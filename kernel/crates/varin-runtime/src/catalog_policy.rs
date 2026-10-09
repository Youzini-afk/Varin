//! Policy graphs share one immutable tool directory and commit each node receipt independently.
use super::policy_body::{PolicyActionMetadata, PolicyGraphBody, PolicyGraphProgress};
use super::*;
use crate::execution::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub struct PolicyGraphSchemaPreparation {
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedPolicyGraphSchemas {
    metadata: PolicyActionMetadata,
    run_id: String,
    nodes: Vec<PreparedGraphNode>,
    tools_ref: Value,
    checkpoint: super::policy_checkpoint::PolicyCheckpointReferences,
    _publication: crate::content::ContentPublication,
}
struct PreparedGraphNode {
    id: String,
    call_id: String,
    dependencies: Vec<String>,
    generation: u64,
    source: Option<super::launches::SourceSelection>,
}
impl PolicyGraphSchemaPreparation {
    pub fn load(self, intent: &PolicyGraphIntent) -> Result<PreparedPolicyGraphSchemas> {
        let (body, run_id) = PolicyGraphBody::prepare(intent)?;
        let tools_ref = self.content.save(&serde_json::to_value(&body.tools)?)?;
        let metadata = PolicyActionMetadata::PolicyReadGraphV1 {
            action_id: body.action_id.clone(),
            boundary: body.boundary.clone(),
            identity: body.identity.clone(),
            node_count: body.nodes.len(),
            body_ref: self.content.save(&serde_json::to_value(&body)?)?,
        };
        let action = PolicyAction::ReadGraph {
            nodes: intent
                .nodes()
                .iter()
                .map(|node| node.node.clone())
                .collect(),
        };
        let checkpoint = super::policy_checkpoint::PolicyCheckpointReferences::write(
            &self.content,
            intent.checkpoint().1,
            &action,
        )?;
        let nodes = body
            .nodes
            .into_iter()
            .map(|node| PreparedGraphNode {
                id: node.node.id,
                call_id: node.node.call.call_id,
                dependencies: node.node.depends_on,
                generation: node.tool_schema_generation,
                source: node.source,
            })
            .collect();
        Ok(PreparedPolicyGraphSchemas {
            metadata,
            run_id,
            nodes,
            tools_ref,
            checkpoint,
            _publication: self.publication,
        })
    }
}
pub struct PolicyGraphRead {
    pub(crate) metadata: PolicyActionMetadata,
    op: Operation,
    content: crate::content::ContentStore,
    database: std::path::PathBuf,
    checkpoint: Option<super::policy_checkpoint::PolicyCheckpointRead>,
    _publication: crate::content::ContentPublication,
}
impl PolicyGraphRead {
    pub fn load(self) -> Result<PolicyGraphState> {
        let intent = self.metadata.load_graph(&self.content, &self.op.run_id)?;
        let mut database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let snapshot = database.transaction()?;
        let op: Operation = record(&snapshot, "operations", &self.op.id)?;
        if op.epoch != self.op.epoch
            || op.run_id != self.op.run_id
            || graph_metadata(&op)?.as_ref() != Some(&self.metadata)
        {
            return Err(RuntimeError::Conflict(
                "policy graph owner changed during body loading".into(),
            ));
        }
        let progress = PolicyGraphProgress::read(&op, &self.metadata)?;
        let mut receipts = BTreeMap::new();
        let mut statement = snapshot.prepare("SELECT node_id,call_id,receipt,outcome FROM policy_graph_nodes WHERE action_id=?1 ORDER BY position")?;
        let mut count = 0;
        for row in statement.query_map([&op.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })? {
            let (node_id, call_id, receipt, outcome) = row?;
            let expected = intent
                .nodes()
                .get(count)
                .ok_or_else(|| RuntimeError::Invalid("graph node index exceeds its body".into()))?;
            if node_id != expected.node.id || call_id != expected.node.call.call_id {
                return Err(RuntimeError::Invalid(
                    "graph node index differs from its body".into(),
                ));
            }
            if let Some(receipt) = receipt {
                let receipt: PolicyNodeReceipt = serde_json::from_str(&receipt)?;
                if receipt.node_id != node_id
                    || outcome != Some(encode(&receipt.outcome)?)
                    || receipt.output.as_ref().is_some_and(|output| {
                        output.action_id != op.id || output.node_id != node_id
                    })
                {
                    return Err(RuntimeError::Invalid(
                        "policy graph receipt ownership mismatch".into(),
                    ));
                }
                receipts.insert(node_id, receipt);
            } else if outcome.is_some() {
                return Err(RuntimeError::Invalid("graph outcome has no receipt".into()));
            }
            count += 1;
        }
        if count != intent.nodes().len()
            || receipts.len() != progress.settled
            || receipts
                .values()
                .filter(|receipt| receipt.outcome == Outcome::Cancelled)
                .count()
                != progress.cancelled
            || receipts
                .values()
                .filter(|receipt| {
                    !matches!(receipt.outcome, Outcome::Succeeded | Outcome::Cancelled)
                })
                .count()
                != progress.failed
        {
            return Err(RuntimeError::Invalid(
                "graph progress differs from its node receipts".into(),
            ));
        }
        drop(statement);
        drop(snapshot);
        let decision = self
            .checkpoint
            .map(|checkpoint| checkpoint.load_pending())
            .transpose()?
            .flatten()
            .filter(|decision| !matches!(decision.action, PolicyAction::ReadGraph { .. }));
        Ok(PolicyGraphState {
            intent,
            result: PolicyGraphResult { receipts },
            terminal: op.phase == OperationPhase::Terminal,
            decision,
            cancel_requested: op.cancel_requested,
        })
    }
}
pub(crate) fn graph_metadata(op: &Operation) -> Result<Option<PolicyActionMetadata>> {
    Ok(PolicyActionMetadata::from_operation(op)?
        .filter(|metadata| metadata.graph_nodes().is_some()))
}
impl Catalog {
    pub fn policy_boundary(&self, run_id: &str, epoch: u64) -> Result<PolicyBoundary> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let model: Option<String> = self
            .db
            .query_row(
                "SELECT id FROM model_steps WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1",
                [run_id],
                |r| r.get(0),
            )
            .optional()?;
        let previous:Option<String>=self.db.query_row("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind') IN ('policy_read_graph_v1','policy_model_job_v1') AND json_extract(body,'$.phase')='terminal' ORDER BY rowid DESC LIMIT 1",[run_id],|r|r.get(0)).optional()?;
        let id = hex::encode(Sha256::digest(serde_json::to_vec(&(
            run_id,
            self.head(&run.branch_id)?,
            model,
            previous,
        ))?));
        let source = self
            .launch_metadata(run_id)?
            .and_then(|launch| launch.selection.source);
        Ok(PolicyBoundary { id, source })
    }
    pub fn policy_graph(&self, run_id: &str, epoch: u64) -> Result<Option<PolicyGraphState>> {
        self.prepare_policy_graph_read(run_id, epoch)?
            .map(PolicyGraphRead::load)
            .transpose()
    }
    fn graph_read(
        &self,
        op: Operation,
        metadata: PolicyActionMetadata,
        checkpoint: Option<super::policy_checkpoint::PolicyCheckpointRead>,
    ) -> Result<PolicyGraphRead> {
        PolicyGraphProgress::read(&op, &metadata)?;
        Ok(PolicyGraphRead {
            metadata,
            op,
            checkpoint,
            content: self.content.clone(),
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no persistent database".into()))?
                .into(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn prepare_policy_graph_read(
        &self,
        run_id: &str,
        epoch: u64,
    ) -> Result<Option<PolicyGraphRead>> {
        fence(&self.run(run_id)?, epoch)?;
        let key:Option<String>=self.db.query_row("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind') IN ('policy_read_graph_v1','policy_model_job_v1') ORDER BY rowid DESC LIMIT 1",[run_id],|r|r.get(0)).optional()?;
        let Some(key) = key else { return Ok(None) };
        let op: Operation = record(&self.db, "operations", &key)?;
        let Some(metadata) = graph_metadata(&op)? else {
            return Ok(None);
        };
        let admitted:u64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='policy.graph_admitted'",[&key],|r|read_number(r,0))?;
        let delivered:u64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='input.delivered'",[run_id],|r|read_number(r,0))?;
        let model:u64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind')='request_prepared'",[run_id],|r|read_number(r,0))?;
        if op.phase == OperationPhase::Terminal && (delivered > admitted || model > admitted) {
            return Ok(None);
        }
        let checkpoint = if op.phase == OperationPhase::Terminal {
            self.capture_policy_checkpoint(run_id)?
        } else {
            None
        };
        if checkpoint
            .as_ref()
            .is_some_and(|saved| &saved.identity != metadata.identity())
        {
            return Err(RuntimeError::Conflict(
                "policy checkpoint identity changed".into(),
            ));
        }
        self.graph_read(op, metadata, checkpoint).map(Some)
    }
    pub fn admit_policy_graph(
        &mut self,
        run_id: &str,
        epoch: u64,
        intent: &PolicyGraphIntent,
    ) -> Result<PolicyGraphState> {
        let schemas = self.prepare_policy_graph_schemas().load(intent)?;
        self.admit_policy_graph_prepared(run_id, epoch, schemas)?
            .load()
    }
    pub fn prepare_policy_graph_schemas(&self) -> PolicyGraphSchemaPreparation {
        PolicyGraphSchemaPreparation {
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    pub fn admit_policy_graph_prepared(
        &mut self,
        run_id: &str,
        epoch: u64,
        schemas: PreparedPolicyGraphSchemas,
    ) -> Result<PolicyGraphRead> {
        let metadata = &schemas.metadata;
        let action_id = metadata.action_id();
        let identity = metadata.identity();
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if schemas.run_id != run_id {
            return Err(RuntimeError::Conflict(
                "graph belongs to another Run".into(),
            ));
        }
        if let Some(previous) = optional_record::<Operation>(&self.db, "operations", action_id)? {
            if graph_metadata(&previous)?.as_ref() != Some(metadata) || previous.run_id != run_id {
                return Err(RuntimeError::Conflict(
                    "policy boundary intent changed".into(),
                ));
            }
            return self.graph_read(previous, metadata.clone(), None);
        }
        if run.cancel_requested
            || metadata.boundary() != &self.policy_boundary(run_id, epoch)?
            || action_id != format!("{run_id}:policy:{}", metadata.boundary().id)
        {
            return Err(RuntimeError::Conflict("policy boundary changed".into()));
        }
        if let Some(launch) = self.launch_metadata(run_id)? {
            if launch.selection.policy != *identity
                || schemas.tools_ref != launch.selection.tools_ref
                || schemas.nodes.iter().any(|node| {
                    node.generation != launch.selection.tool_schema_generation
                        || node.source != launch.selection.source
                })
            {
                return Err(RuntimeError::Conflict(
                    "graph differs from pinned launch".into(),
                ));
            }
        }
        let op = Operation {
            id: action_id.into(),
            run_id: run_id.into(),
            epoch,
            revision: 1,
            phase: OperationPhase::Running,
            outcome: None,
            effect: Effect::None,
            cancel_requested: false,
            lifetime: Lifetime::Run,
            handed_off: false,
            executor: Some("policy-read-graph.v1".into()),
            waiting_on: None,
            intent: serde_json::to_value(metadata)?,
            result: Some(serde_json::to_value(PolicyGraphProgress::default())?),
            external_receipt: None,
        };
        let tx = self.db.transaction()?;
        if super::inputs::has_boundary_inputs(&tx, run_id)? {
            return Err(RuntimeError::InputPending);
        }
        let unresolved:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind') IN ('policy_read_graph_v1','policy_model_job_v1') AND json_extract(body,'$.phase')!='terminal') OR EXISTS(SELECT 1 FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0) OR EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state!='completed' AND json_extract(body,'$.superseded_by_input') IS NULL)",[run_id],|r|r.get(0))?;
        if unresolved {
            return Err(RuntimeError::Conflict(
                "policy graph cannot bypass unsettled work".into(),
            ));
        }
        let saved: Option<String> = tx
            .query_row(
                "SELECT identity FROM policy_checkpoints WHERE run_id=?1",
                [run_id],
                |r| r.get(0),
            )
            .optional()?;
        if saved
            .map(|saved| serde_json::from_str::<PolicyIdentity>(&saved))
            .transpose()?
            .is_some_and(|saved| saved != *identity)
        {
            return Err(RuntimeError::Conflict("policy identity changed".into()));
        }
        schemas.checkpoint.publish(&tx, run_id, identity)?;
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![action_id, run_id, encode(&op)?],
        )?;
        for (position, node) in schemas.nodes.iter().enumerate() {
            tx.execute("INSERT INTO policy_graph_nodes(action_id,node_id,call_id,position) VALUES(?1,?2,?3,?4)",params![action_id,node.id,node.call_id,position as i64])?;
        }
        for node in &schemas.nodes {
            for dependency in &node.dependencies {
                tx.execute("INSERT INTO policy_graph_dependencies(action_id,node_id,dependency_id) VALUES(?1,?2,?3)",params![action_id,node.id,dependency])?;
            }
        }
        event(
            &tx,
            action_id,
            1,
            "policy.graph_admitted",
            json!({"run_id":run_id}),
        )?;
        tx.commit()?;
        self.graph_read(op, schemas.metadata, None)
    }
    pub fn settle_policy_node(
        &mut self,
        run_id: &str,
        epoch: u64,
        action: &str,
        node: &str,
        completion: &ToolCompletion,
    ) -> Result<PolicyNodeReceipt> {
        let _publication = self.content.begin_publication();
        let output = match completion {
            ToolCompletion::Result {
                effect: Effect::None,
                content,
                ..
            } => Some(self.content.save(content)?),
            _ => None,
        };
        self.settle_policy_node_reference(run_id, epoch, action, node, completion, output)
    }
    pub(crate) fn settle_policy_node_reference(
        &mut self,
        run_id: &str,
        epoch: u64,
        action: &str,
        node: &str,
        completion: &ToolCompletion,
        output: Option<Value>,
    ) -> Result<PolicyNodeReceipt> {
        fence(&self.run(run_id)?, epoch)?;
        let mut op: Operation = record(&self.db, "operations", action)?;
        let metadata = graph_metadata(&op)?
            .ok_or_else(|| RuntimeError::Invalid("not a policy graph".into()))?;
        if op.run_id != run_id || op.epoch != epoch {
            return Err(RuntimeError::Conflict("graph owner changed".into()));
        }
        let mut progress = PolicyGraphProgress::read(&op, &metadata)?;
        let saved: Option<String> = self.db.query_row(
            "SELECT receipt FROM policy_graph_nodes WHERE action_id=?1 AND node_id=?2",
            params![action, node],
            |row| row.get(0),
        )?;
        let (unsettled,unsuccessful):(bool,bool)=self.db.query_row("SELECT EXISTS(SELECT 1 FROM policy_graph_dependencies d JOIN policy_graph_nodes n ON n.action_id=d.action_id AND n.node_id=d.dependency_id WHERE d.action_id=?1 AND d.node_id=?2 AND n.receipt IS NULL), EXISTS(SELECT 1 FROM policy_graph_dependencies d JOIN policy_graph_nodes n ON n.action_id=d.action_id AND n.node_id=d.dependency_id WHERE d.action_id=?1 AND d.node_id=?2 AND n.outcome!=?3)",params![action,node,encode(&Outcome::Succeeded)?],|row|Ok((row.get(0)?,row.get(1)?)))?;
        if unsettled {
            return Err(RuntimeError::Conflict(
                "dependencies have not settled".into(),
            ));
        }
        let (outcome, output, non_execution) = match completion {
            ToolCompletion::NotDispatched { reason } => (
                if reason == "cancelled" || op.cancel_requested || progress.cancelled != 0 {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                None,
                Some(reason.clone()),
            ),
            ToolCompletion::Result {
                outcome,
                effect: Effect::None,
                ..
            } => {
                if unsuccessful {
                    return Err(RuntimeError::Conflict(
                        "failed dependency cannot execute".into(),
                    ));
                }
                let reference = output.ok_or_else(|| {
                    RuntimeError::Invalid("policy output reference missing".into())
                })?;
                (
                    *outcome,
                    Some(PolicyEvidenceRef {
                        action_id: action.into(),
                        node_id: node.into(),
                        content_ref: reference["content_object"]
                            .as_str()
                            .ok_or_else(|| {
                                RuntimeError::Invalid("content reference missing".into())
                            })?
                            .into(),
                    }),
                    None,
                )
            }
            _ => {
                return Err(RuntimeError::Invalid(
                    "pure read returned an effect or job".into(),
                ))
            }
        };
        let receipt = PolicyNodeReceipt {
            node_id: node.into(),
            outcome,
            output,
            non_execution,
        };
        if let Some(saved) = saved {
            let saved: PolicyNodeReceipt = serde_json::from_str(&saved)?;
            if saved != receipt {
                return Err(RuntimeError::Conflict("graph receipt changed".into()));
            }
            return Ok(saved);
        }
        progress.settled += 1;
        match outcome {
            Outcome::Succeeded => {}
            Outcome::Cancelled => progress.cancelled += 1,
            _ => progress.failed += 1,
        };
        op.revision += 1;
        if Some(progress.settled) == metadata.graph_nodes() {
            op.phase = OperationPhase::Terminal;
            op.outcome = Some(if progress.failed == 0 && progress.cancelled == 0 {
                Outcome::Succeeded
            } else if op.cancel_requested || progress.cancelled != 0 {
                Outcome::Cancelled
            } else {
                Outcome::Failed
            });
        }
        op.result = Some(serde_json::to_value(&progress)?);
        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE policy_graph_nodes SET receipt=?3,outcome=?4 WHERE action_id=?1 AND node_id=?2",
            params![action, node, encode(&receipt)?, encode(&outcome)?],
        )?;
        put(&tx, "operations", action, &op)?;
        event(
            &tx,
            action,
            op.revision,
            "policy.node_settled",
            json!({"node_id":node,"outcome":outcome}),
        )?;
        tx.commit()?;
        Ok(receipt)
    }
    pub(crate) fn owned_policy_reference(
        &self,
        run_id: &str,
        reference: &PolicyEvidenceRef,
    ) -> Result<Value> {
        let op: Operation = record(&self.db, "operations", &reference.action_id)?;
        let owned = if super::policy_model::model_metadata(&op)?.is_some() {
            super::policy_model::model_result(&op)?
                .receipt
                .is_some_and(|receipt| receipt.usable && receipt.output.as_ref() == Some(reference))
        } else {
            let metadata = graph_metadata(&op)?
                .ok_or_else(|| RuntimeError::Invalid("not a policy graph".into()))?;
            PolicyGraphProgress::read(&op, &metadata)?;
            let saved: Option<Option<String>> = self
                .db
                .query_row(
                    "SELECT receipt FROM policy_graph_nodes WHERE action_id=?1 AND node_id=?2",
                    params![reference.action_id, reference.node_id],
                    |row| row.get(0),
                )
                .optional()?;
            saved
                .flatten()
                .map(|saved| serde_json::from_str::<PolicyNodeReceipt>(&saved))
                .transpose()?
                .is_some_and(|receipt| receipt.output.as_ref() == Some(reference))
        };
        if op.run_id != run_id || !owned {
            return Err(RuntimeError::Conflict(
                "policy output is not owned by this Run and node".into(),
            ));
        }
        Ok(json!({"content_object":reference.content_ref}))
    }
    pub fn policy_output_chunk(
        &self,
        run_id: &str,
        action_id: &str,
        node_id: &str,
        content_ref: &str,
        index: usize,
    ) -> Result<crate::content::ContentChunk> {
        self.content.load_chunk(
            &self.owned_policy_reference(
                run_id,
                &PolicyEvidenceRef {
                    action_id: action_id.into(),
                    node_id: node_id.into(),
                    content_ref: content_ref.into(),
                },
            )?,
            index,
        )
    }
    pub(crate) fn is_policy_model_reference(&self, reference: &PolicyEvidenceRef) -> Result<bool> {
        let op: Operation = record(&self.db, "operations", &reference.action_id)?;
        Ok(super::policy_model::model_metadata(&op)?.is_some())
    }
    pub fn policy_evidence(
        &self,
        run_id: &str,
        epoch: u64,
        reference: &PolicyEvidenceRef,
    ) -> Result<ConversationItem> {
        fence(&self.run(run_id)?, epoch)?;
        let content = self
            .content
            .load(&self.owned_policy_reference(run_id, reference)?)?;
        Ok(if self.is_policy_model_reference(reference)? {
            policy_model_evidence_item(reference, content)
        } else {
            policy_evidence_item(reference, content)
        })
    }
}
