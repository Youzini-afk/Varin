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
    IsolatedWrite,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChildSourceRequirement {
    None,
    Source,
    Physical,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChildCapabilityDescriptor {
    pub name: String,
    pub version: String,
    pub source_requirement: ChildSourceRequirement,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchInput {
    pub task: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_mode: Option<ChildWorkMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
}
impl DispatchInput {
    pub fn validate(&self) -> Result<()> {
        if self.task.trim().is_empty()
            || self.preset.as_ref().is_some_and(|id| id.trim().is_empty())
        {
            return Err(RuntimeError::Invalid(
                "dispatch requires a task and a valid selected preset".into(),
            ));
        }
        if let Some(tools) = &self.tools {
            validate_names(tools)?;
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
                ))
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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildPreset {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub tools: Vec<String>,
    pub work_mode: ChildWorkMode,
    pub model_source: ChildModelSource,
    pub inherit_base: Option<ChildModelBinding>,
    /// Absence means the configuration owner explicitly selected parent inheritance.
    /// An unavailable configured model is represented by `unavailable`, never by absence.
    pub model: Option<ChildModelBinding>,
    pub unavailable: Option<ChildCapabilityFailure>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildDispatchCatalog {
    pub identity: String,
    pub native_capabilities: Vec<ChildCapabilityDescriptor>,
    pub normal_unavailable: Option<ChildCapabilityFailure>,
    pub presets: Vec<ChildPreset>,
}
impl ChildDispatchCatalog {
    pub fn validate(&self) -> Result<()> {
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
            if preset.id.trim().is_empty()
                || preset.name.trim().is_empty()
                || !names.insert(&preset.id)
            {
                return Err(RuntimeError::Invalid(
                    "child preset identities must be nonempty and unique".into(),
                ));
            }
            validate_names(&preset.tools)?;
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
pub struct ChildSelectedProfile {
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
    pub catalog_ref: Value,
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
    reference: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct ChildDispatchSelection {
    pub reference: Value,
    pub frozen: FrozenChildDispatch,
    pub catalog: ChildDispatchCatalog,
    pub mcp_binding: Option<super::launches::HostToolBinding>,
    pub extension_bindings: Vec<super::launches::ExtensionToolBinding>,
    _publication: crate::content::ContentPublication,
}
#[derive(Debug)]
pub struct ResolvedChildSelection {
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
    pub work_mode: ChildWorkMode,
    pub process: bool,
    pub configured_preset: bool,
    pub selection_ref: Value,
}
impl ResolvedChildSelection {
    pub fn source_delegation(&self) -> ChildSourceDelegation {
        ChildSourceDelegation {
            work_mode: self.profile.work_mode,
            process: self.profile.tools.iter().any(|name| {
                matches!(
                    name.as_str(),
                    "process_spawn"
                        | "process_inspect"
                        | "process_read"
                        | "process_write"
                        | "process_resize"
                        | "wait_process"
                ) && !self
                    .extension_bindings
                    .iter()
                    .any(|binding| &binding.tool.name == name)
                    && !self
                        .mcp_binding
                        .as_ref()
                        .is_some_and(|binding| binding.tools.iter().any(|tool| &tool.name == name))
            }),
            configured_preset: self.profile.preset_id.is_some(),
            selection_ref: self.frozen_reference.clone(),
        }
    }
}
fn physical_tool(name: &str) -> bool {
    matches!(
        name,
        "file_write"
            | "file_edit"
            | "process_spawn"
            | "process_inspect"
            | "process_read"
            | "process_write"
            | "process_resize"
            | "wait_process"
    )
}
impl ChildDispatchSelection {
    pub fn host_tool(&self, name: &str) -> Option<&ToolSchema> {
        self.extension_bindings
            .iter()
            .map(|binding| &binding.tool)
            .chain(self.mcp_binding.iter().flat_map(|binding| &binding.tools))
            .find(|tool| tool.name == name && self.frozen.allowed_delegation.contains(tool))
    }
    fn physical_tool(&self, name: &str) -> bool {
        self.host_tool(name).is_none() && physical_tool(name)
    }
    /// Resolve only an already authenticated configuration snapshot. Executable declarations
    /// are still assembled and checked by their owning tool directory in the kernel.
    pub fn resolve(&self, input: &DispatchInput) -> Result<ResolvedChildSelection> {
        input.validate()?;
        let (mut tools, mode, instructions, model) = if let Some(id) = &input.preset {
            let preset = self
                .catalog
                .presets
                .iter()
                .find(|preset| &preset.id == id)
                .ok_or_else(|| {
                    RuntimeError::Invalid(format!("child preset {id} is not selected"))
                })?;
            if let Some(failure) = &preset.unavailable {
                return Err(RuntimeError::Invalid(format!(
                    "child preset unavailable: {} ({})",
                    failure.code,
                    failure.capabilities.join(", ")
                )));
            }
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
                preset.tools.clone(),
                input.work_mode.unwrap_or(preset.work_mode),
                preset.instructions.clone(),
                preset
                    .model
                    .clone()
                    .unwrap_or_else(|| self.frozen.parent_model.clone()),
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
            if input.work_mode == Some(ChildWorkMode::ReadOnly) {
                tools.retain(|name| !self.physical_tool(name));
            }
            if input.work_mode == Some(ChildWorkMode::IsolatedWrite) {
                for name in ["file_write", "file_edit"] {
                    if !tools.iter().any(|tool| tool == name) {
                        tools.push(name.into());
                    }
                }
            }
            let mode = input.work_mode.unwrap_or_else(|| {
                if tools.iter().any(|name| self.physical_tool(name)) {
                    ChildWorkMode::IsolatedWrite
                } else {
                    ChildWorkMode::ReadOnly
                }
            });
            (tools, mode, String::new(), self.frozen.parent_model.clone())
        };
        if let Some(selected) = &input.tools {
            if selected.iter().any(|name| !tools.contains(name)) {
                return Err(RuntimeError::Invalid(
                    "requested child tools exceed the frozen delegation".into(),
                ));
            }
            tools = selected.clone();
        }
        let mode = if input.preset.is_none() && input.work_mode.is_none() {
            if tools.iter().any(|name| self.physical_tool(name)) {
                ChildWorkMode::IsolatedWrite
            } else {
                ChildWorkMode::ReadOnly
            }
        } else {
            mode
        };
        if mode == ChildWorkMode::ReadOnly && tools.iter().any(|name| self.physical_tool(name)) {
            return Err(RuntimeError::Invalid(
                "selected child effects require a private physical source".into(),
            ));
        }
        tools.sort();
        model.connection_identity()?;
        Ok(ResolvedChildSelection {
            frozen_reference: self.reference.clone(),
            catalog_ref: self.frozen.catalog_ref.clone(),
            model,
            tool_schema_generation: self.frozen.tool_schema_generation,
            parent_tools_ref: self.frozen.tools_ref.clone(),
            mcp_binding: self
                .mcp_binding
                .as_ref()
                .and_then(|binding| binding.delegate(&tools)),
            extension_bindings: self
                .extension_bindings
                .iter()
                .filter(|binding| tools.contains(&binding.tool.name))
                .cloned()
                .collect(),
            profile: ChildSelectedProfile {
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
            serde_json::from_value(self.content.load(&frozen.catalog_ref)?)?;
        catalog.validate()?;
        frozen.parent_model.connection_identity()?;
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
    pub fn load(self) -> Result<ChildDispatchSelection> {
        use crate::execution::{RequestSnapshot, ToolOrigin};
        let value = self.content.load(&self.body)?;
        let reference = match &self.context.origin {
            ToolOrigin::ModelStep { request_id } => {
                let snapshot: RequestSnapshot = serde_json::from_value(value)?;
                if snapshot.view.request_id != *request_id
                    || snapshot.view.run_id != self.context.run_id
                {
                    return Err(RuntimeError::Invalid(
                        "dispatch request belongs to another origin".into(),
                    ));
                }
                snapshot.view.binding.child_dispatch
            }
            ToolOrigin::PolicyAction { action_id, node_id } => {
                let body: super::policy_body::PolicyGraphBody = serde_json::from_value(value)?;
                if body.action_id != *action_id {
                    return Err(RuntimeError::Invalid(
                        "dispatch graph belongs to another origin".into(),
                    ));
                }
                body.nodes
                    .into_iter()
                    .find(|node| node.node.id == *node_id)
                    .ok_or_else(|| RuntimeError::NotFound("dispatch graph node".into()))?
                    .child_dispatch
            }
        }
        .ok_or_else(|| {
            RuntimeError::Invalid("dispatch has no frozen configuration selection".into())
        })?;
        ChildDispatchRead {
            reference,
            content: self.content,
            _publication: self._publication,
        }
        .load()
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
        let reference = self
            .selection
            .child_dispatch_ref
            .clone()
            .map(|catalog_ref| {
                let catalog: ChildDispatchCatalog =
                    serde_json::from_value(self.content.load(&catalog_ref)?)?;
                catalog.validate()?;
                self.content
                    .save(&serde_json::to_value(FrozenChildDispatch {
                        catalog_ref,
                        parent_model: self.model.clone(),
                        allowed_delegation: self.allowed_delegation,
                        tool_schema_generation: self.selection.tool_schema_generation,
                        tools_ref: self.selection.tools_ref.clone(),
                        mcp_binding_ref: self.selection.mcp_binding_ref.clone(),
                        extension_bindings_ref: self.selection.extension_bindings_ref.clone(),
                    })?)
            })
            .transpose()?;
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
        let body = match &context.origin {
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
        use super::collaboration::{ChildCodeResult, ChildReport, ChildTask};
        use std::collections::BTreeSet;
        let tx = self.db.transaction()?;
        let root = match &target {
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
                let child: ChildTask = record(&tx, "child_tasks", operation_id)?;
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
            rows.map(|row| Ok(serde_json::from_str::<ChildTask>(&row?)?))
                .collect::<Result<Vec<_>>>()?
        };
        // Fixed point over the original lineage, with no artificial depth limit. This lock
        // also fences new descendants until their original parent Run is cancelled below.
        loop {
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
        let children = children
            .into_iter()
            .filter(|child| threads.contains(&child.child_thread_id))
            .collect::<Vec<_>>();
        let runs = {
            let mut statement = tx.prepare("SELECT body FROM runs ORDER BY id")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.map(|row| Ok(serde_json::from_str::<Run>(&row?)?))
                .collect::<Result<Vec<_>>>()?
        };
        let runs = runs
            .into_iter()
            .filter(|run| threads.contains(&run.thread_id))
            .collect::<Vec<_>>();
        let run_ids = runs.iter().map(|run| run.id.clone()).collect::<Vec<_>>();
        for run in &runs {
            super::request_cancel_run_in(&tx, &run.id)?;
            // Terminal source Runs can still own live process-trigger registrations. Cancel
            // those original registrations without changing the source Run's terminal fact.
            super::followups::cancel_tree_source_run(&tx, &run.id)?;
            super::goals::cancel_run(&tx, &run.id)?;
        }
        let mut process_ids = Vec::new();
        for run in &runs {
            let ids = {
                let mut statement = tx.prepare("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.executor')='process_spawn' AND json_extract(body,'$.execution_owner.kind')='kernel' AND coalesce(json_extract(body,'$.external_receipt.executor_stopped'),0)=0 ORDER BY id")?;
                let rows = statement.query_map([&run.id], |row| row.get::<_, String>(0))?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            };
            for id in ids {
                super::request_cancel_operation_in(&tx, &id)?;
                process_ids.push(id);
            }
        }
        for mut child in children.iter().cloned() {
            super::request_cancel_operation_in(&tx, &child.operation_id)?;
            if child.receipt.is_none() && child.report.is_none() {
                child.state = "cancelled".into();
                if !child.code_result.settled() {
                    child.code_result = ChildCodeResult::Unavailable {
                        code: "cancelled_before_launch".into(),
                        effect: Effect::None,
                    };
                }
                child.report = Some(ChildReport {
                    outcome: Outcome::Cancelled,
                    sender_thread_id: child.child_thread_id.clone(),
                    run_id: None,
                    history_ids: Vec::new(),
                    detail: Some("Child preparation was cancelled before launch.".into()),
                });
                child.revision += 1;
                put(&tx, "child_tasks", &child.operation_id, &child)?;
                event(
                    &tx,
                    &child.operation_id,
                    child.revision,
                    "child.report_ready",
                    json!({"sender_thread_id":child.child_thread_id,"outcome":"cancelled"}),
                )?;
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
