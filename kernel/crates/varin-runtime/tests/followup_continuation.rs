//! Durable continuation behavior through real catalog model/tool admissions. Storage/process
//! output and Host IPC are separate integration evidence, not supplied by this fixture.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use std::sync::{atomic::AtomicBool, Arc};
use varin_runtime::catalog::followups::*;
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::execution::*;
use varin_runtime::*;

trait RegisterProcessFollowup {
    fn register_process_followup(
        &mut self,
        key: &str,
        run: &str,
        process: &str,
    ) -> Result<Followup, varin_runtime::catalog::RuntimeError>;
}
impl RegisterProcessFollowup for Catalog {
    fn register_process_followup(
        &mut self,
        key: &str,
        run: &str,
        process: &str,
    ) -> Result<Followup, varin_runtime::catalog::RuntimeError> {
        let p = self
            .prepare_followup_registration(
                key,
                run,
                FollowupRegistration {
                    trigger: FollowupRegistrationTrigger::ProcessStopped {
                        operation_id: process.into(),
                    },
                    instruction: "Inspect the original process result".into(),
                    wait: None,
                },
            )?
            .load()?;
        Ok(self.admit_followup_registration(p)?.followup)
    }
}

struct Fixture {
    root: std::path::PathBuf,
    db: Catalog,
    run: String,
    process: String,
}
impl Fixture {
    fn new() -> Self {
        Self::with_source(
            json!({"mode":"live_root","live_root":{"hostId":"host","canonicalRoot":"/workspace/fixture","rootId":"root"},"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":null,"revision":null}),
        )
    }
    fn with_source(source: serde_json::Value) -> Self {
        let root = std::env::temp_dir().join(format!("varin-followup-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let tools = vec![
            schema("process_spawn"),
            schema("process_read"),
            schema("process_inspect"),
            schema("goal_report"),
        ];
        let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"original-connection","provider_family":"fixture","model":"original-model","configuration_generation":7,"tool_schema_generation":7,"tools":tools,"policy":{"name":"fixture-policy","version":"1"},"source":source})).unwrap();
        let receipt = db
            .submit_with_launch(
                &SubmitInput {
                    key: "original-input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("Run this process and handle its result"),
                    configuration: json!({"model":"original-model"}),
                },
                Some(launch),
            )
            .unwrap();
        let mut fixture = Self {
            root,
            db,
            run: receipt.run_id,
            process: "request:tool:process".into(),
        };
        fixture.state(RunState::Runnable);
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: fixture.db.head("branch").unwrap(),
        };
        let binding = RequestBinding {
            child_dispatch: None,
            goal: None,
            resource_activations: Vec::new(),
            resource_checkpoint_id: None,
            connection_identity: "original-connection".into(),
            provider_family: "fixture".into(),
            model: "original-model".into(),
            credential_ref: None,
            configuration_generation: 7,
            tool_schema_generation: 7,
            tools,
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: range.clone(),
        };
        fixture.record(ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: "request".into(),
                    run_id: fixture.run.clone(),
                    origin: RequestOrigin::Conversation {
                        step: 1,
                        history_range: range,
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({}),
            },
        });
        fixture.record(ExecutionRecord::ModelDispatched {
            request_id: "request".into(),
        });
        let call = ToolCall {
            call_id: "process".into(),
            name: "process_spawn".into(),
            schema_version: "1".into(),
            arguments: json!({"command":"fixture"}),
        };
        fixture.record(ExecutionRecord::ModelFinished {
            request_id: "request".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "provider-call".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        });
        fixture.record(ExecutionRecord::ToolAdmitted {
            context: fixture.context(),
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
        fixture.record(ExecutionRecord::ToolDispatched {
            context: fixture.context(),
            executor_owner: ExecutorOwner::Kernel,
        });
        let completion = ToolCompletion::JobAccepted {
            operation_id: fixture.process.clone(),
            phase: "running".into(),
            effect: Effect::Dispatched,
            lifetime: Lifetime::Thread,
        };
        fixture.record(ExecutionRecord::ToolSettled {
            context: fixture.context(),
            completion: completion.clone(),
            executor_stopped: false,
        });
        fixture.record(ExecutionRecord::ToolBatchCommitted {
            request_id: "request".into(),
            results: vec![ToolResult {
                request_id: "request".into(),
                call_id: "process".into(),
                completion,
            }],
        });
        fixture
    }
    fn context(&self) -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: self.run.clone(),
            operation_id: self.process.clone(),
            origin: ToolOrigin::ModelStep {
                request_id: "request".into(),
            },
        }
    }
    fn record(&mut self, record: ExecutionRecord) {
        self.db
            .commit_execution(&self.run, self.db.epoch(), &record)
            .unwrap();
    }
    fn state(&mut self, state: RunState) {
        self.record(ExecutionRecord::StateChanged {
            state,
            waiting_on: None,
        });
    }
    fn register(&mut self) -> Followup {
        self.db
            .register_process_followup("authorization", &self.run, &self.process)
            .unwrap()
    }
    fn receipt(&self) -> ExternalReceipt {
        ExternalReceipt {
            executor: "process_spawn".into(),
            identity: self.process.clone(),
            epoch: "original-process-epoch".into(),
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            result: json!({"processId":self.process,"kernelEpoch":"original-process-epoch","treeConfirmed":true,"status":"exited","exitCode":0,"outputAvailable":true}),
        }
    }
    fn terminal(&mut self, stopped: bool) {
        self.db
            .record_external_receipt_with_stop(&self.process.clone(), self.receipt(), stopped)
            .unwrap();
    }
    fn reconcile(&mut self) -> Vec<String> {
        let mut runs = Vec::new();
        loop {
            let mut stale = false;
            for candidate in self.db.capture_followup_continuations().unwrap() {
                match self
                    .db
                    .admit_followup_continuation(candidate.load().unwrap())
                    .unwrap()
                {
                    ContinuationAdmission::Admitted(_) => (),
                    ContinuationAdmission::Stale => stale = true,
                    ContinuationAdmission::Held => (),
                }
            }
            for candidate in self.db.capture_request_activations().unwrap() {
                match self
                    .db
                    .admit_request_activation(candidate.load().unwrap())
                    .unwrap()
                {
                    varin_runtime::catalog::activation::RequestActivationAdmission::Bound(run) => {
                        runs.push(run)
                    }
                    varin_runtime::catalog::activation::RequestActivationAdmission::Stale => {
                        stale = true
                    }
                    _ => (),
                }
            }
            if !stale {
                return runs;
            }
        }
    }
    fn reopen(self) -> Self {
        let Self {
            root,
            db,
            run,
            process,
        } = self;
        drop(db);
        let db = Catalog::open(&root).unwrap();
        Self {
            root,
            db,
            run,
            process,
        }
    }
    fn cleanup(self) {
        let Self { root, db, .. } = self;
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
fn schema(name: &str) -> ToolSchema {
    ToolSchema {
        name: name.into(),
        version: "1".into(),
        description: format!("Fixture {name}"),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    }
}

#[test]
fn stopped_process_enters_the_active_original_run_once_and_survives_reopen() {
    let mut f = Fixture::new();
    f.register();
    assert!(f.reconcile().is_empty());
    f.terminal(true);
    assert!(f.reconcile().is_empty());
    let value = f.db.followup("authorization").unwrap();
    let delivery = value.occurrence.unwrap().delivery.unwrap();
    assert_eq!(delivery.run_id.as_deref(), Some(f.run.as_str()));
    assert_eq!(delivery.state, InputState::Queued);
    assert_eq!(value.wait.state, NextRunWaitState::Observed);
    let prepared =
        f.db.prepare_input_delivery(
            &f.run,
            f.db.epoch(),
            f.db.head("branch").unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    let batch = f.db.admit_input_delivery(prepared).unwrap().unwrap();
    assert!(batch.activating);
    assert_eq!(batch.items.len(), 1);
    assert!(matches!(
        batch.items[0].provenance,
        Provenance::EnvironmentFact { .. }
    ));
    let Content::Text { text } = &batch.items[0].content else {
        panic!("follow-up text")
    };
    assert!(text.contains("Inspect the original process result"));
    assert!(text.contains(&f.process));
    assert_eq!(
        f.db.followup("authorization").unwrap().wait.state,
        NextRunWaitState::Consumed
    );
    f.state(RunState::Completed);
    let mut f = f.reopen();
    assert!(f.reconcile().is_empty());
    let before = f.db.followup("authorization").unwrap();
    assert_eq!(
        before.occurrence.as_ref().unwrap().state,
        OccurrenceState::Completed
    );
    assert_eq!(
        f.db.control_followup("authorization", 0, FollowupControlAction::Cancel)
            .unwrap(),
        before
    );
    f.cleanup();
}

#[test]
fn receipt_without_stopped_evidence_and_recovery_terminal_do_not_trigger() {
    let mut f = Fixture::new();
    f.register();
    f.state(RunState::Completed);
    f.terminal(false);
    assert!(f.reconcile().is_empty());
    assert_eq!(
        f.db.followup("authorization").unwrap().wait.state,
        NextRunWaitState::Waiting
    );
    let mut f = f.reopen();
    assert!(f.reconcile().is_empty());
    f.terminal(true);
    assert_eq!(f.reconcile().len(), 1);
    f.cleanup();
    let mut f = Fixture::new();
    f.register();
    f.state(RunState::Completed);
    let mut f = f.reopen();
    assert_eq!(
        f.db.operation(&f.process).unwrap().outcome,
        Some(Outcome::Indeterminate)
    );
    assert!(f.reconcile().is_empty());
    let mut uncertain = f.receipt();
    uncertain.outcome = Outcome::Indeterminate;
    uncertain.effect = Effect::Unknown;
    uncertain.result = json!({"processId":f.process,"status":"failed","writerActive":false,
        "reason":"executor stopped; original business effect remains uncertain"});
    f.db.record_external_receipt_with_stop(&f.process.clone(), uncertain, true)
        .unwrap();
    let original = f.db.operation(&f.process).unwrap();
    assert_eq!(original.effect, Effect::Unknown);
    assert_eq!(original.outcome, Some(Outcome::Indeterminate));
    let next = f.reconcile();
    assert_eq!(next.len(), 1);
    assert_eq!(f.db.operation(&f.process).unwrap(), original);
    assert!(f.db.pending_run_operations(&next[0]).unwrap().is_empty());
    f.cleanup();
}

#[test]
fn terminal_before_registration_and_observed_crash_are_rechecked() {
    let mut f = Fixture::new();
    f.state(RunState::Completed);
    f.terminal(true);
    let registered = f.register();
    assert_eq!(registered.wait.state, NextRunWaitState::Observed);
    let mut f = f.reopen();
    assert_eq!(f.reconcile().len(), 1);
    assert_eq!(f.register().wait.state, NextRunWaitState::Consumed);
    assert!(f
        .db
        .register_process_followup("authorization", &f.run, "different")
        .is_err());
    f.cleanup();
}

#[test]
fn pause_and_cancel_invalidate_prepared_admission_without_reviving_source_run() {
    let mut f = Fixture::new();
    f.register();
    f.state(RunState::Completed);
    f.terminal(true);
    let candidate =
        f.db.capture_followup_continuations()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    let paused =
        f.db.control_followup("authorization", 1, FollowupControlAction::Pause)
            .unwrap();
    assert_eq!(
        f.db.admit_followup_continuation(candidate).unwrap(),
        ContinuationAdmission::Stale
    );
    assert!(f.reconcile().is_empty());
    let resumed =
        f.db.control_followup(
            "authorization",
            paused.revision,
            FollowupControlAction::Resume,
        )
        .unwrap();
    let candidate =
        f.db.capture_followup_continuations()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    f.db.control_followup(
        "authorization",
        resumed.revision,
        FollowupControlAction::Cancel,
    )
    .unwrap();
    assert_eq!(
        f.db.admit_followup_continuation(candidate).unwrap(),
        ContinuationAdmission::Stale
    );
    assert!(f.reconcile().is_empty());
    assert_eq!(f.db.run(&f.run).unwrap().state, RunState::Completed);
    f.cleanup();
}

#[test]
fn cancelling_source_run_atomically_cancels_pending_authorization() {
    let mut f = Fixture::new();
    f.register();
    f.db.request_cancel_run(&f.run).unwrap();
    assert_eq!(
        f.db.followup("authorization").unwrap().state,
        FollowupState::Cancelled
    );
    f.state(RunState::Cancelled);
    f.terminal(true);
    assert!(f.reconcile().is_empty());
    assert!(f
        .db
        .register_process_followup("new-authorization", &f.run, &f.process)
        .is_ok());
    assert_eq!(f.reconcile().len(), 1);
    f.cleanup();
}

#[test]
fn concurrent_user_input_claims_the_original_occurrence_without_a_second_run() {
    let mut f = Fixture::new();
    f.register();
    f.state(RunState::Completed);
    f.terminal(true);
    let candidate =
        f.db.capture_followup_continuations()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    let launch = f.db.launch_intent(&f.run).unwrap().unwrap().selection;
    let user =
        f.db.submit_with_launch(
            &SubmitInput {
                key: "user-two".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: f.db.head("branch").unwrap(),
                input: json!("Additional user constraint"),
                configuration: json!({"user":"new configuration"}),
            },
            Some(launch),
        )
        .unwrap();
    assert!(matches!(
        f.db.admit_followup_continuation(candidate).unwrap(),
        ContinuationAdmission::Admitted(_)
    ));
    assert!(f.reconcile().is_empty());
    let run = f.db.run(&user.run_id).unwrap();
    f.db.transition_run(&run.id, run.epoch, run.revision, RunState::Runnable)
        .unwrap();
    let p =
        f.db.prepare_input_delivery(
            &user.run_id,
            f.db.epoch(),
            f.db.head("branch").unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(
        f.db.admit_input_delivery(p).unwrap().unwrap().items.len(),
        1
    );
    let row =
        f.db.followup("authorization")
            .unwrap()
            .occurrence
            .unwrap()
            .delivery
            .unwrap();
    assert_eq!(row.run_id, Some(user.run_id.clone()));
    assert_eq!(row.state, InputState::Delivered);
    let history = f.db.history("branch").unwrap();
    assert_eq!(
        history.last().unwrap().parent.as_deref(),
        Some(user.input_id.as_str())
    );
    f.cleanup();
}

#[test]
fn only_exact_continuation_run_receives_original_process_read_access() {
    let mut f = Fixture::new();
    f.register();
    f.state(RunState::Completed);
    f.terminal(true);
    let new = f.reconcile().pop().unwrap();
    assert_eq!(
        f.db.require_process_observation(&new, &f.process)
            .unwrap()
            .run_id,
        f.run
    );
    assert!(f
        .db
        .require_process_observation(&new, "different-process")
        .is_err());
    f.db.create_thread("other", "other-branch").unwrap();
    let other =
        f.db.submit(&SubmitInput {
            key: "other".into(),
            thread_id: "other".into(),
            branch_id: "other-branch".into(),
            expected_head: None,
            input: json!("other"),
            configuration: json!({}),
        })
        .unwrap();
    assert!(f
        .db
        .require_process_observation(&other.run_id, &f.process)
        .is_err());
    f.cleanup();
}

#[test]
fn prepared_continuation_publication_and_registered_launch_survive_gc() {
    let mut f = Fixture::new();
    f.register();
    f.state(RunState::Completed);
    f.terminal(true);
    let candidate =
        f.db.capture_followup_continuations()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    let gc =
        f.db.prepare_content_collection(Arc::new(AtomicBool::new(false)))
            .run();
    assert_eq!(gc.status, ContentCollectionStatus::Deferred);
    f.db.admit_followup_continuation(candidate).unwrap();
    let gc =
        f.db.prepare_content_collection(Arc::new(AtomicBool::new(false)))
            .run();
    assert_eq!(gc.status, ContentCollectionStatus::Completed);
    assert!(f
        .db
        .history("branch")
        .unwrap()
        .last()
        .unwrap()
        .content
        .is_object());
    f.cleanup();
}

#[test]
fn stopping_old_owner_fences_prepared_admission_and_reopen_keeps_authorization() {
    let mut f = Fixture::new();
    f.register();
    f.state(RunState::Completed);
    f.terminal(true);
    let candidate =
        f.db.capture_followup_continuations()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    f.db.stop_followup_admission();
    assert!(f.db.admit_followup_continuation(candidate).is_err());
    assert!(f.db.capture_followup_continuations().unwrap().is_empty());
    let mut f = f.reopen();
    assert_eq!(f.reconcile().len(), 1);
    f.cleanup();
}

#[test]
fn same_scope_but_changed_physical_source_holds_without_switching_authority() {
    let mut f = Fixture::new();
    f.register();
    f.state(RunState::Completed);
    f.terminal(true);
    let mut launch = f.db.launch_intent(&f.run).unwrap().unwrap().selection;
    launch
        .source
        .as_mut()
        .unwrap()
        .live_root
        .as_mut()
        .unwrap()
        .root_id = "different-root".into();
    let user =
        f.db.submit_with_launch(
            &SubmitInput {
                key: "change-source".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: f.db.head("branch").unwrap(),
                input: json!("Work in another source now"),
                configuration: json!({}),
            },
            Some(launch),
        )
        .unwrap();
    let run = f.db.run(&user.run_id).unwrap();
    let run =
        f.db.transition_run(&run.id, run.epoch, run.revision, RunState::Runnable)
            .unwrap();
    f.db.transition_run(&run.id, run.epoch, run.revision, RunState::Completed)
        .unwrap();
    assert!(f.reconcile().is_empty());
    assert_eq!(
        f.db.followup("authorization")
            .unwrap()
            .occurrence
            .unwrap()
            .hold_reason,
        Some(HoldReason::ContextScopeChanged)
    );
    let cursor = f.db.event_cursor().unwrap();
    assert!(f.reconcile().is_empty());
    assert_eq!(f.db.event_cursor().unwrap(), cursor);
    f.cleanup();
}

#[test]
fn materialized_source_inheritance_preserves_the_original_environment_owner() {
    let mut f = Fixture::with_source(
        json!({"mode":"materialized","live_root":null,"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":"fixed-source","revision":3}),
    );
    f.register();
    f.state(RunState::Completed);
    f.terminal(true);
    let mut launch = f.db.launch_intent(&f.run).unwrap().unwrap().selection;
    launch.source = None;
    launch.tools.clear();
    let user =
        f.db.submit_with_inherited_source(
            &SubmitInput {
                key: "same-source-input".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: f.db.head("branch").unwrap(),
                input: json!("Keep the existing environment"),
                configuration: json!({}),
            },
            launch,
        )
        .unwrap();
    let run = f.db.run(&user.run_id).unwrap();
    let run =
        f.db.transition_run(&run.id, run.epoch, run.revision, RunState::Runnable)
            .unwrap();
    f.db.transition_run(&run.id, run.epoch, run.revision, RunState::Completed)
        .unwrap();
    let next = f.reconcile().pop().unwrap();
    assert_eq!(
        f.db.launch_intent(&next)
            .unwrap()
            .unwrap()
            .selection
            .source
            .unwrap()
            .environment_run_id
            .as_deref(),
        Some(f.run.as_str())
    );
    assert!(f.db.require_process_observation(&next, &f.process).is_ok());
    f.cleanup();
}

#[test]
fn explicit_process_occurrence_is_managed_independently_and_honors_goal_pause() {
    use varin_runtime::catalog::goals::*;
    let mut f = Fixture::new();
    let scope = GoalScope {
        thread_id: "thread".into(),
        branch_id: "branch".into(),
    };
    let p =
        f.db.prepare_goal_start(
            "goal",
            &f.run,
            scope.clone(),
            "Process the actual result".into(),
            None,
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_goal_mutation(p).unwrap();
    let followup = f.register();
    assert_eq!(followup.goal_id.as_deref(), Some("goal"));
    f.db.control_followup("authorization", 1, FollowupControlAction::Pause)
        .unwrap();
    f.db.control_followup("authorization", 2, FollowupControlAction::Resume)
        .unwrap();
    f.db.control_goal("goal", 1, &scope, GoalControlAction::Pause)
        .unwrap();
    f.state(RunState::Completed);
    f.terminal(true);
    assert!(f.reconcile().is_empty());
    let mut f = f.reopen();
    assert!(f.reconcile().is_empty());
    f.db.control_goal("goal", 2, &scope, GoalControlAction::Resume)
        .unwrap();
    let runs = f.reconcile();
    assert_eq!(runs.len(), 1);
    assert_eq!(
        f.db.require_process_observation(&runs[0], &f.process)
            .unwrap()
            .run_id,
        f.run
    );
    assert!(f.reconcile().is_empty());
    f.cleanup();
}

#[test]
fn tree_stop_cancels_terminal_source_triggers_before_process_stop_can_restart_a_run() {
    use varin_runtime::catalog::dispatch::TreeCancelTarget;
    for goal_owned in [false, true] {
        let mut f = Fixture::new();
        if goal_owned {
            use varin_runtime::catalog::goals::*;
            let prepared =
                f.db.prepare_goal_start(
                    "goal",
                    &f.run,
                    GoalScope {
                        thread_id: "thread".into(),
                        branch_id: "branch".into(),
                    },
                    "Observe process result".into(),
                    None,
                )
                .unwrap()
                .load()
                .unwrap();
            f.db.admit_goal_mutation(prepared).unwrap();
        }
        f.register();
        f.state(RunState::Completed);
        let original = f.db.run(&f.run).unwrap();
        let capture =
            f.db.cancel_tree(TreeCancelTarget::Thread {
                thread_id: "thread".into(),
            })
            .unwrap();
        assert_eq!(capture.receipt.run_count, 1);
        assert_eq!(f.db.run(&f.run).unwrap(), original);
        assert_eq!(
            f.db.followup("authorization").unwrap().state,
            FollowupState::Cancelled
        );
        f.terminal(true);
        assert!(f.reconcile().is_empty());
        let mut f = f.reopen();
        assert!(f.reconcile().is_empty());
        f.cleanup();
    }
}

fn at(f: &mut Fixture, key: &str, instant: u64, text: &str) -> Followup {
    let p =
        f.db.prepare_followup_registration(
            key,
            &f.run,
            FollowupRegistration {
                trigger: FollowupRegistrationTrigger::At { at_ms: instant },
                instruction: text.into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_followup_registration(p).unwrap().followup
}
#[test]
fn explicit_instants_deliver_once_while_thread_process_is_running_and_cancel_only_queued_work() {
    let mut f = Fixture::new();
    let first = at(&mut f, "first", 0, "Check the still-running job once");
    let second = at(&mut f, "second", 0, "A separate check");
    assert_eq!(first.wait.state, NextRunWaitState::Observed);
    assert!(first.observation.is_none());
    assert_eq!(first.actor, FollowupActor::User);
    assert_eq!(
        at(&mut f, "first", 0, "Check the still-running job once").id,
        first.id
    );
    assert!(f
        .db
        .prepare_followup_registration(
            "first",
            &f.run,
            FollowupRegistration {
                trigger: FollowupRegistrationTrigger::At { at_ms: 1 },
                instruction: "Check the still-running job once".into(),
                wait: None
            }
        )
        .unwrap()
        .load()
        .and_then(|p| f.db.admit_followup_registration(p))
        .is_err());
    assert!(f.reconcile().is_empty());
    assert_eq!(
        f.db.operation(&f.process).unwrap().phase,
        OperationPhase::Running
    );
    let queued = f.db.followup(&second.id).unwrap();
    assert_eq!(
        queued
            .occurrence
            .as_ref()
            .unwrap()
            .delivery
            .as_ref()
            .unwrap()
            .state,
        InputState::Queued
    );
    f.db.control_followup(&second.id, queued.revision, FollowupControlAction::Cancel)
        .unwrap();
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
        panic!("text")
    };
    assert!(text.contains("Check the still-running job once"));
    assert_eq!(
        f.db.followup("first").unwrap().wait.state,
        NextRunWaitState::Consumed
    );
    assert_eq!(
        f.db.followup("second").unwrap().state,
        FollowupState::Cancelled
    );
    assert!(!f.db.run(&f.run).unwrap().cancel_requested);
    assert!(f.reconcile().is_empty());
    f.cleanup();
}
#[test]
fn paused_due_instant_is_observed_off_deadline_then_reopens_without_busy_retry() {
    let mut f = Fixture::new();
    let now = varin_runtime::catalog::observations::wall_time_ms().unwrap();
    let registered = at(&mut f, "later", now + 60_000, "Inspect later");
    f.db.control_followup(
        &registered.id,
        registered.revision,
        FollowupControlAction::Pause,
    )
    .unwrap();
    assert_eq!(
        f.db.nearest_followup_deadline().unwrap(),
        Some(now + 60_000)
    );
    f.db.reconcile_followup_facts_at(now + 60_000).unwrap();
    assert_eq!(f.db.nearest_followup_deadline().unwrap(), None);
    let paused = f.db.followup("later").unwrap();
    assert_eq!(paused.wait.state, NextRunWaitState::Observed);
    assert_eq!(
        paused.occurrence.unwrap().hold_reason,
        Some(HoldReason::ControlPaused)
    );
    f.state(RunState::Completed);
    let mut f = f.reopen();
    assert!(f.reconcile().is_empty());
    let original = f.db.operation(&f.process).unwrap();
    assert_eq!(original.outcome, Some(Outcome::Indeterminate));
    assert_eq!(original.effect, Effect::Unknown);
    assert!(!original
        .external_receipt
        .as_ref()
        .is_some_and(|r| r.executor_stopped));
    let paused = f.db.followup("later").unwrap();
    f.db.control_followup("later", paused.revision, FollowupControlAction::Resume)
        .unwrap();
    let next = f.reconcile();
    assert_eq!(next.len(), 1);
    assert_ne!(next[0], f.run);
    assert_eq!(
        f.db.followup("later").unwrap().wait.state,
        NextRunWaitState::Consumed
    );
    assert_eq!(f.db.operation(&f.process).unwrap(), original);
    assert!(f.db.pending_run_operations(&next[0]).unwrap().is_empty());
    assert!(f.reconcile().is_empty());
    f.cleanup();
}
#[test]
fn late_cancelled_worker_does_not_revoke_user_intent_accepted_after_stop() {
    let mut f = Fixture::new();
    let old = at(&mut f, "old", u64::from(4_000_000_000u32), "Old check");
    f.db.request_cancel_run(&f.run).unwrap();
    assert_eq!(
        f.db.followup(&old.id).unwrap().state,
        FollowupState::Cancelled
    );
    let new = at(&mut f, "after-stop", 0, "New explicit check after Stop");
    f.state(RunState::Cancelled);
    assert_eq!(f.db.followup(&new.id).unwrap().state, FollowupState::Active);
    assert_eq!(f.reconcile().len(), 1);
    f.cleanup();
}
#[test]
fn unreadable_instruction_returns_original_error_after_delivering_independent_due_work() {
    let mut f = Fixture::new();
    at(&mut f, "broken", 0, "Damaged retained instruction");
    at(&mut f, "healthy", 0, "Healthy retained instruction");
    use sha2::Digest;
    let hash = format!(
        "sha256-{}",
        hex::encode(sha2::Sha256::digest(
            serde_json::to_vec(&json!("Damaged retained instruction")).unwrap()
        ))
    );
    let path = varin_runtime::content::object_path(&f.root.join("content"), &hash).unwrap();
    std::fs::write(&path, b"corrupt").unwrap();
    let owner = std::sync::Mutex::new(f.db);
    assert!(varin_runtime::catalog::followups::reconcile(&owner).is_err());
    f.db = owner.into_inner().unwrap();
    assert_eq!(
        f.db.followup("broken")
            .unwrap()
            .occurrence
            .unwrap()
            .hold_reason,
        Some(HoldReason::PreparationFailed)
    );
    assert!(f
        .db
        .followup("healthy")
        .unwrap()
        .occurrence
        .unwrap()
        .delivery
        .is_some());
    assert_eq!(f.db.nearest_followup_deadline().unwrap(), None);
    f.cleanup();
}

fn report_dependency(f: &mut Fixture, request: &str, wait: Option<String>) {
    use varin_runtime::catalog::goals::*;
    let launch = f.db.launch_intent(&f.run).unwrap().unwrap().selection;
    let range = HistoryRange {
        branch_id: "branch".into(),
        ancestor_id: None,
        leaf_id: f.db.head("branch").unwrap(),
    };
    let call = ToolCall {
        call_id: "report".into(),
        name: REPORT_TOOL.into(),
        schema_version: "1".into(),
        arguments: json!({"state":"blocked","reason":"Original process is still producing results","waitOperationId":wait}),
    };
    let context = ToolExecutionContext {
        run_id: f.run.clone(),
        operation_id: format!("{request}:tool:report"),
        origin: ToolOrigin::ModelStep {
            request_id: request.into(),
        },
    };
    let binding = RequestBinding {
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
        history_range: range.clone(),
    };
    f.record(ExecutionRecord::RequestPrepared {
        snapshot: RequestSnapshot {
            view: RequestView {
                request_id: request.into(),
                run_id: f.run.clone(),
                origin: RequestOrigin::Conversation {
                    step: 2,
                    history_range: range,
                },
                binding,
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
            id: request.into(),
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
                name: REPORT_TOOL.into(),
                schema_version: "1".into(),
                read_only: false,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![],
            },
        },
    });
    f.record(ExecutionRecord::ToolDispatched {
        context: context.clone(),
        executor_owner: ExecutorOwner::Kernel,
    });
    let p = f.db.prepare_goal_report(&context).unwrap().load().unwrap();
    let completion = f.db.admit_goal_report(p).unwrap();
    f.record(ExecutionRecord::ToolBatchCommitted {
        request_id: request.into(),
        results: vec![ToolResult {
            request_id: request.into(),
            call_id: "report".into(),
            completion,
        }],
    });
}
#[test]
fn one_explicit_check_enters_original_dependency_goal_without_clearing_subscription_or_renewing_permission(
) {
    use varin_runtime::catalog::goals::*;
    let mut f = Fixture::new();
    let scope = GoalScope {
        thread_id: "thread".into(),
        branch_id: "branch".into(),
    };
    let p =
        f.db.prepare_goal_start(
            "dependency-goal",
            &f.run,
            scope.clone(),
            "Observe the actual job".into(),
            None,
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_goal_mutation(p).unwrap();
    let process = f.process.clone();
    report_dependency(&mut f, "blocked-report", Some(process.clone()));
    let before =
        f.db.capture_goal("dependency-goal")
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(before.blocked_reason, Some(GoalBlockReason::Dependency));
    f.state(RunState::Completed);
    at(
        &mut f,
        "check-dependency",
        0,
        "Inspect the unfinished job once",
    );
    let runs = f.reconcile();
    assert_eq!(runs.len(), 1);
    let next = runs[0].clone();
    let after =
        f.db.capture_goal("dependency-goal")
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(after.blocked_reason, Some(GoalBlockReason::Dependency));
    assert_eq!(
        after.dependency_operation_id.as_deref(),
        Some(process.as_str())
    );
    assert_eq!(after.generation, before.generation);
    assert!(f.db.require_process_observation(&next, &process).is_ok());
    assert_eq!(
        f.db.goal_binding(&next).unwrap().unwrap().generation,
        before.generation
    );
    assert!(matches!(
        f.db.goal_boundary(&next, f.db.epoch()).unwrap(),
        GoalBoundary::Continue
    ));
    f.run = next;
    f.state(RunState::Runnable);
    // A real new goal_report invalidates the consumed check's frozen generation.
    report_dependency(&mut f, "new-report", None);
    assert!(matches!(
        f.db.goal_boundary(&f.run, f.db.epoch()).unwrap(),
        GoalBoundary::Finish {
            state: RunState::Completed
        }
    ));
    f.state(RunState::Completed);
    assert!(f.reconcile().is_empty());
    let current =
        f.db.capture_goal("dependency-goal")
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(current.blocked_reason, Some(GoalBlockReason::Reported));
    assert!(f.db.followups("thread").unwrap().iter().any(|v| matches!(
        v.actor,
        FollowupActor::Goal { .. }
    ) && matches!(&v.trigger, FollowupTrigger::ProcessStopped { operation_id } if operation_id == &process)
        && v.wait.state == NextRunWaitState::Waiting));
    f.cleanup();
}

#[path = "fixtures/followup_conditions.rs"]
mod conditions;
