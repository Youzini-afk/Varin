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
fn gate(db: &mut Catalog, bot: &str) {
    db.publish_bot_gate(varin_runtime::catalog::bot::BotGate {
        bot_id: bot.into(),
        profile_revision: 1,
        activity_operation_id: None,
        permitted: true,
    })
    .unwrap();
}
#[test]
fn attention_is_one_snapshot_and_owner_replacement_is_not_empty_success() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    let first = submit(&mut db, "first", "first-branch");
    gate(&mut db, "original-bot");
    gate(&mut db, "concurrent-bot");
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
    assert_eq!(direct.bot_session_thread_id, None);
    assert_eq!(direct.current_run.as_ref().unwrap().id, first.run_id);
    // A running Run has no settled output fact yet.
    assert_eq!(direct.current_run.as_ref().unwrap().visible_output, None);
    for branch in snapshot
        .branches
        .iter()
        .filter(|b| b.thread_id == "bot-thread")
    {
        assert_eq!(branch.bot_id.as_deref(), Some("original-bot"));
        assert_eq!(branch.bot_session_thread_id.as_deref(), Some("bot-thread"));
        assert_eq!(branch.parent_thread_id, None);
    }
    let wire = serde_json::to_value(&snapshot).unwrap();
    let direct = wire["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["threadId"] == "first")
        .unwrap();
    assert_eq!(direct.get("botId"), Some(&Value::Null));
    assert_eq!(direct.get("botSessionThreadId"), Some(&Value::Null));
    assert!(!wire.to_string().contains("private body"));
    drop(writer);
    let next = db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(next.branches.len(), 4);
    assert!(next.event_cursor > before);
    let concurrent = next
        .branches
        .iter()
        .find(|b| b.thread_id == "concurrent")
        .unwrap();
    assert_eq!(concurrent.bot_id.as_deref(), Some("concurrent-bot"));
    assert_eq!(concurrent.bot_session_thread_id.as_deref(), Some("concurrent"));
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
    // Work dispatched directly from the session keeps that session as its owner conversation.
    assert_eq!(branch.bot_session_thread_id.as_deref(), Some("thread:parent"));
    let session = snapshot
        .branches
        .iter()
        .find(|b| b.thread_id == "thread:parent")
        .unwrap();
    assert_eq!(session.bot_session_thread_id.as_deref(), Some("thread:parent"));
    let relation = &snapshot.delegations[0];
    assert_eq!(relation.continued_cursor, None);
    assert_eq!(relation.continued_by_thread_id, None);
    assert_eq!(relation.report_cursor, None);
    assert_eq!(relation.operation_id, child.operation_id);
    assert_eq!(relation.child_branch_id, child.child_branch_id);
    assert_eq!(relation.parent_branch_id, child.parent_branch_id);
    assert_eq!(relation.accepted_cursor, Some(child.cursor));
    f.settle_exchange();
    f.db.cancel_child(&child.operation_id).unwrap();
    let after = f.db.capture_attention_read().load(&|| false).unwrap();
    assert_eq!(after.delegations[0].accepted_cursor, Some(child.cursor));
    assert_eq!(after.delegations[0].parent_run_id, child.parent_run_id);
    // Cancellation creates the child's actual report; the relation records it once.
    assert!(after.delegations[0].report_cursor.is_some_and(|cursor| cursor > child.cursor));
    assert_eq!(after.delegations[0].report_outcome.as_deref(), Some("cancelled"));
    assert_eq!(after.delegations[0].continued_cursor, None);
    let wire = serde_json::to_string(&snapshot).unwrap();
    assert!(!wire.contains("credential-ref"));
}

