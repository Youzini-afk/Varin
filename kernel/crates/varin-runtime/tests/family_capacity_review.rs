//! Independent deterministic admission counterexamples. Gates represent executor completion,
//! not elapsed-time guesses or artificially large file payloads.
use std::num::NonZeroUsize;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::execution_capacity::*;
use varin_runtime::resource_admission::*;

fn identity(family: &str, owner: &str) -> AdmissionIdentity {
    AdmissionIdentity {
        family_id: family.into(),
        run_id: format!("run-{family}"),
        owner_generation: 1,
        origin: ToolOrigin::ModelStep {
            request_id: owner.into(),
        },
    }
}
fn admission() -> Arc<ResourceAdmission> {
    let a = Arc::new(ResourceAdmission::default());
    a.set_compute_capacity(NonZeroUsize::new(1).unwrap());
    a
}
fn claim(key: &str) -> ResourceClaim {
    ResourceClaim {
        key: key.into(),
        access: Access::Write,
    }
}
fn wait_for(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !predicate() {
        assert!(Instant::now() < deadline, "admission did not reach gate");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn queued(
    a: &Arc<ResourceAdmission>,
    owner: &str,
    family: &str,
    claims: Vec<ResourceClaim>,
    events: mpsc::Sender<String>,
) -> (
    CancellationToken,
    mpsc::Sender<()>,
    std::thread::JoinHandle<bool>,
) {
    let token = CancellationToken::default();
    let child = token.clone();
    let aa = a.clone();
    let id = identity(family, owner);
    let owner = owner.to_owned();
    let (release, gate) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let lease = aa
            .acquire_scheduled(&owner, &claims, &id, ExecutionClass::LocalCompute, &child)
            .unwrap();
        if lease.is_some() {
            events.send(owner).unwrap();
            gate.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        lease.is_some()
    });
    (token, release, worker)
}

#[test]
fn newcomer_advances_before_family_flood_and_family_turns_continue() {
    let a = admission();
    let hold = a
        .acquire_scheduled(
            "hold",
            &[],
            &identity("A", "hold"),
            ExecutionClass::LocalCompute,
            &CancellationToken::default(),
        )
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let mut jobs = vec![];
    for n in 0..6 {
        let name = format!("A-{n}");
        jobs.push(queued(&a, &name, "A", vec![], tx.clone()));
        wait_for(|| a.inspect(&name).is_some());
    }
    let b = queued(&a, "B", "B", vec![], tx.clone());
    wait_for(|| a.inspect("B").is_some());
    assert_eq!(a.summary().local_compute_active, 1);
    assert_eq!(a.inspect("B").unwrap().reason, Some("capacity"));
    drop(hold);
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        "B",
        "one family's existing flood cannot take the challenger's next turn"
    );
    // Add more A traffic while B really owns the only permit.
    jobs.push(queued(&a, "A-late", "A", vec![], tx.clone()));
    wait_for(|| a.inspect("A-late").is_some());
    b.1.send(()).unwrap();
    assert!(b.2.join().unwrap());
    for (index, (_, release, worker)) in jobs.into_iter().enumerate() {
        let expected = if index < 6 {
            format!("A-{index}")
        } else {
            "A-late".into()
        };
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), expected);
        assert_eq!(a.summary().local_compute_active, 1);
        release.send(()).unwrap();
        assert!(worker.join().unwrap());
    }
    assert_eq!(a.summary().queued, 0);
    assert_eq!(a.summary().local_compute_active, 0);
}

#[test]
fn conflict_fifo_survives_family_rotation_and_capacity_wait_holds_no_resources() {
    let a = admission();
    let hold = a
        .acquire_scheduled(
            "hold",
            &[],
            &identity("A", "hold"),
            ExecutionClass::LocalCompute,
            &CancellationToken::default(),
        )
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let older = queued(&a, "older", "A", vec![claim("file")], tx.clone());
    wait_for(|| a.inspect("older").is_some());
    let later = queued(&a, "later", "B", vec![claim("file")], tx);
    wait_for(|| a.inspect("later").is_some());
    assert_eq!(
        a.inspect("later").unwrap().reason,
        Some("resource_conflict")
    );
    // Pending compute claims are not active claims. Cancel its ticket, then an unmetered
    // writer can immediately enter while the compute holder is still running.
    let unused = queued(&a, "unused", "C", vec![claim("other")], mpsc::channel().0);
    wait_for(|| a.inspect("unused").is_some());
    unused.0.cancel();
    assert!(!unused.2.join().unwrap());
    let cheap = a
        .acquire("cheap", &[claim("other")], &CancellationToken::default())
        .unwrap()
        .unwrap();
    drop(cheap);
    assert_eq!(a.summary().local_compute_active, 1);
    drop(hold);
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "older");
    older.1.send(()).unwrap();
    older.2.join().unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "later");
    later.1.send(()).unwrap();
    later.2.join().unwrap();
}

