//! Independent adversarial tests: graph evidence is not a synthetic model tool exchange.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use varin_runtime::execution::*;
use varin_runtime::*;

#[path = "fixtures/content_window.rs"]
mod content_window;

#[test]
fn body_publication_keeps_policy_node_alive_and_receipt_idempotent() {
    let f = Fixture::new();
    let intent = admitted(&f, vec![node("large", &[])]);
    let action = intent.action_id().to_string();
    let run = f.input.run_id.clone();
    let epoch = f.input.owner_generation;
    f.db.admit_policy_graph(&run, epoch, &intent).unwrap();
    let value = json!({"evidence":content_window::large_text()});
    let completion = ToolCompletion::Result {
        outcome: Outcome::Succeeded, effect: Effect::None, content: value.clone(),
    };
    let worker_run = run.clone();
    let worker_action = action.clone();
    let worker_completion = completion.clone();
    let receipt = content_window::during_write(&f.root, &f.db,
        move |db| db.settle_policy_node(&worker_run, epoch, &worker_action, "large", &worker_completion),
        |catalog| {
            let graph = catalog.policy_graph(&run, epoch).unwrap().unwrap();
            assert!(graph.result.receipts.is_empty(), "body must precede receipt publication");
            assert_eq!(catalog.collect_content_objects().unwrap(), 0);
            catalog.create_thread("independent", "independent-main").unwrap();
        }).unwrap();
    let before = f.db.lock().unwrap().operation(&action).unwrap().revision;
    assert_eq!(f.db.settle_policy_node(&run, epoch, &action, "large", &completion).unwrap(), receipt);
    assert_eq!(f.db.lock().unwrap().operation(&action).unwrap().revision, before);
    assert!(f.db.settle_policy_node(&run, epoch, &action, "large", &ToolCompletion::Result {
        outcome: Outcome::Succeeded, effect: Effect::None, content: json!("different body"),
    }).is_err());
    f.db.lock().unwrap().collect_content_objects().unwrap();
    let evidence = f.db.policy_evidence(&run, epoch, receipt.output.as_ref().unwrap()).unwrap();
    assert!(serde_json::to_string(&evidence.content).unwrap().contains(value["evidence"].as_str().unwrap()));
}

struct Fixture {
    root: std::path::PathBuf,
    db: Arc<Mutex<Catalog>>,
    input: ExecutionInput,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "varin-policy-graph-review-{}",
            uuid::Uuid::new_v4()
        ));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("inspect evidence then answer"),
                configuration: json!({}),
            })
            .unwrap();
        let binding = RequestBinding {
            connection_identity: "local-review".into(),
            provider_family: "test".into(),
            model: "test".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: vec![ToolSchema {
                name: "read".into(),
                version: "1".into(),
                schema: json!({"type":"object"}),
            }],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: "main".into(),
                ancestor_id: None,
                leaf_id: Some(receipt.input_id),
            },
        };
        let input = db
            .prepare_execution(&receipt.run_id, binding, identity(), Value::Null)
            .unwrap();
        Self {
            root,
            db: Arc::new(Mutex::new(db)),
            input,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn identity() -> PolicyIdentity {
    PolicyIdentity {
        name: "independent-review".into(),
        version: "1".into(),
    }
}
fn action(value: Value) -> PolicyAction {
    serde_json::from_value(value).unwrap()
}
fn node(id: &str, deps: &[&str]) -> Value {
    json!({"id":id,"depends_on":deps,"call":{"call_id":id,"name":"read","schema_version":"1","arguments":{"path":id}}})
}
fn graph(nodes: Vec<Value>) -> Value {
    json!({"kind":"read_graph","nodes":nodes})
}

#[derive(Default)]
struct Provider {
    requests: Mutex<Vec<RequestView>>,
}
impl ModelProvider for Provider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.requests.lock().unwrap().push(request.view.clone());
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "answer".into(),
                content: Content::Text {
                    text: "done".into(),
                },
                opaque: None,
            },
        })
        .map_err(|e| ModelFailure {
            code: e.code,
            message: e.message,
            retry_after_ms: None,
            provider_request_id: None,
        })?;
        Ok(FinishReason::Stop)
    }
}
struct Tools {
    calls: Mutex<Vec<String>>,
    output: String,
    started: Option<mpsc::Sender<String>>,
    authorized: Option<mpsc::Sender<String>>,
    block_read: bool,
    readonly: bool,
    trusted: bool,
    revoked: AtomicBool,
}
impl Tools {
    fn new(output: &str) -> Self {
        Self {
            calls: Mutex::new(vec![]),
            output: output.into(),
            started: None,
            authorized: None,
            block_read: false,
            readonly: true,
            trusted: true,
            revoked: AtomicBool::new(false),
        }
    }
}
impl ToolExecutor for Tools {
    fn plan(&self, call: &varin_runtime::execution::ToolCall, context: &varin_runtime::execution::FrozenToolContext,
        cancel: &varin_runtime::execution::CancellationToken) -> Result<varin_runtime::execution::ToolPreparation, varin_runtime::execution::ExecutionError> {
        self.prepare(call, context, cancel).map(varin_runtime::execution::ToolPreparation::Ready)
    }

