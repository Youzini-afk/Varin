//! Actual Catalog admission, inference receipts, cancellation, collection and reopen.
//! Provider transport is not simulated: these tests exercise the native owner boundaries.
use super::delegation_model::{Choice, CommitParams, PrepareParams, SelectionView};
use super::inference::generation::InferenceGenerateParams;
use super::inference::*;
use super::*;
use crate::execution::*;
use crate::test_submission::InputAdmission;
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-delegation-model-{}", id())))
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn owner(epoch: &str) -> ExecutorOwner {
    ExecutorOwner::External {
        identity: "selection-host".into(),
        epoch: epoch.into(),
    }
}
fn configuration(model: &str, thinking: &str) -> ModelSessionConfiguration {
    serde_json::from_value(json!({"providerId":"channel", "providerFamily":"openai-responses", "model":model,
        "catalogModelId":model,"endpoint":"https://example.invalid/responses", "allowAnonymous":true,
        "configurationGeneration":1,"maxOutputTokens":100,"thinkingLevel":thinking})).unwrap()
}
fn child(db: &mut Catalog, _operation: &str, with_goal: bool) -> collaboration::ChildTask {
    db.create_thread("thread", "main").unwrap();
    let model = dispatch::ChildModelBinding {
        configuration: configuration("parent", "medium"),
        credential_scope: None,
    };
    let receipt = db
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"Keep this actual task context."}),
            configuration: serde_json::to_value(&model.configuration).unwrap(),
        })
        .unwrap();
    if with_goal {
        let p = db
            .prepare_goal_start(
                "goal",
                &receipt.run_id,
                goals::GoalScope {
                    thread_id: "thread".into(),
                    branch_id: "main".into(),
                },
                "Finish the delegated work".into(),
                Some(goals::GoalBudget {
                    max_output_tokens: 1000,
                }),
            )
            .unwrap()
            .load()
            .unwrap();
        db.admit_goal_mutation(p).unwrap();
    }
    let schema = ToolSchema {
        name: "dispatch".into(),
        version: "7".into(),
        description: "Dispatch".into(),
        schema: json!({"type":"object","properties":{"task":{"type":"string"}},"required":["task"],"additionalProperties":false}),
        requirements: None,
        output_schema: None,
        metadata: None,
    };
    let catalog: dispatch::ChildDispatchCatalog = serde_json::from_value(json!({"identity":"catalog", "projects":[],"presets":[],"normal_unavailable":null,"native_capabilities":[],"model_selection_preparation":true})).unwrap();
    let bound = crate::model_session::bind(model.configuration.clone()).unwrap();
    let mut binding = bound.binding;
    binding.tool_schema_generation = 1;
    binding.goal = db.goal_binding(&receipt.run_id).unwrap();
    binding.tools = vec![schema.clone()];
    binding.history_range = HistoryRange {
        branch_id: "main".into(),
        ancestor_id: None,
        leaf_id: Some(receipt.input_id.clone()),
    };
    let mut launch =
        launches::LaunchSelection::from_binding(&binding, bound.policy.identity(), None);
    launch.child_dispatch = Some(catalog);
    db.bind_launch(&receipt.run_id, launch.clone()).unwrap();
    let p = db
        .prepare_child_dispatch_binding(&receipt.run_id, model, 1, Vec::new())
        .unwrap()
        .load()
        .unwrap();
    binding.child_dispatch = db.bind_child_dispatch(&receipt.run_id, p).unwrap();
    let epoch = db.epoch();
    db.transition_run(&receipt.run_id, epoch, 1, RunState::Runnable)
        .unwrap();
    let snapshot = RequestSnapshot {
        view: RequestView {
            request_id: "request".into(),
            run_id: receipt.run_id.clone(),
            origin: RequestOrigin::Conversation {
                compaction: None,
                step: 1,
                history_range: binding.history_range.clone(),
            },
            binding,
            history: Vec::new(),
        },
        serialized: json!({"model":"parent"}).into(),
    };
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared {
            snapshot: snapshot.into(),
        },
    )
    .unwrap();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "request".into(),
        },
    )
    .unwrap();
    let call = ToolCall {
        call_id: "delegate".into(),
        name: "dispatch".into(),
        schema_version: "7".into(),
        arguments: json!({"task":"Inspect the original source."}),
    };
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "request".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "delegate-call".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: Vec::new(),
            failure: None,
            usage: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                input_tokens: Some(0),
                output_tokens: Some(0),
                ..Default::default()
            },
        },
    )
    .unwrap();
    let context = ToolExecutionContext {
        run_id: receipt.run_id.clone(),
        operation_id: "request:tool:delegate".into(),
        origin: ToolOrigin::ModelStep {
            request_id: "request".into(),
        },
    };
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call: call.clone(),
                contract: ToolContract {
                    name: "dispatch".into(),
                    schema_version: "7".into(),
                    read_only: true,
                    completion: CompletionKind::Job,
                    lifetime: Lifetime::Thread,
                    resources: Vec::new(),
                },
            },
        },
    )
    .unwrap();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: ExecutorOwner::Kernel,
        },
    )
    .unwrap();
    let input: dispatch::DispatchInput = serde_json::from_value(call.arguments).unwrap();
    let selected = db
        .capture_child_dispatch_invocation(&context)
        .unwrap()
        .load()
        .unwrap()
        .resolve(&input)
        .unwrap();
    launch.tools.clear();
    let p = db
        .prepare_child_launch(&receipt.run_id, launch, selected)
        .unwrap()
        .load()
        .unwrap();
    let p = db
        .prepare_child_admission(&context, input, None, p)
        .unwrap()
        .load()
        .unwrap();
    let child = db.accept_child_references(p).unwrap();
    let completion = db
        .operation(&context.operation_id)
        .unwrap()
        .call_completion
        .unwrap()
        .load(&db.content)
        .unwrap();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::ToolBatchCommitted {
            request_id: "request".into(),
            results: vec![ToolResult {
                request_id: "request".into(),
                call_id: "delegate".into(),
                completion,
            }],
        },
    )
    .unwrap();
    child
}
fn selection_catalog(operation: &str) -> delegation_model::SelectionCatalog {
    serde_json::from_value(json!({"candidates":[{"id":"execution","providerId":"channel","modelId":"worker","configurationFingerprint":"worker-v1","thinkingLevels":["low","high"],"defaultThinkingLevel":"low","input":["text"],"name":"Worker","channelName":"Channel"}],
        "selector":{"providerId":"channel","modelId":"selector","operation":operation,"configurationFingerprint":"selector-v1","thinkingLevel":"medium"}})).unwrap()
}
fn prepare(db: &mut Catalog, execution: &str, executor: ExecutorOwner) -> SelectionView {
    prepare_kind(db, execution, executor, "chat")
}
fn prepare_kind(
    db: &mut Catalog,
    execution: &str,
    executor: ExecutorOwner,
    operation: &str,
) -> SelectionView {
    let p = db
        .capture_delegation_model(PrepareParams {
            execution_id: execution.into(),
            execution_owner: executor.clone(),
            catalog: Some(selection_catalog(operation)),
        })
        .unwrap()
        .load()
        .unwrap();
    let id = db.admit_delegation_model(p, executor).unwrap();
    db.read_delegation_model(&id).unwrap().load().unwrap()
}
fn generation(work: &SelectionView) -> InferenceGenerateParams {
    InferenceGenerateParams {
        parent_operation_id: work.operation_id.clone(),
        caller_owner: work.execution_owner.clone(),
        ordinal: 1,
        configuration: configuration("selector", "medium"),
        credential_scope: serde_json::from_value(
            json!({"reference":"fixture","authority":"fixture","account":"fixture","generation":1}),
        )
        .unwrap(),
        purpose: "delegation-model-selection".into(),
        system_prompt: "Select exactly one frozen choice".into(),
        user: serde_json::to_string(&work.recipe).unwrap(),
    }
}
fn admit_generation(db: &mut Catalog, request: &InferenceGenerateParams) -> String {
    let body = db
        .prepare_inference_content()
        .write(&serde_json::to_value(request).unwrap())
        .unwrap();
    db.admit_inference_generation(request, body)
        .unwrap()
        .operation_id
}
fn receipt(problem: Option<InferenceProblem>) -> InferenceReceipt {
    InferenceReceipt {
        request_started: Some(true),
        provider_completed: matches!(
            problem,
            None | Some(InferenceProblem::HttpRejected | InferenceProblem::InvalidResponse)
        ),
        local_executor_stopped: true,
        usage: InferenceUsage {
            measurement: UsageMeasurement::Actual,
            input_tokens: Some(11),
            output_tokens: Some(7),
            ..Default::default()
        },
        http_status: Some(if problem.is_some() { 503 } else { 200 }),
        problem,
    }
}
fn settle_generation(db: &mut Catalog, inference: &str) {
    let response = json!({"text":"{\"model\":\"execution\",\"thinking\":\"high\"}","providerOutput":{"finishReason":"stop"}});
    let body = db.prepare_inference_content().write(&response).unwrap();
    db.settle_inference_generation(inference, body, receipt(None), None)
        .unwrap();
}
fn commit(db: &mut Catalog, execution: &str, executor: ExecutorOwner) -> Result<()> {
    commit_choice(db, execution, executor, "high")
}
fn commit_choice(
    db: &mut Catalog,
    execution: &str,
    executor: ExecutorOwner,
    thinking: &str,
) -> Result<()> {
    let p = db
        .prepare_delegation_model_commit(CommitParams {
            execution_id: execution.into(),
            execution_owner: executor,
            choice: Choice {
                model: "execution".into(),
                thinking: thinking.into(),
            },
            binding: dispatch::ChildModelBinding {
                configuration: configuration("worker", thinking),
                credential_scope: None,
            },
        })?
        .load()?;
    db.commit_delegation_model(p)
}

