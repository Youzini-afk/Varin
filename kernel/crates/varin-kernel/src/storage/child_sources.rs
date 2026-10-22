//! Bounded source authorization transfer under the original real parent grant. The receipt
//! delegates an exact source to one child, not a reusable credential or parent write permission.
use super::operations::idempotent;
use super::*;
use crate::tools::ToolBinding;
use varin_runtime::execution::ToolExecutionContext;

impl Storage {
    /// Actual registered physical identity, separate from the durable source selection.
    pub(crate) fn source_physical_root(
        &self,
        binding: &ToolBinding,
        grant: &Grant,
        host_id: &str,
    ) -> Result<Option<varin_runtime::catalog::launches::LiveRoot>, KernelError> {
        if binding.source_mode == varin_runtime::SourceMode::FixedBranch {
            return Ok(None);
        }
        let root = self.registered_file_root(
            binding.root_id.as_deref().ok_or_else(|| {
                KernelError::Authorization("physical source root is missing".into())
            })?,
            grant,
        )?;
        Ok(Some(varin_runtime::catalog::launches::LiveRoot {
            host_id: host_id.into(),
            root_id: root.root_id,
            canonical_root: root.canonical_root.to_string_lossy().into_owned(),
        }))
    }
    pub(crate) fn child_source_handoff(
        &mut self,
        binding: &ToolBinding,
        context: &ToolExecutionContext,
        delegation: &varin_runtime::catalog::dispatch::ChildSourceDelegation,
        grant: &Grant,
        host_id: &str,
        authorize_only: bool,
    ) -> Result<Value, KernelError> {
        if !grant.path_scopes.iter().any(String::is_empty)
            || !(grant.capabilities.contains("storage.read")
                || grant.capabilities.contains("storage.admin"))
        {
            return Err(KernelError::Authorization("child source handoff requires whole-root read authority and an explicit supported profile".into()));
        }
        if delegation.process
            && (delegation.work_mode
                == varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly
                || (!delegation.configured_preset && !grant.capabilities.contains("process")))
        {
            return Err(KernelError::Authorization("process delegation requires the frozen configured capability or original parent process authority".into()));
        }
        let source = delegation.agent_source.as_ref().map(|s|s.source.clone()).unwrap_or(binding.source_selection()?);
        let physical = if let Some(stage)=&delegation.agent_source {
            if source.workspace_id!=binding.workspace_id || source.resource_owner!=binding.resource_owner {
                return Err(KernelError::Authorization("stage source belongs to another resource owner".into()));
            }
            match source.mode {
                varin_runtime::SourceMode::FixedBranch=>{
                    let view_id=format!("run-execution:{}",stage.run_id);
                    match self.materialized_view_record(&source.workspace_id,&view_id)? {
                        Some(record) if record["branchId"]==json!(source.branch_id) && record["revision"]==json!(source.revision)=>{
                            let original=self.load_grant(record["ownerGrantId"].as_str().ok_or_else(||KernelError::Storage("Selected execution view owner missing".into()))?)?;
                            if original.run_id.as_deref()!=Some(&stage.run_id) || original.owning_workspace.as_deref()!=Some(&source.workspace_id)
                                || original.execution_workspace.as_deref().or(original.owning_workspace.as_deref())!=Some(&source.execution_workspace_id) {
                                return Err(KernelError::Authorization("Selected execution view belongs to another Run source".into()));
                            }
                            match (self.source_authority_for_grant(&grant.grant_id)?,self.source_authority_for_grant(&original.grant_id)?) {
                                (None,None)=>{},
                                (Some(caller),Some(owner)) if caller.principal_id==owner.principal_id && caller.coordinator_host_id==owner.coordinator_host_id && owner.result.source==source=>{},
                                _=>return Err(KernelError::Authorization("Selected execution view belongs to another authenticated owner".into())),
                            }
                            let view=self.inspect_execution_view(&json!({"workspaceId":source.workspace_id,"branchId":source.branch_id,"revision":source.revision}),&original)?;
                            if view["status"]!="ready" {return Err(KernelError::Operation("Selected Agent execution view preparation has not completed".into()));}
                            Some(varin_runtime::catalog::launches::LiveRoot{host_id:host_id.into(),root_id:view["rootId"].as_str().unwrap().into(),canonical_root:view["canonicalRoot"].as_str().unwrap().into()})
                        },_=>None,
                    }
                },
                _=>{
                    let directory=if source.mode==varin_runtime::SourceMode::LiveRoot {
                        PathBuf::from(&source.live_root.as_ref().ok_or_else(||KernelError::Storage("stage live root missing".into()))?.canonical_root)
                    } else {
                        let key=hex::encode(Sha256::digest(serde_json::to_vec(&json!([source.workspace_id,source.environment_run_id.as_deref().unwrap_or(&stage.run_id)]))?));
                        let receipt=self.operation_get(&json!({"operationId":format!("source-materialize:{key}")}))?;
                        if receipt["state"]!="committed" || receipt["result"]["status"]!="materialized" {return Err(KernelError::Storage("stage execution directory is unavailable".into()))}
                        self.root.join("managed").join("runs").join(key)
                    };
                    // Catalog delegated this exact related Run's file view. Keep the
                    // original caller grant; register only the selected execution root.
                    let mut stage_grant=grant.clone();
                    stage_grant.execution_workspace=Some(source.execution_workspace_id.clone());
                    let root=self.file_root_register(&json!({"workspaceId":source.workspace_id,"executionWorkspaceId":source.execution_workspace_id,"canonicalRoot":directory}),&stage_grant)?;
                    Some(varin_runtime::catalog::launches::LiveRoot{host_id:host_id.into(),root_id:root["rootId"].as_str().ok_or_else(||KernelError::Storage("stage root missing".into()))?.into(),canonical_root:root["canonicalRoot"].as_str().ok_or_else(||KernelError::Storage("stage directory missing".into()))?.into()})
                }
            }
        } else if let Some(effective)=self.execution_tool_binding(binding,grant)? {
            self.source_physical_root(&effective,grant,host_id)?
        } else { self.source_physical_root(binding, grant, host_id)? };
        if authorize_only {
            return Ok(Value::Null);
        }
        let operation_id = format!("child-source-handoff:{}", context.operation_id);
        let identity = json!({"operationId":operation_id,"workspaceId":binding.workspace_id,"source":source,"physicalRoot":physical,
            "parentRunId":context.run_id,"parentThreadId":binding.thread_id,"childThreadId":format!("thread:child:{}",context.operation_id),"delegation":delegation});
        idempotent(self, "source.handoff", &identity, |storage| {
            let root = if let Some(root) = physical.as_ref().filter(|_|source.mode!=varin_runtime::SourceMode::FixedBranch) {
                json!({"kind":"physical","root":root})
            } else {
                let pin_id = format!("child-pin:{}", context.operation_id);
                let pinned = storage.branch_pin(
                    &json!({"branchId":source.branch_id,"revision":source.revision,"pinId":pin_id}),
                    true,
                    &grant.grant_id,
                )?;
                let pin=json!({"pin_id":pin_id,"root":pinned["root"],"source":source});
                if let Some(root)=&physical {
                    json!({"kind":"derived","pin":pin,"root":root,"view_id":format!("run-execution:{}",delegation.agent_source.as_ref().map(|stage|stage.run_id.as_str()).unwrap_or(&binding.run_id))})
                } else { json!({"kind":"fixed","pin":pin}) }
            };
            Ok(
                { let mut handoff=json!({"operation_id":operation_id,"source":source,"root":root,"resource_authority":binding.target_authority.as_ref().map(|authority|json!({"authority_id":authority.authority_id,"resource_epoch":authority.resource_epoch}))});
                  if let Some(stage)=&delegation.agent_source {handoff["source_run_id"]=json!(stage.run_id);} handoff },
            )
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
        if binding.target_authority.is_some() {
            let candidate = match kind {
                "working.result.prepare" => receipt["result"].clone(),
                "working.result.publish" => self.operation_get(
                    &json!({"operationId":format!("result-prepare:{operation_id}")}),
                )?["result"]
                    .clone(),
                _ => {
                    return Err(KernelError::Authorization(
                        "Managed child receipt kind is unavailable".into(),
                    ))
                }
            };
            let original = candidate["ownerGrantId"].as_str().ok_or_else(|| {
                KernelError::Authorization("Child result creation grant missing".into())
            })?;
            self.validate_source_grant_owner(&grant.grant_id, original)?;
        }
        let mut result=receipt["result"].clone();
        if kind=="working.result.publish" {
            let record=self.working_record_get(&json!({"workspaceId":result["workspaceId"],"recordId":result["recordId"]}), &grant.grant_id,"working.result")?;
            result["changedPaths"]=record["record"]["changedPaths"].clone();
        }
        Ok(result)
    }
    pub(crate) fn require_child_root_idle(
        &mut self,
        binding: &ToolBinding,
        grant: &Grant,
    ) -> Result<Value, KernelError> {
        let effective;
        let binding=if binding.source_mode==varin_runtime::SourceMode::FixedBranch {
            let params=Storage::execution_view_params(binding)?;
            let view=self.inspect_execution_view(&json!({"workspaceId":binding.workspace_id,"branchId":params["branchId"],"revision":params["revision"]}),grant)?;
            if view.is_null() {return Ok(json!({"physical":false,"writerStopped":true}));}
            // No command can start until preparation commits. Interrupted copy
            // resources are reclaimed by their original materialization journal.
            if view["status"]=="interrupted" {return Ok(json!({"physical":false,"writerStopped":true}));}
            if view["status"]=="preparing" {return Ok(json!({"physical":false,"writerStopped":false}));}
            effective=self.execution_tool_binding(binding,grant)?.ok_or_else(||KernelError::Storage("Execution view disappeared during settlement".into()))?;
            &effective
        } else {binding};
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
        let path = std::path::PathBuf::from(&registered.canonical_root);
        let stopped = self.process_directory_writer(&path)?.is_none();
        Ok(json!({"physical":true,"rootId":root,"canonicalRoot":path,"writerStopped":stopped}))
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
        if handoff.refresh.is_some() {
            return self.authorize_child_refresh(grant, dispatch, &handoff, method, params);
        }
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
                | "file.lease.wait"
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
                    varin_runtime::catalog::collaboration::ChildSourceRoot::Fixed { pin }
                        | varin_runtime::catalog::collaboration::ChildSourceRoot::Derived { pin, .. } => pin,
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
                varin_runtime::catalog::collaboration::ChildSourceRoot::Fixed { pin }
                    | varin_runtime::catalog::collaboration::ChildSourceRoot::Derived { pin, .. } => {
                    Some(pin.pin_id.as_str())
                }
                _ => None,
            };
            if Some(pin) != parent && pin != format!("child-source-pin:{dispatch}") {
                return Err(deny());
            }
        }
        let parent_branch = match &handoff.root {
            varin_runtime::catalog::collaboration::ChildSourceRoot::Fixed { pin }
                | varin_runtime::catalog::collaboration::ChildSourceRoot::Derived { pin, .. } => {
                pin.source.branch_id.as_deref()
            }
            _ => None,
        };
        if let Some(record) = params.get("recordId").and_then(Value::as_str) {
            if method != "storage.getBlob"
                || (record != format!("working-source:{branch}")
                    && !parent_branch
                        .is_some_and(|parent| record == format!("working-source:{parent}")))
                || params["slot"] != "source-provenance"
            {
                return Err(deny());
            }
        }
        if method == "operation.get"
            && params["operationId"] != id
            && params["operationId"] != format!("branch-create:{branch}")
            && !parent_branch
                .is_some_and(|parent| params["operationId"] == format!("branch-create:{parent}"))
        {
            return Err(deny());
        }
        if method.starts_with("file.") || method == "compute.start" {
            let root = match &handoff.root {
                varin_runtime::catalog::collaboration::ChildSourceRoot::Physical { root }
                    | varin_runtime::catalog::collaboration::ChildSourceRoot::Derived { root, .. } => root,
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

    /// Refresh reads its two fixed stages and writes the new private baseline.
    fn authorize_child_refresh(&self, grant:&Grant, execution:&str,
        handoff:&varin_runtime::catalog::collaboration::ChildSourceHandoff,
        method:&str, params:&Value) -> Result<(),KernelError> {
        let deny=||KernelError::Authorization("operation exceeds this continuation's source preparation".into());
        let parent=handoff.source.branch_id.as_deref().ok_or_else(deny)?;
        let source=format!("child-source:{execution}");
        let incoming=format!("child-incoming:{execution}");
        let merged=format!("child-refresh:{execution}");
        let readable=[parent,source.as_str(),incoming.as_str(),merged.as_str()];
        let writable=[source.as_str(),merged.as_str()];
        if !matches!(method,"storage.health"|"storage.getBlob"|"storage.putBlob.begin"|"storage.putBlob.chunk"|
            "storage.putBlob.finish"|"storage.putBlob.abort"|"storage.blob.release"|"branch.create.begin"|
            "branch.create.append"|"branch.create.finish"|"branch.create.abort"|"branch.read"|"branch.pin"|
            "branch.unpin"|"branch.delete"|"pin.read"|"operation.get"|"working.result.get") { return Err(deny()); }
        if let Some(branch)=params.get("branchId").and_then(Value::as_str) {
            if !readable.contains(&branch) { return Err(deny()); }
            if method.starts_with("branch.create.") && !writable.contains(&branch) {return Err(deny());}
            if method=="branch.read" && params["includeEntries"]!=false {
                let expected=if branch==parent {handoff.source.revision.unwrap_or(0)} else {0};
                if params["revision"].as_u64()!=Some(expected) {return Err(deny());}
            }
            if method=="branch.delete" && branch!=incoming && !writable.contains(&branch) {return Err(deny());}
        }
        if method=="branch.create.begin" {
            let branch=params["branchId"].as_str().ok_or_else(deny)?;
            if params["operationId"]!=format!("branch-create:{branch}"){return Err(deny());}
            if branch==source {
                let prior=self.branch(&merged)?;
                if params["baseRef"]!=prior.base_root || params["parentRef"]!=format!("{merged}@0") {return Err(deny());}
            } else if params.get("baseRef").is_some() {return Err(deny());}
        }
        if method=="pin.read" {
            let pin=params["pinId"].as_str().ok_or_else(deny)?;
            let owned:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM pins WHERE pin_id=?1 AND grant_id=?2)",
                params![pin,grant.grant_id],|r|r.get(0))?;
            if !owned {return Err(deny());}
        }
        let result_id=format!("working-result:{parent}@{}",handoff.source.revision.unwrap_or(0));
        if let Some(record)=params.get("recordId").and_then(Value::as_str) {
            if method=="working.result.get" {
                if record!=result_id {return Err(deny());}
            } else if method=="storage.getBlob" {
                if record!=result_id && !readable.iter().any(|branch|record==format!("working-source:{branch}")) {return Err(deny());}
            } else {return Err(deny());}
        }
        if method=="operation.get" && params["operationId"]!=handoff.operation_id
            && !readable.iter().any(|branch|params["operationId"]==format!("branch-create:{branch}")) {return Err(deny());}
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
        let exchange=data.get("operationBinding").and_then(|v|v.get("kind")).and_then(Value::as_str)==Some("code_exchange");
        let target=if exchange {serde_json::from_value::<varin_runtime::catalog::launches::SourceSelection>(data["operationBinding"]["target"].clone())?}else{read.source.clone()};
        let source = &target;
        if source.workspace_id!=read.source.workspace_id || source.resource_owner!=read.source.resource_owner {
            return Err(KernelError::Authorization("file exchange journal belongs to another resource owner".into()));
        }
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
                    source.environment_run_id.as_deref().unwrap_or(if exchange {data["operationBinding"]["targetRunId"].as_str().ok_or_else(||KernelError::Storage("exchange target Run missing".into()))?}else{&read.run_id})
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
        let source:varin_runtime::catalog::launches::SourceSelection=serde_json::from_value(json!({"resource_owner":{"kind":"local"},"mode":"materialized","workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":"branch","revision":0,"live_root":null,"environment_run_id":"environment-run"})).unwrap();
        let key = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!(["workspace", "environment-run"])).unwrap(),
        ));
        let managed = root.join("managed").join("runs");
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
    fn invoke(
        storage: &mut Storage,
        actor: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, KernelError> {
        let (grant, params) =
            storage.authorize(Some(actor), "epoch", "host", "generation", method, &params)?;
        storage.dispatch(method, &params, Some(actor), &grant)
    }
    #[test]
    fn readonly_fixed_parent_dispatch_claim_only_authorizes_its_exact_private_source() {
        let root = std::env::temp_dir().join(format!("varin-handoff-scope-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&root, "host").unwrap();
        let identity = root.to_string_lossy().into_owned();
        storage.issue_grant(&json!({"grantId":"parent","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"parent-thread","runId":"parent-run","pathScopes":[""],"capabilities":["storage.read","storage.write"]}),"host","generation",&identity,"epoch").unwrap();
        let parent = storage.load_grant("parent").unwrap();
        let text = r#"{"resources":{"skills":["captured-resource"]}}"#;
        let upload = json!({"operationId":"provenance","streamId":"provenance","workspaceId":"workspace","byteLength":text.len()});
        invoke(
            &mut storage,
            "parent",
            "storage.putBlob.begin",
            upload.clone(),
        )
        .unwrap();
        invoke(&mut storage,"parent","storage.putBlob.chunk",json!({"streamId":"provenance","sequence":0,"bytesBase64":BASE64.encode(text.as_bytes())})).unwrap();
        let body = invoke(&mut storage, "parent", "storage.putBlob.finish", upload).unwrap();
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
            resource_owner: varin_runtime::catalog::launches::SourceResourceOwner::Local,
            remote_authority: None,
            target_authority: None,
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
            .child_source_handoff(
                &binding,
                &context,
                &varin_runtime::catalog::dispatch::ChildSourceDelegation {
        agent_source: None,
                    work_mode: varin_runtime::catalog::dispatch::ChildWorkMode::IsolatedWrite,
                    process: false,
                    configured_preset: false,
                    selection_ref: json!({"content_object":"fixture"}),
                },
                &parent,
                "host",
                false,
            )
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
        let original = invoke(
            &mut storage,
            "claim",
            "operation.get",
            json!({"operationId":"branch-create:fixed"}),
        )
        .unwrap();
        assert_eq!(
            original["result"]["sourceProvenance"]["objectHash"],
            body["hash"]
        );
        let bytes=invoke(&mut storage,"claim","storage.getBlob",json!({"hash":body["hash"],"recordId":"working-source:fixed","slot":"source-provenance"})).unwrap();
        assert_eq!(bytes["bytesBase64"], BASE64.encode(text.as_bytes()));
        for (method, params) in [
            (
                "operation.get",
                json!({"operationId":"branch-create:other-parent"}),
            ),
            (
                "storage.getBlob",
                json!({"hash":body["hash"],"recordId":"working-source:other-parent","slot":"source-provenance"}),
            ),
            (
                "storage.getBlob",
                json!({"hash":body["hash"],"recordId":"working-source:fixed","slot":"other-slot"}),
            ),
        ] {
            assert!(
                invoke(&mut storage, "claim", method, params).is_err(),
                "must reject unrelated parent receipt/record/slot"
            );
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
