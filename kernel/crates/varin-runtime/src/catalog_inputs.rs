//! Durable ingress held outside the active history until a legal model boundary.
use super::*;
use crate::execution::{ConversationItem, InputBatch};

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct EnqueueInput {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub mode: InputMode,
    pub input: Value,
    pub configuration: Option<Value>,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct QueuedInput {
    pub id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
    pub mode: InputMode,
    pub state: InputState,
    pub revision: u64,
    pub content: Value,
    pub cursor: u64,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputActivation {
    Activating,
    Passive,
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputOrigin {
    UserIngress,
    Followup {
        followup_id: String,
        occurrence_id: String,
        generation: u64,
        activation: super::activation::IngressActivationFact,
        goal: Option<super::goals::FrozenGoal>,
    },
    Message {
        identity: super::messages::MessageIdentity,
        command_key: String,
        activation: super::messages::IngressActivationFact,
    },
}
impl InputOrigin {
    pub fn is_user_ingress(&self) -> bool {
        matches!(self, Self::UserIngress)
    }
    pub(super) fn history_source(&self) -> HistorySource {
        match self {
            Self::Followup { .. } => HistorySource::Environment,
            Self::Message { identity, .. }
                if matches!(identity.actor, super::messages::MessageActor::Agent { .. }) =>
            {
                HistorySource::Agent
            }
            _ => HistorySource::User,
        }
    }
}
/// Queue ownership is independent of its immutable user-content body.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct QueuedInputMetadata {
    pub id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: Option<String>,
    pub mode: InputMode,
    pub state: InputState,
    pub revision: u64,
    pub cursor: u64,
    pub origin: InputOrigin,
    pub activation: InputActivation,
    pub delivered_cursor: Option<u64>,
}
impl QueuedInputMetadata {
    fn with_content(self, content: Value) -> Result<QueuedInput> {
        if !self.origin.is_user_ingress() {
            return Err(RuntimeError::Invalid(
                "message records use the read-only message API".into(),
            ));
        }
        Ok(QueuedInput {
            id: self.id,
            thread_id: self.thread_id,
            branch_id: self.branch_id,
            run_id: self
                .run_id
                .ok_or_else(|| RuntimeError::Invalid("user input Run is missing".into()))?,
            mode: self.mode,
            state: self.state,
            revision: self.revision,
            cursor: self.cursor,
            content,
        })
    }
}
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct InputReceipt {
    pub input_id: String,
    pub run_id: String,
    pub mode: InputMode,
    pub cursor: u64,
}

/// Admission status is local control evidence, not part of the public durable receipt.
/// A duplicate interrupt must not stop a newer generation of the same Run.
pub struct QueuedInputAdmission {
    pub receipt: InputReceipt,
    pub accepted: bool,
}

/// This additive user-content domain is installed atomically. Existing unrecognized tables,
/// partial domains and future versions are preserved and rejected, never replaced with empty data.
pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    let domains: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_domains')",
        [],
        |row| row.get(0),
    )?;
    let queued: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='input_queue')",
        [],
        |row| row.get(0),
    )?;
    if !domains {
        if queued {
            return Err(RuntimeError::Invalid(
                "unrecognized existing input queue domain".into(),
            ));
        }
        tx.execute_batch(
            "CREATE TABLE runtime_domains(name TEXT PRIMARY KEY,version INTEGER NOT NULL);",
        )?;
    }
    let version: Option<i64> = tx
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='input_queue'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match version {
        None => {
            if queued {
                return Err(RuntimeError::Invalid(
                    "input queue exists without its schema identity".into(),
                ));
            }
            tx.execute_batch("CREATE TABLE input_queue(id TEXT PRIMARY KEY,branch_id TEXT NOT NULL REFERENCES branches(id),run_id TEXT REFERENCES runs(id),mode TEXT NOT NULL,state TEXT NOT NULL,cursor INTEGER NOT NULL,origin TEXT NOT NULL,activation TEXT NOT NULL,sender_thread_id TEXT,sender_branch_id TEXT,body TEXT NOT NULL); CREATE INDEX input_queue_pending ON input_queue(branch_id,state,activation,cursor); CREATE INDEX input_queue_outgoing ON input_queue(sender_thread_id,sender_branch_id,cursor); INSERT INTO runtime_domains(name,version) VALUES('input_queue',5);")?;
        }
        Some(5) => check_format(tx)?,
        Some(version) => {
            return Err(RuntimeError::Invalid(format!(
                "unsupported input queue domain version {version}; data was preserved"
            )))
        }
    }
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    let version: Option<i64> = db
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='input_queue'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if version != Some(5) {
        return Err(RuntimeError::Invalid(
            "unsupported input queue format; data was preserved".into(),
        ));
    }
    let kind: Option<String> = db
        .query_row(
            "SELECT type FROM sqlite_master WHERE name='input_queue'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let columns: Vec<(String, String, i64, i64)> = {
        let mut statement = db.prepare("PRAGMA table_info(input_queue)")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get(1)?, row.get(2)?, row.get(3)?, row.get(5)?))
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let expected = vec![
        ("id", "TEXT", 0, 1),
        ("branch_id", "TEXT", 1, 0),
        ("run_id", "TEXT", 0, 0),
        ("mode", "TEXT", 1, 0),
        ("state", "TEXT", 1, 0),
        ("cursor", "INTEGER", 1, 0),
        ("origin", "TEXT", 1, 0),
        ("activation", "TEXT", 1, 0),
        ("sender_thread_id", "TEXT", 0, 0),
        ("sender_branch_id", "TEXT", 0, 0),
        ("body", "TEXT", 1, 0),
    ]
    .into_iter()
    .map(|(n, t, nn, pk)| (n.to_string(), t.to_string(), nn, pk))
    .collect::<Vec<_>>();
    if kind.as_deref() != Some("table") || columns != expected {
        return Err(RuntimeError::Invalid(
            "input queue schema is malformed; data was preserved".into(),
        ));
    }
    db.prepare("SELECT input_id,body FROM input_history_content")?;
    db.prepare("SELECT id,intent,receipt FROM commands")?;
    Ok(())
}
pub(super) fn write_input(tx: &Transaction<'_>, input: &QueuedInputMetadata) -> Result<()> {
    tx.execute(
        "UPDATE input_queue SET state=?2,body=?3,run_id=?4 WHERE id=?1",
        params![
            input.id,
            encode(&input.state)?.trim_matches('"'),
            encode(input)?,
            input.run_id
        ],
    )?;
    Ok(())
}
impl Catalog {
    pub fn admit_queued_input(
        &mut self,
        prepared: PreparedQueueInput,
    ) -> Result<QueuedInputAdmission> {
        let PreparedQueueInput {
            identity: command,
            epoch,
            history: history_content,
            intent,
            checkpoint,
            _publication,
        } = prepared;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "queued input belongs to a previous owner".into(),
            ));
        }
        super::context_jobs::require_regular_branch(&self.db, &command.branch_id)?;
        let encoded = encode(&intent)?;
        let tx = self.db.transaction()?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT intent,receipt FROM commands WHERE id=?1",
                [&command.key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((input, receipt)) = previous {
            if input != encoded {
                return Err(RuntimeError::Conflict(
                    "input key has different content or mode".into(),
                ));
            }
            return Ok(QueuedInputAdmission {
                receipt: serde_json::from_str(&receipt)?,
                accepted: false,
            });
        }
        if let Some(expected) = checkpoint {
            let active: Option<String> = tx
                .query_row(
                    "SELECT checkpoint_id FROM active_contexts WHERE branch_id=?1",
                    [&command.branch_id],
                    |row| row.get(0),
                )
                .optional()?;
            if active != expected {
                return Err(RuntimeError::Conflict(
                    "input resource context changed during preparation".into(),
                ));
            }
        }
        let delegated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM child_tasks WHERE child_thread_id=?1)",
            [&command.thread_id],
            |row| row.get(0),
        )?;
        let (thread, active): (String, Option<String>) = tx.query_row(
            "SELECT thread_id,active_run FROM branches WHERE id=?1",
            [&command.branch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if thread != command.thread_id {
            return Err(RuntimeError::Conflict(
                "input branch belongs to another Thread".into(),
            ));
        }
        let owner: Option<Run> = active
            .as_ref()
            .map(|id| record(&tx, "runs", id))
            .transpose()?;
        if owner
            .as_ref()
            .is_some_and(|run| run.cancel_requested || run.state.terminal())
        {
            return Err(RuntimeError::Conflict("active Run is closing".into()));
        }
        if delegated {
            let run = owner
                .as_ref()
                .filter(|_| command.mode != InputMode::NextRun)
                .ok_or_else(|| {
                    RuntimeError::Invalid(
                        "delegated next Run requires an explicit continuation admission".into(),
                    )
                })?;
            let raw: Option<String> = tx
                .query_row(
                    "SELECT body FROM delegated_executions WHERE run_id=?1",
                    [&run.id],
                    |row| row.get(0),
                )
                .optional()?;
            let execution: delegated::DelegatedExecution = raw
                .map(|raw| serde_json::from_str(&raw))
                .transpose()?
                .ok_or_else(|| {
                    RuntimeError::Conflict(
                        "active delegated Run has no exact execution admission".into(),
                    )
                })?;
            if execution.cancel_requested || execution.report.is_some() {
                return Err(RuntimeError::Conflict(
                    "delegated execution is closing".into(),
                ));
            }
        }
        let predecessor: Option<Run> = if owner.is_some() {
            owner.clone()
        } else {
            let body: Option<String> = tx
                .query_row(
                    "SELECT body FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",
                    [&command.branch_id],
                    |r| r.get(0),
                )
                .optional()?;
            body.map(|body| serde_json::from_str(&body)).transpose()?
        };
        let immediate = owner.is_none();
        let run_id = if command.mode == InputMode::NextRun || immediate {
            let desired: Option<super::models::RunModelSelection> = if command
                .configuration
                .is_none()
            {
                predecessor.as_ref().map(|previous|tx.query_row("SELECT body FROM model_selections WHERE run_id=?1 ORDER BY revision DESC LIMIT 1",[&previous.id],|row|row.get::<_,String>(0)).optional())
                    .transpose()?.flatten().map(|body|serde_json::from_str(&body)).transpose()?
            } else {
                None
            };
            let inherited_configuration = desired
                .as_ref()
                .map(|choice| serde_json::to_value(&choice.configuration))
                .transpose()?;
            let configuration = command
                .configuration
                .clone()
                .or(inherited_configuration)
                .or_else(|| predecessor.as_ref().map(|run| run.configuration.clone()))
                .ok_or_else(|| {
                    RuntimeError::Invalid(
                        "an idle branch requires an explicit launch configuration".into(),
                    )
                })?;
            let next = Run {
                id: id(),
                thread_id: thread,
                branch_id: command.branch_id.clone(),
                state: RunState::Accepted,
                revision: 1,
                epoch: self.epoch,
                configuration,
                cancel_requested: false,
                waiting_on: None,
            };
            // Queued Runs own their admission scope now, not when eventually promoted.
            tx.execute("INSERT INTO runs(id,branch_id,body,context_checkpoint_id) VALUES(?1,?2,?3,(SELECT checkpoint_id FROM active_contexts WHERE branch_id=?2))",params![next.id,next.branch_id,encode(&next)?])?;
            if let Some(previous) = predecessor.as_ref().filter(|previous| {
                previous.configuration == next.configuration || desired.is_some()
            }) {
                if let Some(mut launch) = optional_record::<super::launch_content::LaunchMetadata>(
                    &tx,
                    "run_launches",
                    &previous.id,
                )? {
                    if let Some(desired) = &desired {
                        let binding = &mut launch.selection;
                        binding.connection_identity =
                            if let Some(scope) = &desired.credential_scope {
                                crate::model_session::connection_identity_with_scope(
                                    &desired.configuration,
                                    scope,
                                )
                            } else {
                                crate::model_session::connection_identity(&desired.configuration)
                            }
                            .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
                        binding.model = desired.configuration.model.clone();
                        binding.provider_family = desired.configuration.provider_family.clone();
                        binding.configuration_generation =
                            desired.configuration.configuration_generation;
                        binding.credential_scope = desired.credential_scope.clone();
                    }
                    if let Some(source) = launch
                        .selection
                        .source
                        .as_mut()
                        .filter(|source| source.mode == crate::SourceMode::Materialized)
                    {
                        if source.environment_run_id.is_none() {
                            source.environment_run_id = Some(previous.id.clone());
                        }
                    }
                    launch.run_id = next.id.clone();
                    launch.revision = 1;
                    launch.bound_epoch = None;
                    launch.requires_rebind = true;
                    launch.preparation_failure = None;
                    tx.execute(
                        "INSERT INTO run_launches(id,body) VALUES(?1,?2)",
                        params![next.id, encode(&launch)?],
                    )?;
                    event(
                        &tx,
                        &next.id,
                        1,
                        "run.launch_selected",
                        json!({"inherited_from":previous.id}),
                    )?;
                }
            }
            next.id
        } else {
            let owner = owner.as_ref().expect("active owner");
            if command
                .configuration
                .as_ref()
                .is_some_and(|value| value != &owner.configuration)
            {
                return Err(RuntimeError::Invalid(
                    "current-Run input cannot silently change frozen configuration".into(),
                ));
            }
            owner.id.clone()
        };
        let input_id = id();
        let cursor = event(
            &tx,
            &run_id,
            owner.as_ref().map_or(1, |run| run.revision),
            "input.queued",
            json!({"input_id":input_id,"mode":command.mode}),
        )?;
        let input = QueuedInputMetadata {
            id: input_id.clone(),
            thread_id: command.thread_id.clone(),
            branch_id: command.branch_id.clone(),
            run_id: Some(run_id.clone()),
            origin: InputOrigin::UserIngress,
            activation: InputActivation::Activating,
            delivered_cursor: None,
            mode: command.mode,
            state: InputState::Queued,
            revision: 1,
            cursor,
        };
        tx.execute("INSERT INTO input_queue(id,branch_id,run_id,mode,state,cursor,origin,activation,body) VALUES(?1,?2,?3,?4,'queued',?5,'user','activating',?6)",params![input.id,input.branch_id,input.run_id,encode(&input.mode)?.trim_matches('"'),sql_number(cursor)?,encode(&input)?])?;
        tx.execute(
            "INSERT INTO input_history_content(input_id,body) VALUES(?1,?2)",
            params![input.id, encode(&history_content)?],
        )?;
        if immediate {
            let run: Run = record(&tx, "runs", &run_id)?;
            super::activation::bind_pending(&tx, &run)?;
            super::goals::bind_admission(&tx, &run)?;
            deliver(&tx, &run, &input)?;
            tx.execute(
                "UPDATE branches SET active_run=?2 WHERE id=?1",
                params![command.branch_id, run_id],
            )?;
            event(
                &tx,
                &run_id,
                1,
                "run.accepted",
                json!({"input_id":input_id}),
            )?;
        }
        let receipt = InputReceipt {
            input_id,
            run_id,
            mode: command.mode,
            cursor,
        };
        tx.execute(
            "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
            params![command.key, encoded, encode(&receipt)?],
        )?;
        tx.commit()?;
        Ok(QueuedInputAdmission {
            receipt,
            accepted: true,
        })
    }
    pub fn cancel_input(&mut self, id: &str, revision: u64) -> Result<QueuedInputRead> {
        let tx = self.db.transaction()?;
        let mut input: QueuedInputMetadata = record(&tx, "input_queue", id)?;
        if !input.origin.is_user_ingress() {
            return Err(RuntimeError::Invalid(
                "messages are immutable and cannot be cancelled as user input".into(),
            ));
        }
        if input.state == InputState::Cancelled {
            drop(tx);
            return self.capture_queued_input(id);
        }
        if input.state != InputState::Queued || input.revision != revision {
            return Err(RuntimeError::Conflict(
                "input has changed or was already delivered".into(),
            ));
        }
        input.state = InputState::Cancelled;
        input.revision += 1;
        write_input(&tx, &input)?;
        if input.mode == InputMode::NextRun {
            let mut run: Run = record(
                &tx,
                "runs",
                input
                    .run_id
                    .as_deref()
                    .ok_or_else(|| RuntimeError::Invalid("user input Run is missing".into()))?,
            )?;
            super::policy_switch::close_run_candidate(&tx, &run.id, run.revision + 1)?;
            run.state = RunState::Cancelled;
            run.cancel_requested = true;
            run.revision += 1;
            put(&tx, "runs", &run.id, &run)?;
        }
        event(&tx, id, input.revision, "input.cancelled", Value::Null)?;
        tx.commit()?;
        self.capture_queued_input(id)
    }
    pub fn admit_input_delivery(
        &mut self,
        prepared: PreparedInputDelivery,
    ) -> Result<Option<InputBatch>> {
        let PreparedInputDelivery {
            run: captured,
            head,
            selected: queued,
            items,
            _publication,
        } = prepared;
        if captured.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "input delivery belongs to a previous owner".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let run = bodies::validate_delivery(&tx, &captured.id, captured.epoch, head.as_deref())?;
        if super::observations::next(&tx, &run.id)?.is_some() {
            return Ok(Some(InputBatch::default()));
        }
        for input in &queued {
            let current: QueuedInputMetadata = record(&tx, "input_queue", &input.id)?;
            if current != *input
                || current.state != InputState::Queued
                || current.mode == InputMode::NextRun
                || current.branch_id != run.branch_id
                || (current.activation == InputActivation::Activating
                    && current.run_id.as_deref() != Some(run.id.as_str()))
            {
                return Ok(None);
            }
            if followups::ingress_hold(&tx, input, Some(&run))?.is_some() {
                return Ok(None);
            }
        }
        let input_ids = queued
            .iter()
            .filter(|input| input.activation == InputActivation::Activating)
            .map(|input| input.id.clone())
            .collect::<Vec<_>>();
        let activating = !input_ids.is_empty();
        if activating {
            super::goals::detach_ended_for_input(&tx, &run.id)?;
        }
        let superseding = input_ids.last().cloned();
        for input in queued {
            deliver(&tx, &run, &input)?;
        }
        if let Some(input_id) = superseding {
            let mut statement=tx.prepare("SELECT body FROM model_steps WHERE run_id=?1 AND state IN ('interrupted','failed','cancelled')")?;
            let rows = statement.query_map([&run.id], |row| row.get::<_, String>(0))?;
            let mut steps = Vec::new();
            for row in rows {
                steps.push(serde_json::from_str::<ModelStep>(&row?)?);
            }
            drop(statement);
            for mut step in steps {
                if step.superseded_by_input.is_none() {
                    step.superseded_by_input = Some(input_id.clone());
                    put(&tx, "model_steps", &step.id, &step)?;
                }
            }
        }
        tx.commit()?;
        Ok(Some(InputBatch {
            items,
            input_ids,
            activating,
        }))
    }
}
fn deliver(tx: &Transaction<'_>, run: &Run, input: &QueuedInputMetadata) -> Result<()> {
    let reference: String = tx.query_row(
        "SELECT body FROM input_history_content WHERE input_id=?1",
        [&input.id],
        |row| row.get(0),
    )?;
    let history_content: Value = serde_json::from_str(&reference)?;
    let parent: Option<String> = tx.query_row(
        "SELECT head FROM branches WHERE id=?1",
        [&run.branch_id],
        |row| row.get(0),
    )?;
    let item = HistoryItem {
        run_id: run.id.clone(),
        id: input.id.clone(),
        thread_id: run.thread_id.clone(),
        parent,
        source: input.origin.history_source(),
        content: history_content,
        provider: None,
    };
    tx.execute(
        "INSERT INTO history(id,thread_id,parent,body,run_id) VALUES(?1,?2,?3,?4,?5)",
        params![item.id, item.thread_id, item.parent, encode(&item)?, run.id],
    )?;
    tx.execute(
        "UPDATE branches SET head=?2 WHERE id=?1",
        params![run.branch_id, item.id],
    )?;
    let mut input = input.clone();
    input.state = InputState::Delivered;
    input.run_id = Some(run.id.clone());
    input.revision += 1;
    let cursor = event(
        tx,
        &run.id,
        run.revision,
        if input.activation == InputActivation::Activating {
            "input.delivered"
        } else {
            "message.delivered"
        },
        json!({"input_id":input.id,"mode":input.mode}),
    )?;
    input.delivered_cursor = Some(cursor);
    write_input(tx, &input)?;
    followups::delivered(tx, &input)?;
    Ok(())
}
/// Called in the terminating Run's transaction, after releasing its branch execution owner.
pub(super) fn promote_next(tx: &Transaction<'_>, branch: &str) -> Result<Option<String>> {
    let active: Option<String> = tx.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [branch],
        |row| row.get(0),
    )?;
    if active.is_some() {
        return Ok(None);
    }
    loop {
        let raw:Option<String>=tx.query_row("SELECT body FROM input_queue WHERE branch_id=?1 AND mode='next_run' AND state='queued' ORDER BY cursor LIMIT 1",[branch],|row|row.get(0)).optional()?;
        let Some(raw) = raw else {
            return Ok(None);
        };
        let mut input: QueuedInputMetadata = serde_json::from_str(&raw)?;
        let mut run: Run = record(
            tx,
            "runs",
            input
                .run_id
                .as_deref()
                .ok_or_else(|| RuntimeError::Invalid("queued Run is missing".into()))?,
        )?;
        if run.cancel_requested || run.state.terminal() {
            input.state = InputState::Cancelled;
            input.revision += 1;
            write_input(tx, &input)?;
            continue;
        }
        super::goals::bind_admission(tx, &run)?;
        super::activation::bind_pending(tx, &run)?;
        deliver(tx, &run, &input)?;
        run.revision += 1;
        put(tx, "runs", &run.id, &run)?;
        tx.execute(
            "UPDATE branches SET active_run=?2 WHERE id=?1",
            params![branch, run.id],
        )?;
        event(
            tx,
            &run.id,
            run.revision,
            "run.runnable",
            json!({"input_id":input.id}),
        )?;
        return Ok(Some(run.id));
    }
}

