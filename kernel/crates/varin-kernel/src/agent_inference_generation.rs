//! Kernel-owned auxiliary inference for an admitted query, using the original model adapters.
use super::*;
use crate::credential_bridge::CredentialBridge;
use varin_runtime::catalog::inference::generation::{
    GenerationAttempt, GenerationOutput, InferenceGenerateParams, generation_body,
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
                .settle_inference_generation(id, saved, receipt.clone(), body.get("providerOutput").and_then(|v| v.get("usage")).and_then(|v| serde_json::from_value(v.clone()).ok()))
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
    // These local diagnostics contain only configured capacity and measured token counts.
    // Preserve them in the original receipt without exposing arbitrary adapter/auth errors.
    let message = if error.code.starts_with("delegation-selection-capacity-") {
        error.message
    } else {
        "Auxiliary inference could not start; inspect its retained evidence".into()
    };
    let failed = ModelFailure {
        tool_name: None,
        code: error.code,
        message,
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
    let (provider, mut snapshot) = match prepared {
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
    let policy = provider.retry_policy();
    let root_request_id = snapshot.view.request_id.clone();
    let mut retries_used = 0;
    let mut retry_accounted = false;
    let generated = loop {
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
            tool_name: None,
            code: "provider_panicked".into(),
            message: "Auxiliary provider failed after dispatch".into(),
            retry_after_ms: None,
            provider_request_id: None,
        })
    });
    let Some(failed) = generated.as_ref().err() else { break generated; };
    let decision = policy.decide(&failed.into(), retries_used);
    if cancel.is_cancelled() || !decision.retry { break generated; }
    let receipt = InferenceReceipt { request_started: Some(true), provider_completed: false,
        local_executor_stopped: true, usage: InferenceUsage::from(&output.usage), http_status: None,
        problem: Some(InferenceProblem::TransportFailed) };
    let prep = owner.lock().map_err(failure)?.prepare_inference_content();
    let body = prep.write(&generation_body(Some(&snapshot), &output, Some(&receipt), Some(failed), None)).map_err(failure)?;
    owner.lock().map_err(failure)?.finish_inference_attempt(id, body, receipt).map_err(failure)?;
    retry_accounted = true;
    if !varin_runtime::model_retry::wait(cancel, decision.delay_ms) { break generated; }
    // Original query/Run/Goal and credential owners still fence every paid attempt.
    if owner.lock().map_err(failure)?.dispatch_inference_retry(id).is_err() { break generated; }
    retry_accounted = false;
    output.attempts.push(GenerationAttempt { request_id: snapshot.view.request_id.clone(),
        events: std::mem::take(&mut output.events), items: std::mem::take(&mut output.items),
        usage: std::mem::take(&mut output.usage), failure: failed.clone() });
    retries_used += 1;
    snapshot.view.request_id = format!("{root_request_id}:retry:{retries_used}");
    };
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
    output.finish_reason = generated.as_ref().ok().cloned();
    let complete_text = matches!(&snapshot.view.origin, RequestOrigin::AuxiliaryInference { purpose, .. } if purpose != "explore");
    let usable = matches!(generated, Ok(FinishReason::Stop | FinishReason::Length))
        && (!complete_text || matches!(generated, Ok(FinishReason::Stop)))
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
        request_started: (generated.is_ok() || retry_accounted || !output.events.is_empty() || !output.attempts.is_empty()
            || generated.as_ref().err().is_some_and(|e| e.code.starts_with("http_"))).then_some(true),
        provider_completed: generated.is_ok(),
        local_executor_stopped: true,
        usage: InferenceUsage::from(&varin_runtime::model_retry::total_usage(output.attempts.iter().map(|a| &a.usage).chain(std::iter::once(&output.usage)))),
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
    let selection_capacity = selection_input_capacity(&p.purpose, &p.configuration)?;
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
    bound.binding.request_context = Some(owner.lock().map_err(failure)?.model_request_context(&read.operation.run_id).map_err(failure)?);
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
        ].into_iter().map(Into::into).collect(),
    };
    let serialized = bound.provider.serialize_cancellable(&view, None, cancel)?;
    check_selection_capacity(selection_capacity, &view, &serialized)?;
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


fn selection_input_capacity(
    purpose: &str,
    configuration: &varin_runtime::ModelSessionConfiguration,
) -> Result<Option<u64>, ExecutionError> {
    if purpose != "delegation-model-selection" { return Ok(None); }
    let capacity = configuration.context_window_tokens.filter(|value| *value > 0)
        .ok_or_else(|| ExecutionError::new("delegation-selection-capacity-unknown", "Configure the selector model context capacity"))?;
    let reserve = configuration.max_output_tokens.unwrap_or(2048).max(capacity.div_ceil(10));
    Ok(Some(capacity.saturating_sub(reserve)))
}

