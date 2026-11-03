//! Real Catalog/model/invocation owners with a concurrent algorithm, not ExecutionEngine.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use varin_runtime::{
    catalog::{inputs::EnqueueInput, launches::LaunchSelection},
    driver::*,
    execution::*,
    *,
};

fn selection(recovery: DriverRecovery) -> DriverSelection {
    use varin_runtime::catalog::service_composition::*;
    let mut node = HostCompositionNode {
        id: String::new(),
        extension_id: "concurrent".into(),
        entrypoint_id: "host".into(),
        extension_version: "1".into(),
        artifact_integrity: "original-artifact".into(),
        activation_configuration: Value::Null,
        grants: vec![],
        dependencies: vec![],
    };
    node.id = node.content_identity().unwrap();
    DriverSelection::Extension {
        artifact: DriverArtifact {
            provider_key: "concurrent:host:varin.agent.driver@1".into(),
            extension_id: "concurrent".into(),
            extension_version: "1".into(),
            service_id: "varin.agent.driver".into(),
            service_version: 1,
            artifact_integrity: "original-artifact".into(),
            composition: HostServiceComposition {
                schema_version: 1,
                root: node.id.clone(),
                nodes: vec![node],
            },
            configuration_identity: "original-config".into(),
            identity: PolicyIdentity {
                name: "concurrent".into(),
                version: "1".into(),
            },
            model_roles: vec![],
            recovery,
            checkpoint_schema: (recovery == DriverRecovery::Checkpoint).then(|| "state-1".into()),
        },
    }
}
struct Algorithm(DriverSelection);
impl RunDriver for Algorithm {
    fn selection(&self) -> DriverSelection {
        self.0.clone()
    }
    fn run(&self, _: Arc<DriverContext>) -> Result<ExecutionReport, ExecutionError> {
        panic!("this fixture directly exercises the same native primitive owner")
    }
}
struct Provider {
    entered: mpsc::Sender<String>,
    gates: Mutex<HashMap<String, mpsc::Receiver<()>>>,
    calls: AtomicUsize,
}
impl ModelProvider for Provider {
    fn serialize(
        &self,
        view: &RequestView,
        _: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(request.view.history.iter().any(|item| matches!(&item.provenance, Provenance::SystemInstruction { source } if source.starts_with("driver:")) && matches!(&item.content,Content::Text { text } if text.starts_with("Independent branch"))), "driver instructions must reach the real serialized model context");
        let id = request
            .view
            .request_id
            .rsplit(':')
            .next()
            .unwrap()
            .to_string();
        let gate = self.gates.lock().unwrap().remove(&id);
        self.entered.send(id).unwrap();
        if let Some(gate) = gate {
            gate.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        // A cancellation request does not make this executor stop before its actual gate.
        if cancel.is_cancelled() {
            return Err(ExecutionError::new("cancelled", "original provider stopped").into());
        }
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "answer".into(),
                content: Content::Text {
                    text: "branch answer".into(),
                },
                opaque: None,
            },
        })
        .map_err(ModelFailure::from)?;
        Ok(FinishReason::Stop)
    }
}
struct Tools {
    calls: AtomicUsize,
    entered: mpsc::Sender<ToolExecutionContext>,
}
impl ToolExecutor for Tools {
    fn plan(
        &self,
        c: &ToolCall,
        f: &FrozenToolContext,
        t: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(c, f, t).map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        c: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        Ok(ToolContract {
            name: c.name.clone(),
            schema_version: c.schema_version.clone(),
            read_only: true,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![ResourceClaim {
                key: "original-read".into(),
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
        c: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.send(c.clone()).unwrap();
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::None,
            content: json!({"original":true}).into(),
        }
    }
}
struct Fixture {
    root: std::path::PathBuf,
    context: Arc<DriverContext>,
    provider: Arc<Provider>,
    tools: Arc<Tools>,
    models: mpsc::Receiver<String>,
    tool_calls: mpsc::Receiver<ToolExecutionContext>,
    progress: Option<ProgressReceiver>,
}
impl Fixture {
    fn new(recovery: DriverRecovery, gates: HashMap<String, mpsc::Receiver<()>>) -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-driver-owner-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"original input"}),
                configuration: json!({}),
            })
            .unwrap();
        let binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[{"name":"inspect","version":"1","description":"Read original source","schema":{"type":"object"},"output_schema":null,"metadata":null}],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":receipt.input_id}})).unwrap();
        let selected = selection(recovery);
        db.select_launch(
            &receipt.run_id,
            LaunchSelection::from_binding(&binding, DefaultAgentPolicy.identity(), None),
        )
        .unwrap();
        let prepared = db
            .prepare_run_driver(&receipt.run_id, &selected, vec![])
            .unwrap()
            .load()
            .unwrap();
        db.admit_run_driver(prepared).unwrap();
        let (mt, models) = mpsc::channel();
        let (tt, tool_calls) = mpsc::channel();
        let provider = Arc::new(Provider {
            entered: mt,
            gates: Mutex::new(gates),
            calls: AtomicUsize::new(0),
        });
        let tools = Arc::new(Tools {
            entered: tt,
            calls: AtomicUsize::new(0),
        });
        let (progress_sink, progress) = ProgressSink::channel();
        let start = varin_runtime::supervisor::RunStart {
            driver: Arc::new(Algorithm(selected)),
            context_preparation: Arc::new(NoopContextPreparation),
            binding,
            policy_state: Value::Null,
            provider: provider.clone(),
            tools: tools.clone(),
            policy: Arc::new(DefaultAgentPolicy),
            progress: progress_sink,
        };
        let epoch = db.epoch();
        let context = Arc::new(DriverContext::new(
            Arc::new(Mutex::new(db)),
            receipt.run_id,
            epoch,
            start,
            CancellationToken::default(),
        ));
        Self {
            root,
            context,
            provider,
            tools,
            models,
            tool_calls,
            progress: Some(progress),
        }
    }
    fn request(&self, id: &str, history: ConversationHistory) -> DriverModelInput {
        DriverModelInput {
            id: id.into(),
            capability_id: Some("primary".into()),
            history,
            instructions: vec![format!("Independent branch {id}")],
            tools: vec![],
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn concurrent_models_interleave_actual_tool_and_drain_before_real_report() {
    let (release, gate) = mpsc::channel();
    let mut f = Fixture::new(DriverRecovery::None, HashMap::from([("slow".into(), gate)]));
    let initial = f.context.prepare_custom().unwrap();
    let c = f.context.clone();
    let slow = f.request("slow", initial.history.clone());
    let slow_worker = std::thread::spawn(move || {
        c.model_owned(slow, || {
            assert_eq!(
                c.finish(DriverFinishInput {
                    outcome: DriverTerminalOutcome::Complete
                })
                .unwrap(),
                DriverFinishReceipt::WorkPending,
                "credit transfer runs after the actual mutable primitive admission is held"
            );
        })
    });
    assert_eq!(
        f.models.recv_timeout(Duration::from_secs(5)).unwrap(),
        "slow"
    );
    let fast_input = f.request("fast", initial.history);
    let fast = f.context.model(fast_input.clone()).unwrap();
    assert_eq!(
        f.models.recv_timeout(Duration::from_secs(5)).unwrap(),
        "fast"
    );
    assert_eq!(fast.outcome, ModelOutcome::Completed);
    let tool = DriverToolInput {
        id: "early".into(),
        name: "inspect".into(),
        arguments: json!({}),
    };
    let receipt = f
        .context
        .tool_owned(tool.clone(), || {
            assert_eq!(
                f.context
                    .finish(DriverFinishInput {
                        outcome: DriverTerminalOutcome::Complete
                    })
                    .unwrap(),
                DriverFinishReceipt::WorkPending
            );
        })
        .unwrap();
    assert!(receipt.executor_stopped);
    let actual = f.tool_calls.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(actual.origin, ToolOrigin::Driver { .. }));
    assert_eq!(f.context.tool(tool).unwrap(), receipt);
    assert_eq!(f.tools.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.context.model(fast_input).unwrap(), fast);
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 2);
    let delivered = f
        .context
        .deliver(DriverDeliveryInput {
            id: "answer".into(),
            text: "joined result".into(),
        })
        .unwrap();
    assert_eq!(
        f.context
            .finish(DriverFinishInput {
                outcome: DriverTerminalOutcome::Complete
            })
            .unwrap(),
        DriverFinishReceipt::WorkPending
    );
    assert!(
        f.context
            .receipt(DriverReceiptInput {
                id: "fast".into(),
                kind: varin_runtime::catalog::driver::DriverWorkKind::Model
            })
            .unwrap()
            .is_some(),
        "a rejected finish leaves the original scope open"
    );
    release.send(()).unwrap();
    assert_eq!(
        slow_worker.join().unwrap().unwrap().outcome,
        ModelOutcome::Completed
    );
    assert_eq!(
        f.context
            .finish(DriverFinishInput {
                outcome: DriverTerminalOutcome::Complete
            })
            .unwrap(),
        DriverFinishReceipt::Committed {
            state: RunState::Completed
        }
    );
    assert!(f
        .context
        .receipt(DriverReceiptInput {
            id: "fast".into(),
            kind: varin_runtime::catalog::driver::DriverWorkKind::Model
        })
        .is_err());
    let report = f
        .context
        .finish_custom(Ok(DriverRunOutcome::Complete))
        .unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(report.model_steps, 2);
    assert!(report
        .history
        .iter()
        .any(|item| item.id == delivered.history_id));
    let mut progress = f.progress.take().unwrap();
    drop(f);
    assert!(
        progress.next().is_none(),
        "private model drafts must not appear as conversation output before deliver"
    );
}

