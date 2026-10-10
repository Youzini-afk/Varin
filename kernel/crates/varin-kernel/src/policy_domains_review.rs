//! Real policy Engine, Catalog and builtin domains. No provider request or Host IPC is fabricated.
use crate::{plan, plan_bridge::PlanBridge, process_wait, questions};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use varin_runtime::catalog::{context::ContextProposal, launches::LaunchSelection};
use varin_runtime::composition::tools::{ToolDeclaration, ToolDirectory};
use varin_runtime::execution::*;
use varin_runtime::supervisor::{RunStart, RunSupervisor};
use varin_runtime::{
    Catalog, Effect, HistorySource, OperationPhase, Outcome, RunState, SubmitInput,
};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;

struct NoModel;
impl ModelProvider for NoModel {
    fn serialize(&self, _: &RequestView) -> Result<Value, ExecutionError> {
        panic!("policy domains cannot fabricate a model request")
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        panic!("no model dispatched")
    }
}
/// Simulated provider output travels through one actual ModelStep and legal tool pairing.
struct QuestionModel;
impl ModelProvider for QuestionModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "model-question".into(),
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: "ask".into(),
                        name: "ask_user".into(),
                        schema_version: "1".into(),
                        arguments: json!({"question":"Original model question"}),
                    },
                },
                opaque: None,
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
fn graph(id: &str, name: &str, arguments: Value) -> PolicyAction {
    PolicyAction::ToolGraph {
        nodes: vec![PolicyToolNode {
            id: id.into(),
            depends_on: vec![],
            call: ToolCall {
                call_id: id.into(),
                name: name.into(),
                schema_version: "1".into(),
                arguments,
            },
        }],
    }
}
fn receipts(event: &PolicyEvent) -> &[PolicyNodeReceipt] {
    let PolicyEvent::ToolGraphCompleted { receipts, .. } = event else {
        panic!("original graph continuation required: {event:?}")
    };
    receipts
}
struct Sequence {
    calls: AtomicUsize,
}
impl AgentPolicy for Sequence {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "domain-sequence".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let stage = state["stage"].as_u64().unwrap_or(0);
        let mut next = state.clone();
        if !next.is_object() {
            next = json!({});
        }
        next["stage"] = json!(stage + 1);
        let action = match stage {
            0 if state["model"].as_bool() == Some(true) => PolicyAction::RequestModel,
            0 => graph(
                "plan",
                "todo",
                if state["planRead"].as_bool() == Some(true) {
                    json!({"action":"read"})
                } else {
                    json!({"action":"update","expectedRef":null,"items":[{"text":"Wait for the real answer","status":"in_progress"}]})
                },
            ),
            1 if state["model"].as_bool() == Some(true) => {
                assert!(
                    matches!(event, PolicyEvent::ModelCompleted { tool_calls: 1, .. }),
                    "real model completion required: {event:?}"
                );
                PolicyAction::ExecuteTools
            }
            1 => {
                if matches!(event, PolicyEvent::ToolGraphCompleted { .. }) {
                    assert_eq!(receipts(event)[0].outcome(), Outcome::Succeeded);
                }
                let mut action = graph(
                    "ask",
                    "ask_user",
                    json!({"question":"Run the bounded probe?","options":["run","cancel"]}),
                );
                if state.get("mixed").is_some() {
                    let PolicyAction::ToolGraph { nodes } = &mut action else {
                        unreachable!()
                    };
                    nodes.push(PolicyToolNode {
                        id: "failure".into(),
                        depends_on: vec![],
                        call: ToolCall {
                            call_id: "failure".into(),
                            name: "receipt_failure".into(),
                            schema_version: "1".into(),
                            arguments: json!({}),
                        },
                    });
                }
                action
            }
            2 => {
                if state["newInput"].as_bool() == Some(true) {
                    let PolicyEvent::InputDelivered { input_ids } = event else {
                        panic!("new input after the parked Wait was lost: {event:?}")
                    };
                    next["inputIds"] = json!(input_ids);
                    return Ok(PolicyDecision {
                        action: PolicyAction::Complete,
                        state: next,
                    });
                }
                if state["mixed"] == "fail" {
                    return Ok(PolicyDecision {
                        action: PolicyAction::Fail {
                            reason: "actual receipt was indeterminate".into(),
                        },
                        state: json!({"failed":true}),
                    });
                }
                if state["mixed"] == "continue"
                    && !view
                        .history
                        .iter()
                        .any(|item| item.id.starts_with("question-answer:"))
                {
                    return Ok(PolicyDecision {
                        action: PolicyAction::Deliver {
                            text: "unexecuted premature proposal".into(),
                        },
                        state: json!({"stage":777}),
                    });
                }
                let (operation_id, phase) = match event {
                    PolicyEvent::ToolsCompleted { results }
                        if state["model"].as_bool() == Some(true) =>
                    {
                        let ToolCompletion::JobAccepted {
                            operation_id,
                            phase,
                            ..
                        } = &results[0].completion
                        else {
                            panic!("original model JobAccepted required")
                        };
                        (operation_id, phase)
                    }
                    PolicyEvent::ToolGraphCompleted { receipts, .. } => {
                        let PolicyNodeCompletion::JobAccepted {
                            operation_id,
                            phase,
                            ..
                        } = &receipts[0].completion
                        else {
                            panic!("accepted question retained")
                        };
                        (operation_id, phase)
                    }
                    _ => {
                        panic!("original question continuation was lost: {event:?}, state={state}")
                    }
                };
                assert_eq!(phase, "awaiting_user");
                assert!(view.history.iter().any(|item| matches!(
                    item.provenance,
                    Provenance::UserInstruction { .. }
                ) && item
                    .id
                    .starts_with("question-answer:")));
                next["question"] = json!(operation_id);
                graph(
                    "answer",
                    "question_status",
                    json!({"operationId":operation_id}),
                )
            }
            3 => PolicyAction::ReadResult {
                reference: receipts(event)[0]
                    .output()
                    .expect("question status result")
                    .clone(),
                index: 0,
            },
            4 => {
                let PolicyEvent::ResultChunk { bytes, .. } = event else {
                    panic!("read original status result")
                };
                let value: Value = serde_json::from_slice(bytes).unwrap();
                assert_eq!(value["operationId"], state["question"]);
                match value["status"].as_str().unwrap() {
                    "answered" => {
                        assert_eq!(value["answer"], "run 原始答复");
                        assert!(value["historyId"]
                            .as_str()
                            .unwrap()
                            .starts_with("question-answer:"));
                    }
                    "cancelled" => {
                        assert!(value.get("answer").is_none());
                        assert!(value.get("historyId").is_none());
                    }
                    other => panic!("unexpected resumed status: {other}"),
                }
                next["observed"] = value.clone();
                if state["process"].as_bool() == Some(true) && value["status"] == "answered" {
                    graph(
                        "spawn",
                        "process_spawn",
                        json!({"cwd":"","command":"/bin/sh","args":["-c","IFS= read -r value; test \"$value\" = policy-original-input && printf 'policy-original-output\\n'"],"env":[],"mode":"pipe"}),
                    )
                } else {
                    next["stage"] = json!(9);
                    PolicyAction::Deliver {
                        text: format!("Question status: {}", value["status"].as_str().unwrap()),
                    }
                }
            }
            5 => {
                let PolicyNodeCompletion::JobAccepted { operation_id, .. } =
                    &receipts(event)[0].completion
                else {
                    panic!("spawn acceptance")
                };
                next["processId"] = json!(operation_id);
                next["stage"] = json!(50);
                graph(
                    "input",
                    "process_write",
                    json!({"processId":operation_id,"text":"policy-original-input\n","eof":true}),
                )
            }
            50 => {
                assert!(matches!(
                    receipts(event)[0].completion,
                    PolicyNodeCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::Confirmed,
                        ..
                    }
                ));
                PolicyAction::ReadResult {
                    reference: receipts(event)[0].output().unwrap().clone(),
                    index: 0,
                }
            }
            51 => {
                let PolicyEvent::ResultChunk { bytes, .. } = event else {
                    panic!("read original input receipt")
                };
                let receipt: Value = serde_json::from_slice(bytes).unwrap();
                assert_eq!(receipt["processId"], state["processId"]);
                assert_eq!(receipt["state"], "applied");
                assert_eq!(receipt["confirmedBytes"], 22);
                assert_eq!(receipt["eofApplied"], true);
                next["inputReceipt"] = receipt;
                next["stage"] = json!(6);
                graph(
                    "wait",
                    "wait_process",
                    json!({"processId":state["processId"]}),
                )
            }
            6 => {
                assert!(matches!(
                    receipts(event)[0].completion,
                    PolicyNodeCompletion::JobAccepted { .. }
                ));
                assert!(view
                    .history
                    .iter()
                    .any(|item| matches!(item.provenance, Provenance::EnvironmentFact { .. })));
                graph(
                    "inspect",
                    "process_inspect",
                    json!({"processId":state["processId"]}),
                )
            }
            7 => PolicyAction::ReadResult {
                reference: receipts(event)[0]
                    .output()
                    .expect("process inspect result")
                    .clone(),
                index: 0,
            },
            8 => {
                let PolicyEvent::ResultChunk { bytes, .. } = event else {
                    panic!("read process result")
                };
                let value: Value = serde_json::from_slice(bytes).unwrap();
                assert_eq!(value["processId"], state["processId"]);
                next["processResult"] = value;
                PolicyAction::Deliver {
                    text: "Observed the original process terminal receipt".into(),
                }
            }
            9 => {
                assert!(matches!(event, PolicyEvent::Delivered { .. }));
                PolicyAction::Pause {
                    reason: "Explicitly resume to finish".into(),
                }
            }
            10 => {
                assert!(matches!(event, PolicyEvent::Resumed { .. }));
                PolicyAction::Complete
            }
            _ => panic!("private policy state skipped an action: {state}"),
        };
        Ok(PolicyDecision {
            action,
            state: next,
        })
    }
}
struct Fixture {
    root: std::path::PathBuf,
    runtime: Arc<RunSupervisor>,
    run: String,
    binding: RequestBinding,
    sequence: Arc<Sequence>,
    initial: Value,
}
impl Fixture {
    fn new(
        tools: Vec<ToolSchema>,
        source: Option<varin_runtime::catalog::launches::SourceSelection>,
        initial: Value,
    ) -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-policy-domains-{}", uuid::Uuid::new_v4()));
        let sequence = Arc::new(Sequence {
            calls: AtomicUsize::new(0),
        });
        let identity =
            process_wait::policy_identity(questions::policy_identity(sequence.identity()));
        let binding:RequestBinding=serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"unused","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":null}})).unwrap();
        let launch = LaunchSelection::from_binding(&binding, identity, source);
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "main").unwrap();
        let run = db.submit_with_context_snapshot(&SubmitInput { key: "original-input".into(), thread_id: "thread".into(), branch_id: "main".into(), expected_head: None, input: json!({"text":"Original user task"}), configuration: json!({}) }, Some(launch), false,
            Some(ContextProposal { key:"initial".into(),branch_id:"main".into(),through_id:None,expected_revision:0,summary:String::new(),effective_system_prompt:"system".into(),instruction_sources:vec![],memory_checkpoint:None }),
            Some(serde_json::from_value(json!({"mode":"agent","threadRole":"main","revision":0,"configurationDigest":"domain-review","memorySnapshot":{"revision":0,"memories":[]},"sessionId":"thread","projectId":null,"originalSections":[{"name":"preamble","content":"system"}],"instructionSources":[]})).unwrap())).unwrap().run_id;
        Self {
            root,
            runtime: Arc::new(RunSupervisor::new(db)),
            run,
            binding,
            sequence,
            initial,
        }
    }
    fn start(&self, extra: Vec<ToolDeclaration>) -> ExecutionReport {
        let owner = self.runtime.catalog();
        let mut declarations = vec![
            questions::declaration(owner.clone()),
            questions::status_declaration(owner.clone()),
        ];
        declarations.extend(extra);
        let start = RunStart {
            binding: self.binding.clone(),
            policy_state: self.initial.clone(),
            provider: if self.initial["model"].as_bool() == Some(true) {
                Arc::new(QuestionModel)
            } else {
                Arc::new(NoModel)
            },
            tools: Arc::new(ToolDirectory::assemble(declarations).unwrap()),
            policy: self.sequence.clone(),
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        };
        let start = process_wait::configure(questions::configure(start, owner.clone()), owner);
        self.runtime
            .start(&self.run, start)
            .unwrap()
            .wait()
            .unwrap()
    }
    fn reopen(self) -> Self {
        let waiting = self
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .run(&self.run)
            .unwrap()
            .waiting_on;
        if let Some(operation) = waiting
            .as_deref()
            .and_then(|wait| wait.strip_prefix("question:"))
        {
            self.runtime.quiesce_question(operation).unwrap();
        }
        let Self {
            root,
            runtime,
            run,
            binding,
            sequence,
            initial,
        } = self;
        drop(runtime);
        let runtime = Arc::new(RunSupervisor::new(Catalog::open(&root).unwrap()));
        Self {
            root,
            runtime,
            run,
            binding,
            sequence,
            initial,
        }
    }
    fn question(&self) -> String {
        self.runtime
            .catalog()
            .lock()
            .unwrap()
            .run(&self.run)
            .unwrap()
            .waiting_on
            .unwrap()
            .strip_prefix("question:")
            .unwrap()
            .into()
    }
    fn answer(&self, answer: Option<&str>) {
        let owner = self.runtime.catalog();
        let operation = self.question();
        self.runtime.quiesce_question(&operation).unwrap();
        let prepared = owner
            .lock()
            .unwrap()
            .prepare_question_answer(&operation, answer.map(str::to_owned))
            .unwrap()
            .load()
            .unwrap();
        owner
            .lock()
            .unwrap()
            .admit_question_answer(prepared)
            .unwrap();
    }
    fn finish(&self, report: ExecutionReport) {
        assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
        assert_eq!(report.policy_state["stage"], 10);
        let wait = report.waiting_on.unwrap();
        self.runtime.resume_policy_pause(&self.run, &wait).unwrap();
        let report = self.start(vec![]);
        assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
        let expected_models = u64::from(self.initial["model"].as_bool() == Some(true));
        assert_eq!(report.model_steps, expected_models);
        let owner = self.runtime.catalog();
        let db = owner.lock().unwrap();
        let raw = rusqlite::Connection::open_with_flags(
            self.root.join("conversation.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let count: i64 = raw
            .query_row(
                "SELECT count(*) FROM model_steps WHERE run_id=?1",
                [&self.run],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, expected_models as i64);
        let reads:i64=raw.query_row("SELECT count(*) FROM operations WHERE json_extract(body,'$.executor')='question_status'",[],|row|row.get(0)).unwrap();
        assert_eq!(
            reads, 0,
            "trusted status reads have no durable invocation Operation"
        );
        assert_eq!(
            db.history("main")
                .unwrap()
                .iter()
                .filter(|item| item.id.starts_with("question-answer:"))
                .count(),
            1
        );
        assert_eq!(
            db.history("main")
                .unwrap()
                .iter()
                .filter(|item| item.source == HistorySource::Assistant)
                .count(),
            1 + expected_models as usize
        );
    }
    fn cleanup(self) {
        let root = self.root.clone();
        drop(self);
        std::fs::remove_dir_all(root).unwrap();
    }
}
fn basic_tools() -> Vec<ToolSchema> {
    questions::schemas(vec![])
}
#[test]
fn policy_question_reopen_reads_authentic_answer_without_skipping_private_state() {
    let f = Fixture::new(basic_tools(), None, json!({"stage":1}));
    let report = f.start(vec![]);
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(report.policy_state["stage"], 2);
    assert_eq!(
        f.sequence.calls.load(Ordering::SeqCst),
        1,
        "accepted question parks before strategy selection"
    );
    let operation = f.question();
    let f = f.reopen();
    let status = f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_question_status(&f.run, &operation)
        .unwrap()
        .load()
        .unwrap()
        .value;
    assert_eq!(status["status"], "awaiting_user");
    assert!(status.get("answer").is_none());
    f.answer(Some("run 原始答复"));
    let owner = f.runtime.catalog();
    let mut db = owner.lock().unwrap();
    let before = db.history("main").unwrap();
    assert!(db.answer_question(&operation, "run 原始答复").is_ok());
    assert!(db.answer_question(&operation, "different answer").is_err());
    assert_eq!(db.history("main").unwrap(), before);
    assert!(matches!(
        db.operation(&operation).unwrap().call_completion,
        Some(varin_runtime::catalog::result_content::ToolCompletionMetadata::JobAccepted { .. })
    ));
    drop(db);
    drop(owner);
    f.finish(f.start(vec![]));
    f.cleanup();
}
#[test]
fn policy_question_cancel_is_read_as_cancelled_and_never_as_an_answer() {
    let f = Fixture::new(basic_tools(), None, json!({"stage":1}));
    assert_eq!(f.start(vec![]).state, RunState::Waiting);
    let f = f.reopen();
    f.answer(None);
    let report = f.start(vec![]);
    assert_eq!(report.policy_state["observed"]["status"], "cancelled");
    f.finish(report);
    f.cleanup();
}

/// The bridge uses a controlled owner reply here; real KnowledgeStore CAS is covered in Host tests.
/// This checks exact native origin/intent transport without pretending this fixture is Host E2E.
fn plan_owner() -> (
    PlanBridge,
    Arc<Mutex<Vec<Value>>>,
    std::thread::JoinHandle<()>,
) {
    let (sender, receiver) = mpsc::sync_channel(8);
    let bridge = PlanBridge::new(sender);
    bridge.initialize("plan-epoch");
    let queries = Arc::new(Mutex::new(Vec::new()));
    let worker = std::thread::spawn({
        let bridge = bridge.clone();
        let queries = queries.clone();
        move || {
            let mut receipts = std::collections::BTreeMap::<String, Value>::new();
            for message in receiver {
                if message["kind"] != "plan-request" {
                    continue;
                }
                let query = &message["query"];
                queries.lock().unwrap().push(query.clone());
                assert_eq!(query["origin"]["toolOrigin"]["kind"], "policy_action");
                assert!(query["origin"].get("requestId").is_none());
                let operation = query["origin"]["operationId"].as_str().unwrap();
                let result = if query["action"] == "receipt" {
                    receipts
                        .get(operation)
                        .cloned()
                        .unwrap_or(json!({"status":"unknown"}))
                } else {
                    let result = json!({"status":"ready","mutation":{"receipt":{"threadId":query["view"]["threadId"],"branchId":query["view"]["branchId"],"origin":query["origin"],"intentHash":"fixture-owner-intent","status":"applied","ref":"fixture-plan"},"plan":{"ref":"fixture-plan"}}});
                    if query["action"] == "mutate" {
                        receipts.insert(operation.into(), result.clone());
                    }
                    result
                };
                bridge.receive(json!({"v":1,"kind":"plan-response","id":message["id"],"kernelEpoch":"plan-epoch","result":result}));
            }
        }
    });
    (bridge, queries, worker)
}

#[test]
fn policy_todo_uses_its_original_graph_head_and_main_thread_origin() {
    let f = Fixture::new(questions::schemas(vec![plan::schema()]), None, Value::Null);
    let head = f.runtime.catalog().lock().unwrap().head("main").unwrap();
    let (bridge, queries, worker) = plan_owner();
    let report = f.start(vec![plan::declaration(f.runtime.catalog(), bridge.clone())]);
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(report.policy_state["stage"], 2);
    let queries = queries.lock().unwrap().clone();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0]["view"]["headId"], json!(head));
    let operation = queries[0]["origin"]["operationId"].as_str().unwrap();
    let owner = f.runtime.catalog();
    let db = owner.lock().unwrap();
    let op = db.operation(operation).unwrap();
    assert_eq!(op.outcome, Some(Outcome::Succeeded));
    assert_eq!(op.effect, Effect::Confirmed);
    assert_eq!(op.intent["origin"], queries[0]["origin"]["toolOrigin"]);
    assert!(matches!(op.phase, OperationPhase::Terminal));
    drop(db);
    drop(owner);
    bridge.close();
    worker.join().unwrap();
    f.cleanup();
}

