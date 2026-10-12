//! Original cheap Kernel retrieval, real Storage/compute/Documents and Host inference over stdio.
use super::material_collection_review::binding;
use super::web_domain_review::{EPOCH, Fixture, GENERATION, HOST, Host};
use super::*;
use crate::host_tools::ToolBridge;
use crate::storage::Storage;
use crate::tools::{
    KernelResourceClient, KernelToolExecutor, ResourceCall, ToolBinding, ToolKind, serve_resource,
};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use varin_runtime::catalog::goals::*;
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{OperationPhase, RunState};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;
struct Model;
impl ModelProvider for Model {
    fn serialize(&self, _: &RequestView) -> Result<Value, ExecutionError> {
        Ok(json!({}))
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        emit(ProviderEvent::Usage {
            receipt: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                input_tokens: Some(0),
                output_tokens: Some(0),
                ..Default::default()
            },
        })
        .unwrap();
        if request.view.history.iter().any(|item|matches!(&item.content,Content::ToolResult{result} if result.call_id=="retrieve")) {return Ok(FinishReason::Stop);}
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == "code_retrieval")
            .unwrap();
        emit(ProviderEvent::ItemCompleted{item:ProviderItem{id:"retrieval-call".into(),opaque:None,content:Content::ToolCall{call:ToolCall{
            call_id:"retrieve".into(),name:schema.name.clone(),schema_version:schema.version.clone(),arguments:json!({"question":"retrievalNeedle","paths":["allowed"],"limit":3})}}}}).unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
