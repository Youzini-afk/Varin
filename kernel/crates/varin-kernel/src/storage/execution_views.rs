//! A fixed source remains available without copying. Its first command obtains a
//! Run-owned physical view, and subsequent source tools resolve that same view.
use super::*;
use crate::tools::{FixedFileSource, ToolBinding};
use varin_runtime::SourceMode;

impl Storage {
    pub(crate) fn deferred_source_binding(&mut self, binding: &ToolBinding, grant: &Grant) -> Result<Option<ToolBinding>, KernelError> {
        if binding.source_mode != SourceMode::Materialized || binding.root_id.is_some() { return Ok(None); }
        let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([binding.workspace_id,
            binding.environment_run_id.as_deref().unwrap_or(&binding.run_id)]))?));
        let receipt = self.operation_get(&json!({"operationId":format!("source-materialize:{key}")}))?;
        if receipt.is_null() || receipt["state"] != "committed" { return Ok(None); }
        if receipt["kind"] != "file.materialize" || receipt["result"]["status"] != "materialized" {
            return Err(KernelError::Storage("Original child materialization needs reconciliation".into()));
        }
        let target = self.root.join("managed").join("runs").join(key);
        // file_root_register resolves and checks the original directory; it must
        // not recreate a lost, previously published execution environment.
        let root = self.file_root_register(&json!({"workspaceId":binding.workspace_id,
            "executionWorkspaceId":binding.execution_workspace_id,"canonicalRoot":target}), grant)?;
        let mut effective = binding.clone();
        effective.root_id = Some(root["rootId"].as_str().unwrap().into());
        Ok(Some(effective))
    }
    pub(crate) fn prepare_deferred_source(&mut self, binding: &ToolBinding, grant: &Grant, cancellation: Arc<AtomicBool>)
        -> Result<super::materialization::Admission, KernelError> {
        let fixed = binding.materialized_source.as_ref().ok_or_else(|| KernelError::Authorization("Deferred source has no fixed baseline".into()))?;
        let source = self.branch_read(&json!({"branchId":fixed.branch_id,"revision":fixed.revision,"includeEntries":false}))?;
        if source["workspaceId"] != binding.workspace_id { return Err(KernelError::Authorization("Deferred source belongs to another workspace".into())); }
        let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([binding.workspace_id,
            binding.environment_run_id.as_deref().unwrap_or(&binding.run_id)]))?));
        let root = self.file_root_register(&json!({"workspaceId":binding.workspace_id,
            "executionWorkspaceId":binding.execution_workspace_id,"canonicalRoot":self.root}), grant)?;
        self.prepare_materialization(&json!({"operationId":format!("source-materialize:{key}"),"workspaceId":binding.workspace_id,
            "rootId":root["rootId"],"path":format!("managed/runs/{key}"),"sourceRoot":source["root"]}), grant, cancellation)
    }
    pub(super) fn validate_execution_view_grant(
        &self,
        record: &Value,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        let original = self.load_grant(
            record["ownerGrantId"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("Execution view owner missing".into()))?,
        )?;
        if grant.run_id.is_none()
            || original.run_id != grant.run_id
            || original.thread_id != grant.thread_id
            || original.owning_workspace != grant.owning_workspace
            || original.execution_workspace != grant.execution_workspace
        {
            return Err(KernelError::Authorization(
                "Execution view belongs to another original Run".into(),
            ));
        }
        self.validate_source_grant_owner(&grant.grant_id, &original.grant_id)
    }
    pub(super) fn checked_execution_view(
        &self,
        record: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        self.validate_execution_view_grant(record, grant)?;
        let original =
            self.load_grant(record["ownerGrantId"].as_str().expect("checked view owner"))?;
        // The old generation identifies retained bytes. Current caller authority was
        // checked above; reopening must not replace this mutable execution directory.
        self.check_materialized_view(
            &json!({"workspaceId":record["workspaceId"],"viewId":record["viewId"]}),
            &original,
        )
    }
    pub(crate) fn inspect_execution_view(
        &mut self,
        params: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: crate::protocol_generated::KernelExecutionViewParams =
            super::file_resources::parse_file_params(params)?;
        if grant.owning_workspace.as_deref() != Some(&params.workspace_id) || params.revision < 0 {
            return Err(KernelError::Authorization(
                "Execution view source scope differs from its Run".into(),
            ));
        }
        let run = grant
            .run_id
            .as_deref()
            .ok_or_else(|| KernelError::Authorization("Original source Run required".into()))?;
        let id = format!("run-execution:{run}");
        let Some(mut record) = self.materialized_view_record(&params.workspace_id, &id)? else {
            return Ok(Value::Null);
        };
        self.validate_execution_view_grant(&record, grant)?;
        if record["branchId"] != params.branch_id || record["revision"] != params.revision {
            return Err(KernelError::Authorization(
                "Execution view baseline changed".into(),
            ));
        }
        if record["state"] == "preparing" {
            let operation = record["operationId"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("Execution view journal missing".into()))?;
            let receipt = self.operation_get(&json!({"operationId":operation}))?;
            if receipt["state"] == "committed" && receipt["result"]["status"] == "materialized" {
                let original = self.load_grant(record["ownerGrantId"].as_str().unwrap())?;
                self.finish_materialized_view(&json!({"workspaceId":record["workspaceId"],"executionWorkspaceId":record["executionWorkspaceId"],"branchId":record["branchId"],"revision":record["revision"],"viewId":id}),&original,receipt["result"].clone())?;
                record = self
                    .materialized_view_record(&params.workspace_id, &id)?
                    .expect("reconciled view");
            } else {
                return Ok(
                    json!({"status":if self.materializations.contains_key(operation){"preparing"}else{"interrupted"},"viewId":id}),
                );
            }
        }
        let mut view = self.checked_execution_view(&record, grant)?;
        let root=self.file_root_register(&json!({"workspaceId":params.workspace_id,"executionWorkspaceId":record["executionWorkspaceId"],"canonicalRoot":view["canonicalRoot"]}),grant)?;
        view["rootId"] = root["rootId"].clone();
        view["status"] = json!("ready");
        Ok(view)
    }
    /// Source services use the same Run view as native tools. The original branch
    /// remains the authority; an unrelated branch or grant cannot select this root.
    pub(crate) fn execution_compute_root(
        &mut self,
        workspace: &str,
        branch: &str,
        revision: i64,
        grant: &Grant,
    ) -> Result<Option<String>, KernelError> {
        let Some(run) = grant.run_id.as_deref() else {
            return Ok(None);
        };
        let id = format!("run-execution:{run}");
        let Some(record) = self.materialized_view_record(workspace, &id)? else {
            return Ok(None);
        };
        if record["branchId"] != branch || record["revision"] != revision {
            return Ok(None);
        };
        let view = self.inspect_execution_view(
            &json!({"workspaceId":workspace,"branchId":branch,"revision":revision}),
            grant,
        )?;
        Ok(if view["status"] == "ready" {
            Some(
                view["rootId"]
                    .as_str()
                    .ok_or_else(|| KernelError::Storage("Execution root missing".into()))?
                    .into(),
            )
        } else {
            None
        })
    }
    pub(crate) fn execution_view_params(binding: &ToolBinding) -> Result<Value, KernelError> {
        let fixed = binding
            .file_source
            .as_ref()
            .filter(|_| binding.source_mode == SourceMode::FixedBranch)
            .ok_or_else(|| {
                KernelError::Authorization(
                    "Execution view requires its original fixed source".into(),
                )
            })?;
        Ok(
            json!({"workspaceId":binding.workspace_id,"executionWorkspaceId":binding.execution_workspace_id,
            "branchId":fixed.branch_id,"revision":fixed.revision,"viewId":format!("run-execution:{}",binding.run_id)}),
        )
    }
    pub(crate) fn require_execution_view_owner(
        binding: &ToolBinding,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        if grant.run_id.as_deref() != Some(&binding.run_id)
            || grant.thread_id.as_deref() != Some(&binding.thread_id)
            || grant.owning_workspace.as_deref() != Some(&binding.workspace_id)
            || grant
                .execution_workspace
                .as_deref()
                .or(grant.owning_workspace.as_deref())
                != Some(&binding.execution_workspace_id)
            || !(grant.capabilities.contains("process")
                || grant.capabilities.contains("storage.admin"))
        {
            return Err(KernelError::Authorization(
                "Execution view requires the original Run's process authority".into(),
            ));
        }
        Ok(())
    }
    pub(crate) fn execution_tool_binding(
        &mut self,
        binding: &ToolBinding,
        grant: &Grant,
    ) -> Result<Option<ToolBinding>, KernelError> {
        if binding.source_mode != SourceMode::FixedBranch {
            return Ok(None);
        }
        let params = Self::execution_view_params(binding)?;
        self.inspect_execution_view(&json!({"workspaceId":binding.workspace_id,"branchId":params["branchId"],"revision":params["revision"]}),grant)?;
        let id = params["viewId"].as_str().expect("view identity");
        let Some(record) = self.materialized_view_record(&binding.workspace_id, id)? else {
            return Ok(None);
        };
        self.validate_execution_view_grant(&record, grant)?;
        if record["branchId"] != params["branchId"] || record["revision"] != params["revision"] {
            return Err(KernelError::Authorization(
                "Execution view differs from its retained source owner".into(),
            ));
        }
        if record["state"] == "preparing" {
            return Ok(None);
        };
        let view = self.checked_execution_view(&record, grant)?;
        let root=self.file_root_register(&json!({"workspaceId":binding.workspace_id,"executionWorkspaceId":binding.execution_workspace_id,"canonicalRoot":view["canonicalRoot"]}),grant)?;
        let mut effective = binding.clone();
        effective.source_mode = SourceMode::Materialized;
        effective.root_id = Some(
            root["rootId"]
                .as_str()
                .ok_or_else(|| {
                    KernelError::Storage("Execution view omitted its root identity".into())
                })?
                .into(),
        );
        effective.materialized_source = Some(FixedFileSource {
            branch_id: params["branchId"].as_str().unwrap().into(),
            revision: params["revision"].as_i64().unwrap(),
        });
        effective.file_source = None;
        effective.environment_run_id = Some(binding.run_id.clone());
        Ok(Some(effective))
    }
}
