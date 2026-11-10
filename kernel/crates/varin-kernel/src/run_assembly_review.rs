//! The actual child assembly, retained Host directory and owner frames, without a model or IPC server.
use super::*;
use std::sync::mpsc;
use std::time::Duration;
use varin_runtime::execution::*;
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;
use admission::InputAdmission;

fn assembly(runtime:Arc<RunSupervisor>)->(RunAssembly,mpsc::Receiver<Value>) {
    let (output, frames) = mpsc::sync_channel(64);
    let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
    credentials.initialize("child-test").unwrap();
    let bridge = crate::host_tools::ToolBridge::new(output.clone().into());
    bridge.initialize("child-test");
    let assembly = RunAssembly {
        runtime: runtime.clone(),
        resources: crate::tools::KernelResourceClient::new(
            |_| Err(KernelError::Operation("unrequested source effect".into())),
            |_| Ok(()),
            Default::default(),
        ),
        credentials: credentials.clone(),
        language: crate::language::LanguageBridge::new(output.clone()),
        memory: crate::host_query::OwnerChannel::new("memory", output.clone()),
        context: crate::host_query::OwnerChannel::new("context", output.clone()),
        resource: crate::host_query::OwnerChannel::new("resource", output.clone()),
        plan: crate::plan_bridge::PlanBridge::new(output.clone()),
        policy: crate::policy::PolicyBridge::new(output.clone()),
        models: crate::run_models::RunModels::new(runtime.catalog(), credentials),
        tools: crate::run_tools::RunTools::new(runtime.catalog(), bridge),
        driver: crate::driver_bridge::DriverBridge::new(output.clone()), responses: output.into(),
        epoch: "child-test".into(),
    };
    assembly.policy.initialize("child-test");
    assembly.policy.set_catalog(runtime.catalog());
    (assembly,frames)
}

#[test]
fn child_assembly_rebinds_only_admitted_extension_and_activates_its_own_static_owner() {
    let mut f = fixture::Fixture::new_host_child(false, None, vec!["helper".into()]);
    f.launch.policy = crate::observations::default_policy_identity();
    let child = f.accept();
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: "child-context".into(),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Child".into(),
        instruction_sources: vec!["fixture:child".into()],
        memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"fixture:child","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Child"}],"instructionSources":["fixture:child"]})).unwrap();
    let child =
        f.db.prepare_child(&child.operation_id, source.clone(), proposal, basis)
            .unwrap();
    let run = f.db.run(&child.receipt.unwrap().run_id).unwrap();
    let launch = f.db.launch_intent(&run.id).unwrap().unwrap().selection;
    let root = f.root.clone();
    let runtime = Arc::new(RunSupervisor::new(f.db));
    let (assembly,frames)=assembly(runtime.clone());
    let params = json!({"runId":run.id,"credentialScope":launch.credential_scope,
        "toolBinding":{"resourceOwner":{"kind":"local"},"grantId":"child-source-grant","runId":run.id,"threadId":run.thread_id,
            "workspaceId":source.workspace_id,"executionWorkspaceId":source.execution_workspace_id,
            "sourceMode":"fixed_branch","fileSource":{"branchId":source.branch_id,"revision":source.revision},"enabledTools":[]},
        "extensionBindings":[{"ownerId":"child-host-owner","generation":1,"binding":launch.extension_bindings[0]}]});
    for mutation in [
        "missing",
        "artifact",
        "configuration",
        "schema-version",
        "schema-name",
        "schema-body",
        "expanded",
        "foreign-source",
    ] {
        let mut wrong = params.clone();
        match mutation {
            "missing" => {
                wrong.as_object_mut().unwrap().remove("extensionBindings");
            }
            "artifact" => {
                wrong["extensionBindings"][0]["binding"]["artifactIntegrity"] = json!("latest")
            }
            "configuration" => {
                wrong["extensionBindings"][0]["binding"]["configurationIdentity"] =
                    json!("different")
            }
            "schema-version" => wrong["extensionBindings"][0]["binding"]["tool"]["version"] = json!("2"),
            "schema-name" => wrong["extensionBindings"][0]["binding"]["tool"]["name"] = json!("memory"),
            "schema-body" => wrong["extensionBindings"][0]["binding"]["tool"]["schema"] = json!({"type":"object","properties":{"extra":{"type":"string"}}}),
            "expanded" => {
                let extra = wrong["extensionBindings"][0].clone();
                wrong["extensionBindings"]
                    .as_array_mut()
                    .unwrap()
                    .push(extra);
            }
            _ => wrong["toolBinding"]["fileSource"]["branchId"] = json!("parent-source"),
        }
        let prepared = RunPreparation::new(serde_json::from_value(wrong).unwrap(), &run).unwrap();
        assert!(
            assembly.prepare(prepared, None, || false).is_err(),
            "{mutation}"
        );
    }
    let start = assembly
        .prepare(
            RunPreparation::new(serde_json::from_value(params).unwrap(), &run).unwrap(),
            None,
            || false,
        )
        .unwrap();
    let PreparedLaunch::Start(start) = start else {
        panic!("child start required")
    };
    assert_eq!(start.binding.tools, launch.tools);
    assert!(
        start
            .tools
            .select_for_request(
                &run.id,
                runtime.catalog().lock().unwrap().epoch(),
                &CancellationToken::default()
            )
            .unwrap()
            .is_none(),
        "child selection is frozen"
    );
    loop {
        let frame = frames.recv_timeout(Duration::from_secs(5)).unwrap();
        if frame["kind"] == "host-tool-binding-activate" {
            assert_eq!(frame["runId"], run.id);
            assert_eq!(frame["ownerId"], "child-host-owner");
            break;
        }
    }
    let call = ToolCall {
        call_id: "child-call".into(),
        name: "helper".into(),
        schema_version: launch.tools[0].version.clone(),
        arguments: json!({}),
    };
    let mut frozen = FrozenToolContext { tool_output_visible_bytes: None, execution_environment: None, direct_tools: None,
        run_id: run.id.clone(),
        origin: ToolOrigin::ModelStep {
            request_id: "not-dispatched-request".into(),
        },
        tool_schema_generation: start.binding.tool_schema_generation,
        tools: Arc::new(start.binding.tools.clone()),
        source: Some(source),
        child_dispatch: None,
        resource_checkpoint_id: None,
        resource_activations: Vec::new(),
    };
    assert!(start
        .tools
        .prepare(&call, &frozen, &CancellationToken::default())
        .is_ok());
    frozen.run_id = f.context.run_id;
    assert!(
        start
            .tools
            .prepare(&call, &frozen, &CancellationToken::default())
            .is_err(),
        "parent cannot borrow child owner"
    );
    drop(start);
    drop(assembly);
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}


