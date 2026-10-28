use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use varin_runtime::composition::tools::{ToolDeclaration, ToolDirectory};
use varin_runtime::{RunState, SubmitInput};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;

#[test]
fn discovery_pages_whole_entries_and_reads_exact_operations_without_changing_execution_schema() {
    use varin_runtime::tool_documentation::{self as docs, ToolDisclosure, ToolDocumentationOperation};
    let root=std::env::temp_dir().join(format!("varin-discovery-pages-{}",uuid::Uuid::new_v4()));
    let owner=Arc::new(Capabilities {catalog:Arc::new(Mutex::new(Catalog::open(&root).unwrap())),index:Mutex::new(None)});
    let mut tools=(0..80).map(|i|ToolSchema {name:format!("external_{i:03}"),version:"v1".into(),description:"Inspect a retained external object.".into(),schema:json!({"type":"object","required":["id"],"properties":{"id":{"type":"string"}}}),requirements:None,metadata:None,output_schema:None}).collect::<Vec<_>>();
    tools.push(ToolSchema {name:"viewer".into(),version:"original".into(),description:"Observe application images.".into(),requirements:None,output_schema:None,
        schema:json!({"type":"object","required":["application"],"properties":{"application":{"type":"string"},"view":{"enum":["capture","tree"]}},"oneOf":[{"properties":{"view":{"const":"capture"}},"required":["view"]},{"properties":{"view":{"const":"tree"}},"required":["view"]}]}),
        metadata:Some(ToolMetadata {disclosure:Some(ToolDisclosure {summary:"Observe application state.".into(),aliases:vec!["截图".into()],namespace:Some("desktop".into()),operations:vec![ToolDocumentationOperation {name:"capture".into(),description:"Capture the selected window.".into(),paths:vec!["/oneOf/0".into()]}]}),always_declared:false,service_id:"private-service".into(),service_version:1,completion:RegisteredToolCompletion::Result,lifetime:None,operation:ToolOperation::Read,examples:None,source:None})});
    let frozen=FrozenToolContext {tool_output_visible_bytes:Some(1800),execution_environment:None,direct_tools:None,child_dispatch:None,resource_activations:vec![],resource_checkpoint_id:None,run_id:"run".into(),origin:ToolOrigin::ModelStep {request_id:"request".into()},tool_schema_generation:1,tools:Arc::new(tools),source:None};
    let call=Call {owner:owner.clone(),frozen:frozen.clone(),name:disclosure::DESCRIBE.into(),request:Request::Describe(Describe::default())};
    let index=owner.index(&frozen).unwrap();assert!(Arc::ptr_eq(&index,&owner.index(&frozen).unwrap()));
    let mut args:Describe=serde_json::from_value(json!({"namespace":"extensions","detail":"full"})).unwrap();
    let mut names=Vec::new();let mut first_cursor=None;
    loop {
        let page=call.describe(&args).unwrap();assert!(docs::bytes(&page)<=1800,"{page}");
        for entry in page["tools"].as_array().unwrap(){assert_eq!(entry["parameters"]["required"],json!(["id"]));names.push(entry["name"].as_str().unwrap().to_string());}
        let Some(cursor)=page["next"]["arguments"]["cursor"].as_str() else {break};
        first_cursor.get_or_insert(cursor.to_string());args=serde_json::from_value(json!({"cursor":cursor})).unwrap();
    }
    assert_eq!(names.len(),80);assert_eq!(names.iter().collect::<std::collections::HashSet<_>>().len(),80);
    let search=call.describe(&serde_json::from_value(json!({"query":"截图 屏幕"})).unwrap()).unwrap();assert_eq!(search["tools"][0]["name"],"viewer");assert!(search["tools"][0].get("parameters").is_none());
    let exact=call.describe(&serde_json::from_value(json!({"name":"viewer","operation":"capture"})).unwrap()).unwrap();
    assert_eq!(exact["parameters"]["required"],json!(["application"]));assert!(exact.get("metadata").is_none());assert!(exact.get("scriptInvocation").is_none());
    assert_eq!(exact["reference"]["version"],"original");assert_eq!(frozen.tools.last().unwrap().schema["oneOf"].as_array().unwrap().len(),2);
    let mut large=frozen.clone();Arc::make_mut(&mut large.tools)[0].description="文本😀".repeat(600);
    let large_call=Call {owner:owner.clone(),frozen:large.clone(),name:disclosure::DESCRIBE.into(),request:Request::Describe(Describe::default())};
    let mut args:Describe=serde_json::from_value(json!({"name":"external_000","path":"/description"})).unwrap();let mut text=String::new();
    loop {let page=large_call.describe(&args).unwrap();assert!(docs::bytes(&page)<=1800);assert_eq!(page["view"],"json_text_fragment");text.push_str(page["text"].as_str().unwrap());
        let Some(cursor)=page["next"]["arguments"]["cursor"].as_str() else {break};args=serde_json::from_value(json!({"cursor":cursor})).unwrap();}
    assert_eq!(serde_json::from_str::<String>(&text).unwrap(),large.tools[0].description);
    let mut changed=call.frozen.clone();Arc::make_mut(&mut changed.tools)[0].version="v2".into();
    let changed_call=Call {owner:owner.clone(),frozen:changed,name:disclosure::DESCRIBE.into(),request:Request::Describe(Describe::default())};
    assert_eq!(changed_call.describe(&serde_json::from_value(json!({"cursor":first_cursor.unwrap()})).unwrap()).unwrap()["status"],"directory_changed");
    drop(large_call);drop(changed_call);drop(call);drop(owner);std::fs::remove_dir_all(root).unwrap();
}

