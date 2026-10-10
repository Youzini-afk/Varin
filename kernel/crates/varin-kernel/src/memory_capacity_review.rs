//! Combined production PlanTools -> MemoryTools -> ProcessWaitTools admission checks.
//! The watcher below is an injected hook-contract witness, NOT runtime::run's private
//! grant watcher. Storage revocation is real; immediate queued revoke wake is not tested.
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use super::*;
use crate::storage::Storage;
use crate::tools::{
    serve_resource, FixedFileSource, KernelResourceClient, KernelToolExecutor, SourceMode,
    ToolBinding, ToolKind,
};
use input_admission::InputAdmission;
use std::{
    collections::BTreeSet,
    num::NonZeroUsize,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use varin_runtime::execution_capacity::{AdmissionControlGuard, AdmissionIdentity, ExecutionClass};
use varin_runtime::{catalog::context::ContextProposal, SubmitInput};
const HOST: &str = "memory-capacity-host";
const GENERATION: &str = "memory-capacity-generation";
const EPOCH: &str = "memory-capacity-epoch";
fn wait_for(mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(5);
    while !f() {
        assert!(Instant::now() < end, "gate not reached");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn dispatch(s: &mut Storage, method: &str, params: Value) -> Value {
    let (grant, params) = s
        .authorize(Some("setup"), EPOCH, HOST, GENERATION, method, &params)
        .unwrap();
    s.dispatch(method, &params, Some("setup"), &grant).unwrap()
}
struct Provider(AtomicUsize);
impl ModelProvider for Provider {
    fn serialize(&self, v: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(v).unwrap())
    }
    fn generate(
        &self,
        r: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: r.view.request_id.clone(),
                content: if first {
                    Content::ToolCall { call: search() }
                } else {
                    Content::Text {
                        text: "done".into(),
                    }
                },
                opaque: None,
            },
        })
        .unwrap();
        Ok(if first {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}
fn search() -> ToolCall {
    ToolCall {
        call_id: "search-call".into(),
        name: "file_search".into(),
        schema_version: "1".into(),
        arguments: json!({"query":"needle","maxResults":1}),
    }
}
#[derive(Clone, Copy, PartialEq)]
enum Ending {
    Release,
    Cancel,
    Revoke,
}
fn combined(ending: Ending) {
    let root = std::env::temp_dir().join(format!("varin-memory-capacity-{}", uuid::Uuid::new_v4()));
    let db = Arc::new(Mutex::new(Catalog::open(&root.join("catalog")).unwrap()));
    let basis: PersonalizationBasis = serde_json::from_value(json!({"mode":"agent","threadRole":"main","revision":0,"configurationDigest":"capacity-review","memorySnapshot":{"revision":0,"memories":[]},"sessionId":"thread","projectId":null,"originalSections":[{"name":"preamble","content":"system"}],"instructionSources":[]})).unwrap();
    let mut input = {
        let mut db = db.lock().unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit_with_context_snapshot(
                &SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "main".into(),
                    expected_head: None,
                    input: json!({"text":"search"}),
                    configuration: json!({}),
                },
                None,
                false,
                Some(ContextProposal {
                    key: "initial".into(),
                    branch_id: "main".into(),
                    through_id: None,
                    expected_revision: 0,
                    summary: String::new(),
                    effective_system_prompt: "system".into(),
                    instruction_sources: vec![],
                    memory_checkpoint: None,
                }),
                Some(basis.clone()),
            )
            .unwrap();
        ExecutionInput {
            run_id: receipt.run_id,
            owner_generation: db.epoch(),
            binding: RequestBinding {
                child_dispatch: None,
                goal: None, resource_activations: Vec::new(),
                resource_checkpoint_id: None,
                connection_identity: "review".into(),
                provider_family: "review".into(),
                model: "review".into(),
                credential_ref: None,
                configuration_generation: 1,
                tool_schema_generation: 1,
                tools: KernelToolExecutor::selected_schemas(&BTreeSet::from([
                    ToolKind::FileSearch,
                ])),
                instruction_sources: vec![],
                memory_checkpoint: None,
                attachment_refs: vec![],
                environment_cursor: 0,
                history_range: HistoryRange {
                    branch_id: "main".into(),
                    ancestor_id: None,
                    leaf_id: Some(receipt.input_id),
                },
            },
            history: db.execution_history("main").unwrap(),
            policy_state: Value::Null,
            completed_model_steps: 0,
        }
    };
    let storage_root = root.join("storage");
    let mut storage = Storage::open(&storage_root, HOST).unwrap();
    for id in ["setup", "search"] {
        storage.issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,"capabilities":if id == "setup" {vec!["storage.admin"]} else {vec!["storage.read"]},"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":input.run_id}), HOST, GENERATION, &storage_root.to_string_lossy(), EPOCH).unwrap();
    }
    dispatch(
        &mut storage,
        "storage.putBlob.begin",
        json!({"streamId":"tiny","operationId":"tiny-put","byteLength":7,"workspaceId":"workspace"}),
    );
    dispatch(
        &mut storage,
        "storage.putBlob.chunk",
        json!({"streamId":"tiny","sequence":0,"bytesBase64":"bmVlZGxlCg=="}),
    );
    let blob = dispatch(
        &mut storage,
        "storage.putBlob.finish",
        json!({"streamId":"tiny","operationId":"tiny-put","workspaceId":"workspace"}),
    );
    dispatch(
        &mut storage,
        "branch.create.begin",
        json!({"builderId":"builder","operationId":"begin","branchId":"fixed","workspaceId":"workspace","draftBasePaths":[],"captureScopes":[]}),
    );
    dispatch(
        &mut storage,
        "branch.create.append",
        json!({"builderId":"builder","sequence":0,"entries":[{"path":"tiny.txt","state":{"kind":"regular-file","objectHash":blob["hash"],"byteLength":7,"mode":420},"ownerId":blob["ownerId"]}]}),
    );
    dispatch(
        &mut storage,
        "branch.create.finish",
        json!({"builderId":"builder","operationId":"begin"}),
    );
    let storage = Arc::new(Mutex::new(storage));
    let results = Arc::new(Mutex::new(Vec::<Value>::new()));
    let registrations = Arc::new(AtomicUsize::new(0));
    let releases = Arc::new(AtomicUsize::new(0));
    let watched = Arc::new(Mutex::new(None::<CancellationToken>));
    let client = KernelResourceClient::new(
        {
            let storage = storage.clone();
            let results = results.clone();
            move |request| {
                let result = serve_resource(
                    &mut storage.lock().unwrap(),
                    EPOCH,
                    HOST,
                    GENERATION,
                    &request,
                );
                if let Ok(value) = &result {
                    results.lock().unwrap().push(value.clone());
                }
                request.reply.send(result).unwrap();
                Ok(())
            }
        },
        |_| Ok(()),
        crate::process::ProcessControlRegistry::default(),
    )
    .with_admission_control({
        let registrations = registrations.clone();
        let releases = releases.clone();
        let watched = watched.clone();
        move |_, cancel| {
            registrations.fetch_add(1, Ordering::SeqCst);
            *watched.lock().unwrap() = Some(cancel.clone());
            let releases = releases.clone();
            Ok(AdmissionControlGuard::new(move || {
                releases.fetch_add(1, Ordering::SeqCst);
            }))
        }
    });
    let binding = ToolBinding {
        grant_id: "search".into(),
        run_id: input.run_id.clone(),
        thread_id: "thread".into(),
        workspace_id: "workspace".into(),
        execution_workspace_id: "workspace".into(),
        root_id: None,
        file_source: Some(FixedFileSource {
            branch_id: "fixed".into(),
            revision: 0,
        }),
        source_mode: SourceMode::FixedBranch,
        materialized_source: None,
        live_root: None,
        environment_run_id: None,
        enabled_tools: BTreeSet::from([ToolKind::FileSearch]),
    };
    let (output, messages) = mpsc::sync_channel(8);
    let bridge = OwnerChannel::new("memory", output);
    bridge.initialize(EPOCH);
    // Real private bridge rendezvous; the external memory domain reply is deliberately a fixture.
    let responder = {
        let bridge = bridge.clone();
        let basis = basis.clone();
        std::thread::spawn(move || {
            for request in messages {
                if request["kind"] != "memory-request" {
                    continue;
                }
                let reply = if request["query"]["action"] == "synchronize" {
                    json!({"status":"ready","context":{"effectiveSystemPrompt":"system","instructionSources":[],"memoryCheckpoint":null,"personalization":basis},"state":{"revision":0,"memories":[],"noteRevisions":{},"known":{}}})
                } else {
                    json!({"status":"ready","revision":0,"memories":[]})
                };
                bridge.receive(json!({"v":1,"kind":"memory-response","id":request["id"],"kernelEpoch":EPOCH,"result":reply}));
            }
        })
    };
    let mut start = crate::questions::configure(
        varin_runtime::supervisor::RunStart {
            context_preparation: Arc::new(NoopContextPreparation),
            binding: input.binding.clone(),
            policy_state: Value::Null,
            provider: Arc::new(Provider(AtomicUsize::new(0))),
            tools: Arc::new(KernelToolExecutor::new(binding.clone(), client.clone()).unwrap()),
            policy: Arc::new(DefaultAgentPolicy),
            progress: ProgressSink::default(),
        },
        db.clone(),
    );
    start = crate::collaboration::configure(start, db.clone());
    start = crate::process_wait::configure(start, db.clone());
    let mut declarations = KernelToolExecutor::new(binding.clone(), client.clone())
        .unwrap()
        .declarations(true);
    declarations.push(crate::questions::declaration(db.clone()));
    declarations.extend(crate::collaboration::declarations(
        db.clone(),
        Some(binding.clone()),
        client.clone(),
    ));
    declarations.extend(crate::process_wait::declarations(
        db.clone(),
        binding,
        client,
    ));
    declarations.push(declaration(db.clone(), bridge.clone(), true));
    let mut start = configure_context(start, db.clone(), bridge.clone());
    let (plan_output, _plan_messages) = mpsc::sync_channel(8);
    let plan_bridge = crate::plan_bridge::PlanBridge::new(plan_output);
    plan_bridge.initialize(EPOCH);
    declarations.push(crate::plan::declaration(db.clone(), plan_bridge));
    let directory =
        varin_runtime::composition::tools::ToolDirectory::assemble(declarations).unwrap();
    start.binding.tools = directory.schemas().to_vec();
    start.tools = Arc::new(directory);
    input.binding = start.binding.clone();
    let tools = start.tools.clone();
    let admission = db.lock().unwrap().resource_admission();
    admission.set_compute_capacity(NonZeroUsize::new(1).unwrap());
    let holder = admission
        .acquire_scheduled(
            "held-compute",
            &[],
            &AdmissionIdentity {
                run_id: "holder".into(),
                owner_generation: input.owner_generation,
                origin: ToolOrigin::ModelStep {
                    request_id: "holder".into(),
                },
                family_id: "holder".into(),
            },
            ExecutionClass::LocalCompute,
            &CancellationToken::default(),
        )
        .unwrap()
        .unwrap();
    let context = ToolExecutionContext {
        run_id: input.run_id.clone(),
        origin: ToolOrigin::ModelStep {
            request_id: "memory-read".into(),
        },
        operation_id: "memory-read".into(),
    };
    let memory = ToolCall {
        call_id: "memory-read".into(),
        name: TOOL.into(),
        schema_version: "1".into(),
        arguments: json!({"action":"read"}),
    };
    let frozen = FrozenToolContext {
        child_dispatch: None,
        resource_activations: Vec::new(),
        resource_checkpoint_id: None,
        run_id: input.run_id.clone(),
        origin: context.origin.clone(),
        tool_schema_generation: 1,
        tools: Arc::new(vec![schema(true)]),
        source: None,
    };
    let memory_call = tools
        .clone()
        .bind_call(&memory, &frozen, &CancellationToken::default())
        .unwrap();
    let contract = memory_call.prepare(&CancellationToken::default()).unwrap();
    assert_eq!(
        memory_call.execution_class(&contract),
        ExecutionClass::Unmetered
    );
    let _memory_watch = memory_call
        .watch_admission(&context, &contract, &CancellationToken::default())
        .unwrap();
    let plan = ToolCall {
        call_id: "plan-read".into(),
        name: "todo".into(),
        schema_version: "1".into(),
        arguments: json!({"action":"read"}),
    };
    let plan_frozen = FrozenToolContext {
        child_dispatch: None,
        resource_activations: Vec::new(),
        resource_checkpoint_id: None,
        tools: Arc::new(vec![crate::plan::schema()]),
        ..frozen.clone()
    };
    let plan_call = tools
        .clone()
        .bind_call(&plan, &plan_frozen, &CancellationToken::default())
        .unwrap();
    let plan_contract = plan_call.prepare(&CancellationToken::default()).unwrap();
    assert_eq!(
        plan_call.execution_class(&plan_contract),
        ExecutionClass::Unmetered
    );
    let _plan_watch = plan_call
        .watch_admission(&context, &plan_contract, &CancellationToken::default())
        .unwrap();
    // Actual plan execution is covered by Host IPC tests; this assertion is solely admission classification.
    assert_eq!(registrations.load(Ordering::SeqCst), 0);
    memory_call
        .authorize(&context, &contract, &CancellationToken::default())
        .unwrap();
    assert!(matches!(
        memory_call
            .execute(&context, &contract, &CancellationToken::default())
            .completion,
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            ..
        }
    ));
    let prepare = start.context_preparation.clone();
    prepare
        .prepare(
            &input.run_id,
            input.owner_generation,
            &CancellationToken::default(),
        )
        .unwrap();
    assert_eq!(admission.summary().local_compute_active, 1);
    let cancel = CancellationToken::default();
    let engine = ExecutionEngine {
        context_preparation: prepare,
        persistence: db.clone(),
        provider: Arc::new(Provider(AtomicUsize::new(0))),
        tools: tools.clone(),
        policy: start.policy.clone(),
        progress: ProgressSink::default(),
    };
    let worker = {
        let cancel = cancel.clone();
        std::thread::spawn(move || engine.run(input, cancel))
    };
    wait_for(|| (admission.summary().queued == 1
        && registrations.load(Ordering::SeqCst) == 1
        && watched.lock().unwrap().is_some()) || worker.is_finished());
    assert!(!worker.is_finished(), "engine ended before search queue");
    assert_eq!(admission.summary().queued, 1);
    assert_eq!(registrations.load(Ordering::SeqCst), 1);
    assert_eq!(releases.load(Ordering::SeqCst), 0);
    assert!(watched.lock().unwrap().is_some());
    assert!(
        results.lock().unwrap().iter().all(Value::is_null),
        "only authorization before permit"
    );
    match ending {
        Ending::Release => drop(holder),
        Ending::Cancel => {
            cancel.cancel();
            wait_for(|| worker.is_finished());
            assert_eq!(admission.summary().local_compute_active, 1);
            assert_eq!(admission.summary().queued, 0);
            assert!(watched.lock().unwrap().as_ref().unwrap().is_cancelled());
            assert_eq!(releases.load(Ordering::SeqCst), 1);
            drop(holder);
        }
        Ending::Revoke => {
            storage
                .lock()
                .unwrap()
                .revoke_grant(&json!({"grantId":"search"}), HOST)
                .unwrap();
            let _watch = memory_call
                .watch_admission(&context, &contract, &CancellationToken::default())
                .unwrap();
            memory_call
                .authorize(&context, &contract, &CancellationToken::default())
                .unwrap();
            assert!(matches!(
                memory_call
                    .execute(&context, &contract, &CancellationToken::default())
                    .completion,
                ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    ..
                }
            ));
            assert_eq!(registrations.load(Ordering::SeqCst), 1);
            // No synthetic revocation -> cancellation bridge. The actual Storage fence
            // is tested after releasing the permit, not runtime::run's immediate wake.
            assert_eq!(admission.summary().local_compute_active, 1);
            drop(holder);
        }
    }
    wait_for(|| worker.is_finished());
    worker.join().unwrap().unwrap();
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    assert_eq!(admission.summary().queued, 0);
    assert_eq!(admission.summary().local_compute_active, 0);
    let results = results.lock().unwrap();
    if ending == Ending::Release {
        assert!(
            results.iter().any(|v| v.get("records").is_some()),
            "real Storage compute page never returned"
        );
        assert!(
            results.iter().any(|v| v["records"]
                .as_array()
                .is_some_and(|r| r.iter().any(|record| record.to_string().contains("needle")))),
            "tiny-file search produced no record"
        );
    } else {
        assert!(
            results.iter().all(Value::is_null),
            "cancelled or revoked search dispatched"
        );
    }
    drop(results);
    drop(memory_call);
    drop(plan_call);
    drop(_memory_watch);
    drop(_plan_watch);
    drop(tools);
    drop(start);
    bridge.close();
    drop(bridge);
    responder.join().unwrap();
    drop(storage);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn memory_wrapper_real_search_queues_and_runs_after_permit_release() {
    combined(Ending::Release);
}
#[test]
fn memory_wrapper_queued_search_cancels_before_permit_release() {
    combined(Ending::Cancel);
}
#[test]
fn memory_wrapper_queued_search_rechecks_real_storage_revocation_after_permit_release() {
    combined(Ending::Revoke);
}