#[test]
fn selector_inference_is_independent_accounts_usage_and_reopens_original_response() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", true);
    let work = prepare(&mut db, &child.execution_id, owner("first"));
    let request = generation(&work);
    let inference = admit_generation(&mut db, &request);
    assert!(db.operation(&inference).unwrap().handed_off);
    db.dispatch_inference_generation(&inference).unwrap();
    db.commit_execution(
        &child.parent_run_id,
        db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    settle_generation(&mut db, &inference);
    let goal = db.capture_goal("goal").unwrap().load().unwrap();
    assert_eq!(goal.usage.actual.output_tokens.known, 7);
    assert_eq!(goal.usage.pending_inferences, 0);
    let report = db.prepare_content_collection(Default::default()).run();
    assert_eq!(
        report.status,
        ContentCollectionStatus::Completed,
        "{report:?}"
    );
    drop(db);
    let mut db = f.open();
    let recovered = prepare(&mut db, &child.execution_id, owner("second"));
    assert_eq!(recovered.inference.len(), 1);
    assert_eq!(recovered.inference[0].outcome, Some(Outcome::Succeeded));
    commit(&mut db, &child.execution_id, owner("second")).unwrap();
    commit(&mut db, &child.execution_id, owner("second")).unwrap();
    let actual = db
        .capture_delegated_execution(db.delegated_execution(&child.execution_id).unwrap())
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(actual.configuration["model"], "worker");
    assert_eq!(actual.configuration["thinkingLevel"], "high");
    let body = db
        .prepare_inference_content()
        .write(&serde_json::to_value(&request).unwrap())
        .unwrap();
    assert!(db.admit_inference_generation(&request, body).is_err());
}

