//! Frozen tool arguments are immutable content; control transitions use their identities.
use super::*;
use crate::execution::{
    AdmittedTool, ToolCall, ToolContract, ToolExecutionContext, ToolInvocation, ToolOrigin,
};
use serde::Deserialize;

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
            Some(value)
        }
        Some(OperationResultMetadata::Content { reference }) => Some(content.load(&reference)?),
        None => None,
    };
    let external_receipt = operation
        .external_receipt
        .map(|receipt| {
            Ok::<_, RuntimeError>(ExternalReceipt {
                executor: receipt.executor,
                identity: receipt.identity,
                epoch: receipt.epoch,
                outcome: receipt.outcome,
                effect: receipt.effect,
                result: content.load(&receipt.result_ref)?,
            })
        })
        .transpose()?;
    Ok(crate::types::Operation {
        call_completion: operation
            .call_completion
            .map(|completion| completion.load(content))
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
enum InvocationOwner {
    Model {
        step: ModelStep,
    },
    Policy {
        operation: Operation,
        metadata: super::policy_body::PolicyActionMetadata,
    },
}
pub struct ToolInvocationRead {
    context: ToolExecutionContext,
    branch_id: String,
    call: ToolCallMetadata,
    owner: InvocationOwner,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct ToolInvocationSnapshot {
    pub context: ToolExecutionContext,
    pub call: ToolCall,
    pub history_range: crate::execution::HistoryRange,
    pub tools: std::sync::Arc<Vec<crate::execution::ToolSchema>>,
    pub owner_epoch: u64,
    owner: InvocationOwner,
    _publication: crate::content::ContentPublication,
}
impl ToolInvocationRead {
    pub fn load(self) -> Result<ToolInvocationSnapshot> {
        use crate::execution::{RequestOrigin, RequestSnapshot};
        let call = self.call.load(&self.content)?;
        let (history_range, tools, owner_epoch) = match &self.owner {
            InvocationOwner::Model { step } => {
                let snapshot: RequestSnapshot =
                    serde_json::from_value(self.content.load(&step.request)?)?;
                if snapshot.view.run_id != self.context.run_id
                    || snapshot.view.request_id != step.id
                    || snapshot.view.binding.history_range.branch_id != self.branch_id
                    || !matches!(&snapshot.view.origin, RequestOrigin::Conversation { history_range, .. } if history_range == &snapshot.view.binding.history_range)
                {
                    return Err(RuntimeError::Conflict(
                        "invocation is not its admitted conversation snapshot".into(),
                    ));
                }
                (
                    snapshot.view.binding.history_range,
                    std::sync::Arc::new(snapshot.view.binding.tools),
                    step.epoch,
                )
            }
            InvocationOwner::Policy {
                operation,
                metadata,
            } => {
                let graph = metadata.load_graph(&self.content, &self.context.run_id)?;
                let ToolOrigin::PolicyAction { node_id, .. } = &self.context.origin else {
                    unreachable!("captured policy owner")
                };
                let node = graph
                    .nodes()
                    .iter()
                    .find(|node| &node.node.id == node_id)
                    .ok_or_else(|| RuntimeError::NotFound(node_id.clone()))?;
                if node.node.call != call
                    || node.context.origin != self.context.origin
                    || metadata.boundary().history_range.branch_id != self.branch_id
                {
                    return Err(RuntimeError::Conflict(
                        "invocation differs from its admitted policy node".into(),
                    ));
                }
                (
                    metadata.boundary().history_range.clone(),
                    node.context.tools.clone(),
                    operation.epoch,
                )
            }
        };
        Ok(ToolInvocationSnapshot {
            context: self.context,
            call,
            history_range,
            tools,
            owner_epoch,
            owner: self.owner,
            _publication: self._publication,
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
        let (owner, call) = match &context.origin {
            ToolOrigin::ModelStep { request_id } => {
                let step = self.model_step_metadata(request_id)?;
                if step.run_id != run.id {
                    return Err(RuntimeError::Conflict(
                        "invocation model owner changed".into(),
                    ));
                }
                let raw: String = self.db.query_row(
                    "SELECT body FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                    params![request_id, call_id],
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
                if operation.run_id != run.id || node_id != call_id {
                    return Err(RuntimeError::Conflict(
                        "invocation graph owner changed".into(),
                    ));
                }
                let raw: String = self.db.query_row("SELECT call FROM policy_graph_nodes WHERE action_id=?1 AND node_id=?2 AND call_id=?3",
                    params![action_id, node_id, call_id], |row| row.get(0))?;
                (
                    InvocationOwner::Policy {
                        operation,
                        metadata,
                    },
                    serde_json::from_str::<ToolCallMetadata>(&raw)?,
                )
            }
        };
        Ok(ToolInvocationRead {
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
