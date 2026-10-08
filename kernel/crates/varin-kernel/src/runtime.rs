use crate::error::{response_error, KernelError};
use crate::protocol::*;
use crate::protocol_generated::KERNEL_REQUEST_WINDOW;
use crate::storage::Storage;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use uuid::Uuid;

struct ActiveRequest {
    token: Arc<AtomicBool>,
    epoch: Option<String>,
    grant_id: Option<String>,
}

fn mark_grant_revoked(
    revoked_grants: &Arc<Mutex<HashSet<String>>>,
    active: &Arc<Mutex<HashMap<String, ActiveRequest>>>,
    grant_id: &str,
) {
    if grant_id.is_empty() {
        return;
    }
    if let Ok(mut revoked) = revoked_grants.lock() {
        revoked.insert(grant_id.to_string());
    }
    if let Ok(active) = active.lock() {
        for request in active.values() {
            if request.grant_id.as_deref() == Some(grant_id) {
                request.token.store(true, Ordering::Release);
            }
        }
    }
}

fn admission_revoke_target(request: &Value, current_epoch: Option<&str>) -> Option<String> {
    let fields = request.as_object()?;
    if !fields.keys().all(|field| {
        matches!(
            field.as_str(),
            "v" | "kind" | "id" | "method" | "params" | "epoch" | "grantId"
        )
    }) || request.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || request.get("kind").and_then(Value::as_str) != Some("request")
        || request
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || request.get("method").and_then(Value::as_str) != Some("authority.grant.revoke")
        || request.get("epoch").and_then(Value::as_str) != current_epoch
    {
        return None;
    }
    let params = request.get("params")?;
    validate_method_params("authority.grant.revoke", params).ok()?;
    params
        .get("grantId")
        .and_then(Value::as_str)
        .filter(|grant_id| !grant_id.is_empty())
        .map(str::to_string)
}

struct Kernel {
    epoch: String,
    host_id: Option<String>,
    host_generation: Option<String>,
    build_version: Option<String>,
    storage_root: Option<PathBuf>,
    storage: Option<Storage>,
    handshaken: bool,
}

impl Kernel {
    fn new() -> Self {
        Self {
            epoch: Uuid::new_v4().to_string(),
            host_id: None,
            host_generation: None,
            build_version: None,
            storage_root: None,
            storage: None,
            handshaken: false,
        }
    }

