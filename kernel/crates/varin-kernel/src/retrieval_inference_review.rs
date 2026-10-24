//! Original retrieval admission, visibility and recovered final receipt use the real Catalog.
use super::*;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod dispatch;
use varin_runtime::{Effect, Outcome};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;
use varin_runtime::execution::*;

struct Investigate { pause:Option<std::sync::mpsc::SyncSender<()>> }
impl ModelProvider for Investigate {
    fn serialize(&self,view:&RequestView,_reuse:Option<&mut RequestCompileReuse>)->Result<RequestBody,ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(&self,request:&RequestSnapshot,cancel:&CancellationToken,
        emit:&mut dyn FnMut(ProviderEvent)->Result<(),ExecutionError>)->Result<FinishReason,ModelFailure> {
        let evidence=request.view.history.iter().find_map(|item|match &item.content {
            Content::ToolResult {result} if result.call_id=="read-evidence"=>Some(result),_=>None,
        });
        let content=if let Some(result)=evidence {
            assert!(serde_json::to_string(result).unwrap().contains("native retrieval evidence"));
            Content::Text{text:"body.txt:1 contains native retrieval evidence.".into()}
        } else {Content::ToolCall {call:ToolCall{call_id:"read-evidence".into(),name:"file_read".into(),schema_version:"1".into(),arguments:json!({"path":"body.txt"})}}};
        if self.pause.is_some() && evidence.is_some() {
            let Content::Text{text}=content else {unreachable!()};
            emit(ProviderEvent::TextDelta{item_id:"reply".into(),text})?;
        } else {emit(ProviderEvent::ItemCompleted{item:ProviderItem{id:"reply".into(),content,opaque:None}})?;}
        emit(ProviderEvent::Usage{receipt:UsageReceipt{measurement:UsageMeasurement::Actual,input_tokens:Some(100),output_tokens:Some(12),..Default::default()}})?;
        if let Some(pause)=self.pause.as_ref().filter(|_|evidence.is_some()) {
            let (send,receive)=std::sync::mpsc::sync_channel(1);let _watch=cancel.wake_on_cancel(send);
            pause.send(()).unwrap();if !cancel.is_cancelled(){receive.recv().unwrap();}
            return Err(ExecutionError::new("cancelled","Original model request stopped").into());
        }
        Ok(if evidence.is_some(){FinishReason::Stop}else{FinishReason::ToolCalls})
    }
}

