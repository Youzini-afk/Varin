//! Native file-service boundaries enter the existing WorkingResult owner. The
//! active head is allowed to advance; publication retains its selected tree and
//! filesystem metadata, and never reads a physical execution directory.
use super::workspace_files::InstalledFile;
use super::workspace_metadata::{Head, Metadata};
use super::*;
use serde::{Deserialize, Serialize};

const RESULT_METADATA: &str = "workspace.result-filesystem";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FilesystemRevision {
    #[serde(skip_serializing_if="Option::is_none")]
    pub session_id: Option<Uuid>,
    pub head: Head,
    pub root: String,
    pub pin_id: String,
    pub base_root: String,
    pub base_pin_id: String,
}
fn metadata_record(result: &str) -> String {
    format!("workspace-result-filesystem:{result}")
}
impl Storage {
    pub(super) fn replay_workspace_result(
        &self,
        publication: &str,
        branch: &str,
        session: Uuid,
        grant: &Grant,
    ) -> Result<Option<Value>, KernelError> {
        let operation =
            self.operation_get(&json!({"operationId":format!("result-prepare:{publication}")}))?;
        if operation.is_null() {
            return Ok(None);
        }
        let candidate = &operation["result"];
        if operation["kind"] != "working.result.prepare"
            || operation["state"] != "committed"
            || candidate["branchId"] != branch
            || candidate["publicationId"] != publication
            || candidate["ownerGrantId"] != grant.grant_id
            || candidate["filesystem"]["sessionId"] != session.to_string()
        {
            return Err(KernelError::Authorization(
                "Result preparation differs from its original workspace boundary and owner".into(),
            ));
        }
        Ok(Some(candidate.clone()))
    }
    pub(super) fn prepare_workspace_result(
        &mut self,
        publication: &str,
        branch_id: &str,
        pin: &str,
        base_pin: &str,
        metadata_pin: &str,
        branch: &BranchRow,
        head: &Head,
        metadata: &[(String, Metadata)],
        files: &[(Vec<String>, u32, InstalledFile)],
        session: Uuid,
        grant: &Grant,
        file_owner: &Grant,
    ) -> Result<Value, KernelError> {
        let current = self.require_result_scope(&grant.grant_id, &branch.workspace_id)?;
        if current.state != crate::model::GrantState::Active
            || current.kernel_epoch != grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Native result requires its original current authority".into(),
            ));
        }
        if current.owning_workspace.as_deref() != Some(branch.workspace_id.as_str())
            && !current.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "Native result belongs to another workspace".into(),
            ));
        }
        if self.branch(branch_id)?.workspace_id != branch.workspace_id {
            return Err(KernelError::Authorization(
                "Native result source branch changed workspace".into(),
            ));
        }
        require_capability(&current, "working.result.prepare")?;
        if let Some(result) =
            self.replay_workspace_result(publication, branch_id, session, grant)?
        {
            return Ok(result);
        }
        let retained_owner = self.load_grant(&file_owner.grant_id)?;
        if retained_owner.state != crate::model::GrantState::Active
            || retained_owner.kernel_epoch != file_owner.kernel_epoch
            || retained_owner.owning_workspace != Some(branch.workspace_id.clone())
            || current
                .execution_workspace
                .as_ref()
                .or(current.owning_workspace.as_ref())
                != retained_owner
                    .execution_workspace
                    .as_ref()
                    .or(retained_owner.owning_workspace.as_ref())
        {
            return Err(KernelError::Authorization(
                "Native file-service owner is no longer current".into(),
            ));
        }
        let data = self.pin_read(
            &json!({"pinId":pin,"includeEntries":false}),
            &file_owner.grant_id,
        )?;
        let baseline = self.pin_read(
            &json!({"pinId":base_pin,"includeEntries":false}),
            &file_owner.grant_id,
        )?;
        let attrs = self.pin_read(
            &json!({"pinId":metadata_pin,"includeEntries":false}),
            &file_owner.grant_id,
        )?;
        if data["branchId"] != branch_id
            || data["root"] != branch.head_root
            || data["workspaceId"] != branch.workspace_id
            || baseline["root"] != branch.base_root
            || baseline["branchId"] != branch_id
            || baseline["workspaceId"] != branch.workspace_id
            || head.branch_id != branch_id
            || attrs["branchId"] != head.metadata_branch
            || attrs["workspaceId"] != branch.workspace_id
        {
            return Err(KernelError::Authorization(
                "Native result pins do not belong to the selected file-service boundary".into(),
            ));
        }
        let mut entries = Vec::new();
        for (paths, mode, file) in files {
            for path in paths {
                entries.push((Self::validate_path(path)?, file.state(*mode)));
            }
        }
        let operation = format!("result-prepare:{publication}");
        let identity = json!({"operationId":operation,"publicationId":publication,"workspaceId":branch.workspace_id,
            "branchId":branch_id,"sourcePinId":pin,"metadataPinId":metadata_pin,"sessionId":session,"grantId":grant.grant_id});
        super::operations::idempotent(self, "working.result.prepare", &identity, |storage| {
            for (_, state) in &entries {
                if let PathState::RegularFile {
                    object_hash,
                    byte_length,
                    ..
                } = state
                {
                    storage.conn.execute(
                        "INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES(?1,?2)",
                        params![
                            object_hash,
                            i64::try_from(*byte_length).map_err(|_| KernelError::Operation(
                                "Native result file exceeds Storage length range".into()
                            ))?
                        ],
                    )?;
                }
            }
            let root = storage.root_apply(&branch.head_root, &entries)?;
            storage.record_root_blob_hashes(
                &root,
                entries
                    .iter()
                    .filter_map(|(_, state)| state.object_hash().map(str::to_owned)),
            )?;
            storage.record_root_parent(&root, &branch.head_root)?;
            let metadata_root = storage.workspace_metadata_snapshot(
                attrs["root"].as_str().ok_or_else(|| {
                    KernelError::Storage("Native metadata pin has no root".into())
                })?,
                metadata,
            )?;
            let pin_id = format!("result-candidate:{publication}");
            let base_pin = format!("result-base:{publication}");
            let filesystem_pin = format!("result-filesystem:{publication}");
            let filesystem_base_pin = format!("result-filesystem-base:{publication}");
            let filesystem_base = storage.branch(&head.metadata_branch)?.base_root;
            for (id, selected_branch, selected_root) in [
                (&pin_id, branch_id, root.as_str()),
                (&base_pin, branch_id, branch.base_root.as_str()),
                (
                    &filesystem_pin,
                    head.metadata_branch.as_str(),
                    metadata_root.as_str(),
                ),
                (
                    &filesystem_base_pin,
                    head.metadata_branch.as_str(),
                    filesystem_base.as_str(),
                ),
            ] {
                storage.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,-1,?4,?5,?6,0,?7)",
                    params![id,selected_branch,branch.workspace_id,crate::model::SNAPSHOT_PIN_WRITE_REVISION,selected_root,grant.grant_id,now_ms()])?;
            }
            let filesystem = FilesystemRevision {
                session_id: Some(session),
                head: head.clone(),
                root: metadata_root,
                pin_id: filesystem_pin,
                base_root: filesystem_base,
                base_pin_id: filesystem_base_pin,
            };
            Ok(
                json!({"publicationId":publication,"candidateOperationId":operation,"workspaceId":branch.workspace_id,"branchId":branch_id,
                "root":root,"baseRoot":branch.base_root,"writeRevision":branch.write_revision,"pinId":pin_id,"basePinId":base_pin,
                "parentRef":branch.parent_ref,"ownerGrantId":grant.grant_id,"ownerThreadId":grant.thread_id,"ownerSessionId":Value::Null,"filesystem":filesystem}),
            )
        })
    }
    pub(super) fn require_result_filesystem_pin(
        &self,
        candidate: &Value,
    ) -> Result<(), KernelError> {
        let Some(value) = candidate.get("filesystem") else {
            return Ok(());
        };
        let filesystem: FilesystemRevision = serde_json::from_value(value.clone())?;
        for (pin, root) in [
            (&filesystem.pin_id, &filesystem.root),
            (&filesystem.base_pin_id, &filesystem.base_root),
        ] {
            let retained:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM pins WHERE pin_id=?1 AND branch_id=?2 AND workspace_id=?3 AND root_hash=?4 AND ephemeral=0)",
                params![pin,filesystem.head.metadata_branch,candidate["workspaceId"].as_str(),root],|row|row.get(0))?;
            if !retained {
                return Err(KernelError::Operation(
                    "Native result filesystem boundary was released".into(),
                ));
            }
        }
        Ok(())
    }
    pub(super) fn retain_published_result_filesystem(
        &mut self,
        candidate: &Value,
        result: &result_publication::PreparedWorkingResult,
    ) -> Result<(), KernelError> {
        let Some(value) = candidate.get("filesystem") else {
            return Ok(());
        };
        let mut filesystem: FilesystemRevision = serde_json::from_value(value.clone())?;
        self.require_result_filesystem_pin(candidate)?;
        self.retain_filesystem_revision(&result.branch_id,result.revision,&filesystem,candidate["ownerGrantId"].as_str().ok_or_else(||KernelError::Storage("Filesystem revision owner is missing".into()))?)?;
        filesystem.pin_id = format!("native-result:{}", result.record_id);
        filesystem.base_pin_id = format!("native-result-base:{}", result.record_id);
        for (pin, root) in [
            (&filesystem.pin_id, &filesystem.root),
            (&filesystem.base_pin_id, &filesystem.base_root),
        ] {
            self.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,-1,?4,?5,?6,0,?7)",
                params![pin,filesystem.head.metadata_branch,result.workspace,crate::model::SNAPSHOT_PIN_WRITE_REVISION,root,candidate["ownerGrantId"].as_str(),now_ms()])?;
        }
        let id = metadata_record(&result.record_id);
        if self.domain_record_value(&result.workspace, &id)?.is_some() {
            return Err(KernelError::Storage(
                "Native result metadata identity is already occupied".into(),
            ));
        }
        self.save_source_record(
            RESULT_METADATA,
            &id,
            &result.workspace,
            "active",
            &filesystem,
        )?;
        self.conn.execute("UPDATE domain_records SET branch_id=?3,result_revision=?4 WHERE workspace_id=?1 AND record_id=?2",params![result.workspace,id,result.branch_id,result.revision])?;
        Ok(())
    }
    pub(super) fn release_result_filesystem(
        &mut self,
        workspace: &str,
        result_record: &str,
    ) -> Result<(), KernelError> {
        let id = metadata_record(result_record);
        let Some(value) = self.domain_record_value(workspace, &id)? else {
            return Ok(());
        };
        if value["recordType"] != RESULT_METADATA {
            return Err(KernelError::Storage(
                "Native result metadata record has another owner".into(),
            ));
        }
        let filesystem: FilesystemRevision =
            serde_json::from_str(value["payloadJson"].as_str().ok_or_else(|| {
                KernelError::Storage("Native result metadata is missing".into())
            })?)?;
        if filesystem.pin_id != format!("native-result:{result_record}")
            || filesystem.base_pin_id != format!("native-result-base:{result_record}")
        {
            return Err(KernelError::Storage(
                "Native result metadata pin identity changed".into(),
            ));
        }
        self.conn.execute("DELETE FROM pins WHERE pin_id=?1 AND branch_id=?2 AND workspace_id=?3 AND root_hash=?4",params![filesystem.pin_id,filesystem.head.metadata_branch,workspace,filesystem.root])?;
        self.conn.execute("DELETE FROM pins WHERE pin_id=?1 AND branch_id=?2 AND workspace_id=?3 AND root_hash=?4",params![filesystem.base_pin_id,filesystem.head.metadata_branch,workspace,filesystem.base_root])?;
        self.conn.execute(
            "DELETE FROM domain_records WHERE workspace_id=?1 AND record_id=?2",
            params![workspace, id],
        )?;
        Ok(())
    }
    pub(super) fn release_branch_result_filesystems(
        &mut self,
        workspace: &str,
        branch: &str,
    ) -> Result<(), KernelError> {
        let records = {
            let mut query=self.conn.prepare("SELECT record_id FROM domain_records WHERE workspace_id=?1 AND branch_id=?2 AND record_type=?3")?;
            let rows = query.query_map(params![workspace, branch, RESULT_METADATA], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for id in records {
            let result = id
                .strip_prefix("workspace-result-filesystem:")
                .ok_or_else(|| {
                    KernelError::Storage("Native result metadata identity is invalid".into())
                })?;
            self.release_result_filesystem(workspace, result)?;
        }
        Ok(())
    }
}
