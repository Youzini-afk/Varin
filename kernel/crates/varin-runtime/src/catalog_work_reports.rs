//! Completion replies for requests sent to existing conversations. Original Runs,
//! input identities and message receipts own the work; no child task is fabricated.
use super::*;
use crate::execution::Content;

fn requests(db: &Connection, run: &str) -> Result<Vec<(inputs::QueuedInputMetadata, String)>> {
    let mut query = db.prepare("SELECT q.body,b.bot_id FROM input_queue q JOIN bot_thread_bindings b ON b.thread_id=q.sender_thread_id WHERE q.run_id=?1 AND q.state='delivered' AND q.origin='message' AND json_extract(q.body,'$.origin.identity.kind')='request' AND json_extract(q.body,'$.origin.identity.actor.kind')='agent'")?;
    let rows = query.query_map([run], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.map(|row| {
        let (body, bot) = row?;
        Ok((serde_json::from_str(&body)?, bot))
    })
    .collect()
}

pub(super) fn directly_requested_by(db: &Connection, run: &Run, bot: &str) -> Result<bool> {
    Ok(requests(db, &run.id)?
        .iter()
        .any(|(_, requester)| requester == bot))
}

pub(super) fn publish_pending(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    let delegated: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM child_tasks WHERE child_thread_id=?1)",
        [&run.thread_id],
        |row| row.get(0),
    )?;
    if delegated {
        return Ok(());
    }
    for (request, _) in requests(tx, &run.id)? {
        event(
            tx,
            &request.id,
            run.revision,
            "bot.request_report_pending",
            json!({"messageId":request.id,"runId":run.id}),
        )?;
    }
    Ok(())
}

struct ReportRead {
    run: Run,
    request: messages::MessageIdentity,
    name: String,
    failure: Option<RunFailure>,
    items: Vec<HistoryItem>,
    content: crate::content::ContentStore,
}
struct ReportBody {
    run: Run,
    request: messages::MessageIdentity,
    text: String,
    answer: Option<HistoryItem>,
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
        let state = serde_json::to_value(self.run.state)?;
        let mut notice = format!(
            "Work {} ({}) ended with status {}. Original Run: {}.",
            self.name,
            self.run.thread_id,
            state.as_str().unwrap_or_default(),
            self.run.id
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
        })
    }
}

impl Catalog {
    fn pending_work_reports(&self) -> Result<Vec<(String, String)>> {
        let mut query = self.db.prepare("SELECT DISTINCT json_extract(e.data,'$.messageId'),json_extract(e.data,'$.runId') FROM events e JOIN input_queue q ON q.id=json_extract(e.data,'$.messageId') JOIN threads target ON target.id=q.sender_thread_id JOIN branches b ON b.id=q.branch_id JOIN threads source ON source.id=b.thread_id WHERE e.kind='bot.request_report_pending' AND target.deleted_at_ms IS NULL AND source.deleted_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM commands c WHERE c.id='bot-report:run:'||json_extract(e.data,'$.runId')||':'||q.id) ORDER BY e.cursor")?;
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
            run,
            request,
            name,
            failure,
            items,
            content: self.content.clone(),
        })
    }

    fn prepare_work_report(&self, body: ReportBody) -> Result<messages::MessagePreparation> {
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
                target_thread_id: Some(body.request.sender_thread_id),
                target_branch_id: Some(body.request.sender_branch_id),
                reply_to: Some(body.request.message_id),
                kind: if self.run(requester)?.cancel_requested {
                    MessageKind::Inform
                } else {
                    MessageKind::Request
                },
                text: body.text,
            },
            None,
            None,
        )
        .map(|preparation| preparation.with_attachments(attachments))
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