    fn handle(
        &mut self,
        request: &Value,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Option<Value>, KernelError> {
        if cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let version = request.get("v").and_then(Value::as_u64).unwrap_or(0);
        if version != PROTOCOL_VERSION {
            return Err(KernelError::Protocol(format!(
                "protocol version mismatch: host={version}, kernel={PROTOCOL_VERSION}"
            )));
        }
        let kind = request.get("kind").and_then(Value::as_str).unwrap_or("");
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Protocol("request id is required".to_string()))?;
        if id.is_empty() {
            return Err(KernelError::Protocol("request id is empty".to_string()));
        }
        if kind == "request" {
            reject_unknown_fields(
                request,
                &["v", "kind", "id", "method", "params", "epoch", "grantId"],
                "request",
            )?;
        } else if kind == "cancel" {
            reject_unknown_fields(request, &["v", "kind", "id", "epoch", "grantId"], "cancel")?;
        } else if kind == "data" {
            reject_unknown_fields(
                request,
                &[
                    "v",
                    "kind",
                    "id",
                    "streamId",
                    "sequence",
                    "bytesBase64",
                    "epoch",
                    "grantId",
                ],
                "data",
            )?;
        }
        if kind == "cancel" {
            return Ok(None);
        }
        if kind != "request" {
            return Err(KernelError::Protocol("expected request frame".to_string()));
        }
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Protocol("request method is required".to_string()))?;
        let params_value = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if method == "kernel.handshake" {
            if self.handshaken {
                return Err(KernelError::Protocol(
                    "handshake already completed".to_string(),
                ));
            }
            reject_unknown_fields(
                &params_value,
                &[
                    "protocolVersion",
                    "buildVersion",
                    "hostId",
                    "hostGeneration",
                    "storageRoot",
                    "capabilities",
                ],
                "handshake",
            )?;
            let protocol = params_value
                .get("protocolVersion")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if protocol != PROTOCOL_VERSION {
                return Err(KernelError::Protocol(format!(
                    "protocol mismatch: host={protocol}, kernel={PROTOCOL_VERSION}"
                )));
            }
            let host_id = params_value
                .get("hostId")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Protocol("hostId is required".to_string()))?
                .to_string();
            if host_id.trim().is_empty() {
                return Err(KernelError::Protocol("hostId is empty".to_string()));
            }
            let host_generation = params_value
                .get("hostGeneration")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| KernelError::Protocol("hostGeneration is required".to_string()))?
                .to_string();
            let build_version = params_value
                .get("buildVersion")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| KernelError::Protocol("buildVersion is required".to_string()))?
                .to_string();
            if build_version != KERNEL_BUILD_IDENTITY {
                return Err(KernelError::Protocol(format!(
                    "application build identity does not match kernel: host={build_version}, kernel={KERNEL_BUILD_IDENTITY}"
                )));
            }
            let requested_capabilities = params_value
                .get("capabilities")
                .and_then(Value::as_array)
                .ok_or_else(|| KernelError::Protocol("capabilities are required".to_string()))?;
            for capability in requested_capabilities {
                let capability = capability
                    .as_str()
                    .ok_or_else(|| KernelError::Protocol("capability is malformed".to_string()))?;
                if !KERNEL_CAPABILITIES.contains(&capability) {
                    return Err(KernelError::Protocol(format!(
                        "unsupported capability requested: {capability}"
                    )));
                }
            }
            let root = params_value
                .get("storageRoot")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Protocol("storageRoot is required".to_string()))?;
            if !Path::new(root).is_absolute() {
                return Err(KernelError::Authorization(
                    "storageRoot must be absolute".to_string(),
                ));
            }
            fs::create_dir_all(root)?;
            let canonical_root = fs::canonicalize(root)?.to_string_lossy().to_string();
            let storage = Storage::open(Path::new(&canonical_root), &host_id)?;
            self.host_id = Some(host_id.clone());
            self.host_generation = Some(host_generation.clone());
            self.build_version = Some(build_version.clone());
            self.storage_root = Some(PathBuf::from(&canonical_root));
            self.storage = Some(storage);
            self.handshaken = true;
            return Ok(Some(response_ok(
                id,
                json!({"protocolVersion": PROTOCOL_VERSION, "kernelVersion": KERNEL_VERSION, "kernelBuildIdentity": KERNEL_BUILD_IDENTITY, "targetTriple": KERNEL_TARGET, "arch": KERNEL_ARCH, "applicationBuildVersion": build_version, "buildVersion": KERNEL_BUILD_IDENTITY, "kernelEpoch": self.epoch, "requestWindow": KERNEL_REQUEST_WINDOW, "hostId": host_id, "hostGeneration": host_generation, "storageRoot": canonical_root, "capabilities": KERNEL_CAPABILITIES}),
            )));
        }
        if !self.handshaken {
            return Err(KernelError::Protocol(
                "handshake is required before requests".to_string(),
            ));
        }
        validate_method_params(method, &params_value)?;
        let request_epoch = request
            .get("epoch")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Authorization("epoch is required after handshake".to_string())
            })?;
        if request_epoch != self.epoch {
            return Err(KernelError::Authorization("stale kernel epoch".to_string()));
        }
        if method == "kernel.ping" {
            return Ok(Some(response_ok(
                id,
                json!({"kernelEpoch": self.epoch, "ready": true}),
            )));
        }
        if method == "kernel.shutdown" {
            if let Some(storage) = self.storage.as_mut() {
                storage.shutdown_computations()?;
                storage.shutdown_processes()?;
            }
            return Ok(Some(response_ok(id, json!({"stopping": true}))));
        }
        let storage = self
            .storage
            .as_mut()
            .ok_or_else(|| KernelError::Storage("storage is not open".to_string()))?;
        let host_id = self.host_id.as_deref().ok_or_else(|| {
            KernelError::Authorization("Host identity is unavailable".to_string())
        })?;
        let grant_id = request.get("grantId").and_then(Value::as_str);
        if method == "authority.grant.issue" {
            reject_unknown_fields(
                &params_value,
                &[
                    "grantId",
                    "hostGeneration",
                    "authorityInstanceId",
                    "workerId",
                    "workerGeneration",
                    "sessionId",
                    "threadId",
                    "runId",
                    "owningWorkspace",
                    "executionWorkspace",
                    "storageIdentity",
                    "capabilities",
                    "pathScopes",
                ],
                "grant",
            )?;
            let storage_identity = storage.root().to_string_lossy().to_string();
            return Ok(Some(response_ok(
                id,
                storage.issue_grant(
                    &params_value,
                    host_id,
                    self.host_generation.as_deref().unwrap_or_default(),
                    &storage_identity,
                    &self.epoch,
                )?,
            )));
        }
        if method == "authority.grant.revoke" {
            reject_unknown_fields(&params_value, &["grantId"], "grant revoke")?;
            return Ok(Some(response_ok(
                id,
                storage.revoke_grant(&params_value, host_id)?,
            )));
        }
        let (authorized_grant, authorized_params) = storage.authorize(
            grant_id,
            &self.epoch,
            host_id,
            self.host_generation.as_deref().unwrap_or_default(),
            method,
            &params_value,
        )?;
        storage.set_cancellation(cancellation);
        let result = storage.dispatch(method, &authorized_params, grant_id, &authorized_grant);
        storage.clear_cancellation();
        Ok(Some(response_ok(id, result?)))
    }
}

