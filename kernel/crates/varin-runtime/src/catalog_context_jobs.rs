//! Explicit summarization jobs use ordinary durable Runs on isolated branches.
use super::*;
pub use crate::context_job::{ContextJob, ContextJobRequest};
use crate::execution::{Content, ConversationItem};

impl Catalog {
    pub fn create_context_job(
        &mut self,
        request: ContextJobRequest,
        launch: launches::LaunchSelection,
        configuration: Value,
    ) -> Result<ContextJob> {
        let prepared = self.prepare_context_job(request, launch, configuration)?.load()?;
        self.admit_prepared_context_job(prepared)
    }

    pub fn prepare_context_job(&self, request: ContextJobRequest, launch: launches::LaunchSelection,
        configuration: Value) -> Result<ContextJobPreparation> {
        Ok(ContextJobPreparation { database: self.db.path().ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?.into(),
            content: self.content.clone(), publication: self.content.begin_publication(),
            duplicate: self.db.query_row("SELECT EXISTS(SELECT 1 FROM commands WHERE id=?1)", [format!("context-job:{}",request.key)], |row| row.get(0))?,
            request, launch, configuration })
    }

    pub fn admit_prepared_context_job(&mut self, prepared: PreparedContextJob) -> Result<ContextJob> {
        let PreparedContextJob { request, mut launch, mut configuration, _publication } = prepared;
        if request.key.is_empty() || request.through_id.is_empty() {
            return Err(RuntimeError::Invalid(
                "context job identity and boundary are required".into(),
            ));
        }
        launch.tools.clear();
        launch.tool_schema_generation = 0;
        launch.policy = crate::context_job::policy_identity();
        launch.source = None;
        launch.validate()?;
        let config = configuration.as_object_mut().ok_or_else(|| {
            RuntimeError::Invalid("context job model configuration must be an object".into())
        })?;
        if config.contains_key("context_job") {
            return Err(RuntimeError::Invalid(
                "context_job is reserved for runtime admission".into(),
            ));
        }
        config.insert("context_job".into(), serde_json::to_value(&request)?);

        // Retry the original admission before checking a source which may since have advanced.
        let command_key = format!("context-job:{}", request.key);
        let previous: Option<String> = self
            .db
            .query_row(
                "SELECT receipt FROM commands WHERE id=?1",
                [&command_key],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            let receipt: Receipt = serde_json::from_str(&previous)?;
            let job = self.context_job(&receipt.run_id)?;
            let intent = self
                .launch_intent(&receipt.run_id)?
                .ok_or_else(|| RuntimeError::Invalid("context job launch is missing".into()))?;
            if job.request != request
                || intent.selection != launch
                || self.run(&receipt.run_id)?.configuration != configuration
            {
                return Err(RuntimeError::Conflict(
                    "context job identity has different input".into(),
                ));
            }
            return Ok(job);
        }
        let revision = self
            .active_context(&request.branch_id)?
            .map_or(0, |c| c.revision);
        if revision != request.expected_revision {
            return Err(RuntimeError::Conflict(
                "active context checkpoint changed".into(),
            ));
        }
        if request.personalization.is_none() && self.active_context(&request.branch_id)?.is_some_and(|checkpoint| checkpoint.personalization.is_some()) {
            return Err(RuntimeError::Invalid("personalized compaction requires an explicit frozen candidate".into()));
        }
        if let Some(candidate) = &request.personalization {
            candidate.validate()?;
            let active = self.active_context(&request.branch_id)?.and_then(|checkpoint| checkpoint.personalization)
                .ok_or_else(|| RuntimeError::Invalid("memory compaction needs an admitted personalization basis".into()))?;
            if !active.same_scope_and_source(candidate) || active.configuration_digest != candidate.configuration_digest
                || active.revision != candidate.revision || candidate.memory_snapshot.revision < active.memory_snapshot.revision {
                return Err(RuntimeError::Conflict("memory compaction configuration or scope changed".into()));
            }
        }
        require_ancestor(&self.db, &request.branch_id, &request.through_id)?;
        let thread_id = format!("context-job-thread:{}", request.key);
        let branch_id = format!("context-job-branch:{}", request.key);
        let receipt = self.submit_admission(
            &SubmitInput {
                key: command_key,
                thread_id,
                branch_id,
                expected_head: None,
                input: Value::String(crate::context_job::SUMMARY_REQUEST.into()),
                configuration,
            },
            Some(launch),
            true,
            false,
            None,
            None,
        )?;
        Ok(ContextJob { request, receipt })
    }

