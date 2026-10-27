use crate::error::{response_error, KernelError};
use crate::protocol::*;
use crate::protocol_generated::{
    KERNEL_CONTROL_RESPONSE_METHODS, KERNEL_DEFERRED_RESPONSE_METHODS, KERNEL_REQUEST_WINDOW,
};
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
    View(Value),
    Reconcile(Value),
    RootRegistration(String),
    Resource(crate::tools::ResourceCall),
}

struct PendingRootRegistration {
    response: Value,
    remaining: usize,
}

enum BlobReadReply {
    Wire(Value),
    Resource(crate::tools::ResourceCall),
}

enum WorkerRequest {
    RootRegistered { request: Value, cancellation: Arc<AtomicBool>, result: Result<Value, KernelError> },
    CaptureResolved {
        request: Value,
        prepared: crate::storage::capture_resources::CapturePreparation,
        result: Result<Vec<crate::model::CanonicalFileLeaseResource>, KernelError>,
    },
    ResourceWorkDone {
        call: crate::tools::ResourceCall,
        result: Result<Value, crate::tools::ResourceFailure>,
    },
    ResourceRequestDone {
        request: Value,
        result: Result<Value, KernelError>,
    },
    BlobReadDone {
        reply: BlobReadReply,
        task: crate::storage::blob_reads::BlobReadTask,
        result: Result<crate::storage::blob_reads::PreparedBlobRead, KernelError>,
    },
    FileLeaseResolved {
        request: Value,
        task: crate::storage::file_lease_tasks::Task,
        result: Result<crate::storage::file_lease_tasks::Resolved, KernelError>,
    },
    Wire(Value, Arc<AtomicBool>),
    SourceWire(Value,varin_runtime::execution::CancellationToken),
    SourceDone { request:Value, key:String, result:Result<crate::source_resources::SourceWorkResult,KernelError> },
    Resource(crate::tools::ResourceCall),
    FileObservation(crate::file_observation::Command),
    Workspace(crate::storage::workspace_session::Command),
    WorkspaceIdle,
    FileWorkersDrained,
    WorkspaceDone { request: Option<Value>, result: Result<Value, KernelError> },
    WorkspaceShutdownDone {
        request: Option<Value>, result: Result<Value, KernelError>,
        processes: crate::process::ProcessManager, computations: crate::compute::ComputeManager,
    },
    FileWriterStopped(String),
    RecheckRecoveredProcessReceipts,
    FileLeasesChanged,
    Interaction(crate::storage::process_interactions::Command),
    ReplayProcessTerminals(Vec<String>),
    IntegrationReceipt(crate::tools::SourceEffectReceiptRead),
    FileReceipt(crate::tools::SourceEffectReceiptRead),
    ResultPublicationDone {
        request: Value,
        task: Arc<crate::storage::result_publication::ResultPublicationTask>,
        result: Result<crate::storage::result_publication::PreparedWorkingResult, KernelError>,
    },
    InventoryDone {
        request: Value,
        task: crate::storage::file_inventory::InventoryTask,
        result: Result<crate::storage::file_inventory::InventoryResult, KernelError>,
    },
    CaptureHashed {
        request: Value,
        task: crate::storage::capture_resources::CaptureTask,
        result: Result<crate::storage::capture_resources::HashedCapture, KernelError>,
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
    MaterializedViewCleanupDone {
        request: Option<Value>,
        task: crate::storage::materialized_views::CleanupTask,
        result: Result<(), KernelError>,
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

/// Transfer only completed-body transport credit. The original request, cancellation and
/// final response remain owned until the worker finishes. Call after real execution admission.
fn release_request_credit(
    active: &Mutex<HashMap<String, ActiveRequest>>,
    responses: &crate::transport::Sender,
    id: &str,
    method: &str,
) {
    if !KERNEL_DEFERRED_RESPONSE_METHODS.contains(&method) {
        return;
    }
    let frame = {
        let Ok(mut requests) = active.lock() else {
            return;
        };
        let Some(request) = requests.get_mut(id) else {
            return;
        };
        if request.pending_body || request.wire_lane.is_none() {
            return;
        }
        let Some(epoch) = request.epoch.clone() else {
            return;
        };
        request.wire_lane = None;
        json!({"v":PROTOCOL_VERSION,"kind":"request-credit-released","id":id,"kernelEpoch":epoch,"method":method})
    };
    let _ = responses.send_control(frame);
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

/// A pending file response retains its original cancellation identity until the
/// matching worker completion, including single-path capture.
fn pending_file_worker(method: &str) -> bool {
    matches!(
        method,
        "storage.getBlob"
            | "file.read"
            | "file.read.check"
            | "file.lease.wait"
            | "file.lease.acquire"
            | "file.lease.check"
            | "file.apply"
            | "file.mkdir"
            | "file.remove"
            | "file.rename"
            | "process.spawn"
            | "file.capture"
            | "file.captureBatch"
            | "file.scan"
            | "file.measure"
            | "working.result.publish"
            | "file.materialize"
            | "file.materializedView.prepare"
            | "file.materializedView.release"
            | "file.root.register"
            | "file.operation.reconcile"
            | "file.operation.list"
            | "recovery.points"
            | "recovery.files.restore"
            | "recovery.point.create"
    )
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
    #[cfg(test)]
    inventory_traversal_hold: Option<Box<dyn FnOnce() + Send>>,
    #[cfg(test)]
    capture_hold: Option<(
        crate::storage::capture_resources::CapturePhase,
        Box<dyn FnOnce() + Send>,
    )>,
    #[cfg(test)]
    blob_read_hold: Option<(
        crate::storage::blob_reads::BlobReadPhase,
        Box<dyn FnOnce() + Send>,
    )>,
    pending_root_registrations: HashMap<String, PendingRootRegistration>,
    active_materializations: usize,
    model_protocol: Option<crate::model_protocol::ModelProtocolOwner>,
    source_resources:Option<crate::tools::KernelResourceClient>,
    source_request_cancel:Option<varin_runtime::execution::CancellationToken>,
    source_tasks:HashMap<String,varin_runtime::execution::CancellationToken>,
    workspaces: Arc<crate::workspace_resources::Workspaces>,
    workspace_tasks: HashMap<String, Arc<AtomicBool>>,
    workspace_shutdown: bool,
    workspace_shutdown_started: bool,
    file_workers_draining: bool,
    workspace_shutdown_request: Option<Value>,
    shutdown_complete: bool,
    workspace_idle_pending:bool,
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
    fn drained(&self) -> bool {
        self.shutdown_complete && self.active_materializations == 0 && self.source_tasks.is_empty()
            && self.workspace_tasks.is_empty() && !self.workspace_shutdown && self.workspaces.is_empty()
            && !self.storage.as_ref().is_some_and(Storage::file_observation_reads_active)
    }
    fn workspace_port(completions: &mpsc::Sender<WorkerRequest>) -> crate::storage::workspace_session::StoragePort {
        let sender = completions.clone();
        crate::storage::workspace_session::StoragePort::new(move |command| {
            sender.send(WorkerRequest::Workspace(command)).map_err(|_| KernelError::Storage("Runtime workspace Storage owner disconnected".into()))
        })
    }
    fn stop_workspaces(&mut self, request: Option<Value>, completions: &mpsc::Sender<WorkerRequest>) {
        if self.workspace_shutdown { return; }
        self.workspace_shutdown = true;
        if request.is_some(){self.workspace_shutdown_request=request;}
        for cancelled in self.workspace_tasks.values() { cancelled.store(true, Ordering::Release); }
        for cancelled in self.source_tasks.values() { cancelled.cancel(); }
        for (cancelled, _) in &self.file_workers { cancelled.store(true, Ordering::Release); }
        self.advance_shutdown(completions);
    }
    fn advance_shutdown(&mut self, completions: &mpsc::Sender<WorkerRequest>) {
        if !self.workspace_shutdown || self.workspace_shutdown_started || !self.workspace_tasks.is_empty()
            || !self.source_tasks.is_empty() || self.active_materializations != 0
            || self.storage.as_ref().is_some_and(Storage::file_observation_reads_active) { return; }
        if self.file_workers_draining { return; }
        self.file_workers.retain(|(_,worker)|!worker.is_finished());
        if !self.file_workers.is_empty() {
            self.file_workers_draining=true;
            let (workers,sender)=(std::mem::take(&mut self.file_workers),completions.clone());
            thread::spawn(move ||{
                for (_,worker) in workers {let _=worker.join();}
                let _=sender.send(WorkerRequest::FileWorkersDrained);
            });
            return;
        }
        self.workspace_shutdown_started = true;
        self.workspace_idle_pending=false;
        let request = self.workspace_shutdown_request.take();
        let execution = self.storage.as_mut().map(Storage::take_execution_for_shutdown).unwrap_or_default();
        let (workspaces, sender) = (self.workspaces.clone(), completions.clone());
        thread::spawn(move || {
            let (mut processes, mut computations) = execution;
            // File/launch executors have transferred their final handles above.
            // Keep Storage responsive to callbacks from the remaining native users.
            let result = processes.shutdown();
            computations.shutdown();
            let result = result.and_then(|()| workspaces.shutdown()).map(|()| json!({"stopping":true}));
            let _ = sender.send(WorkerRequest::WorkspaceShutdownDone { request, result, processes, computations });
        });
    }
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
            #[cfg(test)]
            inventory_traversal_hold: None,
            #[cfg(test)]
            capture_hold: None,
            #[cfg(test)]
            blob_read_hold: None,
            pending_root_registrations: HashMap::new(),
            active_materializations: 0,
            model_protocol: None,
            source_resources:None,
            source_request_cancel:None,
            source_tasks:HashMap::new(),
            workspaces: Arc::new(crate::workspace_resources::Workspaces::default()),
            workspace_tasks: HashMap::new(),
            workspace_shutdown: false,
            workspace_shutdown_started: false,
            file_workers_draining: false,
            workspace_shutdown_request: None,
            shutdown_complete: false,
            workspace_idle_pending:false,
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
            self.collect_obsolete_materialized_views(completions)?;
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
            if self.workspace_shutdown || self.workspace_shutdown_request.is_some() { return Err(KernelError::Operation("The original kernel shutdown is still draining".into())); }
            if let Some(storage) = self.storage.as_ref() { storage.cancel_file_observation_reads(); }
            self.stop_workspaces(Some(request.clone()), completions);
            return Ok(None);
        }
        if matches!(method, "model.adapters.publish" | "model.adapters.revoke" | "model.adapters.retain" | "model.adapters.release") {
            if request.get("grantId").is_some() { return Err(KernelError::Authorization("model adapter composition requires authenticated Host ownership".into())); }
            let owner = self.model_protocol.as_ref().ok_or_else(|| KernelError::Operation("model protocol owner unavailable".into()))?;
            let result = if method == "model.adapters.publish" { owner.publish(serde_json::from_value(params_value)?)? }
                else if method == "model.adapters.retain" { owner.retain(serde_json::from_value(params_value)?)? }
                else if method == "model.adapters.release" { owner.release(serde_json::from_value(params_value)?)? }
                else { owner.revoke(serde_json::from_value(params_value)?)? };
            return Ok(Some(response_ok(id, result)));
        }
        let storage = self
            .storage
            .as_mut()
            .ok_or_else(|| KernelError::Storage("storage is not open".to_string()))?;
        let host_id = self.host_id.as_deref().ok_or_else(|| {
            KernelError::Authorization("Host identity is unavailable".to_string())
        })?;
        let grant_id = request.get("grantId").and_then(Value::as_str);
        if method.starts_with("source.") && method!="source.handoff.claim" {
            use crate::source_resources::*;
            if grant_id.is_some(){return Err(denied("Source authority entry requires authenticated Host ownership"));}
            if method=="source.resource.cancel" {
                let p:SourceResourceControlParams=serde_json::from_value(params_value.clone())?;
                let address=SourceAuthorityAddress{principal_id:p.principal_id,coordinator_host_id:p.coordinator_host_id,authority_id:p.authority_id,resource_epoch:p.resource_epoch};
                storage.source_authority(&address,false,&self.epoch)?;
                if let Some(token)=self.source_tasks.get(&format!("{}:{}",address.authority_id,p.operation_id)){token.cancel();}
            }
            let work=prepare_request(storage,method,params_value,&self.epoch,host_id,self.host_generation.as_deref().unwrap_or_default())?;
            if let SourceDispatch::Ready(value)=work{return Ok(Some(response_ok(id,value)));}
            let key=work.key().expect("source work identity");
            if self.source_tasks.contains_key(&key){return Err(denied("Original source request is already in flight; observe it"));}
            let resources=self.source_resources.clone().ok_or_else(||denied("Source resource worker unavailable"))?;
            let cancel=self.source_request_cancel.take().unwrap_or_default();
            let request=request.clone();let sender=completions.clone();
            self.source_tasks.insert(key.clone(),cancel.clone());
            thread::spawn(move||{let result=work.execute(resources,cancel);let _=sender.send(WorkerRequest::SourceDone{request,key,result});});
            return Ok(None);
        }
        if method == "source.handoff.claim" {
            if grant_id.is_some() {
                return Err(KernelError::Authorization(
                    "source claim requires current Host authority".into(),
                ));
            }
            let handoff = self.agent_control.child_handoff(&params_value)?;
            let identity = storage.root().to_string_lossy().to_string();
            return Ok(Some(response_ok(
                id,
                storage.claim_child_handoff(
                    &params_value,
                    &handoff,
                    host_id,
                    self.host_generation.as_deref().unwrap_or_default(),
                    &identity,
                    &self.epoch,
                )?,
            )));
        }
        if method == "authority.grant.issue" {
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
        if method == "authority.grant.retire" {
            let result=storage.retire_grants(&params_value,host_id)?;
            if let Err(error)=self.collect_obsolete_materialized_views(completions) {eprintln!("derived view cleanup pending: {error}");}
            return Ok(Some(response_ok(id,result)));
        }
        if method == "authority.grant.revoke" {
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
        if method.starts_with("workspace.") {
            if self.workspace_shutdown { return Err(KernelError::Operation("Workspace shutdown is in progress".into())); }
            let (workspaces, sender, request, method, port) = (self.workspaces.clone(), completions.clone(), request.clone(), method.to_owned(), Self::workspace_port(completions));
            let idle_sender=completions.clone();
            let notify_idle=Arc::new(move ||{let _=idle_sender.send(WorkerRequest::WorkspaceIdle);});
            self.workspace_tasks.insert(id.to_owned(), cancellation.clone());
            thread::spawn(move || {
                let result = workspaces.execute(port, notify_idle, &method, params_value, authorized_grant, cancellation);
                let _ = sender.send(WorkerRequest::WorkspaceDone { request:Some(request), result });
            });
            return Ok(None);
        }
        if matches!(method, "file.lease.wait" | "file.lease.acquire" | "file.lease.check") {
            let task = storage.prepare_file_lease_task(method, &authorized_params, &authorized_grant, cancellation)?;
            self.spawn_file_lease(request.clone(), task, completions)?;
            return Ok(None);
        }
        if matches!(method, "file.apply" | "file.mkdir" | "file.remove" | "file.rename") {
            let task = storage.prepare_file_effect(method, &authorized_params, &authorized_grant, cancellation.clone())?;
            let (port, completed, request) = (Self::workspace_port(completions), completions.clone(), request.clone());
            self.file_workers.retain(|(_, worker)| !worker.is_finished());
            let worker = thread::Builder::new().name("file-effect".into()).spawn(move || {
                let result = task.run(port);
                let _ = completed.send(WorkerRequest::ResourceRequestDone { request, result });
            })?;
            self.file_workers.push((cancellation, worker));
            return Ok(None);
        }
        if method=="process.spawn" {
            let task=storage.prepare_process_spawn(&authorized_params,&authorized_grant,cancellation.clone())?;
            let (port,completed,request)=(Self::workspace_port(completions),completions.clone(),request.clone());
            let worker=thread::Builder::new().name("process-launch".into()).spawn(move ||{
                let result=task.run(port);
                let _=completed.send(WorkerRequest::ResourceRequestDone{request,result});
            })?;
            self.file_workers.push((cancellation,worker));
            return Ok(None);
        }
        if method == "storage.getBlob" {
            let task =
                storage.prepare_blob_read(&authorized_params, &authorized_grant, cancellation)?;
            self.spawn_blob_read(task, BlobReadReply::Wire(request.clone()), completions)?;
            return Ok(None);
        }
        if matches!(method, "file.read" | "file.read.check") {
            let mut task=storage.prepare_file_read(&authorized_params,&authorized_grant,cancellation)?;
            if method == "file.read.check" { task=task.regular_identity(); }
            self.spawn_blob_read(crate::storage::blob_reads::BlobReadTask::File(task),BlobReadReply::Wire(request.clone()),completions)?;
            return Ok(None);
        }
        if method == "working.result.publish" {
            use crate::storage::result_publication::ResultPublicationAdmission;
            match storage.prepare_result_publication(
                &authorized_params,
                &authorized_grant.grant_id,
                cancellation.clone(),
            )? {
                ResultPublicationAdmission::Complete(value) => {
                    return Ok(Some(response_ok(id, value)))
                }
                ResultPublicationAdmission::Work(task) => {
                    let task = Arc::new(task);
                    let work = task.clone();
                    let request = request.clone();
                    let completed = completions.clone();
                    let spawned = thread::Builder::new()
                        .name("result-publication".into())
                        .spawn(move || {
                            let result =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    work.run()
                                }))
                                .unwrap_or_else(|_| {
                                    Err(KernelError::Storage(
                                        "result publication worker panicked".into(),
                                    ))
                                });
                            let _ = completed.send(WorkerRequest::ResultPublicationDone {
                                request,
                                task: work,
                                result,
                            });
                        });
                    match spawned {
                        Ok(worker) => self.file_workers.push((cancellation, worker)),
                        Err(error) => {
                            storage.release_result_publication_worker(&task);
                            return Err(error.into());
                        }
                    }
                    return Ok(None);
                }
            }
        }
        if matches!(method, "file.scan" | "file.measure") {
            let task = storage.prepare_file_inventory(
                method,
                &authorized_params,
                &authorized_grant,
                cancellation.clone(),
            )?;
            #[cfg(test)]
            let task = {
                let mut task = task;
                if let Some(hold) = self.inventory_traversal_hold.take() {
                    task.hold_traversal(hold);
                }
                task
            };
            let lease_id = task.lease_id().map(str::to_owned);
            let request = request.clone();
            let completed = completions.clone();
            self.file_workers
                .retain(|(_, worker)| !worker.is_finished());
            let worker = thread::Builder::new()
                .name("file-inventory".into())
                .spawn(move || {
                    let result =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task.run()))
                            .unwrap_or_else(|_| {
                                Err(KernelError::Storage("inventory worker panicked".into()))
                            });
                    let _ = completed.send(WorkerRequest::InventoryDone {
                        request,
                        task,
                        result,
                    });
                });
            match worker {
                Ok(worker) => self.file_workers.push((cancellation, worker)),
                Err(error) => {
                    if let Some(id) = lease_id {
                        storage.finish_retained_file_lease(&id);
                    }
                    return Err(error.into());
                }
            }
            return Ok(None);
        }
        if matches!(method, "file.capture" | "file.captureBatch") {
            let prepared=storage.prepare_capture_resolution(method,&authorized_params,&authorized_grant,cancellation.clone())?;
            let (request,completed)=(request.clone(),completions.clone());
            let worker=thread::Builder::new().name("capture-admission".into()).spawn(move ||{
                let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||prepared.resolve()))
                    .unwrap_or_else(|_|Err(KernelError::Storage("Capture admission worker panicked".into())));
                let _=completed.send(WorkerRequest::CaptureResolved{request,prepared,result});
            })?;
            self.file_workers.push((cancellation,worker));
            return Ok(None);
        }
        if method == "file.materializedView.prepare" {
            match storage.prepare_materialized_view(&authorized_params,&authorized_grant,cancellation.clone())? {
                MaterializationAdmission::Complete(result) => return Ok(Some(response_ok(id,storage.finish_materialized_view(&authorized_params,&authorized_grant,result)?))),
                MaterializationAdmission::Work(task) => {
                    self.spawn_materialization(task,MaterializationReply::View(request.clone()),authorized_grant.grant_id,cancellation,completions)?;
                    return Ok(None);
                }
            }
        }
        if method == "file.materializedView.release" {
            if let Some(task)=storage.prepare_materialized_view_release(&authorized_params,&authorized_grant)? {
                self.spawn_materialized_view_cleanup(task,Some(request.clone()),cancellation,completions)?;
                return Ok(None);
            }
            return Ok(Some(response_ok(id,json!({"viewId":authorized_params["viewId"],"released":true}))));
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
        if matches!(method,"recovery.points"|"recovery.files.restore"|"recovery.point.create") {
            use crate::storage::recovery_file_tasks::Action;
            let params:crate::protocol_generated::KernelFileRecoveryParams=crate::storage::recovery_file_tasks::parse_params(&authorized_params)?;
            let args=serde_json::to_value(&params.arguments)?;
            let journal=authorized_params.get("journal").map(|value|serde_json::from_value(value.clone())).transpose()?;
            let mode=serde_json::from_value(json!(params.source_mode.as_deref().unwrap_or("live_root")))?;
            let action=match method{
                "recovery.points"=>Action::Points(serde_json::from_value(args)?),
                "recovery.files.restore"=>Action::Restore{operation:params.operation_id.clone().ok_or_else(||KernelError::Operation("Restore operation is required".into()))?,args:serde_json::from_value(args)?},
                _=>Action::CreatePoint{params:authorized_params.clone(),args},
            };
            let task=storage.prepare_recovery_file_task(&params.workspace_id,&params.root_id,&params.thread_id,action,journal.as_ref(),mode,&authorized_grant,cancellation.clone())?;
            let (port,completed,request)=(Self::workspace_port(completions),completions.clone(),request.clone());
            let worker=thread::Builder::new().name("file-recovery".into()).spawn(move ||{
                let result=task.run_wire(port);
                let _=completed.send(WorkerRequest::ResourceRequestDone{request,result});
            })?;
            self.file_workers.push((cancellation,worker));
            return Ok(None);
        }
        if matches!(method,"file.operation.reconcile"|"file.operation.list") {
            let task=storage.prepare_file_inspection(method,&authorized_params,&authorized_grant,cancellation.clone())?;
            let (port,completed,request)=(Self::workspace_port(completions),completions.clone(),request.clone());
            let worker=thread::Builder::new().name("file-inspection".into()).spawn(move ||{
                let result=task.run(port);
                let _=completed.send(WorkerRequest::ResourceRequestDone{request,result});
            })?;
            self.file_workers.push((cancellation,worker));
            return Ok(None);
        }
        if method=="file.root.register" {
            let task=storage.prepare_file_root_registration(&authorized_params,&authorized_grant,cancellation.clone())?;
            let (port,completed,request)=(Self::workspace_port(completions),completions.clone(),request.clone());
            let worker=thread::Builder::new().name("file-root-registration".into()).spawn(move ||{
                let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||task.run(port)))
                    .unwrap_or_else(|_|Err(KernelError::Storage("File root registration worker panicked".into())));
                let _=completed.send(WorkerRequest::RootRegistered{request,cancellation:task.cancellation,result});
            })?;
            self.file_workers.push((cancellation,worker));
            return Ok(None);
        }
        storage.set_cancellation(cancellation);
        let result = storage.dispatch(method, &authorized_params, grant_id, &authorized_grant);
        storage.clear_cancellation();
        let result = result?;
        if method == "storage.gc" { self.collect_obsolete_materialized_views(completions)?; }
        Ok(Some(response_ok(id, result)))
    }

    fn continue_root_registration(
        &mut self,
        request: &Value,
        result: Value,
        cancellation: Arc<AtomicBool>,
        completions: &mpsc::Sender<WorkerRequest>,
    ) -> Result<Option<Value>, KernelError> {
        if cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let id = request["id"].as_str().unwrap_or_default();
        let storage = self
            .storage
            .as_mut()
            .ok_or_else(|| KernelError::Storage("Kernel stopped".into()))?;
        let (authorized_grant, authorized_params) = storage.authorize(
            request["grantId"].as_str(),
            &self.epoch,
            self.host_id.as_deref().unwrap_or_default(),
            self.host_generation.as_deref().unwrap_or_default(),
            "file.root.register",
            &request["params"],
        )?;
        let intents = storage.pending_materializations(
            result["rootId"].as_str().unwrap_or(""),
            authorized_params["workspaceId"].as_str().unwrap_or(""),
            None,
        )?;
        let mut tasks = Vec::new();
        for intent in intents {
            // Busy or unadmitted journals remain explicit pending work.
            if let Ok(MaterializationAdmission::Work(task)) =
                storage.prepare_materialization(&intent, &authorized_grant, cancellation.clone())
            {
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

    fn continue_capture_admission(
        &mut self,
        request: Value,
        prepared: crate::storage::capture_resources::CapturePreparation,
        resolved: Result<Vec<crate::model::CanonicalFileLeaseResource>, KernelError>,
        completions: &mpsc::Sender<WorkerRequest>,
    ) -> Result<(), KernelError> {
        let storage = self
            .storage
            .as_mut()
            .ok_or_else(|| KernelError::Storage("Kernel stopped".into()))?;
        let (grant, _) = storage.authorize(
            request["grantId"].as_str(),
            &self.epoch,
            self.host_id.as_deref().unwrap_or_default(),
            self.host_generation.as_deref().unwrap_or_default(),
            request["method"].as_str().unwrap_or_default(),
            &request["params"],
        )?;
        let task = storage.finish_capture_resolution(prepared, resolved?, &grant)?;
        let cancellation = task.cancellation();
        #[cfg(test)]
        let task = {
            let mut task = task;
            if let Some((phase, hold)) = self.capture_hold.take() {
                task.hold_at(phase, hold);
            }
            task
        };
        let lease_id = task.lease_id().to_string();
        let completed = completions.clone();
        self.file_workers
            .retain(|(_, worker)| !worker.is_finished());
        let spawned = thread::Builder::new()
            .name("file-capture".into())
            .spawn(move || {
                if task.store() {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        task.hash_sources()
                    }))
                    .unwrap_or_else(|_| {
                        Err(KernelError::Storage("capture worker panicked".into()))
                    });
                    let _ = completed.send(WorkerRequest::CaptureHashed {
                        request,
                        task,
                        result,
                    });
                } else {
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
                }
            });
        match spawned {
            Ok(worker) => self.file_workers.push((cancellation, worker)),
            Err(error) => {
                storage.finish_retained_file_lease(&lease_id);
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn continue_file_capture(
        &mut self,
        request: Value,
        mut task: crate::storage::capture_resources::CaptureTask,
        result: Result<crate::storage::capture_resources::HashedCapture, KernelError>,
        revoked_grants: &Mutex<HashSet<String>>,
        completions: &mpsc::Sender<WorkerRequest>,
    ) -> Result<(), KernelError> {
        let lease_id = task.lease_id().to_owned();
        let continued = (|| {
            let storage = self.storage.as_mut()
                .ok_or_else(|| KernelError::Authorization("kernel stopped".into()))?;
            let (grant, _) = storage.authorize(
                request["grantId"].as_str(), &self.epoch,
                self.host_id.as_deref().unwrap_or(""),
                self.host_generation.as_deref().unwrap_or(""),
                request["method"].as_str().unwrap_or(""), &request["params"],
            )?;
            if revoked_grants.lock().map(|revoked| revoked.contains(&grant.grant_id)).unwrap_or(true) {
                return Err(KernelError::Authorization("grant is revoked".into()));
            }
            let hashed = result?;
            storage.retain_capture_objects(&mut task, &hashed, &grant)?;
            let cancellation = task.cancellation();
            // Queued completion may be consumed before this worker tail returns.
            let retention = task.retain_worker_objects();
            let completed = completions.clone();
            self.file_workers.retain(|(_, worker)| !worker.is_finished());
            let worker = thread::Builder::new().name("file-capture".into()).spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task.finish_sources(hashed)))
                    .unwrap_or_else(|_| Err(KernelError::Storage("capture worker panicked".into())));
                let _ = completed.send(WorkerRequest::CaptureDone { request, task, result });
                drop(retention);
            })?;
            self.file_workers.push((cancellation, worker));
            Ok(())
        })();
        if continued.is_err() {
            if let Some(storage) = self.storage.as_mut() {
                storage.finish_retained_file_lease(&lease_id);
            }
        }
        continued
    }

    fn complete_file_capture(
        &mut self,
        request: &Value,
        task: &crate::storage::capture_resources::CaptureTask,
        result: Result<crate::storage::capture_resources::CapturedBatch, KernelError>,
        revoked_grants: &Arc<Mutex<HashSet<String>>>,
    ) -> Result<Value, KernelError> {
        let published = (|| {
            let storage = self
                .storage
                .as_mut()
                .ok_or_else(|| KernelError::Authorization("kernel stopped".into()))?;
            let (grant, _) = storage.authorize(
                request["grantId"].as_str(),
                &self.epoch,
                self.host_id.as_deref().unwrap_or(""),
                self.host_generation.as_deref().unwrap_or(""),
                request["method"].as_str().unwrap_or(""),
                &request["params"],
            )?;
            if revoked_grants
                .lock()
                .map(|revoked| revoked.contains(&grant.grant_id))
                .unwrap_or(true)
            {
                return Err(KernelError::Authorization("grant is revoked".into()));
            }
            storage.publish_capture(task, result?, &grant)
        })();
        if let Some(storage) = self.storage.as_mut() {
            storage.finish_retained_file_lease(task.lease_id());
        }
        published
    }

    fn complete_file_inventory(
        &mut self,
        request: &Value,
        task: &crate::storage::file_inventory::InventoryTask,
        result: Result<crate::storage::file_inventory::InventoryResult, KernelError>,
        revoked_grants: &Mutex<HashSet<String>>,
    ) -> Result<Value, KernelError> {
        let completed = (|| {
            let storage = self
                .storage
                .as_ref()
                .ok_or_else(|| KernelError::Authorization("kernel stopped".into()))?;
            let (grant, _) = storage.authorize(
                request["grantId"].as_str(),
                &self.epoch,
                self.host_id.as_deref().unwrap_or(""),
                self.host_generation.as_deref().unwrap_or(""),
                request["method"].as_str().unwrap_or(""),
                &request["params"],
            )?;
            if revoked_grants
                .lock()
                .map(|revoked| revoked.contains(&grant.grant_id))
                .unwrap_or(true)
            {
                return Err(KernelError::Authorization("grant is revoked".into()));
            }
            storage.finish_file_inventory(task, result?, &grant)
        })();
        if let (Some(storage), Some(id)) = (self.storage.as_mut(), task.lease_id()) {
            storage.finish_retained_file_lease(id);
        }
        completed
    }

    fn resume_file_lease_waiters(&mut self, completions: &mpsc::Sender<WorkerRequest>) -> Vec<(String, Result<Value, KernelError>)> {
        let Some(storage) = self.storage.as_mut() else { return Vec::new(); };
        let (mut completed, tasks) = storage.prepare_file_lease_waiters(&self.epoch,
            self.host_id.as_deref().unwrap_or_default(), self.host_generation.as_deref().unwrap_or_default());
        for continuation in tasks {
            let request = json!({"v":PROTOCOL_VERSION,"kind":"request","id":continuation.request_id,
                "method":"file.lease.wait","params":continuation.task.params,"epoch":self.epoch,"grantId":continuation.grant_id});
            if let Err(error) = self.spawn_file_lease(request, continuation.task, completions) {
                if let Some(storage) = self.storage.as_mut() { storage.finish_file_lease_waiter(&continuation.request_id); }
                completed.push((continuation.request_id, Err(error)));
            }
        }
        completed
    }
    fn spawn_file_lease(&mut self, request: Value, task: crate::storage::file_lease_tasks::Task,
        completions: &mpsc::Sender<WorkerRequest>) -> Result<(), KernelError> {
        let completed = completions.clone();
        let cancellation = task.cancellation.clone();
        self.file_workers.retain(|(_, worker)|!worker.is_finished());
        let worker = thread::Builder::new().name("file-lease".into()).spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||task.run()))
                .unwrap_or_else(|_|Err(KernelError::Storage("File lease resolution worker panicked".into())));
            let _ = completed.send(WorkerRequest::FileLeaseResolved { request, task, result });
        })?;
        self.file_workers.push((cancellation, worker));
        Ok(())
    }
    fn complete_file_lease(&mut self, request: &Value, task: &crate::storage::file_lease_tasks::Task,
        result: Result<crate::storage::file_lease_tasks::Resolved, KernelError>, revoked: &Mutex<HashSet<String>>)
        -> Result<Option<Value>, KernelError> {
        let storage = self.storage.as_mut().ok_or_else(||KernelError::Storage("Kernel stopped".into()))?;
        let id = request["id"].as_str().unwrap_or("");
        let outcome = (|| {
            let (grant, _) = storage.authorize(request["grantId"].as_str(), &self.epoch,
                self.host_id.as_deref().unwrap_or(""),self.host_generation.as_deref().unwrap_or(""),task.method(),&task.params)?;
            if request["epoch"].as_str() != Some(&self.epoch)
                || revoked.lock().map(|ids|ids.contains(&grant.grant_id)).unwrap_or(true) {
                return Err(KernelError::Authorization("File lease owner changed or was revoked".into()));
            }
            storage.finish_file_lease_task(id, task, result, &grant)
        })();
        if outcome.is_err() { storage.finish_file_lease_waiter(id); }
        outcome
    }
    fn spawn_blob_read(
        &mut self,
        mut task: crate::storage::blob_reads::BlobReadTask,
        reply: BlobReadReply,
        completions: &mpsc::Sender<WorkerRequest>,
    ) -> Result<(), KernelError> {
        #[cfg(test)]
        if let Some((phase, hold)) = self.blob_read_hold.take() {
            task.hold_at(phase, hold);
        }
        #[cfg(not(test))]
        let _ = &mut task;
        let cancellation = task.cancellation();
        let retention = task.retain_worker();
        let completed = completions.clone();
        self.file_workers
            .retain(|(_, worker)| !worker.is_finished());
        let worker = thread::Builder::new()
            .name("blob-read".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task.run()))
                    .unwrap_or_else(|_| {
                        Err(KernelError::Storage("blob read worker panicked".into()))
                    });
                let _ = completed.send(WorkerRequest::BlobReadDone {
                    reply,
                    task,
                    result,
                });
                drop(retention);
            })?;
        self.file_workers.push((cancellation, worker));
        Ok(())
    }
    fn complete_blob_read(
        &mut self,
        request: &Value,
        task: &crate::storage::blob_reads::BlobReadTask,
        result: Result<crate::storage::blob_reads::PreparedBlobRead, KernelError>,
        revoked: &Mutex<HashSet<String>>,
    ) -> Result<Value, KernelError> {
        let storage = self
            .storage
            .as_mut()
            .ok_or_else(|| KernelError::Storage("kernel stopped".into()))?;
        let (grant, _) = storage.authorize(
            request["grantId"].as_str(),
            &self.epoch,
            self.host_id.as_deref().unwrap_or(""),
            self.host_generation.as_deref().unwrap_or(""),
            task.method(),
            task.params(),
        )?;
        if request["epoch"].as_str() != Some(&self.epoch)
            || revoked
                .lock()
                .map(|set| set.contains(&grant.grant_id))
                .unwrap_or(true)
        {
            return Err(KernelError::Authorization(
                "blob reader owner changed or revoked".into(),
            ));
        }
        storage.finish_blob_read(task, result, &grant)
    }

    fn collect_obsolete_materialized_views(&mut self,completions:&mpsc::Sender<WorkerRequest>)->Result<(),KernelError>{
        let storage=self.storage.as_mut().ok_or_else(||KernelError::Storage("kernel stopped".into()))?;
        let obsolete=storage.obsolete_materialized_views(&self.epoch)?;
        let mut tasks=Vec::new();
        for (params,grant) in obsolete {
            // Unknown writers or replaced directories remain owned and visible.
            match storage.prepare_materialized_view_release(&params,&grant) {
                Ok(Some(task))=>tasks.push(task), Ok(None)=>{}, Err(error)=>eprintln!("derived view cleanup pending: {error}"),
            }
        }
        for task in tasks { self.spawn_materialized_view_cleanup(task,None,Arc::new(AtomicBool::new(false)),completions)?; }
        Ok(())
    }
    fn spawn_materialized_view_cleanup(&mut self,task:crate::storage::materialized_views::CleanupTask,request:Option<Value>,cancellation:Arc<AtomicBool>,completions:&mpsc::Sender<WorkerRequest>)->Result<(),KernelError>{
        let completed=completions.clone();
        let worker_task=task.clone();
        let worker=thread::Builder::new().name("materialized-view-cleanup".into()).spawn(move||{
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||worker_task.run())).unwrap_or_else(|_|Err(KernelError::Storage("derived view cleanup worker panicked".into())));
            let _=completed.send(WorkerRequest::MaterializedViewCleanupDone{request,task:worker_task,result});
        });
        match worker {
            Ok(worker)=>{self.file_workers.push((cancellation,worker));self.active_materializations+=1;Ok(())},
            Err(error)=>{
                if let Some(storage)=self.storage.as_mut(){let _=storage.finish_materialized_view_release(&task,Err(KernelError::Storage("Derived view cleanup worker did not start".into())));}
                Err(error.into())
            }
        }
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
    let model_protocol = crate::model_protocol::ModelProtocolOwner::new(response_tx.clone());
    let mcp_bridge = crate::host_tools::ToolBridge::new(response_tx.clone());
    let memory_bridge = crate::host_query::OwnerChannel::new("memory", response_tx.clone());
    let context_bridge = crate::host_query::OwnerChannel::new("context", response_tx.clone());
    let resource_bridge = crate::host_query::OwnerChannel::new("resource", response_tx.clone());
    let file_observation_bridge =
        crate::host_query::OwnerChannel::new("file-observation", response_tx.clone());
    let plan_bridge = crate::plan_bridge::PlanBridge::new(response_tx.clone());
    let language_bridge = crate::language::LanguageBridge::new(response_tx.clone());
    let policy_bridge = crate::policy::PolicyBridge::new(response_tx.clone());
    let source_bridge=crate::host_query::OwnerChannel::new("source-resource",response_tx.clone());
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
    let file_terminal_commands = request_tx.clone();
    thread::spawn(move || {
        for terminal in terminal_rx {
            let _ = file_terminal_commands.send(WorkerRequest::FileWriterStopped(
                terminal.process_id.clone(),
            ));
            if terminal_commands
                .send(crate::agent_runtime::Command::ProcessTerminal(terminal))
                .is_err()
            {
                break;
            }
        }
    });
    let integration_requests = request_tx.clone();
    let file_receipt_requests = request_tx.clone();
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
    let interaction_requests = request_tx.clone();
    let interaction_active = cancellations.clone();
    let interaction_revoked = revoked_grants.clone();
    let interaction_epoch = admission_epoch.clone();
    let interaction_client = crate::storage::process_interactions::Client::new(move |command| {
        interaction_requests
            .send(WorkerRequest::Interaction(command))
            .map_err(|_| KernelError::Storage("process owner stopped".into()))
    })
    .with_watch(move |grants, cancel| {
        let revoked = interaction_revoked
            .lock()
            .map_err(|_| KernelError::Storage("revocation owner failed".into()))?;
        let epoch = interaction_epoch
            .lock()
            .map_err(|_| KernelError::Storage("epoch owner failed".into()))?
            .clone();
        let mut active = interaction_active
            .lock()
            .map_err(|_| KernelError::Storage("cancellation owner failed".into()))?;
        let mut keys = Vec::new();
        for grant in grants {
            if revoked.contains(grant) {
                cancel.cancel();
            }
            let key = format!("process-input:{}", Uuid::new_v4());
            active.insert(
                key.clone(),
                ActiveRequest {
                    token: cancel.shared_flag(),
                    epoch: epoch.clone(),
                    grant_id: Some(grant.clone()),
                    runtime_cancel: Some(cancel.clone()),
                    input_order: None,
                    wire_lane: None,
                    pending_body: false,
                    body_cancel_receipt: false,
                },
            );
            keys.push(key);
        }
        drop(active);
        drop(revoked);
        let owner = interaction_active.clone();
        Ok(
            varin_runtime::execution_capacity::AdmissionControlGuard::new(move || {
                if let Ok(mut active) = owner.lock() {
                    for key in keys {
                        active.remove(&key);
                    }
                }
            }),
        )
    });
    let file_observation_requests = request_tx.clone();
    let file_observations = crate::file_observation::Client::new(
        move |command| {
            file_observation_requests
                .send(WorkerRequest::FileObservation(command))
                .map_err(|_| KernelError::Storage("file observation owner stopped".into()))
        },
        file_observation_bridge.clone(),
    ).with_source_bridge(source_bridge.clone());
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
    .with_source_bridge(source_bridge.clone())
    .with_file_observations(file_observations)
    .with_process_interactions(interaction_client.clone())
    .with_integration_receipts(move |read| {
        integration_requests
            .send(WorkerRequest::IntegrationReceipt(read))
            .map_err(|_| KernelError::Storage("Storage journal owner stopped".into()))
    })
    .with_file_receipts(move |read| {
        file_receipt_requests.send(WorkerRequest::FileReceipt(read))
            .map_err(|_| KernelError::Storage("Storage file receipt owner stopped".into()))
    })
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
    let credit_cancellations = cancellations.clone();
    let credit_responses = response_tx.clone();
    let agent_control = crate::agent_runtime::AgentControl::default();
    let source_resources=resources.clone();
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
        policy_bridge.clone(),
        response_tx.clone(),
        move |id| {
            if let Ok(mut active) = agent_cancellations.lock() {
                active.remove(id);
            }
        },
        move |id, method| {
            release_request_credit(&credit_cancellations, &credit_responses, id, method)
        },
    );
    let worker_agent_control = agent_control.clone();
    let worker_agent_tx = agent_tx.clone();
    let worker_cancellations = cancellations.clone();
    let worker_revoked_grants = revoked_grants.clone();
    let worker_admission_epoch = admission_epoch.clone();
    let worker_credentials = credential_bridge.clone();
    let worker_model_protocol = model_protocol.clone();
    let worker_mcp = mcp_bridge.clone();
    let worker_language = language_bridge.clone();
    let worker_memory = memory_bridge.clone();
    let worker_context = context_bridge.clone();
    let worker_resource = resource_bridge.clone();
    let worker_file_observation = file_observation_bridge.clone();
    let worker_plan = plan_bridge.clone();
    let worker_policy = policy_bridge.clone();
    let worker_source=source_bridge.clone();
    let worker_response_tx = response_tx.clone();
    let worker_writer_failed = writer_failed.clone();
    let capture_completions = request_tx.clone();
    let worker = thread::spawn(move || {
        let mut kernel = Kernel::new(transport_epoch);
        kernel.agent_control = worker_agent_control;
        kernel.model_protocol = Some(worker_model_protocol.clone());
        kernel.source_resources=Some(source_resources);
        let mut stopping = false;
        macro_rules! respond {
            ($response:expr) => {
                if worker_response_tx.send($response).is_err() {
                    worker_writer_failed.store(true, Ordering::Release);
                    stopping = true;
                    if !kernel.shutdown_complete { kernel.stop_workspaces(None, &capture_completions); }
                }
            };
        }
        loop {
            if worker_writer_failed.load(Ordering::Acquire) && !stopping {
                stopping = true;
                kernel.stop_workspaces(None, &capture_completions);
            }
            kernel.advance_shutdown(&capture_completions);
            if stopping && kernel.drained() {
                break;
            }
            let Ok(message) = request_rx.recv() else { break; };
            let (request, cancellation) = match message {
                WorkerRequest::Wire(request, cancellation) => (request, cancellation),
                WorkerRequest::SourceWire(request,cancel)=>{kernel.source_request_cancel=Some(cancel.clone());(request,cancel.shared_flag())},
                WorkerRequest::SourceDone{request,key,result}=>{
                    kernel.source_tasks.remove(&key);
                    let id=request["id"].as_str().unwrap_or_default();
                    if let Ok(mut active)=worker_cancellations.lock(){active.remove(id);}
                    let result=result.and_then(|value|value.finish(kernel.storage.as_mut().expect("source Storage owner")));
                    let response=match result{Ok(value)=>response_ok(id,value),Err(error)=>response_error(id,&error)};
                    respond!(response);
                    continue;
                },
                WorkerRequest::Stop => {
                    stopping = true;
                    kernel.stop_workspaces(None, &capture_completions);
                    for cancel in kernel.source_tasks.values(){cancel.cancel();}
                    for (cancel, _) in &kernel.file_workers {
                        cancel.store(true, Ordering::Release);
                    }
                    if let Some(storage) = kernel.storage.as_mut() {
                        for id in storage.cancel_file_lease_waiters() {
                            if let Ok(mut active) = worker_cancellations.lock() { active.remove(&id); }
                            let _ = worker_response_tx.send(response_error(&id, &KernelError::Cancelled));
                        }
                    }
                    if let Some(storage) = kernel.storage.as_ref() {
                        storage.cancel_file_observation_reads();
                    }
                    if kernel.drained() {
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
                WorkerRequest::MaterializedViewCleanupDone{request,task,result}=>{
                    let result=kernel.storage.as_mut().ok_or_else(||KernelError::Storage("kernel stopped".into())).and_then(|storage|storage.finish_materialized_view_release(&task,result));
                    kernel.active_materializations-=1;
                    if let Some(request)=request {
                        let id=request["id"].as_str().unwrap_or("");
                        worker_cancellations.lock().ok().map(|mut active|active.remove(id));
                        let response=match result {Ok(result)=>response_ok(id,result),Err(error)=>response_error(id,&error)};
                        respond!(response);
                    } else if let Err(error)=result {eprintln!("derived view cleanup failed: {error}");}
                    if stopping && kernel.drained() {break;}
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
                        MaterializationReply::Resource(call) => {
                            let result = result.and_then(|value| {
                                let storage = kernel.storage.as_mut().ok_or_else(|| KernelError::Storage("kernel stopped".into()))?;
                                crate::tools::finish_resource_execution_view(storage, &kernel.epoch,
                                    kernel.host_id.as_deref().unwrap_or(""), kernel.host_generation.as_deref().unwrap_or(""), &call, value)
                            });
                            match result {
                                Ok(()) => { let _ = capture_completions.send(WorkerRequest::Resource(call)); }
                                Err(error) => {
                                    if let Some(key) = &call.admission_key {
                                        worker_cancellations.lock().ok().map(|mut active| active.remove(key));
                                    }
                                    let _ = call.reply.send(Err(crate::tools::ResourceFailure {error, dispatched: false}));
                                }
                            }
                            None
                        }
                        MaterializationReply::Direct(request)
                        | MaterializationReply::View(request)
                        | MaterializationReply::Reconcile(request) => {
                            let id = request["id"].as_str().unwrap_or("");
                            worker_cancellations
                                .lock()
                                .ok()
                                .map(|mut active| active.remove(id));
                            let result = if request["method"] == "file.materializedView.prepare" {
                                result.and_then(|result| {
                                    let storage=kernel.storage.as_mut().ok_or_else(||KernelError::Storage("kernel stopped".into()))?;
                                    let (grant,_)=storage.authorize(request["grantId"].as_str(),&kernel.epoch,kernel.host_id.as_deref().unwrap_or(""),kernel.host_generation.as_deref().unwrap_or(""),"file.materializedView.prepare",&request["params"])?;
                                    storage.finish_materialized_view(&request["params"],&grant,result)
                                })
                            } else if request["method"] == "file.operation.reconcile" {
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
                        respond!(response);
                    }
                    if stopping && kernel.drained() {
                        break;
                    }
                    continue;
                }
                WorkerRequest::ResultPublicationDone {
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
                            "working.result.publish",
                            &request["params"],
                        )?;
                        if worker_revoked_grants
                            .lock()
                            .map(|revoked| revoked.contains(&grant.grant_id))
                            .unwrap_or(true)
                        {
                            return Err(KernelError::Authorization("grant is revoked".into()));
                        }
                        storage.finish_result_publication(&task, result?, &grant.grant_id)
                    })();
                    if let Some(storage) = kernel.storage.as_mut() {
                        storage.release_result_publication_worker(&task);
                    }
                    worker_cancellations
                        .lock()
                        .ok()
                        .map(|mut active| active.remove(id));
                    let response = match published {
                        Ok(value) => response_ok(id, value),
                        Err(error) => response_error(id, &error),
                    };
                    respond!(response);
                    continue;
                }
                WorkerRequest::RootRegistered { request, cancellation, result } => {
                    let id=request["id"].as_str().unwrap_or_default();
                    let result=if stopping{Err(KernelError::Cancelled)}else{result.and_then(|value|kernel.continue_root_registration(&request,value,cancellation,&capture_completions))};
                    if matches!(result,Ok(None)){continue;}
                    if let Ok(mut active)=worker_cancellations.lock(){active.remove(id);}
                    respond!(match result{Ok(Some(response))=>response,Err(error)=>response_error(id,&error),Ok(None)=>unreachable!()});
                    continue;
                }
                WorkerRequest::ResourceWorkDone { call, result } => {
                    if let Some(key) = &call.admission_key {
                        if let Ok(mut active) = worker_cancellations.lock() { active.remove(key); }
                    }
                    let _ = call.reply.send(result);
                    continue;
                }
                WorkerRequest::ResourceRequestDone { request, result } => {
                    let id = request["id"].as_str().unwrap_or("");
                    if let Ok(mut active) = worker_cancellations.lock() { active.remove(id); }
                    // The original worker has already committed its actual receipt
                    // and drained its lease. Late cancellation cannot erase an effect.
                    respond!(match result {
                        Ok(value) => response_ok(id, value),
                        Err(error) => response_error(id, &error),
                    });
                    continue;
                }
                WorkerRequest::FileLeaseResolved { request, task, result } => {
                    let id = request["id"].as_str().unwrap_or("");
                    let result = kernel.complete_file_lease(&request, &task, result, &worker_revoked_grants);
                    if matches!(result, Ok(None)) { continue; }
                    if let Ok(mut active) = worker_cancellations.lock() { active.remove(id); }
                    let response = match result {
                        Ok(Some(value)) => response_ok(id, value),
                        Err(error) => response_error(id, &error),
                        Ok(None) => unreachable!("queued lease keeps its original request"),
                    };
                    respond!(response);
                    continue;
                }
                WorkerRequest::BlobReadDone {
                    reply,
                    task,
                    result,
                } => {
                    match reply {
                        BlobReadReply::Wire(request) => {
                            let id = request["id"].as_str().unwrap_or("");
                            let value = kernel.complete_blob_read(
                                &request,
                                &task,
                                result,
                                &worker_revoked_grants,
                            );
                            worker_cancellations
                                .lock()
                                .ok()
                                .map(|mut active| active.remove(id));
                            let response = match value {
                                Ok(value) => response_ok(id, value),
                                Err(error) => response_error(id, &error),
                            };
                            respond!(response);
                        }
                        BlobReadReply::Resource(call) => {
                            let denied = worker_revoked_grants
                                .lock()
                                .map(|set| set.contains(&call.binding.grant_id))
                                .unwrap_or(true);
                            let value = if denied {
                                Err(crate::tools::ResourceFailure {
                                    error: KernelError::Authorization("grant is revoked".into()),
                                    dispatched: true,
                                })
                            } else if let Some(storage) = kernel.storage.as_mut() {
                                crate::tools::finish_resource_blob_read(
                                    storage,
                                    &kernel.epoch,
                                    kernel.host_id.as_deref().unwrap_or(""),
                                    kernel.host_generation.as_deref().unwrap_or(""),
                                    &call,
                                    &task,
                                    result,
                                )
                            } else {
                                Err(crate::tools::ResourceFailure {
                                    error: KernelError::Storage("kernel stopped".into()),
                                    dispatched: true,
                                })
                            };
                            if let Some(key) = &call.admission_key {
                                worker_cancellations
                                    .lock()
                                    .ok()
                                    .map(|mut active| active.remove(key));
                            }
                            let _ = call.reply.send(value);
                        }
                    }
                    continue;
                }
                WorkerRequest::InventoryDone {
                    request,
                    task,
                    result,
                } => {
                    let id = request["id"].as_str().unwrap_or("");
                    let completed = kernel.complete_file_inventory(
                        &request,
                        &task,
                        result,
                        &worker_revoked_grants,
                    );
                    worker_cancellations
                        .lock()
                        .ok()
                        .map(|mut active| active.remove(id));
                    let response = match completed {
                        Ok(value) => response_ok(id, value),
                        Err(error) => response_error(id, &error),
                    };
                    respond!(response);
                    continue;
                }
                WorkerRequest::CaptureResolved { request, prepared, result } => {
                    let id=request["id"].as_str().unwrap_or_default().to_owned();
                    let result=if stopping{Err(KernelError::Cancelled)}else{kernel.continue_capture_admission(request,prepared,result,&capture_completions)};
                    if let Err(error)=result{
                        if let Ok(mut active)=worker_cancellations.lock(){active.remove(&id);}
                        respond!(response_error(&id,&error));
                    }
                    continue;
                }
                WorkerRequest::CaptureHashed { request, task, result } => {
                    let id = request["id"].as_str().unwrap_or("").to_owned();
                    let continued = if stopping {
                        if let Some(storage) = kernel.storage.as_mut() {
                            storage.finish_retained_file_lease(task.lease_id());
                        }
                        Err(KernelError::Cancelled)
                    } else {
                        kernel.continue_file_capture(request, task, result, &worker_revoked_grants, &capture_completions)
                    };
                    if let Err(error) = continued {
                        worker_cancellations.lock().ok().map(|mut active| active.remove(&id));
                        respond!(response_error(&id, &error));
                    }
                    // The same request/credit remains active across the continuation.
                    continue;
                }
                WorkerRequest::CaptureDone {
                    request,
                    task,
                    result,
                } => {
                    let id = request["id"].as_str().unwrap_or("");
                    let published = kernel.complete_file_capture(
                        &request,
                        &task,
                        result,
                        &worker_revoked_grants,
                    );
                    worker_cancellations
                        .lock()
                        .ok()
                        .map(|mut active| active.remove(id));
                    let response = match published {
                        Ok(value) => response_ok(id, value),
                        Err(error) => response_error(id, &error),
                    };
                    respond!(response);
                    continue;
                }
                WorkerRequest::Interaction(command) => {
                    if let Some(storage) = kernel.storage.as_mut() {
                        if let Some((intent, receipt)) = storage.serve_interaction(
                            command,
                            &kernel.epoch,
                            kernel.host_id.as_deref().unwrap_or_default(),
                            kernel.host_generation.as_deref().unwrap_or_default(),
                        ) {
                            if intent.native.as_ref().is_some_and(|native|native.resource_owner.is_local()) {
                                let _ = worker_agent_tx.send(
                                    crate::agent_runtime::Command::ProcessInteraction {
                                        intent,
                                        receipt,
                                    },
                                );
                            }
                        }
                    }
                    continue;
                }
                WorkerRequest::IntegrationReceipt(read) => {
                    let result = kernel
                        .storage
                        .as_ref()
                        .ok_or_else(|| KernelError::Storage("Storage not ready".into()))
                        .and_then(|storage| storage.integration_receipt(&read));
                    let _ = read.reply.send(result);
                    continue;
                }
                WorkerRequest::FileReceipt(read) => {
                    let result = kernel.storage.as_ref().ok_or_else(|| KernelError::Storage("Storage not ready".into()))
                        .and_then(|storage| storage.file_tool_receipt(&read));
                    let _ = read.reply.send(result); continue;
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
                WorkerRequest::FileObservation(command) => {
                    command.serve(
                        kernel.storage.as_mut(),
                        &kernel.epoch,
                        kernel.host_id.as_deref().unwrap_or(""),
                        kernel.host_generation.as_deref().unwrap_or(""),
                    );
                    continue;
                }
                WorkerRequest::Workspace(command) => {
                    command(kernel.storage.as_mut());
                    continue;
                }
                WorkerRequest::WorkspaceIdle => {
                    kernel.workspace_idle_pending=true;
                    if !stopping&&kernel.workspaces.take_idle_observer(){respond!(json!({"v":PROTOCOL_VERSION,"kind":"workspace-idle","kernelEpoch":kernel.epoch}));}
                    if stopping && !kernel.workspace_shutdown && !kernel.shutdown_complete { kernel.stop_workspaces(None,&capture_completions); }
                    continue;
                }
                WorkerRequest::WorkspaceDone { request, result } => {
                    if let Some(request) = request {
                        let id = request["id"].as_str().unwrap_or_default();
                        kernel.workspace_tasks.remove(id);
                        if let Ok(mut active) = worker_cancellations.lock() { active.remove(id); }
                        let result=if request["method"]=="workspace.inspect" {result.and_then(|value|{
                            kernel.storage.as_mut().ok_or_else(||KernelError::Storage("Workspace Storage owner disconnected".into()))?
                                .authorize(request["grantId"].as_str(),&kernel.epoch,kernel.host_id.as_deref().unwrap_or_default(),kernel.host_generation.as_deref().unwrap_or_default(),"workspace.inspect",&request["params"])
                                .map(|_|value)
                        })}else{result};
                        let response = match result { Ok(value) => response_ok(id, value), Err(error) => response_error(id, &error) };
                        respond!(response);
                    }
                    if stopping && kernel.drained() { break; }
                    continue;
                }
                WorkerRequest::WorkspaceShutdownDone { request, result, processes, computations } => {
                    let restored = kernel.storage.as_mut().map(|storage| storage.finish_execution_shutdown(processes, computations))
                        .unwrap_or(Ok(()));
                    let result = result.and_then(|value| restored.map(|()| value));
                    kernel.workspace_shutdown = false;
                    kernel.workspace_shutdown_started = false;
                    kernel.shutdown_complete = result.is_ok();
                    if matches!(&result,Err(KernelError::Execution(error)) if error.code=="workspace_native_handles_active"){
                        // Keep the original shutdown reply pending while real
                        // native references drain. A Close received before this
                        // continuation is remembered, so the wake cannot be lost.
                        if request.is_some(){kernel.workspace_shutdown_request=request;}
                        if kernel.workspace_idle_pending {kernel.stop_workspaces(None,&capture_completions);}
                        continue;
                    }
                    if let Some(request) = request {
                        let id = request["id"].as_str().unwrap_or_default();
                        if let Ok(mut active) = worker_cancellations.lock() { active.remove(id); }
                        let response = match result { Ok(value) => response_ok(id, value), Err(error) => response_error(id, &error) };
                        respond!(response);
                    } else if let Err(error) = result { eprintln!("Workspace shutdown remains pending: {error}"); }
                    if stopping && !kernel.shutdown_complete && kernel.workspace_idle_pending { kernel.stop_workspaces(None,&capture_completions); }
                    if stopping && kernel.drained() { break; }
                    continue;
                }
                WorkerRequest::FileWorkersDrained => {
                    kernel.file_workers_draining=false;
                    kernel.advance_shutdown(&capture_completions);
                    continue;
                }
                WorkerRequest::RecheckRecoveredProcessReceipts => {
                    kernel.workspace_idle_pending=true;
                    if let Some(storage) = kernel.storage.as_mut() {
                        storage.recheck_recovered_process_receipts();
                    }
                    if !stopping&&kernel.workspaces.take_idle_observer(){respond!(json!({"v":PROTOCOL_VERSION,"kind":"workspace-idle","kernelEpoch":kernel.epoch}));}
                    if stopping && !kernel.workspace_shutdown && !kernel.shutdown_complete { kernel.stop_workspaces(None,&capture_completions); }
                    continue;
                }
                WorkerRequest::FileLeasesChanged => {
                    {
                        let completed = kernel.resume_file_lease_waiters(&capture_completions);
                        for (id, result) in completed {
                            if let Ok(mut active) = worker_cancellations.lock() { active.remove(&id); }
                            let response = match result { Ok(value) => response_ok(&id, value), Err(error) => response_error(&id, &error) };
                            respond!(response);
                        }
                    }
                    continue;
                }
                WorkerRequest::FileWriterStopped(id) => {
                    kernel.workspace_idle_pending=true;
                    if let Some(storage) = kernel.storage.as_mut() {
                        let _ = storage.observe_file_writer_stopped(&id);
                    }
                    if !stopping&&kernel.workspaces.take_idle_observer(){respond!(json!({"v":PROTOCOL_VERSION,"kind":"workspace-idle","kernelEpoch":kernel.epoch}));}
                    if let Err(error)=kernel.collect_obsolete_materialized_views(&capture_completions) {eprintln!("derived view cleanup pending: {error}");}
                    if stopping && !kernel.workspace_shutdown && !kernel.shutdown_complete { kernel.stop_workspaces(None,&capture_completions); }
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
                        crate::tools::prepare_resource(
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
                    let result = match result {
                        Ok(crate::tools::ResourceWork::Ready(value)) => Ok(value),
                        Ok(crate::tools::ResourceWork::ProcessSpawn(task)) => {
                            let (port,completed)=(Kernel::workspace_port(&capture_completions),capture_completions.clone());
                            let (key,cancellation)=(call.admission_key.clone(),call.cancellation.shared_flag());
                            let worker=thread::Builder::new().name("process-launch".into()).spawn(move ||{
                                let result=task.run_resource(port);
                                let _=completed.send(WorkerRequest::ResourceWorkDone{call,result});
                            });
                            match worker {
                                Ok(worker)=>kernel.file_workers.push((cancellation,worker)),
                                Err(_)=>if let Some(key)=key{if let Ok(mut active)=worker_cancellations.lock(){active.remove(&key);}},
                            }
                            continue;
                        }
                        Ok(crate::tools::ResourceWork::NativeHandoff(task)) => {
                            let (port,completed,workspaces)=(Kernel::workspace_port(&capture_completions),capture_completions.clone(),kernel.workspaces.clone());
                            let (key,cancellation)=(call.admission_key.clone(),call.cancellation.shared_flag());
                            let worker=thread::Builder::new().name("native-source-handoff".into()).spawn(move||{
                                let result=task.run(&workspaces,port).map_err(|error|crate::tools::ResourceFailure{error,dispatched:false});
                                let _=completed.send(WorkerRequest::ResourceWorkDone{call,result});
                            });
                            match worker{Ok(worker)=>kernel.file_workers.push((cancellation,worker)),Err(_)=>if let Some(key)=key{if let Ok(mut active)=worker_cancellations.lock(){active.remove(&key);}}}
                            continue;
                        }
                        Ok(crate::tools::ResourceWork::FileRecovery(task)) => {
                            let (port,completed)=(Kernel::workspace_port(&capture_completions),capture_completions.clone());
                            let (key,cancellation)=(call.admission_key.clone(),call.cancellation.shared_flag());
                            let worker=thread::Builder::new().name("file-recovery".into()).spawn(move ||{
                                let result=task.run(port);
                                let _=completed.send(WorkerRequest::ResourceWorkDone{call,result});
                            });
                            match worker {
                                Ok(worker)=>kernel.file_workers.push((cancellation,worker)),
                                Err(_)=>if let Some(key)=key{if let Ok(mut active)=worker_cancellations.lock(){active.remove(&key);}},
                            }
                            continue;
                        }
                        Ok(crate::tools::ResourceWork::TextMutation(task)) => {
                            let (port, completed) = (Kernel::workspace_port(&capture_completions), capture_completions.clone());
                            let (key, cancellation) = (call.admission_key.clone(), call.cancellation.shared_flag());
                            let worker = thread::Builder::new().name("text-mutation".into()).spawn(move || {
                                let result = task.run(port);
                                let _ = completed.send(WorkerRequest::ResourceWorkDone { call, result });
                            });
                            match worker {
                                Ok(worker) => kernel.file_workers.push((cancellation, worker)),
                                Err(_) => if let Some(key) = key {
                                    if let Ok(mut active) = worker_cancellations.lock() { active.remove(&key); }
                                },
                            }
                            continue;
                        }
                        Ok(crate::tools::ResourceWork::ExecutionView(task)) => {
                            let key = call.admission_key.clone();
                            let grant_id = call.binding.grant_id.clone();
                            let cancellation = call.cancellation.shared_flag();
                            if kernel.spawn_materialization(task, MaterializationReply::Resource(call), grant_id,
                                cancellation, &capture_completions).is_err() {
                                if let Some(key) = key {
                                    worker_cancellations.lock().ok().map(|mut active| active.remove(&key));
                                }
                            }
                            continue;
                        }
                        Ok(crate::tools::ResourceWork::BlobRead(task)) => {
                            // A failed spawn drops the original reply and retention; its receiver
                            // reports disconnection, never a fabricated successful/cancelled read.
                            let key = call.admission_key.clone();
                            if kernel
                                .spawn_blob_read(
                                    task,
                                    BlobReadReply::Resource(call),
                                    &capture_completions,
                                )
                                .is_err()
                            {
                                if let Some(key) = key {
                                    worker_cancellations
                                        .lock()
                                        .ok()
                                        .map(|mut active| active.remove(&key));
                                }
                            }
                            continue;
                        }
                        Err(error) => Err(error),
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
            let handled = if stopping && !matches!(method.as_deref(), Some("kernel.shutdown" | "kernel.ping" | "workspace.inspect" | "workspace.release" | "workspace.close")) {
                Err(KernelError::Operation("kernel is stopping".into()))
            } else if revoked {
                Err(KernelError::Authorization("grant is revoked".to_string()))
            } else {
                kernel.handle(&request, cancellation, &capture_completions)
            };
            if kernel.workspace_shutdown {
                stopping = true;
                if let Some(storage) = kernel.storage.as_mut() {
                    for pending in storage.cancel_file_lease_waiters() {
                        if let Ok(mut active) = worker_cancellations.lock() { active.remove(&pending); }
                        let _ = worker_response_tx.send(response_error(&pending, &KernelError::Cancelled));
                    }
                }
            }
            let response = match handled {
                Ok(Some(response)) => response,
                Ok(None) => {
                    if method.as_deref() == Some("file.lease.wait") {
                        release_request_credit(&worker_cancellations, &worker_response_tx, &id, "file.lease.wait");
                    }
                    if method.as_deref().is_some_and(|method| method.starts_with("workspace.") || method == "kernel.shutdown" || pending_file_worker(method)||matches!(method,"source.resource.authorize"|"source.resource.execute"|"source.service.call"|"source.file_observation"|"source.resource.observe"|"source.resource.cancel")) {
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
                    worker_model_protocol.initialize(epoch);
                    worker_mcp.initialize(epoch);
                    worker_language.initialize(epoch);
                    worker_memory.initialize(epoch);
                    worker_context.initialize(epoch);
                    worker_resource.initialize(epoch);
                    worker_file_observation.initialize(epoch);
                    worker_plan.initialize(epoch);
                    worker_policy.initialize(epoch);
                    worker_source.initialize(epoch);
                    if let Some(storage) = kernel.storage.as_mut() {
                        let output = worker_response_tx.clone();
                        let epoch = epoch.to_owned();
                        storage.set_file_observation_hints(move |hint| {
                            if let Ok(mut value) = serde_json::to_value(hint) {
                                value["v"] = json!(1);
                                value["kind"] = json!("file-observation-invalidated");
                                value["kernelEpoch"] = json!(epoch);
                                let _ = output.send(value);
                            }
                        });
                        let commands = capture_completions.clone();
                        storage.set_file_lease_notify(move || { let _ = commands.send(WorkerRequest::FileLeasesChanged); });
                        storage.set_process_terminal_sender(process_terminals.clone());
                        let commands = capture_completions.clone();
                        storage.set_recovered_process_receipt_wake(move || {
                            let _ = commands.send(WorkerRequest::RecheckRecoveredProcessReceipts);
                        });
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
            if method.as_deref() == Some("authority.grant.retire")
                && response.get("ok") == Some(&Value::Bool(true))
            {
                if let Some(ids) = response
                    .get("result")
                    .and_then(|v| v.get("grantIds"))
                    .and_then(Value::as_array)
                {
                    for id in ids.iter().filter_map(Value::as_str) {
                        storage_subscriptions.close_grant(id);
                        mark_grant_revoked(&worker_revoked_grants, &worker_cancellations, id);
                    }
                }
            }
            if matches!(method.as_deref(),Some("source.authority.release"|"source.authority.release_scope")) && response["ok"]==true {
                let receipts=if method.as_deref()==Some("source.authority.release_scope"){response["result"]["released"].as_array().cloned().unwrap_or_default()}else{vec![response["result"].clone()]};
                for receipt in receipts {for grant in receipt["grantIds"].as_array().into_iter().flatten().filter_map(Value::as_str){storage_subscriptions.close_grant(grant);mark_grant_revoked(&worker_revoked_grants,&worker_cancellations,grant);}}
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
            if shutdown {
                if let Some(storage) = kernel.storage.as_mut() {
                    for id in storage.cancel_file_lease_waiters() {
                        if let Ok(mut active) = worker_cancellations.lock() { active.remove(&id); }
                        let _ = worker_response_tx.send(response_error(&id, &KernelError::Cancelled));
                    }
                }
            }
            // Retire execution ownership before its response becomes observable, so a client
            // using its returned credit cannot race a stale in-flight entry at admission.
            worker_cancellations
                .lock()
                .ok()
                .map(|mut active| active.remove(&id));
            respond!(response);
            if shutdown {
                stopping = true;
                if kernel.drained() {
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
                let wire_lane = if meta["method"].as_str().is_some_and(|method| KERNEL_CONTROL_RESPONSE_METHODS.contains(&method)) {
                    WireLane::Control
                } else { WireLane::Data };
                let mut active = cancellations
                    .lock()
                    .map_err(|_| "cancellation owner poisoned")?;
                if active.contains_key(id)
                    || active
                        .values()
                        .filter(|request| request.wire_lane == Some(wire_lane))
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
                        wire_lane: Some(wire_lane),
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
        if request.get("kind").and_then(Value::as_str)==Some("source-process-terminal") {if let Ok(frame)=serde_json::from_value(request){let _=agent_tx.send(crate::agent_runtime::Command::SourceProcessTerminal(frame));}continue;}
        if request.get("kind").and_then(Value::as_str)==Some("source-resource-response") {source_bridge.receive(request);continue;}
        if request.get("kind").and_then(Value::as_str) == Some("plan-response") {
            plan_bridge.receive(request);
            continue;
        }
        if request.get("kind").and_then(Value::as_str) == Some("file-observation-response") {
            file_observation_bridge.receive(request);
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
        if request.get("kind").and_then(Value::as_str) == Some("model-protocol-response") { model_protocol.receive(request); continue; }
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
                        let _ = request_tx.send(WorkerRequest::FileLeasesChanged);
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
        // Credits follow the response lane, as on the Host. A short control request
        // such as run.inspect can return a streamed body and owns ordinary credit.
        let wire_lane = if request["method"]
                .as_str()
                .is_some_and(|method| KERNEL_CONTROL_RESPONSE_METHODS.contains(&method))
        {
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
        if request["method"].as_str().is_some_and(|m|matches!(m,"source.resource.authorize"|"source.resource.execute"|"source.service.call"|"source.file_observation")) {
            let request_id=request["id"].as_str().unwrap_or_default().to_string();
            let cancel={let mut active=cancellations.lock().map_err(|_|"cancellation owner poisoned")?;
                let active=active.get_mut(&request_id).ok_or("source request lost admission")?;
                let cancel=active.runtime_cancel.clone().unwrap_or_default();if active.token.load(Ordering::Acquire){cancel.cancel();}
                active.token=cancel.shared_flag();active.runtime_cancel=Some(cancel.clone());cancel};
            if request_tx.send(WorkerRequest::SourceWire(request,cancel)).is_err(){break;}continue;
        }
        if request["method"].as_str().is_some_and(|method| {
            matches!(
                method,
                "process.write" | "process.resize" | "process.interaction.inspect"
            )
        }) {
            let request_id = request["id"].as_str().unwrap_or_default().to_string();
            let cancel = {
                let mut active = cancellations
                    .lock()
                    .map_err(|_| "cancellation owner poisoned")?;
                let active = active
                    .get_mut(&request_id)
                    .ok_or("interaction request lost admission")?;
                let cancel = active.runtime_cancel.clone().unwrap_or_default();
                if active.token.load(Ordering::Acquire) {
                    cancel.cancel();
                }
                active.token = cancel.shared_flag();
                active.runtime_cancel = Some(cancel.clone());
                cancel
            };
            release_request_credit(
                &cancellations,
                &response_tx,
                &request_id,
                request["method"].as_str().unwrap_or_default(),
            );
            let client = interaction_client.clone();
            let responses = response_tx.clone();
            let active = cancellations.clone();
            thread::spawn(move || {
                let result = client.wire(request, cancel);
                let response = match result {
                    Ok(value) => response_ok(&request_id, value),
                    Err(error) => response_error(&request_id, &error),
                };
                if let Ok(mut active) = active.lock() {
                    active.remove(&request_id);
                }
                let _ = responses.send(response);
            });
            continue;
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
            let (token, wake_cancel) = if matches!(
                request["method"].as_str(),
                Some(
                    "runtime.followup.register"
                        | "runtime.followup.file.observe"
                        | "runtime.followup.file.release"
                )
            ) {
                let request_id = request["id"].as_str().unwrap_or_default();
                let mut active = cancellations
                    .lock()
                    .map_err(|_| "cancellation owner poisoned")?;
                let active = active
                    .get_mut(request_id)
                    .ok_or("file observation lost admission")?;
                let cancel = active.runtime_cancel.clone().unwrap_or_default();
                if active.token.load(Ordering::Acquire) {
                    cancel.cancel();
                }
                active.token = cancel.shared_flag();
                active.runtime_cancel = Some(cancel.clone());
                (cancel.shared_flag(), Some(cancel))
            } else {
                (token, None)
            };
            // Enqueue the intent before fast OS control. A resulting terminal fact can then
            // never overtake its cancel command in the owner's FIFO and lose causality.
            if agent_tx
                .send(crate::agent_runtime::Command::Request {
                    value: request,
                    cancellation: token,
                    wake_cancel,
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
    model_protocol.close();
    mcp_bridge.close();
    language_bridge.close();
    memory_bridge.close();
    context_bridge.close();
    resource_bridge.close();
    file_observation_bridge.close();
    plan_bridge.close();
    policy_bridge.close();
    source_bridge.close();
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

#[cfg(test)]
#[path = "runtime_inventory_tests.rs"]
mod file_inventory_tests;

#[cfg(test)]
#[path = "runtime_nested_credit_tests.rs"]
mod nested_credit_tests;
