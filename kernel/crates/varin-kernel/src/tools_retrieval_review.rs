//! Focused adapter checks use the actual child directory, Storage grant and immutable reader.
use super::*;
use std::sync::Mutex;
const HOST: &str = "retrieval-source-review";
const GENERATION: &str = "generation";
const EPOCH: &str = "epoch";
struct Fixture {
    root: std::path::PathBuf,
    storage: Arc<Mutex<Storage>>,
    executor: Arc<KernelToolExecutor>,
    context: ToolExecutionContext,
    frozen: FrozenToolContext,
    call: ToolCall,
}
impl Fixture {
    fn new(bytes: &[u8]) -> Self {
        let root = std::env::temp_dir().join(format!("varin-source-adapter-{}", uuid::Uuid::new_v4()));
        let mut storage = Storage::open(&root, HOST).unwrap();
        for id in ["setup", "reader"] {
            storage.issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,
                "capabilities":if id == "setup" {vec!["storage.admin"]} else {vec!["storage.read"]},
                "pathScopes":["allowed"],"owningWorkspace":"workspace","executionWorkspace":"execution",
                "threadId":"thread","runId":"run"}), HOST, GENERATION, &root.to_string_lossy(), EPOCH).unwrap();
        }
        let mut invoke = |method: &str, params: Value| {
            let (grant, params) = storage.authorize(Some("setup"), EPOCH, HOST, GENERATION, method, &params).unwrap();
            storage.dispatch(method, &params, Some("setup"), &grant).unwrap()
        };
        invoke("storage.putBlob.begin", json!({"streamId":"source","operationId":"put","workspaceId":"workspace","byteLength":bytes.len()}));
        for (sequence, part) in bytes.chunks(64 * 1024).enumerate() {
            invoke("storage.putBlob.chunk", json!({"streamId":"source","sequence":sequence,"bytesBase64":BASE64.encode(part)}));
        }
        let blob = invoke("storage.putBlob.finish", json!({"streamId":"source","operationId":"put","workspaceId":"workspace"}));
        invoke("branch.create.begin", json!({"builderId":"create","operationId":"create","workspaceId":"workspace","branchId":"fixed","draftBasePaths":[],"captureScopes":[]}));
        invoke("branch.create.append", json!({"builderId":"create","sequence":0,"entries":[{"path":"allowed/source.ts","state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":bytes.len(),"mode":420},"ownerId":blob["ownerId"]}]}));
        invoke("branch.create.finish", json!({"builderId":"create","operationId":"create"}));
        let storage = Arc::new(Mutex::new(storage));
        let resources = KernelResourceClient::new({let storage = storage.clone(); move |request| {
            let result = serve_resource(&mut storage.lock().unwrap(), EPOCH, HOST, GENERATION, &request);
            request.reply.send(result).unwrap(); Ok(())
        }}, |_| Ok(()), Default::default());
        let binding: ToolBinding = serde_json::from_value(json!({"resourceOwner":{"kind":"local"},"grantId":"reader","runId":"run","threadId":"thread",
            "workspaceId":"workspace","executionWorkspaceId":"execution","sourceMode":"fixed_branch",
            "fileSource":{"branchId":"fixed","revision":0},"enabledTools":["code_retrieval"]})).unwrap();
        let schemas = crate::child_capabilities::select(&["code_retrieval".into()]).unwrap();
        let call = ToolCall {call_id:"retrieve".into(),name:schemas[0].name.clone(),schema_version:schemas[0].version.clone(),
            arguments:json!({"question":"tail marker","paths":["allowed"]})};
        let origin = ToolOrigin::PolicyAction { action_id:"policy".into(),node_id:"retrieve".into() };
        let context = execution_context("run", &call, &origin);
        let frozen = FrozenToolContext {run_id:"run".into(),origin,tools:Arc::new(schemas),tool_schema_generation:1,
            source:Some(binding.source_selection().unwrap()),child_dispatch:None,resource_activations:vec![],resource_checkpoint_id:None};
        let executor = Arc::new(KernelToolExecutor::new(binding, resources).unwrap());
        Self {root,storage,executor,context,frozen,call}
    }
    fn cleanup(self) { let root = self.root.clone(); drop(self); std::fs::remove_dir_all(root).unwrap(); }
}
#[test]
fn child_retrieval_policy_read_requires_exact_frozen_source_and_original_grant() {
    let f = Fixture::new(b"export const marker = true;\n");
    let directory = Arc::new(varin_runtime::composition::tools::ToolDirectory::assemble(
        KernelToolExecutor::new(f.executor.binding.clone(), f.executor.resources.clone()).unwrap().declarations(false)).unwrap());
    let cancel = CancellationToken::default();
    let bound = directory.clone().bind_call(&f.call, &f.frozen, &cancel).unwrap();
    let contract = bound.prepare(&cancel).unwrap();
    assert!(bound.supports_policy_read(&contract));
    bound.authorize(&f.context, &contract, &cancel).unwrap();
    for changed in ["revision", "branch", "workspace", "execution", "physical"] {
        let mut frozen = f.frozen.clone();
        let source = frozen.source.as_mut().unwrap();
        match changed {
            "revision" => source.revision = Some(1),
            "branch" => source.branch_id = Some("other".into()),
            "workspace" => source.workspace_id = "other".into(),
            "execution" => source.execution_workspace_id = "other".into(),
            _ => source.mode = SourceMode::Materialized,
        }
        assert!(!directory.clone().bind_call(&f.call, &frozen, &cancel).unwrap().supports_policy_read(&contract), "{changed}");
    }
    let mut mutable = contract.clone(); mutable.read_only = false;
    assert!(!bound.supports_policy_read(&mutable));
    f.storage.lock().unwrap().revoke_grant(&json!({"grantId":"reader"}), HOST).unwrap();
    assert!(bound.authorize(&f.context, &contract, &cancel).is_err());
    drop(bound); drop(directory); f.cleanup();
}
#[test]
fn fixed_final_observation_reads_past_one_wire_frame_through_original_blob_pages() {
    let mut bytes = vec![b'a'; crate::protocol::MAX_BLOB_RESPONSE_BYTES + 17];
    bytes.splice(0..3, [0xef, 0xbb, 0xbf]);
    bytes.extend_from_slice("\nexport const tail = '原始';\r\n".as_bytes());
    let f = Fixture::new(&bytes);
    let observed = f.executor.observe_source_path(&f.context, "allowed/source.ts", &CancellationToken::default()).unwrap();
    assert_eq!(observed.text.as_bytes(), &bytes[3..]);
    assert!(observed.text.contains("tail = '原始'"));
    assert!(f.executor.observe_source_path(&f.context, "private/secret.ts", &CancellationToken::default()).is_err());
    f.cleanup();
}

