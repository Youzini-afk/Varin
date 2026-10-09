use serde_json::json;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use varin_runtime::execution::*;
use varin_runtime::resource_admission::*;
use varin_runtime::*;
fn claim(key: &str) -> ResourceClaim {
    ResourceClaim {
        key: key.into(),
        access: Access::Write,
    }
}
fn request_snapshot(receipt: &Receipt) -> varin_runtime::execution::RequestSnapshot {
    use varin_runtime::execution::*;
    RequestSnapshot {
        view: RequestView {
            request_id: "model-1".into(),
            run_id: receipt.run_id.clone(),
            origin: RequestOrigin::Conversation { step: 1, history_range: HistoryRange { branch_id: receipt.branch_id.clone(), ancestor_id: None, leaf_id: Some(receipt.input_id.clone()) } },
            binding: RequestBinding {
                connection_identity: "fixture-connection".into(),
                provider_family: "test".into(),
                model: "mock".into(),
                credential_ref: None,
                configuration_generation: 1,
                tool_schema_generation: 1,
                tools: vec![],
                instruction_sources: vec![],
                memory_checkpoint: None,
                attachment_refs: vec![],
                environment_cursor: 0,
                history_range: HistoryRange {
                    branch_id: receipt.branch_id.clone(),
                    ancestor_id: None,
                    leaf_id: Some(receipt.input_id.clone()),
                },
            },
            history: vec![],
        },
        serialized: json!({"model":"mock"}),
    }
}

