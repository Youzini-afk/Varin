//! Native agent control is independent of the file/process Storage execution queue.
//! Only the authenticated parent Host may use this management channel. It is not a tool grant.
use crate::error::{response_error, KernelError};
use crate::protocol::{
    reject_unknown_fields, response_ok, validate_method_params, PROTOCOL_VERSION,
};
use crate::protocol_generated::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread::{self, JoinHandle};
use varin_runtime::{Catalog, SubmitInput};

pub(crate) enum Command {
    Initialize {
        root: PathBuf,
        epoch: String,
    },
    Request {
        value: Value,
        cancellation: Arc<AtomicBool>,
    },
}
fn domain(error: varin_runtime::RuntimeError) -> KernelError {
    match error {
        varin_runtime::RuntimeError::Conflict(message) => {
            KernelError::Operation(format!("conflict: {message}"))
        }
        varin_runtime::RuntimeError::NotFound(message) => {
            KernelError::Operation(format!("not found: {message}"))
        }
        varin_runtime::RuntimeError::Invalid(message) => KernelError::Protocol(message),
        other => KernelError::Storage(other.to_string()),
    }
}
pub(crate) fn spawn(
    commands: mpsc::Receiver<Command>,
    responses: mpsc::SyncSender<Value>,
    finished: impl Fn(&str) + Send + 'static,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut identity: Option<(PathBuf, String)> = None;
        let mut catalog: Option<Catalog> = None;
        for command in commands {
            match command {
                Command::Initialize { root, epoch } => {
                    identity = Some((root.join("agent-runtime"), epoch));
                }
                Command::Request {
                    value,
                    cancellation,
                } => {
                    let id = value
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let result = (|| {
                        if cancellation.load(Ordering::Acquire) {
                            return Err(KernelError::Cancelled);
                        }
                        reject_unknown_fields(
                            &value,
                            &["v", "kind", "id", "method", "params", "epoch", "grantId"],
                            "native runtime request",
                        )?;
                        if value.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
                            || value.get("kind").and_then(Value::as_str) != Some("request")
                            || id.is_empty()
                        {
                            return Err(KernelError::Protocol("invalid runtime envelope".into()));
                        }
                        let (root, epoch) = identity.as_ref().ok_or_else(|| {
                            KernelError::Authorization("kernel handshake required".into())
                        })?;
                        if value.get("epoch").and_then(Value::as_str) != Some(epoch.as_str())
                            || value.get("grantId").is_some()
                        {
                            return Err(KernelError::Authorization(
                                "native runtime commands require current Host management authority"
                                    .into(),
                            ));
                        }
                        let method = value
                            .get("method")
                            .and_then(Value::as_str)
                            .ok_or_else(|| KernelError::Protocol("method required".into()))?;
                        let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
                        validate_method_params(method, &params)?;
                        if catalog.is_none() {
                            catalog = Some(Catalog::open(root).map_err(domain)?);
                        }
                        dispatch(catalog.as_mut().expect("opened catalog"), method, params)
                    })();
                    let response = match result {
                        Ok(result) => response_ok(&id, result),
                        Err(error) => response_error(&id, &error),
                    };
                    finished(&id);
                    if responses.send(response).is_err() {
                        break;
                    }
                }
            }
        }
    })
}
fn dispatch(catalog: &mut Catalog, method: &str, params: Value) -> Result<Value, KernelError> {
    match method {
        "runtime.status" => Ok(json!({"epoch":catalog.epoch()})),
        "runtime.thread.create" => {
            let p: NativeThreadCreateParams = serde_json::from_value(params)?;
            if p.thread_id.trim().is_empty() || p.branch_id.trim().is_empty() {
                return Err(KernelError::Protocol(
                    "thread and branch identities cannot be empty".into(),
                ));
            }
            catalog
                .create_thread(&p.thread_id, &p.branch_id)
                .map_err(domain)?;
            Ok(json!({"threadId":p.thread_id,"branchId":p.branch_id}))
        }
        "runtime.input.submit" => {
            let p: NativeInputSubmitParams = serde_json::from_value(params)?;
            if p.key.trim().is_empty() {
                return Err(KernelError::Protocol(
                    "input idempotency key cannot be empty".into(),
                ));
            }
            Ok(serde_json::to_value(
                catalog
                    .submit(&SubmitInput {
                        key: p.key,
                        thread_id: p.thread_id,
                        branch_id: p.branch_id,
                        expected_head: p.expected_head.0,
                        input: p.input,
                        configuration: p.configuration,
                    })
                    .map_err(domain)?,
            )?)
        }
        "runtime.run.inspect" | "runtime.run.cancel" => {
            let p: NativeRunParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                if method.ends_with("cancel") {
                    catalog.request_cancel_run(&p.run_id)
                } else {
                    catalog.run(&p.run_id)
                }
                .map_err(domain)?,
            )?)
        }
        "runtime.operation.inspect" | "runtime.operation.cancel" => {
            let p: NativeOperationParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                if method.ends_with("cancel") {
                    catalog.request_cancel_operation(&p.operation_id)
                } else {
                    catalog.operation(&p.operation_id)
                }
                .map_err(domain)?,
            )?)
        }
        "runtime.history.read" => {
            let p: NativeHistoryParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                catalog.history(&p.branch_id).map_err(domain)?,
            )?)
        }
        "runtime.events.read" => {
            let p: NativeEventsParams = serde_json::from_value(params)?;
            let cursor = u64::try_from(p.cursor)
                .map_err(|_| KernelError::Protocol("event cursor must be nonnegative".into()))?;
            let limit = u32::try_from(p.limit)
                .map_err(|_| KernelError::Protocol("event limit out of range".into()))?;
            Ok(serde_json::to_value(
                catalog.events_after(cursor, limit).map_err(domain)?,
            )?)
        }
        _ => Err(KernelError::Protocol(
            "unknown native runtime method".into(),
        )),
    }
}