    fn supports_policy_read(&self, _: &FrozenToolContext, _: &ToolCall, _: &ToolContract) -> bool {
        self.trusted
    }
    fn prepare(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        assert!(
            matches!(context.origin, ToolOrigin::PolicyAction { .. }),
            "graph must use independent origin, never fabricate a ModelStep"
        );
        if !context
            .tools
            .iter()
            .any(|schema| schema.name == call.name && schema.version == call.schema_version)
        {
            return Err(ExecutionError::new("schema_mismatch", "unbound schema"));
        }
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: self.readonly,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![ResourceClaim {
                key: call.arguments["path"].as_str().unwrap().into(),
                access: Access::Read,
            }],
        })
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if self.revoked.load(Ordering::SeqCst) {
            Err(ExecutionError::new("revoked", "grant revoked"))
        } else {
            if let Some(sender) = &self.authorized {
                sender.send(call.call_id.clone()).unwrap();
            }
            Ok(())
        }
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        assert!(matches!(context.origin, ToolOrigin::PolicyAction { .. }));
        self.calls.lock().unwrap().push(call.call_id.clone());
        if let Some(sender) = &self.started {
            sender.send(call.call_id.clone()).unwrap();
        }
        if self.block_read {
            let (tx, rx) = mpsc::sync_channel(1);
            let _wake = cancel.wake_on_cancel(tx);
            rx.recv_timeout(Duration::from_secs(5))
                .expect("test read was not cancelled");
            return ToolCompletion::Result {
                outcome: Outcome::Cancelled,
                effect: Effect::None,
                content: json!({"cancelled":true}),
            };
        }
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::None,
            content: json!({"answer":self.output,"node":call.call_id}),
        }
    }
}
struct Policy {
    nodes: Vec<Value>,
    events: Mutex<Vec<Value>>,
    evidence: bool,
    content_gate: bool,
}
impl Policy {
    fn new(nodes: Vec<Value>) -> Self {
        Self {
            nodes,
            events: Mutex::new(vec![]),
            evidence: false,
            content_gate: false,
        }
    }
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        identity()
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let event = serde_json::to_value(event).unwrap();
        self.events.lock().unwrap().push(event.clone());
        let (next, state) = match event["kind"].as_str().unwrap() {
            "started" => (graph(self.nodes.clone()), json!({"stage":"graph"})),
            "read_graph_completed" => {
                let outputs: Vec<Value> = event["receipts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|r| r.get("output").filter(|r| !r.is_null()).cloned())
                    .collect();
                if self.content_gate {
                    (
                        json!({"kind":"read_result","reference":outputs[0],"index":0}),
                        json!({"evidence":outputs}),
                    )
                } else if self.evidence {
                    (
                        json!({"kind":"request_model_with_evidence","evidence":outputs}),
                        Value::Null,
                    )
                } else {
                    (json!({"kind":"complete"}), Value::Null)
                }
            }
            "result_chunk" => {
                let bytes: Vec<u8> = serde_json::from_value(event["bytes"].clone()).unwrap();
                let result: Value = serde_json::from_slice(&bytes).unwrap();
                if result.to_string().contains("ALLOW") {
                    (
                        json!({"kind":"request_model_with_evidence","evidence":state["evidence"]}),
                        state.clone(),
                    )
                } else {
                    (json!({"kind":"complete"}), state.clone())
                }
            }
            "model_completed" => (json!({"kind":"complete"}), state.clone()),
            other => panic!("unexpected policy event {other}: {event}"),
        };
        Ok(PolicyDecision {
            action: action(next),
            state,
        })
    }
}
fn engine(
    f: &Fixture,
    tools: Arc<Tools>,
    policy: Arc<Policy>,
) -> ExecutionEngine<Mutex<Catalog>, Provider, Tools, Policy> {
    ExecutionEngine {
        context_preparation: Arc::new(NoopContextPreparation),
        persistence: f.db.clone(),
        provider: Arc::new(Provider::default()),
        tools,
        policy,
        progress: ProgressSink::default(),
    }
}

#[test]
fn graph_starts_without_model_and_actual_bytes_change_the_next_action() {
    for (body, expected_models) in [("ALLOW", 1), ("DENY", 0)] {
        let f = Fixture::new();
        let tools = Arc::new(Tools::new(body));
        let mut policy = Policy::new(vec![node("evidence", &[])]);
        policy.content_gate = true;
        let e = engine(&f, tools.clone(), Arc::new(policy));
        let report = e
            .run(f.input.clone(), CancellationToken::default())
            .unwrap();
        assert_eq!(report.state, RunState::Completed);
        assert_eq!(*tools.calls.lock().unwrap(), vec!["evidence"]);
        let requests = e.provider.requests.lock().unwrap();
        assert_eq!(requests.len(), expected_models);
        let events = e.policy.events.lock().unwrap();
        assert_eq!(events[0]["kind"], "started");
        assert_eq!(events[1]["kind"], "read_graph_completed");
        for request in requests.iter() {
            assert!(request.history.iter().any(|item| matches!(
                &item.provenance,
                Provenance::ExternalData { .. }
            ) && serde_json::to_string(&item.content)
                .unwrap()
                .contains(body)));
            assert!(
                !request.history.iter().any(|item| matches!(
                    item.content,
                    Content::ToolCall { .. } | Content::ToolResult { .. }
                )),
                "independent evidence must not forge provider pairs"
            );
        }
    }
}

