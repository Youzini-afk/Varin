//! Materialized source -> original native tools -> actual bundled TypeScript -> durable history.
//! Only the test stdio delivery and model decisions are controlled. Process pipes, source reads,
//! grant identities, dependency resolution, diagnostic bytes and Catalog/Storage are production owners.
use super::material_collection_review::binding;
use super::web_domain_review::{Fixture, Host, EPOCH, GENERATION, HOST};
use super::*;
use crate::host_tools::ToolBridge;
use crate::storage::{process_interactions, Storage};
use crate::tools::{
    finish_resource_blob_read, prepare_resource, KernelResourceClient, KernelToolExecutor,
    ResourceCall, ResourceWork, ToolBinding, ToolKind,
};
use std::collections::BTreeSet;
use std::time::{Duration, Instant};
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Outcome, RunState};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;
#[path = "child_language_review.rs"]
mod child_review;
#[path = "language_policy_consumers_review.rs"]
mod policy_consumers_review;
const THREAD: &str = "thread:language";
const BRANCH: &str = "branch:language";
const TOOLS: [&str; 7] = [
    "language_definition",
    "language_references",
    "language_diagnostics",
    "language_hover",
    "language_symbols",
    "language_document_symbols",
    "language_call_hierarchy",
];
const SCRIPT_CALLS: usize = 10;