#[test]
#[ignore = "requires a freshly built kernel executable"]
fn policy_todo_question_reopen_process_wait_and_explicit_resume_use_real_domains() {
    use crate::storage::Storage;
    use crate::tools::{
        serve_resource, KernelResourceClient, KernelToolExecutor, ToolBinding, ToolKind,
    };
    use std::collections::BTreeSet;
    use std::time::Duration;
    use varin_runtime::catalog::launches::LiveRoot;
    use varin_runtime::SourceMode;
    const HOST: &str = "policy-domain-host";
    const GENERATION: &str = "policy-domain-generation";
    const EPOCH: &str = "policy-domain-process-epoch";
    let executable = std::env::var_os("VARIN_TEST_KERNEL_EXECUTABLE")
        .map(std::path::PathBuf::from)
        .expect("fresh kernel executable is explicit");
    assert!(executable.is_file());
    let root = std::env::temp_dir().join(format!("varin-domain-process-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("working");
    std::fs::create_dir_all(&cwd).unwrap();
    let storage_root = root.join("storage");
    let mut storage = Storage::open(&storage_root, HOST).unwrap();
    storage.set_test_process_worker_executable(executable);
    let issue = |storage: &mut Storage, id: &str, run: &str| {
        storage.issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,"capabilities":["storage.admin","process"],"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":run}),HOST,GENERATION,&storage_root.to_string_lossy(),EPOCH).unwrap()
    };
    issue(&mut storage, "setup", "setup");
    let params =
        json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":cwd});
    let (grant, params) = storage
        .authorize(
            Some("setup"),
            EPOCH,
            HOST,
            GENERATION,
            "file.root.register",
            &params,
        )
        .unwrap();
    let registered = storage
        .dispatch("file.root.register", &params, Some("setup"), &grant)
        .unwrap();
    let kinds = BTreeSet::from([
        ToolKind::ProcessSpawn,
        ToolKind::ProcessInspect,
        ToolKind::ProcessRead,
        ToolKind::ProcessWrite,
    ]);
    let mut binding = ToolBinding {
        grant_id: "process".into(),
        run_id: String::new(),
        thread_id: "thread".into(),
        workspace_id: "workspace".into(),
        execution_workspace_id: "workspace".into(),
        root_id: Some(registered["rootId"].as_str().unwrap().into()),
        file_source: None,
        source_mode: SourceMode::LiveRoot,
        materialized_source: None,
        live_root: Some(LiveRoot {
            host_id: HOST.into(),
            canonical_root: cwd.canonicalize().unwrap().to_string_lossy().into_owned(),
            root_id: registered["rootId"].as_str().unwrap().into(),
        }),
        environment_run_id: None,
        enabled_tools: kinds,
    };
    let mut tools = process_wait::schemas(questions::schemas(
        KernelToolExecutor::selected_schemas(&binding.enabled_tools),
    ));
    tools.push(plan::schema());
    let f = Fixture::new(
        tools,
        Some(binding.source_selection().unwrap()),
        json!({"stage":0,"process":true}),
    );
    binding.run_id = f.run.clone();
    issue(&mut storage, "process", &f.run);
    let (sender, receiver) = mpsc::channel();
    storage.set_process_terminal_sender(sender);
    let controls = crate::process::ProcessControlRegistry::default();
    storage.set_process_controls(controls.clone());
    let storage = Arc::new(Mutex::new(storage));
    let interactions = crate::storage::process_interactions::Client::new({
        let storage = storage.clone();
        move |command| {
            storage
                .lock()
                .unwrap()
                .serve_interaction(command, EPOCH, HOST, GENERATION);
            Ok(())
        }
    });
    let resources = KernelResourceClient::new(
        {
            let storage = storage.clone();
            move |request| {
                let result = serve_resource(
                    &mut storage.lock().unwrap(),
                    EPOCH,
                    HOST,
                    GENERATION,
                    &request,
                );
                request.reply.send(result).unwrap();
                Ok(())
            }
        },
        |_| Ok(()),
        controls,
    )
    .with_process_interactions(interactions);
    let (bridge, queries, worker) = plan_owner();
    let declarations = |f: &Fixture| {
        let mut declarations = KernelToolExecutor::new(binding.clone(), resources.clone())
            .unwrap()
            .declarations(true);
        declarations.retain(|d| {
            ![
                "process_inspect",
                "process_read",
                "process_write",
                "process_resize",
            ]
            .contains(&d.schema.name.as_str())
        });
        declarations.extend(process_wait::declarations(
            f.runtime.catalog(),
            binding.clone(),
            resources.clone(),
        ));
        declarations.push(plan::declaration(f.runtime.catalog(), bridge.clone()));
        declarations
    };
    let report = f.start(declarations(&f));
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(report.policy_state["stage"], 2);
    assert_eq!(queries.lock().unwrap().len(), 1);
    let f = f.reopen();
    f.answer(Some("run 原始答复"));
    let report = f.start(declarations(&f));
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(report.policy_state["stage"], 6);
    let wait = report.waiting_on.unwrap();
    assert!(wait.starts_with("process-wait:"));
    let terminal = receiver
        .recv_timeout(Duration::from_secs(20))
        .expect("original guardian terminal receipt");
    assert_eq!(
        terminal.process_id,
        report.policy_state["processId"].as_str().unwrap()
    );
    super::apply_process_terminal(&f.runtime, &terminal).unwrap();
    f.runtime.quiesce_process_waits().unwrap();
    varin_runtime::catalog::process_delivery::deliver_waits(&f.runtime.catalog()).unwrap();
    let report = f.start(declarations(&f));
    assert_eq!(report.policy_state["processResult"]["status"], "exited");
    assert_eq!(report.policy_state["processResult"]["exitCode"], 0);
    let operation = f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(
            report.policy_state["inputReceipt"]["operationId"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    let intent =
        varin_runtime::catalog::tool_content::ToolIntent::from_operation(&operation).unwrap();
    assert!(matches!(intent.origin(), ToolOrigin::PolicyAction { .. }));
    assert_eq!(operation.effect, Effect::Confirmed);
    assert!(operation.external_receipt.is_some());
    // Once paused, the completed tool graph no longer needs the process/plan directory to resume.
    f.finish(report);
    bridge.close();
    worker.join().unwrap();
    drop(resources);
    drop(storage);
    f.cleanup();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn policy_todo_read_has_no_durable_invocation_operation() {
    let f = Fixture::new(
        questions::schemas(vec![plan::schema()]),
        None,
        json!({"stage":0,"planRead":true}),
    );
    let (bridge, queries, worker) = plan_owner();
    let report = f.start(vec![plan::declaration(f.runtime.catalog(), bridge.clone())]);
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    let query = queries.lock().unwrap()[0].clone();
    assert_eq!(query["action"], "read");
    assert!(f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(query["origin"]["operationId"].as_str().unwrap())
        .is_err());
    bridge.close();
    worker.join().unwrap();
    f.cleanup();
}

#[test]
fn accepted_question_before_graph_receipt_reopen_consumes_original_job_once() {
    let f = Fixture::new(basic_tools(), None, json!({"stage":1}));
    let owner = f.runtime.catalog();
    let context = {
        let mut db = owner.lock().unwrap();
        let epoch = db.epoch();
        db.commit_execution(
            &f.run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        let boundary = db.policy_boundary(&f.run, epoch).unwrap();
        let action_id = format!("{}:policy:{}", f.run, boundary.id);
        let origin = ToolOrigin::PolicyAction {
            action_id: action_id.clone(),
            node_id: "ask".into(),
        };
        let call = ToolCall {
            call_id: "ask".into(),
            name: "ask_user".into(),
            schema_version: "1".into(),
            arguments: json!({"question":"Original question"}),
        };
        let frozen = FrozenToolContext {
            resource_activations: vec![],
            resource_checkpoint_id: boundary.resource_checkpoint_id.clone(),
            run_id: f.run.clone(),
            origin: origin.clone(),
            tool_schema_generation: 1,
            tools: Arc::new(f.binding.tools.clone()),
            source: None,
        };
        db.admit_policy_graph(
            &f.run,
            epoch,
            &PolicyGraphIntent::PolicyToolGraphV1 {
                action_id,
                boundary,
                identity: process_wait::policy_identity(questions::policy_identity(
                    f.sequence.identity(),
                )),
                state: json!({"stage":2}),
                nodes: vec![PolicyAdmittedNode {
                    node: PolicyToolNode {
                        id: "ask".into(),
                        depends_on: vec![],
                        call: call.clone(),
                    },
                    context: frozen,
                }],
            },
        )
        .unwrap();
        let context = ToolExecutionContext {
            run_id: f.run.clone(),
            operation_id: origin.operation_id("ask"),
            origin,
        };
        db.commit_execution(
            &f.run,
            epoch,
            &ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call,
                    contract: ToolContract {
                        name: "ask_user".into(),
                        schema_version: "1".into(),
                        read_only: true,
                        completion: CompletionKind::Job,
                        lifetime: varin_runtime::Lifetime::Thread,
                        resources: vec![],
                    },
                },
            },
        )
        .unwrap();
        db.commit_execution(
            &f.run,
            epoch,
            &ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: varin_runtime::ExecutorOwner::Kernel,
            },
        )
        .unwrap();
        db.open_question(&context).unwrap();
        context
    };
    drop(owner);
    let f = f.reopen();
    let report = f.start(vec![]);
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(report.policy_state["stage"], 2);
    assert_eq!(
        f.sequence.calls.load(Ordering::SeqCst),
        0,
        "recovered receipt parks before a new strategy decision"
    );
    assert_eq!(f.question(), context.operation_id);
    let owner = f.runtime.catalog();
    let db = owner.lock().unwrap();
    assert_eq!(
        db.events_after(0, 1000)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "question.opened")
            .count(),
        1
    );
    drop(db);
    drop(owner);
    f.answer(Some("run 原始答复"));
    f.finish(f.start(vec![]));
    f.cleanup();
}