pub(crate) fn run() -> Result<(), Box<dyn std::error::Error>> {
    // The Host holds at most this many acknowledgement-backed credits. The
    // stdin reader therefore stays available for cancel/revoke even while the
    // serial Storage worker is busy. Upload chunks consume the same credits.
    let (request_tx, request_rx) = mpsc::sync_channel::<(Value, Arc<AtomicBool>)>(KERNEL_REQUEST_WINDOW);
    let (response_tx, response_rx) = mpsc::sync_channel::<Value>(1);
    let cancellations = Arc::new(Mutex::new(HashMap::<String, ActiveRequest>::new()));
    let revoked_grants = Arc::new(Mutex::new(HashSet::<String>::new()));
    let admission_epoch = Arc::new(Mutex::new(None::<String>));
    let writer_failed = Arc::new(AtomicBool::new(false));
    let (native_tx, native_rx) = mpsc::sync_channel(KERNEL_REQUEST_WINDOW);
    let native_cancellations = cancellations.clone();
    let native_worker = crate::native_runtime::spawn(native_rx, response_tx.clone(), move |id| {
        if let Ok(mut active) = native_cancellations.lock() { active.remove(id); }
    });
    let worker_native_tx = native_tx.clone();
    let worker_cancellations = cancellations.clone();
    let worker_revoked_grants = revoked_grants.clone();
    let worker_admission_epoch = admission_epoch.clone();
    let worker_response_tx = response_tx.clone();
    let worker_writer_failed = writer_failed.clone();
    let worker = thread::spawn(move || {
        let mut kernel = Kernel::new();
        for (request, cancellation) in request_rx {
            let id = request
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_string);
            let grant_id = request
                .get("grantId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let revoked = grant_id.as_deref().is_some_and(|grant_id| {
                worker_revoked_grants
                    .lock()
                    .ok()
                    .is_some_and(|revoked| revoked.contains(grant_id))
            });
            let handled = if revoked {
                Err(KernelError::Authorization("grant is revoked".to_string()))
            } else {
                kernel.handle(&request, cancellation)
            };
            let response = match handled {
                Ok(Some(response)) => response,
                Ok(None) => {
                    worker_cancellations
                        .lock()
                        .ok()
                        .map(|mut active| active.remove(&id));
                    continue;
                }
                Err(error) => response_error(&id, &error),
            };
            if method.as_deref() == Some("kernel.handshake")
                && response.get("ok") == Some(&Value::Bool(true))
            {
                if let Some(epoch) = response
                    .get("result")
                    .and_then(Value::as_object)
                    .and_then(|result| result.get("kernelEpoch"))
                    .and_then(Value::as_str)
                {
                    if let Some(root) = kernel.storage_root.as_ref() {
                        if worker_native_tx.send(crate::native_runtime::Command::Initialize { root: root.clone(), epoch: epoch.to_string() }).is_err() { break; }
                    }
                    if let Ok(mut current) = worker_admission_epoch.lock() {
                        *current = Some(epoch.to_string());
                    }
                }
            }
            if method.as_deref() == Some("authority.grant.revoke") {
                let target = request
                    .get("params")
                    .and_then(Value::as_object)
                    .and_then(|params| params.get("grantId"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if response.get("ok") == Some(&Value::Bool(true)) {
                    mark_grant_revoked(&worker_revoked_grants, &worker_cancellations, target);
                } else if let Ok(mut revoked) = worker_revoked_grants.lock() {
                    revoked.remove(target);
                }
            }
            if method.as_deref() == Some("authority.grant.issue") {
                let target = request
                    .get("params")
                    .and_then(Value::as_object)
                    .and_then(|params| params.get("grantId"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if response.get("ok") == Some(&Value::Bool(true)) {
                    if let Ok(mut revoked) = worker_revoked_grants.lock() {
                        revoked.remove(target);
                    }
                }
            }
            let stopping = method.as_deref() == Some("kernel.shutdown");
            if worker_response_tx.send(response).is_err() {
                worker_writer_failed.store(true, Ordering::Release);
                break;
            }
            worker_cancellations
                .lock()
                .ok()
                .map(|mut active| active.remove(&id));
            if stopping {
                break;
            }
        }
    });
    let writer_failed_for_thread = writer_failed.clone();
    let writer = thread::spawn(move || {
        let stdout = io::stdout();
        let mut output = stdout.lock();
        for response in response_rx {
            if write_frame(&mut output, &response).is_err() {
                writer_failed_for_thread.store(true, Ordering::Release);
                // There is no safe way to drain stdin after stdout is gone:
                // the Host cannot receive any pending response. Exit the
                // process so it observes a real disconnect and can rebuild
                // the epoch instead of waiting forever.
                std::process::exit(1);
            }
        }
    });
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let payload = match read_frame(&mut input) {
            Ok(Some(payload)) => payload,
            Ok(None) => break,
            Err(error) => { eprintln!("kernel input disconnected: {error}"); break; }
        };
        if writer_failed.load(Ordering::Acquire) {
            break;
        }
        let request: Value = match serde_json::from_slice(&payload) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("invalid JSON frame: {error}");
                break;
            }
        };
        let id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if request.get("kind").and_then(Value::as_str) == Some("cancel") {
            let valid_envelope = request
                .as_object()
                .map(|fields| {
                    fields.keys().all(|field| {
                        matches!(field.as_str(), "v" | "kind" | "id" | "epoch" | "grantId")
                    })
                })
                .unwrap_or(false)
                && request.get("v").and_then(Value::as_u64) == Some(PROTOCOL_VERSION)
                && !id.is_empty();
            if !valid_envelope {
                continue;
            }
            let cancel_epoch = request.get("epoch").and_then(Value::as_str);
            let cancel_grant = request.get("grantId").and_then(Value::as_str);
            if let Ok(active) = cancellations.lock() {
                if let Some(request) = active.get(&id) {
                    if request.epoch.as_deref() == cancel_epoch
                        && request.grant_id.as_deref() == cancel_grant
                    {
                        request.token.store(true, Ordering::Release);
                    }
                }
            }
            continue;
        }
        if request.get("kind").and_then(Value::as_str) != Some("request") || id.is_empty() {
            eprintln!("invalid kernel request admission");
            break;
        }
        let token = Arc::new(AtomicBool::new(false));
        let request_epoch = request
            .get("epoch")
            .and_then(Value::as_str)
            .map(str::to_string);
        let request_grant = request
            .get("grantId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if request.get("method").and_then(Value::as_str) == Some("authority.grant.revoke") {
            let current_epoch = admission_epoch.lock().ok().and_then(|epoch| epoch.clone());
            if let Some(target) = admission_revoke_target(&request, current_epoch.as_deref()) {
                mark_grant_revoked(&revoked_grants, &cancellations, &target);
            }
        }
        if !id.is_empty() {
            if let Ok(mut active) = cancellations.lock() {
                if active.contains_key(&id) { eprintln!("duplicate in-flight request id"); break; }
                active.insert(
                    id,
                    ActiveRequest {
                        token: token.clone(),
                        epoch: request_epoch,
                        grant_id: request_grant,
                    },
                );
            }
        }
        if request.get("method").and_then(Value::as_str).is_some_and(|method|method.starts_with("runtime.")) {
            if native_tx.try_send(crate::native_runtime::Command::Request { value: request, cancellation: token }).is_err() {
                eprintln!("native runtime request admission window exceeded"); break;
            }
            continue;
        }
        if request_tx.try_send((request, token)).is_err() {
            // A sender violating the negotiated window loses this epoch, not
            // the cancellation/control channel. Never accept a silent drop.
            eprintln!("kernel request admission window exceeded");
            break;
        }
    }
    if let Ok(active) = cancellations.lock() {
        for request in active.values() { request.token.store(true, Ordering::Release); }
    }
    drop(request_tx);
    let _ = worker.join();
    drop(native_tx);
    let _ = native_worker.join();
    drop(response_tx);
    let _ = writer.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revoke_admission_requires_a_fully_valid_envelope() {
        let valid = json!({
            "v": PROTOCOL_VERSION,
            "kind": "request",
            "id": "revoke-request",
            "method": "authority.grant.revoke",
            "params": {"grantId": "actor"},
            "epoch": "epoch",
        });
        assert_eq!(
            admission_revoke_target(&valid, Some("epoch")).as_deref(),
            Some("actor")
        );
        let mut malformed = valid.clone();
        malformed["params"]["unexpected"] = Value::Bool(true);
        assert_eq!(admission_revoke_target(&malformed, Some("epoch")), None);
        let mut stale = valid;
        stale["epoch"] = Value::String("old".to_string());
        assert_eq!(admission_revoke_target(&stale, Some("epoch")), None);
    }
}
