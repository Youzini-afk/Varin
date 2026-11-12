//! Product metadata stays with the original Catalog. A tombstone hides navigation; it never
//! cancels execution, releases resources, or discards the records needed by their owners.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadListQuery {
    #[serde(default, skip_serializing_if="Option::is_none", deserialize_with="super::principals::optional_principal")]
    pub principal_id: Option<Option<String>>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_mode: Option<titles::TitleMode>,
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
pub struct BranchDelete {
    pub thread_id: String,
    pub branch_id: String,
    pub key: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadRead {
    pub thread_id: String,
    pub key: String,
    pub through_cursor: u64,
}

/// SQLite's built-in lower() is ASCII-only. Product search has always used Rust's Unicode
/// lowercase semantics, so apply that predicate before expanding a matching directory row.
pub(super) fn install_functions(db: &Connection) -> Result<()> {
    db.create_scalar_function("varin_lower", 1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8 | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        |context| Ok(context.get::<String>(0)?.to_lowercase()))?;
    Ok(())
}

pub(super) fn now_ms() -> Result<u64> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| RuntimeError::Invalid("system clock precedes Unix epoch".into()))?;
    u64::try_from(elapsed.as_millis())
        .map_err(|_| RuntimeError::Invalid("system clock exceeds catalog range".into()))
}
pub(super) fn insert(tx: &Transaction<'_>, thread_id: &str, initial_branch: &str, domain: &str, bot_id: Option<&str>) -> Result<()> {
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)", [thread_id], |r| r.get(0))?;
    if exists { return Err(RuntimeError::IdentityUnavailable(thread_id.into())); }
    let branch_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM branches WHERE id=?1)", [initial_branch], |r| r.get(0))?;
    if branch_exists { return Err(RuntimeError::Conflict("initial branch identity already exists".into())); }
    loop {
        let code = Uuid::new_v4().simple().to_string()[..8].to_uppercase();
        let used: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE agent_code=?1 COLLATE NOCASE UNION ALL SELECT 1 FROM retired_agent_codes WHERE code=?1 COLLATE NOCASE UNION ALL SELECT 1 FROM model_agents WHERE agent_code=?1 COLLATE NOCASE)", [&code], |r| r.get(0))?;
        if !used {
            tx.execute("INSERT INTO threads(id,agent_code,hidden_kind) VALUES(?1,?2,?3)", params![thread_id,code, matches!(domain,"summary"|"memory").then_some(domain)])?;
            super::identity::record(tx, thread_id, initial_branch, domain, bot_id)?;
            return Ok(());
        }
    }
}
pub(super) fn resolve(db: &Connection, identity: &str) -> Result<String> {
    db.query_row("SELECT id FROM threads WHERE id=?1 OR agent_code=?2 COLLATE NOCASE", params![identity,identity.to_uppercase()], |r| r.get(0))
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
    let changes_mode = titles::mode(tx,thread_id)? != titles::TitleMode::Manual;
    titles::set_mode(tx,thread_id,titles::TitleMode::Manual)?;
    let changed = tx.execute("UPDATE threads SET title=?2,title_initialized=1,revision=revision+1,updated_at_ms=max(updated_at_ms,?3) WHERE id=?1 AND (title!=?2 OR ?4)", params![thread_id,name,sql_number(now_ms()?)?,changes_mode])?;
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
/// One-time replacement for the product directory's repeated auxiliary-work probes.
pub(super) fn upgrade_hidden(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("ALTER TABLE threads ADD COLUMN hidden_kind TEXT;
        UPDATE threads SET hidden_kind=CASE
        WHEN EXISTS(SELECT 1 FROM thread_creations c WHERE c.thread_id=threads.id AND c.domain='summary') THEN 'summary'
        WHEN EXISTS(SELECT 1 FROM thread_creations c WHERE c.thread_id=threads.id AND c.domain='memory') THEN 'memory'
        WHEN EXISTS(SELECT 1 FROM child_tasks c JOIN operations o ON o.id=c.id WHERE c.child_thread_id=threads.id AND json_extract(o.body,'$.executor')='code_retrieval') THEN 'code_retrieval'
        WHEN EXISTS(SELECT 1 FROM branches b JOIN runs r ON r.branch_id=b.id JOIN context_jobs c ON c.run_id=r.id WHERE b.thread_id=threads.id) THEN 'context_job'
        WHEN EXISTS(SELECT 1 FROM branches b JOIN runs r ON r.branch_id=b.id JOIN operations o ON o.run_id=r.id WHERE b.thread_id=threads.id AND json_extract(o.body,'$.intent.kind')='memory_work_v1') THEN 'memory'
        END;")?;
    Ok(())
}
pub(super) fn check_legacy_hidden_format(db: &Connection) -> Result<()> {
    let present: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('threads') WHERE name='hidden_kind')", [], |row|row.get(0))?;
    if present { return Err(RuntimeError::Invalid("Legacy Catalog contains newer internal Thread classification; data was preserved".into())); }
    Ok(())
}
pub(super) fn check_hidden_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT hidden_kind FROM threads")?;
    let invalid: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE hidden_kind IS NOT NULL AND hidden_kind NOT IN ('summary','memory','code_retrieval','context_job'))", [], |r| r.get(0))?;
    if invalid { return Err(RuntimeError::Invalid("invalid internal Thread kind; data was preserved".into())); }
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

