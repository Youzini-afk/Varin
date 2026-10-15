//! Original component installer/active selection, shared worker, native source and Catalog over stdio.
//! Run these heavy fixtures with --test-threads=1 to isolate the existing source parse budget.
use super::*;
#[test]
#[ignore = "requires built Host packages; real Node worker with controlled component model bytes, no ONNX quality claim"]
fn installed_local_encoder_serves_original_native_fixed_sources_and_reuses_cache() {
    for source in ["fixed_branch", "materialized"] {
        let mut review = Review::with_source("semantic-local-cache", source);
        let counts = review.execute(false);
        assert_eq!(counts["localValidationCalls"], 1);
        assert_eq!(counts["retrievalCalls"], 2);
        assert_eq!(counts["embeddingRequests"], 0, "local never uses HTTP");
        assert_eq!(
            counts["indexRequests"], 0,
            "foreground never borrows the index owner"
        );
        assert_eq!(counts["ledgerFacts"], json!([]));
        let facts = counts["queryFacts"].as_array().unwrap();
        assert_eq!(facts.len(), 2);
        assert_eq!(
            facts[0]["status"], "ready",
            "full-cache evidence requires complete first-source preparation: {counts}"
        );
        assert!(facts[0]["localCalls"].as_u64().unwrap() >= 2, "{counts}");
        assert_eq!(
            facts[0]["localCalls"], facts[1]["localCalls"],
            "cache hit is real zero compute"
        );
        let calls = counts["localCalls"].as_array().unwrap();
        assert!(calls
            .iter()
            .flat_map(|batch| batch.as_array().unwrap())
            .all(|text| !text.as_str().unwrap().contains("FORBIDDEN_SOURCE")));
        assert!(calls
            .iter()
            .flat_map(|batch| batch.as_array().unwrap())
            .any(|text| text.as_str().unwrap().contains("MAGENTA_CAPSULE")));
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        let history = db.execution_history("branch:parent").unwrap();
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
        assert_eq!(operations.len(), calls.len());
        assert!(operations.len() >= 2);
        let parent = operations[0].intent["parentOperationId"].clone();
        for (index, operation) in operations.iter().enumerate() {
            assert_eq!(operation.intent["parentOperationId"], parent);
            assert_eq!(operation.intent["ordinal"], index + 1);
            assert_eq!(
                operation.intent["binding"]["executor"]["kind"],
                "local_component"
            );
            assert!(operation.intent["binding"]["executor"]
                .get("endpoint")
                .is_none());
            assert!(operation.intent["binding"]["executor"]
                .get("credentialScope")
                .is_none());
            assert_eq!(operation.phase, OperationPhase::Terminal);
            let receipt = &operation.result.as_ref().unwrap().control().unwrap()["receipt"];
            assert_eq!(receipt["requestStarted"], true);
            assert_eq!(receipt["localExecutorStopped"], true);
            assert_eq!(receipt["usage"]["measurement"], "estimated");
            assert_eq!(receipt["usage"]["outputTokens"], 0);
            assert!(receipt["usage"]["inputTokens"].as_u64().unwrap() > 0);
        }
        let usage = db
            .capture_goal("rerank-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage;
        assert_eq!(usage.pending_inferences, 0);
        assert_eq!(usage.estimated.inferences, calls.len() as u64);
        assert_eq!(usage.missing_inferences, 0);
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
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "requires original child/source/Catalog owners and installed controlled component over stdio"]
fn installed_local_encoder_runs_under_the_real_child_source_and_parent_chain() {
    let mut review = Review::with_child_source("semantic-local-child", "fixed_branch");
    let accepted = child_review::dispatch(&mut review, "retrieval");
    let child = child_review::prepare_source(
        &mut review,
        &accepted,
        varin_runtime::SourceMode::FixedBranch,
    );
    child_review::select_child(&mut review, &child);
    let counts = review.execute(false);
    assert!(
        counts["localCalls"].as_array().unwrap().len() >= 2,
        "{counts}"
    );
    assert_eq!(counts["embeddingRequests"], 0);
    assert_eq!(counts["indexRequests"], 0);
    let owner = review.f.runtime.catalog();
    let db = owner.lock().unwrap();
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
    assert!(!operations.is_empty());
    for operation in operations {
        assert_eq!(operation.run_id, child.receipt.as_ref().unwrap().run_id);
        assert_eq!(
            operation.intent["binding"]["executor"]["kind"],
            "local_component"
        );
        assert_eq!(operation.outcome, Some(varin_runtime::Outcome::Succeeded));
    }
    let history = db.execution_history(&child.child_branch_id).unwrap();
    assert!(history.iter().any(|item| matches!(&item.content, Content::ToolResult { result } if result.call_id == "retrieve")));
    drop(db);
    let root = review.root.clone();
    drop(owner);
    drop(review);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires real shared Node worker and original native cancellation/Goal barrier over stdio"]
fn installed_local_encoder_cancellation_keeps_physical_and_catalog_evidence_separate() {
    for mode in ["semantic-local-queued", "semantic-local-stop"] {
        let mut review = Review::with_source(mode, "fixed_branch");
        let counts = review.execute(mode == "semantic-local-stop");
        assert_eq!(counts["embeddingRequests"], 0);
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
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
        assert!(!operations.is_empty());
        let last = operations.last().unwrap();
        let receipt = &last.result.as_ref().unwrap().control().unwrap()["receipt"];
        assert_eq!(receipt["localExecutorStopped"], true);
        let usage = db
            .capture_goal("rerank-goal")
            .unwrap()
            .load()
            .unwrap()
            .usage;
        assert_eq!(usage.pending_inferences, 0);
        assert_eq!(usage.missing_inferences, 0);
        if mode == "semantic-local-queued" {
            assert_eq!(operations.len(), 1);
            assert_eq!(receipt["requestStarted"], false);
            assert_eq!(usage.estimated.inferences, 0);
            assert_eq!(
                counts["localCalls"],
                json!([
                    ["HOLD_FORWARD independent-background"],
                    ["unrelated-after-cancel"]
                ])
            );
        } else {
            assert_eq!(counts["drained"], true);
            assert_eq!(receipt["requestStarted"], true);
            assert_eq!(receipt["providerCompleted"], true);
            assert_eq!(receipt["usage"]["measurement"], "estimated");
            assert_eq!(usage.estimated.inferences, operations.len() as u64);
            assert!(
                last.result.as_ref().unwrap().control().unwrap()["response"]["vectors"].is_array(),
                "late original vectors survive observer cancellation"
            );
        }
        drop(db);
        let root = review.root.clone();
        drop(owner);
        drop(review);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
#[ignore = "requires installed controlled component and original per-grain Catalog receipts over stdio"]
fn installed_local_encoder_keeps_success_and_error_evidence_for_a_partial_source_batch() {
    let mut review = Review::with_source("semantic-local-partial", "fixed_branch");
    let counts = review.execute(false);
    let owner = review.f.runtime.catalog();
    let db = owner.lock().unwrap();
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
        counts["localCalls"].as_array().unwrap().len()
    );
    assert!(operations.len() >= 3);
    let errors = operations
        .iter()
        .filter(|operation| operation.outcome == Some(varin_runtime::Outcome::Failed))
        .collect::<Vec<_>>();
    assert_eq!(errors.len(), 1);
    let error = errors[0].result.as_ref().unwrap().control().unwrap();
    assert_eq!(error["response"]["error"], "Controlled encoder failure");
    assert_eq!(error["receipt"]["usage"]["measurement"], "estimated");
    assert!(operations
        .iter()
        .any(|operation| operation.outcome == Some(varin_runtime::Outcome::Succeeded)));
    let usage = db
        .capture_goal("rerank-goal")
        .unwrap()
        .load()
        .unwrap()
        .usage;
    assert_eq!(usage.estimated.inferences, operations.len() as u64);
    assert_eq!(usage.pending_inferences, 0);
    assert_eq!(usage.missing_inferences, 0);
    drop(db);
    let root = review.root.clone();
    drop(owner);
    drop(review);
    std::fs::remove_dir_all(root).unwrap();
}
