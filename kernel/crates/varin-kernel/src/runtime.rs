use crate::error::{response_error, KernelError};
use crate::protocol::*;
use crate::protocol_generated::KERNEL_REQUEST_WINDOW;
use crate::storage::materialization::{
    Admission as MaterializationAdmission, Control as MaterializationControl,
    Controlled as MaterializationControlled, Task as MaterializationTask,
};
use crate::storage::Storage;
use crate::transport::{Incoming, Lane};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use uuid::Uuid;

enum MaterializationReply {
    Direct(Value),
    Reconcile(Value),
    RootRegistration(String),
}

struct PendingRootRegistration {
    response: Value,
    remaining: usize,
}

enum WorkerRequest {
    Wire(Value, Arc<AtomicBool>),
    Resource(crate::tools::ResourceCall),
    ReplayProcessTerminals(Vec<String>),
    IntegrationReceipt(crate::tools::IntegrationReceiptRead),
    ResultPublicationDone {
        request: Value,
        task: Arc<crate::storage::result_publication::ResultPublicationTask>,
        result: Result<crate::storage::result_publication::PreparedWorkingResult, KernelError>,
    },
    CaptureDone {
        request: Value,
        task: crate::storage::capture_resources::CaptureTask,
        result: Result<crate::storage::capture_resources::CapturedBatch, KernelError>,
    },
    MaterializationControl {
        operation_id: String,
        job_id: String,
        grant_id: String,
        control: MaterializationControl,
        reply: mpsc::Sender<Result<MaterializationControlled, KernelError>>,
    },
    MaterializationDone {
        operation_id: String,
        job_id: String,
        reply: MaterializationReply,
        result: Result<Value, KernelError>,
    },
    Stop,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WireLane {
    Control,
    Data,
}

struct ActiveRequest {
    token: Arc<AtomicBool>,
    epoch: Option<String>,
    grant_id: Option<String>,
    runtime_cancel: Option<varin_runtime::execution::CancellationToken>,
    input_order: Option<varin_runtime::resource_admission::ResourceReservation>,
    wire_lane: Option<WireLane>,
    pending_body: bool,
    body_cancel_receipt: bool,
}

impl ActiveRequest {
    fn cancel(&self) {
        if let Some(cancel) = &self.runtime_cancel {
            cancel.cancel();
        } else {
            self.token.store(true, Ordering::Release);
        }
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
    file_workers: Vec<(Arc<AtomicBool>, thread::JoinHandle<()>)>,
    pending_root_registrations: HashMap<String, PendingRootRegistration>,
    active_materializations: usize,
    agent_control: crate::agent_runtime::AgentControl,
}

impl Drop for Kernel {
    fn drop(&mut self) {
        for (cancel, _) in &self.file_workers {
            cancel.store(true, Ordering::Release);
        }
        for (_, worker) in self.file_workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Kernel {
    fn new(epoch: String) -> Self {
        Self {
            epoch,
            host_id: None,
            host_generation: None,
            build_version: None,
            storage_root: None,
            storage: None,
            handshaken: false,
            file_workers: Vec::new(),
            pending_root_registrations: HashMap::new(),
            active_materializations: 0,
            agent_control: crate::agent_runtime::AgentControl::default(),
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
            for (cancel, _) in &self.file_workers {
                cancel.store(true, Ordering::Release);
            }
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
        if method == "source.handoff.claim" {
            if grant_id.is_some(){return Err(KernelError::Authorization("source claim requires current Host authority".into()));}
            let handoff=self.agent_control.child_handoff(&params_value)?;
            let identity=storage.root().to_string_lossy().to_string();
            return Ok(Some(response_ok(id,storage.claim_child_handoff(&params_value,&handoff,host_id,
                self.host_generation.as_deref().unwrap_or_default(),&identity,&self.epoch)?)));
        }
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
        if method == "working.result.publish" {
            use crate::storage::result_publication::ResultPublicationAdmission;
            match storage.prepare_result_publication(&authorized_params,&authorized_grant.grant_id,cancellation.clone())? {
                ResultPublicationAdmission::Complete(value)=>return Ok(Some(response_ok(id,value))),
                ResultPublicationAdmission::Work(task)=>{
                    let task=Arc::new(task);
                    let work=task.clone(); let request=request.clone(); let completed=completions.clone();
                    let spawned=thread::Builder::new().name("result-publication".into()).spawn(move||{
                        let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||work.run()))
                            .unwrap_or_else(|_|Err(KernelError::Storage("result publication worker panicked".into())));
                        let _=completed.send(WorkerRequest::ResultPublicationDone {request,task:work,result});
                    });
                    match spawned {Ok(worker)=>self.file_workers.push((cancellation,worker)),Err(error)=>{storage.release_result_publication_worker(&task);return Err(error.into());}}
                    return Ok(None);
                }
            }
        }
        if method == "file.captureBatch" {
            let task = storage.prepare_capture_batch(
                &authorized_params,
                &authorized_grant,
                cancellation.clone(),
            )?;
            let lease_id = task.lease_id().to_string();
            let request = request.clone();
            let completed = completions.clone();
            self.file_workers
                .retain(|(_, worker)| !worker.is_finished());
            let spawned = thread::Builder::new()
                .name("file-capture".into())
                .spawn(move || {
                    let result =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task.run()))
                            .unwrap_or_else(|_| {
                                Err(KernelError::Storage("capture worker panicked".into()))
                            });
                    let _ = completed.send(WorkerRequest::CaptureDone {
                        request,
                        task,
                        result,
                    });
                });
            match spawned {
                Ok(worker) => self.file_workers.push((cancellation, worker)),
                Err(error) => {
                    storage.finish_retained_file_lease(&lease_id);
                    return Err(error.into());
                }
            }
            return Ok(None);
        }
        if method == "file.materialize" {
            match storage.prepare_materialization(
                &authorized_params,
                &authorized_grant,
                cancellation.clone(),
            )? {
                MaterializationAdmission::Complete(result) => {
                    return Ok(Some(response_ok(id, result)))
                }
                MaterializationAdmission::Work(task) => {
                    self.spawn_materialization(
                        task,
                        MaterializationReply::Direct(request.clone()),
                        authorized_grant.grant_id,
                        cancellation,
                        completions,
                    )?;
                    return Ok(None);
                }
            }
        }
        if method == "file.operation.reconcile" {
            let pending = storage.pending_materializations(
                authorized_params["rootId"].as_str().unwrap_or(""),
                authorized_params["workspaceId"].as_str().unwrap_or(""),
                authorized_params["operationId"].as_str(),
            )?;
            if let Some(intent) = pending.first() {
                match storage.prepare_materialization(
                    intent,
                    &authorized_grant,
                    cancellation.clone(),
                )? {
                    MaterializationAdmission::Work(task) => {
                        self.spawn_materialization(
                            task,
                            MaterializationReply::Reconcile(request.clone()),
                            authorized_grant.grant_id,
                            cancellation,
                            completions,
                        )?;
                        return Ok(None);
                    }
                    MaterializationAdmission::Complete(_) => {}
                }
            }
        }
        if method == "file.root.register" {
            storage.set_cancellation(cancellation.clone());
            let registered =
                storage.dispatch(method, &authorized_params, grant_id, &authorized_grant);
            storage.clear_cancellation();
            let result = registered?;
            let intents = storage.pending_materializations(
                result["rootId"].as_str().unwrap_or(""),
                authorized_params["workspaceId"].as_str().unwrap_or(""),
                None,
            )?;
            let mut tasks = Vec::new();
            for intent in intents {
                // Busy or unadmitted journals remain explicit pending work.
                if let Ok(MaterializationAdmission::Work(task)) = storage.prepare_materialization(
                    &intent,
                    &authorized_grant,
                    cancellation.clone(),
                ) {
                    tasks.push(task);
                }
            }
            if tasks.is_empty() {
                return Ok(Some(response_ok(id, result)));
            }
            self.pending_root_registrations.insert(
                id.to_string(),
                PendingRootRegistration {
                    response: response_ok(id, result),
                    remaining: tasks.len(),
                },
            );
            for task in tasks {
                if let Err(_) = self.spawn_materialization(
                    task,
                    MaterializationReply::RootRegistration(id.to_string()),
                    authorized_grant.grant_id.clone(),
                    cancellation.clone(),
                    completions,
                ) {
                    self.pending_root_registrations
                        .get_mut(id)
                        .expect("root registration")
                        .remaining -= 1;
                }
            }
            if self.pending_root_registrations[id].remaining == 0 {
                return Ok(Some(
                    self.pending_root_registrations
                        .remove(id)
                        .expect("root registration")
                        .response,
                ));
            }
            return Ok(None);
        }
        storage.set_cancellation(cancellation);
        let result = storage.dispatch(method, &authorized_params, grant_id, &authorized_grant);
        storage.clear_cancellation();
        Ok(Some(response_ok(id, result?)))
    }

