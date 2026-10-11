//! Real passive resource notifications through original Engine/Host/permission/MCP stdio owners.
use super::mcp_review_fixture::*;
use super::*;
use crate::host_tools::ToolBridge;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};

struct Model {
    calls: Vec<(String, String, Value)>,
    views: Arc<Mutex<Vec<RequestView>>>,
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        self.views.lock().unwrap().push(view.clone());
        Ok(json!({"request":view.request_id}))
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let next = self.calls.iter().find(|(id, _, _)| {
            !request.view.history.iter().any(
                |item| matches!(&item.content,Content::ToolResult{result} if &result.call_id==id),
            )
        });
        if let Some((id, name, args)) = next {
            let schema = request
                .view
                .binding
                .tools
                .iter()
                .find(|t| &t.name == name)
                .unwrap();
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: format!("{}:{id}", request.view.request_id),
                    opaque: None,
                    content: Content::ToolCall {
                        call: ToolCall {
                            call_id: id.clone(),
                            name: name.clone(),
                            schema_version: schema.version.clone(),
                            arguments: args.clone(),
                        },
                    },
                },
            })
            .unwrap();
            Ok(FinishReason::ToolCalls)
        } else {
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: format!("{}:answer", request.view.request_id),
                    opaque: None,
                    content: Content::Text {
                        text: "Original resource lifecycle observed".into(),
                    },
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
}
fn submit_on(db: &mut Catalog, thread: &str, branch: &str, key: &str) -> varin_runtime::Receipt {
    let p = db
        .prepare_submission(
            SubmitInput {
                key: key.into(),
                thread_id: thread.into(),
                branch_id: branch.into(),
                expected_head: db.head(branch).unwrap(),
                input: json!({"text":"Observe through the original MCP server"}),
                configuration: model_configuration(),
            },
            None,
            None,
        )
        .unwrap();
    db.admit_submission(p.load(None, false).unwrap()).unwrap()
}
fn prepared(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            Instant::now() < deadline,
            "Host resource preparation stalled"
        );
        if let Some(frame) = host.pump(runtime, bridge, outgoing) {
            assert_eq!(frame["kind"], "fixture-prepared");
            return frame;
        }
    }
}
fn run(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
    receipt: &varin_runtime::Receipt,
    prepared: &Value,
    calls: Vec<(String, String, Value)>,
) -> Vec<RequestView> {
    run_with_policy(
        host,
        runtime,
        bridge,
        outgoing,
        receipt,
        prepared,
        calls,
        Arc::new(DefaultAgentPolicy),
    )
}
fn run_with_policy(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
    receipt: &varin_runtime::Receipt,
    prepared: &Value,
    calls: Vec<(String, String, Value)>,
    policy: Arc<dyn AgentPolicy>,
) -> Vec<RequestView> {
    let (report, views) = execute_with_policy(
        host, runtime, bridge, outgoing, receipt, prepared, calls, policy,
    );
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    views
}
fn execute_with_policy(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
    receipt: &varin_runtime::Receipt,
    prepared: &Value,
    calls: Vec<(String, String, Value)>,
    policy: Arc<dyn AgentPolicy>,
) -> (ExecutionReport, Vec<RequestView>) {
    let live = live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
    let mut binding = request_binding(&live, receipt);
    binding.history_range.branch_id = runtime
        .catalog()
        .lock()
        .unwrap()
        .run(&receipt.run_id)
        .unwrap()
        .branch_id;
    let mut launch = varin_runtime::catalog::launches::LaunchSelection::from_binding(
        &binding,
        policy.identity(),
        None,
    );
    launch.mcp_binding = Some(live.binding.clone());
    runtime
        .catalog()
        .lock()
        .unwrap()
        .bind_launch(&receipt.run_id, launch)
        .unwrap();
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone());
    let scope = tools
        .prepare_scope(&receipt.run_id, vec![], Some(live), vec![])
        .unwrap();
    let executor = tools.install(&receipt.run_id, 1, scope).unwrap();
    let views = Arc::new(Mutex::new(Vec::new()));
    let execution = runtime
        .start(
            &receipt.run_id,
            RunStart {
                binding,
                policy_state: Value::Null,
                provider: Arc::new(Model {
                    calls,
                    views: views.clone(),
                }),
                tools: executor,
                policy,
                context_preparation: Arc::new(crate::child_capabilities::BindingPreparation {
                    inner: Arc::new(NoopContextPreparation),
                    catalog: runtime.catalog(),
                }),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    let (tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(execution.wait());
    });
    let mut report = None;
    host.until(runtime, bridge, outgoing, || {
        report = done.try_recv().ok();
        report.is_some()
    });
    let report = report.unwrap().unwrap();
    tools.release(&receipt.run_id);
    host.send(
        json!({"v":1,"kind":"host-tool-owner-release","kernelEpoch":EPOCH,"runId":receipt.run_id}),
    );
    let result = views.lock().unwrap().clone();
    (report, result)
}
fn subscribe(prepared: &Value, id: &str, uri: &str) -> (String, String, Value) {
    let binding: crate::host_tools::LiveMcpBinding =
        live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
    let name = binding
        .binding
        .routes
        .iter()
        .find_map(|(name, route)| {
            matches!(route, varin_runtime::McpRoute::ResourceSubscribe { .. }).then(|| name.clone())
        })
        .unwrap();
    (
        id.into(),
        name,
        json!({"server":"original","schemaVersion":prepared["schemaVersion"],"uri":uri}),
    )
}
fn operation(views: &[RequestView], id: &str) -> String {
    views
        .last()
        .unwrap()
        .history
        .iter()
        .find_map(|item| match &item.content {
            Content::ToolResult { result } if result.call_id == id => {
                assert!(
                    matches!(
                        result.completion,
                        ToolCompletion::Result {
                            outcome: Outcome::Succeeded,
                            effect: Effect::Confirmed,
                            ..
                        }
                    ),
                    "{result:?}"
                );
                Some(
                    ToolOrigin::ModelStep {
                        request_id: result.request_id.clone(),
                    }
                    .operation_id(id),
                )
            }
            _ => None,
        })
        .unwrap()
}
fn control(root: &Path, value: Value) {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("resource-controls.jsonl"))
        .unwrap();
    writeln!(file, "{value}").unwrap();
    file.flush().unwrap();
}
fn trace(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("resource-trace.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn finish(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
) {
    host.send(json!({"kind":"fixture-finish"}));
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline);
        if let Some(frame) = host.pump(runtime, bridge, outgoing) {
            assert_eq!(frame["kind"], "fixture-finished");
            break;
        }
    }
}
#[test]
#[ignore = "requires workspace Node/tsx and built pi-host; real MCP stdio, no product socket"]
fn original_resource_observers_preserve_shared_owners_passive_facts_cancel_and_reopen() {
    let root = std::env::temp_dir().join(format!("varin-mcp-resources-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("catalog");
    let mut db = Catalog::open(&path).unwrap();
    db.create_thread("thread", "main").unwrap();
    db.create_thread("sibling", "other").unwrap();
    let first = submit_on(&mut db, "thread", "main", "first");
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","resources":true,"epoch":EPOCH,"root":root,"runId":first.run_id}));
    let p = prepared(&mut host, &runtime, &bridge, &outgoing);
    let call = subscribe(&p, "watch-first", "fixture://watched");
    let views = run(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &first,
        &p,
        vec![call],
    );
    let first_id = operation(&views, "watch-first");
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&first_id)
            .unwrap()
            .mcp_resource_subscription
            .unwrap()
            .last_event_cursor
            .is_some()
    });
    let original = runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(&first_id)
        .unwrap();
    let original_completion = original.call_completion.clone();
    let original_receipt = original.external_receipt.clone();
    let second = submit_on(
        &mut runtime.catalog().lock().unwrap(),
        "sibling",
        "other",
        "second",
    );
    host.send(
        json!({"kind":"fixture-resource-prepare","runId":second.run_id,"threadId":"sibling"}),
    );
    let p = prepared(&mut host, &runtime, &bridge, &outgoing);
    let calls = vec![
        subscribe(&p, "watch-shared", "fixture://watched"),
        subscribe(&p, "watch-other", "fixture://other"),
    ];
    let views = run(&mut host, &runtime, &bridge, &outgoing, &second, &p, calls);
    let shared_id = operation(&views, "watch-shared");
    let other_id = operation(&views, "watch-other");
    assert_eq!(
        trace(&root)
            .iter()
            .filter(|q| q["method"] == "resources/subscribe"
                && q["params"]["uri"] == "fixture://watched")
            .count(),
        1,
        "actual same-client URI registration is shared across Threads"
    );
    runtime.cancel_operation(&shared_id).unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&shared_id)
            .unwrap()
            .mcp_resource_subscription
            .unwrap()
            .remote_cleanup
            == varin_runtime::McpResourceCleanup::Shared
    });
    assert!(!trace(&root).iter().any(
        |q| q["method"] == "resources/unsubscribe" && q["params"]["uri"] == "fixture://watched"
    ));
    let old = runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(&first_id)
        .unwrap()
        .mcp_resource_subscription
        .unwrap()
        .last_event_cursor;
    let head = runtime.catalog().lock().unwrap().head("main").unwrap();
    control(
        &root,
        json!({"kind":"update","key":"idle","params":{"uri":"fixture://watched","_meta":{"original":"idle-update"},"opaque":{"nullable":null,"empty":[]}}}),
    );
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&first_id)
            .unwrap()
            .mcp_resource_subscription
            .unwrap()
            .last_event_cursor
            > old
    });
    assert_eq!(
        runtime.catalog().lock().unwrap().head("main").unwrap(),
        head,
        "passive observation does not append to idle history"
    );
    assert_eq!(
        runtime
            .catalog()
            .lock()
            .unwrap()
            .run(&first.run_id)
            .unwrap()
            .state,
        RunState::Completed
    );
    std::fs::write(root.join("deny-unsubscribe"), "receiver rejects cleanup").unwrap();
    runtime.cancel_operation(&other_id).unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&other_id)
            .unwrap()
            .mcp_resource_subscription
            .unwrap()
            .remote_cleanup
            == varin_runtime::McpResourceCleanup::Unknown
    });
    let other = runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(&other_id)
        .unwrap();
    assert!(other.mcp_resource_subscription.unwrap().local_released);
    assert_eq!(
        other.outcome,
        Some(Outcome::Succeeded),
        "observer cleanup cannot rewrite the original finite RPC"
    );
    std::fs::remove_file(root.join("deny-unsubscribe")).unwrap();
    let collection = runtime
        .catalog()
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    finish(&mut host, &runtime, &bridge, &outgoing);
    drop(host);
    drop(runtime);

    let mut db = Catalog::open(&path).unwrap();
    assert_eq!(
        db.operation(&first_id).unwrap().call_completion,
        original_completion
    );
    assert_eq!(
        db.operation(&first_id).unwrap().external_receipt,
        original_receipt
    );
    let next = submit_on(&mut db, "thread", "main", "read-after-reopen");
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","resources":true,"epoch":EPOCH,"root":root,"runId":next.run_id}));
    let p = prepared(&mut host, &runtime, &bridge, &outgoing);
    host.until(&runtime, &bridge, &outgoing, || {
        let op = runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&first_id)
            .unwrap();
        let sub = op.mcp_resource_subscription.unwrap();
        sub.listener_id
            != original
                .mcp_resource_subscription
                .as_ref()
                .unwrap()
                .listener_id
            && sub.availability == varin_runtime::McpResourceAvailability::Active
    });
    let views = run(&mut host, &runtime, &bridge, &outgoing, &next, &p, vec![]);
    let facts: Vec<Value> = views
        .last()
        .unwrap()
        .history
        .iter()
        .filter_map(|item| match (&item.provenance, &item.content) {
            (Provenance::EnvironmentFact { .. }, Content::Text { text }) => {
                serde_json::from_str(text).ok()
            }
            _ => None,
        })
        .collect();
    assert!(
        facts
            .iter()
            .any(|f| f["notification"]["_meta"]["original"] == "before-subscribe-ack"),
        "actual pre-ACK notification must survive acceptance"
    );
    let idle = facts
        .iter()
        .find(|f| f["notification"]["_meta"]["original"] == "idle-update")
        .expect("passive original update reaches next authorized Run");
    assert_eq!(
        idle["notification"]["opaque"],
        json!({"nullable":null,"empty":[]})
    );
    assert!(
        facts
            .iter()
            .any(|f| f["kind"] == "mcp_resource_observation_gap"),
        "reconnect explicitly preserves missed-notification uncertainty"
    );
    assert!(
        facts
            .iter()
            .any(|f| f["kind"] == "mcp_resource_association_unresolved"),
        "nonexact same-client notifications preserve only association uncertainty"
    );
    assert!(
        !facts
            .iter()
            .any(|f| f["notification"]["uri"] == "fixture://other"),
        "other subscription URI/body is not fanned into this observer"
    );
    assert_eq!(
        trace(&root)
            .iter()
            .filter(|q| q["method"] == "resources/subscribe"
                && q["params"]["uri"] == "fixture://watched")
            .count(),
        2,
        "restart establishes one new interval for only the remaining accepted holder"
    );
    assert!(
        !trace(&root).iter().any(|q| q["method"] == "resources/read"),
        "notification never grants an automatic resource read"
    );
    let final_run = submit_on(
        &mut runtime.catalog().lock().unwrap(),
        "thread",
        "main",
        "unsubscribe-original",
    );
    let stale = {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        let observer = db
            .operation(&first_id)
            .unwrap()
            .mcp_resource_subscription
            .unwrap();
        db.prepare_mcp_resource_fact(
            observer.binding,
            observer.listener_id.unwrap(),
            "received-before-withdrawal".into(),
            varin_runtime::McpResourceFactKind::Updated,
            Some(json!({"uri":"fixture://watched","body":"原始通知".repeat(32768)})),
        )
        .unwrap()
    }
    .load()
    .unwrap();
    let collection = runtime
        .catalog()
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    let collection = collection.run();
    assert_eq!(
        collection.status,
        varin_runtime::ContentCollectionStatus::Deferred
    );
    assert_eq!(
        collection.reason.as_deref(),
        Some("publication_active"),
        "the existing publication lease protects the staged notification before commit"
    );
    host.send(json!({"kind":"fixture-resource-prepare","runId":final_run.run_id}));
    let p = prepared(&mut host, &runtime, &bridge, &outgoing);
    let live = live_mcp_binding(serde_json::from_value(p["live"].clone()).unwrap()).unwrap();
    let name = live
        .binding
        .routes
        .iter()
        .find_map(|(name, route)| {
            matches!(route, varin_runtime::McpRoute::ResourceUnsubscribe { .. })
                .then(|| name.clone())
        })
        .unwrap();
    let stopped = run(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &final_run,
        &p,
        vec![(
            "stop-original".into(),
            name,
            json!({"operationId":first_id}),
        )],
    );
    let acknowledgement = stopped
        .last()
        .unwrap()
        .history
        .iter()
        .find_map(|item| match &item.content {
            Content::ToolResult { result } if result.call_id == "stop-original" => {
                match &result.completion {
                    ToolCompletion::Result {
                        content,
                        outcome: Outcome::Succeeded,
                        ..
                    } => Some(&content.data),
                    _ => None,
                }
            }
            _ => None,
        })
        .expect("original unsubscribe result");
    assert_eq!(
        acknowledgement["acknowledgement"]["_meta"]["original"],
        "resource-unsubscribe"
    );
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&first_id)
            .unwrap()
            .mcp_resource_subscription
            .unwrap()
            .remote_cleanup
            == varin_runtime::McpResourceCleanup::Acknowledged
    });
    let op = runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(&first_id)
        .unwrap();
    assert_eq!(op.call_completion, original_completion);
    assert_eq!(op.external_receipt, original_receipt);
    assert!(op.cancel_requested && op.mcp_resource_subscription.unwrap().local_released);
    assert!(
        runtime
            .catalog()
            .lock()
            .unwrap()
            .admit_mcp_resource_fact(stale)
            .is_err(),
        "body staged before local withdrawal cannot cross the original admission fence"
    );
    finish(&mut host, &runtime, &bridge, &outgoing);
}

