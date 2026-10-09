//! Durable ingress held outside the active history until a legal model boundary.
use super::*;
use crate::execution::ConversationItem;

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
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
pub struct InputReceipt {
    pub input_id: String,
    pub run_id: String,
    pub mode: InputMode,
    pub cursor: u64,
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
            tx.execute_batch("CREATE TABLE input_queue(id TEXT PRIMARY KEY,branch_id TEXT NOT NULL REFERENCES branches(id),run_id TEXT NOT NULL REFERENCES runs(id),mode TEXT NOT NULL,state TEXT NOT NULL,cursor INTEGER NOT NULL,body TEXT NOT NULL); CREATE INDEX input_queue_pending ON input_queue(branch_id,run_id,state,mode,cursor); INSERT INTO runtime_domains(name,version) VALUES('input_queue',1);")?;
        }
        Some(1) => {
            let kind: Option<String> = tx
                .query_row(
                    "SELECT type FROM sqlite_master WHERE name='input_queue'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            let columns: Vec<(String, String, i64, i64)> = {
                let mut statement = tx.prepare("PRAGMA table_info(input_queue)")?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get(1)?, row.get(2)?, row.get(3)?, row.get(5)?))
                })?;
                rows.collect::<std::result::Result<_, _>>()?
            };
            let expected = vec![
                ("id", "TEXT", 0, 1),
                ("branch_id", "TEXT", 1, 0),
                ("run_id", "TEXT", 1, 0),
                ("mode", "TEXT", 1, 0),
                ("state", "TEXT", 1, 0),
                ("cursor", "INTEGER", 1, 0),
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
        }
        Some(version) => {
            return Err(RuntimeError::Invalid(format!(
                "unsupported input queue domain version {version}; data was preserved"
            )))
        }
    }
    Ok(())
}
fn write_input(tx: &Transaction<'_>, input: &QueuedInput) -> Result<()> {
    tx.execute(
        "UPDATE input_queue SET state=?2,body=?3 WHERE id=?1",
        params![
            input.id,
            encode(&input.state)?.trim_matches('"'),
            encode(input)?
        ],
    )?;
    Ok(())
}
impl Catalog {
    pub fn enqueue_input(&mut self, command: &EnqueueInput) -> Result<InputReceipt> {
        super::context_jobs::require_regular_branch(&self.db, &command.branch_id)?;
        execution_persistence::user_input_items("admission", &command.input)?;
        let history_content = self.content.save_history(&command.input, &None)?;
        let encoded = encode(command)?;
        let tx = self.db.transaction()?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT input,receipt FROM commands WHERE id=?1",
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
            return Ok(serde_json::from_str(&receipt)?);
        }
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
        let owner:Option<Run>=active.as_ref().map(|id|record(&tx,"runs",id)).transpose()?;
        if owner.as_ref().is_some_and(|run|run.cancel_requested||run.state.terminal()){
            return Err(RuntimeError::Conflict("active Run is closing".into()));
        }
        let predecessor:Option<Run>=if owner.is_some() { owner.clone() } else {
            let body:Option<String>=tx.query_row("SELECT body FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",[&command.branch_id],|r|r.get(0)).optional()?;
            body.map(|body|serde_json::from_str(&body)).transpose()?
        };
        let immediate=owner.is_none();
        let run_id=if command.mode==InputMode::NextRun||immediate {
            let desired: Option<super::models::RunModelSelection> = if command.configuration.is_none() {
                predecessor.as_ref().map(|previous|tx.query_row("SELECT body FROM model_selections WHERE run_id=?1 ORDER BY revision DESC LIMIT 1",[&previous.id],|row|row.get::<_,String>(0)).optional())
                    .transpose()?.flatten().map(|body|serde_json::from_str(&body)).transpose()?
            } else {None};
            let inherited_configuration = desired.as_ref().map(|choice|serde_json::to_value(&choice.configuration)).transpose()?;
            let configuration=command.configuration.clone().or(inherited_configuration).or_else(||predecessor.as_ref().map(|run|run.configuration.clone()))
                .ok_or_else(||RuntimeError::Invalid("an idle branch requires an explicit launch configuration".into()))?;
            let next=Run{id:id(),thread_id:thread,branch_id:command.branch_id.clone(),state:RunState::Accepted,revision:1,epoch:self.epoch,configuration,cancel_requested:false,waiting_on:None};
            // Queued Runs own their admission scope now, not when eventually promoted.
            tx.execute("INSERT INTO runs(id,branch_id,body,context_checkpoint_id) VALUES(?1,?2,?3,(SELECT checkpoint_id FROM active_contexts WHERE branch_id=?2))",params![next.id,next.branch_id,encode(&next)?])?;
            if let Some(previous)=predecessor.as_ref().filter(|previous|previous.configuration==next.configuration || desired.is_some()) {
                if let Some(mut launch)=optional_record::<super::launches::LaunchIntent>(&tx,"run_launches",&previous.id)? {
                    if let Some(desired) = &desired {
                        let binding = &mut launch.selection;
                        binding.connection_identity = if let Some(scope) = &desired.credential_scope {
                            crate::model_session::connection_identity_with_scope(&desired.configuration,scope)
                        } else {crate::model_session::connection_identity(&desired.configuration)}.map_err(|error|RuntimeError::Invalid(error.to_string()))?;
                        binding.model = desired.configuration.model.clone();
                        binding.provider_family = desired.configuration.provider_family.clone();
                        binding.configuration_generation = desired.configuration.configuration_generation;
                        binding.credential_scope = desired.credential_scope.clone();
                    }
                    if let Some(source)=launch.selection.source.as_mut().filter(|source|source.mode == crate::SourceMode::Materialized) {
                        if source.environment_run_id.is_none(){source.environment_run_id=Some(previous.id.clone());}
                    }
                    launch.run_id=next.id.clone();launch.revision=1;launch.bound_epoch=None;launch.requires_rebind=true;launch.preparation_failure=None;
                    tx.execute("INSERT INTO run_launches(id,body) VALUES(?1,?2)",params![next.id,encode(&launch)?])?;
                    event(&tx,&next.id,1,"run.launch_selected",json!({"inherited_from":previous.id}))?;
                }
            }
            next.id
        }else{
            let owner=owner.as_ref().expect("active owner");
            if command.configuration.as_ref().is_some_and(|value|value!=&owner.configuration){return Err(RuntimeError::Invalid("current-Run input cannot silently change frozen configuration".into()));}
            owner.id.clone()
        };
        let input_id = id();
        let cursor = event(
            &tx,
            &run_id,
            owner.as_ref().map_or(1,|run|run.revision),
            "input.queued",
            json!({"input_id":input_id,"mode":command.mode}),
        )?;
        let input = QueuedInput {
            id: input_id.clone(),
            thread_id: command.thread_id.clone(),
            branch_id: command.branch_id.clone(),
            run_id: run_id.clone(),
            mode: command.mode,
            state: InputState::Queued,
            revision: 1,
            content: command.input.clone(),
            cursor,
        };
        tx.execute("INSERT INTO input_queue(id,branch_id,run_id,mode,state,cursor,body) VALUES(?1,?2,?3,?4,'queued',?5,?6)",params![input.id,input.branch_id,input.run_id,encode(&input.mode)?.trim_matches('"'),sql_number(cursor)?,encode(&input)?])?;
        tx.execute("INSERT INTO input_history_content(input_id,body) VALUES(?1,?2)", params![input.id, encode(&history_content)?])?;
        if immediate {
            let run:Run=record(&tx,"runs",&run_id)?;
            deliver(&tx,&run,&input)?;
            tx.execute("UPDATE branches SET active_run=?2 WHERE id=?1",params![command.branch_id,run_id])?;
            event(&tx,&run_id,1,"run.accepted",json!({"input_id":input_id}))?;
        }
        let receipt = InputReceipt {
            input_id,
            run_id,
            mode: command.mode,
            cursor,
        };
        tx.execute(
            "INSERT INTO commands(id,input,receipt) VALUES(?1,?2,?3)",
            params![command.key, encoded, encode(&receipt)?],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn queued_input(&self, id: &str) -> Result<QueuedInput> {
        record(&self.db, "input_queue", id)
    }
    pub fn queued_inputs(&self, branch: &str) -> Result<Vec<QueuedInput>> {
        let mut statement = self
            .db
            .prepare("SELECT body FROM input_queue WHERE branch_id=?1 ORDER BY cursor")?;
        let rows = statement.query_map([branch], |row| row.get::<_, String>(0))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(serde_json::from_str(&row?)?);
        }
        Ok(result)
    }
    pub fn edit_queued_input(
        &mut self,
        id: &str,
        revision: u64,
        content: Value,
    ) -> Result<QueuedInput> {
        let existing = self.queued_input(id)?;
        super::context_jobs::require_regular_branch(&self.db, &existing.branch_id)?;
        execution_persistence::user_input_items(id, &content)?;
        let history_content = self.content.save_history(&content, &None)?;
        let tx = self.db.transaction()?;
        let mut input: QueuedInput = record(&tx, "input_queue", id)?;
        if input.state != InputState::Queued || input.revision != revision {
            return Err(RuntimeError::Conflict(
                "input has changed or was already delivered".into(),
            ));
        }
        input.content = content;
        input.revision += 1;
        write_input(&tx, &input)?;
        if tx.execute("UPDATE input_history_content SET body=?2 WHERE input_id=?1", params![id, encode(&history_content)?])? != 1 {
            return Err(RuntimeError::Invalid("queued history reference missing".into()));
        }
        event(&tx, id, input.revision, "input.edited", Value::Null)?;
        tx.commit()?;
        Ok(input)
    }
    pub fn cancel_queued_input(&mut self, id: &str, revision: u64) -> Result<QueuedInput> {
        let tx = self.db.transaction()?;
        let mut input: QueuedInput = record(&tx, "input_queue", id)?;
        if input.state == InputState::Cancelled {
            return Ok(input);
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
            let mut run: Run = record(&tx, "runs", &input.run_id)?;
            run.state = RunState::Cancelled;
            run.cancel_requested = true;
            run.revision += 1;
            put(&tx, "runs", &run.id, &run)?;
        }
        event(&tx, id, input.revision, "input.cancelled", Value::Null)?;
        tx.commit()?;
        Ok(input)
    }
    pub fn consume_inputs(
        &mut self,
        run_id: &str,
        epoch: u64,
        expected_head: Option<&str>,
    ) -> Result<Vec<ConversationItem>> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if active.as_deref() != Some(run_id) || head.as_deref() != expected_head {
            return Err(RuntimeError::Conflict(
                "input boundary history owner changed".into(),
            ));
        }
        let open:i64=tx.query_row("SELECT (SELECT count(*) FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched'))+(SELECT count(*) FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0)",[run_id],|row|row.get(0))?;
        if open > 0 {
            return Err(RuntimeError::Conflict(
                "input cannot enter an unfinished model/tool exchange".into(),
            ));
        }
        let queued: Vec<QueuedInput> = {
            let mut statement=tx.prepare("SELECT body FROM input_queue WHERE run_id=?1 AND state='queued' AND mode!='next_run' ORDER BY cursor")?;
            let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
            let mut result = Vec::new();
            for row in rows {
                result.push(serde_json::from_str(&row?)?);
            }
            result
        };
        let mut result = Vec::new();
        let superseding = queued.last().map(|input| input.id.clone());
        for input in queued {
            result.extend(deliver(&tx, &run, &input)?);
        }
        if let Some(input_id) = superseding {
            let mut statement=tx.prepare("SELECT body FROM model_steps WHERE run_id=?1 AND state IN ('interrupted','failed','cancelled')")?;
            let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
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
        Ok(result)
    }
}
fn deliver(tx: &Transaction<'_>, run: &Run, input: &QueuedInput) -> Result<Vec<ConversationItem>> {
    let reference: String = tx.query_row("SELECT body FROM input_history_content WHERE input_id=?1", [&input.id], |row| row.get(0))?;
    let history_content: Value = serde_json::from_str(&reference)?;
    let parent: Option<String> = tx.query_row(
        "SELECT head FROM branches WHERE id=?1",
        [&run.branch_id],
        |row| row.get(0),
    )?;
    let item = HistoryItem {
        id: input.id.clone(),
        thread_id: run.thread_id.clone(),
        parent,
        source: HistorySource::User,
        content: history_content,
        provider: None,
    };
    tx.execute(
        "INSERT INTO history(id,thread_id,parent,body) VALUES(?1,?2,?3,?4)",
        params![item.id, item.thread_id, item.parent, encode(&item)?],
    )?;
    tx.execute(
        "UPDATE branches SET head=?2 WHERE id=?1",
        params![run.branch_id, item.id],
    )?;
    let mut input = input.clone();
    input.state = InputState::Delivered;
    input.revision += 1;
    write_input(tx, &input)?;
    event(
        tx,
        &run.id,
        run.revision,
        "input.delivered",
        json!({"input_id":input.id,"mode":input.mode}),
    )?;
    execution_persistence::user_input_items(&input.id, &input.content)
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
        let mut input: QueuedInput = serde_json::from_str(&raw)?;
        let mut run: Run = record(tx, "runs", &input.run_id)?;
        if run.cancel_requested || run.state.terminal() {
            input.state = InputState::Cancelled;
            input.revision += 1;
            write_input(tx, &input)?;
            continue;
        }
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

pub(super) fn has_boundary_inputs(tx: &Transaction<'_>, run_id: &str) -> Result<bool> {
    Ok(tx.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE run_id=?1 AND state='queued' AND mode!='next_run')",[run_id],|row|row.get(0))?)
}
pub(super) fn cancel_current(tx: &Transaction<'_>, run_id: &str) -> Result<()> {
    let inputs: Vec<QueuedInput> = {
        let mut statement =
            tx.prepare("SELECT body FROM input_queue WHERE run_id=?1 AND state='queued'")?;
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
