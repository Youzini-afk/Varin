//! Original MCP server/user exchange facts. Bodies are read and written outside the Catalog lock.
use super::*;
#[path = "agent_mcp_sampling.rs"]
mod sampling;
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
struct InteractionInvocation {
    snapshot: varin_runtime::catalog::tool_content::ToolInvocationSnapshot,
    frozen: varin_runtime::catalog::launches::HostToolBinding,
    cleanup: Option<(
        varin_runtime::catalog::tool_content::ToolInvocationSnapshot,
        varin_runtime::catalog::launches::HostToolBinding,
    )>,
}
impl InteractionInvocation {
    fn cleanup(&self) -> Option<(
        &varin_runtime::catalog::tool_content::ToolInvocationSnapshot,
        &varin_runtime::catalog::launches::HostToolBinding,
    )> {
        self.cleanup.as_ref().map(|(snapshot, frozen)| (snapshot, frozen))
    }
}
fn load_invocation(
    owner: &std::sync::Mutex<Catalog>,
    operation_id: &str,
) -> Result<InteractionInvocation, KernelError> {
    let read = {
        let db = owner.lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
        invocation(&db, operation_id)?
    };
    let (snapshot, frozen) = read.load_mcp().map_err(domain)?;
    // Explicit unsubscribe may target a server removed from the caller's catalog.
    // Load the retained subscribe owner's actual frozen binding outside Catalog too.
    let cleanup = if let Some(varin_runtime::McpRoute::ResourceUnsubscribe { argument }) =
        frozen.routes.get(&snapshot.call.name)
    {
        let target_id = snapshot.call.arguments[argument].as_str()
            .ok_or_else(|| KernelError::Protocol("MCP cleanup target missing".into()))?;
        let read = {
            let db = owner.lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            db.access_mcp_resource(&snapshot.context.run_id, target_id, true).map_err(domain)?;
            invocation(&db, target_id)?
        };
        Some(read.load_mcp().map_err(domain)?)
    } else {
        None
    };
    Ok(InteractionInvocation { snapshot, frozen, cleanup })
}
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    credentials: &crate::credential_bridge::CredentialBridge,
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
        "runtime.mcp.sampling.generate" => sampling::generate(runtime, credentials.clone(), params, cancelled),
        "runtime.mcp.sampling.review_request" | "runtime.mcp.sampling.review_output" => {
            let (operation,id,revision,action) = if method.ends_with("review_request") {
                let p: McpSamplingRequestReviewParams=serde_json::from_value(params)?;
                (p.operation_id,p.interaction_id,p.expected_revision,p.action)
            } else {
                let p: McpSamplingOutputReviewParams=serde_json::from_value(params)?;
                (p.operation_id,p.interaction_id,p.expected_revision,p.action)
            };
            let record=db!().review_mcp_sampling(&operation,&id,revision.try_into().map_err(|_|KernelError::Protocol("Invalid revision".into()))?,&action,method.ends_with("review_output")).map_err(domain)?;
            if action != "accept" { if let Some(id)=record.sampling.as_ref().and_then(|s|s.generation_operation_id.as_deref()) { runtime.cancel_operation_control(id); } }
            Ok(serde_json::to_value(record)?)
        },
        "runtime.mcp.interaction.open" => {
            let p: McpInteractionOpenParams = serde_json::from_value(params)?;
            let invocation = load_invocation(&owner, &p.binding.operation_id)?;
            let prep = db!().prepare_result_content();
            let body = prep
                .write_data(&json!({"request":p.request,"presentation":p.presentation}))
                .map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(
                db!()
                    .open_mcp_interaction(p.id, p.binding, p.mode, &body,
                        &invocation.snapshot, &invocation.frozen, invocation.cleanup())
                    .map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.error.open" => {
            let p: McpInteractionErrorOpenParams = serde_json::from_value(params)?;
            let first = p
                .items
                .first()
                .ok_or_else(|| KernelError::Protocol("Empty MCP error observation".into()))?;
            let invocation = load_invocation(&owner, &first.binding.operation_id)?;
            let prep = db!().prepare_result_content();
            let presentations: Vec<_> = p
                .items
                .iter()
                .map(|item| item.presentation.clone())
                .collect();
            // One publication/fsync for the complete error and every normalized URL.
            let body = prep
                .write_data(&json!({"request":p.request,"presentations":presentations}))
                .map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let items = p
                .items
                .into_iter()
                .map(|item| (item.id, item.binding))
                .collect();
            Ok(serde_json::to_value(
                db!()
                    .open_mcp_error_interactions(items, &body,
                        &invocation.snapshot, &invocation.frozen, invocation.cleanup())
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
        "runtime.mcp.interaction.inspect" => {
            let p:McpInteractionReadParams=serde_json::from_value(params)?;
            db!().inspect_mcp_interaction(&p.operation_id,&p.interaction_id).map_err(domain)
        },
        "runtime.mcp.interaction.context" => {
            let p: McpInteractionReadParams = serde_json::from_value(params)?;
            let invocation = load_invocation(&owner, &p.operation_id)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(
                db!().mcp_interaction_context(&p.operation_id, &p.interaction_id,
                    &invocation.snapshot, &invocation.frozen, invocation.cleanup()).map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.delivery.released" => {
            let p: McpInteractionControlParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                db!().acknowledge_mcp_interaction_delivery_released(&p.binding, &p.interaction_id)
                    .map_err(domain)?,
            )?)
        }
        "runtime.mcp.interaction.pending" => {
            let mut db=db!();
            let records=db.pending_mcp_interactions().map_err(domain)?;
            let values=records.iter().map(|r|db.inspect_mcp_interaction(&r.binding.operation_id,&r.id)).collect::<Result<Vec<_>,varin_runtime::RuntimeError>>();
            Ok(serde_json::to_value(values.map_err(domain)?)?)
        },
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
            let record=db!().close_mcp_interaction(&p.binding, &p.interaction_id, p.availability, p.problem).map_err(domain)?;
            if let Some(id)=record.sampling.as_ref().and_then(|s|s.generation_operation_id.as_deref()) { runtime.cancel_operation_control(id); }
            Ok(serde_json::to_value(record)?)
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
            runtime.reconcile_operation_controls().map_err(|e|KernelError::Operation(e.to_string()))?;
            Ok(json!({}))
        }
        _ => Err(KernelError::Protocol(
            "Unknown MCP interaction method".into(),
        )),
    }
}