#[test]
fn child_tree_cancellation_stops_selection_without_erasing_late_usage() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", false);
    let work = prepare(&mut db, &child.execution_id, owner("first"));
    let inference = admit_generation(&mut db, &generation(&work));
    db.dispatch_inference_generation(&inference).unwrap();
    db.cancel_tree(dispatch::TreeCancelTarget::Child {
        operation_id: child.operation_id.clone(),
    })
    .unwrap();
    assert!(db.operation(&inference).unwrap().cancel_requested);
    assert!(!db.inference_generation_live(&inference).unwrap());
    settle_generation(&mut db, &inference);
    assert!(commit(&mut db, &child.execution_id, owner("first")).is_err());
    let actual = db.delegated_execution(&child.execution_id).unwrap();
    assert!(actual.receipt.is_none());
    assert_eq!(actual.report.unwrap().outcome, Outcome::Cancelled);
    assert_eq!(
        db.operation(&inference)
            .unwrap()
            .result
            .unwrap()
            .control()
            .unwrap()["receipt"]["usage"]["outputTokens"],
        7
    );
}

#[test]
fn interrupted_paid_selection_is_not_replayed_or_relabelled_successful() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", false);
    let work = prepare(&mut db, &child.execution_id, owner("first"));
    let request = generation(&work);
    let inference = admit_generation(&mut db, &request);
    db.dispatch_inference_generation(&inference).unwrap();
    drop(db);
    let mut db = f.open();
    let work = prepare(&mut db, &child.execution_id, owner("second"));
    assert_eq!(work.inference.len(), 1);
    assert_eq!(work.inference[0].outcome, Some(Outcome::Indeterminate));
    assert_eq!(work.inference[0].effect, Effect::Unknown);
    assert!(commit(&mut db, &child.execution_id, owner("second")).is_err());
    let next = generation(&work);
    let body = db
        .prepare_inference_content()
        .write(&serde_json::to_value(&next).unwrap())
        .unwrap();
    assert!(db.admit_inference_generation(&next, body).is_err());
}

