//! Actual policy slots, Engine/Catalog, private credentials and loopback provider HTTP.
//! The policy replies are controlled fixtures, not an installed Host/kernel IPC session.
use crate::{credential_bridge::CredentialBridge, policy::PolicyBridge};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{atomic::AtomicBool, mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use varin_runtime::{
    catalog::{launches::LaunchSelection, policy_switch::*},
    execution::*,
    model_session, Catalog, ModelSessionConfiguration, RunState, SubmitInput,
};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;

fn configuration(
    model: &str,
    endpoint: &str,
    generation: u64,
    anonymous: bool,
) -> ModelSessionConfiguration {
    serde_json::from_value(json!({"providerFamily":"openai-responses","model":model,
        "endpoint":endpoint,"credentialEnvironment":null,"allowAnonymous":anonymous,
        "configurationGeneration":generation,"maxOutputTokens":100}))
    .unwrap()
}
fn artifact(version: u64) -> AgentPolicyArtifactBinding {
    AgentPolicyArtifactBinding {
        provider_key: "planning-policy:host:varin.agent.policy@3".into(),
        extension_id: "planning-policy".into(),
        extension_version: version.to_string(),
        service_id: "varin.agent.policy".into(),
        service_version: 3,
        artifact_integrity: format!("artifact-{version}"),
        configuration_identity: "configuration".into(),
        declared_identity: PolicyIdentity {
            name: "planning-policy".into(),
            version: version.to_string(),
        },
        identity: PolicyIdentity {
            name: "bound-planning-policy".into(),
            version: format!("bound-{version}"),
        },
        model_roles: vec!["agentPlanning".into()],
        state_transition: PolicyStateTransition::Explicit,
    }
}
fn ready(
    catalog: &Mutex<Catalog>,
    bridge: &PolicyBridge,
    credentials: &CredentialBridge,
    run: &str,
    version: u64,
    endpoint: &str,
) -> PolicySelection {
    let target = artifact(version);
    let before = catalog.lock().unwrap().policy_selections(run).unwrap();
    let selection = catalog
        .lock()
        .unwrap()
        .select_policy(
            run,
            &format!("policy-{version}"),
            before.active.generation,
            before.desired.map(|s| s.selection_id),
            PolicyTarget::Extension {
                artifact: target.clone(),
            },
            if version == 1 {
                PolicyStateMode::RestartState
            } else {
                PolicyStateMode::Preserve
            },
        )
        .unwrap();
    let model = if version == 1 {
        "planner-one"
    } else {
        "planner-two"
    };
    let cap = PolicyModelCapability {
        capability_id: "agentPlanning".into(),
        purpose: "planning".into(),
        status: PolicyModelStatus::Available,
        supported_operation: "tool_free_text".into(),
        binding_id: Some(format!(
            "policy:{}:agentPlanning:configuration-{version}",
            selection.generation
        )),
        configuration_identity: Some(format!("configuration-{version}")),
        binding: None,
        configuration: Some(configuration(model, endpoint, version, false)),
        credential_scope: Some(varin_runtime::providers::auth::CredentialScope {
            reference: format!("planner-account-{version}"),
            authority: "fixture-credentials".into(),
            account: format!("account-{version}"),
            generation: version,
        }),
    };
    let prepared = bridge
        .ready(
            selection,
            Some(crate::protocol_generated::AgentPolicyBinding {
                reference: format!("provider-{version}"),
                generation: version as i64,
                artifact: target,
            }),
            vec![cap],
            credentials,
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(prepared.status, PolicySelectionStatus::Ready);
    prepared
}

#[test]
fn activated_planning_generation_uses_its_exact_model_and_private_credential_owner() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let http = std::thread::spawn(move || {
        let mut received = Vec::new();
        for n in 1..=2 {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 4096];
            let header_end = loop {
                let read = socket.read(&mut buf).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buf[..read]);
                if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() - header_end < length {
                let read = socket.read(&mut buf).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buf[..read]);
            }
            let body: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            assert!(headers
                .to_lowercase()
                .contains(&format!("authorization: bearer fixture-only-{n}")));
            received.push((headers.lines().next().unwrap().to_owned(), body));
            let event = json!({"type":"response.completed","response":{"output":[{"id":format!("planning-output-{n}"),"type":"message","content":[{"type":"output_text","text":format!("PLAN_{n}")}]}]}});
            let body = format!("data: {event}\n\n");
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        }
        received
    });
    let root = std::env::temp_dir().join(format!("varin-policy-planner-{}", uuid::Uuid::new_v4()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("thread", "branch").unwrap();
    let mut start = model_session::bind(configuration(
        "main-must-not-run",
        "http://127.0.0.1:1/responses",
        1,
        true,
    ))
    .unwrap();
    let initial_identity = crate::policy::effective_identity(start.policy.identity());
    let receipt = db
        .submit_with_launch(
            &SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: None,
                input: json!({"text":"original user history"}),
                configuration: json!({}),
            },
            Some(LaunchSelection::from_binding(
                &start.binding,
                initial_identity,
                None,
            )),
        )
        .unwrap();
    let catalog = Arc::new(Mutex::new(db));
    let run = receipt.run_id;
    let (tx, rx) = mpsc::sync_channel(16);
    let bridge = PolicyBridge::new(tx.clone());
    bridge.initialize("transport");
    bridge.set_catalog(catalog.clone());
    let credentials = CredentialBridge::new(tx);
    credentials.initialize("transport").unwrap();
    start.policy = bridge
        .install(
            &run,
            0,
            PolicyTarget::Default,
            start.policy,
            vec![],
            BTreeMap::new(),
        )
        .unwrap();
    start.provider = bridge.wrap_models(&run, start.provider).unwrap();
    start = crate::questions::configure(start, catalog.clone());
    start = crate::collaboration::configure(start, catalog.clone());
    start = crate::process_wait::configure(start, catalog.clone());
    let input = catalog
        .lock()
        .unwrap()
        .prepare_execution(&run, start.binding, start.policy.identity(), Value::Null)
        .unwrap();
    ready(
        &catalog,
        &bridge,
        &credentials,
        &run,
        1,
        &format!("{base}/one"),
    );
    let engine = ExecutionEngine {
        persistence: catalog.clone(),
        context_preparation: start.context_preparation,
        provider: start.provider,
        tools: start.tools,
        policy: start.policy,
        progress: start.progress,
    };
    let (done_tx, done_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        done_tx
            .send(engine.run(input, CancellationToken::default()))
            .unwrap()
    });
    let mut credential_ids = Vec::new();
    let mut releases = Vec::new();
    let mut decisions = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    let report = loop {
        assert!(
            Instant::now() < deadline,
            "planning fixture did not reach its next observable fact"
        );
        if let Ok(report) = done_rx.try_recv() {
            break report.unwrap();
        }
        let frame = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(error) => panic!("private fixture disconnected: {error}"),
        };
        let generation = frame["generation"].as_u64();
        match frame["kind"].as_str().unwrap() {
            "agent-policy-release" => releases.push(generation.unwrap()),
            "credential-request" => {
                credential_ids.push(frame["bindingId"].as_str().unwrap().to_owned());
                let n = frame["scope"]["generation"].as_u64().unwrap();
                credentials.receive(json!({"v":1,"kind":"credential-response","id":frame["id"],"kernelEpoch":"transport","ok":true,
                    "result":{"scope":frame["scope"],"headers":[{"name":"authorization","value":format!("Bearer fixture-only-{n}")}]}}));
            }
            "agent-policy-transition-request" => {
                assert_eq!(generation, Some(2));
                assert_eq!(frame["input"]["event"]["kind"], "delivered");
                assert_eq!(frame["input"]["state"], json!({"step":2}));
                bridge.receive(json!({"v":1,"kind":"agent-policy-transition-response","id":frame["id"],"kernelEpoch":"transport","generation":2,
                    "ok":true,"transition":{"kind":"compatible","state":{"step":2,"version":2}}}));
            }
            "agent-policy-request" => {
                let g = generation.unwrap();
                let event = frame["input"]["event"]["kind"].as_str().unwrap();
                decisions.push((g, event.to_owned()));
                let decision = match (g, event) {
                    (1, "started") => {
                        json!({"state":{"step":1},"action":{"kind":"request_model_job","capability_id":"agentPlanning","instructions":["PLANNER_ONE"],"evidence":[]}})
                    }
                    (1, "model_job_completed") => {
                        assert_eq!(frame["input"]["event"]["receipt"]["usable"], true);
                        ready(
                            &catalog,
                            &bridge,
                            &credentials,
                            &run,
                            2,
                            &format!("{base}/two"),
                        );
                        assert_eq!(
                            catalog
                                .lock()
                                .unwrap()
                                .policy_selections(&run)
                                .unwrap()
                                .active
                                .generation,
                            1,
                            "ready must not interrupt this original decision"
                        );
                        json!({"state":{"step":2},"action":{"kind":"deliver","text":"first planner result"}})
                    }
                    (2, "delivered") => {
                        assert_eq!(frame["input"]["state"], json!({"step":2,"version":2}));
                        json!({"state":{"step":3,"version":2},"action":{"kind":"request_model_job","capability_id":"agentPlanning","instructions":["PLANNER_TWO"],"evidence":[]}})
                    }
                    (2, "model_job_completed") => {
                        assert_eq!(frame["input"]["event"]["receipt"]["usable"], true);
                        json!({"state":{"step":4,"version":2},"action":{"kind":"complete"}})
                    }
                    _ => panic!("unexpected policy generation/event: {g}/{event}"),
                };
                bridge.receive(json!({"v":1,"kind":"agent-policy-response","id":frame["id"],"kernelEpoch":"transport","generation":g,"ok":true,"decision":decision}));
            }
            kind => panic!("unexpected private fixture kind {kind}"),
        }
    };
    worker.join().unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(report.model_steps, 0);
    assert_eq!(
        decisions,
        vec![
            (1, "started".into()),
            (1, "model_job_completed".into()),
            (2, "delivered".into()),
            (2, "model_job_completed".into())
        ]
    );
    assert_eq!(
        credential_ids,
        vec![
            "policy:1:agentPlanning:configuration-1",
            "policy:2:agentPlanning:configuration-2"
        ]
    );
    assert!(releases.contains(&1));
    let received = http.join().unwrap();
    assert!(received[0].0.starts_with("POST /one "));
    assert!(received[1].0.starts_with("POST /two "));
    assert_eq!(received[0].1["model"], "planner-one");
    assert_eq!(received[1].1["model"], "planner-two");
    let launch = catalog
        .lock()
        .unwrap()
        .launch_intent(&run)
        .unwrap()
        .unwrap();
    assert_eq!(launch.policy_generation, 2);
    assert_eq!(launch.selection.model, "main-must-not-run");
    assert_eq!(
        launch.selection.policy_models[0]
            .configuration
            .as_ref()
            .unwrap()
            .model,
        "planner-two"
    );
    bridge.close();
    credentials.close();
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}