#[test]
fn policy_todo_committed_before_tool_settlement_reconciles_original_epoch_and_head() {
    let f = Fixture::new(questions::schemas(vec![plan::schema()]), None, Value::Null);
    let call = ToolCall {
        call_id: "plan".into(),
        name: "todo".into(),
        schema_version: "1".into(),
        arguments: json!({"action":"update","expectedRef":null,"items":[{"text":"Original mutation","status":"pending"}]}),
    };
    let contract = ToolContract {
        name: "todo".into(),
        schema_version: "1".into(),
        read_only: false,
        completion: CompletionKind::Result,
        lifetime: varin_runtime::Lifetime::Run,
        resources: vec![],
    };
    let context = {
        let owner = f.runtime.catalog();
        let mut db = owner.lock().unwrap();
        let epoch = db.epoch();
        db.commit_execution(
            &f.run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        let boundary = db.policy_boundary(&f.run, epoch).unwrap();
        let action_id = format!("{}:policy:{}", f.run, boundary.id);
        let origin = ToolOrigin::PolicyAction {
            action_id: action_id.clone(),
            node_id: "plan".into(),
        };
        let frozen = FrozenToolContext {
            resource_activations: vec![],
            resource_checkpoint_id: boundary.resource_checkpoint_id.clone(),
            run_id: f.run.clone(),
            origin: origin.clone(),
            tool_schema_generation: 1,
            tools: Arc::new(f.binding.tools.clone()),
            source: None,
        };
        db.admit_policy_graph(
            &f.run,
            epoch,
            &PolicyGraphIntent::PolicyToolGraphV1 {
                action_id,
                boundary,
                identity: process_wait::policy_identity(questions::policy_identity(
                    f.sequence.identity(),
                )),
                state: json!({"stage":1}),
                nodes: vec![PolicyAdmittedNode {
                    node: PolicyToolNode {
                        id: "plan".into(),
                        depends_on: vec![],
                        call: call.clone(),
                    },
                    context: frozen,
                }],
            },
        )
        .unwrap();
        let context = ToolExecutionContext {
            run_id: f.run.clone(),
            operation_id: origin.operation_id("plan"),
            origin,
        };
        db.commit_execution(
            &f.run,
            epoch,
            &ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call: call.clone(),
                    contract: contract.clone(),
                },
            },
        )
        .unwrap();
        db.commit_execution(
            &f.run,
            epoch,
            &ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: varin_runtime::ExecutorOwner::Kernel,
            },
        )
        .unwrap();
        context
    };
    let (bridge, queries, worker) = plan_owner();
    let tool = plan::declaration(f.runtime.catalog(), bridge.clone());
    let result =
        tool.implementation
            .execute(&context, &call, &contract, &CancellationToken::default());
    assert!(matches!(
        result,
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            ..
        }
    ));
    drop(tool);
    let original = queries.lock().unwrap()[0].clone();
    let f = f.reopen();
    let (sender, receiver) = mpsc::sync_channel(1);
    plan::reconcile(
        f.runtime.clone(),
        bridge.clone(),
        f.run.clone(),
        "lookup".into(),
        sender.into(),
        Arc::new(|_| {}),
    )
    .unwrap();
    let response = receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let lookup = queries.lock().unwrap().last().unwrap().clone();
    assert_eq!(lookup["action"], "receipt");
    assert_eq!(
        lookup["origin"], original["origin"],
        "reopen must preserve the original mutation epoch"
    );
    assert_eq!(
        lookup["view"], original["view"],
        "reconciliation uses the original graph history cut"
    );
    assert_eq!(
        response["result"]["reconciled"],
        json!([context.operation_id])
    );
    assert_eq!(
        f.runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&context.operation_id)
            .unwrap()
            .outcome,
        Some(Outcome::Succeeded)
    );
    let report = f.start(vec![plan::declaration(f.runtime.catalog(), bridge.clone())]);
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(report.policy_state["stage"], 2);
    assert_eq!(
        queries.lock().unwrap().len(),
        2,
        "recovery consumes the receipt without replaying mutation"
    );
    bridge.close();
    worker.join().unwrap();
    f.cleanup();
}

