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
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_composition: Option<crate::composition::context::ContextComposition>,
    pub session_id: String,
    pub project_id: Option<String>,
    pub original_sections: Vec<SystemSection>,
    pub instruction_sources: Vec<String>,
}
impl PersonalizationBasis {
    pub(super) fn same_scope_and_source(&self, other: &Self) -> bool {
        self.session_id == other.session_id && self.project_id == other.project_id
            && self.original_sections == other.original_sections
            && self.instruction_sources == other.instruction_sources
    }
    pub(super) fn validate(&self) -> Result<()> {
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
    pub fn refresh_personalization(
        &mut self,
        branch_id: &str,
        expected_revision: u64,
        effective_system_prompt: String,
        instruction_sources: Vec<String>,
        memory_checkpoint: Option<String>,
        personalization: PersonalizationBasis,
    ) -> Result<context::ContextCheckpoint> {
        personalization.validate()?;
        if !instruction_sources.starts_with(&personalization.instruction_sources) {
            return Err(RuntimeError::Conflict("personalization refresh omitted frozen instruction identities".into()));
        }
        let current = self.active_context(branch_id)?.ok_or_else(|| RuntimeError::Conflict("context has not been initialized".into()))?;
        let previous = current.personalization.as_ref().ok_or_else(|| RuntimeError::Invalid("context has no owned personalization basis".into()))?;
        if !previous.same_scope_and_source(&personalization) {
            return Err(RuntimeError::Conflict("personalization scope or frozen instruction source changed".into()));
        }
        if personalization.revision < previous.revision {
            return Err(RuntimeError::Conflict("personalization revision moved backwards".into()));
        }
        if current.proposal.effective_system_prompt == effective_system_prompt
            && current.proposal.instruction_sources == instruction_sources
            && current.proposal.memory_checkpoint == memory_checkpoint
            && previous == &personalization {
            return Ok(current);
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
            branch_id: branch_id.into(), through_id: current.proposal.through_id,
            expected_revision, summary: current.proposal.summary,
            effective_system_prompt, instruction_sources, memory_checkpoint,
        };
        let (checkpoint, reference) = self.stage_context_with_personalization(proposal, Some(personalization))?;
        let tx = self.db.transaction()?;
        context::publish_prepared(&tx, &checkpoint, &reference)?;
        tx.commit()?;
        Ok(checkpoint)
    }
}
