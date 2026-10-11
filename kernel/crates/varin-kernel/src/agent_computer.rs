//! Read-only Computer identity ingress. No physical I/O or ContentStore body loading under Catalog.
use super::*;
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let p: ComputerScopeParams = serde_json::from_value(params)?;
    let owner = runtime.catalog();
    let scope = owner
        .lock()
        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
        .computer_scope(
            &p.thread_id,
            &p.branch_id,
            p.run_id.as_deref(),
            p.operation_id.as_deref(),
        )
        .map_err(domain)?;
    Ok(serde_json::to_value(scope)?)
}