struct Policy {
    call: ToolCall,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "resource-consumer".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        if state.is_null()
            && matches!(
                event,
                PolicyEvent::ModelCompleted {
                    reason: FinishReason::Stop,
                    ..
                }
            )
        {
            return Ok(PolicyDecision {
                action: PolicyAction::ToolGraph {
                    nodes: vec![PolicyToolNode {
                        id: self.call.call_id.clone(),
                        depends_on: vec![],
                        call: self.call.clone(),
                    }],
                },
                state: json!({"observed":true}),
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            assert_eq!(receipts.len(), 1);
            assert!(matches!(
                &receipts[0].completion,
                PolicyNodeCompletion::Result {
                    outcome: Outcome::Succeeded,
                    ..
                }
            ));
            return Ok(PolicyDecision {
                action: PolicyAction::RequestModel,
                state: state.clone(),
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}

#[test]
#[ignore = "requires workspace Node/tsx and built pi-host; real MCP stdio, no product socket"]
fn policy_resource_subscription_delivers_environment_without_model_tool_pairs() {
    let root = std::env::temp_dir().join(format!("varin-resource-policy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("thread", "main").unwrap();
    let submitted = submit(&mut db, "policy");
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","resources":true,"epoch":EPOCH,"root":root,"runId":submitted.run_id}));
    let p = prepared(&mut host, &runtime, &bridge, &outgoing);
    let (_, name, args) = subscribe(&p, "policy-resource", "fixture://policy");
    let live = live_mcp_binding(serde_json::from_value(p["live"].clone()).unwrap()).unwrap();
    let schema = live.binding.tools.iter().find(|s| s.name == name).unwrap();
    let policy = Arc::new(Policy {
        call: ToolCall {
            call_id: "policy-resource".into(),
            name,
            schema_version: schema.version.clone(),
            arguments: args,
        },
    });
    let views = run_with_policy(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &submitted,
        &p,
        vec![],
        policy,
    );
    let pending = runtime
        .catalog()
        .lock()
        .unwrap()
        .pending_mcp_resources()
        .unwrap();
    assert_eq!(pending.len(), 1);
    let read = {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        db.capture_operation_read(db.operation(&pending[0].operation_id).unwrap())
    }
    .load()
    .unwrap();
    assert_eq!(read.intent["origin"]["kind"], "policy_action");
    assert!(
        !views
            .last()
            .unwrap()
            .history
            .iter()
            .any(|i| matches!(&i.content, Content::ToolResult { .. })),
        "policy result is not a provider tool exchange"
    );
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&pending[0].operation_id)
            .unwrap()
            .mcp_resource_subscription
            .unwrap()
            .last_event_cursor
            .is_some()
    });
    let next = submit(
        &mut runtime.catalog().lock().unwrap(),
        "consume-policy-observation",
    );
    host.send(json!({"kind":"fixture-resource-prepare","runId":next.run_id}));
    let prepared = prepared(&mut host, &runtime, &bridge, &outgoing);
    let views = run(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &next,
        &prepared,
        vec![],
    );
    assert!(
        views
            .last()
            .unwrap()
            .history
            .iter()
            .any(|i| matches!(&i.provenance, Provenance::EnvironmentFact { .. })),
        "next authorized model consumes original policy resource notification"
    );
    runtime.cancel_operation(&pending[0].operation_id).unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&pending[0].operation_id)
            .unwrap()
            .mcp_resource_subscription
            .unwrap()
            .local_released
    });
    finish(&mut host, &runtime, &bridge, &outgoing);
}

#[test]
#[ignore = "requires Node/tsx and built MCP/extension packages; actual stdio, no product socket"]
fn source_less_child_installed_nested_resource_observers_keep_their_real_origins() {
    let root =
        std::env::temp_dir().join(format!("varin-resource-consumers-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","resources":true,"consumer":true,"epoch":EPOCH,"root":root}));
    let initial = host.frames.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(initial["kind"], "fixture-prepared", "{initial}");
    let mcp = mcp_binding(serde_json::from_value(initial["mcpBinding"].clone()).unwrap()).unwrap();
    let extension =
        extension_binding(serde_json::from_value(initial["extensionBinding"].clone()).unwrap())
            .unwrap();
    let name = mcp
        .routes
        .iter()
        .find_map(|(name, route)| {
            matches!(route, varin_runtime::McpRoute::ResourceSubscribe { .. }).then(|| name.clone())
        })
        .unwrap();
    let task = mcp.tools.iter().find(|t| t.name == name).unwrap().clone();
    let outer = extension.tool.clone();
    let super::mcp_consumer_fixture::PreparedChild {
        runtime,
        bridge,
        outgoing,
        mut binding,
        executor,
        child,
        tools,
        catalog_root,
    } = super::mcp_consumer_fixture::prepare_child(
        &mut host,
        mcp,
        extension,
        task.clone(),
        vec![name.clone(), outer.name.clone()],
    );
    let run_id = runtime
        .catalog()
        .lock()
        .unwrap()
        .delegated_execution(&child.execution_id)
        .unwrap()
        .receipt
        .unwrap()
        .run_id;
    let args =
        |uri: &str| json!({"server":"original","schemaVersion":initial["schemaVersion"],"uri":uri});
    let policy: Arc<dyn AgentPolicy> = Arc::new(DefaultAgentPolicy);
    binding.history_range.leaf_id = runtime
        .catalog()
        .lock()
        .unwrap()
        .head(&child.child_branch_id)
        .unwrap();
    let views = Arc::new(Mutex::new(Vec::new()));
    let execution=runtime.start(&run_id,RunStart{binding,policy_state:Value::Null,
        provider:Arc::new(Model{calls:vec![("direct-resource".into(),name.clone(),args("fixture://child-direct")),
            ("outer-resource".into(),outer.name,json!({"callId":"nested-resource","name":name,"arguments":args("fixture://child-nested")}))],views:views.clone()}),
        tools:executor,policy,context_preparation:Arc::new(crate::child_capabilities::BindingPreparation{inner:Arc::new(NoopContextPreparation),catalog:runtime.catalog()}),progress:ProgressSink::default()}).unwrap();
    let (tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(execution.wait());
    });
    let mut report = None;
    host.until(&runtime, &bridge, &outgoing, || {
        report = done.try_recv().ok();
        report.is_some()
    });
    let report = report.unwrap().unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let snapshots = views.lock().unwrap().clone();
    let view = snapshots.last().unwrap();
    let direct_id = operation(&snapshots, "direct-resource");
    let nested_id = view
        .history
        .iter()
        .find_map(|i| match &i.content {
            Content::ToolResult { result } if result.call_id == "outer-resource" => {
                match &result.completion {
                    ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        content,
                        ..
                    } => {
                        assert_eq!(content.data["completion"]["kind"], "result");
                        content.data["operationId"].as_str().map(str::to_owned)
                    }
                    _ => panic!("original installed nested receipt: {result:?}"),
                }
            }
            _ => None,
        })
        .unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .pending_mcp_resources()
            .unwrap()
            .iter()
            .filter(|p| p.run_id == run_id && p.subscription.last_event_cursor.is_some())
            .count()
            == 2
    });
    let pending = runtime
        .catalog()
        .lock()
        .unwrap()
        .pending_mcp_resources()
        .unwrap();
    assert_eq!(pending.len(), 2);
    let mut kinds = Vec::new();
    for p in &pending {
        assert_eq!(p.run_id, run_id);
        assert_eq!(
            p.subscription.source_scope,
            varin_runtime::catalog::launches::McpExecutionScope::Global
        );
        let read = {
            let owner = runtime.catalog();
            let db = owner.lock().unwrap();
            db.capture_operation_read(db.operation(&p.operation_id).unwrap())
        }
        .load()
        .unwrap();
        kinds.push(read.intent["origin"]["kind"].as_str().unwrap().to_string());
        assert_eq!(read.outcome, Some(Outcome::Succeeded));
    }
    kinds.sort();
    assert_eq!(kinds, vec!["model_step", "nested_call"]);
    assert!(
        pending.iter().any(|p| p.operation_id == direct_id)
            && pending.iter().any(|p| p.operation_id == nested_id)
    );
    assert_eq!(
        view.history
            .iter()
            .filter(|i| matches!(&i.content, Content::ToolResult { .. }))
            .count(),
        2,
        "nested/policy calls do not fabricate provider exchange pairs"
    );
    assert!(
        view.history
            .iter()
            .any(|i| matches!(&i.provenance, Provenance::EnvironmentFact { .. })),
        "actual child model consumes original passive facts"
    );
    runtime
        .catalog()
        .lock()
        .unwrap()
        .cancel_tree(varin_runtime::catalog::dispatch::TreeCancelTarget::Thread {
            thread_id: child.child_thread_id.clone(),
        })
        .unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        pending.iter().all(|p| {
            let op = runtime
                .catalog()
                .lock()
                .unwrap()
                .operation(&p.operation_id)
                .unwrap();
            op.cancel_requested && op.mcp_resource_subscription.unwrap().local_released
        })
    });
    assert!(!trace(&root).iter().any(|q| q["method"] == "resources/read"));
    finish(&mut host, &runtime, &bridge, &outgoing);
    drop(host);
    drop(tools);
    drop(runtime);
    // Test evidence remains until the lead archives the phase; no user files are involved.
    assert!(catalog_root.exists());
}

