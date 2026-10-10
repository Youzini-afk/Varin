//! Policy-originated calls reuse the child, Wait and invocation owners without a model exchange.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::collaboration::WAIT_TOOL;
use varin_runtime::execution::*;
use varin_runtime::*;

fn wait_call(f: &mut Fixture, suffix: &str) -> ToolExecutionContext {
    f.admit_policy_call(ToolCall {
        call_id: suffix.into(),
        name: WAIT_TOOL.into(),
        schema_version: "1".into(),
        arguments: json!({"operationId": f.context.operation_id}),
    })
}
fn register(f: &mut Fixture, c: &ToolExecutionContext) -> Wait {
    let prepared =
        f.db.prepare_child_wait_registration(c, &f.context.operation_id)
            .unwrap()
            .load()
            .unwrap();
    f.db.register_child_wait(prepared).unwrap()
}
fn park(f: &mut Fixture, c: &ToolExecutionContext, wait: &Wait) {
    f.settle_policy_call(c, "awaiting_child");
    f.db.commit_execution(
        &c.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Waiting,
            waiting_on: Some(wait.id.clone()),
        },
    )
    .unwrap();
}
fn no_model_exchange(f: &Fixture) {
    let connection = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM model_steps", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM tool_calls", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[derive(Default)]
struct NoExecution;
impl ModelProvider for NoExecution {
    fn serialize(&self, _: &RequestView) -> Result<Value, ExecutionError> {
        panic!("child recovery must not request a model")
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        panic!("must not generate")
    }
}
impl ToolExecutor for NoExecution {
    fn plan(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        panic!("accepted child must not be prepared again")
    }
    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        panic!("must not prepare")
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        panic!("must not authorize")
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        panic!("must not execute")
    }
}
impl AgentPolicy for NoExecution {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "fixture".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let PolicyEvent::ToolGraphCompleted { receipts, .. } = event else {
            panic!("recovery must consume graph receipt: {event:?}")
        };
        assert!(matches!(
            receipts[0].completion,
            PolicyNodeCompletion::JobAccepted { .. }
        ));
        Ok(PolicyDecision {
            action: PolicyAction::Complete,
            state: state.clone(),
        })
    }
}
fn binding(f: &Fixture) -> RequestBinding {
    let launch =
        f.db.launch_intent(&f.context.run_id)
            .unwrap()
            .unwrap()
            .selection;
    RequestBinding {
        goal: None, resource_activations: Vec::new(),
        resource_checkpoint_id: None,
        connection_identity: launch.connection_identity,
        provider_family: launch.provider_family,
        model: launch.model,
        credential_ref: Some("credential-ref".into()),
        configuration_generation: launch.configuration_generation,
        tool_schema_generation: launch.tool_schema_generation,
        tools: launch.tools,
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: "branch:parent".into(),
            ancestor_id: None,
            leaf_id: f.db.head("branch:parent").unwrap(),
        },
    }
}

