//! Private rendezvous with the selected Host retrieval owner. No search/configuration owner here.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::execution::{CancellationToken, ExecutionError};

struct Pending {
    reply: mpsc::Sender<Reply>,
    wake: mpsc::SyncSender<()>,
    presentation: Option<Value>,
    sequence: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn progress_uses_query_identity_without_blocking_replies_for_a_slow_viewer() {
        let (output, events) = mpsc::sync_channel(0);
        let bridge = RetrievalBridge::new(output);
        bridge.initialize("epoch");
        let querying = bridge.clone();
        let query = std::thread::spawn(move || {
            querying.query(json!({"question":"frames"}), &CancellationToken::default(), Some(json!({
            "runId":"run", "threadId":"thread", "branchId":"branch", "requestId":"request",
            "event":{"kind":"tool_progress", "operationId":"request:tool:call", "toolName":"code_retrieval"}
        })))
        });
        let request = events.recv_timeout(Duration::from_secs(3)).unwrap();
        let receiving = bridge.clone();
        let (done, settled) = mpsc::channel();
        let response = std::thread::spawn(move || {
            receiving.receive(
                json!({"v":1,"kind":"retrieval-progress","kernelEpoch":"epoch","id":request["id"],
                "runId":"ignored-host-claim","progress":{"phase":"collecting","receivedFiles":1}}),
            );
            receiving.receive(
                json!({"v":1,"kind":"retrieval-response","kernelEpoch":"epoch","id":request["id"],
                "result":{"status":"ready","snippets":[]}}),
            );
            done.send(()).unwrap();
        });
        // The viewer has not consumed progress; the original query can already settle.
        settled.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(
            query.join().unwrap().unwrap(),
            json!({"status":"ready","snippets":[]})
        );
        let progress = events.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(progress["runId"], "run");
        assert_eq!(progress["threadId"], "thread");
        assert_eq!(progress["branchId"], "branch");
        assert_eq!(progress["event"]["operationId"], "request:tool:call");
        assert_eq!(progress["event"]["details"]["progress"]["receivedFiles"], 1);
        response.join().unwrap();
        bridge.close();
    }
}
struct State {
    epoch: Option<String>,
    pending: HashMap<String, Pending>,
    progress: HashMap<String, Value>,
}
#[derive(Clone)]
pub(crate) struct RetrievalBridge {
    state: Arc<Mutex<State>>,
    events: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
    progress_wake: Arc<Mutex<Option<mpsc::SyncSender<()>>>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    v: u64,
    kind: String,
    id: String,
    kernel_epoch: String,
    result: Value,
}
fn failed(code: &str) -> ExecutionError {
    ExecutionError::new(code, code)
}
impl RetrievalBridge {
    pub(crate) fn finish(&self, operation_id: &str) -> Result<bool, ExecutionError> {
        let state = self.state.lock().map_err(|_| failed("retrieval_channel_failed"))?;
        let Some(epoch) = &state.epoch else { return Ok(false); };
        let matches: Vec<_> = state.pending.iter().filter(|(_, pending)| pending.presentation.as_ref()
            .is_some_and(|value| value["event"]["operationId"] == operation_id)).map(|(id, _)| id.clone()).collect();
        for id in &matches {
            self.send(json!({"v":1,"kind":"retrieval-finish","id":id,"kernelEpoch":epoch}))?;
        }
        Ok(!matches.is_empty())
    }
    pub(crate) fn new(output: impl Into<crate::transport::Sender>) -> Self {
        let output = output.into();
        let progress_output = output.clone();
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(State {
            epoch: None,
            pending: HashMap::new(),
            progress: HashMap::new(),
        }));
        let (progress_tx, progress_rx) = mpsc::sync_channel(1);
        let progress_state = state.clone();
        std::thread::spawn(move || {
            while progress_rx.recv().is_ok() {
                let updates = std::mem::take(&mut progress_state.lock().unwrap().progress);
                for (_, event) in updates {
                    if progress_output.send_progress(event).is_err() {
                        return;
                    }
                }
            }
        });
        let failed_state = state.clone();
        std::thread::spawn(move || {
            for event in rx {
                if output.send(event).is_err() {
                    break;
                }
            }
            if let Ok(mut state) = failed_state.lock() {
                state.epoch = None;
                for (_, pending) in state.pending.drain() {
                    drop(pending.reply);
                    let _ = pending.wake.try_send(());
                }
            }
        });
        Self {
            state,
            events: Arc::new(Mutex::new(Some(tx))),
            progress_wake: Arc::new(Mutex::new(Some(progress_tx))),
        }
    }
    pub(crate) fn initialize(&self, epoch: &str) {
        if let Ok(mut state) = self.state.lock() {
            for (_, pending) in state.pending.drain() {
                drop(pending.reply);
                let _ = pending.wake.try_send(());
            }
            state.epoch = Some(epoch.into());
            state.progress.clear();
        }
    }
    pub(crate) fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.epoch = None;
            state.progress.clear();
            for (_, pending) in state.pending.drain() {
                drop(pending.reply);
                let _ = pending.wake.try_send(());
            }
        }
        if let Ok(mut events) = self.events.lock() {
            events.take();
        }
        if let Ok(mut wake) = self.progress_wake.lock() {
            wake.take();
        }
    }
    pub(crate) fn receive(&self, value: Value) {
        if value["kind"] == "retrieval-progress" {
            let event = (|| {
                if value["v"] != 1 || !value["progress"].is_object() {
                    return None;
                }
                let mut state = self.state.lock().ok()?;
                let epoch = state.epoch.as_deref()?;
                if value["kernelEpoch"] != epoch {
                    return None;
                }
                let epoch = epoch.to_owned();
                let id = value["id"].as_str()?;
                let pending = state.pending.get_mut(id)?;
                let mut event = pending.presentation.clone()?;
                pending.sequence += 1;
                event["v"] = json!(crate::protocol::PROTOCOL_VERSION);
                event["kind"] = json!("runtime-event");
                event["kernelEpoch"] = json!(epoch);
                event["stream"] = json!("progress");
                event["streamId"] = json!(id);
                event["sequence"] = json!(pending.sequence);
                event["event"]["details"] = json!({"progress":value["progress"]});
                // A slow viewer replaces pending snapshots without blocking private replies.
                state.progress.insert(id.to_owned(), event);
                Some(())
            })();
            if event.is_some() {
                if let Ok(wake) = self.progress_wake.lock() {
                    if let Some(wake) = wake.as_ref() {
                        let _ = wake.try_send(());
                    }
                }
            }
            return;
        }
        let Ok(reply) = serde_json::from_value::<Reply>(value) else {
            return;
        };
        if reply.v != 1 || reply.kind != "retrieval-response" || !reply.result.is_object() {
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
            .map_err(|_| failed("retrieval_channel_failed"))?
            .as_ref()
            .ok_or_else(|| failed("retrieval_channel_closed"))?
            .send(value)
            .map_err(|_| failed("retrieval_channel_closed"))
    }
    pub(crate) fn query(
        &self,
        query: Value,
        cancel: &CancellationToken,
        presentation: Option<Value>,
    ) -> Result<Value, ExecutionError> {
        if cancel.is_cancelled() {
            return Err(failed("retrieval_cancelled"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (reply, rx) = mpsc::channel();
        let (wake, changed) = mpsc::sync_channel(1);
        let _registration = cancel.wake_on_cancel(wake.clone());
        let epoch = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| failed("retrieval_channel_failed"))?;
            let epoch = state
                .epoch
                .clone()
                .ok_or_else(|| failed("retrieval_channel_unavailable"))?;
            state.pending.insert(
                id.clone(),
                Pending {
                    reply,
                    wake,
                    presentation,
                    sequence: 0,
                },
            );
            epoch
        };
        let result = (|| {
            self.send(
                json!({"v":1,"kind":"retrieval-request","id":id,"kernelEpoch":epoch,"query":query}),
            )?;
            loop {
                if cancel.is_cancelled() {
                    // Read-only query cancellation settles this waiter, not the shared retrieval owner.
                    self.send(
                        json!({"v":1,"kind":"retrieval-cancel","id":id,"kernelEpoch":epoch}),
                    )?;
                    return Err(failed("retrieval_cancelled"));
                }
                match rx.try_recv() {
                    Ok(reply) => return Ok(reply.result),
                    Err(mpsc::TryRecvError::Disconnected) => {
                        return Err(failed("retrieval_channel_closed"))
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                changed
                    .recv()
                    .map_err(|_| failed("retrieval_channel_closed"))?;
            }
        })();
        if let Ok(mut state) = self.state.lock() {
            state.pending.remove(&id);
        }
        result
    }
}
