//! Original Web tools, Host domain owners and native Storage over a test-only stdio rendezvous.
//! Outbound bytes are controlled; this does not replace or exercise the product socket transport.
use super::*;
use crate::host_tools::{LateReceipt, ToolBridge};
use crate::storage::Storage;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};

pub(super) const EPOCH: &str = "web-domain-review";
pub(super) const HOST: &str = "web-domain-host";
pub(super) const GENERATION: &str = "web-domain-generation";
const THREAD: &str = "thread:web";
const BRANCH: &str = "branch:web";

pub(super) struct Host {
    child: Child,
    input: ChildStdin,
    frames: mpsc::Receiver<Value>,
}
impl Host {
    fn new() -> Self {
        Self::with_script("packages/web/application-host/lib/kernel/web-domain-host.test-helper.ts")
    }
    pub(super) fn with_script(script: &str) -> Self {
        let mut child =
            Command::new(std::env::var_os("VARIN_NODE").unwrap_or_else(|| "node".into()))
                .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
                .args(["--import", "tsx", script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, frames) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let value = serde_json::from_str(&line)
                    .unwrap_or_else(|_| panic!("invalid Web Host frame: {line}"));
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            frames,
        }
    }
    pub(super) fn send(&mut self, value: Value) {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(super) struct Fixture {
    pub(super) host: Host,
    pub(super) runtime: Arc<RunSupervisor>,
    pub(super) storage: Mutex<Storage>,
    pub(super) storage_root: PathBuf,
    pub(super) bridge: ToolBridge,
    pub(super) outgoing: mpsc::Receiver<Value>,
}
impl Fixture {
    fn rpc(&self, frame: &Value) -> Result<Value, KernelError> {
        let method = frame["method"].as_str().unwrap();
        let params = frame["params"].clone();
        validate_method_params(method, &params)?;
        let owner = self.runtime.catalog();
        if method.starts_with("runtime.family.") {
            let command = FamilyCommand::capture(&owner.lock().unwrap(), method, params)?;
            return command.load(&|| false);
        }
        if method.starts_with("runtime.inference.") {
            return inference_commands::execute(self.runtime.clone(),method,params,&AtomicBool::new(false));
        }
        match method {
            "runtime.operation.status" => {
                let p: OperationParams=serde_json::from_value(params)?;
                Ok(operation_cancellation_receipt(&owner.lock().unwrap().operation(&p.operation_id).map_err(domain)?))
            }
            "runtime.operation.cancel" | "runtime.run.cancel" => {
                let (sender,_)=mpsc::sync_channel(16);
                let controls=control_commands::ControlCommands {
                    runtime:self.runtime.clone(),
                    resources:crate::tools::KernelResourceClient::new(|_|Err(KernelError::Operation("unrequested resource effect".into())), |_|Ok(()),Default::default()),
                    models:crate::run_models::RunModels::new(owner.clone(),crate::credential_bridge::CredentialBridge::new(sender)),
                    tools:crate::run_tools::RunTools::new(owner.clone(),self.bridge.clone()),
                };
                if let Some(value)=controls.admit_control(method,&params)? { return Ok(value); }
                controls.execute(method,params,&AtomicBool::new(false))
            }
            "runtime.thread.list"
            | "runtime.thread.inspect"
            | "runtime.run.inspect"
            | "runtime.run.scope" => dispatch(&mut owner.lock().unwrap(), method, params),
            "runtime.launch.inspect" => {
                let read = owner
                    .lock()
                    .unwrap()
                    .capture_launch(params["runId"].as_str().unwrap())
                    .map_err(domain)?;
                Ok(serde_json::to_value(
                    read.map(|r| r.load()).transpose().map_err(domain)?,
                )?)
            }
            "runtime.research.scopes" => host_job_commands::execute(
                self.runtime.clone(),
                method,
                params,
                &AtomicBool::new(false),
            ),
            "runtime.operation.inspect"
            | "runtime.thread.operations.active"
            | "runtime.permission.open"
            | "runtime.permission.consume"
            | "runtime.permission.decide" => operation_commands::execute(
                self.runtime.clone(),
                method,
                params,
                &AtomicBool::new(false),
            ),
            "authority.grant.issue" => self.storage.lock().unwrap().issue_grant(
                &params,
                HOST,
                GENERATION,
                &self.storage_root.to_string_lossy(),
                EPOCH,
            ),
            "authority.grant.revoke" => self.storage.lock().unwrap().revoke_grant(&params, HOST),
            "authority.grant.retire" => self.storage.lock().unwrap().retire_grants(&params, HOST),
            _ => {
                let grant_id = frame["grantId"].as_str();
                let mut storage = self.storage.lock().unwrap();
                let (grant, params) =
                    storage.authorize(grant_id, EPOCH, HOST, GENERATION, method, &params)?;
                if method == "file.materialize" || method == "file.materializedView.prepare" {
                    use crate::storage::materialization::Admission;
                    let admission = if method == "file.materializedView.prepare" {
                        storage.prepare_materialized_view(&params, &grant, Arc::new(AtomicBool::new(false)))?
                    } else {
                        storage.prepare_materialization(&params, &grant, Arc::new(AtomicBool::new(false)))?
                    };
                    drop(storage);
                    let result = match admission {
                        Admission::Complete(value) => Ok(value),
                        Admission::Work(task) => {
                            let result = task.run(|control| {
                                self.storage.lock().unwrap().control_materialization(
                                    &task.operation_id,
                                    &task.job_id,
                                    control,
                                    false,
                                )
                            });
                            self.storage
                                .lock()
                                .unwrap()
                                .finish_materialization(&task.operation_id, &task.job_id);
                            result
                        }
                    }?;
                    return if method == "file.materializedView.prepare" {
                        self.storage.lock().unwrap().finish_materialized_view(&params, &grant, result)
                    } else { Ok(result) };
                }
                if method == "file.materializedView.release" {
                    let task = storage.prepare_materialized_view_release(&params, &grant)?;
                    drop(storage);
                    return match task {
                        Some(task) => {
                            let result = task.run();
                            self.storage.lock().unwrap().finish_materialized_view_release(&task, result)
                        }
                        None => Ok(json!({"released":true})),
                    };
                }
                if method == "file.capture" {
                    let task = storage.prepare_capture(
                        method,
                        &params,
                        &grant,
                        Arc::new(AtomicBool::new(false)),
                    )?;
                    drop(storage);
                    let body = task.run();
                    let mut storage = self.storage.lock().unwrap();
                    let result = (|| {
                        let (grant, _) = storage
                            .authorize(grant_id, EPOCH, HOST, GENERATION, method, &params)?;
                        storage.publish_capture(&task, body?, &grant)
                    })();
                    storage.finish_retained_file_lease(task.lease_id());
                    return result;
                }
                if method == "storage.getBlob" {
                    let task = storage.prepare_blob_read(
                        &params,
                        &grant,
                        Arc::new(AtomicBool::new(false)),
                    )?;
                    drop(storage);
                    let body = task.run();
                    return self
                        .storage
                        .lock()
                        .unwrap()
                        .finish_blob_read(&task, body, &grant);
                }
                storage.dispatch(method, &params, grant_id, &grant)
            }
        }
    }
    pub(super) fn pump(&mut self) -> Option<Value> {
        self.pump_reply(|_, _| true)
    }
    /// Drop a selected delivery only after the original authority returned its result.
    pub(super) fn pump_reply(
        &mut self,
        deliver: impl FnMut(&Value, &Result<Value, KernelError>) -> bool,
    ) -> Option<Value> {
        self.pump_request(|_|None,deliver)
    }
    /// A finite original boundary error, distinct from a successful commit with a lost ACK.
    pub(super) fn pump_request(
        &mut self,
        mut reject: impl FnMut(&Value) -> Option<KernelError>,
        deliver: impl FnMut(&Value, &Result<Value, KernelError>) -> bool,
    ) -> Option<Value> {
        self.pump_dispatch(|frame| reject(frame).map(Err), deliver)
    }
    /// An additional original production handler, without replacing Storage or Catalog routes.
    pub(super) fn pump_dispatch(
        &mut self,
        mut dispatch: impl FnMut(&Value) -> Option<Result<Value, KernelError>>,
        mut deliver: impl FnMut(&Value, &Result<Value, KernelError>) -> bool,
    ) -> Option<Value> {
        while let Ok(frame) = self.outgoing.try_recv() {
            self.host.send(frame);
        }
        let frame = match self.host.frames.recv_timeout(Duration::from_millis(5)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => return None,
            Err(error) => panic!("Web Host exited: {error}"),
        };
        match frame["kind"].as_str().unwrap() {
            "fixture-request" => {
                let before = self.runtime.catalog().lock().unwrap().event_cursor().unwrap();
                let result = match dispatch(&frame) { Some(result)=>result,None=>self.rpc(&frame) };
                let cursor = self.runtime.catalog().lock().unwrap().event_cursor().unwrap();
                if cursor != before {
                    self.host.send(json!({"v":crate::protocol::PROTOCOL_VERSION,"kind":"runtime-event","kernelEpoch":EPOCH,"stream":"durable","cursor":cursor}));
                }
                if !deliver(&frame, &result) {
                    return Some(frame);
                }
                self.host.send(match result {
                    Ok(value) => json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":value}),
                    Err(error) => json!({"kind":"fixture-response","id":frame["id"],"ok":false,"error":error.to_string()}),
                });
                None
            }
            "host-tool-response" | "host-tool-revoked" => {
                self.bridge.receive(frame);
                None
            }
            "host-tool-receipt" => {
                let accepted = serde_json::from_value::<LateReceipt>(frame.clone())
                    .unwrap()
                    .apply(&self.runtime.catalog())
                    .is_ok();
                self.host.send(json!({"v":1,"kind":"host-tool-receipt-ack","kernelEpoch":EPOCH,"id":frame["id"],"accepted":accepted}));
                None
            }
            "fixture-failed" => panic!("original Web owner failed: {frame}"),
            _ => Some(frame),
        }
    }
    pub(super) fn receive(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            assert!(
                Instant::now() < deadline,
                "Web lifecycle stalled waiting for {kind}"
            );
            if let Some(frame) = self.pump() {
                assert_eq!(frame["kind"], kind, "{frame}");
                return frame;
            }
        }
    }
}

struct Policy {
    schemas: Vec<ToolSchema>,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "web-review".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        if matches!(
            event,
            PolicyEvent::ModelCompleted {
                reason: FinishReason::Stop,
                ..
            }
        ) {
            let nodes = [("pinned", "webfetch"), ("pdf-text", "document_read")].into_iter().map(|(id,name)| {
                let output = view.history.iter().find_map(|item| match &item.content {
                    Content::ToolResult { result } if result.call_id == id => match &result.completion {
                        ToolCompletion::Result { content, .. } => Some(&content.data), _ => None }, _ => None }).unwrap();
                let schema = self.schemas.iter().find(|tool| tool.name == name).unwrap();
                let id = format!("policy-{id}");
                PolicyToolNode { id: id.clone(), depends_on: vec![], call: ToolCall {
                    call_id: id, name: name.into(), schema_version: schema.version.clone(),
                    arguments: json!({"snapshotId":output["snapshot"]["snapshotId"],"view":"text"}) } }
            }).collect();
            return Ok(PolicyDecision {
                action: PolicyAction::ToolGraph { nodes },
                state: state.clone(),
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            assert_eq!(receipts.len(), 2);
            for receipt in receipts {
                assert_eq!(receipt.outcome(), Outcome::Succeeded);
            }
            assert!(receipts.iter().all(|receipt| receipt.output().is_some()));
            return Ok(PolicyDecision {
                action: PolicyAction::Complete,
                state: state.clone(),
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}

struct Model {
    views: Arc<Mutex<Vec<RequestView>>>,
    wires: Arc<Mutex<Vec<Value>>>,
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        use varin_runtime::providers::{
            Connection, EnvironmentCredentialResolver, ReqwestTransport,
        };
        let mut connection = Connection::new(
            "https://model.invalid/responses",
            Arc::new(EnvironmentCredentialResolver::default()),
            Arc::new(ReqwestTransport::default()),
        );
        connection.accepts_images = Some(true);
        let wire = varin_runtime::providers::responses::ResponsesProvider::new(connection)
            .serialize(view)?;
        self.views.lock().unwrap().push(view.clone());
        self.wires.lock().unwrap().push(wire.clone());
        Ok(wire)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let results: Vec<_> = request
            .view
            .history
            .iter()
            .filter_map(|item| match &item.content {
                Content::ToolResult { result } => Some(result),
                _ => None,
            })
            .collect();
        let data = |id: &str| {
            let result = results.iter().find(|result| result.call_id == id).unwrap();
            let ToolCompletion::Result {
                outcome,
                effect,
                content,
            } = &result.completion
            else {
                panic!("finite Web result")
            };
            assert_eq!(
                (*outcome, *effect),
                (Outcome::Succeeded, Effect::None),
                "{result:?}"
            );
            content.data.clone()
        };
        let calls = match results.len() {
            0 => vec![(
                "search",
                "websearch",
                json!({"query":"original web contract","urls":["https://web.invalid/article","https://web.invalid/paper.pdf"]}),
            )],
            1 => {
                let search = data("search");
                assert_eq!(search["providerId"], "default-exa");
                assert_eq!(
                    search["items"][0]["results"][0]["title"],
                    "Original discovery"
                );
                vec![
                    (
                        "pinned",
                        "webfetch",
                        json!({"snapshotId":search["items"][1]["fetch"]["snapshot"]["snapshotId"],"find":"OriginalWebText"}),
                    ),
                    (
                        "pdf-text",
                        "document_read",
                        json!({"snapshotId":search["items"][2]["fetch"]["snapshot"]["snapshotId"],"view":"text","pages":"all"}),
                    ),
                ]
            }
            3 => {
                assert!(
                    data("pinned")["markdown"]
                        .as_str()
                        .unwrap()
                        .contains("OriginalWebText")
                );
                assert!(
                    data("pdf-text")["markdown"]
                        .as_str()
                        .unwrap()
                        .contains("LEFT")
                );
                vec![
                    (
                        "refresh",
                        "webfetch",
                        json!({"url":"https://web.invalid/article","refresh":true}),
                    ),
                    (
                        "pdf-image",
                        "document_read",
                        json!({"snapshotId":data("pdf-text")["snapshot"]["snapshotId"],"view":"page-image","page":1,"scale":1}),
                    ),
                ]
            }
            5 => {
                assert!(
                    data("refresh")["markdown"]
                        .as_str()
                        .unwrap()
                        .contains("RefreshedWebText")
                );
                assert_ne!(
                    data("pinned")["snapshot"]["snapshotId"],
                    data("refresh")["snapshot"]["snapshotId"]
                );
                vec![(
                    "old-again",
                    "webfetch",
                    json!({"snapshotId":data("pinned")["snapshot"]["snapshotId"]}),
                )]
            }
            6 => {
                assert_eq!(
                    data("old-again")["markdown"],
                    data("search")["items"][1]["fetch"]["markdown"]
                );
                vec![]
            }
            _ => panic!("unexpected repeated Web execution"),
        };
        for (id, name, arguments) in &calls {
            let schema = request
                .view
                .binding
                .tools
                .iter()
                .find(|schema| schema.name == *name)
                .unwrap();
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: (*id).into(),
                    opaque: None,
                    content: Content::ToolCall {
                        call: ToolCall {
                            call_id: (*id).into(),
                            name: (*name).into(),
                            schema_version: schema.version.clone(),
                            arguments: arguments.clone(),
                        },
                    },
                },
            })
            .unwrap();
        }
        if calls.is_empty() {
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: "done".into(),
                    opaque: None,
                    content: Content::Text {
                        text: "Original material retained".into(),
                    },
                },
            })
            .unwrap();
        }
        Ok(if calls.is_empty() {
            FinishReason::Stop
        } else {
            FinishReason::ToolCalls
        })
    }
}