#[test]
fn invalid_dags_and_stale_schema_fail_before_any_execution() {
    let mut stale = node("stale", &[]);
    stale["call"]["schema_version"] = json!("old");
    for nodes in [
        vec![node("a", &["b"]), node("b", &["a"])],
        vec![node("a", &["missing"])],
        vec![node("a", &[]), node("a", &[])],
        vec![node("valid", &[]), stale],
    ] {
        let f = Fixture::new();
        let tools = Arc::new(Tools::new("unused"));
        let e = engine(&f, tools.clone(), Arc::new(Policy::new(nodes)));
        let result = e.run(f.input.clone(), CancellationToken::default());
        assert!(result.is_err() || result.unwrap().state == RunState::Failed);
        assert!(tools.calls.lock().unwrap().is_empty());
        assert!(e.provider.requests.lock().unwrap().is_empty());
    }
}

#[test]
fn trusted_contract_and_dispatch_grant_cannot_be_claimed_by_policy() {
    for (readonly, trusted, revoked) in [
        (false, true, false),
        (true, false, false),
        (true, true, true),
    ] {
        let f = Fixture::new();
        let mut tools = Tools::new("forbidden");
        tools.readonly = readonly;
        tools.trusted = trusted;
        tools.revoked.store(revoked, Ordering::SeqCst);
        let tools = Arc::new(tools);
        let e = engine(
            &f,
            tools.clone(),
            Arc::new(Policy::new(vec![node("x", &[])])),
        );
        let _ = e.run(f.input.clone(), CancellationToken::default());
        assert!(tools.calls.lock().unwrap().is_empty());
        assert!(e.provider.requests.lock().unwrap().is_empty());
    }
}

#[test]
fn unrelated_b_runs_while_a_waits_shared_resource_and_c_waits_dependency() {
    let f = Fixture::new();
    let admission = f.db.resource_admission();
    let blocker = admission
        .acquire(
            "other-run-writer",
            &[ResourceClaim {
                key: "a".into(),
                access: Access::Write,
            }],
            &CancellationToken::default(),
        )
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let mut tools = Tools::new("ok");
    tools.started = Some(tx);
    let tools = Arc::new(tools);
    let e = engine(
        &f,
        tools.clone(),
        Arc::new(Policy::new(vec![
            node("a", &[]),
            node("b", &[]),
            node("c", &["a"]),
        ])),
    );
    let input = f.input.clone();
    let cancel = CancellationToken::default();
    let emergency = cancel.clone();
    let worker = std::thread::spawn(move || e.run(input, cancel));
    let first = rx.recv_timeout(Duration::from_secs(3));
    if first.as_deref() != Ok("b") {
        emergency.cancel();
        drop(blocker);
        let _ = worker.join();
        panic!("independent b did not bypass blocked a: {first:?}");
    }
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "dependent c must not execute while a blocked"
    );
    drop(blocker);
    let report = worker.join().unwrap().unwrap();
    assert_eq!(report.state, RunState::Completed);
    let calls = tools.calls.lock().unwrap();
    assert_eq!(*calls, vec!["b", "a", "c"]);
}

#[test]
fn queued_cancellation_releases_wait_and_never_dispatches_blocked_nodes() {
    let f = Fixture::new();
    let admission = f.db.resource_admission();
    let blocker = admission
        .acquire(
            "other-run-writer",
            &[ResourceClaim {
                key: "a".into(),
                access: Access::Write,
            }],
            &CancellationToken::default(),
        )
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let mut tools = Tools::new("ok");
    tools.started = Some(tx);
    let tools = Arc::new(tools);
    let e = engine(
        &f,
        tools.clone(),
        Arc::new(Policy::new(vec![
            node("a", &[]),
            node("b", &[]),
            node("c", &["a"]),
        ])),
    );
    let input = f.input.clone();
    let cancel = CancellationToken::default();
    let other = cancel.clone();
    let (done, finished) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        done.send(e.run(input, other)).unwrap();
    });
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), "b");
    cancel.cancel();
    let result = finished.recv_timeout(Duration::from_secs(3));
    drop(blocker);
    worker.join().unwrap();
    assert_eq!(result.unwrap().unwrap().state, RunState::Cancelled);
    assert_eq!(*tools.calls.lock().unwrap(), vec!["b"]);
}

