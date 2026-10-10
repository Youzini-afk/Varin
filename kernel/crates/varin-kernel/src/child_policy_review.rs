//! Real child admission, RunAssembly, policy/model owners and Catalog. Private Host replies and
//! the loopback model are controlled fixtures; this is not a full Host Unix IPC acceptance test.
use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{atomic::AtomicBool, mpsc, Mutex},
    time::{Duration, Instant},
};
use varin_runtime::{
    catalog::{collaboration::ChildTask, goals::*, launches::LaunchSelection, policy_switch::*},
    execution::*,
    Catalog, Outcome, Run, RunState,
};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod dispatch;
use admission::InputAdmission;

const EPOCH: &str = "child-policy-test";
struct Fixture {
    root: PathBuf,
    child: ChildTask,
    run: Run,
    original: LaunchSelection,
    params: Value,
    assembly: RunAssembly,
    frames: mpsc::Receiver<Value>,
}
impl Fixture {
    fn new(goal: bool) -> Self {
        Self::with_tools(goal, Vec::new(), vec!["helper".into()])
    }
    fn with_tools(goal: bool, native: Vec<ToolSchema>, selected: Vec<String>) -> Self {
        let mut f = dispatch::Fixture::new_host_child_with_native(true, false, None, selected, native);
        f.launch.policy = crate::observations::default_policy_identity();
        // The real parent policy graph already committed private {"stage": 1}; the child must
        // nevertheless start with null. No checkpoint is copied or fabricated for the child.
        let persisted = rusqlite::Connection::open_with_flags(
            f.root.join("conversation.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let checkpoints: i64 = persisted
            .query_row(
                "SELECT count(*) FROM policy_checkpoints WHERE run_id=?1",
                [&f.context.run_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(checkpoints, 1);
        drop(persisted);
        if goal {
            let prepared =
                f.db.prepare_goal_start(
                    "parent-goal",
                    &f.context.run_id,
                    GoalScope {
                        thread_id: "thread:parent".into(),
                        branch_id: "branch:parent".into(),
                    },
                    "Complete the original delegated task".into(),
                    Some(GoalBudget {
                        max_output_tokens: 100,
                    }),
                )
                .unwrap()
                .load()
                .unwrap();
            f.db.admit_goal_mutation(prepared).unwrap();
        }
        let child = f.accept();
        assert!(
            child.receipt.is_none(),
            "acceptance precedes policy preparation"
        );
        assert!(
            child.launch.policy_models.is_empty(),
            "no parent planning inheritance"
        );
        let mut source = child.source.pin().unwrap().source.clone();
        source.branch_id = Some(format!("child-source:{}", child.operation_id));
        source.revision = Some(0);
        let proposal = varin_runtime::catalog::context::ContextProposal {
            key: "child-context".into(),
            branch_id: child.child_branch_id.clone(),
            through_id: None,
            expected_revision: 0,
            summary: String::new(),
            effective_system_prompt: "Independent child".into(),
            instruction_sources: vec!["fixture:child".into()],
            memory_checkpoint: None,
        };
        let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
            "configurationDigest":"fixture:child","memorySnapshot":{"revision":0,"memories":[]},
            "sessionId":child.child_thread_id,"projectId":child.project_id,
            "originalSections":[{"name":"preamble","content":"Independent child"}],"instructionSources":["fixture:child"]})).unwrap();
        let child =
            f.db.prepare_child(&child.operation_id, source.clone(), proposal, basis)
                .unwrap();
        let run = f.db.run(&child.receipt.as_ref().unwrap().run_id).unwrap();
        let original = f.db.launch_intent(&run.id).unwrap().unwrap().selection;
        let params = json!({"runId":run.id,"credentialScope":original.credential_scope,
            "toolBinding":{"grantId":"child-source-grant","runId":run.id,"threadId":run.thread_id,
                "workspaceId":source.workspace_id,"executionWorkspaceId":source.execution_workspace_id,
                "sourceMode":"fixed_branch","fileSource":{"branchId":source.branch_id,"revision":source.revision},"enabledTools":[]},
            "extensionBindings":original.extension_bindings.iter().map(|binding| json!({"ownerId":"child-host-owner","generation":1,"binding":binding})).collect::<Vec<_>>()});
        Self::from_catalog(f.root, child, run, original, params, f.db)
    }
    fn from_catalog(
        root: PathBuf,
        child: ChildTask,
        run: Run,
        original: LaunchSelection,
        params: Value,
        db: Catalog,
    ) -> Self {
        let runtime = Arc::new(RunSupervisor::new(db));
        let (output, frames) = mpsc::sync_channel(128);
        let credentials = crate::credential_bridge::CredentialBridge::new(output.clone());
        credentials.initialize(EPOCH).unwrap();
        let tools = crate::host_tools::ToolBridge::new(output.clone().into());
        tools.initialize(EPOCH);
        let policy = crate::policy::PolicyBridge::new(output.clone());
        policy.initialize(EPOCH);
        policy.set_catalog(runtime.catalog());
        let memory = crate::host_query::OwnerChannel::new("memory", output.clone());
        memory.initialize(EPOCH);
        let plan = crate::plan_bridge::PlanBridge::new(output.clone());
        plan.initialize(EPOCH);
        let assembly = RunAssembly {
            runtime: runtime.clone(),
            resources: crate::tools::KernelResourceClient::new(
                |_| Err(KernelError::Operation("unrequested source effect".into())),
                |_| Ok(()),
                Default::default(),
            ),
            credentials: credentials.clone(),
            language: crate::language::LanguageBridge::new(output.clone()),
            retrieval: crate::retrieval::RetrievalBridge::new(output.clone()),
            memory,
            context: crate::host_query::OwnerChannel::new("context", output.clone()),
            resource: crate::host_query::OwnerChannel::new("resource", output.clone()),
            plan,
            policy,
            models: crate::run_models::RunModels::new(runtime.catalog(), credentials),
            tools: crate::run_tools::RunTools::new(runtime.catalog(), tools),
            responses: output.into(),
            epoch: EPOCH.into(),
        };
        Self {
            root,
            child,
            run,
            original,
            params,
            assembly,
            frames,
        }
    }
    fn catalog(&self) -> Arc<Mutex<Catalog>> {
        self.assembly.runtime.catalog()
    }
    fn prepare_policy(&self, generation: u64, endpoint: &str) {
        let mut model = capability(generation, endpoint);
        model.binding = Some(
            bind_policy_model(&self.run.id, &model, &self.assembly.credentials)
                .unwrap()
                .binding,
        );
        let preparation = self
            .catalog()
            .lock()
            .unwrap()
            .prepare_policy_change(
                &self.run.id,
                crate::observations::default_policy_identity(),
                crate::policy::effective_identity(artifact(generation).identity),
                vec![model],
                PolicyTarget::Extension {
                    artifact: artifact(generation),
                },
            )
            .unwrap();
        let prepared = preparation.load().unwrap();
        self.catalog()
            .lock()
            .unwrap()
            .admit_launch_change(prepared)
            .unwrap();
    }
    fn start(&self, generation: u64) -> RunStart {
        let mut params = self.params.clone();
        params["policyBinding"] = json!({"reference":format!("child-policy-{generation}"),"generation":generation,"artifact":artifact(generation)});
        let prepared =
            RunPreparation::new(serde_json::from_value(params).unwrap(), &self.run).unwrap();
        let PreparedLaunch::Start(start) = self.assembly.prepare(prepared, None, || false).unwrap()
        else {
            panic!("Run start required")
        };
        assert_eq!(start.binding.tools, self.original.tools);
        assert!(
            start
                .tools
                .select_for_request(
                    &self.run.id,
                    self.catalog().lock().unwrap().epoch(),
                    &CancellationToken::default()
                )
                .unwrap()
                .is_none(),
            "policy changes must not make the child's tools dynamic"
        );
        assert!(start.binding.tools.iter().all(|t| t.name != "goal_report"));
        start
    }
    fn ready(&self, generation: u64, endpoint: &str) -> PolicySelection {
        let catalog = self.catalog();
        let before = catalog
            .lock()
            .unwrap()
            .policy_selections(&self.run.id)
            .unwrap();
        let selected = catalog
            .lock()
            .unwrap()
            .select_policy(
                &self.run.id,
                &format!("candidate-{generation}"),
                before.active.generation,
                before.desired.map(|v| v.selection_id),
                PolicyTarget::Extension {
                    artifact: artifact(generation),
                },
                PolicyStateMode::Preserve,
            )
            .unwrap();
        self.assembly
            .policy
            .ready(
                selected,
                Some(crate::protocol_generated::AgentPolicyBinding {
                    reference: format!("child-policy-{generation}"),
                    generation: generation as i64,
                    artifact: artifact(generation),
                }),
                vec![capability(generation, endpoint)],
                &self.assembly.credentials,
                &AtomicBool::new(false),
            )
            .unwrap()
    }
    fn reply(&self, frame: &Value, decision: Value) {
        self.assembly.policy.receive(
            json!({"v":1,"kind":"agent-policy-response","kernelEpoch":EPOCH,
            "id":frame["id"],"generation":frame["generation"],"ok":true,"decision":decision}),
        );
    }
    fn ordinary_frame(&self, frame: &Value) -> bool {
        match frame["kind"].as_str().unwrap() {
            "memory-request" => {
                assert_eq!(frame["query"]["runId"], self.run.id);
                assert_eq!(
                    frame["query"]["scope"]["sessionId"],
                    self.child.child_thread_id
                );
                assert_eq!(frame["query"]["action"], "synchronize");
                let checkpoint = &frame["query"]["checkpoint"];
                self.assembly.memory.receive(json!({"v":1,"kind":"memory-response","id":frame["id"],"kernelEpoch":EPOCH,
                    "result":{"status":"ready","context":{"resources":checkpoint["resources"],
                        "effectiveSystemPrompt":checkpoint["proposal"]["effective_system_prompt"],
                        "instructionSources":checkpoint["proposal"]["instruction_sources"],"memoryCheckpoint":checkpoint["proposal"]["memory_checkpoint"],
                        "personalization":checkpoint["personalization"]},"state":{"revision":0,"memories":[],"noteRevisions":{},"known":{}}}}));
                true
            }
            "runtime-event"
            | "host-tool-binding-activate"
            | "host-tool-binding-retain"
            | "host-tool-binding-release"
            | "agent-policy-release"
            | "agent-policy-cancel" => true,
            _ => false,
        }
    }
    fn credentials(&self, frame: &Value) {
        assert_eq!(
            frame["runId"], self.run.id,
            "planner credentials belong to child, never parent"
        );
        let g = frame["scope"]["generation"].as_u64().unwrap();
        assert_eq!(
            frame["bindingId"],
            format!("policy:{g}:agentPlanning:child-config-{g}")
        );
        self.assembly.credentials.receive(json!({"v":1,"kind":"credential-response","id":frame["id"],"kernelEpoch":EPOCH,"ok":true,
            "result":{"scope":frame["scope"],"headers":[{"name":"authorization","value":format!("Bearer fixture-child-{g}")}]}}));
    }
    fn reopen(self) -> Self {
        let Self {
            root,
            child,
            run,
            original,
            params,
            assembly,
            frames,
        } = self;
        assembly.policy.close();
        assembly.credentials.close();
        assembly.memory.close();
        assembly.plan.close();
        drop(assembly);
        drop(frames);
        let db = Catalog::open(&root).unwrap();
        let run = db.run(&run.id).unwrap();
        Self::from_catalog(root, child, run, original, params, db)
    }
    fn finish(self) {
        let root = self.root.clone();
        self.assembly.policy.close();
        self.assembly.credentials.close();
        self.assembly.memory.close();
        self.assembly.plan.close();
        drop(self);
        std::fs::remove_dir_all(root).unwrap();
    }
}
fn artifact(g: u64) -> AgentPolicyArtifactBinding {
    AgentPolicyArtifactBinding {
        provider_key: "child-strategy:host:varin.agent.policy@3".into(),
        extension_id: "child-strategy".into(),
        extension_version: g.to_string(),
        service_id: "varin.agent.policy".into(),
        service_version: 3,
        artifact_integrity: format!("child-artifact-{g}"),
        configuration_identity: format!("child-policy-config-{g}"),
        declared_identity: PolicyIdentity {
            name: "child-strategy".into(),
            version: g.to_string(),
        },
        identity: PolicyIdentity {
            name: "bound-child-strategy".into(),
            version: g.to_string(),
        },
        model_roles: vec!["agentPlanning".into()],
        state_transition: PolicyStateTransition::Explicit,
    }
}
fn capability(g: u64, endpoint: &str) -> PolicyModelCapability {
    PolicyModelCapability {
        capability_id: "agentPlanning".into(), purpose: "planning".into(), status: PolicyModelStatus::Available,
        supported_operation: "tool_free_text".into(), binding_id: Some(format!("policy:{g}:agentPlanning:child-config-{g}")),
        configuration_identity: Some(format!("child-config-{g}")), binding: None,
        configuration: Some(serde_json::from_value(json!({"providerFamily":"openai-responses","model":format!("child-planner-{g}"),
            "endpoint":endpoint,"allowAnonymous":false,"configurationGeneration":g+1,"maxOutputTokens":100})).unwrap()),
        credential_scope: Some(varin_runtime::providers::auth::CredentialScope {
            reference: format!("child-planner-account-{g}"), authority: "fixture-credentials".into(), account: format!("planner-{g}"), generation: g,
        }),
    }
}
fn loopback(count: usize) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/responses", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        (0..count).map(|_| {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut bytes = Vec::new(); let mut buffer = [0;4096];
        let end = loop {
            let n = socket.read(&mut buffer).unwrap(); assert!(n>0); bytes.extend_from_slice(&buffer[..n]);
            if let Some(index)=bytes.windows(4).position(|w|w==b"\r\n\r\n") { break index+4; }
        };
        let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
        let length: usize = headers.lines().find_map(|line| { let (name,value)=line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length").then(||value.trim().parse().unwrap()) }).unwrap();
        while bytes.len()-end<length { let n=socket.read(&mut buffer).unwrap(); assert!(n>0); bytes.extend_from_slice(&buffer[..n]); }
        let body: Value = serde_json::from_slice(&bytes[end..end+length]).unwrap();
        let g=body["model"].as_str().unwrap().strip_prefix("child-planner-").unwrap();
        assert!(headers.to_lowercase().contains(&format!("authorization: bearer fixture-child-{g}")));
        assert!(body["tools"].as_array().is_none_or(Vec::is_empty));
        let event=json!({"type":"response.completed","response":{"output":[{"id":"plan","type":"message","content":[{"type":"output_text","text":"Independent child plan"}]}],
            "usage":{"input_tokens":11,"output_tokens":4,"total_tokens":15}}});
        let data=format!("data: {event}\n\n");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len()).as_bytes()).unwrap();
        body
    }).collect()
    });
    (endpoint, thread)
}
fn make_engine(
    f: &Fixture,
    start: RunStart,
) -> ExecutionEngine<Mutex<Catalog>, dyn ModelProvider, dyn ToolExecutor, dyn AgentPolicy> {
    ExecutionEngine {
        persistence: f.catalog(),
        context_preparation: start.context_preparation,
        provider: start.provider,
        tools: start.tools,
        policy: start.policy,
        progress: start.progress,
    }
}
fn planning_decision(stage: u64) -> Value {
    json!({"state":{"childStage":stage},"action":{"kind":"request_model_job","capability_id":"agentPlanning","instructions":["Plan only the admitted child task"],"evidence":[]}})
}
fn graph_decision(schema: &ToolSchema) -> Value {
    json!({"state":{"childStage":4},"action":{"kind":"tool_graph","nodes":[{
        "id":"child-read","depends_on":[],"call":{"call_id":"child-read","name":schema.name,
            "schema_version":schema.version,"arguments":{}}}]}})
}

