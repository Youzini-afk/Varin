//! Background retrieval observation and cancellation share the original Catalog task owner.
use crate::agent_runtime::control_commands::ControlCommands;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use varin_runtime::execution::*;
use varin_runtime::{Effect, Lifetime, Outcome};

pub(crate) const NAME: &str = varin_runtime::catalog::retrieval::CONTROL_TOOL;

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Action {
    Status,
    Wait,
    Stop,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    operation_id: String,
    action: Action,
}
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("retrieval_control", value.to_string())
}
fn input(call: &ToolCall) -> Result<Input, ExecutionError> {
    let input: Input = serde_json::from_value(call.arguments.clone()).map_err(error)?;
    if input.operation_id.trim().is_empty() {
        return Err(error("operationId is required"));
    }
    Ok(input)
}
pub(crate) fn schema() -> ToolSchema {
    ToolSchema { name: NAME.into(),version:"1".into(),requirements:None,output_schema:None,metadata:None,
        description:"Observe, wait for, or stop a background code_retrieval from this conversation branch. status returns the actual state, elapsed time, latest assistant message and latest action; it does not wait or request a new summary. wait durably parks this Run until the investigation stops; cancelling the wait leaves the investigation running. stop requests cancellation, retaining existing content, and distinguishes the request from confirmed stop. The final answer is delivered automatically once; no result-read call is required.".into(),
        schema:json!({"type":"object","additionalProperties":false,"properties":{
            "operationId":{"type":"string","minLength":1},"action":{"type":"string","enum":["status","wait","stop"]}},"required":["operationId","action"]}) }
}
pub(crate) fn builtin() -> crate::run_tools::BuiltinSchema {
    use varin_runtime::catalog::dispatch::{
        ChildPresetDefault::{Retrieval, Worker},
        ChildSourceRequirement::None,
    };
    crate::run_tools::BuiltinSchema::child(schema(), None, &[Worker, Retrieval])
}
pub(crate) fn declaration(
    control: ControlCommands,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(),
        Arc::new(RetrievalControl(control)),
    )
}
struct RetrievalControl(ControlCommands);
impl RetrievalControl {
    fn selected(&self, context:&ToolExecutionContext,call:&ToolCall)->Result<(Input,Option<String>),ExecutionError> {
        let mut input=input(call)?;
        let catalog=self.0.runtime.catalog();let db=catalog.lock().map_err(error)?;
        let exact=if input.operation_id.contains('/') {
            match db.resolve_execution_reference(&input.operation_id).map_err(error)?.target {
                varin_runtime::catalog::model_references::ExecutionTarget::Delegated{operation_id,execution_id,..}=>{input.operation_id=operation_id;Some(execution_id)},
                _=>return Err(error("This is not an internal retrieval execution")),
            }
        }else{None};
        let child=db.require_retrieval_parent(&context.run_id,&input.operation_id).map_err(error)?;
        if exact.as_ref().is_some_and(|id|id!=&child.execution_id) {return Err(error("Retrieval control cannot retarget another execution"));}
        Ok((input,exact))
    }
}
impl ToolExecutor for RetrievalControl {
    fn plan(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, frozen, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let schema = schema();
        if call.name != NAME
            || call.schema_version != schema.version
            || !frozen.tools.contains(&schema)
        {
            return Err(error("Retrieval control is not selected in this request"));
        }
        let action = input(call)?.action;
        Ok(ToolContract {
            name: NAME.into(),
            schema_version: schema.version,
            read_only: action != Action::Stop,
            completion: if action == Action::Wait {
                CompletionKind::Job
            } else {
                CompletionKind::Result
            },
            lifetime: if action == Action::Wait {
                Lifetime::Thread
            } else {
                Lifetime::Run
            },
            resources: vec![],
        })
    }
    fn supports_policy_read(
        &self,
        _: &FrozenToolContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> bool {
        contract.read_only
            && contract.completion == CompletionKind::Result
            && input(call).is_ok_and(|input| input.action == Action::Status)
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("Retrieval observation cancelled before admission"));
        }
        self.selected(context,call)?;
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let executed = (|| {
            self.authorize(context, call, contract, cancel)?;
            let (input,exact) = self.selected(context,call)?;
            let catalog = self.0.runtime.catalog();
            match input.action {
                Action::Status => {
                    let read = catalog
                        .lock()
                        .map_err(error)?
                        .capture_retrieval_status(&context.run_id, &input.operation_id)
                        .map_err(error)?;
                    Ok(ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::None,
                        content: read.load().map_err(error)?.into(),
                    })
                }
                Action::Wait => {
                    let read = {let db=catalog.lock().map_err(error)?;
                        if let Some(execution)=&exact {db.prepare_delegated_wait_registration(context,&input.operation_id,execution)}
                        else {db.prepare_child_wait_registration(context,&input.operation_id)}.map_err(error)?};
                    let prepared = read.load().map_err(error)?;
                    catalog
                        .lock()
                        .map_err(error)?
                        .register_child_wait(prepared)
                        .map_err(error)?;
                    let read=catalog.lock().map_err(error)?.capture_call_completion(&context.operation_id).map_err(error)?;
                    read.load().map_err(error)
                }
                Action::Stop => {
                    let parent_thread = catalog
                        .lock()
                        .map_err(error)?
                        .run(&context.run_id)
                        .map_err(error)?
                        .thread_id;
                    self.0
                        .admit_tree_cancel(
                            if let Some(execution)=&exact {varin_runtime::catalog::dispatch::TreeCancelTarget::Execution {execution_id:execution.clone()}}
                            else {varin_runtime::catalog::dispatch::TreeCancelTarget::Child {operation_id:input.operation_id.clone()}},
                            Some(&parent_thread),
                        )
                        .map_err(error)?;
                    let read = catalog
                        .lock()
                        .map_err(error)?
                        .capture_retrieval_status(&context.run_id, &input.operation_id)
                        .map_err(error)?;
                    Ok(ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::Confirmed,
                        content: read.load().map_err(error)?.into(),
                    })
                }
            }
        })();
        executed.unwrap_or_else(|failure: ExecutionError| ToolCompletion::Result {
            outcome: Outcome::Failed,
            effect: Effect::None,
            content: json!({"code":failure.code,"message":failure.message}).into(),
        })
    }
}
