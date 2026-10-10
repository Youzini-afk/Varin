#[path = "../tests/fixtures/content_collection.rs"]
mod content_collection;
use super::*;
use crate::test_submission::InputAdmission;
use std::path::PathBuf;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-runtime-test-{}", id())))
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn submit(db: &mut Catalog) -> Receipt {
    db.create_thread("thread", "main").unwrap();
    db.submit(&command()).unwrap()
}
fn command() -> SubmitInput {
    SubmitInput {
        key: "input-1".into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        expected_head: None,
        input: json!({"text":"hello"}),
        configuration: json!({"provider":"test"}),
    }
}
#[test]
fn admission_is_durable_and_idempotent() {
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    assert_eq!(receipt, db.submit(&command()).unwrap());
    let mut changed = command();
    changed.input = json!("different");
    assert!(matches!(
        db.submit(&changed),
        Err(RuntimeError::Conflict(_))
    ));
    assert_eq!(db.run(&receipt.run_id).unwrap().state, RunState::Accepted);
    assert!(db
        .events_after(0, 100)
        .unwrap()
        .iter()
        .any(|e| e.kind == "run.accepted" && e.cursor == receipt.cursor));
    drop(db);
    let mut db = f.open();
    assert_eq!(receipt, db.submit(&command()).unwrap());
    assert_eq!(db.history("main").unwrap().len(), 1);
}
#[test]
fn branch_cas_and_opaque_history_survive_restart() {
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let epoch = db.epoch();
    let original = ProviderOriginal {
        connection_identity: "fixture-connection".into(),
        adapter: "responses".into(),
        version: "1".into(),
        item: json!({"type":"reasoning","encrypted_content":"opaque","signature":{"nested":[null,42]}}),
    };
    let item = db
        .append_history(
            &receipt.run_id,
            epoch,
            Some(&receipt.input_id),
            HistorySource::Assistant,
            json!({"text":"shown"}),
            Some(original.clone()),
        )
        .unwrap();
    assert!(db
        .append_history(
            &receipt.run_id,
            epoch,
            Some(&receipt.input_id),
            HistorySource::Assistant,
            Value::Null,
            None
        )
        .is_err());
    db.fork_branch("main", "fork", Some(&receipt.input_id))
        .unwrap();
    assert_eq!(db.history("fork").unwrap().len(), 1);
    drop(db);
    let db = f.open();
    assert_eq!(db.history("main").unwrap().last(), Some(&item));
    assert_eq!(
        db.history("main").unwrap()[1].provider.as_ref(),
        Some(&original)
    );
}
#[test]
fn failed_initial_install_leaves_no_partial_catalog_and_can_reopen() {
    let f = Fixture::new();
    std::fs::create_dir_all(&f.0).unwrap();
    let mut raw = Connection::open(f.0.join("conversation.sqlite")).unwrap();
    let content = crate::content::ContentStore::open(f.0.join("content")).unwrap();
    // Actual SQLite capacity failure, not a mocked installation path.
    raw.pragma_update(None, "max_page_count", 2).unwrap();
    assert!(initialize_metadata(&mut raw, 0, &content).is_err());
    assert_eq!(inspect_catalog_format(&raw).unwrap(), 0);
    let tables: i64 = raw
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
    raw.pragma_update(None, "max_page_count", 1_000_000)
        .unwrap();
    drop(raw);
    let mut db = f.open();
    let receipt = submit(&mut db);
    drop(db);
    let db = f.open();
    assert_eq!(db.run(&receipt.run_id).unwrap().state, RunState::Accepted);
    assert_eq!(db.history("main").unwrap().len(), 1);
}
#[test]
fn single_writer_and_unknown_formats_preserve_assets() {
    let f = Fixture::new();
    let db = f.open();
    assert!(matches!(
        Catalog::open(&f.0),
        Err(RuntimeError::Conflict(_))
    ));
    drop(db);
    let raw = Connection::open(f.0.join("conversation.sqlite")).unwrap();
    raw.pragma_update(None, "user_version", 999).unwrap();
    drop(raw);
    assert!(matches!(
        Catalog::open(&f.0),
        Err(RuntimeError::Format(999))
    ));
    let raw = Connection::open(f.0.join("conversation.sqlite")).unwrap();
    assert_eq!(
        raw.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        999
    );
    raw.pragma_update(None, "user_version", FORMAT).unwrap();
    raw.execute(
        "UPDATE runtime_domains SET version=999 WHERE name='input_queue'",
        [],
    )
    .unwrap();
    let epoch: i64 = raw
        .query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(matches!(Catalog::open(&f.0), Err(RuntimeError::Invalid(_))));
    assert_eq!(
        raw.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        epoch
    );
}
#[test]
fn cancellation_is_a_request_and_dispatched_unknown_is_not_replayed() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    db.admit_operation(
        "op",
        &r.run_id,
        epoch,
        Lifetime::Run,
        json!({"click":"button"}),
    )
    .unwrap();
    db.dispatch_operation("op", epoch, "desktop-1", true)
        .unwrap();
    let cancelled = db.request_cancel_operation("op").unwrap();
    assert!(cancelled.cancel_requested);
    assert_eq!(cancelled.outcome, None);
    assert_eq!(cancelled.effect, Effect::Dispatched);
    assert!(db
        .settle_operation("op", epoch, Outcome::Cancelled, Effect::None, Value::Null)
        .is_err());
    drop(db);
    let mut db = f.open();
    let recovered = db.operation("op").unwrap();
    assert_eq!(recovered.outcome, Some(Outcome::Indeterminate));
    assert_eq!(recovered.effect, Effect::Unknown);
    assert!(db
        .dispatch_operation("op", db.epoch(), "desktop-1", true)
        .is_err());
    assert!(db
        .settle_operation(
            "op",
            epoch,
            Outcome::Succeeded,
            Effect::Confirmed,
            Value::Null
        )
        .is_err());
}
#[test]
fn accepted_operations_can_resume_but_old_epoch_cannot_dispatch() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let old = db.epoch();
    db.admit_operation("op", &r.run_id, old, Lifetime::Run, Value::Null)
        .unwrap();
    drop(db);
    let mut db = f.open();
    assert!(db.dispatch_operation("op", old, "local", false).is_err());
    db.dispatch_operation("op", db.epoch(), "local", false)
        .unwrap();
    db.settle_operation(
        "op",
        db.epoch(),
        Outcome::Succeeded,
        Effect::None,
        json!("done"),
    )
    .unwrap();
}
#[test]
fn foreground_must_settle_but_explicit_thread_job_can_outlive_run() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    let run = db
        .transition_run(&r.run_id, epoch, 1, RunState::Runnable)
        .unwrap();
    db.admit_operation("op", &r.run_id, epoch, Lifetime::Thread, Value::Null)
        .unwrap();
    assert!(db
        .transition_run(&r.run_id, epoch, run.revision, RunState::Completed)
        .is_err());
    db.handoff_operation("op", epoch).unwrap();
    db.transition_run(&r.run_id, epoch, run.revision, RunState::Completed)
        .unwrap();
    db.dispatch_operation("op", epoch, "background", false)
        .unwrap();
    db.settle_operation(
        "op",
        epoch,
        Outcome::Succeeded,
        Effect::None,
        json!("background result"),
    )
    .unwrap();
}
#[test]
fn wait_registration_checks_past_events_and_claims_once() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    db.admit_operation("op", &r.run_id, epoch, Lifetime::Run, Value::Null)
        .unwrap();
    db.settle_operation("op", epoch, Outcome::Succeeded, Effect::None, json!("done"))
        .unwrap();
    let wait = db
        .register_wait("wait", &r.run_id, "op", "operation.settled", r.cursor)
        .unwrap();
    assert!(wait.trigger_cursor.is_some());
    db.commit_execution(
        &r.run_id,
        epoch,
        &crate::execution::ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &crate::execution::ExecutionRecord::StateChanged {
            state: RunState::Waiting,
            waiting_on: Some("wait".into()),
        },
    )
    .unwrap();
    assert!(db.claim_resumption("wait", epoch).unwrap());
    assert!(!db.claim_resumption("wait", epoch).unwrap());
    drop(db);
    let mut db = f.open();
    assert!(db.claim_resumption("wait", db.epoch()).unwrap());
    db.complete_resumption("wait", db.epoch()).unwrap();
    drop(db);
    let mut db = f.open();
    assert!(!db.claim_resumption("wait", db.epoch()).unwrap());
}
#[test]
fn cancelling_observation_does_not_cancel_observed_job() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    db.admit_operation("op", &r.run_id, epoch, Lifetime::Thread, Value::Null)
        .unwrap();
    db.register_wait("wait", &r.run_id, "op", "operation.settled", r.cursor)
        .unwrap();
    db.cancel_wait("wait").unwrap();
    assert!(!db.operation("op").unwrap().cancel_requested);
    db.settle_operation("op", epoch, Outcome::Succeeded, Effect::None, Value::Null)
        .unwrap();
    assert_eq!(db.reconcile_waits().unwrap(), 0);
    assert!(!db.claim_resumption("wait", epoch).unwrap());
}
#[test]
fn dispatched_model_is_interrupted_and_not_sent_again() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    db.prepare_model_step(
        "step",
        &r.run_id,
        epoch,
        json!({"model":"test","history":["hello"]}),
    )
    .unwrap();
    db.dispatch_model_step("step", epoch).unwrap();
    drop(db);
    let mut db = f.open();
    assert_eq!(
        db.model_step("step").unwrap().state,
        ModelStepState::Interrupted
    );
    assert!(db.dispatch_model_step("step", db.epoch()).is_err());
    assert_eq!(db.model_step("step").unwrap().usage, None);
}
#[test]
fn delivery_cannot_commit_a_fact_before_send() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    assert!(db
        .set_delivery("model", r.cursor, "request", DeliveryState::Committed)
        .is_err());
    db.set_delivery("model", r.cursor, "request", DeliveryState::Selected)
        .unwrap();
    db.set_delivery("model", r.cursor, "request", DeliveryState::Sent)
        .unwrap();
    db.set_delivery("model", r.cursor, "request", DeliveryState::Committed)
        .unwrap();
    db.set_delivery("model", r.cursor, "request", DeliveryState::Committed)
        .unwrap();
    assert!(db
        .set_delivery("model", r.cursor, "request", DeliveryState::Selected)
        .is_err());
}

