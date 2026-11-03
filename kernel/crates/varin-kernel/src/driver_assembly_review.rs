//! Real launch/driver assembly preserves a dormant policy without borrowing its live owners.
use crate::run_assembly::{PreparedLaunch, RunAssembly, RunPreparation};
use serde_json::{json, Value};
use std::{
    sync::{mpsc, Arc},
    time::Duration,
};
use varin_runtime::{
    catalog::{
        launches::LaunchSelection,
        policy_switch::{AgentPolicyArtifactBinding, PolicyStateTransition, PolicyTarget},
    },
    driver::{DriverArtifact, DriverRecovery, DriverSelection},
    execution::*,
    supervisor::{RunStart, RunSupervisor},
    Catalog, Run, RunState, SubmitInput,
};

#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;

const EPOCH: &str = "dormant-policy-driver-review";

fn assembly(db: Catalog) -> (RunAssembly, mpsc::Receiver<Value>) {
    let runtime = Arc::new(RunSupervisor::new(db));
    let (output, frames) = mpsc::sync_channel(64);
    let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
    credentials.initialize(EPOCH).unwrap();
    let tools = crate::host_tools::ToolBridge::new(output.clone().into());
    tools.initialize(EPOCH);
    let policy = crate::policy::PolicyBridge::new(output.clone());
    policy.initialize(EPOCH);
    policy.set_catalog(runtime.catalog());
    let driver = crate::driver_bridge::DriverBridge::new(output.clone());
    driver.initialize(EPOCH);
    let assembly = RunAssembly {
        runtime: runtime.clone(),
        resources: crate::tools::KernelResourceClient::new(
            |_| panic!("this source-free driver must not request a resource effect"),
            |_| Ok(()),
            Default::default(),
        ),
        credentials: credentials.clone(),
        language: crate::language::LanguageBridge::new(output.clone()),
        memory: crate::host_query::OwnerChannel::new("memory", output.clone()),
        context: crate::host_query::OwnerChannel::new("context", output.clone()),
        resource: crate::host_query::OwnerChannel::new("resource", output.clone()),
        plan: crate::plan_bridge::PlanBridge::new(output.clone()),
        policy,
        driver,
        models: crate::run_models::RunModels::new(runtime.catalog(), credentials),
        tools: crate::run_tools::RunTools::new(runtime.catalog(), tools),
        responses: output.into(),
        epoch: EPOCH.into(),
    };
    (assembly, frames)
}

fn original_selection(assembly: &RunAssembly, run: &str) -> LaunchSelection {
    let read = assembly
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_launch(run)
        .unwrap()
        .unwrap();
    read.load().unwrap().selection
}

fn start(assembly: &RunAssembly, run: &Run, artifact: &DriverArtifact) -> RunStart {
    let params = serde_json::from_value(json!({
        "runId":run.id,
        "driverBinding":{"reference":"original-driver-reference","artifact":artifact}
    }))
    .unwrap();
    let PreparedLaunch::Start(start) = assembly
        .prepare(RunPreparation::new(params, run).unwrap(), None, || false)
        .unwrap()
    else {
        panic!("actual RunAssembly must prepare the original custom driver")
    };
    start
}

fn assert_no_dormant_request(frame: &Value) {
    let kind = frame["kind"].as_str().unwrap();
    assert!(
        kind != "credential-request" && !kind.starts_with("agent-policy-"),
        "a dormant policy must not acquire credentials or execute a callback: {kind}"
    );
}

