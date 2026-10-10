//! Actual Engine/Catalog continuation boundaries for independently delivered output and explicit pause.
#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::inputs::EnqueueInput;
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::execution::*;
use varin_runtime::*;

fn identity() -> PolicyIdentity {
    PolicyIdentity {
        name: "control-fixture".into(),
        version: "1".into(),
    }
}
struct Owner(Option<Arc<Mutex<Catalog>>>);
impl std::ops::Deref for Owner {
    type Target = Arc<Mutex<Catalog>>;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}
impl Owner {
    fn clone(&self) -> Arc<Mutex<Catalog>> {
        self.0.as_ref().unwrap().clone()
    }
}
struct Fixture {
    root: std::path::PathBuf,
    db: Owner,
    supervisor: Option<Arc<varin_runtime::supervisor::RunSupervisor>>,
    input: ExecutionInput,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-policy-control-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("continue deliberately"),
                configuration: json!({}),
            })
            .unwrap();
        let binding = RequestBinding {
            child_dispatch: None,
            goal: None, resource_activations: Vec::new(),
            resource_checkpoint_id: None,
            connection_identity: "fixture".into(),
            provider_family: "fixture".into(),
            model: "fixture".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 0,
            tools: vec![],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: "main".into(),
                ancestor_id: None,
                leaf_id: Some(receipt.input_id),
            },
        };
        db.bind_launch(
            &receipt.run_id,
            LaunchSelection::from_binding(&binding, identity(), None),
        )
        .unwrap();
        let input = db
            .prepare_execution(&receipt.run_id, binding, identity(), Value::Null)
            .unwrap();
        let supervisor = Arc::new(varin_runtime::supervisor::RunSupervisor::new(db));
        Self {
            root,
            db: Owner(Some(supervisor.catalog())),
            supervisor: Some(supervisor),
            input,
        }
    }
    fn reopen(&mut self) {
        self.db.0 = None;
        self.supervisor = None;
        let supervisor = Arc::new(varin_runtime::supervisor::RunSupervisor::new(
            Catalog::open(&self.root).unwrap(),
        ));
        self.db = Owner(Some(supervisor.catalog()));
        self.supervisor = Some(supervisor);
        self.input.owner_generation = self.db.lock().unwrap().epoch();
    }
    fn input(&self) -> ExecutionInput {
        self.db
            .lock()
            .unwrap()
            .prepare_execution(
                &self.input.run_id,
                self.input.binding.clone(),
                identity(),
                Value::Null,
            )
            .unwrap()
    }
    fn enqueue(&self, key: &str) {
        self.db
            .lock()
            .unwrap()
            .enqueue_input(&EnqueueInput {
                key: key.into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                mode: InputMode::Boundary,
                input: json!({"text":key}),
                configuration: None,
            })
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[derive(Default)]
struct Provider {
    requests: Mutex<Vec<RequestView>>,
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
        self.requests.lock().unwrap().push(request.view.clone());
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "answer".into(),
                content: Content::Text {
                    text: "model continuation".into(),
                },
                opaque: None,
            },
        })
        .unwrap();
        Ok(FinishReason::Stop)
    }
}
struct NoTools;
impl ToolExecutor for NoTools {
    fn plan(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        panic!("no tool call expected")
    }
    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        panic!("no tool call expected")
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        panic!("no tool call expected")
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        panic!("no tool call expected")
    }
}
struct Policy<F>(F);
impl<F: Fn(&PolicyView<'_>, &PolicyEvent, &Value) -> PolicyDecision + Send + Sync> AgentPolicy
    for Policy<F>
{
    fn identity(&self) -> PolicyIdentity {
        identity()
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        Ok((self.0)(view, event, state))
    }
}
fn decision(action: PolicyAction, state: Value) -> PolicyDecision {
    PolicyDecision { action, state }
}
fn execute(f: &Fixture, policy: impl AgentPolicy + 'static) -> ExecutionReport {
    ExecutionEngine {
        persistence: f.db.clone(),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: Arc::new(Provider::default()),
        tools: Arc::new(NoTools),
        policy: Arc::new(policy),
        progress: ProgressSink::default(),
    }
    .run(f.input(), CancellationToken::default())
    .unwrap()
}

/// The injected failure comes after the real durable transaction, like a lost worker response.
struct LoseDeliveryReply(Arc<Mutex<Catalog>>);
impl Persistence for LoseDeliveryReply {
    fn resource_admission(&self) -> Arc<varin_runtime::resource_admission::ResourceAdmission> {
        self.0.resource_admission()
    }
    fn compile_context(
        &self,
        run: &str,
        epoch: u64,
        head: Option<&str>,
    ) -> Result<Option<ContextProjection>, ExecutionError> {
        self.0.compile_context(run, epoch, head)
    }
    fn consume_inputs(
        &self,
        run: &str,
        epoch: u64,
        head: Option<&str>,
    ) -> Result<InputBatch, ExecutionError> {
        self.0.consume_inputs(run, epoch, head)
    }
    fn commit(
        &self,
        run: &str,
        epoch: u64,
        record: &ExecutionRecord,
    ) -> Result<(), ExecutionError> {
        self.0.commit(run, epoch, record)
    }
    fn policy_action(
        &self,
        run: &str,
        epoch: u64,
    ) -> Result<Option<PolicyActionState>, ExecutionError> {
        self.0.policy_action(run, epoch)
    }
    fn policy_boundary(&self, run: &str, epoch: u64) -> Result<PolicyBoundary, ExecutionError> {
        self.0.policy_boundary(run, epoch)
    }
    fn commit_policy_control(
        &self,
        run: &str,
        epoch: u64,
        intent: &PolicyControlIntent,
    ) -> Result<PolicyControlReceipt, ExecutionError> {
        let first = self.0.commit_policy_control(run, epoch, intent)?;
        let revision = self
            .0
            .lock()
            .unwrap()
            .operation(&intent.action_id)
            .unwrap()
            .revision;
        assert_eq!(self.0.commit_policy_control(run, epoch, intent)?, first);
        assert_eq!(
            self.0
                .lock()
                .unwrap()
                .operation(&intent.action_id)
                .unwrap()
                .revision,
            revision
        );
        Err(ExecutionError::new(
            "lost_response",
            "committed transaction response was lost",
        ))
    }
}
#[test]
fn delivery_lost_reply_reopens_once_with_honest_assistant_history() {
    let mut f = Fixture::new();
    let provider = Arc::new(Provider::default());
    let engine = ExecutionEngine {
        persistence: Arc::new(LoseDeliveryReply(f.db.clone())),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: provider.clone(),
        tools: Arc::new(NoTools),
        policy: Arc::new(Policy(
            |_: &PolicyView<'_>, event: &PolicyEvent, state: &Value| {
                assert!(matches!(event, PolicyEvent::Started));
                assert!(state.is_null());
                decision(
                    PolicyAction::Deliver {
                        text: String::new(),
                    },
                    json!({"delivered":true}),
                )
            },
        )),
        progress: ProgressSink::default(),
    };
    assert_eq!(
        engine
            .run(f.input(), CancellationToken::default())
            .unwrap_err()
            .code,
        "lost_response"
    );
    drop(engine);
    content_collection::collect(|| f.db.lock().unwrap().prepare_content_collection(Default::default())).unwrap();
    f.reopen();
    let history = f.db.lock().unwrap().history("main").unwrap();
    assert_eq!(history.len(), 2);
    let item: ConversationItem = serde_json::from_value(history[1].content.clone()).unwrap();
    assert!(
        matches!(item.provenance, Provenance::PolicyOutput { identity: selected, .. } if selected == identity())
    );
    assert_eq!(
        item.content,
        Content::Text {
            text: String::new()
        }
    );
    assert!(history[1].provider.is_none());
    assert!(item.opaque.is_none());
    let report = execute(
        &f,
        Policy(
            |view: &PolicyView<'_>, event: &PolicyEvent, state: &Value| {
                assert_eq!(state, &json!({"delivered":true}));
                let PolicyEvent::Delivered { item_id, .. } = event else {
                    panic!("{event:?}");
                };
                assert_eq!(&view.history.last().unwrap().id, item_id);
                decision(
                    PolicyAction::Pause {
                        reason: "等我确认 🧭".into(),
                    },
                    json!({"paused":true}),
                )
            },
        ),
    );
    assert_eq!(report.state, RunState::Waiting);
    let launch =
        f.db.lock()
            .unwrap()
            .launch_intent(&f.input.run_id)
            .unwrap()
            .unwrap();
    assert!(!launch.startable);
    assert_eq!(launch.pause.unwrap().reason, "等我确认 🧭");
    assert_eq!(f.db.lock().unwrap().history("main").unwrap().len(), 2);
    assert!(provider.requests.lock().unwrap().is_empty());
    let connection = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM model_steps", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn pause_reopen_blocks_worker_admission_and_old_resume_cannot_release_new_pause() {
    let mut f = Fixture::new();
    let report = execute(
        &f,
        Policy(|_: &PolicyView<'_>, _: &PolicyEvent, _: &Value| {
            decision(
                PolicyAction::Pause {
                    reason: String::new(),
                },
                json!(1),
            )
        }),
    );
    let first = report.waiting_on.unwrap();
    f.enqueue("new input while paused");
    f.reopen();
    let supervisor = f.supervisor.as_ref().unwrap();
    assert!(supervisor
        .prepare_start(&f.input.run_id, |_| panic!("paused Run must not assemble"))
        .is_err());
    f.db.lock()
        .unwrap()
        .pause_failed_execution(
            &f.input.run_id,
            f.input.owner_generation,
            "late",
            "late failed worker",
        )
        .unwrap();
    assert_eq!(
        f.db.lock()
            .unwrap()
            .run(&f.input.run_id)
            .unwrap()
            .waiting_on
            .as_deref(),
        Some(first.as_str())
    );
    let receipt = supervisor
        .resume_policy_pause(&f.input.run_id, &first)
        .unwrap();
    assert_eq!(
        supervisor
            .resume_policy_pause(&f.input.run_id, &first)
            .unwrap(),
        receipt
    );
    let report = execute(
        &f,
        Policy(
            |view: &PolicyView<'_>, event: &PolicyEvent, state: &Value| {
                assert!(matches!(event, PolicyEvent::Resumed { .. }), "{event:?}");
                assert_eq!(state, &json!(1));
                assert!(view.history.iter().any(|item| matches!(&item.content, Content::Text { text } if text == "new input while paused")));
                decision(
                    PolicyAction::Pause {
                        reason: "second pause".into(),
                    },
                    json!(2),
                )
            },
        ),
    );
    let second = report.waiting_on.unwrap();
    assert_ne!(first, second);
    assert_eq!(
        supervisor
            .resume_policy_pause(&f.input.run_id, &first)
            .unwrap(),
        receipt
    );
    assert_eq!(
        f.db.lock()
            .unwrap()
            .run(&f.input.run_id)
            .unwrap()
            .waiting_on,
        Some(second.clone())
    );
    content_collection::collect(|| f.db.lock().unwrap().prepare_content_collection(Default::default())).unwrap();
    f.reopen();
    let db = f.db.lock().unwrap();
    assert_eq!(
        db.policy_resume_receipt(&f.input.run_id, &first).unwrap(),
        Some(receipt)
    );
    assert_eq!(db.run(&f.input.run_id).unwrap().waiting_on, Some(second));
    assert!(!db.run_startable(&f.input.run_id).unwrap());
}

