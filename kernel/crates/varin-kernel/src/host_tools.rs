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
    source_cleanup: Arc<Mutex<Option<crate::tools::KernelResourceClient>>>,
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
            source_cleanup: Arc::new(Mutex::new(None)),
        }
    }
    pub(crate) fn set_source_cleanup(&self, resources: crate::tools::KernelResourceClient) {
        if let Ok(mut owner) = self.source_cleanup.lock() { *owner = Some(resources); }
    }
    pub(crate) fn initialize(&self, epoch: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.close_waiters();
            state.epoch = Some(epoch.into());
        }
    }
    pub(crate) fn close(&self) {
        if let Ok(mut owner) = self.source_cleanup.lock() { owner.take(); }
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
                        return Err(failed("host_tool_channel_closed"));
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
                        return Err(failed("child_retention_cancelled"));
                    }
                    Ok(reply)
                        if reply.ok
                            && reply.completion.is_none()
                            && reply.executor_stopped.is_none() =>
                    {
                        return Ok(());
                    }
                    Ok(reply) => {
                        return Err(failed(
                            reply
                                .error
                                .as_ref()
                                .map(|error| error.code.as_str())
                                .unwrap_or("child_retention_rejected"),
                        ));
                    }
                    Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(failed("host_tool_channel_closed"));
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
    completion: Option<ToolCompletion<varin_runtime::output::IncomingMedia>>,
    #[serde(rename = "executor_stopped")]
    executor_stopped: Option<bool>,
    error: Option<crate::protocol_generated::HostToolErrorMarker>,
}
fn failed(code: &str) -> ExecutionError {
    ExecutionError::new(code, code)
}
fn unknown() -> ToolCompletion {
    ToolCompletion::Result {
        outcome: Outcome::Indeterminate,
        effect: Effect::Unknown,
        content: json!({"error":"host_tool_effect_unknown"}).into(),
    }
}
/// Validate producer media independently of the receipt's already established effect facts.
/// A rejected media payload never enters storage; its original ordered position gets an
/// explicit diagnostic. Job admission remains byte-for-byte domain-owned and cannot be repaired.
fn admit_host_completion(
    completion: ToolCompletion<varin_runtime::output::IncomingMedia>,
    context: &ToolExecutionContext,
) -> Result<ToolCompletion, varin_runtime::RuntimeError> {
    use varin_runtime::output::{OutputBody, OutputPart, OutputSource};
    let source = OutputSource::Tool {
        context: context.clone(),
    };
    Ok(match completion {
        ToolCompletion::Result {
            outcome,
            effect,
            content,
        } => {
            let parts=content.parts.into_iter().enumerate().map(|(index,part)|match part {
                OutputPart::Text{text}=>OutputPart::Text{text},
                OutputPart::Media{media}=>match media.admit(source.clone()) {
                    Ok(media)=>OutputPart::Media{media},
                    Err(error)=>OutputPart::Text{text:format!("[output_media_rejected] Output part {index} was not admitted: {error}. Supply a valid MIME type and non-empty canonical base64 bytes. The original outcome and effect are unchanged.")},
                },
            }).collect();
            ToolCompletion::Result {
                outcome,
                effect,
                content: OutputBody {
                    data: content.data,
                    parts,
                },
            }
        }
        other => other.map_media(|media| media.admit(source.clone()))?,
    })
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
                completion: match self.schema.metadata.as_ref().map(|m| &m.completion) {
                    Some(RegisteredToolCompletion::Job) => CompletionKind::Job,
                    _ => CompletionKind::Result,
                },
                lifetime: match self.schema.metadata.as_ref() {
                    Some(metadata) if metadata.completion == RegisteredToolCompletion::Job => {
                        metadata
                            .lifetime
                            .filter(|l| matches!(l, Lifetime::Thread | Lifetime::Environment))
                            .ok_or_else(|| failed("host_job_lifetime_required"))?
                    }
                    _ => Lifetime::Run,
                },
                resources: vec![],
            });
        }
        let GenerationBinding::Mcp(binding) = &self.generation.binding else {
            unreachable!("extension contract returned above")
        };
        let route = binding
            .routes
            .get(&call.name)
            .ok_or_else(|| failed("mcp_route_unbound"))?;
        let (target, discovery, local) = match route {
            varin_runtime::McpRoute::Direct | varin_runtime::McpRoute::DirectTask => {
                (Some(call.name.clone()), false, false)
            }
            varin_runtime::McpRoute::ServerArgument { argument }
            | varin_runtime::McpRoute::ServerTaskArgument { argument }
            | varin_runtime::McpRoute::ResourceSubscribe { argument } => {
                let server = call
                    .arguments
                    .get(argument)
                    .and_then(Value::as_str)
                    .ok_or_else(|| failed("mcp_target_required"))?;
                (Some(format!("server:{server}")), false, false)
            }
            varin_runtime::McpRoute::TaskControl { argument, .. }
            | varin_runtime::McpRoute::ResourceUnsubscribe { argument } => {
                if call
                    .arguments
                    .get(argument)
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                {
                    return Err(failed("mcp_task_operation_required"));
                }
                // Management may reopen the original remote owner and issue tasks/get. Keep its
                // ordinary Result durable for the existing permission rendezvous, with no claim.
                (None, false, true)
            }
            varin_runtime::McpRoute::Discovery { argument } => {
                if let Some(server) = call.arguments.get(argument) {
                    let server = server
                        .as_str()
                        .ok_or_else(|| failed("mcp_target_required"))?;
                    if !binding.resources.contains_key(&format!("server:{server}")) {
                        return Err(failed("mcp_target_unbound"));
                    }
                    (None, true, false)
                } else {
                    (None, true, true)
                }
            }
        };
        let resources = match target {
            None => Vec::new(),
            Some(target) => vec![ResourceClaim {
                key: binding
                    .resources
                    .get(&target)
                    .ok_or_else(|| failed("mcp_target_unbound"))?
                    .clone(),
                access: Access::Write,
            }],
        };
        let job = matches!(
            route,
            varin_runtime::McpRoute::DirectTask
                | varin_runtime::McpRoute::ServerTaskArgument { .. }
                | varin_runtime::McpRoute::TaskControl {
                    action: varin_runtime::McpTaskAction::Wait,
                    ..
                }
        );
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            // Selected-server discovery is a durable preparation Operation. A catalog listing
            // without a server is purely local and needs no effectful Operation.
            read_only: discovery && local,
            completion: if job {
                CompletionKind::Job
            } else {
                CompletionKind::Result
            },
            lifetime: if job || matches!(route, varin_runtime::McpRoute::ResourceSubscribe { .. }) {
                Lifetime::Thread
            } else {
                Lifetime::Run
            },
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
    fn receipt_persisted(&self, context: &ToolExecutionContext, call: &ToolCall) {
        if self.generation.binding.extension().is_none() || call.name != "extension_package" {
            return;
        }
        let resources = self.generation.bridge.source_cleanup.lock().ok().and_then(|owner| owner.clone());
        if let Some(resources) = resources {
            resources.schedule_package_source_release(context.operation_id.clone());
        }
    }
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
            if let Some(error) = reply.error.filter(|error| {
                error.admission == Some(true)
                    && error
                        .code
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_lowercase)
                    && error.code.bytes().all(|value| {
                        value.is_ascii_lowercase()
                            || value.is_ascii_digit()
                            || matches!(value, b'_' | b'-')
                    })
            }) {
                return Err(failed(&error.code));
            }
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
                        | ToolCompletion::Result { .. }
                        | ToolCompletion::JobAccepted { .. }),
                    ),
                    Some(executor_stopped),
                ) => ToolExecutionReceipt {
                    completion: admit_host_completion(completion, context)
                        .unwrap_or_else(|_| unknown()),
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
    pub receipt: ToolExecutionReceipt<varin_runtime::output::IncomingMedia>,
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
        let context = ToolExecutionContext {
            run_id: operation.run_id.clone(),
            operation_id: operation.id.clone(),
            origin: self.call.origin.clone(),
        };
        let completion =
            admit_host_completion(self.receipt.completion, &context).map_err(domain)?;
        let (outcome, effect, result) = match completion {
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
                json!({"not_dispatched":reason}).into(),
            ),
            completion @ ToolCompletion::JobAccepted { .. } => {
                let saved = catalog
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                    .capture_job_acceptance(&operation.id)
                    .map_err(domain)?;
                if self.receipt.executor_stopped || saved.load().map_err(domain)? != completion {
                    return Err(KernelError::Authorization(
                        "Job acceptance differs from its canonical domain acceptance".into(),
                    ));
                }
                return Ok(());
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
                routes: std::collections::BTreeMap::new(),
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
            "completion":{"kind":"result","outcome":"succeeded","effect":"confirmed","content":{"data":"real receipt","parts":[]}}}));
        let reply = result
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert!(
            matches!(reply.completion,Some(ToolCompletion::Result {outcome:Outcome::Succeeded,effect:Effect::Confirmed,content}) if content.data=="real receipt" && content.parts.is_empty())
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
                requirements: None,
                name: "helper".into(),
                version: "declaration".into(),
                description: "Original helper".into(),
                schema: json!({"type":"object"}),
                output_schema: None,
                metadata: Some(ToolMetadata {
                    lifetime: None,
                    service_id: "helper.service".into(),
                    service_version: 1,
                    completion: RegisteredToolCompletion::Result,
                    operation: ToolOperation::Read,
                    examples: None,
                    source: None,
                }),
            };
            let original = varin_runtime::catalog::launches::ExtensionToolBinding {
                provider_key: "extension:host:helper.service@1".into(),
                extension_id: "extension".into(),
                extension_version: "1".into(),
                service_id: "helper.service".into(),
                service_version: 1,
                artifact_integrity: "original-artifact".into(),
                composition: crate::service_composition_fixture::graph(
                    "extension",
                    "1",
                    "original-artifact",
                ),
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
    #[test]
    fn actual_host_response_rejects_only_bad_media_without_erasing_confirmed_receipt() {
        use varin_runtime::output::{IncomingMedia, OutputBody, OutputPart};
        let (bridge, frames) = fixture();
        let context = ToolExecutionContext {
            run_id: "media-run".into(),
            operation_id: "request:tool:media".into(),
            origin: ToolOrigin::ModelStep {
                request_id: "request".into(),
            },
        };
        let call = ToolCall {
            call_id: "media".into(),
            name: "query".into(),
            schema_version: "1".into(),
            arguments: json!({}),
        };
        let schema = ToolSchema {
            requirements: None,
            name: "query".into(),
            version: "1".into(),
            description: String::new(),
            schema: json!({"type":"object"}),
            output_schema: None,
            metadata: None,
        };
        let binding = McpBinding {
            reference: "owner".into(),
            generation: 1,
            tools: vec![schema.clone()],
            resources: [("query".into(), "bound-resource".into())].into(),
            routes: [("query".into(), varin_runtime::McpRoute::Direct)].into(),
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
        let executor = HostTools {
            schema,
            generation: Arc::new(ToolGeneration {
                run_id: context.run_id.clone(),
                binding: GenerationBinding::Mcp(binding),
                bridge: bridge.clone(),
                epoch: "epoch".into(),
                holder: "holder".into(),
                owner_id: "owner-id".into(),
            }),
        };
        let original = ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            content: OutputBody {
                data: json!({"receipt":"original confirmed effect","opaque":{"image":"ordinary JSON"}}),
                parts: vec![
                    OutputPart::Text {
                        text: "before".into(),
                    },
                    OutputPart::Media {
                        media: IncomingMedia {
                            media_type: "image/png".into(),
                            data_base64: "bad-payload-never-echo".into(),
                        },
                    },
                    OutputPart::Media {
                        media: IncomingMedia {
                            media_type: "image/png".into(),
                            data_base64: "aW1hZ2U=".into(),
                        },
                    },
                    OutputPart::Text {
                        text: "after".into(),
                    },
                ],
            },
        };
        let expected = admit_host_completion(original.clone(), &context).unwrap();
        let contract = executor.contract(&call).unwrap();
        let (send, done) = mpsc::channel();
        std::thread::spawn(move || {
            send.send(executor.execute_receipt(
                &context,
                &call,
                &contract,
                &CancellationToken::default(),
            ))
            .unwrap();
        });
        let request = frames.recv_timeout(Duration::from_secs(2)).unwrap();
        bridge.receive(json!({"v":1,"kind":"host-tool-response","id":request["id"],"kernelEpoch":"epoch","ok":true,"completion":original,"executor_stopped":true}));
        let receipt = done.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(receipt.executor_stopped);
        assert_eq!(receipt.completion, expected);
        let ToolCompletion::Result {
            outcome,
            effect,
            content,
        } = receipt.completion
        else {
            panic!("original Result")
        };
        assert_eq!((outcome, effect), (Outcome::Succeeded, Effect::Confirmed));
        assert_eq!(content.data["receipt"], "original confirmed effect");
        assert_eq!(content.parts.len(), 4);
        let OutputPart::Text { text } = &content.parts[1] else {
            panic!("explicit rejected-media diagnostic")
        };
        assert!(text.contains("output_media_rejected") && text.contains("part 1"));
        assert!(!text.contains("bad-payload-never-echo"));
        assert!(
            matches!(&content.parts[2],OutputPart::Media{media} if media.data_base64=="aW1hZ2U=")
        );
        bridge.close();
    }
}
