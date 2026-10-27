//! Cross-Host states carry selected recoverable attributes, never the sender's
//! inode graph. Import assigns local identities in the existing transaction.
use super::*;
use varin_runtime::catalog::followups::FileMetadata;
impl Storage {
    pub(in crate::storage) fn retain_filesystem_revision(
        &mut self,
        branch: &str,
        revision: i64,
        filesystem: &super::super::workspace_results::FilesystemRevision,
        grant: &str,
    ) -> Result<(), KernelError> {
        let workspace = self.branch(branch)?.workspace_id;
        let mut selected = filesystem.clone();
        selected.session_id = None;
        selected.pin_id = format!("native-revision:{branch}@{revision}");
        selected.base_pin_id = format!("native-revision-base:{branch}@{revision}");
        for (pin, root) in [
            (&selected.pin_id, &selected.root),
            (&selected.base_pin_id, &selected.base_root),
        ] {
            self.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,-1,?4,?5,?6,0,?7)",
                params![pin,selected.head.metadata_branch,workspace,crate::model::SNAPSHOT_PIN_WRITE_REVISION,root,grant,now_ms()])?;
        }
        let id = format!("workspace-revision-filesystem:{branch}@{revision}");
        self.save_source_record(
            "workspace.revision-filesystem",
            &id,
            &workspace,
            "active",
            &selected,
        )?;
        self.conn.execute("UPDATE domain_records SET branch_id=?3,result_revision=?4 WHERE workspace_id=?1 AND record_id=?2",params![workspace,id,branch,revision])?;
        Ok(())
    }
    pub(in crate::storage) fn publish_current_filesystem(
        &mut self,
        branch: &str,
        revision: i64,
        grant: &str,
    ) -> Result<(), KernelError> {
        let data = self.branch(branch)?;
        let Some(record) = self.domain_record_value(&data.workspace_id, &record_id(branch))? else {
            return Ok(());
        };
        let head: Head = serde_json::from_str(
            record["payloadJson"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("Filesystem head is missing".into()))?,
        )?;
        let metadata = self.branch(&head.metadata_branch)?;
        let selected = super::super::workspace_results::FilesystemRevision {
            session_id: None,
            head,
            root: metadata.head_root,
            base_root: metadata.base_root,
            pin_id: String::new(),
            base_pin_id: String::new(),
        };
        self.retain_filesystem_revision(branch, revision, &selected, grant)
    }
    pub(in crate::storage) fn release_filesystem_revisions(
        &mut self,
        branch: &str,
        workspace: &str,
    ) -> Result<(), KernelError> {
        let entries = self.conn.prepare("SELECT record_id,payload_json FROM domain_records WHERE workspace_id=?1 AND branch_id=?2 AND record_type='workspace.revision-filesystem'")?
            .query_map(params![workspace,branch], |row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        for (id, payload) in entries {
            let selected: super::super::workspace_results::FilesystemRevision =
                serde_json::from_str(&payload)?;
            for pin in [&selected.pin_id, &selected.base_pin_id] {
                self.conn.execute(
                    "DELETE FROM pins WHERE pin_id=?1 AND branch_id=?2 AND workspace_id=?3",
                    params![pin, selected.head.metadata_branch, workspace],
                )?;
            }
            self.conn.execute(
                "DELETE FROM domain_records WHERE workspace_id=?1 AND record_id=?2",
                params![workspace, id],
            )?;
        }
        Ok(())
    }
    pub(in crate::storage) fn release_filesystem_revision(
        &mut self,
        branch: &str,
        workspace: &str,
        revision: i64,
    ) -> Result<(), KernelError> {
        let id = format!("workspace-revision-filesystem:{branch}@{revision}");
        let Some(value) = self.domain_record_value(workspace, &id)? else {
            return Ok(());
        };
        if value["recordType"] != "workspace.revision-filesystem"
            || value["branchId"] != branch
            || value["resultRevision"] != revision
        {
            return Err(KernelError::Storage(
                "Filesystem revision cleanup identity changed".into(),
            ));
        }
        let selected: super::super::workspace_results::FilesystemRevision = serde_json::from_str(
            value["payloadJson"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("Filesystem revision is missing".into()))?,
        )?;
        for pin in [&selected.pin_id, &selected.base_pin_id] {
            self.conn.execute(
                "DELETE FROM pins WHERE pin_id=?1 AND branch_id=?2 AND workspace_id=?3",
                params![pin, selected.head.metadata_branch, workspace],
            )?;
        }
        self.conn.execute(
            "DELETE FROM domain_records WHERE workspace_id=?1 AND record_id=?2",
            params![workspace, id],
        )?;
        Ok(())
    }
    pub(in crate::storage) fn retain_branch_result_filesystem(
        &mut self,
        publication: &str,
        branch: &str,
        grant: &str,
    ) -> Result<Option<super::super::workspace_results::FilesystemRevision>, KernelError> {
        let data = self.branch(branch)?;
        let Some(record) = self.domain_record_value(&data.workspace_id, &record_id(branch))? else {
            return Ok(None);
        };
        let head: Head =
            serde_json::from_str(record["payloadJson"].as_str().ok_or_else(|| {
                KernelError::Storage("Result filesystem head is missing".into())
            })?)?;
        let metadata = self.branch(&head.metadata_branch)?;
        let (pin_id, base_pin_id) = (
            format!("result-filesystem:{publication}"),
            format!("result-filesystem-base:{publication}"),
        );
        for (id, root) in [
            (&pin_id, &metadata.head_root),
            (&base_pin_id, &metadata.base_root),
        ] {
            self.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,-1,?4,?5,?6,0,?7)",params![id,head.metadata_branch,data.workspace_id,crate::model::SNAPSHOT_PIN_WRITE_REVISION,root,grant,now_ms()])?;
        }
        Ok(Some(super::super::workspace_results::FilesystemRevision {
            session_id: None,
            head,
            root: metadata.head_root,
            pin_id,
            base_root: metadata.base_root,
            base_pin_id,
        }))
    }
    pub(in crate::storage) fn entry_file_metadata(
        entry: &Value,
    ) -> Result<Option<FileMetadata>, KernelError> {
        let Some(raw) = entry.get("nativeJson") else {
            return Ok(None);
        };
        let value: FileMetadata = serde_json::from_str(
            raw.as_str()
                .ok_or_else(|| KernelError::Protocol("nativeJson must be a string".into()))?,
        )?;
        validate_file_metadata(&value)?;
        let state: PathState = serde_json::from_value(entry["state"].clone())?;
        if matches!(state, PathState::Missing | PathState::Unsupported) {
            return Err(KernelError::Operation(
                "An absent or unsupported entry has no native attributes".into(),
            ));
        }
        if let Some(bytes) = &value.reparse_data {
            let parsed = crate::reparse_data::parse(bytes)?;
            if !matches!(&state,PathState::Symlink{symlink_target,..}if symlink_target==&parsed.target)
            {
                return Err(KernelError::Operation(
                    "Imported reparse attributes differ from the symlink target".into(),
                ));
            }
        }
        Ok(Some(value))
    }
    pub(in crate::storage) fn import_entry_metadata(
        &mut self,
        branch: &str,
        entries: &[Value],
        grant_id: &str,
        baseline: bool,
    ) -> Result<(), KernelError> {
        let selected = entries
            .iter()
            .filter_map(|entry| match Self::entry_file_metadata(entry) {
                Ok(Some(metadata)) => Some(Ok((entry, metadata))),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, KernelError>>()?;
        if selected.is_empty() {
            return Ok(());
        }
        let grant = self.load_grant(grant_id)?;
        for (entry, value) in selected {
            let path = Self::branch_entry_path(entry)?.join("/");
            if !path_allowed(&grant, &path) {
                return Err(KernelError::Authorization(
                    "Imported attributes exceed the original path scope".into(),
                ));
            }
            let state = self
                .root_get(&self.branch(branch)?.head_root, &path)?
                .or_else(|| {
                    path.is_empty()
                        .then_some(PathState::Directory { mode: None })
                })
                .ok_or_else(|| {
                    KernelError::Storage("Imported attribute entry is missing".into())
                })?;
            let mut metadata = self.read_workspace_metadata(branch, &path, &state, &grant)?;
            metadata.attributes = metadata.attributes.with_file_metadata(&value)?;
            metadata.attributes.mode = mode(&serde_json::from_value::<PathState>(
                entry["state"].clone(),
            )?);
            self.save_workspace_metadata(branch, &path, &metadata, &grant)?;
        }
        if baseline {
            let head = self.workspace_metadata_head(branch, &grant)?;
            let root = self.branch(&head.metadata_branch)?.head_root;
            self.conn.execute(
                "UPDATE branches SET base_root=?2,head_root=?2,write_revision=0 WHERE branch_id=?1",
                params![head.metadata_branch, root],
            )?;
            self.conn.execute(
                "UPDATE revisions SET root_hash=?2 WHERE branch_id=?1 AND revision=0",
                params![head.metadata_branch, root],
            )?;
        }
        Ok(())
    }
}
