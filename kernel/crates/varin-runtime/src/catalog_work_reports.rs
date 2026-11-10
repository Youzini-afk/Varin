//! Completion replies for requests sent to existing conversations. Original Runs,
//! input identities and message receipts own the work; no child task is fabricated.
use super::*;
use crate::execution::Content;

// A retrieval result activates its parent through the same queue, but is the original
// Operation's completion, not a work request from a public Agent. Its private worker
// must never become the receiver of an automatic completion reply.
const WORK_REQUEST: &str = r#"q.state='delivered' AND q.origin='message'
    AND json_extract(q.body,'$.origin.identity.kind')='request'
    AND json_extract(q.body,'$.origin.identity.actor.kind')='agent'
    AND NOT EXISTS(SELECT 1 FROM child_tasks internal JOIN operations owner ON owner.id=internal.id
        WHERE internal.child_thread_id=q.sender_thread_id AND json_extract(owner.body,'$.executor')='code_retrieval')"#;

fn requests(db: &Connection, run: &str) -> Result<Vec<inputs::QueuedInputMetadata>> {
    let mut query = db.prepare(&format!("SELECT q.body FROM input_queue q WHERE q.run_id=?1 AND {WORK_REQUEST}"))?;
    let rows = query
        .query_map([run], |row| row.get::<_, String>(0))?
        .map(|row| Ok(serde_json::from_str(&row?)?))
        .collect();
    rows
}

