//! Canonical workspace file resources and cross-request path leases.
//!
//! R2 keeps editor buffers in the TypeScript Document Registry while moving
//! controlled disk identity, capture, apply, and CRUD side effects into this
//! kernel. File roots are epoch-local registrations: the Host must re-admit a
//! Documents-authorized canonical root after every kernel restart.
use super::*;
use crate::protocol_generated::{
    KernelFileApplyParams, KernelFileMkdirParams, KernelFileOperationListParams,
    KernelFileOperationReconcileParams, KernelFileRemoveParams, KernelFileRenameParams,
    KernelFileRootRegisterParams,
};
use serde::de::DeserializeOwned;
use std::path::{Component, Path};

pub(super) use varin_runtime::catalog::followups::FileState;

#[derive(Clone, Debug)]
pub(super) struct ResolvedFileResource {
    pub(super) path: String,
    pub(super) absolute: PathBuf,
}

/// Pure identity shared by registration and immutable Source receipt verification.
pub(super) fn file_root_identity(workspace: &str, execution_workspace: &str, canonical: &Path) -> String {
    let identity = format!("file-root-v2\0{workspace}\0{execution_workspace}\0{}", canonical.to_string_lossy());
    format!("file-root-{}", hex::encode(Sha256::digest(identity.as_bytes())))
}

fn file_params_value(params_value: &Value) -> Value {
    let mut params = params_value.clone();
    if let Some(object) = params.as_object_mut() {
        object.remove("__pathScopes");
    }
    params
}

fn file_operation_identity(params_value: &Value) -> Result<(Value, String), KernelError> {
    let mut identity = file_params_value(params_value);
    if let Some(object) = identity.as_object_mut() {
        object.remove("leaseId");
    }
    let hash = hash_json(&identity)?;
    Ok((identity, hash))
}

pub(super) fn parse_file_params<T: DeserializeOwned>(
    params_value: &Value,
) -> Result<T, KernelError> {
    let mut value = file_params_value(params_value);
    // This field is injected only by the typed native adapter. Public wire DTO
    // validation rejects it; it remains part of the durable intent identity.
    if let Some(object) = value.as_object_mut() {
        object.remove("__nativeRequestHash");
        object.remove("__nativeGrantId");
        object.remove("__nativeEpoch");
        object.remove("__recoveryTurn");
        object.remove("__recoveryBeforeOwner");
        object.remove("__recoveryTool");
    }
    Ok(serde_json::from_value(value)?)
}

pub(super) fn file_mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o7777
    }
    #[cfg(windows)]
    {
        if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        0o666
    }
}

pub(super) fn apply_mode(path: &Path, mode: Option<u32>) -> Result<(), KernelError> {
    let Some(mode) = mode else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))?;
    }
    #[cfg(windows)]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(path, permissions)?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn path_inside(root: &Path, candidate: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |path: &Path| path.to_string_lossy().replace('/', "\\").to_lowercase();
        let root = normalize(root);
        let candidate = normalize(candidate);
        candidate == root || candidate.starts_with(&(root + "\\"))
    }
    #[cfg(not(windows))]
    {
        candidate == root || candidate.starts_with(root)
    }
}

pub(super) fn normalized_relative_path(
    value: &str,
    allow_root: bool,
) -> Result<(String, PathBuf), KernelError> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty() {
        if allow_root {
            return Ok((String::new(), PathBuf::new()));
        }
        return Err(KernelError::Authorization(
            "workspace root cannot be mutated directly".to_string(),
        ));
    }
    let mut result = PathBuf::new();
    let mut pieces = Vec::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(segment) => {
                let text = segment.to_str().ok_or_else(|| {
                    KernelError::Authorization("file path is not UTF-8".to_string())
                })?;
                if text.is_empty() {
                    return Err(KernelError::Authorization(
                        "file path contains an empty segment".to_string(),
                    ));
                }
                pieces.push(text.to_string());
                result.push(segment);
            }
            _ => {
                return Err(KernelError::Authorization(format!(
                    "file path is not relative and normalized: {value}"
                )))
            }
        }
    }
    if pieces.is_empty() && !allow_root {
        return Err(KernelError::Authorization(
            "workspace root cannot be mutated directly".to_string(),
        ));
    }
    Ok((pieces.join("/"), result))
}

fn remove_existing(path: &Path) -> Result<(), KernelError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir(path).map_err(Into::into)
        }
        Ok(_) => fs::remove_file(path).map_err(Into::into),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn materialize_side_path(path: &str, operation_id: &str, kind: &str) -> String {
    let digest = hex::encode(Sha256::digest(operation_id.as_bytes()));
    format!("{path}.varin-{kind}-{}", &digest[..16])
}

pub(super) fn materialized_expected_state(state: &PathState) -> FileState {
    match state {
        PathState::RegularFile {
            object_hash,
            byte_length,
            mode: _mode,
        } => FileState::RegularFile {
            object_hash: object_hash.clone(),
            byte_length: *byte_length,
            #[cfg(unix)]
            mode: Some(*_mode),
            #[cfg(windows)]
            mode: Some(if _mode & 0o200 == 0 { 0o444 } else { 0o666 }),
            #[cfg(not(any(unix, windows)))]
            mode: None,
        },
        PathState::Directory { mode: _mode } => FileState::Directory {
            #[cfg(unix)]
            mode: *_mode,
            #[cfg(windows)]
            mode: _mode.map(|mode| if mode & 0o200 == 0 { 0o444 } else { 0o666 }),
            #[cfg(not(any(unix, windows)))]
            mode: None,
        },
        PathState::Symlink {
            symlink_target,
            mode: _mode,
        } => FileState::Symlink {
            symlink_target: symlink_target.clone(),
            #[cfg(unix)]
            mode: *_mode,
            #[cfg(not(unix))]
            mode: None,
        },
        PathState::Missing => FileState::Missing,
        PathState::Unsupported => FileState::Unsupported,
    }
}

