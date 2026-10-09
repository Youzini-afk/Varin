//! Materialization bodies and recovery observations run independently of Storage.
//! The worker reads an immutable tree retained by its started journal. Storage alone
//! admits physical leases, authorizes effects, moves directories and commits facts.
use super::file_resources::{
    apply_mode, copy_object_to, create_symlink, durable_directory_rename, file_mode,
    materialize_side_path, materialized_expected_state, normalized_relative_path,
    parse_file_params, resolve_admitted_resource, FileState, ResolvedFileResource,
};
use super::*;
use crate::protocol_generated::KernelFileMaterializeParams;
use serde::{Deserialize, Serialize};

pub(crate) enum Admission {
    Complete(Value),
    Work(Task),
}

pub(crate) struct Task {
    pub(crate) operation_id: String,
    pub(crate) job_id: String,
    params: KernelFileMaterializeParams,
    root: FileRoot,
    grant: Grant,
    storage_root: PathBuf,
    cancellation: Arc<AtomicBool>,
    resuming: bool,
    journal: Value,
    paths: [ResolvedFileResource; 3],
}

pub(super) struct ActiveMaterialization {
    job_id: String,
    params: KernelFileMaterializeParams,
    root: FileRoot,
    grant: Grant,
    cancellation: Arc<AtomicBool>,
    lease_id: String,
    caller_lease: Option<FileLease>,
    target: ResolvedFileResource,
    stage: ResolvedFileResource,
    backup: ResolvedFileResource,
}

/// A stable directory identity also survives a rename and a kernel restart.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DirectoryIdentity {
    volume: u64,
    file: u64,
}

fn directory_identity(path: &Path) -> Result<Option<DirectoryIdentity>, KernelError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(KernelError::Operation(
            "materialization directory was replaced".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Some(DirectoryIdentity {
            volume: metadata.dev(),
            file: metadata.ino(),
        }))
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        #[repr(C)]
        #[derive(Default)]
        struct FileTime {
            low: u32,
            high: u32,
        }
        #[repr(C)]
        #[derive(Default)]
        struct Information {
            attributes: u32,
            creation: FileTime,
            access: FileTime,
            write: FileTime,
            volume: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandle(
                handle: *mut std::ffi::c_void,
                info: *mut Information,
            ) -> i32;
        }
        // OPEN_REPARSE_POINT prevents a concurrently installed junction being followed.
        let handle = OpenOptions::new()
            .access_mode(0)
            .custom_flags(0x0200_0000 | 0x0020_0000)
            .open(path)?;
        let mut info = Information::default();
        if unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        if info.attributes & 0x400 != 0 || info.attributes & 0x10 == 0 {
            return Err(KernelError::Operation(
                "materialization directory was replaced".into(),
            ));
        }
        Ok(Some(DirectoryIdentity {
            volume: u64::from(info.volume),
            file: (u64::from(info.index_high) << 32) | u64::from(info.index_low),
        }))
    }
}

fn exists(path: &Path) -> Result<bool, KernelError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn empty_directory(path: &Path) -> Result<bool, KernelError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    if directory_identity(path)?.is_none() {
        return Ok(false);
    }
    Ok(fs::read_dir(path)?.next().transpose()?.is_none())
}

fn has_directory_identity(path: &Path, identity: &DirectoryIdentity) -> Result<bool, KernelError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    Ok(directory_identity(path)?.as_ref() == Some(identity))
}

fn journal_directory_identity(
    journal: &Value,
    field: &str,
) -> Result<Option<DirectoryIdentity>, KernelError> {
    Ok(journal
        .get(field)
        .cloned()
        .map(serde_json::from_value::<Option<DirectoryIdentity>>)
        .transpose()?
        .flatten())
}

pub(crate) enum Control {
    CreateStage,
    Promote {
        stage: DirectoryIdentity,
        original: Option<DirectoryIdentity>,
    },
    RestoreBackup {
        backup: DirectoryIdentity,
    },
    Commit {
        result: Value,
        effect_observed: bool,
    },
}

