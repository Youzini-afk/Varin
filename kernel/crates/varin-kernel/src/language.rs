//! Private rendezvous with the existing Host language owner. No server/configuration owner here.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::execution::{CancellationToken, ExecutionError};

struct Pending { reply: mpsc::Sender<Reply>, wake: mpsc::SyncSender<()> }
struct State { epoch: Option<String>, pending: HashMap<String, Pending> }
#[derive(Clone)]
pub(crate) struct LanguageBridge {
    state: Arc<Mutex<State>>,
    events: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Reply { v: u64, kind: String, id: String, kernel_epoch: String, result: Value }
fn failed(code: &str) -> ExecutionError { ExecutionError::new(code, code) }
impl LanguageBridge {
    pub(crate) fn new(output: mpsc::SyncSender<Value>) -> Self {
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(State { epoch: None, pending: HashMap::new() }));
        let failed_state = state.clone();
        std::thread::spawn(move || {
            for event in rx { if output.send(event).is_err() { break; } }
            if let Ok(mut state) = failed_state.lock() {
                state.epoch = None;
                for (_, pending) in state.pending.drain() { drop(pending.reply); let _ = pending.wake.try_send(()); }
            }
        });
        Self { state, events: Arc::new(Mutex::new(Some(tx))) }
    }
    pub(crate) fn initialize(&self, epoch: &str) {
        if let Ok(mut state) = self.state.lock() {
            for (_, pending) in state.pending.drain() { drop(pending.reply); let _ = pending.wake.try_send(()); }
            state.epoch = Some(epoch.into());
        }
    }
    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.epoch = None;
            for (_, pending) in state.pending.drain() { drop(pending.reply); let _ = pending.wake.try_send(()); }
        }
        if let Ok(mut events) = self.events.lock() { events.take(); }
    }
    pub(crate) fn receive(&self, value: Value) {
        let Ok(reply) = serde_json::from_value::<Reply>(value) else { return; };
        if reply.v != 1 || reply.kind != "language-response" || !reply.result.is_object() { return; }
        if let Ok(mut state) = self.state.lock() {
            if state.epoch.as_deref() != Some(&reply.kernel_epoch) { return; }
            if let Some(pending) = state.pending.remove(&reply.id) {
                let _ = pending.reply.send(reply);
                let _ = pending.wake.try_send(());
            }
        }
    }
    fn send(&self, value: Value) -> Result<(), ExecutionError> {
        self.events.lock().map_err(|_| failed("language_channel_failed"))?.as_ref()
            .ok_or_else(|| failed("language_channel_closed"))?.send(value).map_err(|_| failed("language_channel_closed"))
    }
    pub(crate) fn query(&self, query: Value, cancel: &CancellationToken) -> Result<Value, ExecutionError> {
        if cancel.is_cancelled() { return Err(failed("language_cancelled")); }
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, rx) = mpsc::channel();
        let (wake, changed) = mpsc::sync_channel(1);
        let _registration = cancel.wake_on_cancel(wake.clone());
        let epoch = {
            let mut state = self.state.lock().map_err(|_| failed("language_channel_failed"))?;
            let epoch = state.epoch.clone().ok_or_else(|| failed("language_channel_unavailable"))?;
            state.pending.insert(id.clone(), Pending { reply, wake });
            epoch
        };
        let result = (|| {
            self.send(json!({"v":1,"kind":"language-request","id":id,"kernelEpoch":epoch,"query":query}))?;
            loop {
                if cancel.is_cancelled() {
                    // Read-only query cancellation settles this waiter, not the shared language process.
                    self.send(json!({"v":1,"kind":"language-cancel","id":id,"kernelEpoch":epoch}))?;
                    return Err(failed("language_cancelled"));
                }
                match rx.try_recv() {
                    Ok(reply) => return Ok(reply.result),
                    Err(mpsc::TryRecvError::Disconnected) => return Err(failed("language_channel_closed")),
                    Err(mpsc::TryRecvError::Empty) => {},
                }
                changed.recv().map_err(|_| failed("language_channel_closed"))?;
            }
        })();
        if let Ok(mut state) = self.state.lock() { state.pending.remove(&id); }
        result
    }
}

#[cfg(test)]
#[path = "language_review_tests.rs"]
mod review_tests;
