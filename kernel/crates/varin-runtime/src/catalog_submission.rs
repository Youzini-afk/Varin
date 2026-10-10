//! Input bodies are prepared outside the Catalog owner; admission commits only their references.
use super::*;

pub struct SubmissionPreparation {
    existing: Option<(Value, Receipt)>,
    expected_context_checkpoint: Option<String>,
    current: Option<context::CheckpointRead>,
    scope: Option<context::ContextScope>,
    command: SubmitInput,
    initial: Option<context::ContextProposal>,
    personalization: Option<personalization::PersonalizationBasis>,
    resources: Option<resources::ContextResources>,
    checkpoint: Option<String>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}

#[derive(Serialize)]
pub(super) struct SubmissionIdentity {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub expected_head: Option<String>,
    pub configuration: Value,
}
pub(super) enum SubmissionOrigin {
    User {
        checkpoint: Option<String>,
    },
    Child {
        operation_id: String,
        parent_thread_id: String,
        checkpoint: Option<String>,
    },
    Continuation {
        occurrence_id: String,
        checkpoint: Option<String>,
    },
    Summary,
}
pub struct PreparedSubmission {
    pub(super) run_id: String,
    pub(super) identity: SubmissionIdentity,
    pub(super) epoch: u64,
    pub(super) intent: Value,
    pub(super) history: Value,
    pub(super) launch: Option<launch_content::LaunchSelectionMetadata>,
    pub(super) inherit_source: bool,
    pub(super) initial: Option<(context::CheckpointMetadata, Value)>,
    pub(super) origin: SubmissionOrigin,
    pub(super) _publication: crate::content::ContentPublication,
}
pub(super) struct SubmissionBody {
    pub command: SubmitInput,
    pub launch: Option<launches::LaunchSelection>,
    pub inherit_source: bool,
    pub initial: Option<context::ContextProposal>,
    pub current: Option<context::CheckpointRead>,
    pub personalization: Option<personalization::PersonalizationBasis>,
    pub resources: Option<resources::ContextResources>,
    pub origin: SubmissionOrigin,
    pub epoch: u64,
    pub content: crate::content::ContentStore,
    pub publication: crate::content::ContentPublication,
}

fn submission_intent(command: &SubmitInput, launch: &Option<launches::LaunchSelection>, inherit_source: bool, child_context: Option<&Value>) -> Value {
    json!({"command":command,"launch":launch,"inherit_source":inherit_source,"child_context":child_context})
}

