//! Original Engine/Host/installed MCP/public user-response chain, without product sockets.
use super::mcp_review_fixture::*;
use super::*;
use crate::host_tools::ToolBridge;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};

struct Model {
    name: String,
    scenarios: Vec<String>,
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
        let completed = request
            .view
            .history
            .iter()
            .filter(|item| matches!(item.content, Content::ToolResult { .. }))
            .count();
        let content = if let Some(scenario) = self.scenarios.get(completed) {
            let schema = request
                .view
                .binding
                .tools
                .iter()
                .find(|tool| tool.name == self.name)
                .unwrap();
            Content::ToolCall {
                call: ToolCall {
                    call_id: format!("call:{scenario}"),
                    name: self.name.clone(),
                    schema_version: schema.version.clone(),
                    arguments: json!({"scenario":scenario}),
                },
            }
        } else {
            Content::Text {
                text: "Original interaction result observed".into(),
            }
        };
        let stop = matches!(content, Content::Text { .. });
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: format!("{}:item", request.view.request_id),
                opaque: None,
                content,
            },
        })
        .unwrap();
        Ok(if stop {
            FinishReason::Stop
        } else {
            FinishReason::ToolCalls
        })
    }
}
fn receive(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
    kind: &str,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            Instant::now() < deadline,
            "original interaction frame {kind} stalled"
        );
        if let Some(frame) = host.pump(runtime, bridge, outgoing) {
            assert_eq!(frame["kind"], kind, "{frame}");
            return frame;
        }
    }
}
fn consumer(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
    mut request: Value,
) -> Value {
    request["kind"] = json!("fixture-interaction-consumer");
    if request.get("threadId").is_none() {
        request["threadId"] = json!("thread:interaction");
    }
    if request.get("branchId").is_none() {
        request["branchId"] = json!("branch:interaction");
    }
    host.send(request);
    let frame = receive(
        host,
        runtime,
        bridge,
        outgoing,
        "fixture-interaction-consumer-result",
    );
    assert_eq!(frame["ok"], true, "public consumer failed: {frame}");
    frame["result"].clone()
}
fn next_question(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            Instant::now() < deadline,
            "original public pending interaction did not arrive"
        );
        let page = consumer(host, runtime, bridge, outgoing, json!({"action":"list"}));
        if let Some(view) = page["items"].as_array().unwrap().iter().find(|view| {
            view["record"]["choice"].is_null() && view["record"]["availability"] == "live"
        }) {
            return view.clone();
        }
    }
}
fn read(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
    view: &Value,
) -> Value {
    consumer(
        host,
        runtime,
        bridge,
        outgoing,
        json!({"action":"read","operationId":view["record"]["binding"]["operationId"],"interactionId":view["record"]["id"]}),
    )
}
fn respond(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
    view: &Value,
    response: Value,
) -> Value {
    consumer(
        host,
        runtime,
        bridge,
        outgoing,
        json!({"action":"respond","operationId":view["record"]["binding"]["operationId"],
        "interactionId":view["record"]["id"],"expectedRevision":view["record"]["revision"],"response":response}),
    )
}

