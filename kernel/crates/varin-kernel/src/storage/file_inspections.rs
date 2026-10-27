//! Journal inspection is observation, never replay. Physical evidence is read
//! beside the mount; only the original Storage owner can commit its receipt.
use super::file_effects::{Control, Local};
use super::file_resources::{parse_file_params, FileState};
use super::*;
use crate::protocol_generated::{
    KernelFileOperationListParams, KernelFileOperationReconcileParams,
};

#[derive(Clone)]
pub(super) struct Row {
    pub id: String,
    kind: String,
    state: String,
    envelope: Value,
    created: i64,
    updated: i64,
}
impl Row {
    fn paths(&self) -> Result<Vec<String>, KernelError> {
        let intent = &self.envelope["intent"];
        let fields = if self.kind == "file.rename" {
            &["fromPath", "toPath"][..]
        } else {
            &["path"][..]
        };
        fields
            .iter()
            .map(|field| {
                intent[*field]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| KernelError::Storage("Pending file intent has no path".into()))
            })
            .collect()
    }
    fn descriptor(
        &self,
        root: &str,
        reason: &str,
        disposition: &str,
    ) -> Result<Value, KernelError> {
        Ok(
            json!({"operationId":self.id,"kind":self.kind,"state":self.state,"rootId":root,"paths":self.paths()?,
            "reason":reason,"disposition":disposition,"createdAt":self.created,"updatedAt":self.updated}),
        )
    }
    fn pending(&self, root: &str, reason: &str, disposition: &str) -> Result<Value, KernelError> {
        Ok(json!({"status":"pending","operation":self.descriptor(root,reason,disposition)?}))
    }
    fn committed(&self) -> Value {
        json!({"status":"reconciled","operationId":self.id,"kind":self.kind,"result":self.envelope})
    }
}
#[derive(Clone)]
pub(crate) struct Task {
    pub params: Value,
    pub cancellation: Arc<AtomicBool>,
    method: &'static str,
    root: FileRoot,
    grant: Grant,
}
impl Task {
    fn authorize(&self, s: &Storage) -> Result<Grant, KernelError> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let grant = s.load_grant(&self.grant.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != self.grant.kernel_epoch
        {
            return Err(KernelError::Authorization(
                "Original file inspection grant is no longer active".into(),
            ));
        }
        require_capability(&grant, self.method)?;
        let root = s.admitted_file_root(&self.root.root_id, &grant)?;
        if root.canonical_root != self.root.canonical_root
            || root.owning_workspace_id != self.root.owning_workspace_id
            || root.execution_workspace_id != self.root.execution_workspace_id
        {
            return Err(KernelError::Authorization(
                "Original file inspection root changed".into(),
            ));
        }
        Ok(grant)
    }
    fn control<T: Send + 'static>(
        &self,
        owner: &mut impl Control,
        work: impl FnOnce(&Task, &mut Storage) -> Result<T, KernelError> + Send + 'static,
    ) -> Result<T, KernelError> {
        let task = self.clone();
        owner.call(move |s| work(&task, s))
    }
    pub(crate) fn run(
        &self,
        mut port: workspace_session::StoragePort,
    ) -> Result<Value, KernelError> {
        self.run_with(&mut port)
    }
    pub(super) fn run_local(&self, s: &mut Storage) -> Result<Value, KernelError> {
        self.run_with(&mut Local(s))
    }
    pub(super) fn run_with(&self, owner: &mut impl Control) -> Result<Value, KernelError> {
        if self.method == "file.operation.reconcile" {
            let row = self.control(owner, |t, s| {
                t.authorize(s)?;
                s.file_inspection_row(
                    &t.root,
                    &t.params["operationId"]
                        .as_str()
                        .expect("validated operation"),
                )
            })?;
            let Some(row) = row else {
                return Ok(json!({"status":"missing","operationId":self.params["operationId"]}));
            };
            return self.inspect(owner, row, true);
        }
        let rows = self.control(owner, |t, s| {
            t.authorize(s)?;
            s.pending_file_inspections(&t.root)
        })?;
        let (cursor, size) = if self.method == "file.operation.list" {
            let p: KernelFileOperationListParams = parse_file_params(&self.params)?;
            (
                usize::try_from(p.cursor.unwrap_or(0)).map_err(|_| {
                    KernelError::Operation("file operation cursor is invalid".into())
                })?,
                p.page_size.unwrap_or(128).clamp(1, 512) as usize,
            )
        } else {
            (0, rows.len())
        };
        if cursor > rows.len() {
            return Err(KernelError::Operation(
                "file operation cursor is out of range".into(),
            ));
        }
        let total = rows.len();
        let end = cursor.saturating_add(size).min(total);
        let mut operations = Vec::new();
        let mut reconciled = 0;
        let mut pending = 0;
        for row in rows.into_iter().skip(cursor).take(end - cursor) {
            if self.method == "file.root.register"
                && row
                    .paths()?
                    .iter()
                    .any(|path| !path_allowed(&self.grant, path))
            {
                pending += 1;
                continue;
            }
            let value = self.inspect(owner, row, self.method == "file.root.register")?;
            if value["status"] == "reconciled" {
                reconciled += 1;
            } else if value["status"] == "pending" {
                pending += 1;
                operations.push(value["operation"].clone());
            }
        }
        if self.method == "file.root.register" {
            return Ok(json!({"reconciledOperations":reconciled,"pendingOperations":pending}));
        }
        Ok(
            json!({"operations":operations,"total":total,"nextCursor":if end<total{Some(end)}else{None}}),
        )
    }
    fn inspect(
        &self,
        owner: &mut impl Control,
        row: Row,
        settle: bool,
    ) -> Result<Value, KernelError> {
        if row.state == "committed" {
            return Ok(row.committed());
        }
        let id = row.id.clone();
        if self.control(owner, move |t, s| {
            t.authorize(s)?;
            Ok(s.file_effects.contains(&id))
        })? {
            return row.pending(
                &self.root.root_id,
                "original-file-worker-running",
                "needs-attention",
            );
        }
        for path in row.paths()? {
            if !path_allowed(&self.grant, &path) {
                return Err(KernelError::Authorization(
                    "File inspection is outside grant scope".into(),
                ));
            }
        }
        if row.kind == "file.materialize" {
            return row.pending(
                &self.root.root_id,
                "materialization-observation-required",
                "reconcile",
            );
        }
        if !matches!(
            row.kind.as_str(),
            "file.apply" | "file.mkdir" | "file.remove" | "file.rename"
        ) {
            return row.pending(
                &self.root.root_id,
                "unknown-file-operation-kind",
                "needs-attention",
            );
        }
        let original = row.clone();
        let mut effect = self.control(owner, move |t, s| {
            let grant = t.authorize(s)?;
            let mut intent = original.envelope["intent"].clone();
            intent
                .as_object_mut()
                .ok_or_else(|| KernelError::Storage("Pending file operation has no intent".into()))?
                .remove("leaseId");
            if intent["operationId"] != original.id {
                return Err(KernelError::Storage(
                    "Pending file intent identity changed".into(),
                ));
            }
            s.prepare_file_effect(&original.kind, &intent, &grant, t.cancellation.clone())
        })?;
        effect.access_method = self.method;
        let effect = Arc::new(effect);
        let mut retained = false;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let canonical = effect.canonical()?;
            let (work, proof) = (effect.clone(), canonical.clone());
            let admitted = self.control(owner, move |t, s| {
                t.authorize(s)?;
                s.try_retain_file_effect(&work, &proof, false)
            })?;
            if !admitted {
                return row.pending(
                    &self.root.root_id,
                    "original-file-worker-running",
                    "needs-attention",
                );
            }
            retained = true;
            let id = row.id.clone();
            let current = self.control(owner, move |t, s| {
                t.authorize(s)?;
                s.file_inspection_row(&t.root, &id)
            })?;
            let Some(current) = current else {
                return Ok(json!({"status":"missing","operationId":row.id}));
            };
            if current.state == "committed" {
                return Ok(current.committed());
            }
            if current.kind != row.kind || current.envelope != row.envelope {
                return Err(KernelError::Operation(
                    "Original file journal changed while being inspected".into(),
                ));
            }
            let mut states = Vec::new();
            for field in if row.kind == "file.rename" {
                &["fromPath", "toPath"][..]
            } else {
                &["path"][..]
            } {
                effect.check()?;
                let resource = effect.resolve(field)?;
                let state = if matches!(row.kind.as_str(), "file.mkdir" | "file.remove") {
                    match fs::symlink_metadata(&resource.absolute) {
                        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                            FileState::Directory {
                                mode: Some(super::file_resources::file_mode(&meta)),
                            }
                        }
                        Ok(_) => FileState::Unsupported,
                        Err(error) if error.kind() == io::ErrorKind::NotFound => FileState::Missing,
                        Err(error) => return Err(error.into()),
                    }
                } else {
                    super::capture_resources::observe_effect(
                        &effect.root,
                        &resource.path,
                        &effect.grant,
                        &effect.cancellation,
                    )?
                };
                states.push(state);
            }
            if effect.canonical()? != canonical {
                return Err(KernelError::Authorization(
                    "File inspection resource changed during observation".into(),
                ));
            }
            let (receipt, reason) = evidence(&row, &states)?;
            let (work, original) = (effect.clone(), row.clone());
            self.control(owner, move |t, s| {
                let grant = t.authorize(s)?;
                s.validate_file_effect(&work)?;
                let current = s
                    .file_inspection_row(&t.root, &original.id)?
                    .ok_or_else(|| {
                        KernelError::Storage(
                            "Original file operation disappeared during inspection".into(),
                        )
                    })?;
                if current.state == "committed" {
                    return Ok(current.committed());
                }
                if current.envelope != original.envelope || current.kind != original.kind {
                    return Err(KernelError::Operation(
                        "Original file journal changed during inspection".into(),
                    ));
                }
                if settle {
                    if let Some(receipt) = receipt {
                        s.finish_file_operation_owned(
                            &original.id,
                            &receipt,
                            original.envelope["intent"]["ownerId"].as_str(),
                            Some(&t.root.owning_workspace_id),
                        )?;
                        return Ok(s
                            .file_inspection_row(&t.root, &original.id)?
                            .ok_or_else(|| {
                                KernelError::Storage(
                                    "Original inspected receipt disappeared".into(),
                                )
                            })?
                            .committed());
                    }
                }
                // grant remains the original admitted observer; it never revives
                // the historical writer whose receipt is being reconciled.
                let _ = grant;
                original.pending(
                    &t.root.root_id,
                    reason,
                    if receipt.is_some() {
                        "reconcile"
                    } else {
                        "needs-attention"
                    },
                )
            })
        }))
        .unwrap_or_else(|_| {
            Err(KernelError::Storage(
                "File inspection worker panicked".into(),
            ))
        });
        if retained {
            let work = effect.clone();
            let cleanup = owner.call(move |s| {
                s.file_effects.remove(work.operation());
                s.finish_retained_file_lease(&work.lease_id);
                Ok(())
            });
            if outcome.is_ok() {
                cleanup?;
            }
        }
        outcome
    }
}
fn evidence(row: &Row, states: &[FileState]) -> Result<(Option<Value>, &'static str), KernelError> {
    let observed = &states[0];
    Ok(match row.kind.as_str() {
        "file.apply" => {
            let target: FileState =
                serde_json::from_str(row.envelope["intent"]["targetJson"].as_str().ok_or_else(
                    || KernelError::Storage("Original apply target is missing".into()),
                )?)?;
            if Storage::file_state_matches(observed, &target) {
                (
                    Some(
                        json!({"status":"applied","reconciled":true,"stateJson":serde_json::to_string(observed)?}),
                    ),
                    "target-observed",
                )
            } else {
                (None, "target-not-observed")
            }
        }
        "file.mkdir" => {
            if matches!(observed, FileState::Directory { .. }) {
                (
                    Some(json!({"status":"created","reconciled":true})),
                    "directory-observed",
                )
            } else {
                (None, "directory-not-observed")
            }
        }
        "file.remove" => {
            if matches!(observed, FileState::Missing) {
                (
                    Some(json!({"status":"removed","reconciled":true})),
                    "path-absent",
                )
            } else {
                (None, "path-present-after-interrupted-remove")
            }
        }
        "file.rename" => {
            let before = row
                .envelope
                .get("renameSourceState")
                .cloned()
                .map(serde_json::from_value::<FileState>)
                .transpose()?;
            if matches!(observed, FileState::Missing)
                && before.as_ref().is_some_and(|before| {
                    matches!(
                        before,
                        FileState::RegularFile { .. } | FileState::Symlink { .. }
                    ) && Storage::file_state_matches(&states[1], before)
                })
            {
                (
                    Some(json!({"status":"renamed","reconciled":true})),
                    "saved-source-state-observed-at-target",
                )
            } else if before.is_some_and(|before| matches!(before, FileState::Directory { .. })) {
                (
                    None,
                    "directory-rename-cannot-be-proven-from-directory-metadata",
                )
            } else {
                (None, "rename-result-not-provable")
            }
        }
        _ => unreachable!("validated original file operation"),
    })
}
impl Storage {
    pub(crate) fn prepare_file_inspection(
        &self,
        method: &str,
        params: &Value,
        grant: &Grant,
        cancellation: Arc<AtomicBool>,
    ) -> Result<Task, KernelError> {
        let (method, workspace, root) = match method {
            "file.operation.reconcile" => {
                let p: KernelFileOperationReconcileParams = parse_file_params(params)?;
                ("file.operation.reconcile", p.workspace_id, p.root_id)
            }
            "file.operation.list" => {
                let p: KernelFileOperationListParams = parse_file_params(params)?;
                ("file.operation.list", p.workspace_id, p.root_id)
            }
            "file.root.register" => (
                "file.root.register",
                params["workspaceId"].as_str().unwrap_or_default().into(),
                params["rootId"].as_str().unwrap_or_default().into(),
            ),
            _ => {
                return Err(KernelError::Protocol(
                    "Unknown file inspection method".into(),
                ))
            }
        };
        let root = self.admitted_file_root(&root, grant)?;
        if root.owning_workspace_id != workspace {
            return Err(KernelError::Authorization(
                "File inspection workspace differs from its root".into(),
            ));
        }
        let task = Task {
            params: params.clone(),
            method,
            root,
            grant: grant.clone(),
            cancellation,
        };
        task.authorize(self)?;
        Ok(task)
    }
    fn file_inspection_row(&self, root: &FileRoot, id: &str) -> Result<Option<Row>, KernelError> {
        let row:Option<(String,String,Option<String>,i64,i64)>=self.conn.query_row(
            "SELECT o.kind,o.state,o.result_json,o.created_at,o.updated_at FROM operations o JOIN operation_owners w ON w.operation_id=o.operation_id WHERE o.operation_id=?1 AND w.workspace_id=?2",
            params![id,root.owning_workspace_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let Some((kind, state, raw, created, updated)) = row else {
            return Ok(None);
        };
        if !kind.starts_with("file.") {
            return Err(KernelError::Operation(
                "operation is not a file-resource operation".into(),
            ));
        }
        let envelope = raw
            .map(|raw| serde_json::from_str::<Value>(&raw))
            .transpose()?
            .ok_or_else(|| KernelError::Storage("Original file operation has no body".into()))?;
        if state == "started" && envelope["intent"]["rootId"] != root.root_id {
            return Err(KernelError::Authorization(
                "file operation belongs to another root".into(),
            ));
        }
        Ok(Some(Row {
            id: id.into(),
            kind,
            state,
            envelope,
            created,
            updated,
        }))
    }
    pub(super) fn pending_file_inspections(
        &self,
        root: &FileRoot,
    ) -> Result<Vec<Row>, KernelError> {
        let mut query=self.conn.prepare("SELECT o.operation_id FROM operations o INDEXED BY operations_pending_files JOIN operation_owners w ON w.operation_id=o.operation_id WHERE o.state='started' AND w.workspace_id=?1 AND o.kind GLOB 'file.*' AND json_extract(o.result_json,'$.intent.rootId')=?2 ORDER BY o.created_at,o.operation_id")?;
        let ids = query
            .query_map(params![root.owning_workspace_id, root.root_id], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| {
                self.file_inspection_row(root, id)?.ok_or_else(|| {
                    KernelError::Storage("Original pending file journal disappeared".into())
                })
            })
            .collect()
    }
}
