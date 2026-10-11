//! Filesystem bodies are copied and verified outside the catalog actor. Only the
//! actor admits leases and publishes object ownership; a cancelled worker retains
//! its exclusion until it has really stopped using the admitted source.
use super::file_resource_leases::{canonical_lease_path, covers, RetainedFileLease};
use super::file_resources::{
    file_mode, parse_file_params, resolve_admitted_resource, FileState, ResolvedFileResource,
};
use super::*;
use crate::model::CanonicalFileLeaseResource;
use crate::protocol_generated::{KernelFileCaptureBatchParams, KernelFileCaptureParams};

enum CaptureRequest {
    Single(KernelFileCaptureParams),
    Batch(KernelFileCaptureBatchParams),
    Observation { path: String },
}
pub(crate) struct CaptureTask {
    request: CaptureRequest,
    root: FileRoot,
    grant: Grant,
    lease: FileLease,
    storage_root: PathBuf,
    cancellation: Arc<AtomicBool>,
    hooks: CaptureHooks,
}
pub(crate) struct CapturedBatch {
    entries: Vec<CapturedEntry>,
}
struct CapturedEntry {
    path: String,
    state: FileState,
    staged: Option<StagedFile>,
}
struct StagedFile(PathBuf);
impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum CapturePhase {
    Read,
    VerifySource,
    VerifyObject,
    Staged,
}
#[derive(Default)]
struct CaptureHooks {
    #[cfg(test)]
    hold: std::sync::Mutex<Option<(CapturePhase, Box<dyn FnOnce() + Send>)>>,
}
impl CaptureHooks {
    fn checkpoint(&self, phase: CapturePhase) {
        #[cfg(test)]
        {
            let mut hold = self.hold.lock().unwrap();
            if hold
                .as_ref()
                .is_some_and(|(expected, _)| *expected == phase)
            {
                let (_, callback) = hold.take().unwrap();
                drop(hold);
                callback();
            }
        }
        #[cfg(not(test))]
        let _ = phase;
    }
}
fn check(cancel: &AtomicBool) -> Result<(), KernelError> {
    if cancel.load(Ordering::Acquire) {
        Err(KernelError::Cancelled)
    } else {
        Ok(())
    }
}
fn open_regular(path: &Path) -> Result<File, KernelError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A concurrently replaced leaf must not follow a link or block opening
        // a FIFO. File contents are read only after the actual handle is checked.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(KernelError::SnapshotChanged(
            "capture source is no longer a regular file".into(),
        ));
    }
    Ok(file)
}
fn digest_file(
    path: &Path,
    cancel: &AtomicBool,
    hooks: &CaptureHooks,
    phase: CapturePhase,
) -> Result<(String, u64), KernelError> {
    let mut file = open_regular(path)?;
    digest_reader(&mut file, None, cancel, hooks, phase)
}
fn digest_reader(
    source: &mut File,
    mut target: Option<&mut File>,
    cancel: &AtomicBool,
    hooks: &CaptureHooks,
    phase: CapturePhase,
) -> Result<(String, u64), KernelError> {
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut bytes = [0u8; 128 * 1024];
    loop {
        check(cancel)?;
        let count = source.read(&mut bytes)?;
        hooks.checkpoint(phase);
        check(cancel)?;
        if count == 0 {
            break;
        }
        if let Some(target) = target.as_mut() {
            target.write_all(&bytes[..count])?;
        }
        digest.update(&bytes[..count]);
        length = length
            .checked_add(count as u64)
            .ok_or_else(|| KernelError::Storage("capture length overflow".into()))?;
    }
    Ok((format!("sha256-{}", hex::encode(digest.finalize())), length))
}
impl CaptureTask {
    pub(crate) fn lease_id(&self) -> &str {
        &self.lease.lease_id
    }
    fn paths(&self) -> &[String] {
        match &self.request {
            CaptureRequest::Single(params) => std::slice::from_ref(&params.path),
            CaptureRequest::Batch(params) => &params.paths,
            CaptureRequest::Observation { path } => std::slice::from_ref(path),
        }
    }
    fn store(&self) -> bool {
        match &self.request {
            CaptureRequest::Single(params) => params.store,
            CaptureRequest::Batch(params) => params.store,
            CaptureRequest::Observation { .. } => false,
        }
    }
    fn resolve(&self, path: &str) -> Result<ResolvedFileResource, KernelError> {
        check(&self.cancellation)?;
        let resource = resolve_admitted_resource(&self.root, path, &self.grant, true)?;
        let requested = CanonicalFileLeaseResource {
            absolute: canonical_lease_path(resource.absolute.clone())?,
            subtree: false,
        };
        if !self
            .lease
            .canonical_resources
            .iter()
            .any(|held| covers(held, &requested))
        {
            return Err(KernelError::Authorization(
                "file resource is outside the held lease".into(),
            ));
        }
        Ok(resource)
    }
    pub(crate) fn run(&self) -> Result<CapturedBatch, KernelError> {
        let mut entries = Vec::with_capacity(self.paths().len());
        for path in self.paths() {
            let captured = capture_entry(
                || self.resolve(path),
                self.store(),
                &self.storage_root,
                &self.cancellation,
                &self.hooks,
            );
            // The original single-path API reports unstable captures as an operation failure.
            let captured = if matches!(self.request, CaptureRequest::Single(_)) {
                captured.map_err(|error| match error {
                    KernelError::SnapshotChanged(message) => KernelError::Operation(message),
                    other => other,
                })
            } else {
                captured
            };
            entries.push(captured?);
        }
        check(&self.cancellation)?;
        Ok(CapturedBatch { entries })
    }
    #[cfg(test)]
    pub(crate) fn hold_at(&mut self, phase: CapturePhase, hold: Box<dyn FnOnce() + Send>) {
        *self.hooks.hold.get_mut().unwrap() = Some((phase, hold));
    }
}

