//! Durable observation of one process from the same native Run, including legal launch rebinds.
use crate::native_tools::{NativeResourceClient, NativeToolBinding, NativeToolKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::process_wait::WAIT_TOOL;
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
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
fn observes(name: &str) -> bool {
    matches!(name, "native_process_inspect" | "native_process_read")
}
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("process_wait", value.to_string())
}
pub(crate) fn schemas(mut tools: Vec<ToolSchema>) -> Vec<ToolSchema> {
    tools.retain(|tool| tool.name != WAIT_TOOL);
    if tools
        .iter()
        .any(|tool| tool.name == "native_process_inspect")
    {
        tools.push(ToolSchema { name: WAIT_TOOL.into(), version: "1".into(), schema: json!({
            "type":"object", "description":"Wait durably for a process started by this Run. Use the processId from native_process_spawn. This parks model execution until an observed terminal fact; cancelling this observation does not stop the process. Read output separately with native_process_read.",
            "properties":{"processId":{"type":"string","minLength":1}}, "required":["processId"], "additionalProperties":false
        }) });
    }
    tools
}
pub(crate) fn policy_identity(inner: PolicyIdentity) -> PolicyIdentity {
    PolicyIdentity {
        name: format!("{}+process-wait", inner.name),
        version: format!("{}+1", inner.version),
    }
}
pub(crate) fn default_policy_identity() -> PolicyIdentity {
    policy_identity(crate::native_collaboration::default_policy_identity())
}
pub(crate) fn configure(mut start: RunStart, catalog: Arc<Mutex<Catalog>>) -> RunStart {
    start.policy = Arc::new(ProcessWaitPolicy {
        inner: start.policy,
        catalog,
    });
    start
}
pub(crate) fn wrap_tools(
    inner: Arc<dyn ToolExecutor>,
    catalog: Arc<Mutex<Catalog>>,
    binding: NativeToolBinding,
    resources: NativeResourceClient,
) -> Arc<dyn ToolExecutor> {
    Arc::new(ProcessWaitTools {
        inner,
        catalog,
        binding,
        resources,
    })
}
struct ProcessWaitTools {
    inner: Arc<dyn ToolExecutor>,
    catalog: Arc<Mutex<Catalog>>,
    binding: NativeToolBinding,
    resources: NativeResourceClient,
}
impl ProcessWaitTools {
    fn handle(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
    ) -> Result<String, ExecutionError> {
        if context.run_id != self.binding.run_id
            || !matches!(context.origin, ToolOrigin::ModelStep { .. })
            || !self
                .binding
                .enabled_tools
                .contains(&NativeToolKind::ProcessInspect)
        {
            return Err(error("process wait requires the bound Run's model origin and process observation capability"));
        }
        let handle: Handle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if handle.process_id.is_empty() {
            return Err(error("processId required"));
        }
        self.check_owner(context, &handle.process_id)?;
        Ok(handle.process_id)
    }
    fn check_owner(&self, c: &ToolExecutionContext, id: &str) -> Result<(), ExecutionError> {
        let db = self.catalog.lock().map_err(error)?;
        db.require_process_observation(&c.run_id, id)
            .map_err(error)?;
        let launch = db
            .launch_intent(&c.run_id)
            .map_err(error)?
            .ok_or_else(|| error("process observation requires saved launch"))?;
        if launch.selection.source.as_ref()
            != Some(&self.binding.source_selection().map_err(error)?)
        {
            return Err(error("process observation source changed"));
        }
        Ok(())
    }
    fn validate_contract(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> Result<(), ExecutionError> {
        let expected = if observes(&call.name) {
            crate::native_tools::NativeToolExecutor::new(
                self.binding.clone(),
                self.resources.clone(),
            )?
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
    fn observe(
        &self,
        c: &ToolExecutionContext,
        call: &ToolCall,
        authorize_only: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ExecutionError> {
        let kind = if call.name == "native_process_read" {
            NativeToolKind::ProcessRead
        } else {
            NativeToolKind::ProcessInspect
        };
        if !self.binding.enabled_tools.contains(&kind) {
            return Err(error("process observation tool is not selected"));
        }
        let (id, read) = if call.name == "native_process_read" {
            let h: ReadHandle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            (h.process_id, Some((h.cursor, h.max_bytes)))
        } else {
            let h: Handle = serde_json::from_value(call.arguments.clone()).map_err(error)?;
            (h.process_id, None)
        };
        self.check_owner(c, &id)?;
        self.resources
            .observe_process(&self.binding, c, &id, read, authorize_only, cancel)
    }
}
impl ToolExecutor for ProcessWaitTools {
    fn supports_policy_read(
        &self,
        c: &FrozenToolContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> bool {
        call.name != WAIT_TOOL && self.inner.supports_policy_read(c, call, contract)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
    ) -> Result<ToolContract, ExecutionError> {
        if call.name != WAIT_TOOL {
            return self.inner.prepare(call, frozen);
        }
        let schema = schemas(crate::native_tools::NativeToolExecutor::selected_schemas(
            &self.binding.enabled_tools,
        ))
        .into_iter()
        .find(|tool| tool.name == WAIT_TOOL)
        .ok_or_else(|| error("process wait is not selected"))?;
        if call.schema_version != "1"
            || !frozen.tools.contains(&schema)
            || !matches!(frozen.origin, ToolOrigin::ModelStep { .. })
        {
            return Err(error("process wait schema/origin is not frozen"));
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
        if observes(&call.name) {
            self.validate_contract(c, call, contract)?;
            return self.observe(c, call, true, cancel).map(|_| ());
        }
        if call.name != WAIT_TOOL {
            return self.inner.authorize(c, call, contract, cancel);
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
        if call.name != WAIT_TOOL {
            return self.inner.execute(c, call, contract, cancel);
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
struct ProcessWaitPolicy {
    inner: Arc<dyn AgentPolicy>,
    catalog: Arc<Mutex<Catalog>>,
}
impl AgentPolicy for ProcessWaitPolicy {
    fn identity(&self) -> PolicyIdentity {
        policy_identity(self.inner.identity())
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let decision = self.inner.decide(view, event, state, cancel)?;
        if !matches!(
            decision.action,
            PolicyAction::Fail { .. } | PolicyAction::Wait { .. }
        ) && view.pending_tool_calls == 0
        {
            if let Some(wait_id) = self
                .catalog
                .lock()
                .map_err(error)?
                .pending_process_wait(view.run_id)
                .map_err(error)?
            {
                return Ok(PolicyDecision {
                    action: PolicyAction::Wait { wait_id },
                    state: decision.state,
                });
            }
        }
        Ok(decision)
    }
}