#[test]
fn branch_cancel_is_intent_and_does_not_cancel_other_branch() {
    let (release, gate) = mpsc::channel();
    let f = Fixture::new(DriverRecovery::None, HashMap::from([("slow".into(), gate)]));
    let input = f.context.prepare_custom().unwrap();
    let c = f.context.clone();
    let request = f.request("slow", input.history.clone());
    let (done_tx, done) = mpsc::channel();
    let worker = std::thread::spawn(move || done_tx.send(c.model(request)).unwrap());
    f.models.recv_timeout(Duration::from_secs(5)).unwrap();
    let unknown = f
        .context
        .cancel_work(DriverCancelInput {
            id: "other-run-work".into(),
            kind: DriverCancelKind::Model,
        })
        .unwrap();
    assert!(!unknown.requested);
    assert!(unknown.receipt.is_none());
    let cancel = f
        .context
        .cancel_work(DriverCancelInput {
            id: "slow".into(),
            kind: DriverCancelKind::Model,
        })
        .unwrap();
    assert!(cancel.requested);
    assert!(matches!(
        cancel.receipt,
        Some(DriverReceipt::Model {
            state: ModelStepState::Dispatched,
            receipt: None,
            ..
        })
    ));
    assert!(matches!(done.try_recv(), Err(mpsc::TryRecvError::Empty)));
    let fast = f.context.model(f.request("fast", input.history)).unwrap();
    assert_eq!(fast.outcome, ModelOutcome::Completed);
    release.send(()).unwrap();
    assert_eq!(
        done.recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap()
            .outcome,
        ModelOutcome::Cancelled
    );
    worker.join().unwrap();
    assert!(!f.context.cancel.is_cancelled());
}

