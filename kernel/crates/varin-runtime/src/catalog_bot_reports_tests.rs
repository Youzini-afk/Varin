use super::*;
#[path = "../tests/fixtures/child_dispatch.rs"]
mod child_fixture;

#[test]
fn a_bot_preparation_failure_is_queued_once_with_its_original_report() {
    let mut fixture = child_fixture::Fixture::new_in_bot("bot");
    let child = fixture.accept();
    fixture
        .db
        .fail_child_preparation(&child.execution_id, "source_unavailable")
        .unwrap();
    let candidates = fixture.db.pending_bot_reports().unwrap();
    assert_eq!(candidates.len(), 1);
    let prepared = fixture
        .db
        .prepare_bot_report(candidates[0].clone())
        .unwrap()
        .load()
        .unwrap();
    let first = fixture.db.admit_message(prepared).unwrap();
    assert!(first.accepted);
    assert_eq!(
        first.receipt.identity.target_thread_id,
        child.parent_thread_id
    );
    assert_eq!(first.receipt.identity.kind, MessageKind::Request);
    assert_eq!(
        first.receipt.identity.message_id,
        format!("message:bot-report:{}", child.execution_id)
    );
    assert!(fixture.db.pending_bot_reports().unwrap().is_empty());
    let view = fixture
        .db
        .capture_message(
            &child.parent_thread_id,
            &child.parent_branch_id,
            &first.receipt.identity.message_id,
        )
        .unwrap()
        .load()
        .unwrap();
    assert!(view.text.contains("source_unavailable"));
    let prepared = fixture
        .db
        .prepare_bot_report(candidates[0].clone())
        .unwrap()
        .load()
        .unwrap();
    assert!(!fixture.db.admit_message(prepared).unwrap().accepted);
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordinary_agent_reports_do_not_start_a_bot_processing_round() {
    let mut fixture = child_fixture::Fixture::new();
    let child = fixture.accept();
    fixture
        .db
        .fail_child_preparation(&child.execution_id, "source_unavailable")
        .unwrap();
    assert!(fixture.db.pending_bot_reports().unwrap().is_empty());
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bot_wait_and_background_delivery_consume_the_same_original_report() {
    let mut fixture = child_fixture::Fixture::new_in_bot("bot");
    let child = fixture.accept();
    fixture.settle_exchange();
    fixture
        .db
        .fail_child_preparation(&child.execution_id, "source_unavailable")
        .unwrap();
    let report = fixture.db.pending_bot_reports().unwrap().remove(0);
    let prepared = fixture
        .db
        .prepare_bot_report(report)
        .unwrap()
        .load()
        .unwrap();
    fixture.admit_wait("queued-bot-report");
    // The report worker captured the result just before the same request registered its Wait.
    let receipt = fixture.db.admit_message(prepared).unwrap();
    let waits = fixture.db.capture_child_waits().unwrap();
    assert_eq!(waits.len(), 1);
    for wait in waits {
        let prepared = wait.load().unwrap();
        fixture.db.admit_child_wait(prepared).unwrap();
    }
    assert!(fixture.db.pending_bot_reports().unwrap().is_empty());
    assert_eq!(
        fixture
            .db
            .execution_history(&child.parent_branch_id)
            .unwrap()
            .iter()
            .filter(|item| item.id == receipt.receipt.identity.message_id)
            .count(),
        1
    );
    let queued: bool = fixture
        .db
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM input_queue WHERE id=?1 AND state='queued')",
            [&receipt.receipt.identity.message_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!queued);
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bot_project_dispatch_waits_for_its_own_source_and_never_borrows_the_home_source() {
    let mut fixture = child_fixture::Fixture::new_project_dispatch();
    let child = fixture.accept();
    assert_eq!(child.project_id.as_deref(), Some("project-B"));
    assert!(matches!(
        child.source,
        collaboration::ChildSource::Project { .. }
    ));
    let source:launches::SourceSelection=serde_json::from_value(json!({"resource_owner":{"kind":"local"},"mode":"live_root","live_root":{"hostId":"local","rootId":"project-B-root","canonicalRoot":"/registered/project-B"},"workspace_id":"workspace-B","execution_workspace_id":"workspace-B","branch_id":null,"revision":null})).unwrap();
    let prepared = fixture
        .db
        .prepare_project_child_source(&child.execution_id, None, source.clone(), None)
        .unwrap()
        .load()
        .unwrap();
    let ready = fixture.db.attach_child_source(prepared).unwrap();
    assert_eq!(ready.source.selection(), Some(&source));
    assert!(ready.source.handoff().is_none());
    assert_eq!(
        ready.code_result,
        collaboration::ChildCodeResult::SharedSource
    );
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bot_activity_pages_a_sessions_dispatch_and_its_report_newest_first() {
    let mut fixture = child_fixture::Fixture::new_in_bot("bot");
    let child = fixture.accept();
    fixture
        .db
        .fail_child_preparation(&child.execution_id, "source_unavailable")
        .unwrap();
    let read = |before| {
        serde_json::to_value(
            fixture.db.capture_bot_activity("bot", before, Some(1)).unwrap().load(&|| false).unwrap(),
        )
        .unwrap()
    };
    let newest = read(None);
    let report = &newest["events"][0];
    assert_eq!(newest["events"].as_array().unwrap().len(), 1);
    assert_eq!(report["kind"], "report");
    assert_eq!(report["outcome"], "failed");
    assert_eq!(report["threadId"], json!(child.child_thread_id));
    assert_eq!(report["sessionThreadId"], "thread:parent");
    assert!(report["atMs"].as_u64().is_some());
    assert!(newest["participants"].as_array().unwrap().iter().any(|p| p["threadId"] == json!(child.child_thread_id)));
    let older = read(newest["before"].as_u64());
    let dispatch = &older["events"][0];
    assert_eq!(dispatch["kind"], "dispatch");
    assert_eq!(dispatch["task"], "Read the fixed file and report");
    assert_eq!(dispatch["operationId"], json!(child.operation_id));
    assert!(dispatch["atMs"].as_u64().is_some());
    assert!(older["before"].is_null());
    let whole = fixture.db.capture_bot_activity("bot", None, None).unwrap().load(&|| false).unwrap();
    assert_eq!(whole.events.len(), 2);
    assert!(whole.before.is_none());
    assert!(fixture.db.capture_bot_activity("bot", None, None).unwrap().load(&|| true).is_err());
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}
