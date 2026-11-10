//! Real external dispatch/message admissions keep their canonical model handles across
//! the acceptance/ToolSettled crash boundary, without creating native child Runs.
#[path = "fixtures/child_dispatch.rs"]
mod child_dispatch;
#[path = "fixtures/computer_requests.rs"]
#[allow(dead_code)]
mod tool_invocations;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::{catalog::{dispatch::*, messages::MessageInput, model_references::ReferenceKind}, execution::*, *};

#[test]
fn external_send_acceptance_replays_its_original_projection_before_tool_settlement() {
    for inform in [false,true] {
        for policy in [false,true] {
            let mut f=child_dispatch::Fixture::new();
            let mut launch=f.db.launch_intent(&f.context.run_id).unwrap().unwrap().selection;
            launch.tools.push(ToolSchema{requirements:None,name:"send".into(),version:"1".into(),description:String::new(),schema:json!({"type":"object"}),output_schema:None,metadata:None});
            launch.child_dispatch.as_mut().unwrap().presets.push(ChildPreset{
                work_focus:vec![],external:Some(ExternalChildBinding{configuration_id:"codex".into(),harness:"codex".into(),model:None,
                    launch:ExternalLaunch{command:"codex".into(),args:vec![]}}),description:None,avatar:None,id:"external".into(),name:"External worker".into(),instructions:String::new(),tools:vec![],
                tools_source:ChildPresetToolsSource::Explicit,retired_work_mode:None,model_source:ChildModelSource::Inherit,inherit_base:None,model:None,unavailable:None,
            });
            f.db.create_thread("external-parent","external-main").unwrap();
            let configuration=f.db.run(&f.context.run_id).unwrap().configuration;
            let run=f.db.submit_with_launch(&SubmitInput{key:"external-parent".into(),thread_id:"external-parent".into(),branch_id:"external-main".into(),
                expected_head:None,input:json!({"text":"Delegate and send an original message"}),configuration},Some(launch.clone())).unwrap();
            let model=ChildModelBinding{configuration:serde_json::from_value(f.db.run(&run.run_id).unwrap().configuration).unwrap(),credential_scope:launch.credential_scope.clone()};
            let prepared=f.db.prepare_child_dispatch_binding(&run.run_id,model,launch.tool_schema_generation,launch.tools.clone()).unwrap().load().unwrap();
            f.db.bind_child_dispatch(&run.run_id,prepared).unwrap();
            f.context.run_id=run.run_id.clone();f.launch=launch;
            let mut dispatch=f.input.clone();dispatch.preset=Some("external".into());dispatch.tools=None;dispatch.work_mode=Some(ChildWorkMode::Shared);
            let context=f.admit_policy_call(ToolCall{call_id:"external-dispatch".into(),name:"dispatch".into(),schema_version:"1".into(),arguments:serde_json::to_value(&dispatch).unwrap()});
            let selected=f.db.capture_child_dispatch_invocation(&context).unwrap().load().unwrap();
            let preset=selected.external_preset(&dispatch).unwrap().unwrap();
            let prepared=f.db.prepare_external_child(&context,&dispatch,&selected,&preset,None).unwrap().load().unwrap();
            let child=f.db.accept_external_child(prepared).unwrap();
            f.settle_policy_call(&context,"preparing_external_agent");
            let command=serde_json::from_value(json!({"action":"create","id":child.conversation_id,"key":"external-conversation","configurationId":"codex","harness":"codex","title":"External worker","cwd":"/workspace"})).unwrap();
            let prepared=f.db.prepare_external(command).load().unwrap();f.db.execute_external(prepared).unwrap().load().unwrap();
            let args=json!({"targetThreadId":child.conversation_id,"kind":if inform{"inform"}else{"request"},"text":"Keep literal file:999 unchanged"});
            let context=tool_invocations::admit_kernel_call(&mut f.db,&run.run_id,"send",args.clone(),policy);
            let intent=f.db.operation(&context.operation_id).unwrap().intent;
            let call=ToolCall{call_id:intent["call"]["call_id"].as_str().unwrap().into(),name:"send".into(),schema_version:"1".into(),arguments:args.clone()};
            let input:MessageInput=serde_json::from_value(args).unwrap();
            let prepared=f.db.prepare_external_message(&context,call.clone(),input.clone()).unwrap().load().unwrap();
            let completion=f.db.admit_external_message(prepared).unwrap();
            assert_eq!(f.db.capture_call_completion(&context.operation_id).unwrap().load().unwrap(),completion);
            let ToolCompletion::Result{content,..}=&completion else {panic!("non-wait send acceptance")};
            assert_eq!(content.data["operationId"],context.operation_id);
            assert_eq!(content.data["conversationId"],child.conversation_id);
            let model=content.model_data.as_ref().unwrap();
            assert!(!model.to_string().contains(&context.operation_id));
            assert!(!model.to_string().contains(&child.conversation_id));
            if inform {
                let reference=model["ref"].as_str().unwrap();
                assert!(reference.starts_with("report:"));
                let target=f.db.resolve_model_reference(ReferenceKind::Report,reference).unwrap();
                assert_eq!(target.target["operationId"],context.operation_id);
                assert!(f.db.execution_reference(&context.operation_id).is_err());
            } else {
                let reference=f.db.execution_reference(&context.operation_id).unwrap();
                assert!(model.to_string().contains(&reference.reference));
            }
            let prepared=f.db.prepare_external_message(&context,call,input).unwrap().load().unwrap();
            assert_eq!(f.db.admit_external_message(prepared).unwrap(),completion);
            let root=f.root.clone();drop(f.db);
            let db=Catalog::open(&root).unwrap();
            assert_eq!(db.capture_call_completion(&context.operation_id).unwrap().load().unwrap(),completion);
            let retained=db.external_child(&context.operation_id).unwrap().unwrap();
            assert_eq!(retained.conversation_id,child.conversation_id);
            let raw=rusqlite::Connection::open(root.join("conversation.sqlite")).unwrap();
            assert_eq!(raw.query_row("SELECT COUNT(*) FROM runs",[],|r|r.get::<_,i64>(0)).unwrap(),2,"external messages must not create native Runs");
            drop(raw);drop(db);std::fs::remove_dir_all(root).unwrap();
        }
    }
}
