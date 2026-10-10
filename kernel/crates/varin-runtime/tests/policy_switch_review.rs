//! Real Catalog cuts and Engine recovery; no Host IPC, paid model, or synthetic activation action.
#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::{
    catalog::{inputs::EnqueueInput, launches::LaunchSelection, policy_switch::*},
    execution::*,
    *,
};
fn target(version: &str) -> PolicyTarget {
    PolicyTarget::Extension {
        artifact: AgentPolicyArtifactBinding {
            provider_key: "fixture:policy".into(),
            extension_id: "fixture".into(),
            extension_version: version.into(),
            service_id: "varin.agent.policy".into(),
            service_version: 3,
            artifact_integrity: format!("artifact-{version}"),
            configuration_identity: "configuration".into(),
            declared_identity: PolicyIdentity {
                name: "strategy".into(),
                version: version.into(),
            },
            identity: PolicyIdentity {
                name: "fixture:strategy".into(),
                version: format!("exact-{version}"),
            },
            model_roles: vec![],
            state_transition: PolicyStateTransition::Explicit,
        },
    }
}
struct Fixture {
    root: std::path::PathBuf,
    db: Option<Catalog>,
    run: String,
    binding: RequestBinding,
    old: PolicyIdentity,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-policy-switch-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("original input"),
                configuration: json!({}),
            })
            .unwrap();
        let binding = RequestBinding {
            goal: None, resource_activations: Vec::new(),
            resource_checkpoint_id: None,
            connection_identity: "main-original".into(),
            provider_family: "fixture".into(),
            model: "main-original".into(),
            credential_ref: None,
            configuration_generation: 7,
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
        let default = DefaultAgentPolicy.identity();
        db.select_launch(
            &receipt.run_id,
            LaunchSelection::from_binding(&binding, default.clone(), None),
        )
        .unwrap();
        let old = target("old").identity();
        let prep = db
            .prepare_policy_change(&receipt.run_id, default, old.clone(), vec![], target("old"))
            .unwrap()
            .load()
            .unwrap();
        db.admit_launch_change(prep).unwrap();
        db.bind_launch(
            &receipt.run_id,
            LaunchSelection::from_binding(&binding, old.clone(), None),
        )
        .unwrap();
        Self {
            root,
            db: Some(db),
            run: receipt.run_id,
            binding,
            old,
        }
    }
    fn db(&mut self) -> &mut Catalog {
        self.db.as_mut().unwrap()
    }
    fn ready(&mut self, id: &str, mode: PolicyStateMode) -> PolicySelection {
        let run = self.run.clone();
        let selected = self.db().policy_selections(&run).unwrap();
        let selection = self
            .db()
            .select_policy(
                &run,
                id,
                selected.active.generation,
                selected.desired.map(|s| s.selection_id),
                target(id),
                mode,
            )
            .unwrap();
        let prep = self
            .db()
            .prepare_policy_ready(
                &run,
                id,
                selection.generation,
                target(id).identity(),
                vec![],
            )
            .unwrap()
            .load()
            .unwrap();
        self.db().publish_policy_ready(prep).unwrap()
    }
    fn control(&mut self, action: PolicyAction, state: Value) -> PolicyControlReceipt {
        let run = self.run.clone();
        let identity = self
            .db()
            .launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection
            .policy;
        let epoch = self.db().epoch();
        let boundary = self.db().policy_boundary(&run, epoch).unwrap();
        let intent = PolicyControlIntent {
            action_id: format!("{run}:policy:{}", boundary.id),
            boundary,
            identity,
            state,
            expected_head: self.db().head("main").unwrap(),
            action,
        };
        let prepared = self.db().prepare_policy_control().load(&intent).unwrap();
        self.db()
            .commit_policy_control(&run, epoch, prepared)
            .unwrap()
    }
    fn enqueue(&mut self, key: &str) {
        self.db()
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
    fn reopen(&mut self) {
        drop(self.db.take());
        self.db = Some(Catalog::open(&self.root).unwrap());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.db.take());
        let _ = std::fs::remove_dir_all(&self.root);
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
        panic!("no tools")
    }
    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        panic!("no tools")
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        panic!("no tools")
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        panic!("no tools")
    }
}
#[derive(Default)]
struct Provider(Mutex<Vec<RequestSnapshot>>);
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
        self.0.lock().unwrap().push(r.clone());
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "answer".into(),
                content: Content::Text {
                    text: "continued".into(),
                },
                opaque: None,
            },
        })
        .unwrap();
        Ok(FinishReason::Stop)
    }
}
struct FinishPolicy(PolicyIdentity);
impl AgentPolicy for FinishPolicy {
    fn identity(&self) -> PolicyIdentity {
        self.0.clone()
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        assert!(
            matches!(event, PolicyEvent::ModelCompleted { .. }),
            "pending decision was discarded: {event:?}"
        );
        assert_eq!(state, &json!({"pending":"new"}));
        Ok(PolicyDecision {
            action: PolicyAction::Complete,
            state: state.clone(),
        })
    }
}
#[test]
fn resumed_cut_survives_activation_then_pending_decision_crash_and_gc() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let delivered = f.control(
        PolicyAction::Deliver {
            text: "already delivered".into(),
        },
        json!({"old":"delivered"}),
    );
    let PolicyControlReceipt::Delivered {
        action_id: deliver_id,
        ..
    } = delivered
    else {
        panic!()
    };
    let pause = f.control(
        PolicyAction::Pause {
            reason: "explicit approval".into(),
        },
        json!({"old":"paused"}),
    );
    let PolicyControlReceipt::Paused { action_id, wait_id } = pause else {
        panic!()
    };
    let selection = f.ready("new", PolicyStateMode::RestartState);
    let epoch = f.db().epoch();
    assert!(f
        .db()
        .capture_policy_activation(&run, epoch, &selection.selection_id, selection.generation)
        .unwrap()
        .is_none());
    f.enqueue("new actual instruction");
    assert!(f
        .db()
        .capture_policy_activation(&run, epoch, &selection.selection_id, selection.generation)
        .unwrap()
        .is_none());
    let resume = f.db().resume_policy_pause(&run, &wait_id, epoch).unwrap();
    assert_eq!(resume.action_id, action_id);
    assert!(f
        .db()
        .capture_policy_activation(&run, epoch, &selection.selection_id, selection.generation)
        .unwrap()
        .is_none());
    let head = f.db().head("main").unwrap();
    f.db().consume_inputs(&run, epoch, head.as_deref()).unwrap();
    let event = PolicyEvent::Resumed {
        action_id: action_id.clone(),
        wait_id: wait_id.clone(),
    };
    let prepared = f
        .db()
        .capture_policy_activation(&run, epoch, &selection.selection_id, selection.generation)
        .unwrap()
        .unwrap()
        .load(&Value::Null, &event)
        .unwrap();
    let activated = f.db().activate_policy(prepared).unwrap().unwrap();
    assert_eq!(activated.status, PolicySelectionStatus::Active);
    // No Host acknowledgment or in-memory swap is necessary for the committed choice to recover.
    let old_boundary = f.db().policy_boundary(&run, epoch).unwrap();
    assert_ne!(format!("{run}:policy:{}", old_boundary.id), deliver_id);
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::PolicyCheckpoint {
                previous_state: Value::Null,
                identity: target("new").identity(),
                state: json!({"pending":"new"}),
                action: PolicyAction::RequestModel,
                event: event.clone(),
            },
        )
        .unwrap();
    content_collection::collect(|| f.db().prepare_content_collection(Default::default())).unwrap();
    f.reopen();
    content_collection::collect(|| f.db().prepare_content_collection(Default::default())).unwrap();
    let binding = f.binding.clone();
    let (new_input, recovery) = f
        .db()
        .prepare_recovered_execution(&run, binding, target("new").identity(), Value::Null)
        .unwrap();
    let recovery = recovery.unwrap();
    assert_eq!(recovery.event, event);
    assert!(matches!(
        recovery.decision.as_ref().map(|d| &d.action),
        Some(PolicyAction::RequestModel)
    ));
    let launch = f.db().launch_intent(&run).unwrap().unwrap();
    assert_eq!(launch.policy_target, target("new"));
    assert_eq!(launch.policy_generation, selection.generation);
    assert_eq!(launch.selection.model, "main-original");
    assert!(!launch.policy_preparable);
    let provider = Arc::new(Provider::default());
    let db = Arc::new(Mutex::new(f.db.take().unwrap()));
    let report = ExecutionEngine {
        persistence: db.clone(),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: provider.clone(),
        tools: Arc::new(NoTools),
        policy: Arc::new(FinishPolicy(target("new").identity())),
        progress: ProgressSink::default(),
    }
    .run_recovered(new_input, CancellationToken::default(), Some(recovery))
    .unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(provider.0.lock().unwrap().len(), 1);
    let history = db.lock().unwrap().history("main").unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|i| i.source == HistorySource::User)
            .count(),
        2
    );
    assert_eq!(
        history.iter().filter(|i| i.id.ends_with(":output")).count(),
        1
    );
    let old = db.lock().unwrap().operation(&action_id).unwrap();
    assert_eq!(old.outcome, Some(Outcome::Succeeded));
    assert_eq!(
        db.lock()
            .unwrap()
            .policy_selections(&run)
            .unwrap()
            .active
            .generation,
        selection.generation
    );
}
#[test]
fn pending_decision_input_and_superseded_candidates_cannot_be_overwritten() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let epoch = f.db().epoch();
    let old = f.old.clone();
    f.db()
        .commit_execution(
            &run,
            epoch,
            &ExecutionRecord::PolicyCheckpoint {
                previous_state: Value::Null,
                identity: old.clone(),
                state: json!({"private":"old decision"}),
                action: PolicyAction::RequestModel,
                event: PolicyEvent::Started,
            },
        )
        .unwrap();
    let a = f.ready("a", PolicyStateMode::RestartState);
    assert!(f
        .db()
        .capture_policy_activation(&run, epoch, "a", a.generation)
        .unwrap()
        .is_none());
    let b = f.ready("b", PolicyStateMode::Preserve);
    let retry = f
        .db()
        .select_policy(
            &run,
            "a",
            0,
            None,
            target("a"),
            PolicyStateMode::RestartState,
        )
        .unwrap();
    assert_eq!(retry.status, PolicySelectionStatus::Superseded);
    assert_eq!(
        f.db()
            .policy_selections(&run)
            .unwrap()
            .desired
            .unwrap()
            .selection_id,
        "b"
    );
    assert!(f
        .db()
        .select_policy(
            &run,
            "stale",
            0,
            Some("a".into()),
            target("stale"),
            PolicyStateMode::RestartState
        )
        .is_err());
    f.db()
        .fail_policy_selection(&run, "b", "policy_state_incompatible")
        .unwrap();
    assert_eq!(f.db().policy_selections(&run).unwrap().active.identity, old);
    let c = f.ready("c", PolicyStateMode::Preserve);
    assert!(c.generation > b.generation);
    f.reopen();
    assert_eq!(
        f.db()
            .policy_selection(&run, "c")
            .unwrap()
            .failure
            .as_deref(),
        Some("policy_preparation_interrupted")
    );
    let binding = f.binding.clone();
    let (_, recovery) = f
        .db()
        .prepare_recovered_execution(&run, binding, old, Value::Null)
        .unwrap();
    assert_eq!(
        recovery.unwrap().decision.unwrap().state,
        json!({"private":"old decision"})
    );
}
#[test]
fn staged_activation_rechecks_input_cancellation_and_latest_selection() {
    let mut f = Fixture::new();
    let run = f.run.clone();
    let epoch = f.db().epoch();
    let a = f.ready("a", PolicyStateMode::RestartState);
    let prepared = f
        .db()
        .capture_policy_activation(&run, epoch, "a", a.generation)
        .unwrap()
        .unwrap()
        .load(&Value::Null, &PolicyEvent::Started)
        .unwrap();
    f.enqueue("wins before activation");
    assert!(f.db().activate_policy(prepared).unwrap().is_none());
    assert_eq!(f.db().policy_selections(&run).unwrap().active.generation, 0);
    let head = f.db().head("main").unwrap();
    let delivered = f.db().consume_inputs(&run, epoch, head.as_deref()).unwrap();
    let event = PolicyEvent::InputDelivered {
        input_ids: delivered
            .iter()
            .filter_map(|item| match &item.provenance {
                Provenance::UserInstruction { input_id } => Some(input_id.clone()),
                _ => None,
            })
            .collect(),
    };
    let prepared = f
        .db()
        .capture_policy_activation(&run, epoch, "a", a.generation)
        .unwrap()
        .unwrap()
        .load(&Value::Null, &event)
        .unwrap();
    let b = f.ready("b", PolicyStateMode::RestartState);
    assert!(f.db().activate_policy(prepared).unwrap().is_none());
    let prepared = f
        .db()
        .capture_policy_activation(&run, epoch, "b", b.generation)
        .unwrap()
        .unwrap()
        .load(&Value::Null, &event)
        .unwrap();
    f.db().cancel_policy_selection(&run, "b").unwrap();
    assert!(f.db().activate_policy(prepared).unwrap().is_none());
    assert_eq!(f.db().policy_selections(&run).unwrap().active.generation, 0);
}

