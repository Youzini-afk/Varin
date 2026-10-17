#[path = "../tests/fixtures/content_collection.rs"]
mod content_collection;
use super::*;
use crate::test_submission::InputAdmission;
use crate::{Catalog, SubmitInput};
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct Fixture {
    path: std::path::PathBuf,
}

#[test]
fn progress_coalesces_bursts_without_blocking_or_losing_content() {
    let (sink, mut receiver) = ProgressSink::channel();
    for _ in 0..4096 {
        sink.emit("run", "request", ExecutionEvent::Provider(ProviderEvent::TextDelta { item_id: "message".into(), text: "字".into() }));
    }
    sink.emit("run", "next", ExecutionEvent::Provider(ProviderEvent::ReasoningDelta { item_id: "thinking".into(), text: "next reasoning".into() }));
    let batches = receiver.next().unwrap();
    assert_eq!(batches.len(), 2);
    assert_eq!(batches[0].events.len(), 1);
    assert!(matches!(&batches[0].events[0], ExecutionEvent::Provider(ProviderEvent::TextDelta { text, .. }) if text == &"字".repeat(4096)));
    assert_eq!(batches[1].request_id, "next");
    drop(sink);
    assert!(receiver.next().is_none());
}
impl Fixture {
    fn new() -> Self {
        Self {
            path: std::env::temp_dir().join(format!("varin-engine-{}", uuid::Uuid::new_v4())),
        }
    }
    fn catalog(&self) -> Arc<Mutex<Catalog>> {
        Arc::new(Mutex::new(Catalog::open(&self.path).unwrap()))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
fn input(db: &Arc<Mutex<Catalog>>) -> ExecutionInput { input_with_bot(db, None) }
fn input_with_bot(db: &Arc<Mutex<Catalog>>, bot: Option<&str>) -> ExecutionInput {
    input_with_payload(db, bot, json!({"text":"read then answer"}))
}
fn input_with_payload(db: &Arc<Mutex<Catalog>>, bot: Option<&str>, payload: Value) -> ExecutionInput {
    input_with_frozen_context(db, bot, payload, None, None)
}
fn input_with_frozen_context(
    db: &Arc<Mutex<Catalog>>,
    bot: Option<&str>,
    payload: Value,
    checkpoint: Option<crate::catalog::context::ContextProposal>,
    basis: Option<crate::catalog::personalization::PersonalizationBasis>,
) -> ExecutionInput {
    let mut db = db.lock().unwrap();
    if let Some(bot) = bot { db.create_bot_thread("thread", "main", bot).unwrap(); }
    else { db.create_thread("thread", "main").unwrap(); }
    let receipt = db
        .submit_with_context_snapshot(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: payload,
            configuration: json!({"provider":"test"}),
        }, None, false, checkpoint, basis)
        .unwrap();
    ExecutionInput {
        run_id: receipt.run_id,
        owner_generation: db.epoch(),
        binding: RequestBinding {
            request_context: None,
            child_dispatch: None,
            goal: None,
            resource_activations: Vec::new(),
            resource_checkpoint_id: None,
            connection_identity: "fixture-connection".into(),
            provider_family: "test".into(),
            model: "test-model".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: vec![ToolSchema {
                requirements: None,
                description: String::new(),
                output_schema: None,
                metadata: None,
                name: "read".into(),
                version: "1".into(),
                schema: json!({"type":"object"}),
            }],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: "main".into(),
                ancestor_id: None,
                leaf_id: Some(receipt.input_id),
            },
        },
        history: db.execution_history("main").unwrap(),
        policy_state: Value::Null,
        completed_model_steps: 0,
    }
}
#[derive(Default)]
struct Tools {
    calls: AtomicUsize,
}

#[test]
fn request_commit_validates_the_exact_available_cut_of_the_frozen_launch() {
    use crate::catalog::launches::{AgentSelection, LaunchSelection};
    let fixture = Fixture::new();
    let db = fixture.catalog();
    let mut original = input(&db);
    let mut hidden = original.binding.tools[0].clone();
    hidden.name = "hidden".into();
    let mut goal = hidden.clone();
    goal.name = "goal_report".into();
    original.binding.tools.extend([hidden.clone(), goal]);
    original.binding.tools.extend(crate::tool_disclosure::schemas());
    let mut selection = LaunchSelection::from_binding(&original.binding,
        PolicyIdentity { name: "test".into(), version: "1".into() }, None);
    selection.agent = Some(AgentSelection { profile_id: None, name: None, work_focus: "code".into(), tools: Some(vec!["read".into()]) });
    db.lock().unwrap().bind_launch(&original.run_id, selection).unwrap();
    let mut binding = original.binding.clone();
    binding.tools = crate::tool_disclosure::request_tools(&binding.tools, false, Some(&["read".into()]));
    let snapshot = RequestSnapshot { view: RequestView {
        request_id: "available-cut".into(), run_id: original.run_id.clone(),
        origin: RequestOrigin::Conversation { compaction: None, step: 1, history_range: binding.history_range.clone() },
        binding, history: original.history,
    }, serialized: json!({"input": "fixture"}).into() };
    for tamper in 0..3 {
        let mut changed = snapshot.clone();
        match tamper {
            0 => changed.view.binding.tools.push(hidden.clone()),
            1 => changed.view.binding.tools[0].schema = json!({"type":"string"}),
            _ => { changed.view.binding.tools.pop(); },
        }
        assert!(db.lock().unwrap().commit_execution(&original.run_id, original.owner_generation,
            &ExecutionRecord::RequestPrepared { snapshot: changed.into() }).is_err());
    }
    db.lock().unwrap().commit_execution(&original.run_id, original.owner_generation,
        &ExecutionRecord::RequestPrepared { snapshot: snapshot.into() }).unwrap();
}
impl ToolExecutor for Tools {
    fn plan(
        &self,
        call: &crate::execution::ToolCall,
        context: &crate::execution::FrozenToolContext,
        cancel: &crate::execution::CancellationToken,
    ) -> Result<crate::execution::ToolPreparation, crate::execution::ExecutionError> {
        self.prepare(call, context, cancel)
            .map(crate::execution::ToolPreparation::Ready)
    }

    fn prepare(
        &self,
        call: &ToolCall,
        _: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: true,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![ResourceClaim {
                key: "file".into(),
                access: Access::Read,
            }],
        })
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Ok(())
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        self.calls.fetch_add(1, Ordering::SeqCst);
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::None,
            content: json!("actual bytes").into(),
        }
    }
}
struct Provider {
    calls: AtomicUsize,
    mode: Mode,
    cancel: CancellationToken,
}
#[derive(Clone, Copy)]
enum Mode {
    ToolThenAnswer,
    CancelPrepared,
    PartialFailure,
}
impl ModelProvider for Provider {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
        if matches!(self.mode, Mode::CancelPrepared) {
            self.cancel.cancel();
        }
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let send = |emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>, event| {
            emit(event).map_err(|e| ModelFailure {
                code: e.code,
                message: e.message,
                retry_after_ms: None,
                provider_request_id: None,
            })
        };
        if matches!(self.mode, Mode::PartialFailure) {
            send(
                emit,
                ProviderEvent::ToolArgumentsDelta {
                    call_id: "partial".into(),
                    delta: "{\"path\":".into(),
                },
            )?;
            return Err(ModelFailure {
                code: "stream_lost".into(),
                message: "connection lost".into(),
                retry_after_ms: None,
                provider_request_id: Some("remote-request".into()),
            });
        }
        if call == 0 {
            send(
                emit,
                ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: "opaque".into(),
                        content: Content::ProviderOnly,
                        opaque: Some(OpaqueProviderItem {
                            connection_identity: "fixture-connection".into(),
                            family: "test".into(),
                            adapter_version: "1".into(),
                            value: json!({"signature":[null,42,"unaltered"]}),
                        }),
                    },
                },
            )?;
            send(
                emit,
                ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: "call-item".into(),
                        content: Content::ToolCall {
                            call: ToolCall {
                                call_id: "call-1".into(),
                                name: "read".into(),
                                schema_version: "1".into(),
                                arguments: json!({}),
                            },
                        },
                        opaque: None,
                    },
                },
            )?;
            Ok(FinishReason::ToolCalls)
        } else {
            assert!(request.view.history.iter().any(|item|matches!(&item.content,Content::ToolResult{result} if result.call_id=="call-1")));
            assert!(request.view.history.iter().any(|item| {
                item.opaque
                    .as_ref()
                    .is_some_and(|o| o.value == json!({"signature":[null,42,"unaltered"]}))
            }));
            send(
                emit,
                ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: "answer".into(),
                        content: Content::Text {
                            text: "done".into(),
                        },
                        opaque: None,
                    },
                },
            )?;
            Ok(FinishReason::Stop)
        }
    }
}
fn engine(
    db: Arc<Mutex<Catalog>>,
    mode: Mode,
    cancel: CancellationToken,
    progress: ProgressSink,
) -> ExecutionEngine<Mutex<Catalog>, Provider, Tools, DefaultAgentPolicy> {
    ExecutionEngine {
        context_preparation: Arc::new(NoopContextPreparation),
        persistence: db,
        provider: Arc::new(Provider {
            calls: AtomicUsize::new(0),
            mode,
            cancel,
        }),
        tools: Arc::new(Tools::default()),
        policy: Arc::new(DefaultAgentPolicy),
        progress,
    }
}
#[test]
fn actual_catalog_two_model_tool_exchange_survives_reopen_with_opaque_original() {
    let f = Fixture::new();
    let db = f.catalog();
    let input = input(&db);
    let run_id = input.run_id.clone();
    let cancel = CancellationToken::default();
    let (progress, _never_consumed) = ProgressSink::channel();
    let engine = engine(db.clone(), Mode::ToolThenAnswer, cancel.clone(), progress);
    let report = engine.run(input, cancel).unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(engine.tools.calls.load(Ordering::SeqCst), 1);
    assert_eq!(engine.provider.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        db.lock().unwrap().run(&run_id).unwrap().state,
        RunState::Completed
    );
    drop(engine);
    drop(db);
    let db = f.catalog();
    let history = db.lock().unwrap().execution_history("main").unwrap();
    assert_eq!(history.len(), 5);
    assert!(history.iter().any(|i| {
        i.opaque
            .as_ref()
            .is_some_and(|o| o.value == json!({"signature":[null,42,"unaltered"]}))
    }));
    assert!(matches!(&history.last().unwrap().content,Content::Text{text} if text=="done"));
}
#[test]
fn cancelled_after_serialization_settles_prepared_step_without_provider_dispatch() {
    let f = Fixture::new();
    let db = f.catalog();
    let input = input(&db);
    let run_id = input.run_id.clone();
    let cancel = CancellationToken::default();
    let engine = engine(
        db.clone(),
        Mode::CancelPrepared,
        cancel.clone(),
        ProgressSink::default(),
    );
    let report = engine.run(input, cancel).unwrap();
    assert_eq!(report.state, RunState::Cancelled);
    assert_eq!(engine.provider.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        db.lock().unwrap().run(&run_id).unwrap().state,
        RunState::Cancelled
    );
}
#[test]
fn interrupted_partial_tool_arguments_never_execute_and_remain_nonzero_unknown_usage() {
    let f = Fixture::new();
    let db = f.catalog();
    let input = input(&db);
    let request = format!("{}:{}:1", input.run_id, input.owner_generation);
    let cancel = CancellationToken::default();
    let engine = engine(
        db.clone(),
        Mode::PartialFailure,
        cancel.clone(),
        ProgressSink::default(),
    );
    let report = engine.run(input, cancel).unwrap();
    assert_eq!(report.state, RunState::Failed);
    assert_eq!(engine.tools.calls.load(Ordering::SeqCst), 0);
    let step = db.lock().unwrap().model_step(&request).unwrap();
    assert_eq!(step.state, crate::ModelStepState::Interrupted);
    assert_eq!(step.usage.unwrap()["measurement"], "missing");
    assert_eq!(db.lock().unwrap().history("main").unwrap().len(), 1);
}

