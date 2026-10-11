//! Original Host job receipts feed ordinary follow-up admission and real input activation.
use super::*;
use varin_runtime::catalog::host_jobs::HostJobBinding;
pub(super) fn job(f: &mut Fixture, key: &str, accept: bool) -> HostJobBinding {
    let run = f.db.run(&f.run).unwrap();
    let source =
        f.db.launch_intent(&f.run)
            .unwrap()
            .unwrap()
            .selection
            .source
            .unwrap();
    let prepared =
        f.db.prepare_result_content()
            .write_data(&json!({"requestId":key}))
            .unwrap();
    let op =
        f.db.admit_user_host_job(
            &run.thread_id,
            &run.branch_id,
            &run.id,
            key,
            "research.experiment",
            1,
            &format!("attempt:{key}"),
            prepared,
        )
        .unwrap();
    let binding = HostJobBinding {
        operation_id: op.id,
        execution_owner: op.execution_owner.unwrap(),
        domain: "research.experiment".into(),
        domain_version: 1,
        workspace_id: source.workspace_id,
        subject_id: format!("attempt:{key}"),
    };
    f.db.begin_host_job(binding.clone()).unwrap();
    if accept {
        let accepted = f.db.prepare_result_content().write_result(&json!({"attempt":{"attemptId":binding.subject_id},"text":"original domain acceptance"})).unwrap();
        f.db.accept_host_job(binding.clone(), accepted).unwrap();
    }
    binding
}
fn stop(f: &mut Fixture, binding: &HostJobBinding, stopped: bool) {
    let op = f.db.operation(&binding.operation_id).unwrap();
    let ExecutorOwner::External { epoch, .. } = &binding.execution_owner else {
        panic!()
    };
    // A real stopped executor need not have a known business outcome or complete artifacts.
    let receipt = f.db.prepare_result_content().write_external_receipt(ExternalReceipt { executor: op.executor.unwrap(), identity: op.id, epoch: epoch.clone(), outcome: Outcome::Indeterminate, effect: Effect::Unknown,
        result: json!({"attempt":{"attemptId":binding.subject_id,"state":"unknown","collectionState":"pending"}}).into() }).unwrap();
    f.db.record_host_job_terminal(binding, receipt, stopped)
        .unwrap();
}
fn register(f: &mut Fixture, key: &str, trigger: FollowupRegistrationTrigger) -> Followup {
    conditions::register(f, key, trigger)
}
fn source(binding: &HostJobBinding) -> FollowupRegistrationSource {
    FollowupRegistrationSource::JobStopped {
        operation_id: binding.operation_id.clone(),
    }
}
fn trigger(binding: &HostJobBinding) -> FollowupRegistrationTrigger {
    FollowupRegistrationTrigger::JobStopped {
        operation_id: binding.operation_id.clone(),
    }
}
fn deliver(f: &mut Fixture) -> Vec<ConversationItem> {
    let p =
        f.db.prepare_input_delivery(
            &f.run,
            f.db.epoch(),
            f.db.head("branch").unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_input_delivery(p).unwrap().unwrap().items
}
#[test]
fn accepted_job_discovery_and_registration_reject_unaccepted_process_and_foreign_targets() {
    let mut f = Fixture::new();
    let planned = job(&mut f, "planned", false);
    let accepted = job(&mut f, "accepted", true);
    let candidates = f.db.host_job_sources(&f.run).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].binding, accepted);
    assert_eq!(candidates[0].source_run_id, f.run);
    assert!(matches!(
        candidates[0].origin,
        varin_runtime::catalog::host_jobs::HostJobOrigin::User { .. }
    ));
    let receipt = f.db.submit_with_launch(
        &SubmitInput {
            key: "foreign".into(),
            thread_id: "foreign".into(),
            branch_id: "foreign-branch".into(),
            expected_head: None,
            input: json!("Other work"),
            configuration: json!({}),
        },
        None,
    );
    assert!(receipt.is_err());
    f.db.create_thread("foreign", "foreign-branch").unwrap();
    let foreign =
        f.db.submit(&SubmitInput {
            key: "foreign".into(),
            thread_id: "foreign".into(),
            branch_id: "foreign-branch".into(),
            expected_head: None,
            input: json!("Other work"),
            configuration: json!({}),
        })
        .unwrap();
    assert!(f.db.host_job_sources(&foreign.run_id).unwrap().is_empty());
    assert!(
        f.db.require_host_job_observation(&foreign.run_id, &accepted.operation_id)
            .is_err()
    );
    for id in [planned.operation_id.clone(), f.process.clone()] {
        let p =
            f.db.prepare_followup_registration(
                &id,
                &f.run,
                FollowupRegistration {
                    repeat: varin_runtime::catalog::followups::FollowupRepeat::Once,
                    trigger: FollowupRegistrationTrigger::Any {
                        sources: vec![
                            FollowupRegistrationSource::At { at_ms: 0 },
                            FollowupRegistrationSource::JobStopped {
                                operation_id: id.clone(),
                            },
                        ],
                    },
                    instruction: "Explicit".into(),
                    wait: None,
                },
            )
            .unwrap()
            .load()
            .unwrap();
        assert!(f.db.admit_followup_registration(p).is_err());
    }
    assert!(f.db.followups("thread").unwrap().is_empty());
    f.cleanup();
}
#[test]
fn job_unknown_without_stop_never_wins_then_original_stop_delivers_active_input_and_survives_gc() {
    let mut f = Fixture::new();
    let binding = job(&mut f, "unknown", true);
    let accepted = register(
        &mut f,
        "job-all",
        FollowupRegistrationTrigger::All {
            sources: vec![
                FollowupRegistrationSource::At { at_ms: 0 },
                source(&binding),
            ],
        },
    );
    assert!(accepted.sources[0].observed.is_some());
    assert!(accepted.sources[1].observed.is_none());
    stop(&mut f, &binding, false);
    f.reconcile();
    assert!(f.db.followup("job-all").unwrap().occurrence.is_none());
    let mut f = f.reopen();
    assert!(
        f.db.followup("job-all").unwrap().sources[0]
            .observed
            .is_some()
    );
    stop(&mut f, &binding, true);
    let candidate =
        f.db.capture_followup_continuations()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(
        f.db.prepare_content_collection(Arc::new(AtomicBool::new(false)))
            .run()
            .status,
        ContentCollectionStatus::Deferred
    );
    f.db.admit_followup_continuation(candidate).unwrap();
    let items = deliver(&mut f);
    assert_eq!(items.len(), 1);
    let Content::Output { output } = &items[0].content else {
        panic!("follow-up output")
    };
    let text = serde_json::to_string(&output.data).unwrap();
    assert!(
        text.contains("original domain acceptance")
            && text.contains("collectionState")
            && text.contains("pending")
            && text.contains("indeterminate")
    );
    assert!(!text.contains("process_read"));
    assert_eq!(
        f.db.operation(&binding.operation_id).unwrap().effect,
        Effect::Unknown
    );
    assert_eq!(
        f.db.followup("job-all")
            .unwrap()
            .occurrence
            .unwrap()
            .delivery
            .unwrap()
            .state,
        InputState::Delivered
    );
    assert_eq!(
        f.db.followup("job-all").unwrap().wait.state,
        NextRunWaitState::Consumed
    );
    assert_eq!(
        f.db.prepare_content_collection(Arc::new(AtomicBool::new(false)))
            .run()
            .status,
        ContentCollectionStatus::Completed
    );
    let mut f = f.reopen();
    assert!(f.reconcile().is_empty());
    assert_eq!(
        f.db.host_job_sources(&f.run).unwrap()[0].executor_stopped,
        true
    );
    f.cleanup();
}
#[test]
fn historical_user_job_stops_before_registration_and_continues_current_work_source_in_new_run() {
    let mut f = Fixture::with_source(
        json!({"workspace_id":"workspace","execution_workspace_id":"workspace","mode":"fixed_branch","branch_id":"source","revision":1,"live_root":null}),
    );
    let historical = f.run.clone();
    let binding = job(&mut f, "history", true);
    f.state(RunState::Completed);
    stop(&mut f, &binding, true);
    let mut launch = f.db.launch_intent(&historical).unwrap().unwrap().selection;
    launch.source.as_mut().unwrap().revision = Some(2);
    let current =
        f.db.submit_with_launch(
            &SubmitInput {
                key: "current-work".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: f.db.head("branch").unwrap(),
                input: json!("Current source revision 2"),
                configuration: json!({}),
            },
            Some(launch),
        )
        .unwrap();
    f.run = current.run_id.clone();
    f.state(RunState::Runnable);
    let prepared =
        f.db.prepare_followup_registration(
            "historical-job",
            &f.run,
            FollowupRegistration {
                repeat: varin_runtime::catalog::followups::FollowupRepeat::Once,
                trigger: trigger(&binding),
                instruction: "Follow this current work".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    let value = f.db.admit_followup_registration(prepared).unwrap().followup;
    assert_eq!(value.source_run_id, current.run_id);
    assert!(value.occurrence.is_some());
    assert_eq!(
        f.db.host_job_sources(&f.run).unwrap()[0].source_run_id,
        historical
    );
    f.state(RunState::Completed);
    let mut f = f.reopen();
    let runs = f.reconcile();
    assert_eq!(runs.len(), 1);
    assert_ne!(runs[0], historical);
    assert_ne!(runs[0], current.run_id);
    assert_eq!(
        f.db.launch_intent(&runs[0])
            .unwrap()
            .unwrap()
            .selection
            .source
            .unwrap()
            .revision,
        Some(2)
    );
    assert_eq!(f.db.run(&historical).unwrap().state, RunState::Completed);
    let view = f.db.followup("historical-job").unwrap();
    let evidence = view.occurrence.unwrap().evidence;
    let TriggerEvidence::JobStopped {
        binding: actual,
        receipt_identity,
        ..
    } = evidence
    else {
        panic!()
    };
    assert_eq!(actual, binding);
    assert_eq!(receipt_identity, binding.operation_id);
    f.cleanup();
}
#[test]
fn any_winner_and_stop_race_keep_one_fact_while_cancellation_never_cancels_the_job() {
    let mut f = Fixture::new();
    let binding = job(&mut f, "race", true);
    register(
        &mut f,
        "winner",
        FollowupRegistrationTrigger::Any {
            sources: vec![
                FollowupRegistrationSource::At { at_ms: 0 },
                source(&binding),
            ],
        },
    );
    let winner = f.db.followup("winner").unwrap().occurrence.unwrap();
    let cancelled = register(&mut f, "cancelled", trigger(&binding));
    f.db.control_followup(
        "cancelled",
        cancelled.revision,
        FollowupControlAction::Cancel,
    )
    .unwrap();
    assert!(
        !f.db
            .operation(&binding.operation_id)
            .unwrap()
            .cancel_requested
    );
    let p =
        f.db.prepare_followup_registration(
            "race-stop",
            &f.run,
            FollowupRegistration {
                repeat: varin_runtime::catalog::followups::FollowupRepeat::Once,
                trigger: trigger(&binding),
                instruction: "stop race".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    stop(&mut f, &binding, true);
    f.db.admit_followup_registration(p).unwrap();
    f.reconcile();
    let after = f.db.followup("winner").unwrap();
    assert_eq!(after.occurrence.unwrap().evidence, winner.evidence);
    assert!(after.sources[1].observed.is_none());
    assert!(f.db.followup("race-stop").unwrap().occurrence.is_some());
    assert!(f.db.followup("cancelled").unwrap().occurrence.is_none());
    f.cleanup();
}
#[test]
fn tree_stop_fences_existing_job_intents_but_later_user_intent_is_independent() {
    let mut f = Fixture::new();
    let binding = job(&mut f, "stop", true);
    register(&mut f, "before-stop", trigger(&binding));
    f.state(RunState::Completed);
    f.db.cancel_tree(varin_runtime::catalog::dispatch::TreeCancelTarget::Thread {
        thread_id: "thread".into(),
    })
    .unwrap();
    assert_eq!(
        f.db.followup("before-stop").unwrap().state,
        FollowupState::Cancelled
    );
    register(&mut f, "after-stop", trigger(&binding));
    stop(&mut f, &binding, true);
    let mut f = f.reopen();
    let runs = f.reconcile();
    assert_eq!(runs.len(), 1);
    assert_eq!(
        f.db.followup("before-stop").unwrap().state,
        FollowupState::Cancelled
    );
    assert!(
        f.db.followup("after-stop")
            .unwrap()
            .occurrence
            .unwrap()
            .delivery
            .is_some()
    );
    f.cleanup();
}

#[test]
fn winning_job_stop_keeps_its_original_unknown_body_after_refinement_gc_and_reopen() {
    let mut f = Fixture::new();
    let binding = job(&mut f, "refine", true);
    let value = register(&mut f, "held-original", trigger(&binding));
    f.db.control_followup(
        "held-original",
        value.revision,
        FollowupControlAction::Pause,
    )
    .unwrap();
    stop(&mut f, &binding, true);
    f.db.reconcile_followup_facts_at(u64::MAX).unwrap();
    let original = f.db.followup("held-original").unwrap().occurrence.unwrap();
    assert!(matches!(
        original.evidence,
        TriggerEvidence::JobStopped {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            ..
        }
    ));
    let op = f.db.operation(&binding.operation_id).unwrap();
    let ExecutorOwner::External { epoch, .. } = &binding.execution_owner else {
        panic!()
    };
    let known =
        f.db.prepare_result_content()
            .write_external_receipt(ExternalReceipt {
                executor: op.executor.unwrap(),
                identity: op.id,
                epoch: epoch.clone(),
                outcome: Outcome::Succeeded,
                effect: Effect::Confirmed,
                result: json!({"later":"known business result"}).into(),
            })
            .unwrap();
    f.db.record_host_job_terminal(&binding, known, true)
        .unwrap();
    assert_eq!(
        f.db.operation(&binding.operation_id).unwrap().outcome,
        Some(Outcome::Succeeded)
    );
    let public =
        f.db.capture_events_read(original.trigger_cursor - 1, 1)
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(
        public[0].data["host_job_stop"]["receipt"]["outcome"],
        "indeterminate"
    );
    assert_eq!(
        public[0].data["host_job_stop"]["receipt"]["result"]["data"]["attempt"]["collectionState"],
        "pending"
    );
    assert!(
        public[0].data["host_job_stop"]["receipt"]
            .get("result_ref")
            .is_none()
    );
    assert_eq!(
        f.db.prepare_content_collection(Arc::new(AtomicBool::new(false)))
            .run()
            .status,
        ContentCollectionStatus::Completed
    );
    let mut f = f.reopen();
    let value = f.db.followup("held-original").unwrap();
    f.db.control_followup(
        "held-original",
        value.revision,
        FollowupControlAction::Resume,
    )
    .unwrap();
    // A registration after refinement also observes the original indexed stop fact.
    let late = register(&mut f, "registered-later", trigger(&binding));
    assert_eq!(late.occurrence.unwrap().evidence, original.evidence);
    f.reconcile();
    let items = deliver(&mut f);
    assert_eq!(items.len(), 2);
    for item in items {
        let Content::Output { output } = item.content else {
            panic!("follow-up output")
        };
        let text = serde_json::to_string(&output.data).unwrap();
        assert!(text.contains("indeterminate") && text.contains("collectionState"));
        assert!(!text.contains("known business result"));
    }
    assert_eq!(
        f.db.followup("held-original")
            .unwrap()
            .occurrence
            .unwrap()
            .evidence,
        original.evidence
    );
    f.cleanup();
}

#[test]
fn job_occurrences_keep_original_goal_and_manual_pause_gates_across_reopen() {
    use varin_runtime::catalog::goals::*;
    for goal in [false, true] {
        let mut f = Fixture::new();
        let binding = job(&mut f, "held", true);
        let scope = GoalScope {
            thread_id: "thread".into(),
            branch_id: "branch".into(),
        };
        if goal {
            let p =
                f.db.prepare_goal_start(
                    "job-goal",
                    &f.run,
                    scope.clone(),
                    "Follow the original job".into(),
                    None,
                )
                .unwrap()
                .load()
                .unwrap();
            f.db.admit_goal_mutation(p).unwrap();
        }
        register(&mut f, "held-job", trigger(&binding));
        if goal {
            f.db.control_goal("job-goal", 1, &scope, GoalControlAction::Pause)
                .unwrap();
        } else {
            f.state(RunState::Runnable);
            let boundary = f.db.policy_boundary(&f.run, f.db.epoch()).unwrap();
            let intent = PolicyControlIntent {
                action_id: format!("{}:policy:{}", f.run, boundary.id),
                boundary,
                identity: f
                    .db
                    .launch_intent(&f.run)
                    .unwrap()
                    .unwrap()
                    .selection
                    .policy,
                state: json!({"paused":true}),
                expected_head: f.db.head("branch").unwrap(),
                action: PolicyAction::Pause {
                    reason: "Explicit pause".into(),
                },
            };
            let p = f.db.prepare_policy_control().load(&intent).unwrap();
            f.db.commit_policy_control(&f.run, f.db.epoch(), p).unwrap();
        }
        stop(&mut f, &binding, true);
        f.reconcile();
        let mut f = f.reopen();
        f.reconcile();
        let value = f.db.followup("held-job").unwrap();
        assert_eq!(
            value.occurrence.unwrap().hold_reason,
            Some(if goal {
                HoldReason::GoalPaused
            } else {
                HoldReason::ManualPause
            })
        );
        assert!(f.db.capture_request_activations().unwrap().is_empty());
        f.cleanup();
    }
}

#[test]
fn corrupt_job_receipt_body_fails_only_its_definition_without_blocking_healthy_due_work() {
    let mut f = Fixture::new();
    let binding = job(&mut f, "broken-body", true);
    register(&mut f, "broken-job", trigger(&binding));
    stop(&mut f, &binding, true);
    at(&mut f, "healthy-next", 0, "Healthy independent work");
    let reference =
        f.db.operation(&binding.operation_id)
            .unwrap()
            .external_receipt
            .unwrap()
            .result_ref;
    let path = varin_runtime::content::object_path(
        &f.root.join("content"),
        reference["content_object"].as_str().unwrap(),
    )
    .unwrap();
    std::fs::write(path, b"corrupt original stop body").unwrap();
    let owner = std::sync::Mutex::new(f.db);
    assert!(varin_runtime::catalog::followups::reconcile(&owner).is_err());
    f.db = owner.into_inner().unwrap();
    assert_eq!(
        f.db.followup("broken-job")
            .unwrap()
            .occurrence
            .unwrap()
            .hold_reason,
        Some(HoldReason::PreparationFailed)
    );
    assert!(
        f.db.followup("healthy-next")
            .unwrap()
            .occurrence
            .unwrap()
            .delivery
            .is_some()
    );
    assert!(f.db.capture_followup_continuations().unwrap().is_empty());
    f.cleanup();
}
