//! Generated public DTOs reach the exact same immutable domain reader used by tools.
use super::*;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;
#[test]
fn public_family_commands_preserve_target_anchor_and_original_semantic_item() {
    let mut f = fixture::Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let list = FamilyCommand::capture(
        &f.db,
        "runtime.family.list",
        json!({"callerThreadId":child.child_thread_id}),
    )
    .unwrap()
    .load(&|| false)
    .unwrap();
    assert_eq!(list["members"][0]["threadId"], "thread:parent");
    assert!(list["members"][0].get("configuration").is_none());
    let identity = json!({"callerThreadId":child.child_thread_id,"threadId":"thread:parent","branchId":"branch:parent"});
    let mut input = identity.clone();
    input["query"] = json!({"kind":"recent","limit":1,"maxItemBytes":1});
    let command = FamilyCommand::capture(&f.db, "runtime.family.read", input.clone()).unwrap();
    let page = command.load(&|| false).unwrap();
    assert!(page["items"][0]["bodyTruncated"].as_bool().unwrap());
    assert_eq!(page["items"][0]["runId"], f.context.run_id);
    let mut item = identity.clone();
    item["anchor"] = page["anchor"].clone();
    item["itemId"] = page["items"][0]["id"].clone();
    item["maxBytes"] = json!(65536);
    let body = FamilyCommand::capture(&f.db, "runtime.family.item", item)
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(body["format"], "conversation_json");
    let semantic: Value = serde_json::from_str(body["text"].as_str().unwrap()).unwrap();
    assert!(semantic.get("provider").is_none());
    assert_eq!(semantic["content"]["kind"], "tool_result");
    let mut runs = identity.clone();
    runs["limit"] = json!(1);
    let runs = FamilyCommand::capture(&f.db, "runtime.family.runs", runs)
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(runs["runs"][0]["runId"], f.context.run_id);
    input["query"]["unexpected"] = json!(true);
    assert!(FamilyCommand::capture(&f.db, "runtime.family.read", input).is_err());
    assert!(matches!(
        FamilyCommand::capture(
            &f.db,
            "runtime.family.list",
            json!({"callerThreadId":child.child_thread_id})
        )
        .unwrap()
        .load(&|| true),
        Err(KernelError::Cancelled)
    ));
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn old_history_page_read_captures_before_append_and_keeps_exclusive_previous_boundary() {
    let mut f = fixture::Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let original = f.db.history_page("branch:parent", None, None, 1).unwrap();
    let capture = f.db.capture_history_page("branch:parent").unwrap();
    f.db.append_history(
        &f.context.run_id,
        f.db.epoch(),
        original.head.as_deref(),
        varin_runtime::HistorySource::Assistant,
        json!("later"),
        None,
    )
    .unwrap();
    let page = capture.load(None, None, 1, &|| false).unwrap();
    assert_eq!(page.head, original.head);
    assert_eq!(page.items[0].id, original.items[0].id);
    assert_eq!(page.items[0].run_id, f.context.run_id);
    let previous =
        f.db.capture_history_page("branch:parent")
            .unwrap()
            .load(page.head.as_deref(), page.previous.as_deref(), 1, &|| false)
            .unwrap();
    assert_ne!(previous.items[0].id, page.items[0].id);
    assert!(matches!(
        f.db.capture_history_page("branch:parent")
            .unwrap()
            .load(None, None, 1, &|| true),
        Err(varin_runtime::RuntimeError::DispatchCancelled)
    ));
    assert!(
        f.db.capture_family_read(
            &child.child_thread_id,
            Some("thread:parent"),
            Some("branch:parent")
        )
        .is_ok()
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
