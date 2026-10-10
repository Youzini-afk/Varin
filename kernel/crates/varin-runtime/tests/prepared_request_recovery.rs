//! Exercise the real Engine commit boundary, reopened Catalog, and Supervisor admission.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use varin_runtime::{
    catalog::{goals::*, inputs::EnqueueInput},
    execution::*,
    supervisor::{RunStart, RunSupervisor},
    *,
};

#[derive(Default)]
struct Provider {
    requests: Mutex<Vec<RequestSnapshot>>,
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
        self.requests.lock().unwrap().push(request.clone());
        let failure = |e: ExecutionError| ModelFailure {
            code: e.code,
            message: e.message,
            retry_after_ms: None,
            provider_request_id: None,
        };
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "signed".into(),
                content: Content::ProviderOnly,
                opaque: Some(OpaqueProviderItem {
                    connection_identity: request.view.binding.connection_identity.clone(),
                    family: request.view.binding.provider_family.clone(),
                    adapter_version: "1".into(),
                    value: json!({"signature":[null,17,"原始"]}),
                }),
            },
        })
        .map_err(failure)?;
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "answer".into(),
                content: Content::Text {
                    text: "answer".into(),
                },
                opaque: None,
            },
        })
        .map_err(failure)?;
        emit(ProviderEvent::Usage {
            receipt: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                output_tokens: Some(1),
                ..Default::default()
            },
        })
        .map_err(failure)?;
        Ok(FinishReason::Stop)
    }
}
#[derive(Default)]
struct Policy {
    decisions: Mutex<Vec<(PolicyEvent, Value)>>,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "recovery-fixture".into(),
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
        self.decisions
            .lock()
            .unwrap()
            .push((event.clone(), state.clone()));
        let n = state.as_u64().unwrap();
        let action = match (event, n) {
            (PolicyEvent::Started, 0) => PolicyAction::RequestModel,
            (PolicyEvent::ModelCompleted { .. }, 1) => PolicyAction::Deliver {
                text: "durable progress".into(),
            },
            (PolicyEvent::Delivered { .. }, 2) => PolicyAction::RequestModel,
            (PolicyEvent::ModelCompleted { .. }, 3) => PolicyAction::Complete,
            _ => panic!("unexpected policy continuation: {event:?} state={state}"),
        };
        Ok(PolicyDecision {
            state: json!(n + 1),
            action,
        })
    }
}
struct PreparedBoundary {
    db: Arc<Mutex<Catalog>>,
    prepared: AtomicUsize,
    id: Mutex<Option<String>>,
    interrupt: bool,
}
impl Persistence for PreparedBoundary {
    fn policy_action(&self, r: &str, e: u64) -> Result<Option<PolicyActionState>, ExecutionError> {
        self.db.policy_action(r, e)
    }
    fn policy_boundary(&self, r: &str, e: u64) -> Result<PolicyBoundary, ExecutionError> {
        self.db.policy_boundary(r, e)
    }
    fn commit_policy_control(
        &self,
        r: &str,
        e: u64,
        i: &PolicyControlIntent,
    ) -> Result<PolicyControlReceipt, ExecutionError> {
        self.db.commit_policy_control(r, e, i)
    }
    fn resource_admission(&self) -> Arc<varin_runtime::resource_admission::ResourceAdmission> {
        self.db.resource_admission()
    }
    fn compile_context(
        &self,
        r: &str,
        e: u64,
        h: Option<&str>,
    ) -> Result<Option<ContextProjection>, ExecutionError> {
        self.db.compile_context(r, e, h)
    }
    fn consume_inputs(
        &self,
        r: &str,
        e: u64,
        h: Option<&str>,
    ) -> Result<InputBatch, ExecutionError> {
        Persistence::consume_inputs(self.db.as_ref(), r, e, h)
    }
    fn goal_context(&self, r: &str, e: u64) -> Result<Option<GoalContext>, ExecutionError> {
        self.db.goal_context(r, e)
    }
    fn goal_boundary(&self, r: &str, e: u64) -> Result<GoalBoundary, ExecutionError> {
        self.db.goal_boundary(r, e)
    }
    fn commit(&self, r: &str, e: u64, record: &ExecutionRecord) -> Result<(), ExecutionError> {
        self.db.commit(r, e, record)?;
        if let ExecutionRecord::RequestPrepared { snapshot } = record {
            let prepared = self.prepared.fetch_add(1, Ordering::SeqCst);
            if self.interrupt && prepared == 0 {
                self.db
                    .lock()
                    .unwrap()
                    .enqueue_input(&EnqueueInput {
                        key: "interrupt-readmitted-proposal".into(),
                        thread_id: "thread".into(),
                        branch_id: "branch".into(),
                        mode: InputMode::Interrupt,
                        input: json!("CORRECTION BEFORE DISPATCH"),
                        configuration: None,
                    })
                    .unwrap();
            } else if !self.interrupt && prepared == 1 {
                *self.id.lock().unwrap() = Some(snapshot.view.request_id.clone());
                panic!("crash after durable RequestPrepared, before ModelDispatched");
            }
        }
        Ok(())
    }
}
struct Fixture {
    root: std::path::PathBuf,
    run: String,
    request: String,
    binding: RequestBinding,
    provider: Arc<Provider>,
    policy: Arc<Policy>,
}
impl Fixture {
    fn crash(goal: bool) -> Self {
        let root = std::env::temp_dir().join(format!("varin-prepared-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let launch=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":0,"tools":[],"policy":{"name":"recovery-fixture","version":"1"},"source":null})).unwrap();
        let receipt = db
            .submit_with_launch(
                &SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("original input"),
                    configuration: json!({}),
                },
                Some(launch),
            )
            .unwrap();
        if goal {
            let p = db
                .prepare_goal_start(
                    "goal",
                    &receipt.run_id,
                    Self::scope(),
                    "original objective".into(),
                    None,
                )
                .unwrap()
                .load()
                .unwrap();
            db.admit_goal_mutation(p).unwrap();
        }
        let binding:RequestBinding=serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":0,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":receipt.input_id}})).unwrap();
        let provider = Arc::new(Provider::default());
        let policy = Arc::new(Policy::default());
        let input = db
            .prepare_execution(
                &receipt.run_id,
                binding.clone(),
                policy.identity(),
                json!(0),
            )
            .unwrap();
        let db = Arc::new(Mutex::new(db));
        let cut = Arc::new(PreparedBoundary {
            db: db.clone(),
            prepared: AtomicUsize::new(0),
            id: Mutex::new(None),
            interrupt: false,
        });
        let engine = ExecutionEngine {
            persistence: cut.clone(),
            provider: provider.clone(),
            tools: Arc::new(
                varin_runtime::composition::tools::ToolDirectory::assemble(vec![]).unwrap(),
            ),
            policy: policy.clone(),
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        };
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || engine.run(input, CancellationToken::default())
        ))
        .is_err());
        let request = cut.id.lock().unwrap().clone().unwrap();
        assert_eq!(
            db.lock().unwrap().model_step(&request).unwrap().state,
            ModelStepState::Prepared
        );
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
        drop(engine);
        drop(cut);
        drop(db);
        Self {
            root,
            run: receipt.run_id,
            request,
            binding,
            provider,
            policy,
        }
    }
    fn scope() -> GoalScope {
        GoalScope {
            thread_id: "thread".into(),
            branch_id: "branch".into(),
        }
    }
    fn start(&self) -> RunStart {
        RunStart {
            binding: self.binding.clone(),
            policy_state: json!(999),
            provider: self.provider.clone(),
            tools: Arc::new(
                varin_runtime::composition::tools::ToolDirectory::assemble(vec![]).unwrap(),
            ),
            policy: self.policy.clone(),
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        }
    }
    fn assert_closed(&self, db: &Catalog) {
        let s = db.model_step(&self.request).unwrap();
        assert_eq!(s.state, ModelStepState::NotDispatched);
        assert!(s.usage.is_none());
        assert!(s.original.is_empty());
        assert!(db.model_output(&self.request).unwrap().is_none());
        assert!(s.superseded_by_input.is_none());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn prepared_reopens_through_supervisor_without_redeciding_or_replaying_history() {
    let f = Fixture::crash(false);
    let db = Catalog::open(&f.root).unwrap();
    let old = db.model_step(&f.request).unwrap().request;
    let supervisor = RunSupervisor::new(db);
    let report = supervisor.start(&f.run, f.start()).unwrap().wait().unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(report.policy_state, json!(4));
    let requests = f.provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[1].view.request_id, f.request);
    assert!(requests[1].view.history.iter().any(|i| i
        .opaque
        .as_ref()
        .is_some_and(|o| o.value == json!({"signature":[null,17,"原始"]}))));
    let db = supervisor.catalog();
    let db = db.lock().unwrap();
    f.assert_closed(&db);
    assert_eq!(db.model_step(&f.request).unwrap().request, old);
    let history = db.execution_history("branch").unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|i| matches!(&i.content,Content::Text{text} if text=="original input"))
            .count(),
        1
    );
    assert_eq!(
        history
            .iter()
            .filter(|i| matches!(&i.content,Content::Text{text} if text=="durable progress"))
            .count(),
        1
    );
    assert_eq!(f.policy.decisions.lock().unwrap().len(), 4);
    drop(db);
    drop(requests);
    supervisor.shutdown().unwrap();
}