#[cfg(target_os = "linux")]
fn clone_file(source: &Path, destination: &Path) -> Result<bool, KernelError> {
    use std::os::fd::AsRawFd;
    const FICLONE: std::os::raw::c_ulong = 0x4004_9409;
    unsafe extern "C" {
        fn ioctl(
            fd: std::os::raw::c_int,
            request: std::os::raw::c_ulong,
            ...
        ) -> std::os::raw::c_int;
    }
    let source_file = File::open(source)?;
    let target_file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(destination)?;
    let result = unsafe { ioctl(target_file.as_raw_fd(), FICLONE, source_file.as_raw_fd()) };
    if result == 0 {
        target_file.sync_all()?;
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    let unsupported = matches!(error.raw_os_error(), Some(18 | 22 | 25 | 38 | 95));
    drop(target_file);
    let _ = fs::remove_file(destination);
    if unsupported {
        return Ok(false);
    }
    Err(error.into())
}

#[cfg(target_os = "macos")]
fn clone_file(source: &Path, destination: &Path) -> Result<bool, KernelError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn clonefile(
            source: *const std::os::raw::c_char,
            target: *const std::os::raw::c_char,
            flags: u32,
        ) -> i32;
    }
    let source_c = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| KernelError::Operation("materialize source contains NUL".to_string()))?;
    let target_c = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| KernelError::Operation("materialize destination contains NUL".to_string()))?;
    let result = unsafe { clonefile(source_c.as_ptr(), target_c.as_ptr(), 0) };
    if result == 0 {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(destination)?
            .sync_all()?;
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    let unsupported = matches!(error.raw_os_error(), Some(18 | 22 | 45 | 78));
    let _ = fs::remove_file(destination);
    if unsupported {
        return Ok(false);
    }
    Err(error.into())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn clone_file(_source: &Path, _destination: &Path) -> Result<bool, KernelError> {
    Ok(false)
}

pub(super) fn copy_object_to(
    source: &Path,
    destination: &Path,
    cancellation: &AtomicBool,
) -> Result<&'static str, KernelError> {
    if cancellation.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    if clone_file(source, destination)? {
        return Ok("reflink");
    }
    let mut reader = File::open(source)?;
    let mut target = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        target.write_all(&buffer[..count])?;
    }
    target.sync_all()?;
    Ok("copy")
}

pub(super) fn durable_directory_rename(source: &Path, target: &Path) -> Result<(), KernelError> {
    #[cfg(windows)]
    {
        // Directory moves target an absent sibling. Recovery relies on the
        // persisted intent and observed staging/live/backup state, not on an
        // unsupported claim of atomic durability across SQLite and the disk.
        fs::rename(source, target)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        durable_rename(source, target)?;
        Ok(())
    }
}

pub(super) fn create_symlink(target: &str, path: &Path) -> Result<(), KernelError> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, path)?;
    }
    #[cfg(windows)]
    {
        let target_path = Path::new(target);
        let observed = if target_path.is_absolute() {
            target_path.to_path_buf()
        } else {
            path.parent()
                .unwrap_or_else(|| Path::new("."))
                .join(target_path)
        };
        if fs::metadata(&observed).is_ok_and(|metadata| metadata.is_dir()) {
            std::os::windows::fs::symlink_dir(target, path)?;
        } else {
            std::os::windows::fs::symlink_file(target, path)?;
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        return Err(KernelError::Storage(
            "symbolic links are unsupported on this platform".to_string(),
        ));
    }
    Ok(())
}

