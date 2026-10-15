//! Narrow original MCP resource observer commands. Body work stays outside Catalog.
use super::*;
use varin_runtime::catalog::mcp_resources::McpResourcePending;
fn pending(catalog: &Catalog, op: varin_runtime::OperationMetadata) -> Result<Value, KernelError> {
    Ok(serde_json::to_value(
        catalog.mcp_resource_pending_view(op).map_err(domain)?,
    )?)
}
fn invocation(
    catalog: &Catalog,
    id: &str,
) -> Result<varin_runtime::catalog::tool_content::ToolInvocationRead, KernelError> {
    let op = catalog.operation(id).map_err(domain)?;
    let intent =
        varin_runtime::catalog::tool_content::ToolIntent::from_operation(&op).map_err(domain)?;
    let context = varin_runtime::execution::ToolExecutionContext {
        run_id: op.run_id,
        operation_id: op.id,
        origin: intent.origin().clone(),
    };
    catalog
        .capture_tool_invocation(&context, &intent.call().call_id)
        .map_err(domain)
}
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
        "runtime.mcp.resource.begin" => {
            let p: McpResourceBeginParams = serde_json::from_value(params)?;
            let read = {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                invocation(&db, &p.binding.operation_id)?
            };
            let (snapshot, frozen) = read.load_mcp().map_err(domain)?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .begin_mcp_resource(p.binding, &snapshot, &frozen)
                .map_err(domain)?;
            pending(&db, op)
        }
        "runtime.mcp.resource.accept" => {
            let p: McpResourceAcceptParams = serde_json::from_value(params)?;
            let (prep, receipt_prep, executor) = {
                let db = owner.lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let op = db.mcp_resource_context_operation(&p.binding.operation_id).map_err(domain)?;
                let executor = op.executor.ok_or_else(|| KernelError::Protocol("MCP original executor missing".into()))?;
                (db.prepare_result_content(), db.prepare_result_content(), executor)
            };
            let varin_runtime::ExecutorOwner::External { epoch, .. } = &p.binding.execution_owner else {
                return Err(KernelError::Protocol("MCP original external owner required".into()));
            };
            let body = prep.write_data(&p.content).map_err(domain)?;
            // The original subscribe ACK proves this finite RPC stopped, even
            // when its caller already published an immutable Unknown completion.
            // Both bodies are staged outside Catalog and use existing result ownership.
            let receipt = receipt_prep.write_external_receipt(varin_runtime::ExternalReceipt {
                executor,
                identity: p.binding.operation_id.clone(),
                epoch: epoch.clone(),
                outcome: varin_runtime::Outcome::Succeeded,
                effect: varin_runtime::Effect::Confirmed,
                result: json!({"operationId":p.binding.operation_id,
                    "server":p.binding.endpoint.server,"uri":p.binding.uri,
                    "acknowledgement":p.content}).into(),
            }).map_err(domain)?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db.accept_mcp_resource(&p.binding, &p.listener_id, body, receipt)
                .map_err(domain)?;
            pending(&db, op)
        }
        "runtime.mcp.resource.creation_failed" => {
            let p: McpResourceCreationFailedParams = serde_json::from_value(params)?;
            if p.error.dispatched && p.error.settlement == crate::source_resources::SourceMcpCreationSettlement::Unknown {
                return Err(KernelError::Protocol("MCP creation failure does not prove finite RPC stopped".into()));
            }
            let (prep, executor) = {
                let db = owner.lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let op = db.mcp_resource_context_operation(&p.binding.operation_id).map_err(domain)?;
                let executor = op.executor.ok_or_else(|| KernelError::Protocol("MCP original executor missing".into()))?;
                (db.prepare_result_content(), executor)
            };
            let varin_runtime::ExecutorOwner::External { epoch, .. } = &p.binding.execution_owner else {
                return Err(KernelError::Protocol("MCP original external owner required".into()));
            };
            let dispatched = p.error.dispatched;
            let receipt = prep.write_external_receipt(varin_runtime::ExternalReceipt {
                executor,
                identity: p.binding.operation_id.clone(),
                epoch: epoch.clone(),
                outcome: if dispatched { varin_runtime::Outcome::Indeterminate } else { varin_runtime::Outcome::Failed },
                effect: if dispatched { varin_runtime::Effect::Unknown } else { varin_runtime::Effect::None },
                result: json!({"operationId":p.binding.operation_id,
                    "server":p.binding.endpoint.server,"uri":p.binding.uri,"error":p.error}).into(),
            }).map_err(domain)?;
            let mut db = owner.lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db.fail_mcp_resource_creation(&p.binding, receipt).map_err(domain)?;
            pending(&db, op)
        }
        "runtime.mcp.resource.holder_released" => {
            let p: McpResourceHolderReleasedParams = serde_json::from_value(params)?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .acknowledge_mcp_resource_holder_released(&p.binding)
                .map_err(domain)?;
            pending(&db, op)
        }
        "runtime.mcp.resource.listener" => {
            let p: McpResourceListenerParams = serde_json::from_value(params)?;
            let mut db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .update_mcp_resource_listener(
                    &p.binding,
                    p.expected_listener_id.0.as_deref(),
                    p.listener_id.0,
                    p.availability,
                    p.local_released,
                    p.remote_cleanup,
                    p.problem.0,
                )
                .map_err(domain)?;
            pending(&db, op)
        }
        "runtime.mcp.resource.notify" => {
            let p: McpResourceNotifyParams = serde_json::from_value(params)?;
            let prep = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_mcp_resource_fact(
                    p.binding,
                    p.listener_id,
                    p.fact_id,
                    p.kind,
                    p.notification,
                )
                .map_err(domain)?;
            let body = prep.load().map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let cursor = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .admit_mcp_resource_fact(body)
                .map_err(domain)?;
            Ok(json!({"cursor":cursor}))
        }
        "runtime.mcp.resource.pending" => {
            let values: Vec<McpResourcePending> = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .pending_mcp_resources()
                .map_err(domain)?;
            Ok(serde_json::to_value(values)?)
        }
        "runtime.mcp.resource.release_source" => {
            let p: RunParams = serde_json::from_value(params)?;
            let values = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .release_mcp_resource_source(&p.run_id)
                .map_err(domain)?;
            Ok(serde_json::to_value(values)?)
        }
        "runtime.mcp.resource.access" => {
            let p: McpResourceAccessParams = serde_json::from_value(params)?;
            let db = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let op = db
                .access_mcp_resource(&p.run_id, &p.target_operation_id, p.control)
                .map_err(domain)?;
            pending(&db, op)
        }
        "runtime.mcp.resource.context" => {
            let p: OperationParams = serde_json::from_value(params)?;
            let (read, thread_id) = {
                let db = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                let op = db
                    .mcp_resource_context_operation(&p.operation_id)
                    .map_err(domain)?;
                (
                    invocation(&db, &p.operation_id)?,
                    db.run(&op.run_id).map_err(domain)?.thread_id,
                )
            };
            let (snapshot, binding) = read.load_mcp().map_err(domain)?;
            owner.lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .validate_mcp_resource_context(&p.operation_id, &snapshot, &binding)
                .map_err(domain)?;
            Ok(json!({"threadId":thread_id,"source":snapshot.frozen.source,"binding":binding}))
        }
        _ => Err(KernelError::Protocol(
            "unsupported MCP resource observer command".into(),
        )),
    }
}
