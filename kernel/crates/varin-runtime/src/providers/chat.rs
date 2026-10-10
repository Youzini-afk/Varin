//! OpenAI Chat Completions wire contract. Vendor-specific compatibility is explicit configuration.
use super::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
pub const FAMILY: &str = "openai-completions";
pub struct ChatProvider {
    family: &'static str,
    mistral: bool,
    pub connection: Connection,
    pub max_output_tokens: Option<u64>,
    pub legacy_max_tokens: bool,
    pub include_stream_usage: bool,
    pub reasoning_effort: Option<String>,
}
impl ChatProvider {
    pub fn new(connection: Connection) -> Self {
        Self {
            family: FAMILY,
            mistral: false,
            connection,
            max_output_tokens: None,
            legacy_max_tokens: false,
            include_stream_usage: true,
            reasoning_effort: None,
        }
    }
    pub(super) fn mistral(connection: Connection) -> Self {
        let mut provider = Self::new(connection);
        provider.family = super::mistral::FAMILY;
        provider.mistral = true;
        provider.legacy_max_tokens = true;
        provider.include_stream_usage = false;
        provider
    }
}
impl ModelProvider for ChatProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        validate_view(view, self.family)?;
        validate_images(view, &self.connection)?;
        let mut messages = Vec::<Value>::new();
        let mut replayed = BTreeSet::new();
        for item in compile_history(
            &view.history,
            self.family,
            &view.binding.connection_identity,
        ) {
            if let Some(original) = item.opaque {
                if original.adapter_version != "1" {
                    return Err(ExecutionError::new(
                        "opaque_version",
                        "unsupported Chat continuation version",
                    ));
                }
                if let Some(calls) = original.value["tool_calls"].as_array() {
                    for call in calls {
                        if let Some(id) = call["id"].as_str() {
                            replayed.insert(id.to_owned());
                        }
                    }
                }
                messages.push(original.value);
                continue;
            }
            let role = match item.provenance {
                Provenance::SystemInstruction { .. } => "system",
                Provenance::Assistant | Provenance::PolicyOutput { .. } => "assistant",
                _ => "user",
            };
            match item.content {
                Content::Text{text}|Content::ReasoningSummary{text}=>messages.push(json!({"role":role,"content":text})),
                Content::ToolCall{call}=>{
                    if replayed.remove(&call.call_id){continue;}
                    let value=json!({"id":call.call_id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}});
                    if let Some(message)=messages.last_mut().filter(|m|m["role"]=="assistant"){
                        if message.get("tool_calls").is_none(){message["tool_calls"]=json!([]);}
                        message["tool_calls"].as_array_mut().ok_or_else(||ExecutionError::new("invalid_opaque","invalid Chat tool_calls"))?.push(value);
                    }else{messages.push(json!({"role":"assistant","content":null,"tool_calls":[value]}));}
                }
                Content::ToolResult{result}=>messages.push(json!({"role":"tool","tool_call_id":result.call_id,"content":serde_json::to_string(&result.completion).map_err(|_|ExecutionError::new("serialize","invalid tool result"))?})),
                Content::Attachment{media_type,content_ref,..}=>{
                    if !media_type.starts_with("image/")||!(content_ref.starts_with("https://")||content_ref.starts_with("data:image/")){return Err(ExecutionError::new("unsupported_attachment","Chat adapter requires a supported image URL; other media need a configured specialized adapter"));}
                    messages.push(json!({"role":"user","content":[{"type":"image_url","image_url":{"url":content_ref}}]}));
                }
                Content::ProviderOnly=>return Err(ExecutionError::new("missing_opaque","provider-only item lacks its original")),
            }
        }
        let tools:Vec<_>=view.binding.tools.iter().map(|tool|json!({"type":"function","function":{"name":tool.name,"parameters":tool.schema}})).collect();
        let mut body = json!({"model":view.binding.model,"messages":messages,"stream":true,"n":1});
        if !tools.is_empty() {
            body["tools"] = json!(tools);
        }
        if self.include_stream_usage {
            body["stream_options"] = json!({"include_usage":true});
        }
        if let Some(max) = self.max_output_tokens {
            body[if self.legacy_max_tokens {
                "max_tokens"
            } else {
                "max_completion_tokens"
            }] = json!(max);
        }
        if let Some(effort) = &self.reasoning_effort {
            body["reasoning_effort"] = json!(effort);
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
        let mut state = StreamState {
            mistral: self.mistral,
            ..StreamState::default()
        };
        let headers = if self.mistral {
            request.serialized["prompt_cache_key"]
                .as_str()
                .map(|key| vec![("x-affinity", key)])
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        self.connection.run_events_mode(
            request,
            cancel,
            &headers,
            &mut |event| state.event(event, &request.view, emit),
            self.mistral,
        )?;
        if self.mistral && !state.done {
            state.event(None, &request.view, emit)?;
        }
        if !state.done {
            return Err(failure(
                "stream_interrupted",
                "Chat stream ended before DONE",
            ));
        }
        state
            .finish
            .ok_or_else(|| failure("missing_stop_reason", "Chat stream omitted finish_reason"))
    }
}
#[derive(Default)]
struct Call {
    id: Option<String>,
    name: String,
    arguments: String,
}
#[derive(Default)]
struct StreamState {
    mistral: bool,
    id: Option<String>,
    message: serde_json::Map<String, Value>,
    calls: BTreeMap<u64, Call>,
    finish: Option<FinishReason>,
    done: bool,
}
impl StreamState {
    fn mistral_content(
        &mut self,
        value: &Value,
        id: &str,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<(), ModelFailure> {
        let incoming = if let Some(text) = value.as_str() {
            vec![json!({"type":"text","text":text})]
        } else {
            value
                .as_array()
                .ok_or_else(|| {
                    failure(
                        "unsupported_content_delta",
                        "Mistral content is neither text nor typed chunks",
                    )
                })?
                .clone()
        };
        let content = self
            .message
            .entry("content")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| {
                failure(
                    "invalid_content_delta",
                    "mixed incompatible Mistral content encodings",
                )
            })?;
        for part in incoming {
            match part["type"].as_str() {
                Some("text") => {
                    let text = part["text"].as_str().ok_or_else(|| {
                        failure("invalid_content_delta", "Mistral text chunk lacks text")
                    })?;
                    if text.is_empty() {
                        continue;
                    }
                    emit_event(
                        emit,
                        ProviderEvent::TextDelta {
                            item_id: format!("{id}:message"),
                            text: text.into(),
                        },
                    )?;
                    if part.as_object().is_some_and(|v| v.len() == 2)
                        && content.last().is_some_and(|last| {
                            last["type"] == "text" && last.as_object().is_some_and(|v| v.len() == 2)
                        })
                    {
                        let last = content.last_mut().unwrap();
                        let mut combined = last["text"].as_str().unwrap_or("").to_owned();
                        combined.push_str(text);
                        last["text"] = json!(combined);
                    } else {
                        content.push(part);
                    }
                }
                Some("thinking") => {
                    let thinking = part["thinking"].as_array().ok_or_else(|| {
                        failure(
                            "invalid_content_delta",
                            "Mistral thinking chunk lacks parts",
                        )
                    })?;
                    if part.as_object().is_some_and(|v| v.len() == 2)
                        && content.last().is_some_and(|last| {
                            last["type"] == "thinking"
                                && last.as_object().is_some_and(|v| v.len() == 2)
                        })
                    {
                        content.last_mut().unwrap()["thinking"]
                            .as_array_mut()
                            .expect("validated thinking")
                            .extend(thinking.iter().cloned());
                    } else {
                        content.push(part);
                    }
                }
                Some("reference") => content.push(part),
                _ => {
                    return Err(failure(
                        "unsupported_content_delta",
                        "unsupported Mistral output content type",
                    ))
                }
            }
        }
        Ok(())
    }
    fn event(
        &mut self,
        event: Option<Value>,
        view: &RequestView,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<bool, ModelFailure> {
        let Some(event) = event else {
            if self.finish.is_none() {
                return Err(failure(
                    "missing_stop_reason",
                    "Chat DONE arrived before finish_reason",
                ));
            }
            let id = self
                .id
                .as_deref()
                .ok_or_else(|| failure("invalid_provider_event", "Chat response id missing"))?;
            let mut tool_items = Vec::new();
            let mut raw_calls = Vec::new();
            let mut seen = BTreeSet::new();
            for (index, call) in &mut self.calls {
                if self.mistral
                    && call
                        .id
                        .as_deref()
                        .is_none_or(|id| id.is_empty() || id == "null")
                {
                    call.id = Some(super::mistral::derive_id(&format!("{id}:{index}"), 0));
                }
                let call_id = call
                    .id
                    .as_ref()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        failure("invalid_tool_call", "completed tool has no identity")
                    })?;
                if !seen.insert(call_id) {
                    return Err(failure("invalid_tool_call", "duplicate tool identity"));
                }
                let arguments: Value = serde_json::from_str(&call.arguments).map_err(|_| {
                    failure(
                        "invalid_tool_arguments",
                        "completed tool arguments are invalid JSON",
                    )
                })?;
                if !arguments.is_object() {
                    return Err(failure(
                        "invalid_tool_arguments",
                        "tool arguments must be an object",
                    ));
                }
                let call_value = ToolCall {
                    call_id: call_id.clone(),
                    name: call.name.clone(),
                    schema_version: schema_version(view, &call.name)?,
                    arguments,
                };
                tool_items.push(ProviderItem {
                    id: format!("{id}:tool:{index}"),
                    content: Content::ToolCall { call: call_value },
                    opaque: None,
                });
                raw_calls.push(json!({"id":call_id,"type":"function","function":{"name":call.name,"arguments":call.arguments}}));
            }
            if self.finish == Some(FinishReason::ToolCalls) && raw_calls.is_empty() {
                return Err(failure(
                    "invalid_tool_call",
                    "tool_calls finish has no calls",
                ));
            }
            if !raw_calls.is_empty() && self.finish != Some(FinishReason::ToolCalls) {
                return Err(failure(
                    "incomplete_tool_call",
                    "Chat did not finish the tool-call batch",
                ));
            }
            self.message.insert("role".into(), json!("assistant"));
            if !raw_calls.is_empty() {
                self.message.insert("tool_calls".into(), json!(raw_calls));
            }
            let text = if let Some(text) = self.message.get("content").and_then(Value::as_str) {
                text.to_owned()
            } else {
                self.message
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|part| {
                                if part["type"] == "text" {
                                    part["text"].as_str()
                                } else {
                                    None
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default()
            };
            if !self.message.contains_key("content") {
                self.message.insert("content".into(), Value::Null);
            }
            let content = if text.is_empty()
                && self
                    .message
                    .get("refusal")
                    .and_then(Value::as_str)
                    .is_some()
            {
                Content::Text {
                    text: self.message["refusal"].as_str().unwrap().into(),
                }
            } else {
                Content::Text { text }
            };
            emit_event(
                emit,
                ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: format!("{id}:message"),
                        content,
                        opaque: opaque(view, Value::Object(self.message.clone())),
                    },
                },
            )?;
            for item in tool_items {
                emit_event(emit, ProviderEvent::ItemCompleted { item })?;
            }
            self.done = true;
            return Ok(true);
        };
        if let Some(error) = event.get("error") {
            return Err(provider_failure(error, "provider_error"));
        }
        let id = required(&event, "id")?;
        if self.id.as_deref().is_some_and(|previous| previous != id) {
            return Err(failure(
                "conflicting_response_id",
                "Chat response identity changed mid-stream",
            ));
        }
        self.id = Some(id.into());
        if let Some(usage) = event.get("usage").filter(|v| v.is_object()) {
            emit_event(
                emit,
                ProviderEvent::Usage {
                    receipt: UsageReceipt {
                        measurement: UsageMeasurement::Actual,
                        input_tokens: usage["prompt_tokens"].as_u64(),
                        output_tokens: usage["completion_tokens"].as_u64(),
                        cached_input_tokens: usage["prompt_tokens_details"]["cached_tokens"]
                            .as_u64()
                            .or_else(|| {
                                if self.mistral {
                                    usage["prompt_token_details"]["cached_tokens"]
                                        .as_u64()
                                        .or_else(|| usage["num_cached_tokens"].as_u64())
                                } else {
                                    None
                                }
                            }),
                        reasoning_tokens: usage["completion_tokens_details"]["reasoning_tokens"]
                            .as_u64(),
                        raw: Some(usage.clone()),
                        ..UsageReceipt::default()
                    },
                },
            )?;
        }
        let choices = event["choices"]
            .as_array()
            .ok_or_else(|| failure("invalid_provider_event", "Chat chunk lacks choices"))?;
        for choice in choices {
            if choice["index"].as_u64() != Some(0) {
                return Err(failure(
                    "unsupported_multiple_choices",
                    "request accepts exactly one Chat choice",
                ));
            }
            let delta = choice["delta"]
                .as_object()
                .ok_or_else(|| failure("invalid_provider_event", "Chat chunk lacks delta"))?;
            if self.finish.is_some() {
                return Err(failure(
                    "invalid_event_order",
                    "Chat content follows finish_reason",
                ));
            }
            for (key, value) in delta {
                match key.as_str() {
                    "role" => {
                        if value != "assistant" {
                            return Err(failure(
                                "invalid_provider_role",
                                "Chat response role is not assistant",
                            ));
                        }
                    }
                    "content" | "refusal" | "reasoning_content" | "reasoning" => {
                        if value.is_null() {
                            continue;
                        }
                        if self.mistral && key == "content" {
                            self.mistral_content(value, id, emit)?;
                            continue;
                        }
                        let text = value.as_str().ok_or_else(|| {
                            failure("unsupported_content_delta", "Chat text field is not text")
                        })?;
                        let field = self.message.entry(key.clone()).or_insert_with(|| json!(""));
                        let mut combined = field.as_str().unwrap_or("").to_owned();
                        combined.push_str(text);
                        *field = json!(combined);
                        if key == "content" {
                            emit_event(
                                emit,
                                ProviderEvent::TextDelta {
                                    item_id: format!("{id}:message"),
                                    text: text.into(),
                                },
                            )?;
                        }
                    }
                    "tool_calls" => {
                        if self.mistral && value.is_null() {
                            continue;
                        }
                        for value in value.as_array().ok_or_else(|| {
                            failure("invalid_tool_call", "tool delta is not a list")
                        })? {
                            let index = value["index"].as_u64().ok_or_else(|| {
                                failure("invalid_tool_call", "tool delta lacks index")
                            })?;
                            let call = self.calls.entry(index).or_default();
                            if let Some(kind) = value.get("type") {
                                if kind != "function" {
                                    return Err(failure(
                                        "unsupported_tool_type",
                                        "Chat tool type is unsupported",
                                    ));
                                }
                            }
                            if let Some(id) = value["id"]
                                .as_str()
                                .filter(|id| !self.mistral || (*id != "null" && !id.is_empty()))
                            {
                                if call.id.as_deref().is_some_and(|old| old != id) {
                                    return Err(failure(
                                        "conflicting_tool_id",
                                        "tool identity changed",
                                    ));
                                }
                                call.id = Some(id.into());
                            }
                            if let Some(name) = value["function"]["name"].as_str() {
                                if !self.mistral || call.name != name {
                                    call.name.push_str(name);
                                }
                            }
                            let arguments = value["function"].get("arguments");
                            let object_arguments = if self.mistral {
                                arguments.filter(|v| v.is_object()).map(Value::to_string)
                            } else {
                                None
                            };
                            if let Some(fragment) = arguments
                                .and_then(Value::as_str)
                                .or(object_arguments.as_deref())
                            {
                                call.arguments.push_str(fragment);
                                if let Some(id) = &call.id {
                                    emit_event(
                                        emit,
                                        ProviderEvent::ToolArgumentsDelta {
                                            call_id: id.clone(),
                                            delta: fragment.into(),
                                        },
                                    )?;
                                }
                            }
                        }
                    }
                    _ if value.is_null() => {}
                    _ => {
                        return Err(failure(
                            "unsupported_content_delta",
                            "Chat extension requires an explicit compatibility adapter",
                        ))
                    }
                }
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                self.finish = Some(match reason {
                    "stop" => FinishReason::Stop,
                    "tool_calls" => FinishReason::ToolCalls,
                    "length" => FinishReason::Length,
                    "model_length" if self.mistral => FinishReason::Length,
                    "error" if self.mistral => {
                        return Err(failure(
                            "provider_error",
                            "Mistral reported generation failure",
                        ))
                    }
                    "content_filter" => FinishReason::ContentFilter,
                    _ => {
                        return Err(failure(
                            "unsupported_stop_reason",
                            "unknown Chat finish reason",
                        ))
                    }
                });
            }
        }
        Ok(false)
    }
}
