//! Real Engine, collaboration endpoint, Catalog and Storage; no Host transport or paid provider.
use super::*;
use crate::storage::Storage;
use crate::tools::{serve_resource, FixedFileSource, KernelToolExecutor, ToolKind};
use std::collections::BTreeSet;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use varin_runtime::catalog::{context::ContextProposal, launches::LaunchSelection};
use varin_runtime::{HistorySource, RunState, SourceMode, SubmitInput};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;

const HOST: &str = "policy-child-host";
const GENERATION: &str = "policy-child-generation";
const EPOCH: &str = "policy-child-epoch";
fn setup_call(storage: &mut Storage, method: &str, params: Value) {
    let (grant, params) = storage
        .authorize(Some("setup"), EPOCH, HOST, GENERATION, method, &params)
        .unwrap();
    storage
        .dispatch(method, &params, Some("setup"), &grant)
        .unwrap();
}
#[derive(Default)]
struct Provider {
    requests: Mutex<Vec<RequestView>>,
}
impl ModelProvider for Provider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        snapshot: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.requests.lock().unwrap().push(snapshot.view.clone());
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "report".into(),
                content: Content::Text {
                    text: "READ_ONLY_CHILD_REPORT".into(),
                },
                opaque: None,
            },
        })
        .unwrap();
        Ok(FinishReason::Stop)
    }
}
struct Sequence {
    decisions: AtomicUsize,
    cancel_before_park: bool,
}
impl AgentPolicy for Sequence {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "child-sequence".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        self.decisions.fetch_add(1, Ordering::SeqCst);
        let node = |id: &str, name: &str, arguments: Value| PolicyAction::ToolGraph {
            nodes: vec![PolicyToolNode {
                id: id.into(),
                depends_on: vec![],
                call: ToolCall {
                    call_id: id.into(),
                    name: name.into(),
                    schema_version: "1".into(),
                    arguments,
                },
            }],
        };
        let (action, state) = match state["stage"].as_u64().unwrap_or(0) {
            0 => (
                node(
                    "delegate",
                    "dispatch",
                    json!({"task":"Read the fixed source and report","model":"parent","profile":"read_only"}),
                ),
                json!({"stage":1}),
            ),
            1 => {
                let PolicyEvent::ToolGraphCompleted { receipts, .. } = event else {
                    panic!("expected dispatch completion")
                };
                let PolicyNodeCompletion::JobAccepted { operation_id, .. } =
                    &receipts[0].completion
                else {
                    panic!("dispatch was not accepted: {receipts:?}")
                };
                (
                    node(
                        "independent-status",
                        "child_status",
                        json!({"operationId":operation_id}),
                    ),
                    json!({"stage":2,"child":operation_id}),
                )
            }
            2 => {
                let PolicyEvent::ToolGraphCompleted { receipts, .. } = event else {
                    panic!("expected independent status")
                };
                assert_eq!(receipts[0].outcome(), Outcome::Succeeded);
                (
                    node(
                        "observe",
                        "wait_child",
                        json!({"operationId":state["child"]}),
                    ),
                    json!({"stage":3,"child":state["child"]}),
                )
            }
            3 => {
                assert!(
                    view.history.iter().any(|item| if self.cancel_before_park {
                        matches!(&item.provenance, Provenance::EnvironmentFact { .. })
                            && serde_json::to_string(&item.content)
                                .unwrap()
                                .contains("observation wait was cancelled")
                    } else {
                        matches!(&item.provenance, Provenance::AgentMessage { .. })
                            && serde_json::to_string(&item.content)
                                .unwrap()
                                .contains("READ_ONLY_CHILD_REPORT")
                    }),
                    "strategy advanced before observation delivery"
                );
                (PolicyAction::RequestModel, json!({"stage":4}))
            }
            4 => (PolicyAction::Complete, json!({"stage":5})),
            _ => panic!("strategy checkpoint advanced past its action"),
        };
        Ok(PolicyDecision { action, state })
    }
}
struct Hooks {
    directory: Arc<dyn ToolExecutor>,
    catalog: Arc<Mutex<Catalog>>,
    cancel_wait: bool,
    accepted: mpsc::Sender<String>,
    release: Arc<Mutex<mpsc::Receiver<()>>>,
}
struct HookCall {
    inner: Box<dyn PreparedToolCall>,
    name: String,
    catalog: Arc<Mutex<Catalog>>,
    cancel_wait: bool,
    accepted: mpsc::Sender<String>,
    release: Arc<Mutex<mpsc::Receiver<()>>>,
}
impl ToolExecutor for Hooks {
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        Ok(Box::new(HookCall {
            inner: self.directory.clone().bind_call(call, context, cancel)?,
            name: call.name.clone(),
            catalog: self.catalog.clone(),
            cancel_wait: self.cancel_wait,
            accepted: self.accepted.clone(),
            release: self.release.clone(),
        }))
    }
    fn plan(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        unreachable!()
    }
    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        unreachable!()
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        unreachable!()
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        unreachable!()
    }
}
impl PreparedToolCall for HookCall {
    fn plan(&self, c: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        self.inner.plan(c)
    }
    fn prepare(&self, c: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        self.inner.prepare(c)
    }
    fn execution_class(
        &self,
        c: &ToolContract,
    ) -> varin_runtime::execution_capacity::ExecutionClass {
        self.inner.execution_class(c)
    }
    fn watch_admission(
        &self,
        x: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> Result<Option<varin_runtime::execution_capacity::AdmissionControlGuard>, ExecutionError>
    {
        self.inner.watch_admission(x, c, t)
    }
    fn supports_policy_read(&self, c: &ToolContract) -> bool {
        self.inner.supports_policy_read(c)
    }
    fn authorize(
        &self,
        x: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.inner.authorize(x, c, t)
    }
    fn execute(
        &self,
        x: &ToolExecutionContext,
        c: &ToolContract,
        t: &CancellationToken,
    ) -> ToolCompletion {
        let completion = self.inner.execute(x, c, t);
        if self.name == "dispatch" {
            assert!(matches!(completion, ToolCompletion::JobAccepted { .. }));
            self.accepted.send(x.operation_id.clone()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
        if self.name == "wait_child" && self.cancel_wait {
            assert!(matches!(completion, ToolCompletion::JobAccepted { .. }));
            let mut owner = self.catalog.lock().unwrap();
            assert_ne!(
                owner.run(&x.run_id).unwrap().state,
                RunState::Waiting,
                "cancel must precede parent park"
            );
            owner
                .request_cancel_child_wait(&format!("child-wait:{}", x.operation_id))
                .unwrap();
        }
        completion
    }
}
fn execution_input(db: &Mutex<Catalog>, run: &str, policy: PolicyIdentity) -> ExecutionInput {
    let owner = db.lock().unwrap();
    let launch = owner.launch_intent(run).unwrap().unwrap().selection;
    let run_record = owner.run(run).unwrap();
    let binding = RequestBinding {
        connection_identity: launch.connection_identity,
        provider_family: launch.provider_family,
        model: launch.model,
        credential_ref: Some("credential-ref".into()),
        configuration_generation: launch.configuration_generation,
        tool_schema_generation: launch.tool_schema_generation,
        tools: launch.tools,
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: run_record.branch_id.clone(),
            ancestor_id: None,
            leaf_id: owner.head(&run_record.branch_id).unwrap(),
        },
    };
    owner
        .prepare_execution(run, binding, policy, Value::Null)
        .unwrap()
}
fn run_sequence(cancel_before_park: bool) {
    let root = std::env::temp_dir().join(format!(
        "varin-policy-child-engine-{}",
        uuid::Uuid::new_v4()
    ));
    let mut catalog = Catalog::open(&root).unwrap();
    catalog.create_thread("parent", "main").unwrap();
    let kinds = BTreeSet::from([ToolKind::FileRead]);
    let read = KernelToolExecutor::selected_schemas(&kinds).remove(0);
    let tools = schemas(vec![read], true);
    let sequence = Arc::new(Sequence {
        decisions: AtomicUsize::new(0),
        cancel_before_park,
    });
    let identity = policy_identity(sequence.identity());
    let launch: LaunchSelection = serde_json::from_value(json!({"connection_identity":"frozen-connection","provider_family":"fixture","model":"fixture-model",
        "configuration_generation":2,"tool_schema_generation":1,"tools":tools,"policy":identity,
        "source":{"mode":"fixed_branch","live_root":null,"workspace_id":"workspace-A","execution_workspace_id":"workspace-A","branch_id":"fixed-parent","revision":0},
        "credential_scope":{"reference":"credential-ref","authority":"credential-owner","account":"account-A","generation":3}})).unwrap();
    let receipt = catalog
        .submit_with_launch(
            &SubmitInput {
                key: "parent-input".into(),
                thread_id: "parent".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("delegate then observe"),
                configuration: json!({}),
            },
            Some(launch),
        )
        .unwrap();
    let run = receipt.run_id;
    let db = Arc::new(Mutex::new(catalog));
    let storage_root = root.join("storage");
    let mut storage = Storage::open(&storage_root, HOST).unwrap();
    for grant in ["setup", "parent"] {
        storage.issue_grant(&json!({"grantId":grant,"hostGeneration":GENERATION,"capabilities":if grant=="setup" {vec!["storage.admin"]} else {vec!["storage.read","storage.write"]},
            "pathScopes":[""],"owningWorkspace":"workspace-A","executionWorkspace":"workspace-A","threadId":"parent","runId":run}),HOST,GENERATION,&storage_root.to_string_lossy(),EPOCH).unwrap();
    }
    setup_call(
        &mut storage,
        "branch.create.begin",
        json!({"builderId":"builder","operationId":"begin","branchId":"fixed-parent","workspaceId":"workspace-A","draftBasePaths":[],"captureScopes":[]}),
    );
    setup_call(
        &mut storage,
        "branch.create.finish",
        json!({"builderId":"builder","operationId":"begin"}),
    );
    let storage = Arc::new(Mutex::new(storage));
    let pins = Arc::new(AtomicUsize::new(0));
    let resources = KernelResourceClient::new(
        {
            let storage = storage.clone();
            let pins = pins.clone();
            move |request| {
                let result = serve_resource(
                    &mut storage.lock().unwrap(),
                    EPOCH,
                    HOST,
                    GENERATION,
                    &request,
                );
                if result
                    .as_ref()
                    .is_ok_and(|value| value.get("pinId").is_some())
                {
                    pins.fetch_add(1, Ordering::SeqCst);
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
        run_id: run.clone(),
        thread_id: "parent".into(),
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
        varin_runtime::composition::tools::ToolDirectory::assemble(declarations(
            db.clone(),
            Some(binding),
            resources,
        ))
        .unwrap(),
    );
    let (accepted_tx, accepted_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let hooks = Arc::new(Hooks {
        directory,
        catalog: db.clone(),
        cancel_wait: cancel_before_park,
        accepted: accepted_tx,
        release: Arc::new(Mutex::new(release_rx)),
    });
    let policy = Arc::new(CollaborationPolicy {
        inner: sequence.clone(),
        catalog: db.clone(),
    });
    let provider = Arc::new(Provider::default());
    let engine = Arc::new(ExecutionEngine {
        persistence: db.clone(),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: provider.clone(),
        tools: hooks.clone(),
        policy: policy.clone(),
        progress: ProgressSink::default(),
    });
    let input = execution_input(&db, &run, identity.clone());
    let handle = std::thread::spawn({
        let engine = engine.clone();
        move || engine.run(input, CancellationToken::default())
    });
    let operation = accepted_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    let child = db.lock().unwrap().child_task(&operation).unwrap();
    assert!(matches!(child.origin, ToolOrigin::PolicyAction { .. }));
    assert_eq!(child.source_pin.pin_id, format!("child-pin:{operation}"));
    assert!(child.receipt.is_none());
    setup_call(
        &mut storage.lock().unwrap(),
        "branch.create.begin",
        json!({
            "builderId":"child-source-builder","operationId":format!("create-child-source:{operation}"),"branchId":format!("child-source:{operation}"),
            "workspaceId":"workspace-A","baseRef":child.source_pin.root,
            "parentRef":"fixed-parent@0","draftBasePaths":[],"captureScopes":[],
        }),
    );
    setup_call(
        &mut storage.lock().unwrap(),
        "branch.create.finish",
        json!({
            "builderId":"child-source-builder","operationId":format!("create-child-source:{operation}"),
        }),
    );
    let mut source = child.source_pin.source.clone();
    source.branch_id = Some(format!("child-source:{operation}"));
    source.revision = Some(0);
    let proposal = ContextProposal {
        key: format!("context:{operation}"),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Read-only child".into(),
        instruction_sources: vec!["test:child".into()],
        memory_checkpoint: None,
    };
    let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"test:child","memorySnapshot":{"revision":0,"memories":[]},
        "sessionId":child.child_thread_id,"projectId":null,"originalSections":[{"name":"preamble","content":"Read-only child"}],"instructionSources":["test:child"]})).unwrap();
    let preparation = db
        .lock()
        .unwrap()
        .capture_child_preparation(&operation, source, proposal, basis)
        .unwrap();
    let (prepare_tx, prepare_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();
    let child_worker = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        prepare_rx.recv().unwrap();
        preparation.load().unwrap()
    });
    ready_rx.recv().unwrap();
    release_tx.send(()).unwrap();
    let waiting = handle.join().unwrap().unwrap();
    assert_eq!(waiting.state, RunState::Waiting);
    assert_eq!(
        waiting.policy_state["stage"], 3,
        "wrapper cannot checkpoint an unexecuted inner action"
    );
    assert_eq!(
        sequence.decisions.load(Ordering::SeqCst),
        3,
        "pending Wait must not call the strategy"
    );
    assert!(provider.requests.lock().unwrap().is_empty());
    assert!(
        db.lock()
            .unwrap()
            .child_task(&operation)
            .unwrap()
            .receipt
            .is_none(),
        "parent reached status and wait while child preparation stayed blocked"
    );
    prepare_tx.send(()).unwrap();
    let prepared_child = child_worker.join().unwrap();
    let child = db.lock().unwrap().admit_child(prepared_child).unwrap();
    let child_run = child.receipt.as_ref().unwrap().run_id.clone();
    let child_input = execution_input(&db, &child_run, DefaultAgentPolicy.identity());
    let child_engine = ExecutionEngine {
        persistence: db.clone(),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: provider.clone(),
        tools: hooks,
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    };
    assert_eq!(
        child_engine
            .run(child_input, CancellationToken::default())
            .unwrap()
            .state,
        RunState::Completed
    );
    varin_runtime::catalog::child_delivery::deliver_waits(&db).unwrap();
    varin_runtime::catalog::child_delivery::deliver_waits(&db).unwrap();
    let input = execution_input(&db, &run, identity);
    assert_eq!(
        engine
            .run(input, CancellationToken::default())
            .unwrap()
            .state,
        RunState::Completed
    );
    let owner = db.lock().unwrap();
    assert_eq!(owner.child_tasks().unwrap().len(), 1);
    assert!(!owner.operation(&operation).unwrap().cancel_requested);
    let events = owner.events_after(0, 1000).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "child.wait_registered")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "child.wait_delivered")
            .count(),
        1
    );
    assert_eq!(
        owner
            .child_task(&operation)
            .unwrap()
            .report
            .unwrap()
            .outcome,
        Outcome::Succeeded
    );
    assert_eq!(
        owner
            .history("main")
            .unwrap()
            .iter()
            .filter(|i| i.source == HistorySource::Agent)
            .count(),
        if cancel_before_park { 0 } else { 1 }
    );
    assert_eq!(pins.load(Ordering::SeqCst), 1);
    let database = rusqlite::Connection::open(root.join("conversation.sqlite")).unwrap();
    assert_eq!(
        database
            .query_row("SELECT count(*) FROM resource_occupancy", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(database);
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].run_id, child_run);
    assert_eq!(requests[1].run_id, run);
    drop(requests);
    drop(owner);
    drop(child_engine);
    drop(engine);
    drop(policy);
    drop(db);
    drop(storage);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn policy_dispatch_prepares_independently_then_waits_reports_and_continues() {
    run_sequence(false);
}
#[test]
fn cancelled_policy_child_wait_before_park_delivers_cancellation_without_losing_next_action() {
    run_sequence(true);
}
