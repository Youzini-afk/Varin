//! Product metadata stays with the original Catalog. A tombstone hides navigation; it never
//! cancels execution, releases resources, or discards the records needed by their owners.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadListQuery {
    pub query: Option<String>,
    pub archived: Option<ArchiveFilter>,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveFilter {
    #[default]
    Exclude,
    Include,
    Only,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadUpdate {
    pub thread_id: String,
    pub key: String,
    pub expected_revision: u64,
    pub title: Option<String>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadDelete {
    pub thread_id: String,
    pub key: String,
    pub expected_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRead {
    pub thread_id: String,
    pub key: String,
    pub through_cursor: u64,
}

fn now_ms() -> Result<u64> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| RuntimeError::Invalid("system clock precedes Unix epoch".into()))?;
    u64::try_from(elapsed.as_millis())
        .map_err(|_| RuntimeError::Invalid("system clock exceeds catalog range".into()))
}
pub(super) fn insert(tx: &Transaction<'_>, thread_id: &str) -> Result<()> {
    loop {
        let code = Uuid::new_v4().simple().to_string()[..8].to_uppercase();
        let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE agent_code=?1 UNION ALL SELECT 1 FROM retired_agent_codes WHERE code=?1)", [&code], |r| r.get(0))?;
        if !used {
            tx.execute("INSERT INTO threads(id,agent_code) VALUES(?1,?2)", params![thread_id,code])?;
            return Ok(());
        }
    }
}
pub(super) fn resolve(db: &Connection, identity: &str) -> Result<String> {
    db.query_row("SELECT id FROM threads WHERE id=?1 OR agent_code=?2", params![identity,identity.to_uppercase()], |r| r.get(0))
        .optional()?.ok_or_else(|| RuntimeError::NotFound(identity.into()))
}
pub(super) fn branch(db: &Connection, thread_id: &str) -> Result<String> {
    let child: Option<String> = db.query_row("SELECT json_extract(body,'$.child_branch_id') FROM child_tasks WHERE child_thread_id=?1", [thread_id], |r| r.get(0)).optional()?;
    if let Some(branch) = child { return Ok(branch); }
    db.query_row("SELECT id FROM branches WHERE thread_id=?1 ORDER BY rowid LIMIT 1", [thread_id], |r| r.get(0)).map_err(Into::into)
}
pub(super) fn name(tx: &Transaction<'_>, thread_id: &str, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() { return Err(RuntimeError::Invalid("Agent name is empty".into())); }
    let changed = tx.execute("UPDATE threads SET title=?2,title_initialized=1,revision=revision+1,updated_at_ms=max(updated_at_ms,?3) WHERE id=?1 AND title!=?2", params![thread_id,name,sql_number(now_ms()?)?])?;
    if changed > 0 {
        let revision = tx.query_row("SELECT revision FROM threads WHERE id=?1", [thread_id], |r| read_number(r,0))?;
        event(tx,thread_id,revision,"thread.updated",json!({"title":name}))?;
    }
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT code FROM retired_agent_codes")?;
    db.prepare("SELECT agent_code FROM threads")?;
    db.prepare("SELECT id,title,title_initialized,revision,created_at_ms,updated_at_ms,pinned,archived,deleted_at_ms,activity_cursor,read_cursor FROM threads")?;
    let invalid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE typeof(title)!='text' OR length(trim(title))=0 OR title_initialized NOT IN (0,1) OR revision<1 OR created_at_ms<0 OR updated_at_ms<created_at_ms OR pinned NOT IN (0,1) OR archived NOT IN (0,1) OR deleted_at_ms<0 OR activity_cursor<0 OR read_cursor<0 OR read_cursor>activity_cursor)", [], |r| r.get(0))?;
    if invalid {
        return Err(RuntimeError::Invalid(
            "invalid Thread metadata; data was preserved".into(),
        ));
    }
    Ok(())
}
pub(super) fn require_available(db: &Connection, thread_id: &str) -> Result<()> {
    let deleted: Option<Option<i64>> = db
        .query_row(
            "SELECT deleted_at_ms FROM threads WHERE id=?1",
            [thread_id],
            |r| r.get(0),
        )
        .optional()?;
    match deleted {
        None => Err(RuntimeError::NotFound(thread_id.into())),
        Some(Some(_)) => Err(RuntimeError::Conflict("Thread is deleted".into())),
        Some(None) => Ok(()),
    }
}