fn request_snapshot(receipt: &Receipt) -> crate::execution::RequestSnapshot {
    use crate::execution::*;
    RequestSnapshot {
        view: RequestView {
            request_id: "model-1".into(),
            run_id: receipt.run_id.clone(),
            origin: RequestOrigin::Conversation {
                step: 1,
                history_range: HistoryRange {
                    branch_id: receipt.branch_id.clone(),
                    ancestor_id: None,
                    leaf_id: Some(receipt.input_id.clone()),
                },
            },
            binding: RequestBinding {
                connection_identity: "fixture-connection".into(),
                provider_family: "test".into(),
                model: "mock".into(),
                credential_ref: None,
                configuration_generation: 1,
                tool_schema_generation: 1,
                tools: vec![],
                instruction_sources: vec![],
                memory_checkpoint: None,
                attachment_refs: vec![],
                environment_cursor: 0,
                history_range: HistoryRange {
                    branch_id: receipt.branch_id.clone(),
                    ancestor_id: None,
                    leaf_id: Some(receipt.input_id.clone()),
                },
            },
            history: vec![],
        },
        serialized: json!({"model":"mock"}),
    }
}
#[test]
fn model_output_and_history_are_one_commit_and_reject_stale_heads() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    let snapshot = request_snapshot(&r);
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared {
            snapshot: snapshot.clone(),
        },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "model-1".into(),
        },
    )
    .unwrap();
    let item = ProviderItem {
        id: "answer".into(),
        content: Content::Text {
            text: "hello back".into(),
        },
        opaque: Some(OpaqueProviderItem {
            connection_identity: "fixture-connection".into(),
            family: "test".into(),
            adapter_version: "1".into(),
            value: json!({"signature":"original"}),
        }),
    };
    db.append_history(
        &r.run_id,
        epoch,
        Some(&r.input_id),
        HistorySource::Environment,
        json!({"changed":true}),
        None,
    )
    .unwrap();
    let finish = ExecutionRecord::ModelFinished {
        request_id: "model-1".into(),
        outcome: ModelOutcome::Completed,
        finish_reason: Some(FinishReason::Stop),
        items: vec![item],
        interrupted_deltas: vec![],
        usage: UsageReceipt::default(),
        failure: None,
    };
    assert!(matches!(
        db.commit_execution(&r.run_id, epoch, &finish),
        Err(RuntimeError::Conflict(_))
    ));
    assert_eq!(
        db.model_step("model-1").unwrap().state,
        ModelStepState::Dispatched
    );
    assert!(!db.history("main").unwrap().iter().any(|i| i.id == "answer"));
}
#[test]
fn completed_model_history_is_durable_without_a_second_append() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared {
            snapshot: request_snapshot(&r),
        },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "model-1".into(),
        },
    )
    .unwrap();
    let original = json!({"opaque":{"nested":[false,"original"]}});
    let item = ProviderItem {
        id: "answer".into(),
        content: Content::Text {
            text: "hello back".into(),
        },
        opaque: Some(OpaqueProviderItem {
            connection_identity: "fixture-connection".into(),
            family: "test".into(),
            adapter_version: "1".into(),
            value: original.clone(),
        }),
    };
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "model-1".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::Stop),
            items: vec![item],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    drop(db);
    let db = f.open();
    assert_eq!(
        db.model_step("model-1").unwrap().state,
        ModelStepState::Completed
    );
    assert_eq!(
        db.execution_history("main")
            .unwrap()
            .last()
            .unwrap()
            .opaque
            .as_ref()
            .unwrap()
            .value,
        original
    );
}

#[test]
fn structured_user_attachment_cannot_silently_disappear_from_execution_history() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let mut input = command();
    input.input = json!({"text":"inspect this image","attachments":[{"media_type":"image/png","content_ref":"content:example"}]});
    db.submit(&input).unwrap();
    match db.execution_history("main") {
        Err(_) => {} // A typed unsupported input failure is acceptable until attachment binding exists.
        Ok(items) => assert!(
            items
                .iter()
                .any(|item| matches!(item.content, crate::execution::Content::Attachment { .. })),
            "accepted attachment was silently reduced to text before request compilation"
        ),
    }
}

#[test]
fn tool_batch_receipt_cannot_cross_between_two_active_runs() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut db = f.open();
    let original = submit(&mut db);
    let epoch = db.epoch();
    let mut snapshot = request_snapshot(&original);
    snapshot.view.binding.tools = vec![ToolSchema {
        description: String::new(),
        output_schema: None,
        metadata: None,
        name: "read".into(),
        version: "1".into(),
        schema: json!({"type":"object"}),
    }];
    db.commit_execution(
        &original.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared { snapshot },
    )
    .unwrap();
    db.commit_execution(
        &original.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "model-1".into(),
        },
    )
    .unwrap();
    let call = ToolCall {
        call_id: "call-1".into(),
        name: "read".into(),
        schema_version: "1".into(),
        arguments: json!({}),
    };
    db.commit_execution(
        &original.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "model-1".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "call-item".into(),
                content: Content::ToolCall { call },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    db.create_thread("other-thread", "other-branch").unwrap();
    let mut other = command();
    other.key = "other-input".into();
    other.thread_id = "other-thread".into();
    other.branch_id = "other-branch".into();
    let other = db.submit(&other).unwrap();
    let receipt = ExecutionRecord::ToolBatchCommitted {
        request_id: "model-1".into(),
        results: vec![ToolResult {
            request_id: "model-1".into(),
            call_id: "call-1".into(),
            completion: ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content: json!("belongs to first run"),
            },
        }],
    };
    assert!(
        db.commit_execution(&other.run_id, epoch, &receipt).is_err(),
        "another active run accepted and consumed this run's tool receipt"
    );
    assert_eq!(db.history("other-branch").unwrap().len(), 1);
}

#[test]
fn unfinished_model_tool_exchange_cannot_complete_a_run() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    let run = db
        .transition_run(&r.run_id, epoch, 1, RunState::Runnable)
        .unwrap();
    let mut snapshot = request_snapshot(&r);
    snapshot.view.binding.tools = vec![ToolSchema {
        description: String::new(),
        output_schema: None,
        metadata: None,
        name: "read".into(),
        version: "1".into(),
        schema: json!({"type":"object"}),
    }];
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared { snapshot },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "model-1".into(),
        },
    )
    .unwrap();
    let call = ToolCall {
        call_id: "call-1".into(),
        name: "read".into(),
        schema_version: "1".into(),
        arguments: json!({}),
    };
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "model-1".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "call-item".into(),
                content: Content::ToolCall { call },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    assert!(db
        .transition_run(&r.run_id, epoch, run.revision, RunState::Completed)
        .is_err());
    assert!(db
        .commit_execution(
            &r.run_id,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Completed,
                waiting_on: None
            }
        )
        .is_err());
    assert_eq!(db.run(&r.run_id).unwrap().state, RunState::Runnable);
}

fn external(op: &str, outcome: Outcome, effect: Effect) -> ExternalReceipt {
    ExternalReceipt {
        executor: "process-executor".into(),
        identity: op.into(),
        epoch: "resource-epoch".into(),
        outcome,
        effect,
        result: json!({"exitCode":0}),
    }
}
#[test]
fn external_terminal_before_explicit_handoff_is_not_lost() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    db.admit_operation(
        "job",
        &r.run_id,
        epoch,
        Lifetime::Thread,
        json!({"command":"true"}),
    )
    .unwrap();
    db.dispatch_operation("job", epoch, "process-executor", true)
        .unwrap();
    let receipt = external("job", Outcome::Succeeded, Effect::Confirmed);
    let early = db.record_external_receipt("job", receipt.clone()).unwrap();
    assert_eq!(early.phase, OperationPhase::Running);
    db.handoff_operation("job", epoch).unwrap();
    let settled = db.operation("job").unwrap();
    assert_eq!(
        settled.phase,
        OperationPhase::Terminal,
        "early terminal was buffered but never applied at explicit handoff"
    );
    assert_eq!(settled.outcome, Some(Outcome::Succeeded));
    assert_eq!(db.record_external_receipt("job", receipt).unwrap(), settled);
}
#[test]
fn external_receipts_are_idempotent_and_only_same_epoch_unknown_can_refine() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    db.admit_operation("job", &r.run_id, epoch, Lifetime::Thread, Value::Null)
        .unwrap();
    db.dispatch_operation("job", epoch, "process-executor", true)
        .unwrap();
    db.handoff_operation("job", epoch).unwrap();
    let mut unknown = external("job", Outcome::Indeterminate, Effect::Unknown);
    let unknown_body =
        json!({"permission":{"opaque":true},"unknown":"lost-reply-original".repeat(20000)});
    unknown.result = unknown_body.clone();
    let observed = db.record_external_receipt("job", unknown.clone()).unwrap();
    assert_eq!(
        db.record_external_receipt("job", unknown).unwrap(),
        observed
    );
    let mut foreign = external("job", Outcome::Succeeded, Effect::Confirmed);
    foreign.epoch = "wrong-generation".into();
    assert!(db.record_external_receipt("job", foreign).is_err());
    let mut confirmed = external("job", Outcome::Succeeded, Effect::Confirmed);
    let confirmed_body = json!({"exitCode":0,"opaque":"confirmed-original".repeat(20000)});
    confirmed.result = confirmed_body.clone();
    let settled = db
        .record_external_receipt("job", confirmed.clone())
        .unwrap();
    assert_eq!(settled.outcome, Some(Outcome::Succeeded));
    assert_eq!(
        db.record_external_receipt("job", confirmed.clone())
            .unwrap(),
        settled
    );
    let mut conflicting = confirmed;
    conflicting.result = json!({"exitCode":7});
    assert!(db.record_external_receipt("job", conflicting).is_err());
    let mut wrong = external("other-job", Outcome::Succeeded, Effect::Confirmed);
    assert!(db.record_external_receipt("job", wrong.clone()).is_err());
    wrong.identity = "job".into();
    wrong.executor = "other-executor".into();
    assert!(db.record_external_receipt("job", wrong).is_err());
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    let metadata = db.operation("job").unwrap();
    assert!(serde_json::to_vec(&metadata).unwrap().len() < 2048);
    assert_eq!(
        db.capture_operation_read(metadata).load().unwrap().result,
        Some(confirmed_body.clone())
    );
    let events = db.capture_events_read(0, 1000).unwrap().load().unwrap();
    assert!(
        events
            .iter()
            .any(|event| event.data["external_receipt"]["result"] == unknown_body),
        "refinement must retain the original uncertain executor evidence"
    );
    drop(db);
    let db = f.open();
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    assert_eq!(
        db.capture_operation_read(db.operation("job").unwrap())
            .load()
            .unwrap()
            .result,
        Some(confirmed_body)
    );
    let events = db.capture_events_read(0, 1000).unwrap().load().unwrap();
    assert!(events
        .iter()
        .any(|event| event.data["external_receipt"]["result"] == unknown_body));
}
#[test]
fn early_external_terminal_and_model_job_acceptance_converge() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    let mut snapshot = request_snapshot(&r);
    snapshot.view.binding.tools = vec![ToolSchema {
        description: String::new(),
        output_schema: None,
        metadata: None,
        name: "process-executor".into(),
        version: "1".into(),
        schema: json!({"type":"object"}),
    }];
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared { snapshot },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "model-1".into(),
        },
    )
    .unwrap();
    let call = ToolCall {
        call_id: "job".into(),
        name: "process-executor".into(),
        schema_version: "1".into(),
        arguments: json!({}),
    };
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "model-1".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "job-call".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    db.commit_execution(&r.run_id, epoch, &{
        let tool = AdmittedTool {
            call,
            contract: ToolContract {
                name: "process-executor".into(),
                schema_version: "1".into(),
                read_only: false,
                completion: CompletionKind::Job,
                lifetime: Lifetime::Thread,
                resources: vec![],
            },
        };
        ExecutionRecord::ToolAdmitted {
            context: {
                let request_id: String = "model-1".into();
                let call_id: String = tool.call.call_id.clone();
                varin_runtime::execution::ToolExecutionContext {
                    run_id: (&r.run_id).to_string(),
                    operation_id: format!("{request_id}:tool:{call_id}"),
                    origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                }
            },
            tool,
        }
    })
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolDispatched {
            executor_owner: varin_runtime::ExecutorOwner::Kernel,
            context: {
                let request_id: String = "model-1".into();
                let call_id: String = "job".into();
                varin_runtime::execution::ToolExecutionContext {
                    run_id: (&r.run_id).to_string(),
                    operation_id: format!("{request_id}:tool:{call_id}"),
                    origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                }
            },
        },
    )
    .unwrap();
    let operation_id = "model-1:tool:job";
    db.register_wait(
        "job-wait",
        &r.run_id,
        operation_id,
        "operation.settled",
        r.cursor,
    )
    .unwrap();
    let receipt = external(operation_id, Outcome::Succeeded, Effect::Confirmed);
    db.record_external_receipt(operation_id, receipt.clone())
        .unwrap();
    let result = ToolResult {
        request_id: "model-1".into(),
        call_id: "job".into(),
        completion: ToolCompletion::JobAccepted {
            operation_id: operation_id.into(),
            phase: "accepted".into(),
            effect: Effect::Dispatched,
            lifetime: Lifetime::Thread,
        },
    };
    db.commit_execution(&r.run_id, epoch, &{
        let result = result.clone();
        ExecutionRecord::ToolSettled {
            executor_stopped: false,
            context: {
                let request_id: String = result.request_id.clone();
                let call_id: String = result.call_id.clone();
                varin_runtime::execution::ToolExecutionContext {
                    run_id: (&r.run_id).to_string(),
                    operation_id: format!("{request_id}:tool:{call_id}"),
                    origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                }
            },
            completion: result.completion,
        }
    })
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolBatchCommitted {
            request_id: "model-1".into(),
            results: vec![result],
        },
    )
    .unwrap();
    assert!(
        db.pending_resumptions()
            .unwrap()
            .iter()
            .any(|id| id == "job-wait"),
        "early receipt followed by model handoff never woke the durable waiter"
    );
    let settled = db.operation(operation_id).unwrap();
    assert_eq!(settled.phase, OperationPhase::Terminal);
    assert_eq!(settled.effect, Effect::Confirmed);
    assert_eq!(
        db.record_external_receipt(operation_id, receipt).unwrap(),
        settled
    );
}