#[test]
fn changed_goal_redecides_from_real_delivery_and_committed_private_state() {
    let f = Fixture::crash(true);
    let mut db = Catalog::open(&f.root).unwrap();
    let p = db
        .prepare_goal_update(
            "goal",
            1,
            Fixture::scope(),
            "CURRENT OBJECTIVE".into(),
            None,
        )
        .unwrap()
        .load()
        .unwrap();
    db.admit_goal_mutation(p).unwrap();
    let supervisor = RunSupervisor::new(db);
    let report = supervisor.start(&f.run, f.start()).unwrap().wait().unwrap();
    assert_eq!(report.policy_state, json!(4));
    let requests = f.provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].view.binding.goal.as_ref().unwrap().generation,
        2
    );
    assert!(serde_json::to_string(&requests[1])
        .unwrap()
        .contains("CURRENT OBJECTIVE"));
    let decisions = f.policy.decisions.lock().unwrap();
    assert!(matches!(decisions[3],(PolicyEvent::Delivered{..},ref state) if state==&json!(2)));
    let db = supervisor.catalog();
    let db = db.lock().unwrap();
    f.assert_closed(&db);
    let goal = db.capture_goal("goal").unwrap().load().unwrap();
    assert_eq!(goal.usage.actual.inferences, 2);
    assert_eq!(goal.usage.missing_inferences, 0);
    assert_eq!(goal.usage.pending_inferences, 0);
    drop(db);
    supervisor.shutdown().unwrap();
}

