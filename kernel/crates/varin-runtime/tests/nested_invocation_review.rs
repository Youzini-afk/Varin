//! Canonical Catalog/engine checks; installed SDK/broker/domain consumers have separate tests.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Effect, ExecutorOwner, Lifetime, Outcome, SubmitInput};

fn owner() -> ExecutorOwner {
    ExecutorOwner::External {
        identity: "controlled-original-executor".into(),
        epoch: "epoch".into(),
    }
}
fn identity() -> PolicyIdentity {
    PolicyIdentity {
        name: "nested-review".into(),
        version: "1".into(),
    }
}
fn call(name: &str, id: &str) -> ToolCall {
    ToolCall {
        call_id: id.into(),
        name: name.into(),
        schema_version: "1".into(),
        arguments: json!({}),
    }
}
fn schema(name: &str) -> ToolSchema {
    ToolSchema {
        requirements: None,
        name: name.into(),
        version: "1".into(),
        description: "".into(),
        schema: json!({"type":"object"}),
        metadata: None,
        output_schema: None,
    }
}
struct Provider(AtomicUsize);
impl ModelProvider for Provider {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: if first { "outer" } else { "answer" }.into(),
                content: if first {
                    Content::ToolCall {
                        call: call("compose", "outer"),
                    }
                } else {
                    Content::Text {
                        text: "done".into(),
                    }
                },
                opaque: None,
            },
        })
        .map_err(|e| ModelFailure {
            code: e.code,
            message: e.message,
            retry_after_ms: None,
            provider_request_id: None,
        })?;
        Ok(if first {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}
struct GraphPolicy;
impl AgentPolicy for GraphPolicy {
    fn identity(&self) -> PolicyIdentity {
        identity()
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        Ok(PolicyDecision {
            state: state.clone(),
            action: if matches!(event, PolicyEvent::Started) {
                PolicyAction::ToolGraph {
                    nodes: vec![PolicyToolNode {
                        id: "outer".into(),
                        depends_on: vec![],
                        call: call("compose", "outer"),
                    }],
                }
            } else {
                PolicyAction::Complete
            },
        })
    }
}
struct BlockedEffect {
    started: mpsc::Sender<ToolExecutionContext>,
    cancelled: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
struct Tools {
    db: Arc<Mutex<Catalog>>,
    calls: Mutex<Vec<ToolExecutionContext>>,
    effects: AtomicUsize,
    blocked: Option<BlockedEffect>,
}
impl ToolExecutor for Tools {
    fn executor_owner(&self) -> ExecutorOwner {
        owner()
    }
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        assert_eq!(context.tools.len(), 3);
        assert_eq!(context.tool_schema_generation, 7);
        Ok(ToolPreparation::Ready(self.prepare(call, context, cancel)?))
    }
    fn prepare(
        &self,
        call: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: call.name == "read",
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: if call.name == "effect" {
                vec![ResourceClaim {
                    key: "controlled-writer".into(),
                    access: Access::Write,
                }]
            } else {
                vec![]
            },
        })
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        let read = self
            .db
            .lock()
            .unwrap()
            .capture_tool_invocation(context, &call.call_id)
            .unwrap();
        let snapshot = read.load().unwrap();
        assert_eq!(snapshot.call, *call);
        assert_eq!(snapshot.tools.len(), 3);
        self.db
            .lock()
            .unwrap()
            .validate_tool_invocation(&snapshot, true)
            .unwrap();
        Ok(())
    }
    fn execute_receipt(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        self.calls.lock().unwrap().push(context.clone());
        if call.name == "compose" {
            let registry = self.db.lock().unwrap().nested_tools();
            let input = |id: &str, name: &str| NestedToolInput {
                call_id: id.into(),
                name: name.into(),
                arguments: json!({}),
            };
            if call.arguments["nested"] == true {
                let inner = registry
                    .invoke(&context.operation_id, &owner(), input("y", "read"))
                    .unwrap();
                return ToolExecutionReceipt {
                    executor_stopped: true,
                    completion: ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::Confirmed,
                        content: json!({"operationId":inner.operation_id}).into(),
                    },
                };
            }
            let read = registry
                .invoke(&context.operation_id, &owner(), input("read", "read"))
                .unwrap();
            assert!(matches!(
                read.completion,
                ToolCompletion::Result {
                    effect: Effect::None,
                    ..
                }
            ));
            let effect = registry
                .invoke(&context.operation_id, &owner(), input("effect", "effect"))
                .unwrap();
            if self.blocked.is_none() {
                assert_eq!(
                    effect,
                    registry
                        .invoke(&context.operation_id, &owner(), input("effect", "effect"))
                        .unwrap()
                );
                let mut changed = input("effect", "effect");
                changed.arguments = json!({"changed":true});
                assert!(
                    registry
                        .invoke(&context.operation_id, &owner(), changed)
                        .is_err()
                );
                assert!(
                    registry
                        .invoke(&context.operation_id, &owner(), input("hidden", "disabled"))
                        .is_err()
                );
                let direct = registry
                    .invoke(&context.operation_id, &owner(), input("x:nested:y", "read"))
                    .unwrap();
                let mut deep = input("x", "compose");
                deep.arguments = json!({"nested":true});
                let descendant = registry
                    .invoke(&context.operation_id, &owner(), deep)
                    .unwrap();
                let ToolCompletion::Result { content, .. } = descendant.completion else {
                    panic!("nested composition result")
                };
                assert_ne!(
                    direct.operation_id,
                    content.data["operationId"].as_str().unwrap()
                );
            }
            // Deliberately omit inner receipt/output. Its original Operation must remain reconcilable after the outer callback finishes.
            ToolExecutionReceipt {
                executor_stopped: true,
                completion: ToolCompletion::Result {
                    outcome: Outcome::Succeeded,
                    effect: Effect::Confirmed,
                    content: json!({"caught":true}).into(),
                },
            }
        } else {
            if call.name == "effect" {
                self.effects.fetch_add(1, Ordering::SeqCst);
            }
            if call.name == "effect" {
                if let Some(blocked) = &self.blocked {
                    let (wake, wait) = mpsc::sync_channel(1);
                    let _registration = cancel.wake_on_cancel(wake);
                    blocked.started.send(context.clone()).unwrap();
                    wait.recv_timeout(std::time::Duration::from_secs(3))
                        .unwrap();
                    assert!(cancel.is_cancelled());
                    blocked.cancelled.send(()).unwrap();
                    blocked.release.lock().unwrap().recv().unwrap();
                    return ToolExecutionReceipt {
                        executor_stopped: true,
                        completion: ToolCompletion::Result {
                            outcome: Outcome::Cancelled,
                            effect: Effect::Partial,
                            content: json!({"actual":"stopped after partial work"}).into(),
                        },
                    };
                }
            }
            ToolExecutionReceipt {
                executor_stopped: call.name == "read",
                completion: ToolCompletion::Result {
                    outcome: if call.name == "read" {
                        Outcome::Succeeded
                    } else {
                        Outcome::Indeterminate
                    },
                    effect: if call.name == "read" {
                        Effect::None
                    } else {
                        Effect::Unknown
                    },
                    content: json!({"original":call.name}).into(),
                },
            }
        }
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        unreachable!("trusted receipt owner")
    }
}
fn setup(
    policy: bool,
) -> (
    std::path::PathBuf,
    Arc<Mutex<Catalog>>,
    ExecutionInput,
    Arc<dyn AgentPolicy>,
) {
    let path = std::env::temp_dir().join(format!("varin-nested-review-{}", uuid::Uuid::new_v4()));
    let mut catalog = Catalog::open(&path).unwrap();
    catalog.create_thread("thread", "main").unwrap();
    let receipt = catalog
        .submit(&SubmitInput {
            key: "input".into(),
            thread_id: "thread".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!("compose"),
            configuration: json!({}),
        })
        .unwrap();
    let binding = RequestBinding {
        provider_id: None,
        tokenizer: None,
        request_context: None,
        child_dispatch: None,
        goal: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        connection_identity: "fixture".into(),
        provider_family: "fixture".into(),
        model: "fixture".into(),
        credential_ref: None,
        configuration_generation: 1,
        tool_schema_generation: 7,
        tools: vec![schema("compose"), schema("read"), schema("effect")],
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
    let selected: Arc<dyn AgentPolicy> = if policy {
        Arc::new(GraphPolicy)
    } else {
        Arc::new(DefaultAgentPolicy)
    };
    let input = catalog
        .prepare_execution(&receipt.run_id, binding, selected.identity(), Value::Null)
        .unwrap();
    let db = Arc::new(Mutex::new(catalog));
    (path, db, input, selected)
}
#[test]
fn model_and_policy_nested_calls_share_original_catalog_without_inner_model_pairing_or_replay() {
    for policy in [false, true] {
        let (path, db, input, selected) = setup(policy);
        let tools = Arc::new(Tools {
            db: db.clone(),
            calls: Mutex::new(vec![]),
            effects: AtomicUsize::new(0),
            blocked: None,
        });
        let engine = ExecutionEngine {
            persistence: db.clone(),
            context_preparation: Arc::new(NoopContextPreparation),
            provider: Arc::new(Provider(AtomicUsize::new(0))),
            tools: tools.clone(),
            policy: selected,
            progress: ProgressSink::default(),
        };
        let report = engine.run(input, CancellationToken::default()).unwrap();
        assert_eq!(tools.effects.load(Ordering::SeqCst), 1);
        let calls = tools.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 6);
        let outer = &calls[0];
        let child = &calls[2];
        assert_eq!(
            child.origin,
            ToolOrigin::NestedCall {
                parent_operation_id: outer.operation_id.clone()
            }
        );
        let operation = db.lock().unwrap().operation(&child.operation_id).unwrap();
        assert_eq!(operation.effect, Effect::Unknown);
        let outer_operation = db.lock().unwrap().operation(&outer.operation_id).unwrap();
        assert_eq!(outer_operation.effect, Effect::Confirmed);
        assert_eq!(outer_operation.outcome, Some(Outcome::Succeeded));
        assert!(
            db.resource_admission()
                .inspect(&child.operation_id)
                .is_some()
        );
        assert!(
            db.resource_admission()
                .inspect(&outer.operation_id)
                .is_none()
        );
        let read = db.lock().unwrap().operation(&calls[1].operation_id).unwrap();
        assert_eq!(read.effect, Effect::None);
        assert_eq!(read.outcome, Some(Outcome::Succeeded));
        assert!(db.lock().unwrap().external_delivery_persisted(&read.id).unwrap(),
            "external reads retain their original stop receipt");
        assert!(db.resource_admission().inspect(&read.id).is_none());
        let paired: Vec<_> = report
            .history
            .iter()
            .filter_map(|item| match &item.content {
                Content::ToolResult { result } => Some(result.call_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(paired, if policy { vec![] } else { vec!["outer"] });
        let registry = db.lock().unwrap().nested_tools();
        assert!(
            registry
                .invoke(
                    &outer.operation_id,
                    &owner(),
                    NestedToolInput {
                        call_id: "late".into(),
                        name: "read".into(),
                        arguments: json!({})
                    }
                )
                .is_err()
        );
        drop(engine);
        drop(tools);
        drop(db);
        let mut reopened = Catalog::open(&path).unwrap();
        assert_eq!(
            reopened.operation(&child.operation_id).unwrap().effect,
            Effect::Unknown
        );
        assert!(
            reopened
                .nested_tools()
                .invoke(
                    &outer.operation_id,
                    &owner(),
                    NestedToolInput {
                        call_id: "effect".into(),
                        name: "effect".into(),
                        arguments: json!({})
                    }
                )
                .is_err()
        );
        reopened
            .record_external_receipt_with_stop(
                &child.operation_id,
                varin_runtime::ExternalReceipt {
                    executor: "effect".into(),
                    identity: child.operation_id.clone(),
                    epoch: "epoch".into(),
                    outcome: Outcome::Succeeded,
                    effect: Effect::Confirmed,
                    result: json!({"original":"effect","reconciled":true}).into(),
                },
                true,
            )
            .unwrap();
        assert_eq!(
            reopened.operation(&child.operation_id).unwrap().effect,
            Effect::Confirmed
        );
        assert_eq!(
            reopened.operation(&outer.operation_id).unwrap().revision,
            outer_operation.revision
        );
        assert_eq!(
            reopened.operation(&outer.operation_id).unwrap().effect,
            Effect::Confirmed
        );
        assert!(
            reopened
                .resource_admission()
                .inspect(&child.operation_id)
                .is_none()
        );
        drop(reopened);
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[test]
fn nested_exact_operation_alias_and_parent_cancel_wait_for_actual_executor_receipt() {
    for parent in [false, true] {
        let (path, db, input, selected) = setup(false);
        let (started, entered) = mpsc::channel();
        let (cancelled, seen) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let tools = Arc::new(Tools {
            db: db.clone(),
            calls: Mutex::new(vec![]),
            effects: AtomicUsize::new(0),
            blocked: Some(BlockedEffect {
                started,
                cancelled,
                release: Mutex::new(wait),
            }),
        });
        let cancel = CancellationToken::default();
        let running = cancel.clone();
        let engine = ExecutionEngine {
            persistence: db.clone(),
            context_preparation: Arc::new(NoopContextPreparation),
            provider: Arc::new(Provider(AtomicUsize::new(0))),
            tools: tools.clone(),
            policy: selected,
            progress: ProgressSink::default(),
        };
        let worker = std::thread::spawn(move || engine.run(input, running));
        let child = entered
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        if parent {
            cancel.cancel();
        } else {
            db.lock()
                .unwrap()
                .request_cancel_operation(&child.operation_id)
                .unwrap();
            assert!(
                cancel.cancel_child(&child.operation_id),
                "exact nested Operation resolves through original Run token alias"
            );
        }
        seen.recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        assert!(
            !worker.is_finished(),
            "cancellation notification cannot settle an executing callback"
        );
        assert!(
            db.resource_admission()
                .inspect(&child.operation_id)
                .is_some()
        );
        release.send(()).unwrap();
        worker.join().unwrap().unwrap();
        let operation = db.lock().unwrap().operation(&child.operation_id).unwrap();
        assert_eq!(operation.outcome, Some(Outcome::Cancelled));
        assert_eq!(operation.effect, Effect::Partial);
        assert!(
            db.resource_admission()
                .inspect(&child.operation_id)
                .is_none()
        );
        assert_eq!(cancel.is_cancelled(), parent);
        drop(tools);
        drop(db);
        std::fs::remove_dir_all(path).unwrap();
    }
}
