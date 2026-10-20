//! Real RunAssembly, file tools, input journal and successor RequestSnapshot; no transport listener.
use crate::{
    error::KernelError,
    run_assembly::{PreparedLaunch, RunAssembly, RunPreparation},
    storage::Storage,
    tools::{KernelResourceClient, ResourceWork, finish_resource_blob_read, prepare_resource},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, mpsc};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunSupervisor;
use varin_runtime::{Catalog, Outcome, RunState, SubmitInput};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;
struct Model {
    write: bool,
    wires: Arc<Mutex<Vec<Value>>>,
    catalog: Arc<Mutex<Catalog>>,
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView, reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        use varin_runtime::providers::{
            Connection, EnvironmentCredentialResolver, ReqwestTransport,
        };
        let provider =
            varin_runtime::providers::responses::ResponsesProvider::new(Connection::new(
                "https://controlled.invalid/responses",
                Arc::new(EnvironmentCredentialResolver::default()),
                Arc::new(ReqwestTransport::default()),
            ));
        let wire = provider.serialize(view, reuse)?;
        self.wires
            .lock()
            .unwrap()
            .push(json!({"run":view.run_id,"wire":wire}));
        Ok(wire)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        if !self.write {
            return Ok(FinishReason::Stop);
        }
        let later = request
            .view
            .history
            .iter()
            .any(|item| matches!(&item.content,Content::Text{text} if text=="LATER_INPUT"));
        let read_id = if later { "read2" } else { "read" };
        let write_id = if later { "write2" } else { "write" };
        let mut version = None;
        for item in &request.view.history {
            if let Content::ToolResult { result } = &item.content {
                if result.call_id == write_id {
                    for (id, args) in [
                        (format!("{write_id}-points"), json!({})),
                        (format!("{write_id}-before"), json!({"point":"current:before"})),
                    ] {
                        if let Some(completion) = request.view.history.iter().find_map(|item| match &item.content {
                            Content::ToolResult { result } if result.call_id == id => Some(&result.completion),
                            _ => None,
                        }) {
                            assert!(matches!(completion, ToolCompletion::Result { outcome: Outcome::Succeeded, .. }), "{completion:?}");
                        } else {
                            let schema = request.view.binding.tools.iter().find(|tool| tool.name == "recovery_points").unwrap();
                            emit(ProviderEvent::ItemCompleted { item: ProviderItem {
                                id: id.clone(), opaque: None,
                                content: Content::ToolCall { call: ToolCall {
                                    call_id: id, name: schema.name.clone(), schema_version: schema.version.clone(), arguments: args,
                                }},
                            }}).unwrap();
                            return Ok(FinishReason::ToolCalls);
                        }
                    }
                    if !later {
                        self.catalog
                            .lock()
                            .unwrap()
                            .enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
                                key: "later-input".into(),
                                thread_id: "thread".into(),
                                branch_id: "main".into(),
                                mode: varin_runtime::InputMode::Boundary,
                                input: json!({"text":"LATER_INPUT"}),
                                configuration: None,
                            })
                            .unwrap();
                    }
                    return Ok(FinishReason::Stop);
                }
                if result.call_id == read_id {
                    if let ToolCompletion::Result { content, .. } = &result.completion {
                        version = content.data["readVersion"].as_str().map(str::to_owned);
                    }
                }
            }
        }
        let (id, name, args) = if let Some(version) = version {
            (
                write_id,
                "file_write",
                json!({"path":"a.txt","readVersion":version,"content":if later {"C"}else{"B"}}),
            )
        } else {
            (read_id, "file_read", json!({"path":"a.txt"}))
        };
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: id.into(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: id.into(),
                        name: name.into(),
                        schema_version: schema.version.clone(),
                        arguments: args,
                    },
                },
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
#[test]
fn assembled_tool_journal_and_explicit_successor_use_the_selected_ancestry() {
    let root = std::env::temp_dir().join(format!("thread-recovery-{}", uuid::Uuid::new_v4()));
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("a.txt"), "A").unwrap();
    let mut catalog = Catalog::open(root.join("runtime")).unwrap();
    catalog.create_thread("thread", "main").unwrap();
    let runtime = Arc::new(RunSupervisor::new(catalog));
    let storage = Arc::new(Mutex::new(
        Storage::open(&root.join("storage"), "host").unwrap(),
    ));
    let storage_for_call = storage.clone();
    let resources = KernelResourceClient::new(
        move |call| {
            let work = prepare_resource(
                &mut storage_for_call.lock().unwrap(),
                "epoch",
                "host",
                "generation",
                &call,
            );
            let result = match work {
                Ok(ResourceWork::Ready(value)) => Ok(value),
                Ok(ResourceWork::BlobRead(task)) => {
                    let body = task.run();
                    finish_resource_blob_read(
                        &mut storage_for_call.lock().unwrap(),
                        "epoch",
                        "host",
                        "generation",
                        &call,
                        &task,
                        body,
                    )
                }
                Err(error) => Err(error),
            };
            call.reply
                .send(result)
                .map_err(|_| KernelError::Operation("fixture reply closed".into()))
        },
        |_| Ok(()),
        Default::default(),
    );
    let (output, frames) = mpsc::sync_channel(256);
    let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
    credentials.initialize("epoch").unwrap();
    let bridge = crate::host_tools::ToolBridge::new(output.clone().into());
    bridge.initialize("epoch");
    let policy = crate::policy::PolicyBridge::new(output.clone());
    policy.initialize("epoch");
    policy.set_catalog(runtime.catalog());
    let assembly = RunAssembly {
        runtime: runtime.clone(),
        resources,
        credentials: credentials.clone(),
        language: crate::language::LanguageBridge::new(output.clone()),
        retrieval: crate::retrieval::RetrievalBridge::new(output.clone()),
        memory: crate::host_query::OwnerChannel::new("memory", output.clone()),
        context: crate::host_query::OwnerChannel::new("context", output.clone()),
        resource: crate::host_query::OwnerChannel::new("resource", output.clone()),
        plan: crate::plan_bridge::PlanBridge::new(output.clone()),
        policy,
        models: crate::run_models::RunModels::new(runtime.catalog(), credentials),
        tools: crate::run_tools::RunTools::new(runtime.catalog(), bridge),
        responses: output.into(),
        epoch: "epoch".into(),
    };
    assembly.memory.initialize("epoch");
    assembly.context.initialize("epoch");
    assembly.resource.initialize("epoch");
    let context = assembly.context.clone();
    let host = std::thread::spawn(move || {
        for frame in frames {
            if frame["kind"] == "context-request" {
                assert_eq!(frame["query"]["action"], "prepare");
                context.receive(json!({"v":1,"kind":"context-response","id":frame["id"],
                    "kernelEpoch":frame["kernelEpoch"],"result":{"status":"ready"}}));
            }
        }
    });
    let wires = Arc::new(Mutex::new(Vec::new()));
    let config = json!({"providerFamily":"openai-responses","model":"controlled","endpoint":"https://controlled.invalid/responses","allowAnonymous":true,"configurationGeneration":1});
    let launch = |text: &str, write: bool| {
        let owner = runtime.catalog();
        let mut db = owner.lock().unwrap();
        let expected = db.head("main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: text.into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: expected,
                input: json!({"text":text}),
                configuration: config.clone(),
            })
            .unwrap();
        let run = db.run(&receipt.run_id).unwrap();
        drop(db);
        let grant_id = format!("actor:{}", run.id);
        let mut store = storage.lock().unwrap();
        let identity = root.join("storage").to_string_lossy().to_string();
        store.issue_grant(&json!({"grantId":grant_id,"hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":run.id,"pathScopes":[""],"capabilities":["storage.read","storage.write","recovery"]}),"host","generation",&identity,"epoch").unwrap();
        let args = json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":workspace});
        let (grant, args) = store
            .authorize(
                Some(&grant_id),
                "epoch",
                "host",
                "generation",
                "file.root.register",
                &args,
            )
            .unwrap();
        let registered = store
            .dispatch("file.root.register", &args, Some(&grant_id), &grant)
            .unwrap();
        drop(store);
        let params=serde_json::from_value(json!({"runId":run.id,"toolBinding":{"resourceOwner":{"kind":"local"},"grantId":grant_id,"runId":run.id,"threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace","sourceMode":"live_root","rootId":registered["rootId"],"liveRoot":{"hostId":"host","canonicalRoot":workspace,"rootId":registered["rootId"]},"enabledTools":["file_read","file_write","recovery_points"]}})).unwrap();
        let PreparedLaunch::Start(mut start) = assembly
            .prepare(RunPreparation::new(params, &run).unwrap(), None, || false)
            .unwrap()
        else {
            panic!("expected start")
        };
        start.provider = Arc::new(Model {
            write,
            wires: wires.clone(),
            catalog: runtime.catalog(),
        });
        let handle = runtime.start(&run.id, start).unwrap();
        assert_eq!(handle.wait().unwrap().state, RunState::Completed);
        runtime.reap().unwrap();
        receipt
    };
    let first = launch("FUTURE_ONLY", true);
    assert_eq!(
        std::fs::read_to_string(workspace.join("a.txt")).unwrap(),
        "C"
    );
    let owner = runtime.catalog();
    let mut db = owner.lock().unwrap();
    let range = db
        .capture_recovery_range("thread", "main", &first.input_id)
        .unwrap();
    drop(db);
    let range = range.load().unwrap();
    assert_eq!(range.len(), 2);
    assert!(range.iter().all(|turn| !turn.uncovered));
    assert_eq!(range[0].anchor.run_id, range[1].anchor.run_id);
    assert_ne!(range[0].anchor.execution_id, range[1].anchor.execution_id);
    let mut store = storage.lock().unwrap();
    let actor = format!("actor:{}", first.run_id);
    let args = json!({"workspaceId":"workspace","executionId":range[0].anchor.execution_id});
    let (grant, args) = store
        .authorize(
            Some(&actor),
            "epoch",
            "host",
            "generation",
            "recovery.turn.get",
            &args,
        )
        .unwrap();
    let turn = store
        .dispatch("recovery.turn.get", &args, Some(&actor), &grant)
        .unwrap();
    let args = json!({"workspaceId":"workspace","executionId":range[1].anchor.execution_id});
    let (grant, args) = store
        .authorize(
            Some(&actor),
            "epoch",
            "host",
            "generation",
            "recovery.turn.get",
            &args,
        )
        .unwrap();
    let later_turn = store
        .dispatch("recovery.turn.get", &args, Some(&actor), &grant)
        .unwrap();
    assert_eq!(later_turn["userEntryId"], range[1].anchor.entry_id);
    assert_ne!(turn["checkpointId"], later_turn["checkpointId"]);
    drop(store);
    assert_eq!(turn["userEntryId"], first.input_id);
    assert_eq!(turn["conversation"]["kind"], "thread");
    let mut db = owner.lock().unwrap();
    let command = varin_runtime::catalog::navigation::NavigationCommand {
        key: "rewind".into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        expected_head_id: db.head("main").unwrap(),
        target_head_id: None,
        undo_of: None,
    };
    let preparation = db.prepare_navigation(command).unwrap();
    drop(db);
    let prepared = preparation.load().unwrap();
    owner.lock().unwrap().commit_navigation(prepared).unwrap();
    let original = owner.lock().unwrap().capture_run_recovery(&first.run_id).unwrap();
    let original = original.load().unwrap();
    assert_eq!(original.len(), 2);
    assert!(original.iter().all(|turn| turn.settled));
    assert_eq!(original[0].anchor.execution_id, range[0].anchor.execution_id);
    assert_eq!(original[1].entry_ids, range[1].entry_ids);
    let labels=owner.lock().unwrap().capture_recovery_labels("thread",vec![first.run_id.clone()]);
    assert_eq!(labels.load(&||false).unwrap()[&first.run_id],"FUTURE_ONLY");
    let second = launch("NEW_ONLY", false);
    let serialized = serde_json::to_string(
        &wires
            .lock()
            .unwrap()
            .iter()
            .filter(|value| value["run"] == second.run_id)
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(serialized.contains("NEW_ONLY"));
    assert!(!serialized.contains("FUTURE_ONLY"));
    assert!(!serialized.contains("LATER_INPUT"));
    assert_eq!(
        owner.lock().unwrap().run(&first.run_id).unwrap().state,
        RunState::Completed
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("a.txt")).unwrap(),
        "C"
    );
    assembly.context.close();
    drop(assembly);
    drop(runtime);
    drop(storage);
    drop(owner);
    host.join().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
