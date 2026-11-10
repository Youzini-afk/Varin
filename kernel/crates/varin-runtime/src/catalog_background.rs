//! Selective immutable conversation references; file-source selection is independent.
use super::*;
use crate::execution::{Content, ConversationHistory, ConversationItem, Provenance};
use serde::Deserialize;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackgroundReference {
    pub thread_id: String,
    pub branch_id: String,
    pub head_id: String,
    pub item_ids: Vec<String>,
}
pub(super) fn authorize(
    db: &Connection,
    caller: &str,
    references: &[BackgroundReference],
) -> Result<()> {
    for reference in references {
        threads::require_available(db, &reference.thread_id)?;
        threads::require_public(db, &reference.thread_id)?;
        let owner: String = db.query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [&reference.branch_id],
            |row| row.get(0),
        )?;
        if owner != reference.thread_id
            || (scheduling::thread_family(db, caller)? != scheduling::thread_family(db, &owner)?
                && !super::bot_work::ordinary_conversation(db, caller, &owner)?
                && !super::bot_work::linked(
                    db,
                    caller,
                    &owner,
                    Some(&reference.branch_id),
                    false,
                    false,
                )?)
        {
            return Err(RuntimeError::Conflict(
                "background is outside the caller's readable work".into(),
            ));
        }
        if reference.head_id.is_empty() || reference.item_ids.is_empty() {
            return Err(RuntimeError::Invalid(
                "background requires a fixed head and selected item IDs".into(),
            ));
        }
    }
    Ok(())
}
/// Copy only the reference index relationships owned by the original selected history.
/// A copied context is not a SQL history ancestry edge, so its lightweight mappings need
/// their own receiving holder. This does not retain source Runs, bytes, or resource grants.
pub(super) fn capture_reference_ids(
    db: &Connection,
    parent_run: &str,
    history: &ConversationHistory,
) -> Result<Vec<u64>> {
    if history.is_empty() { return Ok(Vec::new()); }
    let items = history.iter().map(|item| item.id.as_str()).collect::<Vec<_>>();
    let mut query = db.prepare("WITH source_runs(id) AS (
        SELECT run_id FROM history WHERE id IN (SELECT value FROM json_each(?1))
        UNION SELECT ?2
    ), holders(id) AS (
        SELECT id FROM source_runs
        UNION SELECT id FROM operations WHERE run_id IN source_runs
        UNION SELECT id FROM history WHERE run_id IN source_runs
        UNION SELECT id FROM input_queue WHERE run_id IN source_runs
        UNION SELECT id FROM delegated_executions WHERE run_id IN source_runs
        UNION SELECT c.id FROM child_tasks c JOIN runs r ON json_extract(r.body,'$.thread_id')=c.child_thread_id WHERE r.id IN source_runs
    ) SELECT DISTINCT reference_id FROM model_reference_holders WHERE holder IN holders ORDER BY reference_id")?;
    let rows = query.query_map(params![encode(&items)?,parent_run], |row| read_number(row,0))?;
    rows.collect::<std::result::Result<_,_>>().map_err(Into::into)
}

pub(super) fn retain_reference_ids(db: &Connection, references: &[u64], holder: &str) -> Result<()> {
    if references.is_empty() { return Ok(()); }
    let encoded = serde_json::to_string(references)?;
    let existing: u64 = db.query_row("SELECT count(*) FROM model_references WHERE id IN (SELECT value FROM json_each(?1))",[&encoded],|row|read_number(row,0))?;
    if existing != references.len() as u64 {
        return Err(RuntimeError::Conflict("Selected background references were retired during preparation; select the background again".into()));
    }
    db.execute("INSERT OR IGNORE INTO model_reference_holders(reference_id,holder) SELECT value,?2 FROM json_each(?1)",params![encoded,holder])?;
    Ok(())
}

/// Quoting a completed tool result preserves its raw receipt alongside the same stable
/// owner-authored projection. Only this typed output envelope is adapted, never body JSON.
fn quoted_projection(content: &Content) -> Option<Content> {
    let mut projected = content.clone();
    let output = match &mut projected {
        Content::ToolResult { result } => match &mut result.completion {
            crate::execution::ToolCompletion::Result { content, .. } => content,
            crate::execution::ToolCompletion::JobAccepted { content: Some(content), .. } => content,
            _ => return None,
        },
        _ => return None,
    };
    output.data = output.model_data.take()?;
    Some(projected)
}

