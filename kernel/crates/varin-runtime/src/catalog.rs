use crate::types::OperationMetadata as Operation;
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
    #[error("tool dispatch cancelled before executor entry")]
    DispatchCancelled,
    #[error("Goal authorization or constraints changed at this boundary")]
    GoalChanged,
    #[error("catalog I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("catalog storage: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("catalog data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("request source is still settling")]
    RequestActivationHeld,
    #[error("request activation candidate changed")]
    RequestActivationStale,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid transition: {0}")]
    Invalid(String),
    #[error("unsupported catalog format {0}; user history was preserved")]
    Format(i64),
}
type Result<T> = std::result::Result<T, RuntimeError>;
pub(crate) const FORMAT: i64 = 33;
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

/// A rejected database may contain committed WAL pages. Read-only validation must precede
/// any write-capable SQLite handle: dropping a read/write connection can checkpoint its WAL.
fn inspect_catalog_format(db: &Connection) -> Result<i64> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version != 0 && version != FORMAT {
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
    if version == FORMAT {
        db.prepare("SELECT id,thread_id,parent,run_id,body FROM history")?;
        inputs::check_format(db)?;
        followups::check_format(db)?;
        calendar::check_format(db)?;
        goals::check_format(db)?;
        db.prepare("SELECT run_id,identity,kind,state_ref,pending_state_ref,action_ref,continuation_ref,activation_cursor,pending,wait_id FROM policy_checkpoints")?;
        db.prepare("SELECT action_id,node_id,call_id,position,call,receipt,outcome FROM policy_graph_nodes")?;
        db.prepare("SELECT action_id,node_id,dependency_id FROM policy_graph_dependencies")?;
        db.prepare("SELECT id,run_id,revision,status,active,body FROM model_selections")?;
        db.prepare("SELECT id,run_id,generation,status,body FROM policy_selections")?;
        context_jobs::check_format(db)?;
        launches::check_format(db)?;
        collaboration::check_format(db)?;
        context::check_format(db)?;
        let content_format: i64 = db.query_row(
            "SELECT version FROM runtime_content_format WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if content_format != 3 {
            return Err(RuntimeError::Invalid(
                "unsupported content format; data was preserved".into(),
            ));
        }
    }
    Ok(version)
}

/// Installing the catalog is one commit. A failed first open must leave a new, empty
/// database rather than a collection of independently committed domain fragments.
fn initialize_metadata(
    db: &mut Connection,
    version: i64,
    content: &crate::content::ContentStore,
) -> Result<u64> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if version == 0 {
        tx.execute_batch(SCHEMA)?;
        tx.execute_batch("CREATE TABLE input_history_content(input_id TEXT PRIMARY KEY REFERENCES input_queue(id),body TEXT NOT NULL); CREATE TABLE runtime_content_format(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO runtime_content_format VALUES(1,3);")?;
        tx.pragma_update(None, "user_version", FORMAT)?;
        context_jobs::initialize_new(&tx)?;
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS resource_occupancy (operation_id TEXT PRIMARY KEY REFERENCES operations(id), claims TEXT NOT NULL)")?;
    inputs::initialize(&tx)?;
    crate::content::initialize(&tx, content)?;
    launches::initialize(&tx)?;
    context::initialize(&tx)?;
    if version == 0 {
        collaboration::initialize_new(&tx)?;
        followups::initialize_new(&tx)?;
        calendar::initialize_new(&tx)?;
        goals::initialize_new(&tx)?;
    }
    let epoch = tx.query_row(
        "UPDATE runtime_meta SET epoch=epoch+1 WHERE id=1 RETURNING epoch",
        [],
        |row| read_number(row, 0),
    )?;
    tx.commit()?;
    Ok(epoch)
}