struct FailureTool;
impl ToolExecutor for FailureTool {
    fn plan(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, frozen, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: "1".into(),
            read_only: true,
            completion: CompletionKind::Result,
            lifetime: varin_runtime::Lifetime::Run,
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Ok(())
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            content: json!({"status":"unknown"}),
        }
    }
}
fn failure_declaration() -> ToolDeclaration {
    ToolDeclaration::new(
        ToolSchema {
            name: "receipt_failure".into(),
            version: "1".into(),
            description: "Explicit fixture uncertain receipt".into(),
            schema: json!({"type":"object"}),
            output_schema: None,
            metadata: None,
        },
        Arc::new(FailureTool),
    )
}
#[test]
fn accepted_question_does_not_hide_failure_decision_for_indeterminate_sibling() {
    let failure = failure_declaration();
    let f = Fixture::new(
        questions::schemas(vec![failure.schema.clone()]),
        None,
        json!({"stage":1,"mixed":"fail"}),
    );
    let report = f.start(vec![failure]);
    assert_eq!(report.state, RunState::Failed, "{:?}", report.failure);
    assert_eq!(report.policy_state, json!({"failed":true}));
    let owner = f.runtime.catalog();
    let db = owner.lock().unwrap();
    let event = db
        .events_after(0, 1000)
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "question.opened")
        .unwrap();
    let question = db.operation(&event.subject).unwrap();
    assert_eq!(question.outcome, Some(Outcome::Cancelled));
    drop(db);
    drop(owner);
    f.cleanup();
}
#[test]
fn mixed_receipt_continuation_discards_unexecuted_proposal_state_until_answer() {
    let failure = failure_declaration();
    let f = Fixture::new(
        questions::schemas(vec![failure.schema.clone()]),
        None,
        json!({"stage":1,"mixed":"continue"}),
    );
    let report = f.start(vec![failure]);
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(
        report.policy_state["stage"], 2,
        "proposal's next private state must not become committed"
    );
    assert_eq!(f.sequence.calls.load(Ordering::SeqCst), 2);
    let f = f.reopen();
    f.answer(Some("run 原始答复"));
    f.finish(f.start(vec![failure_declaration()]));
    f.cleanup();
}

