//! Original cancelled exchanges use the same unlocked staging and Catalog CAS as execution.
use super::*;
use crate::execution::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};

fn exchange(catalog: &mut Catalog, admitted: bool) -> (Receipt, String) {
    exchange_with_contract(
        catalog,
        admitted,
        ToolContract {
            name: "write".into(),
            schema_version: "1".into(),
            read_only: false,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![],
        },
    )
}

fn exchange_with_contract(
    catalog: &mut Catalog,
    admitted: bool,
    contract: ToolContract,
) -> (Receipt, String) {
    exchange_with_tools(catalog, admitted, contract, vec![])
}

fn exchange_with_tools(
    catalog: &mut Catalog,
    admitted: bool,
    contract: ToolContract,
    additional_tools: Vec<ToolSchema>,
) -> (Receipt, String) {
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
        name: contract.name.clone(),
        version: "1".into(),
        description: String::new(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
        requirements: None,
    }];
    snapshot.view.binding.tools.extend(additional_tools);
    independent_prepare(catalog, &receipt, snapshot);
    let call = ToolCall {
        call_id: "original".into(),
        name: contract.name.clone(),
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
                    tool: AdmittedTool { call, contract },
                },
            )
            .unwrap();
    }
    (receipt, operation)
}

#[test]
fn cancelled_host_search_recovers_without_inventing_stop_or_replaying_and_allows_new_work() {
    // The real extension adapter deliberately uses read_only:false even for websearch.
    // Its caller may lose a response before or after an unknown observer completion.
    for (cancel_before_restart, observer_completed, legacy_missing_result) in [
        (true, false, false),
        (false, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let fixture = Fixture::new();
        let mut catalog = fixture.open();
        let (receipt, operation) = exchange_with_contract(
            &mut catalog,
            true,
            ToolContract {
                name: "websearch".into(),
                schema_version: "1".into(),
                read_only: false,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Run,
                resources: vec![],
            },
        );
        let epoch = catalog.epoch();
        let context = ToolExecutionContext {
            run_id: receipt.run_id.clone(),
            operation_id: operation.clone(),
            origin: ToolOrigin::ModelStep {
                request_id: "model-1".into(),
            },
        };
        let original_owner = ExecutorOwner::External {
            identity: "original-web-provider".into(),
            epoch: "original-web-owner".into(),
        };
        catalog
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::ToolDispatched {
                    context: context.clone(),
                    executor_owner: original_owner.clone(),
                },
            )
            .unwrap();
        if observer_completed {
            catalog
                .commit_execution(
                    &receipt.run_id,
                    epoch,
                    &ExecutionRecord::ToolSettled {
                        context,
                        completion: ToolCompletion::Result {
                            outcome: Outcome::Indeterminate,
                            effect: Effect::Unknown,
                            content: json!({"error":"observer_cancelled"}).into(),
                        },
                        executor_stopped: false,
                    },
                )
                .unwrap();
        }
        if cancel_before_restart {
            catalog.request_cancel_run(&receipt.run_id).unwrap();
        }
        drop(catalog);
        if legacy_missing_result {
            let catalog = fixture.open();
            // 0.9.44 already-recovered Results retained owner/Unknown but no output body.
            // Remove only that newer observation body from an actual reopened operation.
            let mut operation = catalog.operation(&operation).unwrap();
            operation.result = None;
            catalog
                .db
                .execute(
                    "UPDATE operations SET body=?2 WHERE id=?1",
                    params![operation.id, encode(&operation).unwrap()],
                )
                .unwrap();
        }
        let catalog = fixture.open();
        assert_eq!(
            catalog.run(&receipt.run_id).unwrap().state,
            RunState::Waiting
        );
        let supervisor = crate::supervisor::RunSupervisor::new(catalog);
        if cancel_before_restart {
            supervisor.reconcile_message_requests().unwrap();
        } else {
            supervisor.cancel(&receipt.run_id).unwrap();
        }
        supervisor.shutdown().unwrap();
        assert!(
            supervisor
                .execution_failure(&receipt.run_id)
                .unwrap()
                .is_none(),
            "{:?}",
            supervisor.execution_failure(&receipt.run_id).unwrap()
        );
        let owner = supervisor.catalog();
        let mut catalog = owner.lock().unwrap();
        assert_eq!(
            catalog.run(&receipt.run_id).unwrap().state,
            RunState::Cancelled
        );
        let operation_read = catalog.operation(&operation).unwrap();
        assert_eq!(operation_read.execution_owner, Some(original_owner));
        assert_eq!(operation_read.epoch, epoch);
        assert_eq!(operation_read.outcome, Some(Outcome::Indeterminate));
        assert_eq!(operation_read.effect, Effect::Unknown);
        assert!(
            operation_read.external_receipt.is_none(),
            "caller cancellation is not executor evidence"
        );
        assert!(catalog
            .pending_run_operations(&receipt.run_id)
            .unwrap()
            .iter()
            .any(|op| op.id == operation));
        assert!(
            catalog.resource_admission.inspect(&operation).is_some(),
            "original occupancy is not released"
        );
        assert!(!catalog
            .events_after(0, 1000)
            .unwrap()
            .iter()
            .any(|event| event.subject == operation
                && matches!(
                    event.kind.as_str(),
                    "operation.executor_stopped" | "operation.invocation_executor_stopped"
                )));
        let history = catalog.execution_history("main").unwrap();
        assert!(
            matches!(&history.last().unwrap().content, Content::ToolResult { result }
            if matches!(result.completion, ToolCompletion::Result { outcome: Outcome::Indeterminate, effect: Effect::Unknown, .. }))
        );
        assert_eq!(
            history
                .iter()
                .filter(|item| matches!(item.content, Content::ToolResult { .. }))
                .count(),
            1
        );
        assert_cancelled_attention(&catalog, &receipt.run_id, &operation);
        // No provider/ToolExecutor is installed in cancellation recovery. New admission and
        // the real shared scheduler remain available despite the retained empty search claim.
        let mut next = command();
        next.key = "new-search".into();
        next.expected_head = catalog.head("main").unwrap();
        let next_run = catalog.submit(&next).unwrap();
        assert_ne!(next_run.run_id, receipt.run_id);
        let next_lease = catalog
            .resource_admission
            .acquire("new-search-operation", &[], &CancellationToken::default())
            .unwrap();
        assert!(next_lease.is_some());
        drop(next_lease);
        drop(catalog);
        drop(owner);
        drop(supervisor);
        let catalog = fixture.open();
        assert_eq!(
            catalog.run(&receipt.run_id).unwrap().state,
            RunState::Cancelled
        );
        assert_eq!(
            catalog
                .execution_history("main")
                .unwrap()
                .iter()
                .filter(|item| matches!(item.content, Content::ToolResult { .. }))
                .count(),
            1
        );
    }
}