#[test]
fn supervisor_control_reaches_provider_while_catalog_is_locked() {
    struct WaitingProvider {
        started: std::sync::mpsc::Sender<()>,
        stopped: std::sync::mpsc::Sender<()>,
    }
    impl ModelProvider for WaitingProvider {
        fn serialize(&self, v: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap().into())
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            cancel: &CancellationToken,
            _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            self.started.send(()).unwrap();
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(cancel.cancelled());
            self.stopped.send(()).unwrap();
            Err(ModelFailure {
                code: "cancelled".into(),
                message: "provider observed cancellation".into(),
                retry_after_ms: None,
                provider_request_id: None,
            })
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    let input = input(&db);
    let run_id = input.run_id.clone();
    let catalog = match Arc::try_unwrap(db) {
        Ok(db) => db.into_inner().unwrap(),
        Err(_) => panic!("unexpected shared catalog"),
    };
    let supervisor = crate::supervisor::RunSupervisor::new(catalog);
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (stopped_tx, stopped_rx) = std::sync::mpsc::channel();
    let handle = supervisor
        .start(
            &run_id,
            crate::supervisor::RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding: input.binding,
                policy_state: Value::Null,
                provider: Arc::new(WaitingProvider {
                    started: started_tx,
                    stopped: stopped_tx,
                }),
                tools: Arc::new(Tools::default()),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    started_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let catalog = supervisor.catalog();
    let held = catalog.lock().unwrap();
    assert!(supervisor.cancel_control(&run_id));
    let cancellation_observed = stopped_rx.recv_timeout(std::time::Duration::from_secs(3));
    drop(held);
    assert!(
        cancellation_observed.is_ok(),
        "control waited on Catalog before signalling the provider"
    );
    assert_eq!(handle.wait().unwrap().state, RunState::Cancelled);
    supervisor.shutdown().unwrap();
}

#[test]
fn cold_run_assembly_is_independent_and_cancellation_prevents_model_dispatch() {
    use crate::supervisor::{RunStart, RunSupervisor};
    let f = Fixture::new();
    let db = f.catalog();
    let first = input(&db);
    let second = {
        let mut owner = db.lock().unwrap();
        owner.create_thread("independent", "independent").unwrap();
        owner
            .submit(&SubmitInput {
                key: "independent".into(),
                thread_id: "independent".into(),
                branch_id: "independent".into(),
                expected_head: None,
                input: json!({"text":"answer"}),
                configuration: json!({"provider":"test"}),
            })
            .unwrap()
    };
    let catalog = Arc::try_unwrap(db).ok().unwrap().into_inner().unwrap();
    let supervisor = RunSupervisor::new(catalog);
    let make_start = |binding| RunStart {
        binding,
        context_preparation: Arc::new(NoopContextPreparation),
        policy_state: Value::Null,
        provider: Arc::new(Provider {
            calls: AtomicUsize::new(0),
            mode: Mode::ToolThenAnswer,
            cancel: CancellationToken::default(),
        }),
        tools: Arc::new(Tools::default()),
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    };
    let mut first_start = make_start(first.binding.clone());
    let first_provider = Arc::new(Provider {
        calls: AtomicUsize::new(0),
        mode: Mode::ToolThenAnswer,
        cancel: CancellationToken::default(),
    });
    first_start.provider = first_provider.clone();
    let (started, entered) = std::sync::mpsc::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let (observed, cancellation) = std::sync::mpsc::channel();
    let handle = supervisor
        .prepare_start(&first.run_id, move |cancel| {
            started.send(()).unwrap();
            gate.recv().unwrap();
            observed.send(cancel.is_cancelled()).unwrap();
            Ok(first_start)
        })
        .unwrap();
    entered
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let mut binding = first.binding;
    binding.history_range = HistoryRange {
        branch_id: "independent".into(),
        ancestor_id: None,
        leaf_id: Some(second.input_id),
    };
    let independent = supervisor
        .start(&second.run_id, make_start(binding))
        .unwrap();
    let (done, completion) = std::sync::mpsc::channel();
    let waiter = std::thread::spawn(move || done.send(independent.wait()).unwrap());
    let independent_result = completion.recv_timeout(std::time::Duration::from_secs(3));
    let cancelled = supervisor.cancel(&first.run_id);
    release.send(()).unwrap();
    let observed = cancellation
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let report = handle.wait().unwrap();
    waiter.join().unwrap();
    assert!(
        independent_result.is_ok(),
        "cold assembly blocked an independent Run"
    );
    assert_eq!(
        independent_result.unwrap().unwrap().state,
        RunState::Completed
    );
    assert_eq!(cancelled.unwrap().state, RunState::Cancelled);
    assert!(observed);
    assert_eq!(report.state, RunState::Cancelled);
    assert_eq!(first_provider.calls.load(Ordering::SeqCst), 0);
    supervisor.shutdown().unwrap();
}

#[test]
fn worker_commit_conflict_cannot_leave_a_workerless_run_generating() {
    struct ConcurrentInput {
        catalog: Arc<Mutex<Catalog>>,
    }
    impl ModelProvider for ConcurrentInput {
        fn serialize(&self, view: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
            Ok(serde_json::to_value(view).unwrap().into())
        }
        fn generate(
            &self,
            request: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            let mut db = self.catalog.lock().unwrap();
            let epoch = db.epoch();
            db.append_history(
                &request.view.run_id,
                epoch,
                request.view.binding.history_range.leaf_id.as_deref(),
                crate::HistorySource::User,
                json!({"text":"a newly arrived correction"}),
                None,
            )
            .unwrap();
            drop(db);
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: "obsolete-answer".into(),
                    content: Content::Text {
                        text: "answer to old input".into(),
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    let input = input(&db);
    let run_id = input.run_id.clone();
    let request_id = format!("{}:{}:1", run_id, input.owner_generation);
    let catalog = match Arc::try_unwrap(db) {
        Ok(db) => db.into_inner().unwrap(),
        Err(_) => panic!("unexpected shared catalog"),
    };
    let supervisor = crate::supervisor::RunSupervisor::new(catalog);
    let db = supervisor.catalog();
    let handle = supervisor
        .start(
            &run_id,
            crate::supervisor::RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding: input.binding,
                policy_state: Value::Null,
                provider: Arc::new(ConcurrentInput {
                    catalog: db.clone(),
                }),
                tools: Arc::new(Tools::default()),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    assert!(
        handle.wait().is_err(),
        "stale output must not commit over the newer input"
    );
    supervisor.shutdown().unwrap();
    let run = db.lock().unwrap().run(&run_id).unwrap();
    assert!(
        matches!(run.state, RunState::Failed | RunState::Waiting),
        "worker has exited after conflict but Run still reports {:?}",
        run.state
    );
    assert!(supervisor.execution_failure(&run_id).unwrap().is_some());
    assert!(run.waiting_on.is_some());
    content_collection::collect(|| {
        db.lock()
            .unwrap()
            .prepare_content_collection(Default::default())
    })
    .unwrap();
    let retained = db
        .lock()
        .unwrap()
        .model_output(&request_id)
        .unwrap()
        .unwrap();
    assert_eq!(retained["status"], "rejected");
    assert_eq!(retained["record"]["items"][0]["id"], "obsolete-answer");
    assert!(
        !db.lock()
            .unwrap()
            .history("main")
            .unwrap()
            .iter()
            .any(|item| item.id == "obsolete-answer")
    );
    drop(db);
    drop(supervisor);
    let reopened = f.catalog();
    content_collection::collect(|| {
        reopened
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default())
    })
    .unwrap();
    assert_eq!(
        reopened.lock().unwrap().run(&run_id).unwrap().state,
        RunState::Waiting
    );
    assert_eq!(
        reopened
            .lock()
            .unwrap()
            .model_output(&request_id)
            .unwrap()
            .unwrap(),
        retained
    );
}
#[test]
fn independent_fast_tool_finishes_while_another_tool_is_still_running() {
    struct BatchProvider(AtomicUsize);
    impl ModelProvider for BatchProvider {
        fn serialize(&self, v: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap().into())
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                for name in ["slow", "fast"] {
                    emit(ProviderEvent::ItemCompleted {
                        item: ProviderItem {
                            id: format!("item-{name}"),
                            content: Content::ToolCall {
                                call: ToolCall {
                                    call_id: name.into(),
                                    name: name.into(),
                                    schema_version: "1".into(),
                                    arguments: json!({}),
                                },
                            },
                            opaque: None,
                        },
                    })
                    .unwrap();
                }
                Ok(FinishReason::ToolCalls)
            } else {
                emit(ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: "answer".into(),
                        content: Content::Text {
                            text: "both settled".into(),
                        },
                        opaque: None,
                    },
                })
                .unwrap();
                Ok(FinishReason::Stop)
            }
        }
    }
    struct IndependentTools {
        slow_started: std::sync::mpsc::Sender<()>,
        release_slow: Mutex<std::sync::mpsc::Receiver<()>>,
        fast_done: std::sync::mpsc::Sender<()>,
    }
    impl ToolExecutor for IndependentTools {
        fn plan(
            &self,
            call: &crate::execution::ToolCall,
            context: &crate::execution::FrozenToolContext,
            cancel: &crate::execution::CancellationToken,
        ) -> Result<crate::execution::ToolPreparation, crate::execution::ExecutionError> {
            self.prepare(call, context, cancel)
                .map(crate::execution::ToolPreparation::Ready)
        }

        fn prepare(
            &self,
            call: &ToolCall,
            _: &FrozenToolContext,
            _cancel: &CancellationToken,
        ) -> Result<ToolContract, ExecutionError> {
            Ok(ToolContract {
                name: call.name.clone(),
                schema_version: "1".into(),
                read_only: true,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![ResourceClaim {
                    key: call.name.clone(),
                    access: Access::Read,
                }],
            })
        }
        fn authorize(
            &self,
            _: &ToolExecutionContext,
            _: &ToolCall,
            _: &ToolContract,
            _: &CancellationToken,
        ) -> Result<(), ExecutionError> {
            Ok(())
        }
        fn execute(
            &self,
            _: &ToolExecutionContext,
            call: &ToolCall,
            _: &ToolContract,
            _: &CancellationToken,
        ) -> ToolCompletion {
            if call.name == "slow" {
                self.slow_started.send(()).unwrap();
                self.release_slow.lock().unwrap().recv().unwrap();
            } else {
                self.fast_done.send(()).unwrap();
            }
            ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: json!(call.name).into(),
            }
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    let mut input = input(&db);
    input.binding.tools = ["slow", "fast"]
        .into_iter()
        .map(|name| ToolSchema {
            requirements: None,
            description: String::new(),
            output_schema: None,
            metadata: None,
            name: name.into(),
            version: "1".into(),
            schema: json!({"type":"object"}),
        })
        .collect();
    let (start_tx, start_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (fast_tx, fast_rx) = std::sync::mpsc::channel();
    let engine = ExecutionEngine {
        context_preparation: Arc::new(NoopContextPreparation),
        persistence: db,
        provider: Arc::new(BatchProvider(AtomicUsize::new(0))),
        tools: Arc::new(IndependentTools {
            slow_started: start_tx,
            release_slow: Mutex::new(release_rx),
            fast_done: fast_tx,
        }),
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    };
    let worker = std::thread::spawn(move || engine.run(input, CancellationToken::default()));
    let slow_started = start_rx.recv_timeout(std::time::Duration::from_secs(3));
    let fast_finished = fast_rx.recv_timeout(std::time::Duration::from_secs(3));
    let _ = release_tx.send(());
    let report = worker.join().unwrap().unwrap();
    assert!(slow_started.is_ok());
    assert!(
        fast_finished.is_ok(),
        "independent tool waited for the slow predecessor"
    );
    assert_eq!(report.state, RunState::Completed);
}

#[test]
fn cancelling_one_queued_operation_does_not_fail_its_run_or_execute_it() {
    struct TwoWrites(AtomicUsize);
    impl ModelProvider for TwoWrites {
        fn serialize(&self, v: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap().into())
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                for name in ["first", "queued"] {
                    emit(ProviderEvent::ItemCompleted {
                        item: ProviderItem {
                            id: format!("item-{name}"),
                            content: Content::ToolCall {
                                call: ToolCall {
                                    call_id: name.into(),
                                    name: name.into(),
                                    schema_version: "1".into(),
                                    arguments: json!({}),
                                },
                            },
                            opaque: None,
                        },
                    })
                    .unwrap();
                }
                Ok(FinishReason::ToolCalls)
            } else {
                emit(ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: "answer".into(),
                        content: Content::Text {
                            text: "first completed, second cancelled".into(),
                        },
                        opaque: None,
                    },
                })
                .unwrap();
                Ok(FinishReason::Stop)
            }
        }
    }
    struct Writes {
        started: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
        queued_calls: AtomicUsize,
    }
    impl ToolExecutor for Writes {
        fn plan(
            &self,
            call: &crate::execution::ToolCall,
            context: &crate::execution::FrozenToolContext,
            cancel: &crate::execution::CancellationToken,
        ) -> Result<crate::execution::ToolPreparation, crate::execution::ExecutionError> {
            self.prepare(call, context, cancel)
                .map(crate::execution::ToolPreparation::Ready)
        }

        fn prepare(
            &self,
            call: &ToolCall,
            _: &FrozenToolContext,
            _cancel: &CancellationToken,
        ) -> Result<ToolContract, ExecutionError> {
            Ok(ToolContract {
                name: call.name.clone(),
                schema_version: "1".into(),
                read_only: false,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![ResourceClaim {
                    key: "same-file".into(),
                    access: Access::Write,
                }],
            })
        }
        fn authorize(
            &self,
            _: &ToolExecutionContext,
            _: &ToolCall,
            _: &ToolContract,
            _: &CancellationToken,
        ) -> Result<(), ExecutionError> {
            Ok(())
        }
        fn execute(
            &self,
            _: &ToolExecutionContext,
            call: &ToolCall,
            _: &ToolContract,
            _: &CancellationToken,
        ) -> ToolCompletion {
            if call.name == "first" {
                self.started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            } else {
                self.queued_calls.fetch_add(1, Ordering::SeqCst);
            }
            ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::Confirmed,
                content: json!(call.name).into(),
            }
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    let mut input = input(&db);
    input.binding.tools = ["first", "queued"]
        .into_iter()
        .map(|name| ToolSchema {
            requirements: None,
            description: String::new(),
            output_schema: None,
            metadata: None,
            name: name.into(),
            version: "1".into(),
            schema: json!({"type":"object"}),
        })
        .collect();
    let queued_id = format!("{}:{}:1:tool:queued", input.run_id, input.owner_generation);
    let catalog = match Arc::try_unwrap(db) {
        Ok(db) => db.into_inner().unwrap(),
        Err(_) => panic!("unexpected shared catalog"),
    };
    let supervisor = crate::supervisor::RunSupervisor::new(catalog);
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let tools = Arc::new(Writes {
        started: started_tx,
        release: Mutex::new(release_rx),
        queued_calls: AtomicUsize::new(0),
    });
    let handle = supervisor
        .start(
            &input.run_id,
            crate::supervisor::RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding: input.binding,
                policy_state: Value::Null,
                provider: Arc::new(TwoWrites(AtomicUsize::new(0))),
                tools: tools.clone(),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    started_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    // First executor entry does not imply the independent successor has finished admission.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while supervisor
        .catalog()
        .lock()
        .unwrap()
        .operation(&queued_id)
        .is_err()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "queued intent was not admitted"
        );
        std::thread::yield_now();
    }
    // Force the real fast-control/slow-Catalog ordering: the worker first settles
    // Cancelled and finishes the Run, then the explicit request records its intent.
    assert!(supervisor.cancel_operation_control(&queued_id));
    release_tx.send(()).unwrap();
    let report = handle.wait();
    assert!(
        report.is_ok(),
        "queued-operation cancellation aborted the whole worker: {report:?}"
    );
    assert_eq!(report.unwrap().state, RunState::Completed);
    assert_eq!(tools.queued_calls.load(Ordering::SeqCst), 0);
    let before = supervisor
        .catalog()
        .lock()
        .unwrap()
        .operation(&queued_id)
        .unwrap();
    assert_eq!(before.outcome, Some(Outcome::Cancelled));
    assert!(!before.cancel_requested);
    let cancelled = supervisor.cancel_operation(&queued_id).unwrap();
    let mut expected = before;
    expected.cancel_requested = true;
    expected.revision += 1;
    assert_eq!(
        cancelled, expected,
        "record the request without rewriting its original result"
    );
    assert_eq!(
        supervisor.cancel_operation(&queued_id).unwrap(),
        cancelled,
        "repeated intent is idempotent"
    );
    let first_id = queued_id.replace(":tool:queued", ":tool:first");
    let completed = supervisor
        .catalog()
        .lock()
        .unwrap()
        .operation(&first_id)
        .unwrap();
    assert_eq!(completed.outcome, Some(Outcome::Succeeded));
    assert_eq!(supervisor.cancel_operation(&first_id).unwrap(), completed);
    assert!(
        !supervisor
            .catalog()
            .lock()
            .unwrap()
            .run(&input.run_id)
            .unwrap()
            .cancel_requested
    );
    supervisor.shutdown().unwrap();
    assert_eq!(
        supervisor
            .catalog()
            .lock()
            .unwrap()
            .operation(&queued_id)
            .unwrap()
            .outcome,
        Some(Outcome::Cancelled)
    );
}

