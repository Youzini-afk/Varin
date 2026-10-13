//! Source leases live in the original Storage record owner. These are permissions and
//! fencing records, not another operation or process ledger.
use super::*;
use crate::source_resources::*;
use serde::Serialize;

impl Storage {
    fn source_record<T: serde::de::DeserializeOwned>(
        &self,
        kind: &str,
        id: &str,
    ) -> Result<Option<T>, KernelError> {
        let body: Option<String> = self
            .conn
            .query_row(
                "SELECT payload_json FROM domain_records WHERE record_type=?1 AND record_id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .optional()?;
        body.map(|v| serde_json::from_str(&v).map_err(Into::into))
            .transpose()
    }
    fn save_source_record<T: Serialize>(
        &mut self,
        kind: &str,
        id: &str,
        workspace: &str,
        state: &str,
        value: &T,
    ) -> Result<(), KernelError> {
        self.conn.execute("INSERT INTO domain_records(record_id,workspace_id,record_type,state,record_revision,payload_json,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?6,?6) ON CONFLICT(workspace_id,record_id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json,record_revision=record_revision+1,updated_at=excluded.updated_at",params![id,workspace,kind,state,serde_json::to_string(value)?,now_ms()])?;
        Ok(())
    }
    pub(crate) fn source_authority(
        &self,
        address: &SourceAuthorityAddress,
        current: bool,
        epoch: &str,
    ) -> Result<AuthorityRecord, KernelError> {
        let record: AuthorityRecord = self
            .source_record("source.authority", &address.authority_id)?
            .ok_or_else(|| denied("Original source authority is unavailable"))?;
        if record.principal_id != address.principal_id
            || record.coordinator_host_id != address.coordinator_host_id
            || record.result.resource_epoch != address.resource_epoch
        {
            return Err(denied(
                "Source authority belongs to another authenticated owner",
            ));
        }
        if current {
            let scope: ScopeRecord = self
                .source_record("source.scope", &record.scope_id)?
                .ok_or_else(|| denied("Source scope is unavailable"))?;
            if scope.epoch != record.result.scope.epoch()
                || scope.closed
                || scope.source != record.result.source
                || record.result.resource_epoch != epoch
                || !matches!(record.result.phase.as_str(), "preparing" | "ready")
                || (record.purpose == "mcp_owner"
                    && scope.mcp_closed_epoch.is_some_and(|closed| record.result.scope.epoch() <= closed))
            {
                return Err(denied("Source authority no longer admits new work"));
            }
        }
        Ok(record)
    }
    pub(crate) fn source_authority_open(
        &mut self,
        p: SourceAuthorityOpenParams,
        epoch: &str,
        host_id: &str,
    ) -> Result<Value, KernelError> {
        if p.principal_id.is_empty()
            || p.coordinator_host_id.is_empty()
            || !p.scope.validate()
            || !matches!(
                p.purpose.as_str(),
                "source" | "read" | "integration" | "result" | "process_view" | "script_environment" | "mcp_owner"
            )
            || (p.purpose == "mcp_owner" && (!p.enabled_tools.is_empty()
                || !matches!(p.scope, SourceAuthorityScope::Run { .. })
                || p.operation_id.is_some()
                || p.source.mode == varin_runtime::SourceMode::FixedBranch))
        {
            return Err(denied("Source authority identity is incomplete"));
        }
        p.source.validate().map_err(|e| denied(&e.to_string()))?;
        if p.source.resource_owner.host_id() != Some(host_id) {
            return Err(denied("Source belongs to another resource Host"));
        }
        if let Some(execution) = p
            .source
            .branch_id
            .as_deref()
            .and_then(|branch| branch.strip_prefix("child-source:"))
        {
            let receipt = self.operation_get(
                &json!({"operationId":format!("child-source-handoff:{execution}")}),
            )?;
            if receipt["kind"] != "source.handoff" || receipt["state"] != "committed" {
                return Err(denied("Private child source has no original handoff"));
            }
            let handoff: varin_runtime::catalog::collaboration::ChildSourceHandoff =
                serde_json::from_value(receipt["result"].clone())?;
            let original = handoff
                .resource_authority
                .ok_or_else(|| denied("Private source has no managed creation authority"))?;
            let creator = self.source_authority(
                &SourceAuthorityAddress {
                    principal_id: p.principal_id.clone(),
                    coordinator_host_id: p.coordinator_host_id.clone(),
                    authority_id: original.authority_id,
                    resource_epoch: original.resource_epoch,
                },
                false,
                epoch,
            )?;
            if p.scope.thread_id() != creator.result.scope.thread_id()
                && p.scope.thread_id() != format!("thread:child:{execution}")
            {
                return Err(denied("Private child source belongs to another Thread"));
            }
            if p.source.resource_owner != creator.result.source.resource_owner
                || p.source.workspace_id != creator.result.source.workspace_id
                || p.source.execution_workspace_id != creator.result.source.execution_workspace_id
            {
                return Err(denied(
                    "Private child source belongs to another original resource",
                ));
            }
        }
        let grant = self.load_grant(&p.grant_id)?;
        if grant.state != crate::model::GrantState::Active
            || grant.host_id != host_id
            || grant.kernel_epoch != epoch
            || grant.thread_id.as_deref() != Some(p.scope.thread_id())
            || grant.run_id.as_deref() != p.scope.run_id()
            || grant.owning_workspace.as_deref() != Some(&p.source.workspace_id)
            || grant.execution_workspace.as_deref() != Some(&p.source.execution_workspace_id)
            || grant.operation_id != p.operation_id
        {
            return Err(denied(
                "Source grant differs from its original admitted scope",
            ));
        }
        let scope_id = format!(
            "source-scope:{}",
            hash_json(&json!([
                p.principal_id,
                p.coordinator_host_id,
                p.scope.identity()
            ]))?
        );
        let mut scope: ScopeRecord =
            self.source_record("source.scope", &scope_id)?
                .unwrap_or(ScopeRecord {
                    source: p.source.clone(),
                    epoch: p.scope.epoch(),
                    ready: false,
                    closed: false,
                    mcp_closed_epoch: None,
                });
        if scope.source != p.source || scope.epoch > p.scope.epoch() || scope.closed {
            return Err(denied("Source scope or coordinator epoch changed"));
        }
        if p.purpose == "mcp_owner" && (!scope.ready || scope.epoch != p.scope.epoch()
            || scope.mcp_closed_epoch.is_some_and(|closed| p.scope.epoch() <= closed)) {
            return Err(denied("MCP owner requires its already prepared original Run source"));
        }
        scope.epoch = p.scope.epoch();
        // Fencing new dispatch is separate from revoking the creation grant. Accepted
        // Thread processes continue under their original lifetime and receipt identity.
        self.save_source_record(
            "source.scope",
            &scope_id,
            &p.source.workspace_id,
            "active",
            &scope,
        )?;
        let authority_id = format!(
            "source-authority:{}",
            hash_json(&json!([p.principal_id, p.coordinator_host_id, p.grant_id]))?
        );
        if let Some(previous) =
            self.source_record::<AuthorityRecord>("source.authority", &authority_id)?
        {
            if previous.result.source != p.source
                || previous.result.scope != p.scope
                || previous.enabled_tools != p.enabled_tools
                || previous.purpose != p.purpose
            {
                return Err(denied("Source authority identity was reused"));
            }
            return Ok(serde_json::to_value(previous.result)?);
        }
        let environment = p
            .source
            .environment_run_id
            .as_deref()
            .or(p.scope.run_id())
            .unwrap_or("");
        let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([
            p.source.workspace_id,
            environment
        ]))?));
        let result = SourceAuthorityResult {
            authority_id: authority_id.clone(),
            resource_epoch: epoch.into(),
            execution_owner: varin_runtime::ExecutorOwner::External {
                identity: format!("source:{host_id}:{authority_id}"),
                epoch: epoch.into(),
            },
            source: p.source,
            scope: p.scope,
            phase: "preparing".into(),
            purpose: p.purpose.clone(),
            operation_id: p.operation_id.clone(),
            grant_id: p.grant_id,
            tool_binding: None,
            physical_root: None,
            first_preparation: !scope.ready,
            materialization_operation_id: format!("source-materialize:{key}"),
            mcp_holders: Vec::new(),
        };
        let record = AuthorityRecord {
            principal_id: p.principal_id,
            coordinator_host_id: p.coordinator_host_id,
            scope_id,
            enabled_tools: p.enabled_tools,
            purpose: p.purpose,
            operation_id: p.operation_id,
            result,
        };
        self.save_source_record(
            "source.authority",
            &authority_id,
            &record.result.source.workspace_id,
            "preparing",
            &record,
        )?;
        Ok(serde_json::to_value(record.result)?)
    }
    /// Metadata-only handoff discovery and cancellation for one original caller
    /// scope. The scope fence is durable before any grant is retired.
    pub(crate) fn source_read_scope(
        &mut self,
        p: SourceReadScopeParams,
        close: bool,
        epoch: &str,
        host: &str,
    ) -> Result<Value, KernelError> {
        if p.principal_id.is_empty()
            || p.coordinator_host_id.is_empty()
            || !p.scope.validate()
            || !matches!(p.scope, SourceAuthorityScope::SourceRead { .. })
            || p.source.resource_owner.host_id() != Some(host)
        {
            return Err(denied("Original source-read scope is incomplete"));
        }
        p.source.validate().map_err(|e| denied(&e.to_string()))?;
        let id = format!(
            "source-scope:{}",
            hash_json(&json!([
                p.principal_id,
                p.coordinator_host_id,
                p.scope.identity()
            ]))?
        );
        let mut scope = self
            .source_record::<ScopeRecord>("source.scope", &id)?
            .unwrap_or(ScopeRecord {
                source: p.source.clone(),
                epoch: 0,
                ready: false,
                closed: false,
                mcp_closed_epoch: None,
            });
        if scope.source != p.source {
            return Err(denied("Original source-read scope changed"));
        }
        if close {
            scope.closed = true;
            self.save_source_record(
                "source.scope",
                &id,
                &p.source.workspace_id,
                "closed",
                &scope,
            )?;
        }
        let records = {
            let mut q = self.conn.prepare(
                "SELECT payload_json FROM domain_records WHERE record_type='source.authority'",
            )?;
            let rows = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut authorities = Vec::new();
        for body in records {
            let record: AuthorityRecord = serde_json::from_str(&body)?;
            if record.scope_id != id {
                continue;
            }
            if record.principal_id != p.principal_id
                || record.coordinator_host_id != p.coordinator_host_id
                || record.result.scope != p.scope
                || record.result.source != p.source
            {
                return Err(denied("Original source-read authority changed"));
            }
            let address = SourceAuthorityAddress {
                principal_id: p.principal_id.clone(),
                coordinator_host_id: p.coordinator_host_id.clone(),
                authority_id: record.result.authority_id.clone(),
                resource_epoch: record.result.resource_epoch.clone(),
            };
            let phase = if close && record.result.phase != "revoked" {
                self.release_source_authority(&address, "retire", host, epoch)?["phase"]
                    .as_str().ok_or_else(|| denied("Source retirement has no phase"))?.to_string()
            } else { record.result.phase.clone() };
            authorities.push(json!({"authorityId":record.result.authority_id,"resourceEpoch":record.result.resource_epoch,
                "phase":phase,
                "current":!scope.closed && record.result.resource_epoch==epoch && phase=="ready"}));
        }
        Ok(json!({"closed":scope.closed,"authorities":authorities}))
    }
    pub(crate) fn source_authority_bind(
        &mut self,
        p: SourceAuthorityBindParams,
        epoch: &str,
        host_id: &str,
    ) -> Result<Value, KernelError> {
        let address = SourceAuthorityAddress {
            principal_id: p.principal_id,
            coordinator_host_id: p.coordinator_host_id,
            authority_id: p.authority_id,
            resource_epoch: p.resource_epoch,
        };
        let mut record = self.source_authority(&address, true, epoch)?;
        if let Some(binding) = &p.tool_binding {
            if record.result.scope.run_id() != Some(binding.run_id.as_str())
                || record.result.scope.thread_id() != binding.thread_id
                || record.result.grant_id != binding.grant_id
                || binding.source_selection()? != record.result.source
                || binding
                    .enabled_tools
                    .iter()
                    .map(|t| t.name().to_string())
                    .collect::<BTreeSet<_>>()
                    != record.enabled_tools.iter().cloned().collect()
            {
                return Err(denied("Source binding changed after admission"));
            }
            if binding.remote_authority.is_some() {
                return Err(denied(
                    "Receiving source authority cannot redirect resource execution",
                ));
            }
            crate::tools::KernelToolExecutor::validate_source_binding(binding)?;
        } else if record.result.scope.run_id().is_some() {
            return Err(denied("Run source requires its exact tool binding"));
        }
        if let Some(root) = &p.physical_root {
            let grant = self.load_grant(&record.result.grant_id)?;
            let registered = self.registered_file_root(&root.root_id, &grant)?;
            if root.host_id != host_id
                || fs::canonicalize(&root.canonical_root)? != registered.canonical_root
                || registered.execution_workspace_id != record.result.source.execution_workspace_id
            {
                return Err(denied("Source physical root changed"));
            }
            if record.result.source.mode == varin_runtime::SourceMode::LiveRoot
                && record.result.source.live_root.as_ref() != Some(root)
            {
                return Err(denied("Live source identity changed"));
            }
            if let Some(binding) = &p.tool_binding {
                if binding.root_id.as_deref() != Some(root.root_id.as_str()) {
                    return Err(denied("Tool root differs from admitted source"));
                }
            }
        } else if record.purpose != "result"
            && p.tool_binding
                .as_ref()
                .is_some_and(|b| b.source_mode != varin_runtime::SourceMode::FixedBranch)
        {
            return Err(denied("Physical source requires its original root"));
        }
        if record.result.phase == "ready"
            && (serde_json::to_value(&record.result.tool_binding)?
                != serde_json::to_value(&p.tool_binding)?
                || record.result.physical_root != p.physical_root)
        {
            return Err(denied("Ready source authority is immutable"));
        }
        record.result.tool_binding = p.tool_binding;
        record.result.physical_root = p.physical_root;
        record.result.phase = "ready".into();
        let prior: ScopeRecord = self
            .source_record("source.scope", &record.scope_id)?
            .ok_or_else(|| denied("Source scope is unavailable"))?;
        let scope = ScopeRecord {
            closed: prior.closed,
            mcp_closed_epoch: prior.mcp_closed_epoch,
            source: record.result.source.clone(),
            epoch: record.result.scope.epoch(),
            ready: prior.ready || record.purpose != "result",
        };
        self.save_source_record(
            "source.scope",
            &record.scope_id,
            &record.result.source.workspace_id,
            "active",
            &scope,
        )?;
        self.save_source_record(
            "source.authority",
            &address.authority_id,
            &record.result.source.workspace_id,
            "ready",
            &record,
        )?;
        Ok(serde_json::to_value(record.result)?)
    }
    pub(crate) fn release_source_authority(
        &mut self,
        address: &SourceAuthorityAddress,
        mode: &str,
        host_id: &str,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        if !matches!(mode, "retire" | "revoke") {
            return Err(denied("Unknown source release mode"));
        }
        let mut record = self.source_authority(address, false, epoch)?;
        if mode == "retire" {
            // Close new admission before checking physical drainage. A failed stop
            // check leaves this original authority sealed, never ready again.
            self.seal_source_record(&mut record)?;
            if record.result.phase == "retaining"
                && self.load_grant(&record.result.grant_id)?.state == crate::model::GrantState::Active
            {
                let retained: Vec<_> = record.result.mcp_holders.iter()
                    .filter(|holder| !holder.released).cloned().collect();
                return Ok(json!({"authorityId":address.authority_id,"phase":"retaining","grantIds":[],
                    "receipt":{"retainedMcpHolders":retained}}));
            }
        }
        let receipt = match mode {
            "retire" => self.retire_grants(
                &json!({"target":{"kind":"grant","grantId":record.result.grant_id}}),
                host_id,
            )?,
            "revoke" => self.revoke_grant(&json!({"grantId":record.result.grant_id}), host_id)?,
            _ => return Err(denied("Unknown source release mode")),
        };
        record.result.phase = if mode == "retire"
            && self.load_grant(&record.result.grant_id)?.state != crate::model::GrantState::Revoked
        {
            "retired"
        } else {
            "revoked"
        }
        .into();
        self.save_source_record(
            "source.authority",
            &address.authority_id,
            &record.result.source.workspace_id,
            &record.result.phase,
            &record,
        )?;
        Ok(
            json!({"authorityId":address.authority_id,"phase":record.result.phase,"grantIds":[record.result.grant_id],"receipt":receipt}),
        )
    }
    fn seal_source_record(&mut self, record: &mut AuthorityRecord) -> Result<(), KernelError> {
        if record.purpose == "mcp_owner" {
            let mut scope: ScopeRecord = self.source_record("source.scope", &record.scope_id)?
                .ok_or_else(|| denied("Source scope is unavailable"))?;
            if scope.source != record.result.source {
                return Err(denied("Original MCP source scope changed"));
            }
            self.close_source_mcp_admission(&record.scope_id, &mut scope, record.result.scope.epoch())?;
        }
        if matches!(record.result.phase.as_str(), "retired" | "revoked") {
            return Ok(());
        }
        record.result.phase = if record.purpose == "mcp_owner"
            && record.result.mcp_holders.iter().any(|holder| !holder.released)
        {
            "retaining"
        } else {
            "draining"
        }.into();
        self.save_source_record("source.authority", &record.result.authority_id,
            &record.result.source.workspace_id, &record.result.phase, record)
    }
    fn close_source_mcp_admission(
        &mut self,
        scope_id: &str,
        scope: &mut ScopeRecord,
        through_epoch: u64,
    ) -> Result<(), KernelError> {
        scope.mcp_closed_epoch = Some(scope.mcp_closed_epoch.map_or(through_epoch, |closed| closed.max(through_epoch)));
        self.save_source_record("source.scope", scope_id, &scope.source.workspace_id,
            if scope.closed { "closed" } else { "active" }, scope)
    }
    pub(crate) fn seal_source_authority(
        &mut self,
        address: &SourceAuthorityAddress,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let mut record = self.source_authority(address, false, epoch)?;
        self.seal_source_record(&mut record)?;
        Ok(serde_json::to_value(record.result)?)
    }
    pub(crate) fn source_mcp_holder(
        &mut self,
        p: SourceMcpHolderParams,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let address = SourceAuthorityAddress {
            principal_id: p.principal_id,
            coordinator_host_id: p.coordinator_host_id,
            authority_id: p.authority_id,
            resource_epoch: p.resource_epoch,
        };
        let mut record = self.source_authority(&address, false, epoch)?;
        if record.purpose != "mcp_owner" || !p.binding.validate()
            || !matches!(p.action.as_str(), "retain" | "inspect" | "release" | "release_unstarted")
            || p.action == "release_unstarted" && p.binding.purpose != "task"
        {
            return Err(denied("Original MCP holder identity is incomplete"));
        }
        let previous = record.result.mcp_holders.iter()
            .position(|holder| holder.binding.operation_id == p.binding.operation_id);
        if previous.is_some_and(|index| record.result.mcp_holders[index].binding != p.binding) {
            return Err(denied("Original MCP holder binding changed"));
        }
        if p.action == "inspect" && previous.is_none() {
            return Err(denied("Original MCP holder is unavailable"));
        }
        if p.action == "retain" && !previous.is_some_and(|index| record.result.mcp_holders[index].released) {
            let grant = self.load_grant(&record.result.grant_id)?;
            if !matches!(record.result.phase.as_str(), "ready" | "retaining")
                || record.result.resource_epoch != epoch
                || grant.kernel_epoch != epoch
                || grant.state != crate::model::GrantState::Active
            {
                return Err(denied("Original MCP owner no longer admits holders"));
            }
            if previous.is_none() {
                self.source_authority(&address, true, epoch)?;
                if record.result.phase != "ready" {
                    return Err(denied("Sealed MCP owner cannot acquire another holder"));
                }
            }
        }
        let index = match previous {
            Some(index) => index,
            None => {
                // A release can overtake acceptance. Preserve its complete immutable
                // identity so a delayed retain can only recall the closed reference.
                record.result.mcp_holders.push(SourceMcpHolder {
                    binding: p.binding,
                    released: matches!(p.action.as_str(), "release" | "release_unstarted"),
                    creation_receipt: None,
                });
                record.result.mcp_holders.len() - 1
            }
        };
        if p.action == "release" || p.action == "release_unstarted"
            && record.result.mcp_holders[index].creation_receipt.is_none()
        {
            record.result.mcp_holders[index].released = true;
            if record.result.phase == "retaining"
                && record.result.mcp_holders.iter().all(|holder| holder.released)
            {
                record.result.phase = "draining".into();
            }
        }
        if p.action != "inspect" {
            self.save_source_record("source.authority", &address.authority_id,
                &record.result.source.workspace_id, &record.result.phase, &record)?;
        }
        Ok(json!({"holder":record.result.mcp_holders[index],"authority":record.result}))
    }
    /// One creation dispatch and its immutable response on the original holder.
    /// Storage serializes admission, and one record write commits the holder and
    /// the unknown receipt together before the caller may send the remote request.
    pub(crate) fn source_mcp_task_receipt(
        &mut self,
        p: SourceMcpTaskReceiptParams,
        epoch: &str,
    ) -> Result<SourceDispatch, KernelError> {
        let address = SourceAuthorityAddress {
            principal_id: p.principal_id,
            coordinator_host_id: p.coordinator_host_id,
            authority_id: p.authority_id,
            resource_epoch: p.resource_epoch,
        };
        // Recall and late settlement use the exact original owner, even after
        // revocation or restart. They never reacquire a grant or reopen admission.
        let mut record = self.source_authority(&address, false, epoch)?;
        if record.purpose != "mcp_owner" || !p.binding.validate()
            || p.binding.purpose != "task"
            || p.request_hash.as_ref().is_some_and(|hash| hash.is_empty())
            || (p.action != SourceMcpTaskReceiptAction::Inspect && p.request_hash.is_none())
            || (p.action == SourceMcpTaskReceiptAction::Settle) != p.outcome.is_some()
        {
            return Err(denied("Original MCP task creation identity is incomplete"));
        }
        let previous = record.result.mcp_holders.iter()
            .position(|holder| holder.binding.operation_id == p.binding.operation_id);
        if previous.is_some_and(|index| record.result.mcp_holders[index].binding != p.binding) {
            return Err(denied("Original MCP holder binding changed"));
        }
        let receipt = previous.and_then(|index| record.result.mcp_holders[index].creation_receipt.as_ref());
        if receipt.is_some_and(|receipt| p.request_hash.as_ref().is_some_and(|hash| &receipt.request_hash != hash)) {
            return Err(denied("Original MCP task creation request changed"));
        }
        if p.action == SourceMcpTaskReceiptAction::Inspect {
            let index = previous.ok_or_else(|| denied("Original MCP holder is unavailable"))?;
            return self.recall_source_mcp_task_receipt(record, index, false);
        }
        if p.action == SourceMcpTaskReceiptAction::Settle {
            if receipt.is_none() {
                return Err(denied("Original MCP task creation receipt is unavailable"));
            }
            return Ok(SourceDispatch::McpTaskReceiptStage(super::source_mcp_receipts::McpReceiptPreparation {
                address,
                binding: p.binding,
                request_hash: p.request_hash.expect("settlement requires a request hash"),
                epoch: epoch.into(),
                outcome: p.outcome.expect("settlement requires an outcome"),
                root: self.root.clone(),
            }));
        }
        let mut dispatch = false;
        let mut changed = false;
        let index = if receipt.is_some() {
            previous.expect("receipt belongs to an original holder")
        } else {
            if p.action != SourceMcpTaskReceiptAction::Begin {
                return Err(denied("Original MCP task creation receipt is unavailable"));
            }
            if previous.is_some_and(|index| record.result.mcp_holders[index].released) {
                return Err(denied("Released MCP holder cannot admit task creation"));
            }
            self.source_authority(&address, true, epoch)?;
            let grant = self.load_grant(&record.result.grant_id)?;
            if record.result.phase != "ready" || grant.kernel_epoch != epoch
                || grant.state != crate::model::GrantState::Active
            {
                return Err(denied("Original MCP owner no longer admits task creation"));
            }
            let index = match previous {
                Some(index) => index,
                None => {
                    record.result.mcp_holders.push(SourceMcpHolder {
                        binding: p.binding,
                        released: false,
                        creation_receipt: None,
                    });
                    record.result.mcp_holders.len() - 1
                }
            };
            record.result.mcp_holders[index].creation_receipt = Some(SourceMcpTaskCreationReceipt {
                request_hash: p.request_hash.expect("begin requires a creation request hash"),
                outcome_ref: None,
            });
            dispatch = true;
            changed = true;
            index
        };
        if changed {
            self.save_source_record("source.authority", &address.authority_id,
                &record.result.source.workspace_id, &record.result.phase, &record)?;
        }
        self.recall_source_mcp_task_receipt(record, index, dispatch)
    }
    /// Publish only the staged object's identity under Storage. Exact holder
    /// release may have overtaken this worker; it never restores a body GC root.
    pub(crate) fn publish_source_mcp_task_receipt(
        &mut self,
        staged: super::source_mcp_receipts::StagedMcpReceipt,
    ) -> Result<Value, KernelError> {
        let mut record = self.source_authority(&staged.address, false, &staged.epoch)?;
        let index = record.result.mcp_holders.iter()
            .position(|holder| holder.binding == staged.binding)
            .ok_or_else(|| denied("Original MCP holder binding changed"))?;
        let holder = &mut record.result.mcp_holders[index];
        let receipt = holder.creation_receipt.as_mut()
            .ok_or_else(|| denied("Original MCP task creation receipt is unavailable"))?;
        if receipt.request_hash != staged.request_hash {
            return Err(denied("Original MCP task creation request changed"));
        }
        match &receipt.outcome_ref {
            Some(original) if original != &staged.reference => {
                return Err(denied("Original MCP task creation outcome changed"));
            }
            Some(_) => {}
            None => {
                // The original holder remains the only durable GC owner. A late
                // first settlement after release keeps a compact hash tombstone.
                let retain = !holder.released;
                if retain {
                    let object = object_path(&self.root, &staged.reference.object_hash)?;
                    let shard = object.parent().expect("content object shard");
                    if !shard.exists() {
                        fs::create_dir_all(shard)?;
                        sync_directory(&self.root.join("objects"))?;
                    }
                    durable_rename(&staged.staged, &object)?;
                    sync_directory(shard)?;
                    sync_directory(&self.root.join("staging"))?;
                }
                receipt.outcome_ref = Some(staged.reference.clone());
                self.conn.execute_batch("BEGIN IMMEDIATE")?;
                let published = (|| {
                    if retain {
                        self.conn.execute("INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES(?1,?2)",
                            params![staged.reference.object_hash, i64::try_from(staged.reference.byte_length)
                                .map_err(|_| KernelError::Storage("MCP receipt object is too large".into()))?])?;
                        self.conn.execute("DELETE FROM pending_gc_files WHERE hash=?1", [&staged.reference.object_hash])?;
                    }
                    self.save_source_record("source.authority", &staged.address.authority_id,
                        &record.result.source.workspace_id, &record.result.phase, &record)
                })();
                if let Err(error) = published {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error);
                }
                self.conn.execute_batch("COMMIT")?;
            }
        }
        Ok(json!({"dispatch":false,"holder":record.result.mcp_holders[index],"authority":record.result,"outcome":null}))
    }
    pub(crate) fn inspect_source_scope(
        &self,
        p: SourceAuthorityScopeParams,
    ) -> Result<Value, KernelError> {
        let mut q = self.conn.prepare(
            "SELECT payload_json FROM domain_records WHERE record_type='source.authority'",
        )?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        let mut found = Vec::new();
        for row in rows {
            let record: AuthorityRecord = serde_json::from_str(&row?)?;
            if record.principal_id == p.principal_id
                && record.coordinator_host_id == p.coordinator_host_id
                && record.result.scope.thread_id() == p.thread_id
                && record.result.scope.run_id() == Some(p.run_id.as_str())
            {
                found.push(record.result);
            }
        }
        Ok(serde_json::to_value(found)?)
    }
    pub(crate) fn release_source_scope(
        &mut self,
        p: SourceAuthorityScopeReleaseParams,
        epoch: &str,
        host_id: &str,
    ) -> Result<Value, KernelError> {
        if !matches!(p.mode.as_str(), "retire" | "revoke") {
            return Err(denied("Unknown source release mode"));
        }
        let scope_id = format!("source-scope:{}", hash_json(&json!([
            p.principal_id, p.coordinator_host_id, ["run", p.thread_id, p.run_id]
        ]))?);
        if let Some(mut scope) = self.source_record::<ScopeRecord>("source.scope", &scope_id)? {
            let through_epoch = scope.epoch;
            // Commit the authenticated scope fence before enumerating authorities:
            // an MCP grant that has not opened an owner yet is fenced as well.
            self.close_source_mcp_admission(&scope_id, &mut scope, through_epoch)?;
        }
        let records = {
            let mut q = self.conn.prepare(
                "SELECT payload_json FROM domain_records WHERE record_type='source.authority'",
            )?;
            let rows = q.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut released = Vec::new();
        let mut pending = Vec::new();
        for body in records {
            let record: AuthorityRecord = serde_json::from_str(&body)?;
            if record.principal_id != p.principal_id
                || record.coordinator_host_id != p.coordinator_host_id
                || record.result.scope.thread_id() != p.thread_id
                || record.result.scope.run_id() != Some(p.run_id.as_str())
            {
                continue;
            }
            if p.mode == "retire" && record.operation_id.is_some() {
                continue;
            }
            let address = SourceAuthorityAddress {
                principal_id: p.principal_id.clone(),
                coordinator_host_id: p.coordinator_host_id.clone(),
                authority_id: record.result.authority_id.clone(),
                resource_epoch: record.result.resource_epoch,
            };
            match self.release_source_authority(&address, &p.mode, host_id, epoch) {
                Ok(result) => {
                    if result["receipt"]["pendingProcesses"]
                        .as_array()
                        .is_some_and(|v| !v.is_empty())
                        || result["receipt"]["processStopFailures"]
                            .as_array()
                            .is_some_and(|v| !v.is_empty())
                    {
                        pending.push(record.result.authority_id);
                    }
                    released.push(result)
                }
                Err(_) => pending.push(record.result.authority_id),
            }
        }
        Ok(json!({"released":released,"pendingAuthorities":pending}))
    }
}

