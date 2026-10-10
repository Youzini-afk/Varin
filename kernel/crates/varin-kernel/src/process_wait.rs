//! Durable observation of one process from the same Run, including legal launch rebinds.
use crate::tools::{KernelResourceClient, ToolBinding, ToolKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::process_wait::WAIT_TOOL;
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};

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
}
fn interacts(name: &str) -> bool {
    matches!(name, "process_write" | "process_resize")
}
fn observes(name: &str) -> bool {
    matches!(name, "process_inspect" | "process_read")
}
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("process_wait", value.to_string())
}
pub(crate) fn schemas(mut tools: Vec<ToolSchema>) -> Vec<ToolSchema> {
    tools.retain(|tool| tool.name != WAIT_TOOL);
    if tools.iter().any(|tool| tool.name == "process_inspect") {
        tools.push(ToolSchema { description: "Wait durably for a process started by this Run. Use the processId from process_spawn. This parks model execution until an observed terminal fact; cancelling this observation does not stop the process. Read output separately with process_read.".into(), output_schema: None, metadata: None, name: WAIT_TOOL.into(), version: "1".into(), schema: json!({"type":"object",
            "properties":{"processId":{"type":"string","minLength":1}}, "required":["processId"], "additionalProperties":false
        }) });
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
            schema.name == WAIT_TOOL || observes(&schema.name) || interacts(&schema.name)
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
                .contains(&ToolKind::ProcessInspect)
        {
            return Err(error(
                "process wait requires the bound Run and process observation capability",
            ));
        }
        let handle: Handle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if handle.process_id.is_empty() {
            return Err(error("processId required"));
        }
        self.check_owner(context, &handle.process_id)?;
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
                name: WAIT_TOOL.into(),
                schema_version: "1".into(),
                read_only: true,
                completion: CompletionKind::Job,
                lifetime: Lifetime::Thread,
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
            (
                args.process_id,
                crate::process::interaction::Input::Write {
                    bytes: args.text.into_bytes().into(),
                    eof: args.eof,
                },
                ToolKind::ProcessWrite,
            )
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
        if process.cancel_requested {
            return Err(error("original process cancellation was requested"));
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
            content: serde_json::to_value(receipt).map_err(|failure| {
                ExecutionError::new("process_effect_unknown", failure.to_string())
            })?,
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
        let (id, read) = if call.name == "process_read" {
            let h: ReadHandle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            (h.process_id, Some((h.cursor, h.max_bytes)))
        } else {
            let h: Handle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            (h.process_id, None)
        };
        let source_run_id = self.check_owner(c, &id)?;
        self.resources.observe_process(
            &self.binding,
            c,
            &id,
            &source_run_id,
            read,
            authorize_only,
            cancel,
        )
    }
}
impl ToolExecutor for ProcessWaitTools {
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
        .find(|tool| tool.name == WAIT_TOOL)
        .ok_or_else(|| error("process wait is not selected"))?;
        if call.schema_version != "1" || !frozen.tools.contains(&schema) {
            return Err(error("process wait schema is not frozen"));
        }
        let handle: Handle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if handle.process_id.is_empty() {
            return Err(error("processId required"));
        }
        Ok(ToolContract {
            name: WAIT_TOOL.into(),
            schema_version: "1".into(),
            read_only: true,
            completion: CompletionKind::Job,
            lifetime: Lifetime::Thread,
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
        self.resources
            .authorize_process_observation(&self.binding, c, &id, cancel)
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
                            content: json!({"error":error.code,"message":error.message}),
                        }
                    } else {
                        ToolCompletion::NotDispatched {
                            reason: error.to_string(),
                        }
                    }
                });
        }
        if observes(&call.name) {
            if let Err(e) = self.validate_contract(c, call, contract) {
                return ToolCompletion::NotDispatched {
                    reason: e.to_string(),
                };
            }
            return match self.observe(c, call, false, cancel) {
                Ok(content) => ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    effect: Effect::None,
                    content,
                },
                Err(e) => ToolCompletion::Result {
                    outcome: Outcome::Failed,
                    effect: Effect::None,
                    content: json!({"error":e.code,"message":e.message}),
                },
            };
        }
        let result = (|| -> Result<ToolCompletion, ExecutionError> {
            self.authorize(c, call, contract, cancel)?;
            let id = self.handle(c, call)?;
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
            })
        })();
        result.unwrap_or_else(|e| ToolCompletion::Result {
            outcome: Outcome::Failed,
            effect: Effect::None,
            content: json!({"error":e.code,"message":e.message}),
        })
    }
}
