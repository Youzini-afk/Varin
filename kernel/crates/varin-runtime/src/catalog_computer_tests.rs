use super::*;
use crate::execution::*;

#[test]
fn computer_scope_uses_active_branch_owner_not_auxiliary_runs() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    assert_eq!(
        db.computer_scope("thread", "main", None, None)
            .unwrap()
            .current_run_id,
        None
    );
    let run = db.submit(&command()).unwrap();
    let snapshot = request_snapshot(&run);
    let launch = launches::LaunchSelection::from_binding(
        &snapshot.view.binding,
        DefaultAgentPolicy.identity(),
        None,
    );
    let job = db
        .create_context_job(
            crate::context_job::ContextJobRequest {
            compaction: None,
            summary_recipe: varin_runtime::context_job::ContextSummaryRecipe::manual(),
                owner_run_id: None,
                personalization: None,
                key: "computer-auxiliary".into(),
                branch_id: "main".into(),
                through_id: run.input_id.clone(),
                expected_revision: 0,
                effective_system_prompt: "Summarize".into(),
                instruction_sources: vec![],
                memory_checkpoint: None,
            },
            launch,
            json!({}),
        )
        .unwrap();
    assert!(!db.run(&job.receipt.run_id).unwrap().state.terminal());
    assert_eq!(
        db.computer_scope("thread", "main", None, None)
            .unwrap()
            .current_run_id
            .as_deref(),
        Some(run.run_id.as_str())
    );
    let active = db.run(&run.run_id).unwrap();
    let active = db
        .transition_run(
            &active.id,
            active.epoch,
            active.revision,
            RunState::Runnable,
        )
        .unwrap();
    db.transition_run(
        &active.id,
        active.epoch,
        active.revision,
        RunState::Completed,
    )
    .unwrap();
    assert_eq!(
        db.computer_scope("thread", "main", None, None)
            .unwrap()
            .current_run_id,
        None
    );
    assert!(db.computer_scope("missing", "main", None, None).is_err());
}

#[test]
fn computer_scope_checks_original_model_and_policy_tool_origins_without_a_file_source() {
    for policy in [false, true] {
        let f = Fixture::new();
        let mut db = f.open();
        db.create_thread("thread", "main").unwrap();
        let launch: launches::LaunchSelection = serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture",
            "provider_family":"fixture","model":"model","configuration_generation":1,"tool_schema_generation":1,
            "tools":[{"name":"computer_act","version":"1","description":"Controlled input","output_schema":null,"metadata":null,"schema":{"type":"object"}}],
            "policy":{"name":"fixture","version":"1"},"source":null})).unwrap();
        let run = db
            .submit_with_launch(&command(), Some(launch.clone()))
            .unwrap();
        let active = db.run(&run.run_id).unwrap();
        db.transition_run(
            &active.id,
            active.epoch,
            active.revision,
            RunState::Runnable,
        )
        .unwrap();
        let epoch = db.epoch();
        let call = ToolCall {
            call_id: "input".into(),
            name: "computer_act".into(),
            schema_version: "1".into(),
            arguments: json!({"desktopId":"controlled"}),
        };
        let origin = if policy {
            let boundary = db.policy_boundary(&run.run_id, epoch).unwrap();
            let action_id = format!("{}:policy:{}", run.run_id, boundary.id);
            let origin = ToolOrigin::PolicyAction {
                action_id: action_id.clone(),
                node_id: call.call_id.clone(),
            };
            let context = FrozenToolContext { tool_output_visible_bytes: None, execution_environment: None, direct_tools: None,
                child_dispatch: None,
                resource_activations: vec![],
                resource_checkpoint_id: boundary.resource_checkpoint_id.clone(),
                run_id: run.run_id.clone(),
                origin: origin.clone(),
                tool_schema_generation: 1,
                tools: std::sync::Arc::new(launch.tools),
                source: None,
            };
            db.admit_policy_graph(
                &run.run_id,
                epoch,
                &PolicyGraphIntent::PolicyToolGraphV1 {
                    dispatch_history: None,
                    action_id,
                    boundary,
                    identity: launch.policy,
                    state: json!({}),
                    nodes: vec![PolicyAdmittedNode {
                        node: PolicyToolNode {
                            id: call.call_id.clone(),
                            depends_on: vec![],
                            call: call.clone(),
                        },
                        context,
                    }],
                },
            )
            .unwrap();
            origin
        } else {
            let mut snapshot = request_snapshot(&run);
            snapshot.view.binding.tools = launch.tools;
            independent_prepare(&mut db, &run, snapshot);
            db.commit_execution(
                &run.run_id,
                epoch,
                &ExecutionRecord::ModelFinished {
                    request_id: "model-1".into(),
                    outcome: ModelOutcome::Completed,
                    finish_reason: Some(FinishReason::ToolCalls),
                    items: vec![ProviderItem {
                        id: "item".into(),
                        content: Content::ToolCall { call: call.clone() },
                        opaque: None,
                    }],
                    interrupted_deltas: vec![],
                    usage: UsageReceipt::default(),
                    failure: None,
                },
            )
            .unwrap();
            ToolOrigin::ModelStep {
                request_id: "model-1".into(),
            }
        };
        let context = ToolExecutionContext {
            run_id: run.run_id.clone(),
            operation_id: origin.operation_id(&call.call_id),
            origin,
        };
        db.commit_execution(
            &run.run_id,
            epoch,
            &ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call,
                    contract: ToolContract {
                        name: "computer_act".into(),
                        schema_version: "1".into(),
                        read_only: false,
                        completion: CompletionKind::Result,
                        lifetime: Lifetime::Call,
                        resources: vec![],
                    },
                },
            },
        )
        .unwrap();
        assert!(db
            .computer_scope(
                "thread",
                "main",
                Some(&run.run_id),
                Some(&context.operation_id)
            )
            .is_err());
        db.commit_execution(
            &run.run_id,
            epoch,
            &ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: ExecutorOwner::External {
                    identity: "original-host".into(),
                    epoch: "helper-owner".into(),
                },
            },
        )
        .unwrap();
        let scope = db
            .computer_scope(
                "thread",
                "main",
                Some(&run.run_id),
                Some(&context.operation_id),
            )
            .unwrap();
        assert_eq!(scope.root_thread_id, "thread");
        assert!(scope.can_execute);
        assert_eq!(scope.current_run_id.as_deref(), Some(run.run_id.as_str()));
        assert!(db
            .computer_scope(
                "thread",
                "main",
                Some("foreign"),
                Some(&context.operation_id)
            )
            .is_err());
        assert!(db
            .launch_intent(&run.run_id)
            .unwrap()
            .unwrap()
            .selection
            .source
            .is_none());
    }
}