#[test]
fn cancellation_clears_pending_ticket_but_cannot_release_running_capacity() {
    let a = admission();
    let running_cancel = CancellationToken::default();
    let hold = a
        .acquire_scheduled(
            "running",
            &[],
            &identity("A", "running"),
            ExecutionClass::LocalCompute,
            &running_cancel,
        )
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let cancelled = queued(&a, "cancelled", "B", vec![], tx.clone());
    wait_for(|| a.inspect("cancelled").is_some());
    cancelled.0.cancel();
    assert!(!cancelled.2.join().unwrap());
    assert!(a.inspect("cancelled").is_none());
    let next = queued(&a, "next", "C", vec![], tx);
    wait_for(|| a.inspect("next").is_some());
    running_cancel.cancel();
    assert_eq!(a.summary().local_compute_active, 1);
    assert_eq!(a.inspect("next").unwrap().state, "queued");
    assert!(rx.try_recv().is_err());
    drop(hold);
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "next");
    next.1.send(()).unwrap();
    next.2.join().unwrap();
    assert!(rx.try_recv().is_err());
    assert_eq!(a.summary().queued, 0);
}

#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[test]
fn committed_child_lineage_owns_family_after_parent_completion_and_inspection_is_scoped() {
    use varin_runtime::*;
    let mut f = fixture::Fixture::new();
    let epoch = f.db.epoch();
    // A committed call without a receipt or transient ticket is known but not active.
    assert_eq!(
        f.db.inspect_admission(&f.context.run_id, epoch, &f.context.origin, "dispatch-call")
            .unwrap()["state"],
        "not_active"
    );
    let child = f.accept();
    let (source, proposal, basis) = child_context(&child);
    let child =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    let child_run = child.receipt.as_ref().unwrap().run_id.clone();
    let parent_family = f.db.task_family(&f.context.run_id, epoch).unwrap();
    assert_eq!(f.db.task_family(&child_run, epoch).unwrap(), parent_family);
    let origin = f.context.origin.clone();
    assert_eq!(
        f.db.inspect_admission(&f.context.run_id, epoch, &origin, "dispatch-call")
            .unwrap()["state"],
        // accept_child has already persisted the original dispatch receipt.
        "settled"
    );
    assert!(
        f.db.inspect_admission(&child_run, epoch, &origin, "dispatch-call")
            .is_err()
    );
    assert!(
        f.db.inspect_admission(&f.context.run_id, epoch + 1, &origin, "dispatch-call")
            .is_err()
    );
    assert!(
        f.db.inspect_admission(&f.context.run_id, epoch, &origin, "unknown")
            .is_err()
    );
    f.settle_exchange();
    assert_eq!(
        f.db.inspect_admission(&f.context.run_id, epoch, &origin, "dispatch-call")
            .unwrap()["state"],
        "settled"
    );
    f.db.commit_execution(
        &f.context.run_id,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    assert_eq!(f.db.task_family(&child_run, epoch).unwrap(), parent_family);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

fn child_context(
    child: &varin_runtime::catalog::collaboration::ChildTask,
) -> (
    varin_runtime::catalog::launches::SourceSelection,
    varin_runtime::catalog::context::ContextProposal,
    varin_runtime::catalog::personalization::PersonalizationBasis,
) {
    let mut source = child.source_pin.source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: format!("child-context:{}", child.operation_id),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Read-only child".into(),
        instruction_sources: vec!["review:child".into()],
        memory_checkpoint: None,
    };
    let basis = serde_json::from_value(serde_json::json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"review:child-profile:0","memorySnapshot":{"revision":0,"memories":[]},
        "sessionId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Read-only child"}],"instructionSources":["review:child"]})).unwrap();
    (source, proposal, basis)
}

