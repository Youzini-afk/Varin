//! Private Host domain commands. Body writes run on this worker, outside Catalog.
use super::*;
use varin_runtime::catalog::host_jobs::HostJobPending;
use varin_runtime::{ExecutorOwner, ExternalReceipt};
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let owner = runtime.catalog();
    match method {
        "runtime.research.scopes" => {
            let p: ResearchScopeParams = serde_json::from_value(params)?;
            let result = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .research_scopes(
                    &p.thread_id,
                    &p.branch_id,
                    p.source_run_id.as_deref(),
                    p.operation_id.as_deref(),
                )
                .map_err(domain)?;
            Ok(serde_json::to_value(result)?)
        }
        "runtime.host_job.user" => {
            let p: HostJobUserParams = serde_json::from_value(params)?;
            let preparation = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_result_content();
            let body = preparation.write_data(&p.request).map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .admit_user_host_job(
                    &p.thread_id,
                    &p.branch_id,
                    &p.source_run_id,
                    &p.key,
                    &p.domain,
                    p.domain_version
                        .try_into()
                        .map_err(|_| KernelError::Protocol("job domain version".into()))?,
                    &p.subject_id,
                    body,
                )
                .map_err(domain)?;
            Ok(serde_json::to_value(
                HostJobPending::from_operation(op).map_err(domain)?,
            )?)
        }
        "runtime.host_job.begin" => {
            let p: HostJobBeginParams = serde_json::from_value(params)?;
            let captured = if matches!(
                &p.binding.subject,
                varin_runtime::catalog::host_jobs::HostJobSubject::Mcp { .. }
            ) {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let op = db.operation(&p.binding.operation_id).map_err(domain)?;
                let intent = varin_runtime::catalog::tool_content::ToolIntent::from_operation(&op)
                    .map_err(domain)?;
                let context = varin_runtime::execution::ToolExecutionContext {
                    run_id: op.run_id,
                    operation_id: op.id,
                    origin: intent.origin().clone(),
                };
                Some(
                    db.capture_tool_invocation(&context, &intent.call().call_id)
                        .map_err(domain)?,
                )
            } else {
                None
            };
            let frozen = captured
                .as_ref()
                .map(|read| read.load_mcp())
                .transpose()
                .map_err(domain)?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = if let Some((snapshot, frozen)) = &frozen {
                db.begin_mcp_host_job(p.binding, snapshot, frozen)
            } else {
                db.begin_host_job(p.binding)
            }
            .map_err(domain)?;
            Ok(serde_json::to_value(
                HostJobPending::from_operation(op).map_err(domain)?,
            )?)
        }
        "runtime.host_job.accept" => {
            let p: HostJobAcceptParams = serde_json::from_value(params)?;
            let (preparation, source) = {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let operation = db.operation(&p.binding.operation_id).map_err(domain)?;
                (
                    db.prepare_result_content(),
                    output_source(&operation).map_err(domain)?,
                )
            };
            let output = p
                .content
                .map_media(|media| media.admit(source.clone()))
                .map_err(domain)?;
            let body = preparation.write_output(&output).map_err(domain)?;
            // A domain accepted work before this call. Caller cancellation cannot erase that receipt.
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .accept_host_job_task(p.binding, body, p.task)
                .map_err(domain)?;
            Ok(serde_json::to_value(
                HostJobPending::from_operation(op).map_err(domain)?,
            )?)
        }
        "runtime.host_job.observe" => {
            let p: HostJobObserveParams = serde_json::from_value(params)?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .wait_for_host_job_mode(
                    &p.operation_id,
                    &p.target_operation_id,
                    p.mode.unwrap_or(varin_runtime::HostJobWaitMode::Stopped),
                )
                .map_err(domain)?;
            let read = db.capture_operation_read(op);
            drop(db);
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.host_job.task.update" => {
            let p: HostJobTaskUpdateParams = serde_json::from_value(params)?;
            let (preparation, final_preparation, operation) = {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                (
                    db.prepare_result_content(),
                    db.prepare_result_content(),
                    db.operation(&p.binding.operation_id).map_err(domain)?,
                )
            };
            let body = preparation
                .write_output(&varin_runtime::output::OutputBody {
                    data: p.content,
                    parts: vec![],
                })
                .map_err(domain)?;
            let result = p
                .result
                .map(|result| {
                    let ExecutorOwner::External { epoch, .. } = &p.binding.execution_owner else {
                        return Err(KernelError::Authorization(
                            "Task original external owner required".into(),
                        ));
                    };
                    let source = output_source(&operation).map_err(domain)?;
                    final_preparation
                        .write_external_receipt(ExternalReceipt {
                            executor: operation.executor.clone().ok_or_else(|| {
                                KernelError::Protocol("Task executor missing".into())
                            })?,
                            identity: operation.id.clone(),
                            epoch: epoch.clone(),
                            outcome: result.outcome,
                            effect: result.effect,
                            result: result
                                .content
                                .map_media(|media| media.admit(source.clone()))
                                .map_err(domain)?,
                        })
                        .map(|prepared| (result.kind, prepared))
                        .map_err(domain)
                })
                .transpose()?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .update_mcp_task(
                    &p.binding,
                    p.expected_revision
                        .try_into()
                        .map_err(|_| KernelError::Protocol("task revision".into()))?,
                    p.task,
                    p.availability,
                    p.problem,
                    result,
                    body,
                )
                .map_err(domain)?;
            Ok(serde_json::to_value(
                HostJobPending::from_operation(op).map_err(domain)?,
            )?)
        }
        "runtime.host_job.task.finish" => {
            let p: HostJobBeginParams = serde_json::from_value(params)?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db.finish_mcp_task(&p.binding).map_err(domain)?;
            Ok(serde_json::to_value(
                HostJobPending::from_operation(op).map_err(domain)?,
            )?)
        }
        "runtime.host_job.task.context" => {
            let p: OperationParams = serde_json::from_value(params)?;
            let (read, thread_id) = {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let op = db.operation(&p.operation_id).map_err(domain)?;
                if op
                    .host_job
                    .as_ref()
                    .and_then(|link| link.mcp_task.as_ref())
                    .is_none()
                {
                    return Err(KernelError::Protocol(
                        "Task has no accepted identity".into(),
                    ));
                }
                let intent = varin_runtime::catalog::tool_content::ToolIntent::from_operation(&op)
                    .map_err(domain)?;
                let thread_id = db.run(&op.run_id).map_err(domain)?.thread_id;
                let context = varin_runtime::execution::ToolExecutionContext {
                    run_id: op.run_id,
                    operation_id: op.id,
                    origin: intent.origin().clone(),
                };
                (
                    db.capture_tool_invocation(&context, &intent.call().call_id)
                        .map_err(domain)?,
                    thread_id,
                )
            };
            let (snapshot, binding) = read.load_mcp().map_err(domain)?;
            Ok(
                serde_json::json!({"threadId":thread_id,"source":snapshot.frozen.source,"binding":binding}),
            )
        }
        "runtime.host_job.task.read" => {
            let p: HostJobAccessParams = serde_json::from_value(params)?;
            let read = {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let op = db
                    .access_host_job(
                        &p.run_id,
                        &p.target_operation_id,
                        p.control.unwrap_or(false),
                    )
                    .map_err(domain)?;
                db.capture_operation_read(op)
            };
            read.load_mcp_task().map_err(domain)
        }
        "runtime.host_job.access" => {
            let p: HostJobAccessParams = serde_json::from_value(params)?;
            let db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .access_host_job(
                    &p.run_id,
                    &p.target_operation_id,
                    p.control.unwrap_or(false),
                )
                .map_err(domain)?;
            let read = db.capture_operation_read(op);
            drop(db);
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.host_job.sources" => {
            let p: RunParams = serde_json::from_value(params)?;
            let result = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .host_job_sources(&p.run_id)
                .map_err(domain)?;
            Ok(serde_json::to_value(result)?)
        }
        "runtime.host_job.pending" => {
            let db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let result = db
                .pending_host_jobs()
                .map_err(domain)?
                .into_iter()
                .map(HostJobPending::from_operation)
                .collect::<std::result::Result<Vec<_>, varin_runtime::catalog::RuntimeError>>()
                .map_err(domain)?;
            Ok(serde_json::to_value(result)?)
        }
        "runtime.host_job.terminal" => {
            let p: HostJobTerminalParams = serde_json::from_value(params)?;
            let (preparation, executor, source) = {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let operation = db.operation(&p.binding.operation_id).map_err(domain)?;
                let source = output_source(&operation).map_err(domain)?;
                (
                    db.prepare_result_content(),
                    operation
                        .executor
                        .ok_or_else(|| KernelError::Protocol("job executor missing".into()))?,
                    source,
                )
            };
            let ExecutorOwner::External { epoch, .. } = &p.binding.execution_owner else {
                return Err(KernelError::Authorization(
                    "external job owner required".into(),
                ));
            };
            let prepared = preparation
                .write_external_receipt(ExternalReceipt {
                    executor,
                    identity: p.binding.operation_id.clone(),
                    epoch: epoch.clone(),
                    outcome: p.outcome,
                    effect: p.effect,
                    result: p
                        .content
                        .map_media(|media| media.admit(source.clone()))
                        .map_err(domain)?,
                })
                .map_err(domain)?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .record_host_job_terminal(&p.binding, prepared, p.executor_stopped)
                .map_err(domain)?;
            Ok(serde_json::to_value(
                HostJobPending::from_operation(op).map_err(domain)?,
            )?)
        }
        _ => Err(KernelError::Protocol("unknown Host job command".into())),
    }
}

fn output_source(
    operation: &varin_runtime::OperationMetadata,
) -> Result<varin_runtime::output::OutputSource, varin_runtime::catalog::RuntimeError> {
    Ok(if operation.intent["kind"] == "tool" {
        let intent = varin_runtime::catalog::tool_content::ToolIntent::from_operation(operation)?;
        varin_runtime::output::OutputSource::Tool {
            context: varin_runtime::execution::ToolExecutionContext {
                run_id: operation.run_id.clone(),
                origin: intent.origin().clone(),
                operation_id: operation.id.clone(),
            },
        }
    } else {
        varin_runtime::output::OutputSource::Operation {
            operation_id: operation.id.clone(),
        }
    })
}
