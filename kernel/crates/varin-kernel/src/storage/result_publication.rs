//! WorkingResult publication is one Storage transaction. The original operation receipt and
//! retained root/base pins bridge capture, Catalog acknowledgement and publication without
//! recapturing a different directory or granting a caller general maintenance authority.
use super::operations::idempotent;
use super::*;

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, KernelError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| KernelError::Operation(format!("{key} is required")))
}
/// Public projection excludes the original receipt's private owner provenance.
pub(crate) fn candidate_view(
    receipt: &Value,
) -> Result<varin_runtime::KernelWorkingResultCandidate, KernelError> {
    let fields = [
        "publicationId",
        "candidateOperationId",
        "workspaceId",
        "branchId",
        "root",
        "baseRoot",
        "writeRevision",
        "pinId",
        "basePinId",
    ];
    let object = fields
        .into_iter()
        .map(|key| (key.to_string(), receipt[key].clone()))
        .collect::<serde_json::Map<_, _>>();
    Ok(serde_json::from_value(Value::Object(object))?)
}
impl Storage {
    fn require_result_scope(&self, grant_id: &str, workspace: &str) -> Result<Grant, KernelError> {
        let grant = self.load_grant(grant_id)?;
        if grant
            .owning_workspace
            .as_deref()
            .is_some_and(|id| id != workspace)
            || !grant.path_scopes.iter().any(String::is_empty)
        {
            return Err(KernelError::Authorization(
                "whole-root result publication exceeds grant scope".into(),
            ));
        }
        Ok(grant)
    }
    /// The builder is the existing bounded branch-write input stream. Its identity, complete
    /// changes and both pins commit together; a lost response is read by operation.get.
    pub(super) fn prepare_working_result(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let operation = required(params, "operationId")?;
        let publication = required(params, "publicationId")?;
        if operation != format!("result-prepare:{publication}") {
            return Err(KernelError::Operation(
                "result candidate operation identity changed".into(),
            ));
        }
        let builder_id = required(params, "builderId")?;
        let builder = self.branch_write_builders.get(builder_id).ok_or_else(|| {
            KernelError::Operation("result candidate builder is unavailable".into())
        })?;
        if builder.grant_id != grant_id || builder.operation_id != operation {
            return Err(KernelError::Authorization(
                "result candidate builder belongs to another actor".into(),
            ));
        }
        let grant = self.require_result_scope(grant_id, &builder.workspace_id)?;
        let identity = json!({"operationId":operation,"publicationId":publication,
            "workspaceId":builder.workspace_id,"branchId":builder.branch_id,
            "expectedWriteRevision":builder.expected_write_revision,"expectedRoot":required(params,"expectedRoot")?,
            "changes":builder.changes});
        self.branch_write_builders.remove(builder_id);
        idempotent(self, "working.result.prepare", &identity, |storage| {
            storage.check_cancelled()?;
            let branch_id = required(&identity, "branchId")?;
            let before = storage.branch(branch_id)?;
            if before.head_root != identity["expectedRoot"]
                || before.write_revision != identity["expectedWriteRevision"].as_i64().unwrap()
            {
                return Err(KernelError::Operation(
                    "working result candidate conflicts with current branch".into(),
                ));
            }
            if identity["changes"]
                .as_array()
                .is_some_and(|changes| !changes.is_empty())
            {
                let result = storage.branch_write(&identity, grant_id)?;
                if result["status"] != "committed" {
                    return Err(KernelError::Operation(
                        "working result capture changed during preparation".into(),
                    ));
                }
            }
            let branch = storage.branch(branch_id)?;
            let pin_id = format!("result-candidate:{publication}");
            let base_pin_id = format!("result-base:{publication}");
            for (id, root, revision, write_revision) in [
                (
                    &pin_id,
                    &branch.head_root,
                    branch.head_revision,
                    branch.write_revision,
                ),
                (&base_pin_id, &branch.base_root, 0, -1),
            ] {
                storage.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,0,?8)",
                    params![id,branch_id,branch.workspace_id,revision,write_revision,root,grant_id,now_ms()])?;
            }
            Ok(
                json!({"publicationId":publication,"candidateOperationId":operation,
                "workspaceId":branch.workspace_id,"branchId":branch_id,"root":branch.head_root,
                "baseRoot":branch.base_root,"writeRevision":branch.write_revision,"pinId":pin_id,"basePinId":base_pin_id,
                "parentRef":branch.parent_ref,"ownerThreadId":grant.thread_id,"ownerSessionId":grant.session_id}),
            )
        })
    }
    fn result_candidate(&self, params: &Value, grant_id: &str) -> Result<Value, KernelError> {
        let workspace = required(params, "workspaceId")?;
        let grant = self.require_result_scope(grant_id, workspace)?;
        let candidate_id = required(params, "candidateOperationId")?;
        let operation = self.operation_get(&json!({"operationId":candidate_id}))?;
        let candidate = operation["result"].clone();
        if operation["kind"] != "working.result.prepare"
            || operation["state"] != "committed"
            || candidate["workspaceId"] != workspace
            || candidate["branchId"] != params["branchId"]
            || candidate["candidateOperationId"] != candidate_id
        {
            return Err(KernelError::Operation(
                "working result candidate is unavailable or has another identity".into(),
            ));
        }
        for (key, actual) in [
            ("ownerThreadId", grant.thread_id.as_deref()),
            ("ownerSessionId", grant.session_id.as_deref()),
        ] {
            if candidate[key]
                .as_str()
                .is_some_and(|owner| Some(owner) != actual)
                && !grant.capabilities.contains("storage.maintenance")
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(
                    "working result candidate belongs to another actor".into(),
                ));
            }
        }
        Ok(candidate)
    }
    pub(crate) fn prepare_result_publication(
        &mut self,
        params: &Value,
        grant_id: &str,
        cancellation: Arc<AtomicBool>,
    ) -> Result<ResultPublicationAdmission, KernelError> {
        let candidate = self.result_candidate(params, grant_id)?;
        if params["operationId"] != candidate["publicationId"] {
            return Err(KernelError::Operation(
                "publication identity changed".into(),
            ));
        }
        if let Some(result) = self.operation_existing(
            required(params, "operationId")?,
            "working.result.publish",
            &hash_json(params)?,
        )? {
            return Ok(ResultPublicationAdmission::Complete(result));
        }
        self.require_candidate_pins(&candidate)?;
        let branch = self.branch(required(&candidate, "branchId")?)?;
        self.check_result_branch(&candidate, &branch)?;
        let identity = required(&candidate, "candidateOperationId")?.to_string();
        if !self.result_publications.insert(identity) {
            return Err(KernelError::Operation(
                "result publication is already running".into(),
            ));
        }
        Ok(ResultPublicationAdmission::Work(ResultPublicationTask {
            candidate,
            params: params.clone(),
            branch,
            database: self.root.join("catalog.sqlite"),
            cancellation,
        }))
    }
    fn check_result_branch(
        &self,
        candidate: &Value,
        branch: &BranchRow,
    ) -> Result<(), KernelError> {
        if branch.workspace_id != candidate["workspaceId"]
            || branch.base_root != candidate["baseRoot"]
            || branch.head_root != candidate["root"]
            || Some(branch.write_revision) != candidate["writeRevision"].as_i64()
        {
            return Err(KernelError::Operation(
                "working result branch changed after candidate fixation".into(),
            ));
        }
        Ok(())
    }
    fn require_candidate_pins(&self, candidate: &Value) -> Result<(), KernelError> {
        for (pin_key, root_key) in [("pinId", "root"), ("basePinId", "baseRoot")] {
            let retained:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM pins WHERE pin_id=?1 AND branch_id=?2 AND workspace_id=?3 AND root_hash=?4 AND ephemeral=0)",
                params![required(candidate,pin_key)?,required(candidate,"branchId")?,required(candidate,"workspaceId")?,required(candidate,root_key)?],|row|row.get(0))?;
            if !retained {
                return Err(KernelError::Operation(
                    "working result candidate pin was released".into(),
                ));
            }
        }
        Ok(())
    }
    pub(crate) fn finish_result_publication(
        &mut self,
        task: &ResultPublicationTask,
        prepared: PreparedWorkingResult,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let candidate = self.result_candidate(&task.params, grant_id)?;
        if candidate != task.candidate {
            return Err(KernelError::Operation(
                "result candidate changed during publication".into(),
            ));
        }
        if task.cancellation.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        idempotent(self, "working.result.publish", &task.params, |storage| {
            storage.require_candidate_pins(&candidate)?;
            let branch_id = required(&candidate, "branchId")?;
            let branch = storage.branch(branch_id)?;
            storage.check_result_branch(&candidate, &branch)?;
            if branch.head_revision != task.branch.head_revision {
                return Err(KernelError::Operation(
                    "working result publication revision advanced".into(),
                ));
            }
            let published = storage.branch_publish(
                &json!({"operationId":task.params["operationId"],"branchId":branch_id,
                "expectedWriteRevision":branch.write_revision,"expectedRoot":branch.head_root}),
            )?;
            if published["revision"] != prepared.revision {
                return Err(KernelError::Storage("result revision mismatch".into()));
            }
            storage.insert_prepared_working_result(&prepared)?;
            Ok(prepared.receipt)
        })
    }
    pub(crate) fn release_result_publication_worker(&mut self, task: &ResultPublicationTask) {
        if let Some(id) = task.candidate["candidateOperationId"].as_str() {
            self.result_publications.remove(id);
        }
    }
    // Direct owner harnesses use the identical preparation/commit boundary. Production intercepts
    // this method in Kernel::handle and runs the task on an independent data worker.
    pub(super) fn publish_working_result(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        match self.prepare_result_publication(params, grant_id, Arc::new(AtomicBool::new(false)))? {
            ResultPublicationAdmission::Complete(value) => Ok(value),
            ResultPublicationAdmission::Work(task) => {
                let result = task
                    .run()
                    .and_then(|prepared| self.finish_result_publication(&task, prepared, grant_id));
                self.release_result_publication_worker(&task);
                result
            }
        }
    }
    pub(super) fn release_working_result_candidate(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let candidate = self.result_candidate(params, grant_id)?;
        if required(params, "operationId")?
            != format!(
                "result-candidate-release:{}",
                required(&candidate, "publicationId")?
            )
        {
            return Err(KernelError::Operation(
                "candidate release identity changed".into(),
            ));
        }
        if self
            .result_publications
            .contains(required(&candidate, "candidateOperationId")?)
        {
            return Err(KernelError::Operation(
                "candidate is retained by a result publication worker".into(),
            ));
        }
        idempotent(
            self,
            "working.result.candidate.release",
            params,
            |storage| {
                let count = storage.conn.execute(
                    "DELETE FROM pins WHERE pin_id IN (?1,?2) AND branch_id=?3 AND workspace_id=?4",
                    params![
                        required(&candidate, "pinId")?,
                        required(&candidate, "basePinId")?,
                        required(&candidate, "branchId")?,
                        required(&candidate, "workspaceId")?
                    ],
                )?;
                Ok(json!({"released":count>0}))
            },
        )
    }
}

