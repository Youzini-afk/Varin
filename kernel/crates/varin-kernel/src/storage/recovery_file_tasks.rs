//! Recovery keeps its original journal and receipts. Filesystem work runs beside
//! the mounted source and returns metadata stages to the same Storage owner.
use super::file_effects::{Control, Local};
use super::file_mutations::TextMutation;
use super::file_resources::parse_file_params;
use super::recovery_points::{restored_file, FileRestoreArgs, RecoveryPointsArgs};
use super::*;
use crate::protocol_generated::KernelFileRecoveryParams;
use varin_runtime::catalog::journal::JournalAnchor;

pub(crate) fn parse_params(input: &Value) -> Result<KernelFileRecoveryParams, KernelError> {
    parse_file_params(input)
}

pub(super) enum RestorePlan {
    Ready(Value),
    Existing,
    Targets(BTreeMap<String, (Value, Value)>),
}
#[derive(Clone)]
pub(crate) enum Action {
    Points(RecoveryPointsArgs),
    Restore {
        operation: String,
        args: FileRestoreArgs,
    },
    Reconcile {
        operation: String,
    },
    RestoreReceipt {
        operation: String,
        args: FileRestoreArgs,
    },
    TextReceipt {
        operation: String,
        mutation: TextMutation,
        executor: String,
    },
    CreatePoint {
        params: Value,
        args: Value,
    },
}
impl Action {
    fn method(&self) -> &'static str {
        match self {
            Self::Points(_) | Self::Reconcile { .. } => "recovery.points",
            Self::Restore { .. } => "recovery.files.restore",
            Self::RestoreReceipt { .. } | Self::TextReceipt { .. } => "file.operation.reconcile",
            Self::CreatePoint { .. } => "recovery.point.create",
        }
    }
    fn reservation(&self) -> Option<&str> {
        match self {
            Self::Restore { operation, .. } => Some(operation),
            Self::CreatePoint { params, .. } => params["operationId"].as_str(),
            _ => None,
        }
    }
}
#[derive(Clone)]
pub(crate) struct Task {
    workspace: String,
    root: FileRoot,
    thread: String,
    action: Arc<Action>,
    grant: Grant,
    anchor: Option<JournalAnchor>,
    mode: varin_runtime::SourceMode,
    pub cancellation: Arc<AtomicBool>,
    live_root: Option<varin_runtime::catalog::launches::LiveRoot>,
}
impl Task {
    pub(crate) fn with_live_root(
        mut self,
        root: Option<varin_runtime::catalog::launches::LiveRoot>,
    ) -> Self {
        self.live_root = root;
        self
    }
    fn control<T: Send + 'static>(
        &self,
        owner: &mut impl Control,
        work: impl FnOnce(&Task, &mut Storage) -> Result<T, KernelError> + Send + 'static,
    ) -> Result<T, KernelError> {
        let task = self.clone();
        owner.call(move |s| work(&task, s))
    }
    fn authorize(&self, s: &Storage) -> Result<Grant, KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let grant = s.load_grant(&self.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != self.grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Original recovery grant is no longer active".into(),
            ));
        }
        require_capability(&grant, self.action.method())?;
        let root = s.admitted_file_root(&self.root.root_id, &grant)?;
        if root.canonical_root != self.root.canonical_root
            || root.owning_workspace_id != self.workspace
            || root.execution_workspace_id != self.root.execution_workspace_id
        {
            return Err(KernelError::Authorization(
                "Original recovery source changed".into(),
            ));
        }
        if let Some(live) = &self.live_root {
            s.validate_recorded_live_root(live, &grant, &grant.host_id)?;
        }
        s.recovery_workspace(
            &json!({"workspaceId":self.workspace,"threadId":self.thread}),
            &grant.grant_id,
        )?;
        Ok(grant)
    }
    pub(crate) fn run(
        &self,
        mut port: workspace_session::StoragePort,
    ) -> Result<Value, crate::tools::ResourceFailure> {
        let mut dispatched = false;
        self.run_with(&mut port, &mut dispatched)
            .map_err(|error| crate::tools::ResourceFailure { error, dispatched })
    }
    pub(crate) fn run_wire(
        &self,
        mut port: workspace_session::StoragePort,
    ) -> Result<Value, KernelError> {
        self.run_with(&mut port, &mut false)
    }
    pub(crate) fn run_local(
        &self,
        storage: &mut Storage,
        dispatched: &mut bool,
    ) -> Result<Value, KernelError> {
        self.run_with(&mut Local(storage), dispatched)
    }
    fn lease(&self, owner: &mut impl Control, path: &str, id: &str) -> Result<bool, KernelError> {
        let (path, id) = (path.to_owned(), id.to_owned());
        let task = self.control(owner, move |t, s| {
            s.prepare_file_lease_task(
                "file.lease.acquire",
                &json!({"workspaceId":t.workspace,"rootId":t.root.root_id,"leaseId":id,
                "resources":[{"path":path,"scope":"exact"}]}),
                &t.authorize(s)?,
                t.cancellation.clone(),
            )
        })?;
        let resolved = task.run();
        let value = self.control(owner, move |t, s| {
            let grant = t.authorize(s)?;
            s.finish_file_lease_task("recovery", &task, resolved, &grant)?
                .ok_or_else(|| KernelError::Storage("Recovery acquire unexpectedly queued".into()))
        })?;
        Ok(value["status"] == "acquired")
    }
    fn release_lease(&self, owner: &mut impl Control, id: String) -> Result<(), KernelError> {
        self.control(owner, move |t, s| {
            s.file_lease_release(
                &json!({"workspaceId":t.workspace,"rootId":t.root.root_id,"leaseId":id}),
                &t.grant,
            )
            .map(|_| ())
        })
    }
    fn capture(
        &self,
        owner: &mut impl Control,
        path: &str,
        lease: &str,
    ) -> Result<Value, KernelError> {
        let (path, id) = (path.to_owned(), lease.to_owned());
        let prepared = self.control(owner, move |t, s| s.prepare_capture_resolution("file.capture",
            &json!({"workspaceId":t.workspace,"operationId":format!("capture:{id}"),"rootId":t.root.root_id,
                "path":path,"leaseId":id,"store":true}), &t.authorize(s)?, t.cancellation.clone()))?;
        let resolved = prepared.resolve()?;
        let task = self.control(owner, move |t, s| {
            s.finish_capture_resolution(prepared, resolved, &t.authorize(s)?)
        })?;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let hashed = task.hash_sources()?;
            let (task, hashed) = self.control(owner, move |t, s| {
                let mut task = task;
                s.retain_capture_objects(&mut task, &hashed, &t.authorize(s)?)?;
                Ok((task, hashed))
            })?;
            let batch = task.finish_sources(hashed)?;
            self.control(owner, move |t, s| {
                s.publish_capture(&task, batch, &t.authorize(s)?)
            })
        }))
        .unwrap_or_else(|_| {
            Err(KernelError::Storage(
                "Recovery capture worker panicked".into(),
            ))
        });
        let id = lease.to_owned();
        let release = self.control(owner, move |_, s| {
            s.finish_retained_file_lease(&id);
            Ok(())
        });
        if result.is_ok() {
            release?;
        }
        result
    }
    fn inspect(&self, owner: &mut impl Control, operation: String) -> Result<Value, KernelError> {
        let task =
            self.control(owner, move |t, s| {
                s.prepare_file_inspection("file.operation.reconcile",
            &json!({"workspaceId":t.workspace,"rootId":t.root.root_id,"operationId":operation}),
            &t.authorize(s)?, t.cancellation.clone())
            })?;
        task.run_with(owner)
    }
    fn reconcile(
        &self,
        owner: &mut impl Control,
        operation: &str,
        own_reservation: bool,
    ) -> Result<Value, KernelError> {
        let id = operation.to_owned();
        let (row, active) = self.control(owner, move |t, s| {
            t.authorize(s)?;
            Ok((
                s.recovery_operation_get(
                    &json!({"workspaceId":t.workspace,"operationId":id}),
                    &t.grant.grant_id,
                )?,
                s.active_recoveries.contains(&id) && !own_reservation,
            ))
        })?;
        if active && row.is_null() {
            return Ok(
                json!({"operationId":operation,"status":"pending","reason":"original-recovery-worker-running","appliedPaths":[],"conflictPaths":[],"files":[]}),
            );
        }
        if row.is_null() {
            return Ok(
                json!({"operationId":operation,"status":"failed","appliedPaths":[],"conflictPaths":[],"files":[]}),
            );
        }
        if row["kind"] != "file-restore"
            || row["threadId"] != self.thread
            || row["data"]["rootId"] != self.root.root_id
        {
            return Err(KernelError::Authorization("Restore source changed".into()));
        }
        if row["state"] == "complete" {
            return Ok(row["result"].clone());
        }
        if active {
            return Ok(
                json!({"operationId":operation,"status":"pending","reason":"original-recovery-worker-running",
            "appliedPaths":[],"conflictPaths":[],"files":row["data"]["files"]}),
            );
        }
        let mut results = row["data"]["files"].as_array().cloned().unwrap_or_default();
        for (index, file) in row["files"].as_array().into_iter().flatten().enumerate() {
            let receipt = self.inspect(owner, format!("{operation}:file:{index}"))?;
            results.push(restored_file(
                file,
                if receipt["status"] == "pending" {
                    "pending"
                } else {
                    receipt["result"]["status"]
                        .as_str()
                        .unwrap_or("interrupted")
                },
            )?);
        }
        let id = operation.to_owned();
        self.control(owner, move |t, s| {
            s.finish_file_restore(&t.workspace, &id, results, &t.grant)
        })
    }
    fn restore(
        &self,
        owner: &mut impl Control,
        operation: &str,
        args: &FileRestoreArgs,
        leases: &mut Vec<String>,
        owners: &mut Vec<String>,
        dispatched: &mut bool,
    ) -> Result<Value, KernelError> {
        let (id, arguments) = (operation.to_owned(), args.clone());
        let plan = self.control(owner, move |t, s| {
            s.prepare_restore_metadata(
                &t.workspace,
                &t.root.root_id,
                &t.thread,
                &id,
                &arguments,
                t.anchor.as_ref(),
                &t.authorize(s)?,
            )
        })?;
        let targets = match plan {
            RestorePlan::Ready(value) => return Ok(value),
            RestorePlan::Existing => return self.reconcile(owner, operation, true),
            RestorePlan::Targets(targets) => targets,
        };
        let mut files = Vec::new();
        let mut results = args.paths.iter().flatten().filter(|p| !targets.contains_key(*p))
            .map(|path| json!({"path":path,"status":"unavailable","message":"This path has no recorded state at the selected point."})).collect::<Vec<_>>();
        for (path, (expected, target)) in targets {
            self.control(owner, |t, s| t.authorize(s).map(|_| ()))?;
            if target.is_null() || target["kind"] == "unsupported" {
                results.push(json!({"path":path,"status":"unavailable"}));
                continue;
            }
            if let Some(message) = args.blocked_paths.as_ref().and_then(|p| p.get(&path)) {
                results.push(json!({"path":path,"status":"busy","message":message}));
                continue;
            }
            let lease = format!(
                "restore:{operation}:{}",
                hex::encode(Sha256::digest(path.as_bytes()))
            );
            if !self.lease(owner, &path, &lease)? {
                results.push(json!({"path":path,"status":"busy"}));
                continue;
            }
            leases.push(lease.clone());
            // One stable stored observation provides both the comparison and the
            // exact undo image; the later effect still compares it conditionally.
            let safety = self.capture(owner, &path, &lease)?;
            if let Some(id) = safety["ownerId"].as_str() {
                owners.push(id.into());
            }
            let state: Value =
                serde_json::from_str(safety["stateJson"].as_str().ok_or_else(|| {
                    KernelError::Storage("Recovery capture omitted state".into())
                })?)?;
            if state == target {
                results.push(json!({"path":path,"status":"unchanged"}));
                continue;
            }
            if state != expected
                && !args
                    .overwrite_paths
                    .as_ref()
                    .is_some_and(|p| p.contains(&path))
            {
                results.push(json!({"path":path,"status":"conflict"}));
                continue;
            }
            let mut references = Vec::new();
            for (slot, value) in [
                ("expected", &state),
                ("target", &target),
                ("safety", &state),
            ] {
                if let Some(hash) = value["objectHash"].as_str() {
                    let mut reference = json!({"slot":slot,"objectHash":hash});
                    if slot != "target" {
                        reference["ownerId"] = safety["ownerId"].clone();
                    }
                    references.push(reference);
                }
            }
            files.push(
                json!({"path":path,"expectedJson":state.to_string(),"targetJson":target.to_string(),
                "safetyJson":state.to_string(),"references":references}),
            );
        }
        files.sort_by_key(|file| {
            let target: Value =
                serde_json::from_str(file["targetJson"].as_str().unwrap()).expect("prepared state");
            let depth = file["path"].as_str().unwrap().split('/').count() as i64;
            let group = if target["kind"] == "missing" {
                0
            } else if target["kind"] == "directory" {
                1
            } else {
                2
            };
            (
                group,
                if group == 0 { -depth } else { depth },
                file["path"].as_str().unwrap().to_owned(),
            )
        });
        let (id, arguments, initial, selected) = (
            operation.to_owned(),
            args.clone(),
            results.clone(),
            files.clone(),
        );
        let journal = self.control(owner, move |t, s| {
            let grant = t.authorize(s)?;
            let journal = if selected.is_empty() {None} else {Some(s.restore_journal(&t.workspace,&t.root.root_id,
                &t.thread,&id,t.anchor.as_ref(),t.mode,&grant)?)};
            s.recovery_operation_create(&json!({"operationId":id,"workspaceId":t.workspace,"threadId":t.thread,
                "kind":"file-restore","state":"applying","dataJson":json!({"rootId":t.root.root_id,"runId":grant.run_id,
                "pointRunId":t.anchor.as_ref().map(|a|&a.run_id),"epoch":grant.kernel_epoch,"arguments":arguments,
                "files":initial,"journal":journal}).to_string(),"files":selected}), &grant.grant_id)?;
            Ok(journal)
        })?;
        for (index, file) in files.iter().enumerate() {
            let path = file["path"].as_str().unwrap();
            let id = format!("{operation}:file:{index}");
            let mut params = json!({"workspaceId":self.workspace,"rootId":self.root.root_id,"path":path,"operationId":id,
                "leaseId":format!("restore:{operation}:{}",hex::encode(Sha256::digest(path.as_bytes()))),
                "targetJson":file["targetJson"],"expectedJson":file["safetyJson"]});
            let target: Value = serde_json::from_str(file["targetJson"].as_str().unwrap())?;
            if target["kind"] == "regular-file" {
                params["recordId"] = json!(format!("operation-file:{operation}:{path}"));
                params["slot"] = json!("target");
            }
            if let Some(journal) = &journal {
                params["__recoveryTurn"] = journal.clone();
                params["__recoveryTool"] = json!("file_restore");
            }
            let effect = self.control(owner, move |t, s| {
                s.prepare_file_effect(
                    "file.apply",
                    &params,
                    &t.authorize(s)?,
                    t.cancellation.clone(),
                )
            });
            let receipt = effect.and_then(|effect| {
                *dispatched = true;
                effect.run_control(owner)
            });
            match receipt {
                Ok(receipt) => results.push(restored_file(
                    file,
                    receipt["status"].as_str().unwrap_or("unknown"),
                )?),
                Err(error) => {
                    // Observe only the durable original receipt after a failed
                    // executor. Revocation never initiates a new physical read.
                    let prior = self.control(owner, move |_, s| {
                        s.operation_get(&json!({"operationId":id}))
                    })?;
                    let status = if prior["state"] == "committed" {
                        prior["result"]["status"].as_str().unwrap_or("failed")
                    } else if prior["state"] == "started" {
                        "pending"
                    } else if matches!(error, KernelError::Cancelled) {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    let mut value = restored_file(file, status)?;
                    value["message"] = json!(error.to_string());
                    results.push(value);
                }
            }
        }
        let id = operation.to_owned();
        self.control(owner, move |t, s| {
            s.finish_file_restore(&t.workspace, &id, results, &t.grant)
        })
    }
    fn create_point(
        &self,
        owner: &mut impl Control,
        params: &Value,
        args: &Value,
        leases: &mut Vec<String>,
        owners: &mut Vec<String>,
    ) -> Result<Value, KernelError> {
        let parsed: KernelFileRecoveryParams = parse_file_params(params)?;
        let (p, a) = (params.clone(), args.clone());
        let paths = self.control(owner, move |t, s| {
            s.prepare_named_point_metadata(&parse_file_params(&p)?, &a, &t.authorize(s)?)
        })?;
        let files = if let Some(paths) = paths {
            let mut files = Vec::new();
            for path in paths {
                let id = format!(
                    "point:{}:{}",
                    parsed.operation_id.as_deref().unwrap(),
                    hex::encode(Sha256::digest(path.as_bytes()))
                );
                if !self.lease(owner, &path, &id)? {
                    return Err(KernelError::Operation(format!(
                        "Recovery point path is busy: {path}"
                    )));
                }
                leases.push(id.clone());
                let captured = self.capture(owner, &path, &id)?;
                if let Some(id) = captured["ownerId"].as_str() {
                    owners.push(id.into());
                }
                self.release_lease(owner, id.clone())?;
                leases.retain(|lease| lease != &id);
                let state: Value =
                    serde_json::from_str(captured["stateJson"].as_str().ok_or_else(|| {
                        KernelError::Storage("Point capture omitted state".into())
                    })?)?;
                let refs=state["objectHash"].as_str().map(|hash|vec![json!({"slot":"target","objectHash":hash,"ownerId":captured["ownerId"]})]).unwrap_or_default();
                files.push(json!({"path":path,"targetJson":state.to_string(),"references":refs}));
            }
            Some(files)
        } else {
            None
        };
        let a = args.clone();
        self.control(owner, move |t, s| {
            s.commit_named_point_metadata(&parsed, &a, files, &t.authorize(s)?)
        })
    }
    fn run_with(
        &self,
        owner: &mut impl Control,
        dispatched: &mut bool,
    ) -> Result<Value, KernelError> {
        let mut reserved = false;
        let mut leases = Vec::new();
        let mut owners = Vec::new();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.control(owner, |t, s| {
                t.authorize(s)?;
                if let Some(id) = t.action.reservation() {
                    if !s.active_recoveries.insert(id.into()) {
                        return Err(KernelError::Operation(
                            "Original recovery executor is still running".into(),
                        ));
                    }
                }
                Ok(())
            })?;
            reserved = self.action.reservation().is_some();
            match &*self.action {
                Action::Restore { operation, args } => {
                    self.restore(owner, operation, args, &mut leases, &mut owners, dispatched)
                }
                Action::Reconcile { operation } => self.reconcile(owner, operation, false),
                Action::Points(args) => {
                    if let Some(operation) = &args.operation {
                        self.reconcile(owner, operation, false)
                    } else {
                        let args = args.clone();
                        self.control(owner, move |t, s| {
                            s.file_recovery_points(
                                &t.workspace,
                                &t.root.root_id,
                                &t.thread,
                                &args,
                                t.anchor.as_ref(),
                                &t.authorize(s)?,
                            )
                        })
                    }
                }
                Action::CreatePoint { params, args } => {
                    self.create_point(owner, params, args, &mut leases, &mut owners)
                }
                Action::RestoreReceipt { operation, args } => {
                    let (id, a) = (operation.clone(), args.clone());
                    self.control(owner, move |t, s| {
                        s.file_restore_receipt_metadata(
                            &t.workspace,
                            &t.root.root_id,
                            &t.thread,
                            &id,
                            &a,
                            &t.authorize(s)?,
                            None,
                        )
                    })?;
                    let result = self.reconcile(owner, operation, false)?;
                    let (id, a) = (operation.clone(), args.clone());
                    self.control(owner, move |t, s| {
                        Ok(serde_json::to_value(s.file_restore_receipt_metadata(
                            &t.workspace,
                            &t.root.root_id,
                            &t.thread,
                            &id,
                            &a,
                            &t.authorize(s)?,
                            Some(result),
                        )?)?)
                    })
                }
                Action::TextReceipt {
                    operation,
                    mutation,
                    executor,
                } => {
                    let (id, m, e) = (operation.clone(), mutation.clone(), executor.clone());
                    let ready = self.control(owner, move |t, s| {
                        s.reconcile_text_mutation(
                            &t.workspace,
                            &t.root.root_id,
                            &id,
                            &m,
                            &t.authorize(s)?,
                            &e,
                        )
                    })?;
                    if ready.is_some() {
                        return Ok(serde_json::to_value(ready)?);
                    }
                    let id = operation.clone();
                    let inspectable = self.control(owner, move |_, s| {
                        let row = s.operation_get(&json!({"operationId":id}))?;
                        Ok(row["state"] == "started"
                            && row["result"]["intent"]["__nativeRequestHash"].is_string())
                    })?;
                    if !inspectable {
                        return Ok(Value::Null);
                    }
                    self.inspect(owner, operation.clone())?;
                    let (id, m, e) = (operation.clone(), mutation.clone(), executor.clone());
                    self.control(owner, move |t, s| {
                        Ok(serde_json::to_value(s.reconcile_text_mutation(
                            &t.workspace,
                            &t.root.root_id,
                            &id,
                            &m,
                            &t.authorize(s)?,
                            &e,
                        )?)?)
                    })
                }
            }
        }))
        .unwrap_or_else(|_| {
            Err(KernelError::Storage(
                "Recovery worker panicked; inspect its original operation".into(),
            ))
        });
        let cleanup = self.control(owner, move |t, s| {
            if reserved {
                if let Some(id) = t.action.reservation() {
                    s.active_recoveries.remove(id);
                }
            }
            for id in leases {
                let _ = s.file_lease_release(
                    &json!({"workspaceId":t.workspace,"rootId":t.root.root_id,"leaseId":id}),
                    &t.grant,
                );
            }
            for id in owners {
                let _ = s.release_object_owner(
                    &json!({"ownerId":id}),
                    Some(&t.workspace),
                    &t.grant.grant_id,
                );
            }
            Ok(())
        });
        if result.is_ok() {
            cleanup?;
        }
        result
    }
}
impl Storage {
    pub(crate) fn prepare_recovery_file_task(
        &self,
        workspace: &str,
        root: &str,
        thread: &str,
        action: Action,
        anchor: Option<&JournalAnchor>,
        mode: varin_runtime::SourceMode,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Task, KernelError> {
        if anchor.is_some_and(|a| a.thread_id != thread) {
            return Err(KernelError::Authorization(
                "Recovery journal belongs to a different conversation".into(),
            ));
        }
        let task = Task {
            workspace: workspace.into(),
            root: self.admitted_file_root(root, grant)?,
            thread: thread.into(),
            action: Arc::new(action),
            anchor: anchor.cloned(),
            mode,
            grant: grant.clone(),
            cancellation,
            live_root: None,
        };
        task.authorize(self)?;
        Ok(task)
    }
}