#[test]
fn later_external_confirmation_resolves_lost_acceptance_receipt_without_handoff() {
    for (outcome, effect) in [
        (Outcome::Succeeded, Effect::Confirmed),
        (Outcome::Failed, Effect::None),
    ] {
        for persisted_before_crash in [false, true] {
            let f = Fixture::new();
            let mut db = f.open();
            let r = submit(&mut db);
            let epoch = db.epoch();
            db.admit_operation("job", &r.run_id, epoch, Lifetime::Thread, Value::Null)
                .unwrap();
            db.dispatch_operation("job", epoch, "process-executor", true)
                .unwrap();
            db.register_wait(
                "receipt-wait",
                &r.run_id,
                "job",
                "operation.settled",
                r.cursor,
            )
            .unwrap();
            let mut receipt = external("job", outcome, effect);
            receipt.result = json!({"original":"executor evidence", "outcome":outcome,"opaque":[null,"原始",17]});
            if persisted_before_crash {
                // The executor fact committed, but the model's ToolSettled/handoff did not.
                let early = db.record_external_receipt("job", receipt.clone()).unwrap();
                assert_eq!(
                    (early.phase, early.effect),
                    (OperationPhase::Running, Effect::Dispatched)
                );
                assert!(db.pending_resumptions().unwrap().is_empty());
                drop(db);
                db = f.open();
            } else {
                db.settle_operation(
                    "job",
                    epoch,
                    Outcome::Indeterminate,
                    Effect::Unknown,
                    json!({"reason":"acceptance response lost"}),
                )
                .unwrap();
            }
            let interrupted = db.operation("job").unwrap();
            assert!(!interrupted.handed_off);
            assert_eq!(
                (interrupted.outcome, interrupted.effect),
                (Some(Outcome::Indeterminate), Effect::Unknown)
            );
            let confirmed = db.record_external_receipt("job", receipt.clone()).unwrap();
            assert_eq!(
                (confirmed.phase, confirmed.outcome, confirmed.effect),
                (OperationPhase::Terminal, Some(outcome), effect)
            );
            assert_eq!(confirmed.revision, interrupted.revision + 1);
            assert_eq!(
                db.capture_operation_read(confirmed.clone())
                    .load()
                    .unwrap()
                    .result,
                Some(receipt.result.clone())
            );
            assert!(db
                .pending_resumptions()
                .unwrap()
                .iter()
                .any(|wait| wait == "receipt-wait"));
            // Replaying an applied fact is genuinely idempotent, including its event cursor.
            let cursor = db.event_cursor().unwrap();
            assert_eq!(
                db.record_external_receipt("job", receipt).unwrap(),
                confirmed
            );
            assert_eq!(db.event_cursor().unwrap(), cursor);
        }
    }
}

