//! Production bridge and actual Engine/Catalog. The channel fixture is not Host Unix IPC.
use super::*;
use std::{sync::atomic::AtomicBool, time::Duration};
use varin_runtime::{
    catalog::launches::LaunchSelection, supervisor::RunStart, Effect, Lifetime, OperationPhase,
    RunState, SubmitInput,
};
#[path = "../../varin-runtime/tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
fn artifact(version: &str, transition: PolicyStateTransition) -> AgentPolicyArtifactBinding {
    AgentPolicyArtifactBinding {
        provider_key: "fixture:strategy".into(),
        extension_id: "fixture".into(),
        extension_version: version.into(),
        service_id: "varin.agent.policy".into(),
        service_version: 3,
        artifact_integrity: format!("artifact-{version}"),
        configuration_identity: "configuration".into(),
        declared_identity: PolicyIdentity {
            name: "strategy".into(),
            version: version.into(),
        },
        identity: PolicyIdentity {
            name: "fixture:strategy".into(),
            version: format!("exact-{version}"),
        },
        model_roles: vec![],
        state_transition: transition,
    }
}
fn schema() -> ToolSchema {
    ToolSchema {
        name: "independent_job".into(),
        version: "old-schema".into(),
        description: "fixture accepted job".into(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    }
}
struct Fixture {
    root: std::path::PathBuf,
    db: Arc<Mutex<Catalog>>,
    bridge: PolicyBridge,
    output: mpsc::Receiver<Value>,
    credentials: crate::credential_bridge::CredentialBridge,
    run: String,
    binding: RequestBinding,
    old: AgentPolicyArtifactBinding,
    policy: Arc<dyn AgentPolicy>,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-policy-binding-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "main").unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("work"),
                configuration: json!({}),
            })
            .unwrap();
        let binding = RequestBinding {
            resource_activations: Vec::new(),
            resource_checkpoint_id: None,
            connection_identity: "original-main".into(),
            provider_family: "fixture".into(),
            model: "original-main".into(),
            credential_ref: None,
            configuration_generation: 7,
            tool_schema_generation: 9,
            tools: vec![schema()],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: "main".into(),
                ancestor_id: None,
                leaf_id: Some(receipt.input_id),
            },
        };
        let old = artifact("old", PolicyStateTransition::Unsupported);
        let default = effective_identity(DefaultAgentPolicy.identity());
        db.select_launch(
            &receipt.run_id,
            LaunchSelection::from_binding(&binding, default.clone(), None),
        )
        .unwrap();
        let prepared = db
            .prepare_policy_change(
                &receipt.run_id,
                default,
                effective_identity(old.identity.clone()),
                vec![],
                PolicyTarget::Extension {
                    artifact: old.clone(),
                },
            )
            .unwrap()
            .load()
            .unwrap();
        db.admit_launch_change(prepared).unwrap();
        db.bind_launch(
            &receipt.run_id,
            LaunchSelection::from_binding(&binding, effective_identity(old.identity.clone()), None),
        )
        .unwrap();
        let db = Arc::new(Mutex::new(db));
        let (tx, output) = mpsc::sync_channel(16);
        let bridge = PolicyBridge::new(tx.clone());
        bridge.initialize("epoch");
        bridge.set_catalog(db.clone());
        let credentials = crate::credential_bridge::CredentialBridge::new(tx);
        credentials.initialize("epoch").unwrap();
        let inner = bridge
            .policy(receipt.run_id.clone(), "old-live".into(), 0, old.clone())
            .unwrap();
        let policy = bridge
            .install(
                &receipt.run_id,
                0,
                PolicyTarget::Extension {
                    artifact: old.clone(),
                },
                inner,
                vec![],
                BTreeMap::new(),
            )
            .unwrap();
        Self {
            root,
            db,
            bridge,
            output,
            credentials,
            run: receipt.run_id,
            binding,
            old,
            policy,
        }
    }
    fn start(
        &self,
        provider: Arc<dyn ModelProvider>,
        tools: Arc<dyn ToolExecutor>,
    ) -> mpsc::Receiver<Result<ExecutionReport, ExecutionError>> {
        let mut start = RunStart {
            binding: self.binding.clone(),
            policy_state: Value::Null,
            policy: self.policy.clone(),
            provider: self.bridge.wrap_models(&self.run, provider).unwrap(),
            tools,
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        };
        start = crate::questions::configure(start, self.db.clone());
        start = crate::collaboration::configure(start, self.db.clone());
        start = crate::process_wait::configure(start, self.db.clone());
        let input = self
            .db
            .lock()
            .unwrap()
            .prepare_execution(
                &self.run,
                start.binding,
                start.policy.identity(),
                Value::Null,
            )
            .unwrap();
        let engine = ExecutionEngine {
            persistence: self.db.clone(),
            context_preparation: start.context_preparation,
            provider: start.provider,
            tools: start.tools,
            policy: start.policy,
            progress: start.progress,
        };
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(engine.run(input, CancellationToken::default()));
        });
        rx
    }
    fn ready(
        &self,
        name: &str,
        mode: PolicyStateMode,
        transition: PolicyStateTransition,
    ) -> PolicySelection {
        let target = artifact(name, transition);
        let previous = self
            .db
            .lock()
            .unwrap()
            .policy_selections(&self.run)
            .unwrap();
        let selected = self
            .db
            .lock()
            .unwrap()
            .select_policy(
                &self.run,
                name,
                previous.active.generation,
                previous.desired.map(|s| s.selection_id),
                PolicyTarget::Extension {
                    artifact: target.clone(),
                },
                mode,
            )
            .unwrap();
        self.bridge
            .ready(
                selected,
                Some(crate::protocol_generated::AgentPolicyBinding {
                    reference: format!("{name}-live"),
                    generation: 1,
                    artifact: target,
                }),
                vec![],
                &self.credentials,
                &AtomicBool::new(false),
            )
            .unwrap()
    }
    fn next(&self, kind: &str) -> Value {
        loop {
            let value = self.output.recv_timeout(Duration::from_secs(10)).unwrap();
            if value["kind"] == kind {
                return value;
            }
            assert!(
                value["kind"].as_str().unwrap().ends_with("-release")
                    || value["kind"].as_str().unwrap().ends_with("-cancel"),
                "unexpected {value}"
            );
        }
    }
    fn reply(&self, request: &Value, action: PolicyAction, state: Value) {
        self.bridge.receive(json!({"v":1,"kind":"agent-policy-response","id":request["id"],"kernelEpoch":"epoch","generation":request["generation"],"ok":true,"decision":{"action":action,"state":state}}));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.bridge.close();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
struct BlockedModel {
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    requests: Mutex<Vec<RequestSnapshot>>,
}
impl ModelProvider for BlockedModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.requests.lock().unwrap().push(request.clone());
        self.entered.send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "call".into(),
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: "old-call".into(),
                        name: "independent_job".into(),
                        schema_version: "old-schema".into(),
                        arguments: json!({"original":true}),
                    },
                },
                opaque: Some(OpaqueProviderItem {
                    connection_identity: "original-main".into(),
                    family: "fixture".into(),
                    adapter_version: "1".into(),
                    value: json!({"signed":"original-provider"}),
                }),
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
#[derive(Default)]
struct Job(Mutex<Option<String>>);
impl ToolExecutor for Job {
    fn plan(
        &self,
        call: &ToolCall,
        view: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, view, cancel).map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        view: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        assert_eq!(call.schema_version, "old-schema");
        assert_eq!(view.tools.as_ref(), &vec![schema()]);
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: false,
            completion: CompletionKind::Job,
            lifetime: Lifetime::Thread,
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
        context: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        *self.0.lock().unwrap() = Some(context.operation_id.clone());
        ToolCompletion::JobAccepted {
            operation_id: context.operation_id.clone(),
            phase: "accepted".into(),
            effect: Effect::None,
            lifetime: Lifetime::Thread,
        }
    }
}
struct NoModel;
impl ModelProvider for NoModel {
    fn serialize(&self, _: &RequestView) -> Result<Value, ExecutionError> {
        panic!("no model requested")
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        panic!("no model requested")
    }
}
#[test]
fn old_decision_model_and_job_acceptance_close_before_new_binding_activates() {
    let f = Fixture::new();
    let (entered_tx, entered) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let provider = Arc::new(BlockedModel {
        entered: entered_tx,
        release: Mutex::new(release_rx),
        requests: Mutex::new(vec![]),
    });
    let job = Arc::new(Job::default());
    let done = f.start(provider.clone(), job.clone());
    let first = f.next("agent-policy-request");
    assert_eq!(first["generation"], 0);
    let selected = f.ready(
        "next",
        PolicyStateMode::RestartState,
        PolicyStateTransition::Unsupported,
    );
    assert_eq!(
        f.db.lock()
            .unwrap()
            .policy_selections(&f.run)
            .unwrap()
            .active
            .generation,
        0
    );
    f.reply(
        &first,
        PolicyAction::RequestModel,
        json!({"old":"requested"}),
    );
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        f.db.lock()
            .unwrap()
            .policy_selections(&f.run)
            .unwrap()
            .active
            .generation,
        0
    );
    release.send(()).unwrap();
    let tools = f.next("agent-policy-request");
    assert_eq!(tools["generation"], 0);
    assert_eq!(tools["input"]["event"]["kind"], "model_completed");
    f.reply(&tools, PolicyAction::ExecuteTools, json!({"old":"tools"}));
    let next = f.next("agent-policy-request");
    assert_eq!(next["generation"], selected.generation);
    assert_eq!(next["input"]["event"]["kind"], "tools_completed");
    assert_eq!(
        next["input"]["event"]["results"][0]["completion"]["kind"],
        "job_accepted"
    );
    assert!(next["input"]["state"].is_null());
    // A valid-looking old reply cannot satisfy the new binding's pending request.
    f.bridge.receive(json!({"v":1,"kind":"agent-policy-response","id":next["id"],"kernelEpoch":"epoch","generation":0,"ok":true,"decision":{"action":{"kind":"complete"},"state":"wrong generation"}}));
    assert!(done.recv_timeout(Duration::from_millis(20)).is_err());
    f.reply(
        &next,
        PolicyAction::Deliver {
            text: "new policy delivery".into(),
        },
        json!({"new":1}),
    );
    let delivered = f.next("agent-policy-request");
    assert_eq!(delivered["input"]["event"]["kind"], "delivered");
    f.reply(&delivered, PolicyAction::Complete, json!({"new":2}));
    let report = done.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
    let saved = provider.requests.lock().unwrap()[0].view.binding.clone();
    assert_eq!(saved.model, "original-main");
    assert_eq!(saved.tool_schema_generation, 9);
    let operation =
        f.db.lock()
            .unwrap()
            .operation(job.0.lock().unwrap().as_ref().unwrap())
            .unwrap();
    assert_ne!(operation.phase, OperationPhase::Terminal);
    assert!(!operation.cancel_requested);
    assert!(matches!(
        operation.call_completion,
        Some(varin_runtime::catalog::result_content::ToolCompletionMetadata::JobAccepted { .. })
    ));
    let history = f.db.lock().unwrap().history("main").unwrap();
    assert!(history.iter().any(|h| h
        .provider
        .as_ref()
        .is_some_and(|p| p.item == json!({"signed":"original-provider"}))));
}
#[test]
fn incompatible_candidate_keeps_original_checkpoint_and_large_explicit_transition_is_not_rejected_as_one_frame(
) {
    for explicit in [false, true] {
        let f = Fixture::new();
        let done = f.start(Arc::new(NoModel), Arc::new(Job::default()));
        let started = f.next("agent-policy-request");
        let new = f.ready(
            "next",
            PolicyStateMode::Preserve,
            if explicit {
                PolicyStateTransition::Explicit
            } else {
                PolicyStateTransition::Unsupported
            },
        );
        let old_state = if explicit {
            Value::String("x".repeat(crate::protocol::MAX_FRAME_BYTES + 1))
        } else {
            json!({"old":"retain me"})
        };
        f.reply(
            &started,
            PolicyAction::Deliver {
                text: "old delivery".into(),
            },
            old_state.clone(),
        );
        if explicit {
            let transition = f.next("agent-policy-transition-request");
            assert_eq!(transition["generation"], new.generation);
            assert_eq!(
                transition["input"]["from"]["identity"],
                serde_json::to_value(&f.old.identity).unwrap()
            );
            assert_eq!(transition["input"]["event"]["kind"], "delivered");
            assert_eq!(transition["input"]["state"], old_state);
            assert_eq!(
                f.db.lock()
                    .unwrap()
                    .policy_selections(&f.run)
                    .unwrap()
                    .active
                    .generation,
                0
            );
            f.bridge.receive(json!({"v":1,"kind":"agent-policy-transition-response","id":transition["id"],"kernelEpoch":"epoch","generation":new.generation,"ok":true,"transition":{"kind":"compatible","state":{"converted":true}}}));
        }
        let next = f.next("agent-policy-request");
        assert_eq!(next["input"]["event"]["kind"], "delivered");
        assert_eq!(
            next["generation"],
            if explicit { new.generation } else { 0 }
        );
        assert_eq!(
            next["input"]["state"],
            if explicit {
                json!({"converted":true})
            } else {
                old_state
            }
        );
        if !explicit {
            assert_eq!(
                f.db.lock()
                    .unwrap()
                    .policy_selection(&f.run, "next")
                    .unwrap()
                    .failure
                    .as_deref(),
                Some("policy_state_incompatible")
            );
        }
        f.reply(&next, PolicyAction::Complete, json!({"done":true}));
        assert_eq!(
            done.recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap()
                .state,
            RunState::Completed
        );
    }
}