#[test]
fn execution_binding_requires_original_successful_choice_not_just_an_allowed_choice() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", false);
    let original_configuration = child.configuration_ref.clone();
    let work = prepare(&mut db, &child.execution_id, owner("first"));
    assert!(commit(&mut db, &child.execution_id, owner("first")).is_err());
    let inference = admit_generation(&mut db, &generation(&work));
    assert!(commit(&mut db, &child.execution_id, owner("first")).is_err());
    db.dispatch_inference_generation(&inference).unwrap();
    assert!(commit(&mut db, &child.execution_id, owner("first")).is_err());
    settle_generation(&mut db, &inference);
    assert!(commit_choice(&mut db, &child.execution_id, owner("first"), "low").is_err());
    assert_eq!(
        db.delegated_execution(&child.execution_id)
            .unwrap()
            .configuration_ref,
        original_configuration
    );
    commit(&mut db, &child.execution_id, owner("first")).unwrap();
}

#[test]
fn parent_run_cancellation_does_not_cancel_accepted_child_selection() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", false);
    let work = prepare(&mut db, &child.execution_id, owner("first"));
    let inference = admit_generation(&mut db, &generation(&work));
    db.request_cancel_run(&child.parent_run_id).unwrap();
    assert!(!db.operation(&inference).unwrap().cancel_requested);
    assert!(db.inference_generation_live(&inference).unwrap());
}

#[test]
fn paused_original_goal_holds_selection_preparation_and_blocks_paid_entry() {
    let scope = goals::GoalScope {
        thread_id: "thread".into(),
        branch_id: "main".into(),
    };
    for captured in [false, true] {
        let f = Fixture::new();
        let mut db = f.open();
        let child = child(&mut db, "chat", true);
        let params = PrepareParams {
            execution_id: child.execution_id.clone(),
            execution_owner: owner("first"),
            catalog: Some(selection_catalog("chat")),
        };
        let prepared = captured.then(|| {
            db.capture_delegation_model(params.clone())
                .unwrap()
                .load()
                .unwrap()
        });
        db.control_goal("goal", 1, &scope, goals::GoalControlAction::Pause)
            .unwrap();
        let error = if let Some(prepared) = prepared {
            db.admit_delegation_model(prepared, owner("first"))
                .err()
                .unwrap()
        } else {
            db.capture_delegation_model(params).err().unwrap()
        };
        assert!(matches!(error, RuntimeError::RequestActivationHeld));
        assert!(
            db.find_delegation_model(&child.execution_id)
                .unwrap()
                .is_none()
        );
        db.control_goal("goal", 2, &scope, goals::GoalControlAction::Resume)
            .unwrap();
        let work = prepare(&mut db, &child.execution_id, owner("first"));
        let inference = admit_generation(&mut db, &generation(&work));
        db.control_goal("goal", 3, &scope, goals::GoalControlAction::Pause)
            .unwrap();
        assert!(db.dispatch_inference_generation(&inference).is_err());
        assert_eq!(db.operation(&inference).unwrap().effect, Effect::None);
        assert_eq!(
            db.capture_goal("goal")
                .unwrap()
                .load()
                .unwrap()
                .usage
                .pending_inferences,
            0
        );
        db.control_goal("goal", 4, &scope, goals::GoalControlAction::Resume)
            .unwrap();
        assert_eq!(
            db.capture_inference_generation(&inference)
                .unwrap()
                .goal
                .unwrap()
                .generation,
            1
        );
        db.dispatch_inference_generation(&inference).unwrap();
        settle_generation(&mut db, &inference);
        assert_eq!(
            db.capture_goal("goal")
                .unwrap()
                .load()
                .unwrap()
                .usage
                .actual
                .output_tokens
                .known,
            7
        );
    }
}

