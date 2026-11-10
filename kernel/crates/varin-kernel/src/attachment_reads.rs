//! File references use their resource owner rather than the recipient's workspace grant.
//! Ordinary path reads keep the original file executor and its physical scheduler.
use crate::host_query::OwnerChannel;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};
use varin_runtime::composition::tools::ToolDeclaration;
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, Lifetime, Outcome};

fn error(message: impl ToString) -> ExecutionError { ExecutionError::new("attachment_read", message.to_string()) }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
        let mut arguments=call.arguments.clone();
        if let Some(reference)=arguments["ref"].as_str().filter(|reference|reference.starts_with("read:")) {
            if arguments.as_object().is_none_or(|fields|fields.len()!=1) {return Err(error("Use nextRead without changing its fixed selection"));}
            let catalog=self.catalog.lock().map_err(error)?;
            let selected=catalog.resolve_model_reference(varin_runtime::catalog::model_references::ReferenceKind::Read,reference).map_err(error)?;
            let target:crate::resource_references::ReadTarget=serde_json::from_value(selected.target).map_err(error)?;
            if selected.owner!="attachment" {return Ok(None);}
            if target.tool!=call.name || target.source.is_some() {return Err(error("Attachment continuation changed its original reader"));}
            arguments=target.arguments;
        }
        if let Some(reference) = arguments["ref"].as_str() {
            if reference.starts_with("file:") {
                let catalog = self.catalog.lock().map_err(error)?;
                let selected: crate::resource_references::FileTarget = crate::resource_references::resolve(&catalog, varin_runtime::catalog::model_references::ReferenceKind::File, reference)?;
                if matches!(selected, crate::resource_references::FileTarget::Observation {..}) { return Ok(None); }
            }
        }
        if call.name!=self.schema.name || !matches!(call.schema_version.as_str(), "1" | "2") ||
            !frozen.tools.iter().any(|schema| schema==&self.schema || (call.schema_version=="1" && schema.name==call.name && schema.version=="1")) {
            return Err(error("file reader is not selected in this invocation"));
        }
        let mut read:Read=serde_json::from_value(arguments).map_err(error)?;
        if read.reference.starts_with("file:") {
            let catalog = self.catalog.lock().map_err(error)?;
            let selected: crate::resource_references::FileTarget = crate::resource_references::resolve(&catalog, varin_runtime::catalog::model_references::ReferenceKind::File, &read.reference)?;
            if let crate::resource_references::FileTarget::Attachment {reference} = selected { read.reference = reference; }
        }
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
            let mut catalog = self.owner.catalog.lock().map_err(error)?;
            project_read(&mut catalog, &context.run_id, &self.read, value)
        })();
        let completion=match result {
            Ok(content)=>ToolCompletion::Result{outcome:Outcome::Succeeded,effect:Effect::None,content},
            Err(failure)=>ToolCompletion::Result{outcome:if cancel.is_cancelled() || failure.code=="attachment_read_cancelled"{Outcome::Cancelled}else{Outcome::Failed},effect:Effect::None,content:json!({"error":failure}).into()},
        };
        ToolExecutionReceipt::local(completion,contract)
    }
}

/// Project only the original attachment owner's declared response. Full raw receipts
/// stay available; continuations bind this immutable file and exact byte offset.
fn project_read(catalog:&mut Catalog, holder:&str, read:&Read, value:serde_json::Value)->Result<varin_runtime::output::OutputBody,ExecutionError> {
    let mut attachment:varin_runtime::catalog::attachments::Attachment=serde_json::from_value(value["attachment"].clone()).map_err(error)?;
    if attachment.reference!=read.reference {return Err(error("Attachment owner changed the selected immutable file"));}
    attachment.validate().map_err(error)?;
    let content=&value["content"];
    let next=content["nextOffset"].as_u64().ok_or_else(||error("Attachment owner omitted the original page boundary"))?;
    if content["offset"].as_u64()!=Some(read.offset) || next<read.offset || next>attachment.byte_length
        || content["byteLength"].as_u64()!=Some(attachment.byte_length)
        || content["eof"].as_bool()!=Some(next==attachment.byte_length)
        || next==read.offset && next<attachment.byte_length {
        return Err(error("Attachment owner changed its fixed page boundary"));
    }
    catalog.project_attachments(std::slice::from_mut(&mut attachment),holder).map_err(error)?;
    let reference=attachment.model_ref.as_ref().expect("owner projection").clone();
    let mut projected=value.clone();
    projected["attachment"]=serde_json::to_value(attachment.model_descriptor()).map_err(error)?;
    projected["ref"]=json!(reference);
    projected["content"].as_object_mut().expect("validated content").remove("nextOffset");
    if next<attachment.byte_length {
        projected["nextRead"]=crate::resource_references::continuation(catalog,"attachment","file_read",None,
            json!({"ref":reference,"offset":next,"length":read.length}),holder)?;
    }
    let mut output:varin_runtime::output::OutputBody=value.into();output.model_data=Some(projected);Ok(output)
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    #[test]
    fn attachment_page_ref_replays_exact_owner_selection_and_rejects_changed_receipts() {
        let root=std::env::temp_dir().join(format!("attachment-continuation-{}",uuid::Uuid::new_v4()));
        let mut catalog=Catalog::open(&root).unwrap();
        let read=Read{reference:"attachment:immutable-version".into(),offset:0,length:Some(3)};
        let page=json!({"status":"ready","attachment":{"ref":read.reference,"filename":"file.txt","mimeType":"text/plain","byteLength":6},
            "content":{"text":"abc","offset":0,"nextOffset":3,"byteLength":6,"eof":false}});
        let output=project_read(&mut catalog,"retained-run",&read,page.clone()).unwrap();
        let again=project_read(&mut catalog,"retained-run",&read,page.clone()).unwrap();assert_eq!(output,again);
        assert_eq!(output.data,page);assert!(!output.model_data().to_string().contains("attachment:immutable-version"));
        let next=output.model_data()["nextRead"]["arguments"].clone();
        let (tx,_rx)=std::sync::mpsc::sync_channel(1);let bridge=OwnerChannel::new("resource",tx);
        let declaration=declaration(None,Arc::new(Mutex::new(catalog)),bridge);
        let schema=declaration.schema.clone();
        // Exercise the same hybrid dispatch router used with no workspace Source.
        let mut call=ToolCall{call_id:"next".into(),name:"file_read".into(),schema_version:schema.version.clone(),arguments:next};
        let frozen=FrozenToolContext{tool_output_visible_bytes:None,execution_environment:None,direct_tools:None,child_dispatch:None,
            resource_activations:vec![],resource_checkpoint_id:Some("original-resource-checkpoint".into()),run_id:"retained-run".into(),
            origin:ToolOrigin::ModelStep{request_id:"original-request".into()},tools:Arc::new(vec![schema]),tool_schema_generation:1,source:None};
        let cancel=CancellationToken::default();
        for _ in 0..2 {assert!(declaration.implementation.clone().bind_call(&call,&frozen,&cancel).is_ok());}
        call.arguments["offset"]=json!(4);assert!(declaration.implementation.clone().bind_call(&call,&frozen,&cancel).is_err());
        drop(declaration);
        let mut catalog=Catalog::open(&root).unwrap();
        let mut changed=page.clone();changed["attachment"]["ref"]=json!("attachment:other");assert!(project_read(&mut catalog,"retained-run",&read,changed).is_err());
        let mut changed=page;changed["content"]["nextOffset"]=json!(7);assert!(project_read(&mut catalog,"retained-run",&read,changed).is_err());
        drop(catalog);std::fs::remove_dir_all(root).unwrap();
    }
}
