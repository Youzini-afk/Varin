//! Original MCP request, public reviews, native model Operation and private credentials.
//! The registered review adapter keeps the installed builtin serializer/parser and substitutes
//! only its HTTP stream. No listener, external account or live model is involved.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use varin_runtime::providers::{
    Connection, HttpRequest, HttpTransport,
    registry::{
        MODEL_ADAPTER_CONTRACT, ModelAdapter, ModelAdapterMetadata, ModelAdapterRegistry,
        SelectedAdapter, model_adapters,
    },
};

const ANSWER: &str = "Reviewed output from the original Responses adapter";
const PIXEL: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7h8AAAAASUVORK5CYII=";
#[derive(Default)]
struct Stream {
    requests: Mutex<Vec<Value>>,
    cancelled: AtomicUsize,
}
impl HttpTransport for Stream {
    fn stream(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        assert_eq!(
            request.endpoint,
            "https://sampling-model.invalid/v1/responses"
        );
        assert_eq!(
            request.headers["authorization"],
            "Bearer fixture-only-sampling-credential"
        );
        self.requests.lock().unwrap().push(request.body.to_value());
        if request
            .body
            .to_string()
            .contains("HOLD_REVIEWED_GENERATION")
        {
            let (wake, wait) = mpsc::sync_channel(1);
            let _watch = cancel.wake_on_cancel(wake);
            wait.recv_timeout(Duration::from_secs(30))
                .expect("exact generation Stop did not wake the original transport");
            assert!(cancel.is_cancelled());
            self.cancelled.fetch_add(1, Ordering::SeqCst);
            return Err(ModelFailure {
                code: "cancelled".into(),
                message: "Original generation transport cancelled".into(),
                retry_after_ms: None,
                provider_request_id: None,
            });
        }
        let event = json!({"type":"response.completed","response":{"id":"original-sampling-response","status":"completed",
            "output":[{"id":"sample","type":"message","role":"assistant","content":[{"type":"output_text","text":ANSWER}],"opaqueOriginal":{"nullable":null,"empty":[]}}],
            "usage":{"input_tokens":17,"output_tokens":9,"input_tokens_details":{"cached_tokens":3}},
            "opaqueOriginal":{"nullable":null,"empty":[]}}});
        let wire = format!("data: {event}\n\n");
        for chunk in wire.as_bytes().chunks(7) {
            if receive(chunk)? {
                break;
            }
        }
        Ok(())
    }
}
struct Adapter {
    metadata: ModelAdapterMetadata,
    // Each planned binding is a retained original builtin selection. Unexpected extra binding
    // fails this finite test instead of obtaining another provider or masking an automatic retry.
    original: Mutex<Vec<SelectedAdapter>>,
    stream: Arc<Stream>,
}
impl ModelAdapter for Adapter {
    fn metadata(&self) -> &ModelAdapterMetadata {
        &self.metadata
    }
    fn bind(
        &self,
        configuration: &varin_runtime::ModelSessionConfiguration,
        mut connection: Connection,
    ) -> Result<Arc<dyn ModelProvider>, ExecutionError> {
        connection.transport = self.stream.clone();
        self.original
            .lock()
            .unwrap()
            .pop()
            .expect("unexpected sampling provider binding")
            .bind(configuration, connection)
    }
}
struct RegistryGuard(Option<ModelAdapterRegistry>);
impl Drop for RegistryGuard {
    fn drop(&mut self) {
        *model_adapters().write().unwrap() = self.0.take().unwrap();
    }
}
fn install_stream() -> (Arc<Stream>, RegistryGuard) {
    let configuration: varin_runtime::ModelSessionConfiguration = serde_json::from_value(json!({
        "providerFamily":"openai-responses","model":"reviewed-model","endpoint":"https://sampling-model.invalid/v1/responses",
        "allowAnonymous":false,"configurationGeneration":1,"maxOutputTokens":500
    })).unwrap();
    let stream = Arc::new(Stream::default());
    let mut registry = model_adapters().write().unwrap();
    // Four cases, with a possible preparation and execution binding each. The original registry
    // is restored when this ignored serial composition ends, including on an assertion failure.
    let original = (0..8)
        .map(|_| registry.select(&configuration).unwrap())
        .collect();
    let mut controlled = ModelAdapterRegistry::default();
    controlled
        .publish(
            0,
            vec![Arc::new(Adapter {
                metadata: ModelAdapterMetadata {
                    id: "openai-responses".into(),
                    version: "1".into(),
                    contract_version: MODEL_ADAPTER_CONTRACT,
                    protocol_family: "openai-responses".into(),
                },
                original: Mutex::new(original),
                stream: stream.clone(),
            })],
        )
        .unwrap();
    let original = std::mem::replace(&mut *registry, controlled);
    (stream, RegistryGuard(Some(original)))
}
fn call(f: &mut InteractionExecution, mut action: Value) -> Value {
    action["kind"] = json!("fixture-interaction-consumer");
    action["threadId"] = json!("thread:interaction");
    action["branchId"] = json!("branch:interaction");
    f.host.send(action);
    receive(
        &mut f.host,
        &f.runtime,
        &f.bridge,
        &f.outgoing,
        "fixture-interaction-consumer-result",
    )
}
fn success(f: &mut InteractionExecution, action: Value) -> Value {
    let response = call(f, action);
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}
fn one_card(f: &mut InteractionExecution) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            Instant::now() < deadline,
            "original sampling card did not publish"
        );
        let page = success(f, json!({"action":"list"}));
        if let Some(card) = page["items"].as_array().unwrap().first() {
            assert_eq!(card["record"]["mode"], "sampling");
            assert!(
                card.get("request").is_none() && card.get("sampling").is_none(),
                "pages must not copy sampling bodies"
            );
            return card.clone();
        }
    }
}
fn action(card: &Value, kind: &str, choice: &str) -> Value {
    json!({"action":kind,"choice":choice,"operationId":card["record"]["binding"]["operationId"],
        "interactionId":card["record"]["id"],"expectedRevision":card["record"]["revision"]})
}
fn generate(f: &mut InteractionExecution, card: &Value, request: Value) -> Value {
    let mut input = action(card, "sampling-request", "generate");
    input["editedRequest"] = request;
    input["model"] = json!({"providerId":"sampling-fixture","modelId":"reviewed-model"});
    success(f, input)
}
fn wait_output(f: &mut InteractionExecution, card: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            Instant::now() < deadline,
            "original sampling model did not reach output review"
        );
        let view = f.read(card);
        if view["record"]["sampling"]["review"] == "output" {
            return view;
        }
        assert_ne!(
            view["generation"]["phase"], "terminal",
            "generation ended before output review: {view}"
        );
    }
}