#[test]
fn narrow_source_grant_reads_fixed_input_but_rejects_language_before_host_preparation() {
    let text = "export const main = 1;\n";
    let f = Fixture::new(text.as_bytes());
    let cancel = CancellationToken::default();
    // This is the actual immutable FileRead/blob reader under the path-scoped Run grant.
    let observed = f
        .executor
        .observe_source_path(&f.context, "allowed/source.ts", &cancel)
        .unwrap();
    assert_eq!(observed.text, text);
    let args = LanguageQueryArgs::parse(
        ToolKind::LanguageDefinition,
        &json!({"path":"allowed/source.ts","line":0,"character":13}),
    )
    .unwrap();
    let failure = f
        .executor
        .resources
        .call(
            &f.executor.binding,
            &f.context,
            ResourceOperation::LanguageQuery(args),
            true,
            &cancel,
        )
        .unwrap_err();
    assert!(matches!(failure.error, KernelError::Authorization(_)));
    assert!(
        !failure.dispatched,
        "language input admission must fail before Host service preparation"
    );
    assert!(failure
        .error
        .to_string()
        .contains("whole-project read grant"));
    {
        let mut storage = f.storage.lock().unwrap();
        let (grant, params) = storage
            .authorize(
                Some("setup"),
                EPOCH,
                HOST,
                GENERATION,
                "storage.record.list",
                &json!({"workspaceId":"workspace","recordType":"file.materialized-view"}),
            )
            .unwrap();
        let records = storage
            .dispatch("storage.record.list", &params, Some("setup"), &grant)
            .unwrap();
        assert_eq!(records["records"], json!([]));
    }
    f.cleanup();
}
