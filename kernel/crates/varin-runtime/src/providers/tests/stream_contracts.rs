//! Protocol facts are tested through fragmented transport, not duplicated state machines.
use super::*;

#[test]
fn google_default_finish_is_nonterminal_for_both_families() {
    for family in [google::FAMILY, google::VERTEX_FAMILY] {
        for sentinel in ["", "FINISH_REASON_UNSPECIFIED"] {
            let partial = json!({"candidates":[{"index":0,"finishReason":sentinel,
                "content":{"role":"model","parts":[{"text":"hello"}]}}]});
            for terminal in [false, true] {
                let mut input = vec![partial.clone()];
                if terminal {
                    input.push(json!({"candidates":[{"index":0,"finishReason":"STOP"}]}));
                    input.push(json!({"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}));
                }
                let provider = if family == google::FAMILY {
                    google::GoogleProvider::new(connection(input, 1))
                } else {
                    google::GoogleProvider::vertex(connection(input, 1))
                }.unwrap();
                let (result, events) = generate(&provider, family);
                assert!(events.iter().any(|e| matches!(e, ProviderEvent::TextDelta { text, .. } if text == "hello")));
                if terminal {
                    assert_eq!(result.unwrap(), FinishReason::Stop);
                    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Usage { receipt } if receipt.output_tokens == Some(1))));
                } else {
                    assert_eq!(result.unwrap_err().code, "stream_interrupted");
                    assert!(!events.iter().any(|e| matches!(e, ProviderEvent::ItemCompleted { .. })));
                }
            }
        }
    }
}

#[test]
fn bedrock_message_stop_does_not_complete_an_open_tool_block() {
    // Remove one whole independently checksummed frame, preserving valid framing
    // and complete tool JSON. The adapter, rather than CRC/JSON parsing, must reject it.
    let fixture = include_bytes!("../../../tests/fixtures/bedrock-converse.bin");
    let mut bytes = Vec::new();
    let mut offset = 0;
    let mut removed = 0;
    while offset < fixture.len() {
        let total = u32::from_be_bytes(fixture[offset..offset + 4].try_into().unwrap()) as usize;
        let headers = u32::from_be_bytes(fixture[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let frame = &fixture[offset..offset + total];
        let payload: Value = serde_json::from_slice(&frame[12 + headers..total - 4]).unwrap();
        if frame[12..12 + headers].windows(b"contentBlockStop".len()).any(|w| w == b"contentBlockStop")
            && payload["contentBlockIndex"] == 1
        {
            removed += 1;
        } else {
            bytes.extend_from_slice(frame);
        }
        offset += total;
    }
    assert_eq!(removed, 1);
    let (provider, _) = bedrock_fixture(bytes.clone());
    let (result, events) = generate(&provider, bedrock::FAMILY);
    assert_eq!(result.unwrap_err().code, "incomplete_tool_call");
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Usage { receipt }
        if receipt.measurement == UsageMeasurement::Actual
            && receipt.input_tokens == Some(10) && receipt.output_tokens == Some(4)
            && receipt.raw.as_ref() == Some(&json!({"inputTokens":10,"outputTokens":4,"cacheReadInputTokens":2})))));
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::ToolArgumentsDelta { .. })));
    assert!(!events.iter().any(|e| matches!(e, ProviderEvent::ItemCompleted { item } if matches!(item.content, Content::ToolCall { .. }))));

    // Deferring the semantic failure must not mask transport/framing errors or
    // permit another message after the valid terminal event.
    let (provider, _) = bedrock_fixture(bytes[..bytes.len() - 1].to_vec());
    assert_eq!(generate(&provider, bedrock::FAMILY).0.unwrap_err().code, "stream_interrupted");
    let mut corrupt = bytes.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    let (provider, _) = bedrock_fixture(corrupt);
    assert_eq!(generate(&provider, bedrock::FAMILY).0.unwrap_err().code, "invalid_eventstream");
    let first_frame_size = u32::from_be_bytes(fixture[..4].try_into().unwrap()) as usize;
    bytes.extend_from_slice(&fixture[..first_frame_size]);
    let (provider, _) = bedrock_fixture(bytes);
    let (result, events) = generate(&provider, bedrock::FAMILY);
    assert_eq!(result.unwrap_err().code, "invalid_bedrock_event");
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Usage { receipt } if receipt.output_tokens == Some(4))));
}

