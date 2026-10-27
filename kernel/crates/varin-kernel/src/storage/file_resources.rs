//! Canonical workspace file resources and cross-request path leases.
//!
//! R2 keeps editor buffers in the TypeScript Document Registry while moving
//! controlled disk identity, capture, apply, and CRUD side effects into this
//! kernel. File roots are epoch-local registrations: the Host must re-admit a
//! Documents-authorized canonical root after every kernel restart.
use super::*;
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

impl Storage {
    /// Read an operation's own native receipt after its original Host/grant has
    /// disappeared. The current checkpoint after-image is not the receipt owner.
    pub(crate) fn file_tool_receipt(&self, read: &crate::tools::SourceEffectReceiptRead) -> Result<Value, KernelError> {
        let row: Option<(String, String, Option<String>)> = self.conn.query_row(
            "SELECT o.kind,o.state,o.result_json FROM operations o JOIN operation_owners w ON w.operation_id=o.operation_id WHERE o.operation_id=?1 AND w.workspace_id=?2",
            params![read.operation_id, read.source.workspace_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((kind, state, body)) = row else { return Ok(Value::Null); };
        if kind != "file.apply" { return Err(KernelError::Authorization("The original operation is not a binary file write".into())); }
        let body: Value = serde_json::from_str(body.as_deref().ok_or_else(|| KernelError::Storage("File receipt has no body".into()))?)?;
        let identity = if state == "started" { &body["intent"] } else { &body };
        let turn = &identity["__recoveryTurn"];
        let target = &turn["fileTarget"];
        let source = &read.source;
        let expected_root = match source.mode {
            varin_runtime::SourceMode::LiveRoot => PathBuf::from(&source.live_root.as_ref()
                .ok_or_else(|| KernelError::Authorization("Original file root is missing".into()))?.canonical_root),
            varin_runtime::SourceMode::Materialized => {
                let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([source.workspace_id, source.environment_run_id.as_deref().unwrap_or(&read.run_id)]))?));
                self.root.join("managed").join("runs").join(key)
            }
            _ => return Err(KernelError::Authorization("An immutable source has no binary file write".into())),
        };
        let root_id = file_root_identity(&source.workspace_id, &source.execution_workspace_id, &expected_root);
        if turn["workspaceId"] != source.workspace_id || turn["runId"] != read.run_id || turn["conversation"]["threadId"] != read.thread_id
            || target["threadId"] != read.thread_id || target["runId"] != read.run_id || target["workspaceId"] != source.workspace_id
            || target["executionWorkspaceId"] != source.execution_workspace_id || target["sourceMode"] != serde_json::to_value(source.mode)?
            || target["canonicalRoot"].as_str() != expected_root.to_str() || target["rootId"] != root_id
            || !matches!(identity["__recoveryTool"].as_str(), Some("office_write" | "office_export" | "browser_files")) {
            return Err(KernelError::Authorization("File receipt differs from its original Run, source or tool".into()));
        }
        Ok(json!({"state":state,"tool":identity["__recoveryTool"],"turn":turn,"receipt":if state=="committed"{body.clone()}else{Value::Null}}))
    }
}

pub(super) fn file_params_value(params_value: &Value) -> Value {
    let mut params = params_value.clone();
    if let Some(object) = params.as_object_mut() {
        object.remove("__pathScopes");
    }
    params
}

fn public_file_result(mut result: Value) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.remove("__recoveryTurn"); object.remove("__recoveryTool");
    }
    result
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

