//! Explicit summarization jobs use ordinary durable Runs on isolated branches.
use super::*;
use crate::context_job::SummarySource;
pub use crate::context_job::{ContextJob, ContextJobRequest};
use crate::execution::{Content, ConversationItem, Provenance};

/// Small searchable ownership facts. Prompt and memory bodies live in the immutable recipe.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ContextJobAdmission {
    key: String,
    branch_id: String,
    through_id: String,
    expected_revision: u64,
    owner_run_id: Option<String>,
    recipe: Value,
    parts: u64,
}
impl ContextJobAdmission {
    pub(super) fn publish(
        &self,
        tx: &Transaction<'_>,
        run_id: &str,
        parts: &[Value],
    ) -> Result<()> {
        tx.execute("INSERT INTO context_jobs(run_id,job_key,branch_id,through_id,expected_revision,owner_run_id,recipe,parts) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![run_id,self.key,self.branch_id,self.through_id,sql_number(self.expected_revision)?,self.owner_run_id,encode(&self.recipe)?,sql_number(self.parts)?])?;
        let mut insert =
            tx.prepare("INSERT INTO context_job_parts(run_id,part_index,body) VALUES(?1,?2,?3)")?;
        for (index, reference) in parts.iter().enumerate() {
            insert.execute(params![
                run_id,
                sql_number(index as u64)?,
                encode(reference)?
            ])?;
        }
        Ok(())
    }
}
#[derive(Serialize, serde::Deserialize)]
struct ContextJobRecipe {
    request: ContextJobRequest,
    source: SummarySource,
}
pub(super) fn initialize_new(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE context_jobs(run_id TEXT PRIMARY KEY REFERENCES runs(id),job_key TEXT NOT NULL UNIQUE,branch_id TEXT NOT NULL REFERENCES branches(id),through_id TEXT NOT NULL REFERENCES history(id),expected_revision INTEGER NOT NULL,owner_run_id TEXT REFERENCES runs(id),recipe TEXT NOT NULL,parts INTEGER NOT NULL); CREATE INDEX context_jobs_branch ON context_jobs(branch_id); CREATE TABLE context_job_parts(run_id TEXT NOT NULL REFERENCES runs(id),part_index INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,part_index));")?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT run_id,job_key,branch_id,through_id,expected_revision,owner_run_id,recipe,parts FROM context_jobs")?;
    db.prepare("SELECT run_id,part_index,body FROM context_job_parts")?;
    Ok(())
}

