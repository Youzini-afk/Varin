//! Gemini/Vertex GenerateContent: model-scoped signed parts, not flattened assistant strings.
use super::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
pub const FAMILY: &str = "google-generative-ai";
pub const VERTEX_FAMILY: &str = "google-vertex";
pub struct GoogleProvider {
    pub connection: Connection,
    pub max_output_tokens: Option<u64>,
    pub thinking_config: Option<Value>,
    family: &'static str,
}
impl GoogleProvider {
    /// Endpoint is a complete models/...:streamGenerateContent URL. Credentials are header-only.
    pub fn new(connection: Connection) -> Result<Self, ExecutionError> {
        Self::for_family(connection, FAMILY)
    }
    pub fn vertex(connection: Connection) -> Result<Self, ExecutionError> {
        Self::for_family(connection, VERTEX_FAMILY)
    }
    fn for_family(
        mut connection: Connection,
        family: &'static str,
    ) -> Result<Self, ExecutionError> {
        let mut url = reqwest::Url::parse(&connection.endpoint).map_err(|_| {
            ExecutionError::new(
                "invalid_google_endpoint",
                "GenerateContent requires a complete endpoint URL",
            )
        })?;
        let mut alt = false;
        for (key, value) in url.query_pairs() {
            if key == "alt" {
                if alt || value != "sse" {
                    return Err(ExecutionError::new(
                        "invalid_google_endpoint",
                        "GenerateContent endpoint must use alt=sse",
                    ));
                }
                alt = true;
            }
        }
        if !alt {
            url.query_pairs_mut().append_pair("alt", "sse");
        }
        connection.endpoint = url.into();
        Ok(Self {
            connection,
            max_output_tokens: None,
            thinking_config: None,
            family,
        })
    }
}
fn push(contents: &mut Vec<Value>, role: &str, part: Value) {
    if let Some(last) = contents.last_mut().filter(|v| v["role"] == role) {
        last["parts"]
            .as_array_mut()
            .expect("constructed parts")
            .push(part);
    } else {
        contents.push(json!({"role":role,"parts":[part]}));
    }
}
impl ModelProvider for GoogleProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        validate_view(view, self.family)?;
        let mut contents = Vec::new();
        let mut system = Vec::new();
        let mut calls = BTreeMap::<String, (String, bool)>::new();
        for item in compile_history(
            &view.history,
            self.family,
            &view.binding.connection_identity,
        ) {
            if let Some(original) = &item.opaque {
                if original.adapter_version != "1" {
                    return Err(ExecutionError::new(
                        "opaque_version",
                        "unsupported GenerateContent continuation version",
                    ));
                }
                if original.value["model"] == view.binding.model {
                    let part = original
                        .value
                        .get("part")
                        .filter(|v| v.is_object())
                        .ok_or_else(|| {
                            ExecutionError::new(
                                "invalid_opaque",
                                "Google continuation lacks an original part",
                            )
                        })?
                        .clone();
                    if let Content::ToolCall { call } = &item.content {
                        calls.insert(
                            call.call_id.clone(),
                            (call.name.clone(), part["functionCall"]["id"].is_string()),
                        );
                    }
                    push(&mut contents, "model", part);
                    continue;
                }
                // Signatures are model-bound even within a protocol family. Keep only semantics.
            }
            let role = if matches!(item.provenance, Provenance::Assistant) {
                "model"
            } else {
                "user"
            };
            match item.content {
                Content::Text { text } | Content::ReasoningSummary { text } => {
                    if matches!(item.provenance, Provenance::SystemInstruction { .. }) {
                        if !contents.is_empty() {
                            return Err(ExecutionError::new("unsupported_mid_conversation_system","Google system instructions must be compiled before conversation content"));
                        }
                        system.push(json!({"text":text}));
                    } else {
                        push(&mut contents, role, json!({"text":text}));
                    }
                }
                Content::ToolCall { call } => {
                    calls.insert(call.call_id.clone(), (call.name.clone(), true));
                    push(
                        &mut contents,
                        "model",
                        json!({"functionCall":{"id":call.call_id,"name":call.name,"args":call.arguments}}),
                    );
                }
                Content::ToolResult { result } => {
                    let (name, wire_id) = calls.get(&result.call_id).ok_or_else(|| {
                        ExecutionError::new(
                            "invalid_history_pairing",
                            "Google tool result has no matching call name",
                        )
                    })?;
                    let mut response = json!({"name":name,"response":serde_json::to_value(&result.completion).map_err(|_|ExecutionError::new("serialize","invalid tool completion"))?});
                    if *wire_id {
                        response["id"] = json!(result.call_id);
                    }
                    push(&mut contents, "user", json!({"functionResponse":response}));
                }
                Content::Attachment {
                    media_type,
                    content_ref,
                    ..
                } => {
                    if let Some(data) =
                        content_ref.strip_prefix(&format!("data:{media_type};base64,"))
                    {
                        push(
                            &mut contents,
                            "user",
                            json!({"inlineData":{"mimeType":media_type,"data":data}}),
                        );
                    } else if content_ref.starts_with("gs://")
                        || content_ref.starts_with("https://generativelanguage.googleapis.com/")
                    {
                        push(
                            &mut contents,
                            "user",
                            json!({"fileData":{"mimeType":media_type,"fileUri":content_ref}}),
                        );
                    } else {
                        return Err(ExecutionError::new("unsupported_attachment","Google requires admitted inline data or provider-owned file references"));
                    }
                }
                Content::ProviderOnly => {}
            }
        }
        let declarations: Vec<_> = view
            .binding
            .tools
            .iter()
            .map(|t| json!({"name":t.name,"parametersJsonSchema":t.schema}))
            .collect();
        let mut body = json!({"contents":contents,"generationConfig":{"candidateCount":1}});
        if !system.is_empty() {
            body["systemInstruction"] = json!({"parts":system});
        }
        if !declarations.is_empty() {
            body["tools"] = json!([{"functionDeclarations":declarations}]);
        }
        if let Some(max) = self.max_output_tokens {
            body["generationConfig"]["maxOutputTokens"] = json!(max);
        }
        if let Some(thinking) = &self.thinking_config {
            body["generationConfig"]["thinkingConfig"] = thinking.clone();
        }
        Ok(body)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        if request.view.binding.provider_family != self.family {
            return Err(failure("provider_family_mismatch", "wrong adapter family"));
        }
        let mut state = StreamState::default();
        self.connection.run_events_mode(
            request,
            cancel,
            &[],
            &mut |event| {
                let event = event.ok_or_else(|| {
                    failure(
                        "invalid_google_stream",
                        "GenerateContent does not use a DONE sentinel",
                    )
                })?;
                state.event(event, &request.view, emit)?;
                Ok(false)
            },
            true,
        )?;
        let reason = state.finish.ok_or_else(|| {
            failure(
                "stream_interrupted",
                "GenerateContent ended before finishReason",
            )
        })?;
        if !state.calls.is_empty() && reason != FinishReason::ToolCalls {
            return Err(failure(
                "incomplete_tool_call",
                "Google did not complete its function-call batch",
            ));
        }
        for item in state.items {
            emit_event(emit, ProviderEvent::ItemCompleted { item })?;
        }
        Ok(reason)
    }
}
#[derive(Default)]
struct StreamState {
    response_id: Option<String>,
    items: Vec<ProviderItem>,
    calls: BTreeSet<String>,
    finish: Option<FinishReason>,
}
impl StreamState {
    fn event(
        &mut self,
        event: Value,
        view: &RequestView,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<(), ModelFailure> {
        if let Some(error) = event.get("error") {
            return Err(provider_failure(error, "provider_error"));
        }
        if let Some(id) = event["responseId"].as_str() {
            if self
                .response_id
                .as_deref()
                .is_some_and(|previous| previous != id)
            {
                return Err(failure(
                    "conflicting_response_id",
                    "Google response identity changed",
                ));
            }
            self.response_id = Some(id.into());
        }
        if let Some(usage) = event.get("usageMetadata").filter(|v| v.is_object()) {
            emit_event(
                emit,
                ProviderEvent::Usage {
                    receipt: UsageReceipt {
                        measurement: UsageMeasurement::Actual,
                        input_tokens: usage["promptTokenCount"].as_u64(),
                        output_tokens: usage["candidatesTokenCount"].as_u64().and_then(|n| {
                            n.checked_add(usage["thoughtsTokenCount"].as_u64().unwrap_or(0))
                        }),
                        cached_input_tokens: usage["cachedContentTokenCount"].as_u64(),
                        reasoning_tokens: usage["thoughtsTokenCount"].as_u64(),
                        raw: Some(usage.clone()),
                        ..UsageReceipt::default()
                    },
                },
            )?;
        }
        if event["promptFeedback"]["blockReason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty() && reason != "BLOCK_REASON_UNSPECIFIED")
        {
            self.finish = Some(FinishReason::ContentFilter);
        }
        if let Some(candidates) = event["candidates"].as_array() {
            if candidates.len() > 1 {
                return Err(failure(
                    "unsupported_multiple_choices",
                    "GenerateContent requested one candidate",
                ));
            }
            for candidate in candidates {
                if candidate
                    .get("index")
                    .is_some_and(|v| v.as_u64() != Some(0))
                {
                    return Err(failure(
                        "unsupported_multiple_choices",
                        "GenerateContent candidate index differs",
                    ));
                }
                if self.finish.is_some() {
                    return Err(failure(
                        "invalid_event_order",
                        "Google candidate follows terminal finishReason",
                    ));
                }
                if let Some(role) = candidate["content"].get("role") {
                    if role != "model" {
                        return Err(failure(
                            "invalid_provider_role",
                            "Google response is not model content",
                        ));
                    }
                }
                if let Some(parts) = candidate["content"]["parts"].as_array() {
                    for part in parts {
                        if !part.is_object() {
                            return Err(failure(
                                "invalid_provider_item",
                                "Google part must be an object",
                            ));
                        }
                        let id = format!(
                            "{}:{}",
                            self.response_id.as_deref().unwrap_or(&view.request_id),
                            self.items.len()
                        );
                        let content = if let Some(call) = part.get("functionCall") {
                            if call.get("partialArgs").is_some() || call["willContinue"] == true {
                                return Err(failure("unsupported_function_streaming","partial Google arguments require an explicit streaming contract"));
                            }
                            let name = required(call, "name")?;
                            let arguments = call.get("args").cloned().unwrap_or_else(|| json!({}));
                            if !arguments.is_object() {
                                return Err(failure(
                                    "invalid_tool_arguments",
                                    "Google function arguments must be an object",
                                ));
                            }
                            let call_id =
                                call["id"].as_str().map(str::to_owned).unwrap_or_else(|| {
                                    format!(
                                        "varin_{}_{}",
                                        view.request_id
                                            .replace(|c: char| !c.is_ascii_alphanumeric(), "_"),
                                        self.items.len()
                                    )
                                });
                            if call_id.is_empty() || !self.calls.insert(call_id.clone()) {
                                return Err(failure(
                                    "invalid_tool_call",
                                    "Google function identity is empty or duplicated",
                                ));
                            }
                            Content::ToolCall {
                                call: ToolCall {
                                    call_id,
                                    name: name.into(),
                                    schema_version: schema_version(view, name)?,
                                    arguments,
                                },
                            }
                        } else if let Some(text) = part["text"].as_str() {
                            if part["thought"] == true {
                                Content::ProviderOnly
                            } else {
                                emit_event(
                                    emit,
                                    ProviderEvent::TextDelta {
                                        item_id: id.clone(),
                                        text: text.into(),
                                    },
                                )?;
                                Content::Text { text: text.into() }
                            }
                        } else {
                            Content::ProviderOnly
                        };
                        self.items.push(ProviderItem {
                            id,
                            content,
                            opaque: opaque(view, json!({"model":view.binding.model,"part":part})),
                        });
                    }
                }
                if let Some(reason) = candidate["finishReason"].as_str() {
                    self.finish = Some(match reason {
                        "STOP" => {
                            if self.calls.is_empty() {
                                FinishReason::Stop
                            } else {
                                FinishReason::ToolCalls
                            }
                        }
                        "MAX_TOKENS" => FinishReason::Length,
                        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
                        | "IMAGE_SAFETY" => FinishReason::ContentFilter,
                        _ => {
                            return Err(failure(
                                "provider_finish_error",
                                "Google reported an unsupported or failed finish reason",
                            ))
                        }
                    });
                }
            }
        } else if event.get("usageMetadata").is_none() && event.get("promptFeedback").is_none() {
            return Err(failure(
                "invalid_provider_event",
                "GenerateContent event has no candidates or receipt",
            ));
        }
        Ok(())
    }
}
