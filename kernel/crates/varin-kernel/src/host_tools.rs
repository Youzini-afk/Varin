//! Tool executor over the existing Application Host MCP authority.
//! Frames are private, epoch-bound, and name concrete retained tools, never arbitrary Host methods.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::execution::*;
use varin_runtime::{Effect, ExecutorOwner, Lifetime, Outcome};

pub(crate) use varin_runtime::catalog::launches::HostToolBinding as McpBinding;
#[derive(Clone, PartialEq)]
pub(crate) struct LiveMcpBinding {
    pub owner_id: String,
    pub binding: McpBinding,
}
#[derive(Clone, PartialEq)]
pub(crate) struct LiveExtensionBinding {
    pub owner_id: String,
    pub generation: u64,
    pub binding: varin_runtime::catalog::launches::ExtensionToolBinding,
}
struct State {
    epoch: Option<String>,
    pending: HashMap<String, Pending>,
    admissions: HashMap<(String, String), CancellationToken>,
}
struct Pending {
    reply: mpsc::Sender<Reply>,
    wake: mpsc::SyncSender<()>,
}
impl State {
    fn close_waiters(&mut self) {
        for (_, cancel) in self.admissions.drain() {
            cancel.cancel();
        }
        for (_, pending) in self.pending.drain() {
            drop(pending.reply);
            let _ = pending.wake.try_send(());
        }
    }
}
#[derive(Clone)]
pub(crate) struct ToolBridge {
    state: Arc<Mutex<State>>,
    events: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
}
impl ToolBridge {
    pub(crate) fn new(output: crate::transport::Sender) -> Self {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(State {
            epoch: None,
            pending: HashMap::new(),
            admissions: HashMap::new(),
        }));
        let failed_state = state.clone();
        std::thread::spawn(move || {
            for event in rx {
                if output.send(event).is_err() {
                    break;
                }
            }
            if let Ok(mut state) = failed_state.lock() {
                state.epoch = None;
                state.close_waiters();
            }
        });
        Self {
            state,
            events: Arc::new(Mutex::new(Some(tx))),
        }
    }
    pub(crate) fn initialize(&self, epoch: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.close_waiters();
            state.epoch = Some(epoch.into());
        }
    }
    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.epoch = None;
            state.close_waiters();
        }
        if let Ok(mut events) = self.events.lock() {
            events.take();
        }
    }
    pub(crate) fn receive(&self, value: Value) {
        if value["kind"] == "host-tool-revoked" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields, rename_all = "camelCase")]
            struct Revoked {
                v: u64,
                kind: String,
                kernel_epoch: String,
                owner_id: String,
                operation_id: String,
            }
            if let Ok(event) = serde_json::from_value::<Revoked>(value) {
                if let Ok(state) = self.state.lock() {
                    if event.v == 1
                        && event.kind == "host-tool-revoked"
                        && state.epoch.as_deref() == Some(&event.kernel_epoch)
                    {
                        if let Some(cancel) =
                            state.admissions.get(&(event.owner_id, event.operation_id))
                        {
                            cancel.cancel();
                        }
                    }
                }
            }
            return;
        }
        let Ok(reply) = serde_json::from_value::<Reply>(value) else {
            return;
        };
        if reply.v != 1
            || reply.kind != "host-tool-response"
            || reply.id.is_empty()
            || (reply.ok && reply.error.is_some())
            || (!reply.ok && (reply.error.is_none() || reply.completion.is_some()))
        {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if state.epoch.as_deref() != Some(&reply.kernel_epoch) {
                return;
            }
            if let Some(pending) = state.pending.remove(&reply.id) {
                let _ = pending.reply.send(reply);
                let _ = pending.wake.try_send(());
            }
        }
    }
    fn send(&self, value: Value) -> Result<(), ExecutionError> {
        self.events
            .lock()
            .map_err(|_| failed("host_tool_channel_failed"))?
            .as_ref()
            .ok_or_else(|| failed("host_tool_channel_closed"))?
            .send(value)
            .map_err(|_| failed("host_tool_channel_closed"))
    }
    fn call(
        &self,
        generation: &ToolGeneration,
        phase: &str,
        context: &ToolExecutionContext,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<Reply, ExecutionError> {
        let epoch = &generation.epoch;
        let holder = &generation.holder;
        let binding = &generation.binding;
        if cancel.is_cancelled() {
            return Err(failed("host_tool_cancelled_before_dispatch"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let (wake, changed) = mpsc::sync_channel(1);
        let _registration = cancel.wake_on_cancel(wake.clone());
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| failed("host_tool_channel_failed"))?;
            if state.epoch.as_deref() != Some(epoch) {
                return Err(failed("host_tool_channel_unavailable"));
            }
            state
                .pending
                .insert(id.clone(), Pending { reply: tx, wake });
        }
        let result = (|| {
            if cancel.is_cancelled() {
                return Err(failed("host_tool_cancelled_before_dispatch"));
            }
            self.send(json!({"v":1,"kind":"host-tool-request","id":id,"kernelEpoch":epoch,"phase":phase,
                "binding":{"ownerId":generation.owner_id,"reference":binding.reference(),"generation":binding.generation(),"holderId":holder},
                "call":{"runId":context.run_id,"origin":context.origin,"operationId":context.operation_id,
                    "callId":call.call_id,"name":call.name,"schemaVersion":call.schema_version,"arguments":call.arguments}}))
                .map_err(|_| failed("host_tool_not_dispatched"))?;
            let mut cancellation_sent = false;
            loop {
                match rx.try_recv() {
                    Ok(reply) => return Ok(reply),
                    Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(failed("host_tool_channel_closed"))
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                if cancel.is_cancelled() && !cancellation_sent {
                    cancellation_sent = true;
                    self.send(json!({"v":1,"kind":"host-tool-cancel","id":id,"kernelEpoch":epoch,"runId":context.run_id}))?;
                    // Cancellation is not a no-effect receipt. Host races the retained call against
                    // its abort signal and returns a real result or an explicit unknown receipt.
                }
                changed
                    .recv()
                    .map_err(|_| failed("host_tool_channel_closed"))?;
            }
        })();
        if let Ok(mut state) = self.state.lock() {
            state.pending.remove(&id);
        }
        result
    }
    /// Transfer only live retention from this request's original owners. No service is prepared here.
    pub(crate) fn retain_child(
        &self,
        context: &ToolExecutionContext,
        mcp: Option<&McpBinding>,
        extensions: &[varin_runtime::catalog::launches::ExtensionToolBinding],
        cancel: &CancellationToken,
    ) -> Result<Option<ChildHostRetention>, ExecutionError> {
        if mcp.is_none() && extensions.is_empty() {
            return Ok(None);
        }
        if cancel.is_cancelled() {
            return Err(failed("child_retention_cancelled"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let (wake, changed) = mpsc::sync_channel(1);
        let _registration = cancel.wake_on_cancel(wake.clone());
        let epoch = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| failed("host_tool_channel_failed"))?;
            let epoch = state
                .epoch
                .clone()
                .ok_or_else(|| failed("host_tool_channel_unavailable"))?;
            state
                .pending
                .insert(id.clone(), Pending { reply: tx, wake });
            epoch
        };
        let retained = ChildHostRetention {
            bridge: self.clone(),
            epoch: epoch.clone(),
            parent_run_id: context.run_id.clone(),
            operation_id: context.operation_id.clone(),
            armed: true,
        };
        let result = (|| {
            self.send(
                json!({"v":1,"kind":"host-tool-child-retain","id":id,"kernelEpoch":epoch,
                "parentRunId":context.run_id,"childOperationId":context.operation_id,
                "mcpBinding":mcp,"extensionBindings":extensions}),
            )?;
            loop {
                // This local owner acknowledgement must precede rollback: independent content
                // streams can otherwise deliver a short release before its larger retain body.
                match rx.try_recv() {
                    Ok(_) if cancel.is_cancelled() => {
                        return Err(failed("child_retention_cancelled"))
                    }
                    Ok(reply)
                        if reply.ok
                            && reply.completion.is_none()
                            && reply.executor_stopped.is_none() =>
                    {
                        return Ok(())
                    }
                    Ok(reply) => {
                        return Err(failed(
                            reply
                                .error
                                .as_ref()
                                .map(|error| error._code.as_str())
                                .unwrap_or("child_retention_rejected"),
                        ))
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(failed("host_tool_channel_closed"))
                    }
                    Err(mpsc::TryRecvError::Empty) => (),
                }
                changed
                    .recv()
                    .map_err(|_| failed("host_tool_channel_closed"))?;
            }
        })();
        if let Ok(mut state) = self.state.lock() {
            state.pending.remove(&id);
        }
        result?;
        Ok(Some(retained))
    }
    pub(crate) fn prepare_generation(
        &self,
        run_id: String,
        live: LiveMcpBinding,
    ) -> Result<Arc<ToolGeneration>, ExecutionError> {
        live.binding
            .validate()
            .map_err(|_| failed("host_tool_binding_invalid"))?;
        self.retain_generation(run_id, live.owner_id, GenerationBinding::Mcp(live.binding))
    }
    fn retain_generation(
        &self,
        run_id: String,
        owner_id: String,
        binding: GenerationBinding,
    ) -> Result<Arc<ToolGeneration>, ExecutionError> {
        if owner_id.is_empty() {
            return Err(failed("host_tool_live_owner_required"));
        }
        let epoch = self
            .state
            .lock()
            .map_err(|_| failed("host_tool_channel_failed"))?
            .epoch
            .clone()
            .ok_or_else(|| failed("host_tool_channel_unavailable"))?;
        let holder = uuid::Uuid::new_v4().to_string();
        self.send(
            json!({"v":1,"kind":"host-tool-binding-retain","kernelEpoch":epoch,
            "runId":run_id,"ownerId":owner_id,"holderId":holder}),
        )?;
        Ok(Arc::new(ToolGeneration {
            run_id,
            binding,
            bridge: self.clone(),
            epoch,
            holder,
            owner_id,
        }))
    }
    pub(crate) fn prepare_extension(
        &self,
        run_id: String,
        live: LiveExtensionBinding,
    ) -> Result<Arc<ToolGeneration>, ExecutionError> {
        live.binding
            .validate()
            .map_err(|_| failed("extension_binding_invalid"))?;
        self.retain_generation(
            run_id,
            live.owner_id,
            GenerationBinding::Extension {
                binding: live.binding,
                generation: live.generation,
            },
        )
    }
    pub(crate) fn deactivate(&self, run_id: &str) -> Result<(), ExecutionError> {
        self.deactivate_slot(run_id, "mcp")
    }
    pub(crate) fn deactivate_slot(&self, run_id: &str, slot: &str) -> Result<(), ExecutionError> {
        let epoch = self
            .state
            .lock()
            .map_err(|_| failed("host_tool_channel_failed"))?
            .epoch
            .clone()
            .ok_or_else(|| failed("host_tool_channel_unavailable"))?;
        self.send(json!({"v":1,"kind":"host-tool-binding-deactivate","kernelEpoch":epoch,"runId":run_id,"slot":slot}))
    }
}
/// The accepted ChildTask becomes the retention owner; failure before acceptance rolls back.
pub(crate) struct ChildHostRetention {
    bridge: ToolBridge,
    epoch: String,
    parent_run_id: String,
    operation_id: String,
    armed: bool,
}
impl ChildHostRetention {
    pub(crate) fn handoff(mut self) {
        self.armed = false;
    }
}
impl Drop for ChildHostRetention {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.bridge.send(
                json!({"v":1,"kind":"host-tool-child-release","kernelEpoch":self.epoch,
                "parentRunId":self.parent_run_id,"childOperationId":self.operation_id}),
            );
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reply {
    v: u64,
    kind: String,
    id: String,
    kernel_epoch: String,
    ok: bool,
    completion: Option<ToolCompletion>,
    #[serde(rename = "executor_stopped")]
    executor_stopped: Option<bool>,
    error: Option<ErrorMarker>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorMarker {
    #[serde(rename = "code")]
    _code: String,
}
fn failed(code: &str) -> ExecutionError {
    ExecutionError::new(code, code)
}
fn unknown() -> ToolCompletion {
    ToolCompletion::Result {
        outcome: Outcome::Indeterminate,
        effect: Effect::Unknown,
        content: json!({"error":"host_tool_effect_unknown"}),
    }
}
enum GenerationBinding {
    Mcp(McpBinding),
    Extension {
        binding: varin_runtime::catalog::launches::ExtensionToolBinding,
        generation: u64,
    },
}
impl GenerationBinding {
    fn reference(&self) -> &str {
        match self {
            Self::Mcp(binding) => &binding.reference,
            Self::Extension { binding, .. } => &binding.provider_key,
        }
    }
    fn generation(&self) -> u64 {
        match self {
            Self::Mcp(binding) => binding.generation,
            Self::Extension { generation, .. } => *generation,
        }
    }
    fn schemas(&self) -> &[ToolSchema] {
        match self {
            Self::Mcp(binding) => &binding.tools,
            Self::Extension { binding, .. } => std::slice::from_ref(&binding.tool),
        }
    }
    fn extension(&self) -> Option<&varin_runtime::catalog::launches::ExtensionToolBinding> {
        match self {
            Self::Mcp(_) => None,
            Self::Extension { binding, .. } => Some(binding),
        }
    }
}
pub(crate) struct ToolGeneration {
    run_id: String,
    binding: GenerationBinding,
    bridge: ToolBridge,
    epoch: String,
    holder: String,
    owner_id: String,
}
impl ToolGeneration {
    pub(crate) fn matches(&self, live: &LiveMcpBinding) -> bool {
        self.owner_id == live.owner_id
            && matches!(&self.binding, GenerationBinding::Mcp(binding) if binding == &live.binding)
    }
    pub(crate) fn matches_extension(&self, live: &LiveExtensionBinding) -> bool {
        self.owner_id == live.owner_id
            && self.binding.generation() == live.generation
            && self.binding.extension() == Some(&live.binding)
    }
    pub(crate) fn declarations(
        self: &Arc<Self>,
    ) -> Vec<varin_runtime::composition::tools::ToolDeclaration> {
        self.binding
            .schemas()
            .iter()
            .map(
                |schema| varin_runtime::composition::tools::ToolDeclaration {
                    schema: schema.clone(),
                    content_version: format!(
                        "{}:{}:{}",
                        self.binding
                            .extension()
                            .map(|b| serde_json::to_string(b).expect("binding JSON"))
                            .unwrap_or_else(|| self.binding.reference().to_string()),
                        self.binding.generation(),
                        schema.version
                    ),
                    implementation: Arc::new(HostTools {
                        generation: self.clone(),
                        schema: schema.clone(),
                    }),
                },
            )
            .collect()
    }
    pub(crate) fn activate(&self) -> Result<(), ExecutionError> {
        self.bridge.send(
            json!({"v":1,"kind":"host-tool-binding-activate","kernelEpoch":self.epoch,
            "runId":self.run_id,"ownerId":self.owner_id,"holderId":self.holder}),
        )
    }
}
impl Drop for ToolGeneration {
    fn drop(&mut self) {
        if let Ok(mut state) = self.bridge.state.lock() {
            state
                .admissions
                .retain(|(owner, _), _| owner != &self.owner_id);
        }
        // Enqueue only. Retired endpoints can outlive the Run's current directory or a resumed
        // scope, so release the actual holder in its original epoch, never the current owner.
        let _ = self.bridge.send(
            json!({"v":1,"kind":"host-tool-binding-release","kernelEpoch":self.epoch,
            "runId":self.run_id,"ownerId":self.owner_id,"holderId":self.holder}),
        );
    }
}
struct HostTools {
    generation: Arc<ToolGeneration>,
    schema: ToolSchema,
}
impl HostTools {
    fn contract(&self, call: &ToolCall) -> Result<ToolContract, ExecutionError> {
        if self.schema.name != call.name
            || self.schema.version != call.schema_version
            || (self.generation.binding.extension().is_none() && !call.arguments.is_object())
        {
            return Err(failed("host_tool_schema_changed"));
        }
        if self.generation.binding.extension().is_some() {
            // Author read/effect describes the service contract, not trusted replay or domain locks.
            // First domain adapter reads immutable material. Future effects obtain claims from their real resource owner.
            return Ok(ToolContract {
                name: call.name.clone(),
                schema_version: call.schema_version.clone(),
                read_only: false,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![],
            });
        }
        let discovery = call.name == "mcp_discover";
        let target = if call.name == "mcp_call" {
            format!(
                "server:{}",
                call.arguments
                    .get("server")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failed("mcp_target_required"))?
            )
        } else {
            call.name.clone()
        };
        let resources = if discovery {
            Vec::new()
        } else {
            let GenerationBinding::Mcp(binding) = &self.generation.binding else {
                unreachable!("extension contract returned above")
            };
            let key = binding
                .resources
                .get(&target)
                .ok_or_else(|| failed("mcp_target_unbound"))?;
            vec![ResourceClaim {
                key: key.clone(),
                access: Access::Write,
            }]
        };
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            // Selected-server discovery is a durable preparation Operation. A catalog listing
            // without a server is purely local and needs no effectful Operation.
            read_only: discovery && call.arguments.get("server").is_none(),
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources,
        })
    }
    fn validate(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> Result<(), ExecutionError> {
        if context.run_id != self.generation.run_id || &self.contract(call)? != contract {
            return Err(failed("host_tool_call_binding_changed"));
        }
        Ok(())
    }
}
impl ToolExecutor for HostTools {
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<varin_runtime::execution::ToolPreparation, ExecutionError> {
        self.prepare(call, context, cancel)
            .map(varin_runtime::execution::ToolPreparation::Ready)
    }

    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if request.run_id != self.generation.run_id || !request.tools.contains(&self.schema) {
            return Err(failed("host_tool_frozen_schema_changed"));
        }
        self.contract(call)
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.validate(context, call, contract)?;
        let reply =
            self.generation
                .bridge
                .call(&self.generation, "authorize", context, call, cancel)?;
        if !reply.ok || reply.completion.is_some() {
            return Err(failed("host_tool_authorization_failed"));
        }
        Ok(())
    }
    fn executor_owner(&self) -> ExecutorOwner {
        ExecutorOwner::External {
            identity: self.generation.binding.reference().to_string(),
            epoch: self.generation.owner_id.clone(),
        }
    }
    fn watch_admission(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError>
    {
        self.validate(context, call, contract)?;
        let key = (
            self.generation.owner_id.clone(),
            context.operation_id.clone(),
        );
        let state = self.generation.bridge.state.clone();
        state
            .lock()
            .map_err(|_| failed("host_tool_channel_failed"))?
            .admissions
            .insert(key.clone(), cancel.clone());
        let release = varin_runtime::execution_capacity::AdmissionControlGuard::new(move || {
            if let Ok(mut state) = state.lock() {
                state.admissions.remove(&key);
            }
        });
        Ok(Some(release))
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        self.execute_receipt(context, call, contract, cancel)
            .completion
    }
    fn execute_receipt(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        if self.validate(context, call, contract).is_err() || cancel.is_cancelled() {
            return ToolExecutionReceipt::not_dispatched("host_cancelled_or_binding_changed");
        }
        match self
            .generation
            .bridge
            .call(&self.generation, "execute", context, call, cancel)
        {
            Ok(reply) if reply.ok => match (reply.completion, reply.executor_stopped) {
                (
                    Some(
                        completion @ (ToolCompletion::NotDispatched { .. }
                        | ToolCompletion::Result { .. }),
                    ),
                    Some(executor_stopped),
                ) => ToolExecutionReceipt {
                    completion,
                    executor_stopped,
                },
                _ => ToolExecutionReceipt {
                    completion: unknown(),
                    executor_stopped: false,
                },
            },
            Err(error)
                if matches!(
                    error.code.as_str(),
                    "host_tool_cancelled_before_dispatch"
                        | "host_tool_channel_unavailable"
                        | "host_tool_not_dispatched"
                ) =>
            {
                ToolExecutionReceipt::not_dispatched(error.code)
            }
            _ => ToolExecutionReceipt {
                completion: unknown(),
                executor_stopped: false,
            },
        }
    }
}

/// Private authenticated parent traffic. Transport epoch is separate from original executor epoch.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LateReceipt {
    pub v: u64,
    pub kind: String,
    pub id: String,
    pub kernel_epoch: String,
    pub execution_owner: ExecutorOwner,
    pub call: crate::protocol_generated::HostToolCall,
    pub receipt: ToolExecutionReceipt,
}
impl LateReceipt {
    pub(crate) fn apply(
        self,
        catalog: &Arc<Mutex<varin_runtime::Catalog>>,
    ) -> Result<(), crate::error::KernelError> {
        use crate::agent_runtime::domain;
        use crate::error::KernelError;
        let (operation, preparation) = {
            let db = catalog
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            (
                db.operation(&self.call.operation_id).map_err(domain)?,
                db.prepare_result_content(),
            )
        };
        let intent = varin_runtime::catalog::tool_content::ToolIntent::from_operation(&operation)
            .map_err(domain)?;
        let call = ToolCall {
            call_id: self.call.call_id,
            name: self.call.name,
            schema_version: self.call.schema_version,
            arguments: self.call.arguments,
        };
        let fingerprint = varin_runtime::catalog::tool_content::ToolIntent::fingerprint(
            &self.call.origin,
            &call,
            intent.contract(),
        )
        .map_err(domain)?;
        if operation.run_id != self.call.run_id
            || intent != fingerprint
            || operation.execution_owner.as_ref() != Some(&self.execution_owner)
        {
            return Err(KernelError::Authorization(
                "original tool receipt identity changed".into(),
            ));
        }
        let ExecutorOwner::External { epoch, .. } = &self.execution_owner else {
            return Err(KernelError::Authorization("external owner required".into()));
        };
        let (outcome, effect, result) = match self.receipt.completion {
            ToolCompletion::Result {
                outcome,
                effect,
                content,
            } => (outcome, effect, content),
            ToolCompletion::NotDispatched { reason } => (
                if reason == "cancelled" {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                Effect::None,
                json!({"not_dispatched":reason}),
            ),
            ToolCompletion::JobAccepted { .. } => {
                return Err(KernelError::Protocol(
                    "this retained service does not issue Job receipts".into(),
                ))
            }
        };
        let prepared = preparation
            .write_external_receipt(varin_runtime::ExternalReceipt {
                executor: call.name,
                identity: operation.id.clone(),
                epoch: epoch.clone(),
                outcome,
                effect,
                result,
            })
            .map_err(domain)?;
        catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .record_external_tool_receipt_prepared(
                &operation.id,
                &self.execution_owner,
                prepared,
                self.receipt.executor_stopped,
            )
            .map_err(domain)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fixture() -> (ToolBridge, mpsc::Receiver<Value>) {
        let (output, frames) = mpsc::sync_channel(4);
        let bridge = ToolBridge::new(output.into());
        bridge.initialize("epoch");
        (bridge, frames)
    }
    fn start(
        bridge: ToolBridge,
        cancel: CancellationToken,
    ) -> mpsc::Receiver<Result<Reply, ExecutionError>> {
        let (done, result) = mpsc::channel();
        std::thread::spawn(move || {
            let binding = McpBinding {
                reference: "owner".into(),
                generation: 1,
                tools: vec![],
                resources: std::collections::BTreeMap::new(),
                provenance: varin_runtime::catalog::launches::McpProvenance {
                    execution_scope: varin_runtime::catalog::launches::McpExecutionScope::Global,
                    configuration: varin_runtime::catalog::launches::McpConfiguration {
                        agent_dir: "/fixture/agent".into(),
                        config_cwd: "/fixture/project".into(),
                        project_trusted: true,
                    },
                    servers: Default::default(),
                },
            };
            let context = ToolExecutionContext {
                run_id: "run".into(),
                operation_id: "op".into(),
                origin: ToolOrigin::ModelStep {
                    request_id: "request".into(),
                },
            };
            let call = ToolCall {
                call_id: "call".into(),
                name: "query".into(),
                schema_version: "1".into(),
                arguments: json!({}),
            };
            let generation = ToolGeneration {
                run_id: "run".into(),
                binding: GenerationBinding::Mcp(binding),
                bridge: bridge.clone(),
                epoch: "epoch".into(),
                holder: "holder".into(),
                owner_id: "owner-id".into(),
            };
            let _ = done.send(bridge.call(&generation, "execute", &context, &call, &cancel));
        });
        result
    }
    #[test]
    fn cancellation_wakes_the_call_but_preserves_a_real_late_effect_receipt() {
        let (bridge, frames) = fixture();
        let cancel = CancellationToken::default();
        let result = start(bridge.clone(), cancel.clone());
        let request = frames.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(request["kind"], "host-tool-request");
        cancel.cancel();
        let cancelled = frames.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(cancelled["kind"], "host-tool-cancel");
        assert_eq!(cancelled["id"], request["id"]);
        bridge.receive(json!({"v":1,"kind":"host-tool-response","id":request["id"],"kernelEpoch":"epoch","ok":true,
            "completion":{"kind":"result","outcome":"succeeded","effect":"confirmed","content":"real receipt"}}));
        let reply = result
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert!(
            matches!(reply.completion,Some(ToolCompletion::Result {outcome:Outcome::Succeeded,effect:Effect::Confirmed,content}) if content=="real receipt")
        );
        bridge.close();
    }
    #[test]
    fn closing_or_replacing_the_channel_wakes_original_waiters() {
        for replace in [false, true] {
            let (bridge, frames) = fixture();
            let result = start(bridge.clone(), CancellationToken::default());
            let request = frames.recv_timeout(Duration::from_secs(2)).unwrap();
            if replace {
                bridge.initialize("replacement");
            } else {
                bridge.close();
            }
            let error = match result.recv_timeout(Duration::from_secs(2)).unwrap() {
                Err(error) => error,
                Ok(_) => panic!("closed owner returned a reply"),
            };
            assert_eq!(error.code, "host_tool_channel_closed");
            bridge.receive(json!({"v":1,"kind":"host-tool-response","id":request["id"],"kernelEpoch":"epoch","ok":true}));
            bridge.close();
        }
    }
    #[test]
    fn child_retention_requires_ack_and_rolls_back_failure_or_cancel_without_tool_execution() {
        for outcome in [
            "accepted",
            "admission_failed",
            "rejected",
            "cancelled",
            "channel_reset",
        ] {
            let (bridge, frames) = fixture();
            let schema = ToolSchema {
                name: "helper".into(),
                version: "declaration".into(),
                description: "Original helper".into(),
                schema: json!({"type":"object"}),
                output_schema: None,
                metadata: Some(ToolMetadata {
                    service_id: "helper.service".into(),
                    service_version: 1,
                    completion: RegisteredToolCompletion::Result,
                    operation: ToolOperation::Read,
                    examples: None,
                    source: None,
                }),
            };
            let original = varin_runtime::catalog::launches::ExtensionToolBinding {
                provider_key: "original-provider".into(),
                extension_id: "extension".into(),
                extension_version: "1".into(),
                service_id: "helper.service".into(),
                service_version: 1,
                artifact_integrity: "original-artifact".into(),
                declaration_hash: "declaration".into(),
                configuration_identity: None,
                tool: schema,
            };
            let context = ToolExecutionContext {
                run_id: "original-parent".into(),
                operation_id: "request:tool:dispatch".into(),
                origin: ToolOrigin::ModelStep {
                    request_id: "request".into(),
                },
            };
            let cancel = CancellationToken::default();
            let worker_cancel = cancel.clone();
            let worker_bridge = bridge.clone();
            let (done, result) = mpsc::channel();
            std::thread::spawn(move || {
                let retained =
                    worker_bridge.retain_child(&context, None, &[original], &worker_cancel);
                let ok = retained.is_ok();
                if outcome == "accepted" {
                    retained.unwrap().unwrap().handoff();
                }
                done.send(ok).unwrap();
            });
            let request = frames
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            assert_eq!(request["kind"], "host-tool-child-retain");
            assert_eq!(request["parentRunId"], "original-parent");
            assert_eq!(request["childOperationId"], "request:tool:dispatch");
            assert!(request["mcpBinding"].is_null());
            assert_eq!(request["extensionBindings"].as_array().unwrap().len(), 1);
            assert!(
                matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)),
                "acceptance cannot precede original owner acknowledgement"
            );
            match outcome {
                "cancelled" => {
                    cancel.cancel();
                    assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
                    assert!(matches!(frames.try_recv(), Err(mpsc::TryRecvError::Empty)));
                    bridge.receive(json!({"v":1,"kind":"host-tool-response","id":request["id"],"kernelEpoch":"epoch","ok":true}));
                },
                "channel_reset" => bridge.initialize("replacement-epoch"),
                "rejected" => bridge.receive(json!({"v":1,"kind":"host-tool-response","id":request["id"],"kernelEpoch":"epoch","ok":false,"error":{"code":"original_owner_missing"}})),
                _ => bridge.receive(json!({"v":1,"kind":"host-tool-response","id":request["id"],"kernelEpoch":"epoch","ok":true})),
            }
            assert_eq!(
                result
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap(),
                matches!(outcome, "accepted" | "admission_failed")
            );
            if outcome == "accepted" {
                assert!(matches!(frames.try_recv(), Err(mpsc::TryRecvError::Empty)));
            } else {
                let release = frames
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                assert_eq!(
                    release,
                    json!({"v":1,"kind":"host-tool-child-release","kernelEpoch":"epoch","parentRunId":"original-parent","childOperationId":"request:tool:dispatch"})
                );
            }
            bridge.close();
        }
        let (bridge, _) = fixture();
        bridge.close();
        let context = ToolExecutionContext {
            run_id: "native-parent".into(),
            operation_id: "native-child".into(),
            origin: ToolOrigin::ModelStep {
                request_id: "native".into(),
            },
        };
        assert!(
            bridge
                .retain_child(&context, None, &[], &CancellationToken::default())
                .unwrap()
                .is_none(),
            "native dispatch needs no Host channel"
        );
    }
}
