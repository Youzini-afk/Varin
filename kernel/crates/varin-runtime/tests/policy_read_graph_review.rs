//! Independent adversarial tests: graph evidence is not a synthetic model tool exchange.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
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
        outcome: Outcome::Succeeded,
        effect: Effect::None,
        content: value.clone(),
    };
    let worker_run = run.clone();
    let worker_action = action.clone();
    let worker_completion = completion.clone();
    let receipt = content_window::during_write(
        &f.root,
        &f.db,
        move |db| {
            db.settle_policy_node(
                &worker_run,
                epoch,
                &worker_action,
                "large",
                &worker_completion,
            )
        },
        |catalog| {
            let graph = catalog.policy_graph(&run, epoch).unwrap().unwrap();
            assert!(
                graph.result.receipts.is_empty(),
                "body must precede receipt publication"
            );
            assert_eq!(catalog.collect_content_objects().unwrap(), 0);
            catalog
                .create_thread("independent", "independent-main")
                .unwrap();
        },
    )
    .unwrap();
    let before = f.db.lock().unwrap().operation(&action).unwrap().revision;
    assert_eq!(
        f.db.settle_policy_node(&run, epoch, &action, "large", &completion)
            .unwrap(),
        receipt
    );
    assert_eq!(
        f.db.lock().unwrap().operation(&action).unwrap().revision,
        before
    );
    assert!(f
        .db
        .settle_policy_node(
            &run,
            epoch,
            &action,
            "large",
            &ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: json!("different body"),
            }
        )
        .is_err());
    f.db.lock().unwrap().collect_content_objects().unwrap();
    let evidence =
        f.db.policy_evidence(&run, epoch, receipt.output().unwrap())
            .unwrap();
    assert!(serde_json::to_string(&evidence.item.content)
        .unwrap()
        .contains(value["evidence"].as_str().unwrap()));
}

