//! Launch ownership is small metadata; executable descriptions are immutable content.
//! Capture while holding Catalog, then validate, hash, write and hydrate on the caller's worker.
use super::*;
use crate::execution::{policy_model::PolicyModelCapability, PolicyIdentity, ToolSchema};
use launches::{
    ExtensionToolBinding, HostToolBinding, LaunchIntent, LaunchSelection, SourceSelection,
    McpChildDerivationOrigin, McpChildDerivationReceipt, McpSourceAuthority, SourceResourceOwner,
};

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PolicyModelReference {
    pub capability_id: String,
    pub body: Value,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LaunchSelectionMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<launches::AgentSelection>,
    pub child_dispatch_ref: Option<Value>,
    pub credential_scope: Option<crate::providers::auth::CredentialScope>,
    pub connection_identity: String,
    pub provider_family: String,
    pub model: String,
    pub configuration_generation: u64,
    pub tool_schema_generation: u64,
    pub policy: PolicyIdentity,
    pub source: Option<SourceSelection>,
    pub tools_ref: Value,
    pub base_tools_ref: Value,
    pub mcp_binding_ref: Option<Value>,
    pub extension_bindings_ref: Value,
    pub policy_models: Vec<PolicyModelReference>,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LaunchMetadata {
    pub dispatch_context_ref: Option<Value>,
    pub policy_generation: u64,
    pub policy_target: super::policy_switch::PolicyTargetMetadata,
    pub preparation_failure: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_failure_detail: Option<String>,
    pub run_id: String,
    pub revision: u64,
    pub selection: LaunchSelectionMetadata,
    pub bound_epoch: Option<u64>,
    pub requires_rebind: bool,
}
impl LaunchSelectionMetadata {
    pub(super) fn rebase_policy_models(
        &mut self,
        content: &crate::content::ContentStore,
    ) -> Result<()> {
        let mut models = self.load_policy_models(content)?;
        for model in &mut models {
            if model.status == crate::execution::PolicyModelStatus::Available {
                let identity = model.configuration_identity.as_deref().ok_or_else(|| {
                    RuntimeError::Invalid("planning configuration identity is missing".into())
                })?;
                model.binding_id = Some(format!("policy:0:{}:{identity}", model.capability_id));
            }
        }
        self.policy_models = stage_policy_models(content, &models)?;
        Ok(())
    }
    pub(super) fn stage(
        content: &crate::content::ContentStore,
        selection: LaunchSelection,
    ) -> Result<Self> {
        selection.validate()?;
        Self::stage_validated(content, selection)
    }
    /// Non-executable delegation description. ChildSource alone owns Pending/Ready;
    /// submission validates the eventual child's exact source before creating its Run.
    pub(super) fn stage_child_intent(
        content: &crate::content::ContentStore,
        selection: LaunchSelection,
    ) -> Result<Self> {
        selection.validate_structure()?;
        Self::stage_validated(content, selection)
    }
    fn stage_validated(
        content: &crate::content::ContentStore,
        selection: LaunchSelection,
    ) -> Result<Self> {
        let tools_ref = content.save(&serde_json::to_value(&selection.tools)?)?;
        let mut mcp_names = selection
            .mcp_binding
            .as_ref()
            .map(|binding| {
                binding
                    .tools
                    .iter()
                    .map(|tool| tool.name.as_str())
                    .collect::<std::collections::BTreeSet<_>>()
            })
            .unwrap_or_default();
        mcp_names.extend(
            selection
                .extension_bindings
                .iter()
                .map(|b| b.tool.name.as_str()),
        );
        let extension_bindings_ref =
            content.save(&serde_json::to_value(&selection.extension_bindings)?)?;
        let mut base = selection
            .tools
            .iter()
            .filter(|tool| !mcp_names.contains(tool.name.as_str()))
            .collect::<Vec<_>>();
        base.sort_by(|left, right| left.name.cmp(&right.name));
        let base_tools_ref = content.save(&serde_json::to_value(base)?)?;
        let mcp_binding_ref = selection
            .mcp_binding
            .as_ref()
            .map(|binding| content.save(&serde_json::to_value(binding)?))
            .transpose()?;
        let policy_models = stage_policy_models(content, &selection.policy_models)?;
        Ok(Self {
            agent: selection.agent,
            child_dispatch_ref: selection
                .child_dispatch
                .as_ref()
                .map(|catalog| content.save(&serde_json::to_value(catalog)?))
                .transpose()?,
            credential_scope: selection.credential_scope,
            connection_identity: selection.connection_identity,
            provider_family: selection.provider_family,
            model: selection.model,
            configuration_generation: selection.configuration_generation,
            tool_schema_generation: selection.tool_schema_generation,
            policy: selection.policy,
            source: selection.source,
            tools_ref,
            base_tools_ref,
            mcp_binding_ref,
            extension_bindings_ref,
            policy_models,
        })
    }
    pub(super) fn load(self, content: &crate::content::ContentStore) -> Result<LaunchSelection> {
        let selection = self.load_selection(content)?;
        selection.validate()?;
        Ok(selection)
    }
    pub(super) fn load_child_intent(
        self,
        content: &crate::content::ContentStore,
    ) -> Result<LaunchSelection> {
        let selection = self.load_selection(content)?;
        selection.validate_structure()?;
        Ok(selection)
    }
    fn load_selection(self, content: &crate::content::ContentStore) -> Result<LaunchSelection> {
        let selection = LaunchSelection {
            agent: self.agent.clone(),
            child_dispatch: self
                .child_dispatch_ref
                .as_ref()
                .map(|reference| {
                    serde_json::from_value(content.load(&reference)?).map_err(RuntimeError::from)
                })
                .transpose()?,
            extension_bindings: serde_json::from_value(
                content.load(&self.extension_bindings_ref)?,
            )?,
            tools: serde_json::from_value(content.load(&self.tools_ref)?)?,
            mcp_binding: self
                .mcp_binding_ref
                .as_ref()
                .map(|reference| {
                    serde_json::from_value(content.load(reference)?).map_err(RuntimeError::from)
                })
                .transpose()?,
            policy_models: self.load_policy_models(content)?,
            credential_scope: self.credential_scope,
            connection_identity: self.connection_identity,
            provider_family: self.provider_family,
            model: self.model,
            configuration_generation: self.configuration_generation,
            tool_schema_generation: self.tool_schema_generation,
            policy: self.policy,
            source: self.source,
        };
        Ok(selection)
    }
    pub(super) fn load_policy_models(
        &self,
        content: &crate::content::ContentStore,
    ) -> Result<Vec<PolicyModelCapability>> {
        self.policy_models
            .iter()
            .map(|reference| {
                let model: PolicyModelCapability =
                    serde_json::from_value(content.load(&reference.body)?)?;
                if model.capability_id != reference.capability_id {
                    return Err(RuntimeError::Invalid(
                        "planning capability differs from its retained identity".into(),
                    ));
                }
                Ok(model)
            })
            .collect()
    }
}
pub(super) fn stage_policy_models(
    content: &crate::content::ContentStore,
    models: &[PolicyModelCapability],
) -> Result<Vec<PolicyModelReference>> {
    launches::validate_policy_models(models)?;
    models
        .iter()
        .map(|model| {
            Ok(PolicyModelReference {
                capability_id: model.capability_id.clone(),
                body: content.save(&serde_json::to_value(model)?)?,
            })
        })
        .collect()
}
pub struct LaunchRead {
    startable: bool,
    policy_preparable: bool,
    pause: Option<super::policy_control::PolicyPauseRead>,
    pub metadata: LaunchMetadata,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl LaunchRead {
    pub fn load_policy_target(&self) -> Result<super::policy_switch::PolicyTarget> {
        self.metadata.policy_target.load(&self.content)
    }
    pub fn load(self) -> Result<LaunchIntent> {
        Ok(LaunchIntent {
            policy_generation: self.metadata.policy_generation,
            policy_target: self.metadata.policy_target.load(&self.content)?,
            startable: self.startable,
            policy_preparable: self.policy_preparable,
            pause: self
                .pause
                .map(|pause| pause.load(&self.content))
                .transpose()?,
            run_id: self.metadata.run_id,
            revision: self.metadata.revision,
            selection: self.metadata.selection.load(&self.content)?,
            bound_epoch: self.metadata.bound_epoch,
            requires_rebind: self.metadata.requires_rebind,
            preparation_failure: self.metadata.preparation_failure,
            preparation_failure_detail: self.metadata.preparation_failure_detail,
        })
    }
    pub fn load_policy_models(self) -> Result<Vec<PolicyModelCapability>> {
        self.metadata.selection.load_policy_models(&self.content)
    }
}
pub struct LaunchSelectionPreparation {
    selection: LaunchSelection,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedLaunchSelection {
    pub(super) selection: LaunchSelectionMetadata,
    pub(super) epoch: u64,
    _publication: crate::content::ContentPublication,
}
impl LaunchSelectionPreparation {
    pub fn load(self) -> Result<PreparedLaunchSelection> {
        Ok(PreparedLaunchSelection {
            selection: LaunchSelectionMetadata::stage(&self.content, self.selection)?,
            epoch: self.epoch,
            _publication: self.publication,
        })
    }
}
pub struct LaunchChangePreparation {
    read: LaunchRead,
    change: LaunchChange,
    epoch: u64,
    child_selection: Option<LaunchSelectionMetadata>,
    child_mcp: Option<ChildMcpCapture>,
}
pub struct ChildLaunchPreparation {
    read: LaunchRead,
    child: LaunchSelection,
    selected: super::dispatch::ResolvedChildSelection,
}
pub struct PreparedChildLaunch {
    pub(super) selection: LaunchSelection,
    pub(super) parent_tools_ref: Value,
    pub(super) selected_profile: super::dispatch::ChildSelectedProfile,
    pub(super) configuration: Value,
    pub(super) frozen_reference: Value,
    _publication: crate::content::ContentPublication,
}
impl ChildLaunchPreparation {
    pub fn load(self) -> Result<PreparedChildLaunch> {
        let mut names: Vec<_> = self
            .child
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect();
        names.sort();
        if names != self.selected.profile.tools
            || self.child.connection_identity != self.selected.model.connection_identity()?
            || self.child.credential_scope != self.selected.model.credential_scope
            || self.child.model != self.selected.model.configuration.model
            || self.child.provider_family != self.selected.model.configuration.provider_family
            || self.child.configuration_generation
                != self.selected.model.configuration.configuration_generation
            || self.child.mcp_binding != self.selected.mcp_binding
            || self.child.extension_bindings != self.selected.extension_bindings
            || !self.child.policy_models.is_empty()
            || self.child.tool_schema_generation != self.selected.tool_schema_generation
            || self.read.metadata.selection.tool_schema_generation
                != self.selected.tool_schema_generation
            || self.read.metadata.selection.tools_ref != self.selected.parent_tools_ref
            || self
                .child
                .child_dispatch
                .as_ref()
                .map(|catalog| {
                    crate::content::ContentStore::reference(&serde_json::to_value(catalog)?)
                })
                .transpose()?
                .as_ref()
                != Some(&self.selected.catalog_ref)
        {
            return Err(RuntimeError::Conflict(
                "child launch differs from its frozen selection".into(),
            ));
        }
        Ok(PreparedChildLaunch {
            selection: self.child,
            selected_profile: self.selected.profile,
            configuration: serde_json::to_value(self.selected.model.configuration)?,
            frozen_reference: self.selected.frozen_reference,
            parent_tools_ref: self.selected.parent_tools_ref,
            _publication: self.read._publication,
        })
    }
}
enum LaunchChange {
    Mcp { binding: HostToolBinding, derivations: Vec<McpChildDerivationReceipt> },
    Extensions(Vec<ExtensionToolBinding>),
    Policy {
        baseline: PolicyIdentity,
        identity: PolicyIdentity,
        models: Vec<PolicyModelCapability>,
        target: super::policy_switch::PolicyTarget,
    },
}
pub struct PreparedLaunchChange {
    pub(super) expected: LaunchMetadata,
    pub(super) selection: LaunchSelectionMetadata,
    pub(super) policy_target: super::policy_switch::PolicyTargetMetadata,
    pub(super) epoch: u64,
    pub(super) kind: &'static str,
    pub(super) child_mcp: Option<ChildMcpCapture>,
    _publication: crate::content::ContentPublication,
}
/// A small metadata cut captured under Catalog ownership. Immutable bodies are loaded only
/// by LaunchChangePreparation::load; the transaction rechecks this cut before publication.
pub(super) struct ChildMcpCapture {
    execution: super::delegated::DelegatedExecution,
    relation: super::delegated::ChildRelation,
    operation: Option<Operation>,
}
impl ChildMcpCapture {
    pub(super) fn recheck(&self, db: &Connection, run: &Run) -> Result<()> {
        let execution = super::delegated::execution(db, &self.execution.execution_id)?;
        let relation = super::delegated::relation(db, &execution.child_operation_id)?;
        if execution != self.execution
            || relation != self.relation
            || execution.cancel_requested
            || execution.report.is_some()
            || execution.resources_released
            || execution
                .receipt
                .as_ref()
                .map(|receipt| receipt.run_id.as_str())
                != Some(&run.id)
            || relation.child_thread_id != run.thread_id
            || relation.child_branch_id != run.branch_id
            || run.cancel_requested
            || run.state.terminal()
        {
            return Err(RuntimeError::Conflict(
                "child MCP execution admission changed".into(),
            ));
        }
        if let Some(expected) = &self.operation {
            let actual: Operation = record(db, "operations", &expected.id)?;
            if actual.id != expected.id
                || actual.run_id != expected.run_id
                || actual.epoch != expected.epoch
                || actual.execution_owner != expected.execution_owner
                || actual.cancel_requested
            {
                return Err(RuntimeError::Conflict(
                    "original MCP dispatch owner changed".into(),
                ));
            }
        }
        Ok(())
    }
}

/// One source-owner cut, including each gateway and only that owner's direct tools/resources.
/// Public aliases, descriptions, generation and reference remain the original frozen values.
fn mcp_source_cut(
    original: &HostToolBinding,
    authority: &McpSourceAuthority,
    owner: &SourceResourceOwner,
) -> HostToolBinding {
    let mut cut = original.clone();
    cut.provenance.servers.retain(|_, server| {
        server.owner.source_authority.as_ref() == Some(authority)
            && &server.owner.resource_owner == owner
    });
    cut.resources.retain(|_, key| {
        cut.provenance
            .servers
            .values()
            .any(|s| &s.resource_key == key)
    });
    cut.tools.retain(|tool| {
        !matches!(
            original.routes.get(&tool.name),
            Some(crate::McpRoute::Direct | crate::McpRoute::DirectTask)
        ) || cut.resources.contains_key(&tool.name)
    });
    cut.routes
        .retain(|name, _| cut.tools.iter().any(|tool| &tool.name == name));
    cut
}

fn validate_child_mcp_derivation(
    binding: &HostToolBinding,
    original: &HostToolBinding,
    derivations: &[McpChildDerivationReceipt],
    captured: &ChildMcpCapture,
    launch: &LaunchMetadata,
    content: &crate::content::ContentStore,
) -> Result<()> {
    use super::collaboration::{ChildSource, ChildSourceRoot};
    use super::delegated::DelegatedTrigger;
    let changed = || {
        RuntimeError::Conflict(
            "child MCP execution binding differs from its exact frozen derivation".into(),
        )
    };
    original.validate()?;
    let execution = &captured.execution;
    let relation = &captured.relation;
    if execution.cancel_requested
        || execution.report.is_some()
        || execution.resources_released
        || execution.receipt.as_ref().map(|receipt| &receipt.run_id) != Some(&launch.run_id)
        || execution.child_operation_id != relation.operation_id
        || binding.tools != original.tools
        || binding.routes != original.routes
        || binding.provenance.servers.len() != original.provenance.servers.len()
        || binding.resources.len() != original.resources.len()
    {
        return Err(changed());
    }
    // Ordinary local derivation continues to use the original strict owner contract.
    if original
        .provenance
        .servers
        .values()
        .all(|server| server.owner.resource_owner.is_local())
    {
        return if derivations.is_empty() && binding.derives_from(original) {
            Ok(())
        } else {
            Err(changed())
        };
    }
    let Some(ChildSource::Ready {
        handoff,
        pin,
        selection: source,
        provenance_ref,
    }) = &execution.source
    else {
        return Err(changed());
    };
    if source.mode != crate::SourceMode::Materialized
        || launch.selection.source.as_ref() != Some(source)
    {
        return Err(changed());
    }
    // The actual child Source has one target-owned immutable derivation outcome. Combining
    // multiple origins for it would claim a receipt the native Source owner cannot produce.
    if derivations.len() != 1 {
        return Err(changed());
    }
    let mut covered = std::collections::BTreeSet::new();
    for receipt in derivations {
        let proof = &receipt.proof;
        proof.source.validate()?;
        proof.selection.validate()?;
        let original_authority = proof
            .selection
            .provenance
            .servers
            .values()
            .next()
            .and_then(|server| server.owner.source_authority.as_ref())
            .ok_or_else(changed)?;
        let owner = &proof.source.resource_owner;
        if owner.is_local()
            || proof.selection.provenance.servers.is_empty()
            || proof.execution_id != execution.execution_id
            || proof.child_run_id != launch.run_id
            || proof.child_thread_id != relation.child_thread_id
            || &proof.source != source
            || &proof.pin != pin
            || proof.materialization_operation_id.trim().is_empty()
            || !proof
                .materialization_receipt_hash
                .strip_prefix("sha256-")
                .is_some_and(|hash| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
            || proof.physical_root.host_id.is_empty()
            || proof.physical_root.root_id.is_empty()
            || proof.physical_root.canonical_root.is_empty()
            || owner.host_id() != Some(proof.physical_root.host_id.as_str())
            || proof.source_authority.coordinator_host_id.is_empty()
            || proof.source_authority.authority_id.is_empty()
            || proof.source_authority.resource_epoch.is_empty()
            || proof.source_authority == *original_authority
            || proof.source_authority.coordinator_host_id != original_authority.coordinator_host_id
            || proof.selection != mcp_source_cut(original, original_authority, owner)
            || receipt.provenance.servers.len() != proof.selection.provenance.servers.len()
        {
            return Err(changed());
        }
        match (&execution.trigger, &proof.origin) {
            (
                DelegatedTrigger::Dispatch,
                McpChildDerivationOrigin::Dispatch {
                    parent_source_authority,
                    binding,
                },
            ) => {
                let operation = captured.operation.as_ref().ok_or_else(changed)?;
                if execution.source_basis.is_some()
                    || handoff.as_ref() != Some(&proof.handoff)
                    || parent_source_authority != original_authority
                    || !binding.validate()
                    || binding.operation_id != relation.operation_id
                    || binding.operation_id != operation.id
                    || binding.parent_run_id != relation.parent_run_id
                    || binding.parent_run_id != operation.run_id
                    || Some(&binding.execution_owner) != operation.execution_owner.as_ref()
                    || binding.execution_epoch != operation.epoch
                    || operation.cancel_requested
                {
                    return Err(changed());
                }
            }
            (
                DelegatedTrigger::UserContinuation {
                    previous_run_id, ..
                }
                | DelegatedTrigger::MessageRequest {
                    previous_run_id, ..
                }
                | DelegatedTrigger::Followup {
                    previous_run_id, ..
                }
                | DelegatedTrigger::Calendar {
                    previous_run_id, ..
                }
                | DelegatedTrigger::ComputerEvent {
                    previous_run_id, ..
                },
                McpChildDerivationOrigin::Continuation {
                    previous_run_id: proved_previous,
                },
            ) => {
                let basis = execution.source_basis.as_ref().ok_or_else(changed)?;
                let same_provenance=match basis {
                    super::delegated::ChildSourceBasis::Refreshed {incoming,..} => {
                        let provenance:super::collaboration::ChildSourceProvenance=serde_json::from_value(content.load(provenance_ref)?)?;
                        proof.handoff.refresh.as_ref()==Some(incoming) && matches!(provenance,
                            super::collaboration::ChildSourceProvenance::RefreshedRoot {root,previous_root,incoming:observed,..}
                            if root==pin.root && previous_root==basis.root() && &observed==incoming)
                    },
                    _=>proof.handoff.refresh.is_none() && pin.root==basis.root()
                        && content.load(provenance_ref)?==content.load(basis.provenance_ref())?,
                };
                if previous_run_id != proved_previous
                    || previous_run_id == &proof.child_run_id
                    || handoff.is_some()
                    || !same_provenance
                    || proof.handoff.operation_id
                        != format!("child-source-handoff:{}", execution.execution_id)
                    || &proof.handoff.source != basis.source()
                    || proof
                        .handoff
                        .resource_authority
                        .as_ref()
                        .is_none_or(|authority| {
                            authority.authority_id != original_authority.authority_id
                                || authority.resource_epoch != original_authority.resource_epoch
                        })
                    || !matches!(&proof.handoff.root, ChildSourceRoot::Fixed { pin: handoff_pin }
                        if handoff_pin.pin_id == format!("child-pin:{}", execution.execution_id)
                            && handoff_pin.root == basis.root() && &handoff_pin.source == basis.source())
                    || source.resource_owner != basis.source().resource_owner
                    || source.workspace_id != basis.source().workspace_id
                    || source.execution_workspace_id != basis.source().execution_workspace_id
                {
                    return Err(changed());
                }
            }
            _ => return Err(changed()),
        }
        for (name, old) in &proof.selection.provenance.servers {
            let next = receipt.provenance.servers.get(name).ok_or_else(changed)?;
            if !covered.insert(name.clone())
                || next.owner.source_authority.as_ref() != Some(&proof.source_authority)
                || next.owner.resource_owner != old.owner.resource_owner
                || next.owner.configuration != old.owner.configuration
                || next.owner.execution_scope != old.owner.execution_scope
                || next.definition_version != old.definition_version
                || binding.provenance.servers.get(name) != Some(next)
            {
                return Err(changed());
            }
        }
    }
    for (name, old) in &original.provenance.servers {
        let next = binding.provenance.servers.get(name).ok_or_else(changed)?;
        if old.owner.resource_owner.is_local() {
            if next.owner != old.owner || next.definition_version != old.definition_version {
                return Err(changed());
            }
        } else if !covered.contains(name) {
            return Err(changed());
        }
    }
    // A resource alias must still select exactly its old server, even if two owners share a key.
    for (alias, old_key) in &original.resources {
        let next_key = binding.resources.get(alias).ok_or_else(changed)?;
        if !original
            .provenance
            .servers
            .iter()
            .filter(|(_, server)| &server.resource_key == old_key)
            .all(|(name, _)| {
                binding
                    .provenance
                    .servers
                    .get(name)
                    .is_some_and(|next| &next.resource_key == next_key)
            })
        {
            return Err(changed());
        }
    }
    Ok(())
}

/// Selecting a registered project is a new configuration source, rather than a
/// derivation of the dispatcher's project MCP. Its real execution Source must
/// already have been accepted; the Host admits definitions/trust from that source.
fn validate_project_mcp(
    binding: &HostToolBinding,
    selected: &super::dispatch::ChildProjectMcp,
    captured: &ChildMcpCapture,
    launch: &LaunchMetadata,
) -> Result<()> {
    let source = launch.selection.source.as_ref().ok_or_else(||
        RuntimeError::Conflict("project MCP requires its admitted execution source".into()))?;
    if captured.execution.source.as_ref().and_then(|source| source.selection()) != Some(source)
        || source.resource_owner != selected.project.resource_owner
        || captured.relation.project_id.as_deref() != Some(selected.project.id.as_str())
        || selected.tools.as_ref().is_some_and(|names| binding.tools.iter().any(|tool| !names.contains(&tool.name)))
        || binding.provenance.servers.values().any(|server| match server.owner.execution_scope {
            launches::McpExecutionScope::Workspace => server.owner.resource_owner != source.resource_owner,
            launches::McpExecutionScope::Global => !server.owner.resource_owner.is_local()
                || server.owner.configuration.config_cwd != server.owner.configuration.agent_dir,
        })
    {
        return Err(RuntimeError::Conflict("project MCP differs from its selected project, source or exact tools".into()));
    }
    Ok(())
}

impl LaunchChangePreparation {
    pub fn load(self) -> Result<PreparedLaunchChange> {
        let LaunchRead {
            metadata,
            content,
            _publication,
            ..
        } = self.read;
        let mut selection = metadata.selection.clone();
        let mut policy_target = metadata.policy_target.clone();
        let kind = match self.change {
            LaunchChange::Mcp { binding, derivations } => {
                binding.validate()?;
                let reference = content.save(&serde_json::to_value(&binding)?)?;
                let delegated = if let Some(child) = &self.child_selection {
                    let captured = self.child_mcp.as_ref().ok_or_else(|| RuntimeError::Conflict(
                        "child MCP execution admission is missing".into()))?;
                    let profile: super::dispatch::ChildSelectedProfile = serde_json::from_value(
                        content.load(&captured.relation.selected_profile_ref)?)?;
                    if let Some(project) = &profile.project_mcp {
                        if !derivations.is_empty() {
                            return Err(RuntimeError::Invalid("project MCP uses its own source admission, not a parent derivation".into()));
                        }
                        validate_project_mcp(&binding, project, captured, &metadata)?;
                        // Only replace the initial dispatcher cut, before binding/model use.
                        // Later prepares/restarts must restore the exact committed generation.
                        selection.mcp_binding_ref == child.mcp_binding_ref
                    } else {
                        let original_ref = child.mcp_binding_ref.as_ref().ok_or_else(|| {
                            RuntimeError::Invalid("child has no delegated MCP capability".into())
                        })?;
                        let original_selection = selection.mcp_binding_ref.as_ref() == Some(original_ref);
                        let receipt_replay = !derivations.is_empty()
                            && selection.mcp_binding_ref.as_ref() == Some(&reference);
                        if original_selection || receipt_replay {
                            let original: HostToolBinding =
                                serde_json::from_value(content.load(original_ref)?)?;
                            validate_child_mcp_derivation(
                                &binding, &original, &derivations, captured,
                                &metadata, &content,
                            )?;
                            original_selection
                        } else {
                            false
                        }
                    }
                } else {
                    false
                };
                if !delegated && !derivations.is_empty()
                    && (self.child_selection.is_none() || selection.mcp_binding_ref.as_ref() != Some(&reference))
                {
                    return Err(RuntimeError::Conflict(
                        "MCP derivation receipts require the original delegated selection".into(),
                    ));
                }
                if selection
                    .mcp_binding_ref
                    .as_ref()
                    .is_some_and(|previous| previous != &reference)
                    && !delegated
                {
                    return Err(RuntimeError::Conflict(
                        "MCP owner generation changed".into(),
                    ));
                }
                let mut tools: Vec<ToolSchema> =
                    serde_json::from_value(content.load(&selection.base_tools_ref)?)?;
                let extensions: Vec<ExtensionToolBinding> =
                    serde_json::from_value(content.load(&selection.extension_bindings_ref)?)?;
                tools.extend(extensions.into_iter().map(|b| b.tool));
                tools.extend(binding.tools);
                tools.sort_by(|left, right| left.name.cmp(&right.name));
                let mut names = std::collections::BTreeSet::new();
                if tools.iter().any(|tool| !names.insert(&tool.name)) {
                    return Err(RuntimeError::Invalid(
                        "launch tool identities must be unique".into(),
                    ));
                }
                selection.tools_ref = content.save(&serde_json::to_value(tools)?)?;
                selection.mcp_binding_ref = Some(reference);
                "run.mcp_prepared"
            }
            LaunchChange::Extensions(bindings) => {
                if let Some(child) = &self.child_selection {
                    let original: Vec<ExtensionToolBinding> =
                        serde_json::from_value(content.load(&child.extension_bindings_ref)?)?;
                    if bindings != original {
                        return Err(RuntimeError::Conflict(
                            "child extension selection differs from its frozen delegation".into(),
                        ));
                    }
                }
                let mut full = metadata.selection.clone().load(&content)?;
                if !full.extension_bindings.is_empty() && full.extension_bindings != bindings {
                    return Err(RuntimeError::Conflict(
                        "extension service generation changed".into(),
                    ));
                }
                full.tools = serde_json::from_value(content.load(&selection.base_tools_ref)?)?;
                if let Some(mcp) = &full.mcp_binding {
                    full.tools.extend(mcp.tools.iter().cloned());
                }
                full.tools.extend(bindings.iter().map(|b| b.tool.clone()));
                full.tools.sort_by(|a, b| a.name.cmp(&b.name));
                full.extension_bindings = bindings;
                selection = LaunchSelectionMetadata::stage(&content, full)?;
                "run.extensions_prepared"
            }
            LaunchChange::Policy {
                baseline,
                identity,
                models,
                target,
            } => {
                // A child resolves its own policy after acceptance. This changes neither the
                // original delegation nor the independently frozen tool/source selection.
                policy_target =
                    super::policy_switch::PolicyTargetMetadata::stage(&content, target)?;
                if identity.name.is_empty() || identity.version.is_empty() {
                    return Err(RuntimeError::Invalid("policy identity is empty".into()));
                }
                selection.policy_models = stage_policy_models(&content, &models)?;
                selection.policy = identity;
                if metadata.selection.policy != baseline
                    && (metadata.selection.policy != selection.policy
                        || metadata.selection.policy_models != selection.policy_models)
                {
                    return Err(RuntimeError::Conflict(
                        "policy preparation differs from its admitted baseline".into(),
                    ));
                }
                "run.policy_prepared"
            }
        };
        Ok(PreparedLaunchChange {
            expected: metadata,
            selection,
            policy_target,
            epoch: self.epoch,
            kind,
            child_mcp: self.child_mcp,
            _publication,
        })
    }
}
impl Catalog {
    pub fn launch_metadata(&self, run_id: &str) -> Result<Option<LaunchMetadata>> {
        let mut metadata: Option<LaunchMetadata> =
            optional_record(&self.db, "run_launches", run_id)?;
        if let Some(metadata) = &mut metadata {
            metadata.requires_rebind = metadata.bound_epoch != Some(self.epoch);
        }
        Ok(metadata)
    }
    pub(super) fn launch_read(&self, metadata: LaunchMetadata) -> Result<LaunchRead> {
        Ok(LaunchRead {
            startable: self.run_startable(&metadata.run_id)?,
            policy_preparable: super::launches::policy_preparable(
                &self.db,
                &self.run(&metadata.run_id)?,
                &metadata,
            )?,
            pause: self.capture_policy_pause(&metadata.run_id)?,
            metadata,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn capture_launch(&self, run_id: &str) -> Result<Option<LaunchRead>> {
        self.launch_metadata(run_id)?
            .map(|metadata| self.launch_read(metadata))
            .transpose()
    }
    pub fn capture_pending_launches(&self) -> Result<Vec<LaunchRead>> {
        let mut query = self.db.prepare("SELECT l.body FROM run_launches l JOIN runs r ON r.id=l.id WHERE json_extract(r.body,'$.state') NOT IN ('completed','failed','cancelled') ORDER BY l.rowid")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let mut metadata: LaunchMetadata = serde_json::from_str(&row?)?;
            metadata.requires_rebind = metadata.bound_epoch != Some(self.epoch);
            self.launch_read(metadata)
        })
        .collect()
    }
    pub fn prepare_launch_selection(
        &self,
        selection: LaunchSelection,
    ) -> LaunchSelectionPreparation {
        LaunchSelectionPreparation {
            selection,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    pub fn prepare_mcp_change(
        &self,
        run_id: &str,
        binding: HostToolBinding,
    ) -> Result<LaunchChangePreparation> {
        self.prepare_mcp_change_with_derivations(run_id, binding, Vec::new())
    }
    pub fn prepare_mcp_change_with_derivations(
        &self,
        run_id: &str,
        binding: HostToolBinding,
        derivations: Vec<McpChildDerivationReceipt>,
    ) -> Result<LaunchChangePreparation> {
        let child = self.require_child_launch(run_id)?;
        let child_mcp = child.as_ref().map(|child| {
            let execution = self.delegated_execution(&child.execution_id)?;
            Ok::<_, RuntimeError>(ChildMcpCapture {
                relation: super::delegated::relation(&self.db, &child.operation_id)?,
                operation: matches!(execution.trigger, super::delegated::DelegatedTrigger::Dispatch)
                    .then(|| self.operation(&child.operation_id)).transpose()?,
                execution,
            })
        }).transpose()?;
        Ok(LaunchChangePreparation {
            child_selection: child.map(|child| child.launch),
            child_mcp,
            read: self
                .capture_launch(run_id)?
                .ok_or_else(|| RuntimeError::NotFound(run_id.into()))?,
            change: LaunchChange::Mcp { binding, derivations },
            epoch: self.epoch,
        })
    }
    pub fn prepare_extensions_change(
        &self,
        run_id: &str,
        bindings: Vec<ExtensionToolBinding>,
    ) -> Result<LaunchChangePreparation> {
        Ok(LaunchChangePreparation {
            child_selection: self.require_child_launch(run_id)?.map(|child| child.launch),
            child_mcp: None,
            read: self
                .capture_launch(run_id)?
                .ok_or_else(|| RuntimeError::NotFound(run_id.into()))?,
            change: LaunchChange::Extensions(bindings),
            epoch: self.epoch,
        })
    }
    pub fn prepare_policy_change(
        &self,
        run_id: &str,
        baseline: PolicyIdentity,
        identity: PolicyIdentity,
        models: Vec<PolicyModelCapability>,
        target: super::policy_switch::PolicyTarget,
    ) -> Result<LaunchChangePreparation> {
        Ok(LaunchChangePreparation {
            child_selection: self.require_child_launch(run_id)?.map(|child| child.launch),
            child_mcp: None,
            read: self
                .capture_launch(run_id)?
                .ok_or_else(|| RuntimeError::NotFound(run_id.into()))?,
            change: LaunchChange::Policy {
                baseline,
                identity,
                models,
                target,
            },
            epoch: self.epoch,
        })
    }
    pub fn prepare_child_launch(
        &self,
        run_id: &str,
        child: LaunchSelection,
        selected: super::dispatch::ResolvedChildSelection,
    ) -> Result<ChildLaunchPreparation> {
        Ok(ChildLaunchPreparation {
            read: self
                .capture_launch(run_id)?
                .ok_or_else(|| RuntimeError::NotFound(run_id.into()))?,
            child,
            selected,
        })
    }
}
