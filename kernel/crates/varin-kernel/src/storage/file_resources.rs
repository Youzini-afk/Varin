//! Canonical workspace file resources and cross-request path leases.
//!
//! R2 keeps editor buffers in the TypeScript Document Registry while moving
//! controlled disk identity, capture, apply, and CRUD side effects into this
//! kernel. File roots are epoch-local registrations: the Host must re-admit a
//! Documents-authorized canonical root after every kernel restart.
use super::*;
use crate::protocol_generated::{
    KernelFileApplyParams, KernelFileCaptureParams, KernelFileMaterializeParams,
    KernelFileMeasureParams, KernelFileMkdirParams, KernelFileOperationListParams,
    KernelFileOperationReconcileParams, KernelFileRemoveParams, KernelFileRenameParams,
    KernelFileRootRegisterParams, KernelFileScanParams,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum FileState {
    #[serde(rename = "regular-file")]
    RegularFile {
        #[serde(rename = "objectHash")]
        object_hash: String,
        #[serde(rename = "byteLength")]
        byte_length: u64,
        mode: Option<u32>,
    },
    Directory {
        mode: Option<u32>,
    },
    Symlink {
        #[serde(rename = "symlinkTarget")]
        symlink_target: String,
        mode: Option<u32>,
    },
    Missing,
    Unsupported,
}

#[derive(Clone, Debug)]
pub(super) struct ResolvedFileResource {
    pub(super) path: String,
    pub(super) absolute: PathBuf,
}

fn file_params_value(params_value: &Value) -> Value {
    let mut params = params_value.clone();
    if let Some(object) = params.as_object_mut() {
        object.remove("__pathScopes");
    }
    params
}

pub(super) fn parse_file_params<T: DeserializeOwned>(
    params_value: &Value,
) -> Result<T, KernelError> {
    let mut value = file_params_value(params_value);
    // This field is injected only by the typed native adapter. Public wire DTO
    // validation rejects it; it remains part of the durable intent identity.
    if let Some(object) = value.as_object_mut() {
        object.remove("__nativeRequestHash");
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

fn apply_mode(path: &Path, mode: Option<u32>) -> Result<(), KernelError> {
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

fn remove_tree(path: &Path) -> Result<(), KernelError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path).map_err(Into::into)
        }
        Ok(_) => fs::remove_file(path).map_err(Into::into),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn materialize_side_path(path: &str, operation_id: &str, kind: &str) -> String {
    let digest = hex::encode(Sha256::digest(operation_id.as_bytes()));
    format!("{path}.varin-{kind}-{}", &digest[..16])
}

fn materialized_expected_state(state: &PathState) -> FileState {
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

fn copy_object_to(source: &Path, destination: &Path) -> Result<&'static str, KernelError> {
    if clone_file(source, destination)? {
        return Ok("reflink");
    }
    fs::copy(source, destination)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)?
        .sync_all()?;
    Ok("copy")
}

fn durable_directory_rename(source: &Path, target: &Path) -> Result<(), KernelError> {
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

fn create_symlink(target: &str, path: &Path) -> Result<(), KernelError> {
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
    pub(super) fn registered_file_root(
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

    pub(super) fn capture_file_state(
        &mut self,
        resource: &ResolvedFileResource,
        store: bool,
        operation_id: &str,
        workspace_id: &str,
        grant_id: &str,
    ) -> Result<(FileState, Option<String>), KernelError> {
        self.check_cancelled()?;
        let metadata = match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((FileState::Missing, None))
            }
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&resource.absolute)?
                .into_os_string()
                .into_string()
                .map_err(|_| KernelError::Operation("symlink target is not UTF-8".to_string()))?;
            return Ok((
                FileState::Symlink {
                    symlink_target: target,
                    mode: Some(file_mode(&metadata)),
                },
                None,
            ));
        }
        if metadata.is_dir() {
            return Ok((
                FileState::Directory {
                    mode: Some(file_mode(&metadata)),
                },
                None,
            ));
        }
        if !metadata.is_file() {
            return Ok((FileState::Unsupported, None));
        }
        let mode = file_mode(&metadata);
        if !store {
            let (hash, byte_length) = hash_file(&resource.absolute)?;
            let after = fs::symlink_metadata(&resource.absolute)?;
            let (after_hash, after_length) = hash_file(&resource.absolute)?;
            if !after.is_file()
                || file_mode(&after) != mode
                || hash != after_hash
                || byte_length != after_length
            {
                return Err(KernelError::Operation(format!(
                    "file changed while being captured: {}",
                    resource.path
                )));
            }
            return Ok((
                FileState::RegularFile {
                    object_hash: hash,
                    byte_length,
                    mode: Some(mode),
                },
                None,
            ));
        }

        let staging_dir = self.root.join("staging");
        fs::create_dir_all(&staging_dir)?;
        let staging = staging_dir.join(format!("file-capture-{}", Uuid::new_v4()));
        let mut source = BufReader::new(File::open(&resource.absolute)?);
        let mut target_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .read(true)
            .open(&staging)?;
        let mut digest = Sha256::new();
        let mut byte_length = 0u64;
        let mut buffer = [0u8; 128 * 1024];
        loop {
            self.check_cancelled()?;
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            target_file.write_all(&buffer[..read])?;
            digest.update(&buffer[..read]);
            byte_length = byte_length
                .checked_add(read as u64)
                .ok_or_else(|| KernelError::Storage("file size overflow".to_string()))?;
        }
        target_file.sync_all()?;
        drop(target_file);
        let hash = format!("sha256-{}", hex::encode(digest.finalize()));
        let after = fs::symlink_metadata(&resource.absolute)?;
        let (after_hash, after_length) = hash_file(&resource.absolute)?;
        if !after.is_file()
            || file_mode(&after) != mode
            || hash != after_hash
            || byte_length != after_length
        {
            let _ = fs::remove_file(&staging);
            return Err(KernelError::Operation(format!(
                "file changed while being captured: {}",
                resource.path
            )));
        }
        let object = object_path(&self.root, &hash)?;
        if object.exists() {
            let (existing_hash, existing_length) = hash_file(&object)?;
            if existing_hash != hash || existing_length != byte_length {
                let _ = fs::remove_file(&staging);
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {hash}"
                )));
            }
            fs::remove_file(&staging)?;
            sync_directory(&staging_dir)?;
        } else {
            let shard = object.parent().expect("object path has shard");
            if !shard.exists() {
                fs::create_dir_all(shard)?;
                sync_directory(&self.root.join("objects"))?;
            }
            durable_rename(&staging, &object)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&object)?
                .sync_all()?;
            sync_directory(&staging_dir)?;
            sync_directory(shard)?;
        }
        self.conn.execute(
            "INSERT OR IGNORE INTO blobs(hash, byte_length) VALUES (?1, ?2)",
            params![
                hash,
                i64::try_from(byte_length).map_err(|_| KernelError::Operation(
                    "content object is too large".to_string()
                ))?
            ],
        )?;
        self.verified_objects.insert(hash.clone());
        let owner_id = blob_owner_id(operation_id);
        self.record_object_owner(
            &owner_id,
            &hash,
            Some(workspace_id),
            Some(operation_id),
            grant_id,
        )?;
        Ok((
            FileState::RegularFile {
                object_hash: hash,
                byte_length,
                mode: Some(mode),
            },
            Some(owner_id),
        ))
    }

    fn observe_state(&mut self, resource: &ResolvedFileResource) -> Result<FileState, KernelError> {
        self.capture_file_state(resource, false, "observe", "", "")
            .map(|value| value.0)
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

    fn file_state_matches(observed: &FileState, expected: &FileState) -> bool {
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

    fn scan_directory_paths(
        &self,
        root_id: &str,
        grant: &Grant,
        base_path: &str,
        directory: &Path,
        prefix: &str,
        output: &mut Vec<String>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
        for entry in entries {
            let name = entry.file_name().into_string().map_err(|_| {
                KernelError::Operation("filesystem inventory contains a non-UTF-8 path".to_string())
            })?;
            if name == ".git" || name == ".varin" {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let full = if base_path.is_empty() {
                relative.clone()
            } else {
                format!("{base_path}/{relative}")
            };
            let allowed = path_allowed(grant, &full);
            let may_contain_allowed = grant.path_scopes.iter().any(|scope| {
                scope.is_empty() || scope == &full || scope.starts_with(&(full.clone() + "/"))
            });
            if !allowed && !may_contain_allowed {
                continue;
            }
            let resource = self.resolve_file_resource(root_id, &full, grant, false)?;
            let metadata = match fs::symlink_metadata(&resource.absolute) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if allowed {
                output.push(relative.clone());
            }
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                self.scan_directory_paths(
                    root_id,
                    grant,
                    base_path,
                    &resource.absolute,
                    &relative,
                    output,
                )?;
            }
        }
        Ok(())
    }

    fn scan_paths(
        &self,
        root_id: &str,
        base: &ResolvedFileResource,
        scopes: Option<&[String]>,
        grant: &Grant,
    ) -> Result<Vec<String>, KernelError> {
        let mut output = Vec::new();
        let effective_scopes = scopes
            .filter(|values| !values.is_empty())
            .map(|values| values.to_vec())
            .unwrap_or_else(|| vec![String::new()]);
        for raw_scope in effective_scopes {
            let (scope, _) = normalized_relative_path(&raw_scope, true)?;
            if scope.is_empty() {
                self.scan_directory_paths(
                    root_id,
                    grant,
                    &base.path,
                    &base.absolute,
                    "",
                    &mut output,
                )?;
                continue;
            }
            let full = if base.path.is_empty() {
                scope.clone()
            } else {
                format!("{}/{}", base.path, scope)
            };
            if !path_allowed(grant, &full) {
                return Err(KernelError::Authorization(format!(
                    "scan scope is outside grant scope: {full}"
                )));
            }
            let resource = self.resolve_file_resource(root_id, &full, grant, false)?;
            let metadata = match fs::symlink_metadata(&resource.absolute) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            output.push(scope.clone());
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                self.scan_directory_paths(
                    root_id,
                    grant,
                    &base.path,
                    &resource.absolute,
                    &scope,
                    &mut output,
                )?;
            }
        }
        output.sort();
        output.dedup();
        Ok(output)
    }

    fn measure_directory(
        &self,
        directory: &Path,
        logical: &mut u64,
        allocated: &mut u64,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
        for entry in entries {
            self.check_cancelled()?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                self.measure_directory(&path, logical, allocated)?;
                continue;
            }
            *logical = logical.checked_add(metadata.len()).ok_or_else(|| {
                KernelError::Storage("materialized logical size overflow".to_string())
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                *allocated = allocated
                    .checked_add(metadata.blocks().saturating_mul(512))
                    .ok_or_else(|| {
                        KernelError::Storage("materialized allocated size overflow".to_string())
                    })?;
            }
            #[cfg(not(unix))]
            {
                let _ = allocated;
            }
        }
        Ok(())
    }

    fn directory_matches_root(
        &mut self,
        root_id: &str,
        target: &ResolvedFileResource,
        source_root: &str,
        grant: &Grant,
    ) -> Result<bool, KernelError> {
        let metadata = match fs::symlink_metadata(&target.absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Ok(false);
        }
        let expected = self
            .root_entries(source_root)?
            .into_iter()
            .filter(|(_, state)| !matches!(state, PathState::Missing))
            .collect::<Vec<_>>();
        let actual_paths = self.scan_paths(root_id, target, None, grant)?;
        let expected_paths = expected
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        if actual_paths != expected_paths {
            return Ok(false);
        }
        for (path, state) in expected {
            if matches!(state, PathState::Unsupported) {
                return Ok(false);
            }
            let full = if target.path.is_empty() {
                path
            } else {
                format!("{}/{}", target.path, path)
            };
            let resource = self.resolve_file_resource(root_id, &full, grant, false)?;
            let observed = self.observe_state(&resource)?;
            if !Self::file_state_matches(&observed, &materialized_expected_state(&state)) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn build_materialized_root(
        &mut self,
        source_root: &str,
        destination: &Path,
    ) -> Result<(usize, usize), KernelError> {
        remove_tree(destination)?;
        fs::create_dir_all(destination)?;
        let mut entries = self.root_entries(source_root)?;
        entries.sort_by(|left, right| {
            let left_depth = left.0.split('/').count();
            let right_depth = right.0.split('/').count();
            left_depth
                .cmp(&right_depth)
                .then_with(|| left.0.cmp(&right.0))
        });
        let mut reflink = 0usize;
        let mut copy = 0usize;
        let mut directory_modes = Vec::new();
        for (relative, state) in entries {
            self.check_cancelled()?;
            if relative.is_empty() || matches!(state, PathState::Missing) {
                continue;
            }
            let (_, path_part) = normalized_relative_path(&relative, false)?;
            let target = destination.join(path_part);
            if !path_inside(destination, &target) {
                return Err(KernelError::Authorization(
                    "materialize path escaped staging directory".to_string(),
                ));
            }
            match state {
                PathState::Directory { mode } => {
                    remove_existing(&target).or_else(|error| {
                        if target.is_dir() {
                            Ok(())
                        } else {
                            Err(error)
                        }
                    })?;
                    fs::create_dir_all(&target).map_err(|error| {
                        KernelError::Storage(format!(
                            "materialize mkdir failed for {relative}: {error}"
                        ))
                    })?;
                    // Install children before restoring a readonly directory.
                    directory_modes.push((target, mode));
                }
                PathState::RegularFile {
                    object_hash,
                    byte_length,
                    mode,
                } => {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).map_err(|error| {
                            KernelError::Storage(format!(
                                "materialize parent mkdir failed for {relative}: {error}"
                            ))
                        })?;
                    }
                    remove_tree(&target)?;
                    let source = object_path(&self.root, &object_hash)?;
                    let (actual_hash, actual_length) = hash_file(&source)?;
                    if actual_hash != object_hash || actual_length != byte_length {
                        return Err(KernelError::Storage(format!(
                            "materialize object is corrupt: {object_hash}"
                        )));
                    }
                    match copy_object_to(&source, &target).map_err(|error| {
                        KernelError::Storage(format!(
                            "materialize object copy failed for {relative}: {error}"
                        ))
                    })? {
                        "reflink" => reflink += 1,
                        _ => copy += 1,
                    }
                    let installed = OpenOptions::new().read(true).write(true).open(&target)?;
                    apply_mode(&target, Some(mode)).map_err(|error| {
                        KernelError::Storage(format!(
                            "materialize file mode failed for {relative}: {error}"
                        ))
                    })?;
                    installed.sync_all()?;
                }
                PathState::Symlink {
                    symlink_target,
                    mode: _,
                } => {
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent).map_err(|error| {
                            KernelError::Storage(format!(
                                "materialize symlink parent mkdir failed for {relative}: {error}"
                            ))
                        })?;
                    }
                    remove_tree(&target)?;
                    create_symlink(&symlink_target, &target).map_err(|error| {
                        KernelError::Storage(format!(
                            "materialize symlink failed for {relative}: {error}"
                        ))
                    })?;
                }
                PathState::Unsupported => {
                    return Err(KernelError::Operation(format!(
                        "unsupported state cannot be materialized: {relative}"
                    )))
                }
                PathState::Missing => {}
            }
        }
        for (directory, mode) in directory_modes.into_iter().rev() {
            // Flush each directory's own entries, not only the staging root.
            apply_mode(&directory, mode)?;
            sync_directory(&directory)?;
        }
        sync_directory(destination)?;
        Ok((reflink, copy))
    }

    fn begin_file_operation(
        &mut self,
        operation_id: &str,
        kind: &str,
        params_value: &Value,
    ) -> Result<(String, Option<Value>, bool), KernelError> {
        let mut identity_params = file_params_value(params_value);
        if let Some(object) = identity_params.as_object_mut() {
            object.remove("leaseId");
        }
        let params_hash = hash_json(&identity_params)?;
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

    fn finish_file_operation(
        &mut self,
        operation_id: &str,
        result: &Value,
    ) -> Result<(), KernelError> {
        self.finish_file_operation_owned(operation_id, result, None, None)
    }

    fn finish_file_operation_owned(
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
        if let Some(intent) = intent {
            let envelope: Value = serde_json::from_str(&intent)?;
            if let Some(identity) = envelope["intent"]["__nativeRequestHash"].as_str() {
                durable_result["__nativeRequestHash"] = json!(identity);
            }
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            self.operation_finish(operation_id, &durable_result)?;
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
                "SELECT o.operation_id, o.kind, o.result_json FROM operations o JOIN operation_owners w ON w.operation_id = o.operation_id WHERE o.state = 'started' AND w.workspace_id = ?1 AND o.kind LIKE 'file.%' ORDER BY o.created_at, o.operation_id",
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
                    let params: KernelFileMaterializeParams = parse_file_params(intent)?;
                    let target = self.resolve_file_resource(root_id, &params.path, grant, false)?;
                    let stage_path = materialize_side_path(&params.path, &operation_id, "staging");
                    let backup_path = materialize_side_path(&params.path, &operation_id, "backup");
                    let stage = self.resolve_file_resource(root_id, &stage_path, grant, false)?;
                    let backup = self.resolve_file_resource(root_id, &backup_path, grant, false)?;
                    if self
                        .assert_process_directory_idle(&target.absolute)
                        .is_err()
                        || self.assert_process_directory_idle(&stage.absolute).is_err()
                        || self
                            .assert_process_directory_idle(&backup.absolute)
                            .is_err()
                    {
                        unresolved += 1;
                        continue;
                    }
                    if self.directory_matches_root(root_id, &target, &params.source_root, grant)? {
                        Some((
                            json!({
                                "status":"materialized",
                                "root": params.source_root,
                                "reconciled": true,
                                "cow": {"reflink": 0, "copy": 0},
                            }),
                            None,
                            None,
                        ))
                    } else if fs::symlink_metadata(&target.absolute)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                    {
                        if self.directory_matches_root(
                            root_id,
                            &stage,
                            &params.source_root,
                            grant,
                        )? {
                            durable_directory_rename(&stage.absolute, &target.absolute)?;
                            if let Some(parent) = target.absolute.parent() {
                                sync_directory(parent)?;
                            }
                            Some((
                                json!({
                                    "status":"materialized",
                                    "root": params.source_root,
                                    "reconciled": true,
                                    "cow": {"reflink": 0, "copy": 0},
                                }),
                                None,
                                None,
                            ))
                        } else if fs::symlink_metadata(&backup.absolute).is_ok() {
                            let _ = remove_tree(&stage.absolute);
                            durable_directory_rename(&backup.absolute, &target.absolute)?;
                            if let Some(parent) = target.absolute.parent() {
                                sync_directory(parent)?;
                            }
                            Some((
                                json!({
                                    "status":"conflict",
                                    "root": params.source_root,
                                    "reconciled": true,
                                    "reason":"restored backup after incomplete materialization",
                                }),
                                None,
                                None,
                            ))
                        } else {
                            let _ = remove_tree(&stage.absolute);
                            Some((
                                json!({
                                    "status":"conflict",
                                    "root": params.source_root,
                                    "reconciled": true,
                                    "reason":"incomplete materialization left no live or backup directory",
                                }),
                                None,
                                None,
                            ))
                        }
                    } else if fs::symlink_metadata(&backup.absolute).is_ok() {
                        Some((
                            json!({
                                "status":"conflict",
                                "root": params.source_root,
                                "reconciled": true,
                                "reason":"materialized target changed after promotion",
                            }),
                            None,
                            None,
                        ))
                    } else {
                        let _ = remove_tree(&stage.absolute);
                        Some((
                            json!({
                                "status":"conflict",
                                "root": params.source_root,
                                "reconciled": true,
                                "reason":"materialization target is not the immutable source root",
                            }),
                            None,
                            None,
                        ))
                    }
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
                if kind == "file.materialize" {
                    let params: KernelFileMaterializeParams = parse_file_params(intent)?;
                    let stage_path = materialize_side_path(&params.path, &operation_id, "staging");
                    let backup_path = materialize_side_path(&params.path, &operation_id, "backup");
                    if let Ok(stage) =
                        self.resolve_file_resource(root_id, &stage_path, grant, false)
                    {
                        let _ = remove_tree(&stage.absolute);
                    }
                    if result.get("status").and_then(Value::as_str) == Some("materialized") {
                        if let Ok(backup) =
                            self.resolve_file_resource(root_id, &backup_path, grant, false)
                        {
                            let _ = remove_tree(&backup.absolute);
                        }
                    }
                }
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
                let params: KernelFileMaterializeParams = parse_file_params(intent)?;
                let target = self.resolve_file_resource(root_id, &params.path, grant, false)?;
                let stage_path = materialize_side_path(&params.path, operation_id, "staging");
                let backup_path = materialize_side_path(&params.path, operation_id, "backup");
                let stage = self.resolve_file_resource(root_id, &stage_path, grant, false)?;
                let backup = self.resolve_file_resource(root_id, &backup_path, grant, false)?;
                if self.directory_matches_root(root_id, &target, &params.source_root, grant)? {
                    ("reconcile", "target-matches-source-root")
                } else if fs::symlink_metadata(&target.absolute)
                    .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                    && self.directory_matches_root(root_id, &stage, &params.source_root, grant)?
                {
                    ("reconcile", "staging-root-ready-for-promotion")
                } else if fs::symlink_metadata(&target.absolute)
                    .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                    && fs::symlink_metadata(&backup.absolute).is_ok()
                {
                    ("reconcile", "backup-can-be-restored-as-conflict")
                } else {
                    ("needs-attention", "materialization-state-not-provable")
                }
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
                "SELECT o.operation_id, o.kind, o.result_json, o.created_at, o.updated_at FROM operations o JOIN operation_owners w ON w.operation_id = o.operation_id WHERE o.state = 'started' AND w.workspace_id = ?1 AND o.kind LIKE 'file.%' ORDER BY o.created_at, o.operation_id",
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
        let identity = format!(
            "file-root-v2\0{}\0{}\0{}",
            params.workspace_id,
            params.execution_workspace_id,
            canonical.to_string_lossy()
        );
        let root_id = format!(
            "file-root-{}",
            hex::encode(Sha256::digest(identity.as_bytes()))
        );
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

    pub(super) fn file_scan(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileScanParams = parse_file_params(params_value)?;
        let base = self.resolve_file_resource(&params.root_id, &params.path, grant, true)?;
        let paths = self.scan_paths(&params.root_id, &base, params.scopes.as_deref(), grant)?;
        let fingerprint = hash_json(&json!(paths))?;
        let cursor = params.cursor.unwrap_or(0) as usize;
        if (cursor > 0 && params.expected_fingerprint.is_none())
            || params
                .expected_fingerprint
                .as_ref()
                .is_some_and(|expected| expected != &fingerprint)
        {
            return Err(KernelError::Operation(
                "file scan inventory changed or continuation fingerprint is missing".to_string(),
            ));
        }
        let page_size = params.page_size.unwrap_or(512).clamp(1, 4096) as usize;
        if cursor > paths.len() {
            return Err(KernelError::Operation(
                "file scan cursor is out of range".to_string(),
            ));
        }
        let end = (cursor + page_size).min(paths.len());
        let page = paths[cursor..end].to_vec();
        Ok(json!({
            "paths": page,
            "fingerprint": fingerprint,
            "cursor": cursor,
            "nextCursor": if end < paths.len() { Some(end) } else { None },
            "total": paths.len(),
        }))
    }

    pub(super) fn file_measure(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileMeasureParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, true)?;
        let metadata = match fs::symlink_metadata(&resource.absolute) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(json!({
                    "logicalBytes": Value::Null,
                    "allocatedBytes": Value::Null,
                    "unknown": true,
                    "missing": true,
                }));
            }
            Err(error) => return Err(error.into()),
        };
        let mut logical = 0u64;
        let mut allocated = 0u64;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            self.measure_directory(&resource.absolute, &mut logical, &mut allocated)?;
        } else {
            logical = metadata.len();
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                allocated = metadata.blocks().saturating_mul(512);
            }
        }
        #[cfg(unix)]
        let allocated_value = json!(allocated);
        #[cfg(not(unix))]
        let allocated_value = Value::Null;
        Ok(json!({
            "logicalBytes": logical,
            "allocatedBytes": allocated_value,
            "unknown": false,
            "missing": false,
        }))
    }

    pub(super) fn file_capture(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileCaptureParams = parse_file_params(params_value)?;
        let resource = self.resolve_file_resource(&params.root_id, &params.path, grant, true)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: false,
            }],
            params.lease_id.as_deref(),
        )?;
        let (state, owner_id) = self.capture_file_state(
            &resource,
            params.store,
            &params.operation_id,
            &params.workspace_id,
            &grant.grant_id,
        )?;
        Ok(
            json!({"path": resource.path, "stateJson": serde_json::to_string(&state)?, "ownerId": owner_id}),
        )
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
        let (_params_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.apply", params_value)?;
        if let Some(committed) = committed {
            return Ok(committed);
        }
        if let Some(owner_id) = params.owner_id.as_ref() {
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

    pub(super) fn file_materialize(
        &mut self,
        params_value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelFileMaterializeParams = parse_file_params(params_value)?;
        if params.path.is_empty() {
            return Err(KernelError::Authorization(
                "materialize target must be below the registered managed root".to_string(),
            ));
        }
        if !self.root_owned_by_workspace(&params.source_root, &params.workspace_id)? {
            return Err(KernelError::Authorization(
                "materialize source root is not owned by workspace".to_string(),
            ));
        }
        if !grant.path_scopes.iter().any(String::is_empty) {
            return Err(KernelError::Authorization(
                "materialize requires an unbounded source-view grant".to_string(),
            ));
        }
        self.load_node(&params.source_root)?;
        let target = self.resolve_file_resource(&params.root_id, &params.path, grant, false)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[FileLeaseResource {
                path: target.path.clone(),
                subtree: true,
            }],
            params.lease_id.as_deref(),
        )?;
        let stage_path = materialize_side_path(&target.path, &params.operation_id, "staging");
        let backup_path = materialize_side_path(&target.path, &params.operation_id, "backup");
        let stage = self.resolve_file_resource(&params.root_id, &stage_path, grant, false)?;
        let backup = self.resolve_file_resource(&params.root_id, &backup_path, grant, false)?;
        self.assert_file_lease(
            grant,
            &params.root_id,
            &[
                FileLeaseResource {
                    path: stage_path.clone(),
                    subtree: true,
                },
                FileLeaseResource {
                    path: backup_path.clone(),
                    subtree: true,
                },
            ],
            None,
        )?;

        let (_hash, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.materialize", params_value)?;
        if let Some(committed) = committed {
            // The receipt is immutable; later files at these pathnames are not
            // owned by replaying an old terminal operation.
            return Ok(committed);
        }

        self.assert_process_directory_idle(&target.absolute)?;
        self.assert_process_directory_idle(&stage.absolute)?;
        self.assert_process_directory_idle(&backup.absolute)?;
        if self.directory_matches_root(&params.root_id, &target, &params.source_root, grant)? {
            let result = json!({
                "status": "materialized",
                "root": params.source_root,
                "reconciled": resuming,
                "cow": {"reflink": 0, "copy": 0},
            });
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }

        if resuming
            && fs::symlink_metadata(&backup.absolute).is_ok()
            && fs::symlink_metadata(&target.absolute).is_ok()
        {
            let result = json!({
                "status": "conflict",
                "root": params.source_root,
                "reconciled": true,
                "reason": "materialized target changed after promotion",
            });
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }

        if resuming {
            return Err(KernelError::Operation(
                "materialize needs attention: interrupted state requires reconciliation, not replacement".to_string()));
        }
        let occupied = match fs::symlink_metadata(&target.absolute) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                fs::read_dir(&target.absolute)?
                    .next()
                    .transpose()?
                    .is_some()
            }
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if occupied
            || fs::symlink_metadata(&stage.absolute).is_ok()
            || fs::symlink_metadata(&backup.absolute).is_ok()
        {
            let result = json!({"status": "conflict", "root": params.source_root,
                "reason": "materialization target or staging/backup path contains unowned content"});
            self.finish_file_operation(&params.operation_id, &result)?;
            return Ok(result);
        }
        let (reflink, copy) = self
            .build_materialized_root(&params.source_root, &stage.absolute)
            .map_err(|error| {
                KernelError::Storage(format!("materialize staging build failed: {error}"))
            })?;
        if fs::symlink_metadata(&target.absolute).is_ok() {
            if fs::symlink_metadata(&backup.absolute).is_ok() {
                if resuming {
                    return Err(KernelError::Operation(
                        "materialize recovery found both live and backup directories".to_string(),
                    ));
                }
                remove_tree(&backup.absolute)?;
            }
            durable_directory_rename(&target.absolute, &backup.absolute).map_err(|error| {
                KernelError::Storage(format!("materialize live backup failed: {error}"))
            })?;
            if let Some(parent) = target.absolute.parent() {
                sync_directory(parent)?;
            }
            if std::env::var_os("VARIN_KERNEL_FAIL_MATERIALIZE_AFTER_BACKUP").is_some() {
                return Err(KernelError::Storage(
                    "injected materialize failure after backup".to_string(),
                ));
            }
        }
        if let Some(parent) = target.absolute.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Err(error) =
            durable_directory_rename(&stage.absolute, &target.absolute).map_err(|error| {
                KernelError::Storage(format!("materialize staging promote failed: {error}"))
            })
        {
            if fs::symlink_metadata(&backup.absolute).is_ok()
                && fs::symlink_metadata(&target.absolute)
                    .is_err_and(|value| value.kind() == io::ErrorKind::NotFound)
            {
                let _ = durable_directory_rename(&backup.absolute, &target.absolute);
            }
            return Err(error);
        }
        if let Some(parent) = target.absolute.parent() {
            sync_directory(parent)?;
        }
        if !self.directory_matches_root(&params.root_id, &target, &params.source_root, grant)? {
            // Verification can fail because an external writer changed live.
            // Retain both generations; do not erase user bytes to fake rollback.
            return Err(KernelError::Storage(
                "materialize needs attention: live differs from immutable source; live and backup were preserved".to_string(),
            ));
        }
        let result = json!({
            "status": "materialized",
            "root": params.source_root,
            "reconciled": resuming,
            "cow": {"reflink": reflink, "copy": copy},
        });
        // Keep the backup until the durable terminal record commits. If the
        // response/finish is lost, the next call or root registration can
        // prove the live directory equals sourceRoot before deleting it.
        self.finish_file_operation(&params.operation_id, &result)?;
        remove_tree(&backup.absolute)?;
        let _ = remove_tree(&stage.absolute);
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
    let current_root = fs::canonicalize(&root.canonical_root)?;
    if current_root != root.canonical_root || !fs::metadata(&current_root)?.is_dir() {
        return Err(KernelError::Authorization(
            "registered file root identity changed".into(),
        ));
    }
    let (path, relative_path) = normalized_relative_path(relative, allow_root)?;
    if !path_allowed(grant, &path) {
        return Err(KernelError::Authorization(format!(
            "path is outside grant scope: {path}"
        )));
    }
    let mut current = root.canonical_root.clone();
    let components = relative_path.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let next = current.join(component.as_os_str());
        if index + 1 < components.len() {
            match fs::canonicalize(&next) {
                Ok(canonical) => {
                    if !path_inside(&root.canonical_root, &canonical) {
                        return Err(KernelError::Authorization(
                            "file path escaped the registered workspace root".to_string(),
                        ));
                    }
                    current = canonical;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
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
    if !path_inside(&root.canonical_root, &current) {
        return Err(KernelError::Authorization(
            "file path escaped the registered workspace root".to_string(),
        ));
    }
    let canonical_relative = current.strip_prefix(&root.canonical_root).map_err(|_| {
        KernelError::Authorization("resolved resource is outside registered root".to_string())
    })?;
    let canonical_scope = canonical_relative
        .to_str()
        .ok_or_else(|| KernelError::Authorization("resolved resource is not UTF-8".to_string()))?
        .replace('\\', "/");
    if !path_allowed(grant, &canonical_scope) {
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
    /// Typed native adapter entry point. This is deliberately not a wire method:
    /// the bound Run supplies the root, and the existing grant/root/lease owner
    /// still admits every read. Materialized sources observe their actual disk.
    pub(crate) fn native_file_read(
        &mut self,
        params: &Value,
        grant: &Grant,
        read_body: bool,
    ) -> Result<Value, KernelError> {
        let root_id = params["rootId"].as_str().ok_or_else(|| {
            KernelError::Authorization("materialized source root is missing".into())
        })?;
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
        if !read_body {
            return Ok(Value::Null);
        }
        let source = json!({"mode":"materialized","rootId":root_id});
        let metadata = match fs::symlink_metadata(&resource.absolute) {
            Ok(value) => value,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(
                    json!({"path":path,"source":source,"missing":true,"readVersion":super::native_file_mutations::read_version(grant,root_id,&resource.path,&FileState::Missing)?}),
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
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(&resource.absolute)?;
        let before = file.metadata()?;
        if !before.is_file() {
            return Err(KernelError::Operation("file changed before read".into()));
        }
        let byte_length = before.len();
        let offset = params["offset"].as_u64().unwrap_or(0);
        let length = match params.get("length") {
            Some(value) => value
                .as_u64()
                .ok_or_else(|| KernelError::Operation("invalid byte range".into()))?,
            None => byte_length.saturating_sub(offset),
        };
        if (params.get("length").is_none() && byte_length > MAX_BLOB_RESPONSE_BYTES as u64)
            || length > MAX_BLOB_RESPONSE_BYTES as u64
        {
            return Err(KernelError::Operation(
                "file is larger than one response frame; request a byte range".into(),
            ));
        }
        let start = offset.min(byte_length);
        let end = start.saturating_add(length).min(byte_length);
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0u8; (end - start) as usize];
        for chunk in bytes.chunks_mut(128 * 1024) {
            self.check_cancelled()?;
            file.read_exact(chunk)?;
        }
        self.check_cancelled()?;
        let after = file.metadata()?;
        let resolved = self.resolve_file_resource(root_id, path, grant, false)?;
        let current = fs::symlink_metadata(&resolved.absolute)?;
        let mut changed = resolved.absolute != resource.absolute
            || !current.is_file()
            || current.file_type().is_symlink()
            || before.len() != after.len()
            || before.modified()? != after.modified()?
            || file_mode(&before) != file_mode(&after)
            || after.len() != current.len()
            || after.modified()? != current.modified()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            changed |= after.dev() != current.dev() || after.ino() != current.ino();
        }
        if changed {
            return Err(KernelError::Operation(
                "file changed while being read".into(),
            ));
        }
        let version = if start == 0 && end == byte_length {
            let state = FileState::RegularFile {
                object_hash: format!("sha256-{}", hex::encode(Sha256::digest(&bytes))),
                byte_length,
                mode: Some(file_mode(&after)),
            };
            Some(super::native_file_mutations::read_version(
                grant,
                root_id,
                &resource.path,
                &state,
            )?)
        } else {
            None
        };
        let mut content = json!({"byteLength":byte_length,"offset":start,"nextOffset":end,"eof":end>=byte_length});
        match String::from_utf8(bytes) {
            Ok(text) => content["text"] = Value::String(text),
            Err(error) => content["bytesBase64"] = Value::String(BASE64.encode(error.as_bytes())),
        }
        let mut result = json!({"path":path,"source":source,"missing":false,"content":content});
        if let Some(version) = version {
            result["readVersion"] = json!(version);
        }
        Ok(result)
    }
}
