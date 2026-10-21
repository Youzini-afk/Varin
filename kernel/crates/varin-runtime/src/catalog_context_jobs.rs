//! Explicit summarization jobs use ordinary durable Runs on isolated branches.
use super::*;
use crate::context_job::*;
pub use crate::context_job::{ContextJob, ContextJobRequest};
use crate::execution::{Content, ConversationItem, Provenance};

/// Small searchable ownership facts. Prompt and memory bodies live in the immutable recipe.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ContextJobAdmission {
    key: String,
    pub(super) branch_id: String,
    through_id: String,
    expected_revision: u64,
    owner_run_id: Option<String>,
    recipe: Value,
    plan_hash: String,
    nodes: Vec<ContextNodeAdmission>,
}
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
struct ContextNodeAdmission {
    id: String,
    dependencies: Vec<String>,
}
impl From<&ContextCompactionNode> for ContextNodeAdmission {
    fn from(node: &ContextCompactionNode) -> Self {
        Self {
            id: node.id.clone(),
            dependencies: node
                .inputs
                .iter()
                .filter_map(|input| match input {
                    ContextCompactionInput::NodeOutput { node_id } => Some(node_id.clone()),
                    _ => None,
                })
                .collect(),
        }
    }
}
impl ContextJobAdmission {
    pub(super) fn publish(&self, tx: &Transaction<'_>, run_id: &str) -> Result<()> {
        tx.execute("INSERT INTO context_jobs(run_id,job_key,branch_id,through_id,expected_revision,owner_run_id,recipe,plan_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![run_id,self.key,self.branch_id,self.through_id,sql_number(self.expected_revision)?,self.owner_run_id,encode(&self.recipe)?,self.plan_hash])?;
        if let Some(parent) = &self.owner_run_id {
            goals::bind_inherited(tx, run_id, parent)?;
        }
        for (index, node) in self.nodes.iter().enumerate() {
            tx.execute(
                "INSERT INTO context_job_nodes(run_id,node_id,node_index,dependencies) VALUES(?1,?2,?3,?4)",
                params![run_id, node.id, sql_number(index as u64)?, encode(&node.dependencies)?],
            )?;
        }
        Ok(())
    }
}

#[derive(Serialize, serde::Deserialize)]
struct ContextJobRecipe {
    #[serde(default)]
    continuation_tokenizer: crate::token_count::TokenCounter,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    originals: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    continuation_budget_tokens: Option<u64>,
    recent: Value,
    bot_memory_snapshot: Option<memory::BotMemorySnapshotRef>,
    resource_activations: Vec<resources::ResourceActivation>,
    request: ContextJobRequest,
    source: SummarySource,
    sources: Value,
    compaction: ContextCompactionCandidate,
    plan_hash: String,
    model_budget: ContextCompactionModelBudget,
}
pub(super) fn initialize_new(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE context_jobs(run_id TEXT PRIMARY KEY REFERENCES runs(id),job_key TEXT NOT NULL UNIQUE,branch_id TEXT NOT NULL REFERENCES branches(id),through_id TEXT NOT NULL REFERENCES history(id),expected_revision INTEGER NOT NULL,owner_run_id TEXT REFERENCES runs(id),recipe TEXT NOT NULL,plan_hash TEXT NOT NULL); CREATE INDEX context_jobs_branch ON context_jobs(branch_id); CREATE INDEX context_jobs_owner ON context_jobs(owner_run_id,expected_revision); CREATE TABLE context_job_nodes(run_id TEXT NOT NULL REFERENCES context_jobs(run_id),node_id TEXT NOT NULL,node_index INTEGER NOT NULL,dependencies TEXT NOT NULL,PRIMARY KEY(run_id,node_id),UNIQUE(run_id,node_index)); CREATE TABLE context_job_steps(request_id TEXT PRIMARY KEY REFERENCES model_steps(id),run_id TEXT NOT NULL,node_id TEXT NOT NULL,plan_hash TEXT NOT NULL,is_final INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(run_id,node_id) REFERENCES context_job_nodes(run_id,node_id));")?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT run_id,job_key,branch_id,through_id,expected_revision,owner_run_id,recipe,plan_hash FROM context_jobs")?;
    db.prepare("SELECT run_id,node_id,node_index,dependencies FROM context_job_nodes")?;
    db.prepare("SELECT request_id,run_id,node_id,plan_hash FROM context_job_steps")?;
    Ok(())
}