fn resume_after_reopen(f: Fixture, generation: u64, state: Value) -> Fixture {
    let f = f.reopen();
    let start = f.start(generation);
    let wait = f
        .catalog()
        .lock()
        .unwrap()
        .run(&f.run.id)
        .unwrap()
        .waiting_on
        .unwrap();
    let resume = f
        .catalog()
        .lock()
        .unwrap()
        .resume_policy_pause(&f.run.id, &wait, f.run.epoch)
        .unwrap();
    assert_eq!(resume.wait_id, wait);
    let (input, recovery) = f
        .catalog()
        .lock()
        .unwrap()
        .prepare_recovered_execution(
            &f.run.id,
            start.binding.clone(),
            start.policy.identity(),
            Value::Null,
        )
        .unwrap();
    let engine = make_engine(&f, start);
    let (tx, done) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        tx.send(engine.run_recovered(input, CancellationToken::default(), recovery))
            .unwrap()
    });
    let frame = loop {
        let frame = f.frames.recv_timeout(Duration::from_secs(10)).unwrap();
        if !f.ordinary_frame(&frame) {
            break frame;
        }
    };
    assert_eq!(frame["kind"], "agent-policy-request");
    assert_eq!(frame["input"]["event"]["kind"], "resumed");
    assert_eq!(frame["input"]["state"], state);
    f.reply(&frame, json!({"state":state,"action":{"kind":"complete"}}));
    let report = done.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
    worker.join().unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(report.model_steps, 0);
    f
}

