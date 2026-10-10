use super::*;
fn position(id: &str, sequence: u64) -> FileWatchPosition {
    FileWatchPosition {
        source_id: id.into(),
        generation: 1,
        sequence,
    }
}
fn body(value: &str) -> FileState {
    FileState::RegularFile {
        object_hash: format!("sha256-{value}"),
        byte_length: value.len() as u64,
        mode: Some(420),
    }
}
fn register_file(
    f: &mut Fixture,
    key: &str,
    trigger: FollowupRegistrationTrigger,
    state: FileState,
    ready: bool,
) -> Followup {
    let mut p =
        f.db.prepare_followup_registration(
            key,
            &f.run,
            FollowupRegistration {
                trigger,
                instruction: "Read and explain the exact original file result".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    let files = p
        .file_requests()
        .unwrap()
        .into_iter()
        .map(|r| PreparedFileObservation {
            source_index: r.source_index,
            receipt_id: r.receipt_id(),
            state: Some(state.clone()),
            immutable: r.source.mode == SourceMode::FixedBranch,
            watch_id: (r.source.mode != SourceMode::FixedBranch).then(|| "original-watch".into()),
            position: (r.source.mode != SourceMode::FixedBranch).then(|| position("source", 0)),
            gap: false,
            targeted_change: false,
            ready,
        })
        .collect();
    p.bind_file_observations(files).unwrap();
    f.db.admit_followup_registration(p).unwrap().followup
}
fn work(f: &Fixture, id: &str, index: usize) -> FileObservationWork {
    let d = f.db.followup(id).unwrap();
    let file = d.sources[index].file.as_ref().unwrap();
    f.db.followup_file_work(&FileObservationKey {
        followup_id: id.into(),
        generation: d.generation,
        source_index: index,
        receipt_id: file.receipt_id.clone(),
        observation_revision: file.revision,
    })
    .unwrap()
}
fn update(
    w: &FileObservationWork,
    state: FileState,
    sequence: u64,
    targeted: bool,
    ready: bool,
) -> FileObservationUpdate {
    FileObservationUpdate {
        state: Some(state),
        watch_id: w.file.watch_id.clone(),
        position: w.file.position.as_ref().map(|p| FileWatchPosition {
            sequence,
            ..p.clone()
        }),
        gap: false,
        targeted_change: targeted,
        ready,
        failure_code: None,
    }
}
#[test]
fn file_exists_enters_original_active_input_once_and_normalizes_only_source_path() {
    let mut f = Fixture::new();
    let d = register_file(
        &mut f,
        "file-exists",
        FollowupRegistrationTrigger::Any {
            sources: vec![
                FollowupRegistrationSource::At {
                    at_ms: varin_runtime::catalog::observations::MAX_DEADLINE_MS,
                },
                FollowupRegistrationSource::File {
                    path: "out\\nested//./result.txt".into(),
                    condition: FileCondition::Exists,
                },
            ],
        },
        FileState::Missing,
        false,
    );
    assert_eq!(d.wait.state, NextRunWaitState::Waiting);
    assert!(
        matches!(&d.trigger,FollowupTrigger::Any{sources} if matches!(&sources[1],FollowupSource::File{path,..} if path=="out/nested/result.txt"))
    );
    let w = work(&f, "file-exists", 1);
    assert!(f
        .db
        .apply_file_observation(
            &w,
            update(
                &w,
                FileState::Directory { mode: Some(493) },
                1,
                false,
                false
            )
        )
        .unwrap());
    let first = f.db.followup("file-exists").unwrap().occurrence.unwrap();
    assert!(
        matches!(&first.evidence,TriggerEvidence::Any{sources} if matches!(&sources[0].evidence,FollowupLeafEvidence::File{proof:FileProof::Exists,..}))
    );
    assert!(!f
        .db
        .apply_file_observation(&w, update(&w, FileState::Missing, 2, true, false))
        .unwrap());
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
    let delivery = f.db.admit_input_delivery(p).unwrap().unwrap();
    assert_eq!(delivery.items.len(), 1);
    let Content::Text { text } = &delivery.items[0].content else {
        panic!("original Environment input")
    };
    assert!(text.contains("out/nested/result.txt") && text.contains("Read and explain"));
    assert_eq!(
        f.db.followup("file-exists").unwrap().occurrence.unwrap().id,
        first.id
    );
    f.cleanup();
}
#[test]
fn file_all_partial_progress_and_gap_survive_restart_without_inventing_offline_change() {
    let mut f = Fixture::new();
    let process = f.process.clone();
    register_file(
        &mut f,
        "file-all",
        FollowupRegistrationTrigger::All {
            sources: vec![
                FollowupRegistrationSource::At { at_ms: 0 },
                FollowupRegistrationSource::File {
                    path: "result.txt".into(),
                    condition: FileCondition::Changed,
                },
                FollowupRegistrationSource::ProcessStopped {
                    operation_id: process,
                },
            ],
        },
        body("same"),
        false,
    );
    assert!(f.db.followup("file-all").unwrap().sources[0]
        .observed
        .is_some());
    let old = work(&f, "file-all", 1);
    let mut reset = update(&old, body("same"), 0, false, false);
    reset.watch_id = Some("replacement-watch".into());
    reset.position = Some(position("new-source", 0));
    reset.gap = true;
    f.db.apply_file_observation(&old, reset).unwrap();
    assert!(f.db.followup("file-all").unwrap().sources[1]
        .observed
        .is_none());
    let mut f = f.reopen();
    assert!(f
        .db
        .apply_file_observation(&old, update(&old, body("new"), 1, true, false))
        .is_err());
    let current = work(&f, "file-all", 1);
    assert!(current.file.gap);
    f.db.apply_file_observation(&current, update(&current, body("same"), 1, true, false))
        .unwrap();
    let partial = f.db.followup("file-all").unwrap();
    assert!(partial.sources[1].observed.is_some() && partial.occurrence.is_none());
    f.terminal(true);
    f.state(RunState::Completed);
    let runs = f.reconcile();
    assert_eq!(runs.len(), 1);
    let occurrence = f.db.followup("file-all").unwrap().occurrence.unwrap();
    assert!(matches!(occurrence.evidence,TriggerEvidence::All{sources} if sources.len()==3));
    assert!(f.reconcile().is_empty());
    f.cleanup();
}
#[test]
fn file_ready_waits_for_real_idle_evidence_and_pause_cancel_fence_late_reads() {
    let mut f = Fixture::new();
    let d = register_file(
        &mut f,
        "ready",
        FollowupRegistrationTrigger::File {
            path: "result.txt".into(),
            condition: FileCondition::Ready,
        },
        body("stable"),
        false,
    );
    let w = work(&f, "ready", 0);
    f.db.apply_file_observation(&w, update(&w, body("stable"), 0, false, false))
        .unwrap();
    assert_eq!(work(&f, "ready", 0).file.revision, w.file.revision);
    f.db.control_followup("ready", d.revision, FollowupControlAction::Pause)
        .unwrap();
    assert!(!f
        .db
        .apply_file_observation(&w, update(&w, body("stable"), 0, false, true))
        .unwrap());
    let paused = f.db.followup("ready").unwrap();
    f.db.control_followup("ready", paused.revision, FollowupControlAction::Resume)
        .unwrap();
    let w = work(&f, "ready", 0);
    f.db.apply_file_observation(&w, update(&w, body("stable"), 0, false, true))
        .unwrap();
    assert!(matches!(
        f.db.followup("ready").unwrap().occurrence.unwrap().evidence,
        TriggerEvidence::File {
            proof: FileProof::ManagedReady,
            ..
        }
    ));
    let d = register_file(
        &mut f,
        "cancel-file",
        FollowupRegistrationTrigger::File {
            path: "result.txt".into(),
            condition: FileCondition::Changed,
        },
        body("old"),
        false,
    );
    let w = work(&f, "cancel-file", 0);
    f.db.control_followup("cancel-file", d.revision, FollowupControlAction::Cancel)
        .unwrap();
    assert!(!f
        .db
        .apply_file_observation(&w, update(&w, body("new"), 1, true, true))
        .unwrap());
    let release = f.db.followup_file_release_work(&w.key).unwrap();
    assert!(release.release_required);
    f.db.confirm_file_observation_released(&w.key).unwrap();
    assert!(
        f.db.followup_file_release_work(&w.key)
            .unwrap()
            .file
            .released
    );
    f.cleanup();
}
#[test]
fn fixed_changed_stays_static_while_snapshot_ready_and_directory_exists_are_honest() {
    let mut f = Fixture::with_source(
        json!({"mode":"fixed_branch","live_root":null,"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":"fixed","revision":3}),
    );
    let changed = register_file(
        &mut f,
        "immutable-change",
        FollowupRegistrationTrigger::File {
            path: "result.txt".into(),
            condition: FileCondition::Changed,
        },
        body("immutable"),
        true,
    );
    assert!(changed.sources[0].file.as_ref().unwrap().immutable);
    assert!(changed.occurrence.is_none());
    let w = work(&f, "immutable-change", 0);
    f.db.apply_file_observation(&w, update(&w, body("immutable"), 0, false, true))
        .unwrap();
    assert!(f
        .db
        .followup("immutable-change")
        .unwrap()
        .occurrence
        .is_none());
    assert!(register_file(
        &mut f,
        "immutable-exists",
        FollowupRegistrationTrigger::File {
            path: "result.txt".into(),
            condition: FileCondition::Exists
        },
        FileState::Directory { mode: Some(493) },
        true
    )
    .occurrence
    .is_some());
    assert!(register_file(
        &mut f,
        "immutable-ready",
        FollowupRegistrationTrigger::File {
            path: "result.txt".into(),
            condition: FileCondition::Ready
        },
        body("immutable"),
        true
    )
    .occurrence
    .is_some());
    f.cleanup();
}

#[test]
fn explicit_user_registration_disposal_fence_survives_restart_and_rejects_other_actors() {
    let mut f = Fixture::new();
    let input = FollowupRegistration {
        trigger: FollowupRegistrationTrigger::File {
            path: "result.txt".into(),
            condition: FileCondition::Changed,
        },
        instruction: "original pending intent".into(),
        wait: None,
    };
    let prepared =
        f.db.prepare_followup_registration("pending-user", &f.run, input.clone())
            .unwrap()
            .load()
            .unwrap();
    let requests = prepared.file_requests().unwrap();
    for actor in [
        FollowupActor::Agent {
            run_id: f.run.clone(),
            operation_id: f.process.clone(),
            origin: f.context().origin,
        },
        FollowupActor::Goal {
            goal_id: "goal-owned".into(),
        },
    ] {
        let mut other = requests.clone();
        other[0].actor = actor;
        assert!(f
            .db
            .cancel_user_followup_registration("pending-user", &f.run, &other)
            .is_err());
        assert!(!f
            .db
            .user_followup_registration_cancelled("pending-user", &f.run)
            .unwrap());
    }
    assert!(matches!(
        f.db.cancel_user_followup_registration("unaccepted", &f.run, &[]),
        Err(RuntimeError::NotFound(_))
    ));
    assert!(!f
        .db
        .user_followup_registration_cancelled("unaccepted", &f.run)
        .unwrap());
    assert!(f
        .db
        .cancel_user_followup_registration("pending-user", &f.run, &requests)
        .unwrap()
        .is_none());
    assert!(f.db.admit_followup_registration(prepared).is_err());
    let mut f = f.reopen();
    assert!(f
        .db
        .user_followup_registration_cancelled("pending-user", &f.run)
        .unwrap());
    assert!(f
        .db
        .cancel_user_followup_registration("pending-user", &f.run, &[])
        .unwrap()
        .is_none());
    assert!(f
        .db
        .prepare_followup_registration("pending-user", &f.run, input)
        .is_err());
    assert!(f.db.file_acceptance_may_release(&requests[0]).unwrap());
    f.cleanup();
}
