//! Real Catalog and original Storage journal replay, without transport or a provider.
use super::*;
use crate::storage::Storage;
use std::sync::{Arc, Mutex};
use varin_runtime::catalog::collaboration::*;
use varin_runtime::execution::*;
use varin_runtime::*;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;

fn invoke(storage: &mut Storage, method: &str, value: Value) -> Value {
    let (grant, params) = storage
        .authorize(Some("actor"), "epoch", "host", "generation", method, &value)
        .unwrap();
    storage
        .dispatch(method, &params, Some("actor"), &grant)
        .unwrap()
}
#[test]
fn original_integration_unknown_stop_refines_and_replays_identical_public_body_without_disk() {
    replay_scenario(None);
}
#[test]
fn compensated_receipt_distinguishes_unissued_surface_intent_from_unacknowledged_dispatch() {
    replay_scenario(Some("external-intent"));
    replay_scenario(Some("external-dispatched"));
}
fn replay_scenario(tail_phase: Option<&str>) {
    let mut f = fixture::Fixture::new_isolated();
    let child = f.accept();
    f.settle_exchange();
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    source.mode = SourceMode::Materialized;
    let proposal=serde_json::from_value(json!({"key":"child-context","branch_id":child.child_branch_id,"through_id":null,"expected_revision":0,"summary":"","effective_system_prompt":"private child","instruction_sources":[],"memory_checkpoint":null})).unwrap();
    let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"child-profile","memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":null,"originalSections":[],"instructionSources":[]})).unwrap();
    let child =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    let epoch = f.db.epoch();
    let child_run = &child.receipt.as_ref().unwrap().run_id;
    f.db.request_cancel_run(child_run).unwrap();
    f.db.commit_execution(
        child_run,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Cancelled,
            waiting_on: None,
        },
    )
    .unwrap();
    f.db.reconcile_child_reports().unwrap();
    f.db.begin_child_settlement(&child.operation_id).unwrap();
    let publication = format!("child-result:{}", child.operation_id);
    let candidate = KernelWorkingResultCandidate {
        publication_id: publication.clone(),
        candidate_operation_id: format!("result-prepare:{publication}"),
        workspace_id: "workspace-A".into(),
        branch_id: format!("child-source:{}", child.operation_id),
        root: "result-root".into(),
        base_root: "fixed-root".into(),
        write_revision: 1,
        pin_id: "candidate-pin".into(),
        base_pin_id: "candidate-base".into(),
    };
    f.db.attach_child_candidate(&child.operation_id, candidate.clone())
        .unwrap();
    let result = ChildWorkingResultRef {
        publication_id: publication.clone(),
        workspace_id: candidate.workspace_id,
        branch_id: candidate.branch_id,
        root: candidate.root,
        base_root: candidate.base_root,
        result_revision: 1,
        record_id: "result-record".into(),
    };
    f.db.attach_child_result(&child.operation_id, result.clone(), Effect::Partial)
        .unwrap();
    f.db.settle_child_receipts().unwrap();
    f.db.commit_execution(
        &f.context.run_id,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    let nonexistent = f.root.join("deleted-original-live-root");
    let target=serde_json::from_value(json!({"mode":"live_root","live_root":{"hostId":"host","rootId":"original-root","canonicalRoot":nonexistent},"workspace_id":"workspace-A","execution_workspace_id":"workspace-A","branch_id":null,"revision":null})).unwrap();
    let tool = ToolSchema {
        name: "integrate_child".into(),
        version: "1".into(),
        description: String::new(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    };
    let mut launch = f.launch.clone();
    launch.source = Some(target);
    launch.tools = vec![tool.clone()];
    let run=f.db.submit_with_launch(&SubmitInput{key:"later-parent".into(),thread_id:child.parent_thread_id.clone(),branch_id:child.parent_branch_id.clone(),expected_head:f.db.head(&child.parent_branch_id).unwrap(),input:json!("integrate fixed child"),configuration:json!({"providerFamily":"fixture","model":"fixture-model","configurationGeneration":2})},Some(launch.clone())).unwrap();
    let range = HistoryRange {
        branch_id: run.branch_id.clone(),
        ancestor_id: None,
        leaf_id: Some(run.input_id.clone()),
    };
    let binding = RequestBinding {
        child_dispatch: None,
        goal: None, resource_activations: Vec::new(),
        resource_checkpoint_id: None,
        connection_identity: launch.connection_identity,
        provider_family: launch.provider_family,
        model: launch.model,
        credential_ref: Some("credential-ref".into()),
        configuration_generation: 2,
        tool_schema_generation: 1,
        tools: vec![tool],
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: range.clone(),
    };
    let call = ToolCall {
        call_id: "integrate".into(),
        name: "integrate_child".into(),
        schema_version: "1".into(),
        arguments: json!({"childOperationId":child.operation_id,"publicationId":publication}),
    };
    let context = ToolExecutionContext {
        run_id: run.run_id.clone(),
        origin: ToolOrigin::ModelStep {
            request_id: "integration-request".into(),
        },
        operation_id: "integration-request:tool:integrate".into(),
    };
    for record in [
        ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
        ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: "integration-request".into(),
                    run_id: run.run_id.clone(),
                    origin: RequestOrigin::Conversation {
                        step: 1,
                        history_range: range,
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({}),
            },
        },
        ExecutionRecord::ModelDispatched {
            request_id: "integration-request".into(),
        },
        ExecutionRecord::ModelFinished {
            request_id: "integration-request".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "call".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
        ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call: call.clone(),
                contract: ToolContract {
                    name: "integrate_child".into(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: CompletionKind::Result,
                    lifetime: Lifetime::Run,
                    resources: vec![ResourceClaim {
                        key: "parent-file".into(),
                        access: Access::Write,
                    }],
                },
            },
        },
        ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: ExecutorOwner::External {
                identity: "installed:integrate@1".into(),
                epoch: "host-owner".into(),
            },
        },
        ExecutionRecord::ToolSettled {
            context: context.clone(),
            completion: ToolCompletion::Result {
                outcome: Outcome::Indeterminate,
                effect: Effect::Unknown,
                content: json!({"original":"unknown"}),
            },
            executor_stopped: false,
        },
    ] {
        f.db.commit_execution(&run.run_id, epoch, &record).unwrap();
    }
    f.db.commit_execution(
        &run.run_id,
        epoch,
        &ExecutionRecord::ToolBatchCommitted {
            request_id: "integration-request".into(),
            results: vec![ToolResult {
                request_id: "integration-request".into(),
                call_id: call.call_id.clone(),
                completion: ToolCompletion::Result {
                    outcome: Outcome::Indeterminate,
                    effect: Effect::Unknown,
                    content: json!({"original":"unknown"}),
                },
            }],
        },
    )
    .unwrap();
    let prepared =
        f.db.prepare_result_content()
            .write_external_receipt(ExternalReceipt {
                executor: "integrate_child".into(),
                identity: context.operation_id.clone(),
                epoch: "host-owner".into(),
                outcome: Outcome::Indeterminate,
                effect: Effect::Unknown,
                result: json!({"original":"unknown"}),
            })
            .unwrap();
    f.db.record_external_tool_receipt_prepared(
        &context.operation_id,
        &ExecutorOwner::External {
            identity: "installed:integrate@1".into(),
            epoch: "host-owner".into(),
        },
        prepared,
        false,
    )
    .unwrap();
    f.db.request_cancel_run(&run.run_id).unwrap();
    f.db.commit_execution(
        &run.run_id,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Cancelled,
            waiting_on: None,
        },
    )
    .unwrap();
    let root = f.root.clone();
    drop(f.db);
    let catalog = Catalog::open(&root).unwrap();
    let runtime = RunSupervisor::new(catalog);
    let original_owner = ExecutorOwner::External {
        identity: "installed:integrate@1".into(),
        epoch: "host-owner".into(),
    };
    let operation_binding = json!({"kind":"runtime_operation","operationId":context.operation_id,"parentRunId":run.run_id,"parentThreadId":child.parent_thread_id,"parentBranchId":child.parent_branch_id,"origin":context.origin,"callId":call.call_id,"childOperationId":child.operation_id,"childThreadId":child.child_thread_id,
        "result":{"workspaceId":result.workspace_id,"branchId":result.branch_id,"resultRevision":1,"root":result.root,"publicationId":publication},"target":launch.source});
    let journal_id = format!("integration:{}", context.operation_id);
    let mut storage = Storage::open(&root.join("storage"), "host").unwrap();
    let storage_identity = root.join("storage").to_string_lossy().into_owned();
    storage.issue_grant(&json!({"grantId":"actor","hostGeneration":"generation","owningWorkspace":"workspace-A","executionWorkspace":"workspace-A","threadId":child.parent_thread_id,"runId":run.run_id,"pathScopes":[""],"capabilities":["recovery"]}),"host","generation",&storage_identity,"epoch").unwrap();
    let mut data = json!({"operationBinding":operation_binding,"applyCanonicalRoot":nonexistent,"executorStopped":true,"effect":"unknown","appliedPaths":["a.txt"],"conflictPaths":[],"compensatedPaths":[],"needsAttentionPaths":[],"retryBinding":{"childStates":{"a.txt":{"kind":"missing"}}},"diffStats":{"files":1,"insertions":0,"deletions":1}});
    let mut files = vec![json!({"path":"a.txt","phase":"external-target-observed"})];
    if let Some(phase) = tail_phase {
        files.push(json!({"path":"b.txt","phase":phase}));
        data["retryBinding"]["childStates"]["b.txt"] = json!({"kind":"missing"});
        data["diffStats"] = json!({"files":2,"insertions":0,"deletions":2});
    }
    invoke(
        &mut storage,
        "recovery.operation.create",
        json!({"workspaceId":"workspace-A","operationId":journal_id,"kind":"integration","state":"awaiting-surface","threadId":child.parent_thread_id,"runId":run.run_id,"dataJson":serde_json::to_string(&data).unwrap(),"files":files}),
    );
    let storage = Arc::new(Mutex::new(storage));
    let reader = storage.clone();
    let resources = KernelResourceClient::new(
        |_| panic!("no source effects or grants during metadata recovery"),
        |_| Ok(()),
        crate::process::ProcessControlRegistry::default(),
    )
    .with_integration_receipts(move |read| {
        let result = reader.lock().unwrap().integration_receipt(&read);
        read.reply.send(result).unwrap();
        Ok(())
    });
    assert!(!reconcile(
        &runtime,
        &resources,
        None,
        &context.operation_id,
        Some(&original_owner)
    )
    .unwrap());
    {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        let op = db
            .capture_operation_read(db.operation(&context.operation_id).unwrap())
            .load()
            .unwrap();
        assert_eq!(op.effect, Effect::Unknown);
        assert_eq!(op.result, Some(json!({"original":"unknown"})));
        assert!(db
            .resource_admission()
            .inspect(&context.operation_id)
            .is_none());
        assert_eq!(db.run(&run.run_id).unwrap().state, RunState::Cancelled);
    }
    let terminal = if tail_phase.is_some() {
        "compensated"
    } else {
        "complete"
    };
    if tail_phase.is_some() {
        data["compensatedPaths"] = json!(["a.txt"]);
        invoke(
            &mut storage.lock().unwrap(),
            "recovery.operation.file.cas",
            json!({"workspaceId":"workspace-A","operationId":journal_id,"path":"a.txt","expectedRevision":1,"expectedPhase":"external-target-observed","phase":"external-safety-observed","transitionId":"original-compensation-observed"}),
        );
    }
    invoke(
        &mut storage.lock().unwrap(),
        "recovery.operation.complete",
        json!({"workspaceId":"workspace-A","operationId":journal_id,"expectedRevision":1,"transitionId":"confirm-original","state":terminal,"resultJson":serde_json::to_string(&data).unwrap()}),
    );
    if tail_phase == Some("external-dispatched") {
        assert!(!reconcile(
            &runtime,
            &resources,
            None,
            &context.operation_id,
            Some(&original_owner)
        )
        .unwrap());
        let owner = runtime.catalog();
        {
            let db = owner.lock().unwrap();
            let op = db
                .capture_operation_read(db.operation(&context.operation_id).unwrap())
                .load()
                .unwrap();
            assert_eq!(op.effect, Effect::Unknown);
            assert_eq!(op.result, Some(json!({"original":"unknown"})));
        }
        drop(owner);
        drop(runtime);
        drop(resources);
        drop(storage);
        std::fs::remove_dir_all(root).unwrap();
        return;
    }
    assert!(reconcile(
        &runtime,
        &resources,
        None,
        &context.operation_id,
        Some(&original_owner)
    )
    .unwrap());
    let status = if tail_phase.is_some() {
        "compensated"
    } else {
        "applied"
    };
    let changed = if tail_phase.is_some() {
        json!(["a.txt", "b.txt"])
    } else {
        json!(["a.txt"])
    };
    let expected = json!({"operationId":journal_id,"status":status,"appliedPaths":["a.txt"],"conflictPaths":[],"compensatedPaths":data["compensatedPaths"],"needsAttentionPaths":[],"diffStats":data["diffStats"],"changedFiles":changed,"text":format!("Recorded integration {journal_id}: {terminal}"),"receipt":{"kind":"integration","workspaceId":"workspace-A","operationId":journal_id,"revision":2,"state":terminal},"effect":"confirmed","executorStopped":true,"recoveryCoverage":"files-only"});
    let owner = runtime.catalog();
    let original = {
        let db = owner.lock().unwrap();
        db.capture_operation_read(db.operation(&context.operation_id).unwrap())
            .load()
            .unwrap()
    };
    assert_eq!(original.result, Some(expected));
    assert!(reconcile(
        &runtime,
        &resources,
        None,
        &context.operation_id,
        Some(&original_owner)
    )
    .unwrap());
    let replay = {
        let db = owner.lock().unwrap();
        db.capture_operation_read(db.operation(&context.operation_id).unwrap())
            .load()
            .unwrap()
    };
    assert_eq!(replay.external_receipt, original.external_receipt);
    assert_eq!(replay.revision, original.revision);
    drop(owner);
    drop(runtime);
    drop(resources);
    drop(storage);
    std::fs::remove_dir_all(root).unwrap();
}
