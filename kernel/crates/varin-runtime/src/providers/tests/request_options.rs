use super::*;

fn configured(
    family: &str,
    options: Value,
    effort: Option<&str>,
) -> Result<Arc<dyn ModelProvider>, ExecutionError> {
    let config: crate::ModelSessionConfiguration = serde_json::from_value(json!({
        "providerFamily": family, "model": "model", "endpoint": "https://fixture.invalid",
        "credentialEnvironment": null, "allowAnonymous": true, "configurationGeneration": 1,
        "maxOutputTokens": 512, "azureDeployment": "deployment", "azureApiVersion": "2025-04-01-preview",
        "modelOptions": options, "reasoningEffort": effort
    })).unwrap();
    let mut registry = registry::ModelAdapterRegistry::default();
    registry
        .publish(0, super::super::builtins::adapters())
        .unwrap();
    registry
        .select(&config)?
        .bind(&config, connection(vec![], 1))
}

#[test]
fn sampling_cannot_replace_privacy_continuation_or_stream_controls() {
    for family in [chat::FAMILY, responses::FAMILY, azure::FAMILY] {
        for (key, value) in [
            ("store", json!(true)),
            ("include", json!([])),
            ("stream_options", json!({"include_usage": false})),
            ("previous_response_id", json!("remote-response")),
            ("conversation", json!("remote-conversation")),
        ] {
            let error = configured(family, json!({"samplingParams": {key: value}}), None)
                .err()
                .unwrap();
            assert_eq!(error.code, "sampling_parameters");
        }
    }
    for value in [
        Value::Null,
        json!(0),
        json!(2),
        json!(-1),
        json!(1.5),
        json!("1"),
        json!(true),
    ] {
        assert_eq!(
            configured(chat::FAMILY, json!({"samplingParams": {"n": value}}), None)
                .err()
                .unwrap()
                .code,
            "sampling_parameters"
        );
    }
}

#[test]
fn vendor_sampling_fields_and_existing_explicit_precedence_are_preserved() {
    let provider = configured(
        chat::FAMILY,
        json!({"temperature": 0.4, "samplingParams": {
            "n": 1, "temperature": 0.2, "top_k": 20, "min_p": 0.05,
            "reasoning": {"enabled": true}, "chat_template_kwargs": {"enable_thinking": true}
        }}),
        None,
    )
    .unwrap();
    let body = provider
        .serialize(&view(chat::FAMILY), None)
        .unwrap()
        .to_value();
    assert_eq!(body["n"], 1);
    assert_eq!(body["temperature"], 0.2);
    assert_eq!(body["top_k"], 20);
    assert_eq!(body["min_p"], 0.05);
    assert_eq!(body["reasoning"], json!({"enabled": true}));
    assert_eq!(
        body["chat_template_kwargs"],
        json!({"enable_thinking": true})
    );
    assert_eq!(body["stream_options"]["include_usage"], true);
}

#[test]
fn mistral_explicit_prompt_mode_and_cache_key_reach_the_request() {
    let provider = configured(
        mistral::FAMILY,
        json!({"protocol": {"promptMode": "reasoning", "promptCacheKey": "fixture-affinity"}}),
        None,
    )
    .unwrap();
    let body = provider
        .serialize(&view(mistral::FAMILY), None)
        .unwrap()
        .to_value();
    assert_eq!(body["prompt_mode"], "reasoning");
    assert_eq!(body["prompt_cache_key"], "fixture-affinity");
    assert!(body.get("reasoning_effort").is_none());
    for options in [json!({"promptMode": "off"}), json!({"promptCacheKey": 7})] {
        assert_eq!(
            configured(mistral::FAMILY, json!({"protocol": options}), None)
                .err()
                .unwrap()
                .code,
            "model_options"
        );
    }
    assert_eq!(
        configured(
            mistral::FAMILY,
            json!({"protocol": {"promptMode": "reasoning"}}),
            Some("high")
        )
        .err()
        .unwrap()
        .code,
        "model_options"
    );
    let provider = configured(mistral::FAMILY, json!({}), Some("none")).unwrap();
    let body = provider
        .serialize(&view(mistral::FAMILY), None)
        .unwrap()
        .to_value();
    assert_eq!(body["reasoning_effort"], "none");
    assert!(body.get("prompt_mode").is_none());
    assert!(body.get("prompt_cache_key").is_none());
}

#[test]
fn responses_explicit_unsupported_strict_mode_omits_field_without_changing_continuation() {
    for family in [responses::FAMILY, azure::FAMILY] {
        for invalid in [Value::Null, json!("false"), json!(0)] {
            assert_eq!(
                configured(
                    family,
                    json!({"protocol": {"supportsStrictMode": invalid}}),
                    None
                )
                .err()
                .unwrap()
                .code,
                "model_options"
            );
        }
        for flag in [None, Some(false), Some(true)] {
            let options = flag.map_or_else(
                || json!({}),
                |v| json!({"protocol": {"supportsStrictMode": v}}),
            );
            let provider = configured(family, options, None).unwrap();
            let body = provider.serialize(&view(family), None).unwrap().to_value();
            assert!(!body["tools"].as_array().unwrap().is_empty());
            for tool in body["tools"].as_array().unwrap() {
                assert_eq!(
                    tool.get("strict"),
                    if flag == Some(false) {
                        None
                    } else {
                        Some(&Value::Bool(false))
                    }
                );
            }
            assert_eq!(body["store"], false);
            assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
        }
    }
}