impl Catalog {
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn create_context_job(
        &mut self,
        request: ContextJobRequest,
        launch: launches::LaunchSelection,
        configuration: Value,
    ) -> Result<ContextJob> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self
            .prepare_context_job(request, launch, configuration)?
            .load()?;
        self.admit_prepared_context_job(prepared)
    }

    pub fn prepare_context_job(
        &self,
        request: ContextJobRequest,
        launch: launches::LaunchSelection,
        configuration: Value,
    ) -> Result<ContextJobPreparation> {
        let duplicate: Option<Value> = self
            .db
            .query_row(
                "SELECT recipe FROM context_jobs WHERE job_key=?1",
                [&request.key],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|value| serde_json::from_str(&value))
            .transpose()?;
        let source: Option<(u64, Option<String>, String)> = self.db.query_row(
            "SELECT c.revision,c.through_id,c.body FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",
            [&request.branch_id], |row| Ok((read_number(row,0)?, row.get(1)?, row.get(2)?))).optional()?;
        if duplicate.is_none()
            && source.as_ref().map_or(0, |entry| entry.0) != request.expected_revision
        {
            return Err(RuntimeError::Conflict(
                "active context checkpoint changed".into(),
            ));
        }
        let source = source
            .map(|(_, through_id, reference)| {
                Ok::<_, RuntimeError>(SummarySource {
                    through_id,
                    checkpoint: Some(serde_json::from_str(&reference)?),
                })
            })
            .transpose()?
            .unwrap_or_default();
        Ok(ContextJobPreparation {
            epoch: self.epoch,
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            content: self.content.clone(),
            publication: self.content.begin_publication(),
            duplicate,
            request,
            launch,
            configuration,
            source,
        })
    }

    pub fn admit_prepared_context_job(
        &mut self,
        prepared: PreparedContextJob,
    ) -> Result<ContextJob> {
        let PreparedContextJob {
            request,
            launch,
            configuration,
            admission,
            parts,
            submission,
        } = prepared;

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
            let previous = self
                .context_job_metadata(&receipt.run_id)?
                .ok_or_else(|| RuntimeError::Invalid("context job metadata is missing".into()))?;
            let intent = self
                .launch_metadata(&receipt.run_id)?
                .ok_or_else(|| RuntimeError::Invalid("context job launch is missing".into()))?;
            let previous_configuration = self.run(&receipt.run_id)?.configuration;
            if previous != admission
                || intent.selection != launch
                || previous_configuration != configuration
            {
                return Err(RuntimeError::Conflict(
                    "context job identity has different input".into(),
                ));
            }
            return Ok(ContextJob { request, receipt });
        }
        let revision: u64 = self.db.query_row("SELECT c.revision FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",
            [&request.branch_id], |row|read_number(row,0)).optional()?.unwrap_or(0);
        if let Some(parent) = &request.owner_run_id {
            let parent = self.run(parent)?;
            fence(&parent, self.epoch)?;
            let selected = self.launch_metadata(&parent.id)?.ok_or_else(|| {
                RuntimeError::Invalid("automatic compaction needs the selected model owner".into())
            })?;
            if parent.cancel_requested
                || parent.branch_id != request.branch_id
                || parent.configuration != configuration
                || selected.selection.credential_scope != launch.credential_scope
            {
                return Err(RuntimeError::Conflict(
                    "automatic compaction owner changed".into(),
                ));
            }
        }
        if revision != request.expected_revision {
            return Err(RuntimeError::Conflict(
                "active context checkpoint changed".into(),
            ));
        }
        // The worker proved immutable ancestry and validated the frozen checkpoint. Branch heads
        // only append; a fork has a distinct branch ID. New tail input does not invalidate A.
        let receipt = self.submit_admission(submission, Some((&admission, &parts)))?;
        Ok(ContextJob { request, receipt })
    }

    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn context_jobs(&self, branch_id: &str) -> Result<Vec<ContextJob>> {
        let _synchronous = self.content.begin_synchronous()?;
        self.capture_context_jobs(branch_id)?
            .into_iter()
            .map(ContextJobRead::load)
            .collect()
    }
    pub fn capture_context_jobs(&self, branch_id: &str) -> Result<Vec<ContextJobRead>> {
        self.head(branch_id)?;
        let mut statement = self
            .db
            .prepare("SELECT run_id FROM context_jobs WHERE branch_id=?1 ORDER BY rowid")?;
        let ids = statement
            .query_map([branch_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| self.capture_context_job(&id))
            .collect()
    }

    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn context_job(&self, run_id: &str) -> Result<ContextJob> {
        let _synchronous = self.content.begin_synchronous()?;
        self.capture_context_job(run_id)?.load()
    }
    pub fn is_context_job(&self, run_id: &str) -> Result<bool> {
        Ok(self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM context_jobs WHERE run_id=?1)",
            [run_id],
            |row| row.get(0),
        )?)
    }
    pub fn context_job_parent(&self, run_id: &str) -> Result<Option<String>> {
        context_job_parent(&self.db, run_id)
    }
    pub fn context_job_parts(&self, run_id: &str) -> Result<Option<u64>> {
        Ok(self
            .db
            .query_row(
                "SELECT parts FROM context_jobs WHERE run_id=?1",
                [run_id],
                |row| read_number(row, 0),
            )
            .optional()?)
    }
    pub(super) fn context_job_input(
        &self,
        run_id: &str,
    ) -> Result<(Value, Option<(String, Value)>)> {
        let completed: u64 = self.db.query_row(
            "SELECT count(*) FROM model_steps WHERE run_id=?1 AND state='completed'",
            [run_id],
            |row| read_number(row, 0),
        )?;
        let reference: String = self.db.query_row(
            "SELECT body FROM context_job_parts WHERE run_id=?1 AND part_index=?2",
            params![run_id, sql_number(completed)?],
            |row| row.get(0),
        )?;
        let previous:Option<(String,String)>=self.db.query_row("SELECT s.id,o.body FROM model_steps s JOIN model_outputs o ON o.request_id=s.id WHERE s.run_id=?1 AND s.state='completed' ORDER BY s.rowid DESC LIMIT 1",[run_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        Ok((
            serde_json::from_str(&reference)?,
            previous
                .map(|(id, value)| Ok::<_, RuntimeError>((id, serde_json::from_str(&value)?)))
                .transpose()?,
        ))
    }
    pub fn register_context_job_wait(
        &mut self,
        run_id: &str,
        epoch: u64,
        job_id: &str,
        revision: u64,
    ) -> Result<Option<Wait>> {
        let run = self.run(run_id)?;
        fence(&run, epoch)?;
        let job = self
            .context_job_metadata(job_id)?
            .ok_or_else(|| RuntimeError::NotFound(job_id.into()))?;
        if run.cancel_requested
            || job.owner_run_id.as_deref() != Some(run_id)
            || job.branch_id != run.branch_id
            || job.expected_revision != revision
        {
            return Err(RuntimeError::Conflict(
                "context wait owner or boundary changed".into(),
            ));
        }
        let current = self
            .capture_active_checkpoint(&run.branch_id)?
            .map_or(0, |checkpoint| checkpoint.revision);
        if current != revision {
            return Ok(None);
        }
        self.register_wait(
            &format!("context-wait:{run_id}:{job_id}"),
            run_id,
            job_id,
            "context.job_settled",
            0,
        )
        .map(Some)
    }
    /// Only a parked context waiter can relinquish its worker. A live model/tool is never joined.
    pub fn context_job_waiter(&self, job_id: &str) -> Result<Option<String>> {
        let Some(parent) = self.context_job_parent(job_id)? else {
            return Ok(None);
        };
        let run = self.run(&parent)?;
        let Some(key) = run
            .waiting_on
            .as_deref()
            .filter(|_| run.state == RunState::Waiting && !run.cancel_requested)
        else {
            return Ok(None);
        };
        let wait: Wait = record(&self.db, "waits", key)?;
        Ok((!wait.cancelled
            && wait.run_id == parent
            && wait.subject == job_id
            && wait.kind == "context.job_settled")
            .then_some(parent))
    }
    /// Resolve from committed facts after the old worker has parked. Failure wakes the engine
    /// to consume any pending input and report the original failed candidate without paid replay.
    pub fn resume_context_job_wait(&mut self, job_id: &str) -> Result<Option<Run>> {
        let Some(parent) = self.context_job_waiter(job_id)? else {
            return Ok(None);
        };
        let job = self
            .context_job_metadata(job_id)?
            .ok_or_else(|| RuntimeError::NotFound(job_id.into()))?;
        let summary = self.run(job_id)?;
        let current = self
            .capture_active_checkpoint(&job.branch_id)?
            .map_or(0, |checkpoint| checkpoint.revision);
        let changed = current != job.expected_revision;
        if !changed && !matches!(summary.state, RunState::Failed | RunState::Cancelled) {
            return Ok(None);
        }
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", &parent)?;
        fence(&run, self.epoch)?;
        if run.cancel_requested {
            return Ok(None);
        }
        let key = run
            .waiting_on
            .take()
            .ok_or_else(|| RuntimeError::Conflict("context wait is gone".into()))?;
        let mut wait: Wait = record(&tx, "waits", &key)?;
        let cursor = event(
            &tx,
            job_id,
            summary.revision,
            "context.job_settled",
            json!({"checkpoint_revision":current,"summary_state":summary.state}),
        )?;
        wait.trigger_cursor = Some(cursor);
        put(&tx, "waits", &key, &wait)?;
        Self::enqueue_resume(&tx, &wait, cursor)?;
        run.state = RunState::Runnable;
        run.revision += 1;
        put(&tx, "runs", &parent, &run)?;
        let mut launch: launch_content::LaunchMetadata = record(&tx, "run_launches", &parent)?;
        launch.requires_rebind = true;
        launch.bound_epoch = None;
        launch.revision += 1;
        put(&tx, "run_launches", &parent, &launch)?;
        tx.execute(
            "UPDATE resumptions SET claimed=?2,acknowledged=1 WHERE wait_id=?1",
            params![key, sql_number(self.epoch)?],
        )?;
        event(
            &tx,
            &parent,
            run.revision,
            "run.resumed",
            json!({"wait_id":key,"job_run_id":job_id}),
        )?;
        tx.commit()?;
        Ok(Some(run))
    }
    fn context_job_metadata(&self, run_id: &str) -> Result<Option<ContextJobAdmission>> {
        let row:Option<(String,String,String,u64,Option<String>,String,u64)> = self.db.query_row(
            "SELECT job_key,branch_id,through_id,expected_revision,owner_run_id,recipe,parts FROM context_jobs WHERE run_id=?1",[run_id],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,read_number(row,3)?,row.get(4)?,row.get(5)?,read_number(row,6)?))).optional()?;
        row.map(
            |(key, branch_id, through_id, expected_revision, owner_run_id, recipe, parts)| {
                Ok(ContextJobAdmission {
                    key,
                    branch_id,
                    through_id,
                    expected_revision,
                    owner_run_id,
                    recipe: serde_json::from_str(&recipe)?,
                    parts,
                })
            },
        )
        .transpose()
    }
    pub fn capture_context_job(&self, run_id: &str) -> Result<ContextJobRead> {
        let metadata = self
            .context_job_metadata(run_id)?
            .ok_or_else(|| RuntimeError::Invalid("Run is not a context job".into()))?;
        let receipt: String = self.db.query_row(
            "SELECT receipt FROM commands WHERE id=?1",
            [format!("context-job:{}", metadata.key)],
            |r| r.get(0),
        )?;
        let receipt: Receipt = serde_json::from_str(&receipt)?;
        if receipt.run_id != run_id {
            return Err(RuntimeError::Conflict(
                "context job admission identity differs".into(),
            ));
        }
        Ok(ContextJobRead {
            metadata,
            receipt,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }

    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn publish_context_job(&mut self, run_id: &str) -> Result<context::ContextCheckpoint> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self.prepare_context_job_publication(run_id)?.load()?;
        self.publish_prepared_context_job(prepared)
    }
    pub fn prepare_context_job_publication(&self, run_id: &str) -> Result<ContextJobPublication> {
        let job = self.capture_context_job(run_id)?;
        let run = self.run(run_id)?;
        if run.state != RunState::Completed || run.cancel_requested {
            return Err(RuntimeError::Conflict(
                "context summary Run has not completed successfully".into(),
            ));
        }
        let mut statement = self.db.prepare("SELECT o.body FROM model_steps s JOIN model_outputs o ON o.request_id=s.id WHERE s.run_id=?1 ORDER BY s.rowid")?;
        let outputs = statement
            .query_map([run_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if outputs.is_empty() || outputs.len() as u64 != job.metadata.parts {
            return Err(RuntimeError::Conflict(
                "context job has not completed every frozen source part".into(),
            ));
        }
        Ok(ContextJobPublication {
            job,
            run_revision: run.revision,
            content: self.content.clone(),
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            outputs: outputs
                .into_iter()
                .map(|value| serde_json::from_str(&value).map_err(Into::into))
                .collect::<Result<Vec<_>>>()?,
            publication: self.content.begin_publication(),
        })
    }
    pub fn publish_prepared_context_job(
        &mut self,
        prepared: PreparedContextCheckpoint,
    ) -> Result<context::ContextCheckpoint> {
        let run = self.run(&prepared.job.receipt.run_id)?;
        if run.state != RunState::Completed
            || run.cancel_requested
            || run.revision != prepared.run_revision
        {
            return Err(RuntimeError::Conflict(
                "summary completion changed during publication".into(),
            ));
        }
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
        "SELECT EXISTS(SELECT 1 FROM context_jobs j JOIN runs r ON r.id=j.run_id WHERE r.branch_id=?1)",
        [branch_id], |r| r.get(0),
    )?;
    if internal {
        return Err(RuntimeError::Conflict(
            "context job branches do not accept additional input".into(),
        ));
    }
    Ok(())
}

pub(super) fn context_job_parent(db: &Connection, run_id: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT owner_run_id FROM context_jobs WHERE run_id=?1",
            [run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// Capture under Catalog, hydrate after releasing it. The publication lease protects the recipe.
pub struct ContextJobRead {
    metadata: ContextJobAdmission,
    receipt: Receipt,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ContextJobRead {
    fn recipe(&self) -> Result<ContextJobRecipe> {
        let recipe: ContextJobRecipe =
            serde_json::from_value(self.content.load(&self.metadata.recipe)?)?;
        let request = &recipe.request;
        if request.key != self.metadata.key
            || request.branch_id != self.metadata.branch_id
            || request.through_id != self.metadata.through_id
            || request.expected_revision != self.metadata.expected_revision
            || request.owner_run_id != self.metadata.owner_run_id
        {
            return Err(RuntimeError::Invalid(
                "context job recipe differs from its ownership facts".into(),
            ));
        }
        Ok(recipe)
    }
    pub fn load(self) -> Result<ContextJob> {
        Ok(ContextJob {
            request: self.recipe()?.request,
            receipt: self.receipt,
        })
    }
    pub(super) fn request(self) -> Result<ContextJobRequest> {
        Ok(self.recipe()?.request)
    }
}

/// Owns the immutable input and content lifetime while a worker checks the fixed ancestor.
pub struct ContextJobPreparation {
    epoch: u64,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    request: ContextJobRequest,
    launch: launches::LaunchSelection,
    configuration: Value,
    duplicate: Option<Value>,
    source: SummarySource,
}
pub struct PreparedContextJob {
    request: ContextJobRequest,
    launch: launch_content::LaunchSelectionMetadata,
    configuration: Value,
    admission: ContextJobAdmission,
    parts: Vec<Value>,
    submission: submissions::PreparedSubmission,
}
impl ContextJobPreparation {
    pub fn load(mut self) -> Result<PreparedContextJob> {
        if self.request.key.is_empty() || self.request.through_id.is_empty() {
            return Err(RuntimeError::Invalid(
                "context job identity and boundary are required".into(),
            ));
        }
        self.launch.tools.clear();
        self.launch.tool_schema_generation = 0;
        self.launch.policy = crate::context_job::policy_identity();
        self.launch.source = None;
        self.launch.validate()?;
        if !self.configuration.is_object() {
            return Err(RuntimeError::Invalid(
                "context job model configuration must be an object".into(),
            ));
        }
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let parts = if let Some(reference) = &self.duplicate {
            let original: ContextJobRecipe = serde_json::from_value(self.content.load(reference)?)?;
            if original.request != self.request {
                return Err(RuntimeError::Conflict(
                    "context job identity has different input".into(),
                ));
            }
            self.source = original.source;
            let mut statement=database.prepare("SELECT p.body FROM context_jobs j JOIN context_job_parts p ON p.run_id=j.run_id WHERE j.job_key=?1 ORDER BY p.part_index")?;
            let references = statement
                .query_map([&self.request.key], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            references
                .into_iter()
                .map(|value| serde_json::from_str(&value).map_err(Into::into))
                .collect::<Result<Vec<_>>>()?
        } else {
            let active_checkpoint: Option<context::ContextCheckpoint> = self
                .source
                .checkpoint
                .as_ref()
                .map(|reference| {
                    self.content
                        .load(reference)
                        .and_then(|value| serde_json::from_value(value).map_err(Into::into))
                })
                .transpose()?;
            if let Some(candidate) = &self.request.personalization {
                candidate.validate()?;
            }
            if self.request.personalization.is_none()
                && active_checkpoint
                    .as_ref()
                    .is_some_and(|checkpoint| checkpoint.personalization.is_some())
            {
                return Err(RuntimeError::Invalid(
                    "personalized compaction requires an explicit frozen candidate".into(),
                ));
            }
            if let Some(candidate) = &self.request.personalization {
                let active = active_checkpoint
                    .as_ref()
                    .and_then(|checkpoint| checkpoint.personalization.as_ref())
                    .ok_or_else(|| {
                        RuntimeError::Invalid(
                            "memory compaction needs an admitted personalization basis".into(),
                        )
                    })?;
                if !active.same_scope_and_source(candidate)
                    || active.configuration_digest != candidate.configuration_digest
                    || active.revision != candidate.revision
                    || candidate.memory_snapshot.revision < active.memory_snapshot.revision
                {
                    return Err(RuntimeError::Conflict(
                        "memory compaction configuration or scope changed".into(),
                    ));
                }
            }
            require_ancestor(&database, &self.request.branch_id, &self.request.through_id)?;
            if let Some(boundary) = &self.source.through_id {
                let visible: bool = database.query_row("WITH RECURSIVE ancestors(id,parent) AS (SELECT id,parent FROM history WHERE id=?1 UNION ALL SELECT h.id,h.parent FROM history h JOIN ancestors a ON h.id=a.parent) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)",params![self.request.through_id,boundary],|row|row.get(0))?;
                if !visible {
                    self.source = SummarySource::default();
                }
            }
            let source = source_metadata_until(
                &database,
                Some(&self.request.through_id),
                self.source.through_id.as_deref(),
            )?;
            let history = hydrate_source(&self.content, source)?;
            crate::execution::validate_history_pairs(&history)
                .map_err(|error| RuntimeError::Conflict(error.to_string()))?;
            let prior = active_checkpoint
                .filter(|_| self.source.through_id.is_some())
                .map(|checkpoint| ConversationItem {
                    id: format!("context-job:{}:prior-summary", self.request.key),
                    provenance: Provenance::ExternalData {
                        source: format!("conversation-summary:{}", checkpoint.id),
                    },
                    content: Content::Text {
                        text: checkpoint.proposal.summary,
                    },
                    opaque: None,
                });
            crate::context_material::partition(
                &self.request.key,
                &self.configuration,
                prior,
                history,
            )?
            .into_iter()
            .map(|part| self.content.save(&serde_json::to_value(part)?))
            .collect::<Result<Vec<_>>>()?
        };
        let recipe = self.content.save(&serde_json::to_value(ContextJobRecipe {
            request: self.request.clone(),
            source: self.source,
        })?)?;
        let admission = ContextJobAdmission {
            key: self.request.key.clone(),
            branch_id: self.request.branch_id.clone(),
            through_id: self.request.through_id.clone(),
            expected_revision: self.request.expected_revision,
            owner_run_id: self.request.owner_run_id.clone(),
            recipe,
            parts: parts.len() as u64,
        };
        let submission = submissions::PreparedSubmission::stage(submissions::SubmissionBody {
                command:SubmitInput {key:format!("context-job:{}",self.request.key),
                    thread_id:format!("context-job-thread:{}",self.request.key),
                    branch_id:format!("context-job-branch:{}",self.request.key),expected_head:None,
                    input:Value::String(crate::context_job::SUMMARY_REQUEST.into()),configuration:self.configuration.clone()},
                launch:Some(self.launch.clone()),inherit_source:false,initial:None,personalization:None,
                origin:submissions::SubmissionOrigin::Summary,epoch:self.epoch,content:self.content,publication:self.publication,
            })?;
        let launch = submission.launch.clone().ok_or_else(||RuntimeError::Invalid("context job launch is missing".into()))?;
        Ok(PreparedContextJob {
            submission,
            request: self.request,
            launch,
            configuration: self.configuration,
            admission,
            parts,
        })
    }
}

pub struct ContextJobPublication {
    job: ContextJobRead,
    run_revision: u64,
    content: crate::content::ContentStore,
    outputs: Vec<Value>,
    database: std::path::PathBuf,
    publication: crate::content::ContentPublication,
}
pub struct PreparedContextCheckpoint {
    job: ContextJob,
    run_revision: u64,
    checkpoint: context::ContextCheckpoint,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
impl ContextJobPublication {
    pub fn load(self) -> Result<PreparedContextCheckpoint> {
        let job = self.job.load()?;
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        require_ancestor(&database, &job.request.branch_id, &job.request.through_id)?;
        let mut summary = String::new();
        for reference in self.outputs {
            summary = crate::context_material::summary_text(&self.content, &reference)?;
        }
        let request = &job.request;
        let checkpoint = context::ContextCheckpoint {
            id: request.key.clone(),
            revision: request
                .expected_revision
                .checked_add(1)
                .ok_or_else(|| RuntimeError::Invalid("context revision exhausted".into()))?,
            proposal: context::ContextProposal {
                key: request.key.clone(),
                branch_id: request.branch_id.clone(),
                through_id: Some(request.through_id.clone()),
                expected_revision: request.expected_revision,
                summary,
                effective_system_prompt: request.effective_system_prompt.clone(),
                instruction_sources: request.instruction_sources.clone(),
                memory_checkpoint: request.memory_checkpoint.clone(),
            },
            personalization: request.personalization.clone(),
        };
        let reference = self.content.save(&serde_json::to_value(&checkpoint)?)?;
        Ok(PreparedContextCheckpoint {
            job,
            run_revision: self.run_revision,
            checkpoint,
            reference,
            _publication: self.publication,
        })
    }
}

pub(super) fn require_ancestor(database: &Connection, branch: &str, through: &str) -> Result<()> {
    let visible: bool = database.query_row("WITH RECURSIVE ancestors(id,parent) AS (SELECT h.id,h.parent FROM branches b JOIN history h ON h.id=b.head WHERE b.id=?1 UNION ALL SELECT h.id,h.parent FROM history h JOIN ancestors a ON h.id=a.parent) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)", params![branch,through], |row| row.get(0))?;
    if !visible {
        return Err(RuntimeError::Conflict(
            "context boundary is no longer on the selected branch".into(),
        ));
    }
    Ok(())
}
pub(super) fn source_metadata_until(
    database: &Connection,
    head: Option<&str>,
    through: Option<&str>,
) -> Result<Vec<HistoryItem>> {
    let mut cursor = head.map(str::to_owned);
    let mut history = Vec::new();
    let mut visited = std::collections::BTreeSet::new();
    while cursor.as_deref() != through {
        let key = cursor.ok_or_else(|| {
            RuntimeError::Conflict(
                "context boundary is not an ancestor of the selected history".into(),
            )
        })?;
        if !visited.insert(key.clone()) {
            return Err(RuntimeError::Invalid(
                "history ancestry contains a cycle".into(),
            ));
        }
        let item: HistoryItem = record(database, "history", &key)?;
        cursor = item.parent.clone();
        history.push(item);
    }
    history.reverse();
    Ok(history)
}
