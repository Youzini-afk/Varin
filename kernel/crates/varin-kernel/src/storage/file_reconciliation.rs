//! Private journal observation for recovery; no filesystem replay.
use super::file_resources::FileState;
use super::file_mutations::TextMutation;
use super::*;

impl Storage {
    /// Observe one exact journal entry under freshly admitted authority. The old
    /// grant is provenance only; it never authorizes a filesystem access here.
    pub(crate) fn reconcile_text_mutation(
        &mut self,
        workspace_id: &str,
        root_id: &str,
        operation_id: &str,
        mutation: &TextMutation,
        grant: &Grant,
        executor: &str,
    ) -> Result<Option<varin_runtime::ExternalReceipt>, KernelError> {
        let resource = self.resolve_file_resource(root_id, mutation.path(), grant, false)?;
        self.assert_file_lease(
            grant,
            root_id,
            &[FileLeaseResource {
                path: resource.path.clone(),
                subtree: false,
            }],
            None,
        )?;
        self.check_cancelled()?;
        let owned: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_owners WHERE operation_id=?1 AND workspace_id=?2)",
            params![operation_id,workspace_id], |row|row.get(0))?;
        if !owned {
            return Ok(None);
        }
        let prior = self.operation_get(&json!({"operationId":operation_id}))?;
        if prior.is_null() {
            return Ok(None);
        }
        if prior["kind"] != "file.apply" {
            return Err(KernelError::Authorization(
                "mutation receipt identifies another resource operation".into(),
            ));
        }
        let mut receipt = prior["result"].clone();
        let identity = if prior["state"] == "started" {
            &receipt["intent"]
        } else {
            &receipt
        };
        let Some(original_grant_id) = identity["__nativeGrantId"].as_str() else {
            // Missing provenance is not evidence that dispatch did not happen.
            return Ok(None);
        };
        let original_epoch = identity["__nativeEpoch"]
            .as_str()
            .filter(|epoch| !epoch.is_empty())
            .ok_or_else(|| {
                KernelError::Storage("mutation receipt omitted original execution epoch".into())
            })?
            .to_string();
        let original = self.load_grant(original_grant_id)?;
        if original.run_id.is_none()
            || original.run_id != grant.run_id
            || original.thread_id != grant.thread_id
            || original.host_id != grant.host_id
            || original.owning_workspace != grant.owning_workspace
            || original
                .execution_workspace
                .as_ref()
                .or(original.owning_workspace.as_ref())
                != grant
                    .execution_workspace
                    .as_ref()
                    .or(grant.owning_workspace.as_ref())
            || original.storage_identity != grant.storage_identity
        {
            return Err(KernelError::Authorization(
                "mutation receipt belongs to another run, thread, or resource owner".into(),
            ));
        }
        let request_hash = hash_json(&json!([
            "text-mutation-v1",
            original.grant_id,
            workspace_id,
            root_id,
            operation_id,
            mutation
        ]))?;
        if identity["__nativeRequestHash"].as_str() != Some(request_hash.as_str()) {
            return Err(KernelError::Authorization(
                "mutation receipt does not match the admitted tool arguments and source".into(),
            ));
        }
        if prior["state"] == "started" {
            let intent = receipt["intent"].clone();
            if intent["rootId"] != root_id
                || intent["path"] != resource.path
                || intent["workspaceId"] != workspace_id
            {
                return Err(KernelError::Authorization(
                    "mutation intent source identity changed".into(),
                ));
            }
            let target: FileState =
                serde_json::from_str(intent["targetJson"].as_str().ok_or_else(|| {
                    KernelError::Storage("mutation intent omitted target".into())
                })?)?;
            let (observed, _) = self.capture_file_state(
                &resource,
                false,
                "observe",
                workspace_id,
                &grant.grant_id,
            )?;
            if !Self::file_state_matches(&observed, &target) {
                return Ok(None);
            }
            // Same factual reconciliation used by file-root admission. Never
            // call file_apply or reconstruct/edit the file to produce evidence.
            receipt = json!({"status":"applied","reconciled":true,"stateJson":serde_json::to_string(&observed)?});
            self.finish_file_operation_owned(
                operation_id,
                &receipt,
                intent["ownerId"].as_str(),
                Some(workspace_id),
            )?;
        } else if prior["state"] != "committed" {
            return Ok(None);
        }
        let observed_receipt: FileState =
            serde_json::from_str(receipt["stateJson"].as_str().ok_or_else(|| {
                KernelError::Storage("mutation terminal receipt omitted file state".into())
            })?)?;
        if receipt["status"] == "applied"
            && !matches!(observed_receipt, FileState::RegularFile { .. })
        {
            return Err(KernelError::Storage(
                "text mutation applied receipt is not a regular file".into(),
            ));
        }
        let (outcome, effect) = match receipt["status"].as_str() {
            Some("applied") => (
                varin_runtime::Outcome::Succeeded,
                varin_runtime::Effect::Confirmed,
            ),
            Some("conflict") => (varin_runtime::Outcome::Failed, varin_runtime::Effect::None),
            _ => {
                return Err(KernelError::Storage(
                    "mutation journal has an invalid terminal receipt".into(),
                ))
            }
        };
        // Receipt content must be identical across repeated reconciliation and
        // fresh grants. It is a historical effect fact, not a new read snapshot.
        if let Some(object) = receipt.as_object_mut() {
            object.remove("__nativeRequestHash");
            object.remove("__nativeGrantId");
            object.remove("__nativeEpoch");
        }
        receipt["path"] = json!(resource.path);
        Ok(Some(varin_runtime::ExternalReceipt {
            executor: executor.into(),
            identity: operation_id.into(),
            epoch: original_epoch,
            outcome,
            effect,
            result: receipt,
        }))
    }
}
