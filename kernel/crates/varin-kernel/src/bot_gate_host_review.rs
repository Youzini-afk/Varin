//! Original BotService gate writes and same-Host scoped-grant epoch invalidation.
use super::web_domain_review::{EPOCH, Fixture, HOST, Host};
use super::*;
use crate::host_tools::ToolBridge;
use crate::storage::Storage;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
fn receive(f: &mut Fixture, epoch: &str, kind: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "Bot gate Host did not settle");
        if let Some(frame) = f.pump_epoch(epoch) {
            assert_eq!(frame["kind"], kind, "{frame}");
            return frame;
        }
    }
}
#[test]
fn bot_service_publishes_original_lifecycle_and_refreshes_same_instance_grant_after_epoch_loss() {
    let root = std::env::temp_dir().join(format!("varin-bot-gate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let catalog_root = root.join("catalog");
    let storage_root = root.join("storage");
    let runtime = Arc::new(RunSupervisor::new(Catalog::open(&catalog_root).unwrap()));
    let (send, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(send.into());
    bridge.initialize(EPOCH);
    let mut f = Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/bot-gate-host.test-helper.ts",
        ),
        runtime,
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge,
        outgoing,
    };
    f.host.send(
        json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"storageRoot":storage_root}),
    );
    let first = receive(&mut f, EPOCH, "fixture-prepared");
    let bot = first["bot"]["id"].as_str().unwrap().to_string();
    f.runtime
        .catalog()
        .lock()
        .unwrap()
        .create_bot_thread("bot-main", "main", &bot)
        .unwrap();
    f.host.send(json!({"kind":"fixture-sleep"}));
    receive(&mut f, EPOCH, "fixture-stop-entered");
    assert!(
        f.runtime
            .catalog()
            .lock()
            .unwrap()
            .create_bot_thread("sleep-blocked", "sleep-blocked", &bot)
            .is_err()
    );
    f.host.send(json!({"kind":"fixture-release-stop"}));
    receive(&mut f, EPOCH, "fixture-asleep");
    f.host.send(json!({"kind":"fixture-wake"}));
    receive(&mut f, EPOCH, "fixture-awake");
    f.runtime
        .catalog()
        .lock()
        .unwrap()
        .create_bot_thread("wake-open", "wake-open", &bot)
        .unwrap();
    f.host.send(json!({"kind":"fixture-preparation-drain"}));
    receive(&mut f, EPOCH, "fixture-preparation-drained");
    f.runtime.shutdown().unwrap();
    let old = std::mem::replace(
        &mut f.runtime,
        Arc::new(RunSupervisor::new(
            Catalog::open(root.join("replacement")).unwrap(),
        )),
    );
    drop(old);
    f.runtime = Arc::new(RunSupervisor::new(Catalog::open(&catalog_root).unwrap()));
    assert!(
        f.runtime
            .catalog()
            .lock()
            .unwrap()
            .create_bot_thread("epoch-blocked", "epoch-blocked", &bot)
            .is_err()
    );
    let second = "bot-gate-second-epoch";
    f.host
        .send(json!({"kind":"fixture-reset-epoch","epoch":second}));
    let restored = receive(&mut f, second, "fixture-republished");
    assert_eq!(restored["bot"]["id"], bot);
    assert_eq!(
        restored["bot"]["entry"],
        json!({"runtime":"pi","sessionId":null})
    );
    f.runtime
        .catalog()
        .lock()
        .unwrap()
        .create_bot_thread("epoch-open", "epoch-open", &bot)
        .unwrap();
    f.host.send(json!({"kind":"fixture-close"}));
    receive(&mut f, second, "fixture-closed");
    f.runtime.shutdown().unwrap();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

