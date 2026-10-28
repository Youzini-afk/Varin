//! Reported tool failures against the real resource owners, in disposable roots.
use super::*;
use std::{fs, path::PathBuf, sync::Mutex};
const HOST: &str = "tools-host";
const GENERATION: &str = "tools-generation";
const EPOCH: &str = "tools-epoch";

#[test]
fn missing_workspace_backend_rejects_isolation_before_source_receipts_and_keeps_shared() {
    if crate::workspace_backend::require().is_ok() { return; }
    let f = Fixture::new();
    let mut storage = f._storage.lock().unwrap();
    let (grant, _) = storage.authorize(Some("actor"), EPOCH, HOST, GENERATION,
        "storage.health", &json!({"workspaceId":"workspace"})).unwrap();
    let context = ToolExecutionContext { run_id:"run".into(), operation_id:"isolation-preflight".into(),
        origin:ToolOrigin::ModelStep { request_id:"request".into() } };
    let mut delegation = varin_runtime::catalog::dispatch::ChildSourceDelegation {
        source_path:None,agent_source:None,work_mode:varin_runtime::catalog::dispatch::ChildWorkMode::IsolatedWrite,
        process:false,configured_preset:true,selection_ref:json!({}) };
    let failure: varin_runtime::execution::ExecutionError = storage.child_source_handoff(
        &f.executor.binding, &context, &delegation, &grant, HOST, true).unwrap_err().into();
    assert_eq!(failure.code, "workspace_backend_unavailable");
    assert_eq!(failure.details.as_ref().unwrap()["executionStarted"], false);
    assert_eq!(failure.details.as_ref().unwrap()["hostId"], HOST);
    assert!(failure.message.contains("workMode=shared"));
    assert!(storage.dispatch("operation.get", &json!({"operationId":"child-source-handoff:isolation-preflight"}), Some("actor"), &grant).unwrap().is_null());
    delegation.work_mode = varin_runtime::catalog::dispatch::ChildWorkMode::Shared;
    assert!(storage.child_source_handoff(&f.executor.binding, &context, &delegation, &grant, HOST, false).is_ok());
}
pub(crate) struct TestRoot(PathBuf);
impl std::ops::Deref for TestRoot {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}
impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Fixture {
    executor: KernelToolExecutor,
    _storage: Arc<Mutex<Storage>>,
    root: TestRoot,
    serial: usize,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("varin-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        let mut storage = Storage::open(&root.join("store"), HOST).unwrap();
        storage.issue_grant(&json!({"grantId":"actor","hostGeneration":GENERATION,"capabilities":["storage.admin","process"],
            "pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":"run"}),
            HOST,GENERATION,&root.join("store").to_string_lossy(),EPOCH).unwrap();
        let params = json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":root.join("work")});
        let (grant, params) = storage
            .authorize(
                Some("actor"),
                EPOCH,
                HOST,
                GENERATION,
                "file.root.register",
                &params,
            )
            .unwrap();
        let registered = storage
            .dispatch("file.root.register", &params, Some("actor"), &grant)
            .unwrap();
        let binding:ToolBinding=serde_json::from_value(json!({"resourceOwner":{"kind":"local"},"grantId":"actor","runId":"run","threadId":"thread",
            "workspaceId":"workspace","executionWorkspaceId":"workspace","rootId":registered["rootId"],"sourceMode":"live_root",
            "liveRoot":{"hostId":HOST,"rootId":registered["rootId"],"canonicalRoot":registered["canonicalRoot"]},
            "enabledTools":["file_read","file_write","file_edit","file_list","file_search","process_spawn"]})).unwrap();
        let storage = Arc::new(Mutex::new(storage));
        let owner = storage.clone();
        let resources = KernelResourceClient::new(
            move |request| {
                let result = serve_resource(
                    &mut owner.lock().unwrap(),
                    EPOCH,
                    HOST,
                    GENERATION,
                    &request,
                );
                request.reply.send(result).unwrap();
                Ok(())
            },
            |_| Ok(()),
            crate::process::ProcessControlRegistry::default(),
        );
        Self {
            executor: KernelToolExecutor::new(binding, resources).unwrap(),
            _storage: storage,
            root: TestRoot(root),
            serial: 0,
        }
    }
    fn call(&mut self, name: &str, arguments: Value) -> ToolCompletion {
        self.try_call(name, arguments).unwrap()
    }
    fn try_call(&mut self, name: &str, arguments: Value) -> Result<ToolCompletion, ExecutionError> {
        self.serial += 1;
        let call = ToolCall {
            call_id: format!("call-{}", self.serial),
            name: name.into(),
            schema_version: "1".into(),
            arguments,
        };
        let origin = ToolOrigin::ModelStep {
            request_id: "request".into(),
        };
        let context = execution_context(&self.executor.binding.run_id, &call, &origin);
        let cancel = CancellationToken::default();
        let operation = self.executor.operation(Some(&context), &call)?;
        let contract = self
            .executor
            .planned_contract(&context, &call, &operation, &cancel)?;
        Ok(self
            .executor
            .execute_operation(&context, &call, operation, &contract, &cancel))
    }
    fn next_run(&mut self, id: &str, scopes: &[&str]) {
        self._storage.lock().unwrap().issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,
            "capabilities":["storage.read","storage.write"],"pathScopes":scopes,"owningWorkspace":"workspace",
            "executionWorkspace":"workspace","threadId":"thread","runId":id}), HOST,GENERATION,
            &self.root.join("store").to_string_lossy(),EPOCH).unwrap();
        self.executor.binding.grant_id = id.into();
        self.executor.binding.run_id = id.into();
    }
    fn read(&mut self, args: Value) -> Value {
        match self.call("file_read", args) {
            ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                content,
                ..
            } => content.data,
            other => panic!("{other:?}"),
        }
    }
}

pub(crate) fn source_reader(run:&str,thread:&str)->(KernelToolExecutor,TestRoot) {
    let mut f=Fixture::new();
    fs::write(f.root.join("work/body.txt"),"native retrieval evidence\r\n").unwrap();
    f._storage.lock().unwrap().issue_grant(&json!({"grantId":"child-reader","hostGeneration":GENERATION,
        "capabilities":["storage.read"],"pathScopes":[""],"owningWorkspace":"workspace",
        "executionWorkspace":"workspace","threadId":thread,"runId":run}),HOST,GENERATION,
        &f.root.join("store").to_string_lossy(),EPOCH).unwrap();
    f.executor.binding.grant_id="child-reader".into();
    f.executor.binding.thread_id=thread.into();f.executor.binding.run_id=run.into();
    f.executor.binding.enabled_tools=[ToolKind::FileRead].into_iter().collect();
    (f.executor,f.root)
}