#[test]
fn custom_context_consumes_original_inbox_and_rejects_unadmitted_resource_reference() {
    let f = Fixture::new(DriverRecovery::None, HashMap::new());
    let initial = f.context.prepare_custom().unwrap();
    let input = f
        .context
        .catalog
        .lock()
        .unwrap()
        .enqueue_input(&EnqueueInput {
            key: "steering".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::Boundary,
            input: json!({"text":"new constraint"}),
            configuration: None,
        })
        .unwrap();
    let updated = f.context.context(DriverContextInput {}).unwrap();
    assert!(updated.activating);
    assert_eq!(updated.input_ids, vec![input.input_id]);
    assert!(updated.history.len() > initial.history.len());
    let next = f.context.context(DriverContextInput {}).unwrap();
    assert!(next.input_ids.is_empty());
    assert_eq!(next.history, updated.history);
    let mut forged = updated.history;
    Arc::make_mut(&mut forged[0]).id = "another-run".into();
    Arc::make_mut(&mut forged[0]).provenance = Provenance::ExternalData {
        source: "skill-activation:another-run".into(),
    };
    Arc::make_mut(&mut forged[0]).resource_activation=Some(serde_json::from_value(json!({"activationId":"another-run","inputId":"foreign-input","inputRevision":1,"ordinal":0,"resourceCheckpointId":"foreign-checkpoint","snapshotId":"foreign-snapshot","resourceId":"private-skill","reference":{"domainId":"private","viewId":"another-run","path":"private.md","canonicalId":"private","version":"1"}})).unwrap());
    let error = f.context.model(f.request("injection", forged)).unwrap_err();
    assert!(error.message.contains("unadmitted resource"));
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 0);
    assert!(serde_json::from_value::<DriverModelInput>(json!({"id":"cross-run-media","capabilityId":null,"instructions":[],"tools":[],"history":[{"id":"foreign","provenance":{"kind":"assistant"},"content":{"kind":"media","media":{"media_type":"image/png","source":{},"content_ref":{"hash":"another-run-blob"}}},"opaque":null}]})).is_err());
}

