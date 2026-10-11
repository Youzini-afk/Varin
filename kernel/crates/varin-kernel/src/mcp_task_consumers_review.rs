//! One original source-less child consumes Tasks directly and through an installed SDK extension.
//! Reuses the parent review's real MCP/permission/Host pump; only the model and remote work are controlled.
use super::*;
use std::sync::atomic::Ordering;
use varin_runtime::Lifetime;
use varin_runtime::catalog::collaboration::{ChildCodeResult, ChildSource};
use varin_runtime::catalog::launches::{ExtensionToolBinding, HostToolBinding};

struct ConsumerModel {
    task: ToolSchema,
    get: ToolSchema,
    outer: ToolSchema,
    views: Arc<Mutex<Vec<RequestView>>>,
    results_ready: Arc<AtomicBool>,
}
impl ModelProvider for ConsumerModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        self.views.lock().unwrap().push(view.clone());
        Ok(json!({"request": view.request_id}))
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
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
        let call = match results.len() {
            0 => Some(ToolCall {
                call_id: "direct-task".into(),
                name: self.task.name.clone(),
                schema_version: self.task.version.clone(),
                arguments: json!({"scenario":"child-direct"}),
            }),
            1 => {
                assert!(matches!(
                    &results[0].completion,
                    ToolCompletion::JobAccepted {
                        lifetime: Lifetime::Thread,
                        ..
                    }
                ));
                Some(ToolCall {
                    call_id: "outer-start".into(),
                    name: self.outer.name.clone(),
                    schema_version: self.outer.version.clone(),
                    arguments: json!({"callId":"nested-start","name":self.task.name,
                        "arguments":{"scenario":"child-nested"}}),
                })
            }
            2 => {
                let ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    content,
                    ..
                } = &results[1].completion
                else {
                    panic!(
                        "installed extension must return its original nested receipt: {:?}",
                        results[1]
                    );
                };
                assert_eq!(content.data["completion"]["kind"], "job_accepted");
                let nested = content.data["operationId"].as_str().unwrap();
                assert_eq!(content.data["completion"]["operation_id"], nested);
                let deadline = Instant::now() + Duration::from_secs(30);
                while !self.results_ready.load(Ordering::Acquire) {
                    assert!(
                        !cancel.is_cancelled() && Instant::now() < deadline,
                        "original Task results did not arrive"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                Some(ToolCall {
                    call_id: "outer-get".into(),
                    name: self.outer.name.clone(),
                    schema_version: self.outer.version.clone(),
                    arguments: json!({"callId":"nested-get","name":self.get.name,
                        "arguments":{"operationId":nested}}),
                })
            }
            3 => None,
            _ => panic!("nested calls must not create extra model tool-result pairs"),
        };
        let more = call.is_some();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: request.view.request_id.clone(),
                opaque: None,
                content: call.map_or_else(
                    || Content::Text {
                        text: "Original child Task receipts and result consumed".into(),
                    },
                    |call| Content::ToolCall { call },
                ),
            },
        })
        .unwrap();
        Ok(if more {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}

#[test]
#[ignore = "requires Node/tsx and built MCP/extension packages; original stdio, no product socket"]
fn source_less_child_and_installed_nested_extension_preserve_original_task_receipts_and_results() {
    let root = std::env::temp_dir().join(format!("varin-task-consumers-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"consumer":true}));
    // Consumer preparation installs its actual brokered package before creating any Run. No
    // Kernel request is made until the Catalog below contains the real admitted identities.
    let initial = host.frames.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(initial["kind"], "fixture-prepared", "{initial}");
    let mcp: HostToolBinding =
        mcp_binding(serde_json::from_value(initial["mcpBinding"].clone()).unwrap()).unwrap();
    let extension: ExtensionToolBinding =
        extension_binding(serde_json::from_value(initial["extensionBinding"].clone()).unwrap())
            .unwrap();
    let task_name = initial["names"]["deferred"].as_str().unwrap().to_string();
    assert!(matches!(
        mcp.routes[&task_name],
        varin_runtime::McpRoute::DirectTask
    ));
    let get_name = mcp
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
    let task = mcp
        .tools
        .iter()
        .find(|tool| tool.name == task_name)
        .unwrap()
        .clone();
    let get = mcp
        .tools
        .iter()
        .find(|tool| tool.name == get_name)
        .unwrap()
        .clone();
    let outer = extension.tool.clone();
    let selected = vec![task_name, get_name, outer.name.clone()];
    let super::super::mcp_consumer_fixture::PreparedChild {
        runtime,
        bridge,
        outgoing,
        binding,
        executor,
        child,
        tools,
        catalog_root,
    } = super::super::mcp_consumer_fixture::prepare_child(
        &mut host,
        mcp,
        extension,
        task.clone(),
        selected,
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
    let views = Arc::new(Mutex::new(Vec::new()));
    let results_ready = Arc::new(AtomicBool::new(false));
    let execution = runtime
        .start(
            &run_id,
            RunStart {
                binding,
                policy_state: Value::Null,
                provider: Arc::new(ConsumerModel {
                    task,
                    get,
                    outer,
                    views: views.clone(),
                    results_ready: results_ready.clone(),
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
    let (done_tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(execution.wait());
    });
    let mut accepted_ids = Vec::new();
    host.until(&runtime, &bridge, &outgoing, || {
        if let Ok(result) = done.try_recv() {
            panic!("child ended before both Task acceptances reached its model: {result:?}");
        }
        let snapshots = views.lock().unwrap();
        let Some(view) = snapshots.last() else {
            return false;
        };
        let results: Vec<_> = view
            .history
            .iter()
            .filter_map(|item| match &item.content {
                Content::ToolResult { result } => Some(result),
                _ => None,
            })
            .collect();
        if results.len() != 2 {
            return false;
        }
        let ToolCompletion::JobAccepted { operation_id, .. } = &results[0].completion else {
            panic!("direct Task acceptance required")
        };
        let ToolCompletion::Result { content, .. } = &results[1].completion else {
            panic!("outer receipt required")
        };
        accepted_ids = vec![
            operation_id.clone(),
            content.data["operationId"].as_str().unwrap().to_string(),
        ];
        true
    });
    let originals: Vec<_> = accepted_ids
        .iter()
        .map(|id| {
            let catalog = runtime.catalog();
            let db = catalog.lock().unwrap();
            let op = db.operation(id).unwrap();
            assert_eq!(op.run_id, run_id);
            let task = op.host_job.as_ref().unwrap();
            assert!(matches!(
                task.binding.subject,
                varin_runtime::catalog::host_jobs::HostJobSubject::Mcp { .. }
            ));
            assert!(
                !op.external_receipt
                    .as_ref()
                    .is_some_and(|receipt| receipt.executor_stopped)
            );
            db.capture_operation_read(op).load().unwrap()
        })
        .collect();
    assert_eq!(originals[0].intent["origin"]["kind"], "model_step");
    assert_eq!(originals[1].intent["origin"]["kind"], "nested_call");
    assert_eq!(originals[1].intent["call"]["call_id"], "nested-start");
    for scenario in ["child-direct", "child-nested"] {
        std::fs::write(
            root.join(format!("{scenario}.done")),
            b"actual receiver completion",
        )
        .unwrap();
    }
    host.until(&runtime, &bridge, &outgoing, || {
        accepted_ids.iter().all(|id| {
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
                .result_ready
        })
    });
    results_ready.store(true, Ordering::Release);
    let mut report = None;
    host.until(&runtime, &bridge, &outgoing, || {
        report = done.try_recv().ok();
        report.is_some()
    });
    let report = report.unwrap().unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let final_view = views.lock().unwrap().last().unwrap().clone();
    let results: Vec<_> = final_view
        .history
        .iter()
        .filter_map(|item| match &item.content {
            Content::ToolResult { result } => Some(result),
            _ => None,
        })
        .collect();
    assert_eq!(
        results.len(),
        3,
        "nested Task and get do not fabricate model call/result pairs"
    );
    assert_eq!(results[0].call_id, "direct-task");
    let ToolCompletion::Result {
        content,
        outcome: Outcome::Succeeded,
        ..
    } = &results[2].completion
    else {
        panic!("nested get receipt required")
    };
    let lookup = &content.data["completion"]["content"];
    assert_eq!(lookup["data"]["operationId"], accepted_ids[1]);
    assert_eq!(
        lookup["data"]["task"]["task"]["taskId"],
        "receiver:child-nested"
    );
    assert_eq!(lookup["data"]["task"]["resultReady"], true);
    assert_eq!(
        lookup["data"]["result"]["structuredContent"]["scenario"],
        "child-nested"
    );
    assert_eq!(
        lookup["data"]["result"]["structuredContent"]["nullable"],
        Value::Null
    );
    assert_eq!(
        lookup["data"]["result"]["structuredContent"]["empty"],
        json!([])
    );
    assert_eq!(lookup["parts"].as_array().unwrap().len(), 3);
    assert!(
        host.permissions >= 4,
        "direct, outer and nested dispatch each require their original permission; get uses original Job access"
    );
    for (id, before) in accepted_ids.iter().zip(originals) {
        let read = {
            let catalog = runtime.catalog();
            let db = catalog.lock().unwrap();
            db.capture_operation_read(db.operation(id).unwrap())
        }
        .load()
        .unwrap();
        assert_eq!(
            read.call_completion, before.call_completion,
            "final result never rewrites original JobAccepted"
        );
        assert!(read.host_job.unwrap().mcp_task_result.is_some());
    }
    runtime.reconcile_observations().unwrap();
    let completed = runtime
        .catalog()
        .lock()
        .unwrap()
        .child_task(&child.operation_id)
        .unwrap();
    assert_eq!(completed.source, ChildSource::Absent);
    assert_eq!(completed.code_result, ChildCodeResult::NotApplicable);
    assert_eq!(completed.report.unwrap().outcome, Outcome::Succeeded);
    host.send(json!({"kind":"fixture-finish"}));
    let deadline = Instant::now() + Duration::from_secs(30);
    let finished = loop {
        assert!(Instant::now() < deadline);
        if let Some(frame) = host.pump(&runtime, &bridge, &outgoing) {
            break frame;
        }
    };
    assert_eq!(finished["kind"], "fixture-finished");
    let calls: Vec<_> = finished["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|call| call["method"] == "tools/call")
        .collect();
    assert_eq!(
        calls.len(),
        2,
        "child and installed nested consumer each dispatch exactly once"
    );
    assert!(calls.iter().all(|call| call["params"]["task"].is_object()));
    assert!(
        finished["requests"]
            .as_array()
            .unwrap()
            .iter()
            .any(|call| call["method"] == "tasks/result"
                && call["params"]["taskId"] == "receiver:child-nested")
    );
    drop(host);
    drop(tools);
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(catalog_root).unwrap();
}
