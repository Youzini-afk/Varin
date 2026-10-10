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
            .register_followup("authorization", &self.run, &self.process)
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
                    ContinuationAdmission::Admitted(r) => runs.push(r.run_id),
                    ContinuationAdmission::Stale => stale = true,
                    ContinuationAdmission::Held => (),
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
fn stopped_process_starts_one_new_run_after_original_terminal_and_survives_launch_crash() {
    let mut f = Fixture::new();
    f.register();
    assert!(f.reconcile().is_empty());
    f.terminal(true);
    assert!(f.reconcile().is_empty());
    assert_eq!(
        f.db.followup("authorization")
            .unwrap()
            .occurrence
            .unwrap()
            .hold_reason,
        Some(HoldReason::SourceRunActive)
    );
    f.state(RunState::Completed);
    let old = f.db.run(&f.run).unwrap();
    let new = f.reconcile().pop().unwrap();
    assert_ne!(new, f.run);
    assert_eq!(f.db.run(&f.run).unwrap(), old);
    let occurrence = f.db.followup("authorization").unwrap().occurrence.unwrap();
    assert_eq!(occurrence.state, OccurrenceState::Admitted);
    let history = f.db.history("branch").unwrap();
    let item = history.last().unwrap();
    assert_eq!(item.source, HistorySource::Environment);
    let body: ConversationItem = serde_json::from_value(item.content.clone()).unwrap();
    assert!(matches!(
        body.provenance,
        Provenance::EnvironmentFact { .. }
    ));
    let Content::Text { text } = body.content else {
        panic!("typed process continuation text")
    };
    assert!(text.contains("process_read"));
    assert!(text.contains(&f.process));
    f.terminal(true);
    assert!(f.reconcile().is_empty());
    let mut f = f.reopen();
    assert!(f.reconcile().is_empty());
    assert_eq!(
        f.db.pending_launches()
            .unwrap()
            .iter()
            .filter(|launch| launch.run_id == new)
            .count(),
        1
    );
    assert_eq!(
        f.db.launch_intent(&new).unwrap().unwrap().selection.model,
        "original-model"
    );
    let run = f.db.run(&new).unwrap();
    let run =
        f.db.transition_run(&new, run.epoch, run.revision, RunState::Runnable)
            .unwrap();
    f.db.transition_run(&new, run.epoch, run.revision, RunState::Completed)
        .unwrap();
    assert_eq!(
        f.db.followup("authorization")
            .unwrap()
            .occurrence
            .unwrap()
            .state,
        OccurrenceState::Completed
    );
    assert!(f
        .db
        .control_followup("authorization", 0, FollowupControlAction::Cancel)
        .unwrap()
        .occurrence
        .unwrap()
        .receipt
        .is_some());
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
    f.terminal(true);
    assert_eq!(f.reconcile().len(), 1);
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
        .register_followup("authorization", &f.run, "different")
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
        .register_followup("new-authorization", &f.run, &f.process)
        .is_err());
    f.cleanup();
}

#[test]
fn concurrent_user_input_wins_and_continuation_uses_its_new_head_after_terminal() {
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
    let user =
        f.db.submit(&SubmitInput {
            key: "user-two".into(),
            thread_id: "thread".into(),
            branch_id: "branch".into(),
            expected_head: f.db.head("branch").unwrap(),
            input: json!("Additional user constraint"),
            configuration: json!({}),
        })
        .unwrap();
    assert_eq!(
        f.db.admit_followup_continuation(candidate).unwrap(),
        ContinuationAdmission::Held
    );
    assert!(f.reconcile().is_empty());
    let run = f.db.run(&user.run_id).unwrap();
    let run =
        f.db.transition_run(&run.id, run.epoch, run.revision, RunState::Runnable)
            .unwrap();
    f.db.transition_run(&run.id, run.epoch, run.revision, RunState::Completed)
        .unwrap();
    assert_eq!(f.reconcile().len(), 1);
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
