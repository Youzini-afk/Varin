#[path = "fixtures/child_dispatch.rs"]
mod child_dispatch;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use varin_runtime::catalog::{launches, threads};
use varin_runtime::*;
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-attention-{}", id())))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn submit(db: &mut Catalog, thread: &str, branch: &str) -> Receipt {
    db.create_thread(thread, branch).unwrap();
    // Directory titles are deliberately public metadata; keep the confidential body separate.
    db.update_thread(&threads::ThreadUpdate {
        key: format!("title:{thread}"),
        thread_id: thread.into(),
        expected_revision: 1,
        title: Some(format!("Task {thread}")),
        pinned: None,
        archived: None,
    })
    .unwrap();
    db.submit(&SubmitInput {
        key: format!("input:{thread}"),
        thread_id: thread.into(),
        branch_id: branch.into(),
        expected_head: None,
        input: json!({"text":"private body must not escape"}),
        configuration: json!({}),
    })
    .unwrap()
}
#[test]
fn attention_is_one_snapshot_and_owner_replacement_is_not_empty_success() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    let first = submit(&mut db, "first", "first-branch");
    for bot in ["original-bot", "concurrent-bot"] {
        db.publish_bot_gate(varin_runtime::catalog::bot::BotGate {
            bot_id: bot.into(),
            profile_revision: 1,
            activity_operation_id: None,
            permitted: true,
        }).unwrap();
    }
    db.create_bot_thread("bot-thread", "bot-branch", "original-bot")
        .unwrap();
    db.fork_branch("bot-branch", "bot-fork", None).unwrap();
    let read = db.capture_attention_read();
    let before = db.event_cursor().unwrap();
    let calls = std::cell::Cell::new(0);
    let writer = std::cell::RefCell::new(&mut db);
    let snapshot = read
        .load(&|| {
            let n = calls.get();
            calls.set(n + 1);
            if n == 1 {
                writer
                    .borrow_mut()
                    .create_bot_thread("concurrent", "concurrent-branch", "concurrent-bot")
                    .unwrap();
            }
            false
        })
        .unwrap();
    assert_eq!(snapshot.event_cursor, before);
    assert_eq!(snapshot.branches.len(), 3);
    assert_eq!(snapshot.counts.action_required, 0);
    let direct = snapshot
        .branches
        .iter()
        .find(|b| b.thread_id == "first")
        .unwrap();
    assert_eq!(direct.bot_id, None);
    assert_eq!(direct.current_run.as_ref().unwrap().id, first.run_id);
    for branch in snapshot
        .branches
        .iter()
        .filter(|b| b.thread_id == "bot-thread")
    {
        assert_eq!(branch.bot_id.as_deref(), Some("original-bot"));
        assert_eq!(branch.parent_thread_id, None);
    }
    let wire = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(wire["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["threadId"] == "first")
        .unwrap().get("botId"), Some(&Value::Null));
    assert!(!wire.to_string().contains("private body"));
    drop(writer);
    let next = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(next.branches.len(), 4);
    assert!(next.event_cursor > before);
    assert_eq!(
        next.branches
            .iter()
            .find(|b| b.thread_id == "concurrent")
            .unwrap()
            .bot_id
            .as_deref(),
        Some("concurrent-bot")
    );
    let old = db.capture_attention_read();
    drop(db);
    let _next = Catalog::open(&root.0).unwrap();
    assert!(matches!(
        old.load(&|| false),
        Err(RuntimeError::Conflict(_))
    ));
}
#[test]
fn attention_is_compact_at_concurrency_and_cancellation_is_not_zero() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    for n in 0..64 {
        submit(&mut db, &format!("thread-{n}"), &format!("branch-{n}"));
    }
    // Representative retained tool history alongside live branches, not only empty threads.
    let first_run = db.inspect_thread("thread-0").unwrap()["branches"][0]["active_run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    for n in 0..256 {
        let op = format!("historical-{n}");
        let epoch = db.epoch();
        db.admit_operation(&op, &first_run, epoch, Lifetime::Run, Value::Null)
            .unwrap();
        db.dispatch_operation(&op, epoch, "fixture", false).unwrap();
        db.settle_operation(&op, epoch, Outcome::Succeeded, Effect::None, Value::Null)
            .unwrap();
    }
    let sql = rusqlite::Connection::open(root.0.join("conversation.sqlite")).unwrap();
    let mut plan=sql.prepare("EXPLAIN QUERY PLAN SELECT o.id FROM operations o JOIN runs r ON r.id=o.run_id WHERE json_extract(o.body,'$.phase')!='terminal' OR json_extract(o.body,'$.effect')='unknown'").unwrap();
    let plan = plan
        .query_map([], |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    eprintln!("attention retained-history query plan: {plan:?}");
    let start = std::time::Instant::now();
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(snapshot.branches.len(), 64);
    assert_eq!(snapshot.counts.action_required, 0);
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("private body"));
    assert!(encoded.len() < 100_000);
    eprintln!(
        "attention 64 concurrent branches + 256 terminal operations: {} bytes, {:?}",
        encoded.len(),
        start.elapsed()
    );
    assert!(matches!(
        db.capture_attention_read().load(&|| true),
        Err(RuntimeError::DispatchCancelled)
    ));
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    assert!(matches!(
        db.capture_attention_read().load_cancellable(cancelled),
        Err(RuntimeError::DispatchCancelled)
    ));
}
#[test]
fn attention_keeps_hidden_unsettled_work_but_not_hidden_idle_history() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    submit(&mut db, "busy", "busy-branch");
    db.create_thread("idle", "idle-branch").unwrap();
    for thread in ["busy", "idle"] {
        db.update_thread(&threads::ThreadUpdate {
            key: format!("archive:{thread}"),
            thread_id: thread.into(),
            expected_revision: db.inspect_thread(thread).unwrap()["revision"]
                .as_u64()
                .unwrap(),
            title: None,
            pinned: None,
            archived: Some(true),
        })
        .unwrap();
    }
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(snapshot.branches.len(), 1);
    assert_eq!(snapshot.branches[0].thread_id, "busy");
    assert!(snapshot.branches[0].archived);
}
#[test]
fn attention_retains_unknown_effect_from_terminal_prior_owner_without_hydrating_result() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    let r = submit(&mut db, "thread", "branch");
    let epoch = db.epoch();
    db.admit_operation(
        "effect",
        &r.run_id,
        epoch,
        Lifetime::Thread,
        json!({"secret":"not presentation"}),
    )
    .unwrap();
    db.dispatch_operation("effect", epoch, "original-executor", true)
        .unwrap();
    db.request_cancel_operation("effect").unwrap();
    drop(db);
    let db = Catalog::open(&root.0).unwrap();
    let op = db.operation("effect").unwrap();
    assert_eq!(op.effect, Effect::Unknown);
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(snapshot.counts.action_required, 0);
    assert_eq!(snapshot.counts.unknown_effects, 1);
    let effect = snapshot
        .items
        .iter()
        .find(|i| i.kind == "effect_unknown")
        .unwrap();
    assert_eq!(effect.run_id, r.run_id);
    assert_eq!(effect.operation_id.as_deref(), Some("effect"));
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("not presentation"));
}
#[test]
fn attention_preparation_failure_is_waiting_and_multiple_branches_keep_identity() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    let r = submit(&mut db, "thread", "branch");
    let launch:launches::LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"agent","version":"1"},"source":null})).unwrap();
    db.select_launch(&r.run_id, launch).unwrap();
    db.fail_launch_metadata(&r.run_id, "preparation_failed", Some("private diagnostic"))
        .unwrap();
    db.fork_branch("branch", "fork", None).unwrap();
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(snapshot.branches.len(), 2);
    let entry = snapshot
        .items
        .iter()
        .find(|i| i.kind == "preparation_failed")
        .unwrap();
    assert_eq!(entry.branch_id, "branch");
    assert_eq!(entry.run_id, r.run_id);
    assert!(!entry.actionable);
    assert!(!snapshot.items.iter().any(|i| i.kind == "run_failed"));
    assert_eq!(
        snapshot
            .branches
            .iter()
            .find(|b| b.branch_id == "branch")
            .unwrap()
            .current_run
            .as_ref()
            .unwrap()
            .state,
        RunState::Waiting
    );
    assert!(!serde_json::to_string(&snapshot)
        .unwrap()
        .contains("private diagnostic"));
}

#[test]
fn attention_uses_original_bot_ancestry_without_rewriting_child_identity() {
    let mut f = child_dispatch::Fixture::new_in_bot("owning-bot");
    let child = f.accept();
    let snapshot = f.db.capture_attention_read().load(&|| false).unwrap();
    let branch = snapshot
        .branches
        .iter()
        .find(|b| b.thread_id == child.child_thread_id)
        .unwrap();
    assert_eq!(branch.bot_id.as_deref(), Some("owning-bot"));
    assert_eq!(branch.branch_id, child.child_branch_id);
    assert_eq!(branch.parent_thread_id.as_deref(), Some("thread:parent"));
    let wire = serde_json::to_string(&snapshot).unwrap();
    assert!(!wire.contains("credential-ref"));
}
