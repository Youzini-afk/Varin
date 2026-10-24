//! Original Engine and Host MCP/permission owners, with a real local MCP stdio peer.
//! Test stdio delivers private bridge frames; it is not the product socket transport.
use super::*;
use crate::host_tools::{LateReceipt, ToolBridge};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::output::{MediaReadParams, OutputMediaHolder, OutputPart};
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};

const EPOCH: &str = "mcp-content-review";
const PIXEL: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7h8AAAAASUVORK5CYII=";

struct Host {
    child: Child,
    input: ChildStdin,
    frames: mpsc::Receiver<Value>,
}
impl Host {
    fn new() -> Self {
        let mut child =
            Command::new(std::env::var_os("VARIN_NODE").unwrap_or_else(|| "node".into()))
                .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
                .args([
                    "--import",
                    "tsx",
                    "packages/web/application-host/lib/kernel/mcp-content-host.test-helper.ts",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, frames) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let value = serde_json::from_str(&line)
                    .unwrap_or_else(|_| panic!("invalid MCP Host frame: {line}"));
                if tx.send(value).is_err() {
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
    fn send(&mut self, frame: Value) {
        writeln!(self.input, "{frame}").unwrap();
        self.input.flush().unwrap();
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Model {
    views: Arc<Mutex<Vec<RequestView>>>,
    wires: Arc<Mutex<Vec<Value>>>,
}
/// One ordinary policy action follows the completed model exchange through the same directory.
struct Policy {
    read: ToolSchema,
}
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "mcp-review".into(),
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
        if let PolicyEvent::ToolsCompleted { results } = event {
            if results.len() == 1 && results[0].call_id == "expiry-first" {
                assert!(matches!(
                    results[0].completion,
                    ToolCompletion::Result {
                        outcome: Outcome::Indeterminate,
                        effect: Effect::Unknown,
                        ..
                    }
                ));
                assert!(
                    matches!(
                        DefaultAgentPolicy
                            .decide(view, event, state, cancel)?
                            .action,
                        PolicyAction::Fail { .. }
                    ),
                    "the ordinary policy still stops at an unknown remote effect"
                );
                // This explicit test policy chooses a distinct new operation after observing the
                // unknown result. It does not reconcile or change that original result.
                return Ok(PolicyDecision {
                    action: PolicyAction::RequestModel,
                    state: state.clone(),
                });
            }
        }
        if matches!(
            event,
            PolicyEvent::ModelCompleted {
                reason: FinishReason::Stop,
                ..
            }
        ) {
            let output = view
                .history
                .iter()
                .find_map(|item| match &item.content {
                    Content::ToolResult { result } if result.call_id == "resources1" => {
                        match &result.completion {
                            ToolCompletion::Result { content, .. } => Some(&content.data),
                            _ => None,
                        }
                    }
                    _ => None,
                })
                .unwrap();
            return Ok(PolicyDecision {
                action: PolicyAction::ToolGraph {
                    nodes: vec![PolicyToolNode {
                        id: "policy-resource".into(),
                        depends_on: vec![],
                        call: ToolCall {
                            call_id: "policy-resource".into(),
                            name: self.read.name.clone(),
                            schema_version: self.read.version.clone(),
                            arguments: json!({"server":"fixture","schemaVersion":output["schemaVersion"],"uri":"asset://policy"}),
                        },
                    }],
                },
                state: state.clone(),
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            assert_eq!(receipts.len(), 1);
            assert_eq!(receipts[0].outcome(), Outcome::Succeeded);
            return Ok(PolicyDecision {
                action: PolicyAction::Complete,
                state: json!({"evidence":receipts[0].output().unwrap()}),
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView, reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        use varin_runtime::providers::{
            Connection, EnvironmentCredentialResolver, ReqwestTransport,
        };
        let mut connection = Connection::new(
            "https://fixture.invalid/responses",
            Arc::new(EnvironmentCredentialResolver::default()),
            Arc::new(ReqwestTransport::default()),
        );
        connection.accepts_images = Some(true);
        let wire = varin_runtime::providers::responses::ResponsesProvider::new(connection)
            .serialize(view, reuse)?;
        self.views.lock().unwrap().push(view.clone());
        self.wires.lock().unwrap().push(wire.to_value());
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
                outcome, content, ..
            } = &result.completion
            else {
                panic!("original MCP Result required")
            };
            assert_eq!(*outcome, Outcome::Succeeded, "{result:?}");
            content.data.clone()
        };
        let calls = match results.len() {
            0 => vec![("discover", "mcp_discover", json!({"server":"fixture"}))],
            1 => {
                let discovered = data("discover");
                let tool = &discovered["tools"][0];
                let service = |kind: &str| {
                    discovered["services"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|service| service["kind"] == kind)
                        .unwrap()["schemaVersion"]
                        .clone()
                };
                vec![
                    (
                        "picture",
                        "mcp_call",
                        json!({"server":"fixture","tool":tool["tool"],"schemaVersion":tool["schemaVersion"],"arguments":{}}),
                    ),
                    (
                        "resources1",
                        "mcp_list_resources",
                        json!({"server":"fixture","schemaVersion":service("resources")}),
                    ),
                    (
                        "prompts1",
                        "mcp_list_prompts",
                        json!({"server":"fixture","schemaVersion":service("prompts")}),
                    ),
                ]
            }
            4 => {
                let resources = data("resources1");
                let prompts = data("prompts1");
                let picture = data("picture");
                assert_eq!(resources["result"]["_meta"]["page"], 1);
                assert_eq!(prompts["result"]["_meta"]["page"], 1);
                vec![
                    (
                        "resources2",
                        "mcp_list_resources",
                        json!({"server":"fixture","schemaVersion":resources["schemaVersion"],"cursor":resources["result"]["nextCursor"]}),
                    ),
                    (
                        "templates",
                        "mcp_list_resources",
                        json!({"server":"fixture","schemaVersion":resources["schemaVersion"],"kind":"templates"}),
                    ),
                    (
                        "prompts2",
                        "mcp_list_prompts",
                        json!({"server":"fixture","schemaVersion":prompts["schemaVersion"],"cursor":prompts["result"]["nextCursor"]}),
                    ),
                    (
                        "resource",
                        "mcp_read_resource",
                        json!({"server":"fixture","schemaVersion":resources["schemaVersion"],"uri":picture["content"][2]["uri"]}),
                    ),
                    (
                        "prompt",
                        "mcp_get_prompt",
                        json!({"server":"fixture","name":"review","schemaVersion":prompts["promptVersions"][0]["schemaVersion"],"arguments":{"subject":"original MCP content"}}),
                    ),
                    (
                        "changed",
                        "mcp_read_resource",
                        json!({"server":"fixture","schemaVersion":"deliberately-old","uri":"asset://not-dispatched"}),
                    ),
                    (
                        "missing-argument",
                        "mcp_get_prompt",
                        json!({"server":"fixture","name":"review","schemaVersion":prompts["promptVersions"][0]["schemaVersion"],"arguments":{}}),
                    ),
                    (
                        "unsupported",
                        "mcp_read_resource",
                        json!({"server":"promptsOnly","schemaVersion":"not-negotiated","uri":"asset://not-dispatched"}),
                    ),
                ]
            }
            12 => {
                for (id, code) in [
                    ("changed", "mcp-schema-generation-mismatch"),
                    ("missing-argument", "mcp-prompt-arguments-invalid"),
                    ("unsupported", "mcp-service-unsupported"),
                ] {
                    let result = results.iter().find(|result| result.call_id == id).unwrap();
                    let ToolCompletion::NotDispatched { reason, .. } = &result.completion else {
                        panic!("bad admission must not dispatch: {result:?}")
                    };
                    assert!(
                        reason.contains(code),
                        "original actionable error must reach the model: {id}: {reason}"
                    );
                }
                assert_eq!(data("resources2")["result"]["_meta"]["page"], 2);
                assert_eq!(data("prompts2")["result"]["_meta"]["page"], 2);
                assert_eq!(
                    data("templates")["result"]["resourceTemplates"][0]["uriTemplate"],
                    "asset://{name}"
                );
                vec![(
                    "expiry-discover",
                    "mcp_discover",
                    json!({"server":"expiry"}),
                )]
            }
            13 | 14 => {
                if results.len() == 14 {
                    let original = results
                        .iter()
                        .find(|result| result.call_id == "expiry-first")
                        .unwrap();
                    assert!(
                        matches!(
                            original.completion,
                            ToolCompletion::Result {
                                outcome: Outcome::Indeterminate,
                                effect: Effect::Unknown,
                                ..
                            }
                        ),
                        "the expired-session result retains its original unknown effect: {original:?}"
                    );
                }
                let id = if results.len() == 13 {
                    "expiry-first"
                } else {
                    "expiry-next"
                };
                let discovered = data("expiry-discover");
                vec![(
                    id,
                    "mcp_read_resource",
                    json!({"server":"expiry","schemaVersion":discovered["services"][0]["schemaVersion"],"uri":format!("asset://{id}")}),
                )]
            }
            15 => {
                assert_eq!(
                    data("expiry-next")["contents"][0]["uri"],
                    "asset://expiry-next"
                );
                emit(ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: "answer".into(),
                        opaque: None,
                        content: Content::Text {
                            text: "Original MCP outputs received".into(),
                        },
                    },
                })
                .unwrap();
                return Ok(FinishReason::Stop);
            }
            count => panic!("unexpected MCP exchange count {count}: {results:?}"),
        };
        for (id, name, arguments) in calls {
            let schema = request
                .view
                .binding
                .tools
                .iter()
                .find(|schema| schema.name == name)
                .unwrap();
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: format!("{}:{id}", request.view.request_id),
                    opaque: None,
                    content: Content::ToolCall {
                        call: ToolCall {
                            call_id: id.into(),
                            name: name.into(),
                            schema_version: schema.version.clone(),
                            arguments,
                        },
                    },
                },
            })
            .unwrap();
        }
        Ok(FinishReason::ToolCalls)
    }
}

fn media(catalog: &Arc<Mutex<Catalog>>, params: &MediaReadParams) -> Vec<u8> {
    use base64::Engine;
    let read = catalog.lock().unwrap().capture_media_read(params).unwrap();
    let chunk = read.chunk(&|| false).unwrap();
    base64::engine::general_purpose::STANDARD
        .decode(chunk.bytes_base64)
        .unwrap()
}

#[test]
#[ignore = "requires workspace Node/tsx and built pi-host; original MCP stdio only, no product sockets or model request"]
fn original_mcp_content_resources_prompts_reach_model_permissions_and_persisted_readers() {
    let root = std::env::temp_dir().join(format!("varin-mcp-content-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let catalog_path = root.join("catalog");
    let mut db = Catalog::open(&catalog_path).unwrap();
    db.create_thread("thread", "main").unwrap();
    let prepared = db
        .prepare_submission(
            SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"Inspect the selected MCP resource and prompt"}),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap();
    let submitted = db
        .admit_submission(prepared.load(None, false).unwrap())
        .unwrap();
    let run = submitted.run_id;
    let mut host = Host::new();
    host.send(json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"runId":run}));
    let prepared = host.frames.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!(prepared["kind"], "fixture-prepared", "{prepared}");
    let live = live_mcp_binding(serde_json::from_value(prepared["live"].clone()).unwrap()).unwrap();
    let mut schemas = live.binding.tools.clone();
    schemas.sort_by(|a, b| a.name.cmp(&b.name));
    let policy: Arc<dyn AgentPolicy> = Arc::new(Policy {
        read: schemas
            .iter()
            .find(|s| s.name == "mcp_read_resource")
            .unwrap()
            .clone(),
    });
    let binding: RequestBinding = serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
        "connection_identity":"fixture","provider_family":"openai-responses","model":"fixture","credential_ref":null,
        "configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"instruction_sources":[],"memory_checkpoint":null,
        "attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":submitted.input_id}})).unwrap();
    let mut launch = varin_runtime::catalog::launches::LaunchSelection::from_binding(
        &binding,
        policy.identity(),
        None,
    );
    launch.mcp_binding = Some(live.binding.clone());
    db.bind_launch(&run, launch).unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let (tx, frames) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(tx.into());
    bridge.initialize(EPOCH);
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone());
    let prepared = tools
        .prepare_scope(&run, vec![], Some(live), vec![])
        .unwrap();
    let executor = tools.install(&run, 1, prepared).unwrap();
    let views = Arc::new(Mutex::new(Vec::new()));
    let wires = Arc::new(Mutex::new(Vec::new()));
    let execution = runtime
        .start(
            &run,
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
    std::thread::spawn(move || {
        let _ = done_tx.send(execution.wait());
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut permissions = 0;
    let report = loop {
        assert!(Instant::now() < deadline, "MCP chain stalled");
        while let Ok(frame) = frames.try_recv() {
            host.send(frame);
        }
        if let Ok(report) = done.try_recv() {
            break report.unwrap();
        }
        let frame = match host.frames.recv_timeout(Duration::from_millis(5)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(error) => panic!("{error}"),
        };
        match frame["kind"].as_str().unwrap() {
            "fixture-request" => {
                let method = frame["method"].as_str().unwrap();
                let params = frame["params"].clone();
                crate::protocol::validate_method_params(method, &params).unwrap();
                let result = operation_commands::execute(
                    runtime.clone(),
                    method,
                    params.clone(),
                    &AtomicBool::new(false),
                )
                .unwrap();
                host.send(
                    json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":result}),
                );
                if method == "runtime.permission.open" {
                    permissions += 1;
                    let catalog = runtime.catalog();
                    let db = catalog.lock().unwrap();
                    let op = db
                        .operation(params["operationId"].as_str().unwrap())
                        .unwrap();
                    assert!(
                        op.waiting_on.is_some(),
                        "real permission Wait precedes dispatch"
                    );
                    drop(db);
                    // Only the user's click is controlled. Original PermissionService and
                    // Catalog still decide and consume this exact one-action scope.
                    host.send(json!({"kind":"fixture-permission","operationId":params["operationId"],"permissionId":params["permissionId"]}));
                }
            }
            "host-tool-receipt" => {
                serde_json::from_value::<LateReceipt>(frame.clone())
                    .unwrap()
                    .apply(&runtime.catalog())
                    .unwrap();
                host.send(json!({"v":1,"kind":"host-tool-receipt-ack","kernelEpoch":EPOCH,"id":frame["id"],"accepted":true}));
            }
            "host-tool-response" => bridge.receive(frame),
            "host-tool-revoked" => panic!("unexpected revocation: {frame}"),
            _ => panic!("unexpected Host frame: {frame}"),
        }
    };
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    assert_eq!(
        permissions, 11,
        "all remote reads/calls use original one-action permission"
    );
    let final_view = views.lock().unwrap().last().unwrap().clone();
    let final_wire = wires.lock().unwrap().last().unwrap().clone();
    assert_eq!(views.lock().unwrap().len(), 7);
    let owner = runtime.catalog();
    let mut reads = Vec::new();
    for id in ["picture", "resource", "prompt"] {
        let result = final_view
            .history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == id => Some(result),
                _ => None,
            })
            .unwrap();
        let ToolCompletion::Result {
            outcome,
            effect,
            content,
        } = &result.completion
        else {
            panic!("original Result")
        };
        assert_eq!((*outcome, *effect), (Outcome::Succeeded, Effect::Confirmed));
        assert!(!content.data.to_string().contains(PIXEL));
        assert_eq!(
            content
                .parts
                .iter()
                .filter(|p| matches!(p, OutputPart::Media { .. }))
                .count(),
            1
        );
        let output = final_wire["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call_output" && item["call_id"] == id)
            .unwrap()["output"]
            .as_array()
            .unwrap();
        assert_eq!(
            output
                .iter()
                .filter(|part| part["type"] == "input_image")
                .count(),
            1
        );
        assert!(output
            .iter()
            .filter(|part| part["type"] == "input_text")
            .all(|part| !part["text"].as_str().unwrap().contains(PIXEL)));
        match id {
            "picture" => {
                assert_eq!(
                    content.data["structuredContent"]["echo"]["media"]["data_base64"],
                    "opaque ordinary JSON"
                );
                assert_eq!(content.data["content"][0]["_meta"]["outputPartIndex"], 777);
                assert_eq!(content.data["content"][4]["nested"]["data"], "ordinary");
            }
            "resource" => assert_eq!(content.data["contents"][1]["uri"], "asset://not-listed"),
            "prompt" => {
                assert_eq!(content.data["messages"][1]["role"], "assistant");
                assert_eq!(
                    content.data["messages"][2]["content"]["resource"]["uri"],
                    "asset://embedded"
                );
            }
            _ => unreachable!(),
        }
        let operation_id = ToolOrigin::ModelStep {
            request_id: result.request_id.clone(),
        }
        .operation_id(id);
        let capture = {
            let db = owner.lock().unwrap();
            db.capture_operation_read(db.operation(&operation_id).unwrap())
        };
        let operation = capture.load().unwrap();
        let ToolCompletion::Result {
            content: stored, ..
        } = operation.call_completion.unwrap()
        else {
            panic!("persisted completion")
        };
        assert_eq!(stored.data, content.data);
        for (index, part) in stored.parts.iter().enumerate() {
            let OutputPart::Media { media: descriptor } = part else {
                continue;
            };
            let params: MediaReadParams = serde_json::from_value(json!({"threadId":"thread","branchId":"main",
                "holder":{"kind":"history","itemId":format!("{}:result:{id}",result.request_id)},"partIndex":index,"chunkIndex":0,
                "expectedContentRef":descriptor.content_ref.content_object})).unwrap();
            let bytes = media(&owner, &params);
            assert_eq!(&bytes[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
            reads.push((params, bytes));
        }
    }
    let evidence: PolicyEvidenceRef =
        serde_json::from_value(report.policy_state["evidence"].clone()).unwrap();
    let policy_origin = ToolOrigin::PolicyAction {
        action_id: evidence.action_id.clone(),
        node_id: evidence.node_id.clone(),
    };
    let operation_id = policy_origin.operation_id("policy-resource");
    let capture = {
        let db = owner.lock().unwrap();
        db.capture_operation_read(db.operation(&operation_id).unwrap())
    };
    let operation = capture.load().unwrap();
    let ToolCompletion::Result { content, .. } = operation.call_completion.unwrap() else {
        panic!("original policy Result")
    };
    assert_eq!(content.data["contents"][0]["uri"], "asset://policy");
    let (index, descriptor) = content
        .parts
        .iter()
        .enumerate()
        .find_map(|(index, part)| match part {
            OutputPart::Media { media } => Some((index, media)),
            _ => None,
        })
        .unwrap();
    let varin_runtime::output::OutputSource::Tool { context } = &descriptor.source else {
        panic!("real policy source")
    };
    assert_eq!(context.origin, policy_origin);
    let params: MediaReadParams = serde_json::from_value(json!({"threadId":"thread","branchId":"main","holder":{"kind":"policy_evidence","reference":evidence},
        "partIndex":index,"chunkIndex":0,"expectedContentRef":descriptor.content_ref.content_object})).unwrap();
    let bytes = media(&owner, &params);
    reads.push((params, bytes));
    assert!(final_view.history.iter().all(|item| !matches!(&item.content, Content::ToolResult { result } if result.call_id == "policy-resource")), "policy work does not fabricate a model exchange");
    let fork = {
        let db = owner.lock().unwrap();
        db.prepare_branch_fork("main", "fork", db.head("main").unwrap().as_deref(), None)
            .unwrap()
    }
    .load()
    .unwrap();
    owner.lock().unwrap().admit_branch_fork(fork).unwrap();
    let collection = {
        owner
            .lock()
            .unwrap()
            .prepare_content_collection(Default::default())
    }
    .run();
    assert_eq!(
        collection.status,
        varin_runtime::ContentCollectionStatus::Completed,
        "{:?}",
        collection.reason
    );
    for (params, bytes) in &reads {
        assert_eq!(&media(&owner, params), bytes);
    }
    host.send(json!({"kind":"fixture-finish"}));
    let finished = loop {
        let frame = host.frames.recv_timeout(Duration::from_secs(5)).unwrap();
        if frame["kind"] == "fixture-finished" {
            break frame;
        }
        if frame["kind"] == "host-tool-response" {
            bridge.receive(frame);
        } else {
            panic!("unexpected finish frame {frame}");
        }
    };
    let requests = finished["requests"].as_array().unwrap();
    for method in ["tools/call", "resources/read", "prompts/get"] {
        assert_eq!(
            requests.iter().filter(|q| q["method"] == method).count(),
            if method == "resources/read" { 2 } else { 1 },
            "no content fetch or effect replay"
        );
    }
    assert!(
        requests
            .iter()
            .filter(|q| q["server"] == "promptsOnly")
            .all(|q| q["method"] == "initialize"),
        "unavailable capability must not enter a remote request"
    );
    assert_eq!(
        requests
            .iter()
            .find(|q| q["method"] == "resources/read")
            .unwrap()["params"]["uri"],
        "asset://not-listed"
    );
    let http = finished["httpRequests"].as_array().unwrap();
    assert_eq!(
        http.iter().filter(|q| q["method"] == "initialize").count(),
        2
    );
    let http_reads: Vec<_> = http
        .iter()
        .filter(|q| q["method"] == "resources/read")
        .collect();
    assert_eq!(
        http_reads.len(),
        2,
        "one request per distinct operation; expired operation is never replayed"
    );
    assert_eq!(http_reads[0]["session"], "session-1");
    assert_eq!(http_reads[0]["params"]["uri"], "asset://expiry-first");
    assert_eq!(http_reads[1]["session"], "session-2");
    assert_eq!(http_reads[1]["params"]["uri"], "asset://expiry-next");
    bridge.close();
    drop(host);
    drop(tools);
    drop(owner);
    drop(runtime);
    let reopened = Arc::new(Mutex::new(Catalog::open(&catalog_path).unwrap()));
    for (mut params, bytes) in reads {
        assert_eq!(media(&reopened, &params), bytes);
        if !matches!(params.holder, OutputMediaHolder::History { .. }) {
            continue;
        }
        params.branch_id = "fork".into();
        assert_eq!(
            media(&reopened, &params),
            bytes,
            "fork and reopen retain original MCP bytes without a connection"
        );
    }
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}
