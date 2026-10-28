//! Shared source-less child admission for original MCP consumer tests. No alternative owner.
use super::mcp_review_fixture::*;
use super::*;
use crate::host_tools::ToolBridge;
use std::time::{Duration, Instant};
use varin_runtime::catalog::collaboration::{ChildCodeResult, ChildSource, ChildTask};
use varin_runtime::catalog::dispatch::ChildWorkMode;
use varin_runtime::catalog::launches::{ExtensionToolBinding, HostToolBinding};
use varin_runtime::execution::*;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod child_fixture;
pub(super) struct PreparedChild {
    pub runtime: Arc<RunSupervisor>,
    pub bridge: ToolBridge,
    pub outgoing: mpsc::Receiver<Value>,
    pub binding: RequestBinding,
    pub executor: Arc<dyn ToolExecutor>,
    pub child: ChildTask,
    pub tools: Arc<crate::run_tools::RunTools>,
    pub catalog_root: PathBuf,
}
fn prepared(
    host: &mut Host,
    runtime: &Arc<RunSupervisor>,
    bridge: &ToolBridge,
    outgoing: &mpsc::Receiver<Value>,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline);
        if let Some(frame) = host.pump(runtime, bridge, outgoing) {
            assert_eq!(frame["kind"], "fixture-prepared");
            return frame;
        }
    }
}
pub(super) fn prepare_child(
    host: &mut Host,
    mcp: HostToolBinding,
    extension: ExtensionToolBinding,
    task: ToolSchema,
    selected: Vec<String>,
) -> PreparedChild {
    let dispatch_schema = crate::child_capabilities::schemas()
        .into_iter()
        .find(|tool| tool.name == "dispatch")
        .unwrap();
    let expected_routes: std::collections::BTreeMap<String, varin_runtime::McpRoute> = mcp
        .routes
        .iter()
        .filter(|(name, _)| selected.contains(name))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let count = selected.len();
    let parent_mcp = mcp.clone();
    let parent_extension = extension.clone();
    let parent_dispatch = dispatch_schema.clone();
    let f = child_fixture::Fixture::new_parent_custom(
        0,
        task.clone(),
        dispatch_schema.clone(),
        false,
        false,
        false,
        move |input, launch| {
            input.task = "Consume original MCP capabilities without file authority".into();
            input.work_mode = Some(ChildWorkMode::ReadOnly);
            input.tools = Some(selected);
            launch.source = None;
            launch.tools = parent_mcp.tools.clone();
            launch.tools.push(parent_extension.tool.clone());
            launch.tools.push(parent_dispatch);
            launch.mcp_binding = Some(parent_mcp);
            launch.extension_bindings = vec![parent_extension];
        },
    );
    let context = f.context.clone();
    let input = f.input.clone();
    let catalog_root = f.root.clone();
    let runtime = Arc::new(RunSupervisor::new(f.db));
    let (tx, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    host.send(json!({"kind":"fixture-consumer-parent","runId":context.run_id}));
    let parent_live = prepared(host, &runtime, &bridge, &outgoing);
    assert_eq!(
        parent_live["live"]["binding"],
        serde_json::to_value(&mcp).unwrap()
    );
    let directory = Arc::new(
        varin_runtime::composition::tools::ToolDirectory::assemble(
            crate::collaboration::declarations(
                runtime.catalog(),
                None,
                crate::tools::KernelResourceClient::new(
                    |_| panic!("source-less dispatch must not create a source grant"),
                    |_| Ok(()),
                    Default::default(),
                ),
                bridge.clone(),
            ),
        )
        .unwrap(),
    );
    let frozen = FrozenToolContext { tool_output_visible_bytes: None, execution_environment: None, direct_tools: None,
        run_id: context.run_id.clone(),
        origin: context.origin.clone(),
        tools: Arc::new(vec![dispatch_schema.clone()]),
        tool_schema_generation: 1,
        source: None,
        child_dispatch: runtime
            .catalog()
            .lock()
            .unwrap()
            .launch_metadata(&context.run_id)
            .unwrap()
            .unwrap()
            .dispatch_context_ref,
        resource_checkpoint_id: None,
        resource_activations: vec![],
    };
    let call = ToolCall {
        call_id: "dispatch-call".into(),
        name: dispatch_schema.name,
        schema_version: dispatch_schema.version,
        arguments: serde_json::to_value(input).unwrap(),
    };
    let invocation = directory
        .clone()
        .bind_call(&call, &frozen, &CancellationToken::default())
        .unwrap();
    let contract = invocation.prepare(&CancellationToken::default()).unwrap();
    invocation
        .authorize(&context, &contract, &CancellationToken::default())
        .unwrap();
    let (done_tx, done) = mpsc::channel();
    let dispatch_context = context.clone();
    let worker = thread::spawn(move || {
        done_tx
            .send(invocation.execute(&dispatch_context, &contract, &CancellationToken::default()))
            .unwrap()
    });
    let mut dispatched = None;
    host.until(&runtime, &bridge, &outgoing, || {
        dispatched = done.try_recv().ok();
        dispatched.is_some()
    });
    worker.join().unwrap();
    let completion = dispatched.unwrap().completion;
    assert!(matches!(completion, ToolCompletion::JobAccepted { .. }));
    let child = {
        let catalog = runtime.catalog();
        let mut db = catalog.lock().unwrap();
        let epoch = db.epoch();
        db.commit_execution(
            &context.run_id,
            epoch,
            &ExecutionRecord::ToolSettled {
                executor_stopped: false,
                context: context.clone(),
                completion: completion.clone(),
            },
        )
        .unwrap();
        db.commit_execution(
            &context.run_id,
            epoch,
            &ExecutionRecord::ToolBatchCommitted {
                request_id: "parent-request".into(),
                results: vec![ToolResult {
                    request_id: "parent-request".into(),
                    call_id: "dispatch-call".into(),
                    completion,
                }],
            },
        )
        .unwrap();
        db.child_task(&context.operation_id).unwrap()
    };
    assert_eq!(child.source, ChildSource::Absent);
    assert_eq!(child.code_result, ChildCodeResult::NotApplicable);
    assert!(child.launch.source.is_none());
    let child_view = runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_child_read(child.clone())
        .load()
        .unwrap();
    assert_eq!(child_view.launch.extension_bindings, vec![extension]);
    assert_eq!(
        child_view.launch.mcp_binding.as_ref().unwrap().routes,
        expected_routes
    );
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: "mcp-consumer-child".into(),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Source-less MCP consumer".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"mcp-consumer-child","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":child.child_thread_id,"projectId":null,"originalSections":[{"name":"preamble","content":"Source-less MCP consumer"}],"instructionSources":[]})).unwrap();
    let preparation = runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_child_preparation(&child.execution_id, None, proposal, basis)
        .unwrap();
    let admitted = runtime
        .catalog()
        .lock()
        .unwrap()
        .admit_child(preparation.load().unwrap())
        .unwrap();
    let receipt = admitted.receipt.as_ref().unwrap();
    let run_id = receipt.run_id.clone();
    host.send(json!({"kind":"fixture-consumer-child","runId":run_id,"threadId":child.child_thread_id,"source":null,
        "mcpBinding":child_view.launch.mcp_binding,"extensionBinding":child_view.launch.extension_bindings[0]}));
    let child_live = prepared(host, &runtime, &bridge, &outgoing);
    let live =
        live_mcp_binding(serde_json::from_value(child_live["live"].clone()).unwrap()).unwrap();
    let extension =
        live_extension_binding(serde_json::from_value(child_live["extension"].clone()).unwrap())
            .unwrap();
    let preparation = runtime
        .catalog()
        .lock()
        .unwrap()
        .prepare_mcp_change(&run_id, live.binding.clone())
        .unwrap();
    let prepared_launch = preparation.load().unwrap();
    let launch = runtime
        .catalog()
        .lock()
        .unwrap()
        .admit_launch_change(prepared_launch)
        .unwrap()
        .load()
        .unwrap()
        .selection;
    assert!(launch.source.is_none());
    assert_eq!(launch.tools.len(), count);
    let binding = RequestBinding { tool_output_visible_bytes: None, mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
        provider_id: None,
        tokenizer: None,
        request_context: None,
        child_dispatch: None,
        goal: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        connection_identity: launch.connection_identity.clone(),
        provider_family: launch.provider_family.clone(),
        model: launch.model.clone(),
        credential_ref: launch
            .credential_scope
            .as_ref()
            .map(|scope| scope.reference.clone()),
        configuration_generation: launch.configuration_generation,
        tool_schema_generation: launch.tool_schema_generation,
        tools: launch.tools.clone(),
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: child.child_branch_id.clone(),
            ancestor_id: None,
            leaf_id: Some(receipt.input_id.clone()),
        },
    };
    runtime
        .catalog()
        .lock()
        .unwrap()
        .bind_launch(&run_id, launch.clone())
        .unwrap();
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone());
    let prepared_tools = tools
        .prepare_scope(&run_id, vec![], Some(live), vec![extension])
        .unwrap();
    assert_eq!(prepared_tools.schemas(), launch.tools);
    let executor = prepared_tools.into_static().unwrap();
    PreparedChild {
        runtime,
        bridge,
        outgoing,
        binding,
        executor,
        child,
        tools,
        catalog_root,
    }
}
