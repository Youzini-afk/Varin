//! Host-selected instruction and skill snapshots live in the ordinary context object.
//! The Host owns discovery and path selection; Catalog owns exact checkpoint/call binding.
use super::*;
use crate::execution::{RequestSnapshot, ToolOrigin};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceReference {
    pub domain_id: String,
    pub view_id: String,
    pub path: String,
    pub canonical_id: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLocation {
    pub domain_id: String,
    pub view_id: String,
    pub path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedResource {
    pub reference: ResourceReference,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResourceScope {
    pub thread_id: String,
    pub branch_id: String,
    pub mode: String,
    pub thread_role: String,
    pub project_id: Option<String>,
    pub source_identity: Option<String>,
    pub cwd: String,
    pub project_trusted: bool,
    pub project_root: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResourceReader {
    pub domain_id: String,
    pub view_id: String,
    pub consistency: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResourceProject {
    pub domain_id: String,
    pub view_id: String,
    pub cwd: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionEntry {
    pub origin: String,
    pub kind: String,
    pub applies_to: Option<String>,
    pub reference: ResourceReference,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionScope {
    pub directory: String,
    pub instructions: Vec<InstructionEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub disable_model_invocation: bool,
    pub requires_project_trust: bool,
    pub origin: String,
    pub reference: ResourceReference,
    pub base_path: String,
    pub base_canonical_id: String,
    pub priority: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_identity: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDiagnostic {
    pub kind: String,
    pub message: String,
    pub location: ResourceLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub winner: Option<ResourceReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceObservation {
    pub domain_id: String,
    pub view_id: String,
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResourceSnapshot {
    pub id: String,
    pub scope: AgentResourceScope,
    pub readers: Vec<AgentResourceReader>,
    pub project: Option<AgentResourceProject>,
    pub configuration_digest: String,
    pub shadowed_context_canonical_ids: Vec<String>,
    pub system: Option<InstructionEntry>,
    pub append_system: Option<InstructionEntry>,
    pub instructions: Vec<InstructionEntry>,
    pub instruction_scopes: Vec<InstructionScope>,
    pub skills: Vec<SkillDescriptor>,
    pub diagnostics: Vec<ResourceDiagnostic>,
    pub captured_files: Vec<CapturedResource>,
    pub observations: Vec<ResourceObservation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextResources {
    pub source: Option<super::launches::SourceSelection>,
    pub snapshot: AgentResourceSnapshot,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ResourceRequest {
    #[serde(rename = "skill")]
    Skill {
        #[serde(rename = "activationId", skip_serializing_if = "Option::is_none")]
        activation_id: Option<String>,
        #[serde(rename = "resourceId")]
        resource_id: String,
    },
    #[serde(rename = "skill-resource")]
    SkillResource {
        #[serde(rename = "activationId", skip_serializing_if = "Option::is_none")]
        activation_id: Option<String>,
        #[serde(rename = "resourceId")]
        resource_id: String,
        #[serde(rename = "relativePath")]
        relative_path: String,
    },
    #[serde(rename = "instruction-scope")]
    InstructionScope {
        #[serde(rename = "targetPath")]
        target_path: String,
        #[serde(rename = "targetType", skip_serializing_if = "Option::is_none")]
        target_type: Option<ResourceTargetType>,
    },
}
impl ResourceRequest {
    pub fn activation_id(&self) -> Option<&str> {
        match self { Self::Skill { activation_id, .. } | Self::SkillResource { activation_id, .. } => activation_id.as_deref(), _ => None }
    }
    pub fn resource_id(&self) -> Option<&str> {
        match self { Self::Skill { resource_id, .. } | Self::SkillResource { resource_id, .. } => Some(resource_id), _ => None }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ResourceTargetType {
    File,
    Directory,
}
impl ContextResources {
    pub(super) fn validate(
        &self,
        basis: &super::personalization::PersonalizationBasis,
    ) -> Result<()> {
        if let Some(source) = &self.source {
            source.validate()?;
        }
        let scope = &self.snapshot.scope;
        if self.snapshot.id.is_empty()
            || self.snapshot.configuration_digest.is_empty()
            || scope.branch_id.is_empty()
            || scope.thread_id != basis.session_id
            || scope.mode != basis.mode
            || scope.thread_role != basis.thread_role
            || scope.project_id != basis.project_id
            || scope.source_identity.as_ref().is_some_and(String::is_empty)
            || self.source.is_some() != scope.source_identity.is_some()
        {
            return Err(RuntimeError::Conflict(
                "resource snapshot does not match its admitted context scope".into(),
            ));
        }
        let mut readers = std::collections::BTreeSet::new();
        for reader in &self.snapshot.readers {
            if reader.domain_id.is_empty()
                || reader.view_id.is_empty()
                || !matches!(reader.consistency.as_str(), "immutable" | "capture-only")
                || !readers.insert((&reader.domain_id, &reader.view_id))
            {
                return Err(RuntimeError::Invalid(
                    "resource snapshot has invalid or repeated readers".into(),
                ));
            }
        }
        let mut captured = std::collections::BTreeMap::new();
        for file in &self.snapshot.captured_files {
            let reference = &file.reference;
            if !readers.contains(&(&reference.domain_id, &reference.view_id))
                || reference.canonical_id.is_empty()
                || reference.version.is_empty()
                || captured
                    .insert(
                        (&reference.domain_id, &reference.view_id, &reference.path),
                        reference,
                    )
                    .is_some()
            {
                return Err(RuntimeError::Invalid(
                    "resource capture does not identify one admitted view".into(),
                ));
            }
        }
        // Descriptor bytes must be retained, not an unowned content reference supplied by the Host.
        let references = self
            .snapshot
            .instructions
            .iter()
            .chain(self.snapshot.system.iter())
            .chain(self.snapshot.append_system.iter())
            .chain(
                self.snapshot
                    .instruction_scopes
                    .iter()
                    .flat_map(|scope| &scope.instructions),
            )
            .map(|entry| &entry.reference)
            .chain(self.snapshot.skills.iter().map(|skill| &skill.reference));
        for reference in references {
            if captured
                .get(&(&reference.domain_id, &reference.view_id, &reference.path))
                .copied()
                != Some(reference)
            {
                return Err(RuntimeError::Invalid(
                    "resource descriptor has no exact captured body".into(),
                ));
            }
        }
        Ok(())
    }
}

pub struct ResourceRefresh {
    current: context::CheckpointRead,
    content: crate::content::ContentStore,
    epoch: u64,
    expected_revision: u64,
    effective_system_prompt: String,
    instruction_sources: Vec<String>,
    memory_checkpoint: Option<String>,
    personalization: personalization::PersonalizationBasis,
    resources: ContextResources,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedResourceRefresh {
    previous_id: String,
    epoch: u64,
    checkpoint: context::ContextCheckpoint,
    reference: Value,
    unchanged: bool,
    _publication: crate::content::ContentPublication,
}
impl Catalog {
    pub fn prepare_resource_refresh(
        &self,
        branch_id: &str,
        expected_revision: u64,
        effective_system_prompt: String,
        instruction_sources: Vec<String>,
        memory_checkpoint: Option<String>,
        personalization: personalization::PersonalizationBasis,
        resources: ContextResources,
    ) -> Result<ResourceRefresh> {
        let current = self
            .capture_active_checkpoint(branch_id)?
            .ok_or_else(|| RuntimeError::Conflict("context has not been initialized".into()))?;
        Ok(ResourceRefresh {
            current,
            content: self.content.clone(),
            epoch: self.epoch,
            expected_revision,
            effective_system_prompt,
            instruction_sources,
            memory_checkpoint,
            personalization,
            resources,
            _publication: self.content.begin_publication(),
        })
    }
    pub fn publish_resource_refresh(
        &mut self,
        prepared: PreparedResourceRefresh,
    ) -> Result<context::ContextCheckpoint> {
        if prepared.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "resource preparation belongs to a previous owner".into(),
            ));
        }
        let current: Option<String> = self
            .db
            .query_row(
                "SELECT checkpoint_id FROM active_contexts WHERE branch_id=?1",
                [&prepared.checkpoint.proposal.branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() != Some(&prepared.previous_id) {
            return Err(RuntimeError::Conflict(
                "active context checkpoint changed".into(),
            ));
        }
        if !prepared.unchanged {
            let tx = self.db.transaction()?;
            context::publish_prepared(&tx, &prepared.checkpoint, &prepared.reference)?;
            tx.commit()?;
        }
        Ok(prepared.checkpoint)
    }
}
impl ResourceRefresh {
    pub fn load(self) -> Result<PreparedResourceRefresh> {
        let Self {
            current,
            content,
            epoch,
            expected_revision,
            effective_system_prompt,
            instruction_sources,
            memory_checkpoint,
            personalization,
            resources,
            _publication,
        } = self;
        let current = current.load()?;
        let previous = current.personalization.as_ref().ok_or_else(|| {
            RuntimeError::Invalid("resource refresh requires an owned context scope".into())
        })?;
        personalization.validate()?;
        resources.validate(&personalization)?;
        if resources.snapshot.scope.branch_id != current.proposal.branch_id {
            return Err(RuntimeError::Conflict(
                "resource refresh belongs to another branch".into(),
            ));
        }
        if current.revision != expected_revision {
            return Err(RuntimeError::Conflict(
                "active context checkpoint changed".into(),
            ));
        }
        if context::ContextScope::from(previous) != context::ContextScope::from(&personalization)
            || previous.memory_snapshot != personalization.memory_snapshot
            || current.proposal.memory_checkpoint != memory_checkpoint
            || previous.revision != personalization.revision
            || previous.configuration_digest != personalization.configuration_digest
            || previous.context_composition != personalization.context_composition
        {
            return Err(RuntimeError::Conflict(
                "resource refresh changed personalization or memory ownership".into(),
            ));
        }
        if !instruction_sources.starts_with(&personalization.instruction_sources) {
            return Err(RuntimeError::Conflict(
                "resource refresh omitted its selected instruction identities".into(),
            ));
        }
        let old = current.resources.as_ref().ok_or_else(|| {
            RuntimeError::Conflict(
                "resource refresh requires an existing frozen resource source".into(),
            )
        })?;
        let old_scope = &old.snapshot.scope;
        let scope = &resources.snapshot.scope;
        if old.source != resources.source
            || old_scope.source_identity != scope.source_identity
            || old_scope.cwd != scope.cwd
        {
            return Err(RuntimeError::Conflict(
                "resource refresh changed its admitted source scope".into(),
            ));
        }
        let unchanged = current.resources.as_ref() == Some(&resources)
            && current.personalization.as_ref() == Some(&personalization)
            && current.proposal.effective_system_prompt == effective_system_prompt
            && current.proposal.instruction_sources == instruction_sources;
        if unchanged {
            return Ok(PreparedResourceRefresh {
                previous_id: current.id.clone(),
                epoch,
                checkpoint: current,
                reference: Value::Null,
                unchanged: true,
                _publication,
            });
        }
        let revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::Invalid("context revision exhausted".into()))?;
        let proposal = context::ContextProposal {
            key: format!("resources:{}:{revision}", current.proposal.branch_id),
            branch_id: current.proposal.branch_id,
            through_id: current.proposal.through_id,
            expected_revision,
            summary: current.proposal.summary,
            effective_system_prompt,
            instruction_sources,
            memory_checkpoint,
        };
        let checkpoint = context::ContextCheckpoint {
            resource_activations: current.resource_activations,
            id: proposal.key.clone(),
            revision,
            proposal,
            personalization: Some(personalization),
            resources: Some(resources),
        };
        let reference = content.save(&serde_json::to_value(&checkpoint)?)?;
        Ok(PreparedResourceRefresh {
            previous_id: current.id,
            epoch,
            checkpoint,
            reference,
            unchanged: false,
            _publication,
        })
    }
}

enum ResourceCallRead {
    Model {
        request: super::tool_content::ModelStepRead,
        call: super::tool_content::ToolCallMetadata,
    },
    Policy {
        metadata: super::policy_body::PolicyActionMetadata,
        node_id: String,
        call_id: String,
    },
}
pub struct ResourceSnapshotRead {
    pub epoch: u64,
    activation_id: Option<String>,
    database: std::path::PathBuf,
    head: Option<String>,
    run: Run,
    checkpoint: context::CheckpointRead,
    origin: ResourceCallRead,
    content: crate::content::ContentStore,
    scope: context::ContextScope,
}
impl Catalog {
    pub fn validate_resource_snapshot_owner(
        &self,
        run_id: &str,
        epoch: u64,
        origin: &ToolOrigin,
    ) -> Result<()> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        if run.cancel_requested || epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "resource call owner is no longer active".into(),
            ));
        }
        if let ToolOrigin::PolicyAction { action_id, .. } = origin {
            let operation = self.operation(action_id)?;
            if operation.run_id != run_id
                || operation.cancel_requested
                || operation.phase == OperationPhase::Terminal
            {
                return Err(RuntimeError::Conflict(
                    "resource policy owner is no longer active".into(),
                ));
            }
        }
        Ok(())
    }
    /// Capture immutable references under Catalog; validate bodies and hydrate after releasing it.
    pub fn capture_resource_snapshot(
        &self,
        run_id: &str,
        origin: &ToolOrigin,
        call_id: &str,
        checkpoint_id: &str,
        activation_id: Option<&str>,
    ) -> Result<ResourceSnapshotRead> {
        self.validate_resource_snapshot_owner(run_id, self.epoch, origin)?;
        let run = self.run(run_id)?;
        let scope = self
            .run_context_scope(run_id)?
            .ok_or_else(|| RuntimeError::Conflict("resource call has no admitted scope".into()))?;
        let checkpoint = self
            .capture_checkpoint(
                "SELECT id,revision,body,scope FROM context_checkpoints WHERE id=?1",
                checkpoint_id,
            )?
            .ok_or_else(|| RuntimeError::NotFound(checkpoint_id.into()))?;
        let origin = match origin {
            ToolOrigin::ModelStep { request_id } => {
                let request = self.capture_model_step_read(request_id)?;
                if request.metadata.run_id != run_id {
                    return Err(RuntimeError::Conflict(
                        "resource request belongs to another Run".into(),
                    ));
                }
                let raw: String = self
                    .db
                    .query_row(
                        "SELECT body FROM tool_calls WHERE request_id=?1 AND call_id=?2",
                        params![request_id, call_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(|| RuntimeError::NotFound(call_id.into()))?;
                let call: super::tool_content::ToolCallMetadata = serde_json::from_str(&raw)?;
                if call.name != "resource_read" || call.call_id != call_id {
                    return Err(RuntimeError::Conflict(
                        "resource snapshot requires its original resource tool call".into(),
                    ));
                }
                ResourceCallRead::Model { request, call }
            }
            ToolOrigin::PolicyAction { action_id, node_id } => {
                let operation = self.operation(action_id)?;
                if operation.run_id != run_id || operation.cancel_requested {
                    return Err(RuntimeError::Conflict(
                        "resource policy call owner changed".into(),
                    ));
                }
                let metadata = super::policy::graph_metadata(&operation)?.ok_or_else(|| {
                    RuntimeError::Invalid("resource origin is not a policy graph".into())
                })?;
                ResourceCallRead::Policy {
                    metadata,
                    node_id: node_id.clone(),
                    call_id: call_id.into(),
                }
            }
        };
        Ok(ResourceSnapshotRead {
            activation_id: activation_id.map(str::to_owned),
            database: self.db.path().ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?.into(),
            head: self.head(&run.branch_id)?,
            epoch: self.epoch,
            run,
            checkpoint,
            origin,
            content: self.content.clone(),
            scope,
        })
    }
}
impl ResourceSnapshotRead {
    pub fn load(self) -> Result<ContextResources> {
        let checkpoint_id = self.checkpoint.id.clone();
        let (default_checkpoint, bindings, request) = match self.origin {
            ResourceCallRead::Model { request, call } => {
                let request_id = request.metadata.id.clone();
                let snapshot: RequestSnapshot = serde_json::from_value(request.load_request()?)?;
                if snapshot.view.run_id != self.run.id || snapshot.view.request_id != request_id
                    || call.schema_version != "2"
                    || !snapshot.view.binding.tools.iter().any(|schema| schema.name == call.name && schema.version == call.schema_version)
                    || snapshot.view.binding.resource_activations != retained_activations(&snapshot.view.history)
                {
                    return Err(RuntimeError::Conflict("resource snapshot differs from the frozen ModelStep".into()));
                }
                let call = call.load(&self.content)?;
                (snapshot.view.binding.resource_checkpoint_id, snapshot.view.binding.resource_activations,
                    serde_json::from_value::<ResourceRequest>(call.arguments)?)
            }
            ResourceCallRead::Policy { metadata, node_id, call_id } => {
                let graph = metadata.load_graph(&self.content, &self.run.id)?;
                let node = graph.nodes().iter().find(|node| node.node.id == node_id)
                    .ok_or_else(|| RuntimeError::NotFound(node_id))?;
                if node.node.call.name != "resource_read" || node.node.call.call_id != call_id
                    || node.node.call.schema_version != "2"
                    || !node.context.tools.iter().any(|schema| schema.name == node.node.call.name && schema.version == node.node.call.schema_version)
                {
                    return Err(RuntimeError::Conflict("resource snapshot differs from the frozen policy call".into()));
                }
                (node.context.resource_checkpoint_id.clone(), node.context.resource_activations.clone(),
                    serde_json::from_value::<ResourceRequest>(node.node.call.arguments.clone())?)
            }
        };
        if request.activation_id() != self.activation_id.as_deref() {
            return Err(RuntimeError::Conflict("resource selector differs from the original tool call".into()));
        }
        let activation = if let Some(id) = self.activation_id.as_deref() {
            let binding = bindings.iter().find(|binding| binding.activation_id == id)
                .ok_or_else(|| RuntimeError::Conflict("resource activation is not retained by this invocation".into()))?;
            if binding.resource_checkpoint_id != checkpoint_id || Some(binding.resource_id.as_str()) != request.resource_id()
                || bindings.iter().filter(|binding| binding.activation_id == id).count() != 1 {
                return Err(RuntimeError::Conflict("resource activation differs from its frozen selection".into()));
            }
            let database = Connection::open_with_flags(&self.database,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
            let visible: bool = database.query_row("WITH RECURSIVE ancestors(id,parent) AS (SELECT id,parent FROM history WHERE id=?1 UNION ALL SELECT h.id,h.parent FROM history h JOIN ancestors a ON h.id=a.parent) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)",
                params![self.head, binding.input_id], |row| row.get(0))?;
            if !visible { return Err(RuntimeError::Conflict("resource activation input is not a branch ancestor".into())); }
            let input: HistoryItem = record(&database, "history", &binding.input_id)?;
            if input.thread_id != self.run.thread_id || input.source != HistorySource::User {
                return Err(RuntimeError::Conflict("resource activation belongs to another input owner".into()));
            }
            let input = self.content.hydrate_history(input)?;
            if !invocations(&input.content)?.iter().any(|entry| entry.binding(&binding.input_id) == *binding) {
                return Err(RuntimeError::Conflict("resource activation is not proved by its original input".into()));
            }
            Some(binding)
        } else {
            if default_checkpoint.as_deref() != Some(&checkpoint_id) {
                return Err(RuntimeError::Conflict("resource snapshot differs from the frozen invocation".into()));
            }
            None
        };
        let checkpoint = self.checkpoint.load()?;
        if (activation.is_none() && checkpoint.proposal.branch_id != self.run.branch_id)
            || checkpoint.personalization.as_ref().map(context::ContextScope::from).as_ref() != Some(&self.scope)
        {
            return Err(RuntimeError::Conflict("resource checkpoint belongs to another admitted scope".into()));
        }
        let resources = checkpoint.resources.ok_or_else(|| RuntimeError::NotFound("resource snapshot is not bound".into()))?;
        if let Some(binding) = activation {
            if resources.snapshot.id != binding.snapshot_id || !resources.snapshot.skills.iter().any(|skill|
                skill.id == binding.resource_id && skill.reference == binding.reference) {
                return Err(RuntimeError::Conflict("resource activation source differs from its checkpoint".into()));
            }
        }
        Ok(resources)
    }
}

#[path = "catalog_input_resources.rs"]
mod inputs;
pub use inputs::{InputResourcePreparation, PreparedExplicitSkill, ResourceActivation, retained_activations};
pub(super) use inputs::{bind_input, input_text, invocations, preserve, validate_raw_input};
