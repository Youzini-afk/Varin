//! Original sampling inferences share the Goal dispatch and measured-usage ledger.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::mcp_sampling::{SamplingOutput, SamplingReceipt};
use varin_runtime::{
    catalog::{
        dispatch::ChildModelBinding,
        goals::*,
        launches::{HostToolBinding, LaunchSelection},
        mcp_interactions::*,
    },
    execution::*,
    *,
};
struct Directory(std::path::PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Fixture {
    root: std::path::PathBuf,
    db: Catalog,
    id: String,
    _directory: Directory,
}
fn commit(db: &mut Catalog, run: &str, record: ExecutionRecord) {
    db.commit_execution(run, db.epoch(), &record).unwrap();
}
fn fixture(budget: u64) -> Fixture {
    let root = std::env::temp_dir().join(format!("varin-sampling-goal-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "branch").unwrap();
    let config = json!({"providerFamily":"openai-responses","endpoint":"https://fixture.invalid","allowAnonymous":true,"model":"fixture","configurationGeneration":1});
    let model: ChildModelBinding =
        serde_json::from_value(json!({"configuration":config,"credential_scope":null})).unwrap();
    let connection = model.connection_identity().unwrap();
    let schemas:Vec<ToolSchema>=serde_json::from_value(json!([{"name":"mcp_subscribe_resource","version":"1","description":"Observe original resource","schema":{"type":"object","properties":{"server":{"type":"string"},"schemaVersion":{"type":"string"},"uri":{"type":"string"}},"required":["server","schemaVersion","uri"],"additionalProperties":false},"output_schema":null,"metadata":null}])).unwrap();
    let mcp:HostToolBinding=serde_json::from_value(json!({"reference":"mcp-owner","generation":1,"tools":schemas,"routes":{"mcp_subscribe_resource":{"kind":"resource_subscribe","argument":"server"}},"resources":{"server:peer":"mcp:peer"},"provenance":{"servers":{"peer":{"owner":{"source_authority":null,"resource_owner":{"kind":"local"},"configuration":{"agent_dir":"/fixture","config_cwd":"/fixture","project_trusted":false},"execution_scope":"workspace"},"definition_version":"configuration","resource_key":"mcp:peer"}}}})).unwrap();
    let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"mcp_binding":mcp,"connection_identity":connection,"provider_family":"openai-responses","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"policy":{"name":"fixture","version":"1"},"source":{"resource_owner":{"kind":"local"},"workspace_id":"workspace","execution_workspace_id":"workspace","mode":"live_root","live_root":{"hostId":"fixture","canonicalRoot":root,"rootId":"original-root"},"branch_id":null,"revision":null}})).unwrap();
    let receipt = db
        .submit_with_launch(
            &SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: None,
                input: json!("Observe during explicit goal"),
                configuration: config.clone(),
            },
            Some(launch),
        )
        .unwrap();
    let run = receipt.run_id;
    let prepared = db
        .prepare_child_dispatch_binding(&run, model, 1, schemas.clone())
        .unwrap()
        .load()
        .unwrap();
    let frozen = db.bind_child_dispatch(&run, prepared).unwrap();
    commit(
        &mut db,
        &run,
        ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    );
    let scope = GoalScope {
        thread_id: "thread".into(),
        branch_id: "branch".into(),
    };
    let goal = db
        .prepare_goal_start(
            "goal",
            &run,
            scope.clone(),
            "Observe original resource while goal remains authorized".into(),
            Some(GoalBudget {
                max_output_tokens: budget,
            }),
        )
        .unwrap()
        .load()
        .unwrap();
    db.admit_goal_mutation(goal).unwrap();
    let range = HistoryRange {
        branch_id: "branch".into(),
        ancestor_id: None,
        leaf_id: db.head("branch").unwrap(),
    };
    let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":frozen,"goal":db.goal_binding(&run).unwrap(),"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":connection,"provider_family":"openai-responses","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
    let call = ToolCall {
        call_id: "subscribe".into(),
        name: "mcp_subscribe_resource".into(),
        schema_version: "1".into(),
        arguments: json!({"server":"peer","schemaVersion":"service-1","uri":"opaque:resource"}),
    };
    commit(
        &mut db,
        &run,
        ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: "request".into(),
                    run_id: run.clone(),
                    origin: RequestOrigin::Conversation {
                        step: 0,
                        history_range: range,
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({}),
            }.into(),
        },
    );
    commit(
        &mut db,
        &run,
        ExecutionRecord::ModelDispatched {
            request_id: "request".into(),
        },
    );
    commit(
        &mut db,
        &run,
        ExecutionRecord::ModelFinished {
            request_id: "request".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "call-item".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                input_tokens: Some(3),
                output_tokens: Some(2),
                ..Default::default()
            },
            failure: None,
        },
    );
    let context = ToolExecutionContext {
        run_id: run.clone(),
        operation_id: "request:tool:subscribe".into(),
        origin: ToolOrigin::ModelStep {
            request_id: "request".into(),
        },
    };
    commit(
        &mut db,
        &run,
        ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call: call.clone(),
                contract: ToolContract {
                    name: call.name.clone(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: CompletionKind::Result,
                    lifetime: Lifetime::Thread,
                    resources: vec![ResourceClaim {
                        key: "mcp:peer".into(),
                        access: Access::Write,
                    }],
                },
            },
        },
    );
    let permission_call = json!({"runId":run,"operationId":context.operation_id,"origin":context.origin,"callId":call.call_id,"name":call.name,"schemaVersion":call.schema_version,"arguments":call.arguments});
    let permission_scope = json!({"ownerReference":"mcp-owner","ownerGeneration":1,"toolSchemaVersion":"1","policyGeneration":"original-policy","reason":"unknown MCP action"});
    let prepared = db
        .prepare_permission(permission_call.clone(), permission_scope.clone())
        .load()
        .unwrap();
    db.open_permission_prepared(&context.operation_id, "permission", prepared)
        .unwrap();
    assert!(
        db.operation(&context.operation_id)
            .unwrap()
            .mcp_resource_subscription
            .is_none()
    );
    db.decide_permission(&context.operation_id, "permission", "allow_once")
        .unwrap();
    let prepared = db
        .prepare_permission(permission_call, permission_scope)
        .load()
        .unwrap();
    db.consume_permission_prepared(&context.operation_id, "permission", prepared)
        .unwrap();
    let owner = ExecutorOwner::External {
        identity: "host".into(),
        epoch: "epoch".into(),
    };
    commit(
        &mut db,
        &run,
        ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: owner.clone(),
        },
    );
    let (snapshot, original) = db
        .capture_tool_invocation(&context, "subscribe")
        .unwrap()
        .load_mcp()
        .unwrap();

    let binding:McpInteractionBinding=serde_json::from_value(json!({"operationId":context.operation_id,"executionOwner":owner,"endpoint":{"server":"peer","resourceKey":"mcp:peer","configurationVersion":"configuration","credentialVersion":"grant"},"connectionId":"original-client","source":{"kind":"server_request","requestId":"sample:original","relation":{"kind":"rpc_response_stream","outgoingRequestId":7}}})).unwrap();
    let request = json!({"messages":[{"role":"user","content":{"type":"text","text":"Sample under explicit bounded Goal"}}],"maxTokens":32});
    let staged = db
        .prepare_result_content()
        .write_data(
            &json!({"request":request,"presentation":{"mode":"sampling","message":"Review"}}),
        )
        .unwrap();
    let opened = db
        .open_mcp_interaction(
            "sample:original".into(),
            binding.clone(),
            McpInteractionMode::Sampling,
            &staged,
            &snapshot,
            &original,
        )
        .unwrap();
    let config: ModelSessionConfiguration = serde_json::from_value(config).unwrap();
    let admission = db
        .prepare_sampling_content()
        .admission(request.clone(), &config)
        .unwrap();
    let admitted = db
        .admit_mcp_sampling(
            &context.operation_id,
            "sample:original",
            opened.revision,
            admission,
            None,
        )
        .unwrap();
    let id = admitted.sampling.unwrap().generation_operation_id.unwrap();
    let decoded = varin_runtime::mcp_sampling::decode_request(&request).unwrap();
    let selected = varin_runtime::model_session::bind(
        varin_runtime::mcp_sampling::configure(config, &decoded).unwrap(),
    )
    .unwrap();
    let view = varin_runtime::mcp_sampling::request_view(
        "sample:original",
        &id,
        &context.operation_id,
        &run,
        selected.binding,
        &decoded,
    )
    .unwrap();
    let serialized = selected.provider.serialize(&view).unwrap();
    let snapshot = RequestSnapshot { view, serialized };
    let body = db.prepare_sampling_content().snapshot(&snapshot).unwrap();
    db.prepare_mcp_sampling(
        &id,
        varin_runtime::mcp_sampling::SamplingModel {
            provider_id: None,
            provider_family: "openai-responses".into(),
            model: "fixture".into(),
            max_tokens: 32,
        },
        body,
    )
    .unwrap();

    assert_eq!(
        db.operation(&id).unwrap().intent["goal"],
        json!({"id":"goal","generation":1})
    );
    Fixture {
        _directory: Directory(root.clone()),
        root,
        db,
        id,
    }
}
fn goal(f: &Fixture) -> Goal {
    f.db.capture_goal("goal").unwrap().load().unwrap()
}
fn actual() -> UsageReceipt {
    UsageReceipt {
        measurement: UsageMeasurement::Actual,
        input_tokens: Some(100),
        output_tokens: Some(9),
        cached_input_tokens: Some(4),
        cache_write_tokens: Some(5),
        reasoning_tokens: Some(6),
        raw: Some(json!({"largeProviderOriginal":"原".repeat(20000)})),
        ..Default::default()
    }
}
fn settle(f: &mut Fixture, usage: UsageReceipt) {
    let output = SamplingOutput {
        usage: usage.clone(),
        ..Default::default()
    };
    let receipt = SamplingReceipt {
        finish_reason: Some(FinishReason::Stop),
        failure: None,
        usage,
        provider_completed: true,
        local_executor_stopped: true,
        usable: true,
    };
    let body=f.db.prepare_sampling_content().output(&output,Some(&receipt),Some(&json!({"role":"assistant","model":"fixture","content":{"type":"text","text":"Sampled"}}))).unwrap();
    f.db.settle_mcp_sampling(&f.id, body, &receipt).unwrap();
}
#[test]
fn exhausted_original_goal_prevents_sampling_dispatch_and_adds_no_usage() {
    let mut f = fixture(2);
    assert_eq!(goal(&f).state, GoalState::BudgetLimited);
    assert!(matches!(
        f.db.dispatch_mcp_sampling(&f.id),
        Err(RuntimeError::GoalChanged)
    ));
    let after = goal(&f);
    assert_eq!(after.usage.pending_inferences, 0);
    assert_eq!(after.usage.actual.inferences, 1);
    assert_eq!(after.usage.actual.output_tokens.known, 2);
    assert_eq!(f.db.operation(&f.id).unwrap().effect, Effect::None);
}
#[test]
fn sampling_actual_usage_is_measured_once_on_the_existing_goal() {
    let mut f = fixture(200);
    f.db.dispatch_mcp_sampling(&f.id).unwrap();
    assert_eq!(goal(&f).usage.pending_inferences, 1);
    settle(&mut f, actual());
    settle(&mut f, actual());
    let after = goal(&f);
    assert_eq!(after.usage.pending_inferences, 0);
    assert_eq!(after.usage.actual.inferences, 2);
    assert_eq!(after.usage.actual.output_tokens.known, 11);
    assert_eq!(after.usage.actual.cache_write_tokens.known, 5);
    assert_eq!(after.usage.actual.reasoning_tokens.known, 6);
    let before = serde_json::to_value(after.usage).unwrap();
    // Reopen recovery must not charge a terminal generation for a second time.
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(serde_json::to_value(goal(&f).usage).unwrap(), before);
}
#[test]
fn recovery_measures_only_durable_short_sampling_usage_and_never_replays() {
    for checkpoint in [false, true] {
        let mut f = fixture(200);
        f.db.dispatch_mcp_sampling(&f.id).unwrap();
        if checkpoint {
            let usage = actual();
            let output = SamplingOutput {
                usage: usage.clone(),
                ..Default::default()
            };
            let body =
                f.db.prepare_sampling_content()
                    .output(&output, None, None)
                    .unwrap();
            f.db.checkpoint_mcp_sampling(&f.id, body, &usage).unwrap();
            let op = f.db.operation(&f.id).unwrap();
            assert!(
                !serde_json::to_string(&op)
                    .unwrap()
                    .contains("largeProviderOriginal")
            );
        }
        let root = f.root.clone();
        drop(f.db);
        f.db = Catalog::open(&root).unwrap();
        let after = goal(&f);
        assert_eq!(after.usage.pending_inferences, 0);
        assert_eq!(
            after.usage.actual.inferences,
            if checkpoint { 2 } else { 1 }
        );
        assert_eq!(
            after.usage.actual.output_tokens.known,
            if checkpoint { 11 } else { 2 }
        );
        assert_eq!(
            after.usage.missing_inferences,
            if checkpoint { 0 } else { 1 }
        );
        let op = f.db.operation(&f.id).unwrap();
        assert_eq!(op.phase, OperationPhase::Terminal);
        assert_eq!(op.outcome, Some(Outcome::Indeterminate));
        assert!(f.db.dispatch_mcp_sampling(&f.id).is_err());
        let before = serde_json::to_value(after.usage).unwrap();
        drop(f.db);
        f.db = Catalog::open(&root).unwrap();
        assert_eq!(serde_json::to_value(goal(&f).usage).unwrap(), before);
    }
}