/// The one body algorithm, also used synchronously by original mutation/recovery observations.
fn capture_entry(
    mut resolve: impl FnMut() -> Result<ResolvedFileResource, KernelError>,
    store: bool,
    storage_root: &Path,
    cancel: &AtomicBool,
    hooks: &CaptureHooks,
) -> Result<CapturedEntry, KernelError> {
    check(cancel)?;
    let resource = resolve()?;
    let path = &resource.path;
    let metadata = match fs::symlink_metadata(&resource.absolute) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let mut staged = None;
    let state = match metadata {
        None => FileState::Missing,
        Some(metadata) if metadata.file_type().is_symlink() => FileState::Symlink {
            symlink_target: fs::read_link(&resource.absolute)?
                .into_os_string()
                .into_string()
                .map_err(|_| KernelError::Operation("symlink target is not UTF-8".into()))?,
            mode: Some(file_mode(&metadata)),
        },
        Some(metadata) if metadata.is_dir() => FileState::Directory {
            mode: Some(file_mode(&metadata)),
        },
        Some(metadata) if metadata.is_file() => {
            let mode = file_mode(&metadata);
            let mut source = open_regular(&resource.absolute)?;
            let (hash, length) = if store {
                let directory = storage_root.join("staging");
                fs::create_dir_all(&directory)?;
                let holder = StagedFile(directory.join(format!("file-capture-{}", Uuid::new_v4())));
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&holder.0)?;
                let identity = digest_reader(
                    &mut source,
                    Some(&mut file),
                    cancel,
                    hooks,
                    CapturePhase::Read,
                )?;
                file.sync_all()?;
                drop(file);
                staged = Some(holder);
                hooks.checkpoint(CapturePhase::Staged);
                check(cancel)?;
                identity
            } else {
                digest_reader(&mut source, None, cancel, hooks, CapturePhase::Read)?
            };
            // Re-resolve scope before the second pass. External filesystem writers
            // are not governed by kernel leases; changed captures must fail.
            let after_resource = resolve()?;
            let after = fs::symlink_metadata(&after_resource.absolute)?;
            if !after.is_file() || after.file_type().is_symlink() {
                return Err(KernelError::SnapshotChanged(format!(
                    "file changed while being captured: {path}"
                )));
            }
            let (after_hash, after_length) = digest_file(
                &after_resource.absolute,
                cancel,
                hooks,
                CapturePhase::VerifySource,
            )?;
            if !after.is_file()
                || after.file_type().is_symlink()
                || file_mode(&after) != mode
                || after_resource.absolute != resource.absolute
                || after_hash != hash
                || after_length != length
            {
                return Err(KernelError::SnapshotChanged(format!(
                    "file changed while being captured: {path}"
                )));
            }
            if store {
                let object = object_path(storage_root, &hash)?;
                match fs::symlink_metadata(&object) {
                    Ok(metadata) => {
                        if !metadata.is_file() || metadata.file_type().is_symlink() {
                            return Err(KernelError::Storage(format!(
                                "content object is corrupt: {hash}"
                            )));
                        }
                        let observed =
                            digest_file(&object, cancel, hooks, CapturePhase::VerifyObject);
                        // GC may remove an unreferenced object during verification.
                        match observed {
                            Ok((existing, size)) if existing == hash && size == length => {}
                            Err(KernelError::Storage(_)) if !object.exists() => {}
                            Err(KernelError::Cancelled) => return Err(KernelError::Cancelled),
                            _ => {
                                return Err(KernelError::Storage(format!(
                                    "content object is corrupt: {hash}"
                                )))
                            }
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
            FileState::RegularFile {
                object_hash: hash,
                byte_length: length,
                mode: Some(mode),
            }
        }
        Some(_) => FileState::Unsupported,
    };

    check(cancel)?;
    // Even a metadata-only state must still describe the admitted physical path.
    if resolve()?.absolute != resource.absolute {
        return Err(KernelError::SnapshotChanged(format!(
            "file changed while being captured: {path}"
        )));
    }
    Ok(CapturedEntry {
        path: resource.path,
        state,
        staged,
    })
}
impl Storage {
    pub(crate) fn prepare_capture(
        &mut self,
        method: &str,
        value: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<CaptureTask, KernelError> {
        check(&cancellation)?;
        let request = match method {
            "file.capture" => CaptureRequest::Single(parse_file_params(value)?),
            "file.captureBatch" => CaptureRequest::Batch(parse_file_params(value)?),
            _ => return Err(KernelError::Protocol("unknown capture method".into())),
        };
        let (root_id, workspace_id, paths, supplied_lease) = match &request {
            CaptureRequest::Single(params) => (
                &params.root_id,
                &params.workspace_id,
                std::slice::from_ref(&params.path),
                params.lease_id.as_deref(),
            ),
            CaptureRequest::Batch(params) => {
                if params.operation_id.is_empty() || params.paths.is_empty() {
                    return Err(KernelError::Operation(
                        "capture requires an operation identity and paths".into(),
                    ));
                }
                (
                    &params.root_id,
                    &params.workspace_id,
                    params.paths.as_slice(),
                    Some(params.lease_id.as_str()),
                )
            }
            CaptureRequest::Observation { .. } => unreachable!(),
        };
        let root = self.registered_file_root(root_id, grant)?;
        let mut seen = BTreeSet::new();
        let paths = paths
            .iter()
            .map(|path| {
                let path = super::file_resources::normalized_relative_path(path, true)?.0;
                if !seen.insert(path.clone()) {
                    return Err(KernelError::Operation("capture has duplicate paths".into()));
                }
                Ok(FileLeaseResource {
                    path,
                    subtree: false,
                })
            })
            .collect::<Result<Vec<_>, KernelError>>()?;
        let canonical_resources = self.canonical_lease_resources(root_id, &paths, grant)?;
        self.assert_canonical_file_lease(grant, root_id, &canonical_resources, supplied_lease)?;
        let lease = if let Some(id) = supplied_lease {
            self.file_leases
                .get(id)
                .expect("checked capture lease")
                .clone()
        } else {
            // The old synchronous capture excluded managed writers for its entire read.
            // Retain that exclusion using the existing physical lease authority.
            let lease_id = format!("file-capture:{}", Uuid::new_v4());
            let lease = FileLease {
                lease_id,
                root_id: root_id.clone(),
                workspace_id: workspace_id.clone(),
                grant_id: grant.grant_id.clone(),
                resources: paths,
                canonical_resources,
            };
            self.file_leases
                .insert(lease.lease_id.clone(), lease.clone());
            lease
        };
        self.retained_file_leases.insert(
            lease.lease_id.clone(),
            RetainedFileLease {
                release_requested: supplied_lease.is_none(),
            },
        );
        Ok(CaptureTask {
            request,
            root,
            grant: grant.clone(),
            lease,
            storage_root: self.root.clone(),
            cancellation,
            hooks: CaptureHooks::default(),
        })
    }

    /// Original mutation and reconciliation observations remain synchronous. Their
    /// body semantics use the same capture algorithm; these are not worker APIs.
    pub(super) fn capture_file_state(
        &self,
        resource: &ResolvedFileResource,
    ) -> Result<FileState, KernelError> {
        let cancel = self
            .cancellation
            .clone()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        capture_entry(
            || Ok(resource.clone()),
            false,
            &self.root,
            &cancel,
            &CaptureHooks::default(),
        )
        .map(|entry| entry.state)
        .map_err(|error| match error {
            KernelError::SnapshotChanged(message) => KernelError::Operation(message),
            other => other,
        })
    }
    pub(crate) fn publish_capture(
        &mut self,
        task: &CaptureTask,
        batch: CapturedBatch,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        check(&task.cancellation)?;
        let root = self.registered_file_root(&task.root.root_id, grant)?;
        if root.canonical_root != task.root.canonical_root {
            return Err(KernelError::Authorization(
                "capture root changed before publication".into(),
            ));
        }
        let held = self
            .file_leases
            .get(&task.lease.lease_id)
            .ok_or_else(|| KernelError::Operation("capture lease disappeared".into()))?;
        if held.grant_id != grant.grant_id || held.root_id != root.root_id {
            return Err(KernelError::Authorization(
                "capture lease owner changed".into(),
            ));
        }
        if held.workspace_id != task.lease.workspace_id
            || held.canonical_resources != task.lease.canonical_resources
        {
            return Err(KernelError::Authorization(
                "capture lease identity changed".into(),
            ));
        }
        let (workspace_id, operation_id, single) = match &task.request {
            CaptureRequest::Single(params) => (&params.workspace_id, &params.operation_id, true),
            CaptureRequest::Batch(params) => (&params.workspace_id, &params.operation_id, false),
            CaptureRequest::Observation { .. } => {
                return Err(KernelError::Storage(
                    "observation cannot publish objects".into(),
                ))
            }
        };
        if single && batch.entries.len() != 1 {
            return Err(KernelError::Storage(
                "single capture changed cardinality".into(),
            ));
        }
        let mut rows = Vec::new();
        let mut result = Vec::new();
        for (index, entry) in batch.entries.iter().enumerate() {
            let owner = if let FileState::RegularFile {
                object_hash,
                byte_length,
                ..
            } = &entry.state
            {
                if task.store() {
                    let operation = if single {
                        operation_id.clone()
                    } else {
                        format!("{operation_id}:{index}")
                    };
                    let owner = blob_owner_id(&operation);
                    rows.push((owner.clone(), object_hash.clone(), *byte_length, operation));
                    Some(owner)
                } else {
                    None
                }
            } else {
                None
            };
            result.push(json!({"path":entry.path,"stateJson":serde_json::to_string(&entry.state)?,"ownerId":owner}));
        }
        let response = if single {
            result.remove(0)
        } else {
            json!({"entries":result})
        };
        if serde_json::to_vec(&response)?.len() > crate::protocol::MAX_FRAME_BYTES / 2 {
            return Err(KernelError::Operation(
                "capture result exceeds the protocol frame; split the path batch".into(),
            ));
        }
        // Install only verified staging files. Always replacing with our staged
        // bytes closes a GC delete/recreate race without trusting a stale check.
        for entry in &batch.entries {
            check(&task.cancellation)?;
            if let (Some(staged), FileState::RegularFile { object_hash, .. }) =
                (&entry.staged, &entry.state)
            {
                let object = object_path(&self.root, object_hash)?;
                let shard = object.parent().expect("object shard");
                if !shard.exists() {
                    fs::create_dir_all(shard)?;
                    sync_directory(&self.root.join("objects"))?;
                }
                durable_rename(&staged.0, &object)?;
                sync_directory(shard)?;
            }
        }
        if !rows.is_empty() {
            sync_directory(&self.root.join("staging"))?;
        }
        check(&task.cancellation)?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let committed = (|| {
            for (owner, hash, length, operation) in &rows {
                self.conn.execute(
                    "INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES (?1,?2)",
                    params![
                        hash,
                        i64::try_from(*length).map_err(|_| KernelError::Operation(
                            "content object is too large".into()
                        ))?
                    ],
                )?;
                self.record_object_owner(
                    owner,
                    hash,
                    Some(workspace_id),
                    Some(operation),
                    &grant.grant_id,
                )?;
            }
            check(&task.cancellation)?;
            self.conn.execute_batch("COMMIT")?;
            Ok::<(), KernelError>(())
        })();
        if let Err(error) = committed {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(error);
        }
        for (_, hash, _, _) in rows {
            self.verified_objects.insert(hash);
        }
        Ok(response)
    }
}

impl CaptureTask {
    pub(super) fn observation(
        root: FileRoot,
        grant: Grant,
        path: String,
        lease: FileLease,
        storage_root: PathBuf,
        cancellation: Arc<AtomicBool>,
    ) -> Self {
        Self {
            request: CaptureRequest::Observation { path },
            root,
            grant,
            lease,
            storage_root,
            cancellation,
            hooks: CaptureHooks::default(),
        }
    }
}
impl CapturedBatch {
    pub(super) fn single_state(mut self) -> Result<FileState, KernelError> {
        if self.entries.len() != 1 {
            return Err(KernelError::Storage(
                "single file observation changed cardinality".into(),
            ));
        }
        Ok(self.entries.remove(0).state)
    }
}