fn assert_cancelled_attention(catalog: &Catalog, run: &str, operation: &str) {
    let attention = catalog.capture_attention_read().load(&|| false).unwrap();
    let branch = attention
        .branches
        .iter()
        .find(|branch| branch.branch_id == "main")
        .unwrap();
    assert!(branch.active_run_id.is_none());
    assert!(branch.current_run.is_none());
    let latest = branch.latest_run.as_ref().unwrap();
    assert_eq!(latest.id, run);
    assert_eq!(latest.state, RunState::Cancelled);
    assert!(branch.has_unsettled_work);
    assert!(attention.items.iter().any(
        |item| item.operation_id.as_deref() == Some(operation) && item.kind == "effect_unknown"
    ));
    assert!(attention
        .stopped_executors
        .iter()
        .all(|stopped| stopped.operation_id != operation));
}

#[test]
fn cancelled_recovery_closes_interrupted_gateway_but_retains_nested_host_search() {
    for legacy_result in [false, true] {
        let fixture = Fixture::new();
        let mut catalog = fixture.open();
        let schema = ToolSchema {
            name: "websearch".into(),
            version: "1".into(),
            description: String::new(),
            schema: json!({"type":"object"}),
            output_schema: None,
            metadata: None,
            requirements: None,
        };
        let (receipt, parent) = exchange_with_tools(
            &mut catalog,
            true,
            ToolContract {
                name: crate::tool_disclosure::INVOKE.into(),
                schema_version: "1".into(),
                read_only: true,
                completion: CompletionKind::Result,
                lifetime: Lifetime::Call,
                resources: vec![],
            },
            vec![schema],
        );
        let epoch = catalog.epoch();
        let parent_context = ToolExecutionContext {
            run_id: receipt.run_id.clone(),
            operation_id: parent.clone(),
            origin: ToolOrigin::ModelStep {
                request_id: "model-1".into(),
            },
        };
        catalog
            .commit_execution(
                &receipt.run_id,
                epoch,
                &ExecutionRecord::ToolDispatched {
                    context: parent_context.clone(),
                    executor_owner: ExecutorOwner::Kernel,
                },
            )
            .unwrap();
        let frozen = catalog
            .capture_tool_invocation(&parent_context, "original")
            .unwrap()
            .load()
            .unwrap()
            .frozen;
        let nested = catalog.nested_tools();
        let owner = Arc::new(Mutex::new(catalog));
        let callback_owner = owner.clone();
        let external = ExecutorOwner::External {
            identity: "original-web-provider".into(),
            epoch: "original-web-owner".into(),
        };
        let callback_external = external.clone();
        // Admit through the original live nested registry, not a fabricated NestedCall row.
        // The worker loses its callback after dispatch, before either tool result was saved.
        let scope = nested
            .register(
                parent_context,
                ExecutorOwner::Kernel,
                Arc::new(frozen),
                CancellationToken::default(),
                Arc::new(move |context, call| {
                    let mut catalog = callback_owner.lock().unwrap();
                    for record in [
                        ExecutionRecord::ToolAdmitted {
                            context: context.clone(),
                            tool: AdmittedTool {
                                call: (*call).clone(),
                                contract: ToolContract {
                                    name: call.name.clone(),
                                    schema_version: "1".into(),
                                    read_only: false,
                                    completion: CompletionKind::Result,
                                    lifetime: Lifetime::Run,
                                    resources: vec![],
                                },
                            },
                        },
                        ExecutionRecord::ToolDispatched {
                            context: context.clone(),
                            executor_owner: callback_external.clone(),
                        },
                    ] {
                        catalog
                            .commit_execution(&context.run_id, epoch, &record)
                            .unwrap();
                    }
                    Err(ExecutionError::new(
                        "interrupted",
                        "worker ended before callback receipt",
                    ))
                }),
            )
            .unwrap();
        assert!(nested
            .invoke(
                &parent,
                &ExecutorOwner::Kernel,
                crate::nested_tools::NestedToolInput {
                    call_id: "target".into(),
                    name: "websearch".into(),
                    arguments: json!({}),
                }
            )
            .is_err());
        let operation = ToolOrigin::NestedCall {
            parent_operation_id: parent.clone(),
        }
        .operation_id("target");
        assert_eq!(
            owner.lock().unwrap().operation(&operation).unwrap().phase,
            OperationPhase::Running
        );
        drop(scope);
        drop(nested);
        drop(owner);
        if legacy_result {
            let catalog = fixture.open();
            // Exact 0.9.44 shape after its first reopen: raw parent interruption body,
            // no child body. Keep the real owner, intent, and dispatch facts unchanged.
            let mut outer = catalog.operation(&parent).unwrap();
            outer.result = Some(OperationResultMetadata::Content {
                reference: catalog
                    .content
                    .save(&json!({"reason":"executor interrupted"}))
                    .unwrap(),
            });
            put(&catalog.db, "operations", &parent, &outer).unwrap();
            let mut child = catalog.operation(&operation).unwrap();
            child.result = None;
            put(&catalog.db, "operations", &operation, &child).unwrap();
        }
        let supervisor = crate::supervisor::RunSupervisor::new(fixture.open());
        supervisor.cancel(&receipt.run_id).unwrap();
        supervisor.shutdown().unwrap();
        assert!(
            supervisor
                .execution_failure(&receipt.run_id)
                .unwrap()
                .is_none(),
            "{:?}",
            supervisor.execution_failure(&receipt.run_id).unwrap()
        );
        let owner = supervisor.catalog();
        let mut catalog = owner.lock().unwrap();
        assert_eq!(
            catalog.run(&receipt.run_id).unwrap().state,
            RunState::Cancelled
        );
        let outer = catalog.operation(&parent).unwrap();
        assert_eq!(outer.outcome, Some(Outcome::Failed));
        assert_eq!(outer.effect, Effect::None);
        assert!(catalog.resource_admission.inspect(&parent).is_none());
        let child = catalog.operation(&operation).unwrap();
        assert_eq!(child.outcome, Some(Outcome::Indeterminate));
        assert_eq!(child.effect, Effect::Unknown);
        assert_eq!(child.execution_owner, Some(external.clone()));
        assert_eq!(child.epoch, epoch);
        assert!(child.external_receipt.is_none());
        assert!(catalog.resource_admission.inspect(&operation).is_some());
        assert_cancelled_attention(&catalog, &receipt.run_id, &operation);
        let history = catalog.execution_history("main").unwrap();
        assert!(
            matches!(&history.last().unwrap().content, Content::ToolResult { result }
            if matches!(result.completion, ToolCompletion::Result { outcome: Outcome::Failed, effect: Effect::None, .. }))
        );
        let mut next = command();
        next.key = "after-gateway".into();
        next.expected_head = catalog.head("main").unwrap();
        assert_ne!(catalog.submit(&next).unwrap().run_id, receipt.run_id);
        let lease = catalog
            .resource_admission
            .acquire("after-gateway-search", &[], &CancellationToken::default())
            .unwrap();
        assert!(lease.is_some());
        drop(lease);
        let prepared = catalog
            .prepare_result_content()
            .write_external_receipt(ExternalReceipt {
                executor: "websearch".into(),
                identity: operation.clone(),
                epoch: "original-web-owner".into(),
                outcome: Outcome::Succeeded,
                effect: Effect::Confirmed,
                result: json!({"late":"original result"}).into(),
            })
            .unwrap();
        catalog
            .record_external_tool_receipt_prepared(&operation, &external, prepared, true)
            .unwrap();
        assert!(catalog.resource_admission.inspect(&operation).is_none());
        assert_eq!(
            catalog
                .execution_history("main")
                .unwrap()
                .iter()
                .filter(|item| matches!(item.content, Content::ToolResult { .. }))
                .count(),
            1
        );
        assert_eq!(
            catalog.run(&receipt.run_id).unwrap().state,
            RunState::Cancelled
        );
    }
}

