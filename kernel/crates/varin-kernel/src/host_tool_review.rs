//! Portable real bridge + Catalog tests. No socket/Host process success is claimed here.
use crate::host_tools::{LateReceipt, ToolBridge};
use serde_json::{json, Value};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, ExecutorOwner, Outcome, RunState, SubmitInput};

fn recv(frames: &mpsc::Receiver<Value>, kind: &str) -> Value {
    loop {
        let frame = frames.recv_timeout(Duration::from_secs(5)).unwrap();
        if frame["kind"] == kind {
            return frame;
        }
    }
}
#[test]
fn ordinary_service_model_and_policy_share_real_directory_permission_dispatch_and_late_owner_recovery(
) {
    for policy in [false, true] {
        let root =
            std::env::temp_dir().join(format!("varin-host-tools-review-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "main").unwrap();
        let preparation = catalog
            .prepare_submission(
                SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "main".into(),
                    expected_head: None,
                    input: json!("read stored material"),
                    configuration: json!({}),
                },
                None,
                None,
            )
            .unwrap();
        let submitted = catalog
            .admit_submission(preparation.load(None, false).unwrap())
            .unwrap();
        let live = json!({"ownerId":"original-host-owner","generation":7,"binding":{
            "providerKey":"installed:host:read@1","extensionId":"installed","extensionVersion":"1.0.0","serviceId":"read","serviceVersion":1,
            "artifactIntegrity":"sha256-original","declarationHash":"decl-original","configurationIdentity":null,
            "tool":{"name":"material_read","version":"decl-original","description":"Read an immutable material snapshot","schema":{"type":"object"},"output_schema":{"type":"object"},
                "metadata":{"service_id":"read","service_version":1,"completion":"result","operation":"read"}}
        }});
        // Validate the actual generated nested DTO, including output_schema spelling.
        crate::protocol::validate_method_params("runtime.tools.ready",&json!({"runId":submitted.run_id,"selectionId":"selected","extensionBindings":[live.clone()]})).unwrap();
        crate::protocol::validate_method_params(
            "runtime.launch.extensions.prepare",
            &json!({"runId":submitted.run_id,"bindings":[live["binding"].clone()]}),
        )
        .unwrap();
        let mut misspelled = live.clone();
        let tool = misspelled["binding"]["tool"].as_object_mut().unwrap();
        let output = tool.remove("output_schema").unwrap();
        tool.insert("outputSchema".into(), output);
        assert!(crate::protocol::validate_method_params("runtime.tools.ready", &json!({"runId":submitted.run_id,"selectionId":"selected","extensionBindings":[misspelled]})).is_err());
        let live =
            crate::agent_runtime::live_extension_binding(serde_json::from_value(live).unwrap())
                .unwrap();
        let schema = live.binding.tool.clone();
        let persisted_binding = live.binding.clone();
        let (out, frames) = mpsc::sync_channel(16);
        let bridge = ToolBridge::new(out.into());
        bridge.initialize("transport-before");
        let generation = bridge
            .prepare_extension(submitted.run_id.clone(), live)
            .unwrap();
        recv(&frames, "host-tool-binding-retain");
        let directory = Arc::new(
            varin_runtime::composition::tools::ToolDirectory::assemble(generation.declarations())
                .unwrap(),
        );
        let binding = RequestBinding {
            child_dispatch: None,
            goal: None, resource_activations: Vec::new(),
            resource_checkpoint_id: None,
            connection_identity: "fixture".into(),
            provider_family: "fixture".into(),
            model: "fixture".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: vec![schema.clone()],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: "main".into(),
                ancestor_id: None,
                leaf_id: Some(submitted.input_id.clone()),
            },
        };
        let identity = PolicyIdentity {
            name: "fixture".into(),
            version: "1".into(),
        };
        let mut launch = varin_runtime::catalog::launches::LaunchSelection::from_binding(
            &binding,
            identity.clone(),
            None,
        );
        launch.extension_bindings.push(persisted_binding);
        catalog.bind_launch(&submitted.run_id, launch).unwrap();
        let input = catalog
            .prepare_execution(
                &submitted.run_id,
                binding.clone(),
                identity.clone(),
                Value::Null,
            )
            .unwrap();
        let db = Arc::new(Mutex::new(catalog));
        let run = &submitted.run_id;
        let epoch = input.owner_generation;
        db.commit(
            run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        let call = ToolCall {
            call_id: if policy { "node" } else { "call" }.into(),
            name: schema.name.clone(),
            schema_version: schema.version.clone(),
            arguments: json!({"snapshotId":"immutable"}),
        };
        let (origin, frozen) = if policy {
            let boundary = db.policy_boundary(run, epoch).unwrap();
            let action_id = format!("{run}:policy:{}", boundary.id);
            let origin = ToolOrigin::PolicyAction {
                action_id: action_id.clone(),
                node_id: call.call_id.clone(),
            };
            let frozen = FrozenToolContext {
                child_dispatch: None,
                resource_activations: Vec::new(),
                resource_checkpoint_id: None,
                run_id: run.clone(),
                origin: origin.clone(),
                tool_schema_generation: 1,
                tools: Arc::new(vec![schema.clone()]),
                source: boundary.source.clone(),
            };
            let intent = PolicyGraphIntent::PolicyToolGraphV1 {
                action_id,
                boundary,
                identity,
                state: json!({}),
                nodes: vec![PolicyAdmittedNode {
                    node: PolicyToolNode {
                        id: call.call_id.clone(),
                        depends_on: vec![],
                        call: call.clone(),
                    },
                    context: frozen.clone(),
                }],
            };
            db.admit_policy_graph(run, epoch, &intent).unwrap();
            (origin, frozen)
        } else {
            let request_id = "request".to_string();
            db.commit(
                run,
                epoch,
                &ExecutionRecord::RequestPrepared {
                    snapshot: RequestSnapshot {
                        view: RequestView {
                            request_id: request_id.clone(),
                            run_id: run.clone(),
                            origin: RequestOrigin::Conversation {
                                step: 1,
                                history_range: binding.history_range.clone(),
                            },
                            binding: binding.clone(),
                            history: vec![],
                        },
                        serialized: json!({"fixture":true}),
                    },
                },
            )
            .unwrap();
            db.commit(
                run,
                epoch,
                &ExecutionRecord::ModelDispatched {
                    request_id: request_id.clone(),
                },
            )
            .unwrap();
            db.commit(
                run,
                epoch,
                &ExecutionRecord::ModelFinished {
                    request_id: request_id.clone(),
                    outcome: ModelOutcome::Completed,
                    finish_reason: Some(FinishReason::ToolCalls),
                    items: vec![ProviderItem {
                        id: "call-item".into(),
                        content: Content::ToolCall { call: call.clone() },
                        opaque: None,
                    }],
                    interrupted_deltas: vec![],
                    usage: UsageReceipt::default(),
                    failure: None,
                },
            )
            .unwrap();
            let origin = ToolOrigin::ModelStep { request_id };
            let frozen = FrozenToolContext {
                child_dispatch: None,
                resource_activations: Vec::new(),
                resource_checkpoint_id: None,
                run_id: run.clone(),
                origin: origin.clone(),
                tool_schema_generation: 1,
                tools: Arc::new(vec![schema.clone()]),
                source: None,
            };
            (origin, frozen)
        };
        let context = ToolExecutionContext {
            run_id: run.clone(),
            operation_id: origin.operation_id(&call.call_id),
            origin: origin.clone(),
        };
        let cancel = CancellationToken::default();
        let bound = directory.bind_call(&call, &frozen, &cancel).unwrap();
        let contract = bound.prepare(&cancel).unwrap();
        assert!(
            !contract.read_only,
            "an author's read declaration never grants trusted lightweight replay"
        );
        assert!(!bound.supports_policy_read(&contract));
        db.commit(
            run,
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
        let host_call = json!({"runId":run,"operationId":context.operation_id,"origin":origin,"callId":call.call_id,"name":call.name,"schemaVersion":call.schema_version,"arguments":call.arguments});
        let scope = json!({"ownerReference":"installed:host:read@1","ownerGeneration":7,"toolSchemaVersion":"decl-original","policyGeneration":"policy-1","reason":"fixture exact permission"});
        {
            let mut catalog = db.lock().unwrap();
            catalog
                .open_permission(
                    &context.operation_id,
                    "permission",
                    host_call.clone(),
                    scope.clone(),
                )
                .unwrap();
            catalog
                .decide_permission(&context.operation_id, "permission", "allow_once")
                .unwrap();
            catalog
                .consume_permission(
                    &context.operation_id,
                    "permission",
                    host_call.clone(),
                    scope,
                )
                .unwrap();
        }
        let executor_owner = bound.executor_owner();
        assert_eq!(
            executor_owner,
            ExecutorOwner::External {
                identity: "installed:host:read@1".into(),
                epoch: "original-host-owner".into()
            }
        );
        let _watch = bound.watch_admission(&context, &contract, &cancel).unwrap();
        let (send, result) = mpsc::channel();
        let ctx = context.clone();
        let token = cancel.clone();
        let worker_db = db.clone();
        let worker_run = run.clone();
        std::thread::spawn(move || {
            bound.authorize(&ctx, &contract, &token).unwrap();
            worker_db
                .commit(
                    &worker_run,
                    epoch,
                    &ExecutionRecord::ToolDispatched {
                        context: ctx.clone(),
                        executor_owner,
                    },
                )
                .unwrap();
            let receipt = bound.execute(&ctx, &contract, &token);
            worker_db
                .commit(
                    &worker_run,
                    epoch,
                    &ExecutionRecord::ToolSettled {
                        context: ctx,
                        completion: receipt.completion.clone(),
                        executor_stopped: receipt.executor_stopped,
                    },
                )
                .unwrap();
            send.send(receipt).unwrap();
        });
        let authorize = recv(&frames, "host-tool-request");
        assert_eq!(authorize["call"], host_call);
        bridge.receive(json!({"v":1,"kind":"host-tool-response","id":authorize["id"],"kernelEpoch":"transport-before","ok":true}));
        let executed = recv(&frames, "host-tool-request");
        assert_eq!(executed["phase"], "execute");
        assert_eq!(executed["call"], host_call);
        cancel.cancel();
        let cancellation = recv(&frames, "host-tool-cancel");
        assert_eq!(cancellation["id"], executed["id"]);
        bridge.receive(json!({"v":1,"kind":"host-tool-response","id":executed["id"],"kernelEpoch":"transport-before","ok":true,"executor_stopped":false,
            "completion":{"kind":"result","outcome":"indeterminate","effect":"unknown","content":{"error":"observer_cancelled"}}}));
        let original = result.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!original.executor_stopped);
        if let ToolOrigin::PolicyAction { action_id, node_id } = &origin {
            db.settle_policy_node(run, epoch, action_id, node_id, &original.completion)
                .unwrap();
        } else {
            db.commit(
                run,
                epoch,
                &ExecutionRecord::ToolBatchCommitted {
                    request_id: "request".into(),
                    results: vec![ToolResult {
                        request_id: "request".into(),
                        call_id: call.call_id.clone(),
                        completion: original.completion.clone(),
                    }],
                },
            )
            .unwrap();
        }
        let state = if policy {
            RunState::Cancelled
        } else {
            RunState::Completed
        };
        if policy {
            db.lock().unwrap().request_cancel_run(run).unwrap();
        }
        db.commit(
            run,
            epoch,
            &ExecutionRecord::StateChanged {
                state,
                waiting_on: None,
            },
        )
        .unwrap();
        bridge.close();
        drop(generation);
        drop(db);
        let db = Arc::new(Mutex::new(Catalog::open(&root).unwrap()));
        assert_eq!(
            db.lock()
                .unwrap()
                .resource_admission()
                .inspect(&context.operation_id)
                .unwrap()
                .state,
            "active",
            "kernel restart cannot stop an external callback"
        );
        let before = db.lock().unwrap().run(run).unwrap();
        // An unchanged unknown receipt can independently confirm that its original executor
        // stopped. It must free occupancy without inventing a confirmed business effect.
        let stopped_unknown = json!({"v":1,"kind":"host-tool-receipt","id":"original-unknown-stop","kernelEpoch":"replacement-transport",
            "executionOwner":{"kind":"external","identity":"installed:host:read@1","epoch":"original-host-owner"},"call":host_call,
            "receipt":{"completion":original.completion,"executor_stopped":true}});
        for _ in 0..2 {
            serde_json::from_value::<LateReceipt>(stopped_unknown.clone()).unwrap().apply(&db).unwrap();
        }
        {
            let catalog=db.lock().unwrap();
            let op=catalog.operation(&context.operation_id).unwrap();
            let op=catalog.capture_operation_read(op).load().unwrap();
            assert_eq!(op.effect,Effect::Unknown);
            assert_eq!(op.result,Some(json!({"error":"observer_cancelled"})));
            assert!(catalog.resource_admission().inspect(&context.operation_id).is_none());
            assert_eq!(catalog.run(run).unwrap(),before);
        }
        let original_text = if policy {
            "large-original-".repeat(1_400_000)
        } else {
            "original bytes".into()
        };
        let late = json!({"v":1,"kind":"host-tool-receipt","id":"original-receipt","kernelEpoch":"replacement-transport",
            "executionOwner":{"kind":"external","identity":"installed:host:read@1","epoch":"original-host-owner"},"call":host_call,
            "receipt":{"completion":{"kind":"result","outcome":"succeeded","effect":"confirmed","content":{"text":original_text}},"executor_stopped":true}});
        let mut forged = late.clone();
        forged["executionOwner"]["epoch"] = json!("replacement-owner");
        assert!(serde_json::from_value::<LateReceipt>(forged)
            .unwrap()
            .apply(&db)
            .is_err());
        for _ in 0..2 {
            serde_json::from_value::<LateReceipt>(late.clone())
                .unwrap()
                .apply(&db)
                .unwrap();
        }
        let catalog = db.lock().unwrap();
        let op = catalog.operation(&context.operation_id).unwrap();
        let op = catalog.capture_operation_read(op).load().unwrap();
        assert_eq!(op.call_completion, Some(original.completion));
        assert_eq!(
            op.result,
            Some(json!({"text":original_text})),
            "full external result must roundtrip through the existing ContentStore"
        );
        assert_eq!(
            (op.outcome, op.effect),
            (Some(Outcome::Succeeded), Effect::Confirmed)
        );
        assert!(catalog
            .resource_admission()
            .inspect(&context.operation_id)
            .is_none());
        assert_eq!(
            catalog.run(run).unwrap(),
            before,
            "late receipt cannot revive a completed or cancelled Run"
        );
        drop(catalog);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn rejected_newer_candidate_can_restore_the_prior_ready_directory_before_next_request() {
    let root = std::env::temp_dir().join(format!("varin-ready-restore-{}", uuid::Uuid::new_v4()));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("thread", "main").unwrap();
    let preparation = catalog
        .prepare_submission(
            SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("fixture"),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap();
    let submitted = catalog
        .admit_submission(preparation.load(None, false).unwrap())
        .unwrap();
    let run = submitted.run_id.clone();
    let binding = RequestBinding {
        child_dispatch: None,
        goal: None, resource_activations: Vec::new(),
        resource_checkpoint_id: None,
        connection_identity: "fixture".into(),
        provider_family: "fixture".into(),
        model: "fixture".into(),
        credential_ref: None,
        configuration_generation: 1,
        tool_schema_generation: 1,
        tools: vec![],
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: "main".into(),
            ancestor_id: None,
            leaf_id: Some(submitted.input_id),
        },
    };
    catalog
        .bind_launch(
            &run,
            varin_runtime::catalog::launches::LaunchSelection::from_binding(
                &binding,
                PolicyIdentity {
                    name: "fixture".into(),
                    version: "1".into(),
                },
                None,
            ),
        )
        .unwrap();
    let epoch = catalog.epoch();
    let db = Arc::new(Mutex::new(catalog));
    let (out, _frames) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(out.into());
    bridge.initialize("transport");
    let tools = crate::run_tools::RunTools::new(db.clone(), bridge);
    let prepared = tools.prepare_scope(&run, vec![], None, vec![]).unwrap();
    let executor = tools.install(&run, 1, prepared).unwrap();
    let extension = |id: &str| {
        crate::agent_runtime::live_extension_binding(serde_json::from_value(json!({"ownerId":id,"generation":1,"binding":{
        "providerKey":format!("{id}:host:read@1"),"extensionId":id,"extensionVersion":"1.0.0","serviceId":"read","serviceVersion":1,
        "artifactIntegrity":format!("artifact-{id}"),"declarationHash":format!("declaration-{id}"),"configurationIdentity":null,
        "tool":{"name":"read","version":format!("declaration-{id}"),"description":format!("Read {id}"),"schema":{"type":"object"},"output_schema":null,
        "metadata":{"service_id":"read","service_version":1,"completion":"result","operation":"read"}}
    }})).unwrap()).unwrap()
    };
    let a = extension("A");
    let b = extension("B");
    tools.desire(&run, "A-ready").unwrap();
    assert!(tools
        .ready(&run, "A-ready", None, vec![a.clone()], || false)
        .unwrap());
    assert!(
        db.lock()
            .unwrap()
            .launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection
            .tools
            .is_empty(),
        "ready ACK is not activation"
    );
    tools.desire(&run, "B-invalid").unwrap();
    assert!(tools
        .ready(&run, "B-invalid", None, vec![a.clone(), b], || false)
        .is_err());
    // The publication owner restores its valid snapshot immediately after the rejected selection.
    tools.desire(&run, "A-restored").unwrap();
    assert!(tools
        .ready(&run, "A-restored", None, vec![a], || false)
        .unwrap());
    let selected = executor
        .select_for_request(&run, epoch, &CancellationToken::default())
        .unwrap()
        .unwrap();
    assert_eq!(selected.schemas.len(), 1);
    assert_eq!(selected.schemas[0].description, "Read A");
    assert_eq!(
        db.lock()
            .unwrap()
            .launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection
            .tools,
        selected.schemas
    );
    drop(executor);
    drop(tools);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
