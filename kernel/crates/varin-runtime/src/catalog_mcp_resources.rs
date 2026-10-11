//! Resource observers are a facet of the original finite MCP Operation, never remote Tasks.
use super::*;
use crate::execution::{CompletionKind, Content, ConversationItem, Provenance};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpResourceBinding {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub endpoint: host_jobs::McpEndpoint,
    pub schema_version: String,
    pub uri: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpResourceSubscription {
    pub binding: McpResourceBinding,
    pub source_scope: launches::McpExecutionScope,
    pub acceptance_ref: Option<Value>,
    pub listener_id: Option<String>,
    pub availability: crate::McpResourceAvailability,
    pub local_released: bool,
    pub remote_cleanup: crate::McpResourceCleanup,
    pub last_event_cursor: Option<u64>,
    pub problem: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourcePending {
    pub revision: u64,
    pub operation_id: String,
    pub run_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub cancel_requested: bool,
    pub subscription: McpResourceSubscription,
}
fn linked(op: &Operation, binding: &McpResourceBinding) -> Result<()> {
    if op.mcp_resource_subscription.as_ref().map(|s| &s.binding) != Some(binding)
        || op.execution_owner.as_ref() != Some(&binding.execution_owner)
    {
        return Err(RuntimeError::Conflict(
            "MCP resource observer owner changed".into(),
        ));
    }
    Ok(())
}
fn source_live(db: &Connection, op: &Operation) -> Result<()> {
    let Some(sub) = &op.mcp_resource_subscription else {
        return Err(RuntimeError::NotFound("MCP resource observer".into()));
    };
    if sub.source_scope == launches::McpExecutionScope::Workspace {
        let retired: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='mcp.resource_source_retired') OR EXISTS(SELECT 1 FROM delegated_executions WHERE run_id=?1 AND json_extract(body,'$.resources_released')=1)", [&op.run_id], |r| r.get(0))?;
        if retired {
            return Err(RuntimeError::Conflict(
                "MCP original source was released".into(),
            ));
        }
    }
    Ok(())
}
fn publish(tx: &Transaction<'_>, op: &mut Operation, kind: &str) -> Result<()> {
    op.revision += 1;
    put(tx, "operations", &op.id, op)?;
    event(
        tx,
        &op.id,
        op.revision,
        kind,
        json!({"subscription":op.mcp_resource_subscription}),
    )?;
    Ok(())
}
impl Catalog {
    pub fn mcp_resource_pending_view(&self, op: Operation) -> Result<McpResourcePending> {
        let run = self.run(&op.run_id)?;
        Ok(McpResourcePending {
            revision: op.revision,
            operation_id: op.id,
            run_id: op.run_id,
            thread_id: run.thread_id,
            branch_id: run.branch_id,
            cancel_requested: op.cancel_requested,
            subscription: op
                .mcp_resource_subscription
                .ok_or_else(|| RuntimeError::NotFound("MCP resource observer".into()))?,
        })
    }
    pub fn begin_mcp_resource(
        &mut self,
        binding: McpResourceBinding,
        snapshot: &tool_content::ToolInvocationSnapshot,
        frozen: &launches::HostToolBinding,
    ) -> Result<Operation> {
        self.validate_tool_invocation(snapshot, true)?;
        let mut op = self.operation(&binding.operation_id)?;
        let intent = tool_content::ToolIntent::from_operation(&op)?;
        let selected = frozen.provenance.servers.get(&binding.endpoint.server);
        if snapshot.context.operation_id != binding.operation_id
            || op.execution_owner.as_ref() != Some(&binding.execution_owner)
            || !matches!(binding.execution_owner, ExecutorOwner::External { .. })
            || binding.uri.is_empty()
            || binding.schema_version.is_empty()
            || binding.endpoint.credential_version.is_empty()
            || intent.contract().completion != CompletionKind::Result
            || intent.contract().lifetime != Lifetime::Thread
            || snapshot.call.arguments["uri"].as_str() != Some(binding.uri.as_str())
            || snapshot.call.arguments["schemaVersion"].as_str()
                != Some(binding.schema_version.as_str())
            || !matches!(frozen.routes.get(&snapshot.call.name), Some(crate::McpRoute::ResourceSubscribe {argument}) if snapshot.call.arguments[argument].as_str()==Some(binding.endpoint.server.as_str()))
            || selected.is_none_or(|s| {
                s.definition_version != binding.endpoint.configuration_version
                    || s.resource_key != binding.endpoint.resource_key
            })
            || intent.contract().resources
                != vec![crate::execution::ResourceClaim {
                    key: binding.endpoint.resource_key.clone(),
                    access: crate::execution::Access::Write,
                }]
            || (frozen.provenance.execution_scope == launches::McpExecutionScope::Workspace
                && snapshot.frozen.source.is_none())
        {
            return Err(RuntimeError::Conflict(
                "MCP resource subscription differs from original invocation".into(),
            ));
        }
        if let Some(old) = &op.mcp_resource_subscription {
            if old.binding != binding {
                return Err(RuntimeError::Conflict(
                    "MCP resource binding changed".into(),
                ));
            }
            return Ok(op);
        }
        // Original ToolDispatched can precede the Host's first subscription admission.
        // Reuse the original Goal binding/control fence, including a replacement Goal
        // on this Run, before acquiring a new continuing observer in that handoff window.
        if !super::goals::tool_allowed(&self.db, &snapshot.context)? {
            return Err(RuntimeError::Conflict(
                "Original Goal no longer authorizes this MCP resource observer".into(),
            ));
        }
        if op.cancel_requested
            || op.phase != OperationPhase::Running
            || op.call_completion.is_some()
        {
            return Err(RuntimeError::Conflict(
                "MCP resource invocation is no longer dispatchable".into(),
            ));
        }
        op.mcp_resource_subscription = Some(McpResourceSubscription {
            binding,
            source_scope: frozen.provenance.execution_scope,
            acceptance_ref: None,
            listener_id: None,
            availability: crate::McpResourceAvailability::Pending,
            local_released: true,
            remote_cleanup: crate::McpResourceCleanup::NotRequested,
            last_event_cursor: None,
            problem: None,
        });
        source_live(&self.db, &op)?;
        let tx = self.db.transaction()?;
        publish(&tx, &mut op, "mcp.resource_intent")?;
        tx.commit()?;
        Ok(op)
    }
    pub fn accept_mcp_resource(
        &mut self,
        binding: &McpResourceBinding,
        listener_id: &str,
        prepared: result_content::PreparedOperationResult,
    ) -> Result<Operation> {
        if listener_id.is_empty() {
            return Err(RuntimeError::Invalid(
                "MCP listener identity missing".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &binding.operation_id)?;
        linked(&op, binding)?;
        if let Some(old) = &op
            .mcp_resource_subscription
            .as_ref()
            .unwrap()
            .acceptance_ref
        {
            if old != &prepared.reference {
                return Err(RuntimeError::Conflict(
                    "MCP subscribe acknowledgement changed".into(),
                ));
            }
            return Ok(op);
        }
        // The ACK already happened. Preserve it even if local observation was withdrawn while it arrived.
        let source_available = match source_live(&tx, &op) {
            Ok(()) => true,
            Err(RuntimeError::Conflict(_)) => false,
            Err(error) => return Err(error),
        };
        let live = source_available && !op.cancel_requested;
        let sub = op.mcp_resource_subscription.as_mut().unwrap();
        sub.acceptance_ref = Some(prepared.reference);
        if live {
            sub.listener_id = Some(listener_id.into());
            sub.local_released = false;
        }
        sub.availability = if live {
            crate::McpResourceAvailability::Active
        } else {
            crate::McpResourceAvailability::Closed
        };
        publish(&tx, &mut op, "mcp.resource_accepted")?;
        tx.commit()?;
        Ok(op)
    }
    pub fn update_mcp_resource_listener(
        &mut self,
        binding: &McpResourceBinding,
        expected: Option<&str>,
        listener: Option<String>,
        availability: crate::McpResourceAvailability,
        local_released: bool,
        cleanup: crate::McpResourceCleanup,
        problem: Option<String>,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &binding.operation_id)?;
        linked(&op, binding)?;
        let old = op.mcp_resource_subscription.as_ref().unwrap();
        if old.listener_id.as_deref() != expected {
            return Err(RuntimeError::Conflict(
                "MCP resource listener incarnation changed".into(),
            ));
        }
        if availability == crate::McpResourceAvailability::Active {
            source_live(&tx, &op)?;
            if op.cancel_requested
                || old.acceptance_ref.is_none()
                || local_released
                || listener.as_ref().is_none_or(String::is_empty)
            {
                return Err(RuntimeError::Conflict(
                    "MCP resource observation cannot resume".into(),
                ));
            }
        }
        let sub = op.mcp_resource_subscription.as_mut().unwrap();
        sub.listener_id = listener;
        sub.availability = availability;
        sub.local_released = local_released;
        sub.remote_cleanup = cleanup;
        sub.problem = problem;
        publish(&tx, &mut op, "mcp.resource_listener_changed")?;
        tx.commit()?;
        Ok(op)
    }
    pub fn pending_mcp_resources(&self) -> Result<Vec<McpResourcePending>> {
        let mut q=self.db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.mcp_resource_subscription') IS NOT NULL AND (coalesce(json_extract(body,'$.cancel_requested'),0)=0 OR coalesce(json_extract(body,'$.mcp_resource_subscription.localReleased'),0)=0) ORDER BY id")?;
        let operations = q
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|v| Ok(serde_json::from_str(&v?)?))
            .collect::<Result<Vec<Operation>>>()?;
        operations
            .into_iter()
            .map(|op| self.mcp_resource_pending_view(op))
            .collect()
    }
    pub fn access_mcp_resource(
        &self,
        run_id: &str,
        target_id: &str,
        control: bool,
    ) -> Result<Operation> {
        let caller = self.run(run_id)?;
        let target = self.operation(target_id)?;
        let source = self.run(&target.run_id)?;
        if target.mcp_resource_subscription.is_none()
            || scheduling::thread_family(&self.db, &caller.thread_id)?
                != scheduling::thread_family(&self.db, &source.thread_id)?
            || control
                && !host_jobs::descendants(&self.db, &caller.thread_id)?.contains(&source.thread_id)
        {
            return Err(RuntimeError::Conflict(
                "MCP resource observer is outside caller scope".into(),
            ));
        }
        Ok(target)
    }
    pub fn require_mcp_resource_source(&self, id: &str) -> Result<Operation> {
        let op = self.operation(id)?;
        source_live(&self.db, &op)?;
        if op.cancel_requested
            || op
                .mcp_resource_subscription
                .as_ref()
                .is_none_or(|s| s.acceptance_ref.is_none())
        {
            return Err(RuntimeError::Conflict(
                "Original MCP resource observation was not accepted or is withdrawn".into(),
            ));
        }
        Ok(op)
    }
    pub fn release_mcp_resource_source(&mut self, run_id: &str) -> Result<Vec<McpResourcePending>> {
        self.run(run_id)?;
        let tx = self.db.transaction()?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='mcp.resource_source_retired')",[run_id],|r|r.get(0))?;
        if !exists {
            event(&tx, run_id, 1, "mcp.resource_source_retired", Value::Null)?;
        }
        cancel_run(&tx, run_id, true)?;
        tx.commit()?;
        self.pending_mcp_resources_for_run(run_id)
    }
    fn pending_mcp_resources_for_run(&self, run_id: &str) -> Result<Vec<McpResourcePending>> {
        let mut q=self.db.prepare("SELECT body FROM operations WHERE run_id=?1 AND json_extract(body,'$.mcp_resource_subscription.sourceScope')='workspace'")?;
        let ops = q
            .query_map([run_id], |r| r.get::<_, String>(0))?
            .map(|v| Ok(serde_json::from_str(&v?)?))
            .collect::<Result<Vec<Operation>>>()?;
        ops.into_iter()
            .map(|op| self.mcp_resource_pending_view(op))
            .collect()
    }
}
pub(super) fn cancel_run(tx: &Transaction<'_>, run_id: &str, workspace_only: bool) -> Result<()> {
    let ids = {
        let mut q=tx.prepare("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.mcp_resource_subscription') IS NOT NULL AND (?2=0 OR json_extract(body,'$.mcp_resource_subscription.sourceScope')='workspace')")?;
        let rows = q
            .query_map(params![run_id, workspace_only], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for id in ids {
        request_cancel_operation_in(tx, &id)?;
    }
    Ok(())
}
pub(super) fn require_source_released(db: &Connection, run_id: &str) -> Result<()> {
    let open:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.mcp_resource_subscription.sourceScope')='workspace' AND (coalesce(json_extract(body,'$.cancel_requested'),0)=0 OR coalesce(json_extract(body,'$.mcp_resource_subscription.localReleased'),0)=0))",[run_id],|r|r.get(0))?;
    if open {
        return Err(RuntimeError::Conflict(
            "Original workspace MCP resource listeners must detach before source release".into(),
        ));
    }
    Ok(())
}

pub struct McpResourceFactPreparation {
    binding: McpResourceBinding,
    listener: String,
    fact_id: String,
    kind: crate::McpResourceFactKind,
    notification: Option<Value>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedMcpResourceFact {
    binding: McpResourceBinding,
    listener: String,
    fact_id: String,
    kind: crate::McpResourceFactKind,
    epoch: u64,
    history: Value,
    _publication: crate::content::ContentPublication,
}
impl McpResourceFactPreparation {
    pub fn load(self) -> Result<PreparedMcpResourceFact> {
        let data = match self.kind {
            crate::McpResourceFactKind::Updated => {
                json!({"kind":"mcp_resource_updated","operationId":self.binding.operation_id,"server":self.binding.endpoint.server,"subscriptionUri":self.binding.uri,"notification":self.notification})
            }
            crate::McpResourceFactKind::UnresolvedAssociation => {
                json!({"kind":"mcp_resource_association_unresolved","operationId":self.binding.operation_id,"server":self.binding.endpoint.server,"subscriptionUri":self.binding.uri,"detail":"The original server sent a resource notification that cannot be associated with this subscription. It may concern a sub-resource; this does not establish that this subscribed resource changed."})
            }
            crate::McpResourceFactKind::Gap => {
                json!({"kind":"mcp_resource_observation_gap","operationId":self.binding.operation_id,"server":self.binding.endpoint.server,"subscriptionUri":self.binding.uri,"detail":"Resource notifications may have been missed while the original connection was unavailable. No remote replay cursor is available."})
            }
        };
        let item: ConversationItem = ConversationItem {
            id: format!(
                "mcp-resource:{}:{}",
                self.binding.operation_id, self.fact_id
            ),
            resource_activation: None,
            provenance: Provenance::EnvironmentFact {
                event_id: format!(
                    "mcp-resource:{}:{}",
                    self.binding.operation_id, self.fact_id
                ),
            },
            content: Content::Text {
                text: serde_json::to_string(&data)?,
            },
            opaque: None,
        };
        let history = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        Ok(PreparedMcpResourceFact {
            binding: self.binding,
            listener: self.listener,
            fact_id: self.fact_id,
            kind: self.kind,
            epoch: self.epoch,
            history,
            _publication: self.publication,
        })
    }
}
impl Catalog {
    pub fn prepare_mcp_resource_fact(
        &self,
        binding: McpResourceBinding,
        listener: String,
        fact_id: String,
        kind: crate::McpResourceFactKind,
        notification: Option<Value>,
    ) -> Result<McpResourceFactPreparation> {
        if listener.is_empty() || fact_id.is_empty() {
            return Err(RuntimeError::Invalid(
                "Resource notification requires original local identities".into(),
            ));
        }
        if kind == crate::McpResourceFactKind::Updated {
            if notification
                .as_ref()
                .and_then(|v| v.get("uri"))
                .and_then(Value::as_str)
                != Some(binding.uri.as_str())
            {
                return Err(RuntimeError::Invalid(
                    "Only exactly associated resource notification bodies may enter this observer"
                        .into(),
                ));
            }
        } else if notification.is_some() {
            return Err(RuntimeError::Invalid(
                "Unassociated resource notification bodies must not be fanned out".into(),
            ));
        }
        let op = self.operation(&binding.operation_id)?;
        linked(&op, &binding)?;
        Ok(McpResourceFactPreparation {
            binding,
            listener,
            fact_id,
            kind,
            notification,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_mcp_resource_fact(&mut self, p: PreparedMcpResourceFact) -> Result<u64> {
        if p.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "Resource notification belongs to an earlier Catalog owner".into(),
            ));
        }
        let input_id = format!("mcp-resource:{}:{}", p.binding.operation_id, p.fact_id);
        let tx = self.db.transaction()?;
        if let Some(old) =
            optional_record::<inputs::QueuedInputMetadata>(&tx, "input_queue", &input_id)?
        {
            let history: String = tx.query_row(
                "SELECT body FROM input_history_content WHERE input_id=?1",
                [&input_id],
                |r| r.get(0),
            )?;
            if !matches!(&old.origin,inputs::InputOrigin::McpResource{operation_id,fact_id,listener_id} if operation_id==&p.binding.operation_id && fact_id==&p.fact_id && listener_id==&p.listener)
                || serde_json::from_str::<Value>(&history)? != p.history
            {
                return Err(RuntimeError::Conflict(
                    "MCP resource fact identity changed".into(),
                ));
            }
            return Ok(old.cursor);
        }
        let mut op: Operation = record(&tx, "operations", &p.binding.operation_id)?;
        linked(&op, &p.binding)?;
        source_live(&tx, &op)?;
        let sub = op.mcp_resource_subscription.as_ref().unwrap();
        if op.cancel_requested
            || sub.acceptance_ref.is_none()
            || sub.listener_id.as_deref() != Some(p.listener.as_str())
            || (sub.local_released && p.kind != crate::McpResourceFactKind::Gap)
        {
            return Err(RuntimeError::Conflict(
                "MCP resource listener no longer admits notifications".into(),
            ));
        }
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let cursor = event(
            &tx,
            &op.id,
            op.revision,
            "mcp.resource_observed",
            json!({"inputId":input_id,"kind":p.kind,"listenerId":p.listener}),
        )?;
        ingress::insert_occurrence(
            &tx,
            input_id,
            run.thread_id,
            run.branch_id,
            cursor,
            inputs::InputOrigin::McpResource {
                operation_id: op.id.clone(),
                fact_id: p.fact_id,
                listener_id: p.listener,
            },
            &p.history,
        )?;
        let sub = op.mcp_resource_subscription.as_mut().unwrap();
        sub.last_event_cursor = Some(cursor);
        if p.kind == crate::McpResourceFactKind::Gap {
            sub.availability = crate::McpResourceAvailability::Gap;
        }
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        tx.commit()?;
        Ok(cursor)
    }
}