impl Storage {
    pub(crate) fn validate_live_root(
        &self,
        identity: &varin_runtime::catalog::launches::LiveRoot,
        grant: &Grant,
        host_id: &str,
    ) -> Result<(), KernelError> {
        let root = self.registered_file_root(&identity.root_id, grant)?;
        // Host realpath and Rust canonicalize use different Windows namespace spellings.
        // Compare the same filesystem identity while retaining the admitted root and host.
        if identity.host_id != host_id || root.canonical_root != fs::canonicalize(&identity.canonical_root)?
        {
            return Err(KernelError::Authorization(
                "live source environment identity changed".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn admitted_file_root(
        &self,
        root_id: &str,
        grant: &Grant,
    ) -> Result<FileRoot, KernelError> {
        let root = self.file_roots.get(root_id).cloned().ok_or_else(|| {
            KernelError::Authorization(
                "file root is not registered for this kernel epoch".to_string(),
            )
        })?;
        let owning = grant.owning_workspace.as_deref();
        let execution = grant.execution_workspace.as_deref().or(owning);
        if (owning != Some(root.owning_workspace_id.as_str())
            || execution != Some(root.execution_workspace_id.as_str()))
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "grant workspace identity does not own file root".to_string(),
            ));
        }
        Ok(root)
    }

    pub(super) fn registered_file_root(
        &self,
        root_id: &str,
        grant: &Grant,
    ) -> Result<FileRoot, KernelError> {
        let root = self.admitted_file_root(root_id, grant)?;
        // A registered pathname is not permanent authorization. A junction or
        // ancestor may have been replaced since admission.
        let current = fs::canonicalize(&root.canonical_root)?;
        if current != root.canonical_root || !fs::metadata(&current)?.is_dir() {
            return Err(KernelError::Authorization(
                "registered file root identity changed; Host readmission is required".to_string(),
            ));
        }
        Ok(root)
    }

    pub(super) fn resolve_file_resource(
        &self,
        root_id: &str,
        relative: &str,
        grant: &Grant,
        allow_root: bool,
    ) -> Result<ResolvedFileResource, KernelError> {
        let root = self.registered_file_root(root_id, grant)?;
        resolve_admitted_resource(&root, relative, grant, allow_root)
    }

    fn observe_state(&mut self, resource: &ResolvedFileResource) -> Result<FileState, KernelError> {
        self.capture_file_state(resource)
    }

    fn apply_file_state(
        &mut self,
        resource: &ResolvedFileResource,
        state: &FileState,
        workspace_id: &str,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        if resource.path.is_empty() {
            return Err(KernelError::Authorization(
                "workspace root cannot be applied as a file state".to_string(),
            ));
        }
        match state {
            FileState::Missing => remove_existing(&resource.absolute),
            FileState::Directory { mode } => {
                match fs::symlink_metadata(&resource.absolute) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                    Ok(_) => remove_existing(&resource.absolute)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                fs::create_dir_all(&resource.absolute)?;
                apply_mode(&resource.absolute, *mode)
            }
            FileState::Symlink {
                symlink_target,
                mode: _,
            } => {
                remove_existing(&resource.absolute)?;
                if let Some(parent) = resource.absolute.parent() {
                    fs::create_dir_all(parent)?;
                }
                create_symlink(symlink_target, &resource.absolute)
            }
            FileState::RegularFile {
                object_hash,
                byte_length,
                mode,
            } => {
                if !self.blob_owned(object_hash, Some(workspace_id))? {
                    return Err(KernelError::Authorization(
                        "file target object is not owned by the workspace".to_string(),
                    ));
                }
                let object = object_path(&self.root, object_hash)?;
                let (actual_hash, actual_length) = hash_file(&object)?;
                if actual_hash != *object_hash || actual_length != *byte_length {
                    return Err(KernelError::Storage(format!(
                        "content object is corrupt: {object_hash}"
                    )));
                }
                if let Some(parent) = resource.absolute.parent() {
                    fs::create_dir_all(parent)?;
                }
                match fs::symlink_metadata(&resource.absolute) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        fs::remove_dir(&resource.absolute)?
                    }
                    Ok(_) | Err(_) => {}
                }
                let temporary = resource
                    .absolute
                    .with_file_name(format!(".varin-kernel-{}", Uuid::new_v4()));
                fs::copy(&object, &temporary)?;
                // Acquire the flush handle before making the file readonly.
                // Reopening with WRITE afterwards fails on Windows and POSIX.
                let installed = OpenOptions::new().read(true).write(true).open(&temporary)?;
                apply_mode(&temporary, *mode)?;
                installed.sync_all()?;
                drop(installed);
                durable_rename(&temporary, &resource.absolute).map_err(|error| {
                    let _ = fs::remove_file(&temporary);
                    KernelError::Storage(error.to_string())
                })?;
                if let Some(parent) = resource.absolute.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            }
            FileState::Unsupported => Err(KernelError::Operation(
                "unsupported file states cannot be applied".to_string(),
            )),
        }
    }

    pub(super) fn file_state_matches(observed: &FileState, expected: &FileState) -> bool {
        match (observed, expected) {
            (FileState::Missing, FileState::Missing)
            | (FileState::Unsupported, FileState::Unsupported) => true,
            (FileState::Directory { mode: observed }, FileState::Directory { mode: expected }) => {
                expected.is_none() || observed == expected
            }
            (
                FileState::Symlink {
                    symlink_target: observed_target,
                    mode: observed_mode,
                },
                FileState::Symlink {
                    symlink_target: expected_target,
                    mode: expected_mode,
                },
            ) => {
                observed_target == expected_target
                    && (expected_mode.is_none() || observed_mode == expected_mode)
            }
            (
                FileState::RegularFile {
                    object_hash: observed_hash,
                    byte_length: observed_length,
                    mode: observed_mode,
                },
                FileState::RegularFile {
                    object_hash: expected_hash,
                    byte_length: expected_length,
                    mode: expected_mode,
                },
            ) => {
                observed_hash == expected_hash
                    && observed_length == expected_length
                    && (expected_mode.is_none() || observed_mode == expected_mode)
            }
            _ => false,
        }
    }

    fn file_operation_record(
        &self,
        operation_id: &str,
        kind: &str,
        params_hash: &str,
    ) -> Result<Option<(String, Option<String>)>, KernelError> {
        let existing: Option<(String, String, String, Option<String>)> = self.conn.query_row(
            "SELECT kind, params_hash, state, result_json FROM operations WHERE operation_id = ?1",
            params![operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        if let Some((stored_kind, stored_hash, state, result)) = existing {
            if stored_kind != kind || stored_hash != params_hash {
                return Err(KernelError::Operation(format!(
                    "operationId {operation_id} was reused with different parameters"
                )));
            }
            return Ok(Some((state, result)));
        }
        Ok(None)
    }

    /// Read an immutable receipt without starting work or requiring its derived
    /// source to remain alive. The current caller still owns the workspace and
    /// supplies the exact intent; execution leases are not historical authority.
    pub(super) fn committed_file_operation(
        &self,
        operation_id: &str,
        kind: &str,
        params_value: &Value,
        workspace_id: &str,
    ) -> Result<Option<Value>, KernelError> {
        let (_, params_hash) = file_operation_identity(params_value)?;
        let Some((state, result)) = self.file_operation_record(operation_id, kind, &params_hash)?
        else {
            return Ok(None);
        };
        if state != "committed" {
            return Ok(None);
        }
        let owned: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_owners WHERE operation_id=?1 AND workspace_id=?2)",
            params![operation_id, workspace_id], |row| row.get(0))?;
        if !owned {
            return Err(KernelError::Authorization(
                "file operation is not owned by the workspace".into(),
            ));
        }
        let result = result
            .ok_or_else(|| KernelError::Storage("committed file operation has no result".into()))?;
        Ok(Some(serde_json::from_str(&result)?))
    }

    pub(super) fn begin_file_operation(
        &mut self,
        operation_id: &str,
        kind: &str,
        params_value: &Value,
    ) -> Result<(String, Option<Value>, bool), KernelError> {
        let (identity_params, params_hash) = file_operation_identity(params_value)?;
        if let Some((state, result)) =
            self.file_operation_record(operation_id, kind, &params_hash)?
        {
            if state == "committed" {
                let result = result.ok_or_else(|| {
                    KernelError::Storage("committed file operation has no result".to_string())
                })?;
                return Ok((params_hash, Some(serde_json::from_str(&result)?), false));
            }
            if state == "started" {
                return Ok((params_hash, None, true));
            }
            self.conn.execute(
                "DELETE FROM operations WHERE operation_id = ?1",
                params![operation_id],
            )?;
            self.conn.execute(
                "DELETE FROM operation_owners WHERE operation_id = ?1",
                params![operation_id],
            )?;
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            self.operation_begin(operation_id, kind, &params_hash)?;
            self.journal_file_intent(operation_id, &identity_params)?;
            self.record_operation_workspace(
                operation_id,
                params_value.get("workspaceId").and_then(Value::as_str),
            )?;
            self.conn.execute(
                "UPDATE operations SET result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
                params![
                    operation_id,
                    serde_json::to_string(&json!({"intent": identity_params}))?,
                    now_ms()
                ],
            )?;
            Ok::<(), KernelError>(())
        })();
        match outcome {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                Ok((params_hash, None, false))
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub(super) fn finish_file_operation(
        &mut self,
        operation_id: &str,
        result: &Value,
    ) -> Result<(), KernelError> {
        self.finish_file_operation_owned(operation_id, result, None, None)
    }

    pub(super) fn finish_file_operation_owned(
        &mut self,
        operation_id: &str,
        result: &Value,
        owner_id: Option<&str>,
        workspace_id: Option<&str>,
    ) -> Result<(), KernelError> {
        let mut durable_result = result.clone();
        let intent: Option<String> = self.conn.query_row(
            "SELECT result_json FROM operations WHERE operation_id=?1",
            params![operation_id],
            |row| row.get(0),
        )?;
        let journal_intent = intent.as_ref().map(|value| serde_json::from_str::<Value>(value)).transpose()?.and_then(|value| value.get("intent").cloned());
        if let Some(intent) = intent {
            let envelope: Value = serde_json::from_str(&intent)?;
            for field in ["__nativeRequestHash", "__nativeGrantId", "__nativeEpoch"] {
                if let Some(identity) = envelope["intent"][field].as_str() {
                    durable_result[field] = json!(identity);
                }
            }
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            self.operation_finish(operation_id, &durable_result)?;
            if let Some(intent)=&journal_intent { self.journal_file_receipt(operation_id,intent,result)?; }
            if let (Some(owner_id), Some(workspace_id)) = (owner_id, workspace_id) {
                self.conn.execute(
                    "DELETE FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2",
                    params![owner_id, workspace_id],
                )?;
            }
            Ok::<(), KernelError>(())
        })();
        match outcome {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(())
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn reconcile_file_operations_for_root(
        &mut self,
        root_id: &str,
        workspace_id: &str,
        grant: &Grant,
    ) -> Result<(usize, usize), KernelError> {
        let pending = {
            let mut statement = self.conn.prepare(
                "SELECT o.operation_id, o.kind, o.result_json FROM operations o INDEXED BY operations_pending_files JOIN operation_owners w ON w.operation_id = o.operation_id WHERE o.state = 'started' AND w.workspace_id = ?1 AND o.kind GLOB 'file.*' ORDER BY o.created_at, o.operation_id",
            )?;
            let rows = statement.query_map(params![workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut reconciled = 0usize;
        let mut unresolved = 0usize;
        for (operation_id, kind, stored) in pending {
            let Some(stored) = stored else {
                unresolved += 1;
                continue;
            };
            let envelope: Value = serde_json::from_str(&stored)?;
            let Some(intent) = envelope.get("intent") else {
                unresolved += 1;
                continue;
            };
            if intent.get("rootId").and_then(Value::as_str) != Some(root_id) {
                continue;
            }
            let operation_paths: Vec<FileLeaseResource> = if kind == "file.rename" {
                let params: KernelFileRenameParams = parse_file_params(intent)?;
                vec![
                    FileLeaseResource {
                        path: params.from_path,
                        subtree: true,
                    },
                    FileLeaseResource {
                        path: params.to_path,
                        subtree: true,
                    },
                ]
            } else {
                vec![FileLeaseResource {
                    path: intent
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| KernelError::Storage("file intent has no path".to_string()))?
                        .to_string(),
                    subtree: true,
                }]
            };
            if self
                .assert_file_lease(grant, root_id, &operation_paths, None)
                .is_err()
            {
                unresolved += 1;
                continue;
            }
            let result = match kind.as_str() {
                "file.apply" => {
                    let params: KernelFileApplyParams = parse_file_params(intent)?;
                    let resource =
                        self.resolve_file_resource(root_id, &params.path, grant, false)?;
                    let target: FileState = serde_json::from_str(&params.target_json)?;
                    let observed = self.observe_state(&resource)?;
                    if Self::file_state_matches(&observed, &target) {
                        Some((
                            json!({"status":"applied","reconciled":true,"stateJson":serde_json::to_string(&observed)?}),
                            params.owner_id,
                            Some(params.workspace_id),
                        ))
                    } else {
                        None
                    }
                }
                "file.mkdir" => {
                    let params: KernelFileMkdirParams = parse_file_params(intent)?;
                    let resource =
                        self.resolve_file_resource(root_id, &params.path, grant, false)?;
                    if fs::symlink_metadata(&resource.absolute).is_ok_and(|metadata| {
                        metadata.is_dir() && !metadata.file_type().is_symlink()
                    }) {
                        Some((json!({"status":"created","reconciled":true}), None, None))
                    } else {
                        None
                    }
                }
                "file.remove" => {
                    let params: KernelFileRemoveParams = parse_file_params(intent)?;
                    let resource =
                        self.resolve_file_resource(root_id, &params.path, grant, false)?;
                    if fs::symlink_metadata(&resource.absolute)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                    {
                        Some((json!({"status":"removed","reconciled":true}), None, None))
                    } else {
                        None
                    }
                }
                "file.rename" => {
                    let params: KernelFileRenameParams = parse_file_params(intent)?;
                    let source =
                        self.resolve_file_resource(root_id, &params.from_path, grant, false)?;
                    let target =
                        self.resolve_file_resource(root_id, &params.to_path, grant, false)?;
                    let before = envelope
                        .get("renameSourceState")
                        .cloned()
                        .map(serde_json::from_value::<FileState>)
                        .transpose()?;
                    let observed = self.observe_state(&target)?;
                    if fs::symlink_metadata(&source.absolute)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                        && before.as_ref().is_some_and(|state| {
                            matches!(
                                state,
                                FileState::RegularFile { .. } | FileState::Symlink { .. }
                            ) && Self::file_state_matches(&observed, state)
                        })
                    {
                        Some((json!({"status":"renamed","reconciled":true}), None, None))
                    } else {
                        None
                    }
                }
                "file.materialize" => {
                    unresolved += 1;
                    continue;
                }
                _ => None,
            };
            if let Some((result, owner_id, owner_workspace)) = result {
                self.finish_file_operation_owned(
                    &operation_id,
                    &result,
                    owner_id.as_deref(),
                    owner_workspace.as_deref(),
                )?;
                reconciled += 1;
            } else {
                unresolved += 1;
            }
        }
        Ok((reconciled, unresolved))
    }

    fn pending_file_operation_descriptor(
        &mut self,
        root_id: &str,
        operation_id: &str,
        kind: &str,
        envelope: &Value,
        created_at: i64,
        updated_at: i64,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let intent = envelope.get("intent").ok_or_else(|| {
            KernelError::Storage(format!(
                "pending file operation has no intent: {operation_id}"
            ))
        })?;
        let paths = if kind == "file.rename" {
            let params: KernelFileRenameParams = parse_file_params(intent)?;
            vec![params.from_path.clone(), params.to_path.clone()]
        } else {
            vec![intent
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KernelError::Storage(format!(
                        "pending file operation has no path: {operation_id}"
                    ))
                })?
                .to_string()]
        };
        let (disposition, reason) = match kind {
            "file.apply" => {
                let params: KernelFileApplyParams = parse_file_params(intent)?;
                let resource = self.resolve_file_resource(root_id, &params.path, grant, false)?;
                let target: FileState = serde_json::from_str(&params.target_json)?;
                let observed = self.observe_state(&resource)?;
                if Self::file_state_matches(&observed, &target) {
                    ("reconcile", "target-observed")
                } else {
                    ("needs-attention", "target-not-observed")
                }
            }
            "file.mkdir" => {
                let params: KernelFileMkdirParams = parse_file_params(intent)?;
                let resource = self.resolve_file_resource(root_id, &params.path, grant, false)?;
                if fs::symlink_metadata(&resource.absolute)
                    .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
                {
                    ("reconcile", "directory-observed")
                } else {
                    ("needs-attention", "directory-not-observed")
                }
            }
            "file.remove" => {
                let params: KernelFileRemoveParams = parse_file_params(intent)?;
                let resource = self.resolve_file_resource(root_id, &params.path, grant, false)?;
                if fs::symlink_metadata(&resource.absolute)
                    .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                {
                    ("reconcile", "path-absent")
                } else {
                    ("needs-attention", "path-present-after-interrupted-remove")
                }
            }
            "file.rename" => {
                let params: KernelFileRenameParams = parse_file_params(intent)?;
                let source =
                    self.resolve_file_resource(root_id, &params.from_path, grant, false)?;
                let target = self.resolve_file_resource(root_id, &params.to_path, grant, false)?;
                let before = envelope
                    .get("renameSourceState")
                    .cloned()
                    .map(serde_json::from_value::<FileState>)
                    .transpose()?;
                let target_state = self.observe_state(&target)?;
                if fs::symlink_metadata(&source.absolute)
                    .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                    && before.as_ref().is_some_and(|state| {
                        matches!(
                            state,
                            FileState::RegularFile { .. } | FileState::Symlink { .. }
                        ) && Self::file_state_matches(&target_state, state)
                    })
                {
                    ("reconcile", "saved-source-state-observed-at-target")
                } else if before
                    .as_ref()
                    .is_some_and(|state| matches!(state, FileState::Directory { .. }))
                {
                    (
                        "needs-attention",
                        "directory-rename-cannot-be-proven-from-directory-metadata",
                    )
                } else {
                    ("needs-attention", "rename-result-not-provable")
                }
            }
            "file.materialize" => {
                for path in &paths {
                    self.resolve_file_resource(root_id, path, grant, false)?;
                }
                ("reconcile", "materialization-observation-required")
            }
            _ => ("needs-attention", "unknown-file-operation-kind"),
        };
        Ok(json!({
            "operationId": operation_id,
            "kind": kind,
            "state": "started",
            "rootId": root_id,
            "paths": paths,
            "disposition": disposition,
            "reason": reason,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }))
    }

    fn pending_file_operations_for_root(
        &mut self,
        root_id: &str,
        workspace_id: &str,
        grant: &Grant,
    ) -> Result<Vec<Value>, KernelError> {
        let rows = {
            let mut statement = self.conn.prepare(
                "SELECT o.operation_id, o.kind, o.result_json, o.created_at, o.updated_at FROM operations o INDEXED BY operations_pending_files JOIN operation_owners w ON w.operation_id = o.operation_id WHERE o.state = 'started' AND w.workspace_id = ?1 AND o.kind GLOB 'file.*' ORDER BY o.created_at, o.operation_id",
            )?;
            let rows = statement.query_map(params![workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut result = Vec::new();
        for (operation_id, kind, stored, created_at, updated_at) in rows {
            let Some(stored) = stored else {
                continue;
            };
            let envelope: Value = serde_json::from_str(&stored)?;
            let Some(intent) = envelope.get("intent") else {
                continue;
            };
            if intent.get("rootId").and_then(Value::as_str) != Some(root_id) {
                continue;
            }
            result.push(self.pending_file_operation_descriptor(
                root_id,
                &operation_id,
                &kind,
                &envelope,
                created_at,
                updated_at,
                grant,
            )?);
        }
        Ok(result)
    }

    pub(super) fn file_operation_list(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileOperationListParams = parse_file_params(params_value)?;
        self.registered_file_root(&params.root_id, grant)?;
        let pending =
            self.pending_file_operations_for_root(&params.root_id, &params.workspace_id, grant)?;
        let cursor = usize::try_from(params.cursor.unwrap_or(0))
            .map_err(|_| KernelError::Operation("file operation cursor is invalid".to_string()))?;
        let page_size =
            usize::try_from(params.page_size.unwrap_or(128).clamp(1, 512)).map_err(|_| {
                KernelError::Operation("file operation page size is invalid".to_string())
            })?;
        if cursor > pending.len() {
            return Err(KernelError::Operation(
                "file operation cursor is out of range".to_string(),
            ));
        }
        let end = (cursor + page_size).min(pending.len());
        Ok(json!({
            "operations": pending[cursor..end],
            "nextCursor": if end < pending.len() { Some(end) } else { None },
            "total": pending.len(),
        }))
    }

    pub(super) fn file_operation_reconcile(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileOperationReconcileParams = parse_file_params(params_value)?;
        self.registered_file_root(&params.root_id, grant)?;
        let owned: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM operation_owners WHERE operation_id = ?1 AND workspace_id = ?2",
                params![params.operation_id, params.workspace_id],
                |row| row.get(0),
            )
            .optional()?;
        if owned.is_none() {
            return Ok(json!({"status":"missing","operationId":params.operation_id}));
        }
        let row: Option<(String, String, Option<String>, i64, i64)> = self.conn.query_row(
            "SELECT kind, state, result_json, created_at, updated_at FROM operations WHERE operation_id = ?1",
            params![params.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?;
        let Some((kind, state, stored, _created_at, _updated_at)) = row else {
            return Ok(json!({"status":"missing","operationId":params.operation_id}));
        };
        if !kind.starts_with("file.") {
            return Err(KernelError::Operation(
                "operation is not a file-resource operation".to_string(),
            ));
        }
        if state == "started" {
            let Some(stored_text) = stored.as_ref() else {
                return Err(KernelError::Storage(
                    "pending file operation has no intent".to_string(),
                ));
            };
            let envelope: Value = serde_json::from_str(stored_text)?;
            if envelope
                .get("intent")
                .and_then(|value| value.get("rootId"))
                .and_then(Value::as_str)
                != Some(params.root_id.as_str())
            {
                return Err(KernelError::Authorization(
                    "file operation belongs to another root".to_string(),
                ));
            }
            let _ = self.reconcile_file_operations_for_root(
                &params.root_id,
                &params.workspace_id,
                grant,
            )?;
        }
        let current: Option<(String, Option<String>, i64, i64)> = self.conn.query_row(
            "SELECT state, result_json, created_at, updated_at FROM operations WHERE operation_id = ?1",
            params![params.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        let Some((current_state, current_result, current_created_at, current_updated_at)) = current
        else {
            return Ok(json!({"status":"missing","operationId":params.operation_id}));
        };
        if current_state == "committed" {
            return Ok(json!({
                "status":"reconciled",
                "operationId":params.operation_id,
                "kind":kind,
                "result": current_result.map(|text| serde_json::from_str::<Value>(&text)).transpose()?,
            }));
        }
        let envelope: Value =
            serde_json::from_str(current_result.as_deref().ok_or_else(|| {
                KernelError::Storage("pending file operation has no intent".to_string())
            })?)?;
        let descriptor = self.pending_file_operation_descriptor(
            &params.root_id,
            &params.operation_id,
            &kind,
            &envelope,
            current_created_at,
            current_updated_at,
            grant,
        )?;
        Ok(json!({"status":"pending","operation":descriptor}))
    }

    pub(super) fn file_root_register(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileRootRegisterParams = parse_file_params(params_value)?;
        let expected_owning = grant.owning_workspace.as_deref();
        let expected_execution = grant.execution_workspace.as_deref().or(expected_owning);
        if (expected_owning != Some(params.workspace_id.as_str())
            || expected_execution != Some(params.execution_workspace_id.as_str()))
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "grant workspace identity does not match file root registration".to_string(),
            ));
        }
        let requested = Path::new(&params.canonical_root);
        if !requested.is_absolute() {
            return Err(KernelError::Authorization(
                "file root must be absolute".to_string(),
            ));
        }
        let canonical = fs::canonicalize(requested)?;
        if !fs::metadata(&canonical)?.is_dir() {
            return Err(KernelError::Operation(
                "file root is not a directory".to_string(),
            ));
        }
        if let Some(existing) = self.file_roots.values().find(|root| {
            root.owning_workspace_id == params.workspace_id
                && root.execution_workspace_id == params.execution_workspace_id
                && root.canonical_root == canonical
        }) {
            let root_id = existing.root_id.clone();
            let execution_workspace_id = existing.execution_workspace_id.clone();
            let canonical_root = existing.canonical_root.clone();
            let (reconciled_operations, pending_operations) =
                self.reconcile_file_operations_for_root(&root_id, &params.workspace_id, grant)?;
            return Ok(json!({
                "rootId": root_id,
                "executionWorkspaceId": execution_workspace_id,
                "canonicalRoot": canonical_root,
                "reconciledOperations": reconciled_operations,
                "pendingOperations": pending_operations,
            }));
        }
        let root_id = file_root_identity(&params.workspace_id, &params.execution_workspace_id, &canonical);
        let root = FileRoot {
            root_id: root_id.clone(),
            owning_workspace_id: params.workspace_id.clone(),
            execution_workspace_id: params.execution_workspace_id.clone(),
            canonical_root: canonical.clone(),
        };
        self.file_roots.insert(root_id.clone(), root);
        let (reconciled_operations, pending_operations) =
            self.reconcile_file_operations_for_root(&root_id, &params.workspace_id, grant)?;
        Ok(json!({
            "rootId": root_id,
            "executionWorkspaceId": params.execution_workspace_id,
            "canonicalRoot": canonical,
            "reconciledOperations": reconciled_operations,
            "pendingOperations": pending_operations,
        }))
    }

    pub(super) fn file_apply(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileApplyParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, false)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: false,
            }],
            params.lease_id.as_deref(),
        )?;
        let target: FileState = serde_json::from_str(&params.target_json)?;
        let expected = params
            .expected_json
            .as_deref()
            .map(serde_json::from_str::<FileState>)
            .transpose()?;
        let journalled = self.journal_for_file_reservation(params_value, grant)?;
        let params_value = journalled.as_ref().unwrap_or(params_value);
        let (_params_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.apply", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        if params.record_id.is_some() || params.slot.is_some() {
            let FileState::RegularFile { object_hash, .. } = &target else {
                return Err(KernelError::Authorization("only a file target can use a content record".into()));
            };
            let mut reference = json!({"recordId":params.record_id,"slot":params.slot});
            if let Some(owner) = &params.owner_id { reference["ownerId"] = json!(owner); }
            self.validate_blob_read_source(&reference, object_hash, &grant.grant_id, false)?;
        } else if let Some(owner_id) = params.owner_id.as_ref() {
            let FileState::RegularFile { object_hash, .. } = &target else {
                return Err(KernelError::Authorization(
                    "only a file target can consume an object owner".to_string(),
                ));
            };
            self.validate_object_owners(
                &params.workspace_id,
                &grant.grant_id,
                &BTreeMap::from([(owner_id.clone(), object_hash.clone())]),
            )?;
        } else if matches!(&target, FileState::RegularFile { .. })
            && !grant.capabilities.contains("storage.maintenance")
            && !grant.capabilities.contains("recovery.maintenance")
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "file apply requires an exact object owner or Host maintenance authority"
                    .to_string(),
            ));
        }
        if grant.capabilities.contains("recovery.maintenance") {
            if !self.observation_process_idle(&resource.absolute)? { return Err(KernelError::Operation("affected resource still has an active process writer".into())); }
            let conflicts = self.recovery_operation_conflicts(&json!({"workspaceId":params.workspace_id,"rootId":params.root_id,"paths":[resource.path],"exceptOperationId":params.reservation_operation_id}), grant)?;
            if conflicts["operations"].as_array().is_some_and(|values|!values.is_empty()) { return Err(KernelError::Operation("affected resource has an unfinished Integration".into())); }
        }
        let current = self.observe_state(&resource)?;
        if Self::file_state_matches(&current, &target) {
            let result = json!({"status": "applied", "reconciled": resuming, "stateJson": serde_json::to_string(&current)?});
            self.finish_file_operation_owned(
                &params.operation_id,
                &result,
                params.owner_id.as_deref(),
                Some(&params.workspace_id),
            )?;
            return Ok(result);
        }
        if let Some(expected) = expected.as_ref() {
            if !Self::file_state_matches(&current, expected) {
                let result =
                    json!({"status": "conflict", "stateJson": serde_json::to_string(&current)?});
                self.finish_file_operation_owned(
                    &params.operation_id,
                    &result,
                    params.owner_id.as_deref(),
                    Some(&params.workspace_id),
                )?;
                return Ok(result);
            }
        }
        self.apply_file_state(&resource, &target, &params.workspace_id)?;
        let observed = self.observe_state(&resource)?;
        if !Self::file_state_matches(&observed, &target) {
            return Err(KernelError::Storage(format!(
                "file state did not match target after apply: {}",
                resource.path
            )));
        }
        let result = json!({"status": "applied", "reconciled": false, "stateJson": serde_json::to_string(&observed)?});
        self.finish_file_operation_owned(
            &params.operation_id,
            &result,
            params.owner_id.as_deref(),
            Some(&params.workspace_id),
        )?;
        Ok(result)
    }

    pub(super) fn file_mkdir(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileMkdirParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, false)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: true,
            }],
            params.lease_id.as_deref(),
        )?;
        let (_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.mkdir", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(KernelError::Operation(
                    "mkdir target exists and is not a directory".to_string(),
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if params.recursive {
                    fs::create_dir_all(&resource.absolute)?;
                } else {
                    fs::create_dir(&resource.absolute)?;
                }
                if let Some(parent) = resource.absolute.parent() {
                    sync_directory(parent)?;
                }
            }
            Err(error) => return Err(error.into()),
        }
        let result = json!({"status": "created", "reconciled": resuming});
        self.finish_file_operation(&params.operation_id, &result)?;
        Ok(result)
    }

    pub(super) fn file_remove(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileRemoveParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, false)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: params.recursive,
            }],
            params.lease_id.as_deref(),
        )?;
        let (_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.remove", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        if resuming {
            if !fs::symlink_metadata(&resource.absolute)
                .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
            {
                return Err(KernelError::Operation("remove needs attention: target exists after interrupted operation; refusing destructive replay".to_string()));
            }
            let result = json!({"status": "removed", "reconciled": true});
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }
        self.assert_process_directory_idle(&resource.absolute)?;
        match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                if params.recursive {
                    fs::remove_dir_all(&resource.absolute)?;
                } else {
                    fs::remove_dir(&resource.absolute)?;
                }
            }
            Ok(_) => fs::remove_file(&resource.absolute)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound && params.force => {}
            Err(error) => return Err(error.into()),
        }
        if let Some(parent) = resource.absolute.parent() {
            sync_directory(parent)?;
        }
        let result = json!({"status": "removed", "reconciled": resuming});
        self.finish_file_operation(&params.operation_id, &result)?;
        Ok(result)
    }

    pub(super) fn file_rename(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileRenameParams = parse_file_params(params_value)?;
        let source =
            self.resolve_file_resource(&params.root_id, &params.from_path, grant, false)?;
        let target = self.resolve_file_resource(&params.root_id, &params.to_path, grant, false)?;
        let resources = [
            FileLeaseResource {
                path: source.path.clone(),
                subtree: true,
            },
            FileLeaseResource {
                path: target.path.clone(),
                subtree: true,
            },
        ];
        self.assert_file_lease(
            grant,
            &params.root_id,
            &resources,
            params.lease_id.as_deref(),
        )?;
        let (_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.rename", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        let source_state = self.observe_state(&source)?;
        let target_state = self.observe_state(&target)?;
        if resuming {
            let envelope: String = self.conn.query_row(
                "SELECT result_json FROM operations WHERE operation_id = ?1",
                params![params.operation_id],
                |row| row.get(0),
            )?;
            let envelope: Value = serde_json::from_str(&envelope)?;
            let before = envelope
                .get("renameSourceState")
                .cloned()
                .map(serde_json::from_value::<FileState>)
                .transpose()?;
            if matches!(source_state, FileState::Missing)
                && before.as_ref().is_some_and(|state| {
                    matches!(
                        state,
                        FileState::RegularFile { .. } | FileState::Symlink { .. }
                    ) && Self::file_state_matches(&target_state, state)
                })
            {
                let result = json!({"status": "renamed", "reconciled": true});
                self.finish_file_operation(&params.operation_id, &result)?;
                return Ok(result);
            }
            return Err(KernelError::Operation("rename needs attention: interrupted operation has no provable target; refusing replay".to_string()));
        }
        let expected_source = params
            .expected_from_json
            .as_deref()
            .map(serde_json::from_str::<FileState>)
            .transpose()?;
        let expected_target = params
            .expected_to_json
            .as_deref()
            .map(serde_json::from_str::<FileState>)
            .transpose()?;
        if expected_source
            .as_ref()
            .is_some_and(|expected| !Self::file_state_matches(&source_state, expected))
            || expected_target
                .as_ref()
                .is_some_and(|expected| !Self::file_state_matches(&target_state, expected))
        {
            let result = json!({
                "status": "conflict",
                "sourceStateJson": serde_json::to_string(&source_state)?,
                "targetStateJson": serde_json::to_string(&target_state)?,
            });
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }
        let source_exists = !matches!(source_state, FileState::Missing);
        let target_exists = !matches!(target_state, FileState::Missing);
        if !source_exists {
            return Err(KernelError::Operation(
                "rename source is missing".to_string(),
            ));
        }
        if params.target_must_be_missing.unwrap_or(false) && target_exists {
            let result = json!({"status": "target-exists"});
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }
        if let Some(parent) = target.absolute.parent() {
            fs::create_dir_all(parent)?;
        }
        let envelope: String = self.conn.query_row(
            "SELECT result_json FROM operations WHERE operation_id = ?1",
            params![params.operation_id],
            |row| row.get(0),
        )?;
        let mut envelope: Value = serde_json::from_str(&envelope)?;
        envelope["renameSourceState"] = serde_json::to_value(&source_state)?;
        self.conn.execute(
            "UPDATE operations SET result_json = ?2 WHERE operation_id = ?1",
            params![params.operation_id, serde_json::to_string(&envelope)?],
        )?;
        self.assert_process_directory_idle(&source.absolute)?;
        self.assert_process_directory_idle(&target.absolute)?;
        durable_rename(&source.absolute, &target.absolute)?;
        if let Some(parent) = source.absolute.parent() {
            sync_directory(parent)?;
        }
        if source.absolute.parent() != target.absolute.parent() {
            if let Some(parent) = target.absolute.parent() {
                sync_directory(parent)?;
            }
        }
        let result = json!({"status": "renamed", "reconciled": resuming});
        self.finish_file_operation(&params.operation_id, &result)?;
        Ok(result)
    }
}

