//! The generated trusted management DTO reaches the same message authority, always as User.
use super::*;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;
#[test]
fn public_send_list_get_keep_user_identity_and_never_admit_a_run() {
    let mut fixture = fixture::Fixture::new();
    let child = fixture.accept();
    fixture.settle_exchange();
    let root = fixture.root.clone();
    let runtime = Arc::new(RunSupervisor::new(fixture.db));
    let cancelled = Arc::new(AtomicBool::new(false));
    let input = json!({"key":"public-message","senderThreadId":child.child_thread_id,"senderBranchId":child.child_branch_id,
        "targetThreadId":"thread:parent","targetBranchId":"branch:parent","kind":"inform","text":"original user message"});
    let receipt = execute(
        runtime.clone(),
        "runtime.messages.send",
        input.clone(),
        cancelled.clone(),
        None,
    )
    .unwrap();
    assert_eq!(receipt["actor"]["kind"], "user");
    assert_eq!(
        execute(
            runtime.clone(),
            "runtime.messages.send",
            input.clone(),
            cancelled.clone(),
            None
        )
        .unwrap(),
        receipt
    );
    let page = execute(
        runtime.clone(),
        "runtime.messages.list",
        json!({"threadId":"thread:parent","branchId":"branch:parent","direction":"incoming"}),
        cancelled.clone(),
        None,
    )
    .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(page["messages"][0]["state"], "queued");
    assert!(page["messages"][0]["deliveredRunId"].is_null());
    assert!(page["messages"][0].get("text").is_none());
    let message = execute(runtime.clone(), "runtime.messages.get", json!({"threadId":"thread:parent","branchId":"branch:parent","messageId":receipt["messageId"]}), cancelled.clone(), None).unwrap();
    assert_eq!(message["text"], "original user message");
    assert!(execute(
        runtime.clone(),
        "runtime.input.inspect",
        json!({"inputId":receipt["messageId"]}),
        cancelled.clone(),
        None
    )
    .is_err());
    let mut spoofed = input;
    spoofed["actor"] = json!({"kind":"agent"});
    assert!(execute(
        runtime.clone(),
        "runtime.messages.send",
        spoofed,
        cancelled,
        None
    )
    .is_err());
    let sql = rusqlite::Connection::open_with_flags(
        root.join("conversation.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(sql);
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}