#[test]
fn grant_revoked_while_queued_is_rechecked_at_dispatch() {
    let f = Fixture::new();
    let admission = f.db.resource_admission();
    let blocker = admission
        .acquire(
            "other-writer",
            &[ResourceClaim {
                key: "a".into(),
                access: Access::Write,
            }],
            &CancellationToken::default(),
        )
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let (auth_tx, auth_rx) = mpsc::channel();
    let mut tools = Tools::new("must not read a");
    tools.started = Some(tx);
    tools.authorized = Some(auth_tx);
    let tools = Arc::new(tools);
    let e = engine(
        &f,
        tools.clone(),
        Arc::new(Policy::new(vec![node("a", &[]), node("b", &[])])),
    );
    let input = f.input.clone();
    let worker = std::thread::spawn(move || e.run(input, CancellationToken::default()));
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), "b");
    while auth_rx.recv_timeout(Duration::from_secs(3)).unwrap() != "a" {}
    tools.revoked.store(true, Ordering::SeqCst);
    drop(blocker);
    let _ = worker.join().unwrap();
    assert_eq!(
        *tools.calls.lock().unwrap(),
        vec!["b"],
        "queued grant revocation must prevent a's read"
    );
}

fn admitted(f: &Fixture, nodes: Vec<Value>) -> PolicyGraphIntent {
    let boundary =
        f.db.policy_boundary(&f.input.run_id, f.input.owner_generation)
            .unwrap();
    let action_id = format!("{}:policy:{}", f.input.run_id, boundary.id);
    let tools = Tools::new("fixture");
    let nodes = nodes
        .into_iter()
        .map(|value| {
            let node: PolicyReadNode = serde_json::from_value(value).unwrap();
            let context = FrozenToolContext {
                run_id: f.input.run_id.clone(),
                origin: ToolOrigin::PolicyAction {
                    action_id: action_id.clone(),
                    node_id: node.id.clone(),
                },
                tool_schema_generation: f.input.binding.tool_schema_generation,
                tools: Arc::new(f.input.binding.tools.clone()),
                source: boundary.source.clone(),
            };
            let contract = tools.prepare(&node.call, &context, &CancellationToken::default()).unwrap();
            PolicyAdmittedNode {
                node,
                context,
                contract,
            }
        })
        .collect();
    PolicyGraphIntent::PolicyReadGraphV1 {
        action_id,
        boundary,
        identity: identity(),
        state: json!({"stage":"admitted"}),
        nodes,
    }
}
fn settled() -> ToolCompletion {
    ToolCompletion::Result {
        outcome: Outcome::Succeeded,
        effect: Effect::None,
        content: json!({"answer":"DURABLE_RECEIPT"}),
    }
}
fn reopen(f: &mut Fixture) {
    // Drop the only old owner before reopening. The temporary catalog is inside this fixture.
    let placeholder = Arc::new(Mutex::new(
        Catalog::open(f.root.join("placeholder")).unwrap(),
    ));
    drop(std::mem::replace(&mut f.db, placeholder));
    f.db = Arc::new(Mutex::new(Catalog::open(&f.root).unwrap()));
}

#[test]
fn admission_retry_is_same_action_and_changed_intent_is_rejected() {
    let f = Fixture::new();
    let intent = admitted(&f, vec![node("a", &[])]);
    let first =
        f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
            .unwrap();
    let retry =
        f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
            .unwrap();
    assert_eq!(first.intent, retry.intent);
    let mut altered = intent.clone();
    let PolicyGraphIntent::PolicyReadGraphV1 { nodes, .. } = &mut altered;
    nodes[0].node.call.arguments["path"] = json!("different");
    assert!(f
        .db
        .admit_policy_graph(&f.input.run_id, f.input.owner_generation, &altered)
        .is_err());
}

#[test]
fn restart_before_any_model_resumes_graph_at_each_durable_cut_without_rerunning_receipts() {
    for settled_count in 0..=2 {
        let mut f = Fixture::new();
        let intent = admitted(&f, vec![node("a", &[]), node("b", &["a"])]);
        let action_id = intent.action_id().to_string();
        f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
            .unwrap();
        for id in ["a", "b"].iter().take(settled_count) {
            f.db.settle_policy_node(
                &f.input.run_id,
                f.input.owner_generation,
                &action_id,
                id,
                &settled(),
            )
            .unwrap();
        }
        let old_epoch = f.input.owner_generation;
        reopen(&mut f);
        let (input, recovery) =
            f.db.lock()
                .unwrap()
                .prepare_recovered_execution(
                    &f.input.run_id,
                    f.input.binding.clone(),
                    identity(),
                    Value::Null,
                )
                .unwrap();
        assert_ne!(input.owner_generation, old_epoch);
        assert_eq!(input.completed_model_steps, 0);
        let tools = Arc::new(Tools::new("resumed"));
        let e = engine(&f, tools.clone(), Arc::new(Policy::new(vec![])));
        let report = e
            .run_recovered(input, CancellationToken::default(), recovery)
            .unwrap();
        assert_eq!(report.state, RunState::Completed);
        assert_eq!(tools.calls.lock().unwrap().len(), 2 - settled_count);
        for id in ["a", "b"].iter().take(settled_count) {
            assert!(!tools
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|called| called == id));
        }
        assert!(e.provider.requests.lock().unwrap().is_empty());
        assert_eq!(
            e.policy.events.lock().unwrap()[0]["kind"],
            "read_graph_completed",
            "must resume durable action rather than call Started again"
        );
        assert!(
            f.db.settle_policy_node(&f.input.run_id, old_epoch, &action_id, "a", &settled())
                .is_err(),
            "late owner must have no write authority"
        );
    }
}

