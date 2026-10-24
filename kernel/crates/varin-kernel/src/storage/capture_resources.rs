//! Source bodies and immutable-object verification stay outside the catalog actor.
//! A stored capture returns once for exact-hash retention, then resumes under the
//! original request and physical lease. Retention preserves bytes, never authority.
use super::file_resource_leases::{canonical_lease_path, covers, RetainedFileLease};
use super::file_resources::{
    file_mode, parse_file_params, resolve_admitted_resource, FileState, ResolvedFileResource,
};
use super::*;
use crate::model::CanonicalFileLeaseResource;
use crate::protocol_generated::{KernelFileCaptureBatchParams, KernelFileCaptureParams};
use super::file_identity::capture_identity;

#[derive(Clone)]
pub(super) struct CaptureReuse { identity: String, object_identity: Option<String>, state: FileState }

enum CaptureRequest {
    Single(KernelFileCaptureParams),
    Batch(KernelFileCaptureBatchParams),
    Observation { path: String },
}
fn paths_from_request(request: &CaptureRequest) -> &[String] {
    match request { CaptureRequest::Single(params) => std::slice::from_ref(&params.path),
        CaptureRequest::Batch(params) => &params.paths, CaptureRequest::Observation { path } => std::slice::from_ref(path) }
}
pub(crate) struct CaptureTask {
    request: CaptureRequest,
    root: FileRoot,
    grant: Grant,
    lease: FileLease,
    storage_root: PathBuf,
    cancellation: Arc<AtomicBool>,
    retained_objects: BTreeMap<String, blob_reads::BlobReadRetention>,
    expected: Option<BTreeMap<String, FileState>>,
    reusable: BTreeMap<String, CaptureReuse>,
    hooks: CaptureHooks,
}
pub(crate) struct HashedCapture {
    entries: Vec<HashedEntry>,
}
struct HashedEntry {
    path: String,
    absolute: PathBuf,
    state: FileState,
    identity: Option<String>,
    reused: bool,
}
pub(crate) struct CapturedBatch {
    entries: Vec<CapturedEntry>,
    publication: Option<CapturePublication>,
}
struct CapturePublication {
    response: Value,
    rows: Vec<(String, String, u64, String)>,
}
struct CapturedEntry {
    path: String,
    state: FileState,
    object: Option<CapturedObject>,
    identity: Option<String>,
}
enum CapturedObject {
    Staged(StagedFile),
    Retained,
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
    #[cfg(test)]
    counts: std::sync::Mutex<[u64; 5]>,
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
    fn source_read(&self, phase: CapturePhase, length: u64) {
        #[cfg(test)]
        {
            let mut counts = self.counts.lock().unwrap();
            match phase {
                CapturePhase::Read => {
                    counts[0] += 1;
                    counts[1] += length;
                }
                CapturePhase::VerifySource => {
                    counts[2] += 1;
                    counts[3] += length;
                }
                _ => {}
            }
        }
        #[cfg(not(test))]
        let _ = (phase, length);
    }
    fn staged(&self) {
        #[cfg(test)]
        {
            self.counts.lock().unwrap()[4] += 1;
        }
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
        // Never follow a replaced leaf or block on a substituted FIFO.
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
    hooks.source_read(phase, length);
    Ok((format!("sha256-{}", hex::encode(digest.finalize())), length))
}
impl CaptureTask {
    fn read_source(&self, path: &str) -> Result<HashedEntry, KernelError> {
        let resource = self.resolve(path)?;
        if let Some(prior) = self.reusable.get(path) {
            if capture_identity(&resource.absolute).as_deref() == Some(&prior.identity) {
                check(&self.cancellation)?;
                return Ok(HashedEntry { path: path.into(), absolute: resource.absolute,
                    state: prior.state.clone(), identity: Some(prior.identity.clone()), reused: true });
            }
        }
        read_entry(|| self.resolve(path), &self.cancellation, &self.hooks)
    }
    pub(crate) fn lease_id(&self) -> &str {
        &self.lease.lease_id
    }
    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancellation.clone()
    }
    pub(crate) fn retain_worker_objects(&self) -> Vec<blob_reads::BlobReadRetention> {
        self.retained_objects.values().cloned().collect()
    }
    fn paths(&self) -> &[String] {
        match &self.request {
            CaptureRequest::Single(params) => std::slice::from_ref(&params.path),
            CaptureRequest::Batch(params) => &params.paths,
            CaptureRequest::Observation { path } => std::slice::from_ref(path),
        }
    }
    pub(crate) fn store(&self) -> bool {
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
    fn capture_error(&self, error: KernelError) -> KernelError {
        match (&self.request, error) {
            (CaptureRequest::Single(_), KernelError::SnapshotChanged(message)) => {
                KernelError::Operation(message)
            }
            (_, error) => error,
        }
    }
    pub(crate) fn hash_sources(&self) -> Result<HashedCapture, KernelError> {
        let entries = self
            .paths()
            .iter()
            .map(|path| {
                self.read_source(path)
                    .map_err(|error| self.capture_error(error))
            })
            .collect::<Result<_, _>>()?;
        check(&self.cancellation)?;
        Ok(HashedCapture { entries })
    }
    /// A verification reads against the caller's captured state. A fresh observation
    /// still establishes its own reference with the original two source passes.
    pub(crate) fn run(&self) -> Result<CapturedBatch, KernelError> {
        if self.store() {
            return Err(KernelError::Storage(
                "stored capture requires exact-hash retention".into(),
            ));
        }
        let mut entries = Vec::with_capacity(self.paths().len());
        for path in self.paths() {
            let entry = if let Some(expected) = &self.expected {
                let observed = self.read_source(path)?;
                if expected.get(path) != Some(&observed.state) {
                    return Err(KernelError::SnapshotChanged(format!(
                        "captured content or metadata changed: {path}"
                    )));
                }
                CapturedEntry {
                    path: observed.path,
                    state: observed.state,
                    object: None,
                    identity: observed.identity,
                }
            } else {
                capture_entry(|| self.resolve(path), &self.cancellation, &self.hooks)
                    .map_err(|error| self.capture_error(error))?
            };
            entries.push(entry);
        }
        self.prepare_publication(entries)
    }
    pub(crate) fn finish_sources(
        &self,
        hashed: HashedCapture,
    ) -> Result<CapturedBatch, KernelError> {
        let mut entries = Vec::with_capacity(hashed.entries.len());
        for mut entry in hashed.entries {
            let captured = (|| {
                let object = if let FileState::RegularFile {
                    object_hash,
                    byte_length,
                    ..
                } = &entry.state
                {
                    if !self.retained_objects.contains_key(object_hash) {
                        return Err(KernelError::Storage(
                            "capture object is not retained".into(),
                        ));
                    }
                    let path = object_path(&self.storage_root, object_hash)?;
                    match fs::symlink_metadata(&path) {
                        Ok(metadata) => {
                            if !metadata.is_file() || metadata.file_type().is_symlink() {
                                return Err(KernelError::Storage(format!(
                                    "content object is corrupt: {object_hash}"
                                )));
                            }
                            if !entry.reused {
                            let mut file = open_regular(&path)?;
                            let (hash, length) = digest_reader(
                                &mut file,
                                None,
                                &self.cancellation,
                                &self.hooks,
                                CapturePhase::VerifyObject,
                            )?;
                            if hash != *object_hash || length != *byte_length {
                                return Err(KernelError::Storage(format!(
                                    "content object is corrupt: {object_hash}"
                                )));
                            }
                            }
                            Some(CapturedObject::Retained)
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            entry.reused = false;
                            let directory = self.storage_root.join("staging");
                            fs::create_dir_all(&directory)?;
                            Some(CapturedObject::Staged(StagedFile(
                                directory.join(format!("file-capture-{}", Uuid::new_v4())),
                            )))
                        }
                        Err(error) => return Err(error.into()),
                    }
                } else {
                    None
                };
                let path = entry.path.clone();
                verify_entry(
                    entry,
                    || self.resolve(&path),
                    object,
                    &self.cancellation,
                    &self.hooks,
                )
            })()
            .map_err(|error| self.capture_error(error))?;
            entries.push(captured);
        }
        self.prepare_publication(entries)
    }
    fn prepare_publication(
        &self,
        entries: Vec<CapturedEntry>,
    ) -> Result<CapturedBatch, KernelError> {
        check(&self.cancellation)?;
        let (operation_id, single) = match &self.request {
            CaptureRequest::Single(params) => (&params.operation_id, true),
            CaptureRequest::Batch(params) => (&params.operation_id, false),
            CaptureRequest::Observation { .. } => {
                return Ok(CapturedBatch {
                    entries,
                    publication: None,
                })
            }
        };
        if single && entries.len() != 1 {
            return Err(KernelError::Storage(
                "single capture changed cardinality".into(),
            ));
        }
        let mut rows = Vec::new();
        let mut result = Vec::with_capacity(entries.len());
        for (index, entry) in entries.iter().enumerate() {
            let owner = if let FileState::RegularFile {
                object_hash,
                byte_length,
                ..
            } = &entry.state
            {
                if self.store() {
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
        check(&self.cancellation)?;
        Ok(CapturedBatch {
            entries,
            publication: Some(CapturePublication { response, rows }),
        })
    }
    #[cfg(test)]
    pub(crate) fn hold_at(&mut self, phase: CapturePhase, hold: Box<dyn FnOnce() + Send>) {
        *self.hooks.hold.get_mut().unwrap() = Some((phase, hold));
    }
    #[cfg(test)]
    pub(crate) fn counts(&self) -> [u64; 5] {
        *self.hooks.counts.lock().unwrap()
    }
}

fn read_entry(
    mut resolve: impl FnMut() -> Result<ResolvedFileResource, KernelError>,
    cancel: &AtomicBool,
    hooks: &CaptureHooks,
) -> Result<HashedEntry, KernelError> {
    check(cancel)?;
    let resource = resolve()?;
    let identity = capture_identity(&resource.absolute);
    let metadata = match fs::symlink_metadata(&resource.absolute) {
        Ok(value) => Some(value),
        // Descendants of a non-directory are absent observations. This does not
        // authorize replacing that ancestor; mutations retain their own CAS.
        Err(error)
            if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) =>
        {
            None
        }
        Err(error) => return Err(error.into()),
    };
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
            let mut source = open_regular(&resource.absolute)?;
            let (hash, length) =
                digest_reader(&mut source, None, cancel, hooks, CapturePhase::Read)?;
            FileState::RegularFile {
                object_hash: hash,
                byte_length: length,
                mode: Some(file_mode(&metadata)),
            }
        }
        Some(_) => FileState::Unsupported,
    };
    check(cancel)?;
    if resolve()?.absolute != resource.absolute {
        return Err(KernelError::SnapshotChanged(format!(
            "file changed while being captured: {}",
            resource.path
        )));
    }
    if identity.is_some() && identity != capture_identity(&resource.absolute) {
        return Err(KernelError::SnapshotChanged(format!("file identity changed while being captured: {}", resource.path)));
    }
    Ok(HashedEntry {
        path: resource.path,
        absolute: resource.absolute,
        state,
        identity,
        reused: false,
    })
}
fn verify_entry(
    entry: HashedEntry,
    mut resolve: impl FnMut() -> Result<ResolvedFileResource, KernelError>,
    object: Option<CapturedObject>,
    cancel: &AtomicBool,
    hooks: &CaptureHooks,
) -> Result<CapturedEntry, KernelError> {
    check(cancel)?;
    if let FileState::RegularFile {
        object_hash,
        byte_length,
        mode,
    } = &entry.state
    {
        hooks.checkpoint(CapturePhase::VerifySource);
        check(cancel)?;
        let after_resource = resolve()?;
        let after = fs::symlink_metadata(&after_resource.absolute)?;
        if !after.is_file()
            || after.file_type().is_symlink()
            || Some(file_mode(&after)) != *mode
            || after_resource.absolute != entry.absolute
        {
            return Err(KernelError::SnapshotChanged(format!(
                "file changed while being captured: {}",
                entry.path
            )));
        }
        if entry.reused {
            if entry.identity.is_none() || capture_identity(&after_resource.absolute) != entry.identity {
                return Err(KernelError::SnapshotChanged(format!("reused file changed during capture: {}", entry.path)));
            }
        } else {
        let mut source = open_regular(&after_resource.absolute)?;
        let mut target = if let Some(CapturedObject::Staged(staged)) = &object {
            let file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&staged.0)?;
            hooks.staged();
            Some(file)
        } else {
            None
        };
        let (hash, length) = digest_reader(
            &mut source,
            target.as_mut(),
            cancel,
            hooks,
            CapturePhase::VerifySource,
        )?;
        if hash != *object_hash || length != *byte_length {
            return Err(KernelError::SnapshotChanged(format!(
                "file changed while being captured: {}",
                entry.path
            )));
        }
        if let Some(file) = target {
            file.sync_all()?;
            drop(file);
            hooks.checkpoint(CapturePhase::Staged);
        }
        }
    }
    check(cancel)?;
    // Metadata-only states still describe the admitted physical path.
    if resolve()?.absolute != entry.absolute {
        return Err(KernelError::SnapshotChanged(format!(
            "file changed while being captured: {}",
            entry.path
        )));
    }
    if entry.identity.is_some() && capture_identity(&entry.absolute) != entry.identity {
        return Err(KernelError::SnapshotChanged(format!("file identity changed during verification: {}", entry.path)));
    }
    Ok(CapturedEntry {
        path: entry.path,
        state: entry.state,
        object,
        identity: entry.identity,
    })
}
/// Original mutation/recovery observations share exactly the same source passes.
fn capture_entry(
    mut resolve: impl FnMut() -> Result<ResolvedFileResource, KernelError>,
    cancel: &AtomicBool,
    hooks: &CaptureHooks,
) -> Result<CapturedEntry, KernelError> {
    let entry = read_entry(&mut resolve, cancel, hooks)?;
    verify_entry(entry, resolve, None, cancel, hooks)
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
        let expected = match &request {
            CaptureRequest::Batch(params) if params.expected_states_json.is_some() => {
                let states: BTreeMap<String, FileState> =
                    serde_json::from_str(params.expected_states_json.as_ref().unwrap())?;
                if params.store
                    || states.len() != params.paths.len()
                    || params.paths.iter().any(|path| !states.contains_key(path))
                {
                    return Err(KernelError::Operation(
                        "verification requires one expected state per path and store:false".into(),
                    ));
                }
                Some(states)
            }
            _ => None,
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
            reusable: paths_from_request(&request).iter().filter_map(|path| {
                let prior = self.source_capture_cache.get(&(root.root_id.clone(), path.clone()))?;
                // Reuse carries no blob reference. GC may already have reclaimed
                // its bytes; only a still-installed, previously verified object is usable.
                if let FileState::RegularFile { object_hash, .. } = &prior.state {
                    if !self.verified_objects.contains(object_hash) || prior.object_identity.is_none()
                        || capture_identity(&object_path(&self.root, object_hash).ok()?) != prior.object_identity { return None; }
                }
                Some((path.clone(), prior.clone()))
            }).collect(),
            request,
            root,
            grant: grant.clone(),
            lease,
            storage_root: self.root.clone(),
            cancellation,
            retained_objects: BTreeMap::new(),
            expected,
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
        capture_entry(|| Ok(resource.clone()), &cancel, &CaptureHooks::default())
            .map(|entry| entry.state)
            .map_err(|error| match error {
                KernelError::SnapshotChanged(message) => KernelError::Operation(message),
                other => other,
            })
    }
    fn validate_capture(&self, task: &CaptureTask, grant: &Grant) -> Result<(), KernelError> {
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
        Ok(())
    }
    /// Retain every exact first-pass hash before a worker tests object existence.
    /// This also protects pending-delete/orphan objects without a second index.
    pub(crate) fn retain_capture_objects(
        &mut self,
        task: &mut CaptureTask,
        hashed: &HashedCapture,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        self.validate_capture(task, grant)?;
        if !task.store() || !task.retained_objects.is_empty() {
            return Err(KernelError::Storage("invalid capture continuation".into()));
        }
        for entry in &hashed.entries {
            check(&task.cancellation)?;
            if let FileState::RegularFile { object_hash, .. } = &entry.state {
                task.retained_objects
                    .entry(object_hash.clone())
                    .or_insert_with(|| self.blob_read_roots.retain(object_hash));
            }
        }
        Ok(())
    }
    pub(crate) fn publish_capture(
        &mut self,
        task: &CaptureTask,
        batch: CapturedBatch,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        self.validate_capture(task, grant)?;
        let workspace_id = match &task.request {
            CaptureRequest::Single(params) => &params.workspace_id,
            CaptureRequest::Batch(params) => &params.workspace_id,
            CaptureRequest::Observation { .. } => {
                return Err(KernelError::Storage(
                    "observation cannot publish objects".into(),
                ))
            }
        };
        let CapturePublication { response, rows } = batch
            .publication
            .ok_or_else(|| KernelError::Storage("capture publication was not prepared".into()))?;
        // Hits stay installed under exact-hash retention until the new owner commits.
        // Misses install only the verified second source pass.
        let mut installed = false;
        for entry in &batch.entries {
            check(&task.cancellation)?;
            if let FileState::RegularFile { object_hash, .. } = &entry.state {
                if !task.store() {
                    continue;
                }
                if !task.retained_objects.contains_key(object_hash) || entry.object.is_none() {
                    return Err(KernelError::Storage(
                        "capture object is not retained".into(),
                    ));
                }
                if let Some(CapturedObject::Staged(staged)) = &entry.object {
                    let object = object_path(&self.root, object_hash)?;
                    let shard = object.parent().expect("object shard");
                    if !shard.exists() {
                        fs::create_dir_all(shard)?;
                        sync_directory(&self.root.join("objects"))?;
                    }
                    durable_rename(&staged.0, &object)?;
                    sync_directory(shard)?;
                    installed = true;
                }
            }
        }
        if installed {
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
        for entry in &batch.entries {
            let key = (task.root.root_id.clone(), entry.path.clone());
            if let Some(identity) = &entry.identity {
                let object_identity = if let FileState::RegularFile { object_hash, .. } = &entry.state {
                    object_path(&self.root, object_hash).ok().and_then(|path| capture_identity(&path))
                } else { None };
                self.source_capture_cache.insert(key, CaptureReuse { identity: identity.clone(), object_identity, state: entry.state.clone() });
            } else { self.source_capture_cache.remove(&key); }
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
            retained_objects: BTreeMap::new(),
            expected: None,
            reusable: BTreeMap::new(),
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
