//! Typed delivery facts. Storage/material owners retain bytes and authenticate references;
//! Catalog publishes their prepared descriptors with the original input, never from prose.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged, deny_unknown_fields)]
pub enum AttachmentSelection {
    Ref {
        #[serde(rename = "ref")]
        reference: String,
    },
    Path {
        path: String,
    },
}
impl AttachmentSelection {
    pub fn validate(&self) -> Result<()> {
        let value = match self {
            Self::Ref { reference } => reference,
            Self::Path { path } => path,
        };
        if value.trim().is_empty() || value.contains('\0') {
            return Err(RuntimeError::Invalid(
                "attachment requires a nonempty reference or path".into(),
            ));
        }
        Ok(())
    }
}

/// Public immutable-file descriptor. No owner address, grant, mutable path or bytes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attachment {
    #[serde(rename = "ref")]
    pub reference: String,
    pub filename: String,
    pub mime_type: String,
    pub byte_length: u64,
}
impl Attachment {
    pub fn validate(&self) -> Result<()> {
        if self.reference.trim().is_empty()
            || self.reference.contains('\0')
            || self.filename.trim().is_empty()
            || self.filename.contains('\0')
            || self.mime_type.trim().is_empty()
            || self.mime_type.contains('\0')
        {
            return Err(RuntimeError::Invalid(
                "attachment descriptor is incomplete".into(),
            ));
        }
        Ok(())
    }
    pub fn is_direct_image(&self) -> bool {
        matches!(self.mime_type.as_str(), "image/png"|"image/jpeg"|"image/webp"|"image/gif")
    }
    pub fn description(&self) -> String {
        let mut text=format!("File attachment: {}",serde_json::to_string(self).expect("typed attachment"));
        if self.mime_type.starts_with("image/") && !self.is_direct_image() {
            text.push_str(" This format is delivered as a file, not direct model vision input.");
        }
        text
    }
}

pub fn input_attachments(input: &Value) -> Result<Vec<Attachment>> {
    let attachments: Vec<Attachment> = input
        .get("fileAttachments")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    for attachment in &attachments {
        attachment.validate()?;
    }
    Ok(attachments)
}