#[test]
fn missing_or_incompatible_policy_on_reopen_cannot_erase_graph_facts() {
    let mut f = Fixture::new();
    let intent = admitted(&f, vec![node("a", &[]), node("b", &["a"])]);
    let action_id = intent.action_id().to_string();
    f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
        .unwrap();
    let receipt =
        f.db.settle_policy_node(
            &f.input.run_id,
            f.input.owner_generation,
            &action_id,
            "a",
            &settled(),
        )
        .unwrap();
    reopen(&mut f);
    for wrong in [
        PolicyIdentity {
            name: "missing-default-substitute".into(),
            version: "1".into(),
        },
        PolicyIdentity {
            name: identity().name,
            version: "2".into(),
        },
    ] {
        assert!(f
            .db
            .lock()
            .unwrap()
            .prepare_recovered_execution(
                &f.input.run_id,
                f.input.binding.clone(),
                wrong,
                Value::Null
            )
            .is_err());
    }
    let epoch = f.db.lock().unwrap().epoch();
    let retained = f.db.policy_graph(&f.input.run_id, epoch).unwrap().unwrap();
    assert_eq!(retained.result.receipts.get("a"), Some(&receipt));
    assert_eq!(retained.intent, intent);
}

#[test]
fn output_chunks_are_owned_bounded_and_survive_content_collection() {
    let mut f = Fixture::new();
    let intent = admitted(&f, vec![node("a", &[])]);
    let action_id = intent.action_id().to_string();
    f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
        .unwrap();
    // A modest structured output crosses the documented 256 KiB content-chunk ceiling.
    let output = json!({"data":"x".repeat(270_000)});
    let completion = ToolCompletion::Result {
        outcome: Outcome::Succeeded,
        effect: Effect::None,
        content: output.clone(),
    };
    let receipt =
        f.db.settle_policy_node(
            &f.input.run_id,
            f.input.owner_generation,
            &action_id,
            "a",
            &completion,
        )
        .unwrap();
    let reference = receipt.output.unwrap();
    f.db.lock().unwrap().collect_content_objects().unwrap();
    reopen(&mut f);
    let epoch = f.db.lock().unwrap().epoch();
    f.db.lock().unwrap().collect_content_objects().unwrap();
    let first =
        f.db.policy_chunk(&f.input.run_id, epoch, &reference, 0)
            .unwrap();
    assert!(first.chunk_count >= 2);
    let mut bytes = vec![];
    for index in 0..first.chunk_count {
        let chunk =
            f.db.policy_chunk(&f.input.run_id, epoch, &reference, index)
                .unwrap();
        assert!(chunk.bytes.len() <= 256 * 1024);
        bytes.extend(chunk.bytes);
    }
    let decoded: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(decoded, output);
    assert!(f
        .db
        .policy_chunk(&f.input.run_id, epoch, &reference, first.chunk_count)
        .is_err());
    assert!(f
        .db
        .policy_chunk("another-run", epoch, &reference, 0)
        .is_err());
    for field in ["action_id", "node_id", "content_ref"] {
        let mut bad = serde_json::to_value(&reference).unwrap();
        bad[field] = json!("foreign");
        let bad: PolicyEvidenceRef = serde_json::from_value(bad).unwrap();
        assert!(
            f.db.policy_chunk(&f.input.run_id, epoch, &bad, 0).is_err(),
            "must reject foreign {field}"
        );
    }
}

struct CheckpointPolicy {
    seen: Mutex<Vec<Value>>,
    expected: String,
}
impl AgentPolicy for CheckpointPolicy {
    fn identity(&self) -> PolicyIdentity {
        identity()
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let event = serde_json::to_value(event).unwrap();
        self.seen.lock().unwrap().push(event.clone());
        if event["kind"] != self.expected || state["marker"] != "committed-after-results" {
            return Err(ExecutionError::new(
                "checkpoint_rolled_back",
                "recovery replayed the graph instead of its later decided checkpoint",
            ));
        }
        Ok(PolicyDecision {
            action: PolicyAction::Complete,
            state: state.clone(),
        })
    }
}
#[test]
fn newer_decision_checkpoint_after_graph_results_is_not_rolled_back_on_restart() {
    for kind in ["read_result", "request_model_with_evidence", "complete"] {
        let mut f = Fixture::new();
        let intent = admitted(&f, vec![node("a", &[])]);
        let action_id = intent.action_id().to_string();
        f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
            .unwrap();
        let reference =
            f.db.settle_policy_node(
                &f.input.run_id,
                f.input.owner_generation,
                &action_id,
                "a",
                &settled(),
            )
            .unwrap()
            .output
            .unwrap();
        let next = match kind {
            "read_result" => json!({"kind":kind,"reference":reference,"index":0}),
            "request_model_with_evidence" => json!({"kind":kind,"evidence":[reference]}),
            _ => json!({"kind":kind}),
        };
        f.db.commit(
            &f.input.run_id,
            f.input.owner_generation,
            &ExecutionRecord::PolicyCheckpoint {
                identity: identity(),
                state: json!({"marker":"committed-after-results"}),
                action: action(next),
            },
        )
        .unwrap();
        reopen(&mut f);
        let (input, recovery) =
            f.db.lock()
                .unwrap()
                .prepare_recovered_execution(
                    &f.input.run_id,
                    f.input.binding.clone(),
                    identity(),
                    Value::Null,
                )
                .unwrap();
        let policy = Arc::new(CheckpointPolicy {
            seen: Mutex::new(vec![]),
            expected: if kind == "read_result" {
                "result_chunk".into()
            } else {
                "model_completed".into()
            },
        });
        let e = ExecutionEngine {
            context_preparation: Arc::new(NoopContextPreparation),
            persistence: f.db.clone(),
            provider: Arc::new(Provider::default()),
            tools: Arc::new(Tools::new("must not rerun")),
            policy: policy.clone(),
            progress: ProgressSink::default(),
        };
        let report = e
            .run_recovered(input, CancellationToken::default(), recovery)
            .unwrap();
        assert_eq!(
            report.state,
            RunState::Completed,
            "committed action {kind} was rolled back: {:?}",
            report.failure
        );
        assert!(e.tools.calls.lock().unwrap().is_empty());
        assert_eq!(
            e.provider.requests.lock().unwrap().len(),
            usize::from(kind == "request_model_with_evidence")
        );
        assert_eq!(
            policy.seen.lock().unwrap().len(),
            usize::from(kind != "complete")
        );
    }
}

