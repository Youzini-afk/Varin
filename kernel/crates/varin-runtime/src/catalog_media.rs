//! Owner-bound typed media reads use the existing body worker and immutable content store.
use super::*;
use crate::execution::{Content, ConversationItem};
use crate::output::*;
use base64::{Engine, engine::general_purpose::STANDARD};

enum Selection {
    History {
        head: Option<String>,
        item_id: String,
    },
    HistoryBody(Value),
    Output(Value),
    Family(super::family::FamilyRead),
}
pub struct MediaRead {
    database: std::path::PathBuf,
    epoch: u64,
    content: crate::content::ContentStore,
    request: MediaReadParams,
    selection: Selection,
    _publication: crate::content::ContentPublication,
}
fn owned_run(catalog: &Catalog, run_id: &str, request: &MediaReadParams) -> Result<()> {
    let run = catalog.run(run_id)?;
    if run.thread_id != request.thread_id || run.branch_id != request.branch_id {
        return Err(RuntimeError::Conflict(
            "media holder belongs to another Thread or branch".into(),
        ));
    }
    Ok(())
}
fn operation_reference(op: &Operation, selection: &OperationOutputSelection) -> Result<Value> {
    match selection {
        OperationOutputSelection::McpTaskResult => op
            .host_job
            .as_ref()
            .and_then(|link| link.mcp_task.as_ref())
            .and_then(|task| task.result_ref.clone())
            .ok_or_else(|| RuntimeError::NotFound("MCP task result".into())),
        OperationOutputSelection::Result => op
            .result
            .as_ref()
            .ok_or_else(|| RuntimeError::NotFound("operation result".into()))?
            .reference()
            .cloned(),
        OperationOutputSelection::ExternalReceipt => op
            .external_receipt
            .as_ref()
            .map(|r| r.result_ref.clone())
            .ok_or_else(|| RuntimeError::NotFound("external receipt".into())),
        OperationOutputSelection::Completion => match op.call_completion.as_ref() {
            Some(result_content::ToolCompletionMetadata::Result { content_ref, .. }) => {
                Ok(content_ref.clone())
            }
            Some(result_content::ToolCompletionMetadata::JobAccepted {
                content_ref: Some(reference),
                ..
            }) => Ok(reference.clone()),
            _ => Err(RuntimeError::NotFound(
                "invocation completion output".into(),
            )),
        },
    }
}
impl Catalog {
    pub fn capture_media_read(&self, request: &MediaReadParams) -> Result<MediaRead> {
        let owner: String = self.db.query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [&request.branch_id],
            |r| r.get(0),
        )?;
        if owner != request.thread_id {
            return Err(RuntimeError::Conflict(
                "media branch belongs to another Thread".into(),
            ));
        }
        let selection = match &request.holder {
            OutputMediaHolder::History { item_id } => Selection::History {
                head: self.head(&request.branch_id)?,
                item_id: item_id.clone(),
            },
            OutputMediaHolder::Input {
                input_id,
                expected_revision,
            } => {
                let input = self.queued_input_metadata(input_id)?;
                if input.thread_id != request.thread_id
                    || input.branch_id != request.branch_id
                    || input.revision != *expected_revision
                    || !input.origin.is_user_ingress()
                {
                    return Err(RuntimeError::Conflict(
                        "media input owner or revision changed".into(),
                    ));
                }
                let reference: String = self.db.query_row(
                    "SELECT body FROM input_history_content WHERE input_id=?1",
                    [input_id],
                    |r| r.get(0),
                )?;
                Selection::HistoryBody(serde_json::from_str(&reference)?)
            }
            OutputMediaHolder::Operation {
                operation_id,
                output,
            } => {
                let op: Operation = record(&self.db, "operations", operation_id)?;
                owned_run(self, &op.run_id, request)?;
                Selection::Output(operation_reference(&op, output)?)
            }
            OutputMediaHolder::Event { cursor, output } => {
                let (subject, kind, data): (String, String, String) = self.db.query_row(
                    "SELECT subject,kind,data FROM events WHERE cursor=?1",
                    [sql_number(*cursor)?],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                if matches!(
                    kind.as_str(),
                    "operation.accepted"
                        | "operation.dispatched"
                        | "operation.settled"
                        | "operation.external_receipt"
                        | "operation.recovered"
                        | "permission.opened"
                ) {
                    let op: Operation = serde_json::from_str(&data)?;
                    owned_run(self, &op.run_id, request)?;
                    Selection::Output(operation_reference(&op, output)?)
                } else if kind == "host_job.result_observed"
                    && matches!(output, OperationOutputSelection::McpTaskResult)
                {
                    let op: Operation = record(&self.db, "operations", &subject)?;
                    owned_run(self, &op.run_id, request)?;
                    let fact: super::host_jobs::McpResultFact = serde_json::from_str(&data)?;
                    Selection::Output(
                        fact.result_ref
                            .ok_or_else(|| RuntimeError::NotFound("MCP task result".into()))?,
                    )
                } else if kind == "operation.executor_stopped"
                    && matches!(output, OperationOutputSelection::ExternalReceipt)
                {
                    let op: Operation = record(&self.db, "operations", &subject)?;
                    owned_run(self, &op.run_id, request)?;
                    let data: Value = serde_json::from_str(&data)?;
                    let receipt: ExternalReceiptMetadata = serde_json::from_value(
                        data.get("host_job_stop")
                            .and_then(|v| v.get("receipt"))
                            .cloned()
                            .ok_or_else(|| RuntimeError::NotFound("event receipt".into()))?,
                    )?;
                    Selection::Output(receipt.result_ref)
                } else {
                    return Err(RuntimeError::Invalid(
                        "event does not hold the selected output".into(),
                    ));
                }
            }
            OutputMediaHolder::ChildReport {
                operation_id,
                execution_id,
                item_id,
            } => {
                let child = self.child_task(operation_id)?;
                let execution_id = execution_id.as_deref().unwrap_or(operation_id);
                self.require_delegated_parent(&child.parent_run_id, operation_id, execution_id)?;
                let parent = child.parent_thread_id == request.thread_id;
                let own = child.child_thread_id == request.thread_id
                    && child.child_branch_id == request.branch_id;
                if !parent && !own {
                    return Err(RuntimeError::Conflict(
                        "child report belongs to another Thread branch".into(),
                    ));
                }
                Selection::HistoryBody(
                    self.capture_delegated_report(execution_id, item_id, 0, 65536)?
                        .reference(),
                )
            }
            OutputMediaHolder::PolicyEvidence { reference } => {
                let op: Operation = record(&self.db, "operations", &reference.action_id)?;
                owned_run(self, &op.run_id, request)?;
                if self.is_policy_model_reference(reference)? {
                    return Err(RuntimeError::Invalid(
                        "policy model evidence does not have output-body media parts".into(),
                    ));
                }
                Selection::Output(self.owned_policy_reference(&op.run_id, reference)?)
            }
            OutputMediaHolder::Family {
                thread_id,
                branch_id,
                ..
            } => Selection::Family(self.capture_family_read(
                &request.thread_id,
                Some(thread_id),
                Some(branch_id),
            )?),
        };
        Ok(MediaRead {
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog has no database".into()))?
                .into(),
            epoch: self.epoch,
            content: self.content.clone(),
            request: request.clone(),
            selection,
            _publication: self.content.begin_publication(),
        })
    }
}
impl MediaRead {
    pub fn chunk(self, cancelled: &dyn Fn() -> bool) -> Result<MediaReadChunk> {
        if cancelled() {
            return Err(RuntimeError::DispatchCancelled);
        }
        let media = match self.selection {
            Selection::History { mut head, item_id } => {
                let db = history_views::current_history_owner(&self.database, self.epoch)?;
                db.execute_batch("BEGIN")?;
                let item = loop {
                    if cancelled() {
                        return Err(RuntimeError::DispatchCancelled);
                    }
                    let id = head.ok_or_else(|| {
                        RuntimeError::Conflict("media history is not on this branch".into())
                    })?;
                    let item: HistoryItem = record(&db, "history", &id)?;
                    if item.id == item_id {
                        break item;
                    }
                    head = item.parent;
                };
                history_media(
                    &self.content,
                    &item.content,
                    self.request.part_index,
                    cancelled,
                )?
            }
            Selection::HistoryBody(reference) => history_media(
                &self.content,
                &reference,
                self.request.part_index,
                cancelled,
            )?,
            Selection::Output(reference) => {
                let body: OutputBody<StoredMedia> =
                    serde_json::from_value(self.content.load_cancellable(&reference, cancelled)?)?;
                output_media(&body, self.request.part_index)?
            }
            Selection::Family(read) => return read.media(self.request, cancelled),
        };
        let chunk = read_chunk(&self.content, media, &self.request, cancelled)?;
        history_views::current_history_owner(&self.database, self.epoch)?;
        Ok(chunk)
    }
}
fn output_media(output: &OutputBody<StoredMedia>, index: usize) -> Result<StoredMedia> {
    match output.parts.get(index) {
        Some(OutputPart::Media { media }) => Ok(media.clone()),
        _ => Err(RuntimeError::Invalid(
            "selected output part is not media".into(),
        )),
    }
}
pub(super) fn history_media(
    content: &crate::content::ContentStore,
    reference: &Value,
    index: usize,
    cancelled: &dyn Fn() -> bool,
) -> Result<StoredMedia> {
    let payload = content.load_cancellable(reference, cancelled)?;
    match payload.get("format").and_then(Value::as_str) {
        Some("user_input") => {
            let media: Vec<StoredMedia> = serde_json::from_value(
                payload["content"]
                    .get("attachments")
                    .cloned()
                    .unwrap_or(json!([])),
            )?;
            media
                .get(index)
                .cloned()
                .ok_or_else(|| RuntimeError::Invalid("selected attachment does not exist".into()))
        }
        Some("conversation") => {
            let item: ConversationItem<StoredMedia> =
                serde_json::from_value(payload["content"].clone())?;
            match item.content {
                Content::Media { media } if index == 0 => Ok(media),
                Content::Output { output } => output_media(&output, index),
                Content::ToolResult { result } => match result.completion {
                    crate::execution::ToolCompletion::Result { content, .. }
                    | crate::execution::ToolCompletion::JobAccepted {
                        content: Some(content),
                        ..
                    } => output_media(&content, index),
                    _ => Err(RuntimeError::Invalid(
                        "tool receipt has no output body".into(),
                    )),
                },
                _ => Err(RuntimeError::Invalid(
                    "selected history part is not media".into(),
                )),
            }
        }
        _ => Err(RuntimeError::Invalid(
            "history body does not contain typed media".into(),
        )),
    }
}
pub(super) fn read_chunk(
    content: &crate::content::ContentStore,
    media: StoredMedia,
    request: &MediaReadParams,
    cancelled: &dyn Fn() -> bool,
) -> Result<MediaReadChunk> {
    if media.content_ref.content_object != request.expected_content_ref {
        return Err(RuntimeError::Conflict(
            "selected media reference changed".into(),
        ));
    }
    if cancelled() {
        return Err(RuntimeError::DispatchCancelled);
    }
    let chunk = content.load_chunk(
        &serde_json::to_value(&media.content_ref)?,
        request.chunk_index,
    )?;
    if cancelled() {
        return Err(RuntimeError::DispatchCancelled);
    }
    Ok(MediaReadChunk {
        media,
        part_index: request.part_index,
        chunk_index: chunk.chunk_index,
        chunk_count: chunk.chunk_count,
        total_bytes: chunk.total_bytes,
        bytes_base64: STANDARD.encode(chunk.bytes),
    })
}