#[test]
fn fixed_source_commands_prepare_once_and_reads_searches_use_the_owned_view() {
    let mut f = Fixture::new();
    let body = "原🙂 original fixed text\r\n".as_bytes();
    {
        let mut storage=f._storage.lock().unwrap();
        let mut invoke=|method:&str,params:Value| {
            let (grant,params)=storage.authorize(Some("actor"),EPOCH,HOST,GENERATION,method,&params).unwrap();
            storage.dispatch(method,&params,Some("actor"),&grant).unwrap()
        };
        invoke("storage.putBlob.begin",json!({"operationId":"fixed-blob","streamId":"fixed-body","workspaceId":"workspace","byteLength":body.len()}));
        invoke("storage.putBlob.chunk",json!({"streamId":"fixed-body","sequence":0,"bytesBase64":BASE64.encode(body)}));
        let blob=invoke("storage.putBlob.finish",json!({"operationId":"fixed-blob","streamId":"fixed-body","workspaceId":"workspace"}));
        invoke("branch.create.begin",json!({"operationId":"fixed-create","builderId":"fixed-builder","workspaceId":"workspace","branchId":"fixed","draftBasePaths":[],"captureScopes":[]}));
        invoke("branch.create.append",json!({"builderId":"fixed-builder","sequence":0,"entries":[{"path":"body.txt","state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":body.len(),"mode":420},"ownerId":blob["ownerId"]}]}));
        invoke("branch.create.finish",json!({"operationId":"fixed-create","builderId":"fixed-builder"}));
    }
    f.executor.binding.source_mode=SourceMode::FixedBranch;
    f.executor.binding.root_id=None;
    f.executor.binding.live_root=None;
    f.executor.binding.file_source=Some(FixedFileSource{branch_id:"fixed".into(),revision:0});
    assert_eq!(f.read(json!({"path":"body.txt"}))["content"]["text"],String::from_utf8_lossy(body).as_ref());
    let page=f.read(json!({"path":"body.txt","offset":1,"length":1}));
    assert_eq!(page["content"]["text"],"原");assert_eq!(page["content"]["offset"],0);assert_eq!(page["content"]["nextOffset"],3);
    assert!(!f.root.join("store/managed/source-views").exists());
    // The command's cwd is checked against the prepared fixed view, before spawning.
    let result=f.call("process_spawn",json!({"command":"varin-fixture-program-does-not-exist","cwd":"missing"}));
    assert!(matches!(result,ToolCompletion::NotDispatched{..}),"{result:?}");
    {
        let mut storage=f._storage.lock().unwrap();
        let (grant,_)=storage.authorize(Some("actor"),EPOCH,HOST,GENERATION,"storage.health",&json!({"workspaceId":"workspace"})).unwrap();
        assert!(storage.execution_tool_binding(&f.executor.binding,&grant).unwrap().is_some());
    }
    let root={let storage=f._storage.lock().unwrap();
        let (grant,_)=storage.authorize(Some("actor"),EPOCH,HOST,GENERATION,"storage.health",&json!({"workspaceId":"workspace"})).unwrap();
        PathBuf::from(storage.check_materialized_view(&json!({"workspaceId":"workspace","viewId":"run-execution:run"}),&grant).unwrap()["canonicalRoot"].as_str().unwrap())};
    fs::write(root.join("body.txt"),"changed in execution view\r\n").unwrap();
    assert_eq!(f.read(json!({"path":"body.txt"}))["content"]["text"],"changed in execution view\r\n");
    let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=f.call("file_search",json!({"query":"changed"})) else {panic!("derived search failed")};
    assert_eq!(content.data["records"][0]["path"],"body.txt");
    assert!(!f.root.join("work/body.txt").exists());
    {
        let mut storage=f._storage.lock().unwrap();
        let (grant,_)=storage.authorize(Some("actor"),EPOCH,HOST,GENERATION,"storage.health",&json!({"workspaceId":"workspace"})).unwrap();
        let context=ToolExecutionContext{run_id:"run".into(),operation_id:"request:tool:handoff".into(),origin:ToolOrigin::ModelStep{request_id:"request".into()}};
        let handoff=storage.child_source_handoff(&f.executor.binding,&context,&varin_runtime::catalog::dispatch::ChildSourceDelegation{ source_path: None,
            agent_source:None,work_mode:varin_runtime::catalog::dispatch::ChildWorkMode::Shared,process:true,configured_preset:true,selection_ref:json!({"content_object":"fixture"})},&grant,HOST,false).unwrap();
        assert_eq!(handoff["root"]["kind"],"derived");assert_eq!(handoff["root"]["view_id"],"run-execution:run");
        assert_eq!(fs::canonicalize(handoff["root"]["root"]["canonicalRoot"].as_str().unwrap()).unwrap(),fs::canonicalize(&root).unwrap());
        storage.revoke_grant(&json!({"grantId":"actor"}),HOST).unwrap();
        assert!(storage.obsolete_materialized_views(EPOCH).unwrap().is_empty(),"Original handoff retains physical bytes until capture transfers ownership");
        let owner=serde_json::from_value(handoff.clone()).unwrap();
        let identity=f.root.join("store").to_string_lossy().into_owned();
        storage.claim_child_handoff(&json!({"grantId":"release-handoff","childThreadId":"thread:child:request:tool:handoff"}),&owner,HOST,GENERATION,&identity,EPOCH).unwrap();
        let p=json!({"operationId":"release-derived-pin","branchId":"fixed","pinId":handoff["root"]["pin"]["pin_id"]});
        let (release,p)=storage.authorize(Some("release-handoff"),EPOCH,HOST,GENERATION,"branch.unpin",&p).unwrap();
        storage.dispatch("branch.unpin",&p,Some("release-handoff"),&release).unwrap();
        assert_eq!(storage.obsolete_materialized_views(EPOCH).unwrap().len(),1);
    }
    // A separately admitted fixed reader still observes the immutable baseline.
    f.next_run("baseline-reader",&[""]);
    assert_eq!(f.read(json!({"path":"body.txt"}))["content"]["text"],String::from_utf8_lossy(body).as_ref());
}