#[test]
fn early_report_and_reopen_fill_graph_gap_from_accepted_call_without_reexecution() {
    let mut f = Fixture::new_policy();
    let child = f.accept();
    let original = f.db.operation(&child.operation_id).unwrap().call_completion;
    f.db.fail_child_preparation(&child.operation_id, "independent preparation failed")
        .unwrap();
    f.db.settle_child_receipts().unwrap();
    assert_eq!(
        f.db.operation(&child.operation_id).unwrap().outcome,
        Some(Outcome::Failed)
    );
    assert_eq!(
        f.db.operation(&child.operation_id).unwrap().call_completion,
        original
    );
    assert!(f
        .db
        .policy_graph(&f.context.run_id, f.db.epoch())
        .unwrap()
        .unwrap()
        .result
        .receipts
        .is_empty());
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    no_model_exchange(&f);
    assert_eq!(f.accept(), f.db.child_task(&child.operation_id).unwrap());
    let run = f.context.run_id.clone();
    let input =
        f.db.prepare_execution(&run, binding(&f), NoExecution.identity(), Value::Null)
            .unwrap();
    let db = Arc::new(Mutex::new(f.db));
    let engine = ExecutionEngine {
        persistence: db.clone(),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: Arc::new(NoExecution),
        tools: Arc::new(NoExecution),
        policy: Arc::new(NoExecution),
        progress: ProgressSink::default(),
    };
    assert_eq!(
        engine
            .run(input, CancellationToken::default())
            .unwrap()
            .state,
        RunState::Completed
    );
    let owner = db.lock().unwrap();
    assert_eq!(owner.child_tasks().unwrap().len(), 1);
    let ToolOrigin::PolicyAction { action_id, .. } = &child.origin else {
        unreachable!()
    };
    assert_eq!(
        owner.operation(action_id).unwrap().phase,
        OperationPhase::Terminal
    );
    assert_eq!(
        owner.operation(&child.operation_id).unwrap().outcome,
        Some(Outcome::Failed)
    );
    assert_eq!(
        owner
            .operation(&child.operation_id)
            .unwrap()
            .call_completion,
        original
    );
    drop(owner);
    drop(engine);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn report_before_policy_wait_survives_reopen_and_delivers_once_without_model_pairing() {
    let mut f = Fixture::new_policy();
    let child = f.accept();
    f.settle_policy_call(&f.context.clone(), "preparing_child");
    f.db.fail_child_preparation(&child.operation_id, "EARLY_CHILD_REPORT")
        .unwrap();
    f.db.settle_child_receipts().unwrap();
    let context = wait_call(&mut f, "wait");
    let wait = register(&mut f, &context);
    assert!(wait.trigger_cursor.is_some());
    let original =
        f.db.operation(&context.operation_id)
            .unwrap()
            .call_completion;
    park(&mut f, &context, &wait);
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(
        f.db.deliver_child_waits().unwrap(),
        vec![context.run_id.clone()]
    );
    f.db.deliver_child_waits().unwrap();
    let history = f.db.history("branch:parent").unwrap();
    let reports: Vec<_> = history
        .iter()
        .filter(|i| i.source == HistorySource::Agent)
        .collect();
    assert_eq!(reports.len(), 1);
    let report: ConversationItem = serde_json::from_value(reports[0].content.clone()).unwrap();
    assert_eq!(
        report.provenance,
        Provenance::AgentMessage {
            thread_id: child.child_thread_id
        }
    );
    assert!(serde_json::to_string(&report.content)
        .unwrap()
        .contains("EARLY_CHILD_REPORT"));
    assert_eq!(
        f.db.operation(&context.operation_id)
            .unwrap()
            .call_completion,
        original
    );
    assert_eq!(
        register(&mut f, &context),
        f.db.inspect_child_wait(&wait.id).unwrap()
    );
    assert_eq!(
        f.db.operation(&context.operation_id).unwrap().phase,
        OperationPhase::Terminal
    );
    no_model_exchange(&f);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn policy_wait_cancellation_keeps_child_and_late_report_available_for_new_observer() {
    let mut f = Fixture::new_policy();
    let child = f.accept();
    f.settle_policy_call(&f.context.clone(), "preparing_child");
    let context = wait_call(&mut f, "first-wait");
    let wait = register(&mut f, &context);
    park(&mut f, &context, &wait);
    f.db.request_cancel_child_wait(&wait.id).unwrap();
    f.db.deliver_child_waits().unwrap();
    assert!(
        !f.db
            .operation(&child.operation_id)
            .unwrap()
            .cancel_requested
    );
    assert!(f
        .db
        .child_task(&child.operation_id)
        .unwrap()
        .report
        .is_none());
    assert_eq!(
        f.db.operation(&context.operation_id).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    let next = wait_call(&mut f, "second-wait");
    let wait = register(&mut f, &next);
    park(&mut f, &next, &wait);
    f.db.fail_child_preparation(&child.operation_id, "LATE_CHILD_REPORT")
        .unwrap();
    f.db.deliver_child_waits().unwrap();
    assert_eq!(
        f.db.history("branch:parent")
            .unwrap()
            .iter()
            .filter(|i| i.source == HistorySource::Agent)
            .count(),
        1
    );
    assert_eq!(
        f.db.operation(&next.operation_id).unwrap().outcome,
        Some(Outcome::Succeeded)
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn graph_cancel_fences_new_child_and_wait_publication_but_keeps_accepted_child() {
    let mut f = Fixture::new_policy();
    let launch =
        f.db.prepare_child_launch(&f.context.run_id, f.launch.clone())
            .unwrap()
            .load()
            .unwrap();
    let prepared =
        f.db.prepare_child_admission(&f.context, f.input.clone(), varin_runtime::catalog::collaboration::ChildSourceHandoff::fixed(&f.context.operation_id,f.pin.clone()), launch)
            .unwrap()
            .load()
            .unwrap();
    let ToolOrigin::PolicyAction { action_id, .. } = &f.context.origin else {
        unreachable!()
    };
    f.db.request_cancel_operation(action_id).unwrap();
    assert!(f.db.accept_child_references(prepared).is_err());
    assert!(f.db.child_tasks().unwrap().is_empty());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();

    let mut f = Fixture::new_policy();
    let child = f.accept();
    f.settle_policy_call(&f.context.clone(), "preparing_child");
    let context = wait_call(&mut f, "cancel-wait");
    let prepared =
        f.db.prepare_child_wait_registration(&context, &child.operation_id)
            .unwrap()
            .load()
            .unwrap();
    let ToolOrigin::PolicyAction { action_id, .. } = &context.origin else {
        unreachable!()
    };
    f.db.request_cancel_operation(action_id).unwrap();
    assert!(f.db.register_child_wait(prepared).is_err());
    assert!(
        !f.db
            .operation(&child.operation_id)
            .unwrap()
            .cancel_requested
    );
    f.db.request_cancel_run(&f.context.run_id).unwrap();
    assert!(
        !f.db
            .operation(&child.operation_id)
            .unwrap()
            .cancel_requested
    );
    f.db.fail_child_preparation(&child.operation_id, "report after parent cancellation")
        .unwrap();
    f.db.settle_child_receipts().unwrap();
    assert_eq!(
        f.db.operation(&child.operation_id).unwrap().outcome,
        Some(Outcome::Failed)
    );
    no_model_exchange(&f);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn policy_wait_rejects_changed_target_or_origin_before_registering_any_wait() {
    let mut f = Fixture::new_policy();
    f.accept();
    f.settle_policy_call(&f.context.clone(), "preparing_child");
    let context = wait_call(&mut f, "wait");
    assert!(f
        .db
        .prepare_child_wait_registration(&context, "other-child")
        .unwrap()
        .load()
        .is_err());
    let mut wrong = context.clone();
    wrong.origin = ToolOrigin::ModelStep {
        request_id: "fake-model".into(),
    };
    assert!(f
        .db
        .prepare_child_wait_registration(&wrong, &f.context.operation_id)
        .unwrap()
        .load()
        .is_err());
    let prepared =
        f.db.prepare_child_wait_registration(&context, &f.context.operation_id)
            .unwrap()
            .load()
            .unwrap();
    f.db.request_cancel_operation(&context.operation_id)
        .unwrap();
    assert!(f.db.register_child_wait(prepared).is_err());
    assert!(f.db.pending_child_wait(&context.run_id).unwrap().is_none());
    no_model_exchange(&f);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancelled_observation_can_park_for_delivery_but_generic_cancelled_wait_cannot() {
    let mut f = Fixture::new_policy();
    f.accept();
    f.settle_policy_call(&f.context.clone(), "preparing_child");
    let context = wait_call(&mut f, "cancel-before-park");
    let wait = register(&mut f, &context);
    f.settle_policy_call(&context, "awaiting_child");
    f.db.request_cancel_child_wait(&wait.id).unwrap();
    assert_ne!(f.db.run(&context.run_id).unwrap().state, RunState::Waiting);
    let identity =
        f.db.launch_intent(&context.run_id)
            .unwrap()
            .unwrap()
            .selection
            .policy;
    let checkpoint = ExecutionRecord::PolicyCheckpoint {
        previous_state: Value::Null,
                event: PolicyEvent::Started,
        identity: identity.clone(),
        state: json!({"stage":1}),
        action: PolicyAction::Wait {
            wait_id: wait.id.clone(),
        },
    };
    f.db.commit_execution(&context.run_id, f.db.epoch(), &checkpoint)
        .unwrap();
    park(&mut f, &context, &wait);
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    f.db.deliver_child_waits().unwrap();
    f.db.deliver_child_waits().unwrap();
    assert_eq!(
        f.db.history("branch:parent")
            .unwrap()
            .iter()
            .filter(|i| i.source == HistorySource::Environment)
            .count(),
        1
    );
    assert!(
        !f.db
            .operation(&f.context.operation_id)
            .unwrap()
            .cancel_requested
    );
    let generic =
        f.db.register_wait("generic", &context.run_id, "independent", "some-event", 0)
            .unwrap();
    f.db.cancel_wait(&generic.id).unwrap();
    assert!(f
        .db
        .commit_execution(
            &context.run_id,
            f.db.epoch(),
            &ExecutionRecord::PolicyCheckpoint {
                previous_state: Value::Null,
                event: PolicyEvent::Started,
                identity,
                state: json!({"stage":2}),
                action: PolicyAction::Wait {
                    wait_id: generic.id.clone()
                },
            }
        )
        .is_err());
    assert!(f
        .db
        .commit_execution(
            &context.run_id,
            f.db.epoch(),
            &ExecutionRecord::StateChanged {
                state: RunState::Waiting,
                waiting_on: Some(generic.id),
            }
        )
        .is_err());
    assert_eq!(f.db.run(&context.run_id).unwrap().state, RunState::Runnable);
    assert_eq!(
        f.db.events_after(0, 1000)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "child.wait_registered")
            .count(),
        1
    );
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn dispatched_child_without_acceptance_requires_original_owner_reconciliation_on_reopen() {
    let mut f = Fixture::new_policy();
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(
        f.db.operation(&f.context.operation_id).unwrap().outcome,
        Some(Outcome::Indeterminate)
    );
    let input =
        f.db.prepare_execution(
            &f.context.run_id,
            binding(&f),
            NoExecution.identity(),
            Value::Null,
        )
        .unwrap();
    let db = Arc::new(Mutex::new(f.db));
    let engine = ExecutionEngine {
        persistence: db.clone(),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: Arc::new(NoExecution),
        tools: Arc::new(NoExecution),
        policy: Arc::new(NoExecution),
        progress: ProgressSink::default(),
    };
    assert_eq!(
        engine
            .run(input, CancellationToken::default())
            .unwrap_err()
            .code,
        "tool_reconciliation_required"
    );
    assert!(db.lock().unwrap().child_tasks().unwrap().is_empty());
    drop(engine);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
