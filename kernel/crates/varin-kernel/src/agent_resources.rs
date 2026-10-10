//! Resource selection stays in the Host. This builtin carries the original request checkpoint
//! through the ordinary tool directory. New dependencies use the Host's original resource view authorization.
use crate::host_query::OwnerChannel;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::resources::ResourceRequest;
use varin_runtime::execution::*;
use varin_runtime::execution_capacity::{AdmissionControlGuard, ExecutionClass};
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};

pub(crate) fn execute_rpc(
    catalog: Arc<Mutex<Catalog>>,
    method: &str,
    params: Value,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Value, crate::error::KernelError> {
    use crate::agent_runtime::{domain, personalization_basis};
    use crate::error::KernelError;
    let check = || {
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    };
    let read_error = |error| match error {
        varin_runtime::RuntimeError::Conflict(message) => KernelError::Authorization(message),
        other => domain(other),
    };
    check()?;
    if method == "runtime.resources.snapshot" {
        let p: crate::protocol_generated::ResourceSnapshotParams = serde_json::from_value(params)?;
        let read = {
            let owner = catalog
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            owner
                .validate_resource_snapshot_owner(&p.run_id, owner.epoch(), &p.origin)
                .map_err(|_| KernelError::Cancelled)?;
            owner
                .capture_resource_snapshot(
                    &p.run_id,
                    &p.origin,
                    &p.call_id,
                    &p.resource_checkpoint_id,
                    p.activation_id.as_deref(),
                )
                .map_err(read_error)?
        };
        let epoch = read.epoch;
        let resources = read.load().map_err(read_error)?;
        check()?;
        catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .validate_resource_snapshot_owner(&p.run_id, epoch, &p.origin)
            .map_err(|_| KernelError::Cancelled)?;
        Ok(serde_json::to_value(resources)?)
    } else {
        let p: crate::protocol_generated::ResourceRefreshParams = serde_json::from_value(params)?;
        let basis = personalization_basis(p.context.personalization.ok_or_else(|| {
            KernelError::Protocol("resource refresh requires personalization".into())
        })?)?;
        let resources = p
            .context
            .resources
            .ok_or_else(|| KernelError::Protocol("resource refresh requires a snapshot".into()))?;
        let prepared = catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .prepare_resource_refresh(
                &p.branch_id,
                p.expected_revision.try_into().map_err(|_| {
                    KernelError::Protocol("context revision must be nonnegative".into())
                })?,
                p.context.effective_system_prompt,
                p.context.instruction_sources,
                p.context.memory_checkpoint.0,
                basis,
                resources,
            )
            .map_err(domain)?;
        let prepared = prepared.load().map_err(domain)?;
        check()?;
        let checkpoint = catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .publish_resource_refresh(prepared)
            .map_err(domain)?;
        Ok(serde_json::to_value(checkpoint)?)
    }
}

fn failed(value: impl ToString) -> ExecutionError {
    ExecutionError::new("agent_resources", value.to_string())
}
pub(crate) fn schema() -> ToolSchema {
    ToolSchema { name:"resource_read".into(),version:"2".into(),
        description:"Read a selected skill, a file within its bundle, or the instructions applying to a target in the admitted source. Pass a retained explicit skill input's activationId and matching resourceId to select its original version. Without activationId, read from this invocation's current frozen catalog. Returned text retains its original source and scope.".into(),
        output_schema:None,metadata:None,
        schema:json!({"type":"object","oneOf":[
            {"type":"object","properties":{"kind":{"const":"skill"},"resourceId":{"type":"string","minLength":1},"activationId":{"type":"string","minLength":1,"description":"Use the activationId from a retained explicit skill input to read that original resource version."}},"required":["kind","resourceId"],"additionalProperties":false},
            {"type":"object","properties":{"kind":{"const":"skill-resource"},"resourceId":{"type":"string","minLength":1},"activationId":{"type":"string","minLength":1,"description":"Use the activationId from a retained explicit skill input to read that original resource version."},"relativePath":{"type":"string"}},"required":["kind","resourceId","relativePath"],"additionalProperties":false},
            {"type":"object","properties":{"kind":{"const":"instruction-scope"},"targetPath":{"type":"string"},"targetType":{"type":"string","enum":["file","directory"]}},"required":["kind","targetPath"],"additionalProperties":false}
        ]}),
    }
}
fn contract() -> ToolContract {
    ToolContract {
        name: "resource_read".into(),
        schema_version: "2".into(),
        read_only: true,
        completion: CompletionKind::Result,
        lifetime: Lifetime::Run,
        resources: vec![],
    }
}
fn request(
    call: &ToolCall,
    context: &FrozenToolContext,
) -> Result<ResourceRequest, ExecutionError> {
    if call.name != "resource_read"
        || call.schema_version != "2"
        || !context.tools.contains(&schema())
    {
        return Err(failed("resource schema is not bound"));
    }
    let request: ResourceRequest =
        serde_json::from_value(call.arguments.clone()).map_err(failed)?;
    if matches!(&request,ResourceRequest::Skill{resource_id,..}|ResourceRequest::SkillResource{resource_id,..} if resource_id.is_empty())
    {
        return Err(failed("resource ID is required"));
    }
    checkpoint(&request, context)?;
    Ok(request)
}
fn checkpoint<'a>(request: &ResourceRequest, context: &'a FrozenToolContext) -> Result<&'a str, ExecutionError> {
    if let Some(activation_id) = request.activation_id() {
        let binding = context.resource_activations.iter().find(|binding| binding.activation_id == activation_id)
            .ok_or_else(|| failed("resource activation is not retained by this invocation"))?;
        if activation_id.is_empty() || Some(binding.resource_id.as_str()) != request.resource_id()
            || context.resource_activations.iter().filter(|binding| binding.activation_id == activation_id).count() != 1 {
            return Err(failed("resource activation differs from the selected resource"));
        }
        return Ok(&binding.resource_checkpoint_id);
    }
    context.resource_checkpoint_id.as_deref().filter(|id| !id.is_empty())
        .ok_or_else(|| failed("resource checkpoint is not bound"))
}
pub(crate) fn declaration(
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(),
        Arc::new(ResourceTools { catalog, bridge }),
    )
}
struct ResourceTools {
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
}
struct ResourceCall {
    owner: Arc<ResourceTools>,
    frozen: FrozenToolContext,
    call_id: String,
    request: ResourceRequest,
    epoch: u64,
}
impl ResourceTools {
    fn authorize_owner(
        &self,
        context: &ToolExecutionContext,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(ExecutionError::new(
                "resource_cancelled",
                "resource read cancelled",
            ));
        }
        self.catalog
            .lock()
            .map_err(failed)?
            .validate_resource_snapshot_owner(&context.run_id, epoch, &context.origin)
            .map_err(|error| match error {
                varin_runtime::RuntimeError::Conflict(_) => {
                    ExecutionError::new("resource_cancelled", "resource read owner closed")
                }
                other => failed(other),
            })?;
        Ok(())
    }
}
impl ToolExecutor for ResourceTools {
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        context: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        let request = request(call, context)?;
        let epoch = self.catalog.lock().map_err(failed)?.epoch();
        Ok(Box::new(ResourceCall {
            owner: self,
            frozen: context.clone(),
            call_id: call.call_id.clone(),
            request,
            epoch,
        }))
    }
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
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        request(call, context)?;
        Ok(contract())
    }
    fn supports_policy_read(
        &self,
        context: &FrozenToolContext,
        call: &ToolCall,
        contract: &ToolContract,
    ) -> bool {
        contract.read_only
            && contract.completion == CompletionKind::Result
            && request(call, context).is_ok()
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Err(failed("resource read requires its selected invocation"))
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        ToolCompletion::NotDispatched {
            reason: "resource read requires its selected invocation".into(),
        }
    }
}
impl PreparedToolCall for ResourceCall {
    fn plan(&self, _: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        Ok(ToolPreparation::Ready(contract()))
    }
    fn prepare(&self, _: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        Ok(contract())
    }
    fn execution_class(&self, _: &ToolContract) -> ExecutionClass {
        ExecutionClass::Unmetered
    }
    fn watch_admission(
        &self,
        _: &ToolExecutionContext,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<Option<AdmissionControlGuard>, ExecutionError> {
        Ok(None)
    }
    fn supports_policy_read(&self, contract: &ToolContract) -> bool {
        contract.read_only && contract.completion == CompletionKind::Result
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if context.run_id != self.frozen.run_id
            || context.origin != self.frozen.origin
            || context.operation_id != context.origin.operation_id(&self.call_id)
        {
            return Err(failed("resource invocation owner changed"));
        }
        self.owner.authorize_owner(context, self.epoch, cancel)
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        let result = (|| -> Result<Value, ExecutionError> {
            self.authorize(context, contract, cancel)?;
            let result = self.owner.bridge.query(
                json!({"runId":context.run_id,"origin":context.origin,"callId":self.call_id,
                "resourceCheckpointId":checkpoint(&self.request, &self.frozen)?,"request":self.request}),
                cancel,
            )?;
            // Checkpoint content remains bound to this live call. New source reads are
            // separately authorized by the original resource view owner in the Host.
            self.authorize(context, contract, cancel)?;
            if !matches!(
                result["status"].as_str(),
                Some(
                    "ready"
                        | "missing"
                        | "invalid"
                        | "denied"
                        | "unavailable"
                        | "stale"
                        | "cancelled"
                )
            ) {
                return Err(failed("resource owner returned an invalid status"));
            }
            Ok(result)
        })();
        let completion = match result {
            Ok(content) => ToolCompletion::Result {
                outcome: if content["status"] == "ready" {
                    Outcome::Succeeded
                } else if content["status"] == "cancelled" {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                effect: Effect::None,
                content,
            },
            Err(error) => ToolCompletion::Result {
                outcome: if cancel.is_cancelled() || error.code == "resource_cancelled" {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
                effect: Effect::None,
                content: json!({"status":if cancel.is_cancelled() || error.code == "resource_cancelled" {"cancelled"}else{"unavailable"},"reason":"The selected resource read could not complete"}),
            },
        };
        ToolExecutionReceipt::local(completion, contract)
    }
}