fn check_selection_capacity(
    available: Option<u64>,
    view: &RequestView,
    serialized: &RequestBody,
) -> Result<(), ExecutionError> {
    if let Some(available) = available {
        // Only the selected provider serializer knows its actual envelope. This uses
        // the ordinary conversation estimator and executes before any model send.
        let estimate = varin_runtime::context_capacity::estimate_request(view, serialized);
        if estimate.estimated_tokens > available {
            return Err(ExecutionError::new("delegation-selection-capacity-exceeded",
                format!("Serialized selector input requires {} tokens; {} remain after output reserve", estimate.estimated_tokens, available)));
        }
    }
    Ok(())
}

#[cfg(test)]
mod selection_capacity_tests {
    use super::*;

    fn request() -> (varin_runtime::ModelSessionConfiguration, RequestView, RequestBody) {
        let configuration: varin_runtime::ModelSessionConfiguration = serde_json::from_value(serde_json::json!({
            "providerFamily": "openai-responses", "model": "local-capacity-fixture",
            "endpoint": "https://not-contacted.invalid/v1/responses", "credentialEnvironment": null,
            "allowAnonymous": false, "configurationGeneration": 1, "maxOutputTokens": 2048,
            "contextWindowTokens": 16384
        })).unwrap();
        let bound = model_session::bind(configuration.clone()).unwrap();
        let view = RequestView {
            request_id: "capacity-fixture".into(), run_id: "selection-run".into(),
            origin: RequestOrigin::AuxiliaryInference { operation_id: "selection".into(), parent_operation_id: "child".into(), purpose: "delegation-model-selection".into() },
            binding: bound.binding,
            history: vec![
                ConversationItem { resource_activation: None, id: "system".into(), provenance: Provenance::SystemInstruction { source: "selection".into() },
                    content: Content::Text { text: "Select one valid model and thinking option.".into() }, opaque: None },
                ConversationItem { resource_activation: None, id: "user".into(), provenance: Provenance::ExternalData { source: "selection".into() },
                    content: Content::Text { text: "{\"task\":\"Check the patch\",\"choices\":[{\"model\":\"candidate\",\"thinking\":\"off\"}]}".into() }, opaque: None },
            ].into_iter().map(Into::into).collect(),
        };
        let serialized = bound.provider.serialize(&view, None).unwrap();
        (configuration, view, serialized)
    }

    #[test]
    fn actual_provider_wrapper_can_exceed_reserve_when_text_alone_fits() {
        let (mut configuration, view, serialized) = request();
        let counter = varin_runtime::token_count::TokenCounter::for_binding(&view.binding.model, view.binding.tokenizer.as_ref());
        let text_only: u64 = view.history.iter().map(|item| match &item.content { Content::Text { text } => counter.count(text), _ => 0 }).sum();
        let actual = varin_runtime::context_capacity::estimate_request(&view, &serialized).estimated_tokens;
        let available = actual - 1;
        assert!(text_only < available, "the actual adapter envelope must contribute to the input estimate");
        configuration.context_window_tokens = Some(2048 + available);
        let budget = selection_input_capacity("delegation-model-selection", &configuration).unwrap();
        assert_eq!(budget, Some(available));
        let error = check_selection_capacity(budget, &view, &serialized).unwrap_err();
        assert_eq!(error.code, "delegation-selection-capacity-exceeded");
        assert!(error.message.contains(&format!("requires {actual} tokens")));
        assert!(error.message.contains(&format!("{available} remain after output reserve")));
    }

    #[test]
    fn fitting_serialized_input_is_admitted_at_the_exact_reserved_boundary() {
        let (mut configuration, view, serialized) = request();
        let actual = varin_runtime::context_capacity::estimate_request(&view, &serialized).estimated_tokens;
        configuration.context_window_tokens = Some(2048 + actual);
        let budget = selection_input_capacity("delegation-model-selection", &configuration).unwrap();
        assert_eq!(budget, Some(actual));
        check_selection_capacity(budget, &view, &serialized).unwrap();
        configuration.max_output_tokens = configuration.context_window_tokens;
        assert_eq!(selection_input_capacity("delegation-model-selection", &configuration).unwrap(), Some(0));
        assert!(check_selection_capacity(Some(0), &view, &serialized).is_err());
    }

    #[test]
    fn missing_capacity_is_concrete_and_other_auxiliary_purposes_are_unchanged() {
        let (mut configuration, view, serialized) = request();
        configuration.context_window_tokens = None;
        assert_eq!(selection_input_capacity("delegation-model-selection", &configuration).unwrap_err().code, "delegation-selection-capacity-unknown");
        let budget = selection_input_capacity("title", &configuration).unwrap();
        assert_eq!(budget, None); check_selection_capacity(budget, &view, &serialized).unwrap();
    }
}
