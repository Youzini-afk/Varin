//! Logical native source identity survives mount generations. The concrete root
//! is admitted only by its original workspace service, never a caller override.
use super::*;
use crate::tools::ToolBinding;

#[derive(Clone)]
pub(crate) struct NativeFileRoot {
    pub session: std::sync::Weak<workspace_session::Session>,
    pub scope: String,
}
pub(crate) struct NativeReadRetention(std::sync::Weak<workspace_session::Session>);
impl Drop for NativeReadRetention {
    fn drop(&mut self) {
        if let Some(session) = self.0.upgrade() {
            session.notify_native_idle();
        }
    }
}
impl std::fmt::Debug for NativeFileRoot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeFileRoot")
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}
impl NativeFileRoot {
    pub(crate) fn attributes(
        &self,
        path: &str,
    ) -> Result<workspace_metadata::Attributes, KernelError> {
        let session = self
            .session
            .upgrade()
            .ok_or_else(|| KernelError::Authorization("Native file owner is closed".into()))?;
        session.check_mounted()?;
        let path = if self.scope.is_empty() {
            path.into()
        } else if path.is_empty() {
            self.scope.clone()
        } else {
            format!("{}/{path}", self.scope)
        };
        let node = session.lookup(&path)?;
        let result = node.attributes();
        session.forget_cached(&node)?;
        result
    }
    pub(crate) fn apply(
        &self,
        path: &str,
        mode: Option<u32>,
        metadata: &varin_runtime::catalog::followups::FileMetadata,
    ) -> Result<(), KernelError> {
        let session = self
            .session
            .upgrade()
            .ok_or_else(|| KernelError::Authorization("Native file owner is closed".into()))?;
        session.check_mounted()?;
        let path = if self.scope.is_empty() {
            path.into()
        } else if path.is_empty() {
            self.scope.clone()
        } else {
            format!("{}/{path}", self.scope)
        };
        let node = session.lookup(&path)?;
        let mut attributes = node.attributes()?.with_file_metadata(metadata)?;
        if let Some(mode) = mode {
            attributes.mode = mode;
        }
        let result = session.import_attributes(&node, attributes);
        session.forget_cached(&node)?;
        result
    }
}

