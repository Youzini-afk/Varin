//! Real Engine/Catalog/Host/permission/stdio-MCP chain. Controlled receiver work, no product socket.
use super::mcp_review_fixture::*;
use super::*;
use crate::host_tools::ToolBridge;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};

struct Model {
    task: String,
    ordinary: String,
    inspect: Option<(String, String)>,
    wait: Option<String>,
    views: Arc<Mutex<Vec<RequestView>>>,
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        self.views.lock().unwrap().push(view.clone());
        Ok(json!({"request":view.request_id}).into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let results: Vec<_> = request
            .view
            .history
            .iter()
            .filter_map(|item| match &item.content {
                Content::ToolResult { result } => Some(result),
                _ => None,
            })
            .collect();
        let next = if let Some((name, target)) = &self.inspect {
            if let Some(wait) = self
                .wait
                .as_ref()
                .filter(|_| !results.iter().any(|r| r.call_id == "wait-original"))
            {
                Some(("wait-original", wait.clone(), json!({"operationId":target})))
            } else if results.iter().any(|r| r.call_id == "inspect-original") {
                None
            } else {
                Some((
                    "inspect-original",
                    name.clone(),
                    json!({"operationId":target}),
                ))
            }
        } else {
            match results.len() {
                0 => Some((
                    "complete",
                    self.task.clone(),
                    json!({"scenario":"complete"}),
                )),
                1 => {
                    assert!(matches!(
                        results[0].completion,
                        ToolCompletion::JobAccepted { .. }
                    ));
                    Some(("cancel", self.task.clone(), json!({"scenario":"cancel"})))
                }
                2 => {
                    assert!(matches!(
                        results[1].completion,
                        ToolCompletion::JobAccepted { .. }
                    ));
                    Some(("ordinary", self.ordinary.clone(), json!({})))
                }
                3 => None,
                count => panic!("unexpected model result count {count}"),
            }
        };
        if let Some((id, name, arguments)) = next {
            let schema = request
                .view
                .binding
                .tools
                .iter()
                .find(|s| s.name == name)
                .unwrap();
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: format!("{}:{id}", request.view.request_id),
                    opaque: None,
                    content: Content::ToolCall {
                        call: ToolCall {
                            call_id: id.into(),
                            name,
                            schema_version: schema.version.clone(),
                            arguments,
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
                        text: "Original remote task acceptance observed".into(),
                    },
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
}
struct Policy {
    task: ToolSchema,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "task-review".into(),
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
        if matches!(
            event,
            PolicyEvent::ModelCompleted {
                reason: FinishReason::Stop,
                ..
            }
        ) {
            return Ok(PolicyDecision {
                action: PolicyAction::ToolGraph {
                    nodes: vec![PolicyToolNode {
                        id: "policy-input".into(),
                        depends_on: vec![],
                        call: ToolCall {
                            call_id: "policy-input".into(),
                            name: self.task.name.clone(),
                            schema_version: self.task.version.clone(),
                            arguments: json!({"scenario":"input"}),
                        },
                    }],
                },
                state: state.clone(),
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            assert_eq!(receipts.len(), 1);
            assert!(matches!(
                receipts[0].completion,
                PolicyNodeCompletion::JobAccepted { .. }
            ));
            return Ok(PolicyDecision {
                action: PolicyAction::Complete,
                state: serde_json::to_value(receipts).unwrap(),
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}
#[test]
#[ignore = "requires workspace Node/tsx and built pi-host; original MCP stdio, no product socket"]
fn original_mcp_tasks_survive_run_completion_cancel_without_false_stop_and_reopen() {
    let root = std::env::temp_dir().join(format!("varin-mcp-tasks-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("catalog");
    let mut db = Catalog::open(&path).unwrap();
    db.create_thread("thread", "main").unwrap();
    let submitted = submit(&mut db, "first");
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.send(
        json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"runId":submitted.run_id}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let prepared = loop {
        assert!(Instant::now() < deadline);
        if let Some(frame) = host.pump(&runtime, &bridge, &outgoing) {
            assert_eq!(frame["kind"], "fixture-prepared");
            break frame;
        }
    };
    let live = live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
    let task = prepared["names"]["deferred"].as_str().unwrap().to_string();
    let ordinary = prepared["names"]["ordinary"].as_str().unwrap().to_string();
    let binding = request_binding(&live, &submitted);
    let policy: Arc<dyn AgentPolicy> = Arc::new(Policy {
        task: binding
            .tools
            .iter()
            .find(|s| s.name == task)
            .unwrap()
            .clone(),
    });
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
        .bind_launch(&submitted.run_id, launch)
        .unwrap();
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone());
    let prepared = tools
        .prepare_scope(&submitted.run_id, vec![], Some(live), vec![])
        .unwrap();
    let executor = tools.install(&submitted.run_id, 1, prepared).unwrap();
    let views = Arc::new(Mutex::new(Vec::new()));
    let execution = runtime
        .start(
            &submitted.run_id,
            RunStart {
                binding,
                policy_state: Value::Null,
                provider: Arc::new(Model {
                    task,
                    ordinary,
                    inspect: None,
                    wait: None,
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
    let (done_tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(execution.wait());
    });
    let mut report = None;
    host.until(&runtime, &bridge, &outgoing, || {
        report = done.try_recv().ok();
        report.is_some()
    });
    let report = report.unwrap().unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let final_view = views.lock().unwrap().last().unwrap().clone();
    let original = |id: &str| {
        final_view
            .history
            .iter()
            .find_map(|i| match &i.content {
                Content::ToolResult { result } if result.call_id == id => Some(result.clone()),
                _ => None,
            })
            .unwrap()
    };
    let complete = original("complete");
    let cancel = original("cancel");
    let operation_id = |result: &ToolResult| {
        ToolOrigin::ModelStep {
            request_id: result.request_id.clone(),
        }
        .operation_id(&result.call_id)
    };
    let complete_id = operation_id(&complete);
    let cancel_id = operation_id(&cancel);
    assert!(
        matches!(
            original("ordinary").completion,
            ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                ..
            }
        ),
        "verified task handoff frees the persistent and in-memory server dispatch slot"
    );
    tools.release(&submitted.run_id);
    host.send(json!({"v":1,"kind":"host-tool-owner-release","kernelEpoch":EPOCH,"runId":submitted.run_id}));
    let task_state = |id: &str| {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(id)
            .unwrap()
            .host_job
            .unwrap()
            .mcp_task
            .unwrap()
    };
    assert_eq!(
        task_state(&complete_id).task.status,
        varin_runtime::catalog::host_jobs::McpTaskStatus::Working
    );
    let original_cancel_completion = {
        let db = runtime.catalog();
        let db = db.lock().unwrap();
        db.capture_operation_read(db.operation(&cancel_id).unwrap())
    }
    .load()
    .unwrap()
    .call_completion;
    std::fs::write(root.join("hold-cancel-get"), "hold status response").unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        root.join("cancel-get-blocked").exists()
    });
    runtime.cancel_operation(&cancel_id).unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        root.join("cancel-received").exists()
    });
    assert!(
        root.join("hold-cancel-get").exists(),
        "cancel bypassed the original blocked status read"
    );
    std::fs::remove_file(root.join("hold-cancel-get")).unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        let op = runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&cancel_id)
            .unwrap();
        op.host_job
            .as_ref()
            .unwrap()
            .mcp_task
            .as_ref()
            .unwrap()
            .result_ready
            && op.external_receipt.is_some()
    });
    let cancelled = runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(&cancel_id)
        .unwrap();
    assert_eq!(cancelled.effect, Effect::Unknown);
    assert!(
        !cancelled
            .external_receipt
            .as_ref()
            .unwrap()
            .executor_stopped
    );
    assert_eq!(
        cancelled
            .host_job
            .as_ref()
            .unwrap()
            .mcp_task
            .as_ref()
            .unwrap()
            .task
            .status,
        varin_runtime::catalog::host_jobs::McpTaskStatus::Cancelled
    );
    assert_eq!(
        {
            runtime
                .catalog()
                .lock()
                .unwrap()
                .capture_operation_read(cancelled)
        }
        .load()
        .unwrap()
        .call_completion
        .unwrap(),
        original_cancel_completion.unwrap()
    );
    let policy_id = report.policy_state[0]["completion"]["operation_id"]
        .as_str()
        .unwrap()
        .to_string();
    host.until(&runtime, &bridge, &outgoing, || {
        task_state(&policy_id).result_ready && root.join("continued-after-cancel").exists()
    });
    let original_binding = runtime
        .catalog()
        .lock()
        .unwrap()
        .operation(&complete_id)
        .unwrap()
        .host_job
        .unwrap()
        .binding;
    host.send(json!({"kind":"fixture-finish"}));
    let finished = loop {
        if let Some(frame) = host.pump(&runtime, &bridge, &outgoing) {
            break frame;
        }
    };
    assert_eq!(finished["kind"], "fixture-finished");
    assert_eq!(
        finished["tasks"]["receiver:cancel"]["remoteWorkContinues"],
        true
    );
    assert!(
        root.join("continued-after-cancel").exists(),
        "receiver performed an actual controlled write after acknowledging cancellation"
    );
    assert!(
        finished["requests"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |q| q["id"].as_str().is_some_and(|id| id.starts_with("roots:"))
                    && q["result"]["roots"].is_array()
            ),
        "input_required used the original client roots handler"
    );
    assert_eq!(
        host.permissions, 4,
        "model and policy submissions use original one-action permissions"
    );
    drop(host);
    drop(tools);
    drop(runtime);

    // The accepted task has no final result when the original Host and Catalog are closed.
    // A new Host restores the exact configured endpoint and task identity; tools/call is never replayed.
    let mut reopened = Catalog::open(&path).unwrap();
    assert_eq!(
        reopened
            .operation(&complete_id)
            .unwrap()
            .host_job
            .as_ref()
            .unwrap()
            .mcp_task
            .as_ref()
            .unwrap()
            .task
            .task_id,
        "receiver:complete"
    );
    let next = submit(&mut reopened, "read-after-reopen");
    let runtime = Arc::new(RunSupervisor::new(reopened));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"runId":next.run_id}));
    let deadline = Instant::now() + Duration::from_secs(30);
    let prepared = loop {
        assert!(Instant::now() < deadline);
        if let Some(frame) = host.pump(&runtime, &bridge, &outgoing) {
            assert_eq!(frame["kind"], "fixture-prepared");
            break frame;
        }
    };
    let live = live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
    let get_name = live
        .binding
        .routes
        .iter()
        .find_map(|(name, route)| {
            matches!(
                route,
                varin_runtime::McpRoute::TaskControl {
                    action: varin_runtime::McpTaskAction::Get,
                    ..
                }
            )
            .then(|| name.clone())
        })
        .unwrap();
    let wait_name = live
        .binding
        .routes
        .iter()
        .find_map(|(name, route)| {
            matches!(
                route,
                varin_runtime::McpRoute::TaskControl {
                    action: varin_runtime::McpTaskAction::Wait,
                    ..
                }
            )
            .then(|| name.clone())
        })
        .unwrap();
    let binding = request_binding(&live, &next);
    let policy: Arc<dyn AgentPolicy> = Arc::new(crate::observations::ObservationPolicy {
        inner: Arc::new(DefaultAgentPolicy),
        catalog: runtime.catalog(),
    });
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
        .bind_launch(&next.run_id, launch.clone())
        .unwrap();
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone());
    let prepared = tools
        .prepare_scope(&next.run_id, vec![], Some(live), vec![])
        .unwrap();
    let executor = tools.install(&next.run_id, 1, prepared).unwrap();
    let views = Arc::new(Mutex::new(Vec::new()));
    let run_observer = |host: &mut Host| {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .bind_launch(&next.run_id, launch.clone())
            .unwrap();
        let mut binding = binding.clone();
        binding.history_range.leaf_id = runtime.catalog().lock().unwrap().head("main").unwrap();
        let execution = runtime
            .start(
                &next.run_id,
                RunStart {
                    binding,
                    policy_state: Value::Null,
                    provider: Arc::new(Model {
                        task: String::new(),
                        ordinary: String::new(),
                        inspect: Some((get_name.clone(), complete_id.clone())),
                        wait: Some(wait_name.clone()),
                        views: views.clone(),
                    }),
                    tools: executor.clone(),
                    policy: policy.clone(),
                    context_preparation: Arc::new(crate::child_capabilities::BindingPreparation {
                        inner: Arc::new(NoopContextPreparation),
                        catalog: runtime.catalog(),
                    }),
                    progress: ProgressSink::default(),
                },
            )
            .unwrap();
        let (done_tx, done) = mpsc::channel();
        thread::spawn(move || {
            let _ = done_tx.send(execution.wait());
        });
        let mut report = None;
        host.until(&runtime, &bridge, &outgoing, || {
            report = done.try_recv().ok();
            report.is_some()
        });
        report.unwrap().unwrap()
    };
    let waiting = run_observer(&mut host);
    assert_eq!(waiting.state, RunState::Waiting, "{:?}", waiting.failure);
    let wait_id = waiting
        .waiting_on
        .as_ref()
        .expect("original Task result Wait");
    assert!(wait_id.starts_with(varin_runtime::catalog::host_jobs::WAIT_PREFIX));
    std::fs::write(
        root.join("complete.done"),
        b"controlled receiver completion",
    )
    .unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        let op = runtime
            .catalog()
            .lock()
            .unwrap()
            .operation(&complete_id)
            .unwrap();
        op.host_job
            .as_ref()
            .unwrap()
            .mcp_task
            .as_ref()
            .unwrap()
            .result_ready
            && op
                .external_receipt
                .as_ref()
                .is_some_and(|receipt| receipt.executor_stopped)
    });
    let original_read = {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        db.capture_operation_read(db.operation(&complete_id).unwrap())
    }
    .load()
    .unwrap();
    assert_eq!(original_read.outcome, Some(Outcome::Succeeded));
    assert!(
        original_read
            .external_receipt
            .as_ref()
            .unwrap()
            .executor_stopped
    );
    assert_eq!(
        original_read.host_job.as_ref().unwrap().binding,
        original_binding
    );
    let result = original_read
        .host_job
        .as_ref()
        .unwrap()
        .mcp_task_result
        .as_ref()
        .unwrap();
    assert_eq!(result.data["structuredContent"]["nullable"], Value::Null);
    assert_eq!(
        result.data["structuredContent"]["opaque"]["data"],
        "not media"
    );
    let (part_index, descriptor) = result
        .parts
        .iter()
        .enumerate()
        .find_map(|(i, p)| match p {
            varin_runtime::output::OutputPart::Media { media } => Some((i, media)),
            _ => None,
        })
        .unwrap();
    let params:varin_runtime::output::MediaReadParams=serde_json::from_value(json!({"threadId":"thread","branchId":"main",
        "holder":{"kind":"operation","operationId":complete_id,"output":"mcp_task_result"},"partIndex":part_index,"chunkIndex":0,"expectedContentRef":descriptor.content_ref.content_object})).unwrap();
    let read = runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_media_read(&params)
        .unwrap();
    let original_chunk = read.chunk(&|| false).unwrap();
    assert!(original_chunk.bytes_base64.starts_with("iVBOR"));
    host.until(&runtime, &bridge, &outgoing, || {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .run(&next.run_id)
            .unwrap()
            .state
            == RunState::Runnable
    });
    let report = run_observer(&mut host);
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let view = views.lock().unwrap().last().unwrap().clone();
    let delivered = view
        .history
        .iter()
        .find_map(|item| match &item.content {
            Content::Output { output } if output.data["operationId"] == complete_id => Some(output),
            _ => None,
        })
        .expect("original Task result Wait must deliver output to the resumed model");
    let image_index = delivered.data["receipt"]["content"][1]["data"]["outputPartIndex"]
        .as_u64()
        .expect("original MCP image part index") as usize;
    assert!(
        matches!(
            delivered.parts.get(image_index),
            Some(varin_runtime::output::OutputPart::Media { .. })
        ),
        "Wait lifecycle text must preserve the original typed output part indices"
    );
    let inspected = view
        .history
        .iter()
        .find_map(|i| match &i.content {
            Content::ToolResult { result } if result.call_id == "inspect-original" => Some(result),
            _ => None,
        })
        .unwrap();
    let ToolCompletion::Result {
        outcome, content, ..
    } = &inspected.completion
    else {
        panic!("original get result")
    };
    assert_eq!(*outcome, Outcome::Succeeded);
    assert!(
        content
            .parts
            .iter()
            .any(|p| matches!(p, varin_runtime::output::OutputPart::Media { .. })),
        "stored task media must reach the next real model request through the original Host tool bridge"
    );
    assert_eq!(
        view.history
            .iter()
            .filter(
                |i| matches!(&i.content,Content::ToolResult{result}if result.call_id=="complete")
            )
            .count(),
        1,
        "final result must not create another provider pair for the original Job call"
    );
    let fork = {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        db.prepare_branch_fork("main", "fork", db.head("main").unwrap().as_deref(), None)
            .unwrap()
    }
    .load()
    .unwrap();
    runtime
        .catalog()
        .lock()
        .unwrap()
        .admit_branch_fork(fork)
        .unwrap();
    let collection = {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default())
    }
    .run();
    assert_eq!(
        collection.status,
        varin_runtime::ContentCollectionStatus::Completed,
        "{:?}",
        collection.reason
    );
    assert_eq!(
        {
            runtime
                .catalog()
                .lock()
                .unwrap()
                .capture_media_read(&params)
                .unwrap()
        }
        .chunk(&|| false)
        .unwrap()
        .bytes_base64,
        original_chunk.bytes_base64
    );
    host.send(json!({"kind":"fixture-finish"}));
    let finished = loop {
        if let Some(frame) = host.pump(&runtime, &bridge, &outgoing) {
            break frame;
        }
    };
    let calls: Vec<_> = finished["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|q| q["method"] == "tools/call")
        .collect();
    assert_eq!(
        calls.len(),
        4,
        "two model tasks, one policy task and one ordinary call, without task recreation after reopen"
    );
    assert!(
        calls
            .iter()
            .filter(|q| q["params"]["name"] == "deferred")
            .all(|q| q["params"]["task"].is_object())
    );
}

