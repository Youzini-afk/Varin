//! Operation views and one-action approval bodies use request workers.
use super::*;

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
    if method == "runtime.events.read" {
        let p: EventsParams = serde_json::from_value(params)?;
        let cursor = u64::try_from(p.cursor).map_err(|_| KernelError::Protocol("event cursor must be nonnegative".into()))?;
        let limit = u32::try_from(p.limit).map_err(|_| KernelError::Protocol("event limit out of range".into()))?;
        let read = owner.lock().map_err(|_| KernelError::Storage("catalog owner failed".into()))?.capture_events_read(cursor, limit).map_err(domain)?;
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if method == "runtime.thread.operations.active" {
        let p: ThreadOperationsParams = serde_json::from_value(params)?;
        let reads = {
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            catalog
                .active_thread_operations(&p.thread_id, p.branch_id.as_deref())
                .map_err(domain)?
                .into_iter()
                .map(|operation| catalog.capture_operation_read(operation))
                .collect::<Vec<_>>()
        };
        let operations = reads
            .into_iter()
            .map(|read| read.load().map_err(domain))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(serde_json::to_value(operations)?);
    }
    let read = match method {
        "runtime.permission.open" | "runtime.permission.consume" => {
            let p: PermissionOpenParams = serde_json::from_value(params)?;
            let preparation = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_permission(p.call, p.scope);
            let prepared = preparation.load().map_err(domain)?;
            let mut catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let operation = if method == "runtime.permission.open" {
                catalog.open_permission_prepared(&p.operation_id, &p.permission_id, prepared)
            } else {
                catalog.consume_permission_prepared(&p.operation_id, &p.permission_id, prepared)
            }
            .map_err(domain)?;
            catalog.capture_operation_read(operation)
        }
        "runtime.permission.decide" => {
            let p: PermissionDecideParams = serde_json::from_value(params)?;
            let mut catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let operation = catalog
                .decide_permission(&p.operation_id, &p.permission_id, &p.decision)
                .map_err(domain)?;
            catalog.capture_operation_read(operation)
        }
        "runtime.operation.inspect" => {
            let p: OperationParams = serde_json::from_value(params)?;
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let operation = catalog.operation(&p.operation_id).map_err(domain)?;
            catalog.capture_operation_read(operation)
        }
        _ => {
            return Err(KernelError::Protocol(
                "unknown operation projection command".into(),
            ))
        }
    };
    Ok(serde_json::to_value(read.load().map_err(domain)?)?)
}
