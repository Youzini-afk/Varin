//! Frozen summary excerpts. Partitioning is preparation, not a token measurement or an input limit.
use crate::{catalog::RuntimeError, context_capacity::estimate_item, context_job::*, execution::*};
use serde::Deserialize;
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, RuntimeError>;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capacity {
    context_window_tokens: Option<u64>,
    max_output_tokens: Option<u64>,
}
fn data(key: &str, item: &ConversationItem, suffix: &str, text: String) -> ConversationItem {
    ConversationItem {
        resource_activation: None,
        id: format!("context-job:{key}:source:{}:{suffix}", item.id),
        provenance: Provenance::ExternalData {
            source: format!("history:{}", item.id),
        },
        content: Content::Text { text },
        opaque: None,
    }
}
fn floor(text: &str, mut end: usize) -> usize {
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}
fn excerpts(
    key: &str,
    mut item: ConversationItem,
    budget: Option<u64>,
) -> Result<Vec<ConversationItem>> {
    item.opaque = None;
    // Media stays media. Quoting an inline payload as text would inflate context and lose the
    // selected adapter's multimodal input. Its token cost is unknown, not assigned a fake price.
    if matches!(item.content, Content::Media { .. }) {
        return Ok(vec![ConversationItem {
            resource_activation: None,
            id: format!("context-job:{key}:source:{}", item.id),
            provenance: Provenance::ExternalData {
                source: format!("history:{}", item.id),
            },
            content: item.content,
            opaque: None,
        }]);
    }
    // Tool-free summary evidence preserves explicitly ordered parts without inventing calls.
    let parts = match &mut item.content {
        Content::Output { output } => std::mem::take(&mut output.parts),
        Content::ToolResult { result } => match &mut result.completion {
            ToolCompletion::Result { content, .. }
            | ToolCompletion::JobAccepted {
                content: Some(content),
                ..
            } => std::mem::take(&mut content.parts),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    if !parts.is_empty() {
        let source_id = item.id.clone();
        let mut result = excerpts(key, item, budget)?;
        for (index, part) in parts.into_iter().enumerate() {
            let content = match part {
                OutputPart::Text { text } => Content::Text { text },
                OutputPart::Media { media } => Content::Media { media },
            };
            result.extend(excerpts(
                key,
                ConversationItem {
                    resource_activation: None,
                    id: format!("{source_id}:part:{index}"),
                    provenance: Provenance::ExternalData {
                        source: format!("history:{source_id}"),
                    },
                    content,
                    opaque: None,
                },
                budget,
            )?);
        }
        return Ok(result);
    }
    let whole = data(key, &item, "whole", serde_json::to_string(&item)?);
    let Some(budget) = budget.filter(|budget| estimate_item(&whole) > *budget) else {
        return Ok(vec![whole]);
    };
    drop(whole);
    let body = serde_json::to_string(&item.content)?;
    let mut result = Vec::new();
    let mut start = 0;
    while start < body.len() {
        let mut end = floor(
            &body,
            start
                .saturating_add(usize::try_from(budget.saturating_mul(4)).unwrap_or(usize::MAX))
                .min(body.len()),
        );
        loop {
            if end <= start {
                return Err(RuntimeError::Invalid(
                    "selected summary capacity cannot represent a source excerpt".into(),
                ));
            }
            let fragment = data(
                key,
                &item,
                &start.to_string(),
                serde_json::to_string(&json!({"id":item.id,"provenance":item.provenance,
                "utf8_range":{"start":start,"end":end,"total":body.len()},"content_fragment":&body[start..end]}))?,
            );
            let cost = estimate_item(&fragment);
            if cost <= budget {
                result.push(fragment);
                break;
            }
            // Serialized escaping and source identity count too. Shrink strictly, on a UTF-8
            // boundary, until the complete excerpt fits this preparation budget.
            let next = (end - start).saturating_mul(usize::try_from(budget).unwrap_or(usize::MAX))
                / usize::try_from(cost).unwrap_or(usize::MAX);
            end = floor(&body, start + next.min(end - start - 1));
        }
        start = end;
    }
    Ok(result)
}
pub(crate) fn partition(
    key: &str,
    configuration: &Value,
    recipe: &ContextSummaryRecipe,
    prior: Option<ConversationItem>,
    history: Vec<ConversationItem>,
) -> Result<Vec<Vec<ConversationItem>>> {
    let capacity: Capacity = serde_json::from_value(configuration.clone())?;
    let fixed = (SUMMARIZER_SYSTEM.len() as u64 + recipe.request_text().len() as u64).div_ceil(4);
    let budget = match (capacity.context_window_tokens, capacity.max_output_tokens) {
        (Some(window), Some(output)) => {
            // Each later request carries the previous summary and reserves the selected output.
            let remaining = window
                .saturating_sub(output.saturating_mul(2))
                .saturating_sub(fixed);
            if remaining == 0 {
                return Err(RuntimeError::Invalid(
                    "selected model leaves no source budget for a continuation summary".into(),
                ));
            }
            Some(remaining)
        }
        _ => None,
    };
    let mut material = Vec::new();
    if let Some(prior) = prior {
        if budget.is_none_or(|budget| estimate_item(&prior) <= budget) {
            material.push(prior);
        } else {
            material.extend(excerpts(key, prior, budget)?);
        }
    }
    for item in history {
        material.extend(excerpts(key, item, budget)?);
    }
    let mut parts = Vec::new();
    let mut part = Vec::new();
    let mut used = 0u64;
    for item in material {
        let cost = estimate_item(&item);
        if !part.is_empty() && budget.is_some_and(|budget| cost > budget.saturating_sub(used)) {
            parts.push(std::mem::take(&mut part));
            used = 0;
        }
        used = used.saturating_add(cost);
        part.push(item);
    }
    if !part.is_empty() {
        parts.push(part);
    }
    if parts.is_empty() {
        return Err(RuntimeError::Invalid("summary source is empty".into()));
    }
    Ok(parts)
}

pub(crate) fn summary_text(
    content: &crate::content::ContentStore,
    reference: &Value,
) -> Result<String> {
    let mut output = content.load(reference)?;
    if output.get("status").and_then(Value::as_str) != Some("committed") {
        return Err(RuntimeError::Conflict(
            "summary output was not committed".into(),
        ));
    }
    let record: ExecutionRecord = serde_json::from_value(output["record"].take())?;
    let ExecutionRecord::ModelFinished {
        outcome: ModelOutcome::Completed,
        finish_reason: Some(FinishReason::Stop),
        items,
        ..
    } = record
    else {
        return Err(RuntimeError::Conflict(
            "summary generation did not finish completely".into(),
        ));
    };
    let mut text = Vec::new();
    for item in items {
        match item.content {
            Content::Text { text: value } => text.push(value),
            Content::ReasoningSummary { .. } | Content::ProviderOnly => (),
            _ => {
                return Err(RuntimeError::Invalid(
                    "summary contains an action or attachment".into(),
                ));
            }
        }
    }
    let summary = text.join("\n");
    if summary.trim().is_empty() {
        return Err(RuntimeError::Invalid("summary is empty".into()));
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partitioned_unicode_source_keeps_exact_ranges_and_media() {
        let source = ConversationItem {
            resource_activation: None,
            id: "real-input".into(),
            provenance: Provenance::UserInstruction {
                input_id: "original-input".into(),
            },
            content: Content::Text {
                text: "中文 🎉 \"quoted\" \\ path\n".repeat(500),
            },
            opaque: None,
        };
        let image = ConversationItem {
            resource_activation: None,
            id: "real-image".into(),
            provenance: Provenance::UserInstruction {
                input_id: "original-input".into(),
            },
            content: Content::Media {
                media: crate::output::ResolvedMedia {
                    media_type: "image/png".into(),
                    data_base64: "iVBORw0KGgo=".into(),
                    source: crate::output::OutputSource::Conversation {
                        provenance: Provenance::UserInstruction {
                            input_id: "original-input".into(),
                        },
                    },
                },
            },
            opaque: None,
        };
        let parts = partition(
            "job",
            &json!({"contextWindowTokens":600,"maxOutputTokens":64}),
            &ContextSummaryRecipe::manual(),
            None,
            vec![source.clone(), image.clone()],
        )
        .unwrap();
        assert!(parts.len() > 1);
        let body = serde_json::to_string(&source.content).unwrap();
        let mut reconstructed = String::new();
        let mut offset = 0;
        for item in parts.iter().flatten() {
            match &item.content {
                Content::Text { text } => {
                    let fragment: Value = serde_json::from_str(text).unwrap();
                    assert_eq!(fragment["id"], source.id);
                    assert_eq!(
                        fragment["provenance"],
                        serde_json::to_value(&source.provenance).unwrap()
                    );
                    assert_eq!(fragment["utf8_range"]["start"], offset);
                    assert_eq!(fragment["utf8_range"]["total"], body.len());
                    let excerpt = fragment["content_fragment"].as_str().unwrap();
                    reconstructed.push_str(excerpt);
                    offset += excerpt.len();
                    assert_eq!(fragment["utf8_range"]["end"], offset);
                }
                Content::Media { .. } => assert_eq!(item.content, image.content),
                _ => panic!("summary source acquired executable content"),
            }
            assert!(matches!(item.provenance, Provenance::ExternalData { .. }));
        }
        assert_eq!(reconstructed, body);
        assert!(
            parts
                .iter()
                .flatten()
                .any(|item| item.content == image.content)
        );
    }

    #[test]
    fn mixed_output_excerpts_keep_original_receipts_parts_and_media_without_executable_tools() {
        use crate::output::{IncomingMedia, OutputBody, OutputPart, OutputSource};
        let mut originals = Vec::new();
        let mut metadata = Vec::new();
        let mut media = Vec::new();
        for kind in ["output", "result", "job"] {
            let id = format!("original-{kind}");
            let image = IncomingMedia {
                media_type: "image/png".into(),
                data_base64: "iVBORw0KGgo=".into(),
            }
            .admit(OutputSource::Tool {
                context: ToolExecutionContext {
                    run_id: "original-run".into(),
                    origin: ToolOrigin::ModelStep {
                        request_id: "original-request".into(),
                    },
                    operation_id: format!("original-request:tool:{kind}"),
                },
            })
            .unwrap();
            let output: OutputBody =
                json!({"kind":kind,"nested":{"unicode":"中文 🎉","array":[null,1,true]}}).into();
            let content = match kind {
                "output" => Content::Output { output },
                "result" => Content::ToolResult {
                    result: ToolResult {
                        request_id: "original-request".into(),
                        call_id: kind.into(),
                        completion: ToolCompletion::Result {
                            outcome: crate::Outcome::Failed,
                            effect: crate::Effect::Partial,
                            content: output,
                        },
                    },
                },
                "job" => Content::ToolResult {
                    result: ToolResult {
                        request_id: "original-request".into(),
                        call_id: kind.into(),
                        completion: ToolCompletion::JobAccepted {
                            operation_id: "original-job".into(),
                            phase: "running".into(),
                            effect: crate::Effect::Confirmed,
                            lifetime: crate::Lifetime::Thread,
                            content: Some(output),
                        },
                    },
                },
                _ => unreachable!(),
            };
            let mut item = ConversationItem {
                resource_activation: None,
                id,
                provenance: Provenance::ExternalData {
                    source: format!("original-source:{kind}"),
                },
                content,
                opaque: None,
            };
            metadata.push(item.clone());
            let parts = match &mut item.content {
                Content::Output { output } => &mut output.parts,
                Content::ToolResult { result } => match &mut result.completion {
                    ToolCompletion::Result { content, .. }
                    | ToolCompletion::JobAccepted {
                        content: Some(content),
                        ..
                    } => &mut content.parts,
                    _ => unreachable!(),
                },
                _ => unreachable!(),
            };
            *parts = vec![
                OutputPart::Text {
                    text: format!("before-{kind} 中文"),
                },
                OutputPart::Media {
                    media: image.clone(),
                },
                OutputPart::Text {
                    text: format!("after-{kind} 🎉"),
                },
            ];
            item.opaque = Some(OpaqueProviderItem {
                family: "original-family".into(),
                adapter_version: "1".into(),
                connection_identity: "original-connection".into(),
                value: json!({"secret":"do not summarize private continuation"}),
            });
            media.push(image);
            originals.push(item);
        }
        let parts = partition(
            "original-summary",
            &json!({}),
            &ContextSummaryRecipe::manual(),
            None,
            originals,
        )
        .unwrap();
        let items: Vec<_> = parts.iter().flatten().collect();
        assert_eq!(items.len(), 12);
        for (index, group) in items.chunks_exact(4).enumerate() {
            let decode = |item: &ConversationItem| {
                let Content::Text { text } = &item.content else {
                    panic!("expected summary evidence text")
                };
                serde_json::from_str::<ConversationItem>(text).unwrap()
            };
            assert_eq!(decode(group[0]), metadata[index]);
            let kind = ["output", "result", "job"][index];
            for (part, text) in [
                (0, format!("before-{kind} 中文")),
                (2, format!("after-{kind} 🎉")),
            ] {
                let item = decode(group[if part == 0 { 1 } else { 3 }]);
                assert_eq!(item.content, Content::Text { text });
                assert_eq!(
                    item.provenance,
                    Provenance::ExternalData {
                        source: format!("history:original-{kind}")
                    }
                );
                assert_eq!(item.id, format!("original-{kind}:part:{part}"));
            }
            assert_eq!(
                group[2].content,
                Content::Media {
                    media: media[index].clone()
                }
            );
            assert_eq!(
                group[2].provenance,
                Provenance::ExternalData {
                    source: format!("history:original-{kind}:part:1")
                }
            );
        }
        assert!(items.iter().all(|item| item.opaque.is_none()
            && matches!(item.provenance, Provenance::ExternalData { .. })
            && matches!(item.content, Content::Text { .. } | Content::Media { .. })));
    }
}
