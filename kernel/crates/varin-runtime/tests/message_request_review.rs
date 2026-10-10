//! Real queue/submission/Wait ownership. Provider and physical source consumers have separate tests.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::{
    catalog::{dispatch::TreeCancelTarget, messages::activation::*, messages::*},
    execution::*,
    *,
};
fn send(f: &mut Fixture, key: &str) -> MessageReceipt {
    let child = f.db.child_task(&f.context.operation_id).unwrap();
    let p =
        f.db.prepare_user_message(
            key.into(),
            child.child_thread_id,
            child.child_branch_id,
            MessageInput {
                target_thread_id: Some("thread:parent".into()),
                target_branch_id: Some("branch:parent".into()),
                reply_to: None,
                kind: MessageKind::Request,
                text: "please act on this exact request".into(),
            },
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_message(p).unwrap().receipt
}
fn finish(f: &mut Fixture, state: RunState) {
    f.db.commit_execution(
        &f.context.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state,
            waiting_on: None,
        },
    )
    .unwrap();
}
fn view(db: &Catalog, receipt: &MessageReceipt) -> MessageView {
    db.capture_message(
        "thread:parent",
        "branch:parent",
        &receipt.identity.message_id,
    )
    .unwrap()
    .load()
    .unwrap()
}
fn candidate(db: &mut Catalog) -> PreparedRequestActivation {
    db.capture_request_activations()
        .unwrap()
        .pop()
        .unwrap()
        .load()
        .unwrap()
}
#[test]
fn active_request_binds_once_joins_closed_boundary_and_cancel_cannot_reopen_it() {
    let mut f = Fixture::new();
    f.accept();
    f.settle_exchange();
    let msg = send(&mut f, "active");
    assert!(
        matches!(view(&f.db,&msg).summary.activation,MessageActivation::Bound{ref run_id,..} if run_id==&f.context.run_id)
    );
    assert!(view(&f.db, &msg).summary.delivered_run_id.is_none());
    assert!(matches!(
        f.db.commit_execution(
            &f.context.run_id,
            f.db.epoch(),
            &ExecutionRecord::StateChanged {
                state: RunState::Completed,
                waiting_on: None
            }
        ),
        Err(RuntimeError::InputPending)
    ));
    let head = f.db.head("branch:parent").unwrap();
    let delivery =
        f.db.prepare_input_delivery(&f.context.run_id, f.db.epoch(), head.as_deref())
            .unwrap()
            .load()
            .unwrap();
    f.db.request_cancel_run(&f.context.run_id).unwrap();
    assert!(f.db.admit_input_delivery(delivery).is_err());
    let late = send(&mut f, "accepted-after-stop");
    assert!(matches!(
        view(&f.db, &late).summary.activation,
        MessageActivation::Pending {
            execution_id: None,
            ..
        }
    ));
    assert!(f.db.capture_request_activations().unwrap().is_empty());
    assert!(matches!(
        view(&f.db, &late).summary.activation,
        MessageActivation::Pending {
            execution_id: None,
            ..
        }
    ));
    finish(&mut f, RunState::Cancelled);
    assert_eq!(view(&f.db, &msg).summary.state, InputState::Cancelled);
    assert_eq!(send(&mut f, "active"), msg);
    let root = f.root.clone();
    drop(f);
    let mut db = Catalog::open(&root).unwrap();
    let prepared = candidate(&mut db);
    let RequestActivationAdmission::Bound(run) = db.admit_request_activation(prepared).unwrap()
    else {
        panic!("the later accepted intent gets its own Run")
    };
    assert_eq!(view(&db, &late).summary.delivered_run_id, Some(run));
    assert_eq!(view(&db, &msg).summary.state, InputState::Cancelled);
    assert!(db.capture_request_activations().unwrap().is_empty());
    assert_eq!(view(&db, &msg).text, "please act on this exact request");
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn idle_root_reopen_admits_one_actual_new_run_from_exact_launch_and_history() {
    for materialized in [false, true] {
        let mut f = Fixture::new();
        f.accept();
        f.settle_exchange();
        finish(&mut f, RunState::Completed);
        if materialized {
            let previous = f.db.run(&f.context.run_id).unwrap();
            let mut launch = f.db.launch_intent(&previous.id).unwrap().unwrap().selection;
            let source = launch.source.as_mut().unwrap();
            source.mode = SourceMode::Materialized;
            source.environment_run_id = None;
            let source = launch.source.clone();
            let basis=serde_json::from_value::<catalog::personalization::PersonalizationBasis>(json!({"mode":"agent","threadRole":"main","revision":1,"configurationDigest":"materialized-main","memorySnapshot":{"revision":0,"memories":[]},"sessionId":"thread:parent","projectId":null,"originalSections":[{"name":"system","content":"Root source context"}],"instructionSources":[]})).unwrap();
            let resources=serde_json::from_value(json!({"source":source,"snapshot":{"id":"materialized-resources","scope":{"threadId":"thread:parent","branchId":"branch:parent","mode":"agent","threadRole":"main","projectId":null,"sourceIdentity":"materialized-owned","cwd":"/frozen","projectTrusted":false,"projectRoot":null},"readers":[],"project":null,"configurationDigest":"materialized-main","shadowedContextCanonicalIds":[],"system":null,"appendSystem":null,"instructions":[],"instructionScopes":[],"skills":[],"diagnostics":[],"capturedFiles":[],"observations":[]}})).unwrap();
            let proposal = catalog::context::ContextProposal {
                key: "materialized-context".into(),
                branch_id: "branch:parent".into(),
                through_id: None,
                expected_revision: 0,
                summary: String::new(),
                effective_system_prompt: "Root source context".into(),
                instruction_sources: vec![],
                memory_checkpoint: None,
            };
            let command = SubmitInput {
                key: "materialized-root".into(),
                thread_id: "thread:parent".into(),
                branch_id: "branch:parent".into(),
                expected_head: f.db.head("branch:parent").unwrap(),
                input: json!("Continue in the materialized source"),
                configuration: previous.configuration,
            };
            let preparation =
                f.db.prepare_submission(command, Some(proposal), Some(basis))
                    .unwrap()
                    .with_resources(Some(resources))
                    .load(Some(launch), false)
                    .unwrap();
            let run = f.db.admit_submission(preparation).unwrap();
            f.context.run_id = run.run_id;
            f.db.commit_execution(
                &f.context.run_id,
                f.db.epoch(),
                &ExecutionRecord::StateChanged {
                    state: RunState::Runnable,
                    waiting_on: None,
                },
            )
            .unwrap();
            finish(&mut f, RunState::Completed);
            let context = f.db.active_context("branch:parent").unwrap().unwrap();
            assert_eq!(
                context
                    .resources
                    .unwrap()
                    .source
                    .unwrap()
                    .environment_run_id
                    .as_deref(),
                Some(f.context.run_id.as_str())
            );
        }
        let original = f.db.launch_intent(&f.context.run_id).unwrap().unwrap();
        let msg = send(&mut f, "idle");
        let old = f.context.run_id.clone();
        let root = f.root.clone();
        drop(f);
        let mut db = Catalog::open(&root).unwrap();
        let prepared = candidate(&mut db);
        let RequestActivationAdmission::Bound(run) = db.admit_request_activation(prepared).unwrap()
        else {
            panic!("new Run")
        };
        assert_ne!(run, old);
        assert_eq!(db.run(&old).unwrap().state, RunState::Completed);
        assert!(db.capture_request_activations().unwrap().is_empty());
        let current = db.launch_intent(&run).unwrap().unwrap();
        let mut expected = original.selection.clone();
        if materialized {
            expected.source.as_mut().unwrap().environment_run_id = Some(old.clone());
        }
        assert_eq!(current.selection, expected);
        assert_eq!(current.policy_target, original.policy_target);
        let message = view(&db, &msg);
        assert_eq!(message.summary.delivered_run_id, Some(run.clone()));
        let history = db.history("branch:parent").unwrap();
        assert_eq!(history.last().unwrap().id, msg.identity.message_id);
        assert_eq!(history.last().unwrap().run_id, run);
        assert!(matches!(
            db.execution_history("branch:parent")
                .unwrap()
                .last()
                .unwrap()
                .provenance,
            Provenance::UserInstruction { .. }
        ));
        drop(db);
        let mut db = Catalog::open(&root).unwrap();
        assert!(db.capture_request_activations().unwrap().is_empty());
        assert_eq!(view(&db, &msg).summary.delivered_run_id, Some(run));
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn staged_idle_candidate_loses_to_real_user_run_and_tree_cancel_fences_unbound() {
    let mut f = Fixture::new();
    f.accept();
    f.settle_exchange();
    finish(&mut f, RunState::Completed);
    let msg = send(&mut f, "race");
    let prepared = candidate(&mut f.db);
    let user =
        f.db.enqueue_input(&catalog::inputs::EnqueueInput {
            key: "new-user".into(),
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
            mode: InputMode::Boundary,
            input: json!("actual User input"),
            configuration: None,
        })
        .unwrap();
    assert_eq!(
        f.db.admit_request_activation(prepared).unwrap(),
        RequestActivationAdmission::Stale
    );
    assert!(
        matches!(view(&f.db,&msg).summary.activation,MessageActivation::Bound{run_id,..} if run_id==user.run_id)
    );
    f.db.request_cancel_run(&user.run_id).unwrap();
    f.db.transition_run(
        &user.run_id,
        f.db.epoch(),
        f.db.run(&user.run_id).unwrap().revision,
        RunState::Cancelled,
    )
    .unwrap();
    let next = send(&mut f, "tree");
    let late = candidate(&mut f.db);
    f.db.cancel_tree(TreeCancelTarget::Thread {
        thread_id: "thread:parent".into(),
    })
    .unwrap();
    assert_eq!(
        f.db.admit_request_activation(late).unwrap(),
        RequestActivationAdmission::Stale
    );
    assert!(matches!(
        view(&f.db, &next).summary.activation,
        MessageActivation::Cancelled { run_id: None, .. }
    ));
    assert!(f.db.capture_request_activations().unwrap().is_empty());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn request_ends_original_child_observation_only_then_resumes_same_run_after_reopen() {
    for observation_state in ["live", "partial", "triggered"] {
        let mut f = Fixture::new();
        let child = f.accept();
        f.settle_exchange();
        let waits = f.admit_waits("request", 2);
        if observation_state == "triggered" {
            // A real terminal child report precedes reconciliation of its Wait events.
            f.db.fail_child_preparation(&child.execution_id, "completed child failure")
                .unwrap();
            f.db.settle_child_receipts().unwrap();
        }
        let msg = send(&mut f, "wait");
        let run = f.context.run_id.clone();
        if observation_state == "partial" {
            // The first original cancellation committed, then the process stopped before the
            // remaining observation was cancelled. Reopen must finish that same input boundary.
            f.db.request_cancel_child_wait(&waits[0].id).unwrap();
            assert!(!f.db.inspect_child_wait(&waits[1].id).unwrap().cancelled);
        } else if observation_state == "live" {
            assert!(f.db.interrupt_request_observations().unwrap());
            for wait in &waits {
                assert!(f.db.inspect_child_wait(&wait.id).unwrap().cancelled);
            }
        }
        assert!(
            !f.db
                .delegated_execution(&child.execution_id)
                .unwrap()
                .cancel_requested
        );
        let root = f.root.clone();
        drop(f);
        let owner = supervisor::RunSupervisor::new(Catalog::open(&root).unwrap());
        owner.reconcile_message_requests().unwrap();
        let catalog = owner.catalog();
        let mut db = catalog.lock().unwrap();
        assert_eq!(db.run(&run).unwrap().state, RunState::Runnable);
        assert!(db.run(&run).unwrap().waiting_on.is_none());
        assert!(db.pending_child_wait(&run).unwrap().is_none());
        let history = db.history("branch:parent").unwrap();
        for wait in &waits {
            let was_cancelled = db.inspect_child_wait(&wait.id).unwrap().cancelled;
            if observation_state == "triggered" {
                assert!(
                    !was_cancelled,
                    "a committed result keeps its original observation"
                );
                assert_eq!(
                    db.operation(wait.id.strip_prefix("child-wait:").unwrap())
                        .unwrap()
                        .outcome,
                    Some(Outcome::Succeeded)
                );
            } else {
                assert!(was_cancelled);
                assert!(history
                    .iter()
                    .any(|item| item.id == format!("child-wait-cancel:{}", wait.id)));
            }
        }
        let head = db.head("branch:parent").unwrap();
        let p = db
            .prepare_input_delivery(&run, db.epoch(), head.as_deref())
            .unwrap()
            .load()
            .unwrap();
        assert!(db.admit_input_delivery(p).unwrap().unwrap().activating);
        assert_eq!(view(&db, &msg).summary.delivered_run_id, Some(run));
        assert!(
            !db.delegated_execution(&child.execution_id)
                .unwrap()
                .cancel_requested
        );
        drop(db);
        drop(catalog);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn request_preserves_real_manual_pause_and_unanswered_question_across_reopen() {
    for question in [false, true] {
        let schema = |name: &str| ToolSchema {
            name: name.into(),
            version: "1".into(),
            description: String::new(),
            schema: json!({"type":"object"}),
            output_schema: None,
            metadata: None,
        };
        let mut f = Fixture::new_extended_parent_with_schemas(
            schema("file_read"),
            schema("dispatch"),
            schema("ask_user"),
        );
        f.accept();
        f.settle_exchange();
        let run = f.context.run_id.clone();
        let wait = if question {
            let call = f.admit_policy_call(ToolCall {
                call_id: "question".into(),
                name: "ask_user".into(),
                schema_version: "1".into(),
                arguments: json!({"question":"A real unanswered question"}),
            });
            let wait = f.db.open_question(&call).unwrap();
            f.settle_policy_call(&call, "awaiting_user");
            f.db.commit_execution(
                &run,
                f.db.epoch(),
                &ExecutionRecord::StateChanged {
                    state: RunState::Waiting,
                    waiting_on: Some(wait.clone()),
                },
            )
            .unwrap();
            wait
        } else {
            f.db.commit_execution(
                &run,
                f.db.epoch(),
                &ExecutionRecord::StateChanged {
                    state: RunState::Runnable,
                    waiting_on: None,
                },
            )
            .unwrap();
            let boundary = f.db.policy_boundary(&run, f.db.epoch()).unwrap();
            let intent = PolicyControlIntent {
                action_id: format!("{run}:policy:{}", boundary.id),
                boundary,
                identity: f.db.launch_intent(&run).unwrap().unwrap().selection.policy,
                state: json!({"paused":true}),
                expected_head: f.db.head("branch:parent").unwrap(),
                action: PolicyAction::Pause {
                    reason: "Wait for explicit resume".into(),
                },
            };
            let prepared = f.db.prepare_policy_control().load(&intent).unwrap();
            let PolicyControlReceipt::Paused { wait_id, .. } =
                f.db.commit_policy_control(&run, f.db.epoch(), prepared)
                    .unwrap()
            else {
                panic!("pause")
            };
            wait_id
        };
        let message = send(&mut f, "held");
        let root = f.root.clone();
        drop(f);
        let owner = supervisor::RunSupervisor::new(Catalog::open(&root).unwrap());
        owner.reconcile_message_requests().unwrap();
        let catalog = owner.catalog();
        let db = catalog.lock().unwrap();
        assert_eq!(db.run(&run).unwrap().waiting_on, Some(wait));
        let expected = if question {
            MessageActivationHold::Question
        } else {
            MessageActivationHold::ManualPause
        };
        assert!(
            matches!(view(&db,&message).summary.activation,MessageActivation::Bound{hold_reason:Some(reason),..} if reason==expected)
        );
        assert_eq!(view(&db, &message).summary.state, InputState::Queued);
        drop(db);
        assert!(owner
            .prepare_start(&run, |_| panic!("request cannot bypass blocker"))
            .is_err());
        drop(catalog);
        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn idle_request_obeys_goal_budget_then_new_owner_can_activate_after_explicit_removal() {
    use varin_runtime::catalog::goals::*;
    let mut f = Fixture::new();
    f.accept();
    f.settle_exchange();
    let scope = GoalScope {
        thread_id: "thread:parent".into(),
        branch_id: "branch:parent".into(),
    };
    let prepared =
        f.db.prepare_goal_start(
            "bounded-goal",
            &f.context.run_id,
            scope.clone(),
            "Explicit bounded work".into(),
            Some(GoalBudget {
                max_output_tokens: 0,
            }),
        )
        .unwrap()
        .load()
        .unwrap();
    let goal = f.db.admit_goal_mutation(prepared).unwrap();
    finish(&mut f, RunState::Completed);
    let message = send(&mut f, "goal-held");
    assert!(f.db.capture_request_activations().unwrap().is_empty());
    assert!(matches!(
        view(&f.db, &message).summary.activation,
        MessageActivation::Pending {
            hold_reason: Some(MessageActivationHold::GoalBlocked),
            ..
        }
    ));
    f.db.control_goal(&goal.id, goal.revision, &scope, GoalControlAction::Complete)
        .unwrap();
    let prepared = candidate(&mut f.db);
    let RequestActivationAdmission::Bound(run) = f.db.admit_request_activation(prepared).unwrap()
    else {
        panic!("new request")
    };
    assert!(f.db.goal_binding(&run).unwrap().is_none());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
