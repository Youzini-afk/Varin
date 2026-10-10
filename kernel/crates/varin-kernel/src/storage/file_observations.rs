//! A bounded durable read acceptance in the original operation journal. There is no
//! condition/cursor/occurrence database here and no reusable observation credential.
use super::capture_resources::CaptureTask;
use super::*;
use crate::model::GrantState;
use crate::tools::ToolBinding;
use serde::{Deserialize, Serialize};
use varin_runtime::catalog::followups::{FileObservationRequest, FileState, FollowupActor};
use varin_runtime::catalog::launches::LiveRoot;

const KIND: &str = "file.observation.accept";
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "scope",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Hint {
    Root {
        root_id: String,
        canonical_root: String,
    },
    Receipt {
        receipt_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    pub receipt_id: String,
    pub followup_id: String,
    pub source_index: usize,
    pub source_run_id: String,
    pub thread_id: String,
    pub source: varin_runtime::catalog::launches::SourceSelection,
    pub physical_root: Option<LiveRoot>,
    pub path: String,
    pub immutable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    identity: Value,
    target: Target,
    original_grant_id: String,
    pin_id: Option<String>,
    fixed_root: Option<String>,
    released: bool,
}
pub(crate) struct ActiveRead {
    receipt_id: String,
    grant_id: String,
    cancel: Arc<AtomicBool>,
    lease_id: Option<String>,
}
pub(crate) struct ReadTask {
    id: String,
    request: FileObservationRequest,
    epoch: String,
    host_generation: String,
    capture: Option<CaptureTask>,
    fixed: Option<FileState>,
    storage_idle: bool,
}
pub(crate) struct Snapshot {
    pub state: FileState,
    pub storage_idle: bool,
}
impl ReadTask {
    pub(crate) fn run(&self) -> Result<FileState, KernelError> {
        if let Some(capture) = &self.capture {
            capture.run()?.single_state()
        } else {
            self.fixed
                .clone()
                .ok_or_else(|| KernelError::Storage("file state missing".into()))
        }
    }
}
fn denied(message: &str) -> KernelError {
    KernelError::Authorization(message.into())
}
impl Storage {
    fn observation_process_idle(&mut self, target: &Path) -> Result<bool, KernelError> {
        self.ensure_recovered_process_receipt_wake();
        let rows = {
            let mut query = self
                .conn
                .prepare("SELECT process_id,status_json FROM process_records")?;
            let rows = query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (id, raw) in rows {
            let record: Value = serde_json::from_str(&raw)?;
            if record["writerActive"] == false {
                continue;
            }
            let root = record["sourceRoot"]
                .as_str()
                .or(record["cwd"].as_str())
                .ok_or_else(|| KernelError::Storage("process writer scope missing".into()))?;
            let path = Path::new(root);
            if !target.starts_with(path) && !path.starts_with(target) {
                continue;
            }
            let record = self
                .refresh_process_writer_record(&id)?
                .ok_or_else(|| KernelError::Storage("process writer record disappeared".into()))?;
            if record["writerActive"] == false {
                continue;
            }
            if !self.processes.is_live(&id) {
                if let Some(error) = &self.process_receipt_wake_failure {
                    return Err(KernelError::Operation(format!(
                        "process receipt notification unavailable: {error}"
                    )));
                }
            }
            return Ok(false);
        }
        Ok(true)
    }
    pub(super) fn is_file_observation_read_lease(&self, id: &str) -> bool {
        self.observation_reads
            .values()
            .any(|read| read.lease_id.as_deref() == Some(id))
    }
    pub(crate) fn file_observation_reads_active(&self) -> bool {
        !self.observation_reads.is_empty()
    }
    pub(crate) fn cancel_file_observation_reads(&self) {
        for r in self.observation_reads.values() {
            r.cancel.store(true, Ordering::Release);
        }
    }
    pub(crate) fn observe_file_writer_stopped(&mut self, id: &str) -> Result<(), KernelError> {
        if let Some(record) = self.refresh_process_writer_record(id)? {
            if record["writerActive"] == false {
                if let Some(cwd) = record["sourceRoot"].as_str().or(record["cwd"].as_str()) {
                    self.hint_file_path(Path::new(cwd));
                }
            }
        }
        Ok(())
    }
    pub(crate) fn set_file_observation_hints(
        &mut self,
        hint: impl Fn(Hint) + Send + Sync + 'static,
    ) {
        self.observation_hints = Some(Arc::new(hint));
    }
    pub(super) fn hint_file_root(&self, root_id: &str) {
        if let (Some(hint), Some(root)) = (&self.observation_hints, self.file_roots.get(root_id)) {
            hint(Hint::Root {
                root_id: root_id.into(),
                canonical_root: root.canonical_root.to_string_lossy().into_owned(),
            });
        }
    }
    pub(super) fn hint_file_path(&self, path: &Path) {
        for root in self.file_roots.values() {
            if path.starts_with(&root.canonical_root) || root.canonical_root.starts_with(path) {
                self.hint_file_root(&root.root_id);
            }
        }
    }
    pub(super) fn cancel_file_observation_grant(&self, grant_id: &str) -> Result<(), KernelError> {
        for r in self
            .observation_reads
            .values()
            .filter(|r| r.grant_id == grant_id)
        {
            r.cancel.store(true, Ordering::Release);
        }
        if let Some(hint) = &self.observation_hints {
            let mut query=self.conn.prepare("SELECT operation_id FROM operations WHERE kind='file.observation.accept' AND state='committed' AND CASE WHEN json_valid(result_json) THEN json_extract(result_json,'$.originalGrantId')=?1 AND json_extract(result_json,'$.released')=0 ELSE 1 END")?;
            for id in query.query_map([grant_id], |row| row.get::<_, String>(0))? {
                hint(Hint::Receipt { receipt_id: id? });
            }
        }
        Ok(())
    }
    fn observation_receipt(&self, r: &FileObservationRequest) -> Result<Receipt, KernelError> {
        let value = self.operation_get(&json!({"operationId":r.receipt_id()}))?;
        if value["kind"] != KIND || value["state"] != "committed" {
            return Err(denied("file observation acceptance unavailable"));
        }
        let receipt: Receipt = serde_json::from_value(value["result"].clone())?;
        let owned:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM operation_owners WHERE operation_id=?1 AND workspace_id=?2)",params![r.receipt_id(),r.source.workspace_id],|row|row.get(0))?;
        if !owned
            || receipt.target.receipt_id != r.receipt_id()
            || receipt.target.source != r.source
            || receipt.target.path != r.path
            || receipt.target.source_run_id != r.source_run_id
            || receipt.target.thread_id != r.thread_id
            || receipt.target.followup_id != r.followup_id
            || receipt.target.source_index != r.source_index
            || receipt.identity != r.authorization_identity()
        {
            return Err(denied("file observation acceptance identity changed"));
        }
        Ok(receipt)
    }
    fn observation_grant(&self, receipt: &Receipt, host: &str) -> Result<Grant, KernelError> {
        if receipt.released {
            return Err(denied("file observation released"));
        }
        let grant = self.load_grant(&receipt.original_grant_id)?;
        if grant.state == GrantState::Revoked {
            return Err(denied("file_observation_revoked"));
        }
        if grant.host_id != host || grant.storage_identity != self.root.to_string_lossy() {
            return Err(denied("file observation original authority moved"));
        }
        // Retirement and the historical creating epoch are provenance, not execution authority.
        // Only the private single-path task below consumes this receipt under the current owner.
        Ok(grant)
    }
    fn observation_root(
        &mut self,
        source: &varin_runtime::catalog::launches::SourceSelection,
        run: &str,
        host: &str,
    ) -> Result<Option<FileRoot>, KernelError> {
        if source.mode == varin_runtime::SourceMode::FixedBranch {
            return Ok(None);
        }
        let requested = if source.mode == varin_runtime::SourceMode::LiveRoot {
            let root = source
                .live_root
                .as_ref()
                .ok_or_else(|| denied("live root identity missing"))?;
            if root.host_id != host {
                return Err(denied("live root belongs to another Host"));
            }
            PathBuf::from(&root.canonical_root)
        } else {
            let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([
                source.workspace_id,
                source.environment_run_id.as_deref().unwrap_or(run)
            ]))?));
            self.root.join("managed").join("runs").join(key)
        };
        let canonical = fs::canonicalize(&requested)?;
        if canonical != requested || !fs::metadata(&canonical)?.is_dir() {
            return Err(denied("observation source root changed"));
        }
        let identity = format!(
            "file-root-v2\0{}\0{}\0{}",
            source.workspace_id,
            source.execution_workspace_id,
            canonical.to_string_lossy()
        );
        let root_id = format!(
            "file-root-{}",
            hex::encode(Sha256::digest(identity.as_bytes()))
        );
        if source
            .live_root
            .as_ref()
            .is_some_and(|r| r.root_id != root_id)
        {
            return Err(denied("observation live root changed"));
        }
        let root = FileRoot {
            root_id: root_id.clone(),
            owning_workspace_id: source.workspace_id.clone(),
            execution_workspace_id: source.execution_workspace_id.clone(),
            canonical_root: canonical,
        };
        // Pure root identity registration. In particular this never invokes file-operation
        // reconciliation/materialization (the public write-capable registration does).
        self.file_roots.insert(root_id, root.clone());
        Ok(Some(root))
    }
    pub(crate) fn describe_file_observation(
        &self,
        r: &FileObservationRequest,
        authorize: bool,
        host: &str,
    ) -> Result<Target, KernelError> {
        let receipt = self.observation_receipt(r)?;
        if authorize {
            self.observation_grant(&receipt, host)?;
        }
        Ok(receipt.target)
    }
    pub(crate) fn file_acceptance_page(
        &self,
        after: Option<&str>,
        strict: bool,
        followup_id: Option<&str>,
    ) -> Result<(Vec<FileObservationRequest>, Option<String>), KernelError> {
        // Public pending pages must not expose another Thread's operation key through
        // their scan cursor. The existing row position carries no receipt metadata.
        let cursor = after
            .map(str::parse::<i64>)
            .transpose()
            .map_err(|_| KernelError::Protocol("invalid file acceptance cursor".into()))?
            .unwrap_or(0);
        if cursor < 0 {
            return Err(KernelError::Protocol(
                "invalid file acceptance cursor".into(),
            ));
        }
        let mut query=self.conn.prepare("SELECT rowid,operation_id,result_json FROM operations WHERE kind='file.observation.accept' AND state='committed' AND rowid>?1 AND (?2 IS NULL OR (substr(operation_id,1,length(?2))=?2 AND length(substr(operation_id,length(?2)+1))>0 AND substr(operation_id,length(?2)+1) NOT GLOB '*[^0-9]*')) ORDER BY rowid LIMIT 65")?;
        let prefix = followup_id.map(|id| format!("file-observation:{id}:"));
        let rows = query
            .query_map(params![cursor, prefix], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let next = if rows.len() > 64 {
            Some(rows[63].0.to_string())
        } else {
            None
        };
        let mut result = Vec::new();
        for (_, operation_id, raw) in rows.into_iter().take(64) {
            let receipt = match serde_json::from_str::<Receipt>(&raw) {
                Ok(receipt) => receipt,
                Err(_) if strict => {
                    return Err(KernelError::Storage(
                        "file observation receipt is corrupt".into(),
                    ))
                }
                Err(_) => continue,
            };
            if receipt.released {
                continue;
            }
            let actor = match serde_json::from_value(receipt.identity["actor"].clone()) {
                Ok(actor) => actor,
                Err(_) if strict => {
                    return Err(KernelError::Storage(
                        "file observation actor is corrupt".into(),
                    ))
                }
                Err(_) => continue,
            };
            let t = receipt.target;
            let request = FileObservationRequest {
                followup_id: t.followup_id,
                source_index: t.source_index,
                source_run_id: t.source_run_id,
                thread_id: t.thread_id,
                actor,
                source: t.source,
                path: t.path,
                condition: varin_runtime::catalog::followups::FileCondition::Exists,
                intent_ref: receipt.identity["intentRef"].clone(),
            };
            if request.receipt_id() != operation_id {
                if strict {
                    return Err(KernelError::Storage(
                        "file observation receipt identity is corrupt".into(),
                    ));
                }
                continue;
            }
            if strict {
                self.observation_receipt(&request)?;
            }
            result.push(request);
        }
        Ok((result, next))
    }
    pub(crate) fn accept_file_observation(
        &mut self,
        r: &FileObservationRequest,
        grant_id: &str,
        binding: Option<&ToolBinding>,
        epoch: &str,
        host: &str,
        generation: &str,
    ) -> Result<Target, KernelError> {
        let identity = r.authorization_identity();
        if let Some(value) =
            self.operation_existing(&r.receipt_id(), KIND, &hash_json(&identity)?)?
        {
            let _ = value;
            let receipt = self.observation_receipt(r)?;
            self.observation_grant(&receipt, host)?;
            return Ok(receipt.target);
        }
        let (grant, _) = self.authorize(
            Some(grant_id),
            epoch,
            host,
            generation,
            "storage.health",
            &json!({"workspaceId":r.source.workspace_id}),
        )?;
        if !(grant.capabilities.contains("storage.read")
            || grant.capabilities.contains("storage.admin"))
            || grant.thread_id.as_deref() != Some(&r.thread_id)
            || grant.owning_workspace.as_deref() != Some(&r.source.workspace_id)
            || grant
                .execution_workspace
                .as_deref()
                .or(grant.owning_workspace.as_deref())
                != Some(&r.source.execution_workspace_id)
            || !path_allowed(&grant, &r.path)
        {
            return Err(denied("file acceptance exceeds original read authority"));
        }
        match &r.actor {
            FollowupActor::Agent { run_id, .. } => {
                let b = binding.ok_or_else(|| {
                    denied("Agent file acceptance requires its original tool binding")
                })?;
                if b.grant_id != grant_id
                    || b.run_id != *run_id
                    || b.run_id != r.source_run_id
                    || b.thread_id != r.thread_id
                    || b.source_selection()? != r.source
                    || grant.run_id.as_deref() != Some(run_id)
                {
                    return Err(denied("file tool source binding changed"));
                }
            }
            FollowupActor::User => {
                if binding.is_some()
                    || grant
                        .run_id
                        .as_deref()
                        .is_some_and(|run| run != r.source_run_id)
                {
                    return Err(denied("User file authority changed"));
                }
            }
            FollowupActor::Goal { .. } => {
                return Err(denied(
                    "file acceptance requires User or original tool invocation",
                ))
            }
        }
        let physical = self.observation_root(&r.source, &r.source_run_id, host)?;
        if let Some(root) = &physical {
            super::file_resources::resolve_admitted_resource(root, &r.path, &grant, false)?;
            if let Some(b) = binding {
                if b.root_id.as_deref() != Some(&root.root_id) {
                    return Err(denied("tool physical root changed"));
                }
            }
        } else {
            let branch = self.branch(
                r.source
                    .branch_id
                    .as_deref()
                    .ok_or_else(|| denied("fixed branch missing"))?,
            )?;
            if branch.workspace_id != r.source.workspace_id {
                return Err(denied("fixed branch workspace changed"));
            }
        }
        let target = Target {
            receipt_id: r.receipt_id(),
            followup_id: r.followup_id.clone(),
            source_index: r.source_index,
            source_run_id: r.source_run_id.clone(),
            thread_id: r.thread_id.clone(),
            source: r.source.clone(),
            physical_root: physical.map(|root| LiveRoot {
                host_id: host.into(),
                root_id: root.root_id,
                canonical_root: root.canonical_root.to_string_lossy().into_owned(),
            }),
            path: r.path.clone(),
            immutable: r.source.mode == varin_runtime::SourceMode::FixedBranch,
        };
        let value = super::operations::idempotent(self, KIND, &identity, |storage| {
            let (pin_id, fixed_root) = if target.immutable {
                let id = format!("{}:pin", r.receipt_id());
                let pin = storage.branch_pin(
                    &json!({"branchId":r.source.branch_id,"revision":r.source.revision,"pinId":id}),
                    true,
                    grant_id,
                )?;
                (
                    Some(id),
                    Some(
                        pin["root"]
                            .as_str()
                            .ok_or_else(|| KernelError::Storage("file pin root missing".into()))?
                            .to_owned(),
                    ),
                )
            } else {
                (None, None)
            };
            Ok(serde_json::to_value(Receipt {
                identity: identity.clone(),
                target: target.clone(),
                original_grant_id: grant_id.into(),
                pin_id,
                fixed_root,
                released: false,
            })?)
        })?;
        Ok(serde_json::from_value::<Receipt>(value)?.target)
    }
    pub(crate) fn prepare_file_observation(
        &mut self,
        r: FileObservationRequest,
        cancel: Arc<AtomicBool>,
        epoch: &str,
        host: &str,
        generation: &str,
    ) -> Result<ReadTask, KernelError> {
        if cancel.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let receipt = self.observation_receipt(&r)?;
        let grant = self.observation_grant(&receipt, host)?;
        let root = self.observation_root(&r.source, &r.source_run_id, host)?;
        let id = Uuid::new_v4().to_string();
        let (capture, fixed, lease_id, storage_idle) = if let Some(root) = root {
            if receipt.target.physical_root.as_ref().is_none_or(|v| {
                v.root_id != root.root_id || Path::new(&v.canonical_root) != root.canonical_root
            }) {
                return Err(denied("accepted physical root changed"));
            }
            let paths = vec![FileLeaseResource {
                path: r.path.clone(),
                subtree: false,
            }];
            self.assert_file_observation_lease(&grant, &root.root_id, &paths)?;
            let canonical = self.canonical_lease_resources(&root.root_id, &paths, &grant)?;
            let idle = self.observation_process_idle(&root.canonical_root)?;
            let lease_id = format!("file-observation-read:{id}");
            self.file_leases.insert(
                lease_id.clone(),
                FileLease {
                    lease_id: lease_id.clone(),
                    root_id: root.root_id.clone(),
                    workspace_id: r.source.workspace_id.clone(),
                    grant_id: grant.grant_id.clone(),
                    resources: paths,
                    canonical_resources: canonical,
                },
            );
            self.retained_file_leases.insert(
                lease_id.clone(),
                super::file_resource_leases::RetainedFileLease {
                    release_requested: false,
                },
            );
            (
                Some(CaptureTask::observation(
                    root,
                    grant.clone(),
                    r.path.clone(),
                    self.root.clone(),
                    cancel.clone(),
                )),
                None,
                Some(lease_id),
                idle,
            )
        } else {
            let root = receipt
                .fixed_root
                .as_ref()
                .ok_or_else(|| denied("fixed observation pin missing"))?;
            let pin = self.pin_read(
                &json!({"pinId":receipt.pin_id,"paths":[r.path],"__pathScopes":grant.path_scopes}),
                &grant.grant_id,
            )?;
            if pin["root"] != *root {
                return Err(denied("fixed observation root changed"));
            }
            let state = self
                .root_get(root, &r.path)?
                .map(|s| super::file_resources::materialized_expected_state(&s))
                .unwrap_or(FileState::Missing);
            (None, Some(state), None, true)
        };
        self.observation_reads.insert(
            id.clone(),
            ActiveRead {
                receipt_id: r.receipt_id(),
                grant_id: grant.grant_id,
                cancel,
                lease_id,
            },
        );
        Ok(ReadTask {
            id,
            request: r,
            epoch: epoch.into(),
            host_generation: generation.into(),
            capture,
            fixed,
            storage_idle,
        })
    }
    pub(crate) fn finish_file_observation(
        &mut self,
        task: ReadTask,
        result: Result<FileState, KernelError>,
        epoch: &str,
        host: &str,
        generation: &str,
    ) -> Result<Snapshot, KernelError> {
        let active = self
            .observation_reads
            .remove(&task.id)
            .ok_or_else(|| denied("file observation read ended"))?;
        let result = (|| {
            if active.cancel.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            if task.epoch != epoch || task.host_generation != generation {
                return Err(denied("file observation owner epoch changed"));
            }
            let receipt = self.observation_receipt(&task.request)?;
            let grant = self.observation_grant(&receipt, host)?;
            let idle = if let Some(root) =
                self.observation_root(&task.request.source, &task.request.source_run_id, host)?
            {
                super::file_resources::resolve_admitted_resource(
                    &root,
                    &task.request.path,
                    &grant,
                    false,
                )?;
                self.observation_process_idle(&root.canonical_root)?
            } else {
                true
            };
            Ok(Snapshot {
                state: result?,
                storage_idle: task.storage_idle && idle,
            })
        })();
        if let Some(id) = active.lease_id {
            self.retained_file_leases.remove(&id);
            self.file_leases.remove(&id);
        }
        if self
            .observation_receipt(&task.request)
            .is_ok_and(|r| r.released)
        {
            if let Some(hint) = &self.observation_hints {
                hint(Hint::Receipt {
                    receipt_id: task.request.receipt_id(),
                });
            }
        }
        result
    }
    pub(crate) fn release_file_observation(
        &mut self,
        r: &FileObservationRequest,
    ) -> Result<bool, KernelError> {
        let mut receipt = self.observation_receipt(r)?;
        if !receipt.released {
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            let result = (|| {
                if let Some(pin) = &receipt.pin_id {
                    self.conn.execute(
                        "DELETE FROM pins WHERE pin_id=?1 AND grant_id=?2",
                        params![pin, receipt.original_grant_id],
                    )?;
                }
                receipt.released = true;
                self.operation_finish(&r.receipt_id(), &serde_json::to_value(&receipt)?)?;
                Ok::<_, KernelError>(())
            })();
            match result {
                Ok(()) => self.conn.execute_batch("COMMIT")?,
                Err(e) => {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(e);
                }
            }
        }
        let mut drained = true;
        for read in self
            .observation_reads
            .values()
            .filter(|read| read.receipt_id == r.receipt_id())
        {
            read.cancel.store(true, Ordering::Release);
            drained = false;
        }
        Ok(drained)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use varin_runtime::{
        catalog::followups::FileCondition, catalog::launches::SourceSelection, SourceMode,
    };
    struct Fixture {
        base: PathBuf,
        work: PathBuf,
        storage: Storage,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("file-observer-{}", Uuid::new_v4()));
            let work = base.join("work");
            fs::create_dir_all(&work).unwrap();
            let storage = Storage::open(&base.join("store"), "host").unwrap();
            let mut f = Self {
                base,
                work,
                storage,
            };
            f.issue("reader", false, "epoch", "generation");
            f
        }
        fn issue(&mut self, id: &str, admin: bool, epoch: &str, generation: &str) {
            self.storage.issue_grant(&json!({"grantId":id,"hostGeneration":generation,"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","capabilities":if admin{vec!["storage.admin"]}else{vec!["storage.read"]},"pathScopes":if admin{vec![""]}else{vec!["result.txt"]}}),"host",generation,&self.storage.root.to_string_lossy().into_owned(),epoch).unwrap();
        }
        fn request(&self, key: &str) -> FileObservationRequest {
            let root = format!(
                "file-root-{}",
                hex::encode(Sha256::digest(
                    format!(
                        "file-root-v2\0workspace\0workspace\0{}",
                        self.work.to_string_lossy()
                    )
                    .as_bytes()
                ))
            );
            FileObservationRequest {
                followup_id: key.into(),
                source_index: 0,
                source_run_id: "original-run".into(),
                thread_id: "thread".into(),
                actor: FollowupActor::User,
                source: SourceSelection {
                    environment_run_id: None,
                    mode: SourceMode::LiveRoot,
                    live_root: Some(LiveRoot {
                        host_id: "host".into(),
                        root_id: root,
                        canonical_root: self.work.to_string_lossy().into_owned(),
                    }),
                    workspace_id: "workspace".into(),
                    execution_workspace_id: "workspace".into(),
                    branch_id: None,
                    revision: None,
                },
                path: "result.txt".into(),
                condition: FileCondition::Changed,
                intent_ref: json!({"hash":"original-intent"}),
            }
        }
        fn accept(&mut self, r: &FileObservationRequest) -> Target {
            self.storage
                .accept_file_observation(r, "reader", None, "epoch", "host", "generation")
                .unwrap()
        }
        fn read(
            &mut self,
            r: &FileObservationRequest,
            epoch: &str,
            generation: &str,
        ) -> Result<Snapshot, KernelError> {
            let task = self.storage.prepare_file_observation(
                r.clone(),
                Arc::new(AtomicBool::new(false)),
                epoch,
                "host",
                generation,
            )?;
            let state = task.run();
            self.storage
                .finish_file_observation(task, state, epoch, "host", generation)
        }
        fn invoke(&mut self, actor: &str, method: &str, params: Value) -> Value {
            let (g, p) = self
                .storage
                .authorize(Some(actor), "epoch", "host", "generation", method, &params)
                .unwrap();
            self.storage.dispatch(method, &p, Some(actor), &g).unwrap()
        }
        fn cleanup(self) {
            let Self { base, storage, .. } = self;
            drop(storage);
            fs::remove_dir_all(base).unwrap();
        }
    }
    #[test]
    fn acceptance_pages_use_metadata_free_cursors_and_exact_key_filter_is_unambiguous() {
        let mut f = Fixture::new();
        for n in 0..65 {
            let request = f.request(&format!("private-key-{n}"));
            f.accept(&request);
        }
        let (page, next) = f.storage.file_acceptance_page(None, true, None).unwrap();
        assert_eq!(page.len(), 64);
        let next = next.unwrap();
        assert!(next.parse::<i64>().unwrap() > 0);
        let (rest, next) = f
            .storage
            .file_acceptance_page(Some(&next), true, None)
            .unwrap();
        assert_eq!(rest.len(), 1);
        assert!(next.is_none());
        for key in ["exact", "exact:0"] {
            let request = f.request(key);
            f.accept(&request);
        }
        let (exact, next) = f
            .storage
            .file_acceptance_page(None, true, Some("exact"))
            .unwrap();
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].followup_id, "exact");
        assert!(next.is_none());
        assert!(f
            .storage
            .file_acceptance_page(Some("not-a-cursor"), true, None)
            .is_err());
        f.cleanup();
    }
    #[test]
    fn durable_file_acceptance_keeps_first_permission_across_retirement_restart_and_retry() {
        let mut f = Fixture::new();
        fs::write(f.work.join("result.txt"), b"first").unwrap();
        let r = f.request("wait");
        let target = f.accept(&r);
        let first = f.read(&r, "epoch", "generation").unwrap().state;
        f.storage
            .retire_grants(
                &json!({"target":{"kind":"grant","grantId":"reader"}}),
                "host",
            )
            .unwrap();
        let path = f.storage.root.clone();
        drop(f.storage);
        f.storage = Storage::open(&path, "host").unwrap();
        f.issue("retry", false, "new-epoch", "new-generation");
        assert_eq!(
            f.storage
                .accept_file_observation(&r, "retry", None, "new-epoch", "host", "new-generation")
                .unwrap(),
            target
        );
        assert_eq!(
            f.read(&r, "new-epoch", "new-generation").unwrap().state,
            first
        );
        fs::write(f.work.join("result.txt"), b"second").unwrap();
        assert_ne!(
            f.read(&r, "new-epoch", "new-generation").unwrap().state,
            first
        );
        f.storage
            .revoke_grant(&json!({"grantId":"reader"}), "host")
            .unwrap();
        assert!(f.read(&r, "new-epoch", "new-generation").is_err());
        assert!(f
            .storage
            .accept_file_observation(&r, "retry", None, "new-epoch", "host", "new-generation")
            .is_err());
        assert!(f.storage.release_file_observation(&r).unwrap());
        assert_eq!(
            f.storage
                .operation_release(&json!({"operationId":r.receipt_id(),"workspaceId":"workspace"}))
                .unwrap()["status"],
            "in-use"
        );
        assert!(f
            .storage
            .accept_file_observation(&r, "retry", None, "new-epoch", "host", "new-generation")
            .is_err());
        f.cleanup();
    }
    #[test]
    fn release_cancels_only_its_read_and_waits_for_actual_worker_drain() {
        let mut f = Fixture::new();
        fs::write(f.work.join("result.txt"), vec![7u8; 20 * 1024 * 1024]).unwrap();
        let r = f.request("large");
        f.accept(&r);
        let complete = f.read(&r, "epoch", "generation").unwrap();
        assert!(
            matches!(complete.state,FileState::RegularFile{byte_length,..} if byte_length==20*1024*1024)
        );
        let task = f
            .storage
            .prepare_file_observation(
                r.clone(),
                Arc::new(AtomicBool::new(false)),
                "epoch",
                "host",
                "generation",
            )
            .unwrap();
        assert!(!f.storage.release_file_observation(&r).unwrap());
        assert!(f.storage.file_observation_reads_active());
        let result = task.run();
        assert!(matches!(result, Err(KernelError::Cancelled)));
        assert!(matches!(
            f.storage
                .finish_file_observation(task, result, "epoch", "host", "generation"),
            Err(KernelError::Cancelled)
        ));
        assert!(f.storage.release_file_observation(&r).unwrap());
        assert!(f.storage.file_leases.is_empty());
        assert_eq!(
            f.storage.load_grant("reader").unwrap().state,
            GrantState::Active
        );
        assert_eq!(
            fs::metadata(f.work.join("result.txt")).unwrap().len(),
            20 * 1024 * 1024
        );
        f.cleanup();
    }
    #[test]
    fn physical_source_identity_does_not_turn_a_missing_root_into_a_missing_leaf() {
        let mut f = Fixture::new();
        let r = f.request("missing");
        f.accept(&r);
        assert_eq!(
            f.read(&r, "epoch", "generation").unwrap().state,
            FileState::Missing
        );
        fs::rename(&f.work, f.base.join("moved")).unwrap();
        assert!(f.read(&r, "epoch", "generation").is_err());
        f.cleanup();
    }
    #[test]
    fn exact_file_lease_release_wakes_observation_without_a_filesystem_write() {
        let mut f = Fixture::new();
        let r = f.request("lease");
        let target = f.accept(&r);
        f.issue("writer", true, "epoch", "generation");
        let root = target.physical_root.unwrap().root_id;
        let (tx, rx) = std::sync::mpsc::channel();
        f.storage.set_file_observation_hints(move |hint| {
            if let Hint::Root { root_id, .. } = hint {
                tx.send(root_id).unwrap();
            }
        });
        f.invoke("writer","file.lease.acquire",json!({"leaseId":"busy","workspaceId":"workspace","rootId":root,"resources":[{"path":"result.txt","scope":"exact"}]}));
        assert!(f.read(&r, "epoch", "generation").is_err());
        f.invoke(
            "writer",
            "file.lease.release",
            json!({"leaseId":"busy","workspaceId":"workspace","rootId":root}),
        );
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap(),
            root
        );
        assert!(f.read(&r, "epoch", "generation").unwrap().storage_idle);
        f.cleanup();
    }
    #[test]
    fn materialized_observer_retains_original_run_directory_and_never_reads_workspace() {
        let mut f = Fixture::new();
        let mut r = f.request("materialized");
        r.source.mode = SourceMode::Materialized;
        r.source.live_root = None;
        r.source.branch_id = Some("original-branch".into());
        r.source.revision = Some(7);
        r.source.environment_run_id = Some("original-environment".into());
        let key = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!(["workspace", "original-environment"])).unwrap(),
        ));
        let directory = f.storage.root.join("managed/runs").join(key);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("result.txt"), b"materialized-original").unwrap();
        fs::write(f.work.join("result.txt"), b"unrelated-workspace").unwrap();
        let target = f.accept(&r);
        assert_eq!(
            Path::new(&target.physical_root.unwrap().canonical_root),
            directory
        );
        let original = f.read(&r, "epoch", "generation").unwrap().state;
        fs::write(f.work.join("result.txt"), b"another-workspace-version").unwrap();
        assert_eq!(f.read(&r, "epoch", "generation").unwrap().state, original);
        fs::rename(&directory, directory.with_extension("gone")).unwrap();
        assert!(f.read(&r, "epoch", "generation").is_err());
        f.cleanup();
    }
    #[test]
    fn fixed_observer_pins_exact_revision_and_releases_pin_without_restoring_a_grant() {
        let mut f = Fixture::new();
        f.issue("writer", true, "epoch", "generation");
        f.invoke("writer","branch.create.begin",json!({"operationId":"create","builderId":"create","workspaceId":"workspace","branchId":"branch","draftBasePaths":[],"captureScopes":[]}));
        f.invoke("writer","branch.create.append",json!({"builderId":"create","sequence":0,"entries":[{"path":"result.txt","state":{"kind":"directory","mode":493}}]}));
        let branch = f.invoke(
            "writer",
            "branch.create.finish",
            json!({"operationId":"create","builderId":"create"}),
        );
        let mut r = f.request("fixed");
        r.source.mode = SourceMode::FixedBranch;
        r.source.live_root = None;
        r.source.branch_id = Some("branch".into());
        r.source.revision = Some(branch["headRevision"].as_u64().unwrap());
        assert!(f.accept(&r).immutable);
        assert!(matches!(
            f.read(&r, "epoch", "generation").unwrap().state,
            FileState::Directory { .. }
        ));
        f.storage
            .retire_grants(
                &json!({"target":{"kind":"grant","grantId":"reader"}}),
                "host",
            )
            .unwrap();
        assert!(matches!(
            f.read(&r, "new-epoch", "new-generation").unwrap().state,
            FileState::Directory { .. }
        ));
        let pins: i64 = f
            .storage
            .conn
            .query_row(
                "SELECT count(*) FROM pins WHERE pin_id=?1",
                [format!("{}:pin", r.receipt_id())],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pins, 1);
        // A damaged unrelated acceptance cannot block the real grant transition
        // or its fixed (watchless) receipt invalidation.
        f.issue("other-reader", false, "epoch", "generation");
        let mut damaged = r.clone();
        damaged.followup_id = "damaged-unrelated".into();
        f.storage
            .accept_file_observation(
                &damaged,
                "other-reader",
                None,
                "epoch",
                "host",
                "generation",
            )
            .unwrap();
        f.storage
            .conn
            .execute(
                "UPDATE operations SET result_json='broken' WHERE operation_id=?1",
                [damaged.receipt_id()],
            )
            .unwrap();
        let (hints, received) = std::sync::mpsc::channel();
        f.storage.set_file_observation_hints(move |hint| {
            hints.send(hint).unwrap();
        });
        f.storage
            .revoke_grant(&json!({"grantId":"reader"}), "host")
            .unwrap();
        let hints = (0..2)
            .map(|_| {
                received
                    .recv_timeout(std::time::Duration::from_secs(1))
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(hints
            .iter()
            .any(|hint| matches!(hint,Hint::Receipt{receipt_id} if *receipt_id==r.receipt_id())));
        assert!(hints.iter().any(
            |hint| matches!(hint,Hint::Receipt{receipt_id} if *receipt_id==damaged.receipt_id())
        ));
        assert_eq!(
            f.storage.load_grant("other-reader").unwrap().state,
            GrantState::Active
        );
        assert!(f.read(&r, "epoch", "generation").is_err());
        f.storage.release_file_observation(&r).unwrap();
        let pins: i64 = f
            .storage
            .conn
            .query_row(
                "SELECT count(*) FROM pins WHERE pin_id=?1",
                [format!("{}:pin", r.receipt_id())],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pins, 0);
        assert_eq!(
            f.storage.load_grant("reader").unwrap().state,
            GrantState::Revoked
        );
        f.cleanup();
    }
    #[test]
    fn overlapping_observer_readers_are_compatible_but_writers_wait_for_both() {
        let mut f = Fixture::new();
        fs::write(f.work.join("result.txt"), b"shared-read").unwrap();
        let a = f.request("first-reader");
        let b = f.request("second-reader");
        let target = f.accept(&a);
        f.accept(&b);
        let one = f
            .storage
            .prepare_file_observation(
                a,
                Arc::new(AtomicBool::new(false)),
                "epoch",
                "host",
                "generation",
            )
            .unwrap();
        let two = f
            .storage
            .prepare_file_observation(
                b,
                Arc::new(AtomicBool::new(false)),
                "epoch",
                "host",
                "generation",
            )
            .unwrap();
        let grant = f.storage.load_grant("reader").unwrap();
        let root = target.physical_root.unwrap().root_id;
        let paths = [FileLeaseResource {
            path: "result.txt".into(),
            subtree: false,
        }];
        assert!(f
            .storage
            .assert_file_lease(&grant, &root, &paths, None)
            .is_err());
        let one_state = one.run();
        f.storage
            .finish_file_observation(one, one_state, "epoch", "host", "generation")
            .unwrap();
        assert!(f
            .storage
            .assert_file_lease(&grant, &root, &paths, None)
            .is_err());
        let two_state = two.run();
        f.storage
            .finish_file_observation(two, two_state, "epoch", "host", "generation")
            .unwrap();
        f.storage
            .assert_file_lease(&grant, &root, &paths, None)
            .unwrap();
        f.cleanup();
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn recovered_guardian_late_atomic_receipt_wakes_original_root_without_target_write() {
        let mut f = Fixture::new();
        fs::write(f.work.join("result.txt"), b"unchanged").unwrap();
        let r = f.request("late-guardian");
        let target = f.accept(&r);
        let record = json!({"processId":"old-process","kernelEpoch":"old-epoch","sourceRoot":f.work,"cwd":f.work,"writerActive":true,"status":"unknown"});
        f.storage.conn.execute("INSERT INTO process_records(process_id,workspace_id,execution_workspace_id,grant_id,kernel_epoch,cwd,job_name,params_hash,status_json) VALUES ('old-process','workspace','workspace','reader','old-epoch',?1,'old-job','original',?2)",params![f.work.to_string_lossy(),serde_json::to_string(&record).unwrap()]).unwrap();
        let (wake_tx, wakes) = std::sync::mpsc::channel();
        let (terminal_tx, terminals) = std::sync::mpsc::channel();
        let (hint_tx, hints) = std::sync::mpsc::channel();
        f.storage.set_process_terminal_sender(terminal_tx);
        f.storage.set_file_observation_hints(move |hint| {
            if let Hint::Root { root_id, .. } = hint {
                let _ = hint_tx.send(root_id);
            }
        });
        f.storage.set_recovered_process_receipt_wake(move || {
            let _ = wake_tx.send(());
        });
        assert!(f.storage.process_receipt_wake.is_some());
        assert!(!f.read(&r, "epoch", "generation").unwrap().storage_idle);
        let receipt = crate::process::receipt_path(&f.storage.root, "old-process");
        let temporary = receipt.with_extension("tmp");
        // Corrupt spool bytes must never be opened by the short terminal callback.
        fs::write(
            crate::process::output_path(&f.storage.root, "old-process"),
            b"invalid output framing",
        )
        .unwrap();
        fs::write(&temporary,serde_json::to_vec(&json!({"processId":"wrong-process","kernelEpoch":"old-epoch","treeConfirmed":true,"status":"exited"})).unwrap()).unwrap();
        fs::rename(&temporary, &receipt).unwrap();
        wakes
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        f.storage.recheck_recovered_process_receipts();
        assert!(terminals.try_recv().is_err());
        assert!(f.read(&r, "epoch", "generation").is_err());
        assert!(f.storage.process_record("old-process").unwrap().unwrap()["outputError"].is_null());
        // A separate healthy source is not blocked by this original writer's invalid receipt.
        let other = f.base.join("other");
        fs::create_dir_all(&other).unwrap();
        let mut healthy = f.request("healthy");
        let live = healthy.source.live_root.as_mut().unwrap();
        live.canonical_root = other.to_string_lossy().into_owned();
        live.root_id = format!(
            "file-root-{}",
            hex::encode(Sha256::digest(
                format!(
                    "file-root-v2\0workspace\0workspace\0{}",
                    other.to_string_lossy()
                )
                .as_bytes()
            ))
        );
        f.accept(&healthy);
        assert!(
            f.read(&healthy, "epoch", "generation")
                .unwrap()
                .storage_idle
        );
        fs::write(&temporary,serde_json::to_vec(&json!({"processId":"old-process","kernelEpoch":"old-epoch","treeConfirmed":true,"status":"exited","exitCode":0})).unwrap()).unwrap();
        fs::rename(&temporary, &receipt).unwrap();
        wakes
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        f.storage.recheck_recovered_process_receipts();
        let terminal = terminals
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(terminal.process_id, "old-process");
        assert_eq!(terminal.kernel_epoch, "old-epoch");
        let root = target.physical_root.unwrap().root_id;
        assert!(hints.try_iter().any(|id| id == root));
        assert!(f.read(&r, "epoch", "generation").unwrap().storage_idle);
        assert!(f.storage.process_receipt_wake.is_none());
        assert_eq!(fs::read(f.work.join("result.txt")).unwrap(), b"unchanged");
        assert!(f.storage.process_record("old-process").unwrap().unwrap()["outputError"].is_null());
        f.cleanup();
    }
}