impl Catalog {
    /// Capture small ownership facts. `load` owns validation, serialization, hashing and disk I/O.
    pub fn prepare_submission(
        &self,
        command: SubmitInput,
        initial: Option<context::ContextProposal>,
        personalization: Option<personalization::PersonalizationBasis>,
    ) -> Result<SubmissionPreparation> {
        let delegated: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM child_tasks WHERE child_thread_id=?1)",
            [&command.thread_id],
            |row| row.get(0),
        )?;
        if delegated {
            return Err(RuntimeError::Invalid(
                "read-only delegated Threads accept only their admitted child task".into(),
            ));
        }
        let existing: Option<(String,String)> = self.db.query_row("SELECT intent,receipt FROM commands WHERE id=?1", [&command.key], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
        let existing = existing.map(|(intent,receipt)| -> Result<_> {Ok((serde_json::from_str(&intent)?,serde_json::from_str(&receipt)?))}).transpose()?;
        let checkpoint = self.capture_active_checkpoint(&command.branch_id)?;
        let scope = checkpoint
            .as_ref()
            .and_then(|checkpoint| checkpoint.scope.clone())
            .or_else(|| {
                checkpoint
                    .is_none()
                    .then(|| personalization.as_ref().map(context::ContextScope::from))
                    .flatten()
            });
        Ok(SubmissionPreparation {
            existing,
            expected_context_checkpoint: None,
            scope,
            checkpoint: checkpoint.as_ref().map(|checkpoint| checkpoint.id.clone()),
            current: checkpoint,
            command,
            initial,
            personalization,
            resources: None,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_submission(&mut self, prepared: PreparedSubmission) -> Result<Receipt> {
        self.submit_admission(prepared, None)
    }
}

impl SubmissionPreparation {
    pub fn with_expected_context_checkpoint(mut self, checkpoint: Option<String>) -> Self {
        self.expected_context_checkpoint = checkpoint;
        self
    }
    pub fn with_resources(mut self, resources: Option<resources::ContextResources>) -> Self {
        self.resources = resources;
        self
    }
    pub fn thread_id(&self) -> &str {
        &self.command.thread_id
    }
    pub fn scope(&self) -> Option<&context::ContextScope> {
        self.scope.as_ref()
    }
    pub fn existing_receipt(&self, launch: &Option<launches::LaunchSelection>, inherit_source: bool) -> Result<Option<Receipt>> {
        let Some((intent,receipt)) = &self.existing else { return Ok(None); };
        if crate::content::ContentStore::reference(&submission_intent(&self.command,launch,inherit_source,None))? != *intent {
            return Err(RuntimeError::Conflict("idempotency key has different input".into()));
        }
        Ok(Some(receipt.clone()))
    }
    pub fn load(
        self,
        launch: Option<launches::LaunchSelection>,
        inherit_source: bool,
    ) -> Result<PreparedSubmission> {
        if let Some(receipt) = self.existing_receipt(&launch, inherit_source)? {
            let intent = self.existing.as_ref().expect("validated original receipt").0.clone();
            return Ok(PreparedSubmission {
                run_id:receipt.run_id,
                identity:SubmissionIdentity {key:self.command.key,thread_id:self.command.thread_id,branch_id:self.command.branch_id,
                    expected_head:self.command.expected_head,configuration:self.command.configuration},
                epoch:self.epoch,intent,history:Value::Null,launch:None,inherit_source,initial:None,
                origin:SubmissionOrigin::User {checkpoint:self.checkpoint},_publication:self.publication,
            });
        }
        if (self.resources.is_some() && self.checkpoint.is_some()) || self.expected_context_checkpoint.is_some() {
            if self.expected_context_checkpoint != self.checkpoint {
                return Err(RuntimeError::Conflict("prepared resource context is based on a different checkpoint".into()));
            }
        }
        PreparedSubmission::stage(SubmissionBody {
            command: self.command,
            launch,
            inherit_source,
            initial: self.initial,
            current: self.current,
            personalization: self.personalization,
            resources: self.resources,
            origin: SubmissionOrigin::User {
                checkpoint: self.checkpoint,
            },
            epoch: self.epoch,
            content: self.content,
            publication: self.publication,
        })
    }
}

impl PreparedSubmission {
    pub(super) fn stage(body: SubmissionBody) -> Result<Self> {
        let SubmissionBody {
            command,
            launch,
            inherit_source,
            initial,
            current,
            personalization,
            mut resources,
            origin,
            epoch,
            content,
            publication,
        } = body;
        let run_id = id();
        if resources.is_some() && initial.is_none() {
            return Err(RuntimeError::Invalid("resource candidate requires its prepared context".into()));
        }
        if command.key.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "input idempotency key cannot be empty".into(),
            ));
        }
        if let Some(selection) = &launch {
            selection.validate()?;
        }
        if inherit_source
            && launch.as_ref().is_none_or(|selection| {
                selection.source.is_some()
                    || selection.tools.iter().any(|tool| {
                        !matches!(
                            tool.name.as_str(),
                            questions::QUESTION_TOOL
                                | collaboration::STATUS_TOOL
                                | collaboration::WAIT_TOOL
                                | collaboration::REPORT_TOOL
                                | "resource_read"
                                | "memory"
                                | "todo"
                        )
                    })
            })
        {
            return Err(RuntimeError::Invalid(
                "source inheritance requires an unoverridden model launch".into(),
            ));
        }
        if let Some(basis) = &personalization {
            if basis.session_id != command.thread_id {
                return Err(RuntimeError::Invalid(
                    "personalization scope must identify the admitted thread".into(),
                ));
            }
        }
        execution_persistence::user_input_items("admission", &command.input)?;
        let checkpoint = match &origin {
            SubmissionOrigin::User { checkpoint } | SubmissionOrigin::Child { checkpoint, .. }
            | SubmissionOrigin::Continuation { checkpoint, .. } => {
                checkpoint
            }
            SubmissionOrigin::Summary => &None,
        };
        let active = current.map(context::CheckpointRead::load).transpose()?;
        let selected_source = launch.as_ref().and_then(|launch| launch.source.clone());
        let normalized_source = super::followups::normalized_source(selected_source.clone(), &run_id);
        if resources.is_none() && !inherit_source && selected_source.is_some() {
            if let Some(previous) = active.as_ref().and_then(|checkpoint| checkpoint.resources.as_ref()) {
                if previous.source != normalized_source {
                    return Err(RuntimeError::Conflict("a changed input source requires its prepared resource context".into()));
                }
            }
        }
        let initial = initial.map(|mut proposal| -> Result<_> {
            if proposal.branch_id != command.branch_id || proposal.through_id.is_some()
                || proposal.expected_revision != 0 || !proposal.summary.is_empty() {
                return Err(RuntimeError::Invalid("input context must be a prepared system snapshot".into()));
            }
            if let Some(basis) = &personalization { basis.validate()?; }
            if let Some(resources) = &resources {
                let basis = personalization.as_ref().ok_or_else(|| RuntimeError::Invalid("resources require an owned context scope".into()))?;
                resources.validate(basis)?;
                if resources.snapshot.scope.branch_id != command.branch_id || resources.source != selected_source {
                    return Err(RuntimeError::Conflict("resource snapshot differs from the admitted branch/source".into()));
                }
            }
            let revision = if let Some(active) = &active {
                // An explicit new source and its prepared prompt publish with the new input/Run.
                // Ordinary contextless inputs keep their original checkpoint unchanged.
                if resources.is_none() { return Ok(None); }
                let previous = active.personalization.as_ref().ok_or_else(|| RuntimeError::Invalid("resource replacement needs an owned context scope".into()))?;
                let next = personalization.as_ref().expect("resource scope checked");
                if context::ContextScope::from(previous) != context::ContextScope::from(next)
                    || previous.memory_snapshot != next.memory_snapshot
                    || active.proposal.memory_checkpoint != proposal.memory_checkpoint
                    || next.revision < previous.revision {
                    return Err(RuntimeError::Conflict("input resource replacement changed frozen scope or memory".into()));
                }
                let revision = active.revision.checked_add(1).ok_or_else(|| RuntimeError::Invalid("context revision exhausted".into()))?;
                proposal.key = format!("input-context:{}:{}", command.branch_id, command.key);
                proposal.expected_revision = active.revision;
                proposal.through_id = active.proposal.through_id.clone();
                proposal.summary = active.proposal.summary.clone();
                revision
            } else {
                if checkpoint.is_some() { return Err(RuntimeError::Conflict("captured input context is unavailable".into())); }
                1
            };
            if let Some(resources) = resources.as_mut() {
                resources.source = super::followups::normalized_source(resources.source.take(), &run_id);
            }
            let body = context::ContextCheckpoint { id:proposal.key.clone(),revision,proposal,personalization,resources };
            let reference = content.save(&serde_json::to_value(&body)?)?;
            Ok(Some((context::CheckpointMetadata::from(&body), reference)))
        }).transpose()?.flatten();
        let history = match &origin {
            SubmissionOrigin::Child {
                operation_id,
                parent_thread_id,
                ..
            } => {
                let task = command
                    .input
                    .as_str()
                    .ok_or_else(|| RuntimeError::Invalid("child task must be text".into()))?;
                content.save_history(
                    &serde_json::to_value(crate::execution::ConversationItem {
                        id: format!("child-input:{operation_id}"),
                        provenance: crate::execution::Provenance::AgentMessage {
                            thread_id: parent_thread_id.clone(),
                        },
                        content: crate::execution::Content::Text { text: task.into() },
                        opaque: None,
                    })?,
                    &None,
                )?
            }
            _ => content.save_history(&command.input, &None)?,
        };
        // The intent retains the original content and requested selection. Inherited source and
        // the initial prompt are separately frozen by the atomic admission, never by a retry.
        let child_context = if matches!(origin, SubmissionOrigin::Child { .. }) { initial.as_ref().map(|(_,reference)|reference) } else { None };
        let intent = content.save(&submission_intent(&command, &launch, inherit_source, child_context))?;
        let launch = launch.map(|selection| launch_content::LaunchSelectionMetadata::stage(&content, selection)).transpose()?;
        Ok(Self {
            run_id,
            identity: SubmissionIdentity {
                key: command.key,
                thread_id: command.thread_id,
                branch_id: command.branch_id,
                expected_head: command.expected_head,
                configuration: command.configuration,
            },
            epoch,
            intent,
            history,
            launch,
            inherit_source,
            initial,
            origin,
            _publication: publication,
        })
    }
}
