use super::*;
use crate::catalog::inputs::EnqueueInput;
use crate::test_submission::InputAdmission;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-thread-catalog-{}", id())))
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
fn input(key: &str) -> SubmitInput {
    SubmitInput {
        key: key.into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        expected_head: None,
        input: json!({"text":"  Research material interfaces\nKeep original prompt intact"}),
        configuration: json!({"provider":"test"}),
    }
}
fn patch(key: &str, revision: u64) -> ThreadUpdate {
    ThreadUpdate {
        thread_id: "thread".into(),
        key: key.into(),
        expected_revision: revision,
        title: None,
        pinned: None,
        archived: None,
    }
}
fn delete(revision: u64) -> ThreadDelete {
    ThreadDelete {
        thread_id: "thread".into(),
        key: "delete-thread".into(),
        expected_revision: revision,
    }
}
fn read(key: &str, cursor: u64) -> ThreadRead {
    ThreadRead {
        thread_id: "thread".into(),
        key: key.into(),
        through_cursor: cursor,
    }
}

#[test]
fn catalog_metadata_commands_are_atomic_idempotent_and_recoverable() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let original = db.inspect_thread("thread").unwrap();
    assert_eq!(original["title"], "New thread");
    assert_eq!(original["main_branch_id"], "main");
    assert_eq!(original["revision"], 1);
    assert_eq!(original["unread"], false);
    assert!(original["created_at_ms"].as_u64().unwrap() > 0);
    db.create_thread("thread", "main").unwrap();
    assert_eq!(original, db.inspect_thread("thread").unwrap());
    assert!(matches!(
        db.create_thread("thread", "wrong"),
        Err(RuntimeError::Conflict(_))
    ));
    let mut rename = patch("rename", 1);
    rename.title = Some("  原生研究 Résumé  ".into());
    rename.pinned = Some(true);
    let renamed = db.update_thread(&rename).unwrap();
    assert_eq!(renamed["title"], "原生研究 Résumé");
    assert_eq!(renamed["pinned"], true);
    assert_eq!(renamed["revision"], 2);
    assert_eq!(renamed["unread"], false);
    assert_eq!(renamed["created_at_ms"], original["created_at_ms"]);
    let cursor = db.event_cursor().unwrap();
    assert_eq!(renamed, db.update_thread(&rename).unwrap());
    assert_eq!(cursor, db.event_cursor().unwrap());
    let mut stale = patch("stale", 1);
    stale.archived = Some(true);
    assert!(matches!(
        db.update_thread(&stale),
        Err(RuntimeError::Conflict(_))
    ));
    rename.title = Some("different".into());
    assert!(matches!(
        db.update_thread(&rename),
        Err(RuntimeError::Conflict(_))
    ));
    assert_eq!(renamed, db.inspect_thread("thread").unwrap());
    drop(db);
    let mut db = f.open();
    assert_eq!(renamed, db.inspect_thread("thread").unwrap());
    rename.title = Some("  原生研究 Résumé  ".into());
    assert_eq!(renamed, db.update_thread(&rename).unwrap());
    let events = db.events_after(0, 100).unwrap();
    assert_eq!(
        events.iter().filter(|e| e.kind == "thread.created").count(),
        1
    );
    assert_eq!(
        events.iter().filter(|e| e.kind == "thread.updated").count(),
        1
    );
}