impl Catalog {
    pub(crate) fn context_node_recovery(&self,run:&str,node:&str)->Result<(Vec<Value>,Vec<HistoryItem>)> {
        let mut q=self.db.prepare("SELECT s.body FROM context_job_steps c JOIN model_steps s ON s.id=c.request_id WHERE c.run_id=?1 AND c.node_id=?2 AND s.state='completed' AND c.is_final=0 ORDER BY s.rowid")?;
        let steps=q.query_map(params![run,node],|r|r.get::<_,String>(0))?.map(|row|Ok(serde_json::from_str::<ModelStep>(&row?)?)).collect::<Result<Vec<_>>>()?;
        let metadata=self.context_job_history(run)?.into_iter().filter(|item|steps.iter().any(|step|item.id.starts_with(&format!("model-item:{}:{}:",step.id.len(),step.id)) || item.id.starts_with(&format!("{}:result:",step.id)))).collect();
        Ok((steps.into_iter().map(|step|step.request).collect(),metadata))
    }
    pub fn summary_project(&self,run:&str)->Result<Option<String>> {
        let job=self.context_job_metadata(run)?.ok_or_else(||RuntimeError::NotFound(run.into()))?;
        match job.owner_run_id {Some(owner)=>self.run_project_id(&owner),None=>Ok(None)}
    }
    /// The summary worker resumes the original plan, rather than the last conversation step.
    /// Only requests proven not dispatched may be prepared again after reopening.
    pub(crate) fn capture_context_execution(
        &mut self,
        run_id: &str,
        binding: crate::execution::RequestBinding,
    ) -> Result<ContextExecutionRead> {
        let job = self.capture_context_job(run_id)?;
        let mut run = self.run(run_id)?;
        fence(&run, self.epoch)?;
        if !self.run_startable(run_id)? {
            return Err(RuntimeError::Conflict(
                "summary Run is not eligible for execution".into(),
            ));
        }
        let mut statement = self
            .db
            .prepare("SELECT id,state FROM model_steps WHERE run_id=?1")?;
        let steps = statement
            .query_map([run_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        for (id, state) in &steps {
            if matches!(state.as_str(), "completed" | "not_dispatched" | "prepared") { continue; }
            // A later completed exchange of this same frozen node proves that its live
            // owner already handled the failure. Recovery never restarts an unfinished attempt.
            let replaced = matches!(state.as_str(), "failed" | "interrupted") && self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM context_job_steps c JOIN model_steps s ON s.id=c.request_id JOIN context_job_steps n ON n.run_id=c.run_id AND n.node_id=c.node_id JOIN model_steps next ON next.id=n.request_id WHERE c.request_id=?1 AND next.rowid>s.rowid AND next.state='completed')",
                [id], |row| row.get::<_, bool>(0))?;
            if !replaced {
                return Err(RuntimeError::Conflict("summary contains an unsuccessful or unknown original model request".into()));
            }
        }
        let tx = self.db.transaction()?;
        for (id, state) in &steps {
            if state == "prepared" {
                super::execution_persistence::close_prepared_request(
                    &tx,
                    &run,
                    id,
                    crate::execution::NonDispatchReason::Recovery,
                )?;
            }
        }
        if run.state == RunState::Waiting {
            if let Some(id) = run.waiting_on.take() {
                let mut wait: Wait = record(&tx, "waits", &id)?;
                wait.cancelled = true;
                put(&tx, "waits", &id, &wait)?;
            }
            run.state = RunState::Runnable;
            run.revision += 1;
            put(&tx, "runs", run_id, &run)?;
        }
        tx.commit()?;
        let execution = self.capture_execution_preparation(
            run_id,
            binding,
            policy_identity(),
            Value::Null,
            false,
            false,
            true,
            None,
        )?;
        Ok(ContextExecutionRead { execution, job })
    }
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
        let mut source = source
            .map(|(_, through_id, reference)| {
                Ok::<_, RuntimeError>(SummarySource {
                    through_id,
                    checkpoint: Some(serde_json::from_str(&reference)?),
                    recent_head: None,
                })
            })
            .transpose()?
            .unwrap_or_default();
        // Queries and selectable originals share this cut. Newer arrivals remain in the
        // conversation and participate in the next compaction.
        source.recent_head = Some(request.through_id.clone());
        let memory_reference = self.memory_state_identity(&request.branch_id)?;
        let conversation = match &request.owner_run_id {
            Some(owner) => Some(self.run(owner)?),
            None => activation::latest_run(&self.db, &request.branch_id)?,
        };
        let continuation_configuration = conversation.as_ref().filter(|run| run.configuration["model"].is_string())
            .map(|run| run.configuration.clone()).unwrap_or_else(|| configuration.clone());
        let continuation_tokenizer = crate::token_count::TokenCounter::for_configuration(&continuation_configuration);
        Ok(ContextJobPreparation {
            continuation_tokenizer,
            continuation_configuration,
            memory_reference,
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
            compaction,
            memory_reference,
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
            return Ok(ContextJob {
                request,
                receipt,
                compaction,
            });
        }
        let revision: u64 = self.db.query_row("SELECT c.revision FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",
            [&request.branch_id], |row|read_number(row,0)).optional()?.unwrap_or(0);
        if let Some(parent) = &request.owner_run_id {
            let parent = self.run(parent)?;
            fence(&parent, self.epoch)?;
            self.launch_metadata(&parent.id)?.ok_or_else(|| {
                RuntimeError::Invalid("automatic compaction needs the selected model owner".into())
            })?;
            if parent.cancel_requested
                || parent.branch_id != request.branch_id
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
        if let Some(parent) = &request.owner_run_id {
            if self
                .capture_context_job_for_request(parent, request.expected_revision)?
                .is_some()
            {
                return Err(RuntimeError::ContextJobAlreadyAdmitted);
            }
        }
        // The worker proved immutable ancestry and validated the frozen checkpoint. Branch heads
        // only append; a fork has a distinct branch ID. New tail input does not invalidate A.
        if self.memory_state_identity(&request.branch_id)? != memory_reference {
            return Err(RuntimeError::Conflict(
                "summary memory changed during preparation".into(),
            ));
        }
        let receipt = self.submit_admission(submission, Some(&admission))?;
        Ok(ContextJob {
            request,
            receipt,
            compaction,
        })
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
    pub(crate) fn context_job_history(&self, run_id: &str) -> Result<Vec<HistoryItem>> {
        let run = self.run(run_id)?;
        match self.head(&run.branch_id)? {
            Some(head) => self.context_source_metadata(&run.branch_id, &head),
            None => Ok(Vec::new()),
        }
    }
    pub(crate) fn context_job_outputs(&self, run_id: &str) -> Result<Vec<ContextNodeOutput>> {
        self.context_outputs(run_id, None)
    }
    pub(crate) fn context_job_output(
        &self,
        run_id: &str,
        request_id: &str,
    ) -> Result<ContextNodeOutput> {
        self.context_outputs(run_id, Some(request_id))?
            .into_iter()
            .next()
            .ok_or_else(|| {
                RuntimeError::Invalid("original summary request has no node receipt".into())
            })
    }
    fn context_outputs(
        &self,
        run_id: &str,
        request_id: Option<&str>,
    ) -> Result<Vec<ContextNodeOutput>> {
        let mut statement = self.db.prepare("SELECT c.node_id,c.plan_hash,s.id,CASE WHEN s.state='completed' AND c.is_final=0 THEN 'querying' ELSE s.state END,o.body FROM context_job_steps c JOIN model_steps s ON s.id=c.request_id LEFT JOIN model_outputs o ON o.request_id=s.id WHERE c.run_id=?1 AND (?2 IS NULL OR c.request_id=?2) ORDER BY s.rowid")?;
        let rows = statement
            .query_map(params![run_id, request_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(node_id, plan_hash, request_id, state, body)| {
                Ok(ContextNodeOutput {
                    node_id,
                    plan_hash,
                    request_id,
                    state,
                    body: body.map(|body| serde_json::from_str(&body)).transpose()?,
                })
            })
            .collect()
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
            || self
                .capture_context_job_for_request(run_id, revision)?
                .as_ref()
                .is_none_or(|accepted| accepted.receipt.run_id != job_id)
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
        let Some(job) = self.context_job_metadata(job_id)? else {
            return Ok(None);
        };
        let mut statement = self.db.prepare(
            "SELECT body FROM runs WHERE branch_id=?1 AND json_extract(body,'$.state')='waiting'",
        )?;
        let runs = statement
            .query_map([&job.branch_id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for body in runs {
            let run: Run = serde_json::from_str(&body)?;
            if run.cancel_requested {
                continue;
            }
            let Some(key) = run.waiting_on.as_deref() else {
                continue;
            };
            let wait: Wait = record(&self.db, "waits", key)?;
            if !wait.cancelled
                && wait.run_id == run.id
                && wait.subject == job_id
                && wait.kind == "context.job_settled"
            {
                return Ok(Some(run.id));
            }
        }
        Ok(None)
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
        if !changed
            && !matches!(
                summary.state,
                RunState::Completed | RunState::Failed | RunState::Cancelled
            )
        {
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
        let row:Option<(String,String,String,u64,Option<String>,String,String)> = self.db.query_row(
            "SELECT job_key,branch_id,through_id,expected_revision,owner_run_id,recipe,plan_hash FROM context_jobs WHERE run_id=?1",[run_id],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,read_number(row,3)?,row.get(4)?,row.get(5)?,row.get(6)?))).optional()?;
        row.map(
            |(key, branch_id, through_id, expected_revision, owner_run_id, recipe, plan_hash)| {
                let mut statement = self.db.prepare(
                    "SELECT node_id,dependencies FROM context_job_nodes WHERE run_id=?1 ORDER BY node_index",
                )?;
                let nodes = statement
                    .query_map([run_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                    .collect::<std::result::Result<Vec<_>, _>>()?
                    .into_iter().map(|(id, dependencies)| Ok(ContextNodeAdmission { id, dependencies: serde_json::from_str(&dependencies)? }))
                    .collect::<Result<Vec<_>>>()?;
                Ok(ContextJobAdmission {
                    key,
                    branch_id,
                    through_id,
                    expected_revision,
                    owner_run_id,
                    recipe: serde_json::from_str(&recipe)?,
                    plan_hash,
                    nodes,
                })
            },
        )
        .transpose()
    }
    /// Reuse already admitted automatic work for this branch/checkpoint/model/policy, regardless
    /// of later routing or selected boundaries. Failure/unknown state is not permission to retry.
    pub fn capture_context_job_for_request(
        &self,
        run_id: &str,
        revision: u64,
    ) -> Result<Option<ContextJobRead>> {
        let parent = self.run(run_id)?;
        let launch = self.launch_metadata(run_id)?;
        let mut statement = self.db.prepare("SELECT run_id,owner_run_id FROM context_jobs WHERE branch_id=?1 AND owner_run_id IS NOT NULL AND expected_revision=?2 ORDER BY rowid")?;
        let ids = statement
            .query_map(params![parent.branch_id, sql_number(revision)?], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (id, original_owner) in ids {
            let original = self.run(&original_owner)?;
            let original_launch = self.launch_metadata(&original_owner)?;
            let same_policy = original_launch
                .as_ref()
                .map(|value| (&value.policy_target, &value.selection.policy))
                == launch
                    .as_ref()
                    .map(|value| (&value.policy_target, &value.selection.policy));
            if same_policy
                && original.configuration == parent.configuration
                && original_launch
                    .as_ref()
                    .and_then(|value| value.selection.credential_scope.as_ref())
                    == launch
                        .as_ref()
                        .and_then(|value| value.selection.credential_scope.as_ref())
            {
                return self.capture_context_job(&id).map(Some);
            }
        }
        Ok(None)
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
        let outputs = self.context_job_outputs(run_id)?;
        Ok(ContextJobPublication {
            job,
            run_revision: run.revision,
            content: self.content.clone(),
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            outputs,
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
        if let Some(owner) = &prepared.job.request.owner_run_id {
            let owner = self.run(owner)?;
            if owner.cancel_requested || owner.state == RunState::Cancelled {
                return Err(RuntimeError::Conflict(
                    "context candidate owner was cancelled".into(),
                ));
            }
        }
        let tx = self.db.transaction()?;
        require_ancestor(
            &tx,
            &prepared.job.request.branch_id,
            &prepared.job.request.through_id,
        )?;
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
) -> Result<crate::execution::ConversationHistory> {
    let mut history = Vec::new();
    for item in metadata {
        let item = content.hydrate_history(item)?;
        history.extend(super::execution_persistence::history_input_items(
            &item.id,
            item.source,
            &item.content,
        )?);
    }
    Ok(history)
}

/// Internal summary branches accept only their original admitted input.
pub(super) fn require_regular_branch(db: &Connection, branch_id: &str) -> Result<()> {
    let internal: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM context_jobs j JOIN runs r ON r.id=j.run_id WHERE r.branch_id=?1) OR EXISTS(SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id WHERE r.branch_id=?1 AND json_extract(o.body,'$.intent.kind')='memory_work_v1')",
        [branch_id], |r| r.get(0),
    )?;
    if internal {
        return Err(RuntimeError::Conflict(
            "background work branches do not accept conversation input".into(),
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
    pub fn read_scope(&self) -> Result<(String,Option<String>)> {
        let recipe=self.recipe()?;
        Ok((recipe.request.branch_id,recipe.source.recent_head))
    }
    fn recipe(&self) -> Result<ContextJobRecipe> {
        let recipe: ContextJobRecipe =
            serde_json::from_value(self.content.load(&self.metadata.recipe)?)?;
        let request = &recipe.request;
        if request.key != self.metadata.key
            || request.branch_id != self.metadata.branch_id
            || request.through_id != self.metadata.through_id
            || request.expected_revision != self.metadata.expected_revision
            || request.owner_run_id != self.metadata.owner_run_id
            || recipe.plan_hash != self.metadata.plan_hash
            || recipe
                .compaction
                .plan
                .nodes()
                .iter()
                .map(ContextNodeAdmission::from)
                .collect::<Vec<_>>()
                != self.metadata.nodes
        {
            return Err(RuntimeError::Invalid(
                "context job recipe differs from its ownership facts".into(),
            ));
        }
        Ok(recipe)
    }
    pub fn load(self) -> Result<ContextJob> {
        let recipe = self.recipe()?;
        Ok(ContextJob {
            compaction: recipe.metadata(),
            request: recipe.request,
            receipt: self.receipt,
        })
    }
    pub fn load_execution(self) -> Result<ContextCompactionExecution> {
        let recipe = self.recipe()?;
        Ok(ContextCompactionExecution {
            plan: recipe.compaction.plan,
            model_budget: recipe.model_budget,
        })
    }
    pub(crate) fn compiler(self) -> Result<ContextJobCompiler> {
        let recipe = self.recipe()?;
        let sources = if recipe.compaction.plan.nodes().is_empty() {
            Default::default()
        } else {
            self.content
                .load_items(&recipe.sources, &|| false)?
                .into_iter()
                .map(|item| {
                    (
                        item.id.clone(),
                        ContextCompactionSource {
                            source_id: item.id.clone(),
                            item: std::sync::Arc::unwrap_or_clone(item),
                        },
                    )
                })
                .collect()
        };
        Ok(ContextJobCompiler {
            originals: recipe.originals.as_ref().map(|reference| self.content.load_items(reference, &|| false)
                .map(|items| crate::context_retention::Originals::new(items, recipe.continuation_tokenizer.clone()))).transpose()?,
            recent: self.content.load_items(&recipe.recent,&||false)?,
            recipe,
            sources,
            content: self.content,
            _publication: self._publication,
        })
    }
    pub(super) fn compile(
        self,
        outputs: Vec<ContextNodeOutput>,
    ) -> Result<crate::execution::ContextProjection> {
        let compiler = self.compiler()?;
        let completed = completed_outputs(&compiler.recipe, &outputs)?;
        let node = compiler
            .recipe
            .compaction
            .plan
            .nodes()
            .iter()
            .find(|node| !completed.contains_key(&node.id))
            .ok_or_else(|| {
                RuntimeError::Conflict("summary plan has no pending model node".into())
            })?;
        compiler.compile_node(&node.id, &outputs)
    }
}

pub(crate) struct ContextJobCompiler {
    originals: Option<crate::context_retention::Originals>,
    recent: crate::execution::ConversationHistory,
    recipe: ContextJobRecipe,
    sources: std::collections::BTreeMap<String, ContextCompactionSource>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ContextJobCompiler {
    pub(crate) fn snapshot(&self,reference:&Value)->Result<crate::execution::RequestSnapshot>{self.content.load_snapshot(reference)}
    pub(crate) fn completed(
        &self,
        outputs: &[ContextNodeOutput],
    ) -> Result<std::collections::BTreeMap<String, ContextNodeOutput>> {
        Ok(completed_outputs(&self.recipe, outputs)?
            .into_iter()
            .map(|(id, output)| (id, output.clone()))
            .collect())
    }
    pub(crate) fn history(
        &self,
        metadata: Vec<HistoryItem>,
    ) -> Result<crate::execution::ConversationHistory> {
        hydrate_source(&self.content, metadata)
    }
    pub(crate) fn plan(&self) -> &ContextCompactionPlan {
        &self.recipe.compaction.plan
    }
    pub(crate) fn compile_node(
        &self,
        id: &str,
        outputs: &[ContextNodeOutput],
    ) -> Result<crate::execution::ContextProjection> {
        let recipe = &self.recipe;
        let completed = completed_outputs(recipe, outputs)?;
        let node = recipe
            .compaction
            .plan
            .nodes()
            .iter()
            .find(|node| node.id == id)
            .ok_or_else(|| {
                RuntimeError::Invalid("node is outside the original summary plan".into())
            })?;
        let sources = &self.sources;
        let mut history = vec![ConversationItem {
            resource_activation: None,
            id: format!("context-job:{}:system", recipe.request.key),
            provenance: Provenance::SystemInstruction {
                source: "context_compaction:v4".into(),
            },
            content: Content::Text {
                text: recipe.request.summary_recipe.system_text(),
            },
            opaque: None,
        }];
        for input in &node.inputs {
            history.push(match input {
                ContextCompactionInput::Source { source_id, range } => {
                    crate::context_material::source_item(
                        sources
                            .get(source_id)
                            .ok_or_else(|| RuntimeError::Invalid("frozen source missing".into()))?,
                        range.as_ref(),
                    )?
                }
                ContextCompactionInput::NodeOutput { node_id } => {
                    let output = completed.get(node_id).ok_or_else(|| {
                        RuntimeError::Conflict("summary dependency is not completed".into())
                    })?;
                    let text = crate::context_material::summary_text(&self.content,
                        output.body.as_ref().ok_or_else(|| RuntimeError::Invalid("summary output missing".into()))?)?;
                    let text = self.originals.as_ref().map(|originals| originals.carry(&text)).transpose()?.unwrap_or(text);
                    ConversationItem {
                        resource_activation: None,
                        id: format!("context-job:{}:node-output:{node_id}", recipe.request.key),
                        provenance: Provenance::ExternalData {
                            source: format!("model-output:{}", output.request_id),
                        },
                        content: Content::Text {
                            text,
                        },
                        opaque: None,
                    }
                }
            });
        }
        history.extend(self.recent.iter().map(|item|std::sync::Arc::unwrap_or_clone(item.clone())));
        let mut instructions = recipe.request.summary_recipe.request_text();
        if self.originals.is_some() {
            instructions.push_str("\n\n");
            instructions.push_str(&budget_text(recipe.continuation_budget_tokens, &recipe.continuation_tokenizer.description()));
        }
        if let Some(guidance) = &node.instructions {
            instructions.push_str(
                "\n\nSelected node guidance (subject to summarizer system constraints):\n",
            );
            instructions.push_str(guidance);
        }
        history.push(
            ConversationItem {
                resource_activation: None,
                id: format!("context-job:{}:request:{}", recipe.request.key, node.id),
                provenance: Provenance::UserInstruction {
                    input_id: recipe.request.key.clone(),
                },
                content: Content::Text { text: instructions },
                opaque: None,
            }
            .into(),
        );
        Ok(crate::execution::ContextProjection {
            compaction: Some(ContextCompactionStep {
                plan_hash: recipe.plan_hash.clone(),
                node_id: node.id.clone(),
            }),
            resource_checkpoint_id: None,
            checkpoint_id: format!("context-job:{}", recipe.request.key),
            history: history.into_iter().map(Into::into).collect(),
            instruction_sources: vec!["context_compaction:v4".into()],
            memory_checkpoint: None,
        })
    }
}

/// Owns the immutable input and content lifetime while a worker checks the fixed ancestor.
pub(crate) struct ContextExecutionRead {
    execution: super::recovery::ExecutionPreparation,
    job: ContextJobRead,
}
impl ContextExecutionRead {
    pub(crate) fn load(self) -> Result<(crate::execution::ExecutionInput, ContextJobCompiler)> {
        Ok((self.execution.load()?, self.job.compiler()?))
    }
}

pub struct ContextJobPreparation {
    continuation_tokenizer: crate::token_count::TokenCounter,
    continuation_configuration: Value,
    memory_reference: Option<Value>,
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
    compaction: ContextCompactionMetadata,
    memory_reference: Option<Value>,
    submission: submissions::PreparedSubmission,
}
struct FrozenSummarySource {
    originals: crate::execution::ConversationHistory,
    continuation_budget_tokens: Option<u64>,
    recent: crate::execution::ConversationHistory,
    preview: ContextCompactionPreview,
    bot_memory_snapshot: Option<memory::BotMemorySnapshotRef>,
    resource_activations: Vec<resources::ResourceActivation>,
}
impl ContextJobRecipe {
    fn metadata(&self) -> ContextCompactionMetadata {
        ContextCompactionMetadata {
            producer: self.compaction.producer.clone(),
            kind: self.compaction.plan.kind().into(),
            source_cut_hash: self.compaction.plan.source_cut_hash().into(),
            plan_hash: self.plan_hash.clone(),
        }
    }
}
impl ContextJobPreparation {
    fn validate(&mut self) -> Result<()> {
        self.request
            .summary_recipe
            .validate(self.request.owner_run_id.is_some())
            .map_err(RuntimeError::Invalid)?;
        if self.request.key.is_empty() || self.request.through_id.is_empty() {
            return Err(RuntimeError::Invalid(
                "context job identity and boundary are required".into(),
            ));
        }
        self.launch.tools = if self.request.compaction.as_ref().is_some_and(|candidate|matches!(candidate.plan,ContextCompactionPlan::Text{..})) {Vec::new()} else {vec![crate::summary_tools::schema()]};
        self.launch.tool_schema_generation = 0;
        self.launch.policy = policy_identity();
        self.launch.source = None;
        self.launch.validate()?;
        if !self.configuration.is_object() {
            return Err(RuntimeError::Invalid(
                "context job model configuration must be an object".into(),
            ));
        }
        Ok(())
    }
    fn frozen_source(&mut self, database: &Connection) -> Result<FrozenSummarySource> {
        let mut resource_activations = Vec::new();
        let mut bot_memory_snapshot = None;
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
                return Err(RuntimeError::Conflict(
                    "checkpoint is not an ancestor of the requested summary cut".into(),
                ));
            }
        }
        let source = source_metadata_until(
            &database,
            Some(&self.request.through_id),
            self.source.through_id.as_deref(),
        )?;
        let source_metadata = serde_json::to_value(&source)?;
        let mut history = active_checkpoint.as_ref().and_then(|checkpoint| checkpoint.retained.as_ref())
            .map(|retained| self.content.load_items(&retained.items, &|| false)).transpose()?.unwrap_or_default();
        history.extend(hydrate_source(&self.content, source)?);
        if let Some(basis) = self
            .request
            .personalization
            .as_ref()
            .filter(|basis| basis.mode == "bot")
        {
            let reference = self.memory_reference.as_ref().ok_or_else(|| {
                RuntimeError::Conflict("Bot summary requires synchronized Knowledge".into())
            })?;
            let state: memory::MemoryState = serde_json::from_value(self.content.load(reference)?)?;
            let knowledge = state.bot_knowledge.as_ref().ok_or_else(|| {
                RuntimeError::Invalid("Bot summary has no original Knowledge owner".into())
            })?;
            if knowledge.thread_id != basis.thread_id {
                return Err(RuntimeError::Invalid(
                    "Bot summary Knowledge belongs to another Thread".into(),
                ));
            }
            // The immutable recipe owns the exact state supplied to this summary. A later
            // write remains a delta even if it arrives before the candidate is published.
            history.extend(memory::project(
                Some(&state),
                Some(basis),
                &history,
                &Default::default(),
                None,
            )?);
            bot_memory_snapshot = Some(memory::BotMemorySnapshotRef {
                bot_id: knowledge.bot_id.clone(),
                thread_id: knowledge.thread_id.clone(),
                revision: state.revision,
                state: reference.clone(),
            });
        }
        if self.source.through_id.is_some() {
            resource_activations = active_checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.resource_activations.clone())
                .unwrap_or_default();
        }
        resource_activations.extend(resources::retained_activations(&history));
        crate::execution::validate_history_pairs(&history)
            .map_err(|error| RuntimeError::Conflict(error.to_string()))?;
        let prior = active_checkpoint
            .clone()
            .filter(|_| self.source.through_id.is_some())
            .map(|checkpoint| ConversationItem {
                resource_activation: None,
                id: format!("context-job:{}:prior-summary", self.request.key),
                provenance: Provenance::ExternalData {
                    source: format!("conversation-summary:{}", checkpoint.id),
                },
                content: Content::Text {
                    text: checkpoint.proposal.summary,
                },
                opaque: None,
            });

        let originals = history.clone();
        if let Some(prior) = prior {
            history.insert(0, prior.into());
        }
        let mut sources = crate::context_material::quote_sources(&self.request.key, history)?;
        crate::context_retention::Originals::new(originals.clone(), self.continuation_tokenizer.clone()).annotate(&mut sources);
        let model_budget=crate::context_material::model_budget(&self.configuration,&self.request.summary_recipe)?;
        let continuation_budget_tokens = if let Some(tokens) = self.request.summary_recipe.continuation_budget_tokens {
            Some(tokens)
        } else {
            let available = if self.continuation_configuration == self.configuration {
                model_budget.source_budget_tokens
            } else {
                crate::context_material::model_budget(&self.continuation_configuration, &self.request.summary_recipe)?.source_budget_tokens
            };
            available.map(|tokens| tokens.saturating_mul(3) / 5)
        };
        let recent = Vec::new();
        let source_cut_hash = crate::context_material::hash(&json!({
            "quoteFormat":crate::context_material::QUOTE_FORMAT,
            "branchId":self.request.branch_id,"throughId":self.request.through_id,"revision":self.request.expected_revision,
            "checkpoint":self.source.checkpoint,"priorCheckpoint":active_checkpoint,"sourceMetadata":source_metadata,
            "sources":sources,"memoryReference":self.memory_reference,"botMemory":bot_memory_snapshot,"resourceActivations":resource_activations,
            "personalization":self.request.personalization,"systemPrompt":self.request.effective_system_prompt,"instructionSources":self.request.instruction_sources,
            "memoryCheckpoint":self.request.memory_checkpoint,"summaryRecipe":self.request.summary_recipe,
            "modelBudget":model_budget,"continuationTokenizer":self.continuation_tokenizer,"continuationBudgetTokens":continuation_budget_tokens,
        }))?;
        Ok(FrozenSummarySource {
            originals,
            continuation_budget_tokens,
            recent,
            preview: ContextCompactionPreview {
                source_cut_hash,
                sources,
                model_budget,
            },
            bot_memory_snapshot,
            resource_activations,
        })
    }
    /// Pure preview: no Run, recipe, candidate ledger or ContentStore write is admitted.
    pub fn preview(mut self) -> Result<ContextCompactionPreview> {
        self.validate()?;
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(self.frozen_source(&database)?.preview)
    }
    pub fn load(mut self) -> Result<PreparedContextJob> {
        self.validate()?;
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let recipe = if let Some(reference) = &self.duplicate {
            let original: ContextJobRecipe = serde_json::from_value(self.content.load(reference)?)?;
            if original.request != self.request {
                return Err(RuntimeError::Conflict(
                    "context job identity has different input".into(),
                ));
            }
            original
        } else {
            let frozen = self.frozen_source(&database)?;
            let summary_tokenizer = crate::token_count::TokenCounter::for_configuration(&self.configuration);
            let compaction = match &self.request.compaction {
                Some(candidate) => candidate.clone(),
                None => ContextCompactionCandidate {
                    producer: ContextCompactionProducer::builtin(),
                    plan: crate::context_material::builtin_plan(&frozen.preview, &summary_tokenizer)?,
                },
            };
            compaction.producer.validate()?;
            crate::context_material::validate_plan(&compaction.plan, &frozen.preview)?;
            if self.request.compaction.is_some() && matches!(
                compaction.producer,
                ContextCompactionProducer::Builtin { .. }
            ) && compaction.plan != crate::context_material::builtin_plan(&frozen.preview, &summary_tokenizer)?
            {
                return Err(RuntimeError::Invalid(
                    "builtin compaction producer must use the core fold plan".into(),
                ));
            }
            let plan_hash = crate::context_material::hash(&compaction)?;
            let sources = self.content.save_items(
                &frozen
                    .preview
                    .sources
                    .into_iter()
                    .map(|source| source.item.into())
                    .collect::<Vec<_>>(),
            )?;
            ContextJobRecipe {
                continuation_tokenizer: self.continuation_tokenizer.clone(),
                originals: Some(self.content.save_items(&frozen.originals)?),
                continuation_budget_tokens: frozen.continuation_budget_tokens,
                recent: self.content.save_items(&frozen.recent)?,
                request: self.request.clone(),
                source: self.source.clone(),
                sources,
                compaction,
                plan_hash,
                model_budget: frozen.preview.model_budget,
                bot_memory_snapshot: frozen.bot_memory_snapshot,
                resource_activations: frozen.resource_activations,
            }
        };
        let compaction = recipe.metadata();
        let nodes = recipe
            .compaction
            .plan
            .nodes()
            .iter()
            .map(ContextNodeAdmission::from)
            .collect();
        let mut dependencies = vec![recipe
            .sources
            .get("content_object")
            .and_then(Value::as_str)
            .ok_or_else(|| RuntimeError::Invalid("summary source reference is malformed".into()))?
            .to_owned()];
        if let Some(object)=recipe.recent.get("content_object").and_then(Value::as_str) {dependencies.push(object.into());}
        if let Some(object)=recipe.originals.as_ref().and_then(|reference| reference.get("content_object")).and_then(Value::as_str) {dependencies.push(object.into());}
        if let Some(snapshot) = &recipe.bot_memory_snapshot {
            dependencies.push(snapshot.dependency()?);
        }
        if let Some(checkpoint) = &recipe.source.checkpoint {
            dependencies.push(
                checkpoint
                    .get("content_object")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RuntimeError::Invalid("summary checkpoint reference is malformed".into())
                    })?
                    .to_owned(),
            );
        }
        let reference = self
            .content
            .save_with_dependencies(&serde_json::to_value(&recipe)?, dependencies)?;
        let admission = ContextJobAdmission {
            key: self.request.key.clone(),
            branch_id: self.request.branch_id.clone(),
            through_id: self.request.through_id.clone(),
            expected_revision: self.request.expected_revision,
            owner_run_id: self.request.owner_run_id.clone(),
            recipe: reference,
            plan_hash: compaction.plan_hash.clone(),
            nodes,
        };
        let submission = submissions::PreparedSubmission::stage(submissions::SubmissionBody {
            input_preparation: None,
            command: SubmitInput {
                key: format!("context-job:{}", self.request.key),
                thread_id: format!("context-job-thread:{}", self.request.key),
                branch_id: format!("context-job-branch:{}", self.request.key),
                expected_head: None,
                input: Value::String(self.request.summary_recipe.request_text()),
                configuration: self.configuration.clone(),
            },
            launch: Some(self.launch.clone()),
            inherit_source: false,
            initial: None,
            current: None,
            personalization: None,
            resources: None,
            origin: submissions::SubmissionOrigin::Summary,
            epoch: self.epoch,
            content: self.content,
            publication: self.publication,
        })?;
        let launch = submission
            .launch
            .clone()
            .ok_or_else(|| RuntimeError::Invalid("context job launch is missing".into()))?;
        Ok(PreparedContextJob {
            submission,
            request: self.request,
            launch,
            configuration: self.configuration,
            admission,
            compaction,
            memory_reference: self.memory_reference,
        })
    }
}

pub struct ContextJobPublication {
    job: ContextJobRead,
    run_revision: u64,
    content: crate::content::ContentStore,
    outputs: Vec<ContextNodeOutput>,
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
impl PreparedContextCheckpoint {
    pub fn preview(
        &self,
        read: context::ContextRead,
    ) -> Result<crate::execution::ContextProjection> {
        read.with_checkpoint(&self.checkpoint, self.reference.clone())?
            .load()
    }
}
impl ContextJobPublication {
    pub fn load(self) -> Result<PreparedContextCheckpoint> {
        let recipe = self.job.recipe()?;
        let resource_checkpoint = recipe.source.checkpoint.clone();
        let resources = resource_checkpoint
            .map(|reference| -> Result<_> {
                let checkpoint: context::ContextCheckpoint =
                    serde_json::from_value(self.content.load(&reference)?)?;
                Ok(checkpoint.resources)
            })
            .transpose()?
            .flatten();
        let job = self.job.load()?;
        let database = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        require_ancestor(&database, &job.request.branch_id, &job.request.through_id)?;
        let completed = completed_outputs(&recipe, &self.outputs)?;
        let summary = match &recipe.compaction.plan {
            ContextCompactionPlan::Text { text, .. } => {
                if !self.outputs.is_empty() {
                    return Err(RuntimeError::Invalid(
                        "text compaction has unexpected ModelSteps".into(),
                    ));
                }
                text.clone()
            }
            ContextCompactionPlan::ModelPlan {
                nodes,
                final_node_id,
                ..
            } => {
                if completed.len() != nodes.len() {
                    return Err(RuntimeError::Conflict(
                        "summary plan has incomplete nodes".into(),
                    ));
                }
                let output = completed.get(final_node_id).ok_or_else(|| {
                    RuntimeError::Conflict("final summary node has no original output".into())
                })?;
                crate::context_material::summary_text(
                    &self.content,
                    output.body.as_ref().ok_or_else(|| {
                        RuntimeError::Invalid("final summary output missing".into())
                    })?,
                )?
            }
        };
        let selection = if matches!(recipe.compaction.plan, ContextCompactionPlan::Text { .. }) {
            crate::context_retention::Selection { summary, retain: Vec::new() }
        } else { crate::context_retention::Selection::parse(&summary)? };
        let retained = recipe.originals.as_ref().map(|reference| -> Result<_> {
            let counter = recipe.continuation_tokenizer.clone();
            let originals = crate::context_retention::Originals::new(self.content.load_items(reference, &|| false)?, counter.clone());
            let items = originals.select(&selection.retain)?;
            crate::execution::validate_history_pairs(&items)
                .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
            let estimated_tokens = counter.count(&selection.summary)
                + items.iter().map(|item| counter.item(item)).sum::<u64>();
            Ok(crate::context_retention::RetainedContext { items: self.content.save_items(&items)?,
                estimated_tokens, budget_tokens: recipe.continuation_budget_tokens })
        }).transpose()?;
        let request = &job.request;
        let memory_checkpoint = recipe
            .bot_memory_snapshot
            .as_ref()
            .map(|snapshot| snapshot.identity())
            .transpose()?
            .or_else(|| request.memory_checkpoint.clone());
        let checkpoint = context::ContextCheckpoint {
            retained,
            bot_memory_snapshot: recipe.bot_memory_snapshot,
            resource_activations: recipe.resource_activations,
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
                summary: selection.summary,
                effective_system_prompt: request.effective_system_prompt.clone(),
                instruction_sources: request.instruction_sources.clone(),
                memory_checkpoint,
            },
            personalization: request.personalization.clone(),
            resources,
        };
        let reference = checkpoint.save(&self.content)?;
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
    Ok(source_metadata_since(database, head, through, None)?.history)
}

pub(super) struct ContextSourceMetadata {
    pub history: Vec<HistoryItem>,
    pub reused_prefix: bool,
}

/// Stop at an already verified immutable head only when it is an ancestor of this read.
/// Reaching the checkpoint first is an ordinary cache miss, not an ancestry error.
pub(super) fn source_metadata_since(
    database: &Connection,
    head: Option<&str>,
    through: Option<&str>,
    cached_head: Option<&str>,
) -> Result<ContextSourceMetadata> {
    let mut cursor = head.map(str::to_owned);
    let mut history = Vec::new();
    let mut visited = std::collections::BTreeSet::new();
    let reused_prefix = loop {
        if cached_head.is_some() && cursor.as_deref() == cached_head {
            break true;
        }
        if cursor.as_deref() == through {
            break false;
        }
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
    };
    history.reverse();
    Ok(ContextSourceMetadata {
        history,
        reused_prefix,
    })
}

#[derive(Clone)]
pub(crate) struct ContextNodeOutput {
    pub(crate) node_id: String,
    plan_hash: String,
    request_id: String,
    pub(crate) state: String,
    body: Option<Value>,
}
fn completed_outputs<'a>(
    recipe: &ContextJobRecipe,
    outputs: &'a [ContextNodeOutput],
) -> Result<std::collections::BTreeMap<String, &'a ContextNodeOutput>> {
    let mut completed = std::collections::BTreeMap::new();
    for (index, output) in outputs.iter().enumerate() {
        if output.plan_hash != recipe.plan_hash
            || !recipe
                .compaction
                .plan
                .nodes()
                .iter()
                .any(|node| node.id == output.node_id)
        {
            return Err(RuntimeError::Invalid(
                "ModelStep does not belong to the frozen summary plan".into(),
            ));
        }
        match output.state.as_str() {
            "completed" if output.body.is_some() => {
                if completed.insert(output.node_id.clone(), output).is_some() {
                    return Err(RuntimeError::Invalid(
                        "summary node has duplicate completed ModelSteps".into(),
                    ));
                }
            }
            "not_dispatched" | "querying" => (),
            "failed" | "interrupted" if outputs[index + 1..].iter().any(|later|
                later.node_id == output.node_id && later.body.is_some() && matches!(later.state.as_str(), "completed" | "querying")) => (),
            _ => {
                return Err(RuntimeError::Conflict(
                    "summary node has an unsettled or unsuccessful original ModelStep".into(),
                ));
            }
        }
    }
    Ok(completed)
}
/// Association commits atomically with the original RequestPrepared/ModelStep.
pub(super) fn record_step(
    db: &Connection,
    run_id: &str,
    snapshot: &crate::execution::RequestSnapshot,
) -> Result<()> {
    let actual: Option<String> = db
        .query_row(
            "SELECT plan_hash FROM context_jobs WHERE run_id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()?;
    let crate::execution::RequestOrigin::Conversation { compaction, .. } = &snapshot.view.origin
    else {
        return Err(RuntimeError::Invalid(
            "summary ModelStep requires a conversation request origin".into(),
        ));
    };
    let Some(plan_hash) = actual else {
        if compaction.is_some() {
            return Err(RuntimeError::Invalid(
                "ordinary Run cannot claim a summary node".into(),
            ));
        }
        return Ok(());
    };
    let step = compaction.as_ref().ok_or_else(|| {
        RuntimeError::Invalid("summary request is missing its frozen node association".into())
    })?;
    let index: Option<u64> = db
        .query_row(
            "SELECT node_index FROM context_job_nodes WHERE run_id=?1 AND node_id=?2",
            params![run_id, step.node_id],
            |row| read_number(row, 0),
        )
        .optional()?;
    let Some(_) = index.filter(|_| step.plan_hash == plan_hash) else {
        return Err(RuntimeError::Invalid(
            "summary request changed its plan or node".into(),
        ));
    };
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM context_job_nodes n, json_each(n.dependencies) dependency WHERE n.run_id=?1 AND n.node_id=?2 AND NOT EXISTS(SELECT 1 FROM context_job_steps c JOIN model_steps s ON s.id=c.request_id WHERE c.run_id=n.run_id AND c.node_id=dependency.value AND s.state='completed' AND c.is_final=1)) OR EXISTS(SELECT 1 FROM context_job_steps c JOIN model_steps s ON s.id=c.request_id WHERE c.run_id=?1 AND c.node_id=?2 AND s.state NOT IN ('not_dispatched','failed','interrupted') AND NOT (s.state='completed' AND c.is_final=0 AND NOT EXISTS(SELECT 1 FROM tool_calls t WHERE t.request_id=c.request_id AND t.receipt IS NULL)))",params![run_id,step.node_id],|row|row.get(0))?;
    if invalid {
        return Err(RuntimeError::Conflict(
            "summary node is already dispatched or dependencies are incomplete".into(),
        ));
    }
    db.execute(
        "INSERT INTO context_job_steps(request_id,run_id,node_id,plan_hash) VALUES(?1,?2,?3,?4)",
        params![
            snapshot.view.request_id,
            run_id,
            step.node_id,
            step.plan_hash
        ],
    )?;
    Ok(())
}
