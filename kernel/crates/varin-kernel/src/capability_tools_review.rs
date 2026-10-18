use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use varin_runtime::composition::tools::{ToolDeclaration, ToolDirectory};
use varin_runtime::{RunState, SubmitInput};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod admission;
use admission::InputAdmission;

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
                id: "group-index".into(), opaque: None,
                content: Content::ToolCall { call: ToolCall {
                    call_id: "index".into(), name: disclosure::DESCRIBE.into(),
                    schema_version: "1".into(), arguments: json!({}),
                } },
            } }).unwrap();
        }
        let content = match step {
            0 => Content::ToolCall {
                call: ToolCall {
                    call_id: "describe".into(),
                    name: disclosure::DESCRIBE.into(),
                    schema_version: "1".into(),
                    arguments: if self.mode == "question" { json!({"name":"ask_user"}) } else { json!({"namespace":"extensions"}) },
                },
            },
            1 => {
                let index = request.view.history.iter().find_map(|item| match &item.content {
                    Content::ToolResult { result } if result.call_id == "index" => match &result.completion {
                        ToolCompletion::Result { content, .. } => Some(&content.data), _ => None,
                    }, _ => None,
                }).unwrap();
                assert_eq!(index["groups"].as_array().unwrap().len(), 1);
                assert_eq!(index["groups"][0]["namespace"], "extensions");
                assert_eq!(index["groups"][0]["tools"], 1, "common tools stay out of the deferred index");
                let result = request
                    .view
                    .history
                    .iter()
                    .find_map(|item| match &item.content {
                        Content::ToolResult { result } if result.call_id == "describe" => {
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
                let result = if self.mode == "question" { &result } else { &result["tools"][0] };
                assert_eq!(
                    result["parameters"]["required"],
                    json!([if self.mode == "question" {
                        "question"
                    } else {
                        "mode"
                    }])
                );
                assert_eq!(result["name"], if self.mode == "question" { "ask_user" } else { "fixture_effect" });
                let mut reference = result["reference"].clone();
                if self.mode == "stale" {
                    reference["version"] = json!("obsolete");
                }
                if self.mode == "missing" {
                    reference["name"] = json!("not_selected");
                }
                let arguments = if self.mode == "direct_invalid" {
                    json!({})
                } else if self.mode == "question" {
                    json!({"question":"Choose a fixture option","options":["A","B"]})
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
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: if call.arguments["mode"] == "unknown" {
                Effect::Unknown
            } else {
                Effect::Confirmed
            },
            content: varin_runtime::output::OutputBody {
                data: json!({"actual":"fixture_effect"}),
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
        "success", "denied", "stale", "missing", "unknown", "question",
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
        let report = engine.run(input, CancellationToken::default()).unwrap();
        assert_eq!(
            target.calls.load(Ordering::SeqCst),
            usize::from(matches!(mode, "success" | "unknown" | "direct_success")),
            "{mode}: {:?}",
            report.history
        );
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
        if matches!(mode, "success" | "unknown" | "direct_success") {
            let ToolCompletion::Result {
                outcome, content, ..
            } = &result.completion
            else {
                panic!("target receipt missing")
            };
            let direct = mode.starts_with("direct_");
            assert_eq!(
                if direct { &content.data["actual"] } else { &content.data["result"]["actual"] },
                "fixture_effect"
            );
            assert!(
                matches!(&content.parts[0],varin_runtime::output::OutputPart::Text{text} if text=="target output")
            );
            assert!(
                matches!(&content.parts[1], varin_runtime::output::OutputPart::Media { media } if media.media_type == "image/png")
            );
            let operation_id = if direct {
                format!("{}:tool:{}", result.request_id, result.call_id)
            } else {
                content.data["operationId"].as_str().unwrap().into()
            };
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
        if mode == "direct_denied" {
            assert!(matches!(&result.completion, ToolCompletion::NotDispatched { reason }
                if reason == "tool_disclosure: original target permission denied"));
        }
        if mode == "direct_invalid" {
            let ToolCompletion::Result { outcome: Outcome::Failed, effect: Effect::None, content } = &result.completion else {
                panic!("{mode}: rejected invocation must have no effect")
            };
            assert_eq!(content.data["message"], "mode required");
        }
        if mode == "question" {
            let ToolCompletion::Result { content, .. } = &result.completion else {
                panic!("missing question receipt")
            };
            assert_eq!(content.data["completion"]["kind"], "job_accepted");
        }
        assert_eq!(
            report.state,
            if mode == "unknown" {
                RunState::Failed
            } else if mode == "question" {
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
