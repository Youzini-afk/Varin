//! Kernel-owned auxiliary inference for an admitted query, using the original model adapters.
use super::*;
use crate::credential_bridge::CredentialBridge;
use varin_runtime::catalog::inference::generation::{
    GenerationOutput, InferenceGenerateParams, generation_body,
};
use varin_runtime::catalog::inference::{InferenceProblem, InferenceReceipt, InferenceUsage};
use varin_runtime::execution::*;

fn failure(error: impl ToString) -> ExecutionError {
    ExecutionError::new("inference_generation_failed", error.to_string())
}
pub(super) fn generate(
    runtime: Arc<RunSupervisor>,
    credentials: CredentialBridge,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    let p: InferenceGenerateParams = serde_json::from_value(params)?;
    let owner = runtime.catalog();
    let prep = owner
        .lock()
        .map_err(|e| KernelError::Operation(e.to_string()))?
        .prepare_inference_content();
    let body = prep.write(&serde_json::to_value(&p)?).map_err(domain)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let status = owner
        .lock()
        .map_err(|e| KernelError::Operation(e.to_string()))?
        .admit_inference_generation(&p, body)
        .map_err(domain)?;
    if status.phase != varin_runtime::OperationPhase::Terminal {
        let read = owner
            .lock()
            .map_err(|e| KernelError::Operation(e.to_string()))?
            .capture_inference_generation(&status.operation_id)
            .map_err(domain)?;
        let id = status.operation_id.clone();
        let worker_runtime = runtime.clone();
        let worker_id = id.clone();
        if let Err(error) = runtime.start_operation(
            &id,
            &p.parent_operation_id,
            &read.operation.run_id,
            move |cancel| run(&worker_runtime, &credentials, &worker_id, cancel),
        ) {
            settle_preparation_failure(&runtime, &id, error)
                .map_err(|e| KernelError::Operation(e.to_string()))?;
        }
    }
    Ok(serde_json::to_value(status)?)
}
fn publish(
    runtime: &RunSupervisor,
    id: &str,
    body: &Value,
    receipt: &InferenceReceipt,
) -> Result<(), ExecutionError> {
    let owner = runtime.catalog();
    let mut delay = std::time::Duration::from_millis(25);
    loop {
        let result = (|| {
            let prep = owner
                .lock()
                .map_err(|e| varin_runtime::RuntimeError::Conflict(e.to_string()))?
                .prepare_inference_content();
            let saved = prep.write(body)?;
            owner
                .lock()
                .map_err(|e| varin_runtime::RuntimeError::Conflict(e.to_string()))?
                .settle_inference_generation(id, saved, receipt.clone())
        })();
        match result {
            Ok(_) => return Ok(()),
            Err(error) => {
                let retryable = match &error {
                    varin_runtime::RuntimeError::Io(_) => true,
                    varin_runtime::RuntimeError::Sql(e) => matches!(
                        e.sqlite_error_code(),
                        Some(
                            rusqlite::ErrorCode::DatabaseBusy
                                | rusqlite::ErrorCode::DatabaseLocked
                                | rusqlite::ErrorCode::SystemIoFailure
                                | rusqlite::ErrorCode::DiskFull
                        )
                    ),
                    _ => false,
                };
                if !retryable || runtime.is_stopping() {
                    return Err(failure(error));
                }
                // Retry only this exact already-observed receipt. Never repeat generation.
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_secs(2));
            }
        }
    }
}
fn settle_preparation_failure(
    runtime: &RunSupervisor,
    id: &str,
    error: ExecutionError,
) -> Result<(), ExecutionError> {
    let owner = runtime.catalog();
    let read = owner
        .lock()
        .map_err(failure)?
        .capture_inference_generation(id)
        .map_err(failure)?;
    let status = owner
        .lock()
        .map_err(failure)?
        .inference_status(id, &read.caller_owner)
        .map_err(failure)?;
    if status.dispatched || status.phase == varin_runtime::OperationPhase::Terminal {
        return Err(error);
    }
    let receipt = InferenceReceipt {
        request_started: Some(false),
        provider_completed: false,
        local_executor_stopped: true,
        usage: InferenceUsage::default(),
        http_status: None,
        problem: Some(InferenceProblem::NotDispatched),
    };
    let failed = ModelFailure {
        code: error.code,
        message: "Auxiliary inference could not start; inspect its retained evidence".into(),
        retry_after_ms: None,
        provider_request_id: None,
    };
    publish(
        runtime,
        id,
        &generation_body(
            None,
            &GenerationOutput::default(),
            Some(&receipt),
            Some(&failed),
            None,
        ),
        &receipt,
    )
}
fn run(
    runtime: &RunSupervisor,
    credentials: &CredentialBridge,
    id: &str,
    cancel: &CancellationToken,
) -> Result<(), ExecutionError> {
    let prepared = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        prepare(runtime, credentials, id, cancel)
    }))
    .unwrap_or_else(|_| Err(failure("Auxiliary provider preparation panicked")));
    let (provider, snapshot) = match prepared {
        Ok(value) => value,
        Err(error) => return settle_preparation_failure(runtime, id, error),
    };
    let owner = runtime.catalog();
    if cancel.is_cancelled() {
        return settle_preparation_failure(runtime, id, failure("cancelled"));
    }
    let dispatched = owner
        .lock()
        .map_err(failure)?
        .dispatch_inference_generation(id);
    if let Err(error) = dispatched {
        return settle_preparation_failure(runtime, id, failure(error));
    }
    let mut output = GenerationOutput::default();
    let generated = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        provider.generate(&snapshot, cancel, &mut |event| {
            let is_usage = matches!(event, ProviderEvent::Usage { .. });
            let durable = matches!(
                event,
                ProviderEvent::ItemCompleted { .. } | ProviderEvent::Usage { .. }
            );
            match &event {
                ProviderEvent::ItemCompleted { item } => output.items.push(item.clone()),
                ProviderEvent::Usage { receipt } => output.usage = receipt.clone(),
                _ => {}
            }
            output.events.push(event);
            if durable {
                let prep = owner.lock().map_err(failure)?.prepare_inference_content();
                let body = prep
                    .write(&generation_body(Some(&snapshot), &output, None, None, None))
                    .map_err(failure)?;
                owner
                    .lock()
                    .map_err(failure)?
                    .checkpoint_inference_generation(id, body, &output)
                    .map_err(failure)?;
            }
            if cancel.is_cancelled() && !is_usage {
                return Err(failure("cancelled"));
            }
            Ok(())
        })
    }))
    .unwrap_or_else(|_| {
        Err(ModelFailure {
            code: "provider_panicked".into(),
            message: "Auxiliary provider failed after dispatch".into(),
            retry_after_ms: None,
            provider_request_id: None,
        })
    });
    let forbidden = output.items.iter().any(|item| {
        matches!(
            item.content,
            Content::ToolCall { .. }
                | Content::ToolResult { .. }
                | Content::Media { .. }
                | Content::Output { .. }
        )
    }) || output
        .events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ToolArgumentsDelta { .. }));
    let text = output
        .items
        .iter()
        .filter_map(|item| {
            if let Content::Text { text } = &item.content {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let usable = matches!(generated, Ok(FinishReason::Stop | FinishReason::Length))
        && !forbidden
        && !cancel.is_cancelled()
        && !text.trim().is_empty();
    let problem = if cancel.is_cancelled() {
        Some(InferenceProblem::Cancelled)
    } else if generated.is_err() {
        Some(InferenceProblem::TransportFailed)
    } else if !usable {
        Some(InferenceProblem::InvalidResponse)
    } else {
        None
    };
    let receipt = InferenceReceipt {
        // Adapter success/events prove transport entry. A failure before any event does not.
        request_started: (generated.is_ok() || !output.events.is_empty()).then_some(true),
        provider_completed: generated.is_ok(),
        local_executor_stopped: true,
        usage: InferenceUsage::from(&output.usage),
        http_status: None,
        problem,
    };
    let error = generated.err();
    publish(
        runtime,
        id,
        &generation_body(
            Some(&snapshot),
            &output,
            Some(&receipt),
            error.as_ref(),
            usable.then_some(text.as_str()),
        ),
        &receipt,
    )
}
fn prepare(
    runtime: &RunSupervisor,
    credentials: &CredentialBridge,
    id: &str,
    cancel: &CancellationToken,
) -> Result<(Arc<dyn ModelProvider>, RequestSnapshot), ExecutionError> {
    let owner = runtime.catalog();
    let read = owner
        .lock()
        .map_err(failure)?
        .capture_inference_generation(id)
        .map_err(failure)?;
    let p = read.load().map_err(failure)?;
    if cancel.is_cancelled() || read.operation.cancel_requested {
        return Err(failure("cancelled"));
    }
    let resolver = credentials
        .resolver_for_binding(&read.operation.run_id, id, p.credential_scope.clone())
        .map_err(|e| ExecutionError::new(e.code, e.message))?;
    let mut bound = model_session::bind_provider_with_credentials(
        p.configuration,
        resolver,
        p.credential_scope,
    )?;
    bound.binding.history_range = HistoryRange {
        branch_id: String::new(),
        ancestor_id: None,
        leaf_id: None,
    };
    bound.binding.goal = read.goal;
    let view = RequestView {
        request_id: id.into(),
        run_id: read.operation.run_id,
        origin: RequestOrigin::AuxiliaryInference {
            operation_id: id.into(),
            parent_operation_id: p.parent_operation_id,
            purpose: p.purpose.clone(),
        },
        binding: bound.binding,
        history: vec![
            ConversationItem {
                resource_activation: None,
                id: format!("{id}:instruction"),
                provenance: Provenance::SystemInstruction {
                    source: p.purpose.clone(),
                },
                content: Content::Text {
                    text: p.system_prompt,
                },
                opaque: None,
            },
            ConversationItem {
                resource_activation: None,
                id: format!("{id}:input"),
                provenance: Provenance::ExternalData { source: p.purpose },
                content: Content::Text { text: p.user },
                opaque: None,
            },
        ],
    };
    let serialized = bound.provider.serialize(&view)?;
    let snapshot = RequestSnapshot { view, serialized };
    let prep = owner.lock().map_err(failure)?.prepare_inference_content();
    let body = prep
        .write(&generation_body(
            Some(&snapshot),
            &GenerationOutput::default(),
            None,
            None,
            None,
        ))
        .map_err(failure)?;
    owner
        .lock()
        .map_err(failure)?
        .prepare_inference_generation(id, body)
        .map_err(failure)?;
    Ok((bound.provider, snapshot))
}
