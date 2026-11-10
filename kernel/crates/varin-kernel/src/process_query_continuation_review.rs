//! Actual guardian output, frozen invocation declarations and a Catalog reopen between pages.
use super::*;
#[allow(dead_code)]
#[path = "fixtures/query_schemas_v93.rs"]
mod original;
#[path = "child_tool_bindings.rs"]
mod frozen_bindings;
use varin_runtime::composition::tools::ToolDirectory;

fn directory(owner: &Arc<Mutex<Catalog>>, binding: &ToolBinding, resources: &KernelResourceClient, schemas: &[ToolSchema]) -> Arc<ToolDirectory> {
    let mut declarations=KernelToolExecutor::new(binding.clone(),resources.clone()).unwrap().declarations(false);
    declarations.retain(|tool| !matches!(tool.schema.name.as_str(),"process_read"|"process_inspect"));
    declarations.extend(crate::process_wait::declarations(owner.clone(),binding.clone(),resources.clone()));
    Arc::new(ToolDirectory::assemble(frozen_bindings::retain(declarations,schemas)).unwrap())
}
fn read_page(owner: &Arc<Mutex<Catalog>>, binding: &ToolBinding, directory: &Arc<ToolDirectory>, schemas: &[ToolSchema], request: &str, arguments: Value) -> varin_runtime::output::OutputBody {
    let schema=schemas.iter().find(|schema|schema.name=="process_read").unwrap();
    let properties=schema.schema["properties"].as_object().unwrap();
    for key in arguments.as_object().unwrap().keys() { assert!(properties.contains_key(key),"continuation must use the original reader declaration"); }
    if let Some(required)=schema.schema["required"].as_array() { for key in required { assert!(arguments.get(key.as_str().unwrap()).is_some()); } }
    let call=ToolCall {call_id:request.into(),name:schema.name.clone(),schema_version:schema.version.clone(),arguments};
    let (context,frozen)=model_call(owner,&binding.run_id,request,&call,schemas);
    let token=CancellationToken::default();
    let bound=directory.clone().bind_call(&call,&frozen,&token).unwrap();
    let contract=bound.prepare(&token).unwrap();
    record(owner,&binding.run_id,ExecutionRecord::ToolAdmitted {context:context.clone(),tool:AdmittedTool {call:call.clone(),contract:contract.clone()}});
    bound.authorize(&context,&contract,&token).unwrap();
    record(owner,&binding.run_id,ExecutionRecord::ToolDispatched {context:context.clone(),executor_owner:bound.executor_owner()});
    let completion=bound.execute(&context,&contract,&token).completion;
    let ToolCompletion::Result {outcome:varin_runtime::Outcome::Succeeded,content,..}=&completion else {panic!("actual process output: {completion:?}")};
    let content=content.clone();
    close_call(owner,&context,&call,completion,true);
    content
}