#[test]
fn catalog_archive_search_pin_and_restore_use_real_metadata() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    db.create_thread("other", "other-main").unwrap();
    let mut update = patch("name-pin", 1);
    update.title = Some("Résumé 研究".into());
    update.pinned = Some(true);
    db.update_thread(&update).unwrap();
    let rows = db.list_thread_catalog(&ThreadListQuery::default()).unwrap();
    assert_eq!(rows[0]["thread_id"], "thread");
    let query = ThreadListQuery {
        query: Some("RÉSUMÉ".into()),
        archived: None,
    };
    assert_eq!(db.list_thread_catalog(&query).unwrap().len(), 1);
    let mut archive = patch("archive", 2);
    archive.archived = Some(true);
    db.update_thread(&archive).unwrap();
    assert!(db.list_thread_catalog(&query).unwrap().is_empty());
    let only = ThreadListQuery {
        query: None,
        archived: Some(ArchiveFilter::Only),
    };
    assert_eq!(
        db.list_thread_catalog(&only).unwrap()[0]["thread_id"],
        "thread"
    );
    assert_eq!(
        db.list_threads().unwrap().len(),
        2,
        "owner discovery must include archived work"
    );
    let mut restore = patch("restore", 3);
    restore.archived = Some(false);
    db.update_thread(&restore).unwrap();
    assert_eq!(
        db.list_thread_catalog(&query).unwrap()[0]["archived"],
        false
    );
}

#[test]
fn catalog_titles_and_read_positions_follow_actual_commits() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let accepted = db.submit(&input("input")).unwrap();
    let summary = db.inspect_thread("thread").unwrap();
    assert_eq!(summary["title"], "Research material interfaces");
    assert_eq!(summary["revision"], 2);
    assert_eq!(summary["unread"], true);
    assert_eq!(summary["activity_cursor"], accepted.cursor);
    let read_command = read("read-first", accepted.cursor);
    let marked = db.mark_thread_read(&read_command).unwrap();
    assert_eq!(marked["unread"], false);
    assert_eq!(marked["read_cursor"], accepted.cursor);
    let before = db.event_cursor().unwrap();
    assert_eq!(marked, db.mark_thread_read(&read_command).unwrap());
    assert_eq!(before, db.event_cursor().unwrap());
    let epoch = db.epoch();
    db.append_history(
        &accepted.run_id,
        epoch,
        Some(&accepted.input_id),
        HistorySource::Assistant,
        json!({"text":"new reply"}),
        None,
    )
    .unwrap();
    let next = db.inspect_thread("thread").unwrap();
    assert_eq!(next["unread"], true);
    assert!(next["activity_cursor"].as_u64().unwrap() > accepted.cursor);
    let stale = db.mark_thread_read(&read("read-older", 0)).unwrap();
    assert_eq!(stale["read_cursor"], accepted.cursor);
    assert_eq!(stale["unread"], true);
    let cursor = db.event_cursor().unwrap();
    assert!(matches!(
        db.mark_thread_read(&read("future", cursor + 1)),
        Err(RuntimeError::Invalid(_))
    ));
    assert_eq!(cursor, db.event_cursor().unwrap());
    drop(db);
    let mut db = f.open();
    let recovered = db.inspect_thread("thread").unwrap();
    assert_eq!(recovered["read_cursor"], accepted.cursor);
    assert_eq!(recovered["unread"], true);
    let through = db.event_cursor().unwrap();
    db.mark_thread_read(&read("read-final", through)).unwrap();
    assert_eq!(db.inspect_thread("thread").unwrap()["unread"], false);
}

#[test]
fn catalog_explicit_title_survives_first_input() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let mut update = patch("name", 1);
    update.title = Some("My selected name".into());
    db.update_thread(&update).unwrap();
    db.submit(&input("input")).unwrap();
    assert_eq!(
        db.inspect_thread("thread").unwrap()["title"],
        "My selected name"
    );
    assert_eq!(db.inspect_thread("thread").unwrap()["revision"], 2);
}