/// Only visible conversation/attention changes advance unread position. Metadata and read ACKs
/// cannot create their own notification loop. Existing owner identities resolve attribution.
pub(super) fn record_activity(
    tx: &Transaction<'_>,
    subject: &str,
    kind: &str,
    cursor: u64,
) -> Result<()> {
    let thread: Option<String> = match kind {
        "run.accepted" | "run.changed" | "run.cancel_requested" => tx.query_row("SELECT b.thread_id FROM runs r JOIN branches b ON b.id=r.branch_id WHERE r.id=?1", [subject], |r| r.get(0)).optional()?,
        "history.appended" => tx.query_row("SELECT thread_id FROM branches WHERE id=?1", [subject], |r| r.get(0)).optional()?,
        "permission.opened" | "question.opened" => tx.query_row("SELECT b.thread_id FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE o.id=?1", [subject], |r| r.get(0)).optional()?,
        _ => None,
    };
    if let Some(thread) = thread {
        tx.execute(
            "UPDATE threads SET activity_cursor=?2,updated_at_ms=max(updated_at_ms,?3) WHERE id=?1",
            params![thread, sql_number(cursor)?, sql_number(now_ms()?)?],
        )?;
    }
    Ok(())
}

pub(super) fn input_title(input: &Value) -> Option<String> {
    input
        .get("text")
        .and_then(Value::as_str)
        .and_then(|text| text.lines().map(str::trim).find(|line| !line.is_empty()))
        .map(str::to_owned)
}
pub(super) fn initialize_title(
    tx: &Transaction<'_>,
    thread_id: &str,
    title: Option<&str>,
) -> Result<()> {
    let Some(title) = title else {
        return Ok(());
    };
    let changed = tx.execute("UPDATE threads SET title=?2,title_initialized=1,revision=revision+1,updated_at_ms=max(updated_at_ms,?3) WHERE id=?1 AND title_initialized=0", params![thread_id, title, sql_number(now_ms()?)?])?;
    if changed > 0 {
        let revision = tx.query_row(
            "SELECT revision FROM threads WHERE id=?1",
            [thread_id],
            |r| read_number(r, 0),
        )?;
        event(
            tx,
            thread_id,
            revision,
            "thread.updated",
            json!({"title":title}),
        )?;
    }
    Ok(())
}