#[test]
fn child_assembly_plans_with_own_credentials_switches_policy_and_keeps_frozen_tools_and_goal_usage()
{
    let f = Fixture::new(true);
    let (endpoint, provider) = loopback(2);
    f.prepare_policy(0, &endpoint);
    let start = f.start(0);
    assert_eq!(start.policy_state, Value::Null);
    let input = f
        .catalog()
        .lock()
        .unwrap()
        .prepare_execution(
            &f.run.id,
            start.binding.clone(),
            start.policy.identity(),
            Value::Null,
        )
        .unwrap();
    let engine = make_engine(&f, start);
    let (done_tx, done) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        done_tx
            .send(engine.run(input, CancellationToken::default()))
            .unwrap()
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut decisions = Vec::new();
    let mut credential_count = 0;
    let mut tool_phases = Vec::new();
    let report = loop {
        assert!(
            Instant::now() < deadline,
            "child did not reach next durable boundary"
        );
        if let Ok(report) = done.try_recv() {
            break report.unwrap();
        }
        let frame = match f.frames.recv_timeout(Duration::from_millis(50)) {
            Ok(v) => v,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(e) => panic!("{e}"),
        };
        if f.ordinary_frame(&frame) {
            continue;
        }
        match frame["kind"].as_str().unwrap() {
            "credential-request" => {
                credential_count += 1;
                f.credentials(&frame);
            }
            "host-tool-request" => {
                assert_eq!(frame["binding"]["ownerId"], "child-host-owner");
                assert_eq!(frame["call"]["runId"], f.run.id);
                assert_eq!(frame["call"]["origin"]["kind"], "policy_action");
                assert_eq!(frame["call"]["origin"]["node_id"], "child-read");
                assert_eq!(frame["call"]["name"], "helper");
                let phase = frame["phase"].as_str().unwrap();
                tool_phases.push(phase.to_owned());
                let mut reply = json!({"v":1,"kind":"host-tool-response","id":frame["id"],"kernelEpoch":EPOCH,"ok":true});
                if phase == "execute" {
                    reply["executor_stopped"] = json!(true);
                    reply["completion"] = json!({"kind":"result","outcome":"succeeded","effect":"none","content":{"originalChildOwner":true}});
                    // Host publishes its authenticated original receipt before answering the
                    // invocation. Without that evidence an effectful service's None is Unknown.
                    serde_json::from_value::<crate::host_tools::LateReceipt>(json!({
                        "v":1,"kind":"host-tool-receipt","id":"child-read-receipt","kernelEpoch":EPOCH,
                        "executionOwner":{"kind":"external","identity":f.original.extension_bindings[0].provider_key,"epoch":"child-host-owner"},
                        "call":frame["call"],"receipt":{"completion":reply["completion"],"executor_stopped":true}
                    })).unwrap().apply(&f.catalog()).unwrap();
                } else {
                    assert_eq!(phase, "authorize");
                }
                f.assembly.tools.bridge().receive(reply);
            }
            "agent-policy-transition-request" => {
                assert_eq!(frame["generation"], 1);
                assert_eq!(frame["input"]["event"]["kind"], "delivered");
                assert_eq!(frame["input"]["state"], json!({"childStage":2}));
                f.assembly.policy.receive(json!({"v":1,"kind":"agent-policy-transition-response","id":frame["id"],"kernelEpoch":EPOCH,"generation":1,
                    "ok":true,"transition":{"kind":"compatible","state":{"childStage":2,"newPolicy":true}}}));
            }
            "agent-policy-request" => {
                assert_eq!(frame["runId"], f.run.id);
                let g = frame["generation"].as_u64().unwrap();
                let event = frame["input"]["event"]["kind"].as_str().unwrap();
                decisions.push((g, event.to_owned()));
                let decision = match (g, event) {
                    (0, "started") => {
                        assert_eq!(frame["input"]["state"], Value::Null);
                        planning_decision(1)
                    }
                    (0, "model_job_completed") => {
                        assert_eq!(frame["input"]["event"]["receipt"]["usable"], true);
                        assert_eq!(f.ready(1, &endpoint).status, PolicySelectionStatus::Ready);
                        assert_eq!(
                            f.catalog()
                                .lock()
                                .unwrap()
                                .policy_selections(&f.run.id)
                                .unwrap()
                                .active
                                .generation,
                            0
                        );
                        json!({"state":{"childStage":2},"action":{"kind":"deliver","text":"First child plan ready"}})
                    }
                    (1, "delivered") if frame["input"]["state"]["newPolicy"] == true => {
                        planning_decision(3)
                    }
                    (1, "model_job_completed") => graph_decision(&f.original.tools[0]),
                    (1, "tool_graph_completed") => {
                        assert_eq!(
                            frame["input"]["event"]["receipts"][0]["completion"]["outcome"],
                            "succeeded"
                        );
                        json!({"state":{"childStage":4},"action":{"kind":"deliver","text":"Independent child report"}})
                    }
                    (1, "delivered") => {
                        json!({"state":{"childStage":5},"action":{"kind":"pause","reason":"Review child report"}})
                    }
                    _ => panic!("unexpected child policy event {g}/{event}: {frame}"),
                };
                f.reply(&frame, decision);
            }
            _ => panic!("unexpected {frame}"),
        }
    };
    worker.join().unwrap();
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(report.model_steps, 0);
    assert_eq!(credential_count, 2);
    assert_eq!(decisions.len(), 6);
    assert_eq!(
        tool_phases
            .iter()
            .filter(|phase| phase.as_str() == "execute")
            .count(),
        1
    );
    assert!(tool_phases.iter().any(|phase| phase == "authorize"));
    let requests = provider.join().unwrap();
    assert_eq!(requests[0]["model"], "child-planner-0");
    assert_eq!(requests[1]["model"], "child-planner-1");
    let f = resume_after_reopen(f, 1, json!({"childStage":5}));
    let catalog = f.catalog();
    let preparation = catalog.lock().unwrap().capture_child_reports().unwrap();
    let prepared = preparation.load().unwrap();
    for report in prepared {
        catalog.lock().unwrap().admit_child_report(report).unwrap();
    }
    let mut db = catalog.lock().unwrap();
    let launch = db.launch_intent(&f.run.id).unwrap().unwrap();
    assert_eq!(launch.policy_generation, 1);
    assert_eq!(launch.selection.tools, f.original.tools);
    assert_eq!(
        launch.selection.extension_bindings,
        f.original.extension_bindings
    );
    assert_eq!(launch.selection.source, f.original.source);
    assert_eq!(launch.selection.model, f.original.model);
    let child = db.child_task(&f.child.operation_id).unwrap();
    assert_eq!(
        child.code_result,
        varin_runtime::catalog::collaboration::ChildCodeResult::NoChanges
    );
    assert_eq!(child.report.as_ref().unwrap().outcome, Outcome::Succeeded);
    let report = child.report.unwrap();
    let text = db
        .read_child_report(
            &f.child.operation_id,
            report.history_ids.last().unwrap(),
            0,
            65536,
        )
        .unwrap();
    assert!(serde_json::to_string(&text)
        .unwrap()
        .contains("Independent child report"));
    let goal = db.capture_goal("parent-goal").unwrap().load().unwrap();
    assert_eq!(goal.usage.actual.inferences, 2);
    assert_eq!(goal.usage.actual.output_tokens.known, 8);
    assert_eq!(goal.usage.pending_inferences, 0);
    assert_eq!(goal.state, GoalState::Active);
    let denied = db
        .prepare_goal_start(
            "child-goal",
            &f.run.id,
            GoalScope {
                thread_id: f.run.thread_id.clone(),
                branch_id: f.run.branch_id.clone(),
            },
            "unapproved independent goal".into(),
            None,
        )
        .unwrap()
        .load()
        .unwrap();
    assert!(db.admit_goal_mutation(denied).is_err());
    drop(db);
    drop(catalog);
    f.finish();
}