pub(super) fn branch_deleted(db: &Connection, branch: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='branch.deleted')",
        [branch], |row| row.get(0),
    )?)
}

pub(super) fn require_branch_available(db: &Connection, branch: &str) -> Result<()> {
    if branch_deleted(db, branch)? {
        return Err(RuntimeError::NotFound(branch.into()));
    }
    Ok(())
}

/// Internal investigations are controlled through their parent Operation.
pub(super) fn require_public(db:&Connection,thread:&str)->Result<()> {
    let internal:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM child_tasks c JOIN operations o ON o.id=c.id WHERE c.child_thread_id=?1 AND json_extract(o.body,'$.executor')='code_retrieval')",
        [thread],|row|row.get(0))?;
    if internal {return Err(RuntimeError::Conflict("Internal retrieval belongs to its original code_retrieval Operation; use retrieval_control to inspect, wait or stop it".into()));}
    Ok(())
}

/// Only visible conversation/attention changes advance unread position. Metadata and read ACKs
/// cannot create their own notification loop. Existing owner identities resolve attribution.
pub(super) fn record_activity(
    tx: &Transaction<'_>,
    subject: &str,
    thread: Option<&str>,
    kind: &str,
    cursor: u64,
    data: &Value,
) -> Result<()> {
    if !matches!(kind, "run.accepted" | "run.changed" | "run.cancel_requested" | "assistant.output" | "history.appended" | "permission.opened" | "question.opened") { return Ok(()); }
    if let Some(thread) = thread {
        let bot_entry: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM bot_thread_bindings WHERE thread_id=?1)", [&thread], |row|row.get(0))?;
        if bot_entry {
            let visible = match kind {
                "run.accepted" => tx.query_row("SELECT EXISTS(SELECT 1 FROM history WHERE run_id=?1 AND json_extract(body,'$.source')='user')", [subject], |row|row.get(0))?,
                "run.changed" => data["state"] == "failed" || data["hasVisibleAssistantOutput"] == true,
                "run.cancel_requested" => false,
                "history.appended" => tx.query_row("SELECT EXISTS(SELECT 1 FROM history WHERE id=?1 AND json_extract(body,'$.source')='user')", [data["id"].as_str().unwrap_or_default()], |row|row.get(0))?,
                _ => true,
            };
            if !visible { return Ok(()); }
        }
        tx.execute(
            "UPDATE threads SET activity_cursor=?2,updated_at_ms=max(updated_at_ms,?3) WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM child_tasks c JOIN operations o ON o.id=c.id WHERE c.child_thread_id=?1 AND json_extract(o.body,'$.executor')='code_retrieval')",
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
        let needle = query.query.as_deref().unwrap_or("").trim().to_lowercase();
        inspect_selected(&self.db,
            "(?2=0 OR t.principal_id IS NULL OR t.principal_id=?3) AND t.deleted_at_ms IS NULL AND t.hidden_kind IS NULL AND (?1=1 OR t.archived=CASE WHEN ?1=2 THEN 1 ELSE 0 END) AND (?4='' OR instr(varin_lower(t.id),?4)>0 OR instr(varin_lower(t.title),?4)>0)",
            params![archive, query.principal_id.is_some(), query.principal_id.as_ref().and_then(Option::as_deref),needle])
    }
    /// Navigation batch: hidden, deleted and absent rows are omitted so clients remove stale entries.
    pub fn inspect_threads(&self, ids: &[String]) -> Result<Vec<Value>> {
        inspect_selected(&self.db,
            "t.id IN (SELECT value FROM json_each(?1)) AND t.deleted_at_ms IS NULL AND t.hidden_kind IS NULL",
            [serde_json::to_string(ids)?])
    }

    pub fn update_thread(&mut self, command: &ThreadUpdate) -> Result<Value> {
        let intent = json!({"kind":"thread.update","command":command});
        let tx = self.db.transaction()?;
        if let Some(receipt) = existing_command(&tx, &command.key, &intent)? {
            return Ok(receipt);
        }
        require_revision(&tx, &command.thread_id, command.expected_revision)?;
        if command.title.is_none() && command.pinned.is_none() && command.archived.is_none() && command.title_mode.is_none() {
            return Err(RuntimeError::Invalid("Thread update is empty".into()));
        }
        let title = command.title.as_deref().map(str::trim);
        if title.is_some_and(str::is_empty) {
            return Err(RuntimeError::Invalid("Thread title is empty".into()));
        }
        if let Some(mode) = command.title_mode.or(title.map(|_|titles::TitleMode::Manual)) {
            titles::set_mode(&tx,&command.thread_id,mode)?;
        }
        tx.execute("UPDATE threads SET title=coalesce(?2,title),title_initialized=CASE WHEN ?2 IS NULL THEN title_initialized ELSE 1 END,pinned=coalesce(?3,pinned),archived=coalesce(?4,archived),revision=revision+1,updated_at_ms=max(updated_at_ms,?5) WHERE id=?1", params![command.thread_id,title,command.pinned,command.archived,sql_number(now_ms()?)?])?;
        event(
            &tx,
            &command.thread_id,
            command.expected_revision + 1,
            "thread.updated",
            json!({"title":title,"pinned":command.pinned,"archived":command.archived,"titleMode":command.title_mode}),
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
    pub fn delete_branch(&mut self, command: &BranchDelete) -> Result<Value> {
        let intent = json!({"kind":"branch.delete","command":command});
        let tx = self.db.transaction()?;
        if let Some(receipt) = existing_command(&tx, &command.key, &intent)? {
            return Ok(receipt);
        }
        require_available(&tx, &command.thread_id)?;
        require_public(&tx, &command.thread_id)?;
        let target = &command.branch_id;
        require_branch_available(&tx, target)?;
        let active: Option<String> = tx.query_row(
            "SELECT active_run FROM branches WHERE id=?1 AND thread_id=?2",
            params![target, command.thread_id], |row| row.get(0),
        ).optional()?.ok_or_else(|| RuntimeError::NotFound(target.clone()))?;
        if branch(&tx, &command.thread_id)? == *target {
            return Err(RuntimeError::Conflict("The main conversation cannot be deleted as a branch".into()));
        }
        let unfinished: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE branch_id=?1 AND json_extract(body,'$.state') NOT IN ('completed','failed','cancelled'))",
            [target], |row| row.get(0),
        )?;
        if active.is_some() || unfinished {
            return Err(RuntimeError::Conflict("Stop the work on this branch before deleting it".into()));
        }
        followups::cancel_branch(&tx, &command.thread_id, target)?;
        let revision = tx.query_row(
            "UPDATE threads SET revision=revision+1 WHERE id=?1 RETURNING revision",
            [&command.thread_id], |row| read_number(row, 0),
        )?;
        event(&tx, target, revision, "branch.deleted", json!({"threadId":command.thread_id}))?;
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
    inspect_selected(db, "t.id=?1", [thread_id])?.into_iter().next()
        .ok_or_else(|| RuntimeError::NotFound(thread_id.into()))
}

/// One SQL statement for any directory window. Branches, latest Runs, scope history and
/// ancestry are joined/aggregated inside the same snapshot instead of N per-Thread calls.
fn inspect_selected<P: rusqlite::Params>(db: &Connection, filter: &str, parameters: P) -> Result<Vec<Value>> {
    let sql = format!(r#"WITH RECURSIVE selected AS (
        SELECT t.* FROM threads t WHERE {filter}
    ), latest_runs AS (
        SELECT r.branch_id,r.body,row_number() OVER(PARTITION BY r.branch_id ORDER BY r.rowid DESC) AS position
        FROM runs r JOIN branches b ON b.id=r.branch_id JOIN selected t ON t.id=b.thread_id
    ), links AS NOT MATERIALIZED (
        SELECT t.id, bot.bot_id, coalesce(
            (SELECT json_extract(c.body,'$.parent_thread_id') FROM child_tasks c WHERE c.child_thread_id=t.id),
            (SELECT source.thread_id FROM context_jobs c JOIN runs r ON r.id=c.run_id JOIN branches helper ON helper.id=r.branch_id JOIN branches source ON source.id=c.branch_id WHERE helper.thread_id=t.id)
        ) AS parent,
        (SELECT json_extract(o.body,'$.intent.scopeId') FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=t.id AND json_extract(o.body,'$.intent.kind')='memory_work_v1' LIMIT 1) AS memory_scope,
        coalesce(creation.identity_known,1) AS known
        FROM threads t LEFT JOIN bot_thread_bindings bot ON bot.thread_id=t.id
            LEFT JOIN thread_creations creation ON creation.thread_id=t.id
    ), ancestry(root,id,path,cycle) AS (
        SELECT id,id,json_array(id),0 FROM selected
        UNION ALL SELECT a.root,l.parent,json_insert(a.path,'$[#]',l.parent),
            EXISTS(SELECT 1 FROM json_each(a.path) WHERE value=l.parent)
        FROM ancestry a JOIN links l ON l.id=a.id
        WHERE NOT a.cycle AND l.bot_id IS NULL AND l.parent IS NOT NULL
    ), terminal AS (
        SELECT a.root,l.bot_id,l.memory_scope,l.known,a.cycle FROM ancestry a JOIN links l ON l.id=a.id
        WHERE a.cycle OR l.bot_id IS NOT NULL OR l.parent IS NULL
    )
    SELECT t.id,t.title,t.revision,t.created_at_ms,t.updated_at_ms,t.pinned,t.archived,t.deleted_at_ms,
        t.activity_cursor,t.read_cursor,t.principal_id,t.agent_code,
        coalesce((SELECT mode FROM thread_title_state WHERE thread_id=t.id),'automatic'),
        (SELECT json_extract(body,'$.parent_thread_id') FROM child_tasks WHERE child_thread_id=t.id),
        (SELECT json_extract(body,'$.avatar') FROM child_tasks WHERE child_thread_id=t.id),
        terminal.bot_id,terminal.memory_scope,terminal.known,terminal.cycle,
        (SELECT json_group_array(json(branch)) FROM (
            SELECT json_object('branch_id',b.id,'head',b.head,'active_run_id',b.active_run,'latest_run',
                json(latest.body)) AS branch
            FROM branches b LEFT JOIN latest_runs latest ON latest.branch_id=b.id AND latest.position=1 WHERE b.thread_id=t.id AND NOT EXISTS(SELECT 1 FROM events e WHERE e.subject=b.id AND e.kind='branch.deleted') ORDER BY b.rowid)),
        (SELECT json_group_array(project_id) FROM (SELECT DISTINCT c.project_id FROM runs r JOIN branches b ON b.id=r.branch_id
            LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id WHERE b.thread_id=t.id ORDER BY c.project_id))
        FROM selected t LEFT JOIN terminal ON terminal.root=t.id ORDER BY t.pinned DESC,t.updated_at_ms DESC,t.id"#);
    let mut query = db.prepare_cached(&sql)?;
    let rows = query.query_map(parameters, |r| Ok((
        json!({"thread_id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"revision":read_number(r,2)?,
            "created_at_ms":read_number(r,3)?,"updated_at_ms":read_number(r,4)?,"pinned":r.get::<_,bool>(5)?,
            "archived":r.get::<_,bool>(6)?,"deleted_at_ms":r.get::<_,Option<i64>>(7)?,"activity_cursor":read_number(r,8)?,
            "read_cursor":read_number(r,9)?,"unread":read_number(r,8)?>read_number(r,9)?,
            "principal_id":r.get::<_,Option<String>>(10)?,"agent_code":r.get::<_,String>(11)?,
            "title_mode":r.get::<_,String>(12)?,"parent_thread_id":r.get::<_,Option<String>>(13)?}),
        r.get::<_,Option<String>>(14)?,r.get::<_,Option<String>>(15)?,r.get::<_,Option<String>>(16)?,
        r.get::<_,Option<bool>>(17)?,r.get::<_,Option<bool>>(18)?,r.get::<_,String>(19)?,r.get::<_,String>(20)?
    )))?;
    rows.map(|row| {
        let (mut summary,avatar,bot,scope,known,cycle,branches,projects) = row?;
        if cycle == Some(true) { return Err(RuntimeError::Invalid("Bot execution ancestry is cyclic".into())); }
        let bot = match (bot,scope) { (Some(bot),_) => Some(bot), (None,Some(scope)) => Some(scope.strip_prefix("bot:").filter(|id|!id.is_empty()).ok_or_else(||RuntimeError::Invalid("MemoryWork Bot identity is invalid".into()))?.to_owned()), _ => None };
        if bot.is_none() && known == Some(false) { summary["creation_identity_known"] = json!(false); }
        summary["bot_id"] = json!(bot);
        if let Some(avatar) = avatar { summary["avatar"] = json!(avatar); }
        let mut branches: Value = serde_json::from_str(&branches)?;
        if let Some(items) = branches.as_array_mut() {
            for branch in items {
                if !branch["latest_run"].is_null() {
                    let run: Run = serde_json::from_value(branch["latest_run"].take())?;
                    branch["latest_run"] = serde_json::to_value(run)?;
                }
            }
        }
        let first = branches.as_array().and_then(|items|items.first()).ok_or_else(||RuntimeError::Invalid("Thread has no initial branch".into()))?;
        summary["main_branch_id"] = first["branch_id"].clone();
        summary["branches"] = branches;
        summary["observer_project_ids"] = serde_json::from_str(&projects)?;
        Ok(summary)
    }).collect()
}

#[cfg(test)]
#[path = "catalog_threads_tests.rs"]
mod tests;
