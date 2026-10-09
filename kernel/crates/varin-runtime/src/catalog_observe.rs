//! Read-side discovery and coalesced committed-event notifications for Host projections.
use super::*;
use std::sync::mpsc::SyncSender;

impl Catalog {
    /// The hook sends no transaction data. The receiver reads the committed cursor under the
    /// Catalog owner lock after the transaction ends; a rollback is only a harmless wakeup.
    pub fn set_event_notifier(&self, sender: SyncSender<()>) -> Result<()> {
        self.db.update_hook(Some(
            move |action, _database: &str, table: &str, _row: i64| {
                if action == rusqlite::hooks::Action::SQLITE_INSERT && table == "events" {
                    let _ = sender.try_send(());
                }
            },
        ))?;
        Ok(())
    }
    pub fn event_cursor(&self) -> Result<u64> {
        self.db
            .query_row("SELECT coalesce(max(cursor),0) FROM events", [], |row| {
                read_number(row, 0)
            })
            .map_err(Into::into)
    }
    pub fn inspect_thread(&self, thread_id: &str) -> Result<Value> {
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
            [thread_id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(RuntimeError::NotFound(thread_id.into()));
        }
        let mut statement = self
            .db
            .prepare("SELECT id,head,active_run FROM branches WHERE thread_id=?1 ORDER BY rowid")?;
        let rows = statement.query_map([thread_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        let mut branches = Vec::new();
        for row in rows {
            let (branch_id, head, active_run_id) = row?;
            let latest: Option<String> = self
                .db
                .query_row(
                    "SELECT body FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",
                    [&branch_id],
                    |r| r.get(0),
                )
                .optional()?;
            let latest_run = latest
                .map(|raw| serde_json::from_str::<Run>(&raw))
                .transpose()?;
            branches.push(json!({"branch_id":branch_id,"head":head,"active_run_id":active_run_id,"latest_run":latest_run}));
        }
        // Scope is bound at Run admission, including queued Runs, and survives later context
        // publication. Read only small checkpoint metadata; never hydrate prompt bodies here.
        let mut scopes = self.db.prepare(
            "SELECT DISTINCT c.project_id FROM runs r JOIN branches b ON b.id=r.branch_id
             LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id
             WHERE b.thread_id=?1 ORDER BY c.project_id")?;
        let observer_project_ids = scopes.query_map([thread_id], |row| row.get::<_, Option<String>>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(json!({"thread_id":thread_id,"branches":branches,"observer_project_ids":observer_project_ids}))
    }
    pub fn list_threads(&self) -> Result<Vec<Value>> {
        let ids: Vec<String> = {
            let mut statement = self.db.prepare("SELECT id FROM threads ORDER BY rowid")?;
            let rows = statement.query_map([], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        ids.iter().map(|id| self.inspect_thread(id)).collect()
    }
}

const RUN_ACTIVITY_REQUEST: &str = "varin.run.activity@1";

fn validate_observer_scope(observer: &str, thread_id: &str) -> Result<Option<String>> {
    // The Host owns selection; the kernel owns exact scope membership for both reads and ACKs.
    // Null is an absent project. An empty project string must not alias absence.
    let (request, provider, thread, project): (String, String, String, Option<String>) =
        serde_json::from_str(observer)?;
    if request != RUN_ACTIVITY_REQUEST || provider.is_empty() || thread != thread_id || thread_id.is_empty() {
        return Err(RuntimeError::Invalid("activity subscription scope mismatch".into()));
    }
    Ok(project)
}

impl Catalog {
    /// Read the original committed event log, never a second queue. Only Run activity facts and
    /// safe state metadata cross the extension boundary; the stored source event is unchanged.
    pub fn observer_run_activity(&self, observer: &str, thread_id: &str, through_cursor: u64, limit: u32) -> Result<Vec<Event>> {
        let project = validate_observer_scope(observer, thread_id)?;
        let mut statement = self.db.prepare(
            "SELECT e.cursor,e.subject,e.revision,e.kind,e.data FROM events e
             JOIN runs r ON r.id=e.subject JOIN branches b ON b.id=r.branch_id
             LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id
             WHERE b.thread_id=?1 AND c.project_id IS ?6 AND e.cursor<=?5 AND e.kind IN ('run.accepted','run.changed','run.cancel_requested')
             AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.observer=?2 AND d.fact_cursor=e.cursor
                 AND d.request=?3 AND d.state='\"committed\"') ORDER BY e.cursor LIMIT ?4")?;
        let rows = statement.query_map(params![thread_id, observer, RUN_ACTIVITY_REQUEST, limit, sql_number(through_cursor)?, project], |row| {
            Ok((read_number(row, 0)?, row.get::<_, String>(1)?, read_number(row, 2)?,
                row.get::<_, String>(3)?, row.get::<_, String>(4)?))
        })?;
        rows.map(|row| {
            let (cursor, subject, revision, kind, raw) = row?;
            let original: Value = serde_json::from_str(&raw)?;
            let state = if kind == "run.accepted" { json!("accepted") }
                else if kind == "run.changed" { original.get("state").cloned().unwrap_or(Value::Null) }
                else { Value::Null };
            Ok(Event { cursor, subject, revision, kind, data: json!({"state":state}) })
        }).collect()
    }

    pub fn acknowledge_run_activity(&mut self, observer: &str, thread_id: &str,
        cursor: u64, next: DeliveryState) -> Result<()> {
        let project = validate_observer_scope(observer, thread_id)?;
        let belongs: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM events e JOIN runs r ON r.id=e.subject JOIN branches b ON b.id=r.branch_id
             LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id
             WHERE e.cursor=?1 AND b.thread_id=?2 AND c.project_id IS ?3 AND e.kind IN ('run.accepted','run.changed','run.cancel_requested'))",
            params![sql_number(cursor)?, thread_id, project], |row| row.get(0))?;
        if !belongs { return Err(RuntimeError::Invalid("activity cursor does not belong to subscription".into())); }
        let old: Option<String> = self.db.query_row(
            "SELECT state FROM deliveries WHERE observer=?1 AND fact_cursor=?2 AND request=?3",
            params![observer, sql_number(cursor)?, RUN_ACTIVITY_REQUEST], |row| row.get(0)).optional()?;
        // Retrying an in-flight delivery must not rewind sent to selected. All forward state
        // transitions still go through the existing selected -> sent -> committed authority.
        if old.as_deref() == Some("\"committed\"")
            || (old.as_deref() == Some("\"sent\"") && next == DeliveryState::Selected) { return Ok(()); }
        self.set_delivery(observer, cursor, RUN_ACTIVITY_REQUEST, next)
    }
}