#[test]
fn original_checkpoint_resumes_without_replaying_receipts_and_none_is_honest() {
    let f = Fixture::new(DriverRecovery::Checkpoint, HashMap::new());
    let first = f.context.prepare_custom().unwrap();
    let receipt = f
        .context
        .model(f.request("original", first.history))
        .unwrap();
    let checkpoint = f
        .context
        .checkpoint(DriverCheckpointInput {
            expected_revision: 0,
            schema: "state-1".into(),
            state: json!({"phase":"observed"}),
            operations: vec![receipt.request_id.clone()],
        })
        .unwrap();
    f.context.close_and_drain();
    let c = DriverContext::new(
        f.context.catalog.clone(),
        f.context.run_id.clone(),
        f.context.epoch,
        f.context.start.clone(),
        CancellationToken::default(),
    );
    let resumed = c.prepare_custom().unwrap();
    assert_eq!(resumed.mode, "resume");
    assert_eq!(resumed.checkpoint, Some(checkpoint));
    assert!(
        matches!(&resumed.receipts[..],[DriverReceipt::Model{receipt:Some(saved),..}] if saved==&receipt)
    );
    assert_eq!(f.provider.calls.load(Ordering::SeqCst), 1);
    let no = Fixture::new(DriverRecovery::None, HashMap::new());
    no.context.prepare_custom().unwrap();
    no.context.close_and_drain();
    let c = DriverContext::new(
        no.context.catalog.clone(),
        no.context.run_id.clone(),
        no.context.epoch,
        no.context.start.clone(),
        CancellationToken::default(),
    );
    assert_eq!(
        c.prepare_custom().unwrap_err().code,
        "driver_resume_unsupported"
    );
}

