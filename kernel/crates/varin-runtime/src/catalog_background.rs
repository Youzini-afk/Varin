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
                    item.content=Content::Output{output:json!({"quotedHistory":item.content,"reference":reference,"originalRole":hydrated.source}).into()};
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
