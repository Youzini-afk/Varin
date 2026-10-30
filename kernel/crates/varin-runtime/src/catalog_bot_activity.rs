//! A Bot's work as it happened, read from original events across all of its sessions: what
//! a session handed out, what came back, what the user changed in work the Bot watches,
//! background rounds that ended without a reply, and schedule occurrences. Nothing is stored.
use super::*;
use std::collections::BTreeSet;

/// One original input a quiet background round consumed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityInput {
    /// The input's original domain, e.g. `message`, `work_event` or `calendar`.
    pub origin: String,
    /// The conversation that produced it, when the input has one.
    pub thread_id: Option<String>,
    pub branch_id: Option<String>,
    /// The work update's kind for `work_event` inputs.
    pub change: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ActivityDetail {
    Dispatch { operation_id: String, execution_id: String, thread_id: String, branch_id: String, task: String, preset: Option<String> },
    Report { operation_id: String, execution_id: String, thread_id: String, branch_id: String, outcome: Outcome },
    /// The user typed, edited the workspace or changed history in work this Bot watches.
    Change { change: String, thread_id: String, branch_id: String },
    /// A session round without user input that finished without visible assistant output.
    Quiet { run_id: String, inputs: Vec<ActivityInput> },
    Schedule { occurrence_id: String, definition_id: String, name: String, state: calendar::OccurrenceState },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub cursor: u64,
    /// Wall time of the original fact; null for facts recorded before their events carried it.
    pub at_ms: Option<u64>,
    pub session_thread_id: String,
    pub session_branch_id: String,
    #[serde(flatten)]
    pub detail: ActivityDetail,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub bot_id: String,
    /// Newest first.
    pub events: Vec<ActivityEvent>,
    pub participants: Vec<messages::feed::Participant>,
    /// Pass back as `before` for the next older page; null when this page reaches the start.
    pub before: Option<u64>,
    pub event_cursor: u64,
}

pub struct ActivityRead {
    database: std::path::PathBuf,
    epoch: u64,
    bot_id: String,
    before: Option<u64>,
    limit: usize,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}

