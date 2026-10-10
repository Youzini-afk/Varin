//! Launch ownership is small metadata; executable descriptions are immutable content.
//! Capture while holding Catalog, then validate, hash, write and hydrate on the caller's worker.
use super::*;
use crate::execution::{policy_model::PolicyModelCapability, PolicyIdentity, ToolSchema};
use launches::{
    ExtensionToolBinding, HostToolBinding, LaunchIntent, LaunchSelection, SourceSelection,
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
    pub policy_target: super::policy_switch::PolicyTarget,
    pub preparation_failure: Option<String>,
    pub run_id: String,
    pub revision: u64,
    pub selection: LaunchSelectionMetadata,
    pub bound_epoch: Option<u64>,
    pub requires_rebind: bool,
}
impl LaunchSelectionMetadata {
    pub(super) fn rebase_policy_models(&mut self, content: &crate::content::ContentStore) -> Result<()> {
        let mut models=self.load_policy_models(content)?;
        for model in &mut models {
            if model.status==crate::execution::PolicyModelStatus::Available {
                let identity=model.configuration_identity.as_deref().ok_or_else(||RuntimeError::Invalid("planning configuration identity is missing".into()))?;
                model.binding_id=Some(format!("policy:0:{}:{identity}",model.capability_id));
            }
        }
        self.policy_models=stage_policy_models(content,&models)?;
        Ok(())
    }
    pub(super) fn stage(
        content: &crate::content::ContentStore,
        selection: LaunchSelection,
    ) -> Result<Self> {
        selection.validate()?;
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
            child_dispatch_ref: selection.child_dispatch.as_ref().map(|catalog| content.save(&serde_json::to_value(catalog)?)).transpose()?,
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
        let selection = LaunchSelection {
            child_dispatch: self.child_dispatch_ref.as_ref().map(|reference| serde_json::from_value(content.load(&reference)?).map_err(RuntimeError::from)).transpose()?,
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
        selection.validate()?;
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
    pub fn load(self) -> Result<LaunchIntent> {
        Ok(LaunchIntent {
            policy_generation: self.metadata.policy_generation,
            policy_target: self.metadata.policy_target,
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
        let mut names: Vec<_> = self.child.tools.iter().map(|tool| tool.name.clone()).collect();
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
            return Err(RuntimeError::Conflict("child launch differs from its frozen selection".into()));
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
    Mcp(HostToolBinding),
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
    pub(super) policy_target: super::policy_switch::PolicyTarget,
    pub(super) epoch: u64,
    pub(super) kind: &'static str,
    _publication: crate::content::ContentPublication,
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
            LaunchChange::Mcp(binding) => {
                binding.validate()?;
                let reference = content.save(&serde_json::to_value(&binding)?)?;
                let delegated = if let Some(child) = &self.child_selection {
                    let original_ref = child.mcp_binding_ref.as_ref().ok_or_else(|| {
                        RuntimeError::Invalid("child has no delegated MCP capability".into())
                    })?;
                    if selection.mcp_binding_ref.as_ref() == Some(original_ref) {
                        let original: HostToolBinding =
                            serde_json::from_value(content.load(original_ref)?)?;
                        if !binding.derives_from(&original) {
                            return Err(RuntimeError::Conflict(
                                "child MCP execution binding differs from its frozen delegation"
                                    .into(),
                            ));
                        }
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
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
                target.validate()?;
                policy_target = target;
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
        Ok(LaunchChangePreparation {
            child_selection: self.require_child_launch(run_id)?.map(|child| child.launch),
            read: self
                .capture_launch(run_id)?
                .ok_or_else(|| RuntimeError::NotFound(run_id.into()))?,
            change: LaunchChange::Mcp(binding),
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
