//! Main-Thread plans. Catalog supplies frozen identity; KnowledgeStore owns bodies and receipts.
use super::plan_bridge::PlanBridge;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};

const TOOL: &str = "todo";
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new(TOOL, value.to_string())
}

// Status semantics and rendering belong solely to the shared TodoItem Host owner.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Item {
    #[serde(rename = "text")]
    _text: String,
    #[serde(rename = "status")]
    _status: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Arguments {
    Read,
    Update {
        #[serde(rename = "expectedRef")]
        expected_ref: crate::protocol_generated::RequiredNullable<String>,
        #[serde(rename = "items")]
        _items: Vec<Item>,
    },
}
fn args(call: &ToolCall) -> Result<Arguments, ExecutionError> {
    let args: Arguments = serde_json::from_value(call.arguments.clone()).map_err(error)?;
    match &args {
        Arguments::Read
            if call
                .arguments
                .as_object()
                .is_none_or(|value| value.len() != 1) =>
        {
            return Err(error("read accepts only action"));
        }
        Arguments::Update { expected_ref, .. }
            if call.arguments.get("expectedRef").is_none()
                || expected_ref
                    .0
                    .as_ref()
                    .is_some_and(|value| value.is_empty()) =>
        {
            return Err(error(
                "expectedRef must be an explicit nonempty reference or null",
            ));
        }
        _ => {}
    }
    Ok(args)
}
pub(crate) fn schema() -> ToolSchema {
    ToolSchema {
        name: TOOL.into(),
        version: "1".into(),
        schema: json!({"type":"object","description":"Read or replace this conversation's plan. Read first, then update using the exact returned plan ref (null when absent). A conflicting update changes nothing; read again before revising. Owner identity is fixed by the runtime.",
            "properties":{"action":{"type":"string","enum":["read","update"]},"expectedRef":{"type":["string","null"]},
                "items":{"type":"array","items":{"type":"object","properties":{"text":{"type":"string"},"status":{"type":"string","description":"Shared TodoItem status: pending, in_progress, completed, or blocked."}},"required":["text","status"],"additionalProperties":false}}},
            "required":["action"],"additionalProperties":false}),
    }
}
/// Both schema exposure and execution revalidate the real ordinary main Thread admission.
pub(crate) fn eligible(catalog: &Catalog, run_id: &str) -> Result<bool, ExecutionError> {
    let run = catalog.run(run_id).map_err(error)?;
    if catalog.is_context_job(run_id).map_err(error)? {
        return Ok(false);
    }
    let basis = catalog.run_context_scope(run_id).map_err(error)?;
    Ok(basis.is_some_and(|basis| {
        basis.mode == "agent" && basis.thread_role == "main" && basis.session_id == run.thread_id
    }) && catalog
        .child_task_for_thread(&run.thread_id)
        .map_err(error)?
        .is_none())
}
pub(crate) fn declaration(
    catalog: Arc<Mutex<Catalog>>,
    bridge: PlanBridge,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(),
        Arc::new(PlanTools { catalog, bridge }),
    )
}
struct PlanTools {
    catalog: Arc<Mutex<Catalog>>,
    bridge: PlanBridge,
}

