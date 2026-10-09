//! Launch ownership is small metadata; executable descriptions are immutable content.
//! Capture while holding Catalog, then validate, hash, write and hydrate on the caller's worker.
use super::*;
use crate::execution::{policy_model::PolicyModelCapability, PolicyIdentity, ToolSchema};
use launches::{HostToolBinding, LaunchIntent, LaunchSelection, SourceSelection};

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PolicyModelReference {
    pub capability_id: String,
    pub body: Value,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LaunchSelectionMetadata {
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
    pub policy_models: Vec<PolicyModelReference>,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LaunchMetadata {
    pub preparation_failure: Option<String>,
    pub run_id: String,
    pub revision: u64,
    pub selection: LaunchSelectionMetadata,
    pub bound_epoch: Option<u64>,
    pub requires_rebind: bool,
}
impl LaunchSelectionMetadata {
    pub(super) fn stage(
        content: &crate::content::ContentStore,
        selection: LaunchSelection,
    ) -> Result<Self> {
        selection.validate()?;
        let tools_ref = content.save(&serde_json::to_value(&selection.tools)?)?;
        let mcp_names = selection
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
            policy_models,
        })
    }
    pub(super) fn load(self, content: &crate::content::ContentStore) -> Result<LaunchSelection> {
        let selection = LaunchSelection {
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
    pub metadata: LaunchMetadata,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl LaunchRead {
    pub fn load(self) -> Result<LaunchIntent> {
        Ok(LaunchIntent {
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
}
pub struct ChildLaunchPreparation {
    read: LaunchRead,
    child: LaunchSelection,
}
pub struct PreparedChildLaunch {
    pub(super) selection: LaunchSelection,
    pub(super) parent_tools_ref: Value,
    _publication: crate::content::ContentPublication,
}
impl ChildLaunchPreparation {
    pub fn load(mut self) -> Result<PreparedChildLaunch> {
        let tools: Vec<ToolSchema> = serde_json::from_value(
            self.read
                .content
                .load(&self.read.metadata.selection.tools_ref)?,
        )?;
        if self.child.tools.iter().any(|tool| !tools.contains(tool)) {
            return Err(RuntimeError::Conflict("child exceeds parent tools".into()));
        }
        self.child.mcp_binding = None;
        self.child.policy_models.clear();
        Ok(PreparedChildLaunch {
            selection: self.child,
            parent_tools_ref: self.read.metadata.selection.tools_ref,
            _publication: self.read._publication,
        })
    }
}
enum LaunchChange {
    Mcp(HostToolBinding),
    Policy {
        baseline: PolicyIdentity,
        identity: PolicyIdentity,
        models: Vec<PolicyModelCapability>,
    },
}
pub struct PreparedLaunchChange {
    pub(super) expected: LaunchMetadata,
    pub(super) selection: LaunchSelectionMetadata,
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
        } = self.read;
        let mut selection = metadata.selection.clone();
        let kind = match self.change {
            LaunchChange::Mcp(binding) => {
                binding.validate()?;
                let reference = content.save(&serde_json::to_value(&binding)?)?;
                if selection
                    .mcp_binding_ref
                    .as_ref()
                    .is_some_and(|previous| previous != &reference)
                {
                    return Err(RuntimeError::Conflict(
                        "MCP owner generation changed".into(),
                    ));
                }
                let mut tools: Vec<ToolSchema> =
                    serde_json::from_value(content.load(&selection.base_tools_ref)?)?;
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
            LaunchChange::Policy {
                baseline,
                identity,
                models,
            } => {
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
    pub(super) fn launch_read(&self, metadata: LaunchMetadata) -> LaunchRead {
        LaunchRead {
            metadata,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
    pub fn capture_launch(&self, run_id: &str) -> Result<Option<LaunchRead>> {
        Ok(self
            .launch_metadata(run_id)?
            .map(|metadata| self.launch_read(metadata)))
    }
    pub fn capture_pending_launches(&self) -> Result<Vec<LaunchRead>> {
        let mut query = self.db.prepare("SELECT l.body FROM run_launches l JOIN runs r ON r.id=l.id WHERE json_extract(r.body,'$.state') NOT IN ('completed','failed','cancelled') ORDER BY l.rowid")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let mut metadata: LaunchMetadata = serde_json::from_str(&row?)?;
            metadata.requires_rebind = metadata.bound_epoch != Some(self.epoch);
            Ok(self.launch_read(metadata))
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
            read: self
                .capture_launch(run_id)?
                .ok_or_else(|| RuntimeError::NotFound(run_id.into()))?,
            change: LaunchChange::Mcp(binding),
            epoch: self.epoch,
        })
    }
    pub fn prepare_policy_change(
        &self,
        run_id: &str,
        baseline: PolicyIdentity,
        identity: PolicyIdentity,
        models: Vec<PolicyModelCapability>,
    ) -> Result<LaunchChangePreparation> {
        Ok(LaunchChangePreparation {
            read: self
                .capture_launch(run_id)?
                .ok_or_else(|| RuntimeError::NotFound(run_id.into()))?,
            change: LaunchChange::Policy {
                baseline,
                identity,
                models,
            },
            epoch: self.epoch,
        })
    }
    pub fn prepare_child_launch(
        &self,
        run_id: &str,
        child: LaunchSelection,
    ) -> Result<ChildLaunchPreparation> {
        Ok(ChildLaunchPreparation {
            read: self
                .capture_launch(run_id)?
                .ok_or_else(|| RuntimeError::NotFound(run_id.into()))?,
            child,
        })
    }
}