struct InputWinsCompletion {
    db: Arc<Mutex<Catalog>>,
    identity: PolicyIdentity,
    committed: Value,
    continuation: PolicyEvent,
    insert_during_decide: bool,
    calls: Mutex<usize>,
}
impl AgentPolicy for InputWinsCompletion {
    fn identity(&self) -> PolicyIdentity {
        self.identity.clone()
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let mut calls = self.calls.lock().unwrap();
        let first = *calls == 0;
        *calls += 1;
        assert!(
            state == &self.committed,
            "unexecuted completion advanced private state"
        );
        if first && self.insert_during_decide {
            assert_eq!(event, &self.continuation);
            self.db
                .lock()
                .unwrap()
                .enqueue_input(&EnqueueInput {
                    key: "wins-live-completion".into(),
                    thread_id: "thread".into(),
                    branch_id: "main".into(),
                    mode: InputMode::Boundary,
                    input: json!({"text":"do the new work"}),
                    configuration: None,
                })
                .unwrap();
            return Ok(PolicyDecision {
                state: json!({"obsolete":"must not commit"}),
                action: PolicyAction::Complete,
            });
        }
        if matches!(
            self.continuation,
            PolicyEvent::Delivered { .. } | PolicyEvent::Resumed { .. }
        ) {
            assert_eq!(
                event, &self.continuation,
                "input replaced an unconsumed control continuation"
            );
        } else {
            let PolicyEvent::InputDelivered { input_ids } = event else {
                panic!("missing actual input continuation: {event:?}")
            };
            assert_eq!(input_ids.len(), 1);
            assert!(view.history.iter().any(|item| matches!(&item.provenance, Provenance::UserInstruction { input_id } if input_id == &input_ids[0])));
        }
        assert_eq!(
            view.history
                .iter()
                .filter(|item| matches!(item.provenance, Provenance::UserInstruction { .. }))
                .count(),
            2
        );
        Ok(PolicyDecision {
            state: json!({"finished":"new input observed"}),
            action: PolicyAction::Complete,
        })
    }
}

