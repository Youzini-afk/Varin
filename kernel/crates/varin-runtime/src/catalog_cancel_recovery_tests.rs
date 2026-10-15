//! Original cancelled exchanges use the same unlocked staging and Catalog CAS as execution.
use super::*;
use crate::execution::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};

fn exchange(catalog: &mut Catalog, admitted: bool) -> (Receipt, String) {
    let receipt = submit(catalog);
    let epoch = catalog.epoch();
    for state in [RunState::Runnable, RunState::Generating] {
        catalog
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::StateChanged {
                    state,
                    waiting_on: None,
                },
            )
            .unwrap();
    }
    let mut snapshot = request_snapshot(&receipt);
    snapshot.view.binding.tools = vec![ToolSchema {
        name: "write".into(),
        version: "1".into(),
        description: String::new(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
        requirements: None,
    }];
    independent_prepare(catalog, &receipt, snapshot);
    let call = ToolCall {
        call_id: "original".into(),
        name: "write".into(),
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
                    id: "call".into(),
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
        .commit_execution(
            &receipt.run_id,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Executing,
                waiting_on: None,
            },
        )
        .unwrap();
    let operation = "model-1:tool:original".to_string();
    if admitted {
        catalog
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::ToolAdmitted {
                    context: ToolExecutionContext {
                        run_id: receipt.run_id.clone(),
                        operation_id: operation.clone(),
                        origin: ToolOrigin::ModelStep {
                            request_id: "model-1".into(),
                        },
                    },
                    tool: AdmittedTool {
                        call,
                        contract: ToolContract {
                            name: "write".into(),
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
    (receipt, operation)
}

fn original_receipt(operation: &str, known: bool) -> ExternalReceipt {
    ExternalReceipt {
        executor: "write".into(),
        identity: operation.into(),
        epoch: "original-epoch".into(),
        outcome: if known {
            Outcome::Succeeded
        } else {
            Outcome::Indeterminate
        },
        effect: if known {
            Effect::Confirmed
        } else {
            Effect::Unknown
        },
        result: json!({"known":known}).into(),
    }
}

#[test]
fn cancelled_recovery_pairs_only_proven_undispatched_calls() {
    for admitted in [false, true] {
        let fixture = Fixture::new();
        let mut catalog = fixture.open();
        let (receipt, operation) = exchange(&mut catalog, admitted);
        catalog.request_cancel_run(&receipt.run_id).unwrap();
        drop(catalog);
        let supervisor = crate::supervisor::RunSupervisor::new(fixture.open());
        supervisor.reconcile_message_requests().unwrap();
        supervisor.shutdown().unwrap();
        let owner = supervisor.catalog();
        let catalog = owner.lock().unwrap();
        assert_eq!(
            catalog.run(&receipt.run_id).unwrap().state,
            RunState::Cancelled
        );
        let history = catalog.execution_history("main").unwrap();
        assert!(
            matches!(&history.last().unwrap().content, Content::ToolResult { result }
            if matches!(result.completion, ToolCompletion::Result { outcome: Outcome::Cancelled, effect: Effect::None, .. }))
        );
        if admitted {
            assert_eq!(
                catalog.operation(&operation).unwrap().outcome,
                Some(Outcome::Cancelled)
            );
        } else {
            assert!(
                catalog.operation(&operation).is_err(),
                "pairing creates no executor admission"
            );
        }
    }
}

#[test]
fn cancelled_recovery_stages_unlocked_and_rejects_a_late_receipt_boundary() {
    let fixture = Fixture::new();
    let mut catalog = fixture.open();
    let (receipt, operation) = exchange(&mut catalog, true);
    let epoch = catalog.epoch();
    catalog
        .commit_execution(
            &receipt.run_id,
            epoch,
            &ExecutionRecord::ToolDispatched {
                context: ToolExecutionContext {
                    run_id: receipt.run_id.clone(),
                    operation_id: operation.clone(),
                    origin: ToolOrigin::ModelStep {
                        request_id: "model-1".into(),
                    },
                },
                executor_owner: ExecutorOwner::External {
                    identity: "original-owner".into(),
                    epoch: "original-epoch".into(),
                },
            },
        )
        .unwrap();
    catalog.request_cancel_run(&receipt.run_id).unwrap();
    drop(catalog);
    let mut catalog = fixture.open();
    catalog
        .record_external_receipt_with_stop(&operation, original_receipt(&operation, false), true)
        .unwrap();
    let preparation = catalog
        .capture_cancelled_recovery(&receipt.run_id)
        .unwrap()
        .unwrap();
    let (entered, entering) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let released = Mutex::new(released);
    let once = AtomicBool::new(false);
    catalog.content.set_write_hook(Some(Arc::new(move |_| {
        if !once.swap(true, Ordering::SeqCst) {
            entered.send(()).unwrap();
            released.lock().unwrap().recv().unwrap();
        }
    })));
    let owner = Arc::new(Mutex::new(catalog));
    let mut catalog = owner.lock().unwrap();
    let (finished, finish) = mpsc::channel();
    let worker = std::thread::spawn(move || finished.send(preparation.load()).unwrap());
    entering
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    // Keep the actual Catalog owner lock while loading/staging completes, and refine the
    // original executor's result at this exact boundary. No replacement execution is admitted.
    catalog
        .record_external_receipt_with_stop(&operation, original_receipt(&operation, true), true)
        .unwrap();
    release.send(()).unwrap();
    let prepared = finish
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
    catalog.content.set_write_hook(None);
    assert!(!catalog.publish_cancelled_recovery(prepared).unwrap());
    assert_eq!(
        catalog.run(&receipt.run_id).unwrap().state,
        RunState::Waiting
    );
    let preparation = catalog
        .capture_cancelled_recovery(&receipt.run_id)
        .unwrap()
        .unwrap();
    drop(catalog);
    let prepared = preparation.load().unwrap();
    let mut catalog = owner.lock().unwrap();
    assert!(catalog.publish_cancelled_recovery(prepared).unwrap());
    assert_eq!(
        catalog.run(&receipt.run_id).unwrap().state,
        RunState::Cancelled
    );
    let history = catalog.execution_history("main").unwrap();
    assert!(
        matches!(&history.last().unwrap().content, Content::ToolResult { result }
        if matches!(result.completion, ToolCompletion::Result { outcome: Outcome::Succeeded, effect: Effect::Confirmed, .. }))
    );
    assert_eq!(catalog.operation(&operation).unwrap().epoch, epoch);
    assert!(
        catalog
            .capture_cancelled_recovery(&receipt.run_id)
            .unwrap()
            .is_none()
    );
}
