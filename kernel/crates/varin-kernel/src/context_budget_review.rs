//! Actual budget extension, ContextService and RunAssembly via the existing stdio fixture.
//! Only model generation is controlled; serialization, summary ownership and publication are real.
use super::web_domain_review::{Fixture, Host, EPOCH, HOST};
use super::*;
use crate::run_assembly::{PreparedLaunch, RunAssembly, RunPreparation};
use crate::storage::Storage;
use std::path::Path;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod dispatch_fixture;

struct Generation {
    request: RequestSnapshot,
    finish: mpsc::Sender<String>,
}
struct ControlledModel {
    serializer: Arc<dyn ModelProvider>,
    actual_input_tokens: Option<u64>,
    sends: mpsc::Sender<Generation>,
}
impl ModelProvider for ControlledModel {
    fn request_budget_protocol(
        &self,
    ) -> Option<varin_runtime::context_capacity::RequestBudgetProtocol> {
        self.serializer.request_budget_protocol()
    }
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        self.serializer.serialize(view)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let failure = |code: &str| ModelFailure {
            code: code.into(),
            message: code.into(),
            retry_after_ms: None,
            provider_request_id: None,
        };
        let (finish, receive) = mpsc::channel();
        self.sends
            .send(Generation {
                request: request.clone(),
                finish,
            })
            .map_err(|_| failure("fixture_closed"))?;
        let text = loop {
            if cancel.is_cancelled() {
                return Err(failure("cancelled"));
            }
            match receive.recv_timeout(Duration::from_millis(10)) {
                Ok(text) => break text,
                Err(mpsc::RecvTimeoutError::Timeout) => (),
                Err(_) => return Err(failure("fixture_closed")),
            }
        };
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "answer".into(),
                content: Content::Text { text },
                opaque: None,
            },
        })
        .map_err(|_| failure("emit_failed"))?;
        emit(ProviderEvent::Usage {
            receipt: UsageReceipt {
                measurement: UsageMeasurement::Actual,
                input_tokens: Some(self.actual_input_tokens.unwrap_or_else(|| {
                    varin_runtime::context_capacity::estimate_request(
                        &request.view,
                        &request.serialized,
                    )
                    .estimated_tokens
                })),
                output_tokens: Some(3),
                raw: Some(json!({"controlled":true})),
                ..Default::default()
            },
        })
        .map_err(|_| failure("emit_failed"))?;
        Ok(FinishReason::Stop)
    }
}
/// Surface the original boundary failure rather than timing out with no diagnostic.
struct ObservedContext(Arc<dyn ContextPreparation>);
impl ContextPreparation for ObservedContext {
    fn prepare_binding(
        &self,
        run: &str,
        epoch: u64,
        binding: &mut RequestBinding,
        cancel: &CancellationToken,
    ) -> Result<varin_runtime::execution::ConversationHistory, ExecutionError> {
        self.0.prepare_binding(run, epoch, binding, cancel)
    }
    fn prepare(
        &self,
        run: &str,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.0.prepare(run, epoch, cancel)
    }
    fn prepare_request(
        &self,
        epoch: u64,
        view: &RequestView,
        serialized: &Value,
        protocol: Option<varin_runtime::context_capacity::RequestBudgetProtocol>,
        preview: &dyn Fn(ContextProjection) -> Result<varin_runtime::context_capacity::InputEstimate, ExecutionError>,
        cancel: &CancellationToken,
    ) -> Result<ContextRequestPreparation, ExecutionError> {
        self.0
            .prepare_request(epoch, view, serialized, protocol, preview, cancel)
            .inspect_err(|error| eprintln!("Context budget boundary failed: {}", error.code))
    }
}
struct Review {
    fixture: Fixture,
    assembly: RunAssembly,
    sends: mpsc::Sender<Generation>,
    generations: mpsc::Receiver<Generation>,
    actual_input_tokens: Option<u64>,
    notified_cursor: u64,
    connected: bool,
    with_goal: bool,
}
impl Review {
    fn open(root: &Path) -> Self {
        Self::with_catalog(root, Catalog::open(root.join("catalog")).unwrap())
    }
    fn with_catalog(root: &Path, catalog: Catalog) -> Self {
        let runtime = Arc::new(RunSupervisor::new(catalog));
        let (output, outgoing) = mpsc::sync_channel(256);
        let bridge = crate::host_tools::ToolBridge::new(output.clone().into());
        bridge.initialize(EPOCH);
        let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
        credentials.initialize(EPOCH).unwrap();
        let assembly = RunAssembly {
            runtime: runtime.clone(),
            resources: crate::tools::KernelResourceClient::new(
                |_| {
                    Err(KernelError::Operation(
                        "Source-free budget has no resource effect".into(),
                    ))
                },
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
            tools: crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone()),
            responses: output.into(),
            epoch: EPOCH.into(),
        };
        assembly.context.initialize(EPOCH);
        assembly.memory.initialize(EPOCH);
        assembly.resource.initialize(EPOCH);
        assembly.policy.initialize(EPOCH);
        assembly.policy.set_catalog(runtime.catalog());
        let storage_root = root.join("storage");
        let fixture = Fixture {
            host: Host::with_script(
                "packages/web/application-host/lib/kernel/context-budget-host.test-helper.ts",
            ),
            runtime,
            storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
            storage_root,
            bridge,
            outgoing,
        };
        let (sends, generations) = mpsc::channel();
        Self {
            fixture,
            assembly,
            sends,
            generations,
            actual_input_tokens: None,
            notified_cursor: 0,
            connected: false,
            with_goal: false,
        }
    }
    fn initialize(&mut self, root: &Path, reopen: bool) {
        if !reopen {
            self.fixture
                .runtime
                .catalog()
                .lock()
                .unwrap()
                .create_thread("thread:budget", "branch:budget")
                .unwrap();
        }
        self.fixture.host.send(json!({"kind":"fixture-initialize","root":root,"threadId":"thread:budget","branchId":"branch:budget",
            "epoch":EPOCH,"storageRoot":self.fixture.storage_root,"reopen":reopen,"withGoal":self.with_goal,
            "configuration":{"providerFamily":"openai-responses","model":"budget-controlled","endpoint":"https://controlled.invalid/responses",
                "allowAnonymous":true,"credentialEnvironment":null,"configurationGeneration":1,"maxOutputTokens":64,"contextWindowTokens":16384}}));
    }
    fn pump(&mut self) -> Option<Value> {
        self.fixture.runtime.reap().unwrap();
        let assembly = self.assembly.clone();
        let sends = self.sends.clone();
        let actual_input_tokens = self.actual_input_tokens;
        let mut failure = None;
        let mut connected = false;
        let frame=self.fixture.pump_dispatch(|frame| {
            connected=true;
            let method=frame["method"].as_str().unwrap();
            if !method.starts_with("runtime.") || method=="runtime.operation.inspect" { return None; }
            let params=frame["params"].clone();
            Some((|| {
                validate_method_params(method,&params)?;
                let runtime=assembly.runtime.clone(); let owner=runtime.catalog();
                if method=="runtime.thread.create" || method.starts_with("runtime.input.") || method=="runtime.child.prepare" {
                    return input_commands::execute(runtime,method,params,Arc::new(AtomicBool::new(false)),None);
                }
                if method.starts_with("runtime.child.") {
                    return child_commands::execute(runtime,assembly.resources.clone(),method,params,&AtomicBool::new(false));
                }
                if method == "runtime.goal.start" {
                    return crate::agent_goals::execute_rpc(owner, method, params, Arc::new(AtomicBool::new(false)));
                }
                match method {
                    "runtime.context.inspect" => {
                        let p:HistoryParams=serde_json::from_value(params)?;
                        let read=owner.lock().unwrap().capture_active_checkpoint(&p.branch_id).map_err(domain)?;
                        Ok(serde_json::to_value(read.map(|r|r.load()).transpose().map_err(domain)?)?)
                    }
                    "runtime.context_job.list" | "runtime.context_job.inspect" => {
                        let list=method.ends_with(".list");
                        let reads=if list { let p:HistoryParams=serde_json::from_value(params)?; owner.lock().unwrap().capture_context_jobs(&p.branch_id).map_err(domain)? }
                            else { let p:RunParams=serde_json::from_value(params)?; vec![owner.lock().unwrap().capture_context_job(&p.run_id).map_err(domain)?] };
                        let mut jobs=reads.into_iter().map(|r|r.load().map_err(domain)).collect::<Result<Vec<_>,_>>()?;
                        Ok(if list { serde_json::to_value(jobs)? } else { serde_json::to_value(jobs.remove(0))? })
                    }
                    "runtime.context_job.preview" => {
                        let _:ContextJobPreviewParams=serde_json::from_value(params.clone())?;
                        let mut params=params; params.as_object_mut().unwrap().insert("compaction".into(),Value::Null);
                        let p:ContextJobCreateParams=serde_json::from_value(params)?;
                        let prepare=prepare_context_job_mode(&owner.lock().unwrap(),p,true)?;
                        Ok(serde_json::to_value(prepare.preview().map_err(domain)?)?)
                    }
                    "runtime.context_job.create" => {
                        let p:ContextJobCreateParams=serde_json::from_value(params)?;
                        let prepare=prepare_context_job(&owner.lock().unwrap(),p)?;
                        let prepared=prepare.load().map_err(domain)?;
                        let result=owner.lock().unwrap().admit_prepared_context_job(prepared).map_err(domain)?;
                        Ok(serde_json::to_value(result)?)
                    }
                    "runtime.context_job.publish" => {
                        let p:RunParams=serde_json::from_value(params)?;
                        let prepare=owner.lock().unwrap().prepare_context_job_publication(&p.run_id).map_err(domain)?;
                        let prepared=prepare.load().map_err(domain)?;
                        let result=owner.lock().unwrap().publish_prepared_context_job(prepared).map_err(domain)?;
                        Ok(serde_json::to_value(result)?)
                    }
                    "runtime.context_job.resume" => {
                        let p:RunParams=serde_json::from_value(params)?;
                        runtime.quiesce_context_job(&p.run_id).map_err(|e|KernelError::Operation(e.to_string()))?;
                        let result=owner.lock().unwrap().resume_context_job_wait(&p.run_id).map_err(domain)?;
                        Ok(serde_json::to_value(result)?)
                    }
                    "runtime.launch.inspect" => {
                        let p:RunParams=serde_json::from_value(params)?;
                        let read=owner.lock().unwrap().capture_launch(&p.run_id).map_err(domain)?;
                        let mut launch=read.map(|r|r.load()).transpose().map_err(domain)?;
                        if let Some(launch)=&mut launch { launch.startable &= runtime.start_available(&p.run_id).map_err(|e|KernelError::Operation(e.to_string()))?; }
                        Ok(serde_json::to_value(launch)?)
                    }
                    "runtime.model.inspect" => { let p:RunParams=serde_json::from_value(params)?; Ok(serde_json::to_value(assembly.models.inspect(&p.run_id)?)?) }
                    "runtime.plan.reconcile" | "runtime.memory.reconcile" => {
                        let p:RunParams=serde_json::from_value(params)?; let (send,receive)=mpsc::sync_channel(8);
                        if method=="runtime.plan.reconcile" { crate::plan::reconcile(runtime,assembly.plan.clone(),p.run_id,"reconcile".into(),send.into(),Arc::new(|_|{}))?; }
                        else { crate::memory::reconcile(runtime,assembly.memory.clone(),p.run_id,"reconcile".into(),send.into(),Arc::new(|_|{}))?; }
                        let result=receive.recv_timeout(Duration::from_secs(5)).unwrap(); assert_eq!(result["ok"],true,"{result}"); Ok(result["result"].clone())
                    }
                    "runtime.run.start" => {
                        let p:RunStartParams=serde_json::from_value(params)?; let run=owner.lock().unwrap().run(&p.run_id).map_err(domain)?;
                        let prepared=RunPreparation::new(p,&run)?;
                        let PreparedLaunch::Start(mut start)=assembly.prepare(prepared,None,||false)? else { panic!("Run expected") };
                        start.provider=Arc::new(ControlledModel { serializer:start.provider.clone(), actual_input_tokens, sends:sends.clone() });
                        start.context_preparation=Arc::new(ObservedContext(start.context_preparation));
                        let job_read = { let catalog=owner.lock().unwrap(); if catalog.is_context_job(&run.id).map_err(domain)? { Some(catalog.capture_context_job(&run.id).map_err(domain)?) } else { None } };
                        if let Some(read)=job_read { start=varin_runtime::context_job::configure_compaction_start(start,read.load_execution().map_err(domain)?); }
                        let handle=runtime.start(&run.id,start).map_err(|e|KernelError::Operation(e.to_string()))?;
                        let result=json!({"runId":handle.run_id,"epoch":handle.epoch}); assembly.observe_completion(handle); Ok(result)
                    }
                    _ => dispatch(&mut owner.lock().unwrap(),method,params),
                }
            })())
        }, |frame,result| {
            if let Err(error)=result {
                eprintln!("Budget fixture RPC {} failed: {error}", frame["method"]);
                let response=crate::error::response_error(frame["id"].as_str().unwrap(),error);
                failure=Some(json!({"kind":"fixture-response","id":frame["id"],"ok":false,"error":response["error"]})); false
            } else { true }
        });
        self.connected |= connected;
        if self.connected {
            let cursor = self
                .fixture
                .runtime
                .catalog()
                .lock()
                .unwrap()
                .event_cursor()
                .unwrap();
            if cursor != self.notified_cursor {
                self.notified_cursor = cursor;
                self.fixture.host.send(json!({"v":crate::protocol::PROTOCOL_VERSION,"kind":"runtime-event","kernelEpoch":EPOCH,"stream":"durable","cursor":cursor}));
            }
        }
        if let Some(failure) = failure {
            self.fixture.host.send(failure);
            return None;
        }
        match frame {
            Some(frame) if frame["kind"] == "memory-response" => {
                self.assembly.memory.receive(frame);
                None
            }
            Some(frame) if frame["kind"] == "context-response" => {
                self.assembly.context.receive(frame);
                None
            }
            Some(frame) if frame["kind"] == "plan-response" => {
                self.assembly.plan.receive(frame);
                None
            }
            Some(frame) if frame["kind"] == "credential-response" => {
                self.assembly.credentials.receive(frame);
                None
            }
            frame => frame,
        }
    }
    fn receive(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(
                Instant::now() < deadline,
                "Budget lifecycle stalled at {kind}"
            );
            if let Some(frame) = self.pump() {
                assert_eq!(frame["kind"], kind, "{frame}");
                return frame;
            }
        }
    }
    fn generation(&mut self) -> Generation {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(generation) = self.generations.try_recv() {
                return generation;
            }
            assert!(Instant::now() < deadline, "Budget model dispatch stalled");
            if let Some(frame) = self.pump() {
                panic!("Unexpected frame during model preparation: {frame}");
            }
        }
    }
    fn completed(&mut self, run: &str) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let state = self
                .fixture
                .runtime
                .catalog()
                .lock()
                .unwrap()
                .run(run)
                .unwrap()
                .state;
            if state == varin_runtime::RunState::Completed {
                return;
            }
            assert!(!state.terminal(), "unexpected {state:?}");
            assert!(Instant::now() < deadline, "Run did not complete");
            if let Some(frame) = self.pump() {
                panic!("Unexpected completion frame: {frame}");
            }
        }
    }
}
#[test]
#[ignore = "requires built original Host packages; stdio and Node broker IPC only"]
fn selected_budget_freezes_summary_and_recovers_original_publication_without_paid_replay() {
    let root = std::env::temp_dir().join(format!("varin-context-budget-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut first = Review::open(&root);
    first.initialize(&root, false);
    let initial = first.receive("fixture-submitted");
    let initial_run = initial["receipt"]["run_id"].as_str().unwrap();
    let main = first.generation();
    assert_eq!(main.request.view.run_id, initial_run);
    assert!(main
        .request
        .serialized
        .to_string()
        .contains("ORIGINAL BUDGET USER PROFILE"));
    main.finish
        .send("FIRST ANSWER retained evidence".into())
        .unwrap();
    first.completed(initial_run);
    let before = first
        .fixture
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .capture_active_checkpoint("branch:budget")
        .unwrap()
        .unwrap()
        .id
        .clone();
    first.fixture.host.send(json!({"kind":"fixture-invalid"}));
    let invalid = first.receive("fixture-invalid-submitted");
    let invalid_run = invalid["receipt"]["run_id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(
            first.generations.try_recv().is_err(),
            "Disabled background preparation dispatched paid model work"
        );
        let state = first
            .fixture
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .run(invalid_run)
            .unwrap()
            .state;
        if state.terminal() {
            assert_eq!(state, varin_runtime::RunState::Failed);
            break;
        }
        assert!(Instant::now() < deadline, "Invalid Decision did not fail");
        if let Some(frame) = first.pump() {
            panic!("Unexpected invalid Decision frame: {frame}");
        }
    }
    {
        let owner = first.fixture.runtime.catalog();
        let db = owner.lock().unwrap();
        assert!(db.capture_context_jobs("branch:budget").unwrap().is_empty());
        assert_eq!(
            db.capture_active_checkpoint("branch:budget")
                .unwrap()
                .unwrap()
                .id,
            before
        );
    }
    first.fixture.host.send(json!({"kind":"fixture-second"}));
    let second = first.receive("fixture-second-submitted");
    let parent = second["receipt"]["run_id"].as_str().unwrap().to_owned();
    let summary = first.generation();
    let summary_id = summary.request.view.run_id.clone();
    let summary_request_id = summary.request.view.request_id.clone();
    let summary_input_tokens = varin_runtime::context_capacity::estimate_request(
        &summary.request.view,
        &summary.request.serialized,
    )
    .estimated_tokens;
    assert_ne!(summary_id, parent);
    let wire = summary.request.serialized.to_string();
    assert!(
        wire.contains("Preserve source references, concrete outcomes"),
        "{wire}"
    );
    assert!(wire.contains("ORIGINAL_EVIDENCE"));
    assert!(summary.request.view.binding.tools.is_empty());
    first.fixture.host.send(json!({"kind":"fixture-tail"}));
    first.receive("fixture-tail-added");
    summary
        .finish
        .send("FROZEN EVIDENCE SUMMARY from the original source".into())
        .unwrap();
    let held = first.receive("fixture-publication-held");
    assert_eq!(held["observations"].as_array().unwrap().len(), 1);
    let original_recipe = held["job"]["request"]["summary_recipe"].clone();
    assert_eq!(original_recipe["strategy"]["kind"], "extension");
    assert_eq!(
        first
            .fixture
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .run(&summary_id)
            .unwrap()
            .state,
        varin_runtime::RunState::Completed
    );
    drop(first);
    let mut recovered = Review::open(&root);
    recovered.initialize(&root, true);
    recovered.receive("fixture-recovered");
    let continuation = recovered.generation();
    assert_eq!(continuation.request.view.run_id, parent);
    let wire = continuation.request.serialized.to_string();
    assert!(wire.contains("FROZEN EVIDENCE SUMMARY"), "{wire}");
    assert!(
        wire.contains("NEW_TAIL N") && wire.contains("SECOND USER QUESTION"),
        "{wire}"
    );
    assert!(
        wire.contains("ORIGINAL BUDGET USER PROFILE") && !wire.contains("recorded source fact."),
        "{wire}"
    );
    continuation.finish.send("FINAL ANSWER".into()).unwrap();
    recovered.completed(&parent);
    recovered
        .fixture
        .host
        .send(json!({"kind":"fixture-finish"}));
    let final_state = recovered.receive("fixture-finished");
    let decisions = final_state["observations"].as_array().unwrap();
    assert_eq!(decisions.len(), 2, "Recompiled request checks its current decision before and after publication");
    assert_eq!(decisions[0]["input"]["acceptedCandidate"]["throughId"], held["job"]["request"]["through_id"]);
    assert_eq!(decisions[0]["value"]["decision"]["mode"], "blocking");
    assert_eq!(decisions[1]["value"]["decision"]["kind"], "continue");
    assert_eq!(final_state["jobs"].as_array().unwrap().len(), 1);
    assert_eq!(
        final_state["jobs"][0]["request"]["summary_recipe"],
        original_recipe
    );
    assert!(
        recovered.generations.try_recv().is_err(),
        "No second paid summary"
    );
    drop(recovered);
    let catalog = Catalog::open(root.join("catalog")).unwrap();
    let summary_step = catalog.model_step(&summary_request_id).unwrap();
    assert_eq!(
        summary_step.usage.as_ref().unwrap()["measurement"],
        "actual"
    );
    assert_eq!(
        summary_step.usage.as_ref().unwrap()["input_tokens"],
        summary_input_tokens
    );
    assert_eq!(
        summary_step.usage.as_ref().unwrap()["raw"],
        json!({"controlled":true})
    );

    assert_eq!(
        catalog.run(&summary_id).unwrap().state,
        varin_runtime::RunState::Completed
    );
    assert!(
        serde_json::to_string(&catalog.execution_history("branch:budget").unwrap())
            .unwrap()
            .contains("NEW_TAIL N")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires original Host packages; actual child admission and budget scope, no model or listener"]
fn real_child_admission_selects_its_own_budget_scope_without_promoting_parent_selection() {
    let schemas = crate::child_capabilities::schemas();
    let mut parent = dispatch_fixture::Fixture::new_parent_custom(
        0,
        schemas.iter().find(|s| s.name == "memory").unwrap().clone(),
        schemas
            .iter()
            .find(|s| s.name == "dispatch")
            .unwrap()
            .clone(),
        false,
        false,
        false,
        |input, launch| {
            input.task = "Choose the child's own context policy".into();
            input.tools = Some(vec!["memory".into()]);
            launch.source = None;
        },
    );
    let selected = parent
        .db
        .capture_child_dispatch_invocation(&parent.context)
        .unwrap()
        .load()
        .unwrap()
        .resolve(&parent.input)
        .unwrap();
    let launch = parent
        .db
        .prepare_child_launch(&parent.context.run_id, parent.launch.clone(), selected)
        .unwrap()
        .load()
        .unwrap();
    let prepared = parent
        .db
        .prepare_child_admission(&parent.context, parent.input.clone(), None, launch)
        .unwrap()
        .load()
        .unwrap();
    let child = parent.db.accept_child_references(prepared).unwrap();
    let execution_id = child.execution_id.clone();
    let child = parent.db.capture_child_read(child).load().unwrap();
    let root = parent.root;
    parent
        .db
        .create_thread("thread:budget", "branch:budget")
        .unwrap();
    let mut review = Review::with_catalog(&root, parent.db);
    review.fixture.host.send(json!({"kind":"fixture-initialize","root":root,"storageRoot":review.fixture.storage_root,"epoch":EPOCH,
        "threadId":"thread:budget","branchId":"branch:budget","child":child,"executionId":execution_id,"configuration":null}));
    let checked = review.receive("fixture-child-verified");
    assert_eq!(checked["selected"]["external"], true);
    assert_eq!(checked["parent"]["external"], false);
    assert!(review.generations.try_recv().is_err());
    drop(review);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires built original Host packages; stdio and Node broker IPC only"]
fn original_usage_reaches_selected_budget_without_unrequested_summary() {
    for with_goal in [false, true] {
        calibrated_scenario(with_goal);
    }
}
fn calibrated_scenario(with_goal: bool) {
    use varin_runtime::context_capacity::estimate_request;
    let root =
        std::env::temp_dir().join(format!("varin-calibrated-budget-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut review = Review::open(&root);
    review.actual_input_tokens = Some(10);
    review.with_goal = with_goal;
    review.initialize(&root, false);
    let first = review.receive("fixture-submitted");
    let initial = review.generation();
    // The actual assembled request must also satisfy GenerateContent's system-prefix contract.
    // Only serialize: the lazy transport and credential resolver are never dispatched.
    let google = varin_runtime::providers::google::GoogleProvider::new(
        varin_runtime::providers::Connection::new(
            "https://controlled.invalid/models/model:streamGenerateContent",
            Arc::new(varin_runtime::providers::EnvironmentCredentialResolver::default()),
            varin_runtime::providers::shared_transport(),
        ),
    )
    .unwrap();
    let mut google_view = initial.request.view.clone();
    google_view.binding.provider_family = varin_runtime::providers::google::FAMILY.into();
    let google_request = google.serialize(&google_view).unwrap();
    assert!(
        google_request["systemInstruction"]["parts"]
            .as_array()
            .unwrap()
            .len()
            >= 2
    );
    if with_goal {
        assert_eq!(google_request["contents"][0]["role"], "user");
        let goal = initial
            .request
            .view
            .history
            .iter()
            .position(|item| matches!(item.provenance, Provenance::GoalInstruction { .. }))
            .unwrap();
        let user = initial
            .request
            .view
            .history
            .iter()
            .position(|item| matches!(item.provenance, Provenance::UserInstruction { .. }))
            .unwrap();
        assert!(goal < user);
        assert!(!initial.request.view.history[goal].provenance.is_system());
        assert_eq!(initial.request.serialized["input"][goal]["role"], "user");
    }
    let old_estimate =
        estimate_request(&initial.request.view, &initial.request.serialized).estimated_tokens;
    assert!(
        old_estimate > 4384,
        "Local bytes alone would require a summary at the next budget"
    );
    initial
        .finish
        .send("ACTUAL SUCCESS retained output".into())
        .unwrap();
    review.completed(first["receipt"]["run_id"].as_str().unwrap());
    review
        .fixture
        .host
        .send(json!({"kind":"fixture-calibrated"}));
    let admitted = review.receive("fixture-calibrated-submitted");
    let next = review.generation();
    assert_eq!(next.request.view.run_id, admitted["receipt"]["run_id"].as_str().unwrap(),
        "The selected Decision must consume the calibrated input instead of starting an extra summary");
    assert!(next
        .request
        .view
        .history
        .starts_with(&initial.request.view.history));
    let expected = 10
        + estimate_request(&next.request.view, &next.request.serialized).estimated_tokens
        - old_estimate;
    next.finish.send("NEXT SUCCESS".into()).unwrap();
    review.completed(admitted["receipt"]["run_id"].as_str().unwrap());
    review.fixture.host.send(json!({"kind":"fixture-finish"}));
    let finished = review.receive("fixture-finished");
    assert_eq!(finished["jobs"], json!([]));
    let observations = finished["observations"].as_array().unwrap();
    assert_eq!(observations.len(), 1);
    assert_eq!(
        observations[0]["input"]["estimate"]["estimatedTokens"],
        expected
    );
    assert!(observations[0]["input"]["estimate"]["method"]
        .as_str()
        .unwrap()
        .starts_with("actual-input-calibrated"));
    assert!(review.generations.try_recv().is_err());
    drop(review);
    std::fs::remove_dir_all(root).unwrap();
}
