//! Original Engine → Host scripts → Storage guardian → persistent Node → nested owner.
//! Test stdio substitutes only transport. Provider output, Documents admission and installed
//! extension loading are controlled; no fake process, evaluator, Catalog or source grant runs.
use super::*;
use crate::host_query::OwnerChannel;
use crate::host_tools::{LiveExtensionBinding, ToolBridge};
use crate::storage::{Storage, process_interactions};
use crate::tools::{KernelResourceClient, serve_resource};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};
use varin_runtime::catalog::{
    context::ContextProposal,
    launches::{ExtensionToolBinding, LaunchSelection, SourceSelection},
};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
const HOST: &str = "managed-script-host";
const GENERATION: &str = "managed-script-generation";
const EPOCH: &str = "managed-script-epoch";

struct NodeHost {
    child: Child,
    input: Arc<Mutex<Option<ChildStdin>>>,
    output: mpsc::Receiver<Value>,
}
impl NodeHost {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child =
            Command::new(std::env::var_os("VARIN_NODE").unwrap_or_else(|| "node".into()))
                .current_dir(root)
                .args([
                    "--import",
                    "tsx",
                    "packages/web/application-host/lib/kernel/managed-script-host.test-helper.ts",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
        let input = Arc::new(Mutex::new(child.stdin.take()));
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let frame = serde_json::from_str(&line)
                    .unwrap_or_else(|_| panic!("invalid Host fixture frame: {line}"));
                if tx.send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output,
        }
    }
    fn send(&self, value: Value) {
        send(&self.input, value);
    }
}
fn send(input: &Arc<Mutex<Option<ChildStdin>>>, value: Value) {
    if let Some(stdin) = input.lock().unwrap().as_mut() {
        writeln!(stdin, "{value}").unwrap();
        stdin.flush().unwrap();
    }
}
impl Drop for NodeHost {
    fn drop(&mut self) {
        self.input.lock().unwrap().take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
struct FinalModel {
    requests: Arc<Mutex<Vec<RequestView>>>,
}
impl ModelProvider for FinalModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        self.requests.lock().unwrap().push(view.clone());
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: request.view.request_id.clone(),
                opaque: None,
                content: Content::Text {
                    text: "Observed committed note".into(),
                },
            },
        })
        .unwrap();
        Ok(FinishReason::Stop)
    }
}
/// The original provider compiler runs; generation is a finite controlled model, without HTTP.
struct MediaModel {
    requests: Arc<Mutex<Vec<RequestView>>>,
    wires: Arc<Mutex<Vec<Value>>>,
}
impl ModelProvider for MediaModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
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
            .serialize(view)?;
        self.requests.lock().unwrap().push(view.clone());
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
        let environment = results.iter().find_map(|result| match &result.completion {
            ToolCompletion::JobAccepted { operation_id, .. } if result.call_id == "media-open" => {
                Some(operation_id.clone())
            }
            _ => None,
        });
        let calls = match results.len() {
            0 => vec![("media-open", "script_open", json!({}))],
            1 => vec![
                (
                    "direct-image",
                    "computer_observe",
                    json!({"desktopId":"local-console","app":"fixture-editor","includeScreenshot":true}),
                ),
                (
                    "media-cell",
                    "script_run",
                    json!({"environmentId":environment.unwrap(),"script":
                    "const nested = await tools.invoke({callId:'nested-action',name:'computer_act',arguments:{desktopId:'local-console',action:{kind:'key',app:'fixture-editor',key:'enter',returnState:'screenshot'}}}); if(nested.completion.kind!=='result') throw Error('missing original Computer result'); const first=nested.completion.content.parts.find(part=>part.kind==='media'); if(!first) throw Error('Computer did not produce typed image'); print('before-media'); emitImage(first.media); print('after-media'); await tools.invoke({callId:'unforwarded-image',name:'computer_observe',arguments:{desktopId:'local-console',app:'fixture-editor',includeScreenshot:true}}); await tools.invoke({callId:'save-note',name:'memory',arguments:{action:'save',scope:'currentThread',revision:0,content:'Original note beside explicit image'}}); print({kind:'media',media:{data_base64:'opaque ordinary JSON'}}); throw Error('outer fails after explicit image');"}),
                ),
            ],
            3 => vec![(
                "media-close",
                "script_close",
                json!({"environmentId":environment.unwrap()}),
            )],
            4 => {
                emit(ProviderEvent::ItemCompleted {
                    item: ProviderItem {
                        id: format!("{}:answer", request.view.request_id),
                        opaque: None,
                        content: Content::Text {
                            text: "Original image and receipt consumed".into(),
                        },
                    },
                })
                .unwrap();
                return Ok(FinishReason::Stop);
            }
            count => panic!("unexpected original model tool pairing count {count}"),
        };
        for (id, name, arguments) in calls {
            let schema = request
                .view
                .binding
                .tools
                .iter()
                .find(|tool| tool.name == name)
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

fn assert_media_request(view: &RequestView, wire: &Value) {
    const PIXEL: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7h8AAAAASUVORK5CYII=";
    let results: Vec<_> = view
        .history
        .iter()
        .filter_map(|item| match &item.content {
            Content::ToolResult { result } => Some(result),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 4);
    assert!(
        results
            .iter()
            .all(|r| !["nested-action", "unforwarded-image", "save-note"]
                .contains(&r.call_id.as_str())),
        "nested calls cannot fabricate model exchanges"
    );
    let mut image_count = 0;
    for call_id in ["direct-image", "media-cell"] {
        let result = results
            .iter()
            .find(|result| result.call_id == call_id)
            .unwrap();
        let ToolCompletion::Result {
            outcome, content, ..
        } = &result.completion
        else {
            panic!("actual result required")
        };
        assert_eq!(
            *outcome,
            if call_id == "media-cell" {
                Outcome::Failed
            } else {
                Outcome::Succeeded
            }
        );
        let images: Vec<_> = content
            .parts
            .iter()
            .filter_map(|part| match part {
                OutputPart::Media { media } => Some(media),
                _ => None,
            })
            .collect();
        assert_eq!(
            images.len(),
            1,
            "only explicitly forwarded inner image belongs to outer cell"
        );
        for media in images {
            assert_eq!(media.media_type, "image/png");
            assert_eq!(media.data_base64, PIXEL);
            let varin_runtime::output::OutputSource::Tool { context } = &media.source else {
                panic!("real outer invocation source required")
            };
            assert_eq!(
                context.origin,
                ToolOrigin::ModelStep {
                    request_id: result.request_id.clone()
                }
            );
            assert_eq!(
                context.operation_id,
                context.origin.operation_id(&result.call_id)
            );
            image_count += 1;
        }
        assert!(
            !content.data.to_string().contains(PIXEL),
            "image bytes must not also pollute ordinary data JSON"
        );
        let item = wire["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
            .unwrap();
        let parts = item["output"]
            .as_array()
            .expect("original Responses function output uses typed parts");
        let media: Vec<_> = parts
            .iter()
            .filter(|part| part["type"] == "input_image")
            .collect();
        assert_eq!(media.len(), 1);
        assert_eq!(
            media[0]["image_url"],
            format!("data:image/png;base64,{PIXEL}")
        );
        assert!(
            parts
                .iter()
                .filter(|part| part["type"] == "input_text")
                .all(|part| !part["text"].as_str().unwrap().contains(PIXEL))
        );
        if call_id == "media-cell" {
            let order: Vec<_> = content
                .parts
                .iter()
                .map(|part| match part {
                    OutputPart::Media { .. } => "image".to_string(),
                    OutputPart::Text { text } => text.clone(),
                })
                .collect();
            let before = order
                .iter()
                .position(|text| text.contains("before-media"))
                .unwrap();
            let image = order.iter().position(|text| text == "image").unwrap();
            let after = order
                .iter()
                .position(|text| text.contains("after-media"))
                .unwrap();
            assert!(
                before < image && image < after,
                "explicit text/image order survives the failed outer result"
            );
        }
    }
    assert_eq!(image_count, 2);
}

fn read_original_media(
    catalog: &Arc<Mutex<Catalog>>,
    params: &varin_runtime::output::MediaReadParams,
) -> Vec<u8> {
    let mut params = params.clone();
    let mut bytes = Vec::new();
    let mut count = 1;
    for index in 0.. {
        if index >= count {
            break;
        }
        params.chunk_index = index;
        let read = { catalog.lock().unwrap().capture_media_read(&params).unwrap() };
        let chunk = read.chunk(&|| false).unwrap();
        assert_eq!(chunk.chunk_index, index);
        assert_eq!(chunk.part_index, params.part_index);
        assert_eq!(
            chunk.media.content_ref.content_object,
            params.expected_content_ref
        );
        count = chunk.chunk_count;
        bytes.extend(
            base64::engine::general_purpose::STANDARD
                .decode(&chunk.bytes_base64)
                .unwrap(),
        );
        if index + 1 == count {
            assert_eq!(bytes.len() as u64, chunk.total_bytes);
        }
    }
    bytes
}

/// Public family JSON retains descriptors; only the same anchored owner hydrates actual bytes.
fn check_original_family_media(
    catalog: &Arc<Mutex<Catalog>>,
    reads: &[(varin_runtime::output::MediaReadParams, Vec<u8>)],
) {
    use varin_runtime::output::OutputMediaHolder;
    for (params, expected) in reads {
        let OutputMediaHolder::History { item_id } = &params.holder else {
            continue;
        };
        let capture = || {
            catalog
                .lock()
                .unwrap()
                .capture_family_read(
                    &params.thread_id,
                    Some(&params.thread_id),
                    Some(&params.branch_id),
                )
                .unwrap()
        };
        let page = capture()
            .read(
                serde_json::from_value(json!({
                    "query":{"kind":"recent","limit":100,"maxItemBytes":65536}
                }))
                .unwrap(),
                &|| false,
            )
            .unwrap();
        let item = page.items.iter().find(|item| &item.id == item_id).unwrap();
        assert!(!item.body_truncated);
        let body = item.body.clone().unwrap();
        // Strict StoredMedia decoding rejects inline-byte descriptors without interpreting opaque data.
        let original: ConversationItem<StoredMedia> = serde_json::from_value(body).unwrap();
        let Content::ToolResult { result } = original.content else {
            panic!("original family tool result")
        };
        let ToolCompletion::Result { content, .. } = result.completion else {
            panic!("original result")
        };
        let OutputPart::Media { media } = &content.parts[params.part_index] else {
            panic!("original media part")
        };
        assert_eq!(
            media.content_ref.content_object,
            params.expected_content_ref
        );
        let output = capture()
            .media_output(
                None,
                &page.anchor,
                item_id,
                params.part_index,
                &params.expected_content_ref,
                &|| false,
            )
            .unwrap();
        let [OutputPart::Media { media: resolved }] = output.parts.as_slice() else {
            panic!("explicit family image")
        };
        assert_eq!(&resolved.source, &media.source);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&resolved.data_base64)
                .unwrap(),
            *expected
        );
        let mut public = params.clone();
        public.holder = OutputMediaHolder::Family {
            thread_id: params.thread_id.clone(),
            branch_id: params.branch_id.clone(),
            run_id: None,
            anchor: page.anchor,
            item_id: item_id.clone(),
        };
        assert_eq!(read_original_media(catalog, &public), *expected);
        let read = catalog.lock().unwrap().capture_media_read(&public).unwrap();
        assert!(matches!(
            read.chunk(&|| true),
            Err(varin_runtime::RuntimeError::DispatchCancelled)
        ));
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scenario {
    TypedMedia,
    Persistence,
    CancelDrain,
    LostClose,
    KillFailure,
    RunEndJob,
}
struct Cells {
    schemas: Vec<ToolSchema>,
    scenario: Scenario,
}
impl AgentPolicy for Cells {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "managed-script-sequence".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        let stage = state["stage"].as_u64().unwrap_or(0);
        let mut next = state.clone();
        if !next.is_object() {
            next = json!({});
        }
        next["stage"] = json!(stage + 1);
        if stage > 0
            && stage
                <= match self.scenario {
                    Scenario::CancelDrain | Scenario::RunEndJob => 2,
                    Scenario::LostClose | Scenario::KillFailure => 6,
                    _ => 5,
                }
        {
            let PolicyEvent::ToolGraphCompleted { receipts, .. } = event else {
                panic!("actual tool graph result required: {event:?}")
            };
            assert_eq!(receipts.len(), 1);
            if stage == 1 {
                let PolicyNodeCompletion::JobAccepted { operation_id, .. } =
                    &receipts[0].completion
                else {
                    panic!("original environment admission failed: {receipts:?}")
                };
                next["environment"] = json!(operation_id);
            } else if self.scenario == Scenario::CancelDrain && stage == 2 {
                assert_eq!(
                    receipts[0].outcome(),
                    Outcome::Cancelled,
                    "synchronous cell cancels only after actual callbacks drain"
                );
            } else if self.scenario == Scenario::KillFailure && stage == 5 {
                assert_eq!(
                    receipts[0].outcome(),
                    Outcome::Succeeded,
                    "original independent Catalog control still stops the guardian after resource kill refusal"
                );
            } else if self.scenario == Scenario::LostClose && stage == 5 {
                assert_eq!(
                    receipts[0].outcome(),
                    Outcome::Failed,
                    "close callback ended; the original target receipt remains the effect authority"
                );
            } else if stage == 3 {
                assert_eq!(
                    receipts[0].outcome(),
                    Outcome::Failed,
                    "cell deliberately fails after nested commit"
                );
            } else {
                assert_eq!(receipts[0].outcome(), Outcome::Succeeded, "{receipts:?}");
            }
        }
        let env = next["environment"].clone();
        if self.scenario == Scenario::RunEndJob && stage == 2 {
            return Ok(PolicyDecision {
                action: PolicyAction::Complete,
                state: next,
            });
        }
        if self.scenario == Scenario::CancelDrain && stage >= 2 {
            return Ok(PolicyDecision {
                action: if stage == 2 {
                    PolicyAction::RequestModel
                } else {
                    assert!(matches!(event, PolicyEvent::ModelCompleted { .. }));
                    PolicyAction::Complete
                },
                state: next,
            });
        }
        if matches!(self.scenario, Scenario::LostClose | Scenario::KillFailure) && stage >= 6 {
            return Ok(PolicyDecision {
                action: if stage == 6 {
                    PolicyAction::RequestModel
                } else {
                    assert!(matches!(event, PolicyEvent::ModelCompleted { .. }));
                    PolicyAction::Complete
                },
                state: next,
            });
        }
        let (name, args) = match stage {
            1 if self.scenario == Scenario::RunEndJob => (
                "script_run",
                json!({"environmentId": env, "script": format!(
                    "const independent = await tools.invoke({}); if (independent.completion.kind !== 'job_accepted') throw Error('independent job was not accepted'); print(independent.operationId);",
                    json!({"callId":"independent","name":"process_spawn","arguments":{"cwd":"","command":std::env::var("VARIN_NODE").unwrap_or_else(|_| "node".into()),"args":["-e", "const fs = require('node:fs'); fs.writeFileSync('job-started','started'); const timer = setInterval(() => { if (fs.existsSync('job-release')) { fs.writeFileSync('job-result','survived'); clearInterval(timer); } }, 50);"],"mode":"pipe"}}))}),
            ),
            1 if self.scenario == Scenario::CancelDrain => (
                "script_run",
                json!({"environmentId":env,"script":"void tools.invoke({callId:'save-note',name:'memory',arguments:{action:'save',scope:'currentThread',revision:0,content:'A nested note before cancelling the real synchronous loop'}}); const fs = await import('node:fs'); fs.writeFileSync('loop-entered', 'ready'); for (;;) {}"}),
            ),
            5 if matches!(self.scenario, Scenario::LostClose | Scenario::KillFailure) => {
                ("script_close", json!({"environmentId":env}))
            }
            0 => ("script_open", json!({})),
            1 => (
                "script_run",
                json!({"environmentId":env,"script":"let shared = { count: 40 }; class Box { value() { return shared.count; } }; const instance = new Box(); await import('node:fs/promises').then(fs => fs.writeFile('actual-node.txt', 'created by original Node')); print(instance.value());"}),
            ),
            2 => (
                "script_run",
                json!({"environmentId":env,"script":"shared.count += 2; if (instance.value() !== 42) throw Error('heap lost'); await tools.invoke({callId:'save-note',name:'memory',arguments:{action:'save',scope:'currentThread',revision:0,content:'A nested note from the original Node environment'}}); throw Error('outer cell fails after the real write');"}),
            ),
            3 => (
                "script_run",
                json!({"environmentId":env,"script":"if (instance.value() !== 42) throw Error('error reset the environment'); print('retained object: ' + instance.value());"}),
            ),
            4 => ("script_close", json!({"environmentId":env})),
            5 => {
                return Ok(PolicyDecision {
                    action: PolicyAction::RequestModel,
                    state: next,
                });
            }
            _ => {
                assert!(matches!(event, PolicyEvent::ModelCompleted { .. }));
                return Ok(PolicyDecision {
                    action: PolicyAction::Complete,
                    state: next,
                });
            }
        };
        let schema = self.schemas.iter().find(|s| s.name == name).unwrap();
        Ok(PolicyDecision {
            action: PolicyAction::ToolGraph {
                nodes: vec![PolicyToolNode {
                    id: format!("cell-{stage}"),
                    depends_on: vec![],
                    call: ToolCall {
                        call_id: format!("cell-{stage}"),
                        name: name.into(),
                        schema_version: schema.version.clone(),
                        arguments: args,
                    },
                }],
            },
            state: next,
        })
    }
}

#[derive(Clone)]
struct Rpc {
    storage: Arc<Mutex<Storage>>,
    runtime: Arc<RunSupervisor>,
    resources: KernelResourceClient,
    interactions: process_interactions::Client,
    storage_root: PathBuf,
    subscriptions: crate::process::subscriptions::ProcessSubscriptions,
    controls: Arc<control_commands::ControlCommands>,
}
impl Rpc {
    fn execute(&self, frame: &Value) -> Result<Value, KernelError> {
        let method = frame["method"].as_str().unwrap();
        let params = frame["params"].clone();
        if method.starts_with("runtime.managed_process.") {
            return managed_process_commands::execute(
                self.runtime.clone(),
                self.resources.clone(),
                method,
                params,
                &AtomicBool::new(false),
            );
        }
        if method.starts_with("runtime.computer.") {
            return computer_commands::execute(
                self.runtime.clone(),
                method,
                params,
                &AtomicBool::new(false),
            );
        }
        let owner = self.runtime.catalog();
        match method {
            "runtime.run.inspect"|"runtime.run.scope"=>dispatch(&mut owner.lock().unwrap(),method,params),
            "runtime.launch.inspect"=>{let read=owner.lock().unwrap().capture_launch(params["runId"].as_str().unwrap()).map_err(domain)?;Ok(serde_json::to_value(read.map(|r|r.load()).transpose().map_err(domain)?)?)},
            "runtime.operation.inspect"=>{let read={let db=owner.lock().unwrap();db.capture_operation_read(db.operation(params["operationId"].as_str().unwrap()).map_err(domain)?)};Ok(serde_json::to_value(read.load().map_err(domain)?)?)},
            "runtime.operation.cancel" => {
                if let Some(receipt)=self.controls.admit_control(method,&params)? {return Ok(receipt);}
                self.controls.execute(method,params,&AtomicBool::new(false))
            },
            "runtime.tools.invoke"=>{let p:NestedToolInvokeParams=serde_json::from_value(params)?;let nested=owner.lock().unwrap().nested_tools();Ok(serde_json::to_value(nested.invoke(&p.parent_operation_id,&p.executor_owner,p.call).map_err(|e|KernelError::Operation(e.to_string()))?)?)},
            "authority.grant.issue"=>{let mut params=params;params["hostGeneration"]=json!(GENERATION);self.storage.lock().unwrap().issue_grant(&params,HOST,GENERATION,&self.storage_root.to_string_lossy(),EPOCH)},
            "authority.grant.retire"=>self.storage.lock().unwrap().retire_grants(&params,HOST),
            "authority.grant.revoke"=>self.storage.lock().unwrap().revoke_grant(&params,HOST),
            "process.subscription.ack"=>{validate_method_params(method,&params)?;self.subscriptions.ack(params["subscriptionId"].as_str().unwrap(),frame["grantId"].as_str().unwrap(),EPOCH,params["stream"].as_str().unwrap(),params["sequence"].as_u64().unwrap())},
            "process.subscription.unsubscribe"=>{validate_method_params(method,&params)?;self.subscriptions.unsubscribe(params["subscriptionId"].as_str().unwrap(),frame["grantId"].as_str().unwrap(),EPOCH)},
            "process.write"|"process.resize"=>self.interactions.wire(json!({"v":PROTOCOL_VERSION,"kind":"request","id":frame["id"],"method":method,"params":params,"epoch":EPOCH,"grantId":frame["grantId"]}),CancellationToken::default()),
            _=>{let mut storage=self.storage.lock().unwrap();let grant_id=frame["grantId"].as_str();let(grant,params)=storage.authorize(grant_id,EPOCH,HOST,GENERATION,method,&params)?;storage.dispatch(method,&params,grant_id,&grant)}
        }
    }
}

#[test]
#[ignore = "requires fresh kernel guardian, workspace Node/tsx and script-runtime build; no product socket or paid provider"]
fn actual_managed_node_preserves_heap_and_nested_receipts_then_stops_writer() {
    run_case(Scenario::Persistence);
}
#[test]
#[ignore = "requires fresh kernel guardian, workspace Node/tsx and script-runtime build; no product socket or paid provider"]
fn actual_managed_node_stops_sync_loop_but_drains_original_callback_before_settlement() {
    run_case(Scenario::CancelDrain);
}
#[test]
#[ignore = "requires fresh kernel guardian, workspace Node/tsx and script-runtime build; no product socket or paid provider"]
fn actual_managed_node_retries_lost_close_receipt_without_replaying_cells() {
    run_case(Scenario::LostClose);
}
#[test]
#[ignore = "requires fresh kernel guardian, workspace Node/tsx and script-runtime build; no product socket or paid provider"]
fn actual_run_end_stops_idle_script_environment_but_preserves_nested_thread_job() {
    run_case(Scenario::RunEndJob);
}
#[test]
#[ignore = "requires fresh guardian/Node; run alone or --test-threads=1 for the existing process kill fault injection"]
fn original_catalog_control_stops_node_when_resource_kill_is_refused() {
    run_case(Scenario::KillFailure);
}
#[test]
#[ignore = "requires fresh guardian/Node/script-runtime; physical capture and model generation controlled, no socket or paid provider"]
fn actual_node_and_computer_media_reach_original_provider_results_after_outer_failure() {
    run_case(Scenario::TypedMedia);
}
fn run_case(scenario: Scenario) {
    let executable = PathBuf::from(
        std::env::var_os("VARIN_TEST_KERNEL_EXECUTABLE").expect("fresh kernel guardian required"),
    );
    assert!(executable.is_file());
    let root = std::env::temp_dir().join(format!("varin-managed-node-{}", uuid::Uuid::new_v4()));
    let work = root.join("work");
    let storage_root = root.join("storage");
    std::fs::create_dir_all(&work).unwrap();
    let host = NodeHost::new();
    host.send(json!({"kind":"fixture-initialize","epoch":EPOCH,"storageRoot":storage_root,"media":scenario==Scenario::TypedMedia}));
    let prepared = host.output.recv_timeout(Duration::from_secs(20)).unwrap();
    assert_eq!(prepared["kind"], "fixture-prepared", "{prepared}");
    let bindings: Vec<ExtensionToolBinding> =
        serde_json::from_value(prepared["bindings"].clone()).unwrap();
    let mut schemas = bindings.iter().map(|b| b.tool.clone()).collect::<Vec<_>>();
    schemas.push(crate::memory::schema(true));
    let process_tools = [crate::tools::ToolKind::ProcessSpawn].into_iter().collect();
    if scenario == Scenario::RunEndJob {
        schemas.extend(crate::tools::KernelToolExecutor::selected_schemas(
            &process_tools,
        ));
    }
    schemas.sort_by(|a, b| a.name.cmp(&b.name));
    if scenario != Scenario::RunEndJob {
        assert!(
            !schemas
                .iter()
                .any(|s| s.name == "process_spawn" || s.name == "file_write")
        );
    }
    let policy: Arc<dyn AgentPolicy> = if scenario == Scenario::TypedMedia {
        Arc::new(DefaultAgentPolicy)
    } else {
        Arc::new(Cells {
            schemas: schemas.clone(),
            scenario,
        })
    };
    let (frames, events) = mpsc::sync_channel(256);
    let (terminal_tx, terminals) = mpsc::channel();
    let process_controls = crate::process::ProcessControlRegistry::default();
    let mut storage = Storage::open(&storage_root, HOST).unwrap();
    storage.set_test_process_worker_executable(executable);
    storage.set_process_controls(process_controls.clone());
    storage.set_process_terminal_sender(terminal_tx);
    let subscriptions = crate::process::subscriptions::ProcessSubscriptions::new(frames.clone());
    storage.set_process_subscriptions(subscriptions.clone());
    storage.issue_grant(&json!({"grantId":"root-admission","hostGeneration":GENERATION,"capabilities":["storage.admin"],"pathScopes":[""],"owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread"}),HOST,GENERATION,&storage_root.to_string_lossy(),EPOCH).unwrap();
    let params =
        json!({"workspaceId":"workspace","executionWorkspaceId":"workspace","canonicalRoot":work});
    let (grant, params) = storage
        .authorize(
            Some("root-admission"),
            EPOCH,
            HOST,
            GENERATION,
            "file.root.register",
            &params,
        )
        .unwrap();
    let registered = storage
        .dispatch(
            "file.root.register",
            &params,
            Some("root-admission"),
            &grant,
        )
        .unwrap();
    let source:SourceSelection=serde_json::from_value(json!({"resource_owner":{"kind":"local"},"mode":"live_root","live_root":{"hostId":HOST,"canonicalRoot":work,"rootId":registered["rootId"]},"workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":null,"revision":null})).unwrap();
    let binding:RequestBinding=serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":if scenario==Scenario::TypedMedia {"openai-responses"} else {"fixture"},"model":"unused","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"main","ancestor_id":null,"leaf_id":null}})).unwrap();
    let mut launch = LaunchSelection::from_binding(&binding, policy.identity(), Some(source));
    launch.extension_bindings = bindings.clone();
    let mut db = Catalog::open(&root.join("catalog")).unwrap();
    db.create_thread("thread", "main").unwrap();
    let run=db.submit_with_context_snapshot(&SubmitInput{key:"script-input".into(),thread_id:"thread".into(),branch_id:"main".into(),expected_head:None,input:json!({"text":"Run the original managed Node environment"}),configuration:json!({})},Some(launch),false,
        Some(ContextProposal{key:"initial".into(),branch_id:"main".into(),through_id:None,expected_revision:0,summary:String::new(),effective_system_prompt:"system".into(),instruction_sources:vec![],memory_checkpoint:None}),
        Some(serde_json::from_value(json!({"mode":"agent","threadRole":"main","revision":0,"configurationDigest":"script-review","memorySnapshot":{"revision":0,"memories":[]},"sessionId":"thread","projectId":null,"originalSections":[{"name":"preamble","content":"system"}],"instructionSources":[]})).unwrap())).unwrap().run_id;
    let runtime = Arc::new(RunSupervisor::new(db));
    let storage = Arc::new(Mutex::new(storage));
    let resources = KernelResourceClient::new(
        {
            let storage = storage.clone();
            move |request| {
                let result = serve_resource(
                    &mut storage.lock().unwrap(),
                    EPOCH,
                    HOST,
                    GENERATION,
                    &request,
                );
                request.reply.send(result).unwrap();
                Ok(())
            }
        },
        |_| Ok(()),
        process_controls,
    );
    let interactions = process_interactions::Client::new({
        let storage = storage.clone();
        move |command| {
            storage
                .lock()
                .unwrap()
                .serve_interaction(command, EPOCH, HOST, GENERATION);
            Ok(())
        }
    });
    let bridge = ToolBridge::new(frames.clone().into());
    bridge.initialize(EPOCH);
    let memory = OwnerChannel::new("memory", frames.clone());
    memory.initialize(EPOCH);
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge.clone());
    let controls = Arc::new(control_commands::ControlCommands {
        runtime: runtime.clone(),
        resources: resources.clone(),
        tools: tools.clone(),
        models: crate::run_models::RunModels::new(
            runtime.catalog(),
            crate::credential_bridge::CredentialBridge::new(frames.clone()),
        ),
    });
    let rpc = Rpc {
        storage: storage.clone(),
        runtime: runtime.clone(),
        resources,
        interactions,
        storage_root,
        subscriptions,
        controls,
    };
    let mut base = vec![crate::memory::declaration(
        runtime.catalog(),
        memory.clone(),
        true,
        false,
    )];
    if scenario == Scenario::RunEndJob {
        rpc.execute(&json!({"method":"authority.grant.issue","params":{"grantId":"independent-job-grant","owningWorkspace":"workspace","executionWorkspace":"workspace","threadId":"thread","runId":run,"capabilities":["storage.read","storage.write","process"],"pathScopes":[""]}})).unwrap();
        let binding:crate::tools::ToolBinding=serde_json::from_value(json!({"resourceOwner":{"kind":"local"},"grantId":"independent-job-grant","runId":run,"threadId":"thread","workspaceId":"workspace","executionWorkspaceId":"workspace","rootId":registered["rootId"],"sourceMode":"live_root","liveRoot":{"hostId":HOST,"canonicalRoot":work,"rootId":registered["rootId"]},"enabledTools":["process_spawn"]})).unwrap();
        base.extend(
            crate::tools::KernelToolExecutor::new(binding, rpc.resources.clone())
                .unwrap()
                .declarations(false),
        );
    }
    let directory = tools
        .prepare_scope(
            &run,
            base,
            None,
            bindings
                .into_iter()
                .map(|binding| LiveExtensionBinding {
                    owner_id: GENERATION.into(),
                    generation: 1,
                    binding,
                })
                .collect(),
        )
        .unwrap();
    let executor = tools.install(&run, 1, directory).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let wires = Arc::new(Mutex::new(Vec::new()));
    let provider: Arc<dyn ModelProvider> = if scenario == Scenario::TypedMedia {
        Arc::new(MediaModel {
            requests: requests.clone(),
            wires: wires.clone(),
        })
    } else {
        Arc::new(FinalModel {
            requests: requests.clone(),
        })
    };
    let start = RunStart {
        binding,
        policy_state: Value::Null,
        provider,
        tools: executor,
        policy,
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    };
    let start = crate::memory::configure_context(start, runtime.catalog(), memory.clone());
    let execution = runtime.start(&run, start).unwrap();
    let (done_tx, done) = mpsc::channel();
    std::thread::spawn(move || {
        done_tx.send(execution.wait()).unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut workers = Vec::new();
    let mut finished = false;
    let held = Arc::new(AtomicBool::new(false));
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let lost_close = Arc::new(AtomicBool::new(false));
    let failed_kill = Arc::new(AtomicBool::new(false));
    let mut cancelled = false;
    let mut released = false;
    let mut open_id = None::<String>;
    let mut cell_id = None::<String>;
    let mut process_grant = None::<String>;
    let independent = Arc::new(Mutex::new(None::<String>));
    let mut completed = None::<ExecutionReport>;
    let mut job_released = false;
    let mut accepted_jobs = Vec::new();
    let report = loop {
        assert!(Instant::now() < deadline, "managed Node chain stalled");
        while let Ok(fact) = terminals.try_recv() {
            apply_process_terminal(&runtime, &fact).unwrap();
        }
        while let Ok(frame) = events.try_recv() {
            if frame["kind"] == "host-tool-request" && frame["phase"] == "execute" {
                if frame["call"]["name"] == "script_open" {
                    open_id = frame["call"]["operationId"].as_str().map(str::to_owned);
                }
                if frame["call"]["name"] == "script_run" {
                    cell_id = frame["call"]["operationId"].as_str().map(str::to_owned);
                }
            }
            host.send(frame);
        }
        if scenario == Scenario::CancelDrain
            && held.load(Ordering::Acquire)
            && work.join("loop-entered").exists()
        {
            if !cancelled {
                rpc.execute(&json!({"method":"runtime.operation.cancel","params":{"operationId":cell_id.as_ref().expect("actual cell dispatch")}})).unwrap();
                cancelled = true;
            }
            if !released {
                let process=rpc.execute(&json!({"method":"process.inspect","params":{"workspaceId":"workspace","rootId":registered["rootId"],"processId":open_id.as_ref().unwrap()},"grantId":process_grant.as_ref().expect("actual environment grant")})).unwrap();
                if process["writerActive"] == false {
                    let owner = runtime.catalog();
                    let db = owner.lock().unwrap();
                    let op = db.operation(open_id.as_ref().unwrap()).unwrap();
                    assert!(
                        op.external_receipt
                            .as_ref()
                            .is_none_or(|r| !r.executor_stopped),
                        "physical tree stop cannot settle a held Host callback"
                    );
                    assert!(
                        done.try_recv().is_err(),
                        "cell cannot finish while its original callback Promise is held"
                    );
                    drop(db);
                    *release.0.lock().unwrap() = true;
                    release.1.notify_all();
                    released = true;
                }
            }
        }
        if let Ok(report) = done.try_recv() {
            let report = report.unwrap();
            if scenario != Scenario::RunEndJob {
                break report;
            }
            assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
            completed = Some(report);
            managed_process_commands::close_ended_environments(&runtime, &rpc.resources).unwrap();
            host.send(json!({"kind":"fixture-tick","cursor":runtime.catalog().lock().unwrap().event_cursor().unwrap()}));
        }
        if completed.is_some() {
            let owner = runtime.catalog();
            let db = owner.lock().unwrap();
            let environment = db.operation(open_id.as_ref().unwrap()).unwrap();
            let stopped = environment
                .external_receipt
                .as_ref()
                .is_some_and(|r| r.executor_stopped);
            drop(db);
            if stopped {
                let job = independent
                    .lock()
                    .unwrap()
                    .clone()
                    .expect("original nested job receipt");
                if !job_released {
                    let process=rpc.execute(&json!({"method":"process.inspect","grantId":"independent-job-grant","params":{"workspaceId":"workspace","rootId":registered["rootId"],"processId":job}})).unwrap();
                    assert_eq!(
                        process["writerActive"], true,
                        "ending the Run must not kill its independent Thread job"
                    );
                    assert!(work.join("job-started").is_file());
                    std::fs::write(work.join("job-release"), b"finish independently").unwrap();
                    job_released = true;
                }
                let op = owner.lock().unwrap().operation(&job).unwrap();
                if op
                    .external_receipt
                    .as_ref()
                    .is_some_and(|r| r.executor_stopped)
                {
                    assert_eq!(op.outcome, Some(Outcome::Succeeded));
                    break completed.take().unwrap();
                }
            }
        }
        match host.output.recv_timeout(Duration::from_millis(5)) {
            Ok(frame) => match frame["kind"].as_str().unwrap() {
                "fixture-request" => {
                    if frame["method"] == "authority.grant.issue"
                        && frame["params"]["operationId"].is_string()
                    {
                        process_grant = frame["params"]["grantId"].as_str().map(str::to_owned);
                    }
                    let rpc = rpc.clone();
                    let input = host.input.clone();
                    let held = held.clone();
                    let release = release.clone();
                    let lost_close = lost_close.clone();
                    let failed_kill = failed_kill.clone();
                    let independent = independent.clone();
                    workers.push(std::thread::spawn(move||{
                        let result=if scenario==Scenario::KillFailure && frame["method"]=="process.kill" && !failed_kill.swap(true,Ordering::SeqCst) {
                            // Existing original Storage failure path, only around this one synchronous
                            // dispatch. The named ignored test runs serially; no fake process receipt.
                            let previous=std::env::var_os("VARIN_KERNEL_FAIL_PROCESS_PHASE");
                            std::env::set_var("VARIN_KERNEL_FAIL_PROCESS_PHASE","kill");
                            let result=rpc.execute(&frame);
                            if let Some(previous)=previous {std::env::set_var("VARIN_KERNEL_FAIL_PROCESS_PHASE",previous)} else {std::env::remove_var("VARIN_KERNEL_FAIL_PROCESS_PHASE")}
                            assert!(result.as_ref().is_err_and(|e|e.to_string().contains("injected native process termination failure")));
                            let observed=rpc.execute(&json!({"method":"process.inspect","params":frame["params"],"grantId":frame["grantId"]})).unwrap();
                            // Original parallel Catalog control may already have stopped it.
                            assert!(observed["writerActive"].is_boolean());result
                        } else {rpc.execute(&frame)};
                        if scenario==Scenario::RunEndJob && frame["method"]=="runtime.tools.invoke" {let receipt=result.as_ref().expect("actual independent job receipt");assert_eq!(receipt["completion"]["kind"],"job_accepted");*independent.lock().unwrap()=Some(receipt["operationId"].as_str().unwrap().into());}
                        if scenario==Scenario::CancelDrain && frame["method"]=="runtime.tools.invoke" {assert!(result.is_ok(),"original nested memory receipt required");held.store(true,Ordering::Release);let mut gate=release.0.lock().unwrap();while !*gate {gate=release.1.wait(gate).unwrap();}}
                        let result=if scenario==Scenario::LostClose && frame["method"]=="runtime.managed_process.terminal" && !lost_close.swap(true,Ordering::SeqCst) {assert!(result.is_ok());Err(KernelError::Protocol("Fixture loses the first original terminal response after durable commit".into()))}else{result};
                        let response=match result{Ok(result)=>json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":result}),Err(error)=>json!({"kind":"fixture-response","id":frame["id"],"ok":false,"error":error.to_string()})};send(&input,response);
                    }));
                }
                "host-tool-receipt" => {
                    if frame["receipt"]["completion"]["kind"] == "job_accepted" {
                        accepted_jobs.push(frame.clone());
                    }
                    serde_json::from_value::<crate::host_tools::LateReceipt>(frame)
                        .unwrap()
                        .apply(&runtime.catalog())
                        .unwrap();
                }
                "host-tool-response" => bridge.receive(frame),
                "memory-response" => memory.receive(frame),
                "fixture-diagnostic" => eprintln!("{frame}"),
                "fixture-failed" => panic!("{frame}"),
                _ => panic!("unexpected frame: {frame}"),
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("{error}"),
        }
    };
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let snapshots = requests.lock().unwrap();
    if scenario != Scenario::RunEndJob {
        assert_eq!(
            snapshots.len(),
            if scenario == Scenario::TypedMedia {
                4
            } else {
                1
            }
        );
        if scenario == Scenario::TypedMedia {
            assert_media_request(
                snapshots.last().unwrap(),
                wires.lock().unwrap().last().unwrap(),
            );
        }
        let facts:Vec<_>=snapshots.last().unwrap().history.iter().filter(|item|matches!(&item.provenance,Provenance::EnvironmentFact{event_id} if event_id.starts_with("memory:"))).collect();
        assert_eq!(
            facts.len(),
            1,
            "one independent note reaches the next actual request"
        );
        assert!(snapshots.last().unwrap().history.iter().all(|item|!matches!(&item.content,Content::ToolResult{result} if result.call_id=="save-note")),"nested call cannot manufacture provider pairing");
    } else {
        assert!(snapshots.is_empty());
    }
    drop(snapshots);
    if scenario == Scenario::CancelDrain {
        assert!(
            cancelled && released,
            "actual tree stopped before held callback was released"
        );
    } else if scenario == Scenario::RunEndJob {
        assert!(job_released);
        assert_eq!(
            std::fs::read_to_string(work.join("job-result")).unwrap(),
            "survived"
        );
    } else if scenario != Scenario::TypedMedia {
        assert_eq!(
            std::fs::read_to_string(work.join("actual-node.txt")).unwrap(),
            "created by original Node"
        );
    }
    let environment = if scenario == Scenario::TypedMedia {
        open_id.as_deref().unwrap()
    } else {
        report.policy_state["environment"].as_str().unwrap()
    };
    let read = {
        let owner = runtime.catalog();
        let db = owner.lock().unwrap();
        db.capture_operation_read(db.operation(environment).unwrap())
    };
    let environment = read.load().unwrap();
    assert_eq!(environment.effect, Effect::Confirmed);
    let terminal = serde_json::to_value(environment.result.as_ref().unwrap()).unwrap();
    assert_eq!(terminal["kind"], "output");
    assert_eq!(terminal["output"]["data"]["process"]["writerActive"], false);
    assert_eq!(terminal["output"]["data"]["callbacksStopped"], true);
    assert!(
        runtime
            .catalog()
            .lock()
            .unwrap()
            .pending_managed_processes()
            .unwrap()
            .is_empty()
    );
    host.send(json!({"kind":"fixture-finish"}));
    while !finished {
        assert!(Instant::now() < deadline);
        let frame = host.output.recv_timeout(Duration::from_secs(5)).unwrap();
        match frame["kind"].as_str().unwrap() {
            "fixture-finished" => {
                assert_eq!(frame["observed"]["processSpawns"], 1);
                if scenario == Scenario::TypedMedia {
                    let calls = frame["observed"]["driverCalls"].as_array().unwrap();
                    assert_eq!(calls.iter().filter(|call| **call == "press_key").count(), 1);
                    assert_eq!(
                        calls
                            .iter()
                            .filter(|call| **call == "get_app_state")
                            .count(),
                        2
                    );
                }
                assert_eq!(
                    frame["memoryWrites"],
                    if scenario == Scenario::RunEndJob {
                        0
                    } else {
                        1
                    }
                );
                assert!(
                    frame["observed"]["processGrants"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|v| v.as_array().unwrap().contains(&json!("process")))
                );
                finished = true
            }
            "fixture-request" => {
                let response = rpc.execute(&frame);
                host.send(match response{Ok(result)=>json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":result}),Err(error)=>json!({"kind":"fixture-response","id":frame["id"],"ok":false,"error":error.to_string()})});
            }
            _ => panic!("{frame}"),
        }
    }
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(accepted_jobs.len(), 1, "original environment accepted once");
    for frame in accepted_jobs {
        let operation_id = frame["call"]["operationId"].as_str().unwrap();
        let owner = runtime.catalog();
        let read = owner
            .lock()
            .unwrap()
            .capture_call_completion(operation_id)
            .unwrap();
        assert_eq!(
            serde_json::to_value(read.load().unwrap()).unwrap(),
            frame["receipt"]["completion"],
            "closed environment keeps its original complete acceptance, not terminal output"
        );
        let (revision, cursor) = {
            let db = owner.lock().unwrap();
            (
                db.operation(operation_id).unwrap().revision,
                db.event_cursor().unwrap(),
            )
        };
        for _ in 0..2 {
            serde_json::from_value::<crate::host_tools::LateReceipt>(frame.clone())
                .unwrap()
                .apply(&owner)
                .unwrap();
            let db = owner.lock().unwrap();
            assert_eq!(db.operation(operation_id).unwrap().revision, revision);
            assert_eq!(db.event_cursor().unwrap(), cursor);
        }
    }
    let mut media_reads = Vec::new();
    if scenario == Scenario::TypedMedia {
        let owner = runtime.catalog();
        let final_view = requests.lock().unwrap().last().unwrap().clone();
        for call_id in ["direct-image", "media-cell"] {
            let result = final_view
                .history
                .iter()
                .find_map(|item| match &item.content {
                    Content::ToolResult { result } if result.call_id == call_id => Some(result),
                    _ => None,
                })
                .unwrap();
            let operation_id = ToolOrigin::ModelStep {
                request_id: result.request_id.clone(),
            }
            .operation_id(call_id);
            let read = {
                let db = owner.lock().unwrap();
                db.capture_operation_read(db.operation(&operation_id).unwrap())
            };
            let op = read.load().unwrap();
            let Some(ToolCompletion::Result { content, .. }) = op.call_completion else {
                panic!("original complete tool receipt required")
            };
            let (part_index, media) = content
                .parts
                .iter()
                .enumerate()
                .find_map(|(index, part)| match part {
                    OutputPart::Media { media } => Some((index, media)),
                    _ => None,
                })
                .unwrap();
            let params:varin_runtime::output::MediaReadParams=serde_json::from_value(json!({"threadId":"thread","branchId":"main","holder":{"kind":"operation","operationId":operation_id,"output":"completion"},"partIndex":part_index,"chunkIndex":0,"expectedContentRef":media.content_ref.content_object})).unwrap();
            let bytes = read_original_media(&owner, &params);
            assert_eq!(&bytes[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
            media_reads.push((params, bytes));
            let history:varin_runtime::output::MediaReadParams=serde_json::from_value(json!({"threadId":"thread","branchId":"main","holder":{"kind":"history","itemId":format!("{}:result:{call_id}",result.request_id)},"partIndex":part_index,"chunkIndex":0,"expectedContentRef":media.content_ref.content_object})).unwrap();
            assert_eq!(
                read_original_media(&owner, &history),
                media_reads.last().unwrap().1
            );
            media_reads.push((history, media_reads.last().unwrap().1.clone()));
        }
        check_original_family_media(&owner, &media_reads);
        let fork = {
            let db = owner.lock().unwrap();
            db.prepare_branch_fork(
                "main",
                "media-fork",
                db.head("main").unwrap().as_deref(),
                None,
            )
            .unwrap()
        }
        .load()
        .unwrap();
        owner.lock().unwrap().admit_branch_fork(fork).unwrap();
        let fork_reads: Vec<_> = media_reads
            .iter()
            .filter(|(params, _)| {
                matches!(
                    params.holder,
                    varin_runtime::output::OutputMediaHolder::History { .. }
                )
            })
            .map(|(params, bytes)| {
                let mut params = params.clone();
                params.branch_id = "media-fork".into();
                (params, bytes.clone())
            })
            .collect();
        media_reads.extend(fork_reads);
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
        for (params, expected) in &media_reads {
            assert_eq!(&read_original_media(&owner, params), expected);
        }
        check_original_family_media(&owner, &media_reads);
    }
    memory.close();
    bridge.close();
    storage.lock().unwrap().shutdown_processes().unwrap();
    drop(host);
    drop(tools);
    drop(runtime);
    drop(rpc);
    drop(storage);
    if scenario == Scenario::TypedMedia {
        let reopened = Arc::new(Mutex::new(Catalog::open(&root.join("catalog")).unwrap()));
        check_original_family_media(&reopened, &media_reads);
        for (params, expected) in &media_reads {
            assert_eq!(
                &read_original_media(&reopened, params),
                expected,
                "original persisted image survived without a live Node or Computer helper"
            );
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}
