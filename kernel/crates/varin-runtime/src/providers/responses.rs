use super::*;
use serde_json::json;
use std::collections::BTreeMap;
pub const FAMILY: &str = "openai-responses";

pub struct ResponsesProvider {
    family: &'static str,
    pub connection: Connection,
    pub max_output_tokens: Option<u64>,
    /// Provider-native reasoning settings, fixed when the adapter generation is constructed.
    pub reasoning: Option<Value>,
}
impl ResponsesProvider {
    pub fn new(connection: Connection) -> Self {
        Self {
            family: FAMILY,
            connection,
            max_output_tokens: None,
            reasoning: None,
        }
    }
    pub(super) fn for_family(connection: Connection, family: &'static str) -> Self {
        let mut provider = Self::new(connection);
        provider.family = family;
        provider
    }
}
impl ModelProvider for ResponsesProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        validate_view(view, self.family)?;
        let mut input = Vec::new();
        for item in compile_history(
            &view.history,
            self.family,
            &view.binding.connection_identity,
        ) {
            if let Some(original) = item.opaque {
                if original.adapter_version != "1" {
                    return Err(ExecutionError::new(
                        "opaque_version",
                        "unsupported Responses continuation version",
                    ));
                }
                input.push(original.value);
                continue;
            }
            let role = match item.provenance {
                Provenance::SystemInstruction { .. } => "system",
                Provenance::Assistant => "assistant",
                _ => "user",
            };
            match item.content {
                Content::Text{text} | Content::ReasoningSummary{text} => input.push(json!({"role":role,"content":text})),
                Content::ToolCall{call}=>input.push(json!({"type":"function_call","call_id":call.call_id,"name":call.name,"arguments":call.arguments.to_string()})),
                Content::ToolResult{result}=>input.push(json!({"type":"function_call_output","call_id":result.call_id,"output":serde_json::to_string(&result.completion).map_err(|_|ExecutionError::new("serialize","invalid tool result"))?})),
                Content::Attachment{media_type,content_ref,..}=> {
                    let block = if media_type.starts_with("image/") && (content_ref.starts_with("https://") || content_ref.starts_with("data:image/")) {
                        json!({"type":"input_image","image_url":content_ref})
                    } else if media_type=="application/pdf" && content_ref.starts_with("https://") {
                        json!({"type":"input_file","file_url":content_ref})
                    } else { return Err(ExecutionError::new("unsupported_attachment", "Responses requires a supported image/PDF URL; resolve local references before compilation")); };
                    input.push(json!({"role":"user","content":[block]}));
                }
                Content::ProviderOnly=>return Err(ExecutionError::new("missing_opaque", "provider-only content requires continuation data")),
            }
        }
        let tools: Vec<_> = view
            .binding
            .tools
            .iter()
            .map(|t| json!({"type":"function","name":t.name,"parameters":t.schema}))
            .collect();
        let mut value = json!({"model":view.binding.model,"input":input,"tools":tools,"stream":true,"store":false,"include":["reasoning.encrypted_content"]});
        if let Some(max) = self.max_output_tokens {
            value["max_output_tokens"] = json!(max);
        }
        if let Some(reasoning) = &self.reasoning {
            value["reasoning"] = reasoning.clone();
        }
        Ok(value)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.generate_headers(request, cancel, emit, &[])
    }
}
impl ResponsesProvider {
    pub(super) fn generate_headers(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        headers: &[(&str, &str)],
    ) -> Result<FinishReason, ModelFailure> {
        if request.view.binding.provider_family != self.family {
            return Err(failure("provider_family_mismatch", "wrong adapter family"));
        }
        let mut state = StreamState::default();
        self.connection
            .run(request, cancel, headers, &mut |event| {
                state.event(event, &request.view, emit)
            })?;
        state.finished.ok_or_else(|| {
            failure(
                "stream_interrupted",
                "Responses stream ended before terminal response",
            )
        })
    }
}
#[derive(Default)]
struct StreamState {
    finished: Option<FinishReason>,
    completed: BTreeMap<String, Value>,
    calls: BTreeMap<String, String>,
    tool_calls: bool,
}
impl StreamState {
    fn item(
        &mut self,
        raw: Value,
        view: &RequestView,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<(), ModelFailure> {
        let id = required(&raw, "id")?.to_owned();
        if let Some(previous) = self.completed.get(&id) {
            if previous != &raw {
                return Err(failure(
                    "conflicting_provider_item",
                    "provider changed an already completed item",
                ));
            }
            return Ok(());
        }
        if raw
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status != "completed")
        {
            return Err(failure(
                "incomplete_provider_item",
                "provider did not complete an output item",
            ));
        }
        self.completed.insert(id.clone(), raw.clone());
        let content = match required(&raw, "type")? {
            "function_call" => {
                let name = required(&raw, "name")?;
                let arguments =
                    serde_json::from_str(required(&raw, "arguments")?).map_err(|_| {
                        failure(
                            "invalid_tool_arguments",
                            "completed tool arguments are invalid JSON",
                        )
                    })?;
                if !Value::is_object(&arguments) {
                    return Err(failure(
                        "invalid_tool_arguments",
                        "tool arguments must be an object",
                    ));
                }
                self.tool_calls = true;
                Content::ToolCall {
                    call: ToolCall {
                        call_id: required(&raw, "call_id")?.into(),
                        name: name.into(),
                        schema_version: schema_version(view, name)?,
                        arguments,
                    },
                }
            }
            "message" => {
                let blocks = raw
                    .get("content")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        failure("invalid_provider_item", "message has no content blocks")
                    })?;
                let text = blocks
                    .iter()
                    .filter_map(|b| match b["type"].as_str() {
                        Some("output_text") => b["text"].as_str(),
                        Some("refusal") => b["refusal"].as_str(),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                Content::Text { text }
            }
            "reasoning" => Content::ProviderOnly,
            _ => Content::ProviderOnly,
        };
        emit_event(
            emit,
            ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id,
                    content,
                    opaque: opaque(view, raw),
                },
            },
        )
    }
    fn event(
        &mut self,
        event: Value,
        view: &RequestView,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<bool, ModelFailure> {
        match required(&event, "type")? {
            "response.output_item.added" => {
                let item = &event["item"];
                if item["type"] == "function_call" {
                    self.calls.insert(
                        required(item, "id")?.into(),
                        required(item, "call_id")?.into(),
                    );
                }
            }
            "response.output_text.delta" => emit_event(
                emit,
                ProviderEvent::TextDelta {
                    item_id: required(&event, "item_id")?.into(),
                    text: event["delta"]
                        .as_str()
                        .ok_or_else(|| failure("invalid_provider_event", "text delta is missing"))?
                        .into(),
                },
            )?,
            "response.function_call_arguments.delta" => {
                let item_id = required(&event, "item_id")?;
                let call_id = self.calls.get(item_id).ok_or_else(|| {
                    failure("invalid_event_order", "tool delta precedes call identity")
                })?;
                emit_event(
                    emit,
                    ProviderEvent::ToolArgumentsDelta {
                        call_id: call_id.clone(),
                        delta: event["delta"]
                            .as_str()
                            .ok_or_else(|| {
                                failure("invalid_provider_event", "tool delta is missing")
                            })?
                            .into(),
                    },
                )?;
            }
            "response.output_item.done" => self.item(event["item"].clone(), view, emit)?,
            "response.completed" | "response.incomplete" => {
                let response = &event["response"];
                if let Some(usage) = response.get("usage").filter(|v| v.is_object()) {
                    emit_event(
                        emit,
                        ProviderEvent::Usage {
                            receipt: UsageReceipt {
                                measurement: UsageMeasurement::Actual,
                                input_tokens: usage["input_tokens"].as_u64(),
                                output_tokens: usage["output_tokens"].as_u64(),
                                cached_input_tokens: usage["input_tokens_details"]["cached_tokens"]
                                    .as_u64(),
                                cache_write_tokens: None,
                                reasoning_tokens: usage["output_tokens_details"]
                                    ["reasoning_tokens"]
                                    .as_u64(),
                                raw: Some(usage.clone()),
                                pricing_version: None,
                            },
                        },
                    )?;
                }
                if let Some(items) = response["output"].as_array() {
                    for item in items {
                        self.item(item.clone(), view, emit)?;
                    }
                }
                self.finished = Some(if event["type"] == "response.incomplete" {
                    match response["incomplete_details"]["reason"].as_str() {
                        Some("max_output_tokens") => FinishReason::Length,
                        Some("content_filter") => FinishReason::ContentFilter,
                        _ => {
                            return Err(failure(
                                "incomplete_response",
                                "unrecognized incomplete response reason",
                            ))
                        }
                    }
                } else if self.tool_calls {
                    FinishReason::ToolCalls
                } else {
                    FinishReason::Stop
                });
                return Ok(true);
            }
            "response.failed" => {
                return Err(provider_failure(
                    &event["response"]["error"],
                    "provider_error",
                ))
            }
            "error" => return Err(provider_failure(&event, "provider_error")),
            // Protocol adds events over time. Only explicit terminal events establish completion.
            _ => {}
        }
        Ok(false)
    }
}
