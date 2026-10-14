//! Actual public source admission, resources, RunAssembly and Storage/Catalog reopen.
//! Test stdio replaces transport. Only the prepared Run's model provider is controlled.
use super::web_domain_review::{Fixture, Host, EPOCH, GENERATION, HOST};
use super::*;
use crate::run_assembly::{PreparedLaunch, RunAssembly, RunPreparation};
use crate::storage::Storage;
use crate::tools::{
    finish_resource_blob_read, prepare_resource, KernelResourceClient, ResourceCall, ResourceWork,
};
use std::path::Path;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;

struct ControlledModel {
    wires: Arc<Mutex<Vec<Value>>>,
}
impl ModelProvider for ControlledModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        use varin_runtime::providers::{
            Connection, EnvironmentCredentialResolver, ReqwestTransport,
        };
        let provider =
            varin_runtime::providers::responses::ResponsesProvider::new(Connection::new(
                "https://controlled.invalid/responses",
                Arc::new(EnvironmentCredentialResolver::default()),
                Arc::new(ReqwestTransport::default()),
            ));
        let wire = provider.serialize(view)?;
        self.wires
            .lock()
            .unwrap()
            .push(json!({"runId":view.run_id,"wire":wire}));
        Ok(wire)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let id = format!("read:{}", request.view.run_id);
        if request.view.history.iter().any(
            |item| matches!(&item.content, Content::ToolResult { result } if result.call_id == id),
        ) {
            return Ok(FinishReason::Stop);
        }
        let tool = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == "file_read")
            .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: id.clone(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: id,
                        name: tool.name.clone(),
                        schema_version: tool.version.clone(),
                        arguments: json!({"path":"source.txt"}),
                    },
                },
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
struct Review {
    fixture: Fixture,
    assembly: RunAssembly,
    resources: mpsc::Receiver<ResourceCall>,
    wires: Arc<Mutex<Vec<Value>>>,
    runs: Vec<String>,
    pause_start: bool,
    materializations: usize,
}
impl Review {
    fn open(root: &Path) -> Self {
        let runtime = Arc::new(RunSupervisor::new(
            Catalog::open(root.join("catalog")).unwrap(),
        ));
        let (output, outgoing) = mpsc::sync_channel(256);
        let bridge = crate::host_tools::ToolBridge::new(output.clone().into());
        bridge.initialize(EPOCH);
        let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
        credentials.initialize(EPOCH).unwrap();
        let (send, resources) = mpsc::channel();
        let client = KernelResourceClient::new(
            move |call| {
                send.send(call)
                    .map_err(|_| KernelError::Operation("source reader closed".into()))
            },
            |_| Ok(()),
            Default::default(),
        );
        let assembly = RunAssembly {
            runtime: runtime.clone(),
            resources: client,
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
                "packages/web/application-host/lib/kernel/source-lifecycle-host.test-helper.ts",
            ),
            runtime,
            storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
            storage_root,
            bridge,
            outgoing,
        };
        Self {
            fixture,
            assembly,
            resources,
            wires: Arc::new(Mutex::new(vec![])),
            runs: vec![],
            pause_start: false,
            materializations: 0,
        }
    }
    fn initialize(&mut self, root: &Path, mode: &str, reopen: bool) {
        self.fixture.host.send(json!({"kind":"fixture-initialize","root":root,"storageRoot":self.fixture.storage_root,"epoch":EPOCH,"sourceMode":mode,"reopen":reopen}));
        self.receive("fixture-ready");
    }
    fn pump(&mut self) -> Option<Value> {
        self.fixture.runtime.reap().unwrap();
        while let Ok(call) = self.resources.try_recv() {
            let work = prepare_resource(
                &mut self.fixture.storage.lock().unwrap(),
                EPOCH,
                HOST,
                GENERATION,
                &call,
            );
            let result = match work {
                Ok(ResourceWork::Ready(value)) => Ok(value),
                Ok(ResourceWork::BlobRead(task)) => {
                    let body = task.run();
                    finish_resource_blob_read(
                        &mut self.fixture.storage.lock().unwrap(),
                        EPOCH,
                        HOST,
                        GENERATION,
                        &call,
                        &task,
                        body,
                    )
                }
                Err(error) => Err(error),
            };
            call.reply.send(result).unwrap();
        }
        let assembly = self.assembly.clone();
        let wires = self.wires.clone();
        let mut started = None;
        let mut failure = None;
        let mut captured = None;
        let mut paused = None;
        let pause_start = self.pause_start;
        let mut materializations = 0;
        let frame = self.fixture.pump_dispatch(
            |frame| {
                let method = frame["method"].as_str().unwrap();
                if method == "file.materialize" {
                    materializations += 1;
                }
                if method == "runtime.run.start" && pause_start {
                    paused = Some(frame.clone());
                    return Some(Ok(Value::Null));
                }
                if method == "file.captureBatch" {
                    captured = Some(frame.clone());
                    return Some(Ok(Value::Null));
                }
                if !method.starts_with("runtime.") || method == "runtime.operation.inspect" {
                    return None;
                }
                let params = frame["params"].clone();
                Some((|| {
                    validate_method_params(method, &params)?;
                    let runtime = assembly.runtime.clone();
                    let owner = runtime.catalog();
                    if method == "runtime.thread.create" || method.starts_with("runtime.input.") {
                        return input_commands::execute(
                            runtime,
                            method,
                            params,
                            Arc::new(AtomicBool::new(false)),
                            None,
                        );
                    }
                    if method.starts_with("runtime.child.") {
                        return child_commands::execute(
                            runtime,
                            assembly.resources.clone(),
                            method,
                            params,
                            &AtomicBool::new(false),
                        );
                    }
                    if method.starts_with("runtime.host_job.") {
                        return host_job_commands::execute(
                            runtime,
                            method,
                            params,
                            &AtomicBool::new(false),
                        );
                    }
                    match method {
                        "runtime.source.tools" => {
                            let p: crate::protocol_generated::SourceToolsParams =
                                serde_json::from_value(params)?;
                            let tools = crate::tools::KernelToolExecutor::selected_schemas(
                                &crate::tools::ToolKind::all().collect(),
                            )
                            .into_iter()
                            .filter(|schema| {
                                schema
                                    .requirements
                                    .as_ref()
                                    .is_some_and(|required| required.accepts_mode(p.mode))
                            })
                            .map(|schema| schema.name)
                            .collect::<Vec<_>>();
                            Ok(json!(tools))
                        }
                        "runtime.context.inspect" => {
                            let p: HistoryParams = serde_json::from_value(params)?;
                            let read = owner
                                .lock()
                                .unwrap()
                                .capture_active_checkpoint(&p.branch_id)
                                .map_err(domain)?;
                            Ok(serde_json::to_value(
                                read.map(|read| read.load()).transpose().map_err(domain)?,
                            )?)
                        }
                        "runtime.context.refresh" => {
                            let p: ContextRefreshParams = serde_json::from_value(params)?;
                            let basis =
                                personalization_basis(p.context.personalization.ok_or_else(
                                    || KernelError::Protocol("missing personalization".into()),
                                )?)?;
                            let prepare = owner
                                .lock()
                                .unwrap()
                                .prepare_personalization_refresh(
                                    &p.branch_id,
                                    p.expected_revision.try_into().unwrap(),
                                    p.context.effective_system_prompt,
                                    p.context.instruction_sources,
                                    p.context.memory_checkpoint.0,
                                    basis,
                                )
                                .map_err(domain)?
                                .require_resources(p.context.resources);
                            let prepared = prepare.load().map_err(domain)?;
                            Ok(serde_json::to_value(
                                owner
                                    .lock()
                                    .unwrap()
                                    .publish_personalization_refresh(prepared)
                                    .map_err(domain)?,
                            )?)
                        }
                        "runtime.launch.inspect" => {
                            let p: RunParams = serde_json::from_value(params)?;
                            let read = owner
                                .lock()
                                .unwrap()
                                .capture_launch(&p.run_id)
                                .map_err(domain)?;
                            let mut launch =
                                read.map(|read| read.load()).transpose().map_err(domain)?;
                            if let Some(launch) = &mut launch {
                                launch.startable &= runtime
                                    .start_available(&p.run_id)
                                    .map_err(|error| KernelError::Operation(error.to_string()))?;
                            }
                            Ok(serde_json::to_value(launch)?)
                        }
                        "runtime.launch.fail" => {
                            let p: LaunchFailedParams = serde_json::from_value(params)?;
                            owner
                                .lock()
                                .unwrap()
                                .fail_launch_metadata(&p.run_id, &p.code)
                                .map_err(domain)?;
                            let read = owner
                                .lock()
                                .unwrap()
                                .capture_launch(&p.run_id)
                                .map_err(domain)?;
                            Ok(serde_json::to_value(
                                read.map(|read| read.load()).transpose().map_err(domain)?,
                            )?)
                        }
                        "runtime.model.inspect" => {
                            let p: RunParams = serde_json::from_value(params)?;
                            Ok(serde_json::to_value(assembly.models.inspect(&p.run_id)?)?)
                        }
                        "runtime.plan.reconcile" | "runtime.memory.reconcile" => {
                            let p: RunParams = serde_json::from_value(params)?;
                            let (send, receive) = mpsc::sync_channel(8);
                            if method == "runtime.plan.reconcile" {
                                crate::plan::reconcile(
                                    runtime,
                                    assembly.plan.clone(),
                                    p.run_id,
                                    "reconcile".into(),
                                    send.into(),
                                    Arc::new(|_| {}),
                                )?;
                            } else {
                                crate::memory::reconcile(
                                    runtime,
                                    assembly.memory.clone(),
                                    p.run_id,
                                    "reconcile".into(),
                                    send.into(),
                                    Arc::new(|_| {}),
                                )?;
                            }
                            let result = receive.recv_timeout(Duration::from_secs(5)).unwrap();
                            assert_eq!(result["ok"], true, "{result}");
                            Ok(result["result"].clone())
                        }
                        "runtime.run.reconcile" => {
                            let p: RunReconcileParams = serde_json::from_value(params)?;
                            let binding: crate::tools::ToolBinding =
                                serde_json::from_value(p.tool_binding)?;
                            let db = owner.lock().unwrap();
                            let run = db.run(&p.run_id).map_err(domain)?;
                            if binding.run_id != run.id
                                || binding.thread_id != run.thread_id
                                || db
                                    .launch_metadata(&run.id)
                                    .map_err(domain)?
                                    .unwrap()
                                    .selection
                                    .source
                                    .as_ref()
                                    != Some(&binding.source_selection()?)
                            {
                                return Err(KernelError::Authorization(
                                    "source reconciliation identity changed".into(),
                                ));
                            }
                            assert!(
                                db.pending_run_operations(&run.id)
                                    .map_err(domain)?
                                    .is_empty(),
                                "fixture must not simplify nonempty recovery"
                            );
                            Ok(json!({"reconciled":[],"unresolved":[]}))
                        }
                        "runtime.run.start" => {
                            let p: RunStartParams = serde_json::from_value(params)?;
                            let run = owner.lock().unwrap().run(&p.run_id).map_err(domain)?;
                            let prepared = RunPreparation::new(p, &run)?;
                            let PreparedLaunch::Start(mut start) =
                                assembly.prepare(prepared, None, || false)?
                            else {
                                panic!("execution expected");
                            };
                            // Preserve the actual assembled source tools, policy and context preparation.
                            start.provider = Arc::new(ControlledModel {
                                wires: wires.clone(),
                            });
                            let handle = runtime
                                .start(&run.id, start)
                                .map_err(|error| KernelError::Operation(error.to_string()))?;
                            let result = json!({"runId":handle.run_id,"epoch":handle.epoch});
                            started = Some(run.id);
                            assembly.observe_completion(handle);
                            Ok(result)
                        }
                        _ => dispatch(&mut owner.lock().unwrap(), method, params),
                    }
                })())
            },
            |frame, result| {
                if frame["method"] == "file.captureBatch"
                    || (frame["method"] == "runtime.run.start" && pause_start)
                {
                    return false;
                }
                // Preserve the original typed Kernel error projection across the test transport.
                if let Err(error) = result {
                    failure = Some(crate::error::response_error(
                        frame["id"].as_str().unwrap(),
                        error,
                    ));
                    false
                } else {
                    true
                }
            },
        );
        self.materializations += materializations;
        if let Some(call) = paused {
            return Some(json!({"kind":"fixture-start-paused","runId":call["params"]["runId"]}));
        }
        if let Some(call) = captured {
            let result = (|| -> Result<Value, KernelError> {
                let params = call["params"].clone();
                validate_method_params("file.captureBatch", &params)?;
                let grant_id = call["grantId"].as_str();
                let mut task = {
                    let mut storage = self.fixture.storage.lock().unwrap();
                    let (grant, authorized) = storage.authorize(
                        grant_id,
                        EPOCH,
                        HOST,
                        GENERATION,
                        "file.captureBatch",
                        &params,
                    )?;
                    storage.prepare_capture(
                        "file.captureBatch",
                        &authorized,
                        &grant,
                        Arc::new(AtomicBool::new(false)),
                    )?
                };
                let body = (|| {
                    if !task.store() { return task.run(); }
                    let hashed = task.hash_sources()?;
                    {
                        let mut storage = self.fixture.storage.lock().unwrap();
                        let (grant, _) = storage.authorize(grant_id, EPOCH, HOST, GENERATION, "file.captureBatch", &params)?;
                        storage.retain_capture_objects(&mut task, &hashed, &grant)?;
                    }
                    task.finish_sources(hashed)
                })();
                let mut storage = self.fixture.storage.lock().unwrap();
                let result = (|| {
                    let (grant, _) = storage.authorize(
                        grant_id,
                        EPOCH,
                        HOST,
                        GENERATION,
                        "file.captureBatch",
                        &params,
                    )?;
                    storage.publish_capture(&task, body?, &grant)
                })();
                storage.finish_retained_file_lease(task.lease_id());
                result
            })();
            self.fixture.host.send(match result {
                Ok(value) => {
                    json!({"kind":"fixture-response","id":call["id"],"ok":true,"result":value})
                }
                Err(error) => crate::error::response_error(call["id"].as_str().unwrap(), &error),
            });
            return None;
        }
        if let Some(run) = started {
            self.runs.push(run);
        }
        if let Some(error) = failure {
            self.fixture.host.send(error);
            return None;
        }
        match frame {
            Some(frame) if frame["kind"] == "memory-response" => {
                self.assembly.memory.receive(frame);
                None
            }
            Some(frame) if frame["kind"] == "plan-response" => {
                self.assembly.plan.receive(frame);
                None
            }
            Some(frame) if frame["kind"] == "context-response" => {
                self.assembly.context.receive(frame);
                None
            }
            Some(frame) if frame["kind"] == "credential-response" => {
                self.assembly.credentials.receive(frame);
                None
            }
            value => value,
        }
    }
    fn receive(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            assert!(
                Instant::now() < deadline,
                "source lifecycle stalled at {kind}"
            );
            if let Some(frame) = self.pump() {
                assert_eq!(frame["kind"], kind, "{frame}");
                return frame;
            }
        }
    }
    fn assert_run(&self, run: &str, expected: &str) {
        let owner = self.fixture.runtime.catalog();
        let db = owner.lock().unwrap();
        assert_eq!(
            db.run(run).unwrap().state,
            varin_runtime::RunState::Completed
        );
        let history = db
            .execution_history(&db.run(run).unwrap().branch_id)
            .unwrap();
        let id = format!("read:{run}");
        let result = history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == id => {
                    Some(serde_json::to_value(result).unwrap())
                }
                _ => None,
            })
            .unwrap();
        assert!(result.to_string().contains(expected), "{result}");
        assert!(!result.to_string().contains("WRONG_"), "{result}");
        let wires = self.wires.lock().unwrap();
        assert!(wires.iter().any(|wire| wire["runId"] == run
            && wire.to_string().contains("ORIGINAL_SOURCE_INSTRUCTIONS")));
        assert!(!wires
            .iter()
            .any(|wire| wire.to_string().contains("WRONG_LIVE_INSTRUCTIONS")));
    }
}
#[test]
#[ignore = "requires built Host packages; no listener, original source owners and controlled model"]
fn public_fixed_and_materialized_sources_survive_old_root_loss_and_real_storage_reopen() {
    for mode in ["fixed_branch", "materialized"] {
        let root =
            std::env::temp_dir().join(format!("varin-source-lifecycle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut first = Review::open(&root);
        first.initialize(&root, mode, false);
        first.fixture.host.send(json!({"kind":"fixture-first"}));
        let first_done = first.receive("fixture-first-done");
        let run = first_done["firstRun"].as_str().unwrap();
        first.assert_run(run, "ORIGINAL_SOURCE_BYTES");
        assert_eq!(
            first.runs.len(),
            1,
            "rejected public requests must not start a Run"
        );
        first.pause_start = true;
        first.fixture.host.send(json!({"kind":"fixture-pending"}));
        let mut pending = None;
        let mut paused = None;
        let deadline = Instant::now() + Duration::from_secs(90);
        while pending.is_none() || paused.is_none() {
            assert!(Instant::now() < deadline, "pending Run admission stalled");
            if let Some(frame) = first.pump() {
                match frame["kind"].as_str().unwrap() {
                    "fixture-pending-admitted" => pending = Some(frame),
                    "fixture-start-paused" => paused = Some(frame),
                    _ => panic!("{frame}"),
                }
            }
        }
        let pending = pending.unwrap();
        assert_eq!(paused.unwrap()["runId"], pending["pendingRun"]);
        let pending_run = pending["pendingRun"].as_str().unwrap().to_owned();
        let branch_id = first_done["identity"]["branchId"]
            .as_str()
            .unwrap()
            .to_owned();
        let pending_input = first
            .fixture
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .head(&branch_id)
            .unwrap()
            .unwrap();
        let original_grants = pending["grants"].as_array().unwrap().clone();
        drop(first); // Close both native owners, not just the Host process or Catalog.
        let mut reopened = Review::open(&root);
        reopened.initialize(&root, mode, true);
        reopened.fixture.host.send(json!({"kind":"fixture-second"}));
        let second = reopened.receive("fixture-second-done");
        assert_eq!(second["pendingRun"], pending_run);
        assert_eq!(
            reopened
                .fixture
                .runtime
                .catalog()
                .lock()
                .unwrap()
                .execution_history(&branch_id)
                .unwrap()
                .iter()
                .filter(|item| item.id == pending_input)
                .count(),
            1,
            "original input is retained once"
        );
        reopened.assert_run(
            &pending_run,
            if mode == "materialized" {
                "PRESERVED_MANAGED_COPY"
            } else {
                "ORIGINAL_SOURCE_BYTES"
            },
        );
        reopened.assert_run(
            second["secondRun"].as_str().unwrap(),
            if mode == "materialized" {
                "PRESERVED_MANAGED_COPY"
            } else {
                "ORIGINAL_SOURCE_BYTES"
            },
        );
        assert!(
            second["grants"]
                .as_array()
                .unwrap()
                .iter()
                .all(|grant| !original_grants.contains(grant)),
            "new Host must acquire fresh grants"
        );
        assert_eq!(reopened.runs.len(), 2);
        if mode == "materialized" {
            reopened.pause_start = true;
            reopened
                .fixture
                .host
                .send(json!({"kind":"fixture-pending","key":"pending-missing-copy"}));
            let mut admitted = false;
            let mut paused = false;
            let deadline = Instant::now() + Duration::from_secs(90);
            while !admitted || !paused {
                assert!(
                    Instant::now() < deadline,
                    "missing-copy pending admission stalled"
                );
                if let Some(frame) = reopened.pump() {
                    match frame["kind"].as_str().unwrap() {
                        "fixture-pending-admitted" => admitted = true,
                        "fixture-start-paused" => paused = true,
                        _ => panic!("{frame}"),
                    }
                }
            }
            reopened
                .fixture
                .host
                .send(json!({"kind":"fixture-hide-copy"}));
            reopened.receive("fixture-copy-hidden");
            drop(reopened);
            let mut missing = Review::open(&root);
            missing.initialize(&root, mode, true);
            missing
                .fixture
                .host
                .send(json!({"kind":"fixture-retry-missing"}));
            missing.receive("fixture-missing-done");
            assert!(missing.runs.is_empty());
            assert_eq!(
                missing.materializations, 0,
                "recovery must not create a replacement copy"
            );
            drop(missing);
        } else {
            drop(reopened);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
