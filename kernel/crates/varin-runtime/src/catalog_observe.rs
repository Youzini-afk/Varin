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
        Ok(json!({"thread_id":thread_id,"branches":branches}))
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