fn pi_provider(events: Vec<Value>) -> pi_messages::PiMessagesProvider {
    pi_messages::PiMessagesProvider {
        connection: connection(events, 1),
        max_output_tokens: None,
        reasoning: None,
        cache_retention: None,
    }
}
fn pi_call_start(index: u64, id: &str) -> Value {
    json!({"type":"toolcall_start","contentIndex":index,"id":id,"toolName":"read"})
}
fn pi_call_end(index: u64, id: &str) -> Value {
    json!({"type":"toolcall_end","contentIndex":index,"toolCall":{"type":"toolCall","id":id,"name":"read","arguments":{"path":"x"}}})
}

#[test]
fn pi_tool_progress_precedes_arguments_and_preserves_terminal_receipt() {
    let provider = pi_provider(vec![
        json!({"type":"start"}), pi_call_start(0, "call"),
        json!({"type":"toolcall_delta","contentIndex":0,"delta":"{\"path\":\"x\"}"}),
        pi_call_end(0, "call"),
        json!({"type":"done","reason":"toolUse","responseModel":"routed-model","usage":{"input":4,"output":2}}),
    ]);
    let (result, events) = generate(&provider, pi_messages::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    let started = events.iter().position(|e| matches!(e, ProviderEvent::ToolCallStarted { call_id, name, request_id } if call_id == "call" && name == "read" && request_id == &view(pi_messages::FAMILY).request_id)).unwrap();
    let delta = events.iter().position(|e| matches!(e, ProviderEvent::ToolArgumentsDelta { call_id, .. } if call_id == "call")).unwrap();
    let completed = events.iter().position(|e| matches!(e, ProviderEvent::ItemCompleted { item } if matches!(item.content, Content::ToolCall { .. }))).unwrap();
    assert!(started < delta && delta < completed);
    assert!(events.iter().any(|e| matches!(e, ProviderEvent::Usage { receipt } if receipt.measurement == UsageMeasurement::Actual && receipt.output_tokens == Some(2) && receipt.raw.as_ref().unwrap()["responseModel"] == "routed-model")));
}

#[test]
fn pi_missing_usage_is_not_an_actual_measurement() {
    for terminal in [json!({"type":"done","reason":"stop"}), json!({"type":"error","reason":"error"})] {
        let provider = pi_provider(vec![json!({"type":"start"}), terminal]);
        let (_, events) = generate(&provider, pi_messages::FAMILY);
        assert!(events.iter().any(|e| matches!(e, ProviderEvent::Usage { receipt } if receipt.measurement == UsageMeasurement::Missing && receipt.input_tokens.is_none() && receipt.output_tokens.is_none())));
    }
}

#[test]
fn pi_rejects_reopened_indices_duplicate_calls_and_wrong_end_type() {
    let mut wrong_type = pi_call_end(0, "call");
    wrong_type["toolCall"]["type"] = json!("text");
    for body in [
        vec![pi_call_start(0, "call"), pi_call_end(0, "call"), pi_call_start(0, "other")],
        vec![pi_call_start(0, "call"), pi_call_end(0, "call"), pi_call_start(1, "call")],
        vec![pi_call_start(0, "call"), pi_call_start(1, "call")],
        vec![pi_call_start(0, "call"), wrong_type],
    ] {
        let mut input = vec![json!({"type":"start"})];
        input.extend(body);
        input.push(json!({"type":"done","reason":"toolUse"}));
        let (result, _) = generate(&pi_provider(input), pi_messages::FAMILY);
        assert_eq!(result.unwrap_err().code, "invalid_pi_messages_event");
    }
}
