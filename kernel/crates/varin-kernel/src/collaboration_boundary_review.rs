//! Independent real Storage/wrapper breakpoint checks; no model or shared process.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[allow(dead_code)]
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;
const HOST: &str = "review-host";
const GENERATION: &str = "review-generation";
const EPOCH: &str = "review-epoch";
fn dispatch(storage: &mut Storage, method: &str, params: Value) -> Value {
    let (grant, params) = storage
        .authorize(Some("setup"), EPOCH, HOST, GENERATION, method, &params)
        .unwrap();
    storage
        .dispatch(method, &params, Some("setup"), &grant)
        .unwrap()
}
fn boundary(revoke_before: bool, policy: bool) {
    let kinds = BTreeSet::from([ToolKind::FileRead]);
    let read = KernelToolExecutor::selected_schemas(&kinds).remove(0);
    let schema = crate::collaboration::schemas(vec![], true)
        .into_iter()
        .find(|s| s.name == "dispatch")
        .unwrap();
    let f = if policy {
        let mut fixture = fixture::Fixture::new_policy_parent_with_schemas(0, read, schema.clone());
        fixture.context = fixture.admit_policy_call(ToolCall {
            call_id: "dispatch-call".into(),
            name: "dispatch".into(),
            schema_version: "2".into(),
            arguments: serde_json::to_value(&fixture.input).unwrap(),
        });
        fixture
    } else {
        fixture::Fixture::new_with_schemas(0, read, schema.clone())
    };
    let storage_root = f.root.join("storage");
    let mut storage = Storage::open(&storage_root, HOST).unwrap();
    for id in ["setup", "parent"] {
        storage.issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,
            "capabilities":if id == "setup" { vec!["storage.admin"] } else { vec!["storage.read","storage.write"] },"pathScopes":[""],
            "owningWorkspace":"workspace-A","executionWorkspace":"workspace-A","threadId":"thread:parent","runId":f.context.run_id}),
            HOST, GENERATION, &storage_root.to_string_lossy(), EPOCH).unwrap();
    }
    dispatch(
        &mut storage,
        "branch.create.begin",
        json!({"builderId":"builder","operationId":"begin","branchId":"fixed-parent","workspaceId":"workspace-A","draftBasePaths":[],"captureScopes":[]}),
    );
    dispatch(
        &mut storage,
        "branch.create.finish",
        json!({"builderId":"builder","operationId":"begin"}),
    );
    let db = Arc::new(Mutex::new(f.db));
    let storage = Arc::new(Mutex::new(storage));
    let crossed = Arc::new(AtomicBool::new(false));
    let resources = KernelResourceClient::new(
        {
            let storage = storage.clone();
            let db = db.clone();
            let crossed = crossed.clone();
            move |request| {
                let is_pin = !request.authorize_only
                    && matches!(
                        &request.operation,
                        ResourceOperation::ChildSourceHandoff { .. }
                    );
                let mut owner = storage.lock().unwrap();
                if is_pin && revoke_before {
                    owner
                        .revoke_grant(&json!({"grantId":"parent"}), HOST)
                        .unwrap();
                }
                let result = serve_resource(&mut owner, EPOCH, HOST, GENERATION, &request);
                if is_pin && !revoke_before {
                    let pin = result.as_ref().unwrap_or_else(|failure| {
                        panic!(
                            "source transfer failed before breakpoint: {}",
                            failure.error
                        )
                    });
                    assert_eq!(
                        pin["root"]["pin"]["pin_id"],
                        format!("child-pin:{}", request.context.operation_id)
                    );
                    assert!(pin["root"]["pin"]["root"].is_string());
                    assert!(
                        db.lock().unwrap().child_tasks().unwrap().is_empty(),
                        "source transfer is distinct from Catalog acceptance"
                    );
                    owner
                        .revoke_grant(&json!({"grantId":"parent"}), HOST)
                        .unwrap();
                    crossed.store(true, Ordering::SeqCst);
                }
                request.reply.send(result).unwrap();
                Ok(())
            }
        },
        |_| Ok(()),
        crate::process::ProcessControlRegistry::default(),
    );
    let binding = ToolBinding {
        grant_id: "parent".into(),
        run_id: f.context.run_id.clone(),
        thread_id: "thread:parent".into(),
        workspace_id: "workspace-A".into(),
        execution_workspace_id: "workspace-A".into(),
        root_id: None,
        file_source: Some(FixedFileSource {
            branch_id: "fixed-parent".into(),
            revision: 0,
        }),
        source_mode: SourceMode::FixedBranch,
        materialized_source: None,
        live_root: None,
        environment_run_id: None,
        enabled_tools: kinds,
    };
    let directory = Arc::new(
        varin_runtime::composition::tools::ToolDirectory::assemble(
            crate::collaboration::declarations(
                db.clone(),
                Some(binding),
                resources,
                crate::host_tools::ToolBridge::new(std::sync::mpsc::sync_channel(1).0.into()),
            ),
        )
        .unwrap(),
    );
    let call = ToolCall {
        call_id: "dispatch-call".into(),
        name: "dispatch".into(),
        schema_version: "2".into(),
        arguments: serde_json::to_value(f.input).unwrap(),
    };
    let frozen = FrozenToolContext {
        child_dispatch: db.lock().unwrap().launch_metadata(&f.context.run_id).unwrap().unwrap().dispatch_context_ref,
        resource_activations: Vec::new(),
        resource_checkpoint_id: None,
        run_id: f.context.run_id.clone(),
        origin: f.context.origin.clone(),
        tool_schema_generation: 1,
        tools: Arc::new(vec![schema]),
        source: Some(f.pin.source),
    };
    let executor = directory
        .bind_call(&call, &frozen, &CancellationToken::default())
        .unwrap();
    let contract = executor.prepare(&CancellationToken::default()).unwrap();
    executor
        .authorize(&f.context, &contract, &CancellationToken::default())
        .unwrap();
    let completion = executor.execute(&f.context, &contract, &CancellationToken::default());
    if revoke_before {
        assert!(!matches!(
            completion.completion,
            ToolCompletion::JobAccepted { .. }
        ));
        assert!(db.lock().unwrap().child_tasks().unwrap().is_empty());
        assert!(!crossed.load(Ordering::SeqCst));
    } else {
        assert!(crossed.load(Ordering::SeqCst));
        assert!(matches!(
            completion.completion,
            ToolCompletion::JobAccepted { .. }
        ));
        let children = db.lock().unwrap().child_tasks().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].parent_run_id, f.context.run_id);
        let read = db.lock().unwrap().capture_child_read(children[0].clone());
        assert_eq!(read.load().unwrap().launch.tools.len(), 1);
        assert_eq!(children[0].source.pin().unwrap().source.revision, Some(0));
    }
    drop(executor);
    drop(db);
    drop(storage);
    std::fs::remove_dir_all(f.root).unwrap();
}
#[test]
fn old_parent_grant_revoked_exactly_after_source_transfer_before_child_acceptance() {
    boundary(false, false);
}
#[test]
fn old_parent_grant_revoked_after_authorize_before_source_transfer_denies() {
    boundary(true, false);
}

#[test]
fn policy_origin_uses_the_same_fixed_source_pin_and_revocation_boundary() {
    boundary(false, true);
    boundary(true, true);
}
