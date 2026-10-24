//! Model capabilities affect the outgoing request, never the durable conversation or media store.
use super::*;
use super::output_preview::{bounded_output, is_explicit_read, retrieval_preview_limit};
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

fn bounded_content(content: &Content, budget: usize, item_id: &str, can_read: bool, snippet_limit: Option<usize>) -> Option<Content> {
    match content {
        Content::Output { output } => bounded_output(output, budget, item_id, can_read, snippet_limit).map(|output| Content::Output { output }),
        Content::ToolResult { result } => {
            let content = bounded_output(completion_output(&result.completion)?, budget, item_id, can_read, snippet_limit)?;
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

fn process_call(call: &ToolCall) -> bool {
    let name = if call.name == crate::tool_disclosure::INVOKE { call.arguments["reference"]["name"].as_str().unwrap_or("") } else { &call.name };
    matches!(name,"process_spawn"|"process_read")
}
fn process_text(content: &Content) -> Option<Content> {
    fn project(value: &mut Value) -> bool {
        match value {
            Value::Array(items) => items.iter_mut().fold(false,|changed,item|project(item)||changed),
            Value::Object(fields) => {
                let mut changed = fields.values_mut().fold(false,|changed,item|project(item)||changed);
                if fields.get("text").is_some_and(Value::is_string) && fields.contains_key("bytesBase64") {
                    fields.remove("bytesBase64"); changed = true;
                }
                changed
            }, _ => false,
        }
    }
    let Content::ToolResult {result} = content else {return None};
    let mut result=result.clone();
    let output=match &mut result.completion {
        ToolCompletion::Result {content,..}=>content,
        ToolCompletion::JobAccepted {content:Some(content),..}=>content,
        _=>return None,
    };
    project(&mut output.data).then_some(Content::ToolResult {result})
}

/// Shared by built-in and contributed adapters. Unchanged items keep their Arc identity;
/// changed items are reused within the original compile cache without copying image bytes.
pub(super) fn model_input<'a>(view: &'a RequestView, connection: &Connection, reuse: Option<&mut RequestCompileReuse>) -> Cow<'a, RequestView> {
    let mut projected = text_input(view, connection, reuse);
    if let Some(tools) = crate::tool_disclosure::model_tools_for(&view.binding.tools, view.binding.direct_tools.as_deref()) {
        projected.to_mut().binding.tools = tools;
    }
    projected
}

fn text_input<'a>(view: &'a RequestView, connection: &Connection, reuse: Option<&mut RequestCompileReuse>) -> Cow<'a, RequestView> {
    if connection.accepts_images != Some(false) && connection.tool_output_visible_bytes.is_none()
        && !view.history.iter().any(|item| matches!(&item.content, Content::ToolCall { call } if retrieval_preview_limit(call).is_some() || process_call(call))) { return Cow::Borrowed(view); }
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
            calls.insert(call.call_id.as_str(), (is_explicit_read(call), retrieval_preview_limit(call),process_call(call)));
        }
        let (explicit_read, snippet_limit,process) = match &source.content {
            Content::ToolResult { result } => calls.remove(result.call_id.as_str()).unwrap_or_default(),
            _ => (false, None,false),
        };
        let key = Arc::as_ptr(source) as usize;
        let item = previous.remove(&key).map(|(_, projected)| projected).unwrap_or_else(|| {
            let mut content = process.then(||process_text(&source.content)).flatten();
            if let Some(bounded) = connection.tool_output_visible_bytes.or(snippet_limit.map(|_| usize::MAX)).filter(|_| !explicit_read)
                .and_then(|budget| bounded_content(content.as_ref().unwrap_or(&source.content), budget, &source.id, can_read, snippet_limit)) {
                content=Some(bounded);
            }
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
