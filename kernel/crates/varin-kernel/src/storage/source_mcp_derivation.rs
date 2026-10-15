//! Child MCP derivation is one receipt on the actual child Source. It retains
//! evidence bodies independently of the Source's physical/grant lifetime.
use super::*;
use crate::source_resources::{
    AuthorityRecord, SourceAuthorityAddress, SourceAuthorityScopeParams, SourceDispatch,
    SourceMcpCreationReceiptBodyRef as BodyRef, SourceMcpDerivationAction as Action,
    SourceMcpDerivationOutcome as Outcome, SourceMcpDerivationParams,
    SourceMcpDerivationReference,
};
use serde::{Deserialize, Serialize};
use varin_runtime::catalog::{
    collaboration::{ChildSourceHandoff, ChildSourcePin, ChildSourceRoot},
    launches::{HostToolBinding, LiveRoot, McpChildDerivationOrigin as Origin,
        McpChildDerivationProof as Proof, McpSourceAuthority, SourceSelection},
};

fn denied(message: &str) -> KernelError { KernelError::Authorization(message.into()) }

/// Only original Storage metadata is captured under its owner. Body hydration,
/// directory verification and hashing are performed by the existing Source worker.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
struct ProofIdentity {
    execution_id: String,
    child_run_id: String,
    child_thread_id: String,
    source_authority: McpSourceAuthority,
    source: SourceSelection,
    physical_root: LiveRoot,
    pin: ChildSourcePin,
    handoff: ChildSourceHandoff,
    materialization_operation_id: String,
    materialization_receipt_hash: String,
    origin: Origin,
    grant_id: String,
    scope: crate::source_resources::SourceAuthorityScope,
    physical_path: PathBuf,
    storage_path: PathBuf,
    directory_identity: materialization::DirectoryIdentity,
    selection_ref: Option<BodyRef>,
    selection_authorities: Vec<McpSourceAuthority>,
}
impl ProofIdentity {
    fn proof(&self, selection: HostToolBinding) -> Proof {
        Proof {
            execution_id:self.execution_id.clone(), child_run_id:self.child_run_id.clone(),
            child_thread_id:self.child_thread_id.clone(), source_authority:self.source_authority.clone(),
            source:self.source.clone(), physical_root:self.physical_root.clone(), pin:self.pin.clone(),
            handoff:self.handoff.clone(), materialization_operation_id:self.materialization_operation_id.clone(),
            materialization_receipt_hash:self.materialization_receipt_hash.clone(), origin:self.origin.clone(), selection,
        }
    }
    fn verify_directory(&self, root: &Path) -> Result<(), KernelError> {
        let canonical_storage = fs::canonicalize(root)?;
        let canonical_physical = fs::canonicalize(&self.physical_root.canonical_root)?;
        let key = self.materialization_operation_id.strip_prefix("source-materialize:")
            .ok_or_else(|| denied("Child materialization identity is invalid"))?;
        if canonical_storage != self.storage_path
            || canonical_physical != self.physical_path
            || canonical_physical != canonical_storage.join("managed").join("runs").join(key)
            || materialization::directory_identity(&canonical_physical)?.as_ref() != Some(&self.directory_identity)
        { return Err(denied("Child materialization directory no longer matches its original receipt")); }
        Ok(())
    }
    fn verify_selection(&self, selection: &HostToolBinding) -> Result<(), KernelError> {
        selection.validate().map_err(|e| denied(&e.to_string()))?;
        let original = selection.provenance.servers.values().next()
            .and_then(|server| server.owner.source_authority.as_ref());
        if original.is_none() || selection.provenance.servers.values().any(|server| {
            server.owner.resource_owner != self.source.resource_owner
                || server.owner.source_authority.as_ref() != original
                || server.owner.source_authority.as_ref().is_none_or(|owner| !self.selection_authorities.contains(owner))
        }) { return Err(denied("Child MCP selection belongs to another original Source")); }
        Ok(())
    }
}

struct RetainedBody {
    path: PathBuf,
    reference: BodyRef,
    _retention: blob_reads::BlobReadRetention,
}
impl RetainedBody {
    fn load<T: serde::de::DeserializeOwned>(&self) -> Result<T, KernelError> {
        let bytes = fs::read(&self.path)?;
        if bytes.len() as u64 != self.reference.byte_length
            || format!("sha256-{}", hex::encode(Sha256::digest(&bytes))) != self.reference.object_hash
        { return Err(KernelError::Storage("Original MCP derivation object is corrupt".into())); }
        Ok(serde_json::from_slice(&bytes)?)
    }
}

