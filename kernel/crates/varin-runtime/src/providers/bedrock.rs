//! Bedrock ConverseStream over AWS binary eventstream, with dispatch-bound bearer or SigV4 auth.
use super::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
pub const FAMILY: &str = "bedrock-converse-stream";
pub struct BedrockProvider {
    pub connection: Connection,
    pub max_output_tokens: Option<u64>,
}
impl BedrockProvider {
    /// The trusted factory supplies the complete /model/{encoded-model-id}/converse-stream URL.
    pub fn new(connection: Connection) -> Self {
        Self {
            connection,
            max_output_tokens: None,
        }
    }
}
fn tool_id(id: &str) -> String {
    if !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        id.into()
    } else {
        hex::encode(Sha256::digest(id.as_bytes()))
    }
}
fn bedrock_parts(parts: Vec<ProviderPart<'_>>) -> Result<Vec<Value>, ExecutionError> {
    let mut blocks = Vec::new();
    for part in parts {
        match part {
            ProviderPart::Text { text } => {
                let mut block = json!({});
                block["text"] = Value::String(text.into_owned());
                blocks.push(block);
            }
            ProviderPart::Media { media } => {
                let format = match media.media_type.as_str() {
                    "image/png" => "png",
                    "image/jpeg" => "jpeg",
                    "image/gif" => "gif",
                    "image/webp" => "webp",
                    _ => {
                        return Err(ExecutionError::new(
                            "unsupported_media",
                            "Bedrock media type is unsupported",
                        ));
                    }
                };
                blocks.push(json!({"text":media_label(media)}));
                blocks
                    .push(json!({"image":{"format":format,"source":{"bytes":media.data_base64}}}));
            }
        }
    }
    Ok(blocks)
}
fn bedrock_blocks(
    items: &[ProjectedHistoryItem<'_>],
    model: &str,
) -> Result<Vec<Value>, ExecutionError> {
    let mut blocks = Vec::new();
    for projected in items {
        let item = projected.item;
        if let Some(original) = projected.opaque {
            if original.value["model"] == model {
                let block = original
                    .value
                    .get("block")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| {
                        ExecutionError::new(
                            "invalid_opaque",
                            "Bedrock continuation lacks its original block",
                        )
                    })?;
                blocks.push(block.clone());
                continue;
            }
        }
        match &item.content {
            Content::Text { text } | Content::ReasoningSummary { text } => blocks.push(json!({"text":text})),
            Content::ToolCall { call } => blocks.push(json!({"toolUse":{"toolUseId":tool_id(&call.call_id),"name":call.name,"input":call.arguments}})),
            Content::ToolResult { result } => {
                let success = matches!(&result.completion, ToolCompletion::Result { outcome: crate::types::Outcome::Succeeded, .. } | ToolCompletion::JobAccepted { .. });
                let mut block = json!({"toolResult":{"toolUseId":tool_id(&result.call_id),"status":if success{"success"}else{"error"}}});
                block["toolResult"]["content"] = Value::Array(bedrock_parts(completion_parts(&result.completion))?);
                blocks.push(block);
            }
            Content::Media { media } => blocks.extend(bedrock_parts(vec![ProviderPart::Media { media }])?),
            Content::Output { output } => blocks.extend(bedrock_parts(evidence_parts(output, &item.provenance))?),
            Content::ProviderOnly => {}
        }
    }
    Ok(blocks)
}
impl ModelProvider for BedrockProvider {
    fn request_budget_protocol(&self) -> Option<crate::context_capacity::RequestBudgetProtocol> {
        Some(crate::context_capacity::RequestBudgetProtocol {
            transcript: &["messages"],
            coalesced_content: Some("content"),
            complete_input_tokens: bedrock_input_tokens,
        })
    }

