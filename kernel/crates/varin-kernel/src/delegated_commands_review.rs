//! Actual typed Kernel commands, Catalog and RunAssembly. Source bytes and private
//! Host bridges are controlled fixtures; this does not claim Unix IPC or provider execution.
use super::*;
use crate::run_assembly::{PreparedLaunch, RunAssembly, RunPreparation};
use varin_runtime::execution::*;
use varin_runtime::{RunState, SourceMode};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;
use admission::InputAdmission;
#[test]
fn public_continuation_source_prepare_and_exact_run_assembly_share_one_execution_owner() {
    let selected = vec!["child_status".into(), "child_report".into()];
    let mut f = fixture::Fixture::new_host_child_with_native(
        false,
        false,
        None,
        selected,
        crate::collaboration::schemas(vec![], false)
            .into_iter()
            .filter(|tool| matches!(tool.name.as_str(), "child_status" | "child_report"))
            .collect(),
    );
    f.launch.policy = crate::process_wait::default_policy_identity();
    f.launch
        .tools
        .sort_by(|left, right| left.name.cmp(&right.name));
    let child = f.accept();
    f.settle_exchange();
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal=serde_json::from_value(json!({"key":"child-context","branch_id":child.child_branch_id,"through_id":null,"expected_revision":0,"summary":"","effective_system_prompt":"Original worker","instruction_sources":[],"memory_checkpoint":null})).unwrap();
    let basis:varin_runtime::catalog::personalization::PersonalizationBasis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"original-worker","memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":child.project_id,"originalSections":[],"instructionSources":[]})).unwrap();
    let child =
        f.db.prepare_child(&child.execution_id, source, proposal, basis.clone())
            .unwrap();
    let first = child.receipt.as_ref().unwrap().run_id.clone();
    f.db.commit_execution(
        &first,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    f.db.commit_execution(
        &first,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    f.db.reconcile_child_reports().unwrap();
    let original = f.db.child_task(&child.operation_id).unwrap();
    let expected_head = f.db.head(&child.child_branch_id).unwrap();
    let checkpoint =
        f.db.capture_active_checkpoint(&child.child_branch_id)
            .unwrap()
            .unwrap()
            .id;
    let runtime = Arc::new(RunSupervisor::new(f.db));
    let resources = crate::tools::KernelResourceClient::new(
        |_| Err(KernelError::Operation("no source effect requested".into())),
        |_| Ok(()),
        Default::default(),
    );
    let call = |method: &str, params: Value| {
        execute(
            runtime.clone(),
            resources.clone(),
            method,
            params,
            &AtomicBool::new(false),
        )
        .unwrap()
    };
    let command = json!({"key":"continue-user","childOperationId":child.operation_id,"previousRunId":first,"expectedHead":expected_head,"input":{"text":"Continue explicitly","attachments":[{"media_type":"image/png","content_ref":"user-image"}]}});
    let accepted = call("runtime.child.continuation.accept", command.clone());
    let execution = accepted["execution_id"].as_str().unwrap();
    assert_eq!(accepted["source"], Value::Null);
    assert_eq!(call("runtime.child.continuation.accept", command), accepted);
    let selected = &accepted["source_basis"]["source"];
    let source = json!({"workspaceId":selected["workspace_id"],"executionWorkspaceId":selected["execution_workspace_id"],"mode":"fixed_branch","branchId":format!("child-source:{execution}"),"revision":0});
    let pin_source = json!({"workspace_id":selected["workspace_id"],"execution_workspace_id":selected["execution_workspace_id"],"live_root":null,"mode":"fixed_branch","branch_id":format!("child-source:{execution}"),"revision":0});
    call(
        "runtime.child.source.ready",
        json!({"executionId":execution,"pin":{"pin_id":format!("child-source-pin:{execution}"),"root":accepted["source_basis"]["root"],"source":pin_source},"source":source,"provenance":accepted["source_basis"]["provenance"]}),
    );
    let prepared=super::super::input_commands::execute(runtime.clone(),"runtime.child.prepare",json!({"executionId":execution,"source":source,"expectedContextCheckpoint":checkpoint,"context":{"effectiveSystemPrompt":"Original worker","instructionSources":[],"memoryCheckpoint":null,"personalization":basis}}),Arc::new(AtomicBool::new(false)),None).unwrap();
    let run_id = prepared["receipt"]["run_id"].as_str().unwrap();
    assert_ne!(run_id, first);
    assert_eq!(
        call("runtime.child.execution.for_run", json!({"runId":run_id})),
        prepared
    );
    assert_eq!(
        call(
            "runtime.child.execution.list",
            json!({"childOperationId":child.operation_id})
        )
        .as_array()
        .unwrap()
        .len(),
        2
    );
    assert!(execute(
        runtime.clone(),
        resources.clone(),
        "runtime.child.prepare",
        json!({"operationId":child.operation_id}),
        &AtomicBool::new(false)
    )
    .is_err());
    let catalog = runtime.catalog();
    let run = catalog.lock().unwrap().run(run_id).unwrap();
    let launch = catalog
        .lock()
        .unwrap()
        .capture_launch(run_id)
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
    assert!(!launch.policy_preparable);
    assert_eq!(launch.policy_generation, 0);
    let (output, _frames) = std::sync::mpsc::sync_channel(128);
    let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
    credentials.initialize("delegated-test").unwrap();
    let bridge = crate::host_tools::ToolBridge::new(output.clone().into());
    bridge.initialize("delegated-test");
    let policy = crate::policy::PolicyBridge::new(output.clone());
    policy.initialize("delegated-test");
    policy.set_catalog(catalog.clone());
    let memory = crate::host_query::OwnerChannel::new("memory", output.clone());
    memory.initialize("delegated-test");
    let plan = crate::plan_bridge::PlanBridge::new(output.clone());
    plan.initialize("delegated-test");
    let assembly = RunAssembly {
        runtime: runtime.clone(),
        resources,
        credentials: credentials.clone(),
        language: crate::language::LanguageBridge::new(output.clone()),
        retrieval: crate::retrieval::RetrievalBridge::new(output.clone()),
        memory,
        context: crate::host_query::OwnerChannel::new("context", output.clone()),
        resource: crate::host_query::OwnerChannel::new("resource", output.clone()),
        plan,
        policy,
        models: crate::run_models::RunModels::new(catalog.clone(), credentials),
        tools: crate::run_tools::RunTools::new(catalog.clone(), bridge),
        responses: output.into(),
        epoch: "delegated-test".into(),
    };
    let params=serde_json::from_value(json!({"runId":run_id,"credentialScope":launch.selection.credential_scope,"toolBinding":{"grantId":"fresh-source-grant","runId":run_id,"threadId":child.child_thread_id,"workspaceId":selected["workspace_id"],"executionWorkspaceId":selected["execution_workspace_id"],"sourceMode":"fixed_branch","fileSource":{"branchId":format!("child-source:{execution}"),"revision":0},"enabledTools":[]}})).unwrap();
    let PreparedLaunch::Start(start) = assembly
        .prepare(RunPreparation::new(params, &run).unwrap(), None, || false)
        .unwrap()
    else {
        panic!("start required")
    };
    assert_eq!(start.binding.tools, launch.selection.tools);
    assert!(start.binding.tools.iter().all(|tool| tool.version == "2"));
    assert_eq!(
        catalog
            .lock()
            .unwrap()
            .child_task(&child.operation_id)
            .unwrap(),
        original
    );
    assert_eq!(
        catalog
            .lock()
            .unwrap()
            .launch_metadata(run_id)
            .unwrap()
            .unwrap()
            .selection
            .source
            .as_ref()
            .unwrap()
            .mode,
        SourceMode::FixedBranch
    );
    drop(start);
    drop(assembly);
    drop(catalog);
    drop(runtime);
    std::fs::remove_dir_all(f.root).unwrap();
}
