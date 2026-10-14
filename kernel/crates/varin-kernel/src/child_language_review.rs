//! Actual default child dispatch -> independent source/Run -> bundled TypeScript -> report/stop/history.
//! Reuses the original language/process/Storage rendezvous; only model choices are controlled.
use super::*;
use varin_runtime::catalog::collaboration::{
    ChildCodeResult, ChildSourcePin, ChildSourceProvenance, ChildSourceRoot, ChildTask,
};
use varin_runtime::catalog::launches::SourceSelection;
use varin_runtime::composition::tools::ToolDirectory;
use varin_runtime::SourceMode;

struct DispatchModel {
    preset: &'static str,
}
impl ModelProvider for DispatchModel {
    fn serialize(&self, view: &RequestView, reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Script.serialize(view, reuse)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        if let Some(result) = request
            .view
            .history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == "dispatch-language" => {
                    Some(result)
                }
                _ => None,
            })
        {
            assert!(
                matches!(result.completion, ToolCompletion::JobAccepted { .. }),
                "{result:?}"
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
        emit(ProviderEvent::ItemCompleted { item: ProviderItem { id: "dispatch-language-call".into(), opaque: None,
            content: Content::ToolCall { call: ToolCall { call_id: "dispatch-language".into(), name: schema.name.clone(),
                schema_version: schema.version.clone(), arguments: json!({"task":"Inspect the delegated TypeScript source and report its actual definitions.","preset":self.preset}) } } } }).unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
struct ChildModel;
impl ModelProvider for ChildModel {
    fn serialize(&self, view: &RequestView, reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Script.serialize(view, reuse)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let finish = Script.generate(request, cancel, emit)?;
        if finish == FinishReason::Stop {
            emit(ProviderEvent::ItemCompleted { item: ProviderItem { id: format!("{}:child-report", request.view.run_id), opaque: None,
                content: Content::Text { text: "CHILD_LANGUAGE_REPORT: greet resolves to util.ts; shared resolves through the captured tsconfig to src/shared.ts.".into() } } }).unwrap();
        }
        Ok(finish)
    }
}
fn admit_dispatch(review: &Review, source: &Value) -> String {
    let model = review.child_model.as_ref().unwrap();
    let selection: LaunchSelection = serde_json::from_value(json!({"extension_bindings":[],
        "connection_identity":model.connection_identity().unwrap(),"provider_family":model.configuration.provider_family,"model":model.configuration.model,
        "configuration_generation":model.configuration.configuration_generation,"tool_schema_generation":1,
        "credential_scope":model.credential_scope,"child_dispatch":review.child_catalog,
        "tools":crate::collaboration::schemas(vec![]),"policy":{"name":"default","version":"1"},"source":source})).unwrap();
    let owner = review.f.runtime.catalog();
    let mut db = owner.lock().unwrap();
    let receipt = db
        .submit_with_launch(
            &SubmitInput {
                key: "dispatch-child-language".into(),
                thread_id: THREAD.into(),
                branch_id: BRANCH.into(),
                expected_head: None,
                input: json!({"text":"Delegate language analysis"}),
                configuration: serde_json::to_value(&model.configuration).unwrap(),
            },
            Some(selection),
        )
        .unwrap();
    let epoch = db.epoch();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    receipt.run_id
}
fn dispatch_child(
    review: &mut Review,
    parent_run: &str,
    source: ToolBinding,
    preset: &'static str,
) -> ChildTask {
    let owner = review.f.runtime.catalog();
    let directory = Arc::new(
        ToolDirectory::assemble(crate::collaboration::declarations(
            owner.clone(),
            Some(source),
            review.resource_client.clone(),
            review.f.bridge.clone(),
        ))
        .unwrap(),
    );
    let request_binding = binding(&review.f.runtime, parent_run);
    let mut schemas = request_binding.tools.clone();
    schemas.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(schemas, directory.schemas());
    let handle = review
        .f
        .runtime
        .start(
            parent_run,
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
    thread::spawn(move || sender.send(handle.wait()).unwrap());
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(
            Instant::now() < deadline,
            "actual child dispatch did not finish"
        );
        assert!(review.pump().is_none());
        if let Ok(report) = done.try_recv() {
            assert_eq!(report.unwrap().state, RunState::Completed);
            break;
        }
    }
    let db = owner.lock().unwrap();
    let children = db.child_tasks().unwrap();
    assert_eq!(children.len(), 1);
    let child = children.into_iter().next().unwrap();
    assert_eq!(child.parent_run_id, parent_run);
    assert!(child.receipt.is_none());
    assert_ne!(child.child_thread_id, THREAD);
    assert_ne!(child.child_branch_id, BRANCH);
    let frozen = db
        .capture_child_dispatch(&child.dispatch_context_ref)
        .load()
        .unwrap();
    let profile = frozen
        .catalog
        .presets
        .iter()
        .find(|profile| profile.id == preset)
        .unwrap();
    assert_eq!(
        profile.tools_source,
        varin_runtime::catalog::dispatch::ChildPresetToolsSource::Default
    );
    for name in TOOLS {
        assert!(profile.tools.iter().any(|tool| tool == name));
    }
    child
}
fn storage_call(review: &Review, actor: &str, method: &str, params: Value) -> Value {
    let mut storage = review.f.storage.lock().unwrap();
    let (grant, params) = storage
        .authorize(Some(actor), EPOCH, HOST, GENERATION, method, &params)
        .unwrap();
    storage
        .dispatch(method, &params, Some(actor), &grant)
        .unwrap()
}
fn prepare_child_source(review: &Review, child: &ChildTask, mode: SourceMode) -> ChildTask {
    let handoff = child.source.handoff().unwrap();
    let ChildSourceRoot::Fixed { pin: parent } = &handoff.root else {
        panic!("fixed parent handoff required")
    };
    let grant_id = format!("language-child-prepare:{}", child.operation_id);
    {
        let mut storage = review.f.storage.lock().unwrap();
        storage
            .claim_child_handoff(
                &json!({"grantId":grant_id,"childThreadId":child.child_thread_id}),
                handoff,
                HOST,
                GENERATION,
                &review.f.storage_root.to_string_lossy(),
                EPOCH,
            )
            .unwrap();
        assert!(storage
            .authorize(
                Some(&grant_id),
                EPOCH,
                HOST,
                GENERATION,
                "branch.read",
                &json!({"branchId":parent.source.branch_id,"revision":1,"includeEntries":true})
            )
            .is_err());
    }
    let branch = format!("child-source:{}", child.operation_id);
    let operation = format!("branch-create:{branch}");
    storage_call(
        review,
        &grant_id,
        "branch.create.begin",
        json!({"operationId":operation,"builderId":operation,
        "workspaceId":parent.source.workspace_id,"branchId":branch,"baseRef":parent.root,"draftBasePaths":[],"captureScopes":[]}),
    );
    storage_call(
        review,
        &grant_id,
        "branch.create.finish",
        json!({"operationId":operation,"builderId":operation}),
    );
    let pinned = storage_call(
        review,
        &grant_id,
        "branch.pin",
        json!({"operationId":format!("pin:{}",child.operation_id),
        "branchId":branch,"revision":0,"pinId":format!("child-source-pin:{}",child.operation_id)}),
    );
    assert_eq!(pinned["root"], parent.root);
    let mut source = parent.source.clone();
    source.mode = mode;
    source.branch_id = Some(branch);
    source.revision = Some(0);
    let mut pin_source = source.clone();
    pin_source.mode = SourceMode::FixedBranch;
    let owner = review.f.runtime.catalog();
    let candidate = owner
        .lock()
        .unwrap()
        .prepare_child_source(
            &child.operation_id,
            ChildSourcePin {
                pin_id: pinned["pinId"].as_str().unwrap().into(),
                root: parent.root.clone(),
                source: pin_source,
            },
            source.clone(),
            ChildSourceProvenance::FixedRoot {
                root: parent.root.clone(),
                resources: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    owner
        .lock()
        .unwrap()
        .attach_child_source(candidate)
        .unwrap();
    let proposal = serde_json::from_value(json!({"key":format!("context:{}",child.operation_id),"branch_id":child.child_branch_id,
        "through_id":null,"expected_revision":0,"summary":"","effective_system_prompt":"Inspect only the admitted child source.","instruction_sources":[],"memory_checkpoint":null})).unwrap();
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"child-language-review",
        "memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":null,"originalSections":[],"instructionSources":[]})).unwrap();
    let prepared = owner
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
    prepared
}

#[test]
#[ignore = "requires bundled TypeScript and fresh process worker; original child dispatch/Run over stdio"]
fn default_fixed_and_materialized_children_execute_language_and_retain_reports_after_reopen() {
    for (preset, mode) in [
        ("retrieval", SourceMode::FixedBranch),
        ("worker", SourceMode::Materialized),
    ] {
        let root = std::env::temp_dir().join(format!(
            "varin-child-language-{preset}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut review = Review::open_with_script(
            &root,
            "packages/web/application-host/lib/kernel/child-language-host.test-helper.ts",
        );
        review.f.host.send(json!({"kind":"fixture-initialize","root":root,"storageRoot":review.f.storage_root,"epoch":EPOCH,"mode":"fixed_branch"}));
        let prepared = review.receive("fixture-prepared");
        review.child_catalog =
            Some(serde_json::from_value(prepared["childCatalog"].clone()).unwrap());
        review.child_model = Some(serde_json::from_value(prepared["parent"].clone()).unwrap());
        let parent_source = serde_json::to_value(
            serde_json::from_value::<SourceSelection>(prepared["source"].clone()).unwrap(),
        )
        .unwrap();
        let parent_run = admit_dispatch(&review, &parent_source);
        let (parent_binding, _) = review.select(&parent_run, &parent_source);
        let accepted = dispatch_child(&mut review, &parent_run, parent_binding.clone(), preset);
        let child = prepare_child_source(&review, &accepted, mode);
        let run = child.receipt.as_ref().unwrap().run_id.clone();
        let launch = review
            .f
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection;
        let source = serde_json::to_value(launch.source.clone().unwrap()).unwrap();
        let (mut child_binding, selected) = review.select(&run, &source);
        child_binding.enabled_tools = ToolKind::all()
            .filter(|kind| {
                launch
                    .tools
                    .iter()
                    .any(|schema| schema.name == serde_json::to_value(kind).unwrap())
            })
            .collect();
        assert_ne!(child_binding.grant_id, parent_binding.grant_id);
        assert_ne!(child_binding.run_id, parent_binding.run_id);
        assert_eq!(child_binding.thread_id, child.child_thread_id);
        assert_eq!(
            child_binding.source_selection().unwrap(),
            launch.source.unwrap()
        );
        let results =
            review.execute_with_provider(&run, child_binding.clone(), true, Arc::new(ChildModel));
        assert_results(&results, &selected, &source, false);
        review.f.host.send(json!({"kind":"fixture-child-audit"}));
        review.receive("fixture-child-audited");
        let owner = review.f.runtime.catalog();
        let (parent_history, history, report, terminal_child) = {
            let mut db = owner.lock().unwrap();
            db.reconcile_child_reports().unwrap();
            let terminal = db.child_task(&child.operation_id).unwrap();
            if mode == SourceMode::Materialized {
                assert!(
                    matches!(
                        terminal.code_result,
                        ChildCodeResult::Pending | ChildCodeResult::Settling { .. }
                    ),
                    "this fixture does not execute Host code-result settlement: {:?}",
                    terminal.code_result
                );
            }
            let report = terminal
                .report
                .clone()
                .expect("the actual child Run produces an original report");
            assert_eq!(report.outcome, Outcome::Succeeded);
            assert_eq!(report.sender_thread_id, child.child_thread_id);
            assert_eq!(report.run_id.as_deref(), Some(run.as_str()));
            assert_eq!(report.history_ids.len(), 1);
            let page = db
                .read_child_report(&child.operation_id, &report.history_ids[0], 0, 65536)
                .unwrap();
            assert!(page.text.starts_with("CHILD_LANGUAGE_REPORT:"));
            let history = db.execution_history(&child.child_branch_id).unwrap();
            assert!(history.iter().any(|item| matches!(&item.content, Content::Text { text } if text.starts_with("CHILD_LANGUAGE_REPORT:"))));
            assert_eq!(db.run(&run).unwrap().state, RunState::Completed);
            (
                db.execution_history(BRANCH).unwrap(),
                history,
                report,
                terminal,
            )
        };
        review
            .f
            .host
            .send(json!({"kind":"fixture-drain","runId":run}));
        review.receive("fixture-drained");
        if mode == SourceMode::Materialized {
            assert!(review.root_idle(&child_binding));
        } else {
            let derived = PathBuf::from(
                results[0]["source"]["derivedView"]["canonicalRoot"]
                    .as_str()
                    .unwrap(),
            );
            assert!(
                !derived.exists(),
                "the original fixed service lease must clean its stopped derived view"
            );
        }
        review
            .f
            .host
            .send(json!({"kind":"fixture-release","grantId":child_binding.grant_id}));
        review.receive("fixture-released");
        review
            .f
            .host
            .send(json!({"kind":"fixture-release","grantId":parent_binding.grant_id}));
        review.receive("fixture-released");
        let collection = owner
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default());
        assert_eq!(
            collection.run().status,
            varin_runtime::ContentCollectionStatus::Completed
        );
        review.f.host.send(json!({"kind":"fixture-gc"}));
        review.receive("fixture-gc-finished");
        review.f.host.send(json!({"kind":"fixture-finish"}));
        let finished = review.receive("fixture-finished");
        assert_eq!(finished["sourceQueries"], SCRIPT_CALLS);
        assert_eq!(finished["processSpawns"], 1);
        let storage_root = review.f.storage_root.clone();
        drop(owner);
        drop(review);
        let db = Catalog::open(root.join("catalog")).unwrap();
        assert_eq!(db.execution_history(BRANCH).unwrap(), parent_history);
        assert_eq!(
            db.execution_history(&child.child_branch_id).unwrap(),
            history
        );
        let reopened = db.child_task(&child.operation_id).unwrap();
        let page = db
            .read_child_report(&child.operation_id, &report.history_ids[0], 0, 65536)
            .unwrap();
        assert!(page.text.starts_with("CHILD_LANGUAGE_REPORT:"));
        assert_eq!(reopened.report, Some(report));
        assert_eq!(reopened, terminal_child);
        let mut storage = Storage::open(&storage_root, HOST).unwrap();
        assert!(storage.issue_grant(&json!({"grantId":"child-reopen-audit","hostGeneration":GENERATION,"owningWorkspace":source["workspace_id"],
            "executionWorkspace":source["execution_workspace_id"],"capabilities":["storage.read"],"pathScopes":[""]}), HOST, GENERATION,
            &storage_root.to_string_lossy(), EPOCH).is_ok());
        let params = json!({"branchId":source["branch_id"],"revision":0,"includeEntries":false});
        let (grant, params) = storage
            .authorize(
                Some("child-reopen-audit"),
                EPOCH,
                HOST,
                GENERATION,
                "branch.read",
                &params,
            )
            .unwrap();
        let original = storage
            .dispatch("branch.read", &params, Some("child-reopen-audit"), &grant)
            .unwrap();
        assert_eq!(original["root"], child.source.pin().unwrap().root);
        drop(storage);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