#[test]
fn scoped_fixed_source_reads_without_copy_and_first_write_uses_the_observed_version() {
    let mut f=Fixture::new();
    {
        let mut storage=f._storage.lock().unwrap();
        let mut invoke=|method:&str,params:Value| {
            let (grant,params)=storage.authorize(Some("actor"),EPOCH,HOST,GENERATION,method,&params).unwrap();
            storage.dispatch(method,&params,Some("actor"),&grant).unwrap()
        };
        invoke("storage.putBlob.begin",json!({"operationId":"scoped-body","streamId":"scoped-body","workspaceId":"workspace","byteLength":8}));
        invoke("storage.putBlob.chunk",json!({"streamId":"scoped-body","sequence":0,"bytesBase64":BASE64.encode(b"original")}));
        let blob=invoke("storage.putBlob.finish",json!({"operationId":"scoped-body","streamId":"scoped-body","workspaceId":"workspace"}));
        invoke("branch.create.begin",json!({"operationId":"scoped-create","builderId":"scoped-create","workspaceId":"workspace","branchId":"parent","draftBasePaths":[],"captureScopes":[]}));
        invoke("branch.create.append",json!({"builderId":"scoped-create","sequence":0,"entries":[
            {"path":"sub/body.txt","state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":8,"mode":420},"ownerId":blob["ownerId"]},
            {"path":"sibling","state":{"kind":"directory","mode":493}}]}));
        invoke("branch.create.finish",json!({"operationId":"scoped-create","builderId":"scoped-create"}));
    }
    f.executor.binding.source_mode=SourceMode::FixedBranch;
    f.executor.binding.root_id=None;f.executor.binding.live_root=None;
    f.executor.binding.file_source=Some(FixedFileSource{branch_id:"parent".into(),revision:0});
    let handoff={
        let mut storage=f._storage.lock().unwrap();
        let (grant,_)=storage.authorize(Some("actor"),EPOCH,HOST,GENERATION,"storage.health",&json!({"workspaceId":"workspace"})).unwrap();
        let context=ToolExecutionContext{run_id:"run".into(),operation_id:"scoped-dispatch".into(),origin:ToolOrigin::ModelStep{request_id:"request".into()}};
        let handoff=storage.child_source_handoff(&f.executor.binding,&context,&varin_runtime::catalog::dispatch::ChildSourceDelegation{
            source_path:Some("sub".into()),agent_source:None,work_mode:varin_runtime::catalog::dispatch::ChildWorkMode::Shared,
            process:true,configured_preset:true,selection_ref:json!({})},&grant,HOST,false).unwrap();
        assert_eq!(handoff["source_path"],"sub");
        for (method,params) in [
            ("branch.create.begin",json!({"operationId":"branch-create:child-source:scoped-dispatch","builderId":"child-create","branchId":"child-source:scoped-dispatch","workspaceId":"workspace","baseRef":handoff["root"]["pin"]["root"],"draftBasePaths":[],"captureScopes":[]})),
            ("branch.create.finish",json!({"operationId":"branch-create:child-source:scoped-dispatch","builderId":"child-create"}))] {
            storage.dispatch(method,&params,Some("actor"),&grant).unwrap();
        }
        let tree=storage.dispatch("branch.read",&json!({"branchId":"child-source:scoped-dispatch","revision":0,"includeEntries":true}),Some("actor"),&grant).unwrap();
        assert_eq!(tree["entries"].as_array().unwrap().len(),1);
        assert_eq!(tree["entries"][0]["path"],"body.txt");
        handoff
    };
    assert!(!handoff["root"]["pin"]["root"].is_null());
    f.executor.binding.source_mode=SourceMode::Materialized;
    f.executor.binding.materialized_source=Some(FixedFileSource{branch_id:"child-source:scoped-dispatch".into(),revision:0});
    f.executor.binding.file_source=None;
    let before=f.read(json!({"path":"body.txt"}));
    assert_eq!(before["content"]["text"],"original");
    assert!(before["readVersion"].is_string());
    assert!(!f.root.join("store/managed/runs").exists());
    let changed=f.call("file_write",json!({"path":"body.txt","readVersion":before["readVersion"],"content":"private change"}));
    assert!(matches!(changed,ToolCompletion::Result{outcome:Outcome::Succeeded,effect:Effect::Confirmed,..}),"{changed:?}");
    assert_eq!(f.read(json!({"path":"body.txt"}))["content"]["text"],"private change");
    assert!(f.root.join("store/managed/runs").is_dir());
    assert!(!f.root.join("work/body.txt").exists());
    let stale=f.call("file_write",json!({"path":"body.txt","readVersion":before["readVersion"],"content":"stale"}));
    assert!(matches!(stale,ToolCompletion::NotDispatched{..}),"{stale:?}");
}

#[test]
fn batch_reads_keep_original_ranges_and_individual_failures() {
    let mut f = Fixture::new();
    fs::write(f.root.join("work/a.txt"), "one\r\ntwo\r\nthree\r\n").unwrap();
    let result = f.call("file_read",json!({"files":[
        {"path":"a.txt","startLine":2,"endLine":3},
        {"path":"missing.txt"},{"path":"../escape"},{"path":"a.txt","offset":0,"length":5}
    ]}));
    let ToolCompletion::Result {content,..} = result else {panic!("read result")};
    assert_eq!(content.data["status"],"partial");
    assert_eq!(content.data["files"][0]["result"]["content"]["text"],"two\r\nthree\r\n");
    assert_eq!(content.data["files"][1]["result"]["status"],"missing");
    assert_eq!(content.data["files"][2]["result"]["status"],"failed");
    assert_eq!(content.data["files"][3]["result"]["content"]["text"],"one\r\n");
    assert_eq!(content.data["files"][0]["result"]["readVersion"],content.data["files"][3]["result"]["readVersion"]);
}

#[test]
fn overlapping_line_batches_fall_back_when_the_combined_range_exceeds_the_frame() {
    let mut f=Fixture::new();
    let line=format!("{}\r\n","x".repeat(crate::protocol::MAX_BLOB_RESPONSE_BYTES/3+1));
    fs::write(f.root.join("work/large.txt"),line.repeat(4)).unwrap();
    let result=f.read(json!({"files":[{"path":"large.txt","startLine":1,"endLine":2},{"path":"large.txt","startLine":2,"endLine":3}]}));
    assert_eq!(result["status"],"ready");
    for item in result["files"].as_array().unwrap() {assert_eq!(item["result"]["content"]["text"],line.repeat(2));}
    assert_eq!(result["files"][0]["result"]["readVersion"],result["files"][1]["result"]["readVersion"]);
}

#[test]
fn search_batches_preserve_matches_and_continue_within_a_versioned_file() {
    let mut f = Fixture::new();
    fs::write(f.root.join("work/source.txt"), "alpha\nbeta alpha\ngamma\nbeta\n").unwrap();
    fs::write(f.root.join("work/z.txt"), "alpha\n").unwrap();
    let result = |value| match value {
        ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } => content.data,
        other => panic!("search failed: {other:?}"),
    };
    let first = result(f.call("file_search", json!({"queries":["alpha","beta"],"maxResults":1,"after":1})));
    assert_eq!(first["records"][0]["data"]["line"], 1);
    assert_eq!(first["records"][0]["data"]["queryIndices"], json!([0]));
    assert_eq!(first["records"][0]["data"]["after"], json!(["beta alpha"]));
    assert_eq!(first["scanComplete"], false);
    let second = result(f.call("file_search", json!({"queries":["alpha","beta"],"maxResults":2,"after":1,"cursor":first["nextCursor"]})));
    assert_eq!(second["records"][0]["data"]["line"], 2);
    assert_eq!(second["records"][0]["data"]["queryIndices"], json!([0,1]));
    assert_eq!(second["records"][1]["data"]["line"], 4);
    let third = result(f.call("file_search", json!({"queries":["alpha","beta"],"maxResults":2,"after":1,"cursor":second["nextCursor"]})));
    assert_eq!(third["records"].as_array().unwrap().len(), 1);
    assert_eq!(third["records"][0]["path"], "z.txt");
    assert!(third["nextCursor"].is_null());
    assert_eq!(third["scanComplete"], true);
    assert!(f.try_call("file_search", json!({"query":"gamma","cursor":first["nextCursor"]})).is_err());
    fs::write(f.root.join("work/source.txt"), "changed\nalpha\n").unwrap();
    let changed = f.call("file_search", json!({"queries":["alpha","beta"],"after":1,"cursor":first["nextCursor"]}));
    assert!(matches!(changed, ToolCompletion::Result {outcome:Outcome::Failed,..}));
}