#[test]
fn cancelling_an_admitted_unstarted_run_releases_its_branch() {
    let f = Fixture::new();
    let db = f.catalog();
    let input = input(&db);
    let run_id = input.run_id;
    let catalog = match Arc::try_unwrap(db) {
        Ok(db) => db.into_inner().unwrap(),
        Err(_) => panic!("unexpected shared catalog"),
    };
    let supervisor = crate::supervisor::RunSupervisor::new(catalog);
    let cancelled = supervisor.cancel(&run_id).unwrap();
    assert_eq!(
        cancelled.state,
        RunState::Cancelled,
        "unstarted cancellation became a permanent request flag with no worker able to settle it"
    );
    let db = supervisor.catalog();
    let mut db = db.lock().unwrap();
    let head = db.head("main").unwrap();
    assert!(
        db.submit(&SubmitInput {
            key: "next".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: head,
            input: json!({"text":"next work"}),
            configuration: json!({"provider":"test"})
        })
        .is_ok()
    );
}

#[test]
fn input_arriving_between_completion_decision_and_commit_is_not_lost() {
    struct AnswerProvider(AtomicUsize);
    impl ModelProvider for AnswerProvider {
        fn serialize(&self, v: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap().into())
        }
        fn generate(
            &self,
            request: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            let count = self.0.fetch_add(1, Ordering::SeqCst);
            if count == 1 {
                assert!(request.view.history.iter().any(
                    |item| matches!(&item.content,Content::Text{text} if text=="late correction")
                ));
            }
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: format!("answer-{count}"),
                    content: Content::Text {
                        text: format!("answer {count}"),
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
    struct GatedDecision {
        paused: AtomicBool,
        ready: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl AgentPolicy for GatedDecision {
        fn identity(&self) -> PolicyIdentity {
            PolicyIdentity {
                name: "default".into(),
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
            if matches!(event, PolicyEvent::ModelCompleted { .. })
                && !self.paused.swap(true, Ordering::SeqCst)
            {
                self.ready.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            DefaultAgentPolicy.decide(view, event, state, cancel)
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    let input = input(&db);
    let run_id = input.run_id.clone();
    let catalog = match Arc::try_unwrap(db) {
        Ok(db) => db.into_inner().unwrap(),
        Err(_) => panic!("unexpected shared catalog"),
    };
    let supervisor = crate::supervisor::RunSupervisor::new(catalog);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let provider = Arc::new(AnswerProvider(AtomicUsize::new(0)));
    let handle = supervisor
        .start(
            &run_id,
            crate::supervisor::RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding: input.binding,
                policy_state: Value::Null,
                provider: provider.clone(),
                tools: Arc::new(Tools::default()),
                policy: Arc::new(GatedDecision {
                    paused: AtomicBool::new(false),
                    ready: ready_tx,
                    release: Mutex::new(release_rx),
                }),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let queued = supervisor
        .catalog()
        .lock()
        .unwrap()
        .enqueue_input(&crate::catalog::inputs::EnqueueInput {
            key: "late".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: crate::InputMode::Boundary,
            input: json!({"text":"late correction"}),
            configuration: None,
        })
        .unwrap();
    release_tx.send(()).unwrap();
    let result = handle.wait();
    supervisor.shutdown().unwrap();
    assert_eq!(result.unwrap().state, RunState::Completed);
    assert_eq!(provider.0.load(Ordering::SeqCst), 2);
    assert_eq!(
        supervisor
            .catalog()
            .lock()
            .unwrap()
            .queued_input(&queued.input_id)
            .unwrap()
            .state,
        crate::InputState::Delivered
    );
}

#[test]
fn interrupt_during_request_serialization_prevents_stale_generation() {
    interrupt_during_request_serialization(false);
}
#[test]
fn serialization_cancellation_error_preserves_interrupt_boundary() {
    interrupt_during_request_serialization(true);
}
fn interrupt_during_request_serialization(cooperative: bool) {
    struct GatedSerializer {
        cooperative: bool,
        first: AtomicBool,
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
        calls: AtomicUsize,
        stale: AtomicUsize,
    }
    impl ModelProvider for GatedSerializer {
        fn serialize_cancellable(&self, view: &RequestView, reuse: Option<&mut RequestCompileReuse>, cancel: &CancellationToken) -> Result<RequestBody, ExecutionError> {
            let body = self.serialize(view, reuse)?;
            if self.cooperative && cancel.is_cancelled() {
                return Err(ExecutionError::new("cancelled", "original encoder drained"));
            }
            Ok(body)
        }
        fn serialize(&self, view: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
            if !self.first.swap(true, Ordering::SeqCst) {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            Ok(serde_json::to_value(view).unwrap().into())
        }
        fn generate(
            &self,
            request: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if !request.view.history.iter().any(
                |item| matches!(&item.content,Content::Text{text} if text=="corrected before send"),
            ) {
                self.stale.fetch_add(1, Ordering::SeqCst);
            }
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: format!("answer-{n}"),
                    content: Content::Text {
                        text: "answer".into(),
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    let input = input(&db);
    let run_id = input.run_id.clone();
    let catalog = match Arc::try_unwrap(db) {
        Ok(db) => db.into_inner().unwrap(),
        Err(_) => panic!("unexpected shared catalog"),
    };
    let supervisor = crate::supervisor::RunSupervisor::new(catalog);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let provider = Arc::new(GatedSerializer {
        cooperative,
        first: AtomicBool::new(false),
        entered: entered_tx,
        release: Mutex::new(release_rx),
        calls: AtomicUsize::new(0),
        stale: AtomicUsize::new(0),
    });
    let handle = supervisor
        .start(
            &run_id,
            crate::supervisor::RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding: input.binding,
                policy_state: Value::Null,
                provider: provider.clone(),
                tools: Arc::new(Tools::default()),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    supervisor
        .catalog()
        .lock()
        .unwrap()
        .enqueue_input(&crate::catalog::inputs::EnqueueInput {
            key: "interrupt".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: crate::InputMode::Interrupt,
            input: json!({"text":"corrected before send"}),
            configuration: None,
        })
        .unwrap();
    supervisor.interrupt_generation(&run_id);
    release_tx.send(()).unwrap();
    let report = handle.wait();
    supervisor.shutdown().unwrap();
    let report = report.unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(report.model_steps, 1, "unprepared cancelled encoding is not a model exchange");
    assert_eq!(
        provider.stale.load(Ordering::SeqCst),
        0,
        "accepted interrupt missed the candidate being serialized and sent stale user instructions"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn serialization_cancellation_error_preserves_cancel_and_bot_sleep() {
    use crate::catalog::bot::{BotGate, BotSuspension};
    struct StopEncoding {
        catalog: Arc<Mutex<Catalog>>,
        root: CancellationToken,
        sleeping: bool,
    }
    impl ModelProvider for StopEncoding {
        fn serialize(&self, _: &RequestView, _: Option<&mut RequestCompileReuse>) -> Result<RequestBody, ExecutionError> {
            panic!("the original cancellable encoder must be used")
        }
        fn serialize_cancellable(&self, view: &RequestView, _: Option<&mut RequestCompileReuse>, cancel: &CancellationToken) -> Result<RequestBody, ExecutionError> {
            let mut owner = self.catalog.lock().unwrap();
            if self.sleeping {
                owner.publish_bot_gate(BotGate {
                    bot_id: "bot".into(), profile_revision: 2,
                    activity_operation_id: Some("encoding-sleep".into()), permitted: false,
                }).unwrap();
                owner.suspend_bot_scope(BotSuspension {
                    bot_id: "bot".into(), profile_revision: 2,
                    activity_operation_id: "encoding-sleep".into(),
                }).unwrap();
            } else {
                owner.request_cancel_run(&view.run_id).unwrap();
            }
            self.root.cancel();
            assert!(cancel.is_cancelled());
            Err(ExecutionError::new("cancelled", "original encoder drained"))
        }
        fn generate(&self, _: &RequestSnapshot, _: &CancellationToken, _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>) -> Result<FinishReason, ModelFailure> {
            panic!("cancelled encoding must not dispatch")
        }
    }
    struct CandidatePolicy;
    impl AgentPolicy for CandidatePolicy {
        fn identity(&self) -> PolicyIdentity { DefaultAgentPolicy.identity() }
        fn decide(&self, _: &PolicyView<'_>, _: &PolicyEvent, _: &Value, _: &CancellationToken) -> Result<PolicyDecision, ExecutionError> {
            Ok(PolicyDecision { action: PolicyAction::RequestModel, state: json!({"uncommitted":true}) })
        }
    }
    for sleeping in [false, true] {
        let fixture = Fixture::new();
        let catalog = fixture.catalog();
        if sleeping {
            catalog.lock().unwrap().publish_bot_gate(BotGate {
                bot_id: "bot".into(), profile_revision: 1,
                activity_operation_id: Some("encoding-sleep".into()), permitted: true,
            }).unwrap();
        }
        let input = input_with_bot(&catalog, sleeping.then_some("bot"));
        let run_id = input.run_id.clone();
        let cancel = CancellationToken::default();
        let engine = ExecutionEngine {
            persistence: catalog.clone(),
            context_preparation: Arc::new(NoopContextPreparation),
            provider: Arc::new(StopEncoding { catalog: catalog.clone(), root: cancel.clone(), sleeping }),
            tools: Arc::new(Tools::default()),
            policy: Arc::new(CandidatePolicy),
            progress: ProgressSink::default(),
        };
        let report = engine.run(input, cancel).unwrap();
        let expected = if sleeping { RunState::Waiting } else { RunState::Cancelled };
        assert_eq!(report.state, expected);
        assert_eq!(report.policy_state, Value::Null);
        assert_eq!(report.model_steps, 0);
        assert!(report.failure.is_none());
        let owner = catalog.lock().unwrap();
        let run = owner.run(&run_id).unwrap();
        assert_eq!(run.state, expected);
        assert_eq!(run.cancel_requested, !sleeping);
        assert_eq!(owner.history("main").unwrap().len(), 1);
    }
}

#[test]
fn recovered_completed_output_never_resends_model_or_reexecutes_cached_receipts() {
    for cut in 0..3 {
        let fixture = Fixture::new();
        let db = fixture.catalog();
        let original_input = input(&db);
        let run_id = original_input.run_id.clone();
        let epoch = original_input.owner_generation;
        let snapshot = RequestSnapshot {
            view: RequestView {
                request_id: "saved-first".into(),
                run_id: run_id.clone(),
                origin: RequestOrigin::Conversation {
                    compaction: None, step: 1,
                    history_range: original_input.binding.history_range.clone(),
                },
                binding: original_input.binding.clone(),
                history: original_input.history.clone(),
            },
            serialized: json!({"request":"must never send again"}).into(),
        };
        let calls: Vec<ToolCall> = (1..=2)
            .map(|n| ToolCall {
                call_id: format!("call-{n}"),
                name: "read".into(),
                schema_version: "1".into(),
                arguments: json!({}),
            })
            .collect();
        let mut items = vec![ProviderItem {
            id: "opaque".into(),
            content: Content::ProviderOnly,
            opaque: Some(OpaqueProviderItem {
                connection_identity: "fixture-connection".into(),
                family: "test".into(),
                adapter_version: "1".into(),
                value: json!({"signature":[null,42,"unaltered"]}),
            }),
        }];
        items.extend(calls.iter().enumerate().map(|(n, call)| ProviderItem {
            id: format!("saved-call-{n}"),
            content: Content::ToolCall { call: call.clone() },
            opaque: None,
        }));
        let commit = |record: ExecutionRecord| {
            db.lock()
                .unwrap()
                .commit_execution(&run_id, epoch, &record)
                .unwrap();
        };
        commit(ExecutionRecord::RequestPrepared {
            snapshot: snapshot.clone().into(),
        });
        commit(ExecutionRecord::ModelDispatched {
            request_id: "saved-first".into(),
        });
        commit(ExecutionRecord::ModelFinished {
            request_id: "saved-first".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items,
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        });
        if cut >= 1 {
            let contract = ToolContract {
                name: "read".into(),
                schema_version: "1".into(),
                read_only: false,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![],
            };
            commit({
                let tool = AdmittedTool {
                    call: calls[0].clone(),
                    contract,
                };
                ExecutionRecord::ToolAdmitted {
                    context: {
                        let request_id: String = "saved-first".into();
                        let call_id: String = tool.call.call_id.clone();
                        varin_runtime::execution::ToolExecutionContext {
                            run_id: (&run_id).to_string(),
                            operation_id: format!("{request_id}:tool:{call_id}"),
                            origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                        }
                    },
                    tool,
                }
            });
            commit(ExecutionRecord::ToolDispatched {
                executor_owner: varin_runtime::ExecutorOwner::Kernel,
                context: {
                    let request_id: String = "saved-first".into();
                    let call_id: String = "call-1".into();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&run_id).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
            });
        }
        if cut == 1 {
            commit({
                let result = ToolResult {
                    request_id: "saved-first".into(),
                    call_id: "call-1".into(),
                    completion: ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::Confirmed,
                        content: json!("cached first result").into(),
                    },
                };
                ExecutionRecord::ToolSettled {
                    executor_stopped: true,
                    context: {
                        let request_id: String = result.request_id.clone();
                        let call_id: String = result.call_id.clone();
                        varin_runtime::execution::ToolExecutionContext {
                            run_id: (&run_id).to_string(),
                            operation_id: format!("{request_id}:tool:{call_id}"),
                            origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                        }
                    },
                    completion: result.completion,
                }
            });
        }
        drop(db);
        let db = fixture.catalog();
        let prepared = db.lock().unwrap().prepare_recovered_execution(
            &run_id,
            original_input.binding,
            DefaultAgentPolicy.identity(),
            Value::Null,
        );
        if cut == 2 {
            assert!(
                prepared.is_err(),
                "dispatched effect without receipt cannot be replayed"
            );
            assert_eq!(
                db.lock()
                    .unwrap()
                    .operation("saved-first:tool:call-1")
                    .unwrap()
                    .effect,
                Effect::Unknown
            );
            continue;
        }
        let (input, recovery) = prepared.unwrap();
        assert!(recovery.is_some());
        let cancel = CancellationToken::default();
        let (progress, _receiver) = ProgressSink::channel();
        let engine = engine(db.clone(), Mode::ToolThenAnswer, cancel.clone(), progress);
        engine.provider.calls.store(1, Ordering::SeqCst);
        let report = engine.run_recovered(input, cancel, recovery).unwrap();
        assert_eq!(report.state, RunState::Completed);
        assert_eq!(
            engine.provider.calls.load(Ordering::SeqCst),
            2,
            "only the new continuation request may be sent"
        );
        assert_eq!(
            engine.tools.calls.load(Ordering::SeqCst),
            if cut == 1 { 1 } else { 2 }
        );
        let history = db.lock().unwrap().execution_history("main").unwrap();
        for call in &calls {
            assert_eq!(history.iter().filter(|item|matches!(&item.content,Content::ToolResult{result} if result.call_id==call.call_id)).count(),1);
        }
        if cut == 1 {
            assert!(history.iter().any(|item|matches!(&item.content,Content::ToolResult{result} if matches!(&result.completion,ToolCompletion::Result{content,..} if content.data==json!("cached first result")))));
        }
    }
}

#[test]
fn active_context_compiles_summary_and_tail_without_destroying_original_history() {
    struct ContextProvider;
    impl ModelProvider for ContextProvider {
        fn serialize(&self, view: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
            assert!(matches!(
                &view.history[0].provenance,
                Provenance::SystemInstruction { .. }
            ));
            assert!(matches!(
                &view.history[1].provenance,
                Provenance::ExternalData { .. }
            ));
            assert_eq!(view.binding.memory_checkpoint.as_deref(), Some("memory-7"));
            assert_eq!(
                view.binding.instruction_sources,
                vec!["policy-file".to_string()]
            );
            assert_eq!(
                view.history.last().unwrap().opaque.as_ref().unwrap().value,
                json!({"signature":"tail-original"})
            );
            assert!(!view.history.iter().any(
                |item| matches!(&item.content,Content::Text{text} if text=="read then answer")
            ));
            Ok(serde_json::to_value(view).unwrap().into())
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: "context-answer".into(),
                    content: Content::Text {
                        text: "done".into(),
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
    let fixture = Fixture::new();
    let db = fixture.catalog();
    let mut prepared = input(&db);
    let ancestor = prepared.binding.history_range.leaf_id.clone().unwrap();
    let tail: ConversationItem = ConversationItem {
        resource_activation: None,
        id: "context-tail".into(),
        provenance: Provenance::Assistant,
        content: Content::ProviderOnly,
        opaque: Some(OpaqueProviderItem {
            connection_identity: "fixture-connection".into(),
            family: "test".into(),
            adapter_version: "1".into(),
            value: json!({"signature":"tail-original"}),
        }),
    };
    let mut catalog = db.lock().unwrap();
    let tail_row = catalog
        .append_history(
            &prepared.run_id,
            prepared.owner_generation,
            Some(&ancestor),
            crate::HistorySource::Assistant,
            serde_json::to_value(&tail).unwrap(),
            None,
        )
        .unwrap();
    let proposal = crate::catalog::context::ContextProposal {
        key: "context-1".into(),
        branch_id: "main".into(),
        through_id: Some(ancestor.clone()),
        expected_revision: 0,
        summary: "earlier user context".into(),
        effective_system_prompt: "trusted system snapshot".into(),
        instruction_sources: vec!["policy-file".into()],
        memory_checkpoint: Some("memory-7".into()),
    };
    catalog.publish_context(proposal.clone()).unwrap();
    prepared.history = catalog.execution_history("main").unwrap();
    prepared.binding.history_range.leaf_id = catalog.head("main").unwrap();
    let collection = catalog.prepare_content_collection(Default::default());
    drop(catalog);
    content_collection::collect(|| collection).unwrap();
    let (progress, _receiver) = ProgressSink::channel();
    let engine = ExecutionEngine {
        context_preparation: Arc::new(NoopContextPreparation),
        persistence: db.clone(),
        provider: Arc::new(ContextProvider),
        tools: Arc::new(Tools::default()),
        policy: Arc::new(DefaultAgentPolicy),
        progress,
    };
    assert_eq!(
        engine
            .run(prepared, CancellationToken::default())
            .unwrap()
            .state,
        RunState::Completed
    );
    drop(engine);
    drop(db);
    let reopened = fixture.catalog();
    content_collection::collect(|| {
        reopened
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default())
    })
    .unwrap();
    let catalog = reopened.lock().unwrap();
    assert_eq!(
        catalog.active_context("main").unwrap().unwrap().proposal,
        proposal
    );
    let history = catalog.execution_history("main").unwrap();
    assert!(
        history
            .iter()
            .any(|item| matches!(&item.content,Content::Text{text} if text=="read then answer"))
    );
    assert_eq!(
        history
            .iter()
            .find(|item| item.id == tail_row.id)
            .unwrap()
            .opaque,
        tail.opaque
    );
}

#[path = "bot_suspension_execution_tests.rs"]
mod bot_suspension;

#[test]
fn context_prefix_reuse_rehydrates_only_new_history_across_real_model_steps() {
    use crate::catalog::context::ContextProposal;
    use crate::catalog::goals::GoalScope;
    use crate::catalog::memory::{MemorySnapshot, MemoryState};
    use crate::catalog::personalization::{PersonalizationBasis, SystemSection};

    fn note(text: &str) -> Value {
        json!({"id":1,"scope":{"kind":"global"},"content":text,"updatedAt":"2026-10-14T00:00:00.000Z"})
    }
    fn goal_scope() -> GoalScope {
        GoalScope {
            thread_id: "thread".into(),
            branch_id: "main".into(),
        }
    }
    use crate::providers::{Connection, CredentialResolver, HttpRequest, HttpTransport, responses};

    struct Credentials(AtomicUsize);
    impl CredentialResolver for Credentials {
        fn headers(
            &self,
            _: Option<&str>,
            _: &CancellationToken,
        ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(reqwest::header::HeaderMap::new())
        }
    }
    #[derive(Default)]
    struct Transport(Mutex<Vec<RequestBody>>);
    impl HttpTransport for Transport {
        fn stream(
            &self,
            request: HttpRequest<'_>,
            _: &CancellationToken,
            receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
        ) -> Result<(), ModelFailure> {
            let mut requests = self.0.lock().unwrap();
            let first = requests.is_empty();
            requests.push(request.body.clone());
            drop(requests);
            let output = if first {
                json!([{ "id":"first-call", "type":"function_call", "status":"completed",
                    "call_id":"call-1", "name":"read", "arguments":"{}" }])
            } else {
                json!([{ "id":"answer", "type":"message", "status":"completed", "role":"assistant",
                    "content":[{"type":"output_text","text":"done"}] }])
            };
            let frame = format!(
                "data: {}\n\n",
                json!({"type":"response.completed","response":{"output":output}})
            );
            for chunk in frame.as_bytes().chunks(17) {
                if receive(chunk)? {
                    break;
                }
            }
            Ok(())
        }
    }
    struct Preparation {
        db: Arc<Mutex<Catalog>>,
        calls: AtomicUsize,
        replace: bool,
        views: Arc<Mutex<Vec<RequestView>>>,
    }
    impl ContextPreparation for Preparation {
        fn prepare(
            &self,
            run: &str,
            epoch: u64,
            _: &CancellationToken,
        ) -> Result<(), ExecutionError> {
            let step = self.calls.fetch_add(1, Ordering::SeqCst);
            if step == 1 && self.replace {
                self.db
                    .lock()
                    .unwrap()
                    .publish_context(ContextProposal {
                        key: "replacement-prefix".into(),
                        branch_id: "main".into(),
                        through_id: None,
                        expected_revision: 1,
                        summary: String::new(),
                        effective_system_prompt: "Replacement system".into(),
                        instruction_sources: vec!["replacement".into()],
                        memory_checkpoint: None,
                    })
                    .unwrap();
            }
            let prepared = self
                .db
                .lock()
                .unwrap()
                .prepare_memory_sync(
                    run,
                    epoch,
                    MemoryState {
                        revision: step as u64 + 2,
                        memories: vec![note(if step == 0 {
                            "FIRST_NOTE"
                        } else {
                            "CURRENT_NOTE"
                        })],
                        note_revisions: BTreeMap::from([("1".into(), step as u64 + 2)]),
                        known: BTreeMap::new(),
                        bot_knowledge: None,
                    },
                )
                .unwrap();
            let prepared = prepared.load().unwrap();
            assert!(
                self.db
                    .lock()
                    .unwrap()
                    .publish_memory_state(prepared)
                    .unwrap()
            );
            if step == 1 {
                let prepared = self
                    .db
                    .lock()
                    .unwrap()
                    .prepare_goal_update("goal", 1, goal_scope(), "CURRENT_GOAL".into(), None)
                    .unwrap();
                let prepared = prepared.load().unwrap();
                self.db
                    .lock()
                    .unwrap()
                    .admit_goal_mutation(prepared)
                    .unwrap();
            }
            Ok(())
        }
        fn prepare_request(
            &self,
            _: u64,
            view: &RequestView,
            _: &RequestBody,
            _: Option<crate::context_capacity::RequestBudgetProtocol>,
            _: &dyn Fn(
                ContextProjection,
            )
                -> Result<crate::context_capacity::InputEstimate, ExecutionError>,
            _: &CancellationToken,
        ) -> Result<ContextRequestPreparation, ExecutionError> {
            // Observe the actual Engine candidate consumed by the real Responses adapter.
            self.views.lock().unwrap().push(view.clone());
            Ok(ContextRequestPreparation::Ready)
        }
    }
    for replace in [false, true] {
        let fixture = Fixture::new();
        let db = fixture.catalog();
        let mut input = input_with_frozen_context(
            &db,
            None,
            json!({
                "text": "stable source material ".repeat(8192),
                "attachments":[{"media_type":"image/png","data_base64":"aW1hZ2U6Zml4ZWQ="}]
            }),
            Some(ContextProposal {
                key: "stable-prefix".into(),
                branch_id: "main".into(),
                through_id: None,
                expected_revision: 0,
                summary: String::new(),
                effective_system_prompt: "Stable system".into(),
                instruction_sources: vec!["initial".into()],
                memory_checkpoint: Some("memory:1".into()),
            }),
            Some(PersonalizationBasis {
                mode: "agent".into(),
                thread_role: "main".into(),
                revision: 1,
                configuration_digest: "fixture".into(),
                memory_snapshot: MemorySnapshot {
                    revision: 1,
                    memories: vec![note("BASELINE_NOTE")],
                },
                context_composition: None,
                thread_id: "thread".into(),
                project_id: None,
                original_sections: vec![SystemSection {
                    name: "preamble".into(),
                    content: "Stable system".into(),
                }],
                instruction_sources: vec!["initial".into()],
            }),
        );
        input.binding.provider_family = responses::FAMILY.into();
        let original_head = input.binding.history_range.leaf_id.clone().unwrap();
        let mut foreign_id = String::new();
        let mut opaque_only_id = String::new();
        {
            let mut catalog = db.lock().unwrap();
            catalog
                .bind_launch(
                    &input.run_id,
                    crate::catalog::launches::LaunchSelection::from_binding(
                        &input.binding,
                        DefaultAgentPolicy.identity(),
                        None,
                    ),
                )
                .unwrap();
            for (id, content) in [
                (
                    "portable",
                    Content::Text {
                        text: "portable foreign source ".repeat(8192),
                    },
                ),
                ("opaque-only", Content::ProviderOnly),
            ] {
                let head = catalog.head("main").unwrap();
                let item = ConversationItem::<ResolvedMedia> {
                    resource_activation: None,
                    id: id.into(),
                    provenance: Provenance::Assistant,
                    content,
                    opaque: Some(OpaqueProviderItem {
                        family: "foreign-protocol".into(),
                        connection_identity: "foreign-connection".into(),
                        adapter_version: "1".into(),
                        value: json!({"secret":"FOREIGN_WIRE_SECRET"}),
                    }),
                };
                let row = catalog
                    .append_history(
                        &input.run_id,
                        input.owner_generation,
                        head.as_deref(),
                        crate::HistorySource::Assistant,
                        serde_json::to_value(item).unwrap(),
                        None,
                    )
                    .unwrap();
                if id == "portable" {
                    foreign_id = row.id;
                } else {
                    opaque_only_id = row.id;
                }
            }
            input.binding.history_range.leaf_id = catalog.head("main").unwrap();
            input.history = catalog.execution_history("main").unwrap();
            let prepared = catalog
                .prepare_goal_start(
                    "goal",
                    &input.run_id,
                    goal_scope(),
                    "FIRST_GOAL".into(),
                    None,
                )
                .unwrap();
            drop(catalog);
            let prepared = prepared.load().unwrap();
            db.lock().unwrap().admit_goal_mutation(prepared).unwrap();
        }
        let hydrations = Arc::new(Mutex::new(BTreeMap::<String, usize>::new()));
        let seen = hydrations.clone();
        db.lock()
            .unwrap()
            .set_context_history_read_hook(Some(Arc::new(move |id| {
                *seen.lock().unwrap().entry(id.into()).or_default() += 1;
            })));
        let transport = Arc::new(Transport::default());
        let credentials = Arc::new(Credentials(AtomicUsize::new(0)));
        let (progress, _receiver) = ProgressSink::channel();
        let views = Arc::new(Mutex::new(Vec::new()));
        let config: crate::ModelSessionConfiguration = serde_json::from_value(json!({
            "providerFamily":responses::FAMILY,"model":input.binding.model,"endpoint":"https://fixture.invalid",
            "credentialEnvironment":null,"allowAnonymous":true,"configurationGeneration":1,
            "maxOutputTokens":null,"modelOptions":{"temperature":0.125}
        })).unwrap();
        // Use the actual registry lease and configured wrapper, not a lighter test serializer.
        let selected = crate::providers::registry::model_adapters().read().unwrap().select(&config).unwrap();
        let provider = selected.bind(&config, Connection::new("https://fixture.invalid", credentials.clone(), transport.clone())).unwrap();
        let engine = ExecutionEngine {
            persistence: db.clone(),
            context_preparation: Arc::new(Preparation {
                db: db.clone(),
                calls: AtomicUsize::new(0),
                replace,
                views: views.clone(),
            }),
            provider,
            tools: Arc::new(Tools::default()),
            policy: Arc::new(DefaultAgentPolicy),
            progress,
        };
        let report = engine.run(input, CancellationToken::default()).unwrap();
        assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
        assert!(
            report
                .history
                .iter()
                .find(|item| item.id == foreign_id)
                .unwrap()
                .opaque
                .is_some(),
            "request projection never erases the original history's opaque ownership"
        );
        db.lock().unwrap().set_context_history_read_hook(None);
        let counts = hydrations.lock().unwrap();
        assert_eq!(
            counts[&original_head],
            if replace { 2 } else { 1 },
            "unchanged retained text and media are hydrated once; a new checkpoint compiles afresh"
        );
        assert!(
            counts.len() >= 3,
            "the second step hydrates its actual tool exchange"
        );
        let bodies = transport.0.lock().unwrap();
        assert_eq!(bodies[0].shared_fragments(&bodies[1], "input"), if replace {0} else {4},
            "system, large text, media, and sanitized foreign content reuse frozen Responses fragments; checkpoint replacement invalidates them");
        assert_eq!(bodies[0].shared_fragments(&bodies[1], "tools"), usize::from(!replace), "unchanged tools reuse their encoded schema");
        let requests: Vec<_> = bodies.iter().map(RequestBody::to_value).collect();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            credentials.0.load(Ordering::SeqCst),
            2,
            "authentication is resolved at every dispatch"
        );
        let first = requests[0]["input"].as_array().unwrap();
        let second = requests[1]["input"].as_array().unwrap();
        let views = views.lock().unwrap();
        assert_eq!(views.len(), 2);
        let mut shared = 0;
        for (index, item) in views[0].history.iter().enumerate() {
            if matches!(item.provenance, Provenance::UserInstruction { .. })
                || item.id == foreign_id
            {
                let next = views[1]
                    .history
                    .iter()
                    .position(|next| next.id == item.id)
                    .unwrap();
                assert_eq!(
                    Arc::ptr_eq(item, &views[1].history[next]),
                    !replace,
                    "unchanged context shares actual semantic allocations; replacement compiles new ones"
                );
                assert_eq!(
                    first[index], second[next],
                    "complete wire values retain original text/media"
                );
                shared += usize::from(Arc::ptr_eq(item, &views[1].history[next]));
            }
        }
        assert_eq!(
            shared,
            if replace { 0 } else { 3 },
            "text, media, and sanitized foreign content share allocations"
        );
        for (index, view) in views.iter().enumerate() {
            assert!(view.history.iter().all(|item| item.id != opaque_only_id));
            assert!(
                view.history
                    .iter()
                    .find(|item| item.id == foreign_id)
                    .unwrap()
                    .opaque
                    .is_none()
            );
            let text = serde_json::to_string(&requests[index]).unwrap();
            assert!(!text.contains("FOREIGN_WIRE_SECRET"));
            assert!(text.contains(if index == 0 {
                "FIRST_NOTE"
            } else {
                "CURRENT_NOTE"
            }));
            assert!(!text.contains(if index == 0 {
                "CURRENT_NOTE"
            } else {
                "FIRST_NOTE"
            }));
            assert!(text.contains(if index == 0 {
                "FIRST_GOAL"
            } else {
                "CURRENT_GOAL"
            }));
            assert!(!text.contains(if index == 0 {
                "CURRENT_GOAL"
            } else {
                "FIRST_GOAL"
            }));
            assert_eq!(
                view.binding.goal.as_ref().unwrap().generation,
                index as u64 + 1
            );
            let stored = db
                .lock()
                .unwrap()
                .capture_model_step_read(&view.request_id)
                .unwrap()
                .load_request()
                .unwrap();
            assert_eq!(
                stored["serialized"], requests[index],
                "RequestPrepared retains the actual provider body"
            );
            let reference = db
                .lock()
                .unwrap()
                .model_step_metadata(&view.request_id)
                .unwrap()
                .request;
            let restored = crate::content::ContentStore::open(fixture.path.join("content"))
                .unwrap()
                .load_snapshot(&reference)
                .unwrap();
            assert_eq!(restored.serialized.wire_bytes(), bodies[index].wire_bytes(),
                "reopened ContentStore restores the exact bytes used by HTTP");
            assert_eq!(requests[index]["temperature"], 0.125, "outer configured fields precede freezing");
            assert_eq!(
                &restored.view, view,
                "stored media resolution restores the complete immutable semantic view"
            );
            assert!(
                stored["view"]["history"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|item| item.get("id").is_some() && item.get("content").is_some()),
                "shared history preserves existing serde item shape"
            );
        }
        assert_eq!(
            second[0]["content"],
            if replace {
                "Replacement system"
            } else {
                "Stable system"
            }
        );
        assert!(
            first
                .iter()
                .any(|item| item["content"].as_array().is_some_and(|parts| parts
                    .iter()
                    .any(|part| part["image_url"] == "data:image/png;base64,aW1hZ2U6Zml4ZWQ=")))
        );
        assert!(
            second
                .iter()
                .any(|item| item["type"] == "function_call" && item["call_id"] == "call-1")
        );
        assert!(
            second
                .iter()
                .any(|item| item["type"] == "function_call_output" && item["call_id"] == "call-1")
        );
        assert_eq!(requests[1]["tools"], requests[0]["tools"]);
    }
}

#[test]
fn context_prefix_projection_retains_only_current_source_and_connection() {
    let original = Arc::new(ConversationItem::<ResolvedMedia> {
        resource_activation: None,
        id: "same-history-id".into(),
        provenance: Provenance::Assistant,
        content: Content::Text {
            text: "immutable source".into(),
        },
        opaque: Some(OpaqueProviderItem {
            family: "original-family".into(),
            connection_identity: "original-connection".into(),
            adapter_version: "1".into(),
            value: json!({"signature":"original"}),
        }),
    });
    let mut reuse = HistoryProjectionReuse::default();
    let first = compile_history(
        [&original],
        "selected-family",
        "selected-connection",
        Some(&mut reuse),
    );
    let second = compile_history(
        [&original],
        "selected-family",
        "selected-connection",
        Some(&mut reuse),
    );
    assert!(Arc::ptr_eq(&first[0], &second[0]));
    assert!(first[0].opaque.is_none());
    assert!(original.opaque.is_some());
    let obsolete = Arc::downgrade(&first[0]);
    drop(first);
    drop(second);
    assert!(
        obsolete.upgrade().is_some(),
        "latest projection retains its sanitized allocation"
    );

    // A checkpoint rehydration is a different immutable source even if it has the same history ID.
    let mut changed = original.as_ref().clone();
    changed.content = Content::Text {
        text: "replacement source".into(),
    };
    let changed = Arc::new(changed);
    let next = compile_history(
        [&changed],
        "selected-family",
        "selected-connection",
        Some(&mut reuse),
    );
    assert!(
        obsolete.upgrade().is_none(),
        "superseded checkpoint projections are released"
    );
    assert_eq!(next[0].content, changed.content);
    let changed_projection = Arc::downgrade(&next[0]);
    drop(next);
    let own = compile_history(
        [&changed],
        "original-family",
        "original-connection",
        Some(&mut reuse),
    );
    assert!(Arc::ptr_eq(&own[0], &changed));
    assert!(
        own[0].opaque.is_some(),
        "returning to the owner must not reuse its stripped projection"
    );
    assert!(changed_projection.upgrade().is_none());
    let next = compile_history(
        [&changed],
        "original-family",
        "other-connection",
        Some(&mut reuse),
    );
    assert!(
        next[0].opaque.is_none(),
        "same family with another connection cannot replay originals"
    );
    let current = Arc::downgrade(&next[0]);
    drop(next);
    drop(reuse);
    assert!(
        current.upgrade().is_none(),
        "worker exit releases the latest projection"
    );
}

#[test]
fn context_prefix_reuse_rebuilds_an_older_captured_head_and_keeps_live_memory() {
    use crate::catalog::context::{ContextCompileReuse, ContextProposal};
    use crate::catalog::memory::{MemorySnapshot, MemoryState};
    use crate::catalog::personalization::{PersonalizationBasis, SystemSection};
    let fixture = Fixture::new();
    let db = fixture.catalog();
    let note = |text: &str| json!({"id":1,"scope":{"kind":"global"},"content":text,"updatedAt":"2026-10-14T00:00:00.000Z"});
    let mut catalog = db.lock().unwrap();
    catalog.create_thread("thread", "main").unwrap();
    let input = catalog
        .submit_with_context_snapshot(
            &SubmitInput {
                key: "live-memory".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"original user"}),
                configuration: json!({}),
            },
            None,
            false,
            Some(ContextProposal {
                key: "initial".into(),
                branch_id: "main".into(),
                through_id: None,
                expected_revision: 0,
                summary: String::new(),
                effective_system_prompt: "FROZEN_SYSTEM".into(),
                instruction_sources: vec![],
                memory_checkpoint: Some("memory:1".into()),
            }),
            Some(PersonalizationBasis {
                mode: "agent".into(),
                thread_role: "main".into(),
                revision: 1,
                configuration_digest: "fixture".into(),
                memory_snapshot: MemorySnapshot {
                    revision: 1,
                    memories: vec![note("ORIGINAL_NOTE")],
                },
                context_composition: None,
                thread_id: "thread".into(),
                project_id: None,
                original_sections: vec![SystemSection {
                    name: "preamble".into(),
                    content: "FROZEN_SYSTEM".into(),
                }],
                instruction_sources: vec![],
            }),
        )
        .unwrap();
    let epoch = catalog.epoch();
    let capture = |catalog: &Catalog, head: &str| {
        catalog
            .prepare_context_read(&input.run_id, epoch, Some(head))
            .unwrap()
            .unwrap()
    };
    let old_read = capture(&catalog, &input.input_id);
    let first_read = capture(&catalog, &input.input_id);
    drop(catalog);
    let mut reuse = ContextCompileReuse::default();
    let first = first_read.load_reusing(Some(&mut reuse)).unwrap();
    let catalog = db.lock().unwrap();
    let memory = catalog
        .prepare_memory_sync(
            &input.run_id,
            epoch,
            MemoryState {
                revision: 2,
                memories: vec![note("LATEST_NOTE")],
                note_revisions: BTreeMap::from([("1".into(), 2)]),
                known: BTreeMap::new(),
                bot_knowledge: None,
            },
        )
        .unwrap();
    drop(catalog);
    let memory = memory.load().unwrap();
    let mut catalog = db.lock().unwrap();
    assert!(catalog.publish_memory_state(memory).unwrap());
    let tail = catalog
        .append_history(
            &input.run_id,
            epoch,
            Some(&input.input_id),
            crate::HistorySource::Assistant,
            serde_json::to_value(ConversationItem::<crate::output::ResolvedMedia> {
                resource_activation: None,
                id: "later".into(),
                provenance: Provenance::Assistant,
                content: Content::Text {
                    text: "later descendant".into(),
                },
                opaque: None,
            })
            .unwrap(),
            None,
        )
        .unwrap();
    let next_read = capture(&catalog, &tail.id);
    drop(catalog);
    let next = next_read.load_reusing(Some(&mut reuse)).unwrap();
    assert!(next.history.iter().any(
        |item| matches!(&item.content, Content::Text { text } if text.contains("LATEST_NOTE"))
    ));
    assert_eq!(
        next.history[0], first.history[0],
        "new memory does not rewrite the fixed system prefix"
    );
    let old = old_read.load_reusing(Some(&mut reuse)).unwrap();
    assert!(
        !old.history.iter().any(
            |item| matches!(&item.content, Content::Text { text } if text == "later descendant")
        ),
        "a previously captured read cannot inherit a cached descendant"
    );
    assert_eq!(
        old.history, first.history,
        "captured memory and history stay fixed to their original read"
    );
}

// A real binding preparation can return its cancellation error after Sleep/Stop
// has already fenced the original Run, before any request or graph is admitted.
fn binding_preparation_control_case(graph: bool, sleeping: bool) {
    use crate::catalog::bot::{BotGate, BotSuspension};
    use std::sync::mpsc;
    use std::time::Duration;

    struct HeldBinding {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl ContextPreparation for HeldBinding {
        fn prepare_binding(
            &self,
            _: &str,
            _: u64,
            _: &mut RequestBinding,
            cancel: &CancellationToken,
        ) -> Result<ConversationHistory, ExecutionError> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            assert!(cancel.is_cancelled());
            Err(ExecutionError::new("child_delegation", "Run cancelled"))
        }
        fn prepare(&self, _: &str, _: u64, _: &CancellationToken) -> Result<(), ExecutionError> {
            Ok(())
        }
    }
    struct SelectedAction(bool);
    impl AgentPolicy for SelectedAction {
        fn identity(&self) -> PolicyIdentity {
            PolicyIdentity { name: "binding-control-review".into(), version: "1".into() }
        }
        fn decide(
            &self,
            _: &PolicyView<'_>,
            _: &PolicyEvent,
            _: &Value,
            _: &CancellationToken,
        ) -> Result<PolicyDecision, ExecutionError> {
            Ok(PolicyDecision {
                state: json!({"pending":"must not replace prior state"}),
                action: if self.0 {
                    PolicyAction::ToolGraph { nodes: vec![PolicyToolNode {
                        id: "read-node".into(), depends_on: vec![],
                        call: ToolCall { call_id: "read-call".into(), name: "read".into(),
                            schema_version: "1".into(), arguments: json!({}) },
                    }] }
                } else { PolicyAction::RequestModel },
            })
        }
    }

    let fixture = Fixture::new();
    let catalog = fixture.catalog();
    if sleeping {
        catalog.lock().unwrap().publish_bot_gate(BotGate {
            bot_id: "bot".into(), profile_revision: 1,
            activity_operation_id: Some("original-sleep".into()), permitted: true,
        }).unwrap();
    }
    let input = input_with_bot(&catalog, sleeping.then_some("bot"));
    let run_id = input.run_id.clone();
    let cancel = CancellationToken::default();
    let original = engine(catalog.clone(), Mode::ToolThenAnswer, cancel.clone(), ProgressSink::default());
    let provider = original.provider.clone();
    let tools = original.tools.clone();
    let (entered, waiting) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let engine = ExecutionEngine {
        persistence: catalog.clone(),
        context_preparation: Arc::new(HeldBinding { entered, release: Mutex::new(held) }),
        provider: provider.clone(), tools: tools.clone(),
        policy: Arc::new(SelectedAction(graph)), progress: ProgressSink::default(),
    };
    let worker_cancel = cancel.clone();
    let worker = std::thread::spawn(move || engine.run(input, worker_cancel));
    waiting.recv_timeout(Duration::from_secs(3)).unwrap();
    let suspension = BotSuspension { bot_id: "bot".into(),
        profile_revision: 2, activity_operation_id: "original-sleep".into() };
    {
        let mut owner = catalog.lock().unwrap();
        if sleeping {
            owner.publish_bot_gate(BotGate { bot_id: "bot".into(), profile_revision: 2,
                activity_operation_id: Some("original-sleep".into()), permitted: false }).unwrap();
            owner.suspend_bot_scope(suspension.clone()).unwrap();
        } else {
            owner.request_cancel_run(&run_id).unwrap();
        }
    }
    cancel.cancel();
    release.send(()).unwrap();
    let report = worker.join().unwrap().unwrap();
    let expected = if sleeping { RunState::Waiting } else { RunState::Cancelled };
    assert_eq!(report.state, expected, "binding errors must preserve the original control meaning");
    assert_eq!(report.policy_state, Value::Null, "unexecuted decision state must roll back");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    assert_eq!(tools.calls.load(Ordering::SeqCst), 0);
    let mut owner = catalog.lock().unwrap();
    let run = owner.run(&run_id).unwrap();
    assert_eq!(run.state, expected);
    assert_eq!(run.cancel_requested, !sleeping);
    assert_eq!(owner.history("main").unwrap().len(), 1);
    if sleeping {
        assert!(run.waiting_on.as_deref().unwrap().starts_with("execution-recovery:"));
        owner.publish_bot_gate(BotGate { bot_id: "bot".into(), profile_revision: 3,
            activity_operation_id: Some("original-sleep".into()), permitted: true }).unwrap();
        let resumed = owner.resume_bot_scope(&BotSuspension { profile_revision: 3, ..suspension }).unwrap();
        assert_eq!(resumed.resumed_run_ids, vec![run_id]);
        assert!(resumed.blocked_run_ids.is_empty());
    }
}
#[test]
fn binding_preparation_cancel_preserves_model_control() { binding_preparation_control_case(false, false); }
#[test]
fn binding_preparation_cancel_preserves_graph_control() { binding_preparation_control_case(true, false); }
#[test]
fn binding_preparation_sleep_preserves_model_control() { binding_preparation_control_case(false, true); }
#[test]
fn binding_preparation_sleep_preserves_graph_control() { binding_preparation_control_case(true, true); }

#[test]
fn terminal_failure_fact_survives_reopen_without_exposing_callback_content() {
    struct FailingPreparation { early: bool, code: &'static str }
    impl ContextPreparation for FailingPreparation {
        fn prepare(&self, _: &str, _: u64, _: &CancellationToken) -> Result<(), ExecutionError> {
            if self.early { Err(ExecutionError::new(self.code, "private callback body SECRET")) } else { Ok(()) }
        }
        fn prepare_request(
            &self, _: u64, _: &RequestView, _: &RequestBody,
            _: Option<crate::context_capacity::RequestBudgetProtocol>,
            _: &dyn Fn(ContextProjection) -> Result<crate::context_capacity::InputEstimate, ExecutionError>,
            _: &CancellationToken,
        ) -> Result<ContextRequestPreparation, ExecutionError> {
            Err(ExecutionError::new(self.code, "private callback body SECRET"))
        }
    }
    for (early, raw_code, expected_code, event_kind) in [
        (false, "context_candidate_capacity", "context_candidate_capacity", "run.failed"),
        (false, "external_SECRET", "execution_failed", "run.failed"),
        (true, "external_SECRET", "context_preparation_failed", "context.preparation_failed"),
    ] {
        let fixture = Fixture::new();
        let db = fixture.catalog();
        let input = input(&db);
        let run_id = input.run_id.clone();
        assert!(db.lock().unwrap().run_failure(&run_id).unwrap().is_none());
        let cancel = CancellationToken::default();
        let mut engine = engine(db.clone(), Mode::ToolThenAnswer, cancel.clone(), ProgressSink::default());
        engine.context_preparation = Arc::new(FailingPreparation { early, code: raw_code });
        let report = engine.run(input, cancel).unwrap();
        assert_eq!(report.state, RunState::Failed);
        assert_eq!(engine.provider.calls.load(Ordering::SeqCst), 0, "no model request was dispatched");
        let failure = {
            let db = db.lock().unwrap();
            assert_eq!(db.run(&run_id).unwrap().state, RunState::Failed);
            let failure = db.run_failure(&run_id).unwrap().unwrap();
            assert_eq!(failure.code, expected_code);
            assert_eq!(failure.run_id, run_id);
            assert!(!failure.message.contains("SECRET"));
            let events = db.events_after(0, 100).unwrap();
            let original = events.iter().find(|event| event.cursor == failure.cursor).unwrap();
            assert_eq!(original.subject, run_id);
            assert_eq!(original.kind, event_kind);
            assert_eq!(original.data["code"], expected_code);
            assert!(!serde_json::to_string(&events).unwrap().contains("SECRET"));
            failure
        };
        drop(engine);
        drop(db);
        let reopened = Catalog::open(&fixture.path).unwrap();
        assert_eq!(reopened.run_failure(&run_id).unwrap(), Some(failure));
        assert!(reopened.run_failure("missing-run").is_err(), "missing owner is not an absent failure");
    }
}

#[test]
fn cancellation_during_request_preparation_does_not_publish_a_failure_fact() {
    struct CancellingPreparation;
    impl ContextPreparation for CancellingPreparation {
        fn prepare(&self, _: &str, _: u64, _: &CancellationToken) -> Result<(), ExecutionError> { Ok(()) }
        fn prepare_request(
            &self, _: u64, _: &RequestView, _: &RequestBody,
            _: Option<crate::context_capacity::RequestBudgetProtocol>,
            _: &dyn Fn(ContextProjection) -> Result<crate::context_capacity::InputEstimate, ExecutionError>,
            cancel: &CancellationToken,
        ) -> Result<ContextRequestPreparation, ExecutionError> {
            cancel.cancel();
            Err(ExecutionError::new("context_candidate_capacity", "a losing preparation error"))
        }
    }
    let fixture = Fixture::new();
    let db = fixture.catalog();
    let input = input(&db);
    let run_id = input.run_id.clone();
    let cancel = CancellationToken::default();
    let mut engine = engine(db.clone(), Mode::ToolThenAnswer, cancel.clone(), ProgressSink::default());
    engine.context_preparation = Arc::new(CancellingPreparation);
    assert_eq!(engine.run(input, cancel).unwrap().state, RunState::Cancelled);
    let db = db.lock().unwrap();
    assert!(db.run_failure(&run_id).unwrap().is_none());
    assert!(!db.events_after(0, 100).unwrap().iter().any(|event| event.kind == "run.failed"));
}
