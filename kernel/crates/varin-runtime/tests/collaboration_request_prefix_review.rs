//! Real Engine/Catalog history boundaries, then the actual five protocol serializers.
//! Generation is deterministic and local. No credential or network path may be called;
//! these assertions establish request structure, not provider-side cache hit rates.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use varin_runtime::{
    catalog::{
        collaboration::ChildTask, context::ContextProposal, family::CollaborationSnapshot,
        threads::ThreadUpdate,
    },
    execution::*,
    providers::{self, Connection, CredentialResolver, HttpRequest, HttpTransport},
    *,
};

struct NoNetwork;
impl CredentialResolver for NoNetwork {
    fn headers(
        &self,
        _: Option<&str>,
        _: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
        panic!("this structural test must never resolve credentials")
    }
}
impl HttpTransport for NoNetwork {
    fn stream(
        &self,
        _: HttpRequest<'_>,
        _: &CancellationToken,
        _: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        panic!("this structural test must never contact a provider")
    }
}
fn connection() -> Connection {
    Connection::new(
        "https://fixture.invalid/structural-only",
        Arc::new(NoNetwork),
        Arc::new(NoNetwork),
    )
}
fn adapters() -> Vec<(&'static str, Box<dyn ModelProvider>)> {
    vec![
        (
            providers::responses::FAMILY,
            Box::new(providers::responses::ResponsesProvider::new(connection())),
        ),
        (
            providers::codex::FAMILY,
            Box::new(providers::codex::CodexProvider::new(connection())),
        ),
        (
            providers::chat::FAMILY,
            Box::new(providers::chat::ChatProvider::new(connection())),
        ),
        (
            providers::anthropic::FAMILY,
            Box::new(providers::anthropic::AnthropicProvider::new(
                connection(),
                1024,
            )),
        ),
        (
            providers::google::FAMILY,
            Box::new(providers::google::GoogleProvider::new(connection()).unwrap()),
        ),
    ]
}
struct Policy;
impl AgentPolicy for Policy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "fixture".into(),
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
        DefaultAgentPolicy.decide(view, event, state, cancel)
    }
}
struct Capture {
    requests: Vec<RequestView>,
    wire: Vec<Vec<u8>>,
    old_tails: Vec<ConversationItem>,
}
struct Provider {
    original: providers::responses::ResponsesProvider,
    catalog: Arc<Mutex<Catalog>>,
    captured: Mutex<Capture>,
}
impl ModelProvider for Provider {
    fn serialize(
        &self,
        view: &RequestView,
        reuse: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        self.original.serialize(view, reuse)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let old = self
            .catalog
            .lock()
            .unwrap()
            .capture_family_read("thread:parent", None, None)
            .unwrap()
            .status_context()
            .unwrap()
            .unwrap();
        let index = {
            let mut capture = self.captured.lock().unwrap();
            let index = capture.requests.len();
            capture.requests.push(request.view.clone());
            capture.wire.push(request.serialized.wire_bytes().to_vec());
            capture.old_tails.push(old);
            index
        };
        let content = if index < 3 {
            Content::ToolCall {
                call: ToolCall {
                    call_id: format!("read-{index}"),
                    name: "file_read".into(),
                    schema_version: "1".into(),
                    arguments: json!({"step":index}),
                },
            }
        } else {
            Content::Text {
                text: "All structural steps completed.".into(),
            }
        };
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: format!("generated-{index}"),
                content,
                opaque: None,
            },
        })
        .unwrap();
        Ok(if index < 3 {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}
struct Tools {
    catalog: Arc<Mutex<Catalog>>,
    child: ChildTask,
    child_run: String,
    count: Mutex<usize>,
}
impl ToolExecutor for Tools {
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, context, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        assert!(context
            .tools
            .iter()
            .any(|tool| tool.name == call.name && tool.version == call.schema_version));
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: true,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Ok(())
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        let mut count = self.count.lock().unwrap();
        assert_eq!(call.arguments["step"].as_u64().unwrap(), *count as u64);
        let mut db = self.catalog.lock().unwrap();
        let epoch = db.epoch();
        // Simulate independent teammate activity while the parent's genuine tool exchange
        // is open. It is observed only at the following closed Engine input boundary.
        if *count == 1 {
            let revision = db.inspect_thread(&self.child.child_thread_id).unwrap()["revision"]
                .as_u64()
                .unwrap();
            db.update_thread(&ThreadUpdate {
                thread_id: self.child.child_thread_id.clone(),
                key: "peer-purpose-change".into(),
                expected_revision: revision,
                title: Some("Verify the final evidence".into()),
                title_mode: None,
                pinned: None,
                archived: None,
            })
            .unwrap();
        } else {
            let state = if *count == 0 {
                RunState::Generating
            } else {
                RunState::Executing
            };
            db.commit_execution(
                &self.child_run,
                epoch,
                &ExecutionRecord::StateChanged {
                    state,
                    waiting_on: None,
                },
            )
            .unwrap();
            let head = db.head(&self.child.child_branch_id).unwrap();
            db.append_history(&self.child_run, epoch, head.as_deref(), HistorySource::Assistant,
                json!({"id":format!("peer-progress-{}", *count),"provenance":{"kind":"assistant"},"content":{"kind":"text","text":"ordinary peer progress"},"opaque":null}), None).unwrap();
        }
        *count += 1;
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::None,
            content: json!({"text":"original file bytes"}).into(),
        }
    }
}
fn prepare_child(f: &mut Fixture, child: ChildTask) -> ChildTask {
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal = ContextProposal {
        key: format!("context:{}", child.operation_id),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Independent teammate".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"prefix-test",
        "memorySnapshot":{"revision":0,"memories":[]},"threadId":child.child_thread_id,"projectId":child.project_id,"originalSections":[],"instructionSources":[]})).unwrap();
    f.db.prepare_child(&child.operation_id, source, proposal, basis)
        .unwrap()
}
fn binding(f: &Fixture) -> RequestBinding {
    let launch =
        f.db.launch_intent(&f.context.run_id)
            .unwrap()
            .unwrap()
            .selection;
    RequestBinding {
        pricing: None,
        tool_output_visible_bytes: None,
        mcp_tools: Vec::new(),
        execution_environment: None,
        direct_tools: None,
        provider_id: None,
        tokenizer: None,
        request_context: None,
        child_dispatch: f
            .db
            .launch_metadata(&f.context.run_id)
            .unwrap()
            .unwrap()
            .dispatch_context_ref,
        goal: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        connection_identity: launch.connection_identity,
        provider_family: launch.provider_family,
        model: launch.model,
        credential_ref: Some("credential-ref".into()),
        configuration_generation: launch.configuration_generation,
        tool_schema_generation: launch.tool_schema_generation,
        tools: launch.tools,
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: "branch:parent".into(),
            ancestor_id: None,
            leaf_id: f.db.head("branch:parent").unwrap(),
        },
    }
}
fn observations(view: &RequestView) -> Vec<(&ConversationItem, CollaborationSnapshot)> {
    view.history
        .iter()
        .filter_map(|item| {
            CollaborationSnapshot::from_item(item)
                .unwrap()
                .map(|snapshot| (item.as_ref(), snapshot))
        })
        .collect()
}
fn transcript<'a>(family: &str, body: &'a Value) -> &'a Vec<Value> {
    body[match family {
        providers::responses::FAMILY | providers::codex::FAMILY => "input",
        providers::google::FAMILY => "contents",
        _ => "messages",
    }]
    .as_array()
    .unwrap()
}
fn validate_wire(family: &str, body: &Value) {
    let mut calls = BTreeSet::new();
    for message in transcript(family, body) {
        match family {
            providers::responses::FAMILY | providers::codex::FAMILY => {
                match message["type"].as_str() {
                    Some("function_call") => {
                        assert!(message["name"].is_string());
                        assert!(serde_json::from_str::<Value>(
                            message["arguments"].as_str().unwrap()
                        )
                        .unwrap()
                        .is_object());
                        assert!(calls.insert(message["call_id"].as_str().unwrap().to_owned()));
                    }
                    Some("function_call_output") => {
                        assert!(calls.remove(message["call_id"].as_str().unwrap()))
                    }
                    _ => assert!(matches!(
                        message["role"].as_str(),
                        Some("system" | "assistant" | "user")
                    )),
                }
            }
            providers::chat::FAMILY => {
                assert!(matches!(
                    message["role"].as_str(),
                    Some("system" | "assistant" | "user" | "tool")
                ));
                if let Some(tools) = message["tool_calls"].as_array() {
                    assert_eq!(message["role"], "assistant");
                    for tool in tools {
                        assert!(calls.insert(tool["id"].as_str().unwrap().to_owned()));
                    }
                }
                if message["role"] == "tool" {
                    assert!(calls.remove(message["tool_call_id"].as_str().unwrap()));
                }
            }
            providers::anthropic::FAMILY => {
                assert!(matches!(
                    message["role"].as_str(),
                    Some("user" | "assistant")
                ));
                for block in message["content"].as_array().unwrap() {
                    if block["type"] == "tool_use" {
                        assert_eq!(message["role"], "assistant");
                        assert!(block["input"].is_object());
                        assert!(calls.insert(block["id"].as_str().unwrap().to_owned()));
                    } else if block["type"] == "tool_result" {
                        assert_eq!(message["role"], "user");
                        assert!(calls.remove(block["tool_use_id"].as_str().unwrap()));
                    }
                }
            }
            providers::google::FAMILY => {
                assert!(matches!(message["role"].as_str(), Some("user" | "model")));
                for part in message["parts"].as_array().unwrap() {
                    if let Some(call) = part.get("functionCall") {
                        assert_eq!(message["role"], "model");
                        assert!(call["args"].is_object());
                        assert!(calls.insert(call["id"].as_str().unwrap().to_owned()));
                    } else if let Some(result) = part.get("functionResponse") {
                        assert_eq!(message["role"], "user");
                        assert!(calls.remove(result["id"].as_str().unwrap()));
                    }
                }
            }
            _ => unreachable!(),
        }
    }
    assert!(
        calls.is_empty(),
        "all retained tool calls precede their completed results"
    );
    if family == providers::codex::FAMILY {
        assert!(body["instructions"].is_string());
        assert_eq!(body["prompt_cache_key"].as_str().unwrap().len(), 64);
        assert!(transcript(family, body)
            .iter()
            .all(|item| item["role"] != "system"));
    }
}

