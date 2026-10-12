//! Model-authored files through original Storage, package and dynamic Run owners.
//! Only model choices and stdio delivery are controlled; no product listener is started.
use super::web_domain_review::{EPOCH, Fixture, GENERATION, HOST, Host};
use super::*;
use crate::host_tools::ToolBridge;
use crate::storage::Storage;
use crate::tools::{
    KernelResourceClient, KernelToolExecutor, ResourceCall, ResourceWork, ToolKind,
    finish_resource_blob_read, prepare_resource,
};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::{Effect, Outcome, RunState};

#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
fn failure(error: impl std::fmt::Display) -> KernelError {
    KernelError::Operation(error.to_string())
}
const THREAD: &str = "thread:authored";
const BRANCH: &str = "branch:authored";

#[derive(Default)]
struct Observed {
    grouped: bool,
    files: Vec<(String, String)>,
    results: BTreeMap<String, ToolCompletion>,
    requested_enable: bool,
    enabled: bool,
    surface_checks: BTreeSet<String>,
    policy_result: Option<Value>,
    policy_reference: Option<PolicyEvidenceRef>,
    package_schema: Option<ToolSchema>,
    available_tools: BTreeSet<String>,
}
struct Model {
    observed: Arc<Mutex<Observed>>,
    commands: mpsc::Sender<Value>,
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let mut state = self.observed.lock().unwrap();
        for item in &request.view.history {
            if let Content::ToolResult { result } = &item.content {
                if result.call_id.starts_with("author-") {
                    state
                        .results
                        .insert(result.call_id.clone(), result.completion.clone());
                }
            }
        }
        let data = |state: &Observed, id: &str| match &state.results[id] {
            ToolCompletion::Result { content, .. } => content.data.clone(),
            other => panic!("expected finite authored result: {other:?}"),
        };
        let mut next = None;
        for (index, (path, content)) in state.files.iter().enumerate() {
            let read = format!("author-read-{index}");
            let write = format!("author-write-{index}");
            if !state.results.contains_key(&read) {
                next = Some((read, "file_read", json!({"path":path})));
                break;
            }
            if !state.results.contains_key(&write) {
                next = Some((
                    write,
                    "file_write",
                    json!({"path":path,"content":content,"readVersion":data(&state,&read)["readVersion"]}),
                ));
                break;
            }
            assert!(
                matches!(
                    &state.results[&write],
                    ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::Confirmed,
                        ..
                    }
                ),
                "{:?}",
                state.results[&write]
            );
        }
        if next.is_none() && !state.results.contains_key("author-catalog") {
            next = Some((
                "author-catalog".into(),
                "runtime_contract",
                json!({"action":"list","kind":"service"}),
            ));
        }
        if next.is_none() && !state.results.contains_key("author-stage") {
            let metadata = data(&state, "author-catalog");
            next = Some((
                "author-stage".into(),
                "extension_package",
                json!({"action":"stage","packagePath":"package","expectedRevision":metadata["revisions"]["catalog"]}),
            ));
        }
        if next.is_none() {
            assert!(matches!(
                &state.results["author-stage"],
                ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    effect: Effect::Confirmed,
                    ..
                }
            ));
            let staged = data(&state, "author-stage");
            assert_eq!(staged["outcome"], "installed_disabled", "{staged}");
            assert_eq!(staged["applicationRequested"], false);
            if !state.requested_enable {
                state.requested_enable = true;
                self.commands
                    .send(json!({"kind":"fixture-user-enable"}))
                    .unwrap();
            }
            drop(state);
            let deadline = Instant::now() + Duration::from_secs(30);
            while !self.observed.lock().unwrap().enabled {
                assert!(
                    Instant::now() < deadline,
                    "explicit user enable did not finish"
                );
                thread::sleep(Duration::from_millis(5));
            }
            state = self.observed.lock().unwrap();
            if !state.results.contains_key("author-use") {
                if request
                    .view
                    .binding
                    .tools
                    .iter()
                    .any(|tool| tool.name == "authored_text_count")
                {
                    next = Some((
                        "author-use".into(),
                        "authored_text_count",
                        json!({"text":"hello 源 world"}),
                    ));
                } else {
                    // This model request was frozen before enable. A real ordinary result creates
                    // the next legal request boundary, where the original dynamic owner may publish.
                    let index = state
                        .results
                        .keys()
                        .filter(|key| key.starts_with("author-boundary-"))
                        .count();
                    assert!(
                        index < 20,
                        "new tool never reached the original Run directory"
                    );
                    next = Some((
                        format!("author-boundary-{index}"),
                        "runtime_contract",
                        json!({"action":"list","kind":"tool"}),
                    ));
                }
            } else {
                let result = data(&state, "author-use");
                assert_eq!(result, json!({"words":3,"characters":13}));
                for (number, label) in [(1, "broken"), (2, "updated")] {
                    let prefix = format!("author-update-{number}");
                    for path in ["package/host.js", "package/surface.cjs"] {
                        let original =
                            &state.files.iter().find(|(name, _)| name == path).unwrap().1;
                        let content = if path.ends_with("host.js") {
                            original.replace(
                                "length : 0, characters",
                                &format!("length * {} : 0, characters", number + 1),
                            )
                        } else {
                            let changed = original.replace(
                                "text counter · 1.0.0",
                                &format!("text counter · {label}"),
                            );
                            if number == 1 {
                                changed.replace("mount(container, mount) {", "mount(container, mount) { throw new Error('controlled candidate mount failure');")
                            } else {
                                changed
                            }
                        };
                        let read = format!("{prefix}-read-{path}");
                        let write = format!("{prefix}-write-{path}");
                        if !state.results.contains_key(&read) {
                            next = Some((read, "file_read", json!({"path":path})));
                            break;
                        }
                        if !state.results.contains_key(&write) {
                            next = Some((
                                write,
                                "file_write",
                                json!({"path":path,"content":content,"readVersion":data(&state,&read)["readVersion"]}),
                            ));
                            break;
                        }
                    }
                    if next.is_some() {
                        break;
                    }
                    let catalog = format!("{prefix}-catalog");
                    let stage = format!("{prefix}-stage");
                    if !state.results.contains_key(&catalog) {
                        next = Some((
                            catalog,
                            "runtime_contract",
                            json!({"action":"list","kind":"service"}),
                        ));
                        break;
                    }
                    if !state.results.contains_key(&stage) {
                        next = Some((
                            stage,
                            "extension_package",
                            json!({"action":"stage","packagePath":"package","expectedRevision":data(&state,&catalog)["revisions"]["catalog"]}),
                        ));
                        break;
                    }
                    let staged = data(&state, &stage);
                    assert_eq!(staged["outcome"], "candidate_staged", "{staged}");
                    if number == 1 {
                        let apply = format!("{prefix}-apply");
                        if !state.results.contains_key(&apply) {
                            next = Some((
                                apply,
                                "extension_package",
                                json!({"action":"apply","extensionId":staged["extensionId"],"candidateIntegrity":staged["artifactIntegrity"],"expectedRevision":staged["catalogRevision"]}),
                            ));
                            break;
                        }
                        assert!(matches!(
                            &state.results[&apply],
                            ToolCompletion::Result {
                                outcome: Outcome::Succeeded,
                                effect: Effect::Confirmed,
                                ..
                            }
                        ));
                        assert_eq!(
                            data(&state, &apply)["outcome"],
                            if state.grouped {
                                "application_requested"
                            } else {
                                "selected"
                            }
                        );
                    } else if state.policy_result.is_none() {
                        return Ok(FinishReason::Stop);
                    } else {
                        let outcome = state.policy_result.as_ref().unwrap()["outcome"]
                            .as_str()
                            .unwrap();
                        assert!(
                            outcome == "selected"
                                || (state.grouped && outcome == "application_requested")
                        );
                    }
                    if !state.surface_checks.contains(label) {
                        self.commands.send(json!({"kind":"fixture-check-update","label":label,"integrity":staged["artifactIntegrity"]})).unwrap();
                        drop(state);
                        let deadline = Instant::now() + Duration::from_secs(30);
                        while !self.observed.lock().unwrap().surface_checks.contains(label) {
                            assert!(Instant::now() < deadline, "Surface update check stalled");
                            thread::sleep(Duration::from_millis(5));
                        }
                        state = self.observed.lock().unwrap();
                    }
                }
                if next.is_none() {
                    if !state.results.contains_key("author-update-boundary") {
                        // Policy apply may complete after this request was already frozen. The Host
                        // check observed the exact artifact's original tools.ready acknowledgement;
                        // close this exchange before asking a subsequent request to use that owner.
                        next = Some((
                            "author-update-boundary".into(),
                            "file_read",
                            json!({"path":"package/varin.extension.json"}),
                        ));
                    } else if !state.results.contains_key("author-new-use") {
                        next = Some((
                            "author-new-use".into(),
                            "authored_text_count",
                            json!({"text":"hello 源 world"}),
                        ));
                    } else {
                        assert_eq!(
                            data(&state, "author-new-use"),
                            json!({"words":9,"characters":13})
                        );
                        return Ok(FinishReason::Stop);
                    }
                }
            }
        }
        let (mut id, mut name, mut arguments) = next.unwrap();
        if !request
            .view
            .binding
            .tools
            .iter()
            .any(|tool| tool.name == name)
        {
            self.commands
                .send(json!({"kind":"fixture-await-tool","name":name}))
                .unwrap();
            drop(state);
            let deadline = Instant::now() + Duration::from_secs(60);
            while !self.observed.lock().unwrap().available_tools.contains(name) {
                assert!(
                    Instant::now() < deadline,
                    "cold distribution preparation did not finish for {name}"
                );
                thread::sleep(Duration::from_millis(5));
            }
            state = self.observed.lock().unwrap();
            let index = state
                .results
                .keys()
                .filter(|key| key.starts_with("author-directory-boundary-"))
                .count();
            assert!(
                index < 20,
                "prepared tool did not publish at request boundary"
            );
            id = format!("author-directory-boundary-{index}");
            name = "file_read";
            arguments = json!({"path":"package/varin.extension.json"});
        }
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("normal directory is missing {name}"));
        if name == "extension_package" {
            state.package_schema = Some(schema.clone());
        }
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: id.clone(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: id,
                        name: name.into(),
                        schema_version: schema.version.clone(),
                        arguments,
                    },
                },
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}