/// The original Operation epoch is mutation intent. Catalog/transport epochs independently
/// authenticate today's caller; recovery must never rewrite that original intent.
fn query(
    owner: &Mutex<Catalog>,
    context: &ToolExecutionContext,
    call: &ToolCall,
    contract: &ToolContract,
    receipt: bool,
) -> Result<Value, ExecutionError> {
    let ToolOrigin::ModelStep { request_id } = &context.origin else {
        return Err(error("plan requires a conversation model call"));
    };
    let read_only = matches!(args(call)?, Arguments::Read);
    if call.name != TOOL
        || call.schema_version != "1"
        || contract.name != TOOL
        || contract.schema_version != "1"
        || contract.read_only != read_only
        || contract.completion != CompletionKind::Result
        || contract.lifetime != Lifetime::Run
        || !contract.resources.is_empty()
        || (receipt && read_only)
        || context.operation_id != format!("{request_id}:tool:{}", call.call_id)
    {
        return Err(error("plan call does not match its admitted contract"));
    }
    let intent = varin_runtime::catalog::tool_content::ToolIntent::fingerprint(&context.origin, call, contract)
        .map_err(error)?;
    let (epoch, run, read) = {
        let catalog = owner.lock().map_err(error)?;
        if !eligible(&catalog, &context.run_id)? {
            return Err(error("plan requires an ordinary main Thread"));
        }
        (
            catalog.epoch(),
            catalog.run(&context.run_id).map_err(error)?,
            catalog.capture_model_step_read(request_id).map_err(error)?,
        )
    };
    let step = read.metadata.clone();
    let snapshot: RequestSnapshot =
        serde_json::from_value(read.load_request().map_err(error)?).map_err(error)?;
    if step.run_id != run.id
        || snapshot.view.run_id != run.id
        || snapshot.view.request_id != *request_id
        || snapshot.view.binding.history_range.branch_id != run.branch_id
        || !matches!(&snapshot.view.origin, RequestOrigin::Conversation { history_range, .. } if history_range == &snapshot.view.binding.history_range)
        || !snapshot.view.binding.tools.contains(&schema())
    {
        return Err(error(
            "plan request is not the admitted conversation snapshot",
        ));
    }
    let (operation_epoch, view) = {
        let catalog = owner.lock().map_err(error)?;
        let current = catalog.run(&context.run_id).map_err(error)?;
        let current_step = catalog.model_step_metadata(request_id).map_err(error)?;
        if catalog.epoch() != epoch
            || current_step.request != step.request
            || current_step.run_id != run.id
        {
            return Err(error("plan request owner changed during preparation"));
        }
        if !receipt
            && (current.epoch != epoch
                || current.cancel_requested
                || current.state.terminal()
                || current_step.superseded_by_input.is_some())
        {
            return Err(error("plan execution generation is no longer active"));
        }
        if !receipt {
            catalog
                .inspect_admission(&run.id, epoch, &context.origin, &call.call_id)
                .map_err(error)?;
        }
        let operation_epoch = if read_only {
            step.epoch
        } else {
            let operation = catalog.operation(&context.operation_id).map_err(error)?;
            if operation.run_id != run.id
                || varin_runtime::catalog::tool_content::ToolIntent::from_operation(&operation)
                    .map_err(error)?
                    != intent
                || (!receipt && (operation.epoch != epoch || operation.cancel_requested))
            {
                return Err(error(
                    "plan operation does not match its original admission",
                ));
            }
            operation.epoch
        };
        (
            operation_epoch,
            catalog
                .plan_view(
                    &run.branch_id,
                    snapshot.view.binding.history_range.leaf_id.as_deref(),
                )
                .map_err(error)?,
        )
    };
    Ok(
        json!({"action":if receipt { "receipt" } else if read_only { "read" } else { "mutate" },
        "view":view,
        "origin":{"kind":"tool","operationId":context.operation_id,"runId":run.id,"requestId":request_id,"callId":call.call_id,"epoch":operation_epoch},
        "arguments":call.arguments}),
    )
}
/// A structured owner receipt is the only evidence for a mutation's effect.
fn mutation_result(query: &Value, value: &Value) -> Option<(Outcome, Effect)> {
    if value["status"] != "ready" {
        return None;
    }
    let receipt = &value["mutation"]["receipt"];
    if receipt["origin"] != query["origin"]
        || receipt["threadId"] != query["view"]["threadId"]
        || receipt["branchId"] != query["view"]["branchId"]
        || receipt["intentHash"].as_str().is_none_or(str::is_empty)
    {
        return None;
    }
    match receipt["status"].as_str() {
        Some("applied")
            if receipt["ref"].as_str().is_some_and(|s| !s.is_empty())
                && value["mutation"]["plan"]["ref"] == receipt["ref"] =>
        {
            Some((Outcome::Succeeded, Effect::Confirmed))
        }
        Some("conflict") => Some((Outcome::Failed, Effect::None)),
        _ => None,
    }
}
impl ToolExecutor for PlanTools {
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, context, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if call.schema_version != "1"
            || !context.tools.contains(&schema())
            || !matches!(context.origin, ToolOrigin::ModelStep { .. })
        {
            return Err(error("plan schema is not bound to a model step"));
        }
        Ok(ToolContract {
            name: TOOL.into(),
            schema_version: "1".into(),
            read_only: matches!(args(call)?, Arguments::Read),
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("plan action cancelled"));
        }
        query(&self.catalog, context, call, contract, false)?;
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        // A failed local check precedes any dispatch and therefore has no external effect.
        let query = match (|| {
            if cancel.is_cancelled() {
                return Err(error("plan action cancelled"));
            }
            query(&self.catalog, context, call, contract, false)
        })() {
            Ok(query) => query,
            Err(failure) => {
                return ToolCompletion::NotDispatched {
                    reason: failure.message,
                }
            }
        };
        let value = match self.bridge.query(query.clone(), cancel) {
            Ok(value) => value,
            Err(failure) => json!({"status":"unknown","message":failure.message}),
        };
        if value["status"] == "rejected" {
            return ToolCompletion::NotDispatched {
                reason: value["message"].as_str().unwrap_or("plan rejected").into(),
            };
        }
        let (outcome, effect) = if contract.read_only {
            (
                if value["status"] == "ready" {
                    Outcome::Succeeded
                } else {
                    Outcome::Failed
                },
                Effect::None,
            )
        } else {
            mutation_result(&query, &value).unwrap_or((Outcome::Indeterminate, Effect::Unknown))
        };
        if !contract.read_only && effect == Effect::None {
            // A real CAS rejection is not "not dispatched". Retain the domain's
            // exact receipt before allowing the dispatched Operation to settle None.
            let recorded = (|| -> Result<(), ExecutionError> {
                let intent =
                    varin_runtime::catalog::tool_content::ToolIntent::fingerprint(&context.origin, call, contract)
                        .map_err(error)?;
                let catalog = self.catalog.lock().map_err(error)?;
                let run = catalog.run(&context.run_id).map_err(error)?;
                let operation = catalog.operation(&context.operation_id).map_err(error)?;
                let admitted =
                    varin_runtime::catalog::tool_content::ToolIntent::from_operation(&operation)
                        .map_err(error)?;
                if run.epoch != catalog.epoch()
                    || operation.run_id != run.id
                    || Some(operation.epoch) != query["origin"]["epoch"].as_u64()
                    || admitted != intent
                {
                    return Err(error(
                        "plan receipt no longer matches the admitted execution",
                    ));
                }
                drop(catalog);
                varin_runtime::catalog::result_content::record_external_receipt(
                        &self.catalog, &operation.id,
                        varin_runtime::ExternalReceipt {
                            identity: operation.id.clone(),
                            executor: TOOL.into(),
                            epoch: operation.epoch.to_string(),
                            outcome,
                            effect,
                            result: value.clone(),
                        }, outcome != Outcome::Indeterminate,
                    )
                    .map_err(error)?;
                Ok(())
            })();
            if let Err(failure) = recorded {
                return ToolCompletion::Result {
                    outcome: Outcome::Indeterminate,
                    effect: Effect::Unknown,
                    content: json!({"status":"unknown","message":failure.message}),
                };
            }
        }
        ToolCompletion::Result {
            outcome,
            effect,
            content: value,
        }
    }
}

