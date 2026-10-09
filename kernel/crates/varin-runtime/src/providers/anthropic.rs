use super::*;
use serde_json::json;
use std::collections::BTreeMap;
pub const FAMILY: &str = "anthropic-messages";
pub struct AnthropicProvider {
    pub connection: Connection,
    pub max_tokens: u64,
    pub thinking: Option<Value>,
    pub oauth: bool,
}
impl AnthropicProvider {
    pub fn new(connection: Connection, max_tokens: u64) -> Self {
        Self {
            connection,
            max_tokens,
            thinking: None,
            oauth: false,
        }
    }
}
// Locked Pi Messages adapter's Claude subscription tool naming contract.
fn oauth_tool_name(name: &str) -> &str {
    const NAMES: &[&str] = &["Read", "Write", "Edit", "Bash", "Grep", "Glob", "AskUserQuestion",
        "EnterPlanMode", "ExitPlanMode", "KillShell", "NotebookEdit", "Skill", "Task", "TaskOutput",
        "TodoWrite", "WebFetch", "WebSearch"];
    NAMES.iter().copied().find(|candidate| candidate.eq_ignore_ascii_case(name)).unwrap_or(name)
}
fn registered_tool_name<'a>(name: &'a str, view: &'a RequestView, oauth: bool) -> &'a str {
    if oauth {
        view.binding.tools.iter().find(|tool| tool.name.eq_ignore_ascii_case(name))
            .map(|tool| tool.name.as_str()).unwrap_or(name)
    } else { name }
}
fn push_block(messages: &mut Vec<Value>, role: &str, block: Value) {
    if let Some(last) = messages.last_mut().filter(|m| m["role"] == role) {
        last["content"]
            .as_array_mut()
            .expect("constructed array")
            .push(block);
    } else {
        messages.push(json!({"role":role,"content":[block]}));
    }
}
impl ModelProvider for AnthropicProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        validate_view(view, FAMILY)?;
        validate_images(view, &self.connection)?;
        if self.max_tokens == 0 {
            return Err(ExecutionError::new(
                "invalid_max_tokens",
                "Anthropic requires a positive output token budget",
            ));
        }
        let mut messages = Vec::new();
        let mut system = Vec::new();
        if self.oauth {
            system.push(json!({"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}));
        }
        for item in compile_history(&view.history, FAMILY, &view.binding.connection_identity) {
            if let Some(original) = item.opaque {
                if original.adapter_version != "1" {
                    return Err(ExecutionError::new(
                        "opaque_version",
                        "unsupported Anthropic continuation version",
                    ));
                }
                push_block(&mut messages, "assistant", original.value);
                continue;
            }
            let role = if matches!(item.provenance, Provenance::Assistant) {
                "assistant"
            } else {
                "user"
            };
            let block = match item.content {
                Content::Text { text } | Content::ReasoningSummary { text } => {
                    let block = json!({"type":"text","text":text});
                    if matches!(item.provenance, Provenance::SystemInstruction { .. }) {
                        system.push(block);
                        continue;
                    }
                    block
                }
                Content::ToolCall { call } => {
                    json!({"type":"tool_use","id":call.call_id,"name":if self.oauth { oauth_tool_name(&call.name) } else { &call.name },"input":call.arguments})
                }
                Content::ToolResult { result } => {
                    json!({"type":"tool_result","tool_use_id":result.call_id,"content":serde_json::to_string(&result.completion).map_err(|_|ExecutionError::new("serialize","invalid tool result"))?,"is_error":matches!(result.completion,ToolCompletion::Result{outcome:crate::types::Outcome::Failed|crate::types::Outcome::Cancelled|crate::types::Outcome::Indeterminate,..})})
                }
                Content::Attachment {
                    media_type,
                    content_ref,
                    ..
                } => {
                    let kind = if media_type.starts_with("image/") {
                        "image"
                    } else if media_type == "application/pdf" {
                        "document"
                    } else {
                        return Err(ExecutionError::new(
                            "unsupported_attachment",
                            "Anthropic attachment type is unsupported",
                        ));
                    };
                    let source = if content_ref.starts_with("https://") {
                        json!({"type":"url","url":content_ref})
                    } else if let Some(data) =
                        content_ref.strip_prefix(&format!("data:{media_type};base64,"))
                    {
                        json!({"type":"base64","media_type":media_type,"data":data})
                    } else {
                        return Err(ExecutionError::new(
                            "unsupported_attachment",
                            "resolve local attachment references before request compilation",
                        ));
                    };
                    json!({"type":kind,"source":source})
                }
                Content::ProviderOnly => {
                    return Err(ExecutionError::new(
                        "missing_opaque",
                        "provider-only item has no original",
                    ))
                }
            };
            push_block(&mut messages, role, block);
        }
        let tools: Vec<_> = view
            .binding
            .tools
            .iter()
            .map(|t| json!({"name":if self.oauth { oauth_tool_name(&t.name) } else { &t.name },"input_schema":t.schema}))
            .collect();
        let mut result = json!({"model":view.binding.model,"messages":messages,"system":system,"tools":tools,"max_tokens":self.max_tokens,"stream":true});
        if let Some(thinking) = &self.thinking {
            result["thinking"] = thinking.clone();
        }
        Ok(result)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        if request.view.binding.provider_family != FAMILY {
            return Err(failure("provider_family_mismatch", "wrong adapter family"));
        }
        let mut state = StreamState { oauth: self.oauth, ..Default::default() };
        self.connection.run(
            request,
            cancel,
            &[("anthropic-version", "2023-06-01")],
            &mut |event| state.event(event, &request.view, emit),
        )?;
        if !state.stopped {
            return Err(failure(
                "stream_interrupted",
                "Anthropic stream ended before message_stop",
            ));
        }
        state
            .finish
            .ok_or_else(|| failure("missing_stop_reason", "Anthropic omitted stop reason"))
    }
}
struct Block {
    value: Value,
    arguments: String,
}
#[derive(Default)]
struct StreamState {
    oauth: bool,
    id: Option<String>,
    blocks: BTreeMap<u64, Block>,
    finish: Option<FinishReason>,
    stopped: bool,
    usage: UsageReceipt,
    seen: std::collections::BTreeSet<u64>,
}
impl StreamState {
    fn usage(
        &mut self,
        value: &Value,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<(), ModelFailure> {
        if !value.is_object() {
            return Ok(());
        }
        self.usage.measurement = UsageMeasurement::Actual;
        let raw = self.usage.raw.get_or_insert_with(|| json!({}));
        for (key, value) in value.as_object().expect("checked object") {
            raw[key] = value.clone();
        }
        if let Some(n) = value["cache_creation_input_tokens"].as_u64() {
            self.usage.cache_write_tokens = Some(n);
        }
        if let Some(n) = value["input_tokens"].as_u64() {
            self.usage.input_tokens = Some(n);
        }
        if let Some(n) = value["output_tokens"].as_u64() {
            self.usage.output_tokens = Some(n);
        }
        if let Some(n) = value["cache_read_input_tokens"].as_u64() {
            self.usage.cached_input_tokens = Some(n);
        }
        emit_event(
            emit,
            ProviderEvent::Usage {
                receipt: self.usage.clone(),
            },
        )
    }
    fn event(
        &mut self,
        event: Value,
        view: &RequestView,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<bool, ModelFailure> {
        let kind = required(&event, "type")?;
        if kind != "message_start" && kind != "ping" && kind != "error" && self.id.is_none() {
            return Err(failure(
                "invalid_event_order",
                "Anthropic event precedes message_start",
            ));
        }
        match kind {
            "message_start" => {
                if self.id.is_some() {
                    return Err(failure("invalid_event_order", "duplicate message_start"));
                }
                self.id = Some(required(&event["message"], "id")?.into());
                self.usage(&event["message"]["usage"], emit)?;
            }
            "content_block_start" => {
                let index = index(&event)?;
                if !self.blocks.is_empty()
                    || index != self.seen.len() as u64
                    || !self.seen.insert(index)
                {
                    return Err(failure(
                        "invalid_event_order",
                        "duplicate content block index",
                    ));
                }
                let value = event["content_block"].clone();
                required(&value, "type")?;
                self.blocks.insert(
                    index,
                    Block {
                        value,
                        arguments: String::new(),
                    },
                );
            }
            "content_block_delta" => {
                let index = index(&event)?;
                let block = self
                    .blocks
                    .get_mut(&index)
                    .ok_or_else(|| failure("invalid_event_order", "delta outside an open block"))?;
                let delta = &event["delta"];
                match required(delta, "type")? {
                    "text_delta" => {
                        ensure_block(&block.value, &["text"])?;
                        let text = delta["text"].as_str().ok_or_else(|| {
                            failure("invalid_provider_event", "text delta missing")
                        })?;
                        append(&mut block.value, "text", text)?;
                        emit_event(
                            emit,
                            ProviderEvent::TextDelta {
                                item_id: format!("{}:{index}", self.id.as_ref().unwrap()),
                                text: text.into(),
                            },
                        )?;
                    }
                    "input_json_delta" => {
                        ensure_block(&block.value, &["tool_use", "server_tool_use"])?;
                        let fragment = delta["partial_json"].as_str().ok_or_else(|| {
                            failure("invalid_provider_event", "tool delta missing")
                        })?;
                        block.arguments.push_str(fragment);
                        // Server tool exchanges stay opaque; never dispatch them as client tools.
                        if block.value["type"] == "tool_use" {
                            emit_event(
                                emit,
                                ProviderEvent::ToolArgumentsDelta {
                                    call_id: required(&block.value, "id")?.into(),
                                    delta: fragment.into(),
                                },
                            )?;
                        }
                    }
                    "thinking_delta" => {
                        ensure_block(&block.value, &["thinking"])?;
                        append(
                            &mut block.value,
                            "thinking",
                            delta["thinking"].as_str().ok_or_else(|| {
                                failure("invalid_provider_event", "thinking delta missing")
                            })?,
                        )?;
                    }
                    "signature_delta" => {
                        ensure_block(&block.value, &["thinking"])?;
                        append(
                            &mut block.value,
                            "signature",
                            delta["signature"].as_str().ok_or_else(|| {
                                failure("invalid_provider_event", "signature delta missing")
                            })?,
                        )?;
                    }
                    "citations_delta" => {
                        ensure_block(&block.value, &["text"])?;
                        if block.value.get("citations").is_none() {
                            block.value["citations"] = json!([]);
                        }
                        block.value["citations"]
                            .as_array_mut()
                            .ok_or_else(|| {
                                failure("invalid_provider_event", "invalid citation list")
                            })?
                            .push(delta["citation"].clone());
                    }
                    _ => {
                        return Err(failure(
                            "unsupported_content_delta",
                            "cannot losslessly preserve this new content delta",
                        ))
                    }
                }
            }
            "content_block_stop" => {
                let index = index(&event)?;
                let mut block = self
                    .blocks
                    .remove(&index)
                    .ok_or_else(|| failure("invalid_event_order", "stop outside an open block"))?;
                if !block.arguments.is_empty() {
                    block.value["input"] =
                        serde_json::from_str(&block.arguments).map_err(|_| {
                            failure(
                                "invalid_tool_arguments",
                                "completed arguments are invalid JSON",
                            )
                        })?;
                }
                let content = match required(&block.value, "type")? {
                    "tool_use" => {
                        let name = registered_tool_name(required(&block.value, "name")?, view, self.oauth);
                        if !block.value["input"].is_object() {
                            return Err(failure(
                                "invalid_tool_arguments",
                                "tool arguments must be an object",
                            ));
                        }
                        Content::ToolCall {
                            call: ToolCall {
                                call_id: required(&block.value, "id")?.into(),
                                name: name.into(),
                                schema_version: schema_version(view, name)?,
                                arguments: block.value["input"].clone(),
                            },
                        }
                    }
                    "text" => Content::Text {
                        text: block.value["text"]
                            .as_str()
                            .ok_or_else(|| {
                                failure("invalid_provider_item", "text block missing text")
                            })?
                            .into(),
                    },
                    _ => Content::ProviderOnly,
                };
                emit_event(
                    emit,
                    ProviderEvent::ItemCompleted {
                        item: ProviderItem {
                            id: format!("{}:{index}", self.id.as_ref().unwrap()),
                            content,
                            opaque: opaque(view, block.value),
                        },
                    },
                )?;
            }
            "message_delta" => {
                self.usage(&event["usage"], emit)?;
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.finish = Some(match reason {
                        "end_turn" | "stop_sequence" => FinishReason::Stop,
                        "tool_use" => FinishReason::ToolCalls,
                        "max_tokens" | "model_context_window_exceeded" => FinishReason::Length,
                        "refusal" => FinishReason::ContentFilter,
                        _ => {
                            return Err(failure(
                                "unsupported_stop_reason",
                                "provider continuation requires explicit orchestration support",
                            ))
                        }
                    });
                }
            }
            "message_stop" => {
                if !self.blocks.is_empty() {
                    return Err(failure(
                        "incomplete_content_blocks",
                        "message stopped with unfinished blocks",
                    ));
                }
                self.stopped = true;
                return Ok(true);
            }
            "error" => return Err(provider_failure(&event["error"], "provider_error")),
            _ => {}
        }
        Ok(false)
    }
}
fn index(event: &Value) -> Result<u64, ModelFailure> {
    event["index"]
        .as_u64()
        .ok_or_else(|| failure("invalid_provider_event", "content block index missing"))
}
fn append(value: &mut Value, key: &str, text: &str) -> Result<(), ModelFailure> {
    if value.get(key).is_none() {
        value[key] = json!("");
    }
    let current = value[key]
        .as_str()
        .ok_or_else(|| failure("invalid_provider_event", "invalid streamed content field"))?;
    let mut combined = current.to_owned();
    combined.push_str(text);
    value[key] = json!(combined);
    Ok(())
}

fn ensure_block(value: &Value, allowed: &[&str]) -> Result<(), ModelFailure> {
    if value["type"]
        .as_str()
        .is_some_and(|kind| allowed.contains(&kind))
    {
        Ok(())
    } else {
        Err(failure(
            "invalid_content_delta",
            "delta does not match its content block type",
        ))
    }
}
