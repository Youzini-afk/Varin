//! Original MCP server/user exchange facts. Bodies are read and written outside the Catalog lock.
use super::*;
fn invocation(
    catalog: &Catalog,
    id: &str,
) -> Result<varin_runtime::catalog::tool_content::ToolInvocationRead, KernelError> {
    let op = catalog.operation(id).map_err(domain)?;
    let intent =
        varin_runtime::catalog::tool_content::ToolIntent::from_operation(&op).map_err(domain)?;
    catalog
        .capture_tool_invocation(
            &varin_runtime::execution::ToolExecutionContext {
                run_id: op.run_id,
                operation_id: op.id,
                origin: intent.origin().clone(),
            },
            &intent.call().call_id,
        )
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
    macro_rules! db {
        () => {
            owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
        };
    }
    match method {
        "runtime.mcp.interaction.open" => {
            let p: McpInteractionOpenParams = serde_json::from_value(params)?;
            let (read, prep) = {
                let db = db!();
                (
                    invocation(&db, &p.binding.operation_id)?,
                    db.prepare_result_content(),
                )
            };
            let (snapshot, frozen) = read.load_mcp().map_err(domain)?;
            let body = prep
                .write_data(&json!({"request":p.request,"presentation":p.presentation}))
                .map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(
                db!()
                    .open_mcp_interaction(p.id, p.binding, p.mode, body, &snapshot, &frozen)
                    .map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.list" => {
            let p: McpInteractionListParams = serde_json::from_value(params)?;
            let read = db!()
                .capture_mcp_interactions(
                    &p.thread_id,
                    &p.branch_id,
                    p.cursor.as_deref(),
                    u64::try_from(p.limit.unwrap_or(40))
                        .map_err(|_| KernelError::Protocol("Invalid page size".into()))?,
                )
                .map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.mcp.interaction.read" => {
            let p: McpInteractionReadParams = serde_json::from_value(params)?;
            let read = db!()
                .capture_mcp_interaction(&p.operation_id, &p.interaction_id)
                .map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.mcp.interaction.respond" => {
            let p: McpInteractionRespondParams = serde_json::from_value(params)?;
            let choice =
                serde_json::from_value(p.response.get("action").cloned().unwrap_or(Value::Null))?;
            let prep = db!().prepare_result_content();
            let body = prep.write_data(&p.response).map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(
                db!()
                    .respond_mcp_interaction(
                        &p.operation_id,
                        &p.interaction_id,
                        u64::try_from(p.expected_revision)
                            .map_err(|_| KernelError::Protocol("Invalid revision".into()))?,
                        choice,
                        body,
                    )
                    .map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.pending" => Ok(serde_json::to_value(
            db!().pending_mcp_interactions().map_err(domain)?,
        )?),
        "runtime.mcp.interaction.response.begin" => {
            let p: McpInteractionControlParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                db!()
                    .begin_mcp_interaction_response(&p.binding, &p.interaction_id)
                    .map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.response.settle" => {
            let p: McpInteractionSettleParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                db!()
                    .settle_mcp_interaction_response(&p.binding, &p.interaction_id, p.delivery)
                    .map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.close" => {
            let p: McpInteractionCloseParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                db!()
                    .close_mcp_interaction(&p.binding, &p.interaction_id, p.availability, p.problem)
                    .map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.complete" => {
            let p: McpInteractionControlParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                db!()
                    .complete_mcp_interaction(&p.binding, &p.interaction_id)
                    .map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.release_source" => {
            let p: RunParams = serde_json::from_value(params)?;
            db!()
                .release_mcp_interaction_source(&p.run_id)
                .map_err(domain)?;
            Ok(json!({}))
        }
        _ => Err(KernelError::Protocol(
            "Unknown MCP interaction method".into(),
        )),
    }
}
