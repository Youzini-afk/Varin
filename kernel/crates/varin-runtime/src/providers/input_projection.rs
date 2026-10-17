//! Model capabilities affect the outgoing request, never the durable conversation or media store.
use super::*;
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct TextInputProjection {
    items: BTreeMap<usize, (Arc<ConversationItem>, Arc<ConversationItem>)>,
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
    if connection.accepts_images != Some(false) { return Cow::Borrowed(view); }
    let mut cache = reuse.map(|reuse| &mut reuse.text_input);
    let mut previous = cache.as_mut().map(|cache| std::mem::take(&mut cache.items)).unwrap_or_default();
    let mut current = BTreeMap::new();
    let mut changed = false;
    let history = view.history.iter().map(|source| {
        if !source.content.media().iter().any(|media| media.media_type.starts_with("image/")) {
            return source.clone();
        }
        changed = true;
        let key = Arc::as_ptr(source) as usize;
        let item = previous.remove(&key).map(|(_, projected)| projected).unwrap_or_else(|| Arc::new(ConversationItem {
            resource_activation: source.resource_activation.clone(), id: source.id.clone(), provenance: source.provenance.clone(),
            content: text_content(&source.content),
            // Original protocol bytes may contain the image; serialize the derived semantic content.
            opaque: None,
        }));
        if cache.is_some() { current.insert(key, (source.clone(), item.clone())); }
        item
    }).collect();
    if let Some(cache) = cache { cache.items = current; }
    if !changed { return Cow::Borrowed(view); }
    Cow::Owned(RequestView { history, ..view.clone() })
}
