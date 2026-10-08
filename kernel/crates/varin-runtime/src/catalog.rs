use crate::types::*;
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    path::Path,
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("new user input is waiting at this execution boundary")]
    InputPending,
    #[error("catalog I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("catalog storage: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("catalog data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid transition: {0}")]
    Invalid(String),
    #[error("unsupported catalog format {0}; user history was preserved")]
    Format(i64),
}
type Result<T> = std::result::Result<T, RuntimeError>;
fn sql_number(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| RuntimeError::Invalid("integer exceeds catalog range".into()))
}
fn read_number(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(column)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, value))
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn encode<T: Serialize>(v: &T) -> Result<String> {
    Ok(serde_json::to_string(v)?)
}
fn record<T: DeserializeOwned>(db: &Connection, table: &str, key: &str) -> Result<T> {
    let raw: Option<String> = db
        .query_row(
            &format!("SELECT body FROM {table} WHERE id=?1"),
            [key],
            |r| r.get(0),
        )
        .optional()?;
    serde_json::from_str(&raw.ok_or_else(|| RuntimeError::NotFound(key.into()))?)
        .map_err(Into::into)
}
fn optional_record<T: DeserializeOwned>(
    db: &Connection,
    table: &str,
    key: &str,
) -> Result<Option<T>> {
    match record(db, table, key) {
        Ok(v) => Ok(Some(v)),
        Err(RuntimeError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}
fn put<T: Serialize>(db: &Connection, table: &str, key: &str, v: &T) -> Result<()> {
    db.execute(
        &format!("UPDATE {table} SET body=?2 WHERE id=?1"),
        params![key, encode(v)?],
    )?;
    Ok(())
}
fn event(
    tx: &Transaction<'_>,
    subject: &str,
    revision: u64,
    kind: &str,
    data: Value,
) -> Result<u64> {
    tx.execute(
        "INSERT INTO events(subject,revision,kind,data) VALUES(?1,?2,?3,?4)",
        params![subject, sql_number(revision)?, kind, encode(&data)?],
    )?;
    Ok(tx.last_insert_rowid() as u64)
}
fn fence(run: &Run, epoch: u64) -> Result<()> {
    if run.epoch != epoch || run.state.terminal() {
        return Err(RuntimeError::Conflict(
            "stale or terminal run execution".into(),
        ));
    }
    Ok(())
}

/// Sole writer of native conversation and coordination facts. Holding this value (or its mutex)
/// across model, extension or tool execution is forbidden: all methods are bounded local transactions.
/// Its database is separate from the replaceable system-kernel cache and is never recreated on error.
pub struct Catalog {
    db: Connection,
    content: crate::content::ContentStore,
    _owner: File,
    epoch: u64,
}
impl Catalog {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        std::fs::create_dir_all(root.as_ref())?;
        let owner = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.as_ref().join("runtime.owner"))?;
        owner
            .try_lock_exclusive()
            .map_err(|e| RuntimeError::Conflict(format!("runtime already owned: {e}")))?;
        let mut db = Connection::open(root.as_ref().join("conversation.sqlite"))?;
        db.pragma_update(None, "foreign_keys", true)?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version != 0 && version != 1 && version != 2 && version != 3 {
            return Err(RuntimeError::Format(version));
        }
        let existing: i64 = db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )?;
        if version == 0 && existing != 0 {
            return Err(RuntimeError::Format(0));
        }
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        if version == 0 {
            db.execute_batch(SCHEMA)?;
        }
        let content = crate::content::ContentStore::open(root.as_ref().join("content"))?;
        inputs::initialize(&mut db)?;
        crate::content::initialize(&mut db, &content)?;
        launches::initialize(&mut db)?;
        let epoch: u64 = db.query_row(
            "UPDATE runtime_meta SET epoch=epoch+1 WHERE id=1 RETURNING epoch",
            [],
            |r| read_number(r, 0),
        )?;
        let mut this = Self {
            db,
            content,
            _owner: owner,
            epoch,
        };
        this.recover()?;
        this.reconcile_waits()?;
        Ok(this)
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn create_thread(&mut self, thread_id: &str, branch_id: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO threads(id) VALUES(?1)", [thread_id])?;
        tx.execute(
            "INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,NULL)",
            params![branch_id, thread_id],
        )?;
        event(
            &tx,
            thread_id,
            1,
            "thread.created",
            json!({"branch_id":branch_id}),
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn head(&self, branch: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT head FROM branches WHERE id=?1", [branch], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| RuntimeError::NotFound(branch.into()))?)
    }
    pub fn submit(&mut self, command: &SubmitInput) -> Result<Receipt> {
        execution_persistence::user_input_items("admission",&command.input)?;
        let history_content = self.content.save_history(&command.input, &None)?;
        let input = encode(command)?;
        let tx = self.db.transaction()?;
        let duplicate: Option<(String, String)> = tx
            .query_row(
                "SELECT input,receipt FROM commands WHERE id=?1",
                [&command.key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((old, receipt)) = duplicate {
            if old != input {
                return Err(RuntimeError::Conflict(
                    "idempotency key has different input".into(),
                ));
            }
            return Ok(serde_json::from_str(&receipt)?);
        }
        let (thread, head, active): (String, Option<String>, Option<String>) = tx.query_row(
            "SELECT thread_id,head,active_run FROM branches WHERE id=?1",
            [&command.branch_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if thread != command.thread_id || head != command.expected_head || active.is_some() {
            return Err(RuntimeError::Conflict(
                "branch head or execution owner changed".into(),
            ));
        }
        let input_id = id();
        let run_id = id();
        let history = HistoryItem {
            id: input_id.clone(),
            thread_id: thread.clone(),
            parent: head,
            source: HistorySource::User,
            content: history_content,
            provider: None,
        };
        tx.execute(
            "INSERT INTO history(id,thread_id,parent,body) VALUES(?1,?2,?3,?4)",
            params![input_id, thread, history.parent, encode(&history)?],
        )?;
        let run = Run {
            waiting_on: None,
            id: run_id.clone(),
            thread_id: thread,
            branch_id: command.branch_id.clone(),
            state: RunState::Accepted,
            revision: 1,
            epoch: self.epoch,
            configuration: command.configuration.clone(),
            cancel_requested: false,
        };
        tx.execute(
            "INSERT INTO runs(id,branch_id,body) VALUES(?1,?2,?3)",
            params![run_id, command.branch_id, encode(&run)?],
        )?;
        tx.execute(
            "UPDATE branches SET head=?2,active_run=?3 WHERE id=?1",
            params![command.branch_id, input_id, run_id],
        )?;
        let cursor = event(
            &tx,
            &run_id,
            1,
            "run.accepted",
            json!({"input_id":input_id}),
        )?;
        let receipt = Receipt {
            thread_id: command.thread_id.clone(),
            branch_id: command.branch_id.clone(),
            run_id,
            input_id,
            cursor,
        };
        tx.execute(
            "INSERT INTO commands(id,input,receipt) VALUES(?1,?2,?3)",
            params![command.key, input, encode(&receipt)?],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn run(&self, id: &str) -> Result<Run> {
        record(&self.db, "runs", id)
    }
    pub fn transition_run(
        &mut self,
        id: &str,
        epoch: u64,
        expected_revision: u64,
        next: RunState,
    ) -> Result<Run> {
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", id)?;
        fence(&run, epoch)?;
        if run.revision != expected_revision || !run.state.permits(next) {
            return Err(RuntimeError::Conflict("run revision/state changed".into()));
        }
        if next.terminal() {
            if matches!(next,RunState::Completed|RunState::Failed)&&inputs::has_boundary_inputs(&tx,id)?{return Err(RuntimeError::InputPending);}

            let mut stmt = tx.prepare("SELECT body FROM operations WHERE run_id=?1")?;
            for raw in stmt.query_map([id], |r| r.get::<_, String>(0))? {
                let op: Operation = serde_json::from_str(&raw?)?;
                if op.phase != OperationPhase::Terminal && !op.handed_off {
                    return Err(RuntimeError::Invalid(
                        "unsettled foreground operation".into(),
                    ));
                }
            }
            let pending:i64=tx.query_row("SELECT count(*) FROM model_steps WHERE run_id=?1 AND state IN ('prepared','dispatched')",[id],|r|r.get(0))?;
            if pending != 0 {
                return Err(RuntimeError::Invalid("unsettled model exchange".into()));
            }
            let unpaired:i64=tx.query_row("SELECT count(*) FROM tool_calls c JOIN model_steps m ON m.id=c.request_id WHERE m.run_id=?1 AND c.committed=0",[id],|r|r.get(0))?;
            if unpaired>0{return Err(RuntimeError::Invalid("unsettled tool exchange".into()));}
        }
        if next==RunState::Waiting && run.waiting_on.is_none(){return Err(RuntimeError::Invalid("waiting requires a durable wait".into()));}
        run.state = next;
        if next!=RunState::Waiting {run.waiting_on=None;}
        run.revision += 1;
        put(&tx, "runs", id, &run)?;
        if next.terminal() {
            tx.execute(
                "UPDATE branches SET active_run=NULL WHERE active_run=?1",
                [id],
            )?;
            if next==RunState::Cancelled{inputs::cancel_current(&tx,id)?;}
            inputs::promote_next(&tx,&run.branch_id)?;
        }
        event(
            &tx,
            id,
            run.revision,
            "run.changed",
            serde_json::to_value(&run)?,
        )?;
        tx.commit()?;
        Ok(run)
    }
    pub fn request_cancel_run(&mut self, id: &str) -> Result<Run> {
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", id)?;
        if run.state.terminal() || run.cancel_requested {
            return Ok(run);
        }
        run.cancel_requested = true;
        run.revision += 1;
        put(&tx, "runs", id, &run)?;
        event(&tx, id, run.revision, "run.cancel_requested", Value::Null)?;
        tx.commit()?;
        Ok(run)
    }
    pub fn append_history(
        &mut self,
        run_id: &str,
        epoch: u64,
        expected_head: Option<&str>,
        source: HistorySource,
        content: Value,
        provider: Option<ProviderOriginal>,
    ) -> Result<HistoryItem> {
        let body_reference = self.content.save_history(&content, &provider)?;
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if head.as_deref() != expected_head || active.as_deref() != Some(run_id) {
            return Err(RuntimeError::Conflict("branch changed".into()));
        }
        let mut item = HistoryItem {
            id: id(),
            thread_id: run.thread_id,
            parent: head,
            source,
            content: body_reference,
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
        event(
            &tx,
            &run.branch_id,
            0,
            "history.appended",
            json!({"id":item.id}),
        )?;
        tx.commit()?;
        item.content = content;
        item.provider = provider;
        Ok(item)
    }
    pub fn history(&self, branch: &str) -> Result<Vec<HistoryItem>> {
        let mut head = self.head(branch)?;
        let mut result = Vec::new();
        while let Some(key) = head {
            let item = self.content.hydrate_history(record(&self.db, "history", &key)?)?;
            head = item.parent.clone();
            result.push(item);
        }
        result.reverse();
        Ok(result)
    }
    pub fn fork_branch(
        &mut self,
        source: &str,
        new_branch: &str,
        head: Option<&str>,
    ) -> Result<()> {
        let ancestry = self.history(source)?;
        if head.is_some_and(|head| !ancestry.iter().any(|item| item.id == head)) {
            return Err(RuntimeError::Invalid("fork head is not an ancestor".into()));
        }
        let tx = self.db.transaction()?;
        let thread: String = tx.query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [source],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,?3)",
            params![new_branch, thread, head],
        )?;
        event(
            &tx,
            new_branch,
            1,
            "branch.created",
            json!({"source":source,"head":head}),
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn admit_operation(
        &mut self,
        key: &str,
        run_id: &str,
        epoch: u64,
        lifetime: Lifetime,
        intent: Value,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        if let Some(old) = optional_record::<Operation>(&tx, "operations", key)? {
            if old.run_id == run_id && old.intent == intent && old.lifetime == lifetime {
                return Ok(old);
            }
            return Err(RuntimeError::Conflict("operation identity reused".into()));
        }
        if run.cancel_requested {
            return Err(RuntimeError::Invalid("run cancellation pending".into()));
        }
        let op = Operation {
                            external_receipt:None,
            id: key.into(),
            run_id: run_id.into(),
            epoch,
            revision: 1,
            phase: OperationPhase::Accepted,
            outcome: None,
            effect: Effect::None,
            cancel_requested: false,
            lifetime,
            handed_off: false,
            executor: None,
            waiting_on: None,
            intent,
            result: None,
        };
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![key, run_id, encode(&op)?],
        )?;
        event(
            &tx,
            key,
            1,
            "operation.accepted",
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn operation(&self, key: &str) -> Result<Operation> {
        record(&self.db, "operations", key)
    }
    pub fn dispatch_operation(
        &mut self,
        key: &str,
        epoch: u64,
        executor: &str,
        has_effect: bool,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", key)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        if !op.handed_off {
            fence(&run, epoch)?;
        }
        if op.epoch != epoch
            || op.cancel_requested
            || (!op.handed_off && run.cancel_requested)
            || !matches!(
                op.phase,
                OperationPhase::Accepted | OperationPhase::Preparing | OperationPhase::Queued
            )
        {
            return Err(RuntimeError::Conflict("operation not dispatchable".into()));
        }
        op.phase = OperationPhase::Running;
        op.executor = Some(executor.into());
        op.effect = if has_effect {
            Effect::Dispatched
        } else {
            Effect::None
        };
        op.revision += 1;
        put(&tx, "operations", key, &op)?;
        event(
            &tx,
            key,
            op.revision,
            "operation.dispatched",
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn settle_operation(
        &mut self,
        key: &str,
        epoch: u64,
        outcome: Outcome,
        effect: Effect,
        result: Value,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", key)?;
        if op.epoch != epoch {
            return Err(RuntimeError::Conflict("stale operation executor".into()));
        }
        if op.phase == OperationPhase::Terminal {
            if op.outcome == Some(outcome)
                && op.effect == effect
                && op.result.as_ref() == Some(&result)
            {
                return Ok(op);
            }
            return Err(RuntimeError::Conflict("terminal receipt differs".into()));
        }
        if matches!(
            op.effect,
            Effect::Dispatched | Effect::Partial | Effect::Confirmed | Effect::Unknown
        ) && effect == Effect::None
        {
            return Err(RuntimeError::Invalid(
                "dispatched effect cannot be erased".into(),
            ));
        }
        if effect == Effect::Unknown && outcome != Outcome::Indeterminate {
            return Err(RuntimeError::Invalid(
                "unknown effect requires indeterminate outcome".into(),
            ));
        }
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(outcome);
        op.effect = effect;
        op.result = Some(result);
        op.revision += 1;
        put(&tx, "operations", key, &op)?;
        event(
            &tx,
            key,
            op.revision,
            "operation.settled",
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn request_cancel_operation(&mut self, key: &str) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", key)?;
        if (op.phase == OperationPhase::Terminal && op.outcome!=Some(Outcome::Indeterminate)) || op.cancel_requested {
            return Ok(op);
        }
        op.cancel_requested = true;
        op.revision += 1;
        put(&tx, "operations", key, &op)?;
        event(
            &tx,
            key,
            op.revision,
            "operation.cancel_requested",
            Value::Null,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn handoff_operation(&mut self, key: &str, epoch: u64) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", key)?;
        if op.epoch != epoch || !matches!(op.lifetime, Lifetime::Thread | Lifetime::Environment) {
            return Err(RuntimeError::Invalid(
                "operation lifetime does not permit handoff".into(),
            ));
        }
        if op.handed_off {drop(tx);self.reconcile_waits()?;return Ok(op);}
        op.handed_off = true;
        op.revision += 1;
        if let Some(receipt)=op.external_receipt.clone(){
            execution_persistence::apply_external_terminal(&mut op,&receipt);
            event(&tx,key,op.revision,"operation.settled",serde_json::to_value(&op)?)?;
        }
        put(&tx, "operations", key, &op)?;
        event(&tx, key, op.revision, "operation.handed_off", Value::Null)?;
        tx.commit()?;
        self.reconcile_waits()?;
        Ok(op)
    }
    pub fn prepare_model_step(
        &mut self,
        key: &str,
        run_id: &str,
        epoch: u64,
        request: Value,
    ) -> Result<ModelStep> {
        let request_ref = self.content.save(&request)?;
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        if run.cancel_requested {
            return Err(RuntimeError::Invalid("run cancellation pending".into()));
        }
        if let Some(mut old) = optional_record::<ModelStep>(&tx, "model_steps", key)? {
            if old.run_id == run_id && old.request == request_ref {
                drop(tx);
                old.request = request;
                self.content.hydrate_originals(&mut old.original)?;
                return Ok(old);
            }
            return Err(RuntimeError::Conflict("model step identity reused".into()));
        }
        let mut step = ModelStep {
                    superseded_by_input:None,
            id: key.into(),
            run_id: run_id.into(),
            epoch,
            state: ModelStepState::Prepared,
            request: request_ref,
            original: Vec::new(),
            usage: None,
        };
        tx.execute(
            "INSERT INTO model_steps(id,run_id,state,body) VALUES(?1,?2,'prepared',?3)",
            params![key, run_id, encode(&step)?],
        )?;
        event(&tx, key, 1, "model.prepared", Value::Null)?;
        tx.commit()?;
        step.request = request;
        Ok(step)
    }
    fn hydrate_model_step(&self, mut step: ModelStep) -> Result<ModelStep> {
        step.request = self.content.load(&step.request)?;
        self.content.hydrate_originals(&mut step.original)?;
        Ok(step)
    }
    /// Collect only unreferenced immutable bodies under this catalog owner lock.
    pub fn collect_content_objects(&mut self) -> Result<u64> {
        self.content.collect(&self.db)
    }
    pub fn model_step(&self, key: &str) -> Result<ModelStep> {
        self.hydrate_model_step(record(&self.db, "model_steps", key)?)
    }
    pub fn dispatch_model_step(&mut self, key: &str, epoch: u64) -> Result<ModelStep> {
        let hydrated = self.model_step(key)?;
        let tx = self.db.transaction()?;
        let mut step: ModelStep = record(&tx, "model_steps", key)?;
        let run: Run = record(&tx, "runs", &step.run_id)?;
        fence(&run, epoch)?;
        if step.epoch != epoch || step.state != ModelStepState::Prepared || run.cancel_requested {
            return Err(RuntimeError::Conflict("model step not dispatchable".into()));
        }
        step.state = ModelStepState::Dispatched;
        put(&tx, "model_steps", key, &step)?;
        tx.execute(
            "UPDATE model_steps SET state='dispatched' WHERE id=?1",
            [key],
        )?;
        event(&tx, key, 2, "model.dispatched", Value::Null)?;
        tx.commit()?;
        step.request = hydrated.request;
        step.original = hydrated.original;
        Ok(step)
    }
    pub fn settle_model_step(
        &mut self,
        key: &str,
        epoch: u64,
        state: ModelStepState,
        original: Vec<ProviderOriginal>,
        usage: Option<Value>,
    ) -> Result<ModelStep> {
        let request = self.model_step(key)?.request;
        let stored_original = self.content.save_originals(&original)?;
        let tx = self.db.transaction()?;
        let mut step: ModelStep = record(&tx, "model_steps", key)?;
        if step.epoch != epoch
            || !matches!(
                step.state,
                ModelStepState::Prepared | ModelStepState::Dispatched
            )
            || matches!(state, ModelStepState::Prepared | ModelStepState::Dispatched)
        {
            return Err(RuntimeError::Conflict("model step cannot settle".into()));
        }
        step.state = state;
        step.original = stored_original;
        step.usage = usage;
        put(&tx, "model_steps", key, &step)?;
        tx.execute(
            "UPDATE model_steps SET state=?2 WHERE id=?1",
            params![key, encode(&state)?.trim_matches('"')],
        )?;
        event(&tx, key, 3, "model.settled", json!({"state":state}))?;
        tx.commit()?;
        step.request = request;
        step.original = original;
        Ok(step)
    }
    pub fn register_wait(
        &mut self,
        key: &str,
        run_id: &str,
        subject: &str,
        kind: &str,
        after_cursor: u64,
    ) -> Result<Wait> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        if run.state.terminal() || run.cancel_requested {
            return Err(RuntimeError::Invalid("run cannot wait".into()));
        }
        if let Some(old) = optional_record::<Wait>(&tx, "waits", key)? {
            if old.run_id == run_id
                && old.subject == subject
                && old.kind == kind
                && old.after_cursor == after_cursor
            {
                return Ok(old);
            }
            return Err(RuntimeError::Conflict("wait identity reused".into()));
        }
        let mut wait = Wait {
            id: key.into(),
            run_id: run_id.into(),
            subject: subject.into(),
            kind: kind.into(),
            after_cursor,
            trigger_cursor: None,
            cancelled: false,
        };
        // Registration and retrospective condition check share the same write transaction: no lost wakeup.
        wait.trigger_cursor=tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind=?2 AND cursor>?3 ORDER BY cursor LIMIT 1",params![subject,kind,sql_number(after_cursor)?],|r|read_number(r,0)).optional()?;
        tx.execute(
            "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
            params![key, run_id, encode(&wait)?],
        )?;
        if let Some(cursor) = wait.trigger_cursor {
            Self::enqueue_resume(&tx, &wait, cursor)?;
        }
        event(&tx, key, 1, "wait.registered", serde_json::to_value(&wait)?)?;
        tx.commit()?;
        Ok(wait)
    }
    fn enqueue_resume(tx: &Transaction<'_>, wait: &Wait, cursor: u64) -> Result<()> {
        tx.execute("INSERT INTO resumptions(wait_id,run_id,trigger_cursor,claimed) VALUES(?1,?2,?3,0) ON CONFLICT(wait_id) DO NOTHING",params![wait.id,wait.run_id,sql_number(cursor)?])?;
        Ok(())
    }
    pub fn reconcile_waits(&mut self) -> Result<usize> {
        let tx = self.db.transaction()?;
        let waits: Vec<Wait> = {
            let mut stmt = tx.prepare("SELECT body FROM waits")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(serde_json::from_str(&row?)?);
            }
            out
        };
        let mut count = 0;
        for mut wait in waits {
            if wait.cancelled || wait.trigger_cursor.is_some() {
                continue;
            }
            let run: Run = record(&tx, "runs", &wait.run_id)?;
            if run.state.terminal() || run.cancel_requested {
                continue;
            }
            let cursor:Option<u64>=tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind=?2 AND cursor>?3 ORDER BY cursor LIMIT 1",params![wait.subject,wait.kind,sql_number(wait.after_cursor)?],|r|read_number(r,0)).optional()?;
            if let Some(cursor) = cursor {
                wait.trigger_cursor = Some(cursor);
                put(&tx, "waits", &wait.id, &wait)?;
                Self::enqueue_resume(&tx, &wait, cursor)?;
                event(&tx, &wait.id, 2, "wait.triggered", json!({"cursor":cursor}))?;
                count += 1;
            }
        }
        tx.commit()?;
        Ok(count)
    }
    pub fn cancel_wait(&mut self, key: &str) -> Result<Wait> {
        let tx = self.db.transaction()?;
        let mut wait: Wait = record(&tx, "waits", key)?;
        if !wait.cancelled {
            wait.cancelled = true;
            put(&tx, "waits", key, &wait)?;
            event(&tx, key, 2, "wait.cancelled", Value::Null)?;
        }
        tx.commit()?;
        Ok(wait)
    }
    pub fn claim_resumption(&mut self, key: &str, epoch: u64) -> Result<bool> {
        let tx = self.db.transaction()?;
        let wait: Wait = record(&tx, "waits", key)?;
        let run: Run = record(&tx, "runs", &wait.run_id)?;
        fence(&run, epoch)?;
        if wait.cancelled || run.cancel_requested {
            return Ok(false);
        }
        let changed = tx.execute(
            "UPDATE resumptions SET claimed=?2 WHERE wait_id=?1 AND claimed=0 AND acknowledged=0",
            params![key, sql_number(epoch)?],
        )?;
        if changed > 0 {
            event(
                &tx,
                key,
                3,
                "wait.resumption_claimed",
                json!({"run_id":run.id}),
            )?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }
    /// Acknowledges a durable continuation, not merely an in-memory wakeup. The Run has
    /// already been transitioned to runnable in this same transaction.
    pub fn complete_resumption(&mut self, key: &str, epoch: u64) -> Result<Run> {
        let tx = self.db.transaction()?;
        let wait: Wait = record(&tx, "waits", key)?;
        let mut run: Run = record(&tx, "runs", &wait.run_id)?;
        fence(&run, epoch)?;
        if wait.cancelled || run.cancel_requested {
            return Err(RuntimeError::Conflict("wait cancelled".into()));
        }
        let claimed: i64 = tx.query_row(
            "SELECT claimed FROM resumptions WHERE wait_id=?1 AND acknowledged=0",
            [key],
            |r| r.get(0),
        )?;
        if claimed != sql_number(epoch)? {
            return Err(RuntimeError::Conflict("resumption claim changed".into()));
        }
        if run.state != RunState::Runnable {
            if !run.state.permits(RunState::Runnable) {
                return Err(RuntimeError::Invalid("run cannot resume".into()));
            }
            run.state = RunState::Runnable;
            run.waiting_on=None;
            run.revision += 1;
            put(&tx, "runs", &run.id, &run)?;
            event(
                &tx,
                &run.id,
                run.revision,
                "run.resumed",
                json!({"wait_id":key}),
            )?;
        }
        tx.execute(
            "UPDATE resumptions SET acknowledged=1 WHERE wait_id=?1",
            [key],
        )?;
        tx.commit()?;
        Ok(run)
    }
    pub fn pending_resumptions(&self) -> Result<Vec<String>> {
        let mut stmt = self.db.prepare(
            "SELECT wait_id FROM resumptions WHERE acknowledged=0 ORDER BY trigger_cursor",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn set_delivery(
        &mut self,
        observer: &str,
        fact_cursor: u64,
        request: &str,
        next: DeliveryState,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT state FROM deliveries WHERE observer=?1 AND fact_cursor=?2 AND request=?3",
                params![observer, sql_number(fact_cursor)?, request],
                |r| r.get(0),
            )
            .optional()?;
        let next = encode(&next)?;
        let valid = match old.as_deref() {
            None => next == "\"selected\"",
            Some(old) => {
                old == next
                    || old == "\"selected\"" && next == "\"sent\""
                    || old == "\"sent\"" && next == "\"committed\""
            }
        };
        if !valid {
            return Err(RuntimeError::Invalid(
                "delivery must be selected, sent, then committed".into(),
            ));
        }
        tx.execute("INSERT INTO deliveries(observer,fact_cursor,request,state) VALUES(?1,?2,?3,?4) ON CONFLICT(observer,fact_cursor,request) DO UPDATE SET state=excluded.state",params![observer,sql_number(fact_cursor)?,request,next])?;
        tx.commit()?;
        Ok(())
    }
    pub fn events_after(&self, cursor: u64, limit: u32) -> Result<Vec<Event>> {
        let mut stmt=self.db.prepare("SELECT cursor,subject,revision,kind,data FROM events WHERE cursor>?1 ORDER BY cursor LIMIT ?2")?;
        let rows = stmt.query_map(params![sql_number(cursor)?, limit], |r| {
            Ok((
                read_number(r, 0)?,
                r.get(1)?,
                read_number(r, 2)?,
                r.get(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (cursor, subject, revision, kind, data) = row?;
            result.push(Event {
                cursor,
                subject,
                revision,
                kind,
                data: serde_json::from_str(&data)?,
            });
        }
        Ok(result)
    }
    fn recover(&mut self) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute("UPDATE resumptions SET claimed=0 WHERE acknowledged=0", [])?;
        let runs: Vec<Run> = read_all(&tx, "runs")?;
        for mut run in runs {
            if !run.state.terminal() {
                run.epoch = self.epoch;
                run.revision += 1;
                if matches!(run.state, RunState::Generating | RunState::Executing) {
                    run.state = RunState::Waiting;
                    let key=format!("recovery:{}:{}",run.id,self.epoch);
                    let after_cursor:u64=tx.query_row("SELECT coalesce(max(cursor),0) FROM events",[],|r|read_number(r,0))?;
                    let wait=Wait{id:key.clone(),run_id:run.id.clone(),subject:run.id.clone(),kind:"recovery.reconciled".into(),after_cursor,trigger_cursor:None,cancelled:false};
                    tx.execute("INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",params![key,run.id,encode(&wait)?])?;
                    run.waiting_on=Some(key);
                }
                put(&tx, "runs", &run.id, &run)?;
                event(
                    &tx,
                    &run.id,
                    run.revision,
                    "run.recovered",
                    serde_json::to_value(&run)?,
                )?;
            }
        }
        let steps: Vec<ModelStep> = read_all(&tx, "model_steps")?;
        for mut step in steps {
            if step.state == ModelStepState::Dispatched {
                step.state = ModelStepState::Interrupted;
                put(&tx, "model_steps", &step.id, &step)?;
                tx.execute(
                    "UPDATE model_steps SET state='interrupted' WHERE id=?1",
                    [&step.id],
                )?;
                event(&tx, &step.id, 3, "model.interrupted", Value::Null)?;
            } else if step.state == ModelStepState::Prepared {
                step.epoch = self.epoch;
                put(&tx, "model_steps", &step.id, &step)?;
            }
        }
        let operations: Vec<Operation> = read_all(&tx, "operations")?;
        for mut op in operations {
            if op.phase != OperationPhase::Terminal {
                if matches!(
                    op.effect,
                    Effect::Dispatched | Effect::Partial | Effect::Unknown
                ) {
                    op.phase = OperationPhase::Terminal;
                    op.outcome = Some(Outcome::Indeterminate);
                    op.effect = Effect::Unknown;
                } else if op.phase == OperationPhase::Running {
                    op.phase = OperationPhase::Terminal;
                    op.outcome = Some(Outcome::Failed);
                    op.result = Some(json!({"reason":"executor interrupted"}));
                }
                op.epoch = self.epoch;
                op.revision += 1;
                put(&tx, "operations", &op.id, &op)?;
                event(
                    &tx,
                    &op.id,
                    op.revision,
                    "operation.recovered",
                    serde_json::to_value(&op)?,
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}
fn read_all<T: DeserializeOwned>(db: &Connection, table: &str) -> Result<Vec<T>> {
    let mut stmt = db.prepare(&format!("SELECT body FROM {table}"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut result = Vec::new();
    for row in rows {
        result.push(serde_json::from_str(&row?)?);
    }
    Ok(result)
}
const SCHEMA: &str = r#"
BEGIN IMMEDIATE;
CREATE TABLE runtime_meta(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL);
INSERT INTO runtime_meta VALUES(1,0);
CREATE TABLE threads(id TEXT PRIMARY KEY);
CREATE TABLE branches(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),head TEXT,active_run TEXT);
CREATE TABLE history(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),parent TEXT REFERENCES history(id),body TEXT NOT NULL);
CREATE TABLE runs(id TEXT PRIMARY KEY,branch_id TEXT NOT NULL REFERENCES branches(id),body TEXT NOT NULL);
CREATE TABLE commands(id TEXT PRIMARY KEY,input TEXT NOT NULL,receipt TEXT NOT NULL);
CREATE TABLE operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),body TEXT NOT NULL);
CREATE INDEX operations_run ON operations(run_id);
CREATE TABLE model_steps(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),state TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX model_steps_run ON model_steps(run_id,state);
CREATE UNIQUE INDEX model_steps_active ON model_steps(run_id) WHERE state IN ('prepared','dispatched');
CREATE TABLE model_outputs(request_id TEXT PRIMARY KEY REFERENCES model_steps(id),body TEXT NOT NULL);
CREATE TABLE tool_calls(request_id TEXT NOT NULL REFERENCES model_steps(id),call_id TEXT NOT NULL,body TEXT NOT NULL,receipt TEXT,committed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(request_id,call_id));
CREATE TABLE policy_checkpoints(run_id TEXT PRIMARY KEY REFERENCES runs(id),identity TEXT NOT NULL,state TEXT NOT NULL,action TEXT NOT NULL);
CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,subject TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX events_condition ON events(subject,kind,cursor);
CREATE TABLE waits(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),body TEXT NOT NULL);
CREATE TABLE resumptions(wait_id TEXT PRIMARY KEY REFERENCES waits(id),run_id TEXT NOT NULL REFERENCES runs(id),trigger_cursor INTEGER NOT NULL REFERENCES events(cursor),claimed INTEGER NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE deliveries(observer TEXT NOT NULL,fact_cursor INTEGER NOT NULL REFERENCES events(cursor),request TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(observer,fact_cursor,request));
PRAGMA user_version=1;
COMMIT;
"#;
#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

#[path="catalog_execution.rs"]
mod execution_persistence;

#[path="catalog_inputs.rs"]
pub mod inputs;

#[path="catalog_launch.rs"]
pub mod launches;
