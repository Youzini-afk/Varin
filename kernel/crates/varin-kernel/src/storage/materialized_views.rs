//! Derived physical views of immutable roots. The language supervisor owns its Run
//! references; Storage owns only this physical resource, its original tree and cleanup.
use super::file_resources::{materialize_side_path, parse_file_params};
use super::materialization::{directory_identity, Admission, DirectoryIdentity};
use super::*;
use crate::protocol_generated::{
    KernelMaterializedViewParams, KernelMaterializedViewPrepareParams,
};

const RECORD_TYPE: &str = "file.materialized-view";
fn unavailable(message: &str) -> KernelError {
    KernelError::Operation(message.into())
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, KernelError> {
    value[name]
        .as_str()
        .ok_or_else(|| KernelError::Storage(format!("materialized view omitted {name}")))
}
fn record_id(view: &str) -> String {
    format!("materialized-view:{view}")
}

#[derive(Clone)]
pub(crate) struct CleanupTask {
    pub(crate) workspace_id: String,
    pub(crate) view_id: String,
    operation_id: String,
    lease_id: String,
    paths: Vec<(PathBuf, DirectoryIdentity)>,
}
impl CleanupTask {
    pub(crate) fn run(&self) -> Result<(), KernelError> {
        for (path, identity) in &self.paths {
            match directory_identity(path)? {
                None => continue,
                Some(current) if &current == identity => {}
                _ => {
                    return Err(unavailable(
                        "Derived view cleanup directory changed; the directory was preserved",
                    ))
                }
            }
            // The directory is owned by its materialization identity and is
            // protected by the original retained physical lease until completion.
            fs::remove_dir_all(path)?;
            if let Some(parent) = path.parent() {
                sync_directory(parent)?;
            }
        }
        Ok(())
    }
}
impl Storage {
    fn materialized_view_record(
        &self,
        workspace: &str,
        view: &str,
    ) -> Result<Option<Value>, KernelError> {
        self.require_native_record_owner(workspace, &record_id(view))?;
        self.conn.query_row("SELECT payload_json FROM domain_records WHERE workspace_id=?1 AND record_id=?2 AND record_type=?3",
            params![workspace,record_id(view),RECORD_TYPE], |row| row.get::<_,String>(0)).optional()?
            .map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
    }
    fn save_materialized_view_record(&self, record: &Value) -> Result<(), KernelError> {
        self.require_native_record_owner(field(record, "workspaceId")?, &record_id(field(record, "viewId")?))?;
        self.conn.execute("INSERT INTO domain_records(record_id,workspace_id,record_type,state,record_revision,payload_json,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?6,?6) ON CONFLICT(workspace_id,record_id) DO UPDATE SET state=excluded.state,record_revision=domain_records.record_revision+1,payload_json=excluded.payload_json,updated_at=excluded.updated_at",
            params![record_id(field(record,"viewId")?),field(record,"workspaceId")?,RECORD_TYPE,field(record,"state")?,serde_json::to_string(record)?,now_ms()])?;
        Ok(())
    }
    fn view_descriptor(&self, record: &Value) -> Value {
        json!({"viewId":record["viewId"],"branchId":record["branchId"],"revision":record["revision"],
            "sourceRoot":record["sourceRoot"],"canonicalRoot":self.root.join(record["path"].as_str().unwrap_or("")),"kernelEpoch":record["kernelEpoch"]})
    }
    fn view_container(
        &mut self,
        workspace: &str,
        execution: &str,
        grant: &Grant,
    ) -> Result<String, KernelError> {
        let result = self.file_root_register(&json!({"workspaceId":workspace,"executionWorkspaceId":execution,"canonicalRoot":self.root}),grant)?;
        Ok(field(&result, "rootId")?.into())
    }
    pub(crate) fn prepare_materialized_view(
        &mut self,
        value: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Admission, KernelError> {
        let params: KernelMaterializedViewPrepareParams = parse_file_params(value)?;
        if params.view_id.is_empty()
            || params.revision < 0
            || !grant.path_scopes.iter().any(String::is_empty)
            || grant
                .execution_workspace
                .as_deref()
                .or(grant.owning_workspace.as_deref())
                != Some(&params.execution_workspace_id)
        {
            return Err(KernelError::Authorization(
                "Derived language view requires its original complete source environment".into(),
            ));
        }
        let branch = self.branch_read(
            &json!({"branchId":params.branch_id,"revision":params.revision,"includeEntries":false}),
        )?;
        if branch["workspaceId"] != params.workspace_id || branch["view"] != "revision" {
            return Err(KernelError::Authorization(
                "Derived language view source changed".into(),
            ));
        }
        let container =
            self.view_container(&params.workspace_id, &params.execution_workspace_id, grant)?;
        let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([
            grant.kernel_epoch,
            params.workspace_id,
            params.execution_workspace_id,
            params.view_id
        ]))?));
        let record = if let Some(record) =
            self.materialized_view_record(&params.workspace_id, &params.view_id)?
        {
            if record["branchId"] != params.branch_id
                || record["revision"] != params.revision
                || record["sourceRoot"] != branch["root"]
                || record["executionWorkspaceId"] != params.execution_workspace_id
                || record["kernelEpoch"] != grant.kernel_epoch
                || record["ownerGrantId"] != grant.grant_id
                || record["state"] == "releasing"
            {
                return Err(KernelError::Authorization(
                    "Derived view identity was reused or is retiring".into(),
                ));
            }
            if record["state"] == "ready" {
                return self
                    .check_materialized_view(
                        &json!({"workspaceId":params.workspace_id,"viewId":params.view_id}),
                        grant,
                    )
                    .map(Admission::Complete);
            }
            record
        } else {
            let record = json!({"viewId":params.view_id,"workspaceId":params.workspace_id,"executionWorkspaceId":params.execution_workspace_id,
                "branchId":params.branch_id,"revision":params.revision,"sourceRoot":branch["root"],"kernelEpoch":grant.kernel_epoch,
                "ownerGrantId":grant.grant_id,"operationId":format!("materialized-view:{key}"),"rootId":container,
                "path":format!("managed/language-views/{key}"),"state":"preparing"});
            self.save_materialized_view_record(&record)?;
            record
        };
        self.prepare_materialization(&json!({"workspaceId":params.workspace_id,"rootId":container,"operationId":record["operationId"],"path":record["path"],"sourceRoot":record["sourceRoot"]}),grant,cancellation)
    }
    pub(crate) fn finish_materialized_view(
        &mut self,
        value: &Value,
        grant: &Grant,
        result: Value,
    ) -> Result<Value, KernelError> {
        let params: KernelMaterializedViewPrepareParams = parse_file_params(value)?;
        let mut record = self
            .materialized_view_record(&params.workspace_id, &params.view_id)?
            .ok_or_else(|| unavailable("Derived source view was released during preparation"))?;
        // A ready fast path returns the actual checked descriptor, not a materialization receipt.
        if record["state"] == "ready" {
            return self.check_materialized_view(
                &json!({"workspaceId":params.workspace_id,"viewId":params.view_id}),
                grant,
            );
        }
        if result["status"] != "materialized" || result["root"] != record["sourceRoot"] {
            return Err(unavailable("Derived source view materialization requires reconciliation; the source was preserved"));
        }
        let identity: DirectoryIdentity =
            serde_json::from_value(result["directoryIdentity"].clone())?;
        let target = self.root.join(field(&record, "path")?);
        if directory_identity(&target)?.as_ref() != Some(&identity) {
            return Err(unavailable(
                "Derived source view directory changed during preparation",
            ));
        }
        record["directoryIdentity"] = serde_json::to_value(identity)?;
        record["state"] = json!("ready");
        self.save_materialized_view_record(&record)?;
        self.check_materialized_view(
            &json!({"workspaceId":params.workspace_id,"viewId":params.view_id}),
            grant,
        )
    }
    pub(crate) fn check_materialized_view(
        &self,
        value: &Value,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let params: KernelMaterializedViewParams = parse_file_params(value)?;
        let record = self
            .materialized_view_record(&params.workspace_id, &params.view_id)?
            .ok_or_else(|| {
                unavailable("Derived source view is unavailable; retry the language query")
            })?;
        if record["executionWorkspaceId"]
            != json!(grant
                .execution_workspace
                .as_deref()
                .or(grant.owning_workspace.as_deref()))
            || !grant.path_scopes.iter().any(String::is_empty)
        {
            return Err(KernelError::Authorization(
                "Derived source view belongs to another environment".into(),
            ));
        }
        if record["state"] != "ready" || record["kernelEpoch"] != grant.kernel_epoch {
            return Err(unavailable(
                "Derived source view generation is unavailable; retry the language query",
            ));
        }
        let expected: DirectoryIdentity =
            serde_json::from_value(record["directoryIdentity"].clone())?;
        if directory_identity(&self.root.join(field(&record, "path")?))?.as_ref() != Some(&expected)
        {
            return Err(unavailable(
                "Derived source view directory changed; retry after the old language process stops",
            ));
        }
        Ok(self.view_descriptor(&record))
    }
    pub(crate) fn prepare_materialized_view_release(
        &mut self,
        value: &Value,
        grant: &Grant,
    ) -> Result<Option<CleanupTask>, KernelError> {
        let params: KernelMaterializedViewParams = parse_file_params(value)?;
        let lease_id = format!("materialized-view-cleanup:{}", params.view_id);
        let already_active = self.file_leases.contains_key(&lease_id);
        let result = self.prepare_materialized_view_release_inner(value, grant);
        if let Err(error) = &result {
            if !already_active {
                self.finish_retained_file_lease(&lease_id);
            }
            if let Some(mut record) =
                self.materialized_view_record(&params.workspace_id, &params.view_id)?
            {
                record["cleanupRequested"] = json!(true);
                record["cleanupError"] = json!(error.to_string());
                self.save_materialized_view_record(&record)?;
            }
        }
        result
    }
    fn prepare_materialized_view_release_inner(
        &mut self,
        value: &Value,
        grant: &Grant,
    ) -> Result<Option<CleanupTask>, KernelError> {
        let params: KernelMaterializedViewParams = parse_file_params(value)?;
        let Some(mut record) =
            self.materialized_view_record(&params.workspace_id, &params.view_id)?
        else {
            return Ok(None);
        };
        if record["ownerGrantId"] != grant.grant_id && record["kernelEpoch"] == grant.kernel_epoch {
            return Err(KernelError::Authorization(
                "Derived view release belongs to its original service owner".into(),
            ));
        }
        let operation_id = field(&record, "operationId")?.to_string();
        if self.materializations.contains_key(&operation_id) {
            return Err(unavailable(
                "Derived source view preparation has not stopped",
            ));
        }
        let root_id = self.view_container(
            &params.workspace_id,
            field(&record, "executionWorkspaceId")?,
            grant,
        )?;
        let path = field(&record, "path")?.to_string();
        let mut paths = Vec::<(String, DirectoryIdentity)>::new();
        if record["state"] == "releasing" {
            paths = serde_json::from_value(record["cleanupPaths"].clone())?;
        } else {
            let operation = self.operation_get(&json!({"operationId":operation_id}))?;
            let journal = &operation["result"];
            let identity = record
                .get("directoryIdentity")
                .filter(|v| !v.is_null())
                .or_else(|| journal.get("directoryIdentity"))
                .or_else(|| journal.get("materializationStage"));
            for (candidate, expected) in [
                (path.clone(), identity),
                (
                    materialize_side_path(&path, &operation_id, "staging"),
                    journal.get("materializationStage"),
                ),
                (
                    materialize_side_path(&path, &operation_id, "backup"),
                    journal.get("materializationOriginal"),
                ),
            ] {
                if let Some(current) = directory_identity(&self.root.join(&candidate))? {
                    let expected = expected
                        .cloned()
                        .map(serde_json::from_value::<DirectoryIdentity>)
                        .transpose()?;
                    if expected.as_ref() != Some(&current) {
                        return Err(unavailable("Derived view directory was replaced; cleanup preserved the unowned directory"));
                    }
                    paths.push((candidate, current));
                }
            }
        }
        for (path, _) in &paths {
            self.assert_process_directory_idle(&self.root.join(path))?;
        }
        // Check the original target even after it disappeared: a native writer's
        // recorded cwd remains authoritative until actual guardian stop.
        self.assert_process_directory_idle(&self.root.join(&path))?;
        let lease_id = format!("materialized-view-cleanup:{}", params.view_id);
        if self.file_leases.contains_key(&lease_id) {
            return Err(unavailable("Derived view cleanup is already active"));
        }
        let resources = paths
            .iter()
            .map(|(path, _)| FileLeaseResource {
                path: path.clone(),
                subtree: true,
            })
            .collect::<Vec<_>>();
        if !resources.is_empty() {
            self.assert_file_lease(grant, &root_id, &resources, None)?;
        }
        let canonical_resources = self.canonical_lease_resources(&root_id, &resources, grant)?;
        self.file_leases.insert(
            lease_id.clone(),
            FileLease {
                lease_id: lease_id.clone(),
                root_id,
                workspace_id: params.workspace_id.clone(),
                grant_id: grant.grant_id.clone(),
                resources,
                canonical_resources,
            },
        );
        self.retained_file_leases.insert(
            lease_id.clone(),
            super::file_resource_leases::RetainedFileLease {
                release_requested: true,
            },
        );
        record["state"] = json!("releasing");
        record["cleanupRequested"] = json!(true);
        record
            .as_object_mut()
            .expect("view record")
            .remove("cleanupError");
        record["cleanupPaths"] = serde_json::to_value(&paths)?;
        self.save_materialized_view_record(&record)?;
        Ok(Some(CleanupTask {
            workspace_id: params.workspace_id,
            view_id: params.view_id,
            operation_id,
            lease_id,
            paths: paths
                .into_iter()
                .map(|(path, id)| (self.root.join(path), id))
                .collect(),
        }))
    }
    pub(crate) fn finish_materialized_view_release(
        &mut self,
        task: &CleanupTask,
        result: Result<(), KernelError>,
    ) -> Result<Value, KernelError> {
        self.finish_retained_file_lease(&task.lease_id);
        if let Err(error) = result {
            if let Some(mut record) =
                self.materialized_view_record(&task.workspace_id, &task.view_id)?
            {
                record["cleanupError"] = json!(error.to_string());
                self.save_materialized_view_record(&record)?;
            }
            return Err(error);
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let removed = (|| {
            self.conn.execute("DELETE FROM domain_records WHERE workspace_id=?1 AND record_id=?2 AND record_type=?3",params![task.workspace_id,record_id(&task.view_id),RECORD_TYPE])?;
            self.conn.execute(
                "DELETE FROM operations WHERE operation_id=?1",
                [&task.operation_id],
            )?;
            self.conn.execute(
                "DELETE FROM operation_owners WHERE operation_id=?1",
                [&task.operation_id],
            )?;
            Ok::<_, KernelError>(())
        })();
        if let Err(error) = removed {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(error);
        }
        self.conn.execute_batch("COMMIT")?;
        Ok(json!({"viewId":task.view_id,"released":true}))
    }
    /// Old Host references cannot resurrect. Their physical writers still can
    /// delay cleanup, so the normal GC worker retries only proved-idle resources.
    pub(crate) fn obsolete_materialized_views(
        &self,
        epoch: &str,
    ) -> Result<Vec<(Value, Grant)>, KernelError> {
        let mut records = self
            .conn
            .prepare("SELECT payload_json FROM domain_records WHERE record_type=?1")?;
        let rows = records
            .query_map([RECORD_TYPE], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut result = Vec::new();
        for raw in rows {
            let record: Value = serde_json::from_str(&raw)?;
            let grant = self.load_grant(field(&record, "ownerGrantId")?)?;
            if record["kernelEpoch"] != epoch
                || grant.state != crate::model::GrantState::Active
                || record["cleanupRequested"] == true
            {
                result.push((
                    json!({"workspaceId":record["workspaceId"],"viewId":record["viewId"]}),
                    grant,
                ));
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn actor(storage: &mut Storage, id: &str, epoch: &str) -> Grant {
        let root = storage.root.to_string_lossy().into_owned();
        storage.issue_grant(&json!({"grantId":id,"hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace",
            "capabilities":["storage.read","storage.write","storage.maintenance","storage.gc"],"pathScopes":[""]}),"host","generation",&root,epoch).unwrap();
        storage.load_grant(id).unwrap()
    }
    fn invoke(storage: &mut Storage, grant: &Grant, method: &str, value: Value) -> Value {
        let (grant, value) = storage
            .authorize(
                Some(&grant.grant_id),
                &grant.kernel_epoch,
                "host",
                "generation",
                method,
                &value,
            )
            .unwrap();
        storage
            .dispatch(method, &value, Some(&grant.grant_id), &grant)
            .unwrap()
    }
    fn fixture() -> (Storage, Grant, PathBuf, Value, String) {
        let root =
            std::env::temp_dir().join(format!("varin-fixed-language-view-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&root, "host").unwrap();
        let grant = actor(&mut storage, "service", "old-epoch");
        let bytes = b"export const fixed = 1;\n";
        invoke(
            &mut storage,
            &grant,
            "storage.putBlob.begin",
            json!({"operationId":"blob","streamId":"body","workspaceId":"workspace","byteLength":bytes.len()}),
        );
        invoke(
            &mut storage,
            &grant,
            "storage.putBlob.chunk",
            json!({"streamId":"body","sequence":0,"bytesBase64":BASE64.encode(bytes)}),
        );
        let blob = invoke(
            &mut storage,
            &grant,
            "storage.putBlob.finish",
            json!({"operationId":"blob","streamId":"body","workspaceId":"workspace"}),
        );
        invoke(
            &mut storage,
            &grant,
            "branch.create.begin",
            json!({"operationId":"branch","builderId":"branch","workspaceId":"workspace","branchId":"source","draftBasePaths":[],"captureScopes":[]}),
        );
        invoke(
            &mut storage,
            &grant,
            "branch.create.append",
            json!({"builderId":"branch","sequence":0,"entries":[{"path":"main.ts","state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":bytes.len(),"mode":420},"ownerId":blob["ownerId"]}]}),
        );
        invoke(
            &mut storage,
            &grant,
            "branch.create.finish",
            json!({"operationId":"branch","builderId":"branch"}),
        );
        let params = json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","branchId":"source","revision":0,"viewId":"view-one"});
        (
            storage,
            grant,
            root,
            params,
            blob["hash"].as_str().unwrap().into(),
        )
    }
    fn prepare(storage: &mut Storage, grant: &Grant, params: &Value) -> Value {
        let materialized = match storage
            .prepare_materialized_view(params, grant, Arc::new(AtomicBool::new(false)))
            .unwrap()
        {
            Admission::Complete(result) => result,
            Admission::Work(task) => {
                let result = task
                    .run(|control| {
                        storage.control_materialization(
                            &task.operation_id,
                            &task.job_id,
                            control,
                            false,
                        )
                    })
                    .unwrap();
                storage.finish_materialization(&task.operation_id, &task.job_id);
                result
            }
        };
        storage
            .finish_materialized_view(params, grant, materialized)
            .unwrap()
    }
    fn address() -> Value {
        json!({"workspaceId":"workspace","viewId":"view-one"})
    }
    fn release(storage: &mut Storage, grant: &Grant) {
        if let Some(task) = storage
            .prepare_materialized_view_release(&address(), grant)
            .unwrap()
        {
            let result = task.run();
            storage
                .finish_materialized_view_release(&task, result)
                .unwrap();
        }
    }
    #[test]
    fn materialized_view_reuses_original_tree_and_refuses_replaced_directory() {
        let (mut storage, grant, root, params, _) = fixture();
        let view = prepare(&mut storage, &grant, &params);
        let target = PathBuf::from(view["canonicalRoot"].as_str().unwrap());
        assert_eq!(
            fs::read_to_string(target.join("main.ts")).unwrap(),
            "export const fixed = 1;\n"
        );
        assert_eq!(prepare(&mut storage, &grant, &params), view);
        let moved = root.join("original-view");
        fs::rename(&target, &moved).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("unowned"), b"keep").unwrap();
        assert!(storage.check_materialized_view(&address(), &grant).is_err());
        assert!(storage
            .prepare_materialized_view_release(&address(), &grant)
            .is_err());
        assert_eq!(fs::read(target.join("unowned")).unwrap(), b"keep");
        assert!(storage
            .cleanup_status()
            .unwrap()
            .1
            .iter()
            .any(|error| error.contains("replaced")));
        fs::remove_dir_all(&target).unwrap();
        fs::rename(moved, &target).unwrap();
        release(&mut storage, &grant);
        assert!(!target.exists());
        assert!(storage
            .materialized_view_record("workspace", "view-one")
            .unwrap()
            .is_none());
        assert!(storage.file_leases.is_empty());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_keeps_materialization_lease_until_worker_stops_and_cleans_its_partial_stage() {
        let (mut storage, grant, root, params, hash) = fixture();
        let cancel = Arc::new(AtomicBool::new(false));
        let Admission::Work(task) = storage
            .prepare_materialized_view(&params, &grant, cancel.clone())
            .unwrap()
        else {
            panic!("new view")
        };
        assert!(storage
            .prepare_materialized_view_release(&address(), &grant)
            .is_err());
        let result = task.run(|control| {
            let staging = matches!(
                &control,
                super::super::materialization::Control::CreateStage
            );
            let result =
                storage.control_materialization(&task.operation_id, &task.job_id, control, false);
            if staging {
                cancel.store(true, Ordering::Release);
            }
            result
        });
        assert!(result.is_err());
        assert!(!storage.file_leases.is_empty());
        storage.finish_materialization(&task.operation_id, &task.job_id);
        invoke(
            &mut storage,
            &grant,
            "branch.delete",
            json!({"operationId":"delete-source","branchId":"source"}),
        );
        storage.gc().unwrap();
        assert!(object_path(&root, &hash).unwrap().exists());
        release(&mut storage, &grant);
        assert!(storage.file_leases.is_empty());
        storage.gc().unwrap();
        storage.drain_gc_files().unwrap();
        assert!(!object_path(&root, &hash).unwrap().exists());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
    // On Unix a missing exit receipt keeps the prior tree unknown. On Windows,
    // absence of the original native Job already supplies actual stop evidence.
    #[cfg(unix)]
    #[test]
    fn reopening_retains_old_unknown_writer_and_reclaims_only_after_original_stop_evidence() {
        let (mut storage, grant, root, params, hash) = fixture();
        let view = prepare(&mut storage, &grant, &params);
        let target = PathBuf::from(view["canonicalRoot"].as_str().unwrap());
        let status = json!({"processId":"prior-writer","kernelEpoch":"old-epoch","workspaceId":"workspace","cwd":target,"status":"unknown","writerActive":true,"outputAvailable":false});
        storage.conn.execute("INSERT INTO process_records(process_id,workspace_id,execution_workspace_id,grant_id,kernel_epoch,cwd,job_name,params_hash,status_json) VALUES('prior-writer','workspace','workspace','service','old-epoch',?1,'job','params',?2)",params![target.to_string_lossy(),serde_json::to_string(&status).unwrap()]).unwrap();
        invoke(
            &mut storage,
            &grant,
            "branch.delete",
            json!({"operationId":"delete-source","branchId":"source"}),
        );
        storage
            .revoke_grant(&json!({"grantId":"service"}), "host")
            .unwrap();
        drop(storage);
        let mut storage = Storage::open(&root, "host").unwrap();
        let current = actor(&mut storage, "new-service", "new-epoch");
        assert!(storage
            .check_materialized_view(&address(), &current)
            .is_err());
        let obsolete = storage.obsolete_materialized_views("new-epoch").unwrap();
        assert_eq!(obsolete.len(), 1);
        assert!(storage
            .prepare_materialized_view_release(&obsolete[0].0, &obsolete[0].1)
            .is_err());
        storage.gc().unwrap();
        storage.drain_gc_files().unwrap();
        assert!(target.exists());
        assert!(object_path(&root, &hash).unwrap().exists());
        // The original native process record receives the guardian-confirmed stop
        // fact. No revoke/retire acknowledgement is substituted for that evidence.
        let mut stopped = status;
        stopped["writerActive"] = json!(false);
        stopped["status"] = json!("exited");
        storage
            .conn
            .execute(
                "UPDATE process_records SET status_json=?1 WHERE process_id='prior-writer'",
                [serde_json::to_string(&stopped).unwrap()],
            )
            .unwrap();
        release(&mut storage, &current);
        storage.gc().unwrap();
        storage.drain_gc_files().unwrap();
        assert!(!target.exists());
        assert!(!object_path(&root, &hash).unwrap().exists());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
