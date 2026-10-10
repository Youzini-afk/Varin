//! Bounded source authorization transfer under the original real parent grant. The receipt
//! delegates an exact source to one child, not a reusable credential or parent write permission.
use super::operations::idempotent;
use super::*;
use crate::tools::ToolBinding;
use varin_runtime::execution::ToolExecutionContext;

impl Storage {
    pub(crate) fn child_source_handoff(
        &mut self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        profile: &str,
        grant: &Grant,
        host_id: &str,
        authorize_only: bool,
    ) -> Result<Value, KernelError> {
        if !matches!(profile, "read_only" | "isolated_write")
            || !grant.path_scopes.iter().any(String::is_empty)
            || !(grant.capabilities.contains("storage.read")
                || grant.capabilities.contains("storage.admin"))
        {
            return Err(KernelError::Authorization("child source handoff requires whole-root read authority and an explicit supported profile".into()));
        }
        let source = binding.source_selection()?;
        let physical = if source.mode != varin_runtime::SourceMode::FixedBranch {
            let root = self.registered_file_root(
                binding.root_id.as_deref().ok_or_else(|| {
                    KernelError::Authorization("physical source root is missing".into())
                })?,
                grant,
            )?;
            Some(varin_runtime::catalog::launches::LiveRoot {
                host_id: host_id.into(),
                root_id: root.root_id,
                canonical_root: root.canonical_root.to_string_lossy().into_owned(),
            })
        } else {
            None
        };
        if authorize_only {
            return Ok(Value::Null);
        }
        let operation_id = format!("child-source-handoff:{}", context.operation_id);
        let identity = json!({"operationId":operation_id,"workspaceId":binding.workspace_id,"source":source,"physicalRoot":physical,
            "parentRunId":context.run_id,"parentThreadId":binding.thread_id,"childThreadId":format!("thread:child:{}",context.operation_id),"profile":profile});
        idempotent(self, "source.handoff", &identity, |storage| {
            let root = if let Some(root) = physical {
                json!({"kind":"physical","root":root})
            } else {
                let pin_id = format!("child-pin:{}", context.operation_id);
                let pinned = storage.branch_pin(
                    &json!({"branchId":source.branch_id,"revision":source.revision,"pinId":pin_id}),
                    true,
                    &grant.grant_id,
                )?;
                json!({"kind":"fixed","pin":{"pin_id":pin_id,"root":pinned["root"],"source":source}})
            };
            Ok(json!({"operation_id":operation_id,"source":source,"root":root}))
        })
    }
    pub(crate) fn child_storage_receipt(
        &self,
        binding: &ToolBinding,
        operation_id: &str,
        kind: &str,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let receipt = self.operation_get(&json!({"operationId":operation_id}))?;
        let workspace: Option<String> = self
            .conn
            .query_row(
                "SELECT workspace_id FROM operation_owners WHERE operation_id=?1",
                [operation_id],
                |row| row.get(0),
            )
            .optional()?;
        if workspace.as_deref() != Some(binding.workspace_id.as_str())
            || receipt["state"] != "committed"
            || receipt["kind"] != kind
        {
            return Err(KernelError::Authorization(
                "child storage receipt is unavailable or belongs to another source".into(),
            ));
        }
        if !grant.path_scopes.iter().any(String::is_empty) {
            return Err(KernelError::Authorization(
                "child receipt requires the whole private source".into(),
            ));
        }
        Ok(receipt["result"].clone())
    }
    pub(crate) fn require_child_root_idle(
        &self,
        binding: &ToolBinding,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let root = binding
            .root_id
            .as_deref()
            .ok_or_else(|| KernelError::Authorization("child root is missing".into()))?;
        self.assert_file_lease(
            grant,
            root,
            &[FileLeaseResource {
                path: String::new(),
                subtree: true,
            }],
            None,
        )?;
        let registered = self.registered_file_root(root, grant)?;
        Ok(json!({"rootId":root,"canonicalRoot":registered.canonical_root,"writerStopped":true}))
    }
}

