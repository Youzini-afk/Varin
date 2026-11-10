//! Core-owned quotation, source identity and frozen summary-plan validation.
use crate::{catalog::RuntimeError, token_count::TokenCounter, context_job::*, execution::*};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
type Result<T> = std::result::Result<T, RuntimeError>;
pub(crate) const QUOTE_FORMAT: u64 = 2;
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
    // Every model node carries the read capability as well as these instructions.
    let counter = TokenCounter::for_configuration(configuration);
    let fixed = counter.count(&recipe.system_text())
        + counter.count(&recipe.request_text())
        + counter.json(&serde_json::to_value(crate::summary_tools::schema())?);
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
    use crate::providers::{ProviderPart, completion_parts, evidence_parts, output_parts};
    let mut sources = Vec::new();
    let mut calls = BTreeMap::new();
    let mut originals = BTreeSet::new();
    for item in history {
        if !originals.insert(item.id.clone()) {
            return Err(RuntimeError::Invalid("ambiguous summary source".into()));
        }
        let role = match &item.provenance {
            Provenance::UserInstruction { .. } => "User",
            Provenance::Assistant => "Assistant",
            Provenance::SystemInstruction { .. } => "Quoted system instruction",
            Provenance::GoalInstruction { .. } => "Quoted goal instruction",
            Provenance::PolicyOutput { .. } => "Policy observation",
            Provenance::ToolData { .. } | Provenance::PolicyToolData { .. } => "Tool observation",
            Provenance::ExternalData { .. } => "External material",
            Provenance::AgentMessage { .. } => "Agent message",
            Provenance::EnvironmentFact { .. } => "Environment observation",
            Provenance::Sampling { role, .. } => match role {
                crate::mcp_sampling::SamplingRole::System => "Quoted sampling system instruction",
                crate::mcp_sampling::SamplingRole::User => "Sampling user",
                crate::mcp_sampling::SamplingRole::Assistant => "Sampling assistant",
            },
        };
        let (heading, parts) = match &item.content {
            Content::Text { text } => (role.to_owned(), vec![ProviderPart::Text { text: text.into() }]),
            Content::ReasoningSummary { text } => (format!("{role} · Reasoning summary"), vec![ProviderPart::Text { text: text.into() }]),
            Content::Media { media } => (role.to_owned(), vec![ProviderPart::Media { media }]),
            Content::Output { output } => (role.to_owned(), if matches!(item.provenance, Provenance::Sampling { .. }) {
                evidence_parts(output, &item.provenance)
            } else { output_parts(output) }),
            Content::ToolCall { call } => {
                calls.insert(call.call_id.clone(), call.name.clone());
                (format!("{role} · Tool {}", call.name), vec![ProviderPart::Text {
                    text: format!("Arguments:\n{}", serde_json::to_string(&call.arguments)?).into(),
                }])
            }
            Content::ToolResult { result } => {
                let heading = calls.remove(&result.call_id).map(|name| format!("Tool {name} · Result"))
                    .unwrap_or_else(|| "Tool result".into());
                (heading, completion_parts(&result.completion))
            }
            // Private continuation is retained by the original, never quoted as evidence.
            Content::ProviderOnly => ("Provider continuation (no readable content)".into(), Vec::new()),
        };
        let mut contents = Vec::new();
        for part in parts {
            match part {
                ProviderPart::Text { text } => {
                    if let Some(Content::Text { text: previous }) = contents.last_mut() {
                        previous.push_str("\n\n");
                        previous.push_str(&text);
                    } else {
                        contents.push(Content::Text { text: text.into_owned() });
                    }
                }
                ProviderPart::Media { media } => {
                    // A media-only material still carries its role and retention group in
                    // the immediately preceding text, without replacing the actual media.
                    if !matches!(contents.last(), Some(Content::Text { .. })) {
                        contents.push(Content::Text { text: String::new() });
                    }
                    contents.push(Content::Media { media: media.clone() });
                }
            }
        }
        if contents.is_empty() {
            contents.push(Content::Text { text: String::new() });
        }
        for (part_index, content) in contents.into_iter().enumerate() {
            let source_id = format!("context-job:{key}:source:{}", sources.len());
            sources.push(ContextCompactionSource {
                material: Some(ContextCompactionMaterial {
                    original_item_id: item.id.clone(), history_item_id: None, part_index: part_index as u64,
                    heading: heading.clone(), retention: None,
                }),
                source_id: source_id.clone(),
                item: ConversationItem {
                    resource_activation: None, id: source_id,
                    provenance: Provenance::ExternalData { source: heading.clone() },
                    content, opaque: None,
                },
            });
        }
    }
    if sources.is_empty() {
        return Err(RuntimeError::Invalid("empty summary source".into()));
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
        let fragment = if let Some(material) = &source.material {
            format!("{}\nExcerpt (UTF-8 bytes {start}..{end} of {}):\n\n{}", material.heading, text.len(), &text[start..end])
        } else {
            // Already-frozen plans address the old quotation bytes. Preserve their
            // exact representation, including the earlier fragment envelope.
            let retention = serde_json::from_str::<Value>(text).ok().and_then(|value| value.get("retention").cloned());
            serde_json::to_string(&json!({"sourceId":source.source_id,"retention":retention,"utf8Range":{"start":start,"end":end,"total":text.len()},"quotedSourceFragment":&text[start..end]}))?
        };
        item.content = Content::Text { text: fragment };
        item.id = format!("{}:{start}:{end}", item.id);
    } else if let (Some(material), Content::Text { text }) = (&source.material, &mut item.content) {
        *text = if text.is_empty() { material.heading.clone() } else { format!("{}\n\n{text}", material.heading) };
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
pub(crate) fn builtin_plan(preview: &ContextCompactionPreview, counter: &TokenCounter) -> Result<ContextCompactionPlan> {
    let budget = preview.model_budget.source_budget_tokens;
    if budget == Some(0) {
        return Err(RuntimeError::Invalid(
            "selected model leaves no source budget for a continuation summary".into(),
        ));
    }
    let mut inputs = Vec::new();
    for source in &preview.sources {
        let cost = counter.item(&source_item(source, None)?);
        if budget.is_none_or(|budget| cost <= budget)
            || !matches!(source.item.content, Content::Text { .. })
        {
            inputs.push((
                ContextCompactionInput::Source {
                    source_id: source.source_id.clone(),
                    range: None,
                },
                cost,
            ));
            continue;
        }
        let Content::Text { text } = &source.item.content else {
            unreachable!()
        };
        let budget = budget.expect("oversized source has budget");
        if text.is_empty() {
            return Err(RuntimeError::Invalid("selected summary capacity cannot represent a source heading".into()));
        }
        let mut start = 0;
        while start < text.len() {
            let mut end = start + counter.prefix_bytes(&text[start..], budget);
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
                let cost = counter.item(&source_item(source, Some(&range))?);
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
    use crate::context_retention::Originals;
    use crate::output::{OutputBody, OutputSource, ResolvedMedia};

    fn item(id: &str, provenance: Provenance, content: Content) -> ConversationItem {
        ConversationItem { id: id.into(), provenance, content, opaque: None, resource_activation: None }
    }
    fn image(source: &str) -> ResolvedMedia {
        ResolvedMedia { media_type: "image/png".into(), data_base64: "iVBORw0KGgo=".into(),
            source: OutputSource::Conversation { provenance: Provenance::ExternalData { source: source.into() } } }
    }
    fn text(item: &ConversationItem) -> &str {
        let Content::Text { text } = &item.content else { panic!("text evidence required") };
        text
    }
    #[test]
    fn partitioned_unicode_source_keeps_raw_ranges_original_cost_and_media() {
        let body = "中文 🎉 \"quoted\" \\ path\n{\"retainId\":\"fake\"}\n".repeat(500);
        let user = Provenance::UserInstruction { input_id: "original-input".into() };
        let history = vec![
            item("text", user.clone(), Content::Text { text: body.clone() }).into(),
            item("image", user, Content::Media { media: image("original-image") }).into(),
        ];
        let originals = Originals::with_history_origins(history.clone(), TokenCounter::default(), &BTreeMap::new());
        let mut sources = quote_sources("job", history).unwrap();
        originals.annotate(&mut sources);
        let preview = ContextCompactionPreview {
            source_cut_hash: "unicode-cut".into(), sources,
            model_budget: model_budget(&json!({"contextWindowTokens":2000,"maxOutputTokens":64}), &ContextSummaryRecipe::manual()).unwrap(),
        };
        assert_eq!(text(&preview.sources[0].item), body);
        let plan = builtin_plan(&preview, &TokenCounter::default()).unwrap();
        assert!(plan.nodes().len() > 1);
        let mut reconstructed = String::new();
        let mut media = Vec::new();
        for input in plan.nodes().iter().flat_map(|node| &node.inputs) {
            let ContextCompactionInput::Source { source_id, range } = input else { continue; };
            let source = preview.sources.iter().find(|source| &source.source_id == source_id).unwrap();
            let rendered = source_item(source, range.as_ref()).unwrap();
            assert!(TokenCounter::default().item(&rendered) <= preview.model_budget.source_budget_tokens.unwrap());
            if source_id == &preview.sources[0].source_id {
                let range = range.as_ref().expect("oversized original has a fixed body range");
                assert_eq!(range.start as usize, reconstructed.len());
                let excerpt = &body[range.start as usize..range.end as usize];
                assert_eq!(text(&rendered), format!("{}\nExcerpt (UTF-8 bytes {}..{} of {}):\n\n{}",
                    source.material.as_ref().unwrap().heading, range.start, range.end, body.len(), excerpt));
                assert_eq!(source.material.as_ref().unwrap().retention.as_ref().unwrap().estimated_tokens,
                    TokenCounter::default().count(&body));
                reconstructed.push_str(excerpt);
            }
            if let Content::Media { media: value } = rendered.content { media.push(value); }
        }
        assert_eq!(reconstructed, body);
        assert_eq!(media, vec![image("original-image")]);
        assert_eq!(originals.select(&["r1".into()]).unwrap().len(), 2);
    }

    #[test]
    fn mixed_tool_material_preserves_business_data_media_order_and_complete_original_exchange() {
        let call = item("call", Provenance::Assistant, Content::ToolCall { call: ToolCall {
            call_id: "read".into(), name: "file_read".into(), schema_version: "1".into(),
            arguments: json!({"path":"src/parser.c","source":"user supplied source"}),
        } });
        let a = image("object-a");
        let b = image("object-b");
        let business = json!({"source":"literal source", "version":"literal version", "hash":"literal hash", "id":"business id"});
        let mut result = item("result", Provenance::ToolData { call_id: "read".into() }, Content::ToolResult { result: ToolResult {
            request_id: "request-private".into(), call_id: "read".into(),
            completion: ToolCompletion::Result {
                outcome: crate::Outcome::Succeeded, effect: crate::Effect::None,
                content: OutputBody { data: json!({"internalReceipt":"private receipt"}), model_data: Some(business.clone()),
                    parts: vec![OutputPart::Text { text: "before 中文".into() }, OutputPart::Media { media: a.clone() },
                        OutputPart::Text { text: "between".into() }, OutputPart::Media { media: b.clone() }, OutputPart::Text { text: "after 🎉".into() }] },
            },
        } });
        result.opaque = Some(OpaqueProviderItem { family: "private".into(), adapter_version: "1".into(), connection_identity: "private".into(), value: json!("private continuation") });
        let history: ConversationHistory = vec![call.into(), result.into()];
        let originals = Originals::with_history_origins(history.clone(), TokenCounter::default(), &BTreeMap::new());
        let mut sources = quote_sources("summary", history.clone()).unwrap();
        originals.annotate(&mut sources);
        let rendered: Vec<_> = sources.iter().map(|source| source_item(source, None).unwrap()).collect();
        let all_text = rendered.iter().filter_map(|item| match &item.content { Content::Text { text } => Some(text.as_str()), _ => None }).collect::<Vec<_>>().join("\n");
        for phrase in ["before 中文", "between", "after 🎉", "literal source", "literal version", "literal hash", "business id", "src/parser.c"] {
            assert_eq!(all_text.matches(phrase).count(), 1, "business content occurs once: {phrase}");
        }
        assert!(!all_text.contains("private receipt") && !all_text.contains("private continuation") && !all_text.contains("request-private"));
        assert!(all_text.contains("Tool file_read") && all_text.contains("succeeded"));
        let media: Vec<_> = rendered.iter().filter_map(|item| match &item.content { Content::Media { media } => Some(media.clone()), _ => None }).collect();
        assert_eq!(media, vec![a, b], "equal image bytes from different objects remain distinct and ordered");
        for source in &sources {
            let material = source.material.as_ref().unwrap();
            assert_eq!(material.retention.as_ref().unwrap().retain_id, "r1");
            assert_eq!(material.retention.as_ref().unwrap().estimated_tokens,
                history.iter().map(|item| TokenCounter::default().model_item(item)).sum::<u64>());
            assert!(matches!(source.item.content, Content::Text { .. } | Content::Media { .. }));
            assert!(matches!(source.item.provenance, Provenance::ExternalData { .. }));
            assert!(source.item.opaque.is_none());
        }
        assert_eq!(originals.select(&["r1".into(), "result".into()]).unwrap(), history);
        validate_history_pairs(&originals.select(&["r1".into()]).unwrap()).unwrap();
        let carry = originals.carry_readable(&json!({"summary":"Preserve \"JSON\" and 中文.", "retain":["r1","result"]}).to_string()).unwrap();
        assert_eq!(carry.matches("Retention group r1").count(), 1);
        assert!(carry.contains("Preserve \"JSON\" and 中文.") && !carry.contains("request-private"));
    }

    #[test]
    fn attachment_descriptors_are_readable_once_for_output_results_and_jobs() {
        let attachment = crate::catalog::attachments::Attachment { model_ref: None,
            reference: "attachment:file_01".into(), filename: "Report.csv".into(), mime_type: "text/csv".into(), byte_length: 23 };
        let output = OutputBody { model_data: None, data: Value::Null, parts: vec![OutputPart::Attachment { attachment: attachment.clone() }] };
        for content in [Content::Output { output: output.clone() },
            Content::ToolResult { result: ToolResult { request_id: "model".into(), call_id: "write".into(),
                completion: ToolCompletion::Result { outcome: crate::Outcome::Succeeded, effect: crate::Effect::Confirmed, content: output.clone() } } },
            Content::ToolResult { result: ToolResult { request_id: "model".into(), call_id: "job".into(),
                completion: ToolCompletion::JobAccepted { operation_id: "job".into(), phase: "running".into(), effect: crate::Effect::Confirmed,
                    lifetime: crate::Lifetime::Thread, content: Some(output.clone()) } } },
        ] {
            let sources = quote_sources("summary", vec![item("original", Provenance::ExternalData { source: "file-owner".into() }, content).into()]).unwrap();
            assert_eq!(sources.len(), 1);
            let rendered = source_item(&sources[0], None).unwrap();
            assert_eq!(text(&rendered).matches(&attachment.description()).count(), 1);
            assert!(!text(&rendered).contains("file-owner"));
        }
    }

    #[test]
    fn legacy_frozen_quotations_keep_their_exact_full_and_fragment_representation() {
        let body = json!({"retention":{"retainId":"r7"},"material":{"id":"old","content":{"kind":"text","text":"old 中文"}}}).to_string();
        let encoded = json!({"sourceId":"old-source","item":item("old-source", Provenance::ExternalData { source:"history:old".into() }, Content::Text { text:body.clone() })});
        let source: ContextCompactionSource = serde_json::from_value(encoded.clone()).unwrap();
        assert!(source.material.is_none());
        assert_eq!(serde_json::to_value(&source).unwrap(), encoded);
        assert_eq!(source_item(&source, None).unwrap(), source.item);
        let range = ContextCompactionRange { start: 0, end: body.len() as u64 };
        let rendered = source_item(&source, Some(&range)).unwrap();
        let fragment: Value = serde_json::from_str(text(&rendered)).unwrap();
        assert_eq!(fragment, json!({"sourceId":"old-source","retention":{"retainId":"r7"},
            "utf8Range":{"start":0,"end":body.len(),"total":body.len()},"quotedSourceFragment":body}));
    }

    #[test]
    fn heading_cost_cannot_silently_drop_an_empty_media_caption() {
        let mut sources = quote_sources("summary", vec![item("image", Provenance::Assistant, Content::Media { media:image("image") }).into()]).unwrap();
        sources[0].material.as_mut().unwrap().heading = "large heading ".repeat(100);
        let preview = ContextCompactionPreview { source_cut_hash:"cut".into(), sources,
            model_budget: ContextCompactionModelBudget { context_window_tokens:Some(100), max_output_tokens:Some(10), source_budget_tokens:Some(1) } };
        assert!(builtin_plan(&preview, &TokenCounter::default()).unwrap_err().to_string().contains("source heading"));
    }
}