#[test]
fn search_batch_keeps_valid_results_when_an_expression_is_invalid() {
    let mut f = Fixture::new();
    fs::write(f.root.join("work/source.txt"), "alpha\n").unwrap();
    let ToolCompletion::Result {outcome:Outcome::Succeeded,content,..} = f.call("file_search", json!({"queries":["[","alpha"],"fixedStrings":false})) else {panic!("batch failed")};
    assert_eq!(content.data["queryErrors"][0]["queryIndex"], 0);
    assert_eq!(content.data["records"][0]["data"]["queryIndices"], json!([1]));
    assert_eq!(content.data["status"], "partial");
}

#[test]
fn managed_unit_reads_compose_structure_and_bytes_at_the_coordinator() {
    use sha2::Digest;
    let f=Fixture::new();
    let (output,events)=mpsc::sync_channel(16);
    let source=crate::host_query::OwnerChannel::new("source-resource",output.clone());source.initialize(EPOCH);
    let language=crate::language::LanguageBridge::new(output.clone());language.initialize(EPOCH);drop(output);
    let mut binding=f.executor.binding.clone();
    binding.resource_owner=serde_json::from_value(json!({"kind":"managed_host","hostId":"target","connectionId":"remote","endpointIdentity":"endpoint"})).unwrap();
    binding.live_root.as_mut().unwrap().host_id="target".into();
    binding.remote_authority=Some(RemoteResourceAuthority{authority_id:"original-authority".into(),resource_epoch:"target-epoch".into(),
        execution_owner:varin_runtime::ExecutorOwner::External{identity:"original-authority".into(),epoch:"target-epoch".into()}});
    let selection=binding.source_selection().unwrap();let returned_source=selection.clone();
    let body="function marker() {}";let hash=hex::encode(sha2::Sha256::digest(body.as_bytes()));
    let reply_source=source.clone();let reply_language=language.clone();
    let responder=std::thread::spawn(move||{
        let mut structured=false;let mut read=false;
        for event in events {
            let query=&event["query"];
            if event["kind"]=="language-request" {
                assert_eq!(query["method"],"structure");assert_eq!(query["source"],json!(returned_source));structured=true;
                reply_language.receive(json!({"v":1,"kind":"language-response","id":event["id"],"kernelEpoch":EPOCH,
                    "result":{"status":"ready","revision":"version","contentHash":hash,"items":[{"name":"marker","range":{"startLine":1,"endLine":1,"startByte":0,"endByte":body.len()}}]}}));
            } else if event["kind"]=="source-resource-request" {
                // Resource Hosts execute original reads; the composite tool never
                // invokes a second remote file_read lacking the language owner.
                assert_eq!(query["kind"],"resource");
                let value=if query["action"]["kind"]=="retrieval_source" {json!({"source":returned_source,"physicalRoot":null})}
                    else if query["authorizeOnly"]==true {json!({"resourceKey":"original-file"})}
                    else {read=true;json!({"path":"source.ts","content":{"text":body,"hash":format!("sha256-{hash}"),"offset":0,"nextOffset":body.len(),"eof":true}})};
                reply_source.receive(json!({"v":1,"kind":"source-resource-response","id":event["id"],"kernelEpoch":EPOCH,"result":{"ok":true,"value":value}}));
            }
        }
        assert!(structured && read);
    });
    let executor=Arc::new(KernelToolExecutor::new(binding,f.executor.resources.clone().with_source_bridge(source.clone())).unwrap().with_language(language.clone()));
    let call=ToolCall{call_id:"unit".into(),name:"file_read".into(),schema_version:"1".into(),arguments:json!({"path":"source.ts","unit":{"line":1}})};
    let origin=ToolOrigin::ModelStep{request_id:"unit-request".into()};let context=execution_context("run",&call,&origin);
    let request=FrozenToolContext { execution_environment: None, direct_tools: None,run_id:"run".into(),origin,tools:Arc::new(executor.schemas.clone()),tool_schema_generation:1,source:Some(selection),child_dispatch:None,resource_activations:vec![],resource_checkpoint_id:None};
    let cancel=CancellationToken::default();let bound=executor.bind_call(&call,&request,&cancel).unwrap();
    assert_eq!(bound.executor_owner(),varin_runtime::ExecutorOwner::Kernel);
    let plan=bound.prepare(&cancel).unwrap();bound.authorize(&context,&plan,&cancel).unwrap();
    let result=bound.execute(&context,&plan,&cancel);
    let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=result.completion else {panic!("unit read failed")};
    assert_eq!(content.data["unit"]["name"],"marker");assert_eq!(content.data["content"]["text"],body);
    source.close();language.close();responder.join().unwrap();
}

#[test]
fn search_pages_keep_the_original_job_and_release_paused_work_on_revocation() {
    use base64::Engine;
    let mut f=Fixture::new();
    fs::write(f.root.join("work/large.txt"),("needle ".to_owned()+&"x".repeat(8192)+"\n").repeat(300)).unwrap();
    let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=f.call("file_search",json!({"query":"needle","maxResults":10000,"maxBytes":1})) else {panic!("initial page failed")};
    let decode=|value:&Value|->Value{serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value.as_str().unwrap()).unwrap()).unwrap()};
    let first=content.data;let handle=decode(&first["nextCursor"]);
    let job=handle["job_id"].as_str().unwrap();
    let watch={let storage=f._storage.lock().unwrap();
        let(grant,_)=storage.authorize(Some("actor"),EPOCH,HOST,GENERATION,"storage.health",&json!({"workspaceId":"workspace"})).unwrap();
        storage.watch_compute(job,"workspace",&grant).unwrap()};
    assert!(watch.wait(u64::MAX,false,&CancellationToken::default()),"Producer yields without waiting for another model page");
    let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=f.call("file_search",json!({"query":"needle","maxResults":3,"cursor":first["nextCursor"]})) else {panic!("continuation failed")};
    assert_eq!(decode(&content.data["nextCursor"])["job_id"],handle["job_id"]);
    assert_eq!(content.data["records"][0]["data"]["line"],2);
    assert_eq!(content.data["records"][2]["data"]["line"],4);
    let retained=content.data["nextCursor"].clone();
    let mut expired=decode(&retained);expired["epoch"]=json!("prior-kernel");
    let expired=base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&expired).unwrap());
    let rejected=f.call("file_search",json!({"query":"needle","cursor":expired}));
    assert!(serde_json::to_string(&rejected).unwrap().contains("earlier kernel epoch"));
    // An old-epoch request cannot advance or cancel the current job.
    let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=f.call("file_search",json!({"query":"needle","maxResults":1,"cursor":retained})) else {panic!("expired cursor changed the current job")};
    assert_eq!(content.data["records"][0]["data"]["line"],5);
    let retained=content.data["nextCursor"].clone();
    f._storage.lock().unwrap().revoke_grant(&json!({"grantId":"actor"}),HOST).unwrap();
    assert!(watch.wait(0,true,&CancellationToken::default()));
    f.next_run("new-reader",&[""]);
    let result=f.call("file_search",json!({"query":"needle","cursor":retained}));
    assert!(matches!(result,ToolCompletion::Result{outcome:Outcome::Failed,..}));
    assert!(serde_json::to_string(&result).unwrap().contains("Restart without cursor"));
}

