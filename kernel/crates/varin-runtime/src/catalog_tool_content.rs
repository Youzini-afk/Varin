//! Frozen tool arguments are immutable content; control transitions use their identities.
use super::*;
use crate::execution::{
    AdmittedTool, ToolCall, ToolContract, ToolExecutionContext, ToolInvocation, ToolOrigin,
};
use serde::Deserialize;

/// Read-only call outline. Arguments and output remain with their original Operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationCallSummary {
    pub operation_id: String,
    pub parent_operation_id: String,
    pub name: String,
    pub depth: u64,
    pub phase: OperationPhase,
    pub outcome: Option<Outcome>,
    pub effect: Effect,
    pub cancel_requested: bool,
}
impl Catalog {
    pub fn nested_tool_calls(&self, operation_id: &str) -> Result<Vec<OperationCallSummary>> {
        let original: Operation = record(&self.db, "operations", operation_id)?;
        ToolIntent::from_operation(&original)?;
        let mut statement = self.db.prepare("WITH RECURSIVE calls(id,depth) AS (
            SELECT id,0 FROM operations WHERE run_id=?2 AND json_extract(body,'$.intent.origin.kind')='nested_call'
                AND json_extract(body,'$.intent.origin.parent_operation_id')=?1
            UNION ALL SELECT o.id,c.depth+1 FROM operations o JOIN calls c ON json_extract(o.body,'$.intent.origin.parent_operation_id')=c.id
                WHERE o.run_id=?2 AND json_extract(o.body,'$.intent.origin.kind')='nested_call'
        ) SELECT o.body,c.depth FROM calls c JOIN operations o ON o.id=c.id ORDER BY o.rowid")?;
        let rows = statement.query_map(params![operation_id, original.run_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
        rows.map(|row| {
            let (body, depth) = row?;
            let depth = u64::try_from(depth).map_err(|_| RuntimeError::Invalid("invalid nested call depth".into()))?;
            let operation: Operation = serde_json::from_str(&body)?;
            let intent = ToolIntent::from_operation(&operation)?;
            let ToolOrigin::NestedCall { parent_operation_id } = intent.origin() else { unreachable!() };
            Ok(OperationCallSummary { operation_id: operation.id, parent_operation_id: parent_operation_id.clone(),
                name: intent.call().name.clone(), depth, phase: operation.phase, outcome: operation.outcome,
                effect: operation.effect, cancel_requested: operation.cancel_requested })
        }).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallMetadata {
    pub call_id: String,
    pub name: String,
    pub schema_version: String,
    pub arguments_ref: Value,
}
impl ToolCallMetadata {
    pub(crate) fn write(content: &crate::content::ContentStore, call: &ToolCall) -> Result<Self> {
        Ok(Self {
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            arguments_ref: content.save(&call.arguments)?,
        })
    }
    pub(crate) fn load(self, content: &crate::content::ContentStore) -> Result<ToolCall> {
        Ok(ToolCall {
            call_id: self.call_id,
            name: self.name,
            schema_version: self.schema_version,
            arguments: content.load(&self.arguments_ref)?,
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolIntent {
    Tool {
        origin: ToolOrigin,
        call: ToolCallMetadata,
        contract: ToolContract,
    },
}
impl ToolIntent {
    pub fn fingerprint(
        origin: &ToolOrigin,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> Result<Self> {
        Ok(Self::Tool {
            origin: origin.clone(),
            call: ToolCallMetadata {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                schema_version: call.schema_version.clone(),
                arguments_ref: crate::content::ContentStore::reference(&call.arguments)?,
            },
            contract: contract.clone(),
        })
    }
    pub fn origin(&self) -> &ToolOrigin {
        let Self::Tool { origin, .. } = self;
        origin
    }
    pub fn call(&self) -> &ToolCallMetadata {
        let Self::Tool { call, .. } = self;
        call
    }
    pub fn contract(&self) -> &ToolContract {
        let Self::Tool { contract, .. } = self;
        contract
    }
    pub fn from_operation(operation: &Operation) -> Result<Self> {
        let intent: Self = serde_json::from_value(operation.intent.clone())?;
        if operation.id != intent.origin().operation_id(&intent.call().call_id)
            || matches!(intent.origin(),ToolOrigin::PolicyAction{node_id,..} if node_id!=&intent.call().call_id)
        {
            return Err(RuntimeError::Invalid(
                "tool intent origin differs from canonical operation".into(),
            ));
        }
        Ok(intent)
    }
    pub(crate) fn write(
        content: &crate::content::ContentStore,
        origin: &ToolOrigin,
        tool: &AdmittedTool,
    ) -> Result<Self> {
        Ok(Self::Tool {
            origin: origin.clone(),
            call: ToolCallMetadata::write(content, &tool.call)?,
            contract: tool.contract.clone(),
        })
    }
    pub(crate) fn load(self, content: &crate::content::ContentStore) -> Result<ToolInvocation> {
        let Self::Tool {
            origin,
            call,
            contract,
        } = self;
        Ok(ToolInvocation {
            origin,
            call: call.load(content)?,
            contract,
        })
    }
}
pub struct ToolIntentPreparation {
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedToolIntent {
    intent: ToolIntent,
    _publication: crate::content::ContentPublication,
}
impl ToolIntentPreparation {
    pub fn load(self, origin: &ToolOrigin, tool: &AdmittedTool) -> Result<PreparedToolIntent> {
        Ok(PreparedToolIntent {
            intent: ToolIntent::write(&self.content, origin, tool)?,
            _publication: self.publication,
        })
    }
}
pub struct OperationRead {
    operation: Operation,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct ModelStepRead {
    pub metadata: ModelStep,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
/// One derived budget read. Capture only ownership and a content publication lease; SQL selection,
/// snapshot hydration and exact prefix comparison all run outside the Catalog/control mutex.
pub struct RequestBudgetRead {
    run_id: String,
    branch_id: String,
    epoch: u64,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl RequestBudgetRead {
    pub fn estimate(
        self,
        view: &crate::execution::RequestView,
        serialized: &crate::execution::RequestBody,
        protocol: crate::context_capacity::RequestBudgetProtocol,
        cancel: &crate::execution::CancellationToken,
    ) -> Result<crate::context_capacity::InputEstimate> {
        use crate::{context_capacity::*, execution::*};
        if cancel.is_cancelled() {
            return Err(RuntimeError::DispatchCancelled);
        }
        if view.run_id != self.run_id || view.binding.history_range.branch_id != self.branch_id {
            return Err(RuntimeError::Conflict(
                "request budget owner changed".into(),
            ));
        }
        let local = || estimate_request(view, serialized);
        if !matches!(view.origin, RequestOrigin::Conversation { .. }) {
            return Ok(local());
        }
        let db = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let token = cancel.clone();
        db.progress_handler(1000, Some(move || token.is_cancelled()))?;
        let epoch = db.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| {
            read_number(row, 0)
        })?;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "request budget belongs to a previous owner epoch".into(),
            ));
        }
        // Failed/interrupted/late output and unknown/estimated input never replace a successful
        // actual observation. Select exactly one latest candidate, including across Runs of this
        // branch; a different configuration or prefix does not revive an older observation.
        let previous: Option<(String, String, String, String)> = db.query_row(
            "SELECT m.id,m.run_id,json_extract(m.body,'$.request'),json_extract(m.body,'$.usage')
             FROM model_steps m JOIN runs r ON r.id=m.run_id
             WHERE r.branch_id=?1 AND m.state='completed'
               AND json_extract(m.body,'$.usage.measurement')='actual'
               AND json_type(m.body,'$.usage.input_tokens')='integer'
             ORDER BY m.rowid DESC LIMIT 1", [&self.branch_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
        drop(db);
        if cancel.is_cancelled() {
            return Err(RuntimeError::DispatchCancelled);
        }
        let Some((id, run, reference, usage)) = previous else {
            return Ok(local());
        };
        let previous = self
            .content
            .load_snapshot_cancellable(&serde_json::from_str(&reference)?, &|| {
                cancel.is_cancelled()
            })?;
        if previous.view.request_id != id
            || previous.view.run_id != run
            || previous.view.binding.history_range.branch_id != self.branch_id
        {
            return Err(RuntimeError::Invalid(
                "request budget snapshot differs from its owner".into(),
            ));
        }
        let usage: UsageReceipt = serde_json::from_str(&usage)?;
        let estimate = calibrated_estimate(view, serialized, &previous, &usage, protocol);
        if cancel.is_cancelled() {
            return Err(RuntimeError::DispatchCancelled);
        }
        Ok(estimate)
    }
}
impl ModelStepRead {
    pub fn load_request(self) -> Result<Value> {
        self.content.load(&self.metadata.request)
    }
    pub fn load(self) -> Result<ModelStep> {
        let mut step = self.metadata;
        step.request = self.content.load(&step.request)?;
        self.content.hydrate_originals(&mut step.original)?;
        Ok(step)
    }
}
impl OperationRead {
    pub fn load_mcp_task(self) -> Result<Value> {
        let task = self
            .operation
            .host_job
            .as_ref()
            .and_then(|link| link.mcp_task.as_ref())
            .ok_or_else(|| RuntimeError::NotFound("Accepted MCP task".into()))?;
        let result = task
            .result_ref
            .as_ref()
            .map(|reference| self.content.load_output(reference))
            .transpose()?;
        let observation = self.content.load_output(&task.observation_ref)?.data;
        Ok(json!({"operation":self.load()?,"result":result,"observation":observation}))
    }

    /// An internal domain preserves the exact captured receipt, including its typed media.
    pub fn load_with_external_receipt(
        self,
    ) -> Result<(
        crate::types::Operation,
        Option<crate::types::ExternalReceipt>,
    )> {
        let receipt = self
            .operation
            .external_receipt
            .as_ref()
            .map(|receipt| {
                Ok::<_, RuntimeError>(crate::types::ExternalReceipt {
                    executor: receipt.executor.clone(),
                    identity: receipt.identity.clone(),
                    epoch: receipt.epoch.clone(),
                    outcome: receipt.outcome,
                    effect: receipt.effect,
                    result: self.content.load_output(&receipt.result_ref)?,
                })
            })
            .transpose()?;
        Ok((hydrate_operation(self.operation, &self.content)?, receipt))
    }
    pub fn load(self) -> Result<crate::types::Operation> {
        hydrate_operation(self.operation, &self.content)
    }
}
pub(super) fn hydrate_operation(
    mut operation: Operation,
    content: &crate::content::ContentStore,
) -> Result<crate::types::Operation> {
    if operation.intent.get("kind").and_then(Value::as_str) == Some("tool") {
        operation.intent =
            serde_json::to_value(ToolIntent::from_operation(&operation)?.load(content)?)?;
    }
    if operation.intent.get("kind").and_then(Value::as_str) == Some("user_host_job") {
        let body = content.load(&operation.intent["request_ref"])?;
        let intent = operation
            .intent
            .as_object_mut()
            .ok_or_else(|| RuntimeError::Invalid("User job intent malformed".into()))?;
        intent.remove("request_ref");
        intent.insert("request".into(), body);
    }
    super::mcp_interactions::sampling::hydrate_operation(&mut operation, content)?;
    super::inference::hydrate_operation(&mut operation, content)?;
    let result = match operation.result {
        Some(OperationResultMetadata::Control { mut value }) => {
            if let Some(permission) = value.get_mut("permission") {
                let call = content.load(&permission["call_ref"])?;
                let scope = content.load(&permission["scope_ref"])?;
                let record = permission.as_object_mut().ok_or_else(|| {
                    RuntimeError::Invalid("permission record is malformed".into())
                })?;
                record.remove("call_ref");
                record.remove("scope_ref");
                record.insert("call".into(), call);
                record.insert("scope".into(), scope);
            }
            Some(crate::output::OperationResult::Control { value })
        }
        Some(OperationResultMetadata::Content { reference }) => {
            Some(crate::output::OperationResult::Output {
                output: content.load_stored_output(&reference)?,
            })
        }
        None => None,
    };
    let external_receipt = operation
        .external_receipt
        .map(|receipt| {
            Ok::<_, RuntimeError>(crate::types::ExternalReceiptView {
                executor_stopped: receipt.executor_stopped,
                receipt: ExternalReceipt {
                    executor: receipt.executor,
                    identity: receipt.identity,
                    epoch: receipt.epoch,
                    outcome: receipt.outcome,
                    effect: receipt.effect,
                    result: content.load_stored_output(&receipt.result_ref)?,
                },
            })
        })
        .transpose()?;
    Ok(crate::types::Operation {
        mcp_resource_subscription: operation.mcp_resource_subscription,
        host_job: operation
            .host_job
            .map(|link| {
                let mcp_task_result = link
                    .mcp_task
                    .as_ref()
                    .and_then(|task| task.result_ref.as_ref())
                    .map(|reference| content.load_stored_output(reference))
                    .transpose()?;
                Ok::<_, RuntimeError>(super::host_jobs::HostJobView {
                    link,
                    mcp_task_result,
                })
            })
            .transpose()?,
        managed_process: operation.managed_process,
        call_completion: operation
            .call_completion
            .map(|completion| completion.load_stored(content))
            .transpose()?,
        external_receipt,
        id: operation.id,
        run_id: operation.run_id,
        epoch: operation.epoch,
        revision: operation.revision,
        phase: operation.phase,
        outcome: operation.outcome,
        effect: operation.effect,
        cancel_requested: operation.cancel_requested,
        lifetime: operation.lifetime,
        handed_off: operation.handed_off,
        executor: operation.executor,
        execution_owner: operation.execution_owner,
        waiting_on: operation.waiting_on,
        intent: operation.intent,
        result,
    })
}
impl Catalog {
    pub fn capture_request_budget(&self, run_id: &str, epoch: u64) -> Result<RequestBudgetRead> {
        let run = self.run(run_id)?;
        if run.epoch != epoch || epoch != self.epoch || run.cancel_requested || run.state.terminal()
        {
            return Err(RuntimeError::Conflict(
                "request budget owner changed".into(),
            ));
        }
        Ok(RequestBudgetRead {
            run_id: run.id,
            branch_id: run.branch_id,
            epoch,
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn model_step_metadata(&self, id: &str) -> Result<ModelStep> {
        record(&self.db, "model_steps", id)
    }
    pub fn capture_model_step_read(&self, id: &str) -> Result<ModelStepRead> {
        Ok(ModelStepRead {
            metadata: self.model_step_metadata(id)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn capture_operation_read(&self, operation: Operation) -> OperationRead {
        OperationRead {
            operation,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
    pub fn prepare_tool_intent(&self) -> ToolIntentPreparation {
        ToolIntentPreparation {
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn admit_tool_operation(
        &mut self,
        key: &str,
        run_id: &str,
        epoch: u64,
        origin: &ToolOrigin,
        tool: &AdmittedTool,
    ) -> Result<Operation> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self.prepare_tool_intent().load(origin, tool)?;
        self.admit_tool_operation_prepared(key, run_id, epoch, prepared)
    }
    pub fn admit_tool_operation_prepared(
        &mut self,
        key: &str,
        run_id: &str,
        epoch: u64,
        prepared: PreparedToolIntent,
    ) -> Result<Operation> {
        if key
            != prepared
                .intent
                .origin()
                .operation_id(&prepared.intent.call().call_id)
        {
            return Err(RuntimeError::Invalid(
                "tool intent operation identity changed".into(),
            ));
        }
        self.admit_operation_metadata(
            key,
            run_id,
            epoch,
            prepared.intent.contract().lifetime,
            serde_json::to_value(&prepared.intent)?,
        )
    }
}

/// Resolve a nested caller through canonical Operation intents. The original model/graph
/// boundary remains the only frozen directory/source authority; IDs are never parsed.
pub(super) fn root_tool_context(
    db: &Connection,
    context: &ToolExecutionContext,
    live: bool,
) -> Result<ToolExecutionContext> {
    let mut root = context.clone();
    let run: Run = record(db, "runs", &context.run_id)?;
    let mut visited = std::collections::BTreeSet::new();
    while let ToolOrigin::NestedCall {
        parent_operation_id,
    } = &root.origin
    {
        if !visited.insert(parent_operation_id.clone()) {
            return Err(RuntimeError::Invalid("cyclic nested invocation".into()));
        }
        let parent: Operation = record(db, "operations", parent_operation_id)?;
        let intent = ToolIntent::from_operation(&parent)?;
        if parent.run_id != run.id
            || (live
                && (parent.epoch != run.epoch
                    || parent.cancel_requested
                    || parent.phase == OperationPhase::Terminal))
        {
            return Err(RuntimeError::Conflict(
                "nested caller is no longer active in this Run".into(),
            ));
        }
        root = ToolExecutionContext {
            run_id: run.id.clone(),
            origin: intent.origin().clone(),
            operation_id: parent.id,
        };
    }
    Ok(root)
}

/// Validate one admitted Job against its actual model or graph caller. Metadata only.
pub(super) fn require_job_invocation(
    db: &Connection,
    run: &Run,
    op: &Operation,
    context: &ToolExecutionContext,
    tool: &str,
) -> Result<super::tool_content::ToolIntent> {
    let admitted = super::tool_content::ToolIntent::from_operation(op)?;
    if op.id != context.operation_id
        || context.operation_id != context.origin.operation_id(&admitted.call().call_id)
        || op.run_id != run.id
        || op.epoch != run.epoch
        || context.run_id != run.id
        || admitted.origin() != &context.origin
        || admitted.call().name != tool
        || op.executor.as_deref() != Some(tool)
        || admitted.contract().completion != crate::execution::CompletionKind::Job
        || admitted.contract().lifetime != Lifetime::Thread
        || !admitted.contract().read_only
    {
        return Err(RuntimeError::Conflict(
            "job invocation owner or contract changed".into(),
        ));
    }
    let expected: String = match &context.origin {
        ToolOrigin::NestedCall { .. } => {
            root_tool_context(db, context, true)?;
            return Ok(admitted);
        }
        ToolOrigin::ModelStep { request_id } => {
            let step: ModelStep = record(db, "model_steps", request_id)?;
            if step.run_id != run.id || step.state != ModelStepState::Completed {
                return Err(RuntimeError::Conflict(
                    "job call has no completed model owner".into(),
                ));
            }
            db.query_row(
                "SELECT body FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                params![request_id, admitted.call().call_id],
                |row| row.get(0),
            )?
        }
        ToolOrigin::PolicyAction { action_id, node_id } => {
            let graph: Operation = record(db, "operations", action_id)?;
            if graph.run_id != run.id
                || graph.epoch != run.epoch
                || graph.cancel_requested
                || graph.phase == OperationPhase::Terminal
                || super::policy::graph_metadata(&graph)?.is_none()
            {
                return Err(RuntimeError::Conflict(
                    "job call has no active policy graph owner".into(),
                ));
            }
            db.query_row("SELECT call FROM policy_graph_nodes WHERE action_id=?1 AND node_id=?2 AND receipt IS NULL",
                params![action_id, node_id], |row| row.get(0))?
        }
    };
    if serde_json::from_str::<super::tool_content::ToolCallMetadata>(&expected)? != *admitted.call()
    {
        return Err(RuntimeError::Conflict(
            "job call differs from its caller's frozen invocation".into(),
        ));
    }
    Ok(admitted)
}

/// A captured invocation's immutable caller binding. Loading never holds Catalog.
#[derive(Clone)]
enum InvocationOwner {
    Model {
        step: ModelStep,
    },
    Policy {
        operation: Operation,
        metadata: super::policy_body::PolicyActionMetadata,
    },
}
enum InvocationCall {
    Stored(ToolCallMetadata),
    Live(std::sync::Arc<ToolCall>),
}
pub struct ToolInvocationRead {
    root: ToolExecutionContext,
    source: Option<super::launches::SourceSelection>,
    context: ToolExecutionContext,
    branch_id: String,
    call: InvocationCall,
    owner: InvocationOwner,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct ToolInvocationSnapshot {
    pub frozen: crate::execution::FrozenToolContext,
    pub context: ToolExecutionContext,
    pub call: ToolCall,
    pub history_range: crate::execution::HistoryRange,
    pub tools: std::sync::Arc<Vec<crate::execution::ToolSchema>>,
    pub owner_epoch: u64,
    owner: InvocationOwner,
    _publication: crate::content::ContentPublication,
}
impl ToolInvocationRead {
    /// Load the original frozen MCP contribution on a body worker, never in a Catalog transaction.
    pub fn load_mcp(&self) -> Result<(ToolInvocationSnapshot, super::launches::HostToolBinding)> {
        let snapshot = self.load()?;
        let reference = snapshot.frozen.child_dispatch.as_ref().ok_or_else(|| {
            RuntimeError::Conflict("MCP invocation has no original composition".into())
        })?;
        let dispatch: super::dispatch::FrozenChildDispatch =
            serde_json::from_value(self.content.load(reference)?)?;
        let reference = dispatch.mcp_binding_ref.ok_or_else(|| {
            RuntimeError::Conflict("MCP invocation has no original MCP binding".into())
        })?;
        let binding: super::launches::HostToolBinding =
            serde_json::from_value(self.content.load(&reference)?)?;
        binding.validate()?;
        Ok((snapshot, binding))
    }
    pub fn load(&self) -> Result<ToolInvocationSnapshot> {
        use crate::execution::{RequestOrigin, RequestSnapshot};
        let call = match &self.call {
            InvocationCall::Stored(call) => call.clone().load(&self.content)?,
            InvocationCall::Live(call) => call.as_ref().clone(),
        };
        let (history_range, frozen, owner_epoch) = match &self.owner {
            InvocationOwner::Model { step } => {
                let snapshot: RequestSnapshot = self.content.load_snapshot(&step.request)?;
                if snapshot.view.run_id != self.context.run_id
                    || snapshot.view.request_id != step.id
                    || snapshot.view.binding.history_range.branch_id != self.branch_id
                    || !matches!(&snapshot.view.origin, RequestOrigin::Conversation { history_range, .. } if history_range == &snapshot.view.binding.history_range)
                {
                    return Err(RuntimeError::Conflict(
                        "invocation is not its admitted conversation snapshot".into(),
                    ));
                }
                if snapshot.view.binding.resource_activations
                    != super::resources::retained_activations(&snapshot.view.history)
                {
                    return Err(RuntimeError::Conflict(
                        "invocation resource bindings differ from original history".into(),
                    ));
                }
                let binding = snapshot.view.binding;
                (
                    binding.history_range,
                    crate::execution::FrozenToolContext {
                        run_id: self.context.run_id.clone(),
                        origin: self.context.origin.clone(),
                        tools: std::sync::Arc::new(binding.tools),
                        tool_schema_generation: binding.tool_schema_generation,
                        resource_activations: binding.resource_activations,
                        resource_checkpoint_id: binding.resource_checkpoint_id,
                        child_dispatch: binding.child_dispatch,
                        source: self.source.clone(),
                    },
                    step.epoch,
                )
            }
            InvocationOwner::Policy {
                operation,
                metadata,
            } => {
                let graph = metadata.load_graph(&self.content, &self.context.run_id)?;
                let ToolOrigin::PolicyAction { node_id, .. } = &self.root.origin else {
                    unreachable!("captured policy owner")
                };
                let node = graph
                    .nodes()
                    .iter()
                    .find(|node| &node.node.id == node_id)
                    .ok_or_else(|| RuntimeError::NotFound(node_id.clone()))?;
                if (self.root == self.context && node.node.call != call)
                    || node.context.origin != self.root.origin
                    || metadata.boundary().history_range.branch_id != self.branch_id
                {
                    return Err(RuntimeError::Conflict(
                        "invocation differs from its admitted policy node".into(),
                    ));
                }
                (
                    metadata.boundary().history_range.clone(),
                    {
                        let mut frozen = node.context.clone();
                        frozen.origin = self.context.origin.clone();
                        frozen
                    },
                    operation.epoch,
                )
            }
        };
        Ok(ToolInvocationSnapshot {
            context: self.context.clone(),
            call,
            history_range,
            tools: frozen.tools.clone(),
            frozen,
            owner_epoch,
            owner: self.owner.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}
impl Catalog {
    /// Capture the actual model call or graph node without decoding its arguments or binding body.
    pub fn capture_tool_invocation(
        &self,
        context: &ToolExecutionContext,
        call_id: &str,
    ) -> Result<ToolInvocationRead> {
        let run = self.run(&context.run_id)?;
        if context.operation_id != context.origin.operation_id(call_id) {
            return Err(RuntimeError::Conflict(
                "invocation operation identity changed".into(),
            ));
        }
        let root = root_tool_context(&self.db, context, false)?;
        let root_call_id = if root != *context {
            ToolIntent::from_operation(&self.operation(&root.operation_id)?)?
                .call()
                .call_id
                .clone()
        } else {
            call_id.into()
        };
        let (owner, root_call) = match &root.origin {
            ToolOrigin::ModelStep { request_id } => {
                let step = self.model_step_metadata(request_id)?;
                if step.run_id != run.id {
                    return Err(RuntimeError::Conflict(
                        "invocation model owner changed".into(),
                    ));
                }
                let raw: String = self.db.query_row(
                    "SELECT body FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                    params![request_id, root_call_id],
                    |row| row.get(0),
                )?;
                (
                    InvocationOwner::Model { step },
                    serde_json::from_str::<ToolCallMetadata>(&raw)?,
                )
            }
            ToolOrigin::PolicyAction { action_id, node_id } => {
                let operation = self.operation(action_id)?;
                let metadata = super::policy::graph_metadata(&operation)?.ok_or_else(|| {
                    RuntimeError::Invalid("invocation owner is not a policy graph".into())
                })?;
                if operation.run_id != run.id || node_id != &root_call_id {
                    return Err(RuntimeError::Conflict(
                        "invocation graph owner changed".into(),
                    ));
                }
                let raw: String = self.db.query_row("SELECT call FROM policy_graph_nodes WHERE action_id=?1 AND node_id=?2 AND call_id=?3",
                    params![action_id, node_id, root_call_id], |row| row.get(0))?;
                (
                    InvocationOwner::Policy {
                        operation,
                        metadata,
                    },
                    serde_json::from_str::<ToolCallMetadata>(&raw)?,
                )
            }
            ToolOrigin::NestedCall { .. } => unreachable!("resolved root invocation"),
        };
        let call = if root == *context {
            InvocationCall::Stored(root_call)
        } else if let Some(operation) =
            optional_record::<Operation>(&self.db, "operations", &context.operation_id)?
        {
            let intent = ToolIntent::from_operation(&operation)?;
            if operation.run_id != run.id
                || intent.origin() != &context.origin
                || intent.call().call_id != call_id
            {
                return Err(RuntimeError::Conflict(
                    "nested invocation identity changed".into(),
                ));
            }
            InvocationCall::Stored(intent.call().clone())
        } else {
            InvocationCall::Live(
                self.nested_tools
                    .call(context)
                    .filter(|call| call.call_id == call_id)
                    .ok_or_else(|| RuntimeError::NotFound("nested invocation".into()))?,
            )
        };
        Ok(ToolInvocationRead {
            root,
            source: self
                .launch_metadata(&run.id)?
                .and_then(|launch| launch.selection.source),
            context: context.clone(),
            branch_id: run.branch_id,
            call,
            owner,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    /// Recheck the exact immutable caller after body preparation; receipt reconciliation may read a retired owner.
    pub fn validate_tool_invocation(
        &self,
        snapshot: &ToolInvocationSnapshot,
        live: bool,
    ) -> Result<()> {
        let run = self.run(&snapshot.context.run_id)?;
        root_tool_context(&self.db, &snapshot.context, live)?;
        if run.branch_id != snapshot.history_range.branch_id {
            return Err(RuntimeError::Conflict("invocation branch changed".into()));
        }
        match &snapshot.owner {
            InvocationOwner::Model { step } => {
                let current = self.model_step_metadata(&step.id)?;
                if current.run_id != run.id
                    || current.request != step.request
                    || (live && current.superseded_by_input.is_some())
                {
                    return Err(RuntimeError::Conflict(
                        "invocation model binding changed".into(),
                    ));
                }
            }
            InvocationOwner::Policy {
                operation,
                metadata,
            } => {
                let current = self.operation(&operation.id)?;
                if current.run_id != run.id
                    || super::policy::graph_metadata(&current)?.as_ref() != Some(metadata)
                    || (live
                        && (current.cancel_requested || current.phase == OperationPhase::Terminal))
                {
                    return Err(RuntimeError::Conflict(
                        "invocation graph binding changed".into(),
                    ));
                }
            }
        }
        if live {
            if run.epoch != self.epoch || run.cancel_requested || run.state.terminal() {
                return Err(RuntimeError::Conflict(
                    "invocation generation is no longer active".into(),
                ));
            }
            self.inspect_admission(
                &run.id,
                self.epoch,
                &snapshot.context.origin,
                &snapshot.call.call_id,
            )?;
        }
        Ok(())
    }
}