pub(crate) enum Controlled {
    Stage {
        stage: DirectoryIdentity,
        original: Option<DirectoryIdentity>,
    },
    Promoted,
    Restored,
    Committed,
}

fn check(cancel: &AtomicBool) -> Result<(), KernelError> {
    if cancel.load(Ordering::Acquire) {
        Err(KernelError::Cancelled)
    } else {
        Ok(())
    }
}

fn digest(path: &Path, cancellation: Option<&AtomicBool>) -> Result<(String, u64), KernelError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut reader = options.open(path)?;
    if !reader.metadata()?.is_file() {
        return Err(KernelError::Operation(
            "materialization file was replaced".into(),
        ));
    }
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if let Some(cancel) = cancellation {
            check(cancel)?;
        }
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        length = length
            .checked_add(count as u64)
            .ok_or_else(|| KernelError::Storage("materialization length overflow".into()))?;
    }
    Ok((format!("sha256-{}", hex::encode(digest.finalize())), length))
}

impl Task {
    fn resource(&self, path: &str) -> Result<ResolvedFileResource, KernelError> {
        let resolved = resolve_admitted_resource(&self.root, path, &self.grant, false)?;
        for base in &self.paths {
            let expected = if path == base.path {
                Some(base.absolute.clone())
            } else {
                path.strip_prefix(&(base.path.clone() + "/"))
                    .map(|relative| base.absolute.join(relative))
            };
            if expected.is_some_and(|expected| expected != resolved.absolute) {
                return Err(KernelError::Authorization(
                    "materialization physical path changed after admission".into(),
                ));
            }
        }
        Ok(resolved)
    }