#[test]
fn child_reopen_restores_exact_planning_operation_and_never_replays_dispatched_work() {
    for dispatched in [false, true] {
        let f = Fixture::new(false);
        let (endpoint, http) = loopback(usize::from(!dispatched));
        f.prepare_policy(0, &endpoint);
        let start = f.start(0);
        let catalog = f.catalog();
        let input = catalog
            .lock()
            .unwrap()
            .prepare_execution(
                &f.run.id,
                start.binding.clone(),
                start.policy.identity(),
                Value::Null,
            )
            .unwrap();
        let boundary = catalog
            .lock()
            .unwrap()
            .policy_boundary(&f.run.id, input.owner_generation)
            .unwrap();
        let action_id = format!("{}:policy:{}", f.run.id, boundary.id);
        let model = start
            .provider
            .policy_model_capability("agentPlanning")
            .unwrap();
        let mut binding = model.capability.binding.clone().unwrap();
        binding.history_range = input.binding.history_range.clone();
        let instructions = vec!["Original frozen child planning request".into()];
        binding.instruction_sources = instructions.clone();
        let view = RequestView {
            request_id: action_id.clone(),
            run_id: f.run.id.clone(),
            binding,
            origin: RequestOrigin::PolicyModelJob {
                action_id: action_id.clone(),
                purpose: "planning".into(),
                boundary_id: boundary.id.clone(),
            },
            history: vec![],
        };
        let snapshot = RequestSnapshot {
            serialized: model.provider.serialize(&view).unwrap(),
            view,
        };
        let intent = PolicyModelIntent::PolicyModelJobV1 {
            action_id: action_id.clone(),
            boundary,
            identity: start.policy.identity(),
            state: json!({"childStage":7}),
            capability: model.capability.clone(),
            instructions,
            evidence: vec![],
        };
        catalog
            .lock()
            .unwrap()
            .admit_policy_model(&f.run.id, input.owner_generation, &intent, &snapshot)
            .unwrap();
        if dispatched {
            catalog
                .lock()
                .unwrap()
                .dispatch_policy_model(&f.run.id, input.owner_generation, &action_id)
                .unwrap();
        }
        drop(model);
        drop(start);
        drop(catalog);
        let f = f.reopen();
        // Neither a current route nor a similarly named artifact may replace the committed one.
        let mut wrong = f.params.clone();
        wrong["policyBinding"] =
            json!({"reference":"current-route","generation":0,"artifact":artifact(1)});
        assert!(f
            .assembly
            .prepare(
                RunPreparation::new(serde_json::from_value(wrong).unwrap(), &f.run).unwrap(),
                None,
                || false
            )
            .is_err());
        let start = f.start(0);
        let saved = f
            .catalog()
            .lock()
            .unwrap()
            .policy_model_job(&f.run.id, f.run.epoch)
            .unwrap()
            .unwrap();
        assert_eq!(
            saved.snapshot, snapshot,
            "recovery retains original request bytes and child identity"
        );
        assert_eq!(saved.intent, intent);
        assert_eq!(
            start
                .provider
                .policy_model_capability("agentPlanning")
                .unwrap()
                .capability,
            intent.capability().clone()
        );
        let (input, recovery) = f
            .catalog()
            .lock()
            .unwrap()
            .prepare_recovered_execution(
                &f.run.id,
                start.binding.clone(),
                start.policy.identity(),
                Value::Null,
            )
            .unwrap();
        let engine = make_engine(&f, start);
        let (tx, done) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            tx.send(engine.run_recovered(input, CancellationToken::default(), recovery))
                .unwrap()
        });
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut requests = 0;
        let mut callbacks = 0;
        let report = loop {
            assert!(Instant::now() < deadline, "recovered child stalled");
            if let Ok(result) = done.try_recv() {
                break result.unwrap();
            }
            let frame = match f.frames.recv_timeout(Duration::from_millis(50)) {
                Ok(v) => v,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(e) => panic!("{e}"),
            };
            if f.ordinary_frame(&frame) {
                continue;
            }
            match frame["kind"].as_str().unwrap() {
                "credential-request" => {
                    assert!(
                        !dispatched,
                        "ambiguous child planning must not be sent again"
                    );
                    requests += 1;
                    f.credentials(&frame);
                }
                "agent-policy-request" => {
                    assert_eq!(frame["input"]["event"]["kind"], "model_job_completed");
                    assert_eq!(frame["input"]["event"]["action_id"], action_id);
                    assert_eq!(frame["input"]["state"], json!({"childStage":7}));
                    assert_eq!(frame["input"]["event"]["receipt"]["usable"], !dispatched);
                    if dispatched {
                        assert_eq!(
                            frame["input"]["event"]["receipt"]["outcome"],
                            "indeterminate"
                        );
                    }
                    callbacks += 1;
                    f.reply(&frame,json!({"state":{"childStage":8},"action":{"kind":"pause","reason":"Review child plan"}}));
                }
                _ => panic!("unexpected recovery frame {frame}"),
            }
        };
        worker.join().unwrap();
        assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
        assert_eq!(report.model_steps, 0);
        assert_eq!(requests, usize::from(!dispatched));
        assert_eq!(callbacks, 1);
        assert_eq!(http.join().unwrap().len(), usize::from(!dispatched));
        let f = resume_after_reopen(f, 0, json!({"childStage":8}));
        f.finish();
    }
}