struct Script;
impl ModelProvider for Script {
    fn serialize(&self, view: &RequestView, reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        // Use the ordinary provider serialization too, without an external HTTP request.
        use varin_runtime::providers::{
            Connection, EnvironmentCredentialResolver, ReqwestTransport,
        };
        varin_runtime::providers::responses::ResponsesProvider::new(Connection::new(
            "https://controlled.invalid/responses",
            Arc::new(EnvironmentCredentialResolver::default()),
            Arc::new(ReqwestTransport::default()),
        ))
        .serialize(view, reuse)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let prefix = format!("{}:language-", request.view.run_id);
        let completed = request
            .view
            .history
            .iter()
            .filter(|item| {
                matches!(&item.content,
            Content::ToolResult { result } if result.call_id.starts_with(&prefix))
            })
            .count();
        // The bundled provider can legitimately return no call item for an import
        // alias. Follow the actual admitted definition to the declaration instead
        // of assuming that every reference position has a prepare result.
        let declaration = if completed >= 8 {
            request
                .view
                .history
                .iter()
                .find_map(|item| match &item.content {
                    Content::ToolResult { result } if result.call_id == format!("{prefix}2") => {
                        match &result.completion {
                            ToolCompletion::Result { content, .. } => {
                                Some(content.data["items"][0].clone())
                            }
                            _ => None,
                        }
                    }
                    _ => None,
                })
                .expect("the original definition result must precede relation queries")
        } else {
            Value::Null
        };
        // Record the actual cold answer, then let the ordinary diagnostics tool observe
        // the real publication before requiring precise cross-file definitions.
        let calls = [
            (
                "language_definition",
                json!({"path":"main.ts","line":3,"character":31}),
            ),
            ("language_diagnostics", json!({"path":"main.ts"})),
            (
                "language_definition",
                json!({"path":"main.ts","line":3,"character":31}),
            ),
            (
                "language_definition",
                json!({"path":"main.ts","line":3,"character":37}),
            ),
            (
                "language_references",
                json!({"path":"main.ts","line":3,"character":31}),
            ),
            (
                "language_hover",
                json!({"path":"main.ts","line":3,"character":31}),
            ),
            (
                "language_symbols",
                json!({"path":"main.ts","query":"greet"}),
            ),
            ("language_document_symbols", json!({"path":"main.ts"})),
            (
                "language_call_hierarchy",
                json!({"path":declaration["resource"]["resourceId"],"line":declaration["targetSelectionRange"]["start"]["line"],"character":declaration["targetSelectionRange"]["start"]["character"],"direction":"incoming"}),
            ),
            (
                "language_call_hierarchy",
                json!({"path":declaration["resource"]["resourceId"],"line":declaration["targetSelectionRange"]["start"]["line"],"character":declaration["targetSelectionRange"]["start"]["character"],"direction":"outgoing"}),
            ),
        ];
        assert_eq!(calls.len(), SCRIPT_CALLS);
        let Some((name, arguments)) = calls.get(completed) else {
            return Ok(FinishReason::Stop);
        };
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == *name)
            .unwrap();
        let id = format!("{prefix}{completed}");
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: id.clone(),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: id,
                        name: (*name).into(),
                        schema_version: schema.version.clone(),
                        arguments: arguments.clone(),
                    },
                },
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
struct Review {
    f: Fixture,
    language: crate::language::LanguageBridge,
    output: mpsc::SyncSender<Value>,
    subscriptions: crate::process::subscriptions::ProcessSubscriptions,
    interactions: process_interactions::Client,
    interaction_commands: mpsc::Receiver<process_interactions::Command>,
    resources: mpsc::Receiver<ResourceCall>,
    resource_client: KernelResourceClient,
    child_catalog: Option<varin_runtime::catalog::dispatch::ChildDispatchCatalog>,
    child_model: Option<varin_runtime::catalog::dispatch::ChildModelBinding>,
}
impl Review {
    fn open(root: &std::path::Path) -> Self {
        Self::open_with_script(
            root,
            "packages/web/application-host/lib/kernel/language-source-host.test-helper.ts",
        )
    }
    fn open_with_script(root: &std::path::Path, script: &str) -> Self {
        let executable = PathBuf::from(
            std::env::var_os("VARIN_TEST_KERNEL_EXECUTABLE")
                .expect("fresh installed kernel process guardian is required"),
        );
        assert!(executable.is_file());
        let mut catalog = Catalog::open(root.join("catalog")).unwrap();
        catalog.create_thread(THREAD, BRANCH).unwrap();
        let runtime = Arc::new(RunSupervisor::new(catalog));
        let (output, outgoing) = mpsc::sync_channel(256);
        let bridge = ToolBridge::new(output.clone().into());
        bridge.initialize(EPOCH);
        let language = crate::language::LanguageBridge::new(output.clone());
        language.initialize(EPOCH);
        let subscriptions =
            crate::process::subscriptions::ProcessSubscriptions::new(output.clone());
        let controls = crate::process::ProcessControlRegistry::default();
        let storage_root = root.join("storage");
        let mut storage = Storage::open(&storage_root, HOST).unwrap();
        storage.set_test_process_worker_executable(executable);
        storage.set_process_controls(controls.clone());
        storage.set_process_subscriptions(subscriptions.clone());
        let (resource_send, resources) = mpsc::channel();
        let resource_client = KernelResourceClient::new(
            move |call| {
                resource_send.send(call).map_err(|_| {
                    KernelError::Operation("language source resource receiver closed".into())
                })
            },
            |_| Ok(()),
            controls,
        );
        let (interaction_send, interaction_commands) = mpsc::channel();
        let interactions = process_interactions::Client::new(move |command| {
            interaction_send.send(command).map_err(|_| {
                KernelError::Operation("language source process interaction receiver closed".into())
            })
        });
        Self {
            f: Fixture {
                host: Host::with_script(script),
                runtime,
                storage: Mutex::new(storage),
                storage_root,
                bridge,
                outgoing,
            },
            language,
            output,
            subscriptions,
            interactions,
            interaction_commands,
            resources,
            resource_client,
            child_catalog: None,
            child_model: None,
        }
    }
    fn pump(&mut self) -> Option<Value> {
        self.f.runtime.reap().unwrap();
        while let Ok(command) = self.interaction_commands.try_recv() {
            self.f
                .storage
                .lock()
                .unwrap()
                .serve_interaction(command, EPOCH, HOST, GENERATION);
        }
        while let Ok(call) = self.resources.try_recv() {
            let prepared = prepare_resource(
                &mut self.f.storage.lock().unwrap(),
                EPOCH,
                HOST,
                GENERATION,
                &call,
            );
            let result = match prepared {
                Ok(ResourceWork::Ready(value)) => Ok(value),
                Ok(ResourceWork::BlobRead(task)) => {
                    let body = task.run();
                    finish_resource_blob_read(
                        &mut self.f.storage.lock().unwrap(),
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
        let subscriptions = self.subscriptions.clone();
        let interactions = self.interactions.clone();
        let output = self.output.clone();
        let frame = self.f.pump_dispatch(|frame| {
            let method = frame["method"].as_str().unwrap();
            let params = &frame["params"];
            match method {
                "runtime.child.capabilities" => {
                    validate_method_params(method, params).unwrap();
                    Some(serde_json::to_value(crate::child_capabilities::descriptors()).map_err(Into::into))
                }
                "process.subscription.ack" => Some(subscriptions.ack(params["subscriptionId"].as_str().unwrap(),
                    frame["grantId"].as_str().unwrap(), EPOCH, params["stream"].as_str().unwrap(), params["sequence"].as_u64().unwrap())),
                "process.subscription.unsubscribe" => Some(subscriptions.unsubscribe(params["subscriptionId"].as_str().unwrap(), frame["grantId"].as_str().unwrap(), EPOCH)),
                "process.write" | "process.resize" | "process.interaction.inspect" => {
                    let frame = frame.clone(); let client = interactions.clone(); let output = output.clone();
                    // Body/guardian work runs outside the Storage owner, as in production. The
                    // interaction commands are served above; no new process protocol is implemented.
                    thread::spawn(move || {
                        let result = client.wire(json!({"v":PROTOCOL_VERSION,"kind":"request","id":frame["id"],
                            "method":frame["method"],"params":frame["params"],"epoch":EPOCH,"grantId":frame["grantId"]}), CancellationToken::default());
                        output.send(match result {
                            Ok(result) => json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":result}),
                            Err(error) => crate::error::response_error(frame["id"].as_str().unwrap(), &error),
                        }).unwrap();
                    });
                    Some(Ok(Value::Null))
                }
                _ => None,
            }
        }, |frame, _| !matches!(frame["method"].as_str(), Some("process.write" | "process.resize" | "process.interaction.inspect")));
        if let Some(frame) = frame {
            if frame["kind"] == "language-response" {
                self.language.receive(frame);
                return None;
            }
            if frame["kind"] == "fixture-request" {
                return None;
            }
            return Some(frame);
        }
        None
    }
    fn receive(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            assert!(Instant::now() < deadline, "timed out waiting for {kind}");
            if let Some(frame) = self.pump() {
                assert_eq!(frame["kind"], kind, "{frame}");
                return frame;
            }
        }
    }
    fn initialize(&mut self, root: &std::path::Path, mode: &str, resume: bool) -> Value {
        self.f
            .host
            .send(json!({"kind":"fixture-initialize","root":root,
            "storageRoot":self.f.storage_root,"epoch":EPOCH,"mode":mode,"resume":resume}));
        let prepared = self.receive("fixture-prepared");
        self.child_catalog =
            Some(serde_json::from_value(prepared["childCatalog"].clone()).unwrap());
        self.child_model = Some(serde_json::from_value(prepared["parent"].clone()).unwrap());
        serde_json::to_value(
            serde_json::from_value::<varin_runtime::catalog::launches::SourceSelection>(
                prepared["source"].clone(),
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn admit(&self, source: Value, key: &str) -> String {
        let tools = KernelToolExecutor::selected_schemas(&enabled());
        let mut selection: LaunchSelection = serde_json::from_value(json!({"extension_bindings":[],
            "connection_identity":"language-source-review","provider_family":"controlled","model":"language-source",
            "configuration_generation":1,"tool_schema_generation":1,"tools":tools,
            "policy":{"name":"default","version":"1"},"source":source})).unwrap();
        let model = self.child_model.as_ref().unwrap();
        selection.connection_identity = model.connection_identity().unwrap();
        selection.provider_family = model.configuration.provider_family.clone();
        selection.model = model.configuration.model.clone();
        selection.configuration_generation = model.configuration.configuration_generation;
        selection.credential_scope = model.credential_scope.clone();
        selection.child_dispatch = self.child_catalog.clone();
        let owner = self.f.runtime.catalog();
        let mut db = owner.lock().unwrap();
        let head = db.head(BRANCH).unwrap();
        let run = db
            .submit_with_launch(
                &SubmitInput {
                    key: key.into(),
                    thread_id: THREAD.into(),
                    branch_id: BRANCH.into(),
                    expected_head: head,
                    input: json!({"text":"Inspect the actual materialized TypeScript project"}),
                    configuration: serde_json::to_value(&model.configuration).unwrap(),
                },
                Some(selection),
            )
            .unwrap()
            .run_id;
        let epoch = db.epoch();
        db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        run
    }
    fn freeze_child_directory(&self, run: &str) {
        let owner = self.f.runtime.catalog();
        let preparation = owner
            .lock()
            .unwrap()
            .prepare_child_dispatch_binding(
                run,
                self.child_model.clone().unwrap(),
                1,
                KernelToolExecutor::selected_schemas(&enabled()),
            )
            .unwrap();
        let prepared = preparation.load().unwrap();
        let reference = owner
            .lock()
            .unwrap()
            .bind_child_dispatch(run, prepared)
            .unwrap()
            .unwrap();
        let selected = owner
            .lock()
            .unwrap()
            .capture_child_dispatch(&reference)
            .load()
            .unwrap();
        for id in ["worker", "retrieval", "custom:language_reader"] {
            let input = varin_runtime::catalog::dispatch::DispatchInput {
                task: "Inspect the original source".into(),
                preset: Some(id.into()),
                work_mode: None,
                tools: None,
            };
            let (resolved, schemas) =
                crate::collaboration::resolve_selection(&selected, &input).unwrap();
            for name in TOOLS {
                let schema = schemas.iter().find(|schema| schema.name == name);
                if id == "custom:language_reader" && !TOOLS[..3].contains(&name) {
                    assert!(
                        schema.is_none(),
                        "an explicit custom tool selection must not gain new defaults"
                    );
                    continue;
                }
                assert!(
                    schema.is_some(),
                    "fixed language is available to the original read-only profile"
                );
                if let Some(schema) = schema {
                    let requirements = schema.requirements.as_ref().unwrap();
                    assert!(requirements.accepts_mode(varin_runtime::SourceMode::Materialized));
                    assert!(requirements.accepts_mode(varin_runtime::SourceMode::FixedBranch));
                    assert_eq!(
                        resolved.profile.work_mode,
                        if id == "retrieval" {
                            varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly
                        } else {
                            varin_runtime::catalog::dispatch::ChildWorkMode::IsolatedWrite
                        }
                    );
                }
            }
            if id == "custom:language_reader" {
                let mut readonly = input;
                readonly.work_mode =
                    Some(varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly);
                assert!(crate::collaboration::resolve_selection(&selected, &readonly).is_ok());
            }
        }
    }

    fn select(&mut self, run: &str, source: &Value) -> (ToolBinding, Value) {
        let thread_id = self
            .f
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .run(run)
            .unwrap()
            .thread_id;
        self.f
            .host
            .send(json!({"kind":"fixture-select","runId":run,"threadId":thread_id,"source":source,
                "expectClean":if source["mode"]=="fixed_branch" { Some(source["revision"]==1) } else { None }}));
        let selected = self.receive("fixture-selected");
        let mut value = json!({"resourceOwner":{"kind":"local"},"grantId":selected["grantId"],"runId":run,"threadId":thread_id,
            "workspaceId":source["workspace_id"],"executionWorkspaceId":source["execution_workspace_id"],
            "sourceMode":source["mode"],"enabledTools":TOOLS});
        let fixed = json!({"branchId":source["branch_id"],"revision":source["revision"]});
        if source["mode"] == "fixed_branch" {
            value["fileSource"] = fixed;
        } else if source["mode"] == "live_root" {
            value["liveRoot"] = source["live_root"].clone();
            value["rootId"] = selected["physicalRoot"]["rootId"].clone();
        } else {
            value["materializedSource"] = fixed;
            value["environmentRunId"] = source["environment_run_id"].clone();
            value["rootId"] = selected["physicalRoot"]["rootId"].clone();
        }
        (serde_json::from_value(value).unwrap(), selected)
    }
    fn execute(&mut self, run: &str, source: ToolBinding, observe: bool) -> Vec<Value> {
        self.execute_with_provider(run, source, observe, Arc::new(Script))
    }
    fn execute_with_provider(
        &mut self,
        run: &str,
        source: ToolBinding,
        observe: bool,
        provider: Arc<dyn ModelProvider>,
    ) -> Vec<Value> {
        self.execute_with_policy(run, source, observe, provider, Arc::new(DefaultAgentPolicy))
    }
    fn execute_with_policy(
        &mut self,
        run: &str,
        source: ToolBinding,
        observe: bool,
        provider: Arc<dyn ModelProvider>,
        policy: Arc<dyn AgentPolicy>,
    ) -> Vec<Value> {
        let executor = Arc::new(
            KernelToolExecutor::new(source, self.resource_client.clone())
                .unwrap()
                .with_language(self.language.clone()),
        );
        let handle = self
            .f
            .runtime
            .start(
                run,
                RunStart {
                    binding: binding(&self.f.runtime, run),
                    policy_state: Value::Null,
                    provider,
                    tools: executor,
                    policy,
                    context_preparation: Arc::new(NoopContextPreparation),
                    progress: ProgressSink::default(),
                },
            )
            .unwrap();
        let (send, done) = mpsc::channel();
        if observe {
            let output = self.output.clone();
            let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
            let assembly = crate::run_assembly::RunAssembly {
                runtime: self.f.runtime.clone(),
                resources: self.resource_client.clone(),
                credentials: credentials.clone(),
                language: self.language.clone(),
                retrieval: crate::retrieval::RetrievalBridge::new(output.clone()),
                memory: crate::host_query::OwnerChannel::new("memory", output.clone()),
                context: crate::host_query::OwnerChannel::new("context", output.clone()),
                resource: crate::host_query::OwnerChannel::new("resource", output.clone()),
                plan: crate::plan_bridge::PlanBridge::new(output.clone()),
                policy: crate::policy::PolicyBridge::new(output.clone()),
                models: crate::run_models::RunModels::new(self.f.runtime.catalog(), credentials),
                tools: crate::run_tools::RunTools::new(
                    self.f.runtime.catalog(),
                    self.f.bridge.clone(),
                ),
                responses: output.into(),
                epoch: EPOCH.into(),
            };
            assembly.observe_completion(handle);
        } else {
            thread::spawn(move || send.send(handle.wait()).unwrap());
        }
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            assert!(
                Instant::now() < deadline,
                "actual TypeScript Run must complete"
            );
            if let Ok(report) = done.try_recv() {
                assert_eq!(report.unwrap().state, RunState::Completed);
                break;
            }
            if let Some(frame) = self.pump() {
                if observe && frame["kind"] == "fixture-run-released" && frame["runId"] == run {
                    assert_eq!(
                        self.f
                            .runtime
                            .catalog()
                            .lock()
                            .unwrap()
                            .run(run)
                            .unwrap()
                            .state,
                        RunState::Completed
                    );
                    break;
                }
                panic!("unexpected language fixture frame: {frame}");
            }
        }
        let owner = self.f.runtime.catalog();
        let db = owner.lock().unwrap();
        db.execution_history(&db.run(run).unwrap().branch_id)
            .unwrap()
            .iter()
            .filter_map(|item| match &item.content {
                Content::ToolResult { result }
                    if result.call_id.starts_with(&format!("{run}:language-")) =>
                {
                    match &result.completion {
                        ToolCompletion::Result {
                            outcome, content, ..
                        } => {
                            assert_eq!(*outcome, Outcome::Succeeded, "{result:?}");
                            Some(content.data.clone())
                        }
                        _ => panic!("finite native language result required"),
                    }
                }
                _ => None,
            })
            .collect()
    }
    fn root_idle(&self, binding: &ToolBinding) -> bool {
        let mut storage = self.f.storage.lock().unwrap();
        let params =
            json!({"workspaceId":binding.workspace_id,"rootId":binding.root_id,"path":"main.ts"});
        let (grant, _) = storage
            .authorize(
                Some(&binding.grant_id),
                EPOCH,
                HOST,
                GENERATION,
                "file.read.check",
                &params,
            )
            .unwrap();
        storage.require_child_root_idle(binding, &grant).unwrap()["writerStopped"]
            .as_bool()
            .unwrap()
    }
}
impl Drop for Review {
    fn drop(&mut self) {
        self.language.close();
        if let Err(error) = self
            .f
            .storage
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .shutdown_processes()
        {
            eprintln!("Language fixture process cleanup failed: {error}");
        }
    }
}
fn enabled() -> BTreeSet<ToolKind> {
    [
        ToolKind::LanguageDefinition,
        ToolKind::LanguageReferences,
        ToolKind::LanguageDiagnostics,
        ToolKind::LanguageHover,
        ToolKind::LanguageSymbols,
        ToolKind::LanguageDocumentSymbols,
        ToolKind::LanguageCallHierarchy,
    ]
    .into_iter()
    .collect()
}
fn assert_results(results: &[Value], selected: &Value, source: &Value, changed: bool) {
    assert_eq!(results.len(), SCRIPT_CALLS);
    for (index, result) in results.iter().enumerate() {
        assert_eq!(result["source"]["selection"], *source, "{result}");
        assert_eq!(result["source"]["physicalRoot"], selected["physicalRoot"]);
        assert_eq!(
            result["source"]["revision"],
            selected["revisions"][if index >= 8 { "util.ts" } else { "main.ts" }]
        );
        assert_eq!(
            result["source"]["dependencies"],
            json!({"source":if source["mode"] == "fixed_branch" {"fixed_branch"} else {"live"}, "external":"provider_environment"})
        );
        assert_eq!(result["source"]["providerId"], "varin.typescript-language");
        assert!(result["source"]["view"]
            .as_str()
            .unwrap()
            .starts_with("agent:source:"));
    }
    let first = &results[0];
    assert_eq!(first["status"], "ready");
    let location = &first["items"][0];
    let first_path = location["resource"]["resourceId"].as_str().unwrap();
    assert!(matches!(first_path, "main.ts" | "util.ts"), "{first}");
    if first_path == "main.ts" {
        // TypeScript can initially report the local import alias while loading its project.
        // Preserve that finite answer in history rather than replacing it with prewarmed data.
        assert_eq!(
            location["targetSelectionRange"]["start"],
            json!({"line":0,"character":9})
        );
        assert_eq!(location["rangeRevision"], selected["revisions"]["main.ts"]);
    }
    let diagnostic = &results[1];
    assert_eq!(
        diagnostic["status"], "pending",
        "unversioned push cannot certify clean"
    );
    assert_eq!(diagnostic["diagnosticVerification"], "unversioned");
    let diagnostics = diagnostic["items"].as_array().unwrap();
    if changed {
        assert!(diagnostics.is_empty());
    } else {
        assert!(diagnostics
            .iter()
            .any(|item| item["code"] == 2322 && item["rangeRevision"].is_null()));
    }
    let relative = &results[2];
    assert_eq!(relative["status"], "ready", "{relative}");
    assert_eq!(relative["items"][0]["resource"]["resourceId"], "util.ts");
    assert_eq!(
        relative["items"][0]["targetSelectionRange"]["start"]["line"],
        if changed { 3 } else { 1 }
    );
    assert_eq!(
        relative["items"][0]["observedRevision"],
        selected["revisions"]["util.ts"]
    );
    assert!(relative["items"][0]["rangeRevision"].is_null());
    let alias = &results[3];
    assert_eq!(alias["status"], "ready", "{alias}");
    assert_eq!(
        alias["items"][0]["resource"]["resourceId"], "src/shared.ts",
        "extends and paths must resolve inside B"
    );
    assert_eq!(
        alias["items"][0]["targetSelectionRange"]["start"]["line"],
        1
    );
    assert_eq!(results[4]["status"], "ready");
    assert!(results[4]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["resource"]["resourceId"] == "main.ts"
            && item["range"]["start"]["line"] == 3
            && item["rangeRevision"] == selected["revisions"]["main.ts"]));
    assert_rich_results(&results[5..], selected, changed);
}
fn assert_rich_results(results: &[Value], selected: &Value, changed: bool) {
    assert_eq!(results.len(), 5);
    for result in results {
        assert_eq!(result["status"], "ready", "{result}");
    }
    let hover = &results[0]["items"];
    assert_eq!(hover.as_array().unwrap().len(), 1, "{hover}");
    let contents = hover[0]["contents"].as_array().unwrap();
    let text = contents
        .iter()
        .map(|part| part["value"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("greet"), "{text}");
    assert!(
        text.contains(if changed { "): number" } else { "): string" }),
        "{text}"
    );
    assert_eq!(hover[0]["resource"]["resourceId"], "main.ts");
    assert_eq!(
        hover[0]["observedRevision"],
        selected["revisions"]["main.ts"]
    );

    let symbols = results[1]["items"].as_array().unwrap();
    let greet = symbols
        .iter()
        .find(|item| item["name"] == "greet")
        .expect("real workspace symbol in the captured dependency");
    assert_eq!(greet["resource"]["resourceId"], "util.ts");
    assert_eq!(greet["range"]["start"]["line"], if changed { 3 } else { 1 });
    assert_eq!(greet["observedRevision"], selected["revisions"]["util.ts"]);
    assert!(greet["rangeRevision"].is_null());

    let document = results[2]["items"].as_array().unwrap();
    let shelf = document
        .iter()
        .find(|item| item["name"] == "Shelf")
        .expect("real document namespace symbol");
    let invoke = shelf["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "invoke")
        .expect("real nested function symbol");
    for symbol in [shelf, invoke] {
        assert_eq!(symbol["resource"]["resourceId"], "main.ts");
        assert_eq!(symbol["observedRevision"], selected["revisions"]["main.ts"]);
        assert_eq!(symbol["rangeRevision"], selected["revisions"]["main.ts"]);
    }

    let incoming = results[3]["items"].as_array().unwrap();
    assert!(
        incoming
            .iter()
            .any(|edge| edge["from"]["resource"]["resourceId"] == "main.ts"
                && edge["to"]["resource"]["resourceId"] == "util.ts"
                && edge["fromRanges"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|range| range["start"]["line"] == 3)),
        "{incoming:?}"
    );
    let module = incoming
        .iter()
        .find(|edge| {
            edge["fromRanges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|range| range["start"]["line"] == 3)
        })
        .unwrap();
    // This real TypeScript response ends its module at character 2 on the
    // final `}` line of length 1. LSP interprets that column as end-of-line.
    assert_eq!(
        module["from"]["range"]["end"],
        json!({"line":6,"character":1})
    );
    for edge in incoming {
        assert_eq!(
            edge["from"]["observedRevision"],
            selected["revisions"][edge["from"]["resource"]["resourceId"].as_str().unwrap()]
        );
        assert_eq!(
            edge["to"]["observedRevision"],
            selected["revisions"]["util.ts"]
        );
        assert_eq!(
            edge["to"]["rangeRevision"],
            selected["revisions"]["util.ts"]
        );
    }
    let outgoing = results[4]["items"].as_array().unwrap();
    if changed {
        assert!(
            outgoing.is_empty(),
            "the changed implementation has no function call: {outgoing:?}"
        );
    } else {
        let edge = outgoing
            .iter()
            .find(|edge| edge["to"]["name"] == "decorate")
            .expect("original dependency calls decorate");
        // Sites belong to the actual caller function, not an arbitrary target.
        assert_eq!(edge["from"]["resource"]["resourceId"], "util.ts");
        assert_eq!(edge["from"]["name"], "greet");
        assert_eq!(
            edge["from"]["observedRevision"],
            selected["revisions"]["util.ts"]
        );
        assert_eq!(
            edge["to"]["observedRevision"],
            selected["revisions"]["util.ts"]
        );
        assert!(edge["fromRanges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|range| range["start"]["line"] == 1));
        assert_eq!(
            edge["from"]["rangeRevision"],
            selected["revisions"]["util.ts"]
        );
    }
}

#[test]
#[ignore = "requires installed bundled TypeScript and fresh Rust process worker; stdio only, no listener or external provider"]
fn materialized_typescript_dependencies_history_and_shared_process_stop_survive_reopen() {
    let root = std::env::temp_dir().join(format!("varin-language-source-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut review = Review::open(&root);
    review.f.host.send(json!({"kind":"fixture-initialize","root":root,"storageRoot":review.f.storage_root,"epoch":EPOCH}));
    let prepared = review.receive("fixture-prepared");
    review.child_catalog = Some(serde_json::from_value(prepared["childCatalog"].clone()).unwrap());
    review.child_model = Some(serde_json::from_value(prepared["parent"].clone()).unwrap());
    let mut source = prepared["source"].clone();
    // Normalize through the actual durable source shape, including nullable environment identity.
    source = serde_json::to_value(
        serde_json::from_value::<varin_runtime::catalog::launches::SourceSelection>(source)
            .unwrap(),
    )
    .unwrap();
    let first = review.admit(source.clone(), "first-language-input");
    review.freeze_child_directory(&first);
    let (first_binding, first_selected) = review.select(&first, &source);
    let initial = review.execute(&first, first_binding.clone(), false);
    assert_results(&initial, &first_selected, &source, false);
    assert!(
        !review.root_idle(&first_binding),
        "completed language RPC/Run does not mean the actual LSP tree stopped"
    );
    let mut inherited = source.clone();
    inherited["environment_run_id"] = json!(first);
    let second = review.admit(inherited.clone(), "second-language-input");
    let (second_binding, second_selected) = review.select(&second, &inherited);
    assert_eq!(
        second_selected["physicalRoot"], first_selected["physicalRoot"],
        "environmentRunId must reopen the original working directory"
    );
    // The second Run takes a real view reference before the first grant is retired.
    // These two direct fixture Runs deliberately retain their source references. The final
    // Run below uses the production completion observer; ordinary sequential Runs may stop/restart.
    let shared = review.execute(&second, second_binding.clone(), false);
    assert_results(&shared, &second_selected, &inherited, false);
    assert_eq!(
        initial[0]["source"]["generation"],
        shared[0]["source"]["generation"]
    );
    assert_eq!(initial[0]["source"]["view"], shared[0]["source"]["view"]);
    review
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":first_binding.grant_id}));
    let released = review.receive("fixture-released");
    assert_eq!(released["processSpawns"], 1);
    assert!(
        !review.root_idle(&second_binding),
        "one surviving original grant keeps the shared server alive"
    );
    review.f.host.send(json!({"kind":"fixture-change-import"}));
    let changed = review.receive("fixture-changed");
    assert_eq!(changed["processSpawns"], 1);
    let third = review.admit(inherited.clone(), "changed-import-input");
    let (third_binding, third_selected) = review.select(&third, &inherited);
    let updated = review.execute(&third, third_binding.clone(), true);
    assert_results(&updated, &third_selected, &inherited, true);
    assert_eq!(
        updated[0]["source"]["generation"],
        initial[0]["source"]["generation"]
    );
    assert_eq!(
        third_selected["revisions"]["main.ts"], first_selected["revisions"]["main.ts"],
        "dependency change must not invent a queried-body revision"
    );
    review
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":second_binding.grant_id}));
    review.receive("fixture-released");
    // Keep a read-only audit handle while the final source permit is withdrawn.
    let audit = {
        let mut storage = review.f.storage.lock().unwrap();
        storage.issue_grant(&json!({"grantId":"language-stop-audit","hostGeneration":GENERATION,"owningWorkspace":third_binding.workspace_id,
            "executionWorkspace":third_binding.execution_workspace_id,"capabilities":["storage.read"],"pathScopes":[""]}), HOST, GENERATION,
            &review.f.storage_root.to_string_lossy(), EPOCH).unwrap();
        let mut audit = third_binding.clone();
        audit.grant_id = "language-stop-audit".into();
        audit
    };
    review
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":third_binding.grant_id}));
    let stopped = review.receive("fixture-released");
    assert_eq!(stopped["processSpawns"], 1);
    // Revocation closes admission immediately; its ACK alone is not a process-stop receipt.
    // The original child settlement consumer explicitly drains the same language owner first.
    let stopped_at_revoke = review.root_idle(&audit);
    review
        .f
        .host
        .send(json!({"kind":"fixture-drain","runId":third}));
    review.receive("fixture-drained");
    assert!(
        review.root_idle(&audit),
        "language drain must await the actual tree before child root freeze"
    );
    eprintln!(
        "language revocation ACK writerStopped={stopped_at_revoke}; explicit drain writerStopped=true"
    );
    review.f.host.send(json!({"kind":"fixture-finish"}));
    let finished = review.receive("fixture-finished");
    assert_eq!(finished["processSpawns"], 1);
    assert_eq!(finished["sourceQueries"], 3 * SCRIPT_CALLS);
    let history = review
        .f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .execution_history(BRANCH)
        .unwrap();
    let storage_root = review.f.storage_root.clone();
    let physical = PathBuf::from(
        third_selected["physicalRoot"]["canonicalRoot"]
            .as_str()
            .unwrap(),
    );
    drop(review);
    let reopened = Catalog::open(root.join("catalog")).unwrap();
    assert_eq!(reopened.execution_history(BRANCH).unwrap(), history);
    let mut reopened_storage = Storage::open(&storage_root, HOST).unwrap();
    let params = json!({"grantId":"language-reopen-audit","hostGeneration":GENERATION,"owningWorkspace":audit.workspace_id,
        "executionWorkspace":audit.execution_workspace_id,"capabilities":["storage.read"],"pathScopes":[""]});
    reopened_storage
        .issue_grant(
            &params,
            HOST,
            GENERATION,
            &storage_root.to_string_lossy(),
            "reopened-language",
        )
        .unwrap();
    let read = json!({"branchId":"source:language","revision":0,"includeEntries":false});
    let (grant, read) = reopened_storage
        .authorize(
            Some("language-reopen-audit"),
            "reopened-language",
            HOST,
            GENERATION,
            "branch.read",
            &read,
        )
        .unwrap();
    let retained = reopened_storage
        .dispatch("branch.read", &read, Some("language-reopen-audit"), &grant)
        .unwrap();
    assert_eq!(retained["revision"], 0);
    assert!(std::fs::read_to_string(physical.join("main.ts"))
        .unwrap()
        .contains("MATERIALIZED_WORKING_B"));
    assert!(std::fs::read_to_string(physical.join("util.ts"))
        .unwrap()
        .contains("name.length"));
    drop(reopened_storage);
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires installed bundled TypeScript and fresh Rust process worker; stdio only, no listener or external provider"]
fn fixed_typescript_project_revisions_share_only_their_view_and_query_again_after_reopen() {
    let root = std::env::temp_dir().join(format!(
        "varin-fixed-language-source-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let mut review = Review::open(&root);
    let source = review.initialize(&root, "fixed_branch", false);
    assert_eq!(source["mode"], "fixed_branch");
    let first = review.admit(source.clone(), "fixed-first");
    review.freeze_child_directory(&first);
    let (first_binding, first_selected) = review.select(&first, &source);
    assert!(first_selected["physicalRoot"].is_null());
    let initial = review.execute(&first, first_binding.clone(), false);
    assert_results(&initial, &first_selected, &source, false);
    let original_view = initial[0]["source"]["derivedView"].clone();
    let original_root = PathBuf::from(original_view["canonicalRoot"].as_str().unwrap());
    assert!(original_root.is_dir());
    assert_eq!(original_view["branchId"], source["branch_id"]);
    assert_eq!(original_view["revision"], 0);

    // The live workspace disagreed before preparation and changes again afterward.
    // Neither action may alter the captured project's relative imports/config/paths.
    review.f.host.send(json!({"kind":"fixture-live-change"}));
    review.receive("fixture-live-changed");
    let second = review.admit(source.clone(), "fixed-second");
    let (second_binding, second_selected) = review.select(&second, &source);
    let shared = review.execute(&second, second_binding.clone(), false);
    assert_results(&shared, &second_selected, &source, false);
    assert_eq!(shared[0]["source"]["derivedView"], original_view);
    assert_eq!(shared[0]["source"]["view"], initial[0]["source"]["view"]);
    assert_eq!(
        shared[0]["source"]["generation"],
        initial[0]["source"]["generation"]
    );

    // Commit a genuinely different immutable revision through the original branch
    // writer. The first view stays alive and cannot be silently retargeted.
    review.f.host.send(json!({"kind":"fixture-next-revision"}));
    let next = review.receive("fixture-next-revision");
    let next_source = serde_json::to_value(
        serde_json::from_value::<varin_runtime::catalog::launches::SourceSelection>(
            next["source"].clone(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(next_source["revision"], 1);
    let third = review.admit(next_source.clone(), "fixed-next-revision");
    let (third_binding, third_selected) = review.select(&third, &next_source);
    let changed = review.execute(&third, third_binding.clone(), false);
    assert_results(&changed, &third_selected, &next_source, true);
    let next_view = changed[0]["source"]["derivedView"].clone();
    let next_root = PathBuf::from(next_view["canonicalRoot"].as_str().unwrap());
    assert_ne!(next_view["viewId"], original_view["viewId"]);
    assert_ne!(next_view["sourceRoot"], original_view["sourceRoot"]);
    assert_ne!(next_root, original_root);
    assert_eq!(
        third_selected["revisions"]["main.ts"],
        first_selected["revisions"]["main.ts"]
    );
    assert!(std::fs::read_to_string(original_root.join("util.ts"))
        .unwrap()
        .contains("\"B \" + name"));
    assert!(std::fs::read_to_string(next_root.join("util.ts"))
        .unwrap()
        .contains("name.length"));

    review
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":first_binding.grant_id}));
    let one_released = review.receive("fixture-released");
    assert_eq!(one_released["processSpawns"], 2);
    assert!(
        original_root.is_dir(),
        "the second retained Run still owns the original view"
    );
    review
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":second_binding.grant_id}));
    review.receive("fixture-released");
    review
        .f
        .host
        .send(json!({"kind":"fixture-drain","runId":second}));
    review.receive("fixture-drained");
    assert!(
        !original_root.exists(),
        "only actual source drain permits physical cleanup"
    );
    assert!(
        next_root.is_dir(),
        "retiring revision zero must not release revision one"
    );
    review
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":third_binding.grant_id}));
    review.receive("fixture-released");
    review
        .f
        .host
        .send(json!({"kind":"fixture-drain","runId":third}));
    review.receive("fixture-drained");
    assert!(!next_root.exists());
    review.f.host.send(json!({"kind":"fixture-gc"}));
    review.receive("fixture-gc-finished");
    review.f.host.send(json!({"kind":"fixture-finish"}));
    let finished = review.receive("fixture-finished");
    assert_eq!(finished["processSpawns"], 2);
    assert_eq!(finished["sourceQueries"], 3 * SCRIPT_CALLS);
    let history = review
        .f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .execution_history(BRANCH)
        .unwrap();
    drop(review);

    // Both authority stores and the Host process are newly opened. The fixture's
    // transport epoch string is intentionally constant; this is fresh-query/reopen
    // evidence, not evidence of obsolete-epoch cleanup (covered by Storage tests).
    let mut reopened = Review::open(&root);
    assert_eq!(
        reopened
            .f
            .runtime
            .catalog()
            .lock()
            .unwrap()
            .execution_history(BRANCH)
            .unwrap(),
        history
    );
    let reopened_source = reopened.initialize(&root, "fixed_branch", true);
    assert_eq!(reopened_source, source);
    reopened.f.host.send(json!({"kind":"fixture-gc"}));
    reopened.receive("fixture-gc-finished");
    let fourth = reopened.admit(reopened_source.clone(), "fixed-reopened-query");
    let (fourth_binding, fourth_selected) = reopened.select(&fourth, &reopened_source);
    let restored = reopened.execute(&fourth, fourth_binding.clone(), true);
    assert_results(&restored, &fourth_selected, &source, false);
    let restored_view = &restored[0]["source"]["derivedView"];
    assert_ne!(restored_view["viewId"], original_view["viewId"]);
    assert_eq!(restored_view["sourceRoot"], original_view["sourceRoot"]);
    reopened
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":fourth_binding.grant_id}));
    reopened.receive("fixture-released");
    reopened
        .f
        .host
        .send(json!({"kind":"fixture-drain","runId":fourth}));
    reopened.receive("fixture-drained");
    assert!(!PathBuf::from(restored_view["canonicalRoot"].as_str().unwrap()).exists());
    reopened.f.host.send(json!({"kind":"fixture-finish"}));
    let finished = reopened.receive("fixture-finished");
    assert_eq!(finished["processSpawns"], 1);
    assert_eq!(finished["sourceQueries"], SCRIPT_CALLS);
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires bundled TypeScript and fresh Rust process worker; original live source over stdio"]
fn live_typescript_rich_queries_keep_the_original_root_and_history_after_drain() {
    let root = std::env::temp_dir().join(format!("varin-live-language-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut review = Review::open(&root);
    let source = review.initialize(&root, "live_root", false);
    assert_eq!(source["mode"], "live_root");
    assert!(source["branch_id"].is_null());
    let run = review.admit(source.clone(), "live-rich-language");
    let (binding, selected) = review.select(&run, &source);
    let results = review.execute(&run, binding.clone(), true);
    assert_results(&results, &selected, &source, false);
    assert!(results
        .iter()
        .all(|result| result["source"].get("derivedView").is_none()));
    review
        .f
        .host
        .send(json!({"kind":"fixture-drain","runId":run}));
    review.receive("fixture-drained");
    assert!(
        review.root_idle(&binding),
        "the original live process writer really stopped"
    );
    assert!(
        root.join("workspace/main.ts").is_file(),
        "live project is not a disposable derived view"
    );
    let owner = review.f.runtime.catalog();
    let history = owner.lock().unwrap().execution_history(BRANCH).unwrap();
    let collection = owner
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    review
        .f
        .host
        .send(json!({"kind":"fixture-release","grantId":binding.grant_id}));
    review.receive("fixture-released");
    review.f.host.send(json!({"kind":"fixture-gc"}));
    review.receive("fixture-gc-finished");
    review.f.host.send(json!({"kind":"fixture-finish"}));
    let finished = review.receive("fixture-finished");
    assert_eq!(finished["sourceQueries"], SCRIPT_CALLS);
    assert_eq!(finished["processSpawns"], 1);
    drop(owner);
    drop(review);
    let catalog = Catalog::open(root.join("catalog")).unwrap();
    assert_eq!(catalog.execution_history(BRANCH).unwrap(), history);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}