#[test]
fn ended_or_replaced_goal_cannot_authorize_original_delegated_selection() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", true);
    let work = prepare(&mut db, &child.execution_id, owner("first"));
    let inference = admit_generation(&mut db, &generation(&work));
    let scope = goals::GoalScope {
        thread_id: "thread".into(),
        branch_id: "main".into(),
    };
    db.control_goal("goal", 1, &scope, goals::GoalControlAction::Complete)
        .unwrap();
    let params = PrepareParams {
        execution_id: child.execution_id.clone(),
        execution_owner: owner("first"),
        catalog: None,
    };
    assert!(matches!(
        db.capture_delegation_model(params.clone()),
        Err(RuntimeError::RequestActivationHeld)
    ));
    assert!(db.dispatch_inference_generation(&inference).is_err());
    let next = db
        .prepare_goal_start(
            "replacement-goal",
            &child.parent_run_id,
            scope,
            "Unrelated next objective".into(),
            None,
        )
        .unwrap()
        .load()
        .unwrap();
    db.admit_goal_mutation(next).unwrap();
    assert!(matches!(
        db.capture_delegation_model(params),
        Err(RuntimeError::RequestActivationHeld)
    ));
    assert!(db.dispatch_inference_generation(&inference).is_err());
    assert_eq!(db.operation(&inference).unwrap().effect, Effect::None);
    assert_eq!(
        db.capture_inference_generation(&inference)
            .unwrap()
            .goal
            .unwrap()
            .id,
        "goal"
    );
    assert_eq!(
        db.capture_goal("replacement-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage
            .pending_inferences,
        0
    );
}

#[test]
fn pause_before_first_selector_request_holds_without_publishing_and_resumes_same_root() {
    for operation in ["chat", "decision"] {
        let f = Fixture::new();
        let mut db = f.open();
        let child = child(&mut db, operation, true);
        let work = prepare_kind(&mut db, &child.execution_id, owner("first"), operation);
        let original = db.operation(&work.operation_id).unwrap();
        let native = generation(&work);
        let mut http = InferenceAdmitParams {
            parent_operation_id: work.operation_id.clone(),
            execution_owner: work.execution_owner.clone(),
            ordinal: 1,
            binding: InferenceBinding {
                request_kind: InferenceRequestKind::Preparation,
                purpose: "delegation-model-selection".into(),
                provider_id: "channel".into(),
                model_id: "selector".into(),
                configuration_id: "selector-connection".into(),
                executor: InferenceExecutor::Http {
                    api: "llama-cpp-classify".into(),
                    endpoint: "https://example.invalid/tokenize".into(),
                    credential_scope: native.credential_scope.clone(),
                },
                pricing: None,
            },
            request: json!({"input":{"purpose":"delegation-model-selection","goal":"Original task","questions":["execution"]},"wire":{"route":"tokenize"}}),
        };
        let admit = |db: &mut Catalog, http: &InferenceAdmitParams| {
            if operation == "chat" {
                let body = db
                    .prepare_inference_content()
                    .write(&serde_json::to_value(&native).unwrap())
                    .unwrap();
                db.admit_inference_generation(&native, body)
            } else {
                let body = db.prepare_inference_content().write(&http.request).unwrap();
                db.admit_inference(http, body)
            }
        };
        let scope = goals::GoalScope {
            thread_id: "thread".into(),
            branch_id: "main".into(),
        };
        db.control_goal("goal", 1, &scope, goals::GoalControlAction::Pause)
            .unwrap();
        let cursor = db.events_after(0, u32::MAX).unwrap().last().unwrap().cursor;
        assert!(matches!(
            admit(&mut db, &http),
            Err(RuntimeError::RequestActivationHeld)
        ));
        assert_eq!(db.operation(&work.operation_id).unwrap(), original);
        assert!(db.events_after(cursor, u32::MAX).unwrap().is_empty());
        let held = db
            .read_delegation_model(&work.operation_id)
            .unwrap()
            .load()
            .unwrap();
        assert!(held.inference.is_empty());
        let usage = db.capture_goal("goal").unwrap().load().unwrap().usage;
        assert_eq!(usage.pending_inferences, 0);
        assert_eq!(usage.actual.output_tokens.known, 0);

        db.control_goal("goal", 2, &scope, goals::GoalControlAction::Resume)
            .unwrap();
        let accepted = admit(&mut db, &http).unwrap();
        assert_eq!(
            accepted.operation_id,
            format!("inference:{}:1", work.operation_id)
        );
        assert_eq!(
            db.read_delegation_model(&work.operation_id)
                .unwrap()
                .load()
                .unwrap()
                .inference
                .len(),
            1
        );
        assert_eq!(
            db.operation(&accepted.operation_id).unwrap().effect,
            Effect::None
        );
        if operation == "decision" {
            // Once a real preparation request exists, a later pause cannot disguise
            // an interrupted request chain as a fresh, transparently resumable hold.
            db.control_goal("goal", 3, &scope, goals::GoalControlAction::Pause)
                .unwrap();
            http.ordinal = 2;
            assert!(matches!(
                admit(&mut db, &http),
                Err(RuntimeError::GoalChanged)
            ));
            assert_eq!(
                db.read_delegation_model(&work.operation_id)
                    .unwrap()
                    .load()
                    .unwrap()
                    .inference
                    .len(),
                1
            );
        }
    }
}