#[test]
fn catalog_tombstone_keeps_original_live_executor_queue_and_receipts() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let command = input("input");
    let accepted = db.submit(&command).unwrap();
    let epoch = db.epoch();
    let queue = EnqueueInput {
        key: "queued-before-delete".into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        mode: InputMode::Boundary,
        input: json!({"text":"accepted follow-up"}),
        configuration: None,
    };
    let queued = db.enqueue_input(&queue).unwrap();
    db.admit_operation(
        "job",
        &accepted.run_id,
        epoch,
        Lifetime::Thread,
        json!({"command":"work"}),
    )
    .unwrap();
    db.dispatch_operation("job", epoch, "original-executor", true)
        .unwrap();
    db.handoff_operation("job", epoch).unwrap();
    let original_operation = db.operation("job").unwrap();
    let original_run = db.run(&accepted.run_id).unwrap();
    let tombstone = db.delete_thread(&delete(2)).unwrap();
    assert!(tombstone["deleted_at_ms"].is_number());
    assert!(db
        .list_thread_catalog(&ThreadListQuery {
            query: None,
            archived: Some(ArchiveFilter::Include)
        })
        .unwrap()
        .is_empty());
    assert_eq!(
        db.list_threads().unwrap().len(),
        1,
        "original execution discovery cannot lose a hidden Thread"
    );
    assert_eq!(db.operation("job").unwrap(), original_operation);
    assert_eq!(db.run(&accepted.run_id).unwrap(), original_run);
    assert_eq!(
        db.submit(&command).unwrap(),
        accepted,
        "accepted input retry remains valid"
    );
    assert_eq!(
        db.enqueue_input(&queue).unwrap(),
        queued,
        "accepted queue retry remains valid"
    );
    assert_eq!(db.delete_thread(&delete(2)).unwrap(), tombstone);
    assert!(matches!(
        db.submit(&input("new-input")),
        Err(RuntimeError::Conflict(_))
    ));
    let mut new_queue = queue;
    new_queue.key = "new-queue".into();
    assert!(matches!(
        db.enqueue_input(&new_queue),
        Err(RuntimeError::Conflict(_))
    ));
    assert!(matches!(
        db.fork_branch("main", "new-fork", Some(&accepted.input_id)),
        Err(RuntimeError::Conflict(_))
    ));
    let receipt = ExternalReceipt {
        executor: "original-executor".into(),
        identity: "job".into(),
        epoch: "original-resource-epoch".into(),
        outcome: Outcome::Succeeded,
        effect: Effect::Confirmed,
        result: json!({"exitCode":0}).into(),
    };
    let settled = db.record_external_receipt("job", receipt).unwrap();
    assert_eq!(settled.phase, OperationPhase::Terminal);
    assert_eq!(settled.effect, Effect::Confirmed);
    db.consume_inputs(&accepted.run_id, epoch, Some(&accepted.input_id))
        .unwrap();
    assert_eq!(
        db.queued_input(&queued.input_id).unwrap().state,
        InputState::Delivered
    );
    let head = db.head("main").unwrap();
    db.append_history(
        &accepted.run_id,
        epoch,
        head.as_deref(),
        HistorySource::Assistant,
        json!({"text":"original work completed"}),
        None,
    )
    .unwrap();
    drop(db);
    let mut db = f.open();
    assert!(db.inspect_thread("thread").unwrap()["deleted_at_ms"].is_number());
    assert_eq!(db.delete_thread(&delete(2)).unwrap(), tombstone);
    assert!(db
        .list_thread_catalog(&ThreadListQuery::default())
        .unwrap()
        .is_empty());
    assert_eq!(db.operation("job").unwrap().effect, Effect::Confirmed);
}

#[test]
fn catalog_malformed_current_metadata_is_rejected_without_repair() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    drop(db);
    let raw = Connection::open(f.0.join("conversation.sqlite")).unwrap();
    raw.execute("UPDATE threads SET read_cursor=1 WHERE id='thread'", [])
        .unwrap();
    let epoch: u64 = raw
        .query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |r| {
            read_number(r, 0)
        })
        .unwrap();
    drop(raw);
    assert!(matches!(Catalog::open(&f.0), Err(RuntimeError::Invalid(_))));
    let raw = Connection::open_with_flags(
        f.0.join("conversation.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        raw.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |r| {
            read_number(r, 0)
        })
        .unwrap(),
        epoch
    );
    assert_eq!(
        raw.query_row(
            "SELECT read_cursor FROM threads WHERE id='thread'",
            [],
            |r| read_number(r, 0)
        )
        .unwrap(),
        1
    );
}