#[test]
fn prepared_inputs_preserve_original_intents_and_only_retry_changed_queue_material() {
    use crate::catalog::inputs::EnqueueInput;
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let epoch = db.epoch();
    let command = EnqueueInput {
        key: "body-input".into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        mode: InputMode::Boundary,
        input: json!({"text":"original 中文🎉".repeat(10000)}),
        configuration: None,
    };
    let prepared = db.prepare_enqueue(command.clone()).load().unwrap();
    let queued = db.admit_queued_input(prepared).unwrap();
    let stored: String = db
        .db
        .query_row(
            "SELECT body FROM input_queue WHERE id=?1",
            [&queued.input_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(stored.len() < 1024);
    assert!(!stored.contains("original"));
    let intent: String = db
        .db
        .query_row(
            "SELECT intent FROM commands WHERE id=?1",
            [&command.key],
            |row| row.get(0),
        )
        .unwrap();
    assert!(intent.len() < 256);
    let first = db
        .prepare_input_delivery(&receipt.run_id, epoch, Some(&receipt.input_id))
        .unwrap()
        .load()
        .unwrap();
    let stale_edit = db
        .prepare_input_edit(&queued.input_id, 1, json!({"text":"stale edit"}))
        .unwrap()
        .load()
        .unwrap();
    let edit = db
        .prepare_input_edit(&queued.input_id, 1, json!({"text":"corrected"}))
        .unwrap()
        .load()
        .unwrap();
    db.admit_input_edit(edit).unwrap().load().unwrap();
    assert!(db.admit_input_delivery(first).unwrap().is_none());
    assert_eq!(
        db.head("main").unwrap().as_deref(),
        Some(receipt.input_id.as_str())
    );
    assert!(db.admit_input_edit(stale_edit).is_err());
    let corrected = db
        .prepare_input_delivery(&receipt.run_id, epoch, Some(&receipt.input_id))
        .unwrap()
        .load()
        .unwrap();
    let later = db
        .enqueue_input(&EnqueueInput {
            key: "later".into(),
            input: json!({"text":"later"}),
            ..command.clone()
        })
        .unwrap();
    let delivered = db.admit_input_delivery(corrected).unwrap().unwrap();
    assert!(
        matches!(&delivered[0].content,crate::execution::Content::Text {text} if text=="corrected")
    );
    assert_eq!(
        db.queued_input_metadata(&later.input_id).unwrap().state,
        InputState::Queued
    );
    let edit = db
        .prepare_input_edit(&later.input_id, 1, json!({"text":"cancelled edit"}))
        .unwrap()
        .load()
        .unwrap();
    db.cancel_input(&later.input_id, 1).unwrap();
    assert!(db.admit_input_edit(edit).is_err());
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    assert_eq!(
        db.content
            .load(&serde_json::from_str(&intent).unwrap())
            .unwrap()["input"],
        command.input
    );
    drop(db);
    let mut db = f.open();
    // Editing changes the delivered body, never the original idempotency intent.
    assert_eq!(db.enqueue_input(&command).unwrap(), queued);
    assert_eq!(
        db.queued_input(&queued.input_id).unwrap().content,
        json!({"text":"corrected"})
    );
    assert_eq!(
        db.history("main").unwrap().last().unwrap().content,
        json!({"text":"corrected"})
    );
}
#[test]
fn staged_first_input_rechecks_checkpoint_and_owner_without_holding_catalog() {
    use crate::catalog::context::ContextProposal;
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let proposal = ContextProposal {
        key: "initial".into(),
        branch_id: "main".into(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "system 中文🎉".repeat(10000),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let preparation = db
        .prepare_submission(command(), Some(proposal.clone()), None)
        .unwrap();
    let competing = db
        .prepare_submission(
            SubmitInput {
                key: "competing".into(),
                ..command()
            },
            Some(proposal.clone()),
            None,
        )
        .unwrap()
        .load(None, false)
        .unwrap();
    let (release, wait) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        wait.recv().unwrap();
        preparation.load(None, false).unwrap()
    });
    // While the real candidate is held by its body worker, unrelated control and input continue.
    db.create_thread("other", "other-branch").unwrap();
    let other = db
        .submit(&SubmitInput {
            key: "other".into(),
            thread_id: "other".into(),
            branch_id: "other-branch".into(),
            ..command()
        })
        .unwrap();
    db.request_cancel_run(&other.run_id).unwrap();
    let prepared = db
        .prepare_submission(command(), Some(proposal), None)
        .unwrap()
        .load(None, false)
        .unwrap();
    let accepted = db.admit_submission(prepared).unwrap();
    assert!(
        matches!(db.admit_submission(competing),Err(RuntimeError::Conflict(message)) if message=="input context changed during preparation")
    );
    release.send(()).unwrap();
    assert_eq!(
        db.admit_submission(worker.join().unwrap()).unwrap(),
        accepted
    );
    let next = db
        .prepare_submission(
            SubmitInput {
                key: "next-owner".into(),
                expected_head: Some(accepted.input_id.clone()),
                ..command()
            },
            None,
            None,
        )
        .unwrap()
        .load(None, false)
        .unwrap();
    drop(db);
    let mut db = f.open();
    assert!(db.admit_submission(next).is_err());
    assert_eq!(db.history("main").unwrap().len(), 1);
}
#[test]
fn queued_input_is_durable_editable_and_only_enters_a_closed_model_boundary() {
    use crate::catalog::inputs::EnqueueInput;
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    db.prepare_model_step("active-step", &r.run_id, epoch, json!({"input":"original"}))
        .unwrap();
    db.dispatch_model_step("active-step", epoch).unwrap();
    let command = EnqueueInput {
        key: "queued".into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        mode: InputMode::Boundary,
        input: json!({"text":"first draft"}),
        configuration: None,
    };
    let queued = db.enqueue_input(&command).unwrap();
    assert_eq!(db.enqueue_input(&command).unwrap(), queued);
    assert_eq!(
        db.head("main").unwrap().as_deref(),
        Some(r.input_id.as_str())
    );
    let edited = db
        .edit_queued_input(&queued.input_id, 1, json!({"text":"actual correction"}))
        .unwrap();
    assert_eq!(edited.revision, 2);
    assert!(db
        .edit_queued_input(&queued.input_id, 1, json!({"text":"stale"}))
        .is_err());
    assert!(db
        .consume_inputs(&r.run_id, epoch, Some(&r.input_id))
        .is_err());
    db.settle_model_step(
        "active-step",
        epoch,
        ModelStepState::Interrupted,
        vec![],
        None,
    )
    .unwrap();
    drop(db);
    let mut db = f.open();
    let epoch = db.epoch();
    assert_eq!(
        db.queued_input(&queued.input_id).unwrap().content,
        json!({"text":"actual correction"})
    );
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    let delivered = db
        .consume_inputs(&r.run_id, epoch, Some(&r.input_id))
        .unwrap();
    assert_eq!(delivered.len(), 1);
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    assert_eq!(
        db.history("main").unwrap().last().unwrap().content,
        json!({"text":"actual correction"})
    );
    assert!(
        matches!(&delivered[0].content,crate::execution::Content::Text{text} if text=="actual correction")
    );
    assert_eq!(
        db.queued_input(&queued.input_id).unwrap().state,
        InputState::Delivered
    );
    assert!(db
        .edit_queued_input(&queued.input_id, 2, json!({"text":"too late"}))
        .is_err());
    assert!(db
        .consume_inputs(&r.run_id, epoch, Some(&queued.input_id))
        .unwrap()
        .is_empty());
    assert_eq!(
        db.model_step("active-step")
            .unwrap()
            .superseded_by_input
            .as_deref(),
        Some(queued.input_id.as_str())
    );
}
#[test]
fn boundary_input_cannot_be_lost_to_run_completion_and_next_run_skips_cancelled_entry() {
    use crate::catalog::inputs::EnqueueInput;
    let f = Fixture::new();
    let mut db = f.open();
    let r = submit(&mut db);
    let epoch = db.epoch();
    let run = db
        .transition_run(&r.run_id, epoch, 1, RunState::Runnable)
        .unwrap();
    let boundary = db
        .enqueue_input(&EnqueueInput {
            key: "boundary".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::Boundary,
            input: json!({"text":"do this too"}),
            configuration: None,
        })
        .unwrap();
    assert!(db
        .transition_run(&r.run_id, epoch, run.revision, RunState::Completed)
        .is_err());
    db.consume_inputs(&r.run_id, epoch, Some(&r.input_id))
        .unwrap();
    let queued = |key: &str| EnqueueInput {
        key: key.into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        mode: InputMode::NextRun,
        input: json!({"text":key}),
        configuration: None,
    };
    let removed = db.enqueue_input(&queued("removed")).unwrap();
    let next = db.enqueue_input(&queued("next")).unwrap();
    db.cancel_queued_input(&removed.input_id, 1).unwrap();
    let run = db.run(&r.run_id).unwrap();
    db.transition_run(&r.run_id, epoch, run.revision, RunState::Completed)
        .unwrap();
    assert_eq!(
        db.queued_input(&next.input_id).unwrap().state,
        InputState::Delivered
    );
    assert_eq!(db.run(&removed.run_id).unwrap().state, RunState::Cancelled);
    assert_eq!(
        db.head("main").unwrap().as_deref(),
        Some(next.input_id.as_str())
    );
    let history = db.history("main").unwrap();
    assert!(history.iter().any(|i| i.id == boundary.input_id));
    assert!(!history.iter().any(|i| i.id == removed.input_id));
    assert!(db
        .prepare_execution(
            &next.run_id,
            request_snapshot(&r).view.binding,
            crate::execution::PolicyIdentity {
                name: "default".into(),
                version: "1".into()
            },
            Value::Null
        )
        .is_ok());
}

#[test]
fn content_backed_request_stays_compact_across_phases_and_reopens_exactly() {
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let epoch = db.epoch();
    let request = json!({"request_id":"content-step","history":[{"type":"reasoning","encrypted_content":"opaque-汉字".repeat(60000),"unknown":[null,true,42]}]});
    let prepared = db
        .prepare_model_step("content-step", &receipt.run_id, epoch, request.clone())
        .unwrap();
    assert_eq!(prepared.request, request);
    assert_eq!(
        db.prepare_model_step("content-step", &receipt.run_id, epoch, request.clone())
            .unwrap(),
        prepared
    );
    let compact_body = |db: &Catalog| -> Value {
        let raw: String = db
            .db
            .query_row(
                "SELECT body FROM model_steps WHERE id='content-step'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let body: Value = serde_json::from_str(&raw).unwrap();
        assert!(
            raw.len() < 1024,
            "phase persistence must retain request reference"
        );
        assert!(body["request"]["content_object"].is_string());
        body
    };
    let original_ref = compact_body(&db)["request"].clone();
    assert_eq!(
        db.dispatch_model_step("content-step", epoch)
            .unwrap()
            .request,
        request
    );
    assert_eq!(compact_body(&db)["request"], original_ref);
    let step = db
        .settle_model_step(
            "content-step",
            epoch,
            ModelStepState::Interrupted,
            vec![],
            None,
        )
        .unwrap();
    assert_eq!(step.request, request);
    assert_eq!(compact_body(&db)["request"], original_ref);
    assert_eq!(content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap(), 0);
    drop(db);
    let db = f.open();
    assert_eq!(db.model_step("content-step").unwrap().request, request);
    assert_eq!(compact_body(&db)["request"], original_ref);
    assert_eq!(content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap(), 0);
}

#[test]
fn missing_request_content_does_not_mark_unsent_public_dispatch_as_dispatched() {
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let epoch = db.epoch();
    db.prepare_model_step(
        "missing-content",
        &receipt.run_id,
        epoch,
        json!({"opaque":"must exist before dispatch"}),
    )
    .unwrap();
    let step: ModelStep = record(&db.db, "model_steps", "missing-content").unwrap();
    let path = crate::content::object_path(
        &f.0.join("content"),
        step.request["content_object"].as_str().unwrap(),
    )
    .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(db.dispatch_model_step("missing-content", epoch).is_err());
    let after: ModelStep = record(&db.db, "model_steps", "missing-content").unwrap();
    assert_eq!(after.state, ModelStepState::Prepared);
    assert!(db
        .settle_model_step(
            "missing-content",
            epoch,
            ModelStepState::Interrupted,
            vec![],
            None
        )
        .is_err());
    let after_settle: ModelStep = record(&db.db, "model_steps", "missing-content").unwrap();
    assert_eq!(after_settle.state, ModelStepState::Prepared);
}

#[test]
fn durable_launch_rebind_is_exact_idempotent_and_carries_no_live_credentials() {
    use super::launches::LaunchSelection;
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let selection: LaunchSelection = serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"pinned-public-digest","provider_family":"fixture","model":"test-model","configuration_generation":1,"tool_schema_generation":1,"tools":[{"name":"read","version":"1","description":"Fixture tool","output_schema":null,"metadata":null,"schema":{"type":"object"}}],"policy":{"name":"agent","version":"1"},"source":{"workspace_id":"workspace","execution_workspace_id":"execution","branch_id":"branch","revision":5,"mode":"fixed_branch","live_root":null}})).unwrap();
    let first = db.bind_launch(&receipt.run_id, selection.clone()).unwrap();
    assert_eq!(
        first,
        db.bind_launch(&receipt.run_id, selection.clone()).unwrap()
    );
    for field in [
        "connection_identity",
        "model",
        "configuration_generation",
        "tool_schema_generation",
        "tools",
        "source",
    ] {
        let mut changed = serde_json::to_value(&selection).unwrap();
        match field {
            "connection_identity" | "model" => changed[field] = json!("changed"),
            "configuration_generation" | "tool_schema_generation" => changed[field] = json!(2),
            "tools" => changed[field][0]["schema"] = json!({"type":"string"}),
            "source" => changed[field]["revision"] = json!(6),
            _ => unreachable!(),
        }
        assert!(
            db.bind_launch(&receipt.run_id, serde_json::from_value(changed).unwrap())
                .is_err(),
            "changed {field} must reject"
        );
    }
    let raw: String = db
        .db
        .query_row(
            "SELECT body FROM run_launches WHERE id=?1",
            [&receipt.run_id],
            |r| r.get(0),
        )
        .unwrap();
    for forbidden in ["credential_ref", "grant_id", "root_id", "access_token"] {
        assert!(!raw.contains(forbidden));
    }
    drop(db);
    let mut db = f.open();
    let reopened = db.launch_intent(&receipt.run_id).unwrap().unwrap();
    assert!(reopened.requires_rebind);
    assert_eq!(reopened.selection, selection);
    assert_eq!(db.pending_launches().unwrap().len(), 1);
    let rebound = db.bind_launch(&receipt.run_id, selection).unwrap();
    assert!(!rebound.requires_rebind);
    assert_eq!(rebound.revision, first.revision + 1);
    assert_eq!(rebound.bound_epoch, Some(db.epoch()));
    let epoch = db.epoch();
    db.prepare_model_step(
        "ambiguous-model",
        &receipt.run_id,
        epoch,
        json!({"request":"already sent"}),
    )
    .unwrap();
    db.dispatch_model_step("ambiguous-model", epoch).unwrap();
    drop(db);
    let mut db = f.open();
    db.bind_launch(&receipt.run_id, rebound.selection.clone())
        .unwrap();
    assert!(
        db.prepare_execution(
            &receipt.run_id,
            request_snapshot(&receipt).view.binding,
            rebound.selection.policy,
            Value::Null
        )
        .is_err(),
        "trusted rebind cannot authorize re-sending an ambiguous model request"
    );
    assert_eq!(
        db.model_step("ambiguous-model").unwrap().state,
        ModelStepState::Interrupted
    );
}

