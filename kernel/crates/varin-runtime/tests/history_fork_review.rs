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