fn launch() -> launches::LaunchSelection {
    serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"default","version":"1"},"source":null})).unwrap()
}
/// One real model round of the original execution owner, ending the Run.
fn finish_round(db: &mut Catalog, thread: &str, branch: &str, text: Option<&str>) -> String {
    use varin_runtime::execution::*;
    let run = db
        .submit_with_launch(
            &SubmitInput {
                key: format!("round:{thread}:{}", text.unwrap_or("quiet")),
                thread_id: thread.into(),
                branch_id: branch.into(),
                expected_head: db.head(branch).unwrap(),
                input: json!("round input"),
                configuration: json!({}),
            },
            Some(launch()),
        )
        .unwrap()
        .run_id;
    let epoch = db.epoch();
    let range = HistoryRange {
        branch_id: branch.into(),
        ancestor_id: None,
        leaf_id: db.head(branch).unwrap(),
    };
    let request = format!("{run}:request");
    let records = [
        ExecutionRecord::StateChanged { state: RunState::Runnable, waiting_on: None },
        ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: request.clone(),
                    run_id: run.clone(),
                    origin: RequestOrigin::Conversation { compaction: None, step: 1, history_range: range.clone() },
                    binding: RequestBinding {
                        tool_output_visible_bytes: None, mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
                        provider_id: None, tokenizer: None, request_context: None, child_dispatch: None, goal: None,
                        resource_activations: vec![], resource_checkpoint_id: None,
                        connection_identity: "fixture".into(), provider_family: "fixture".into(), model: "fixture".into(),
                        credential_ref: None, configuration_generation: 1, tool_schema_generation: 1, tools: vec![],
                        instruction_sources: vec![], memory_checkpoint: None, attachment_refs: vec![], environment_cursor: 0,
                        history_range: range,
                    },
                    history: vec![],
                },
                serialized: json!({}).into(),
            }
            .into(),
        },
        ExecutionRecord::ModelDispatched { request_id: request.clone() },
        ExecutionRecord::ModelFinished {
            request_id: request.clone(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::Stop),
            items: text
                .map(|text| ProviderItem { id: format!("{request}:answer"), content: Content::Text { text: text.into() }, opaque: None })
                .into_iter()
                .collect(),
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
        ExecutionRecord::StateChanged { state: RunState::Completed, waiting_on: None },
    ];
    for record in records {
        db.commit_execution(&run, epoch, &record).unwrap();
    }
    run
}
#[test]
fn attention_keeps_bot_sessions_follows_and_public_replies_distinct() {
    use varin_runtime::catalog::bot_work::{BotMatter, MatterThread, MatterUpdate};
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    gate(&mut db, "bot");
    db.create_bot_thread("session", "session-branch", "bot").unwrap();
    db.create_bot_thread("second-session", "second-branch", "bot").unwrap();
    db.create_thread("task", "task-branch").unwrap();
    let matter = |archived: bool, revision: u64| MatterUpdate {
        bot_id: "bot".into(),
        key: format!("follow:{archived}"),
        expected_revision: revision,
        matter: BotMatter {
            id: "release".into(),
            revision,
            title: "Release".into(),
            description: String::new(),
            archived,
            threads: vec![MatterThread { thread_id: "task".into(), branch_id: "task-branch".into(), send: false, memory: false }],
        },
    };
    let followed = db.update_bot_matter(matter(false, 0), None).unwrap();
    let quiet = finish_round(&mut db, "task", "task-branch", None);
    let snapshot = db.capture_attention_read().load(&|| false).unwrap();
    // Each Bot conversation is its own session; following never makes the task Bot work.
    for (thread, session) in [("session", Some("session")), ("second-session", Some("second-session")), ("task", None)] {
        let branch = snapshot.branches.iter().find(|b| b.thread_id == thread).unwrap();
        assert_eq!(branch.bot_session_thread_id.as_deref(), session);
        assert_eq!(branch.bot_id.as_deref(), session.map(|_| "bot"));
    }
    assert_eq!(snapshot.follows.len(), 1);
    let follow = &snapshot.follows[0];
    assert_eq!((follow.bot_id.as_str(), follow.matter_id.as_str()), ("bot", "release"));
    assert_eq!((follow.thread_id.as_str(), follow.branch_id.as_str()), ("task", "task-branch"));
    assert!(snapshot.delegations.is_empty() && snapshot.team_executions.is_empty());
    // A Run that ended without readable output stays quiet, distinct from a public reply.
    let task = snapshot.branches.iter().find(|b| b.thread_id == "task").unwrap();
    let latest = task.latest_run.as_ref().unwrap();
    assert_eq!((latest.id.as_str(), latest.state, latest.visible_output), (quiet.as_str(), RunState::Completed, Some(false)));
    let reply = finish_round(&mut db, "task", "task-branch", Some("Here is the result"));
    db.update_bot_matter(matter(true, followed.revision), None).unwrap();
    let next = db.capture_attention_read().load(&|| false).unwrap();
    let task = next.branches.iter().find(|b| b.thread_id == "task").unwrap();
    let latest = task.latest_run.as_ref().unwrap();
    assert_eq!((latest.id.as_str(), latest.visible_output), (reply.as_str(), Some(true)));
    assert!(next.follows.is_empty());
}
#[test]
fn attention_reuse_never_hides_a_later_commit() {
    let root = Fixture::new();
    let mut db = Catalog::open(&root.0).unwrap();
    submit(&mut db, "task", "task-branch");
    let title = |db: &Catalog| {
        db.capture_attention_read().load(&|| false).unwrap().branches[0]
            .title
            .clone()
    };
    assert_eq!(title(&db), "Task task");
    assert_eq!(title(&db), "Task task");
    db.update_thread(&threads::ThreadUpdate {
        key: "rename:task".into(),
        thread_id: "task".into(),
        expected_revision: db.inspect_thread("task").unwrap()["revision"].as_u64().unwrap(),
        title: Some("Renamed".into()),
        pinned: None,
        archived: None,
    })
    .unwrap();
    assert_eq!(title(&db), "Renamed");
    // A commit through another connection is detected as well as the Catalog's own writes.
    let other = rusqlite::Connection::open(root.0.join("conversation.sqlite")).unwrap();
    other
        .execute("UPDATE threads SET title='Elsewhere' WHERE id='task'", [])
        .unwrap();
    drop(other);
    assert_eq!(title(&db), "Elsewhere");
}
