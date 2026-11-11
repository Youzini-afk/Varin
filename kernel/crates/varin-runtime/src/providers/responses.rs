use super::*;
use serde_json::json;
use std::collections::BTreeMap;
pub const FAMILY: &str = "openai-responses";

pub struct ResponsesProvider {
    family: &'static str,
    pub connection: Connection,
    pub max_output_tokens: Option<u64>,
    /// Compatible endpoints can explicitly reject the optional strict-mode field.
    pub supports_strict_mode: Option<bool>,
    /// Provider-native reasoning settings, fixed when the adapter generation is constructed.
    pub reasoning: Option<Value>,
}
impl ResponsesProvider {
    pub fn new(connection: Connection) -> Self {
        Self {
            family: FAMILY,
            connection,
            max_output_tokens: None,
            supports_strict_mode: None,
            reasoning: None,
        }
    }
    pub(super) fn for_family(connection: Connection, family: &'static str) -> Self {
        let mut provider = Self::new(connection);
        provider.family = family;
        provider
    }
}
fn response_parts(parts: Vec<ProviderPart<'_>>) -> Result<Vec<Value>, ExecutionError> {
    let mut blocks = Vec::new();
    for part in parts {
        match part {
            ProviderPart::Text { text } => {
                let mut block = json!({"type":"input_text"});
                block["text"] = Value::String(text.into_owned());
                blocks.push(block);
            }
            ProviderPart::Media { media } => {
                require_media_type(
                    media,
                    &["image/png", "image/jpeg", "image/webp", "image/gif"],
                    FAMILY,
                )?;
                let mut block = json!({"type":"input_image"});
                block["image_url"] = Value::String(inline_image(media));
                blocks.push(block);
            }
        }
    }
    Ok(blocks)
}
fn serialize_item(projected: ProjectedHistoryItem<'_>) -> Result<Value, ExecutionError> {
    let item = projected.item;
    if let Some(original) = projected.opaque {
        if original.adapter_version != "1" {
            return Err(ExecutionError::new(
                "opaque_version",
                "unsupported Responses continuation version",
            ));
        }
        return Ok(original.value.clone());
    }
    let role = match &item.provenance {
        p if p.is_system() => "system",
        p if p.is_assistant() => "assistant",
        _ => "user",
    };
    Ok(match &item.content {
        Content::Text { text } | Content::ReasoningSummary { text } => {
            json!({"role":role,"content":text})
        }
        Content::ToolCall { call } => {
            json!({"type":"function_call","call_id":call.call_id,"name":call.name,"arguments":call.arguments.to_string()})
        }
        Content::ToolResult { result } => {
            json!({"type":"function_call_output","call_id":result.call_id,"output":response_parts(completion_parts(&result.completion))?})
        }
        Content::Media { media } => {
            json!({"role":"user","content":response_parts(vec![ProviderPart::Media{media}])?})
        }
        Content::Output { output } => {
            json!({"role":evidence_role(&item.provenance,role),"content":response_parts(evidence_parts(output,&item.provenance))?})
        }
        Content::ProviderOnly => {
            return Err(ExecutionError::new(
                "missing_opaque",
                "provider-only content requires continuation data",
            ))
        }
    })
}
impl ResponsesProvider {
    pub(super) fn serialize_history<'a>(
        &self,
        view: &RequestView,
        history: impl IntoIterator<Item = ProjectedHistoryItem<'a>>,
        mut reuse: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        // Validation and the owning wrapper's lease check run even for a fully reusable prefix.
        validate_view(view, self.family)?;
        let previous = reuse
            .as_mut()
            .map(|reuse| std::mem::take(&mut reuse.responses))
            .unwrap_or_default();
        let mut input = Vec::new();
        for projected in history {
            let source = projected.item;
            let key = Arc::as_ptr(source) as usize;
            let fragment = match previous.get(&key) {
                Some((original, fragment)) if Arc::ptr_eq(original, source) => fragment.clone(),
                _ => crate::request_body::FrozenJson::new(serialize_item(projected)?),
            };
            if let Some(reuse) = reuse.as_mut() {
                reuse
                    .responses
                    .insert(key, (source.clone(), fragment.clone()));
            }
            input.push(fragment);
        }
        let tools = if let Some(tools) = reuse
            .as_ref()
            .and_then(|reuse| reuse.responses_tools.as_ref())
        {
            tools.clone()
        } else {
            let tools = view.binding.tools.iter().map(|t| {
                let mut tool = json!({"type":"function","name":t.name,"description":t.description,"parameters":tool_schema::openai_parameters(t)?});
                if self.supports_strict_mode != Some(false) {
                    tool["strict"] = json!(false);
                }
                Ok(crate::request_body::FrozenJson::new(tool))
            }).collect::<Result<Vec<_>, ExecutionError>>()?;
            if let Some(reuse) = reuse.as_mut() {
                reuse.responses_tools = Some(tools.clone());
            }
            tools
        };
        let mut body = RequestBody::from(
            json!({"model":view.binding.model,"stream":true,"store":false,"include":["reasoning.encrypted_content"]}),
        );
        body.insert_fragments("input", input);
        body.insert_fragments("tools", tools);
        if let Some(max) = self.max_output_tokens {
            body.insert("max_output_tokens", json!(max));
        }
        if let Some(reasoning) = &self.reasoning {
            body.insert("reasoning", reasoning.clone());
        }
        Ok(body)
    }
}
impl ModelProvider for ResponsesProvider {
    fn request_budget_protocol(&self) -> Option<crate::context_capacity::RequestBudgetProtocol> {
        Some(crate::context_capacity::RequestBudgetProtocol {
            transcript: &["input"],
            coalesced_content: None,
            complete_input_tokens: inclusive_input_tokens,
        })
    }