#[test]
fn real_engine_keeps_collaboration_observations_append_only_in_five_protocols() {
    let mut fixture = Fixture::new();
    let accepted = fixture.accept();
    fixture.settle_exchange();
    let child = prepare_child(&mut fixture, accepted);
    let child_run = child.receipt.as_ref().unwrap().run_id.clone();
    fixture
        .db
        .commit_execution(
            &child_run,
            fixture.db.epoch(),
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
    let input = fixture
        .db
        .prepare_execution(
            &fixture.context.run_id,
            binding(&fixture),
            Policy.identity(),
            Value::Null,
        )
        .unwrap();
    let root = fixture.root.clone();
    let catalog = Arc::new(Mutex::new(fixture.db));
    let provider = Arc::new(Provider {
        original: providers::responses::ResponsesProvider::new(connection()),
        catalog: catalog.clone(),
        captured: Mutex::new(Capture {
            requests: vec![],
            wire: vec![],
            old_tails: vec![],
        }),
    });
    let engine = ExecutionEngine {
        persistence: catalog.clone(),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: provider.clone(),
        tools: Arc::new(Tools {
            catalog: catalog.clone(),
            child,
            child_run,
            count: Mutex::new(0),
        }),
        policy: Arc::new(Policy),
        progress: ProgressSink::default(),
    };
    let report = engine.run(input, CancellationToken::default()).unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let captured = provider.captured.lock().unwrap();
    assert_eq!(captured.requests.len(), 4);
    assert_eq!(
        captured
            .requests
            .iter()
            .map(|view| observations(view).len())
            .collect::<Vec<_>>(),
        vec![1, 1, 2, 2]
    );
    for pair in captured.requests.windows(2) {
        assert!(
            pair[1].history.starts_with(&pair[0].history),
            "the actual Engine history prefix must remain byte-for-byte semantic history"
        );
        for (old, _) in observations(&pair[0]) {
            let retained = pair[1]
                .history
                .iter()
                .find(|item| item.id == old.id)
                .unwrap();
            assert_eq!(
                serde_json::to_vec(retained).unwrap(),
                serde_json::to_vec(old).unwrap()
            );
        }
    }
    assert_ne!(
        observations(&captured.requests[2])[0].1.members[0].name,
        observations(&captured.requests[2])[1].1.members[0].name
    );
    let durable = catalog
        .lock()
        .unwrap()
        .execution_history("branch:parent")
        .unwrap();
    assert_eq!(
        durable
            .iter()
            .filter(|item| CollaborationSnapshot::is_item(item))
            .count(),
        2
    );
    for (family, adapter) in adapters() {
        let mut previous: Option<Value> = None;
        let mut previous_old: Option<Value> = None;
        let mut negative_control_detected = false;
        for (index, captured_view) in captured.requests.iter().enumerate() {
            let mut view = captured_view.clone();
            view.binding.provider_family = family.into();
            let body = adapter.serialize(&view, None).unwrap();
            let parsed: Value = serde_json::from_slice(&body.wire_bytes()).unwrap();
            assert_eq!(parsed, body.to_value());
            assert_eq!(
                body.wire_bytes(),
                adapter.serialize(&view, None).unwrap().wire_bytes(),
                "repeated compilation is deterministic for {family}"
            );
            validate_wire(family, &parsed);
            if family == providers::responses::FAMILY {
                assert_eq!(
                    body.wire_bytes().as_ref(),
                    captured.wire[index].as_slice(),
                    "actual Engine reuse matches cold Responses serialization"
                );
            }
            if let Some(previous) = &previous {
                assert!(
                    transcript(family, &parsed).starts_with(transcript(family, previous)),
                    "{family}: real request lost its prior transcript prefix at {index}"
                );
                for field in [
                    "tools",
                    "system",
                    "systemInstruction",
                    "instructions",
                    "prompt_cache_key",
                ] {
                    assert_eq!(
                        parsed.get(field),
                        previous.get(field),
                        "{family}: fixed field {field}"
                    );
                }
            }
            previous = Some(parsed);
            // A negative control reuses this exact Engine trace, replacing the durable
            // observations with the old real family reader's ephemeral trailing projection.
            view.history
                .retain(|item| !CollaborationSnapshot::is_item(item));
            view.history
                .push(Arc::new(captured.old_tails[index].clone()));
            let old = adapter.serialize(&view, None).unwrap().to_value();
            if let Some(previous) = &previous_old {
                negative_control_detected |=
                    !transcript(family, &old).starts_with(transcript(family, previous));
            }
            previous_old = Some(old);
        }
        assert!(
            negative_control_detected,
            "{family}: the probe must detect the original tail-replacement behavior"
        );
    }
    drop(captured);
    drop(engine);
    drop(provider);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}
