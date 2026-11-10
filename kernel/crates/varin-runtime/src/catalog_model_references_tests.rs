use super::*;
use crate::test_submission::InputAdmission;
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-model-refs-{}", id())))
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn submit(db: &mut Catalog, key: &str, branch: &str) -> Receipt {
    db.submit(&SubmitInput {
        key: key.into(),
        thread_id: "agent".into(),
        branch_id: branch.into(),
        expected_head: db
            .db
            .query_row("SELECT head FROM branches WHERE id=?1", [branch], |r| {
                r.get(0)
            })
            .unwrap(),
        input: json!({"text":key}),
        configuration: json!({}),
    })
    .unwrap()
}
#[test]
fn fixed_observation_reuses_reference_and_preserves_original_version_after_reopen() {
    let root = Fixture::new();
    let mut db = root.open();
    db.create_thread("agent", "main").unwrap();
    let run = submit(&mut db, "first", "main");
    let target = json!({"path":"notes.txt","source":"source-a","readVersion":"v1","encoding":"gbk","bom":false,"lineEnding":"crlf"});
    let original = db
        .register_model_reference(ReferenceKind::File, "storage-a", &target, &run.run_id)
        .unwrap();
    assert_eq!(
        db.register_model_reference(ReferenceKind::File, "storage-a", &target, &run.run_id)
            .unwrap(),
        original
    );
    let changed = db
        .register_model_reference(
            ReferenceKind::File,
            "storage-a",
            &json!({"path":"notes.txt","source":"source-a","readVersion":"v2"}),
            &run.run_id,
        )
        .unwrap();
    let other_source = db
        .register_model_reference(ReferenceKind::File, "storage-b", &target, &run.run_id)
        .unwrap();
    assert_ne!(changed, original);
    assert_ne!(other_source, original);
    assert!(db
        .resolve_model_reference(ReferenceKind::Process, &original)
        .unwrap_err()
        .to_string()
        .contains("needs proc"));
    let space = db.model_reference_space().unwrap();
    drop(db);
    let db = root.open();
    assert_eq!(db.model_reference_space().unwrap(), space);
    assert_eq!(
        db.resolve_model_reference(ReferenceKind::File, &original)
            .unwrap()
            .target,
        target
    );
}
#[test]
fn execution_numbers_follow_admission_across_branches_and_survive_rename() {
    let root = Fixture::new();
    let mut db = root.open();
    db.create_thread("agent", "main").unwrap();
    let first = submit(&mut db, "first", "main");
    let reference = db.execution_reference(&first.run_id).unwrap();
    assert_eq!(reference.sequence, 1);
    let running = db.run(&first.run_id).unwrap();
    let runnable = db
        .transition_run(
            &running.id,
            db.epoch(),
            running.revision,
            RunState::Runnable,
        )
        .unwrap();
    db.transition_run(
        &running.id,
        db.epoch(),
        runnable.revision,
        RunState::Completed,
    )
    .unwrap();
    let fork = db
        .prepare_branch_fork("main", "parallel", Some(&first.input_id), None)
        .unwrap()
        .load()
        .unwrap();
    db.admit_branch_fork(fork).unwrap();
    let second = submit(&mut db, "parallel", "parallel");
    assert_eq!(db.execution_reference(&second.run_id).unwrap().sequence, 2);
    let current = db.inspect_thread("agent").unwrap();
    db.update_thread(&threads::ThreadUpdate {
        thread_id: "agent".into(),
        key: "rename".into(),
        expected_revision: current["revision"].as_u64().unwrap(),
        title: Some("Renamed".into()),
        pinned: None,
        archived: None,
        title_mode: None,
    })
    .unwrap();
    assert_eq!(
        db.resolve_execution_reference(&reference.reference.to_lowercase())
            .unwrap(),
        reference
    );
    drop(db);
    let db = root.open();
    assert_eq!(db.execution_reference(&first.run_id).unwrap(), reference);
}
#[test]
fn control_target_retries_keep_original_selection_and_reject_changed_intent() {
    let root = Fixture::new();
    let mut db = root.open();
    let first = json!({"execution":"agent/1"});
    let second = json!({"execution":"agent/2"});
    let original = json!({"target":"agent"});
    assert_eq!(
        db.freeze_model_target("operation", "wait", &original, &first)
            .unwrap(),
        first
    );
    assert_eq!(
        db.freeze_model_target("operation", "wait", &original, &second)
            .unwrap(),
        first
    );
    assert!(db
        .freeze_model_target("operation", "wait", &json!({"target":"other"}), &second)
        .is_err());
    drop(db);
    let db = root.open();
    assert_eq!(
        db.model_target("operation", "wait", &original).unwrap(),
        Some(first)
    );
}
#[test]
fn foreign_reference_requires_typed_owner_localization_not_copying_local_identity() {
    let a = Fixture::new();
    let b = Fixture::new();
    let mut a = a.open();
    let mut b = b.open();
    let target = json!({"path":"a","version":1});
    let first = a
        .register_model_reference(ReferenceKind::File, "owner-a", &target, "holder")
        .unwrap();
    let local = b
        .register_model_reference(
            ReferenceKind::File,
            "owner-b",
            &json!({"path":"b"}),
            "holder",
        )
        .unwrap();
    assert_eq!(first, local);
    let original = a
        .resolve_model_reference(ReferenceKind::File, &first)
        .unwrap();
    assert!(b.import_model_reference(&original, "receiver").is_err());
    assert_eq!(
        b.resolve_model_reference(ReferenceKind::File, &local)
            .unwrap()
            .owner,
        "owner-b"
    );
    assert_eq!(
        a.import_model_reference(&original, "receiver").unwrap(),
        first
    );
}
#[test]
fn collection_does_not_reuse_retired_numbers() {
    let root = Fixture::new();
    let db = root.open();
    let first = db
        .register_model_reference(
            ReferenceKind::Read,
            "owner",
            &json!({"offset":0}),
            "unpublished",
        )
        .unwrap();
    assert_eq!(collect_unheld(&db.db, &db.content).unwrap(), 1);
    assert!(db
        .resolve_model_reference(ReferenceKind::Read, &first)
        .is_err());
    let next = db
        .register_model_reference(ReferenceKind::Read, "owner", &json!({"offset":0}), "holder")
        .unwrap();
    assert_ne!(first, next);
}
#[test]
fn previous_format_upgrades_metadata_without_rewriting_history() {
    let root = Fixture::new();
    let mut db = root.open();
    db.create_thread("agent", "main").unwrap();
    // Released generations contain shorter lowercase Agent codes. Preserve them,
    // rather than rejecting or renaming a user's established public identity.
    db.db
        .execute(
            "UPDATE threads SET agent_code='a78bc9' WHERE id='agent'",
            [],
        )
        .unwrap();
    let run = submit(&mut db, "legacy", "main");
    let before = db.history("main").unwrap();
    db.db.execute_batch("DROP TABLE model_reference_holders;DROP TABLE model_references;DROP TABLE model_reference_space;DROP TABLE model_execution_aliases;DROP TABLE model_executions;DROP TABLE model_agents;DROP TABLE model_bound_targets;ALTER TABLE external_items DROP COLUMN kind;ALTER TABLE external_items DROP COLUMN tool_status;PRAGMA user_version=89;").unwrap();
    drop(db);
    let db = root.open();
    assert_eq!(db.history("main").unwrap(), before);
    assert_eq!(
        db.execution_reference(&run.run_id).unwrap().reference,
        "a78bc9/1"
    );
    assert_eq!(
        db.resolve_execution_reference("A78BC9/1").unwrap().sequence,
        1
    );
}
#[test]
fn exact_run_stop_does_not_cancel_parallel_or_future_work() {
    let root = Fixture::new();
    let mut db = root.open();
    db.create_thread("agent", "main").unwrap();
    let original = submit(&mut db, "original", "main");
    let run = db.run(&original.run_id).unwrap();
    let runnable = db
        .transition_run(&run.id, db.epoch(), run.revision, RunState::Runnable)
        .unwrap();
    db.transition_run(&run.id, db.epoch(), runnable.revision, RunState::Completed)
        .unwrap();
    let fork = db
        .prepare_branch_fork("main", "parallel", Some(&original.input_id), None)
        .unwrap()
        .load()
        .unwrap();
    db.admit_branch_fork(fork).unwrap();
    let next = submit(&mut db, "next", "main");
    let parallel = submit(&mut db, "other", "parallel");
    db.cancel_tree(dispatch::TreeCancelTarget::Run {
        run_id: original.run_id.clone(),
    })
    .unwrap();
    assert!(!db.run(&next.run_id).unwrap().cancel_requested);
    assert!(!db.run(&parallel.run_id).unwrap().cancel_requested);
    db.cancel_tree(dispatch::TreeCancelTarget::Run {
        run_id: next.run_id.clone(),
    })
    .unwrap();
    assert!(db.run(&next.run_id).unwrap().cancel_requested);
    assert!(!db.run(&parallel.run_id).unwrap().cancel_requested);
}
#[test]
fn external_admissions_get_stable_numbers_without_native_runs() {
    let root = Fixture::new();
    let mut db = root.open();
    let call = |db: &mut Catalog, input: Value| {
        let prepared = db
            .prepare_external(serde_json::from_value(input).unwrap())
            .load()
            .unwrap();
        db.execute_external(prepared).unwrap().load().unwrap()
    };
    call(
        &mut db,
        json!({"action":"create","key":"external","id":"external:a","configurationId":"codex","harness":"codex","title":"External","cwd":"/tmp"}),
    );
    let first = call(
        &mut db,
        json!({"action":"admit","id":"external:a","key":"one","input":{"text":"first"}}),
    );
    let second = call(
        &mut db,
        json!({"action":"admit","id":"external:a","key":"two","input":{"text":"second"}}),
    );
    let original = db
        .execution_reference(first["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(original.sequence, 1);
    assert_eq!(
        db.execution_reference(second["id"].as_str().unwrap())
            .unwrap()
            .sequence,
        2
    );
    assert!(matches!(original.target, ExecutionTarget::External { .. }));
    assert_eq!(
        db.db
            .query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(db);
    let db = root.open();
    assert_eq!(
        db.resolve_execution_reference(&original.reference).unwrap(),
        original
    );
}

#[test]
fn malformed_execution_high_water_is_rejected_without_rewriting_history() {
    let root = Fixture::new();
    let mut db = root.open();
    db.create_thread("agent", "main").unwrap();
    submit(&mut db, "original", "main");
    let before: String = db
        .db
        .query_row("SELECT body FROM history LIMIT 1", [], |r| r.get(0))
        .unwrap();
    db.db
        .execute("UPDATE model_agents SET high_water=0", [])
        .unwrap();
    drop(db);
    assert!(matches!(
        Catalog::open(&root.0),
        Err(RuntimeError::Invalid(_))
    ));
    let raw = Connection::open(root.0.join("conversation.sqlite")).unwrap();
    let after: String = raw
        .query_row("SELECT body FROM history LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        raw.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        FORMAT
    );
}

#[test]
fn pending_publication_holds_its_future_input_reference_until_original_admission() {
    let root = Fixture::new();
    let db = root.open();
    let publication = db.content.begin_publication();
    let reference = db
        .register_model_reference(
            ReferenceKind::File,
            "attachment",
            &json!({"path":"future.txt"}),
            "future-input",
        )
        .unwrap();
    assert_eq!(collect_unheld(&db.db, &db.content).unwrap(), 0);
    assert!(db
        .resolve_model_reference(ReferenceKind::File, &reference)
        .is_ok());
    drop(publication);
    assert_eq!(collect_unheld(&db.db, &db.content).unwrap(), 1);
    assert!(db
        .resolve_model_reference(ReferenceKind::File, &reference)
        .is_err());
}

#[test]
fn released_main_without_reference_tables_upgrades_and_existing_space_is_never_reallocated() {
    for retained in [false,true] {
        let root=Fixture::new();let mut db=root.open();db.create_thread("agent","main").unwrap();
        let run=submit(&mut db,"main-generation","main");
        let original=db.register_model_reference(ReferenceKind::File,"owner",&json!({"path":"kept"}),&run.run_id).unwrap();
        let space=db.model_reference_space().unwrap();let history=db.history("main").unwrap();
        if !retained {db.db.execute_batch("DROP TABLE model_reference_holders;DROP TABLE model_references;DROP TABLE model_reference_space;DROP TABLE model_execution_aliases;DROP TABLE model_executions;DROP TABLE model_agents;DROP TABLE model_bound_targets;ALTER TABLE external_items DROP COLUMN kind;ALTER TABLE external_items DROP COLUMN tool_status;").unwrap();}
        db.db.pragma_update(None,"user_version",if retained {90}else{91}).unwrap();drop(db);
        let db=root.open();assert_eq!(db.history("main").unwrap(),history);assert_eq!(db.execution_reference(&run.run_id).unwrap().sequence,1);
        if retained {assert_eq!(db.model_reference_space().unwrap(),space);assert_eq!(db.resolve_model_reference(ReferenceKind::File,&original).unwrap().target["path"],"kept");}
        assert_eq!(db.db.pragma_query_value(None,"user_version",|row|row.get::<_,i64>(0)).unwrap(),FORMAT);
    }
}
