//! File references use their resource owner rather than the recipient's workspace grant.
//! Ordinary path reads keep the original file executor and its physical scheduler.
use crate::host_query::OwnerChannel;
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use varin_runtime::composition::tools::ToolDeclaration;
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};

fn error(message: impl ToString) -> ExecutionError { ExecutionError::new("attachment_read", message.to_string()) }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    #[serde(rename = "ref")] reference: String,
    #[serde(default)] offset: u64,
    length: Option<u64>,
}
pub(crate) fn declaration(existing: Option<ToolDeclaration>, catalog: Arc<Mutex<Catalog>>, bridge: OwnerChannel) -> ToolDeclaration {
    let schema = crate::tools::KernelToolExecutor::selected_schemas(&[crate::tools::ToolKind::FileRead].into_iter().collect()).remove(0);
    ToolDeclaration::new(schema.clone(), Arc::new(Reader { schema, existing: existing.map(|d|d.implementation), catalog, bridge }))
}
struct Reader {
    schema: ToolSchema,
    existing: Option<Arc<dyn ToolExecutor>>,
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
}
struct Call { owner: Arc<Reader>, call: ToolCall, frozen: FrozenToolContext, read: Read, epoch: u64 }
impl Reader {
    fn read(&self, call:&ToolCall, frozen:&FrozenToolContext) -> Result<Option<Read>,ExecutionError> {
        if !call.arguments.get("ref").is_some() { return Ok(None); }
        if call.name!=self.schema.name || call.schema_version!=self.schema.version || !frozen.tools.contains(&self.schema) {
            return Err(error("file reader is not selected in this invocation"));
        }
        let read:Read=serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if read.reference.trim().is_empty() || read.reference.contains('\0') { return Err(error("attachment reference is required")); }
        if frozen.resource_checkpoint_id.as_deref().is_none_or(str::is_empty) { return Err(error("file reader has no frozen resource checkpoint")); }
        Ok(Some(read))
    }
}
impl ToolExecutor for Reader {
    fn bind_call(self:Arc<Self>, call:&ToolCall, frozen:&FrozenToolContext, cancel:&CancellationToken) -> Result<Box<dyn PreparedToolCall>,ExecutionError> {
        if let Some(read)=self.read(call,frozen)? {
            let epoch=self.catalog.lock().map_err(error)?.epoch();
            Ok(Box::new(Call {owner:self,call:call.clone(),frozen:frozen.clone(),read,epoch}))
        } else {
            self.existing.as_ref().ok_or_else(||error("A path requires an admitted file Source; use an attachment reference for received files"))?.clone().bind_call(call,frozen,cancel)
        }
    }
    fn plan(&self,call:&ToolCall,frozen:&FrozenToolContext,cancel:&CancellationToken)->Result<ToolPreparation,ExecutionError> {
        self.prepare(call,frozen,cancel).map(ToolPreparation::Ready)
    }
    fn prepare(&self,call:&ToolCall,frozen:&FrozenToolContext,cancel:&CancellationToken)->Result<ToolContract,ExecutionError> {
        if self.read(call,frozen)?.is_some() { Ok(contract(call)) } else {
            self.existing.as_ref().ok_or_else(||error("A path requires an admitted file Source"))?.prepare(call,frozen,cancel)
        }
    }
    fn authorize(&self,_:&ToolExecutionContext,_:&ToolCall,_:&ToolContract,_:&CancellationToken)->Result<(),ExecutionError> {
        Err(error("file read requires its bound invocation"))
    }
    fn execute(&self,_:&ToolExecutionContext,_:&ToolCall,_:&ToolContract,_:&CancellationToken)->ToolCompletion {
        ToolCompletion::not_dispatched(error("file read requires its bound invocation"))
    }
}
fn contract(call:&ToolCall)->ToolContract {
    ToolContract{name:call.name.clone(),schema_version:call.schema_version.clone(),read_only:true,
        completion:CompletionKind::Result,lifetime:Lifetime::Run,resources:vec![]}
}
impl PreparedToolCall for Call {
    fn plan(&self,_:&CancellationToken)->Result<ToolPreparation,ExecutionError> { Ok(ToolPreparation::Ready(contract(&self.call))) }
    fn prepare(&self,_:&CancellationToken)->Result<ToolContract,ExecutionError> { Ok(contract(&self.call)) }
    fn execution_class(&self,_:&ToolContract)->varin_runtime::execution_capacity::ExecutionClass {varin_runtime::execution_capacity::ExecutionClass::Unmetered}
    fn watch_admission(&self,_:&ToolExecutionContext,_:&ToolContract,_:&CancellationToken)->Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>,ExecutionError> {Ok(None)}
    fn supports_policy_read(&self,contract:&ToolContract)->bool {contract.read_only && contract.completion==CompletionKind::Result}
    fn authorize(&self,context:&ToolExecutionContext,_:&ToolContract,cancel:&CancellationToken)->Result<(),ExecutionError> {
        if cancel.is_cancelled() { return Err(ExecutionError::new("attachment_read_cancelled","attachment read cancelled")); }
        if context.run_id!=self.frozen.run_id || context.origin!=self.frozen.origin || context.operation_id!=context.origin.operation_id(&self.call.call_id) {
            return Err(error("attachment read owner changed"));
        }
        self.owner.catalog.lock().map_err(error)?.validate_resource_snapshot_owner(&context.run_id,self.epoch,&context.origin).map_err(|failure|match failure {varin_runtime::RuntimeError::Conflict(_)=>ExecutionError::new("attachment_read_cancelled","Attachment read owner closed"),other=>error(other)})
    }
    fn execute(&self,context:&ToolExecutionContext,contract:&ToolContract,cancel:&CancellationToken)->ToolExecutionReceipt {
        let result=(|| {
            self.authorize(context,contract,cancel)?;
            let value=self.owner.bridge.query(json!({"runId":context.run_id,"origin":context.origin,"callId":self.call.call_id,
                "resourceCheckpointId":self.frozen.resource_checkpoint_id,
                "request":{"kind":"attachment","ref":self.read.reference,"view":"content","offset":self.read.offset,"limit":self.read.length.unwrap_or(65536)}}),cancel)?;
            self.authorize(context,contract,cancel)?;
            if value["status"]!="ready" {
                return Err(error(value["reason"].as_str().or(value["message"].as_str()).unwrap_or("Attachment owner could not read the selected version"))
                    .with_details(value));
            }
            Ok(value)
        })();
        let completion=match result {
            Ok(value)=>ToolCompletion::Result{outcome:Outcome::Succeeded,effect:Effect::None,content:value.into()},
            Err(failure)=>ToolCompletion::Result{outcome:if cancel.is_cancelled() || failure.code=="attachment_read_cancelled"{Outcome::Cancelled}else{Outcome::Failed},effect:Effect::None,content:json!({"error":failure}).into()},
        };
        ToolExecutionReceipt::local(completion,contract)
    }
}
