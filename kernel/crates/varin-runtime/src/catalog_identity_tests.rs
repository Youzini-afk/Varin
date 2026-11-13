use super::*;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-identity-{}", id())))
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
fn gate(c: &mut Catalog, permitted: bool, revision: u64) {
    c.publish_bot_gate(bot::BotGate {
        bot_id: "bot".into(),
        profile_revision: revision,
        activity_operation_id: (!permitted).then(|| "pause".into()),
        permitted,
    })
    .unwrap();
}
fn delete(c: &mut Catalog, thread: &str) -> Value {
    let revision = c.inspect_thread(thread).unwrap()["revision"]
        .as_u64()
        .unwrap();
    c.delete_thread(&threads::ThreadDelete {
        thread_id: thread.into(),
        key: format!("delete:{thread}"),
        expected_revision: revision,
    })
    .unwrap()
}
fn downgrade(c: &Catalog) {
    followups::events::restore_pre_arrangement_fixture(&c.db).unwrap();
    crate::catalog::upgrades::remove_read_views_for_legacy_fixture(&c.db);
    c.db.execute_batch("DROP TABLE thread_creations; DROP TABLE calendar_invocations; DROP TABLE calendar_legacy_manual_boundaries; DROP TABLE IF EXISTS organization_retired_containers;DROP TABLE IF EXISTS organization_positions;DROP TABLE IF EXISTS organization_containers;DROP TABLE IF EXISTS organization_commands;DROP TABLE IF EXISTS organization_spaces;PRAGMA user_version=87;").unwrap();
}
#[test]
fn public_creation_replay_retains_owner_branch_and_receipt_after_collection() {
    for principal in [None, Some("alice")] {
        let f = Fixture::new();
        let mut c = f.open();
        c.create_thread_with_principal("thread", "main", principal)
            .unwrap();
        let code = c.inspect_thread("thread").unwrap()["agent_code"].clone();
        c.create_thread_with_principal("thread", "main", principal)
            .unwrap();
        let deleted = delete(&mut c, "thread");
        c.create_thread_with_principal("thread", "main", principal)
            .unwrap();
        c.retire_deleted_threads(&[]).unwrap();
        assert_eq!(
            c.db.query_row(
                "SELECT count(*) FROM events WHERE kind='thread.created'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        drop(c);
        let mut c = f.open();
        c.create_thread_with_principal("thread", "main", principal)
            .unwrap();
        assert_eq!(c.inspect_thread("thread").unwrap()["agent_code"], code);
        assert_eq!(
            c.inspect_thread("thread").unwrap()["deleted_at_ms"],
            deleted["deleted_at_ms"]
        );
        assert!(matches!(
            c.create_thread_with_principal("thread", "other", principal),
            Err(RuntimeError::Conflict(_))
        ));
        assert!(matches!(
            c.create_thread_with_principal("thread", "main", Some("bob")),
            Err(RuntimeError::Conflict(_))
        ));
        assert!(matches!(
            c.create_bot_thread("thread", "main", "bot"),
            Err(RuntimeError::Conflict(_))
        ));
        c.retire_deleted_threads(&[]).unwrap();
        check_format(&c.db).unwrap();
    }
}
#[test]
fn bot_resolution_is_atomic_replayable_and_does_not_resurrect_deleted_entries() {
    let f = Fixture::new();
    let mut c = f.open();
    gate(&mut c, true, 1);
    let original = c.resolve_bot_entry("original", "main", "bot").unwrap();
    assert_eq!(original.thread_id, "original");
    c.create_bot_thread("survivor", "survivor-main", "bot")
        .unwrap();
    delete(&mut c, "original");
    c.retire_deleted_threads(&[]).unwrap();
    assert_eq!(
        c.bot_for_thread("original").unwrap().as_deref(),
        Some("bot")
    );
    assert_eq!(
        c.resolve_bot_entry("original", "main", "bot")
            .unwrap()
            .thread_id,
        "survivor"
    );
    assert!(matches!(
        c.resolve_bot_entry("original", "wrong", "bot"),
        Err(RuntimeError::Conflict(_))
    ));
    assert!(matches!(
        c.resolve_bot_entry("original", "main", "other-bot"),
        Err(RuntimeError::Conflict(_))
    ));
    delete(&mut c, "survivor");
    c.retire_deleted_threads(&[]).unwrap();
    let next = c.resolve_bot_entry("original", "main", "bot").unwrap();
    assert_ne!(next.thread_id, "original");
    // A lost response and a second caller submit the same original identity.
    assert_eq!(
        c.resolve_bot_entry("original", "main", "bot").unwrap(),
        next
    );
    drop(c);
    let mut c = f.open();
    assert_eq!(
        c.resolve_bot_entry("original", "main", "bot").unwrap(),
        next
    );
    assert_eq!(
        c.db.query_row("SELECT count(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    delete(&mut c, &next.thread_id);
    gate(&mut c, false, 2);
    assert!(matches!(
        c.resolve_bot_entry("original", "main", "bot"),
        Err(RuntimeError::RequestActivationHeld)
    ));
    assert_eq!(
        c.db.query_row("SELECT count(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
}
#[test]
fn legacy_collected_identity_stays_unknown_but_bot_navigation_can_recover() {
    let f = Fixture::new();
    let mut c = f.open();
    gate(&mut c, true, 1);
    c.create_bot_thread("original", "main", "bot").unwrap();
    delete(&mut c, "original");
    c.retire_deleted_threads(&[]).unwrap();
    c.db.execute("DELETE FROM bot_thread_bindings", []).unwrap();
    downgrade(&c);
    drop(c);
    let mut c = f.open();
    gate(&mut c, true, 1);
    assert!(matches!(
        c.create_bot_thread("original", "main", "bot"),
        Err(RuntimeError::IdentityUnavailable(_))
    ));
    assert!(matches!(
        c.create_thread("original", "main"),
        Err(RuntimeError::IdentityUnavailable(_))
    ));
    c.create_thread("unrelated", "unrelated-main").unwrap();
    for wrong_branch in ["unrelated-main", "missing-branch"] {
        assert!(matches!(
            c.resolve_bot_entry("original", wrong_branch, "bot"),
            Err(RuntimeError::Conflict(_))
        ));
    }
    let next = c.resolve_bot_entry("original", "main", "bot").unwrap();
    assert_ne!(next.thread_id, "original");
    assert_eq!(
        c.db.query_row(
            "SELECT count(*) FROM bot_thread_bindings WHERE thread_id='original'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        c.db.query_row(
            "SELECT identity_known FROM thread_creations WHERE thread_id='original'",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap(),
        false
    );
    assert!(c.inspect_thread("original").unwrap()["deleted_at_ms"].is_number());
    assert_eq!(c.list_threads().unwrap().len(), 3);
    c.retire_deleted_threads(&[]).unwrap();
    assert!(matches!(
        bot::thread_permitted(&c.db, "original", c.epoch()),
        Err(RuntimeError::IdentityUnavailable(_))
    ));
}
#[test]
fn live_unknown_or_wrong_principal_entry_never_creates_fallback() {
    let f = Fixture::new();
    let mut c = f.open();
    gate(&mut c, true, 1);
    c.create_bot_thread("original", "main", "bot").unwrap();
    c.db.execute(
        "UPDATE thread_creations SET identity_known=0 WHERE thread_id='original'",
        [],
    )
    .unwrap();
    assert!(matches!(
        c.resolve_bot_entry("original", "main", "bot"),
        Err(RuntimeError::IdentityUnavailable(_))
    ));
    c.db.execute(
        "UPDATE threads SET principal_id='alice' WHERE id='original'",
        [],
    )
    .unwrap();
    assert!(matches!(
        c.resolve_bot_entry_with_principal("original", "main", "bot", Some("bob")),
        Err(RuntimeError::Conflict(_))
    ));
    assert_eq!(
        c.db.query_row("SELECT count(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn original_fork_receipt_survives_branch_and_thread_gc() {
    let f = Fixture::new();
    let mut c = f.open();
    c.create_thread("thread", "main").unwrap();
    let prepared = c
        .prepare_branch_fork("main", "fork", None, None)
        .unwrap()
        .load()
        .unwrap();
    let receipt = c.admit_branch_fork(prepared).unwrap();
    c.delete_branch(&threads::BranchDelete {
        thread_id: "thread".into(),
        branch_id: "fork".into(),
        key: "delete-fork".into(),
    })
    .unwrap();
    c.retire_deleted_threads(&[]).unwrap();
    let prepared = c
        .prepare_branch_fork("main", "fork", None, None)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(c.admit_branch_fork(prepared).unwrap(), receipt);
    delete(&mut c, "thread");
    c.retire_deleted_threads(&[]).unwrap();
    drop(c);
    let mut c = f.open();
    let prepared = c
        .prepare_branch_fork("main", "fork", None, None)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(c.admit_branch_fork(prepared).unwrap(), receipt);
    assert!(matches!(
        c.prepare_branch_fork("main", "fork", Some("wrong"), None),
        Err(RuntimeError::Conflict(_))
    ));
}
#[test]
fn explicit_bot_deletion_keeps_reserved_identity_without_pinning_execution() {
    let f = Fixture::new();
    let mut c = f.open();
    gate(&mut c, true, 1);
    c.create_bot_thread("original", "main", "bot").unwrap();
    gate(&mut c, false, 2);
    let suspension = bot::BotSuspension {
        bot_id: "bot".into(),
        activity_operation_id: "pause".into(),
        profile_revision: 2,
    };
    c.remove_bot_scope(&suspension).unwrap();
    c.remove_bot_scope(&suspension).unwrap();
    assert!(c.inspect_thread("original").unwrap()["deleted_at_ms"].is_number());
    assert!(matches!(
        c.create_thread("original", "main"),
        Err(RuntimeError::Conflict(_))
    ));
    c.create_bot_thread("original", "main", "bot").unwrap();
    assert!(matches!(
        c.resolve_bot_entry("original", "main", "bot"),
        Err(RuntimeError::RequestActivationHeld)
    ));
    check_format(&c.db).unwrap();
    drop(c);
    f.open();
}

#[test]
fn malformed_legacy_creation_is_rejected_without_committing_upgrade() {
    let f = Fixture::new();
    let mut c = f.open();
    c.create_thread("one", "one-main").unwrap();
    c.create_thread("two", "two-main").unwrap();
    c.db.execute(
        "UPDATE events SET data=?1 WHERE subject='one' AND kind='thread.created'",
        [r#"{"branch_id":"two-main"}"#],
    )
    .unwrap();
    downgrade(&c);
    drop(c);
    assert!(matches!(
        Catalog::open(&f.0),
        Err(RuntimeError::Upgrade { .. })
    ));
    let raw = Connection::open(f.0.join("conversation.sqlite")).unwrap();
    assert_eq!(
        raw.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        87
    );
    assert_eq!(
        raw.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='thread_creations'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(
        raw.query_row("SELECT count(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}
#[test]
fn partial_new_identity_schema_under_legacy_marker_is_not_overwritten() {
    let f = Fixture::new();
    let c = f.open();
    if 87 < 95 { crate::catalog::organization::remove_for_legacy_fixture(&c.db); }
    c.db.pragma_update(None, "user_version", 87).unwrap();
    drop(c);
    assert!(matches!(Catalog::open(&f.0), Err(RuntimeError::Invalid(_))));
}

#[test]
fn survivor_requires_the_same_complete_creation_authority_as_original() {
    for corrupt in [
        "UPDATE thread_creations SET identity_known=0 WHERE thread_id='survivor'",
        "UPDATE thread_creations SET domain='summary',bot_id=NULL WHERE thread_id='survivor'",
        "UPDATE thread_creations SET initial_branch_id='main' WHERE thread_id='survivor'",
        "UPDATE threads SET principal_id='other' WHERE id='survivor'",
    ] {
        let f = Fixture::new();
        let mut c = f.open();
        gate(&mut c, true, 1);
        c.create_bot_thread("original", "main", "bot").unwrap();
        c.create_bot_thread("survivor", "survivor-main", "bot")
            .unwrap();
        delete(&mut c, "original");
        c.retire_deleted_threads(&[]).unwrap();
        c.db.execute(corrupt, []).unwrap();
        if corrupt.contains("principal_id") {
            // A foreign principal's survivor is not a fallback candidate. Keep it
            // intact and create a distinct session for the original public scope.
            let next=c.resolve_bot_entry("original","main","bot").unwrap();
            assert_ne!(next.thread_id,"survivor");
            assert_eq!(c.thread_principal(&next.thread_id).unwrap(),None);
            assert_eq!(c.thread_principal("survivor").unwrap().as_deref(),Some("other"));
            continue;
        }
        assert!(matches!(
            c.resolve_bot_entry("original", "main", "bot"),
            Err(RuntimeError::IdentityUnavailable(_) | RuntimeError::Conflict(_))
        ));
        assert_eq!(
            c.db.query_row("SELECT count(*) FROM threads", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}

#[test]
fn concurrent_bot_entry_requests_share_the_original_catalog_commit() {
    let f = Fixture::new();
    let mut c = f.open();
    gate(&mut c, true, 1);
    c.create_bot_thread("original", "main", "bot").unwrap();
    delete(&mut c, "original");
    c.retire_deleted_threads(&[]).unwrap();
    // A second process cannot become another writer for the same Catalog.
    assert!(Catalog::open(&f.0).is_err());
    let owner = std::sync::Arc::new(std::sync::Mutex::new(c));
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let calls = (0..8)
        .map(|_| {
            let owner = owner.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                owner
                    .lock()
                    .unwrap()
                    .resolve_bot_entry("original", "main", "bot")
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    let receipts = calls
        .into_iter()
        .map(|call| call.join().unwrap())
        .collect::<Vec<_>>();
    assert!(receipts.iter().all(|receipt| receipt == &receipts[0]));
    assert_eq!(
        owner
            .lock()
            .unwrap()
            .db
            .query_row("SELECT count(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn live_missing_ownership_evidence_does_not_become_ordinary_execution_permission() {
    let f = Fixture::new();
    let mut c = f.open();
    c.create_thread("unknown", "unknown-main").unwrap();
    c.db.execute(
        "UPDATE thread_creations SET identity_known=0 WHERE thread_id='unknown'",
        [],
    )
    .unwrap();
    assert!(matches!(
        bot::thread_permitted(&c.db, "unknown", c.epoch()),
        Err(RuntimeError::IdentityUnavailable(_))
    ));
    assert_eq!(
        c.inspect_thread("unknown").unwrap()["creation_identity_known"],
        false
    );
    assert_eq!(c.list_threads().unwrap().len(), 1);
}
