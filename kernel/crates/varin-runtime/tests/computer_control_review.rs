//! Original Catalog input, history and continuation boundaries for trusted desktop facts.
#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/computer_requests.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use varin_runtime::{
    catalog::{
        activation::RequestActivationAdmission, computer_events::*,
        computer_requests::ComputerExecution, dispatch::TreeCancelTarget,
    },
    execution::*,
    *,
};

fn command(f: &Fixture, kind: ComputerEventKind, child: bool) -> ComputerEventCommand {
    let run = f
        .base
        .db
        .run(if child { &f.child_run } else { &f.parent_run })
        .unwrap();
    ComputerEventCommand {
        fact: ComputerEventFact {
            id: "original-control".into(),
            kind,
            desktop_id: "desktop".into(),
            execution: ComputerExecution {
                thread_id: run.thread_id,
                branch_id: run.branch_id,
                run_id: run.id,
            },
            at: "2026-10-11T10:00:00Z".into(),
            release_confirmed: true,
        },
        label: "Original desktop".into(),
    }
}
fn accept(f: &mut Fixture, command: ComputerEventCommand) -> ComputerEventReceipt {
    let prepared = f
        .base
        .db
        .prepare_computer_event(command)
        .unwrap()
        .load()
        .unwrap();
    f.base.db.admit_computer_event(prepared).unwrap()
}
fn finish(f: &mut Fixture, child: bool) {
    let id = if child {
        f.child_run.clone()
    } else {
        f.parent_run.clone()
    };
    f.base
        .db
        .commit_execution(
            &id,
            f.base.db.epoch(),
            &ExecutionRecord::StateChanged {
                state: RunState::Completed,
                waiting_on: None,
            },
        )
        .unwrap();
}
fn delivery(f: &mut Fixture, run: &str) -> Option<InputBatch> {
    let run = f.base.db.run(run).unwrap();
    let prepared = f
        .base
        .db
        .prepare_input_delivery(
            &run.id,
            f.base.db.epoch(),
            f.base.db.head(&run.branch_id).unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    f.base.db.admit_input_delivery(prepared).unwrap()
}
#[test]
fn control_facts_use_stable_kind_identity_environment_history_and_passive_root_fanout() {
    let mut f = Fixture::new();
    let takeover = command(&f, ComputerEventKind::Takeover, true);
    let receipt = accept(&mut f, takeover.clone());
    assert_eq!(receipt, accept(&mut f, takeover.clone()));
    let mut conflict = takeover.clone();
    conflict.label = "Changed original body".into();
    let conflict = f
        .base
        .db
        .prepare_computer_event(conflict)
        .unwrap()
        .load()
        .unwrap();
    assert!(f.base.db.admit_computer_event(conflict).is_err());
    content_collection::collect(|| f.base.db.prepare_content_collection(Default::default()))
        .unwrap();
    assert_eq!(receipt.input_ids.len(), 2);
    for run in [f.parent_run.clone(), f.child_run.clone()] {
        let delivered = delivery(&mut f, &run).unwrap();
        assert!(!delivered.activating);
        assert!(
            matches!(&delivered.items[0].provenance, Provenance::EnvironmentFact { event_id } if event_id == &receipt.event_id)
        );
    }
    let handback = command(&f, ComputerEventKind::Handback, true);
    let second = accept(&mut f, handback);
    assert_ne!(receipt.event_id, second.event_id);
    let child = f.child_run.clone();
    assert!(delivery(&mut f, &child).unwrap().activating);
    let parent = f.parent_run.clone();
    assert!(!delivery(&mut f, &parent).unwrap().activating);
    f.cleanup();
}
#[test]
fn idle_root_handback_uses_original_launch_and_lost_ack_reopen_is_idempotent() {
    let mut f = Fixture::new();
    let parent = f.base.db.run(&f.parent_run).unwrap();
    let mut auxiliary_launch = f
        .base
        .db
        .launch_intent(&parent.id)
        .unwrap()
        .unwrap()
        .selection;
    auxiliary_launch.extension_bindings.clear();
    auxiliary_launch.child_dispatch = None;
    auxiliary_launch.tools.clear();
    let auxiliary = f
        .base
        .db
        .create_context_job(
            varin_runtime::context_job::ContextJobRequest {
            compaction: None,
            summary_recipe: varin_runtime::context_job::ContextSummaryRecipe::manual(),
                owner_run_id: None,
                personalization: None,
                key: "handback-auxiliary".into(),
                branch_id: parent.branch_id.clone(),
                through_id: f.base.db.head(&parent.branch_id).unwrap().unwrap(),
                expected_revision: 0,
                effective_system_prompt: "Summarize".into(),
                instruction_sources: vec![],
                memory_checkpoint: None,
            },
            auxiliary_launch,
            serde_json::json!({}),
        )
        .unwrap();
    let auxiliary_run = f.base.db.run(&auxiliary.receipt.run_id).unwrap();
    assert!(!auxiliary_run.state.terminal());
    assert_ne!(auxiliary_run.thread_id, parent.thread_id);
    assert_ne!(auxiliary_run.branch_id, parent.branch_id);
    assert_eq!(auxiliary.request.branch_id, parent.branch_id);
    finish(&mut f, false);
    let event = command(&f, ComputerEventKind::Handback, false);
    let receipt = accept(&mut f, event.clone());
    let root = f.base.root.clone();
    drop(f.base.db);
    f.base.db = Catalog::open(&root).unwrap();
    assert_eq!(receipt, accept(&mut f, event));
    let candidates = f.base.db.capture_request_activations().unwrap();
    assert_eq!(candidates.len(), 1);
    let prepared = candidates.into_iter().next().unwrap().load().unwrap();
    let RequestActivationAdmission::Bound(run) =
        f.base.db.admit_request_activation(prepared).unwrap()
    else {
        panic!("real root Run")
    };
    assert_ne!(run, f.parent_run);
    assert_eq!(f.base.db.run(&run).unwrap().state, RunState::Accepted);
    assert!(
        !f.base
            .db
            .launch_intent(&run)
            .unwrap()
            .unwrap()
            .policy_preparable,
        "handback keeps the original frozen policy"
    );
    let history = f.base.db.history("branch:parent").unwrap();
    assert!(history
        .iter()
        .any(|item| item.run_id == run && item.source == HistorySource::Environment));
    assert!(f.base.db.capture_request_activations().unwrap().is_empty());
    f.cleanup();
}
#[test]
fn tree_stop_fences_late_outbox_and_prepared_terminal_root_without_changing_outcome() {
    for before_accept in [false, true] {
        let mut f = Fixture::new();
        finish(&mut f, false);
        let event = command(&f, ComputerEventKind::Handback, false);
        let prepared = if before_accept {
            None
        } else {
            accept(&mut f, event.clone());
            Some(
                f.base
                    .db
                    .capture_request_activations()
                    .unwrap()
                    .pop()
                    .unwrap()
                    .load()
                    .unwrap(),
            )
        };
        f.base
            .db
            .cancel_tree(TreeCancelTarget::Thread {
                thread_id: "thread:parent".into(),
            })
            .unwrap();
        assert_eq!(
            f.base.db.run(&f.parent_run).unwrap().state,
            RunState::Completed
        );
        if let Some(prepared) = prepared {
            assert!(matches!(
                f.base.db.admit_request_activation(prepared).unwrap(),
                RequestActivationAdmission::Stale
            ));
        } else {
            accept(&mut f, event);
        }
        assert!(f.base.db.capture_request_activations().unwrap().is_empty());
        f.cleanup();
    }
}
#[test]
fn exact_computer_stop_precedes_body_acceptance_and_does_not_cancel_new_control_lifecycle() {
    let mut f = Fixture::new();
    finish(&mut f, false);
    let event = command(&f, ComputerEventKind::Handback, false);
    let prepared = f
        .base
        .db
        .prepare_computer_event(event.clone())
        .unwrap()
        .load()
        .unwrap();
    let stop = ComputerEventCancellation {
        id: "original-stop".into(),
        execution: event.fact.execution.clone(),
        desktop_id: event.fact.desktop_id.clone(),
        pending_event_ids: vec![event.fact.id.clone()],
    };
    f.base.db.cancel_computer_events(stop.clone()).unwrap();
    f.base.db.admit_computer_event(prepared).unwrap();
    assert!(f.base.db.capture_request_activations().unwrap().is_empty());
    let mut fresh = event;
    fresh.fact.id = "new-control".into();
    accept(&mut f, fresh);
    f.base.db.cancel_computer_events(stop).unwrap();
    assert_eq!(
        f.base.db.capture_request_activations().unwrap().len(),
        1,
        "old Stop receipt cannot collect a future handback"
    );
    f.cleanup();
}
#[test]
fn handback_does_not_interrupt_an_unrelated_computer_request_wait() {
    let mut f = Fixture::new();
    let request = f.request(false);
    let operation = f.wait(&request, false);
    let event = command(&f, ComputerEventKind::Handback, true);
    accept(&mut f, event);
    assert!(!f.base.db.interrupt_request_observations().unwrap());
    assert_eq!(
        f.base.db.run(&f.child_run).unwrap().state,
        RunState::Waiting
    );
    let op = f.base.db.operation(&operation).unwrap();
    assert!(!op.cancel_requested);
    assert_eq!(
        f.base.db.pending_observation_wait(&f.child_run).unwrap(),
        op.waiting_on
    );
    f.cleanup();
}

#[test]
fn first_late_handback_is_passive_but_an_already_admitted_fact_binds_the_winning_user_run() {
    for event_first in [false, true] {
        let mut f = Fixture::new();
        finish(&mut f, false);
        let event = command(&f, ComputerEventKind::Handback, false);
        if event_first {
            accept(&mut f, event.clone());
        }
        let user = f
            .base
            .db
            .enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
                key: "fresh-user".into(),
                thread_id: "thread:parent".into(),
                branch_id: "branch:parent".into(),
                mode: InputMode::Boundary,
                input: serde_json::json!("New user work"),
                configuration: None,
            })
            .unwrap();
        if !event_first {
            accept(&mut f, event);
        }
        let delivered = delivery(&mut f, &user.run_id).unwrap();
        assert_eq!(delivered.activating, event_first);
        assert!(delivered
            .items
            .iter()
            .any(|item| matches!(item.provenance, Provenance::EnvironmentFact { .. })));
        assert!(f.base.db.capture_request_activations().unwrap().is_empty());
        f.cleanup();
    }
}
#[test]
fn handback_respects_explicit_goal_pause_and_ended_authority() {
    use varin_runtime::catalog::goals::*;
    for action in [
        GoalControlAction::Pause,
        GoalControlAction::Complete,
        GoalControlAction::Cancel,
    ] {
        let mut f = Fixture::new();
        let scope = GoalScope {
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
        };
        let prepared = f
            .base
            .db
            .prepare_goal_start(
                "goal",
                &f.parent_run,
                scope.clone(),
                "Explicit work".into(),
                None,
            )
            .unwrap()
            .load()
            .unwrap();
        f.base.db.admit_goal_mutation(prepared).unwrap();
        f.base.db.control_goal("goal", 1, &scope, action).unwrap();
        finish(&mut f, false);
        let event = command(&f, ComputerEventKind::Handback, false);
        accept(&mut f, event);
        assert!(f.base.db.capture_request_activations().unwrap().is_empty());
        assert_eq!(
            f.base.db.run(&f.parent_run).unwrap().state,
            RunState::Completed
        );
        f.cleanup();
    }
}