    pub fn context_jobs(&self, branch_id: &str) -> Result<Vec<ContextJob>> {
        self.head(branch_id)?;
        let mut statement = self.db.prepare(
            "SELECT id FROM runs WHERE json_extract(body,'$.configuration.context_job.branch_id')=?1 ORDER BY rowid",
        )?;
        let ids = statement
            .query_map([branch_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.into_iter().map(|id| self.context_job(&id)).collect()
    }

    pub fn context_job(&self, run_id: &str) -> Result<ContextJob> {
        let run = self.run(run_id)?;
        let request = run
            .configuration
            .get("context_job")
            .ok_or_else(|| RuntimeError::Invalid("Run is not a context job".into()))?;
        let request: ContextJobRequest = serde_json::from_value(request.clone())?;
        let receipt: String = self.db.query_row(
            "SELECT receipt FROM commands WHERE id=?1",
            [format!("context-job:{}", request.key)],
            |r| r.get(0),
        )?;
        let receipt: Receipt = serde_json::from_str(&receipt)?;
        if receipt.run_id != run_id {
            return Err(RuntimeError::Conflict(
                "context job admission identity differs".into(),
            ));
        }
        Ok(ContextJob { request, receipt })
    }

    pub fn publish_context_job(&mut self, run_id: &str) -> Result<context::ContextCheckpoint> {
        let prepared = self.prepare_context_job_publication(run_id)?.load()?;
        self.publish_prepared_context_job(prepared)
    }
    pub fn prepare_context_job_publication(&self, run_id: &str) -> Result<ContextJobPublication> {
        let job = self.context_job(run_id)?;
        let run = self.run(run_id)?;
        if run.state != RunState::Completed || run.cancel_requested {
            return Err(RuntimeError::Conflict("context summary Run has not completed successfully".into()));
        }
        let mut statement = self.db.prepare("SELECT o.body FROM model_steps s JOIN model_outputs o ON o.request_id=s.id WHERE s.run_id=?1")?;
        let outputs = statement.query_map([run_id], |row| row.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        if outputs.len() != 1 { return Err(RuntimeError::Conflict("context job requires exactly one completed generation".into())); }
        Ok(ContextJobPublication { job, run_revision: run.revision, content: self.content.clone(),
            output: serde_json::from_str(&outputs[0])?, publication: self.content.begin_publication() })
    }
    pub fn publish_prepared_context_job(&mut self, prepared: PreparedContextCheckpoint) -> Result<context::ContextCheckpoint> {
        let run = self.run(&prepared.job.receipt.run_id)?;
        if run.state != RunState::Completed || run.cancel_requested || run.revision != prepared.run_revision {
            return Err(RuntimeError::Conflict("summary completion changed during publication".into()));
        }
        require_ancestor(&self.db, &prepared.job.request.branch_id, &prepared.job.request.through_id)?;
        let tx = self.db.transaction()?;
        context::publish_prepared(&tx, &prepared.checkpoint, &prepared.reference)?;
        tx.commit()?;
        Ok(prepared.checkpoint)
    }

    pub(super) fn context_source_metadata(
        &self,
        branch_id: &str,
        through_id: &str,
    ) -> Result<Vec<HistoryItem>> {
        let mut cursor = self.head(branch_id)?;
        while cursor.as_deref() != Some(through_id) {
            let key = cursor.ok_or_else(|| {
                RuntimeError::Conflict(
                    "context boundary is no longer on the selected branch".into(),
                )
            })?;
            let item: HistoryItem = record(&self.db, "history", &key)?;
            cursor = item.parent;
        }
        let mut history = Vec::new();
        while let Some(key) = cursor {
            let item: HistoryItem = record(&self.db, "history", &key)?;
            cursor = item.parent.clone();
            history.push(item);
        }
        history.reverse();
        Ok(history)
    }
}

pub(super) fn hydrate_source(
    content: &crate::content::ContentStore,
    metadata: Vec<HistoryItem>,
) -> Result<Vec<ConversationItem>> {
    let mut history = Vec::new();
    for item in metadata {
        let item = content.hydrate_history(item)?;
        if item.source == HistorySource::User {
            history.extend(super::execution_persistence::user_input_items(
                &item.id,
                &item.content,
            )?);
        } else {
            history.push(serde_json::from_value(item.content)?);
        }
    }
    Ok(history)
}

/// Internal summary branches accept only their original admitted input.
pub(super) fn require_regular_branch(db: &Connection, branch_id: &str) -> Result<()> {
    let internal: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE branch_id=?1 AND json_type(body,'$.configuration.context_job') IS NOT NULL)",
        [branch_id], |r| r.get(0),
    )?;
    if internal {
        return Err(RuntimeError::Conflict(
            "context job branches do not accept additional input".into(),
        ));
    }
    Ok(())
}

/// Owns the immutable input and content lifetime while a worker checks the fixed ancestor.
pub struct ContextJobPreparation {
    database: std::path::PathBuf, content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    request: ContextJobRequest, launch: launches::LaunchSelection, configuration: Value, duplicate: bool,
}
pub struct PreparedContextJob {
    request: ContextJobRequest, launch: launches::LaunchSelection, configuration: Value,
    _publication: crate::content::ContentPublication,
}
impl ContextJobPreparation {
    pub fn load(self) -> Result<PreparedContextJob> {
        let database = Connection::open_with_flags(&self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        if !self.duplicate {
        require_ancestor(&database, &self.request.branch_id, &self.request.through_id)?;
        let source = source_metadata(&database, &self.request.through_id)?;
        let history = hydrate_source(&self.content, source)?;
        crate::execution::validate_history_pairs(&history).map_err(|error| RuntimeError::Conflict(error.to_string()))?;
        }
        Ok(PreparedContextJob { request: self.request, launch: self.launch, configuration: self.configuration,
            _publication: self.publication })
    }
}

pub struct ContextJobPublication {
    job: ContextJob, run_revision: u64, content: crate::content::ContentStore, output: Value,
    publication: crate::content::ContentPublication,
}
pub struct PreparedContextCheckpoint {
    job: ContextJob, run_revision: u64, checkpoint: context::ContextCheckpoint, reference: Value,
    _publication: crate::content::ContentPublication,
}
impl ContextJobPublication {
    pub fn load(self) -> Result<PreparedContextCheckpoint> {
        let output = self.content.load(&self.output)?;
        if output.get("status").and_then(Value::as_str) != Some("committed") {
            return Err(RuntimeError::Conflict("summary output was not committed".into()));
        }
        let record: crate::execution::ExecutionRecord = serde_json::from_value(output["record"].clone())?;
        let crate::execution::ExecutionRecord::ModelFinished { outcome: crate::execution::ModelOutcome::Completed,
            finish_reason: Some(crate::execution::FinishReason::Stop), items, .. } = record else {
            return Err(RuntimeError::Conflict("summary generation did not finish completely".into()));
        };
        let mut text = Vec::new();
        for item in items {
            match item.content {
                Content::Text { text: value } => text.push(value),
                Content::ReasoningSummary { .. } | Content::ProviderOnly => (),
                _ => return Err(RuntimeError::Invalid("summary contains an action or attachment".into())),
            }
        }
        let summary = text.join("\n");
        if summary.trim().is_empty() { return Err(RuntimeError::Invalid("summary is empty".into())); }
        let request = &self.job.request;
        let checkpoint = context::ContextCheckpoint { id: request.key.clone(),
            revision: request.expected_revision.checked_add(1).ok_or_else(|| RuntimeError::Invalid("context revision exhausted".into()))?,
            proposal: context::ContextProposal { key: request.key.clone(), branch_id: request.branch_id.clone(),
                through_id: Some(request.through_id.clone()), expected_revision: request.expected_revision, summary,
                effective_system_prompt: request.effective_system_prompt.clone(), instruction_sources: request.instruction_sources.clone(),
                memory_checkpoint: request.memory_checkpoint.clone() }, personalization: request.personalization.clone() };
        let reference = self.content.save(&serde_json::to_value(&checkpoint)?)?;
        Ok(PreparedContextCheckpoint { job: self.job, run_revision: self.run_revision, checkpoint, reference, _publication: self.publication })
    }
}

pub(super) fn require_ancestor(database: &Connection, branch: &str, through: &str) -> Result<()> {
    let visible: bool = database.query_row("WITH RECURSIVE ancestors(id,parent) AS (SELECT h.id,h.parent FROM branches b JOIN history h ON h.id=b.head WHERE b.id=?1 UNION ALL SELECT h.id,h.parent FROM history h JOIN ancestors a ON h.id=a.parent) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)", params![branch,through], |row| row.get(0))?;
    if !visible { return Err(RuntimeError::Conflict("context boundary is no longer on the selected branch".into())); }
    Ok(())
}
pub(super) fn source_metadata(database: &Connection, through: &str) -> Result<Vec<HistoryItem>> {
    let mut cursor = Some(through.to_string());
    let mut history = Vec::new();
    let mut visited = std::collections::BTreeSet::new();
    while let Some(key) = cursor {
        if !visited.insert(key.clone()) { return Err(RuntimeError::Invalid("history ancestry contains a cycle".into())); }
        let item: HistoryItem = record(database,"history",&key)?;
        cursor = item.parent.clone(); history.push(item);
    }
    history.reverse(); Ok(history)
}
