use super::*;

fn register(f: &mut Fixture, key: &str, trigger: FollowupRegistrationTrigger) -> Followup {
    let p =
        f.db.prepare_followup_registration(
            key,
            &f.run,
            FollowupRegistration {
                trigger,
                instruction: "Act once on these original conditions".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_followup_registration(p).unwrap().followup
}
fn at_source(at_ms: u64) -> FollowupRegistrationSource {
    FollowupRegistrationSource::At { at_ms }
}
fn process_source(id: &str) -> FollowupRegistrationSource {
    FollowupRegistrationSource::ProcessStopped {
        operation_id: id.into(),
    }
}
fn stopped(f: &mut Fixture, id: &str, stopped: bool) {
    let mut receipt = f.receipt();
    receipt.identity = id.into();
    receipt.result = json!({"processId":id,"status":"exited","exitCode":0});
    f.db.record_external_receipt_with_stop(id, receipt, stopped)
        .unwrap();
}
fn second_process(f: &mut Fixture) -> String {
    let request = "second-process-request";
    let operation = format!("{request}:tool:process");
    let launch = f.db.launch_intent(&f.run).unwrap().unwrap().selection;
    let branch = f.db.run(&f.run).unwrap().branch_id;
    let range = HistoryRange {
        branch_id: branch.clone(),
        ancestor_id: None,
        leaf_id: f.db.head(&branch).unwrap(),
    };
    let call = ToolCall {
        call_id: "process".into(),
        name: "process_spawn".into(),
        schema_version: "1".into(),
        arguments: json!({"command":"second-original-process"}),
    };
    let context = ToolExecutionContext {
        run_id: f.run.clone(),
        operation_id: operation.clone(),
        origin: ToolOrigin::ModelStep {
            request_id: request.into(),
        },
    };
    f.record(ExecutionRecord::RequestPrepared {
        snapshot: RequestSnapshot {
            view: RequestView {
                request_id: request.into(),
                run_id: f.run.clone(),
                origin: RequestOrigin::Conversation {
                    step: 2,
                    history_range: range.clone(),
                },
                binding: RequestBinding {
                    child_dispatch: None,
                    goal: f.db.goal_binding(&f.run).unwrap(),
                    resource_activations: vec![],
                    resource_checkpoint_id: None,
                    connection_identity: launch.connection_identity,
                    provider_family: launch.provider_family,
                    model: launch.model,
                    credential_ref: None,
                    configuration_generation: launch.configuration_generation,
                    tool_schema_generation: launch.tool_schema_generation,
                    tools: launch.tools,
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
    f.record(ExecutionRecord::ModelDispatched {
        request_id: request.into(),
    });
    f.record(ExecutionRecord::ModelFinished {
        request_id: request.into(),
        outcome: ModelOutcome::Completed,
        finish_reason: Some(FinishReason::ToolCalls),
        items: vec![ProviderItem {
            id: "second-provider-call".into(),
            content: Content::ToolCall { call: call.clone() },
            opaque: None,
        }],
        interrupted_deltas: vec![],
        usage: UsageReceipt::default(),
        failure: None,
    });
    f.record(ExecutionRecord::ToolAdmitted {
        context: context.clone(),
        tool: AdmittedTool {
            call,
            contract: ToolContract {
                name: "process_spawn".into(),
                schema_version: "1".into(),
                read_only: false,
                completion: CompletionKind::Job,
                lifetime: Lifetime::Thread,
                resources: vec![],
            },
        },
    });
    f.record(ExecutionRecord::ToolDispatched {
        context: context.clone(),
        executor_owner: ExecutorOwner::Kernel,
    });
    let completion = ToolCompletion::JobAccepted {
        operation_id: operation.clone(),
        phase: "running".into(),
        effect: Effect::Dispatched,
        lifetime: Lifetime::Thread,
    };
    f.record(ExecutionRecord::ToolSettled {
        context,
        completion: completion.clone(),
        executor_stopped: false,
    });
    f.record(ExecutionRecord::ToolBatchCommitted {
        request_id: request.into(),
        results: vec![ToolResult {
            request_id: request.into(),
            call_id: "process".into(),
            completion,
        }],
    });
    operation
}

#[test]
fn any_at_is_one_active_input_without_a_missing_process_body_or_late_second_occurrence() {
    let mut f = Fixture::new();
    let process = f.process.clone();
    let value = register(
        &mut f,
        "race",
        FollowupRegistrationTrigger::Any {
            sources: vec![process_source(&process), at_source(0)],
        },
    );
    assert!(value.sources[0].observed.is_none());
    assert!(value.sources[1].observed.is_some());
    assert!(f.db.operation(&process).unwrap().external_receipt.is_none());
    assert!(f.reconcile().is_empty());
    let frozen = f.db.followup("race").unwrap().occurrence.unwrap();
    let TriggerEvidence::Any { sources } = &frozen.evidence else {
        panic!("any evidence")
    };
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source_index, 1);
    let p =
        f.db.prepare_input_delivery(
            &f.run,
            f.db.epoch(),
            f.db.head("branch").unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    let batch = f.db.admit_input_delivery(p).unwrap().unwrap();
    assert_eq!(batch.items.len(), 1);
    let Content::Text { text } = &batch.items[0].content else {
        panic!("fact")
    };
    assert!(text.contains("\"processes\":[]"));
    stopped(&mut f, &process, true);
    assert!(f.reconcile().is_empty());
    assert_eq!(
        f.db.followup("race").unwrap().occurrence.unwrap().evidence,
        frozen.evidence
    );
    assert!(f.db.followup("race").unwrap().sources[0].observed.is_none());
    assert_eq!(f.db.nearest_followup_deadline().unwrap(), None);
    f.cleanup();
}

#[test]
fn all_retains_each_fact_through_restart_and_removes_only_observed_time_deadlines() {
    let mut f = Fixture::new();
    let process = f.process.clone();
    let now = varin_runtime::catalog::observations::wall_time_ms().unwrap();
    let definition = register(
        &mut f,
        "all",
        FollowupRegistrationTrigger::All {
            sources: vec![
                at_source(now + 60_000),
                process_source(&process),
                at_source(now + 120_000),
            ],
        },
    );
    assert_eq!(
        f.db.nearest_followup_deadline().unwrap(),
        Some(now + 60_000)
    );
    f.db.reconcile_followup_facts_at(now + 60_000).unwrap();
    let first = f.db.followup("all").unwrap();
    assert_eq!(first.wait.state, NextRunWaitState::Waiting);
    assert!(first.occurrence.is_none());
    assert!(first.sources[0].observed.is_some());
    assert_eq!(
        f.db.nearest_followup_deadline().unwrap(),
        Some(now + 120_000)
    );
    assert!(f
        .db
        .events_after(definition.wait.after_cursor, 1000)
        .unwrap()
        .iter()
        .any(|event| event.kind == "followup.sources_observed"));
    f.db.reconcile_followup_facts_at(now + 120_000).unwrap();
    assert_eq!(f.db.nearest_followup_deadline().unwrap(), None);
    stopped(&mut f, &process, false);
    assert!(f.reconcile().is_empty());
    assert!(f.db.followup("all").unwrap().occurrence.is_none());
    f.state(RunState::Completed);
    let mut f = f.reopen();
    assert_eq!(f.db.followup("all").unwrap().sources[0], first.sources[0]);
    assert_eq!(f.db.nearest_followup_deadline().unwrap(), None);
    assert!(f.reconcile().is_empty());
    stopped(&mut f, &process, true);
    let runs = f.reconcile();
    assert_eq!(runs.len(), 1);
    let value = f.db.followup("all").unwrap();
    let TriggerEvidence::All { sources } = value.occurrence.unwrap().evidence else {
        panic!("all evidence")
    };
    assert_eq!(sources.len(), 3);
    assert_eq!(
        sources[0].evidence,
        first.sources[0].observed.clone().unwrap().evidence
    );
    assert_eq!(value.wait.state, NextRunWaitState::Consumed);
    assert!(f.reconcile().is_empty());
    f.cleanup();
}

#[test]
fn any_one_original_process_can_win_while_another_is_unstopped_and_deadline_is_future() {
    let mut f = Fixture::new();
    let second = second_process(&mut f);
    let process = f.process.clone();
    let future = varin_runtime::catalog::observations::wall_time_ms().unwrap() + 60_000;
    register(
        &mut f,
        "race",
        FollowupRegistrationTrigger::Any {
            sources: vec![
                at_source(future),
                process_source(&process),
                process_source(&second),
            ],
        },
    );
    stopped(&mut f, &second, true);
    assert!(f.reconcile().is_empty());
    let value = f.db.followup("race").unwrap();
    assert!(value.occurrence.as_ref().unwrap().delivery.is_some());
    assert!(value.sources[0].observed.is_none() && value.sources[1].observed.is_none());
    let TriggerEvidence::Any { sources } = &value.occurrence.unwrap().evidence else {
        panic!("any")
    };
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].source_index, 2);
    assert!(
        matches!(&sources[0].evidence, FollowupLeafEvidence::ProcessStopped { receipt_identity, .. } if receipt_identity == &second)
    );
    assert_eq!(
        f.db.operation(&process).unwrap().phase,
        OperationPhase::Running
    );
    assert_eq!(f.db.nearest_followup_deadline().unwrap(), None);
    f.cleanup();
}

#[test]
fn register_rechecks_multiple_original_receipts_and_all_needs_both_real_stops() {
    let mut f = Fixture::new();
    let second = second_process(&mut f);
    let process = f.process.clone();
    stopped(&mut f, &process, true);
    let p =
        f.db.prepare_followup_registration(
            "all",
            &f.run,
            FollowupRegistration {
                trigger: FollowupRegistrationTrigger::All {
                    sources: vec![process_source(&process), process_source(&second)],
                },
                instruction: "Inspect both outputs".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    stopped(&mut f, &second, false);
    let first = f.db.admit_followup_registration(p).unwrap().followup;
    assert!(first.sources[0].observed.is_some() && first.sources[1].observed.is_none());
    assert!(first.occurrence.is_none());
    assert!(f
        .db
        .pending_external_operations("process_spawn")
        .unwrap()
        .contains(&second));
    stopped(&mut f, &second, true);
    f.reconcile();
    let value = f.db.followup("all").unwrap();
    assert!(value.sources.iter().all(|s| s.observed.is_some()));
    let p =
        f.db.prepare_input_delivery(
            &f.run,
            f.db.epoch(),
            f.db.head("branch").unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    let batch = f.db.admit_input_delivery(p).unwrap().unwrap();
    let Content::Text { text } = &batch.items[0].content else {
        panic!("fact")
    };
    assert!(text.contains(&process) && text.contains(&second));
    assert_eq!(batch.items.len(), 1);
    f.cleanup();
}

#[test]
fn every_composite_leaf_is_validated_and_authorized_even_when_at_is_already_due() {
    let mut f = Fixture::new();
    let invalid = [
        json!({"kind":"any","sources":[]}),
        json!({"kind":"all","sources":[{"kind":"any","sources":[{"kind":"at","atMs":0}]}]}),
        json!({"kind":"any","sources":[{"kind":"at","atMs":0},{"kind":"process_stopped","operationId":" "}]}),
        json!({"kind":"all","sources":[{"kind":"at","atMs":u64::MAX}]}),
        json!({"kind":"any","sources":[{"kind":"at","atMs":0},{"kind":"process_stopped","operationId":"request"}]}),
    ];
    for (n, trigger) in invalid.into_iter().enumerate() {
        let result = serde_json::from_value::<FollowupRegistrationTrigger>(trigger)
            .map_err(|_| ())
            .and_then(|trigger| {
                f.db.prepare_followup_registration(
                    &format!("invalid-{n}"),
                    &f.run,
                    FollowupRegistration {
                        trigger,
                        instruction: "Never accept".into(),
                        wait: None,
                    },
                )
                .and_then(|p| p.load())
                .and_then(|p| f.db.admit_followup_registration(p))
                .map_err(|_| ())
            });
        assert!(result.is_err(), "invalid source {n}");
    }
    assert!(f.db.followups("thread").unwrap().is_empty());
    f.cleanup();
}

#[test]
fn composite_pause_and_cancel_preserve_partial_facts_and_original_process() {
    let mut f = Fixture::new();
    let process = f.process.clone();
    let value = register(
        &mut f,
        "held",
        FollowupRegistrationTrigger::All {
            sources: vec![at_source(0), process_source(&process)],
        },
    );
    f.db.control_followup("held", value.revision, FollowupControlAction::Pause)
        .unwrap();
    stopped(&mut f, &process, true);
    assert!(f.reconcile().is_empty());
    let paused = f.db.followup("held").unwrap();
    assert_eq!(
        paused.occurrence.unwrap().hold_reason,
        Some(HoldReason::ControlPaused)
    );
    let process_before = f.db.operation(&process).unwrap();
    f.db.control_followup("held", paused.revision, FollowupControlAction::Cancel)
        .unwrap();
    assert!(f.reconcile().is_empty());
    assert_eq!(f.db.operation(&process).unwrap(), process_before);
    assert_eq!(
        f.db.followup("held").unwrap().wait.state,
        NextRunWaitState::Cancelled
    );
    f.cleanup();
}

#[test]
fn dependency_checks_require_frozen_at_evidence_and_every_all_leaf() {
    use varin_runtime::catalog::goals::*;
    for mode in ["any_at", "any_process", "all_ready", "all_pending"] {
        let mut f = Fixture::new();
        let second = second_process(&mut f);
        let dependency = f.process.clone();
        let p =
            f.db.prepare_goal_start(
                "goal",
                &f.run,
                GoalScope {
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                },
                "Wait for the original dependency".into(),
                None,
            )
            .unwrap()
            .load()
            .unwrap();
        f.db.admit_goal_mutation(p).unwrap();
        report_dependency(&mut f, "dependency-report", Some(dependency.clone()));
        f.state(RunState::Completed);
        if matches!(mode, "any_process" | "all_ready") {
            stopped(&mut f, &second, true);
        }
        let future = varin_runtime::catalog::observations::wall_time_ms().unwrap() + 60_000;
        let trigger = match mode {
            "any_at" => FollowupRegistrationTrigger::Any {
                sources: vec![process_source(&dependency), at_source(0)],
            },
            "any_process" => FollowupRegistrationTrigger::Any {
                sources: vec![process_source(&second), at_source(future)],
            },
            _ => FollowupRegistrationTrigger::All {
                sources: vec![process_source(&second), at_source(0)],
            },
        };
        register(&mut f, "check", trigger);
        let first = f.reconcile();
        if mode == "any_process" {
            assert!(first.is_empty());
            let value = f.db.followup("check").unwrap();
            assert_eq!(
                value.occurrence.unwrap().hold_reason,
                Some(HoldReason::GoalBlocked)
            );
            // A later At fact cannot rewrite the original process-only race evidence.
            f.db.reconcile_followup_facts_at(future).unwrap();
            assert!(f.reconcile().is_empty());
            assert!(f.db.followup("check").unwrap().sources[1]
                .observed
                .is_none());
        } else {
            let runs = if mode == "all_pending" {
                assert!(first.is_empty());
                assert!(f.db.followup("check").unwrap().occurrence.is_none());
                assert_eq!(f.db.nearest_followup_deadline().unwrap(), None);
                stopped(&mut f, &second, true);
                f.reconcile()
            } else {
                first
            };
            assert_eq!(runs.len(), 1, "{mode}");
            assert!(matches!(
                f.db.goal_boundary(&runs[0], f.db.epoch()).unwrap(),
                GoalBoundary::Continue
            ));
            let goal = f.db.capture_goal("goal").unwrap().load().unwrap();
            assert_eq!(goal.blocked_reason, Some(GoalBlockReason::Dependency));
            assert_eq!(
                goal.dependency_operation_id.as_deref(),
                Some(dependency.as_str())
            );
            assert!(!f
                .db
                .operation(&dependency)
                .unwrap()
                .external_receipt
                .as_ref()
                .is_some_and(|r| r.executor_stopped));
            assert!(f.reconcile().is_empty());
        }
        f.cleanup();
    }
}

#[test]
fn simultaneous_any_snapshot_freezes_every_visible_witness_without_claiming_historical_race_order()
{
    let mut f = Fixture::new();
    let process = f.process.clone();
    stopped(&mut f, &process, true);
    let original = register(
        &mut f,
        "simultaneous",
        FollowupRegistrationTrigger::Any {
            sources: vec![process_source(&process), at_source(0)],
        },
    );
    let TriggerEvidence::Any { sources } = &original.occurrence.as_ref().unwrap().evidence else {
        panic!("any")
    };
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0].source_index, 0);
    assert_eq!(sources[1].source_index, 1);
    f.db.reconcile_followup_facts_at(u64::MAX).unwrap();
    let after = f.db.followup("simultaneous").unwrap();
    assert_eq!(
        after.occurrence.unwrap().evidence,
        original.occurrence.unwrap().evidence
    );
    f.cleanup();
}

#[test]
fn a_due_any_branch_does_not_authorize_a_foreign_thread_process_leaf() {
    let mut f = Fixture::new();
    let original_run = f.run.clone();
    let launch =
        f.db.launch_intent(&original_run)
            .unwrap()
            .unwrap()
            .selection;
    f.db.create_thread("foreign-thread", "foreign-branch")
        .unwrap();
    let receipt =
        f.db.submit_with_launch(
            &SubmitInput {
                key: "foreign-input".into(),
                thread_id: "foreign-thread".into(),
                branch_id: "foreign-branch".into(),
                expected_head: None,
                input: json!("Independent work"),
                configuration: json!({}),
            },
            Some(launch),
        )
        .unwrap();
    f.run = receipt.run_id;
    f.state(RunState::Runnable);
    let foreign_process = second_process(&mut f);
    f.run = original_run;
    let original = f.db.operation(&foreign_process).unwrap();
    let prepared =
        f.db.prepare_followup_registration(
            "foreign-source",
            &f.run,
            FollowupRegistration {
                trigger: FollowupRegistrationTrigger::Any {
                    sources: vec![at_source(0), process_source(&foreign_process)],
                },
                instruction: "Must not observe another Thread".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    assert!(f.db.admit_followup_registration(prepared).is_err());
    assert!(f.db.followups("thread").unwrap().is_empty());
    assert_eq!(f.db.operation(&foreign_process).unwrap(), original);
    f.cleanup();
}