enum PreparationBody {
    Begin { identity: ProofIdentity, selection: Option<HostToolBinding>, original: Option<RetainedBody> },
    Settle { proof: RetainedBody, request_hash: String, outcome: Outcome },
}
pub(crate) struct McpDerivationPreparation {
    address: SourceAuthorityAddress,
    execution_id: String,
    epoch: String,
    root: PathBuf,
    body: PreparationBody,
}
enum StagedBody {
    Begin(ProofIdentity),
    Settle { request_ref: BodyRef },
}
pub(crate) struct StagedMcpDerivation {
    address: SourceAuthorityAddress,
    execution_id: String,
    epoch: String,
    staged: PathBuf,
    reference: BodyRef,
    request_hash: String,
    body: StagedBody,
    response: Option<Value>,
}
impl Drop for StagedMcpDerivation {
    fn drop(&mut self) { let _ = fs::remove_file(&self.staged); }
}
fn verify_outcome(proof: &Proof, outcome: &Outcome) -> Result<(), KernelError> {
    match outcome {
        Outcome::Failed { code } if !code.is_empty() => Ok(()),
        Outcome::Derived { provenance } => {
            if provenance.servers.len() != proof.selection.provenance.servers.len()
                || proof.selection.provenance.servers.iter().any(|(name, original)| {
                    provenance.servers.get(name).is_none_or(|derived| {
                        !derived.owner.validate()
                            || derived.definition_version != original.definition_version
                            || derived.resource_key.is_empty()
                            || derived.owner.source_authority.as_ref() != Some(&proof.source_authority)
                            || derived.owner.resource_owner != proof.source.resource_owner
                            || derived.owner.execution_scope != original.owner.execution_scope
                            || derived.owner.configuration != original.owner.configuration
                    })
                })
            { return Err(denied("MCP derivation outcome changed the frozen child definitions or Source")); }
            Ok(())
        }
        _ => Err(denied("MCP derivation failure requires an explicit code")),
    }
}
impl McpDerivationPreparation {
    pub(crate) fn stage(self) -> Result<StagedMcpDerivation, KernelError> {
        let (body, request_hash, stored, response) = match self.body {
            PreparationBody::Begin { identity, selection, original } => {
                identity.verify_directory(&self.root)?;
                let selection = match (selection, original) {
                    (Some(selection), None) => selection,
                    (None, Some(original)) => original.load::<HostToolBinding>()?,
                    _ => return Err(denied("Exactly one original child MCP selection is required")),
                };
                identity.verify_selection(&selection)?;
                let proof = serde_json::to_value(identity.proof(selection))?;
                let request_hash = hash_json(&proof)?;
                (StagedBody::Begin(identity), request_hash, proof.clone(),
                    json!({"proof":proof,"outcome":null}))
            }
            PreparationBody::Settle { proof, request_hash, outcome } => {
                if proof.reference.object_hash != request_hash {
                    return Err(denied("Original child MCP request fingerprint changed"));
                }
                let original = proof.load::<Proof>()?;
                if original.execution_id != self.execution_id
                    || original.source_authority.authority_id != self.address.authority_id
                    || original.source_authority.resource_epoch != self.address.resource_epoch
                    || original.source_authority.coordinator_host_id != self.address.coordinator_host_id
                { return Err(denied("Original child MCP proof belongs to another Source")); }
                verify_outcome(&original, &outcome)?;
                let stored = serde_json::to_value(&outcome)?;
                (StagedBody::Settle { request_ref:proof.reference.clone() }, request_hash, stored,
                    json!({"proof":original,"outcome":outcome}))
            }
        };
        let bytes = serde_json::to_vec(&stored)?;
        let staged = StagedMcpDerivation {
            address:self.address, execution_id:self.execution_id, epoch:self.epoch,
            staged:self.root.join("staging").join(format!("source-mcp-derivation-{}", Uuid::new_v4())),
            reference:BodyRef { object_hash:format!("sha256-{}", hex::encode(Sha256::digest(&bytes))), byte_length:bytes.len() as u64 },
            request_hash, body, response:Some(response),
        };
        let mut file = OpenOptions::new().create_new(true).write(true).open(&staged.staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(staged)
    }
}
pub(crate) struct McpDerivationBody {
    value: Value,
    proof: Option<RetainedBody>,
    outcome: Option<RetainedBody>,
}
impl McpDerivationBody {
    pub(crate) fn load(mut self) -> Result<Value, KernelError> {
        if let Some(proof) = self.proof { self.value["proof"] = proof.load::<Value>()?; }
        if let Some(outcome) = self.outcome { self.value["outcome"] = outcome.load::<Value>()?; }
        Ok(self.value)
    }
}

impl Storage {
    fn derivation_body(&mut self, reference: &BodyRef) -> Result<RetainedBody, KernelError> {
        Ok(RetainedBody { path:object_path(&self.root, &reference.object_hash)?, reference:reference.clone(),
            _retention:self.blob_read_roots.retain(&reference.object_hash) })
    }
    fn check_derivation_source(record: &AuthorityRecord, execution: &str) -> Result<(), KernelError> {
        if execution.is_empty() || record.purpose != "mcp_owner"
            || record.result.source.mode != varin_runtime::SourceMode::Materialized
            || record.result.scope.run_id().is_none()
            || record.result.source.environment_run_id.is_some()
            || record.result.source.branch_id.as_deref() != Some(format!("child-source:{execution}").as_str())
            || record.result.source.revision != Some(0)
            || record.result.mcp_derivation.as_ref().is_some_and(|reference| reference.execution_id != execution)
        { return Err(denied("MCP derivation requires its exact Materialized child Source")); }
        Ok(())
    }
    fn admit_derivation_source(&self, address: &SourceAuthorityAddress, record: &AuthorityRecord, epoch: &str) -> Result<Grant, KernelError> {
        self.source_authority(address, true, epoch)?;
        let grant = self.load_grant(&record.result.grant_id)?;
        if record.result.phase != "ready" || grant.state != crate::model::GrantState::Active
            || grant.kernel_epoch != epoch || grant.thread_id.as_deref() != Some(record.result.scope.thread_id())
            || grant.run_id.as_deref() != record.result.scope.run_id()
            || grant.owning_workspace.as_deref() != Some(record.result.source.workspace_id.as_str())
            || grant.execution_workspace.as_deref() != Some(record.result.source.execution_workspace_id.as_str())
            || record.result.source.resource_owner.host_id() != Some(grant.host_id.as_str())
        { return Err(denied("Child MCP Source no longer admits derivation")); }
        Ok(grant)
    }
    fn derivation_result(&self, record: &AuthorityRecord) -> Result<Value, KernelError> {
        let grant = self.load_grant(&record.result.grant_id)?;
        Ok(json!({"reference":record.result.mcp_derivation,"created":false,"phase":record.result.phase,
            "grantState":grant.state,"proof":null,"outcome":null}))
    }
    fn capture_derivation_identity(&self, address: &SourceAuthorityAddress, record: &AuthorityRecord,
        execution: &str, origin: &Origin, epoch: &str) -> Result<ProofIdentity, KernelError>
    {
        Self::check_derivation_source(record, execution)?;
        let grant = self.admit_derivation_source(address, record, epoch)?;
        let source = &record.result.source;
        let physical = record.result.physical_root.as_ref()
            .ok_or_else(|| denied("Child MCP Source has no actual execution directory"))?;
        let registered = self.admitted_file_root(&physical.root_id, &grant)?;
        if physical.host_id != grant.host_id
            || registered.owning_workspace_id != source.workspace_id
            || registered.execution_workspace_id != source.execution_workspace_id
        { return Err(denied("Child physical root belongs to another Source")); }
        let handoff_id = format!("child-source-handoff:{execution}");
        let receipt = self.operation_get(&json!({"operationId":handoff_id}))?;
        let owned: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_owners WHERE operation_id=?1 AND workspace_id=?2)",
            params![handoff_id, source.workspace_id], |row| row.get(0))?;
        if !owned || receipt["kind"] != "source.handoff" || receipt["state"] != "committed" {
            return Err(denied("Child Source has no committed original handoff"));
        }
        let handoff: ChildSourceHandoff = serde_json::from_value(receipt["result"].clone())?;
        if handoff.operation_id != handoff_id || handoff.source.resource_owner != source.resource_owner
            || handoff.source.workspace_id != source.workspace_id
            || handoff.source.execution_workspace_id != source.execution_workspace_id
        { return Err(denied("Child handoff belongs to another resource")); }
        let creator_address = handoff.resource_authority.as_ref()
            .ok_or_else(|| denied("Child handoff has no original managed Source"))?;
        let creator = self.source_authority(&SourceAuthorityAddress {
            principal_id:address.principal_id.clone(), coordinator_host_id:address.coordinator_host_id.clone(),
            authority_id:creator_address.authority_id.clone(), resource_epoch:creator_address.resource_epoch.clone(),
        }, false, epoch)?;
        let (selection_ref, mut selection_authorities) = match origin {
            Origin::Dispatch { parent_source_authority:parent, binding } => {
                if !binding.validate() || binding.operation_id != execution
                    || parent.coordinator_host_id != address.coordinator_host_id
                    || record.result.scope.thread_id() != format!("thread:child:{execution}")
                { return Err(denied("Child derivation differs from its original dispatch")); }
                let parent_record = self.source_authority(&SourceAuthorityAddress {
                    principal_id:address.principal_id.clone(), coordinator_host_id:parent.coordinator_host_id.clone(),
                    authority_id:parent.authority_id.clone(), resource_epoch:parent.resource_epoch.clone(),
                }, false, epoch)?;
                if parent_record.purpose != "mcp_owner"
                    || parent_record.result.scope.run_id() != Some(binding.parent_run_id.as_str())
                    || creator.result.scope.run_id() != Some(binding.parent_run_id.as_str())
                    || creator.result.scope.thread_id() != parent_record.result.scope.thread_id()
                    || creator.result.source != parent_record.result.source
                    || creator.result.source != handoff.source
                { return Err(denied("Dispatch handoff and frozen MCP definitions have different original owners")); }
                let retained = parent_record.result.mcp_children.iter().find(|child| child.binding == *binding)
                    .filter(|child| !child.released)
                    .ok_or_else(|| denied("Original dispatch MCP definitions are no longer retained"))?;
                let reference = retained.selection_ref.clone()
                    .ok_or_else(|| denied("Original dispatch MCP selection is unavailable"))?;
                (Some(reference), vec![parent.clone()])
            }
            Origin::Continuation { previous_run_id } => {
                if previous_run_id.is_empty() || creator.result.scope.run_id() != Some(previous_run_id.as_str())
                    || creator.result.scope.thread_id() != record.result.scope.thread_id()
                    || creator.result.source.resource_owner != handoff.source.resource_owner
                    || creator.result.source.workspace_id != handoff.source.workspace_id
                    || creator.result.source.execution_workspace_id != handoff.source.execution_workspace_id
                    || creator.result.source.branch_id != handoff.source.branch_id
                    || !matches!(handoff.root, ChildSourceRoot::Fixed { .. })
                { return Err(denied("Continuation handoff has no exact predecessor Source in this child Thread")); }
                let predecessors: Vec<crate::source_resources::SourceAuthorityResult> = serde_json::from_value(
                    self.inspect_source_scope(SourceAuthorityScopeParams {
                        principal_id:address.principal_id.clone(), coordinator_host_id:address.coordinator_host_id.clone(),
                        thread_id:record.result.scope.thread_id().into(), run_id:previous_run_id.clone(),
                    })?)?;
                let owners = predecessors.into_iter().filter(|old| old.purpose == "mcp_owner"
                    && old.source == creator.result.source).map(|old| McpSourceAuthority {
                        coordinator_host_id:address.coordinator_host_id.clone(), authority_id:old.authority_id,
                        resource_epoch:old.resource_epoch,
                    }).collect::<Vec<_>>();
                if owners.is_empty() { return Err(denied("Continuation has no actual predecessor MCP Source")); }
                (None, owners)
            }
        };
        selection_authorities.sort_by(|left, right| left.authority_id.cmp(&right.authority_id));
        let branch_id = format!("child-source:{execution}");
        let branch = self.branch(&branch_id)?;
        let revision = self.branch_read(&json!({"branchId":branch_id,"revision":0,"includeEntries":false}))?;
        let pin_id = format!("child-source-pin:{execution}");
        let (pin_branch, pin_workspace, pin_revision, write_revision, root, creator_grant):
            (String, String, i64, i64, String, String) = self.conn.query_row(
            "SELECT branch_id, workspace_id, revision, write_revision, root_hash, grant_id FROM pins WHERE pin_id=?1",
            [&pin_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))?;
        let preparation_grant = self.load_grant(&creator_grant)?;
        if pin_branch != branch_id || pin_workspace != source.workspace_id || pin_revision != 0 || write_revision >= 0
            || branch.workspace_id != source.workspace_id || revision["root"] != root
            || preparation_grant.handoff_operation_id.as_deref() != Some(handoff_id.as_str())
            || preparation_grant.thread_id.as_deref() != Some(record.result.scope.thread_id())
            || preparation_grant.owning_workspace.as_deref() != Some(source.workspace_id.as_str())
            || preparation_grant.execution_workspace.as_deref() != Some(source.execution_workspace_id.as_str())
            || preparation_grant.host_id != grant.host_id
        { return Err(denied("Child initial pin has no original restricted preparation lineage")); }
        if let ChildSourceRoot::Fixed { pin } = &handoff.root {
            if pin.source != handoff.source || pin.root != root || branch.base_root != root {
                return Err(denied("Fixed child handoff differs from its immutable initial root"));
            }
        }
        // A physical capture has no parent immutable root to compare. Its factual
        // root is the real revision-0 pin created under the restricted handoff grant.
        let created = self.operation_get(&json!({"operationId":format!("branch-create:{branch_id}")}))?;
        if created["kind"] != "branch.create" || created["state"] != "committed"
            || created["result"]["branchId"] != branch_id || created["result"]["workspaceId"] != source.workspace_id
            || created["result"]["root"] != root
        { return Err(denied("Child initial branch has no matching creation receipt")); }
        let run = record.result.scope.run_id().expect("child Run scope checked");
        let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!([source.workspace_id, run]))?));
        let materialization_id = format!("source-materialize:{key}");
        if record.result.materialization_operation_id != materialization_id {
            return Err(denied("Child Source materialization operation changed"));
        }
        // The registered actual child directory supplies the canonical namespace
        // spelling (including Win32 prefixes); the worker verifies its Storage base.
        let storage_path = registered.canonical_root.ancestors().nth(3)
            .ok_or_else(|| denied("Child physical directory is outside managed Storage"))?.to_path_buf();
        if registered.canonical_root != storage_path.join("managed").join("runs").join(&key) {
            return Err(denied("Child physical directory is not its original Run materialization"));
        }
        let container_id = file_resources::file_root_identity(&source.workspace_id,
            &source.execution_workspace_id, &storage_path);
        let params = json!({"operationId":materialization_id,"workspaceId":source.workspace_id,
            "rootId":container_id,"path":format!("managed/runs/{key}"),"sourceRoot":root});
        let materialized = self.committed_file_operation(&materialization_id, "file.materialize", &params,
            &source.workspace_id)?.ok_or_else(|| denied("Child Source has no exact original materialization receipt"))?;
        if materialized["status"] != "materialized" || materialized["root"] != root {
            return Err(denied("Child Source materialization did not commit its initial root"));
        }
        let directory_identity = serde_json::from_value::<Option<materialization::DirectoryIdentity>>(
            materialized["directoryIdentity"].clone())?
            .ok_or_else(|| denied("Child materialization has no original directory identity"))?;
        Ok(ProofIdentity {
            execution_id:execution.into(), child_run_id:run.into(), child_thread_id:record.result.scope.thread_id().into(),
            source_authority:McpSourceAuthority { coordinator_host_id:address.coordinator_host_id.clone(),
                authority_id:address.authority_id.clone(), resource_epoch:address.resource_epoch.clone() },
            source:source.clone(), physical_root:physical.clone(),
            pin:ChildSourcePin { pin_id, root, source:SourceSelection { mode:varin_runtime::SourceMode::FixedBranch, ..source.clone() } },
            handoff, materialization_operation_id:materialization_id,
            materialization_receipt_hash:hash_json(&materialized)?, origin:origin.clone(), grant_id:grant.grant_id,
            scope:record.result.scope.clone(), physical_path:registered.canonical_root, storage_path,
            directory_identity, selection_ref, selection_authorities,
        })
    }
    pub(crate) fn source_mcp_derivation(&mut self, p: SourceMcpDerivationParams, epoch: &str) -> Result<SourceDispatch, KernelError> {
        let address = SourceAuthorityAddress { principal_id:p.principal_id, coordinator_host_id:p.coordinator_host_id,
            authority_id:p.authority_id, resource_epoch:p.resource_epoch };
        let mut record = self.source_authority(&address, false, epoch)?;
        Self::check_derivation_source(&record, &p.execution_id)?;
        if (p.action == Action::Begin) != p.origin.is_some()
            || (p.action == Action::Settle) != p.outcome.is_some()
            || p.selection.is_some() != (p.action == Action::Begin && matches!(p.origin, Some(Origin::Continuation { .. })))
        { return Err(denied("MCP derivation action body is invalid")); }
        if record.result.mcp_derivation.as_ref().is_some_and(|reference| reference.released) {
            return Ok(SourceDispatch::Ready(self.derivation_result(&record)?));
        }
        if p.action == Action::Begin {
            let identity = self.capture_derivation_identity(&address, &record, &p.execution_id,
                p.origin.as_ref().expect("begin origin checked"), epoch)?;
            let original = identity.selection_ref.as_ref().map(|reference| self.derivation_body(reference)).transpose()?;
            return Ok(SourceDispatch::McpDerivationStage(McpDerivationPreparation {
                address, execution_id:p.execution_id, epoch:epoch.into(), root:self.root.clone(),
                body:PreparationBody::Begin { identity, selection:p.selection, original },
            }));
        }
        if p.action == Action::Release {
            let reference = record.result.mcp_derivation.get_or_insert(SourceMcpDerivationReference {
                execution_id:p.execution_id, released:true, request_hash:None, request_ref:None, outcome_ref:None,
            });
            reference.released = true;
            self.save_source_record("source.authority", &address.authority_id,
                &record.result.source.workspace_id, &record.result.phase, &record)?;
            return Ok(SourceDispatch::Ready(self.derivation_result(&record)?));
        }
        let reference = record.result.mcp_derivation.as_ref()
            .ok_or_else(|| denied("Original child MCP derivation is unavailable"))?;
        if p.action == Action::Settle {
            self.admit_derivation_source(&address, &record, epoch)?;
            let proof = reference.request_ref.as_ref().ok_or_else(|| denied("Original child MCP proof is unavailable"))?;
            return Ok(SourceDispatch::McpDerivationStage(McpDerivationPreparation {
                address, execution_id:p.execution_id, epoch:epoch.into(), root:self.root.clone(),
                body:PreparationBody::Settle {
                    proof:self.derivation_body(proof)?, request_hash:reference.request_hash.clone()
                        .ok_or_else(|| denied("Original child MCP proof fingerprint is unavailable"))?,
                    outcome:p.outcome.expect("settlement outcome checked"),
                },
            }));
        }
        let value = self.derivation_result(&record)?;
        if p.action == Action::Read {
            return Ok(SourceDispatch::McpDerivationObserve(McpDerivationBody {
                value,
                proof:reference.request_ref.as_ref().map(|reference| self.derivation_body(reference)).transpose()?,
                outcome:reference.outcome_ref.as_ref().map(|reference| self.derivation_body(reference)).transpose()?,
            }));
        }
        Ok(SourceDispatch::Ready(value))
    }
    pub(crate) fn publish_source_mcp_derivation(&mut self, mut staged: StagedMcpDerivation) -> Result<Value, KernelError> {
        let mut record = self.source_authority(&staged.address, false, &staged.epoch)?;
        Self::check_derivation_source(&record, &staged.execution_id)?;
        if record.result.mcp_derivation.as_ref().is_some_and(|reference| reference.released) {
            return self.derivation_result(&record);
        }
        self.admit_derivation_source(&staged.address, &record, &staged.epoch)?;
        let created;
        let mut publish = true;
        match &staged.body {
            StagedBody::Begin(identity) => {
                let current = self.capture_derivation_identity(&staged.address, &record,
                    &staged.execution_id, &identity.origin, &staged.epoch)?;
                if current != *identity { return Err(denied("Child MCP derivation Source evidence changed before publication")); }
                if let Some(reference) = &record.result.mcp_derivation {
                    if reference.request_hash.as_deref() != Some(staged.request_hash.as_str())
                        || reference.request_ref.as_ref() != Some(&staged.reference)
                    { return Err(denied("Child MCP derivation identity was reused with different evidence")); }
                    created = false;
                    publish = false;
                } else {
                    record.result.mcp_derivation = Some(SourceMcpDerivationReference {
                        execution_id:staged.execution_id.clone(), released:false,
                        request_hash:Some(staged.request_hash.clone()), request_ref:Some(staged.reference.clone()), outcome_ref:None,
                    });
                    created = true;
                }
            }
            StagedBody::Settle { request_ref } => {
                let reference = record.result.mcp_derivation.as_mut()
                    .ok_or_else(|| denied("Original child MCP derivation disappeared before settlement"))?;
                if reference.request_hash.as_deref() != Some(staged.request_hash.as_str())
                    || reference.request_ref.as_ref() != Some(request_ref)
                { return Err(denied("Original child MCP derivation changed before settlement")); }
                if let Some(outcome) = &reference.outcome_ref {
                    if outcome != &staged.reference { return Err(denied("Original child MCP derivation outcome changed")); }
                    publish = false;
                } else { reference.outcome_ref = Some(staged.reference.clone()); }
                created = false;
            }
        }
        if publish {
            let object = object_path(&self.root, &staged.reference.object_hash)?;
            let shard = object.parent().expect("content object shard");
            if !shard.exists() { fs::create_dir_all(shard)?; sync_directory(&self.root.join("objects"))?; }
            durable_rename(&staged.staged, &object)?;
            sync_directory(shard)?;
            sync_directory(&self.root.join("staging"))?;
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            let published = (|| {
                self.conn.execute("INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES(?1,?2)",
                    params![staged.reference.object_hash, i64::try_from(staged.reference.byte_length)
                        .map_err(|_| KernelError::Storage("MCP derivation object is too large".into()))?])?;
                self.conn.execute("DELETE FROM pending_gc_files WHERE hash=?1", [&staged.reference.object_hash])?;
                self.save_source_record("source.authority", &staged.address.authority_id,
                    &record.result.source.workspace_id, &record.result.phase, &record)
            })();
            if let Err(error) = published { let _ = self.conn.execute_batch("ROLLBACK"); return Err(error); }
            self.conn.execute_batch("COMMIT")?;
        }
        let mut response = staged.response.take().expect("staged derivation response");
        let metadata = self.derivation_result(&record)?;
        for key in ["reference", "phase", "grantState"] { response[key] = metadata[key].clone(); }
        response["created"] = json!(created);
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source_resources::{SourceAuthorityBindParams, SourceAuthorityOpenParams,
        SourceMcpChildParams};
    const HOST: &str = "derivation-host";
    const EPOCH: &str = "derivation-epoch";

    fn issue(storage: &mut Storage, id: &str, thread: &str, run: &str) -> Grant {
        storage.issue_grant(&json!({"grantId":id,"hostGeneration":"generation",
            "threadId":thread,"runId":run,"owningWorkspace":"workspace","executionWorkspace":"workspace",
            "capabilities":["storage.read","storage.write","process"],"pathScopes":[""]}),
            HOST,"generation",&storage.root.to_string_lossy().into_owned(),EPOCH).unwrap();
        storage.load_grant(id).unwrap()
    }
    fn open_source(storage: &mut Storage, source: &SourceSelection, path: &Path,
        id: &str, thread: &str, run: &str, purpose: &str) -> SourceAuthorityAddress
    {
        let grant = issue(storage,id,thread,run);
        let physical = storage.file_root_register(&json!({"workspaceId":"workspace",
            "executionWorkspaceId":"workspace","canonicalRoot":path}),&grant).unwrap();
        let opened = storage.source_authority_open(serde_json::from_value::<SourceAuthorityOpenParams>(json!({
            "principalId":"client","coordinatorHostId":"coordinator","scope":{"kind":"run","threadId":thread,"runId":run,"epoch":1},
            "source":source,"grantId":id,"enabledTools":[],"purpose":purpose})).unwrap(),EPOCH,HOST).unwrap();
        let address: SourceAuthorityAddress = serde_json::from_value(json!({"principalId":"client","coordinatorHostId":"coordinator",
            "authorityId":opened["authorityId"],"resourceEpoch":EPOCH})).unwrap();
        let mut binding = json!({"resourceOwner":source.resource_owner,"grantId":id,"runId":run,"threadId":thread,
            "workspaceId":"workspace","executionWorkspaceId":"workspace","rootId":physical["rootId"],
            "sourceMode":source.mode,"enabledTools":[]});
        binding["liveRoot"] = serde_json::to_value(&source.live_root).unwrap();
        if source.mode == varin_runtime::SourceMode::Materialized {
            binding["materializedSource"] = json!({"branchId":source.branch_id,"revision":source.revision});
        }
        let mut params = serde_json::to_value(&address).unwrap();
        params["toolBinding"] = binding;
        params["physicalRoot"] = json!({"hostId":HOST,"rootId":physical["rootId"],"canonicalRoot":physical["canonicalRoot"]});
        storage.source_authority_bind(serde_json::from_value::<SourceAuthorityBindParams>(params).unwrap(),EPOCH,HOST).unwrap();
        address
    }
    fn request(address: &SourceAuthorityAddress, action: &str, origin: &Origin) -> SourceMcpDerivationParams {
        let mut p = serde_json::to_value(address).unwrap(); p["executionId"] = json!("dispatch"); p["action"] = json!(action);
        if action == "begin" { p["origin"] = serde_json::to_value(origin).unwrap(); }
        serde_json::from_value(p).unwrap()
    }
    fn finish(storage: &mut Storage, work: SourceDispatch) -> Result<Value, KernelError> {
        match work {
            SourceDispatch::Ready(value) => Ok(value),
            SourceDispatch::McpDerivationStage(preparation) => storage.publish_source_mcp_derivation(preparation.stage()?),
            SourceDispatch::McpDerivationObserve(body) => body.load(),
            _ => panic!("unexpected Source work"),
        }
    }
    fn call(storage: &mut Storage, p: SourceMcpDerivationParams, epoch: &str) -> Result<Value, KernelError> {
        let work = storage.source_mcp_derivation(p,epoch)?; finish(storage,work)
    }
    #[test]
    fn child_mcp_derivation_uses_real_source_evidence_and_independent_receipt_lifetime() {
        let root = std::env::temp_dir().join(format!("varin-mcp-derivation-{}",Uuid::new_v4()));
        let mut storage = Storage::open(&root,HOST).unwrap();
        let live_path = root.join("parent"); fs::create_dir(&live_path).unwrap();
        let initial = issue(&mut storage,"parent-initial","parent-thread","parent-run");
        let live = storage.file_root_register(&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace",
            "canonicalRoot":live_path}),&initial).unwrap();
        let source: SourceSelection = serde_json::from_value(json!({
            "resource_owner":{"kind":"managed_host","hostId":HOST,"connectionId":"connection","endpointIdentity":"endpoint"},
            "workspace_id":"workspace","execution_workspace_id":"workspace","mode":"live_root","branch_id":null,"revision":null,
            "live_root":{"hostId":HOST,"rootId":live["rootId"],"canonicalRoot":live["canonicalRoot"]},"environment_run_id":null})).unwrap();
        let creator = open_source(&mut storage,&source,&live_path,"parent-files","parent-thread","parent-run","source");
        let parent = open_source(&mut storage,&source,&live_path,"parent-mcp","parent-thread","parent-run","mcp_owner");
        let parent_mcp = McpSourceAuthority { coordinator_host_id:parent.coordinator_host_id.clone(),
            authority_id:parent.authority_id.clone(),resource_epoch:parent.resource_epoch.clone() };
        let selection: HostToolBinding = serde_json::from_value(json!({"reference":"selection","generation":1,"tools":[],"routes":{},
            "resources":{"server:files":"original-resource"},"provenance":{"servers":{"files":{
                "definition_version":"definition","resource_key":"original-resource","owner":{"resource_owner":source.resource_owner,
                    "source_authority":parent_mcp,"configuration":{"agent_dir":"/agent","config_cwd":"/parent","project_trusted":true},
                    "execution_scope":"workspace"}}}}})).unwrap();
        let origin = Origin::Dispatch { parent_source_authority:parent_mcp,
            binding:varin_runtime::catalog::launches::SourceMcpChildBinding { operation_id:"dispatch".into(), parent_run_id:"parent-run".into(),
                execution_owner:varin_runtime::ExecutorOwner::Kernel, execution_epoch:1 } };
        let mut retain = serde_json::to_value(&parent).unwrap();
        if let Origin::Dispatch { binding, .. } = &origin { retain["binding"] = serde_json::to_value(binding).unwrap(); }
        retain["action"] = json!("retain"); retain["selection"] = serde_json::to_value(&selection).unwrap();
        let SourceDispatch::McpChildSelectionStage(prepared) = storage.source_mcp_child(
            serde_json::from_value::<SourceMcpChildParams>(retain).unwrap(),EPOCH).unwrap() else { panic!() };
        storage.publish_source_mcp_child(prepared.stage().unwrap()).unwrap();
        let creator_record = storage.source_authority(&creator,false,EPOCH).unwrap();
        let mut binding = creator_record.result.tool_binding.unwrap(); binding.target_authority = Some(creator);
        let grant = storage.load_grant(&binding.grant_id).unwrap();
        let handoff: ChildSourceHandoff = serde_json::from_value(storage.child_source_handoff(&binding,
            &varin_runtime::execution::ToolExecutionContext { run_id:"parent-run".into(),operation_id:"dispatch".into(),
                origin:varin_runtime::execution::ToolOrigin::ModelStep { request_id:"request".into() } },
            &varin_runtime::catalog::dispatch::ChildSourceDelegation {
                work_mode:varin_runtime::catalog::dispatch::ChildWorkMode::IsolatedWrite,process:false,configured_preset:false,selection_ref:Value::Null },
            &grant,HOST,false).unwrap()).unwrap();
        storage.claim_child_handoff(&json!({"grantId":"preparation","childThreadId":"thread:child:dispatch"}),
            &handoff,HOST,"generation",&root.to_string_lossy(),EPOCH).unwrap();
        storage.begin_branch_builder(&json!({"builderId":"builder","operationId":"branch-create:child-source:dispatch",
            "branchId":"child-source:dispatch","workspaceId":"workspace","draftBasePaths":[],"captureScopes":[]}),"preparation").unwrap();
        let branch = storage.finish_branch_builder(&json!({"builderId":"builder","operationId":"branch-create:child-source:dispatch"}),"preparation").unwrap();
        storage.branch_pin(&json!({"branchId":"child-source:dispatch","pinId":"child-source-pin:dispatch","revision":0}),true,"preparation").unwrap();
        let child_source = SourceSelection { mode:varin_runtime::SourceMode::Materialized, live_root:None,
            branch_id:Some("child-source:dispatch".into()),revision:Some(0),..source };
        let child_grant = issue(&mut storage,"child-files","thread:child:dispatch","child-run");
        let container = storage.file_root_register(&json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":root}),&child_grant).unwrap();
        let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!(["workspace","child-run"])).unwrap()));
        let operation = format!("source-materialize:{key}");
        let params = json!({"operationId":operation,"workspaceId":"workspace","rootId":container["rootId"],
            "path":format!("managed/runs/{key}"),"sourceRoot":branch["root"]});
        fs::create_dir_all(root.join("managed/runs")).unwrap();
        let materialization::Admission::Work(task) = storage.prepare_materialization(&params,&child_grant,Arc::new(AtomicBool::new(false))).unwrap()
            else { panic!() };
        task.run(|control| storage.control_materialization(&task.operation_id,&task.job_id,control,false)).unwrap();
        storage.finish_materialization(&task.operation_id,&task.job_id);
        let physical = root.join("managed/runs").join(key);
        open_source(&mut storage,&child_source,&physical,"child-files","thread:child:dispatch","child-run","source");
        let child = open_source(&mut storage,&child_source,&physical,"child-mcp","thread:child:dispatch","child-run","mcp_owner");
        let later = storage.branch_write(&json!({"branchId":"child-source:dispatch","expectedWriteRevision":0,
            "changes":[{"path":"later-work","state":{"kind":"directory","mode":null}}]}),"child-files").unwrap();
        assert_ne!(later["root"],branch["root"],"a writable child may advance after its initial materialization");
        // A caller cannot substitute parent ownership, preparation lineage or disk identity.
        let mut foreign = request(&child,"begin",&origin); foreign.principal_id = "other".into();
        assert!(call(&mut storage,foreign,EPOCH).is_err());
        storage.conn.execute("UPDATE pins SET grant_id='parent-files' WHERE pin_id='child-source-pin:dispatch'",[]).unwrap();
        assert!(call(&mut storage,request(&child,"begin",&origin),EPOCH).is_err());
        storage.conn.execute("UPDATE pins SET grant_id='preparation' WHERE pin_id='child-source-pin:dispatch'",[]).unwrap();
        let SourceDispatch::McpDerivationStage(prepared) = storage.source_mcp_derivation(request(&child,"begin",&origin),EPOCH).unwrap() else { panic!() };
        fs::rename(&physical,root.join("saved-child-directory")).unwrap(); fs::create_dir(&physical).unwrap();
        assert!(prepared.stage().is_err()); fs::remove_dir(&physical).unwrap(); fs::rename(root.join("saved-child-directory"),&physical).unwrap();
        let begun = call(&mut storage,request(&child,"begin",&origin),EPOCH).unwrap();
        assert_eq!(begun["created"],true);
        assert_eq!(begun["proof"]["pin"]["root"],branch["root"]);
        assert_eq!(begun["proof"]["selection"],serde_json::to_value(&selection).unwrap());
        assert_eq!(call(&mut storage,request(&child,"begin",&origin),EPOCH).unwrap()["created"],false);
        let mut derived = selection.provenance.clone();
        for server in derived.servers.values_mut() {
            server.resource_key = "child-resource".into();
            server.owner.source_authority = Some(serde_json::from_value(begun["proof"]["source_authority"].clone()).unwrap());
        }
        let mut settlement = request(&child,"settle",&origin); settlement.outcome = Some(Outcome::Derived { provenance:derived });
        let settled = call(&mut storage,settlement,EPOCH).unwrap(); assert_eq!(settled["created"],false);
        assert_eq!(settled["outcome"]["kind"],"derived");
        let second = open_source(&mut storage,&child_source,&physical,"child-mcp-second","thread:child:dispatch","child-run","mcp_owner");
        let SourceDispatch::McpDerivationStage(prepared) = storage.source_mcp_derivation(request(&second,"begin",&origin),EPOCH).unwrap() else { panic!() };
        let staged = prepared.stage().unwrap();
        let released = call(&mut storage,request(&second,"release",&origin),EPOCH).unwrap();
        assert!(released["reference"]["requestRef"].is_null());
        assert_eq!(storage.publish_source_mcp_derivation(staged).unwrap(),released);
        assert_eq!(call(&mut storage,request(&second,"begin",&origin),EPOCH).unwrap(),released);
        let revoked = open_source(&mut storage,&child_source,&physical,"child-mcp-revoked","thread:child:dispatch","child-run","mcp_owner");
        let SourceDispatch::McpDerivationStage(prepared) = storage.source_mcp_derivation(request(&revoked,"begin",&origin),EPOCH).unwrap() else { panic!() };
        let staged = prepared.stage().unwrap();
        storage.revoke_grant(&json!({"grantId":"child-mcp-revoked"}),HOST).unwrap();
        assert!(storage.publish_source_mcp_derivation(staged).is_err(),"publication must recheck the actual grant");
        // Continuation derives from the predecessor's actual MCP Source. Its
        // synthetic Fixed handoff is resolved from Storage, never supplied to begin.
        let basis = SourceSelection { mode:varin_runtime::SourceMode::FixedBranch,..child_source.clone() };
        storage.claim_source_handoff(serde_json::from_value(json!({
            "principalId":"client","coordinatorHostId":"coordinator","grantId":"continuation-preparation",
            "scope":{"kind":"source_read","threadId":"thread:child:dispatch","branchId":"branch:child:dispatch","key":"continuation"},
            "source":basis,"continuation":{"executionId":"continuation","previousRunId":"child-run","root":branch["root"]}
        })).unwrap(),EPOCH,HOST,"generation").unwrap();
        storage.begin_branch_builder(&json!({"builderId":"continuation-builder","operationId":"branch-create:child-source:continuation",
            "branchId":"child-source:continuation","workspaceId":"workspace","draftBasePaths":[],"captureScopes":[],"baseRef":branch["root"],
            "parentRef":"child-source:dispatch@0"}),"continuation-preparation").unwrap();
        let continuation_branch = storage.finish_branch_builder(&json!({"builderId":"continuation-builder",
            "operationId":"branch-create:child-source:continuation"}),"continuation-preparation").unwrap();
        storage.branch_pin(&json!({"branchId":"child-source:continuation","pinId":"child-source-pin:continuation","revision":0}),
            true,"continuation-preparation").unwrap();
        let continuation_source = SourceSelection { branch_id:Some("child-source:continuation".into()),..child_source.clone() };
        let continuation_grant = issue(&mut storage,"continuation-files","thread:child:dispatch","continuation-run");
        let key = hex::encode(Sha256::digest(serde_json::to_vec(&json!(["workspace","continuation-run"])).unwrap()));
        let params = json!({"operationId":format!("source-materialize:{key}"),"workspaceId":"workspace","rootId":container["rootId"],
            "path":format!("managed/runs/{key}"),"sourceRoot":continuation_branch["root"]});
        let materialization::Admission::Work(task) = storage.prepare_materialization(&params,&continuation_grant,
            Arc::new(AtomicBool::new(false))).unwrap() else { panic!() };
        task.run(|control| storage.control_materialization(&task.operation_id,&task.job_id,control,false)).unwrap();
        storage.finish_materialization(&task.operation_id,&task.job_id);
        let continuation_path = root.join("managed/runs").join(key);
        open_source(&mut storage,&continuation_source,&continuation_path,"continuation-files","thread:child:dispatch","continuation-run","source");
        let continuation = open_source(&mut storage,&continuation_source,&continuation_path,"continuation-mcp",
            "thread:child:dispatch","continuation-run","mcp_owner");
        let continuation_origin = Origin::Continuation { previous_run_id:"child-run".into() };
        let mut continuation_selection = selection.clone();
        continuation_selection.reference = "continuation-selection".into();
        continuation_selection.generation += 1;
        continuation_selection.resources.insert("server:files".into(),"child-resource".into());
        continuation_selection.provenance = serde_json::from_value(settled["outcome"]["provenance"].clone()).unwrap();
        let continuation_request = |action: &str| {
            let mut p = request(&continuation,action,&continuation_origin); p.execution_id = "continuation".into();
            if action == "begin" { p.selection = Some(continuation_selection.clone()); }
            p
        };
        let mut wrong = continuation_request("begin"); wrong.selection = Some(selection.clone());
        assert!(call(&mut storage,wrong,EPOCH).is_err(),"initial parent definitions cannot stand in for a predecessor MCP Source");
        let continued = call(&mut storage,continuation_request("begin"),EPOCH).unwrap();
        assert_eq!(continued["created"],true);
        assert_eq!(continued["proof"]["handoff"]["root"]["kind"],"fixed");
        assert_eq!(continued["proof"]["pin"]["root"],continuation_branch["root"]);
        let mut provenance = continuation_selection.provenance.clone();
        for server in provenance.servers.values_mut() {
            server.resource_key = "continuation-resource".into();
            server.owner.source_authority = Some(serde_json::from_value(continued["proof"]["source_authority"].clone()).unwrap());
        }
        let mut settlement = continuation_request("settle"); settlement.outcome = Some(Outcome::Derived { provenance });
        let continuation_settled = call(&mut storage,settlement,EPOCH).unwrap();
        assert_eq!(storage.release_source_authority(&continuation,"retire",HOST,EPOCH).unwrap()["phase"],"retired");
        // Evidence does not keep an MCP grant or physical Source in retaining.
        assert_eq!(storage.release_source_authority(&child,"retire",HOST,EPOCH).unwrap()["phase"],"retired");
        let proof_path = object_path(&root,begun["reference"]["requestRef"]["objectHash"].as_str().unwrap()).unwrap();
        let outcome_path = object_path(&root,settled["reference"]["outcomeRef"]["objectHash"].as_str().unwrap()).unwrap();
        storage.gc().unwrap(); storage.drain_gc_files().unwrap(); assert!(proof_path.exists() && outcome_path.exists());
        drop(storage);
        let mut storage = Storage::open(&root,HOST).unwrap();
        let continued_read = call(&mut storage,continuation_request("read"),"new-epoch").unwrap();
        assert_eq!(continued_read["proof"],continued["proof"]);
        assert_eq!(continued_read["outcome"],continuation_settled["outcome"]);
        call(&mut storage,continuation_request("release"),"new-epoch").unwrap();
        let read = call(&mut storage,request(&child,"read",&origin),"new-epoch").unwrap();
        assert_eq!(read["proof"],begun["proof"]); assert_eq!(read["outcome"],settled["outcome"]);
        assert!(call(&mut storage,request(&child,"begin",&origin),"new-epoch").is_err());
        let reading = storage.source_mcp_derivation(request(&child,"read",&origin),"new-epoch").unwrap();
        call(&mut storage,request(&child,"release",&origin),"new-epoch").unwrap();
        storage.gc().unwrap(); storage.drain_gc_files().unwrap(); assert!(proof_path.exists());
        assert_eq!(finish(&mut storage,reading).unwrap()["proof"],begun["proof"]);
        storage.gc().unwrap(); storage.drain_gc_files().unwrap(); assert!(!proof_path.exists() && !outcome_path.exists());
        drop(storage); fs::remove_dir_all(root).unwrap();
    }
}
