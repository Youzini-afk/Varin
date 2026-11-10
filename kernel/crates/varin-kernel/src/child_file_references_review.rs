//! Frozen child contracts consume actual Storage observations after Catalog reopen.
use super::*;
use crate::storage::Storage;
use crate::tools::{serve_resource, KernelResourceClient, KernelToolExecutor, ToolBinding, ToolKind};
use std::{collections::BTreeSet, fs};
use varin_runtime::catalog::{collaboration::ChildSourceHandoff, dispatch::ChildWorkMode};

const HOST: &str = "child-file-contract-host";
const GENERATION: &str = "child-file-contract-generation";

fn file_schemas(legacy: bool) -> Vec<ToolSchema> {
    if legacy {
        // Exact native declarations from f81c03c87d31972146b3da01dd8dbcd700b9469c:
        // tools.rs, tools_read.rs and text.rs. Never derive old parameters by merely
        // changing today's version; v1 write/edit did not declare a ref argument.
        serde_json::from_str(include_str!("fixtures/native_file_v1.json")).unwrap()
    } else {
        KernelToolExecutor::selected_schemas(&BTreeSet::from([
            ToolKind::FileRead, ToolKind::FileWrite, ToolKind::FileEdit,
        ]))
    }
}

fn file_child(mut schemas: Vec<ToolSchema>, root: &std::path::Path) -> (Fixture, Arc<Mutex<Storage>>) {
    schemas.sort_by(|a, b| a.name.cmp(&b.name));
    fs::create_dir_all(root.join("work")).unwrap();
    let store = root.join("storage");
    let mut storage = Storage::open(&store, HOST).unwrap();
    storage.issue_grant(&json!({"grantId":"setup","hostGeneration":GENERATION,
        "capabilities":["storage.read","storage.write"],"pathScopes":[""],
        "owningWorkspace":"workspace-A","executionWorkspace":"workspace-A","threadId":"thread:parent"}),
        HOST, GENERATION, &store.to_string_lossy(), EPOCH).unwrap();
    let (grant, params) = storage.authorize(Some("setup"), EPOCH, HOST, GENERATION,
        "file.root.register", &json!({"workspaceId":"workspace-A","executionWorkspaceId":"workspace-A",
            "canonicalRoot":root.join("work")})).unwrap();
    let registered = storage.dispatch("file.root.register", &params, Some("setup"), &grant).unwrap();
    let mut binding: ToolBinding = serde_json::from_value(json!({"resourceOwner":{"kind":"local"},
        "grantId":"parent-files","runId":"pending","threadId":"thread:parent",
        "workspaceId":"workspace-A","executionWorkspaceId":"workspace-A","sourceMode":"live_root",
        "rootId":registered["rootId"],"liveRoot":{"hostId":HOST,"rootId":registered["rootId"],
            "canonicalRoot":registered["canonicalRoot"]},"enabledTools":["file_read","file_write","file_edit"]})).unwrap();
    let source = binding.source_selection().unwrap();
    let read = schemas.iter().find(|schema| schema.name == "file_read").unwrap().clone();
    let native = schemas.clone();
    let parent_source = source.clone();
    let mut parent = dispatch::Fixture::new_parent_custom(0, read,
        crate::collaboration::schemas(Vec::new()).into_iter().find(|schema| schema.name == "dispatch").unwrap(),
        false, false, false, move |input, launch| {
            input.work_mode = Some(ChildWorkMode::Shared);
            input.tools = Some(native.iter().map(|schema| schema.name.clone()).collect());
            launch.tools.retain(|schema| schema.name != "file_read");
            launch.tools.extend(native);
            launch.source = Some(parent_source);
        });
    binding.run_id = parent.context.run_id.clone();
    storage.issue_grant(&json!({"grantId":binding.grant_id,"hostGeneration":GENERATION,
        "capabilities":["storage.read","storage.write"],"pathScopes":[""],
        "owningWorkspace":"workspace-A","executionWorkspace":"workspace-A",
        "threadId":binding.thread_id,"runId":binding.run_id}),
        HOST, GENERATION, &store.to_string_lossy(), EPOCH).unwrap();
    let selection = parent.db.capture_child_dispatch_invocation(&parent.context).unwrap().load().unwrap()
        .resolve(&parent.input).unwrap();
    let (grant, _) = storage.authorize(Some(&binding.grant_id), EPOCH, HOST, GENERATION,
        "storage.health", &json!({"workspaceId":"workspace-A"})).unwrap();
    let handoff: ChildSourceHandoff = serde_json::from_value(storage.child_source_handoff(
        &binding, &parent.context, &selection.source_delegation(), &grant, HOST, false).unwrap()).unwrap();
    parent.launch.tools = schemas;
    parent.launch.policy = crate::observations::default_policy_identity();
    let launch = parent.db.prepare_child_launch(&parent.context.run_id, parent.launch.clone(), selection)
        .unwrap().load().unwrap();
    let admission = parent.db.prepare_child_admission(&parent.context, parent.input.clone(), Some(handoff.clone()), launch)
        .unwrap().load().unwrap();
    let child = parent.db.accept_child_references(admission).unwrap();
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: "child-file-context".into(), branch_id: child.child_branch_id.clone(), through_id: None,
        expected_revision: 0, summary: String::new(), effective_system_prompt: "Edit the admitted shared file".into(),
        instruction_sources: vec![], memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"child-file-contract","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Edit the admitted shared file"}],"instructionSources":[]})).unwrap();
    let child = parent.db.prepare_child(&child.operation_id, source.clone(), proposal, basis).unwrap();
    let run = parent.db.run(&child.receipt.as_ref().unwrap().run_id).unwrap();
    let original = parent.db.launch_intent(&run.id).unwrap().unwrap().selection;
    assert_eq!(original.source.as_ref(), Some(&source));
    // The trusted resource owner claims the actual handoff before issuing the new
    // Run grant. No parent credential or unadmitted source is reused for execution.
    storage.claim_child_handoff(&json!({"grantId":"child-file-preparation","childThreadId":run.thread_id}),
        &handoff, HOST, GENERATION, &store.to_string_lossy(), EPOCH).unwrap();
    storage.issue_grant(&json!({"grantId":"child-source-grant","hostGeneration":GENERATION,
        "capabilities":["storage.read","storage.write"],"pathScopes":[""],
        "owningWorkspace":"workspace-A","executionWorkspace":"workspace-A",
        "threadId":run.thread_id,"runId":run.id}), HOST, GENERATION, &store.to_string_lossy(), EPOCH).unwrap();
    binding.grant_id = "child-source-grant".into();
    binding.run_id = run.id.clone();
    binding.thread_id = run.thread_id.clone();
    let params = json!({"runId":run.id,"credentialScope":original.credential_scope,"toolBinding":binding});
    let f = Fixture::from_catalog(parent.root, child, run, original, params, parent.db).reopen();
    (f, Arc::new(Mutex::new(storage)))
}