#[test]
fn policy_question_answer_does_not_clear_goal_pause_or_strand_ended_goal() {
    use varin_runtime::catalog::goals::{GoalControl, GoalControlAction, GoalScope};
    for control in [GoalControlAction::Pause, GoalControlAction::Complete] {
        let f = Fixture::new(basic_tools(), None, json!({"stage":1}));
        let scope = GoalScope {
            thread_id: "thread".into(),
            branch_id: "main".into(),
        };
        let owner = f.runtime.catalog();
        let goal = owner
            .lock()
            .unwrap()
            .prepare_goal_start(
                "goal",
                &f.run,
                scope.clone(),
                "Original explicit goal".into(),
                None,
            )
            .unwrap()
            .load()
            .unwrap();
        owner.lock().unwrap().admit_goal_mutation(goal).unwrap();
        drop(owner);
        let report = f.start(vec![]);
        assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
        let original_question = f.question();
        let owner = f.runtime.catalog();
        let revision = owner
            .lock()
            .unwrap()
            .capture_goal("goal")
            .unwrap()
            .load()
            .unwrap()
            .revision;
        owner
            .lock()
            .unwrap()
            .control_goal("goal", revision, &scope, control)
            .unwrap();
        drop(owner);
        let f = f.reopen();
        f.answer(Some("run 原始答复"));
        let report = f.start(vec![]);
        assert_eq!(
            f.runtime
                .catalog()
                .lock()
                .unwrap()
                .operation(&original_question)
                .unwrap()
                .outcome,
            Some(Outcome::Succeeded)
        );
        if control == GoalControlAction::Pause {
            assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
            assert!(report.waiting_on.unwrap().starts_with("goal-wait:"));
            assert_eq!(report.policy_state["stage"], 2);
            let owner = f.runtime.catalog();
            let goal = owner
                .lock()
                .unwrap()
                .capture_goal("goal")
                .unwrap()
                .load()
                .unwrap();
            assert_eq!(goal.control, GoalControl::Paused);
            owner
                .lock()
                .unwrap()
                .control_goal("goal", goal.revision, &scope, GoalControlAction::Resume)
                .unwrap();
            drop(owner);
            f.runtime.reconcile_goal_waits().unwrap();
            f.finish(f.start(vec![]));
        } else {
            assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
        }
        f.cleanup();
    }
}

