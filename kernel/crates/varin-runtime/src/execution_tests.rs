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
        _: &RequestSnapshot,
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