#[test]
fn custom_driver_assembly_rebinds_original_available_dormant_policy_without_live_owners() {
    let root = std::env::temp_dir().join(format!("varin-driver-assembly-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "main").unwrap();
    let submitted = db
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!({"text":"Use the independently selected driver"}),
            configuration: json!({"providerFamily":"openai-responses","model":"unused-primary",
            "endpoint":"http://127.0.0.1:1/unused-primary","allowAnonymous":true,
            "configurationGeneration":1,"maxOutputTokens":100}),
        })
        .unwrap();
    let run = db.run(&submitted.run_id).unwrap();
    let (first, first_frames) = assembly(db);
    let selected = first
        .prepare(
            RunPreparation::new(
                serde_json::from_value(json!({"runId":run.id})).unwrap(),
                &run,
            )
            .unwrap(),
            Some(
                serde_json::from_value(json!({"runId":run.id,"source":null,"enabledTools":[]}))
                    .unwrap(),
            ),
            || false,
        )
        .unwrap();
    assert!(matches!(selected, PreparedLaunch::Selection(_)));

    let policy = AgentPolicyArtifactBinding {
        provider_key: "dormant-policy:host:varin.agent.policy@4".into(),
        extension_id: "dormant-policy".into(),
        extension_version: "1".into(),
        service_id: "varin.agent.policy".into(),
        service_version: 4,
        artifact_integrity: "original-policy".into(),
        composition: crate::service_composition_fixture::graph(
            "dormant-policy",
            "1",
            "original-policy",
        ),
        configuration_identity: "original-policy-configuration".into(),
        declared_identity: PolicyIdentity {
            name: "dormant-policy".into(),
            version: "1".into(),
        },
        identity: PolicyIdentity {
            name: "bound-dormant-policy".into(),
            version: "1".into(),
        },
        model_roles: vec!["agentPlanning".into()],
        state_transition: PolicyStateTransition::Explicit,
    };
    let mut model = PolicyModelCapability {
        capability_id: "agentPlanning".into(),
        purpose: "planning".into(),
        status: PolicyModelStatus::Available,
        supported_operation: "tool_free_text".into(),
        binding_id: Some("policy:0:agentPlanning:original-model".into()),
        configuration_identity: Some("original-model".into()),
        binding: None,
        configuration: Some(
            serde_json::from_value(json!({
                "providerFamily":"openai-responses","model":"dormant-planner",
                "endpoint":"http://127.0.0.1:1/must-not-dispatch","allowAnonymous":false,
                "configurationGeneration":1,"maxOutputTokens":100
            }))
            .unwrap(),
        ),
        credential_scope: Some(varin_runtime::providers::auth::CredentialScope {
            reference: "original-planner-reference".into(),
            authority: "original-host".into(),
            account: "original-planner-account".into(),
            generation: 1,
        }),
    };
    // Obtain the real nonsecret binding from the original credential owner. No HTTP
    // request or credential resolution is needed to prepare an available capability.
    model.binding = Some(
        crate::agent_runtime::bind_policy_model(&run.id, &model, &first.credentials)
            .unwrap()
            .binding,
    );
    let expected_policy = crate::policy::effective_identity(policy.identity.clone());
    let prepared = first
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .prepare_policy_change(
            &run.id,
            crate::observations::default_policy_identity(),
            expected_policy.clone(),
            vec![model.clone()],
            PolicyTarget::Extension { artifact: policy },
        )
        .unwrap()
        .load()
        .unwrap();
    first
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .admit_launch_change(prepared)
        .unwrap();

    let artifact = DriverArtifact {
        provider_key: "independent-driver:host:varin.agent.driver@1".into(),
        extension_id: "independent-driver".into(),
        extension_version: "1".into(),
        service_id: "varin.agent.driver".into(),
        service_version: 1,
        artifact_integrity: "original-driver".into(),
        composition: crate::service_composition_fixture::graph(
            "independent-driver",
            "1",
            "original-driver",
        ),
        configuration_identity: "original-driver-configuration".into(),
        identity: PolicyIdentity {
            name: "independent-driver".into(),
            version: "1".into(),
        },
        model_roles: vec![],
        recovery: DriverRecovery::None,
        checkpoint_schema: None,
    };
    let selection = DriverSelection::Extension {
        artifact: artifact.clone(),
    };
    let prepared = first
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .prepare_run_driver(&run.id, &selection, vec![])
        .unwrap()
        .load()
        .unwrap();
    first
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .admit_run_driver(prepared)
        .unwrap();
    let original = original_selection(&first, &run.id);
    assert_eq!(original.policy, expected_policy);
    assert_eq!(original.policy_models, vec![model.clone()]);
    assert!(original.driver_models.is_empty());

    // Stronger than observing zero network calls: the selected dormant model cannot
    // even be rebound after its credential channel closes, yet driver assembly works.
    first.credentials.close();
    first.policy.close();
    assert!(crate::agent_runtime::bind_policy_model(&run.id, &model, &first.credentials).is_err());
    let assembled = start(&first, &run, &artifact);
    assert_eq!(assembled.driver.selection(), selection);
    assert!(assembled.provider.policy_model_capabilities().is_empty());
    assert_eq!(original_selection(&first, &run.id), original);
    drop(assembled);
    for frame in first_frames.try_iter() {
        assert_no_dormant_request(&frame);
    }
    first.runtime.shutdown().unwrap();
    first.tools.release(&run.id);
    first.models.release(&run.id);
    drop(first);
    drop(first_frames);

    // A new Catalog epoch must restore the exact same dormant metadata, not today's
    // policy identity, and needs only the original live driver binding to execute.
    let db = Catalog::open(&root).unwrap();
    let run = db.run(&run.id).unwrap();
    let (restored, frames) = assembly(db);
    restored.credentials.close();
    restored.policy.close();
    let assembled = start(&restored, &run, &artifact);
    assert_eq!(assembled.driver.selection(), selection);
    assert!(assembled.provider.policy_model_capabilities().is_empty());
    assert_eq!(original_selection(&restored, &run.id), original);
    let handle = restored.runtime.start(&run.id, assembled).unwrap();
    loop {
        let frame = frames.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_no_dormant_request(&frame);
        if frame["kind"] == "agent-driver-run" {
            assert_eq!(frame["runId"], run.id);
            assert_eq!(frame["input"]["mode"], "start");
            assert_eq!(
                frame["input"]["models"],
                json!([{"capabilityId":"primary","status":"available"}])
            );
            restored.driver.receive(json!({"v":1,"kind":"agent-driver-response","kernelEpoch":EPOCH,
                "id":frame["id"],"instanceId":frame["instanceId"],"ok":true,"outcome":{"kind":"complete"}}));
            break;
        }
    }
    assert_eq!(handle.wait().unwrap().state, RunState::Completed);
    assert_eq!(original_selection(&restored, &run.id), original);
    for frame in frames.try_iter() {
        assert_no_dormant_request(&frame);
    }
    restored.runtime.shutdown().unwrap();
    restored.tools.release(&run.id);
    restored.models.release(&run.id);
    restored.driver.close();
    drop(restored);
    drop(frames);
    std::fs::remove_dir_all(root).unwrap();
}