struct Review {
    mode: String,
    root: PathBuf,
    f: Fixture,
    run: String,
    retrieval: crate::retrieval::RetrievalBridge,
    resources: mpsc::Receiver<ResourceCall>,
    executor: Arc<KernelToolExecutor>,
}
impl Review {
    fn new(mode: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-rerank-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut db = Catalog::open(root.join("catalog")).unwrap();
        db.create_thread("thread:parent", "branch:parent").unwrap();
        let runtime = Arc::new(RunSupervisor::new(db));
        let (output, outgoing) = mpsc::sync_channel(64);
        let bridge = ToolBridge::new(output.clone().into());
        bridge.initialize(EPOCH);
        let retrieval = crate::retrieval::RetrievalBridge::new(output);
        retrieval.initialize(EPOCH);
        let storage_root = root.join("storage");
        let mut f = Fixture {
            host: Host::with_script(
                "packages/web/application-host/lib/kernel/retrieval-rerank-host.test-helper.ts",
            ),
            runtime,
            storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
            storage_root,
            bridge,
            outgoing,
        };
        f.host.send(json!({"kind":"fixture-initialize","root":root,"storageRoot":f.storage_root,"epoch":EPOCH,"mode":mode}));
        let ready = f.receive("fixture-prepared");
        let source = &ready["source"];
        let enabled = BTreeSet::from([ToolKind::CodeRetrieval]);
        let tools = KernelToolExecutor::selected_schemas(&enabled);
        let selection:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"rerank-review","provider_family":"rerank-review","model":"script",
            "configuration_generation":1,"tool_schema_generation":1,"tools":tools,"policy":{"name":"default","version":"1"},"source":{
                "workspace_id":source["workspaceId"],"execution_workspace_id":source["executionWorkspaceId"],"mode":"live_root","live_root":source["liveRoot"]}})).unwrap();
        let run = {
            let owner = f.runtime.catalog();
            let mut db = owner.lock().unwrap();
            let receipt = db
                .submit_with_launch(
                    &SubmitInput {
                        key: "rerank-input".into(),
                        thread_id: "thread:parent".into(),
                        branch_id: "branch:parent".into(),
                        expected_head: None,
                        input: json!("Retrieve the authorized code"),
                        configuration: json!({}),
                    },
                    Some(selection),
                )
                .unwrap();
            let epoch = db.epoch();
            db.commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::StateChanged {
                    state: RunState::Runnable,
                    waiting_on: None,
                },
            )
            .unwrap();
            let prepared = db
                .prepare_goal_start(
                    "rerank-goal",
                    &receipt.run_id,
                    GoalScope {
                        thread_id: "thread:parent".into(),
                        branch_id: "branch:parent".into(),
                    },
                    "Rank source under its original scope".into(),
                    Some(GoalBudget {
                        max_output_tokens: 100,
                    }),
                )
                .unwrap()
                .load()
                .unwrap();
            db.admit_goal_mutation(prepared).unwrap();
            receipt.run_id
        };
        f.host
            .send(json!({"kind":"fixture-select","runId":run,"source":source}));
        let grant = f.receive("fixture-prepared");
        let tool_binding:ToolBinding=serde_json::from_value(json!({"grantId":grant["grantId"],"threadId":"thread:parent","runId":run,
            "workspaceId":source["workspaceId"],"executionWorkspaceId":source["executionWorkspaceId"],"rootId":source["liveRoot"]["rootId"],
            "sourceMode":"live_root","liveRoot":source["liveRoot"],"enabledTools":["code_retrieval"]})).unwrap();
        let (send, resources) = mpsc::channel();
        let client = KernelResourceClient::new(
            move |call| {
                send.send(call).map_err(|_| {
                    KernelError::Operation("retrieval resource receiver closed".into())
                })
            },
            |_| Ok(()),
            Default::default(),
        );
        let executor = Arc::new(
            KernelToolExecutor::new(tool_binding, client)
                .unwrap()
                .with_retrieval(
                    retrieval.clone(),
                    None,
                    f.runtime.catalog().lock().unwrap().nested_tools(),
                ),
        );
        Self {
            mode: mode.into(),
            root,
            f,
            run,
            retrieval,
            resources,
            executor,
        }
    }
    fn pump(&mut self) -> Option<Value> {
        while let Ok(call) = self.resources.try_recv() {
            let result = serve_resource(
                &mut self.f.storage.lock().unwrap(),
                EPOCH,
                HOST,
                GENERATION,
                &call,
            );
            call.reply.send(result).unwrap();
        }
        let value = self.f.pump()?;
        if value["kind"] == "retrieval-response" {
            if self.mode == "empty" {
                assert!(
                    value["result"]["stages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|stage| stage["kind"] == "model" && stage["status"] == "failed")
                );
            }
            self.retrieval.receive(value);
            None
        } else {
            Some(value)
        }
    }
    fn execute(&mut self, stop: bool) -> Value {
        let execution = self
            .f
            .runtime
            .start(
                &self.run,
                RunStart {
                    binding: binding(&self.f.runtime, &self.run),
                    policy_state: Value::Null,
                    provider: Arc::new(Model),
                    tools: self.executor.clone(),
                    policy: Arc::new(DefaultAgentPolicy),
                    context_preparation: Arc::new(NoopContextPreparation),
                    progress: ProgressSink::default(),
                },
            )
            .unwrap();
        let (sender, done) = mpsc::channel();
        thread::spawn(move || sender.send(execution.wait()).unwrap());
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut report = None;
        let mut barrier = false;
        loop {
            assert!(Instant::now() < deadline, "original rerank chain stalled");
            if report.is_none() {
                if let Ok(value) = done.try_recv() {
                    report = Some(value.unwrap());
                }
            }
            if let Some(frame) = self.pump() {
                assert_eq!(frame["kind"], "fixture-body-cancelled", "{frame}");
                assert!(stop);
                assert_eq!(frame["drained"], false);
                let owner = self.f.runtime.catalog();
                let db = owner.lock().unwrap();
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
                assert_ne!(
                    op.phase,
                    OperationPhase::Terminal,
                    "cancelled parent read is not stopped child transport"
                );
                let goal = db.capture_goal("rerank-goal").unwrap().load().unwrap();
                assert_eq!(goal.usage.pending_inferences, 1);
                drop(db);
                drop(owner);
                assert!(
                    op.handed_off,
                    "actual HTTP child remains with its external executor"
                );
                barrier = true;
            }
            if report.is_some() && (!stop || barrier) {
                if stop {
                    assert_eq!(report.as_ref().unwrap().state, RunState::Cancelled);
                    let owner = self.f.runtime.catalog();
                    assert_eq!(
                        owner
                            .lock()
                            .unwrap()
                            .capture_goal("rerank-goal")
                            .unwrap()
                            .load()
                            .unwrap()
                            .usage
                            .pending_inferences,
                        1,
                        "cheap query has ended but actual transport still holds its pending usage"
                    );
                    self.f.host.send(json!({"kind":"fixture-release-body"}));
                }
                break;
            }
        }
        if stop {
            assert_eq!(report.unwrap().state, RunState::Cancelled);
        } else {
            assert_ne!(report.unwrap().state, RunState::Failed);
        }
        self.f.host.send(json!({"kind":"fixture-finish"}));
        loop {
            assert!(Instant::now() < deadline);
            if let Some(frame) = self.pump() {
                assert_eq!(frame["kind"], "fixture-finished", "{frame}");
                return frame;
            }
        }
    }
}
#[test]
#[ignore = "requires built Host/extension packages; actual source owners and controlled rerank over stdio"]
fn original_rerank_source_selection_partial_scores_and_receipts_survive_reopen() {
    for mode in ["rank", "source", "unsupported", "stale", "empty"] {
        let mut review = Review::new(mode);
        let counts = review.execute(false);
        assert_eq!(
            counts["requests"],
            if matches!(mode, "source" | "unsupported") {
                0
            } else {
                1
            }
        );
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
        let paths = result["snippets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        if mode == "rank" {
            assert_eq!(paths, vec!["allowed/c.ts", "allowed/a.ts", "allowed/b.ts"]);
            assert_eq!(result["status"], "partial");
        }
        if mode == "stale" {
            assert!(!paths.contains(&"allowed/c.ts"));
            assert!(!result.to_string().contains("CHANGED_SOURCE_C"));
        }
        if mode == "source" {
            assert_eq!(paths.len(), 3);
        }
        if mode == "unsupported" || mode == "empty" {
            assert_eq!(result["status"], "partial");
            assert_eq!(paths.len(), 3);
        }
        let usage = db
            .capture_goal("rerank-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage;
        assert_eq!(usage.pending_inferences, 0);
        assert_eq!(
            usage.missing_inferences,
            if matches!(mode, "rank" | "stale" | "empty") {
                1
            } else {
                0
            }
        );
        let operations = db
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
        for op in &operations {
            assert_eq!(op.intent["binding"]["api"], "http-rerank");
            assert_eq!(op.intent["binding"]["requestKind"], "model_compute");
            if mode == "empty" {
                assert_eq!(
                    op.result.as_ref().unwrap().control().unwrap()["receipt"]["problem"],
                    "invalid_response"
                );
            }
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
        let db = Catalog::open(root.join("catalog")).unwrap();
        assert_eq!(db.execution_history("branch:parent").unwrap(), history);
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
#[ignore = "requires original Host inference; independent cheap read cancel and actual body drain over stdio"]
fn cancelled_cheap_query_preserves_independent_inference_until_real_body_stop() {
    let mut review = Review::new("stop-body");
    let counts = review.execute(true);
    assert_eq!(counts["requests"], 1);
    assert_eq!(counts["drained"], true);
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
    let operations = db
        .events_after(0, 10000)
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == "inference.admitted")
        .collect::<Vec<_>>();
    assert_eq!(operations.len(), 1);
    let op = db
        .capture_operation_read(db.operation(&operations[0].subject).unwrap())
        .load()
        .unwrap();
    assert_eq!(op.phase, OperationPhase::Terminal);
    assert_eq!(
        op.result.as_ref().unwrap().control().unwrap()["receipt"]["localExecutorStopped"],
        true
    );
    assert!(!db.execution_history("branch:parent").unwrap().iter().any(
        |item| match &item.content {
            Content::ToolResult { result } => match &result.completion {
                ToolCompletion::Result { content, .. } =>
                    content.data.to_string().contains("SOURCE_"),
                _ => false,
            },
            _ => false,
        }
    ));
    drop(db);
    drop(owner);
    let root = review.root.clone();
    drop(review);
    std::fs::remove_dir_all(root).unwrap();
}
