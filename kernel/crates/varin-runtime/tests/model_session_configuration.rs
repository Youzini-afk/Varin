use varin_runtime::execution::{CancellationToken, RequestSnapshot, RequestView};
use varin_runtime::{model_session, ModelSessionConfiguration};
fn configuration() -> ModelSessionConfiguration {
    serde_json::from_value(serde_json::json!({
        "providerFamily":"openai-responses", "model":"local-test",
        "endpoint":"http://127.0.0.1:9/not-contacted", "credentialEnvironment":null,
        "allowAnonymous":false, "configurationGeneration":42, "maxOutputTokens":100
    }))
    .unwrap()
}

#[test]
fn explicit_unsupported_provider_cannot_silently_fall_back() {
    let mut config = configuration();
    config.provider_family = "not-implemented".into();
    assert!(matches!(model_session::bind(config),Err(error) if error.code=="unsupported_provider"));
}
#[test]
fn model_only_binding_has_no_tool_grant_and_credentials_remain_dispatch_only() {
    let mut config = configuration();
    let variable = format!("VARIN_MISSING_TEST_{}", uuid::Uuid::new_v4().simple());
    config.credential_environment = Some(variable.clone());
    let start = model_session::bind(config).unwrap();
    assert!(start.binding.tools.is_empty());
    assert_eq!(start.binding.configuration_generation, 42);
    let view = RequestView {
        request_id: "request".into(),
        run_id: "run".into(),
        step: 1,
        binding: start.binding,
        history: vec![],
    };
    let serialized = start.provider.serialize(&view).unwrap();
    assert!(!serialized.to_string().contains(&variable));
    assert!(serialized.get("authorization").is_none());
    let error = start
        .provider
        .generate(
            &RequestSnapshot { view, serialized },
            &CancellationToken::default(),
            &mut |_| Ok(()),
        )
        .unwrap_err();
    assert_eq!(error.code, "credential_unavailable");
    assert!(!error.message.contains(&variable));
}
#[test]
fn absent_credentials_require_explicit_anonymous_configuration() {
    let start = model_session::bind(configuration()).unwrap();
    let view = RequestView {
        request_id: "request".into(),
        run_id: "run".into(),
        step: 1,
        binding: start.binding,
        history: vec![],
    };
    let serialized = start.provider.serialize(&view).unwrap();
    assert_eq!(
        start
            .provider
            .generate(
                &RequestSnapshot { view, serialized },
                &CancellationToken::default(),
                &mut |_| Ok(())
            )
            .unwrap_err()
            .code,
        "credential_required"
    );
}

#[test]
fn factory_chat_and_azure_reach_the_selected_protocol_and_credential_header() {
    use serde_json::json;
    use std::io::{Read, Write};
    use varin_runtime::execution::{FinishReason, ProviderEvent};
    for (family, header) in [
        ("openai-completions", "authorization: Bearer fixture-only"),
        ("azure-openai-responses", "api-key: fixture-only"),
    ] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/model?tenant=fixture",
            listener.local_addr().unwrap()
        );
        let data = if family == "openai-completions" {
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"id":"chat","choices":[{"index":0,"delta":{"role":"assistant","content":"factory chat"},"finish_reason":"stop"}]})
            )
        } else {
            format!(
                "data: {}\n\n",
                json!({"type":"response.completed","response":{"output":[{"id":"azure-message","type":"message","content":[{"type":"output_text","text":"factory azure"}]}]}})
            )
        };
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut received = Vec::new();
            let mut block = [0u8; 4096];
            loop {
                let n = socket.read(&mut block).unwrap();
                assert!(n > 0);
                received.extend_from_slice(&block[..n]);
                if let Some(end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&received[..end]);
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len()).as_bytes()).unwrap();
            String::from_utf8(received).unwrap()
        });
        let variable = format!("VARIN_FACTORY_FIXTURE_{}", uuid::Uuid::new_v4().simple());
        std::env::set_var(&variable, "fixture-only");
        let mut config = configuration();
        config.provider_family = family.into();
        config.endpoint = endpoint;
        config.credential_environment = Some(variable.clone());
        if family == "openai-completions" {
            config.legacy_max_tokens = Some(true);
            config.include_stream_usage = Some(false);
            config.reasoning_effort = Some("low".into());
        } else {
            config.azure_deployment = Some("explicit-deployment".into());
            config.azure_api_version = Some("2025-04-01-preview".into());
        }
        let start = model_session::bind(config).unwrap();
        let view = RequestView {
            request_id: "request".into(),
            run_id: "run".into(),
            step: 1,
            binding: start.binding,
            history: vec![],
        };
        let serialized = start.provider.serialize(&view).unwrap();
        if family == "openai-completions" {
            assert_eq!(serialized["max_tokens"], 100);
            assert!(serialized.get("stream_options").is_none());
            assert_eq!(serialized["reasoning_effort"], "low");
        } else {
            assert_eq!(serialized["model"], "explicit-deployment");
        }
        assert!(!serialized.to_string().contains("fixture-only"));
        let mut events = Vec::new();
        let result = start.provider.generate(
            &RequestSnapshot { view, serialized },
            &CancellationToken::default(),
            &mut |e| {
                events.push(e);
                Ok(())
            },
        );
        let request = server.join().unwrap();
        std::env::remove_var(variable);
        assert_eq!(result.unwrap(), FinishReason::Stop);
        assert!(request.contains(header));
        assert!(request.contains("tenant=fixture"));
        if family == "azure-openai-responses" {
            assert!(request.contains("api-version=2025-04-01-preview"));
        }
        assert!(events.iter().any(|e|matches!(e,ProviderEvent::ItemCompleted{item} if item.opaque.as_ref().is_some_and(|o|o.family==family))));
    }
}
#[test]
fn azure_factory_does_not_infer_missing_deployment_or_api_version() {
    let mut config = configuration();
    config.provider_family = "azure-openai-responses".into();
    assert!(model_session::bind(config.clone()).is_err());
    config.azure_deployment = Some("deployment".into());
    assert!(model_session::bind(config).is_err());
}
