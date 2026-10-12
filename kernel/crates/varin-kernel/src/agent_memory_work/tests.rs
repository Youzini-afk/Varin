//! Original Bot/MemoryService and native adapter over the existing stdio Host fixture.
//! Only outbound HTTP bytes are controlled; no listener or paid model is used.
use super::super::web_domain_review::{Fixture, Host, EPOCH, HOST};
use super::super::*;
use crate::{credential_bridge::CredentialBridge, host_tools::ToolBridge, storage::Storage};
use std::sync::Condvar;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::providers::{
    registry::{
        model_adapters, ModelAdapter, ModelAdapterMetadata, ModelAdapterRegistry,
        MODEL_ADAPTER_CONTRACT,
    },
    Connection, HttpRequest, HttpTransport,
};

const TEXT: &str = "Always document the exact recovery evidence before marking a task finished.";
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
        assert_eq!(request.endpoint, "https://memory.invalid/v1/responses");
        assert_eq!(
            request.headers["authorization"],
            "Bearer controlled-memory-fixture-key"
        );
        assert_eq!(
            request.body["model"],
            if self.mode.starts_with("selection") {
                "configured-organizer"
            } else {
                "bot-profile-model"
            }
        );
        assert!(request.body.to_string().contains(TEXT));
        assert!(request
            .body
            .get("tools")
            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)));
        let request_number = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request.body.clone());
            requests.len()
        };
        if self.mode == "cancel" {
            let event = json!({"type":"response.output_text.delta","item_id":"original-memory-item","delta":"original partial memory"});
            receive(format!("data: {event}\n\n").as_bytes())?;
            let (send, recv) = mpsc::sync_channel(1);
            let _watch = cancel.wake_on_cancel(send);
            self.events.send(json!({"kind":"native-entered"})).unwrap();
            recv.recv_timeout(Duration::from_secs(30))
                .expect("real Bot Sleep must reach original provider");
            self.events
                .send(json!({"kind":"native-cancelled"}))
                .unwrap();
        } else {
            self.events.send(json!({"kind":"native-entered"})).unwrap();
        }
        if self.mode == "cancel" || self.mode == "selection-inflight" {
            let released = self.released.lock().unwrap();
            let (released, timeout) = self
                .wake
                .wait_timeout_while(released, Duration::from_secs(30), |v| !*v)
                .unwrap();
            assert!(
                *released && !timeout.timed_out(),
                "test must explicitly release original body drain"
            );
        }
        if self.mode == "cancel" {
            return Err(ModelFailure {
                code: "cancelled".into(),
                message: "Original body stopped".into(),
                retry_after_ms: None,
                provider_request_id: None,
            });
        }
        let answer = if self.mode.starts_with("selection") {
            json!({"memories":[{"content":"Keep exact recovery evidence","trigger":"When marking a task finished","nature":"preference","source":"s0","quote":TEXT}]})
        } else {
            json!({"memories":[{"action":"new","scope":"bot","nature":"decision","content":"Keep exact recovery evidence","trigger":"When marking a task finished","source":"u0","quote":TEXT}]})
        };
        let truncated = self.mode == "selection-length" && request_number == 1;
        let mut event = json!({"type":if truncated {"response.incomplete"} else {"response.completed"},"response":{"id":"original-memory-response","status":if truncated {"incomplete"} else {"completed"},
            "output":[{"id":"original-memory-item","type":"message","role":"assistant","content":[{"type":"output_text","text":answer.to_string()}],"originalRaw":{"empty":[],"nullable":null}}],
            "usage":{"input_tokens":19,"output_tokens":7,"input_tokens_details":{"cached_tokens":3}}}});
        if truncated {
            event["response"]["incomplete_details"] = json!({"reason":"max_output_tokens"});
        }
        for bytes in format!("data: {event}\n\n").as_bytes().chunks(17) {
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
        self.original
            .lock()
            .unwrap()
            .select(configuration)?
            .bind(configuration, connection)
    }
}
struct RegistryGuard(Arc<Mutex<ModelAdapterRegistry>>);
impl Drop for RegistryGuard {
    fn drop(&mut self) {
        *model_adapters().write().unwrap() = std::mem::take(&mut *self.0.lock().unwrap());
    }
}
fn install(mode: &str) -> (Arc<Stream>, mpsc::Receiver<Value>, RegistryGuard) {
    let (send, events) = mpsc::sync_channel(16);
    let stream = Arc::new(Stream {
        mode: mode.into(),
        requests: Mutex::new(vec![]),
        events: send,
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
    (stream, events, RegistryGuard(original))
}
struct Review {
    f: Fixture,
    credentials: CredentialBridge,
    cursor: u64,
    root: PathBuf,
    mode: String,
}
impl Review {
    fn new(mode: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-bot-memory-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let runtime = Arc::new(RunSupervisor::new(
            Catalog::open(root.join("catalog")).unwrap(),
        ));
        let (send, outgoing) = mpsc::sync_channel(64);
        let bridge = ToolBridge::new(send.clone().into());
        bridge.initialize(EPOCH);
        let credentials = CredentialBridge::new(send);
        credentials.initialize(EPOCH).unwrap();
        let storage_root = root.join("storage");
        let mut f = Fixture {
            host: Host::with_script(
                "packages/web/application-host/lib/kernel/bot-memory-host.test-helper.ts",
            ),
            runtime,
            storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
            storage_root,
            bridge,
            outgoing,
        };
        f.host.send(json!({"kind":"fixture-initialize","root":root,"storageRoot":f.storage_root,"epoch":EPOCH,"mode":mode}));
        let mut review = Self {
            f,
            credentials,
            cursor: 0,
            root,
            mode: mode.into(),
        };
        review.receive("fixture-prepared");
        review
    }
    fn reopen(&mut self) {
        self.f.host = Host::with_script(
            "packages/web/application-host/lib/kernel/bot-memory-host.test-helper.ts",
        );
        self.cursor = 0;
        self.f.host.send(json!({"kind":"fixture-initialize","root":self.root,"storageRoot":self.f.storage_root,"epoch":EPOCH,"mode":self.mode,"reopen":true}));
        self.receive("fixture-prepared");
    }
    fn receive_any(&mut self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(
                Instant::now() < deadline,
                "original consumer did not settle"
            );
            if let Some(frame) = self.pump() {
                return frame;
            }
        }
    }
    fn pump(&mut self) -> Option<Value> {
        let cursor = self
            .f
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .event_cursor()
            .unwrap();
        if cursor != self.cursor {
            self.cursor = cursor;
            self.f.host.send(json!({"v":crate::protocol::PROTOCOL_VERSION,"kind":"runtime-event","kernelEpoch":EPOCH,"stream":"durable","cursor":cursor}));
        }
        let runtime = self.f.runtime.clone();
        let credentials = self.credentials.clone();
        let frame = self.f.pump_dispatch(
            |frame| {
                let method = frame["method"].as_str().unwrap();
                let params = frame["params"].clone();
                if method.starts_with("runtime.memory_work.") {
                    Some(memory_work_commands::execute(
                        runtime.clone(),
                        method,
                        params,
                        &AtomicBool::new(false),
                    ))
                } else if method == "runtime.inference.generate" {
                    Some(inference_generation_commands::generate(
                        runtime.clone(),
                        credentials.clone(),
                        params,
                        &AtomicBool::new(false),
                    ))
                } else {
                    None
                }
            },
            |_, _| true,
        );
        if let Some(frame) = frame {
            if frame["kind"] == "credential-response" {
                self.credentials.receive(frame);
                None
            } else {
                Some(frame)
            }
        } else {
            None
        }
    }
    fn receive(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(
                Instant::now() < deadline,
                "Bot memory lifecycle stalled waiting for {kind}"
            );
            if let Some(frame) = self.pump() {
                assert_eq!(frame["kind"], kind, "{frame}");
                return frame;
            }
        }
    }
    fn native(&mut self, events: &mpsc::Receiver<Value>, kind: &str) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(
                Instant::now() < deadline,
                "native memory did not reach {kind}"
            );
            if let Ok(frame) = events.try_recv() {
                assert_eq!(frame["kind"], kind);
                return;
            }
            let frame = self.pump();
            assert!(
                frame.is_none(),
                "consumer completed while waiting for {kind}: {frame:?}"
            );
        }
    }
    fn close(mut self) {
        self.f.host.send(json!({"kind":"fixture-close"}));
        self.receive("fixture-closed");
        self.credentials.close();
    }
}
#[test]
#[ignore = "original Bot/Host/Knowledge/native-adapter stdio combination; no external model or listener"]
fn bot_memory_uses_original_owner_credentials_receipts_and_sleep_drain() {
    for mode in [
        "automatic",
        "automatic-decision",
        "selection",
        "selection-inflight",
        "cancel",
    ] {
        eprintln!("Bot memory scenario: {mode}");
        let (stream, events, _registry) = install(mode);
        let mut review = Review::new(mode);
        review.f.host.send(json!({"kind":"fixture-run"}));
        if mode == "cancel" {
            review.native(&events, "native-entered");
            // A broken large body must not prevent the original short control path from cancelling.
            let (work_id, recipe_path) = {
                let catalog = review.f.runtime.catalog();
                let db = catalog.lock().unwrap();
                let event = db
                    .events_after(0, 1000)
                    .unwrap()
                    .into_iter()
                    .find(|e| e.kind == "memory.work.admitted")
                    .unwrap();
                let operation = db.operation(&event.subject).unwrap();
                let path = varin_runtime::content::object_path(
                    &review.root.join("catalog/content"),
                    operation.intent["recipeRef"]["content_object"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                (operation.id, path)
            };
            let recipe_bytes = std::fs::read(&recipe_path).unwrap();
            std::fs::remove_file(&recipe_path).unwrap();
            assert!(review
                .f
                .runtime
                .catalog()
                .lock()
                .unwrap()
                .capture_memory_work(&work_id)
                .unwrap()
                .load()
                .is_err());
            review.f.host.send(json!({"kind":"fixture-sleep"}));
            review.native(&events, "native-cancelled");
            std::fs::write(recipe_path, recipe_bytes).unwrap();
            for _ in 0..5 {
                assert!(review.pump().is_none(), "Sleep must await real body drain");
            }
            stream.release();
            let mut results = vec![];
            while results.len() < 2 {
                results.push(review.receive_any());
            }
            let sleep = results
                .iter()
                .find(|f| f["kind"] == "fixture-sleep-result")
                .unwrap();
            assert_eq!(sleep["bot"]["activity"]["state"], "asleep");
            assert!(sleep["memories"].as_array().unwrap().is_empty());
            let inference = &sleep["works"][0]["inference"][0];
            assert_eq!(inference["effect"], "unknown");
            assert_eq!(
                inference["result"]["value"]["receipt"]["localExecutorStopped"],
                true
            );
            assert!(
                inference["result"]["value"]["response"]["providerOutput"]["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["kind"] == "text_delta"
                        && event["text"] == "original partial memory")
            );
        } else {
            if mode == "selection-inflight" {
                review.native(&events, "native-entered");
                review
                    .f
                    .host
                    .send(json!({"kind":"fixture-selection","requestKey":"selection-original"}));
                for _ in 0..10 {
                    assert!(review.pump().is_none());
                }
                stream.release();
            }
            let mut results = vec![];
            let count = if mode == "selection-inflight" { 2 } else { 1 };
            while results.len() < count {
                results.push(review.receive_any());
            }
            let result = &results[0];
            assert_eq!(result["errors"], json!([]), "{result}");
            if mode.starts_with("selection") {
                for result in &results {
                    assert_eq!(result["status"], 200, "{result}");
                    assert_eq!(result["body"]["drafts"].as_array().unwrap().len(), 1);
                    assert!(result["memories"].as_array().unwrap().is_empty());
                }
                review
                    .f
                    .host
                    .send(json!({"kind":"fixture-selection","requestKey":"selection-original"}));
                let observed = review.receive("fixture-selection-result");
                assert_eq!(observed["status"], 200, "{observed}");
                review.f.host.send(json!({"kind":"fixture-save"}));
                let saved = review.receive("fixture-saved");
                assert_eq!(saved["status"], 201, "{saved}");
                assert_eq!(saved["body"]["created"], true, "{saved}");
                assert_eq!(saved["memories"].as_array().unwrap().len(), 1);
                review.f.host.send(json!({"kind":"fixture-disable"}));
                review.receive("fixture-disabled");
                review
                    .f
                    .host
                    .send(json!({"kind":"fixture-selection","requestKey":"selection-original"}));
                assert_ne!(review.receive("fixture-selection-result")["status"], 200);
            } else {
                assert_eq!(result["memories"].as_array().unwrap().len(), 1, "{result}");
                assert_eq!(result["rows"][0]["status"], "formed");
            }
            let work = &result["works"][0];
            let child = work["inference"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["intent"]["binding"]["purpose"] == "memory-organizer")
                .unwrap();
            if mode == "automatic-decision" {
                assert_eq!(result["decisionRequests"], 1);
                let decision = work["inference"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|op| op["intent"]["binding"]["purpose"] == "memory-organization")
                    .unwrap();
                assert_eq!(decision["outcome"], "succeeded");
                assert_eq!(
                    decision["result"]["value"]["receipt"]["usage"]["inputTokens"],
                    11
                );
                assert_ne!(decision["id"], child["id"]);
                assert_eq!(decision["run_id"], child["run_id"]);
            }
            assert_eq!(child["outcome"], "succeeded");
            assert_eq!(
                child["result"]["value"]["receipt"]["usage"]["inputTokens"],
                19
            );
            assert_eq!(
                child["result"]["value"]["response"]["providerOutput"]["finishReason"],
                "stop"
            );
            assert!(child["intent"]["goal"].is_null());
            assert!(child.to_string().contains("originalRaw"));
            assert!(!child.to_string().contains("controlled-memory-fixture-key"));
        }
        assert_eq!(
            stream.requests.lock().unwrap().len(),
            1,
            "same identity cannot make another paid request: {mode}"
        );
        review.close();
    }
}

#[test]
#[ignore = "original Host restart, ContentStore batch and provider receipts over stdio; no external model"]
fn bot_memory_recovers_original_outputs_and_decisions_without_replaying_transport() {
    for mode in ["recover-output", "recover-decision"] {
        let (stream, _events, _registry) = install(mode);
        let mut review = Review::new(mode);
        review.f.host.send(json!({"kind":"fixture-run"}));
        let boundary = review.receive(if mode == "recover-output" {
            "fixture-before-prepared"
        } else {
            "fixture-before-decision"
        });
        let id = boundary["workId"].as_str().unwrap();
        let original = review
            .f
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .capture_memory_work(id)
            .unwrap()
            .load()
            .unwrap();
        assert!(!original.consumed);
        assert_eq!(original.inference.len(), 1);
        assert_eq!(
            original.inference[0].outcome,
            Some(varin_runtime::Outcome::Succeeded)
        );
        review.reopen();
        review.f.host.send(json!({"kind":"fixture-run"}));
        let recovered = review.receive("fixture-result");
        assert_eq!(recovered["errors"], json!([]), "{recovered}");
        let work = &recovered["works"][0];
        assert_eq!(work["recipe"], original.recipe);
        assert_eq!(work["workId"], id);
        assert_eq!(
            work["inference"],
            serde_json::to_value(original.inference).unwrap()
        );
        assert_eq!(work["consumed"], true);
        assert_eq!(recovered["decisionRequests"], 0);
        if mode == "recover-output" {
            assert_eq!(recovered["rows"][0]["status"], "formed");
            assert_eq!(recovered["memories"].as_array().unwrap().len(), 1);
            assert_eq!(stream.requests.lock().unwrap().len(), 1);
        } else {
            assert_eq!(work["decision"], json!([]));
            assert_eq!(recovered["rows"][0]["status"], "reviewed-empty");
            assert!(recovered["memories"].as_array().unwrap().is_empty());
            assert!(stream.requests.lock().unwrap().is_empty());
        }
        review.close();
    }
}

#[test]
#[ignore = "original selection receipt and explicit Retry over stdio; no external model or listener"]
fn bot_memory_retains_length_evidence_and_requires_explicit_linked_retry() {
    let (stream, _events, _registry) = install("selection-length");
    let mut review = Review::new("selection-length");
    review.f.host.send(json!({"kind":"fixture-run"}));
    let failed = review.receive("fixture-result");
    assert_ne!(failed["status"], 200, "{failed}");
    assert!(failed["body"]["drafts"].is_null());
    assert_eq!(failed["body"]["retryDisposition"], "new_attempt");
    assert!(failed["memories"].as_array().unwrap().is_empty());
    let original = &failed["works"][0];
    let child = &original["inference"][0];
    assert_eq!(child["outcome"], "failed");
    let receipt = &child["result"]["value"]["receipt"];
    assert_eq!(receipt["providerCompleted"], true);
    assert_eq!(receipt["localExecutorStopped"], true);
    assert_eq!(receipt["usage"]["inputTokens"], 19);
    assert_eq!(receipt["usage"]["outputTokens"], 7);
    let response = &child["result"]["value"]["response"];
    assert_eq!(response["providerOutput"]["finishReason"], "length");
    assert!(response["text"].is_null());
    let valid_json: Value = serde_json::from_str(
        response["providerOutput"]["items"][0]["content"]["text"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(valid_json["memories"].as_array().unwrap().len(), 1);
    assert!(response.to_string().contains("originalRaw"));
    assert_eq!(stream.requests.lock().unwrap().len(), 1);

    review
        .f
        .host
        .send(json!({"kind":"fixture-selection","requestKey":"selection-original"}));
    let observed = review.receive("fixture-selection-result");
    assert_ne!(observed["status"], 200, "{observed}");
    assert_eq!(observed["body"]["retryDisposition"], "new_attempt");
    assert!(observed["body"]["drafts"].is_null());
    assert_eq!(observed["works"][0]["inference"], original["inference"]);
    assert_eq!(stream.requests.lock().unwrap().len(), 1);

    review.f.host.send(json!({"kind":"fixture-selection","requestKey":"selection-second","retryOf":"selection-original"}));
    let retried = review.receive("fixture-selection-result");
    assert_eq!(retried["status"], 200, "{retried}");
    assert_eq!(retried["body"]["drafts"].as_array().unwrap().len(), 1);
    assert!(retried["memories"].as_array().unwrap().is_empty());
    let works = retried["works"].as_array().unwrap();
    assert_eq!(works.len(), 2);
    let retained = works
        .iter()
        .find(|work| work["workId"] == original["workId"])
        .unwrap();
    assert_eq!(retained["inference"], original["inference"]);
    let next = works
        .iter()
        .find(|work| work["workId"] != original["workId"])
        .unwrap();
    assert_eq!(next["inference"][0]["outcome"], "succeeded");
    assert_eq!(
        next["inference"][0]["result"]["value"]["response"]["providerOutput"]["finishReason"],
        "stop"
    );
    let intent = review
        .f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(next["workId"].as_str().unwrap())
        .unwrap()
        .intent;
    assert_eq!(intent["retryOf"], original["workId"]);
    assert_eq!(stream.requests.lock().unwrap().len(), 2);
    review.close();
}