#[test]
fn cancelling_an_active_read_drains_executor_and_releases_resource() {
    let f = Fixture::new();
    let (tx, rx) = mpsc::channel();
    let mut tools = Tools::new("unused");
    tools.started = Some(tx);
    tools.block_read = true;
    let tools = Arc::new(tools);
    let e = engine(
        &f,
        tools.clone(),
        Arc::new(Policy::new(vec![node("active", &[])])),
    );
    let input = f.input.clone();
    let cancel = CancellationToken::default();
    let child = cancel.clone();
    let (done, finished) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        done.send(e.run(input, child)).unwrap();
    });
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), "active");
    cancel.cancel();
    let result = finished.recv_timeout(Duration::from_secs(3));
    worker.join().unwrap();
    assert_eq!(result.unwrap().unwrap().state, RunState::Cancelled);
    let admission = f.db.resource_admission();
    let (tx, rx) = mpsc::channel();
    let probe = CancellationToken::default();
    let probe_child = probe.clone();
    let worker = std::thread::spawn(move || {
        tx.send(
            admission
                .acquire(
                    "probe-writer",
                    &[ResourceClaim {
                        key: "active".into(),
                        access: Access::Write,
                    }],
                    &probe_child,
                )
                .unwrap()
                .is_some(),
        )
        .unwrap();
    });
    let acquired = rx.recv_timeout(Duration::from_secs(2));
    probe.cancel();
    worker.join().unwrap();
    assert_eq!(
        acquired.unwrap(),
        true,
        "cancelled read leaked its transient lease"
    );
}

#[test]
fn durable_operation_cancellation_before_worker_exists_prevents_recovered_reads() {
    let mut f = Fixture::new();
    let intent = admitted(&f, vec![node("a", &[]), node("b", &["a"])]);
    let action_id = intent.action_id().to_string();
    f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
        .unwrap();
    // This is the durable half of runtime.operation.cancel when no live child is registered.
    f.db.lock()
        .unwrap()
        .request_cancel_operation(&action_id)
        .unwrap();
    reopen(&mut f);
    let (input, recovery) =
        f.db.lock()
            .unwrap()
            .prepare_recovered_execution(
                &f.input.run_id,
                f.input.binding.clone(),
                identity(),
                Value::Null,
            )
            .unwrap();
    let e = engine(
        &f,
        Arc::new(Tools::new("must not read")),
        Arc::new(Policy::new(vec![])),
    );
    let report = e
        .run_recovered(input, CancellationToken::default(), recovery)
        .unwrap();
    assert!(matches!(
        report.state,
        RunState::Completed | RunState::Cancelled
    ));
    assert!(
        e.tools.calls.lock().unwrap().is_empty(),
        "durable graph cancellation was forgotten when the worker restarted"
    );
    assert!(e.provider.requests.lock().unwrap().is_empty());
    f.db.lock().unwrap().collect_content_objects().unwrap();
    let operation = f.db.lock().unwrap().operation(&action_id).unwrap();
    assert_eq!(operation.phase, OperationPhase::Terminal);
    let result: PolicyGraphResult = serde_json::from_value(operation.result.unwrap()).unwrap();
    assert_eq!(result.receipts.len(), 2);
    assert!(result.receipts.values().all(|r| r.output.is_none()));
}

