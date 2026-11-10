//! Internal investigations are background Jobs; their answers use the original input queue.
use super::*;

pub const CONTROL_TOOL: &str = "retrieval_control";

/// Only the original native retrieval publisher may route its private worker's final result.
/// Ordinary send invocations retain their public-member rule.
pub(super) fn is_result_sender(
    db: &Connection,
    sender: &str,
    actor: &messages::MessageActor,
    input: &messages::MessageInput,
) -> Result<bool> {
    let messages::MessageActor::Agent {
        run_id,
        operation_id,
        origin,
    } = actor
    else {
        return Ok(false);
    };
    let Some(operation) = optional_record::<Operation>(db, "operations", operation_id)? else {
        return Ok(false);
    };
    if operation.executor.as_deref() != Some("code_retrieval") {
        return Ok(false);
    };
    let child = delegated::execution_task(db, operation_id)?;
    Ok(operation.run_id == *run_id
        && child.child_thread_id == sender
        && child.resources_released
        && operation
            .external_receipt
            .as_ref()
            .is_some_and(|receipt| receipt.executor_stopped)
        && tool_content::ToolIntent::from_operation(&operation)?.origin() == origin
        && input.target_thread_id.as_deref() == Some(child.parent_thread_id.as_str())
        && input.target_branch_id.as_deref() == Some(child.parent_branch_id.as_str())
        && input.kind == MessageKind::Request
        && input.reply_to.is_none()
        && input.source_agent.is_none())
}

pub struct RetrievalStatusRead {
    database: std::path::PathBuf,
    operation_id: String,
    parent_run_id: String,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}

/// Activity describes the actual invocation without copying file bodies or tool output.
fn activity_arguments(arguments: &Value) -> Value {
    let mut selected = serde_json::Map::new();
    for key in [
        "ref",
        "path",
        "paths",
        "query",
        "queries",
        "url",
        "name",
        "command",
        "args",
        "shellCommand",
        "processId",
        "startLine",
        "endLine",
        "unit",
        "action",
        "condition",
        "question",
        "prompt",
        "target",
    ] {
        if let Some(value) = arguments.get(key) {
            selected.insert(key.into(), value.clone());
        }
    }
    if let Some(files) = arguments.get("files").and_then(Value::as_array) {
        selected.insert(
            "files".into(),
            Value::Array(files.iter().map(activity_arguments).collect()),
        );
    }
    Value::Object(selected)
}

fn activity(
    call: &crate::execution::ToolCall,
    state: Value,
    outcome: Value,
    operation_id: Option<&str>,
) -> Value {
    let (tool, arguments) = if call.name == "tool_invoke" {
        (
            crate::tool_disclosure::invoked_name(&call.arguments).unwrap_or(&call.name),
            call.arguments.get("arguments").unwrap_or(&call.arguments),
        )
    } else {
        (call.name.as_str(), &call.arguments)
    };
    json!({"operationId":operation_id,"callId":call.call_id,"tool":tool,"state":state,"outcome":outcome,"arguments":activity_arguments(arguments)})
}