#[test]
fn unavailable_unit_reads_return_context_and_plain_continuation_without_reinterpreting_unit_offsets() {
    let mut f=Fixture::new();
    let text=(1..150).map(|i|format!("line {i}: 中文\r\n")).collect::<String>();
    fs::write(f.root.join("work/source.unknown"),&text).unwrap();
    let read=f.read(json!({"path":"source.unknown","unit":{"line":50}}));
    assert_eq!(read["content"]["startLine"],30);
    assert!(read["content"]["text"].as_str().unwrap().contains("line 50: 中文\r\n"));
    assert!(read["content"]["text"].as_str().unwrap().ends_with("line 110: 中文\r\n"));
    assert_eq!(read["structure"]["fallback"],"plain_read");
    assert_eq!(read["unitComplete"],false);
    let next=f.read(read["nextRead"].clone());
    assert!(next["content"]["text"].as_str().unwrap().starts_with("line 111:"));
    assert_eq!(next["readVersion"],read["readVersion"]);
    let failed=f.call("file_read",json!({"path":"source.unknown","unit":{"line":50,"revision":"old"},"offset":5}));
    assert!(matches!(failed,ToolCompletion::Result { outcome:Outcome::Failed,.. }));
    let batch=f.read(json!({"files":[{"path":"source.unknown","unit":{"line":50,"revision":"old"}},{"path":"source.unknown","unit":{"line":50}}]}));
    assert_eq!(batch["status"],"partial");
    assert_eq!(batch["files"][0]["result"]["error"]["code"],"structure_continuation_unavailable");
}

#[test]
fn missing_search_paths_keep_other_paths_and_stale_continuations_report_the_file() {
    let mut f=Fixture::new();fs::write(f.root.join("work/a"),"needle\nneedle\nneedle\n").unwrap();
    let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=f.call("file_search",json!({"query":"needle","paths":["a","missing"]})) else {panic!("partial search lost results")};
    assert_eq!(content.data["status"],"partial");
    assert!(content.data["records"].as_array().unwrap().iter().any(|row|row["path"]=="missing" && row["data"]["status"]=="missing"));
    assert_eq!(content.data["records"].as_array().unwrap().iter().filter(|row|row["kind"]=="hit").count(),3);
    let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=f.call("file_search",json!({"query":"needle","maxResults":1})) else {panic!("first page failed")};
    fs::write(f.root.join("work/a"),"changed\nneedle\n").unwrap();
    let result=f.call("file_search",json!({"query":"needle","cursor":content.data["nextCursor"]}));
    assert!(serde_json::to_string(&result).unwrap().contains("Search continuation source changed: a"));
}

#[test]
fn search_scope_and_projections_keep_paths_matches_and_windows_distinct() {
    let mut f=Fixture::new();fs::create_dir(f.root.join("work/src")).unwrap();
    fs::write(f.root.join("work/src/a"),"intro\nalpha\nbeta\nend\n").unwrap();
    fs::write(f.root.join("work/elsewhere"),"alpha beta").unwrap();
    f.executor=f.executor.with_search_scope(Some(vec!["src".into()]));
    let run=|f:&mut Fixture,args|{let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=f.call("file_search",args) else {panic!("search failed")};content.data};
    let paths=run(&mut f,json!({"queries":["alpha","beta"],"format":"paths"}));
    assert_eq!(paths["records"].as_array().unwrap().len(),1);assert_eq!(paths["records"][0]["path"],"src/a");
    assert_eq!(paths["records"][0]["data"]["queryIndices"],json!([0,1]));
    assert_eq!(paths["scope"]["paths"],json!(["src"]));
    let windows=run(&mut f,json!({"queries":["alpha","beta"],"format":"windows","before":1,"after":1}));
    assert_eq!(windows["records"].as_array().unwrap().len(),1);
    assert_eq!(windows["records"][0]["data"]["lines"],json!(["intro","alpha","beta","end"]));
    assert_eq!(windows["records"][0]["data"]["matches"].as_array().unwrap().len(),2);
    assert!(f.try_call("file_read",json!({"path":"elsewhere"})).is_err());
    let batch=f.read(json!({"files":[{"path":"src/a"},{"path":"elsewhere"}]}));
    assert_eq!(batch["status"],"partial");assert_eq!(batch["files"][1]["result"]["status"],"failed");
}

#[test]
fn file_write_creates_without_a_read_and_keeps_existing_content_on_an_unversioned_retry() {
    let mut f=Fixture::new();
    assert!(matches!(f.call("file_write",json!({"path":"new.txt","content":"中文🙂"})),
        ToolCompletion::Result { outcome:Outcome::Succeeded,.. }));
    assert!(matches!(f.call("file_write",json!({"path":"new.txt","content":"overwritten"})),ToolCompletion::NotDispatched {..}));
    assert_eq!(fs::read_to_string(f.root.join("work/new.txt")).unwrap(),"中文🙂");
    let ToolCompletion::NotDispatched { error:Some(error), .. } = f.call("file_write",json!({"path":"new.txt","content":"overwritten","mode":"create"})) else { panic!("create must reject an existing file") };
    assert_eq!(error.code, "file_exists");
    assert!(error.details.unwrap().get("read").is_none());
    let missing = f.read(json!({"path":"missing.txt"}));
    let ToolCompletion::NotDispatched { error:Some(error), .. } = f.call("file_write",json!({"path":"missing.txt","content":"unexpected","mode":"replace","readVersion":missing["readVersion"]})) else { panic!("replace requires a file") };
    assert_eq!(error.code, "file_missing");
    assert!(!f.root.join("work/missing.txt").exists());
    fs::write(f.root.join("work/missing.txt"), "created concurrently").unwrap();
    assert!(matches!(f.call("file_write",json!({"path":"missing.txt","content":"unexpected","readVersion":missing["readVersion"]})),
        ToolCompletion::NotDispatched { .. }));
    let present = f.read(json!({"path":"missing.txt"}));
    assert!(matches!(f.call("file_write",json!({"path":"missing.txt","content":"unexpected","mode":"create","readVersion":present["readVersion"]})),
        ToolCompletion::NotDispatched { .. }));
    assert_eq!(fs::read_to_string(f.root.join("work/missing.txt")).unwrap(), "created concurrently");
}