#[test]
fn cancelled_recovery_never_replays_unknown_results_or_closes_independent_job_observers() {
    for (completion, lifetime) in [
        (CompletionKind::Result, Lifetime::Run),
        (CompletionKind::Job, Lifetime::Thread),
    ] {
        let fixture = Fixture::new();
        let mut catalog = fixture.open();
        let (receipt, operation) = exchange_with_contract(
            &mut catalog,
            true,
            ToolContract {
                name: "original".into(),
                schema_version: "1".into(),
                read_only: false,
                completion,
                lifetime,
                resources: vec![],
            },
        );
        let binding = catalog
            .content
            .load_snapshot(
                &record::<ModelStep>(&catalog.db, "model_steps", "model-1")
                    .unwrap()
                    .request,
            )
            .unwrap()
            .view
            .binding;
        catalog
            .commit_execution(
                &receipt.run_id,
                catalog.epoch(),
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
        drop(catalog);
        let mut catalog = fixture.open();
        let error = catalog
            .prepare_recovered_execution(
                &receipt.run_id,
                binding,
                DefaultAgentPolicy.identity(),
                Value::Null,
            )
            .err()
            .unwrap();
        assert!(
            error
                .to_string()
                .contains("tool effect requires executor reconciliation before recovery"),
            "{error}"
        );
        assert!(!catalog.run(&receipt.run_id).unwrap().cancel_requested);
        if completion == CompletionKind::Job {
            let supervisor = crate::supervisor::RunSupervisor::new(catalog);
            supervisor.cancel(&receipt.run_id).unwrap();
            supervisor.shutdown().unwrap();
            let owner = supervisor.catalog();
            let catalog = owner.lock().unwrap();
            assert_eq!(
                catalog.run(&receipt.run_id).unwrap().state,
                RunState::Waiting
            );
            assert!(catalog.resource_admission.inspect(&operation).is_some());
            assert!(!catalog
                .execution_history("main")
                .unwrap()
                .iter()
                .any(|item| matches!(item.content, Content::ToolResult { .. })));
        }
    }
}

#[test]
fn cancelled_result_keeps_conflicting_resources_until_original_late_stop_receipt() {
    let fixture = Fixture::new();
    let mut catalog = fixture.open();
    let claim = ResourceClaim {
        key: "original-source".into(),
        access: Access::Read,
    };
    let (receipt, operation) = exchange_with_contract(
        &mut catalog,
        true,
        ToolContract {
            name: "write".into(),
            schema_version: "1".into(),
            read_only: false,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![claim.clone()],
        },
    );
    let epoch = catalog.epoch();
    let original_owner = ExecutorOwner::External {
        identity: "original-owner".into(),
        epoch: "original-epoch".into(),
    };
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
                executor_owner: original_owner.clone(),
            },
        )
        .unwrap();
    drop(catalog);
    let supervisor = crate::supervisor::RunSupervisor::new(fixture.open());
    supervisor.cancel(&receipt.run_id).unwrap();
    supervisor.shutdown().unwrap();
    assert!(
        supervisor
            .execution_failure(&receipt.run_id)
            .unwrap()
            .is_none(),
        "{:?}",
        supervisor.execution_failure(&receipt.run_id).unwrap()
    );
    let owner = supervisor.catalog();
    let mut catalog = owner.lock().unwrap();
    assert_eq!(
        catalog.run(&receipt.run_id).unwrap().state,
        RunState::Cancelled
    );
    let history = catalog.execution_history("main").unwrap();
    let write = ResourceClaim {
        access: Access::Write,
        ..claim
    };
    let mut waiting = catalog
        .resource_admission
        .reserve_unmetered(
            "later-source-cleanup",
            vec![ResourceIntent::Exact(write.clone())],
            &CancellationToken::default(),
        )
        .unwrap();
    waiting.resolve(&[write]).unwrap();
    assert!(
        waiting.try_acquire().is_pending(),
        "cancelled Run cannot release original readers or Source cleanup barriers"
    );
    let forged = ExecutorOwner::External {
        identity: "original-owner".into(),
        epoch: "replacement-epoch".into(),
    };
    let prepared = catalog
        .prepare_result_content()
        .write_external_receipt(original_receipt(&operation, true))
        .unwrap();
    assert!(catalog
        .record_external_tool_receipt_prepared(&operation, &forged, prepared, true)
        .is_err());
    assert!(waiting.try_acquire().is_pending());
    let prepared = catalog
        .prepare_result_content()
        .write_external_receipt(original_receipt(&operation, true))
        .unwrap();
    catalog
        .record_external_tool_receipt_prepared(&operation, &original_owner, prepared, false)
        .unwrap();
    assert!(
        waiting.try_acquire().is_pending(),
        "even a known effect is not physical stop evidence"
    );
    let prepared = catalog
        .prepare_result_content()
        .write_external_receipt(original_receipt(&operation, true))
        .unwrap();
    let actual = catalog
        .record_external_tool_receipt_prepared(&operation, &original_owner, prepared, true)
        .unwrap();
    assert_eq!(actual.outcome, Some(Outcome::Succeeded));
    assert_eq!(actual.effect, Effect::Confirmed);
    assert!(matches!(
        waiting.try_acquire(),
        std::task::Poll::Ready(Ok(Some(_)))
    ));
    assert!(catalog.resource_admission.inspect(&operation).is_none());
    assert_eq!(
        catalog.execution_history("main").unwrap(),
        history,
        "late physical evidence does not rewrite the caller's original unknown observation"
    );
    assert_eq!(
        catalog.run(&receipt.run_id).unwrap().state,
        RunState::Cancelled
    );
    let prepared = catalog
        .prepare_result_content()
        .write_external_receipt(original_receipt(&operation, true))
        .unwrap();
    catalog
        .record_external_tool_receipt_prepared(&operation, &original_owner, prepared, true)
        .unwrap();
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
    assert!(catalog
        .capture_cancelled_recovery(&receipt.run_id)
        .unwrap()
        .is_none());
}