#[test]
#[ignore = "requires a freshly built kernel executable"]
fn frozen_process_reader_continues_real_output_after_catalog_reopen() {
    use base64::Engine;
    let executable=PathBuf::from(std::env::var_os("VARIN_TEST_KERNEL_EXECUTABLE").expect("fresh kernel executable"));
    assert!(executable.is_file());
    for legacy in [true,false] {
        let root=std::env::temp_dir().join(format!("varin-process-query-contract-{}",uuid::Uuid::new_v4()));
        let cwd=root.join("working");std::fs::create_dir_all(&cwd).unwrap();
        let storage_root=root.join("storage");
        let mut storage=Storage::open(&storage_root,HOST).unwrap();
        storage.set_test_process_worker_executable(executable.clone());
        let controls=crate::process::ProcessControlRegistry::default();storage.set_process_controls(controls.clone());
        let (terminals,terminal_rx)=mpsc::channel();storage.set_process_terminal_sender(terminals);
        issue(&mut storage,&storage_root,"setup","setup",EPOCH);
        let registered=dispatch(&mut storage,"setup","file.root.register",json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":cwd}),EPOCH);
        let kinds=BTreeSet::from([ToolKind::ProcessSpawn,ToolKind::ProcessInspect,ToolKind::ProcessRead]);
        let mut schemas=KernelToolExecutor::selected_schemas(&kinds);
        if legacy { *schemas.iter_mut().find(|schema|schema.name=="process_read").unwrap()=original::process_schema(); }
        schemas.sort_by(|a,b|a.name.cmp(&b.name));
        let mut binding:ToolBinding=serde_json::from_value(json!({"resourceOwner":{"kind":"local"},"grantId":"source","runId":"pending","threadId":"thread",
            "workspaceId":"workspace","executionWorkspaceId":"workspace","rootId":registered["rootId"],"sourceMode":"live_root",
            "liveRoot":{"hostId":HOST,"rootId":registered["rootId"],"canonicalRoot":registered["canonicalRoot"]},
            "enabledTools":["process_spawn","process_inspect","process_read"]})).unwrap();
        let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture",
            "configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"policy":{"name":"fixture","version":"1"},"source":binding.source_selection().unwrap()})).unwrap();
        let mut db=Catalog::open(root.join("catalog")).unwrap();db.create_thread("thread","branch").unwrap();
        let prepared=db.prepare_submission(SubmitInput {key:"original-output".into(),thread_id:"thread".into(),branch_id:"branch".into(),expected_head:None,input:json!("Read original output"),configuration:json!({})},None,None).unwrap().load(Some(launch.clone()),false).unwrap();
        binding.run_id=db.admit_submission(prepared).unwrap().run_id;
        issue(&mut storage,&storage_root,"source",&binding.run_id,EPOCH);
        let runtime=Arc::new(RunSupervisor::new(db));let owner=runtime.catalog();
        let storage=Arc::new(Mutex::new(storage));
        let resource_owner=storage.clone();
        let resources=KernelResourceClient::new(move |request| {
            let result=serve_resource(&mut resource_owner.lock().unwrap(),EPOCH,HOST,GENERATION,&request);
            request.reply.send(result).unwrap();Ok(())
        }, |_|Ok(()),controls);
        let tools=directory(&owner,&binding,&resources,&schemas);
        let (command,args)=if cfg!(windows) {("cmd.exe",vec!["/c","echo first-second-third"])} else {("/bin/sh",vec!["-c","printf first-second-third"])};
        let spawn_schema=schemas.iter().find(|schema|schema.name=="process_spawn").unwrap();
        let spawn=ToolCall {call_id:"spawn-original".into(),name:"process_spawn".into(),schema_version:spawn_schema.version.clone(),
            arguments:json!({"cwd":"","command":command,"args":args,"env":[],"mode":"pipe"})};
        let (context,frozen)=model_call(&owner,&binding.run_id,"spawn-original",&spawn,&schemas);
        let token=CancellationToken::default();let bound=tools.clone().bind_call(&spawn,&frozen,&token).unwrap();
        let contract=bound.prepare(&token).unwrap();
        record(&owner,&binding.run_id,ExecutionRecord::ToolAdmitted {context:context.clone(),tool:AdmittedTool {call:spawn.clone(),contract:contract.clone()}});
        bound.authorize(&context,&contract,&token).unwrap();
        record(&owner,&binding.run_id,ExecutionRecord::ToolDispatched {context:context.clone(),executor_owner:bound.executor_owner()});
        owner.lock().unwrap().bind_managed_process(&context,bound.managed_process().unwrap()).unwrap();
        let completion=bound.execute(&context,&contract,&token).completion;
        assert!(matches!(completion,ToolCompletion::JobAccepted {..}),"{completion:?}");
        close_call(&owner,&context,&spawn,completion,false);
        let terminal=terminal_rx.recv_timeout(Duration::from_secs(20)).unwrap();
        assert_eq!(terminal.process_id,context.operation_id);apply_process_terminal(&runtime,&terminal).unwrap();
        drop(bound);drop(tools);runtime.shutdown().unwrap();drop(owner);drop(runtime);

        let runtime=Arc::new(RunSupervisor::new(Catalog::open(root.join("catalog")).unwrap()));let owner=runtime.catalog();
        let tools=directory(&owner,&binding,&resources,&schemas);
        let first=read_page(&owner,&binding,&tools,&schemas,"read-first",json!({"processId":context.operation_id,"cursor":0,"maxBytes":5,"mode":"raw","encoding":"utf-8"}));
        let visible=first.model_data();
        let next=if legacy {
            assert_eq!(visible,&first.data);assert!(visible.get("nextRead").is_none());
            json!({"processId":visible["process"]["processId"],"cursor":visible["nextCursor"],"maxBytes":5,"mode":"raw","encoding":"utf-8"})
        } else {
            assert!(visible["processId"].as_str().unwrap().starts_with("proc:"));
            assert!(visible["nextRead"]["arguments"]["ref"].as_str().unwrap().starts_with("read:"));
            visible["nextRead"]["arguments"].clone()
        };
        assert_eq!(first.data["nextCursor"],5);
        drop(tools);runtime.shutdown().unwrap();drop(owner);drop(runtime);
        let runtime=Arc::new(RunSupervisor::new(Catalog::open(root.join("catalog")).unwrap()));let owner=runtime.catalog();
        let tools=directory(&owner,&binding,&resources,&schemas);
        let second=read_page(&owner,&binding,&tools,&schemas,"read-second",next);
        let bytes=|value:&Value|value["chunks"].as_array().unwrap().iter().flat_map(|chunk|base64::engine::general_purpose::STANDARD.decode(chunk["bytesBase64"].as_str().unwrap()).unwrap()).collect::<Vec<_>>();
        assert_eq!(bytes(&first.data),b"first");assert_eq!(bytes(&second.data),b"-seco");assert_eq!(second.data["nextCursor"],10);
        assert_eq!(owner.lock().unwrap().launch_intent(&binding.run_id).unwrap().unwrap().selection.tools,schemas);
        drop(tools);runtime.shutdown().unwrap();drop(owner);drop(runtime);drop(resources);drop(storage);
        std::fs::remove_dir_all(root).unwrap();
    }
}