    fn spawn_materialization(
        &mut self,
        task: MaterializationTask,
        reply: MaterializationReply,
        grant_id: String,
        cancellation: Arc<AtomicBool>,
        completions: &mpsc::Sender<WorkerRequest>,
    ) -> Result<(), KernelError> {
        let operation_id = task.operation_id.clone();
        let job_id = task.job_id.clone();
        let completed = completions.clone();
        self.file_workers
            .retain(|(_, worker)| !worker.is_finished());
        let spawned = thread::Builder::new()
            .name("file-materialization".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    task.run(|control| {
                        let (reply, receive) = mpsc::channel();
                        completed
                            .send(WorkerRequest::MaterializationControl {
                                operation_id: task.operation_id.clone(),
                                job_id: task.job_id.clone(),
                                grant_id: grant_id.clone(),
                                control,
                                reply,
                            })
                            .map_err(|_| {
                                KernelError::Storage("materialization owner stopped".into())
                            })?;
                        receive.recv().map_err(|_| {
                            KernelError::Storage("materialization owner stopped".into())
                        })?
                    })
                }))
                .unwrap_or_else(|_| {
                    Err(KernelError::Storage(
                        "materialization worker panicked".into(),
                    ))
                });
                let _ = completed.send(WorkerRequest::MaterializationDone {
                    operation_id: task.operation_id,
                    job_id: task.job_id,
                    reply,
                    result,
                });
            });
        match spawned {
            Ok(worker) => {
                self.file_workers.push((cancellation, worker));
                self.active_materializations += 1;
                Ok(())
            }
            Err(error) => {
                if let Some(storage) = self.storage.as_mut() {
                    storage.finish_materialization(&operation_id, &job_id);
                }
                Err(error.into())
            }
        }
    }
}