/// Materialization verifies the bytes while copying them. Cloned targets are
/// read once; writable files never share a hard link with the immutable object.
pub(super) fn copy_verified_object_to(source: &Path, destination: &Path, cancellation: &AtomicBool,
    expected_hash: &str, expected_length: u64) -> Result<&'static str, KernelError> {
    let cloned = clone_file(source, destination)?;
    let mut reader = File::open(if cloned { destination } else { source })?;
    let mut target = if cloned { None } else { Some(OpenOptions::new().create_new(true).write(true).open(destination)?) };
    let mut digest = Sha256::new(); let mut length = 0u64; let mut bytes = [0u8; 128 * 1024];
    loop {
        if cancellation.load(Ordering::Acquire) { return Err(KernelError::Cancelled); }
        let count = reader.read(&mut bytes)?; if count == 0 { break; }
        if let Some(target) = &mut target { target.write_all(&bytes[..count])?; }
        digest.update(&bytes[..count]); length += count as u64;
    }
    let actual = format!("sha256-{}",hex::encode(digest.finalize()));
    if actual != expected_hash || length != expected_length { return Err(KernelError::Storage(format!("materialize object is corrupt: {expected_hash}"))); }
    if let Some(target) = target { target.sync_all()?; }
    Ok(if cloned { "reflink" } else { "copy" })
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
    /// Process output/control uses the admitted original executor, not a new
    /// filesystem access. Reopening its cwd can enter a mounted filesystem and
    /// can also make a stopped process unreadable after its directory disappears.
    pub(crate) fn validate_recorded_live_root(
        &self, identity: &varin_runtime::catalog::launches::LiveRoot, grant: &Grant, host_id: &str,
    ) -> Result<(), KernelError> {
        let root=self.admitted_file_root(&identity.root_id,grant)?;
        #[cfg(windows)]
        let same={
            let normalize=|path:&Path|{
                let value=path.to_string_lossy().replace('/',"\\");
                let value=if let Some(unc)=value.strip_prefix(r"\\?\UNC\"){format!(r"\\{unc}")}
                    else{value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()};
                value.trim_end_matches('\\').to_lowercase()
            };
            normalize(Path::new(&identity.canonical_root))==normalize(&root.canonical_root)
        };
        #[cfg(not(windows))]
        let same=Path::new(&identity.canonical_root)==root.canonical_root;
        if identity.host_id!=host_id||!same{
            return Err(KernelError::Authorization("Recorded process source identity changed".into()));
        }
        Ok(())
    }
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
        Ok(Some(public_file_result(serde_json::from_str(&result)?)))
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
                return Ok((params_hash, Some(public_file_result(serde_json::from_str(&result)?)), false));
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
            // Keep the native journal identity with this operation's own receipt.
            // A later write to the same checkpoint path can replace the current
            // after-image, but must not erase the original external tool outcome.
            if envelope["intent"]["journalBinding"].is_object() {
                durable_result["__recoveryTurn"] = envelope["intent"]["__recoveryTurn"].clone();
                durable_result["__recoveryTool"] = envelope["intent"]["__recoveryTool"].clone();
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

    pub(super) fn file_operation_list(&mut self,params:&Value,grant:&Grant)->Result<Value,KernelError>{
        let task=self.prepare_file_inspection("file.operation.list",params,grant,self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false))))?;
        task.run_local(self)
    }
    pub(super) fn file_operation_reconcile(&mut self,params:&Value,grant:&Grant)->Result<Value,KernelError>{
        let task=self.prepare_file_inspection("file.operation.reconcile",params,grant,self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false))))?;
        task.run_local(self)
    }

    pub(super) fn file_root_register(&mut self,params:&Value,grant:&Grant)->Result<Value,KernelError>{
        let task=self.prepare_file_root_registration(params,grant,self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false))))?;
        task.run_local(self)
    }

    pub(super) fn file_apply(&mut self, params: &Value, grant: &Grant) -> Result<Value, KernelError> {
        let task = self.prepare_file_effect("file.apply", params, grant,
            self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false))))?;
        task.run_local(self)
    }
    pub(super) fn file_mkdir(&mut self, params: &Value, grant: &Grant) -> Result<Value, KernelError> {
        let task = self.prepare_file_effect("file.mkdir", params, grant,
            self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false))))?;
        task.run_local(self)
    }
    pub(super) fn file_remove(&mut self, params: &Value, grant: &Grant) -> Result<Value, KernelError> {
        let task = self.prepare_file_effect("file.remove", params, grant,
            self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false))))?;
        task.run_local(self)
    }
    pub(super) fn file_rename(&mut self, params: &Value, grant: &Grant) -> Result<Value, KernelError> {
        let task = self.prepare_file_effect("file.rename", params, grant,
            self.cancellation.clone().unwrap_or_else(||Arc::new(AtomicBool::new(false))))?;
        task.run_local(self)
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
    /// Checks the original Run grant and canonical identity only; no body is read.
    /// Documents separately waits for and owns the physical read lease. Checking
    /// that lease here races concurrent Documents readers between the two fences.
    pub(crate) fn file_read_check(
        &mut self,
        params: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let task = self.prepare_file_read(params, grant, self.cancellation.clone()
            .unwrap_or_else(||Arc::new(AtomicBool::new(false))))?.regular_identity();
        let result = task.run();
        self.finish_file_read(&task, result, grant)
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
        if !read_body {
            self.resolve_file_read(params, grant)?;
            return Ok(Value::Null);
        }
        let task = self.prepare_file_read(params, grant, self.cancellation.clone()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false))))?;
        let result = task.run();
        self.finish_file_read(&task, result, grant)
    }
}

