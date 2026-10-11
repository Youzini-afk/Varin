//! Original MCP integration fixture: Rust owners, Host bridge and real stdio; no product socket.
use super::*;
use crate::host_tools::{LateReceipt, ToolBridge};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};
use varin_runtime::execution::*;

pub(super) const EPOCH: &str = "mcp-task-review";
pub(super) struct Host {
    pub(super) child: Child,
    pub(super) input: ChildStdin,
    pub(super) frames: mpsc::Receiver<Value>,
    pub(super) responses: mpsc::Sender<Value>,
    pub(super) cursor: u64,
    pub(super) permissions: usize,
    pub(super) reject_acceptance_reply: bool,
    pub(super) interrupted_acceptance: bool,
    pub(super) hold_acceptance: bool,
    expected_resource_diagnostics: Vec<String>,
}
impl Host {
    pub(super) fn new() -> Self {
        let mut child =
            Command::new(std::env::var_os("VARIN_NODE").unwrap_or_else(|| "node".into()))
                .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
                .args([
                    "--import",
                    "tsx",
                    "packages/web/application-host/lib/kernel/mcp-review-host.test-helper.ts",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, frames) = mpsc::channel();
        let responses = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let frame = serde_json::from_str(&line)
                    .unwrap_or_else(|_| panic!("invalid Host frame: {line}"));
                if tx.send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            frames,
            responses,
            cursor: 0,
            permissions: 0,
            reject_acceptance_reply: false,
            interrupted_acceptance: false,
            hold_acceptance: false,
            expected_resource_diagnostics: Vec::new(),
        }
    }
    pub(super) fn send(&mut self, frame: Value) {
        writeln!(self.input, "{frame}").unwrap();
        self.input.flush().unwrap();
    }
    pub(super) fn pump(
        &mut self,
        runtime: &Arc<RunSupervisor>,
        bridge: &ToolBridge,
        outgoing: &mpsc::Receiver<Value>,
    ) -> Option<Value> {
        while let Ok(frame) = outgoing.try_recv() {
            self.send(frame);
        }
        let read = runtime
            .catalog()
            .lock()
            .unwrap()
            .capture_events_read(self.cursor, 256)
            .unwrap();
        for event in read.load().unwrap() {
            self.cursor = event.cursor;
            self.send(json!({"kind":"fixture-event","event":event}));
        }
        let frame = match self.frames.recv_timeout(Duration::from_millis(5)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => return None,
            Err(error) => panic!("MCP Host closed: {error}"),
        };
        match frame["kind"].as_str().unwrap() {
            "fixture-request" => {
                let method = frame["method"].as_str().unwrap();
                let params = frame["params"].clone();
                crate::protocol::validate_method_params(method, &params).unwrap();
                if method == "runtime.tools.invoke" {
                    let p: crate::protocol_generated::NestedToolInvokeParams =
                        serde_json::from_value(params).unwrap();
                    let nested = runtime.catalog().lock().unwrap().nested_tools();
                    let responses = self.responses.clone();
                    let id = frame["id"].clone();
                    thread::spawn(move || {
                        let result =
                            nested.invoke(&p.parent_operation_id, &p.executor_owner, p.call);
                        let frame = match result {
                            Ok(value) => {
                                json!({"kind":"fixture-response","id":id,"ok":true,"result":value})
                            }
                            Err(error) => {
                                json!({"kind":"fixture-response","id":id,"ok":false,"error":error.to_string()})
                            }
                        };
                        let _ = responses.send(frame);
                    });
                    return None;
                }
                let acceptance = matches!(
                    method,
                    "runtime.host_job.accept" | "runtime.mcp.resource.accept"
                );
                let result = if acceptance && self.hold_acceptance {
                    self.interrupted_acceptance = true;
                    Err(KernelError::Operation(
                        "fixture: original acceptance was unavailable before commit".into(),
                    ))
                } else if method == "runtime.operation.cancel" {
                    let p: OperationParams = serde_json::from_value(params.clone()).unwrap();
                    let op = runtime
                        .catalog()
                        .lock()
                        .unwrap()
                        .operation(&p.operation_id)
                        .unwrap();
                    assert!(op.mcp_resource_subscription.is_some() && op.managed_process.is_none());
                    // This fixture has only external MCP observers, not process/question teardown.
                    // Use the same original supervisor control and short receipt as ControlCommands.
                    runtime
                        .cancel_operation(&p.operation_id)
                        .map(|op| operation_cancellation_receipt(&op))
                        .map_err(|error| KernelError::Operation(error.to_string()))
                } else if method.starts_with("runtime.mcp.resource.") {
                    mcp_resource_commands::execute(
                        runtime.clone(),
                        method,
                        params.clone(),
                        &AtomicBool::new(false),
                    )
                } else if method.starts_with("runtime.host_job.") {
                    host_job_commands::execute(
                        runtime.clone(),
                        method,
                        params.clone(),
                        &AtomicBool::new(false),
                    )
                } else if method == "runtime.launch.inspect" {
                    let read = runtime
                        .catalog()
                        .lock()
                        .unwrap()
                        .capture_launch(params["runId"].as_str().unwrap())
                        .unwrap();
                    Ok(serde_json::to_value(read.map(|read| read.load().unwrap())).unwrap())
                } else if method == "runtime.run.inspect" {
                    dispatch(
                        &mut runtime.catalog().lock().unwrap(),
                        method,
                        params.clone(),
                    )
                } else if method == "runtime.observations.reconcile" {
                    Ok(serde_json::to_value(runtime.reconcile_observations().unwrap()).unwrap())
                } else {
                    operation_commands::execute(
                        runtime.clone(),
                        method,
                        params.clone(),
                        &AtomicBool::new(false),
                    )
                };
                let result = if acceptance && self.reject_acceptance_reply && result.is_ok() {
                    self.reject_acceptance_reply = false;
                    self.interrupted_acceptance = true;
                    Err(KernelError::Operation(
                        "fixture: original accepted commit reply was interrupted".into(),
                    ))
                } else {
                    result
                };
                if method == "runtime.mcp.resource.accept" && self.interrupted_acceptance {
                    if let Err(error) = &result {
                        self.expected_resource_diagnostics.push(error.to_string());
                    }
                }
                if method == "runtime.mcp.resource.notify" {
                    if let Err(error) = &result {
                        let db = runtime.catalog();
                        let db = db.lock().unwrap();
                        let op = db
                            .operation(params["binding"]["operationId"].as_str().unwrap())
                            .unwrap();
                        let observer = op.mcp_resource_subscription.as_ref().unwrap();
                        // A captured fact may lose its original listener's admission fence.
                        // Accept this diagnostic only after checking the actual Catalog state.
                        if (op.cancel_requested
                            || observer.local_released
                            || observer.listener_id.as_deref() != params["listenerId"].as_str())
                            && matches!(error, KernelError::Operation(message) if message == "conflict: MCP resource listener no longer admits notifications")
                        {
                            self.expected_resource_diagnostics.push(error.to_string());
                        }
                    }
                }
                match result {
                    Ok(value) => self.send(json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":value})),
                    Err(error) => self.send(json!({"kind":"fixture-response","id":frame["id"],"ok":false,"error":error.to_string()})),
                }
                if method == "runtime.permission.open" {
                    self.permissions += 1;
                    assert!(
                        runtime
                            .catalog()
                            .lock()
                            .unwrap()
                            .operation(params["operationId"].as_str().unwrap())
                            .unwrap()
                            .waiting_on
                            .is_some()
                    );
                    self.send(json!({"kind":"fixture-permission","operationId":params["operationId"],"permissionId":params["permissionId"]}));
                }
                None
            }
            "host-tool-receipt" => {
                let result = serde_json::from_value::<LateReceipt>(frame.clone())
                    .unwrap()
                    .apply(&runtime.catalog());
                // Mirror the production receipt command: read-only calls have no durable Operation.
                // Their ordinary response still commits the original model/policy result.
                let accepted = match result {
                    Ok(()) => true,
                    Err(
                        KernelError::Authorization(_)
                        | KernelError::Protocol(_)
                        | KernelError::Operation(_),
                    ) => false,
                    Err(error) => panic!("unexpected original receipt storage failure: {error}"),
                };
                self.send(json!({"v":1,"kind":"host-tool-receipt-ack","kernelEpoch":EPOCH,"id":frame["id"],"accepted":accepted}));
                None
            }
            "host-tool-response" | "host-tool-revoked" => {
                bridge.receive(frame);
                None
            }
            "fixture-response" => {
                self.send(frame);
                None
            }
            "fixture-task-error" => {
                assert!(
                    self.interrupted_acceptance,
                    "unexpected task error: {frame}"
                );
                assert!(
                    matches!(
                        frame["code"].as_str(),
                        Some(
                            "operation error: fixture: original accepted commit reply was interrupted"
                        ) | Some(
                            "operation error: fixture: original acceptance was unavailable before commit"
                        )
                    ),
                    "unexpected task diagnostic: {frame}"
                );
                None
            }
            "fixture-resource-error" => {
                let code = frame["code"].as_str().unwrap();
                let index = self
                    .expected_resource_diagnostics
                    .iter()
                    .position(|value| value == code)
                    .unwrap_or_else(|| panic!("unexpected resource diagnostic: {frame}"));
                self.expected_resource_diagnostics.remove(index);
                None
            }
            "fixture-prepared" | "fixture-finished" | "fixture-child-prepared" => Some(frame),
            _ => panic!("unexpected Host frame: {frame}"),
        }
    }
    pub(super) fn until(
        &mut self,
        runtime: &Arc<RunSupervisor>,
        bridge: &ToolBridge,
        outgoing: &mpsc::Receiver<Value>,
        mut condition: impl FnMut() -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !condition() {
            assert!(Instant::now() < deadline, "original MCP lifecycle stalled");
            assert!(self.pump(runtime, bridge, outgoing).is_none());
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub(super) fn model_configuration() -> Value {
    json!({"providerFamily":"openai-responses","endpoint":"https://fixture.invalid/responses","allowAnonymous":true,"model":"fixture","configurationGeneration":1})
}
pub(super) fn submit(db: &mut Catalog, key: &str) -> varin_runtime::Receipt {
    let prepared = db
        .prepare_submission(
            SubmitInput {
                key: key.into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: db.head("main").unwrap(),
                input: json!({"text":"Use the original remote work"}),
                configuration: model_configuration(),
            },
            None,
            None,
        )
        .unwrap();
    db.admit_submission(prepared.load(None, false).unwrap())
        .unwrap()
}
pub(super) fn request_binding(
    live: &crate::host_tools::LiveMcpBinding,
    receipt: &varin_runtime::Receipt,
) -> RequestBinding {
    let mut schemas = live.binding.tools.clone();
    schemas.sort_by(|a, b| a.name.cmp(&b.name));
    let model = varin_runtime::catalog::dispatch::ChildModelBinding {
        configuration: serde_json::from_value(model_configuration()).unwrap(),
        credential_scope: None,
    };
    serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
        "connection_identity":model.connection_identity().unwrap(),"provider_family":"openai-responses","model":"fixture","credential_ref":null,
        "configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"instruction_sources":[],"memory_checkpoint":null,
        "attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":receipt.input_id}})).unwrap()
}