#[test]
fn launch_selection_survives_restart_before_materialization_and_binding() {
    use super::launches::LaunchSelection;
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let selection = LaunchSelection::from_binding(
        &request_snapshot(&receipt).view.binding,
        crate::execution::PolicyIdentity {
            name: "agent".into(),
            version: "1".into(),
        },
        None,
    );
    let selected = db
        .select_launch(&receipt.run_id, selection.clone())
        .unwrap();
    assert!(selected.requires_rebind);
    assert_eq!(selected.bound_epoch, None);
    assert_eq!(
        db.select_launch(&receipt.run_id, selection.clone())
            .unwrap(),
        selected
    );
    drop(db);
    let mut db = f.open();
    let pending = db.pending_launches().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].selection, selection);
    assert_eq!(pending[0].bound_epoch, None);
    let bound = db.bind_launch(&receipt.run_id, selection).unwrap();
    assert_eq!(bound.bound_epoch, Some(db.epoch()));
    assert!(!bound.requires_rebind);
}

#[test]
fn missing_launch_tool_content_does_not_break_source_or_cancellation_control() {
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let selection: launches::LaunchSelection = serde_json::from_value(json!({
        "extension_bindings":[],"connection_identity":"selected", "provider_family":"fixture", "model":"model",
        "configuration_generation":1, "tool_schema_generation":1,
        "tools":[{"name":"read", "version":"1", "description":"Fixture tool","output_schema":null,"metadata":null,"schema":{"type":"object", "description":"large tool material".repeat(65536)}}],
        "policy":{"name":"default", "version":"1"},
        "source":{"mode":"fixed_branch", "live_root":null, "workspace_id":"workspace", "execution_workspace_id":"workspace", "branch_id":"fixed", "revision":1}
    })).unwrap();
    db.select_launch(&receipt.run_id, selection.clone())
        .unwrap();
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    assert_eq!(
        db.launch_intent(&receipt.run_id)
            .unwrap()
            .unwrap()
            .selection,
        selection
    );
    let metadata = db.launch_metadata(&receipt.run_id).unwrap().unwrap();
    let path = crate::content::object_path(
        &f.0.join("content"),
        metadata.selection.tools_ref["content_object"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(db
        .capture_launch(&receipt.run_id)
        .unwrap()
        .unwrap()
        .load()
        .is_err());
    assert_eq!(
        db.launch_metadata(&receipt.run_id)
            .unwrap()
            .unwrap()
            .selection
            .source,
        selection.source
    );
    assert!(
        db.request_cancel_run(&receipt.run_id)
            .unwrap()
            .cancel_requested
    );
    assert!(db
        .events_after(0, 64)
        .unwrap()
        .iter()
        .any(|event| event.kind == "run.cancel_requested"));
}

#[test]
fn successor_environment_selection_reuses_only_its_original_thread_source() {
    use super::launches::{LaunchSelection, SourceSelection};
    let f = Fixture::new();
    let mut db = f.open();
    let origin = submit(&mut db);
    let original_selection = LaunchSelection::from_binding(
        &request_snapshot(&origin).view.binding,
        crate::execution::PolicyIdentity {
            name: "agent".into(),
            version: "1".into(),
        },
        Some(SourceSelection {
            environment_run_id: None,
            mode: crate::SourceMode::Materialized,
            live_root: None,
            workspace_id: "workspace".into(),
            execution_workspace_id: "execution".into(),
            branch_id: Some("source".into()),
            revision: Some(7),
        }),
    );
    db.bind_launch(&origin.run_id, original_selection.clone())
        .unwrap();
    let queued = db
        .enqueue_input(&crate::catalog::inputs::EnqueueInput {
            key: "atomic-successor".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::NextRun,
            input: json!({"text":"next turn"}),
            configuration: None,
        })
        .unwrap();
    let saved_successor = db
        .launch_intent(&queued.run_id)
        .unwrap()
        .expect("enqueue must atomically preserve the launch selection");
    assert_eq!(saved_successor.bound_epoch, None);
    assert!(saved_successor.requires_rebind);
    assert_eq!(
        saved_successor
            .selection
            .source
            .as_ref()
            .unwrap()
            .environment_run_id,
        Some(origin.run_id.clone())
    );

    db.fork_branch("main", "successor", Some(&origin.input_id))
        .unwrap();
    let mut next = command();
    next.key = "next".into();
    next.branch_id = "successor".into();
    next.expected_head = Some(origin.input_id.clone());
    let successor = db.submit(&next).unwrap();
    let mut inherited = original_selection.clone();
    inherited.source.as_mut().unwrap().environment_run_id = Some(origin.run_id.clone());
    let mut wrong = inherited.clone();
    wrong.source.as_mut().unwrap().revision = Some(8);
    assert!(db.select_launch(&successor.run_id, wrong).is_err());
    db.select_launch(&successor.run_id, inherited.clone())
        .unwrap();
    db.create_thread("other-thread", "other-branch").unwrap();
    next.key = "other".into();
    next.thread_id = "other-thread".into();
    next.branch_id = "other-branch".into();
    next.expected_head = None;
    let other = db.submit(&next).unwrap();
    assert!(db.select_launch(&other.run_id, inherited.clone()).is_err());
    drop(db);
    let db = f.open();
    assert_eq!(
        db.launch_intent(&queued.run_id).unwrap().unwrap().selection,
        saved_successor.selection
    );
    assert_eq!(
        db.launch_intent(&successor.run_id)
            .unwrap()
            .unwrap()
            .selection,
        inherited
    );
}

#[test]
fn initial_input_and_launch_are_one_durable_idempotent_admission() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let selection:super::launches::LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"pinned","provider_family":"fixture","model":"model","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"agent","version":"1"},"source":null})).unwrap();
    let admitted = db
        .submit_with_launch(&command(), Some(selection.clone()))
        .unwrap();
    assert_eq!(
        db.submit_with_launch(&command(), Some(selection.clone()))
            .unwrap(),
        admitted
    );
    let mut changed = selection.clone();
    changed.model = "another".into();
    assert!(db.submit_with_launch(&command(), Some(changed)).is_err());
    drop(db);
    let mut db = f.open();
    let launch = db.launch_intent(&admitted.run_id).unwrap().unwrap();
    assert_eq!(launch.selection, selection);
    assert!(launch.requires_rebind);
    assert_eq!(db.history("main").unwrap().len(), 1);
    assert_eq!(
        db.submit_with_launch(&command(), Some(selection)).unwrap(),
        admitted
    );
}

// Independent regression evidence from retrieval concurrency acceptance. Provider item
// identity is local to the model exchange; the conversation graph has its own durable identity.
fn independent_finished_item(text: &str) -> crate::execution::ProviderItem {
    crate::execution::ProviderItem {
        id: "provider-reused-id".into(),
        content: crate::execution::Content::Text { text: text.into() },
        opaque: Some(crate::execution::OpaqueProviderItem {
            connection_identity: "fixture-connection".into(),
            family: "test".into(),
            adapter_version: "1".into(),
            value: json!({"id":"provider-reused-id","opaque":{"signature":"untouched","values":[null,7]}}),
        }),
    }
}
fn independent_finish(request_id: &str, text: &str) -> crate::execution::ExecutionRecord {
    crate::execution::ExecutionRecord::ModelFinished {
        request_id: request_id.into(),
        outcome: crate::execution::ModelOutcome::Completed,
        finish_reason: Some(crate::execution::FinishReason::Stop),
        items: vec![independent_finished_item(text)],
        interrupted_deltas: vec![],
        usage: crate::execution::UsageReceipt::default(),
        failure: None,
    }
}
fn independent_prepare(
    db: &mut Catalog,
    receipt: &Receipt,
    snapshot: crate::execution::RequestSnapshot,
) {
    use crate::execution::ExecutionRecord;
    let epoch = db.epoch();
    let request_id = snapshot.view.request_id.clone();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared { snapshot },
    )
    .unwrap();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched { request_id },
    )
    .unwrap();
}

