use varin_runtime::execution::{CancellationToken, RequestSnapshot, RequestView};
use varin_runtime::{model_session, ModelSessionConfiguration};
fn configuration() -> ModelSessionConfiguration {
    ModelSessionConfiguration {
        provider_family: "openai-responses".into(),
        model: "local-test".into(),
        endpoint: "http://127.0.0.1:9/not-contacted".into(),
        credential_environment: None,
        allow_anonymous: false,
        configuration_generation: 42,
        max_output_tokens: 100,
    }
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
