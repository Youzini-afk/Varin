//! Filesystem bodies are copied and verified outside the catalog actor. Only the
//! actor admits leases and publishes object ownership; a cancelled worker retains
//! its exclusion until it has really stopped using the admitted source.
use super::file_resources::{file_mode, parse_file_params, resolve_admitted_resource, FileState};
use super::*;
use crate::protocol_generated::KernelFileCaptureBatchParams;

pub(crate) struct CaptureTask {
    params: KernelFileCaptureBatchParams,
    root: FileRoot,
    grant: Grant,
    storage_root: PathBuf,
    cancellation: Arc<AtomicBool>,
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
fn digest_file(path: &Path, cancel: &AtomicBool) -> Result<(String, u64), KernelError> {
    let mut file = open_regular(path)?;
    digest_reader(&mut file, None, cancel)
}
fn digest_reader(
    source: &mut File,
    mut target: Option<&mut File>,
    cancel: &AtomicBool,
) -> Result<(String, u64), KernelError> {
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut bytes = [0u8; 128 * 1024];
    loop {
        check(cancel)?;
        let count = source.read(&mut bytes)?;
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
        &self.params.lease_id
    }
    pub(crate) fn run(&self) -> Result<CapturedBatch, KernelError> {
        let mut entries = Vec::with_capacity(self.params.paths.len());
        for path in &self.params.paths {
            check(&self.cancellation)?;
            let resource = resolve_admitted_resource(&self.root, path, &self.grant, true)?;
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
                        .map_err(|_| {
                            KernelError::Operation("symlink target is not UTF-8".into())
                        })?,
                    mode: Some(file_mode(&metadata)),
                },
                Some(metadata) if metadata.is_dir() => FileState::Directory {
                    mode: Some(file_mode(&metadata)),
                },
                Some(metadata) if metadata.is_file() => {
                    let mode = file_mode(&metadata);
                    let mut source = open_regular(&resource.absolute)?;
                    let (hash, length) = if self.params.store {
                        let directory = self.storage_root.join("staging");
                        fs::create_dir_all(&directory)?;
                        let holder =
                            StagedFile(directory.join(format!("file-capture-{}", Uuid::new_v4())));
                        let mut file = OpenOptions::new()
                            .create_new(true)
                            .write(true)
                            .open(&holder.0)?;
                        let identity =
                            digest_reader(&mut source, Some(&mut file), &self.cancellation)?;
                        file.sync_all()?;
                        drop(file);
                        staged = Some(holder);
                        identity
                    } else {
                        digest_reader(&mut source, None, &self.cancellation)?
                    };
                    // Re-resolve scope before the second pass. External filesystem writers
                    // are not governed by kernel leases; changed captures must fail.
                    let after_resource =
                        resolve_admitted_resource(&self.root, path, &self.grant, true)?;
                    let after = fs::symlink_metadata(&after_resource.absolute)?;
                    if !after.is_file() || after.file_type().is_symlink() {
                        return Err(KernelError::SnapshotChanged(format!(
                            "file changed while being captured: {path}"
                        )));
                    }
                    let (after_hash, after_length) =
                        digest_file(&after_resource.absolute, &self.cancellation)?;
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
                    if self.params.store {
                        let object = object_path(&self.storage_root, &hash)?;
                        match fs::symlink_metadata(&object) {
                            Ok(metadata) => {
                                if !metadata.is_file() || metadata.file_type().is_symlink() {
                                    return Err(KernelError::Storage(format!(
                                        "content object is corrupt: {hash}"
                                    )));
                                }
                                let observed = digest_file(&object, &self.cancellation);
                                // GC may remove an unreferenced object during verification.
                                match observed {
                                    Ok((existing, size)) if existing == hash && size == length => {}
                                    Err(KernelError::Storage(_)) if !object.exists() => {}
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
            entries.push(CapturedEntry {
                path: resource.path,
                state,
                staged,
            });
        }
        check(&self.cancellation)?;
        Ok(CapturedBatch { entries })
    }
}
impl Storage {
    pub(crate) fn prepare_capture_batch(
        &mut self,
        value: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<CaptureTask, KernelError> {
        check(&cancellation)?;
        let params: KernelFileCaptureBatchParams = parse_file_params(value)?;
        if params.operation_id.is_empty() || params.paths.is_empty() {
            return Err(KernelError::Operation(
                "capture requires an operation identity and paths".into(),
            ));
        }
        let root = self.registered_file_root(&params.root_id, grant)?;
        let mut seen = BTreeSet::new();
        let paths = params
            .paths
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
        self.assert_file_lease(grant, &params.root_id, &paths, Some(&params.lease_id))?;
        self.retained_file_leases.insert(
            params.lease_id.clone(),
            super::file_resource_leases::RetainedFileLease {
                release_requested: false,
            },
        );
        Ok(CaptureTask {
            params,
            root,
            grant: grant.clone(),
            storage_root: self.root.clone(),
            cancellation,
        })
    }
    pub(crate) fn publish_capture_batch(
        &mut self,
        task: &CaptureTask,
        batch: CapturedBatch,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        check(&task.cancellation)?;
        let root = self.registered_file_root(&task.params.root_id, grant)?;
        if root.canonical_root != task.root.canonical_root {
            return Err(KernelError::Authorization(
                "capture root changed before publication".into(),
            ));
        }
        let held = self
            .file_leases
            .get(&task.params.lease_id)
            .ok_or_else(|| KernelError::Operation("capture lease disappeared".into()))?;
        if held.grant_id != grant.grant_id || held.root_id != root.root_id {
            return Err(KernelError::Authorization(
                "capture lease owner changed".into(),
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
                if task.params.store {
                    let operation = format!("{}:{index}", task.params.operation_id);
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
        let response = json!({"entries":result});
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
                    Some(&task.params.workspace_id),
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
        storage_root: PathBuf,
        cancellation: Arc<AtomicBool>,
    ) -> Self {
        Self {
            params: KernelFileCaptureBatchParams {
                operation_id: String::new(),
                workspace_id: root.owning_workspace_id.clone(),
                root_id: root.root_id.clone(),
                paths: vec![path],
                store: false,
                lease_id: String::new(),
            },
            root,
            grant,
            storage_root,
            cancellation,
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