struct Policy {
    observed: Arc<Mutex<Observed>>,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        DefaultAgentPolicy.identity()
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
        ) && self.observed.lock().unwrap().policy_result.is_none()
        {
            let observed = self.observed.lock().unwrap();
            let ToolCompletion::Result { content, .. } = &observed.results["author-update-2-stage"]
            else {
                panic!("finite staged candidate");
            };
            let staged = &content.data;
            let schema = observed.package_schema.as_ref().unwrap();
            return Ok(PolicyDecision {
                state: Value::Null,
                action: PolicyAction::ToolGraph {
                    nodes: vec![PolicyToolNode {
                        id: "policy-authored-apply".into(),
                        depends_on: vec![],
                        call: ToolCall {
                            call_id: "policy-authored-apply".into(),
                            name: schema.name.clone(),
                            schema_version: schema.version.clone(),
                            arguments: json!({"action":"apply","extensionId":staged["extensionId"],"candidateIntegrity":staged["artifactIntegrity"],"expectedRevision":staged["catalogRevision"]}),
                        },
                    }],
                },
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            let PolicyNodeCompletion::Result {
                outcome,
                effect,
                output,
            } = &receipts[0].completion
            else {
                panic!("finite policy apply");
            };
            assert_eq!(
                (*outcome, *effect),
                (Outcome::Succeeded, Effect::Confirmed),
                "{receipts:?}"
            );
            return Ok(PolicyDecision {
                state: Value::Null,
                action: PolicyAction::ReadResult {
                    reference: output.clone(),
                    index: 0,
                },
            });
        }
        if let PolicyEvent::ResultChunk {
            bytes,
            reference,
            index,
            total_chunks,
            ..
        } = event
        {
            assert_eq!((*index, *total_chunks), (0, 1));
            let output: OutputBody = serde_json::from_slice(bytes).unwrap();
            let mut observed = self.observed.lock().unwrap();
            observed.policy_result = Some(output.data);
            observed.policy_reference = Some(reference.clone());
            return Ok(PolicyDecision {
                state: Value::Null,
                action: PolicyAction::RequestModel,
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}

struct Review {
    f: Fixture,
    tools: Arc<crate::run_tools::RunTools>,
    resources: mpsc::Receiver<ResourceCall>,
    resource_client: KernelResourceClient,
    observed: Arc<Mutex<Observed>>,
    command_sender: mpsc::Sender<Value>,
    commands: mpsc::Receiver<Value>,
    report: Option<mpsc::Receiver<Result<ExecutionReport, ExecutionError>>>,
}
impl Review {
    fn pump(&mut self) -> Option<Value> {
        while let Ok(command) = self.commands.try_recv() {
            self.f.host.send(command);
        }
        while let Ok(call) = self.resources.try_recv() {
            let work = prepare_resource(
                &mut self.f.storage.lock().unwrap(),
                EPOCH,
                HOST,
                GENERATION,
                &call,
            );
            let result = match work {
                Ok(ResourceWork::Ready(value)) => Ok(value),
                Ok(ResourceWork::BlobRead(task)) => {
                    let bytes = task.run();
                    finish_resource_blob_read(
                        &mut self.f.storage.lock().unwrap(),
                        EPOCH,
                        HOST,
                        GENERATION,
                        &call,
                        &task,
                        bytes,
                    )
                }
                Err(error) => Err(error),
            };
            call.reply.send(result).unwrap();
        }
        let owner = self.f.runtime.catalog();
        let runtime = self.f.runtime.clone();
        let tools = self.tools.clone();
        let resources = self.resource_client.clone();
        let observed = self.observed.clone();
        let commands = self.command_sender.clone();
        let mut capture = None;
        let mut report = None;
        let frame = self.f.pump_dispatch(|frame| {
            let method = frame["method"].as_str().unwrap();
            if method == "runtime.tools.inspect" {
                return Some((|| {
                    let params = &frame["params"];
                    validate_method_params(method, params)?;
                    let nested = owner.lock().unwrap().nested_tools();
                    Ok(serde_json::to_value(nested.inspect(params["parentOperationId"].as_str().unwrap(),
                        &serde_json::from_value(params["executorOwner"].clone())?, params["name"].as_str()).map_err(failure)?)?)
                })());
            }
            if method == "runtime.tools.invoke" {
                let params=frame["params"].clone(); let id=frame["id"].clone();
                let owner=owner.clone(); let commands=commands.clone();
                thread::spawn(move || {
                    let result=(|| -> Result<Value,KernelError> {
                        validate_method_params("runtime.tools.invoke",&params)?;
                        let p:NestedToolInvokeParams=serde_json::from_value(params)?;
                        let nested=owner.lock().unwrap().nested_tools();
                        Ok(serde_json::to_value(nested.invoke(&p.parent_operation_id,&p.executor_owner,p.call).map_err(failure)?)?)
                    })();
                    commands.send(match result {Ok(result)=>json!({"kind":"fixture-response","id":id,"ok":true,"result":result}),Err(error)=>json!({"kind":"fixture-response","id":id,"ok":false,"error":error.to_string()})}).unwrap();
                });
                return Some(Ok(Value::Null));
            }
            if method == "file.captureBatch" { capture = Some(frame.clone()); return Some(Ok(Value::Null)); }
            if !method.starts_with("runtime.child.") && !matches!(method, "runtime.launch.extensions.prepare" | "runtime.tools.select" | "runtime.tools.ready" | "runtime.run.reconcile" | "runtime.memory.reconcile" | "runtime.plan.reconcile" | "runtime.run.start") { return None; }
            let params = frame["params"].clone();
            Some((|| {
                validate_method_params(method, &params)?;
                if method.starts_with("runtime.child.") { return child_commands::execute(runtime.clone(), resources.clone(), method, params, &AtomicBool::new(false)); }
                match method {
                    "runtime.launch.extensions.prepare" => {
                        let p: ExtensionPrepareParams = serde_json::from_value(params)?;
                        let bindings = p.bindings.into_iter().map(extension_binding).collect::<Result<Vec<_>,_>>()?;
                        let preparation = owner.lock().unwrap().prepare_extensions_change(&p.run_id, bindings).map_err(failure)?;
                        let prepared = preparation.load().map_err(failure)?;
                        let read = owner.lock().unwrap().admit_launch_change(prepared).map_err(failure)?;
                        Ok(serde_json::to_value(read.load().map_err(failure)?)?)
                    }
                    "runtime.tools.select" => {
                        let p: ToolSelectParams = serde_json::from_value(params)?;
                        tools.desire(&p.run_id,&p.selection_id).map_err(failure)?; Ok(json!({}))
                    }
                    "runtime.tools.ready" => {
                        let p: ToolReadyParams = serde_json::from_value(params)?;
                        let bindings = p.extension_bindings.unwrap_or_default().into_iter().map(live_extension_binding).collect::<Result<Vec<_>,_>>()?;
                        Ok(json!({"ready":tools.ready(&p.run_id,&p.selection_id,None,bindings,||false).map_err(failure)?}))
                    }
                    "runtime.run.reconcile" => {
                        let p: RunReconcileParams = serde_json::from_value(params)?;
                        assert!(owner.lock().unwrap().pending_run_operations(&p.run_id).map_err(failure)?.is_empty());
                        Ok(json!({"reconciled":[],"unresolved":[]}))
                    }
                    "runtime.memory.reconcile" | "runtime.plan.reconcile" => {
                        let p: RunParams = serde_json::from_value(params)?;
                        assert!(owner.lock().unwrap().pending_run_operations(&p.run_id).map_err(failure)?.is_empty());
                        Ok(json!({"reconciled":[],"unresolved":[]}))
                    }
                    "runtime.run.start" => {
                        let p: RunStartParams = serde_json::from_value(params)?;
                        let run = owner.lock().unwrap().run(&p.run_id).map_err(failure)?;
                        let source: crate::tools::ToolBinding = serde_json::from_value(p.tool_binding.unwrap())?;
                        let base = KernelToolExecutor::new(source, resources.clone()).map_err(failure)?.declarations(false);
                        let extensions = p.extension_bindings.unwrap_or_default().into_iter().map(live_extension_binding).collect::<Result<Vec<_>,_>>()?;
                        let prepared = tools.prepare_scope(&run.id, base, None, extensions).map_err(failure)?;
                        let read = owner.lock().unwrap().capture_launch(&run.id).map_err(failure)?.unwrap();
                        let launch = read.load().map_err(failure)?;
                        owner.lock().unwrap().bind_launch(&run.id, launch.selection.clone()).map_err(failure)?;
                        let mut start = varin_runtime::model_session::bind(serde_json::from_value(run.configuration.clone())?).map_err(failure)?;
                        start.binding.tools = launch.selection.tools.clone();
                        start.binding.tool_schema_generation = launch.selection.tool_schema_generation;
                        start.binding.history_range = HistoryRange { branch_id: run.branch_id.clone(), ancestor_id: None,
                            leaf_id: owner.lock().unwrap().head(&run.branch_id).map_err(failure)? };
                        start.provider = Arc::new(Model { observed: observed.clone(), commands: commands.clone() });
                        start.policy = Arc::new(Policy { observed:observed.clone() });
                        start.context_preparation = Arc::new(NoopContextPreparation);
                        start.tools = tools.install(&run.id, start.binding.tool_schema_generation, prepared).map_err(failure)?;
                        let handle = runtime.start(&run.id,start).map_err(failure)?;
                        let response = json!({"runId":handle.run_id,"epoch":handle.epoch});
                        let (send, done) = mpsc::channel();
                        thread::spawn(move || { let _=send.send(handle.wait()); });
                        report = Some(done);
                        Ok(response)
                    }
                    _ => dispatch(&mut owner.lock().unwrap(), method, params),
                }
            })())
        }, |frame,_| frame["method"] != "file.captureBatch" && frame["method"] != "runtime.tools.invoke");
        if let Some(call) = capture {
            let result = (|| -> Result<Value, KernelError> {
                let params = &call["params"];
                let grant_id = call["grantId"].as_str();
                validate_method_params("file.captureBatch", params)?;
                let task = {
                    let mut storage = self.f.storage.lock().unwrap();
                    let (grant, p) = storage.authorize(
                        grant_id,
                        EPOCH,
                        HOST,
                        GENERATION,
                        "file.captureBatch",
                        params,
                    )?;
                    storage.prepare_capture(
                        "file.captureBatch",
                        &p,
                        &grant,
                        Arc::new(AtomicBool::new(false)),
                    )?
                };
                let body = task.run();
                let mut storage = self.f.storage.lock().unwrap();
                let result = (|| {
                    let (grant, _) = storage.authorize(
                        grant_id,
                        EPOCH,
                        HOST,
                        GENERATION,
                        "file.captureBatch",
                        params,
                    )?;
                    storage.publish_capture(&task, body?, &grant)
                })();
                storage.finish_retained_file_lease(task.lease_id());
                result
            })();
            self.f.host.send(match result {Ok(result)=>json!({"kind":"fixture-response","id":call["id"],"ok":true,"result":result}),Err(error)=>json!({"kind":"fixture-response","id":call["id"],"ok":false,"error":error.to_string()})});
        }
        if let Some(report) = report {
            self.report = Some(report);
        }
        if let Some(value) = frame
            .as_ref()
            .filter(|frame| frame["kind"] == "fixture-tool-ready")
        {
            self.observed
                .lock()
                .unwrap()
                .available_tools
                .insert(value["name"].as_str().unwrap().into());
            return None;
        }
        if let Some(value) = frame
            .as_ref()
            .filter(|frame| frame["kind"] == "fixture-update-checked")
        {
            self.observed
                .lock()
                .unwrap()
                .surface_checks
                .insert(value["label"].as_str().unwrap().into());
            return None;
        }
        if frame
            .as_ref()
            .is_some_and(|frame| frame["kind"] == "fixture-enabled")
        {
            self.observed.lock().unwrap().enabled = true;
            return None;
        }
        if frame.as_ref().is_some_and(|frame| {
            frame["method"] == "runtime.tools.invoke" || frame["method"] == "file.captureBatch"
        }) {
            return None;
        }
        frame
    }
    fn receive(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            assert!(
                Instant::now() < deadline,
                "authored chain stalled at {kind}"
            );
            if let Some(frame) = self.pump() {
                assert_eq!(frame["kind"], kind, "{frame}");
                return frame;
            }
        }
    }
}

#[test]
#[ignore = "requires built ordinary extension packages; original Storage/Catalog and stdio, no listeners"]
fn model_authored_files_stage_disabled_then_original_enable_reaches_dynamic_model() {
    run_authored_extension_chain(false);
}

#[test]
#[ignore = "requires built ordinary extension packages; original Storage/Catalog and stdio, no listeners"]
fn grouped_updates_wait_for_actual_surface_members_then_recover_original_results() {
    run_authored_extension_chain(true);
}

fn run_authored_extension_chain(grouped: bool) {
    let root = std::env::temp_dir().join(format!("varin-authored-review-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut db = Catalog::open(root.join("catalog")).unwrap();
    db.create_thread(THREAD, BRANCH).unwrap();
    let configuration = json!({"providerFamily":"openai-responses","model":"controlled-authored","endpoint":"https://controlled.invalid/responses","credentialEnvironment":null,"allowAnonymous":true,"configurationGeneration":1,"maxOutputTokens":64});
    let preparation=db.prepare_submission(SubmitInput{key:"author-package".into(),thread_id:THREAD.into(),branch_id:BRANCH.into(),expected_head:None,input:json!({"text":"Create the ordinary text counter package and stage it for inspection"}),configuration:configuration.clone()},None,None).unwrap();
    let submitted = db
        .admit_submission(preparation.load(None, false).unwrap())
        .unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let (out, outgoing) = mpsc::sync_channel(256);
    let bridge = ToolBridge::new(out.into());
    bridge.initialize(EPOCH);
    let storage_root = root.join("storage");
    let f = Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/authored-extension-host.test-helper.ts",
        ),
        runtime: runtime.clone(),
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge: bridge.clone(),
        outgoing,
    };
    let (send, resources) = mpsc::channel();
    let resource_client = KernelResourceClient::new(
        move |call| {
            send.send(call)
                .map_err(|_| KernelError::Operation("authored resource closed".into()))
        },
        |_| Ok(()),
        Default::default(),
    );
    let (command_sender, commands) = mpsc::channel();
    let observed = Arc::new(Mutex::new(Observed {
        grouped,
        ..Default::default()
    }));
    let mut review = Review {
        f,
        tools: crate::run_tools::RunTools::new(runtime.catalog(), bridge),
        resources,
        resource_client,
        observed: observed.clone(),
        command_sender,
        commands,
        report: None,
    };
    review.f.host.send(json!({"kind":"fixture-initialize","grouped":grouped,"root":root,"storageRoot":storage_root,"epoch":EPOCH,"runId":submitted.run_id,"threadId":THREAD}));
    let ready = review.receive("fixture-ready");
    observed.lock().unwrap().files = ready["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["path"].as_str().unwrap().into(),
                f["content"].as_str().unwrap().into(),
            )
        })
        .collect();
    let mut bound =
        varin_runtime::model_session::bind(serde_json::from_value(configuration).unwrap()).unwrap();
    bound.binding.tools = KernelToolExecutor::selected_schemas(&BTreeSet::from([
        ToolKind::FileRead,
        ToolKind::FileWrite,
    ]));
    bound.binding.history_range = HistoryRange {
        branch_id: BRANCH.into(),
        ancestor_id: None,
        leaf_id: Some(submitted.input_id.clone()),
    };
    let source = serde_json::from_value(ready["source"].clone()).unwrap();
    let selection = varin_runtime::catalog::launches::LaunchSelection::from_binding(
        &bound.binding,
        bound.policy.identity(),
        Some(source),
    );
    runtime
        .catalog()
        .lock()
        .unwrap()
        .select_launch(&submitted.run_id, selection)
        .unwrap();
    review.f.host.send(json!({"kind":"fixture-start"}));
    review.receive("fixture-started");
    let deadline = Instant::now() + Duration::from_secs(120);
    let report = loop {
        assert!(Instant::now() < deadline, "authored model chain stalled");
        review.pump();
        if let Some(done) = &review.report {
            if let Ok(report) = done.try_recv() {
                break report.unwrap();
            }
        }
    };
    assert_eq!(
        report.state,
        RunState::Completed,
        "{:?} / {:?}",
        report.failure,
        runtime
            .catalog()
            .lock()
            .unwrap()
            .execution_history(BRANCH)
            .map(|items| items
                .into_iter()
                .filter_map(|item| match item.content {
                    Content::ToolResult { result }
                        if !matches!(
                            result.completion,
                            ToolCompletion::Result {
                                outcome: Outcome::Succeeded,
                                ..
                            }
                        ) =>
                        Some(result),
                    _ => None,
                })
                .collect::<Vec<_>>())
    );
    assert!(observed.lock().unwrap().results.contains_key("author-use"));
    review.f.host.send(json!({"kind":"fixture-finish"}));
    let finished = review.receive("fixture-finished");
    assert_eq!(finished["entry"]["desired"]["enabled"], true);
    assert_eq!(finished["entry"]["source"]["kind"], "source_view");
    assert!(
        finished["methods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|method| method == "runtime.tools.ready")
    );
    let owner = runtime.catalog();
    let history = owner.lock().unwrap().execution_history(BRANCH).unwrap();
    assert!(!history.iter().any(|item| matches!(&item.content,Content::ToolResult{result} if result.call_id=="policy-authored-apply")), "Policy application must not fabricate a model pair");
    let collection = owner
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    drop(owner);
    drop(review);
    drop(runtime);
    let reopened = Catalog::open(root.join("catalog")).unwrap();
    assert_eq!(reopened.execution_history(BRANCH).unwrap(), history);
    let observed = observed.lock().unwrap();
    let reference = observed.policy_reference.as_ref().unwrap();
    let chunk = reopened
        .policy_output_chunk(
            &submitted.run_id,
            &reference.action_id,
            &reference.node_id,
            &reference.content_ref,
            0,
        )
        .unwrap();
    assert_eq!(chunk.chunk_count, 1);
    let output: OutputBody = serde_json::from_slice(&chunk.bytes).unwrap();
    assert_eq!(Some(&output.data), observed.policy_result.as_ref());
    drop(observed);
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}
