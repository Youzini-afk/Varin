//! Bounded immutable-history views. Bodies remain in the existing content store.
use super::*;
use serde::Deserialize;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryReference {
    pub run_id: String,
    pub id: String,
    pub thread_id: String,
    pub parent: Option<String>,
    pub source: HistorySource,
    pub content_ref: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryPage {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub boundary_reset: bool,
    pub head: Option<String>,
    pub items: Vec<HistoryReference>,
    pub previous: Option<String>,
}
pub struct HistoryBodyRead {
    database: std::path::PathBuf,
    epoch: u64,
    content: crate::content::ContentStore,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
impl HistoryBodyRead {
    pub fn chunk(self, index: usize) -> Result<crate::content::ContentChunk> {
        let chunk = self.content.load_chunk(&self.reference, index)?;
        current_history_owner(&self.database, self.epoch)?;
        Ok(chunk)
    }
}
impl Catalog {
    /// Synchronous fixture convenience. Public commands capture under Catalog, then load on a reader.
    pub fn history_page(
        &self,
        branch_id: &str,
        head_id: Option<&str>,
        before_id: Option<&str>,
        limit: u32,
    ) -> Result<HistoryPage> {
        self.capture_history_page(branch_id)?
            .load(head_id, before_id, limit, &|| false)
    }
    pub fn capture_history_page(&self, branch_id: &str) -> Result<HistoryPageRead> {
        Ok(HistoryPageRead {
            head: self.head(branch_id)?,
            epoch: self.epoch,
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            _publication: self.content.begin_publication(),
        })
    }

    pub fn history_body_reader(&self, item_id: &str) -> Result<HistoryBodyRead> {
        let item: HistoryItem = record(&self.db, "history", item_id)?;
        Ok(HistoryBodyRead {
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            epoch: self.epoch,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
            reference: item.content,
        })
    }
    pub fn active_thread_operations(
        &self,
        thread_id: &str,
        branch_id: Option<&str>,
    ) -> Result<Vec<Operation>> {
        // The attention predicate is an indexed superset. Keep this view's original narrower
        // predicate too: a terminal unknown effect alone is not an active operation here.
        let mut statement=self.db.prepare_cached(&format!("SELECT o.body FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND (?2 IS NULL OR b.id=?2) AND {} AND (json_extract(o.body,'$.phase')!='terminal' OR json_extract(o.body,'$.outcome')='indeterminate' OR (json_extract(o.body,'$.mcp_resource_subscription') IS NOT NULL AND (json_extract(o.body,'$.cancel_requested')=0 OR json_extract(o.body,'$.mcp_resource_subscription.localReleased')=0))) ORDER BY o.id", super::attention::OPEN_OPERATION))?;
        let rows =
            statement.query_map(params![thread_id, branch_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}

pub struct HistoryPageRead {
    head: Option<String>,
    epoch: u64,
    database: std::path::PathBuf,
    _publication: crate::content::ContentPublication,
}
impl HistoryPageRead {
    pub fn load(
        self,
        head_id: Option<&str>,
        before_id: Option<&str>,
        limit: u32,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<HistoryPage> {
        self.load_since(head_id, before_id, None, limit, cancelled)
    }

    pub fn load_since(
        self,
        head_id: Option<&str>,
        before_id: Option<&str>,
        after_id: Option<&str>,
        limit: u32,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<HistoryPage> {
        if cancelled() {
            return Err(RuntimeError::DispatchCancelled);
        }
        let db = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.execute_batch("BEGIN")?;
        let epoch = db.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| {
            read_number(row, 0)
        })?;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "history reader belongs to a previous owner epoch".into(),
            ));
        }
        if limit == 0 || limit > 256 {
            return Err(RuntimeError::Invalid(
                "history page size must be between 1 and 256".into(),
            ));
        }
        let current = self.head.clone();
        let mut cursor = current.clone();
        // Ancestry is an original Catalog relation. Traverse it without repeatedly decoding
        // unrelated history metadata; only the returned page needs complete references.
        let mut parents = db.prepare("SELECT parent FROM history WHERE id=?1")?;
        let mut parent = |key: &str| -> Result<Option<String>> {
            parents.query_row([key], |row| row.get(0)).optional()?
                .ok_or_else(|| RuntimeError::NotFound(key.into()))
        };
        if let Some(anchor) = head_id {
            while cursor.as_deref() != Some(anchor) {
                if cancelled() {
                    return Err(RuntimeError::DispatchCancelled);
                }
                let key = cursor.ok_or_else(|| {
                    RuntimeError::Conflict("history anchor is no longer on this branch".into())
                })?;
                cursor = parent(&key)?;
            }
        }
        let head = cursor.clone();
        if let Some(before) = before_id {
            loop {
                if cancelled() {
                    return Err(RuntimeError::DispatchCancelled);
                }
                let key = cursor.ok_or_else(|| {
                    RuntimeError::Conflict("history cursor is not on the anchored view".into())
                })?;
                if after_id == Some(key.as_str()) {
                    return Err(RuntimeError::Conflict("history cursor precedes the selected incremental boundary".into()));
                }
                cursor = parent(&key)?;
                if key == before {
                    break;
                }
            }
        }
        let mut items = Vec::new();
        let mut reached_after = after_id.is_none();
        let mut references = db.prepare("SELECT body FROM history WHERE id=?1")?;
        while items.len() < (limit as usize) {
            if cancelled() {
                return Err(RuntimeError::DispatchCancelled);
            }
            let Some(key) = cursor else {
                break;
            };
            if after_id == Some(key.as_str()) { reached_after = true; cursor = None; break; }
            let raw: String = references.query_row([&key], |row| row.get(0)).optional()?
                .ok_or_else(|| RuntimeError::NotFound(key.clone()))?;
            let item: HistoryItem = serde_json::from_str(&raw)?;
            cursor = item.parent.clone();
            let content_ref = item
                .content
                .get("content_object")
                .and_then(Value::as_str)
                .ok_or_else(|| RuntimeError::Invalid("history content reference missing".into()))?
                .to_string();
            items.push(HistoryReference {
                run_id: item.run_id,
                id: item.id,
                thread_id: item.thread_id,
                parent: item.parent,
                source: item.source,
                content_ref,
            });
        }
        items.reverse();
        let boundary_reset = cursor.is_none() && !reached_after;
        let previous = if cursor.is_some() && cursor.as_deref() != after_id {
            items.first().map(|item| item.id.clone())
        } else {
            None
        };
        if cancelled() {
            return Err(RuntimeError::DispatchCancelled);
        }
        current_history_owner(&self.database, self.epoch)?;
        Ok(HistoryPage {
            boundary_reset,
            head,
            items,
            previous,
        })
    }
}

/// A retained SQLite snapshot cannot prove that the current owner is still the captured owner.
/// Each completed history read uses a separate, current connection before returning success.
pub(super) fn current_history_owner(database: &std::path::Path, epoch: u64) -> Result<Connection> {
    let db = Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let current = db.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| {
        read_number(row, 0)
    })?;
    if current != epoch {
        return Err(RuntimeError::Conflict(
            "history reader belongs to a previous owner epoch".into(),
        ));
    }
    Ok(db)
}

/// A typed Bot provenance read; the branch is a visibility witness, not source identity.
pub struct BotHistoryRead {
    database: std::path::PathBuf,
    epoch: u64,
    content: crate::content::ContentStore,
    bot_id: String,
    principal: Option<Option<String>>,
    thread_id: String,
    branch_id: String,
    head_id: String,
    item_id: String,
    _publication: crate::content::ContentPublication,
}
impl Catalog {
    pub fn capture_bot_history(&self, bot_id: &str, thread_id: &str, branch_id: &str, head_id: &str, item_id: &str) -> Result<BotHistoryRead> {
        self.capture_bot_history_scoped(bot_id,thread_id,branch_id,head_id,item_id,None)
    }
    pub fn capture_bot_history_scoped(&self, bot_id: &str, thread_id: &str, branch_id: &str, head_id: &str, item_id: &str, principal: Option<Option<String>>) -> Result<BotHistoryRead> {
        if let Some(principal)=&principal { if !self.db.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND principal_id IS ?2)", params![thread_id,principal], |r|r.get::<_,bool>(0))? { return Err(RuntimeError::Conflict("History source is outside this principal".into())); } }
        if (self.bot_for_thread(thread_id)?.as_deref() != Some(bot_id)
            && !super::bot_work::linked(&self.db, &super::bot_work::entry(&self.db, bot_id)?, thread_id, Some(branch_id), false, true)?) || self.branch_thread_id(branch_id)? != thread_id {
            return Err(RuntimeError::Conflict("History source is outside this Bot".into()));
        }
        Ok(BotHistoryRead { database: self.database_path.clone(), epoch: self.epoch, content: self.content.clone(),
            principal, bot_id: bot_id.into(), thread_id: thread_id.into(), branch_id: branch_id.into(), head_id: head_id.into(), item_id: item_id.into(),
            _publication: self.content.begin_publication() })
    }
}
impl BotHistoryRead {
    pub fn load(self, cancelled: &dyn Fn() -> bool) -> Result<HistoryItem> {
        let db = current_history_owner(&self.database, self.epoch)?;
        db.execute_batch("BEGIN")?;
        if let Some(principal)=&self.principal { if !db.query_row("SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND principal_id IS ?2)", params![self.thread_id,principal], |r|r.get::<_,bool>(0))? { return Err(RuntimeError::Conflict("History source principal changed".into())); } }
        if super::bot::thread_bot(&db, &self.thread_id)?.as_deref() != Some(&self.bot_id)
            && !super::bot_work::linked(&db, &super::bot_work::entry(&db, &self.bot_id)?, &self.thread_id, Some(&self.branch_id), false, true)? {
            return Err(RuntimeError::Conflict("History source Bot changed".into()));
        }
        let (thread, mut cursor): (String, Option<String>) = db.query_row("SELECT thread_id,head FROM branches WHERE id=?1", [&self.branch_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        if thread != self.thread_id { return Err(RuntimeError::Conflict("History witness belongs to another Thread".into())); }
        let mut witnessed = false;
        let item = loop {
            if cancelled() { return Err(RuntimeError::DispatchCancelled); }
            let key = cursor.ok_or_else(|| RuntimeError::Conflict("History item is not an ancestor of the selected head".into()))?;
            let item: HistoryItem = record(&db, "history", &key)?;
            if key == self.head_id { witnessed = true; }
            if witnessed && key == self.item_id {
                if item.thread_id != self.thread_id { return Err(RuntimeError::Conflict("History item owner changed".into())); }
                break item;
            }
            cursor = item.parent;
        };
        let result = self.content.hydrate_history(item)?;
        if cancelled() { return Err(RuntimeError::DispatchCancelled); }
        let current = current_history_owner(&self.database, self.epoch)?;
        if super::bot::thread_bot(&current, &self.thread_id)?.as_deref() != Some(&self.bot_id)
            && !super::bot_work::linked(&current, &super::bot_work::entry(&current, &self.bot_id)?, &self.thread_id, Some(&self.branch_id), false, true)? {
            return Err(RuntimeError::Conflict("History source Bot changed".into()));
        }
        Ok(result)
    }
}
