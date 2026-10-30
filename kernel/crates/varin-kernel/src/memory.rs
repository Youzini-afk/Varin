//! Ordinary memory tools and explicit safe-boundary context preparation.
use super::host_query::OwnerChannel;
use serde::Deserialize;
use serde_json::{Value, json};
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
    if matches!(args.action.as_str(), "save" | "delete") {
        if !mutations {
            return Err(error("Memory writes are unavailable in this execution"));
        }
        if args.revision.is_none() && (args.action == "delete" || args.id.is_some()) {
            return Err(error("Updating or deleting a note requires the revision returned by memory read/search"));
        }
    }
    if !matches!(args.action.as_str(), "read" | "search" | "save" | "delete")
        || args
            .scope
            .as_deref()
            .is_some_and(|scope| !matches!(scope, "global" | "project" | "currentThread"))
        || args.id == Some(0)
        || (args.action == "save" && args.content.as_deref().is_none_or(|s| s.trim().is_empty()))
        || (args.action == "delete" && args.id.is_none())
    {
        return Err(error("Invalid memory arguments: save requires nonempty content; delete requires id; scope is global, project or currentThread"));
    }
    Ok(args)
}
pub(crate) fn builtin_schema(bot: bool) -> crate::run_tools::BuiltinSchema {
    use varin_runtime::catalog::dispatch::{
        ChildPresetDefault::Worker, ChildSourceRequirement::None,
    };
    crate::run_tools::BuiltinSchema::child(
        if bot { bot_schema(true) } else { schema(true) },
        None,
        &[Worker],
    )
}
pub(crate) fn schema(mutations: bool) -> ToolSchema {
    ToolSchema { requirements: None, description: "Read and maintain persistent notes. save with content creates a note; updating an existing id or deleting requires the revision returned by read/search. Scopes follow the conversation identity. Saved notes commit immediately; system memory snapshots update at successful compaction.".into(), output_schema: None, metadata: None,
        name: TOOL.into(),
        version: if mutations { "1" } else { "1-read" }.into(),
        schema: json!({"type":"object",
        "properties":{"action":{"type":"string","enum":if mutations {vec!["read","search","save","delete"]} else {vec!["read","search"]}},"scope":{"type":"string","enum":["global","project","currentThread"]},"id":{"type":"integer","minimum":1},"content":{"type":"string"},"query":{"type":"string"},"revision":{"type":"integer","minimum":0}},"required":["action"],"additionalProperties":false}),
    }
}
pub(crate) fn bot_schema(mutations: bool) -> ToolSchema {
    ToolSchema { requirements: None, description: "Read, recall and maintain this Bot's durable Knowledge memory. Omitted/bot scope means this Bot; user scope means shared user memory; session scope means this original Thread. Get returns exact values and a revision for updates or derived accounts. Remember/correct can cite several original passages through sources or same-scope memory revisions through derivedFrom. Archive removes an understanding from current recall while preserving its history; forget also excludes its supporting source passages from future model context. Recall includes associated work and shared memory. The original Knowledge owner commits writes; repeating an Operation returns its original receipt.".into(), output_schema: None, metadata: None,
        name: TOOL.into(), version: if mutations { "bot-2" } else { "bot-2-read" }.into(),
        schema: json!({"type":"object","properties":{
            "action":{"type":"string","enum":if mutations { vec!["get","search","recall","remember","correct","forget","archive","rewrite","organize","maintenance_status","maintenance_cancel"] } else { vec!["get","search","recall","maintenance_status"] }},
            "ids":{"type":"array","items":{"type":"integer","minimum":1},"description":"Optional existing memory scope for background organization; omit for a general review."},
            "key":{"type":"string","description":"Original maintenance key returned by organize."},
            "reason":{"type":"string","description":"What this organization should help with; no prescribed plan required."},
            "inputs":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer","minimum":1},"revision":{"type":"string"}},"required":["id","revision"],"additionalProperties":false},"description":"For rewrite: exact same-scope memory revisions read with get."},
            "retire":{"type":"array","items":{"type":"integer","minimum":1}},
            "outputs":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string"},"trigger":{"type":"string"},"sources":{"type":"array","items":{"type":"integer","minimum":1}},"overview":{"type":"boolean"}},"required":["content","sources"],"additionalProperties":false},"description":"For rewrite: replacement or overview accounts. Sources refer to inputs; retain detail by leaving it out of retire. Empty outputs can archive retired inputs."},
            "scope":{"type":"string","enum":["bot","user","session"]},"id":{"type":"integer","minimum":1},
            "content":{"type":"string"},"trigger":{"type":"string"},"nature":{"type":"string","enum":["experience","decision","preference","judgment","instruction"]},
            "sourceText":{"type":"string"},"sourceItemId":{"type":"string"},"includeSource":{"type":"boolean"},
            "sources":{"type":"array","items":{"type":"object","properties":{"itemId":{"type":"string"},"quote":{"type":"string"}},"required":["itemId","quote"],"additionalProperties":false},"description":"Original supporting passages; several can support one connected account."},
            "derivedFrom":{"type":"array","items":{"type":"object","properties":{"id":{"type":"integer","minimum":1},"revision":{"type":"string"}},"required":["id","revision"],"additionalProperties":false},"description":"Same-scope memories read with get. The returned revision binds this derived account to its actual sources."},
            "query":{"type":"string"},"k":{"type":"integer","minimum":1},
            "expected":{"type":"object","properties":{"content":{"type":"string"},"trigger":{"type":"string"},"status":{"type":"string","enum":["suggested","accepted","dismissed"]},"invalidAt":{"type":["number","null"]}},"required":["content","trigger","status","invalidAt"],"additionalProperties":false}
        },"required":["action"],"additionalProperties":false}) }
}
fn bot_action(call: &ToolCall, mutations: bool) -> Result<bool, ExecutionError> {
    let value = call
        .arguments
        .as_object()
        .ok_or_else(|| error("Bot memory arguments must be an object"))?;
    let action = value
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| error("Bot memory action missing"))?;
    let read = matches!(action, "get" | "search" | "recall" | "maintenance_status");
    if !read && (!mutations || !matches!(action, "remember" | "correct" | "forget" | "archive" | "rewrite" | "organize" | "maintenance_cancel")) {
        return Err(error("invalid or ungranted Bot memory action"));
    }
    if value.keys().any(|key| {
        ![
            "action",
            "scope",
            "id",
            "content",
            "trigger",
            "nature",
            "sourceText",
            "sourceItemId",
            "sources",
            "derivedFrom",
            "includeSource",
            "query",
            "k",
            "expected",
            "ids", "key", "reason", "inputs", "retire", "outputs",
        ]
        .contains(&key.as_str())
    }) || value
        .get("scope")
        .is_some_and(|scope| !matches!(scope.as_str(), Some("bot" | "user" | "session")))
        || (matches!(action, "get" | "correct" | "forget" | "archive")
            && value
                .get("id")
                .and_then(Value::as_u64)
                .is_none_or(|id| id == 0))
        || (matches!(action, "remember" | "correct")
            && value
                .get("content")
                .and_then(Value::as_str)
                .is_none_or(|text| text.trim().is_empty()))
        || (matches!(action, "correct" | "forget" | "archive")
            && !value.get("expected").is_some_and(Value::is_object))
    {
        return Err(error("invalid Bot memory arguments"));
    }
    Ok(read)
}
fn scope(
    catalog: &Arc<Mutex<Catalog>>,
    run_id: &str,
    basis: &ContextScope,
) -> Result<Value, ExecutionError> {
    let catalog = catalog.lock().map_err(error)?;
    let run = catalog.run(run_id).map_err(error)?;
    let bot_id = catalog.bot_for_thread(&run.thread_id).map_err(error)?;
    if (basis.mode == "bot") != bot_id.is_some() {
        return Err(error("memory mode differs from the actual Bot binding"));
    }
    Ok(
        json!({"mode":basis.mode,"threadId":basis.thread_id,"projectId":basis.project_id,"threadRole":basis.thread_role,"botId":bot_id,"branchId":run.branch_id}),
    )
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
        .is_some_and(|basis| basis.thread_id != run.thread_id)
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
    bot: bool,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        if bot {
            bot_schema(mutations)
        } else {
            schema(mutations)
        },
        Arc::new(MemoryTools {
            catalog,
            bridge,
            mutations,
            bot,
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
    bot: bool,
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
            && if self.bot {
                bot_action(call, self.mutations).unwrap_or(false)
            } else {
                args(call, self.mutations)
                    .is_ok_and(|a| matches!(a.action.as_str(), "read" | "search"))
            }
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let schema = if self.bot {
            bot_schema(self.mutations)
        } else {
            schema(self.mutations)
        };
        if call.schema_version != schema.version || !request.tools.contains(&schema) {
            return Err(error("memory schema is not bound"));
        }
        let read_only = if self.bot {
            bot_action(call, self.mutations)?
        } else {
            matches!(
                args(call, self.mutations)?.action.as_str(),
                "read" | "search"
            )
        };
        Ok(ToolContract {
            name: TOOL.into(),
            schema_version: schema.version,
            read_only,
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
        if self.bot {
            bot_action(call, self.mutations)?;
        } else {
            args(call, self.mutations)?;
        }
        let basis = basis(&self.catalog, &context.run_id)?
            .ok_or_else(|| error("memory scope has not been admitted"))?;
        let actual = scope(&self.catalog, &context.run_id, &basis)?;
        if actual["botId"].is_string() != self.bot
            || (basis.thread_role == "read-only" && !contract.read_only)
        {
            return Err(error(
                "memory declaration differs from the actual identity or role",
            ));
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
            let value = self.bridge.query(json!({"action":"tool","runId":context.run_id,"scope":scope(&self.catalog, &context.run_id, &basis)?,"origin":origin,"arguments":call.arguments}), cancel)?;
            if !self.bot && value["status"] == "ready" && !value["memoryReceipt"].is_null() {
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
                content: value.into(),
            },
            Ok(value) if value["status"] == "rejected" => ToolCompletion::NotDispatched {
                reason: value["message"]
                    .as_str()
                    .unwrap_or("memory action rejected")
                    .into(),
                error: None,
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
                content: value.into(),
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
                content: json!({"error":failure}).into(),
            },
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    resources: Option<varin_runtime::catalog::resources::ContextResources>,
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
            let previous_state = self
                .catalog
                .lock()
                .map_err(error)?
                .capture_memory_state(&checkpoint.proposal.branch_id)
                .map_err(error)?;
            let previous_state = previous_state
                .map(|read| read.load())
                .transpose()
                .map_err(error)?;
            let reply = self.bridge.query(json!({"action":"synchronize","runId":run_id,"scope":scope(&self.catalog,run_id,&admitted)?,"checkpoint":checkpoint,"previousState":previous_state}), cancel)?;
            if reply["status"] != "ready" {
                return Err(error(
                    reply["message"]
                        .as_str()
                        .unwrap_or("context preparation failed"),
                ));
            }
            let prepared: Prepared =
                serde_json::from_value(reply["context"].clone()).map_err(error)?;
            if prepared.resources != checkpoint.resources {
                return Err(error(
                    "ordinary personalization synchronization changed resources",
                ));
            }
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
                let response = bridge.query(json!({"action":"receipt","runId":run_id,"scope":scope(&owner,&run_id,&admitted)?,"origin":origin,"arguments":tool.call.arguments}), &CancellationToken::default())?;
                if response["status"] == "ready" && response["memoryReceipt"].is_null() && response["executionReceipt"]["executorStopped"] == true {
                    let effect: Effect = serde_json::from_value(response["executionReceipt"]["effect"].clone()).map_err(error)?;
                    let outcome: Outcome = serde_json::from_value(response["executionReceipt"]["outcome"].clone()).map_err(error)?;
                    if !matches!(effect, Effect::None | Effect::Unknown) { return Err(error("invalid settled memory owner evidence")); }
                    varin_runtime::catalog::result_content::record_external_receipt(&owner, &operation.id,
                        varin_runtime::ExternalReceipt { identity: operation.id.clone(), executor: TOOL.into(), epoch: origin, outcome, effect, result: response.into() }, true).map_err(error)?;
                    if effect == Effect::Unknown { unresolved.push(operation.id); } else { reconciled.push(operation.id); }
                    continue;
                }
                if response["status"] != "ready" || response["memoryReceipt"].is_null() { unresolved.push(operation.id); continue; }
                let owner = runtime.catalog();
                if admitted.mode != "bot" { observe_receipt(&owner,&run_id,&response["memoryReceipt"])?; }
                varin_runtime::catalog::result_content::record_external_receipt(&owner, &operation.id,
                    varin_runtime::ExternalReceipt { identity: operation.id.clone(), executor: TOOL.into(), epoch: origin, outcome: Outcome::Succeeded, effect: Effect::Confirmed, result: response.into() }, true).map_err(error)?;
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

#[cfg(test)]
mod mutation_arguments {
    use super::*;
    #[test]
    fn new_notes_need_no_revision_but_existing_notes_and_read_only_runs_keep_their_guards() {
        let mut call=ToolCall{call_id:"save".into(),name:TOOL.into(),schema_version:"1".into(),
            arguments:json!({"action":"save","scope":"global","content":"New note"})};
        assert!(args(&call,true).is_ok());
        assert!(args(&call,false).is_err());
        call.arguments["scope"]=json!("currentThread");
        assert!(args(&call,true).is_ok());
        call.arguments["id"]=json!(1);
        assert!(args(&call,true).err().unwrap().message.contains("revision"));
        call.arguments["revision"]=json!(0);
        assert!(args(&call,true).is_ok());
    }
}