/// Receipt lookup only: never replay a mutation after transport loss or owner restart.
pub(crate) fn reconcile(
    runtime: Arc<varin_runtime::supervisor::RunSupervisor>,
    bridge: PlanBridge,
    run_id: String,
    request_id: String,
    responses: crate::transport::Sender,
    finished: Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<(), crate::error::KernelError> {
    std::thread::Builder::new()
        .name("plan-reconcile".into())
        .spawn(move || {
            let result = (|| -> Result<Value, ExecutionError> {
                let (epoch, operations) = {
                    let owner = runtime.catalog();
                    let catalog = owner.lock().map_err(error)?;
                    let operations = catalog
                        .pending_external_operations(TOOL)
                        .map_err(error)?
                        .into_iter()
                        .map(|id| catalog.operation(&id).map_err(error))
                        .collect::<Result<Vec<varin_runtime::OperationMetadata>, _>>()?
                        .into_iter()
                        .filter(|op| op.run_id == run_id)
                        .collect::<Vec<_>>();
                    (catalog.epoch(), operations)
                };
                let mut reconciled = Vec::new();
                let mut unresolved = Vec::new();
                for operation in operations {
                    let read = runtime
                        .catalog()
                        .lock()
                        .map_err(error)?
                        .capture_operation_read(operation);
                    let operation = read.load().map_err(error)?;
                    let admitted: ToolInvocation =
                        serde_json::from_value(operation.intent.clone()).map_err(error)?;
                    if !matches!(admitted.origin,ToolOrigin::ModelStep{..}) || operation.id!=admitted.origin.operation_id(&admitted.call.call_id) {
                        return Err(error("plan recovery currently requires its original model invocation"));
                    }
                    let context = ToolExecutionContext {
                        run_id: run_id.clone(), operation_id: operation.id.clone(), origin:admitted.origin.clone(),
                    };
                    let query = query(
                        &runtime.catalog(),
                        &context,
                        &admitted.call,
                        &admitted.contract,
                        true,
                    )?;
                    let response = bridge.query(query.clone(), &CancellationToken::default())?;
                    let Some((outcome, effect)) = mutation_result(&query, &response) else {
                        unresolved.push(operation.id);
                        continue;
                    };
                    let owner = runtime.catalog();
                    let catalog = owner.lock().map_err(error)?;
                    if catalog.epoch() != epoch {
                        return Err(error("plan reconciliation generation changed"));
                    }
                    drop(catalog);
                    varin_runtime::catalog::result_content::record_external_receipt(
                            &owner, &operation.id,
                            varin_runtime::ExternalReceipt {
                                identity: operation.id.clone(),
                                executor: TOOL.into(),
                                epoch: operation.epoch.to_string(),
                                outcome,
                                effect,
                                result: response,
                            }, outcome != Outcome::Indeterminate,
                        )
                        .map_err(error)?;
                    reconciled.push(operation.id);
                }
                Ok(json!({"reconciled":reconciled,"unresolved":unresolved}))
            })();
            let response = match result {
                Ok(value) => crate::protocol::response_ok(&request_id, value),
                Err(failure) => crate::error::response_error(
                    &request_id,
                    &crate::error::KernelError::Operation(failure.to_string()),
                ),
            };
            finished(&request_id);
            let _ = responses.send(response);
        })
        .map_err(|failure| crate::error::KernelError::Operation(failure.to_string()))?;
    Ok(())
}
