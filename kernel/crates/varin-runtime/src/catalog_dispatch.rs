//! Frozen selections from the existing Host agent-profile owner. This module owns no
//! profile registry: Catalog retains immutable selection bodies and the original call.
use super::*;
use crate::execution::{RequestBinding, ToolSchema};
use crate::providers::auth::CredentialScope;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChildWorkMode {
    ReadOnly,
    /// Investigate the admitted physical source, preparing a private view only for fixed sources.
    Shared,
    IsolatedWrite,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChildSourceRequirement {
    None,
    Source,
    Physical,
    Live,
}
impl From<crate::execution::ToolSourceRequirement> for ChildSourceRequirement {
    fn from(source: crate::execution::ToolSourceRequirement) -> Self {
        match source {
            crate::execution::ToolSourceRequirement::Source => Self::Source,
            crate::execution::ToolSourceRequirement::Physical => Self::Physical,
            crate::execution::ToolSourceRequirement::Live => Self::Live,
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChildPresetDefault {
    Worker,
    Verifier,
    Retrieval,
    ResearchPeer,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChildCapabilityDescriptor {
    pub name: String,
    pub version: String,
    pub source_requirement: ChildSourceRequirement,
    #[serde(default)]
    pub process: bool,
    pub default_presets: Vec<ChildPresetDefault>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchInput {
    #[serde(default, skip_serializing_if="Vec::is_empty")]
    pub attachments: Vec<super::attachments::AttachmentSelection>,
    #[serde(default, skip_serializing_if="Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if="Vec::is_empty")]
    pub background: Vec<super::background::BackgroundReference>,
    pub task: String,
    /// Stable configured channel-model identity from the disclosed catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Omission is undecided; default is an explicit choice of the configuration default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_types: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inherit_context: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_agent: Option<String>,
    /// Directory within the selected Agent's source; no change to its owning workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// Tool disclosure focus for this child. Omission inherits the admitted caller's focus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_focus: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_mode: Option<ChildWorkMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}
impl DispatchInput {
    /// Internal retrieval is admitted from its real tool call; it never fabricates a dispatch origin.
    pub fn from_tool_call(name: &str, arguments: &Value) -> Result<Self> {
        if name == "dispatch" {
            let input: Self = serde_json::from_value(arguments.clone())?;
            if input.preset.as_deref() == Some("code_retrieval") {
                return Err(RuntimeError::Invalid("The internal retrieval profile is available through code_retrieval".into()));
            }
            input.validate()?;
            return Ok(input);
        }
        if name != "code_retrieval" { return Err(RuntimeError::Invalid("Not a delegated Agent invocation".into())); }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Query { question: String, paths: Option<Vec<String>> }
        let query: Query = serde_json::from_value(arguments.clone())?;
        if query.question.trim().is_empty() || query.question.contains('\0')
            || query.paths.as_ref().is_some_and(|paths| paths.is_empty() || paths.iter().any(|path|path.is_empty() || path.starts_with('/') || path.contains('\0') || path.contains('\\') || path.contains(':') || path.split('/').any(|p|matches!(p,".."|".") || p.is_empty()))) {
            return Err(RuntimeError::Invalid("Retrieval requires a question and optional normalized relative paths".into()));
        }
        let mut task = query.question;
        if let Some(paths) = query.paths {
            task.push_str("\n\nSearch scope (relative to the admitted source): ");
            task.push_str(&serde_json::to_string(&paths)?);
        }
        Ok(Self { attachments: Vec::new(), model: None, thinking: None, input_types: Vec::new(), project_id:None, background:Vec::new(), task, inherit_context: false, source_agent: None, source_path: None, name: None, preset: Some("code_retrieval".into()), work_focus: None, work_mode: Some(ChildWorkMode::Shared), tools: None })
    }

    pub fn validate(&self) -> Result<()> {
        for attachment in &self.attachments { attachment.validate()?; }
        if self.work_focus.as_deref().is_some_and(|focus| !launches::WORK_FOCUS_IDS.contains(&focus)) {
            return Err(RuntimeError::Invalid("workFocus must be general, code, research or office".into()));
        }
        if self.preset.is_some() && (self.model.is_some() || self.thinking.is_some()) {
            return Err(RuntimeError::Invalid("A preset retains its own model and thinking configuration; omit preset for free model selection".into()));
        }
        if self.model.as_deref().is_some_and(|id| id.trim().is_empty())
            || self.thinking.as_deref().is_some_and(|v| !["default", "off", "on", "budget", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&v))
            || self.input_types.iter().any(|v| !["text", "image"].contains(&v.as_str())) {
            return Err(RuntimeError::Invalid("Invalid delegated model, thinking or input requirement".into()));
        }
        if self.task.trim().is_empty() || self.name.as_deref().is_some_and(|name| name.trim().is_empty())
            || self.source_agent.as_deref().is_some_and(|source|source.trim().is_empty())
            || self.preset.as_ref().is_some_and(|id| id.trim().is_empty())
        {
            return Err(RuntimeError::Invalid(
                "dispatch requires a task and a valid selected preset".into(),
            ));
        }
        if self.project_id.as_deref().is_some_and(|id|id.trim().is_empty()) || (self.project_id.is_some() && self.source_agent.is_some()) {
            return Err(RuntimeError::Invalid("Choose projectId or sourceAgent as the source, not both".into()));
        }
        if let Some(tools) = &self.tools {
            validate_names(tools)?;
        }
        if self.source_path.as_deref().is_some_and(|path| path.is_empty() || path.contains('\0')) {
            return Err(RuntimeError::Invalid("sourcePath must be a nonempty directory path on the source Host".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildModelBinding {
    pub configuration: ModelSessionConfiguration,
    pub credential_scope: Option<CredentialScope>,
}
impl ChildModelBinding {
    pub fn connection_identity(&self) -> Result<String> {
        match &self.credential_scope {
            Some(scope) => {
                crate::model_session::connection_identity_with_scope(&self.configuration, scope)
            }
            None if self.configuration.allow_anonymous
                || self.configuration.credential_environment.is_some() =>
            {
                crate::model_session::connection_identity(&self.configuration)
            }
            None => {
                return Err(RuntimeError::Invalid(
                    "child model has no admitted credential owner".into(),
                ));
            }
        }
        .map_err(|error| RuntimeError::Invalid(error.to_string()))
    }
    pub fn matches(&self, binding: &RequestBinding) -> Result<bool> {
        Ok(self.connection_identity()? == binding.connection_identity
            && self.configuration.model == binding.model
            && self.configuration.provider_family == binding.provider_family
            && self.configuration.configuration_generation == binding.configuration_generation)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChildCapabilityFailure {
    pub code: String,
    pub capabilities: Vec<String>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChildModelSource {
    Inherit,
    Selected,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChildPresetToolsSource {
    Default,
    Explicit,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildPreset {
    /// Empty means this role is available in every child work focus.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_focus: Vec<String>,
    /// A configured independent harness. Its own model/tools are not Varin model bindings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<ExternalChildBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub tools: Vec<String>,
    pub tools_source: ChildPresetToolsSource,
    /// Retired preset-level placement. Each dispatch selects its own work mode; this value is
    /// kept only so retained frozen catalogs keep their exact bytes, and is never consulted.
    #[serde(default, rename = "work_mode", skip_serializing_if = "Option::is_none")]
    pub retired_work_mode: Option<ChildWorkMode>,
    pub model_source: ChildModelSource,
    pub inherit_base: Option<ChildModelBinding>,
    /// Absence means the configuration owner explicitly selected parent inheritance.
    /// An unavailable configured model is represented by `unavailable`, never by absence.
    pub model: Option<ChildModelBinding>,
    pub unavailable: Option<ChildCapabilityFailure>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExternalChildBinding {
    pub configuration_id: String,
    pub harness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub launch: ExternalLaunch,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExternalLaunch { pub command: String, pub args: Vec<String> }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildDispatchCatalog {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub model_selection_preparation: bool,
    #[serde(default, skip_serializing_if="Vec::is_empty")]
    pub projects: Vec<ChildProjectSource>,
    pub identity: String,
    pub native_capabilities: Vec<ChildCapabilityDescriptor>,
    pub normal_unavailable: Option<ChildCapabilityFailure>,
    pub presets: Vec<ChildPreset>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildProjectSource { pub id:String, pub name:String, pub path:String, pub resource_owner:launches::SourceResourceOwner }
impl ChildDispatchCatalog {
    pub fn validate(&self) -> Result<()> {
        validate_names(&self.projects.iter().map(|project|project.id.clone()).collect::<Vec<_>>())?;
        if self.projects.iter().any(|project|project.path.trim().is_empty()||project.path.contains('\0')) {
            return Err(RuntimeError::Invalid("Registered project source is malformed".into()));
        }
        if self.identity.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "child configuration snapshot has no identity".into(),
            ));
        }
        validate_names(
            &self
                .native_capabilities
                .iter()
                .map(|capability| capability.name.clone())
                .collect::<Vec<_>>(),
        )?;
        if self
            .native_capabilities
            .iter()
            .any(|capability| capability.version.is_empty())
        {
            return Err(RuntimeError::Invalid(
                "native capability descriptors require their original version".into(),
            ));
        }
        let mut names = std::collections::BTreeSet::new();
        for preset in &self.presets {
            if preset.work_focus.iter().any(|focus| !launches::WORK_FOCUS_IDS.contains(&focus.as_str())) {
                return Err(RuntimeError::Invalid("child preset has an unknown work focus".into()));
            }
            if preset.id.trim().is_empty()
                || preset.name.trim().is_empty()
                || !names.insert(&preset.id)
            {
                return Err(RuntimeError::Invalid(
                    "child preset identities must be nonempty and unique".into(),
                ));
            }
            validate_names(&preset.tools)?;
            if let Some(binding) = &preset.external {
                if binding.configuration_id.trim().is_empty() || !matches!(binding.harness.as_str(), "codex" | "claude" | "pi" | "acp") || !preset.tools.is_empty() || preset.model.is_some() || preset.inherit_base.is_some() {
                    return Err(RuntimeError::Invalid("external child binding has native model/tool configuration".into()));
                }
                continue;
            }
            if preset.unavailable.is_none() {
                if let Some(model) = &preset.model {
                    model.connection_identity()?;
                }
                if let Some(model) = &preset.inherit_base {
                    model.connection_identity()?;
                }
            }
            if preset.unavailable.is_none()
                && match preset.model_source {
                    ChildModelSource::Selected => {
                        preset.model.is_none() || preset.inherit_base.is_some()
                    }
                    ChildModelSource::Inherit => {
                        preset.model.is_some() != preset.inherit_base.is_some()
                    }
                }
            {
                return Err(RuntimeError::Invalid(
                    "child model selection lacks its explicit inheritance basis".into(),
                ));
            }
            if preset
                .unavailable
                .as_ref()
                .is_some_and(|failure| failure.code.trim().is_empty())
            {
                return Err(RuntimeError::Invalid(
                    "unavailable child preset requires an explicit reason".into(),
                ));
            }
        }
        Ok(())
    }
}
fn validate_names(names: &[String]) -> Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    if names
        .iter()
        .any(|name| name.trim().is_empty() || !seen.insert(name))
    {
        return Err(RuntimeError::Invalid(
            "child capability identities must be nonempty and unique".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildProjectMcp {
    pub project: ChildProjectSource,
    /// An explicit tool selection stays exact when the target scope is discovered.
    pub tools: Option<Vec<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildSelectedProfile {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub model_selection_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_mcp: Option<ChildProjectMcp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub preset_id: Option<String>,
    pub catalog_identity: Option<String>,
    pub work_mode: ChildWorkMode,
    pub tools: Vec<String>,
    pub instructions: String,
}

/// A body reference is copied into the actual ModelStep or policy graph. The catalog itself
/// is another shared content reference; recursive dispatch never nests profile catalogs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenChildDispatch {
    /// Frozen with the caller's request, including when it delegates across projects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_focus: Option<String>,
    pub source: Option<super::launches::SourceSelection>,
    /// Optional child directory. The same frozen composition also serves non-delegating MCP/extension calls.
    pub catalog_ref: Option<Value>,
    pub parent_model: ChildModelBinding,
    pub allowed_delegation: Vec<ToolSchema>,
    pub tool_schema_generation: u64,
    pub tools_ref: Value,
    pub mcp_binding_ref: Option<Value>,
    pub extension_bindings_ref: Value,
}

pub struct ChildDispatchPreparation {
    selection: super::launch_content::LaunchSelectionMetadata,
    model: ChildModelBinding,
    allowed_delegation: Vec<ToolSchema>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChildDispatch {
    pub reference: Option<Value>,
    selection: super::launch_content::LaunchSelectionMetadata,
    _publication: crate::content::ContentPublication,
}

pub struct ChildDispatchRead {
    pub(crate) reference: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct ChildDispatchSelection {
    pub(crate) history: Option<crate::execution::ConversationHistory>,
    pub reference: Value,
    pub frozen: FrozenChildDispatch,
    pub catalog: ChildDispatchCatalog,
    pub mcp_binding: Option<super::launches::HostToolBinding>,
    pub extension_bindings: Vec<super::launches::ExtensionToolBinding>,
    _publication: crate::content::ContentPublication,
}
#[derive(Debug)]
pub struct ResolvedChildSelection {
    pub agent: Option<launches::AgentSelection>,
    pub process: bool,
    pub frozen_reference: Value,
    pub catalog_ref: Value,
    pub profile: ChildSelectedProfile,
    pub model: ChildModelBinding,
    pub tool_schema_generation: u64,
    pub parent_tools_ref: Value,
    pub mcp_binding: Option<super::launches::HostToolBinding>,
    pub extension_bindings: Vec<super::launches::ExtensionToolBinding>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildSourceDelegation {
    #[serde(default, skip_serializing_if="Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")]
    pub agent_source: Option<AgentSourceSelection>,
    pub work_mode: ChildWorkMode,
    pub process: bool,
    pub configured_preset: bool,
    pub selection_ref: Value,
}
impl ResolvedChildSelection {
    pub fn source_delegation(&self) -> ChildSourceDelegation {
        ChildSourceDelegation {
            source_path: None,
        agent_source: None,
            work_mode: self.profile.work_mode,
            process: self.process,
            configured_preset: self.profile.preset_id.is_some(),
            selection_ref: self.frozen_reference.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentSourceSelection {
    pub run_id: String,
    pub source: launches::SourceSelection,
}
pub(super) fn agent_file_source(db: &Connection, run: &Run) -> Result<launches::SourceSelection> {
    let selected: super::launch_content::LaunchMetadata = record(db,"run_launches",&run.id)?;
    let mut source = selected.selection.source.ok_or_else(|| RuntimeError::Invalid("selected Agent has no file source".into()))?;
    if run.state.terminal() {
        let body: Option<String> = db.query_row("SELECT body FROM delegated_executions WHERE run_id=?1", [&run.id], |r| r.get(0)).optional()?;
        if let Some(body) = body {
            let execution: super::delegated::DelegatedExecution = serde_json::from_str(&body)?;
            if let super::collaboration::ChildCodeResult::Published { result, .. } = execution.code_result {
                source.mode=SourceMode::FixedBranch; source.native_scope=None; source.branch_id=Some(result.branch_id); source.revision=Some(result.result_revision);
                source.live_root=None; source.environment_run_id=None;
            }
        }
    }
    Ok(source)
}
/// Resolve source identity through the original execution registry, without choosing
/// current work when the caller supplied an exact execution.
fn agent_source_identity(db:&Connection, identity:&str)->Result<(String,Option<String>)> {
    if identity.contains('/') {
        use super::model_references::ExecutionTarget;
        match super::model_references::resolve_execution_reference(db,identity)?.target {
            ExecutionTarget::Native{thread_id,run_id,..}
            | ExecutionTarget::Delegated{thread_id,run_id:Some(run_id),..} => Ok((thread_id,Some(run_id))),
            _ => Err(RuntimeError::Invalid("Selected execution has no native file source".into())),
        }
    } else {Ok((super::threads::resolve(db,identity)?,None))}
}
pub(super) fn validate_agent_source(db: &Connection, parent: &Run, source_agent: Option<&str>,
    handoff: Option<&super::collaboration::ChildSourceHandoff>) -> Result<()> {
    let launch: super::launch_content::LaunchMetadata = record(db,"run_launches",&parent.id)?;
    if let Some(identity)=source_agent {
        let (thread,exact_run)=agent_source_identity(db,identity)?;
        if super::scheduling::thread_family(db,&thread)? != super::scheduling::thread_family(db,&parent.thread_id)? {
            return Err(RuntimeError::Conflict("file source is outside this task family".into()));
        }
        let handoff=handoff.ok_or_else(||RuntimeError::Invalid("Agent source handoff missing".into()))?;
        let run:Run=record(db,"runs",handoff.source_run_id.as_deref().ok_or_else(||RuntimeError::Invalid("Agent source Run missing".into()))?)?;
        let parent_source=launch.selection.source.as_ref().ok_or_else(||RuntimeError::Invalid("dispatch requires a file source".into()))?;
        let original:super::launch_content::LaunchMetadata=record(db,"run_launches",&run.id)?;
        // A previously captured live source remains owned by this original Run even
        // after that Run publishes a fixed result. Never replace the captured source.
        if run.thread_id!=thread || exact_run.as_ref().is_some_and(|id|id!=&run.id)
            || (original.selection.source.as_ref()!=Some(&handoff.source) && agent_file_source(db,&run)? != handoff.source)
            || handoff.source.workspace_id!=parent_source.workspace_id || handoff.source.resource_owner!=parent_source.resource_owner {
            return Err(RuntimeError::Conflict("Agent source differs from its original workspace".into()));
        }
    } else if launch.selection.source.as_ref()!=handoff.map(|h|&h.source) || handoff.is_some_and(|h|h.source_run_id.is_some()) {
        return Err(RuntimeError::Conflict("child source differs from the frozen invocation".into()));
    }
    Ok(())
}
impl Catalog {
    pub fn dispatch_agent_source(&self, run_id:&str, input:&DispatchInput)->Result<Option<AgentSourceSelection>> {
        let Some(identity)=&input.source_agent else{return Ok(None)};
        self.agent_source(run_id, identity).map(Some)
    }
    /// Capture the first admitted source selection once; retries cannot follow the
    /// same Agent into a later Run or replace its retained source version.
    pub fn freeze_dispatch_agent_source(&mut self, context:&crate::execution::ToolExecutionContext, input:&DispatchInput)->Result<Option<AgentSourceSelection>> {
        let Some(identity)=&input.source_agent else {return Ok(None)};
        let original=json!({"sourceAgent":identity});
        let value=if let Some(value)=self.model_target(&context.operation_id,"dispatch_source",&original)? {value}
            else {
                let selected=self.agent_source(&context.run_id,identity)?;
                self.freeze_model_target(&context.operation_id,"dispatch_source",&original,&serde_json::to_value(selected)?)?
            };
        let selected:AgentSourceSelection=serde_json::from_value(value)?;
        let parent=self.run(&context.run_id)?;
        let handoff=super::collaboration::ChildSourceHandoff {retention_pin:None,source_path:None,refresh:None,
            source_run_id:Some(selected.run_id.clone()),source:selected.source.clone(),operation_id:String::new(),resource_authority:None,
            root:super::collaboration::ChildSourceRoot::Physical{root:launches::LiveRoot{host_id:String::new(),root_id:String::new(),canonical_root:String::new()}}};
        validate_agent_source(&self.db,&parent,Some(identity),Some(&handoff))?;
        Ok(Some(selected))
    }
    pub fn agent_source(&self, run_id: &str, identity: &str) -> Result<AgentSourceSelection> {
        let parent=self.run(run_id)?;
        let (thread,exact_run)=agent_source_identity(&self.db,identity)?;
        let run_id=if let Some(run)=exact_run {run} else {
            let branch=super::threads::branch(&self.db,&thread)?;
            self.db.query_row("SELECT id FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",[branch],|r|r.get::<_,String>(0))?
        };
        let source=agent_file_source(&self.db,&self.run(&run_id)?)?;
        let selected=AgentSourceSelection{run_id,source};
        let handoff=super::collaboration::ChildSourceHandoff{ retention_pin: None, source_path: None,refresh:None,source_run_id:Some(selected.run_id.clone()),source:selected.source.clone(),operation_id:String::new(),resource_authority:None,
            root:super::collaboration::ChildSourceRoot::Physical{root:launches::LiveRoot{host_id:String::new(),root_id:String::new(),canonical_root:String::new()}}};
        validate_agent_source(&self.db,&parent,Some(identity),Some(&handoff))?;
        Ok(selected)
    }
}
impl ChildDispatchSelection {
    pub fn resolve_with_attachments(&self,input:&DispatchInput,attachments:&[super::attachments::Attachment])->Result<ResolvedChildSelection> {
        let selected = self.resolve(input)?;
        if attachments.iter().any(|file|file.is_direct_image())
            && !selected.profile.model_selection_required
            && selected.model.configuration.accepts_images != Some(true) {
            return Err(RuntimeError::Invalid("The selected child model does not declare image input support".into()));
        }
        Ok(selected)
    }

    pub fn external_preset(&self, input: &DispatchInput) -> Result<Option<ChildPreset>> {
        input.validate()?;
        let Some(preset) = self.catalog.presets.iter().find(|p| input.preset.as_deref() == Some(p.id.as_str()) && p.external.is_some()) else { return Ok(None); };
        if input.work_focus.is_some() { return Err(RuntimeError::Invalid("workFocus selects Varin's native tool disclosure; this external Agent manages its own modes. Omit workFocus for an external preset".into())); }
        self.require_preset_focus(preset, self.work_focus(input))?;
        if let Some(reason) = &preset.unavailable { return Err(RuntimeError::Invalid(format!("external Agent unavailable: {}", reason.code))); }
        if input.tools.is_some() { return Err(RuntimeError::Invalid("External Agents use their own tools; omit tools for this dispatch".into())); }
        // A prompt is not a read-only boundary. Only advertise this mode after the adapter
        // implements the harness's actual sandbox/permission capability.
        if input.work_mode == Some(ChildWorkMode::ReadOnly) { return Err(RuntimeError::Invalid("This external Agent has no configured read-only execution boundary; select shared or isolated_write".into())); }
        Ok(Some(preset.clone()))
    }
    pub fn external_input(&self, input: &DispatchInput, preset: &ChildPreset) -> Result<Value> {
        let mut text = String::new();
        if !preset.instructions.trim().is_empty() { text.push_str(&preset.instructions); text.push_str("\n\n"); }
        if input.inherit_context {
            let history = self.history.as_ref().ok_or_else(|| RuntimeError::Invalid("dispatch history unavailable".into()))?;
            let background = crate::context_retention::conversation_background(history);
            text.push_str("Conversation background supplied by the delegating Agent:\n");
            for item in background {
                use crate::execution::{Content, Provenance};
                let role=match item.provenance {Provenance::UserInstruction{..}=>"User",Provenance::Assistant=>"Assistant",Provenance::AgentMessage{..}=>"Related Agent",_=>continue};
                let body=match &item.content {
                    Content::Text{text}=>text.clone(),
                    Content::Output{output}=>output.parts.iter().filter_map(|p|match p {crate::output::OutputPart::Text{text}=>Some(text.as_str()),_=>None}).collect::<Vec<_>>().join("\n"),
                    _=>continue,
                };
                if !body.is_empty(){text.push_str(role);text.push_str(":\n");text.push_str(&body);text.push_str("\n\n");}
            }
            text.push_str("\n\nCurrent delegated task:\n");
        }
        text.push_str(&input.task);
        let mut value = json!({"text":text,"task":input.task,"_launch":preset.external.as_ref().map(|b|&b.launch)});
        if let Some(model) = preset.external.as_ref().and_then(|b| b.model.as_ref()) { value["model"] = json!(model); }
        Ok(value)
    }
    pub fn host_tool(&self, name: &str) -> Option<&ToolSchema> {
        self.extension_bindings
            .iter()
            .map(|binding| &binding.tool)
            .chain(self.mcp_binding.iter().flat_map(|binding| &binding.tools))
            .find(|tool| tool.name == name && self.frozen.allowed_delegation.contains(tool))
    }
    pub fn source_requirement(&self, name: &str) -> Option<ChildSourceRequirement> {
        if let Some(tool) = self.host_tool(name) {
            if self
                .extension_bindings
                .iter()
                .any(|binding| &binding.tool == tool)
            {
                return Some(
                    tool.requirements
                        .as_ref()
                        .map_or(ChildSourceRequirement::None, |r| r.source.into()),
                );
            }
            return self.mcp_binding.as_ref().map(|binding| {
                if binding.tool_uses_workspace(name) { ChildSourceRequirement::Source }
                else { ChildSourceRequirement::None }
            });
        }
        self.catalog
            .native_capabilities
            .iter()
            .find(|capability| capability.name == name)
            .map(|capability| capability.source_requirement)
    }
    pub fn preset_tools(&self, preset: &ChildPreset) -> Vec<String> {
        let mut tools = preset.tools.clone();
        if preset.tools_source == ChildPresetToolsSource::Default {
            for tool in &self.frozen.allowed_delegation {
                if self.host_tool(&tool.name).is_some()
                    && self.source_requirement(&tool.name) != Some(ChildSourceRequirement::Live)
                    && !tools.contains(&tool.name) { tools.push(tool.name.clone()); }
            }
        }
        if preset.tools_source == ChildPresetToolsSource::Default && self.frozen.source.is_none() {
            tools
                .iter()
                .filter(|name| {
                    !matches!(
                        self.source_requirement(name),
                        Some(
                            ChildSourceRequirement::Source
                                | ChildSourceRequirement::Physical
                                | ChildSourceRequirement::Live
                        )
                    )
                })
                .cloned()
                .collect()
        } else {
            tools
        }
    }
    pub fn unavailable_source_tools(&self, tools: &[String]) -> Vec<String> {
        if self.frozen.source.is_some() {
            return Vec::new();
        }
        tools
            .iter()
            .filter(|name| {
                matches!(
                    self.source_requirement(name),
                    Some(
                        ChildSourceRequirement::Source
                            | ChildSourceRequirement::Physical
                            | ChildSourceRequirement::Live
                    )
                )
            })
            .cloned()
            .collect()
    }
    fn physical_tool(&self, name: &str) -> bool {
        self.source_requirement(name) == Some(ChildSourceRequirement::Physical)
            || (self.host_tool(name).is_none() && self.catalog.native_capabilities.iter().any(|tool|tool.name==name && tool.process))
    }
    /// Resolve only an already authenticated configuration snapshot. Executable declarations
    /// are still assembled and checked by their owning tool directory in the kernel.
    pub fn project(&self,input:&DispatchInput)->Result<Option<ChildProjectSource>> {
        input.project_id.as_ref().map(|id|self.catalog.projects.iter().find(|p|&p.id==id).cloned().ok_or_else(||RuntimeError::Invalid(format!("Registered project {id} is not in this request; use matters projects to discover available project IDs")))).transpose()
    }
    pub fn work_focus<'a>(&'a self, input: &'a DispatchInput) -> &'a str {
        input.work_focus.as_deref().or(self.frozen.work_focus.as_deref()).unwrap_or("general")
    }
    fn require_preset_focus(&self, preset: &ChildPreset, focus: &str) -> Result<()> {
        if !preset.work_focus.is_empty() && !preset.work_focus.iter().any(|allowed| allowed == focus) {
            return Err(RuntimeError::Invalid(format!(
                "Child preset {} is available in workFocus [{}], not {focus}. Choose an applicable workFocus or omit preset for free dispatch",
                preset.id, preset.work_focus.join(", ")
            )));
        }
        Ok(())
    }
    pub fn resolve(&self, input: &DispatchInput) -> Result<ResolvedChildSelection> {
        input.validate()?;
        self.project(input)?;
        let focus = self.work_focus(input);
        let model_selection_required = input.preset.is_none() && self.catalog.model_selection_preparation;
        if !model_selection_required && (input.model.is_some() || input.thinking.is_some()) {
            return Err(RuntimeError::Invalid("Delegated model preparation unavailable; start a new request".into()));
        }
        let available = self.catalog.presets.iter().filter(|preset| preset.unavailable.is_none() && preset.id != "code_retrieval"
            && (preset.work_focus.is_empty() || preset.work_focus.iter().any(|allowed| allowed == focus)))
            .map(|preset| preset.id.as_str()).collect::<Vec<_>>().join(", ");
        let available = if available.is_empty() { "none" } else { &available };
        let (mut tools, mode, instructions, model, avatar) = if let Some(id) = &input.preset {
            let preset = self
                .catalog
                .presets
                .iter()
                .find(|preset| &preset.id == id)
                .ok_or_else(|| {
                    RuntimeError::Invalid(format!("child preset {id} is not selected. Available presets: {available}. Configure child agents in Settings > Agents, or omit preset to use the default delegation."))
                })?;
            if let Some(failure) = &preset.unavailable {
                return Err(RuntimeError::Invalid(format!(
                    "child preset {id} unavailable: {}{}. Available presets: {available}. Configure this child agent in Settings > Agents, or omit preset to use the default delegation.",
                    failure.code, if failure.capabilities.is_empty() { String::new() }
                        else { format!("; unavailable capabilities: {}", failure.capabilities.join(", ")) }
                )));
            }
            self.require_preset_focus(preset, focus)?;
            if preset
                .inherit_base
                .as_ref()
                .is_some_and(|base| base != &self.frozen.parent_model)
            {
                return Err(RuntimeError::Conflict(
                    "child preset inheritance basis changed; prepare its model selection again"
                        .into(),
                ));
            }
            (
                if input.project_id.is_some() { preset.tools.clone() } else { self.preset_tools(preset) },
                // Placement is chosen by this dispatch, independently of the role.
                input.work_mode.unwrap_or(ChildWorkMode::Shared),
                preset.instructions.clone(),
                preset
                    .model
                    .clone()
                    .unwrap_or_else(|| self.frozen.parent_model.clone()),
                preset.avatar.clone(),
            )
        } else {
            if let Some(failure) = &self.catalog.normal_unavailable {
                return Err(RuntimeError::Invalid(format!(
                    "normal child dispatch unavailable: {}",
                    failure.code
                )));
            }
            let mut tools: Vec<_> = self
                .frozen
                .allowed_delegation
                .iter()
                .map(|tool| tool.name.clone())
                .collect();
            if input.work_mode == Some(ChildWorkMode::IsolatedWrite) && self.frozen.source.is_some()
            {
                for name in ["file_write", "file_edit"] {
                    if !tools.iter().any(|tool| tool == name) {
                        tools.push(name.into());
                    }
                }
            }
            (tools, input.work_mode.unwrap_or(ChildWorkMode::Shared), String::new(), self.frozen.parent_model.clone(), None)
        };
        // An explicit read-only dispatch narrows a default capability set; an explicit tool list
        // remains exact and is checked below.
        if mode == ChildWorkMode::ReadOnly && input.tools.is_none() {
            tools.retain(|name| !self.physical_tool(name));
        }
        if input.preset.as_deref() == Some("code_retrieval") {
            tools.retain(|name| !matches!(name.as_str(), "code_retrieval" | "retrieval_control" | "dispatch")
                && self.frozen.allowed_delegation.iter().any(|tool| &tool.name == name));
        }
        if let Some(selected) = &input.tools {
            if selected.iter().any(|name| !tools.contains(name)) {
                return Err(RuntimeError::Invalid(
                    "requested child tools exceed the frozen delegation".into(),
                ));
            }
            tools = selected.clone();
        }
        // Discovery/call are the native interface to this exact subset, not additional
        // target authority. Explicit profiles retain the interface even when listing only
        // their domain capabilities. Older retained catalogs do not acquire new declarations.
        for gateway in crate::tool_disclosure::schemas() {
            if self.catalog.native_capabilities.iter().any(|entry| entry.name == gateway.name && entry.version == gateway.version)
                && !tools.contains(&gateway.name) {
                tools.push(gateway.name);
            }
        }
        if self.frozen.source.is_none() && input.project_id.is_none() {
            let unavailable = self.unavailable_source_tools(&tools);
            if !unavailable.is_empty() {
                return Err(RuntimeError::Invalid(format!(
                    "child tools require a file source: {}; select a source or select only source-independent tools",
                    unavailable.join(", ")
                )));
            }
        }
        let project_mcp=if input.project_id.is_some(){self.mcp_binding.as_ref().and_then(|binding|binding.global_delegation())}else{self.mcp_binding.clone()};
        if input.project_id.is_some() {
            let foreign=tools.iter().filter(|name|self.mcp_binding.as_ref().is_some_and(|original|original.tools.iter().any(|tool|&tool.name==*name))
                && !project_mcp.as_ref().is_some_and(|selected|selected.tools.iter().any(|tool|&tool.name==*name))).cloned().collect::<Vec<_>>();
            if input.tools.as_ref().is_some_and(|selected|selected.iter().any(|name|foreign.contains(name))){return Err(RuntimeError::Invalid("Selected workspace MCP tools belong to the original project's configuration; choose source-independent tools or the original source".into()));}
            tools.retain(|name|!foreign.contains(name));
        }
        if tools
            .iter()
            .any(|name| self.source_requirement(name) == Some(ChildSourceRequirement::Live))
        {
            return Err(RuntimeError::Invalid(
                "Live-source tools cannot run on a child's fixed or materialized source".into(),
            ));
        }
        if mode == ChildWorkMode::ReadOnly && tools.iter().any(|name| self.physical_tool(name)) {
            let physical = tools.iter().filter(|name| self.physical_tool(name)).cloned().collect::<Vec<_>>();
            return Err(RuntimeError::Invalid(format!(
                "selected child tools can change files and cannot run read-only: {}. Omit workMode to share the source, use workMode=isolated_write for an independent copy, or exclude these tools.", physical.join(", ")
            )));
        }
        tools.sort();
        model.connection_identity()?;
        let process = tools.iter().any(|name| {
            if let Some(tool) = self.host_tool(name) {
                return tool.requirements.as_ref().is_some_and(|r| r.process);
            }
            self.catalog
                .native_capabilities
                .iter()
                .find(|capability| &capability.name == name)
                .is_some_and(|capability| capability.process)
        });
        Ok(ResolvedChildSelection {
            agent: input.work_focus.as_ref().or(self.frozen.work_focus.as_ref()).map(|focus| launches::AgentSelection {
                profile_id: None, name: None, work_focus: focus.clone(), tools: None,
            }),
            process,
            frozen_reference: self.reference.clone(),
            catalog_ref: self.frozen.catalog_ref.clone().ok_or_else(|| {
                RuntimeError::Invalid("child delegation directory is unavailable".into())
            })?,
            model,
            tool_schema_generation: self.frozen.tool_schema_generation,
            parent_tools_ref: self.frozen.tools_ref.clone(),
            mcp_binding: project_mcp
                .as_ref()
                .and_then(|binding| binding.delegate(&tools)),
            extension_bindings: self
                .extension_bindings
                .iter()
                .filter(|binding| tools.contains(&binding.tool.name))
                .cloned()
                .collect(),
            profile: ChildSelectedProfile {
                model_selection_required,
                project_mcp: self.project(input)?.map(|project| ChildProjectMcp { project, tools: input.tools.clone() }),
                avatar,
                preset_id: input.preset.clone(),
                catalog_identity: Some(self.catalog.identity.clone()),
                work_mode: mode,
                tools,
                instructions,
            },
        })
    }
}
impl ChildDispatchRead {
    pub fn load(self) -> Result<ChildDispatchSelection> {
        let frozen: FrozenChildDispatch =
            serde_json::from_value(self.content.load(&self.reference)?)?;
        let catalog: ChildDispatchCatalog =
            serde_json::from_value(self.content.load(frozen.catalog_ref.as_ref().ok_or_else(
                || RuntimeError::Invalid("child delegation directory is unavailable".into()),
            )?)?)?;
        catalog.validate()?;
        frozen.parent_model.connection_identity()?;
        if let Some(source) = &frozen.source {
            source.validate()?;
        }
        let tools: Vec<ToolSchema> = serde_json::from_value(self.content.load(&frozen.tools_ref)?)?;
        if frozen
            .allowed_delegation
            .iter()
            .any(|tool| !tools.contains(tool))
        {
            return Err(RuntimeError::Invalid(
                "delegation differs from its original tool directory".into(),
            ));
        }
        let mcp_binding: Option<super::launches::HostToolBinding> = frozen
            .mcp_binding_ref
            .as_ref()
            .map(|reference| {
                serde_json::from_value(self.content.load(reference)?).map_err(RuntimeError::from)
            })
            .transpose()?;
        let extension_bindings: Vec<super::launches::ExtensionToolBinding> =
            serde_json::from_value(self.content.load(&frozen.extension_bindings_ref)?)?;
        if let Some(binding) = &mcp_binding {
            binding.validate()?;
            if binding.tools.iter().any(|tool| !tools.contains(tool)) {
                return Err(RuntimeError::Invalid(
                    "delegated MCP declaration differs from its original directory".into(),
                ));
            }
        }
        for binding in &extension_bindings {
            binding.validate()?;
            if !tools.contains(&binding.tool) {
                return Err(RuntimeError::Invalid(
                    "delegated extension declaration differs from its original directory".into(),
                ));
            }
        }
        Ok(ChildDispatchSelection {
            history: None,
            reference: self.reference,
            frozen,
            catalog,
            mcp_binding,
            extension_bindings,
            _publication: self._publication,
        })
    }
}

pub struct ChildInvocationRead {
    body: Value,
    context: crate::execution::ToolExecutionContext,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ChildInvocationRead {
    pub fn load(self) -> Result<ChildDispatchSelection> { self.load_for(true) }
    pub fn load_for(self, inherit_history: bool) -> Result<ChildDispatchSelection> {
        use crate::execution::{RequestSnapshot, ToolOrigin};
        let mut history = None;
        let reference = match &self.context.origin {
            ToolOrigin::Driver { invocation_id } => {
                let original: super::driver::DriverCallMetadata = serde_json::from_value(self.body.clone())?;
                if original.id != *invocation_id || original.run_id != self.context.run_id { return Err(RuntimeError::Conflict("driver dispatch owner changed".into())); }
                let frozen: crate::execution::FrozenToolContext = serde_json::from_value(self.content.load(&original.frozen_ref)?)?;
                if inherit_history {
                    if let Some(reference) = &original.dispatch_history { history = Some(self.content.load_items(reference, &|| false)?); }
                }
                frozen.child_dispatch
            }
            ToolOrigin::ModelStep { request_id } => {
                if !inherit_history && self.body.get("dispatch").is_some() {
                    let metadata = &self.body["dispatch"];
                    if metadata["requestId"] != *request_id || metadata["runId"] != self.context.run_id {
                        return Err(RuntimeError::Invalid("dispatch request belongs to another origin".into()));
                    }
                    metadata.get("childDispatch").filter(|v| !v.is_null()).cloned()
                } else {
                    let snapshot: RequestSnapshot = self.content.load_snapshot(&self.body)?;
                    if snapshot.view.request_id != *request_id || snapshot.view.run_id != self.context.run_id {
                        return Err(RuntimeError::Invalid("dispatch request belongs to another origin".into()));
                    }
                    history = Some(snapshot.view.history);
                    snapshot.view.binding.child_dispatch
                }
            }
            ToolOrigin::PolicyAction { action_id, node_id } => {
                let body: super::policy_body::PolicyGraphBody = serde_json::from_value(self.content.load(&self.body)?)?;
                if body.action_id != *action_id {
                    return Err(RuntimeError::Invalid(
                        "dispatch graph belongs to another origin".into(),
                    ));
                }
                if let Some(reference) = body.dispatch_history.as_ref().filter(|_| inherit_history) {
                    history = Some(self.content.load_items(reference, &|| false)?);
                }
                body.nodes
                    .into_iter()
                    .find(|node| node.node.id == *node_id)
                    .ok_or_else(|| RuntimeError::NotFound("dispatch graph node".into()))?
                    .child_dispatch
            }
            ToolOrigin::NestedCall { .. } => unreachable!("resolved root invocation"),
        }
        .ok_or_else(|| {
            RuntimeError::Invalid("dispatch has no frozen configuration selection".into())
        })?;
        let mut selection = ChildDispatchRead {
            reference,
            content: self.content,
            _publication: self._publication,
        }
        .load()?;
        selection.history = history;
        Ok(selection)
    }
}
impl ChildDispatchPreparation {
    pub fn load(self) -> Result<PreparedChildDispatch> {
        let connection_identity = self.model.connection_identity()?;
        if self.selection.connection_identity != connection_identity
            || self.selection.credential_scope != self.model.credential_scope
        {
            return Err(RuntimeError::Conflict(
                "delegation model differs from its launch".into(),
            ));
        }
        let tools: Vec<ToolSchema> =
            serde_json::from_value(self.content.load(&self.selection.tools_ref)?)?;
        if self
            .allowed_delegation
            .iter()
            .any(|tool| !tools.contains(tool))
        {
            return Err(RuntimeError::Conflict(
                "delegation differs from its selected tool generation".into(),
            ));
        }
        let catalog_ref = self.selection.child_dispatch_ref.clone();
        if let Some(reference) = &catalog_ref {
            let catalog: ChildDispatchCatalog =
                serde_json::from_value(self.content.load(reference)?)?;
            catalog.validate()?;
        }
        let extensions: Vec<super::launches::ExtensionToolBinding> =
            serde_json::from_value(self.content.load(&self.selection.extension_bindings_ref)?)?;
        // A native MCP-only Run may intentionally have no child directory. Retain its actual
        // composition anyway; task identity must not depend on enabling a delegation capability.
        let reference = if catalog_ref.is_some()
            || self.selection.mcp_binding_ref.is_some()
            || !extensions.is_empty()
        {
            Some(
                self.content
                    .save(&serde_json::to_value(FrozenChildDispatch {
                        work_focus: self.selection.agent.as_ref().map(|agent| agent.work_focus.clone()),
                        source: self.selection.source.clone(),
                        catalog_ref,
                        parent_model: self.model.clone(),
                        allowed_delegation: self.allowed_delegation,
                        tool_schema_generation: self.selection.tool_schema_generation,
                        tools_ref: self.selection.tools_ref.clone(),
                        mcp_binding_ref: self.selection.mcp_binding_ref.clone(),
                        extension_bindings_ref: self.selection.extension_bindings_ref.clone(),
                    })?)?,
            )
        } else {
            None
        };
        Ok(PreparedChildDispatch {
            reference,
            selection: self.selection,
            _publication: self.publication,
        })
    }
}
impl Catalog {
    pub fn bind_child_dispatch(
        &mut self,
        run_id: &str,
        prepared: PreparedChildDispatch,
    ) -> Result<Option<Value>> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, self.epoch)?;
        let mut launch: launch_content::LaunchMetadata = record(&tx, "run_launches", run_id)?;
        if run.cancel_requested || launch.selection != prepared.selection {
            return Err(RuntimeError::Conflict(
                "child delegation launch changed during preparation".into(),
            ));
        }
        launch.dispatch_context_ref = prepared.reference.clone();
        put(&tx, "run_launches", run_id, &launch)?;
        tx.commit()?;
        Ok(prepared.reference)
    }
    pub fn prepare_child_catalog(
        &self,
        catalog: Option<ChildDispatchCatalog>,
    ) -> ChildCatalogPreparation {
        ChildCatalogPreparation {
            catalog,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
    pub fn capture_child_dispatch(&self, reference: &Value) -> ChildDispatchRead {
        ChildDispatchRead {
            reference: reference.clone(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }
    }
    pub fn capture_child_dispatch_invocation(
        &self,
        context: &crate::execution::ToolExecutionContext,
    ) -> Result<ChildInvocationRead> {
        use crate::execution::ToolOrigin;
        let context = super::tool_content::root_tool_context(&self.db, context, false)?;
        let body = match &context.origin {
            ToolOrigin::Driver { invocation_id } => {
                let original = super::driver::driver_call_metadata(&self.db, invocation_id)?;
                if original.run_id != context.run_id { return Err(RuntimeError::Conflict("driver dispatch Run changed".into())); }
                super::driver::require_driver(&self.db, &context.run_id, &original.driver_id)?;
                serde_json::to_value(original)?
            }
            ToolOrigin::ModelStep { request_id } => {
                let step: ModelStep = record(&self.db, "model_steps", request_id)?;
                if step.run_id != context.run_id {
                    return Err(RuntimeError::Invalid("dispatch request Run changed".into()));
                }
                step.request
            }
            ToolOrigin::PolicyAction { action_id, .. } => {
                let operation = self.operation(action_id)?;
                if operation.run_id != context.run_id {
                    return Err(RuntimeError::Invalid("dispatch policy Run changed".into()));
                }
                super::policy_body::PolicyActionMetadata::from_operation(&operation)?
                    .ok_or_else(|| {
                        RuntimeError::Invalid("dispatch origin is not a policy action".into())
                    })?
                    .body_ref()
                    .clone()
            }
            ToolOrigin::NestedCall { .. } => unreachable!("resolved root invocation"),
        };
        Ok(ChildInvocationRead {
            body,
            context: context.clone(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn prepare_child_dispatch_binding(
        &self,
        run_id: &str,
        model: ChildModelBinding,
        tool_schema_generation: u64,
        allowed_delegation: Vec<ToolSchema>,
    ) -> Result<ChildDispatchPreparation> {
        let launch = self
            .launch_metadata(run_id)?
            .ok_or_else(|| RuntimeError::NotFound("Run launch".into()))?;
        if launch.selection.tool_schema_generation != tool_schema_generation {
            return Err(RuntimeError::Conflict(
                "delegation tool generation differs from its selected directory".into(),
            ));
        }
        Ok(ChildDispatchPreparation {
            selection: launch.selection,
            model,
            allowed_delegation,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TreeCancelTarget {
    Thread { thread_id: String },
    Child { operation_id: String },
    Execution { execution_id: String },
    Run { run_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TreeCancelParams {
    pub target: TreeCancelTarget,
    #[serde(
        rename = "expectedParentThreadId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub expected_parent_thread_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TreeCancellationReceipt {
    pub target: TreeCancelTarget,
    pub cursor: u64,
    pub run_count: usize,
    pub child_count: usize,
    pub process_count: usize,
}

pub struct ChildCatalogPreparation {
    catalog: Option<ChildDispatchCatalog>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChildCatalog {
    pub(super) reference: Option<Value>,
    _publication: crate::content::ContentPublication,
}
impl ChildCatalogPreparation {
    pub fn load(self) -> Result<PreparedChildCatalog> {
        let reference = self
            .catalog
            .map(|catalog| {
                catalog.validate()?;
                self.content.save(&serde_json::to_value(catalog)?)
            })
            .transpose()?;
        Ok(PreparedChildCatalog {
            reference,
            _publication: self.publication,
        })
    }
}

/// Short control capture, retained only by the cancellation worker. Lineage and all
/// cancellation intent remain in the original Catalog records, including completed reports.
pub struct TreeCancellationCapture {
    pub receipt: TreeCancellationReceipt,
    pub run_ids: Vec<String>,
    pub process_ids: Vec<String>,
}
impl Catalog {
    pub fn cancel_tree(&mut self, target: TreeCancelTarget) -> Result<TreeCancellationCapture> {
        self.cancel_tree_checked(target, None)
    }
    pub fn cancel_tree_checked(
        &mut self,
        target: TreeCancelTarget,
        expected_parent_thread_id: Option<&str>,
    ) -> Result<TreeCancellationCapture> {
        use super::collaboration::{ChildCodeResult, ChildReport};
        use std::collections::BTreeSet;
        let tx = self.db.transaction()?;
        // Exact controls never broaden to the Agent's next admission or other branches.
        let mut exact_runs = BTreeSet::new();
        let mut exact_executions = BTreeSet::new();
        let exact = matches!(target, TreeCancelTarget::Execution { .. } | TreeCancelTarget::Run { .. });
        let root = match &target {
            TreeCancelTarget::Execution { execution_id } => {
                let execution=super::delegated::execution(&tx,execution_id)?;
                let child=super::delegated::relation(&tx,&execution.child_operation_id)?;
                if let Some(thread)=expected_parent_thread_id {
                    let requester=super::bot_reports::requester(&tx,execution_id)?;
                    if thread!=child.parent_thread_id && thread!=requester.thread_id {
                        return Err(RuntimeError::Invalid("execution does not belong to the expected requesting Thread".into()));
                    }
                }
                exact_executions.insert(execution_id.clone());
                if let Some(receipt)=execution.receipt {exact_runs.insert(receipt.run_id);}
                child.child_thread_id
            },
            TreeCancelTarget::Run { run_id } => {
                let run:Run=record(&tx,"runs",run_id)?;
                if expected_parent_thread_id.is_some() {return Err(RuntimeError::Invalid("parent scope applies only to delegated executions".into()));}
                exact_runs.insert(run_id.clone());run.thread_id
            },
            TreeCancelTarget::Thread { thread_id } => {
                if expected_parent_thread_id.is_some() {
                    return Err(RuntimeError::Invalid(
                        "parent scope applies only to a child cancellation target".into(),
                    ));
                }
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
                    [thread_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(RuntimeError::NotFound(thread_id.clone()));
                }
                thread_id.clone()
            }
            TreeCancelTarget::Child { operation_id } => {
                // User dependency retention is already cancellable before there is a child
                // relation. Resolve this under the same transaction as real child admission,
                // so a Host status-read race cannot stop only half of an accepted task.
                let child: Option<super::delegated::ChildRelation> =
                    optional_record(&tx, "child_tasks", operation_id)?;
                let Some(child) = child else {
                    let op: Operation = record(&tx, "operations", operation_id)?;
                    let run: Run = record(&tx, "runs", &op.run_id)?;
                    if op.executor.as_deref() != Some("user_dispatch") || op.intent["kind"] != "user_child_dispatch_v1" || op.handed_off {
                        return Err(RuntimeError::NotFound(operation_id.clone()));
                    }
                    if expected_parent_thread_id.is_some_and(|thread|thread != run.thread_id) {
                        return Err(RuntimeError::Invalid("handoff does not belong to the expected parent Thread".into()));
                    }
                    super::request_cancel_operation_in(&tx, operation_id)?;
                    let cursor = tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |row|read_number(row,0))?;
                    let receipt=TreeCancellationReceipt { target:target.clone(), cursor,run_count:0,child_count:0,process_count:0 };
                    tx.commit()?;
                    return Ok(TreeCancellationCapture {receipt,run_ids:Vec::new(),process_ids:Vec::new()});
                };
                if expected_parent_thread_id.is_some_and(|thread| thread != child.parent_thread_id)
                {
                    return Err(RuntimeError::Invalid(
                        "child does not belong to the expected parent Thread".into(),
                    ));
                }
                child.child_thread_id
            }
        };
        let mut threads = BTreeSet::from([root]);
        let children = {
            let mut statement = tx.prepare("SELECT body FROM child_tasks ORDER BY id")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.map(|row| {
                Ok(serde_json::from_str::<super::delegated::ChildRelation>(
                    &row?,
                )?)
            })
            .collect::<Result<Vec<_>>>()?
        };
        if exact {
            // Follow the selected Run's actual dispatch edges, not a mutable Thread family.
            loop {
                let before=(exact_runs.len(),exact_executions.len());
                for child in &children {
                    if exact_runs.contains(&child.parent_run_id) {
                        exact_executions.insert(child.operation_id.clone());
                        let execution=super::delegated::execution(&tx,&child.operation_id)?;
                        if let Some(receipt)=execution.receipt {exact_runs.insert(receipt.run_id);}
                    }
                }
                if before==(exact_runs.len(),exact_executions.len()){break;}
            }
        }
        // Fixed point over the original lineage, with no artificial depth limit. This lock
        // also fences new descendants until their original parent Run is cancelled below.
        while !exact {
            let before = threads.len();
            for child in &children {
                if threads.contains(&child.parent_thread_id) {
                    threads.insert(child.child_thread_id.clone());
                }
            }
            if before == threads.len() {
                break;
            }
        }
        for thread in threads.iter().filter(|_| !exact) {
            super::activation::cancel_thread(&tx, thread)?;
            super::calendar::cancel_thread_pending(&tx, thread)?;
        }
        let children = children
            .into_iter()
            .filter(|child| if exact {
                exact_executions.iter().any(|execution| super::delegated::execution(&tx,execution).is_ok_and(|e|e.child_operation_id==child.operation_id))
            } else {threads.contains(&child.child_thread_id)})
            .collect::<Vec<_>>();
        let runs = {
            let mut statement = tx.prepare("SELECT body FROM runs WHERE branch_id IS NOT NULL ORDER BY id")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str::<Run>(&row?)?))
                .collect::<Result<Vec<_>>>()?
        };
        let runs = runs
            .into_iter()
            .filter(|run| if exact {exact_runs.contains(&run.id)} else {threads.contains(&run.thread_id)})
            .collect::<Vec<_>>();
        let run_ids = runs.iter().map(|run| run.id.clone()).collect::<Vec<_>>();
        for run in &runs {
            let stopped: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='run.tree_stop_requested')", [&run.id], |r| r.get(0))?;
            if !stopped {
                event(
                    &tx,
                    &run.id,
                    run.revision,
                    "run.tree_stop_requested",
                    Value::Null,
                )?;
            }
            super::request_cancel_run_in(&tx, &run.id)?;
            let staged = {
                let mut statement=tx.prepare("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.executor')='user_dispatch' AND json_extract(body,'$.handed_off')=0 AND json_extract(body,'$.phase')!='terminal'")?;
                let rows=statement.query_map([&run.id],|r|r.get::<_,String>(0))?;
                rows.collect::<std::result::Result<Vec<_>,_>>()?
            };
            for operation in staged {super::request_cancel_operation_in(&tx,&operation)?;}
            // Terminal source Runs can still own live process-trigger registrations. Cancel
            // those original registrations without changing the source Run's terminal fact.
            super::followups::cancel_tree_source_run(&tx, &run.id)?;
            super::goals::cancel_run(&tx, &run.id)?;
            super::mcp_resources::cancel_run(&tx, &run.id, false)?;
            super::mcp_interactions::cancel_run(&tx, &run.id, false)?;
        }
        let mut process_ids = Vec::new();
        for run in &runs {
            let ids = {
                let mut statement = tx.prepare("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.managed_process') IS NOT NULL AND coalesce(json_extract(body,'$.external_receipt.executor_stopped'),0)=0 ORDER BY id")?;
                let rows = statement.query_map([&run.id], |row| row.get::<_, String>(0))?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            };
            for id in ids {
                super::request_cancel_operation_in(&tx, &id)?;
                process_ids.push(id);
            }
        }
        for run in &runs {
            let ids = {
                let mut statement = tx.prepare("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.execution_owner.kind')='external' AND json_extract(body,'$.lifetime') IN ('thread','environment') AND (json_extract(body,'$.host_job') IS NOT NULL OR json_extract(body,'$.intent.kind')='user_host_job' OR json_extract(body,'$.intent.contract.completion')='job') AND coalesce(json_extract(body,'$.external_receipt.executor_stopped'),0)=0 ORDER BY id")?;
                let rows = statement.query_map([&run.id], |row| row.get::<_, String>(0))?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            };
            for id in ids {
                super::request_cancel_operation_in(&tx, &id)?;
            }
        }
        for child in &children {
            if !exact || exact_executions.contains(&child.operation_id) {
                super::request_cancel_operation_in(&tx, &child.operation_id)?;
            }
            let executions: Vec<super::delegated::DelegatedExecution> = {
                let mut s = tx
                    .prepare("SELECT body FROM delegated_executions WHERE child_operation_id=?1")?;
                let rows = s.query_map([&child.operation_id], |row| row.get::<_, String>(0))?;
                rows.map(|row| Ok(serde_json::from_str(&row?)?))
                    .collect::<Result<_>>()?
            };
            for mut execution in executions {
                if exact && !exact_executions.contains(&execution.execution_id) {continue;}
                let selection: Option<String> = tx.query_row(
                    "SELECT id FROM operations WHERE json_extract(body,'$.intent.kind')='delegation_model_selection_v1' AND json_extract(body,'$.intent.executionId')=?1",
                    [&execution.execution_id], |row| row.get(0),
                ).optional()?;
                if let Some(selection) = selection {
                    let mut selection = super::request_cancel_operation_in(&tx, &selection)?;
                    // This root owns preparation, not transport. End its publication authority
                    // while original inference receipts retain independent drain/usage duties.
                    if selection.phase != OperationPhase::Terminal {
                        selection.phase = OperationPhase::Terminal;
                        selection.outcome = Some(Outcome::Cancelled);
                        selection.revision += 1;
                        put(&tx, "operations", &selection.id, &selection)?;
                        event(&tx, &selection.id, selection.revision, "child.model_selection_cancelled", Value::Null)?;
                    }
                }
                if execution.cancel_requested {
                    continue;
                }
                execution.cancel_requested = true;
                let report_created=execution.receipt.is_none() && execution.report.is_none();
                if execution.receipt.is_none() && execution.report.is_none() {
                    if !execution.code_result.settled() {
                        execution.code_result = ChildCodeResult::Unavailable {
                            code: "cancelled_before_launch".into(),
                            effect: Effect::None,
                        };
                    }
                    execution.report = Some(ChildReport { attachments: Vec::new(),
                        error: None,
                        outcome: Outcome::Cancelled,
                        sender_thread_id: child.child_thread_id.clone(),
                        run_id: None,
                        history_ids: vec![],
                        detail: Some("Child preparation was cancelled before launch.".into()),
                    });
                }
                execution.revision += 1;
                super::delegated::write_execution(&tx, &execution)?;
                event(
                    &tx,
                    &execution.execution_id,
                    execution.revision,
                    "child.cancel_requested",
                    Value::Null,
                )?;
                if report_created {
                    event(&tx,&execution.execution_id,execution.revision,"child.report_ready",json!({"outcome":"cancelled","atMs":observations::wall_time_ms()?}))?;
                    super::bot_reports::publish_pending(&tx, &execution.execution_id, execution.revision)?;
                }
            }
        }
        let cursor: u64 =
            tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |row| {
                read_number(row, 0)
            })?;
        let receipt = TreeCancellationReceipt {
            target,
            cursor,
            run_count: run_ids.len(),
            child_count: children.len(),
            process_count: process_ids.len(),
        };
        tx.commit()?;
        Ok(TreeCancellationCapture {
            receipt,
            run_ids,
            process_ids,
        })
    }
}