#[test]
fn queued_input_wins_without_replaying_committed_delivery() {
    for mode in [InputMode::Boundary, InputMode::Interrupt] {
        let f = Fixture::crash(false);
        let mut db = Catalog::open(&f.root).unwrap();
        db.enqueue_input(&EnqueueInput {
            key: "new".into(),
            thread_id: "thread".into(),
            branch_id: "branch".into(),
            mode,
            input: json!("NEW INPUT"),
            configuration: None,
        })
        .unwrap();
        let supervisor = RunSupervisor::new(db);
        let report = supervisor.start(&f.run, f.start()).unwrap().wait().unwrap();
        assert_eq!(report.policy_state, json!(4));
        let requests = f.provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1]
            .view
            .history
            .iter()
            .any(|i| matches!(&i.content,Content::Text{text} if text=="NEW INPUT")));
        let db = supervisor.catalog();
        let db = db.lock().unwrap();
        assert_eq!(
            db.execution_history("branch")
                .unwrap()
                .iter()
                .filter(|i| matches!(&i.content,Content::Text{text} if text=="durable progress"))
                .count(),
            1
        );
        assert_eq!(
            db.model_step(&f.request).unwrap().state,
            ModelStepState::NotDispatched
        );
        drop(db);
        supervisor.shutdown().unwrap();
    }
}