struct InteractionPolicy {
    call: ToolCall,
}
impl AgentPolicy for InteractionPolicy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "interaction-consumer".into(),
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
                state: json!({"asked":true}),
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            assert_eq!(receipts.len(), 1);
            assert!(matches!(
                receipts[0].completion,
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
#[ignore = "requires workspace Node/tsx and built Host dependencies; actual installed HTTP transport, in-memory fetch only"]
fn original_http_elicitation_uses_public_user_responses_and_preserves_original_results() {
    let root =
        std::env::temp_dir().join(format!("varin-mcp-interactions-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("thread:interaction", "branch:interaction")
        .unwrap();
    let prepared = db
        .prepare_submission(
            SubmitInput {
                key: "original".into(),
                thread_id: "thread:interaction".into(),
                branch_id: "branch:interaction".into(),
                expected_head: None,
                input: json!({"text":"Use the original interactive receiver"}),
                configuration: model_configuration(),
            },
            None,
            None,
        )
        .unwrap();
    let receipt = db
        .admit_submission(prepared.load(None, false).unwrap())
        .unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","interactions":"http","epoch":EPOCH,"root":root,"runId":receipt.run_id,"threadId":"thread:interaction"}));
    let prepared = receive(&mut host, &runtime, &bridge, &outgoing, "fixture-prepared");
    let live = live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
    let tool = live
        .binding
        .tools
        .iter()
        .find(|t| t.name == prepared["names"]["ordinary"].as_str().unwrap())
        .unwrap();
    let policy: Arc<dyn AgentPolicy> = Arc::new(InteractionPolicy {
        call: ToolCall {
            call_id: "policy-form".into(),
            name: tool.name.clone(),
            schema_version: tool.version.clone(),
            arguments: json!({"scenario":"policy-form"}),
        },
    });
    let mut binding = request_binding(&live, &receipt);
    binding.history_range.branch_id = "branch:interaction".into();
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
                    name: prepared["names"]["ordinary"].as_str().unwrap().into(),
                    scenarios: vec!["form".into(), "url".into()],
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

    let form = next_question(&mut host, &runtime, &bridge, &outgoing);
    assert_eq!(form["presentation"]["mode"], "form");
    assert_eq!(
        form["record"]["binding"]["source"]["relation"]["kind"],
        "rpc_response_stream"
    );
    assert_eq!(form["record"]["runId"], receipt.run_id);
    let answer = json!({"action":"accept","content":{"enabled":false,"count":0,"note":"","tags":["one","two"]}});
    respond(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &form,
        answer.clone(),
    );
    let url = next_question(&mut host, &runtime, &bridge, &outgoing);
    assert_eq!(url["presentation"]["mode"], "url");
    assert_eq!(url["record"]["completionReported"], false);
    respond(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &url,
        json!({"action":"accept"}),
    );
    let policy_form = next_question(&mut host, &runtime, &bridge, &outgoing);
    let policy_id = policy_form["record"]["binding"]["operationId"]
        .as_str()
        .unwrap();
    let policy_op = {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        db.capture_operation_read(db.operation(policy_id).unwrap())
    }
    .load()
    .unwrap();
    assert_eq!(policy_op.intent["origin"]["kind"], "policy_action");
    respond(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &policy_form,
        answer.clone(),
    );
    let mut report = None;
    host.until(&runtime, &bridge, &outgoing, || {
        report = done.try_recv().ok();
        report.is_some()
    });
    assert_eq!(report.unwrap().unwrap().state, RunState::Completed);
    let url_after = read(&mut host, &runtime, &bridge, &outgoing, &url);
    assert_eq!(url_after["record"]["choice"], "accept");
    assert_eq!(url_after["record"]["completionReported"], false);
    host.send(json!({"kind":"fixture-interaction-complete","elicitationId":url["presentation"]["elicitationId"]}));
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            Instant::now() < deadline,
            "late original URL completion not recorded"
        );
        if read(&mut host, &runtime, &bridge, &outgoing, &url)["record"]["completionReported"]
            == true
        {
            break;
        }
    }
    let final_form = read(&mut host, &runtime, &bridge, &outgoing, &form);
    assert_eq!(final_form["response"], answer);
    assert_eq!(final_form["record"]["delivery"], "sent");
    // A repeated public submission returns the same choice without another protocol response.
    respond(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        &form,
        answer.clone(),
    );
    let views = views.lock().unwrap().clone();
    let results: Vec<_> = views
        .last()
        .unwrap()
        .history
        .iter()
        .filter_map(|item| match &item.content {
            Content::ToolResult { result } => Some(result),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 2);
    for result in results {
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
    }
    let history = runtime
        .catalog()
        .lock()
        .unwrap()
        .history("branch:interaction")
        .unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|item| item.source == varin_runtime::HistorySource::User)
            .count(),
        1,
        "remote questions/answers must not become main user input"
    );
    let original_requests =
        [&form, &url, &policy_form].map(|item| read(&mut host, &runtime, &bridge, &outgoing, item));
    tools.release(&receipt.run_id);
    host.send(
        json!({"v":1,"kind":"host-tool-owner-release","kernelEpoch":EPOCH,"runId":receipt.run_id}),
    );
    host.send(json!({"kind":"fixture-finish"}));
    let final_state = receive(&mut host, &runtime, &bridge, &outgoing, "fixture-finished");
    let responses: Vec<_> = final_state["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|q| q.get("method").is_none() && q.get("id").is_some())
        .collect();
    assert_eq!(responses.len(), 3, "one wire answer per original request");
    assert_eq!(responses[0]["result"]["content"], answer["content"]);
    let collection = runtime
        .catalog()
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    drop(host);
    drop(tools);
    drop(runtime);
    let reopened = Catalog::open(root.join("catalog")).unwrap();
    for original in &original_requests {
        let prepared = reopened
            .capture_mcp_interaction(
                original["record"]["binding"]["operationId"]
                    .as_str()
                    .unwrap(),
                original["record"]["id"].as_str().unwrap(),
            )
            .unwrap();
        let saved = serde_json::to_value(prepared.load().unwrap()).unwrap();
        assert_eq!(saved["request"], original["request"]);
        assert_eq!(saved["record"]["delivery"], "sent");
        assert_eq!(
            saved["response"],
            if original["presentation"]["mode"] == "form" {
                answer.clone()
            } else {
                json!({"action":"accept"})
            }
        );
    }
}

#[test]
#[ignore = "requires workspace Node/tsx and built Host dependencies; actual MCP stdio, no product socket"]
fn original_stdio_task_interactions_survive_parent_completion_and_fence_task_cancellation() {
    let root = std::env::temp_dir().join(format!(
        "varin-mcp-task-interactions-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("thread:interaction", "branch:interaction")
        .unwrap();
    let prepared = db
        .prepare_submission(
            SubmitInput {
                key: "original".into(),
                thread_id: "thread:interaction".into(),
                branch_id: "branch:interaction".into(),
                expected_head: None,
                input: json!({"text":"Start the original interactive tasks"}),
                configuration: model_configuration(),
            },
            None,
            None,
        )
        .unwrap();
    let receipt = db
        .admit_submission(prepared.load(None, false).unwrap())
        .unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","interactions":"stdio","epoch":EPOCH,"root":root,"runId":receipt.run_id,"threadId":"thread:interaction"}));
    let prepared = receive(&mut host, &runtime, &bridge, &outgoing, "fixture-prepared");
    let live = live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
    let mut binding = request_binding(&live, &receipt);
    binding.history_range.branch_id = "branch:interaction".into();
    let mut launch = varin_runtime::catalog::launches::LaunchSelection::from_binding(
        &binding,
        DefaultAgentPolicy.identity(),
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
                    name: prepared["names"]["deferred"].as_str().unwrap().into(),
                    scenarios: vec!["task-form".into(), "cancel-form".into()],
                    views: views.clone(),
                }),
                tools: executor,
                policy: Arc::new(DefaultAgentPolicy),
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
    host.until(&runtime, &bridge, &outgoing, || {
        report = done.try_recv().ok();
        report.is_some()
    });
    assert_eq!(report.unwrap().unwrap().state, RunState::Completed);
    tools.release(&receipt.run_id);
    host.send(
        json!({"v":1,"kind":"host-tool-owner-release","kernelEpoch":EPOCH,"runId":receipt.run_id}),
    );
    // Accepted Thread Tasks keep their own original association after the invoking Run is gone.
    let deadline = Instant::now() + Duration::from_secs(30);
    let page = loop {
        assert!(
            Instant::now() < deadline,
            "both accepted Task questions must become public"
        );
        let page = consumer(
            &mut host,
            &runtime,
            &bridge,
            &outgoing,
            json!({"action":"list"}),
        );
        if page["items"].as_array().unwrap().len() == 2 {
            break page;
        }
    };
    let views = page["items"].as_array().unwrap();
    let completed = views
        .iter()
        .find(|v| v["record"]["binding"]["source"]["relation"]["taskId"] == "receiver:task-form")
        .unwrap();
    let cancelled = views
        .iter()
        .find(|v| v["record"]["binding"]["source"]["relation"]["taskId"] == "receiver:cancel-form")
        .unwrap();
    for view in views {
        assert_eq!(
            view["record"]["binding"]["source"]["relation"]["kind"],
            "task"
        );
        assert_eq!(view["record"]["runId"], receipt.run_id);
    }
    let id = completed["record"]["binding"]["operationId"]
        .as_str()
        .unwrap();
    let original = runtime.catalog().lock().unwrap().operation(id).unwrap();
    assert!(matches!(
        original.call_completion,
        Some(varin_runtime::catalog::result_content::ToolCompletionMetadata::JobAccepted { .. })
    ));
    let answer =
        json!({"action":"accept","content":{"enabled":false,"count":0,"note":"","tags":["two"]}});
    respond(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        completed,
        answer.clone(),
    );
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(id)
            .unwrap()
            .host_job
            .as_ref()
            .unwrap()
            .mcp_task
            .as_ref()
            .unwrap()
            .result_ready
    });
    let after = runtime.catalog().lock().unwrap().operation(id).unwrap();
    assert_eq!(
        after.call_completion, original.call_completion,
        "Task interaction must not rewrite original JobAccepted"
    );
    assert_eq!(
        runtime
            .catalog()
            .lock()
            .unwrap()
            .run(&receipt.run_id)
            .unwrap()
            .state,
        RunState::Completed
    );
    let stopped_id = cancelled["record"]["binding"]["operationId"]
        .as_str()
        .unwrap();
    runtime.cancel_operation(stopped_id).unwrap();
    host.send(json!({"kind":"fixture-interaction-consumer","action":"respond","threadId":"thread:interaction","branchId":"branch:interaction",
        "operationId":stopped_id,"interactionId":cancelled["record"]["id"],"expectedRevision":cancelled["record"]["revision"],"response":answer}));
    let rejected = receive(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        "fixture-interaction-consumer-result",
    );
    assert_eq!(
        rejected["ok"], false,
        "cancelled original Task must reject its late human response"
    );
    let closed = read(&mut host, &runtime, &bridge, &outgoing, cancelled);
    assert_ne!(closed["record"]["availability"], "live");
    assert!(closed["record"]["choice"].is_null());
    host.send(json!({"kind":"fixture-finish"}));
    let finished = receive(&mut host, &runtime, &bridge, &outgoing, "fixture-finished");
    let replies: Vec<_> = finished["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|q| q.get("method").is_none() && q["result"]["action"] == "accept")
        .collect();
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0]["result"]["_meta"]["io.modelcontextprotocol/related-task"]["taskId"],
        "receiver:task-form"
    );
}

