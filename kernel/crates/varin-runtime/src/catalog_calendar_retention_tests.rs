use super::*;

fn input() -> DefinitionInput {
    DefinitionInput {
        task_id: "retention".into(),
        asset_revision: "asset:1".into(),
        asset_kind: AssetKind::Gui,
        name: "Retention".into(),
        enabled: true,
        activation_hold: None,
        once_acceptance: None,
        timezone: "UTC".into(),
        rule: Rule::Once {
            date: "2026-11-10".into(),
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
            source: Source::Project,
            source_mode: SourceMode::LiveRoot,
            goal: None,
        },
        instruction: "Retained only while work exists".into(),
    }
}
fn sync(db: &mut Catalog, input: DefinitionInput) -> DefinitionView {
    let revision = db.calendar_project("project").unwrap().revision;
    let prepared = db
        .prepare_calendar_sync(
            "project".into(),
            (revision != 0).then_some(revision),
            vec![input],
        )
        .unwrap()
        .load()
        .unwrap();
    db.admit_calendar_sync(prepared)
        .unwrap()
        .definitions
        .into_iter()
        .find(|d| !d.deleted)
        .unwrap()
}
fn retire(db: &mut Catalog, occurrence: &OccurrenceView) {
    let view = db.inspect_thread(&occurrence.thread_id).unwrap();
    db.delete_thread(&threads::ThreadDelete {
        thread_id: occurrence.thread_id.clone(),
        key: format!("delete:{}", occurrence.id),
        expected_revision: view["revision"].as_u64().unwrap(),
    })
    .unwrap();
}
fn assert_retired(result: Result<OccurrenceView>) {
    assert!(
        matches!(result, Err(RuntimeError::IdentityUnavailable(_))),
        "{result:?}"
    );
}
#[test]
fn manual_acceptance_survives_gc_reopen_and_definition_edits() {
    let path = std::env::temp_dir().join(format!("calendar-retention-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&path).unwrap();
    let d = sync(&mut db, input());
    let first = db.run_calendar_now(&d.id, d.revision, "same-key").unwrap();
    retire(&mut db, &first);
    assert_eq!(
        db.run_calendar_now(&d.id, d.revision, "same-key")
            .unwrap()
            .id,
        first.id
    );
    db.retire_deleted_threads(&[]).unwrap();
    assert!(db.calendar_occurrences(&d.id).unwrap().is_empty());
    assert_retired(db.run_calendar_now(&d.id, d.revision, "same-key"));
    db.retire_deleted_threads(&[]).unwrap();
    drop(db);
    let mut db = Catalog::open(&path).unwrap();
    let mut edited = input();
    edited.asset_revision = "asset:2".into();
    edited.instruction = "Different work".into();
    let updated = sync(&mut db, edited);
    assert!(updated.generation > d.generation);
    assert_retired(db.run_calendar_now(&d.id, d.revision, "same-key"));
    assert_retired(db.run_calendar_now(&d.id, updated.revision, "same-key"));
    assert!(matches!(
        db.run_calendar_now(&d.id, d.revision, "new-key"),
        Err(RuntimeError::Conflict(_))
    ));
    let second = db
        .run_calendar_now(&d.id, updated.revision, "new-key")
        .unwrap();
    assert_ne!(second.thread_id, first.thread_id);
    assert_eq!(db.calendar_occurrences(&d.id).unwrap().len(), 1);
    drop(db);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn legacy_missing_receipt_never_reuses_reserved_calendar_identity() {
    let path = std::env::temp_dir().join(format!("calendar-retention-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&path).unwrap();
    let d = sync(&mut db, input());
    let first = db
        .run_calendar_now(&d.id, d.revision, "legacy-key")
        .unwrap();
    retire(&mut db, &first);
    db.retire_deleted_threads(&[]).unwrap();
    // Model an acceptance already GC'd before the receipt table was introduced.
    db.db
        .execute("DELETE FROM calendar_invocations", [])
        .unwrap();
    assert_retired(db.run_calendar_now(&d.id, d.revision, "legacy-key"));
    let mut edited = input();
    edited.asset_revision = "asset:2".into();
    edited.instruction = "Changed generation".into();
    let updated = sync(&mut db, edited);
    assert_retired(db.run_calendar_now(&d.id, updated.revision, "legacy-key"));
    assert!(db.calendar_occurrences(&d.id).unwrap().is_empty());
    drop(db);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn scheduled_cursor_does_not_replay_collected_slot() {
    let path = std::env::temp_dir().join(format!("calendar-retention-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&path).unwrap();
    let d = sync(&mut db, input());
    db.db
        .execute("DROP TABLE calendar_invocations", [])
        .unwrap();
    db.db
        .execute("DROP TABLE calendar_legacy_manual_boundaries", [])
        .unwrap();
    let tx = db.db.transaction().unwrap();
    upgrade_invocations(&tx).unwrap();
    tx.commit().unwrap();
    assert_retired(db.run_calendar_now(&d.id, d.revision, "unknown-legacy-key"));
    let request = db.calendar_pending().unwrap().calculations.remove(0);
    let at = request.now_ms + 1000;
    let slot = Slot {
        at_ms: at,
        following_at_ms: None,
    };
    db.admit_calendar_calculation(
        request,
        Some(CalculationResult {
            next: Some(slot.clone()),
            latest_due: Some(slot),
            next_future: None,
        }),
        None,
    )
    .unwrap();
    assert_eq!(db.reconcile_calendar_facts_at(at + 1).unwrap(), 1);
    let first = db.calendar_occurrences(&d.id).unwrap().remove(0);
    retire(&mut db, &first);
    db.retire_deleted_threads(&[]).unwrap();
    drop(db);
    let mut db = Catalog::open(&path).unwrap();
    sync(&mut db, input());
    assert_eq!(db.reconcile_calendar_facts_at(at + 2).unwrap(), 0);
    assert!(db.calendar_occurrences(&d.id).unwrap().is_empty());
    drop(db);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn invocation_migration_preserves_acceptance_without_replaying_work() {
    let path = std::env::temp_dir().join(format!("calendar-retention-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&path).unwrap();
    let d = sync(&mut db, input());
    let first = db
        .run_calendar_now(&d.id, d.revision, "upgrade-key")
        .unwrap();
    let before: String = db
        .db
        .query_row(
            "SELECT body FROM calendar_occurrences WHERE id=?1",
            [&first.id],
            |r| r.get(0),
        )
        .unwrap();
    db.db
        .execute("DROP TABLE calendar_invocations", [])
        .unwrap();
    db.db
        .execute("DROP TABLE calendar_legacy_manual_boundaries", [])
        .unwrap();
    let tx = db.db.transaction().unwrap();
    upgrade_invocations(&tx).unwrap();
    tx.commit().unwrap();
    let after: String = db
        .db
        .query_row(
            "SELECT body FROM calendar_occurrences WHERE id=?1",
            [&first.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        db.run_calendar_now(&d.id, d.revision, "upgrade-key")
            .unwrap(),
        first
    );
    retire(&mut db, &first);
    db.retire_deleted_threads(&[]).unwrap();
    assert_retired(db.run_calendar_now(&d.id, d.revision, "upgrade-key"));
    drop(db);
    std::fs::remove_dir_all(path).unwrap();
}

fn configuration() -> Value {
    json!({"providerId":"fixture","providerFamily":"fixture","model":"fixture","endpoint":"https://fixture.invalid","credentialEnvironment":null,"allowAnonymous":true,"configurationGeneration":1,"maxOutputTokens":100})
}
fn launch() -> launches::LaunchSelection {
    serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"default","version":"1"},"source":{"resource_owner":{"kind":"local"},"mode":"live_root","live_root":{"hostId":"host","canonicalRoot":"/fixture","rootId":"root"},"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":null,"revision":null}})).unwrap()
}
fn context(
    o: &OccurrenceView,
) -> (
    context::ContextProposal,
    personalization::PersonalizationBasis,
) {
    (context::ContextProposal{key:format!("initial:{}",o.branch_id),branch_id:o.branch_id.clone(),through_id:None,expected_revision:0,summary:String::new(),effective_system_prompt:"Frozen main context".into(),instruction_sources:vec![],memory_checkpoint:None},serde_json::from_value(json!({"mode":"agent","threadRole":"main","revision":1,"configurationDigest":"fixture","memorySnapshot":{"revision":0,"memories":[]},"threadId":o.thread_id,"projectId":"project","originalSections":[{"name":"system","content":"Frozen main context"}],"instructionSources":[]})).unwrap())
}
fn prepare(db: &Catalog, o: &OccurrenceView) -> PreparedCold {
    prepare_with_launch(db, o, launch()).unwrap()
}
fn prepare_with_launch(
    db: &Catalog,
    o: &OccurrenceView,
    selected: launches::LaunchSelection,
) -> Result<PreparedCold> {
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
    )?
    .load(selected)
}

#[test]
fn legacy_existing_work_gc_then_target_edit_cannot_readmit_unknown_key() {
    let path = std::env::temp_dir().join(format!("calendar-retention-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&path).unwrap();
    let d = sync(&mut db, input());
    let cold = db.run_calendar_now(&d.id, d.revision, "original").unwrap();
    let prepared = prepare(&db, &cold);
    let original = db.admit_calendar_submission(prepared).unwrap();
    let run = original.run_id.as_ref().unwrap();
    for next in [RunState::Preparing, RunState::Runnable, RunState::Completed] {
        let r = db.run(run).unwrap();
        db.transition_run(run, db.epoch(), r.revision, next)
            .unwrap();
    }
    let mut existing = input();
    existing.task_id = "existing".into();
    existing.target = Target::ExistingWork {
        thread_id: cold.thread_id.clone(),
        branch_id: cold.branch_id.clone(),
    };
    let revision = db.calendar_project("project").unwrap().revision;
    let prepared = db
        .prepare_calendar_sync(
            "project".into(),
            Some(revision),
            vec![input(), existing.clone()],
        )
        .unwrap()
        .load()
        .unwrap();
    let d = db
        .admit_calendar_sync(prepared)
        .unwrap()
        .definitions
        .into_iter()
        .find(|d| d.task_id == "existing")
        .unwrap();
    let accepted = db
        .run_calendar_now(&d.id, d.revision, "lost-existing-key")
        .unwrap();
    retire(&mut db, &accepted);
    db.retire_deleted_threads(&[run.clone()]).unwrap();
    assert!(db.calendar_occurrences(&d.id).unwrap().is_empty());
    // Actual old GC left no occurrence; migration cannot reconstruct this key.
    db.db
        .execute("DROP TABLE calendar_invocations", [])
        .unwrap();
    db.db
        .execute("DROP TABLE calendar_legacy_manual_boundaries", [])
        .unwrap();
    let tx = db.db.transaction().unwrap();
    upgrade_invocations(&tx).unwrap();
    tx.commit().unwrap();
    let mut edited = input();
    edited.task_id = "existing".into();
    edited.asset_revision = "asset:2".into();
    let updated = sync(&mut db, edited.clone());
    assert_retired(db.run_calendar_now(&d.id, updated.revision, "lost-existing-key"));
    assert_retired(db.run_calendar_now(&d.id, updated.revision, "unknown-new-key"));
    assert!(db.calendar_occurrences(&d.id).unwrap().is_empty());
    drop(db);
    let mut db = Catalog::open(&path).unwrap();
    assert_retired(db.run_calendar_now(&d.id, updated.revision, "lost-existing-key"));
    let refreshed = db
        .calendar_project("project")
        .unwrap()
        .definitions
        .into_iter()
        .find(|v| v.id == d.id)
        .unwrap();
    let prefix = refreshed.manual_key_prefix.as_ref().unwrap();
    assert_eq!(Some(prefix), updated.manual_key_prefix.as_ref());
    assert_retired(db.run_calendar_now(&d.id, refreshed.revision, prefix));
    assert_retired(db.run_calendar_now(&d.id, refreshed.revision, "calendar-manual:wrong:new-key"));
    let fresh_key = format!("{prefix}{}", Uuid::new_v4());
    let fresh = db
        .run_calendar_now(&d.id, refreshed.revision, &fresh_key)
        .unwrap();
    assert_ne!(fresh.id, accepted.id);
    assert_eq!(
        db.run_calendar_now(&d.id, refreshed.revision, &fresh_key)
            .unwrap()
            .id,
        fresh.id
    );
    assert_retired(db.run_calendar_now(&d.id, refreshed.revision, "lost-existing-key"));
    drop(db);
    std::fs::remove_dir_all(path).unwrap();
}

#[test]
fn malformed_current_manual_generation_is_rejected_without_admission() {
    let path = std::env::temp_dir().join(format!("calendar-prefix-{}", Uuid::new_v4()));
    let mut db = Catalog::open(&path).unwrap();
    let d = sync(&mut db, input());
    db.db
        .execute(
            "INSERT INTO calendar_legacy_manual_boundaries(definition_id,key_prefix) VALUES(?1,'')",
            [d.id],
        )
        .unwrap();
    drop(db);
    assert!(matches!(
        Catalog::open(&path),
        Err(RuntimeError::Invalid(_))
    ));
    let raw = Connection::open(path.join("conversation.sqlite")).unwrap();
    assert_eq!(
        raw.query_row("SELECT count(*) FROM calendar_occurrences", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(raw);
    std::fs::remove_dir_all(path).unwrap();
}