#[test]
#[ignore = "requires workspace Node/tsx and built pi-host; real MCP stdio, no product socket"]
fn acknowledged_resource_rpc_releases_dispatch_while_original_local_acceptance_recovers() {
    let root = std::env::temp_dir().join(format!(
        "varin-resource-acceptance-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("thread", "main").unwrap();
    let first = submit_on(&mut db, "thread", "main", "first");
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.hold_acceptance = true;
    host.send(json!({"kind":"fixture-initialize","resources":true,"epoch":EPOCH,"root":root,"runId":first.run_id}));
    let p = prepared(&mut host, &runtime, &bridge, &outgoing);
    let calls = vec![subscribe(&p, "watch-late", "fixture://watched")];
    let (report, _) = execute_with_policy(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &first,
        &p,
        calls,
        Arc::new(DefaultAgentPolicy),
    );
    assert_eq!(
        report.state,
        RunState::Failed,
        "Default policy keeps its original Unknown boundary"
    );
    assert!(host.interrupted_acceptance);
    let result = report
        .history
        .iter()
        .find_map(|item| match &item.content {
            Content::ToolResult { result } if result.call_id == "watch-late" => {
                Some(result.clone())
            }
            _ => None,
        })
        .unwrap();
    assert!(matches!(
        result.completion,
        ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            ..
        }
    ));
    let id = ToolOrigin::ModelStep {
        request_id: result.request_id.clone(),
    }
    .operation_id("watch-late");
    let original = runtime.catalog().lock().unwrap().operation(&id).unwrap();
    assert!(
        original.external_receipt.as_ref().unwrap().executor_stopped,
        "Actual subscribe ACK proves finite RPC stopped even before local acceptance publication succeeds"
    );
    assert!(
        original
            .mcp_resource_subscription
            .as_ref()
            .unwrap()
            .acceptance_ref
            .is_none()
    );
    let before = runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_history_page("main")
        .unwrap()
        .load(None, None, 100, &|| false)
        .unwrap();
    // Recover only the original local publication port. No ready/event injection or remote replay.
    host.hold_acceptance = false;
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&id)
            .unwrap()
            .mcp_resource_subscription
            .as_ref()
            .unwrap()
            .acceptance_ref
            .is_some()
    });
    let after = runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_history_page("main")
        .unwrap()
        .load(None, None, 100, &|| false)
        .unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    let recovered = runtime.catalog().lock().unwrap().operation(&id).unwrap();
    assert_eq!(recovered.call_completion, original.call_completion);
    assert_eq!(recovered.external_receipt, original.external_receipt);
    assert_eq!(
        trace(&root)
            .iter()
            .filter(|q| q["method"] == "resources/subscribe"
                && q["params"]["uri"] == "fixture://watched")
            .count(),
        1
    );
    // A later explicit input can acquire the original server resource; no stale RPC occupancy remains.
    let second = submit_on(
        &mut runtime.catalog().lock().unwrap(),
        "thread",
        "main",
        "next-authorized-input",
    );
    host.send(json!({"kind":"fixture-resource-prepare","runId":second.run_id,"threadId":"thread"}));
    let p = prepared(&mut host, &runtime, &bridge, &outgoing);
    let calls = vec![subscribe(&p, "watch-after-recovery", "fixture://other")];
    let views = run(&mut host, &runtime, &bridge, &outgoing, &second, &p, calls);
    let second_id = operation(&views, "watch-after-recovery");
    assert_ne!(second_id, id);
    runtime.cancel_operation(&id).unwrap();
    runtime.cancel_operation(&second_id).unwrap();
    finish(&mut host, &runtime, &bridge, &outgoing);
}
