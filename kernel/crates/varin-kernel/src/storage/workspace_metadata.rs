//! Filesystem metadata in the existing immutable tree store. A private metadata
//! branch retains its root with the ordinary Storage reference graph. Typed
//! values are encoded as a single child key of a directory leaf, so metadata
//! admission never reads/writes separate object files on the control thread.
//! These roots are never used as a project's file namespace or materialized.
use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

const RECORD: &str = "workspace.filesystem";

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Attributes {
    pub file_id: Uuid,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub created: Timestamp,
    pub accessed: Timestamp,
    pub modified: Timestamp,
    pub changed: Timestamp,
    #[serde(default)]
    pub backup: Option<Timestamp>,
    pub windows_attributes: u32,
    pub bsd_flags: u32,
    pub security: Option<Vec<u8>>,
    /// Native xattr names/bytes, losslessly encoded for the platform adapter.
    pub xattrs: BTreeMap<String, Vec<u8>>,
}
impl Attributes {
    pub(crate) fn touch(&mut self) {
        let now = Timestamp::now();
        self.modified = now;
        self.changed = now;
    }
    pub(crate) fn validate(&self) -> Result<(), KernelError> {
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
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Metadata {
    pub binding: Binding,
    pub attributes: Attributes,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Head {
    version: u32,
    pub branch_id: String,
    pub metadata_branch: String,
    namespace: Uuid,
    created: Timestamp,
}

fn record_id(branch: &str) -> String {
    format!("workspace-filesystem:{branch}")
}
fn key(path: &str) -> Result<Vec<String>, KernelError> {
    let mut parts = vec!["namespace".into()];
    if !path.is_empty() {
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
        accessed: time,
        modified: time,
        changed: time,
        backup: None,
        windows_attributes: if state.is_directory() { 0x10 } else { 0x20 },
        bsd_flags: 0,
        security: None,
        xattrs: BTreeMap::new(),
    }
}

impl Storage {
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
            created: Timestamp {
                seconds: data.created_at.div_euclid(1000),
                nanos: (data.created_at.rem_euclid(1000) * 1_000_000) as u32,
            },
        };
        self.filesystem_transaction(|s|{
            s.create_branch(&json!({"operationId":format!("filesystem-metadata:{}",head.namespace),"branchId":head.metadata_branch,"workspaceId":data.workspace_id,"entries":[],"draftBasePaths":[],"captureScopes":[]}),&grant.grant_id)?;
            let root=s.branch(&head.metadata_branch)?.head_root;
            let binding=Binding{file_id:head.namespace,origin:Some(Origin{namespace:head.namespace,prefix:String::new()})};
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
        let parts = if path.is_empty() {
            vec![]
        } else {
            Storage::validate_path(path)?
        };
        let mut origin = Origin {
            namespace: head.namespace,
            prefix: String::new(),
        };
        let mut origin_depth = 0;
        let mut binding = None;
        for depth in 0..=parts.len() {
            let mut slot = key(&parts[..depth].join("/"))?;
            slot.push("info".into());
            if let Some(value) = self.metadata_value::<Binding>(root, &slot)? {
                if let Some(selected) = &value.origin {
                    origin = selected.clone();
                    origin_depth = depth;
                }
                if depth == parts.len() {
                    binding = Some(value);
                }
            }
        }
        let suffix = parts[origin_depth..].join("/");
        let original = if origin.prefix.is_empty() {
            suffix
        } else if suffix.is_empty() {
            origin.prefix.clone()
        } else {
            format!("{}/{suffix}", origin.prefix)
        };
        let binding = binding.unwrap_or_else(|| Binding {
            file_id: identity(origin.namespace, &original),
            origin: state.is_directory().then_some(Origin {
                namespace: origin.namespace,
                prefix: original,
            }),
        });
        let attributes = self
            .metadata_value::<Attributes>(root, &["inodes".into(), binding.file_id.to_string()])?
            .unwrap_or_else(|| defaults(binding.file_id, state, head.created));
        attributes.validate()?;
        if attributes.file_id != binding.file_id {
            return Err(KernelError::Storage(
                "filesystem inode metadata identity differs from namespace".into(),
            ));
        }
        Ok(Metadata {
            binding,
            attributes,
        })
    }
    pub(crate) fn new_workspace_metadata(state: &PathState) -> Metadata {
        let id = Uuid::new_v4();
        Metadata {
            binding: Binding {
                file_id: id,
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
        let root = self.metadata_set(&root, &info, &value.binding)?;
        let root = self.metadata_set(
            &root,
            &["inodes".into(), value.binding.file_id.to_string()],
            &value.attributes,
        )?;
        self.set_metadata_root(&head, &root)
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
        let root = self.graft_tree_node(&root, &key(path)?, None, true, false)?;
        let root = if let Some(binding) = binding {
            self.graft_tree_node(
                &root,
                &["inodes".into(), binding.file_id.to_string()],
                None,
                true,
                false,
            )?
        } else {
            root
        };
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
        let root = self.graft_tree_node(&root, &key(to)?, Some(&selected), true, true)?;
        self.set_metadata_root(&head, &root)
    }
    pub(super) fn fork_workspace_metadata(
        &mut self,
        source: &Head,
        target: &str,
        root: &str,
        grant: &Grant,
        changes: &[(String, Metadata)],
    ) -> Result<(), KernelError> {
        let mut head = source.clone();
        let workspace = self.branch(target)?.workspace_id;
        head.branch_id = target.into();
        head.metadata_branch = format!("workspace-metadata:{}", Uuid::new_v4());
        self.create_branch(&json!({"operationId":format!("filesystem-fork:{}",Uuid::new_v4()),"branchId":head.metadata_branch,"workspaceId":workspace,"baseRef":root,"entries":[],"draftBasePaths":[],"captureScopes":[]}),&grant.grant_id)?;
        self.insert_filesystem_head(&head, &workspace)?;
        for (path, metadata) in changes {
            self.save_workspace_metadata(target, path, metadata, grant)?;
        }
        Ok(())
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
