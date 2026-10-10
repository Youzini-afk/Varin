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

#[test]
fn child_assembly_rebinds_only_admitted_extension_and_activates_its_own_static_owner() {
    let mut f = fixture::Fixture::new_host_child(false, None, vec!["helper".into()]);
    f.launch.policy = crate::process_wait::default_policy_identity();
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
        "sessionId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Child"}],"instructionSources":["fixture:child"]})).unwrap();
    let child =
        f.db.prepare_child(&child.operation_id, source.clone(), proposal, basis)
            .unwrap();
    let run = f.db.run(&child.receipt.unwrap().run_id).unwrap();
    let launch = f.db.launch_intent(&run.id).unwrap().unwrap().selection;
    let root = f.root.clone();
    let runtime = Arc::new(RunSupervisor::new(f.db));
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
        retrieval: crate::retrieval::RetrievalBridge::new(output.clone()),
        memory: crate::host_query::OwnerChannel::new("memory", output.clone()),
        context: crate::host_query::OwnerChannel::new("context", output.clone()),
        resource: crate::host_query::OwnerChannel::new("resource", output.clone()),
        plan: crate::plan_bridge::PlanBridge::new(output.clone()),
        policy: crate::policy::PolicyBridge::new(output.clone()),
        models: crate::run_models::RunModels::new(runtime.catalog(), credentials),
        tools: crate::run_tools::RunTools::new(runtime.catalog(), bridge),
        responses: output.into(),
        epoch: "child-test".into(),
    };
    assembly.policy.initialize("child-test");
    assembly.policy.set_catalog(runtime.catalog());
    let params = json!({"runId":run.id,"credentialScope":launch.credential_scope,
        "toolBinding":{"grantId":"child-source-grant","runId":run.id,"threadId":run.thread_id,
            "workspaceId":source.workspace_id,"executionWorkspaceId":source.execution_workspace_id,
            "sourceMode":"fixed_branch","fileSource":{"branchId":source.branch_id,"revision":source.revision},"enabledTools":[]},
        "extensionBindings":[{"ownerId":"child-host-owner","generation":1,"binding":launch.extension_bindings[0]}]});
    for mutation in [
        "missing",
        "artifact",
        "configuration",
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
    let mut frozen = FrozenToolContext {
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