mod engines {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use varin_runtime::*;
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
        local_compute: bool,
        key: String,
        gate: Option<Mutex<mpsc::Receiver<()>>>,
        started: mpsc::Sender<String>,
        read_only: bool,
    }
    impl ToolExecutor for Tools {
        fn plan(&self, call: &varin_runtime::execution::ToolCall, context: &varin_runtime::execution::FrozenToolContext,
            cancel: &varin_runtime::execution::CancellationToken) -> Result<varin_runtime::execution::ToolPreparation, varin_runtime::execution::ExecutionError> {
            self.prepare(call, context, cancel).map(varin_runtime::execution::ToolPreparation::Ready)
        }

        fn supports_policy_read(
            &self,
            _: &FrozenToolContext,
            _: &ToolCall,
            _: &ToolContract,
        ) -> bool {
            true
        }
        fn execution_class(&self, _: &ToolCall, _: &ToolContract) -> ExecutionClass {
            if self.local_compute {
                ExecutionClass::LocalCompute
            } else {
                ExecutionClass::Unmetered
            }
        }
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
    fn real_catalog_engine_keeps_cheap_control_read_live_and_never_dispatches_cancelled_search() {
        let root =
            std::env::temp_dir().join(format!("varin-family-engine-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Catalog::open(&root).unwrap()));
        let admission = db.lock().unwrap().resource_admission();
        admission.set_compute_capacity(NonZeroUsize::new(1).unwrap());
        let (started, events) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let start = |name: &str, local_compute, gate, cancel| {
            let i = input(&db, name);
            let id = i.run_id.clone();
            let e = ExecutionEngine {
                context_preparation: Arc::new(NoopContextPreparation),
                persistence: db.clone(),
                provider: Arc::new(Provider(AtomicUsize::new(0))),
                tools: Arc::new(Tools {
                    key: name.into(),
                    gate,
                    started: started.clone(),
                    read_only: true,
                    local_compute,
                }),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            };
            (id, std::thread::spawn(move || e.run(i, cancel)))
        };
        let (a_id, a) = start(
            "search-a",
            true,
            Some(Mutex::new(gate)),
            CancellationToken::default(),
        );
        assert_eq!(events.recv_timeout(Duration::from_secs(2)).unwrap(), a_id);
        let cancel = CancellationToken::default();
        let (_, b) = start("search-b", true, None, cancel.clone());
        wait_for(|| admission.summary().queued == 1);
        let (cheap_id, cheap) = start("cheap-read", false, None, CancellationToken::default());
        assert_eq!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            cheap_id
        );
        cheap.join().unwrap().unwrap();
        cancel.cancel();
        b.join().unwrap().unwrap();
        assert_eq!(admission.summary().queued, 0);
        assert!(events.try_recv().is_err());
        assert_eq!(admission.summary().local_compute_active, 1);
        release.send(()).unwrap();
        a.join().unwrap().unwrap();
        assert!(events.try_recv().is_err());
        assert_eq!(admission.summary().local_compute_active, 0);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    struct WatchedTools {
        inner: Tools,
        allowed: Arc<std::sync::atomic::AtomicBool>,
        watched: Arc<Mutex<Option<CancellationToken>>>,
        registrations: Arc<AtomicUsize>,
    }
    impl ToolExecutor for WatchedTools {
        fn plan(&self, call: &varin_runtime::execution::ToolCall, context: &varin_runtime::execution::FrozenToolContext,
            cancel: &varin_runtime::execution::CancellationToken) -> Result<varin_runtime::execution::ToolPreparation, varin_runtime::execution::ExecutionError> {
            self.prepare(call, context, cancel).map(varin_runtime::execution::ToolPreparation::Ready)
        }

        fn execution_class(&self, call: &ToolCall, contract: &ToolContract) -> ExecutionClass {
            self.inner.execution_class(call, contract)
        }
        fn prepare(
            &self,
            call: &ToolCall,
            context: &FrozenToolContext,
            _cancel: &CancellationToken,
        ) -> Result<ToolContract, ExecutionError> {
            self.inner.prepare(call, context, _cancel)
        }
        fn authorize(
            &self,
            _: &ToolExecutionContext,
            _: &ToolCall,
            _: &ToolContract,
            _: &CancellationToken,
        ) -> Result<(), ExecutionError> {
            if self.allowed.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(ExecutionError::new("revoked", "review grant revoked"))
            }
        }
        fn watch_admission(
            &self,
            _: &ToolExecutionContext,
            _: &ToolCall,
            _: &ToolContract,
            token: &CancellationToken,
        ) -> Result<Option<AdmissionControlGuard>, ExecutionError> {
            self.registrations.fetch_add(1, Ordering::SeqCst);
            *self.watched.lock().unwrap() = Some(token.clone());
            let registrations = self.registrations.clone();
            Ok(Some(AdmissionControlGuard::new(move || {
                registrations.fetch_sub(1, Ordering::SeqCst);
            })))
        }
        fn execute(
            &self,
            context: &ToolExecutionContext,
            call: &ToolCall,
            contract: &ToolContract,
            token: &CancellationToken,
        ) -> ToolCompletion {
            self.inner.execute(context, call, contract, token)
        }
    }
    #[test]
    fn queued_revocation_wakes_without_permit_and_late_authorization_cannot_revive_call() {
        let root =
            std::env::temp_dir().join(format!("varin-family-revoke-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Catalog::open(&root).unwrap()));
        let a = db.lock().unwrap().resource_admission();
        a.set_compute_capacity(NonZeroUsize::new(1).unwrap());
        let holder = a
            .acquire_scheduled(
                "busy",
                &[],
                &super::identity("other", "busy"),
                ExecutionClass::LocalCompute,
                &CancellationToken::default(),
            )
            .unwrap()
            .unwrap();
        let i = input(&db, "revoked");
        let (started, events) = mpsc::channel();
        let watched = Arc::new(Mutex::new(None));
        let registrations = Arc::new(AtomicUsize::new(0));
        let allowed = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let engine = ExecutionEngine {
            context_preparation: Arc::new(NoopContextPreparation),
            persistence: db.clone(),
            provider: Arc::new(Provider(AtomicUsize::new(0))),
            tools: Arc::new(WatchedTools {
                inner: Tools {
                    key: "revoked".into(),
                    gate: None,
                    started,
                    read_only: true,
                    local_compute: true,
                },
                allowed: allowed.clone(),
                watched: watched.clone(),
                registrations: registrations.clone(),
            }),
            policy: Arc::new(DefaultAgentPolicy),
            progress: ProgressSink::default(),
        };
        let worker = std::thread::spawn(move || engine.run(i, CancellationToken::default()));
        wait_for(|| a.summary().queued == 1);
        assert_eq!(registrations.load(Ordering::SeqCst), 1);
        allowed.store(false, Ordering::SeqCst);
        watched.lock().unwrap().as_ref().unwrap().cancel();
        worker.join().unwrap().unwrap();
        assert_eq!(registrations.load(Ordering::SeqCst), 0);
        assert_eq!(a.summary().queued, 0);
        allowed.store(true, Ordering::SeqCst);
        drop(holder);
        assert!(events.try_recv().is_err());
        assert_eq!(a.summary().local_compute_active, 0);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    struct ReadPolicy;
    impl AgentPolicy for ReadPolicy {
        fn identity(&self) -> PolicyIdentity {
            PolicyIdentity {
                name: "family-review".into(),
                version: "1".into(),
            }
        }
        fn decide(
            &self,
            _: &PolicyView<'_>,
            event: &PolicyEvent,
            _: &Value,
            _: &CancellationToken,
        ) -> Result<PolicyDecision, ExecutionError> {
            let action = if matches!(event, PolicyEvent::Started) {
                json!({"kind":"read_graph","nodes":[{"id":"graph-call","depends_on":[],"call":{"call_id":"graph-call","name":"read","schema_version":"1","arguments":{}}}]})
            } else {
                json!({"kind":"complete"})
            };
            Ok(PolicyDecision {
                action: serde_json::from_value(action).unwrap(),
                state: Value::Null,
            })
        }
    }
    #[test]
    fn policy_graph_uses_same_capacity_and_keeps_real_origin_through_settlement() {
        let root =
            std::env::temp_dir().join(format!("varin-family-policy-{}", uuid::Uuid::new_v4()));
        let db = Arc::new(Mutex::new(Catalog::open(&root).unwrap()));
        let a = db.lock().unwrap().resource_admission();
        a.set_compute_capacity(NonZeroUsize::new(1).unwrap());
        let holder = a
            .acquire_scheduled(
                "busy",
                &[],
                &super::identity("ordinary-family", "busy"),
                ExecutionClass::LocalCompute,
                &CancellationToken::default(),
            )
            .unwrap()
            .unwrap();
        let mut i = input(&db, "graph");
        i = db
            .lock()
            .unwrap()
            .prepare_execution(&i.run_id, i.binding, ReadPolicy.identity(), Value::Null)
            .unwrap();
        let run_id = i.run_id.clone();
        let epoch = i.owner_generation;
        let (started, events) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let engine = ExecutionEngine {
            context_preparation: Arc::new(NoopContextPreparation),
            persistence: db.clone(),
            provider: Arc::new(Provider(AtomicUsize::new(0))),
            tools: Arc::new(Tools {
                key: "graph-read".into(),
                gate: Some(Mutex::new(gate)),
                started,
                read_only: true,
                local_compute: true,
            }),
            policy: Arc::new(ReadPolicy),
            progress: ProgressSink::default(),
        };
        let worker = std::thread::spawn(move || engine.run(i, CancellationToken::default()));
        wait_for(|| a.summary().queued == 1 || worker.is_finished());
        if worker.is_finished() {
            panic!(
                "policy ended before admission: {:?}",
                worker.join().unwrap()
            );
        }
        assert!(events.try_recv().is_err());
        // The operation identity is discovered through the real Catalog graph record.
        let graph = db.policy_graph(&run_id, epoch).unwrap().unwrap();
        let origin = ToolOrigin::PolicyAction {
            action_id: graph.intent.action_id().to_owned(),
            node_id: "graph-call".into(),
        };
        let queued = db
            .lock()
            .unwrap()
            .inspect_admission(&run_id, epoch, &origin, "graph-call")
            .unwrap();
        assert_eq!(queued["state"], "queued");
        assert_eq!(queued["queue"]["familyId"], "graph");
        drop(holder);
        assert_eq!(events.recv_timeout(Duration::from_secs(2)).unwrap(), run_id);
        assert_eq!(
            db.lock()
                .unwrap()
                .inspect_admission(&run_id, epoch, &origin, "graph-call")
                .unwrap()["state"],
            "active"
        );
        release.send(()).unwrap();
        worker.join().unwrap().unwrap();
        assert_eq!(
            db.lock()
                .unwrap()
                .inspect_admission(&run_id, epoch, &origin, "graph-call")
                .unwrap()["state"],
            "settled"
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    struct WatchGateTools {
        inner: Tools,
        entered: mpsc::Sender<ToolExecutionContext>,
        release: Mutex<mpsc::Receiver<()>>,
        dropped: Arc<AtomicUsize>,
    }
    impl ToolExecutor for WatchGateTools {
        fn plan(&self, call: &varin_runtime::execution::ToolCall, context: &varin_runtime::execution::FrozenToolContext,
            cancel: &varin_runtime::execution::CancellationToken) -> Result<varin_runtime::execution::ToolPreparation, varin_runtime::execution::ExecutionError> {
            self.prepare(call, context, cancel).map(varin_runtime::execution::ToolPreparation::Ready)
        }

        fn supports_policy_read(
            &self,
            c: &FrozenToolContext,
            call: &ToolCall,
            contract: &ToolContract,
        ) -> bool {
            self.inner.supports_policy_read(c, call, contract)
        }
        fn execution_class(&self, call: &ToolCall, contract: &ToolContract) -> ExecutionClass {
            self.inner.execution_class(call, contract)
        }
        fn prepare(
            &self,
            call: &ToolCall,
            c: &FrozenToolContext,
            _cancel: &CancellationToken,
        ) -> Result<ToolContract, ExecutionError> {
            self.inner.prepare(call, c, _cancel)
        }
        fn authorize(
            &self,
            c: &ToolExecutionContext,
            call: &ToolCall,
            contract: &ToolContract,
            token: &CancellationToken,
        ) -> Result<(), ExecutionError> {
            self.inner.authorize(c, call, contract, token)
        }
        fn watch_admission(
            &self,
            c: &ToolExecutionContext,
            _: &ToolCall,
            _: &ToolContract,
            _: &CancellationToken,
        ) -> Result<Option<AdmissionControlGuard>, ExecutionError> {
            self.entered.send(c.clone()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            let dropped = self.dropped.clone();
            Ok(Some(AdmissionControlGuard::new(move || {
                dropped.fetch_add(1, Ordering::SeqCst);
            })))
        }
        fn execute(
            &self,
            c: &ToolExecutionContext,
            call: &ToolCall,
            contract: &ToolContract,
            token: &CancellationToken,
        ) -> ToolCompletion {
            self.inner.execute(c, call, contract, token)
        }
    }
    fn supervisor_cancel_during_watch(policy_graph: bool) {
        use varin_runtime::supervisor::{RunStart, RunSupervisor};
        let root = std::env::temp_dir().join(format!(
            "varin-watch-cancel-review-{}",
            uuid::Uuid::new_v4()
        ));
        let supervisor = RunSupervisor::new(Catalog::open(&root).unwrap());
        let db = supervisor.catalog();
        let i = input(
            &db,
            if policy_graph {
                "watch-policy"
            } else {
                "watch-model"
            },
        );
        let run_id = i.run_id.clone();
        let epoch = i.owner_generation;
        let (entered, gate) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (started, dispatches) = mpsc::channel();
        let dropped = Arc::new(AtomicUsize::new(0));
        let handle = supervisor
            .start(
                &run_id,
                RunStart {
                    context_preparation: Arc::new(NoopContextPreparation),
                    binding: i.binding,
                    policy_state: Value::Null,
                    provider: Arc::new(Provider(AtomicUsize::new(0))),
                    tools: Arc::new(WatchGateTools {
                        inner: Tools {
                            key: "watch-race".into(),
                            gate: None,
                            started,
                            read_only: true,
                            local_compute: true,
                        },
                        entered,
                        release: Mutex::new(released),
                        dropped: dropped.clone(),
                    }),
                    policy: if policy_graph {
                        Arc::new(ReadPolicy)
                    } else {
                        Arc::new(DefaultAgentPolicy)
                    },
                    progress: ProgressSink::default(),
                },
            )
            .unwrap();
        let context = gate.recv_timeout(Duration::from_secs(5)).unwrap();
        // This calls both the real supervisor token cancellation and durable cancel request.
        let cancelled = supervisor.cancel(&run_id).unwrap();
        assert!(cancelled.cancel_requested);
        release.send(()).unwrap();
        let mut result = None;
        wait_for(|| {
            result = handle.try_result().unwrap();
            result.is_some()
        });
        let result = result.unwrap();
        let run = db.lock().unwrap().run(&run_id).unwrap();
        eprintln!("watch-race policy={policy_graph} result={result:?} durable={run:?}");
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert!(
            dispatches.try_recv().is_err(),
            "cancelled tool must never dispatch"
        );
        assert_eq!(
            run.state,
            RunState::Cancelled,
            "explicit cancellation must not become recovery Waiting"
        );
        assert!(run.waiting_on.is_none());
        assert_eq!(result.unwrap().state, RunState::Cancelled);
        assert!(supervisor.execution_failure(&run_id).unwrap().is_none());
        let call_id = if policy_graph { "graph-call" } else { "call" };
        assert_eq!(
            db.lock()
                .unwrap()
                .inspect_admission(&run_id, epoch, &context.origin, call_id)
                .unwrap()["state"],
            "settled"
        );
        let admission = db.lock().unwrap().resource_admission().summary();
        assert_eq!(admission.queued, 0);
        assert_eq!(admission.local_compute_active, 0);
        drop(handle);
        drop(supervisor);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn supervisor_cancel_during_model_watch_settles_without_recovery_wait() {
        supervisor_cancel_during_watch(false);
    }
    #[test]
    fn supervisor_cancel_during_policy_watch_settles_without_recovery_wait() {
        supervisor_cancel_during_watch(true);
    }
}

#[test]
fn resource_blocked_family_does_not_reserve_compute_capacity_or_stall_independent_family() {
    let a = admission();
    let file = a
        .acquire(
            "file-holder",
            &[claim("locked")],
            &CancellationToken::default(),
        )
        .unwrap()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let blocked = queued(&a, "blocked", "A", vec![claim("locked")], tx.clone());
    wait_for(|| a.inspect("blocked").is_some());
    assert_eq!(a.summary().local_compute_active, 0);
    let independent = queued(&a, "independent", "B", vec![claim("free")], tx);
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        "independent"
    );
    assert_eq!(
        a.inspect("blocked").unwrap().reason,
        Some("resource_conflict")
    );
    independent.1.send(()).unwrap();
    assert!(independent.2.join().unwrap());
    drop(file);
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), "blocked");
    blocked.1.send(()).unwrap();
    assert!(blocked.2.join().unwrap());
    assert_eq!(a.summary().queued, 0);
}