#[test]
fn hybrid_file_read_can_be_selected_without_granting_a_source() {
    let root=std::env::temp_dir().join(format!("source-free-reader-{}",uuid::Uuid::new_v4()));
    let mut catalog=varin_runtime::Catalog::open(&root).unwrap();
    catalog.create_thread("thread","branch").unwrap();
    let receipt=catalog.submit(&varin_runtime::SubmitInput {key:"input".into(),thread_id:"thread".into(),branch_id:"branch".into(),expected_head:None,
        input:json!("Read an attachment"),configuration:json!({"providerFamily":"openai-responses","endpoint":"https://fixture.invalid/responses","allowAnonymous":true,"model":"fixture","configurationGeneration":1})}).unwrap();
    let run=catalog.run(&receipt.run_id).unwrap();
    let runtime=Arc::new(RunSupervisor::new(catalog));
    let (assembly,_frames)=assembly(runtime.clone());
    let prepare=|tools:Value| {
        let params=RunPreparation::new(serde_json::from_value(json!({"runId":run.id})).unwrap(),&run).unwrap();
        let selected=serde_json::from_value(json!({"runId":run.id,"source":null,"enabledTools":tools})).unwrap();
        assembly.prepare(params,Some(selected),||false)
    };
    assert!(prepare(json!(["file_read","file_write"])).is_err(),"source-free selection must not authorize mutations");
    let PreparedLaunch::Selection(selected)=prepare(json!(["file_read"])).unwrap() else {panic!("selection receipt required")};
    assert!(selected["selection"]["source"].is_null());
    assert!(selected["selection"]["tools"].as_array().unwrap().iter().any(|tool|tool["name"]=="file_read"));
    drop(assembly);drop(runtime);std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn calendar_new_round_refreshes_selected_builtins_without_rewriting_prior_launch() {
    use varin_runtime::catalog::{calendar, context::ContextProposal, launches::{ExtensionAdmissionState, LaunchSelection}};
    use varin_runtime::{Catalog, RunState, SubmitInput};

    let fixed_branch = serde_json::from_value(json!({
        "resource_owner":{"kind":"local"},"workspace_id":"workspace","execution_workspace_id":"workspace",
        "mode":"fixed_branch","branch_id":"files","revision":0,"live_root":null,
    })).unwrap();
    for source in [None, Some(fixed_branch)] {
        let root = std::env::temp_dir().join(format!("calendar-launch-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog
            .create_thread("thread:calendar", "branch:calendar")
            .unwrap();
        let configuration = json!({"providerFamily":"openai-responses","endpoint":"https://fixture.invalid/responses",
        "allowAnonymous":true,"model":"fixture","configurationGeneration":1});
        let mut binding =
            model_session::bind(serde_json::from_value(configuration.clone()).unwrap())
                .unwrap()
                .binding;
        let enabled = if source.is_some() {
            [crate::tools::ToolKind::FileList].into_iter().collect()
        } else {
            Default::default()
        };
        binding.tools = crate::run_tools::builtin_schemas(&enabled, true, true, false);
        // A completed older execution selected this name, but not the later directory's
        // complete capabilities. Its stored declaration is immutable after an upgrade.
        binding.tools.retain(|tool| tool.name != "tool_describe");
        binding
            .tools
            .iter_mut()
            .find(|tool| tool.name == "file_read")
            .unwrap()
            .description = "Previously selected attachment reader".into();
        let old_selection = LaunchSelection::from_binding(
            &binding,
            crate::observations::default_policy_identity(),
            source.clone(),
        );
        let previous = catalog.submit_with_context_snapshot(&SubmitInput {
        key: "previous-round".into(), thread_id: "thread:calendar".into(), branch_id: "branch:calendar".into(),
        expected_head: None, input: json!("Original work"), configuration,
    }, Some(old_selection), false, Some(ContextProposal {
        key: "initial".into(), branch_id: "branch:calendar".into(), through_id: None, expected_revision: 0,
        summary: String::new(), effective_system_prompt: "Calendar work".into(), instruction_sources: vec![], memory_checkpoint: None,
    }), Some(serde_json::from_value(json!({"mode":"agent","threadRole":"main","revision":1,
        "configurationDigest":"calendar","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":"thread:calendar","projectId":"project","originalSections":[{"name":"system","content":"Calendar work"}],
        "instructionSources":[]})).unwrap())).unwrap();
        for state in [RunState::Preparing, RunState::Runnable, RunState::Completed] {
            let run = catalog.run(&previous.run_id).unwrap();
            catalog
                .transition_run(&run.id, catalog.epoch(), run.revision, state)
                .unwrap();
        }
        let original = catalog.launch_intent(&previous.run_id).unwrap().unwrap();
        let definition = serde_json::from_value(json!({"taskId":"calendar","assetRevision":"1","assetKind":"gui",
        "name":"Continue original work","enabled":false,"timezone":"UTC","rule":{"kind":"daily","times":["09:00"]},
        "missedPolicy":"skip","target":{"kind":"existing_work","threadId":"thread:calendar","branchId":"branch:calendar"},
        "instruction":"A genuinely new scheduled round"})).unwrap();
        let prepared = catalog
            .prepare_calendar_sync("project".into(), None, vec![definition])
            .unwrap()
            .load()
            .unwrap();
        let definition = catalog
            .admit_calendar_sync(prepared)
            .unwrap()
            .definitions
            .remove(0);
        let occurrence = catalog
            .run_calendar_now(&definition.id, definition.revision, "scheduled-round")
            .unwrap();
        let runtime = Arc::new(RunSupervisor::new(
            catalog.with_ingress_tool_catalog(crate::run_tools::ingress_schemas),
        ));
        calendar::reconcile(&runtime.catalog()).unwrap();
        // Follow-up reconciliation also activates queued ingress; it must not bypass
        // the executable catalogue when it wins the race with the message wake pass.
        varin_runtime::catalog::followups::reconcile(&runtime.catalog()).unwrap();
        runtime.reconcile_message_requests().unwrap();
        let run = {
            let owner = runtime.catalog();
            let catalog = owner.lock().unwrap();
            let occurrence = catalog.calendar_occurrence(&occurrence.id).unwrap();
            catalog.run(occurrence.run_id.as_ref().unwrap()).unwrap()
        };
        assert_ne!(run.id, previous.run_id);
        // The production Host commits current extension discovery before run.start.
        // This kernel-only fixture has no extension tools, but empty is still an
        // explicit preparation result, not permission for assembly to skip Pending.
        let preparation = {
            let owner = runtime.catalog();
            let mut catalog = owner.lock().unwrap();
            let pending = catalog.launch_intent(&run.id).unwrap().unwrap();
            assert_eq!(pending.extension_admission.unwrap().state, ExtensionAdmissionState::Pending);
            assert!(catalog.bind_launch(&run.id, pending.selection).unwrap_err().to_string()
                .contains("current extension directory is not prepared"));
            catalog.prepare_extensions_change(&run.id, vec![]).unwrap()
        };
        let prepared = preparation.load().unwrap();
        let read = runtime.catalog().lock().unwrap().admit_launch_change(prepared).unwrap();
        assert_eq!(read.load().unwrap().extension_admission.unwrap().state, ExtensionAdmissionState::Prepared);
        let (assembly, _frames) = assembly(runtime.clone());
        let mut params = json!({"runId":run.id});
        if let Some(source) = &source {
            params["toolBinding"] = json!({"resourceOwner":{"kind":"local"},"grantId":"calendar-source","runId":run.id,"threadId":run.thread_id,
            "workspaceId":source.workspace_id,"executionWorkspaceId":source.execution_workspace_id,"sourceMode":"fixed_branch",
            "fileSource":{"branchId":source.branch_id,"revision":source.revision},"enabledTools":["file_list"]});
        }
        let params = RunPreparation::new(serde_json::from_value(params).unwrap(), &run).unwrap();
        let PreparedLaunch::Start(start) = assembly
            .prepare(params, None, || false)
            .unwrap_or_else(|error| panic!("calendar assembly failed: {error}"))
        else {
            panic!("Run start required")
        };
        assert!(!start
            .binding
            .tools
            .iter()
            .any(|tool| tool.name == "tool_describe"));
        let mut expected = original.selection.clone();
        expected.tools = crate::run_tools::builtin_schemas(&enabled, true, true, false);
        expected.tools.retain(|tool| tool.name != "tool_describe");
        assert_eq!(start.binding.tools, expected.tools);
        let owner = runtime.catalog();
        let mut catalog = owner.lock().unwrap();
        assert_eq!(
            catalog.launch_intent(&previous.run_id).unwrap().unwrap(),
            original
        );
        assert_eq!(
            catalog.launch_intent(&run.id).unwrap().unwrap().selection,
            expected
        );
        let mut replacement = expected.clone();
        replacement
            .tools
            .iter_mut()
            .find(|tool| tool.name == "file_read")
            .unwrap()
            .description = "Changed after admission".into();
        assert!(catalog
            .bind_launch(&run.id, replacement)
            .unwrap_err()
            .to_string()
            .contains("rebind must preserve its frozen identity"));
        assert_eq!(
            catalog
                .run_calendar_now(&definition.id, definition.revision, "scheduled-round")
                .unwrap()
                .id,
            occurrence.id
        );
        for state in [RunState::Preparing, RunState::Runnable, RunState::Completed] {
            let current = catalog.run(&run.id).unwrap();
            let epoch = catalog.epoch();
            catalog
                .transition_run(&run.id, epoch, current.revision, state)
                .unwrap();
        }
        drop(catalog);
        drop(owner);
        assembly.tools.release(&run.id);
        drop(start);
        drop(assembly);
        drop(runtime);
        let mut reopened = Catalog::open(&root).unwrap();
        let replay = reopened
            .run_calendar_now(&definition.id, definition.revision, "scheduled-round")
            .unwrap();
        assert_eq!(replay.id, occurrence.id);
        assert_eq!(replay.run_id.as_deref(), Some(run.id.as_str()));
        assert_eq!(
            reopened.launch_intent(&run.id).unwrap().unwrap().selection,
            expected
        );
        assert_eq!(
            reopened
                .launch_intent(&previous.run_id)
                .unwrap()
                .unwrap()
                .selection,
            original.selection
        );
        assert_eq!(reopened.history("branch:calendar").unwrap().len(), 2);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