pub(crate) enum ResultPublicationAdmission {
    Complete(Value),
    Work(ResultPublicationTask),
}
pub(crate) struct ResultPublicationTask {
    candidate: Value,
    params: Value,
    branch: BranchRow,
    database: PathBuf,
    cancellation: Arc<AtomicBool>,
}
/// Only this module can construct a verified, serialized record. Record commit does no tree
/// traversal, body deserialization or hashing; metadata/ref insertion remains real work.
pub(crate) struct PreparedWorkingResult {
    pub(super) workspace: String,
    pub(super) branch_id: String,
    pub(super) record_id: String,
    pub(super) revision: i64,
    pub(super) payload: String,
    pub(super) references: Vec<(String, String)>,
    receipt: Value,
}
impl ResultPublicationTask {
    pub(crate) fn run(&self) -> Result<PreparedWorkingResult, KernelError> {
        let base = super::state_tree::read_immutable_tree_entries(
            &self.database,
            &self.branch.base_root,
            &self.cancellation,
        )?
        .into_iter()
        .collect::<BTreeMap<_, _>>();
        let current = super::state_tree::read_immutable_tree_entries(
            &self.database,
            &self.branch.head_root,
            &self.cancellation,
        )?
        .into_iter()
        .collect::<BTreeMap<_, _>>();
        let paths = base
            .keys()
            .chain(current.keys())
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|path| base.get(path) != current.get(path))
            .collect::<Vec<_>>();
        let connection = Connection::open_with_flags(
            &self.database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut base_states = serde_json::Map::new();
        let mut path_states = serde_json::Map::new();
        let mut references = Vec::new();
        for path in &paths {
            if self.cancellation.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            for (tree, prefix, states) in [
                (&base, "base", &mut base_states),
                (&current, "result", &mut path_states),
            ] {
                let state = tree.get(path).cloned().unwrap_or(PathState::Missing);
                if let Some(hash) = state.object_hash() {
                    let present:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=?1 AND EXISTS(SELECT 1 FROM root_blobs WHERE blob_hash=?1))",[hash],|row|row.get(0))?;
                    if !present {
                        return Err(KernelError::Storage(
                            "result references an unavailable captured object".into(),
                        ));
                    }
                    references.push((format!("{prefix}:{path}"), hash.to_string()));
                }
                let mut value = serde_json::to_value(state)?;
                if value.get("mode").is_some_and(Value::is_null) {
                    value.as_object_mut().unwrap().remove("mode");
                }
                states.insert(path.clone(), value);
            }
        }
        let mut insertions = 0usize;
        let mut deletions = 0usize;
        for path in &paths {
            let read = |state: Option<&PathState>| -> Result<Option<String>, KernelError> {
                let Some(PathState::RegularFile {
                    object_hash,
                    byte_length,
                    ..
                }) = state
                else {
                    return Ok(Some(String::new()));
                };
                let bytes = std::fs::read(crate::protocol::object_path(
                    self.database
                        .parent()
                        .ok_or_else(|| KernelError::Storage("object root missing".into()))?,
                    object_hash,
                )?)?;
                if bytes.len() as u64 != *byte_length
                    || format!("sha256-{}", hex::encode(Sha256::digest(&bytes))) != *object_hash
                {
                    return Err(KernelError::Storage(
                        "result object content differs from captured identity".into(),
                    ));
                }
                if bytes.contains(&0) {
                    return Ok(None);
                }
                Ok(String::from_utf8(bytes).ok())
            };
            if let (Some(before), Some(after)) = (read(base.get(path))?, read(current.get(path))?) {
                let (added, removed) = text_line_changes(&before, &after, &self.cancellation)?;
                insertions += added;
                deletions += removed;
            }
        }
        let revision = self.branch.head_revision + 1;
        let branch_id = required(&self.candidate, "branchId")?.to_string();
        let record_id = format!("working-result:{branch_id}@{revision}");
        let created_at = chrono_like_now();
        let mut document = json!({"resultRevision":revision,"branchId":branch_id,"root":self.branch.head_root,"baseRoot":self.branch.base_root,
            "changedPaths":paths,"baseStates":base_states,"pathStates":path_states,
            "diffStats":{"files":paths.len(),"insertions":insertions,"deletions":deletions},"createdAt":created_at});
        if let Some(parent) = &self.branch.parent_ref {
            document["parentRef"] = json!(parent);
        }
        let payload = serde_json::to_string(&document)?;
        let receipt = json!({"publicationId":self.params["operationId"],"workspaceId":self.branch.workspace_id,"branchId":branch_id,
            "resultRevision":revision,"root":self.branch.head_root,"baseRoot":self.branch.base_root,"recordId":record_id,"createdAt":created_at});
        Ok(PreparedWorkingResult {
            workspace: self.branch.workspace_id.clone(),
            branch_id,
            record_id,
            revision,
            payload,
            references,
            receipt,
        })
    }
}

