#[path="fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::catalog::context::ContextProposal;
use varin_runtime::{Catalog, SubmitInput};
#[test]
fn failed_input_leaves_no_checkpoint_and_retry_reopen_cannot_replace_frozen_initial_context() {
    let root = std::env::temp_dir().join(format!(
        "varin-initial-context-review-{}",
        uuid::Uuid::new_v4()
    ));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("thread", "main").unwrap();
    let mut command = SubmitInput {
        key: "first".into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        expected_head: Some("nonexistent-head".into()),
        input: json!({"text":"user input"}),
        configuration: json!({}),
    };
    let proposal = ContextProposal {
        key: "initial-context:main".into(),
        branch_id: "main".into(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "frozen system".into(),
        instruction_sources: vec!["pinned-agent-source".into()],
        memory_checkpoint: Some("notes-revision:1".into()),
    };
    assert!(catalog
        .submit_with_initial_context(&command, None, false, Some(proposal.clone()))
        .is_err());
    assert!(catalog.active_context("main").unwrap().is_none());
    let db = rusqlite::Connection::open(root.join("conversation.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM context_checkpoints", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM history", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    command.expected_head = None;
    let receipt = catalog
        .submit_with_initial_context(&command, None, false, Some(proposal.clone()))
        .unwrap();
    let frozen = catalog.active_context("main").unwrap().unwrap();
    assert_eq!(frozen.proposal, proposal);
    drop(catalog);
    let mut catalog = Catalog::open(&root).unwrap();
    let mut changed = proposal;
    changed.effective_system_prompt = "new unapproved snapshot".into();
    changed.memory_checkpoint = Some("notes-revision:99".into());
    assert_eq!(
        catalog
            .submit_with_initial_context(&command, None, false, Some(changed))
            .unwrap(),
        receipt
    );
    assert_eq!(catalog.active_context("main").unwrap().unwrap(), frozen);
    catalog.fork_branch("main", "empty-fork", None).unwrap();
    let fork = catalog.active_context("empty-fork").unwrap().unwrap();
    assert_eq!(
        fork.proposal.effective_system_prompt,
        frozen.proposal.effective_system_prompt
    );
    assert_eq!(
        fork.proposal.memory_checkpoint,
        frozen.proposal.memory_checkpoint
    );
    assert!(fork.proposal.through_id.is_none());
    assert!(fork.proposal.summary.is_empty());
    drop(catalog);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
