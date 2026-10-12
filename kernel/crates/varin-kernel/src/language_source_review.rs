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
const THREAD: &str = "thread:language";
const BRANCH: &str = "branch:language";
const TOOLS: [&str; 3] = [
    "language_definition",
    "language_references",
    "language_diagnostics",
];

struct Script;
impl ModelProvider for Script {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        // Use the ordinary provider serialization too, without an external HTTP request.
        use varin_runtime::providers::{
            Connection, EnvironmentCredentialResolver, ReqwestTransport,
        };
        varin_runtime::providers::responses::ResponsesProvider::new(Connection::new(
            "https://controlled.invalid/responses",
            Arc::new(EnvironmentCredentialResolver::default()),
            Arc::new(ReqwestTransport::default()),
        ))
        .serialize(view)
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
        ];
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
                host: Host::with_script(
                    "packages/web/application-host/lib/kernel/language-source-host.test-helper.ts",
                ),
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
                assert_eq!(
                    schema.is_some(),
                    id != "retrieval",
                    "read-only default must remain usable"
                );
                if let Some(schema) = schema {
                    let requirements = schema.requirements.as_ref().unwrap();
                    assert!(requirements.accepts_mode(varin_runtime::SourceMode::Materialized));
                    assert!(!requirements.accepts_mode(varin_runtime::SourceMode::FixedBranch));
                    assert_eq!(
                        resolved.profile.work_mode,
                        varin_runtime::catalog::dispatch::ChildWorkMode::IsolatedWrite
                    );
                }
            }
            if id == "custom:language_reader" {
                let mut readonly = input;
                readonly.work_mode =
                    Some(varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly);
                assert!(crate::collaboration::resolve_selection(&selected, &readonly).is_err());
            }
        }
    }

    fn select(&mut self, run: &str, source: &Value) -> (ToolBinding, Value) {
        self.f
            .host
            .send(json!({"kind":"fixture-select","runId":run,"source":source}));
        let selected = self.receive("fixture-selected");
        let value = json!({"grantId":selected["grantId"],"runId":run,"threadId":THREAD,
            "workspaceId":source["workspace_id"],"executionWorkspaceId":source["execution_workspace_id"],
            "sourceMode":"materialized","materializedSource":{"branchId":source["branch_id"],"revision":source["revision"]},
            "environmentRunId":source["environment_run_id"],"rootId":selected["physicalRoot"]["rootId"],"enabledTools":TOOLS});
        (serde_json::from_value(value).unwrap(), selected)
    }
    fn execute(&mut self, run: &str, source: ToolBinding, observe: bool) -> Vec<Value> {
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
                    provider: Arc::new(Script),
                    tools: executor,
                    policy: Arc::new(DefaultAgentPolicy),
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
        db.execution_history(BRANCH)
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
    ]
    .into_iter()
    .collect()
}
fn assert_results(results: &[Value], selected: &Value, source: &Value, changed: bool) {
    assert_eq!(results.len(), 5);
    for result in results {
        assert_eq!(result["source"]["selection"], *source, "{result}");
        assert_eq!(result["source"]["physicalRoot"], selected["physicalRoot"]);
        assert_eq!(
            result["source"]["revision"],
            selected["revisions"]["main.ts"]
        );
        assert_eq!(result["source"]["dependencies"], "live");
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
    assert_eq!(finished["sourceQueries"], 15);
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