#[test]
fn agent_file_read_pages_by_default_without_limiting_explicit_or_internal_reads() {
    let mut f = Fixture::new();
    let body = "中文🙂\n".repeat(12000);
    fs::write(f.root.join("work/body.txt"), &body).unwrap();
    let first = f.read(json!({"path":"body.txt"}));
    let mut text = first["content"]["text"].as_str().unwrap().to_string();
    assert_eq!(first["content"]["returnedBytes"], text.len());
    assert_eq!(first["content"]["byteLength"], body.len());
    // The byte target expands by at most three bytes to finish a UTF-8 character.
    assert!(text.len() <= 65536 + 3 && text.len() < body.len());
    let mut page = first.clone();
    while page["content"]["eof"] == false {
        let offset = page["content"]["nextOffset"].as_u64().unwrap();
        page = f.read(json!({"path":"body.txt","offset":offset}));
        assert_eq!(page["readVersion"], first["readVersion"]);
        assert!(page["content"]["eof"] == true || page["content"]["nextOffset"].as_u64().unwrap() > offset);
        text.push_str(page["content"]["text"].as_str().unwrap());
    }
    assert_eq!(page["content"]["eof"], true);
    assert_eq!(text, body);
    assert_eq!(f.read(json!({"path":"body.txt","length":body.len()}))["content"]["text"], body);
}

#[test]
fn healthcheck_file_contracts_keep_line_endings_and_distinguish_invalid_targets() {
    let mut f = Fixture::new();
    fs::create_dir_all(f.root.join("work/tree")).unwrap();
    fs::write(f.root.join("work/tree/crlf.txt"), "aaa\r\nbbb\r\nccc\r\n").unwrap();
    let original = f.read(json!({"path":"tree\\crlf.txt"}));
    let edited = f.call("file_edit", json!({"path":"tree\\crlf.txt","readVersion":original["readVersion"],
        "edits":[{"oldText":"aaa\r\nbbb","newText":"AAA\r\nBBB"}]}));
    let ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } = edited else { panic!("{edited:?}") };
    assert_eq!(content.data["state"]["kind"], "regular-file");
    assert!(content.data.get("stateJson").is_none());
    let edited = f.call("file_edit", json!({"path":"tree/crlf.txt","readVersion":content.data["readVersion"],
        "edits":[{"oldText":"AAA\nBBB","newText":"one\ntwo"}]}));
    assert!(matches!(edited, ToolCompletion::Result { outcome: Outcome::Succeeded, .. }));
    assert_eq!(fs::read_to_string(f.root.join("work/tree/crlf.txt")).unwrap(), "one\r\ntwo\r\nccc\r\n");
    assert!(matches!(f.call("file_read",json!({"path":"tree"})),
        ToolCompletion::Result { outcome: Outcome::Failed, content, .. } if content.data["error"]["code"] == "not_a_file"));
    let missing = f.call("file_list", json!({"paths":["tree/missing"]}));
    assert!(serde_json::to_string(&missing).unwrap().contains("Discovery path does not exist: tree/missing"));
    fs::write(f.root.join("work/tree/second.txt"), "second entry").unwrap();
    let small = f.call("file_list", json!({"paths":["tree"],"maxBytes":1}));
    let ToolCompletion::Result { content, .. } = small else { panic!("{small:?}") };
    assert_eq!(content.data["records"].as_array().unwrap().len(), 1);
    assert_eq!(content.data["records"][0]["path"],"tree/crlf.txt");
    assert!(content.data["scannedFiles"].as_u64().unwrap() >= 1);
    assert!(content.data["nextCursor"].is_string());
    let bad = f.try_call("file_list", json!({"cursor":"not-a-real-cursor"})).unwrap_err();
    assert_eq!(bad.code, "invalid_tool_arguments");
    let changed = f.try_call("file_list", json!({"paths":[""],"cursor":content.data["nextCursor"]})).unwrap_err();
    assert!(changed.message.contains("different filters or source"));
    let invalid = f.try_call("file_list", json!({"maxResults":0})).unwrap_err();
    assert!(invalid.to_string().contains("maxResults"));
    assert!(!invalid.to_string().contains("query"));
}

#[test]
fn filtered_zero_results_explain_their_scope_and_an_explicit_widening_finds_the_match() {
    let mut f = Fixture::new();
    fs::create_dir_all(f.root.join("work/node_modules/pkg")).unwrap();
    fs::write(f.root.join("work/node_modules/pkg/vendored.txt"), "unique_vendored_marker").unwrap();
    fs::write(f.root.join("work/own.txt"), "project text").unwrap();
    let filtered = f.call("file_search", json!({"query":"unique_vendored_marker"}));
    let ToolCompletion::Result { content, .. } = filtered else { panic!("{filtered:?}") };
    assert_eq!(content.data["records"].as_array().unwrap().len(), 0);
    assert_eq!(content.data["scanComplete"], true);
    let explanation = &content.data["emptyResult"];
    assert!(explanation["meaning"].as_str().unwrap().contains("does not show they lack a match"));
    assert_eq!(content.data["message"], explanation["meaning"]);
    let widen = explanation["widen"].as_array().unwrap();
    assert!(widen.iter().any(|item| item["argument"] == "excludeDirectories" && item["excluded"].as_array().unwrap().contains(&json!("node_modules"))));
    // The caller chooses the wider scope; the tool never rescans on its own.
    let widened = f.call("file_search", json!({"query":"unique_vendored_marker","excludeDirectories":[]}));
    let ToolCompletion::Result { content, .. } = widened else { panic!("{widened:?}") };
    assert_eq!(content.data["records"][0]["path"], "node_modules/pkg/vendored.txt");
    assert!(content.data.get("emptyResult").is_none());
}

#[test]
fn text_edits_can_read_existing_content_larger_than_a_response_frame_internally() {
    let mut f=Fixture::new();
    let mut body="x".repeat(crate::protocol::MAX_BLOB_RESPONSE_BYTES+1);
    body.push_str("END");
    fs::write(f.root.join("work/large.txt"),&body).unwrap();
    let version=f.read(json!({"path":"large.txt","length":1}))["readVersion"].clone();
    assert!(matches!(f.call("file_edit",json!({"path":"large.txt","readVersion":version,"edits":[{"oldText":"END","newText":"DONE"}]})),
        ToolCompletion::Result { outcome:Outcome::Succeeded,.. }));
    let content=fs::read_to_string(f.root.join("work/large.txt")).unwrap();
    assert_eq!(content.len(),body.len()+1);
    assert!(content.ends_with("DONE"));
}