#[test]
fn internal_retrieval_runs_ordinary_native_tools_and_accounts_answer_usage_once() {
    run_investigation(false);
}
#[test]
fn stopping_background_retrieval_retains_actual_partial_output() {
    run_investigation(true);
}
fn run_investigation(stop:bool) {
    let read=crate::tools::KernelToolExecutor::selected_schemas(&[crate::tools::ToolKind::FileRead].into_iter().collect()).remove(0);
    let mut f=dispatch::Fixture::new_internal_retrieval_with_read(read);
    let child=f.accept();
    let status=f.db.capture_retrieval_status(&child.parent_run_id,&child.operation_id).unwrap().load().unwrap();
    assert_eq!(status["state"],"preparing");
    assert!(status["latestAssistantMessage"].is_null());
    assert!(f.db.operation(&child.operation_id).unwrap().call_completion.is_some());
    let mut source=child.source.pin().unwrap().source.clone();
    source.branch_id=Some(format!("child-source:{}",child.operation_id));source.revision=Some(0);
    let proposal=varin_runtime::catalog::context::ContextProposal{key:"retrieval-context".into(),branch_id:child.child_branch_id.clone(),
        through_id:None,expected_revision:0,summary:String::new(),effective_system_prompt:"Investigate using ordinary tools".into(),
        instruction_sources:vec!["fixture:retrieval".into()],memory_checkpoint:None};
    let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"fixture:retrieval",
        "memorySnapshot":{"revision":0,"memories":[]},"threadId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Investigate using ordinary tools"}],"instructionSources":["fixture:retrieval"]})).unwrap();
    let child=f.db.prepare_child(&child.operation_id,source,proposal,basis).unwrap();
    let receipt=child.receipt.as_ref().unwrap();
    let launch=f.db.launch_intent(&receipt.run_id).unwrap().unwrap().selection;
    let binding=RequestBinding { execution_environment: None, direct_tools: None,provider_id:Some("fixture".into()),tokenizer:None,request_context:None,child_dispatch:None,goal:None,
        resource_activations:vec![],resource_checkpoint_id:None,connection_identity:launch.connection_identity,provider_family:launch.provider_family,
        model:launch.model,credential_ref:Some("credential-ref".into()),configuration_generation:launch.configuration_generation,
        tool_schema_generation:launch.tool_schema_generation,tools:launch.tools,instruction_sources:vec!["fixture:retrieval".into()],memory_checkpoint:None,
        attachment_refs:vec![],environment_cursor:0,history_range:HistoryRange{branch_id:child.child_branch_id.clone(),ancestor_id:None,leaf_id:Some(receipt.input_id.clone())}};
    let (tools,_files)=crate::tools::reliability_review::source_reader(&receipt.run_id,&child.child_thread_id);
    let root=f.root.clone();let runtime=RunSupervisor::new(f.db);
    let (send,receive)=std::sync::mpsc::sync_channel(1);
    let handle=runtime.start(&receipt.run_id,varin_runtime::supervisor::RunStart{context_preparation:Arc::new(NoopContextPreparation),
        binding,policy_state:Value::Null,provider:Arc::new(Investigate{pause:stop.then_some(send)}),tools:Arc::new(tools),policy:Arc::new(DefaultAgentPolicy),progress:ProgressSink::default()}).unwrap();
    if stop {
        receive.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        let owner=runtime.catalog();let mut db=owner.lock().unwrap();
        db.cancel_tree(varin_runtime::catalog::dispatch::TreeCancelTarget::Child{operation_id:child.operation_id.clone()}).unwrap();
        assert!(db.operation(&child.operation_id).unwrap().cancel_requested);drop(db);
        assert!(runtime.cancel_control(&receipt.run_id));
    }
    let report=handle.wait().unwrap();assert_eq!(report.state,if stop{varin_runtime::RunState::Cancelled}else{varin_runtime::RunState::Completed},"{report:?}");
    assert_eq!(report.model_steps,2);
    let owner=runtime.catalog();
    varin_runtime::catalog::child_delivery::reconcile_reports(&owner).unwrap();
    assert!(owner.lock().unwrap().operation(&child.operation_id).unwrap().external_receipt.is_none(),"Resource release is part of completion, not launch acceptance");
    owner.lock().unwrap().mark_child_resources_released(&child.execution_id).unwrap();
    varin_runtime::catalog::child_delivery::reconcile_reports(&owner).unwrap();
    varin_runtime::catalog::child_delivery::reconcile_reports(&owner).unwrap();
    let db=owner.lock().unwrap();
    let read=db.capture_operation_read(db.operation(&child.operation_id).unwrap());
    let usage=db.capture_thread_usage(&varin_runtime::catalog::usage::ThreadUsageParams{thread_id:child.parent_thread_id.clone(),branch_id:child.parent_branch_id.clone()}).unwrap();
    assert_eq!(db.list_threads().unwrap().len(),1);drop(db);
    let (_,external)=read.load_with_external_receipt().unwrap();let external=external.unwrap();
    assert_eq!(external.result.data["answer"],"body.txt:1 contains native retrieval evidence.");
    assert_eq!(external.result.data["status"],if stop{"cancelled"}else{"ready"});
    let message=owner.lock().unwrap().capture_message(&child.parent_thread_id,&child.parent_branch_id,&format!("message:{}",child.operation_id)).unwrap().load().unwrap();
    assert!(message.text.contains("body.txt:1 contains native retrieval evidence."));
    let status=owner.lock().unwrap().capture_retrieval_status(&child.parent_run_id,&child.operation_id).unwrap().load().unwrap();
    assert_eq!(status["state"],if stop{"stopped"}else{"completed"});
    assert_eq!(status["latestAction"]["tool"],"file_read");
    assert_eq!(status["latestAction"]["arguments"]["path"],"body.txt");
    if !stop {assert_eq!(status["latestAssistantMessage"]["text"],"body.txt:1 contains native retrieval evidence.");}
    let usage=usage.load(&||false).unwrap();let retrieval=usage.rows.iter().find(|row|row.kind=="retrieval").unwrap();
    assert_eq!(retrieval.requests,2);assert_eq!(retrieval.input_tokens.known.as_deref(),Some("200"));
    runtime.shutdown().unwrap();drop(owner);drop(runtime);std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn internal_retrieval_retains_original_call_and_recovers_preparation_failure() {
    let mut fixture = dispatch::Fixture::new_internal_retrieval();
    let child = fixture.accept();
    assert_eq!(child.operation_id,fixture.context.operation_id);
    assert_eq!(fixture.accept().operation_id,child.operation_id);
    let operation=fixture.db.operation(&child.operation_id).unwrap();
    assert!(matches!(operation.call_completion,Some(varin_runtime::catalog::result_content::ToolCompletionMetadata::JobAccepted{..})),"Admission closes the original tool exchange while investigation continues");
    assert!(operation.handed_off);
    assert!(operation.waiting_on.is_none());
    assert_eq!(fixture.db.list_threads().unwrap().len(),1);
    fixture.db.fail_child_preparation(&child.operation_id,"Original source is unavailable").unwrap();
    fixture.db.mark_child_resources_released(&child.execution_id).unwrap();
    let root=fixture.root.clone();
    drop(fixture);
    let owner=Mutex::new(Catalog::open(&root).unwrap());
    varin_runtime::catalog::child_delivery::reconcile_reports(&owner).unwrap();
    let db=owner.lock().unwrap();
    let operation=db.operation(&child.operation_id).unwrap();
    assert_eq!(operation.outcome,Some(Outcome::Failed));
    assert_eq!(operation.effect,Effect::None);
    let read=db.capture_operation_read(operation);drop(db);
    let (_,receipt)=read.load_with_external_receipt().unwrap();
    let receipt=receipt.unwrap();
    assert_eq!(receipt.executor,"code_retrieval");
    assert_eq!(receipt.result.data["status"],"failed");
    assert!(receipt.result.data["detail"].as_str().unwrap().contains("Original source"));
    drop(owner);
    std::fs::remove_dir_all(root).unwrap();
}