// Inject real durable commands at exact worker interleavings. No fabricated Catalog errors.
enum Interleaving {
    CancelAfterGraphLoad(String),
    InputBeforeGraphAdmission,
}
struct InterleavingPersistence {
    db: Arc<Mutex<Catalog>>,
    interleaving: Interleaving,
    armed: AtomicBool,
    observed_input_pending: AtomicBool,
}
impl Persistence for InterleavingPersistence {
    fn resource_admission(
        &self,
    ) -> Arc<varin_runtime::resource_admission::ResourceAdmission> {
        self.db.resource_admission()
    }
    fn compile_context(
        &self,
        run: &str,
        epoch: u64,
        head: Option<&str>,
    ) -> Result<Option<ContextProjection>, ExecutionError> {
        self.db.compile_context(run, epoch, head)
    }
    fn consume_inputs(
        &self,
        run: &str,
        epoch: u64,
        head: Option<&str>,
    ) -> Result<Vec<ConversationItem>, ExecutionError> {
        self.db.consume_inputs(run, epoch, head)
    }
    fn commit(
        &self,
        run: &str,
        epoch: u64,
        record: &ExecutionRecord,
    ) -> Result<(), ExecutionError> {
        self.db.commit(run, epoch, record)
    }
    fn policy_boundary(&self, run: &str, epoch: u64) -> Result<PolicyBoundary, ExecutionError> {
        self.db.policy_boundary(run, epoch)
    }
    fn policy_graph(
        &self,
        run: &str,
        epoch: u64,
    ) -> Result<Option<PolicyGraphState>, ExecutionError> {
        let loaded = self.db.policy_graph(run, epoch)?;
        if let Interleaving::CancelAfterGraphLoad(action) = &self.interleaving {
            if self.armed.swap(false, Ordering::SeqCst) {
                self.db
                    .lock()
                    .unwrap()
                    .request_cancel_operation(action)
                    .unwrap();
            }
        }
        Ok(loaded)
    }
    fn admit_policy_graph(
        &self,
        run: &str,
        epoch: u64,
        intent: &PolicyGraphIntent,
    ) -> Result<PolicyGraphState, ExecutionError> {
        if matches!(self.interleaving, Interleaving::InputBeforeGraphAdmission)
            && self.armed.swap(false, Ordering::SeqCst)
        {
            self.db
                .lock()
                .unwrap()
                .enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
                    key: "winning-new-input".into(),
                    thread_id: "thread".into(),
                    branch_id: "main".into(),
                    mode: InputMode::Boundary,
                    input: json!({"text":"new input wins graph admission"}),
                    configuration: None,
                })
                .unwrap();
            let result = self.db.admit_policy_graph(run, epoch, intent);
            assert!(
                matches!(&result,Err(error) if error.code=="input_pending"),
                "expected actual Catalog input_pending admission race"
            );
            self.observed_input_pending.store(true, Ordering::SeqCst);
            assert!(
                self.db.policy_graph(run, epoch).unwrap().is_none(),
                "rejected graph must not be published"
            );
            return result;
        }
        self.db.admit_policy_graph(run, epoch, intent)
    }
    fn settle_policy_node(
        &self,
        run: &str,
        epoch: u64,
        action: &str,
        node: &str,
        completion: &ToolCompletion,
    ) -> Result<PolicyNodeReceipt, ExecutionError> {
        self.db
            .settle_policy_node(run, epoch, action, node, completion)
    }
    fn policy_evidence(
        &self,
        run: &str,
        epoch: u64,
        reference: &PolicyEvidenceRef,
    ) -> Result<ConversationItem, ExecutionError> {
        self.db.policy_evidence(run, epoch, reference)
    }
    fn policy_chunk(
        &self,
        run: &str,
        epoch: u64,
        reference: &PolicyEvidenceRef,
        index: usize,
    ) -> Result<varin_runtime::content::ContentChunk, ExecutionError> {
        self.db.policy_chunk(run, epoch, reference, index)
    }
    fn tool_source(
        &self,
        run: &str,
    ) -> Result<Option<varin_runtime::catalog::launches::SourceSelection>, ExecutionError> {
        self.db.tool_source(run)
    }
}
#[test]
fn operation_cancel_between_graph_load_and_child_registration_is_not_lost() {
    let f = Fixture::new();
    let intent = admitted(&f, vec![node("a", &[])]);
    let action_id = intent.action_id().to_string();
    f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
        .unwrap();
    let persistence = Arc::new(InterleavingPersistence {
        db: f.db.clone(),
        interleaving: Interleaving::CancelAfterGraphLoad(action_id.clone()),
        armed: AtomicBool::new(true),
        observed_input_pending: AtomicBool::new(false),
    });
    let e = ExecutionEngine {
        persistence,
        context_preparation: Arc::new(NoopContextPreparation),
        provider: Arc::new(Provider::default()),
        tools: Arc::new(Tools::new("must not read")),
        policy: Arc::new(Policy::new(vec![])),
        progress: ProgressSink::default(),
    };
    let _ = e
        .run(f.input.clone(), CancellationToken::default())
        .unwrap();
    assert!(
        e.tools.calls.lock().unwrap().is_empty(),
        "load-to-child-registration race lost durable cancellation"
    );
    assert!(
        f.db.lock()
            .unwrap()
            .operation(&action_id)
            .unwrap()
            .cancel_requested
    );
    f.db.lock().unwrap().collect_content_objects().unwrap();
}

