//! Locked pi-ai 1.0.4 message wire protocol. This is an HTTP adapter, not a Pi loop.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;
pub const FAMILY: &str = "pi-messages";
pub struct PiMessagesProvider {
    pub connection: Connection,
    pub max_output_tokens: Option<u64>,
    pub reasoning: Option<String>,
    pub cache_retention: Option<String>,
}
fn empty_usage() -> Value {
    json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}})
}
fn push(messages: &mut Vec<Value>, role: &str, block: Value, model: &str) {
    if let Some(last) = messages
        .last_mut()
        .filter(|v| v["role"] == role && role != "toolResult")
    {
        last["content"]
            .as_array_mut()
            .expect("message content")
            .push(block);
    } else if role == "assistant" {
        messages.push(json!({"role":role,"content":[block],"api":FAMILY,"provider":"varin","model":model,"usage":empty_usage(),"stopReason":"stop","timestamp":0}));
    } else {
        messages.push(json!({"role":role,"content":[block],"timestamp":0}));
    }
}
impl ModelProvider for PiMessagesProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        validate_view(view, FAMILY)?;
        validate_images(view, &self.connection)?;
        let mut messages = Vec::new();
        let mut calls = BTreeMap::new();
        for item in compile_history(&view.history, FAMILY, &view.binding.connection_identity) {
            if let Some(original) = &item.opaque {
                if original.adapter_version != "1" {
                    return Err(ExecutionError::new(
                        "opaque_version",
                        "unsupported pi-messages continuation version",
                    ));
                }
                if original.value["model"] == view.binding.model {
                    if let Some(block) = original.value.get("block") {
                        if let Content::ToolCall { call } = &item.content {
                            calls.insert(call.call_id.clone(), call.name.clone());
                        }
                        push(
                            &mut messages,
                            "assistant",
                            block.clone(),
                            &view.binding.model,
                        );
                        continue;
                    }
                }
            }
            let role = if matches!(
                item.provenance,
                Provenance::Assistant | Provenance::PolicyOutput { .. }
            ) {
                "assistant"
            } else {
                "user"
            };
            match item.content {
                Content::Text { text } | Content::ReasoningSummary { text } => {
                    if matches!(item.provenance, Provenance::SystemInstruction { .. }) {
                        messages.push(json!({"role":"system","content":[{"type":"text","text":text}],"timestamp":0}));
                    } else {
                        push(
                            &mut messages,
                            role,
                            json!({"type":"text","text":text}),
                            &view.binding.model,
                        );
                    }
                }
                Content::ToolCall { call } => {
                    calls.insert(call.call_id.clone(), call.name.clone());
                    push(
                        &mut messages,
                        "assistant",
                        json!({"type":"toolCall","id":call.call_id,"name":call.name,"arguments":call.arguments}),
                        &view.binding.model,
                    );
                }
                Content::ToolResult { result } => {
                    let name = calls.get(&result.call_id).ok_or_else(|| {
                        ExecutionError::new(
                            "invalid_history_pairing",
                            "pi-messages result lacks matching call",
                        )
                    })?;
                    let error = !matches!(
                        &result.completion,
                        ToolCompletion::Result {
                            outcome: crate::types::Outcome::Succeeded,
                            ..
                        } | ToolCompletion::JobAccepted { .. }
                    );
                    messages.push(json!({"role":"toolResult","toolCallId":result.call_id,"toolName":name,"isError":error,"content":[{"type":"text","text":serde_json::to_string(&result.completion).map_err(|_|ExecutionError::new("serialize","invalid tool result"))?}],"timestamp":0}));
                }
                Content::Attachment {
                    media_type,
                    content_ref,
                    ..
                } => {
                    let data = content_ref
                        .strip_prefix(&format!("data:{media_type};base64,"))
                        .ok_or_else(|| {
                            ExecutionError::new(
                                "unsupported_attachment",
                                "pi-messages requires admitted inline images",
                            )
                        })?;
                    if !media_type.starts_with("image/") {
                        return Err(ExecutionError::new(
                            "unsupported_attachment",
                            "pi-messages supports image attachments",
                        ));
                    }
                    push(
                        &mut messages,
                        "user",
                        json!({"type":"image","mimeType":media_type,"data":data}),
                        &view.binding.model,
                    );
                }
                Content::ProviderOnly => {}
            }
        }
        let tools: Vec<_> = view
            .binding
            .tools
            .iter()
            .map(|t| json!({"name":t.name,"description":t.description,"parameters":t.schema}))
            .collect();
        if !tools.is_empty() {
            messages.insert(
                0,
                json!({"role":"system","content":"","toolsAdded":tools,"timestamp":0}),
            );
        }
        let mut options = json!({"sessionId":view.binding.history_range.branch_id});
        if let Some(max) = self.max_output_tokens {
            options["maxTokens"] = json!(max);
        }
        if let Some(reasoning) = &self.reasoning {
            options["reasoning"] = json!(reasoning);
        }
        if let Some(retention) = &self.cache_retention {
            options["cacheRetention"] = json!(retention);
        }
        Ok(json!({"model":view.binding.model,"context":{"messages":messages},"options":options}))
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let mut started = false;
        let mut blocks = BTreeMap::<u64, Value>::new();
        let mut finish = None;
        self.connection.run(request,cancel,&[],&mut |event| {
            let kind=required(&event,"type")?;
            if kind=="start" {if started{return Err(invalid());}started=true;return Ok(false);}
            if kind=="error"||kind=="done" {
                if kind=="done" && (!started||!blocks.is_empty()){return Err(invalid());}
                let usage=&event["usage"];
                emit_event(emit,ProviderEvent::Usage{receipt:UsageReceipt{measurement:UsageMeasurement::Actual,input_tokens:usage["input"].as_u64(),output_tokens:usage["output"].as_u64(),cached_input_tokens:usage["cacheRead"].as_u64(),cache_write_tokens:usage["cacheWrite"].as_u64(),raw:Some(json!({"usage":usage,"responseId":event.get("responseId"),"providerThinkingLevel":event.get("providerThinkingLevel"),"rewrite":event.get("rewrite")})),..Default::default()}})?;
                if kind=="error" {return Err(failure(if event["reason"]=="aborted"{"cancelled"}else{"pi_messages_error"},"pi-messages generation failed"));}
                finish=Some(match required(&event,"reason")?{"stop"=>FinishReason::Stop,"length"=>FinishReason::Length,"toolUse"=>FinishReason::ToolCalls,_=>return Err(invalid())});return Ok(true);
            }
            if !started{return Err(invalid());}
            let index=event["contentIndex"].as_u64().ok_or_else(invalid)?;
            match kind {
                "text_start"|"thinking_start"|"toolcall_start"=>{
                    let block=match kind {"text_start"=>json!({"type":"text","text":""}),"thinking_start"=>json!({"type":"thinking","thinking":""}),_=>json!({"type":"toolCall","id":required(&event,"id")?,"name":required(&event,"toolName")?,"arguments":{}})};
                    if blocks.insert(index,block).is_some(){return Err(invalid());}
                },
                "text_delta"|"thinking_delta"|"toolcall_delta"=>{
                    let block=blocks.get_mut(&index).ok_or_else(invalid)?;let delta=required(&event,"delta")?;
                    if kind=="toolcall_delta" {if block["type"]!="toolCall"{return Err(invalid());}emit_event(emit,ProviderEvent::ToolArgumentsDelta{call_id:required(block,"id")?.into(),delta:delta.into()})?;}
                    else {let field=if kind=="text_delta"{"text"}else{"thinking"};if block["type"]!=field{return Err(invalid());}let text=block[field].as_str().ok_or_else(invalid)?.to_owned()+delta;block[field]=json!(text);if field=="text"{emit_event(emit,ProviderEvent::TextDelta{item_id:format!("pi-{index}"),text:delta.into()})?;}}
                },
                "text_end"|"thinking_end"|"toolcall_end"=>{
                    let mut block=blocks.remove(&index).ok_or_else(invalid)?;
                    let content=if kind=="toolcall_end" {
                        let tool=&event["toolCall"];if block["type"]!="toolCall"||tool["id"]!=block["id"]||tool["name"]!=block["name"]||!tool["arguments"].is_object(){return Err(invalid());}
                        block=tool.clone();Content::ToolCall{call:ToolCall{call_id:required(tool,"id")?.into(),name:required(tool,"name")?.into(),arguments:tool["arguments"].clone(),schema_version:schema_version(&request.view,required(tool,"name")?)?}}
                    }else {let field=if kind=="text_end"{"text"}else{"thinking"};if block["type"]!=field{return Err(invalid());}let text=event["content"].as_str().ok_or_else(invalid)?.to_owned();block[field]=json!(text);if let Some(signature)=event.get("contentSignature"){block[if field=="text"{"textSignature"}else{"thinkingSignature"}]=signature.clone();}if let Some(redacted)=event.get("redacted"){block["redacted"]=redacted.clone();}if field=="text"{Content::Text{text}}else{Content::ProviderOnly}};
                    emit_event(emit,ProviderEvent::ItemCompleted{item:ProviderItem{id:format!("pi-{index}"),content,opaque:opaque(&request.view,json!({"model":request.view.binding.model,"block":block}))}})?;
                },
                _=>return Err(failure("unsupported_pi_messages_event","unsupported pi-messages event")),
            }
            Ok(false)
        })?;
        finish.ok_or_else(|| {
            failure(
                "stream_interrupted",
                "pi-messages stream lacks terminal event",
            )
        })
    }
}
fn invalid() -> ModelFailure {
    failure(
        "invalid_pi_messages_event",
        "pi-messages stream violates its message/block contract",
    )
}
