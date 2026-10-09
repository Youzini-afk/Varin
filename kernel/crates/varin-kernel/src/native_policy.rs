//! Private, cancellable Decision rendezvous. No Catalog lock or control worker waits on a policy.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::execution::*;

struct Pending { wake: mpsc::SyncSender<()>, reply: Option<Reply> }
struct State { epoch: Option<String>, pending: HashMap<String, Pending> }
#[derive(Clone)]
pub(crate) struct PolicyBridge { state: Arc<Mutex<State>>, events: Arc<Mutex<Option<mpsc::Sender<Value>>>> }
impl PolicyBridge {
    pub(crate) fn new(output: mpsc::SyncSender<Value>) -> Self {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(State { epoch: None, pending: HashMap::new() }));
        let failed = state.clone();
        std::thread::spawn(move || {
            for event in rx { if output.send(event).is_err() { break; } }
            close_state(&failed);
        });
        Self { state, events: Arc::new(Mutex::new(Some(tx))) }
    }
    pub(crate) fn initialize(&self, epoch: &str) {
        close_state(&self.state);
        if let Ok(mut state) = self.state.lock() { state.epoch = Some(epoch.into()); }
    }
    pub(crate) fn close(&self) {
        close_state(&self.state);
        if let Ok(mut events) = self.events.lock() { events.take(); }
    }
    pub(crate) fn receive(&self, value: Value) {
        let Ok(reply) = serde_json::from_value::<Reply>(value) else { return; };
        if reply.v != 1 || reply.kind != "agent-policy-response" || reply.id.is_empty()
            || reply.ok != reply.decision.is_some() || reply.ok == reply.error.is_some() { return; }
        if let Ok(mut state) = self.state.lock() {
            if state.epoch.as_deref() != Some(&reply.kernel_epoch) { return; }
            if let Some(pending) = state.pending.get_mut(&reply.id) {
                if pending.reply.is_none() { pending.reply = Some(reply); let _ = pending.wake.try_send(()); }
            }
        }
    }
    fn send(&self, value: Value) -> Result<(), ExecutionError> {
        // Validate against the real transport framing contract before entering the shared writer.
        // A bad/oversized policy checkpoint must fail this decision, not disconnect other Runs.
        crate::protocol::write_frame(&mut std::io::sink(), &value)
            .map_err(|_| failed("policy_frame_invalid"))?;
        self.events.lock().map_err(|_| failed("policy_channel_failed"))?.as_ref()
            .ok_or_else(|| failed("policy_channel_closed"))?.send(value).map_err(|_| failed("policy_channel_closed"))
    }
    pub(crate) fn policy(&self, run_id: String, reference: String, identity: PolicyIdentity) -> Result<Arc<dyn AgentPolicy>, ExecutionError> {
        if run_id.is_empty() || reference.is_empty() || identity.name.is_empty() || identity.version.is_empty() {
            return Err(failed("policy_binding_invalid"));
        }
        Ok(Arc::new(HostPolicy { bridge: self.clone(), run_id, reference, identity }))
    }
}
fn close_state(state: &Mutex<State>) {
    if let Ok(mut state) = state.lock() {
        state.epoch = None;
        for (_, pending) in state.pending.drain() { let _ = pending.wake.try_send(()); }
    }
}
struct HostPolicy { bridge: PolicyBridge, run_id: String, reference: String, identity: PolicyIdentity }
impl AgentPolicy for HostPolicy {
    fn identity(&self) -> PolicyIdentity { self.identity.clone() }
    fn decide(&self, view: &PolicyView<'_>, event: &PolicyEvent, checkpoint: &Value, cancel: &CancellationToken) -> Result<PolicyDecision, ExecutionError> {
        if view.run_id != self.run_id { return Err(failed("policy_run_mismatch")); }
        if cancel.is_cancelled() { return Err(failed("policy_cancelled")); }
        let id = uuid::Uuid::new_v4().to_string();
        let (wake, rx) = mpsc::sync_channel(1);
        let _registration = cancel.wake_on_cancel(wake.clone());
        let epoch = {
            let mut state = self.bridge.state.lock().map_err(|_| failed("policy_channel_failed"))?;
            let epoch = state.epoch.clone().ok_or_else(|| failed("policy_channel_unavailable"))?;
            state.pending.insert(id.clone(), Pending { wake, reply: None }); epoch
        };
        let result = (|| {
            self.bridge.send(json!({"v":1,"kind":"agent-policy-request","id":id,"kernelEpoch":epoch,
                "runId":self.run_id,"binding":{"reference":self.reference,"identity":self.identity},
                "input":{"view":{"run_id":view.run_id,"state":view.state,"history_count":view.history.len(),"history_head_id":view.history.last().map(|item| &item.id),
                    "pending_tool_calls":view.pending_tool_calls},"event":event_view(event),"state":checkpoint}}))?;
            loop {
                if cancel.is_cancelled() {
                    let _ = self.bridge.send(json!({"v":1,"kind":"agent-policy-cancel","id":id,"kernelEpoch":epoch,"runId":self.run_id}));
                    return Err(failed("policy_cancelled"));
                }
                {
                    let mut state = self.bridge.state.lock().map_err(|_| failed("policy_channel_failed"))?;
                    if state.epoch.as_deref() != Some(&epoch) { return Err(failed("policy_channel_closed")); }
                    let pending = state.pending.get_mut(&id).ok_or_else(|| failed("policy_channel_closed"))?;
                    if let Some(reply) = pending.reply.take() { return reply.decision.ok_or_else(|| failed("policy_decision_failed")); }
                }
                rx.recv().map_err(|_| failed("policy_channel_closed"))?;
            }
        })();
        if let Ok(mut state) = self.bridge.state.lock() { state.pending.remove(&id); }
        result
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reply { v: u64, kind: String, id: String, kernel_epoch: String, ok: bool, decision: Option<PolicyDecision>, error: Option<ErrorMarker> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorMarker { #[serde(rename = "code")] _code: String }
fn failed(code: &str) -> ExecutionError { ExecutionError::new(code, code) }

/// Graph settlement carries scoped references. Explicit own-result reads carry one bounded
/// immutable content chunk through this same selected-policy binding; no general hash reader or
/// full-result control frame is exposed. Model tool events remain settlement-only.
fn event_view(event: &PolicyEvent) -> Value {
    match event {
        PolicyEvent::ToolsCompleted { results } => json!({"kind":"tools_completed","results":results.iter().map(|result| {
            let completion = match &result.completion {
                ToolCompletion::Result { outcome, effect, .. } => json!({"kind":"result","outcome":outcome,"effect":effect}),
                ToolCompletion::NotDispatched { .. } => json!({"kind":"not_dispatched"}),
                ToolCompletion::JobAccepted { operation_id, phase, effect, lifetime } => json!({"kind":"job_accepted","operation_id":operation_id,"phase":phase,"effect":effect,"lifetime":lifetime}),
            };
            json!({"request_id":result.request_id,"call_id":result.call_id,"completion":completion})
        }).collect::<Vec<_>>()}),
        _ => serde_json::to_value(event).expect("policy event serializes"),
    }
}