#[test]
#[ignore = "requires built Web builtin and workspace Node/tsx; controlled outbound bytes, no listeners or model account"]
fn original_web_search_fixed_pdf_and_public_reader_share_native_identity_and_storage() {
    let root = std::env::temp_dir().join(format!("varin-web-domain-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let catalog_path = root.join("catalog");
    let storage_root = root.join("storage");
    let mut db = Catalog::open(&catalog_path).unwrap();
    db.create_thread(THREAD, BRANCH).unwrap();
    db.create_thread("thread:foreign", "branch:foreign")
        .unwrap();
    let submission = db
        .prepare_submission(
            SubmitInput {
                key: "web-input".into(),
                thread_id: THREAD.into(),
                branch_id: BRANCH.into(),
                expected_head: None,
                input: json!({"text":"Read fixed web material"}),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap();
    let submitted = db
        .admit_submission(submission.load(None, false).unwrap())
        .unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let (sender, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(sender.into());
    bridge.initialize(EPOCH);
    let mut f = Fixture {
        host: Host::new(),
        runtime: runtime.clone(),
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge: bridge.clone(),
        outgoing,
    };
    f.host.send(json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"storageRoot":storage_root,"runId":submitted.run_id,"threadId":THREAD,"branchId":BRANCH}));
    let prepared = f.receive("fixture-prepared");
    let live: Vec<_> = prepared["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| live_extension_binding(serde_json::from_value(v.clone()).unwrap()).unwrap())
        .collect();
    let mut schemas: Vec<_> = live.iter().map(|live| live.binding.tool.clone()).collect();
    schemas.sort_by(|left, right| left.name.cmp(&right.name));
    assert_eq!(schemas.len(), 3);
    let binding: RequestBinding = serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
        "connection_identity":"fixture","provider_family":"openai-responses","model":"fixture","credential_ref":null,
        "configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"instruction_sources":[],"memory_checkpoint":null,
        "attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":BRANCH,"ancestor_id":null,"leaf_id":submitted.input_id}})).unwrap();
    let policy: Arc<dyn AgentPolicy> = Arc::new(Policy {
        schemas: schemas.clone(),
    });
    let mut launch = varin_runtime::catalog::launches::LaunchSelection::from_binding(
        &binding,
        policy.identity(),
        None,
    );
    launch.extension_bindings = live.iter().map(|live| live.binding.clone()).collect();
    runtime
        .catalog()
        .lock()
        .unwrap()
        .bind_launch(&submitted.run_id, launch)
        .unwrap();
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge);
    let selected = tools
        .prepare_scope(&submitted.run_id, vec![], None, live)
        .unwrap();
    let executor = tools.install(&submitted.run_id, 1, selected).unwrap();
    let views = Arc::new(Mutex::new(Vec::new()));
    let wires = Arc::new(Mutex::new(Vec::new()));
    let execution = runtime
        .start(
            &submitted.run_id,
            RunStart {
                binding,
                policy_state: Value::Null,
                provider: Arc::new(Model {
                    views: views.clone(),
                    wires: wires.clone(),
                }),
                tools: executor,
                policy,
                context_preparation: Arc::new(NoopContextPreparation),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    let (done_tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(execution.wait());
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let report = loop {
        assert!(
            Instant::now() < deadline,
            "original Web tool sequence stalled"
        );
        if let Ok(result) = done.try_recv() {
            break result.unwrap();
        }
        assert!(f.pump().is_none());
    };
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let view = views.lock().unwrap().last().unwrap().clone();
    let outputs: Vec<_> = view
        .history
        .iter()
        .filter_map(|item| match &item.content {
            Content::ToolResult { result } => Some(result),
            _ => None,
        })
        .collect();
    assert_eq!(outputs.len(), 6);
    let data = |id: &str| {
        let ToolCompletion::Result { content, .. } =
            &outputs.iter().find(|r| r.call_id == id).unwrap().completion
        else {
            panic!()
        };
        content.clone()
    };
    let image = data("pdf-image");
    assert!(
        image
            .parts
            .iter()
            .any(|part| matches!(part, varin_runtime::output::OutputPart::Media { .. }))
    );
    assert!(
        wires
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .to_string()
            .contains("input_image")
    );
    assert!(
        view.history
            .iter()
            .filter(|item| matches!(item.provenance, Provenance::SystemInstruction { .. }))
            .all(|item| !serde_json::to_string(item)
                .unwrap()
                .contains("OriginalWebText"))
    );
    f.host.send(json!({"kind":"fixture-public","threadId":THREAD,"branchId":BRANCH,
        "pdf":data("pdf-text").data["snapshot"]["snapshotId"],"original":data("pinned").data["snapshot"]["snapshotId"]}));
    let public = f.receive("fixture-public-result");
    assert_eq!(public["ok"], true, "{public}");
    let collection = runtime
        .catalog()
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    let collection = collection.run();
    assert_eq!(
        collection.status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    f.host.send(json!({"kind":"fixture-finish"}));
    let finished = f.receive("fixture-finished");
    assert_eq!(
        finished["articleFetches"], 2,
        "only explicit refresh fetches the original URL again"
    );
    assert_eq!(finished["pdfFetches"], 1);
    assert_eq!(finished["searches"], 1);
    f.bridge.close();
    drop(tools);
    drop(runtime);
    drop(f);
    let reopened = Catalog::open(&catalog_path).unwrap();
    assert_eq!(
        reopened.run(&submitted.run_id).unwrap().state,
        RunState::Completed
    );
    // New Host, domain caches and Storage connection: fixed materials have real
    // durable Thread roots, independent of the completed execution or Pi session.
    let runtime = Arc::new(RunSupervisor::new(reopened));
    let (sender, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(sender.into());
    bridge.initialize(EPOCH);
    let mut reopened = Fixture {
        host: Host::new(),
        runtime,
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge,
        outgoing,
    };
    reopened.host.send(json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,
        "storageRoot":storage_root,"runId":submitted.run_id,"threadId":THREAD,"branchId":BRANCH,"readerOnly":true}));
    reopened.receive("fixture-reader-ready");
    reopened.host.send(json!({"kind":"fixture-public","threadId":THREAD,"branchId":BRANCH,
        "pdf":data("pdf-text").data["snapshot"]["snapshotId"],"original":data("pinned").data["snapshot"]["snapshotId"]}));
    assert_eq!(reopened.receive("fixture-public-result")["ok"], true);
    reopened.host.send(json!({"kind":"fixture-finish"}));
    let finished = reopened.receive("fixture-finished");
    assert_eq!(finished["articleFetches"], 0);
    assert_eq!(finished["pdfFetches"], 0);
    assert_eq!(finished["searches"], 0);
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}
