//! Real child dispatch, source handoff and Run consume the original retrieval owners over stdio.
//! Source preparation stays in Storage; only the model's dispatch/retrieval choices are scripted.
//! This targets the native retrieval endpoint in the default child selection, not every default tool.
use super::*;
use crate::tools::FixedFileSource;
use varin_runtime::SourceMode;
use varin_runtime::catalog::collaboration::{
    ChildSourcePin, ChildSourceProvenance, ChildSourceRoot, ChildTask,
};
use varin_runtime::catalog::dispatch::{ChildPresetToolsSource, DispatchInput};
use varin_runtime::catalog::launches::SourceSelection;
use varin_runtime::composition::tools::ToolDirectory;

struct DispatchModel {
    preset: &'static str,
}
impl ModelProvider for DispatchModel {
    fn serialize(&self, _: &RequestView) -> Result<Value, ExecutionError> {
        Ok(json!({}))
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        emit(ProviderEvent::Usage {
            receipt: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                input_tokens: Some(0),
                output_tokens: Some(0),
                ..Default::default()
            },
        })
        .unwrap();
        if let Some(result) = request
            .view
            .history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == "dispatch-retrieval" => {
                    Some(result)
                }
                _ => None,
            })
        {
            assert!(
                matches!(result.completion, ToolCompletion::JobAccepted { .. }),
                "the real dispatch must accept a child before preparing its source: {result:?}"
            );
            return Ok(FinishReason::Stop);
        }
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == "dispatch")
            .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "dispatch-retrieval-call".into(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: "dispatch-retrieval".into(),
                        name: schema.name.clone(),
                        schema_version: schema.version.clone(),
                        arguments: json!({"task":"Retrieve retrievalNeedle from the delegated source", "preset":self.preset}),
                    },
                },
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}