#[path = "mcp_task_consumers_review.rs"]
mod consumers;

struct LostAcceptance {
    task: String,
    expect_unknown: bool,
}
impl ModelProvider for LostAcceptance {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(json!({"request":view.request_id}).into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        if let Some(result) = request
            .view
            .history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } => Some(result),
                _ => None,
            })
        {
            assert!(
                !self.expect_unknown,
                "the original default policy must stop at Unknown"
            );
            assert!(matches!(
                result.completion,
                ToolCompletion::JobAccepted { .. }
            ));
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: "accepted-finish".into(),
                    opaque: None,
                    content: Content::Text {
                        text: "Original job accepted".into(),
                    },
                },
            })
            .unwrap();
            return Ok(FinishReason::Stop);
        }
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|schema| schema.name == self.task)
            .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "late-call".into(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: "late".into(),
                        name: self.task.clone(),
                        schema_version: schema.version.clone(),
                        arguments: json!({"scenario":"late"}),
                    },
                },
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
#[test]
#[ignore = "requires workspace Node/tsx and built pi-host; original MCP stdio, no product socket"]
fn original_mcp_acceptance_reply_loss_preserves_original_completion_and_eventual_result() {
    acceptance_reply_case(true);
    acceptance_reply_case(false);
}
fn acceptance_reply_case(committed: bool) {
    let root = std::env::temp_dir().join(format!("varin-mcp-tasks-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("thread", "main").unwrap();
    let submitted = submit(&mut db, "lost-ack");
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let mut host = Host::new();
    host.reject_acceptance_reply = committed;
    host.hold_acceptance = !committed;
    host.send(
        json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"runId":submitted.run_id}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let prepared = loop {
        assert!(Instant::now() < deadline);
        if let Some(frame) = host.pump(&runtime, &bridge, &outgoing) {
            assert_eq!(frame["kind"], "fixture-prepared");
            break frame;
        }
    };
    let task = prepared["names"]["deferred"].as_str().unwrap().to_string();
    let live = live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
    let binding = request_binding(&live, &submitted);
    let policy: Arc<dyn AgentPolicy> = Arc::new(DefaultAgentPolicy);
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
        .bind_launch(&submitted.run_id, launch)
        .unwrap();
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone());
    let directory = tools
        .prepare_scope(&submitted.run_id, vec![], Some(live), vec![])
        .unwrap();
    let executor = tools.install(&submitted.run_id, 1, directory).unwrap();
    let execution = runtime
        .start(
            &submitted.run_id,
            RunStart {
                binding,
                policy_state: Value::Null,
                provider: Arc::new(LostAcceptance {
                    task,
                    expect_unknown: !committed,
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
    let (done_tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(execution.wait());
    });
    let mut report = None;
    host.until(&runtime, &bridge, &outgoing, || {
        report = done.try_recv().ok();
        report.is_some()
    });
    let report = report.unwrap().unwrap();
    assert_eq!(
        report.state,
        if committed {
            RunState::Completed
        } else {
            RunState::Failed
        }
    );
    assert!(
        host.interrupted_acceptance,
        "the selected acceptance interruption actually occurred"
    );
    let original = report
        .history
        .iter()
        .find_map(|item| match &item.content {
            Content::ToolResult { result } if result.call_id == "late" => Some(result.clone()),
            _ => None,
        })
        .unwrap();
    if committed {
        assert!(matches!(
            original.completion,
            ToolCompletion::JobAccepted { .. }
        ));
    } else {
        assert!(matches!(
            original.completion,
            ToolCompletion::Result {
                outcome: Outcome::Indeterminate,
                effect: Effect::Unknown,
                ..
            }
        ));
    }
    host.hold_acceptance = false;
    host.send(json!({"kind":"fixture-ready"}));
    let id = ToolOrigin::ModelStep {
        request_id: original.request_id.clone(),
    }
    .operation_id("late");
    let before = {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .capture_history_page("main")
            .unwrap()
    }
    .load(None, None, 100, &|| false)
    .unwrap();
    tools.release(&submitted.run_id);
    host.send(json!({"v":1,"kind":"host-tool-owner-release","kernelEpoch":EPOCH,"runId":submitted.run_id}));
    std::fs::write(root.join("late.done"), b"complete original accepted task").unwrap();
    host.until(&runtime, &bridge, &outgoing, || {
        let op = runtime.catalog().lock().unwrap().operation(&id).unwrap();
        op.host_job
            .as_ref()
            .and_then(|link| link.mcp_task.as_ref())
            .is_some_and(|task| task.result_ready)
            && op
                .external_receipt
                .as_ref()
                .is_some_and(|receipt| receipt.executor_stopped)
    });
    let read = {
        let catalog = runtime.catalog();
        let db = catalog.lock().unwrap();
        db.capture_operation_read(db.operation(&id).unwrap())
    }
    .load()
    .unwrap();
    assert_eq!(
        serde_json::to_value(&read.call_completion).unwrap(),
        serde_json::to_value(Some(&original.completion)).unwrap()
    );
    assert_eq!(read.outcome, Some(Outcome::Succeeded));
    let task = read.host_job.as_ref().unwrap();
    assert_eq!(
        task.mcp_task.as_ref().unwrap().task.task_id,
        "receiver:late"
    );
    assert!(
        task.mcp_task_result
            .as_ref()
            .unwrap()
            .parts
            .iter()
            .any(|part| matches!(part, varin_runtime::output::OutputPart::Media { .. }))
    );
    let after = {
        runtime
            .catalog()
            .lock()
            .unwrap()
            .capture_history_page("main")
            .unwrap()
    }
    .load(None, None, 100, &|| false)
    .unwrap();
    assert_eq!(before.head, after.head);
    assert_eq!(
        before
            .items
            .iter()
            .map(|item| (&item.id, &item.content_ref))
            .collect::<Vec<_>>(),
        after
            .items
            .iter()
            .map(|item| (&item.id, &item.content_ref))
            .collect::<Vec<_>>()
    );
    host.send(json!({"kind":"fixture-finish"}));
    let finished = loop {
        if let Some(frame) = host.pump(&runtime, &bridge, &outgoing) {
            break frame;
        }
    };
    assert_eq!(finished["kind"], "fixture-finished");
    assert_eq!(
        finished["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|frame| frame["method"] == "tools/call")
            .count(),
        1,
        "lost local ACK cannot replay the original remote effect"
    );
}