#[test]
fn original_event_wait_observes_inbox_and_closing_wakes_without_fake_stop() {
    let f = Fixture::new(DriverRecovery::None, HashMap::new());
    f.context.prepare_custom().unwrap();
    let baseline = f
        .context
        .wait(DriverWaitInput {
            after: None,
            work: vec![],
        })
        .unwrap();
    assert!(!baseline.input_pending);
    let c = f.context.clone();
    let (finished, receive) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        finished
            .send(c.wait(DriverWaitInput {
                after: Some(baseline.cursor),
                work: vec![],
            }))
            .unwrap()
    });
    let original = f
        .context
        .catalog
        .lock()
        .unwrap()
        .enqueue_input(&EnqueueInput {
            key: "wake-input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::Boundary,
            input: json!({"text":"wake original driver"}),
            configuration: None,
        })
        .unwrap();
    let observed = receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    waiter.join().unwrap();
    assert!(observed.cursor > baseline.cursor);
    assert!(observed.input_pending);
    let consumed = f.context.context(DriverContextInput {}).unwrap();
    assert_eq!(consumed.input_ids, vec![original.input_id]);
    let baseline = f
        .context
        .wait(DriverWaitInput {
            after: None,
            work: vec![],
        })
        .unwrap();
    assert!(!baseline.input_pending);
    assert!(f
        .context
        .wait(DriverWaitInput {
            after: None,
            work: vec![DriverReceiptInput {
                id: "foreign-stable-id".into(),
                kind: varin_runtime::catalog::driver::DriverWorkKind::Tool
            }]
        })
        .is_err());
    let c = f.context.clone();
    let (finished, receive) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        finished
            .send(c.wait(DriverWaitInput {
                after: Some(baseline.cursor),
                work: vec![],
            }))
            .unwrap()
    });
    f.context.close_admission();
    assert!(receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .is_err());
    waiter.join().unwrap();
    f.context.close_and_drain();
    assert!(
        !f.context.cancel.is_cancelled(),
        "closing observer waits does not cancel accepted model/tool effects"
    );
}

#[test]
fn cancellation_and_author_failure_have_one_actual_final_state() {
    let f = Fixture::new(DriverRecovery::None, HashMap::new());
    f.context.prepare_custom().unwrap();
    f.context.cancel.cancel();
    let report = f
        .context
        .finish_custom(Ok(DriverRunOutcome::Fail {
            error: ExecutionError::new(
                "author_failure",
                "branch failed while cancellation was requested",
            ),
        }))
        .unwrap();
    assert_eq!(report.state, RunState::Cancelled);
    assert_eq!(
        f.context
            .catalog
            .lock()
            .unwrap()
            .run(&f.context.run_id)
            .unwrap()
            .state,
        report.state
    );
    assert_eq!(report.failure.unwrap().code, "author_failure");
}

struct FinishBoundaryDriver {
    refreshed: mpsc::Sender<Arc<DriverContext>>,
    continue_after_input: Mutex<mpsc::Receiver<()>>,
    committed: mpsc::Sender<()>,
    return_callback: Mutex<mpsc::Receiver<()>>,
    return_failure: bool,
}
impl RunDriver for FinishBoundaryDriver {
    fn selection(&self) -> DriverSelection {
        selection(DriverRecovery::None)
    }
    fn run(&self, context: Arc<DriverContext>) -> Result<ExecutionReport, ExecutionError> {
        context.prepare_custom()?;
        context.context(DriverContextInput {})?;
        self.refreshed.send(context.clone()).unwrap();
        self.continue_after_input.lock().unwrap().recv().unwrap();
        assert_eq!(
            context.finish(DriverFinishInput {
                outcome: DriverTerminalOutcome::Complete
            })?,
            DriverFinishReceipt::InputPending
        );
        assert!(
            context
                .wait(DriverWaitInput {
                    after: None,
                    work: vec![]
                })?
                .input_pending,
            "rejected finish must not close observers or the original algorithm"
        );
        let current = context.context(DriverContextInput {})?;
        assert!(current.history.iter().any(|item| matches!(&item.content, Content::Text { text } if text.contains("late original instruction"))));
        context.deliver(DriverDeliveryInput {
            id: "replanned".into(),
            text: "Handled late original instruction in this callback".into(),
        })?;
        assert_eq!(
            context.finish(DriverFinishInput {
                outcome: DriverTerminalOutcome::Complete
            })?,
            DriverFinishReceipt::Committed {
                state: RunState::Completed
            }
        );
        self.committed.send(()).unwrap();
        self.return_callback.lock().unwrap().recv().unwrap();
        let failure = ExecutionError::new(
            "late_callback_failure",
            "cleanup failed after completion was already committed",
        );
        context.finish_custom(if self.return_failure {
            Ok(DriverRunOutcome::Fail { error: failure })
        } else {
            Err(failure)
        })
    }
}