fn dispatch(review: &mut Review, preset: &'static str) -> ChildTask {
    let owner = review.f.runtime.catalog();
    let directory = Arc::new(
        ToolDirectory::assemble(crate::collaboration::declarations(
            owner.clone(),
            Some(review.tool_binding.clone()),
            review.resource_client.clone(),
            review.f.bridge.clone(),
        ))
        .unwrap(),
    );
    let request_binding = binding(&review.f.runtime, &review.run);
    // Freeze the actual executable parent directory. The child's configured native defaults
    // still come from the Host profile compiler and the original capability descriptors.
    let mut compared_schemas = request_binding.tools.clone();
    compared_schemas.sort_by(|left, right| left.name.cmp(&right.name));
    assert_eq!(
        compared_schemas,
        directory.schemas(),
        "launch schemas must equal the actual executable dispatch directory"
    );
    let execution = review
        .f
        .runtime
        .start(
            &review.run,
            RunStart {
                binding: request_binding,
                policy_state: Value::Null,
                provider: Arc::new(DispatchModel { preset }),
                tools: directory,
                policy: Arc::new(DefaultAgentPolicy),
                context_preparation: Arc::new(crate::child_capabilities::BindingPreparation {
                    inner: Arc::new(NoopContextPreparation),
                    catalog: owner.clone(),
                }),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    let (sender, done) = mpsc::channel();
    thread::spawn(move || sender.send(execution.wait()).unwrap());
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(Instant::now() < deadline, "original child dispatch stalled");
        assert!(
            review.pump().is_none(),
            "unexpected fixture event during child dispatch"
        );
        if let Ok(report) = done.try_recv() {
            assert_eq!(report.unwrap().state, RunState::Completed);
            break;
        }
    }
    let db = owner.lock().unwrap();
    let children = db.child_tasks().unwrap();
    assert_eq!(children.len(), 1);
    let child = children.into_iter().next().unwrap();
    assert_eq!(child.parent_run_id, review.run);
    assert!(
        child.receipt.is_none(),
        "JobAccepted precedes child source and Run preparation"
    );
    let history = db.execution_history("branch:parent").unwrap();
    assert!(history.iter().any(|item| matches!(&item.content,
        Content::ToolResult { result } if result.call_id == "dispatch-retrieval"
            && matches!(result.completion, ToolCompletion::JobAccepted { .. }))));
    let selected = db
        .capture_child_dispatch(&child.dispatch_context_ref)
        .load()
        .unwrap();
    let profile = selected
        .catalog
        .presets
        .iter()
        .find(|profile| profile.id == preset)
        .unwrap();
    assert_eq!(profile.tools_source, ChildPresetToolsSource::Default);
    assert!(
        profile.tools.iter().any(|name| name == "code_retrieval"),
        "original Host defaults must expose the native retrieval consumer"
    );
    // An explicit user selection stays exact; adding a default must not rewrite it.
    let explicit: DispatchInput = serde_json::from_value(json!({
        "task":"Read only the explicitly selected tool", "preset":preset, "tools":["file_read"]
    }))
    .unwrap();
    assert_eq!(
        selected.resolve(&explicit).unwrap().profile.tools,
        vec!["file_read"]
    );
    child
}

fn storage_call(review: &Review, actor: &str, method: &str, params: Value) -> Value {
    let mut storage = review.f.storage.lock().unwrap();
    let (grant, params) = storage
        .authorize(Some(actor), EPOCH, HOST, GENERATION, method, &params)
        .unwrap_or_else(|error| panic!("{method} authorization: {error}"));
    storage
        .dispatch(method, &params, Some(actor), &grant)
        .unwrap_or_else(|error| panic!("{method}: {error}"))
}

fn prepare_source(review: &mut Review, child: &ChildTask, mode: SourceMode) -> ChildTask {
    let handoff = child.source.handoff().unwrap();
    let ChildSourceRoot::Fixed { pin: parent_pin } = &handoff.root else {
        panic!("the original fixed parent must transfer its durable pin")
    };
    assert_eq!(parent_pin.source.revision, Some(0));
    assert!(
        !review.root.join("workspace").exists(),
        "the original live path is unavailable"
    );
    let grant_id = format!("source-prepare:{}", child.operation_id);
    {
        let mut storage = review.f.storage.lock().unwrap();
        let params = json!({"grantId":grant_id,"childThreadId":child.child_thread_id});
        let claimed = storage
            .claim_child_handoff(
                &params,
                handoff,
                HOST,
                GENERATION,
                &review.f.storage_root.to_string_lossy(),
                EPOCH,
            )
            .unwrap();
        assert_eq!(claimed["handoff_operation_id"], handoff.operation_id);
        let wrong_revision =
            json!({"branchId":parent_pin.source.branch_id,"revision":1,"includeEntries":true});
        assert!(
            storage
                .authorize(
                    Some(&grant_id),
                    EPOCH,
                    HOST,
                    GENERATION,
                    "branch.read",
                    &wrong_revision
                )
                .is_err(),
            "preparation cannot read a later parent source revision"
        );
        let wrong_branch = json!({"operationId":"unrelated-create","builderId":"unrelated-create",
            "workspaceId":handoff.source.workspace_id,"branchId":"unrelated-source","baseRef":parent_pin.root,
            "draftBasePaths":[],"captureScopes":[]});
        assert!(
            storage
                .authorize(
                    Some(&grant_id),
                    EPOCH,
                    HOST,
                    GENERATION,
                    "branch.create.begin",
                    &wrong_branch
                )
                .is_err(),
            "the handoff cannot create another child's source"
        );
    }
    let branch = format!("child-source:{}", child.operation_id);
    let create = format!("branch-create:{branch}");
    storage_call(
        review,
        &grant_id,
        "branch.create.begin",
        json!({
            "operationId":create,"builderId":create,"workspaceId":handoff.source.workspace_id,
            "branchId":branch,"baseRef":parent_pin.root,"draftBasePaths":[],"captureScopes":[]
        }),
    );
    storage_call(
        review,
        &grant_id,
        "branch.create.finish",
        json!({"operationId":create,"builderId":create}),
    );
    let pinned = storage_call(
        review,
        &grant_id,
        "branch.pin",
        json!({
            "operationId":format!("pin:{}",child.operation_id),"branchId":branch,"revision":0,
            "pinId":format!("child-source-pin:{}",child.operation_id)
        }),
    );
    assert_eq!(
        pinned["root"], parent_pin.root,
        "child begins at the exact handoff root"
    );
    let mut source = parent_pin.source.clone();
    source.mode = mode;
    source.branch_id = Some(branch);
    source.revision = Some(0);
    let mut pin_source = source.clone();
    pin_source.mode = SourceMode::FixedBranch;
    let owner = review.f.runtime.catalog();
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
            ChildSourceProvenance::FixedRoot {
                root: parent_pin.root.clone(),
                resources: None,
            },
        )
        .unwrap();
    let prepared = preparation.load().unwrap();
    owner.lock().unwrap().attach_child_source(prepared).unwrap();
    // Execute the public capture/body/commit input preparation, after the source owner attached
    // its real branch and pin. This is the existing test driver, not a fabricated child Run.
    let proposal = serde_json::from_value(json!({
        "key":format!("context:{}",child.operation_id),"branch_id":child.child_branch_id,
        "through_id":null,"expected_revision":0,"summary":"",
        "effective_system_prompt":"Retrieve only from the admitted child source.",
        "instruction_sources":[],"memory_checkpoint":null
    }))
    .unwrap();
    let basis = serde_json::from_value(json!({
        "mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"child-retrieval-review",
        "memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":null,
        "originalSections":[],"instructionSources":[]
    })).unwrap();
    let child = owner
        .lock()
        .unwrap()
        .prepare_child(&child.operation_id, source, proposal, basis)
        .unwrap();
    review
        .f
        .storage
        .lock()
        .unwrap()
        .revoke_grant(&json!({"grantId":grant_id}), HOST)
        .unwrap();
    child
}