impl Storage {
    pub(crate) fn claim_child_handoff(
        &mut self,
        params: &Value,
        handoff: &varin_runtime::catalog::collaboration::ChildSourceHandoff,
        host_id: &str,
        host_generation: &str,
        storage_identity: &str,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let receipt = self.operation_get(&json!({"operationId":handoff.operation_id}))?;
        if receipt["kind"] != "source.handoff"
            || receipt["state"] != "committed"
            || receipt["result"] != serde_json::to_value(handoff)?
        {
            return Err(KernelError::Authorization(
                "accepted child handoff has no matching Storage authority".into(),
            ));
        }
        let value=self.issue_grant(&json!({"grantId":params["grantId"],"hostGeneration":host_generation,
            "threadId":params["childThreadId"],"owningWorkspace":handoff.source.workspace_id,
            "executionWorkspace":handoff.source.execution_workspace_id,"capabilities":["storage.read","storage.write"],"pathScopes":[""]}),
            host_id,host_generation,storage_identity,epoch)?;
        let id = value["grant_id"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("source claim grant identity missing".into()))?;
        let mut grant = self.load_grant(id)?;
        if grant
            .handoff_operation_id
            .as_ref()
            .is_some_and(|old| old != &handoff.operation_id)
        {
            return Err(KernelError::Authorization(
                "source claim grant reused".into(),
            ));
        }
        grant.handoff_operation_id = Some(handoff.operation_id.clone());
        self.conn.execute(
            "UPDATE grants SET grant_json=?2 WHERE grant_id=?1",
            params![id, serde_json::to_string(&grant)?],
        )?;
        Ok(serde_json::to_value(grant)?)
    }
    pub(super) fn authorize_child_handoff(
        &self,
        grant: &Grant,
        method: &str,
        params: &Value,
    ) -> Result<(), KernelError> {
        let Some(id) = grant.handoff_operation_id.as_deref() else {
            return Ok(());
        };
        let result = self.operation_get(&json!({"operationId":id}))?["result"].clone();
        let handoff: varin_runtime::catalog::collaboration::ChildSourceHandoff =
            serde_json::from_value(result)?;
        let dispatch = id
            .strip_prefix("child-source-handoff:")
            .ok_or_else(|| KernelError::Authorization("corrupt handoff identity".into()))?;
        let branch = format!("child-source:{dispatch}");
        let deny = || {
            KernelError::Authorization(
                "preparation grant exceeds the accepted child source handoff".into(),
            )
        };
        let allowed = matches!(
            method,
            "storage.health"
                | "storage.getBlob"
                | "storage.putBlob.begin"
                | "storage.putBlob.chunk"
                | "storage.putBlob.finish"
                | "storage.putBlob.abort"
                | "storage.blob.release"
                | "branch.create.begin"
                | "branch.create.append"
                | "branch.create.finish"
                | "branch.create.abort"
                | "branch.read"
                | "branch.pin"
                | "branch.unpin"
                | "branch.delete"
                | "pin.read"
                | "file.root.register"
                | "file.scan"
                | "file.read"
                | "file.read.check"
                | "file.capture"
                | "file.captureBatch"
                | "file.lease.acquire"
                | "file.lease.check"
                | "file.lease.release"
                | "compute.start"
                | "compute.read"
                | "compute.cancel"
                | "compute.release"
                | "compute.status"
                | "operation.get"
        );
        if !allowed {
            return Err(deny());
        }
        if let Some(actual) = params.get("branchId").and_then(Value::as_str) {
            if actual != branch {
                let parent = match &handoff.root {
                    varin_runtime::catalog::collaboration::ChildSourceRoot::Fixed { pin } => pin,
                    _ => return Err(deny()),
                };
                if actual != parent.source.branch_id.as_deref().unwrap_or("")
                    || !matches!(method, "branch.read" | "branch.unpin")
                {
                    return Err(deny());
                }
                if method == "branch.read"
                    && params.get("includeEntries").and_then(Value::as_bool) != Some(false)
                    && params.get("revision").and_then(Value::as_u64) != parent.source.revision
                {
                    return Err(deny());
                }
            }
        }
        if method == "branch.create.begin" {
            if params["branchId"] != branch
                || params["operationId"] != format!("branch-create:{branch}")
            {
                return Err(deny());
            }
            if let varin_runtime::catalog::collaboration::ChildSourceRoot::Fixed { pin } =
                &handoff.root
            {
                if params["baseRef"] != pin.root {
                    return Err(deny());
                }
            } else if params.get("baseRef").is_some() {
                return Err(deny());
            }
        }
        if let Some(pin) = params.get("pinId").and_then(Value::as_str) {
            let parent = match &handoff.root {
                varin_runtime::catalog::collaboration::ChildSourceRoot::Fixed { pin } => {
                    Some(pin.pin_id.as_str())
                }
                _ => None,
            };
            if Some(pin) != parent && pin != format!("child-source-pin:{dispatch}") {
                return Err(deny());
            }
        }
        let parent_branch = match &handoff.root {
            varin_runtime::catalog::collaboration::ChildSourceRoot::Fixed { pin } => pin.source.branch_id.as_deref(),
            _ => None,
        };
        if let Some(record) = params.get("recordId").and_then(Value::as_str) {
            if method != "storage.getBlob"
                || (record != format!("working-source:{branch}")
                    && !parent_branch.is_some_and(|parent| record == format!("working-source:{parent}")))
                || params["slot"] != "source-provenance"
            {
                return Err(deny());
            }
        }
        if method == "operation.get"
            && params["operationId"] != id
            && params["operationId"] != format!("branch-create:{branch}")
            && !parent_branch.is_some_and(|parent| params["operationId"] == format!("branch-create:{parent}"))
        {
            return Err(deny());
        }
        if method.starts_with("file.") || method == "compute.start" {
            let root = match &handoff.root {
                varin_runtime::catalog::collaboration::ChildSourceRoot::Physical { root } => root,
                _ => return Err(deny()),
            };
            if let Some(actual) = params.get("rootId").and_then(Value::as_str) {
                if actual != root.root_id {
                    return Err(deny());
                }
            }
            if method == "file.root.register" && params["canonicalRoot"] != root.canonical_root {
                return Err(deny());
            }
            if method == "compute.start" && params["operation"] != "inventory" {
                return Err(deny());
            }
        }
        Ok(())
    }
}

