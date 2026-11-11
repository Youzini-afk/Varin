//! Model capabilities affect the outgoing request, never the durable conversation or media store.
use super::*;
use super::output_preview::{bounded_output, is_explicit_read, retrieval_preview_limit};
use std::collections::BTreeMap;

#[derive(Default)]
pub(crate) struct TextInputProjection {
    items: BTreeMap<usize, (Arc<ConversationItem>, Arc<ConversationItem>)>,
    settings: Option<(Option<bool>, Option<usize>, bool, String)>,
}
const IMAGE_NOTICE: &str = "[Image omitted: the selected model accepts text input only.]";
fn gif_attachment(content:&Content)->bool {
    let output=match content {
        Content::Output{output}=>Some(output),
        Content::ToolResult{result}=>completion_output(&result.completion),_=>None,
    };
    output.is_some_and(|output|output.parts.iter().any(|part|matches!(part,OutputPart::Attachment{attachment} if attachment.mime_type=="image/gif")))
}


fn output_text(output: &OutputBody, omitted: &dyn Fn(&crate::output::ResolvedMedia)->Option<&'static str>) -> OutputBody {
    OutputBody {
        model_data: output.model_data.clone(),
        data: output.data.clone(),
        parts: output.parts.iter().map(|part| match part {
            OutputPart::Media { media } if omitted(media).is_some() =>
                OutputPart::Text { text: omitted(media).expect("selected notice").into() },
            _ => part.clone(),
        }).collect(),
    }
}
fn text_content(content: &Content, omitted: &dyn Fn(&crate::output::ResolvedMedia)->Option<&'static str>) -> Content {
    match content {
        Content::Media { media } if omitted(media).is_some() =>
            Content::Text { text: omitted(media).expect("selected notice").into() },
        Content::Output { output } => Content::Output { output: output_text(output, omitted) },
        Content::ToolResult { result } => Content::ToolResult { result: ToolResult {
            request_id: result.request_id.clone(), call_id: result.call_id.clone(),
            completion: match &result.completion {
                ToolCompletion::Result { outcome, effect, content } => ToolCompletion::Result {
                    outcome: *outcome, effect: *effect, content: output_text(content, omitted),
                },
                ToolCompletion::JobAccepted { operation_id, phase, effect, lifetime, content } => ToolCompletion::JobAccepted {
                    operation_id: operation_id.clone(), phase: phase.clone(), effect: *effect,
                    lifetime: *lifetime, content: content.as_ref().map(|output|output_text(output, omitted)),
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

/// Explicit owner contract for accepted Jobs; never infer handles from arbitrary
/// raw JSON fields and never look up current Catalog state during serialization.
fn projected_operation(output:&OutputBody)->Option<String> {
    let reference=output.model_data.as_ref()?.get("operationRef")?.as_str()?;
    let valid=if let Some((kind,id))=reference.split_once(':') {
        matches!(kind,"proc"|"env"|"job"|"forward"|"followup") && id.parse::<u64>().is_ok_and(|id|id>0)
    } else if let Some((agent,sequence))=reference.split_once('/') {
        agent.len()==8 && agent.bytes().all(|byte|byte.is_ascii_uppercase()||byte.is_ascii_digit()) && sequence.parse::<u64>().is_ok_and(|id|id>0)
    } else {false};
    valid.then(||reference.into())
}
fn owner_projection(content: &Content) -> Option<Content> {
    let output = match content {
        Content::Output {output} => output,
        Content::ToolResult {result} => completion_output(&result.completion)?,
        _ => return None,
    };
    if output.model_data.is_none() && !output.parts.iter().any(|part|matches!(part,OutputPart::Attachment{attachment} if attachment.model_ref.is_some())) {return None;}
    // Every serializer, including existing extension codecs, consumes the same
    // transient semantic data. Durable raw receipts and navigation stay intact.
    let mut projected = content.clone();
    let output = match &mut projected {
        Content::Output {output} => output,
        Content::ToolResult {result} => match &mut result.completion {
            ToolCompletion::Result {content,..} => content,
            ToolCompletion::JobAccepted {operation_id,content:Some(content),..} => {
                if let Some(reference)=projected_operation(content) {*operation_id=reference;}
                content
            },
            _ => unreachable!(),
        },
        _ => unreachable!(),
    };
    if let Some(model)=output.model_data.take() {output.data=model;}
    for part in &mut output.parts {
        if let OutputPart::Attachment{attachment}=part {*attachment=attachment.model_descriptor();}
    }
    Some(projected)
}

fn process_call(call: &ToolCall) -> bool {
    let name = if call.name == crate::tool_disclosure::INVOKE { crate::tool_disclosure::invoked_name(&call.arguments).unwrap_or("") } else { &call.name };
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
    project(output.model_data.as_mut().unwrap_or(&mut output.data)).then_some(Content::ToolResult {result})
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
    let google_gif=matches!(view.binding.provider_family.as_str(),google::FAMILY|google::VERTEX_FAMILY)
        && view.history.iter().any(|item|gif_attachment(&item.content));
    if !google_gif && connection.accepts_images != Some(false) && connection.tool_output_visible_bytes.is_none()
        && !view.history.iter().any(|item| owner_projection(&item.content).is_some())
        && !view.history.iter().any(|item| matches!(&item.content, Content::ToolCall { call } if retrieval_preview_limit(call).is_some() || process_call(call))) { return Cow::Borrowed(view); }
    let mut cache = reuse.map(|reuse| &mut reuse.text_input);
    let can_read = view.binding.tools.iter().any(|tool| tool.name == crate::catalog::family::READ_TOOL);
    let settings = (connection.accepts_images, connection.tool_output_visible_bytes, can_read,view.binding.provider_family.clone());
    let mut user_gif_inputs=std::collections::BTreeSet::new();
    if google_gif {
        for item in &view.history {
            if let Provenance::UserInstruction{input_id}=&item.provenance {
                if gif_attachment(&item.content) {user_gif_inputs.insert(input_id.as_str());}
            }
        }
    }
    if let Some(cache) = cache.as_mut() {
        if cache.settings.as_ref() != Some(&settings) { cache.items.clear(); cache.settings = Some(settings); }
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
            // Operation identity is a control handle, not previewable body text.
            let original_operation = match &source.content {
                Content::ToolResult { result } => match &result.completion {
                    ToolCompletion::JobAccepted { content: Some(output), .. } => projected_operation(output),
                    _ => None,
                },
                _ => None,
            };
            let mut content = None;
            if process { if let Some(projected)=process_text(content.as_ref().unwrap_or(&source.content)) {content=Some(projected);} }
            if let Some(bounded) = connection.tool_output_visible_bytes.or(snippet_limit.map(|_| usize::MAX)).filter(|_| !explicit_read)
                .and_then(|budget| bounded_content(content.as_ref().unwrap_or(&source.content), budget, &source.id, can_read, snippet_limit)) {
                content=Some(bounded);
            }
            // Keep the durable model_data address through preview generation. Moving it to
            // data earlier would make continuation pointers read a different raw field.
            if let Some(mut projected) = owner_projection(content.as_ref().unwrap_or(&source.content)) {
                if let (Some(reference), Content::ToolResult { result }) = (original_operation, &mut projected) {
                    if let ToolCompletion::JobAccepted { operation_id, .. } = &mut result.completion {
                        *operation_id = reference;
                    }
                }
                content = Some(projected);
            }
            let attached_gif=google_gif && (gif_attachment(&source.content) || match &source.provenance {
                Provenance::UserInstruction{input_id}=>user_gif_inputs.contains(input_id.as_str()),_=>false,
            });
            let omitted=|media:&crate::output::ResolvedMedia| {
                if connection.accepts_images==Some(false) && media.media_type.starts_with("image/"){Some(IMAGE_NOTICE)}
                else if attached_gif && media.media_type=="image/gif" {Some("[Image omitted: this provider does not support direct GIF input. The original file attachment remains available.]")}
                else {None}
            };
            if source.content.media().iter().any(|media|omitted(media).is_some()) {
                content = Some(text_content(content.as_ref().unwrap_or(&source.content),&omitted));
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
