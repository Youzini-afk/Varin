//! Model capabilities affect the outgoing request, never the durable conversation or media store.
use super::*;
use super::output_preview::{bounded_output, is_explicit_read};
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct TextInputProjection {
    items: BTreeMap<usize, (Arc<ConversationItem>, Arc<ConversationItem>)>,
    settings: Option<(Option<bool>, Option<usize>, bool)>,
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

fn bounded_content(content: &Content, budget: usize, item_id: &str, can_read: bool) -> Option<Content> {
    match content {
        Content::Output { output } => bounded_output(output, budget, item_id, can_read).map(|output| Content::Output { output }),
        Content::ToolResult { result } => {
            let content = bounded_output(completion_output(&result.completion)?, budget, item_id, can_read)?;
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
    let can_read = view.binding.tools.iter().any(|tool| tool.name == crate::catalog::family::READ_TOOL);
    let settings = (connection.accepts_images, connection.tool_output_visible_bytes, can_read);
    if let Some(cache) = cache.as_mut() {
        if cache.settings != Some(settings) { cache.items.clear(); cache.settings = Some(settings); }
    }
    let mut previous = cache.as_mut().map(|cache| std::mem::take(&mut cache.items)).unwrap_or_default();
    let mut current = BTreeMap::new();
    let mut calls = BTreeMap::new();
    let mut changed = false;
    let history = view.history.iter().map(|source| {
        if let Content::ToolCall { call } = &source.content {
            calls.insert(call.call_id.as_str(), is_explicit_read(call));
        }
        let explicit_read = match &source.content {
            Content::ToolResult { result } => calls.remove(result.call_id.as_str()).unwrap_or(false),
            _ => false,
        };
        let key = Arc::as_ptr(source) as usize;
        let item = previous.remove(&key).map(|(_, projected)| projected).unwrap_or_else(|| {
            let mut content = connection.tool_output_visible_bytes.filter(|_| !explicit_read)
                .and_then(|budget| bounded_content(&source.content, budget, &source.id, can_read));
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