#[test]
fn obsolete_generic_wait_cannot_overwrite_policy_pause_and_cancel_does_not_hydrate_reason() {
    let f = Fixture::new();
    let epoch = f.input.owner_generation;
    {
        let mut db = f.db.lock().unwrap();
        db.admit_operation("job", &f.input.run_id, epoch, Lifetime::Thread, Value::Null)
            .unwrap();
        db.settle_operation(
            "job",
            epoch,
            Outcome::Succeeded,
            Effect::None,
            json!("done"),
        )
        .unwrap();
        db.register_wait("old-wait", &f.input.run_id, "job", "operation.settled", 0)
            .unwrap();
        assert!(db.claim_resumption("old-wait", epoch).unwrap());
    }
    let paused = execute(
        &f,
        Policy(|_: &PolicyView<'_>, _: &PolicyEvent, _: &Value| {
            decision(
                PolicyAction::Pause {
                    reason: "外置原因".into(),
                },
                json!(1),
            )
        }),
    );
    let wait_id = paused.waiting_on.unwrap();
    let mut db = f.db.lock().unwrap();
    assert!(db.complete_resumption("old-wait", epoch).is_err());
    assert_eq!(
        db.run(&f.input.run_id).unwrap().waiting_on.as_deref(),
        Some(wait_id.as_str())
    );
    let wait = read_wait(&f.root, &wait_id);
    let op = db.operation(&wait.subject).unwrap();
    assert!(db.request_cancel_operation(&op.id).is_err());
    assert!(!db.operation(&op.id).unwrap().cancel_requested);
    assert!(db
        .commit_execution(
            &f.input.run_id,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None
            }
        )
        .is_err());
    let revision = db.run(&f.input.run_id).unwrap().revision;
    assert!(db
        .transition_run(&f.input.run_id, epoch, revision, RunState::Runnable)
        .is_err());
    let hash = op.intent["body_ref"]["content_object"]
        .as_str()
        .unwrap()
        .strip_prefix("sha256-")
        .unwrap();
    std::fs::write(
        f.root
            .join("content/objects")
            .join(&hash[..2])
            .join(&hash[2..]),
        b"damaged",
    )
    .unwrap();
    assert!(db.launch_intent(&f.input.run_id).is_err());
    db.request_cancel_run(&f.input.run_id).unwrap();
    assert!(read_wait(&f.root, &wait_id).cancelled);
    assert_eq!(
        db.operation(&wait.subject).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    assert!(db.policy_resume_receipt(&f.input.run_id, &wait_id).is_err());
}

