//! Original Storage sources, query pipeline, model egress and durable results over stdio.
//! The fixture publishes a retained source before diverging both its branch head and live path.
use super::*;

#[test]
#[ignore = "requires built Host packages; actual fixed/materialized Storage and controlled provider bytes over stdio"]
fn source_view_retrieval_uses_pinned_revision_or_actual_cas_working_copy() {
    for (source, mode) in [
        ("fixed_branch", "source"),
        ("fixed_branch", "rank"),
        ("fixed_branch", "decision-known"),
        ("materialized", "source"),
        ("materialized", "rank"),
        ("materialized", "stale"),
        ("materialized", "projection-stale"),
        ("fixed_branch", "syntax"),
        ("materialized", "semantic"),
    ] {
        let mut review = Review::with_source(mode, source);
        let counts = review.execute(false);
        assert_eq!(
            counts["requests"].as_u64().unwrap() == 0,
            matches!(mode, "source" | "syntax" | "semantic")
        );
        if matches!(mode, "syntax" | "semantic") {
            assert!(
                counts["syntaxComputations"].as_u64().unwrap() > 0,
                "original native grammar must actually parse admitted bytes"
            );
        }
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        let history = db.execution_history("branch:parent").unwrap();
        let result = history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == "retrieve" => {
                    match &result.completion {
                        ToolCompletion::Result { content, .. } => Some(&content.data),
                        _ => None,
                    }
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(result["source"]["mode"], source, "{result}");
        assert_eq!(result["source"]["revision"], 0);
        let serialized = result.to_string();
        for forbidden in ["FORBIDDEN_SOURCE", "WRONG_NEW_HEAD", "CHANGED_SOURCE_C"] {
            assert!(!serialized.contains(forbidden), "{source}/{mode}: {result}");
        }
        if mode == "decision-known" {
            assert!(serialized.contains("DISCOVERED_HELPER"), "{result}");
        } else {
            let snippets = result["snippets"].as_array().unwrap();
            let a = snippets
                .iter()
                .find(|item| item["path"] == "allowed/a.ts")
                .unwrap_or_else(|| panic!("tail after 64KiB must survive: {result}"));
            assert!(a["startLine"].as_u64().unwrap() > 3900);
            assert!(
                a["content"]
                    .as_str()
                    .unwrap()
                    .contains(if source == "materialized" {
                        "SOURCE_A_WORKING_COPY"
                    } else {
                        "SOURCE_A"
                    }),
                "{a}"
            );
            if matches!(mode, "stale" | "projection-stale") {
                assert!(
                    !snippets.iter().any(|item| item["path"] == "allowed/c.ts"),
                    "{result}"
                );
                assert_eq!(result["status"], "partial");
            } else {
                assert_eq!(snippets.len(), 3, "{result}");
            }
        }
        assert_eq!(
            db.capture_goal("rerank-goal")
                .unwrap()
                .load()
                .unwrap()
                .usage
                .pending_inferences,
            0
        );
        drop(db);
        let collection = owner
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default());
        assert_eq!(
            collection.run().status,
            varin_runtime::ContentCollectionStatus::Completed
        );
        let root = review.root.clone();
        drop(owner);
        drop(review);
        let reopened = Catalog::open(root.join("catalog")).unwrap();
        assert_eq!(
            reopened.execution_history("branch:parent").unwrap(),
            history
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "actual materialized query cancellation and independent original HTTP body drain over stdio"]
fn source_view_cancel_keeps_actual_model_body_pending_until_drain() {
    let mut review = Review::with_source("stop-body", "materialized");
    let counts = review.execute(true);
    assert_eq!(counts["requests"], 1);
    assert_eq!(counts["drained"], true);
    let owner = review.f.runtime.catalog();
    let db = owner.lock().unwrap();
    assert_eq!(db.run(&review.run).unwrap().state, RunState::Cancelled);
    assert_eq!(
        db.capture_goal("rerank-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage
            .pending_inferences,
        0
    );
    let root = review.root.clone();
    drop(db);
    drop(owner);
    drop(review);
    std::fs::remove_dir_all(root).unwrap();
}
