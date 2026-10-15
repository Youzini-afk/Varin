//! Actual RunAssembly/MemoryTools and the Host MemoryBridge/MemoryOwner/AgentPersonalization.
//! Only the Host's atomic Storage record primitives and outer extension callback are controlled
//! fixtures. The Node helper uses test stdio, not the product Kernel socket transport.
use super::*;
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use varin_runtime::nested_tools::NestedToolInput;

struct MemoryHost {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<Value>,
    reader: Option<std::thread::JoinHandle<()>>,
}
impl MemoryHost {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child =
            Command::new(std::env::var_os("VARIN_NODE").unwrap_or_else(|| "node".into()))
                .current_dir(&root)
                .args([
                    "--import",
                    "tsx",
                    "packages/web/application-host/lib/kernel/nested-memory-host.test-helper.ts",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx
                    .send(serde_json::from_str(&line).expect("original Host memory response"))
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output,
            reader: Some(reader),
        }
    }
    fn frame(&mut self, frame: &Value) -> Value {
        writeln!(self.input.as_mut().unwrap(), "{frame}").unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        let response = self
            .output
            .recv_timeout(Duration::from_secs(15))
            .expect("actual Host owner response");
        assert_eq!(response["id"], frame["id"]);
        assert_eq!(response["kernelEpoch"], frame["kernelEpoch"]);
        assert_eq!(response["result"]["status"], "ready", "{response}");
        response
    }
}
impl Drop for MemoryHost {
    fn drop(&mut self) {
        self.input.take();
        // This is only the test helper; no product executor or script environment is replaced.
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
struct Model {
    first: Option<ToolCall>,
    turns: AtomicUsize,
    snapshots: Arc<Mutex<Vec<RequestView>>>,
}
impl ModelProvider for Model {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        self.snapshots.lock().unwrap().push(view.clone());
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let call = (self.turns.fetch_add(1, Ordering::SeqCst) == 0)
            .then_some(self.first.as_ref())
            .flatten();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: request.view.request_id.clone(),
                opaque: None,
                content: call.map_or(
                    Content::Text {
                        text: "Done".into(),
                    },
                    |call| Content::ToolCall { call: call.clone() },
                ),
            },
        })
        .unwrap();
        Ok(if call.is_some() {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}

#[test]
#[ignore = "requires workspace Node/tsx and built protocol; no socket or provider is used"]
fn nested_memory_uses_original_host_owner_and_delivers_once_without_outer_echo() {
    for model_origin in [false, true] {
        let f = Fixture::with_tools(
            false,
            vec![crate::memory::schema(true)],
            vec!["helper".into(), "memory".into()],
        );
        let mut host = MemoryHost::new();
        f.prepare_policy(0, "http://127.0.0.1:1/unused");
        let mut start = f.start(0);
        let helper = start
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == "helper")
            .unwrap();
        let call = ToolCall {
            call_id: "compose".into(),
            name: helper.name.clone(),
            schema_version: helper.version.clone(),
            arguments: json!({}),
        };
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        start.provider = Arc::new(Model {
            first: model_origin.then_some(call.clone()),
            turns: AtomicUsize::new(0),
            snapshots: snapshots.clone(),
        });
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
        let (tx, done) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            tx.send(engine.run(input, CancellationToken::default()))
                .unwrap()
        });
        let (nested_tx, nested_rx) = mpsc::channel();
        let mut nested_worker = None;
        let mut outer_frame = None;
        let mut nested_operation = None;
        let mut mutation_pair = None;
        let deadline = Instant::now() + Duration::from_secs(40);
        let report = loop {
            assert!(Instant::now() < deadline, "nested memory execution stalled");
            if let Ok(result) = nested_rx.try_recv() {
                let receipt: varin_runtime::nested_tools::NestedToolReceipt = result;
                assert!(matches!(
                    receipt.completion,
                    ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: varin_runtime::Effect::Confirmed,
                        ..
                    }
                ));
                nested_operation = Some(receipt.operation_id);
                let frame: Value = outer_frame.take().unwrap();
                // Omit the receipt in both cases; the policy callback also fails after the write.
                // Neither outer success nor echoed content owns memory commit/delivery.
                let outcome = if model_origin { "succeeded" } else { "failed" };
                f.assembly.tools.bridge().receive(json!({"v":1,"kind":"host-tool-response","id":frame["id"],"kernelEpoch":EPOCH,"ok":true,
                    "completion":{"kind":"result","outcome":outcome,"effect":"confirmed","content":{"data":{"message":"Callback finished"},"parts":[]}},"executor_stopped":true}));
            }
            if let Ok(report) = done.try_recv() {
                break report.unwrap();
            }
            let frame = match f.frames.recv_timeout(Duration::from_millis(10)) {
                Ok(frame) => frame,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(error) => panic!("{error}"),
            };
            match frame["kind"].as_str().unwrap() {
                "memory-request" => {
                    assert_eq!(frame["query"]["runId"], f.run.id);
                    assert_eq!(frame["query"]["scope"]["threadId"], f.run.thread_id);
                    let response = host.frame(&frame);
                    if frame["query"]["action"] == "tool"
                        && frame["query"]["arguments"]["action"] == "save"
                    {
                        mutation_pair = Some((frame.clone(), response.clone()));
                    }
                    f.assembly.memory.receive(response);
                }
                "host-tool-request" if frame["phase"] == "authorize" => {
                    f.assembly.tools.bridge().receive(json!({"v":1,"kind":"host-tool-response","id":frame["id"],"kernelEpoch":EPOCH,"ok":true}));
                }
                "host-tool-request" => {
                    assert_eq!(frame["phase"], "execute");
                    assert_eq!(
                        frame["call"]["origin"]["kind"],
                        if model_origin {
                            "model_step"
                        } else {
                            "policy_action"
                        }
                    );
                    let parent = frame["call"]["operationId"].as_str().unwrap().to_owned();
                    let owner = varin_runtime::ExecutorOwner::External {
                        identity: frame["binding"]["reference"].as_str().unwrap().into(),
                        epoch: frame["binding"]["ownerId"].as_str().unwrap().into(),
                    };
                    let registry = f.catalog().lock().unwrap().nested_tools();
                    let tx = nested_tx.clone();
                    nested_worker = Some(std::thread::spawn(move || {
                        tx.send(registry.invoke(&parent, &owner, NestedToolInput { call_id: "save".into(), name: "memory".into(),
                            arguments: json!({"action":"save","scope":"currentThread","revision":0,"content":"Original nested memory fact"}) }).unwrap()).unwrap();
                    }));
                    outer_frame = Some(frame);
                }
                "agent-policy-request" => {
                    let event = frame["input"]["event"]["kind"].as_str().unwrap();
                    let action = match event {
                        "started" if !model_origin => {
                            json!({"kind":"tool_graph","nodes":[{"id":call.call_id,"depends_on":[],"call":call}]})
                        }
                        "started" | "tools_completed" | "tool_graph_completed" => {
                            json!({"kind":"request_model"})
                        }
                        "model_completed"
                            if frame["input"]["event"]["tool_calls"].as_u64().unwrap_or(0) > 0 =>
                        {
                            json!({"kind":"execute_tools"})
                        }
                        "model_completed" => json!({"kind":"complete"}),
                        _ => panic!("unexpected policy event {event}"),
                    };
                    f.reply(&frame, json!({"state":{},"action":action}));
                }
                _ => assert!(f.ordinary_frame(&frame), "unexpected frame {frame}"),
            }
        };
        worker.join().unwrap();
        nested_worker.take().unwrap().join().unwrap();
        assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
        let snapshots = snapshots.lock().unwrap();
        let last = snapshots.last().unwrap();
        let facts: Vec<_> = last.history.iter().filter(|item| matches!(&item.provenance, Provenance::EnvironmentFact { event_id } if event_id.starts_with("memory:"))).collect();
        assert_eq!(
            facts.len(),
            1,
            "one original memory fact in the next actual request"
        );
        let op_id = nested_operation.unwrap();
        assert!(serde_json::to_string(facts[0]).unwrap().contains(&op_id));
        assert!(last.history.iter().all(|item| !matches!(&item.content, Content::ToolResult { result } if result.call_id == "save")), "nested tool must never create a model result pair");
        drop(snapshots);
        let (mut original, saved) = mutation_pair.unwrap();
        let read = {
            let catalog = f.catalog();
            let db = catalog.lock().unwrap();
            db.capture_operation_read(db.operation(&op_id).unwrap())
        };
        let before = read.load().unwrap();
        assert_eq!(before.intent["origin"]["kind"], "nested_call");
        assert_eq!(
            before.result.as_ref().unwrap().output().unwrap().data["memoryReceipt"],
            saved["result"]["memoryReceipt"]
        );
        let f = f.reopen();
        let read = {
            let catalog = f.catalog();
            let db = catalog.lock().unwrap();
            db.capture_operation_read(db.operation(&op_id).unwrap())
        };
        let after = read.load().unwrap();
        assert_eq!(before.result, after.result);
        original["id"] = json!("receipt-after-reopen");
        original["query"]["action"] = json!("receipt");
        let recovered = host.frame(&original);
        assert_eq!(
            recovered["result"], saved["result"],
            "query the original domain receipt, never replay the write"
        );
        original["id"] = json!("read-after-reopen");
        original["query"]["action"] = json!("tool");
        original["query"]["arguments"] = json!({"action":"read","scope":"currentThread"});
        let read = host.frame(&original);
        assert_eq!(read["result"]["revision"], 1);
        assert_eq!(read["result"]["notes"].as_array().unwrap().len(), 1);
        f.finish();
    }
}
