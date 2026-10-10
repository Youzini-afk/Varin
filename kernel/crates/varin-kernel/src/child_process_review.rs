//! Actual child/recursive dispatch and guardian writers outlive model reports. No provider I/O.
use super::*;
use crate::storage::Storage;
use crate::tools::{
    serve_resource, FixedFileSource, KernelResourceClient, KernelToolExecutor, ToolBinding,
    ToolKind,
};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
use varin_runtime::{
    catalog::{collaboration::*, dispatch::*, launches::LaunchSelection},
    execution::*,
    ExecutorOwner, RunState, SourceMode,
};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;
const HOST: &str = "child-process-host";
const GENERATION: &str = "child-process-generation";
const EPOCH: &str = "child-process-epoch";

struct Node {
    operation: Option<String>,
    binding: ToolBinding,
    cwd: PathBuf,
}
struct Harness {
    root: PathBuf,
    runtime: Arc<RunSupervisor>,
    storage: Arc<Mutex<Option<Storage>>>,
    resources: KernelResourceClient,
    terminals: mpsc::Receiver<crate::process::ProcessTerminal>,
    controls: control_commands::ControlCommands,
    sequence: usize,
}
impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(storage) = self
            .storage
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_mut()
        {
            let _ = storage.shutdown_processes();
        }
    }
}
impl Harness {
    fn invoke(&self, actor: &str, method: &str, params: Value) -> Value {
        let mut lock = self.storage.lock().unwrap();
        let storage = lock.as_mut().unwrap();
        let (grant, params) = storage
            .authorize(Some(actor), EPOCH, HOST, GENERATION, method, &params)
            .unwrap_or_else(|e| panic!("{method} authorization: {e}"));
        storage
            .dispatch(method, &params, Some(actor), &grant)
            .unwrap_or_else(|e| panic!("{method}: {e}"))
    }
    fn issue(&self, id: &str, thread: &str, run: &str, process: bool) {
        let caps = if process {
            vec!["storage.read", "storage.write", "process"]
        } else {
            vec!["storage.read", "storage.write"]
        };
        self.storage.lock().unwrap().as_mut().unwrap().issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,
            "capabilities":caps,"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":thread,"runId":run}),
            HOST, GENERATION, &self.root.join("storage").to_string_lossy(), EPOCH).unwrap();
    }
    fn record(&self, run: &str, value: ExecutionRecord) {
        let owner = self.runtime.catalog();
        let mut db = owner.lock().unwrap();
        let epoch = db.epoch();
        db.commit_execution(run, epoch, &value).unwrap();
    }
    fn request(
        &mut self,
        node: &Node,
        call: Option<&ToolCall>,
    ) -> (ToolExecutionContext, FrozenToolContext) {
        self.sequence += 1;
        let id = format!("child-process-request-{}", self.sequence);
        let owner = self.runtime.catalog();
        let (run, launch, range) = {
            let db = owner.lock().unwrap();
            let run = db.run(&node.binding.run_id).unwrap();
            let range = HistoryRange {
                branch_id: run.branch_id.clone(),
                ancestor_id: None,
                leaf_id: db.head(&run.branch_id).unwrap(),
            };
            let launch = db.launch_intent(&run.id).unwrap().unwrap().selection;
            (run, launch, range)
        };
        let model = ChildModelBinding {
            configuration: serde_json::from_value(run.configuration).unwrap(),
            credential_scope: launch.credential_scope.clone(),
        };
        let preparation = owner
            .lock()
            .unwrap()
            .prepare_child_dispatch_binding(
                &run.id,
                model,
                launch.tool_schema_generation,
                launch.tools.clone(),
            )
            .unwrap();
        let prepared = preparation.load().unwrap();
        let dispatch_ref = owner
            .lock()
            .unwrap()
            .bind_child_dispatch(&run.id, prepared)
            .unwrap();
        let binding = RequestBinding {
            child_dispatch: dispatch_ref.clone(),
            goal: None,
            resource_activations: vec![],
            resource_checkpoint_id: None,
            connection_identity: launch.connection_identity,
            provider_family: launch.provider_family,
            model: launch.model,
            credential_ref: launch.credential_scope.map(|scope| scope.reference),
            configuration_generation: launch.configuration_generation,
            tool_schema_generation: launch.tool_schema_generation,
            tools: launch.tools.clone(),
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: range.clone(),
        };
        self.record(
            &run.id,
            ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        );
        self.record(
            &run.id,
            ExecutionRecord::RequestPrepared {
                snapshot: RequestSnapshot {
                    view: RequestView {
                        request_id: id.clone(),
                        run_id: run.id.clone(),
                        origin: RequestOrigin::Conversation {
                            step: self.sequence as u64,
                            history_range: range,
                        },
                        binding,
                        history: vec![],
                    },
                    serialized: json!({}),
                },
            },
        );
        self.record(
            &run.id,
            ExecutionRecord::ModelDispatched {
                request_id: id.clone(),
            },
        );
        self.record(&run.id, ExecutionRecord::ModelFinished { request_id: id.clone(), outcome: ModelOutcome::Completed,
            finish_reason: Some(if call.is_some() { FinishReason::ToolCalls } else { FinishReason::Stop }),
            items: vec![ProviderItem { id: format!("item-{id}"), content: call.map(|call| Content::ToolCall { call: call.clone() })
                .unwrap_or_else(|| Content::Text { text: "Model report complete; the accepted process is independently alive.".into() }), opaque: None }],
            interrupted_deltas: vec![], usage: UsageReceipt::default(), failure: None });
        let origin = ToolOrigin::ModelStep {
            request_id: id.clone(),
        };
        (
            ToolExecutionContext {
                run_id: run.id.clone(),
                operation_id: format!(
                    "{id}:tool:{}",
                    call.map(|call| call.call_id.as_str()).unwrap_or("final")
                ),
                origin: origin.clone(),
            },
            FrozenToolContext {
                child_dispatch: dispatch_ref,
                resource_activations: vec![],
                resource_checkpoint_id: None,
                run_id: run.id,
                origin,
                tool_schema_generation: launch.tool_schema_generation,
                tools: Arc::new(launch.tools),
                source: launch.source,
            },
        )
    }
    fn admit(&self, context: &ToolExecutionContext, call: &ToolCall, contract: &ToolContract) {
        self.record(
            &context.run_id,
            ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call: call.clone(),
                    contract: contract.clone(),
                },
            },
        );
    }
    fn dispatched(&self, context: &ToolExecutionContext) {
        self.record(
            &context.run_id,
            ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: ExecutorOwner::Kernel,
            },
        );
    }
    fn close(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        completion: ToolCompletion,
        stopped: bool,
    ) {
        self.record(
            &context.run_id,
            ExecutionRecord::ToolSettled {
                context: context.clone(),
                completion: completion.clone(),
                executor_stopped: stopped,
            },
        );
        let ToolOrigin::ModelStep { request_id } = &context.origin else {
            unreachable!()
        };
        self.record(
            &context.run_id,
            ExecutionRecord::ToolBatchCommitted {
                request_id: request_id.clone(),
                results: vec![ToolResult {
                    request_id: request_id.clone(),
                    call_id: call.call_id.clone(),
                    completion,
                }],
            },
        );
    }
    fn child(&mut self, parent: &Node, name: &str) -> Node {
        let call = ToolCall {
            call_id: name.into(),
            name: "dispatch".into(),
            schema_version: "2".into(),
            arguments: json!({"task":name,"preset":"writer"}),
        };
        let (context, frozen) = self.request(parent, Some(&call));
        let directory = Arc::new(
            varin_runtime::composition::tools::ToolDirectory::assemble(
                crate::collaboration::declarations(
                    self.runtime.catalog(),
                    Some(parent.binding.clone()),
                    self.resources.clone(),
                    crate::host_tools::ToolBridge::new(std::sync::mpsc::sync_channel(1).0.into()),
                ),
            )
            .unwrap(),
        );
        let token = CancellationToken::default();
        let bound = directory.bind_call(&call, &frozen, &token).unwrap();
        let contract = bound.prepare(&token).unwrap();
        self.admit(&context, &call, &contract);
        bound.authorize(&context, &contract, &token).unwrap();
        self.dispatched(&context);
        let completion = bound.execute(&context, &contract, &token).completion;
        assert!(
            matches!(completion, ToolCompletion::JobAccepted { .. }),
            "real dispatch: {completion:?}"
        );
        self.close(&context, &call, completion, true);
        let owner = self.runtime.catalog();
        let child = owner
            .lock()
            .unwrap()
            .child_task(&context.operation_id)
            .unwrap();
        assert!(
            child.receipt.is_none(),
            "ChildTask is accepted before source/Run preparation"
        );
        let source_branch = format!("child-source:{}", child.operation_id);
        let preparation_grant = format!("prepare-{name}");
        self.storage
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .claim_child_handoff(
                &json!({"grantId":preparation_grant,"childThreadId":child.child_thread_id}),
                child.source.handoff(),
                HOST,
                GENERATION,
                &self.root.join("storage").to_string_lossy(),
                EPOCH,
            )
            .unwrap();
        let create = format!("branch-create:{source_branch}");
        let mut begin = json!({"operationId":create,"builderId":create,"workspaceId":"workspace","branchId":source_branch,"draftBasePaths":[],"captureScopes":[]});
        let finish = json!({"operationId":create,"builderId":create});
        let provenance = match &child.source.handoff().root {
            ChildSourceRoot::Fixed { pin } => {
                begin["baseRef"] = json!(pin.root);
                ChildSourceProvenance::FixedRoot {
                    root: pin.root.clone(),
                    resources: None,
                }
            }
            ChildSourceRoot::Physical { root } => {
                assert_eq!(PathBuf::from(&root.canonical_root), parent.cwd);
                assert_eq!(
                    std::fs::read_dir(&parent.cwd).unwrap().count(),
                    1,
                    "this focused recursive capture contains the known changed marker only"
                );
                ChildSourceProvenance::StableCapture {
                    content_mode: ChildSourceContentMode::SavedFiles,
                    capture_scopes: vec![],
                    omitted_draft_paths: vec![],
                    resources: None,
                }
            }
        };
        self.invoke(&preparation_grant, "branch.create.begin", begin);
        if let ChildSourceRoot::Physical { root } = &child.source.handoff().root {
            // Exercise the existing physical capture/object/builder path on one known
            // file. This is not a replacement for the Host directory-capture consumer.
            let captured = self.invoke(&preparation_grant, "file.capture", json!({"operationId":format!("capture-marker-{name}"),"workspaceId":"workspace","rootId":root.root_id,"path":"marker.txt","store":true}));
            let state: Value =
                serde_json::from_str(captured["stateJson"].as_str().unwrap()).unwrap();
            self.invoke(&preparation_grant, "branch.create.append", json!({"builderId":create,"sequence":0,"entries":[{"path":"marker.txt","state":state,"ownerId":captured["ownerId"]}]}));
        }
        self.invoke(&preparation_grant, "branch.create.finish", finish);
        let pinned = self.invoke(&preparation_grant, "branch.pin", json!({"operationId":format!("pin-{name}"),"branchId":source_branch,"revision":0,"pinId":format!("child-source-pin:{}",child.operation_id)}));
        let source: varin_runtime::catalog::launches::SourceSelection = serde_json::from_value(json!({"mode":"materialized","live_root":null,"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":source_branch,"revision":0})).unwrap();
        let mut pin_source: varin_runtime::catalog::launches::SourceSelection = source.clone();
        pin_source.mode = SourceMode::FixedBranch;
        let preparation = owner
            .lock()
            .unwrap()
            .prepare_child_source(
                &child.operation_id,
                ChildSourcePin {
                    pin_id: pinned["pinId"].as_str().unwrap().into(),
                    root: pinned["root"].as_str().unwrap().into(),
                    source: pin_source,
                },
                source.clone(),
                provenance,
            )
            .unwrap();
        let prepared = preparation.load().unwrap();
        owner.lock().unwrap().attach_child_source(prepared).unwrap();
        let proposal = serde_json::from_value(json!({"key":format!("context-{name}"),"branch_id":child.child_branch_id,"through_id":null,"expected_revision":0,"summary":"","effective_system_prompt":"Configured child writer","instruction_sources":[],"memory_checkpoint":null})).unwrap();
        let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"writer","memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":null,"originalSections":[],"instructionSources":[]})).unwrap();
        let child = owner
            .lock()
            .unwrap()
            .prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
        let run = child.receipt.as_ref().unwrap().run_id.clone();
        self.issue(name, &child.child_thread_id, &run, true);
        let managed = self.root.join("storage/managed/runs");
        std::fs::create_dir_all(&managed).unwrap();
        let root = self.invoke(name, "file.root.register", json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":managed}));
        use sha2::{Digest, Sha256};
        let key = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!(["workspace", run])).unwrap(),
        ));
        let params = json!({"operationId":format!("source-materialize:{key}"),"workspaceId":"workspace","rootId":root["rootId"],"path":key,"sourceRoot":pinned["root"]});
        {
            let mut lock = self.storage.lock().unwrap();
            let storage = lock.as_mut().unwrap();
            let (grant, _) = storage
                .authorize(
                    Some(name),
                    EPOCH,
                    HOST,
                    GENERATION,
                    "file.materialize",
                    &params,
                )
                .unwrap();
            let crate::storage::materialization::Admission::Work(task) = storage
                .prepare_materialization(&params, &grant, Arc::new(AtomicBool::new(false)))
                .unwrap()
            else {
                panic!("new materialization")
            };
            assert_eq!(
                task.run(|control| storage.control_materialization(
                    &task.operation_id,
                    &task.job_id,
                    control,
                    false
                ))
                .unwrap()["status"],
                "materialized"
            );
            storage.finish_materialization(&task.operation_id, &task.job_id);
        }
        let cwd = managed.join(key).canonicalize().unwrap();
        let registered = self.invoke(name, "file.root.register", json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":cwd}));
        Node {
            operation: Some(child.operation_id),
            cwd,
            binding: ToolBinding {
                grant_id: name.into(),
                run_id: run,
                thread_id: child.child_thread_id,
                workspace_id: "workspace".into(),
                execution_workspace_id: "workspace".into(),
                root_id: Some(registered["rootId"].as_str().unwrap().into()),
                source_mode: SourceMode::Materialized,
                file_source: None,
                materialized_source: Some(FixedFileSource {
                    branch_id: source_branch,
                    revision: 0,
                }),
                live_root: None,
                environment_run_id: None,
                enabled_tools: BTreeSet::from([
                    ToolKind::FileRead,
                    ToolKind::FileWrite,
                    ToolKind::ProcessSpawn,
                ]),
            },
        }
    }
    fn source_result(&mut self, node: &Node, name: &str, arguments: Value) -> Value {
        let call = ToolCall {
            call_id: name.into(),
            name: name.into(),
            schema_version: "1".into(),
            arguments,
        };
        let (context, frozen) = self.request(node, Some(&call));
        let executor =
            KernelToolExecutor::new(node.binding.clone(), self.resources.clone()).unwrap();
        let token = CancellationToken::default();
        let contract = executor.prepare(&call, &frozen, &token).unwrap();
        self.admit(&context, &call, &contract);
        executor
            .authorize(&context, &call, &contract, &token)
            .unwrap();
        self.dispatched(&context);
        let completion = executor.execute(&context, &call, &contract, &token);
        self.close(&context, &call, completion.clone(), true);
        match completion {
            ToolCompletion::Result {
                outcome: varin_runtime::Outcome::Succeeded,
                content,
                ..
            } => content,
            other => panic!("original source tool: {other:?}"),
        }
    }
    fn spawn_writer(&mut self, node: &Node) -> String {
        let script = "(while [ ! -f go ]; do sleep 0.02; done; n=0; while :; do n=$((n+1)); printf 'after-report-%s\\n' \"$n\" > result.txt; sleep 0.02; done) & echo $! > descendant.pid; printf ready > ready; wait";
        let call = ToolCall {
            call_id: "spawn".into(),
            name: "process_spawn".into(),
            schema_version: "1".into(),
            arguments: json!({"cwd":"","command":"/bin/sh","args":["-c",script],"env":[],"mode":"pipe"}),
        };
        let (context, frozen) = self.request(node, Some(&call));
        let executor =
            KernelToolExecutor::new(node.binding.clone(), self.resources.clone()).unwrap();
        let token = CancellationToken::default();
        let contract = executor.prepare(&call, &frozen, &token).unwrap();
        self.admit(&context, &call, &contract);
        executor
            .authorize(&context, &call, &contract, &token)
            .unwrap();
        self.dispatched(&context);
        let completion = executor.execute(&context, &call, &contract, &token);
        assert!(
            matches!(completion, ToolCompletion::JobAccepted { .. }),
            "actual guardian: {completion:?}"
        );
        self.close(&context, &call, completion, false);
        wait_until(|| node.cwd.join("ready").exists());
        context.operation_id
    }
    fn report(&mut self, node: &Node) {
        self.request(node, None);
        self.record(
            &node.binding.run_id,
            ExecutionRecord::StateChanged {
                state: RunState::Completed,
                waiting_on: None,
            },
        );
        varin_runtime::catalog::child_delivery::reconcile_reports(&self.runtime.catalog()).unwrap();
        let owner = self.runtime.catalog();
        let db = owner.lock().unwrap();
        let child = db.child_task(node.operation.as_ref().unwrap()).unwrap();
        assert_eq!(
            child.report.unwrap().outcome,
            varin_runtime::Outcome::Succeeded
        );
        assert_eq!(child.code_result, ChildCodeResult::Pending);
    }
    fn command(&self, method: &str, node: &Node, rootless: bool, extra: Value) -> Value {
        let mut binding = node.binding.clone();
        if rootless {
            binding.root_id = None;
        }
        let mut params = json!({"operationId":node.operation,"toolBinding":binding});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        child_commands::execute(
            self.runtime.clone(),
            self.resources.clone(),
            method,
            params,
            &AtomicBool::new(false),
        )
        .unwrap()
    }
}
fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "real process condition timed out"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
#[test]
#[ignore = "requires a freshly built kernel executable"]
fn actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results() {
    let executable = PathBuf::from(
        std::env::var_os("VARIN_TEST_KERNEL_EXECUTABLE").expect("fresh kernel executable"),
    );
    assert!(executable.is_file());
    let root = std::env::temp_dir().join(format!("varin-child-process-{}", uuid::Uuid::new_v4()));
    let mut storage = Storage::open(&root.join("storage"), HOST).unwrap();
    storage.set_test_process_worker_executable(executable);
    let process_controls = crate::process::ProcessControlRegistry::default();
    storage.set_process_controls(process_controls.clone());
    let (terminals, rx) = mpsc::channel();
    storage.set_process_terminal_sender(terminals);
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("parent", "parent-branch").unwrap();
    let config = json!({"providerFamily":"openai-responses","endpoint":"http://127.0.0.1:1/model","allowAnonymous":true,"model":"no-network-fixture","configurationGeneration":1});
    let model = ChildModelBinding {
        configuration: serde_json::from_value(config.clone()).unwrap(),
        credential_scope: None,
    };
    let schemas = crate::child_capabilities::select(&[
        "dispatch".into(),
        "file_read".into(),
        "file_write".into(),
        "process_spawn".into(),
    ])
    .unwrap();
    let catalog = ChildDispatchCatalog {
        native_capabilities: Vec::new(),
        identity: "original-settings-selection".into(),
        normal_unavailable: None,
        presets: vec![ChildPreset {
            id: "writer".into(),
            name: "Writer".into(),
            instructions: "Use only the admitted private view.".into(),
            tools: schemas.iter().map(|s| s.name.clone()).collect(),
            work_mode: ChildWorkMode::IsolatedWrite,
            model_source: ChildModelSource::Inherit,
            inherit_base: None,
            model: None,
            unavailable: None,
        }],
    };
    let mut binding = ToolBinding {
        grant_id: "parent".into(),
        run_id: String::new(),
        thread_id: "parent".into(),
        workspace_id: "workspace".into(),
        execution_workspace_id: "workspace".into(),
        root_id: None,
        file_source: Some(FixedFileSource {
            branch_id: "parent-source".into(),
            revision: 0,
        }),
        source_mode: SourceMode::FixedBranch,
        materialized_source: None,
        live_root: None,
        environment_run_id: None,
        enabled_tools: BTreeSet::from([ToolKind::FileRead]),
    };
    let launch = LaunchSelection {
        child_dispatch: Some(catalog),
        connection_identity: model.connection_identity().unwrap(),
        provider_family: model.configuration.provider_family.clone(),
        model: model.configuration.model.clone(),
        configuration_generation: 1,
        tool_schema_generation: 1,
        tools: vec![
            schemas
                .iter()
                .find(|s| s.name == "dispatch")
                .unwrap()
                .clone(),
            schemas
                .iter()
                .find(|s| s.name == "file_read")
                .unwrap()
                .clone(),
        ],
        policy: PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        },
        source: Some(binding.source_selection().unwrap()),
        credential_scope: None,
        extension_bindings: vec![],
        mcp_binding: None,
        policy_models: vec![],
    };
    let receipt = db
        .submit_with_launch(
            &SubmitInput {
                key: "parent".into(),
                thread_id: "parent".into(),
                branch_id: "parent-branch".into(),
                expected_head: None,
                input: json!("Run configured child writers"),
                configuration: config,
            },
            Some(launch),
        )
        .unwrap();
    binding.run_id = receipt.run_id;
    let runtime = Arc::new(RunSupervisor::new(db));
    let storage = Arc::new(Mutex::new(Some(storage)));
    let resources = KernelResourceClient::new(
        {
            let storage = storage.clone();
            move |request| {
                let result = serve_resource(
                    storage.lock().unwrap().as_mut().unwrap(),
                    EPOCH,
                    HOST,
                    GENERATION,
                    &request,
                );
                request.reply.send(result).unwrap();
                Ok(())
            }
        },
        |_| Ok(()),
        process_controls,
    );
    let (output, _events) = mpsc::sync_channel(16);
    let controls = control_commands::ControlCommands {
        runtime: runtime.clone(),
        resources: resources.clone(),
        models: crate::run_models::RunModels::new(
            runtime.catalog(),
            crate::credential_bridge::CredentialBridge::new(output.clone()),
        ),
        tools: crate::run_tools::RunTools::new(
            runtime.catalog(),
            crate::host_tools::ToolBridge::new(output.into()),
        ),
    };
    let mut h = Harness {
        root: root.clone(),
        runtime,
        storage,
        resources,
        terminals: rx,
        controls,
        sequence: 0,
    };
    let parent = Node {
        operation: None,
        binding,
        cwd: PathBuf::new(),
    };
    h.issue("parent", "parent", &parent.binding.run_id, false);
    h.invoke("parent","branch.create.begin",json!({"operationId":"parent-source","builderId":"parent-source","workspaceId":"workspace","branchId":"parent-source","draftBasePaths":[],"captureScopes":[]}));
    h.invoke(
        "parent",
        "branch.create.finish",
        json!({"operationId":"parent-source","builderId":"parent-source"}),
    );
    let child = h.child(&parent, "child");
    let missing = h.source_result(&child, "file_read", json!({"path":"marker.txt"}));
    assert_eq!(missing["missing"], true);
    h.source_result(&child, "file_write", json!({"path":"marker.txt","readVersion":missing["readVersion"],"content":"changed in the actual child working copy"}));
    assert_eq!(
        h.source_result(&parent, "file_read", json!({"path":"marker.txt"}))["missing"],
        true,
        "private write does not change parent fixed source"
    );
    let grandchild = h.child(&child, "grandchild");
    assert_eq!(
        h.source_result(&grandchild, "file_read", json!({"path":"marker.txt"}))["content"]["text"],
        "changed in the actual child working copy"
    );
    {
        let owner = h.runtime.catalog();
        let db = owner.lock().unwrap();
        let original = db
            .launch_metadata(&parent.binding.run_id)
            .unwrap()
            .unwrap()
            .selection
            .child_dispatch_ref;
        assert_eq!(
            db.launch_metadata(&child.binding.run_id)
                .unwrap()
                .unwrap()
                .selection
                .child_dispatch_ref,
            original
        );
        assert_eq!(
            db.launch_metadata(&grandchild.binding.run_id)
                .unwrap()
                .unwrap()
                .selection
                .child_dispatch_ref,
            original,
            "recursive catalog remains the same content ref, not nested copies"
        );
        let a = db.child_task(child.operation.as_ref().unwrap()).unwrap();
        let g = db
            .child_task(grandchild.operation.as_ref().unwrap())
            .unwrap();
        assert_ne!(
            a.source.pin().unwrap().root,
            g.source.pin().unwrap().root,
            "recursive baseline captures the modified physical view rather than the original pin"
        );
    }
    let sibling = h.child(&parent, "sibling");
    let child_process = h.spawn_writer(&child);
    let grandchild_process = h.spawn_writer(&grandchild);
    let sibling_process = h.spawn_writer(&sibling);
    for node in [&child, &grandchild, &sibling] {
        h.report(node);
        assert!(!node.cwd.join("result.txt").exists());
        std::fs::write(node.cwd.join("go"), b"user trigger after model report").unwrap();
        wait_until(|| node.cwd.join("result.txt").exists());
    }
    assert_eq!(
        h.command("runtime.child.settle", &child, false, json!({}))["code_result"]["kind"],
        "pending",
        "live guardian cannot fix file result"
    );
    let owner = h.runtime.catalog();
    assert!(!owner
        .lock()
        .unwrap()
        .child_writers_stopped_sync(child.operation.as_ref().unwrap())
        .unwrap());
    let ack=h.controls.admit_control("runtime.tree.cancel",&json!({"target":{"kind":"child","operation_id":child.operation},"expectedParentThreadId":"parent"})).unwrap().unwrap();
    assert_eq!(ack["child_count"], 2);
    assert_eq!(ack["process_count"], 2);
    let mut stopped = BTreeSet::new();
    while stopped.len() < 2 {
        let terminal = h.terminals.recv_timeout(Duration::from_secs(20)).unwrap();
        assert_ne!(terminal.process_id, sibling_process);
        apply_process_terminal(&h.runtime, &terminal).unwrap();
        stopped.insert(terminal.process_id);
    }
    assert_eq!(
        stopped,
        BTreeSet::from([child_process.clone(), grandchild_process])
    );
    assert!(owner
        .lock()
        .unwrap()
        .child_writers_stopped_sync(child.operation.as_ref().unwrap())
        .unwrap());
    assert!(!owner
        .lock()
        .unwrap()
        .child_writers_stopped_sync(sibling.operation.as_ref().unwrap())
        .unwrap());
    let before = std::fs::read(sibling.cwd.join("result.txt")).unwrap();
    wait_until(|| {
        std::fs::read(sibling.cwd.join("result.txt")).is_ok_and(|v| !v.is_empty() && v != before)
    });
    let bytes = std::fs::read(child.cwd.join("result.txt")).unwrap();
    assert!(bytes.starts_with(b"after-report-"));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        std::fs::read(child.cwd.join("result.txt")).unwrap(),
        bytes,
        "OS descendant writer really stopped"
    );
    assert_eq!(
        h.command("runtime.child.settle", &child, false, json!({}))["code_result"]["kind"],
        "settling"
    );
    let branch = child
        .binding
        .materialized_source
        .as_ref()
        .unwrap()
        .branch_id
        .clone();
    let publication = format!("child-result:{}", child.operation.as_ref().unwrap());
    let candidate_op = format!("result-prepare:{publication}");
    let pin=h.invoke("child","branch.pin",json!({"operationId":"result-base-pin","branchId":branch,"revision":0,"pinId":"result-base"}));
    // Capture the whole stopped private view through the original Storage object owner.
    let mut paths = std::fs::read_dir(&child.cwd)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    paths.sort();
    let changes=paths.iter().map(|path| {
        let capture=h.invoke("child","file.capture",json!({"operationId":format!("capture-{path}"),"workspaceId":"workspace","rootId":child.binding.root_id,"path":path,"store":true}));
        let state:Value=serde_json::from_str(capture["stateJson"].as_str().unwrap()).unwrap();
        json!({"path":path,"state":state,"ownerId":capture["ownerId"]})
    }).collect::<Vec<_>>();
    let state = changes
        .iter()
        .find(|change| change["path"] == "result.txt")
        .unwrap()["state"]
        .clone();
    h.invoke("child","branch.write.begin",json!({"operationId":candidate_op,"builderId":candidate_op,"branchId":branch,"expectedWriteRevision":0}));
    h.invoke(
        "child",
        "branch.write.append",
        json!({"builderId":candidate_op,"sequence":0,"changes":changes}),
    );
    let candidate=h.invoke("child","working.result.prepare",json!({"operationId":candidate_op,"publicationId":publication,"builderId":candidate_op,"expectedRoot":pin["root"]}));
    // Fixed Storage candidate survives removal of the physical working directory.
    std::fs::remove_dir_all(&child.cwd).unwrap();
    assert_eq!(
        h.command(
            "runtime.child.result.candidate",
            &child,
            true,
            json!({"candidateOperationId":candidate_op})
        )["code_result"]["kind"],
        "candidate"
    );
    let published=h.invoke("child","working.result.publish",json!({"operationId":publication,"workspaceId":"workspace","branchId":branch,"candidateOperationId":candidate_op}));
    let result = h.command(
        "runtime.child.result.published",
        &child,
        true,
        json!({"publicationId":publication}),
    );
    assert_eq!(result["code_result"]["kind"], "published");
    assert_eq!(result["code_result"]["result"]["root"], candidate["root"]);
    let fixed=h.invoke("child","storage.getBlob",json!({"hash":state["objectHash"],"branchId":branch,"revision":published["resultRevision"],"path":"result.txt"}));
    use base64::Engine;
    assert_eq!(
        base64::prelude::BASE64_STANDARD
            .decode(fixed["bytesBase64"].as_str().unwrap())
            .unwrap(),
        bytes
    );
    h.controls.admit_control("runtime.tree.cancel",&json!({"target":{"kind":"child","operation_id":sibling.operation},"expectedParentThreadId":"parent"})).unwrap();
    let terminal = h.terminals.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!(terminal.process_id, sibling_process);
    apply_process_terminal(&h.runtime, &terminal).unwrap();
    let original = owner.lock().unwrap().operation(&child_process).unwrap();
    assert!(original.external_receipt.as_ref().unwrap().executor_stopped);
    let original_result = result["code_result"].clone();
    drop(owner);
    drop(h);
    let reopened = Catalog::open(root.join("catalog")).unwrap();
    assert_eq!(
        serde_json::to_value(
            reopened
                .child_task(child.operation.as_ref().unwrap())
                .unwrap()
                .code_result
        )
        .unwrap(),
        original_result
    );
    assert_eq!(
        reopened.operation(&child_process).unwrap().external_receipt,
        original.external_receipt
    );
    let mut storage = Storage::open(&root.join("storage"), HOST).unwrap();
    storage.issue_grant(&json!({"grantId":"reopen","hostGeneration":GENERATION,"capabilities":["storage.read","storage.write"],"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":child.binding.thread_id,"runId":child.binding.run_id}),HOST,GENERATION,&root.join("storage").to_string_lossy(),EPOCH).unwrap();
    let query = json!({"operationId":publication,"workspaceId":"workspace","branchId":branch,"candidateOperationId":candidate_op});
    let (grant, query) = storage
        .authorize(
            Some("reopen"),
            EPOCH,
            HOST,
            GENERATION,
            "working.result.publish",
            &query,
        )
        .unwrap();
    assert_eq!(
        storage
            .dispatch("working.result.publish", &query, Some("reopen"), &grant)
            .unwrap(),
        published,
        "reopen uses same publication, never reruns the process or captures cwd"
    );
    assert!(!child.cwd.exists());
    drop(storage);
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}
