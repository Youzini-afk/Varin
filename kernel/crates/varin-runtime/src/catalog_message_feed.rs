//! A read projection of the existing family message queue; no separate chat ledger.
use super::*;
use std::collections::BTreeSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub thread_id: String,
    pub name: String,
    pub agent_id: String,
    pub avatar: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub message: MessageView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_exchange_operation_id: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub root_thread_id: String,
    pub messages: Vec<Entry>,
    pub participants: Vec<Participant>,
    pub before: Option<u64>,
    pub after: Option<u64>,
    pub event_cursor: u64,
}
pub struct Read {
    database: std::path::PathBuf,
    epoch: u64,
    thread: String,
    branch: String,
    before: Option<u64>,
    after: Option<u64>,
    limit: usize,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl Catalog {
    pub fn capture_message_feed(
        &self,
        thread: String,
        branch: String,
        before: Option<u64>,
        after: Option<u64>,
        limit: Option<usize>,
    ) -> Result<Read> {
        branch_owner(&self.db, &thread, &branch)?;
        let limit = limit.unwrap_or(30);
        if before.is_some() && after.is_some()
            || limit == 0
            || i64::try_from(limit.saturating_add(1)).is_err()
        {
            return Err(RuntimeError::Invalid(
                "message page requires one direction and a positive database page size".into(),
            ));
        }
        Ok(Read {
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            epoch: self.epoch,
            thread,
            branch,
            before,
            after,
            limit,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}
impl Read {
    pub fn load(self, cancel: &dyn Fn() -> bool) -> Result<Page> {
        let check = || {
            if cancel() {
                Err(RuntimeError::DispatchCancelled)
            } else {
                Ok(())
            }
        };
        check()?;
        let db = super::super::history_views::current_history_owner(&self.database, self.epoch)?;
        db.execute_batch("BEGIN")?;
        branch_owner(&db, &self.thread, &self.branch)?;
        let root = super::super::scheduling::thread_family(&db, &self.thread)?;
        let event_cursor = db.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
            read_number(r, 0)
        })?;
        // Cursor ranges refer to immutable acceptance order. Membership and body reads share
        // this transaction; a newly admitted message cannot move an older page boundary.
        let (range, order, bound) = if let Some(after) = self.after {
            (">", "ASC", sql_number(after)?)
        } else {
            (
                "<",
                "DESC",
                self.before.map(sql_number).transpose()?.unwrap_or(i64::MAX),
            )
        };
        let sql = format!("WITH RECURSIVE family(id) AS (SELECT ?1 UNION SELECT c.child_thread_id FROM child_tasks c JOIN family f ON json_extract(c.body,'$.parent_thread_id')=f.id)
            SELECT q.body,c.id,c.intent FROM input_queue q JOIN commands c ON c.id=json_extract(q.body,'$.origin.command_key')
            WHERE q.origin='message' AND q.sender_thread_id IN (SELECT id FROM family)
            AND q.cursor {range} ?2 ORDER BY q.cursor {order} LIMIT ?3");
        let mut statement = db.prepare(&sql)?;
        let records = statement
            .query_map(params![root, bound, (self.limit + 1) as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = records.len() > self.limit;
        let mut messages = Vec::new();
        let mut participants = BTreeSet::new();
        for (body, command, intent) in records.into_iter().take(self.limit) {
            check()?;
            let row: QueuedInputMetadata = serde_json::from_str(&body)?;
            let message_summary = summary(&db, row)?;
            let identity = &message_summary.receipt.identity;
            participants.insert(identity.sender_thread_id.clone());
            participants.insert(identity.target_thread_id.clone());
            let reference: Value = serde_json::from_str(&intent)?;
            let original: MessageIntent =
                serde_json::from_value(self.content.load_cancellable(&reference, cancel)?)?;
            let exchange = match &identity.actor {
                MessageActor::Agent { operation_id, .. }
                    if command == format!("code-notice:code-exchange:{operation_id}") =>
                {
                    Some(operation_id.clone())
                }
                _ => None,
            };
            messages.push(Entry {
                message: MessageView {
                    summary: message_summary,
                    text: original.input.text,
                },
                code_exchange_operation_id: exchange,
            });
        }
        if self.after.is_none() {
            messages.reverse();
        }
        let before = (more && self.after.is_none())
            .then(|| {
                messages
                    .first()
                    .map(|m| m.message.summary.receipt.accepted_cursor)
            })
            .flatten();
        let after = (more && self.after.is_some())
            .then(|| {
                messages
                    .last()
                    .map(|m| m.message.summary.receipt.accepted_cursor)
            })
            .flatten();
        let participants = participants.into_iter().map(|thread| {
            check()?;
            Ok(db.query_row("SELECT t.title,t.agent_code,json_extract(c.body,'$.avatar') FROM threads t LEFT JOIN child_tasks c ON c.child_thread_id=t.id WHERE t.id=?1", [&thread], |r| {
                Ok(Participant { thread_id: thread.clone(), name: r.get(0)?, agent_id: r.get(1)?, avatar: r.get(2)? })
            })?)
        }).collect::<Result<Vec<_>>>()?;
        super::super::history_views::current_history_owner(&self.database, self.epoch)?;
        check()?;
        Ok(Page {
            root_thread_id: root,
            messages,
            participants,
            before,
            after,
            event_cursor,
        })
    }
}