#[test]
fn decision_preparation_retries_keep_original_input_and_cannot_repeat_success() {
    for problem in [
        InferenceProblem::HttpRejected,
        InferenceProblem::TransportFailed,
    ] {
        let f = Fixture::new();
        let mut db = f.open();
        let child = child(&mut db, "decision", false);
        let work = prepare_kind(&mut db, &child.execution_id, owner("first"), "decision");
        let mut p = InferenceAdmitParams {
            parent_operation_id: work.operation_id.clone(),
            execution_owner: work.execution_owner.clone(),
            ordinal: 1,
            binding: InferenceBinding {
                request_kind: InferenceRequestKind::Preparation,
                purpose: "delegation-model-selection".into(),
                provider_id: "channel".into(),
                model_id: "selector".into(),
                configuration_id: "selector-connection".into(),
                executor: InferenceExecutor::Http {
                    api: "llama-cpp-classify".into(),
                    endpoint: "https://example.invalid/tokenize".into(),
                    credential_scope: generation(&work).credential_scope,
                },
                pricing: None,
            },
            request: json!({"input":{"purpose":"delegation-model-selection","goal":"Original task","questions":["execution"]},"wire":{"route":"tokenize"}}),
        };
        let body = db.prepare_inference_content().write(&p.request).unwrap();
        let preparation = db.admit_inference(&p, body).unwrap();
        p.ordinal = 2;
        p.request["input"]["goal"] = json!("changed");
        let body = db.prepare_inference_content().write(&p.request).unwrap();
        assert!(db.admit_inference(&p, body).is_err());
        p.request["input"]["goal"] = json!("Original task");
        p.binding.request_kind = InferenceRequestKind::ModelCompute;
        if let InferenceExecutor::Http { endpoint, .. } = &mut p.binding.executor {
            *endpoint = "https://example.invalid/completion".into();
        }
        let body = db.prepare_inference_content().write(&p.request).unwrap();
        let first = db.admit_inference(&p, body).unwrap();
        db.dispatch_inference(&InferenceOwnerParams {
            operation_id: first.operation_id.clone(),
            execution_owner: p.execution_owner.clone(),
        })
        .unwrap();
        let response = json!({"bodyBase64":"e30="});
        let body = db.prepare_inference_content().write(&response).unwrap();
        db.settle_inference(
            &InferenceSettleParams {
                operation_id: first.operation_id,
                execution_owner: p.execution_owner.clone(),
                receipt: receipt(Some(problem)),
                response: response.clone(),
            },
            body,
        )
        .unwrap();
        p.ordinal = 3;
        let body = db.prepare_inference_content().write(&p.request).unwrap();
        let retry = db.admit_inference(&p, body).unwrap();
        db.dispatch_inference(&InferenceOwnerParams {
            operation_id: retry.operation_id.clone(),
            execution_owner: p.execution_owner.clone(),
        })
        .unwrap();
        let body = db.prepare_inference_content().write(&response).unwrap();
        db.settle_inference(
            &InferenceSettleParams {
                operation_id: retry.operation_id,
                execution_owner: p.execution_owner.clone(),
                receipt: receipt(None),
                response,
            },
            body,
        )
        .unwrap();
        p.ordinal = 4;
        let body = db.prepare_inference_content().write(&p.request).unwrap();
        assert!(db.admit_inference(&p, body).is_err());
        assert!(commit(&mut db, &child.execution_id, owner("first")).is_err());
        db.dispatch_inference(&InferenceOwnerParams {
            operation_id: preparation.operation_id.clone(),
            execution_owner: p.execution_owner.clone(),
        })
        .unwrap();
        let response = json!({"bodyBase64":"e30="});
        let body = db.prepare_inference_content().write(&response).unwrap();
        db.settle_inference(
            &InferenceSettleParams {
                operation_id: preparation.operation_id,
                execution_owner: p.execution_owner.clone(),
                receipt: InferenceReceipt {
                    usage: InferenceUsage::default(),
                    ..receipt(None)
                },
                response,
            },
            body,
        )
        .unwrap();
        commit(&mut db, &child.execution_id, owner("first")).unwrap();
    }
}