#[test]
fn child_cancel_after_dispatch_intent_rejects_late_credentials_and_candidate() {
    let f = Fixture::new(false);
    f.prepare_policy(0, "http://127.0.0.1:1/must-not-dispatch");
    let start = f.start(0);
    let handle = f.assembly.runtime.start(&f.run.id, start).unwrap();
    // Hold before private credentials return: dispatch intent exists, but this fixture has
    // not sent an HTTP request. The original conservative receipt remains Interrupted/Missing.
    let credential = loop {
        let frame = f.frames.recv_timeout(Duration::from_secs(10)).unwrap();
        if f.ordinary_frame(&frame) {
            continue;
        }
        match frame["kind"].as_str().unwrap() {
            "agent-policy-request" => f.reply(&frame, planning_decision(1)),
            "credential-request" => break frame,
            _ => panic!("unexpected pre-cancel {frame}"),
        }
    };
    let ready = f.ready(1, "http://127.0.0.1:1/new-planner");
    assert_eq!(ready.status, PolicySelectionStatus::Ready);
    // Parent-only cancellation must leave the accepted child's running planner independent.
    f.catalog()
        .lock()
        .unwrap()
        .request_cancel_run(&f.child.parent_run_id)
        .unwrap();
    assert!(
        !f.catalog()
            .lock()
            .unwrap()
            .run(&f.run.id)
            .unwrap()
            .cancel_requested
    );
    let before = f
        .catalog()
        .lock()
        .unwrap()
        .policy_model_job(&f.run.id, f.run.epoch)
        .unwrap()
        .unwrap();
    f.assembly.runtime.cancel(&f.run.id).unwrap();
    let report = handle.wait().unwrap();
    assert_eq!(report.state, RunState::Cancelled);
    assert_eq!(report.model_steps, 0);
    let catalog = f.catalog();
    let op = catalog
        .lock()
        .unwrap()
        .operation(before.intent.action_id())
        .unwrap();
    assert_eq!(op.outcome, Some(Outcome::Indeterminate));
    assert_eq!(op.run_id, f.run.id);
    let Some(varin_runtime::OperationResultMetadata::Control { value }) = &op.result else {
        panic!("original policy model receipt required")
    };
    let result: PolicyModelResult = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(result.dispatch, PolicyModelDispatch::Interrupted);
    assert_eq!(result.receipt.as_ref().unwrap().usage.output_tokens, None);
    assert_eq!(
        result.receipt.as_ref().unwrap().usage.measurement,
        UsageMeasurement::Missing
    );
    assert_eq!(
        catalog
            .lock()
            .unwrap()
            .policy_selections(&f.run.id)
            .unwrap()
            .active
            .generation,
        0
    );
    assert_eq!(
        catalog
            .lock()
            .unwrap()
            .policy_selection(&f.run.id, &ready.selection_id)
            .unwrap()
            .status,
        PolicySelectionStatus::Cancelled
    );
    f.credentials(&credential);
    let epoch = catalog.lock().unwrap().epoch();
    assert!(catalog
        .lock()
        .unwrap()
        .capture_policy_activation(&f.run.id, epoch, &ready.selection_id, ready.generation)
        .is_err());
    assert_eq!(
        catalog.lock().unwrap().run(&f.run.id).unwrap().state,
        RunState::Cancelled
    );
    drop(catalog);
    f.finish();
}