#[test]
fn file_version_survives_a_new_run_while_write_permissions_and_conflicts_stay_enforced() {
    let mut f = Fixture::new();
    fs::write(f.root.join("work/body"), "unchanged").unwrap();
    let original = f.read(json!({"path":"body"}))["readVersion"].clone();
    f.next_run("next-run", &[""]);
    assert_eq!(
        f.read(json!({"path":"body","length":1}))["readVersion"],
        original
    );
    let args = json!({"path":"body","readVersion":original,"edits":[{"oldText":"unchanged","newText":"updated"}]});
    assert!(matches!(
        f.call("file_edit", args.clone()),
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            ..
        }
    ));
    assert_eq!(
        fs::read_to_string(f.root.join("work/body")).unwrap(),
        "updated"
    );
    assert!(matches!(
        f.call("file_edit", args),
        ToolCompletion::NotDispatched { .. }
    ));
    let current = f.read(json!({"path":"body"}))["readVersion"].clone();
    f.next_run("limited-run", &["other"]);
    assert!(f.try_call("file_edit",json!({"path":"body","readVersion":current,"edits":[{"oldText":"updated","newText":"forbidden"}]})).is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("work/body")).unwrap(),
        "updated"
    );
}

#[test]
fn missing_process_cwd_is_not_dispatched_and_following_reads_work() {
    let mut f = Fixture::new();
    assert!(matches!(
        f.call(
            "process_spawn",
            json!({"command":"unused-command","args":[],"mode":"pipe","cwd":"missing"})
        ),
        ToolCompletion::NotDispatched { .. }
    ));
    fs::write(f.root.join("work/body"), "still available").unwrap();
    assert_eq!(
        f.read(json!({"path":"body"}))["content"]["text"],
        "still available"
    );
}