// Shared path resolution for Storage-admitted background captures.
pub(super) fn resolve_admitted_resource(
    root: &FileRoot,
    relative: &str,
    grant: &Grant,
    allow_root: bool,
) -> Result<ResolvedFileResource, KernelError> {
    resolve_scoped_resource(&root.canonical_root, relative, allow_root, false, |path| {
        path_allowed(grant, path)
    })
}

/// Shared canonical identity resolution. Reservation inspection reads only existing journal
/// metadata; it passes no grant and cannot authorize an effect through this helper.
pub(super) fn resolve_scoped_resource(
    canonical_root: &Path,
    relative: &str,
    allow_root: bool,
    recorded_root_may_be_missing: bool,
    scope_allows: impl Fn(&str) -> bool,
) -> Result<ResolvedFileResource, KernelError> {
    match fs::canonicalize(canonical_root) {
        Ok(current_root)
            if current_root == canonical_root && fs::metadata(&current_root)?.is_dir() =>
        {
            ()
        }
        Ok(_) => {
            return Err(KernelError::Authorization(
                "registered file root identity changed".into(),
            ))
        }
        Err(error) if recorded_root_may_be_missing && error.kind() == io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    let (path, relative_path) = normalized_relative_path(relative, allow_root)?;
    if !scope_allows(&path) {
        return Err(KernelError::Authorization(format!(
            "path is outside grant scope: {path}"
        )));
    }
    let mut current = canonical_root.to_path_buf();
    let components = relative_path.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let next = current.join(component.as_os_str());
        if index + 1 < components.len() {
            match fs::canonicalize(&next) {
                Ok(canonical) => {
                    if !path_inside(canonical_root, &canonical) {
                        return Err(KernelError::Authorization(
                            "file path escaped the registered workspace root".to_string(),
                        ));
                    }
                    current = canonical;
                }
                // An existing file can block the remaining path just as an
                // absent directory does. Preserve its canonical prefix and
                // check the complete canonical scope below, without creating
                // directories or granting authority to replace the ancestor.
                Err(error)
                    if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) =>
                {
                    current = next;
                    for rest in &components[index + 1..] {
                        current.push(rest.as_os_str());
                    }
                    break;
                }
                Err(error) => return Err(error.into()),
            }
        } else {
            current = next;
        }
    }
    if !path_inside(canonical_root, &current) {
        return Err(KernelError::Authorization(
            "file path escaped the registered workspace root".to_string(),
        ));
    }
    let canonical_relative = current.strip_prefix(canonical_root).map_err(|_| {
        KernelError::Authorization("resolved resource is outside registered root".to_string())
    })?;
    let canonical_scope = canonical_relative
        .to_str()
        .ok_or_else(|| KernelError::Authorization("resolved resource is not UTF-8".to_string()))?
        .replace('\\', "/");
    if !scope_allows(&canonical_scope) {
        return Err(KernelError::Authorization(
            "resolved file path is outside grant scope".to_string(),
        ));
    }
    Ok(ResolvedFileResource {
        path,
        absolute: current,
    })
}

