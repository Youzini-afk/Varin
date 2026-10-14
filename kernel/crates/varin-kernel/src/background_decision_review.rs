//! Installed research decision, original material/credential owners and Catalog over test stdio.
//! Controlled provider bytes exercise accounting and public cancellation, not product IPC/auth.
use super::material_collection_review::{binding, substitute};
use super::web_domain_review::{EPOCH, Fixture, HOST, Host};
use super::*;
use crate::{host_tools::ToolBridge, storage::Storage};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use varin_runtime::catalog::{goals::*, launches::LaunchSelection};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;

struct Script {
    calls: Vec<(&'static str, &'static str, Value)>,
}
impl ModelProvider for Script {
    fn serialize(&self, _: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(json!({}).into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let results: BTreeMap<_, _> = request
            .view
            .history
            .iter()
            .filter_map(|item| {
                if let Content::ToolResult { result } = &item.content {
                    if let ToolCompletion::Result { content, .. } = &result.completion {
                        return Some((result.call_id.clone(), content.data.clone()));
                    }
                }
                None
            })
            .collect();
        emit(ProviderEvent::Usage {
            receipt: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                input_tokens: Some(0),
                output_tokens: Some(0),
                ..Default::default()
            },
        })
        .unwrap();
        let Some((id, name, args)) = self
            .calls
            .iter()
            .find(|(id, ..)| !results.contains_key(*id))
        else {
            return Ok(FinishReason::Stop);
        };
        let tool = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == *name)
            .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: (*id).into(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: (*id).into(),
                        name: tool.name.clone(),
                        schema_version: tool.version.clone(),
                        arguments: substitute(args, &results),
                    },
                },
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
fn fixture(mode: &str) -> (PathBuf, Fixture, String, Value) {
    let root = std::env::temp_dir().join(format!("varin-decision-review-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("thread:parent", "branch:parent").unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let (sender, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(sender.into());
    bridge.initialize(EPOCH);
    let storage_root = root.join("storage");
    let mut f = Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/background-decision-host.test-helper.ts",
        ),
        runtime,
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root,
        bridge,
        outgoing,
    };
    f.host.send(
        json!({"kind":"fixture-initialize","root":root,"storageRoot":f.storage_root,"epoch":EPOCH,
        "threadId":"thread:parent","runId":"bootstrap","mode":mode}),
    );
    let ready = f.receive("fixture-prepared");
    let extensions = ready["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            serde_json::from_value::<varin_runtime::catalog::launches::ExtensionToolBinding>(
                entry["binding"].clone(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let mut tools = extensions
        .iter()
        .map(|entry| entry.tool.clone())
        .collect::<Vec<_>>();
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    let launch: LaunchSelection = serde_json::from_value(json!({"extension_bindings":extensions,"connection_identity":"decision-review",
        "provider_family":"decision-review","model":"script","configuration_generation":1,"tool_schema_generation":1,
        "tools":tools,"policy":{"name":"default","version":"1"},"source":null})).unwrap();
    let run = {
        let owner = f.runtime.catalog();
        let mut db = owner.lock().unwrap();
        let receipt = db
            .submit_with_launch(
                &SubmitInput {
                    key: "decision-input".into(),
                    thread_id: "thread:parent".into(),
                    branch_id: "branch:parent".into(),
                    expected_head: None,
                    input: json!("Judge existing material"),
                    configuration: json!({}),
                },
                Some(launch),
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
        if !mode.starts_with("stop") {
            let prepared = db
                .prepare_goal_start(
                    "decision-goal",
                    &receipt.run_id,
                    GoalScope {
                        thread_id: "thread:parent".into(),
                        branch_id: "branch:parent".into(),
                    },
                    "Judge the original PDF once".into(),
                    Some(GoalBudget {
                        max_output_tokens: if mode == "settle-failure" { 4 } else { 100 },
                    }),
                )
                .unwrap()
                .load()
                .unwrap();
            db.admit_goal_mutation(prepared).unwrap();
        }
        receipt.run_id
    };
    f.host.send(json!({"kind":"fixture-select","threadId":"thread:parent","runId":run,"required":extensions}));
    let prepared = f.receive("fixture-prepared");
    (root, f, run, prepared["bindings"].clone())
}
fn execute(
    f: &mut Fixture,
    run: &str,
    bindings: &Value,
    calls: Vec<(&'static str, &'static str, Value)>,
) -> BTreeMap<String, Value> {
    execute_with_receipt_fault(f, run, bindings, calls, false)
}
fn execute_with_receipt_fault(
    f: &mut Fixture,
    run: &str,
    bindings: &Value,
    calls: Vec<(&'static str, &'static str, Value)>,
    fail_settle: bool,
) -> BTreeMap<String, Value> {
    let live = bindings
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            live_extension_binding(serde_json::from_value(entry.clone()).unwrap()).unwrap()
        })
        .collect();
    let tools = crate::run_tools::RunTools::new(f.runtime.catalog(), f.bridge.clone());
    let prepared = tools.prepare_scope(run, vec![], None, live).unwrap();
    let executor = tools.install(run, 1, prepared).unwrap();
    let execution = f
        .runtime
        .start(
            run,
            RunStart {
                binding: binding(&f.runtime, run),
                policy_state: Value::Null,
                provider: Arc::new(Script { calls }),
                tools: executor,
                policy: Arc::new(DefaultAgentPolicy),
                context_preparation: Arc::new(NoopContextPreparation),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    let (sender, done) = mpsc::channel();
    thread::spawn(move || {
        sender.send(execution.wait()).unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut failed = false;
    let pending_seen = std::cell::Cell::new(false);
    let observer = f.runtime.clone();
    loop {
        assert!(Instant::now() < deadline, "decision execution stalled");
        if let Ok(report) = done.try_recv() {
            let report = report.unwrap();
            assert_ne!(report.state, RunState::Failed, "{:?}", report.failure);
            break;
        }
        f.pump_request(
            |frame| {
                if fail_settle
                    && !pending_seen.get()
                    && frame["method"] == "runtime.inference.settle"
                {
                    failed = true;
                    Some(KernelError::Storage(
                        "controlled original response publication failure".into(),
                    ))
                } else {
                    None
                }
            },
            |frame, result| {
                if frame["method"] == "runtime.inference.receipt_pending"
                    && result.is_ok()
                    && !pending_seen.get()
                {
                    pending_seen.set(true);
                    assert_eq!(
                        observer
                            .catalog()
                            .lock()
                            .unwrap()
                            .capture_goal("decision-goal")
                            .unwrap()
                            .load()
                            .unwrap()
                            .usage
                            .missing_inferences,
                        1
                    );
                }
                true
            },
        );
    }
    if fail_settle {
        assert!(failed);
        assert!(
            pending_seen.get(),
            "undurable receipt must establish its original unknown-usage barrier"
        );
    }
    let owner = f.runtime.catalog();
    let db = owner.lock().unwrap();
    db.execution_history("branch:parent")
        .unwrap()
        .into_iter()
        .filter_map(|item| {
            if let Content::ToolResult { result } = &item.content {
                if let ToolCompletion::Result { content, .. } = &result.completion {
                    return Some((result.call_id.clone(), content.data.clone()));
                }
            }
            None
        })
        .collect()
}
fn decision(goal: &str) -> Value {
    json!({"goal":goal,"kind":"relevance","candidates":[{"id":"pdf","kind":"snapshot","snapshotId":"$pdf:/snapshot/snapshotId"}]})
}
#[test]
#[ignore = "requires installed decision/Web artifacts and Node/tsx; subprocess stdio and controlled egress only"]
fn original_pdf_decision_usage_history_and_gc_survive_reopen() {
    let (root, mut f, run, bindings) = fixture("receipts");
    let results = execute(
        &mut f,
        &run,
        &bindings,
        vec![
            (
                "pdf",
                "webfetch",
                json!({"url":"https://paper.invalid/paper.pdf"}),
            ),
            ("known", "research_decide", decision("known answer")),
            (
                "invalid",
                "research_decide",
                decision("invalid answer with known usage"),
            ),
            (
                "partial",
                "research_decide",
                decision("answer with partial usage"),
            ),
        ],
    );
    assert_eq!(results["known"]["ranked"][0]["score"], 0);
    assert_eq!(
        results["known"]["usage"],
        json!({"inputTokens":19,"outputTokens":4})
    );
    assert_eq!(results["invalid"]["status"], "failed");
    assert_eq!(
        results["invalid"]["usage"],
        json!({"inputTokens":19,"outputTokens":4})
    );
    assert_eq!(results["partial"]["usage"], json!({"inputTokens":17}));
    let owner = f.runtime.catalog();
    let (history, operations) = {
        let db = owner.lock().unwrap();
        let goal = db.capture_goal("decision-goal").unwrap().load().unwrap();
        assert_eq!(goal.usage.actual.input_tokens.known, 55);
        assert_eq!(goal.usage.actual.output_tokens.known, 8);
        assert_eq!(goal.usage.actual.output_tokens.unknown_receipts, 1);
        assert_eq!(goal.usage.pending_inferences, 0);
        assert_eq!(goal.blocked_reason, Some(GoalBlockReason::UsageUnknown));
        let operations = db
            .events_after(0, 10000)
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "inference.admitted")
            .map(|event| event.subject)
            .collect::<Vec<_>>();
        assert_eq!(operations.len(), 3);
        (db.execution_history("branch:parent").unwrap(), operations)
    };
    let before = operations
        .iter()
        .map(|id| {
            let db = owner.lock().unwrap();
            db.capture_operation_read(db.operation(id).unwrap())
                .load()
                .unwrap()
        })
        .collect::<Vec<_>>();
    f.host.send(json!({"kind":"fixture-finish"}));
    let counts = f.receive("fixture-finished");
    assert_eq!(counts["requests"], 3);
    assert_eq!(counts["pdfFetches"], 1);
    let collection = owner
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    drop(owner);
    drop(f);
    let db = Catalog::open(root.join("catalog")).unwrap();
    assert_eq!(db.execution_history("branch:parent").unwrap(), history);
    for (id, original) in operations.iter().zip(before) {
        assert_eq!(
            db.capture_operation_read(db.operation(id).unwrap())
                .load()
                .unwrap(),
            original
        );
    }
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[ignore = "requires installed decision artifacts and Node/tsx; subprocess stdio and controlled egress only"]
fn public_stop_reaches_exact_inference_and_waits_for_body_drain() {
    for mode in ["stop", "stop-settle"] {
        let (root, mut f, run, bindings) = fixture(mode);
        let result = execute(
            &mut f,
            &run,
            &bindings,
            vec![(
                "stop",
                "research_decide",
                json!({"goal":"stop original request","kind":"relevance", "candidates":[{"id":"url","kind":"url","url":"https://paper.invalid/"}]}),
            )],
        );
        assert_eq!(
            result["stop"]["status"], "cancelled",
            "exact inference Stop must reach the original tool projection"
        );
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        assert!(!db.run(&run).unwrap().cancel_requested);
        let id = db
            .events_after(0, 10000)
            .unwrap()
            .into_iter()
            .find(|event| event.kind == "inference.admitted")
            .unwrap()
            .subject;
        let inference = db.operation(&id).unwrap();
        assert!(inference.cancel_requested);
        if mode == "stop" {
            assert_eq!(inference.effect, Effect::Unknown);
            assert_eq!(inference.outcome, Some(Outcome::Indeterminate));
        } else {
            assert_eq!(inference.effect, Effect::Confirmed);
            assert_eq!(inference.outcome, Some(Outcome::Cancelled));
            assert_eq!(
                result["stop"]["usage"],
                json!({"inputTokens":19,"outputTokens":4})
            );
        }
        drop(db);
        drop(owner);
        f.host.send(json!({"kind":"fixture-finish"}));
        let counts = f.receive("fixture-finished");
        assert_eq!(counts["requests"], 1);
        assert_eq!(counts["bodyDrained"], true);
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "requires installed decision artifacts and Node/tsx; original SDK retry with controlled bytes only"]
fn cloudflare_retry_owns_each_http_and_unknown_usage_fences_the_next() {
    for known in [true, false] {
        let (root, mut f, run, bindings) = fixture(if known {
            "retry-known"
        } else {
            "retry-unknown"
        });
        let result = execute(
            &mut f,
            &run,
            &bindings,
            vec![(
                "retry",
                "research_decide",
                json!({"goal":"Judge both supplied candidates","kind":"relevance",
            "candidates":[{"id":"url","kind":"url","url":"https://paper.invalid/"},{"id":"missing","kind":"query","detail":"unanswered original candidate"}]}),
            )],
        );
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        let usage = db
            .capture_goal("decision-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage;
        assert_eq!(usage.pending_inferences, 0);
        if known {
            assert_eq!(result["retry"]["status"], "ok");
            assert_eq!(result["retry"]["missing"], json!(["missing"]));
            assert_eq!(
                result["retry"]["usage"],
                json!({"inputTokens":18,"outputTokens":3})
            );
            assert_eq!(usage.actual.input_tokens.known, 18);
            assert_eq!(usage.actual.output_tokens.known, 3);
        } else {
            assert_eq!(result["retry"]["status"], "failed");
            assert_eq!(usage.missing_inferences, 1);
            assert_eq!(usage.actual.output_tokens.known, 0);
        }
        let admissions = db
            .events_after(0, 10000)
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "inference.admitted")
            .collect::<Vec<_>>();
        assert_eq!(
            admissions.len(),
            2,
            "each attempted retry has its original identity"
        );
        let first = db.operation(&admissions[0].subject).unwrap();
        let second = db.operation(&admissions[1].subject).unwrap();
        assert_eq!(first.intent["ordinal"], 1);
        assert_eq!(second.intent["ordinal"], 2);
        assert_eq!(
            second.effect,
            if known {
                Effect::Confirmed
            } else {
                Effect::None
            }
        );
        drop(db);
        drop(owner);
        f.host.send(json!({"kind":"fixture-finish"}));
        let counts = f.receive("fixture-finished");
        assert_eq!(counts["requests"], if known { 2 } else { 1 });
        assert_eq!(counts["pdfFetches"], 0);
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "requires installed decision artifacts and Node/tsx; original settlement unavailable until short barrier, controlled egress only"]
fn failed_receipt_publication_blocks_following_paid_work_then_refines_original_usage() {
    let (root, mut f, run, bindings) = fixture("settle-failure");
    execute_with_receipt_fault(
        &mut f,
        &run,
        &bindings,
        vec![(
            "receipt",
            "research_decide",
            json!({"goal":"Judge one original source","kind":"relevance",
        "candidates":[{"id":"url","kind":"url","url":"https://paper.invalid/"}]}),
        )],
        true,
    );
    f.host.send(json!({"kind":"fixture-finish"}));
    let counts = f.receive("fixture-finished");
    assert_eq!(counts["requests"], 1);
    let owner = f.runtime.catalog();
    let db = owner.lock().unwrap();
    let usage = db
        .capture_goal("decision-goal")
        .unwrap()
        .load()
        .unwrap()
        .usage;
    assert_eq!(usage.missing_inferences, 0);
    assert_eq!(usage.pending_inferences, 0);
    assert_eq!(usage.actual.input_tokens.known, 19);
    assert_eq!(usage.actual.output_tokens.known, 4);
    assert_eq!(
        db.events_after(0, 10000)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "execution.committed"
                && event.data["kind"] == "model_dispatched")
            .count(),
        1,
        "no new model dispatch while receipt is unknown or budget reached"
    );
    drop(db);
    drop(owner);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

fn llama_candidates() -> Value {
    json!({"goal":"Judge each original candidate separately", "kind":"relevance", "candidates":[
        {"id":"candidate-a","kind":"query","detail":"First actual material"},
        {"id":"candidate-b","kind":"query","detail":"Different second material"}
    ]})
}
#[test]
#[ignore = "requires installed patched classifier; original SDK and controlled egress over stdio"]
fn llama_original_preparation_compute_partial_and_unknown_usage_survive_reopen() {
    for mode in ["llama-depth", "llama-partial", "llama-missing"] {
        let (root, mut f, run, bindings) = fixture(mode);
        let result = execute(
            &mut f,
            &run,
            &bindings,
            vec![("llama", "research_decide", llama_candidates())],
        );
        f.host.send(json!({"kind":"fixture-finish"}));
        let counts = f.receive("fixture-finished");
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        let usage = db
            .capture_goal("decision-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage;
        assert_eq!(usage.pending_inferences, 0);
        assert_eq!(
            usage.missing_inferences, 0,
            "preparation HTTP is not unknown model billing"
        );
        let admissions = db
            .events_after(0, 10000)
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "inference.admitted")
            .collect::<Vec<_>>();
        let operations = admissions
            .iter()
            .map(|event| {
                db.capture_operation_read(db.operation(&event.subject).unwrap())
                    .load()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let computations = operations
            .iter()
            .filter(|op| op.intent["binding"]["requestKind"] == "model_compute")
            .collect::<Vec<_>>();
        assert!(
            operations
                .iter()
                .any(|op| op.intent["binding"]["requestKind"] == "preparation")
        );
        match mode {
            "llama-depth" => {
                assert_eq!(
                    counts["preparations"], 10,
                    "batch-local label reuse must retain original per-question template work"
                );
                assert_eq!(counts["completions"], 4);
                assert_eq!(counts["depths"], json!([256, 256, 4096, 256]));
                assert_eq!(
                    counts["targets"],
                    json!(["candidate-a", "candidate-a", "candidate-a", "candidate-b"])
                );
                assert_eq!(computations.len(), 4);
                assert_eq!(result["llama"]["status"], "ok");
                assert_eq!(result["llama"]["ranked"][0]["id"], "candidate-b");
                assert_eq!(result["llama"]["ranked"][1]["score"], 0);
                assert_eq!(usage.actual.input_tokens.known, 36);
                assert_eq!(usage.actual.output_tokens.known, 4);
                assert_eq!(
                    result["llama"]["usage"],
                    json!({"inputTokens":36,"outputTokens":4})
                );
            }
            "llama-partial" => {
                assert_eq!(counts["completions"], 2);
                assert_eq!(computations.len(), 2);
                assert_eq!(result["llama"]["status"], "failed");
                assert_eq!(result["llama"]["fallback"], "order");
                assert_eq!(result["llama"]["ranked"][0]["id"], "candidate-a");
                assert_eq!(result["llama"]["ranked"][0]["score"], 0);
                assert!(result["llama"]["ranked"][1].get("score").is_none());
                assert_eq!(result["llama"]["missing"], json!(["candidate-b"]));
                assert_eq!(usage.actual.input_tokens.known, 24);
                assert_eq!(usage.actual.output_tokens.known, 2);
                assert_eq!(
                    result["llama"]["usage"],
                    json!({"inputTokens":24,"outputTokens":2})
                );
            }
            _ => {
                assert_eq!(counts["completions"], 1);
                assert_eq!(computations.len(), 1);
                assert_eq!(
                    counts["preparations"], 9,
                    "the next template must not be sent through the unknown-usage Goal boundary"
                );
                assert_eq!(result["llama"]["status"], "failed");
                assert_eq!(result["llama"]["ranked"][0]["score"], 0);
                assert_eq!(result["llama"]["missing"], json!(["candidate-b"]));
                assert_eq!(usage.actual.input_tokens.known, 17);
                assert_eq!(usage.actual.output_tokens.unknown_receipts, 1);
                assert_eq!(result["llama"]["usage"], json!({"inputTokens":17}));
            }
        }
        let history = db.execution_history("branch:parent").unwrap();
        drop(db);
        let collection = owner
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default());
        assert_eq!(
            collection.run().status,
            varin_runtime::ContentCollectionStatus::Completed
        );
        drop(owner);
        drop(f);
        let db = Catalog::open(root.join("catalog")).unwrap();
        assert_eq!(db.execution_history("branch:parent").unwrap(), history);
        for original in operations {
            assert_eq!(
                db.capture_operation_read(db.operation(&original.id).unwrap())
                    .load()
                    .unwrap(),
                original
            );
        }
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "requires patched classifier; exact public Stop and real held preparation body over stdio"]
fn llama_stop_or_failed_tokenizer_drains_parallel_preparation_without_model_charge() {
    for mode in ["llama-stop-prep", "llama-fail-prep"] {
        let (root, mut f, run, bindings) = fixture(mode);
        let result = execute(
            &mut f,
            &run,
            &bindings,
            vec![("llama", "research_decide", llama_candidates())],
        );
        assert_eq!(
            result["llama"]["status"],
            if mode == "llama-stop-prep" {
                "cancelled"
            } else {
                "failed"
            }
        );
        f.host.send(json!({"kind":"fixture-finish"}));
        let counts = f.receive("fixture-finished");
        assert_eq!(counts["completions"], 0);
        assert_eq!(counts["bodyDrained"], true);
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        assert!(!db.run(&run).unwrap().cancel_requested);
        let usage = db
            .capture_goal("decision-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage;
        assert_eq!(usage.pending_inferences, 0);
        assert_eq!(usage.missing_inferences, 0);
        assert_eq!(usage.actual.input_tokens.known, 0);
        assert_eq!(usage.actual.output_tokens.known, 0);
        assert_eq!(usage.actual.output_tokens.unknown_receipts, 0);
        for event in db
            .events_after(0, 10000)
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "inference.admitted")
        {
            let op = db.operation(&event.subject).unwrap();
            assert_eq!(op.intent["binding"]["requestKind"], "preparation");
        }
        drop(db);
        drop(owner);
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}