#[test]
fn process_dot_cwd_resolves_before_launch_and_globs_filter_records_without_pruning_traversal() {
    let mut f = Fixture::new();
    for cwd in [".", "./", ".\\"] {
        let operation = ResourceOperation::parse(ToolKind::ProcessSpawn,
            &json!({"command":"unused-command","args":[],"env":[],"mode":"pipe","cwd":cwd})).unwrap();
        let ResourceOperation::ProcessSpawn(args) = operation else { unreachable!() };
        assert_eq!(args.cwd, "");
    }
    let ToolCompletion::NotDispatched { reason, .. } = f.call("process_spawn",
        json!({"command":"unused-command","args":[],"env":[],"mode":"pipe","cwd":"./missing"})) else { panic!("missing directory was dispatched"); };
    assert!(reason.contains("working directory") && !reason.contains("normalized"), "{reason}");
    fs::create_dir_all(f.root.join("work/docs/sub")).unwrap();
    assert_eq!(f.try_call("file_read",json!({"path":"."})).unwrap_err().code,"not_a_file");
    for path in ["README.md", "docs/notes.md", "docs/sub/last.md", "docs/other.txt"] {
        fs::write(f.root.join("work").join(path), "body").unwrap();
    }
    for (recursive, expected) in [(false, vec!["README.md"]), (true, vec!["README.md", "docs/notes.md", "docs/sub/last.md"])] {
        let ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } = f.call("file_list", json!({"paths":["./"],"globs":["*.md"],"recursive":recursive})) else { panic!("listing failed"); };
        let paths = content.data["records"].as_array().unwrap().iter().map(|r|r["path"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(paths, expected);
    }
}

#[test]
fn partial_utf8_read_has_the_full_file_version_and_advances_on_character_boundaries() {
    let mut f = Fixture::new();
    fs::write(f.root.join("work/body"), "第一🙂行\nnext").unwrap();
    let full = f.read(json!({"path":"body"}));
    let first = f.read(json!({"path":"body","offset":1,"length":1}));
    assert_eq!(first["content"]["text"], "第");
    assert_eq!(first["content"]["offset"], 0);
    assert_eq!(first["content"]["nextOffset"], 3);
    assert_eq!(first["readVersion"], full["readVersion"]);
    let next = f.read(json!({"path":"body","offset":3,"length":4}));
    assert_eq!(next["content"]["text"], "一🙂");
    assert_eq!(next["content"]["nextOffset"], 10);
    fs::write(f.root.join("work/body"), "第一🙂行\nchanged").unwrap();
    assert_ne!(
        f.read(json!({"path":"body","length":1}))["readVersion"],
        full["readVersion"]
    );
}

#[test]
fn line_reads_preserve_original_bytes_and_full_file_version() {
    let mut f = Fixture::new();
    let body = "first\r\n中文🙂\r\nlast\n";
    fs::write(f.root.join("work/body"), body).unwrap();
    let full = f.read(json!({"path":"body"}));
    let selected = f.read(json!({"path":"body","startLine":2,"endLine":2}));
    assert_eq!(selected["content"]["text"], "中文🙂\r\n");
    assert_eq!(selected["content"]["offset"], 7);
    assert_eq!(selected["content"]["nextOffset"], 19);
    assert_eq!(selected["content"]["nextLine"], 3);
    assert_eq!(selected["readVersion"], full["readVersion"]);
    let tail = f.read(json!({"path":"body","startLine":3}));
    assert_eq!(tail["content"]["text"], "last\n");
    assert_eq!(tail["content"]["eof"], true);
    let missing = f.read(json!({"path":"body","startLine":8,"endLine":9}));
    assert_eq!(missing["content"]["text"], "");
    assert_eq!(missing["content"]["offset"], body.len());
    for args in [json!({"path":"body","startLine":0}),json!({"path":"body","endLine":2}),
        json!({"path":"body","startLine":3,"endLine":2}),json!({"path":"body","startLine":1,"offset":0})] {
        assert!(f.try_call("file_read", args).is_err());
    }
    fs::write(f.root.join("work/body"), "changed\r\n中文🙂\r\nlast\n").unwrap();
    assert_ne!(f.read(json!({"path":"body","startLine":2,"endLine":2}))["readVersion"], full["readVersion"]);
}

#[test]
fn directory_pages_cover_the_remaining_paths_without_entering_excluded_copies() {
    let mut f = Fixture::new();
    fs::create_dir_all(f.root.join("work/a/sub")).unwrap();
    fs::create_dir_all(f.root.join("work/.worktrees/copy")).unwrap();
    for name in ["a/sub/file", "a.txt", "b", "z", ".worktrees/copy/hidden"] {
        fs::write(f.root.join("work").join(name), "needle").unwrap();
    }
    let mut cursor = None;
    let mut seen = Vec::new();
    loop {
        let mut args = json!({"recursive":true,"maxResults":2});
        if let Some(value) = &cursor {
            args["cursor"] = json!(value);
        }
        let ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            content,
            ..
        } = f.call("file_list", args)
        else {
            panic!("listing failed")
        };
        let result = content.data;
        for item in result["records"].as_array().unwrap() {
            assert!(item.get("revision").is_none());
            assert!(item["data"]["state"].get("objectHash").is_none());
            seen.push(item["path"].as_str().unwrap().to_string());
        }
        cursor = result["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
        assert!(seen.len() < 20, "cursor failed to advance");
    }
    assert_eq!(seen, ["a", "a/sub", "a/sub/file", "a.txt", "b", "z"]);
}

#[test]
fn explicit_paths_reach_dependencies_worktrees_and_ignored_files_without_filter_flags() {
    let mut f = Fixture::new();
    for dir in [".git", "node_modules/pkg/node_modules/nested", ".worktrees/copy", "build"] {
        fs::create_dir_all(f.root.join("work").join(dir)).unwrap();
    }
    fs::write(f.root.join("work/.gitignore"), "node_modules/\n.worktrees/\nbuild/\n*.log\n").unwrap();
    fs::write(f.root.join("work/build/.gitignore"), "skip.txt\n").unwrap();
    for path in ["source.txt", ".git/config", "node_modules/pkg/index.js", "node_modules/pkg/node_modules/nested/index.js",
        ".worktrees/copy/source.txt", "build/output.txt", "build/skip.txt", "debug.log"] {
        fs::write(f.root.join("work").join(path), "needle").unwrap();
    }
    let mut query = |name: &str, args: Value| {
        let ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } = f.call(name,args) else {panic!("query failed")};
        let mut paths=content.data["records"].as_array().unwrap().iter().map(|r|r["path"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        paths.sort();paths
    };
    assert_eq!(query("file_list",json!({})), [".git", ".gitignore", ".worktrees", "build", "debug.log", "node_modules", "source.txt"]);
    assert_eq!(query("file_search",json!({"query":"needle"})), ["source.txt"]);
    assert_eq!(query("file_search",json!({"query":"needle","paths":["node_modules/pkg",".worktrees/copy",".git/config","build","debug.log"]})),
        [".git/config", ".worktrees/copy/source.txt", "build/output.txt", "debug.log", "node_modules/pkg/index.js"]);
    assert_eq!(query("file_search",json!({"query":"needle","paths":["","node_modules/pkg"]})), ["node_modules/pkg/index.js", "source.txt"]);
    assert_eq!(query("file_list",json!({"paths":["node_modules/pkg"]})), ["node_modules/pkg/index.js", "node_modules/pkg/node_modules"]);
}

#[test]
fn multiple_listing_scopes_report_page_membership_without_claiming_unseen_roots_are_empty() {
    let mut f = Fixture::new();
    for dir in ["a", "empty", "z"] { fs::create_dir_all(f.root.join("work").join(dir)).unwrap(); }
    for name in ["a/one", "a/two", "z/last"] { fs::write(f.root.join("work").join(name), "content").unwrap(); }
    let read = |f: &mut Fixture, args| {
        let ToolCompletion::Result { outcome:Outcome::Succeeded, content, .. } = f.call("file_list", args) else { panic!("listing failed") };
        content.data
    };
    let page = read(&mut f, json!({"paths":["a","empty","z"],"maxResults":1}));
    assert!(page["nextCursor"].is_string());
    assert_eq!(page["groups"][0]["returnedEntries"], 1);
    assert_eq!(page["groups"][1]["status"], "no_entries_on_this_page");
    assert_eq!(page["groups"][2]["status"], "no_entries_on_this_page");
    let all = read(&mut f, json!({"paths":["a","empty","z"]}));
    assert_eq!(all["groups"][1]["status"], "empty");
    assert_eq!(all["groups"][2]["returnedEntries"], 1);
    for group in all["groups"].as_array().unwrap() {
        for index in group["recordIndices"].as_array().unwrap() {
            assert!(all["records"][index.as_u64().unwrap() as usize]["path"].as_str().unwrap().starts_with(group["path"].as_str().unwrap()));
        }
    }
}

#[test]
fn multiple_listing_scopes_share_pages_and_resume_without_duplicates_on_disk_and_tree() {
    for fixed in [false, true] {
        let mut f=Fixture::new();
        let mut expected=(0..9).map(|i|format!("a/{i:03}")).collect::<Vec<_>>();
        expected.extend(["a/sub/inside".into(),"z/000".into(),"z/001".into()]);
        for dir in ["a/sub","empty","z"] {fs::create_dir_all(f.root.join("work").join(dir)).unwrap();}
        for path in &expected {fs::write(f.root.join("work").join(path),"body").unwrap();}
        if fixed {
            let mut storage=f._storage.lock().unwrap();
            let mut invoke=|method:&str,params:Value| {
                let (grant,params)=storage.authorize(Some("actor"),EPOCH,HOST,GENERATION,method,&params).unwrap();
                storage.dispatch(method,&params,Some("actor"),&grant).unwrap()
            };
            invoke("storage.putBlob.begin",json!({"operationId":"list-blob","streamId":"list-body","workspaceId":"workspace","byteLength":4}));
            invoke("storage.putBlob.chunk",json!({"streamId":"list-body","sequence":0,"bytesBase64":BASE64.encode(b"body")}));
            let blob=invoke("storage.putBlob.finish",json!({"operationId":"list-blob","streamId":"list-body","workspaceId":"workspace"}));
            let mut entries=expected.iter().map(|path|json!({"path":path,"state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":4,"mode":420},"ownerId":blob["ownerId"]})).collect::<Vec<_>>();
            entries.push(json!({"path":"empty","state":{"kind":"directory","mode":493}}));
            invoke("branch.create.begin",json!({"operationId":"list-create","builderId":"list-builder","workspaceId":"workspace","branchId":"fixed","draftBasePaths":[],"captureScopes":[]}));
            invoke("branch.create.append",json!({"builderId":"list-builder","sequence":0,"entries":entries}));
            invoke("branch.create.finish",json!({"operationId":"list-create","builderId":"list-builder"}));
            f.executor.binding.source_mode=SourceMode::FixedBranch;
            f.executor.binding.root_id=None;f.executor.binding.live_root=None;
            f.executor.binding.file_source=Some(FixedFileSource{branch_id:"fixed".into(),revision:0});
        }
        let mut cursor=None;
        let mut seen=Vec::new();
        let mut page_number=0;
        loop {
            let mut args=json!({"paths":["a","empty","z","a","a/sub"],"maxResults":if page_number==0{3}else{1+page_number%3},"maxBytes":if page_number==0{65536}else{420}});
            if let Some(cursor)=&cursor {args["cursor"]=json!(cursor);}
            let ToolCompletion::Result{outcome:Outcome::Succeeded,content,..}=f.call("file_list",args) else {panic!("listing failed")};
            let paths=content.data["records"].as_array().unwrap().iter().map(|record|record["path"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
            if page_number==0 {assert_eq!(paths,["a/000","z/000","a/001"],"source fixed={fixed}");}
            seen.extend(paths);
            cursor=content.data["nextCursor"].as_str().map(str::to_owned);
            page_number+=1;
            if cursor.is_none(){break;}
            assert!(page_number<20,"listing did not advance");
        }
        seen.sort();expected.sort();
        assert_eq!(seen,expected,"source fixed={fixed}");
    }
}