pub(super) fn has_boundary_inputs(db: &Connection, run_id: &str) -> Result<bool> {
    let run: Run = record(db, "runs", run_id)?;
    let mut q=db.prepare("SELECT body FROM input_queue WHERE run_id=?1 AND state='queued' AND mode!='next_run' AND activation='activating'")?;
    let rows = q.query_map([run_id], |r| r.get::<_, String>(0))?;
    for raw in rows {
        let row: QueuedInputMetadata = serde_json::from_str(&raw?)?;
        if followups::ingress_hold(db, &row, Some(&run))?.is_none() {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(super) fn cancel_current(tx: &Transaction<'_>, run_id: &str) -> Result<()> {
    super::activation::cancel_run(tx, run_id)?;
    let inputs: Vec<QueuedInputMetadata> = {
        let mut statement = tx.prepare(
            "SELECT body FROM input_queue WHERE run_id=?1 AND state='queued' AND origin='user'",
        )?;
        let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(serde_json::from_str(&row?)?);
        }
        result
    };
    for mut input in inputs {
        input.state = InputState::Cancelled;
        input.revision += 1;
        write_input(tx, &input)?;
        event(
            tx,
            &input.id,
            input.revision,
            "input.cancelled",
            Value::Null,
        )?;
    }
    Ok(())
}
impl Catalog {
    pub fn is_queued_run(&self, run_id: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE run_id=?1 AND state='queued' AND mode='next_run')",[run_id],|row|row.get(0))?)
    }
}

#[path = "catalog_input_content.rs"]
mod bodies;
pub use bodies::{
    InputDeliveryPreparation, InputEditPreparation, PreparedInputDelivery, PreparedInputEdit,
    PreparedQueueInput, QueuePreparation, QueuedInputRead,
};