struct FileRoundtrip {
    legacy: bool,
    schemas: Vec<ToolSchema>,
    calls: Arc<Mutex<Vec<ToolCall>>>,
    next: AtomicUsize,
}
impl ModelProvider for FileRoundtrip {
    fn serialize(&self, view: &RequestView, _: Option<&mut varin_runtime::execution::RequestCompileReuse>)
        -> Result<varin_runtime::execution::RequestBody, ExecutionError>
    {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(&self, request: &RequestSnapshot, _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>) -> Result<FinishReason, ModelFailure>
    {
        for original in &self.schemas {
            assert!(request.view.binding.tools.contains(original), "the model must see the originally admitted schema");
        }
        let result = |step: usize| {
            request.view.history.iter().find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == format!("file-contract-{step}") => Some(&result.completion),
                _ => None,
            }).expect("previous model call must have a persisted result")
        };
        let observed = |step| {
            let ToolCompletion::Result { outcome: Outcome::Succeeded, content, .. } = result(step) else {
                panic!("file observation must succeed: {:?}", result(step))
            };
            let visible = content.model_data();
            if self.legacy {
                assert_eq!(visible, &content.data);
                assert!(visible["readVersion"].is_string());
                assert!(visible.get("ref").is_none());
            } else {
                assert!(visible["ref"].as_str().unwrap().starts_with("file:"));
                assert!(visible.get("readVersion").is_none());
                assert!(content.data["readVersion"].is_string(), "raw facts remain available to their owner");
            }
            visible
        };
        let step = self.next.fetch_add(1, Ordering::SeqCst);
        let (name, arguments) = match step {
            0 => ("file_read", json!({"path":"body.txt"})),
            1 | 2 | 3 => {
                let previous = observed(if step == 2 { 1 } else { 0 });
                let mut args = if self.legacy {
                    let format = if step == 2 { &previous["format"] } else { &previous["content"]["format"] };
                    assert_eq!(format["encoding"], "utf-16le");
                    json!({"path":previous["path"],"readVersion":previous["readVersion"],"sourceFormat":format})
                } else {
                    json!({"ref":previous["ref"]})
                };
                if step == 1 {
                    args["edits"] = json!([{"oldText":"first","newText":"second"}]);
                    ("file_edit", args)
                } else {
                    args["content"] = json!(if step == 2 { "third\r\n" } else { "stale overwrite\r\n" });
                    ("file_write", args)
                }
            }
            4 => {
                observed(2);
                assert!(matches!(result(3), ToolCompletion::NotDispatched { .. }), "stale CAS must not dispatch");
                emit(ProviderEvent::ItemCompleted { item: ProviderItem { id: request.view.request_id.clone(),
                    opaque: None, content: Content::Text { text: "The original file contract roundtrip is complete".into() } } }).unwrap();
                return Ok(FinishReason::Stop);
            }
            _ => panic!("unexpected model step"),
        };
        let schema = self.schemas.iter().find(|schema| schema.name == name).unwrap();
        if self.legacy && name != "file_read" {
            let properties = schema.schema["properties"].as_object().unwrap();
            assert!(!properties.contains_key("ref"));
            assert_eq!(schema.schema["additionalProperties"], false);
            for field in arguments.as_object().unwrap().keys() { assert!(properties.contains_key(field)); }
            for field in schema.schema["required"].as_array().unwrap() {
                assert!(arguments.get(field.as_str().unwrap()).is_some());
            }
        }
        let call = ToolCall { call_id: format!("file-contract-{step}"), name: name.into(),
            schema_version: schema.version.clone(), arguments };
        self.calls.lock().unwrap().push(call.clone());
        emit(ProviderEvent::ItemCompleted { item: ProviderItem { id: request.view.request_id.clone(),
            opaque: None, content: Content::ToolCall { call } } }).unwrap();
        Ok(FinishReason::ToolCalls)
    }
}

