//! Model cancellation shares the user control owner and original task-tree teardown.
use crate::agent_runtime::control_commands::ControlCommands;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use varin_runtime::execution::*;
use varin_runtime::{Effect, Lifetime, Outcome};

pub(crate) const NAME: &str = "child_cancel";
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Input { operation_id: String }
fn input(call: &ToolCall) -> Result<Input, ExecutionError> {
    let input: Input = serde_json::from_value(call.arguments.clone())
        .map_err(|error| ExecutionError::new("invalid_tool_arguments", error.to_string()))?;
    if input.operation_id.is_empty() { return Err(ExecutionError::new("invalid_tool_arguments", "operationId is required")); }
    Ok(input)
}
pub(crate) fn schema() -> ToolSchema {
    ToolSchema { name: NAME.into(), version: "1".into(), requirements: None, output_schema: None, metadata: None,
        description: "Cancel a child task dispatched by this conversation, including its descendants and preparation. Use the operationId from dispatch or child_status. Returns accepted cancellation, not proof that every executor has stopped; child_status retains the final result and cleanup state.".into(),
        schema: json!({"type":"object","properties":{"operationId":{"type":"string","minLength":1}},"required":["operationId"],"additionalProperties":false}) }
}
pub(crate) fn builtin() -> crate::run_tools::BuiltinSchema {
    crate::run_tools::BuiltinSchema::child(schema(), varin_runtime::catalog::dispatch::ChildSourceRequirement::None,
        &[varin_runtime::catalog::dispatch::ChildPresetDefault::Worker])
}
pub(crate) fn declaration(control: ControlCommands) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(schema(), Arc::new(ChildCancel(control)))
}
struct ChildCancel(ControlCommands);
impl ToolExecutor for ChildCancel {
    fn plan(&self, call: &ToolCall, request: &FrozenToolContext, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, request, cancel).map(ToolPreparation::Ready)
    }
    fn prepare(&self, call: &ToolCall, request: &FrozenToolContext, _: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        let schema = schema();
        if call.name != NAME || call.schema_version != schema.version || !request.tools.contains(&schema) {
            return Err(ExecutionError::new("child_cancel_unavailable", "Child cancellation is not selected for this request"));
        }
        input(call)?;
        Ok(ToolContract { name: NAME.into(), schema_version: schema.version, read_only: false,
            completion: CompletionKind::Result, lifetime: Lifetime::Run, resources: vec![] })
    }
    fn authorize(&self, context: &ToolExecutionContext, call: &ToolCall, _: &ToolContract, cancel: &CancellationToken) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() { return Err(ExecutionError::new("cancelled", "Child cancellation request was cancelled")); }
        if self.0.runtime.catalog().lock().map_err(|_|ExecutionError::new("catalog_unavailable","Catalog unavailable"))?
            .require_external_child_parent(&context.run_id,&input(call)?.operation_id).map_err(|e|ExecutionError::new("child_cancel_target",e.to_string()))?.is_some() { return Ok(()); }
        self.0.runtime.catalog().lock().map_err(|_| ExecutionError::new("catalog_unavailable", "Catalog unavailable"))?
            .require_child_parent(&context.run_id, &input(call)?.operation_id)
            .map_err(|error| ExecutionError::new("child_cancel_target", error.to_string()))?;
        Ok(())
    }
    fn execute(&self, context: &ToolExecutionContext, call: &ToolCall, contract: &ToolContract, cancel: &CancellationToken) -> ToolCompletion {
        let result = (|| {
            self.authorize(context, call, contract, cancel)?;
            {
                let owner=self.0.runtime.catalog();let mut db=owner.lock().map_err(|_|ExecutionError::new("catalog_unavailable","Catalog unavailable"))?;
                let id=input(call)?.operation_id;
                if db.require_external_child_parent(&context.run_id,&id).map_err(|e|ExecutionError::new("child_cancel_target",e.to_string()))?.is_some() {
                    let child=db.cancel_external_child(&context.run_id,&id).map_err(|e|ExecutionError::new("child_cancel_failed",e.to_string()))?;
                    return Ok(json!({"operationId":id,"conversationId":child.conversation_id,"cancelRequested":true}));
                }
            }
            let child = self.0.runtime.catalog().lock().map_err(|_| ExecutionError::new("catalog_unavailable", "Catalog unavailable"))?
                .require_child_parent(&context.run_id, &input(call)?.operation_id)
                .map_err(|error| ExecutionError::new("child_cancel_target", error.to_string()))?;
            self.0.admit_tree_cancel(varin_runtime::catalog::dispatch::TreeCancelTarget::Child { operation_id: child.operation_id },
                Some(&child.parent_thread_id)).map_err(|error| ExecutionError::new("child_cancel_failed", error.to_string())).and_then(|receipt|serde_json::to_value(receipt).map_err(|e|ExecutionError::new("child_cancel_failed",e.to_string())))
        })();
        match result {
            Ok(receipt) => ToolCompletion::Result { outcome: Outcome::Succeeded, effect: Effect::Confirmed,
                content: json!({"cancelRequested":true,"status":"stop_requested","receipt":receipt}).into() },
            Err(error) => ToolCompletion::Result { outcome: Outcome::Failed, effect: Effect::None,
                content: json!({"code":error.code,"message":error.message}).into() },
        }
    }
}