#[test]
fn stateful_model_question_wait_retains_original_continuation_after_answer_and_reopen_cancel() {
    for reopen in [false, true] {
        let f = Fixture::new(basic_tools(), None, json!({"stage":0,"model":true}));
        let report = f.start(vec![]);
        assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
        assert_eq!(report.policy_state["stage"], 2);
        assert_eq!(
            f.sequence.calls.load(Ordering::SeqCst),
            2,
            "Wait parks before another policy decision"
        );
        let f = if reopen { f.reopen() } else { f };
        f.answer(if reopen {
            None
        } else {
            Some("run 原始答复")
        });
        let report = f.start(vec![]);
        assert_eq!(
            report.state,
            RunState::Waiting,
            "original ToolsCompleted must survive real question delivery: {:?}",
            report.failure
        );
        assert_eq!(
            report.policy_state["observed"]["status"],
            if reopen { "cancelled" } else { "answered" }
        );
        f.finish(report);
        f.cleanup();
    }
}

#[test]
fn delivered_input_after_model_question_wait_survives_crash_before_next_decision() {
    let f = Fixture::new(
        basic_tools(),
        None,
        json!({"stage":0,"model":true,"newInput":true}),
    );
    assert_eq!(f.start(vec![]).state, RunState::Waiting);
    f.answer(Some("run 原始答复"));
    let input_id = {
        let owner = f.runtime.catalog();
        let mut db = owner.lock().unwrap();
        let input = db
            .enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
                key: "new-input-after-answer".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                mode: varin_runtime::InputMode::Boundary,
                input: json!({"text":"Use this newer instruction"}),
                configuration: None,
            })
            .unwrap();
        let epoch = db.epoch();
        let head = db.head("main").unwrap();
        let delivered = db.consume_inputs(&f.run, epoch, head.as_deref()).unwrap();
        assert_eq!(delivered.len(), 1);
        input.input_id
    };
    // The real input delivery committed; the policy has not consumed it or made a new decision.
    let f = f.reopen();
    let report = f.start(vec![]);
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    assert_eq!(report.policy_state["stage"], 3);
    assert_eq!(report.policy_state["inputIds"], json!([input_id]));
    assert_eq!(report.model_steps, 1);
    f.cleanup();
}
