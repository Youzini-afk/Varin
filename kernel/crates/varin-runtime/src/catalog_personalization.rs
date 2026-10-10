//! A refresh replaces only the contextual system snapshot, never conversation history or a
//! prepared/dispatched model request. Ordinary notes remain owned by agent.personalization.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemSection {
    pub name: String,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonalizationBasis {
    pub mode: String,
    pub thread_role: String,
    pub revision: u64,
    pub configuration_digest: String,
    pub memory_snapshot: super::memory::MemorySnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_composition: Option<crate::composition::context::ContextComposition>,
    pub session_id: String,
    pub project_id: Option<String>,
    pub original_sections: Vec<SystemSection>,
    pub instruction_sources: Vec<String>,
}
impl PersonalizationBasis {
    pub(super) fn same_scope_and_source(&self, other: &Self) -> bool {
        self.mode == other.mode && self.thread_role == other.thread_role
            && self.session_id == other.session_id && self.project_id == other.project_id
            && self.original_sections == other.original_sections
            && self.instruction_sources == other.instruction_sources
    }
    pub(super) fn validate(&self) -> Result<()> {
        if !matches!(self.mode.as_str(), "agent" | "bot")
            || !matches!(self.thread_role.as_str(), "main" | "worker" | "read-only") {
            return Err(RuntimeError::Invalid("personalization admission role is invalid".into()));
        }
        if self.configuration_digest.is_empty() { return Err(RuntimeError::Invalid("personalization configuration identity is missing".into())); }
        for note in &self.memory_snapshot.memories {
            super::memory::note_id(note)?;
            if !super::memory::allowed(self, &note["scope"]) { return Err(RuntimeError::Invalid("memory snapshot contains another scope".into())); }
        }
        if let Some(composition) = &self.context_composition {
            composition.validate().map_err(RuntimeError::Invalid)?;
            if composition.scope_id != self.session_id {
                return Err(RuntimeError::Invalid("context composition belongs to another session scope".into()));
            }
        }
        if self.session_id.is_empty() || self.original_sections.iter().any(|section| section.name.is_empty()) {
            return Err(RuntimeError::Invalid("personalization basis needs explicit scope and section identities".into()));
        }
        // Project IDs participate in the existing service-routing identity contract. An absent
        // project is None; accept only the canonical, non-empty IDs supplied by the project owner.
        // The Host's JavaScript trim also removes edge U+FEFF, which Rust str::trim preserves.
        // Reject that noncanonical edge spelling without changing opaque interior characters.
        if self.project_id.as_ref().is_some_and(|project| project.trim().is_empty()
            || project.trim() != project || project.starts_with('\u{feff}') || project.ends_with('\u{feff}')) {
            return Err(RuntimeError::Invalid("personalization project identity must be canonical and non-empty".into()));
        }
        let mut names = std::collections::HashSet::new();
        if self.original_sections.iter().any(|section| !names.insert(&section.name)) {
            return Err(RuntimeError::Invalid("personalization basis repeats a system section".into()));
        }
        Ok(())
    }
}
impl Catalog {
    /// CAS against the active context, preserving its compacted prefix and original tail.
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn refresh_personalization(
        &mut self,
        branch_id: &str,
        expected_revision: u64,
        effective_system_prompt: String,
        instruction_sources: Vec<String>,
        memory_checkpoint: Option<String>,
        personalization: PersonalizationBasis,
    ) -> Result<context::ContextCheckpoint> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self.prepare_personalization_refresh(branch_id,expected_revision,effective_system_prompt,
            instruction_sources,memory_checkpoint,personalization)?.load()?;
        self.publish_personalization_refresh(prepared)
    }
    pub fn prepare_personalization_refresh(&self, branch_id: &str, expected_revision: u64,
        effective_system_prompt: String, instruction_sources: Vec<String>, memory_checkpoint: Option<String>,
        personalization: PersonalizationBasis) -> Result<PersonalizationRefresh> {
        let current = self.capture_active_checkpoint(branch_id)?.ok_or_else(|| RuntimeError::Conflict("context has not been initialized".into()))?;
        Ok(PersonalizationRefresh {current,content:self.content.clone(),branch_id:branch_id.into(),expected_revision,
            effective_system_prompt,instruction_sources,memory_checkpoint,personalization,resources:None,_publication:self.content.begin_publication()})
    }
    pub fn publish_personalization_refresh(&mut self, prepared: PreparedPersonalizationRefresh) -> Result<context::ContextCheckpoint> {
        let current: Option<String> = self.db.query_row("SELECT checkpoint_id FROM active_contexts WHERE branch_id=?1",
            [&prepared.checkpoint.proposal.branch_id],|row|row.get(0)).optional()?;
        if current.as_deref() != Some(prepared.previous_id.as_str()) { return Err(RuntimeError::Conflict("active context checkpoint changed".into())); }
        if !prepared.unchanged {
            let tx = self.db.transaction()?;
            context::publish_prepared(&tx, &prepared.checkpoint, &prepared.reference)?;
            tx.commit()?;
        }
        Ok(prepared.checkpoint)
    }
}