    fn serialize(
        &self,
        view: &RequestView,
        mut reuse: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        let input = model_input(view, &self.connection, reuse.as_deref_mut());
        let view = input.as_ref();
        self.serialize_history(
            view,
            project_history(
                &view.history,
                self.family,
                &view.binding.connection_identity,
            ),
            reuse,
        )
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
    incomplete: BTreeMap<String, Value>,
    calls: BTreeMap<String, String>,
    tool_calls: bool,
}
impl StreamState {
    fn item(
        &mut self,
        raw: Value,
        terminal_incomplete: bool,
        view: &RequestView,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<(), ModelFailure> {
        let id = required(&raw, "id")?.to_owned();
        if let Some(previous) = self.incomplete.get(&id) {
            if previous != &raw {
                return Err(failure("conflicting_provider_item", "provider changed an already finished item"));
            }
        }
        if let Some(previous) = self.completed.get(&id) {
            if previous != &raw {
                return Err(failure(
                    "conflicting_provider_item",
                    "provider changed an already completed item",
                ));
            }
            return Ok(());
        }
        let status = raw.get("status").and_then(Value::as_str);
        if status == Some("incomplete") && !terminal_incomplete {
            // A done item can be truncated. Wait for the terminal response (and its
            // usage) before deciding whether it is valid incomplete text or a failure.
            self.incomplete.insert(id, raw);
            return Ok(());
        }
        if status.is_some_and(|status| status != "completed")
            && !(terminal_incomplete && status == Some("incomplete") && raw["type"] == "message") {
            return Err(failure(
                "incomplete_provider_item",
                "provider did not complete an output item",
            ));
        }
        self.incomplete.remove(&id);
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
                    emit_event(emit, ProviderEvent::ToolCallStarted {
                        call_id: required(item, "call_id")?.into(), name: required(item, "name")?.into(), request_id: view.request_id.clone(),
                    })?;
                    self.calls.insert(
                        required(item, "id")?.into(),
                        required(item, "call_id")?.into(),
                    );
                }
            }
            "response.output_text.delta" | "response.refusal.delta" => emit_event(
                emit,
                ProviderEvent::TextDelta {
                    item_id: required(&event, "item_id")?.into(),
                    text: event["delta"]
                        .as_str()
                        .ok_or_else(|| failure("invalid_provider_event", "text delta is missing"))?
                        .into(),
                },
            )?,
            "response.reasoning_summary_text.delta" => emit_event(emit, ProviderEvent::ReasoningDelta {
                item_id: format!("{}:summary:{}", required(&event, "item_id")?, event["summary_index"].as_u64().unwrap_or(0)),
                text: event["delta"].as_str().ok_or_else(|| failure("invalid_provider_event", "reasoning delta is missing"))?.into(),
            })?,
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
            "response.output_item.done" => self.item(event["item"].clone(), false, view, emit)?,
            "response.completed" | "response.incomplete" | "response.failed" => {
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
                                // Newer Responses models bill cache writes separately. An
                                // omitted/invalid count on older or compatible endpoints stays
                                // unknown; it is not evidence that no cache write occurred.
                                cache_write_tokens: usage["input_tokens_details"]["cache_write_tokens"]
                                    .as_u64(),
                                reasoning_tokens: usage["output_tokens_details"]
                                    ["reasoning_tokens"]
                                    .as_u64(),
                                raw: Some(usage.clone()),
                                pricing_version: None,
                            },
                        },
                    )?;
                }
                if event["type"] == "response.failed" {
                    return Err(provider_failure(&response["error"], "provider_error"));
                }
                let incomplete = event["type"] == "response.incomplete";
                if !incomplete && !self.incomplete.is_empty() {
                    return Err(failure("incomplete_provider_item", "completed response contains an incomplete item"));
                }
                if let Some(items) = response["output"].as_array() {
                    for item in items {
                        if !incomplete && item["status"] == "incomplete" {
                            return Err(failure("incomplete_provider_item", "completed response contains an incomplete item"));
                        }
                        self.item(item.clone(), incomplete, view, emit)?;
                    }
                }
                for item in self.incomplete.values().cloned().collect::<Vec<_>>() {
                    self.item(item, incomplete, view, emit)?;
                }
                if incomplete && self.tool_calls {
                    return Err(failure("incomplete_tool_call", "Responses did not finish the tool-call batch"));
                }
                self.finished = Some(if incomplete {
                    match response["incomplete_details"]["reason"].as_str() {
                        Some("max_output_tokens") => FinishReason::Length,
                        Some("content_filter") => FinishReason::ContentFilter,
                        _ => {
                            return Err(failure(
                                "incomplete_response",
                                "unrecognized incomplete response reason",
                            ));
                        }
                    }
                } else if self.tool_calls {
                    FinishReason::ToolCalls
                } else {
                    FinishReason::Stop
                });
                return Ok(true);
            }
            "error" => return Err(provider_failure(&event, "provider_error")),
            // Protocol adds events over time. Only explicit terminal events establish completion.
            _ => {}
        }
        Ok(false)
    }
}
