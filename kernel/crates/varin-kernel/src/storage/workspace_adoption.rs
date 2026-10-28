//! A physical source is stabilized once, off the Storage thread, into a private
//! unpublished branch. The public branch and its metadata become visible in one
//! transaction. The original operation owns both preparation and cleanup.
use super::*;
use crate::protocol_generated::KernelWorkspaceAdoptParams;

#[derive(Clone)]
pub(crate) struct Adoption {
    pub input: KernelWorkspaceAdoptParams,
    pub temporary: String,
    pub source: PathBuf,
    pub storage: PathBuf,
    pub grant: Grant,
    pub git_roots: Vec<PathBuf>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_adoption_reclaims_only_its_unpublished_state_on_owner_restart() {
        let root =
            std::env::temp_dir().join(format!("workspace-adoption-restart-{}", Uuid::new_v4()));
        let source = root.with_extension("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("original"), b"retained").unwrap();
        let mut storage = Storage::open(&root, "host").unwrap();
        storage.issue_grant(&json!({"grantId":"project","hostGeneration":"generation","owningWorkspace":"project","executionWorkspace":"project",
            "capabilities":["storage.read","storage.write"],"pathScopes":[""]}),"host","generation",&root.to_string_lossy(),"epoch").unwrap();
        let actor = storage.load_grant("project").unwrap();
        let registered=storage.file_root_register(&json!({"workspaceId":"project","executionWorkspaceId":"project","canonicalRoot":source}),&actor).unwrap();
        let input = serde_json::from_value(
            json!({"branchId":"public","rootId":registered["rootId"],"operationId":"adopt"}),
        )
        .unwrap();
        let Admission::Work(plan) = storage.begin_workspace_adoption(input, &actor).unwrap() else {
            panic!("adoption was not prepared")
        };
        storage
            .workspace_metadata_head(&plan.temporary, &actor)
            .unwrap();
        drop(storage);
        let storage = Storage::open(&root, "host").unwrap();
        let receipt = storage
            .operation_get(&json!({"operationId":"adopt"}))
            .unwrap();
        assert_eq!(receipt["state"], "failed");
        let remaining: i64 = storage
            .conn
            .query_row("SELECT count(*) FROM branches", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            remaining, 0,
            "both the private namespace and attributes were reclaimed"
        );
        assert_eq!(fs::read(source.join("original")).unwrap(), b"retained");
        drop(storage);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(source).unwrap();
    }
}
pub(crate) enum Admission {
    Complete(Value),
    Work(Adoption),
}

impl Storage {
    pub(super) fn recover_workspace_adoptions(&mut self) -> Result<(), KernelError> {
        // An import never has a mount or an external executor. A new Storage
        // owner proves its old worker is gone; only its unpublished branch is
        // discarded. Committed workspaces and their original sources survive.
        let interrupted = {
            let mut statement=self.conn.prepare("SELECT operation_id,result_json FROM operations WHERE kind='workspace.adopt' AND state='started'")?;
            let records = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            records
        };
        for (operation, body) in interrupted {
            let body: Value = serde_json::from_str(&body)?;
            let temporary = body["temporaryBranchId"].as_str().ok_or_else(|| {
                KernelError::Storage("Interrupted adoption has no original private branch".into())
            })?;
            self.filesystem_transaction(|s|{
                s.remove_adoption_branch(temporary)?;
                s.operation_failed(&operation,&KernelError::Operation("Source adoption was interrupted before publication; its private candidate was reclaimed".into()))
            })?;
        }
        Ok(())
    }
    pub(crate) fn begin_workspace_adoption(
        &mut self,
        input: KernelWorkspaceAdoptParams,
        original: &Grant,
    ) -> Result<Admission, KernelError> {
        let grant = self.load_grant(&original.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != original.kernel_epoch
            || grant.run_id.is_some()
            || grant.thread_id.is_some()
            || grant.operation_id.is_some()
            || !path_allowed(&grant, "")
        {
            return Err(KernelError::Authorization("Workspace adoption requires its original project lifetime and full selected root authority".into()));
        }
        require_capability(&grant, "workspace.adopt")?;
        let root = self.admitted_file_root(&input.root_id, &grant)?;
        if grant.owning_workspace.as_deref() != Some(root.owning_workspace_id.as_str())
            || grant
                .execution_workspace
                .as_deref()
                .or(grant.owning_workspace.as_deref())
                != Some(root.execution_workspace_id.as_str())
        {
            return Err(KernelError::Authorization(
                "Source adoption belongs to another project or execution workspace".into(),
            ));
        }
        let mut git_roots = vec![root.canonical_root.clone()];
        for id in input.git_root_ids.as_deref().unwrap_or_default() {
            git_roots.push(self.admitted_file_root(id, &grant)?.canonical_root);
        }
        git_roots.sort();
        git_roots.dedup();
        if input.operation_id.is_empty() || input.branch_id.is_empty() {
            return Err(KernelError::Operation(
                "Workspace adoption needs its original operation and target branch".into(),
            ));
        }
        let identity = json!({"input":{"branchId":input.branch_id,"rootId":input.root_id,"operationId":input.operation_id,"gitRootIds":input.git_root_ids},"workspaceId":root.owning_workspace_id,"executionWorkspaceId":root.execution_workspace_id,"source":root.canonical_root,"gitRoots":git_roots});
        let params_hash = hash_json(&identity)?;
        let prior = self.operation_get(&json!({"operationId":input.operation_id}))?;
        if !prior.is_null() {
            if prior["kind"] != "workspace.adopt" || prior["paramsHash"] != params_hash {
                return Err(KernelError::Operation(
                    "Workspace adoption operation was reused for another source or owner".into(),
                ));
            }
            if prior["state"] == "committed" {
                return Ok(Admission::Complete(prior["result"].clone()));
            }
            if let Some(temporary) = prior["result"]["temporaryBranchId"].as_str() {
                if self
                    .workspace_sessions
                    .get(temporary)
                    .and_then(std::sync::Weak::upgrade)
                    .is_some_and(|session| session.check_open().is_ok())
                {
                    return Err(KernelError::Operation(
                        "The original source adoption is still active".into(),
                    ));
                }
                self.remove_adoption_branch(temporary)?;
            }
        }
        if self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM branches WHERE branch_id=?1)",
            params![input.branch_id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(KernelError::Operation(
                "Workspace adoption target already exists; it was not changed".into(),
            ));
        }
        let temporary = format!("workspace-adoption:{}", Uuid::new_v4());
        self.filesystem_transaction(|s| {
            s.conn.execute("DELETE FROM operations WHERE operation_id=?1",params![input.operation_id])?;
            s.operation_begin(&input.operation_id,"workspace.adopt",&params_hash)?;
            s.record_operation_workspace(&input.operation_id,Some(&root.owning_workspace_id))?;
            s.create_branch(&json!({"operationId":format!("{temporary}:create"),"branchId":temporary,"workspaceId":root.owning_workspace_id,"entries":[],"draftBasePaths":[],"captureScopes":[]}),&grant.grant_id)?;
            s.conn.execute("UPDATE operations SET result_json=?2 WHERE operation_id=?1",params![input.operation_id,serde_json::to_string(&json!({"phase":"inventory","temporaryBranchId":temporary,"grantId":grant.grant_id,"identity":identity,"entries":0,"bytes":0}))?])?;
            Ok(())
        })?;
        Ok(Admission::Work(Adoption {
            input,
            temporary,
            source: root.canonical_root,
            storage: self.root.clone(),
            grant,
            git_roots,
        }))
    }
    pub(crate) fn workspace_adoption_progress(
        &mut self,
        plan: &Adoption,
        phase: &str,
        entries: u64,
        bytes: u64,
    ) -> Result<(), KernelError> {
        let grant = self.load_grant(&plan.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != plan.grant.kernel_epoch
        {
            return Err(KernelError::Cancelled);
        }
        let prior = self.operation_get(&json!({"operationId":plan.input.operation_id}))?;
        if prior["state"] != "started" || prior["result"]["temporaryBranchId"] != plan.temporary {
            return Err(KernelError::Operation(
                "Original adoption preparation changed".into(),
            ));
        }
        let mut progress = prior["result"].clone();
        progress["phase"] = json!(phase);
        progress["entries"] = json!(entries);
        progress["bytes"] = json!(bytes);
        self.conn.execute(
            "UPDATE operations SET result_json=?2,updated_at=?3 WHERE operation_id=?1",
            params![
                plan.input.operation_id,
                serde_json::to_string(&progress)?,
                now_ms()
            ],
        )?;
        Ok(())
    }
    fn remove_adoption_branch(&mut self, temporary: &str) -> Result<(), KernelError> {
        if !temporary.starts_with("workspace-adoption:") {
            return Err(KernelError::Storage(
                "Adoption cleanup has an invalid private branch".into(),
            ));
        }
        if self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM branches WHERE branch_id=?1)",
            params![temporary],
            |row| row.get::<_, bool>(0),
        )? {
            self.branch_delete(&json!({"branchId":temporary}))?;
        }
        Ok(())
    }
    pub(crate) fn abort_workspace_adoption(
        &mut self,
        plan: &Adoption,
        error: &KernelError,
    ) -> Result<(), KernelError> {
        let prior = self.operation_get(&json!({"operationId":plan.input.operation_id}))?;
        if prior["state"] == "committed" {
            return Ok(());
        }
        if prior["kind"] != "workspace.adopt"
            || prior["result"]["temporaryBranchId"] != plan.temporary
        {
            return Err(KernelError::Operation(
                "Adoption cleanup differs from its original operation".into(),
            ));
        }
        self.filesystem_transaction(|s| {
            s.remove_adoption_branch(&plan.temporary)?;
            s.operation_failed(&plan.input.operation_id, error)
        })
    }
    pub(crate) fn finish_workspace_adoption(
        &mut self,
        plan: &Adoption,
        entries: u64,
        bytes: u64,
        cancel: &AtomicBool,
    ) -> Result<Value, KernelError> {
        if cancel.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        self.workspace_adoption_progress(plan, "publish", entries, bytes)?;
        let data = self.branch(&plan.temporary)?;
        let metadata = self.workspace_metadata_head(&plan.temporary, &plan.grant)?;
        let metadata_root = self.branch(&metadata.metadata_branch)?.head_root;
        self.filesystem_transaction(|s|{
            let mut result=s.create_branch(&json!({"operationId":plan.input.operation_id,"branchId":plan.input.branch_id,"workspaceId":data.workspace_id,
                "baseRef":data.head_root,"entries":[],"draftBasePaths":[],"captureScopes":[]}),&plan.grant.grant_id)?;
            s.fork_workspace_metadata(&metadata,&plan.input.branch_id,&metadata_root,&plan.grant,&[], "")?;
            result["adoption"]=json!({"consistency":"stable-capture","sourceRootId":plan.input.root_id,"entries":entries,"bytes":bytes});
            s.remove_adoption_branch(&plan.temporary)?;
            s.operation_finish(&plan.input.operation_id,&result)?;
            Ok(result)
        })
    }
}
