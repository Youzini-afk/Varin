//! Tool executor over the existing Application Host MCP authority.
//! Frames are private, epoch-bound, and name concrete retained tools, never arbitrary Host methods.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::execution::*;
use varin_runtime::{Effect, Lifetime, Outcome};

pub(crate) use varin_runtime::catalog::launches::HostToolBinding as McpBinding;
#[derive(Clone, PartialEq)]
pub(crate) struct LiveMcpBinding {
    pub owner_id: String,
    pub binding: McpBinding,
}
struct State {
    epoch: Option<String>,
    pending: HashMap<String, Pending>,
}
struct Pending {
    reply: mpsc::Sender<Reply>,
    wake: mpsc::SyncSender<()>,
}
impl State {
    fn close_waiters(&mut self) {
        for (_, pending) in self.pending.drain() {
            drop(pending.reply);
            let _ = pending.wake.try_send(());
        }
    }
}
#[derive(Clone)]
pub(crate) struct McpBridge {
    state: Arc<Mutex<State>>,
    events: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
}
impl McpBridge {
    pub(crate) fn new(output: crate::transport::Sender) -> Self {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(State {
            epoch: None,
            pending: HashMap::new(),
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
        let Ok(reply) = serde_json::from_value::<Reply>(value) else {
            return;
        };
        if reply.v != 1
            || reply.kind != "mcp-tool-response"
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
            .map_err(|_| failed("mcp_channel_failed"))?
            .as_ref()
            .ok_or_else(|| failed("mcp_channel_closed"))?
            .send(value)
            .map_err(|_| failed("mcp_channel_closed"))
    }
    fn call(
        &self,
        generation: &McpGeneration,
        phase: &str,
        context: &ToolExecutionContext,
        call: &ToolCall,
        cancel: &CancellationToken,
    ) -> Result<Reply, ExecutionError> {
        let epoch = &generation.epoch;
        let holder = &generation.holder;
        let binding = &generation.binding;
        if cancel.is_cancelled() {
            return Err(failed("mcp_cancelled_before_dispatch"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let (wake, changed) = mpsc::sync_channel(1);
        let _registration = cancel.wake_on_cancel(wake.clone());
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| failed("mcp_channel_failed"))?;
            if state.epoch.as_deref() != Some(epoch) {
                return Err(failed("mcp_channel_unavailable"));
            }
            state
                .pending
                .insert(id.clone(), Pending { reply: tx, wake });
        }
        let result = (|| {
            if cancel.is_cancelled() {
                return Err(failed("mcp_cancelled_before_dispatch"));
            }
            self.send(json!({"v":1,"kind":"mcp-tool-request","id":id,"kernelEpoch":epoch,"phase":phase,
                "binding":{"ownerId":generation.owner_id,"reference":binding.reference,"generation":binding.generation,"holderId":holder},
                "call":{"runId":context.run_id,"requestId":match &context.origin { ToolOrigin::ModelStep { request_id } => request_id, _ => return Err(failed("mcp_policy_action_forbidden")) },"operationId":context.operation_id,
                    "callId":call.call_id,"name":call.name,"schemaVersion":call.schema_version,"arguments":call.arguments}}))
                .map_err(|_| failed("mcp_not_dispatched"))?;
            let mut cancellation_sent = false;
            loop {
                match rx.try_recv() {
                    Ok(reply) => return Ok(reply),
                    Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(failed("mcp_channel_closed"))
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                if cancel.is_cancelled() && !cancellation_sent {
                    cancellation_sent = true;
                    self.send(json!({"v":1,"kind":"mcp-tool-cancel","id":id,"kernelEpoch":epoch,"runId":context.run_id}))?;
                    // Cancellation is not a no-effect receipt. Host races the retained call against
                    // its abort signal and returns a real result or an explicit unknown receipt.
                }
                changed.recv().map_err(|_| failed("mcp_channel_closed"))?;
            }
        })();
        if let Ok(mut state) = self.state.lock() {
            state.pending.remove(&id);
        }
        result
    }
    pub(crate) fn prepare_generation(
        &self,
        run_id: String,
        live: LiveMcpBinding,
    ) -> Result<Arc<McpGeneration>, ExecutionError> {
        if live.owner_id.is_empty() {
            return Err(failed("mcp_live_owner_required"));
        }
        let binding = live.binding;
        binding
            .validate()
            .map_err(|_| failed("mcp_binding_invalid"))?;
        let epoch = self
            .state
            .lock()
            .map_err(|_| failed("mcp_channel_failed"))?
            .epoch
            .clone()
            .ok_or_else(|| failed("mcp_channel_unavailable"))?;
        let holder = uuid::Uuid::new_v4().to_string();
        self.send(
            json!({"v":1,"kind":"mcp-binding-retain","kernelEpoch":epoch,
            "runId":run_id,"ownerId":live.owner_id,"holderId":holder}),
        )?;
        Ok(Arc::new(McpGeneration {
            run_id,
            binding,
            bridge: self.clone(),
            epoch,
            holder,
            owner_id: live.owner_id,
        }))
    }
    pub(crate) fn deactivate(&self, run_id: &str) -> Result<(), ExecutionError> {
        let epoch = self
            .state
            .lock()
            .map_err(|_| failed("mcp_channel_failed"))?
            .epoch
            .clone()
            .ok_or_else(|| failed("mcp_channel_unavailable"))?;
        self.send(json!({"v":1,"kind":"mcp-binding-deactivate","kernelEpoch":epoch,"runId":run_id}))
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
        content: json!({"error":"mcp_effect_unknown"}),
    }
}
pub(crate) struct McpGeneration {
    run_id: String,
    binding: McpBinding,
    bridge: McpBridge,
    epoch: String,
    holder: String,
    owner_id: String,
}
impl McpGeneration {
    pub(crate) fn matches(&self, live: &LiveMcpBinding) -> bool {
        self.owner_id == live.owner_id && self.binding == live.binding
    }
    pub(crate) fn declarations(
        self: &Arc<Self>,
    ) -> Vec<varin_runtime::composition::tools::ToolDeclaration> {
        self.binding
            .tools
            .iter()
            .map(
                |schema| varin_runtime::composition::tools::ToolDeclaration {
                    schema: schema.clone(),
                    content_version: format!(
                        "{}:{}:{}",
                        self.binding.reference, self.binding.generation, schema.version
                    ),
                    implementation: Arc::new(McpTools {
                        generation: self.clone(),
                        schema: schema.clone(),
                    }),
                },
            )
            .collect()
    }
    pub(crate) fn activate(&self) -> Result<(), ExecutionError> {
        self.bridge.send(
            json!({"v":1,"kind":"mcp-binding-activate","kernelEpoch":self.epoch,
            "runId":self.run_id,"ownerId":self.owner_id,"holderId":self.holder}),
        )
    }
}
impl Drop for McpGeneration {
    fn drop(&mut self) {
        // Enqueue only. Retired endpoints can outlive the Run's current directory or a resumed
        // scope, so release the actual holder in its original epoch, never the current owner.
        let _ = self.bridge.send(
            json!({"v":1,"kind":"mcp-binding-release","kernelEpoch":self.epoch,
            "runId":self.run_id,"ownerId":self.owner_id,"holderId":self.holder}),
        );
    }
}
struct McpTools {
    generation: Arc<McpGeneration>,
    schema: ToolSchema,
}
impl McpTools {
    fn contract(&self, call: &ToolCall) -> Result<ToolContract, ExecutionError> {
        if self.schema.name != call.name
            || self.schema.version != call.schema_version
            || !call.arguments.is_object()
        {
            return Err(failed("mcp_schema_changed"));
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
            let key = self
                .generation
                .binding
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
            return Err(failed("mcp_call_binding_changed"));
        }
        Ok(())
    }
}
impl ToolExecutor for McpTools {
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
            return Err(failed("mcp_frozen_schema_changed"));
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
            return Err(failed("mcp_authorization_failed"));
        }
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        if self.validate(context, call, contract).is_err() || cancel.is_cancelled() {
            return ToolCompletion::NotDispatched {
                reason: "mcp_cancelled_or_binding_changed".into(),
            };
        }
        match self
            .generation
            .bridge
            .call(&self.generation, "execute", context, call, cancel)
        {
            Ok(reply) if reply.ok => match reply.completion {
                Some(completion @ ToolCompletion::NotDispatched { .. }) => completion,
                Some(completion @ ToolCompletion::Result { .. }) => completion,
                _ => unknown(),
            },
            Err(error)
                if matches!(
                    error.code.as_str(),
                    "mcp_cancelled_before_dispatch"
                        | "mcp_channel_unavailable"
                        | "mcp_not_dispatched"
                ) =>
            {
                ToolCompletion::NotDispatched { reason: error.code }
            }
            _ => unknown(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fixture() -> (McpBridge, mpsc::Receiver<Value>) {
        let (output, frames) = mpsc::sync_channel(4);
        let bridge = McpBridge::new(output.into());
        bridge.initialize("epoch");
        (bridge, frames)
    }
    fn start(
        bridge: McpBridge,
        cancel: CancellationToken,
    ) -> mpsc::Receiver<Result<Reply, ExecutionError>> {
        let (done, result) = mpsc::channel();
        std::thread::spawn(move || {
            let binding = McpBinding {
                reference: "owner".into(),
                generation: 1,
                tools: vec![],
                resources: std::collections::BTreeMap::new(),
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
            let generation = McpGeneration {
                run_id: "run".into(),
                binding,
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
        assert_eq!(request["kind"], "mcp-tool-request");
        cancel.cancel();
        let cancelled = frames.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(cancelled["kind"], "mcp-tool-cancel");
        assert_eq!(cancelled["id"], request["id"]);
        bridge.receive(json!({"v":1,"kind":"mcp-tool-response","id":request["id"],"kernelEpoch":"epoch","ok":true,
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
            assert_eq!(error.code, "mcp_channel_closed");
            bridge.receive(json!({"v":1,"kind":"mcp-tool-response","id":request["id"],"kernelEpoch":"epoch","ok":true}));
            bridge.close();
        }
    }
}
