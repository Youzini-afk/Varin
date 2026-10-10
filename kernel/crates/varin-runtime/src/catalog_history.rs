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
        let mut statement=self.db.prepare("SELECT o.body FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND (?2 IS NULL OR b.id=?2) AND (json_extract(o.body,'$.phase')!='terminal' OR json_extract(o.body,'$.outcome')='indeterminate') ORDER BY o.id")?;
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
        if let Some(anchor) = head_id {
            while cursor.as_deref() != Some(anchor) {
                if cancelled() {
                    return Err(RuntimeError::DispatchCancelled);
                }
                let key = cursor.ok_or_else(|| {
                    RuntimeError::Conflict("history anchor is no longer on this branch".into())
                })?;
                let item: HistoryItem = record(&db, "history", &key)?;
                cursor = item.parent;
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
                let item: HistoryItem = record(&db, "history", &key)?;
                cursor = item.parent;
                if key == before {
                    break;
                }
            }
        }
        let mut items = Vec::new();
        while items.len() < (limit as usize) {
            if cancelled() {
                return Err(RuntimeError::DispatchCancelled);
            }
            let Some(key) = cursor else {
                break;
            };
            let item: HistoryItem = record(&db, "history", &key)?;
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
        let previous = if cursor.is_some() {
            items.first().map(|item| item.id.clone())
        } else {
            None
        };
        if cancelled() {
            return Err(RuntimeError::DispatchCancelled);
        }
        current_history_owner(&self.database, self.epoch)?;
        Ok(HistoryPage {
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