    fn serialize(
        &self,
        view: &RequestView,
        mut reuse: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        validate_view(view, FAMILY)?;
        let input = model_input(view, &self.connection, reuse.as_deref_mut());
        let view = input.as_ref();
        let (system, groups) = groups::group_history(
            project_history(&view.history, FAMILY, &view.binding.connection_identity),
            |projected| {
                if let Some(original) = projected.opaque {
                    if original.adapter_version != "1" {
                        return Err(ExecutionError::new(
                            "opaque_version",
                            "unsupported Bedrock continuation version",
                        ));
                    }
                    if original.value["model"] == view.binding.model {
                        return Ok(Some("assistant"));
                    }
                }
                let item = projected.item;
                let role = if item.provenance.is_assistant() {
                    "assistant"
                } else {
                    "user"
                };
                Ok(match &item.content {
                    Content::Text { text } | Content::ReasoningSummary { text } => {
                        if item.provenance.is_system() {
                            Some("system")
                        } else if text.is_empty() {
                            None
                        } else {
                            Some(role)
                        }
                    }
                    Content::ToolCall { .. } => Some("assistant"),
                    Content::ToolResult { .. } | Content::Media { .. } => Some("user"),
                    Content::Output { output }
                        if output.parts.is_empty()
                            && matches!(item.provenance, Provenance::Sampling { .. }) =>
                    {
                        None
                    }
                    Content::Output { .. } => Some(evidence_role(&item.provenance, role)),
                    Content::ProviderOnly => None,
                })
            },
        )?;
        let mut compiler = groups::GroupCompiler::new(reuse.as_deref_mut());
        let mut messages = Vec::new();
        for (role, items) in groups {
            messages.push(compiler.group(role, &items, || {
                Ok(json!({"role":role,"content":bedrock_blocks(&items, &view.binding.model)?}))
            })?);
        }
        let mut body = RequestBody::from(json!({}));
        body.insert_fragments("messages", messages);
        if !system.is_empty() {
            body.insert_frozen(
                "system",
                compiler.group("system", &system, || {
                    Ok(Value::Array(bedrock_blocks(&system, &view.binding.model)?))
                })?,
            );
        }
        if let Some(max) = self.max_output_tokens {
            body.insert("inferenceConfig", json!({"maxTokens":max}));
        }
        if !view.binding.tools.is_empty() {
            body.insert_frozen("toolConfig", compiler.field("toolConfig", || {
                json!({"tools":view.binding.tools.iter().map(|t|json!({"toolSpec":{"name":t.name,"description":t.description,"inputSchema":{"json":t.schema}}})).collect::<Vec<_>>()})
            }));
        }
        compiler.finish(reuse);
        Ok(body)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "generation cancelled"));
        }
        let dispatch = CredentialDispatch {
            method: "POST".into(),
            endpoint: self.connection.endpoint.clone(),
            payload_sha256: hex::encode(Sha256::digest(request.serialized.wire_bytes())),
        };
        let headers = self.connection.credentials.request_headers(
            request.view.binding.credential_ref.as_deref(),
            &dispatch,
            cancel,
        )?;
        if !headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split_once(' ').is_some_and(|(scheme, token)| {
                    (scheme.eq_ignore_ascii_case("bearer") || scheme == "AWS4-HMAC-SHA256")
                        && !token.trim().is_empty()
                })
            })
        {
            return Err(failure(
                "bedrock_authentication_required",
                "Bedrock binding requires bearer or request-bound AWS authentication",
            ));
        }
        let mut decoder = super::aws_eventstream::Decoder::new(self.connection.max_event_bytes);
        let mut state = StreamState::default();
        self.connection.transport.stream_eventstream(
            HttpRequest {
                endpoint: &self.connection.endpoint,
                headers,
                body: &request.serialized,
            },
            cancel,
            &mut |bytes| {
                decoder.feed(bytes, &mut |kind, value| {
                    state.event(kind, value, &request.view, emit)
                })?;
                Ok(false)
            },
        )?;
        decoder.finish()?;
        state.finish.ok_or_else(|| {
            failure(
                "stream_interrupted",
                "Bedrock stream ended before messageStop",
            )
        })
    }
}
#[derive(Default)]
struct StreamState {
    started: bool,
    finish: Option<FinishReason>,
    blocks: BTreeMap<u64, Block>,
    stopped: BTreeSet<u64>,
    tool_ids: BTreeSet<String>,
}
enum Block {
    Text(String),
    Tool {
        id: String,
        name: String,
        input: String,
    },
    Reasoning {
        text: String,
        signature: String,
        redacted: Vec<u8>,
    },
}
impl StreamState {
    fn event(
        &mut self,
        kind: &str,
        value: Value,
        view: &RequestView,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<(), ModelFailure> {
        if kind == "metadata" {
            if !self.started {
                return Err(invalid());
            }
            if let Some(usage) = value.get("usage") {
                emit_event(
                    emit,
                    ProviderEvent::Usage {
                        receipt: UsageReceipt {
                            measurement: UsageMeasurement::Actual,
                            input_tokens: usage["inputTokens"].as_u64(),
                            output_tokens: usage["outputTokens"].as_u64(),
                            cached_input_tokens: usage["cacheReadInputTokens"].as_u64(),
                            cache_write_tokens: usage["cacheWriteInputTokens"].as_u64(),
                            raw: Some(usage.clone()),
                            ..Default::default()
                        },
                    },
                )?;
            }
            return Ok(());
        }
        if self.finish.is_some() {
            return Err(invalid());
        }
        if kind == "messageStart" {
            if self.started || value["role"] != "assistant" {
                return Err(invalid());
            }
            self.started = true;
            return Ok(());
        }
        if !self.started {
            return Err(invalid());
        }
        match kind {
            "contentBlockStart" => {
                let index = index(&value)?;
                if self.blocks.contains_key(&index) || self.stopped.contains(&index) {
                    return Err(invalid());
                }
                let start = &value["start"];
                if let Some(tool) = start.get("toolUse") {
                    let id = required(tool, "toolUseId")?.to_owned();
                    let name = required(tool, "name")?.to_owned();
                    if !self.tool_ids.insert(id.clone()) {
                        return Err(invalid());
                    }
                    emit_event(emit, ProviderEvent::ToolCallStarted { call_id: id.clone(), name: name.clone(), request_id: view.request_id.clone() })?;
                    self.blocks.insert(
                        index,
                        Block::Tool {
                            id,
                            name,
                            input: String::new(),
                        },
                    );
                } else {
                    return Err(failure(
                        "unsupported_bedrock_block",
                        "unsupported Bedrock content block start",
                    ));
                }
            }
            "contentBlockDelta" => {
                let index = index(&value)?;
                if self.stopped.contains(&index) {
                    return Err(invalid());
                }
                let delta = &value["delta"];
                if delta.as_object().is_none_or(|value| value.len() != 1) {
                    return Err(invalid());
                }
                if let Some(text) = delta.get("text").and_then(Value::as_str) {
                    let block = self
                        .blocks
                        .entry(index)
                        .or_insert_with(|| Block::Text(String::new()));
                    if let Block::Text(full) = block {
                        full.push_str(text);
                    } else {
                        return Err(invalid());
                    }
                    emit_event(
                        emit,
                        ProviderEvent::TextDelta {
                            item_id: format!("bedrock-{index}"),
                            text: text.into(),
                        },
                    )?;
                } else if let Some(tool) = delta.get("toolUse") {
                    let text = tool
                        .get("input")
                        .and_then(Value::as_str)
                        .ok_or_else(invalid)?;
                    if let Some(Block::Tool { id, input, .. }) = self.blocks.get_mut(&index) {
                        input.push_str(text);
                        emit_event(
                            emit,
                            ProviderEvent::ToolArgumentsDelta {
                                call_id: id.clone(),
                                delta: text.into(),
                            },
                        )?;
                    } else {
                        return Err(invalid());
                    }
                } else if let Some(reasoning) = delta.get("reasoningContent") {
                    if reasoning.as_object().is_none_or(|value| value.len() != 1) {
                        return Err(invalid());
                    }
                    let block = self
                        .blocks
                        .entry(index)
                        .or_insert_with(|| Block::Reasoning {
                            text: String::new(),
                            signature: String::new(),
                            redacted: Vec::new(),
                        });
                    let Block::Reasoning {
                        text,
                        signature,
                        redacted,
                    } = block
                    else {
                        return Err(invalid());
                    };
                    if let Some(part) = reasoning.get("text").and_then(Value::as_str) {
                        if !redacted.is_empty() {
                            return Err(invalid());
                        }
                        text.push_str(part);
                    } else if let Some(part) = reasoning.get("signature").and_then(Value::as_str) {
                        if !redacted.is_empty() {
                            return Err(invalid());
                        }
                        signature.push_str(part);
                    } else if let Some(part) =
                        reasoning.get("redactedContent").and_then(Value::as_str)
                    {
                        if !text.is_empty() || !signature.is_empty() {
                            return Err(invalid());
                        }
                        redacted.extend(BASE64.decode(part).map_err(|_| invalid())?);
                    } else {
                        return Err(invalid());
                    }
                } else {
                    return Err(failure(
                        "unsupported_bedrock_delta",
                        "unsupported Bedrock content block delta",
                    ));
                }
            }
            "contentBlockStop" => {
                let index = index(&value)?;
                if !self.blocks.contains_key(&index) || !self.stopped.insert(index) {
                    return Err(invalid());
                }
            }
            "messageStop" => {
                let finish = match required(&value, "stopReason")? {
                    "end_turn" | "stop_sequence" => FinishReason::Stop,
                    "max_tokens" | "model_context_window_exceeded" => FinishReason::Length,
                    "tool_use" => FinishReason::ToolCalls,
                    "guardrail_intervened" | "content_filtered" => FinishReason::ContentFilter,
                    _ => {
                        return Err(failure(
                            "unsupported_bedrock_stop",
                            "Bedrock returned an unsupported stop reason",
                        ));
                    }
                };
                for (index, block) in std::mem::take(&mut self.blocks) {
                    let (content, raw) = match block {
                        Block::Text(text) => {
                            (Content::Text { text: text.clone() }, json!({"text":text}))
                        }
                        Block::Tool { id, name, input } => {
                            let arguments: Value =
                                serde_json::from_str(if input.is_empty() { "{}" } else { &input })
                                    .map_err(|_| {
                                        failure(
                                            "invalid_tool_arguments",
                                            "Bedrock tool arguments are incomplete JSON",
                                        )
                                    })?;
                            if !arguments.is_object() {
                                return Err(failure(
                                    "invalid_tool_arguments",
                                    "Bedrock tool arguments must be an object",
                                ));
                            }
                            let call = ToolCall {
                                call_id: id.clone(),
                                name: name.clone(),
                                arguments: arguments.clone(),
                                schema_version: schema_version(view, &name)?,
                            };
                            (
                                Content::ToolCall { call },
                                json!({"toolUse":{"toolUseId":id,"name":name,"input":arguments}}),
                            )
                        }
                        Block::Reasoning {
                            text,
                            signature,
                            redacted,
                        } => {
                            let raw = if !redacted.is_empty() {
                                json!({"reasoningContent":{"redactedContent":BASE64.encode(redacted)}})
                            } else {
                                json!({"reasoningContent":{"reasoningText":{"text":text,"signature":signature}}})
                            };
                            (Content::ProviderOnly, raw)
                        }
                    };
                    emit_event(
                        emit,
                        ProviderEvent::ItemCompleted {
                            item: ProviderItem {
                                id: format!("bedrock-{index}"),
                                content,
                                opaque: opaque(
                                    view,
                                    json!({"model":view.binding.model,"block":raw}),
                                ),
                            },
                        },
                    )?;
                }
                self.finish = Some(finish);
            }
            _ => {
                return Err(failure(
                    "unsupported_bedrock_event",
                    "unsupported Bedrock stream event",
                ));
            }
        }
        Ok(())
    }
}
fn index(value: &Value) -> Result<u64, ModelFailure> {
    value["contentBlockIndex"].as_u64().ok_or_else(invalid)
}
fn invalid() -> ModelFailure {
    failure(
        "invalid_bedrock_event",
        "Bedrock stream event violates message/block ordering",
    )
}
