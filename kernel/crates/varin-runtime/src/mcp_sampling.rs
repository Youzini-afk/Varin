//! Isolated, reviewed server sampling. The original Catalog Operation owns generation facts.
use crate::execution::*;
use crate::{OperationPhase, Outcome};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpSamplingState {
    pub generation_operation_id: Option<String>,
    pub review: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SamplingModel {
    pub provider_id: Option<String>,
    pub provider_family: String,
    pub model: String,
    pub max_tokens: u64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SamplingUsage {
    pub measurement: UsageMeasurement,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub pricing_version: Option<String>,
}
impl From<&UsageReceipt> for SamplingUsage {
    fn from(r: &UsageReceipt) -> Self {
        Self {
            measurement: r.measurement,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cached_input_tokens: r.cached_input_tokens,
            cache_write_tokens: r.cache_write_tokens,
            reasoning_tokens: r.reasoning_tokens,
            pricing_version: r.pricing_version.clone(),
        }
    }
}
impl From<&SamplingUsage> for UsageReceipt {
    fn from(r: &SamplingUsage) -> Self {
        Self {
            measurement: r.measurement,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cached_input_tokens: r.cached_input_tokens,
            cache_write_tokens: r.cache_write_tokens,
            reasoning_tokens: r.reasoning_tokens,
            pricing_version: r.pricing_version.clone(),
            // Provider raw usage stays with the original checkpoint body, outside control.
            raw: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpSamplingGeneration {
    pub operation_id: String,
    pub phase: OperationPhase,
    pub outcome: Option<Outcome>,
    pub cancel_requested: bool,
    pub dispatch: String,
    pub model: Option<SamplingModel>,
    pub usage: SamplingUsage,
    pub problem: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSamplingBodies {
    pub edited_request: Option<Value>,
    pub output: Option<Value>,
    pub provider_output: Option<Value>,
    pub receipt: Option<Value>,
    pub snapshot: Option<Value>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SamplingOutput {
    pub events: Vec<ProviderEvent>,
    pub items: Vec<ProviderItem>,
    pub usage: UsageReceipt,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SamplingReceipt {
    pub finish_reason: Option<FinishReason>,
    pub failure: Option<ModelFailure>,
    pub usage: UsageReceipt,
    pub provider_completed: bool,
    pub local_executor_stopped: bool,
    pub usable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SamplingRequest {
    pub messages: Vec<SamplingMessage>,
    pub max_tokens: u64,
    pub system_prompt: Option<String>,
    pub temperature: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
    pub model_preferences: Option<Value>,
    pub include_context: Option<String>,
    pub metadata: Option<Value>,
    #[serde(rename = "_meta")]
    pub meta: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SamplingMessage {
    pub role: SamplingRole,
    pub content: Value,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SamplingRole {
    System,
    User,
    Assistant,
}
fn invalid(code: &str, message: &str) -> ExecutionError {
    ExecutionError::new(code, message)
}
pub fn decode_request(value: &Value) -> Result<SamplingRequest, ExecutionError> {
    if value.get("tools").is_some() || value.get("toolChoice").is_some() {
        return Err(invalid(
            "mcp_sampling_tools_unsupported",
            "Sampling tools are not supported; remove tools and toolChoice",
        ));
    }
    if value.get("task").is_some() {
        return Err(invalid(
            "mcp_sampling_task_unsupported",
            "Task-augmented sampling is not supported",
        ));
    }
    let request: SamplingRequest = serde_json::from_value(value.clone()).map_err(|_| {
        invalid(
            "mcp_sampling_request_invalid",
            "Sampling request fields or messages are invalid",
        )
    })?;
    if request.max_tokens == 0 || request.temperature.is_some_and(|t| !t.is_finite()) {
        return Err(invalid(
            "mcp_sampling_request_invalid",
            "Provide messages, a positive maxTokens and finite temperature",
        ));
    }
    if request
        .include_context
        .as_deref()
        .is_some_and(|c| c != "none")
    {
        return Err(invalid(
            "mcp_sampling_context_unsupported",
            "Sampling cannot include main conversation or server context; select none",
        ));
    }
    if request.metadata.is_some() {
        return Err(invalid(
            "mcp_sampling_metadata_unsupported",
            "Provider metadata is not supported for sampling; remove metadata",
        ));
    }
    if request.meta.as_ref().is_some_and(|v| !v.is_object()) {
        return Err(invalid(
            "mcp_sampling_request_invalid",
            "Sampling _meta must be an object",
        ));
    }
    if let Some(p) = &request.model_preferences {
        let o = p.as_object().ok_or_else(|| {
            invalid(
                "mcp_sampling_request_invalid",
                "Model preferences must be an object",
            )
        })?;
        for (key, v) in o {
            match key.as_str() {
                "hints" => {
                    if !v.as_array().is_some_and(|a| {
                        a.iter().all(|h| {
                            h.as_object().is_some_and(|o| {
                                o.keys().all(|k| k == "name")
                                    && o.get("name").is_none_or(Value::is_string)
                            })
                        })
                    }) {
                        return Err(invalid(
                            "mcp_sampling_request_invalid",
                            "Model hints are invalid",
                        ));
                    }
                }
                "costPriority" | "speedPriority" | "intelligencePriority" => {
                    if !v.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)) {
                        return Err(invalid(
                            "mcp_sampling_request_invalid",
                            "Model priorities must be between zero and one",
                        ));
                    }
                }
                _ => {
                    return Err(invalid(
                        "mcp_sampling_request_invalid",
                        "Unknown model preference",
                    ));
                }
            }
        }
    }
    for message in &request.messages {
        if message.role == SamplingRole::System {
            return Err(invalid(
                "mcp_sampling_request_invalid",
                "Message role must be user or assistant; use systemPrompt for system text",
            ));
        }
        for block in blocks(&message.content)? {
            validate_block(block)?;
        }
    }
    Ok(request)
}
fn blocks(content: &Value) -> Result<Vec<&Value>, ExecutionError> {
    if let Some(a) = content.as_array() {
        Ok(a.iter().collect())
    } else if content.is_object() {
        Ok(vec![content])
    } else {
        Err(invalid(
            "mcp_sampling_request_invalid",
            "Content must be a block or block array",
        ))
    }
}
fn validate_block(block: &Value) -> Result<(), ExecutionError> {
    let object = block
        .as_object()
        .ok_or_else(|| invalid("mcp_sampling_request_invalid", "Invalid content block"))?;
    match block["type"].as_str() {
        Some("text") if block["text"].is_string() => {}
        Some("image") if block["data"].is_string() && block["mimeType"].is_string() => {
            IncomingMedia {
                media_type: block["mimeType"].as_str().unwrap().into(),
                data_base64: block["data"].as_str().unwrap().into(),
            }
            .admit(OutputSource::Operation {
                operation_id: "validation".into(),
            })
            .map_err(|_| {
                invalid(
                    "mcp_sampling_media_invalid",
                    "Image MIME or encoded bytes are invalid",
                )
            })?;
        }
        Some("audio") => {
            return Err(invalid(
                "mcp_sampling_audio_unsupported",
                "The native sampling adapters do not support audio input; remove audio or use text",
            ));
        }
        Some("tool_use" | "tool_result") => {
            return Err(invalid(
                "mcp_sampling_tools_unsupported",
                "Sampling tools are not supported",
            ));
        }
        _ => {
            return Err(invalid(
                "mcp_sampling_request_invalid",
                "Unsupported sampling content block",
            ));
        }
    }
    let allowed = match block["type"].as_str() {
        Some("text") => &["type", "text", "annotations", "_meta"][..],
        _ => &["type", "data", "mimeType", "annotations", "_meta"][..],
    };
    if object.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(invalid(
            "mcp_sampling_request_invalid",
            "Unknown sampling content field",
        ));
    }
    Ok(())
}
/// Apply reviewed portable parameters through the original adapter's typed configuration.
pub fn configure(
    mut configuration: crate::types::ModelSessionConfiguration,
    request: &SamplingRequest,
) -> Result<crate::types::ModelSessionConfiguration, ExecutionError> {
    if configuration.provider_family == crate::providers::codex::FAMILY {
        return Err(invalid(
            "mcp_sampling_token_limit_unsupported",
            "This Codex adapter cannot enforce sampling maxTokens; select another model",
        ));
    }
    configuration.max_output_tokens = Some(
        configuration
            .max_output_tokens
            .unwrap_or(request.max_tokens)
            .min(request.max_tokens),
    );
    let options = configuration
        .model_options
        .get_or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| invalid("model_options", "Model options are invalid"))?;
    if let Some(t) = request.temperature {
        options.insert("temperature".into(), json!(t));
        if let Some(parameters) = options
            .get_mut("samplingParams")
            .and_then(Value::as_object_mut)
        {
            parameters.remove("temperature");
        }
    }
    if let Some(stops) = &request.stop_sequences {
        options.insert("stopSequences".into(), json!(stops));
        if let Some(parameters) = options
            .get_mut("samplingParams")
            .and_then(Value::as_object_mut)
        {
            parameters.remove("stop");
        }
    }
    Ok(configuration)
}
pub fn request_view(
    interaction_id: &str,
    operation_id: &str,
    parent_operation_id: &str,
    run_id: &str,
    mut binding: RequestBinding,
    request: &SamplingRequest,
) -> Result<RequestView, ExecutionError> {
    // A fresh binding already has no inherited context. Assert this instead of copying the main one.
    if !binding.tools.is_empty()
        || !binding.instruction_sources.is_empty()
        || binding.memory_checkpoint.is_some()
        || binding.resource_checkpoint_id.is_some()
        || binding.child_dispatch.is_some()
        || binding.goal.is_some()
    {
        return Err(invalid(
            "mcp_sampling_context_invalid",
            "Sampling requires an isolated model binding",
        ));
    }
    binding.history_range = HistoryRange {
        branch_id: String::new(),
        ancestor_id: None,
        leaf_id: None,
    };
    let mut history = Vec::new();
    let mut push = |role, content| {
        history.push(ConversationItem {
            resource_activation: None,
            id: format!("{operation_id}:{}", history.len()),
            provenance: Provenance::Sampling {
                interaction_id: interaction_id.into(),
                role,
            },
            content,
            opaque: None,
        }.into());
    };
    if let Some(text) = &request.system_prompt {
        push(SamplingRole::System, Content::Text { text: text.clone() });
    }
    for message in &request.messages {
        let mut parts = Vec::new();
        for block in blocks(&message.content)? {
            if block["type"] == "text" {
                parts.push(OutputPart::Text {
                    text: block["text"].as_str().unwrap().into(),
                });
            } else {
                parts.push(OutputPart::Media {
                    media: IncomingMedia {
                        media_type: block["mimeType"].as_str().unwrap().into(),
                        data_base64: block["data"].as_str().unwrap().into(),
                    }
                    .admit(OutputSource::Operation {
                        operation_id: operation_id.into(),
                    })
                    .map_err(|_| {
                        invalid("mcp_sampling_media_invalid", "Image bytes are invalid")
                    })?,
                });
            }
        }
        push(
            message.role,
            Content::Output {
                output: OutputBody {
                    data: Value::Null,
                    parts,
                },
            },
        );
    }
    Ok(RequestView {
        request_id: operation_id.into(),
        run_id: run_id.into(),
        origin: RequestOrigin::McpSampling {
            interaction_id: interaction_id.into(),
            operation_id: operation_id.into(),
            parent_operation_id: parent_operation_id.into(),
        },
        binding,
        history,
    })
}
pub fn generate(
    provider: &dyn ModelProvider,
    snapshot: &RequestSnapshot,
    cancel: &CancellationToken,
    checkpoint: &mut dyn FnMut(&SamplingOutput) -> Result<(), ExecutionError>,
) -> (SamplingOutput, SamplingReceipt, Option<Value>) {
    let mut output = SamplingOutput::default();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        provider.generate(snapshot, cancel, &mut |event| {
            let is_usage = matches!(event, ProviderEvent::Usage { .. });
            match &event {
                ProviderEvent::ItemCompleted { item } => output.items.push(item.clone()),
                ProviderEvent::Usage { receipt } => output.usage = receipt.clone(),
                _ => {}
            }
            let durable = matches!(
                event,
                ProviderEvent::ItemCompleted { .. } | ProviderEvent::Usage { .. }
            );
            output.events.push(event);
            if durable {
                checkpoint(&output)?;
            }
            // Cancellation cannot undo a provider event already observed by this callback.
            // Retain that evidence before ending the stream; no response is released after Stop.
            if cancel.is_cancelled() && !is_usage {
                return Err(invalid("cancelled", "Sampling cancelled"));
            }
            Ok(())
        })
    }))
    .unwrap_or_else(|_| {
        Err(ModelFailure {
            code: "provider_panicked".into(),
            message: "Sampling provider failed after dispatch".into(),
            retry_after_ms: None,
            provider_request_id: None,
        })
    });
    let forbidden = output.items.iter().any(|i| {
        matches!(
            i.content,
            Content::ToolCall { .. }
                | Content::ToolResult { .. }
                | Content::Media { .. }
                | Content::Output { .. }
        )
    }) || output
        .events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ToolArgumentsDelta { .. }));
    let texts: Vec<_> = output
        .items
        .iter()
        .filter_map(|i| match &i.content {
            Content::Text { text } => Some(json!({"type":"text","text":text})),
            _ => None,
        })
        .collect();
    let usable = matches!(result, Ok(FinishReason::Stop | FinishReason::Length))
        && !forbidden
        && !cancel.is_cancelled()
        && !texts.is_empty();
    let candidate = usable.then(|| {
        let mut value = json!({
            "role": "assistant",
            "model": snapshot.view.binding.model,
            "content": if texts.len() == 1 { texts[0].clone() } else { json!(texts) },
        });
        if result == Ok(FinishReason::Length) {
            value["stopReason"] = json!("maxTokens");
        }
        // Native Stop does not distinguish natural endTurn from a configured stop sequence.
        // The optional MCP field stays absent; the exact provider receipt remains available.
        value
    });
    let receipt = SamplingReceipt {
        provider_completed: result.is_ok(),
        local_executor_stopped: true,
        usable,
        finish_reason: result.as_ref().ok().copied(),
        failure: result.err().or_else(|| {
            forbidden.then(|| ModelFailure {
                code: "mcp_sampling_output_unsupported".into(),
                message: "Sampling returned unsupported tool or media output; original output was retained without execution".into(),
                retry_after_ms: None,
                provider_request_id: None,
            })
        }),
        usage: output.usage.clone(),
    };
    (output, receipt, candidate)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpSamplingGenerateParams {
    pub operation_id: String,
    pub interaction_id: String,
    pub expected_revision: u64,
    pub edited_request: Value,
    pub configuration: crate::types::ModelSessionConfiguration,
    pub credential_scope: Option<crate::providers::auth::CredentialScope>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn configuration(family: &str) -> crate::types::ModelSessionConfiguration {
        serde_json::from_value(json!({"providerFamily":family,"model":"reviewed-model","endpoint":"https://model.invalid/v1/responses","allowAnonymous":true,"configurationGeneration":1,"maxOutputTokens":512,"acceptsImages":true})).unwrap()
    }
    fn snapshot(request: Value, family: &str) -> RequestSnapshot {
        let decoded = decode_request(&request).unwrap();
        let config = configure(configuration(family), &decoded).unwrap();
        let bound = crate::model_session::bind(config).unwrap();
        let view = request_view(
            "interaction",
            "generation",
            "parent",
            "original-run",
            bound.binding,
            &decoded,
        )
        .unwrap();
        let serialized = bound.provider.serialize(&view).unwrap();
        RequestSnapshot { view, serialized }
    }
    #[test]
    fn isolated_sampling_keeps_reviewed_roles_and_real_provider_parameters() {
        let snapshot = snapshot(
            json!({"systemPrompt":"This request only","messages":[{"role":"user","content":[{"type":"text","text":"Question"},{"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}]},{"role":"assistant","content":{"type":"text","text":"Prior answer"}}],"maxTokens":24,"temperature":0.3}),
            crate::providers::responses::FAMILY,
        );
        assert_eq!(snapshot.serialized["max_output_tokens"], 24);
        assert_eq!(snapshot.serialized["temperature"], 0.3);
        assert_eq!(snapshot.serialized["input"][0]["role"], "system");
        assert_eq!(
            snapshot.serialized["input"][0]["content"],
            "This request only"
        );
        assert_eq!(snapshot.serialized["input"][1]["role"], "user");
        assert_eq!(snapshot.serialized["input"][2]["role"], "assistant");
        assert_eq!(
            snapshot.serialized["input"][2]["content"][0]["text"],
            "Prior answer"
        );
        assert_eq!(snapshot.serialized["tools"], json!([]));
        assert!(snapshot.view.binding.history_range.branch_id.is_empty());
        assert!(snapshot.view.binding.memory_checkpoint.is_none());
        assert!(
            !snapshot
                .serialized
                .to_string()
                .contains("External output data")
        );
        assert!(
            snapshot
                .view
                .history
                .iter()
                .all(|h| matches!(h.provenance, Provenance::Sampling { .. }))
        );
    }
    #[test]
    fn declared_fields_are_either_executed_or_explain_the_unsupported_feature() {
        let base = json!({"messages":[{"role":"user","content":{"type":"text","text":"test"}}],"maxTokens":32});
        for (field, value, code) in [
            ("tools", json!([]), "mcp_sampling_tools_unsupported"),
            (
                "toolChoice",
                json!({"mode":"none"}),
                "mcp_sampling_tools_unsupported",
            ),
            ("task", json!({}), "mcp_sampling_task_unsupported"),
            ("metadata", json!({}), "mcp_sampling_metadata_unsupported"),
            (
                "includeContext",
                json!("allServers"),
                "mcp_sampling_context_unsupported",
            ),
        ] {
            let mut request = base.clone();
            request[field] = value;
            assert_eq!(decode_request(&request).unwrap_err().code, code);
        }
        let mut request = base.clone();
        request["messages"][0]["content"] =
            json!({"type":"audio","data":"aW1hZ2U=","mimeType":"audio/wav"});
        assert_eq!(
            decode_request(&request).unwrap_err().code,
            "mcp_sampling_audio_unsupported"
        );
        request["messages"][0]["content"] = json!([]);
        assert!(decode_request(&request).is_ok());
        request["messages"] = json!([]);
        assert!(decode_request(&request).is_ok());
        let request = decode_request(&base).unwrap();
        assert_eq!(
            configure(configuration(crate::providers::codex::FAMILY), &request)
                .unwrap_err()
                .code,
            "mcp_sampling_token_limit_unsupported"
        );
    }
    #[test]
    fn stop_sequences_use_actual_adapter_fields_and_capacity_is_never_expanded() {
        let request = json!({"messages":[{"role":"user","content":{"type":"text","text":"test"}}],"maxTokens":1024,"stopSequences":["END"]});
        let snapshot = snapshot(request, crate::providers::chat::FAMILY);
        assert_eq!(snapshot.serialized["max_completion_tokens"], 512);
        assert_eq!(snapshot.serialized["stop"], json!(["END"]));
    }
    struct Peer {
        tools: bool,
        fail: bool,
        cancel_before_output: bool,
    }
    impl ModelProvider for Peer {
        fn serialize(&self, _: &RequestView) -> Result<Value, ExecutionError> {
            Ok(json!({}))
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            cancel: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            if self.cancel_before_output {
                cancel.cancel();
            }
            let mut output = || -> Result<(), ExecutionError> {
                emit(ProviderEvent::Usage {
                    receipt: UsageReceipt {
                        measurement: UsageMeasurement::Actual,
                        input_tokens: Some(4),
                        output_tokens: Some(2),
                        ..Default::default()
                    },
                })?;
                if self.tools {
                    emit(ProviderEvent::ToolArgumentsDelta {
                        call_id: "unadmitted".into(),
                        delta: "{}".into(),
                    })?;
                }
                emit(ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: "answer".into(),
                        content: Content::Text {
                            text: "Generated".into(),
                        },
                        opaque: Some(OpaqueProviderItem {
                            connection_identity: "isolated".into(),
                            family: "peer".into(),
                            adapter_version: "1".into(),
                            value: json!({"raw":"retained"}),
                        }),
                    },
                })
            };
            output().map_err(|e| ModelFailure {
                code: e.code,
                message: e.message,
                retry_after_ms: None,
                provider_request_id: None,
            })?;
            if self.fail {
                Err(ModelFailure {
                    code: "transport_interrupted".into(),
                    message: "interrupted".into(),
                    retry_after_ms: None,
                    provider_request_id: None,
                })
            } else {
                Ok(FinishReason::Stop)
            }
        }
    }
    #[test]
    fn usage_and_originals_survive_interruption_or_forbidden_tools_and_no_response_is_released() {
        let snapshot = snapshot(
            json!({"messages":[],"maxTokens":32}),
            crate::providers::responses::FAMILY,
        );
        for peer in [
            Peer {
                tools: true,
                fail: false,
                cancel_before_output: false,
            },
            Peer {
                tools: false,
                fail: true,
                cancel_before_output: false,
            },
        ] {
            let (output, receipt, result) =
                generate(&peer, &snapshot, &CancellationToken::default(), &mut |_| {
                    Ok(())
                });
            assert!(result.is_none());
            assert!(!receipt.usable);
            assert_eq!(receipt.usage.input_tokens, Some(4));
            assert_eq!(
                output.items[0].opaque.as_ref().unwrap().value["raw"],
                "retained"
            );
        }
        let (_, receipt, result) = generate(
            &Peer {
                tools: false,
                fail: false,
                cancel_before_output: false,
            },
            &snapshot,
            &CancellationToken::default(),
            &mut |_| Ok(()),
        );
        assert!(receipt.usable);
        assert!(result.unwrap().get("stopReason").is_none());
    }
    #[test]
    fn cancellation_keeps_events_already_received_by_the_provider_callback() {
        let snapshot = snapshot(
            json!({"messages":[],"maxTokens":32}),
            crate::providers::responses::FAMILY,
        );
        let cancel = CancellationToken::default();
        let mut checkpoints = Vec::new();
        let (output, receipt, response) = generate(
            &Peer {
                tools: false,
                fail: false,
                cancel_before_output: true,
            },
            &snapshot,
            &cancel,
            &mut |observed| {
                checkpoints.push(observed.clone());
                Ok(())
            },
        );
        assert!(cancel.is_cancelled());
        assert!(response.is_none());
        assert!(!receipt.usable);
        assert_eq!(receipt.usage.input_tokens, Some(4));
        assert_eq!(
            output.items.len(),
            1,
            "an already received original must survive Stop"
        );
        assert_eq!(
            output.items[0].opaque.as_ref().unwrap().value["raw"],
            "retained"
        );
        assert_eq!(checkpoints.last().unwrap().items.len(), 1);
    }
    #[test]
    fn reviewed_capacity_cannot_invalidate_selected_anthropic_thinking() {
        struct NoDispatch;
        impl crate::providers::CredentialResolver for NoDispatch {
            fn headers(
                &self,
                _: Option<&str>,
                _: &CancellationToken,
            ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
                panic!("serialization must not resolve credentials or dispatch");
            }
        }
        let bind = |configuration| {
            crate::model_session::bind_provider_with_credentials(
                configuration,
                std::sync::Arc::new(NoDispatch),
                crate::providers::auth::CredentialScope {
                    reference: "test".into(),
                    authority: "test".into(),
                    account: "test".into(),
                    generation: 1,
                },
            )
            .unwrap()
        };
        let request = decode_request(&json!({"messages":[],"maxTokens":64})).unwrap();
        for family in [
            crate::providers::anthropic::FAMILY,
            crate::providers::bedrock::FAMILY,
        ] {
            let thinking = json!({"type":"enabled","budget_tokens":16384,"display":"summarized"});
            let protocol = if family == crate::providers::anthropic::FAMILY {
                json!({"thinking":thinking})
            } else {
                json!({"additionalModelRequestFields":{"thinking":thinking,"anthropic_beta":["interleaved-thinking-2025-05-14"]}})
            };
            let mut original = configuration(family);
            original.max_output_tokens = Some(32768);
            original.model_options = Some(json!({"protocol":protocol}));
            let bound = bind(original.clone());
            let view = request_view(
                "interaction",
                "generation",
                "parent",
                "run",
                bound.binding,
                &request,
            )
            .unwrap();
            assert!(
                bound.provider.serialize(&view).is_ok(),
                "the selected configuration is initially valid"
            );
            let effective = configure(original.clone(), &request).unwrap();
            assert_eq!(effective.max_output_tokens, Some(64));
            assert_eq!(
                effective.model_options, original.model_options,
                "never silently lower reviewed thinking"
            );
            let bound = bind(effective);
            let view = request_view(
                "interaction",
                "generation",
                "parent",
                "run",
                bound.binding,
                &request,
            )
            .unwrap();
            assert_eq!(
                bound.provider.serialize(&view).unwrap_err().code,
                "model-thinking-output-capacity-insufficient"
            );
        }
    }
}