fn select_child(review: &mut Review, child: &ChildTask) -> SourceSelection {
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let owner = review.f.runtime.catalog();
    let launch = owner
        .lock()
        .unwrap()
        .launch_intent(&run)
        .unwrap()
        .unwrap()
        .selection;
    let source = launch.source.clone().unwrap();
    assert_eq!(Some(&source), child.source.selection());
    assert!(
        launch
            .tools
            .iter()
            .any(|schema| schema.name == "code_retrieval")
    );
    review.f.host.send(
        json!({"kind":"fixture-select-child","threadId":child.child_thread_id,
        "runId":run,"source":source,"pathScopes":["allowed"]}),
    );
    let ready = review.f.receive("fixture-prepared");
    let fixed = FixedFileSource {
        branch_id: source.branch_id.clone().unwrap(),
        revision: 0,
    };
    let enabled_tools = ToolKind::all()
        .filter(|kind| {
            let name = serde_json::to_value(kind).unwrap();
            launch.tools.iter().any(|schema| name == schema.name)
        })
        .collect();
    let tool_binding = ToolBinding {
        grant_id: ready["grantId"].as_str().unwrap().into(),
        thread_id: child.child_thread_id.clone(),
        run_id: run.clone(),
        workspace_id: source.workspace_id.clone(),
        execution_workspace_id: source.execution_workspace_id.clone(),
        root_id: ready["physicalRoot"]["rootId"].as_str().map(str::to_owned),
        file_source: (source.mode == SourceMode::FixedBranch).then_some(fixed.clone()),
        materialized_source: (source.mode == SourceMode::Materialized).then_some(fixed),
        source_mode: source.mode,
        live_root: None,
        environment_run_id: None,
        enabled_tools,
    };
    assert_ne!(tool_binding.grant_id, review.tool_binding.grant_id);
    assert_ne!(tool_binding.run_id, review.tool_binding.run_id);
    assert_ne!(tool_binding.thread_id, review.tool_binding.thread_id);
    let (method, denied) = if source.mode == SourceMode::FixedBranch {
        (
            "branch.read",
            json!({"branchId":source.branch_id,"revision":source.revision,
            "paths":["private/secret.ts"]}),
        )
    } else {
        (
            "file.read",
            json!({"workspaceId":source.workspace_id,"rootId":tool_binding.root_id,
            "path":"private/secret.ts","offset":0,"length":128}),
        )
    };
    assert!(
        matches!(
            review.f.storage.lock().unwrap().authorize(
                Some(&tool_binding.grant_id),
                EPOCH,
                HOST,
                GENERATION,
                method,
                &denied
            ),
            Err(KernelError::Authorization(_))
        ),
        "the new child Run grant independently rejects reads outside its narrowed scope"
    );
    review.executor = Arc::new(
        KernelToolExecutor::new(tool_binding.clone(), review.resource_client.clone())
            .unwrap()
            .with_retrieval(
                review.retrieval.clone(),
                None,
                owner.lock().unwrap().nested_tools(),
            ),
    );
    review.physical_path = ready["physicalRoot"]["canonicalRoot"]
        .as_str()
        .map(PathBuf::from);
    review.tool_binding = tool_binding;
    review.run = run;
    source
}