#[test]
fn cancellation_between_recipe_capture_and_admission_cannot_start_selection() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", false);
    let preparation = db
        .capture_delegation_model(PrepareParams {
            execution_id: child.execution_id.clone(),
            execution_owner: owner("first"),
            catalog: Some(selection_catalog("chat")),
        })
        .unwrap();
    db.cancel_tree(dispatch::TreeCancelTarget::Child {
        operation_id: child.operation_id.clone(),
    })
    .unwrap();
    let prepared = preparation.load().unwrap();
    assert!(db.admit_delegation_model(prepared, owner("first")).is_err());
    assert!(
        db.find_delegation_model(&child.execution_id)
            .unwrap()
            .is_none()
    );
    assert!(
        db.delegated_execution(&child.execution_id)
            .unwrap()
            .receipt
            .is_none()
    );
}

#[test]
fn native_selection_rejects_unfrozen_model_thinking_and_extra_request() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", false);
    let work = prepare(&mut db, &child.execution_id, owner("first"));
    for changed in 0..4 {
        let mut request = generation(&work);
        match changed {
            0 => request.configuration.provider_id = Some("another-channel".into()),
            1 => request.configuration.catalog_model_id = Some("another-model".into()),
            2 => request.configuration.thinking_level = Some("high".into()),
            _ => request.ordinal = 2,
        }
        let body = db
            .prepare_inference_content()
            .write(&serde_json::to_value(&request).unwrap())
            .unwrap();
        assert!(db.admit_inference_generation(&request, body).is_err());
    }
    assert!(
        db.read_delegation_model(&work.operation_id)
            .unwrap()
            .load()
            .unwrap()
            .inference
            .is_empty()
    );
    admit_generation(&mut db, &generation(&work));
}

#[test]
fn disabled_selection_commits_original_parent_binding_without_inference() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", false);
    let before = child.configuration_ref.clone();
    let p = db
        .capture_delegation_model(PrepareParams {
            execution_id: child.execution_id.clone(),
            execution_owner: owner("first"),
            catalog: Some(delegation_model::SelectionCatalog {
                candidates: Vec::new(),
                selector: None,
            }),
        })
        .unwrap()
        .load()
        .unwrap();
    let id = db.admit_delegation_model(p, owner("first")).unwrap();
    let work = db.read_delegation_model(&id).unwrap().load().unwrap();
    assert!(work.inference.is_empty());
    assert!(work.recipe.catalog.candidates.is_empty());
    let binding = work.recipe.inherited_binding.unwrap();
    assert_eq!(
        binding.configuration.thinking_level.as_deref(),
        Some("medium")
    );
    let p = db
        .prepare_delegation_model_commit(CommitParams {
            execution_id: child.execution_id.clone(),
            execution_owner: owner("first"),
            choice: work.recipe.choices[0].clone(),
            binding,
        })
        .unwrap()
        .load()
        .unwrap();
    db.commit_delegation_model(p).unwrap();
    assert_eq!(
        db.delegated_execution(&child.execution_id)
            .unwrap()
            .configuration_ref,
        before
    );
}

#[test]
fn repeated_preparation_does_not_replace_the_accepted_selector_recipe() {
    let f = Fixture::new();
    let mut db = f.open();
    let child = child(&mut db, "chat", false);
    let original = prepare(&mut db, &child.execution_id, owner("first"));
    let mut changed = selection_catalog("decision");
    changed.candidates[0].configuration_fingerprint = "changed-model".into();
    let p = db
        .capture_delegation_model(PrepareParams {
            execution_id: child.execution_id.clone(),
            execution_owner: owner("first"),
            catalog: Some(changed),
        })
        .unwrap()
        .load()
        .unwrap();
    db.admit_delegation_model(p, owner("first")).unwrap();
    let actual = db
        .read_delegation_model(&original.operation_id)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(actual.recipe.catalog, original.recipe.catalog);
    assert_eq!(actual.recipe.choices, original.recipe.choices);
}

