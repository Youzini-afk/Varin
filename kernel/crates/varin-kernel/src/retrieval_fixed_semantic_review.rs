//! Fixed semantic source producers through original Catalog history, without fabricated hits.
use super::*;
use base64::Engine;

fn results(history: &[std::sync::Arc<ConversationItem>]) -> Vec<&Value> {
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
#[ignore = "actual published semantic reader, original source and Catalog/Storage over stdio"]
fn source_queries_use_existing_publications_without_foreground_index_builds() {
    for (source, mode, expected) in [
        ("fixed_branch", "semantic-fixed-cold", 0),
        ("fixed_branch", "semantic-fixed-warm", 2),
        ("materialized", "semantic-fixed-chain", 0),
    ] {
        let mut review = Review::with_source(mode, source);
        let counts = review.execute(false);
        assert_eq!(counts["fixedUnits"], 0, "no range-wide foreground structure work: {counts}");
        assert_eq!(counts["documentRequests"], 0, "queries never build missing document vectors: {counts}");
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        let history = db.execution_history("branch:parent").unwrap();
        let delivered = results(&history);
        let facts = counts["queryFacts"].as_array().unwrap();
        assert_eq!(delivered.len(), facts.len());
        for (result, fact) in delivered.iter().zip(facts) {
            assert_source_result(result, fact, source, expected);
            assert!(result["coverage"]["semantic"] == "empty" || result["coverage"]["semantic"] == "partial");
        }
        if mode == "semantic-fixed-warm" {
            assert!(counts["embeddingRequests"].as_u64().unwrap() > 0);
            assert!(!delivered[0].to_string().contains("WRONG_LIVE"));
        } else {
            assert_eq!(counts["embeddingRequests"], 0);
        }
        drop(db); drop(owner);
        assert_reopen(review, &counts, false);
    }
}