#[test]
fn child_policy_graph_cannot_add_an_undelegated_memory_tool() {
    let f = Fixture::new(false);
    f.prepare_policy(0, "http://127.0.0.1:1/unused-planner");
    let start = f.start(0);
    let handle = f.assembly.runtime.start(&f.run.id, start).unwrap();
    let frame = loop {
        let frame = f.frames.recv_timeout(Duration::from_secs(10)).unwrap();
        if !f.ordinary_frame(&frame) {
            break frame;
        }
    };
    assert_eq!(frame["kind"], "agent-policy-request");
    assert_eq!(frame["input"]["event"]["kind"], "started");
    f.reply(&frame, graph_decision(&crate::memory::schema(true)));
    let report = handle.wait().unwrap();
    assert_eq!(report.state, RunState::Failed);
    assert_eq!(report.failure.unwrap().code, "unknown_tool_schema");
    assert_eq!(report.model_steps, 0);
    while let Ok(frame) = f.frames.try_recv() {
        assert!(
            f.ordinary_frame(&frame),
            "ungranted graph must not reach an owner: {frame}"
        );
    }
    let launch = f
        .catalog()
        .lock()
        .unwrap()
        .launch_intent(&f.run.id)
        .unwrap()
        .unwrap();
    assert_eq!(launch.selection.tools, f.original.tools);
    f.finish();
}

#[path = "child_memory_plan_review.rs"]
mod memory_plan_review;