struct NestedModel {
    name: String,
    outer: String,
    views: Arc<Mutex<Vec<RequestView>>>,
}
impl ModelProvider for NestedModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        self.views.lock().unwrap().push(view.clone());
        Ok(Value::Null)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let count = request
            .view
            .history
            .iter()
            .filter(|i| matches!(i.content, Content::ToolResult { .. }))
            .count();
        let content = if count < 2 {
            let name = if count == 0 { &self.name } else { &self.outer };
            let schema = request
                .view
                .binding
                .tools
                .iter()
                .find(|t| &t.name == name)
                .unwrap();
            Content::ToolCall {
                call: ToolCall {
                    call_id: if count == 0 {
                        "child-direct"
                    } else {
                        "child-outer"
                    }
                    .into(),
                    name: name.clone(),
                    schema_version: schema.version.clone(),
                    arguments: if count == 0 {
                        json!({"scenario":"child-form"})
                    } else {
                        json!({"callId":"nested-form","name":self.name,"arguments":{"scenario":"nested-form"}})
                    },
                },
            }
        } else {
            Content::Text {
                text: "Original child and nested interactions completed".into(),
            }
        };
        let stop = matches!(content, Content::Text { .. });
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: format!("{}:item", request.view.request_id),
                opaque: None,
                content,
            },
        })
        .unwrap();
        Ok(if stop {
            FinishReason::Stop
        } else {
            FinishReason::ToolCalls
        })
    }
}
#[test]
#[ignore = "requires built Node/MCP/extension packages; original installed HTTP with in-memory fetch, no product socket"]
fn source_less_child_and_installed_nested_interactions_use_exact_public_thread_and_operation() {
    let root = std::env::temp_dir().join(format!(
        "varin-mcp-child-interactions-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","interactions":"http","consumer":true,"epoch":EPOCH,"root":root}));
    let initial = host.frames.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(initial["kind"], "fixture-prepared", "{initial}");
    let mcp = mcp_binding(serde_json::from_value(initial["mcpBinding"].clone()).unwrap()).unwrap();
    let extension =
        extension_binding(serde_json::from_value(initial["extensionBinding"].clone()).unwrap())
            .unwrap();
    let name = initial["names"]["ordinary"].as_str().unwrap().to_owned();
    let task = mcp.tools.iter().find(|t| t.name == name).unwrap().clone();
    let outer = extension.tool.name.clone();
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
        task,
        vec![name.clone(), outer.clone()],
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
    binding.history_range.leaf_id = runtime
        .catalog()
        .lock()
        .unwrap()
        .head(&child.child_branch_id)
        .unwrap();
    let views = Arc::new(Mutex::new(Vec::new()));
    let execution = runtime
        .start(
            &run_id,
            RunStart {
                binding,
                policy_state: Value::Null,
                provider: Arc::new(NestedModel {
                    name,
                    outer,
                    views: views.clone(),
                }),
                tools: executor,
                policy: Arc::new(DefaultAgentPolicy),
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
    let answer =
        json!({"action":"accept","content":{"enabled":false,"count":0,"note":"","tags":["one"]}});
    let mut ids = Vec::new();
    let mut origins = Vec::new();
    for _ in 0..2 {
        let deadline = Instant::now() + Duration::from_secs(30);
        let question = loop {
            assert!(
                Instant::now() < deadline,
                "child's original question absent"
            );
            let page = consumer(
                &mut host,
                &runtime,
                &bridge,
                &outgoing,
                json!({"action":"list","threadId":child.child_thread_id,"branchId":child.child_branch_id}),
            );
            if let Some(v) =
                page["items"].as_array().unwrap().iter().find(|v| {
                    v["record"]["choice"].is_null() && v["record"]["availability"] == "live"
                })
            {
                break v.clone();
            }
        };
        assert_eq!(question["record"]["runId"], run_id);
        assert_eq!(question["record"]["threadId"], child.child_thread_id);
        let id = question["record"]["binding"]["operationId"]
            .as_str()
            .unwrap()
            .to_owned();
        let op = {
            let owner = runtime.catalog();
            let db = owner.lock().unwrap();
            db.capture_operation_read(db.operation(&id).unwrap())
        }
        .load()
        .unwrap();
        origins.push(op.intent["origin"]["kind"].as_str().unwrap().to_owned());
        ids.push(id.clone());
        consumer(
            &mut host,
            &runtime,
            &bridge,
            &outgoing,
            json!({"action":"respond","threadId":child.child_thread_id,"branchId":child.child_branch_id,
            "operationId":id,"interactionId":question["record"]["id"],"expectedRevision":question["record"]["revision"],"response":answer}),
        );
    }
    assert_eq!(origins, vec!["model_step", "nested_call"]);
    assert_ne!(ids[0], ids[1]);
    let mut report = None;
    host.until(&runtime, &bridge, &outgoing, || {
        report = done.try_recv().ok();
        report.is_some()
    });
    let report = report.unwrap().unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let snapshots = views.lock().unwrap().clone();
    let results: Vec<_> = snapshots
        .last()
        .unwrap()
        .history
        .iter()
        .filter_map(|i| match &i.content {
            Content::ToolResult { result } => Some(result),
            _ => None,
        })
        .collect();
    assert_eq!(
        results.len(),
        2,
        "nested interactions cannot fabricate provider pairs"
    );
    for result in results {
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
    }
    let page = consumer(
        &mut host,
        &runtime,
        &bridge,
        &outgoing,
        json!({"action":"list","threadId":child.child_thread_id,"branchId":child.child_branch_id}),
    );
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    host.send(json!({"kind":"fixture-finish"}));
    let finished = receive(&mut host, &runtime, &bridge, &outgoing, "fixture-finished");
    assert_eq!(
        finished["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|q| q.get("method").is_none() && q["result"]["action"] == "accept")
            .count(),
        2
    );
    drop(host);
    drop(tools);
    drop(runtime);
    assert!(catalog_root.exists());
}

/// New error cards use the same actual execution and public consumer as server requests.
/// The peer controls only its external outcome; there is no substitute Catalog or Host API.
struct InteractionExecution {
    root: PathBuf,
    run_id: String,
    runtime: Arc<RunSupervisor>,
    bridge: ToolBridge,
    outgoing: mpsc::Receiver<Value>,
    host: Host,
    tools: Arc<crate::run_tools::RunTools>,
    execution: Option<varin_runtime::supervisor::RunHandle>,
}
impl InteractionExecution {
    fn new(mode: &str, tool: &str, scenario: &str) -> Self {
        Self::with_sampling(mode, tool, scenario, false)
    }
    fn with_sampling(mode: &str, tool: &str, scenario: &str, sampling: bool) -> Self {
        let root = std::env::temp_dir().join(format!("varin-mcp-error-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut db = Catalog::open(root.join("catalog")).unwrap();
        db.create_thread("thread:interaction", "branch:interaction")
            .unwrap();
        let input = db.prepare_submission(SubmitInput { key: "original".into(),
            thread_id: "thread:interaction".into(), branch_id: "branch:interaction".into(),
            expected_head: None, input: json!({"text":"Use the original receiver; retain errors without replay"}),
            configuration: model_configuration() }, None, None).unwrap();
        let receipt = db
            .admit_submission(input.load(None, false).unwrap())
            .unwrap();
        let runtime = Arc::new(RunSupervisor::new(db));
        let (tx, outgoing) = mpsc::sync_channel(64);
        let bridge = ToolBridge::new(tx.into());
        bridge.initialize(EPOCH);
        let mut host = Host::new();
        host.send(
            json!({"kind":"fixture-initialize","interactions":mode,"epoch":EPOCH,"root":root,
            "runId":receipt.run_id,"threadId":"thread:interaction","sampling":sampling}),
        );
        let prepared = receive(&mut host, &runtime, &bridge, &outgoing, "fixture-prepared");
        let live =
            live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
        let mut binding = request_binding(&live, &receipt);
        binding.history_range.branch_id = "branch:interaction".into();
        let mut launch = varin_runtime::catalog::launches::LaunchSelection::from_binding(
            &binding,
            DefaultAgentPolicy.identity(),
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
        let execution = runtime
            .start(
                &receipt.run_id,
                RunStart {
                    binding,
                    policy_state: Value::Null,
                    provider: Arc::new(Model {
                        name: prepared["names"][tool].as_str().unwrap().into(),
                        scenarios: vec![scenario.into()],
                        views: Arc::new(Mutex::new(Vec::new())),
                    }),
                    tools: executor,
                    policy: Arc::new(DefaultAgentPolicy),
                    context_preparation: Arc::new(crate::child_capabilities::BindingPreparation {
                        inner: Arc::new(NoopContextPreparation),
                        catalog: runtime.catalog(),
                    }),
                    progress: ProgressSink::default(),
                },
            )
            .unwrap();
        Self {
            root,
            run_id: receipt.run_id,
            runtime,
            bridge,
            outgoing,
            host,
            tools,
            execution: Some(execution),
        }
    }
    fn run_finished(&mut self) -> RunState {
        let mut result = None;
        let execution = self.execution.take().unwrap();
        self.host
            .until(&self.runtime, &self.bridge, &self.outgoing, || {
                result = execution.try_result().unwrap();
                result.is_some()
            });
        let state = result.unwrap().unwrap().state;
        self.tools.release(&self.run_id);
        self.host.send(
            json!({"v":1,"kind":"host-tool-owner-release","kernelEpoch":EPOCH,"runId":self.run_id}),
        );
        state
    }
    fn cards(&mut self) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(
                Instant::now() < deadline,
                "original error cards not published"
            );
            let page = consumer(
                &mut self.host,
                &self.runtime,
                &self.bridge,
                &self.outgoing,
                json!({"action":"list"}),
            );
            let items = page["items"].as_array().unwrap();
            if items.len() == 2 {
                assert!(
                    items.iter().all(|item| item.get("request").is_none()),
                    "paged cards must not duplicate the full RPC error"
                );
                return items.clone();
            }
        }
    }
    fn read(&mut self, card: &Value) -> Value {
        read(
            &mut self.host,
            &self.runtime,
            &self.bridge,
            &self.outgoing,
            card,
        )
    }
    fn choose(&mut self, card: &Value, action: &str) -> Value {
        respond(
            &mut self.host,
            &self.runtime,
            &self.bridge,
            &self.outgoing,
            card,
            json!({"action":action}),
        )
    }
    fn operation(&self, card: &Value) -> varin_runtime::Operation {
        let capture = {
            let owner = self.runtime.catalog();
            let db = owner.lock().unwrap();
            db.capture_operation_read(
                db.operation(card["record"]["binding"]["operationId"].as_str().unwrap())
                    .unwrap(),
            )
        };
        capture.load().unwrap()
    }
    fn finish(&mut self) -> Value {
        self.host.send(json!({"kind":"fixture-finish"}));
        receive(
            &mut self.host,
            &self.runtime,
            &self.bridge,
            &self.outgoing,
            "fixture-finished",
        )
    }
}

#[test]
#[ignore = "requires workspace Node/tsx; original MCP stdio/in-memory HTTP, no product socket"]
fn rpc_error_urls_reach_public_consumers_after_original_run_ends_without_protocol_answers() {
    for (mode, tool, scenario) in [
        ("http", "ordinary", "ordinary-error-early-complete"),
        ("stdio", "ordinary", "ordinary-error"),
        ("stdio", "deferred", "creation-error"),
    ] {
        let mut fixture = InteractionExecution::new(mode, tool, scenario);
        assert!(
            fixture.run_finished().terminal(),
            "finite failed call must settle before user review"
        );
        let cards = fixture.cards();
        let original = fixture.operation(&cards[0]);
        assert_eq!(original.effect, Effect::Unknown);
        assert!(
            original.external_receipt.as_ref().unwrap().executor_stopped,
            "actual finite JSON-RPC error ends only the RPC, not unknown remote effects"
        );
        assert!(
            original
                .host_job
                .as_ref()
                .is_none_or(|job| job.acceptance_ref.is_none()),
            "creation error must not invent JobAccepted"
        );
        let mut full = Vec::new();
        for (index, card) in cards.iter().enumerate() {
            let source = &card["record"]["binding"]["source"];
            assert_eq!(source["kind"], "rpc_error");
            assert_eq!(source["method"], "tools/call");
            assert!(source.get("requestId").is_none());
            assert!(card["record"]["delivery"].is_null());
            let view = fixture.read(card);
            assert_eq!(view["request"]["code"], -32042);
            let original_value = serde_json::to_value(&original).unwrap();
            assert_eq!(original_value["external_receipt"]["result"]["data"]["protocolError"], view["request"],
                "interaction evidence must not retain more of the original error than its actual effect receipt");
            assert_eq!(view["request"]["originalExtra"]["method"], "tools/call");
            assert_eq!(
                view["request"]["data"]["opaque"]["text"].as_str().unwrap(),
                "原始正文🙂".repeat(4096)
            );
            let chosen = fixture.choose(card, if index == 0 { "accept" } else { "decline" });
            assert!(
                chosen["record"]["delivery"].is_null(),
                "local choice cannot fabricate a protocol send"
            );
            fixture.choose(card, if index == 0 { "accept" } else { "decline" });
            full.push(chosen);
        }
        assert_eq!(
            full[0]["request"], full[1]["request"],
            "both URL selectors retain the same complete error"
        );
        if mode == "http" {
            assert_eq!(
                full.iter()
                    .filter(|v| v["record"]["completionReported"] == true)
                    .count(),
                1,
                "same-chunk completion must apply only to its exact elicitation"
            );
        }
        if mode == "http" {
            // Original cancellation can win before the Host processes its event. A late
            // completion command from that retained SDK callback must not cross the fence.
            let pending = full
                .iter()
                .find(|view| view["record"]["completionReported"] == false)
                .unwrap();
            fixture.runtime.cancel_operation(&original.id).unwrap();
            let binding = serde_json::from_value(pending["record"]["binding"].clone()).unwrap();
            let record = fixture
                .runtime
                .catalog()
                .lock()
                .unwrap()
                .complete_mcp_interaction(&binding, pending["record"]["id"].as_str().unwrap())
                .unwrap();
            assert!(
                !record.completion_reported,
                "cancelled association cannot report a new external completion"
            );
        }
        let after = fixture.operation(&cards[0]);
        assert_eq!(after.external_receipt, original.external_receipt);
        assert_eq!(after.call_completion, original.call_completion);
        let finished = fixture.finish();
        let requests = finished["requests"].as_array().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|q| q["method"] == "tools/call")
                .count(),
            1,
            "no automatic tool replay"
        );
        assert_eq!(
            requests
                .iter()
                .filter(|q| q.get("method").is_none() && q.get("id").is_some())
                .count(),
            0,
            "error responses have no JSON-RPC answer"
        );
        let pass = fixture
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default());
        assert_eq!(
            pass.run().status,
            varin_runtime::ContentCollectionStatus::Completed
        );
        let root = fixture.root.clone();
        drop(fixture);
        let reopened = Catalog::open(root.join("catalog")).unwrap();
        for view in full {
            let saved = serde_json::to_value(
                reopened
                    .capture_mcp_interaction(
                        view["record"]["binding"]["operationId"].as_str().unwrap(),
                        view["record"]["id"].as_str().unwrap(),
                    )
                    .unwrap()
                    .load()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(saved["request"], view["request"]);
            assert_eq!(saved["response"], view["response"]);
            assert!(saved["record"]["delivery"].is_null());
        }
    }
}

#[test]
#[ignore = "requires workspace Node/tsx; original MCP stdio/in-memory HTTP, no product socket"]
fn accepted_task_error_urls_keep_terminal_errors_and_do_not_promote_early_errors_to_results() {
    for (mode, scenario) in [("http", "premature-error"), ("stdio", "terminal-error")] {
        let mut fixture = InteractionExecution::new(mode, "deferred", scenario);
        assert_eq!(fixture.run_finished(), RunState::Completed);
        let cards = fixture.cards();
        let original = fixture.operation(&cards[0]);
        assert!(matches!(
            original.call_completion,
            Some(ToolCompletion::JobAccepted { .. })
        ));
        for card in &cards {
            assert_eq!(
                card["record"]["binding"]["source"]["method"],
                "tasks/result"
            );
            assert_eq!(
                card["record"]["binding"]["source"]["taskId"],
                format!("receiver:{scenario}")
            );
            fixture.choose(card, "accept");
        }
        if scenario == "premature-error" {
            let task = original
                .host_job
                .as_ref()
                .unwrap()
                .mcp_task
                .as_ref()
                .unwrap();
            assert!(
                !task.result_ready,
                "premature nonterminal error is not a future terminal result"
            );
            assert_eq!(
                task.task.status,
                varin_runtime::catalog::host_jobs::McpTaskStatus::InputRequired
            );
            fixture.host.send(json!({"kind":"fixture-interaction-complete","elicitationId":cards[0]["presentation"]["elicitationId"]}));
        }
        let operation_id = original.id.clone();
        let runtime = fixture.runtime.clone();
        fixture
            .host
            .until(&fixture.runtime, &fixture.bridge, &fixture.outgoing, || {
                runtime
                    .catalog()
                    .lock()
                    .unwrap()
                    .operation(&operation_id)
                    .unwrap()
                    .host_job
                    .as_ref()
                    .unwrap()
                    .mcp_task
                    .as_ref()
                    .unwrap()
                    .result_ready
            });
        let after = fixture.operation(&cards[0]);
        assert_eq!(
            after.call_completion, original.call_completion,
            "original model JobAccepted is immutable"
        );
        let task = after.host_job.as_ref().unwrap();
        let result = serde_json::to_value(task.mcp_task_result.as_ref().unwrap()).unwrap();
        if scenario == "premature-error" {
            assert_eq!(
                result["data"]["structuredContent"]["reviewedResponse"]["externalStep"], true,
                "fresh original Task result replaces no prior early error"
            );
        } else {
            assert_eq!(
                result["data"]["protocolError"],
                fixture.read(&cards[0])["request"],
                "actual terminal result must retain the same complete original error as its card"
            );
        }
        let finished = fixture.finish();
        let requests = finished["requests"].as_array().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|q| q["method"] == "tools/call")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|q| q.get("method").is_none() && q.get("id").is_some())
                .count(),
            0
        );
        assert_eq!(
            fixture
                .runtime
                .catalog()
                .lock()
                .unwrap()
                .run(&fixture.run_id)
                .unwrap()
                .state,
            RunState::Completed
        );
    }
}