#[cfg(test)]
#[path = "non_directory_ancestor_review.rs"]
mod non_directory_ancestor_review;

/// Filesystem effects execute on the admitted worker. Content authority and the
/// retained lease have already been checked by the original Storage owner.
pub(super) fn apply_physical_state(storage_root: &Path, resource: &ResolvedFileResource,
    state: &FileState, cancellation: &AtomicBool) -> Result<(), KernelError> {
    if cancellation.load(Ordering::Acquire) { return Err(KernelError::Cancelled); }
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
                let object = object_path(storage_root, object_hash)?;
                if let Some(parent) = resource.absolute.parent() {
                    fs::create_dir_all(parent)?;
                }
                let temporary = resource.absolute.with_file_name(format!(".varin-kernel-{}", Uuid::new_v4()));
                let mut installed = OpenOptions::new().read(true).write(true).create_new(true).open(&temporary)?;
                let mut owned = EffectTemporary(Some(temporary.clone()));
                let mut input = File::open(object)?;
                let mut hash = Sha256::new();
                let mut length = 0u64;
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    if cancellation.load(Ordering::Acquire) { return Err(KernelError::Cancelled); }
                    let read = input.read(&mut buffer)?;
                    if read == 0 { break; }
                    hash.update(&buffer[..read]);
                    installed.write_all(&buffer[..read])?;
                    length += read as u64;
                }
                if format!("sha256-{}", hex::encode(hash.finalize())) != *object_hash || length != *byte_length {
                    return Err(KernelError::Storage(format!("content object is corrupt: {object_hash}")));
                }
                // The existing open handle can flush readonly files on every platform.
                apply_mode(&temporary, *mode)?;
                installed.sync_all()?;
                drop(installed);
                if cancellation.load(Ordering::Acquire) { return Err(KernelError::Cancelled); }
                if fs::symlink_metadata(&resource.absolute).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink()) {
                    fs::remove_dir(&resource.absolute)?;
                }
                durable_rename(&temporary, &resource.absolute)?;
                owned.0 = None;
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

/// Only the worker that successfully created this unique path owns its cleanup.
struct EffectTemporary(Option<PathBuf>);
impl Drop for EffectTemporary {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            #[cfg(windows)]
            if let Ok(meta) = fs::symlink_metadata(&path) {
                if meta.permissions().readonly() {
                    let mut permissions = meta.permissions();
                    permissions.set_readonly(false);
                    let _ = fs::set_permissions(&path, permissions);
                }
            }
            let _ = fs::remove_file(path);
        }
    }
}
