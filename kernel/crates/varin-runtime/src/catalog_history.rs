//! Bounded immutable-history views. Bodies remain in the existing content store.
use super::*;
use serde::Deserialize;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryReference {
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
    content: crate::content::ContentStore,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
impl HistoryBodyRead {
    pub fn chunk(self, index: usize) -> Result<crate::content::ContentChunk> {
        self.content.load_chunk(&self.reference, index)
    }
}
impl Catalog {
    pub fn history_page(
        &self,
        branch_id: &str,
        head_id: Option<&str>,
        before_id: Option<&str>,
        limit: u32,
    ) -> Result<HistoryPage> {
        if limit == 0 || limit > 256 {
            return Err(RuntimeError::Invalid(
                "history page size must be between 1 and 256".into(),
            ));
        }
        let current = self.head(branch_id)?;
        let mut cursor = current.clone();
        if let Some(anchor) = head_id {
            while cursor.as_deref() != Some(anchor) {
                let key = cursor.ok_or_else(|| {
                    RuntimeError::Conflict("history anchor is no longer on this branch".into())
                })?;
                let item: HistoryItem = record(&self.db, "history", &key)?;
                cursor = item.parent;
            }
        }
        let head = cursor.clone();
        if let Some(before) = before_id {
            loop {
                let key = cursor.ok_or_else(|| {
                    RuntimeError::Conflict("history cursor is not on the anchored view".into())
                })?;
                let item: HistoryItem = record(&self.db, "history", &key)?;
                cursor = item.parent;
                if key == before {
                    break;
                }
            }
        }
        let mut items = Vec::new();
        while items.len() < (limit as usize) {
            let Some(key) = cursor else {
                break;
            };
            let item: HistoryItem = record(&self.db, "history", &key)?;
            cursor = item.parent.clone();
            let content_ref = item
                .content
                .get("content_object")
                .and_then(Value::as_str)
                .ok_or_else(|| RuntimeError::Invalid("history content reference missing".into()))?
                .to_string();
            items.push(HistoryReference {
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
        Ok(HistoryPage {
            head,
            items,
            previous,
        })
    }
    pub fn history_body_reader(&self, item_id: &str) -> Result<HistoryBodyRead> {
        let item: HistoryItem = record(&self.db, "history", item_id)?;
        Ok(HistoryBodyRead {
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
            reference: item.content,
        })
    }
    pub fn active_thread_operations(&self, thread_id: &str, branch_id: Option<&str>) -> Result<Vec<Operation>> {
        let mut statement=self.db.prepare("SELECT o.body FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND (?2 IS NULL OR b.id=?2) AND (json_extract(o.body,'$.phase')!='terminal' OR json_extract(o.body,'$.outcome')='indeterminate') ORDER BY o.id")?;
        let rows = statement.query_map(params![thread_id, branch_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}