#[test]
fn model_activation_after_a_closed_exchange_survives_reopen_without_rewriting_its_snapshot() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let configuration:ModelSessionConfiguration = serde_json::from_value(json!({"providerFamily":"openai-responses","model":"old","endpoint":"http://localhost/responses","credentialEnvironment":null,"allowAnonymous":true,"configurationGeneration":1,"maxOutputTokens":32})).unwrap();
    let old = crate::model_session::bind(configuration.clone()).unwrap();
    let receipt = db
        .submit(&SubmitInput {
            configuration: serde_json::to_value(&configuration).unwrap(),
            ..command()
        })
        .unwrap();
    let policy = old.policy.identity();
    db.bind_launch(
        &receipt.run_id,
        launches::LaunchSelection::from_binding(&old.binding, policy.clone(), None),
    )
    .unwrap();
    let mut snapshot = request_snapshot(&receipt);
    let range = snapshot.view.binding.history_range.clone();
    snapshot.view.binding = old.binding.clone();
    snapshot.view.binding.history_range = range;
    independent_prepare(&mut db, &receipt, snapshot.clone());
    let next = ModelSessionConfiguration {
        model: "new".into(),
        configuration_generation: 2,
        ..configuration
    };
    let bound = crate::model_session::bind(next.clone()).unwrap();
    let selection = db
        .select_model(&receipt.run_id, "next-choice", next, None)
        .unwrap();
    db.prepare_model_selection(&selection, db.epoch(), None)
        .unwrap();
    let queued = db
        .enqueue_input(&inputs::EnqueueInput {
            key: "next-run-choice".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            mode: InputMode::NextRun,
            input: json!({"text":"follow up"}),
            configuration: None,
        })
        .unwrap();
    assert_eq!(
        db.run(&queued.run_id).unwrap().configuration["model"],
        "new"
    );
    assert_eq!(
        db.launch_intent(&queued.run_id)
            .unwrap()
            .unwrap()
            .selection
            .model,
        "new"
    );
    assert!(
        db.activate_model_selection(&selection, db.epoch(), &bound.binding)
            .is_err(),
        "an active request cannot be switched"
    );
    db.commit_execution(
        &receipt.run_id,
        db.epoch(),
        &ExecutionRecord::ModelFinished {
            request_id: "model-1".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::Stop),
            items: vec![ProviderItem {
                id: "old-output".into(),
                content: Content::Text {
                    text: "completed old output".into(),
                },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    assert!(
        db.prepare_recovered_execution(
            &receipt.run_id,
            bound.binding.clone(),
            policy.clone(),
            Value::Null
        )
        .is_err(),
        "a changed binding requires a committed activation"
    );
    assert!(db
        .activate_model_selection(&selection, db.epoch(), &bound.binding)
        .unwrap());
    let step = db.model_step("model-1").unwrap();
    assert_eq!(step.request["view"]["binding"]["model"], "old");
    let launch = db
        .launch_intent(&receipt.run_id)
        .unwrap()
        .unwrap()
        .selection;
    drop(db);
    let mut db = f.open();
    db.bind_launch(&receipt.run_id, launch).unwrap();
    let (input, recovery) = db
        .prepare_recovered_execution(&receipt.run_id, bound.binding, policy, Value::Null)
        .unwrap();
    assert_eq!(input.binding.model, "new");
    assert!(recovery.is_some());
    assert_eq!(
        db.model_selections(&receipt.run_id)
            .unwrap()
            .active
            .unwrap()
            .id,
        "next-choice"
    );
    assert!(input
        .history
        .iter()
        .any(|item| matches!(&item.content,Content::Text{text} if text=="completed old output")));
}

#[test]
fn independent_model_finished_retry_is_exactly_idempotent_and_conflicting_retry_preserves_history()
{
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let epoch = db.epoch();
    independent_prepare(&mut db, &receipt, request_snapshot(&receipt));
    let finish = independent_finish("model-1", "accepted output");
    db.commit_execution(&receipt.run_id, epoch, &finish)
        .unwrap();
    let history = db.history("main").unwrap();
    let output = db.model_output("model-1").unwrap();
    let events = db.events_after(0, 1000).unwrap();
    db.commit_execution(&receipt.run_id, epoch, &finish)
        .unwrap();
    assert_eq!(db.history("main").unwrap(), history);
    assert_eq!(db.model_output("model-1").unwrap(), output);
    assert_eq!(db.events_after(0, 1000).unwrap(), events);
    assert!(db
        .commit_execution(
            &receipt.run_id,
            epoch,
            &independent_finish("model-1", "conflicting replacement")
        )
        .is_err());
    assert_eq!(db.history("main").unwrap(), history);
    assert_eq!(db.model_output("model-1").unwrap(), output);
    assert_eq!(
        history.last().unwrap().provider.as_ref().unwrap().item,
        independent_finished_item("accepted output")
            .opaque
            .unwrap()
            .value
    );
}

#[test]
fn tool_activation_retains_its_exact_composition_through_collection_and_reopen() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let configuration:ModelSessionConfiguration=serde_json::from_value(json!({"providerFamily":"openai-responses","model":"same","endpoint":"http://localhost/responses","credentialEnvironment":null,"allowAnonymous":true,"configurationGeneration":1,"maxOutputTokens":32})).unwrap();
    let initial = crate::model_session::bind(configuration.clone()).unwrap();
    let receipt = db
        .submit(&SubmitInput {
            configuration: serde_json::to_value(configuration).unwrap(),
            ..command()
        })
        .unwrap();
    let policy = initial.policy.identity();
    db.bind_launch(
        &receipt.run_id,
        launches::LaunchSelection::from_binding(&initial.binding, policy.clone(), None),
    )
    .unwrap();
    let mut snapshot = request_snapshot(&receipt);
    let range = snapshot.view.binding.history_range.clone();
    snapshot.view.binding = initial.binding.clone();
    snapshot.view.binding.history_range = range;
    let schema = ToolSchema {
        description: String::new(),
        output_schema: None,
        metadata: None,
        name: "query".into(),
        version: "new".into(),
        schema: json!({"type":"object"}),
    };
    let mcp = launches::HostToolBinding {
        reference: "exact-owner".into(),
        generation: 42,
        tools: vec![schema.clone()],
        resources: Default::default(),
    };
    let preparation = db
        .capture_tool_update(&receipt.run_id, db.epoch())
        .unwrap()
        .load_base()
        .unwrap();
    let mut next_tools = preparation.base().to_vec();
    next_tools.push(schema);
    let prepared = preparation
        .load(next_tools.clone(), Some(mcp.clone()), vec![])
        .unwrap();
    independent_prepare(&mut db, &receipt, snapshot.clone());
    assert!(
        db.activate_tool_update(&prepared).is_err(),
        "a dispatched request still owns its directory"
    );
    db.commit_execution(
        &receipt.run_id,
        db.epoch(),
        &independent_finish("model-1", "old request output"),
    )
    .unwrap();
    let mut next_binding = initial.binding.clone();
    next_binding.tools = next_tools;
    next_binding.tool_schema_generation = prepared.composition().generation;
    assert!(
        db.prepare_recovered_execution(
            &receipt.run_id,
            next_binding.clone(),
            policy.clone(),
            Value::Null
        )
        .is_err(),
        "schemas alone are not an activation fact"
    );
    assert!(db.activate_tool_update(&prepared).unwrap());
    drop(prepared);
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    let launch = db
        .launch_intent(&receipt.run_id)
        .unwrap()
        .unwrap()
        .selection;
    assert_eq!(launch.mcp_binding, Some(mcp));
    assert_eq!(
        db.model_step("model-1").unwrap().request["view"]["binding"]["tools"],
        serde_json::to_value(&snapshot.view.binding.tools).unwrap()
    );
    drop(db);
    let mut db = f.open();
    db.bind_launch(&receipt.run_id, launch).unwrap();
    let (input, recovery) = db
        .prepare_recovered_execution(&receipt.run_id, next_binding, policy, Value::Null)
        .unwrap();
    assert!(recovery.is_some());
    assert!(input
        .history
        .iter()
        .any(|item| matches!(&item.content,Content::Text{text} if text=="old request output")));
    let stale = db
        .capture_tool_update(&receipt.run_id, db.epoch())
        .unwrap()
        .load_base()
        .unwrap()
        .load(input.binding.tools.clone(), None, vec![]);
    assert!(
        stale.is_err(),
        "MCP schemas cannot be moved into base authority"
    );
    let preparation = db
        .capture_tool_update(&receipt.run_id, db.epoch())
        .unwrap()
        .load_base()
        .unwrap();
    let base = preparation.base().to_vec();
    let prepared = preparation.load(base, None, vec![]).unwrap();
    drop(db);
    let mut db = f.open();
    assert!(
        db.activate_tool_update(&prepared).is_err(),
        "an old owner cannot publish its ready candidate after reopen"
    );
}

#[test]
fn independent_reused_provider_id_across_model_steps_preserves_each_original_and_branch_chain() {
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let epoch = db.epoch();
    independent_prepare(&mut db, &receipt, request_snapshot(&receipt));
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &independent_finish("model-1", "first answer"),
    )
    .unwrap();
    let first = db.history("main").unwrap().last().unwrap().clone();
    let mut second_snapshot = request_snapshot(&receipt);
    second_snapshot.view.request_id = "model-2".into();
    second_snapshot.view.binding.history_range.leaf_id = Some(first.id.clone());
    second_snapshot.view.history = db.execution_history("main").unwrap();
    second_snapshot.view.origin = crate::execution::RequestOrigin::Conversation {
        step: 2,
        history_range: second_snapshot.view.binding.history_range.clone(),
    };
    independent_prepare(&mut db, &receipt, second_snapshot);
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &independent_finish("model-2", "second answer"),
    )
    .unwrap();
    let history = db.history("main").unwrap();
    let second = history.last().unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(second.parent.as_deref(), Some(first.id.as_str()));
    assert_eq!(first.provider, second.provider);
    assert_eq!(
        db.model_output("model-1").unwrap().unwrap()["record"]["items"][0]["id"],
        "provider-reused-id"
    );
    assert_eq!(
        db.model_output("model-2").unwrap().unwrap()["record"]["items"][0]["id"],
        "provider-reused-id"
    );
    db.fork_branch("main", "reused-provider-fork", Some(&second.id))
        .unwrap();
    assert_eq!(db.history("reused-provider-fork").unwrap(), history);
}