pub struct PersonalizationRefresh {
    current: context::CheckpointRead,
    content: crate::content::ContentStore,
    branch_id: String, expected_revision: u64, effective_system_prompt: String, instruction_sources: Vec<String>,
    memory_checkpoint: Option<String>, personalization: PersonalizationBasis,
    resources: Option<Option<super::resources::ContextResources>>,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedPersonalizationRefresh {
    previous_id: String, checkpoint: context::ContextCheckpoint, reference: Value, unchanged: bool,
    _publication: crate::content::ContentPublication,
}
impl PersonalizationRefresh {
    pub fn require_resources(mut self, resources: Option<super::resources::ContextResources>) -> Self {
        self.resources = Some(resources);
        self
    }
    pub fn load(self) -> Result<PreparedPersonalizationRefresh> {
        let Self {current,content,branch_id,expected_revision,effective_system_prompt,instruction_sources,memory_checkpoint,personalization,resources,_publication} = self;
        personalization.validate()?;
        if !instruction_sources.starts_with(&personalization.instruction_sources) {
            return Err(RuntimeError::Conflict("personalization refresh omitted frozen instruction identities".into()));
        }
        let current = current.load()?;
        if resources.as_ref().is_some_and(|resources| resources != &current.resources) {
            return Err(RuntimeError::Conflict("ordinary personalization refresh cannot change resources".into()));
        }
        let previous = current.personalization.as_ref().ok_or_else(|| RuntimeError::Invalid("context has no owned personalization basis".into()))?;
        if !previous.same_scope_and_source(&personalization) {
            return Err(RuntimeError::Conflict("personalization scope or frozen instruction source changed".into()));
        }
        if personalization.memory_snapshot != previous.memory_snapshot || memory_checkpoint != current.proposal.memory_checkpoint {
            return Err(RuntimeError::Conflict("ordinary refresh cannot replace the memory snapshot".into()));
        }
        if personalization.revision < previous.revision {
            return Err(RuntimeError::Conflict("personalization revision moved backwards".into()));
        }
        if current.proposal.effective_system_prompt == effective_system_prompt
            && current.proposal.instruction_sources == instruction_sources
            && current.proposal.memory_checkpoint == memory_checkpoint
            && previous == &personalization {
            return Ok(PreparedPersonalizationRefresh {previous_id:current.id.clone(),checkpoint:current,reference:Value::Null,unchanged:true,_publication});
        }
        if current.revision != expected_revision {
            return Err(RuntimeError::Conflict("active context checkpoint changed".into()));
        }
        if personalization.revision == previous.revision
            && (current.proposal.effective_system_prompt != effective_system_prompt
                || current.proposal.instruction_sources != instruction_sources
                || current.proposal.memory_checkpoint != memory_checkpoint
                || personalization.context_composition == previous.context_composition) {
            return Err(RuntimeError::Conflict("personalization content changed without a new committed revision".into()));
        }
        let proposal = context::ContextProposal {
            key: format!("personalization:{branch_id}:{}", current.revision.checked_add(1).ok_or_else(|| RuntimeError::Invalid("context revision exhausted".into()))?),
            branch_id, through_id: current.proposal.through_id,
            expected_revision, summary: current.proposal.summary,
            effective_system_prompt, instruction_sources, memory_checkpoint,
        };
        let checkpoint = context::ContextCheckpoint {id:proposal.key.clone(),revision:current.revision+1,proposal,personalization:Some(personalization),resources:current.resources};
        let reference = content.save(&serde_json::to_value(&checkpoint)?)?;
        Ok(PreparedPersonalizationRefresh {previous_id:current.id,checkpoint,reference,unchanged:false,_publication})
    }
}