pub(super) fn output_attachments<M>(output: &crate::output::OutputBody<M>) -> Vec<Attachment> {
    output
        .parts
        .iter()
        .filter_map(|part| match part {
            crate::output::OutputPart::Attachment { attachment } => Some(attachment.clone()),
            _ => None,
        })
        .collect()
}
/// Only the runtime's typed envelope is authoritative. Arbitrary output data and text are not.
pub(super) fn history_attachments(body: &Value, source:HistorySource) -> Result<Vec<Attachment>> {
    if let Ok(item) = serde_json::from_value::<
        crate::execution::ConversationItem<crate::output::StoredMedia>,
    >(body.clone())
    {
        return Ok(match item.content {
            crate::execution::Content::Output { output } => output_attachments(&output),
            crate::execution::Content::ToolResult { result } => match result.completion {
                crate::execution::ToolCompletion::Result { content, .. } => {
                    output_attachments(&content)
                }
                crate::execution::ToolCompletion::JobAccepted {
                    content: Some(content),
                    ..
                } => output_attachments(&content),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        });
    }
    if source==HistorySource::User {input_attachments(body)} else {Ok(Vec::new())}
}

/// Final report relationships remain available in a bounded history read even
/// when that page contains prose only. The original report, not prose parsing at
/// read time, selects these already acquired descriptors.
pub(super) fn history_attachments_with_report(db: &Connection, item: &HistoryItem, body: &Value) -> Result<Vec<Attachment>> {
    let mut files = history_attachments(body, item.source)?;
    if item.source != HistorySource::Assistant { return Ok(files); }
    let execution: Option<String> = db.query_row("SELECT body FROM delegated_executions WHERE run_id=?1", [&item.run_id], |row| row.get(0)).optional()?;
    if let Some(execution) = execution {
        let execution: delegated::DelegatedExecution = serde_json::from_str(&execution)?;
        if let Some(report) = execution.report.filter(|report| report.history_ids.contains(&item.id)) {
            for attachment in report.attachments {
                if attachment.reference.starts_with("attachment:material_") && !files.iter().any(|file| file.reference == attachment.reference) { files.push(attachment); }
            }
        }
    }
    Ok(files)
}

pub(super) fn validate_prepared(
    selections: &[AttachmentSelection],
    attachments: &[Attachment],
) -> Result<()> {
    if selections.len() != attachments.len() {
        return Err(RuntimeError::Invalid(
            "every attachment must be prepared before the message is accepted".into(),
        ));
    }
    for (selection, attachment) in selections.iter().zip(attachments) {
        selection.validate()?;
        attachment.validate()?;
        if let AttachmentSelection::Ref { reference } = selection {
            if (reference.starts_with("attachment:") && reference != &attachment.reference)
                || (reference.starts_with("varin-material://") && material_attachment_reference(reference).as_ref() != Some(&attachment.reference)) {
                return Err(RuntimeError::Conflict(
                    "prepared attachment changed the selected fixed reference".into(),
                ));
            }
        }
    }
    Ok(())
}

/// A durable edge from the existing holder to the original immutable attachment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDelivery {
    pub holder_kind: String,
    pub holder_id: String,
    pub thread_id: String,
    pub branch_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_branch_id: Option<String>,
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_ref: Option<Value>,
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE attachment_deliveries(holder_kind TEXT NOT NULL CHECK(holder_kind IN ('input','dispatch','external_turn')),holder_id TEXT NOT NULL,thread_id TEXT NOT NULL,branch_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(holder_kind,holder_id)); CREATE INDEX attachment_deliveries_thread ON attachment_deliveries(thread_id,branch_id);")?;
    Ok(())
}
/// The same typed delivery owner now accepts original external turn holders. Runtime
/// validation keeps each target domain explicit instead of inventing native branch IDs.
pub(super) fn upgrade_external_targets(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("ALTER TABLE attachment_deliveries RENAME TO attachment_deliveries_previous; DROP INDEX attachment_deliveries_thread;")?;
    initialize(tx)?;
    tx.execute_batch("INSERT INTO attachment_deliveries SELECT * FROM attachment_deliveries_previous; DROP TABLE attachment_deliveries_previous;")?;
    Ok(())
}
fn validate_target(db: &Connection, delivery: &AttachmentDelivery) -> Result<()> {
    if delivery.holder_kind == "external_turn" {
        let owned:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM external_turns WHERE id=?1 AND conversation_id=?2)",params![delivery.holder_id,delivery.thread_id],|r|r.get(0))?;
        if !owned || !delivery.branch_id.is_empty() {return Err(RuntimeError::Conflict("attachment target is not its original external turn".into()));}
    } else {
        let owner:String=db.query_row("SELECT thread_id FROM branches WHERE id=?1",[&delivery.branch_id],|r|r.get(0))?;
        if owner != delivery.thread_id {return Err(RuntimeError::Conflict("attachment target branch belongs to another Thread".into()));}
    }
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    let mut query = db.prepare(
        "SELECT holder_kind,holder_id,thread_id,branch_id,body FROM attachment_deliveries",
    )?;
    for row in query.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })? {
        let (kind, id, thread, branch, body) = row?;
        let delivery: AttachmentDelivery = serde_json::from_str(&body)?;
        if delivery.holder_kind != kind
            || delivery.holder_id != id
            || delivery.thread_id != thread
            || delivery.branch_id != branch
            || delivery.attachments.is_empty()
        {
            return Err(RuntimeError::Invalid(
                "attachment delivery identity is malformed; data was preserved".into(),
            ));
        }
        validate_target(db,&delivery)?;
        for attachment in delivery.attachments {
            attachment.validate()?;
        }
    }
    Ok(())
}
pub(super) fn publish(db: &Connection, delivery: &AttachmentDelivery) -> Result<()> {
    if delivery.attachments.is_empty() {
        return Ok(());
    }
    for attachment in &delivery.attachments {
        attachment.validate()?;
    }
    validate_target(db,delivery)?;
    let previous = read(db, &delivery.holder_kind, &delivery.holder_id)?;
    if let Some(previous) = previous {
        if previous != *delivery {
            return Err(RuntimeError::Conflict(
                "attachment delivery has different original content".into(),
            ));
        }
        return Ok(());
    }
    db.execute("INSERT INTO attachment_deliveries(holder_kind,holder_id,thread_id,branch_id,body) VALUES(?1,?2,?3,?4,?5)",
        params![delivery.holder_kind,delivery.holder_id,delivery.thread_id,delivery.branch_id,encode(delivery)?])?;
    Ok(())
}
pub(super) fn read(
    db: &Connection,
    kind: &str,
    holder: &str,
) -> Result<Option<AttachmentDelivery>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT body FROM attachment_deliveries WHERE holder_kind=?1 AND holder_id=?2",
            params![kind, holder],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|body| serde_json::from_str(&body).map_err(Into::into))
        .transpose()
}
pub(super) fn descriptors(db: &Connection, kind: &str, holder: &str) -> Result<Vec<Attachment>> {
    Ok(read(db, kind, holder)?
        .map(|row| row.attachments)
        .unwrap_or_default())
}
pub(super) fn retire(db: &Connection) -> Result<()> {
    // A shared historical holder survives its source Thread's tombstone. A forwarded
    // file has its own input edge, so deleting the original cannot release its bytes.
    db.execute("DELETE FROM attachment_deliveries WHERE (holder_kind='input' AND NOT EXISTS(SELECT 1 FROM input_queue WHERE id=holder_id) AND NOT EXISTS(SELECT 1 FROM history WHERE id=holder_id)) OR (holder_kind='dispatch' AND NOT EXISTS(SELECT 1 FROM child_tasks WHERE id=holder_id)) OR (holder_kind='external_turn' AND NOT EXISTS(SELECT 1 FROM external_turns t JOIN external_conversations c ON c.id=t.conversation_id WHERE t.id=holder_id AND json_extract(c.body,'$.deleted')=0))",[])?;
    Ok(())
}
impl Catalog {
    pub fn attachment_deliveries(&self) -> Result<Vec<AttachmentDelivery>> {
        self.db
            .prepare("SELECT body FROM attachment_deliveries ORDER BY rowid")?
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect()
    }
    pub fn attachment_delivery(
        &self,
        kind: &str,
        holder: &str,
    ) -> Result<Option<AttachmentDelivery>> {
        read(&self.db, kind, holder)
    }
}