fn read_wait(root: &std::path::Path, id: &str) -> Wait {
    let db = rusqlite::Connection::open(root.join("conversation.sqlite")).unwrap();
    let body: String = db
        .query_row("SELECT body FROM waits WHERE id=?1", [id], |row| row.get(0))
        .unwrap();
    serde_json::from_str(&body).unwrap()
}

#[derive(Clone, Copy)]
enum RaceAt {
    ControlAdmission,
    ModelAdmission,
    ModelCheckpoint,
}
struct InputRace {
    db: Arc<Mutex<Catalog>>,
    at: RaceAt,
    inserted: std::sync::atomic::AtomicBool,
}
impl InputRace {
    fn insert(&self) {
        if !self
            .inserted
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            self.db
                .lock()
                .unwrap()
                .enqueue_input(&EnqueueInput {
                    key: "winning-input".into(),
                    thread_id: "thread".into(),
                    branch_id: "main".into(),
                    mode: InputMode::Boundary,
                    input: json!({"text":"new history before next action"}),
                    configuration: None,
                })
                .unwrap();
        }
    }
}
impl Persistence for InputRace {
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
        let items = self.db.consume_inputs(r, e, h)?;
        if !items.items.is_empty() {
            return Err(ExecutionError::new(
                "lost_input_delivery",
                "input delivery committed before worker loss",
            ));
        }
        Ok(items)
    }
    fn commit(&self, r: &str, e: u64, record: &ExecutionRecord) -> Result<(), ExecutionError> {
        if matches!(self.at, RaceAt::ModelAdmission)
            && matches!(record, ExecutionRecord::RequestPrepared { .. })
        {
            self.insert();
        }
        self.db.commit(r, e, record)?;
        if matches!(self.at, RaceAt::ModelCheckpoint)
            && matches!(
                record,
                ExecutionRecord::PolicyCheckpoint {
                    action: PolicyAction::RequestModel,
                    ..
                }
            )
        {
            return Err(ExecutionError::new(
                "lost_checkpoint_reply",
                "pending decision remains durable",
            ));
        }
        Ok(())
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
        intent: &PolicyControlIntent,
    ) -> Result<PolicyControlReceipt, ExecutionError> {
        if matches!(self.at, RaceAt::ControlAdmission) {
            self.insert();
        }
        self.db.commit_policy_control(r, e, intent)
    }
}
fn resumed_fixture() -> Fixture {
    let f = Fixture::new();
    let pause = execute(
        &f,
        Policy(|_: &PolicyView<'_>, _: &PolicyEvent, _: &Value| {
            decision(
                PolicyAction::Pause {
                    reason: "review".into(),
                },
                json!({"committed":"pause"}),
            )
        }),
    );
    f.supervisor
        .as_ref()
        .unwrap()
        .resume_policy_pause(&f.input.run_id, pause.waiting_on.as_deref().unwrap())
        .unwrap();
    f
}
#[test]
fn input_winning_delivery_or_model_admission_does_not_advance_unexecuted_private_state() {
    for at in [RaceAt::ControlAdmission, RaceAt::ModelAdmission] {
        let mut f = resumed_fixture();
        let provider = Arc::new(Provider::default());
        let engine = ExecutionEngine {
            persistence: Arc::new(InputRace {
                db: f.db.clone(),
                at,
                inserted: Default::default(),
            }),
            context_preparation: Arc::new(NoopContextPreparation),
            provider: provider.clone(),
            tools: Arc::new(NoTools),
            policy: Arc::new(Policy(
                move |_: &PolicyView<'_>, event: &PolicyEvent, state: &Value| {
                    assert!(matches!(event, PolicyEvent::Resumed { .. }));
                    assert_eq!(state, &json!({"committed":"pause"}));
                    decision(
                        if matches!(at, RaceAt::ControlAdmission) {
                            PolicyAction::Deliver {
                                text: "stale decision".into(),
                            }
                        } else {
                            PolicyAction::RequestModel
                        },
                        json!({"unexecuted":"must not leak"}),
                    )
                },
            )),
            progress: ProgressSink::default(),
        };
        assert_eq!(
            engine
                .run(f.input(), CancellationToken::default())
                .unwrap_err()
                .code,
            "lost_input_delivery"
        );
        assert!(provider.requests.lock().unwrap().is_empty());
        drop(engine);
        f.reopen();
        let report = execute(
            &f,
            Policy(
                |view: &PolicyView<'_>, event: &PolicyEvent, state: &Value| match event {
                    PolicyEvent::Resumed { .. } => {
                        assert_eq!(state, &json!({"committed":"pause"}));
                        assert!(view.history.iter().any(|item| matches!(&item.content, Content::Text { text } if text == "new history before next action")));
                        decision(
                            PolicyAction::Deliver {
                                text: "revised after input".into(),
                            },
                            json!({"committed":"delivery"}),
                        )
                    }
                    PolicyEvent::Delivered { .. } => {
                        assert_eq!(state, &json!({"committed":"delivery"}));
                        decision(PolicyAction::Complete, state.clone())
                    }
                    _ => panic!("completion was lost: {event:?}"),
                },
            ),
        );
        assert_eq!(report.state, RunState::Completed);
        let history = f.db.lock().unwrap().history("main").unwrap();
        assert_eq!(history.len(), 3);
        assert!(!serde_json::to_string(&history)
            .unwrap()
            .contains("stale decision"));
    }
}
#[test]
fn pending_model_decision_after_resume_reopens_without_redeciding_or_losing_its_state() {
    let mut f = resumed_fixture();
    let engine = ExecutionEngine {
        persistence: Arc::new(InputRace {
            db: f.db.clone(),
            at: RaceAt::ModelCheckpoint,
            inserted: Default::default(),
        }),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: Arc::new(Provider::default()),
        tools: Arc::new(NoTools),
        policy: Arc::new(Policy(
            |_: &PolicyView<'_>, event: &PolicyEvent, _: &Value| {
                assert!(matches!(event, PolicyEvent::Resumed { .. }));
                decision(PolicyAction::RequestModel, json!({"pending":"model"}))
            },
        )),
        progress: ProgressSink::default(),
    };
    assert_eq!(
        engine
            .run(f.input(), CancellationToken::default())
            .unwrap_err()
            .code,
        "lost_checkpoint_reply"
    );
    drop(engine);
    f.reopen();
    let report = execute(
        &f,
        Policy(|_: &PolicyView<'_>, event: &PolicyEvent, state: &Value| {
            assert!(
                matches!(event, PolicyEvent::ModelCompleted { .. }),
                "pending decision must execute before next policy call: {event:?}"
            );
            assert_eq!(state, &json!({"pending":"model"}));
            decision(PolicyAction::Complete, state.clone())
        }),
    );
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(report.model_steps, 1);
}

