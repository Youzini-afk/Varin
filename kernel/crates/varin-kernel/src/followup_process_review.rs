//! Real guardian/Storage/ProcessWaitTools continuation output. Explicit fresh binary dependency;
//! this does not run the blocked Host socket route or use a paid provider.
use super::*;
use crate::storage::Storage;
use crate::tools::{
    serve_resource, KernelResourceClient, KernelToolExecutor, ToolBinding, ToolKind,
};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};
use varin_runtime::catalog::launches::{LaunchSelection, LiveRoot};
use varin_runtime::execution::*;
use varin_runtime::{ExecutorOwner, RunState, SourceMode};
const HOST: &str = "followup-test-host";
const GENERATION: &str = "followup-test-generation";
const EPOCH: &str = "followup-original-epoch";

fn issue(storage: &mut Storage, root: &std::path::Path, id: &str, run: &str, epoch: &str) {
    storage.issue_grant(&json!({"grantId":id,"hostGeneration":GENERATION,"capabilities":["storage.admin","process"],"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":run}),HOST,GENERATION,&root.to_string_lossy(),epoch).unwrap();
}
fn dispatch(storage: &mut Storage, actor: &str, method: &str, params: Value, epoch: &str) -> Value {
    let (grant, params) = storage
        .authorize(Some(actor), epoch, HOST, GENERATION, method, &params)
        .unwrap();
    storage
        .dispatch(method, &params, Some(actor), &grant)
        .unwrap()
}
fn record(owner: &Arc<Mutex<Catalog>>, run: &str, record: ExecutionRecord) {
    let mut db = owner.lock().unwrap();
    let epoch = db.epoch();
    db.commit_execution(run, epoch, &record).unwrap();
}
fn model_call(
    owner: &Arc<Mutex<Catalog>>,
    run: &str,
    request: &str,
    call: &ToolCall,
    tools: &[ToolSchema],
) -> (ToolExecutionContext, FrozenToolContext) {
    let (range, source) = {
        let db = owner.lock().unwrap();
        (
            HistoryRange {
                branch_id: "branch".into(),
                ancestor_id: None,
                leaf_id: db.head("branch").unwrap(),
            },
            db.launch_intent(run).unwrap().unwrap().selection.source,
        )
    };
    record(
        owner,
        run,
        ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    );
    let binding = RequestBinding {
        connection_identity: "fixture".into(),
        provider_family: "fixture".into(),
        model: "fixture".into(),
        credential_ref: None,
        configuration_generation: 1,
        tool_schema_generation: 1,
        tools: tools.into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: range.clone(),
    };
    record(
        owner,
        run,
        ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: request.into(),
                    run_id: run.into(),
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
    );
    record(
        owner,
        run,
        ExecutionRecord::ModelDispatched {
            request_id: request.into(),
        },
    );
    record(
        owner,
        run,
        ExecutionRecord::ModelFinished {
            request_id: request.into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: format!("item-{request}"),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    );
    let origin = ToolOrigin::ModelStep {
        request_id: request.into(),
    };
    (
        ToolExecutionContext {
            run_id: run.into(),
            operation_id: format!("{request}:tool:{}", call.call_id),
            origin: origin.clone(),
        },
        FrozenToolContext {
            run_id: run.into(),
            origin,
            tool_schema_generation: 1,
            tools: Arc::new(tools.into()),
            source,
        },
    )
}
fn close_call(
    owner: &Arc<Mutex<Catalog>>,
    context: &ToolExecutionContext,
    call: &ToolCall,
    completion: ToolCompletion,
    stopped: bool,
) {
    record(
        owner,
        &context.run_id,
        ExecutionRecord::ToolSettled {
            context: context.clone(),
            completion: completion.clone(),
            executor_stopped: stopped,
        },
    );
    let ToolOrigin::ModelStep { request_id } = &context.origin else {
        unreachable!()
    };
    record(
        owner,
        &context.run_id,
        ExecutionRecord::ToolBatchCommitted {
            request_id: request_id.clone(),
            results: vec![ToolResult {
                request_id: request_id.clone(),
                call_id: call.call_id.clone(),
                completion,
            }],
        },
    );
}
fn read_call(process: &str) -> ToolCall {
    ToolCall {
        call_id: "read".into(),
        name: "process_read".into(),
        schema_version: "1".into(),
        arguments: json!({"processId":process,"cursor":0}),
    }
}
fn text(completion: &ToolCompletion) -> String {
    let ToolCompletion::Result {
        outcome: varin_runtime::Outcome::Succeeded,
        content,
        ..
    } = completion
    else {
        panic!("successful real process output: {completion:?}")
    };
    let bytes = content["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|chunk| {
            base64::prelude::BASE64_STANDARD
                .decode(chunk["bytesBase64"].as_str().unwrap())
                .unwrap()
        })
        .collect::<Vec<_>>();
    String::from_utf8(bytes).unwrap()
}

