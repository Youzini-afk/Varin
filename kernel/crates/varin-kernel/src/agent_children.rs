//! Child projections load immutable task/launch bodies on a request worker.
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
    if method == "runtime.child.report.read" {
        let p: ChildReportReadParams = serde_json::from_value(params)?;
        let offset = usize::try_from(p.offset.unwrap_or(0))
            .map_err(|_| KernelError::Protocol("invalid offset".into()))?;
        let max = usize::try_from(p.max_bytes.unwrap_or(65536))
            .map_err(|_| KernelError::Protocol("invalid maxBytes".into()))?;
        let read = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_child_report(&p.operation_id, &p.item_id, offset, max)
            .map_err(domain)?;
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if method == "runtime.child.list" {
        let reads = {
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            catalog
                .child_tasks()
                .map_err(domain)?
                .into_iter()
                .map(|child| catalog.capture_child_read(child))
                .collect::<Vec<_>>()
        };
        let children = reads
            .into_iter()
            .map(|read| read.load().map_err(domain))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(serde_json::to_value(children)?);
    }
    if method == "runtime.child.for_thread" {
        let p: ThreadParams = serde_json::from_value(params)?;
        let read = {
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            catalog
                .child_task_for_thread(&p.thread_id)
                .map_err(domain)?
                .map(|child| catalog.capture_child_read(child))
        };
        return Ok(serde_json::to_value(
            read.map(|read| read.load().map_err(domain)).transpose()?,
        )?);
    }
    let read = {
        let mut catalog = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
        let child = if method == "runtime.child.fail" {
            let p: ChildFailParams = serde_json::from_value(params)?;
            if ![
                "preparation_failed",
                "source_unavailable",
                "credentials_unavailable",
                "binding_changed",
            ]
            .contains(&p.code.as_str())
            {
                return Err(KernelError::Protocol(
                    "unknown child preparation failure".into(),
                ));
            }
            catalog
                .fail_child_preparation(&p.operation_id, &p.code)
                .map_err(domain)?
        } else {
            let p: OperationParams = serde_json::from_value(params)?;
            match method {
                "runtime.child.inspect" => catalog.child_task(&p.operation_id),
                "runtime.child.release" => catalog.mark_child_resources_released(&p.operation_id),
                _ => {
                    return Err(KernelError::Protocol(
                        "unknown child projection command".into(),
                    ))
                }
            }
            .map_err(domain)?
        };
        catalog.capture_child_read(child)
    };
    Ok(serde_json::to_value(read.load().map_err(domain)?)?)
}