#[test]
fn old_resume_receipt_does_not_quiesce_a_new_live_worker() {
    let f = Fixture::new();
    let paused = execute(
        &f,
        Policy(|_: &PolicyView<'_>, _: &PolicyEvent, _: &Value| {
            decision(
                PolicyAction::Pause {
                    reason: "review".into(),
                },
                json!(1),
            )
        }),
    );
    let wait_id = paused.waiting_on.unwrap();
    let supervisor = f.supervisor.as_ref().unwrap().clone();
    let receipt = supervisor
        .resume_policy_pause(&f.input.run_id, &wait_id)
        .unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    struct BlockingProvider {
        started: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl ModelProvider for BlockingProvider {
        fn serialize(&self, request: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(request).unwrap())
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            cancel: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            self.started.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            assert!(!cancel.is_cancelled());
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: "answer".into(),
                    content: Content::Text {
                        text: "still running".into(),
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
    let handle = supervisor
        .start(
            &f.input.run_id,
            varin_runtime::supervisor::RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding: f.input.binding.clone(),
                policy_state: Value::Null,
                provider: Arc::new(BlockingProvider {
                    started: started_tx,
                    release: Mutex::new(release_rx),
                }),
                tools: Arc::new(NoTools),
                policy: Arc::new(Policy(
                    |_: &PolicyView<'_>, event: &PolicyEvent, state: &Value| match event {
                        PolicyEvent::Resumed { .. } => {
                            decision(PolicyAction::RequestModel, json!(2))
                        }
                        PolicyEvent::ModelCompleted { .. } => {
                            decision(PolicyAction::Complete, state.clone())
                        }
                        _ => panic!("unexpected event {event:?}"),
                    },
                )),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    started_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert!(!supervisor.start_available(&f.input.run_id).unwrap());
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    let retry = std::thread::spawn({
        let supervisor = supervisor.clone();
        let run = f.input.run_id.clone();
        move || {
            reply_tx
                .send(supervisor.resume_policy_pause(&run, &wait_id))
                .unwrap()
        }
    });
    let result = reply_rx.recv_timeout(std::time::Duration::from_secs(2));
    let still_owned = !supervisor.start_available(&f.input.run_id).unwrap();
    release_tx.send(()).unwrap();
    retry.join().unwrap();
    assert_eq!(
        result
            .expect("old resume tried to join a different live worker")
            .unwrap(),
        receipt
    );
    assert!(still_owned);
    assert_eq!(handle.wait().unwrap().state, RunState::Completed);
}