fn setup(kind: CompletionKind) -> (std::path::PathBuf, Catalog, String) {
    let root =
        std::env::temp_dir().join(format!("varin-admission-review-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "main").unwrap();
    let r = db
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!("hello"),
            configuration: json!({}),
        })
        .unwrap();
    let epoch = db.epoch();
    let mut snapshot = request_snapshot(&r);
    snapshot.view.binding.tools = vec![ToolSchema {
        name: "process-executor".into(),
        version: "1".into(),
        schema: json!({"type":"object"}),
    }];
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared { snapshot },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "model-1".into(),
        },
    )
    .unwrap();
    let call = ToolCall {
        call_id: "job".into(),
        name: "process-executor".into(),
        schema_version: "1".into(),
        arguments: json!({}),
    };
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "model-1".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "job-call".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolsAdmitted {
            request_id: "model-1".into(),
            tools: vec![AdmittedTool {
                call,
                contract: ToolContract {
                    name: "process-executor".into(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: kind,
                    lifetime: Lifetime::Thread,
                    resources: vec![claim("file")],
                },
            }],
        },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolDispatched {
            request_id: "model-1".into(),
            call_id: "job".into(),
        },
    )
    .unwrap();

    (root, db, r.run_id)
}
fn can_acquire(admission: Arc<ResourceAdmission>) -> bool {
    let cancel = CancellationToken::default();
    let child = cancel.clone();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = admission
            .acquire("probe", &[claim("file")], &child)
            .unwrap();
        tx.send(result.is_some()).unwrap();
    });
    let result = rx.recv_timeout(Duration::from_millis(150));
    cancel.cancel();
    worker.join().unwrap();
    result.unwrap_or(false)
}
#[test]
fn restart_dead_synchronous_writer_must_not_retain_resource() {
    let (root, db, _) = setup(CompletionKind::Result);
    drop(db);
    let db = Mutex::new(Catalog::open(&root).unwrap());
    assert!(
        can_acquire(db.resource_admission().unwrap()),
        "dead synchronous executor retained file occupancy after restart"
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn terminal_receipt_with_unknown_effect_should_release_executor_occupancy() {
    let (root, mut db, _) = setup(CompletionKind::Job);
    db.record_external_receipt_with_stop(
        "model-1:tool:job",
        ExternalReceipt {
            identity: "model-1:tool:job".into(),
            executor: "process-executor".into(),
            epoch: "process-epoch".into(),
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            result: json!({"status":"exited","exitCode":null}),
        },
        true,
    )
    .unwrap();
    drop(db);
    let db = Mutex::new(Catalog::open(&root).unwrap());
    assert!(
        can_acquire(db.resource_admission().unwrap()),
        "trusted terminal receipt retains lock merely because business effect unknown"
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn admission_atomic_independent_progress_and_cancel() {
    let a = Arc::new(ResourceAdmission::default());
    let root = a
        .acquire("holder", &[claim("A")], &CancellationToken::default())
        .unwrap()
        .unwrap();
    let cancel = CancellationToken::default();
    let child = cancel.clone();
    let a2 = a.clone();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        tx.send(
            a2.acquire("both", &[claim("A"), claim("B")], &child)
                .unwrap()
                .is_some(),
        )
        .unwrap();
    });
    std::thread::sleep(Duration::from_millis(30));
    // A+B cannot acquire only B while awaiting A; unrelated C bypasses.
    let independent = a
        .acquire("independent", &[claim("C")], &CancellationToken::default())
        .unwrap()
        .unwrap();
    cancel.cancel();
    assert!(!rx.recv_timeout(Duration::from_secs(1)).unwrap());
    worker.join().unwrap();
    let b = a
        .acquire("b", &[claim("B")], &CancellationToken::default())
        .unwrap()
        .unwrap();
    drop((b, independent, root));
}

mod actual_engines {
    use super::*;
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn input(db: &Arc<Mutex<Catalog>>, name: &str) -> ExecutionInput {
        let mut db = db.lock().unwrap();
        db.create_thread(name, name).unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: name.into(),
                thread_id: name.into(),
                branch_id: name.into(),
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
                    branch_id: name.into(),
                    ancestor_id: None,
                    leaf_id: Some(receipt.input_id),
                },
            },
            history: db.execution_history(name).unwrap(),
            policy_state: Value::Null,
            completed_model_steps: 0,
        }
    }

    struct Provider(AtomicUsize);
    impl ModelProvider for Provider {
        fn serialize(&self, v: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap())
        }
        fn generate(
            &self,
            r: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: format!("{}-{}", r.view.run_id, r.view.request_id),
                    content: if first {
                        Content::ToolCall {
                            call: ToolCall {
                                call_id: "call".into(),
                                name: "read".into(),
                                schema_version: "1".into(),
                                arguments: json!({}),
                            },
                        }
                    } else {
                        Content::Text {
                            text: "done".into(),
                        }
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(if first {
                FinishReason::ToolCalls
            } else {
                FinishReason::Stop
            })
        }
    }
    struct Tools {
        key: String,
        gate: Option<Mutex<mpsc::Receiver<()>>>,
        started: mpsc::Sender<String>,
        read_only: bool,
    }
    impl ToolExecutor for Tools {
        fn prepare(
            &self,
            c: &ToolCall,
            _: &FrozenToolContext,
            _cancel: &CancellationToken,
        ) -> Result<ToolContract, ExecutionError> {
            Ok(ToolContract {
                name: c.name.clone(),
                schema_version: c.schema_version.clone(),
                read_only: self.read_only,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![ResourceClaim {
                    key: self.key.clone(),
                    access: if self.read_only {
                        Access::Read
                    } else {
                        Access::Write
                    },
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
            self.started.send(c.run_id.clone()).unwrap();
            if self.key == "panic" {
                panic!("simulated executor panic after dispatch");
            }
            if let Some(g) = &self.gate {
                g.lock().unwrap().recv().unwrap();
            }
            ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: if self.read_only {
                    Effect::None
                } else {
                    Effect::Confirmed
                },
                content: json!({}),
            }
        }
    }
    #[test]
    fn catalog_shared_engines_exclude_same_file_allow_other_and_cancel_queued_without_dispatch() {
        let root =
            std::env::temp_dir().join(format!("varin-engine-review-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Catalog::open(&root).unwrap()));
        let (started, events) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let start = |name: &str, key: &str, gate, cancel: CancellationToken| {
            let i = input(&db, name);
            let id = i.run_id.clone();
            let e = ExecutionEngine {
                context_preparation: Arc::new(NoopContextPreparation),
                persistence: db.clone(),
                provider: Arc::new(Provider(AtomicUsize::new(0))),
                tools: Arc::new(Tools {
                    key: key.into(),
                    gate,
                    started: started.clone(),
                    read_only: false,
                }),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            };
            (id, std::thread::spawn(move || e.run(i, cancel)))
        };
        let (a_id, a) = start(
            "a",
            "same",
            Some(Mutex::new(gate)),
            CancellationToken::default(),
        );
        assert_eq!(events.recv_timeout(Duration::from_secs(2)).unwrap(), a_id);
        let cancel = CancellationToken::default();
        let (_, b) = start("b", "same", None, cancel.clone());
        let (c_id, c) = start("c", "other", None, CancellationToken::default());
        assert_eq!(events.recv_timeout(Duration::from_secs(2)).unwrap(), c_id);
        c.join().unwrap().unwrap();
        assert!(events.recv_timeout(Duration::from_millis(80)).is_err());
        cancel.cancel();
        b.join().unwrap().unwrap();
        assert!(events.try_recv().is_err());
        release.send(()).unwrap();
        a.join().unwrap().unwrap();
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ordinary_read_only_execution_is_transient_without_occupancy_rows() {
        let root = std::env::temp_dir().join(format!("varin-read-review-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Catalog::open(&root).unwrap()));
        let i = input(&db, "readonly");
        let (started, events) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let e = ExecutionEngine {
            context_preparation: Arc::new(NoopContextPreparation),
            persistence: db.clone(),
            provider: Arc::new(Provider(AtomicUsize::new(0))),
            tools: Arc::new(Tools {
                key: "same".into(),
                gate: Some(Mutex::new(gate)),
                started,
                read_only: true,
            }),
            policy: Arc::new(DefaultAgentPolicy),
            progress: ProgressSink::default(),
        };
        let worker = std::thread::spawn(move || e.run(i, CancellationToken::default()));
        events.recv_timeout(Duration::from_secs(2)).unwrap();
        let sql = rusqlite::Connection::open(root.join("conversation.sqlite")).unwrap();
        let count: i64 = sql
            .query_row("SELECT COUNT(*) FROM resource_occupancy", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let ops: i64 = sql
            .query_row("SELECT COUNT(*) FROM operations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ops, 0);
        release.send(()).unwrap();
        worker.join().unwrap().unwrap();
        drop(sql);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn synchronous_executor_panic_retains_uncertain_effect_without_retaining_lock() {
        let root =
            std::env::temp_dir().join(format!("varin-panic-review-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Catalog::open(&root).unwrap()));
        let i = input(&db, "panic");
        let (started, _events) = mpsc::channel();
        let e = ExecutionEngine {
            context_preparation: Arc::new(NoopContextPreparation),
            persistence: db.clone(),
            provider: Arc::new(Provider(AtomicUsize::new(0))),
            tools: Arc::new(Tools {
                key: "panic".into(),
                gate: None,
                started,
                read_only: false,
            }),
            policy: Arc::new(DefaultAgentPolicy),
            progress: ProgressSink::default(),
        };
        let _report = e.run(i, CancellationToken::default());
        let sql = rusqlite::Connection::open(root.join("conversation.sqlite")).unwrap();
        let count: i64 = sql
            .query_row("SELECT COUNT(*) FROM resource_occupancy", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let effect: String = sql
            .query_row(
                "SELECT json_extract(body,'$.effect') FROM operations LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(effect, "unknown");
        drop(sql);
        drop(e);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn live_job_survives_run_cancel_and_restart_until_explicit_stop() {
    let (root, mut db, run) = setup(CompletionKind::Job);
    let epoch = db.epoch();
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::ToolSettled {
            result: ToolResult {
                request_id: "model-1".into(),
                call_id: "job".into(),
                completion: ToolCompletion::JobAccepted {
                    operation_id: "model-1:tool:job".into(),
                    phase: "running".into(),
                    effect: Effect::Dispatched,
                    lifetime: Lifetime::Thread,
                },
            },
        },
    )
    .unwrap();
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::ToolBatchCommitted {
            request_id: "model-1".into(),
            results: vec![ToolResult {
                request_id: "model-1".into(),
                call_id: "job".into(),
                completion: ToolCompletion::JobAccepted {
                    operation_id: "model-1:tool:job".into(),
                    phase: "running".into(),
                    effect: Effect::Dispatched,
                    lifetime: Lifetime::Thread,
                },
            }],
        },
    )
    .unwrap();
    let cancelled = db.request_cancel_run(&run).unwrap();
    db.transition_run(&run, epoch, cancelled.revision, RunState::Cancelled)
        .unwrap();
    db.request_cancel_operation("model-1:tool:job").unwrap();
    drop(db);
    let db = Mutex::new(Catalog::open(&root).unwrap());
    assert!(!can_acquire(db.resource_admission().unwrap()));
    let receipt = ExternalReceipt {
        identity: "model-1:tool:job".into(),
        executor: "process-executor".into(),
        epoch: "process-epoch".into(),
        outcome: Outcome::Indeterminate,
        effect: Effect::Unknown,
        result: json!({"status":"unknown"}),
    };
    db.lock()
        .unwrap()
        .record_external_receipt_with_stop("model-1:tool:job", receipt.clone(), false)
        .unwrap();
    assert!(!can_acquire(db.resource_admission().unwrap()));
    db.lock()
        .unwrap()
        .record_external_receipt_with_stop("model-1:tool:job", receipt, true)
        .unwrap();
    assert!(can_acquire(db.resource_admission().unwrap()));
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn early_stop_before_job_accepted_never_reacquires_occupancy() {
    let (root, mut db, run) = setup(CompletionKind::Job);
    let epoch = db.epoch();
    db.record_external_receipt_with_stop(
        "model-1:tool:job",
        ExternalReceipt {
            identity: "model-1:tool:job".into(),
            executor: "process-executor".into(),
            epoch: "process-epoch".into(),
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            result: json!({"status":"exited"}),
        },
        true,
    )
    .unwrap();
    db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::ToolSettled {
            result: ToolResult {
                request_id: "model-1".into(),
                call_id: "job".into(),
                completion: ToolCompletion::JobAccepted {
                    operation_id: "model-1:tool:job".into(),
                    phase: "running".into(),
                    effect: Effect::Dispatched,
                    lifetime: Lifetime::Thread,
                },
            },
        },
    )
    .unwrap();
    drop(db);
    let db = Mutex::new(Catalog::open(&root).unwrap());
    assert!(can_acquire(db.resource_admission().unwrap()));
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn all_claim_fifo_blocks_overtaking_without_blocking_unrelated_resources() {
    let a = Arc::new(ResourceAdmission::default());
    let held = a
        .acquire("holder", &[claim("A")], &CancellationToken::default())
        .unwrap()
        .unwrap();
    let (out, rx) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let a1 = a.clone();
    let out1 = out.clone();
    let first = std::thread::spawn(move || {
        let lease = a1
            .acquire(
                "first",
                &[claim("A"), claim("B")],
                &CancellationToken::default(),
            )
            .unwrap()
            .unwrap();
        out1.send(1).unwrap();
        gate.recv().unwrap();
        drop(lease);
    });
    std::thread::sleep(Duration::from_millis(40));
    let a2 = a.clone();
    let second = std::thread::spawn(move || {
        let lease = a2
            .acquire("second", &[claim("B")], &CancellationToken::default())
            .unwrap()
            .unwrap();
        out.send(2).unwrap();
        drop(lease);
    });
    assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
    let c = a
        .acquire("independent", &[claim("C")], &CancellationToken::default())
        .unwrap()
        .unwrap();
    drop(c);
    drop(held);
    assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
    assert!(rx.recv_timeout(Duration::from_millis(40)).is_err());
    release.send(()).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
    first.join().unwrap();
    second.join().unwrap();
}