#[test]
#[ignore = "requires workspace Node/tsx; original MCP HTTP transport with in-memory fetch"]
fn accepted_task_url_keeps_exact_completion_after_natural_task_retirement() {
    let mut fixture = InteractionExecution::new("http", "deferred", "task-url");
    assert_eq!(fixture.run_finished(), RunState::Completed);
    let card = next_question(
        &mut fixture.host,
        &fixture.runtime,
        &fixture.bridge,
        &fixture.outgoing,
    );
    assert_eq!(card["presentation"]["mode"], "url");
    assert_eq!(
        card["record"]["binding"]["source"]["relation"]["kind"],
        "task"
    );
    fixture.choose(&card, "accept");
    let operation_id = card["record"]["binding"]["operationId"]
        .as_str()
        .unwrap()
        .to_owned();
    let runtime = fixture.runtime.clone();
    fixture
        .host
        .until(&fixture.runtime, &fixture.bridge, &fixture.outgoing, || {
            runtime
                .catalog()
                .lock()
                .unwrap()
                .operation(&operation_id)
                .unwrap()
                .host_job
                .as_ref()
                .unwrap()
                .mcp_task
                .as_ref()
                .unwrap()
                .result_ready
        });
    let original = fixture.operation(&card);
    // This fixture command first awaits the actual Task coordinator's reconciliation,
    // including natural forget/unbind, and only then emits the peer notification.
    fixture.host.send(json!({"kind":"fixture-interaction-complete","ack":true,"elicitationId":card["presentation"]["elicitationId"]}));
    receive(
        &mut fixture.host,
        &fixture.runtime,
        &fixture.bridge,
        &fixture.outgoing,
        "fixture-interaction-completion-emitted",
    );
    let complete = fixture.read(&card);
    assert_eq!(complete["record"]["completionReported"], true,
        "normal Task retirement must not withdraw an already accepted URL's original completion identity: {complete}");
    assert_eq!(complete["record"]["delivery"], "sent");
    let after = fixture.operation(&card);
    assert_eq!(after.call_completion, original.call_completion);
    assert_eq!(after.external_receipt, original.external_receipt);
    fixture.finish();
}

#[path = "mcp_sampling_review.rs"]
mod sampling;
