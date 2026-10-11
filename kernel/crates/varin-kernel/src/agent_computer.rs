//! Computer request metadata is committed under Catalog; bodies are prepared on this worker.
use super::*;
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    let owner = runtime.catalog();
    let lock = || {
        owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))
    };
    let detail = |reason: Option<String>| -> Result<_, KernelError> {
        reason
            .map(|reason| {
                let preparation = lock()?.prepare_result_content();
                preparation.write_result(&json!(reason)).map_err(domain)
            })
            .transpose()
    };
    if cancelled.load(Ordering::Acquire)
        && !matches!(
            method,
            "runtime.computer.decision.settle" | "runtime.computer.request.cancel"
        )
    {
        return Err(KernelError::Cancelled);
    }
    match method {
        "runtime.computer.scope" => {
            let p: ComputerScopeParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?
                    .computer_scope(
                        &p.thread_id,
                        &p.branch_id,
                        p.run_id.as_deref(),
                        p.operation_id.as_deref(),
                    )
                    .map_err(domain)?,
            )?)
        }
        "runtime.computer.request.create" => {
            let p: ComputerRequestCreateParams = serde_json::from_value(params)?;
            let prepared = lock()?
                .prepare_computer_request(
                    &p.operation_id,
                    p.desktop_id,
                    p.access,
                    p.reason,
                    varin_runtime::catalog::observations::wall_time_ms().map_err(domain)?,
                )
                .map_err(domain)?;
            let prepared = prepared.load().map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(
                lock()?.admit_computer_request(prepared).map_err(domain)?,
            )?)
        }
        "runtime.computer.request.list" => {
            let p: ComputerRequestListParams = serde_json::from_value(params)?;
            let read = {
                let mut db = lock()?;
                db.reconcile_computer_requests(None).map_err(domain)?;
                db.capture_computer_requests(
                    p.root_thread_id.as_deref(),
                    p.root_branch_id.as_deref(),
                )
                .map_err(domain)?
            };
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.computer.decision.begin" => {
            let p: ComputerDecisionBeginParams = serde_json::from_value(params)?;
            let body = detail(p.reason)?;
            let revision = p.expected_revision.try_into().map_err(|_| {
                KernelError::Protocol("Computer request revision must be nonnegative".into())
            })?;
            Ok(serde_json::to_value(
                lock()?
                    .begin_computer_decision(
                        &p.request_id,
                        revision,
                        p.actor,
                        p.approved,
                        p.host_epoch,
                        p.assignment_id,
                        body,
                    )
                    .map_err(domain)?,
            )?)
        }
        "runtime.computer.decision.settle" => {
            let p: ComputerDecisionSettleParams = serde_json::from_value(params)?;
            let body = detail(p.reason)?;
            Ok(serde_json::to_value(
                lock()?
                    .settle_computer_decision(&p.request_id, &p.claim, p.status, body)
                    .map_err(domain)?,
            )?)
        }
        "runtime.computer.request.cancel" => {
            let p: ComputerRequestCancelParams = serde_json::from_value(params)?;
            lock()?.cancel_computer_requests(p.target).map_err(domain)?;
            Ok(Value::Null)
        }
        "runtime.computer.request.reconcile" => {
            let p: ComputerRequestReconcileParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?
                    .reconcile_computer_requests(p.host_epoch.as_deref())
                    .map_err(domain)?,
            )?)
        }
        "runtime.computer.request.wait" => {
            let p: ComputerRequestWaitParams = serde_json::from_value(params)?;
            let read = {
                let mut db = lock()?;
                let op = db
                    .wait_for_computer_request(&p.operation_id, &p.request_id)
                    .map_err(domain)?;
                db.capture_operation_read(op)
            };
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        _ => Err(KernelError::Protocol(
            "Unknown Computer request command".into(),
        )),
    }
}
