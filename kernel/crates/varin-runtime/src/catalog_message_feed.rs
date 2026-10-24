//! A read projection of original family messages and dispatches; no separate chat ledger.
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
pub struct Dispatch {
    pub operation_id: String,
    pub execution_id: String,
    pub sender_thread_id: String,
    pub sender_branch_id: String,
    pub target_thread_id: String,
    pub target_branch_id: String,
    pub accepted_cursor: u64,
    pub accepted_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    pub task: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub root_thread_id: String,
    pub messages: Vec<Entry>,
    pub dispatches: Vec<Dispatch>,
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
        // Both domains use the original immutable admission event cursor. A new message,
        // child continuation or renamed member cannot move an older page boundary.
        let (range, order, bound) = if let Some(after) = self.after {
            (">", "ASC", sql_number(after)?)
        } else {
            (
                "<",
                "DESC",
                self.before.map(sql_number).transpose()?.unwrap_or(i64::MAX),
            )
        };
        let sql = format!("WITH RECURSIVE family(id) AS (SELECT ?1 UNION SELECT c.child_thread_id FROM child_tasks c JOIN family f ON json_extract(c.body,'$.parent_thread_id')=f.id),
            feed(kind,body,content,extra,cursor,accepted_at_ms) AS (
                SELECT 'message',q.body,c.intent,c.id,q.cursor,0
                FROM input_queue q JOIN commands c ON c.id=json_extract(q.body,'$.origin.command_key')
                WHERE q.origin='message' AND q.sender_thread_id IN (SELECT id FROM family)
                UNION ALL
                SELECT 'dispatch',c.body,d.body,c.id,e.cursor,coalesce(json_extract(e.data,'$.acceptedAtMs'),t.created_at_ms)
                FROM child_tasks c JOIN delegated_executions d ON d.child_operation_id=c.id AND json_extract(d.body,'$.trigger.kind')='dispatch'
                JOIN events e ON e.subject=c.id AND e.kind='child.accepted'
                JOIN threads t ON t.id=c.child_thread_id JOIN operations o ON o.id=c.id
                WHERE json_extract(c.body,'$.parent_thread_id') IN (SELECT id FROM family)
                  AND coalesce(json_extract(o.body,'$.executor'),'')!='code_retrieval'
            ) SELECT kind,body,content,extra,cursor,accepted_at_ms FROM feed
            WHERE cursor {range} ?2 ORDER BY cursor {order} LIMIT ?3");
        let mut statement = db.prepare(&sql)?;
        let records = statement
            .query_map(params![root, bound, (self.limit + 1) as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    read_number(r, 4)?,
                    read_number(r, 5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = records.len() > self.limit;
        let mut messages = Vec::new();
        let mut dispatches = Vec::new();
        let mut cursors = Vec::new();
        let mut participants = BTreeSet::new();
        for (kind, body, content, command, cursor, accepted_at_ms) in records.into_iter().take(self.limit) {
            check()?;
            cursors.push(cursor);
            if kind == "dispatch" {
                let child: super::super::delegated::ChildRelation = serde_json::from_str(&body)?;
                let execution: super::super::delegated::DelegatedExecution = serde_json::from_str(&content)?;
                let input: super::super::dispatch::DispatchInput = serde_json::from_value(self.content.load_cancellable(&execution.input_ref, cancel)?)?;
                participants.insert(child.parent_thread_id.clone());
                participants.insert(child.child_thread_id.clone());
                dispatches.push(Dispatch {
                    operation_id: child.operation_id,
                    execution_id: execution.execution_id,
                    sender_thread_id: child.parent_thread_id,
                    sender_branch_id: child.parent_branch_id,
                    target_thread_id: child.child_thread_id,
                    target_branch_id: child.child_branch_id,
                    accepted_cursor: cursor,
                    accepted_at_ms,
                    preset: input.preset,
                    task: input.task,
                });
                continue;
            }
            let row: QueuedInputMetadata = serde_json::from_str(&body)?;
            let message_summary = summary(&db, row)?;
            let identity = &message_summary.receipt.identity;
            participants.insert(identity.sender_thread_id.clone());
            participants.insert(identity.target_thread_id.clone());
            let reference: Value = serde_json::from_str(&content)?;
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
            dispatches.reverse();
            cursors.reverse();
        }
        let before = (more && self.after.is_none()).then(|| cursors.first().copied()).flatten();
        let after = (more && self.after.is_some()).then(|| cursors.last().copied()).flatten();
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
            dispatches,
            participants,
            before,
            after,
            event_cursor,
        })
    }
}