pub(super) fn incoming_input(
    text: &str,
    attachments: &[Attachment],
    media: &[crate::output::ResolvedMedia],
) -> Value {
    let mut input = json!({"text":text,"fileAttachments":attachments});
    if !media.is_empty() {
        input["imageReferences"] = json!((1..=media.len()).collect::<Vec<_>>());
        input["attachments"] = json!(
            media
                .iter()
                .map(|media| crate::output::IncomingMedia {
                    media_type: media.media_type.clone(),
                    data_base64: media.data_base64.clone(),
                })
                .collect::<Vec<_>>()
        );
    }
    input
}
pub(super) fn output(
    text: String,
    attachments: &[Attachment],
    media: Vec<crate::output::ResolvedMedia>,
) -> crate::output::OutputBody {
    let mut parts = vec![crate::output::OutputPart::Text { text }];
    parts.extend(
        attachments
            .iter()
            .cloned()
            .map(|attachment| crate::output::OutputPart::Attachment { attachment }),
    );
    for (index, media) in media.into_iter().enumerate() {
        let number = index + 1;
        parts.push(crate::output::OutputPart::Text {text:format!("Image {number}: [Image {number}] / [图片{number}] / [圖片{number}] refers to the following image in this message.")});
        parts.push(crate::output::OutputPart::Media { media });
    }
    crate::output::OutputBody {
        data: Value::Null,
        parts,
    }
}

/// Resolve a typed source selector to its immutable attachment identity. This
/// function creates no descriptor and confers no read authority.
pub fn material_attachment_reference(reference: &str) -> Option<String> {
    let source = reference.strip_prefix("varin-material://")?;
    let id = source.split('?').next()?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || source.bytes().any(|byte| byte.is_ascii_whitespace() || matches!(byte, b'#' | b'<' | b'>' | b'(' | b')' | b'\"' | b'\'')) {
        return None;
    }
    Some(format!("attachment:material_{}", hex::encode(id.as_bytes())))
}

/// Citations select only material descriptors already acquired through typed history.
/// A URL, snapshot-shaped string or hash cannot manufacture a descriptor or read grant.
pub(crate) fn cited_materials(texts: &[String], known: &[Attachment]) -> Vec<Attachment> {
    let citation = regex::Regex::new(r#"varin-material://([A-Za-z0-9_-]+)(?:\?[^\s<>\)\"']*)?(?:[\s<>\)\"']|$)"#)
        .expect("material citation pattern");
    let selected: std::collections::BTreeSet<String> = texts.iter().flat_map(|text| {
        citation.captures_iter(text).map(|capture| format!("attachment:material_{}", hex::encode(capture[1].as_bytes()))).collect::<Vec<_>>()
    }).collect();
    let mut result = Vec::new();
    for attachment in known {
        if selected.contains(&attachment.reference) && !result.iter().any(|item: &Attachment| item.reference == attachment.reference) {
            result.push(attachment.clone());
        }
    }
    result
}

/// Reports reuse actual outgoing deliveries to the organizer, not file-looking text.
pub(super) fn reported(db: &Connection, run: &str, target: &str) -> Result<Vec<Attachment>> {
    let mut result = Vec::new();
    let target = if let Some(execution) = db
        .query_row(
            "SELECT body FROM delegated_executions WHERE run_id=?1",
            [run],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        let execution: delegated::DelegatedExecution = serde_json::from_str(&execution)?;
        match execution.trigger {
            delegated::DelegatedTrigger::MessageRequest { message_id, .. } => {
                let input: inputs::QueuedInputMetadata = record(db, "input_queue", &message_id)?;
                match input.origin {
                    inputs::InputOrigin::Message { identity, .. } => identity.sender_thread_id,
                    _ => target.into(),
                }
            }
            _ => target.into(),
        }
    } else {
        target.into()
    };
    let mut query=db.prepare("SELECT a.body FROM attachment_deliveries a JOIN input_queue q ON q.id=a.holder_id WHERE a.holder_kind='input' AND a.thread_id=?2 AND json_extract(q.body,'$.origin.identity.actor.runId')=?1 ORDER BY q.cursor")?;
    for row in query.query_map(params![run, target], |row| row.get::<_, String>(0))? {
        let delivery: AttachmentDelivery = serde_json::from_str(&row?)?;
        for attachment in delivery.attachments {
            if !result
                .iter()
                .any(|file: &Attachment| file.reference == attachment.reference)
            {
                result.push(attachment);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
#[path = "catalog_attachments_tests.rs"]
mod tests;