#[test]
fn terminal_admission_handles_late_input_in_original_callback_and_preserves_committed_result() {
    for return_failure in [false, true] {
        let f = Fixture::new(DriverRecovery::None, HashMap::new());
        let placeholder = std::env::temp_dir().join(format!(
            "varin-driver-finish-placeholder-{}",
            uuid::Uuid::new_v4()
        ));
        let catalog = std::mem::replace(
            &mut *f.context.catalog.lock().unwrap(),
            Catalog::open(&placeholder).unwrap(),
        );
        let supervisor = varin_runtime::supervisor::RunSupervisor::new(catalog);
        let (refreshed, ready) = mpsc::channel();
        let (continue_after_input, input_gate) = mpsc::channel();
        let (committed, completed) = mpsc::channel();
        let (return_callback, callback_gate) = mpsc::channel();
        let mut start = f.context.start.clone();
        start.driver = Arc::new(FinishBoundaryDriver {
            refreshed,
            continue_after_input: Mutex::new(input_gate),
            committed,
            return_callback: Mutex::new(callback_gate),
            return_failure,
        });
        let handle = supervisor.start(&f.context.run_id, start).unwrap();
        let original = ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let db = supervisor.catalog();
        let late = db
            .lock()
            .unwrap()
            .enqueue_input(&EnqueueInput {
                key: "late".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                mode: InputMode::Boundary,
                input: json!({"text":"late original instruction"}),
                configuration: None,
            })
            .unwrap();
        assert_eq!(late.run_id, original.run_id);
        continue_after_input.send(()).unwrap();
        completed.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            handle.try_result().unwrap().is_none(),
            "terminal business state is not actual callback exit"
        );
        assert!(!original.cancel.is_cancelled());
        assert_eq!(
            db.lock().unwrap().run(&original.run_id).unwrap().state,
            RunState::Completed
        );
        assert_eq!(
            db.lock()
                .unwrap()
                .queued_input(&late.input_id)
                .unwrap()
                .state,
            InputState::Delivered
        );
        assert!(
            original.context(DriverContextInput {}).is_err(),
            "committed completion closes new primitive admission"
        );
        assert_eq!(
            original
                .finish(DriverFinishInput {
                    outcome: DriverTerminalOutcome::Complete
                })
                .unwrap(),
            DriverFinishReceipt::Committed {
                state: RunState::Completed
            }
        );
        let later = db
            .lock()
            .unwrap()
            .enqueue_input(&EnqueueInput {
                key: "after-commit".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                mode: InputMode::Boundary,
                input: json!({"text":"new request after completion"}),
                configuration: None,
            })
            .unwrap();
        assert_ne!(later.run_id, original.run_id, "input after the committed boundary uses normal native next-Run admission, never replays the old callback");
        return_callback.send(()).unwrap();
        let report = handle.wait().unwrap();
        assert_eq!(report.state, RunState::Completed);
        assert!(
            report.failure.is_none(),
            "late callback errors cannot rewrite the original committed outcome"
        );
        assert!(supervisor
            .execution_failure(&original.run_id)
            .unwrap()
            .is_none());
        assert_eq!(
            db.lock().unwrap().run(&original.run_id).unwrap().state,
            RunState::Completed
        );
        assert!(!report.history.iter().any(|item| matches!(&item.content, Content::Text { text } if text.contains("new request after completion"))));
        drop(original);
        drop(db);
        drop(supervisor);
        drop(f);
        std::fs::remove_dir_all(placeholder).unwrap();
    }
}

