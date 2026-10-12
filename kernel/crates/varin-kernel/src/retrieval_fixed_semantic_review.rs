//! Fixed semantic source producers through original Catalog history, without fabricated hits.
use super::*;
use base64::Engine;

fn results(history: &[ConversationItem]) -> Vec<&Value> {
    history
        .iter()
        .filter_map(|item| match &item.content {
            Content::ToolResult { result } => match &result.completion {
                ToolCompletion::Result { content, .. } => Some(&content.data),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn assert_source_result(result: &Value, fact: &Value, source: &str, count: usize) {
    assert_eq!(result["source"]["mode"], source, "{result}");
    assert_eq!(result["source"]["revision"], 0);
    let snippets = result["snippets"].as_array().unwrap();
    assert_eq!(snippets.len(), count, "{result}");
    for forbidden in [
        "FORBIDDEN_SOURCE",
        "LIVE_ONLY",
        "WRONG_LIVE",
        "WRONG_NEW_HEAD",
        "CHANGED_AFTER_HOST",
        "CHANGED_BEFORE_DOCUMENT_MODEL",
    ] {
        assert!(!result.to_string().contains(forbidden), "{result}");
    }
    for snippet in snippets {
        let path = snippet["path"].as_str().unwrap();
        let expected = &fact["expected"][path];
        let content = expected["content"].as_str().unwrap();
        for term in fact["question"].as_str().unwrap().split_whitespace() {
            assert!(
                !content.to_lowercase().contains(term),
                "semantic-only fixture has a lexical overlap"
            );
        }
        assert_eq!(snippet["revision"], expected["revision"], "{snippet}");
        let start = snippet["startLine"].as_u64().unwrap() as usize;
        let end = snippet["endLine"].as_u64().unwrap() as usize;
        let original = content
            .split('\n')
            .skip(start - 1)
            .take(end - start + 1)
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            snippet["content"].as_str().unwrap().as_bytes(),
            original.as_bytes(),
            "{snippet}"
        );
    }
}

// Opening both original stores follows actual owner destruction. It does not start a new
// Host/query or manufacture another request to replay already-settled paid work.
fn assert_reopen(review: Review, counts: &Value, stopped: bool) {
    let owner = review.f.runtime.catalog();
    let db = owner.lock().unwrap();
    let history = db.execution_history("branch:parent").unwrap();
    let launch = db
        .capture_launch(&review.run)
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
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
    let mut started = 0;
    let mut not_dispatched = 0;
    let mut ordinals = std::collections::BTreeMap::<String, u64>::new();
    for operation in &operations {
        let parent = operation.intent["parentOperationId"]
            .as_str()
            .unwrap()
            .to_owned();
        let ordinal = ordinals.entry(parent).or_default();
        *ordinal += 1;
        assert_eq!(operation.intent["ordinal"], *ordinal);
        assert!(matches!(
            operation.intent["binding"]["purpose"].as_str().unwrap(),
            "code-retrieval-document-embedding" | "code-retrieval-query-embedding"
        ));
        assert_eq!(operation.phase, OperationPhase::Terminal);
        let receipt = &operation.result.as_ref().unwrap().control().unwrap()["receipt"];
        assert_eq!(receipt["localExecutorStopped"], true);
        if receipt["requestStarted"] == false {
            assert_eq!(review.mode, "semantic-fixed-guard-stale");
            assert_eq!(receipt["problem"], "not_dispatched");
            not_dispatched += 1;
            continue;
        }
        assert_eq!(receipt["requestStarted"], true);
        started += 1;
        assert_eq!(receipt["usage"]["outputTokens"], Value::Null);
        if stopped {
            assert_eq!(
                operation.intent["binding"]["purpose"],
                "code-retrieval-document-embedding"
            );
            assert_eq!(receipt["usage"]["measurement"], "missing");
            assert_eq!(
                operation.outcome,
                Some(varin_runtime::Outcome::Indeterminate)
            );
        } else {
            assert_eq!(receipt["usage"]["inputTokens"], 7);
        }
    }
    assert_eq!(
        started,
        counts["documentRequests"].as_u64().unwrap()
            + counts["embeddingRequests"].as_u64().unwrap()
    );
    assert_eq!(
        not_dispatched,
        if review.mode == "semantic-fixed-guard-stale" {
            1
        } else {
            0
        },
        "the original admitted request remains after the last source guard rejects HTTP"
    );
    assert_eq!(usage.pending_inferences, 0);
    assert_eq!(usage.missing_inferences, if stopped { 1 } else { 0 });
    if !stopped {
        assert_eq!(usage.actual.input_tokens.known, 7 * started);
    }
    let workspace = review.tool_binding.workspace_id.clone();
    let execution = review.tool_binding.execution_workspace_id.clone();
    let run = review.run.clone();
    let root = review.root.clone();
    drop(db);
    drop(owner);
    drop(review);
    let db = Catalog::open(root.join("catalog")).unwrap();
    assert_eq!(db.execution_history("branch:parent").unwrap(), history);
    assert_eq!(
        db.capture_launch(&run).unwrap().unwrap().load().unwrap(),
        launch
    );
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
    let mut storage = Storage::open(&root.join("storage"), HOST).unwrap();
    storage
        .issue_grant(
            &json!({"grantId":"semantic-reopen", "hostGeneration":GENERATION,
        "capabilities":["storage.read"], "pathScopes":["allowed"], "owningWorkspace":workspace,
        "executionWorkspace":execution, "threadId":"thread:parent", "runId":run}),
            HOST,
            GENERATION,
            &root.join("storage").to_string_lossy(),
            EPOCH,
        )
        .unwrap();
    let mut read = |method: &str, params: Value| {
        let (grant, params) = storage
            .authorize(
                Some("semantic-reopen"),
                EPOCH,
                HOST,
                GENERATION,
                method,
                &params,
            )
            .unwrap();
        storage
            .dispatch(method, &params, Some("semantic-reopen"), &grant)
            .unwrap()
    };
    let branch = read(
        "branch.read",
        json!({"branchId":"source:retrieval", "revision":0, "paths":["allowed/a.ts"]}),
    );
    assert_eq!(branch["revision"], 0);
    assert!(branch["writeRevision"].as_u64().unwrap() > 0);
    assert_ne!(branch["currentRoot"], branch["root"]);
    let blob = read(
        "storage.getBlob",
        json!({"hash":branch["entries"][0]["state"]["objectHash"],
        "branchId":"source:retrieval", "revision":0, "path":"allowed/a.ts"}),
    );
    let bytes = base64::prelude::BASE64_STANDARD
        .decode(blob["bytesBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        bytes,
        "export const capsule = \"PINNED_MAGENTA_CAPSULE_紫\";\n".as_bytes()
    );
    assert!(!root.join("workspace").exists());
    drop(storage);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "actual fixed semantic units, publication, materialized CAS, Catalog and Storage over stdio"]
fn fixed_and_materialized_semantic_only_results_preserve_source_bytes_and_reuse_assets() {
    for (source, mode) in [
        ("fixed_branch", "semantic-fixed-cold"),
        ("fixed_branch", "semantic-fixed-warm"),
        ("materialized", "semantic-fixed-chain"),
    ] {
        let mut review = Review::with_source(mode, source);
        let counts = review.execute(false);
        let facts = counts["queryFacts"].as_array().unwrap();
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        let history = db.execution_history("branch:parent").unwrap();
        let delivered = results(&history);
        assert_eq!(delivered.len(), facts.len(), "{counts}");
        for (result, fact) in delivered.iter().zip(facts) {
            assert_source_result(result, fact, source, 3);
        }
        assert!(counts["fixedUnits"].as_u64().unwrap() > 0, "{counts}");
        assert!(counts["documentRequests"].as_u64().unwrap() > 0, "{counts}");
        assert!(counts["documentInputs"]
            .to_string()
            .contains(if source == "materialized" {
                "WORKING_MAGENTA_CAPSULE"
            } else {
                "PINNED_MAGENTA_CAPSULE"
            }));
        if mode == "semantic-fixed-warm" {
            assert!(counts["indexRequests"].as_u64().unwrap() > 0);
            assert!(!counts["ledgerFacts"].as_array().unwrap().is_empty());
            assert!(counts["backgroundInputs"]
                .to_string()
                .contains("FORBIDDEN_SOURCE"));
            assert!(counts["backgroundInputs"].to_string().contains("LIVE_ONLY"));
            assert!(counts["backgroundInputs"]
                .to_string()
                .contains("WRONG_LIVE_CAPSULE"));
            assert_eq!(
                counts["fixedUnits"], 1,
                "unchanged b/c reuse the real publication"
            );
            assert_eq!(
                counts["documentRequests"], 1,
                "only the fixed-only a.ts differs from the publication"
            );
        } else {
            assert_eq!(counts["indexRequests"], 0);
            assert!(
                counts["ledgerFacts"].as_array().unwrap().is_empty(),
                "foreground documents use Catalog, never index-build"
            );
        }
        assert!(counts["ledgerFacts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|fact| fact["identity"]["operation"]["kind"] == "index-build"));
        if mode == "semantic-fixed-chain" {
            assert_eq!(facts.len(), 4);
            assert_eq!(
                facts[1]["fixedUnits"], facts[0]["fixedUnits"],
                "new question reuses original units"
            );
            assert_eq!(
                facts[1]["documentRequests"], facts[0]["documentRequests"],
                "new question reuses document assets"
            );
            assert_eq!(facts[1]["embeddingRequests"], 2);
            assert_eq!(
                facts[2]["fixedUnits"].as_u64().unwrap(),
                facts[1]["fixedUnits"].as_u64().unwrap() + 1
            );
            assert_eq!(
                facts[2]["documentRequests"].as_u64().unwrap(),
                facts[1]["documentRequests"].as_u64().unwrap() + 1
            );
            assert_eq!(
                facts[2]["embeddingRequests"], 2,
                "same-account query vector remains reusable after document edit"
            );
            assert_eq!(facts[3]["fixedUnits"], facts[2]["fixedUnits"]);
            assert_eq!(
                facts[3]["documentRequests"], facts[2]["documentRequests"],
                "changing key does not re-embed document assets"
            );
            assert_eq!(
                facts[3]["embeddingRequests"], 3,
                "query cache retains its account partition"
            );
            assert_ne!(
                facts[0]["expected"]["allowed/a.ts"]["revision"],
                facts[2]["expected"]["allowed/a.ts"]["revision"]
            );
            assert!(delivered[0].to_string().contains("WORKING_MAGENTA_CAPSULE"));
            assert!(delivered[2].to_string().contains("EDITED_MAGENTA_CAPSULE"));
        }
        drop(db);
        drop(owner);
        assert_reopen(review, &counts, false);
    }
}

#[test]
#[ignore = "actual pre-model source guard and independent Host-to-Rust reconstruction windows over stdio"]
fn materialized_semantic_versions_guard_model_dispatch_and_final_projection_separately() {
    for mode in [
        "semantic-fixed-guard-stale",
        "semantic-fixed-projection-stale",
    ] {
        let mut review = Review::with_source(mode, "materialized");
        let counts = review.execute(false);
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        let history = db.execution_history("branch:parent").unwrap();
        let delivered = results(&history);
        assert_eq!(delivered.len(), 1, "{history:?}");
        let result = delivered[0];
        assert!(!result.to_string().contains("CHANGED_BEFORE_DOCUMENT_MODEL"));
        assert!(!result.to_string().contains("CHANGED_AFTER_HOST"));
        if mode == "semantic-fixed-guard-stale" {
            assert_eq!(counts["guardMutation"], true);
            assert_eq!(
                counts["documentRequests"], 2,
                "only the two unchanged files reach document HTTP"
            );
            let changed = counts["guardPath"].as_str().unwrap();
            let original = counts["queryFacts"][0]["expected"][changed]["content"]
                .as_str()
                .unwrap()
                .trim_end();
            assert!(
                !counts["documentInputs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|batch| batch.as_array().unwrap())
                    .any(|text| text.as_str().unwrap().contains(original)),
                "the actual changed path must be rejected before its document HTTP: {counts}"
            );
            assert_source_result(result, &counts["queryFacts"][0], "materialized", 2);
            assert!(result["snippets"]
                .as_array()
                .unwrap()
                .iter()
                .all(|snippet| snippet["path"] != changed));
            assert_eq!(result["status"], "partial");
        } else {
            assert_source_result(result, &counts["queryFacts"][0], "materialized", 2);
            assert!(result["snippets"]
                .as_array()
                .unwrap()
                .iter()
                .all(|snippet| snippet["path"] != "allowed/c.ts"));
            assert!(result["snippets"]
                .as_array()
                .unwrap()
                .iter()
                .any(|snippet| snippet["path"] == "allowed/a.ts"));
            assert_eq!(result["status"], "partial");
            assert!(result["omissions"]["stale"].as_u64().unwrap() > 0);
        }
        drop(db);
        drop(owner);
        assert_reopen(review, &counts, false);
    }
}

#[test]
#[ignore = "original foreground document HTTP cancellation, body drainage and both durable stores over stdio"]
fn stopped_fixed_document_embedding_settles_once_only_after_original_body_drains() {
    let mut review = Review::with_source("semantic-fixed-stop", "fixed_branch");
    let counts = review.execute(true);
    assert_eq!(counts["documentRequests"], 1);
    assert!(
        counts["lexicalSearches"].as_u64().unwrap() > 0,
        "the original keyword compute must enter while the document HTTP is held"
    );
    assert_eq!(
        counts["embeddingRequests"], 0,
        "held document preparation has not reached the query model"
    );
    assert_eq!(counts["indexRequests"], 0);
    assert_eq!(counts["drained"], true);
    assert!(counts["ledgerFacts"].as_array().unwrap().is_empty());
    let owner = review.f.runtime.catalog();
    let db = owner.lock().unwrap();
    assert_eq!(db.run(&review.run).unwrap().state, RunState::Cancelled);
    assert!(results(&db.execution_history("branch:parent").unwrap())
        .iter()
        .all(|result| result["snippets"].as_array().is_none_or(Vec::is_empty)));
    drop(db);
    drop(owner);
    assert_reopen(review, &counts, true);
}