#[test]
fn independent_recovery_uses_the_saved_contiguous_row_identity_and_rejects_changed_content() {
    use crate::execution::PolicyIdentity;
    let f = Fixture::new();
    let mut db = f.open();
    let receipt = submit(&mut db);
    let epoch = db.epoch();
    let snapshot = request_snapshot(&receipt);
    independent_prepare(&mut db, &receipt, snapshot.clone());
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &independent_finish("model-1", "durable older output"),
    )
    .unwrap();
    let mut saved = db.history("main").unwrap().last().unwrap().clone();
    let generated_id = saved.id.clone();
    // Construct already-committed data whose graph row uses the provider's original ID,
    // as the prior runtime did. The product recovery path must read actual row authority,
    // not guess a migration branch or recompute a replacement graph ID.
    saved.id = "provider-reused-id".into();
    saved.content["id"] = json!(saved.id);
    saved.content = db
        .content
        .save_history(&saved.content, &saved.provider)
        .unwrap();
    saved.provider = None;
    {
        let tx = db.db.transaction().unwrap();
        tx.execute_batch("PRAGMA defer_foreign_keys=ON").unwrap();
        tx.execute(
            "UPDATE history SET id=?1,body=?2 WHERE id=?3",
            params![saved.id, encode(&saved).unwrap(), generated_id],
        )
        .unwrap();
        tx.execute(
            "UPDATE branches SET head=?1 WHERE head=?2",
            params![saved.id, generated_id],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let policy = PolicyIdentity {
        name: "default".into(),
        version: "1".into(),
    };
    let (input, recovery) = db
        .prepare_recovered_execution(
            &receipt.run_id,
            snapshot.view.binding.clone(),
            policy.clone(),
            Value::Null,
        )
        .unwrap();
    assert!(recovery.is_some());
    assert_eq!(
        input.binding.history_range.leaf_id.as_deref(),
        Some("provider-reused-id")
    );
    assert_eq!(input.history.last().unwrap().id, "provider-reused-id");
    assert_eq!(
        db.head("main").unwrap().as_deref(),
        Some("provider-reused-id")
    );
    let mut damaged = db.history("main").unwrap().last().unwrap().clone();
    damaged.content["content"]["text"] = json!("unrelated replacement");
    damaged.content = db
        .content
        .save_history(&damaged.content, &damaged.provider)
        .unwrap();
    damaged.provider = None;
    db.db
        .execute(
            "UPDATE history SET body=?1 WHERE id=?2",
            params![encode(&damaged).unwrap(), damaged.id],
        )
        .unwrap();
    assert!(db
        .prepare_recovered_execution(&receipt.run_id, snapshot.view.binding, policy, Value::Null)
        .is_err());
}

#[test]
fn independent_recovery_rejects_corrupted_branch_anchor_and_foreign_suffix_ownership() {
    use crate::execution::{Content, ConversationItem, PolicyIdentity, Provenance};
    for corruption in [
        "branch-owner",
        "anchor-header",
        "anchor-owner",
        "suffix-owner",
    ] {
        let f = Fixture::new();
        let mut db = f.open();
        let receipt = submit(&mut db);
        let epoch = db.epoch();
        let snapshot = request_snapshot(&receipt);
        independent_prepare(&mut db, &receipt, snapshot.clone());
        db.commit_execution(
            &receipt.run_id,
            epoch,
            &independent_finish("model-1", "owned output"),
        )
        .unwrap();
        db.create_thread("foreign-thread", "foreign-branch")
            .unwrap();
        if corruption == "branch-owner" {
            db.db
                .execute(
                    "UPDATE branches SET thread_id='foreign-thread' WHERE id='main'",
                    [],
                )
                .unwrap();
        } else {
            let target = if corruption == "suffix-owner" {
                let suffix = db
                    .append_history(
                        &receipt.run_id,
                        epoch,
                        db.head("main").unwrap().as_deref(),
                        HistorySource::Environment,
                        serde_json::to_value(ConversationItem {
                            id: "later-environment".into(),
                            provenance: Provenance::EnvironmentFact {
                                event_id: "later-event".into(),
                            },
                            content: Content::Text {
                                text: "later source observation".into(),
                            },
                            opaque: None,
                        })
                        .unwrap(),
                        None,
                    )
                    .unwrap();
                suffix.id
            } else {
                receipt.input_id.clone()
            };
            let body: String = db
                .db
                .query_row("SELECT body FROM history WHERE id=?1", [&target], |row| {
                    row.get(0)
                })
                .unwrap();
            let mut metadata: HistoryItem = serde_json::from_str(&body).unwrap();
            if corruption == "anchor-header" {
                metadata.id = "wrong-anchor-header".into();
                db.db
                    .execute(
                        "UPDATE history SET body=?1 WHERE id=?2",
                        params![encode(&metadata).unwrap(), target],
                    )
                    .unwrap();
            } else {
                metadata.thread_id = "foreign-thread".into();
                db.db
                    .execute(
                        "UPDATE history SET thread_id=?1,body=?2 WHERE id=?3",
                        params![metadata.thread_id, encode(&metadata).unwrap(), target],
                    )
                    .unwrap();
            }
        }
        let result = db.prepare_recovered_execution(
            &receipt.run_id,
            snapshot.view.binding,
            PolicyIdentity {
                name: "default".into(),
                version: "1".into(),
            },
            Value::Null,
        );
        assert!(result.is_err(), "recovery accepted {corruption}");
    }
}

#[test]
fn dispatched_no_effect_requires_exact_durable_executor_evidence() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut db = f.open();
    let run = submit(&mut db);
    let epoch = db.epoch();
    let mut snapshot = request_snapshot(&run);
    snapshot.view.binding.tools = vec![ToolSchema {
        description: String::new(),
        output_schema: None,
        metadata: None,
        name: "cas-owner".into(),
        version: "1".into(),
        schema: json!({"type":"object"}),
    }];
    independent_prepare(&mut db, &run, snapshot);
    let calls: Vec<_> = ["conflict", "other"]
        .into_iter()
        .map(|call_id| ToolCall {
            call_id: call_id.into(),
            name: "cas-owner".into(),
            schema_version: "1".into(),
            arguments: json!({"expectedRef":null}),
        })
        .collect();
    db.commit_execution(
        &run.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "model-1".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: calls
                .iter()
                .map(|call| ProviderItem {
                    id: format!("item-{}", call.call_id),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                })
                .collect(),
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    for call in calls {
        let context = crate::execution::ToolExecutionContext {
            run_id: run.run_id.clone(),
            origin: crate::execution::ToolOrigin::ModelStep {
                request_id: "model-1".into(),
            },
            operation_id: format!("model-1:tool:{}", call.call_id),
        };
        db.commit_execution(
            &run.run_id,
            epoch,
            &ExecutionRecord::ToolAdmitted {
                context,
                tool: AdmittedTool {
                    call,
                    contract: ToolContract {
                        name: "cas-owner".into(),
                        schema_version: "1".into(),
                        read_only: false,
                        completion: CompletionKind::Result,
                        lifetime: Lifetime::Run,
                        resources: vec![],
                    },
                },
            },
        )
        .unwrap();
    }
    for call_id in ["conflict", "other"] {
        db.commit_execution(
            &run.run_id,
            epoch,
            &ExecutionRecord::ToolDispatched {
                executor_owner: varin_runtime::ExecutorOwner::Kernel,
                context: {
                    let request_id: String = "model-1".into();
                    let call_id: String = call_id.into();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&run.run_id).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
            },
        )
        .unwrap();
    }
    let owner = std::sync::Mutex::new(db);
    let context = ToolExecutionContext {
        run_id: run.run_id.clone(),
        operation_id: "model-1:tool:conflict".into(),
        origin: ToolOrigin::ModelStep {
            request_id: "model-1".into(),
        },
    };
    let content = json!({"status":"conflict","currentRef":"user-version","permission":{"ordinary":"opaque tool field"},"data":"result-body-漢字".repeat(20000)});
    let completion = ToolCompletion::Result {
        outcome: Outcome::Failed,
        effect: Effect::None,
        content: content.clone(),
    };
    let settlement = |completion| {
        let result = ToolResult {
            request_id: "model-1".into(),
            call_id: "conflict".into(),
            completion,
        };
        ExecutionRecord::ToolSettled {
            executor_stopped: true,
            context: {
                let request_id: String = result.request_id.clone();
                let call_id: String = result.call_id.clone();
                varin_runtime::execution::ToolExecutionContext {
                    run_id: (&run.run_id).to_string(),
                    operation_id: format!("{request_id}:tool:{call_id}"),
                    origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                }
            },
            completion: result.completion,
        }
    };
    // A tool's no-effect claim alone must neither bypass normalization nor settle a dispatch.
    assert!(!owner
        .confirms_no_effect(&context, epoch, &completion)
        .unwrap());
    assert!(owner
        .commit(&run.run_id, epoch, &settlement(completion.clone()))
        .is_err());
    let op = owner
        .lock()
        .unwrap()
        .operation(&context.operation_id)
        .unwrap();
    assert_eq!(
        (op.phase, op.effect),
        (OperationPhase::Running, Effect::Dispatched)
    );
    super::result_content::record_external_receipt(
        &owner,
        &context.operation_id,
        ExternalReceipt {
            identity: context.operation_id.clone(),
            executor: "cas-owner".into(),
            epoch: "opaque-owner-epoch".into(),
            outcome: Outcome::Failed,
            effect: Effect::None,
            result: content.clone(),
        },
        true,
    )
    .unwrap();
    // Even authentic evidence cannot approve changed content or another Operation/generation.
    let changed = ToolCompletion::Result {
        outcome: Outcome::Failed,
        effect: Effect::None,
        content: json!({"status":"conflict","currentRef":"forged"}),
    };
    assert!(!owner.confirms_no_effect(&context, epoch, &changed).unwrap());
    assert!(owner
        .commit(&run.run_id, epoch, &settlement(changed))
        .is_err());
    let mut foreign = context.clone();
    foreign.operation_id = "model-1:tool:other".into();
    assert!(!owner
        .confirms_no_effect(&foreign, epoch, &completion)
        .unwrap());
    foreign = context.clone();
    foreign.origin = ToolOrigin::ModelStep {
        request_id: "other-request".into(),
    };
    assert!(!owner
        .confirms_no_effect(&foreign, epoch, &completion)
        .unwrap());
    assert!(owner
        .confirms_no_effect(&context, epoch + 1, &completion)
        .is_err());
    assert!(owner
        .confirms_no_effect(&context, epoch, &completion)
        .unwrap());
    owner
        .commit(&run.run_id, epoch, &settlement(completion))
        .unwrap();
    let op = owner
        .lock()
        .unwrap()
        .operation(&context.operation_id)
        .unwrap();
    assert_eq!(
        (op.phase, op.outcome, op.effect),
        (
            OperationPhase::Terminal,
            Some(Outcome::Failed),
            Effect::None
        )
    );
    let read = owner.lock().unwrap().capture_operation_read(op);
    assert_eq!(read.load().unwrap().result, Some(content.clone()));
    let events = owner.lock().unwrap().capture_events_read(0, 1000).unwrap();
    assert!(events
        .load()
        .unwrap()
        .iter()
        .any(|event| event.kind == "operation.settled" && event.data["result"] == content));
    let db = owner.lock().unwrap();
    let receipt: String = db
        .db
        .query_row(
            "SELECT receipt FROM tool_calls WHERE request_id='model-1' AND call_id='conflict'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        receipt.len() < 1024,
        "tool receipt must carry metadata, not output bytes"
    );
    drop(db);
    assert_eq!(
        owner
            .lock()
            .unwrap()
            .operation("model-1:tool:other")
            .unwrap()
            .effect,
        Effect::Dispatched
    );
}

#[test]
fn recovery_preparation_hydrates_without_catalog_and_rechecks_its_actual_boundary() {
    use crate::execution::{CancellationToken, PolicyIdentity};
    use std::sync::{mpsc, Arc, Mutex};
    for change in ["unrelated", "head", "cancel"] {
        let f = Fixture::new();
        let mut catalog = f.open();
        let receipt = submit(&mut catalog);
        let epoch = catalog.epoch();
        let row = catalog
            .append_history(
                &receipt.run_id,
                epoch,
                Some(&receipt.input_id),
                HistorySource::User,
                json!({"text":"retained-history-".repeat(500000)}),
                None,
            )
            .unwrap();
        let owner = Arc::new(Mutex::new(catalog));
        let mut catalog = owner.lock().unwrap();
        let preparation = catalog
            .capture_recovered_execution(
                &receipt.run_id,
                request_snapshot(&receipt).view.binding,
                PolicyIdentity {
                    name: "default".into(),
                    version: "1".into(),
                },
                Value::Null,
                true,
            )
            .unwrap();
        catalog
            .content
            .save(&json!({"orphan":"protected until preparation ends"}))
            .unwrap();
        assert_eq!(content_collection::collect(|| catalog.prepare_content_collection(Default::default())).unwrap(), 0);
        let (send, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            send.send(preparation.load(&CancellationToken::default()))
                .unwrap()
        });
        // Hold the actual Catalog mutex throughout history traversal, object reads and decode.
        let prepared = receive
            .recv_timeout(std::time::Duration::from_secs(20))
            .unwrap()
            .unwrap()
            .unwrap();
        worker.join().unwrap();
        match change {
            "unrelated" => {
                catalog.create_thread("other-thread", "other-main").unwrap();
            }
            "head" => {
                catalog
                    .append_history(
                        &receipt.run_id,
                        epoch,
                        Some(&row.id),
                        HistorySource::User,
                        json!("late correction"),
                        None,
                    )
                    .unwrap();
            }
            "cancel" => {
                catalog.request_cancel_run(&receipt.run_id).unwrap();
            }
            _ => unreachable!(),
        }
        let launch = catalog.publish_recovered_execution(prepared).unwrap();
        if change == "unrelated" {
            let launch = launch.expect("unrelated Catalog writes cannot invalidate this Run");
            assert_eq!(
                launch.input.binding.history_range.leaf_id.as_deref(),
                Some(row.id.as_str())
            );
            assert_eq!(launch.input.history.len(), 2);
        } else {
            assert!(
                launch.is_none(),
                "a stale {change} boundary must be recaptured"
            );
        }
        let collection = catalog.prepare_content_collection(Default::default());
        drop(catalog);
        assert!(content_collection::collect(|| collection).unwrap() > 0, "publication pin must release");
        let mut catalog = owner.lock().unwrap();
        if change == "cancel" {
            assert_eq!(
                catalog
                    .cancel_preparing_execution(&receipt.run_id, epoch)
                    .unwrap()
                    .unwrap()
                    .state,
                RunState::Cancelled
            );
        }
    }
}