#[test]
#[ignore = "requires a freshly built kernel executable"]
fn process_followup_reads_real_original_output_and_rechecks_both_grants() {
    let executable = std::env::var_os("VARIN_TEST_KERNEL_EXECUTABLE")
        .map(PathBuf::from)
        .expect("VARIN_TEST_KERNEL_EXECUTABLE must identify the freshly built kernel binary");
    assert!(
        executable.is_file(),
        "explicit kernel executable must exist"
    );
    let root = std::env::temp_dir().join(format!("varin-real-followup-{}", uuid::Uuid::new_v4()));
    let cwd = root.join("working");
    std::fs::create_dir_all(&cwd).unwrap();
    let storage_root = root.join("storage");
    let mut storage = Storage::open(&storage_root, HOST).unwrap();
    storage.set_test_process_worker_executable(executable);
    issue(&mut storage, &storage_root, "setup", "setup", EPOCH);
    let registered = dispatch(
        &mut storage,
        "setup",
        "file.root.register",
        json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":cwd}),
        EPOCH,
    );
    let kinds = BTreeSet::from([
        ToolKind::ProcessSpawn,
        ToolKind::ProcessInspect,
        ToolKind::ProcessRead,
    ]);
    let tools = KernelToolExecutor::selected_schemas(&kinds);
    let mut binding = ToolBinding {
        grant_id: "source".into(),
        run_id: String::new(),
        thread_id: "thread".into(),
        workspace_id: "workspace".into(),
        execution_workspace_id: "workspace".into(),
        root_id: Some(registered["rootId"].as_str().unwrap().into()),
        file_source: None,
        source_mode: SourceMode::LiveRoot,
        materialized_source: None,
        live_root: Some(LiveRoot {
            host_id: HOST.into(),
            canonical_root: cwd.canonicalize().unwrap().to_string_lossy().into_owned(),
            root_id: registered["rootId"].as_str().unwrap().into(),
        }),
        environment_run_id: None,
        enabled_tools: kinds,
    };
    let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":tools,"policy":{"name":"fixture","version":"1"},"source":binding.source_selection().unwrap()})).unwrap();
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread("thread", "branch").unwrap();
    let prepared = db
        .prepare_submission(
            SubmitInput {
                key: "source".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: None,
                input: json!("Run and inspect these jobs"),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap()
        .load(Some(launch.clone()), false)
        .unwrap();
    let source = db.admit_submission(prepared).unwrap();
    binding.run_id = source.run_id.clone();
    issue(&mut storage, &storage_root, "source", &source.run_id, EPOCH);
    let (terminals, terminal_rx) = mpsc::channel();
    storage.set_process_terminal_sender(terminals);
    let runtime = Arc::new(RunSupervisor::new(db));
    let owner = runtime.catalog();
    let storage = Arc::new(Mutex::new(Some(storage)));
    let epoch = Arc::new(Mutex::new(EPOCH.to_owned()));
    let resources = KernelResourceClient::new(
        {
            let storage = storage.clone();
            let epoch = epoch.clone();
            move |request| {
                let mut storage = storage.lock().unwrap();
                let result = serve_resource(
                    storage.as_mut().unwrap(),
                    &epoch.lock().unwrap(),
                    HOST,
                    GENERATION,
                    &request,
                );
                request.reply.send(result).unwrap();
                Ok(())
            }
        },
        |_| Ok(()),
        crate::process::ProcessControlRegistry::default(),
    );
    let executor = KernelToolExecutor::new(binding.clone(), resources.clone()).unwrap();
    let token = CancellationToken::default();
    let mut processes = Vec::new();
    for (index, marker) in ["followup-original-output", "unrelated-process-output"]
        .into_iter()
        .enumerate()
    {
        let (command, args) = if cfg!(windows) {
            ("cmd.exe", vec!["/c".to_owned(), format!("echo {marker}")])
        } else {
            (
                "/bin/sh",
                vec!["-c".to_owned(), format!("printf '{marker}\\n'")],
            )
        };
        let call = ToolCall {
            call_id: "spawn".into(),
            name: "process_spawn".into(),
            schema_version: "1".into(),
            arguments: json!({"cwd":"","command":command,"args":args,"env":[],"mode":"pipe"}),
        };
        let (context, frozen) = model_call(
            &owner,
            &source.run_id,
            &format!("spawn-{index}"),
            &call,
            &tools,
        );
        let contract = executor.prepare(&call, &frozen, &token).unwrap();
        record(
            &owner,
            &source.run_id,
            ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call: call.clone(),
                    contract: contract.clone(),
                },
            },
        );
        executor
            .authorize(&context, &call, &contract, &token)
            .unwrap();
        record(
            &owner,
            &source.run_id,
            ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: ExecutorOwner::Kernel,
            },
        );
        let completion = executor.execute(&context, &call, &contract, &token);
        assert!(
            matches!(completion, ToolCompletion::JobAccepted { .. }),
            "real process acceptance: {completion:?}"
        );
        close_call(&owner, &context, &call, completion, false);
        let terminal = terminal_rx
            .recv_timeout(Duration::from_secs(20))
            .expect("original guardian terminal receipt");
        assert_eq!(terminal.process_id, context.operation_id);
        apply_process_terminal(&runtime, &terminal).unwrap();
        processes.push(context.operation_id);
    }
    record(
        &owner,
        &source.run_id,
        ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    );
    owner
        .lock()
        .unwrap()
        .register_followup("one-shot", &source.run_id, &processes[0])
        .unwrap();
    let new_run = varin_runtime::catalog::followups::reconcile(&owner)
        .unwrap()
        .pop()
        .unwrap();
    issue(
        storage.lock().unwrap().as_mut().unwrap(),
        &storage_root,
        "continuation",
        &new_run,
        EPOCH,
    );
    let mut current = binding.clone();
    current.run_id = new_run.clone();
    current.grant_id = "continuation".into();
    let directory = varin_runtime::composition::tools::ToolDirectory::assemble(
        crate::process_wait::declarations(owner.clone(), current.clone(), resources.clone()),
    )
    .unwrap();
    let directory = Arc::new(directory);
    let call = read_call(&processes[0]);
    let (context, frozen) = model_call(&owner, &new_run, "read-result", &call, &tools);
    let bound = directory.clone().bind_call(&call, &frozen, &token).unwrap();
    let contract = bound.prepare(&token).unwrap();
    record(
        &owner,
        &new_run,
        ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call: call.clone(),
                contract: contract.clone(),
            },
        },
    );
    bound.authorize(&context, &contract, &token).unwrap();
    record(
        &owner,
        &new_run,
        ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: bound.executor_owner(),
        },
    );
    let end = Instant::now() + Duration::from_secs(10);
    let completion = loop {
        let result = bound.execute(&context, &contract, &token).completion;
        if let ToolCompletion::Result { content, .. } = &result {
            if content["process"]["outputComplete"] == true {
                break result;
            }
        }
        assert!(Instant::now() < end, "real process output did not close");
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(text(&completion).contains("followup-original-output"));
    let other = read_call(&processes[1]);
    let other_bound = directory
        .clone()
        .bind_call(&other, &frozen, &token)
        .unwrap();
    let other_contract = other_bound.prepare(&token).unwrap();
    assert!(
        other_bound
            .authorize(&context, &other_contract, &token)
            .is_err(),
        "another process from the same source Run is not delegated"
    );
    // A changed kernel epoch can read the original durable output using fresh current authority,
    // without reissuing the original grant or spawning either command a second time.
    {
        let old = storage.lock().unwrap().take().unwrap();
        drop(old);
    }
    *storage.lock().unwrap() = Some(Storage::open(&storage_root, HOST).unwrap());
    *epoch.lock().unwrap() = "replacement-epoch".into();
    issue(
        storage.lock().unwrap().as_mut().unwrap(),
        &storage_root,
        "rebound",
        &new_run,
        "replacement-epoch",
    );
    current.grant_id = "rebound".into();
    let rebound = varin_runtime::composition::tools::ToolDirectory::assemble(
        crate::process_wait::declarations(owner.clone(), current.clone(), resources.clone()),
    )
    .unwrap();
    let rebound = Arc::new(rebound);
    let rebound_call = rebound.clone().bind_call(&call, &frozen, &token).unwrap();
    let rebound_contract = rebound_call.prepare(&token).unwrap();
    let missing_root = rebound_call
        .authorize(&context, &rebound_contract, &token)
        .unwrap_err();
    assert_eq!(missing_root.code, "unauthorized");
    assert!(missing_root.message.contains("file root is not registered"));
    // Live-source cold admission re-registers the same physical root each epoch. A fresh
    // Run grant alone must not carry that registration or revive the original Run grant.
    let registered_again = dispatch(
        storage.lock().unwrap().as_mut().unwrap(),
        "rebound",
        "file.root.register",
        json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":cwd}),
        "replacement-epoch",
    );
    assert_eq!(registered_again["rootId"], registered["rootId"]);
    rebound_call
        .authorize(&context, &rebound_contract, &token)
        .unwrap();
    let output = rebound_call
        .execute(&context, &rebound_contract, &token)
        .completion;
    assert!(text(&output).contains("followup-original-output"));
    close_call(&owner, &context, &call, completion, true);
    record(
        &owner,
        &new_run,
        ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    );
    let unrelated = {
        let mut db = owner.lock().unwrap();
        let prepared = db
            .prepare_submission(
                SubmitInput {
                    key: "unrelated-user".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: db.head("branch").unwrap(),
                    input: json!("Another user Run"),
                    configuration: json!({}),
                },
                None,
                None,
            )
            .unwrap()
            .load(Some(launch), false)
            .unwrap();
        db.admit_submission(prepared).unwrap()
    };
    issue(
        storage.lock().unwrap().as_mut().unwrap(),
        &storage_root,
        "unrelated",
        &unrelated.run_id,
        "replacement-epoch",
    );
    let mut unrelated_binding = current.clone();
    unrelated_binding.run_id = unrelated.run_id.clone();
    unrelated_binding.grant_id = "unrelated".into();
    let unrelated_directory = varin_runtime::composition::tools::ToolDirectory::assemble(
        crate::process_wait::declarations(owner.clone(), unrelated_binding, resources.clone()),
    )
    .unwrap();
    let unrelated_directory = Arc::new(unrelated_directory);
    let (unrelated_context, unrelated_frozen) =
        model_call(&owner, &unrelated.run_id, "unrelated-read", &call, &tools);
    let unrelated_call = unrelated_directory
        .clone()
        .bind_call(&call, &unrelated_frozen, &token)
        .unwrap();
    let unrelated_contract = unrelated_call.prepare(&token).unwrap();
    assert!(
        unrelated_call
            .authorize(&unrelated_context, &unrelated_contract, &token)
            .is_err(),
        "another Run on the same Thread does not inherit the one-shot process capability"
    );
    drop(unrelated_call);
    drop(unrelated_directory);
    storage
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .revoke_grant(&json!({"grantId":"rebound"}), HOST)
        .unwrap();
    assert!(
        rebound_call
            .authorize(&context, &rebound_contract, &token)
            .is_err(),
        "current grant revocation is rechecked"
    );
    issue(
        storage.lock().unwrap().as_mut().unwrap(),
        &storage_root,
        "rebound-second",
        &new_run,
        "replacement-epoch",
    );
    current.grant_id = "rebound-second".into();
    let second = varin_runtime::composition::tools::ToolDirectory::assemble(
        crate::process_wait::declarations(owner.clone(), current, resources.clone()),
    )
    .unwrap();
    let second = Arc::new(second);
    let second_call = second.clone().bind_call(&call, &frozen, &token).unwrap();
    let second_contract = second_call.prepare(&token).unwrap();
    storage
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .revoke_grant(&json!({"grantId":"source"}), HOST)
        .unwrap();
    assert!(
        second_call
            .authorize(&context, &second_contract, &token)
            .is_err(),
        "original grant revocation is never repaired by a new continuation grant"
    );
    let ToolCompletion::Result { content, .. } = &output else {
        unreachable!()
    };
    assert_eq!(content["process"]["kernelEpoch"], EPOCH);
    drop(second_call);
    drop(second);
    drop(rebound_call);
    drop(rebound);
    drop(other_bound);
    drop(bound);
    drop(directory);
    drop(executor);
    drop(resources);
    drop(storage);
    drop(owner);
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}
