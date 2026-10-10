//! Goal commands and the ordinary original-call report endpoint share Catalog authority.
use crate::agent_runtime::domain;
use crate::error::KernelError;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use varin_runtime::catalog::goals::*;
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Lifetime};

pub(crate) fn execute_rpc(
    catalog: Arc<Mutex<Catalog>>,
    method: &str,
    params: Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, KernelError> {
    let check = || {
        if cancelled.load(Ordering::Acquire) {
            Err(KernelError::Cancelled)
        } else {
            Ok(())
        }
    };
    check()?;
    if method == "runtime.goal.list" {
        let p: crate::protocol_generated::ThreadParams = serde_json::from_value(params)?;
        let reads = catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_goals(&p.thread_id)
            .map_err(domain)?;
        let values = reads
            .into_iter()
            .map(|read| read.load())
            .collect::<Result<Vec<_>, _>>()
            .map_err(domain)?;
        check()?;
        return Ok(serde_json::to_value(values)?);
    }
    let preparation = if method == "runtime.goal.start" {
        let p: crate::protocol_generated::GoalStartParams = serde_json::from_value(params)?;
        catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .prepare_goal_start(
                &p.key,
                &p.run_id,
                GoalScope {
                    thread_id: p.thread_id,
                    branch_id: p.branch_id,
                },
                p.objective,
                p.budget.0,
            )
            .map_err(domain)?
    } else {
        let p: crate::protocol_generated::GoalUpdateParams = serde_json::from_value(params)?;
        catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .prepare_goal_update(
                &p.goal_id,
                p.expected_revision.try_into().map_err(|_| {
                    KernelError::Protocol("Goal revision must be nonnegative".into())
                })?,
                GoalScope {
                    thread_id: p.thread_id,
                    branch_id: p.branch_id,
                },
                p.objective,
                p.budget.0,
            )
            .map_err(domain)?
    };
    let prepared = preparation.load().map_err(domain)?;
    check()?;
    let receipt = catalog
        .lock()
        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
        .admit_goal_mutation(prepared)
        .map_err(domain)?;
    Ok(serde_json::to_value(receipt)?)
}
pub(crate) fn schema() -> ToolSchema {
    ToolSchema{name:REPORT_TOOL.into(),version:"1".into(),description:"Report the explicitly established continuing Goal as complete or blocked. An ordinary final answer only finishes one Run. Give the real reason. A blocked report may name waitOperationId from this Run's original process_spawn Job; continuation then waits for its real stop. This does not grant new permissions or control a parent Goal from a child task.".into(),output_schema:None,metadata:None,
        schema:json!({"type":"object","properties":{"state":{"type":"string","enum":["complete","blocked"]},"reason":{"type":"string","minLength":1},"waitOperationId":{"type":"string","minLength":1}},"required":["state","reason"],"additionalProperties":false})}
}
fn error(e: impl ToString) -> ExecutionError {
    ExecutionError::new("goal_report", e.to_string())
}
fn contract() -> ToolContract {
    ToolContract {
        name: REPORT_TOOL.into(),
        schema_version: "1".into(),
        read_only: false,
        completion: CompletionKind::Result,
        lifetime: Lifetime::Run,
        resources: Vec::new(),
    }
}
struct GoalReports {
    catalog: Arc<Mutex<Catalog>>,
}
impl ToolExecutor for GoalReports {
    fn plan(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, request, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        call: &ToolCall,
        request: &FrozenToolContext,
        _cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        if call.name != REPORT_TOOL
            || call.schema_version != "1"
            || !request.tools.iter().any(|s| s == &schema())
        {
            return Err(error("Goal report schema is not bound"));
        }
        let input: GoalReportInput =
            serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if input.reason.trim().is_empty()
            || (input.state == GoalReportState::Complete && input.wait_operation_id.is_some())
        {
            return Err(error(
                "Goal report requires a reason and only blocked work can have a dependency",
            ));
        }
        Ok(contract())
    }
    fn authorize(
        &self,
        c: &ToolExecutionContext,
        _call: &ToolCall,
        _contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        if cancel.is_cancelled() {
            return Err(error("Goal report cancelled"));
        }
        self.catalog
            .lock()
            .map_err(error)?
            .prepare_goal_report(c)
            .map_err(error)?;
        Ok(())
    }
    fn execute(
        &self,
        c: &ToolExecutionContext,
        _call: &ToolCall,
        _contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        let result = (|| {
            let preparation = {
                self.catalog
                    .lock()
                    .map_err(error)?
                    .prepare_goal_report(c)
                    .map_err(error)?
            };
            let prepared = preparation.load().map_err(error)?;
            if cancel.is_cancelled() {
                return Err(error("Goal report cancelled"));
            }
            self.catalog
                .lock()
                .map_err(error)?
                .admit_goal_report(prepared)
                .map_err(error)
        })();
        result.unwrap_or_else(|e| ToolCompletion::NotDispatched {
            reason: format!("{}: {}", e.code, e.message),
        })
    }
}
pub(crate) fn declaration(
    catalog: Arc<Mutex<Catalog>>,
) -> varin_runtime::composition::tools::ToolDeclaration {
    varin_runtime::composition::tools::ToolDeclaration::new(
        schema(),
        Arc::new(GoalReports { catalog }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use varin_runtime::catalog::launches::LaunchSelection;
    use varin_runtime::{Effect, RunState, SubmitInput};
    struct Provider {
        catalog: Arc<Mutex<Catalog>>,
        pause: bool,
        blocked: bool,
        input_during_report: bool,
        seen: Mutex<Vec<RequestSnapshot>>,
    }
    impl ModelProvider for Provider {
        fn serialize(&self, v: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap())
        }
        fn generate(
            &self,
            r: &RequestSnapshot,
            _: &CancellationToken,
            emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            let first = {
                let mut seen = self.seen.lock().unwrap();
                seen.push(r.clone());
                seen.len() == 1
            };
            if first && self.pause {
                self.catalog
                    .lock()
                    .unwrap()
                    .control_goal(
                        "goal",
                        1,
                        &GoalScope {
                            thread_id: "thread".into(),
                            branch_id: "branch".into(),
                        },
                        GoalControlAction::Pause,
                    )
                    .unwrap();
            }
            if first && self.input_during_report {
                use varin_runtime::catalog::inputs::EnqueueInput;
                let prepared = {
                    self.catalog
                        .lock()
                        .unwrap()
                        .prepare_enqueue(EnqueueInput {
                            key: "during-report".into(),
                            thread_id: "thread".into(),
                            branch_id: "branch".into(),
                            mode: varin_runtime::InputMode::Boundary,
                            input: json!("USER_INPUT_AFTER_BLOCKED_REPORT"),
                            configuration: None,
                        })
                        .unwrap()
                }
                .load()
                .unwrap();
                self.catalog
                    .lock()
                    .unwrap()
                    .admit_queued_input(prepared)
                    .unwrap();
            }
            emit(ProviderEvent::Usage {
                receipt: UsageReceipt {
                    measurement: UsageMeasurement::Actual,
                    output_tokens: Some(9),
                    ..Default::default()
                },
            })
            .unwrap();
            emit(ProviderEvent::ItemCompleted{item:ProviderItem{id:"report".into(),content:Content::ToolCall{call:ToolCall{call_id:"report".into(),name:REPORT_TOOL.into(),schema_version:"1".into(),arguments:json!({"state":if self.blocked{"blocked"}else{"complete"},"reason":"The objective needs an explicit decision"})}},opaque:None}}).unwrap();
            Ok(FinishReason::ToolCalls)
        }
    }
    #[test]
    fn real_report_uses_original_call_and_pause_refuses_undispatched_effects() {
        for (pause, blocked, input_during_report) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (false, true, true),
        ] {
            let root =
                std::env::temp_dir().join(format!("varin-goal-tool-{}", uuid::Uuid::new_v4()));
            let mut db = Catalog::open(&root).unwrap();
            db.create_thread("thread", "branch").unwrap();
            let binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[schema()],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":null}})).unwrap();
            let launch =
                LaunchSelection::from_binding(&binding, DefaultAgentPolicy.identity(), None);
            let p = db
                .prepare_submission(
                    SubmitInput {
                        key: "input".into(),
                        thread_id: "thread".into(),
                        branch_id: "branch".into(),
                        expected_head: None,
                        input: json!("ordinary task"),
                        configuration: json!({}),
                    },
                    None,
                    None,
                )
                .unwrap()
                .load(Some(launch), false)
                .unwrap();
            let receipt = db.admit_submission(p).unwrap();
            let scope = GoalScope {
                thread_id: "thread".into(),
                branch_id: "branch".into(),
            };
            let p = db
                .prepare_goal_start(
                    "goal",
                    &receipt.run_id,
                    scope.clone(),
                    "A distinct continuing objective".into(),
                    None,
                )
                .unwrap()
                .load()
                .unwrap();
            db.admit_goal_mutation(p).unwrap();
            let input = db
                .prepare_execution(
                    &receipt.run_id,
                    binding.clone(),
                    DefaultAgentPolicy.identity(),
                    Value::Null,
                )
                .unwrap();
            let catalog = Arc::new(Mutex::new(db));
            let provider = Arc::new(Provider {
                catalog: catalog.clone(),
                pause,
                blocked,
                input_during_report,
                seen: Mutex::new(vec![]),
            });
            let engine = ExecutionEngine {
                context_preparation: Arc::new(NoopContextPreparation),
                persistence: catalog.clone(),
                provider: provider.clone(),
                tools: Arc::new(
                    varin_runtime::composition::tools::ToolDirectory::assemble(vec![declaration(
                        catalog.clone(),
                    )])
                    .unwrap(),
                ),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            };
            let report = engine.run(input, CancellationToken::default()).unwrap();
            assert_eq!(
                report.state,
                if pause || input_during_report {
                    RunState::Waiting
                } else {
                    RunState::Completed
                },
                "{:?}",
                report.failure
            );
            let request = provider.seen.lock().unwrap()[0].clone();
            assert!(request
                .view
                .history
                .iter()
                .any(|i| matches!(i.provenance, Provenance::GoalInstruction { .. })));
            let op_id = format!("{}:tool:report", request.view.request_id);
            {
                let db = catalog.lock().unwrap();
                let goal = db.capture_goal("goal").unwrap().load().unwrap();
                assert_eq!(
                    goal.state,
                    if pause {
                        GoalState::Paused
                    } else if blocked {
                        GoalState::Blocked
                    } else {
                        GoalState::Complete
                    }
                );
                assert_eq!(goal.usage.actual.output_tokens.known, 9);
                let op = db.operation(&op_id).unwrap();
                assert_eq!(
                    op.effect,
                    if pause {
                        Effect::None
                    } else {
                        Effect::Confirmed
                    }
                );
                assert!(op.call_completion.is_some());
                assert!(db
                    .events_after(0, 1000)
                    .unwrap()
                    .iter()
                    .any(|e| e.kind == "operation.settled"));
            }
            if pause {
                let input = {
                    let mut db = catalog.lock().unwrap();
                    db.control_goal("goal", 2, &scope, GoalControlAction::Resume)
                        .unwrap();
                    assert!(db.release_goal_wait(&receipt.run_id).unwrap());
                    db.prepare_execution(
                        &receipt.run_id,
                        binding.clone(),
                        DefaultAgentPolicy.identity(),
                        Value::Null,
                    )
                    .unwrap()
                };
                let report = engine.run(input, CancellationToken::default()).unwrap();
                assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
                let db = catalog.lock().unwrap();
                let goal = db.capture_goal("goal").unwrap().load().unwrap();
                assert_eq!(goal.state, GoalState::Complete);
                assert_eq!(goal.usage.actual.inferences, 2);
                assert_eq!(goal.usage.actual.output_tokens.known, 18);
            }
            if blocked {
                let next_run = if input_during_report {
                    receipt.run_id.clone()
                } else {
                    use varin_runtime::catalog::inputs::EnqueueInput;
                    let prepared = {
                        catalog
                            .lock()
                            .unwrap()
                            .prepare_enqueue(EnqueueInput {
                                key: "after-blocked".into(),
                                thread_id: "thread".into(),
                                branch_id: "branch".into(),
                                mode: varin_runtime::InputMode::Boundary,
                                input: json!("USER_INPUT_AFTER_BLOCKED_REPORT"),
                                configuration: None,
                            })
                            .unwrap()
                    }
                    .load()
                    .unwrap();
                    let queued = catalog
                        .lock()
                        .unwrap()
                        .admit_queued_input(prepared)
                        .unwrap()
                        .receipt;
                    assert_ne!(queued.run_id, receipt.run_id);
                    let input = catalog
                        .lock()
                        .unwrap()
                        .prepare_execution(
                            &queued.run_id,
                            binding.clone(),
                            DefaultAgentPolicy.identity(),
                            Value::Null,
                        )
                        .unwrap();
                    let report = engine.run(input, CancellationToken::default()).unwrap();
                    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
                    queued.run_id
                };
                assert_eq!(provider.seen.lock().unwrap().len(), 1);
                let input = {
                    let mut db = catalog.lock().unwrap();
                    assert!(!db.release_goal_wait(&next_run).unwrap());
                    db.control_goal("goal", 2, &scope, GoalControlAction::Resume)
                        .unwrap();
                    assert!(db.release_goal_wait(&next_run).unwrap());
                    db.prepare_execution(
                        &next_run,
                        binding,
                        DefaultAgentPolicy.identity(),
                        Value::Null,
                    )
                    .unwrap()
                };
                let report = engine.run(input, CancellationToken::default()).unwrap();
                assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
                let seen = provider.seen.lock().unwrap();
                assert_eq!(seen.len(), 2);
                assert!(serde_json::to_string(&seen[1].view.history)
                    .unwrap()
                    .contains("USER_INPUT_AFTER_BLOCKED_REPORT"));
            }
            drop(engine);
            drop(provider);
            drop(catalog);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

#[cfg(test)]
mod waiting_tests {
    use super::*;
    use varin_runtime::catalog::launches::LaunchSelection;
    use varin_runtime::composition::tools::{ToolDeclaration, ToolDirectory};
    use varin_runtime::supervisor::{RunStart, RunSupervisor};
    use varin_runtime::{RunState, SubmitInput};
    struct Ask;
    impl ModelProvider for Ask {
        fn serialize(&self, v: &RequestView) -> Result<Value, ExecutionError> {
            Ok(serde_json::to_value(v).unwrap())
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            _: &CancellationToken,
            e: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            e(ProviderEvent::Usage {
                receipt: UsageReceipt {
                    measurement: UsageMeasurement::Actual,
                    output_tokens: Some(2),
                    ..Default::default()
                },
            })
            .unwrap();
            e(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: "ask".into(),
                    content: Content::ToolCall {
                        call: ToolCall {
                            call_id: "ask".into(),
                            name: varin_runtime::catalog::questions::QUESTION_TOOL.into(),
                            schema_version: "1".into(),
                            arguments: json!({"question":"Which original option?"}),
                        },
                    },
                    opaque: None,
                },
            })
            .unwrap();
            Ok(FinishReason::ToolCalls)
        }
    }
    struct CompleteAfterAcceptance {
        inner: Arc<dyn ToolExecutor>,
        catalog: Arc<Mutex<Catalog>>,
    }
    impl ToolExecutor for CompleteAfterAcceptance {
        fn plan(
            &self,
            c: &ToolCall,
            f: &FrozenToolContext,
            t: &CancellationToken,
        ) -> Result<ToolPreparation, ExecutionError> {
            self.inner.plan(c, f, t)
        }
        fn prepare(
            &self,
            c: &ToolCall,
            f: &FrozenToolContext,
            t: &CancellationToken,
        ) -> Result<ToolContract, ExecutionError> {
            self.inner.prepare(c, f, t)
        }
        fn authorize(
            &self,
            c: &ToolExecutionContext,
            a: &ToolCall,
            b: &ToolContract,
            t: &CancellationToken,
        ) -> Result<(), ExecutionError> {
            self.inner.authorize(c, a, b, t)
        }
        fn execute(
            &self,
            c: &ToolExecutionContext,
            a: &ToolCall,
            b: &ToolContract,
            t: &CancellationToken,
        ) -> ToolCompletion {
            let receipt = self.inner.execute(c, a, b, t);
            assert!(matches!(receipt, ToolCompletion::JobAccepted { .. }));
            self.catalog
                .lock()
                .unwrap()
                .control_goal(
                    "goal",
                    1,
                    &GoalScope {
                        thread_id: "thread".into(),
                        branch_id: "branch".into(),
                    },
                    GoalControlAction::Complete,
                )
                .unwrap();
            receipt
        }
    }
    #[test]
    fn goal_completion_keeps_an_accepted_question_answerable_before_closing_run() {
        let root =
            std::env::temp_dir().join(format!("varin-goal-question-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let binding:RequestBinding=serde_json::from_value(json!({"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"fixture","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":[schema(),crate::questions::schema()],"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":"branch","ancestor_id":null,"leaf_id":null}})).unwrap();
        let launch = LaunchSelection::from_binding(
            &binding,
            crate::questions::default_policy_identity(),
            None,
        );
        let prepared = db
            .prepare_submission(
                SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("original task"),
                    configuration: json!({}),
                },
                None,
                None,
            )
            .unwrap()
            .load(Some(launch), false)
            .unwrap();
        let receipt = db.admit_submission(prepared).unwrap();
        let p = db
            .prepare_goal_start(
                "goal",
                &receipt.run_id,
                GoalScope {
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                },
                "Explicit objective".into(),
                None,
            )
            .unwrap()
            .load()
            .unwrap();
        db.admit_goal_mutation(p).unwrap();
        let supervisor = RunSupervisor::new(db);
        let catalog = supervisor.catalog();
        let question = crate::questions::declaration(catalog.clone());
        let questions = ToolDeclaration::new(
            question.schema,
            Arc::new(CompleteAfterAcceptance {
                inner: question.implementation,
                catalog: catalog.clone(),
            }),
        );
        let start = crate::questions::configure(
            RunStart {
                context_preparation: Arc::new(NoopContextPreparation),
                binding,
                policy_state: Value::Null,
                provider: Arc::new(Ask),
                tools: Arc::new(
                    ToolDirectory::assemble(vec![questions, declaration(catalog.clone())]).unwrap(),
                ),
                policy: Arc::new(DefaultAgentPolicy),
                progress: ProgressSink::default(),
            },
            catalog.clone(),
        );
        let report = supervisor
            .start(&receipt.run_id, start.clone())
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
        let wait = report.waiting_on.unwrap();
        let operation = wait.strip_prefix("question:").unwrap();
        supervisor.quiesce_question(operation).unwrap();
        let prepared = {
            catalog
                .lock()
                .unwrap()
                .prepare_question_answer(operation, Some("the real user answer".into()))
                .unwrap()
        }
        .load()
        .unwrap();
        catalog
            .lock()
            .unwrap()
            .admit_question_answer(prepared)
            .unwrap();
        let report = supervisor
            .start(&receipt.run_id, start)
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
        let db = catalog.lock().unwrap();
        let goal = db.capture_goal("goal").unwrap().load().unwrap();
        assert_eq!(goal.state, GoalState::Complete);
        assert_eq!(goal.usage.actual.inferences, 1);
        assert_eq!(
            db.operation(operation).unwrap().phase,
            varin_runtime::OperationPhase::Terminal
        );
        assert!(db
            .events_after(0, 1000)
            .unwrap()
            .iter()
            .any(|e| e.kind == "question.answered"));
        drop(db);
        drop(catalog);
        drop(supervisor);
        std::fs::remove_dir_all(root).unwrap();
    }
}