/// The unchanged stdio fixture delegates only these additional original production owners.
fn receive_native_lifecycle(f: &mut Fixture, kind: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    let runtime = f.runtime.clone();
    let bridge = f.bridge.clone();
    loop {
        assert!(
            Instant::now() < deadline,
            "Native Bot lifecycle did not settle"
        );
        let frame = f.pump_dispatch(
            |frame| {
                let method = frame["method"].as_str().unwrap();
                let params = frame["params"].clone();
                let owner = runtime.catalog();
                match method {
                    "runtime.bot.scope.inspect" | "runtime.bot.thread.create" => {
                        Some(dispatch(&mut owner.lock().unwrap(), method, params))
                    }
                    "runtime.bot.scope.suspend" => Some((|| {
                        // This fixture owns no process operation; the original Supervisor performs the hold and joins.
                        assert!(
                            owner
                                .lock()
                                .unwrap()
                                .pending_managed_processes()
                                .map_err(domain)?
                                .is_empty()
                        );
                        let capture = runtime
                            .suspend_bot_scope(serde_json::from_value(params)?)
                            .map_err(|e| KernelError::Operation(e.to_string()))?;
                        Ok(serde_json::to_value(
                            runtime
                                .drain_bot_scope(&capture)
                                .map_err(|e| KernelError::Operation(e.to_string()))?,
                        )?)
                    })()),
                    "runtime.bot.scope.status" | "runtime.bot.scope.resume" => {
                        let (sender, _) = mpsc::sync_channel(16);
                        let controls = control_commands::ControlCommands {
                            runtime: runtime.clone(),
                            resources: crate::tools::KernelResourceClient::new(
                                |_| {
                                    Err(KernelError::Operation(
                                        "unrequested resource effect".into(),
                                    ))
                                },
                                |_| Ok(()),
                                Default::default(),
                            ),
                            models: crate::run_models::RunModels::new(
                                owner.clone(),
                                crate::credential_bridge::CredentialBridge::new(sender),
                            ),
                            tools: crate::run_tools::RunTools::new(owner, bridge.clone()),
                        };
                        Some(controls.execute(method, params, &AtomicBool::new(false)))
                    }
                    "runtime.memory.reconcile" | "runtime.plan.reconcile" => Some((|| {
                        let (sender, receiver) = mpsc::sync_channel(16);
                        let id = frame["id"].as_str().unwrap().to_owned();
                        let run = params["runId"].as_str().unwrap().to_owned();
                        if method == "runtime.memory.reconcile" {
                            let channel =
                                crate::host_query::OwnerChannel::new("memory", sender.clone());
                            crate::memory::reconcile(
                                runtime.clone(),
                                channel,
                                run,
                                id,
                                sender.into(),
                                Arc::new(|_| {}),
                            )?;
                        } else {
                            let channel = crate::plan_bridge::PlanBridge::new(sender.clone());
                            crate::plan::reconcile(
                                runtime.clone(),
                                channel,
                                run,
                                id,
                                sender.into(),
                                Arc::new(|_| {}),
                            )?;
                        }
                        let reply = receiver
                            .recv_timeout(Duration::from_secs(5))
                            .expect("Original empty domain reconciliation must settle");
                        assert_eq!(reply["ok"], true, "{reply}");
                        Ok(reply["result"].clone())
                    })(
                    )),
                    _ => None,
                }
            },
            |_, _| true,
        );
        if let Some(frame) = frame {
            assert_eq!(frame["kind"], kind, "{frame}");
            return frame;
        }
    }
}