#[test]
fn callback_return_drains_unawaited_work_without_implicitly_committing_completion() {
    let (release, gate) = mpsc::channel();
    let f = Fixture::new(DriverRecovery::None, HashMap::from([("held".into(), gate)]));
    let input = f.context.prepare_custom().unwrap();
    let request = f.request("held", input.history);
    let context = f.context.clone();
    let model = std::thread::spawn(move || context.model(request));
    f.models.recv_timeout(Duration::from_secs(5)).unwrap();
    let context = f.context.clone();
    let (finished, receive) = mpsc::channel();
    let callback = std::thread::spawn(move || {
        finished
            .send(context.finish_custom(Ok(DriverRunOutcome::Complete)))
            .unwrap()
    });
    assert!(matches!(receive.try_recv(), Err(mpsc::TryRecvError::Empty)));
    release.send(()).unwrap();
    model.join().unwrap().unwrap();
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err()
            .code,
        "driver_finish_required"
    );
    callback.join().unwrap();
    assert_eq!(
        f.context
            .catalog
            .lock()
            .unwrap()
            .run(&f.context.run_id)
            .unwrap()
            .state,
        RunState::Runnable
    );
}

/// A real process exit after both dispatch owners commit, not a fabricated unknown row.
/// The read/write fixture performs its effect and exits before returning any completion.
struct ExitAfterDispatch {
    tools: Arc<Tools>,
    provider: Arc<Provider>,
    proof: std::path::PathBuf,
}
impl ToolExecutor for ExitAfterDispatch {
    fn plan(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, frozen, cancel)
            .map(ToolPreparation::Ready)
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.tools.authorize(context, call, contract, cancel)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let mut contract = self.tools.prepare(call, frozen, cancel)?;
        contract.read_only = false;
        contract.resources[0].access = Access::Write;
        Ok(contract)
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let _ = self.tools.execute(context, call, contract, cancel);
        std::fs::write(
            &self.proof,
            serde_json::to_vec(&json!({
                "models": self.provider.calls.load(Ordering::SeqCst),
                "tools": self.tools.calls.load(Ordering::SeqCst),
            }))
            .unwrap(),
        )
        .unwrap();
        std::process::exit(41);
    }
}