impl Catalog {
    pub fn capture_bot_activity(&self, bot_id: &str, before: Option<u64>, limit: Option<usize>) -> Result<ActivityRead> {
        super::bot_work::entry(&self.db, bot_id)?;
        let limit = limit.unwrap_or(30);
        if limit == 0 || i64::try_from(limit.saturating_add(1)).is_err() {
            return Err(RuntimeError::Invalid("activity page requires a positive database page size".into()));
        }
        Ok(ActivityRead {
            database: self.db.path().ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?.into(),
            epoch: self.epoch,
            bot_id: bot_id.to_owned(),
            before,
            limit,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}

// Every source pages by its original immutable event cursor, so a new fact never moves an
// older page boundary. Dispatches and reports are the sessions' own; changes are the work
// updates this Bot was told about, minus the ones delivery suppressed as duplicates or
// inaccessible. Retrieval workers are private tool executions, not delegated work.
const ACTIVITY: &str = "WITH sessions(id) AS (SELECT thread_id FROM bot_thread_bindings WHERE bot_id=?1),
    activity(kind,subject,cursor,data) AS (
        SELECT 'dispatch',c.id,e.cursor,e.data FROM child_tasks c
        JOIN delegated_executions d ON d.child_operation_id=c.id AND json_extract(d.body,'$.trigger.kind')='dispatch'
        JOIN events e ON e.subject=c.id AND e.kind='child.accepted' JOIN operations o ON o.id=c.id
        WHERE json_extract(c.body,'$.parent_thread_id') IN (SELECT id FROM sessions)
          AND coalesce(json_extract(o.body,'$.executor'),'')!='code_retrieval'
        UNION ALL
        SELECT 'report',d.id,e.cursor,e.data FROM delegated_executions d JOIN child_tasks c ON c.id=d.child_operation_id
        JOIN events e ON e.subject=d.id AND e.kind='child.report_ready' JOIN operations o ON o.id=c.id
        WHERE json_extract(c.body,'$.parent_thread_id') IN (SELECT id FROM sessions) AND json_extract(d.body,'$.report') IS NOT NULL
          AND coalesce(json_extract(o.body,'$.executor'),'')!='code_retrieval'
        UNION ALL
        SELECT 'change','',e.cursor,e.data FROM events e
        WHERE e.subject='bot-work-pending' AND e.kind='bot.work_pending' AND json_extract(e.data,'$.botId')=?1
          AND json_extract(e.data,'$.kind') IN ('user_input','workspace_change','history_changed')
          AND NOT EXISTS(SELECT 1 FROM deliveries WHERE observer='bot-work-suppressed' AND fact_cursor=e.cursor)
        UNION ALL
        SELECT 'quiet',r.id,e.cursor,e.data FROM sessions s JOIN branches b ON b.thread_id=s.id JOIN runs r ON r.branch_id=b.id
        JOIN events e ON e.subject=r.id AND e.kind='run.changed'
        WHERE json_extract(e.data,'$.state')='completed' AND json_extract(e.data,'$.hasVisibleAssistantOutput')=0
          AND NOT EXISTS(SELECT 1 FROM history h WHERE h.run_id=r.id AND json_extract(h.body,'$.source')='user')
        UNION ALL
        SELECT 'schedule',o.id,e.cursor,e.data FROM calendar_occurrences o JOIN events e ON e.subject=o.id AND e.kind='calendar.observed'
        WHERE o.thread_id IN (SELECT id FROM sessions)
    ) SELECT kind,subject,cursor,data FROM activity WHERE cursor<?2 ORDER BY cursor DESC LIMIT ?3";

impl ActivityRead {
    pub fn load(self, cancel: &dyn Fn() -> bool) -> Result<ActivityPage> {
        let check = || if cancel() { Err(RuntimeError::DispatchCancelled) } else { Ok(()) };
        check()?;
        let db = super::history_views::current_history_owner(&self.database, self.epoch)?;
        db.execute_batch("BEGIN")?;
        super::bot_work::entry(&db, &self.bot_id)?;
        let event_cursor = db.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| read_number(r, 0))?;
        let bound = self.before.map(sql_number).transpose()?.unwrap_or(i64::MAX);
        let mut statement = db.prepare(ACTIVITY)?;
        let records = statement
            .query_map(params![self.bot_id, bound, (self.limit + 1) as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, read_number(r, 2)?, r.get::<_, String>(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let more = records.len() > self.limit;
        let mut events = Vec::new();
        let mut participants = BTreeSet::new();
        for (kind, subject, cursor, data) in records.into_iter().take(self.limit) {
            check()?;
            let data: Value = serde_json::from_str(&data)?;
            let event = match kind.as_str() {
                "dispatch" | "report" => {
                    let (child, execution) = if kind == "dispatch" {
                        let child: delegated::ChildRelation = record(&db, "child_tasks", &subject)?;
                        let execution_id: String = db.query_row(
                            "SELECT id FROM delegated_executions WHERE child_operation_id=?1 AND json_extract(body,'$.trigger.kind')='dispatch' ORDER BY rowid LIMIT 1",
                            [&subject], |r| r.get(0))?;
                        (child, record::<delegated::DelegatedExecution>(&db, "delegated_executions", &execution_id)?)
                    } else {
                        let execution: delegated::DelegatedExecution = record(&db, "delegated_executions", &subject)?;
                        (record::<delegated::ChildRelation>(&db, "child_tasks", &execution.child_operation_id)?, execution)
                    };
                    participants.insert(child.child_thread_id.clone());
                    let detail = if kind == "dispatch" {
                        let input: dispatch::DispatchInput = serde_json::from_value(self.content.load_cancellable(&execution.input_ref, cancel)?)?;
                        ActivityDetail::Dispatch {
                            operation_id: child.operation_id.clone(), execution_id: execution.execution_id,
                            thread_id: child.child_thread_id.clone(), branch_id: child.child_branch_id.clone(),
                            task: input.task, preset: input.preset,
                        }
                    } else {
                        let report = execution.report.as_ref().ok_or_else(|| RuntimeError::Conflict("selected report is missing".into()))?;
                        ActivityDetail::Report {
                            operation_id: child.operation_id.clone(), execution_id: execution.execution_id.clone(),
                            thread_id: child.child_thread_id.clone(), branch_id: child.child_branch_id.clone(), outcome: report.outcome,
                        }
                    };
                    let at_ms = if kind == "dispatch" {
                        match data["acceptedAtMs"].as_u64() {
                            Some(at) => Some(at),
                            None => db.query_row("SELECT created_at_ms FROM threads WHERE id=?1", [&child.child_thread_id], |r| r.get::<_, Option<i64>>(0))
                                .optional()?.flatten().and_then(|at| u64::try_from(at).ok()),
                        }
                    } else {
                        data["atMs"].as_u64()
                    };
                    ActivityEvent { cursor, at_ms, session_thread_id: child.parent_thread_id, session_branch_id: child.parent_branch_id, detail }
                }
                "change" => {
                    let text = |key: &str| data[key].as_str().map(str::to_owned).ok_or_else(|| RuntimeError::Invalid(format!("work update {key} missing")));
                    let thread_id = text("sourceThreadId")?;
                    participants.insert(thread_id.clone());
                    ActivityEvent {
                        cursor, at_ms: data["atMs"].as_u64(),
                        session_thread_id: text("targetThreadId")?, session_branch_id: text("targetBranchId")?,
                        detail: ActivityDetail::Change { change: text("kind")?, thread_id, branch_id: text("sourceBranchId")? },
                    }
                }
                "quiet" => {
                    let run: Run = record(&db, "runs", &subject)?;
                    let inputs = quiet_inputs(&db, &run.id)?;
                    participants.extend(inputs.iter().filter_map(|input| input.thread_id.clone()));
                    ActivityEvent {
                        cursor, at_ms: data["atMs"].as_u64(), session_thread_id: run.thread_id, session_branch_id: run.branch_id,
                        detail: ActivityDetail::Quiet { run_id: run.id, inputs },
                    }
                }
                "schedule" => {
                    let (name, occurrence) = calendar::named_occurrence(&db, &subject)?;
                    ActivityEvent {
                        cursor, at_ms: Some(occurrence.observed_at_ms),
                        session_thread_id: occurrence.thread_id, session_branch_id: occurrence.branch_id,
                        detail: ActivityDetail::Schedule { occurrence_id: occurrence.id, definition_id: occurrence.definition_id, name, state: occurrence.state },
                    }
                }
                _ => return Err(RuntimeError::Invalid("unknown activity source".into())),
            };
            events.push(event);
        }
        let before = more.then(|| events.last().map(|event| event.cursor)).flatten();
        let mut people = Vec::new();
        for thread in participants {
            check()?;
            // A thread removed with its original records has no name to show; the event keeps its id.
            if let Some(participant) = db.query_row("SELECT t.title,t.agent_code,json_extract(c.body,'$.avatar') FROM threads t LEFT JOIN child_tasks c ON c.child_thread_id=t.id WHERE t.id=?1", [&thread], |r| {
                Ok(messages::feed::Participant { thread_id: thread.clone(), name: r.get(0)?, agent_id: r.get(1)?, avatar: r.get(2)? })
            }).optional()? {
                people.push(participant);
            }
        }
        super::history_views::current_history_owner(&self.database, self.epoch)?;
        check()?;
        Ok(ActivityPage { bot_id: self.bot_id, events, participants: people, before, event_cursor })
    }
}

fn quiet_inputs(db: &Connection, run_id: &str) -> Result<Vec<ActivityInput>> {
    let mut query = db.prepare("SELECT origin,sender_thread_id,sender_branch_id,body FROM input_queue WHERE run_id=?1 AND state='delivered' ORDER BY cursor")?;
    let rows = query
        .query_map([run_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|(origin, thread_id, branch_id, body)| {
        let row: inputs::QueuedInputMetadata = serde_json::from_str(&body)?;
        let inputs::InputOrigin::WorkEvent { event_cursor, .. } = row.origin else {
            return Ok(ActivityInput { origin, thread_id, branch_id, change: None });
        };
        let raw: String = db.query_row("SELECT data FROM events WHERE cursor=?1", [sql_number(event_cursor)?], |r| r.get(0))?;
        let data: Value = serde_json::from_str(&raw)?;
        let text = |key: &str| data[key].as_str().map(str::to_owned);
        Ok(ActivityInput { origin, thread_id: text("sourceThreadId"), branch_id: text("sourceBranchId"), change: text("kind") })
    }).collect()
}