pub(crate) fn run() -> Result<(), Box<dyn std::error::Error>> {
    let transport = crate::transport::Transport::bootstrap()?;
    let transport_epoch = transport.epoch.clone();
    let (request_tx, request_rx) = mpsc::channel::<WorkerRequest>();
    let response_tx = transport.sender.clone();
    let cancellations = Arc::new(Mutex::new(HashMap::<String, ActiveRequest>::new()));
    let revoked_grants = Arc::new(Mutex::new(HashSet::<String>::new()));
    let admission_epoch = Arc::new(Mutex::new(None::<String>));
    let credential_bridge = crate::credential_bridge::CredentialBridge::new(response_tx.clone());
    let mcp_bridge = crate::host_tools::ToolBridge::new(response_tx.clone());
    let memory_bridge = crate::host_query::OwnerChannel::new("memory", response_tx.clone());
    let context_bridge = crate::host_query::OwnerChannel::new("context", response_tx.clone());
    let resource_bridge = crate::host_query::OwnerChannel::new("resource", response_tx.clone());
    let plan_bridge = crate::plan_bridge::PlanBridge::new(response_tx.clone());
    let language_bridge = crate::language::LanguageBridge::new(response_tx.clone());
    let retrieval_bridge = crate::retrieval::RetrievalBridge::new(response_tx.clone());
    let policy_bridge = crate::policy::PolicyBridge::new(response_tx.clone());
    let writer_failed = Arc::new(AtomicBool::new(false));
    let subscriptions =
        crate::process::subscriptions::ProcessSubscriptions::new(response_tx.clone());
    let (subscription_tx, subscription_rx) = mpsc::channel();
    let subscription_cancellations = cancellations.clone();
    let subscription_worker = crate::process::subscriptions::spawn_control(
        subscription_rx,
        subscriptions.clone(),
        admission_epoch.clone(),
        response_tx.clone(),
        move |id| {
            if let Ok(mut active) = subscription_cancellations.lock() {
                active.remove(id);
            }
        },
    );
    let storage_subscriptions = subscriptions.clone();
    let (agent_tx, agent_rx) = mpsc::channel();
    let (process_terminals, terminal_rx) = mpsc::channel::<crate::process::ProcessTerminal>();
    let terminal_commands = agent_tx.clone();
    thread::spawn(move || {
        for terminal in terminal_rx {
            if terminal_commands
                .send(crate::agent_runtime::Command::ProcessTerminal(terminal))
                .is_err()
            {
                break;
            }
        }
    });
    let integration_requests=request_tx.clone();
    let replay_requests = request_tx.clone();
    let agent_cancellations = cancellations.clone();
    let resource_requests = request_tx.clone();
    let resource_cancellations = cancellations.clone();
    let resource_revoked = revoked_grants.clone();
    let resource_epoch = admission_epoch.clone();
    let queue_admission_epoch = admission_epoch.clone();
    let admission_revoked = revoked_grants.clone();
    let admission_cancellations = cancellations.clone();
    let process_controls = crate::process::ProcessControlRegistry::default();
    let resources = crate::tools::KernelResourceClient::new(
        move |call| {
            let epoch = resource_epoch
                .lock()
                .map_err(|_| KernelError::Storage("admission identity lock poisoned".into()))?
                .clone()
                .ok_or_else(|| KernelError::Authorization("kernel handshake required".into()))?;
            if resource_revoked
                .lock()
                .map_err(|_| KernelError::Storage("revocation state lock poisoned".into()))?
                .contains(&call.binding.grant_id)
            {
                return Err(KernelError::Authorization("grant is revoked".into()));
            }
            let key = format!("resource:{}", Uuid::new_v4());
            resource_cancellations
                .lock()
                .map_err(|_| KernelError::Storage("cancellation state lock poisoned".into()))?
                .insert(
                    key.clone(),
                    ActiveRequest {
                        token: call.cancellation.shared_flag(),
                        epoch: Some(epoch),
                        grant_id: Some(call.binding.grant_id.clone()),
                        runtime_cancel: Some(call.cancellation.clone()),
                        input_order: None,
                        wire_lane: None,
                        pending_body: false,
                        body_cancel_receipt: false,
                    },
                );
            // The actor clears this registration after the actual resource receipt, never on mere
            // cancellation request. Attach the key to the typed message, not to a JSON envelope.
            let mut call = call;
            call.admission_key = Some(key.clone());
            if resource_requests
                .send(WorkerRequest::Resource(call))
                .is_err()
            {
                if let Ok(mut active) = resource_cancellations.lock() {
                    active.remove(&key);
                }
                return Err(KernelError::Storage(
                    "resource authority stopped before admission".into(),
                ));
            }
            Ok(())
        },
        move |ids| {
            if ids.is_empty() {
                return Ok(());
            }
            replay_requests
                .send(WorkerRequest::ReplayProcessTerminals(ids))
                .map_err(|_| {
                    KernelError::Storage("resource authority stopped before receipt replay".into())
                })
        },
        process_controls.clone(),
    )
    .with_integration_receipts(move |read|integration_requests.send(WorkerRequest::IntegrationReceipt(read)).map_err(|_|KernelError::Storage("Storage journal owner stopped".into())))
    .with_admission_control(move |binding, cancel| {
        use varin_runtime::{execution::ExecutionError, execution_capacity::AdmissionControlGuard};
        let failed =
            || ExecutionError::new("admission_control", "capability control is unavailable");
        let epoch = queue_admission_epoch
            .lock()
            .map_err(|_| failed())?
            .clone()
            .ok_or_else(|| ExecutionError::new("admission_control", "kernel handshake required"))?;
        // Registration and the revoke fence share the existing owner lock order. A revoke cannot
        // fall between checking the grant and publishing this queue-lifetime cancellation token.
        let revoked = admission_revoked.lock().map_err(|_| failed())?;
        if revoked.contains(&binding.grant_id) {
            cancel.cancel();
            return Ok(AdmissionControlGuard::new(|| {}));
        }
        let key = format!("admission:{}", Uuid::new_v4());
        admission_cancellations
            .lock()
            .map_err(|_| failed())?
            .insert(
                key.clone(),
                ActiveRequest {
                    token: cancel.shared_flag(),
                    epoch: Some(epoch),
                    grant_id: Some(binding.grant_id.clone()),
                    runtime_cancel: Some(cancel.clone()),
                    input_order: None,
                    wire_lane: None,
                    pending_body: false,
                    body_cancel_receipt: false,
                },
            );
        drop(revoked);
        let active = admission_cancellations.clone();
        Ok(AdmissionControlGuard::new(move || {
            if let Ok(mut active) = active.lock() {
                active.remove(&key);
            }
        }))
    });
    let agent_control = crate::agent_runtime::AgentControl::default();
    let agent_worker = crate::agent_runtime::spawn(
        agent_rx,
        agent_tx.clone(),
        agent_control.clone(),
        resources,
        credential_bridge.clone(),
        mcp_bridge.clone(),
        language_bridge.clone(),
        memory_bridge.clone(),
        context_bridge.clone(),
        resource_bridge.clone(),
        plan_bridge.clone(),
        retrieval_bridge.clone(),
        policy_bridge.clone(),
        response_tx.clone(),
        move |id| {
            if let Ok(mut active) = agent_cancellations.lock() {
                active.remove(id);
            }
        },
    );
    let worker_agent_control = agent_control.clone();
    let worker_agent_tx = agent_tx.clone();
    let worker_cancellations = cancellations.clone();
    let worker_revoked_grants = revoked_grants.clone();
    let worker_admission_epoch = admission_epoch.clone();
    let worker_credentials = credential_bridge.clone();
    let worker_mcp = mcp_bridge.clone();
    let worker_language = language_bridge.clone();
    let worker_memory = memory_bridge.clone();
    let worker_context = context_bridge.clone();
    let worker_resource = resource_bridge.clone();
    let worker_plan = plan_bridge.clone();
    let worker_retrieval = retrieval_bridge.clone();
    let worker_policy = policy_bridge.clone();
    let worker_response_tx = response_tx.clone();
    let worker_writer_failed = writer_failed.clone();
    let capture_completions = request_tx.clone();
    let worker = thread::spawn(move || {
        let mut kernel = Kernel::new(transport_epoch);
        kernel.agent_control = worker_agent_control;
        let mut stopping = false;
        for message in request_rx {
            if stopping && kernel.active_materializations == 0 {
                break;
            }
            let (request, cancellation) = match message {
                WorkerRequest::Wire(request, cancellation) => (request, cancellation),
                WorkerRequest::Stop => {
                    stopping = true;
                    for (cancel, _) in &kernel.file_workers {
                        cancel.store(true, Ordering::Release);
                    }
                    if kernel.active_materializations == 0 {
                        break;
                    }
                    continue;
                }
                WorkerRequest::MaterializationControl {
                    operation_id,
                    job_id,
                    grant_id,
                    control,
                    reply,
                } => {
                    let denied = worker_revoked_grants
                        .lock()
                        .map(|revoked| revoked.contains(&grant_id))
                        .unwrap_or(true);
                    let result = kernel
                        .storage
                        .as_mut()
                        .ok_or_else(|| KernelError::Storage("kernel stopped".into()))
                        .and_then(|storage| {
                            storage.control_materialization(&operation_id, &job_id, control, denied)
                        });
                    let _ = reply.send(result);
                    continue;
                }
                WorkerRequest::MaterializationDone {
                    operation_id,
                    job_id,
                    reply,
                    result,
                } => {
                    if let Some(storage) = kernel.storage.as_mut() {
                        storage.finish_materialization(&operation_id, &job_id);
                    }
                    kernel.active_materializations -= 1;
                    let response = match reply {
                        MaterializationReply::Direct(request)
                        | MaterializationReply::Reconcile(request) => {
                            let id = request["id"].as_str().unwrap_or("");
                            worker_cancellations
                                .lock()
                                .ok()
                                .map(|mut active| active.remove(id));
                            let result = if request["method"] == "file.operation.reconcile" {
                                result.map(|result| json!({"status":"reconciled","operationId":operation_id,"kind":"file.materialize","result":result}))
                            } else {
                                result
                            };
                            Some(match result {
                                Ok(result) => response_ok(id, result),
                                Err(error) => response_error(id, &error),
                            })
                        }
                        MaterializationReply::RootRegistration(id) => {
                            let pending = kernel
                                .pending_root_registrations
                                .get_mut(&id)
                                .expect("root registration");
                            pending.remaining -= 1;
                            if result.is_ok() {
                                let result = &mut pending.response["result"];
                                result["reconciledOperations"] =
                                    json!(result["reconciledOperations"].as_u64().unwrap_or(0) + 1);
                                result["pendingOperations"] = json!(result["pendingOperations"]
                                    .as_u64()
                                    .unwrap_or(0)
                                    .saturating_sub(1));
                            }
                            if pending.remaining == 0 {
                                worker_cancellations
                                    .lock()
                                    .ok()
                                    .map(|mut active| active.remove(&id));
                                Some(
                                    kernel
                                        .pending_root_registrations
                                        .remove(&id)
                                        .expect("root registration")
                                        .response,
                                )
                            } else {
                                None
                            }
                        }
                    };
                    if let Some(response) = response {
                        if worker_response_tx.send(response).is_err() {
                            break;
                        }
                    }
                    if stopping && kernel.active_materializations == 0 {
                        break;
                    }
                    continue;
                }
                WorkerRequest::ResultPublicationDone {request,task,result}=>{
                    let id=request["id"].as_str().unwrap_or("");
                    let published=(||{
                        let storage=kernel.storage.as_mut().ok_or_else(||KernelError::Authorization("kernel stopped".into()))?;
                        let (grant,_)=storage.authorize(request["grantId"].as_str(),&kernel.epoch,
                            kernel.host_id.as_deref().unwrap_or(""),kernel.host_generation.as_deref().unwrap_or(""),
                            "working.result.publish",&request["params"])?;
                        if worker_revoked_grants.lock().map(|revoked|revoked.contains(&grant.grant_id)).unwrap_or(true) {
                            return Err(KernelError::Authorization("grant is revoked".into()));
                        }
                        storage.finish_result_publication(&task,result?,&grant.grant_id)
                    })();
                    if let Some(storage)=kernel.storage.as_mut(){storage.release_result_publication_worker(&task);}
                    worker_cancellations.lock().ok().map(|mut active|active.remove(id));
                    let response=match published {Ok(value)=>response_ok(id,value),Err(error)=>response_error(id,&error)};
                    if worker_response_tx.send(response).is_err(){break;}
                    continue;
                }
                WorkerRequest::CaptureDone {
                    request,
                    task,
                    result,
                } => {
                    let id = request["id"].as_str().unwrap_or("");
                    let published = (|| {
                        let storage = kernel
                            .storage
                            .as_mut()
                            .ok_or_else(|| KernelError::Authorization("kernel stopped".into()))?;
                        let (grant, _) = storage.authorize(
                            request["grantId"].as_str(),
                            &kernel.epoch,
                            kernel.host_id.as_deref().unwrap_or(""),
                            kernel.host_generation.as_deref().unwrap_or(""),
                            "file.captureBatch",
                            &request["params"],
                        )?;
                        let denied = worker_revoked_grants
                            .lock()
                            .map(|revoked| revoked.contains(&grant.grant_id))
                            .unwrap_or(true);
                        if denied {
                            return Err(KernelError::Authorization("grant is revoked".into()));
                        }
                        storage.publish_capture_batch(&task, result?, &grant)
                    })();
                    if let Some(storage) = kernel.storage.as_mut() {
                        storage.finish_retained_file_lease(task.lease_id());
                    }
                    worker_cancellations
                        .lock()
                        .ok()
                        .map(|mut active| active.remove(id));
                    let response = match published {
                        Ok(value) => response_ok(id, value),
                        Err(error) => response_error(id, &error),
                    };
                    if worker_response_tx.send(response).is_err() {
                        break;
                    }
                    continue;
                }
                WorkerRequest::IntegrationReceipt(read)=>{
                    let result=kernel.storage.as_ref().ok_or_else(||KernelError::Storage("Storage not ready".into())).and_then(|storage|storage.integration_receipt(&read));
                    let _=read.reply.send(result);continue;
                }
                WorkerRequest::ReplayProcessTerminals(ids) => {
                    let result = kernel
                        .storage
                        .as_ref()
                        .ok_or_else(|| {
                            KernelError::Authorization("kernel handshake required".into())
                        })
                        .and_then(|storage| storage.replay_process_terminals(&ids));
                    if let Err(error) = result {
                        let _ = worker_agent_tx.send(
                            crate::agent_runtime::Command::ProcessReplayFailed(error.to_string()),
                        );
                    }
                    continue;
                }
                WorkerRequest::Resource(call) => {
                    let denied = worker_revoked_grants
                        .lock()
                        .map(|revoked| revoked.contains(&call.binding.grant_id))
                        .unwrap_or(true);
                    let result = if stopping {
                        Err(crate::tools::ResourceFailure {
                            error: KernelError::Operation("kernel is stopping".into()),
                            dispatched: false,
                        })
                    } else if denied {
                        Err(crate::tools::ResourceFailure {
                            error: KernelError::Authorization("grant is revoked".into()),
                            dispatched: false,
                        })
                    } else if let (Some(storage), Some(host_id), Some(host_generation)) = (
                        kernel.storage.as_mut(),
                        kernel.host_id.as_deref(),
                        kernel.host_generation.as_deref(),
                    ) {
                        crate::tools::serve_resource(
                            storage,
                            &kernel.epoch,
                            host_id,
                            host_generation,
                            &call,
                        )
                    } else {
                        Err(crate::tools::ResourceFailure {
                            error: KernelError::Authorization("kernel handshake required".into()),
                            dispatched: false,
                        })
                    };
                    if let Some(key) = &call.admission_key {
                        if let Ok(mut active) = worker_cancellations.lock() {
                            active.remove(key);
                        }
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
            let handled = if stopping {
                Err(KernelError::Operation("kernel is stopping".into()))
            } else if revoked {
                Err(KernelError::Authorization("grant is revoked".to_string()))
            } else {
                kernel.handle(&request, cancellation, &capture_completions)
            };
            let response = match handled {
                Ok(Some(response)) => response,
                Ok(None) => {
                    if method.as_deref().is_some_and(|method| {
                        matches!(
                            method,
                            "file.captureBatch"
                                | "working.result.publish"
                                | "file.materialize"
                                | "file.root.register"
                                | "file.operation.reconcile"
                        )
                    }) {
                        continue;
                    }
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
                    worker_context.initialize(epoch);
                    worker_resource.initialize(epoch);
                    worker_plan.initialize(epoch);
                    worker_retrieval.initialize(epoch);
                    worker_policy.initialize(epoch);
                    if let Some(storage) = kernel.storage.as_mut() {
                        storage.set_process_terminal_sender(process_terminals.clone());
                        storage.set_process_controls(process_controls.clone());
                        storage.set_process_subscriptions(storage_subscriptions.clone());
                    }
                    if let Some(root) = kernel.storage_root.as_ref() {
                        if worker_agent_tx
                            .send(crate::agent_runtime::Command::Initialize {
                                root: root.clone(),
                                epoch: epoch.to_string(),
                            })
                            .is_err()
                        {
                            break;
                        }
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
            let shutdown = method.as_deref() == Some("kernel.shutdown");
            // Retire execution ownership before its response becomes observable, so a client
            // using its returned credit cannot race a stale in-flight entry at admission.
            worker_cancellations
                .lock()
                .ok()
                .map(|mut active| active.remove(&id));
            if worker_response_tx.send(response).is_err() {
                worker_writer_failed.store(true, Ordering::Release);
                break;
            }
            if shutdown {
                stopping = true;
                if kernel.active_materializations == 0 {
                    break;
                }
            }
        }
    });
    for incoming in &transport.incoming {
        let (request, lane) = match incoming {
            Incoming::Disconnected => break,
            Incoming::Abort(meta) => {
                if meta["kind"] == "request" {
                    let id = meta["id"].as_str().unwrap_or_default();
                    let acknowledged = cancellations
                        .lock()
                        .ok()
                        .and_then(|mut active| active.remove(id))
                        .is_some_and(|request| request.body_cancel_receipt);
                    if !acknowledged {
                        let _ =
                            response_tx.send_control(response_error(id, &KernelError::Cancelled));
                    }
                }
                continue;
            }
            Incoming::Open(meta) => {
                let id = meta["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("stream request identity required")?;
                let grant_id = meta["grantId"].as_str().map(str::to_string);
                let revoked = grant_id.as_ref().is_some_and(|grant| {
                    revoked_grants
                        .lock()
                        .map(|grants| grants.contains(grant))
                        .unwrap_or(true)
                });
                let cancel = varin_runtime::execution::CancellationToken::default();
                if revoked {
                    cancel.cancel();
                }
                let epoch = admission_epoch
                    .lock()
                    .map_err(|_| "admission epoch poisoned")?
                    .clone();
                // Arrival belongs to the authenticated control offer, before JSON encoding,
                // content upload or hydration can make a later small input overtake it.
                let input_order = agent_control.reserve_input(&meta, epoch.as_deref(), &cancel)?;
                let mut active = cancellations
                    .lock()
                    .map_err(|_| "cancellation owner poisoned")?;
                if active.contains_key(id)
                    || active
                        .values()
                        .filter(|request| request.wire_lane == Some(WireLane::Data))
                        .count()
                        >= KERNEL_REQUEST_WINDOW
                {
                    eprintln!("invalid content request admission");
                    break;
                }
                active.insert(
                    id.to_string(),
                    ActiveRequest {
                        token: cancel.shared_flag(),
                        epoch: meta["epoch"].as_str().map(str::to_string),
                        grant_id,
                        runtime_cancel: Some(cancel),
                        input_order,
                        wire_lane: Some(WireLane::Data),
                        pending_body: true,
                        body_cancel_receipt: false,
                    },
                );
                continue;
            }
            Incoming::Frame(request, lane) => (request, lane),
        };
        if writer_failed.load(Ordering::Acquire) {
            break;
        }
        // Private secret-bearing replies must never enter method validation, durable queues,
        // public tool grants, or diagnostic formatting. Malformed/old replies are discarded.
        if matches!(
            request.get("kind").and_then(Value::as_str),
            Some("agent-policy-response" | "agent-policy-transition-response")
        ) {
            policy_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("retrieval-response") {
            retrieval_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("plan-response") {
            plan_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("resource-response") {
            resource_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("context-response") {
            context_bridge.receive(request);
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
        if request.get("kind").and_then(Value::as_str) == Some("host-tool-receipt") {
            if let Ok(receipt) = serde_json::from_value::<crate::host_tools::LateReceipt>(request) {
                let _ = agent_tx.send(crate::agent_runtime::Command::ToolReceipt(receipt));
            }
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("host-tool-response")
            || request.get("kind").and_then(Value::as_str) == Some("host-tool-revoked")
        {
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
            if let Ok(mut active) = cancellations.lock() {
                if let Some(request) = active.get_mut(&id) {
                    if request.epoch.as_deref() == cancel_epoch
                        && request.grant_id.as_deref() == cancel_grant
                    {
                        request.cancel();
                        if request.pending_body && !request.body_cancel_receipt {
                            request.body_cancel_receipt = true;
                            request.wire_lane = None;
                            let _ = response_tx
                                .send_control(response_error(&id, &KernelError::Cancelled));
                        }
                    }
                }
            }
            continue;
        }
        if request.get("kind").and_then(Value::as_str) != Some("request") || id.is_empty() {
            eprintln!("invalid kernel request admission");
            break;
        }
        let (token, input_order) = {
            let mut active = cancellations
                .lock()
                .map_err(|_| "cancellation owner poisoned")?;
            match active.get_mut(&id) {
                Some(request)
                    if lane == Lane::Data
                        && request.pending_body
                        && request.body_cancel_receipt =>
                {
                    active.remove(&id);
                    continue;
                }
                Some(request) if lane == Lane::Data && request.pending_body => {
                    request.pending_body = false;
                    (request.token.clone(), request.input_order.take())
                }
                Some(_) => {
                    eprintln!("duplicate in-flight request id");
                    break;
                }
                None if lane == Lane::Data => {
                    eprintln!("content request lost admission identity");
                    break;
                }
                None => (Arc::new(AtomicBool::new(false)), None),
            }
        };
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
        let wire_lane = if lane == Lane::Control {
            WireLane::Control
        } else {
            WireLane::Data
        };
        if lane == Lane::Control {
            let mut active = cancellations
                .lock()
                .map_err(|_| "cancellation owner poisoned")?;
            if active
                .values()
                .filter(|request| request.wire_lane == Some(wire_lane))
                .count()
                >= KERNEL_REQUEST_WINDOW
            {
                eprintln!("kernel external request admission window exceeded");
                break;
            }
            active.insert(
                id,
                ActiveRequest {
                    token: token.clone(),
                    epoch: request_epoch,
                    grant_id: request_grant,
                    runtime_cancel: None,
                    input_order: None,
                    wire_lane: Some(wire_lane),
                    pending_body: false,
                    body_cancel_receipt: false,
                },
            );
        }
        if request
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method.starts_with("process.subscription."))
        {
            if subscription_tx
                .send(crate::process::subscriptions::ControlCommand::Request {
                    value: request,
                    cancellation: token,
                })
                .is_err()
            {
                break;
            }
            continue;
        }
        if request
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method.starts_with("runtime."))
        {
            let current_epoch = admission_epoch.lock().ok().and_then(|epoch| epoch.clone());
            let cancellation_request = request
                .get("method")
                .and_then(Value::as_str)
                .filter(|method| {
                    matches!(*method, "runtime.run.cancel" | "runtime.operation.cancel")
                })
                .map(|_| request.clone());
            // Enqueue the intent before fast OS control. A resulting terminal fact can then
            // never overtake its cancel command in the owner's FIFO and lose causality.
            if agent_tx
                .send(crate::agent_runtime::Command::Request {
                    value: request,
                    cancellation: token,
                    input_order,
                })
                .is_err()
            {
                eprintln!("runtime control authority disconnected");
                break;
            }
            if let Some(request) = cancellation_request {
                agent_control.cancel_admitted(&request, current_epoch.as_deref());
            }
            continue;
        }
        if request_tx
            .send(WorkerRequest::Wire(request, token))
            .is_err()
        {
            // External credits were validated before enqueue. Internal resource/replay work
            // uses the same typed authority queue without consuming those wire credits.
            eprintln!("kernel resource authority disconnected");
            break;
        }
    }
    transport.shutdown();
    if let Ok(active) = cancellations.lock() {
        for request in active.values() {
            request.cancel();
        }
    }
    credential_bridge.close();
    mcp_bridge.close();
    language_bridge.close();
    memory_bridge.close();
    context_bridge.close();
    resource_bridge.close();
    plan_bridge.close();
    retrieval_bridge.close();
    policy_bridge.close();
    subscriptions.shutdown();
    let _ = subscription_tx.send(crate::process::subscriptions::ControlCommand::Stop);
    drop(subscription_tx);
    let _ = subscription_worker.join();
    // Run workers retain a resource sender. Explicitly stop the owner rather than
    // waiting for all senders to drop, which would create a shutdown channel cycle.
    let _ = request_tx.send(WorkerRequest::Stop);
    drop(request_tx);
    let _ = worker.join();
    let _ = agent_tx.send(crate::agent_runtime::Command::Stop);
    drop(agent_tx);
    let _ = agent_worker.join();
    drop(subscriptions);
    drop(response_tx);

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