pub(super) fn load(
    db: &Connection,
    content: &crate::content::ContentStore,
    caller: &Run,
    references: &[BackgroundReference],
) -> Result<ConversationHistory> {
    authorize(db, &caller.thread_id, references)?;
    let mut result = Vec::new();
    for reference in references {
        let mut cursor: Option<String> = db.query_row(
            "SELECT head FROM branches WHERE id=?1",
            [&reference.branch_id],
            |row| row.get(0),
        )?;
        let mut witnessed = false;
        let mut selected = std::collections::BTreeMap::new();
        while let Some(id) = cursor {
            let metadata: HistoryItem = record(db, "history", &id)?;
            cursor = metadata.parent.clone();
            if id == reference.head_id {
                witnessed = true;
            }
            if witnessed && reference.item_ids.contains(&id) {
                selected.insert(id, metadata);
            }
            if selected.len()
                == reference
                    .item_ids
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
            {
                break;
            }
        }
        if !witnessed
            || reference
                .item_ids
                .iter()
                .any(|id| !selected.contains_key(id))
        {
            return Err(RuntimeError::Conflict(
                "background item is not on the selected immutable history view".into(),
            ));
        }
        for id in &reference.item_ids {
            if result
                .iter()
                .any(|item: &std::sync::Arc<ConversationItem>| item.id == *id)
            {
                continue;
            }
            let metadata = selected.remove(id).ok_or_else(|| {
                RuntimeError::Invalid("background item IDs must be unique".into())
            })?;
            let hydrated = content.hydrate_history(metadata)?;
            let attachments = super::attachments::history_attachments_with_report(db, &hydrated, &hydrated.content)?;
            let items = super::execution_persistence::history_input_items(
                &hydrated.id,
                hydrated.source,
                &hydrated.content,
            )?;
            for item in items {
                let mut item = item.as_ref().clone();
                if matches!(
                    item.content,
                    Content::ProviderOnly | Content::ReasoningSummary { .. }
                ) {
                    continue;
                }
                if matches!(
                    item.content,
                    Content::ToolCall { .. } | Content::ToolResult { .. }
                ) {
                    let model = quoted_projection(&item.content).map(|content|
                        json!({"quotedHistory":content,"reference":reference,"originalRole":hydrated.source}));
                    let mut output: crate::output::OutputBody = json!({"quotedHistory":item.content,"reference":reference,"originalRole":hydrated.source}).into();
                    output.model_data = model;
                    item.content = Content::Output { output };
                }
                if !attachments.is_empty() {
                    let mut output = match item.content {
                        Content::Output { output } => output,
                        Content::Text { text } => crate::output::OutputBody { model_data: None, data: Value::Null, parts: vec![crate::output::OutputPart::Text { text }] },
                        other => crate::output::OutputBody { model_data: None, data: json!({"quotedHistory":other}), parts: Vec::new() },
                    };
                    for attachment in &attachments {
                        if !output.parts.iter().any(|part| matches!(part, crate::output::OutputPart::Attachment { attachment: existing } if existing.reference == attachment.reference)) {
                            output.parts.push(crate::output::OutputPart::Attachment { attachment: attachment.clone() });
                        }
                    }
                    item.content = Content::Output { output };
                }
                item.provenance = Provenance::ExternalData {
                    source: format!(
                        "conversation-reference:{}:{}:{}:{}",
                        reference.thread_id, reference.branch_id, reference.head_id, id
                    ),
                };
                item.opaque = None;
                item.resource_activation = None;
                result.push(item.into());
            }
        }
    }
    let state: Option<String> = db
        .query_row(
            "SELECT body FROM memory_states WHERE branch_id=?1",
            [&caller.branch_id],
            |row| row.get(0),
        )
        .optional()?;
    let state: Option<memory::MemoryState> = state
        .map(|value| {
            content
                .load(&serde_json::from_str::<Value>(&value)?)
                .and_then(|value| serde_json::from_value(value).map_err(Into::into))
        })
        .transpose()?;
    super::memory_exclusion::filter(state.as_ref(), &mut result)?;
    Ok(result)
}
