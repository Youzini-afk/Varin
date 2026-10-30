//! Request-time exclusion of explicitly forgotten source ranges. Original history is unchanged.
use super::*;
use crate::execution::{Content, ConversationHistory, ToolCompletion};
use sha2::{Digest, Sha256};

pub(super) fn requires_rebuild(
    current: Option<&memory::MemoryState>,
    baseline: Option<&memory::MemoryState>,
) -> bool {
    let Some(current) = current.and_then(|state| state.bot_knowledge.as_ref()) else {
        return false;
    };
    let baseline = baseline.and_then(|state| state.bot_knowledge.as_ref());
    let changed_sources = current
        .exclusions
        .iter()
        .any(|row| baseline.is_none_or(|old| !old.exclusions.contains(row)));
    changed_sources
        || baseline.is_some_and(|old| {
            old.items.iter().any(|row| {
                current
                    .invalidations
                    .iter()
                    .any(|invalid| invalid["id"] == row["id"] && invalid["scope"] == row["scope"])
            })
        })
}

pub(super) fn filter<M: Clone + Serialize>(
    state: Option<&memory::MemoryState>,
    history: &mut ConversationHistory<M>,
) -> Result<()> {
    let Some(knowledge) = state.and_then(|state| state.bot_knowledge.as_ref()) else {
        return Ok(());
    };
    if knowledge.exclusions.is_empty() {
        return Ok(());
    }
    let opaque_cut = knowledge.redacted_through.as_ref().and_then(|head| {
        history
            .iter()
            .rposition(|item| item.id == *head || item.id.starts_with(&format!("{head}:part:")))
    });
    let memory_calls: std::collections::HashSet<_> = history
        .iter()
        .filter_map(|item| match &item.content {
            Content::ToolCall { call } if call.name == "memory" => Some(call.call_id.clone()),
            _ => None,
        })
        .collect();
    let excluded_calls: std::collections::HashSet<_> = history
        .iter()
        .filter_map(|item| match &item.content {
            Content::ToolResult { result } if memory_calls.contains(&result.call_id) => {
                match &result.completion {
                    ToolCompletion::Result { content, .. }
                        if contains_excluded_row(
                            &serde_json::to_value(content).ok()?,
                            &knowledge.exclusions,
                        ) =>
                    {
                        Some(result.call_id.clone())
                    }
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    for (index, item) in history.iter_mut().enumerate() {
        if opaque_cut.is_some_and(|cut| index <= cut) {
            std::sync::Arc::make_mut(item).opaque = None;
        }
        if let Content::ToolCall { call } = &item.content {
            if excluded_calls.contains(&call.call_id) {
                if let Content::ToolCall { call } = &mut std::sync::Arc::make_mut(item).content {
                    call.arguments = json!({"historicalPayload":"excluded_by_memory_forgetting"});
                }
            }
        }
        let source_id = match &item.content {
            Content::Output { output } if output.data["kind"] == "work_update" => {
                output.data["source"]["itemId"].as_str()
            }
            _ => None,
        };
        let ranges = knowledge
            .exclusions
            .iter()
            .flat_map(|row| row["sources"].as_array().into_iter().flatten())
            .filter(|source| {
                source["id"].as_str().is_some_and(|id| {
                    item.id == id || item.id == format!("{id}:part:0") || source_id == Some(id)
                })
            })
            .collect::<Vec<_>>();
        if !ranges.is_empty() {
            let item = std::sync::Arc::make_mut(item);
            match &mut item.content {
                Content::Text { text } => *text = remove_ranges(text, &ranges)?,
                Content::Output { output } => {
                    let text = output
                        .parts
                        .iter()
                        .filter_map(|part| match part {
                            crate::output::OutputPart::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    let mut filtered = Some(remove_ranges(&text, &ranges)?);
                    for part in &mut output.parts {
                        if let crate::output::OutputPart::Text { text } = part {
                            *text = filtered.take().unwrap_or_default();
                        }
                    }
                }
                _ => (),
            }
        }
        // Preserve tool pairing and the fact of the original operation, without carrying
        // its retired memory payload into another provider request.
        if let Content::Output { output } = &item.content {
            if contains_excluded_row(&output.data, &knowledge.exclusions) {
                if let Content::Output { output } = &mut std::sync::Arc::make_mut(item).content {
                    *output = crate::output::OutputBody {
                        data: json!({"kind":"forgotten_memory_payload"}),
                        parts: vec![],
                    };
                }
            }
        }
        if let Content::ToolResult { result } = &item.content {
            {
                if let ToolCompletion::Result { content, .. } = &result.completion {
                    let text = serde_json::to_value(content)?;
                    if contains_excluded_row(&text, &knowledge.exclusions) {
                        let item = std::sync::Arc::make_mut(item);
                        if let Content::ToolResult { result } = &mut item.content {
                            if let ToolCompletion::Result { content, .. } = &mut result.completion {
                                *content = crate::output::OutputBody {
                                    data: json!({"kind":"forgotten_memory_payload"}),
                                    parts: vec![],
                                };
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(cut) = opaque_cut {
        let mut index = 0;
        history.retain(|item| {
            let keep = index > cut || !matches!(item.content, Content::ProviderOnly);
            index += 1;
            keep
        });
    }
    Ok(())
}

pub(super) fn load_state(
    db: &Connection,
    content: &crate::content::ContentStore,
    branch: &str,
) -> Result<Option<memory::MemoryState>> {
    let reference: Option<String> = db
        .query_row(
            "SELECT body FROM memory_states WHERE branch_id=?1",
            [branch],
            |row| row.get(0),
        )
        .optional()?;
    reference
        .map(|reference| {
            content
                .load(&serde_json::from_str::<Value>(&reference)?)
                .and_then(|value| serde_json::from_value(value).map_err(Into::into))
        })
        .transpose()
}

/// Reconstruct inherited originals when a later summary has absorbed forgotten material.
/// The initial checkpoint owns those references even after several compactions.
pub(super) fn initial_background(
    db: &Connection,
    content: &crate::content::ContentStore,
    branch: &str,
) -> Result<ConversationHistory> {
    let mut items = expand_background(
        db,
        content,
        initial_retained(db, content, branch)?,
        &mut std::collections::HashSet::new(),
    )?;
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert(item.id.clone()));
    Ok(items)
}
fn initial_retained(
    db: &Connection,
    content: &crate::content::ContentStore,
    branch: &str,
) -> Result<ConversationHistory> {
    let reference: Option<String> = db.query_row("SELECT body FROM context_checkpoints WHERE branch_id=?1 AND through_id IS NULL ORDER BY revision LIMIT 1", [branch], |row| row.get(0)).optional()?;
    let Some(reference) = reference else {
        return Ok(Vec::new());
    };
    let checkpoint: context::ContextCheckpoint =
        serde_json::from_value(content.load(&serde_json::from_str::<Value>(&reference)?)?)?;
    checkpoint
        .retained
        .map(|retained| content.load_items(&retained.items, &|| false))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn expand_background(
    db: &Connection,
    content: &crate::content::ContentStore,
    items: ConversationHistory,
    visited: &mut std::collections::HashSet<String>,
) -> Result<ConversationHistory> {
    let mut result = Vec::new();
    for item in items {
        let summary = match &item.provenance {
            crate::execution::Provenance::ExternalData { source } => {
                source.strip_prefix("conversation-summary:")
            }
            _ => None,
        };
        if let Some(id) = summary {
            if !visited.insert(id.to_owned()) {
                continue;
            }
            let reference: String = db.query_row(
                "SELECT body FROM context_checkpoints WHERE id=?1",
                [id],
                |row| row.get(0),
            )?;
            let checkpoint: context::ContextCheckpoint =
                serde_json::from_value(content.load(&serde_json::from_str::<Value>(&reference)?)?)?;
            let initial = initial_retained(db, content, &checkpoint.proposal.branch_id)?;
            result.extend(expand_background(db, content, initial, visited)?);
            let metadata = super::context_jobs::source_metadata_until(
                db,
                checkpoint.proposal.through_id.as_deref(),
                None,
            )?;
            for metadata in metadata {
                let original = content.hydrate_history(metadata)?;
                result.extend(super::execution_persistence::history_input_items(
                    &original.id,
                    original.source,
                    &original.content,
                )?);
            }
        } else {
            result.push(item);
        }
    }
    Ok(result)
}

/// The model-facing original reader filters a projection; the user's history stays intact.
pub(super) fn history_body(
    state: Option<&memory::MemoryState>,
    id: &str,
    body: &mut Value,
) -> Result<()> {
    if let Ok(item) = serde_json::from_value::<
        crate::execution::ConversationItem<crate::output::StoredMedia>,
    >(body.clone())
    {
        let mut items = vec![std::sync::Arc::new(item)];
        filter(state, &mut items)?;
        *body = serde_json::to_value(items[0].as_ref())?;
    } else {
        let value = if body.is_string() {
            &mut *body
        } else if body.get("text").is_some_and(Value::is_string) {
            &mut body["text"]
        } else {
            return Ok(());
        };
        let mut items: ConversationHistory = vec![crate::execution::ConversationItem {
            id: id.into(),
            provenance: crate::execution::Provenance::ExternalData {
                source: "original-history".into(),
            },
            content: Content::Text {
                text: value.as_str().unwrap_or_default().into(),
            },
            resource_activation: None,
            opaque: None,
        }
        .into()];
        filter(state, &mut items)?;
        if let Content::Text { text } = &items[0].content {
            *value = Value::String(text.clone());
        }
    }
    Ok(())
}

fn contains_excluded_row(value: &Value, exclusions: &[Value]) -> bool {
    match value {
        Value::Object(object) => {
            exclusions.iter().any(|row| {
                object.get("id") == row.get("id") && object.get("scope") == row.get("scope")
                    || object.get("id").and_then(Value::as_str).is_some_and(|id| {
                        (object.contains_key("body")
                            || object.contains_key("content")
                            || object.contains_key("text"))
                            && row["sources"].as_array().is_some_and(|sources| {
                                sources.iter().any(|source| source["id"] == id)
                            })
                    })
            }) || object
                .values()
                .any(|part| contains_excluded_row(part, exclusions))
        }
        Value::Array(parts) => parts
            .iter()
            .any(|part| contains_excluded_row(part, exclusions)),
        _ => false,
    }
}

fn remove_ranges(text: &str, ranges: &[&Value]) -> Result<String> {
    let revision = Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut units: Vec<_> = text.encode_utf16().map(Some).collect();
    for range in ranges {
        let (start, end) = (range["start"].as_u64(), range["end"].as_u64());
        let (Some(start), Some(end)) = (start, end) else {
            return Err(RuntimeError::Invalid(
                "forgotten source range is malformed".into(),
            ));
        };
        if range["revision"].as_str() != Some(revision.as_str())
            || start > end
            || end as usize > units.len()
        {
            return Err(RuntimeError::Conflict(
                "forgotten source differs from its immutable history reference".into(),
            ));
        }
        for unit in &mut units[start as usize..end as usize] {
            *unit = None;
        }
    }
    String::from_utf16(&units.into_iter().flatten().collect::<Vec<_>>()).map_err(|_| {
        RuntimeError::Invalid("forgotten source range splits a Unicode character".into())
    })
}
