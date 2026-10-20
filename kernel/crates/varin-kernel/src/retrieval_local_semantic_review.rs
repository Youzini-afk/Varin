//! A cold retrieval never turns the installed encoder into a foreground index builder.
use super::*;
#[test]
#[ignore = "requires installed controlled component and original Catalog/Storage over stdio"]
fn cold_fixed_retrieval_keeps_the_local_component_idle_and_history_readable() {
    for source in ["fixed_branch", "materialized"] {
        let mut review = Review::with_source("semantic-local-cache", source);
        let counts = review.execute(false);
        assert_eq!(counts["localValidationCalls"], 1);
        assert_eq!(counts["retrievalCalls"], 2);
        assert_eq!(counts["localCalls"], json!([]));
        assert_eq!(counts["embeddingRequests"], 0);
        assert_eq!(counts["documentRequests"], 0);
        assert_eq!(counts["fixedUnits"], 0);
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        let history = db.execution_history("branch:parent").unwrap();
        assert!(history.iter().any(|item| matches!(&item.content, Content::ToolResult { result } if result.call_id == "retrieve")));
        assert!(!db.events_after(0, 10000).unwrap().iter().any(|event| event.kind == "inference.admitted"));
        let usage = db.capture_goal("rerank-goal").unwrap().load().unwrap().usage;
        assert_eq!(usage.pending_inferences, 0);
        assert_eq!(usage.estimated.inferences, 0);
        drop(db); let root = review.root.clone(); drop(owner); drop(review);
        let reopened = Catalog::open(root.join("catalog")).unwrap();
        assert_eq!(reopened.execution_history("branch:parent").unwrap(), history);
        drop(reopened); std::fs::remove_dir_all(root).unwrap();
    }
}
