//! Original Run-driver rendezvous. Host callbacks choose algorithms; native contexts
//! admit work and retain their real executors until drainage, including after cancellation.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::driver::*;
use varin_runtime::execution::{ExecutionError, ExecutionReport};

struct Pending {
    context: Arc<DriverContext>,
    reply: Option<Result<DriverRunOutcome, ExecutionError>>,
    wake: mpsc::SyncSender<()>,
}
#[derive(Default)]
struct State {
    epoch: Option<String>,
    pending: HashMap<String, Pending>,
}
#[derive(Clone)]
pub(crate) struct DriverBridge {
    state: Arc<Mutex<State>>,
    output: crate::transport::Sender,
}
fn failed(message: impl ToString) -> ExecutionError {
    ExecutionError::new("driver_bridge", message.to_string())
}
impl DriverBridge {
    pub fn new(output: impl Into<crate::transport::Sender>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            output: output.into(),
        }
    }
    pub fn initialize(&self, epoch: &str) {
        self.close();
        self.state.lock().unwrap_or_else(|p| p.into_inner()).epoch = Some(epoch.into());
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.epoch = None;
        for pending in state.pending.values_mut() {
            pending.context.cancel.cancel();
            pending.reply = Some(Err(failed(
                "original driver transport closed; work will not be replayed",
            )));
            let _ = pending.wake.try_send(());
        }
    }
    pub fn release(&self, run_id: &str) {
        if let Some(epoch) = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .epoch
            .clone()
        {
            let _ = self.output.send(
                json!({"v":1,"kind":"agent-driver-release","kernelEpoch":epoch,"runId":run_id}),
            );
        }
    }
    pub fn receive(&self, value: Value) {
        if value.get("kind").and_then(Value::as_str) == Some("agent-driver-closing") {
            let Ok(closing) = serde_json::from_value::<Closing>(value) else {
                return;
            };
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if closing.v != 1
                || closing.kind != "agent-driver-closing"
                || closing.id != closing.instance_id
                || state.epoch.as_deref() != Some(&closing.kernel_epoch)
            {
                return;
            }
            if let Some(pending) = state.pending.get(&closing.instance_id) {
                if pending.context.run_id == closing.run_id
                    && pending.context.epoch == closing.generation
                {
                    pending.context.close_admission();
                }
            }
            return;
        }
        let Ok(reply) = serde_json::from_value::<Reply>(value) else {
            return;
        };
        if reply.v != 1
            || reply.kind != "agent-driver-response"
            || reply.id != reply.instance_id
            || reply.ok != reply.outcome.is_some()
            || reply.ok == reply.error.is_some()
        {
            return;
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.epoch.as_deref() != Some(&reply.kernel_epoch) {
            return;
        }
        if let Some(pending) = state.pending.get_mut(&reply.instance_id) {
            if pending.reply.is_none() {
                pending.context.close_admission();
                pending.reply = Some(if reply.ok {
                    Ok(reply.outcome.expect("checked outcome"))
                } else {
                    Err(reply.error.expect("checked failure"))
                });
                let _ = pending.wake.try_send(());
            }
        }
    }
    pub fn context(&self, instance: &str) -> Result<Arc<DriverContext>, ExecutionError> {
        self.state
            .lock()
            .map_err(failed)?
            .pending
            .get(instance)
            .filter(|p| p.reply.is_none())
            .map(|p| p.context.clone())
            .ok_or_else(|| failed("original Run driver instance is unavailable"))
    }
    pub fn driver(&self, binding: DriverBinding) -> Result<Arc<dyn RunDriver>, ExecutionError> {
        DriverSelection::Extension {
            artifact: binding.artifact.clone(),
        }
        .validate()
        .map_err(failed)?;
        if binding.reference.is_empty() {
            return Err(failed("driver live reference is required"));
        }
        Ok(Arc::new(HostDriver {
            bridge: self.clone(),
            binding,
        }))
    }
    fn invoke(
        &self,
        binding: &DriverBinding,
        context: Arc<DriverContext>,
        input: DriverRunInput,
    ) -> Result<DriverRunOutcome, ExecutionError> {
        let instance = uuid::Uuid::new_v4().to_string();
        let (wake, receive) = mpsc::sync_channel(1);
        let _cancel_wake = context.cancel.wake_on_cancel(wake.clone());
        let epoch = {
            let mut state = self.state.lock().map_err(failed)?;
            let epoch = state
                .epoch
                .clone()
                .ok_or_else(|| failed("driver bridge is not initialized"))?;
            state.pending.insert(
                instance.clone(),
                Pending {
                    context: context.clone(),
                    reply: None,
                    wake,
                },
            );
            epoch
        };
        let result = (|| {
            self.output.send(json!({"v":1,"kind":"agent-driver-run","kernelEpoch":epoch,"id":instance,"instanceId":instance,"runId":context.run_id,"generation":context.epoch,"reference":binding.reference,"input":input})).map_err(failed)?;
            let mut sent_cancel = false;
            loop {
                let reply = self
                    .state
                    .lock()
                    .map_err(failed)?
                    .pending
                    .get(&instance)
                    .and_then(|p| p.reply.clone());
                if let Some(reply) = reply {
                    return reply;
                }
                if context.cancel.is_cancelled() && !sent_cancel {
                    sent_cancel = true;
                    self.output.send(json!({"v":1,"kind":"agent-driver-cancel","kernelEpoch":epoch,"id":instance,"instanceId":instance,"runId":context.run_id,"generation":context.epoch})).map_err(failed)?;
                }
                // A stop request does not fabricate callback completion. The original Host
                // invocation must return, or its actual transport owner must close.
                receive.recv().map_err(failed)?;
            }
        })();
        // Original native calls still hold their context. Fence all new work before removing
        // the live capability; wait for the actual primitive workers outside bridge ownership.
        context.close_and_drain();
        self.state.lock().map_err(failed)?.pending.remove(&instance);
        result
    }
}
struct HostDriver {
    bridge: DriverBridge,
    binding: DriverBinding,
}
impl RunDriver for HostDriver {
    fn selection(&self) -> DriverSelection {
        DriverSelection::Extension {
            artifact: self.binding.artifact.clone(),
        }
    }
    fn run(&self, context: Arc<DriverContext>) -> Result<ExecutionReport, ExecutionError> {
        let input = context.prepare_custom()?;
        let result = self.bridge.invoke(&self.binding, context.clone(), input);
        context.finish_custom(result)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    v: u64,
    kind: String,
    kernel_epoch: String,
    id: String,
    instance_id: String,
    ok: bool,
    outcome: Option<DriverRunOutcome>,
    error: Option<ExecutionError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Closing {
    v: u64,
    kind: String,
    kernel_epoch: String,
    id: String,
    instance_id: String,
    run_id: String,
    generation: u64,
}
