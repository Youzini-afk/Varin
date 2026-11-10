//! Typed follow-up projections. Original instructions, event bodies and receipts stay intact.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use varin_runtime::catalog::model_references::ReferenceKind;
use followups::{FollowupRegistrationSource as RS, FollowupRegistrationTrigger as RT,
    FollowupSource as S, FollowupTrigger as T};
#[derive(Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Target { followup_id: String }
#[derive(Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct OccurrenceTarget { followup_id: String, occurrence_id: String }
fn reference(catalog: &mut Catalog, id: &str, holder: &str) -> Result<String, ExecutionError> {
    crate::resource_references::register(catalog, ReferenceKind::Followup, "catalog-followup", &Target { followup_id:id.into() }, holder)
}
fn operation(catalog: &mut Catalog, id: &str, process: bool, holder: &str) -> Result<String, ExecutionError> {
    let original = catalog.operation(id).map_err(error)?;
    if process {varin_runtime::catalog::managed_process::require_process(&original).map_err(error)?;}
    else if original.host_job.is_none() {return Err(error("Original accepted job is unavailable"));}
    catalog.operation_model_reference(id,holder).map_err(error)
}
fn trigger(catalog: &mut Catalog, mut trigger: T, holder: &str) -> Result<Value, ExecutionError> {
    fn leaf(catalog:&mut Catalog, source:&mut S, holder:&str)->Result<(),ExecutionError> {
        let selected = match source {
            S::ProcessStopped{operation_id}=>Some((operation_id,true)),
            S::JobStopped{operation_id}|S::LogLiteral{operation_id,..}|S::LogEnd{operation_id,..}
            |S::Artifact{operation_id,..}|S::Collection{operation_id}=>Some((operation_id,false)), _=>None,
        };
        if let Some((id,process))=selected {*id=operation(catalog,id,process,holder)?;}
        Ok(())
    }
    let selected = match &mut trigger {
        T::ProcessStopped{operation_id}=>Some((operation_id,true)),
        T::JobStopped{operation_id}|T::LogLiteral{operation_id,..}|T::LogEnd{operation_id,..}
        |T::Artifact{operation_id,..}|T::Collection{operation_id}=>Some((operation_id,false)),
        T::Any{sources}|T::All{sources}=>{for source in sources {leaf(catalog,source,holder)?;} None}, _=>None,
    };
    if let Some((id,process))=selected {*id=operation(catalog,id,process,holder)?;}
    serde_json::to_value(trigger).map_err(error)
}
fn registration(catalog:&mut Catalog, mut trigger:RT, holder:&str)->Result<Value,ExecutionError> {
    fn leaf(catalog:&mut Catalog, source:&mut RS, holder:&str)->Result<(),ExecutionError> {
        let selected = match source {
            RS::ProcessStopped{operation_id}=>Some((operation_id,true)),
            RS::JobStopped{operation_id}|RS::LogLiteral{operation_id,..}|RS::LogEnd{operation_id,..}
            |RS::Artifact{operation_id,..}|RS::Collection{operation_id}=>Some((operation_id,false)), _=>None,
        };
        if let Some((id,process))=selected {*id=operation(catalog,id,process,holder)?;}
        Ok(())
    }
    let selected = match &mut trigger {
        RT::ProcessStopped{operation_id}=>Some((operation_id,true)),
        RT::JobStopped{operation_id}|RT::LogLiteral{operation_id,..}|RT::LogEnd{operation_id,..}
        |RT::Artifact{operation_id,..}|RT::Collection{operation_id}=>Some((operation_id,false)),
        RT::Any{sources}|RT::All{sources}=>{for source in sources {leaf(catalog,source,holder)?;} None}, _=>None,
    };
    if let Some((id,process))=selected {*id=operation(catalog,id,process,holder)?;}
    serde_json::to_value(trigger).map_err(error)
}
fn evidence(catalog:&mut Catalog, original:&followups::TriggerEvidence, holder:&str)->Result<Value,ExecutionError> {
    use followups::TriggerEvidence as E;
    let mut value=serde_json::to_value(original).map_err(error)?;
    match original {
        E::Any{sources}|E::All{sources}=>{
            // These are explicit typed leaf evidence fields, never event bodies.
            for (target,source) in value["sources"].as_array_mut().expect("typed evidence").iter_mut().zip(sources) {
                let leaf: E=serde_json::from_value(serde_json::to_value(&source.evidence).map_err(error)?).map_err(error)?;
                target["evidence"]=evidence(catalog,&leaf,holder)?;
            }
        },
        E::JobStopped{binding,..}|E::LogLiteral{binding,..}|E::LogEnd{binding,..}
        |E::Artifact{binding,..}|E::Collection{binding,..}=>{
            let fields=value.as_object_mut().expect("typed evidence");
            fields.remove("binding"); fields.remove("receipt_identity"); fields.remove("receipt_epoch");
            fields.insert("jobId".into(),json!(operation(catalog,&binding.operation_id,false,holder)?));
        },
        E::ProcessStopped{..}=>value=json!({"kind":"process_stopped"}),
        E::File{..}=>{
            let fields=value.as_object_mut().expect("typed evidence");
            for field in ["receipt_id","proof","position"] {fields.remove(field);}
            if let Some(state)=fields.get_mut("state").and_then(Value::as_object_mut) {state.remove("native");state.remove("objectHash");}
        },
        _=>(),
    }
    Ok(value)
}
fn occurrence(catalog:&mut Catalog, id:&str, value:&followups::FollowupOccurrence, holder:&str)->Result<Value,ExecutionError> {
    let reference=crate::resource_references::register(catalog,ReferenceKind::Observation,"catalog-followup",
        &OccurrenceTarget{followup_id:id.into(),occurrence_id:value.id.clone()},holder)?;
    let followup=reference_followup(catalog,id,holder)?;
    Ok(json!({"ref":reference,"state":value.state,"holdReason":value.hold_reason,"generation":value.generation,
        "acceptedCursor":value.accepted_cursor,"evidence":evidence(catalog,&value.evidence,holder)?,
        "delivered":value.delivery.is_some()||value.external_delivery.is_some(),
        "read":{"tool":followups::TOOL,"arguments":{"action":"occurrence","followupId":followup,"occurrenceId":reference}}}))
}
fn reference_followup(catalog:&mut Catalog,id:&str,holder:&str)->Result<String,ExecutionError>{reference(catalog,id,holder)}
fn summary(catalog:&mut Catalog, followup:&followups::Followup,holder:&str)->Result<Value,ExecutionError> {
    let reference=reference(catalog,&followup.id,holder)?;
    Ok(json!({"followupId":reference,"name":followup.name,"revision":followup.revision,"state":followup.state,
        "repeat":followup.repeat,"trigger":trigger(catalog,followup.trigger.clone(),holder)?,"pendingOccurrences":followup.pending_occurrences,
        "pendingEvents":followup.pending_events,"exhausted":followup.exhausted,"nextDeliveryAtMs":followup.next_delivery_at_ms,
        "read":{"tool":followups::TOOL,"arguments":{"action":"get","followupId":reference}}}))
}
impl FollowupTools {
    pub(super) fn project_references(&self,c:&ToolExecutionContext,call:&ToolCall,completion:&mut ToolCompletion)->Result<(),ExecutionError> {
        let job=matches!(completion,ToolCompletion::JobAccepted{..});
        let content=match completion {
            ToolCompletion::Result {outcome:Outcome::Succeeded,content,..}|ToolCompletion::JobAccepted{content:Some(content),..}=>content,
            _=>return Ok(()),
        };
        let tools=crate::collaboration::original_tools(&self.catalog,c,call)?;
        let schema=tools.iter().find(|schema|schema.name==call.name && schema.version==call.schema_version)
            .ok_or_else(||error("The original follow-up declaration is missing"))?;
        let reference_reads=schema.schema["oneOf"].as_array().is_some_and(|variants|variants.iter().any(|variant|
            variant["properties"]["action"]["const"]=="read" && variant["properties"].get("ref").is_some()));
        // Existing v10 registrations retain their original IDs and after cursor;
        // their frozen action union does not admit the new read/ref continuation.
        if !reference_reads { return Ok(()); }
        let selected=input(&self.catalog,call)?;
        let mut projected=content.data.clone();
        let mut catalog=self.catalog.lock().map_err(error)?;
        match selected {
            FollowupToolInput::Register{..}|FollowupToolInput::Arrange{..}|FollowupToolInput::Route{..}
            |FollowupToolInput::Backlog{..}|FollowupToolInput::Control{..}=>{
                let Some(id)=content.data["followupId"].as_str() else{return Ok(())};
                let selected=reference(&mut catalog,id,&c.run_id)?;
                projected["followupId"]=json!(selected);
                projected["read"]=json!({"tool":followups::TOOL,"arguments":{"action":"get","followupId":selected}});
                if job {projected["operationRef"]=json!(selected);}
                if let Some(original)=content.data.get("trigger") {
                    projected["trigger"]=trigger(&mut catalog,serde_json::from_value(original.clone()).map_err(error)?,&c.run_id)?;
                }
                if let Some(fields)=projected.as_object_mut(){fields.remove("threadId");fields.remove("branchId");}
            },
            FollowupToolInput::List=>{
                let values:Vec<followups::Followup>=serde_json::from_value(content.data.clone()).map_err(error)?;
                projected=Value::Array(values.iter().map(|value|summary(&mut catalog,value,&c.run_id)).collect::<Result<Vec<_>,_>>()?);
            },
            FollowupToolInput::Get{..}=>{
                let value:followups::FollowupView=serde_json::from_value(content.data.clone()).map_err(error)?;
                projected=json!({"followup":summary(&mut catalog,&value.followup,&c.run_id)?,"instruction":value.instruction,
                    "registrationTrigger":value.registration_trigger.map(|trigger|registration(&mut catalog,trigger,&c.run_id)).transpose()?});
            },
            FollowupToolInput::Occurrences{followup_id,..}=>{
                let page:followups::FollowupOccurrencesResult=serde_json::from_value(content.data.clone()).map_err(error)?;
                projected=json!({"occurrences":page.occurrences.iter().map(|item|occurrence(&mut catalog,&followup_id,item,&c.run_id)).collect::<Result<Vec<_>,_>>()?});
                if let Some(after)=page.next_cursor {
                    let next=crate::resource_references::continuation(&mut catalog,"catalog-followup",followups::TOOL,None,
                        json!({"action":"occurrences","followupId":followup_id,"after":after}),&c.run_id)?;
                    projected["nextRead"]=next;
                    projected["nextRead"]["arguments"]["action"]=json!("read");
                }
            },
            FollowupToolInput::Occurrence{followup_id,..}=>{
                let value:followups::FollowupOccurrenceView=serde_json::from_value(content.data.clone()).map_err(error)?;
                projected=json!({"occurrence":occurrence(&mut catalog,&followup_id,&value.occurrence,&c.run_id)?,"facts":value.facts,"events":value.events});
            },
            FollowupToolInput::Jobs=>{
                let jobs:Vec<varin_runtime::catalog::host_jobs::HostJobSource>=serde_json::from_value(content.data.clone()).map_err(error)?;
                projected=Value::Array(jobs.iter().map(|job|Ok(json!({"jobId":operation(&mut catalog,&job.binding.operation_id,false,&c.run_id)?,
                    "domain":job.binding.domain,"phase":job.phase,"cancelRequested":job.cancel_requested,"executorStopped":job.executor_stopped,
                    "observationKinds":job.observation_kinds}))).collect::<Result<Vec<_>,ExecutionError>>()?);
            },
            _=>return Ok(()),
        }
        content.model_data=Some(projected);
        Ok(())
    }
}
