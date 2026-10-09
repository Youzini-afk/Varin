//! Input bodies are prepared outside the Catalog owner; admission commits only their references.
use super::*;

pub struct SubmissionPreparation {
    scope: Option<context::ContextScope>,
    command: SubmitInput,
    initial: Option<context::ContextProposal>,
    personalization: Option<personalization::PersonalizationBasis>,
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
    Summary,
}
pub struct PreparedSubmission {
    pub(super) identity: SubmissionIdentity,
    pub(super) epoch: u64,
    pub(super) intent: Value,
    pub(super) history: Value,
    pub(super) launch: Option<launches::LaunchSelection>,
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
    pub personalization: Option<personalization::PersonalizationBasis>,
    pub origin: SubmissionOrigin,
    pub epoch: u64,
    pub content: crate::content::ContentStore,
    pub publication: crate::content::ContentPublication,
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
            scope,
            checkpoint: checkpoint.map(|checkpoint| checkpoint.id),
            command,
            initial,
            personalization,
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
    pub fn thread_id(&self) -> &str {
        &self.command.thread_id
    }
    pub fn scope(&self) -> Option<&context::ContextScope> {
        self.scope.as_ref()
    }
    pub fn load(
        self,
        launch: Option<launches::LaunchSelection>,
        inherit_source: bool,
    ) -> Result<PreparedSubmission> {
        PreparedSubmission::stage(SubmissionBody {
            command: self.command,
            launch,
            inherit_source,
            initial: self.initial,
            personalization: self.personalization,
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
            personalization,
            origin,
            epoch,
            content,
            publication,
        } = body;
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
            SubmissionOrigin::User { checkpoint } | SubmissionOrigin::Child { checkpoint, .. } => {
                checkpoint
            }
            SubmissionOrigin::Summary => &None,
        };
        let initial = initial
            .map(|proposal| -> Result<_> {
                if proposal.branch_id != command.branch_id
                    || proposal.through_id.is_some()
                    || proposal.expected_revision != 0
                    || !proposal.summary.is_empty()
                {
                    return Err(RuntimeError::Invalid(
                        "initial context must be a first-input system snapshot".into(),
                    ));
                }
                if checkpoint.is_some() {
                    return Ok(None);
                }
                if let Some(basis) = &personalization {
                    basis.validate()?;
                }
                let body = context::ContextCheckpoint {
                    id: proposal.key.clone(),
                    revision: 1,
                    proposal,
                    personalization,
                };
                let reference = content.save(&serde_json::to_value(&body)?)?;
                Ok(Some((context::CheckpointMetadata::from(&body), reference)))
            })
            .transpose()?
            .flatten();
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
        let intent = content.save(&json!({"command":&command,"launch":&launch,"inherit_source":inherit_source,
            "child_context":matches!(origin,SubmissionOrigin::Child {..}).then(||initial.as_ref().map(|(_,reference)|reference))}))?;
        Ok(Self {
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