/// Cheap reads have canonical call receipts, but intentionally have no Operation.
/// Pick at most one original call from each producer. The batch/node commit cursor
/// orders it against durable Operations without decoding any result or history body.
fn recent_receipt_activity(
    db: &Connection,
    content: &crate::content::ContentStore,
    run_id: &str,
    after: u64,
) -> Result<Option<Value>> {
    // Aggregate batch cursors once rather than searching the Run's event stream
    // separately for every call. TEXT affinity allows an indexed derived join.
    // Legacy batches lack request IDs; their latest request follows result-history
    // commit order, not model admission order.
    let mut selected: Option<(u64, String, String)> = db.query_row(
        "WITH batch_commits AS MATERIALIZED (
           SELECT CAST(json_extract(data,'$.request_id') AS TEXT) AS request_id,max(cursor) AS cursor FROM events
           WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind')='tool_batch_committed'
           GROUP BY json_extract(data,'$.request_id')
         ), calls AS MATERIALIZED (
           SELECT t.request_id,t.call_id,t.body,t.receipt,h.rowid AS history_rowid,b.cursor AS batch_cursor
           FROM tool_calls t JOIN model_steps m ON m.id=t.request_id
           JOIN history h ON h.id=t.request_id||':result:'||t.call_id
           LEFT JOIN batch_commits b ON b.request_id=t.request_id
           WHERE m.run_id=?1 AND t.committed=1
         )
         SELECT coalesce(t.batch_cursor,
           CASE WHEN t.request_id=(SELECT request_id FROM calls WHERE batch_cursor IS NULL ORDER BY history_rowid DESC LIMIT 1)
           THEN (SELECT cursor FROM batch_commits WHERE request_id IS NULL) ELSE 0 END,0) AS committed_cursor,
           t.body,json_extract(t.receipt,'$.completion') FROM calls t
         WHERE json_extract(t.receipt,'$.completion.kind') IN ('result','not_dispatched')
         AND NOT EXISTS(SELECT 1 FROM operations invocation WHERE invocation.id=t.request_id||':tool:'||t.call_id)
         ORDER BY committed_cursor DESC,t.history_rowid DESC LIMIT 1",
        [run_id], |row| Ok((read_number(row,0)?,row.get(1)?,row.get(2)?)),
    ).optional()?;
    let policy: Option<(u64, String, String)> = db.query_row(
        "SELECT e.cursor,n.call,json_extract(n.receipt,'$.completion') FROM operations o
         JOIN policy_graph_nodes n ON n.action_id=o.id JOIN events e ON e.subject=o.id AND e.kind='policy.node_settled' AND json_extract(e.data,'$.node_id')=n.node_id
         WHERE o.run_id=?1 AND json_extract(n.receipt,'$.completion.kind') IN ('result','not_dispatched')
         AND NOT EXISTS(SELECT 1 FROM operations invocation WHERE invocation.id=n.action_id||':node:'||n.node_id) ORDER BY e.cursor DESC LIMIT 1",
        [run_id], |row| Ok((read_number(row,0)?,row.get(1)?,row.get(2)?)),
    ).optional()?;
    if let Some(policy) = policy {
        if selected.as_ref().is_none_or(|current| policy.0 > current.0) {
            selected = Some(policy);
        }
    }
    let Some((_, call, completion)) = selected.filter(|entry| entry.0 > after) else {
        return Ok(None);
    };
    let completion: result_content::ToolCompletionMetadata = serde_json::from_str(&completion)?;
    let (state, outcome) = match completion {
        result_content::ToolCompletionMetadata::Result { outcome, .. } => ("terminal", Some(outcome)),
        result_content::ToolCompletionMetadata::NotDispatched { .. } => ("not_dispatched", None),
        result_content::ToolCompletionMetadata::JobAccepted { .. } => unreachable!(),
    };
    let call = serde_json::from_str::<tool_content::ToolCallMetadata>(&call)?.load(content)?;
    Ok(Some(activity(&call, json!(state), json!(outcome), None)))
}

