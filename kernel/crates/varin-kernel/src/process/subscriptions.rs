//! Credit-backed process projections. Control/ack/terminal notifications never wait for a data
//! credit, and slow observers never hold guardian, spool writer, or Storage transaction locks.
use super::{failure, read_output, OutputHandle, SpoolCursor, CHUNK_BYTES};
use crate::error::KernelError;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{mpsc, Arc, Mutex, Weak},
    thread,
};

struct State {
    cursor: u64,
    spool: SpoolCursor,
    data_sequence: u64,
    control_sequence: u64,
    data_pending: Option<(u64, u64, SpoolCursor)>,
    control_pending: Option<u64>,
    last_data_ack: u64,
    last_control_ack: u64,
    control_signature: Value,
    closed: Option<String>,
}
struct Subscription {
    id: String,
    process_id: String,
    grant_id: String,
    epoch: String,
    output: OutputHandle,
    snapshot: Value,
    live: bool,
    state: Mutex<State>,
}
struct Inner {
    subscriptions: Mutex<HashMap<String, Arc<Subscription>>>,
    outbound: crate::transport::Sender,
}
#[derive(Clone)]
pub(crate) struct ProcessSubscriptions(Arc<Inner>);
impl ProcessSubscriptions {
    pub(crate) fn new(outbound: impl Into<crate::transport::Sender>) -> Self {
        let outbound = outbound.into();
        Self(Arc::new(Inner {
            subscriptions: Mutex::new(HashMap::new()),
            outbound,
        }))
    }
    pub(super) fn subscribe(
        &self,
        id: &str,
        process_id: &str,
        grant_id: &str,
        epoch: &str,
        cursor: u64,
        snapshot: Value,
        output: OutputHandle,
        live: bool,
    ) -> Result<Value, KernelError> {
        if id.is_empty() {
            return Err(failure("subscriptionId is required"));
        }
        if cursor > output.shared.lock().end {
            return Err(failure("subscription cursor is beyond retained output"));
        }
        let subscription = Arc::new(Subscription {
            id: id.into(),
            process_id: process_id.into(),
            grant_id: grant_id.into(),
            epoch: epoch.into(),
            output,
            snapshot,
            live,
            state: Mutex::new(State {
                cursor,
                spool: SpoolCursor::default(),
                data_sequence: 0,
                control_sequence: 0,
                data_pending: None,
                control_pending: None,
                last_data_ack: 0,
                last_control_ack: 0,
                control_signature: Value::Null,
                closed: None,
            }),
        });
        let mut subscriptions = self
            .0
            .subscriptions
            .lock()
            .map_err(|_| failure("subscription owner poisoned"))?;
        if subscriptions.contains_key(id) {
            return Err(failure("subscription identity is already active"));
        }
        subscriptions.insert(id.into(), subscription.clone());
        drop(subscriptions);
        let control = subscription.clone();
        let owner = Arc::downgrade(&self.0);
        let outbound = self.0.outbound.clone();
        thread::spawn(move || control_loop(control, owner, outbound));
        let data = subscription;
        let outbound = self.0.outbound.clone();
        thread::spawn(move || data_loop(data, outbound));
        Ok(json!({"subscriptionId":id,"processId":process_id,"kernelEpoch":epoch}))
    }
    fn owned(
        &self,
        id: &str,
        grant_id: &str,
        epoch: &str,
    ) -> Result<Arc<Subscription>, KernelError> {
        let subscription = self
            .0
            .subscriptions
            .lock()
            .map_err(|_| failure("subscription owner poisoned"))?
            .get(id)
            .cloned()
            .ok_or_else(|| failure("process subscription is not active"))?;
        if subscription.grant_id != grant_id || subscription.epoch != epoch {
            return Err(KernelError::Authorization(
                "process subscription belongs to another actor or epoch".into(),
            ));
        }
        Ok(subscription)
    }
    pub(crate) fn ack(
        &self,
        id: &str,
        grant_id: &str,
        epoch: &str,
        stream: &str,
        sequence: u64,
    ) -> Result<Value, KernelError> {
        let subscription = self.owned(id, grant_id, epoch)?;
        // The shared wake mutex makes credit transitions atomic with the wait predicate.
        let _wake = subscription.output.shared.lock();
        let mut state = subscription
            .state
            .lock()
            .map_err(|_| failure("subscription state poisoned"))?;
        if state.closed.is_some() {
            return Err(failure("process subscription is closing"));
        }
        match stream {
            "data" => {
                if sequence > 0 && sequence == state.last_data_ack {
                    return Ok(json!({"acknowledged":true}));
                }
                if !state
                    .data_pending
                    .as_ref()
                    .is_some_and(|(pending, _, _)| *pending == sequence)
                {
                    return Err(failure(
                        "process data acknowledgement is stale or out of order",
                    ));
                }
                let (_, cursor, spool) = state.data_pending.take().expect("checked data credit");
                state.cursor = cursor;
                state.spool = spool;
                state.last_data_ack = sequence;
            }
            "control" => {
                if sequence > 0 && sequence == state.last_control_ack {
                    return Ok(json!({"acknowledged":true}));
                }
                if state.control_pending != Some(sequence) {
                    return Err(failure(
                        "process control acknowledgement is stale or out of order",
                    ));
                }
                state.control_pending = None;
                state.last_control_ack = sequence;
            }
            _ => {
                return Err(KernelError::Protocol(
                    "unknown process subscription stream".into(),
                ))
            }
        }
        subscription.output.shared.changed.notify_all();
        Ok(json!({"acknowledged":true}))
    }
    pub(crate) fn unsubscribe(
        &self,
        id: &str,
        grant_id: &str,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let subscription = self.owned(id, grant_id, epoch)?;
        close(subscription.as_ref(), "unsubscribed");
        Ok(json!({"unsubscribed":true}))
    }
    pub(crate) fn close_grant(&self, grant_id: &str) {
        self.close_matching(
            |sub| sub.grant_id == grant_id,
            "process subscription permission was revoked",
        );
    }
    pub(crate) fn close_process(&self, process_id: &str, reason: &str) {
        self.close_matching(|sub| sub.process_id == process_id, reason);
    }
    pub(crate) fn shutdown(&self) {
        self.close_matching(|_| true, "process subscription owner stopped");
    }
    fn close_matching(&self, predicate: impl Fn(&Subscription) -> bool, reason: &str) {
        let subscriptions = self
            .0
            .subscriptions
            .lock()
            .map(|items| {
                items
                    .values()
                    .filter(|sub| predicate(sub))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for subscription in subscriptions {
            close(&subscription, reason);
        }
    }
}
fn close(subscription: &Subscription, reason: &str) {
    let _wake = subscription.output.shared.lock();
    if let Ok(mut state) = subscription.state.lock() {
        state.closed.get_or_insert_with(|| reason.into());
    }
    subscription.output.shared.changed.notify_all();
}
fn envelope(
    subscription: &Subscription,
    stream: &str,
    sequence: u64,
    result: Option<Value>,
    error: Option<String>,
) -> Value {
    json!({"v":crate::protocol::PROTOCOL_VERSION,"kind":"process-event","kernelEpoch":subscription.epoch,
        "subscriptionId":subscription.id,"grantId":subscription.grant_id,"processId":subscription.process_id,
        "stream":stream,"sequence":sequence,"result":result,"error":error})
}
fn projection(subscription: &Subscription, buffer: &super::Buffer, cursor: u64) -> (Value, Value) {
    let mut snapshot = subscription.snapshot.clone();
    if subscription.live {
        if let Some(receipt) = &buffer.receipt {
            for key in ["status", "pid", "exitCode", "signal", "reason"] {
                snapshot[key] = receipt[key].clone();
            }
            snapshot["writerActive"] = json!(false);
        } else if buffer.closed {
            snapshot["status"] = json!("unknown");
            snapshot["writerActive"] = json!(true);
            snapshot["reason"] = json!("guardian control closed without a confirmed tree receipt");
        } else if let Some(pid) = buffer.pid {
            snapshot["pid"] = json!(pid);
            snapshot["status"] = json!("running");
        }
    }
    snapshot["outputAvailable"] = json!(true);
    let signature = json!({"process":snapshot,"inputSequence":buffer.input_sequence,"inputError":buffer.input_error,
        "outputComplete":buffer.output_closed&&buffer.output_error.is_none(),"outputError":buffer.output_error,"controlError":buffer.control_error});
    let result = json!({"process":snapshot,"chunks":[],"nextCursor":cursor,"endCursor":buffer.end,
        "inputSequence":buffer.input_sequence,"inputError":buffer.input_error,
        "outputComplete":buffer.output_closed&&buffer.output_error.is_none(),"outputError":buffer.output_error});
    (signature, result)
}
fn control_loop(
    subscription: Arc<Subscription>,
    owner: Weak<Inner>,
    outbound: crate::transport::Sender,
) {
    loop {
        let mut buffer = subscription.output.shared.lock();
        let frame = loop {
            let mut state = match subscription.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            if let Some(reason) = &state.closed {
                break envelope(
                    &subscription,
                    "closed",
                    state.control_sequence,
                    None,
                    Some(reason.clone()),
                );
            }
            let (signature, result) = projection(&subscription, &buffer, state.cursor);
            if state.control_pending.is_none() && signature != state.control_signature {
                state.control_sequence += 1;
                state.control_pending = Some(state.control_sequence);
                state.control_signature = signature;
                break envelope(
                    &subscription,
                    "control",
                    state.control_sequence,
                    Some(result),
                    None,
                );
            }
            drop(state);
            buffer = subscription
                .output
                .shared
                .changed
                .wait(buffer)
                .unwrap_or_else(|poison| poison.into_inner());
        };
        drop(buffer);
        let closing = frame["stream"] == "closed";
        if outbound.send(frame).is_err() {
            close(&subscription, "process event transport disconnected");
            break;
        }
        if closing {
            break;
        }
    }
    if let Some(owner) = owner.upgrade() {
        if let Ok(mut subscriptions) = owner.subscriptions.lock() {
            subscriptions.remove(&subscription.id);
        }
    }
}
fn data_loop(subscription: Arc<Subscription>, outbound: crate::transport::Sender) {
    loop {
        let mut buffer = subscription.output.shared.lock();
        let (cursor, mut spool) = loop {
            let state = match subscription.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            if state.closed.is_some() {
                return;
            }
            if state.data_pending.is_none() && state.cursor < buffer.end {
                break (state.cursor, state.spool.clone());
            }
            drop(state);
            buffer = subscription
                .output
                .shared
                .changed
                .wait(buffer)
                .unwrap_or_else(|poison| poison.into_inner());
        };
        drop(buffer);
        let mut result = match read_output(&subscription.output, &mut spool, cursor, CHUNK_BYTES) {
            Ok(result) => result,
            Err(error) => {
                close(&subscription, &error.to_string());
                return;
            }
        };
        let buffer = subscription.output.shared.lock();
        let mut state = match subscription.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if state.closed.is_some() {
            return;
        }
        let (_, control) = projection(&subscription, &buffer, state.cursor);
        result["process"] = control["process"].clone();
        let Some(next) = result["nextCursor"].as_u64().filter(|next| *next > cursor) else {
            drop(state);
            drop(buffer);
            close(&subscription, "process data stream made no progress");
            return;
        };
        state.data_sequence += 1;
        let sequence = state.data_sequence;
        state.data_pending = Some((sequence, next, spool));
        let frame = envelope(&subscription, "data", sequence, Some(result), None);
        drop(state);
        drop(buffer);
        if outbound.send(frame).is_err() {
            close(&subscription, "process event transport disconnected");
            return;
        }
    }
}

pub(crate) enum ControlCommand {
    Request {
        value: Value,
        cancellation: Arc<std::sync::atomic::AtomicBool>,
    },
    Stop,
}
pub(crate) fn spawn_control(
    commands: mpsc::Receiver<ControlCommand>,
    subscriptions: ProcessSubscriptions,
    current_epoch: Arc<Mutex<Option<String>>>,
    responses: crate::transport::Sender,
    finished: impl Fn(&str) + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for command in commands {
            let ControlCommand::Request {
                value,
                cancellation,
            } = command
            else {
                break;
            };
            let id = value["id"].as_str().unwrap_or_default().to_string();
            let result = (|| -> Result<Value, KernelError> {
                use crate::protocol::{
                    reject_unknown_fields, validate_method_params, PROTOCOL_VERSION,
                };
                use crate::protocol_generated::{
                    KernelProcessSubscriptionAckParams, KernelProcessSubscriptionParams,
                };
                if cancellation.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                reject_unknown_fields(
                    &value,
                    &["v", "kind", "id", "method", "params", "epoch", "grantId"],
                    "process subscription control",
                )?;
                let epoch = current_epoch
                    .lock()
                    .map_err(|_| failure("kernel epoch owner poisoned"))?
                    .clone()
                    .ok_or_else(|| {
                        KernelError::Authorization("kernel handshake required".into())
                    })?;
                if value["v"].as_u64() != Some(PROTOCOL_VERSION)
                    || value["kind"] != "request"
                    || id.is_empty()
                    || value["epoch"].as_str() != Some(epoch.as_str())
                {
                    return Err(KernelError::Authorization(
                        "subscription control envelope or epoch is invalid".into(),
                    ));
                }
                let grant = value["grantId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        KernelError::Authorization("subscription grant required".into())
                    })?;
                let method = value["method"]
                    .as_str()
                    .ok_or_else(|| failure("subscription method required"))?;
                let params = value["params"].clone();
                validate_method_params(method, &params)?;
                match method {
                    "process.subscription.ack" => {
                        let params: KernelProcessSubscriptionAckParams =
                            serde_json::from_value(params)?;
                        let sequence = u64::try_from(params.sequence)
                            .map_err(|_| failure("subscription sequence must be nonnegative"))?;
                        subscriptions.ack(
                            &params.subscription_id,
                            grant,
                            &epoch,
                            &params.stream,
                            sequence,
                        )
                    }
                    "process.subscription.unsubscribe" => {
                        let params: KernelProcessSubscriptionParams =
                            serde_json::from_value(params)?;
                        subscriptions.unsubscribe(&params.subscription_id, grant, &epoch)
                    }
                    _ => Err(KernelError::Protocol(
                        "unknown process subscription control method".into(),
                    )),
                }
            })();
            let response = match result {
                Ok(value) => crate::protocol::response_ok(&id, value),
                Err(error) => crate::error::response_error(&id, &error),
            };
            finished(&id);
            if responses.send(response).is_err() {
                break;
            }
        }
    })
}