/// Sole writer of conversation and coordination facts. Holding this value (or its mutex)
/// across model, extension or tool execution is forbidden: all methods are bounded local transactions.
/// Its database is separate from the replaceable system-kernel cache and is never recreated on error.
pub struct Catalog {
    db: Connection,
    content: crate::content::ContentStore,
    resource_admission: std::sync::Arc<crate::resource_admission::ResourceAdmission>,
    context_compositions: std::sync::Arc<crate::composition::context::ContextCompositions>,
    _owner: std::sync::Arc<File>,
    database_path: std::path::PathBuf,
    epoch: u64,
    plan_cursor_key: [u8; 32],
    continuation_stopping: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl Catalog {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_resource_admission(
            root,
            std::sync::Arc::new(crate::resource_admission::ResourceAdmission::default()),
        )
    }
    pub fn open_with_resource_admission(
        root: impl AsRef<Path>,
        resource_admission: std::sync::Arc<crate::resource_admission::ResourceAdmission>,
    ) -> Result<Self> {
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
        let database_path = root.as_ref().join("conversation.sqlite");
        let version = if database_path.try_exists()? {
            let preflight = Connection::open_with_flags(
                &database_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            inspect_catalog_format(&preflight)?
        } else {
            0
        };
        let mut db = Connection::open(&database_path)?;
        db.pragma_update(None, "foreign_keys", true)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        let content = crate::content::ContentStore::open(root.as_ref().join("content"))?;
        let epoch = initialize_metadata(&mut db, version, &content)?;
        let mut this = Self {
            db,
            content,
            resource_admission,
            context_compositions: std::sync::Arc::new(
                crate::composition::context::ContextCompositions::default(),
            ),
            _owner: std::sync::Arc::new(owner),
            database_path,
            epoch,
            continuation_stopping: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            plan_cursor_key: {
                let mut key = [0; 32];
                key[..16].copy_from_slice(Uuid::new_v4().as_bytes());
                key[16..].copy_from_slice(Uuid::new_v4().as_bytes());
                key
            },
        };
        this.recover()?;
        {
            let mut rows = this
                .db
                .prepare("SELECT operation_id,claims FROM resource_occupancy")?;
            for row in
                rows.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            {
                let (owner, claims) = row?;
                this.resource_admission
                    .restore(owner, serde_json::from_str(&claims)?);
            }
        }
        this.reconcile_waits()?;
        Ok(this)
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn create_thread(&mut self, thread_id: &str, branch_id: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        let initial:Option<String>=tx.query_row("SELECT json_extract(data,'$.branch_id') FROM events WHERE subject=?1 AND kind='thread.created' ORDER BY cursor LIMIT 1",[thread_id],|r|r.get(0)).optional()?;
        if let Some(initial) = initial {
            if initial == branch_id {
                return Ok(());
            }
            return Err(RuntimeError::Conflict(
                "thread was created with another initial branch".into(),
            ));
        }

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
    fn submit_admission(
        &mut self,
        prepared: submissions::PreparedSubmission,
        context_job: Option<(&context_jobs::ContextJobAdmission, &[Value])>,
    ) -> Result<Receipt> {
        let tx = self.db.transaction()?;
        let receipt = Self::submit_admission_tx(&tx, self.epoch, &prepared, context_job)?;
        tx.commit()?;
        Ok(receipt)
    }
    pub(super) fn submit_admission_tx(
        tx: &Transaction<'_>,
        catalog_epoch: u64,
        prepared: &submissions::PreparedSubmission,
        context_job: Option<(&context_jobs::ContextJobAdmission, &[Value])>,
    ) -> Result<Receipt> {
        // The caller retains the publication lease through its outer commit. Taking this by
        // value would drop that lease before a consume-and-admit transaction commits its roots.
        let command = &prepared.identity;
        let epoch = prepared.epoch;
        let input = prepared.intent.clone();
        let history_content = prepared.history.clone();
        let mut launch = prepared.launch.clone();
        let inherit_source = prepared.inherit_source;
        let initial_context = prepared.initial.as_ref();
        let origin = &prepared.origin;
        if epoch != catalog_epoch {
            return Err(RuntimeError::Conflict(
                "input preparation belongs to a previous owner".into(),
            ));
        }
        let child_operation = match &origin {
            submissions::SubmissionOrigin::Child { operation_id, .. }
            | submissions::SubmissionOrigin::ChildContinuation {
                execution_id: operation_id,
                ..
            } => Some(operation_id.as_str()),
            submissions::SubmissionOrigin::Ingress { execution_id, .. } => execution_id.as_deref(),
            _ => None,
        };
        let create_thread = matches!(origin, submissions::SubmissionOrigin::Summary);
        let duplicate: Option<(String, String)> = tx
            .query_row(
                "SELECT intent,receipt FROM commands WHERE id=?1",
                [&command.key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((old, receipt)) = duplicate {
            if serde_json::from_str::<Value>(&old)? != input {
                return Err(RuntimeError::Conflict(
                    "idempotency key has different input".into(),
                ));
            }
            return Ok(serde_json::from_str(&receipt)?);
        }
        if let submissions::SubmissionOrigin::Ingress { input, .. } = origin {
            let current: inputs::QueuedInputMetadata = record(tx, "input_queue", &input.id)?;
            if current.state == InputState::Cancelled {
                return Err(RuntimeError::DispatchCancelled);
            }
            if ingress::hold(tx, &current, None)?.is_some() {
                return Err(RuntimeError::RequestActivationHeld);
            }
        }
        context_jobs::require_regular_branch(&tx, &command.branch_id)?;
        if let Some(operation_id) = child_operation {
            collaboration::validate_submission(&tx, operation_id, &command)?;
        }
        if let submissions::SubmissionOrigin::User { checkpoint }
        | submissions::SubmissionOrigin::Child { checkpoint, .. }
        | submissions::SubmissionOrigin::ChildContinuation { checkpoint, .. }
        | submissions::SubmissionOrigin::Ingress { checkpoint, .. } = &origin
        {
            let active: Option<String> = tx
                .query_row(
                    "SELECT checkpoint_id FROM active_contexts WHERE branch_id=?1",
                    [&command.branch_id],
                    |row| row.get(0),
                )
                .optional()?;
            if active != *checkpoint {
                return Err(RuntimeError::Conflict(
                    "input context changed during preparation".into(),
                ));
            }
        }
        if create_thread {
            tx.execute("INSERT INTO threads(id) VALUES(?1)", [&command.thread_id])?;
            tx.execute(
                "INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,NULL)",
                params![command.branch_id, command.thread_id],
            )?;
            event(
                &tx,
                &command.thread_id,
                1,
                "thread.created",
                json!({"branch_id":command.branch_id}),
            )?;
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
        if let Some((checkpoint, reference)) = initial_context {
            context::publish_metadata(&tx, &checkpoint, &reference)?;
        }
        if inherit_source {
            let previous: Option<(String, String)> = tx.query_row(
                "SELECT r.id,l.body FROM runs r JOIN run_launches l ON l.id=r.id WHERE r.branch_id=?1 ORDER BY r.rowid DESC LIMIT 1",
                [&command.branch_id], |row| Ok((row.get(0)?,row.get(1)?)),
            ).optional()?;
            if let (Some(selection), Some((previous_run, body))) = (launch.as_mut(), previous) {
                let previous: launch_content::LaunchMetadata = serde_json::from_str(&body)?;
                if selection.child_dispatch_ref.is_none() {
                    selection.child_dispatch_ref = previous.selection.child_dispatch_ref;
                }
                selection.source = previous.selection.source;
                if let Some(source) = selection.source.as_mut() {
                    if source.mode == crate::SourceMode::Materialized
                        && source.environment_run_id.is_none()
                    {
                        source.environment_run_id = Some(previous_run);
                    }
                    selection.tools_ref = previous.selection.base_tools_ref.clone();
                    selection.base_tools_ref = previous.selection.base_tools_ref;
                    selection.tool_schema_generation = selection.configuration_generation;
                }
                if let Some(source) = &selection.source {
                    source.validate()?;
                }
            }
        }
        let input_id = match &origin {
            submissions::SubmissionOrigin::Ingress { input, .. } => input.id.clone(),
            submissions::SubmissionOrigin::Child { operation_id, .. } => {
                format!("child-input:{operation_id}")
            }
            _ => id(),
        };
        let run_id = prepared.run_id.clone();
        let history = HistoryItem {
            run_id: run_id.to_owned(),
            id: input_id.clone(),
            thread_id: thread.clone(),
            parent: head,
            source: if let submissions::SubmissionOrigin::Ingress { input, .. } = origin {
                input.origin.history_source()
            } else if matches!(origin, submissions::SubmissionOrigin::Child { .. }) {
                HistorySource::Agent
            } else {
                HistorySource::User
            },
            content: history_content,
            provider: None,
        };
        tx.execute(
            "INSERT INTO history(id,thread_id,parent,body,run_id) VALUES(?1,?2,?3,?4,?5)",
            params![input_id, thread, history.parent, encode(&history)?, run_id],
        )?;
        let run = Run {
            waiting_on: None,
            id: run_id.clone(),
            thread_id: thread,
            branch_id: command.branch_id.clone(),
            state: RunState::Accepted,
            revision: 1,
            epoch: catalog_epoch,
            configuration: command.configuration.clone(),
            cancel_requested: false,
        };
        // Freeze admission provenance, not the evolving execution context. Historical Run
        // activity must never inherit a project first attached to this branch later.
        tx.execute(
            "INSERT INTO runs(id,branch_id,body,context_checkpoint_id) VALUES(?1,?2,?3,(SELECT checkpoint_id FROM active_contexts WHERE branch_id=?2))",
            params![run_id, command.branch_id, encode(&run)?],
        )?;
        tx.execute(
            "UPDATE branches SET head=?2,active_run=?3 WHERE id=?1",
            params![command.branch_id, input_id, run_id],
        )?;
        if let Some(selection) = launch {
            if let Some(source) = selection.source.as_ref() {
                if let Some(origin_id) = source.environment_run_id.as_ref() {
                    let origin_run: Run = record(&tx, "runs", origin_id)?;
                    let origin: launch_content::LaunchMetadata =
                        record(&tx, "run_launches", origin_id)?;
                    let mut same_source = source.clone();
                    same_source.environment_run_id = None;
                    if origin_run.thread_id != run.thread_id
                        || source.mode != crate::SourceMode::Materialized
                        || origin.selection.source.as_ref() != Some(&same_source)
                    {
                        return Err(RuntimeError::Conflict(
                            "environment continuation must preserve the original thread source"
                                .into(),
                        ));
                    }
                }
            }
            let intent = launch_content::LaunchMetadata {
                dispatch_context_ref: None,
                policy_generation: 0,
                policy_target: policy_switch::PolicyTarget::Default,
                run_id: run_id.clone(),
                revision: 1,
                selection,
                bound_epoch: None,
                requires_rebind: true,
                preparation_failure: None,
            };
            tx.execute(
                "INSERT INTO run_launches(id,body) VALUES(?1,?2)",
                params![run_id, encode(&intent)?],
            )?;
            event(&tx, &run_id, 1, "run.launch_selected", Value::Null)?;
        }
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
            "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
            params![command.key, encode(&input)?, encode(&receipt)?],
        )?;
        if let Some(operation_id) = child_operation {
            collaboration::publish_submission(&tx, operation_id, &receipt)?;
        }
        if let submissions::SubmissionOrigin::Ingress { input, .. } = origin {
            activation::delivered_submission(tx, input, &run, cursor)?;
        }
        activation::bind_pending(tx, &run)?;
        // The exact delegated trigger must be visible to Goal admission in this same
        // transaction. A new explicit User Run may outlive a completed parent Goal.
        goals::bind_admission(tx, &run)?;
        if let Some((job, parts)) = context_job {
            job.publish(&tx, &receipt.run_id, parts)?;
        }
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
        if run.state == RunState::Waiting
            && next == RunState::Runnable
            && !policy_control::run_startable(&tx, &run)?
        {
            return Err(RuntimeError::Conflict(
                "Run is waiting on another durable condition".into(),
            ));
        }
        if next.terminal() {
            if matches!(next, RunState::Cancelled | RunState::Failed) {
                questions::cancel_run_questions(&tx, id)?;
                policy_control::cancel_run_pause(&tx, &run)?;
            }
            if matches!(next, RunState::Completed | RunState::Failed)
                && inputs::has_boundary_inputs(&tx, id)?
            {
                return Err(RuntimeError::InputPending);
            }

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
            if unpaired > 0 {
                return Err(RuntimeError::Invalid("unsettled tool exchange".into()));
            }
        }
        if next == RunState::Waiting && run.waiting_on.is_none() {
            return Err(RuntimeError::Invalid(
                "waiting requires a durable wait".into(),
            ));
        }
        if next.terminal() {
            policy_switch::close_run_candidate(&tx, id, run.revision + 1)?;
        }
        run.state = next;
        if next == RunState::Cancelled && !run.cancel_requested {
            followups::cancel_source_run(&tx, id)?;
        }
        if next.terminal() {
            followups::settle_run(&tx, &run)?;
        }
        if next != RunState::Waiting {
            run.waiting_on = None;
        }
        run.revision += 1;
        put(&tx, "runs", id, &run)?;
        if next.terminal() {
            tx.execute(
                "UPDATE branches SET active_run=NULL WHERE active_run=?1",
                [id],
            )?;
            if next == RunState::Cancelled {
                inputs::cancel_current(&tx, id)?;
            }
            inputs::promote_next(&tx, &run.branch_id)?;
        }
        event(
            &tx,
            id,
            run.revision,
            "run.changed",
            serde_json::to_value(&run)?,
        )?;
        if run.state.terminal() {
            goals::settle_run(&tx, &run)?;
        }
        tx.commit()?;
        Ok(run)
    }
    pub fn request_cancel_run(&mut self, id: &str) -> Result<Run> {
        let tx = self.db.transaction()?;
        let result = request_cancel_run_in(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn append_history(
        &mut self,
        run_id: &str,
        epoch: u64,
        expected_head: Option<&str>,
        source: HistorySource,
        content: Value,
        provider: Option<ProviderOriginal>,
    ) -> Result<HistoryItem> {
        let _synchronous = self.content.begin_synchronous()?;
        context_jobs::require_regular_branch(&self.db, &self.run(run_id)?.branch_id)?;
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
            run_id: run_id.to_owned(),
            id: id(),
            thread_id: run.thread_id,
            parent: head,
            source,
            content: body_reference,
            provider: None,
        };
        tx.execute(
            "INSERT INTO history(id,thread_id,parent,body,run_id) VALUES(?1,?2,?3,?4,?5)",
            params![item.id, item.thread_id, item.parent, encode(&item)?, run_id],
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
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn history(&self, branch: &str) -> Result<Vec<HistoryItem>> {
        let _synchronous = self.content.begin_synchronous()?;
        let mut head = self.head(branch)?;
        let mut result = Vec::new();
        while let Some(key) = head {
            let item = self
                .content
                .hydrate_history(record(&self.db, "history", &key)?)?;
            head = item.parent.clone();
            result.push(item);
        }
        result.reverse();
        Ok(result)
    }
    pub fn branch_thread_id(&self, branch_id: &str) -> Result<String> {
        self.db
            .query_row(
                "SELECT thread_id FROM branches WHERE id=?1",
                [branch_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| RuntimeError::NotFound(branch_id.into()))
    }
    pub fn admit_operation(
        &mut self,
        key: &str,
        run_id: &str,
        epoch: u64,
        lifetime: Lifetime,
        intent: Value,
    ) -> Result<Operation> {
        if intent
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| {
                kind == "tool"
                    || kind.starts_with("policy_tool_graph")
                    || kind.starts_with("policy_model_job")
            })
        {
            return Err(RuntimeError::Invalid(
                "typed operations require their admission owner".into(),
            ));
        }
        self.admit_operation_metadata(key, run_id, epoch, lifetime, intent)
    }
    pub(super) fn admit_operation_metadata(
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
            external_receipt: None,
            call_completion: None,
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
            execution_owner: None,
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
        if policy_body::PolicyActionMetadata::from_operation(&op)?.is_some() {
            return Err(RuntimeError::Invalid(
                "policy actions require their typed dispatch owner".into(),
            ));
        }
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
    pub fn settle_operation_prepared(
        &mut self,
        key: &str,
        epoch: u64,
        outcome: Outcome,
        effect: Effect,
        prepared: result_content::PreparedOperationResult,
    ) -> Result<Operation> {
        let result = OperationResultMetadata::Content {
            reference: prepared.reference,
        };
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", key)?;
        if policy_body::PolicyActionMetadata::from_operation(&op)?.is_some() {
            return Err(RuntimeError::Invalid(
                "policy actions settle through their typed owner".into(),
            ));
        }
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
        if outcome != Outcome::Indeterminate {
            tx.execute(
                "DELETE FROM resource_occupancy WHERE operation_id=?1",
                [key],
            )?;
        }
        tx.commit()?;
        if outcome != Outcome::Indeterminate {
            self.resource_admission.release(key);
        }
        Ok(op)
    }
    pub fn request_cancel_operation(&mut self, key: &str) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let result = request_cancel_operation_in(&tx, key)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn handoff_operation(&mut self, key: &str, epoch: u64) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", key)?;
        if op.epoch != epoch || !matches!(op.lifetime, Lifetime::Thread | Lifetime::Environment) {
            return Err(RuntimeError::Invalid(
                "operation lifetime does not permit handoff".into(),
            ));
        }
        if op.handed_off {
            drop(tx);
            self.reconcile_waits()?;
            return Ok(op);
        }
        op.handed_off = true;
        op.revision += 1;
        if let Some(receipt) = op.external_receipt.clone() {
            execution_persistence::apply_external_terminal(&mut op, &receipt);
            event(
                &tx,
                key,
                op.revision,
                "operation.settled",
                serde_json::to_value(&op)?,
            )?;
        }
        put(&tx, "operations", key, &op)?;
        event(&tx, key, op.revision, "operation.handed_off", Value::Null)?;
        tx.commit()?;
        self.reconcile_waits()?;
        Ok(op)
    }
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn prepare_model_step(
        &mut self,
        key: &str,
        run_id: &str,
        epoch: u64,
        request: Value,
    ) -> Result<ModelStep> {
        let _synchronous = self.content.begin_synchronous()?;
        let request_ref = self.content.save(&request)?;
        let tx = self.db.transaction()?;
        let graph_pending = policy_body::has_pending_action(&tx, run_id)?;
        if graph_pending {
            return Err(RuntimeError::Conflict("policy action is unsettled".into()));
        }
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
            goal: None,
            superseded_by_input: None,
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
    /// Short admission only. The returned owned collection must run after releasing Catalog.
    pub fn prepare_content_collection(
        &self,
        cancellation: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> crate::content::ContentCollectionAdmission {
        self.content.prepare_collection(
            self.database_path.clone(),
            self._owner.clone(),
            cancellation,
        )
    }
    /// Request cooperative maintenance shutdown without waiting for I/O or a worker.
    pub fn cancel_content_collection(&self) {
        self.content.cancel_collection();
    }
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn model_step(&self, key: &str) -> Result<ModelStep> {
        let _synchronous = self.content.begin_synchronous()?;
        self.capture_model_step_read(key)?.load()
    }
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn dispatch_model_step(&mut self, key: &str, epoch: u64) -> Result<ModelStep> {
        let _synchronous = self.content.begin_synchronous()?;
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
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn settle_model_step(
        &mut self,
        key: &str,
        epoch: u64,
        state: ModelStepState,
        original: Vec<ProviderOriginal>,
        usage: Option<Value>,
    ) -> Result<ModelStep> {
        let _synchronous = self.content.begin_synchronous()?;
        let request = self.model_step(key)?.request;
        let stored_original = self.content.save_originals(&original)?;
        let tx = self.db.transaction()?;
        let mut step: ModelStep = record(&tx, "model_steps", key)?;
        if step.epoch != epoch
            || !matches!(
                step.state,
                ModelStepState::Prepared | ModelStepState::Dispatched
            )
            || matches!(
                state,
                ModelStepState::Prepared
                    | ModelStepState::Dispatched
                    | ModelStepState::NotDispatched
            )
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
            deadline_at_ms: None,
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
            if wait.kind == messages::reply_wait::REPLY_EVENT {
                if messages::reply_wait::resolve(&tx, &mut wait, observations::wall_time_ms()?)? {
                    count += 1;
                }
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
        if wait.cancelled
            || run.cancel_requested
            || run.state != RunState::Waiting
            || run.waiting_on.as_deref() != Some(key)
            || wait.trigger_cursor.is_none()
            || wait.kind == "policy.resumed"
        {
            return Err(RuntimeError::Conflict(
                "wait no longer owns this Run continuation".into(),
            ));
        }
        let active: Option<String> = tx.query_row(
            "SELECT active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |row| row.get(0),
        )?;
        if active.as_deref() != Some(&run.id) {
            return Err(RuntimeError::Conflict(
                "resumption branch owner changed".into(),
            ));
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
            run.waiting_on = None;
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
        let interrupted_read: bool = self.db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM operations WHERE json_extract(body,'$.phase')='running' AND json_extract(body,'$.effect')='none' AND coalesce(json_extract(body,'$.intent.kind'),'') NOT IN ({}))", policy_body::ACTION_KINDS), [], |row|row.get(0))?;
        let interrupted_result = interrupted_read
            .then(|| self.content.save(&json!({"reason":"executor interrupted"})))
            .transpose()?;
        let tx = self.db.transaction()?;
        policy_switch::interrupt_candidates(&tx)?;
        tx.execute("UPDATE resumptions SET claimed=0 WHERE acknowledged=0", [])?;
        let runs: Vec<Run> = read_all(&tx, "runs")?;
        for mut run in runs {
            if !run.state.terminal() {
                run.epoch = self.epoch;
                run.revision += 1;
                if matches!(run.state, RunState::Generating | RunState::Executing) {
                    run.state = RunState::Waiting;
                    let key = format!("recovery:{}:{}", run.id, self.epoch);
                    let after_cursor: u64 =
                        tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
                            read_number(r, 0)
                        })?;
                    let wait = Wait {
                        id: key.clone(),
                        run_id: run.id.clone(),
                        subject: run.id.clone(),
                        kind: "recovery.reconciled".into(),
                        after_cursor,
                        deadline_at_ms: None,
                        trigger_cursor: None,
                        cancelled: false,
                    };
                    tx.execute(
                        "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
                        params![key, run.id, encode(&wait)?],
                    )?;
                    run.waiting_on = Some(key);
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
                if step.usage.is_none() {
                    let usage = crate::execution::UsageReceipt::default();
                    goals::measured(&tx, step.goal.as_ref(), &usage)?;
                    step.usage = Some(serde_json::to_value(usage)?);
                }
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
            if policy_model::model_metadata(&op)?.is_some() {
                let mut result = policy_model::model_result(&op)?;
                if result.dispatch == crate::execution::PolicyModelDispatch::Dispatched
                    && result.receipt.is_none()
                {
                    let output: crate::execution::PolicyModelOutput = result
                        .original_ref
                        .as_ref()
                        .map(|r| {
                            self.content
                                .load(r)
                                .and_then(|v| Ok(serde_json::from_value(v)?))
                        })
                        .transpose()?
                        .unwrap_or_default();
                    goals::measured(&tx, result.goal.as_ref(), &output.usage)?;
                    result.dispatch = crate::execution::PolicyModelDispatch::Interrupted;
                    result.receipt=Some(crate::execution::PolicyModelReceipt{dispatch:crate::execution::PolicyModelDispatch::Interrupted,outcome:Outcome::Indeterminate,output:None,usage:output.usage,finish_reason:None,failure:Some(crate::execution::ModelFailure{code:"planning_interrupted".into(),message:"dispatch intent was durable; completion is unknown and request will not replay".into(),retry_after_ms:None,provider_request_id:None}),usable:false});
                    op.phase = OperationPhase::Terminal;
                    op.outcome = Some(Outcome::Indeterminate);
                    op.revision += 1;
                    op.result = Some(OperationResultMetadata::Control {
                        value: serde_json::to_value(result)?,
                    });
                    event(
                        &tx,
                        &op.id,
                        op.revision,
                        "policy.model_interrupted",
                        Value::Null,
                    )?;
                }
                op.epoch = self.epoch;
                put(&tx, "operations", &op.id, &op)?;
                continue;
            }
            if let Some(intent) = policy::graph_metadata(&op)? {
                policy_body::PolicyGraphProgress::read(&op, &intent)?;
                // The graph owns orchestration only. Each durable node retains its own invocation/dispatch evidence; only trusted light reads can replay.
                op.epoch = self.epoch;
                put(&tx, "operations", &op.id, &op)?;
                continue;
            }
            if policy_body::PolicyActionMetadata::from_operation(&op)?.is_some() {
                op.epoch = self.epoch;
                put(&tx, "operations", &op.id, &op)?;
                continue;
            }
            // Only an explicitly kernel-owned Result ends with this process. Host/broker and
            // remote calls may survive it, even when their caller contract returns a Result.
            // This is stop evidence only; it never resolves an unknown business effect.
            let occupied: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM resource_occupancy WHERE operation_id=?1)",
                [&op.id],
                |r| r.get(0),
            )?;
            if occupied {
                let tool = tool_content::ToolIntent::from_operation(&op)?;
                if tool.contract().completion == crate::execution::CompletionKind::Result
                    && op.execution_owner == Some(ExecutorOwner::Kernel)
                {
                    tx.execute(
                        "DELETE FROM resource_occupancy WHERE operation_id=?1",
                        [&op.id],
                    )?;
                }
            }
            if op.phase != OperationPhase::Terminal {
                // A dispatched effect is reconciled under its original intent generation.
                // Only work that may actually be readmitted acquires this owner's epoch.
                // Run/graph fencing still governs every new execution and receipt consumer.
                let preserve_dispatch_epoch = matches!(
                    op.effect,
                    Effect::Dispatched | Effect::Partial | Effect::Unknown
                );
                // A live user's one-action decision cannot survive its authorizing owner.
                if op.effect == Effect::None && op.result.as_ref().is_some_and(|v| matches!(v, OperationResultMetadata::Control { value } if value.get("permission").is_some())) {
                    if let Some(wait_id) = &op.waiting_on {
                        let mut wait: Wait = record(&tx, "waits", wait_id)?;
                        wait.cancelled = true;
                        put(&tx, "waits", wait_id, &wait)?;
                    }
                    op.phase = OperationPhase::Accepted;
                    op.waiting_on = None;
                    op.result = None;
                }
                if matches!(
                    op.effect,
                    Effect::Dispatched | Effect::Partial | Effect::Unknown
                ) {
                    op.phase = OperationPhase::Terminal;
                    op.outcome = Some(Outcome::Indeterminate);
                    op.effect = Effect::Unknown;
                } else if op.phase == OperationPhase::Running {
                    op.phase = OperationPhase::Terminal;
                    if op.intent.get("kind").and_then(Value::as_str) == Some("tool")
                        && (tool_content::ToolIntent::from_operation(&op)?
                            .contract()
                            .completion
                            == crate::execution::CompletionKind::Job
                            || matches!(op.execution_owner, Some(ExecutorOwner::External { .. })))
                    {
                        // A background executor may still run without business side effects.
                        // Keep its original call receipt and occupancy until that owner reports.
                        op.outcome = Some(Outcome::Indeterminate);
                    } else {
                        op.outcome = Some(Outcome::Failed);
                        op.result = Some(OperationResultMetadata::Content {
                            reference: interrupted_result
                                .as_ref()
                                .ok_or_else(|| {
                                    RuntimeError::Invalid(
                                        "interrupted result was not prepared".into(),
                                    )
                                })?
                                .clone(),
                        });
                    }
                }
                if !preserve_dispatch_epoch {
                    op.epoch = self.epoch;
                }
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
CREATE TABLE runtime_meta(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL);
INSERT INTO runtime_meta VALUES(1,0);
CREATE TABLE threads(id TEXT PRIMARY KEY);
CREATE TABLE branches(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),head TEXT,active_run TEXT);
CREATE INDEX branches_thread ON branches(thread_id);
CREATE TABLE history(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),parent TEXT REFERENCES history(id),run_id TEXT NOT NULL REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,body TEXT NOT NULL);
CREATE INDEX history_run ON history(run_id);
CREATE TABLE runs(id TEXT PRIMARY KEY,branch_id TEXT NOT NULL REFERENCES branches(id),body TEXT NOT NULL,context_checkpoint_id TEXT REFERENCES context_checkpoints(id));
CREATE INDEX runs_branch ON runs(branch_id);
CREATE INDEX runs_waiting ON runs(json_extract(body,'$.waiting_on')) WHERE json_extract(body,'$.state')='waiting';
CREATE TABLE commands(id TEXT PRIMARY KEY,intent TEXT NOT NULL,receipt TEXT NOT NULL);
CREATE TABLE operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),body TEXT NOT NULL);
CREATE INDEX operations_run ON operations(run_id);
CREATE TABLE model_steps(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),state TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX model_steps_run ON model_steps(run_id,state);
CREATE TABLE model_selections(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),revision INTEGER NOT NULL,status TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0,body TEXT NOT NULL,UNIQUE(run_id,revision));
CREATE UNIQUE INDEX model_selections_active ON model_selections(run_id) WHERE active=1;
CREATE UNIQUE INDEX model_steps_active ON model_steps(run_id) WHERE state IN ('prepared','dispatched');
CREATE TABLE model_outputs(request_id TEXT PRIMARY KEY REFERENCES model_steps(id),body TEXT NOT NULL);
CREATE TABLE tool_calls(request_id TEXT NOT NULL REFERENCES model_steps(id),call_id TEXT NOT NULL,body TEXT NOT NULL,receipt TEXT,committed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(request_id,call_id));
CREATE TABLE policy_checkpoints(run_id TEXT PRIMARY KEY REFERENCES runs(id),identity TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('decision','activation')),state_ref TEXT NOT NULL,pending_state_ref TEXT,action_ref TEXT,continuation_ref TEXT,activation_cursor INTEGER,pending INTEGER NOT NULL,wait_id TEXT,CHECK((pending=1 AND pending_state_ref IS NOT NULL) OR (pending=0 AND pending_state_ref IS NULL)),CHECK((kind='decision' AND action_ref IS NOT NULL) OR (kind='activation' AND action_ref IS NULL AND pending=0)));
CREATE TABLE policy_selections(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),generation INTEGER NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(run_id,generation));
CREATE TABLE policy_graph_nodes(action_id TEXT NOT NULL REFERENCES operations(id),node_id TEXT NOT NULL,call_id TEXT NOT NULL,position INTEGER NOT NULL,call TEXT NOT NULL,receipt TEXT,outcome TEXT,PRIMARY KEY(action_id,node_id),UNIQUE(action_id,call_id),UNIQUE(action_id,position));
CREATE TABLE policy_graph_dependencies(action_id TEXT NOT NULL,node_id TEXT NOT NULL,dependency_id TEXT NOT NULL,PRIMARY KEY(action_id,node_id,dependency_id),FOREIGN KEY(action_id,node_id) REFERENCES policy_graph_nodes(action_id,node_id),FOREIGN KEY(action_id,dependency_id) REFERENCES policy_graph_nodes(action_id,node_id));
CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,subject TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX events_condition ON events(subject,kind,cursor);
CREATE TABLE waits(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),body TEXT NOT NULL);
CREATE TABLE resumptions(wait_id TEXT PRIMARY KEY REFERENCES waits(id),run_id TEXT NOT NULL REFERENCES runs(id),trigger_cursor INTEGER NOT NULL REFERENCES events(cursor),claimed INTEGER NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE deliveries(observer TEXT NOT NULL,fact_cursor INTEGER NOT NULL REFERENCES events(cursor),request TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(observer,fact_cursor,request));
"#;
#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

#[path = "catalog_execution.rs"]
mod execution_persistence;

#[path = "catalog_inputs.rs"]
pub mod inputs;

#[path = "catalog_goals.rs"]
pub mod goals;

#[path = "catalog_followups.rs"]
pub mod followups;

#[path = "catalog_submission.rs"]
pub mod submissions;

#[path = "catalog_launch.rs"]
pub mod launches;

#[path = "catalog_launch_content.rs"]
pub mod launch_content;

#[path = "catalog_delegated.rs"]
pub mod delegated;

#[path = "catalog_child_content.rs"]
pub mod child_content;
#[path = "catalog_child_delivery.rs"]
pub mod child_delivery;
#[path = "catalog_permission_content.rs"]
pub mod permission_content;
#[path = "catalog_policy_body.rs"]
pub(crate) mod policy_body;
#[path = "catalog_policy_checkpoint.rs"]
pub(crate) mod policy_checkpoint;
#[path = "catalog_tool_content.rs"]
pub mod tool_content;

#[path = "catalog_tools.rs"]
pub mod tools;

#[path = "catalog_recovery.rs"]
pub mod recovery;

#[path = "catalog_observe.rs"]
mod observe;

#[path = "catalog_context.rs"]
pub mod context;

#[path = "catalog_family.rs"]
pub mod family;
#[path = "catalog_messages.rs"]
pub mod messages;
#[path = "catalog_observations.rs"]
pub mod observations;

#[path = "catalog_history.rs"]
pub mod history_views;

#[path = "catalog_fork.rs"]
pub mod forks;

#[path = "catalog_context_jobs.rs"]
pub mod context_jobs;

#[path = "catalog_questions.rs"]
pub mod questions;

#[path = "catalog_resources.rs"]
pub mod resources;

#[path = "catalog_personalization.rs"]
pub mod personalization;

#[path = "catalog_permissions.rs"]
pub mod permissions;

#[path = "catalog_policy.rs"]
pub(crate) mod policy;

#[path = "catalog_policy_model.rs"]
pub(crate) mod policy_model;

#[path = "catalog_dispatch.rs"]
pub mod dispatch;

#[path = "catalog_collaboration.rs"]
pub mod collaboration;
#[path = "catalog_memory.rs"]
pub mod memory;
#[path = "catalog_memory_state.rs"]
pub mod memory_state;

#[path = "catalog_scheduling.rs"]
mod scheduling;

#[path = "catalog_process_wait.rs"]
pub mod process_wait;

#[path = "catalog_plan.rs"]
pub mod plan;

#[path = "catalog_models.rs"]
pub mod models;

#[path = "catalog_result_content.rs"]
pub mod result_content;

#[path = "catalog_process_delivery.rs"]
pub mod process_delivery;

#[path = "catalog_policy_control.rs"]
pub mod policy_control;

#[path = "catalog_policy_switch.rs"]
pub mod policy_switch;

impl Drop for Catalog {
    fn drop(&mut self) {
        self.content.cancel_collection();
    }
}

#[cfg(test)]
#[path = "catalog_content_collection_tests.rs"]
mod content_collection_tests;

pub(super) fn request_cancel_run_in(tx: &Transaction<'_>, id: &str) -> Result<Run> {
    let mut run: Run = record(tx, "runs", id)?;
    if run.state.terminal() || run.cancel_requested {
        return Ok(run);
    }
    run.cancel_requested = true;
    activation::cancel_run(tx, id)?;
    calendar::cancel_branch_pending(tx, &run.thread_id, &run.branch_id)?;
    followups::cancel_source_run(tx, id)?;
    goals::cancel_run(tx, id)?;
    if run.state == RunState::Waiting {
        questions::cancel_run_questions(tx, id)?;
        policy_control::cancel_run_pause(tx, &run)?;
    }
    run.revision += 1;
    put(tx, "runs", id, &run)?;
    event(tx, id, run.revision, "run.cancel_requested", Value::Null)?;
    Ok(run)
}

pub(super) fn request_cancel_operation_in(tx: &Transaction<'_>, key: &str) -> Result<Operation> {
    let mut op: Operation = record(tx, "operations", key)?;
    if matches!(
        policy_body::PolicyActionMetadata::from_operation(&op)?,
        Some(policy_body::PolicyActionMetadata::PolicyPauseV1 { .. })
    ) {
        return Err(RuntimeError::Invalid(
            "policy pause requires explicit Run resume or Run cancellation".into(),
        ));
    }
    let unproven_process = op.execution_owner == Some(ExecutorOwner::Kernel)
        && op.executor.as_deref() == Some("process_spawn")
        && op.effect != Effect::None
        && !op
            .external_receipt
            .as_ref()
            .is_some_and(|receipt| receipt.executor_stopped);
    // The direct control signal may let the worker commit Cancelled before this
    // transaction runs. Preserve the caller's explicit cancellation fact once,
    // without rewriting the already-established outcome or ordinary terminal work.
    if (op.phase == OperationPhase::Terminal
        && !matches!(
            op.outcome,
            Some(Outcome::Indeterminate | Outcome::Cancelled)
        )
        && !unproven_process)
        || op.cancel_requested
    {
        return Ok(op);
    }
    op.cancel_requested = true;
    op.revision += 1;
    put(tx, "operations", key, &op)?;
    event(
        tx,
        key,
        op.revision,
        "operation.cancel_requested",
        Value::Null,
    )?;
    Ok(op)
}

#[path = "catalog_activation.rs"]
pub mod activation;

#[path = "catalog_calendar.rs"]
pub mod calendar;
#[path = "catalog_ingress.rs"]
mod ingress;
