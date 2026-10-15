use super::*;
use crate::catalog::bot::{BotGate, BotSuspension};
use crate::supervisor::{RunStart, RunSupervisor};
use std::sync::mpsc;
use std::time::Duration;
fn gate(revision: u64, permitted: bool) -> BotGate {
    BotGate {
        bot_id: "bot".into(),
        profile_revision: revision,
        activity_operation_id: Some("sleep".into()),
        permitted,
    }
}
#[test]
fn bot_scope_waits_for_real_provider_and_operation_workers_then_preserves_unknown_on_reopen() {
    struct HeldProvider {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl ModelProvider for HeldProvider {
        fn serialize(&self, view: &RequestView, _reuse: Option<&mut crate::execution::RequestCompileReuse>) -> Result<crate::execution::RequestBody, ExecutionError> {
            Ok(serde_json::to_value(view).unwrap().into())
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            cancel: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            emit(ProviderEvent::ToolArgumentsDelta {
                call_id: "partial".into(),
                delta: "{".into(),
            })
            .unwrap();
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            assert!(cancel.is_cancelled());
            Err(ModelFailure {
                code: "cancelled".into(),
                message: "actual provider exit".into(),
                retry_after_ms: None,
                provider_request_id: Some("original-transport".into()),
            })
        }
    }
    let f = Fixture::new();
    let db = f.catalog();
    db.lock().unwrap().publish_bot_gate(gate(1, true)).unwrap();
    let input = input_with_bot(&db, Some("bot"));
    let run = input.run_id.clone();
    let original_binding = input.binding.clone();
    let catalog = Arc::try_unwrap(db).ok().unwrap().into_inner().unwrap();
    let supervisor = Arc::new(RunSupervisor::new(catalog));
    let (entered, started) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let handle = supervisor
        .start(
            &run,
            RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding: input.binding,
                policy_state: Value::Null,
                provider: Arc::new(HeldProvider {
                    entered,
                    release: Mutex::new(held),
                }),
                tools: Arc::new(Tools::default()),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    started.recv_timeout(Duration::from_secs(3)).unwrap();
    let (op_started, op_ready) = mpsc::channel();
    let (op_release, op_held) = mpsc::channel();
    let context = {
        let owner = supervisor.catalog();
        let mut owner = owner.lock().unwrap();
        let epoch = owner.epoch();
        owner
            .create_bot_thread("aux-thread", "aux-branch", "bot")
            .unwrap();
        let receipt = owner
            .submit(&SubmitInput {
                key: "aux-input".into(),
                thread_id: "aux-thread".into(),
                branch_id: "aux-branch".into(),
                expected_head: None,
                input: json!("auxiliary fixture"),
                configuration: json!({}),
            })
            .unwrap();
        let range = HistoryRange {
            branch_id: receipt.branch_id.clone(),
            ancestor_id: None,
            leaf_id: Some(receipt.input_id),
        };
        let mut binding = original_binding;
        binding.history_range = range.clone();
        let snapshot = RequestSnapshot {
            view: RequestView {
                request_id: "aux-request".into(),
                run_id: receipt.run_id.clone(),
                origin: RequestOrigin::Conversation {
                    compaction: None, step: 1,
                    history_range: range,
                },
                binding,
                history: vec![],
            },
            serialized: json!({"original":"aux-candidate"}).into(),
        };
        owner
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::RequestPrepared { snapshot: snapshot.into() },
            )
            .unwrap();
        owner
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::ModelDispatched {
                    request_id: "aux-request".into(),
                },
            )
            .unwrap();
        let call = ToolCall {
            call_id: "read".into(),
            name: "read".into(),
            schema_version: "1".into(),
            arguments: json!({}),
        };
        owner
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::ModelFinished {
                    request_id: "aux-request".into(),
                    outcome: ModelOutcome::Completed,
                    finish_reason: Some(FinishReason::ToolCalls),
                    items: vec![ProviderItem {
                        id: "aux-call".into(),
                        content: Content::ToolCall { call: call.clone() },
                        opaque: None,
                    }],
                    interrupted_deltas: vec![],
                    usage: UsageReceipt::default(),
                    failure: None,
                },
            )
            .unwrap();
        let context = ToolExecutionContext {
            run_id: receipt.run_id.clone(),
            operation_id: "aux-request:tool:read".into(),
            origin: ToolOrigin::ModelStep {
                request_id: "aux-request".into(),
            },
        };
        owner
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::ToolAdmitted {
                    context: context.clone(),
                    tool: AdmittedTool {
                        call,
                        contract: ToolContract {
                            name: "read".into(),
                            schema_version: "1".into(),
                            read_only: true,
                            completion: CompletionKind::Result,
                            lifetime: Lifetime::Run,
                            resources: vec![],
                        },
                    },
                },
            )
            .unwrap();
        owner
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::ToolDispatched {
                    context: context.clone(),
                    executor_owner: crate::ExecutorOwner::Kernel,
                },
            )
            .unwrap();
        context
    };
    let operation_id = context.operation_id.clone();
    let operation_run = context.run_id.clone();
    let op_catalog = supervisor.catalog();
    supervisor
        .start_operation(
            &operation_id,
            "aux-request",
            &operation_run,
            move |cancel| {
                op_started.send(()).unwrap();
                op_held.recv().unwrap();
                assert!(cancel.is_cancelled());
                let mut owner = op_catalog.lock().unwrap();
                let epoch = owner.epoch();
                owner
                    .commit_execution(
                        &context.run_id,
                        epoch,
                        &ExecutionRecord::ToolSettled {
                            context: context.clone(),
                            completion: ToolCompletion::Result {
                                outcome: Outcome::Cancelled,
                                effect: Effect::None,
                                content: json!("original worker exited").into(),
                            },
                            executor_stopped: true,
                        },
                    )
                    .unwrap();
                Ok(())
            },
        )
        .unwrap();
    op_ready.recv_timeout(Duration::from_secs(3)).unwrap();
    supervisor
        .catalog()
        .lock()
        .unwrap()
        .publish_bot_gate(gate(2, false))
        .unwrap();
    let request = BotSuspension {
        bot_id: "bot".into(),
        activity_operation_id: "sleep".into(),
        profile_revision: 2,
    };
    let capture = supervisor.suspend_bot_scope(request.clone()).unwrap();
    let clone = supervisor.clone();
    let (done, result) = mpsc::channel();
    let drain = std::thread::spawn(move || {
        done.send(clone.drain_bot_scope(&capture)).unwrap();
    });
    assert!(
        !supervisor
            .bot_scope_status(&request)
            .unwrap()
            .current_kernel_workers_drained
    );
    assert!(result.recv_timeout(Duration::from_millis(30)).is_err());
    // A rename/checkpoint revision does not invalidate an already captured stop.
    supervisor
        .catalog()
        .lock()
        .unwrap()
        .publish_bot_gate(gate(3, false))
        .unwrap();
    release.send(()).unwrap();
    assert!(result.recv_timeout(Duration::from_millis(30)).is_err());
    op_release.send(()).unwrap();
    let status = result
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    drain.join().unwrap();
    assert!(status.current_kernel_workers_drained);
    assert_eq!(status.source_profile_revision, Some(3));
    assert_eq!(status.unresolved_model_request_ids.len(), 1);
    assert!(status.unproven_operation_stop_ids.is_empty());
    assert_eq!(
        supervisor
            .catalog()
            .lock()
            .unwrap()
            .events_after(0, 500)
            .unwrap()
            .iter()
            .filter(|e| e.subject == operation_id && e.kind == "operation.kernel_executor_stopped")
            .count(),
        1
    );
    assert_eq!(handle.wait().unwrap().state, RunState::Waiting);
    assert!(
        !supervisor
            .catalog()
            .lock()
            .unwrap()
            .run(&run)
            .unwrap()
            .cancel_requested
    );
    supervisor.shutdown().unwrap();
    drop(supervisor);
    let db = f.catalog();
    let mut db = db.lock().unwrap();
    db.publish_bot_gate(gate(4, true)).unwrap();
    let request = BotSuspension {
        profile_revision: 4,
        ..request
    };
    assert_eq!(
        db.resume_bot_scope(&request).unwrap().blocked_run_ids,
        vec![run]
    );
}