impl Storage {
    /// Private read-only Host admission before Documents accesses a retrieval candidate.
    /// The persisted Run grant and physical lease owner remain authoritative; no body is read.
    pub(crate) fn file_read_check(
        &mut self,
        params: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let args: crate::protocol_generated::KernelFileReadCheckParams = parse_file_params(params)?;
        let key = self.file_resource_key(&args.root_id, &args.path, grant)?;
        self.file_read(params, grant, false)?;
        let resource = self.resolve_file_resource(&args.root_id, &args.path, grant, false)?;
        let metadata = fs::symlink_metadata(&resource.absolute)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(KernelError::Authorization(
                "retrieval read admission requires a regular file, not a symlink".into(),
            ));
        }
        // Parent symlinks may have changed while the permission/lease checks ran.
        if self.file_resource_key(&args.root_id, &args.path, grant)? != key {
            return Err(KernelError::Authorization(
                "canonical file resource changed during admission".into(),
            ));
        }
        Ok(json!({"resourceKey":key}))
    }
    /// Typed native adapter entry point. This is deliberately not a wire method:
    /// the bound Run supplies the root, and the existing grant/root/lease owner
    /// still admits every read. The caller adds its selected source mode; this owner
    /// only establishes the actual physical root and observed file revision.
    pub(super) fn resolve_file_read(
        &mut self,
        params: &Value,
        grant: &Grant,
    ) -> Result<ResolvedFileResource, KernelError> {
        let root_id = params["rootId"]
            .as_str()
            .ok_or_else(|| KernelError::Authorization("physical source root is missing".into()))?;
        let path = params["path"]
            .as_str()
            .ok_or_else(|| KernelError::Operation("file path is missing".into()))?;
        let resource = self.resolve_file_resource(root_id, path, grant, false)?;
        self.assert_file_lease(
            grant,
            root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: false,
            }],
            params.get("leaseId").and_then(Value::as_str),
        )?;
        self.check_cancelled()?;
        Ok(resource)
    }
    pub(crate) fn file_read(
        &mut self,
        params: &Value,
        grant: &Grant,
        read_body: bool,
    ) -> Result<Value, KernelError> {
        let resource = self.resolve_file_read(params, grant)?;
        let root_id = params["rootId"].as_str().expect("admitted root");
        let path = params["path"].as_str().expect("admitted path");
        if !read_body {
            return Ok(Value::Null);
        }
        let source = json!({"rootId":root_id});
        let metadata = match fs::symlink_metadata(&resource.absolute) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(
                    json!({"path":path,"source":source,"missing":true,"readVersion":super::file_mutations::read_version(root_id,&resource.path,&FileState::Missing)?}),
                )
            }
            Err(error) => return Err(error.into()),
        };
        let state = if metadata.file_type().is_symlink() {
            Some(FileState::Symlink {
                symlink_target: fs::read_link(&resource.absolute)?
                    .into_os_string()
                    .into_string()
                    .map_err(|_| KernelError::Operation("symlink target is not UTF-8".into()))?,
                mode: Some(file_mode(&metadata)),
            })
        } else if metadata.is_dir() {
            Some(FileState::Directory {
                mode: Some(file_mode(&metadata)),
            })
        } else if !metadata.is_file() {
            Some(FileState::Unsupported)
        } else {
            None
        };
        if let Some(state) = state {
            return Ok(json!({"path":path,"source":source,"state":state,"missing":false}));
        }
        let task = self.prepare_file_read(params, grant, self.cancellation.clone()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false))))?
            .ok_or_else(|| KernelError::Operation("file changed before read".into()))?;
        let result = task.run();
        self.finish_file_read(&task, result, grant)
    }
}

#[cfg(test)]
#[path = "non_directory_ancestor_review.rs"]
mod non_directory_ancestor_review;
