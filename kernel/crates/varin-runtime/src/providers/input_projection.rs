//! Model capabilities affect the outgoing request, never the durable conversation or media store.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct TextInputProjection {
    items: BTreeMap<usize, (Arc<ConversationItem>, Arc<ConversationItem>)>,
    settings: Option<(Option<bool>, Option<usize>)>,
}
const IMAGE_NOTICE: &str = "[Image omitted: the selected model accepts text input only.]";

fn output_text(output: &OutputBody) -> OutputBody {
    OutputBody {
        data: output.data.clone(),
        parts: output.parts.iter().map(|part| match part {
            OutputPart::Media { media } if media.media_type.starts_with("image/") =>
                OutputPart::Text { text: IMAGE_NOTICE.into() },
            _ => part.clone(),
        }).collect(),
    }
}
fn text_content(content: &Content) -> Content {
    match content {
        Content::Media { media } if media.media_type.starts_with("image/") =>
            Content::Text { text: IMAGE_NOTICE.into() },
        Content::Output { output } => Content::Output { output: output_text(output) },
        Content::ToolResult { result } => Content::ToolResult { result: ToolResult {
            request_id: result.request_id.clone(), call_id: result.call_id.clone(),
            completion: match &result.completion {
                ToolCompletion::Result { outcome, effect, content } => ToolCompletion::Result {
                    outcome: *outcome, effect: *effect, content: output_text(content),
                },
                ToolCompletion::JobAccepted { operation_id, phase, effect, lifetime, content } => ToolCompletion::JobAccepted {
                    operation_id: operation_id.clone(), phase: phase.clone(), effect: *effect,
                    lifetime: *lifetime, content: content.as_ref().map(output_text),
                },
                other => other.clone(),
            },
        } },
        _ => content.clone(),
    }
}

/// Keep the beginning and the end (often the error/summary), without joining the
/// entire output or splitting UTF-8 characters. This runs once per immutable item.
fn preview(fragments: &[&str], budget: usize) -> String {
    const GAP: &str = "\n… [output truncated] …\n";
    let mut result = String::new();
    let head_budget = if budget > GAP.len() { (budget - GAP.len()) / 2 } else { budget };
    let mut remaining = head_budget;
    for text in fragments {
        let mut end = remaining.min(text.len());
        while !text.is_char_boundary(end) { end -= 1; }
        result.push_str(&text[..end]);
        remaining -= end;
        if end < text.len() { break; }
    }
    if budget <= GAP.len() { return result; }
    result.push_str(GAP);
    let mut tail = Vec::new();
    remaining = budget - result.len();
    for text in fragments.iter().rev() {
        let mut start = text.len().saturating_sub(remaining);
        while !text.is_char_boundary(start) { start += 1; }
        tail.push(&text[start..]);
        remaining -= text.len() - start;
        if start > 0 { break; }
    }
    for text in tail.into_iter().rev() { result.push_str(text); }
    result
}

fn bounded_output(output: &OutputBody, budget: usize, item_id: &str) -> Option<OutputBody> {
    let data = if output.data.is_null() { String::new() } else { serde_json::to_string(&output.data).expect("output data") };
    let mut fragments = vec![data.as_str()];
    for part in &output.parts {
        if let OutputPart::Text { text } = part {
            if !fragments.last().is_some_and(|text| text.is_empty()) { fragments.push("\n"); }
            fragments.push(text);
        }
    }
    let original_bytes: usize = fragments.iter().map(|text| text.len()).sum();
    if original_bytes <= budget { return None; }
    let data = json!({"truncated":true,"originalBytes":original_bytes,"historyItemId":item_id});
    let metadata_bytes = serde_json::to_string(&data).expect("output metadata").len();
    let mut parts = vec![OutputPart::Text { text: preview(&fragments, budget.saturating_sub(metadata_bytes)) }];
    parts.extend(output.parts.iter().filter(|part| matches!(part, OutputPart::Media { .. })).cloned());
    Some(OutputBody { data, parts })
}

fn bounded_content(content: &Content, budget: usize, item_id: &str) -> Option<Content> {
    match content {
        Content::Output { output } => bounded_output(output, budget, item_id).map(|output| Content::Output { output }),
        Content::ToolResult { result } => {
            let content = bounded_output(completion_output(&result.completion)?, budget, item_id)?;
            let mut result = result.clone();
            match &mut result.completion {
                ToolCompletion::Result { content: output, .. } => *output = content,
                ToolCompletion::JobAccepted { content: output, .. } => *output = Some(content),
                ToolCompletion::NotDispatched { .. } => unreachable!(),
            }
            Some(Content::ToolResult { result })
        },
        _ => None,
    }
}

/// Shared by built-in and contributed adapters. Unchanged items keep their Arc identity;
/// changed items are reused within the original compile cache without copying image bytes.
pub(super) fn model_input<'a>(view: &'a RequestView, connection: &Connection, reuse: Option<&mut RequestCompileReuse>) -> Cow<'a, RequestView> {
    let mut projected = text_input(view, connection, reuse);
    if let Some(tools) = crate::tool_disclosure::model_tools(&view.binding.tools) {
        projected.to_mut().binding.tools = tools;
    }
    projected
}

fn text_input<'a>(view: &'a RequestView, connection: &Connection, reuse: Option<&mut RequestCompileReuse>) -> Cow<'a, RequestView> {
    if connection.accepts_images != Some(false) && connection.tool_output_visible_bytes.is_none() { return Cow::Borrowed(view); }
    let mut cache = reuse.map(|reuse| &mut reuse.text_input);
    let settings = (connection.accepts_images, connection.tool_output_visible_bytes);
    if let Some(cache) = cache.as_mut() {
        if cache.settings != Some(settings) { cache.items.clear(); cache.settings = Some(settings); }
    }
    let mut previous = cache.as_mut().map(|cache| std::mem::take(&mut cache.items)).unwrap_or_default();
    let mut current = BTreeMap::new();
    let mut changed = false;
    let history = view.history.iter().map(|source| {
        let key = Arc::as_ptr(source) as usize;
        let item = previous.remove(&key).map(|(_, projected)| projected).unwrap_or_else(|| {
            let mut content = connection.tool_output_visible_bytes.and_then(|budget| bounded_content(&source.content, budget, &source.id));
            if connection.accepts_images == Some(false) && source.content.media().iter().any(|media| media.media_type.starts_with("image/")) {
                content = Some(text_content(content.as_ref().unwrap_or(&source.content)));
            }
            content.map_or_else(|| source.clone(), |content| Arc::new(ConversationItem {
                resource_activation: source.resource_activation.clone(), id: source.id.clone(), provenance: source.provenance.clone(),
                content,
                // Serialize the projected content; opaque bytes retain the full original output.
                opaque: None,
            }))
        });
        changed |= !Arc::ptr_eq(source, &item);
        if cache.is_some() { current.insert(key, (source.clone(), item.clone())); }
        item
    }).collect();
    if let Some(cache) = cache { cache.items = current; }
    if !changed { return Cow::Borrowed(view); }
    Cow::Owned(RequestView { history, ..view.clone() })
}
