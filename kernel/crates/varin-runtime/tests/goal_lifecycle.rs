//! Actual Catalog/ContentStore execution and occurrence boundaries, with recorded provider usage.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::{
    catalog::{followups::ContinuationAdmission, goals::*, launches::LaunchSelection},
    execution::*,
    *,
};
struct Fixture {
    root: std::path::PathBuf,
    db: Catalog,
    run: String,
}
fn scope() -> GoalScope {
    GoalScope {
        thread_id: "thread".into(),
        branch_id: "branch".into(),
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("varin-goal-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"default","version":"1"},"source":null})).unwrap();
        let r = db
            .submit_with_launch(
                &SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("ordinary task"),
                    configuration: json!({}),
                },
                Some(launch),
            )
            .unwrap();
        let mut f = Self {
            root,
            db,
            run: r.run_id,
        };
        f.state(RunState::Runnable, None);
        f
    }
    fn state(&mut self, state: RunState, waiting_on: Option<String>) {
        self.record(ExecutionRecord::StateChanged { state, waiting_on });
    }
    fn record(&mut self, r: ExecutionRecord) {
        self.db
            .commit_execution(&self.run, self.db.epoch(), &r)
            .unwrap();
    }
    fn start(&mut self, id: &str, budget: Option<u64>) -> GoalControlReceipt {
        let p = self
            .db
            .prepare_goal_start(
                id,
                &self.run,
                scope(),
                "Finish the explicitly chosen objective".into(),
                budget.map(|max_output_tokens| GoalBudget { max_output_tokens }),
            )
            .unwrap()
            .load()
            .unwrap();
        self.db.admit_goal_mutation(p).unwrap()
    }
    fn goal(&self, id: &str) -> Goal {
        self.db.capture_goal(id).unwrap().load().unwrap()
    }
    fn prepare(&mut self, id: &str) {
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: self.db.head("branch").unwrap(),
        };
        let goal = self.db.goal_binding(&self.run).unwrap();
        self.record(ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: id.into(),
                    run_id: self.run.clone(),
                    origin: RequestOrigin::Conversation {
                        step: 1,
                        history_range: range.clone(),
                    },
                    binding: RequestBinding {
                        child_dispatch: None,
                        goal,
                        resource_activations: vec![],
                        resource_checkpoint_id: None,
                        connection_identity: "fixture".into(),
                        provider_family: "fixture".into(),
                        model: "fixture".into(),
                        credential_ref: None,
                        configuration_generation: 1,
                        tool_schema_generation: 1,
                        tools: vec![],
                        instruction_sources: vec![],
                        memory_checkpoint: None,
                        attachment_refs: vec![],
                        environment_cursor: 0,
                        history_range: range,
                    },
                    history: vec![],
                },
                serialized: json!({}),
            },
        });
    }
    fn finish(&mut self, id: &str, n: u64) -> ExecutionRecord {
        let r = ExecutionRecord::ModelFinished {
            request_id: id.into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::Stop),
            items: vec![ProviderItem {
                id: format!("{id}-answer"),
                content: Content::Text {
                    text: "A useful increment".into(),
                },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                output_tokens: Some(n),
                ..Default::default()
            },
            failure: None,
        };
        self.record(r.clone());
        r
    }
    fn admit(&mut self) -> Vec<String> {
        let mut ids = vec![];
        for p in self.db.capture_followup_continuations().unwrap() {
            if let ContinuationAdmission::Admitted(r) = self
                .db
                .admit_followup_continuation(p.load().unwrap())
                .unwrap()
            {
                ids.push(r.run_id);
            }
        }
        ids
    }
    fn reopen(self) -> Self {
        let Self { root, db, run } = self;
        drop(db);
        Self {
            db: Catalog::open(&root).unwrap(),
            root,
            run,
        }
    }
    fn cleanup(self) {
        let Self { root, db, .. } = self;
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn ordinary_runs_do_not_create_goals_and_completion_continues_only_explicit_goal() {
    let mut f = Fixture::new();
    assert!(f.db.capture_goals("thread").unwrap().is_empty());
    f.start("goal", None);
    let context =
        f.db.capture_goal_context(&f.run, f.db.epoch())
            .unwrap()
            .unwrap()
            .load()
            .unwrap();
    assert!(matches!(
        context.item.unwrap().provenance,
        Provenance::GoalInstruction { .. }
    ));
    f.prepare("one");
    f.record(ExecutionRecord::ModelDispatched {
        request_id: "one".into(),
    });
    let receipt = f.finish("one", 7);
    f.record(receipt);
    assert_eq!(f.goal("goal").usage.actual.output_tokens.known, 7);
    f.state(RunState::Completed, None);
    let next = f.admit();
    assert_eq!(next.len(), 1);
    assert!(f.admit().is_empty());
    assert_eq!(f.db.run(&next[0]).unwrap().state, RunState::Accepted);
    assert_eq!(f.goal("goal").state, GoalState::Active);
    let f = f.reopen();
    assert_eq!(f.goal("goal").usage.actual.inferences, 1);
    assert_eq!(f.db.goal_binding(&next[0]).unwrap().unwrap().id, "goal");
    f.cleanup();
}
#[test]
fn real_output_overshoot_pauses_future_dispatch_and_user_pause_survives_budget_update() {
    let mut f = Fixture::new();
    f.start("goal", Some(5));
    f.prepare("one");
    f.record(ExecutionRecord::ModelDispatched {
        request_id: "one".into(),
    });
    f.finish("one", 8);
    assert_eq!(f.goal("goal").state, GoalState::BudgetLimited);
    assert_eq!(f.goal("goal").usage.actual.output_tokens.known, 8);
    let GoalBoundary::Wait { wait_id } = f.db.goal_boundary(&f.run, f.db.epoch()).unwrap() else {
        panic!("budget must park")
    };
    f.state(RunState::Waiting, Some(wait_id));
    f.db.control_goal("goal", 1, &scope(), GoalControlAction::Pause)
        .unwrap();
    let p =
        f.db.prepare_goal_update(
            "goal",
            2,
            scope(),
            "Updated objective".into(),
            Some(GoalBudget {
                max_output_tokens: 30,
            }),
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_goal_mutation(p).unwrap();
    assert!(!f.db.release_goal_wait(&f.run).unwrap());
    let mut f = f.reopen();
    assert_eq!(f.goal("goal").state, GoalState::Paused);
    f.db.control_goal("goal", 3, &scope(), GoalControlAction::Resume)
        .unwrap();
    assert!(f.db.release_goal_wait(&f.run).unwrap());
    assert_eq!(f.db.run(&f.run).unwrap().state, RunState::Runnable);
    assert_eq!(f.goal("goal").usage.actual.output_tokens.known, 8);
    f.cleanup();
}
#[test]
fn late_attribution_is_frozen_and_new_goal_on_same_run_does_not_reprice_old_inference() {
    let mut f = Fixture::new();
    f.prepare("before");
    f.record(ExecutionRecord::ModelDispatched {
        request_id: "before".into(),
    });
    f.start("first", None);
    f.finish("before", 10);
    assert_eq!(f.goal("first").usage.actual.inferences, 0);
    f.prepare("owned");
    f.record(ExecutionRecord::ModelDispatched {
        request_id: "owned".into(),
    });
    f.db.control_goal("first", 1, &scope(), GoalControlAction::Complete)
        .unwrap();
    f.start("second", None);
    f.finish("owned", 13);
    assert_eq!(f.goal("first").usage.actual.output_tokens.known, 13);
    assert_eq!(f.goal("second").usage.actual.inferences, 0);
    assert_eq!(f.goal("first").state, GoalState::Complete);
    f.cleanup();
}
#[test]
fn old_prepared_generation_is_not_dispatched_and_old_continuation_candidate_is_not_admitted() {
    let mut f = Fixture::new();
    f.start("goal", None);
    f.prepare("old");
    let p =
        f.db.prepare_goal_update("goal", 1, scope(), "New real constraint".into(), None)
            .unwrap()
            .load()
            .unwrap();
    f.db.admit_goal_mutation(p).unwrap();
    assert!(matches!(
        f.db.commit_execution(
            &f.run,
            f.db.epoch(),
            &ExecutionRecord::ModelDispatched {
                request_id: "old".into()
            }
        ),
        Err(RuntimeError::GoalChanged)
    ));
    f.record(ExecutionRecord::ModelFinished {
        request_id: "old".into(),
        outcome: ModelOutcome::Cancelled,
        finish_reason: None,
        items: vec![],
        interrupted_deltas: vec![],
        usage: UsageReceipt::default(),
        failure: None,
    });
    f.state(RunState::Completed, None);
    let old =
        f.db.capture_followup_continuations()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    f.db.control_goal("goal", 2, &scope(), GoalControlAction::Pause)
        .unwrap();
    assert!(matches!(
        f.db.admit_followup_continuation(old).unwrap(),
        ContinuationAdmission::Stale
    ));
    assert!(f.admit().is_empty());
    f.db.control_goal("goal", 3, &scope(), GoalControlAction::Resume)
        .unwrap();
    assert_eq!(f.admit().len(), 1);
    assert_eq!(f.goal("goal").usage.pending_inferences, 0);
    f.cleanup();
}
#[test]
fn explicit_start_on_terminal_cancelled_run_is_new_authority_and_wrong_scope_cannot_control() {
    let mut f = Fixture::new();
    f.state(RunState::Cancelled, None);
    f.start("goal", None);
    assert_eq!(f.admit().len(), 1);
    assert!(f
        .db
        .control_goal(
            "goal",
            1,
            &GoalScope {
                thread_id: "other".into(),
                branch_id: "branch".into()
            },
            GoalControlAction::Cancel
        )
        .is_err());
    assert_eq!(f.goal("goal").state, GoalState::Active);
    f.cleanup();
}
#[test]
fn interrupted_dispatch_recovers_missing_usage_without_remaining_pending_or_fake_zero() {
    let mut f = Fixture::new();
    f.start("goal", Some(1));
    f.prepare("paid");
    f.record(ExecutionRecord::ModelDispatched {
        request_id: "paid".into(),
    });
    assert_eq!(f.goal("goal").usage.pending_inferences, 1);
    let f = f.reopen();
    let g = f.goal("goal");
    assert_eq!(g.usage.pending_inferences, 0);
    assert_eq!(g.usage.missing_inferences, 1);
    assert_eq!(g.usage.actual.inferences, 0);
    assert_ne!(g.state, GoalState::BudgetLimited);
    f.cleanup();
}

struct UserAfterGoal {
    db: std::sync::Arc<std::sync::Mutex<Catalog>>,
    action: GoalControlAction,
    requests: std::sync::Mutex<Vec<RequestSnapshot>>,
    input: std::sync::Mutex<Option<varin_runtime::catalog::inputs::InputReceipt>>,
}
impl ModelProvider for UserAfterGoal {
    fn serialize(&self, v: &RequestView) -> Result<serde_json::Value, ExecutionError> {
        Ok(serde_json::to_value(v).unwrap())
    }
    fn generate(
        &self,
        r: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let first = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(r.clone());
            requests.len() == 1
        };
        if first {
            let mut db = self.db.lock().unwrap();
            db.control_goal("goal", 1, &scope(), self.action).unwrap();
            *self.input.lock().unwrap() = Some(
                db.enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
                    key: "after-goal".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    mode: InputMode::Boundary,
                    input: json!("NEW_ORDINARY_INPUT"),
                    configuration: None,
                })
                .unwrap(),
            );
        }
        emit(ProviderEvent::Usage {
            receipt: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                output_tokens: Some(if first { 10 } else { 13 }),
                ..Default::default()
            },
        })
        .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "answer".into(),
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
#[test]
fn ordinary_input_after_goal_end_is_really_inferred_without_reviving_or_rebilling_old_goal() {
    use std::sync::{Arc, Mutex};
    for action in [GoalControlAction::Complete, GoalControlAction::Cancel] {
        let mut f = Fixture::new();
        f.start("goal", None);
        let binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":f.db.head("branch").unwrap()}})).unwrap();
        let input =
            f.db.prepare_execution(
                &f.run,
                binding,
                DefaultAgentPolicy.identity(),
                serde_json::Value::Null,
            )
            .unwrap();
        let root = f.root;
        let run = f.run;
        let db = Arc::new(Mutex::new(f.db));
        let provider = Arc::new(UserAfterGoal {
            db: db.clone(),
            action,
            requests: Mutex::new(vec![]),
            input: Mutex::new(None),
        });
        let engine = ExecutionEngine {
            context_preparation: Arc::new(NoopContextPreparation),
            persistence: db.clone(),
            provider: provider.clone(),
            tools: Arc::new(
                varin_runtime::composition::tools::ToolDirectory::assemble(vec![]).unwrap(),
            ),
            policy: Arc::new(DefaultAgentPolicy),
            progress: ProgressSink::default(),
        };
        let report = engine.run(input, CancellationToken::default()).unwrap();
        assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].view.binding.goal.as_ref().unwrap().id, "goal");
        assert!(requests[1].view.binding.goal.is_none());
        assert!(serde_json::to_string(&requests[1].view.history)
            .unwrap()
            .contains("NEW_ORDINARY_INPUT"));
        let mut catalog = db.lock().unwrap();
        let goal = catalog.capture_goal("goal").unwrap().load().unwrap();
        assert!(matches!(
            goal.state,
            GoalState::Complete | GoalState::Cancelled
        ));
        assert_eq!(goal.usage.actual.output_tokens.known, 10);
        assert_eq!(goal.usage.actual.inferences, 1);
        assert_eq!(goal.usage.pending_inferences, 0);
        let receipt = provider.input.lock().unwrap().clone().unwrap();
        let queued = catalog.queued_input(&receipt.input_id).unwrap();
        assert_eq!(queued.mode, InputMode::Boundary);
        assert_eq!(queued.run_id, run);
        assert_eq!(queued.state, InputState::Delivered);
        assert!(catalog.goal_binding(&run).unwrap().is_none());
        assert!(catalog.capture_followup_continuations().unwrap().is_empty());
        drop(catalog);
        drop(requests);
        drop(engine);
        drop(provider);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn missing_output_budget_is_recoverable_without_claiming_zero_or_ignoring_prior_actual() {
    let mut f = Fixture::new();
    f.start("goal", Some(100));
    f.prepare("unknown");
    f.record(ExecutionRecord::ModelDispatched {
        request_id: "unknown".into(),
    });
    f.record(ExecutionRecord::ModelFinished {
        request_id: "unknown".into(),
        outcome: ModelOutcome::Completed,
        finish_reason: Some(FinishReason::Stop),
        items: vec![],
        interrupted_deltas: vec![],
        usage: UsageReceipt::default(),
        failure: None,
    });
    let goal = f.goal("goal");
    assert_eq!(goal.state, GoalState::Blocked);
    assert_eq!(goal.blocked_reason, Some(GoalBlockReason::UsageUnknown));
    assert_eq!(goal.usage.missing_inferences, 1);
    assert_eq!(goal.usage.actual.inferences, 0);
    let GoalBoundary::Wait { wait_id } = f.db.goal_boundary(&f.run, f.db.epoch()).unwrap() else {
        panic!("unknown usage must park")
    };
    f.state(RunState::Waiting, Some(wait_id));
    f.db.control_goal("goal", 1, &scope(), GoalControlAction::Resume)
        .unwrap();
    assert!(!f.db.release_goal_wait(&f.run).unwrap());
    let p =
        f.db.prepare_goal_update(
            "goal",
            2,
            scope(),
            "Continue without claiming a complete usage limit".into(),
            None,
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_goal_mutation(p).unwrap();
    assert!(f.db.release_goal_wait(&f.run).unwrap());
    assert_eq!(f.goal("goal").state, GoalState::Active);
    assert_eq!(f.goal("goal").usage.missing_inferences, 1);
    f.cleanup();
}

#[test]
fn rejected_real_output_is_charged_once_and_conflicting_receipt_cannot_overwrite_it() {
    let mut f = Fixture::new();
    f.start("goal", None);
    f.prepare("rejected");
    f.record(ExecutionRecord::ModelDispatched {
        request_id: "rejected".into(),
    });
    let head = f.db.head("branch").unwrap();
    f.db.append_history(
        &f.run,
        f.db.epoch(),
        head.as_deref(),
        HistorySource::User,
        json!("changed history before provider returned"),
        None,
    )
    .unwrap();
    let record = ExecutionRecord::ModelFinished {
        request_id: "rejected".into(),
        outcome: ModelOutcome::Completed,
        finish_reason: Some(FinishReason::Stop),
        items: vec![ProviderItem {
            id: "answer".into(),
            content: Content::Text {
                text: "late output".into(),
            },
            opaque: None,
        }],
        interrupted_deltas: vec![],
        usage: UsageReceipt {
            measurement: UsageMeasurement::Actual,
            output_tokens: Some(5),
            ..Default::default()
        },
        failure: None,
    };
    let root = f.root;
    let run = f.run;
    let epoch = f.db.epoch();
    let db = std::sync::Mutex::new(f.db);
    assert!(Persistence::commit(&db, &run, epoch, &record).is_err());
    assert!(Persistence::commit(&db, &run, epoch, &record).is_err());
    let mut conflict = record;
    if let ExecutionRecord::ModelFinished { usage, .. } = &mut conflict {
        usage.output_tokens = Some(90);
    }
    assert!(Persistence::commit(&db, &run, epoch, &conflict).is_err());
    let db = db.into_inner().unwrap();
    let goal = db.capture_goal("goal").unwrap().load().unwrap();
    assert_eq!(goal.usage.actual.inferences, 1);
    assert_eq!(goal.usage.actual.output_tokens.known, 5);
    assert_eq!(goal.usage.pending_inferences, 0);
    assert_eq!(
        db.model_step("rejected").unwrap().usage.unwrap()["output_tokens"],
        5
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn goal_edit_after_serialization_recompiles_before_the_only_paid_dispatch() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    struct Edit {
        db: Arc<Mutex<Catalog>>,
        edited: AtomicBool,
        seen: Mutex<Vec<RequestSnapshot>>,
    }
    impl ModelProvider for Edit {
        fn serialize(&self, v: &RequestView) -> Result<serde_json::Value, ExecutionError> {
            if !self.edited.swap(true, Ordering::SeqCst) {
                let preparation = self
                    .db
                    .lock()
                    .unwrap()
                    .prepare_goal_update("goal", 1, scope(), "EDITED_GOAL_CONTEXT".into(), None)
                    .unwrap();
                let prepared = preparation.load().unwrap();
                self.db
                    .lock()
                    .unwrap()
                    .admit_goal_mutation(prepared)
                    .unwrap();
            }
            Ok(serde_json::to_value(v).unwrap())
        }
        fn generate(
            &self,
            r: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            self.seen.lock().unwrap().push(r.clone());
            self.db
                .lock()
                .unwrap()
                .control_goal("goal", 2, &scope(), GoalControlAction::Complete)
                .unwrap();
            emit(ProviderEvent::Usage {
                receipt: UsageReceipt {
                    measurement: UsageMeasurement::Actual,
                    output_tokens: Some(3),
                    ..Default::default()
                },
            })
            .unwrap();
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: "answer".into(),
                    content: Content::Text {
                        text: "finished edited objective".into(),
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
    let mut f = Fixture::new();
    f.start("goal", None);
    let binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":f.db.head("branch").unwrap()}})).unwrap();
    let input =
        f.db.prepare_execution(
            &f.run,
            binding,
            DefaultAgentPolicy.identity(),
            serde_json::Value::Null,
        )
        .unwrap();
    let root = f.root;
    let db = Arc::new(Mutex::new(f.db));
    let provider = Arc::new(Edit {
        db: db.clone(),
        edited: AtomicBool::new(false),
        seen: Mutex::new(vec![]),
    });
    let engine = ExecutionEngine {
        context_preparation: Arc::new(NoopContextPreparation),
        persistence: db.clone(),
        provider: provider.clone(),
        tools: Arc::new(
            varin_runtime::composition::tools::ToolDirectory::assemble(vec![]).unwrap(),
        ),
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    };
    let report = engine.run(input, CancellationToken::default()).unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    {
        let seen = provider.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].view.binding.goal.as_ref().unwrap().generation, 2);
        assert!(serde_json::to_string(&seen[0].view.history)
            .unwrap()
            .contains("EDITED_GOAL_CONTEXT"));
    }
    let goal = db
        .lock()
        .unwrap()
        .capture_goal("goal")
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(goal.usage.actual.inferences, 1);
    assert_eq!(goal.usage.actual.output_tokens.known, 3);
    assert_eq!(goal.usage.missing_inferences, 0);
    drop(engine);
    drop(provider);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn fork_of_older_history_does_not_copy_goal_or_rewind_its_usage_and_user_pause() {
    let mut f = Fixture::new();
    let old = f.db.head("branch").unwrap();
    f.start("goal", None);
    f.prepare("paid");
    f.record(ExecutionRecord::ModelDispatched {
        request_id: "paid".into(),
    });
    f.finish("paid", 6);
    f.db.control_goal("goal", 1, &scope(), GoalControlAction::Pause)
        .unwrap();
    f.db.fork_branch("branch", "fork", old.as_deref()).unwrap();
    let input =
        f.db.submit(&SubmitInput {
            key: "fork-input".into(),
            thread_id: "thread".into(),
            branch_id: "fork".into(),
            expected_head: old,
            input: json!("separate user task from old history"),
            configuration: json!({}),
        })
        .unwrap();
    assert!(f.db.goal_binding(&input.run_id).unwrap().is_none());
    assert!(f
        .db
        .capture_goal_context(&input.run_id, f.db.epoch())
        .unwrap()
        .is_none());
    let goal = f.goal("goal");
    assert_eq!(goal.state, GoalState::Paused);
    assert_eq!(goal.usage.actual.output_tokens.known, 6);
    assert_eq!(f.db.capture_goals("thread").unwrap().len(), 1);
    f.cleanup();
}

#[test]
fn queued_user_run_after_goal_failure_parks_instead_of_falsely_completing() {
    let mut f = Fixture::new();
    f.start("goal", None);
    let input =
        f.db.enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
            key: "after-failure".into(),
            thread_id: "thread".into(),
            branch_id: "branch".into(),
            mode: InputMode::NextRun,
            input: json!("pending user work after failure"),
            configuration: None,
        })
        .unwrap();
    f.state(RunState::Failed, None);
    assert_eq!(f.db.run(&input.run_id).unwrap().state, RunState::Accepted);
    let GoalBoundary::Wait { wait_id } = f.db.goal_boundary(&input.run_id, f.db.epoch()).unwrap()
    else {
        panic!("a failed goal cannot pretend the new user Run was completed")
    };
    f.db.commit_execution(
        &input.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    f.db.commit_execution(
        &input.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Waiting,
            waiting_on: Some(wait_id),
        },
    )
    .unwrap();
    assert!(!f.db.release_goal_wait(&input.run_id).unwrap());
    f.db.control_goal("goal", 1, &scope(), GoalControlAction::Resume)
        .unwrap();
    assert!(f.db.release_goal_wait(&input.run_id).unwrap());
    assert_eq!(
        f.db.queued_input(&input.input_id).unwrap().state,
        InputState::Delivered
    );
    f.cleanup();
}
