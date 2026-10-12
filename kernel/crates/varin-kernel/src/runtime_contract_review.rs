//! Actual distribution tool/broker/SDK → original live NestedTools/Run → durable result/history.
//! Only model choices and delivery use fixtures; no product listener or external provider runs.
use super::web_domain_review::{EPOCH, Fixture, HOST, Host};
use super::*;
use crate::{host_tools::ToolBridge, storage::Storage};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use varin_runtime::execution::*;
use varin_runtime::supervisor::RunStart;
use varin_runtime::{Effect, Outcome, RunState};

#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod dispatch;
use admission::InputAdmission;

const THREAD: &str = "thread:contracts";
const BRANCH: &str = "branch:contracts";
struct Model {
    results: Arc<Mutex<BTreeMap<String, Value>>>,
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
        let mut results = self.results.lock().unwrap();
        for item in &request.view.history {
            if let Content::ToolResult { result } = &item.content {
                if result.call_id.starts_with("contract-") {
                    let ToolCompletion::Result {
                        outcome,
                        effect,
                        content,
                    } = &result.completion
                    else {
                        panic!("finite contract receipt: {result:?}")
                    };
                    assert_eq!(
                        (*outcome, *effect),
                        (Outcome::Succeeded, Effect::Confirmed),
                        "{result:?}"
                    );
                    results.insert(result.call_id.clone(), content.data.clone());
                }
            }
        }
        let (id, name, arguments) = match results.len() {
            0 => (
                "contract-current",
                "runtime_contract",
                json!({"action":"list","kind":"service"}),
            ),
            1 => (
                "contract-source",
                "runtime_contract",
                source_request(&results["contract-current"]),
            ),
            2 => ("contract-sdk", "contract_probe", json!({"nested":true})),
            _ => return Ok(FinishReason::Stop),
        };
        let schema = request
            .view
            .binding
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: id.into(),
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
        Ok(FinishReason::ToolCalls)
    }
}
#[derive(Default)]
struct PolicyRead {
    result: Option<Value>,
    reference: Option<PolicyEvidenceRef>,
    bytes: Vec<u8>,
}
struct Policy {
    schema: ToolSchema,
    observed: Arc<Mutex<PolicyRead>>,
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
        ) {
            let schema = &self.schema;
            return Ok(PolicyDecision {
                state: Value::Null,
                action: PolicyAction::ToolGraph {
                    nodes: vec![PolicyToolNode {
                        id: "policy-contract".into(),
                        depends_on: vec![],
                        call: ToolCall {
                            call_id: "policy-contract".into(),
                            name: schema.name.clone(),
                            schema_version: schema.version.clone(),
                            arguments: json!({"nested":true}),
                        },
                    }],
                },
            });
        }
        if let PolicyEvent::ToolGraphCompleted { receipts, .. } = event {
            assert_eq!(receipts.len(), 1);
            let PolicyNodeCompletion::Result {
                outcome,
                effect,
                output,
            } = &receipts[0].completion
            else {
                panic!("finite policy contract result")
            };
            assert_eq!((*outcome, *effect), (Outcome::Succeeded, Effect::Confirmed));
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
            total_bytes,
            ..
        } = event
        {
            let mut observed = self.observed.lock().unwrap();
            observed.bytes.extend_from_slice(bytes);
            if index + 1 < *total_chunks {
                return Ok(PolicyDecision {
                    state: Value::Null,
                    action: PolicyAction::ReadResult {
                        reference: reference.clone(),
                        index: index + 1,
                    },
                });
            }
            assert_eq!(observed.bytes.len() as u64, *total_bytes);
            let body: OutputBody = serde_json::from_slice(&observed.bytes).unwrap();
            observed.result = Some(body.data);
            observed.reference = Some(reference.clone());
            observed.bytes.clear();
            return Ok(PolicyDecision {
                state: Value::Null,
                action: PolicyAction::Complete,
            });
        }
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}
fn source_request(current: &Value) -> Value {
    let service = current["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|service| service["serviceId"] == "review.cold-contract.future")
        .unwrap();
    let artifact = &service["implementations"][0]["artifacts"]["selected"];
    json!({"action":"read","kind":"source","extensionId":artifact["extensionId"],
        "slot":artifact["slot"],"artifactIntegrity":artifact["artifactIntegrity"],
        "path":"host.cjs","offset":0,"maxBytes":4})
}
fn assert_source_start(value: &Value) {
    assert_eq!(value["origin"], "immutable_artifact");
    assert_eq!(value["status"], "found");
    assert_eq!(value["page"]["text"], "// 源");
    assert_eq!(value["page"]["byteLength"], 6);
    assert_eq!(value["page"]["nextOffset"], 6);
}
fn assert_directory(value: &Value, run: &str, tools: &[ToolSchema], source_text: &str) {
    let listed = &value["listed"];
    assert_eq!(listed["origin"], "accepted_run");
    assert_eq!(listed["runId"], run);
    assert_eq!(listed["generation"], 1);
    let mut names = listed["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["contract_probe", "runtime_contract"]);
    assert!(
        listed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v.get("schema").is_none())
    );
    let expected = tools
        .iter()
        .find(|tool| tool.name == "runtime_contract")
        .unwrap();
    assert_eq!(
        value["described"]["tool"],
        serde_json::to_value(expected).unwrap()
    );
    assert!(value["missing"]["tool"].is_null());
    let query = &value["query"];
    assert_eq!(query["completion"]["kind"], "result");
    assert_eq!(query["completion"]["outcome"], "succeeded");
    assert_eq!(query["completion"]["effect"], "confirmed");
    assert_eq!(
        query["completion"]["content"]["data"]["origin"],
        "current_catalog"
    );
    assert_eq!(
        query["completion"]["content"]["data"]["slot"]["id"],
        "workbench.editor.actions"
    );
    assert_eq!(
        query["completion"]["content"]["data"]["slot"]["live"],
        "unobserved"
    );
    let source = &value["source"];
    let pages = source["pages"].as_array().unwrap();
    assert!(pages.len() > 2, "source uses real byte pages");
    assert_source_start(&pages[0]);
    let mut offset = 0;
    let mut joined = String::new();
    for page in pages {
        assert_eq!(
            page["artifactIntegrity"],
            source["metadata"]["service"]["implementations"][0]["artifacts"]["selected"]["artifactIntegrity"]
        );
        assert_eq!(page["fileIntegrity"], pages[0]["fileIntegrity"]);
        assert_eq!(page["page"]["offset"], offset);
        let text = page["page"]["text"].as_str().unwrap();
        assert_eq!(page["page"]["byteLength"], text.len());
        assert_eq!(page["page"]["totalBytes"], source_text.len());
        offset += text.len();
        joined.push_str(text);
    }
    assert!(pages.last().unwrap()["page"]["nextOffset"].is_null());
    assert_eq!(
        joined, source_text,
        "installed original source survives mutable checkout edits"
    );
}

#[test]
#[ignore = "requires built ordinary contracts builtin and SDK; real Catalog/broker over existing stdio, no listener"]
fn current_catalog_and_frozen_sdk_tools_share_actual_model_policy_receipts_after_reopen() {
    let root =
        std::env::temp_dir().join(format!("varin-runtime-contract-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let catalog = root.join("catalog");
    let mut db = Catalog::open(&catalog).unwrap();
    db.create_thread(THREAD, BRANCH).unwrap();
    let prepared = db
        .prepare_submission(
            SubmitInput {
                key: "contract-input".into(),
                thread_id: THREAD.into(),
                branch_id: BRANCH.into(),
                expected_head: None,
                input: json!({"text":"Inspect current contracts and my selected tools"}),
                configuration: json!({}),
            },
            None,
            None,
        )
        .unwrap();
    let submitted = db
        .admit_submission(prepared.load(None, false).unwrap())
        .unwrap();
    let runtime = Arc::new(RunSupervisor::new(db));
    let (sender, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(sender.clone().into());
    bridge.initialize(EPOCH);
    let storage_root = root.join("storage");
    let mut f = Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/runtime-contract-host.test-helper.ts",
        ),
        runtime: runtime.clone(),
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge: bridge.clone(),
        outgoing,
    };
    f.host.send(json!({"kind":"fixture-initialize","root":root,"storageRoot":storage_root,"epoch":EPOCH,"runId":submitted.run_id,"threadId":THREAD}));
    let ready = f.receive("fixture-prepared");
    let source_text = ready["sourceText"].as_str().unwrap().to_owned();
    let live: Vec<_> = ready["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            live_extension_binding(serde_json::from_value(value.clone()).unwrap()).unwrap()
        })
        .collect();
    let mut schemas: Vec<_> = live.iter().map(|item| item.binding.tool.clone()).collect();
    schemas.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(schemas.len(), 2);
    let binding:RequestBinding=serde_json::from_value(json!({"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"openai-responses","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":BRANCH,"ancestor_id":null,"leaf_id":submitted.input_id}})).unwrap();
    let policy_result = Arc::new(Mutex::new(PolicyRead::default()));
    let policy = Arc::new(Policy {
        schema: schemas
            .iter()
            .find(|tool| tool.name == "contract_probe")
            .unwrap()
            .clone(),
        observed: policy_result.clone(),
    });
    let mut launch = varin_runtime::catalog::launches::LaunchSelection::from_binding(
        &binding,
        policy.identity(),
        None,
    );
    launch.extension_bindings = live.iter().map(|item| item.binding.clone()).collect();
    let original_bindings = launch.extension_bindings.clone();
    runtime
        .catalog()
        .lock()
        .unwrap()
        .bind_launch(&submitted.run_id, launch)
        .unwrap();
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), bridge);
    let prepared = tools
        .prepare_scope(&submitted.run_id, vec![], None, live)
        .unwrap();
    let executor = tools.install(&submitted.run_id, 1, prepared).unwrap();
    let results = Arc::new(Mutex::new(BTreeMap::new()));
    let execution = runtime
        .start(
            &submitted.run_id,
            RunStart {
                binding,
                policy_state: Value::Null,
                provider: Arc::new(Model {
                    results: results.clone(),
                }),
                tools: executor,
                policy,
                context_preparation: Arc::new(NoopContextPreparation),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    let owner = runtime.catalog();
    let report = wait_execution(&mut f, execution, owner.clone(), sender.clone());
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let results = results.lock().unwrap();
    assert_eq!(results.len(), 3);
    let current = &results["contract-current"];
    assert_eq!(current["origin"], "current_catalog");
    assert!(
        current["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["serviceId"] == "review.cold-contract.future")
    );
    let child_source_request = source_request(current);
    assert_source_start(&results["contract-source"]);
    assert_directory(
        &results["contract-sdk"],
        &submitted.run_id,
        &schemas,
        &source_text,
    );
    assert_directory(
        policy_result.lock().unwrap().result.as_ref().unwrap(),
        &submitted.run_id,
        &schemas,
        &source_text,
    );
    drop(results);
    let history = owner.lock().unwrap().execution_history(BRANCH).unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|item| matches!(&item.content, Content::ToolResult { .. }))
            .count(),
        3,
        "nested/Policy results must not fabricate model pairs"
    );
    exercise_child(
        &mut f,
        &schemas,
        original_bindings,
        sender.clone(),
        child_source_request,
    );
    f.host.send(json!({"kind":"fixture-finish"}));
    f.receive("fixture-finished");
    let collection = owner
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    drop(owner);
    drop(tools);
    drop(f);
    drop(runtime);
    let reopened = Catalog::open(&catalog).unwrap();
    assert_eq!(reopened.execution_history(BRANCH).unwrap(), history);
    let observed = policy_result.lock().unwrap();
    let reference = observed.reference.as_ref().unwrap();
    let mut bytes = Vec::new();
    let mut index = 0;
    loop {
        let chunk = reopened
            .policy_output_chunk(
                &submitted.run_id,
                &reference.action_id,
                &reference.node_id,
                &reference.content_ref,
                index,
            )
            .unwrap();
        bytes.extend_from_slice(&chunk.bytes);
        index += 1;
        if index == chunk.chunk_count {
            break;
        }
    }
    let body: OutputBody = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(&body.data, observed.result.as_ref().unwrap());
    drop(observed);
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

fn wait_execution(
    f: &mut Fixture,
    execution: varin_runtime::supervisor::RunHandle,
    owner: Arc<Mutex<Catalog>>,
    sender: mpsc::SyncSender<Value>,
) -> ExecutionReport {
    let (done_tx, done) = mpsc::channel();
    thread::spawn(move || {
        let _ = done_tx.send(execution.wait());
    });
    let deadline = Instant::now() + Duration::from_secs(90);
    let report = loop {
        assert!(Instant::now() < deadline, "real contract consumer stalled");
        if let Ok(value) = done.try_recv() {
            break value.unwrap();
        }
        f.pump_dispatch(|frame| {
            let method=frame["method"].as_str().unwrap();
            if method=="runtime.tools.inspect" {
                let params=&frame["params"];
                let nested=owner.lock().unwrap().nested_tools();
                return Some((|| {validate_method_params(method,params)?;
                    Ok(serde_json::to_value(nested.inspect(params["parentOperationId"].as_str().unwrap(),&serde_json::from_value(params["executorOwner"].clone())?,params["name"].as_str()).map_err(|error|KernelError::Operation(error.to_string()))?)?)})());
            }
            if method=="runtime.tools.invoke" {
                let frame=frame.clone(); let owner=owner.clone(); let sender=sender.clone();
                thread::spawn(move|| {
                    let result=(||->Result<Value,KernelError>{
                        let params=frame["params"].clone();validate_method_params("runtime.tools.invoke",&params)?;
                        let p:NestedToolInvokeParams=serde_json::from_value(params)?;
                        let nested=owner.lock().unwrap().nested_tools();
                        Ok(serde_json::to_value(nested.invoke(&p.parent_operation_id,&p.executor_owner,p.call).map_err(|e|KernelError::Operation(e.to_string()))?)?)
                    })();
                    let response=match result {Ok(result)=>json!({"kind":"fixture-response","id":frame["id"],"ok":true,"result":result}),Err(error)=>json!({"kind":"fixture-response","id":frame["id"],"ok":false,"error":error.to_string()})};
                    let _=sender.send(response);
                });
                return Some(Ok(Value::Null));
            }
            None
        },|frame,_|frame["method"]!="runtime.tools.invoke");
    };
    report
}

struct ChildModel {
    results: Arc<Mutex<Vec<Value>>>,
    source_request: Value,
}
impl ModelProvider for ChildModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let mut results = self.results.lock().unwrap();
        *results = request
            .view
            .history
            .iter()
            .filter_map(|item| {
                let Content::ToolResult { result } = &item.content else {
                    return None;
                };
                let ToolCompletion::Result {
                    outcome,
                    effect,
                    content,
                } = &result.completion
                else {
                    panic!("finite child inspection")
                };
                assert_eq!((*outcome, *effect), (Outcome::Succeeded, Effect::Confirmed));
                Some(content.data.clone())
            })
            .collect();
        if results.len() == 4 {
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: "child-report".into(),
                    opaque: None,
                    content: Content::Text {
                        text: "Only runtime_contract was delegated; parent probe is unavailable."
                            .into(),
                    },
                },
            })
            .unwrap();
            return Ok(FinishReason::Stop);
        }
        assert_eq!(request.view.binding.tools.len(), 1);
        let schema = &request.view.binding.tools[0];
        let arguments = match results.len() {
            0 => json!({"action":"list","kind":"tool"}),
            1 => json!({"action":"describe","kind":"tool","name":"contract_probe"}),
            2 => json!({"action":"describe","kind":"tool","name":"runtime_contract"}),
            _ => self.source_request.clone(),
        };
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: format!("child-contract-{}", results.len()),
                opaque: None,
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: format!("child-contract-{}", results.len()),
                        name: schema.name.clone(),
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
fn exercise_child(
    f: &mut Fixture,
    schemas: &[ToolSchema],
    bindings: Vec<varin_runtime::catalog::launches::ExtensionToolBinding>,
    sender: mpsc::SyncSender<Value>,
    source_request: Value,
) {
    use varin_runtime::catalog::{collaboration::ChildSource, launches::LaunchSelection};
    let declared = crate::child_capabilities::schemas()
        .into_iter()
        .find(|tool| tool.name == "dispatch")
        .unwrap();
    let schema = schemas
        .iter()
        .find(|tool| tool.name == "runtime_contract")
        .unwrap()
        .clone();
    let parent_schemas = schemas.to_vec();
    let mut parent = dispatch::Fixture::new_parent_custom(
        0,
        schema.clone(),
        declared.clone(),
        false,
        false,
        false,
        move |input, launch| {
            input.tools = Some(vec!["runtime_contract".into()]);
            launch.tools = parent_schemas;
            launch.tools.push(declared);
            launch.extension_bindings = bindings;
            launch.source = None;
        },
    );
    let selected = parent
        .db
        .capture_child_dispatch_invocation(&parent.context)
        .unwrap()
        .load()
        .unwrap();
    let resolved = selected.resolve(&parent.input).unwrap();
    let child_launch = LaunchSelection {
        child_dispatch: Some(selected.catalog.clone()),
        extension_bindings: resolved.extension_bindings.clone(),
        policy_models: vec![],
        mcp_binding: resolved.mcp_binding.clone(),
        credential_scope: resolved.model.credential_scope.clone(),
        connection_identity: resolved.model.connection_identity().unwrap(),
        provider_family: resolved.model.configuration.provider_family.clone(),
        model: resolved.model.configuration.model.clone(),
        configuration_generation: resolved.model.configuration.configuration_generation,
        tool_schema_generation: resolved.tool_schema_generation,
        tools: vec![schema.clone()],
        policy: DefaultAgentPolicy.identity(),
        source: None,
    };
    let prepared = parent
        .db
        .prepare_child_launch(&parent.context.run_id, child_launch, resolved)
        .unwrap()
        .load()
        .unwrap();
    drop(selected);
    let prepared = parent
        .db
        .prepare_child_admission(&parent.context, parent.input.clone(), None, prepared)
        .unwrap()
        .load()
        .unwrap();
    let child = parent.db.accept_child_references(prepared).unwrap();
    parent.settle_exchange();
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: "contract-child-context".into(),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Inspect only your frozen contracts.".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"contract-child",
        "memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":null,"originalSections":[],"instructionSources":[]})).unwrap();
    let prepared = parent
        .db
        .capture_child_preparation(&child.execution_id, None, proposal, basis)
        .unwrap()
        .load()
        .unwrap();
    let child = parent.db.admit_child(prepared).unwrap();
    assert_eq!(child.source, ChildSource::Absent);
    let run = parent
        .db
        .run(&child.receipt.as_ref().unwrap().run_id)
        .unwrap();
    let launch = parent.db.launch_intent(&run.id).unwrap().unwrap().selection;
    assert_eq!(launch.tools, vec![schema.clone()]);
    let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
        "connection_identity":launch.connection_identity,"provider_family":launch.provider_family,"model":launch.model,
        "credential_ref":launch.credential_scope.as_ref().map(|scope|&scope.reference),"configuration_generation":launch.configuration_generation,
        "tool_schema_generation":launch.tool_schema_generation,"tools":launch.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,
        "history_range":{"branch_id":run.branch_id,"ancestor_id":null,"leaf_id":parent.db.head(&run.branch_id).unwrap()}})).unwrap();
    let runtime = Arc::new(RunSupervisor::new(parent.db));
    let previous_runtime = std::mem::replace(&mut f.runtime, runtime.clone());
    f.host.send(json!({"kind":"fixture-select","runId":run.id,"threadId":run.thread_id,"onlyContract":true}));
    let selected = f.receive("fixture-prepared");
    let live: Vec<_> = selected["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            live_extension_binding(serde_json::from_value(value.clone()).unwrap()).unwrap()
        })
        .collect();
    assert_eq!(
        live.iter()
            .map(|value| value.binding.clone())
            .collect::<Vec<_>>(),
        launch.extension_bindings
    );
    let tools = crate::run_tools::RunTools::new(runtime.catalog(), f.bridge.clone());
    let scope = tools.prepare_scope(&run.id, vec![], None, live).unwrap();
    let executor = tools
        .install(&run.id, launch.tool_schema_generation, scope)
        .unwrap();
    let results = Arc::new(Mutex::new(Vec::new()));
    let execution = runtime
        .start(
            &run.id,
            RunStart {
                binding,
                policy_state: Value::Null,
                provider: Arc::new(ChildModel {
                    results: results.clone(),
                    source_request,
                }),
                tools: executor,
                policy: Arc::new(DefaultAgentPolicy),
                context_preparation: Arc::new(NoopContextPreparation),
                progress: ProgressSink::default(),
            },
        )
        .unwrap();
    let report = wait_execution(f, execution, runtime.catalog(), sender);
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let values = results.lock().unwrap();
    assert_eq!(values[0]["origin"], "accepted_run");
    assert_eq!(values[0]["runId"], run.id);
    assert_ne!(values[0]["runId"], parent.context.run_id);
    assert_eq!(values[0]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(values[0]["tools"][0]["name"], "runtime_contract");
    assert!(
        values[1]["tool"].is_null(),
        "parent tools cannot be rediscovered into a narrowed child"
    );
    assert_eq!(values[2]["tool"], serde_json::to_value(&schema).unwrap());
    assert_source_start(&values[3]);
    drop(values);
    let owner = runtime.catalog();
    let (history, terminal) = {
        let mut db = owner.lock().unwrap();
        db.reconcile_child_reports().unwrap();
        let terminal = db.child_task(&child.operation_id).unwrap();
        assert_eq!(
            terminal.report.as_ref().unwrap().outcome,
            Outcome::Succeeded
        );
        (db.execution_history(&run.branch_id).unwrap(), terminal)
    };
    let collection = owner
        .lock()
        .unwrap()
        .prepare_content_collection(Default::default());
    assert_eq!(
        collection.run().status,
        varin_runtime::ContentCollectionStatus::Completed
    );
    // Close this real child owner before checking durable original results and report.
    f.runtime = previous_runtime;
    drop(owner);
    drop(tools);
    drop(runtime);
    let reopened = Catalog::open(&parent.root).unwrap();
    assert_eq!(reopened.execution_history(&run.branch_id).unwrap(), history);
    assert_eq!(reopened.child_task(&child.operation_id).unwrap(), terminal);
    drop(reopened);
    std::fs::remove_dir_all(parent.root).unwrap();
}
