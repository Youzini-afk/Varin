//! Operation views and one-action approval bodies use request workers.
use super::*;

pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: &Arc<AtomicBool>,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let owner = runtime.catalog();
    if method == "runtime.operation.calls" {
        let p: OperationParams = serde_json::from_value(params)?;
        let calls = owner.lock().map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .nested_tool_calls(&p.operation_id).map_err(domain)?;
        return Ok(serde_json::to_value(calls)?);
    }
    if method == "runtime.model.presentations" {
        let selection: varin_runtime::catalog::usage::ModelPresentationParams = serde_json::from_value(params)?;
        let read = owner.lock().map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_model_presentations(&selection.request_ids, selection.include_context.unwrap_or(false)).map_err(domain)?;
        return Ok(serde_json::to_value(read.load(&|| cancelled.load(Ordering::Acquire)).map_err(domain)?)?);
    }
    if method == "runtime.thread.usage" {
        let selection: varin_runtime::catalog::usage::ThreadUsageParams = serde_json::from_value(params)?;
        let read = owner.lock().map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_thread_usage(&selection).map_err(domain)?;
        return Ok(serde_json::to_value(read.load(&|| cancelled.load(Ordering::Acquire)).map_err(domain)?)?);
    }
    if method == "runtime.events.read" {
        let p: EventsParams = serde_json::from_value(params)?;
        let cursor = u64::try_from(p.cursor)
            .map_err(|_| KernelError::Protocol("event cursor must be nonnegative".into()))?;
        let limit = u32::try_from(p.limit)
            .map_err(|_| KernelError::Protocol("event limit out of range".into()))?;
        let read = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_events_read(cursor, limit)
            .map_err(domain)?;
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if method == "runtime.thread.attention.read" {
        let _: crate::protocol_generated::KernelEmptyParams = serde_json::from_value(params)?;
        let read = owner.lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_attention_read();
        let snapshot = read.load_cancellable(cancelled.clone()).map_err(domain)?;
        if cancelled.load(Ordering::Acquire) { return Err(KernelError::Cancelled); }
        // The read connection can outlive owner replacement; never publish the old generation.
        if owner.lock().map_err(|_| KernelError::Storage("catalog owner failed".into()))?.epoch() != snapshot.epoch {
            return Err(KernelError::Protocol("attention snapshot belongs to a previous owner epoch".into()));
        }
        return Ok(serde_json::to_value(snapshot)?);
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
                .prepare_permission(json!({"runId":p.call.run_id,"operationId":p.call.operation_id,"origin":p.call.origin,"callId":p.call.call_id,"name":p.call.name,"schemaVersion":p.call.schema_version,"arguments":p.call.arguments}), p.scope);
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
                .decide_permission_with_rule(&p.operation_id, &p.permission_id, &p.decision, p.persisted_rule)
                .map_err(domain)?;
            catalog.capture_operation_read(operation)
        }
        "runtime.operation.inspect" => {
            let p: OperationInspectParams = serde_json::from_value(params)?;
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let operation = match catalog.operation(&p.operation_id) {
                Ok(operation) => operation,
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing == Some(true) => {
                    return Ok(Value::Null);
                }
                Err(error) => return Err(domain(error)),
            };
            catalog.capture_operation_read(operation)
        }
        _ => {
            return Err(KernelError::Protocol(
                "unknown operation projection command".into(),
            ));
        }
    };
    Ok(serde_json::to_value(read.load().map_err(domain)?)?)
}