fn existing_command(db: &Connection, key: &str, intent: &Value) -> Result<Option<Value>> {
    if key.trim().is_empty() {
        return Err(RuntimeError::Invalid("Thread command key is empty".into()));
    }
    let old: Option<(String, String)> = db
        .query_row(
            "SELECT intent,receipt FROM commands WHERE id=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match old {
        None => Ok(None),
        Some((old, receipt)) if serde_json::from_str::<Value>(&old)? == *intent => {
            Ok(Some(serde_json::from_str(&receipt)?))
        }
        Some(_) => Err(RuntimeError::Conflict(
            "Thread command key has different input".into(),
        )),
    }
}
fn save_command(tx: &Transaction<'_>, key: &str, intent: &Value, thread_id: &str) -> Result<Value> {
    let summary = inspect(tx, thread_id)?;
    tx.execute(
        "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
        params![key, encode(intent)?, encode(&summary)?],
    )?;
    Ok(summary)
}
fn require_revision(db: &Connection, thread_id: &str, expected: u64) -> Result<()> {
    require_available(db, thread_id)?;
    let actual = db.query_row(
        "SELECT revision FROM threads WHERE id=?1",
        [thread_id],
        |r| read_number(r, 0),
    )?;
    if actual != expected {
        return Err(RuntimeError::Conflict(
            "Thread metadata revision changed".into(),
        ));
    }
    Ok(())
}
impl Catalog {
    pub fn agent_identity(&self, identity: &str) -> Result<Value> {
        let thread = resolve(&self.db,identity)?;
        self.db.query_row("SELECT agent_code,title FROM threads WHERE id=?1",[&thread],|r|Ok(json!({"threadId":thread,"agentId":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?}))).map_err(Into::into)
    }
    pub fn rename_family_agent(&mut self, invocation: &super::tool_content::ToolInvocationSnapshot, target: &str, name: &str) -> Result<Value> {
        self.validate_tool_invocation(invocation, true)?;
        let run = self.run(&invocation.context.run_id)?;
        let target = resolve(&self.db,target)?;
        if super::scheduling::thread_family(&self.db,&run.thread_id)? != super::scheduling::thread_family(&self.db,&target)? {
            return Err(RuntimeError::Conflict("Agent is outside this task family".into()));
        }
        let intent = json!({"kind":"agent.rename","target":target,"name":name});
        let key = format!("agent-rename:{}",invocation.context.operation_id);
        let tx = self.db.transaction()?;
        if let Some(receipt) = existing_command(&tx,&key,&intent)? { return Ok(receipt); }
        self::name(&tx,&target,name)?;
        let receipt = save_command(&tx,&key,&intent,&target)?;
        tx.commit()?;
        Ok(receipt)
    }
    /// Product discovery deliberately differs from internal owner discovery: tombstones and
    /// auxiliary context/memory inference stay available to original execution owners.
    pub fn list_thread_catalog(&self, query: &ThreadListQuery) -> Result<Vec<Value>> {
        let archive = match query.archived.unwrap_or_default() {
            ArchiveFilter::Exclude => 0,
            ArchiveFilter::Include => 1,
            ArchiveFilter::Only => 2,
        };
        let mut statement = self.db.prepare("SELECT t.id FROM threads t WHERE t.deleted_at_ms IS NULL AND (?1=1 OR t.archived=CASE WHEN ?1=2 THEN 1 ELSE 0 END) AND NOT EXISTS(SELECT 1 FROM branches b JOIN runs r ON r.branch_id=b.id JOIN context_jobs c ON c.run_id=r.id WHERE b.thread_id=t.id) AND NOT EXISTS(SELECT 1 FROM branches b JOIN runs r ON r.branch_id=b.id JOIN operations o ON o.run_id=r.id WHERE b.thread_id=t.id AND json_extract(o.body,'$.intent.kind')='memory_work_v1') ORDER BY t.pinned DESC,t.updated_at_ms DESC,t.id")?;
        let ids = statement
            .query_map([archive], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let needle = query.query.as_deref().unwrap_or("").trim().to_lowercase();
        let mut result = Vec::new();
        for id in ids {
            let summary = self.inspect_thread(&id)?;
            if needle.is_empty()
                || id.to_lowercase().contains(&needle)
                || summary["title"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&needle)
            {
                result.push(summary);
            }
        }
        Ok(result)
    }
    pub fn update_thread(&mut self, command: &ThreadUpdate) -> Result<Value> {
        let intent = json!({"kind":"thread.update","command":command});
        let tx = self.db.transaction()?;
        if let Some(receipt) = existing_command(&tx, &command.key, &intent)? {
            return Ok(receipt);
        }
        require_revision(&tx, &command.thread_id, command.expected_revision)?;
        if command.title.is_none() && command.pinned.is_none() && command.archived.is_none() {
            return Err(RuntimeError::Invalid("Thread update is empty".into()));
        }
        let title = command.title.as_deref().map(str::trim);
        if title.is_some_and(str::is_empty) {
            return Err(RuntimeError::Invalid("Thread title is empty".into()));
        }
        tx.execute("UPDATE threads SET title=coalesce(?2,title),title_initialized=CASE WHEN ?2 IS NULL THEN title_initialized ELSE 1 END,pinned=coalesce(?3,pinned),archived=coalesce(?4,archived),revision=revision+1,updated_at_ms=max(updated_at_ms,?5) WHERE id=?1", params![command.thread_id,title,command.pinned,command.archived,sql_number(now_ms()?)?])?;
        event(
            &tx,
            &command.thread_id,
            command.expected_revision + 1,
            "thread.updated",
            json!({"title":title,"pinned":command.pinned,"archived":command.archived}),
        )?;
        let receipt = save_command(&tx, &command.key, &intent, &command.thread_id)?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn delete_thread(&mut self, command: &ThreadDelete) -> Result<Value> {
        let intent = json!({"kind":"thread.delete","command":command});
        let tx = self.db.transaction()?;
        if let Some(receipt) = existing_command(&tx, &command.key, &intent)? {
            return Ok(receipt);
        }
        require_revision(&tx, &command.thread_id, command.expected_revision)?;
        tx.execute("UPDATE threads SET deleted_at_ms=?2,revision=revision+1,updated_at_ms=max(updated_at_ms,?2) WHERE id=?1", params![command.thread_id, sql_number(now_ms()?)?])?;
        event(
            &tx,
            &command.thread_id,
            command.expected_revision + 1,
            "thread.deleted",
            Value::Null,
        )?;
        let receipt = save_command(&tx, &command.key, &intent, &command.thread_id)?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn mark_thread_read(&mut self, command: &ThreadRead) -> Result<Value> {
        let intent = json!({"kind":"thread.read","command":command});
        let tx = self.db.transaction()?;
        if let Some(receipt) = existing_command(&tx, &command.key, &intent)? {
            return Ok(receipt);
        }
        let maximum = tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
            read_number(r, 0)
        })?;
        if command.through_cursor > maximum {
            return Err(RuntimeError::Invalid(
                "read cursor is beyond committed events".into(),
            ));
        }
        let (activity, read, revision) = tx
            .query_row(
                "SELECT activity_cursor,read_cursor,revision FROM threads WHERE id=?1",
                [&command.thread_id],
                |r| Ok((read_number(r, 0)?, read_number(r, 1)?, read_number(r, 2)?)),
            )
            .optional()?
            .ok_or_else(|| RuntimeError::NotFound(command.thread_id.clone()))?;
        let next = activity.min(command.through_cursor).max(read);
        if next != read {
            tx.execute(
                "UPDATE threads SET read_cursor=?2 WHERE id=?1",
                params![command.thread_id, sql_number(next)?],
            )?;
            event(
                &tx,
                &command.thread_id,
                revision,
                "thread.read",
                json!({"read_cursor":next}),
            )?;
        }
        let receipt = save_command(&tx, &command.key, &intent, &command.thread_id)?;
        tx.commit()?;
        Ok(receipt)
    }
}

pub(super) fn inspect(db: &Connection, thread_id: &str) -> Result<Value> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
        [thread_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(RuntimeError::NotFound(thread_id.into()));
    }
    let mut statement =
        db.prepare("SELECT id,head,active_run FROM branches WHERE thread_id=?1 ORDER BY rowid")?;
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
        let latest: Option<String> = db
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
    let mut scopes = db.prepare(
        "SELECT DISTINCT c.project_id FROM runs r JOIN branches b ON b.id=r.branch_id
             LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id
             WHERE b.thread_id=?1 ORDER BY c.project_id",
    )?;
    let observer_project_ids = scopes
        .query_map([thread_id], |row| row.get::<_, Option<String>>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut summary = db.query_row("SELECT title,revision,created_at_ms,updated_at_ms,pinned,archived,deleted_at_ms,activity_cursor,read_cursor FROM threads WHERE id=?1", [thread_id], |r| Ok(json!({
            "title":r.get::<_,String>(0)?, "revision":read_number(r,1)?,
            "created_at_ms":read_number(r,2)?, "updated_at_ms":read_number(r,3)?,
            "pinned":r.get::<_,bool>(4)?, "archived":r.get::<_,bool>(5)?,
            "deleted_at_ms":r.get::<_,Option<i64>>(6)?, "activity_cursor":read_number(r,7)?,
            "read_cursor":read_number(r,8)?, "unread":read_number(r,7)?>read_number(r,8)?
        })))?;
    summary["main_branch_id"] = branches
        .first()
        .ok_or_else(|| RuntimeError::Invalid("Thread has no initial branch".into()))?["branch_id"]
        .clone();
    summary["thread_id"] = json!(thread_id);
    summary["agent_code"] = json!(db.query_row("SELECT agent_code FROM threads WHERE id=?1", [thread_id], |r| r.get::<_,String>(0))?);
    let parent_thread_id: Option<String> = db.query_row(
        "SELECT json_extract(body,'$.parent_thread_id') FROM child_tasks WHERE child_thread_id=?1",
        [thread_id], |row| row.get(0),
    ).optional()?;
    summary["parent_thread_id"] = json!(parent_thread_id);
    summary["bot_id"] = json!(bot::thread_bot(db, thread_id)?);
    summary["branches"] = json!(branches);
    summary["observer_project_ids"] = json!(observer_project_ids);
    Ok(summary)
}

#[cfg(test)]
#[path = "catalog_threads_tests.rs"]
mod tests;