    fn entries(&self) -> Result<Vec<(String, PathState)>, KernelError> {
        let conn = Connection::open_with_flags(
            self.storage_root.join("catalog.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut pending = vec![(self.params.source_root.clone(), String::new(), true)];
        let mut entries = Vec::new();
        while let Some((hash, prefix, path_node)) = pending.pop() {
            check(&self.cancellation)?;
            let encoded: String = conn.query_row(
                "SELECT children_json FROM trie_nodes WHERE hash=?1",
                [&hash],
                |row| row.get(0),
            )?;
            let node: TrieNode = serde_json::from_str(&encoded)?;
            if node_hash(&node) != hash {
                return Err(KernelError::Storage(format!("corrupt trie node {hash}")));
            }
            match node {
                TrieNode::Path { state, children } if path_node => {
                    if let Some(state) = state {
                        entries.push((prefix.clone(), state));
                    }
                    if let Some(children) = children {
                        pending.push((children, prefix, false));
                    }
                }
                TrieNode::Index {
                    key,
                    child,
                    left,
                    right,
                    ..
                } if !path_node => {
                    if let Some(right) = right {
                        pending.push((right, prefix.clone(), false));
                    }
                    let path = if prefix.is_empty() {
                        key
                    } else {
                        format!("{prefix}/{key}")
                    };
                    normalized_relative_path(&path, false)?;
                    pending.push((child, path, true));
                    if let Some(left) = left {
                        pending.push((left, prefix, false));
                    }
                }
                _ => {
                    return Err(KernelError::Storage(
                        "materialization source tree has an invalid node type".into(),
                    ))
                }
            }
        }
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(entries)
    }

    /// Observe immutable source content without modifying existing .git/.varin assets.
    fn matches(
        &self,
        resource: &ResolvedFileResource,
        entries: &[(String, PathState)],
        cancellable: bool,
    ) -> Result<bool, KernelError> {
        if !exists(&resource.absolute)? {
            return Ok(false);
        }
        if !fs::symlink_metadata(&resource.absolute)?.is_dir()
            || fs::symlink_metadata(&resource.absolute)?
                .file_type()
                .is_symlink()
        {
            return Ok(false);
        }
        let identity = directory_identity(&resource.absolute)?;
        let expected = entries
            .iter()
            .filter(|(path, state)| !path.is_empty() && !matches!(state, PathState::Missing))
            .collect::<Vec<_>>();
        let mut actual = Vec::new();
        let mut pending = vec![String::new()];
        while let Some(prefix) = pending.pop() {
            if cancellable {
                check(&self.cancellation)?;
            }
            let full = if prefix.is_empty() {
                resource.path.clone()
            } else {
                format!("{}/{}", resource.path, prefix)
            };
            let directory = self.resource(&full)?;
            let metadata = fs::symlink_metadata(&directory.absolute)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Ok(false);
            }
            for entry in fs::read_dir(&directory.absolute)? {
                if cancellable {
                    check(&self.cancellation)?;
                }
                let entry = entry?;
                let name = entry.file_name().into_string().map_err(|_| {
                    KernelError::Operation("filesystem inventory contains a non-UTF-8 path".into())
                })?;
                // Existing Git/Varin metadata is outside immutable source content;
                // observing a match never removes it or replaces that directory.
                if resource.path == self.paths[0].path && (name == ".git" || name == ".varin") {
                    continue;
                }
                let relative = if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}/{name}")
                };
                let child = self.resource(&format!("{}/{}", resource.path, relative))?;
                let metadata = fs::symlink_metadata(&child.absolute)?;
                if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    pending.push(relative.clone());
                }
                actual.push(relative);
            }
        }
        actual.sort();
        if actual
            != expected
                .iter()
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>()
        {
            return Ok(false);
        }
        for (path, state) in expected {
            if cancellable {
                check(&self.cancellation)?;
            }
            let child = self.resource(&format!("{}/{}", resource.path, path))?;
            let metadata = fs::symlink_metadata(&child.absolute)?;
            let observed = if metadata.file_type().is_symlink() {
                FileState::Symlink {
                    symlink_target: fs::read_link(&child.absolute)?
                        .into_os_string()
                        .into_string()
                        .map_err(|_| {
                            KernelError::Operation("symlink target is not UTF-8".into())
                        })?,
                    mode: Some(file_mode(&metadata)),
                }
            } else if metadata.is_dir() {
                FileState::Directory {
                    mode: Some(file_mode(&metadata)),
                }
            } else if metadata.is_file() {
                let (object_hash, byte_length) = digest(
                    &child.absolute,
                    cancellable.then_some(self.cancellation.as_ref()),
                )?;
                let after = fs::symlink_metadata(&child.absolute)?;
                if !after.is_file()
                    || after.file_type().is_symlink()
                    || metadata.len() != after.len()
                    || file_mode(&metadata) != file_mode(&after)
                    || metadata.modified().ok() != after.modified().ok()
                {
                    return Ok(false);
                }
                FileState::RegularFile {
                    object_hash,
                    byte_length,
                    mode: Some(file_mode(&metadata)),
                }
            } else {
                FileState::Unsupported
            };
            if matches!(state, PathState::Unsupported)
                || !Storage::file_state_matches(&observed, &materialized_expected_state(state))
            {
                return Ok(false);
            }
        }
        Ok(directory_identity(&resource.absolute)? == identity)
    }

    fn build(
        &self,
        stage: &ResolvedFileResource,
        identity: &DirectoryIdentity,
        entries: &[(String, PathState)],
    ) -> Result<(usize, usize), KernelError> {
        let mut entries = entries.iter().collect::<Vec<_>>();
        entries.sort_by_key(|(path, _)| (path.split('/').count(), path.clone()));
        let mut directory_modes = Vec::new();
        let (mut reflink, mut copy) = (0, 0);
        for (relative, state) in entries {
            check(&self.cancellation)?;
            if directory_identity(&stage.absolute)?.as_ref() != Some(identity) {
                return Err(KernelError::Operation(
                    "materialization staging directory changed".into(),
                ));
            }
            if relative.is_empty() || matches!(state, PathState::Missing) {
                continue;
            }
            let (_, part) = normalized_relative_path(relative, false)?;
            // Do not traverse a symlink from the immutable tree as a parent.
            let mut parent = stage.absolute.clone();
            let components = part.components().collect::<Vec<_>>();
            for component in &components[..components.len() - 1] {
                parent.push(component.as_os_str());
                match fs::create_dir(&parent) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        directory_identity(&parent)?.ok_or_else(|| {
                            KernelError::Operation("staging parent disappeared".into())
                        })?;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            let target = stage.absolute.join(part);
            if exists(&target)? {
                return Err(KernelError::Operation(
                    "materialization staging path contains unexpected content".into(),
                ));
            }
            match state {
                PathState::Directory { mode } => {
                    fs::create_dir(&target)?;
                    directory_modes.push((target, *mode));
                }
                PathState::RegularFile {
                    object_hash,
                    byte_length,
                    mode,
                } => {
                    let source = object_path(&self.storage_root, object_hash)?;
                    let (actual_hash, actual_length) = digest(&source, Some(&self.cancellation))?;
                    if actual_hash != *object_hash || actual_length != *byte_length {
                        return Err(KernelError::Storage(format!(
                            "materialize object is corrupt: {object_hash}"
                        )));
                    }
                    check(&self.cancellation)?;
                    match copy_object_to(&source, &target, &self.cancellation)? {
                        "reflink" => reflink += 1,
                        _ => copy += 1,
                    }
                    let installed = OpenOptions::new().read(true).write(true).open(&target)?;
                    apply_mode(&target, Some(*mode))?;
                    installed.sync_all()?;
                }
                PathState::Symlink { symlink_target, .. } => {
                    create_symlink(symlink_target, &target)?
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
            apply_mode(&directory, mode)?;
            sync_directory(&directory)?;
        }
        sync_directory(&stage.absolute)?;
        Ok((reflink, copy))
    }

    pub(crate) fn run(
        &self,
        mut control: impl FnMut(Control) -> Result<Controlled, KernelError>,
    ) -> Result<Value, KernelError> {
        let entries = self.entries()?;
        let target = self.resource(&self.params.path)?;
        let stage = self.resource(&materialize_side_path(
            &target.path,
            &self.operation_id,
            "staging",
        ))?;
        let backup = self.resource(&materialize_side_path(
            &target.path,
            &self.operation_id,
            "backup",
        ))?;
        let mut effect_observed = false;
        let mut cow = (0, 0);
        let mut cleanup_backup = None;
        let original = journal_directory_identity(&self.journal, "materializationOriginal")?;
        let recorded_stage = journal_directory_identity(&self.journal, "materializationStage")?;
        let result = if self.matches(&target, &entries, true)? {
            effect_observed = self.resuming;
            // Only the original empty directory is eligible for deletion.
            cleanup_backup = original;
            self.success(cow)
        } else if self.resuming {
            let target_absent = !exists(&target.absolute)?;
            let staging_owned = match recorded_stage.as_ref() {
                Some(identity) if target_absent => {
                    has_directory_identity(&stage.absolute, identity)?
                }
                _ => false,
            };
            let original_held = if target_absent {
                match original.as_ref() {
                    Some(identity) => has_directory_identity(&backup.absolute, identity)?,
                    None => !exists(&backup.absolute)?,
                }
            } else {
                false
            };
            if target_absent
                && staging_owned
                && original_held
                && self.matches(&stage, &entries, true)?
            {
                let identity = recorded_stage.expect("journal-proven stage");
                control(Control::Promote {
                    stage: identity,
                    original: original.clone(),
                })?;
                effect_observed = true;
                cleanup_backup = original;
                if self.matches(&target, &entries, false)? {
                    self.success(cow)
                } else {
                    self.conflict("materialized target changed after promotion")
                }
            } else if target_absent && exists(&backup.absolute)? {
                if let Some(identity) = original {
                    if has_directory_identity(&backup.absolute, &identity)?
                        && empty_directory(&backup.absolute)?
                    {
                        control(Control::RestoreBackup { backup: identity })?;
                        effect_observed = true;
                        self.conflict("restored backup after incomplete materialization")
                    } else {
                        self.conflict("materialization backup differs from the journal-proven original; directories were preserved")
                    }
                } else {
                    self.conflict("materialization journal does not own the backup; directories were preserved")
                }
            } else {
                self.conflict("interrupted materialization differs from immutable source; directories were preserved")
            }
        } else if (exists(&target.absolute)? && !empty_directory(&target.absolute)?)
            || exists(&stage.absolute)?
            || exists(&backup.absolute)?
        {
            self.conflict("materialization target or staging/backup path contains unowned content")
        } else {
            let Controlled::Stage {
                stage: identity,
                original,
            } = control(Control::CreateStage)?
            else {
                return Err(KernelError::Storage(
                    "invalid materialization stage response".into(),
                ));
            };
            cow = self.build(&stage, &identity, &entries)?;
            if !self.matches(&stage, &entries, true)? {
                return Err(KernelError::Storage(
                    "materialization staging differs from immutable source".into(),
                ));
            }
            control(Control::Promote {
                stage: identity,
                original: original.clone(),
            })?;
            effect_observed = true;
            cleanup_backup = original;
            // A cancellation after promotion does not erase the actual effect.
            if self.matches(&target, &entries, false)? {
                self.success(cow)
            } else {
                self.conflict(
                    "materialized target changed after promotion; directories were preserved",
                )
            }
        };
        control(Control::Commit {
            result: result.clone(),
            effect_observed,
        })?;
        if result["status"] == "materialized" && !self.cancellation.load(Ordering::Acquire) {
            if let Some(identity) = cleanup_backup {
                // Recursive cleanup cannot delete later user content. The old
                // target was empty; remove_dir both proves and preserves that.
                if directory_identity(&backup.absolute).ok().flatten().as_ref() == Some(&identity)
                    && empty_directory(&backup.absolute).unwrap_or(false)
                {
                    let _ = fs::remove_dir(&backup.absolute);
                }
            }
        }
        Ok(result)
    }

    fn success(&self, (reflink, copy): (usize, usize)) -> Value {
        json!({"status":"materialized","root":self.params.source_root,
            "reconciled":self.resuming,"cow":{"reflink":reflink,"copy":copy}})
    }
    fn conflict(&self, reason: &str) -> Value {
        json!({"status":"conflict","root":self.params.source_root,"reconciled":self.resuming,"reason":reason})
    }
}

impl Storage {
    pub(crate) fn pending_materializations(
        &self,
        root_id: &str,
        workspace_id: &str,
        operation_id: Option<&str>,
    ) -> Result<Vec<Value>, KernelError> {
        let mut statement = self.conn.prepare("SELECT o.result_json FROM operations o JOIN operation_owners w
            ON w.operation_id=o.operation_id WHERE o.state='started' AND o.kind='file.materialize'
            AND w.workspace_id=?1 AND (?2 IS NULL OR o.operation_id=?2) ORDER BY o.created_at,o.operation_id")?;
        let rows = statement.query_map(params![workspace_id, operation_id], |row| {
            row.get::<_, String>(0)
        })?;
        let mut intents = Vec::new();
        for row in rows {
            let envelope: Value = serde_json::from_str(&row?)?;
            if envelope["intent"]["rootId"] == root_id {
                intents.push(envelope["intent"].clone());
            }
        }
        Ok(intents)
    }

    pub(crate) fn prepare_materialization(
        &mut self,
        value: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Admission, KernelError> {
        check(&cancellation)?;
        let params: KernelFileMaterializeParams = parse_file_params(value)?;
        if params.path.is_empty() || params.operation_id.is_empty() {
            return Err(KernelError::Operation(
                "materialization requires an operation identity and target below its root".into(),
            ));
        }
        if !grant.path_scopes.iter().any(String::is_empty) {
            return Err(KernelError::Authorization(
                "materialize requires an unbounded source-view grant".into(),
            ));
        }
        let root = self.registered_file_root(&params.root_id, grant)?;
        let target = self.resolve_file_resource(&params.root_id, &params.path, grant, false)?;
        if let Some(receipt) = self.committed_file_operation(
            &params.operation_id,
            "file.materialize",
            value,
            &params.workspace_id,
        )? {
            return Ok(Admission::Complete(receipt));
        }
        if self.materializations.contains_key(&params.operation_id) {
            return Err(KernelError::Operation(
                "materialization operation is already active".into(),
            ));
        }
        if !self.root_owned_by_workspace(&params.source_root, &params.workspace_id)? {
            // Pending journals retain source ownership even after caller pins go away.
            let retained = self
                .pending_materializations(
                    &params.root_id,
                    &params.workspace_id,
                    Some(&params.operation_id),
                )?
                .iter()
                .any(|intent| intent["sourceRoot"] == params.source_root);
            if !retained {
                return Err(KernelError::Authorization(
                    "materialize source root is not owned by workspace".into(),
                ));
            }
        }
        self.load_node(&params.source_root)?;
        let stage = self.resolve_file_resource(
            &params.root_id,
            &materialize_side_path(&target.path, &params.operation_id, "staging"),
            grant,
            false,
        )?;
        let backup = self.resolve_file_resource(
            &params.root_id,
            &materialize_side_path(&target.path, &params.operation_id, "backup"),
            grant,
            false,
        )?;
        let paths = [target.path.clone(), stage.path.clone(), backup.path.clone()].map(|path| {
            FileLeaseResource {
                path,
                subtree: true,
            }
        });
        self.assert_file_lease(
            grant,
            &params.root_id,
            &paths[..1],
            params.lease_id.as_deref(),
        )?;
        self.assert_file_lease(grant, &params.root_id, &paths[1..], None)?;
        let (_, committed, resuming) =
            self.begin_file_operation(&params.operation_id, "file.materialize", value)?;
        if let Some(value) = committed {
            return Ok(Admission::Complete(value));
        }
        for path in [&target, &stage, &backup] {
            self.assert_process_directory_idle(&path.absolute)?;
        }
        let journal: String = self.conn.query_row(
            "SELECT result_json FROM operations WHERE operation_id=?1",
            [&params.operation_id],
            |row| row.get(0),
        )?;
        let journal = serde_json::from_str(&journal)?;
        let job_id = Uuid::new_v4().to_string();
        let lease_id = format!("materialization:{job_id}");
        let canonical_resources = self.canonical_lease_resources(&params.root_id, &paths, grant)?;
        let caller_lease = params
            .lease_id
            .as_ref()
            .and_then(|id| self.file_leases.get(id))
            .cloned();
        self.file_leases.insert(
            lease_id.clone(),
            FileLease {
                lease_id: lease_id.clone(),
                root_id: root.root_id.clone(),
                workspace_id: params.workspace_id.clone(),
                grant_id: grant.grant_id.clone(),
                resources: paths.to_vec(),
                canonical_resources,
            },
        );
        self.retained_file_leases.insert(
            lease_id.clone(),
            super::file_resource_leases::RetainedFileLease {
                release_requested: true,
            },
        );
        if let Some(lease) = &caller_lease {
            self.retained_file_leases.insert(
                lease.lease_id.clone(),
                super::file_resource_leases::RetainedFileLease {
                    release_requested: false,
                },
            );
        }
        self.materializations.insert(
            params.operation_id.clone(),
            ActiveMaterialization {
                job_id: job_id.clone(),
                params: params.clone(),
                root: root.clone(),
                grant: grant.clone(),
                cancellation: cancellation.clone(),
                lease_id,
                caller_lease,
                target: target.clone(),
                stage: stage.clone(),
                backup: backup.clone(),
            },
        );
        Ok(Admission::Work(Task {
            operation_id: params.operation_id.clone(),
            job_id,
            params,
            root,
            grant: grant.clone(),
            storage_root: self.root.clone(),
            cancellation,
            resuming,
            journal,
            paths: [target, stage, backup],
        }))
    }

    pub(crate) fn control_materialization(
        &mut self,
        operation_id: &str,
        job_id: &str,
        control: Control,
        revoked: bool,
    ) -> Result<Controlled, KernelError> {
        let active = self.materializations.get(operation_id).ok_or_else(|| {
            KernelError::Operation("materialization worker is no longer active".into())
        })?;
        if active.job_id != job_id {
            return Err(KernelError::Authorization(
                "materialization execution identity changed".into(),
            ));
        }
        let factual_commit = matches!(
            &control,
            Control::Commit {
                effect_observed: true,
                ..
            }
        );
        let grant = if factual_commit {
            active.grant.clone()
        } else {
            if revoked {
                return Err(KernelError::Authorization("grant is revoked".into()));
            }
            check(&active.cancellation)?;
            self.authorize(
                Some(&active.grant.grant_id),
                &active.grant.kernel_epoch,
                &active.grant.host_id,
                &active.grant.host_generation,
                "file.materialize",
                &json!({"workspaceId":active.params.workspace_id}),
            )?
            .0
        };
        let params = active.params.clone();
        let root = active.root.clone();
        let paths = [
            active.target.clone(),
            active.stage.clone(),
            active.backup.clone(),
        ];
        let held = self
            .file_leases
            .get(&active.lease_id)
            .ok_or_else(|| KernelError::Operation("materialization lease disappeared".into()))?;
        if held.grant_id != grant.grant_id || held.root_id != root.root_id {
            return Err(KernelError::Authorization(
                "materialization lease owner changed".into(),
            ));
        }
        if let Some(caller) = &active.caller_lease {
            let current = self.file_leases.get(&caller.lease_id).ok_or_else(|| {
                KernelError::Operation("materialization caller lease disappeared".into())
            })?;
            if current.canonical_resources != caller.canonical_resources
                || current.grant_id != caller.grant_id
            {
                return Err(KernelError::Authorization(
                    "materialization caller lease changed".into(),
                ));
            }
        }
        let current: (String, String) = self.conn.query_row(
            "SELECT state,result_json FROM operations WHERE operation_id=?1",
            [operation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if current.0 != "started" {
            return Err(KernelError::Operation(
                "materialization journal changed before publication".into(),
            ));
        }
        let mut journal: Value = serde_json::from_str(&current.1)?;
        if !factual_commit {
            if self
                .registered_file_root(&root.root_id, &grant)?
                .canonical_root
                != root.canonical_root
            {
                return Err(KernelError::Authorization(
                    "materialization root changed".into(),
                ));
            }
            for path in &paths {
                if resolve_admitted_resource(&root, &path.path, &grant, false)?.absolute
                    != path.absolute
                {
                    return Err(KernelError::Authorization(
                        "materialization path changed".into(),
                    ));
                }
                self.assert_process_directory_idle(&path.absolute)?;
            }
        }
        let [target, stage, backup] = &paths;
        match control {
            Control::CreateStage => {
                if exists(&stage.absolute)?
                    || exists(&backup.absolute)?
                    || (exists(&target.absolute)? && !empty_directory(&target.absolute)?)
                {
                    return Err(KernelError::Operation(
                        "materialization target changed before staging".into(),
                    ));
                }
                let original = directory_identity(&target.absolute)?;
                if let Some(parent) = stage.absolute.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::create_dir(&stage.absolute)?;
                let identity = directory_identity(&stage.absolute)?.expect("created stage");
                journal["materializationStage"] = serde_json::to_value(&identity)?;
                journal["materializationOriginal"] = serde_json::to_value(&original)?;
                journal["materializationPhase"] = json!("staging");
                self.write_materialization_journal(operation_id, &journal)?;
                Ok(Controlled::Stage {
                    stage: identity,
                    original,
                })
            }
            Control::Promote {
                stage: identity,
                original,
            } => {
                if journal_directory_identity(&journal, "materializationStage")?.as_ref()
                    != Some(&identity)
                    || journal_directory_identity(&journal, "materializationOriginal")? != original
                    || !has_directory_identity(&stage.absolute, &identity)?
                {
                    return Err(KernelError::Operation(
                        "materialization staging changed before promotion".into(),
                    ));
                }
                if exists(&target.absolute)? {
                    if directory_identity(&target.absolute)? != original
                        || !empty_directory(&target.absolute)?
                        || exists(&backup.absolute)?
                    {
                        return Err(KernelError::Operation(
                            "materialization target changed before promotion".into(),
                        ));
                    }
                } else if let Some(original) = &original {
                    if directory_identity(&backup.absolute)?.as_ref() != Some(original) {
                        return Err(KernelError::Operation(
                            "materialization original directory disappeared".into(),
                        ));
                    }
                } else if exists(&backup.absolute)? {
                    return Err(KernelError::Operation(
                        "materialization backup contains unowned content".into(),
                    ));
                }
                journal["materializationPhase"] = json!("promoting");
                journal["materializationStage"] = serde_json::to_value(&identity)?;
                self.write_materialization_journal(operation_id, &journal)?;
                // Cancellation is checked at the actual external effect boundary.
                check(&self.materializations[operation_id].cancellation)?;
                if exists(&target.absolute)? {
                    durable_directory_rename(&target.absolute, &backup.absolute)?;
                    if let Some(parent) = target.absolute.parent() {
                        sync_directory(parent)?;
                    }
                    if std::env::var_os("VARIN_KERNEL_FAIL_MATERIALIZE_AFTER_BACKUP").is_some() {
                        return Err(KernelError::Storage(
                            "injected materialize failure after backup".into(),
                        ));
                    }
                }
                if let Err(error) = check(&self.materializations[operation_id].cancellation)
                    .and_then(|_| durable_directory_rename(&stage.absolute, &target.absolute))
                {
                    if !exists(&target.absolute)? {
                        if let Some(original) = &original {
                            if has_directory_identity(&backup.absolute, original)?
                                && empty_directory(&backup.absolute)?
                            {
                                let _ =
                                    durable_directory_rename(&backup.absolute, &target.absolute);
                                if let Some(parent) = target.absolute.parent() {
                                    let _ = sync_directory(parent);
                                }
                            }
                        }
                    }
                    return Err(error);
                }
                if let Some(parent) = target.absolute.parent() {
                    sync_directory(parent)?;
                }
                journal["materializationPhase"] = json!("promoted");
                self.write_materialization_journal(operation_id, &journal)?;
                Ok(Controlled::Promoted)
            }
            Control::RestoreBackup { backup: identity } => {
                if journal_directory_identity(&journal, "materializationOriginal")?.as_ref()
                    != Some(&identity)
                    || exists(&target.absolute)?
                    || !has_directory_identity(&backup.absolute, &identity)?
                    || !empty_directory(&backup.absolute)?
                {
                    return Err(KernelError::Operation(
                        "materialization backup changed before restoration".into(),
                    ));
                }
                check(&self.materializations[operation_id].cancellation)?;
                durable_directory_rename(&backup.absolute, &target.absolute)?;
                if let Some(parent) = target.absolute.parent() {
                    sync_directory(parent)?;
                }
                journal["materializationPhase"] = json!("restored");
                self.write_materialization_journal(operation_id, &journal)?;
                Ok(Controlled::Restored)
            }
            Control::Commit { result, .. } => {
                if result["root"] != params.source_root {
                    return Err(KernelError::Storage(
                        "materialization receipt source changed".into(),
                    ));
                }
                self.finish_file_operation(operation_id, &result)?;
                Ok(Controlled::Committed)
            }
        }
    }

    fn write_materialization_journal(
        &self,
        operation_id: &str,
        journal: &Value,
    ) -> Result<(), KernelError> {
        self.conn.execute("UPDATE operations SET result_json=?2,updated_at=?3 WHERE operation_id=?1 AND state='started'",
            params![operation_id, serde_json::to_string(journal)?, now_ms()])?;
        Ok(())
    }

    pub(crate) fn finish_materialization(&mut self, operation_id: &str, job_id: &str) {
        if self
            .materializations
            .get(operation_id)
            .is_none_or(|active| active.job_id != job_id)
        {
            return;
        }
        let active = self
            .materializations
            .remove(operation_id)
            .expect("active materialization");
        self.finish_retained_file_lease(&active.lease_id);
        if let Some(caller) = active.caller_lease {
            self.finish_retained_file_lease(&caller.lease_id);
        }
    }
}
