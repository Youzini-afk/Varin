//! Observation and control of managed processes across Runs of the same Thread/branch.
use crate::tools::{KernelResourceClient, ToolBinding, ToolKind};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::process_wait::WAIT_TOOL;
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};
const STOP_TOOL: &str = "process_stop";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Handle {
    process_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadHandle {
    process_id: String,
    cursor: u64,
    max_bytes: Option<u64>,
    #[serde(default)]
    mode: crate::process::text::Mode,
    encoding: Option<String>,
}
fn interacts(name: &str) -> bool {
    matches!(name, "process_write" | "process_resize")
}
fn observes(name: &str) -> bool {
    matches!(name, "process_inspect" | "process_read")
}
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("process", value.to_string())
}
pub(crate) fn builtin_schemas(
    mut tools: Vec<crate::run_tools::BuiltinSchema>,
) -> Vec<crate::run_tools::BuiltinSchema> {
    use varin_runtime::catalog::dispatch::{
        ChildPresetDefault::{Worker, Retrieval}, ChildSourceRequirement::Physical,
    };
    let schemas = schemas(tools.iter().map(|tool| tool.schema.clone()).collect());
    for schema in schemas {
        if !tools.iter().any(|tool| tool.schema.name == schema.name) {
            tools.push(crate::run_tools::BuiltinSchema::child(
                schema,
                Physical,
                &[Worker, Retrieval],
            ));
        }
    }
    tools
}
pub(crate) fn schemas(mut tools: Vec<ToolSchema>) -> Vec<ToolSchema> {
    tools.retain(|tool| tool.name != WAIT_TOOL && tool.name != STOP_TOOL);
    if tools.iter().any(|tool| tool.name == "process_inspect") {
        tools.push(ToolSchema { requirements: None, description: "Wait durably for an original managed process. Use the processId returned by process_spawn or the environmentId returned by script_open. Script environments remain bound to their original Run. This parks model execution until an observed terminal fact; cancelling this observation does not stop the process. Read output separately with process_read.".into(), output_schema: None, metadata: None, name: WAIT_TOOL.into(), version: "1".into(), schema: json!({"type":"object",
            "properties":{"processId":{"type":"string","minLength":1}}, "required":["processId"], "additionalProperties":false
        }) });
    }
    if tools.iter().any(|tool| tool.name == "process_spawn") {
        tools.push(ToolSchema {
            requirements: None, name: STOP_TOOL.into(), version: "1".into(),
            description: "Stop a process started with process_spawn, including its child processes. Use its processId. Returns the cancellation request and observed stop status; wait_process can wait for exit, and process_read retains output.".into(),
            output_schema: None, metadata: None,
            schema: json!({"type":"object","properties":{"processId":{"type":"string","minLength":1}},"required":["processId"],"additionalProperties":false}),
        });
    }
    tools
}
pub(crate) fn declarations(
    catalog: Arc<Mutex<Catalog>>,
    binding: ToolBinding,
    resources: KernelResourceClient,
) -> Vec<varin_runtime::composition::tools::ToolDeclaration> {
    let selected = crate::tools::KernelToolExecutor::selected_schemas(&binding.enabled_tools);
    let endpoint = Arc::new(ProcessWaitTools {
        catalog,
        binding,
        resources,
    });
    schemas(selected)
        .into_iter()
        .filter(|schema| {
            schema.name == WAIT_TOOL || schema.name == STOP_TOOL || observes(&schema.name) || interacts(&schema.name)
        })
        .map(|schema| {
            varin_runtime::composition::tools::ToolDeclaration::new(schema, endpoint.clone())
        })
        .collect()
}
struct ProcessWaitTools {
    catalog: Arc<Mutex<Catalog>>,
    binding: ToolBinding,
    resources: KernelResourceClient,
}
impl ProcessWaitTools {
    fn handle(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
    ) -> Result<String, ExecutionError> {
        if context.run_id != self.binding.run_id
            || !self
                .binding
                .enabled_tools
                .contains(&if call.name == STOP_TOOL { ToolKind::ProcessSpawn } else { ToolKind::ProcessInspect })
        {
            return Err(error(
                "process control requires the bound Run and selected process capability",
            ));
        }
        let handle: Handle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if handle.process_id.is_empty() {
            return Err(error("processId required"));
        }
        self.check_owner(context, &handle.process_id)?;
        if call.name == STOP_TOOL {
            let owner = self.catalog.lock().map_err(error)?;
            let process = owner.operation(&handle.process_id).map_err(error)?;
            if process.managed_process.as_ref().is_some_and(|binding| binding.is_environment()) {
                return Err(error("Use script_close to close a script environment"));
            }
        }
        Ok(handle.process_id)
    }
    fn check_owner(&self, c: &ToolExecutionContext, id: &str) -> Result<String, ExecutionError> {
        let db = self.catalog.lock().map_err(error)?;
        let source = db
            .require_process_observation(&c.run_id, id)
            .map_err(error)?;
        let launch = db
            .launch_metadata(&c.run_id)
            .map_err(error)?
            .ok_or_else(|| error("process observation requires saved launch"))?;
        if launch.selection.source.as_ref()
            != Some(&self.binding.source_selection().map_err(error)?)
        {
            return Err(error("process observation source changed"));
        }
        Ok(source.run_id)
    }
    fn validate_contract(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> Result<(), ExecutionError> {
        let expected = if observes(&call.name) || interacts(&call.name) {
            crate::tools::KernelToolExecutor::new(self.binding.clone(), self.resources.clone())?
                .process_observation_contract(c, call)?
        } else {
            ToolContract {
                name: call.name.clone(),
                schema_version: "1".into(),
                read_only: call.name != STOP_TOOL,
                completion: if call.name == STOP_TOOL { CompletionKind::Result } else { CompletionKind::Job },
                lifetime: if call.name == STOP_TOOL { Lifetime::Run } else { Lifetime::Thread },
                resources: vec![],
            }
        };
        if call.schema_version != "1" || &expected != contract {
            return Err(error("process observation contract changed"));
        }
        Ok(())
    }
    fn interaction_input(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
    ) -> Result<(String, crate::process::interaction::Input), ExecutionError> {
        let (id, input, kind) = if call.name == "process_write" {
            let args: crate::tools::ProcessWriteArgs =
                serde_json::from_value(call.arguments.clone()).map_err(error)?;
            let input=args.input(&self.binding,&self.resources)?;
            (args.process_id,input,ToolKind::ProcessWrite)
        } else {
            let args: crate::tools::ProcessResizeArgs =
                serde_json::from_value(call.arguments.clone()).map_err(error)?;
            (
                args.process_id,
                crate::process::interaction::Input::Resize {
                    cols: args.cols,
                    rows: args.rows,
                },
                ToolKind::ProcessResize,
            )
        };
        if !self.binding.enabled_tools.contains(&kind) || c.run_id != self.binding.run_id {
            return Err(error("process interaction is not selected for this Run"));
        }
        let owner = self.check_owner(c, &id)?;
        if owner != c.run_id {
            return Err(error("follow-up process delegation is observation-only"));
        }
        let catalog = self.catalog.lock().map_err(error)?;
        let process = catalog.operation(&id).map_err(error)?;
        if process
            .managed_process
            .as_ref()
            .is_none_or(|p| p.is_environment())
        {
            return Err(error(
                "Script environment input is private to its admitted cell",
            ));
        }
        if process.external_receipt.as_ref().is_some_and(|receipt| receipt.executor_stopped) {
            return Err(ExecutionError::new("process_exited", "The process has exited; input and terminal resize are no longer available. Use process_read to read its retained output."));
        }
        if process.cancel_requested {
            return Err(ExecutionError::new("process_stopping", "The process is stopping; input and terminal resize are no longer available. Use process_inspect or wait_process to observe its exit."));
        }
        Ok((id, input))
    }
    fn interaction(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<ToolCompletion, ExecutionError> {
        self.validate_contract(c, call, contract)?;
        let (id, input) = self.interaction_input(c, call)?;
        let client = self
            .resources
            .interactions
            .as_ref()
            .ok_or_else(|| error("process interaction owner unavailable"))?;
        let address = crate::storage::process_interactions::Address {
            workspace_id: self.binding.workspace_id.clone(),
            process_id: id,
            operation_id: c.operation_id.clone(),
            root_id: self.binding.root_id.clone(),
        };
        let context = crate::storage::process_interactions::Context {
            grant_id: self.binding.grant_id.clone(),
            epoch: None,
            binding: Some(self.binding.clone()),
        };
        let native = crate::storage::process_interactions::Native {
            resource_owner: self.binding.resource_owner.clone(),
            context: c.clone(),
            executor: call.name.clone(),
        };
        let receipt = client
            .invoke(
                context,
                address,
                || Ok(input),
                Some(native.clone()),
                cancel.clone(),
            )
            .map_err(|failure| {
                ExecutionError::new(
                    if failure.dispatched {
                        "process_effect_unknown"
                    } else {
                        "process_not_dispatched"
                    },
                    failure.error.to_string(),
                )
            })?;
        if receipt.identity().state != crate::process::interaction::State::Unknown {
            crate::agent_runtime::record_process_interaction(
                &self.catalog,
                &native,
                &receipt,
                true,
            )
            .map_err(|failure| {
                ExecutionError::new("process_effect_unknown", failure.to_string())
            })?;
        }
        Ok(ToolCompletion::Result {
            outcome: receipt.outcome(),
            effect: receipt.effect(),
            content: serde_json::to_value(receipt)
                .map_err(|failure| {
                    ExecutionError::new("process_effect_unknown", failure.to_string())
                })?
                .into(),
        })
    }
    fn observe(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        authorize_only: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let kind = if call.name == "process_read" {
            ToolKind::ProcessRead
        } else {
            ToolKind::ProcessInspect
        };
        if !self.binding.enabled_tools.contains(&kind) {
            return Err(error("process observation tool is not selected"));
        }
        let (id, read, mode, encoding) = if call.name == "process_read" {
            let h: ReadHandle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            crate::process::text::validate_encoding(h.encoding.as_deref()).map_err(error)?;
            (h.process_id, Some(crate::process::text::ReadPage{cursor:h.cursor,max_bytes:h.max_bytes,mode:h.mode.clone(),encoding:h.encoding.clone()}), h.mode, h.encoding)
        } else {
            let h: Handle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            (h.process_id, None, crate::process::text::Mode::Text, None)
        };
        let source_run_id = self.check_owner(c, &id)?;
        let lineage = self
            .catalog
            .lock()
            .map_err(error)?
            .process_result_lineage(&c.run_id, &id)
            .map_err(error)?;
        let mut value = self.resources.observe_process(
            &self.binding,
            c,
            &id,
            &source_run_id,
            lineage,
            read,
            authorize_only,
            cancel,
        )?;
        if !authorize_only { crate::process::text::project(&mut value, &mode, encoding.as_deref()); }
        Ok(value)
    }
}
impl ToolExecutor for ProcessWaitTools {
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        Ok(Box::new(ProcessCall {
            owner: self,
            call: call.clone(),
            frozen: frozen.clone(),
        }))
    }
    fn execute_receipt(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        if interacts(&call.name) && self.binding.remote_authority.is_some() {
            let result = (|| -> Result<ToolExecutionReceipt, ExecutionError> {
                self.validate_contract(c, call, contract)?;
                self.interaction_input(c, call)?;
                let executor = crate::tools::KernelToolExecutor::new(
                    self.binding.clone(),
                    self.resources.clone(),
                )?;
                let result = executor.remote_tool("execute", c, call, cancel)?;
                let receipt: ToolExecutionReceipt =
                    serde_json::from_value(result["result"].clone()).map_err(error)?;
                if let ToolCompletion::Result { content, .. } = &receipt.completion {
                    if let Ok(actual) = serde_json::from_value::<crate::process::interaction::Receipt>(
                        content.data.clone(),
                    ) {
                        let native = crate::storage::process_interactions::Native {
                            resource_owner: self.binding.resource_owner.clone(),
                            context: c.clone(),
                            executor: call.name.clone(),
                        };
                        crate::agent_runtime::record_process_interaction(
                            &self.catalog,
                            &native,
                            &actual,
                            receipt.executor_stopped,
                        )
                        .map_err(error)?;
                    }
                }
                Ok(receipt)
            })();
            return result.unwrap_or_else(|e| ToolExecutionReceipt {
                completion: ToolCompletion::Result {
                    outcome: Outcome::Indeterminate,
                    effect: Effect::Unknown,
                    content: json!({"error":ExecutionError::new("source_unavailable", e.to_string())}).into(),
                },
                executor_stopped: false,
            });
        }
        ToolExecutionReceipt::local(self.execute(c, call, contract, cancel), contract)
    }
    fn watch_admission(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError>
    {
        crate::tools::KernelToolExecutor::new(self.binding.clone(), self.resources.clone())?
            .watch_admission(c, call, contract, cancel)
    }
    fn supports_policy_read(
        &self,
        frozen: &FrozenToolContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> bool {
        observes(&call.name)
            && crate::tools::KernelToolExecutor::new(self.binding.clone(), self.resources.clone())
                .is_ok_and(|executor| executor.supports_policy_read(frozen, call, contract))
    }
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, context, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if observes(&call.name) || interacts(&call.name) {
            return crate::tools::KernelToolExecutor::new(
                self.binding.clone(),
                self.resources.clone(),
            )?
            .prepare(call, frozen, _cancel);
        }
        let schema = schemas(crate::tools::KernelToolExecutor::selected_schemas(
            &self.binding.enabled_tools,
        ))
        .into_iter()
        .find(|tool| tool.name == call.name)
        .ok_or_else(|| error("process control or wait is not selected"))?;
        if call.schema_version != "1" || !frozen.tools.contains(&schema) {
            return Err(error("process tool schema is not frozen"));
        }
        let handle: Handle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if handle.process_id.is_empty() {
            return Err(error("processId required"));
        }
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: "1".into(),
            read_only: call.name != STOP_TOOL,
            completion: if call.name == STOP_TOOL { CompletionKind::Result } else { CompletionKind::Job },
            lifetime: if call.name == STOP_TOOL { Lifetime::Run } else { Lifetime::Thread },
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if interacts(&call.name) {
            if cancel.is_cancelled() {
                return Err(error("process input cancelled before authorization"));
            }
            self.validate_contract(c, call, contract)?;
            let (id, _) = self.interaction_input(c, call)?;
            if self.binding.remote_authority.is_some() {
                return crate::tools::KernelToolExecutor::new(
                    self.binding.clone(),
                    self.resources.clone(),
                )?
                .remote_tool("authorize", c, call, cancel)
                .and_then(|value| {
                    let actual: ToolContract = serde_json::from_value(value).map_err(error)?;
                    if &actual == contract {
                        Ok(())
                    } else {
                        Err(error("Managed process contract changed"))
                    }
                });
            }
            return self
                .resources
                .interactions
                .as_ref()
                .ok_or_else(|| error("process interaction owner unavailable"))?
                .access(self.binding.clone(), id)
                .map(|_| ())
                .map_err(error);
        }
        if observes(&call.name) {
            self.validate_contract(c, call, contract)?;
            return self.observe(c, call, true, cancel).map(|_| ());
        }
        if cancel.is_cancelled() {
            return Err(error("process observation cancelled"));
        }
        self.validate_contract(c, call, contract)?;
        let id = self.handle(c, call)?;
        let source_run_id = self.check_owner(c, &id)?;
        let lineage = self.catalog.lock().map_err(error)?.process_result_lineage(&c.run_id, &id).map_err(error)?;
        self.resources
            .observe_process(&self.binding, c, &id, &source_run_id, lineage, None, true, cancel)
            .map(|_| ())
    }
    fn execute(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        if interacts(&call.name) {
            return self
                .interaction(c, call, contract, cancel)
                .unwrap_or_else(|error| {
                    if error.code == "process_effect_unknown" {
                        ToolCompletion::Result {
                            outcome: Outcome::Indeterminate,
                            effect: Effect::Unknown,
                            content: json!({"error":error}).into(),
                        }
                    } else {
                        ToolCompletion::not_dispatched(error)
                    }
                });
        }
        if observes(&call.name) {
            if let Err(e) = self.validate_contract(c, call, contract) {
                return ToolCompletion::not_dispatched(e);
            }
            return match self.observe(c, call, false, cancel) {
                Ok(content) => ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    effect: Effect::None,
                    content: content.into(),
                },
                Err(e) => ToolCompletion::Result {
                    outcome: Outcome::Failed,
                    effect: Effect::None,
                    content: json!({"error":e}).into(),
                },
            };
        }
        let result = (|| -> Result<ToolCompletion, ExecutionError> {
            self.authorize(c, call, contract, cancel)?;
            let id = self.handle(c, call)?;
            if call.name == STOP_TOOL {
                let operation = self.catalog.lock().map_err(error)?
                    .request_cancel_operation(&id).map_err(error)?;
                let already_stopped = operation.external_receipt.as_ref().is_some_and(|receipt| receipt.executor_stopped);
                let delivery = if already_stopped { Ok(true) } else {
                    self.resources.cancel_process(&id, &operation.run_id).map_err(ExecutionError::from)
                };
                let observed = self.catalog.lock().map_err(error)?.operation(&id).map_err(error)?;
                let stopped = observed.external_receipt.as_ref().is_some_and(|receipt| receipt.executor_stopped);
                let mut content = json!({"processId":id,"cancelRequested":observed.cancel_requested,
                    "status":if stopped {"stopped"} else {"stop_requested"},"stopConfirmed":stopped,
                    "signalDelivered":if already_stopped { Some(false) } else { delivery.as_ref().ok().copied() },
                    "outcome":observed.outcome});
                if let Err(failure) = &delivery { content["error"] = json!(failure); }
                return Ok(ToolCompletion::Result {
                    outcome: if delivery.is_ok() { Outcome::Succeeded } else { Outcome::Failed },
                    effect: Effect::Confirmed,
                    content: content.into(),
                });
            }
            self.catalog
                .lock()
                .map_err(error)?
                .wait_for_process(c, &id)
                .map_err(error)?;
            Ok(ToolCompletion::JobAccepted {
                operation_id: c.operation_id.clone(),
                phase: "awaiting_process".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
                content: None,
            })
        })();
        result.unwrap_or_else(|e| ToolCompletion::Result {
            outcome: Outcome::Failed,
            effect: Effect::None,
            content: json!({"error":e}).into(),
        })
    }
}

struct ProcessCall {
    owner: Arc<ProcessWaitTools>,
    call: ToolCall,
    frozen: FrozenToolContext,
}
impl PreparedToolCall for ProcessCall {
    fn executor_owner(&self) -> varin_runtime::ExecutorOwner {
        if interacts(&self.call.name) {
            if let Some(remote) = &self.owner.binding.remote_authority {
                return remote.execution_owner.clone();
            }
        }
        varin_runtime::ExecutorOwner::Kernel
    }
    fn plan(&self, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        self.owner.plan(&self.call, &self.frozen, cancel)
    }
    fn prepare(&self, cancel: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        self.owner.prepare(&self.call, &self.frozen, cancel)
    }
    fn execution_class(
        &self,
        contract: &ToolContract,
    ) -> varin_runtime::execution_capacity::ExecutionClass {
        self.owner.execution_class(&self.call, contract)
    }
    fn watch_admission(
        &self,
        c: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError>
    {
        self.owner.watch_admission(c, &self.call, contract, cancel)
    }
    fn supports_policy_read(&self, contract: &ToolContract) -> bool {
        self.owner
            .supports_policy_read(&self.frozen, &self.call, contract)
    }
    fn authorize(
        &self,
        c: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.owner.authorize(c, &self.call, contract, cancel)
    }
    fn execute(
        &self,
        c: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        self.owner.execute_receipt(c, &self.call, contract, cancel)
    }
}
