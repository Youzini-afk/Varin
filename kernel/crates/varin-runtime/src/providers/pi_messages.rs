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
fn pi_parts(parts: Vec<ProviderPart<'_>>) -> Result<Vec<Value>, ExecutionError> {
    let mut blocks = Vec::new();
    for part in parts {
        match part {
            ProviderPart::Text { text } => {
                let mut block = json!({"type":"text"});
                block["text"] = Value::String(text.into_owned());
                blocks.push(block);
            }
            ProviderPart::Media { media } => {
                require_media_type(
                    media,
                    &["image/png", "image/jpeg", "image/webp", "image/gif"],
                    FAMILY,
                )?;
                blocks.push(json!({"type":"text","text":media_label(media)}));
                blocks.push(
                    json!({"type":"image","mimeType":media.media_type,"data":media.data_base64}),
                );
            }
        }
    }
    Ok(blocks)
}
impl ModelProvider for PiMessagesProvider {
    fn request_budget_protocol(&self) -> Option<crate::context_capacity::RequestBudgetProtocol> {
        Some(crate::context_capacity::RequestBudgetProtocol {
            transcript: &["context", "messages"],
            coalesced_content: Some("content"),
            complete_input_tokens: pi_input_tokens,
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
        let mut groups: Vec<groups::HistoryGroup<'_>> = Vec::new();
        let mut calls = BTreeMap::new();
        let mut result_calls = BTreeMap::new();
        for projected in project_history(&view.history, FAMILY, &view.binding.connection_identity) {
            let item = projected.item;
            if let Some(original) = projected.opaque {
                if original.adapter_version != "1" {
                    return Err(ExecutionError::new(
                        "opaque_version",
                        "unsupported pi-messages continuation version",
                    ));
                }
            }
            let original_block = projected.opaque.is_some_and(|original| {
                original.value["model"] == view.binding.model
                    && original.value.get("block").is_some()
            });
            let role = if original_block {
                if let Content::ToolCall { call } = &item.content {
                    calls.insert(call.call_id.as_str(), projected);
                }
                "assistant"
            } else {
                match &item.content {
                    Content::Text { .. } | Content::ReasoningSummary { .. }
                        if item.provenance.is_system() =>
                    {
                        "system"
                    }
                    Content::Text { .. } | Content::ReasoningSummary { .. } => {
                        if item.provenance.is_assistant() {
                            "assistant"
                        } else {
                            "user"
                        }
                    }
                    Content::ToolCall { call } => {
                        calls.insert(call.call_id.as_str(), projected);
                        "assistant"
                    }
                    Content::ToolResult { result } => {
                        let call = calls.get(result.call_id.as_str()).ok_or_else(|| {
                            ExecutionError::new(
                                "invalid_history_pairing",
                                "pi-messages result lacks matching call",
                            )
                        })?;
                        result_calls.insert(Arc::as_ptr(item) as usize, *call);
                        "toolResult"
                    }
                    Content::Media { .. } => "user",
                    Content::Output { output } => {
                        if output.parts.is_empty()
                            && matches!(item.provenance, Provenance::Sampling { .. })
                        {
                            continue;
                        }
                        evidence_role(
                            &item.provenance,
                            if item.provenance.is_assistant() {
                                "assistant"
                            } else {
                                "user"
                            },
                        )
                    }
                    Content::ProviderOnly => continue,
                }
            };
            if let Some((_, items)) = groups
                .last_mut()
                .filter(|(last, _)| *last == role && role != "toolResult" && role != "system")
            {
                items.push(projected);
            } else {
                groups.push((role, vec![projected]));
            }
        }
        let mut compiler = groups::GroupCompiler::new(reuse.as_deref_mut());
        let mut messages = Vec::new();
        if !view.binding.tools.is_empty() {
            messages.push(compiler.field("tools-message", || json!({"role":"system","content":"","timestamp":0,
                "toolsAdded":view.binding.tools.iter().map(|t|json!({"name":t.name,"description":t.description,"parameters":t.schema})).collect::<Vec<_>>()
            })));
        }
        for (role, items) in groups {
            let mut sources = items.clone();
            for item in &items {
                if let Some(call) = result_calls.get(&(Arc::as_ptr(item.item) as usize)) {
                    sources.push(*call);
                }
            }
            messages.push(compiler.group(role, &sources, || {
                let mut message = if role == "assistant" {
                    json!({"role":role,"api":FAMILY,"provider":"varin","model":view.binding.model,"usage":empty_usage(),"stopReason":"stop","timestamp":0})
                } else { json!({"role":role,"timestamp":0}) };
                let mut blocks = Vec::new();
                for projected in &items {
                    let item = projected.item;
                    if let Some(block) = projected.opaque.filter(|original| original.value["model"] == view.binding.model).and_then(|original| original.value.get("block")) {
                        blocks.push(block.clone());
                        continue;
                    }
                    match &item.content {
                        Content::Text { text } | Content::ReasoningSummary { text } => blocks.push(json!({"type":"text","text":text})),
                        Content::ToolCall { call } => blocks.push(json!({"type":"toolCall","id":call.call_id,"name":call.name,"arguments":call.arguments})),
                        Content::ToolResult { result } => {
                            let call = result_calls[&(Arc::as_ptr(item) as usize)];
                            let Content::ToolCall { call } = &call.item.content else { unreachable!() };
                            let error = !matches!(&result.completion, ToolCompletion::Result { outcome: crate::types::Outcome::Succeeded, .. } | ToolCompletion::JobAccepted { .. });
                            message["toolCallId"] = json!(result.call_id);
                            message["toolName"] = json!(call.name);
                            message["isError"] = json!(error);
                            blocks.extend(pi_parts(completion_parts(&result.completion))?);
                        }
                        Content::Media { media } => blocks.extend(pi_parts(vec![ProviderPart::Media { media }])?),
                        Content::Output { output } => blocks.extend(pi_parts(evidence_parts(output,&item.provenance))?),
                        Content::ProviderOnly => {}
                    }
                }
                message["content"] = Value::Array(blocks);
                Ok(message)
            })?);
        }
        let session_id = match &view.origin {
            RequestOrigin::McpSampling { operation_id, .. }
            | RequestOrigin::AuxiliaryInference { operation_id, .. } => operation_id,
            _ => &view.binding.history_range.branch_id,
        };
        let mut options = json!({"sessionId":session_id});
        if let Some(max) = self.max_output_tokens {
            options["maxTokens"] = json!(max);
        }
        if let Some(reasoning) = &self.reasoning {
            options["reasoning"] = json!(reasoning);
        }
        if let Some(retention) = &self.cache_retention {
            options["cacheRetention"] = json!(retention);
        }
        let mut context = RequestBody::from(json!({}));
        context.insert_fragments("messages", messages);
        let mut body = RequestBody::from(json!({"model":view.binding.model,"options":options}));
        body.insert_object("context", context);
        compiler.finish(reuse);
        Ok(body)
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