struct Provider {
    step: AtomicUsize,
    mode: &'static str,
}
impl ModelProvider for Provider {
    fn serialize(
        &self,
        view: &RequestView,
        _: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        let tools = disclosure::model_tools(&view.binding.tools).unwrap();
        assert!(!tools.iter().any(|tool| tool.name == "fixture_effect"));
        assert!(tools.iter().any(|tool| tool.name == "ask_user"));
        Ok(json!({"tools":tools}).into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let step = self.step.fetch_add(1, Ordering::SeqCst);
        if step == 0 {
            emit(ProviderEvent::ItemCompleted { item: ProviderItem {
                id: "tool-details".into(), opaque: None,
                content: Content::ToolCall { call: ToolCall {
                    call_id: "details".into(), name: disclosure::DESCRIBE.into(), schema_version: "1".into(),
                    arguments: json!({"name":if self.mode == "question" { "ask_user" } else { "fixture_effect" }}),
                } },
            } }).unwrap();
            emit(ProviderEvent::ItemCompleted { item: ProviderItem {
                id: "group-index".into(), opaque: None,
                content: Content::ToolCall { call: ToolCall {
                    call_id: "index".into(), name: disclosure::DESCRIBE.into(),
                    schema_version: "1".into(), arguments: json!({}),
                } },
            } }).unwrap();
        }
        let content = match step {
            0 if self.mode == "success" => {
                for (id, arguments) in [
                    ("batch-describe", json!({"names":["fixture_effect","ask_user","missing"]})),
                    ("search-describe", json!({"query":"Controlled"})),
                    ("full-group", json!({"namespace":"extensions","detail":"full"})),
                ] {
                    emit(ProviderEvent::ItemCompleted { item: ProviderItem {
                        id: format!("item-{id}"), opaque: None,
                        content: Content::ToolCall { call: ToolCall { call_id:id.into(), name:disclosure::DESCRIBE.into(), schema_version:"1".into(), arguments } },
                    } }).unwrap();
                }
                Content::ToolCall { call: ToolCall { call_id:"describe".into(), name:disclosure::DESCRIBE.into(), schema_version:"1".into(), arguments:json!({"namespace":"extensions"}) } }
            }
            0 => Content::ToolCall {
                call: ToolCall {
                    call_id: "describe".into(),
                    name: disclosure::DESCRIBE.into(),
                    schema_version: "1".into(),
                    arguments: json!({"namespace":"extensions"}),
                },
            },
            1 => {
                if self.mode == "success" {
                    for id in ["batch-describe", "search-describe", "full-group"] {
                        let data = request.view.history.iter().find_map(|item| match &item.content {
                            Content::ToolResult { result } if result.call_id == id => match &result.completion {
                                ToolCompletion::Result { content, .. } => Some(&content.data), _ => None,
                            }, _ => None,
                        }).unwrap();
                        let target = data["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "fixture_effect").unwrap();
                        if id=="search-describe" {assert!(target.get("parameters").is_none());}
                        else {
                            assert_eq!(target["parameters"]["required"], json!(["mode"]));
                            assert_eq!(target["invocation"]["tool"], disclosure::INVOKE);
                        }
                        assert_eq!(target["directlyCallable"], false);
                    }
                }
                let index = request.view.history.iter().find_map(|item| match &item.content {
                    Content::ToolResult { result } if result.call_id == "index" => match &result.completion {
                        ToolCompletion::Result { content, .. } => Some(&content.data), _ => None,
                    }, _ => None,
                }).unwrap();
                let groups = index["groups"].as_array().unwrap();
                let extensions = groups.iter().find(|group| group["namespace"] == "extensions").unwrap();
                assert_eq!(extensions["toolCount"], 1);
                assert_eq!(extensions["directToolCount"], 0);
                let collaboration = groups.iter().find(|group| group["namespace"] == "collaboration").unwrap();
                assert!(collaboration["toolCount"].as_u64().unwrap() > 0);
                assert_eq!(collaboration["directToolCount"], collaboration["toolCount"], "all-direct groups remain discoverable");
                let group = request.view.history.iter().find_map(|item| match &item.content {
                    Content::ToolResult { result } if result.call_id == "describe" => match &result.completion {
                        ToolCompletion::Result { content, .. } => Some(&content.data), _ => None,
                    }, _ => None,
                }).unwrap();
                assert_eq!(group["tools"][0]["name"], "fixture_effect");
                assert!(group["tools"][0].get("parameters").is_none(), "group discovery remains a concise directory");
                assert_eq!(group["tools"][0]["describe"], json!({"tool":"tool_describe","arguments":{"name":"fixture_effect"}}));
                let result = request
                    .view
                    .history
                    .iter()
                    .find_map(|item| match &item.content {
                        Content::ToolResult { result } if result.call_id == "details" => {
                            match &result.completion {
                                ToolCompletion::Result { content, .. } => {
                                    Some(content.data.clone())
                                }
                                _ => None,
                            }
                        }
                        _ => None,
                    })
                    .expect("description is a real tool result");
                let result = &result;
                assert_eq!(
                    result["parameters"]["required"],
                    json!([if self.mode == "question" {
                        "questions"
                    } else {
                        "mode"
                    }])
                );
                assert_eq!(result["name"], if self.mode == "question" { "ask_user" } else { "fixture_effect" });
                assert_eq!(result["directlyCallable"], self.mode == "question");
                assert_eq!(result["invocation"]["tool"], if self.mode == "question" { "ask_user" } else { disclosure::INVOKE });
                if self.mode != "question" { assert_eq!(result["invocation"]["arguments"]["reference"], result["reference"]); }
                let mut reference = result["reference"].clone();
                if self.mode == "stale" {
                    reference["version"] = json!("obsolete");
                }
                if self.mode == "missing" {
                    reference["name"] = json!("not_selected");
                }
                let arguments = if self.mode.ends_with("invalid") {
                    json!({})
                } else if self.mode == "question" {
                    json!({"questions":[{"id":"question","question":"Choose a fixture option","options":[{"id":"0","label":"A"},{"id":"1","label":"B"}]}]})
                } else {
                    json!({"mode":self.mode.strip_prefix("direct_").unwrap_or(self.mode)})
                };
                let call = if self.mode.starts_with("direct_") {
                    ToolCall {
                        call_id: "invoke".into(),
                        name: reference["name"].as_str().unwrap().into(),
                        schema_version: reference["version"].as_str().unwrap().into(),
                        arguments,
                    }
                } else {
                    ToolCall {
                        call_id: "invoke".into(),
                        name: disclosure::INVOKE.into(),
                        schema_version: "1".into(),
                        arguments: json!({"reference":reference,"arguments":arguments}),
                    }
                };
                Content::ToolCall { call }
            }
            _ => Content::Text {
                text: "done".into(),
            },
        };
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: format!("item-{step}"),
                content,
                opaque: None,
            },
        })
        .map_err(|e| ModelFailure {
            tool_name: None,
            code: e.code,
            message: e.message,
            retry_after_ms: None,
            provider_request_id: None,
        })?;
        Ok(if step < 2 {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}
struct Target {
    catalog: Arc<Mutex<Catalog>>,
    calls: AtomicUsize,
}
impl ToolExecutor for Target {
    fn plan(
        &self,
        call: &ToolCall,
        frozen: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, frozen, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if !call.arguments["mode"].is_string() {
            return Err(error("mode required"));
        }
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: false,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Call,
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        assert!(matches!((&context.origin, call.call_id.as_str()),
            (ToolOrigin::NestedCall { .. }, "target") | (ToolOrigin::ModelStep { .. }, "invoke")));
        let snapshot = self
            .catalog
            .lock()
            .unwrap()
            .capture_tool_invocation(context, &call.call_id)
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(
            snapshot.call, *call,
            "original target identity is retained, not the gateway"
        );
        if call.arguments["mode"] == "denied" {
            return Err(error("original target permission denied"));
        }
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if call.arguments["mode"] == "not_dispatched" {
            return ToolCompletion::not_dispatched(ExecutionError::new("fixture_unavailable", "Original target was not dispatched")
                .with_details(json!({"available":["other"]})));
        }
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: if call.arguments["mode"] == "unknown" {
                Effect::Unknown
            } else {
                Effect::Confirmed
            },
            content: varin_runtime::output::OutputBody {
                data: json!({"actual":"fixture_effect","error":{"code":"opaque_payload_field","message":"Successful content can contain error"}}),
                parts: vec![varin_runtime::output::OutputPart::Text {
                    text: "target output".into(),
                }, varin_runtime::output::OutputPart::Media { media: varin_runtime::output::IncomingMedia {
                    media_type: "image/png".into(), data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==".into(),
                }.admit(varin_runtime::output::OutputSource::Tool { context: context.clone() }).unwrap() }],
            },
        }
    }
}

#[test]
fn disclosure_invocation_uses_original_permissions_versions_receipts_and_output() {
    for mode in [
        "success", "denied", "stale", "missing", "unknown", "question", "invalid", "not_dispatched",
        "direct_success", "direct_denied", "direct_invalid",
    ] {
        let root = std::env::temp_dir().join(format!("varin-disclosure-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let input = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: None,
                input: json!("use the capability"),
                configuration: json!({}),
            })
            .unwrap();
        let db = Arc::new(Mutex::new(db));
        let target = Arc::new(Target {
            catalog: db.clone(),
            calls: AtomicUsize::new(0),
        });
        let mut entries = declarations(db.clone());
        entries.push(crate::questions::declaration(db.clone()));
        entries.push(ToolDeclaration::new(ToolSchema {name:"fixture_effect".into(),version:"original".into(),description:"Controlled target".into(),requirements:None,output_schema:None,metadata:None,
            schema:json!({"type":"object","required":["mode"],"properties":{"mode":{"type":"string"}}})},target.clone()));
        let directory = Arc::new(ToolDirectory::assemble(entries).unwrap());
        let binding:RequestBinding = serde_json::from_value(json!({"request_context":null,"child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
            "connection_identity":"test","provider_family":"test","model":"test","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":directory.schemas(),
            "instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":input.input_id}})).unwrap();
        let start = crate::questions::configure(
            varin_runtime::supervisor::RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding,
                policy_state: Value::Null,
                provider: Arc::new(Provider {
                    step: AtomicUsize::new(0),
                    mode,
                }),
                tools: directory,
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            },
            db.clone(),
        );
        let input = db
            .lock()
            .unwrap()
            .prepare_execution(
                &input.run_id,
                start.binding,
                start.policy.identity(),
                Value::Null,
            )
            .unwrap();
        let engine = ExecutionEngine {
            persistence: db.clone(),
            context_preparation: start.context_preparation,
            provider: start.provider,
            tools: start.tools,
            policy: start.policy,
            progress: ProgressSink::default(),
        };
        let run_id = input.run_id.clone();
        let report = engine.run(input, CancellationToken::default()).unwrap();
        assert_eq!(
            target.calls.load(Ordering::SeqCst),
            usize::from(matches!(mode, "success" | "unknown" | "not_dispatched")),
            "{mode}: {:?}",
            report.history
        );
        if mode.starts_with("direct_") {
            assert_eq!(report.state, RunState::Failed);
            let failure = db.lock().unwrap().run_failure(&run_id).unwrap().unwrap();
            assert_eq!(failure.code, "tool_not_declared");
            assert_eq!(failure.tool_name.as_deref(), Some("fixture_effect"));
            assert!(failure.message.contains("tool_invoke"));
            drop(engine); drop(target); drop(db);
            let reopened = Catalog::open(&root).unwrap();
            assert_eq!(reopened.run_failure(&run_id).unwrap().unwrap(), failure);
            drop(reopened);
            std::fs::remove_dir_all(root).unwrap();
            continue;
        }
        let result = report
            .history
            .iter()
            .find_map(|item| match &item.content {
                Content::ToolResult { result } if result.call_id == "invoke" => {
                    Some(result)
                }
                _ => None,
            })
            .unwrap();
        if matches!(mode, "success" | "unknown") {
            let ToolCompletion::Result {
                outcome, content, ..
            } = &result.completion
            else {
                panic!("target receipt missing")
            };
            assert_eq!(
                &content.data["result"]["actual"],
                "fixture_effect"
            );
            assert!(
                matches!(&content.parts[0],varin_runtime::output::OutputPart::Text{text} if text=="target output")
            );
            assert!(
                matches!(&content.parts[1], varin_runtime::output::OutputPart::Media { media } if media.media_type == "image/png")
            );
            let operation_id: String = content.data["operationId"].as_str().unwrap().into();
            let operation = db
                .lock()
                .unwrap()
                .operation(&operation_id)
                .unwrap();
            assert_eq!(
                operation.effect,
                if mode == "unknown" {
                    Effect::Unknown
                } else {
                    Effect::Confirmed
                }
            );
            assert_eq!(
                *outcome,
                if mode == "unknown" {
                    Outcome::Indeterminate
                } else {
                    Outcome::Succeeded
                }
            );
        }
        if mode == "question" {
            let ToolCompletion::Result { content, .. } = &result.completion else {
                panic!("missing question receipt")
            };
            assert_eq!(content.data["completion"]["kind"], "job_accepted");
        }
        if mode == "invalid" {
            assert!(serde_json::to_string(&result.completion).unwrap().contains("mode required"));
        }
        if mode == "success" {
            let ToolCompletion::Result {content,..}=&result.completion else {unreachable!()};
            assert!(content.data.get("error").is_none(), "successful opaque data does not change the completion");
        }
        if mode == "not_dispatched" {
            let ToolCompletion::Result {content,..}=&result.completion else {unreachable!()};
            assert_eq!(content.data["error"]["code"],"fixture_unavailable");
            assert_eq!(content.data["error"]["details"]["available"],json!(["other"]));
            let operation_id=content.data["operationId"].as_str().unwrap();
            let collection=db.lock().unwrap().prepare_content_collection(Arc::new(std::sync::atomic::AtomicBool::new(false)));
            let varin_runtime::content::ContentCollectionAdmission::Ready(collection)=collection else {panic!("collector unavailable")};
            assert_eq!(collection.run().status,varin_runtime::ContentCollectionStatus::Completed);
            let saved=db.lock().unwrap().capture_call_completion(operation_id).unwrap().load().unwrap();
            assert_eq!(saved.error().unwrap().details,Some(json!({"available":["other"]})));
        }
        assert_eq!(
            report.state,
            if mode == "question" {
                RunState::Waiting
            } else {
                RunState::Completed
            }
        );
        drop(engine);
        drop(target);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
