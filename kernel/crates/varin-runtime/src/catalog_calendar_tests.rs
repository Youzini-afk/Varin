use super::*;
use crate::execution::*;
use crate::test_submission::InputAdmission;
use std::sync::{Arc, Mutex};
struct Fixture {
    path: std::path::PathBuf,
    db: Catalog,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("varin-calendar-{}", uuid::Uuid::new_v4()));
        let db = Catalog::open(&path).unwrap();
        Self { path, db }
    }
}
fn definition(goal: bool) -> DefinitionInput {
    DefinitionInput {
        task_id: "asset".into(),
        asset_revision: "asset:1".into(),
        asset_kind: AssetKind::Gui,
        name: "Review".into(),
        enabled: true,
        activation_hold: None,
        once_acceptance: None,
        timezone: "America/New_York".into(),
        rule: Rule::Once {
            date: "2026-10-10".into(),
            time: "09:00".into(),
        },
        missed_policy: MissedPolicy::CoalesceOnce,
        target: Target::NewWork {
            model: ModelSelection {
                provider_id: "fixture".into(),
                model_id: "fixture".into(),
                thinking_level: None,
                temperature: None,
            },
            source_mode: SourceMode::LiveRoot,
            goal: goal.then_some(InitialGoal {
                budget: Some(goals::GoalBudget {
                    max_output_tokens: 100,
                }),
            }),
        },
        instruction: "Inspect the registered work".into(),
    }
}
fn sync(db: &mut Catalog, input: &DefinitionInput) -> DefinitionView {
    let previous = db.calendar_project("project").unwrap().revision;
    let p = db
        .prepare_calendar_sync(
            "project".into(),
            (previous != 0).then_some(previous),
            vec![input.clone()],
        )
        .unwrap()
        .load()
        .unwrap();
    db.admit_calendar_sync(p)
        .unwrap()
        .definitions
        .into_iter()
        .find(|d| !d.deleted)
        .unwrap()
}
fn due(db: &mut Catalog, d: &DefinitionView, at: u64) -> OccurrenceView {
    let request = db
        .calendar_pending()
        .unwrap()
        .calculations
        .into_iter()
        .find(|c| c.definition_id == d.id)
        .unwrap();
    let s = Slot {
        at_ms: at,
        following_at_ms: None,
    };
    db.admit_calendar_calculation(
        request,
        Some(CalculationResult {
            next: Some(s.clone()),
            latest_due: Some(s),
            next_future: None,
        }),
        None,
    )
    .unwrap();
    assert_eq!(db.reconcile_calendar_facts_at(at + 1).unwrap(), 1);
    db.calendar_occurrences(&d.id).unwrap().pop().unwrap()
}
fn configuration() -> Value {
    json!({"providerId":"fixture","providerFamily":"fixture","model":"fixture","endpoint":"https://fixture.invalid","credentialEnvironment":null,"allowAnonymous":true,"configurationGeneration":1,"maxOutputTokens":100})
}
fn launch() -> launches::LaunchSelection {
    serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"default","version":"1"},"source":{"mode":"live_root","live_root":{"hostId":"host","canonicalRoot":"/fixture","rootId":"root"},"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":null,"revision":null}})).unwrap()
}
fn context(
    o: &OccurrenceView,
) -> (
    context::ContextProposal,
    personalization::PersonalizationBasis,
) {
    (context::ContextProposal{key:format!("initial:{}",o.branch_id),branch_id:o.branch_id.clone(),through_id:None,expected_revision:0,summary:String::new(),effective_system_prompt:"Frozen main context".into(),instruction_sources:vec![],memory_checkpoint:None},serde_json::from_value(json!({"mode":"agent","threadRole":"main","revision":1,"configurationDigest":"fixture","memorySnapshot":{"revision":0,"memories":[]},"sessionId":o.thread_id,"projectId":"project","originalSections":[{"name":"system","content":"Frozen main context"}],"instructionSources":[]})).unwrap())
}
fn prepare(db: &Catalog, o: &OccurrenceView) -> PreparedCold {
    let (context, basis) = context(o);
    db.prepare_calendar_submission(
        &o.id,
        o.revision,
        db.epoch(),
        configuration(),
        context,
        basis,
        None,
        None,
    )
    .unwrap()
    .load(launch())
    .unwrap()
}
fn finish(db: &mut Catalog, id: &str) {
    for next in [RunState::Preparing, RunState::Runnable, RunState::Completed] {
        let run = db.run(id).unwrap();
        db.transition_run(id, db.epoch(), run.revision, next)
            .unwrap();
    }
}
#[test]
fn cold_occurrence_and_initial_goal_use_original_run_history_and_terminal_owners() {
    let mut f = Fixture::new();
    let input = definition(true);
    let d = sync(&mut f.db, &input);
    let o = due(&mut f.db, &d, 0);
    assert!(o.thread_id.starts_with("thread:"));
    assert!(latest_run(&f.db.db, &o.branch_id).unwrap().is_none());
    let p = prepare(&f.db, &o);
    let admitted = f.db.admit_calendar_submission(p).unwrap();
    let run = admitted.run_id.clone().unwrap();
    let goal = admitted.goal_id.clone().unwrap();
    assert_eq!(f.db.goal_binding(&run).unwrap().unwrap().id, goal);
    assert_eq!(f.db.history(&o.branch_id).unwrap().len(), 1);
    let items = f.db.execution_history(&o.branch_id).unwrap();
    assert!(items
        .iter()
        .all(|i| !matches!(i.provenance, Provenance::UserInstruction { .. })));
    assert!(items
        .iter()
        .any(|i| matches!(&i.content,Content::Text{text} if text==&input.instruction)));
    let row: QueuedInputMetadata =
        record(&f.db.db, "input_queue", admitted.input_id.as_ref().unwrap()).unwrap();
    assert_eq!(row.state, InputState::Delivered);
    finish(&mut f.db, &run);
    assert_eq!(
        f.db.calendar_occurrence(&o.id).unwrap().state,
        OccurrenceState::Delivered
    );
    let manual =
        f.db.run_calendar_now(
            &d.id,
            f.db.calendar_project("project").unwrap().definitions[0].revision,
            "manual",
        )
        .unwrap();
    assert_eq!(
        manual.hold_reason.as_deref(),
        Some("previous_occurrence_active")
    );
    let scope = goals::GoalScope {
        thread_id: o.thread_id.clone(),
        branch_id: o.branch_id.clone(),
    };
    f.db.control_goal(&goal, 1, &scope, goals::GoalControlAction::Complete)
        .unwrap();
    assert_eq!(
        f.db.calendar_occurrence(&o.id).unwrap().state,
        OccurrenceState::Completed
    );
    assert!(f
        .db
        .calendar_pending()
        .unwrap()
        .preparations
        .iter()
        .any(|v| v.id == manual.id));
    let old = f.db.calendar_occurrence(&o.id).unwrap();
    assert_eq!(
        f.db.control_calendar_occurrence(&o.id, 0, OccurrenceControlAction::Cancel)
            .unwrap(),
        old
    );
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}
#[test]
fn cancellation_and_user_branch_race_fence_cold_preparation_without_creating_another_run() {
    let mut f = Fixture::new();
    let d = sync(&mut f.db, &definition(false));
    let first = f.db.run_calendar_now(&d.id, d.revision, "first").unwrap();
    let p = prepare(&f.db, &first);
    f.db.control_calendar_occurrence(&first.id, first.revision, OccurrenceControlAction::Cancel)
        .unwrap();
    assert!(f.db.admit_calendar_submission(p).is_err());
    assert!(latest_run(&f.db.db, &first.branch_id).unwrap().is_none());
    let current = f.db.calendar_project("project").unwrap().definitions[0].clone();
    let second =
        f.db.run_calendar_now(&d.id, current.revision, "second")
            .unwrap();
    let p = prepare(&f.db, &second);
    let receipt =
        f.db.submit(&SubmitInput {
            key: "user".into(),
            thread_id: second.thread_id.clone(),
            branch_id: second.branch_id.clone(),
            expected_head: None,
            input: json!("New user work"),
            configuration: json!({}),
        })
        .unwrap();
    assert!(f.db.admit_calendar_submission(p).is_err());
    let held = f.db.calendar_occurrence(&second.id).unwrap();
    assert_eq!(held.hold_reason.as_deref(), Some("branch_changed"));
    assert!(held.run_id.is_none());
    assert_eq!(
        latest_run(&f.db.db, &second.branch_id).unwrap().unwrap().id,
        receipt.run_id
    );
    assert!(f.db.calendar_pending().unwrap().preparations.is_empty());
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}
#[test]
fn reopen_revalidates_assets_without_resetting_observed_identity_or_once_and_manual_is_independent()
{
    let mut f = Fixture::new();
    let mut input = definition(false);
    let d = sync(&mut f.db, &input);
    let observed = due(&mut f.db, &d, 0);
    let project_revision = f.db.calendar_project("project").unwrap().revision;
    drop(f.db);
    let mut db = Catalog::open(&f.path).unwrap();
    assert_eq!(
        db.calendar_occurrence(&observed.id)
            .unwrap()
            .hold_reason
            .as_deref(),
        Some("asset_revalidation")
    );
    assert!(db.calendar_pending().unwrap().preparations.is_empty());
    let same = sync(&mut db, &input);
    assert_eq!(same.generation, d.generation);
    assert_eq!(
        db.calendar_project("project").unwrap().revision,
        project_revision
    );
    assert_eq!(db.calendar_occurrences(&d.id).unwrap()[0].id, observed.id);
    assert!(db.calendar_pending().unwrap().calculations.is_empty());
    input.enabled = false;
    input.name = "Renamed".into();
    input.asset_revision = "asset:2".into();
    let paused = sync(&mut db, &input);
    assert_eq!(paused.generation, d.generation);
    assert_eq!(
        db.calendar_occurrence(&observed.id)
            .unwrap()
            .hold_reason
            .as_deref(),
        Some("disabled")
    );
    db.control_calendar_occurrence(
        &observed.id,
        observed.revision,
        OccurrenceControlAction::Cancel,
    )
    .unwrap();
    let manual = db
        .run_calendar_now(&d.id, paused.revision, "exact-key")
        .unwrap();
    assert_eq!(manual.state, OccurrenceState::Preparing);
    assert_eq!(
        db.run_calendar_now(&d.id, 0, "exact-key").unwrap().id,
        manual.id
    );
    let generation = paused.generation;
    input.enabled = true;
    input.asset_revision = "asset:3".into();
    assert_eq!(sync(&mut db, &input).generation, generation);
    assert!(db.calendar_pending().unwrap().calculations.is_empty());
    let project = db.calendar_project("project").unwrap();
    let p = db
        .prepare_calendar_sync("project".into(), Some(project.revision), vec![])
        .unwrap()
        .load()
        .unwrap();
    db.admit_calendar_sync(p).unwrap();
    assert_eq!(
        db.calendar_occurrence(&manual.id).unwrap().state,
        OccurrenceState::Cancelled
    );
    assert_eq!(db.calendar_projects().unwrap(), vec!["project"]);
    drop(db);
    std::fs::remove_dir_all(f.path).unwrap();
}
#[test]
fn recurring_clock_jump_requests_actual_slots_and_explicit_failure_retry_does_not_spin() {
    let mut f = Fixture::new();
    let mut input = definition(false);
    input.rule = Rule::Daily {
        times: vec!["09:00".into(), "10:00".into()],
    };
    input.missed_policy = MissedPolicy::Skip;
    let d = sync(&mut f.db, &input);
    let c = f.db.calendar_pending().unwrap().calculations.pop().unwrap();
    let at = c.after_ms + 1_000;
    let following = at + 3_600_000;
    f.db.admit_calendar_calculation(
        c.clone(),
        Some(CalculationResult {
            next: Some(Slot {
                at_ms: at,
                following_at_ms: Some(following),
            }),
            latest_due: None,
            next_future: Some(Slot {
                at_ms: at,
                following_at_ms: Some(following),
            }),
        }),
        None,
    )
    .unwrap();
    assert_eq!(f.db.nearest_calendar_deadline().unwrap(), Some(at));
    assert_eq!(f.db.reconcile_calendar_facts_at(at - 1).unwrap(), 0);
    assert_eq!(f.db.reconcile_calendar_facts_at(following + 1).unwrap(), 0);
    assert!(f.db.calendar_occurrences(&d.id).unwrap().is_empty());
    assert!(f.db.nearest_calendar_deadline().unwrap().is_none());
    let next = f.db.calendar_pending().unwrap().calculations.pop().unwrap();
    assert_eq!(next.now_ms, following + 1);
    f.db.admit_calendar_calculation(next.clone(), None, Some("calculator_unavailable".into()))
        .unwrap();
    sync(&mut f.db, &input);
    assert!(f.db.calendar_pending().unwrap().calculations.is_empty());
    let current = f.db.calendar_project("project").unwrap().definitions[0].clone();
    f.db.retry_calendar_calculation(&d.id, current.revision)
        .unwrap();
    assert_eq!(f.db.calendar_pending().unwrap().calculations.len(), 1);
    assert!(f
        .db
        .admit_calendar_calculation(next, None, Some("late".into()))
        .is_err());
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}
#[test]
fn existing_active_work_uses_shared_ingress_and_cancelled_queued_occurrence_never_changes_its_run()
{
    let mut f = Fixture::new();
    let d = sync(&mut f.db, &definition(false));
    let cold = f.db.run_calendar_now(&d.id, d.revision, "first").unwrap();
    let p = prepare(&f.db, &cold);
    let original = f.db.admit_calendar_submission(p).unwrap();
    let run = original.run_id.unwrap();
    let mut existing = definition(false);
    existing.task_id = "existing".into();
    existing.target = Target::ExistingWork {
        thread_id: cold.thread_id.clone(),
        branch_id: cold.branch_id.clone(),
    };
    existing.enabled = false;
    let previous = f.db.calendar_project("project").unwrap().revision;
    let p =
        f.db.prepare_calendar_sync(
            "project".into(),
            Some(previous),
            vec![definition(false), existing.clone()],
        )
        .unwrap()
        .load()
        .unwrap();
    let project = f.db.admit_calendar_sync(p).unwrap();
    let d = project
        .definitions
        .iter()
        .find(|d| d.task_id == "existing")
        .unwrap();
    let o =
        f.db.run_calendar_now(&d.id, d.revision, "manual-disabled")
            .unwrap();
    let db = Mutex::new(f.db);
    reconcile(&db).unwrap();
    let mut db = db.into_inner().unwrap();
    let queued = db.calendar_occurrence(&o.id).unwrap();
    assert_eq!(queued.run_id.as_deref(), Some(run.as_str()));
    assert_eq!(queued.state, OccurrenceState::Held);
    assert_eq!(queued.hold_reason.as_deref(), Some("preparing"));
    db.control_calendar_occurrence(&o.id, queued.revision, OccurrenceControlAction::Cancel)
        .unwrap();
    assert!(!db.run(&run).unwrap().cancel_requested);
    assert_eq!(db.history(&cold.branch_id).unwrap().len(), 1);
    drop(db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn actual_engine_consumes_cold_calendar_context_and_accounts_initial_goal_usage() {
    struct Provider {
        db: Arc<Mutex<Catalog>>,
        goal: String,
        scope: goals::GoalScope,
        seen: Mutex<Vec<RequestSnapshot>>,
    }
    impl ModelProvider for Provider {
        fn serialize(&self, view: &RequestView) -> std::result::Result<Value, ExecutionError> {
            Ok(serde_json::to_value(view).unwrap())
        }
        fn generate(
            &self,
            request: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> std::result::Result<(), ExecutionError>,
        ) -> std::result::Result<FinishReason, ModelFailure> {
            self.seen.lock().unwrap().push(request.clone());
            self.db
                .lock()
                .unwrap()
                .control_goal(
                    &self.goal,
                    1,
                    &self.scope,
                    goals::GoalControlAction::Complete,
                )
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
                        text: "Calendar result".into(),
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(FinishReason::Stop)
        }
    }
    let mut f = Fixture::new();
    let d = sync(&mut f.db, &definition(true));
    let occurrence = f.db.run_calendar_now(&d.id, d.revision, "engine").unwrap();
    let prepared = prepare(&f.db, &occurrence);
    let delivered = f.db.admit_calendar_submission(prepared).unwrap();
    let run = delivered.run_id.unwrap();
    let goal = delivered.goal_id.unwrap();
    let binding: RequestBinding = serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":occurrence.branch_id,"ancestor_id":null,"leaf_id":f.db.head(&occurrence.branch_id).unwrap()}})).unwrap();
    let input =
        f.db.prepare_execution(&run, binding, DefaultAgentPolicy.identity(), Value::Null)
            .unwrap();
    let db = Arc::new(Mutex::new(f.db));
    let provider = Arc::new(Provider {
        db: db.clone(),
        goal: goal.clone(),
        scope: goals::GoalScope {
            thread_id: occurrence.thread_id.clone(),
            branch_id: occurrence.branch_id.clone(),
        },
        seen: Mutex::new(vec![]),
    });
    let engine = ExecutionEngine {
        context_preparation: Arc::new(NoopContextPreparation),
        persistence: db.clone(),
        provider: provider.clone(),
        tools: Arc::new(crate::composition::tools::ToolDirectory::assemble(vec![]).unwrap()),
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    };
    let report = engine.run(input, CancellationToken::default()).unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let seen = provider.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].view.binding.goal.as_ref().unwrap().id, goal);
    assert!(seen[0]
        .view
        .history
        .iter()
        .all(|item| !matches!(item.provenance, Provenance::UserInstruction { .. })));
    let serialized = serde_json::to_string(&seen[0].view.history).unwrap();
    assert!(serialized.contains("Inspect the registered work"));
    assert!(serialized.contains("Frozen main context"));
    drop(seen);
    let current = db
        .lock()
        .unwrap()
        .capture_goal(&goal)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(current.usage.actual.inferences, 1);
    assert_eq!(current.usage.actual.output_tokens.known, 3);
    assert_eq!(
        db.lock()
            .unwrap()
            .calendar_occurrence(&occurrence.id)
            .unwrap()
            .state,
        OccurrenceState::Completed
    );
    drop(engine);
    drop(provider);
    drop(db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn tree_stop_cancels_cold_preparation_but_not_future_definition_authority() {
    let mut f = Fixture::new();
    let d = sync(&mut f.db, &definition(false));
    let occurrence =
        f.db.run_calendar_now(&d.id, d.revision, "before-stop")
            .unwrap();
    let prepared = prepare(&f.db, &occurrence);
    let cancellation =
        f.db.cancel_tree(dispatch::TreeCancelTarget::Thread {
            thread_id: occurrence.thread_id.clone(),
        })
        .unwrap();
    assert!(cancellation.run_ids.is_empty());
    assert_eq!(
        f.db.calendar_occurrence(&occurrence.id).unwrap().state,
        OccurrenceState::Cancelled
    );
    assert!(f.db.admit_calendar_submission(prepared).is_err());
    assert!(f.db.history(&occurrence.branch_id).unwrap().is_empty());
    let current =
        f.db.calendar_project("project")
            .unwrap()
            .definitions
            .pop()
            .unwrap();
    assert!(!current.deleted);
    assert!(current.enabled);
    let next =
        f.db.run_calendar_now(&d.id, current.revision, "after-stop")
            .unwrap();
    let prepared = prepare(&f.db, &next);
    assert!(f
        .db
        .admit_calendar_submission(prepared)
        .unwrap()
        .run_id
        .is_some());
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn initial_goal_completion_waits_for_original_run_before_next_occurrence() {
    let mut f = Fixture::new();
    let d = sync(&mut f.db, &definition(true));
    let occurrence = f.db.run_calendar_now(&d.id, d.revision, "first").unwrap();
    let prepared = prepare(&f.db, &occurrence);
    let admitted = f.db.admit_calendar_submission(prepared).unwrap();
    f.db.control_goal(
        admitted.goal_id.as_deref().unwrap(),
        1,
        &goals::GoalScope {
            thread_id: occurrence.thread_id.clone(),
            branch_id: occurrence.branch_id.clone(),
        },
        goals::GoalControlAction::Complete,
    )
    .unwrap();
    let next = f.db.run_calendar_now(&d.id, d.revision, "next").unwrap();
    assert_eq!(
        next.hold_reason.as_deref(),
        Some("previous_occurrence_active")
    );
    assert_eq!(
        f.db.calendar_occurrence(&occurrence.id).unwrap().state,
        OccurrenceState::Delivered
    );
    finish(&mut f.db, admitted.run_id.as_deref().unwrap());
    assert!(f
        .db
        .calendar_occurrence(&next.id)
        .unwrap()
        .hold_reason
        .is_none());
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn cancelled_goal_after_completed_run_is_not_projected_as_success() {
    let mut f = Fixture::new();
    let d = sync(&mut f.db, &definition(true));
    let occurrence =
        f.db.run_calendar_now(&d.id, d.revision, "goal-cancel")
            .unwrap();
    let prepared = prepare(&f.db, &occurrence);
    let admitted = f.db.admit_calendar_submission(prepared).unwrap();
    finish(&mut f.db, admitted.run_id.as_deref().unwrap());
    assert_eq!(
        f.db.calendar_occurrence(&occurrence.id).unwrap().state,
        OccurrenceState::Delivered
    );
    f.db.control_goal(
        admitted.goal_id.as_deref().unwrap(),
        1,
        &goals::GoalScope {
            thread_id: occurrence.thread_id,
            branch_id: occurrence.branch_id,
        },
        goals::GoalControlAction::Cancel,
    )
    .unwrap();
    assert_eq!(
        f.db.calendar_occurrence(&occurrence.id).unwrap().state,
        OccurrenceState::Cancelled
    );
    assert_eq!(
        f.db.run(admitted.run_id.as_deref().unwrap()).unwrap().state,
        RunState::Completed
    );
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn recurring_reopen_skips_or_coalesces_only_real_unobserved_slots() {
    for policy in [MissedPolicy::Skip, MissedPolicy::CoalesceOnce] {
        let mut f = Fixture::new();
        let mut input = definition(false);
        input.rule = Rule::Daily {
            times: vec!["09:00".into()],
        };
        input.missed_policy = policy;
        let d = sync(&mut f.db, &input);
        let c = f.db.calendar_pending().unwrap().calculations.pop().unwrap();
        let first = c.after_ms + 1;
        f.db.admit_calendar_calculation(
            c,
            Some(CalculationResult {
                next: Some(Slot {
                    at_ms: first,
                    following_at_ms: Some(first + 10),
                }),
                latest_due: None,
                next_future: Some(Slot {
                    at_ms: first,
                    following_at_ms: Some(first + 10),
                }),
            }),
            None,
        )
        .unwrap();
        drop(f.db);
        let mut db = Catalog::open(&f.path).unwrap();
        assert!(db.nearest_calendar_deadline().unwrap().is_none());
        sync(&mut db, &input);
        let c = db.calendar_pending().unwrap().calculations.pop().unwrap();
        // The calculator's real slots straddle this captured recovery instant.
        assert!(c.now_ms >= first);
        let due = Slot {
            at_ms: c.now_ms,
            following_at_ms: Some(c.now_ms + 100),
        };
        let future = Slot {
            at_ms: c.now_ms + 100,
            following_at_ms: Some(c.now_ms + 200),
        };
        let now = c.now_ms;
        db.admit_calendar_calculation(
            c,
            Some(CalculationResult {
                next: Some(Slot {
                    at_ms: first,
                    following_at_ms: Some(first + 10),
                }),
                latest_due: Some(due),
                next_future: Some(future),
            }),
            None,
        )
        .unwrap();
        assert_eq!(
            db.reconcile_calendar_facts_at(now).unwrap(),
            usize::from(policy == MissedPolicy::CoalesceOnce)
        );
        let observed = db.calendar_occurrences(&d.id).unwrap();
        if policy == MissedPolicy::Skip {
            assert!(observed.is_empty());
            assert_eq!(db.nearest_calendar_deadline().unwrap(), Some(now + 100));
        } else {
            assert_eq!(observed.len(), 1);
            assert_eq!(
                observed[0].reason,
                OccurrenceReason::Scheduled { at_ms: now }
            );
            assert_eq!(db.reconcile_calendar_facts_at(now + 1).unwrap(), 0);
        }
        drop(db);
        std::fs::remove_dir_all(f.path).unwrap();
    }
}

#[test]
fn semantic_change_retracts_only_undelivered_generation_and_rejects_late_calculator() {
    let mut f = Fixture::new();
    let mut input = definition(false);
    let d = sync(&mut f.db, &input);
    let calculation = f.db.calendar_pending().unwrap().calculations.pop().unwrap();
    let first = f.db.run_calendar_now(&d.id, d.revision, "first").unwrap();
    let prepared = prepare(&f.db, &first);
    let delivered = f.db.admit_calendar_submission(prepared).unwrap();
    let pending = f.db.run_calendar_now(&d.id, d.revision, "pending").unwrap();
    input.instruction = "Revised retained instruction".into();
    input.asset_revision = "asset:2".into();
    let changed = sync(&mut f.db, &input);
    assert_eq!(changed.generation, d.generation + 1);
    assert_eq!(
        f.db.calendar_occurrence(&pending.id).unwrap().state,
        OccurrenceState::Cancelled
    );
    assert_eq!(
        f.db.calendar_occurrence(&first.id).unwrap().run_id,
        delivered.run_id
    );
    assert!(
        !f.db
            .run(delivered.run_id.as_deref().unwrap())
            .unwrap()
            .cancel_requested
    );
    assert!(f
        .db
        .admit_calendar_calculation(calculation, None, Some("late".into()))
        .is_err());
    let new =
        f.db.run_calendar_now(&d.id, changed.revision, "new-generation")
            .unwrap();
    assert_eq!(
        new.hold_reason.as_deref(),
        Some("previous_occurrence_active")
    );
    assert_eq!(
        f.db.run_calendar_now(&d.id, 0, "first").unwrap().id,
        first.id
    );
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn blocked_body_publication_does_not_block_cancel_or_admit_a_late_cold_run() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Barrier,
    };
    use std::time::Duration;
    let mut f = Fixture::new();
    let d = sync(&mut f.db, &definition(false));
    let occurrence =
        f.db.run_calendar_now(&d.id, d.revision, "concurrent-cancel")
            .unwrap();
    let (initial, basis) = context(&occurrence);
    let preparation =
        f.db.prepare_calendar_submission(
            &occurrence.id,
            occurrence.revision,
            f.db.epoch(),
            configuration(),
            initial,
            basis,
            None,
            None,
        )
        .unwrap();
    let release = Arc::new(Barrier::new(2));
    let resume = release.clone();
    let first = AtomicBool::new(true);
    let (entered, ready) = mpsc::sync_channel(1);
    f.db.content.set_write_hook(Some(Arc::new(move |_| {
        if first.swap(false, Ordering::AcqRel) {
            entered.send(()).unwrap();
            resume.wait();
        }
    })));
    let worker = std::thread::spawn(move || preparation.load(launch()));
    ready
        .recv_timeout(Duration::from_secs(5))
        .expect("real content writer entered");
    let cancelled =
        f.db.control_calendar_occurrence(
            &occurrence.id,
            occurrence.revision,
            OccurrenceControlAction::Cancel,
        )
        .unwrap();
    assert_eq!(cancelled.state, OccurrenceState::Cancelled);
    assert!(latest_run(&f.db.db, &occurrence.branch_id)
        .unwrap()
        .is_none());
    release.wait();
    let prepared = worker.join().unwrap().unwrap();
    f.db.content.set_write_hook(None);
    assert!(matches!(
        f.db.admit_calendar_submission(prepared),
        Err(RuntimeError::DispatchCancelled)
    ));
    assert!(f.db.history(&occurrence.branch_id).unwrap().is_empty());
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn asset_hold_preserves_observed_generation_and_never_records_temporary_failure() {
    let mut f = Fixture::new();
    let mut input = definition(false);
    let d = sync(&mut f.db, &input);
    let occurrence = due(&mut f.db, &d, 0);
    let prepared = prepare(&f.db, &occurrence);
    input.activation_hold = Some(ActivationHold::AssetInvalid);
    let held = sync(&mut f.db, &input);
    assert_eq!(held.generation, d.generation);
    assert_eq!(
        f.db.calendar_occurrence(&occurrence.id)
            .unwrap()
            .hold_reason
            .as_deref(),
        Some("asset_invalid")
    );
    assert!(matches!(
        f.db.admit_calendar_submission(prepared),
        Err(RuntimeError::RequestActivationHeld)
    ));
    f.db.fail_calendar_preparation(
        &occurrence.id,
        occurrence.revision,
        f.db.epoch(),
        "temporary",
    )
    .unwrap();
    assert!(f
        .db
        .calendar_occurrence(&occurrence.id)
        .unwrap()
        .failure_code
        .is_none());
    input.activation_hold = None;
    let current = sync(&mut f.db, &input);
    assert_eq!(current.generation, d.generation);
    let prepared = prepare(&f.db, &occurrence);
    assert!(f
        .db
        .admit_calendar_submission(prepared)
        .unwrap()
        .run_id
        .is_some());
    assert_eq!(f.db.calendar_occurrences(&d.id).unwrap().len(), 1);
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn explicitly_selected_thinking_and_zero_temperature_cannot_be_silently_ignored() {
    let mut f = Fixture::new();
    let mut input = definition(false);
    let Target::NewWork { model, .. } = &mut input.target else {
        unreachable!()
    };
    model.thinking_level = Some("high".into());
    model.temperature = Some(0.0);
    let d = sync(&mut f.db, &input);
    let occurrence =
        f.db.run_calendar_now(&d.id, d.revision, "selected-model")
            .unwrap();
    let (initial, basis) = context(&occurrence);
    let preparation =
        f.db.prepare_calendar_submission(
            &occurrence.id,
            occurrence.revision,
            f.db.epoch(),
            configuration(),
            initial.clone(),
            basis.clone(),
            None,
            None,
        )
        .unwrap();
    assert!(preparation.load(launch()).is_err());
    let mut selected = configuration();
    selected["thinkingLevel"] = json!("high");
    selected["modelOptions"] = json!({"temperature":0});
    let prepared =
        f.db.prepare_calendar_submission(
            &occurrence.id,
            occurrence.revision,
            f.db.epoch(),
            selected,
            initial,
            basis,
            None,
            None,
        )
        .unwrap()
        .load(launch())
        .unwrap();
    assert!(f
        .db
        .admit_calendar_submission(prepared)
        .unwrap()
        .run_id
        .is_some());
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn existing_work_occurrence_inherits_original_goal_and_reads_its_cancelled_terminal_owner() {
    let mut f = Fixture::new();
    let cold_definition = definition(true);
    let d = sync(&mut f.db, &cold_definition);
    let cold =
        f.db.run_calendar_now(&d.id, d.revision, "goal-owner")
            .unwrap();
    let prepared = prepare(&f.db, &cold);
    let original = f.db.admit_calendar_submission(prepared).unwrap();
    let run = original.run_id.unwrap();
    let mut input = definition(false);
    input.task_id = "existing-goal".into();
    input.target = Target::ExistingWork {
        thread_id: cold.thread_id.clone(),
        branch_id: cold.branch_id.clone(),
    };
    let revision = f.db.calendar_project("project").unwrap().revision;
    let prepared =
        f.db.prepare_calendar_sync(
            "project".into(),
            Some(revision),
            vec![cold_definition, input],
        )
        .unwrap()
        .load()
        .unwrap();
    let existing =
        f.db.admit_calendar_sync(prepared)
            .unwrap()
            .definitions
            .into_iter()
            .find(|d| d.task_id == "existing-goal")
            .unwrap();
    let occurrence =
        f.db.run_calendar_now(&existing.id, existing.revision, "existing")
            .unwrap();
    let db = Mutex::new(f.db);
    reconcile(&db).unwrap();
    let mut db = db.into_inner().unwrap();
    for state in [RunState::Preparing, RunState::Runnable] {
        let current = db.run(&run).unwrap();
        db.transition_run(&run, db.epoch(), current.revision, state)
            .unwrap();
    }
    let delivery = db
        .prepare_input_delivery(
            &run,
            db.epoch(),
            db.head(&cold.branch_id).unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    db.admit_input_delivery(delivery).unwrap().unwrap();
    let delivered = db.calendar_occurrence(&occurrence.id).unwrap();
    assert_eq!(delivered.goal_id, original.goal_id);
    let current = db.run(&run).unwrap();
    db.transition_run(&run, db.epoch(), current.revision, RunState::Completed)
        .unwrap();
    assert_eq!(
        db.calendar_occurrence(&occurrence.id).unwrap().state,
        OccurrenceState::Delivered
    );
    db.control_goal(
        original.goal_id.as_deref().unwrap(),
        1,
        &goals::GoalScope {
            thread_id: cold.thread_id,
            branch_id: cold.branch_id,
        },
        goals::GoalControlAction::Cancel,
    )
    .unwrap();
    assert_eq!(
        db.calendar_occurrence(&occurrence.id).unwrap().state,
        OccurrenceState::Cancelled
    );
    assert_eq!(db.run(&run).unwrap().state, RunState::Completed);
    drop(db);
    std::fs::remove_dir_all(f.path).unwrap();
}

fn pi_once_acceptance() -> OnceAcceptance {
    OnceAcceptance {
        owner: OnceAcceptanceOwner::Pi,
        acceptance_id: "pi-session:original-accepted-turn".into(),
        scheduled_at_ms: 0,
        accepted_at_ms: 1,
    }
}
#[test]
fn pi_once_handoff_consumes_original_slot_after_settle_and_reopen_without_native_fake_work() {
    for active in [false, true] {
        let mut f = Fixture::new();
        let mut input = definition(false);
        input.once_acceptance = Some(pi_once_acceptance());
        input.activation_hold = active.then_some(ActivationHold::PreviousRuntimeActive);
        let d = sync(&mut f.db, &input);
        assert_eq!(d.once_acceptance, input.once_acceptance);
        assert!(!d.calculation_pending);
        assert!(d.next_at_ms.is_none());
        assert_eq!(f.db.reconcile_calendar_facts_at(50).unwrap(), 0);
        assert!(f.db.calendar_occurrences(&d.id).unwrap().is_empty());
        assert_eq!(
            f.db.db
                .query_row("SELECT count(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(f.db);
        let mut db = Catalog::open(&f.path).unwrap();
        input.activation_hold = None;
        input.asset_revision = "after-original-pi-settle".into();
        let current = sync(&mut db, &input);
        assert_eq!(current.generation, d.generation);
        assert!(db.calendar_pending().unwrap().calculations.is_empty());
        assert!(db.nearest_calendar_deadline().unwrap().is_none());
        assert_eq!(db.reconcile_calendar_facts_at(500).unwrap(), 0);
        // A later same-generation snapshot cannot erase the already accepted cursor or audit fact.
        input.once_acceptance = None;
        let current = sync(&mut db, &input);
        assert_eq!(current.once_acceptance, Some(pi_once_acceptance()));
        assert!(db.calendar_occurrences(&d.id).unwrap().is_empty());
        let manual = db
            .run_calendar_now(&d.id, current.revision, "explicit-manual-after-transfer")
            .unwrap();
        let prepared = prepare(&db, &manual);
        assert!(db
            .admit_calendar_submission(prepared)
            .unwrap()
            .run_id
            .is_some());
        assert_eq!(db.calendar_occurrences(&d.id).unwrap().len(), 1);
        drop(db);
        std::fs::remove_dir_all(f.path).unwrap();
    }
}
#[test]
fn native_once_roundtrip_keeps_original_acceptance_and_semantic_edit_authorizes_a_new_generation() {
    let mut f = Fixture::new();
    let mut input = definition(false);
    let d = sync(&mut f.db, &input);
    let occurrence = due(&mut f.db, &d, 0);
    let prepared = prepare(&f.db, &occurrence);
    let delivered = f.db.admit_calendar_submission(prepared).unwrap();
    input.once_acceptance = Some(OnceAcceptance {
        owner: OnceAcceptanceOwner::Agent,
        acceptance_id: occurrence.id.clone(),
        scheduled_at_ms: 0,
        accepted_at_ms: occurrence.observed_at_ms,
    });
    let same = sync(&mut f.db, &input);
    assert_eq!(same.generation, d.generation);
    assert_eq!(f.db.calendar_occurrence(&occurrence.id).unwrap(), delivered);
    let project = f.db.calendar_project("project").unwrap();
    let prepared =
        f.db.prepare_calendar_sync("project".into(), Some(project.revision), vec![])
            .unwrap()
            .load()
            .unwrap();
    f.db.admit_calendar_sync(prepared).unwrap();
    // The Host has completed its asset handoff through Pi and returns the original managed receipt.
    let restored = sync(&mut f.db, &input);
    assert!(restored.generation > d.generation);
    finish(&mut f.db, delivered.run_id.as_deref().unwrap());
    assert_eq!(f.db.reconcile_calendar_facts_at(10).unwrap(), 0);
    assert!(f.db.calendar_pending().unwrap().calculations.is_empty());
    assert_eq!(f.db.calendar_occurrences(&d.id).unwrap().len(), 1);
    input.instruction = "A newly edited intent".into();
    input.once_acceptance = None;
    input.asset_revision = "new-intent".into();
    let edited = sync(&mut f.db, &input);
    assert!(edited.generation > restored.generation);
    assert!(edited.once_acceptance.is_none());
    let new = due(&mut f.db, &edited, 0);
    assert_ne!(new.id, occurrence.id);
    assert!(new.run_id.is_none());
    assert_eq!(
        f.db.calendar_occurrence(&occurrence.id).unwrap().run_id,
        delivered.run_id
    );
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}
#[test]
fn once_handoff_fences_old_calculation_is_idempotent_and_rejects_non_once_evidence() {
    let mut f = Fixture::new();
    let mut input = definition(false);
    let d = sync(&mut f.db, &input);
    let late = f.db.calendar_pending().unwrap().calculations.pop().unwrap();
    input.once_acceptance = Some(pi_once_acceptance());
    let accepted = sync(&mut f.db, &input);
    assert_eq!(accepted.generation, d.generation);
    let cursor = f.db.events_after(0, 10000).unwrap().last().unwrap().cursor;
    assert_eq!(sync(&mut f.db, &input), accepted);
    assert!(f.db.events_after(cursor, 10000).unwrap().is_empty());
    assert!(f
        .db
        .admit_calendar_calculation(
            late,
            Some(CalculationResult {
                next: Some(Slot {
                    at_ms: 0,
                    following_at_ms: None
                }),
                latest_due: Some(Slot {
                    at_ms: 0,
                    following_at_ms: None
                }),
                next_future: None
            }),
            None
        )
        .is_err());
    assert_eq!(f.db.reconcile_calendar_facts_at(10).unwrap(), 0);
    input.rule = Rule::Daily {
        times: vec!["09:00".into()],
    };
    let revision = f.db.calendar_project("project").unwrap().revision;
    assert!(f
        .db
        .prepare_calendar_sync("project".into(), Some(revision), vec![input])
        .unwrap()
        .load()
        .is_err());
    assert_eq!(
        f.db.calendar_project("project").unwrap().definitions[0],
        accepted
    );
    drop(f.db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn accepted_cold_slot_remains_exportable_after_tombstone_before_any_run_exists() {
    let mut f = Fixture::new();
    let mut input = definition(false);
    let definition = sync(&mut f.db, &input);
    // Host has captured this generation for handoff; native observation wins before its tombstone.
    let generation = definition.generation;
    let observed = due(&mut f.db, &definition, 0);
    let late = prepare(&f.db, &observed);
    let revision = f.db.calendar_project("project").unwrap().revision;
    let tombstone =
        f.db.prepare_calendar_sync("project".into(), Some(revision), vec![])
            .unwrap()
            .load()
            .unwrap();
    f.db.admit_calendar_sync(tombstone).unwrap();
    let original =
        f.db.calendar_occurrences(&definition.id)
            .unwrap()
            .into_iter()
            .find(|o| {
                o.generation == generation && matches!(o.reason, OccurrenceReason::Scheduled { .. })
            })
            .unwrap();
    assert_eq!(original.id, observed.id);
    assert_eq!(original.state, OccurrenceState::Cancelled);
    assert!(original.run_id.is_none());
    assert!(matches!(
        f.db.admit_calendar_submission(late),
        Err(RuntimeError::DispatchCancelled)
    ));
    let OccurrenceReason::Scheduled { at_ms } = original.reason else {
        unreachable!()
    };
    input.once_acceptance = Some(OnceAcceptance {
        owner: OnceAcceptanceOwner::Agent,
        acceptance_id: original.id,
        scheduled_at_ms: at_ms,
        accepted_at_ms: original.observed_at_ms,
    });
    drop(f.db);
    let mut db = Catalog::open(&f.path).unwrap();
    let restored = sync(&mut db, &input);
    assert!(restored.once_acceptance.is_some());
    assert!(db.calendar_pending().unwrap().calculations.is_empty());
    assert_eq!(db.reconcile_calendar_facts_at(500).unwrap(), 0);
    assert_eq!(
        db.db
            .query_row("SELECT count(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.db
            .query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(db.calendar_occurrences(&definition.id).unwrap().len(), 1);
    drop(db);
    std::fs::remove_dir_all(f.path).unwrap();
}

#[test]
fn cold_zero_budget_goal_parks_before_any_model_serialization_or_inference() {
    struct NeverCalled;
    impl ModelProvider for NeverCalled {
        fn serialize(&self, _: &RequestView) -> std::result::Result<Value, ExecutionError> {
            panic!("zero-budget Goal must gate before model serialization")
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            _: &CancellationToken,
            _: &mut dyn FnMut(ProviderEvent) -> std::result::Result<(), ExecutionError>,
        ) -> std::result::Result<FinishReason, ModelFailure> {
            panic!("zero-budget Goal must never infer")
        }
    }
    let mut f = Fixture::new();
    let mut input = definition(true);
    let Target::NewWork {
        goal: Some(goal), ..
    } = &mut input.target
    else {
        unreachable!()
    };
    goal.budget = Some(goals::GoalBudget {
        max_output_tokens: 0,
    });
    let d = sync(&mut f.db, &input);
    let occurrence =
        f.db.run_calendar_now(&d.id, d.revision, "budget-zero")
            .unwrap();
    let prepared = prepare(&f.db, &occurrence);
    let delivered = f.db.admit_calendar_submission(prepared).unwrap();
    let run = delivered.run_id.unwrap();
    let goal = delivered.goal_id.unwrap();
    let binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":occurrence.branch_id,"ancestor_id":null,"leaf_id":f.db.head(&occurrence.branch_id).unwrap()}})).unwrap();
    let execution =
        f.db.prepare_execution(&run, binding, DefaultAgentPolicy.identity(), Value::Null)
            .unwrap();
    let db = Arc::new(Mutex::new(f.db));
    let engine = ExecutionEngine {
        context_preparation: Arc::new(NoopContextPreparation),
        persistence: db.clone(),
        provider: Arc::new(NeverCalled),
        tools: Arc::new(crate::composition::tools::ToolDirectory::assemble(vec![]).unwrap()),
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    };
    let report = engine.run(execution, CancellationToken::default()).unwrap();
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    let current = db
        .lock()
        .unwrap()
        .capture_goal(&goal)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(current.state, goals::GoalState::BudgetLimited);
    assert_eq!(current.usage.actual.inferences, 0);
    assert_eq!(current.usage.missing_inferences, 0);
    assert_eq!(
        db.lock()
            .unwrap()
            .db
            .query_row(
                "SELECT count(*) FROM model_steps WHERE run_id=?1",
                [&run],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        db.lock()
            .unwrap()
            .calendar_occurrence(&occurrence.id)
            .unwrap()
            .hold_reason
            .as_deref(),
        Some("goal_blocked")
    );
    drop(engine);
    drop(db);
    std::fs::remove_dir_all(f.path).unwrap();
}