#[test]
fn cancellation_and_goal_pause_do_not_dispatch_prepared_work() {
    for pause in [false, true] {
        let f = Fixture::crash(pause);
        let mut db = Catalog::open(&f.root).unwrap();
        if pause {
            db.control_goal("goal", 1, &Fixture::scope(), GoalControlAction::Pause)
                .unwrap();
        }
        let supervisor = RunSupervisor::new(db);
        let state = if pause {
            supervisor
                .start(&f.run, f.start())
                .unwrap()
                .wait()
                .unwrap()
                .state
        } else {
            supervisor.cancel(&f.run).unwrap().state
        };
        assert_eq!(
            state,
            if pause {
                RunState::Waiting
            } else {
                RunState::Cancelled
            }
        );
        assert_eq!(f.provider.requests.lock().unwrap().len(), 1);
        let db = supervisor.catalog();
        let db = db.lock().unwrap();
        f.assert_closed(&db);
        drop(db);
        supervisor.shutdown().unwrap();
    }
}

#[test]
fn a_second_crash_after_nonexecution_publication_still_recovers_the_pending_proposal() {
    let f = Fixture::crash(false);
    let mut db = Catalog::open(&f.root).unwrap();
    let (input, recovery) = db
        .prepare_recovered_execution(&f.run, f.binding.clone(), f.policy.identity(), json!(999))
        .unwrap();
    f.assert_closed(&db);
    assert_eq!(input.policy_state, json!(2));
    assert_eq!(recovery.unwrap().decision.unwrap().state, json!(3));
    drop(db);
    let mut db = Catalog::open(&f.root).unwrap();
    let (input, recovery) = db
        .prepare_recovered_execution(&f.run, f.binding.clone(), f.policy.identity(), json!(999))
        .unwrap();
    let supervisor = RunSupervisor::new(db);
    let db = supervisor.catalog();
    let engine = ExecutionEngine {
        persistence: Arc::new(PreparedBoundary {
            db: db.clone(),
            prepared: AtomicUsize::new(0),
            id: Mutex::new(None),
            interrupt: true,
        }),
        provider: f.provider.clone(),
        policy: f.policy.clone(),
        tools: Arc::new(
            varin_runtime::composition::tools::ToolDirectory::assemble(vec![]).unwrap(),
        ),
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    };
    let report = engine
        .run_recovered(input, CancellationToken::default(), recovery)
        .unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(report.policy_state, json!(4));
    let requests = f.provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].view.history.iter().any(
        |item| matches!(&item.content,Content::Text{text} if text=="CORRECTION BEFORE DISPATCH")
    ));
    let decisions = f.policy.decisions.lock().unwrap();
    assert_eq!(decisions.len(), 5);
    assert!(matches!(&decisions[3], (PolicyEvent::Delivered { .. }, state) if state==&json!(2)));
    assert_eq!(
        report
            .history
            .iter()
            .filter(|item| matches!(&item.content,Content::Text{text} if text=="durable progress"))
            .count(),
        1
    );
    supervisor.shutdown().unwrap();
}
#[test]
fn dispatched_intent_is_never_reclassified_or_replayed() {
    let f = Fixture::crash(false);
    let mut db = Catalog::open(&f.root).unwrap();
    db.commit_execution(
        &f.run,
        db.epoch(),
        &ExecutionRecord::ModelDispatched {
            request_id: f.request.clone(),
        },
    )
    .unwrap();
    assert!(db
        .commit_execution(
            &f.run,
            db.epoch(),
            &ExecutionRecord::RequestNotDispatched {
                request_id: f.request.clone(),
                reason: NonDispatchReason::Recovery
            }
        )
        .is_err());
    drop(db);
    let supervisor = RunSupervisor::new(Catalog::open(&f.root).unwrap());
    assert!(supervisor.start(&f.run, f.start()).unwrap().wait().is_err());
    assert_eq!(f.provider.requests.lock().unwrap().len(), 1);
    assert_eq!(
        supervisor
            .catalog()
            .lock()
            .unwrap()
            .model_step(&f.request)
            .unwrap()
            .state,
        ModelStepState::Interrupted
    );
    supervisor.shutdown().unwrap();
}

