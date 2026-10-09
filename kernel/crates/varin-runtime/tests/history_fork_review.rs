#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::execution::{
    Content, ConversationItem, Provenance, ToolCall, ToolCompletion, ToolResult,
};
use varin_runtime::{Catalog, HistorySource, RuntimeError, SubmitInput};

#[test]
fn fork_rejects_an_open_tool_exchange_but_accepts_its_completed_boundary() {
    let root = std::env::temp_dir().join(format!("varin-fork-review-{}", uuid::Uuid::new_v4()));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("thread", "main").unwrap();
    let receipt = catalog
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"inspect"}),
            configuration: json!({}),
        })
        .unwrap();
    let epoch = catalog.epoch();
    let call = ConversationItem {
        id: "call-item".into(),
        provenance: Provenance::Assistant,
        content: Content::ToolCall {
            call: ToolCall {
                call_id: "call-1".into(),
                name: "read".into(),
                schema_version: "1".into(),
                arguments: json!({}),
            },
        },
        opaque: None,
    };
    let call_history = catalog
        .append_history(
            &receipt.run_id,
            epoch,
            Some(&receipt.input_id),
            HistorySource::Assistant,
            serde_json::to_value(call).unwrap(),
            None,
        )
        .unwrap();
    assert!(matches!(
        catalog.fork_branch("main", "fork", Some(&call_history.id)),
        Err(RuntimeError::Invalid(_))
    ));
    assert!(catalog.head("fork").is_err());
    let result = ConversationItem {
        id: "result-item".into(),
        provenance: Provenance::ToolData {
            call_id: "call-1".into(),
        },
        content: Content::ToolResult {
            result: ToolResult {
                request_id: "request-1".into(),
                call_id: "call-1".into(),
                completion: ToolCompletion::NotDispatched {
                    reason: "fixture".into(),
                },
            },
        },
        opaque: None,
    };
    let result_history = catalog
        .append_history(
            &receipt.run_id,
            epoch,
            Some(&call_history.id),
            HistorySource::Tool,
            serde_json::to_value(result).unwrap(),
            None,
        )
        .unwrap();
    catalog
        .fork_branch("main", "fork", Some(&result_history.id))
        .unwrap();
    assert_eq!(
        catalog.history("fork").unwrap(),
        catalog.history("main").unwrap()
    );
    assert!(matches!(
        catalog.fork_branch("main", "fork", Some(&receipt.input_id)),
        Err(RuntimeError::Conflict(_))
    ));
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn fork_worker_pins_its_ancestor_and_context_while_source_and_controls_advance() {
    use varin_runtime::catalog::context::ContextProposal;
    let root = std::env::temp_dir().join(format!("varin-fork-pinning-{}", uuid::Uuid::new_v4()));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("thread", "main").unwrap();
    let prompt = "captured system 中文🎉".repeat(10000);
    let initial = ContextProposal {
        key: "original-context".into(),
        branch_id: "main".into(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: prompt.clone(),
        instruction_sources: vec![],
        memory_checkpoint: Some("original-notes".into()),
    };
    let receipt = catalog
        .submit_with_initial_context(
            &SubmitInput {
                key: "initial".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"original"}),
                configuration: json!({}),
            },
            None,
            false,
            Some(initial.clone()),
        )
        .unwrap();
    let epoch = catalog.epoch();
    let preparation = catalog
        .prepare_branch_fork("main", "fork", Some(&receipt.input_id), None)
        .unwrap();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        wait.recv().unwrap();
        preparation.load().unwrap()
    });
    catalog
        .append_history(
            &receipt.run_id,
            epoch,
            Some(&receipt.input_id),
            HistorySource::Assistant,
            json!({"text":"new tail"}),
            None,
        )
        .unwrap();
    catalog
        .publish_context(ContextProposal {
            key: "later-context".into(),
            expected_revision: 1,
            effective_system_prompt: "later system".into(),
            memory_checkpoint: Some("later-notes".into()),
            ..initial
        })
        .unwrap();
    catalog
        .create_thread("independent", "independent-branch")
        .unwrap();
    release.send(()).unwrap();
    let fork = catalog.admit_branch_fork(worker.join().unwrap()).unwrap();
    assert_eq!(fork.branch_id, "fork");
    assert_eq!(catalog.history("fork").unwrap().len(), 1);
    let context = catalog.active_context("fork").unwrap().unwrap();
    assert_eq!(context.proposal.effective_system_prompt, prompt);
    assert_eq!(
        context.proposal.memory_checkpoint.as_deref(),
        Some("original-notes")
    );
    assert_eq!(catalog.history("main").unwrap().len(), 2);
    assert_eq!(
        catalog
            .active_context("main")
            .unwrap()
            .unwrap()
            .proposal
            .effective_system_prompt,
        "later system"
    );
    let retry = catalog
        .prepare_branch_fork("main", "fork", Some(&receipt.input_id), None)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(catalog.admit_branch_fork(retry).unwrap(), fork);
    let stale = catalog
        .prepare_branch_fork("main", "stale-fork", Some(&receipt.input_id), None)
        .unwrap()
        .load()
        .unwrap();
    drop(catalog);
    let mut catalog = Catalog::open(&root).unwrap();
    assert!(catalog.admit_branch_fork(stale).is_err());
    assert!(catalog.head("stale-fork").is_err());
    assert_eq!(catalog.active_context("fork").unwrap().unwrap(), context);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}
