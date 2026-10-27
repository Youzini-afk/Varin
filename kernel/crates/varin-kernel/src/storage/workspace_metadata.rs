//! Filesystem metadata in the existing immutable tree store. A private metadata
//! branch retains its root with the ordinary Storage reference graph. Typed
//! values are encoded as a single child key of a directory leaf, so metadata
//! admission never reads/writes separate object files on the control thread.
//! These roots are never used as a project's file namespace or materialized.
use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

const RECORD: &str = "workspace.filesystem";
#[path = "workspace_metadata_import.rs"]
mod imports;
#[path = "workspace_metadata_changes.rs"]
mod changes;
#[path = "workspace_metadata_pins.rs"]
mod pins;
#[path = "workspace_metadata_read.rs"]
mod reader;
pub(super) use reader::{Reader, changed_paths};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Timestamp {
    pub seconds: i64,
    pub nanos: u32,
}
impl Timestamp {
    pub(crate) fn now() -> Self {
        Self::from_time(std::time::SystemTime::now())
    }
    pub(crate) fn from_time(time: std::time::SystemTime) -> Self {
        match time.duration_since(std::time::UNIX_EPOCH) {
            Ok(d) => Self {
                seconds: d.as_secs() as i64,
                nanos: d.subsec_nanos(),
            },
            Err(error) => {
                let d = error.duration();
                if d.subsec_nanos() == 0 {
                    Self {
                        seconds: -(d.as_secs() as i64),
                        nanos: 0,
                    }
                } else {
                    Self {
                        seconds: -(d.as_secs() as i64) - 1,
                        nanos: 1_000_000_000 - d.subsec_nanos(),
                    }
                }
            }
        }
    }
    pub(crate) fn time(self) -> Result<std::time::SystemTime, KernelError> {
        if self.nanos >= 1_000_000_000 {
            return Err(KernelError::Storage("invalid filesystem timestamp".into()));
        }
        let epoch = std::time::UNIX_EPOCH;
        let time = if self.seconds >= 0 {
            epoch.checked_add(std::time::Duration::new(self.seconds as u64, self.nanos))
        } else {
            epoch
                .checked_sub(std::time::Duration::from_secs(self.seconds.unsigned_abs()))
                .and_then(|t| t.checked_add(std::time::Duration::from_nanos(self.nanos as u64)))
        };
        time.ok_or_else(|| {
            KernelError::Operation("filesystem timestamp is outside the native clock range".into())
        })
    }
    pub(crate) fn filetime(self) -> Result<u64, KernelError> {
        let ticks = (self.seconds as i128 + 11_644_473_600) * 10_000_000 + self.nanos as i128 / 100;
        u64::try_from(ticks).map_err(|_| {
            KernelError::Operation("timestamp is outside Windows FILETIME range".into())
        })
    }
    pub(crate) fn from_filetime(ticks: u64) -> Self {
        Self {
            seconds: (ticks / 10_000_000) as i64 - 11_644_473_600,
            nanos: ((ticks % 10_000_000) * 100) as u32,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attributes {
    pub file_id: Uuid,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub created: Timestamp,
    /// The logical birth time remains available to mounted programs. Only a
    /// captured/settable birth time is an exact restore requirement on export.
    pub creation_exported: bool,
    pub accessed: Timestamp,
    pub modified: Timestamp,
    pub changed: Timestamp,
    #[serde(default)]
    pub backup: Option<Timestamp>,
    pub windows_attributes: u32,
    pub bsd_flags: u32,
    pub security: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reparse_data: Option<Vec<u8>>,
    /// Native xattr names/bytes, losslessly encoded for the platform adapter.
    pub xattrs: BTreeMap<String, Vec<u8>>,
}
impl Attributes {
    pub(crate) fn file_metadata(&self) -> varin_runtime::catalog::followups::FileMetadata {
        use varin_runtime::catalog::followups::{FileMetadata, FileTimestamp};
        let time = |v: Timestamp| FileTimestamp {
            seconds: v.seconds,
            nanos: v.nanos,
        };
        FileMetadata {
            uid: self.uid,
            gid: self.gid,
            created: self.creation_exported.then(|| time(self.created)),
            modified: time(self.modified),
            backup: self.backup.map(time),
            windows_attributes: self.windows_attributes,
            bsd_flags: self.bsd_flags,
            security: self.security.clone(),
            reparse_data: self.reparse_data.clone(),
            xattrs: self.xattrs.clone(),
        }
    }
    pub(crate) fn with_file_metadata(
        mut self,
        value: &varin_runtime::catalog::followups::FileMetadata,
    ) -> Result<Self, KernelError> {
        let time = |v: varin_runtime::catalog::followups::FileTimestamp| Timestamp {
            seconds: v.seconds,
            nanos: v.nanos,
        };
        self.uid = value.uid;
        self.gid = value.gid;
        if let Some(created) = value.created {
            self.created = time(created);
        }
        self.creation_exported = value.created.is_some();
        self.modified = time(value.modified);
        self.backup = value.backup.map(time);
        self.changed = Timestamp::now();
        self.windows_attributes = value.windows_attributes;
        self.bsd_flags = value.bsd_flags;
        self.security = value.security.clone();
        self.reparse_data = value.reparse_data.clone();
        self.xattrs = value.xattrs.clone();
        self.validate()?;
        Ok(self)
    }
    pub(crate) fn touch(&mut self) {
        let now = Timestamp::now();
        self.modified = now;
        self.changed = now;
    }
    pub(crate) fn validate(&self) -> Result<(), KernelError> {
        if let Some(security) = &self.security {
            crate::native_security::validate(security)?;
        }
        if let Some(data) = &self.reparse_data {
            crate::reparse_data::parse(data)?;
        }
        for stamp in [self.created, self.accessed, self.modified, self.changed]
            .into_iter()
            .chain(self.backup)
        {
            stamp.time()?;
        }
        if self.mode & !0o7777 != 0 {
            return Err(KernelError::Operation(
                "invalid filesystem permission bits".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Origin {
    namespace: Uuid,
    prefix: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    pub file_id: Uuid,
    origin: Option<Origin>,
    /// Changes the path leaf when its shared inode attributes change, allowing
    /// result workers to skip unchanged namespace subtrees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attributes_revision: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Metadata {
    pub binding: Binding,
    pub attributes: Attributes,
}
impl Metadata {
    pub(super) fn directory_origin(&mut self) {
        if self.binding.origin.is_none() {
            self.binding.origin = Some(Origin {
                namespace: self.binding.file_id,
                prefix: String::new(),
            });
        }
    }
}

/// A hard-link name belongs to a stable directory identity, not an absolute
/// path. Moving a directory therefore changes one parent pointer even when it
/// contains many links; no descendant enumeration is needed.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinkName {
    directory: Uuid,
    name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryName {
    parent: Uuid,
    name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkSet {
    entries: BTreeSet<LinkName>,
}

fn split_link_path(path: &str) -> Result<(String, String), KernelError> {
    let parts = Storage::validate_path(path)?;
    let name = parts
        .last()
        .ok_or_else(|| KernelError::Operation("workspace root is not a file link".into()))?
        .clone();
    Ok((parts[..parts.len() - 1].join("/"), name))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Head {
    version: u32,
    pub branch_id: String,
    pub metadata_branch: String,
    namespace: Uuid,
    /// A scoped fork retains the shared inode/link graph. These former roots
    /// terminate names outside this branch, without enumerating the subtree.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    outside_namespaces: BTreeSet<Uuid>,
    created: Timestamp,
}

fn record_id(branch: &str) -> String {
    format!("workspace-filesystem:{branch}")
}
fn key(path: &str) -> Result<Vec<String>, KernelError> {
    let mut parts = vec!["namespace".into()];
    if !path.is_empty() && path != "." {
        for component in Storage::validate_path(path)? {
            parts.push("children".into());
            parts.push(component);
        }
    }
    Ok(parts)
}
fn mode(state: &PathState) -> u32 {
    match state {
        PathState::RegularFile { mode, .. } => *mode,
        PathState::Directory { mode } => mode.unwrap_or(0o755),
        PathState::Symlink { mode, .. } => mode.unwrap_or(0o777),
        _ => 0,
    }
}
fn identity(namespace: Uuid, path: &str) -> Uuid {
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update([0]);
    hash.update(path.as_bytes());
    let digest = hash.finalize();
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    Uuid::from_bytes(bytes)
}
fn defaults(id: Uuid, state: &PathState, time: Timestamp) -> Attributes {
    #[cfg(unix)]
    let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
    #[cfg(not(unix))]
    let (uid, gid) = (0, 0);
    Attributes {
        file_id: id,
        mode: mode(state) & 0o7777,
        uid,
        gid,
        created: time,
        creation_exported: cfg!(any(windows,target_os="macos")),
        accessed: time,
        modified: time,
        changed: time,
        backup: None,
        windows_attributes: if state.is_directory() { 0x10 } else { 0x20 },
        bsd_flags: 0,
        security: None,
        reparse_data: None,
        xattrs: BTreeMap::new(),
    }
}

pub(crate) fn validate_file_metadata(
    value: &varin_runtime::catalog::followups::FileMetadata,
) -> Result<(), KernelError> {
    let attributes = defaults(
        Uuid::nil(),
        &PathState::Directory { mode: None },
        Timestamp::now(),
    )
    .with_file_metadata(value)?;
    for name in attributes.xattrs.keys() {
        let bytes = URL_SAFE_NO_PAD
            .decode(name)
            .map_err(|_| KernelError::Operation("Invalid native xattr name encoding".into()))?;
        if bytes.is_empty() || bytes.contains(&0) {
            return Err(KernelError::Operation("Invalid native xattr name".into()));
        }
    }
    Ok(())
}

impl Storage {
    fn selected_filesystem(
        &self,
        branch: &str,
        revision: i64,
        write_revision: i64,
        data_root: &str,
    ) -> Result<Option<(Head, String)>, KernelError> {
        let data = self.branch(branch)?;
        let Some(record) = self.domain_record_value(&data.workspace_id, &record_id(branch))? else {
            return Ok(None);
        };
        let mut head: Head = serde_json::from_str(
            record["payloadJson"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("Filesystem metadata is missing".into()))?,
        )?;
        let metadata = self.branch(&head.metadata_branch)?;
        let root = if write_revision >= 0
            && data_root == data.head_root
            && data.write_revision == write_revision
        {
            metadata.head_root
        } else if revision == 0 && data_root == data.base_root {
            metadata.base_root
        } else {
            let id = format!("workspace-revision-filesystem:{branch}@{revision}");
            let value = self
                .domain_record_value(&data.workspace_id, &id)?
                .ok_or_else(|| {
                    KernelError::Operation(
                        "Selected native file version has no retained attributes".into(),
                    )
                })?;
            let selected: super::workspace_results::FilesystemRevision =
                serde_json::from_str(value["payloadJson"].as_str().ok_or_else(|| {
                    KernelError::Storage("Native revision attributes are missing".into())
                })?)?;
            head = selected.head;
            selected.root
        };
        Ok(Some((head, root)))
    }
    pub(super) fn project_native_entries(
        &self,
        branch: &str,
        revision: i64,
        write_revision: i64,
        data_root: &str,
        pin: Option<&str>,
        entries: &mut [Value],
    ) -> Result<(), KernelError> {
        if entries.is_empty() {
            return Ok(());
        }
        let selected = if let Some(pin) = pin {
            self.pinned_filesystem(pin, data_root)?
        } else {
            self.selected_filesystem(branch, revision, write_revision, data_root)?
        };
        let Some((head, root)) = selected else {
            return Ok(());
        };
        for entry in entries {
            let path = entry["path"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("Native entry path is missing".into()))?;
            let state: PathState = serde_json::from_value(entry["state"].clone())?;
            if !matches!(state, PathState::Missing | PathState::Unsupported) {
                let attributes = self.read_workspace_metadata_root(&head, &root, path, &state)?.attributes;
                entry["state"]["mode"] = json!(attributes.mode);
                entry["nativeJson"] = json!(serde_json::to_string(&attributes.file_metadata())?);
            }
        }
        Ok(())
    }
    /// Join the caller's admitted transaction, or create one for an internal
    /// metadata operation that has no public operation receipt of its own.
    pub(super) fn filesystem_transaction<T>(
        &mut self,
        action: impl FnOnce(&mut Self) -> Result<T, KernelError>,
    ) -> Result<T, KernelError> {
        if !self.conn.is_autocommit() {
            return action(self);
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match action(self) {
            Ok(result) => {
                if let Err(error) = self.conn.execute_batch("COMMIT") {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(result)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
    fn metadata_value<T: serde::de::DeserializeOwned>(
        &self,
        root: &str,
        path: &[String],
    ) -> Result<Option<T>, KernelError> {
        let Some(node) = self.find_path_node(root, path)? else {
            return Ok(None);
        };
        let TrieNode::Path {
            state: Some(PathState::Directory { .. }),
            children: Some(index),
        } = self.load_node(&node)?
        else {
            return Err(KernelError::Storage(
                "invalid filesystem metadata leaf".into(),
            ));
        };
        let TrieNode::Index {
            key,
            left: None,
            right: None,
            ..
        } = self.load_node(&index)?
        else {
            return Err(KernelError::Storage(
                "filesystem metadata leaf has ambiguous payload".into(),
            ));
        };
        let bytes = URL_SAFE_NO_PAD
            .decode(key.strip_prefix("v1-").ok_or_else(|| {
                KernelError::Storage("unsupported filesystem metadata encoding".into())
            })?)
            .map_err(|_| KernelError::Storage("invalid filesystem metadata payload".into()))?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
    fn metadata_set<T: Serialize>(
        &mut self,
        root: &str,
        path: &[String],
        value: &T,
    ) -> Result<String, KernelError> {
        let bytes = serde_json::to_vec(value)?;
        let child = self.empty_root()?;
        let index = self.make_index(
            format!("v1-{}", URL_SAFE_NO_PAD.encode(bytes)),
            child,
            None,
            None,
        )?;
        let leaf = self.store_node(&TrieNode::Path {
            state: Some(PathState::Directory { mode: None }),
            children: Some(index),
        })?;
        self.graft_tree_node(root, path, Some(&leaf), true, true)
    }

    /// Materialize identities only along the parent chain of an actual link.
    /// Unrelated directories and their entries remain untouched.
    fn ensure_link_directory(
        &mut self,
        head: &Head,
        mut root: String,
        branch: &str,
        directory: &str,
    ) -> Result<(String, Uuid), KernelError> {
        let mut parent = head.namespace;
        let mut path = String::new();
        if directory.is_empty() {
            return Ok((root, parent));
        }
        for name in Self::validate_path(directory)? {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(&name);
            let observed = self.branch_path_inspect(&json!({"branchId":branch,"path":path}))?;
            let state: PathState = serde_json::from_value(observed["state"].clone())?;
            if !state.is_directory() {
                return Err(KernelError::Storage(
                    "hard-link parent is no longer a directory".into(),
                ));
            }
            let selected = self.read_workspace_metadata_root(head, &root, &path, &state)?;
            let entry = DirectoryName { parent, name };
            let entry_path = ["directories".into(), selected.binding.file_id.to_string()];
            if let Some(existing) = self.metadata_value::<DirectoryName>(&root, &entry_path)? {
                if existing != entry {
                    return Err(KernelError::Storage(
                        "hard-link directory identity differs from its parent".into(),
                    ));
                }
            } else {
                let mut info = key(&path)?;
                info.push("info".into());
                root = self.metadata_set(&root, &info, &selected.binding)?;
                root = self.metadata_set(&root, &entry_path, &entry)?;
            }
            parent = selected.binding.file_id;
        }
        Ok((root, parent))
    }
    fn existing_link_parent(
        &self,
        head: &Head,
        root: &str,
        directory: &str,
    ) -> Result<Uuid, KernelError> {
        let directory = self.read_workspace_metadata_root(
            head,
            root,
            directory,
            &PathState::Directory { mode: None },
        )?;
        Ok(directory.binding.file_id)
    }
    fn resolve_link_directory(
        &self,
        head: &Head,
        root: &str,
        mut id: Uuid,
    ) -> Result<Option<String>, KernelError> {
        let mut parts = Vec::new();
        let mut seen = BTreeSet::new();
        while id != head.namespace {
            if head.outside_namespaces.contains(&id) {
                return Ok(None);
            }
            if !seen.insert(id) {
                return Err(KernelError::Storage(
                    "hard-link parent identities contain a cycle".into(),
                ));
            }
            let entry = self
                .metadata_value::<DirectoryName>(root, &["directories".into(), id.to_string()])?
                .ok_or_else(|| {
                    KernelError::Storage("hard-link parent identity is missing".into())
                })?;
            let checked = Self::validate_path(&entry.name)?;
            if checked.len() != 1 || checked[0] != entry.name {
                return Err(KernelError::Storage(
                    "hard-link parent name is invalid".into(),
                ));
            }
            parts.push(entry.name);
            id = entry.parent;
        }
        parts.reverse();
        Ok(Some(parts.join("/")))
    }
    /// Return all actual names of one inode. The fallback is used only for a
    /// regular file that has never been hard-linked.
    pub(super) fn workspace_file_links(
        &mut self,
        branch: &str,
        id: Uuid,
        fallback: Option<&str>,
        grant: &Grant,
    ) -> Result<Vec<String>, KernelError> {
        let head = self.workspace_metadata_head(branch, grant)?;
        let root = self.branch(&head.metadata_branch)?.head_root;
        let Some(group) =
            self.metadata_value::<LinkSet>(&root, &["links".into(), id.to_string()])?
        else {
            return Ok(fallback.into_iter().map(str::to_owned).collect());
        };
        let mut paths = Vec::with_capacity(group.entries.len());
        for entry in group.entries {
            let Some(dir) = self.resolve_link_directory(&head, &root, entry.directory)? else {
                continue;
            };
            let path = if dir.is_empty() {
                entry.name
            } else {
                format!("{dir}/{}", entry.name)
            };
            let checked = Self::validate_path(&path)?.join("/");
            if checked != path {
                return Err(KernelError::Storage("hard-link name is invalid".into()));
            }
            let actual = self.branch_path_inspect(&json!({"branchId":branch,"path":path}))?;
            let state: PathState = serde_json::from_value(actual["state"].clone())?;
            if !matches!(state, PathState::RegularFile { .. })
                || self
                    .read_workspace_metadata_root(&head, &root, &path, &state)?
                    .binding
                    .file_id
                    != id
            {
                return Err(KernelError::Storage(
                    "hard-link namespace does not match its inode".into(),
                ));
            }
            paths.push(path);
        }
        paths.sort();
        Ok(paths)
    }
    pub(super) fn workspace_file_link_count(
        &mut self,
        branch: &str,
        id: Uuid,
        grant: &Grant,
    ) -> Result<usize, KernelError> {
        let head = self.workspace_metadata_head(branch, grant)?;
        let root = self.branch(&head.metadata_branch)?.head_root;
        match self.metadata_value::<LinkSet>(&root, &["links".into(), id.to_string()])? {
            Some(group) if group.entries.is_empty() => Err(KernelError::Storage(
                "empty hard-link group is invalid".into(),
            )),
            Some(group) => {
                let mut count = 0;
                for entry in group.entries {
                    if self
                        .resolve_link_directory(&head, &root, entry.directory)?
                        .is_some()
                    {
                        count += 1;
                    }
                }
                Ok(count)
            }
            None => Ok(1),
        }
    }
    pub(super) fn link_workspace_metadata(
        &mut self,
        branch: &str,
        from: &str,
        to: &str,
        metadata: &Metadata,
        grant: &Grant,
    ) -> Result<usize, KernelError> {
        let head = self.workspace_metadata_head(branch, grant)?;
        let root = self.branch(&head.metadata_branch)?.head_root;
        let (from_dir, from_name) = split_link_path(from)?;
        let (to_dir, to_name) = split_link_path(to)?;
        let (root, from_id) = self.ensure_link_directory(&head, root, branch, &from_dir)?;
        let (root, to_id) = self.ensure_link_directory(&head, root, branch, &to_dir)?;
        let from_link = LinkName {
            directory: from_id,
            name: from_name,
        };
        let to_link = LinkName {
            directory: to_id,
            name: to_name,
        };
        let group_path = ["links".into(), metadata.binding.file_id.to_string()];
        let mut group = self
            .metadata_value::<LinkSet>(&root, &group_path)?
            .unwrap_or_else(|| LinkSet {
                entries: BTreeSet::from([from_link.clone()]),
            });
        if !group.entries.contains(&from_link) || !group.entries.insert(to_link) {
            return Err(KernelError::Storage(
                "hard-link identity changed during creation".into(),
            ));
        }
        let mut from_info = key(from)?;
        from_info.push("info".into());
        let mut to_info = key(to)?;
        to_info.push("info".into());
        let root = self.metadata_set(&root, &from_info, &metadata.binding)?;
        let root = self.metadata_set(&root, &to_info, &metadata.binding)?;
        let root = self.metadata_set(
            &root,
            &["inodes".into(), metadata.binding.file_id.to_string()],
            &metadata.attributes,
        )?;
        let root = self.metadata_set(&root, &group_path, &group)?;
        self.set_metadata_root(&head, &root)?;
        self.workspace_file_link_count(branch, metadata.binding.file_id, grant)
    }
    pub(super) fn workspace_metadata_head(
        &mut self,
        branch: &str,
        grant: &Grant,
    ) -> Result<Head, KernelError> {
        let data = self.branch(branch)?;
        if grant.owning_workspace.as_deref() != Some(&data.workspace_id) {
            return Err(KernelError::Authorization(
                "filesystem metadata belongs to another workspace".into(),
            ));
        }
        if let Some(value) = self.domain_record_value(&data.workspace_id, &record_id(branch))? {
            if value["recordType"] != RECORD
                || value["state"] != "active"
                || value["branchId"] != branch
            {
                return Err(KernelError::Storage(
                    "filesystem metadata record identity is invalid".into(),
                ));
            }
            let head: Head =
                serde_json::from_str(value["payloadJson"].as_str().ok_or_else(|| {
                    KernelError::Storage("filesystem metadata record has no payload".into())
                })?)?;
            if head.version != 1
                || head.branch_id != branch
                || !head.metadata_branch.starts_with("workspace-metadata:")
                || head.metadata_branch == branch
                || self.branch(&head.metadata_branch)?.workspace_id != data.workspace_id
            {
                return Err(KernelError::Storage(
                    "filesystem metadata head identity is invalid".into(),
                ));
            }
            return Ok(head);
        }
        let head = Head {
            version: 1,
            branch_id: branch.into(),
            metadata_branch: format!("workspace-metadata:{}", Uuid::new_v4()),
            namespace: Uuid::new_v4(),
            outside_namespaces: BTreeSet::new(),
            created: Timestamp {
                seconds: data.created_at.div_euclid(1000),
                nanos: (data.created_at.rem_euclid(1000) * 1_000_000) as u32,
            },
        };
        self.filesystem_transaction(|s|{
            s.create_branch(&json!({"operationId":format!("filesystem-metadata:{}",head.namespace),"branchId":head.metadata_branch,"workspaceId":data.workspace_id,"entries":[],"draftBasePaths":[],"captureScopes":[]}),&grant.grant_id)?;
            let root=s.branch(&head.metadata_branch)?.head_root;
            let binding=Binding{file_id:head.namespace,attributes_revision:None,origin:Some(Origin{namespace:head.namespace,prefix:String::new()})};
            let root=s.metadata_set(&root,&["namespace".into(),"info".into()],&binding)?;
            let attributes=defaults(binding.file_id,&PathState::Directory{mode:None},head.created);
            let root=s.metadata_set(&root,&["inodes".into(),binding.file_id.to_string()],&attributes)?;
            s.set_metadata_root(&head,&root)?;
            s.insert_filesystem_head(&head,&data.workspace_id)?;
            Ok(())
        })?;
        Ok(head)
    }
    fn insert_filesystem_head(&mut self, head: &Head, workspace: &str) -> Result<(), KernelError> {
        self.conn.execute("INSERT INTO domain_records(record_id,workspace_id,record_type,state,branch_id,record_revision,payload_json,created_at,updated_at) VALUES(?1,?2,?3,'active',?4,1,?5,?6,?6)",params![record_id(&head.branch_id),workspace,RECORD,head.branch_id,serde_json::to_string(head)?,now_ms()])?;
        Ok(())
    }
    fn set_metadata_root(&mut self, head: &Head, root: &str) -> Result<(), KernelError> {
        self.conn.execute("UPDATE branches SET head_root=?2,write_revision=write_revision+1,updated_at=?3 WHERE branch_id=?1",params![head.metadata_branch,root,now_ms()])?;
        Ok(())
    }
    pub(super) fn read_workspace_metadata(
        &mut self,
        branch: &str,
        path: &str,
        state: &PathState,
        grant: &Grant,
    ) -> Result<Metadata, KernelError> {
        let head = self.workspace_metadata_head(branch, grant)?;
        let root = self.branch(&head.metadata_branch)?.head_root;
        self.read_workspace_metadata_root(&head, &root, path, state)
    }
    fn read_workspace_metadata_root(
        &self,
        head: &Head,
        root: &str,
        path: &str,
        state: &PathState,
    ) -> Result<Metadata, KernelError> {
        reader::read_at(head, path, state, |slot| {
            self.metadata_value::<Value>(root, slot)
        })
    }
    pub(crate) fn new_workspace_metadata(state: &PathState) -> Metadata {
        let id = Uuid::new_v4();
        Metadata {
            binding: Binding {
                file_id: id,
                attributes_revision: None,
                origin: state.is_directory().then_some(Origin {
                    namespace: id,
                    prefix: String::new(),
                }),
            },
            attributes: defaults(id, state, Timestamp::now()),
        }
    }
    pub(super) fn save_workspace_metadata(
        &mut self,
        branch: &str,
        path: &str,
        value: &Metadata,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        value.attributes.validate()?;
        if value.binding.file_id != value.attributes.file_id {
            return Err(KernelError::Storage(
                "filesystem inode metadata has another binding".into(),
            ));
        }
        let head = self.workspace_metadata_head(branch, grant)?;
        let root = self.branch(&head.metadata_branch)?.head_root;
        let mut info = key(path)?;
        info.push("info".into());
        let mut binding = value.binding.clone();
        binding.attributes_revision = Some(hash_json(&json!([value.attributes.mode, value.attributes.file_metadata()]))?);
        let root = self.metadata_set(&root, &info, &binding)?;
        let root = self.metadata_set(
            &root,
            &["inodes".into(), value.binding.file_id.to_string()],
            &value.attributes,
        )?;
        self.set_metadata_root(&head, &root)
    }
    pub(super) fn workspace_metadata_snapshot(
        &mut self,
        root: &str,
        changes: &[(String, Metadata)],
    ) -> Result<String, KernelError> {
        let mut root = root.to_owned();
        for (path, metadata) in changes {
            metadata.attributes.validate()?;
            if metadata.attributes.file_id != metadata.binding.file_id {
                return Err(KernelError::Storage(
                    "Snapshot inode has a different metadata binding".into(),
                ));
            }
            let mut info = key(path)?;
            info.push("info".into());
            let mut binding = metadata.binding.clone();
            binding.attributes_revision = Some(hash_json(&json!([metadata.attributes.mode, metadata.attributes.file_metadata()]))?);
            root = self.metadata_set(&root, &info, &binding)?;
            root = self.metadata_set(
                &root,
                &["inodes".into(), metadata.binding.file_id.to_string()],
                &metadata.attributes,
            )?;
        }
        Ok(root)
    }
    pub(super) fn remove_workspace_metadata(
        &mut self,
        branch: &str,
        path: &str,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        let head = self.workspace_metadata_head(branch, grant)?;
        let root = self.branch(&head.metadata_branch)?.head_root;
        let mut info = key(path)?;
        info.push("info".into());
        let binding = self.metadata_value::<Binding>(&root, &info)?;
        let link = if let Some(binding) = &binding {
            let group_path = ["links".into(), binding.file_id.to_string()];
            if let Some(mut group) = self.metadata_value::<LinkSet>(&root, &group_path)? {
                let (directory, name) = split_link_path(path)?;
                let directory = self.existing_link_parent(&head, &root, &directory)?;
                if !group.entries.remove(&LinkName { directory, name }) {
                    return Err(KernelError::Storage(
                        "removed hard-link is not in its inode".into(),
                    ));
                }
                Some((group_path, group))
            } else {
                None
            }
        } else {
            None
        };
        let mut root = self.graft_tree_node(&root, &key(path)?, None, true, false)?;
        if let Some(binding) = binding {
            if binding.origin.is_some() {
                root = self.graft_tree_node(
                    &root,
                    &["directories".into(), binding.file_id.to_string()],
                    None,
                    true,
                    false,
                )?;
            }
            match link {
                Some((group_path, group)) if !group.entries.is_empty() => {
                    root = self.metadata_set(&root, &group_path, &group)?
                }
                Some((group_path, _)) => {
                    root = self.graft_tree_node(&root, &group_path, None, true, false)?;
                    root = self.graft_tree_node(
                        &root,
                        &["inodes".into(), binding.file_id.to_string()],
                        None,
                        true,
                        false,
                    )?;
                }
                None => {
                    root = self.graft_tree_node(
                        &root,
                        &["inodes".into(), binding.file_id.to_string()],
                        None,
                        true,
                        false,
                    )?
                }
            }
        }
        self.set_metadata_root(&head, &root)
    }
    pub(super) fn rename_workspace_metadata(
        &mut self,
        branch: &str,
        from: &str,
        to: &str,
        source: &PathState,
        target: &PathState,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        let metadata = self.read_workspace_metadata(branch, from, source, grant)?;
        self.save_workspace_metadata(branch, from, &metadata, grant)?;
        if !matches!(target, PathState::Missing) {
            self.remove_workspace_metadata(branch, to, grant)?;
        }
        let head = self.workspace_metadata_head(branch, grant)?;
        let root = self.branch(&head.metadata_branch)?.head_root;
        let selected = self
            .find_path_node(&root, &key(from)?)?
            .ok_or_else(|| KernelError::Storage("filesystem rename metadata missing".into()))?;
        let root = self.graft_tree_node(&root, &key(from)?, None, true, false)?;
        let mut root = self.graft_tree_node(&root, &key(to)?, Some(&selected), true, true)?;
        let directory_path = ["directories".into(), metadata.binding.file_id.to_string()];
        let group_path = ["links".into(), metadata.binding.file_id.to_string()];
        let is_tracked_directory = self
            .metadata_value::<DirectoryName>(&root, &directory_path)?
            .is_some();
        let group = self.metadata_value::<LinkSet>(&root, &group_path)?;
        if is_tracked_directory || group.is_some() {
            let (from_dir, from_name) = split_link_path(from)?;
            let (to_dir, to_name) = split_link_path(to)?;
            let (next, from_id) = self.ensure_link_directory(&head, root, branch, &from_dir)?;
            let (next, to_id) = self.ensure_link_directory(&head, next, branch, &to_dir)?;
            root = next;
            if is_tracked_directory {
                root = self.metadata_set(
                    &root,
                    &directory_path,
                    &DirectoryName {
                        parent: to_id,
                        name: to_name.clone(),
                    },
                )?;
            }
            if let Some(mut group) = group {
                if !group.entries.remove(&LinkName {
                    directory: from_id,
                    name: from_name,
                }) || !group.entries.insert(LinkName {
                    directory: to_id,
                    name: to_name,
                }) {
                    return Err(KernelError::Storage(
                        "renamed hard-link identity changed".into(),
                    ));
                }
                root = self.metadata_set(&root, &group_path, &group)?;
            }
        }
        self.set_metadata_root(&head, &root)
    }
    /// Immutable child preparation shares the file attributes as well as the
    /// body tree. A published baseline never borrows later head attributes.
    pub(super) fn fork_source_filesystem(
        &mut self,
        source: &str,
        target: &str,
        pin: Option<&str>,
        data_root: &str,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        if let Some(pin) = pin {
            if let Some((head, root)) = self.pinned_filesystem(pin, data_root)? {
                return self.fork_workspace_metadata(&head, target, &root, grant, &[], "");
            }
        }
        // Body-only immutable sources can outlive their branch through a pin.
        // Such a pin never claimed a filesystem sidecar; don't look up the
        // deleted branch merely to synthesize one.
        if pin.is_some() && self.conn.query_row("SELECT NOT EXISTS(SELECT 1 FROM branches WHERE branch_id=?1)",[source],|row|row.get::<_,bool>(0))? {return Ok(());}
        let data = self.branch(source)?;
        let Some(record) = self.domain_record_value(&data.workspace_id, &record_id(source))? else {
            return Ok(());
        };
        let mut head: Head =
            serde_json::from_str(record["payloadJson"].as_str().ok_or_else(|| {
                KernelError::Storage("Filesystem source metadata is missing".into())
            })?)?;
        let (revision, write_revision) = if let Some(pin) = pin {
            self.conn.query_row("SELECT revision,write_revision FROM pins WHERE pin_id=?1 AND branch_id=?2 AND root_hash=?3",params![pin,source,data_root],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?)))?
        } else {
            (data.head_revision, data.write_revision)
        };
        let metadata = self.branch(&head.metadata_branch)?;
        let root = if write_revision >= 0 && data_root == data.head_root {
            metadata.head_root
        } else if revision == 0 && data_root == data.base_root {
            metadata.base_root
        } else {
            let id = format!("workspace-revision-filesystem:{source}@{revision}");
            let value = self
                .domain_record_value(&data.workspace_id, &id)?
                .ok_or_else(|| {
                    KernelError::Operation(
                        "Selected native revision has no retained filesystem attributes".into(),
                    )
                })?;
            let filesystem: super::workspace_results::FilesystemRevision =
                serde_json::from_str(value["payloadJson"].as_str().ok_or_else(|| {
                    KernelError::Storage("Native revision attributes are missing".into())
                })?)?;
            head = filesystem.head;
            filesystem.root
        };
        self.fork_workspace_metadata(&head, target, &root, grant, &[], "")
    }
    pub(super) fn fork_workspace_metadata(
        &mut self,
        source: &Head,
        target: &str,
        root: &str,
        grant: &Grant,
        changes: &[(String, Metadata)],
        selected: &str,
    ) -> Result<(), KernelError> {
        let (mut head, root) = self.scope_workspace_metadata(source, root, changes, selected)?;
        let workspace = self.branch(target)?.workspace_id;
        head.branch_id = target.into();
        head.metadata_branch = format!("workspace-metadata:{}", Uuid::new_v4());
        self.create_filesystem_snapshot_branch(
            source.metadata_branch.as_str(),
            &head.metadata_branch,
            &workspace,
            &root,
            &format!("filesystem-fork:{}", Uuid::new_v4()),
            grant,
        )?;
        self.insert_filesystem_head(&head, &workspace)
    }
    fn scope_workspace_metadata(
        &mut self,
        source: &Head,
        root: &str,
        changes: &[(String, Metadata)],
        selected: &str,
    ) -> Result<(Head, String), KernelError> {
        let mut head = source.clone();
        let mut root = self.workspace_metadata_snapshot(root, changes)?;
        if !selected.is_empty() {
            let directory = self.read_workspace_metadata_root(
                source,
                &root,
                selected,
                &PathState::Directory { mode: None },
            )?;
            let subtree = self.find_path_node(&root, &key(selected)?)?;
            // An implicit directory still has a stable Origin. Save its info
            // at the new root so unopened descendants retain their identities.
            root =
                self.graft_tree_node(&root, &["namespace".into()], subtree.as_deref(), true, true)?;
            root = self.metadata_set(
                &root,
                &["namespace".into(), "info".into()],
                &directory.binding,
            )?;
            root = self.metadata_set(
                &root,
                &["inodes".into(), directory.binding.file_id.to_string()],
                &directory.attributes,
            )?;
            head.outside_namespaces.insert(head.namespace);
            head.namespace = directory.binding.file_id;
        }
        Ok((head, root))
    }
    /// The caller already validated an owned snapshot and runs in its original
    /// transaction. A temporary pin admits the derived root through the normal
    /// branch owner; no physical materialization or parallel writer is involved.
    pub(super) fn create_filesystem_snapshot_branch(
        &mut self,
        source: &str,
        target: &str,
        workspace: &str,
        root: &str,
        operation: &str,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let pin = format!("workspace-fork-build:{}", Uuid::new_v4());
        self.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,-1,?4,?5,?6,1,?7)",
            params![pin,source,workspace,crate::model::SNAPSHOT_PIN_WRITE_REVISION,root,grant.grant_id,now_ms()])?;
        let result = self.create_branch(
            &json!({"operationId":operation,"branchId":target,"workspaceId":workspace,
            "baseRef":root,"entries":[],"draftBasePaths":[],"captureScopes":[]}),
            &grant.grant_id,
        );
        self.conn
            .execute("DELETE FROM pins WHERE pin_id=?1", params![pin])?;
        result
    }
    pub(super) fn release_workspace_metadata(
        &mut self,
        branch: &str,
        workspace: &str,
    ) -> Result<(), KernelError> {
        if let Some(record) = self.domain_record_value(workspace, &record_id(branch))? {
            if record["recordType"] != RECORD
                || record["state"] != "active"
                || record["branchId"] != branch
            {
                return Err(KernelError::Storage(
                    "filesystem metadata release record identity is invalid".into(),
                ));
            }
            let head: Head =
                serde_json::from_str(record["payloadJson"].as_str().ok_or_else(|| {
                    KernelError::Storage("filesystem metadata record has no payload".into())
                })?)?;
            if head.version != 1
                || head.branch_id != branch
                || !head.metadata_branch.starts_with("workspace-metadata:")
                || head.metadata_branch == branch
                || self.branch(&head.metadata_branch)?.workspace_id != workspace
            {
                return Err(KernelError::Storage(
                    "filesystem metadata release identity is invalid".into(),
                ));
            }
            self.conn.execute(
                "DELETE FROM domain_records WHERE workspace_id=?1 AND record_id=?2",
                params![workspace, record_id(branch)],
            )?;
            self.branch_delete(&json!({"branchId":head.metadata_branch}))?;
        }
        Ok(())
    }
}
