//! Policy graph persistence uses only the existing Operation and policy checkpoint owners.
use super::*;
use crate::execution::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub struct PolicyGraphSchemaPreparation {
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedPolicyGraphSchemas {
    intent: PolicyGraphIntent,
    reference: Option<Value>,
    _publication: crate::content::ContentPublication,
}
impl PolicyGraphSchemaPreparation {
    pub fn load(self, intent: &PolicyGraphIntent) -> Result<PreparedPolicyGraphSchemas> {
        let tools = intent.nodes().first().map(|node| node.context.tools.as_ref());
        if intent.nodes().iter().any(|node| Some(node.context.tools.as_ref()) != tools) {
            return Err(RuntimeError::Conflict("graph nodes differ in their selected tools".into()));
        }
        let reference = tools.map(|tools| self.content.save(&serde_json::to_value(tools)?)).transpose()?;
        Ok(PreparedPolicyGraphSchemas { intent: intent.clone(), reference, _publication: self.publication })
    }
}

pub(crate) fn graph_intent(op: &Operation) -> Result<Option<PolicyGraphIntent>> {
    let kind = op.intent.get("kind").and_then(Value::as_str).unwrap_or("");
    if !kind.starts_with("policy_read_graph") {
        return Ok(None);
    }
    if kind != "policy_read_graph_v1" {
        return Err(RuntimeError::Invalid(
            "unsupported policy graph format; data preserved".into(),
        ));
    }
    let intent: PolicyGraphIntent = serde_json::from_value(op.intent.clone())?;
    if op.id != intent.action_id()
        || op.lifetime != Lifetime::Run
        || op.effect != Effect::None
        || op.executor.as_deref() != Some("policy-read-graph.v1")
    {
        return Err(RuntimeError::Invalid(
            "policy graph owner is malformed".into(),
        ));
    }
    validate_policy_nodes(
        &intent
            .nodes()
            .iter()
            .map(|n| n.node.clone())
            .collect::<Vec<_>>(),
    )
    .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
    for node in intent.nodes() {
        if node.context.run_id != op.run_id
            || node.context.origin
                != (ToolOrigin::PolicyAction {
                    action_id: op.id.clone(),
                    node_id: node.node.id.clone(),
                })
            || !node.contract.read_only
            || node.contract.completion != CompletionKind::Result
            || node.contract.name != node.node.call.name
            || node.contract.schema_version != node.node.call.schema_version
            || node
                .contract
                .resources
                .iter()
                .any(|r| r.access != Access::Read)
            || !node.context.tools.iter().any(|s| {
                s.name == node.node.call.name && s.version == node.node.call.schema_version
            })
        {
            return Err(RuntimeError::Invalid(
                "policy graph node contract is malformed".into(),
            ));
        }
    }
    Ok(Some(intent))
}
pub(crate) fn graph_result(
    op: &Operation,
    intent: &PolicyGraphIntent,
) -> Result<PolicyGraphResult> {
    let result: PolicyGraphResult = serde_json::from_value(
        op.result
            .clone()
            .ok_or_else(|| RuntimeError::Invalid("policy graph receipts missing".into()))?,
    )?;
    for (id, receipt) in &result.receipts {
        if id != &receipt.node_id
            || !intent.nodes().iter().any(|n| &n.node.id == id)
            || receipt
                .output
                .as_ref()
                .is_some_and(|r| r.action_id != op.id || r.node_id != *id)
        {
            return Err(RuntimeError::Invalid(
                "policy graph receipt ownership mismatch".into(),
            ));
        }
    }
    if (op.phase == OperationPhase::Terminal) != (result.receipts.len() == intent.nodes().len()) {
        return Err(RuntimeError::Invalid(
            "policy graph terminal receipt mismatch".into(),
        ));
    }
    Ok(result)
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
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let key:Option<String>=self.db.query_row("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind') IN ('policy_read_graph_v1','policy_model_job_v1') ORDER BY rowid DESC LIMIT 1",[run_id],|r|r.get(0)).optional()?;
        let Some(key) = key else { return Ok(None) };
        let op: Operation = record(&self.db, "operations", &key)?;
        let Some(intent) = graph_intent(&op)? else { return Ok(None); };
        let result = graph_result(&op, &intent)?;
        let admitted:u64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='policy.graph_admitted'",[&key],|r|read_number(r,0))?;
        let delivered:u64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='input.delivered'",[run_id],|r|read_number(r,0))?;
        if op.phase == OperationPhase::Terminal && delivered > admitted {
            return Ok(None);
        }
        let model:u64=self.db.query_row("SELECT coalesce(max(cursor),0) FROM events WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind')='request_prepared'",[run_id],|r|read_number(r,0))?;
        if op.phase == OperationPhase::Terminal && model > admitted {
            return Ok(None);
        }
        let saved: (String, String) = self.db.query_row(
            "SELECT state,action FROM policy_checkpoints WHERE run_id=?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let action: PolicyAction = serde_json::from_str(&saved.1)?;
        let mut decision = if op.phase == OperationPhase::Terminal
            && !matches!(action, PolicyAction::ReadGraph { .. })
        {
            Some(PolicyDecision {
                state: serde_json::from_str(&saved.0)?,
                action,
            })
        } else {
            None
        };
        if let Some(PolicyDecision {
            action: PolicyAction::Wait { wait_id },
            ..
        }) = &decision
        {
            let wait: Wait = record(&self.db, "waits", wait_id)?;
            if wait.trigger_cursor.is_some() || wait.cancelled {
                decision = None;
            }
        }
        Ok(Some(PolicyGraphState {
            intent,
            result,
            terminal: op.phase == OperationPhase::Terminal,
            decision,
            cancel_requested: op.cancel_requested,
        }))
    }
    pub fn admit_policy_graph(
        &mut self,
        run_id: &str,
        epoch: u64,
        intent: &PolicyGraphIntent,
    ) -> Result<PolicyGraphState> {
        let schemas = self.prepare_policy_graph_schemas().load(intent)?;
        self.admit_policy_graph_prepared(run_id, epoch, schemas)
    }
    pub fn prepare_policy_graph_schemas(&self) -> PolicyGraphSchemaPreparation {
        PolicyGraphSchemaPreparation { content: self.content.clone(), publication: self.content.begin_publication() }
    }
    pub fn admit_policy_graph_prepared(&mut self, run_id: &str, epoch: u64,
        schemas: PreparedPolicyGraphSchemas) -> Result<PolicyGraphState> {
        let intent = &schemas.intent;
        let PolicyGraphIntent::PolicyReadGraphV1 {
            action_id,
            boundary,
            identity,
            state,
            nodes,
        } = intent;
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if let Some(previous) = optional_record::<Operation>(&self.db, "operations", action_id)? {
            let saved = graph_intent(&previous)?
                .ok_or_else(|| RuntimeError::Conflict("action identity already used".into()))?;
            if &saved != intent || previous.run_id != run_id {
                return Err(RuntimeError::Conflict(
                    "policy boundary intent changed".into(),
                ));
            }
            return Ok(PolicyGraphState {
                result: graph_result(&previous, &saved)?,
                intent: saved,
                terminal: previous.phase == OperationPhase::Terminal,
                decision: None,
                cancel_requested: previous.cancel_requested,
            });
        }
        if run.cancel_requested
            || boundary != &self.policy_boundary(run_id, epoch)?
            || action_id != &format!("{run_id}:policy:{}", boundary.id)
        {
            return Err(RuntimeError::Conflict("policy boundary changed".into()));
        }
        if let Some(launch) = self.launch_metadata(run_id)? {
            if launch.selection.policy != *identity
                || schemas.reference.as_ref().is_some_and(|reference| reference != &launch.selection.tools_ref)
                || nodes.iter().any(|n| {
                    n.context.tool_schema_generation
                            != launch.selection.tool_schema_generation
                        || n.context.source != launch.selection.source
                })
            {
                return Err(RuntimeError::Conflict(
                    "graph differs from pinned launch".into(),
                ));
            }
        }
        let op = Operation {
            id: action_id.clone(),
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
            intent: serde_json::to_value(intent)?,
            result: Some(serde_json::to_value(PolicyGraphResult {
                receipts: BTreeMap::new(),
            })?),
            external_receipt: None,
        };
        graph_intent(&op)?;
        let tx = self.db.transaction()?;
        if super::inputs::has_boundary_inputs(&tx, run_id)? {
            return Err(RuntimeError::InputPending);
        }
        let pending_action:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.intent.kind') IN ('policy_read_graph_v1','policy_model_job_v1') AND json_extract(body,'$.phase')!='terminal')",[run_id],|r|r.get(0))?;
        if pending_action{return Err(RuntimeError::Conflict("policy action is unsettled".into()));}
        let unpaired:i64=tx.query_row("SELECT count(*) FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0",[run_id],|r|r.get(0))?;
        let unresolved:i64=tx.query_row("SELECT count(*) FROM model_steps WHERE run_id=?1 AND state!='completed' AND json_extract(body,'$.superseded_by_input') IS NULL",[run_id],|r|r.get(0))?;
        if unpaired != 0 || unresolved != 0 {
            return Err(RuntimeError::Conflict(
                "policy graph cannot bypass an outstanding model exchange".into(),
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
            .map(|s| serde_json::from_str::<PolicyIdentity>(&s))
            .transpose()?
            .is_some_and(|s| s != *identity)
        {
            return Err(RuntimeError::Conflict("policy identity changed".into()));
        }
        let action = PolicyAction::ReadGraph {
            nodes: nodes.iter().map(|n| n.node.clone()).collect(),
        };
        tx.execute("INSERT INTO policy_checkpoints(run_id,identity,state,action) VALUES(?1,?2,?3,?4) ON CONFLICT(run_id) DO UPDATE SET identity=excluded.identity,state=excluded.state,action=excluded.action",params![run_id,encode(identity)?,encode(state)?,encode(&action)?])?;
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![action_id, run_id, encode(&op)?],
        )?;
        event(
            &tx,
            action_id,
            1,
            "policy.graph_admitted",
            json!({"run_id":run_id}),
        )?;
        tx.commit()?;
        Ok(PolicyGraphState {
            intent: intent.clone(),
            result: PolicyGraphResult {
                receipts: BTreeMap::new(),
            },
            terminal: false,
            decision: None,
            cancel_requested: false,
        })
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
            ToolCompletion::Result { effect: Effect::None, content, .. } => Some(self.content.save(content)?),
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
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let mut op: Operation = record(&self.db, "operations", action)?;
        let intent =
            graph_intent(&op)?.ok_or_else(|| RuntimeError::Invalid("not a policy graph".into()))?;
        if op.run_id != run_id || op.epoch != epoch {
            return Err(RuntimeError::Conflict("graph owner changed".into()));
        }
        let mut result = graph_result(&op, &intent)?;
        let admitted = intent
            .nodes()
            .iter()
            .find(|n| n.node.id == node)
            .ok_or_else(|| RuntimeError::Invalid("unknown graph node".into()))?;
        if admitted
            .node
            .depends_on
            .iter()
            .any(|id| !result.receipts.contains_key(id))
        {
            return Err(RuntimeError::Conflict(
                "dependencies have not settled".into(),
            ));
        }
        let (outcome, output, non_execution) = match completion {
            ToolCompletion::NotDispatched { reason } => (
                if reason == "cancelled" {
                    Outcome::Cancelled
                } else if op.cancel_requested
                    || result
                        .receipts
                        .values()
                        .any(|r| r.outcome == Outcome::Cancelled)
                {
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
                if admitted
                    .node
                    .depends_on
                    .iter()
                    .any(|id| result.receipts[id].outcome != Outcome::Succeeded)
                {
                    return Err(RuntimeError::Conflict(
                        "failed dependency cannot execute".into(),
                    ));
                }
                let reference = output.ok_or_else(|| RuntimeError::Invalid("policy output reference missing".into()))?;
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
        if let Some(saved) = result.receipts.get(node) {
            if saved != &receipt {
                return Err(RuntimeError::Conflict("graph receipt changed".into()));
            }
            return Ok(saved.clone());
        }
        result.receipts.insert(node.into(), receipt.clone());
        op.result = Some(serde_json::to_value(&result)?);
        op.revision += 1;
        if result.receipts.len() == intent.nodes().len() {
            op.phase = OperationPhase::Terminal;
            op.outcome = Some(
                if result
                    .receipts
                    .values()
                    .all(|r| r.outcome == Outcome::Succeeded)
                {
                    Outcome::Succeeded
                } else if op.cancel_requested
                    || result
                        .receipts
                        .values()
                        .any(|r| r.outcome == Outcome::Cancelled)
                {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
            );
        }
        let tx = self.db.transaction()?;
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
        if super::policy_model::model_intent(&op)?.is_some() {
            let result=super::policy_model::model_result(&op)?;
            if op.run_id!=run_id || !result.receipt.as_ref().is_some_and(|r|r.usable&&r.output.as_ref()==Some(reference)){return Err(RuntimeError::Conflict("planning evidence is not owned by this Run".into()));}
            return Ok(json!({"content_object":reference.content_ref}));
        }
        let intent =
            graph_intent(&op)?.ok_or_else(|| RuntimeError::Invalid("not a policy graph".into()))?;
        let result = graph_result(&op, &intent)?;
        if op.run_id != run_id
            || !result
                .receipts
                .get(&reference.node_id)
                .is_some_and(|r| r.output.as_ref() == Some(reference))
        {
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
    pub(crate) fn is_policy_model_reference(&self, reference:&PolicyEvidenceRef)->Result<bool> {let op:Operation=record(&self.db,"operations",&reference.action_id)?;Ok(super::policy_model::model_intent(&op)?.is_some())}
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
        Ok(if self.is_policy_model_reference(reference)? {policy_model_evidence_item(reference,content)} else {policy_evidence_item(reference,content)})
    }
}
