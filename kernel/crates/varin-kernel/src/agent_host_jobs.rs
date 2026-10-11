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
            let body = preparation.write_result(&p.request).map_err(domain)?;
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
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db.begin_host_job(p.binding).map_err(domain)?;
            Ok(serde_json::to_value(
                HostJobPending::from_operation(op).map_err(domain)?,
            )?)
        }
        "runtime.host_job.accept" => {
            let p: HostJobAcceptParams = serde_json::from_value(params)?;
            let preparation = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_result_content();
            let body = preparation.write_result(&p.content).map_err(domain)?;
            // A domain accepted work before this call. Caller cancellation cannot erase that receipt.
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db.accept_host_job(p.binding, body).map_err(domain)?;
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
                .wait_for_host_job(&p.operation_id, &p.target_operation_id)
                .map_err(domain)?;
            let read = db.capture_operation_read(op);
            drop(db);
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
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
            let (preparation, executor) = {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                (
                    db.prepare_result_content(),
                    db.operation(&p.binding.operation_id)
                        .map_err(domain)?
                        .executor
                        .ok_or_else(|| KernelError::Protocol("job executor missing".into()))?,
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
                    result: p.content,
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
