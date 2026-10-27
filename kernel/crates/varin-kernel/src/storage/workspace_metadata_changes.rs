//! Namespace writes and explicit rebases keep the same filesystem sidecar as
//! their body transaction. Replacing a directory cannot reuse its old inode or
//! lazily resurrect attributes of removed descendants.
use super::*;

impl Storage {
    pub(in crate::storage) fn rebase_filesystem(
        &mut self,
        branch: &str,
        reference: &str,
        data_root: &str,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        let selected = if let Some(pin) = reference.strip_prefix("pin:") {
            self.pinned_filesystem(pin, data_root)?
        } else if let Some((source, revision)) = reference.split_once('@') {
            self.selected_filesystem(
                source,
                revision.parse().map_err(|_| {
                    KernelError::Operation("Invalid filesystem baseline revision".into())
                })?,
                -1,
                data_root,
            )?
        } else {
            None
        }; // A raw body root carries no filesystem identity.
        let data = self.branch(branch)?;
        let existing = self
            .domain_record_value(&data.workspace_id, &record_id(branch))?
            .is_some();
        if !existing {
            if let Some((head, root)) = selected {
                self.fork_workspace_metadata(&head, branch, &root, grant, &[], "")?;
            }
            return Ok(());
        }
        let original = self.workspace_metadata_head(branch, grant)?;
        let (mut head, root) = if let Some((head, root)) = selected {
            (head, root)
        } else {
            let mut head = original.clone();
            head.namespace = Uuid::new_v4();
            head.outside_namespaces.clear();
            let root = self.empty_root()?;
            let binding = Binding {
                file_id: head.namespace,
                attributes_revision: None,
                origin: Some(Origin {
                    namespace: head.namespace,
                    prefix: String::new(),
                }),
            };
            let root = self.metadata_set(&root, &["namespace".into(), "info".into()], &binding)?;
            let root = self.metadata_set(
                &root,
                &["inodes".into(), head.namespace.to_string()],
                &defaults(
                    head.namespace,
                    &PathState::Directory { mode: None },
                    head.created,
                ),
            )?;
            (head, root)
        };
        head.branch_id = branch.into();
        head.metadata_branch = original.metadata_branch;
        self.conn.execute("UPDATE branches SET base_root=?2,head_root=?2,write_revision=write_revision+1 WHERE branch_id=?1", params![head.metadata_branch,root])?;
        self.conn.execute(
            "UPDATE revisions SET root_hash=?2 WHERE branch_id=?1 AND revision=0",
            params![head.metadata_branch, root],
        )?;
        self.conn.execute("UPDATE domain_records SET payload_json=?3,record_revision=record_revision+1,updated_at=?4 WHERE workspace_id=?1 AND record_id=?2",params![data.workspace_id,record_id(branch),serde_json::to_string(&head)?,now_ms()])?;
        Ok(())
    }

    pub(in crate::storage) fn sync_entry_metadata(
        &mut self,
        branch: &str,
        before_root: &str,
        entries: &[Value],
        grant: &Grant,
    ) -> Result<(), KernelError> {
        let data = self.branch(branch)?;
        if self
            .domain_record_value(&data.workspace_id, &record_id(branch))?
            .is_none()
            && !entries
                .iter()
                .any(|entry| entry.get("nativeJson").is_some())
        {
            return Ok(());
        }
        let mut entries = entries.iter().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry["path"].as_str().map_or(0, str::len));
        for entry in entries {
            let path = Self::branch_entry_path(entry)?.join("/");
            let target: PathState = serde_json::from_value(entry["state"].clone())?;
            let before = self.root_get(before_root, &path)?.unwrap_or_else(|| {
                if path.is_empty() {
                    PathState::Directory { mode: None }
                } else {
                    PathState::Missing
                }
            });
            if matches!(target, PathState::Missing | PathState::Unsupported) {
                self.remove_workspace_metadata(branch, &path, grant)?;
                continue;
            }
            let same_kind = std::mem::discriminant(&before) == std::mem::discriminant(&target);
            let mut metadata = if same_kind {
                self.read_workspace_metadata(branch, &path, &before, grant)?
            } else {
                self.remove_workspace_metadata(branch, &path, grant)?;
                Self::new_workspace_metadata(&target)
            };
            if let Some(native) = Self::entry_file_metadata(entry)? {
                metadata.attributes = metadata.attributes.with_file_metadata(&native)?;
            } else if before != target {
                metadata.attributes.touch();
            }
            match &target {
                PathState::RegularFile { mode, .. } => metadata.attributes.mode = *mode,
                PathState::Directory { mode: Some(mode) }
                | PathState::Symlink {
                    mode: Some(mode), ..
                } => metadata.attributes.mode = *mode,
                _ => (),
            }
            self.save_workspace_metadata(branch, &path, &metadata, grant)?;
        }
        Ok(())
    }
}
