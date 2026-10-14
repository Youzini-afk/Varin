//! Real native adapter, private credentials and original query/Storage over test-only stdio.
use super::*;
use std::sync::Condvar;
use varin_runtime::providers::{
    Connection, HttpRequest, HttpTransport,
    registry::{
        MODEL_ADAPTER_CONTRACT, ModelAdapter, ModelAdapterMetadata, ModelAdapterRegistry,
        model_adapters,
    },
};
struct Stream {
    mode: String,
    requests: Mutex<Vec<Value>>,
    events: mpsc::SyncSender<Value>,
    released: Mutex<bool>,
    wake: Condvar,
}
impl Stream {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
impl HttpTransport for Stream {
    fn stream(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        assert_eq!(request.endpoint, "https://explore.invalid/v1/responses");
        assert_eq!(
            request.headers["authorization"],
            "Bearer controlled-explore-key"
        );
        let body = request.body.to_value();
        assert_eq!(body["model"], "explore-model");
        assert!(!request.body.to_string().contains("FORBIDDEN_SOURCE"));
        assert!(!request.body.to_string().contains("private/secret.ts"));
        assert!(request
            .body
            .get("tools")
            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)));
        let ordinal = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(body.clone());
            requests.len() as u64
        };
        if self.mode == "llm-stop" {
            self.events
                .send(json!({"kind":"fixture-native-request"}))
                .unwrap();
            let (wake, wait) = mpsc::sync_channel(1);
            let _watch = cancel.wake_on_cancel(wake);
            wait.recv_timeout(Duration::from_secs(30))
                .expect("public Stop must reach the exact native transport");
            self.events
                .send(json!({"kind":"fixture-native-body-cancelled"}))
                .unwrap();
            let released = self.released.lock().unwrap();
            let (released, timeout) = self
                .wake
                .wait_timeout_while(released, Duration::from_secs(30), |v| !*v)
                .unwrap();
            assert!(
                *released && !timeout.timed_out(),
                "actual native transport must remain held until test releases it"
            );
            return Err(ModelFailure {
                code: "cancelled".into(),
                message: "Original native body drained".into(),
                retry_after_ms: None,
                provider_request_id: None,
            });
        }
        let mut text = String::new();
        if let Some(items) = body["input"].as_array() {
            for item in items {
                if let Some(content) = item["content"].as_array() {
                    for part in content {
                        if let Some(value) = part["text"].as_str() {
                            text.push_str(value);
                            text.push('\n');
                        }
                    }
                } else if let Some(value) = item["content"].as_str() {
                    text.push_str(value);
                    text.push('\n');
                }
            }
        }
        let planning = request
            .body
            .to_string()
            .contains("Plan grouped search expressions");
        let helper = text.contains("DISCOVERED_HELPER");
        let answer = if planning {
            json!({"behavior":"Trace actual retrieval dependency","groups":[{"id":"seed","concept":"entry","expressions":["retrievalNeedle"]}]}).to_string()
        } else if self.mode == "llm-partial" && helper {
            "invalid later original model response".into()
        } else {
            let mut ids = BTreeSet::new();
            for line in text.lines() {
                if let Some(view) = line.strip_prefix("view ") {
                    let mut words = view.split_whitespace();
                    let id = words.next().unwrap();
                    let location = words.next().unwrap();
                    if location.starts_with("allowed/") {
                        ids.insert(id.to_string());
                    }
                }
            }
            assert!(
                !ids.is_empty(),
                "actual source views reached joint selection: {text}"
            );
            let groups = if self.mode == "llm-empty" && helper {
                vec![]
            } else {
                vec![
                    json!({"id":"joint","purpose":"Required original evidence","views":ids.iter().map(|id|json!({"viewId":id,"required":true})).collect::<Vec<_>>()}),
                ]
            };
            json!({"groups":groups,"done":helper,"actionIds":["symbol:hiddenHelper","read:allowed/helper.ts","read:private/secret.ts"],
                "followup":if helper {Value::Null} else {json!({"searches":[{"expression":"hiddenHelper"}]})}}).to_string()
        };
        let usage = if self.mode == "llm-unknown" {
            json!({"input_tokens":11 * ordinal})
        } else {
            json!({"input_tokens":11 * ordinal,"output_tokens":2 * ordinal,"input_tokens_details":{"cached_tokens":3}})
        };
        let event = json!({"type":"response.completed","response":{"id":format!("explore-response:{ordinal}"),"status":"completed",
            "output":[{"id":format!("explore-item:{ordinal}"),"type":"message","role":"assistant","content":[{"type":"output_text","text":answer}],"opaqueOriginal":{"nullable":null,"empty":[]}}],"usage":usage}});
        for bytes in format!("data: {event}\n\n").as_bytes().chunks(11) {
            if receive(bytes)? {
                break;
            }
        }
        Ok(())
    }
}
struct Adapter {
    metadata: ModelAdapterMetadata,
    original: Arc<Mutex<ModelAdapterRegistry>>,
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
        let selected = self.original.lock().unwrap().select(configuration)?;
        selected.bind(configuration, connection)
    }
}
struct RegistryGuard(Arc<Mutex<ModelAdapterRegistry>>);
impl Drop for RegistryGuard {
    fn drop(&mut self) {
        *model_adapters().write().unwrap() = std::mem::take(&mut *self.0.lock().unwrap());
    }
}
fn install(mode: &str, events: mpsc::SyncSender<Value>) -> (Arc<Stream>, RegistryGuard) {
    let stream = Arc::new(Stream {
        mode: mode.into(),
        requests: Mutex::new(vec![]),
        events,
        released: Mutex::new(false),
        wake: Condvar::new(),
    });
    let mut registry = model_adapters().write().unwrap();
    let original = Arc::new(Mutex::new(std::mem::take(&mut *registry)));
    registry
        .publish(
            0,
            vec![Arc::new(Adapter {
                metadata: ModelAdapterMetadata {
                    id: "openai-responses".into(),
                    version: "1".into(),
                    contract_version: MODEL_ADAPTER_CONTRACT,
                    protocol_family: "openai-responses".into(),
                },
                original: original.clone(),
                stream: stream.clone(),
            })],
        )
        .unwrap();
    (stream, RegistryGuard(original))
}
#[test]
#[ignore = "requires original native adapter/Host credentials/query and Storage over stdio; no external model"]
fn configured_explore_llm_plans_selects_and_accounts_under_the_original_query() {
    for (mode, source) in [
        ("llm-only", "live_root"),
        ("llm-auto", "live_root"),
        ("llm-empty", "live_root"),
        ("llm-partial", "live_root"),
        ("llm-stale", "live_root"),
        ("llm-unknown", "live_root"),
        ("llm-only", "fixed_branch"),
        ("llm-only", "materialized"),
    ] {
        let mut review = Review::with_source(mode, source);
        // Controlled provider observations share only the existing delivery channel.
        let (send, events) = mpsc::sync_channel(16);
        let (stream, guard) = install(mode, send);
        let counts = review.execute(false);
        assert!(events.try_recv().is_err());
        let requests = stream.requests.lock().unwrap().clone();
        assert!(
            !requests.is_empty(),
            "the configured native model actually executed: mode={mode}, counts={counts}"
        );
        let count = requests.len() as u64;
        if mode == "llm-unknown" {
            assert_eq!(count, 1);
        } else {
            assert!(count >= 2);
        }
        assert!(requests[0]
            .to_string()
            .contains("Plan grouped search expressions"));
        if mode == "llm-auto" {
            assert!(
                counts["requests"].as_u64().unwrap() > 0,
                "ready classifier action duty must coexist"
            );
        } else {
            assert_eq!(counts["requests"], 0);
        }
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        let history = db.execution_history("branch:parent").unwrap();
        let result = history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == "retrieve" => {
                    match &result.completion {
                        ToolCompletion::Result { content, .. } => Some(&content.data),
                        _ => None,
                    }
                }
                _ => None,
            })
            .unwrap();
        assert!(!result.to_string().contains("FORBIDDEN_SOURCE"));
        assert!(!result.to_string().contains("WRONG_NEW_HEAD"));
        assert_eq!(result["source"]["mode"], source);
        let snippets = result["snippets"].as_array().unwrap();
        match mode {
            "llm-empty" | "llm-stale" => assert!(
                snippets.is_empty(),
                "explicit empty or broken required group must not leak a partial group: {result}"
            ),
            "llm-only" | "llm-auto" => {
                assert!(result.to_string().contains("allowed/seed.ts"));
                assert!(result.to_string().contains("DISCOVERED_HELPER"));
            }
            "llm-partial" => {
                assert_eq!(result["status"], "partial");
                assert!(result.to_string().contains("allowed/seed.ts"));
            }
            "llm-unknown" => assert_eq!(result["status"], "partial"),
            _ => unreachable!(),
        }
        let usage = db
            .capture_goal("rerank-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage;
        assert_eq!(usage.pending_inferences, 0);
        let mut operations = db
            .events_after(0, 10000)
            .unwrap()
            .into_iter()
            .filter(|e| e.kind == "inference.admitted")
            .map(|e| {
                db.capture_operation_read(db.operation(&e.subject).unwrap())
                    .load()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        operations.sort_by_key(|op| op.intent["ordinal"].as_u64().unwrap());
        let mut measured_input = 0;
        let mut measured_output = 0;
        let mut native = 0;
        let parent = operations[0].intent["parentOperationId"].clone();
        for (index, op) in operations.iter().enumerate() {
            assert_eq!(op.intent["parentOperationId"], parent);
            assert_eq!(op.intent["ordinal"], (index + 1) as u64);
            assert_eq!(op.phase, OperationPhase::Terminal);
            let state = op.result.as_ref().unwrap().control().unwrap();
            measured_input += state["receipt"]["usage"]["inputTokens"]
                .as_u64()
                .unwrap_or(0);
            measured_output += state["receipt"]["usage"]["outputTokens"]
                .as_u64()
                .unwrap_or(0);
            if op.executor.as_deref() == Some("inference.model.v1") {
                native += usize::from(state["receipt"]["providerCompleted"] == true);
                assert_eq!(
                    op.execution_owner,
                    Some(varin_runtime::ExecutorOwner::Kernel)
                );
                if state["receipt"]["providerCompleted"] == true {
                    assert_eq!(
                        state["response"]["snapshot"]["view"]["origin"]["kind"],
                        "auxiliary_inference"
                    );
                    assert!(state["response"]["providerOutput"]["items"]
                        .as_array()
                        .is_some_and(|a| !a.is_empty()));
                }
            }
        }
        assert_eq!(native as u64, count);
        assert_eq!(usage.actual.input_tokens.known, measured_input);
        assert_eq!(usage.actual.output_tokens.known, measured_output);
        if mode == "llm-unknown" {
            assert_eq!(usage.actual.output_tokens.unknown_receipts, 1);
        }
        drop(db);
        let collection = owner
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default());
        assert_eq!(
            collection.run().status,
            varin_runtime::ContentCollectionStatus::Completed
        );
        let root = review.root.clone();
        drop(owner);
        drop(review);
        drop(guard);
        let db = Catalog::open(root.join("catalog")).unwrap();
        assert_eq!(db.execution_history("branch:parent").unwrap(), history);
        assert_eq!(
            db.capture_goal("rerank-goal")
                .unwrap()
                .load()
                .unwrap()
                .usage,
            usage
        );
        for op in operations {
            assert_eq!(
                db.capture_operation_read(db.operation(&op.id).unwrap())
                    .load()
                    .unwrap(),
                op
            );
        }
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "requires original native model transport and public client Stop over stdio"]
fn public_query_stop_keeps_native_generation_pending_until_actual_transport_drain() {
    let mut review = Review::new("llm-stop");
    let (send, events) = mpsc::sync_channel(16);
    let (stream, guard) = install("llm-stop", send);
    review.native_events = Some(events);
    let release = stream.clone();
    review.native_release = Some(Arc::new(move || release.release()));
    let counts = review.execute(true);
    assert_eq!(counts["requests"], 0);
    assert_eq!(counts["drained"], true);
    assert_eq!(stream.requests.lock().unwrap().len(), 1);
    let owner = review.f.runtime.catalog();
    let db = owner.lock().unwrap();
    let usage = db
        .capture_goal("rerank-goal")
        .unwrap()
        .load()
        .unwrap()
        .usage;
    assert_eq!(usage.pending_inferences, 0);
    assert_eq!(usage.missing_inferences, 1);
    let event = db
        .events_after(0, 10000)
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "inference.admitted")
        .unwrap();
    let op = db
        .capture_operation_read(db.operation(&event.subject).unwrap())
        .load()
        .unwrap();
    assert_eq!(op.phase, OperationPhase::Terminal);
    assert!(op.cancel_requested);
    assert_eq!(
        op.execution_owner,
        Some(varin_runtime::ExecutorOwner::Kernel)
    );
    let state = op.result.as_ref().unwrap().control().unwrap();
    assert_eq!(state["receipt"]["localExecutorStopped"], true);
    assert!(state["response"]["text"].is_null());
    assert!(!db.execution_history("branch:parent").unwrap().iter().any(|item|matches!(&item.content,Content::ToolResult{result} if matches!(&result.completion,ToolCompletion::Result{content,..} if content.data["snippets"].as_array().is_some_and(|v|!v.is_empty())))));
    drop(db);
    drop(owner);
    let root = review.root.clone();
    drop(review);
    drop(guard);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires original semantic/decision/Explore consumers over stdio"]
fn semantic_decision_and_explore_use_one_query_session_with_contiguous_ordinals() {
    let mut review = Review::new("semantic-auto");
    let (send, events) = mpsc::sync_channel(16);
    let (stream, guard) = install("llm-auto", send);
    let counts = review.execute(false);
    assert!(events.try_recv().is_err());
    assert_eq!(counts["embeddingRequests"], 1);
    assert!(
        counts["requests"].as_u64().unwrap() > 0,
        "classifier action duty executed"
    );
    assert!(
        stream.requests.lock().unwrap().len() >= 2,
        "original Explore planner and selector executed"
    );
    let owner = review.f.runtime.catalog();
    let db = owner.lock().unwrap();
    let mut operations = db
        .events_after(0, 10000)
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "inference.admitted")
        .map(|event| {
            db.capture_operation_read(db.operation(&event.subject).unwrap())
                .load()
                .unwrap()
        })
        .collect::<Vec<_>>();
    operations.sort_by_key(|operation| operation.intent["ordinal"].as_u64().unwrap());
    assert!(operations.iter().any(
        |operation| operation.intent["binding"]["purpose"] == "code-retrieval-query-embedding"
    ));
    assert!(operations
        .iter()
        .any(|operation| operation.intent["binding"]["executor"]["api"] == "typesafe-system-one"));
    assert!(operations
        .iter()
        .any(|operation| operation.intent["binding"]["executor"]["api"] == "openai-responses"));
    for (index, operation) in operations.iter().enumerate() {
        assert_eq!(operation.intent["ordinal"], (index + 1) as u64);
        assert_eq!(
            operation.intent["parentOperationId"],
            operations[0].intent["parentOperationId"]
        );
        assert_eq!(operation.phase, OperationPhase::Terminal);
    }
    assert_eq!(
        db.capture_goal("rerank-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage
            .pending_inferences,
        0
    );
    drop(db);
    drop(owner);
    drop(guard);
    drop(stream);
    let root = review.root.clone();
    drop(review);
    std::fs::remove_dir_all(root).unwrap();
}