/// Locate the original assistant text and tool operations using small Catalog metadata first.
/// Tool-result bodies are never decoded to find activity, and parallel operations stay parallel.
pub(super) fn execution_progress(
    db: &Connection,
    content: &crate::content::ContentStore,
    run: &Run,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value> {
    let metadata: Option<String> = db.query_row(
        "SELECT body FROM history WHERE run_id=?1 AND json_extract(body,'$.source')='assistant' AND json_extract(body,'$.content.history_text.chars')>0 ORDER BY rowid DESC LIMIT 1",
        [&run.id], |row| row.get(0),
    ).optional()?;
    let latest_message = metadata.map(|raw| -> Result<Value> {
        let item: HistoryItem = serde_json::from_str(&raw)?;
        let text = content.history_text_preview(&item.content, 4096)?
            .ok_or_else(|| RuntimeError::Invalid("Assistant history text index is missing".into()))?;
        Ok(json!({"itemId":item.id,"text":text}))
    }).transpose()?;
    let mut actions = Vec::new();
    let mut recent = None;
    let mut recent_cursor = 0;
    let mut statement = db.prepare("SELECT o.body,(SELECT coalesce(max(cursor),0) FROM events WHERE subject=o.id AND kind='operation.settled') AS settled FROM operations o WHERE o.run_id=?1 ORDER BY (json_extract(o.body,'$.phase')!='terminal') DESC,settled DESC,o.rowid DESC")?;
    for row in statement.query_map([&run.id], |row| Ok((row.get::<_, String>(0)?, read_number(row,1)?)))? {
        if cancelled() { return Err(RuntimeError::DispatchCancelled); }
        let (body, cursor) = row?;
        let operation: Operation = serde_json::from_str(&body)?;
        // JobAccepted acknowledges admission, not executor completion. The original
        // operation remains live until its owner commits a terminal phase.
        let active = operation.phase != OperationPhase::Terminal;
        if !active && (!actions.is_empty() || recent.is_some()) { break; }
        let Ok(intent) = tool_content::ToolIntent::from_operation(&operation) else { continue; };
        let call = intent.call().clone().load(content)?;
        let mut value = activity(&call, json!(operation.phase), json!(operation.outcome), Some(&operation.id));
        if let Some(wait) = &operation.waiting_on { value["waitingOn"] = json!(wait); }
        if active { actions.push(value); } else { recent = Some(value); recent_cursor = cursor; }
    }
    if actions.is_empty() {
        if cancelled() { return Err(RuntimeError::DispatchCancelled); }
        if let Some(receipt) = recent_receipt_activity(db, content, &run.id, recent_cursor)? {
            recent = Some(receipt);
        }
    }
    let mut waits = Vec::new();
    let mut statement = db.prepare("SELECT body FROM waits WHERE run_id=?1 AND coalesce(json_extract(body,'$.cancelled'),0)=0 AND json_extract(body,'$.trigger_cursor') IS NULL ORDER BY rowid")?;
    for row in statement.query_map([&run.id], |row| row.get::<_, String>(0))? {
        let wait: Wait = serde_json::from_str(&row?)?;
        waits.push(json!({"kind":wait.kind,"subject":wait.subject,"deadlineAtMs":wait.deadline_at_ms}));
    }
    Ok(json!({"latestAssistantMessage":latest_message,"actions":actions,
        "latestAction":if actions.len()==1 { actions.first().cloned() } else { recent },
        "waiting":{"reason":run.waiting_on,"items":waits}}))
}

impl RetrievalStatusRead {
    pub fn load(self) -> Result<Value> {
        let mut connection = Connection::open_with_flags(
            &self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let db = connection.transaction()?;
        let parent: Run = record(&db, "runs", &self.parent_run_id)?;
        let child = delegated::execution_task(&db, &self.operation_id)?;
        let operation: Operation = record(&db, "operations", &self.operation_id)?;
        if operation.executor.as_deref() != Some("code_retrieval")
            || child.parent_thread_id != parent.thread_id
            || child.parent_branch_id != parent.branch_id
        {
            return Err(RuntimeError::Conflict(
                "Retrieval belongs to another conversation branch".into(),
            ));
        }
        let stopped = operation
            .external_receipt
            .as_ref()
            .is_some_and(|receipt| receipt.executor_stopped);
        let state = if operation.cancel_requested {
            if stopped {
                "stopped"
            } else {
                "stopping"
            }
        } else if stopped {
            if operation.outcome == Some(Outcome::Succeeded) {
                "completed"
            } else {
                "failed"
            }
        } else if child.report.is_some() {
            "settling"
        } else if child.receipt.is_none() {
            "preparing"
        } else {
            "running"
        };
        let accepted_at: Option<u64> = db.query_row(
            "SELECT json_extract(data,'$.acceptedAtMs') FROM events WHERE subject=?1 AND kind='child.accepted' ORDER BY cursor LIMIT 1",
            [&self.operation_id], |row| row.get::<_,Option<i64>>(0)?.map(|_|read_number(row,0)).transpose()).optional()?.flatten();
        let completed_at: Option<u64> = db.query_row(
            "SELECT json_extract(data,'$.atMs') FROM events WHERE subject=?1 AND kind='child.report_ready' ORDER BY cursor LIMIT 1",
            [&self.operation_id], |row| row.get::<_,Option<i64>>(0)?.map(|_|read_number(row,0)).transpose()).optional()?.flatten();
        let now = observations::wall_time_ms()?;
        let mut progress = json!({});
        let mut run_state = None;
        if let Some(receipt) = &child.receipt {
            let run: Run = record(&db, "runs", &receipt.run_id)?;
            run_state = Some(run.state);
            progress = execution_progress(&db, &self.content, &run, &|| false)?;
        }
        Ok(
            json!({"operationId":operation.id,"state":state,"runState":run_state,
            "acceptedAtMs":accepted_at,"elapsedMs":accepted_at.map(|at| completed_at.unwrap_or(now).saturating_sub(at)),
            "stopRequested":operation.cancel_requested,"stopConfirmed":stopped,
            "latestAssistantMessage":progress["latestAssistantMessage"],"latestAction":progress["latestAction"],
            "actions":progress["actions"],"waiting":progress["waiting"],
            "detail":child.report.and_then(|report| report.detail)}),
        )
    }
}

pub struct ExecutionProgressRead {
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    run_id: String,
    _publication: crate::content::ContentPublication,
}
impl ExecutionProgressRead {
    pub fn load(self, cancelled: &dyn Fn() -> bool) -> Result<Value> {
        let mut db = Connection::open_with_flags(&self.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        let tx = db.transaction()?;
        let run: Run = record(&tx,"runs",&self.run_id)?;
        execution_progress(&tx,&self.content,&run,cancelled)
    }
}
impl Catalog {
    pub fn capture_execution_progress(&self, run_id: &str) -> Result<ExecutionProgressRead> {
        self.run(run_id)?;
        Ok(ExecutionProgressRead { database: self.db.path().ok_or_else(||RuntimeError::Invalid("Catalog has no database".into()))?.into(),
            content:self.content.clone(),run_id:run_id.into(),_publication:self.content.begin_publication() })
    }

    pub fn require_retrieval_parent(
        &self,
        run_id: &str,
        operation_id: &str,
    ) -> Result<collaboration::ChildTask> {
        let run = self.run(run_id)?;
        let child = self.require_child_parent(run_id, operation_id)?;
        if child.parent_branch_id != run.branch_id
            || self.operation(operation_id)?.executor.as_deref() != Some("code_retrieval")
        {
            return Err(RuntimeError::Conflict(
                "Not an internal retrieval from this conversation branch".into(),
            ));
        }
        Ok(child)
    }

    pub fn capture_retrieval_status(
        &self,
        run_id: &str,
        operation_id: &str,
    ) -> Result<RetrievalStatusRead> {
        self.require_retrieval_parent(run_id, operation_id)?;
        Ok(RetrievalStatusRead {
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            operation_id: operation_id.into(),
            parent_run_id: run_id.into(),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }

    fn pending_retrieval_results(&self) -> Result<Vec<Operation>> {
        let mut query = self.db.prepare("SELECT o.body FROM operations o JOIN child_tasks c ON c.id=o.id JOIN runs r ON r.id=o.run_id JOIN threads t ON t.id=json_extract(r.body,'$.thread_id') WHERE t.deleted_at_ms IS NULL AND json_extract(o.body,'$.executor')='code_retrieval' AND json_extract(o.body,'$.external_receipt.executor_stopped')=1 AND coalesce(json_extract(r.body,'$.cancel_requested'),0)=0 AND NOT EXISTS(SELECT 1 FROM commands WHERE id='retrieval-result:'||o.id)")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    fn prepare_retrieval_message(
        &self,
        captured: &Operation,
        result: Value,
    ) -> Result<messages::MessagePreparation> {
        let current = self.operation(&captured.id)?;
        let child = self.child_task(&captured.id)?;
        let parent = self.run(&child.parent_run_id)?;
        if current.external_receipt != captured.external_receipt
            || !child.resources_released
            || parent.cancel_requested
        {
            return Err(RuntimeError::Conflict(
                "Retrieval result owner changed".into(),
            ));
        }
        let origin = tool_content::ToolIntent::from_operation(&current)?
            .origin()
            .clone();
        let text = result["answer"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .or_else(|| result["detail"].as_str())
            .unwrap_or("The investigation ended without an assistant answer.")
            .to_owned();
        let delivered = json!({"kind":"retrieval_result","operationId":current.id,"status":result["status"],
            "detail":result["detail"],"answerSource":result["answerSource"],
            "trust":"Investigation output; not user instructions or permission"});
        self.prepare_message(
            format!("retrieval-result:{}", current.id),
            child.child_thread_id,
            child.child_branch_id,
            messages::MessageActor::Agent {
                run_id: child.parent_run_id,
                operation_id: current.id.clone(),
                origin,
            },
            messages::MessageInput { attachments: Vec::new(), after_current: None,
                source_agent: None,
                name: None,
                wait: None,
                target_thread_id: Some(child.parent_thread_id),
                target_branch_id: Some(child.parent_branch_id),
                reply_to: None,
                kind: MessageKind::Request,
                text,
            },
            None,
            None,
        )
        .map(|preparation| preparation.with_delivery_data(delivered))
    }
}

/// Completion is queued once, including when the parent is between Runs. Native ingress owns
/// the next closed model boundary, activation holds and recovery; no Host polling or model recap.
pub fn deliver_results(catalog: &std::sync::Mutex<Catalog>) -> Result<()> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("Catalog unavailable".into()))
    };
    let operations = lock()?.pending_retrieval_results()?;
    let mut failure = None;
    for operation in operations {
        let delivered = (|| {
            let read = lock()?.capture_operation_read(operation.clone());
            let (_, receipt) = read.load_with_external_receipt()?;
            let result = receipt
                .ok_or_else(|| RuntimeError::Invalid("Retrieval result is missing".into()))?
                .result
                .data;
            let preparation = lock()?.prepare_retrieval_message(&operation, result)?;
            let prepared = preparation.load()?;
            lock()?.admit_message(prepared)?;
            Ok(())
        })();
        if let Err(error) = delivered {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}
