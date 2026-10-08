use super::*;
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
            step: 1,
            binding: RequestBinding {
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
    let unknown = external("job", Outcome::Indeterminate, Effect::Unknown);
    let observed = db.record_external_receipt("job", unknown.clone()).unwrap();
    assert_eq!(
        db.record_external_receipt("job", unknown).unwrap(),
        observed
    );
    let mut foreign = external("job", Outcome::Succeeded, Effect::Confirmed);
    foreign.epoch = "wrong-generation".into();
    assert!(db.record_external_receipt("job", foreign).is_err());
    let confirmed = external("job", Outcome::Succeeded, Effect::Confirmed);
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
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolsAdmitted {
            request_id: "model-1".into(),
            tools: vec![AdmittedTool {
                call,
                contract: ToolContract {
                    name: "process-executor".into(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: CompletionKind::Job,
                    lifetime: Lifetime::Thread,
                    resources: vec![],
                },
            }],
        },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolDispatched {
            request_id: "model-1".into(),
            call_id: "job".into(),
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
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolSettled {
            result: result.clone(),
        },
    )
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