#[test]
fn graph_cancellation_and_node_settlement_do_not_hydrate_the_definition() {
    let f = Fixture::new();
    let intent = admitted(&f, vec![node("a", &[]), node("b", &["a"])]);
    let run = &f.input.run_id;
    let epoch = f.input.owner_generation;
    f.db.admit_policy_graph(run, epoch, &intent).unwrap();
    let action = intent.action_id();
    let operation = f.db.lock().unwrap().operation(action).unwrap();
    assert!(operation.intent.get("nodes").is_none());
    let hash = operation.intent["body_ref"]["content_object"]
        .as_str()
        .unwrap()
        .strip_prefix("sha256-")
        .unwrap();
    std::fs::write(
        f.root
            .join("content/objects")
            .join(&hash[..2])
            .join(&hash[2..]),
        b"damaged definition",
    )
    .unwrap();
    assert!(f.db.policy_graph(run, epoch).is_err());
    let origin = ToolOrigin::PolicyAction {
        action_id: action.into(),
        node_id: "a".into(),
    };
    assert_eq!(
        f.db.lock()
            .unwrap()
            .inspect_admission(run, epoch, &origin, "a")
            .unwrap()["state"],
        "not_active"
    );
    f.db.lock()
        .unwrap()
        .request_cancel_operation(action)
        .unwrap();
    for node in ["a", "b"] {
        let receipt =
            f.db.settle_policy_node(
                run,
                epoch,
                action,
                node,
                &ToolCompletion::NotDispatched {
                    reason: "cancelled".into(),
                },
            )
            .unwrap();
        assert_eq!(receipt.outcome(), Outcome::Cancelled);
    }
    let operation = f.db.lock().unwrap().operation(action).unwrap();
    assert_eq!(operation.phase, OperationPhase::Terminal);
    assert_eq!(operation.outcome, Some(Outcome::Cancelled));
    assert_eq!(
        f.db.lock()
            .unwrap()
            .inspect_admission(run, epoch, &origin, "a")
            .unwrap()["state"],
        "settled"
    );
    f.db.lock()
        .unwrap()
        .create_thread("independent", "independent-main")
        .unwrap();
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
                description: String::new(),
                output_schema: None,
                metadata: None,
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
    json!({"kind":"tool_graph","nodes":nodes})
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
    fn plan(
        &self,
        call: &varin_runtime::execution::ToolCall,
        context: &varin_runtime::execution::FrozenToolContext,
        cancel: &varin_runtime::execution::CancellationToken,
    ) -> Result<varin_runtime::execution::ToolPreparation, varin_runtime::execution::ExecutionError>
    {
        self.prepare(call, context, cancel)
            .map(varin_runtime::execution::ToolPreparation::Ready)
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
            "tool_graph_completed" => {
                let outputs: Vec<Value> = event["receipts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|r| {
                        r["completion"]
                            .get("output")
                            .filter(|r| !r.is_null())
                            .cloned()
                    })
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
        assert_eq!(events[1]["kind"], "tool_graph_completed");
        for request in requests.iter() {
            assert!(request.history.iter().any(|item| matches!(
                &item.provenance,
                Provenance::PolicyToolData { .. }
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
fn trusted_read_opt_in_controls_replay_cost_without_replacing_dispatch_authority() {
    for (readonly, trusted, revoked) in [
        (false, true, false),
        (true, false, false),
        (true, true, true),
    ] {
        let f = Fixture::new();
        let mut tools = Tools::new("ordinary invocation");
        tools.readonly = readonly;
        tools.trusted = trusted;
        tools.revoked.store(revoked, Ordering::SeqCst);
        let tools = Arc::new(tools);
        let e = engine(
            &f,
            tools.clone(),
            Arc::new(Policy::new(vec![node("x", &[])])),
        );
        e.run(f.input.clone(), CancellationToken::default())
            .unwrap();
        assert_eq!(tools.calls.lock().unwrap().len(), usize::from(!revoked));
        let events = e.policy.events.lock().unwrap();
        let completion = &events
            .iter()
            .find(|event| event["kind"] == "tool_graph_completed")
            .unwrap()["receipts"][0]["completion"];
        if revoked {
            assert_eq!(completion["kind"], "not_dispatched");
        } else if readonly {
            assert_eq!(completion["effect"], "none");
        } else {
            assert_eq!(completion["effect"], "unknown");
            assert_eq!(completion["outcome"], "indeterminate");
        }
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
    let nodes = nodes
        .into_iter()
        .map(|value| {
            let node: PolicyToolNode = serde_json::from_value(value).unwrap();
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

            PolicyAdmittedNode { node, context }
        })
        .collect();
    PolicyGraphIntent::PolicyToolGraphV1 {
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
    let PolicyGraphIntent::PolicyToolGraphV1 { nodes, .. } = &mut altered;
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
            "tool_graph_completed",
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
    let reference = receipt.output().unwrap().clone();
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
    for kind in ["read_result", "read_result_consumed", "request_model_with_evidence", "complete"] {
        let mut f = Fixture::new();
        let intent = admitted(&f, vec![node("a", &[])]);
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
        let reference = receipt.output().unwrap().clone();
        let next = match kind {
            "read_result" | "read_result_consumed" => json!({"kind":"read_result","reference":reference,"index":0}),
            "request_model_with_evidence" => json!({"kind":kind,"evidence":[reference]}),
            _ => json!({"kind":kind}),
        };
        f.db.commit(
            &f.input.run_id,
            f.input.owner_generation,
            &ExecutionRecord::PolicyCheckpoint {
                previous_state: json!({"stage":"admitted"}),
                event: PolicyEvent::ToolGraphCompleted { action_id: action_id.clone(), receipts: vec![receipt] },
                identity: identity(),
                state: json!({"marker":"committed-after-results"}),
                action: action(next),
            },
        )
        .unwrap();
        if kind == "read_result_consumed" {
            let chunk = f.db.policy_chunk(&f.input.run_id, f.input.owner_generation, &reference, 0).unwrap();
            f.db.commit(&f.input.run_id, f.input.owner_generation, &ExecutionRecord::PolicyDecisionConsumed {
                event: PolicyEvent::ResultChunk { reference, index: 0, total_chunks: chunk.chunk_count, total_bytes: chunk.total_bytes, bytes: chunk.bytes },
            }).unwrap();
        }
        reopen(&mut f);
        f.db.lock().unwrap().collect_content_objects().unwrap();
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
            expected: if kind.starts_with("read_result") {
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
    let events = e.policy.events.lock().unwrap();
    let completed = events
        .iter()
        .find(|event| event["kind"] == "tool_graph_completed")
        .unwrap();
    let receipts: Vec<PolicyNodeReceipt> =
        serde_json::from_value(completed["receipts"].clone()).unwrap();
    assert_eq!(receipts.len(), 2);
    assert!(receipts
        .iter()
        .all(|receipt| receipt.outcome() == Outcome::Cancelled && receipt.output().is_none()));
}

// Inject real durable commands at exact worker interleavings. No fabricated Catalog errors.
enum Interleaving {
    CancelBeforeNodeDispatch { run: bool, token: CancellationToken },
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
    fn resume_tool(
        &self,
        context: &ToolExecutionContext,
        epoch: u64,
    ) -> Result<ToolResume, ExecutionError> {
        self.db.resume_tool(context, epoch)
    }
    fn resource_admission(&self) -> Arc<varin_runtime::resource_admission::ResourceAdmission> {
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
        if let (
            Interleaving::CancelBeforeNodeDispatch {
                run: cancel_run,
                token,
            },
            ExecutionRecord::ToolDispatched { context, .. },
        ) = (&self.interleaving, record)
        {
            if self.armed.swap(false, Ordering::SeqCst) {
                if *cancel_run {
                    self.db.lock().unwrap().request_cancel_run(run).unwrap();
                    token.cancel();
                } else {
                    self.db
                        .lock()
                        .unwrap()
                        .request_cancel_operation(&context.operation_id)
                        .unwrap();
                }
            }
        }
        self.db.commit(run, epoch, record)
    }
    fn policy_boundary(&self, run: &str, epoch: u64) -> Result<PolicyBoundary, ExecutionError> {
        self.db.policy_boundary(run, epoch)
    }
    fn policy_action(
        &self,
        run: &str,
        epoch: u64,
    ) -> Result<Option<PolicyActionState>, ExecutionError> {
        Ok(self.policy_graph(run, epoch)?.map(PolicyActionState::Graph))
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
    ) -> Result<PolicyEvidence, ExecutionError> {
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
        let reference = receipt.unwrap().output().unwrap().clone();
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

/// A durable fixture executor journal models the independent resource owner's original receipt.
struct EffectOwner {
    journal: std::path::PathBuf,
}
impl EffectOwner {
    fn receipt(&self) -> ExternalReceipt {
        serde_json::from_value(
            serde_json::from_slice::<Value>(&std::fs::read(&self.journal).unwrap()).unwrap()
                ["receipt"]
                .clone(),
        )
        .unwrap()
    }
    fn writes(&self) -> u64 {
        std::fs::read(&self.journal)
            .ok()
            .map(|bytes| {
                serde_json::from_slice::<Value>(&bytes).unwrap()["writes"]
                    .as_u64()
                    .unwrap()
            })
            .unwrap_or(0)
    }
}
impl ToolExecutor for EffectOwner {
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, context, cancel)
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
            schema_version: call.schema_version.clone(),
            read_only: call.arguments["read_only"] == true,
            completion: if call.arguments["job"] == true {
                CompletionKind::Job
            } else {
                CompletionKind::Result
            },
            lifetime: if call.arguments["job"] == true {
                Lifetime::Thread
            } else {
                Lifetime::Run
            },
            resources: vec![ResourceClaim {
                key: format!("owner:{}", call.call_id),
                access: if call.arguments["read_only"] == true {
                    Access::Read
                } else {
                    Access::Write
                },
            }],
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
        context: &ToolExecutionContext,
        _: &ToolCall,
        contract: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        assert!(matches!(context.origin, ToolOrigin::PolicyAction { .. }));
        let receipt = ExternalReceipt {
            executor: contract.name.clone(),
            identity: context.operation_id.clone(),
            epoch: "original-executor-generation".into(),
            outcome: Outcome::Succeeded,
            effect: if contract.read_only {
                Effect::None
            } else {
                Effect::Confirmed
            },
            result: Value::Null,
        };
        std::fs::write(
            &self.journal,
            serde_json::to_vec(&json!({"writes":self.writes()+1,"receipt":receipt})).unwrap(),
        )
        .unwrap();
        if contract.completion == CompletionKind::Job {
            ToolCompletion::JobAccepted {
                operation_id: context.operation_id.clone(),
                phase: "running".into(),
                effect: if contract.read_only {
                    Effect::None
                } else {
                    Effect::Dispatched
                },
                lifetime: Lifetime::Thread,
            }
        } else {
            ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::Confirmed,
                content: Value::Null,
            }
        }
    }
}
fn effect_context(f: &Fixture, intent: &PolicyGraphIntent) -> (ToolExecutionContext, AdmittedTool) {
    let node = &intent.nodes()[0];
    let context = ToolExecutionContext {
        run_id: f.input.run_id.clone(),
        origin: node.context.origin.clone(),
        operation_id: node.context.origin.operation_id(&node.node.call.call_id),
    };
    let owner = EffectOwner {
        journal: f.root.join("owner-journal.json"),
    };
    let contract = owner
        .prepare(
            &node.node.call,
            &node.context,
            &CancellationToken::default(),
        )
        .unwrap();
    (
        context,
        AdmittedTool {
            call: node.node.call.clone(),
            contract,
        },
    )
}

#[test]
fn effect_graph_recovery_uses_original_executor_at_every_dispatch_cut() {
    // 0: admitted; 1: dispatched without receipt; 2: original executor receipt durable;
    // 3: canonical completion durable but graph has not consumed it.
    for cut in 0..4 {
        let mut f = Fixture::new();
        let intent = admitted(&f, vec![node("mutation", &[])]);
        f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
            .unwrap();
        let (context, tool) = effect_context(&f, &intent);
        f.db.commit(
            &f.input.run_id,
            f.input.owner_generation,
            &ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: tool.clone(),
            },
        )
        .unwrap();
        let owner = Arc::new(EffectOwner {
            journal: f.root.join("owner-journal.json"),
        });
        if cut > 0 {
            f.db.commit(
                &f.input.run_id,
                f.input.owner_generation,
                &ExecutionRecord::ToolDispatched {
                    executor_owner: varin_runtime::ExecutorOwner::Kernel,
                    context: context.clone(),
                },
            )
            .unwrap();
            let completion = owner.execute(
                &context,
                &tool.call,
                &tool.contract,
                &CancellationToken::default(),
            );
            if cut == 2 {
                varin_runtime::catalog::result_content::record_external_receipt(
                    &f.db,
                    &context.operation_id,
                    owner.receipt(),
                    true,
                )
                .unwrap();
            }
            if cut == 3 {
                f.db.commit(
                    &f.input.run_id,
                    f.input.owner_generation,
                    &ExecutionRecord::ToolSettled {
                        executor_stopped: true,
                        context: context.clone(),
                        completion,
                    },
                )
                .unwrap();
            }
        }
        reopen(&mut f);
        if cut == 1 {
            let epoch = f.db.lock().unwrap().epoch();
            assert!(
                f.db.resume_tool(&context, epoch).is_err(),
                "unknown dispatch must never become another execute"
            );
            assert_eq!(owner.writes(), 1);
            varin_runtime::catalog::result_content::record_external_receipt(
                &f.db,
                &context.operation_id,
                owner.receipt(),
                true,
            )
            .unwrap();
        }
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
        let e = ExecutionEngine {
            persistence: f.db.clone(),
            provider: Arc::new(Provider::default()),
            tools: owner.clone(),
            policy: Arc::new(Policy::new(vec![])),
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        };
        assert_eq!(
            e.run_recovered(input, CancellationToken::default(), recovery)
                .unwrap()
                .state,
            RunState::Completed
        );
        assert_eq!(
            owner.writes(),
            1,
            "recovering cut {cut} repeated the effect"
        );
        let db = f.db.lock().unwrap();
        let metadata = db.operation(&context.operation_id).unwrap();
        let op = db.capture_operation_read(metadata).load().unwrap();
        assert_eq!(
            op.intent["origin"],
            serde_json::to_value(&context.origin).unwrap()
        );
        assert_eq!(op.result, Some(Value::Null));
        assert!(matches!(
            op.call_completion,
            Some(ToolCompletion::Result {
                content: Value::Null,
                effect: Effect::Confirmed,
                ..
            })
        ));
        let events = e.policy.events.lock().unwrap();
        let receipt = &events
            .iter()
            .find(|event| event["kind"] == "tool_graph_completed")
            .unwrap()["receipts"][0];
        assert!(
            receipt["completion"]["output"]["content_ref"].is_string(),
            "null is real result content with an owned reference"
        );
        assert!(e.provider.requests.lock().unwrap().is_empty());
    }
}

#[test]
fn cancelled_admitted_node_survives_reopen_without_dispatch_or_stranded_frontend_work() {
    let mut f = Fixture::new();
    let intent = admitted(&f, vec![node("mutation", &[])]);
    f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
        .unwrap();
    let (context, tool) = effect_context(&f, &intent);
    f.db.commit(
        &f.input.run_id,
        f.input.owner_generation,
        &ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool,
        },
    )
    .unwrap();
    f.db.lock()
        .unwrap()
        .request_cancel_operation(&context.operation_id)
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
    let owner = Arc::new(EffectOwner {
        journal: f.root.join("owner-journal.json"),
    });
    let e = ExecutionEngine {
        persistence: f.db.clone(),
        provider: Arc::new(Provider::default()),
        tools: owner.clone(),
        policy: Arc::new(Policy::new(vec![])),
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    };
    assert_eq!(
        e.run_recovered(input, CancellationToken::default(), recovery)
            .unwrap()
            .state,
        RunState::Completed
    );
    assert_eq!(owner.writes(), 0);
    let op =
        f.db.lock()
            .unwrap()
            .operation(&context.operation_id)
            .unwrap();
    assert_eq!(
        (op.phase, op.outcome, op.effect),
        (
            OperationPhase::Terminal,
            Some(Outcome::Cancelled),
            Effect::None
        )
    );
}

#[test]
fn job_acceptance_unblocks_graph_dependency_and_late_terminal_preserves_call_receipt() {
    let f = Fixture::new();
    let mut job = node("job", &[]);
    job["call"]["arguments"]["job"] = json!(true);
    let owner = Arc::new(EffectOwner {
        journal: f.root.join("owner-journal.json"),
    });
    let e = ExecutionEngine {
        persistence: f.db.clone(),
        provider: Arc::new(Provider::default()),
        tools: owner.clone(),
        policy: Arc::new(Policy::new(vec![job, node("after", &["job"])])),
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    };
    assert_eq!(
        e.run(f.input.clone(), CancellationToken::default())
            .unwrap()
            .state,
        RunState::Completed
    );
    let events = e.policy.events.lock().unwrap();
    let graph = events
        .iter()
        .find(|event| event["kind"] == "tool_graph_completed")
        .unwrap();
    assert_eq!(graph["receipts"][0]["completion"]["kind"], "job_accepted");
    assert_eq!(graph["receipts"][1]["completion"]["outcome"], "succeeded");
    let id = graph["receipts"][0]["completion"]["operation_id"]
        .as_str()
        .unwrap();
    let before = f.db.lock().unwrap().operation(id).unwrap();
    assert!(before.handed_off);
    assert_ne!(before.phase, OperationPhase::Terminal);
    let receipt = ExternalReceipt {
        executor: "read".into(),
        identity: id.into(),
        epoch: "original-executor-generation".into(),
        outcome: Outcome::Succeeded,
        effect: Effect::Confirmed,
        result: json!({"job":"finished"}),
    };
    let after =
        varin_runtime::catalog::result_content::record_external_receipt(&f.db, id, receipt, true)
            .unwrap();
    assert_eq!(after.call_completion, before.call_completion);
    assert_eq!(
        (after.phase, after.outcome),
        (OperationPhase::Terminal, Some(Outcome::Succeeded))
    );
    assert_eq!(
        owner.writes(),
        2,
        "dependent ran before job completion without restarting either call"
    );
}

#[test]
fn cancellation_winning_durable_dispatch_settles_without_executor_entry() {
    for cancel_run in [false, true] {
        let f = Fixture::new();
        let cancel = CancellationToken::default();
        let persistence = Arc::new(InterleavingPersistence {
            db: f.db.clone(),
            interleaving: Interleaving::CancelBeforeNodeDispatch {
                run: cancel_run,
                token: cancel.clone(),
            },
            armed: AtomicBool::new(true),
            observed_input_pending: AtomicBool::new(false),
        });
        let owner = Arc::new(EffectOwner {
            journal: f.root.join("owner-journal.json"),
        });
        let e = ExecutionEngine {
            persistence,
            provider: Arc::new(Provider::default()),
            tools: owner.clone(),
            policy: Arc::new(Policy::new(vec![node("mutation", &[])])),
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        };
        let report = e.run(f.input.clone(), cancel).unwrap();
        assert_eq!(
            report.state,
            if cancel_run {
                RunState::Cancelled
            } else {
                RunState::Completed
            }
        );
        assert_eq!(owner.writes(), 0);
        let db = f.db.lock().unwrap();
        let event = db
            .events_after(0, 100)
            .unwrap()
            .into_iter()
            .find(|event| event.kind == "operation.settled")
            .unwrap();
        let operation = db.operation(&event.subject).unwrap();
        assert_eq!(
            (operation.phase, operation.outcome, operation.effect),
            (
                OperationPhase::Terminal,
                Some(Outcome::Cancelled),
                Effect::None
            )
        );
        assert!(db.resource_admission().inspect(&operation.id).is_none());
    }
}

#[test]
fn read_only_job_recovery_waits_for_original_executor_at_both_completion_cuts() {
    for accepted in [false, true] {
        let mut f = Fixture::new();
        let mut job = node("job", &[]);
        job["call"]["arguments"] = json!({"job":true,"read_only":true});
        let intent = admitted(&f, vec![job]);
        f.db.admit_policy_graph(&f.input.run_id, f.input.owner_generation, &intent)
            .unwrap();
        let (context, tool) = effect_context(&f, &intent);
        let owner = Arc::new(EffectOwner {
            journal: f.root.join("owner-journal.json"),
        });
        f.db.commit(
            &f.input.run_id,
            f.input.owner_generation,
            &ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: tool.clone(),
            },
        )
        .unwrap();
        f.db.commit(
            &f.input.run_id,
            f.input.owner_generation,
            &ExecutionRecord::ToolDispatched {
                executor_owner: varin_runtime::ExecutorOwner::Kernel,
                context: context.clone(),
            },
        )
        .unwrap();
        let original = owner.execute(
            &context,
            &tool.call,
            &tool.contract,
            &CancellationToken::default(),
        );
        if accepted {
            f.db.commit(
                &f.input.run_id,
                f.input.owner_generation,
                &ExecutionRecord::ToolSettled {
                    executor_stopped: false,
                    context: context.clone(),
                    completion: original.clone(),
                },
            )
            .unwrap();
        }
        let before =
            f.db.lock()
                .unwrap()
                .operation(&context.operation_id)
                .unwrap();
        assert_eq!(
            (before.phase, before.effect),
            (OperationPhase::Running, Effect::None)
        );
        reopen(&mut f);
        let epoch = f.db.lock().unwrap().epoch();
        let recovered =
            f.db.lock()
                .unwrap()
                .operation(&context.operation_id)
                .unwrap();
        assert_eq!(
            (recovered.phase, recovered.outcome, recovered.effect),
            (
                OperationPhase::Terminal,
                Some(Outcome::Indeterminate),
                Effect::None
            )
        );
        assert_eq!(recovered.result, before.result);
        assert_eq!(recovered.call_completion, before.call_completion);
        assert!(f
            .db
            .lock()
            .unwrap()
            .pending_external_operations("read")
            .unwrap()
            .contains(&context.operation_id));
        assert!(f
            .db
            .resource_admission()
            .inspect(&context.operation_id)
            .is_some());
        if !accepted {
            assert!(
                matches!(f.db.resume_tool(&context,epoch),Err(error) if error.code=="tool_reconciliation_required")
            );
        }
        let receipt = owner.receipt();
        let after = varin_runtime::catalog::result_content::record_external_receipt(
            &f.db,
            &context.operation_id,
            receipt.clone(),
            false,
        )
        .unwrap();
        assert_eq!(
            (after.phase, after.outcome, after.effect),
            (
                OperationPhase::Terminal,
                Some(Outcome::Succeeded),
                Effect::None
            )
        );
        assert_eq!(after.call_completion, before.call_completion);
        assert!(
            f.db.resource_admission()
                .inspect(&context.operation_id)
                .is_some(),
            "business terminal is not executor-stop evidence"
        );
        let cursor =
            f.db.lock()
                .unwrap()
                .events_after(0, 1000)
                .unwrap()
                .last()
                .unwrap()
                .cursor;
        let repeated = varin_runtime::catalog::result_content::record_external_receipt(
            &f.db,
            &context.operation_id,
            receipt.clone(),
            false,
        )
        .unwrap();
        assert_eq!(repeated.revision, after.revision);
        assert!(f
            .db
            .lock()
            .unwrap()
            .events_after(cursor, 1000)
            .unwrap()
            .is_empty());
        let stopped = varin_runtime::catalog::result_content::record_external_receipt(
            &f.db,
            &context.operation_id,
            receipt,
            true,
        )
        .unwrap();
        assert_eq!(stopped.revision, after.revision);
        assert!(f
            .db
            .resource_admission()
            .inspect(&context.operation_id)
            .is_none());
        let completion = match f.db.resume_tool(&context, epoch).unwrap() {
            ToolResume::Completed(read) => read.load().unwrap(),
            _ => panic!("original executor terminal must close the invocation"),
        };
        assert_eq!(
            completion,
            if accepted {
                original
            } else {
                ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    effect: Effect::None,
                    content: Value::Null,
                }
            }
        );
        let revision =
            f.db.lock()
                .unwrap()
                .operation(&context.operation_id)
                .unwrap()
                .revision;
        let cursor =
            f.db.lock()
                .unwrap()
                .events_after(0, 1000)
                .unwrap()
                .last()
                .unwrap()
                .cursor;
        assert!(matches!(
            f.db.resume_tool(&context, epoch).unwrap(),
            ToolResume::Completed(_)
        ));
        assert_eq!(
            f.db.lock()
                .unwrap()
                .operation(&context.operation_id)
                .unwrap()
                .revision,
            revision
        );
        assert!(f
            .db
            .lock()
            .unwrap()
            .events_after(cursor, 1000)
            .unwrap()
            .is_empty());
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
        let engine = ExecutionEngine {
            persistence: f.db.clone(),
            provider: Arc::new(Provider::default()),
            tools: owner.clone(),
            policy: Arc::new(Policy::new(vec![])),
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        };
        assert_eq!(
            engine
                .run_recovered(input, CancellationToken::default(), recovery)
                .unwrap()
                .state,
            RunState::Completed
        );
        let events = engine.policy.events.lock().unwrap();
        let graph = events
            .iter()
            .find(|event| event["kind"] == "tool_graph_completed")
            .unwrap();
        assert_eq!(
            graph["receipts"][0]["completion"]["kind"],
            if accepted { "job_accepted" } else { "result" }
        );
        assert_eq!(
            owner.writes(),
            1,
            "recovery must never re-enter the original executor"
        );
    }
}
