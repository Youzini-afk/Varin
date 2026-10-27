//! Conditional filesystem effects retain the original operation and lease.
//! Workers do path/body I/O; every admission and durable receipt returns to the
//! same Storage owner. Local owner fixtures drive these identical stages.
use super::file_resource_leases::{canonical_lease_path, FileLeaseRequest, RetainedFileLease};
use super::file_resources::{
    file_params_value, normalized_relative_path, parse_file_params, resolve_admitted_resource,
    FileState, ResolvedFileResource,
};
use super::*;
use crate::model::CanonicalFileLeaseResource;
use crate::protocol_generated::{
    KernelFileApplyParams, KernelFileLeaseAcquireParams, KernelFileMkdirParams,
    KernelFileRemoveParams, KernelFileRenameParams,
};

#[derive(Clone)]
pub(crate) struct Task {
    pub params: Value,
    pub cancellation: Arc<AtomicBool>,
    pub(super) method: &'static str,
    pub(super) access_method: &'static str,
    pub(super) root: FileRoot,
    pub(super) grant: Grant,
    storage_root: PathBuf,
    resources: Vec<FileLeaseResource>,
    pub(super) lease_id: String,
    private_lease: bool,
}
struct Plan {
    ready: Option<Value>,
    resuming: bool,
    _content: Option<blob_reads::BlobReadRetention>,
    reservations: Option<Vec<Value>>,
}
pub(super) trait Control {
    fn call<T: Send + 'static>(
        &mut self,
        action: impl FnOnce(&mut Storage) -> Result<T, KernelError> + Send + 'static,
    ) -> Result<T, KernelError>;
}
pub(super) struct Local<'a>(pub(super) &'a mut Storage);
impl Control for Local<'_> {
    fn call<T: Send + 'static>(
        &mut self,
        action: impl FnOnce(&mut Storage) -> Result<T, KernelError> + Send + 'static,
    ) -> Result<T, KernelError> {
        action(self.0)
    }
}
impl Control for workspace_session::StoragePort {
    fn call<T: Send + 'static>(
        &mut self,
        action: impl FnOnce(&mut Storage) -> Result<T, KernelError> + Send + 'static,
    ) -> Result<T, KernelError> {
        workspace_session::StoragePort::call(self, action)
    }
}
impl Task {
    pub(super) fn operation(&self) -> &str {
        self.params["operationId"]
            .as_str()
            .expect("validated file operation")
    }
    fn workspace(&self) -> &str {
        &self.root.owning_workspace_id
    }
    pub(super) fn check(&self) -> Result<(), KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    }
    pub(super) fn resolve(&self, field: &str) -> Result<ResolvedFileResource, KernelError> {
        resolve_admitted_resource(
            &self.root,
            self.params[field].as_str().expect("validated file path"),
            &self.grant,
            false,
        )
    }
    pub(super) fn canonical(&self) -> Result<Vec<CanonicalFileLeaseResource>, KernelError> {
        self.resources
            .iter()
            .map(|resource| {
                self.check()?;
                let path =
                    resolve_admitted_resource(&self.root, &resource.path, &self.grant, false)?;
                Ok(CanonicalFileLeaseResource {
                    absolute: canonical_lease_path(path.absolute)?,
                    subtree: resource.subtree,
                })
            })
            .collect()
    }
    pub(crate) fn run(
        &self,
        mut port: workspace_session::StoragePort,
    ) -> Result<Value, KernelError> {
        self.run_with(&mut port, false)
    }
    pub(super) fn run_local(&self, storage: &mut Storage) -> Result<Value, KernelError> {
        self.run_with(&mut Local(storage), false)
    }
    pub(super) fn run_borrowed(&self, owner: &mut impl Control) -> Result<Value, KernelError> {
        self.run_with(owner, true)
    }
    pub(super) fn run_control(&self, owner: &mut impl Control) -> Result<Value, KernelError> {
        self.run_with(owner, false)
    }
    fn run_with(&self, owner: &mut impl Control, borrowed: bool) -> Result<Value, KernelError> {
        let mut retained = false;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.check()?;
            let canonical = self.canonical()?;
            let (task, proof) = (self.clone(), canonical.clone());
            owner.call(move |s| s.retain_file_effect(&task, &proof, borrowed))?;
            retained = true;
            if self.canonical()? != canonical {
                return Err(KernelError::Authorization(
                    "File resource changed during effect admission".into(),
                ));
            }
            let physical = self
                .resources
                .iter()
                .map(|resource| {
                    resolve_admitted_resource(&self.root, &resource.path, &self.grant, false)
                        .map(|resolved| resolved.absolute)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let task = self.clone();
            let plan = owner.call(move |s| s.begin_file_effect(&task, &physical))?;
            if let Some(value) = plan.ready {
                return Ok(value);
            }
            let mut observations = Vec::new();
            if matches!(self.method, "file.apply" | "file.rename") {
                for field in if self.method == "file.rename" {
                    &["fromPath", "toPath"][..]
                } else {
                    &["path"][..]
                } {
                    observations.push(super::capture_resources::observe_effect(
                        &self.root,
                        self.params[*field].as_str().expect("validated effect path"),
                        &self.grant,
                        &self.cancellation,
                    )?);
                }
            }
            if self.canonical()? != canonical {
                return Err(KernelError::Authorization(
                    "File resource changed while observing its original state".into(),
                ));
            }
            let (task, before, resuming) = (self.clone(), observations, plan.resuming);
            if let Some(value) =
                owner.call(move |s| s.decide_file_effect(&task, &before, resuming))?
            {
                return Ok(value);
            }
            if let Some(reservations) = &plan.reservations {
                if !super::recovery::resolve_reservation_conflicts(reservations, &canonical)?
                    .is_empty()
                {
                    return Err(KernelError::Operation(
                        "affected resource has an unfinished Integration".into(),
                    ));
                }
                let (task, expected) = (self.clone(), reservations.clone());
                owner.call(move |s| {
                    s.validate_file_effect(&task)?;
                    if s.recovery_file_reservations(
                        task.workspace(),
                        task.params["reservationOperationId"].as_str(),
                    )? != expected
                    {
                        return Err(KernelError::Operation(
                            "Integration reservations changed before the file effect".into(),
                        ));
                    }
                    Ok(())
                })?;
            }
            self.check()?;
            if self.canonical()? != canonical {
                return Err(KernelError::Authorization(
                    "File resource changed before its effect".into(),
                ));
            }
            let task = self.clone();
            owner.call(move |s| s.validate_file_effect(&task).map(|_| ()))?;
            let value = self.apply(plan.resuming)?;
            // Cancellation/revocation after an effect does not erase the actual
            // outcome. The original journal records it before the lease drains.
            let (task, receipt) = (self.clone(), value.clone());
            owner.call(move |s| s.finish_file_effect(&task, &receipt))?;
            Ok(value)
        }))
        .unwrap_or_else(|_| {
            Err(KernelError::Storage(
                "File effect worker panicked; inspect its original operation receipt".into(),
            ))
        });
        if retained {
            let task = self.clone();
            let released = owner.call(move |s| {
                s.file_effects.remove(task.operation());
                if !borrowed {
                    s.finish_retained_file_lease(&task.lease_id);
                }
                Ok(())
            });
            if outcome.is_ok() {
                released?;
            }
        }
        outcome
    }
    fn apply(&self, resuming: bool) -> Result<Value, KernelError> {
        match self.method {
            "file.apply" => {
                let target: FileState = serde_json::from_str(
                    self.params["targetJson"]
                        .as_str()
                        .expect("validated file target"),
                )?;
                let resource = self.resolve("path")?;
                super::file_resources::apply_physical_state(
                    &self.storage_root,
                    &resource,
                    &target,
                    &self.cancellation,
                )?;
                let observed = super::capture_resources::observe_effect(
                    &self.root,
                    &resource.path,
                    &self.grant,
                    &AtomicBool::new(false),
                )?;
                if !Storage::file_state_matches(&observed, &target) {
                    return Err(KernelError::Storage(format!(
                        "file state did not match target after apply: {}",
                        resource.path
                    )));
                }
                Ok(
                    json!({"status":"applied","reconciled":false,"stateJson":serde_json::to_string(&observed)?}),
                )
            }
            "file.mkdir" => {
                let params: KernelFileMkdirParams = parse_file_params(&self.params)?;
                let resource = self.resolve("path")?;
                match fs::symlink_metadata(&resource.absolute) {
                    Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                    Ok(_) => {
                        return Err(KernelError::Operation(
                            "mkdir target exists and is not a directory".into(),
                        ))
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        if params.recursive {
                            fs::create_dir_all(&resource.absolute)?;
                        } else {
                            fs::create_dir(&resource.absolute)?;
                        }
                        if let Some(parent) = resource.absolute.parent() {
                            sync_directory(parent)?;
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
                Ok(json!({"status":"created","reconciled":resuming}))
            }
            "file.remove" => {
                let params: KernelFileRemoveParams = parse_file_params(&self.params)?;
                let resource = self.resolve("path")?;
                if resuming {
                    if fs::symlink_metadata(&resource.absolute)
                        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
                    {
                        return Ok(json!({"status":"removed","reconciled":true}));
                    }
                    return Err(KernelError::Operation("remove needs attention: target exists after interrupted operation; refusing destructive replay".into()));
                }
                match fs::symlink_metadata(&resource.absolute) {
                    Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                        if params.recursive {
                            fs::remove_dir_all(&resource.absolute)?;
                        } else {
                            fs::remove_dir(&resource.absolute)?;
                        }
                    }
                    Ok(_) => fs::remove_file(&resource.absolute)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound && params.force => {}
                    Err(error) => return Err(error.into()),
                }
                if let Some(parent) = resource.absolute.parent() {
                    sync_directory(parent)?;
                }
                Ok(json!({"status":"removed","reconciled":false}))
            }
            "file.rename" => {
                let source = self.resolve("fromPath")?;
                let target = self.resolve("toPath")?;
                if let Some(parent) = target.absolute.parent() {
                    fs::create_dir_all(parent)?;
                }
                durable_rename(&source.absolute, &target.absolute)?;
                if let Some(parent) = source.absolute.parent() {
                    sync_directory(parent)?;
                }
                if source.absolute.parent() != target.absolute.parent() {
                    if let Some(parent) = target.absolute.parent() {
                        sync_directory(parent)?;
                    }
                }
                Ok(json!({"status":"renamed","reconciled":false}))
            }
            _ => unreachable!("validated file effect"),
        }
    }
}
impl Storage {
    pub(crate) fn prepare_file_effect(
        &self,
        method: &str,
        value: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Task, KernelError> {
        let method = match method {
            "file.apply" => {
                let _: KernelFileApplyParams = parse_file_params(value)?;
                "file.apply"
            }
            "file.mkdir" => {
                let _: KernelFileMkdirParams = parse_file_params(value)?;
                "file.mkdir"
            }
            "file.remove" => {
                let _: KernelFileRemoveParams = parse_file_params(value)?;
                "file.remove"
            }
            "file.rename" => {
                let _: KernelFileRenameParams = parse_file_params(value)?;
                "file.rename"
            }
            _ => return Err(KernelError::Protocol("Unknown file effect".into())),
        };
        let field = |name| {
            value[name]
                .as_str()
                .ok_or_else(|| KernelError::Operation(format!("File {name} is missing")))
        };
        field("operationId")?;
        let root = self.admitted_file_root(field("rootId")?, grant)?;
        if root.owning_workspace_id != field("workspaceId")? {
            return Err(KernelError::Authorization(
                "File effect workspace differs from its original root".into(),
            ));
        }
        let mut resources = Vec::new();
        for name in if method == "file.rename" {
            &["fromPath", "toPath"][..]
        } else {
            &["path"][..]
        } {
            let path = normalized_relative_path(field(*name)?, false)?.0;
            if !path_allowed(grant, &path) {
                return Err(KernelError::Authorization(
                    "File effect is outside grant scope".into(),
                ));
            }
            resources.push(FileLeaseResource {
                path,
                subtree: method == "file.rename"
                    || method == "file.mkdir"
                    || (method == "file.remove" && value["recursive"] == true),
            });
        }
        resources.sort_by(|a, b| a.path.cmp(&b.path).then(a.subtree.cmp(&b.subtree)));
        resources.dedup();
        let lease = value["leaseId"].as_str();
        let task = Task {
            params: file_params_value(value),
            cancellation,
            method,
            access_method: method,
            root,
            grant: grant.clone(),
            storage_root: self.root.clone(),
            resources,
            private_lease: lease.is_none(),
            lease_id: lease
                .map(str::to_owned)
                .unwrap_or_else(|| format!("file-effect:{}", Uuid::new_v4())),
        };
        task.check()?;
        Ok(task)
    }
    pub(super) fn validate_file_effect(&self, task: &Task) -> Result<Grant, KernelError> {
        task.check()?;
        let grant = self.load_grant(&task.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != task.grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "File effect's original grant is no longer active".into(),
            ));
        }
        require_capability(&grant, task.access_method)?;
        let root = self.admitted_file_root(&task.root.root_id, &grant)?;
        if root.canonical_root != task.root.canonical_root
            || root.execution_workspace_id != task.root.execution_workspace_id
            || root.owning_workspace_id != task.root.owning_workspace_id
        {
            return Err(KernelError::Authorization(
                "File effect root changed after admission".into(),
            ));
        }
        if task
            .resources
            .iter()
            .any(|resource| !path_allowed(&grant, &resource.path))
        {
            return Err(KernelError::Authorization(
                "File effect's original scope changed".into(),
            ));
        }
        if self.file_effects.contains(task.operation()) {
            let lease = self.file_leases.get(&task.lease_id).ok_or_else(|| {
                KernelError::Storage("Original file executor lost its lease".into())
            })?;
            if lease.grant_id != task.grant.grant_id || lease.root_id != task.root.root_id {
                return Err(KernelError::Authorization(
                    "Original file executor lease changed owner".into(),
                ));
            }
        }
        Ok(grant)
    }
    pub(super) fn retain_file_effect(
        &mut self,
        task: &Task,
        canonical: &[CanonicalFileLeaseResource],
        borrowed: bool,
    ) -> Result<(), KernelError> {
        if self.file_effects.contains(task.operation()) {
            return Err(KernelError::Operation(
                "The original file operation is still executing".into(),
            ));
        }
        if !self.try_retain_file_effect(task, canonical, borrowed)? {
            return Err(KernelError::Operation("file resource is busy".into()));
        }
        Ok(())
    }
    pub(super) fn try_retain_file_effect(
        &mut self,
        task: &Task,
        canonical: &[CanonicalFileLeaseResource],
        borrowed: bool,
    ) -> Result<bool, KernelError> {
        if self.file_effects.contains(task.operation()) {
            return Ok(false);
        }
        let grant = self.validate_file_effect(task)?;
        if borrowed {
            if task.private_lease {
                return Err(KernelError::Storage(
                    "An inner file effect must borrow its original lease".into(),
                ));
            }
            self.assert_retained_canonical_file_lease(
                &grant,
                &task.root.root_id,
                canonical,
                &task.lease_id,
            )?;
        } else if task.private_lease {
            let params: KernelFileLeaseAcquireParams = parse_file_params(
                &json!({"workspaceId":task.workspace(),"rootId":task.root.root_id,"leaseId":task.lease_id,
                "resources":task.resources.iter().map(|resource|json!({"path":resource.path,"scope":if resource.subtree {"subtree"}else{"exact"}})).collect::<Vec<_>>()}),
            )?;
            let result = self.acquire_file_lease_for(
                FileLeaseRequest {
                    params,
                    resources: task.resources.clone(),
                    canonical_resources: canonical.to_vec(),
                },
                &grant,
                None,
            )?;
            if result["status"] != "acquired" {
                return Ok(false);
            }
        } else {
            self.assert_canonical_file_lease(
                &grant,
                &task.root.root_id,
                canonical,
                Some(&task.lease_id),
            )?;
        }
        if !borrowed {
            self.retained_file_leases.insert(
                task.lease_id.clone(),
                RetainedFileLease {
                    release_requested: task.private_lease,
                },
            );
        }
        self.file_effects.insert(task.operation().into());
        Ok(true)
    }
    fn begin_file_effect(
        &mut self,
        task: &Task,
        physical: &[PathBuf],
    ) -> Result<Plan, KernelError> {
        let grant = self.validate_file_effect(task)?;
        let journalled = if task.method == "file.apply" {
            self.journal_for_file_reservation(&task.params, &grant)?
        } else {
            None
        };
        let input = journalled.as_ref().unwrap_or(&task.params);
        let (_, ready, resuming) =
            self.begin_file_operation(task.operation(), task.method, input)?;
        let mut plan = Plan {
            ready,
            resuming,
            _content: None,
            reservations: None,
        };
        if plan.ready.is_some() {
            return Ok(plan);
        }
        if task.method == "file.apply" {
            let params: KernelFileApplyParams = parse_file_params(&task.params)?;
            let target: FileState = serde_json::from_str(&params.target_json)?;
            if params.record_id.is_some() || params.slot.is_some() {
                let FileState::RegularFile { object_hash, .. } = &target else {
                    return Err(KernelError::Authorization(
                        "only a file target can use a content record".into(),
                    ));
                };
                let mut reference = json!({"recordId":params.record_id,"slot":params.slot});
                if let Some(owner) = &params.owner_id {
                    reference["ownerId"] = json!(owner);
                }
                self.validate_blob_read_source(&reference, object_hash, &grant.grant_id, false)?;
            } else if let Some(owner) = &params.owner_id {
                let FileState::RegularFile { object_hash, .. } = &target else {
                    return Err(KernelError::Authorization(
                        "only a file target can consume an object owner".into(),
                    ));
                };
                self.validate_object_owners(
                    task.workspace(),
                    &grant.grant_id,
                    &BTreeMap::from([(owner.clone(), object_hash.clone())]),
                )?;
            } else if matches!(target, FileState::RegularFile { .. })
                && !grant.capabilities.contains("storage.maintenance")
                && !grant.capabilities.contains("recovery.maintenance")
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(
                    "file apply requires an exact object owner or Host maintenance authority"
                        .into(),
                ));
            }
            if let FileState::RegularFile { object_hash, .. } = &target {
                if !self.blob_owned(object_hash, Some(task.workspace()))? {
                    return Err(KernelError::Authorization(
                        "file target object is not owned by the workspace".into(),
                    ));
                }
                plan._content = Some(self.blob_read_roots.retain(object_hash));
            }
            if grant.capabilities.contains("recovery.maintenance") {
                // Only the process/receipt owner is consulted here. Physical
                // reservation paths are resolved by the worker below.
                if !self.observation_process_idle(&physical[0])? {
                    return Err(KernelError::Operation(
                        "affected resource still has an active process writer".into(),
                    ));
                }
                plan.reservations = Some(self.recovery_file_reservations(
                    task.workspace(),
                    task.params["reservationOperationId"].as_str(),
                )?);
            }
        }
        if task.method == "file.remove" || task.method == "file.rename" {
            for resource in physical {
                self.assert_process_directory_idle(resource)?;
            }
        }
        Ok(plan)
    }
    fn decide_file_effect(
        &mut self,
        task: &Task,
        states: &[FileState],
        resuming: bool,
    ) -> Result<Option<Value>, KernelError> {
        self.validate_file_effect(task)?;
        let result = match task.method {
            "file.apply" => {
                let params: KernelFileApplyParams = parse_file_params(&task.params)?;
                let target: FileState = serde_json::from_str(&params.target_json)?;
                let current = &states[0];
                if Self::file_state_matches(current, &target) {
                    Some(
                        json!({"status":"applied","reconciled":resuming,"stateJson":serde_json::to_string(current)?}),
                    )
                } else if params
                    .expected_json
                    .as_deref()
                    .map(serde_json::from_str::<FileState>)
                    .transpose()?
                    .as_ref()
                    .is_some_and(|expected| !Self::file_state_matches(current, expected))
                {
                    Some(json!({"status":"conflict","stateJson":serde_json::to_string(current)?}))
                } else {
                    None
                }
            }
            "file.rename" => {
                let params: KernelFileRenameParams = parse_file_params(&task.params)?;
                let (source, target) = (&states[0], &states[1]);
                if resuming {
                    let stored = self.operation_get(&json!({"operationId":task.operation()}))?;
                    let before = stored["result"]
                        .get("renameSourceState")
                        .cloned()
                        .map(serde_json::from_value::<FileState>)
                        .transpose()?;
                    if matches!(source, FileState::Missing)
                        && before.as_ref().is_some_and(|before| {
                            matches!(
                                before,
                                FileState::RegularFile { .. } | FileState::Symlink { .. }
                            ) && Self::file_state_matches(target, before)
                        })
                    {
                        Some(json!({"status":"renamed","reconciled":true}))
                    } else {
                        return Err(KernelError::Operation("rename needs attention: interrupted operation has no provable target; refusing replay".into()));
                    }
                } else if params
                    .expected_from_json
                    .as_deref()
                    .map(serde_json::from_str::<FileState>)
                    .transpose()?
                    .as_ref()
                    .is_some_and(|expected| !Self::file_state_matches(source, expected))
                    || params
                        .expected_to_json
                        .as_deref()
                        .map(serde_json::from_str::<FileState>)
                        .transpose()?
                        .as_ref()
                        .is_some_and(|expected| !Self::file_state_matches(target, expected))
                {
                    Some(
                        json!({"status":"conflict","sourceStateJson":serde_json::to_string(source)?,"targetStateJson":serde_json::to_string(target)?}),
                    )
                } else if matches!(source, FileState::Missing) {
                    return Err(KernelError::Operation("rename source is missing".into()));
                } else if params.target_must_be_missing.unwrap_or(false)
                    && !matches!(target, FileState::Missing)
                {
                    Some(json!({"status":"target-exists"}))
                } else {
                    let raw: String = self.conn.query_row(
                        "SELECT result_json FROM operations WHERE operation_id=?1",
                        [task.operation()],
                        |row| row.get(0),
                    )?;
                    let mut envelope: Value = serde_json::from_str(&raw)?;
                    envelope["renameSourceState"] = serde_json::to_value(source)?;
                    self.conn.execute(
                        "UPDATE operations SET result_json=?2 WHERE operation_id=?1",
                        params![task.operation(), envelope.to_string()],
                    )?;
                    None
                }
            }
            _ => None,
        };
        if let Some(receipt) = &result {
            self.finish_file_effect(task, receipt)?;
        }
        Ok(result)
    }
    fn finish_file_effect(&mut self, task: &Task, result: &Value) -> Result<(), KernelError> {
        if !self.file_effects.contains(task.operation()) {
            return Err(KernelError::Storage(
                "The original file executor is no longer retained".into(),
            ));
        }
        self.finish_file_operation_owned(
            task.operation(),
            result,
            if task.method == "file.apply" {
                task.params["ownerId"].as_str()
            } else {
                None
            },
            Some(task.workspace()),
        )
    }
}