impl Storage {
    fn source_authority_for_grant(
        &self,
        grant_id: &str,
    ) -> Result<Option<AuthorityRecord>, KernelError> {
        let mut query = self.conn.prepare(
            "SELECT payload_json FROM domain_records WHERE record_type='source.authority'",
        )?;
        for row in query.query_map([], |row| row.get::<_, String>(0))? {
            let record: AuthorityRecord = serde_json::from_str(&row?)?;
            if record.result.grant_id == grant_id {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }
    pub(crate) fn validate_source_grant_owner(
        &self,
        current_grant: &str,
        creation_grant: &str,
    ) -> Result<(), KernelError> {
        match (
            self.source_authority_for_grant(current_grant)?,
            self.source_authority_for_grant(creation_grant)?,
        ) {
            (None, None) => Ok(()),
            (Some(current), Some(original))
                if current.principal_id == original.principal_id
                    && current.coordinator_host_id == original.coordinator_host_id
                    && current.result.scope.thread_id() == original.result.scope.thread_id()
                    && current.result.scope.run_id() == original.result.scope.run_id()
                    && current.result.source == original.result.source =>
            {
                Ok(())
            }
            _ => Err(denied(
                "Original source result belongs to another authenticated owner",
            )),
        }
    }
    pub(crate) fn validate_source_resource(
        &self,
        address: &SourceAuthorityAddress,
        binding: &crate::tools::ToolBinding,
        epoch: &str,
        current: bool,
    ) -> Result<(), KernelError> {
        let record = self.source_authority(address, current, epoch)?;
        if record.result.phase != "ready"
            || record.result.grant_id != binding.grant_id
            || record.result.source != binding.source_selection()?
            || record.result.scope.run_id() != Some(binding.run_id.as_str())
            || record.result.scope.thread_id() != binding.thread_id
        {
            return Err(denied(
                "Typed resource no longer has its original source authority",
            ));
        }
        Ok(())
    }
    /// Managed process IDs are namespaced by the authenticated coordinator/principal,
    /// not by caller-supplied Thread or Run strings. Delegated output follows only
    /// handoffs and immutable branch bases already recorded by this Storage owner.
    pub(crate) fn validate_source_process_access(
        &self,
        binding: &crate::tools::ToolBinding,
        id: &str,
        epoch: &str,
        lineage: Option<&varin_runtime::catalog::process_wait::ProcessResultLineage>,
    ) -> Result<(), KernelError> {
        let Some(address) = &binding.target_authority else {
            return Ok(());
        };
        let current = self.source_authority(address, true, epoch)?;
        let actor: String = self.conn.query_row(
            "SELECT grant_id FROM process_records WHERE process_id=?1",
            [id],
            |row| row.get(0),
        )?;
        let mut query = self.conn.prepare(
            "SELECT payload_json FROM domain_records WHERE record_type='source.authority'",
        )?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        let mut creation = None;
        for row in rows {
            let value: AuthorityRecord = serde_json::from_str(&row?)?;
            if value.result.grant_id == actor {
                creation = Some(value);
                break;
            }
        }
        let creation =
            creation.ok_or_else(|| denied("Process has no original managed source authority"))?;
        if creation.principal_id != current.principal_id
            || creation.coordinator_host_id != current.coordinator_host_id
            || creation.result.scope.thread_id() != current.result.scope.thread_id()
            || creation.result.source.resource_owner != current.result.source.resource_owner
            || creation.result.source.workspace_id != current.result.source.workspace_id
            || creation.result.source.execution_workspace_id
                != current.result.source.execution_workspace_id
        {
            return Err(denied(
                "Process belongs to another authenticated source owner",
            ));
        }
        if let Some(proof) = lineage {
            if proof.process_id() != id
                || Some(proof.source_run_id()) != creation.result.scope.run_id()
                || Some(proof.target_run_id()) != current.result.scope.run_id()
                || proof.source() != &creation.result.source
                || proof.target() != &current.result.source
                || proof.executions().is_empty()
            {
                return Err(denied(
                    "Process lineage differs from its original source owners",
                ));
            }
            let mut step = current;
            let mut seen = BTreeSet::new();
            for execution in proof.executions() {
                if !seen.insert(execution)
                    || step.result.source.branch_id.as_deref()
                        != Some(format!("child-source:{execution}").as_str())
                {
                    return Err(denied(
                        "Process lineage has no matching target source branch",
                    ));
                }
                let receipt = self.operation_get(
                    &json!({"operationId":format!("child-source-handoff:{execution}")}),
                )?;
                if receipt["kind"] != "source.handoff" || receipt["state"] != "committed" {
                    return Err(denied("Process lineage handoff is unavailable"));
                }
                let handoff: varin_runtime::catalog::collaboration::ChildSourceHandoff =
                    serde_json::from_value(receipt["result"].clone())?;
                let varin_runtime::catalog::collaboration::ChildSourceRoot::Fixed { pin } =
                    &handoff.root
                else {
                    return Err(denied(
                        "Process lineage requires the original immutable continuation basis",
                    ));
                };
                let branch = self.branch(step.result.source.branch_id.as_deref().unwrap())?;
                if branch.base_root != pin.root || pin.source != handoff.source {
                    return Err(denied(
                        "Process lineage branch differs from its original handoff",
                    ));
                }
                let original = handoff
                    .resource_authority
                    .ok_or_else(|| denied("Process lineage original source authority missing"))?;
                let prior = self.source_authority(
                    &SourceAuthorityAddress {
                        principal_id: step.principal_id.clone(),
                        coordinator_host_id: step.coordinator_host_id.clone(),
                        authority_id: original.authority_id,
                        resource_epoch: original.resource_epoch,
                    },
                    false,
                    epoch,
                )?;
                if prior.result.scope.thread_id() != step.result.scope.thread_id()
                    || prior.result.source.resource_owner != step.result.source.resource_owner
                    || handoff.source.resource_owner != prior.result.source.resource_owner
                    || handoff.source.workspace_id != prior.result.source.workspace_id
                    || handoff.source.execution_workspace_id
                        != prior.result.source.execution_workspace_id
                    || handoff.source.branch_id != prior.result.source.branch_id
                {
                    return Err(denied(
                        "Process continuation belongs to another actual source",
                    ));
                }
                step = prior;
            }
            if step.result.scope.run_id() != creation.result.scope.run_id()
                || step.result.source != creation.result.source
            {
                return Err(denied(
                    "Process lineage does not reach its actual creation source",
                ));
            }
        }
        Ok(())
    }
    pub(crate) fn source_service(
        &mut self,
        p: SourceServiceCallParams,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let address = SourceAuthorityAddress {
            principal_id: p.principal_id,
            coordinator_host_id: p.coordinator_host_id,
            authority_id: p.authority_id,
            resource_epoch: p.resource_epoch,
        };
        let record = self.source_authority(&address, true, epoch)?;
        if record.result.phase != "ready" || p.request_id.is_empty() {
            return Err(denied(
                "Source service requires its ready original authority",
            ));
        }
        if !matches!(p.operation, SourceServiceOperation::Validate) {
            return Err(denied("Native resource must use its original worker"));
        }
        let grant = self.load_grant(&record.result.grant_id)?;
        if grant.state != crate::model::GrantState::Active {
            return Err(denied("Source permit is no longer active"));
        }
        Ok(json!({"pathScopes":grant.path_scopes}))
    }
    /// The original interaction journal contains only a bounded intent and receipt.
    /// The worker uses the existing process-interaction owner to read/drain its receipt.
    pub(crate) fn source_interaction_receipt(
        &mut self,
        address: &SourceAuthorityAddress,
        id: &str,
        epoch: &str,
    ) -> Result<
        Option<(
            AuthorityRecord,
            super::process_interactions::Native,
            super::process_interactions::Address,
        )>,
        KernelError,
    > {
        let record = self.source_authority(address, false, epoch)?;
        let prior = self.operation_get(&json!({"operationId":id}))?;
        if !matches!(
            prior["kind"].as_str(),
            Some("process.write" | "process.resize")
        ) {
            return Ok(None);
        }
        let intent: super::process_interactions::Intent =
            serde_json::from_value(prior["result"]["intent"].clone())?;
        let native = intent
            .native
            .ok_or_else(|| denied("Process interaction has no original invocation"))?;
        let expected = if prior["kind"] == "process.write" {
            "process_write"
        } else {
            "process_resize"
        };
        if intent.current_grant_id != record.result.grant_id
            || native.resource_owner != record.result.source.resource_owner
            || record.result.scope.run_id() != Some(native.context.run_id.as_str())
            || native.context.operation_id != id
            || native.executor != expected
            || intent.address.operation_id != id
            || intent.address.workspace_id != record.result.source.workspace_id
            || record
                .result
                .tool_binding
                .as_ref()
                .is_none_or(|b| b.root_id != intent.address.root_id)
        {
            return Err(denied(
                "Process interaction belongs to another original source authority",
            ));
        }
        Ok(Some((record, native, intent.address)))
    }
    /// Recall only facts belonging to the authority's actual creation grant. Missing
    /// receipts are unknown, never evidence that executing the same intent is safe.
    /// Recover the original evaluator through its existing Source + process records.
    /// No replacement grant, evaluator heap or Catalog execution is created here.
    pub(crate) fn control_source_script(
        &mut self,
        p: SourceScriptControlParams,
        epoch: &str,
        host: &str,
    ) -> Result<Value, KernelError> {
        if p.process_id.is_empty() || p.source.resource_owner.host_id() != Some(host) {
            return Err(denied("Original script source identity is incomplete"));
        }
        let authorities: Vec<SourceAuthorityResult> = serde_json::from_value(self.inspect_source_scope(SourceAuthorityScopeParams {
            principal_id: p.principal_id.clone(), coordinator_host_id: p.coordinator_host_id.clone(),
            thread_id: p.thread_id.clone(), run_id: p.run_id.clone(),
        })?)?;
        let authorities: Vec<_> = authorities.into_iter().filter(|a| a.purpose == "script_environment"
            && a.operation_id.as_deref() == Some(p.process_id.as_str()) && a.source == p.source).collect();
        let creation_grant: Option<String> = self.conn.query_row(
            "SELECT grant_id FROM process_records WHERE process_id=?1", [&p.process_id], |row| row.get(0),
        ).optional()?;
        let creation = creation_grant.as_ref().and_then(|grant| authorities.iter().find(|a| &a.grant_id == grant));
        if creation_grant.is_some() && creation.is_none() {
            return Err(denied("Script process belongs to another original source"));
        }
        // Fence even an admitted spawn whose process acceptance has not arrived yet.
        // This only revokes the original environment's grants, never its whole Run.
        if p.stop {
            for authority in &authorities {
                self.release_source_authority(&SourceAuthorityAddress {
                    principal_id: p.principal_id.clone(), coordinator_host_id: p.coordinator_host_id.clone(),
                    authority_id: authority.authority_id.clone(), resource_epoch: authority.resource_epoch.clone(),
                }, "revoke", host, epoch)?;
            }
        }
        let Some(creation) = creation else {
            return Ok(json!({"processId":p.process_id,"source":p.source,"runId":p.run_id,"threadId":p.thread_id,
                "accepted":false,"executorStopped":false,"process":null}));
        };
        let receipt = self.observe_source_operation(&SourceAuthorityAddress {
            principal_id:p.principal_id, coordinator_host_id:p.coordinator_host_id,
            authority_id:creation.authority_id.clone(), resource_epoch:creation.resource_epoch.clone(),
        }, &p.process_id, epoch, p.stop)?;
        Ok(json!({"processId":p.process_id,"source":p.source,"runId":p.run_id,"threadId":p.thread_id,
            "accepted":receipt["accepted"],"executorStopped":receipt["executorStopped"],"process":receipt["process"]}))
    }
    pub(crate) fn observe_source_operation(
        &mut self,
        address: &SourceAuthorityAddress,
        id: &str,
        epoch: &str,
        cancel: bool,
    ) -> Result<Value, KernelError> {
        let record = self.source_authority(address, false, epoch)?;
        if id.is_empty() {
            return Err(denied("Original operation identity required"));
        }
        let process_grant: Option<String> = self
            .conn
            .query_row(
                "SELECT grant_id FROM process_records WHERE process_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let (accepted, stopped, result) = if let Some(grant) = process_grant {
            if grant != record.result.grant_id {
                return Err(denied("Process belongs to another source authority"));
            }
            if cancel {
                let _ = self.processes.kill(id, true);
            }
            let mut status = self
                .refresh_process_record(id)?
                .ok_or_else(|| denied("Process receipt disappeared"))?;
            let original_epoch = status["kernelEpoch"]
                .as_str()
                .ok_or_else(|| denied("Process epoch disappeared"))?;
            let never_spawned = status["status"] == "failed"
                && status["writerActive"] == false
                && status["treeConfirmed"] == true
                && status["spawned"] == false;
            // Pre-spawn failure is durable in the original Storage record. Receipt-directory
            // setup itself may have failed, so it cannot require a guardian's receipt file.
            if !never_spawned {
                if let Some(terminal) = crate::process::read_receipt(&self.root, id, original_epoch)? {
                    if terminal["processId"] != id || terminal["kernelEpoch"] != original_epoch {
                        return Err(denied("Original process terminal identity changed"));
                    }
                    for (key, value) in terminal.as_object().into_iter().flatten() {
                        status[key] = value.clone();
                    }
                }
            }
            (
                true,
                status["writerActive"] == false && status["treeConfirmed"] == true,
                status,
            )
        } else {
            let prior = self.operation_get(&json!({"operationId":id}))?;
            if prior.is_null() {
                (false, false, Value::Null)
            } else {
                if prior["kind"] == "source.read" {
                    if prior["result"]["authorityId"] != record.result.authority_id
                        || prior["result"]["grantId"] != record.result.grant_id
                    {
                        return Err(denied("Read belongs to another original source authority"));
                    }
                    let receipt:varin_runtime::execution::ToolExecutionReceipt=varin_runtime::execution::ToolExecutionReceipt{executor_stopped:false,completion:varin_runtime::execution::ToolCompletion::Result{outcome:varin_runtime::Outcome::Indeterminate,effect:varin_runtime::Effect::None,content:json!({"reason":"Original source read has not returned a durable completion"}).into()}};
                    return Ok(
                        json!({"operationId":id,"resourceEpoch":record.result.resource_epoch,"executionOwner":record.result.execution_owner,"accepted":true,"executorStopped":false,"result":receipt,"process":null}),
                    );
                }
                let identity = if prior["state"] == "started" {
                    &prior["result"]["intent"]
                } else {
                    &prior["result"]
                };
                if identity["__nativeGrantId"] != record.result.grant_id {
                    return Err(denied("Operation belongs to another original authority"));
                }
                let mut result = if prior["state"] == "committed" {
                    prior["result"].clone()
                } else {
                    json!({"reason":"Original file effect remains unresolved"})
                };
                if let Some(object) = result.as_object_mut() {
                    object.remove("__nativeGrantId");
                    object.remove("__nativeEpoch");
                    object.remove("__nativeRequestHash");
                }
                (true, prior["state"] == "committed", result)
            }
        };
        use varin_runtime::execution::{ToolCompletion, ToolExecutionReceipt};
        use varin_runtime::{Effect, Lifetime, Outcome};
        let process = result.get("processId").is_some();
        let completion: ToolCompletion = if process && !stopped {
            ToolCompletion::JobAccepted {
                operation_id: id.into(),
                phase: result["status"].as_str().unwrap_or("unknown").into(),
                effect: Effect::Dispatched,
                lifetime: Lifetime::Thread,
                content: None,
            }
        } else {
            ToolCompletion::Result {
                outcome: if !stopped {
                    Outcome::Indeterminate
                } else if process {
                    if result["status"] == "exited" && result["exitCode"] == 0 {
                        Outcome::Succeeded
                    } else {
                        Outcome::Failed
                    }
                } else if result["status"] == "applied" {
                    Outcome::Succeeded
                } else {
                    Outcome::Failed
                },
                effect: if !stopped {
                    Effect::Unknown
                } else if process || result["status"] == "applied" {
                    Effect::Confirmed
                } else {
                    Effect::None
                },
                content: result.clone().into(),
            }
        };
        let receipt = ToolExecutionReceipt {
            completion,
            executor_stopped: stopped,
        };
        Ok(
            json!({"operationId":id,"resourceEpoch":record.result.resource_epoch,"executionOwner":record.result.execution_owner,"accepted":accepted,"executorStopped":stopped,"result":receipt,"process":if process{result}else{Value::Null}}),
        )
    }
}

impl Storage {
    pub(crate) fn inspect_source_handoff(
        &self,
        p: &SourceHandoffInspectParams,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let receipt = self.operation_get(
            &json!({"operationId":format!("child-source-handoff:{}",p.operation_id)}),
        )?;
        if receipt.is_null() {
            return Ok(Value::Null);
        }
        if receipt["kind"] != "source.handoff" || receipt["state"] != "committed" {
            return Err(denied("Original handoff is still unresolved"));
        }
        let handoff: varin_runtime::catalog::collaboration::ChildSourceHandoff =
            serde_json::from_value(receipt["result"].clone())?;
        let original = handoff
            .resource_authority
            .as_ref()
            .ok_or_else(|| denied("Handoff has no managed resource authority"))?;
        let authority = self.source_authority(
            &SourceAuthorityAddress {
                principal_id: p.principal_id.clone(),
                coordinator_host_id: p.coordinator_host_id.clone(),
                authority_id: original.authority_id.clone(),
                resource_epoch: original.resource_epoch.clone(),
            },
            false,
            epoch,
        )?;
        if authority.result.scope.run_id() != Some(p.parent_run_id.as_str())
            || authority.result.scope.thread_id() != p.parent_thread_id
            || handoff.source != p.source
            || authority.result.source != p.source
        {
            return Err(denied("Handoff belongs to another original parent/source"));
        }
        Ok(serde_json::to_value(handoff)?)
    }
    pub(crate) fn claim_source_handoff(
        &mut self,
        p: SourceHandoffClaimParams,
        epoch: &str,
        host: &str,
        generation: &str,
    ) -> Result<Value, KernelError> {
        use varin_runtime::catalog::collaboration::{
            ChildSourceAuthority, ChildSourceHandoff, ChildSourcePin, ChildSourceRoot,
        };
        let SourceAuthorityScope::SourceRead {
            thread_id,
            branch_id,
            ..
        } = &p.scope
        else {
            return Err(denied("Child preparation has no model Run"));
        };
        let (handoff, dispatch) = match (p.handoff, p.continuation) {
            (Some(handoff), None) => {
                let original = handoff
                    .resource_authority
                    .as_ref()
                    .ok_or_else(|| denied("Original managed handoff authority missing"))?;
                let authority = self.source_authority(
                    &SourceAuthorityAddress {
                        principal_id: p.principal_id.clone(),
                        coordinator_host_id: p.coordinator_host_id.clone(),
                        authority_id: original.authority_id.clone(),
                        resource_epoch: original.resource_epoch.clone(),
                    },
                    false,
                    epoch,
                )?;
                let dispatch = handoff
                    .operation_id
                    .strip_prefix("child-source-handoff:")
                    .ok_or_else(|| denied("Handoff operation identity invalid"))?
                    .to_string();
                if *thread_id != format!("thread:child:{dispatch}")
                    || *branch_id != format!("branch:child:{dispatch}")
                    || authority.result.source != handoff.source
                    || handoff.source != p.source
                {
                    return Err(denied("Child grant differs from its original handoff"));
                }
                (handoff, dispatch)
            }
            (None, Some(continuation)) => {
                if continuation.execution_id.is_empty()
                    || continuation.previous_run_id.is_empty()
                    || continuation.root.is_empty()
                {
                    return Err(denied("Continuation source identity missing"));
                }
                let candidates = self.inspect_source_scope(SourceAuthorityScopeParams {
                    principal_id: p.principal_id.clone(),
                    coordinator_host_id: p.coordinator_host_id.clone(),
                    thread_id: thread_id.clone(),
                    run_id: continuation.previous_run_id,
                })?;
                let previous = candidates
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|v| serde_json::from_value::<SourceAuthorityResult>(v.clone()))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .find(|old| {
                        old.phase != "revoked"
                            && old.source.resource_owner == p.source.resource_owner
                            && old.source.workspace_id == p.source.workspace_id
                            && old.source.execution_workspace_id == p.source.execution_workspace_id
                            && old.source.branch_id == p.source.branch_id
                    })
                    .ok_or_else(|| {
                        denied("Continuation has no original source authority in this child Thread")
                    })?;
                let branch = p
                    .source
                    .branch_id
                    .as_deref()
                    .ok_or_else(|| denied("Continuation basis is not a fixed branch"))?;
                let revision = p
                    .source
                    .revision
                    .ok_or_else(|| denied("Continuation basis revision missing"))?;
                let basis = self.branch_read(
                    &json!({"branchId":branch,"revision":revision,"includeEntries":false}),
                )?;
                if basis["workspaceId"] != p.source.workspace_id
                    || basis["root"] != continuation.root
                {
                    return Err(denied(
                        "Continuation basis does not match original Storage root",
                    ));
                }
                let dispatch = continuation.execution_id;
                let op = format!("child-source-handoff:{dispatch}");
                let pin_id = format!("child-pin:{dispatch}");
                let authority = ChildSourceAuthority {
                    authority_id: previous.authority_id,
                    resource_epoch: previous.resource_epoch,
                };
                let expected = ChildSourceHandoff {
                    operation_id: op.clone(),
                    source: p.source.clone(),
                    resource_authority: Some(authority),
                    root: ChildSourceRoot::Fixed {
                        pin: ChildSourcePin {
                            pin_id: pin_id.clone(),
                            root: continuation.root,
                            source: p.source.clone(),
                        },
                    },
                };
                let identity = json!({"operationId":op,"workspaceId":p.source.workspace_id,"handoff":expected});
                let grant_id = previous.grant_id;
                let handoff =
                    super::operations::idempotent(self, "source.handoff", &identity, |storage| {
                        storage.branch_pin(
                            &json!({"branchId":branch,"revision":revision,"pinId":pin_id}),
                            true,
                            &grant_id,
                        )?;
                        Ok(serde_json::to_value(&expected)?)
                    })?;
                (serde_json::from_value(handoff)?, dispatch)
            }
            _ => {
                return Err(denied(
                    "Exactly one original child preparation proof is required",
                ));
            }
        };
        let storage_identity = self.root.to_string_lossy().to_string();
        self.claim_child_handoff(&json!({"grantId":p.grant_id,"operationId":dispatch,"childThreadId":thread_id,"childBranchId":branch_id}),&handoff,host,generation,&storage_identity,epoch)
    }
}

impl Storage {
    pub(crate) fn source_integration_receipt(
        &self,
        p: SourceIntegrationReceiptParams,
    ) -> Result<Value, KernelError> {
        let mut query = self.conn.prepare(
            "SELECT payload_json FROM domain_records WHERE record_type='source.authority'",
        )?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        let mut found = false;
        for body in rows {
            let authority: AuthorityRecord = serde_json::from_str(&body?)?;
            if authority.principal_id == p.principal_id
                && authority.coordinator_host_id == p.coordinator_host_id
                && authority.purpose == "integration"
                && authority.operation_id.as_deref() == Some(p.operation_id.as_str())
                && authority.result.scope.run_id() == Some(p.run_id.as_str())
                && authority.result.scope.thread_id() == p.thread_id
                && authority.result.source == p.source
            {
                found = true;
                break;
            }
        }
        if !found {
            return Err(denied(
                "Integration receipt has no matching original source authority",
            ));
        }
        let (reply, _) = std::sync::mpsc::channel();
        self.integration_receipt(&crate::tools::IntegrationReceiptRead {
            source: p.source,
            run_id: p.run_id,
            thread_id: p.thread_id,
            operation_id: p.operation_id,
            reply,
        })
    }
}