#[test]
#[ignore = "requires built Host packages; original child directory/source/retrieval owners over stdio"]
fn default_child_dispatch_reads_its_admitted_source_and_keeps_original_history_after_gc() {
    for (preset, mode) in [
        ("worker", SourceMode::Materialized),
        ("retrieval", SourceMode::FixedBranch),
    ] {
        let mut review = Review::with_child_source("source", "fixed_branch");
        let parent_run = review.run.clone();
        let accepted = dispatch(&mut review, preset);
        let child = prepare_source(&mut review, &accepted, mode);
        let source = select_child(&mut review, &child);
        let counts = review.execute(false);
        assert_eq!(
            counts["requests"], 0,
            "source-only child retrieval must not invoke a paid model"
        );
        let owner = review.f.runtime.catalog();
        let db = owner.lock().unwrap();
        assert_eq!(db.run(&review.run).unwrap().state, RunState::Completed);
        assert_eq!(
            db.run(&review.run).unwrap().thread_id,
            child.child_thread_id
        );
        assert_eq!(
            db.launch_intent(&review.run)
                .unwrap()
                .unwrap()
                .selection
                .source,
            Some(source.clone())
        );
        let parent_history = db.execution_history("branch:parent").unwrap();
        let history = db.execution_history(&child.child_branch_id).unwrap();
        let result = history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == "retrieve" => {
                    match &result.completion {
                        ToolCompletion::Result {
                            outcome: varin_runtime::Outcome::Succeeded,
                            content,
                            ..
                        } => Some(&content.data),
                        _ => None,
                    }
                }
                _ => None,
            })
            .expect("actual child Run committed its original retrieval result");
        let snippets = result["snippets"].as_array().unwrap();
        assert_eq!(
            snippets.len(),
            3,
            "the child read the inherited source, not an empty substitute"
        );
        assert!(
            snippets
                .iter()
                .all(|snippet| snippet["path"].as_str().unwrap().starts_with("allowed/"))
        );
        let rendered = result.to_string();
        assert!(!rendered.contains("FORBIDDEN_SOURCE"));
        assert!(!rendered.contains("WRONG_NEW_HEAD"));
        assert!(
            rendered.contains(if mode == SourceMode::Materialized {
                "SOURCE_A_WORKING_COPY"
            } else {
                "SOURCE_A"
            }),
            "the actual child source reader must reach the >64 KiB tail"
        );
        if mode == SourceMode::FixedBranch {
            assert!(!rendered.contains("SOURCE_A_WORKING_COPY"));
        }
        assert_eq!(db.run(&parent_run).unwrap().state, RunState::Completed);
        let retained_child = db.child_task(&child.operation_id).unwrap();
        let launch = db.launch_intent(&review.run).unwrap().unwrap();
        drop(db);
        let collection = owner
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default());
        assert_eq!(
            collection.run().status,
            varin_runtime::ContentCollectionStatus::Completed
        );
        let root = review.root.clone();
        let child_run = review.run.clone();
        drop(owner);
        drop(review);
        let db = Catalog::open(root.join("catalog")).unwrap();
        assert_eq!(
            db.execution_history(&child.child_branch_id).unwrap(),
            history
        );
        assert_eq!(
            db.execution_history("branch:parent").unwrap(),
            parent_history
        );
        let reopened_child = db.child_task(&child.operation_id).unwrap();
        assert_eq!(reopened_child.source, retained_child.source);
        assert_eq!(reopened_child.receipt, retained_child.receipt);
        assert_eq!(
            reopened_child.selected_profile_ref,
            retained_child.selected_profile_ref
        );
        assert_eq!(
            db.launch_intent(&child_run).unwrap().unwrap().selection,
            launch.selection
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