#[test]
fn standalone_v82_selection_assets_upgrade_without_replaying_paid_work() {
    for completed in [false, true] {
        let f = Fixture::new();
        let mut db = f.open();
        let child = child(&mut db, "chat", true);
        let work = prepare(&mut db, &child.execution_id, owner("first"));
        let inference = admit_generation(&mut db, &generation(&work));
        db.dispatch_inference_generation(&inference).unwrap();
        if completed {
            settle_generation(&mut db, &inference);
            commit(&mut db, &child.execution_id, owner("first")).unwrap();
        }
        let before = db.operation(&inference).unwrap();
        let root_before = db.operation(&work.operation_id).unwrap();
        let execution_before = db.delegated_execution(&child.execution_id).unwrap();
        drop(db);
        let raw = Connection::open(f.0.join("conversation.sqlite")).unwrap();
        assert_eq!(
            raw.query_row(
                "SELECT count(*) FROM context_observation_captures",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            raw.query_row(
                "SELECT count(*) FROM context_observation_imports",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        // Exact standalone82 layout, not a combined store with a different label.
        // These native child/inference APIs are the original82 owners; only Zone2
        // tables/indexes differ in83, and no Zone2 records have been fabricated.
        followups::events::restore_pre_arrangement_fixture(&raw).unwrap();
        raw.execute_batch("BEGIN;DROP TABLE thread_creations;DROP TABLE calendar_invocations;DROP TABLE calendar_legacy_manual_boundaries;DROP INDEX thread_principals;ALTER TABLE threads DROP COLUMN principal_id;DROP TABLE catalog_principal_owner;UPDATE runs SET body=json_remove(body,'$.principal_id');DROP TABLE attachment_deliveries;DROP INDEX model_steps_active;ALTER TABLE model_steps DROP COLUMN driver_id;CREATE UNIQUE INDEX model_steps_active ON model_steps(run_id,coalesce(node_id,'')) WHERE state IN ('prepared','dispatched');DROP TABLE driver_calls;DROP TABLE driver_checkpoints;DROP TABLE run_drivers;DELETE FROM runtime_domains WHERE name='run_drivers';UPDATE run_launches SET body=json_remove(body,'$.selection.driver','$.selection.driver_models');UPDATE delegated_executions SET body=json_remove(body,'$.launch.driver','$.launch.driver_models');DROP TABLE context_observation_captures;DROP TABLE context_observation_imports;DROP INDEX context_observation_queue_cursor;DROP INDEX context_observation_queue_page;PRAGMA user_version=82;COMMIT;").unwrap();
        assert_eq!(inspect_catalog_format(&raw).unwrap(), 82);
        drop(raw);
        let mut db = f.open();
        assert_eq!(inspect_catalog_format(&db.db).unwrap(), FORMAT);
        assert_eq!(
            db.delegated_execution(&child.execution_id)
                .unwrap()
                .configuration_ref,
            execution_before.configuration_ref
        );
        let read = db
            .read_delegation_model(&work.operation_id)
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(read.recipe.catalog, work.recipe.catalog);
        assert_eq!(read.recipe.choices, work.recipe.choices);
        assert_eq!(read.inference.len(), 1);
        if completed {
            assert_eq!(db.operation(&inference).unwrap(), before);
            assert_eq!(db.operation(&work.operation_id).unwrap(), root_before);
            assert_eq!(
                db.capture_goal("goal")
                    .unwrap()
                    .load()
                    .unwrap()
                    .usage
                    .actual
                    .output_tokens
                    .known,
                7
            );
            commit(&mut db, &child.execution_id, owner("first")).unwrap();
        } else {
            assert_eq!(read.inference[0].effect, Effect::Unknown);
            assert_eq!(read.inference[0].outcome, Some(Outcome::Indeterminate));
            // The original missing Goal charge also blocks new paid authorization.
            assert!(matches!(
                db.capture_delegation_model(PrepareParams {
                    execution_id: child.execution_id.clone(),
                    execution_owner: owner("second"),
                    catalog: None
                }),
                Err(RuntimeError::RequestActivationHeld)
            ));
            let request = generation(&work);
            let body = db
                .prepare_inference_content()
                .write(&serde_json::to_value(&request).unwrap())
                .unwrap();
            assert!(db.admit_inference_generation(&request, body).is_err());
            assert!(commit(&mut db, &child.execution_id, owner("second")).is_err());
        }
        assert_eq!(
            db.prepare_content_collection(Default::default())
                .run()
                .status,
            ContentCollectionStatus::Completed
        );
        drop(db);
        let db = f.open();
        assert_eq!(
            db.read_delegation_model(&work.operation_id)
                .unwrap()
                .load()
                .unwrap()
                .inference
                .len(),
            1
        );
        assert_eq!(db.db.query_row("SELECT count(*) FROM events WHERE kind='catalog.upgraded' AND json_extract(data,'$.from')=82 AND json_extract(data,'$.to')=?1", [FORMAT], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
}
