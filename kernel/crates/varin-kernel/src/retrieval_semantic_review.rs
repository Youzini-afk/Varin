//! Original publication/source, query-owned Catalog inference and background ledger remain separate.
use super::*;
#[test]
#[ignore = "requires built Host packages; original semantic publication and Catalog over stdio"]
fn configured_semantic_and_rerank_share_original_session_and_preserve_usage_on_reopen() {
    for mode in [
        "semantic-rank",
        "semantic-budget",
        "semantic-invalid",
        "semantic-missing",
        "semantic-cold",
        "semantic-cache",
        "semantic-credential",
    ] {
        let mut review = Review::new(mode);
        let counts = review.execute(false);
        let cold = mode == "semantic-cold";
        assert_eq!(
            counts["embeddingRequests"],
            if cold {
                0
            } else if mode == "semantic-credential" {
                2
            } else {
                1
            },
            "{mode}: {counts}"
        );
        assert_eq!(
            counts["requests"],
            if mode == "semantic-rank" { 1 } else { 0 },
            "{mode}: {counts}"
        );
        if !cold {
            assert!(counts["indexRequests"].as_u64().unwrap() > 0);
            let facts = counts["ledgerFacts"].as_array().unwrap();
            assert!(!facts.is_empty());
            assert!(facts
                .iter()
                .all(|fact| fact["identity"]["operation"]["kind"] == "index-build"));
        }
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        let history = db.execution_history("branch:parent").unwrap();
        let usage = db
            .capture_goal("rerank-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage;
        let operations = db
            .events_after(0, 10000)
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "inference.admitted")
            .map(|event| {
                db.capture_operation_read(db.operation(&event.subject).unwrap())
                    .load()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            operations.len(),
            if cold {
                0
            } else if matches!(
                mode,
                "semantic-rank" | "semantic-credential" | "semantic-budget"
            ) {
                2
            } else {
                1
            },
            "{mode}: {operations:?}"
        );
        for (index, operation) in operations.iter().enumerate() {
            assert_eq!(
                operation.intent["ordinal"],
                if mode == "semantic-credential" {
                    1
                } else {
                    (index + 1) as u64
                }
            );
            assert_eq!(operation.phase, OperationPhase::Terminal);
            if mode != "semantic-credential" {
                assert_eq!(
                    operation.intent["parentOperationId"],
                    operations[0].intent["parentOperationId"]
                );
            }
        }
        if !cold {
            let embedding = &operations[0];
            assert_eq!(
                embedding.intent["binding"]["purpose"],
                "code-retrieval-query-embedding"
            );
            let state = embedding.result.as_ref().unwrap().control().unwrap();
            assert_eq!(state["receipt"]["localExecutorStopped"], true);
            assert_eq!(state["receipt"]["usage"]["outputTokens"], Value::Null);
            if mode == "semantic-missing" {
                assert_eq!(state["receipt"]["usage"]["measurement"], "missing");
            } else {
                assert_eq!(state["receipt"]["usage"]["inputTokens"], 7);
            }
            if mode == "semantic-invalid" {
                assert_eq!(state["receipt"]["problem"], "invalid_response");
            }
        }
        if matches!(mode, "semantic-cache" | "semantic-credential") {
            assert_eq!(counts["retrievalCalls"], 2);
        }
        assert_eq!(usage.pending_inferences, 0);
        if mode == "semantic-budget" {
            assert!(
                usage.actual.output_tokens.unknown_receipts > 0,
                "embedding output is not inferred from total tokens"
            );
            assert_eq!(
                operations[1].result.as_ref().unwrap().control().unwrap()["receipt"]
                    ["requestStarted"],
                false
            );
        }
        drop(db);
        let root = review.root.clone();
        drop(owner);
        drop(review);
        let db = Catalog::open(root.join("catalog")).unwrap();
        assert_eq!(db.execution_history("branch:parent").unwrap(), history);
        assert_eq!(
            db.capture_goal("rerank-goal")
                .unwrap()
                .load()
                .unwrap()
                .usage,
            usage
        );
        for operation in operations {
            assert_eq!(
                db.capture_operation_read(db.operation(&operation.id).unwrap())
                    .load()
                    .unwrap(),
                operation
            );
        }
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "requires original semantic query and delayed HTTP body over stdio"]
fn cancelled_semantic_query_keeps_original_request_pending_until_actual_body_stop() {
    let mut review = Review::new("semantic-stop");
    let counts = review.execute(true);
    assert_eq!(counts["embeddingRequests"], 1);
    assert_eq!(counts["drained"], true);
    let owner = review.f.runtime.catalog();
    let db = owner.lock().unwrap();
    let usage = db
        .capture_goal("rerank-goal")
        .unwrap()
        .load()
        .unwrap()
        .usage;
    assert_eq!(usage.pending_inferences, 0);
    assert_eq!(usage.missing_inferences, 1);
    let events = db.events_after(0, 10000).unwrap();
    let event = events
        .iter()
        .find(|event| event.kind == "inference.admitted")
        .unwrap();
    let operation = db
        .capture_operation_read(db.operation(&event.subject).unwrap())
        .load()
        .unwrap();
    assert_eq!(
        operation.outcome,
        Some(varin_runtime::Outcome::Indeterminate)
    );
    assert_eq!(
        operation.result.as_ref().unwrap().control().unwrap()["receipt"]["localExecutorStopped"],
        true
    );
    drop(db);
    let root = review.root.clone();
    drop(owner);
    drop(review);
    let db = Catalog::open(root.join("catalog")).unwrap();
    assert_eq!(
        db.capture_operation_read(db.operation(&operation.id).unwrap())
            .load()
            .unwrap(),
        operation
    );
    assert_eq!(
        db.capture_goal("rerank-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage,
        usage
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
