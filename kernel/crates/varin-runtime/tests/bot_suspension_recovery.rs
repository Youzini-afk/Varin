//! No-network recovery regression. The only interruption seam is after a real
//! Engine RequestPrepared commit. Wake and dispatched-Unknown use the real Supervisor.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;
use varin_runtime::{
    catalog::bot::{BotGate, BotSuspension, RunStopReason},
    execution::*,
    supervisor::{RunStart, RunSupervisor},
    *,
};

fn gate(rev: u64, permitted: bool) -> BotGate {
    BotGate {
        bot_id: "review-bot".into(),
        profile_revision: rev,
        activity_operation_id: Some("review-sleep".into()),
        permitted,
    }
}
fn suspension(rev: u64) -> BotSuspension {
    BotSuspension {
        bot_id: "review-bot".into(),
        profile_revision: rev,
        activity_operation_id: "review-sleep".into(),
    }
}
#[derive(Default)]
struct Policy {
    decisions: AtomicUsize,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "independent-bot-review".into(),
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
        self.decisions.fetch_add(1, Ordering::SeqCst);
        let action = match (event, state.as_u64()) {
            (PolicyEvent::Started, Some(0)) => PolicyAction::RequestModel,
            (PolicyEvent::ModelCompleted { .. }, Some(1)) => PolicyAction::Complete,
            _ => panic!("unexpected decision {event:?} {state}"),
        };
        Ok(PolicyDecision {
            state: json!(state.as_u64().unwrap() + 1),
            action,
        })
    }
}
#[derive(Default)]
struct Provider {
    requests: Mutex<Vec<RequestSnapshot>>,
    hold: Option<(mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>)>,
}
impl ModelProvider for Provider {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(json!({"original":view,"marker":"independent-original-body"}).into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.requests.lock().unwrap().push(request.clone());
        if let Some((entered, release)) = &self.hold {
            emit(ProviderEvent::ToolArgumentsDelta {
                call_id: "partial-original".into(),
                delta: "{".into(),
            })
            .unwrap();
            entered.send(()).unwrap();
            release.lock().unwrap().recv().unwrap();
            assert!(cancel.is_cancelled());
            return Err(ModelFailure {
                tool_name: None,
                code: "review_cancelled".into(),
                message: "original local executor left".into(),
                retry_after_ms: None,
                provider_request_id: Some("review-remote-original".into()),
            });
        }
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "independent-answer".into(),
                content: Content::Text {
                    text: "one original answer".into(),
                },
                opaque: None,
            },
        })
        .unwrap();
        emit(ProviderEvent::Usage {
            receipt: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                input_tokens: Some(7),
                output_tokens: Some(2),
                ..Default::default()
            },
        })
        .unwrap();
        Ok(FinishReason::Stop)
    }
}
struct Cut {
    db: Arc<Mutex<Catalog>>,
    cut: Mutex<Option<Arc<RequestSnapshot>>>,
    cancel: CancellationToken,
}
impl Persistence for Cut {
    fn stop_reason(&self, r: &str, e: u64) -> Result<RunStopReason, ExecutionError> {
        self.db.stop_reason(r, e)
    }
    fn park_suspension(&self, r: &str, e: u64) -> Result<Run, ExecutionError> {
        self.db.park_suspension(r, e)
    }
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
        reuse: Option<&mut varin_runtime::catalog::context::ContextCompileReuse>,
    ) -> Result<Option<ContextProjection>, ExecutionError> {
        self.db.compile_context(r, e, h, reuse)
    }
    fn consume_inputs(
        &self,
        r: &str,
        e: u64,
        h: Option<&str>,
    ) -> Result<InputBatch, ExecutionError> {
        Persistence::consume_inputs(self.db.as_ref(), r, e, h)
    }
    fn goal_context(
        &self,
        r: &str,
        e: u64,
    ) -> Result<Option<varin_runtime::catalog::goals::GoalContext>, ExecutionError> {
        self.db.goal_context(r, e)
    }
    fn goal_boundary(
        &self,
        r: &str,
        e: u64,
    ) -> Result<varin_runtime::catalog::goals::GoalBoundary, ExecutionError> {
        self.db.goal_boundary(r, e)
    }
    fn commit(&self, r: &str, e: u64, record: &ExecutionRecord) -> Result<(), ExecutionError> {
        self.db.commit(r, e, record)?;
        if let ExecutionRecord::RequestPrepared { snapshot } = record {
            let mut captured = self.cut.lock().unwrap();
            assert!(captured.is_none(), "unexpected second prepare before wake");
            *captured = Some(snapshot.clone());
            let mut db = self.db.lock().unwrap();
            db.publish_bot_gate(gate(2, false)).unwrap();
            db.suspend_bot_scope(suspension(2)).unwrap();
            self.cancel.cancel();
        }
        Ok(())
    }
}
fn fixture(root: &std::path::Path, policy: &Policy) -> (Catalog, String, RequestBinding) {
    let mut db = Catalog::open(root).unwrap();
    db.publish_bot_gate(gate(1, true)).unwrap();
    db.create_bot_thread("review-thread", "review-branch", "review-bot")
        .unwrap();
    let launch=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"review","provider_family":"review","model":"review","configuration_generation":1,"tool_schema_generation":0,"tools":[],"policy":policy.identity(),"source":null})).unwrap();
    let r = db
        .submit_with_launch(
            &SubmitInput {
                key: "review-input".into(),
                thread_id: "review-thread".into(),
                branch_id: "review-branch".into(),
                expected_head: None,
                input: json!("one original input"),
                configuration: json!({}),
            },
            Some(launch),
        )
        .unwrap();
    let binding=serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"review","provider_family":"review","model":"review","credential_ref":null,"configuration_generation":1,"tool_schema_generation":0,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"review-branch","ancestor_id":null,"leaf_id":r.input_id}})).unwrap();
    (db, r.run_id, binding)
}
fn start(binding: RequestBinding, provider: Arc<Provider>, policy: Arc<Policy>) -> RunStart {
    RunStart {
        binding,
        provider,
        policy,
        policy_state: json!(999),
        tools: Arc::new(
            varin_runtime::composition::tools::ToolDirectory::assemble(vec![]).unwrap(),
        ),
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    }
}
fn no_send(root: &std::path::Path, cold: bool) {
    let policy = Arc::new(Policy::default());
    let provider = Arc::new(Provider::default());
    let (db, run, binding) = fixture(root, &policy);
    let input = db
        .prepare_execution(&run, binding.clone(), policy.identity(), json!(0))
        .unwrap();
    let db = Arc::new(Mutex::new(db));
    let cancel = CancellationToken::default();
    let cut = Arc::new(Cut {
        db: db.clone(),
        cut: Mutex::new(None),
        cancel: cancel.clone(),
    });
    let engine = ExecutionEngine {
        persistence: cut.clone(),
        provider: provider.clone(),
        policy: policy.clone(),
        tools: Arc::new(
            varin_runtime::composition::tools::ToolDirectory::assemble(vec![]).unwrap(),
        ),
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    };
    let worker = std::thread::spawn(move || engine.run(input, cancel));
    let report = worker.join().unwrap().unwrap();
    assert_eq!(report.state, RunState::Waiting);
    assert!(provider.requests.lock().unwrap().is_empty());
    let original = cut.cut.lock().unwrap().clone().unwrap();
    let before = db
        .lock()
        .unwrap()
        .model_step(&original.view.request_id)
        .unwrap();
    assert_eq!(before.state, ModelStepState::Prepared);
    assert!(!db.lock().unwrap().run(&run).unwrap().cancel_requested);
    assert_eq!(policy.decisions.load(Ordering::SeqCst), 1);
    drop(cut);
    let mut owner = Arc::try_unwrap(db).ok().unwrap().into_inner().unwrap();
    if cold {
        drop(owner);
        owner = Catalog::open(root).unwrap();
        assert!(
            !owner.run_startable(&run).unwrap(),
            "old epoch gate cannot admit recovery"
        );
        owner.publish_bot_gate(gate(2, false)).unwrap();
        assert!(!owner.run_startable(&run).unwrap());
        assert!(
            owner.publish_bot_gate(gate(1, true)).is_err(),
            "stale awake publication must fail"
        );
    }
    assert_eq!(
        owner.model_step(&original.view.request_id).unwrap().request,
        before.request
    );
    owner.publish_bot_gate(gate(3, true)).unwrap();
    let supervisor = RunSupervisor::new(owner);
    let released = supervisor.resume_bot_scope(&suspension(3)).unwrap();
    assert_eq!(released.resumed_run_ids, vec![run.clone()]);
    assert!(released.blocked_run_ids.is_empty());
    assert!(supervisor
        .resume_bot_scope(&suspension(3))
        .unwrap()
        .resumed_run_ids
        .is_empty());
    let report = supervisor
        .start(
            &run,
            start(binding.clone(), provider.clone(), policy.clone()),
        )
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(report.state, RunState::Completed);
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1, "Wake must actually send exactly once");
    assert_ne!(requests[0].view.request_id, original.view.request_id);
    assert_eq!(
        policy.decisions.load(Ordering::SeqCst),
        2,
        "original RequestModel proposal must not be decided twice"
    );
    drop(requests);
    let owner = supervisor.catalog();
    let db = owner.lock().unwrap();
    let closed = db.model_step(&original.view.request_id).unwrap();
    assert_eq!(closed.state, ModelStepState::NotDispatched);
    assert_eq!(closed.request, before.request);
    assert_eq!(closed.original, before.original);
    assert!(closed.usage.is_none());
    assert!(db
        .model_output(&original.view.request_id)
        .unwrap()
        .is_none());
    let history = db.execution_history("review-branch").unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|i| matches!(&i.content,Content::Text{text} if text=="one original input"))
            .count(),
        1
    );
    assert_eq!(
        history
            .iter()
            .filter(|i| matches!(&i.content,Content::Text{text} if text=="one original answer"))
            .count(),
        1
    );
    let events = db.events_after(0, 1000).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == "model.not_dispatched"
                && e.subject == original.view.request_id
                && e.data["reason"] == "recovery")
            .count(),
        1
    );
    drop(db);
    assert!(supervisor
        .resume_bot_scope(&suspension(3))
        .unwrap()
        .resumed_run_ids
        .is_empty());
    assert!(supervisor
        .start(&run, start(binding, provider.clone(), policy))
        .is_err());
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    supervisor.shutdown().unwrap();
    println!("PASS no-send Sleep→{}Wake→one real provider send; old Step retained; proposal/input/history once",if cold{"cold "}else{"warm "});
}
fn unknown(root: &std::path::Path) {
    let policy = Arc::new(Policy::default());
    let (db, run, binding) = fixture(root, &policy);
    let supervisor = Arc::new(RunSupervisor::new(db));
    let (entered, seen) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let provider = Arc::new(Provider {
        requests: Mutex::new(vec![]),
        hold: Some((entered, Mutex::new(held))),
    });
    let mut initial = start(binding.clone(), provider.clone(), policy.clone());
    initial.policy_state = json!(0);
    let handle = supervisor.start(&run, initial).unwrap();
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    supervisor
        .catalog()
        .lock()
        .unwrap()
        .publish_bot_gate(gate(2, false))
        .unwrap();
    let capture = supervisor.suspend_bot_scope(suspension(2)).unwrap();
    assert!(
        !supervisor
            .bot_scope_status(&suspension(2))
            .unwrap()
            .current_kernel_workers_drained
    );
    let copy = supervisor.clone();
    let (tx, rx) = mpsc::channel();
    let join = std::thread::spawn(move || tx.send(copy.drain_bot_scope(&capture)).unwrap());
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    release.send(()).unwrap();
    let drained = rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
    join.join().unwrap();
    assert!(drained.current_kernel_workers_drained);
    assert_eq!(drained.unresolved_model_request_ids.len(), 1);
    assert_eq!(handle.wait().unwrap().state, RunState::Waiting);
    let request = provider.requests.lock().unwrap()[0].view.request_id.clone();
    let original = supervisor
        .catalog()
        .lock()
        .unwrap()
        .model_step(&request)
        .unwrap();
    supervisor
        .catalog()
        .lock()
        .unwrap()
        .publish_bot_gate(gate(3, true))
        .unwrap();
    let restored = supervisor.resume_bot_scope(&suspension(3)).unwrap();
    assert_eq!(restored.blocked_run_ids, vec![run.clone()]);
    assert!(restored.resumed_run_ids.is_empty());
    assert!(supervisor
        .start(
            &run,
            start(binding.clone(), provider.clone(), policy.clone())
        )
        .is_err());
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    supervisor.shutdown().unwrap();
    drop(supervisor);
    let mut db = Catalog::open(root).unwrap();
    db.publish_bot_gate(gate(4, true)).unwrap();
    let supervisor = RunSupervisor::new(db);
    assert_eq!(
        supervisor
            .resume_bot_scope(&suspension(4))
            .unwrap()
            .blocked_run_ids,
        vec![run.clone()]
    );
    assert!(supervisor
        .start(&run, start(binding, provider.clone(), policy))
        .is_err());
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    let after = supervisor
        .catalog()
        .lock()
        .unwrap()
        .model_step(&request)
        .unwrap();
    assert_eq!(after.request, original.request);
    assert_eq!(after.state, original.state);
    assert_eq!(after.original, original.original);
    assert_eq!(after.usage, original.usage);
    supervisor.shutdown().unwrap();
    println!("PASS dispatched Unknown: actual provider join; warm/cold Wake zero resend; original Step evidence retained");
}
fn stopped(root: &std::path::Path) {
    let policy = Arc::new(Policy::default());
    let provider = Arc::new(Provider::default());
    let (db, run, binding) = fixture(root, &policy);
    let input = db
        .prepare_execution(&run, binding.clone(), policy.identity(), json!(0))
        .unwrap();
    let db = Arc::new(Mutex::new(db));
    let cancel = CancellationToken::default();
    let cut = Arc::new(Cut {
        db: db.clone(),
        cut: Mutex::new(None),
        cancel: cancel.clone(),
    });
    let engine = ExecutionEngine {
        persistence: cut.clone(),
        provider: provider.clone(),
        policy: policy.clone(),
        tools: Arc::new(
            varin_runtime::composition::tools::ToolDirectory::assemble(vec![]).unwrap(),
        ),
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    };
    assert_eq!(
        std::thread::spawn(move || engine.run(input, cancel))
            .join()
            .unwrap()
            .unwrap()
            .state,
        RunState::Waiting
    );
    let original = cut.cut.lock().unwrap().clone().unwrap();
    drop(cut);
    let db = Arc::try_unwrap(db).ok().unwrap().into_inner().unwrap();
    let supervisor = RunSupervisor::new(db);
    supervisor.cancel(&run).unwrap();
    assert!(
        supervisor
            .catalog()
            .lock()
            .unwrap()
            .run(&run)
            .unwrap()
            .cancel_requested
    );
    supervisor
        .catalog()
        .lock()
        .unwrap()
        .publish_bot_gate(gate(3, true))
        .unwrap();
    supervisor.resume_bot_scope(&suspension(3)).unwrap();
    assert!(supervisor
        .start(&run, start(binding, provider.clone(), policy))
        .is_err());
    assert!(provider.requests.lock().unwrap().is_empty());
    let owner = supervisor.catalog();
    let db = owner.lock().unwrap();
    assert!(db.run(&run).unwrap().cancel_requested);
    assert_eq!(
        db.model_step(&original.view.request_id).unwrap().state,
        ModelStepState::NotDispatched
    );
    drop(db);
    supervisor.shutdown().unwrap();
    println!("PASS explicit user Stop during hold wins: Wake cannot restart or send original no-send request");
}
#[test]
fn suspension_recovery_preserves_no_send_unknown_and_explicit_stop() {
    let root = std::env::temp_dir().join(format!(
        "varin-bot-suspension-recovery-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    no_send(&root.join("warm"), false);
    no_send(&root.join("cold"), true);
    unknown(&root.join("unknown"));
    stopped(&root.join("user-stop"));
    std::fs::remove_dir_all(root).unwrap();
}
