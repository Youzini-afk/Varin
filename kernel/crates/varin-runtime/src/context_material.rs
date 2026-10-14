//! Core-owned quotation, source identity and frozen summary-plan validation.
use crate::{catalog::RuntimeError, context_capacity::estimate_item, context_job::*, execution::*};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
type Result<T> = std::result::Result<T, RuntimeError>;
pub(crate) const QUOTE_FORMAT: u64 = 1;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capacity {
    context_window_tokens: Option<u64>,
    max_output_tokens: Option<u64>,
}
pub(crate) fn hash(value: &impl serde::Serialize) -> Result<String> {
    fn canonical(value: Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .into_iter()
                    .map(|(k, v)| (k, canonical(v)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(array) => Value::Array(array.into_iter().map(canonical).collect()),
            value => value,
        }
    }
    Ok(format!(
        "sha256-{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&canonical(
            serde_json::to_value(value)?
        ))?))
    ))
}
pub(crate) fn model_budget(
    configuration: &Value,
    recipe: &ContextSummaryRecipe,
) -> Result<ContextCompactionModelBudget> {
    let capacity: Capacity = serde_json::from_value(configuration.clone())?;
    let fixed = (SUMMARIZER_SYSTEM.len() as u64 + recipe.request_text().len() as u64).div_ceil(4);
    let source_budget_tokens = match (capacity.context_window_tokens, capacity.max_output_tokens) {
        (Some(window), Some(output)) => Some(
            window
                .saturating_sub(output.saturating_mul(2))
                .saturating_sub(fixed),
        ),
        _ => None,
    };
    Ok(ContextCompactionModelBudget {
        context_window_tokens: capacity.context_window_tokens,
        max_output_tokens: capacity.max_output_tokens,
        source_budget_tokens,
    })
}
pub(crate) fn quote_sources(
    key: &str,
    history: crate::execution::ConversationHistory,
) -> Result<Vec<ContextCompactionSource>> {
    fn quote(
        key: &str,
        mut item: ConversationItem,
        out: &mut Vec<ContextCompactionSource>,
    ) -> Result<()> {
        item.opaque = None;
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
        let source_id = format!("context-job:{key}:source:{}", item.id);
        let media = if let Content::Media { media } = &item.content {
            Some(media.clone())
        } else {
            None
        };
        let text = if media.is_some() {
            serde_json::to_string(
                &json!({"id":item.id,"provenance":item.provenance,"content":{"kind":"media","sourceId":format!("{source_id}:media")}}),
            )?
        } else {
            serde_json::to_string(&item)?
        };
        out.push(ContextCompactionSource {
            source_id: source_id.clone(),
            item: ConversationItem {
                resource_activation: None,
                id: source_id.clone(),
                provenance: Provenance::ExternalData {
                    source: format!("history:{}", item.id),
                },
                content: Content::Text { text },
                opaque: None,
            },
        });
        if let Some(media) = media {
            out.push(ContextCompactionSource {
                source_id: format!("{source_id}:media"),
                item: ConversationItem {
                    resource_activation: None,
                    id: format!("{source_id}:media"),
                    provenance: Provenance::ExternalData {
                        source: format!("history:{}", item.id),
                    },
                    content: Content::Media { media },
                    opaque: None,
                },
            });
        }
        for (index, part) in parts.into_iter().enumerate() {
            let content = match part {
                OutputPart::Text { text } => Content::Text { text },
                OutputPart::Media { media } => Content::Media { media },
            };
            quote(
                key,
                ConversationItem {
                    resource_activation: None,
                    id: format!("{}:part:{index}", item.id),
                    provenance: item.provenance.clone(),
                    content,
                    opaque: None,
                },
                out,
            )?;
        }
        Ok(())
    }
    let mut sources = Vec::new();
    for item in history {
        quote(key, std::sync::Arc::unwrap_or_clone(item), &mut sources)?;
    }
    let mut ids = BTreeSet::new();
    if sources.is_empty() || sources.iter().any(|source| !ids.insert(&source.source_id)) {
        return Err(RuntimeError::Invalid(
            "empty or ambiguous summary source".into(),
        ));
    }
    Ok(sources)
}
pub(crate) fn source_item(
    source: &ContextCompactionSource,
    range: Option<&ContextCompactionRange>,
) -> Result<ConversationItem> {
    let mut item = source.item.clone();
    if let Some(range) = range {
        let Content::Text { text } = &item.content else {
            return Err(RuntimeError::Invalid(
                "media summary sources require a whole-item reference".into(),
            ));
        };
        let start = usize::try_from(range.start)
            .map_err(|_| RuntimeError::Invalid("invalid source range".into()))?;
        let end = usize::try_from(range.end)
            .map_err(|_| RuntimeError::Invalid("invalid source range".into()))?;
        if start >= end
            || end > text.len()
            || !text.is_char_boundary(start)
            || !text.is_char_boundary(end)
        {
            return Err(RuntimeError::Invalid(
                "summary source range is not a valid UTF-8 text range".into(),
            ));
        }
        item.content = Content::Text {
            text: serde_json::to_string(
                &json!({"sourceId":source.source_id,"utf8Range":{"start":start,"end":end,"total":text.len()},"quotedSourceFragment":&text[start..end]}),
            )?,
        };
        item.id = format!("{}:{start}:{end}", item.id);
    }
    Ok(item)
}
pub(crate) fn validate_plan(
    plan: &ContextCompactionPlan,
    preview: &ContextCompactionPreview,
) -> Result<()> {
    if plan.source_cut_hash() != preview.source_cut_hash {
        return Err(RuntimeError::Conflict(
            "context compaction source cut changed".into(),
        ));
    }
    let ContextCompactionPlan::ModelPlan {
        nodes,
        final_node_id,
        ..
    } = plan
    else {
        if matches!(plan, ContextCompactionPlan::Text { text, .. } if !text.trim().is_empty()) {
            return Ok(());
        }
        return Err(RuntimeError::Invalid(
            "text compaction candidate is empty".into(),
        ));
    };
    let sources: BTreeMap<_, _> = preview
        .sources
        .iter()
        .map(|source| (&source.source_id, source))
        .collect();
    let mut earlier = BTreeMap::new();
    for node in nodes {
        if node.id.trim().is_empty() || earlier.contains_key(&node.id) || node.inputs.is_empty() {
            return Err(RuntimeError::Invalid(
                "summary plan has an empty or duplicate node".into(),
            ));
        }
        for input in &node.inputs {
            match input {
                ContextCompactionInput::Source { source_id, range } => {
                    let source = sources.get(source_id).ok_or_else(|| {
                        RuntimeError::Invalid("summary source is not in the frozen cut".into())
                    })?;
                    source_item(source, range.as_ref())?;
                }
                ContextCompactionInput::NodeOutput { node_id } => {
                    if !earlier.contains_key(node_id) {
                        return Err(RuntimeError::Invalid(
                            "summary node dependency must name an earlier node".into(),
                        ));
                    }
                }
            }
        }
        earlier.insert(&node.id, node);
    }
    if !earlier.contains_key(final_node_id) {
        return Err(RuntimeError::Invalid(
            "summary final node is missing".into(),
        ));
    }
    let mut needed = BTreeSet::new();
    let mut stack = vec![final_node_id];
    while let Some(id) = stack.pop() {
        if needed.insert(id) {
            for input in &earlier[id].inputs {
                if let ContextCompactionInput::NodeOutput { node_id } = input {
                    stack.push(node_id);
                }
            }
        }
    }
    if needed.len() != nodes.len() {
        return Err(RuntimeError::Invalid(
            "summary plan contains output unreachable from the final node".into(),
        ));
    }
    Ok(())
}
pub(crate) fn builtin_plan(preview: &ContextCompactionPreview) -> Result<ContextCompactionPlan> {
    let budget = preview.model_budget.source_budget_tokens;
    if budget == Some(0) {
        return Err(RuntimeError::Invalid(
            "selected model leaves no source budget for a continuation summary".into(),
        ));
    }
    let mut inputs = Vec::new();
    for source in &preview.sources {
        if budget.is_none_or(|budget| estimate_item(&source.item) <= budget)
            || !matches!(source.item.content, Content::Text { .. })
        {
            inputs.push((
                ContextCompactionInput::Source {
                    source_id: source.source_id.clone(),
                    range: None,
                },
                estimate_item(&source.item),
            ));
            continue;
        }
        let Content::Text { text } = &source.item.content else {
            unreachable!()
        };
        let budget = budget.expect("oversized source has budget");
        let mut start = 0;
        while start < text.len() {
            let mut end = start
                .saturating_add(usize::try_from(budget.saturating_mul(4)).unwrap_or(usize::MAX))
                .min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            loop {
                if end <= start {
                    return Err(RuntimeError::Invalid(
                        "selected summary capacity cannot represent a source excerpt".into(),
                    ));
                }
                let range = ContextCompactionRange {
                    start: start as u64,
                    end: end as u64,
                };
                let cost = estimate_item(&source_item(source, Some(&range))?);
                if cost <= budget {
                    inputs.push((
                        ContextCompactionInput::Source {
                            source_id: source.source_id.clone(),
                            range: Some(range),
                        },
                        cost,
                    ));
                    break;
                }
                let next = (end - start)
                    .saturating_mul(usize::try_from(budget).unwrap_or(usize::MAX))
                    / usize::try_from(cost).unwrap_or(usize::MAX);
                end = start + next.min(end - start - 1);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
            }
            start = end;
        }
    }
    let mut groups = Vec::new();
    let mut group = Vec::new();
    let mut used = 0u64;
    for (input, cost) in inputs {
        if !group.is_empty() && budget.is_some_and(|budget| cost > budget.saturating_sub(used)) {
            groups.push(std::mem::take(&mut group));
            used = 0;
        }
        used = used.saturating_add(cost);
        group.push(input);
    }
    if !group.is_empty() {
        groups.push(group);
    }
    let mut nodes = Vec::new();
    for (index, mut inputs) in groups.into_iter().enumerate() {
        if index > 0 {
            inputs.insert(
                0,
                ContextCompactionInput::NodeOutput {
                    node_id: format!("fold:{}", index - 1),
                },
            );
        }
        nodes.push(ContextCompactionNode {
            id: format!("fold:{index}"),
            instructions: None,
            inputs,
        });
    }
    let final_node_id = nodes
        .last()
        .ok_or_else(|| RuntimeError::Invalid("summary source is empty".into()))?
        .id
        .clone();
    let plan = ContextCompactionPlan::ModelPlan {
        source_cut_hash: preview.source_cut_hash.clone(),
        nodes,
        final_node_id,
    };
    validate_plan(&plan, preview)?;
    Ok(plan)
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
        let preview = ContextCompactionPreview {
            source_cut_hash: "unicode-cut".into(),
            sources: quote_sources("job", vec![source.clone().into(), image.clone().into()]).unwrap(),
            model_budget: model_budget(
                &json!({"contextWindowTokens":600,"maxOutputTokens":64}),
                &ContextSummaryRecipe::manual(),
            )
            .unwrap(),
        };
        let plan = builtin_plan(&preview).unwrap();
        assert!(plan.nodes().len() > 1);
        let body = serde_json::to_string(&source).unwrap();
        let mut reconstructed = String::new();
        let mut offset = 0;
        let mut retained_media = 0;
        for input in plan.nodes().iter().flat_map(|node| &node.inputs) {
            let ContextCompactionInput::Source { source_id, range } = input else {
                continue;
            };
            let source = preview
                .sources
                .iter()
                .find(|source| &source.source_id == source_id)
                .unwrap();
            let item = source_item(source, range.as_ref()).unwrap();
            if source_id == &preview.sources[0].source_id {
                let Content::Text { text } = &item.content else {
                    panic!("text source changed kind")
                };
                let fragment: Value = serde_json::from_str(text).unwrap();
                assert_eq!(fragment["sourceId"], *source_id);
                assert_eq!(fragment["utf8Range"]["start"], offset);
                assert_eq!(fragment["utf8Range"]["total"], body.len());
                let excerpt = fragment["quotedSourceFragment"].as_str().unwrap();
                reconstructed.push_str(excerpt);
                offset += excerpt.len();
                assert_eq!(fragment["utf8Range"]["end"], offset);
            } else if matches!(item.content, Content::Media { .. }) {
                assert_eq!(item.content, image.content);
                retained_media += 1;
            } else {
                assert_eq!(
                    item, source.item,
                    "the media source label stays attached to its original identity"
                );
            }
            assert!(matches!(item.provenance, Provenance::ExternalData { .. }));
        }
        assert_eq!(reconstructed, body);
        assert_eq!(retained_media, 1);
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
            originals.push(item.into());
        }
        let preview = ContextCompactionPreview {
            source_cut_hash: "mixed-cut".into(),
            sources: quote_sources("original-summary", originals).unwrap(),
            model_budget: model_budget(&json!({}), &ContextSummaryRecipe::manual()).unwrap(),
        };
        let plan = builtin_plan(&preview).unwrap();
        let items: Vec<_> = plan
            .nodes()
            .iter()
            .flat_map(|node| &node.inputs)
            .map(|input| {
                let ContextCompactionInput::Source { source_id, range } = input else {
                    panic!("unbounded fixture needs one node")
                };
                source_item(
                    preview
                        .sources
                        .iter()
                        .find(|source| &source.source_id == source_id)
                        .unwrap(),
                    range.as_ref(),
                )
                .unwrap()
            })
            .collect();
        assert_eq!(items.len(), 15);
        for (index, group) in items.chunks_exact(5).enumerate() {
            let decode = |item: &ConversationItem| {
                let Content::Text { text } = &item.content else {
                    panic!("expected summary evidence text")
                };
                serde_json::from_str::<ConversationItem>(text).unwrap()
            };
            assert_eq!(decode(&group[0]), metadata[index]);
            let kind = ["output", "result", "job"][index];
            for (part, text) in [
                (0, format!("before-{kind} 中文")),
                (2, format!("after-{kind} 🎉")),
            ] {
                let item = decode(&group[if part == 0 { 1 } else { 4 }]);
                assert_eq!(item.content, Content::Text { text });
                assert_eq!(item.provenance, metadata[index].provenance);
                assert_eq!(item.id, format!("original-{kind}:part:{part}"));
            }
            let Content::Text { text } = &group[2].content else {
                panic!("media must retain its original source label")
            };
            let label: Value = serde_json::from_str(text).unwrap();
            assert_eq!(label["id"], format!("original-{kind}:part:1"));
            assert_eq!(label["content"]["kind"], "media");
            assert_eq!(label["content"]["sourceId"], group[3].id);
            assert_eq!(
                group[3].content,
                Content::Media {
                    media: media[index].clone()
                }
            );
            assert_eq!(
                group[3].provenance,
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