#[test]
fn crashed_dispatch_reopens_original_unknown_model_and_tool_without_redispatch() {
    const CHILD: &str = "VARIN_DRIVER_DISPATCH_CRASH_REVIEW";
    if let Some(proof_root) = std::env::var_os(CHILD).map(std::path::PathBuf::from) {
        let (_hold_model, gate) = mpsc::channel();
        let f = Fixture::new(
            DriverRecovery::Checkpoint,
            HashMap::from([("paid".into(), gate)]),
        );
        let mut start = f.context.start.clone();
        start.tools = Arc::new(ExitAfterDispatch {
            tools: f.tools.clone(),
            provider: f.provider.clone(),
            proof: proof_root.join("dispatch.json"),
        });
        let context = Arc::new(DriverContext::new(
            f.context.catalog.clone(),
            f.context.run_id.clone(),
            f.context.epoch,
            start,
            CancellationToken::default(),
        ));
        let input = context.prepare_custom().unwrap();
        context
            .checkpoint(DriverCheckpointInput {
                expected_revision: 0,
                schema: "state-1".into(),
                state: json!({"phase":"dispatching"}),
                operations: vec![],
            })
            .unwrap();
        let model = f.request("paid", input.history);
        let tool = DriverToolInput {
            id: "effect".into(),
            name: "inspect".into(),
            arguments: json!({"original":true}),
        };
        std::fs::write(
            proof_root.join("original.json"),
            serde_json::to_vec(&json!({
                "root": f.root, "run": context.run_id, "epoch": context.epoch,
                "binding": context.start.binding, "model": model, "tool": tool,
            }))
            .unwrap(),
        )
        .unwrap();
        let active = context.clone();
        std::thread::spawn(move || active.model(model));
        assert_eq!(
            f.models.recv_timeout(Duration::from_secs(5)).unwrap(),
            "paid"
        );
        // Model remains in its actual provider while the separate original tool dispatches.
        let _ = context.tool(tool);
        panic!("the effect owner must terminate this subprocess before returning a receipt");
    }
    let proof_root = std::env::temp_dir().join(format!(
        "varin-driver-dispatch-crash-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&proof_root).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "crashed_dispatch_reopens_original_unknown_model_and_tool_without_redispatch",
            "--nocapture",
        ])
        .env(CHILD, &proof_root)
        .status()
        .unwrap();
    assert_eq!(
        status.code(),
        Some(41),
        "the original executor exited at its actual dispatch boundary"
    );
    let proof: Value =
        serde_json::from_slice(&std::fs::read(proof_root.join("dispatch.json")).unwrap()).unwrap();
    assert_eq!(proof, json!({"models":1,"tools":1}));
    let original: Value =
        serde_json::from_slice(&std::fs::read(proof_root.join("original.json")).unwrap()).unwrap();
    let root = std::path::PathBuf::from(original["root"].as_str().unwrap());
    let run = original["run"].as_str().unwrap().to_owned();
    let model: DriverModelInput = serde_json::from_value(original["model"].clone()).unwrap();
    let tool: DriverToolInput = serde_json::from_value(original["tool"].clone()).unwrap();
    let f = Fixture::new(DriverRecovery::Checkpoint, HashMap::new());
    let mut start = f.context.start.clone();
    start.binding = serde_json::from_value(original["binding"].clone()).unwrap();
    let db = Catalog::open(&root).unwrap();
    let epoch = db.epoch();
    assert!(epoch > original["epoch"].as_u64().unwrap());
    let context = DriverContext::new(
        Arc::new(Mutex::new(db)),
        run,
        epoch,
        start,
        CancellationToken::default(),
    );
    let resumed = context.prepare_custom().unwrap();
    assert_eq!(resumed.mode, "resume");
    assert_eq!(
        resumed.checkpoint.unwrap().state,
        json!({"phase":"dispatching"})
    );
    assert!(matches!(
        resumed
            .receipts
            .iter()
            .find(|receipt| matches!(receipt, DriverReceipt::Model { id, .. } if id == "paid")),
        Some(DriverReceipt::Model {
            state: ModelStepState::Interrupted,
            receipt: None,
            ..
        })
    ));
    assert!(matches!(
        resumed
            .receipts
            .iter()
            .find(|receipt| matches!(receipt, DriverReceipt::Tool { id, .. } if id == "effect")),
        Some(DriverReceipt::Tool {
            phase: Some(OperationPhase::Terminal),
            receipt: None,
            ..
        })
    ));
    let operation_id = resumed
        .receipts
        .iter()
        .find_map(|receipt| match receipt {
            DriverReceipt::Tool {
                id, operation_id, ..
            } if id == "effect" => Some(operation_id),
            _ => None,
        })
        .unwrap();
    let unknown = context
        .catalog
        .lock()
        .unwrap()
        .operation(operation_id)
        .unwrap();
    assert_eq!(unknown.effect, Effect::Unknown);
    assert_eq!(unknown.outcome, Some(Outcome::Indeterminate));
    let model_error = context.model(model).unwrap_err();
    assert!(
        model_error
            .message
            .contains("inspect it instead of redispatching"),
        "{model_error:?}"
    );
    let tool_error = context.tool(tool).unwrap_err();
    assert!(
        tool_error
            .message
            .contains("inspect it instead of redispatching"),
        "{tool_error:?}"
    );
    assert_eq!(
        f.provider.calls.load(Ordering::SeqCst),
        0,
        "unknown paid request never calls a fresh provider"
    );
    assert_eq!(
        f.tools.calls.load(Ordering::SeqCst),
        0,
        "unknown effect never redispatches its executor"
    );
    assert_eq!(
        context
            .catalog
            .lock()
            .unwrap()
            .operation(operation_id)
            .unwrap(),
        unknown
    );
    context.close_and_drain();
    drop(context);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(proof_root).unwrap();
}