#[test]
fn concurrent_small_receipt_publication_and_gc_preserve_every_committed_output() {
    let f = Fixture::new();
    let names: Vec<String> = (0..24).map(|i| format!("node-{i}")).collect();
    let intent = admitted(&f, names.iter().map(|id| node(id, &[])).collect());
    let action_id = intent.action_id().to_string();
    f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
        .unwrap();
    let start = Arc::new(std::sync::Barrier::new(5));
    let stop = Arc::new(AtomicBool::new(false));
    let gc_db = f.db.clone();
    let gc_start = start.clone();
    let gc_stop = stop.clone();
    let collector = std::thread::spawn(move || {
        gc_start.wait();
        let mut errors = vec![];
        while !gc_stop.load(Ordering::SeqCst) {
            if let Err(error) = gc_db.lock().unwrap().collect_content_objects() {
                errors.push(error.to_string());
            }
            std::thread::yield_now();
        }
        errors
    });
    let mut workers = vec![];
    for lane in 0..4 {
        let db = f.db.clone();
        let start = start.clone();
        let run = f.input.run_id.clone();
        let action = action_id.clone();
        let epoch = f.input.owner_generation;
        workers.push(std::thread::spawn(move || {
            start.wait();
            let mut results = vec![];
            for i in (lane..24).step_by(4) {
                let id = format!("node-{i}");
                let value = json!({"node":id,"small_payload":"evidence".repeat(64)});
                let completion = ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    effect: Effect::None,
                    content: value.clone(),
                };
                results.push((
                    value,
                    db.settle_policy_node(&run, epoch, &action, &id, &completion),
                ));
            }
            results
        }));
    }
    let results: Vec<_> = workers
        .into_iter()
        .flat_map(|worker| worker.join().unwrap())
        .collect();
    stop.store(true, Ordering::SeqCst);
    let gc_errors = collector.join().unwrap();
    assert!(
        gc_errors.is_empty(),
        "GC observed a dangling committed graph output: {gc_errors:?}"
    );
    f.db.lock().unwrap().collect_content_objects().unwrap();
    for (value, receipt) in results {
        let reference = receipt.unwrap().output.unwrap();
        let chunk =
            f.db.policy_chunk(&f.input.run_id, f.input.owner_generation, &reference, 0)
                .unwrap();
        assert_eq!(chunk.chunk_count, 1);
        assert_eq!(
            serde_json::from_slice::<Value>(&chunk.bytes).unwrap(),
            value
        );
    }
}

struct InputWinsPolicy {
    seen: Mutex<Vec<(Value, Value)>>,
}
impl AgentPolicy for InputWinsPolicy {
    fn identity(&self) -> PolicyIdentity {
        identity()
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        self.seen
            .lock()
            .unwrap()
            .push((serde_json::to_value(event).unwrap(), state.clone()));
        match event {
            PolicyEvent::Started => Ok(PolicyDecision {
                action: action(graph(vec![node("obsolete-read", &[])])),
                state: json!({"generation":1}),
            }),
            PolicyEvent::InputDelivered { .. } => {
                if !state.is_null() {
                    return Err(ExecutionError::new("uncommitted_policy_state","failed graph admission leaked its proposed checkpoint into the next decision"));
                }
                Ok(PolicyDecision {
                    action: PolicyAction::Complete,
                    state: json!({"new_input_handled":true}),
                })
            }
            _ => Err(ExecutionError::new(
                "unexpected_event",
                "unadmitted graph executed",
            )),
        }
    }
}
#[test]
fn actual_new_input_winning_graph_admission_preserves_previous_policy_checkpoint() {
    let f = Fixture::new();
    let persistence = Arc::new(InterleavingPersistence {
        db: f.db.clone(),
        interleaving: Interleaving::InputBeforeGraphAdmission,
        armed: AtomicBool::new(true),
        observed_input_pending: AtomicBool::new(false),
    });
    let policy = Arc::new(InputWinsPolicy {
        seen: Mutex::new(vec![]),
    });
    let e = ExecutionEngine {
        context_preparation: Arc::new(NoopContextPreparation),
        persistence: persistence.clone(),
        provider: Arc::new(Provider::default()),
        tools: Arc::new(Tools::new("must not execute")),
        policy: policy.clone(),
        progress: ProgressSink::default(),
    };
    let report = e
        .run(f.input.clone(), CancellationToken::default())
        .unwrap();
    assert!(persistence.observed_input_pending.load(Ordering::SeqCst));
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    assert_eq!(report.policy_state, json!({"new_input_handled":true}));
    assert!(report.history.iter().any(
        |item| matches!(&item.content,Content::Text{text} if text=="new input wins graph admission")
    ));
    assert!(e.tools.calls.lock().unwrap().is_empty());
    assert!(e.provider.requests.lock().unwrap().is_empty());
    let seen = policy.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].0["kind"], "input_delivered");
    assert_eq!(seen[1].1, Value::Null);
    assert!(f
        .db
        .lock()
        .unwrap()
        .events_after(0, 1000)
        .unwrap()
        .iter()
        .all(|event| event.kind != "policy.graph_admitted"));
}
