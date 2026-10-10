//! Ordinary memory tools and explicit safe-boundary context preparation.
use super::host_query::OwnerChannel;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::{
    context::ContextScope, memory::MemoryState, personalization::PersonalizationBasis,
};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};
const TOOL: &str = "memory";
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("memory", value.to_string())
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    action: String,
    scope: Option<String>,
    id: Option<u64>,
    content: Option<String>,
    query: Option<String>,
    revision: Option<u64>,
}
fn args(call: &ToolCall, mutations: bool) -> Result<Arguments, ExecutionError> {
    let args: Arguments = serde_json::from_value(call.arguments.clone()).map_err(error)?;
    if !matches!(args.action.as_str(), "read" | "search" | "save" | "delete")
        || args
            .scope
            .as_deref()
            .is_some_and(|scope| !matches!(scope, "global" | "project" | "currentThread"))
        || args.id == Some(0)
        || (args.action == "save" && args.content.as_deref().is_none_or(|s| s.trim().is_empty()))
        || (args.action == "delete" && args.id.is_none())
        || (matches!(args.action.as_str(), "save" | "delete")
            && (!mutations || args.revision.is_none()))
    {
        return Err(error("invalid or ungranted memory action"));
    }
    Ok(args)
}
pub(crate) fn schema(mutations: bool) -> ToolSchema {
    ToolSchema { description: "Read or explicitly maintain ordinary persistent notes. Reads return the current catalog revision; writes require that revision. Scopes are resolved from this conversation's admitted identity. Saved notes commit immediately; system memory snapshots change only at successful compaction.".into(), output_schema: None, metadata: None,
        name: TOOL.into(),
        version: if mutations { "1" } else { "1-read" }.into(),
        schema: json!({"type":"object",
        "properties":{"action":{"type":"string","enum":if mutations {vec!["read","search","save","delete"]} else {vec!["read","search"]}},"scope":{"type":"string","enum":["global","project","currentThread"]},"id":{"type":"integer","minimum":1},"content":{"type":"string"},"query":{"type":"string"},"revision":{"type":"integer","minimum":0}},"required":["action"],"additionalProperties":false}),
    }
}
fn scope(basis: &ContextScope) -> Value {
    json!({"mode":basis.mode,"sessionId":basis.session_id,"projectId":basis.project_id})
}
fn basis(
    catalog: &Arc<Mutex<Catalog>>,
    run_id: &str,
) -> Result<Option<ContextScope>, ExecutionError> {
    let (run, basis) = {
        let catalog = catalog.lock().map_err(error)?;
        (
            catalog.run(run_id).map_err(error)?,
            catalog.run_context_scope(run_id).map_err(error)?,
        )
    };
    if basis
        .as_ref()
        .is_some_and(|basis| basis.session_id != run.thread_id)
    {
        return Err(error("memory admission belongs to another thread"));
    }
    Ok(basis)
}
fn observe_receipt(
    catalog: &Arc<Mutex<Catalog>>,
    run_id: &str,
    receipt: &Value,
) -> Result<(), ExecutionError> {
    loop {
        let preparation = catalog
            .lock()
            .map_err(error)?
            .prepare_memory_receipt(run_id, receipt.clone())
            .map_err(error)?;
        let prepared = preparation.load().map_err(error)?;
        if catalog
            .lock()
            .map_err(error)?
            .publish_memory_state(prepared)
            .map_err(error)?
        {
            return Ok(());
        }
    }
}
pub(crate) fn declaration(
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
    mutations: bool,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(mutations),
        Arc::new(MemoryTools {
            catalog,
            bridge,
            mutations,
        }),
    )
}
pub(crate) fn configure_context(
    mut start: varin_runtime::supervisor::RunStart,
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
) -> varin_runtime::supervisor::RunStart {
    start.context_preparation = Arc::new(Prepare { catalog, bridge });
    start
}
struct MemoryTools {
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
    mutations: bool,
}
impl ToolExecutor for MemoryTools {
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, context, cancel)
            .map(ToolPreparation::Ready)
    }
    fn supports_policy_read(
        &self,
        _: &FrozenToolContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> bool {
        contract.read_only
            && contract.completion == CompletionKind::Result
            && args(call, self.mutations)
                .is_ok_and(|a| matches!(a.action.as_str(), "read" | "search"))
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let schema = schema(self.mutations);
        if call.schema_version != schema.version || !request.tools.contains(&schema) {
            return Err(error("memory schema is not bound"));
        }
        let a = args(call, self.mutations)?;
        Ok(ToolContract {
            name: TOOL.into(),
            schema_version: schema.version,
            read_only: matches!(a.action.as_str(), "read" | "search"),
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
            return Err(error("memory action cancelled"));
        }
        args(call, self.mutations)?;
        let basis = basis(&self.catalog, &context.run_id)?
            .ok_or_else(|| error("memory scope has not been admitted"))?;
        if basis.mode != "agent" {
            return Err(error("Bot memory has a separate owner"));
        }
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = (|| {
            let basis = basis(&self.catalog, &context.run_id)?
                .ok_or_else(|| error("memory scope unavailable"))?;
            let origin = format!("run:{}:{}", context.run_id, context.operation_id);
            let value = self.bridge.query(json!({"action":"tool","runId":context.run_id,"scope":scope(&basis),"origin":origin,"arguments":call.arguments}), cancel)?;
            if value["status"] == "ready" && !value["memoryReceipt"].is_null() {
                observe_receipt(&self.catalog, &context.run_id, &value["memoryReceipt"])?;
            }
            Ok::<_, ExecutionError>(value)
        })();
        match result {
            Ok(value) if value["status"] == "ready" => ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: if contract.read_only {
                    Effect::None
                } else {
                    Effect::Confirmed
                },
                content: value,
            },
            Ok(value) if value["status"] == "rejected" => ToolCompletion::NotDispatched {
                reason: value["message"]
                    .as_str()
                    .unwrap_or("memory action rejected")
                    .into(),
            },
            Ok(value) => ToolCompletion::Result {
                outcome: if contract.read_only {
                    Outcome::Failed
                } else {
                    Outcome::Indeterminate
                },
                effect: if contract.read_only {
                    Effect::None
                } else {
                    Effect::Unknown
                },
                content: value,
            },
            Err(failure) => ToolCompletion::Result {
                outcome: if contract.read_only {
                    Outcome::Failed
                } else {
                    Outcome::Indeterminate
                },
                effect: if contract.read_only {
                    Effect::None
                } else {
                    Effect::Unknown
                },
                content: json!({"error":failure.code,"message":failure.message}),
            },
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    effective_system_prompt: String,
    instruction_sources: Vec<String>,
    memory_checkpoint: Option<String>,
    personalization: PersonalizationBasis,
}
struct Prepare {
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
}
impl ContextPreparation for Prepare {
    fn prepare(
        &self,
        run_id: &str,
        owner_generation: u64,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        let Some(admitted) = basis(&self.catalog, run_id)? else {
            return Ok(());
        };
        loop {
            if cancel.is_cancelled() {
                return Err(error("context preparation cancelled"));
            }
            let (checkpoint, memory_basis) = {
                let catalog = self.catalog.lock().map_err(error)?;
                let run = catalog.run(run_id).map_err(error)?;
                if run.epoch != owner_generation {
                    return Err(error("context owner generation changed"));
                }
                (
                    catalog
                        .capture_active_checkpoint(&run.branch_id)
                        .map_err(error)?
                        .ok_or_else(|| error("active context missing"))?,
                    catalog
                        .memory_state_identity(&run.branch_id)
                        .map_err(error)?,
                )
            };
            let checkpoint = checkpoint.load().map_err(error)?;
            let reply = self.bridge.query(json!({"action":"synchronize","runId":run_id,"scope":scope(&admitted),"checkpoint":checkpoint}), cancel)?;
            if reply["status"] != "ready" {
                return Err(error(
                    reply["message"]
                        .as_str()
                        .unwrap_or("context preparation failed"),
                ));
            }
            let prepared: Prepared =
                serde_json::from_value(reply["context"].clone()).map_err(error)?;
            let state: MemoryState =
                serde_json::from_value(reply["state"].clone()).map_err(error)?;
            if cancel.is_cancelled() {
                return Err(error("context preparation cancelled"));
            }
            let refresh = {
                let catalog = self.catalog.lock().map_err(error)?;
                let current = catalog
                    .capture_active_checkpoint(&checkpoint.proposal.branch_id)
                    .map_err(error)?
                    .ok_or_else(|| error("context disappeared"))?;
                if current.revision != checkpoint.revision {
                    continue;
                }
                if catalog
                    .memory_state_identity(&checkpoint.proposal.branch_id)
                    .map_err(error)?
                    != memory_basis
                {
                    continue;
                }
                catalog
                    .prepare_personalization_refresh(
                        &checkpoint.proposal.branch_id,
                        checkpoint.revision,
                        prepared.effective_system_prompt,
                        prepared.instruction_sources,
                        prepared.memory_checkpoint,
                        prepared.personalization,
                    )
                    .map_err(error)?
            }
            .load()
            .map_err(error)?;
            let mut catalog = self.catalog.lock().map_err(error)?;
            let run = catalog.run(run_id).map_err(error)?;
            if cancel.is_cancelled()
                || run.cancel_requested
                || run.state.terminal()
                || run.epoch != owner_generation
            {
                return Err(error("context preparation is no longer active"));
            }
            let current = catalog
                .capture_active_checkpoint(&checkpoint.proposal.branch_id)
                .map_err(error)?
                .ok_or_else(|| error("context disappeared"))?;
            if current.revision != checkpoint.revision {
                continue;
            }
            if catalog
                .memory_state_identity(&checkpoint.proposal.branch_id)
                .map_err(error)?
                != memory_basis
            {
                continue;
            }
            catalog
                .publish_personalization_refresh(refresh)
                .map_err(error)?;
            let memory = catalog
                .prepare_memory_sync(run_id, owner_generation, state)
                .map_err(error)?;
            drop(catalog);
            let memory = memory.load().map_err(error)?;
            if cancel.is_cancelled() {
                return Err(error("context preparation cancelled"));
            }
            if !self
                .catalog
                .lock()
                .map_err(error)?
                .publish_memory_state(memory)
                .map_err(error)?
            {
                continue;
            }
            return Ok(());
        }
    }
}

/// The domain owner is queried on a worker; control and other Runs remain available.
pub(crate) fn reconcile(
    runtime: Arc<varin_runtime::supervisor::RunSupervisor>,
    bridge: OwnerChannel,
    run_id: String,
    request_id: String,
    responses: crate::transport::Sender,
    finished: Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<(), crate::error::KernelError> {
    std::thread::Builder::new().name("memory-reconcile".into()).spawn(move || {
        let result = (|| -> Result<Value, ExecutionError> {
            let owner = runtime.catalog();
            let Some(admitted) = basis(&owner, &run_id)? else { return Ok(json!({"reconciled":[],"unresolved":[]})); };
            let operations = {
                let owner = runtime.catalog(); let catalog = owner.lock().map_err(error)?;
                let operations = catalog.pending_external_operations(TOOL).map_err(error)?.into_iter()
                    .map(|id| catalog.operation(&id).map_err(error)).collect::<Result<Vec<_>, _>>()?.into_iter().filter(|op| op.run_id == run_id)
                    .map(|operation|catalog.capture_operation_read(operation)).collect::<Vec<_>>();
                operations
            };
            let mut reconciled = Vec::new(); let mut unresolved = Vec::new();
            for read in operations {
                let operation=read.load().map_err(error)?;
                let tool: ToolInvocation = serde_json::from_value(operation.intent.clone()).map_err(error)?;
                let origin = format!("run:{run_id}:{}", operation.id);
                let response = bridge.query(json!({"action":"receipt","runId":run_id,"scope":scope(&admitted),"origin":origin,"arguments":tool.call.arguments}), &CancellationToken::default())?;
                if response["status"] != "ready" || response["memoryReceipt"].is_null() { unresolved.push(operation.id); continue; }
                let owner = runtime.catalog();
                observe_receipt(&owner,&run_id,&response["memoryReceipt"])?;
                varin_runtime::catalog::result_content::record_external_receipt(&owner, &operation.id,
                    varin_runtime::ExternalReceipt { identity: operation.id.clone(), executor: TOOL.into(), epoch: origin, outcome: Outcome::Succeeded, effect: Effect::Confirmed, result: response }, true).map_err(error)?;
                reconciled.push(operation.id);
            }
            Ok(json!({"reconciled":reconciled,"unresolved":unresolved}))
        })();
        let response = match result { Ok(value) => crate::protocol::response_ok(&request_id, value), Err(failure) => crate::error::response_error(&request_id, &crate::error::KernelError::Operation(failure.to_string())) };
        finished(&request_id); let _ = responses.send(response);
    }).map_err(|failure| crate::error::KernelError::Operation(failure.to_string()))?;
    Ok(())
}

#[cfg(test)]
#[path = "memory_capacity_review.rs"]
mod capacity_review;