pub(super) fn directly_requested_by(db: &Connection, run: &Run, bot: &str) -> Result<bool> {
    for request in requests(db, &run.id)? {
        let identity = messages::message_identity(&request)?;
        if super::super::bot::thread_bot(db, &identity.sender_thread_id)?.as_deref() == Some(bot) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn publish_pending(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    for request in requests(tx, &run.id)? {
        // A resumed delegated execution already reports this exact admission. Other
        // requests delivered into its active Run still retain their own reply route.
        let delegated: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM delegated_executions WHERE run_id=?1 AND json_extract(body,'$.trigger.kind')='message_request' AND json_extract(body,'$.trigger.message_id')=?2)", params![run.id,request.id], |row|row.get(0))?;
        if !delegated {
            event(
                tx,
                &request.id,
                run.revision,
                "bot.request_report_pending",
                json!({"messageId":request.id,"runId":run.id}),
            )?;
        }
    }
    Ok(())
}

struct ReportRead {
    run: Run,
    request: messages::MessageIdentity,
    name: String,
    execution: model_references::ExecutionReference,
    failure: Option<RunFailure>,
    items: Vec<HistoryItem>,
    content: crate::content::ContentStore,
}
struct ReportBody {
    run: Run,
    request: messages::MessageIdentity,
    text: String,
    answer: Option<HistoryItem>,
    execution: model_references::ExecutionReference,
    partial: bool,
}
impl ReportRead {
    fn load(self) -> Result<ReportBody> {
        // Content reads happen outside the Catalog mutex, like other durable
        // message preparations. Only the final visible answer is copied.
        let mut answer = None;
        let mut text = String::new();
        for item in self.items {
            let item = self.content.hydrate_history(item)?;
            let visible = super::super::execution_persistence::history_input_items(
                &item.id,
                item.source,
                &item.content,
            )?;
            let body = visible
                .iter()
                .flat_map(|part| match &part.content {
                    Content::Text { text } => vec![text.clone()],
                    Content::Output { output } => output
                        .parts
                        .iter()
                        .filter_map(|part| match part {
                            crate::output::OutputPart::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect(),
                    _ => Vec::new(),
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let has_attachment = visible.iter().any(|part| matches!(&part.content, Content::Output { output }
                if output.parts.iter().any(|part| matches!(part, crate::output::OutputPart::Attachment { .. } | crate::output::OutputPart::Media { .. }))));
            if !body.trim().is_empty() || has_attachment {
                text = body;
                answer = Some(item);
                break;
            }
        }
        // Reuse the existing original-output page budget, preserving UTF-8 boundaries.
        // The item reference below remains the authority for the complete answer.
        let mut end = text.len().min(65536);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let partial = end < text.len();
        text.truncate(end);
        let state = serde_json::to_value(self.run.state)?;
        let mut notice = format!(
            "Work {} [{}], execution {}, ended with status {}.",
            self.name,
            self.execution.agent_id,
            self.execution.reference,
            state.as_str().unwrap_or_default()
        );
        if let Some(failure) = self.failure {
            notice.push_str(&format!("\n{}: {}", failure.code, failure.message));
        }
        Ok(ReportBody {
            run: self.run,
            request: self.request,
            text: if text.is_empty() {
                notice
            } else {
                format!("{notice}\n\n{text}")
            },
            answer,
            execution: self.execution,
            partial,
        })
    }
}

impl Catalog {
    fn pending_work_reports(&self) -> Result<Vec<(String, String)>> {
        let mut query = self.db.prepare(&format!("SELECT DISTINCT json_extract(e.data,'$.messageId'),json_extract(e.data,'$.runId') FROM events e JOIN input_queue q ON q.id=json_extract(e.data,'$.messageId') JOIN threads target ON target.id=q.sender_thread_id JOIN branches b ON b.id=q.branch_id JOIN threads source ON source.id=b.thread_id WHERE e.kind='bot.request_report_pending' AND {WORK_REQUEST} AND target.deleted_at_ms IS NULL AND source.deleted_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.id='bot-report:run:'||json_extract(e.data,'$.runId')||':'||q.id) ORDER BY e.cursor"))?;
        let rows = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()
            .map_err(Into::into)
    }

    fn capture_work_report(&self, message: &str, run_id: &str) -> Result<ReportRead> {
        let input: inputs::QueuedInputMetadata = record(&self.db, "input_queue", message)?;
        let request = messages::message_identity(&input)?.clone();
        let run = self.run(run_id)?;
        if !run.state.terminal()
            || input.run_id.as_deref() != Some(run_id)
            || input.state != InputState::Delivered
        {
            return Err(RuntimeError::Conflict(
                "Work request has no completed receiving Run".into(),
            ));
        }
        let mut query = self.db.prepare("SELECT body FROM history WHERE run_id=?1 AND json_extract(body,'$.source')='assistant' ORDER BY rowid DESC")?;
        let items = query
            .query_map([run_id], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<Vec<_>>>()?;
        let name = self.db.query_row(
            "SELECT title FROM threads WHERE id=?1",
            [&run.thread_id],
            |row| row.get(0),
        )?;
        let failure = self.run_failure(&run.id)?;
        Ok(ReportRead {
            execution: self.execution_reference(&run.id)?,
            run,
            request,
            name,
            failure,
            items,
            content: self.content.clone(),
        })
    }

    fn prepare_work_report(
        &mut self,
        body: ReportBody,
    ) -> Result<messages::MessagePreparation> {
        let messages::MessageActor::Agent {
            run_id: requester, ..
        } = &body.request.actor
        else {
            return Err(RuntimeError::Invalid(
                "Work report requester is not an Agent".into(),
            ));
        };
        let attachments = body
            .answer
            .as_ref()
            .map(|answer| {
                super::super::attachments::history_attachments_with_report(
                    &self.db,
                    answer,
                    &answer.content,
                )
            })
            .transpose()?
            .unwrap_or_default();
        let requester_run = self.run(requester)?;
        let (read, model_read) = if let Some(answer) = &body.answer {
            let arguments = json!({"threadId":body.run.thread_id,"branchId":body.run.branch_id,
                "runId":body.run.id,"query":{"kind":"item","itemId":answer.id}});
            let target = self.model_history_read_target(family::READ_TOOL, &arguments)?;
            let reference = self.register_model_reference(
                model_references::ReferenceKind::Item,
                "history",
                &target,
                &body.run.id,
            )?;
            self.retain_model_reference(&reference, requester)?;
            (json!({"tool":family::READ_TOOL,"arguments":arguments}),
                json!({"tool":family::READ_TOOL,"arguments":{"ref":reference}}))
        } else {
            (Value::Null, Value::Null)
        };
        let data = json!({"kind":"work_report","executionRef":body.execution.reference,"agentRef":body.execution.agent_id,
            "status":body.run.state,"runId":body.run.id,"itemId":body.answer.as_ref().map(|item|&item.id),
            "read":read,"previewPartial":body.partial});
        self.prepare_message(
            format!("bot-report:run:{}:{}", body.run.id, body.request.message_id),
            body.run.thread_id,
            body.run.branch_id,
            messages::MessageActor::WorkReport {
                run_id: body.run.id,
                request_message_id: body.request.message_id.clone(),
            },
            messages::MessageInput {
                attachments: attachments
                    .iter()
                    .map(|file| attachments::AttachmentSelection::Ref {
                        reference: file.reference.clone(),
                    })
                    .collect(),
                after_current: None,
                source_agent: None,
                name: None,
                wait: None,
                target_thread_id: Some(body.request.sender_thread_id.clone()),
                target_branch_id: Some(body.request.sender_branch_id),
                reply_to: Some(body.request.message_id),
                kind: if requester_run.cancel_requested
                    || requester_run.state == RunState::Cancelled
                    || super::super::bot::thread_bot(&self.db, &body.request.sender_thread_id)?
                        .is_none()
                {
                    MessageKind::Inform
                } else {
                    MessageKind::Request
                },
                text: body.text,
            },
            None,
            None,
        )
        .and_then(|preparation| {
            preparation
                .with_attachments(attachments)
                .with_delivery_data(data).with_report_model_read(model_read).with_report_receiver(self, &requester_run.id)?
                .with_model_references(self)
        })
    }
}

pub(super) fn deliver(catalog: &std::sync::Mutex<Catalog>) -> Result<()> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("Catalog unavailable".into()))
    };
    let candidates = lock()?.pending_work_reports()?;
    let mut failure = None;
    for (message, run) in candidates {
        let delivered = (|| {
            let read = lock()?.capture_work_report(&message, &run)?;
            let body = read.load()?;
            let preparation = lock()?.prepare_work_report(body)?;
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

#[cfg(test)]
#[path = "catalog_work_reports_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "catalog_retrieval_reports_tests.rs"]
mod retrieval_tests;
