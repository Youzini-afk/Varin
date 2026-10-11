use super::files::{body, position, register_file_repeating, update, work};
use super::*;
fn file(path: &str) -> FollowupRegistrationSource {
    FollowupRegistrationSource::File {
        path: path.into(),
        condition: FileCondition::Changed,
    }
}
fn register(f: &mut Fixture, id: &str, trigger: FollowupRegistrationTrigger) -> Followup {
    register_file_repeating(
        f,
        id,
        trigger,
        body("baseline"),
        false,
        FollowupRepeat::Each,
    )
}
fn single(f: &mut Fixture, id: &str) -> Followup {
    register(
        f,
        id,
        FollowupRegistrationTrigger::File {
            path: "result".into(),
            condition: FileCondition::Changed,
        },
    )
}
fn edge(f: &mut Fixture, id: &str, index: usize, value: &str, sequence: u64) {
    let w = work(f, id, index);
    assert!(f
        .db
        .apply_file_observation(&w, update(&w, body(value), sequence, true, false))
        .unwrap());
}
fn occurrences(f: &Fixture, id: &str) -> Vec<FollowupOccurrence> {
    f.db.followup_occurrences(id, None).unwrap().occurrences
}
fn deliver(f: &mut Fixture) -> usize {
    f.reconcile();
    let p =
        f.db.prepare_input_delivery(
            &f.run,
            f.db.epoch(),
            f.db.head("branch").unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_input_delivery(p)
        .unwrap()
        .map_or(0, |d| d.items.len())
}
#[test]
fn accepted_file_edges_keep_old_preparation_and_queued_evidence_without_replaying_callbacks() {
    let mut f = Fixture::new();
    single(&mut f, "each");
    edge(&mut f, "each", 0, "one", 1);
    let first = occurrences(&f, "each").remove(0);
    let prepared =
        f.db.capture_followup_continuations()
            .unwrap()
            .remove(0)
            .load()
            .unwrap();
    edge(&mut f, "each", 0, "two", 2);
    assert!(matches!(
        f.db.admit_followup_continuation(prepared).unwrap(),
        ContinuationAdmission::Admitted(_)
    ));
    let w = work(&f, "each", 0);
    assert!(!w.release_required);
    f.db.apply_file_observation(&w, update(&w, body("two"), 2, true, false))
        .unwrap();
    assert_eq!(
        occurrences(&f, "each").len(),
        2,
        "a repeated callback is not another accepted edge"
    );
    let mut f = f.reopen();
    assert_eq!(deliver(&mut f), 2);
    assert_eq!(
        f.db.followup("each").unwrap().wait.state,
        NextRunWaitState::Waiting
    );
    assert_eq!(f.db.followup("each").unwrap().pending_occurrences, 0);
    edge(&mut f, "each", 0, "three", 3);
    assert_eq!(deliver(&mut f), 1);
    let history = occurrences(&f, "each");
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].id, first.id);
    assert_eq!(history[0].evidence, first.evidence);
    assert!(history
        .iter()
        .all(|o| o.delivery.as_ref().unwrap().state == InputState::Delivered));
    assert_eq!(f.db.followup("each").unwrap().generation, 1);
    f.cleanup();
}
#[test]
fn repeating_all_consumes_fifo_once_and_retains_unpaired_edges_across_restart() {
    let mut f = Fixture::new();
    register(
        &mut f,
        "all",
        FollowupRegistrationTrigger::All {
            sources: vec![file("a"), file("b")],
        },
    );
    edge(&mut f, "all", 0, "a1", 1);
    edge(&mut f, "all", 0, "a2", 2);
    assert!(occurrences(&f, "all").is_empty());
    let mut f = f.reopen();
    edge(&mut f, "all", 1, "b1", 3);
    let first = occurrences(&f, "all").remove(0);
    let TriggerEvidence::All { sources } = first.evidence else {
        panic!("All evidence")
    };
    assert!(
        matches!(&sources[0].evidence,FollowupLeafEvidence::File {state,..} if *state==body("a1"))
    );
    assert!(
        matches!(&sources[1].evidence,FollowupLeafEvidence::File {state,..} if *state==body("b1"))
    );
    let d = f.db.followup("all").unwrap();
    assert!(d.sources[0].observed.as_ref().unwrap().accepted_cursor > d.sources[0].consumed_cursor);
    edge(&mut f, "all", 1, "b2", 4);
    let history = occurrences(&f, "all");
    assert_eq!(history.len(), 2);
    assert!(history[0].accepted_cursor < history[1].accepted_cursor);
    let TriggerEvidence::All { sources } = &history[1].evidence else {
        panic!("All evidence")
    };
    assert!(
        matches!(&sources[0].evidence,FollowupLeafEvidence::File {state,..} if *state==body("a2"))
    );
    assert_eq!(deliver(&mut f), 2);
    f.db.reconcile_followup_facts_at(u64::MAX).unwrap();
    assert_eq!(occurrences(&f, "all").len(), 2);
    f.cleanup();
}
#[test]
fn repeating_pause_gap_and_cancel_preserve_delivered_history_and_fence_exact_reader() {
    let mut f = Fixture::new();
    single(&mut f, "control");
    edge(&mut f, "control", 0, "one", 1);
    assert_eq!(deliver(&mut f), 1);
    let delivered = occurrences(&f, "control").remove(0);
    edge(&mut f, "control", 0, "two", 2);
    f.reconcile();
    let d = f.db.followup("control").unwrap();
    let old = work(&f, "control", 0);
    f.db.control_followup("control", d.revision, FollowupControlAction::Pause)
        .unwrap();
    assert!(!f
        .db
        .apply_file_observation(&old, update(&old, body("unaccepted"), 3, true, false))
        .unwrap());
    assert_eq!(deliver(&mut f), 0);
    let d = f.db.followup("control").unwrap();
    f.db.control_followup("control", d.revision, FollowupControlAction::Resume)
        .unwrap();
    let w = work(&f, "control", 0);
    let mut reset = update(&w, body("two"), 0, true, false);
    reset.watch_id = Some("new-watch".into());
    reset.position = Some(position("new-source", 0));
    reset.gap = true;
    f.db.apply_file_observation(&w, reset).unwrap();
    assert_eq!(
        occurrences(&f, "control").len(),
        2,
        "gap and same snapshot do not manufacture missing edges"
    );
    let old = work(&f, "control", 0);
    let d = f.db.followup("control").unwrap();
    f.db.control_followup("control", d.revision, FollowupControlAction::Cancel)
        .unwrap();
    assert!(!f
        .db
        .apply_file_observation(&old, update(&old, body("late"), 1, true, false))
        .unwrap());
    let history = occurrences(&f, "control");
    assert_eq!(history[0], delivered);
    assert_eq!(history[1].state, OccurrenceState::Cancelled);
    assert_eq!(f.db.followup("control").unwrap().pending_occurrences, 0);
    assert!(
        f.db.followup_file_release_work(&old.key)
            .unwrap()
            .release_required
    );
    f.db.confirm_file_observation_released(&old.key).unwrap();
    f.cleanup();
}
#[test]
fn repeating_preparation_failure_is_exact_and_only_resume_retries_it() {
    let mut f = Fixture::new();
    single(&mut f, "fail");
    edge(&mut f, "fail", 0, "one", 1);
    let first = occurrences(&f, "fail").remove(0);
    edge(&mut f, "fail", 0, "two", 2);
    f.db.fail_followup_preparation(&first.id, 1).unwrap();
    let candidates = f.db.capture_followup_continuations().unwrap();
    assert_eq!(candidates.len(), 1);
    assert_ne!(candidates[0].id(), first.id);
    edge(&mut f, "fail", 0, "three", 3);
    assert!(f
        .db
        .capture_followup_continuations()
        .unwrap()
        .iter()
        .all(|c| c.id() != first.id));
    let d = f.db.followup("fail").unwrap();
    assert_eq!(d.pending_occurrences, 3);
    f.db.control_followup("fail", d.revision, FollowupControlAction::Resume)
        .unwrap();
    assert_eq!(f.db.capture_followup_continuations().unwrap().len(), 3);
    f.cleanup();
}
#[test]
fn repeating_any_consumes_finite_at_once_and_never_lends_it_to_later_file_checks() {
    use varin_runtime::catalog::goals::*;
    let mut f = Fixture::new();
    let p =
        f.db.prepare_goal_start(
            "goal",
            &f.run,
            GoalScope {
                thread_id: "thread".into(),
                branch_id: "branch".into(),
            },
            "Wait for process".into(),
            None,
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_goal_mutation(p).unwrap();
    let process = f.process.clone();
    report_dependency(&mut f, "blocked", Some(process));
    f.state(RunState::Completed);
    register(
        &mut f,
        "any",
        FollowupRegistrationTrigger::Any {
            sources: vec![FollowupRegistrationSource::At { at_ms: 0 }, file("result")],
        },
    );
    edge(&mut f, "any", 1, "new", 1);
    let history = occurrences(&f, "any");
    assert_eq!(history.len(), 2);
    assert_eq!(history[1].hold_reason, Some(HoldReason::GoalBlocked));
    let candidates = f.db.capture_followup_continuations().unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(
        candidates[0].id(),
        history[0].id,
        "the older exact At occurrence remains eligible"
    );
    f.db.admit_followup_continuation(candidates.into_iter().next().unwrap().load().unwrap())
        .unwrap();
    f.db.reconcile_followup_facts_at(0).unwrap();
    assert_eq!(occurrences(&f, "any").len(), 2);
    f.cleanup();
}
#[test]
fn stopping_current_successor_withdraws_each_but_old_terminal_cancel_and_late_receipt_do_not() {
    let mut f = Fixture::new();
    let original = f.run.clone();
    single(&mut f, "old");
    f.state(RunState::Completed);
    edge(&mut f, "old", 0, "one", 1);
    let next = f.reconcile().pop().unwrap();
    f.run = next.clone();
    f.state(RunState::Runnable);
    f.db.request_cancel_run(&original).unwrap();
    assert_eq!(f.db.followup("old").unwrap().state, FollowupState::Active);
    f.db.request_cancel_run(&next).unwrap();
    assert_eq!(
        f.db.followup("old").unwrap().state,
        FollowupState::Cancelled
    );
    single(&mut f, "later-user");
    f.state(RunState::Cancelled);
    assert_eq!(
        f.db.followup("later-user").unwrap().state,
        FollowupState::Active
    );
    f.cleanup();
}
#[test]
fn original_occurrence_history_pages_have_no_total_limit_or_source_cursor_reordering() {
    let mut f = Fixture::new();
    single(&mut f, "pages");
    for n in 1..=66 {
        edge(&mut f, "pages", 0, &format!("value-{n}"), n);
    }
    let first = f.db.followup_occurrences("pages", None).unwrap();
    assert_eq!(first.occurrences.len(), 64);
    let second =
        f.db.followup_occurrences("pages", first.next_cursor)
            .unwrap();
    assert_eq!(second.occurrences.len(), 2);
    assert_eq!(second.next_cursor, None);
    assert!(second.occurrences[0].accepted_cursor > first.next_cursor.unwrap());
    assert_eq!(f.db.followup("pages").unwrap().pending_occurrences, 66);
    f.cleanup();
}
