use super::*;

fn signed_stream(signature: Value, repeated: Option<Value>) -> chat::ChatProvider {
    let mut events = vec![json!({"id":"signed-chat","choices":[{"index":0,"delta":{
        "role":"assistant","content":"Checking.","tool_calls":[
            {"index":0,"id":"call-a","type":"function","function":{"name":"read","arguments":"{\"path\":"},
             "extra_content":{"google":{"thought_signature":signature}}},
            {"index":1,"id":"call-b","type":"function","function":{"name":"read","arguments":"{}"}}
        ]}}]})];
    if let Some(signature) = repeated {
        events.push(json!({"id":"signed-chat","choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"extra_content":{"google":{"thought_signature":signature}}}
        ]}}]}));
    }
    events.push(json!({"id":"signed-chat","choices":[{"index":0,"delta":{"tool_calls":[
        {"index":0,"function":{"arguments":"\"文件.rs\"}"}}
    ]},"finish_reason":"tool_calls"}]}));
    chat::ChatProvider::new(chat_connection(events, true))
}

fn completed_history(events: Vec<ProviderEvent>) -> ConversationHistory {
    events.into_iter().filter_map(|event| match event {
        ProviderEvent::ItemCompleted { item } => Some(ConversationItem {
            resource_activation: None, id: item.id, provenance: Provenance::Assistant,
            content: item.content, opaque: item.opaque,
        }.into()),
        _ => None,
    }).collect()
}

#[test]
fn signed_chat_atomic_metadata_roundtrips_parallel_calls_without_public_leakage() {
    let signature = "fixture-opaque-signature+/=";
    let provider = signed_stream(json!(signature), Some(json!(signature)));
    let (result, events) = generate(&provider, chat::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    for event in &events {
        match event {
            ProviderEvent::TextDelta { text, .. } | ProviderEvent::ReasoningDelta { text, .. } =>
                assert!(!text.contains(signature)),
            _ => {}
        }
    }
    let mut replay = view(chat::FAMILY);
    replay.history = completed_history(events);
    assert_eq!(replay.history.len(), 3);
    let body = provider.serialize(&replay, None).unwrap().to_value();
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "Checking.");
    let calls = messages[0]["tool_calls"].as_array().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["extra_content"]["google"]["thought_signature"], signature);
    assert_eq!(calls[0]["function"]["arguments"], "{\"path\":\"文件.rs\"}");
    assert!(calls[1].get("extra_content").is_none());
}

#[test]
fn signed_chat_conflicts_and_malformed_signatures_fail_without_completed_calls() {
    for (signature, repeated, code) in [
        (json!("first"), Some(json!("second")), "conflicting_thought_signature"),
        (json!(""), None, "invalid_thought_signature"),
        (json!(null), None, "invalid_thought_signature"),
        (json!({"text":"not-a-signature"}), None, "invalid_thought_signature"),
    ] {
        let (result, events) = generate(&signed_stream(signature, repeated), chat::FAMILY);
        assert_eq!(result.unwrap_err().code, code);
        assert!(!events.iter().any(|event| matches!(event, ProviderEvent::ItemCompleted { .. })));
    }
}

#[test]
fn signed_chat_metadata_can_arrive_after_function_arguments() {
    let provider = chat::ChatProvider::new(chat_connection(vec![
        json!({"id":"late-signature","choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"id":"call-a","type":"function","function":{"name":"read","arguments":"{}"}}
        ]}}]}),
        json!({"id":"late-signature","choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"extra_content":{"google":{"thought_signature":"late-opaque"}}}
        ]},"finish_reason":"tool_calls"}]}),
    ], true));
    let (result, events) = generate(&provider, chat::FAMILY);
    assert_eq!(result.unwrap(), FinishReason::ToolCalls);
    let mut replay = view(chat::FAMILY);
    replay.history = completed_history(events);
    let body = provider.serialize(&replay, None).unwrap().to_value();
    assert_eq!(body["messages"][0]["tool_calls"][0]["extra_content"]["google"]["thought_signature"], "late-opaque");
}