/// Myers edit distance gives exact insertion/deletion counts without retaining a diff body.
/// Binary objects contribute file changes only, as in normal text diff statistics.
fn text_line_changes(
    before: &str,
    after: &str,
    cancel: &AtomicBool,
) -> Result<(usize, usize), KernelError> {
    let left = before.split_inclusive('\n').collect::<Vec<_>>();
    let right = after.split_inclusive('\n').collect::<Vec<_>>();
    let n = left.len() as isize;
    let m = right.len() as isize;
    let max = (n + m) as usize;
    let offset = max as isize + 1;
    let mut frontier = vec![0isize; 2 * max + 3];
    for distance in 0..=max {
        if cancel.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let d = distance as isize;
        for diagonal in (-d..=d).step_by(2) {
            let i = (diagonal + offset) as usize;
            let mut x = if diagonal == -d || (diagonal != d && frontier[i - 1] < frontier[i + 1]) {
                frontier[i + 1]
            } else {
                frontier[i - 1] + 1
            };
            let mut y = x - diagonal;
            while x < n && y < m && left[x as usize] == right[y as usize] {
                x += 1;
                y += 1;
            }
            frontier[i] = x;
            if x >= n && y >= m {
                return Ok((((d + m - n) / 2) as usize, ((d + n - m) / 2) as usize));
            }
        }
    }
    unreachable!("finite line edit distance")
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn invoke(
        storage: &mut Storage,
        method: &str,
        value: Value,
    ) -> Result<Value, KernelError> {
        let (grant, params) =
            storage.authorize(Some("actor"), "epoch", "host", "generation", method, &value)?;
        storage.dispatch(method, &params, Some("actor"), &grant)
    }
    pub(super) fn fixture() -> (Storage, PathBuf) {
        let root = std::env::temp_dir().join(format!("varin-result-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&root, "host").unwrap();
        storage.issue_grant(&json!({"grantId":"actor","hostGeneration":"generation","owningWorkspace":"workspace",
            "executionWorkspace":"workspace","threadId":"thread","runId":"run","pathScopes":[""],
            "capabilities":["storage.read","storage.write"]}),"host","generation",&root.to_string_lossy(),"epoch").unwrap();
        invoke(&mut storage,"branch.create.begin",json!({"operationId":"create","builderId":"create","workspaceId":"workspace","branchId":"branch","draftBasePaths":[],"captureScopes":[]})).unwrap();
        invoke(
            &mut storage,
            "branch.create.finish",
            json!({"operationId":"create","builderId":"create"}),
        )
        .unwrap();
        (storage, root)
    }
    fn candidate(storage: &mut Storage, publication: &str) -> Value {
        let branch = storage.branch("branch").unwrap();
        let op = format!("result-prepare:{publication}");
        invoke(storage,"branch.write.begin",json!({"operationId":op,"builderId":op,"branchId":"branch","expectedWriteRevision":branch.write_revision})).unwrap();
        invoke(storage,"branch.write.append",json!({"builderId":op,"sequence":0,"changes":[{"path":"dir","state":{"kind":"directory","mode":493}}]})).unwrap();
        invoke(storage,"working.result.prepare",json!({"operationId":op,"publicationId":publication,"builderId":op,"expectedRoot":branch.head_root})).unwrap()
    }
    #[test]
    fn result_transaction_survives_rebase_and_replays_original_identity() {
        let (mut storage, root) = fixture();
        let candidate = candidate(&mut storage, "publish");
        assert_ne!(candidate["root"], candidate["baseRoot"]);
        let request = json!({"operationId":"publish","workspaceId":"workspace","branchId":"branch","candidateOperationId":"result-prepare:publish"});
        let published = invoke(&mut storage, "working.result.publish", request.clone()).unwrap();
        let result = invoke(
            &mut storage,
            "working.result.get",
            json!({"workspaceId":"workspace","recordId":published["recordId"]}),
        )
        .unwrap();
        assert_eq!(result["record"]["baseRoot"], candidate["baseRoot"]);
        assert_eq!(result["record"]["changedPaths"], json!(["dir"]));
        let branch = storage.branch("branch").unwrap();
        invoke(&mut storage,"branch.write.begin",json!({"operationId":"rebase","builderId":"rebase","branchId":"branch","expectedWriteRevision":branch.write_revision})).unwrap();
        invoke(
            &mut storage,
            "branch.write.finish",
            json!({"operationId":"rebase","builderId":"rebase","baseRef":candidate["root"]}),
        )
        .unwrap();
        assert_eq!(
            invoke(&mut storage, "working.result.publish", request.clone()).unwrap(),
            published
        );
        let again = invoke(
            &mut storage,
            "working.result.get",
            json!({"workspaceId":"workspace","recordId":published["recordId"]}),
        )
        .unwrap();
        assert_eq!(again, result);
        let mut different = request;
        different["candidateOperationId"] = json!("different");
        assert!(invoke(&mut storage, "working.result.publish", different).is_err());
        let release = json!({"operationId":"result-candidate-release:publish","workspaceId":"workspace","branchId":"branch","candidateOperationId":"result-prepare:publish"});
        let released = invoke(
            &mut storage,
            "working.result.candidate.release",
            release.clone(),
        )
        .unwrap();
        assert_eq!(released, json!({"released":true}));
        assert_eq!(
            invoke(&mut storage, "working.result.candidate.release", release).unwrap(),
            released
        );
        drop(storage);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn published_baseline_tree_survives_rebase_source_deletion_pin_release_and_gc() {
        let (mut storage, root) = fixture();
        let original = storage.branch("branch").unwrap();
        invoke(&mut storage,"branch.create.begin",json!({"operationId":"retain-reset","builderId":"retain-reset","workspaceId":"workspace","branchId":"reset-source","draftBasePaths":[],"captureScopes":[]})).unwrap();
        invoke(
            &mut storage,
            "branch.create.finish",
            json!({"operationId":"retain-reset","builderId":"retain-reset"}),
        )
        .unwrap();
        invoke(&mut storage,"branch.create.begin",json!({"operationId":"create-base","builderId":"create-base","workspaceId":"workspace","branchId":"base-source","draftBasePaths":[],"captureScopes":[]})).unwrap();
        invoke(&mut storage,"branch.create.append",json!({"builderId":"create-base","sequence":0,"entries":[{"path":"base-only","state":{"kind":"directory"}}]})).unwrap();
        invoke(
            &mut storage,
            "branch.create.finish",
            json!({"operationId":"create-base","builderId":"create-base"}),
        )
        .unwrap();
        let baseline = storage.branch("base-source").unwrap().head_root;
        let rebase = |storage: &mut Storage, id: &str, base: &str| {
            let branch = storage.branch("branch").unwrap();
            invoke(storage,"branch.write.begin",json!({"operationId":id,"builderId":id,"branchId":"branch","expectedWriteRevision":branch.write_revision})).unwrap();
            invoke(
                storage,
                "branch.write.finish",
                json!({"operationId":id,"builderId":id,"baseRef":base}),
            )
            .unwrap();
        };
        rebase(&mut storage, "adopt-base", &baseline);
        let candidate = candidate(&mut storage, "fixed-baseline");
        assert_eq!(candidate["baseRoot"], baseline);
        invoke(&mut storage,"working.result.publish",json!({"operationId":"fixed-baseline","workspaceId":"workspace","branchId":"branch","candidateOperationId":"result-prepare:fixed-baseline"})).unwrap();
        rebase(&mut storage, "replace-current-base", &original.head_root);
        invoke(
            &mut storage,
            "branch.delete",
            json!({"operationId":"remove-source","branchId":"base-source"}),
        )
        .unwrap();
        invoke(&mut storage,"working.result.candidate.release",json!({"operationId":"result-candidate-release:fixed-baseline","workspaceId":"workspace","branchId":"branch","candidateOperationId":"result-prepare:fixed-baseline"})).unwrap();
        let incidental:i64=storage.conn.query_row("SELECT COUNT(*) FROM (SELECT base_root AS root FROM branches UNION SELECT head_root FROM branches UNION SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins) WHERE root=?1",[&baseline],|row|row.get(0)).unwrap();
        assert_eq!(
            incidental, 0,
            "only original WorkingResult now retains this baseline tree"
        );
        storage.gc().unwrap();
        assert!(storage.load_node(&baseline).is_ok());
        // Deep health visits the same durable roots as collection, rather than only active heads.
        let health = storage.health(&json!({"deep":true})).unwrap();
        assert_eq!(health["integrity"], "ok", "{health}");
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn worker_retains_candidate_and_cancelled_completion_never_publishes_revision() {
        let (mut storage, root) = fixture();
        candidate(&mut storage, "cancelled");
        let request = json!({"operationId":"cancelled","workspaceId":"workspace","branchId":"branch","candidateOperationId":"result-prepare:cancelled"});
        let cancel = Arc::new(AtomicBool::new(false));
        let ResultPublicationAdmission::Work(task) = storage
            .prepare_result_publication(&request, "actor", cancel.clone())
            .unwrap()
        else {
            panic!("work")
        };
        assert!(invoke(&mut storage,"working.result.candidate.release",json!({"operationId":"result-candidate-release:cancelled","workspaceId":"workspace","branchId":"branch","candidateOperationId":"result-prepare:cancelled"})).is_err());
        let prepared = task.run().unwrap();
        cancel.store(true, Ordering::Release);
        assert!(storage
            .finish_result_publication(&task, prepared, "actor")
            .is_err());
        storage.release_result_publication_worker(&task);
        assert_eq!(storage.branch("branch").unwrap().head_revision, 0);
        assert!(storage
            .operation_get(&json!({"operationId":"cancelled"}))
            .unwrap()
            .is_null());
        assert!(invoke(&mut storage, "working.result.publish", request).is_ok());
        drop(storage);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod publication_body_tests {
    use super::tests::{fixture, invoke};
    use super::*;
    fn upload(storage: &mut Storage, id: &str, text: &str) -> Value {
        let params = json!({"operationId":id,"streamId":id,"workspaceId":"workspace","byteLength":text.len()});
        invoke(storage, "storage.putBlob.begin", params.clone()).unwrap();
        invoke(
            storage,
            "storage.putBlob.chunk",
            json!({"streamId":id,"sequence":0,"bytesBase64":BASE64.encode(text.as_bytes())}),
        )
        .unwrap();
        invoke(storage, "storage.putBlob.finish", params).unwrap()
    }
    #[test]
    fn real_text_publication_preserves_fixed_maps_and_nonzero_diff_statistics() {
        let (mut storage, root) = fixture();
        let before = upload(&mut storage, "before", "one\ntwo\nthree\n");
        invoke(&mut storage,"branch.create.begin",json!({"operationId":"text-create","builderId":"text-create","workspaceId":"workspace","branchId":"text","draftBasePaths":[],"captureScopes":[]})).unwrap();
        invoke(&mut storage,"branch.create.append",json!({"builderId":"text-create","sequence":0,"entries":[{"path":"a.txt","state":{"kind":"regular-file","objectHash":before["hash"],"byteLength":before["byteLength"],"mode":420},"ownerId":before["ownerId"]}]})).unwrap();
        invoke(
            &mut storage,
            "branch.create.finish",
            json!({"operationId":"text-create","builderId":"text-create"}),
        )
        .unwrap();
        let original = storage.branch("text").unwrap();
        let after = upload(&mut storage, "after", "one\nchanged\nthree\nfour\n");
        invoke(&mut storage,"branch.write.begin",json!({"operationId":"result-prepare:text-result","builderId":"text-result","branchId":"text","expectedWriteRevision":0})).unwrap();
        invoke(&mut storage,"branch.write.append",json!({"builderId":"text-result","sequence":0,"changes":[{"path":"a.txt","state":{"kind":"regular-file","objectHash":after["hash"],"byteLength":after["byteLength"],"mode":420},"ownerId":after["ownerId"]},{"path":"directory","state":{"kind":"directory"}}]})).unwrap();
        invoke(&mut storage,"working.result.prepare",json!({"operationId":"result-prepare:text-result","publicationId":"text-result","builderId":"text-result","expectedRoot":original.head_root})).unwrap();
        let published=invoke(&mut storage,"working.result.publish",json!({"operationId":"text-result","workspaceId":"workspace","branchId":"text","candidateOperationId":"result-prepare:text-result"})).unwrap();
        let result = invoke(
            &mut storage,
            "working.result.get",
            json!({"workspaceId":"workspace","recordId":published["recordId"]}),
        )
        .unwrap();
        assert_eq!(
            result["record"]["diffStats"],
            json!({"files":2,"insertions":2,"deletions":1})
        );
        assert_eq!(
            result["record"]["baseStates"]["a.txt"]["objectHash"],
            before["hash"]
        );
        assert_eq!(
            result["record"]["pathStates"]["a.txt"]["objectHash"],
            after["hash"]
        );
        assert_eq!(
            result["record"]["pathStates"]["directory"],
            json!({"kind":"directory"})
        );
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn source_provenance_commit_keeps_one_original_short_receipt_and_blob_reference() {
        let (mut storage, root) = fixture();
        let text = r#"{"consistency":"stable-capture","contentMode":"saved-files","captureScopes":[""],"omittedDraftPaths":["draft.txt"]}"#;
        let body = upload(&mut storage, "provenance", text);
        let request = json!({"operationId":"branch-create:captured","builderId":"captured","workspaceId":"workspace","branchId":"captured","draftBasePaths":[],"captureScopes":[],"sourceProvenance":{"objectHash":body["hash"],"ownerId":body["ownerId"]}});
        invoke(&mut storage, "branch.create.begin", request).unwrap();
        assert!(storage
            .operation_get(&json!({"operationId":"branch-create:captured"}))
            .unwrap()
            .is_null());
        let created = invoke(
            &mut storage,
            "branch.create.finish",
            json!({"operationId":"branch-create:captured","builderId":"captured"}),
        )
        .unwrap();
        assert_eq!(
            created["sourceProvenance"],
            json!({"objectHash":body["hash"],"recordId":"working-source:captured","slot":"source-provenance"})
        );
        let raw = serde_json::to_string(&created).unwrap();
        assert!(!raw.contains("omittedDraftPaths"));
        drop(storage);
        let storage = Storage::open(&root, "host").unwrap();
        let receipt = storage
            .operation_get(&json!({"operationId":"branch-create:captured"}))
            .unwrap();
        assert_eq!(receipt["result"], created);
        let retained:i64=storage.conn.query_row("SELECT COUNT(*) FROM domain_record_refs WHERE record_id='working-source:captured' AND object_hash=?1",[body["hash"].as_str().unwrap()],|r|r.get(0)).unwrap();
        assert_eq!(retained, 1);
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
