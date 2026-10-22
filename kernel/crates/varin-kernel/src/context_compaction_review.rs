//! True private DTO -> original Catalog -> production RunAssembly evidence for text plans.
use super::*;
use std::sync::{Arc, mpsc};
use varin_runtime::catalog::service_composition::{HostCompositionNode, HostServiceComposition};
use varin_runtime::context_job::*;
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;

#[test]
fn text_description_preview_create_and_reopen_run_never_bind_an_adapter_or_credentials() {
    let root = std::env::temp_dir().join(format!("varin-text-assembly-{}", uuid::Uuid::new_v4()));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("text-thread", "text-branch").unwrap();
    let source = catalog
        .submit(&varin_runtime::SubmitInput {
            key: "source".into(),
            thread_id: "text-thread".into(),
            branch_id: "text-branch".into(),
            expected_head: None,
            input: json!("Unicode λ source"),
            configuration: json!({}),
        })
        .unwrap();
    // Deliberately no endpoint/providerFamily/credential environment: a model binder cannot use it.
    let descriptor = json!({"providerId":"unavailable-helper-provider","model":"text-description","contextWindowTokens":4096,"maxOutputTokens":512});
    let mut params = json!({"summaryRecipe":ContextSummaryRecipe::manual(),"key":"text-job","branchId":"text-branch","throughId":source.input_id,"expectedRevision":0,"effectiveSystemPrompt":"Continue","instructionSources":[],"memoryCheckpoint":null,"configuration":descriptor});
    let _: ContextJobPreviewParams = serde_json::from_value(params.clone()).unwrap();
    params["compaction"] = Value::Null;
    let preparation = prepare_context_job_mode(
        &catalog,
        serde_json::from_value(params.clone()).unwrap(),
        true,
    )
    .unwrap();
    let preview = preparation.preview().unwrap();
    assert!(catalog.context_jobs("text-branch").unwrap().is_empty());
    let mut node = HostCompositionNode {
        id: String::new(),
        extension_id: "review.compaction".into(),
        entrypoint_id: "host".into(),
        extension_version: "1".into(),
        artifact_integrity: "original-artifact".into(),
        activation_configuration: Value::Null,
        grants: vec![],
        dependencies: vec![],
    };
    node.id = node.content_identity().unwrap();
    let producer = ContextCompactionProducer::Extension {
        provider_key: "review.compaction:host:varin.context.compaction@1".into(),
        provider_id: "direct".into(),
        extension_id: node.extension_id.clone(),
        extension_version: node.extension_version.clone(),
        service_id: "varin.context.compaction".into(),
        service_version: 1,
        artifact_integrity: node.artifact_integrity.clone(),
        composition: HostServiceComposition {
            schema_version: 1,
            root: node.id.clone(),
            nodes: vec![node],
        },
        configuration_identity: "original".into(),
        declared_identity: varin_runtime::execution::PolicyIdentity {
            name: "direct".into(),
            version: "1".into(),
        },
    };
    params["compaction"] = serde_json::to_value(ContextCompactionCandidate {
        producer,
        plan: ContextCompactionPlan::Text {
            source_cut_hash: preview.source_cut_hash,
            text: "Original frozen direct summary".into(),
        },
    })
    .unwrap();
    // Preserve an original nonsecret account scope without installing any private owner.
    params["credentialScope"] = json!({"reference":"missing-owner","authority":"test","account":"original-account","generation":1});
    let prepared = prepare_context_job(&catalog, serde_json::from_value(params).unwrap())
        .unwrap()
        .load()
        .unwrap();
    let job = catalog.admit_prepared_context_job(prepared).unwrap();
    let original = catalog
        .capture_launch(&job.receipt.run_id)
        .unwrap()
        .unwrap()
        .load()
        .unwrap()
        .selection;
    drop(catalog);
    let catalog = Catalog::open(&root).unwrap();
    let runtime = Arc::new(varin_runtime::supervisor::RunSupervisor::new(catalog));
    let (output, frames) = mpsc::sync_channel(64);
    let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
    credentials.initialize("text-test").unwrap();
    let bridge = crate::host_tools::ToolBridge::new(output.clone().into());
    bridge.initialize("text-test");
    let assembly = crate::run_assembly::RunAssembly {
        runtime: runtime.clone(),
        resources: crate::tools::KernelResourceClient::new(
            |_| Err(KernelError::Operation("unrequested resource effect".into())),
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
        responses: output.into(),
        epoch: "text-test".into(),
    };
    assembly.policy.initialize("text-test");
    assembly.policy.set_catalog(runtime.catalog());
    let run = runtime
        .catalog()
        .lock()
        .unwrap()
        .run(&job.receipt.run_id)
        .unwrap();
    let params: RunStartParams = serde_json::from_value(json!({"runId":run.id})).unwrap();
    let prepared = crate::run_assembly::RunPreparation::new(params, &run).unwrap();
    let crate::run_assembly::PreparedLaunch::Start(start) =
        assembly.prepare(prepared, None, || false).unwrap()
    else {
        panic!("start required")
    };
    assert_eq!(
        start.binding.connection_identity,
        original.connection_identity
    );
    assert_eq!(start.binding.credential_ref, Some("missing-owner".into()));
    assert!(start.binding.tools.is_empty());
    assert!(
        frames.try_recv().is_err(),
        "no private credential/Host owner request is made"
    );
    assert_eq!(
        runtime.start(&run.id, start).unwrap().wait().unwrap().state,
        varin_runtime::RunState::Completed
    );
    let owner = runtime.catalog();
    let mut catalog = owner.lock().unwrap();
    assert_eq!(
        catalog
            .publish_context_job(&run.id)
            .unwrap()
            .proposal
            .summary,
        "Original frozen direct summary"
    );
    drop(catalog);
    drop(owner);
    drop(assembly);
    drop(runtime);
    let _ = std::fs::remove_dir_all(root);
}
