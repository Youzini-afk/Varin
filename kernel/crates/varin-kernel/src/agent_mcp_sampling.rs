//! One supervised native model invocation for a reviewed original MCP request.
use super::*;
use crate::credential_bridge::CredentialBridge;
use varin_runtime::execution::{CancellationToken, ExecutionError, ModelFailure, RequestSnapshot};
use varin_runtime::mcp_sampling::{self, SamplingModel, SamplingOutput, SamplingReceipt};

fn runtime_error(error: impl ToString) -> ExecutionError {
    ExecutionError::new("mcp_sampling_execution", error.to_string())
}
fn dispatch_error(error: varin_runtime::RuntimeError) -> ExecutionError {
    if matches!(error, varin_runtime::RuntimeError::GoalChanged) {
        ExecutionError::new(
            "mcp_sampling_goal_unavailable",
            "The original Goal no longer allows inference; review its state, budget and recorded usage",
        )
    } else {
        runtime_error(error)
    }
}
pub(super) fn generate(
    runtime: Arc<RunSupervisor>,
    credentials: CredentialBridge,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    let p: varin_runtime::mcp_sampling::McpSamplingGenerateParams = serde_json::from_value(params)?;
    let owner = runtime.catalog();
    let prep = owner
        .lock()
        .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
        .prepare_sampling_content();
    let admission = prep
        .admission(p.edited_request, &p.configuration)
        .map_err(domain)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let record = owner
        .lock()
        .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
        .admit_mcp_sampling(
            &p.operation_id,
            &p.interaction_id,
            p.expected_revision
                .try_into()
                .map_err(|_| KernelError::Protocol("Invalid revision".into()))?,
            admission,
            p.credential_scope,
        )
        .map_err(domain)?;
    let id = record
        .sampling
        .as_ref()
        .and_then(|s| s.generation_operation_id.clone())
        .ok_or_else(|| KernelError::Operation("Sampling generation identity missing".into()))?;
    let op = owner
        .lock()
        .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
        .operation(&id)
        .map_err(domain)?;
    if op.phase == varin_runtime::OperationPhase::Terminal {
        return Ok(serde_json::to_value(record)?);
    }
    let worker_runtime = runtime.clone();
    let worker_id = id.clone();
    if let Err(error) = runtime.start_operation(
        &id,
        &record.binding.operation_id,
        &record.run_id,
        move |cancel| run(worker_runtime, credentials, &worker_id, cancel),
    ) {
        fail(&runtime, &id, error)?;
    }
    Ok(serde_json::to_value(record)?)
}
fn fail(runtime: &RunSupervisor, id: &str, error: ExecutionError) -> Result<(), KernelError> {
    let owner = runtime.catalog();
    let read = owner
        .lock()
        .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?
        .capture_sampling_generation(id)
        .map_err(domain)?;
    let work = read.load().map_err(domain)?;
    if varin_runtime::catalog::mcp_interactions::sampling::state(&work.operation)
        .map_err(domain)?
        .dispatch
        != "not_started"
    {
        // A worker-admission failure cannot replace evidence from an earlier dispatch.
        return Err(KernelError::Operation(error.to_string()));
    }
    // Preparation failures retain any evidence already owned by this operation.
    let receipt = SamplingReceipt {
        finish_reason: None,
        failure: Some(ModelFailure {
            code: error.code,
            message: "Sampling could not finish; review its retained evidence".into(),
            retry_after_ms: None,
            provider_request_id: None,
        }),
        usage: work.output.usage.clone(),
        provider_completed: false,
        local_executor_stopped: true,
        usable: false,
    };
    publish_generation(runtime, id, &work.output, &receipt, None)
        .map_err(|e| KernelError::Operation(e.to_string()))
}
/// Only this already-computed receipt is retried. No provider or MCP request is repeated.
fn publish_generation(
    runtime: &RunSupervisor,
    id: &str,
    output: &SamplingOutput,
    receipt: &SamplingReceipt,
    response: Option<&Value>,
) -> Result<(), ExecutionError> {
    let owner = runtime.catalog();
    let mut delay = std::time::Duration::from_millis(25);
    loop {
        let attempt = (|| -> Result<(), varin_runtime::RuntimeError> {
            let prep = owner
                .lock()
                .map_err(|_| varin_runtime::RuntimeError::Conflict("Catalog owner failed".into()))?
                .prepare_sampling_content();
            let body = prep.output(output, Some(receipt), response)?;
            owner
                .lock()
                .map_err(|_| varin_runtime::RuntimeError::Conflict("Catalog owner failed".into()))?
                .settle_mcp_sampling(id, body, receipt)
        })();
        match attempt {
            Ok(()) => return Ok(()),
            Err(
                error @ (varin_runtime::RuntimeError::Io(_) | varin_runtime::RuntimeError::Sql(_)),
            ) => {
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
                    return Err(runtime_error(error));
                }
                // A stopped local provider still owns publication until this exact receipt is
                // durable. Backoff affects this operation only, never control or other requests.
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_secs(2));
            }
            Err(error) => return Err(runtime_error(error)),
        }
    }
}