impl Storage {
    /// Trusted Catalog inspection of an original journal, independent of current disk access.
    pub(crate) fn integration_receipt(
        &self,
        read: &crate::tools::IntegrationReceiptRead,
    ) -> Result<Value, KernelError> {
        let id = format!("integration:{}", read.operation_id);
        let receipt = self.read_recovery_operation(&read.source.workspace_id, &id, None)?;
        if receipt.is_null() {
            return Ok(receipt);
        }
        if receipt["kind"] != "integration"
            || receipt["runId"] != read.run_id
            || receipt["threadId"] != read.thread_id
        {
            return Err(KernelError::Authorization(
                "Integration journal owner differs from Catalog invocation".into(),
            ));
        }
        let mut data = receipt["data"]
            .as_object()
            .ok_or_else(|| KernelError::Storage("Integration data malformed".into()))?
            .clone();
        if let Some(result) = receipt["result"].as_object() {
            data.extend(result.clone());
        }
        let source = &read.source;
        if data
            .get("operationBinding")
            .and_then(|value| value.get("target"))
            != Some(&serde_json::to_value(source)?)
        {
            return Err(KernelError::Authorization(
                "Integration journal target differs from original source".into(),
            ));
        }
        let expected = match source.mode {
            varin_runtime::SourceMode::LiveRoot => PathBuf::from(
                &source
                    .live_root
                    .as_ref()
                    .ok_or_else(|| KernelError::Storage("live source identity missing".into()))?
                    .canonical_root,
            ),
            varin_runtime::SourceMode::Materialized => {
                let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([
                    source.workspace_id,
                    source.environment_run_id.as_deref().unwrap_or(&read.run_id)
                ]))?));
                let materialization = self
                    .operation_get(&json!({"operationId":format!("source-materialize:{key}")}))?;
                if materialization["kind"] != "file.materialize"
                    || materialization["state"] != "committed"
                    || materialization["result"]["status"] != "materialized"
                {
                    return Err(KernelError::Authorization(
                        "Integration source has no original materialization receipt".into(),
                    ));
                }
                self.root.join("managed").join("runs").join(key)
            }
            _ => {
                return Err(KernelError::Authorization(
                    "fixed source has no Integration target".into(),
                ))
            }
        };
        if data.get("applyCanonicalRoot").and_then(Value::as_str) != expected.to_str() {
            return Err(KernelError::Authorization(
                "Integration journal changed its admitted physical identity".into(),
            ));
        }
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    fn invoke(
        storage: &mut Storage,
        actor: &str,
        method: &str,
        value: Value,
    ) -> Result<Value, KernelError> {
        let (grant, params) =
            storage.authorize(Some(actor), "epoch", "host", "generation", method, &value)?;
        storage.dispatch(method, &params, Some(actor), &grant)
    }
    fn grant(storage: &mut Storage, id: &str, workspace: &str) {
        let identity = storage.root.to_string_lossy().into_owned();
        storage.issue_grant(&json!({"grantId":id,"hostGeneration":"generation","owningWorkspace":workspace,"executionWorkspace":workspace,
            "threadId":"thread","runId":"run","pathScopes":[""],"capabilities":["storage.read","storage.write","recovery"]}),
            "host","generation",&identity,"epoch").unwrap();
    }
    fn journal(
        storage: &mut Storage,
        actor: &str,
        workspace: &str,
        id: &str,
        data: Value,
        state: &str,
    ) {
        invoke(storage,actor,"recovery.operation.create",json!({"workspaceId":workspace,"operationId":id,"kind":"integration","state":state,
            "threadId":"thread","runId":"run","dataJson":serde_json::to_string(&data).unwrap(),"files":[]})).unwrap();
    }
    #[test]
    fn original_materialized_receipt_survives_removed_execution_directory() {
        let root = std::env::temp_dir().join(format!("varin-integration-read-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&root, "host").unwrap();
        grant(&mut storage, "actor", "workspace");
        invoke(&mut storage,"actor","branch.create.begin",json!({"operationId":"create","builderId":"create","workspaceId":"workspace","branchId":"branch","draftBasePaths":[],"captureScopes":[]})).unwrap();
        invoke(
            &mut storage,
            "actor",
            "branch.create.finish",
            json!({"operationId":"create","builderId":"create"}),
        )
        .unwrap();
        let source:varin_runtime::catalog::launches::SourceSelection=serde_json::from_value(json!({"mode":"materialized","workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":"branch","revision":0,"live_root":null,"environment_run_id":"environment-run"})).unwrap();
        let key = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!(["workspace", "environment-run"])).unwrap(),
        ));
        let managed = root.join("managed/runs");
        fs::create_dir_all(&managed).unwrap();
        let registered=invoke(&mut storage,"actor","file.root.register",json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":managed})).unwrap();
        let branch = storage.branch("branch").unwrap();
        let params = json!({"operationId":format!("source-materialize:{key}"),"workspaceId":"workspace","rootId":registered["rootId"],"path":key,"sourceRoot":branch.head_root});
        let permit = storage.load_grant("actor").unwrap();
        let super::super::materialization::Admission::Work(task) = storage
            .prepare_materialization(&params, &permit, Arc::new(AtomicBool::new(false)))
            .unwrap()
        else {
            panic!("new materialization")
        };
        let result = task
            .run(|control| {
                storage.control_materialization(&task.operation_id, &task.job_id, control, false)
            })
            .unwrap();
        storage.finish_materialization(&task.operation_id, &task.job_id);
        assert_eq!(result["status"], "materialized");
        let directory = managed.join(&key);
        assert!(directory.is_dir());
        journal(
            &mut storage,
            "actor",
            "workspace",
            "integration:tool",
            json!({"operationBinding":{"target":source},"applyCanonicalRoot":directory,"executorStopped":true}),
            "complete",
        );
        fs::remove_dir_all(&directory).unwrap();
        storage
            .revoke_grant(&json!({"grantId":"actor"}), "host")
            .unwrap();
        let (reply, _) = mpsc::channel();
        let read = crate::tools::IntegrationReceiptRead {
            source: source.clone(),
            run_id: "run".into(),
            thread_id: "thread".into(),
            operation_id: "tool".into(),
            reply,
        };
        let receipt = storage.integration_receipt(&read).unwrap();
        assert_eq!(receipt["state"], "complete");
        assert_eq!(receipt["data"]["executorStopped"], true);
        let mut wrong = read;
        wrong.source.environment_run_id = Some("other".into());
        assert!(storage.integration_receipt(&wrong).is_err());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn reservations_conflict_across_workspaces_and_parent_symlink_aliases() {
        let root = std::env::temp_dir().join(format!("varin-reservation-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&root, "host").unwrap();
        grant(&mut storage, "a", "workspace-a");
        grant(&mut storage, "b", "workspace-b");
        let physical = root.join("physical");
        fs::create_dir_all(physical.join("real")).unwrap();
        fs::write(physical.join("real/a.txt"), b"original").unwrap();
        std::os::unix::fs::symlink("real", physical.join("alias")).unwrap();
        let a=invoke(&mut storage,"a","file.root.register",json!({"workspaceId":"workspace-a","executionWorkspaceId":"workspace-a","canonicalRoot":physical})).unwrap();
        journal(
            &mut storage,
            "b",
            "workspace-b",
            "reserved",
            json!({"reservedResources":{"canonicalRoot":physical.join("real"),"paths":["a.txt"]}}),
            "needs-attention",
        );
        let query = json!({"workspaceId":"workspace-a","rootId":a["rootId"],"paths":["alias/a.txt"],"exceptOperationId":"reserved"});
        let found = invoke(
            &mut storage,
            "a",
            "recovery.operation.conflicts",
            query.clone(),
        )
        .unwrap();
        assert_eq!(found["operations"].as_array().unwrap().len(), 1);
        assert_eq!(found["operations"][0]["workspaceId"], "workspace-b");
        let mut no_overlap = query.clone();
        no_overlap["paths"] = json!(["other.txt"]);
        assert_eq!(
            invoke(
                &mut storage,
                "a",
                "recovery.operation.conflicts",
                no_overlap
            )
            .unwrap()["operations"],
            json!([])
        );
        // A symlink leaf itself is a replacement target, not an alias of its contents.
        let mut leaf = query.clone();
        leaf["paths"] = json!(["alias"]);
        assert_eq!(
            invoke(&mut storage, "a", "recovery.operation.conflicts", leaf).unwrap()["operations"],
            json!([])
        );
        fs::remove_dir_all(physical.join("real")).unwrap();
        let mut unrelated = query.clone();
        unrelated["paths"] = json!(["other.txt"]);
        assert_eq!(
            invoke(&mut storage, "a", "recovery.operation.conflicts", unrelated).unwrap()
                ["operations"],
            json!([])
        );
        let mut missing_target = query.clone();
        missing_target["paths"] = json!(["real/a.txt"]);
        assert_eq!(
            invoke(
                &mut storage,
                "a",
                "recovery.operation.conflicts",
                missing_target
            )
            .unwrap()["operations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        journal(
            &mut storage,
            "b",
            "workspace-b",
            "unresolved",
            json!({}),
            "planned",
        );
        assert!(invoke(&mut storage, "a", "recovery.operation.conflicts", query).is_err());
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod handoff_tests {
    use super::*;
    use crate::tools::{FixedFileSource, ToolKind};
    use varin_runtime::{execution::ToolOrigin, SourceMode};
    fn invoke(storage:&mut Storage, actor:&str, method:&str, params:Value)->Result<Value,KernelError>{
        let (grant,params)=storage.authorize(Some(actor),"epoch","host","generation",method,&params)?;
        storage.dispatch(method,&params,Some(actor),&grant)
    }
    #[test]
    fn readonly_fixed_parent_dispatch_claim_only_authorizes_its_exact_private_source() {
        let root = std::env::temp_dir().join(format!("varin-handoff-scope-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&root, "host").unwrap();
        let identity = root.to_string_lossy().into_owned();
        storage.issue_grant(&json!({"grantId":"parent","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"parent-thread","runId":"parent-run","pathScopes":[""],"capabilities":["storage.read","storage.write"]}),"host","generation",&identity,"epoch").unwrap();
        let parent = storage.load_grant("parent").unwrap();
        let text=r#"{"resources":{"skills":["captured-resource"]}}"#;
        let upload=json!({"operationId":"provenance","streamId":"provenance","workspaceId":"workspace","byteLength":text.len()});
        invoke(&mut storage,"parent","storage.putBlob.begin",upload.clone()).unwrap();
        invoke(&mut storage,"parent","storage.putBlob.chunk",json!({"streamId":"provenance","sequence":0,"bytesBase64":BASE64.encode(text.as_bytes())})).unwrap();
        let body=invoke(&mut storage,"parent","storage.putBlob.finish",upload).unwrap();
        for (method, params) in [
            (
                "branch.create.begin",
                json!({"operationId":"branch-create:fixed","builderId":"create","workspaceId":"workspace","branchId":"fixed","draftBasePaths":[],"captureScopes":[],"sourceProvenance":{"objectHash":body["hash"],"ownerId":body["ownerId"]}}),
            ),
            (
                "branch.create.finish",
                json!({"operationId":"branch-create:fixed","builderId":"create"}),
            ),
        ] {
            let (grant, p) = storage
                .authorize(
                    Some("parent"),
                    "epoch",
                    "host",
                    "generation",
                    method,
                    &params,
                )
                .unwrap();
            storage
                .dispatch(method, &p, Some("parent"), &grant)
                .unwrap();
        }
        let binding = ToolBinding {
            grant_id: "parent".into(),
            run_id: "parent-run".into(),
            thread_id: "parent-thread".into(),
            workspace_id: "workspace".into(),
            execution_workspace_id: "workspace".into(),
            root_id: None,
            file_source: Some(FixedFileSource {
                branch_id: "fixed".into(),
                revision: 0,
            }),
            source_mode: SourceMode::FixedBranch,
            materialized_source: None,
            live_root: None,
            environment_run_id: None,
            enabled_tools: [ToolKind::FileRead].into_iter().collect(),
        };
        let context = ToolExecutionContext {
            run_id: "parent-run".into(),
            origin: ToolOrigin::ModelStep {
                request_id: "request".into(),
            },
            operation_id: "request:tool:dispatch".into(),
        };
        let original = storage
            .child_source_handoff(&binding, &context, "isolated_write", &parent, "host", false)
            .unwrap();
        let handoff = serde_json::from_value(original).unwrap();
        storage
            .revoke_grant(&json!({"grantId":"parent"}), "host")
            .unwrap();
        storage
            .claim_child_handoff(
                &json!({"grantId":"claim","childThreadId":"thread:child:request:tool:dispatch"}),
                &handoff,
                "host",
                "generation",
                &identity,
                "epoch",
            )
            .unwrap();
        let original=invoke(&mut storage,"claim","operation.get",json!({"operationId":"branch-create:fixed"})).unwrap();
        assert_eq!(original["result"]["sourceProvenance"]["objectHash"],body["hash"]);
        let bytes=invoke(&mut storage,"claim","storage.getBlob",json!({"hash":body["hash"],"recordId":"working-source:fixed","slot":"source-provenance"})).unwrap();
        assert_eq!(bytes["bytesBase64"],BASE64.encode(text.as_bytes()));
        for (method,params) in [
            ("operation.get",json!({"operationId":"branch-create:other-parent"})),
            ("storage.getBlob",json!({"hash":body["hash"],"recordId":"working-source:other-parent","slot":"source-provenance"})),
            ("storage.getBlob",json!({"hash":body["hash"],"recordId":"working-source:fixed","slot":"other-slot"})),
        ] {
            assert!(invoke(&mut storage,"claim",method,params).is_err(),"must reject unrelated parent receipt/record/slot");
        }
        let good = json!({"operationId":"branch-create:child-source:request:tool:dispatch","builderId":"child","workspaceId":"workspace","branchId":"child-source:request:tool:dispatch","baseRef":storage.branch("fixed").unwrap().head_root,"draftBasePaths":[],"captureScopes":[]});
        assert!(storage
            .authorize(
                Some("claim"),
                "epoch",
                "host",
                "generation",
                "branch.create.begin",
                &good
            )
            .is_ok());
        for (method, params) in [
            (
                "branch.write.begin",
                json!({"operationId":"write","builderId":"write","branchId":"fixed","expectedWriteRevision":0}),
            ),
            ("branch.create.begin", {
                let mut p = good.clone();
                p["branchId"] = json!("unrelated");
                p
            }),
            (
                "file.apply",
                json!({"operationId":"parent-write","rootId":"parent","path":"a","workspaceId":"workspace"}),
            ),
        ] {
            assert!(
                storage
                    .authorize(
                        Some("claim"),
                        "epoch",
                        "host",
                        "generation",
                        method,
                        &params
                    )
                    .is_err(),
                "claim must reject {method}"
            );
        }
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