#[test]
#[ignore = "requires built workspace Node/MCP; original stdio or in-memory HTTP plus controlled provider stream; no product socket"]
fn original_mcp_sampling_reviews_bind_real_model_operations_credentials_and_exact_replies() {
    let (stream, _registry) = install_stream();
    for (index, (mode, tool, scenario)) in [
        ("http", "ordinary", "sampling-reviewed"),
        ("stdio", "deferred", "sampling-retired-parent"),
        ("http", "ordinary", "sampling-declined-output"),
        ("http", "ordinary", "sampling-stopped-generation"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut f = InteractionExecution::with_sampling(mode, tool, scenario, true);
        if tool == "deferred" {
            assert_eq!(f.run_finished(), RunState::Completed);
        }
        let mut card = one_card(&mut f);
        let original = f.read(&card);
        let acceptance = (tool == "deferred").then(|| f.operation(&card).call_completion);
        let before = stream.requests.lock().unwrap().len();
        assert_eq!(
            before, index,
            "request review must precede provider dispatch"
        );
        let mut reviewed = original["request"].clone();
        reviewed["systemPrompt"] = json!("User-reviewed isolated sampling instruction");
        reviewed["messages"][0]["content"] = json!([
            {"type":"text","text":if scenario == "sampling-stopped-generation" {"HOLD_REVIEWED_GENERATION"} else {"Edited sampling message"}},
            {"type":"image","data":PIXEL,"mimeType":"image/png"}
        ]);
        let old_attempt = if index == 0 {
            let mut unsupported = reviewed.clone();
            unsupported["metadata"] = json!({"trace":"UNSUPPORTED_PROVIDER_METADATA_SENTINEL"});
            let bad = generate(&mut f, &card, unsupported);
            let previous = bad["record"]["sampling"]["generationOperationId"]
                .as_str()
                .unwrap()
                .to_owned();
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                assert!(
                    Instant::now() < deadline,
                    "unsupported request did not return to editable review"
                );
                let current = f.read(&card);
                if current["generation"]["phase"] == "terminal" {
                    assert_eq!(current["record"]["sampling"]["review"], "request");
                    assert_eq!(current["generation"]["dispatch"], "not_started");
                    assert_eq!(stream.requests.lock().unwrap().len(), before);
                    card = current;
                    break;
                }
            }
            Some(previous)
        } else {
            None
        };
        let approved = generate(&mut f, &card, reviewed.clone());
        let generation = approved["record"]["sampling"]["generationOperationId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(
            generation,
            card["record"]["binding"]["operationId"].as_str().unwrap()
        );
        if tool == "deferred" {
            let run_id = f.run_id.clone();
            let retired = success(&mut f, json!({"action":"run","runId":run_id}));
            assert_eq!(
                retired["state"], "completed",
                "retired Run cleanup must not revoke the new operation credential lease"
            );
        }
        if scenario == "sampling-stopped-generation" {
            let deadline = Instant::now() + Duration::from_secs(30);
            while stream.requests.lock().unwrap().len() == before {
                assert!(Instant::now() < deadline);
                let _ = f.read(&card);
            }
            let _receipt = success(
                &mut f,
                json!({"action":"cancel-generation","generationOperationId":generation}),
            );
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                assert!(Instant::now() < deadline);
                let view = f.read(&card);
                if view["generation"]["phase"] == "terminal" {
                    assert_eq!(view["generation"]["dispatch"], "interrupted");
                    assert_eq!(view["generation"]["usage"]["measurement"], "missing");
                    break;
                }
            }
            assert_eq!(stream.cancelled.load(Ordering::SeqCst), 1);
        } else {
            let output = wait_output(&mut f, &card);
            assert_eq!(
                output["request"], original["request"],
                "editing cannot overwrite the original remote request"
            );
            assert_eq!(output["sampling"]["editedRequest"], reviewed);
            assert!(
                output["sampling"]["providerOutput"]
                    .to_string()
                    .contains("opaqueOriginal"),
                "original provider item must survive response selection"
            );
            assert_eq!(output["generation"]["model"]["model"], "reviewed-model");
            assert_eq!(output["generation"]["model"]["maxTokens"], 64);
            assert_eq!(output["generation"]["usage"]["measurement"], "actual");
            assert_eq!(output["generation"]["usage"]["inputTokens"], 17);
            assert_eq!(
                output["record"]["delivery"], "not_started",
                "generation completion cannot send before output review"
            );
            let choice = if scenario == "sampling-declined-output" {
                "decline"
            } else {
                "accept"
            };
            success(&mut f, action(&output, "sampling-output", choice));
        }
        if tool == "ordinary" {
            assert_eq!(f.run_finished(), RunState::Completed);
        }
        if tool == "deferred" {
            let parent = card["record"]["binding"]["operationId"]
                .as_str()
                .unwrap()
                .to_owned();
            let runtime = f.runtime.clone();
            f.host.until(&f.runtime, &f.bridge, &f.outgoing, || {
                runtime
                    .catalog()
                    .lock()
                    .unwrap()
                    .operation(&parent)
                    .unwrap()
                    .host_job
                    .as_ref()
                    .unwrap()
                    .mcp_task
                    .as_ref()
                    .unwrap()
                    .result_ready
            });
            assert_eq!(
                f.operation(&card).call_completion,
                acceptance.unwrap(),
                "sampling must not rewrite original Task acceptance"
            );
        }
        if let Some(old) = old_attempt {
            let old = success(
                &mut f,
                json!({"action":"operation","generationOperationId":old}),
            );
            assert!(
                old.to_string()
                    .contains("UNSUPPORTED_PROVIDER_METADATA_SENTINEL"),
                "correcting the request must not make the old operation's reviewed body unreadable"
            );
        }
        let saved = f.read(&card);
        let finished = f.finish();
        let requests = finished["requests"].as_array().unwrap();
        let initialized = requests
            .iter()
            .find(|q| q["method"] == "initialize")
            .unwrap();
        assert_eq!(
            initialized["params"]["capabilities"]["sampling"],
            json!({}),
            "the actual client advertises only implemented basic sampling"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|q| q["method"] == "tools/call")
                .count(),
            1
        );
        let replies: Vec<_> = requests
            .iter()
            .filter(|q| q.get("method").is_none() && q.get("id").is_some())
            .collect();
        assert_eq!(
            replies.len(),
            1,
            "the original sampling request receives exactly one answer"
        );
        if scenario == "sampling-declined-output" || scenario == "sampling-stopped-generation" {
            assert!(
                replies[0].get("error").is_some(),
                "declining/stopping must not leak a generated answer"
            );
        } else {
            assert_eq!(replies[0]["result"]["model"], "reviewed-model");
            assert!(replies[0]["result"]["content"].to_string().contains(ANSWER));
        }
        assert_eq!(
            stream.requests.lock().unwrap().len(),
            before + 1,
            "review, cancellation and final delivery never replay generation"
        );
        let body = stream.requests.lock().unwrap()[before].clone();
        assert_eq!(body["model"], "reviewed-model");
        assert_eq!(body["max_output_tokens"], 64);
        assert_eq!(body["temperature"], 0.25);
        let sent = body.to_string();
        assert!(
            sent.contains("User-reviewed isolated sampling instruction")
                && sent.contains("Server supplied assistant context")
                && sent.contains(PIXEL)
        );
        assert!(
            !sent.contains("Use the original receiver; retain errors without replay"),
            "main user history leaked into isolated sampling"
        );
        assert!(body["tools"].as_array().is_none_or(Vec::is_empty));
        assert!(!sent.contains("fixture-only-sampling-credential"));
        f.runtime.shutdown().unwrap();
        let pass = f
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default());
        assert_eq!(
            pass.run().status,
            varin_runtime::ContentCollectionStatus::Completed
        );
        let root = f.root.clone();
        drop(f);
        let reopened = Catalog::open(root.join("catalog")).unwrap();
        let restored = serde_json::to_value(
            reopened
                .capture_mcp_interaction(
                    card["record"]["binding"]["operationId"].as_str().unwrap(),
                    card["record"]["id"].as_str().unwrap(),
                )
                .unwrap()
                .load()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(restored["request"], saved["request"]);
        assert_eq!(
            restored["sampling"], saved["sampling"],
            "GC/reopen must preserve reviewed request, original model output and receipt"
        );
        assert_eq!(restored["generation"], saved["generation"]);
    }
}