#[test]
fn rejected_live_binding_does_not_become_authorized_after_nonexecution_closure() {
    let f = Fixture::crash(false);
    for _ in 0..2 {
        let supervisor = RunSupervisor::new(Catalog::open(&f.root).unwrap());
        let mut start = f.start();
        start.binding.model = "unselected".into();
        assert!(supervisor.start(&f.run, start).unwrap().wait().is_err());
        assert_eq!(f.provider.requests.lock().unwrap().len(), 1);
        f.assert_closed(&supervisor.catalog().lock().unwrap());
        supervisor.shutdown().unwrap();
    }
    let supervisor = RunSupervisor::new(Catalog::open(&f.root).unwrap());
    assert_eq!(
        supervisor
            .start(&f.run, f.start())
            .unwrap()
            .wait()
            .unwrap()
            .state,
        RunState::Completed
    );
    assert_eq!(f.provider.requests.lock().unwrap().len(), 2);
    supervisor.shutdown().unwrap();
}

#[test]
fn cancellation_closes_prepared_metadata_without_loading_its_request_body() {
    let f = Fixture::crash(false);
    let db = Catalog::open(&f.root).unwrap();
    let raw = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
    let body: String = raw
        .query_row(
            "SELECT body FROM model_steps WHERE id=?1",
            [&f.request],
            |r| r.get(0),
        )
        .unwrap();
    let body: Value = serde_json::from_str(&body).unwrap();
    let path = varin_runtime::content::object_path(
        &f.root.join("content"),
        body["request"]["content_object"].as_str().unwrap(),
    )
    .unwrap();
    std::fs::remove_file(path).unwrap();
    let supervisor = RunSupervisor::new(db);
    assert_eq!(
        supervisor.cancel(&f.run).unwrap().state,
        RunState::Cancelled
    );
    assert_eq!(
        raw.query_row(
            "SELECT state FROM model_steps WHERE id=?1",
            [&f.request],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "not_dispatched"
    );
    assert_eq!(f.provider.requests.lock().unwrap().len(), 1);
    supervisor.shutdown().unwrap();
}

#[test]
fn supervisor_failure_before_dispatch_keeps_nonexecution_and_private_proposal_recoverable() {
    let f = Fixture::crash(false);
    let db = Catalog::open(&f.root).unwrap();
    let raw = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
    raw.execute_batch("CREATE TRIGGER fail_generating BEFORE UPDATE ON runs WHEN json_extract(NEW.body,'$.state')='generating' BEGIN SELECT RAISE(ABORT,'simulated predispatch storage failure'); END;").unwrap();
    let supervisor = RunSupervisor::new(db);
    assert!(supervisor.start(&f.run, f.start()).unwrap().wait().is_err());
    assert_eq!(f.provider.requests.lock().unwrap().len(), 1);
    assert_eq!(
        raw.query_row(
            "SELECT count(*) FROM model_steps WHERE state='not_dispatched'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    raw.execute_batch("DROP TRIGGER fail_generating").unwrap();
    supervisor.shutdown().unwrap();
    drop(supervisor);
    drop(raw);
    let supervisor = RunSupervisor::new(Catalog::open(&f.root).unwrap());
    assert_eq!(
        supervisor
            .start(&f.run, f.start())
            .unwrap()
            .wait()
            .unwrap()
            .policy_state,
        json!(4)
    );
    assert_eq!(f.provider.requests.lock().unwrap().len(), 2);
    assert_eq!(f.policy.decisions.lock().unwrap().len(), 4);
    supervisor.shutdown().unwrap();
}

#[test]
fn paused_goal_only_continues_after_explicit_resume_with_current_generation() {
    let f = Fixture::crash(true);
    let mut db = Catalog::open(&f.root).unwrap();
    db.control_goal("goal", 1, &Fixture::scope(), GoalControlAction::Pause)
        .unwrap();
    let supervisor = RunSupervisor::new(db);
    assert_eq!(
        supervisor
            .start(&f.run, f.start())
            .unwrap()
            .wait()
            .unwrap()
            .state,
        RunState::Waiting
    );
    supervisor.shutdown().unwrap();
    drop(supervisor);
    let mut db = Catalog::open(&f.root).unwrap();
    assert!(!db.release_goal_wait(&f.run).unwrap());
    db.control_goal("goal", 2, &Fixture::scope(), GoalControlAction::Resume)
        .unwrap();
    db.release_goal_wait(&f.run).unwrap();
    let supervisor = RunSupervisor::new(db);
    assert_eq!(
        supervisor
            .start(&f.run, f.start())
            .unwrap()
            .wait()
            .unwrap()
            .state,
        RunState::Completed
    );
    let requests = f.provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].view.binding.goal.as_ref().unwrap().generation,
        3
    );
    supervisor.shutdown().unwrap();
}

#[test]
fn explicit_model_selection_activates_after_the_old_candidate_is_closed() {
    let f = Fixture::crash(false);
    let mut db = Catalog::open(&f.root).unwrap();
    let config:ModelSessionConfiguration=serde_json::from_value(json!({"providerFamily":"openai-responses","model":"chosen-new","endpoint":"http://127.0.0.1:9/not-contacted","credentialEnvironment":null,"allowAnonymous":true,"configurationGeneration":2,"maxOutputTokens":100})).unwrap();
    let selected = db
        .select_model(&f.run, "chosen-model", config.clone(), None)
        .unwrap();
    db.prepare_model_selection(&selected, db.epoch(), None)
        .unwrap();
    let mut binding = f.binding.clone();
    binding.connection_identity =
        varin_runtime::model_session::connection_identity(&config).unwrap();
    binding.model = config.model;
    binding.provider_family = config.provider_family;
    binding.configuration_generation = 2;
    assert!(db
        .activate_model_selection(&selected, db.epoch(), &binding)
        .is_err());
    db.prepare_recovered_execution(&f.run, f.binding.clone(), f.policy.identity(), json!(999))
        .unwrap();
    assert!(db
        .activate_model_selection(&selected, db.epoch(), &binding)
        .unwrap());
    drop(db);
    let supervisor = RunSupervisor::new(Catalog::open(&f.root).unwrap());
    let mut start = f.start();
    start.binding = binding;
    assert_eq!(
        supervisor
            .start(&f.run, start)
            .unwrap()
            .wait()
            .unwrap()
            .state,
        RunState::Completed
    );
    let requests = f.provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].view.binding.model, "chosen-new");
    assert_eq!(f.policy.decisions.lock().unwrap().len(), 4);
    supervisor.shutdown().unwrap();
}

#[test]
fn obsolete_consumed_at_prepare_format_is_rejected_without_recovery_writes() {
    let f = Fixture::crash(false);
    let raw = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
    let before: (i64, String) = raw
        .query_row(
            "SELECT epoch,(SELECT body FROM model_steps WHERE id=?1) FROM runtime_meta WHERE id=1",
            [&f.request],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    raw.pragma_update(None, "user_version", 22).unwrap();
    assert!(matches!(
        Catalog::open(&f.root),
        Err(RuntimeError::Format(22))
    ));
    let after: (i64, String) = raw
        .query_row(
            "SELECT epoch,(SELECT body FROM model_steps WHERE id=?1) FROM runtime_meta WHERE id=1",
            [&f.request],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(after, before);
}