#[test]
fn product_bot_wake_keeps_manual_pause_and_untriggered_wait_at_the_original_host_launch_gate() {
    use varin_runtime::execution::*;
    use varin_runtime::{RunState, SubmitInput};
    let root =
        std::env::temp_dir().join(format!("varin-bot-wake-consumer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let storage_root = root.join("storage");
    let runtime = Arc::new(RunSupervisor::new(
        Catalog::open(root.join("catalog")).unwrap(),
    ));
    let (send, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(send.into());
    bridge.initialize(EPOCH);
    let mut f = Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/bot-gate-host.test-helper.ts",
        ),
        runtime,
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge,
        outgoing,
    };
    f.host.send(json!({"kind":"fixture-initialize","nativeWake":true,"epoch":EPOCH,"root":root,"storageRoot":storage_root}));
    let first = receive_native_lifecycle(&mut f, "fixture-prepared");
    let bot = first["bot"]["id"].as_str().unwrap();
    let entry = &first["bot"]["entry"];
    let mut original = Vec::new();
    {
        let owner = f.runtime.catalog();
        let mut db = owner.lock().unwrap();
        for (name, thread, branch) in [
            (
                "pause",
                entry["threadId"].as_str().unwrap(),
                entry["branchId"].as_str().unwrap(),
            ),
            ("wait", "thread:bot-wait", "branch:bot-wait"),
        ] {
            db.create_bot_thread(thread, branch, bot).unwrap();
            let prepared = db
                .prepare_submission(
                    SubmitInput {
                        key: format!("input:{name}"),
                        thread_id: thread.into(),
                        branch_id: branch.into(),
                        expected_head: None,
                        input: json!({"text":name}),
                        configuration: json!({}),
                    },
                    None,
                    None,
                )
                .unwrap()
                .load(None, false)
                .unwrap();
            let receipt = db.admit_submission(prepared).unwrap();
            let binding:RequestBinding = serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"review","provider_family":"review","model":"review","credential_ref":null,"configuration_generation":1,"tool_schema_generation":0,"tools":[],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":branch,"ancestor_id":null,"leaf_id":receipt.input_id}})).unwrap();
            db.select_launch(
                &receipt.run_id,
                varin_runtime::catalog::launches::LaunchSelection::from_binding(
                    &binding,
                    DefaultAgentPolicy.identity(),
                    None,
                ),
            )
            .unwrap();
            let epoch = db.epoch();
            let wait_id = if name == "pause" {
                let boundary = db.policy_boundary(&receipt.run_id, epoch).unwrap();
                let intent = PolicyControlIntent {
                    action_id: format!("{}:policy:{}", receipt.run_id, boundary.id),
                    boundary,
                    identity: DefaultAgentPolicy.identity(),
                    state: json!({"original":"paused"}),
                    expected_head: db.head(branch).unwrap(),
                    action: PolicyAction::Pause {
                        reason: "Wait for explicit user resume".into(),
                    },
                };
                let prepared = db.prepare_policy_control().load(&intent).unwrap();
                let PolicyControlReceipt::Paused { wait_id, .. } = db
                    .commit_policy_control(&receipt.run_id, epoch, prepared)
                    .unwrap()
                else {
                    panic!("Original policy pause required")
                };
                wait_id
            } else {
                db.commit_execution(
                    &receipt.run_id,
                    epoch,
                    &ExecutionRecord::StateChanged {
                        state: RunState::Runnable,
                        waiting_on: None,
                    },
                )
                .unwrap();
                let wait = db
                    .register_wait(
                        "original-untriggered-wait",
                        &receipt.run_id,
                        "unready-source",
                        "source.ready",
                        0,
                    )
                    .unwrap();
                db.commit_execution(
                    &receipt.run_id,
                    epoch,
                    &ExecutionRecord::StateChanged {
                        state: RunState::Waiting,
                        waiting_on: Some(wait.id.clone()),
                    },
                )
                .unwrap();
                wait.id
            };
            assert!(
                !db.launch_intent(&receipt.run_id)
                    .unwrap()
                    .unwrap()
                    .startable
            );
            original.push((receipt.run_id, wait_id));
        }
    }
    f.host
        .send(json!({"kind":"fixture-sleep","nativeWake":true}));
    receive_native_lifecycle(&mut f, "fixture-asleep");
    f.host.send(json!({"kind":"fixture-wake"}));
    let awake = receive_native_lifecycle(&mut f, "fixture-awake");
    assert_eq!(awake["bot"]["activity"]["state"], "awake");
    assert_eq!(awake["launchErrors"], json!([]));
    let invoked = awake["continuations"].as_array().unwrap();
    assert_eq!(
        invoked.len(),
        2,
        "both original Host consumers were exercised"
    );
    {
        let owner = f.runtime.catalog();
        let db = owner.lock().unwrap();
        for (run, wait) in &original {
            assert!(invoked.contains(&json!(run)));
            let current = db.run(run).unwrap();
            assert_eq!(current.state, RunState::Waiting);
            assert!(!current.cancel_requested);
            assert_eq!(current.waiting_on.as_deref(), Some(wait.as_str()));
            assert!(!db.launch_intent(run).unwrap().unwrap().startable);
        }
        assert!(db.pending_resumptions().unwrap().is_empty());
    }
    f.host.send(json!({"kind":"fixture-close"}));
    receive(&mut f, EPOCH, "fixture-closed");
    f.runtime.shutdown().unwrap();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[derive(Default)]
struct ProductMemoryModel(Mutex<Vec<RequestSnapshot>>);
impl ModelProvider for ProductMemoryModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let mut seen = self.0.lock().unwrap();
        let step = seen.len();
        seen.push(request.clone());
        let result = |index: usize| {
            request
                .view
                .history
                .iter()
                .find_map(|item| match &item.content {
                    Content::ToolResult { result }
                        if result.call_id == format!("memory-{index}") =>
                    {
                        match &result.completion {
                            ToolCompletion::Result { content, .. } => Some(content.data.clone()),
                            _ => None,
                        }
                    }
                    _ => None,
                })
                .expect("original tool result")
        };
        let expected = |row: &Value| json!({"content":row["content"],"trigger":row["trigger"],"status":row["status"],"invalidAt":row["invalidAt"]});
        let args = match step {
            0 => Some(
                json!({"action":"remember","content":"ORIGINAL recovery evidence","trigger":"recovery evidence","sourceText":"Remember the recovery evidence."}),
            ),
            1 => Some(
                json!({"action":"get","id":result(0)["memoryReceipt"]["result"]["knowledge"]["id"],"includeSource":true}),
            ),
            2 => {
                let row = result(1)["item"].clone();
                Some(
                    json!({"action":"correct","id":row["id"],"expected":expected(&row),"content":"CORRECTED signed recovery evidence","trigger":"recovery evidence","sourceText":"Correct it to the signed recovery evidence when requested."}),
                )
            }
            3 => Some(json!({"action":"get","id":result(2)["memoryReceipt"]["result"]["id"]})),
            4 => {
                let row = result(3)["item"].clone();
                Some(json!({"action":"forget","id":row["id"],"expected":expected(&row)}))
            }
            _ => None,
        };
        let content = args
            .map(|arguments| Content::ToolCall {
                call: ToolCall {
                    call_id: format!("memory-{step}"),
                    name: "memory".into(),
                    schema_version: "bot-1".into(),
                    arguments,
                },
            })
            .unwrap_or(Content::Text {
                text: "Memory verified".into(),
            });
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: format!("response-{step}"),
                content,
                opaque: None,
            },
        })
        .unwrap();
        Ok(if step < 5 {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}

#[test]
fn product_bot_entry_admission_original_history_knowledge_tools_and_actual_model_requests() {
    let root = std::env::temp_dir().join(format!("varin-bot-product-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let storage_root = root.join("storage");
    let runtime = Arc::new(RunSupervisor::new(
        Catalog::open(root.join("catalog")).unwrap(),
    ));
    let (send, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(send.clone().into());
    bridge.initialize(EPOCH);
    let memory = crate::host_query::OwnerChannel::new("memory", send.clone());
    memory.initialize(EPOCH);
    let credentials = crate::credential_bridge::CredentialBridge::new(send.clone());
    credentials.initialize(EPOCH).unwrap();
    let policy = crate::policy::PolicyBridge::new(send.clone());
    policy.initialize(EPOCH); policy.set_catalog(runtime.catalog());
    let plan = crate::plan_bridge::PlanBridge::new(send.clone()); plan.initialize(EPOCH);
    let assembly = crate::run_assembly::RunAssembly {
        runtime: runtime.clone(),
        resources: crate::tools::KernelResourceClient::new(|_|Err(KernelError::Operation("No source in this Bot entry".into())), |_|Ok(()), Default::default()),
        credentials: credentials.clone(), language: crate::language::LanguageBridge::new(send.clone()), retrieval: crate::retrieval::RetrievalBridge::new(send.clone()),
        memory: memory.clone(), context: crate::host_query::OwnerChannel::new("context", send.clone()), resource: crate::host_query::OwnerChannel::new("resource", send.clone()),
        plan, policy, models: crate::run_models::RunModels::new(runtime.catalog(), credentials), tools: crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone()), responses: send.into(), epoch: EPOCH.into(),
    };
    let model = Arc::new(ProductMemoryModel::default());
    let (finished, completion) = mpsc::channel();
    let mut f = Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/bot-gate-host.test-helper.ts",
        ),
        runtime: runtime.clone(),
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge,
        outgoing,
    };
    f.host.send(json!({"kind":"fixture-initialize","nativeMemory":true,"epoch":EPOCH,"root":root,"storageRoot":storage_root}));
    let mut admitted = None;
    let mut prepared = false;
    let mut done = false;
    let deadline = Instant::now() + Duration::from_secs(60);
    while !done {
        assert!(
            Instant::now() < deadline,
            "Product Bot memory chain stalled"
        );
        let owner = runtime.catalog();
        let frame = f.pump_dispatch(|frame| {
            let method = frame["method"].as_str().unwrap(); let params = frame["params"].clone();
            Some((|| -> Result<Value, KernelError> { match method {
                "runtime.input.submit" | "runtime.input.receipt" => input_commands::execute(runtime.clone(), method, params, Arc::new(AtomicBool::new(false)), None),
                "runtime.context.inspect" => { let read = owner.lock().unwrap().capture_active_checkpoint(params["branchId"].as_str().unwrap()).map_err(domain)?; Ok(serde_json::to_value(read.map(|read|read.load()).transpose().map_err(domain)?)?) },
                "runtime.context.refresh" => {
                    let p: ContextRefreshParams = serde_json::from_value(params)?;
                    let basis = personalization_basis(p.context.personalization.unwrap())?;
                    let prepare = owner.lock().unwrap().prepare_personalization_refresh(&p.branch_id, p.expected_revision as u64, p.context.effective_system_prompt, p.context.instruction_sources, p.context.memory_checkpoint.0, basis).map_err(domain)?.require_resources(p.context.resources);
                    let candidate = prepare.load().map_err(domain)?;
                    Ok(serde_json::to_value(owner.lock().unwrap().publish_personalization_refresh(candidate).map_err(domain)?)?)
                },
                "runtime.history.page" => { let p: HistoryPageParams = serde_json::from_value(params)?; let read = owner.lock().unwrap().capture_history_page(&p.branch_id).map_err(domain)?; Ok(serde_json::to_value(read.load(p.head_id.as_deref(), p.before_id.as_deref(), p.limit as u32, &||false).map_err(domain)?)?) },
                "runtime.bot.history.read" => { let p: BotHistoryReadParams = serde_json::from_value(params)?; let read = owner.lock().unwrap().capture_bot_history(&p.bot_id,&p.thread_id,&p.branch_id,&p.head_id,&p.item_id).map_err(domain)?; Ok(serde_json::to_value(read.load(&||false).map_err(domain)?)?) },
                "runtime.child.execution.for_run" => child_commands::execute(runtime.clone(), crate::tools::KernelResourceClient::new(|_|Err(KernelError::Operation("No source in this Bot entry".into())), |_|Ok(()), Default::default()), method, params, &AtomicBool::new(false)),
                "runtime.model.inspect" => Ok(serde_json::to_value(owner.lock().unwrap().model_selections(params["runId"].as_str().unwrap()).map_err(domain)?)?),
                "runtime.launch.inspect" => { let read = owner.lock().unwrap().capture_launch(params["runId"].as_str().unwrap()).map_err(domain)?; Ok(serde_json::to_value(read.map(|read|read.load()).transpose().map_err(domain)?)?) },
                "runtime.memory.reconcile" | "runtime.plan.reconcile" => {
                    let (sender, receiver) = mpsc::sync_channel(16); let id = frame["id"].as_str().unwrap().to_owned(); let run = params["runId"].as_str().unwrap().to_owned();
                    if method == "runtime.memory.reconcile" { crate::memory::reconcile(runtime.clone(), memory.clone(), run, id, sender.into(), Arc::new(|_|{}))?; }
                    else { crate::plan::reconcile(runtime.clone(), crate::plan_bridge::PlanBridge::new(sender.clone()), run, id, sender.into(), Arc::new(|_|{}))?; }
                    let reply = receiver.recv_timeout(Duration::from_secs(5)).unwrap(); assert_eq!(reply["ok"], true, "{reply}"); Ok(reply["result"].clone())
                },
                "runtime.run.start" => {
                    let run_id = params["runId"].as_str().unwrap();
                    let (run, launch) = { let db = owner.lock().unwrap(); (db.run(run_id).map_err(domain)?, db.capture_launch(run_id).map_err(domain)?.unwrap()) };
                    let launch = launch.load().map_err(domain)?;
                    assert!(launch.selection.tools.iter().any(|tool| tool.name == "memory" && tool.version == "bot-1"));
                    assert!(!launch.selection.tools.iter().any(|tool| tool.name == "memory" && tool.version == "1"));
                    let preparation = crate::run_assembly::RunPreparation::new(serde_json::from_value(params.clone())?, &run)?;
                    let crate::run_assembly::PreparedLaunch::Start(mut start) = assembly.prepare(preparation, None, ||false)? else { panic!("original Run launch required"); };
                    // Only generation is controlled. Original assembly owns schema, context,
                    // capabilities, identity, publication and all real Host tool calls.
                    start.provider = model.clone();
                    let handle = runtime.start(run_id, start).map_err(|error|KernelError::Operation(error.to_string()))?; let finished = finished.clone();
                    std::thread::spawn(move || { finished.send(handle.wait()).unwrap(); });
                    Ok(json!({"runId":run_id,"epoch":run.epoch}))
                },
                method if method.starts_with("runtime.") => dispatch(&mut owner.lock().unwrap(), method, params),
                _ => Err(KernelError::Protocol("fixture storage dispatch".into())),
            } })()).filter(|_| method.starts_with("runtime."))
        }, |_,_|true);
        if let Some(frame) = frame {
            match frame["kind"].as_str().unwrap() {
                "memory-response" => memory.receive(frame),
                "fixture-prepared" => {
                    assert!(!prepared);
                    prepared = true;
                    assert_eq!(frame["bot"]["entry"]["runtime"], "agent");
                    f.host.send(json!({"kind":"fixture-product-submit"}));
                }
                "fixture-product-admitted" => admitted = Some(frame["receipt"].clone()),
                other => panic!("Unexpected product frame {other}: {frame}"),
            }
        }
        if let Ok(report) = completion.try_recv() {
            assert_eq!(report.unwrap().state, varin_runtime::RunState::Completed);
            done = true;
        }
    }
    assert!(admitted.is_some());
    let requests = model.0.lock().unwrap();
    assert_eq!(requests.len(), 6);
    assert!(
        serde_json::to_string(&requests[0])
            .unwrap()
            .contains("Original Bot")
    );
    assert!(requests.iter().all(|request| {
        !serde_json::to_string(request)
            .unwrap()
            .contains("OTHER_BOT_SECRET")
    }));
    let facts = |index: usize| {
        serde_json::to_string(&requests[index].view.history.iter().filter(|item| matches!(&item.provenance, Provenance::EnvironmentFact { event_id } if event_id.starts_with("bot-memory:"))).collect::<Vec<_>>()).unwrap()
    };
    assert!(facts(1).contains("ORIGINAL recovery evidence"));
    assert!(facts(3).contains("CORRECTED signed recovery evidence"));
    assert!(
        !facts(5).contains("CORRECTED signed recovery evidence") && facts(5).contains("forgotten")
    );
    assert!(
        serde_json::to_string(&requests[2])
            .unwrap()
            .contains("Remember the recovery evidence."),
        "Original typed source read reaches the get tool result"
    );
    drop(requests);
    f.host.send(json!({"kind":"fixture-close"}));
    receive(&mut f, EPOCH, "fixture-closed");
    runtime.shutdown().unwrap();
    drop(f);
    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}
