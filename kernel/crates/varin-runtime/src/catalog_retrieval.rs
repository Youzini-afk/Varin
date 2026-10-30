//! Internal investigations are background Jobs; their answers use the original input queue.
use super::*;
use crate::execution::{Content, ConversationItem};

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

fn assistant_text(content: Content<crate::output::StoredMedia>) -> Option<String> {
    let text = match content {
        Content::Text { text } => text,
        Content::Output { output } => output
            .parts
            .into_iter()
            .filter_map(|part| match part {
                crate::output::OutputPart::Text { text } => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then_some(text)
}

/// Activity describes the actual invocation without copying file bodies or tool output.
fn activity_arguments(arguments: &Value) -> Value {
    let mut selected = serde_json::Map::new();
    for key in [
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
            call.arguments
                .pointer("/reference/name")
                .and_then(Value::as_str)
                .unwrap_or(&call.name),
            call.arguments.get("arguments").unwrap_or(&call.arguments),
        )
    } else {
        (call.name.as_str(), &call.arguments)
    };
    json!({"operationId":operation_id,"callId":call.call_id,"tool":tool,"state":state,"outcome":outcome,"arguments":activity_arguments(arguments)})
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
        let mut latest_message = None;
        let mut latest_action = None;
        let mut run_state = None;
        if let Some(receipt) = &child.receipt {
            let run: Run = record(&db, "runs", &receipt.run_id)?;
            run_state = Some(run.state);
            let mut rows =
                db.prepare("SELECT body FROM history WHERE run_id=?1 ORDER BY rowid DESC")?;
            let mut results = std::collections::BTreeMap::new();
            for row in rows.query_map([&run.id], |row| row.get::<_, String>(0))? {
                let metadata: HistoryItem = serde_json::from_str(&row?)?;
                if !matches!(
                    metadata.source,
                    HistorySource::Assistant | HistorySource::Tool
                ) {
                    continue;
                }
                let (body, _) = self
                    .content
                    .load_stored_history_payload(&metadata.content, &|| false)?;
                let message: ConversationItem<crate::output::StoredMedia> =
                    serde_json::from_value(body)?;
                match message.content {
                    Content::ToolResult { result } => {
                        let (state, outcome) = match result.completion {
                            crate::execution::ToolCompletion::Result { outcome, .. } => {
                                (json!("terminal"), json!(outcome))
                            }
                            crate::execution::ToolCompletion::NotDispatched { .. } => {
                                (json!("terminal"), json!(Outcome::Failed))
                            }
                            crate::execution::ToolCompletion::JobAccepted { .. } => {
                                (json!("running"), Value::Null)
                            }
                        };
                        results.insert(result.call_id, (state, outcome));
                    }
                    Content::ToolCall { call } if latest_action.is_none() => {
                        let (state, outcome) = results
                            .remove(&call.call_id)
                            .unwrap_or((json!("running"), Value::Null));
                        latest_action = Some(activity(&call, state, outcome, None));
                    }
                    content
                        if metadata.source == HistorySource::Assistant
                            && latest_message.is_none() =>
                    {
                        if let Some(text) = assistant_text(content) {
                            latest_message = Some(json!({"itemId":metadata.id,"text":text}));
                        }
                    }
                    _ => {}
                }
                if latest_action.is_some() && latest_message.is_some() {
                    break;
                }
            }
            let mut rows = db.prepare("SELECT body FROM operations WHERE run_id=?1 ORDER BY (json_extract(body,'$.phase')!='terminal' AND json_extract(body,'$.call_completion') IS NULL) DESC,rowid DESC")?;
            for row in rows.query_map([&run.id], |row| row.get::<_, String>(0))? {
                let action: Operation = serde_json::from_str(&row?)?;
                if latest_action.is_some()
                    && (action.phase == OperationPhase::Terminal
                        || action.call_completion.is_some())
                {
                    break;
                }
                let Ok(intent) = tool_content::ToolIntent::from_operation(&action) else {
                    continue;
                };
                let call = intent.call().clone().load(&self.content)?;
                latest_action = Some(activity(
                    &call,
                    json!(action.phase),
                    json!(action.outcome),
                    Some(&action.id),
                ));
                break;
            }
        }
        Ok(
            json!({"operationId":operation.id,"state":state,"runState":run_state,
            "acceptedAtMs":accepted_at,"elapsedMs":accepted_at.map(|at| completed_at.unwrap_or(now).saturating_sub(at)),
            "stopRequested":operation.cancel_requested,"stopConfirmed":stopped,
            "latestAssistantMessage":latest_message,"latestAction":latest_action,
            "detail":child.report.and_then(|report| report.detail)}),
        )
    }
}

impl Catalog {
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
            messages::MessageInput { after_current: None,
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