#[test]
fn frozen_child_file_contracts_roundtrip_real_versions_after_reopen() {
    for legacy in [true, false] {
        let root = std::env::temp_dir().join(format!("varin-child-file-contract-{}", uuid::Uuid::new_v4()));
        let schemas = file_schemas(legacy);
        let (mut f, storage) = file_child(schemas.clone(), &root);
        let utf16 = |text: &str| [vec![0xff, 0xfe], text.encode_utf16().flat_map(u16::to_le_bytes).collect()].concat();
        fs::write(root.join("work/body.txt"), utf16("first\r\n")).unwrap();
        let owner = storage.clone();
        let expected_source = f.original.source.clone().unwrap();
        let expected_run = f.run.id.clone();
        let expected_thread = f.run.thread_id.clone();
        f.assembly.resources = KernelResourceClient::new(move |request| {
            assert_eq!(request.binding.run_id, expected_run);
            assert_eq!(request.binding.thread_id, expected_thread);
            assert_eq!(request.binding.grant_id, "child-source-grant");
            assert_eq!(request.binding.source_selection().unwrap(), expected_source);
            let result = serve_resource(&mut owner.lock().unwrap(), EPOCH, HOST, GENERATION, &request);
            request.reply.send(result).unwrap();
            Ok(())
        }, |_| Ok(()), Default::default());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let model = Arc::new(FileRoundtrip { legacy, schemas, calls: calls.clone(), next: AtomicUsize::new(0) });
        // The common driver uses this only for the expected call count in model mode.
        let count = vec![ToolCall { call_id: String::new(), name: String::new(),
            schema_version: String::new(), arguments: Value::Null }; 4];
        execute_with_provider(&f, true, count, &mut OwnerReplies::default(), false, model);
        assert_eq!(fs::read(root.join("work/body.txt")).unwrap(), utf16("third\r\n"));
        let f = f.reopen();
        let catalog = f.catalog();
        let db = catalog.lock().unwrap();
        let history: Vec<ConversationItem> = db.history(&f.run.branch_id).unwrap().into_iter()
            .filter_map(|item| serde_json::from_value(item.content).ok()).collect();
        for original in calls.lock().unwrap().iter() {
            assert!(history.iter().any(|item| matches!(&item.content, Content::ToolCall { call } if call == original)));
        }
        let launch = db.launch_intent(&f.run.id).unwrap().unwrap().selection;
        assert_eq!(launch.tools, f.original.tools);
        assert_eq!(launch.source, f.original.source);
        drop(db);
        drop(catalog);
        f.finish();
        drop(storage);
        fs::remove_dir_all(root).unwrap();
    }
}