#[test]
fn input_winning_pending_completion_preserves_committed_activation_live_and_after_crash() {
    for control in ["started", "delivered", "resumed"] {
        for crash in [false, true] {
            let mut f = Fixture::new();
            let run = f.run.clone();
            let epoch = f.db().epoch();
            let event = match control {
                "delivered" => match f.control(
                    PolicyAction::Deliver {
                        text: "original delivery".into(),
                    },
                    json!({"old":"delivered"}),
                ) {
                    PolicyControlReceipt::Delivered { action_id, item } => PolicyEvent::Delivered {
                        action_id,
                        item_id: item.id,
                    },
                    _ => panic!(),
                },
                "resumed" => match f.control(
                    PolicyAction::Pause {
                        reason: "explicit pause".into(),
                    },
                    json!({"old":"paused"}),
                ) {
                    PolicyControlReceipt::Paused { action_id, wait_id } => {
                        f.db().resume_policy_pause(&run, &wait_id, epoch).unwrap();
                        PolicyEvent::Resumed { action_id, wait_id }
                    }
                    _ => panic!(),
                },
                _ => PolicyEvent::Started,
            };
            let selected = f.ready("input-wins", PolicyStateMode::Preserve);
            let committed = json!({"committed":"activated", "private_body":"x".repeat(100_000)});
            let staged = f
                .db()
                .capture_policy_activation(&run, epoch, &selected.selection_id, selected.generation)
                .unwrap()
                .unwrap()
                .load(&committed, &event)
                .unwrap();
            f.db().activate_policy(staged).unwrap().unwrap();
            if crash {
                f.db()
                    .commit_execution(
                        &run,
                        epoch,
                        &ExecutionRecord::StateChanged {
                            state: RunState::Runnable,
                            waiting_on: None,
                        },
                    )
                    .unwrap();
                f.db()
                    .commit_execution(
                        &run,
                        epoch,
                        &ExecutionRecord::PolicyCheckpoint {
                            identity: target("input-wins").identity(),
                            previous_state: committed.clone(),
                            state: json!({"obsolete":"must not commit"}),
                            action: PolicyAction::Complete,
                            event: event.clone(),
                        },
                    )
                    .unwrap();
                f.enqueue("wins-before-crash");
                assert!(matches!(
                    f.db().commit_execution(
                        &run,
                        epoch,
                        &ExecutionRecord::StateChanged {
                            state: RunState::Completed,
                            waiting_on: None
                        }
                    ),
                    Err(RuntimeError::InputPending)
                ));
                let head = f.db().head("main").unwrap();
                assert_eq!(
                    f.db()
                        .consume_inputs(&run, epoch, head.as_deref())
                        .unwrap()
                        .len(),
                    1
                );
                content_collection::collect(|| f.db().prepare_content_collection(Default::default())).unwrap();
                f.reopen();
                content_collection::collect(|| f.db().prepare_content_collection(Default::default())).unwrap();
            }
            let binding = f.binding.clone();
            let (input, recovery) = f
                .db()
                .prepare_recovered_execution(
                    &run,
                    binding,
                    target("input-wins").identity(),
                    Value::Null,
                )
                .unwrap();
            assert!(input.policy_state == committed);
            assert!(recovery.as_ref().unwrap().decision.is_none());
            let db = Arc::new(Mutex::new(f.db.take().unwrap()));
            let policy = Arc::new(InputWinsCompletion {
                db: db.clone(),
                identity: target("input-wins").identity(),
                committed,
                continuation: event,
                insert_during_decide: !crash,
                calls: Mutex::new(0),
            });
            let report = ExecutionEngine {
                persistence: db.clone(),
                context_preparation: Arc::new(NoopContextPreparation),
                provider: Arc::new(Provider::default()),
                tools: Arc::new(NoTools),
                policy: policy.clone(),
                progress: ProgressSink::default(),
            }
            .run_recovered(input, CancellationToken::default(), recovery)
            .unwrap();
            assert_eq!(report.state, RunState::Completed);
            assert_eq!(*policy.calls.lock().unwrap(), if crash { 1 } else { 2 });
            assert_eq!(
                report.policy_state,
                json!({"finished":"new input observed"})
            );
            assert_eq!(
                db.lock()
                    .unwrap()
                    .policy_selections(&run)
                    .unwrap()
                    .active
                    .generation,
                selected.generation
            );
            drop(policy);
            drop(db);
        }
    }
}