pub(crate) fn root_id(workspace: &str, execution: &str, branch: &str, scope: &str) -> String {
    format!(
        "native-root-{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&json!([workspace, execution, branch, scope]))
                .expect("source identity")
        ))
    )
}
impl Storage {
    pub(super) fn retain_native_reader(
        &self,
        root: &str,
    ) -> Result<Option<Arc<NativeReadRetention>>, KernelError> {
        if !self.native_file_roots.contains_key(root) {
            return Ok(None);
        }
        let session = self
            .file_roots
            .get(root)
            .and_then(|root| root.native.as_ref())
            .ok_or_else(|| KernelError::Storage("Native reader lost its original root".into()))?
            .session
            .clone();
        let token = Arc::new(NativeReadRetention(session));
        let mut readers = self
            .native_readers
            .lock()
            .map_err(|_| KernelError::Storage("Native file reader registry failed".into()))?;
        let retained = readers.entry(root.into()).or_default();
        retained.retain(|reader| reader.strong_count() > 0);
        retained.push(Arc::downgrade(&token));
        Ok(Some(token))
    }
    pub(crate) fn assert_native_source_idle(
        &mut self,
        branch: &str,
        generation: &str,
    ) -> Result<(), KernelError> {
        let roots = self
            .native_file_roots
            .iter()
            .filter(|(_, (selected, epoch, _))| selected == branch && epoch == generation)
            .filter_map(|(id, _)| self.file_roots.get(id))
            .collect::<Vec<_>>();
        let readers = self
            .native_readers
            .lock()
            .map_err(|_| KernelError::Storage("Native file reader registry failed".into()))?;
        let active_reads = roots.iter().any(|root| {
            readers
                .get(&root.root_id)
                .is_some_and(|readers| readers.iter().any(|reader| reader.strong_count() > 0))
        });
        drop(readers);
        if active_reads
            || self
                .file_leases
                .values()
                .any(|lease| roots.iter().any(|root| root.root_id == lease.root_id))
            || self.computations.jobs.values().any(|job| {
                !job.done()
                    && job
                        .root
                        .as_ref()
                        .is_some_and(|id| roots.iter().any(|root| &root.root_id == id))
            })
        {
            return Err(KernelError::Execution(
                varin_runtime::execution::ExecutionError::new(
                    "workspace_in_use",
                    "A file operation or computation still uses this native mount",
                ),
            ));
        }
        let paths = roots
            .iter()
            .map(|root| root.canonical_root.clone())
            .collect::<Vec<_>>();
        let ids = {
            let mut query = self
                .conn
                .prepare("SELECT process_id,status_json FROM process_records")?;
            let rows = query.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut ids = Vec::new();
            for row in rows {
                let (id, record) = row?;
                let record: Value = serde_json::from_str(&record)?;
                if record["sourceRoot"]
                    .as_str()
                    .is_some_and(|root| paths.iter().any(|path| path == Path::new(root)))
                {
                    ids.push(id);
                }
            }
            ids
        };
        for id in ids {
            let record = self.refresh_process_record(&id)?.ok_or_else(|| {
                KernelError::Authorization("Native workspace process receipt is missing".into())
            })?;
            if record["writerActive"] != false
                || !matches!(
                    record["status"].as_str(),
                    Some("exited" | "failed" | "released")
                )
            {
                return Err(KernelError::Execution(
                    varin_runtime::execution::ExecutionError::new(
                        "workspace_in_use",
                        "A process has not confirmed its stop on this native mount",
                    ),
                ));
            }
        }
        Ok(())
    }
    pub(crate) fn native_handoff(
        &mut self,
        task: &crate::workspace_handoffs::Task,
        root: Option<Value>,
    ) -> Result<Option<Value>, KernelError> {
        let grant = self.load_grant(&task.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != task.grant.kernel_epoch
            || task.cancellation.load(Ordering::Acquire)
        {
            return Err(KernelError::Cancelled);
        }
        if !grant.path_scopes.iter().any(String::is_empty)
            || grant.owning_workspace.as_deref() != Some(&task.source.workspace_id)
            || task.source.resource_owner != task.binding.resource_owner
        {
            return Err(KernelError::Authorization(
                "Native handoff requires the original source owner and whole-source read authority"
                    .into(),
            ));
        }
        require_capability(&grant, "branch.read")?;
        let selected = task
            .delegation
            .agent_source
            .as_ref()
            .map(|stage| Ok(stage.source.clone()))
            .unwrap_or_else(|| task.binding.source_selection())?;
        if selected != task.source
            || (task.delegation.process
                && (task.delegation.work_mode
                    == varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly
                    || (!task.delegation.configured_preset
                        && !grant.capabilities.contains("process"))))
        {
            return Err(KernelError::Authorization(
                "Native handoff differs from the frozen source or process delegation".into(),
            ));
        }
        let operation = format!("child-source-handoff:{}", task.context.operation_id);
        let original = self.operation_get(&json!({"operationId":operation}))?;
        let identity = json!({"operationId":operation,"workspaceId":task.source.workspace_id,"source":task.source,
            "parentRunId":task.context.run_id,"parentThreadId":task.binding.thread_id,"childThreadId":format!("thread:child:{}",task.context.operation_id),"delegation":task.delegation});
        let identity_hash = hash_json(&identity)?;
        if !original.is_null() {
            if original["kind"] != "source.handoff" || original["paramsHash"] != identity_hash {
                return Err(KernelError::Authorization(
                    "Native handoff differs from the original source boundary".into(),
                ));
            }
            if original["state"] == "committed" {
                return Ok(Some(original["result"].clone()));
            }
            if original["state"] != "started" {
                return Err(KernelError::Operation(
                    "Original native source preparation failed; its private boundary was reclaimed"
                        .into(),
                ));
            }
        } else {
            self.filesystem_transaction(|s|{
                s.operation_begin(&operation,"source.handoff",&identity_hash)?;
                s.record_operation_workspace(&operation,Some(&task.source.workspace_id))?;
                s.conn.execute("UPDATE operations SET result_json=?2 WHERE operation_id=?1",params![operation,json!({"nativePreparation":true,"source":task.source,"privateBranch":format!("native-handoff:{}",task.context.operation_id)}).to_string()])?;
                Ok(())
            })?;
        }
        let Some(root) = root else {
            return Ok(None);
        };
        let mut result = json!({"operation_id":operation,"source":task.source,"root":root,
            "resource_authority":task.binding.target_authority.as_ref().map(|authority|json!({"authority_id":authority.authority_id,"resource_epoch":authority.resource_epoch}))});
        if let Some(path) = &task.delegation.source_path {
            result["source_path"] = json!(path);
        }
        if let Some(stage) = &task.delegation.agent_source {
            result["source_run_id"] = json!(stage.run_id);
        }
        self.operation_finish(&operation, &result)?;
        Ok(Some(result))
    }
    pub(crate) fn discard_native_handoff(&mut self, operation: &str) -> Result<(), KernelError> {
        let original = self.operation_get(&json!({"operationId":operation}))?;
        if original["kind"] != "source.handoff"
            || original["state"] != "started"
            || original["result"]["nativePreparation"] != true
        {
            return Ok(());
        }
        let dispatch = operation
            .strip_prefix("child-source-handoff:")
            .ok_or_else(|| {
                KernelError::Storage("Native handoff operation identity is invalid".into())
            })?;
        let branch = format!("native-handoff:{dispatch}");
        if original["result"]["privateBranch"] != branch {
            return Err(KernelError::Storage(
                "Native handoff private branch identity changed".into(),
            ));
        }
        self.filesystem_transaction(|s| {
            s.conn.execute(
                "DELETE FROM pins WHERE pin_id=?1 AND branch_id=?2",
                params![format!("child-pin:{dispatch}"), branch],
            )?;
            s.branch_delete(&json!({"branchId":branch}))?;
            s.operation_failed(
                operation,
                &KernelError::Operation(
                    "Native source preparation did not commit; its private boundary was reclaimed"
                        .into(),
                ),
            )
        })
    }
    pub(super) fn recover_native_handoffs(&mut self) -> Result<(), KernelError> {
        let pending = {
            let mut statement=self.conn.prepare("SELECT operation_id FROM operations WHERE kind='source.handoff' AND state='started'")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for operation in pending {
            self.discard_native_handoff(&operation)?;
        }
        Ok(())
    }
    pub(crate) fn register_native_file_root(
        &mut self,
        branch: &str,
        generation: &str,
        canonical: PathBuf,
        scope: &str,
        grant: &Grant,
    ) -> Result<String, KernelError> {
        self.admit_workspace_session(branch, scope, grant, false)?;
        let session = self
            .workspace_sessions
            .get(branch)
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| {
                KernelError::Authorization("Native source session is unavailable".into())
            })?;
        if session.identity().to_string() != generation {
            return Err(KernelError::Authorization(
                "Native source mount generation changed".into(),
            ));
        }
        session.check_mounted()?;
        let workspace = grant
            .owning_workspace
            .as_ref()
            .ok_or_else(|| KernelError::Authorization("Native source workspace missing".into()))?;
        let execution = grant.execution_workspace.as_ref().unwrap_or(workspace);
        let id = root_id(workspace, execution, branch, scope);
        self.file_roots.insert(
            id.clone(),
            FileRoot {
                root_id: id.clone(),
                owning_workspace_id: workspace.clone(),
                execution_workspace_id: execution.clone(),
                canonical_root: canonical,
                native: Some(NativeFileRoot {
                    session: Arc::downgrade(&session),
                    scope: scope.into(),
                }),
            },
        );
        self.native_file_roots
            .insert(id.clone(), (branch.into(), generation.into(), scope.into()));
        Ok(id)
    }
    pub(crate) fn retain_native_root(
        &mut self,
        id: &str,
        grant: &Grant,
    ) -> Result<(), KernelError> {
        self.admitted_file_root(id, grant)?;
        if let Some((branch, generation, _)) = self.native_file_roots.get(id) {
            let session = self
                .workspace_sessions
                .get(branch)
                .and_then(std::sync::Weak::upgrade)
                .ok_or_else(|| KernelError::Authorization("Native source session closed".into()))?;
            if session.identity().to_string() != *generation {
                return Err(KernelError::Authorization(
                    "Native source generation changed".into(),
                ));
            }
            if session.owned_by(&grant.grant_id) {
                return Ok(());
            }
            self.workspace_holders.insert(
                format!("native-source:{}:{branch}", grant.grant_id),
                (branch.clone(), grant.grant_id.clone()),
            );
        }
        Ok(())
    }
    pub(crate) fn validate_native_tool_binding(
        &self,
        binding: &ToolBinding,
    ) -> Result<(), KernelError> {
        let grant = &self.load_grant(&binding.grant_id)?;
        if binding.source_mode != varin_runtime::SourceMode::NativeWorkspace {
            return Ok(());
        }
        let native = binding
            .native_workspace
            .as_ref()
            .ok_or_else(|| KernelError::Authorization("Native source binding is missing".into()))?;
        let id = root_id(
            &binding.workspace_id,
            &binding.execution_workspace_id,
            &native.branch_id,
            native.source_path.as_deref().unwrap_or(""),
        );
        let root = self.admitted_file_root(&id, grant)?;
        if binding.root_id.as_deref() != Some(&id)
            || self
                .native_file_roots
                .get(&id)
                .is_none_or(|(branch, generation, scope)| {
                    Some(scope.as_str()) != Some(native.source_path.as_deref().unwrap_or(""))
                        || branch != &native.branch_id
                        || Some(generation.as_str()) != native.generation.as_deref()
                })
            || !self
                .workspace_holders
                .values()
                .any(|(branch, owner)| branch == &native.branch_id && owner == &grant.grant_id)
            || binding.live_root.as_ref().is_none_or(|live| {
                live.root_id != id || Path::new(&live.canonical_root) != root.canonical_root
            })
        {
            return Err(KernelError::Authorization(
                "Native source differs from its original mount lease".into(),
            ));
        }
        self.admit_workspace_session(
            &native.branch_id,
            native.source_path.as_deref().unwrap_or(""),
            grant,
            false,
        )
    }
}