#[test]
fn signed_chat_model_and_account_scope_exclude_metadata_even_with_compile_reuse() {
    let provider = signed_stream(json!("scoped-signature"), None);
    let (result, events) = generate(&provider, chat::FAMILY);
    result.unwrap();
    let mut replay = view(chat::FAMILY);
    replay.history = completed_history(events);
    let original = replay.history[0].opaque.as_ref().unwrap().clone();
    assert_eq!(original.adapter_version, "2");
    assert_eq!(original.value["model"], replay.binding.model);
    let mut reuse = RequestCompileReuse::new();
    let same = provider.serialize(&replay, Some(&mut reuse)).unwrap().to_value();
    assert!(same.to_string().contains("scoped-signature"));
    let original_model = replay.binding.model.clone();
    replay.binding.model = "different-model".into();
    let changed = provider.serialize(&replay, Some(&mut reuse)).unwrap().to_value();
    assert!(!changed.to_string().contains("scoped-signature"));
    assert_eq!(changed["messages"][0]["tool_calls"].as_array().unwrap().len(), 2);
    replay.binding.model = original_model;
    let restored = provider.serialize(&replay, Some(&mut reuse)).unwrap().to_value();
    assert_eq!(same, restored);
    replay.binding.connection_identity = "different-account".into();
    let changed = provider.serialize(&replay, Some(&mut reuse)).unwrap().to_value();
    assert!(!changed.to_string().contains("scoped-signature"));
    assert_eq!(changed["messages"][0]["tool_calls"].as_array().unwrap().len(), 2);
    assert_eq!(replay.history[0].opaque.as_ref().unwrap(), &original);
}

#[test]
fn signed_chat_unsigned_originals_keep_cross_model_portability() {
    let provider = chat::ChatProvider::new(chat_connection(vec![json!({
        "id":"unsigned","choices":[{"index":0,"delta":{"content":"Answer.","reasoning_content":"Portable summary."},"finish_reason":"stop"}]
    })], true));
    let (result, events) = generate(&provider, chat::FAMILY);
    result.unwrap();
    let mut replay = view(chat::FAMILY);
    replay.history = completed_history(events);
    assert_eq!(replay.history[0].opaque.as_ref().unwrap().adapter_version, "1");
    replay.binding.model = "different-model".into();
    let body = provider.serialize(&replay, None).unwrap().to_value();
    assert_eq!(body["messages"][0]["reasoning_content"], "Portable summary.");
}

#[test]
fn signed_chat_rejects_malformed_version_two_envelopes() {
    let provider = signed_stream(json!("scoped-signature"), None);
    let (result, events) = generate(&provider, chat::FAMILY);
    result.unwrap();
    let mut replay = view(chat::FAMILY);
    replay.history = completed_history(events);
    for malformed in [json!({"message":{}}), json!({"model":"model","message":null})] {
        Arc::make_mut(&mut replay.history[0]).opaque.as_mut().unwrap().value = malformed;
        assert_eq!(provider.serialize(&replay, None).unwrap_err().code, "invalid_opaque");
    }
}

#[test]
fn signed_chat_tool_only_and_provider_only_originals_fall_back_on_model_change() {
    let provider = chat::ChatProvider::new(chat_connection(vec![json!({
        "id":"tool-only","choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"id":"call-a","type":"function","function":{"name":"read","arguments":"{}"},
             "extra_content":{"google":{"thought_signature":"tool-only-signature"}}}
        ]},"finish_reason":"tool_calls"}]
    })], true));
    let (result, events) = generate(&provider, chat::FAMILY);
    result.unwrap();
    let mut replay = view(chat::FAMILY);
    replay.history = completed_history(events);
    let model = replay.binding.model.clone();
    for provider_only in [false, true] {
        if provider_only {
            Arc::make_mut(&mut replay.history[0]).content = Content::ProviderOnly;
        }
        replay.binding.model = model.clone();
        let mut reuse = RequestCompileReuse::new();
        let same = provider.serialize(&replay, Some(&mut reuse)).unwrap().to_value();
        assert!(same.to_string().contains("tool-only-signature"));
        replay.binding.model = "other-model".into();
        let other = provider.serialize(&replay, Some(&mut reuse)).unwrap().to_value();
        assert!(!other.to_string().contains("tool-only-signature"));
        assert_eq!(other["messages"][0]["tool_calls"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn signed_chat_metadata_is_not_silently_rewritten_by_mistral_encoding() {
    let provider = chat::ChatProvider::mistral(chat_connection(vec![json!({
        "id":"signed-mistral","choices":[{"index":0,"delta":{"tool_calls":[
            {"index":0,"id":"call-a","type":"function","function":{"name":"read","arguments":"{}"},
             "extra_content":{"google":{"thought_signature":"not-mistral-wire"}}}
        ]},"finish_reason":"tool_calls"}]
    })], true));
    let (result, events) = generate(&provider, mistral::FAMILY);
    assert_eq!(result.unwrap_err().code, "unsupported_content_delta");
    assert!(!events.iter().any(|event| matches!(event, ProviderEvent::ItemCompleted { .. })));
}
