use crate::error::{response_error, KernelError};
use crate::protocol::*;
use crate::protocol_generated::{KERNEL_REQUEST_WINDOW, KERNEL_RUNTIME_DATA_METHODS};
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

enum WorkerRequest {
    Wire(Value, Arc<AtomicBool>),
    Native(crate::native_tools::ResourceCall),
    ReplayProcessTerminals(Vec<String>),
    CaptureDone { request: Value, task: crate::storage::capture_resources::CaptureTask, result: Result<crate::storage::capture_resources::CapturedBatch, KernelError> },
    Stop,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WireLane { Storage, Native }

struct ActiveRequest {
    token: Arc<AtomicBool>,
    epoch: Option<String>,
    grant_id: Option<String>,
    native: Option<varin_runtime::execution::CancellationToken>,
    wire_lane: Option<WireLane>,
}

impl ActiveRequest {
    fn cancel(&self) {
        if let Some(native) = &self.native { native.cancel(); }
        else { self.token.store(true, Ordering::Release); }
    }
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
                request.cancel();
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
    capture_workers: Vec<(Arc<AtomicBool>, thread::JoinHandle<()>)>,
}

impl Drop for Kernel {
    fn drop(&mut self) {
        for (cancel, _) in &self.capture_workers { cancel.store(true, Ordering::Release); }
        for (_, worker) in self.capture_workers.drain(..) { let _ = worker.join(); }
    }
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
            capture_workers: Vec::new(),
        }
    }

    fn handle(
        &mut self,
        request: &Value,
        cancellation: Arc<AtomicBool>,
        completions: &mpsc::Sender<WorkerRequest>,
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
        if method == "file.captureBatch" {
            let task = storage.prepare_capture_batch(&authorized_params, &authorized_grant, cancellation.clone())?;
            let lease_id = task.lease_id().to_string();
            let request = request.clone();
            let completed = completions.clone();
            self.capture_workers.retain(|(_, worker)| !worker.is_finished());
            let spawned = thread::Builder::new().name("file-capture".into()).spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task.run()))
                    .unwrap_or_else(|_| Err(KernelError::Storage("capture worker panicked".into())));
                let _ = completed.send(WorkerRequest::CaptureDone { request, task, result });
            });
            match spawned {
                Ok(worker) => self.capture_workers.push((cancellation, worker)),
                Err(error) => { storage.finish_capture_lease(&lease_id); return Err(error.into()); }
            }
            return Ok(None);
        }
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
    let (request_tx, request_rx) = mpsc::channel::<WorkerRequest>();
    let (response_tx, response_rx) = mpsc::sync_channel::<Value>(1);
    let cancellations = Arc::new(Mutex::new(HashMap::<String, ActiveRequest>::new()));
    let revoked_grants = Arc::new(Mutex::new(HashSet::<String>::new()));
    let admission_epoch = Arc::new(Mutex::new(None::<String>));
    let credential_bridge = crate::credential_bridge::CredentialBridge::new(response_tx.clone());
    let mcp_bridge = crate::native_mcp::McpBridge::new(response_tx.clone());
    let memory_bridge = crate::native_memory_bridge::MemoryBridge::new(response_tx.clone());
    let language_bridge = crate::native_language::LanguageBridge::new(response_tx.clone());
    let retrieval_bridge = crate::native_retrieval::RetrievalBridge::new(response_tx.clone());
    let policy_bridge = crate::native_policy::PolicyBridge::new(response_tx.clone());
    let writer_failed = Arc::new(AtomicBool::new(false));
    let subscriptions=crate::process::subscriptions::ProcessSubscriptions::new(response_tx.clone());
    let (subscription_tx,subscription_rx)=mpsc::channel();
    let subscription_cancellations=cancellations.clone();
    let subscription_worker=crate::process::subscriptions::spawn_control(subscription_rx,subscriptions.clone(),admission_epoch.clone(),response_tx.clone(),move|id|{
        if let Ok(mut active)=subscription_cancellations.lock(){active.remove(id);}
    });
    let storage_subscriptions=subscriptions.clone();
    let (native_tx, native_rx) = mpsc::channel();
    let (process_terminals, terminal_rx) = mpsc::channel::<crate::process::ProcessTerminal>();
    let terminal_commands = native_tx.clone();
    thread::spawn(move || {
        for terminal in terminal_rx {
            if terminal_commands.send(crate::native_runtime::Command::ProcessTerminal(terminal)).is_err() { break; }
        }
    });
    let replay_requests = request_tx.clone();
    let native_cancellations = cancellations.clone();
    let resource_requests = request_tx.clone();
    let resource_cancellations = cancellations.clone();
    let resource_revoked = revoked_grants.clone();
    let resource_epoch = admission_epoch.clone();
    let process_controls = crate::process::ProcessControlRegistry::default();
    let resources = crate::native_tools::NativeResourceClient::new(move |call| {
        let epoch = resource_epoch.lock().map_err(|_| KernelError::Storage("admission identity lock poisoned".into()))?
            .clone().ok_or_else(|| KernelError::Authorization("kernel handshake required".into()))?;
        if resource_revoked.lock().map_err(|_| KernelError::Storage("revocation state lock poisoned".into()))?
            .contains(&call.binding.grant_id) {
            return Err(KernelError::Authorization("grant is revoked".into()));
        }
        let key = format!("native-resource:{}", Uuid::new_v4());
        resource_cancellations.lock().map_err(|_| KernelError::Storage("cancellation state lock poisoned".into()))?
            .insert(key.clone(), ActiveRequest { token:call.cancellation.shared_flag(), epoch:Some(epoch), grant_id:Some(call.binding.grant_id.clone()), native:Some(call.cancellation.clone()), wire_lane:None });
        // The actor clears this registration after the actual resource receipt, never on mere
        // cancellation request. Attach the key to the typed message, not to a JSON envelope.
        let mut call = call;
        call.admission_key = Some(key.clone());
        if resource_requests.send(WorkerRequest::Native(call)).is_err() {
            if let Ok(mut active) = resource_cancellations.lock() { active.remove(&key); }
            return Err(KernelError::Storage("resource authority stopped before admission".into()));
        }
        Ok(())
    }, move |ids| {
        if ids.is_empty() { return Ok(()); }
        replay_requests.send(WorkerRequest::ReplayProcessTerminals(ids))
            .map_err(|_| KernelError::Storage("resource authority stopped before receipt replay".into()))
    }, process_controls.clone());
    let native_control = crate::native_runtime::NativeControl::default();
    let native_worker = crate::native_runtime::spawn(native_rx, native_tx.clone(), native_control.clone(), resources, credential_bridge.clone(), mcp_bridge.clone(), language_bridge.clone(), memory_bridge.clone(), retrieval_bridge.clone(), policy_bridge.clone(), response_tx.clone(), move |id| {
        if let Ok(mut active) = native_cancellations.lock() { active.remove(id); }
    });
    let worker_native_tx = native_tx.clone();
    let worker_cancellations = cancellations.clone();
    let worker_revoked_grants = revoked_grants.clone();
    let worker_admission_epoch = admission_epoch.clone();
    let worker_credentials = credential_bridge.clone();
    let worker_mcp = mcp_bridge.clone();
    let worker_language = language_bridge.clone();
    let worker_memory = memory_bridge.clone();
    let worker_retrieval = retrieval_bridge.clone();
    let worker_policy = policy_bridge.clone();
    let worker_response_tx = response_tx.clone();
    let worker_writer_failed = writer_failed.clone();
    let capture_completions = request_tx.clone();
    let worker = thread::spawn(move || {
        let mut kernel = Kernel::new();
        for message in request_rx {
            let (request, cancellation) = match message {
                WorkerRequest::Wire(request, cancellation) => (request, cancellation),
                WorkerRequest::Stop => break,
                WorkerRequest::CaptureDone { request, task, result } => {
                    let id = request["id"].as_str().unwrap_or("");
                    let published = (|| {
                        let storage = kernel.storage.as_mut().ok_or_else(|| KernelError::Authorization("kernel stopped".into()))?;
                        let (grant, _) = storage.authorize(request["grantId"].as_str(), &kernel.epoch,
                            kernel.host_id.as_deref().unwrap_or(""), kernel.host_generation.as_deref().unwrap_or(""),
                            "file.captureBatch", &request["params"])?;
                        let denied = worker_revoked_grants.lock().map(|revoked| revoked.contains(&grant.grant_id)).unwrap_or(true);
                        if denied { return Err(KernelError::Authorization("grant is revoked".into())); }
                        storage.publish_capture_batch(&task, result?, &grant)
                    })();
                    if let Some(storage) = kernel.storage.as_mut() { storage.finish_capture_lease(task.lease_id()); }
                    worker_cancellations.lock().ok().map(|mut active| active.remove(id));
                    let response = match published { Ok(value) => response_ok(id, value), Err(error) => response_error(id, &error) };
                    if worker_response_tx.send(response).is_err() { break; }
                    continue;
                },
                WorkerRequest::ReplayProcessTerminals(ids) => {
                    let result = kernel.storage.as_ref().ok_or_else(|| KernelError::Authorization("kernel handshake required".into()))
                        .and_then(|storage| storage.replay_process_terminals(&ids));
                    if let Err(error) = result {
                        let _ = worker_native_tx.send(crate::native_runtime::Command::ProcessReplayFailed(error.to_string()));
                    }
                    continue;
                }
                WorkerRequest::Native(call) => {
                    let denied = worker_revoked_grants.lock().map(|revoked| revoked.contains(&call.binding.grant_id)).unwrap_or(true);
                    let result = if denied {
                        Err(crate::native_tools::ResourceFailure { error:KernelError::Authorization("grant is revoked".into()), dispatched:false })
                    } else if let (Some(storage), Some(host_id), Some(host_generation)) =
                        (kernel.storage.as_mut(), kernel.host_id.as_deref(), kernel.host_generation.as_deref()) {
                        crate::native_tools::serve_resource(storage, &kernel.epoch, host_id, host_generation, &call)
                    } else {
                        Err(crate::native_tools::ResourceFailure { error:KernelError::Authorization("kernel handshake required".into()), dispatched:false })
                    };
                    if let Some(key) = &call.admission_key {
                        if let Ok(mut active) = worker_cancellations.lock() { active.remove(key); }
                    }
                    let _ = call.reply.send(result);
                    continue;
                }
            };
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
                kernel.handle(&request, cancellation, &capture_completions)
            };
            let response = match handled {
                Ok(Some(response)) => response,
                Ok(None) => {
                    if method.as_deref() == Some("file.captureBatch") { continue; }
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
                    let _ = worker_credentials.initialize(epoch);
                    worker_mcp.initialize(epoch);
                    worker_language.initialize(epoch);
                    worker_memory.initialize(epoch);
                    worker_retrieval.initialize(epoch);
                    worker_policy.initialize(epoch);
                    if let Some(storage) = kernel.storage.as_mut() { storage.set_process_terminal_sender(process_terminals.clone()); storage.set_process_controls(process_controls.clone()); storage.set_process_subscriptions(storage_subscriptions.clone()); }
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
            // Retire execution ownership before its response becomes observable, so a client
            // using its returned credit cannot race a stale in-flight entry at admission.
            worker_cancellations.lock().ok().map(|mut active| active.remove(&id));
            if worker_response_tx.send(response).is_err() {
                worker_writer_failed.store(true, Ordering::Release);
                break;
            }
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
            let mut payload=match serde_json::to_vec(&response){Ok(payload)=>payload,Err(_)=>{writer_failed_for_thread.store(true,Ordering::Release);break;}};
            if payload.len()>MAX_FRAME_BYTES {
                // A large result is one failed read, not a broken shared transport. Transient
                // streams can lose an update; their sequence/cursor lets the Host resynchronize.
                if response.get("kind").and_then(Value::as_str)==Some("runtime-event") && response.get("stream").and_then(Value::as_str)==Some("progress") {continue;}
                if let Some(id)=response.get("id").and_then(Value::as_str).filter(|_|response.get("kind").and_then(Value::as_str)==Some("response")) {
                    let failure=response_error(id,&KernelError::Operation("response exceeds the transport frame limit; use paged history/content reads".into()));
                    payload=serde_json::to_vec(&failure).expect("response error is JSON");
                }
            }
            if write_encoded_frame(&mut output, &payload).is_err() {
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
        // Private secret-bearing replies must never enter method validation, durable queues,
        // public tool grants, or diagnostic formatting. Malformed/old replies are discarded.
        if request.get("kind").and_then(Value::as_str) == Some("agent-policy-response") {
            policy_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("retrieval-response") {
            retrieval_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("memory-response") {
            memory_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("language-response") {
            language_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("mcp-tool-response") {
            mcp_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("credential-response") {
            credential_bridge.receive(request);
            continue;
        }
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
                        request.cancel();
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
                subscriptions.close_grant(&target);
                mark_grant_revoked(&revoked_grants, &cancellations, &target);
            }
        }
        let wire_lane = if request.get("method").and_then(Value::as_str).is_some_and(|method| (method.starts_with("runtime.") && !KERNEL_RUNTIME_DATA_METHODS.contains(&method)) || method.starts_with("process.subscription.")) {
            WireLane::Native
        } else { WireLane::Storage };
        if !id.is_empty() {
            if let Ok(mut active) = cancellations.lock() {
                if active.contains_key(&id) { eprintln!("duplicate in-flight request id"); break; }
                if active.values().filter(|request| request.wire_lane == Some(wire_lane)).count() >= KERNEL_REQUEST_WINDOW {
                    eprintln!("kernel external request admission window exceeded"); break;
                }
                active.insert(
                    id,
                    ActiveRequest {
                        token: token.clone(),
                        epoch: request_epoch,
                        grant_id: request_grant,
                        native: None,
                        wire_lane: Some(wire_lane),
                    },
                );
            }
        }
        if request.get("method").and_then(Value::as_str).is_some_and(|method|method.starts_with("process.subscription.")) {
            if subscription_tx.send(crate::process::subscriptions::ControlCommand::Request{value:request,cancellation:token}).is_err(){break;}
            continue;
        }
        if request.get("method").and_then(Value::as_str).is_some_and(|method|method.starts_with("runtime.")) {
            let current_epoch=admission_epoch.lock().ok().and_then(|epoch|epoch.clone());
            let cancellation_request = request.get("method").and_then(Value::as_str)
                .filter(|method| matches!(*method,"runtime.run.cancel"|"runtime.operation.cancel"))
                .map(|_|request.clone());
            // Enqueue the intent before fast OS control. A resulting terminal fact can then
            // never overtake its cancel command in the native owner's FIFO and lose causality.
            if native_tx.send(crate::native_runtime::Command::Request { value: request, cancellation: token }).is_err() {
                eprintln!("native runtime control authority disconnected"); break;
            }
            if let Some(request)=cancellation_request { native_control.cancel_admitted(&request,current_epoch.as_deref()); }
            continue;
        }
        if request_tx.send(WorkerRequest::Wire(request, token)).is_err() {
            // External credits were validated before enqueue. Internal resource/replay work
            // uses the same typed authority queue without consuming those wire credits.
            eprintln!("kernel resource authority disconnected");
            break;
        }
    }
    if let Ok(active) = cancellations.lock() {
        for request in active.values() { request.cancel(); }
    }
    credential_bridge.close();
    mcp_bridge.close();
    language_bridge.close();
    memory_bridge.close();
    retrieval_bridge.close();
    policy_bridge.close();
    subscriptions.shutdown();
    let _=subscription_tx.send(crate::process::subscriptions::ControlCommand::Stop);
    drop(subscription_tx);
    let _=subscription_worker.join();
    // Native run workers retain a resource sender. Explicitly stop the owner rather than
    // waiting for all senders to drop, which would create a shutdown channel cycle.
    let _ = request_tx.send(WorkerRequest::Stop);
    drop(request_tx);
    let _ = worker.join();
    let _ = native_tx.send(crate::native_runtime::Command::Stop);
    drop(native_tx);
    let _ = native_worker.join();
    drop(subscriptions);
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
