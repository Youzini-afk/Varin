//! Native tool executor over the existing Application Host MCP authority.
//! Frames are private, epoch-bound, and name concrete retained tools, never arbitrary Host methods.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use varin_runtime::execution::*;
use varin_runtime::{Effect, Lifetime, Outcome};

pub(crate) use varin_runtime::catalog::launches::HostToolBinding as McpBinding;
struct State {
    epoch: Option<String>,
    pending: HashMap<String, mpsc::Sender<Reply>>,
}
#[derive(Clone)]
pub(crate) struct McpBridge {
    state: Arc<Mutex<State>>,
    events: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
}
impl McpBridge {
    pub(crate) fn new(output: mpsc::SyncSender<Value>) -> Self {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(State { epoch: None, pending: HashMap::new() }));
        let failed_state = state.clone();
        std::thread::spawn(move || {
            for event in rx {
                if output.send(event).is_err() { break; }
            }
            if let Ok(mut state) = failed_state.lock() { state.epoch = None; state.pending.clear(); }
        });
        Self { state, events: Arc::new(Mutex::new(Some(tx))) }
    }
    pub(crate) fn initialize(&self, epoch: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.pending.clear();
            state.epoch = Some(epoch.into());
        }
    }
    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() { state.epoch = None; state.pending.clear(); }
        if let Ok(mut events) = self.events.lock() { events.take(); }
    }
    pub(crate) fn receive(&self, value: Value) {
        let Ok(reply) = serde_json::from_value::<Reply>(value) else { return; };
        if reply.v != 1 || reply.kind != "mcp-tool-response" || reply.id.is_empty()
            || (reply.ok && reply.error.is_some()) || (!reply.ok && (reply.error.is_none() || reply.completion.is_some())) { return; }
        if let Ok(mut state) = self.state.lock() {
            if state.epoch.as_deref() != Some(&reply.kernel_epoch) { return; }
            if let Some(pending) = state.pending.remove(&reply.id) { let _ = pending.send(reply); }
        }
    }
    fn send(&self, value: Value) -> Result<(), ExecutionError> {
        self.events.lock().map_err(|_| failed("mcp_channel_failed"))?.as_ref()
            .ok_or_else(|| failed("mcp_channel_closed"))?.send(value).map_err(|_| failed("mcp_channel_closed"))
    }
    fn call(&self, phase: &str, binding: &McpBinding, context: &ToolExecutionContext,
        call: &ToolCall, cancel: &CancellationToken) -> Result<Reply, ExecutionError> {
        if cancel.is_cancelled() { return Err(failed("mcp_cancelled_before_dispatch")); }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let epoch = {
            let mut state = self.state.lock().map_err(|_| failed("mcp_channel_failed"))?;
            let epoch = state.epoch.clone().ok_or_else(|| failed("mcp_channel_unavailable"))?;
            state.pending.insert(id.clone(), tx);
            epoch
        };
        let result = (|| {
            self.send(json!({"v":1,"kind":"mcp-tool-request","id":id,"kernelEpoch":epoch,"phase":phase,
                "binding":{"reference":binding.reference,"generation":binding.generation},
                "call":{"runId":context.run_id,"requestId":match &context.origin { ToolOrigin::ModelStep { request_id } => request_id, _ => return Err(failed("mcp_policy_action_forbidden")) },"operationId":context.operation_id,
                    "callId":call.call_id,"name":call.name,"schemaVersion":call.schema_version,"arguments":call.arguments}}))
                .map_err(|_| failed("mcp_not_dispatched"))?;
            let mut cancellation_sent = false;
            loop {
                match rx.recv_timeout(Duration::from_millis(25)) {
                    Ok(reply) => return Ok(reply),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Err(failed("mcp_channel_closed")),
                    Err(mpsc::RecvTimeoutError::Timeout) => {},
                }
                if cancel.is_cancelled() && !cancellation_sent {
                    cancellation_sent = true;
                    self.send(json!({"v":1,"kind":"mcp-tool-cancel","id":id,"kernelEpoch":epoch,"runId":context.run_id}))?;
                    // Cancellation is not a no-effect receipt. Host races the retained call against
                    // its abort signal and returns a real result or an explicit unknown receipt.
                }
            }
        })();
        if let Ok(mut state) = self.state.lock() { state.pending.remove(&id); }
        result
    }
    pub(crate) fn wrap(&self, run_id: String, binding: McpBinding, inner: Arc<dyn ToolExecutor>) -> Result<Arc<dyn ToolExecutor>, ExecutionError> {
        binding.validate().map_err(|_| failed("mcp_binding_invalid"))?;
        let tools = binding.tools.iter().map(|schema| (schema.name.clone(), schema.clone())).collect();
        Ok(Arc::new(McpTools { run_id, binding, tools, bridge: self.clone(), inner }))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reply {
    v: u64, kind: String, id: String, kernel_epoch: String, ok: bool,
    completion: Option<ToolCompletion>, error: Option<ErrorMarker>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorMarker { #[serde(rename = "code")] _code: String }
fn failed(code: &str) -> ExecutionError { ExecutionError::new(code, code) }
fn unknown() -> ToolCompletion {
    ToolCompletion::Result { outcome: Outcome::Indeterminate, effect: Effect::Unknown,
        content: json!({"error":"mcp_effect_unknown"}) }
}
struct McpTools {
    run_id: String, binding: McpBinding, tools: BTreeMap<String, ToolSchema>,
    bridge: McpBridge, inner: Arc<dyn ToolExecutor>,
}
impl McpTools {
    fn contract(&self, call: &ToolCall) -> Result<ToolContract, ExecutionError> {
        let schema = self.tools.get(&call.name).ok_or_else(|| failed("mcp_tool_unavailable"))?;
        if schema.version != call.schema_version || !call.arguments.is_object() { return Err(failed("mcp_schema_changed")); }
        let discovery = call.name == "mcp_discover";
        let target = if call.name == "mcp_call" {
            format!("server:{}", call.arguments.get("server").and_then(Value::as_str).ok_or_else(|| failed("mcp_target_required"))?)
        } else { call.name.clone() };
        let resources = if discovery { Vec::new() } else {
            let key = self.binding.resources.get(&target).ok_or_else(|| failed("mcp_target_unbound"))?;
            vec![ResourceClaim { key: key.clone(), access: Access::Write }]
        };
        Ok(ToolContract { name: call.name.clone(), schema_version: call.schema_version.clone(),
            // Selected-server discovery is a durable preparation Operation. A catalog listing
            // without a server is purely local and needs no effectful Operation.
            read_only: discovery && call.arguments.get("server").is_none(), completion: CompletionKind::Result, lifetime: Lifetime::Run, resources })
    }
    fn validate(&self, context: &ToolExecutionContext, call: &ToolCall, contract: &ToolContract) -> Result<(), ExecutionError> {
        if context.run_id != self.run_id || &self.contract(call)? != contract { return Err(failed("mcp_call_binding_changed")); }
        Ok(())
    }
}
impl ToolExecutor for McpTools {
    fn supports_policy_read(&self, context: &FrozenToolContext, call: &ToolCall, contract: &ToolContract) -> bool {
        !self.tools.contains_key(&call.name) && self.inner.supports_policy_read(context, call, contract)
    }
    fn prepare(&self, call: &ToolCall, request: &FrozenToolContext) -> Result<ToolContract, ExecutionError> {
        let Some(schema) = self.tools.get(&call.name) else { return self.inner.prepare(call, request); };
        if request.run_id != self.run_id || !request.tools.contains(schema) { return Err(failed("mcp_frozen_schema_changed")); }
        self.contract(call)
    }
    fn authorize(&self, context: &ToolExecutionContext, call: &ToolCall, contract: &ToolContract, cancel: &CancellationToken) -> Result<(), ExecutionError> {
        if !self.tools.contains_key(&call.name) { return self.inner.authorize(context, call, contract, cancel); }
        self.validate(context, call, contract)?;
        let reply = self.bridge.call("authorize", &self.binding, context, call, cancel)?;
        if !reply.ok || reply.completion.is_some() { return Err(failed("mcp_authorization_failed")); }
        Ok(())
    }
    fn execute(&self, context: &ToolExecutionContext, call: &ToolCall, contract: &ToolContract, cancel: &CancellationToken) -> ToolCompletion {
        if !self.tools.contains_key(&call.name) { return self.inner.execute(context, call, contract, cancel); }
        if self.validate(context, call, contract).is_err() || cancel.is_cancelled() {
            return ToolCompletion::NotDispatched { reason: "mcp_cancelled_or_binding_changed".into() };
        }
        match self.bridge.call("execute", &self.binding, context, call, cancel) {
            Ok(reply) if reply.ok => match reply.completion {
                Some(completion @ ToolCompletion::NotDispatched { .. }) => completion,
                Some(completion @ ToolCompletion::Result { .. }) => completion,
                _ => unknown(),
            },
            Err(error) if matches!(error.code.as_str(), "mcp_cancelled_before_dispatch" | "mcp_channel_unavailable" | "mcp_not_dispatched") =>
                ToolCompletion::NotDispatched { reason: error.code },
            _ => unknown(),
        }
    }
}
