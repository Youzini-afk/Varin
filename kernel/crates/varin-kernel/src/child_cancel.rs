//! Model cancellation shares the user control owner and original task-tree teardown.
use crate::agent_runtime::control_commands::ControlCommands;
use serde::Deserialize;
use serde_json::json;
use varin_runtime::catalog::model_references::{ExecutionReference, ExecutionTarget};
use std::sync::Arc;
use varin_runtime::execution::*;
use varin_runtime::{Effect, Lifetime, Outcome};

pub(crate) const NAME: &str = "child_cancel";
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Input {
    #[serde(default)] operation_id: String,
    #[serde(default)] target: Option<String>,
}
fn input(call: &ToolCall) -> Result<Input, ExecutionError> {
    let input: Input = serde_json::from_value(call.arguments.clone())
        .map_err(|error| ExecutionError::new("invalid_tool_arguments", error.to_string()))?;
    if input.target.as_ref().is_some_and(String::is_empty) || input.target.is_some() && !input.operation_id.is_empty()
        || input.target.is_none() && input.operation_id.is_empty() { return Err(ExecutionError::new("invalid_tool_arguments", "Choose an exact execution target, a unique Agent, or original operationId")); }
    Ok(input)
}
pub(crate) fn schema() -> ToolSchema {
    ToolSchema { name: NAME.into(), version: "1".into(), requirements: None, output_schema: None, metadata: None,
        description: "Stop the exact execution selected by target=Agent/sequence, or a unique Agent execution fixed at acceptance. Original operationId retains legacy child-tree cancellation, including descendants and preparation. Returns accepted cancellation, not proof that every executor has stopped; child_status retains the final result and cleanup state.".into(),
        schema: json!({"type":"object","properties":{"target":{"type":"string","minLength":1},"operationId":{"type":"string","minLength":1}},"anyOf":[{"required":["target"]},{"required":["operationId"]}],"additionalProperties":false}) }
}
pub(crate) fn builtin() -> crate::run_tools::BuiltinSchema {
    crate::run_tools::BuiltinSchema::child(schema(), varin_runtime::catalog::dispatch::ChildSourceRequirement::None,
        &[varin_runtime::catalog::dispatch::ChildPresetDefault::Worker])
}
pub(crate) fn declaration(control: ControlCommands) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(schema(), Arc::new(ChildCancel(control)))
}
struct ChildCancel(ControlCommands);
impl ChildCancel {
    fn resolve(&self, context: &ToolExecutionContext, target: &str, freeze: bool) -> Result<ExecutionReference, ExecutionError> {
        let owner = self.0.runtime.catalog();
        let mut db = owner.lock().map_err(|_|ExecutionError::new("catalog_unavailable","Catalog unavailable"))?;
        let error = |e: varin_runtime::RuntimeError|ExecutionError::new("child_cancel_target",e.to_string());
        let original = json!({"target":target});
        if let Some(fixed) = db.model_target(&context.operation_id,"child-cancel-target",&original).map_err(error)? {
            let selected:ExecutionReference=serde_json::from_value(fixed).map_err(|e|ExecutionError::new("child_cancel_target",e.to_string()))?;
            db.resolve_child_target(&context.run_id,&selected.reference).map_err(error)?;
            return Ok(selected);
        }
        let selected = db.resolve_child_target(&context.run_id,target).map_err(error)?;
        if !freeze { return Ok(selected); }
        let fixed = db.freeze_model_target(&context.operation_id,"child-cancel-target",&original,&serde_json::to_value(&selected).map_err(|e|ExecutionError::new("child_cancel_target",e.to_string()))?).map_err(error)?;
        serde_json::from_value(fixed).map_err(|e|ExecutionError::new("child_cancel_target",e.to_string()))
    }
}
impl ToolExecutor for ChildCancel {
    fn plan(&self, call: &ToolCall, request: &FrozenToolContext, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, request, cancel).map(ToolPreparation::Ready)
    }
    fn prepare(&self, call: &ToolCall, request: &FrozenToolContext, _: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        let schema = schema();
        if call.name != NAME || call.schema_version != schema.version || !request.tools.iter().any(|selected|selected.name==call.name && selected.version==call.schema_version) {
            return Err(ExecutionError::new("child_cancel_unavailable", "Child cancellation is not selected for this request"));
        }
        input(call)?;
        Ok(ToolContract { name: NAME.into(), schema_version: schema.version, read_only: false,
            completion: CompletionKind::Result, lifetime: Lifetime::Run, resources: vec![] })
    }
    fn authorize(&self, context: &ToolExecutionContext, call: &ToolCall, _: &ToolContract, cancel: &CancellationToken) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() { return Err(ExecutionError::new("cancelled", "Child cancellation request was cancelled")); }
        if let Some(target) = input(call)?.target { self.resolve(context,&target,false)?; return Ok(()); }
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
            if let Some(target) = input(call)?.target {
                let selected = self.resolve(context,&target,true)?;
                let target = match selected.target {
                    ExecutionTarget::Delegated { execution_id, .. } => varin_runtime::catalog::dispatch::TreeCancelTarget::Execution {execution_id},
                    ExecutionTarget::Native { run_id, .. } => varin_runtime::catalog::dispatch::TreeCancelTarget::Run {run_id},
                    ExecutionTarget::External {operation_id:Some(operation_id),..} => {
                        let owner = self.0.runtime.catalog();
                        let child = owner.lock().map_err(|_|ExecutionError::new("catalog_unavailable","Catalog unavailable"))?
                            .cancel_external_child(&context.run_id,&operation_id).map_err(|e|ExecutionError::new("child_cancel_failed",e.to_string()))?;
                        return Ok(json!({"ref":selected.reference,"state":child.state,"cancelRequested":true}));
                    }
                    _ => return Err(ExecutionError::new("child_cancel_target","No delegated execution selected")),
                };
                return self.0.admit_tree_cancel(target,None).map_err(|e|ExecutionError::new("child_cancel_failed",e.to_string()))
                    .map(|receipt|json!({"ref":selected.reference,"receipt":receipt}));
            }
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
