//! Runtime ownership of native workspaces. Metadata commands return to the one
//! Storage owner; mount startup, callbacks, file sealing and detach never run on
//! that owner's thread. A workspace owner is project-lived, while execution
//! leases retain their own original Run/Operation authority.
use crate::error::KernelError;
use crate::model::Grant;
use crate::protocol_generated::{
    KernelWorkspaceAddress as Address, KernelWorkspaceForkParams as Fork,
    KernelWorkspaceLeaseParams as Lease, KernelWorkspaceOpenParams as Open,
    KernelWorkspaceResultPrepareParams as PrepareResult,
};
use crate::storage::workspace_session::{Checkpoint, Session, StoragePort};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use uuid::Uuid;

fn error(code: &str, message: impl Into<String>) -> KernelError {
    KernelError::Execution(varin_runtime::execution::ExecutionError::new(code, message))
}
fn locked<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, KernelError> {
    mutex
        .lock()
        .map_err(|_| error("workspace_failed", "Workspace owner lock poisoned"))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Binding {
    pub branch_id: String,
    pub workspace_id: String,
    pub execution_workspace_id: String,
    pub generation: String,
    pub owner_grant_id: String,
}

struct Entry {
    binding: Binding,
    session: Arc<Session>,
    /// Close excludes new requests and leases; it never holds Storage's owner.
    lifecycle: RwLock<bool>,
    mount: Mutex<Option<MountWorker>>,
    view: Mutex<Option<Value>>,
    directory: PathBuf,
}
#[derive(Default)]
pub(crate) struct Workspaces {
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
    stopping: AtomicBool,
    adoptions: Mutex<BTreeSet<String>>,
}

impl Workspaces {
    #[cfg(test)]
    pub(crate) fn session(&self, branch: &str) -> Arc<Session> {
        self.entries
            .lock()
            .unwrap()
            .get(branch)
            .unwrap()
            .session
            .clone()
    }
    fn entry(&self, address: &Address) -> Result<Arc<Entry>, KernelError> {
        let entry = locked(&self.entries)?
            .get(&address.branch_id)
            .cloned()
            .ok_or_else(|| error("workspace_not_open", "The original workspace is not open"))?;
        if entry.binding.generation != address.generation {
            return Err(error(
                "workspace_generation_changed",
                "Workspace binding belongs to another mount lifetime",
            ));
        }
        Ok(entry)
    }
    fn owner(entry: &Entry, grant: &Grant) -> Result<(), KernelError> {
        if entry.binding.owner_grant_id != grant.grant_id {
            return Err(error(
                "workspace_owner_required",
                "This operation requires the original project workspace owner",
            ));
        }
        Ok(())
    }
    fn inspect(entry: &Entry, grant: &Grant) -> Result<Value, KernelError> {
        Ok(
            json!({"binding":entry.binding, "leases":entry.session.leases(grant, None)?,
            "mount":locked(&entry.view)?.clone(),
            "capabilities":{"nativeFiles":true,"mountCompiled":cfg!(feature="workspace-mount"),"hardlinks":!cfg!(windows),"symlinks":true,"xattrs":cfg!(unix),"losslessNativeNames":false,"activeWritableMappingFork":false}}),
        )
    }
    fn checkpoint(entry: &Entry) -> Result<Checkpoint, KernelError> {
        let mounted = entry.mount.try_lock().map_err(|_| {
            error(
                "workspace_mount_preparing",
                "The original workspace mount is still being prepared",
            )
        })?;
        if let Some(mount) = mounted.as_ref() {
            mount.checkpoint()
        } else {
            entry.session.checkpoint()
        }
    }
    pub(crate) fn execute(
        &self,
        port: StoragePort,
        notify_idle: Arc<dyn Fn() + Send + Sync>,
        method: &str,
        params: Value,
        grant: Grant,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, KernelError> {
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        if method == "workspace.adopt" {
            if self.stopping.load(Ordering::Acquire) {
                return Err(error("workspace_stopping", "Workspace service is stopping"));
            }
            let input: crate::protocol_generated::KernelWorkspaceAdoptParams =
                serde_json::from_value(params)?;
            let operation = input.operation_id.clone();
            if !locked(&self.adoptions)?.insert(operation.clone()) {
                return Err(error(
                    "workspace_adoption_active",
                    "The original source adoption is already running",
                ));
            }
            let result = crate::workspace_adoption::adopt(port, input, grant, cancelled);
            locked(&self.adoptions)?.remove(&operation);
            return result;
        }
        if method == "workspace.open" {
            if self.stopping.load(Ordering::Acquire) {
                return Err(error("workspace_stopping", "Workspace service is stopping"));
            }
            let args: Open = serde_json::from_value(params)?;
            // A short-lived model request cannot become the owner of a project
            // filesystem shared by later Runs or an external editor.
            if grant.run_id.is_some() || grant.operation_id.is_some() || grant.thread_id.is_some() {
                return Err(error("workspace_project_owner_required", "Open a workspace with its explicit project lifetime grant, then acquire execution leases"));
            }
            let session = Session::open(port.clone(), args.branch_id.clone(), grant.clone())?;
            session.on_native_idle(notify_idle);
            let workspace_id = grant.owning_workspace.clone().ok_or_else(|| {
                error(
                    "workspace_owner_required",
                    "Workspace project identity is missing",
                )
            })?;
            let directory = port.call(move |storage| Ok(storage.root().to_path_buf()))?;
            let entry = Arc::new(Entry {
                binding: Binding {
                    branch_id: args.branch_id.clone(),
                    workspace_id: workspace_id.clone(),
                    execution_workspace_id: grant
                        .execution_workspace
                        .clone()
                        .unwrap_or(workspace_id),
                    generation: session.identity().to_string(),
                    owner_grant_id: grant.grant_id.clone(),
                },
                session,
                lifecycle: RwLock::new(true),
                mount: Mutex::new(None),
                view: Mutex::new(None),
                directory,
            });
            let mut entries = locked(&self.entries)?;
            if self.stopping.load(Ordering::Acquire) {
                let retained = entries.contains_key(&args.branch_id);
                drop(entries);
                if !retained {
                    entry.session.close()?;
                }
                return Err(KernelError::Cancelled);
            }
            let selected = entries.entry(args.branch_id).or_insert(entry).clone();
            drop(entries);
            let live = selected
                .lifecycle
                .read()
                .map_err(|_| error("workspace_failed", "Workspace lifecycle lock poisoned"))?;
            if !*live {
                return Err(error(
                    "workspace_closed",
                    "The original workspace just closed",
                ));
            }
            Self::owner(&selected, &grant)?;
            return Self::inspect(&selected, &grant);
        }
        let address = Address {
            branch_id: params["branchId"].as_str().unwrap_or_default().to_owned(),
            generation: params["generation"].as_str().unwrap_or_default().to_owned(),
        };
        let entry = self.entry(&address)?;
        if method == "workspace.close" {
            let _: Address = serde_json::from_value(params)?;
            Self::owner(&entry, &grant)?;
            return self.close(&address, false);
        }
        if method == "workspace.inspect" {
            let _: Address = serde_json::from_value(params)?;
            // Observation does not wait behind a mount or detach worker.
            entry.session.admit(&grant, "", false)?;
            return Self::inspect(&entry, &grant);
        }
        let live = entry
            .lifecycle
            .read()
            .map_err(|_| error("workspace_failed", "Workspace lifecycle lock poisoned"))?;
        if !*live {
            return Err(error(
                "workspace_closed",
                "The original workspace has closed",
            ));
        }
        match method {
            "workspace.acquire" | "workspace.release" => {
                let args: Lease = serde_json::from_value(params)?;
                if self.stopping.load(Ordering::Acquire) && method == "workspace.acquire" {
                    return Err(error("workspace_stopping", "Workspace service is stopping"));
                }
                entry.session.leases(
                    &grant,
                    Some((&args.lease_id, method == "workspace.release")),
                )?;
                Ok(
                    json!({"binding":entry.binding,"leaseId":args.lease_id,"released":method=="workspace.release"}),
                )
            }
            "workspace.mount" => {
                let _: Address = serde_json::from_value(params)?;
                Self::owner(&entry, &grant)?;
                if self.stopping.load(Ordering::Acquire) {
                    return Err(error("workspace_stopping", "Workspace service is stopping"));
                }
                let mut mounted = locked(&entry.mount)?;
                if mounted.is_none() {
                    let path = entry
                        .directory
                        .join("managed/workspaces")
                        .join(&entry.binding.generation);
                    let id = Uuid::new_v4().to_string();
                    *locked(&entry.view)? = Some(
                        json!({"mountId":id,"path":null,"backend":backend(),"state":"starting"}),
                    );
                    let started =
                        MountWorker::start(entry.session.clone(), path.clone(), cancelled);
                    let (worker, startup_error) = match started {
                        Ok(started) => started,
                        Err(failure) => {
                            *locked(&entry.view)? = Some(
                                json!({"mountId":id,"path":null,"backend":backend(),"state":"failed","error":failure.to_string()}),
                            );
                            return Err(failure);
                        }
                    };
                    *locked(&entry.view)? = Some(
                        json!({"mountId":id,"path":if worker.ready {Some(path)} else {None},"backend":backend(),"state":if worker.ready {"ready"} else {"cleanup_pending"}}),
                    );
                    *mounted = Some(worker);
                    if let Some(failure) = startup_error {
                        return Err(failure);
                    }
                }
                if !mounted.as_ref().is_some_and(|mount| mount.ready) {
                    return Err(error(
                        "workspace_mount_not_ready",
                        "The original mount requires cleanup after its failed startup",
                    ));
                }
                drop(mounted);
                Self::inspect(&entry, &grant)
            }
            "workspace.fork" => {
                let args: Fork = serde_json::from_value(params)?;
                entry.session.admit(&grant, "", true)?;
                if let Some(result) = entry.session.replayed_fork(
                    &args.operation_id,
                    &args.target_branch_id,
                    grant.clone(),
                )? {
                    return Ok(result);
                }
                let boundary = Self::checkpoint(&entry)?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                let fork = boundary.fork_for(
                    &args.target_branch_id,
                    &args.operation_id,
                    grant,
                    cancelled,
                )?;
                boundary.release()?;
                Ok(fork)
            }
            "workspace.result.prepare" => {
                let args: PrepareResult = serde_json::from_value(params)?;
                let candidate = if let Some(candidate) = entry
                    .session
                    .replayed_result(&args.publication_id, grant.clone())?
                {
                    candidate
                } else {
                    let boundary = Self::checkpoint(&entry)?;
                    let candidate =
                        boundary.prepare_result(&args.publication_id, grant, cancelled)?;
                    boundary.release()?;
                    candidate
                };
                serde_json::to_value(crate::storage::result_publication::candidate_view(
                    &candidate,
                )?)
                .map_err(Into::into)
            }
            _ => Err(KernelError::Protocol(format!(
                "Unknown workspace method: {method}"
            ))),
        }
    }
    fn close(&self, address: &Address, shutting_down: bool) -> Result<Value, KernelError> {
        let entry = self.entry(address)?;
        let mut live = entry
            .lifecycle
            .write()
            .map_err(|_| error("workspace_failed", "Workspace lifecycle lock poisoned"))?;
        if !shutting_down && entry.session.lease_count()? != 0 {
            return Err(error("workspace_in_use", "Original execution leases must stop their processes and release before closing this workspace"));
        }
        if let Some(view) = locked(&entry.view)?.as_mut() {
            view["state"] = json!("cleanup_pending");
            view["path"] = Value::Null;
        }
        if let Some(mount) = locked(&entry.mount)?.as_mut() {
            mount.stop()?;
        }
        entry.session.close()?;
        entry.session.release_drained_leases()?;
        *live = false;
        let mut entries = locked(&self.entries)?;
        if entries
            .get(&address.branch_id)
            .is_some_and(|current| Arc::ptr_eq(current, &entry))
        {
            entries.remove(&address.branch_id);
        }
        Ok(json!({"branchId":address.branch_id,"generation":address.generation,"closed":true}))
    }
    /// Kernel keeps servicing StoragePort commands until this worker finishes.
    /// Failure retains the original entry, mount worker and dirty data.
    pub(crate) fn shutdown(&self) -> Result<(), KernelError> {
        self.stopping.store(true, Ordering::Release);
        let entries = locked(&self.entries)?
            .values()
            .map(|entry| Address {
                branch_id: entry.binding.branch_id.clone(),
                generation: entry.binding.generation.clone(),
            })
            .collect::<Vec<_>>();
        let mut failures = vec![];
        let mut native_pending = vec![];
        for address in entries {
            if let Err(failure) = self.close(&address, true) {
                if matches!(&failure,KernelError::Execution(error) if error.code=="workspace_native_handles_active")
                {
                    native_pending.push(failure.to_string());
                } else {
                    failures.push(failure.to_string());
                }
            }
        }
        if failures.is_empty() && !native_pending.is_empty() {
            Err(error(
                "workspace_native_handles_active",
                native_pending.join("; "),
            ))
        } else if failures.is_empty() {
            Ok(())
        } else {
            failures.extend(native_pending);
            Err(error("workspace_cleanup_pending", failures.join("; ")))
        }
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.lock().is_ok_and(|entries| entries.is_empty())
    }
}

fn backend() -> &'static str {
    if cfg!(windows) {
        "winfsp"
    } else if cfg!(target_os = "macos") {
        "macfuse"
    } else {
        "fuse"
    }
}

enum MountCommand {
    Checkpoint(mpsc::Sender<Result<Checkpoint, KernelError>>),
    Stop(mpsc::Sender<Result<(), KernelError>>),
}
struct MountWorker {
    sender: mpsc::Sender<MountCommand>,
    thread: Option<std::thread::JoinHandle<()>>,
    ready: bool,
}
impl MountWorker {
    #[cfg(feature = "workspace-mount")]
    fn start(
        session: Arc<Session>,
        path: PathBuf,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(Self, Option<KernelError>), KernelError> {
        let (sender, receiver) = mpsc::channel();
        let (ready, readiness) = mpsc::channel();
        let target = path.clone();
        let thread = std::thread::spawn(move || {
            let prepared = (|| {
                std::fs::create_dir_all(&target)?;
                crate::workspace_mount::Mount::start(session, &target)
            })();
            let mut mount = match prepared {
                Ok(mount) => mount,
                Err(failure) => {
                    let _ = ready.send(Err(failure));
                    return;
                }
            };
            let startup_error = mount.wait_ready_cancelled(&cancelled).err();
            let active = startup_error.is_none();
            if ready.send(Ok(startup_error)).is_err() {
                let _ = mount.stop();
                return;
            }
            while let Ok(command) = receiver.recv() {
                match command {
                    MountCommand::Checkpoint(reply) => {
                        let _ = reply.send(if active { mount.checkpoint() } else {
                            Err(error("workspace_mount_not_ready", "Original mount startup failed; finish its cleanup before reopening"))
                        });
                    }
                    MountCommand::Stop(reply) => {
                        let result = mount.stop();
                        let stopped = result.is_ok();
                        let _ = reply.send(result);
                        if stopped {
                            let _ = std::fs::remove_dir(&target);
                            return;
                        }
                    }
                }
            }
            let _ = mount.stop();
        });
        match readiness.recv().map_err(|_| {
            error(
                "workspace_mount_failed",
                "Mount worker stopped before readiness",
            )
        })? {
            Ok(startup_error) => Ok((
                Self {
                    sender,
                    thread: Some(thread),
                    ready: startup_error.is_none(),
                },
                startup_error,
            )),
            Err(failure) => {
                let _ = thread.join();
                Err(failure)
            }
        }
    }
    #[cfg(not(feature = "workspace-mount"))]
    fn start(
        _: Arc<Session>,
        _: PathBuf,
        _: Arc<AtomicBool>,
    ) -> Result<(Self, Option<KernelError>), KernelError> {
        Err(error(
            "workspace_backend_unavailable",
            "This kernel was built without native mount support",
        ))
    }
    fn checkpoint(&self) -> Result<Checkpoint, KernelError> {
        let (reply, result) = mpsc::channel();
        self.sender
            .send(MountCommand::Checkpoint(reply))
            .map_err(|_| {
                error(
                    "workspace_mount_disconnected",
                    "Original mount worker has stopped",
                )
            })?;
        result.recv().map_err(|_| {
            error(
                "workspace_mount_disconnected",
                "Original mount disconnected during its version boundary",
            )
        })?
    }
    fn stop(&mut self) -> Result<(), KernelError> {
        if self.thread.is_none() {
            return Ok(());
        }
        let (reply, result) = mpsc::channel();
        self.sender.send(MountCommand::Stop(reply)).map_err(|_| {
            error(
                "workspace_mount_disconnected",
                "Original mount worker has stopped",
            )
        })?;
        result.recv().map_err(|_| {
            error(
                "workspace_mount_disconnected",
                "Original mount disconnected during cleanup",
            )
        })??;
        if let Some(thread) = self.thread.take() {
            thread.join().map_err(|_| {
                error(
                    "workspace_mount_failed",
                    "Mount worker failed during callback drainage",
                )
            })?;
        }
        Ok(())
    }
}