fn run(
    runtime: Arc<RunSupervisor>,
    credentials: CredentialBridge,
    id: &str,
    cancel: &CancellationToken,
) -> Result<(), ExecutionError> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        prepare_and_generate(&runtime, &credentials, id, cancel)
    }))
    .unwrap_or_else(|_| {
        Err(ExecutionError::new(
            "provider_panicked",
            "Sampling provider preparation panicked",
        ))
    });
    if let Err(error) = result {
        let owner = runtime.catalog();
        let operation = owner
            .lock()
            .map_err(runtime_error)?
            .operation(id)
            .map_err(runtime_error)?;
        if operation.phase == varin_runtime::OperationPhase::Terminal {
            return Err(error);
        }
        let state = varin_runtime::catalog::mcp_interactions::sampling::state(&operation)
            .map_err(runtime_error)?;
        if state.dispatch != "not_started" {
            return Err(error);
        }
        fail(&runtime, id, error).map_err(runtime_error)?;
    }
    Ok(())
}
fn prepare_and_generate(
    runtime: &RunSupervisor,
    credentials: &CredentialBridge,
    id: &str,
    cancel: &CancellationToken,
) -> Result<(), ExecutionError> {
    let owner = runtime.catalog();
    let read = owner
        .lock()
        .map_err(runtime_error)?
        .capture_sampling_generation(id)
        .map_err(runtime_error)?;
    let work = read.load().map_err(runtime_error)?;
    if work.operation.cancel_requested || cancel.is_cancelled() {
        return Err(ExecutionError::new(
            "cancelled",
            "Sampling cancelled before generation",
        ));
    }
    let request = mcp_sampling::decode_request(&work.request)?;
    // Metadata that did not reach a provider remains original evidence. An edited request cannot
    // silently increase the server's original cap, even when the selected model allows more.
    if work
        .original_request
        .get("maxTokens")
        .and_then(Value::as_u64)
        .is_some_and(|max| request.max_tokens > max)
    {
        return Err(ExecutionError::new(
            "mcp_sampling_token_limit_invalid",
            "Edited maxTokens exceeds the original request",
        ));
    }
    let configuration = mcp_sampling::configure(work.configuration, &request)?;
    let bound = if let Some(scope) = work.intent.credential_scope {
        let resolver = credentials
            .resolver_for_binding(&work.operation.run_id, id, scope.clone())
            .map_err(|e| ExecutionError::new(e.code, e.message))?;
        model_session::bind_provider_with_credentials(configuration.clone(), resolver, scope)?
    } else {
        let start = model_session::bind(configuration.clone())?;
        model_session::BoundModel {
            binding: start.binding,
            provider: start.provider,
        }
    };
    let mut view = mcp_sampling::request_view(
        &work.intent.interaction_id,
        id,
        &work.intent.parent_operation_id,
        &work.operation.run_id,
        bound.binding,
        &request,
    )?;
    // Execution attribution is frozen from the original tool. It contributes no Goal text,
    // main history or tool authority to this isolated provider request.
    view.binding.goal = work.intent.goal.clone();
    view.binding.request_context = Some(runtime.catalog().lock().map_err(runtime_error)?.model_request_context(&work.operation.run_id).map_err(runtime_error)?);
    let serialized = bound.provider.serialize_cancellable(&view, None, cancel)?;
    let snapshot = RequestSnapshot { view, serialized };
    let model = SamplingModel {
        provider_id: configuration.provider_id,
        provider_family: configuration.provider_family,
        model: configuration.model,
        max_tokens: configuration
            .max_output_tokens
            .unwrap_or(request.max_tokens),
    };
    let prep = owner
        .lock()
        .map_err(runtime_error)?
        .prepare_sampling_content();
    let body = prep.snapshot(&snapshot).map_err(runtime_error)?;
    owner
        .lock()
        .map_err(runtime_error)?
        .prepare_mcp_sampling(id, model, body)
        .map_err(runtime_error)?;
    if cancel.is_cancelled() {
        return Err(ExecutionError::new(
            "cancelled",
            "Sampling cancelled before generation",
        ));
    }
    owner
        .lock()
        .map_err(runtime_error)?
        .dispatch_mcp_sampling(id)
        .map_err(dispatch_error)?;
    let (output, receipt, response) =
        mcp_sampling::generate(bound.provider.as_ref(), &snapshot, cancel, &mut |output| {
            let prep = owner
                .lock()
                .map_err(runtime_error)?
                .prepare_sampling_content();
            let body = prep.output(output, None, None).map_err(runtime_error)?;
            owner
                .lock()
                .map_err(runtime_error)?
                .checkpoint_mcp_sampling(id, body, &output.usage)
                .map_err(runtime_error)
        });
    publish_generation(runtime, id, &output, &receipt, response.as_ref())
}
