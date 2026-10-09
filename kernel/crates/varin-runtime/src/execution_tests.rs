use super::*;
use crate::{Catalog, SubmitInput};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

struct Fixture {
    path: std::path::PathBuf,
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
fn input(db: &Arc<Mutex<Catalog>>) -> ExecutionInput {
    let mut db = db.lock().unwrap();
    db.create_thread("thread", "main").unwrap();
    let receipt = db
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"read then answer"}),
            configuration: json!({"provider":"test"}),
        })
        .unwrap();
    ExecutionInput {
        run_id: receipt.run_id,
        owner_generation: db.epoch(),
        binding: RequestBinding {
            connection_identity: "fixture-connection".into(),
            provider_family: "test".into(),
            model: "test-model".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: vec![ToolSchema {
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
impl ToolExecutor for Tools {
    fn prepare(
        &self,
        call: &ToolCall,
        _: &FrozenToolContext,
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
            content: json!("actual bytes"),
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
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        if matches!(self.mode, Mode::CancelPrepared) {
            self.cancel.cancel();
        }
        Ok(serde_json::to_value(view).unwrap())
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
            assert!(request.view.history.iter().any(|item| item
                .opaque
                .as_ref()
                .is_some_and(|o| o.value == json!({"signature":[null,42,"unaltered"]}))));
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
    let (progress, _never_consumed) = ProgressSink::channel(1);
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
    assert!(history.iter().any(|i| i
        .opaque
        .as_ref()
        .is_some_and(|o| o.value == json!({"signature":[null,42,"unaltered"]}))));
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
        fn serialize(&self, v: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap())
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
fn worker_commit_conflict_cannot_leave_a_workerless_run_generating() {
    struct ConcurrentInput {
        catalog: Arc<Mutex<Catalog>>,
    }
    impl ModelProvider for ConcurrentInput {
        fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(view).unwrap())
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
    db.lock().unwrap().collect_content_objects().unwrap();
    let retained = db
        .lock()
        .unwrap()
        .model_output(&request_id)
        .unwrap()
        .unwrap();
    assert_eq!(retained["status"], "rejected");
    assert_eq!(retained["record"]["items"][0]["id"], "obsolete-answer");
    assert!(!db
        .lock()
        .unwrap()
        .history("main")
        .unwrap()
        .iter()
        .any(|item| item.id == "obsolete-answer"));
    drop(db);
    drop(supervisor);
    let reopened = f.catalog();
    reopened.lock().unwrap().collect_content_objects().unwrap();
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
        fn serialize(&self, v: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap())
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
        fn prepare(
            &self,
            call: &ToolCall,
            _: &FrozenToolContext,
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
                content: json!(call.name),
            }
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    let mut input = input(&db);
    input.binding.tools = ["slow", "fast"]
        .into_iter()
        .map(|name| ToolSchema {
            name: name.into(),
            version: "1".into(),
            schema: json!({"type":"object"}),
        })
        .collect();
    let (start_tx, start_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (fast_tx, fast_rx) = std::sync::mpsc::channel();
    let engine = ExecutionEngine {
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
        fn serialize(&self, v: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap())
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
        fn prepare(
            &self,
            call: &ToolCall,
            _: &FrozenToolContext,
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
                content: json!(call.name),
            }
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    let mut input = input(&db);
    input.binding.tools = ["first", "queued"]
        .into_iter()
        .map(|name| ToolSchema {
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
    let cancelled = supervisor.cancel_operation(&queued_id).unwrap();
    assert!(cancelled.cancel_requested);
    release_tx.send(()).unwrap();
    let report = handle.wait();
    supervisor.shutdown().unwrap();
    assert!(
        report.is_ok(),
        "queued-operation cancellation aborted the whole worker: {report:?}"
    );
    assert_eq!(report.unwrap().state, RunState::Completed);
    assert_eq!(tools.queued_calls.load(Ordering::SeqCst), 0);
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
    assert!(db
        .submit(&SubmitInput {
            key: "next".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: head,
            input: json!({"text":"next work"}),
            configuration: json!({"provider":"test"})
        })
        .is_ok());
}

#[test]
fn input_arriving_between_completion_decision_and_commit_is_not_lost() {
    struct AnswerProvider(AtomicUsize);
    impl ModelProvider for AnswerProvider {
        fn serialize(&self, v: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap())
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
    struct GatedSerializer {
        first: AtomicBool,
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
        calls: AtomicUsize,
        stale: AtomicUsize,
    }
    impl ModelProvider for GatedSerializer {
        fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
            if !self.first.swap(true, Ordering::SeqCst) {
                self.entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
            Ok(serde_json::to_value(view).unwrap())
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
    assert_eq!(report.unwrap().state, RunState::Completed);
    assert_eq!(
        provider.stale.load(Ordering::SeqCst),
        0,
        "accepted interrupt missed the candidate being serialized and sent stale user instructions"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
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
                step: 1,
                binding: original_input.binding.clone(),
                history: original_input.history.clone(),
            },
            serialized: json!({"request":"must never send again"}),
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
            snapshot: snapshot.clone(),
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
            commit(ExecutionRecord::ToolsAdmitted {
                request_id: "saved-first".into(),
                tools: vec![AdmittedTool {
                    call: calls[0].clone(),
                    contract,
                }],
            });
            commit(ExecutionRecord::ToolDispatched {
                request_id: "saved-first".into(),
                call_id: "call-1".into(),
            });
        }
        if cut == 1 {
            commit(ExecutionRecord::ToolSettled {
                result: ToolResult {
                    request_id: "saved-first".into(),
                    call_id: "call-1".into(),
                    completion: ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::Confirmed,
                        content: json!("cached first result"),
                    },
                },
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
        let (progress, _receiver) = ProgressSink::channel(1);
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
            assert!(history.iter().any(|item|matches!(&item.content,Content::ToolResult{result} if matches!(&result.completion,ToolCompletion::Result{content,..} if content==&json!("cached first result")))));
        }
    }
}

#[test]
fn active_context_compiles_summary_and_tail_without_destroying_original_history() {
    struct ContextProvider;
    impl ModelProvider for ContextProvider {
        fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
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
            Ok(serde_json::to_value(view).unwrap())
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
    let tail = ConversationItem {
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
    catalog
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
    catalog.collect_content_objects().unwrap();
    drop(catalog);
    let (progress, _receiver) = ProgressSink::channel(1);
    let engine = ExecutionEngine {
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
    let mut catalog = reopened.lock().unwrap();
    catalog.collect_content_objects().unwrap();
    assert_eq!(
        catalog.active_context("main").unwrap().unwrap().proposal,
        proposal
    );
    let history = catalog.execution_history("main").unwrap();
    assert!(history
        .iter()
        .any(|item| matches!(&item.content,Content::Text{text} if text=="read then answer")));
    assert_eq!(
        history
            .iter()
            .find(|item| item.id == "context-tail")
            .unwrap()
            .opaque,
        tail.opaque
    );
}