#[test]
fn recovery_preparation_discards_stale_failure_after_a_real_tool_receipt_arrives() {
    use crate::execution::*;
    let f = Fixture::new();
    let mut catalog = f.open();
    let receipt = submit(&mut catalog);
    let epoch = catalog.epoch();
    let mut snapshot = request_snapshot(&receipt);
    snapshot.view.binding.tools = vec![ToolSchema {
        description: String::new(),
        output_schema: None,
        metadata: None,
        name: "read".into(),
        version: "1".into(),
        schema: json!({"type":"object"}),
    }];
    let binding = snapshot.view.binding.clone();
    independent_prepare(&mut catalog, &receipt, snapshot);
    let call = ToolCall {
        call_id: "receipt-race".into(),
        name: "read".into(),
        schema_version: "1".into(),
        arguments: json!({}),
    };
    catalog
        .commit_execution(
            &receipt.run_id,
            epoch,
            &ExecutionRecord::ModelFinished {
                request_id: "model-1".into(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: vec![ProviderItem {
                    id: "call-item".into(),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                }],
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
        )
        .unwrap();
    catalog
        .commit_execution(&receipt.run_id, epoch, &{
            let tool = AdmittedTool {
                call,
                contract: ToolContract {
                    name: "read".into(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: CompletionKind::Result,
                    lifetime: Lifetime::Run,
                    resources: vec![],
                },
            };
            ExecutionRecord::ToolAdmitted {
                context: {
                    let request_id: String = "model-1".into();
                    let call_id: String = tool.call.call_id.clone();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&receipt.run_id).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
                tool,
            }
        })
        .unwrap();
    catalog
        .commit_execution(
            &receipt.run_id,
            epoch,
            &ExecutionRecord::ToolDispatched {
                executor_owner: varin_runtime::ExecutorOwner::Kernel,
                context: {
                    let request_id: String = "model-1".into();
                    let call_id: String = "receipt-race".into();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&receipt.run_id).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
            },
        )
        .unwrap();
    let policy = PolicyIdentity {
        name: "default".into(),
        version: "1".into(),
    };
    let preparation = catalog
        .capture_recovered_execution(
            &receipt.run_id,
            binding.clone(),
            policy.clone(),
            Value::Null,
            true,
        )
        .unwrap();
    let identity = preparation.identity();
    assert!(
        preparation.load(&CancellationToken::default()).is_err(),
        "unconfirmed dispatch cannot replay"
    );
    catalog
        .commit_execution(&receipt.run_id, epoch, &{
            let result = ToolResult {
                request_id: "model-1".into(),
                call_id: "receipt-race".into(),
                completion: ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    effect: Effect::Confirmed,
                    content: json!("actual receipt"),
                },
            };
            ExecutionRecord::ToolSettled {
                executor_stopped: true,
                context: {
                    let request_id: String = result.request_id.clone();
                    let call_id: String = result.call_id.clone();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&receipt.run_id).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
                completion: result.completion,
            }
        })
        .unwrap();
    assert!(
        !catalog.preparation_is_current(&identity).unwrap(),
        "a late real receipt supersedes the earlier recovery failure"
    );
    let preparation = catalog
        .capture_recovered_execution(&receipt.run_id, binding, policy, Value::Null, true)
        .unwrap();
    let prepared = preparation
        .load(&CancellationToken::default())
        .unwrap()
        .unwrap();
    let launch = catalog
        .publish_recovered_execution(prepared)
        .unwrap()
        .unwrap();
    let recovery = launch.recovery.unwrap();
    assert!(recovery.pending.is_some());
    assert_eq!(
        recovery.receipts["receipt-race"].completion,
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            content: json!("actual receipt"),
        }
    );
}

#[test]
fn result_publication_stages_without_catalog_and_gc_protects_until_commit() {
    use std::sync::{mpsc, Mutex};
    let f = Fixture::new();
    let mut db = f.open();
    let run = submit(&mut db);
    let epoch = db.epoch();
    db.admit_operation(
        "result-publication",
        &run.run_id,
        epoch,
        Lifetime::Run,
        Value::Null,
    )
    .unwrap();
    db.dispatch_operation("result-publication", epoch, "read", false)
        .unwrap();
    let owner = Mutex::new(db);
    let preparation = owner.lock().unwrap().prepare_result_content();
    let body = json!({"body":"immutable-result".repeat(40000),"opaque":[true,null,17]});
    let expected = body.clone();
    let (send, receive) = mpsc::channel();
    let catalog = owner.lock().unwrap();
    let worker = std::thread::spawn(move || send.send(preparation.write_result(&body)).unwrap());
    // Holding Catalog cannot prevent body staging; the publication stays alive in the prepared value.
    let prepared = receive
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap()
        .unwrap();
    assert!(catalog
        .operation("result-publication")
        .unwrap()
        .result
        .is_none());
    drop(catalog);
    worker.join().unwrap();
    assert_eq!(content_collection::collect(|| owner.lock().unwrap().prepare_content_collection(Default::default())).unwrap(), 0);
    let operation = owner
        .lock()
        .unwrap()
        .settle_operation_prepared(
            "result-publication",
            epoch,
            Outcome::Succeeded,
            Effect::None,
            prepared,
        )
        .unwrap();
    content_collection::collect(|| owner.lock().unwrap().prepare_content_collection(Default::default())).unwrap();
    let read = owner.lock().unwrap().capture_operation_read(operation);
    assert_eq!(read.load().unwrap().result, Some(expected));
}

#[test]
fn external_result_outlives_kernel_until_original_stop_receipt() {
    use crate::execution::*;
    for settled in [false, true] {
        let f = Fixture::new();
        let mut db = f.open();
        let run = submit(&mut db);
        let epoch = db.epoch();
        let mut snapshot = request_snapshot(&run);
        snapshot.view.binding.tools = vec![ToolSchema {
            name: "broker_read".into(),
            version: "1".into(),
            description: "Read through an external worker".into(),
            schema: json!({"type":"object"}),
            output_schema: None,
            metadata: None,
        }];
        independent_prepare(&mut db, &run, snapshot);
        let call = ToolCall {
            call_id: "external".into(),
            name: "broker_read".into(),
            schema_version: "1".into(),
            arguments: json!({}),
        };
        db.commit_execution(
            &run.run_id,
            epoch,
            &ExecutionRecord::ModelFinished {
                request_id: "model-1".into(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: vec![ProviderItem {
                    id: "call-item".into(),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                }],
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
        )
        .unwrap();
        let context = ToolExecutionContext {
            run_id: run.run_id.clone(),
            origin: ToolOrigin::ModelStep {
                request_id: "model-1".into(),
            },
            operation_id: "model-1:tool:external".into(),
        };
        let owner = ExecutorOwner::External {
            identity: "broker:exact-instance".into(),
            epoch: "original-owner-epoch".into(),
        };
        db.commit_execution(
            &run.run_id,
            epoch,
            &ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call,
                    contract: ToolContract {
                        name: "broker_read".into(),
                        schema_version: "1".into(),
                        read_only: false,
                        completion: CompletionKind::Result,
                        lifetime: Lifetime::Run,
                        resources: vec![ResourceClaim {
                            key: "original-resource".into(),
                            access: Access::Write,
                        }],
                    },
                },
            },
        )
        .unwrap();
        db.commit_execution(
            &run.run_id,
            epoch,
            &ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: owner.clone(),
            },
        )
        .unwrap();
        let unknown = ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            content: json!({"error":"observer_cancelled"}),
        };
        if settled {
            db.commit_execution(
                &run.run_id,
                epoch,
                &ExecutionRecord::ToolSettled {
                    context: context.clone(),
                    completion: unknown.clone(),
                    executor_stopped: false,
                },
            )
            .unwrap();
        }
        drop(db);
        let mut db = f.open();
        assert_eq!(
            db.operation(&context.operation_id).unwrap().execution_owner,
            Some(owner.clone())
        );
        assert_eq!(
            db.resource_admission
                .inspect(&context.operation_id)
                .map(|s| s.state),
            Some("active"),
            "kernel restart is not broker stop evidence"
        );
        assert_eq!(
            db.operation(&context.operation_id).unwrap().effect,
            Effect::Unknown
        );
        let receipt = ExternalReceipt {
            executor: "broker_read".into(),
            identity: context.operation_id.clone(),
            epoch: "original-owner-epoch".into(),
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            result: json!({"actual":"original worker result"}),
        };
        let mut forged = receipt.clone();
        forged.epoch = "replacement-owner-epoch".into();
        let prepared = db
            .prepare_result_content()
            .write_external_receipt(forged)
            .unwrap();
        assert!(db
            .record_external_receipt_prepared(&context.operation_id, prepared, true)
            .is_err());
        assert_eq!(
            db.resource_admission
                .inspect(&context.operation_id)
                .map(|s| s.state),
            Some("active")
        );
        let prepared = db
            .prepare_result_content()
            .write_external_receipt(receipt.clone())
            .unwrap();
        let result = db
            .record_external_tool_receipt_prepared(&context.operation_id, &owner, prepared, true)
            .unwrap();
        assert_eq!(
            (result.outcome, result.effect),
            (Some(Outcome::Succeeded), Effect::Confirmed)
        );
        assert!(db
            .resource_admission
            .inspect(&context.operation_id)
            .is_none());
        let hydrated = db.capture_operation_read(result).load().unwrap();
        assert_eq!(
            hydrated.call_completion,
            settled.then_some(unknown),
            "late evidence must not rewrite the original invocation completion"
        );
        let prepared = db
            .prepare_result_content()
            .write_external_receipt(receipt)
            .unwrap();
        assert!(
            db.record_external_tool_receipt_prepared(&context.operation_id, &owner, prepared, true)
                .is_ok(),
            "lost durable acknowledgement may retry the same receipt"
        );
    }
}
