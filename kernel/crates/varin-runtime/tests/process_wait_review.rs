//! Independent Catalog counterexamples. These exercise real committed model origins and reopen;
//! guardian, Storage grant authorization and Host continuation require the native integration lane.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use varin_runtime::catalog::launches::LaunchSelection;
use varin_runtime::catalog::process_wait::WAIT_TOOL;
use varin_runtime::execution::*;
use varin_runtime::*;
const PROCESS: &str = "spawn-request:tool:process";

struct Fixture {
    root: std::path::PathBuf,
    db: Catalog,
    run: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "varin-process-wait-review-{}",
            uuid::Uuid::new_v4()
        ));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let launch: LaunchSelection = serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture",
            "provider_family":"fixture","model":"model","configuration_generation":1,"tool_schema_generation":1,
            "tools":[{"name":WAIT_TOOL,"version":"1","description":"Wait for fixture operation","output_schema":null,"metadata":null,"schema":{"type":"object"}},
                {"name":"process_spawn","version":"1","description":"Original native process","output_schema":null,"metadata":null,"schema":{"type":"object"}}],"policy":{"name":"fixture","version":"1"},"source":null})).unwrap();
        let receipt = db
            .submit_with_launch(
                &SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("Observe process"),
                    configuration: json!({}),
                },
                Some(launch),
            )
            .unwrap();
        let mut f = Self {
            root,
            db,
            run: receipt.run_id,
        };
        f.state(RunState::Runnable, None);
        f.spawn();
        f
    }
    fn spawn(&mut self) {
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: self.db.head("branch").unwrap(),
        };
        let binding: RequestBinding = serde_json::from_value(json!({"child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
            "connection_identity":"fixture","provider_family":"fixture","model":"model","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,
            "tools":self.db.launch_intent(&self.run).unwrap().unwrap().selection.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
        let call = ToolCall {
            call_id: "process".into(),
            name: "process_spawn".into(),
            schema_version: "1".into(),
            arguments: json!({}),
        };
        self.record(ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: "spawn-request".into(),
                    run_id: self.run.clone(),
                    origin: RequestOrigin::Conversation {
                        step: 0,
                        history_range: range,
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({}),
            },
        });
        self.record(ExecutionRecord::ModelDispatched {
            request_id: "spawn-request".into(),
        });
        self.record(ExecutionRecord::ModelFinished {
            request_id: "spawn-request".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "spawn".into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        });
        let context = ToolExecutionContext {
            run_id: self.run.clone(),
            operation_id: PROCESS.into(),
            origin: ToolOrigin::ModelStep {
                request_id: "spawn-request".into(),
            },
        };
        self.record(ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call,
                contract: ToolContract {
                    name: "process_spawn".into(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: CompletionKind::Job,
                    lifetime: Lifetime::Thread,
                    resources: vec![],
                },
            },
        });
        self.record(ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: ExecutorOwner::Kernel,
        });
        let completion = ToolCompletion::JobAccepted {
            operation_id: PROCESS.into(),
            phase: "running".into(),
            effect: Effect::Dispatched,
            lifetime: Lifetime::Thread,
        };
        self.record(ExecutionRecord::ToolSettled {
            context,
            completion: completion.clone(),
            executor_stopped: false,
        });
        self.record(ExecutionRecord::ToolBatchCommitted {
            request_id: "spawn-request".into(),
            results: vec![ToolResult {
                request_id: "spawn-request".into(),
                call_id: "process".into(),
                completion,
            }],
        });
    }
    fn record(&mut self, r: ExecutionRecord) {
        self.db
            .commit_execution(&self.run, self.db.epoch(), &r)
            .unwrap();
    }
    fn state(&mut self, state: RunState, waiting_on: Option<String>) {
        self.record(ExecutionRecord::StateChanged { state, waiting_on });
    }
    fn wait(&mut self, suffix: &str) -> Wait {
        let request = format!("request-{suffix}");
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: self.db.head("branch").unwrap(),
        };
        let binding = RequestBinding {
            child_dispatch: None,
            goal: None,
            resource_activations: Vec::new(),
            resource_checkpoint_id: None,
            connection_identity: "fixture".into(),
            provider_family: "fixture".into(),
            model: "model".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: self
                .db
                .launch_intent(&self.run)
                .unwrap()
                .unwrap()
                .selection
                .tools,
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: range.clone(),
        };
        self.record(ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: request.clone(),
                    run_id: self.run.clone(),
                    origin: RequestOrigin::Conversation {
                        step: 1,
                        history_range: range,
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({}),
            },
        });
        self.record(ExecutionRecord::ModelDispatched {
            request_id: request.clone(),
        });
        let call = ToolCall {
            call_id: "wait".into(),
            name: WAIT_TOOL.into(),
            schema_version: "1".into(),
            arguments: json!({"processId":PROCESS}),
        };
        self.record(ExecutionRecord::ModelFinished {
            request_id: request.clone(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: format!("item-{suffix}"),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        });
        self.record({
            let tool = AdmittedTool {
                call,
                contract: ToolContract {
                    name: WAIT_TOOL.into(),
                    schema_version: "1".into(),
                    read_only: true,
                    completion: CompletionKind::Job,
                    lifetime: Lifetime::Thread,
                    resources: vec![],
                },
            };
            ExecutionRecord::ToolAdmitted {
                context: {
                    let request_id: String = request.clone();
                    let call_id: String = tool.call.call_id.clone();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&self.run).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
                tool,
            }
        });
        self.record(ExecutionRecord::ToolDispatched {
            executor_owner: varin_runtime::ExecutorOwner::Kernel,
            context: {
                let request_id: String = request.clone();
                let call_id: String = "wait".into();
                varin_runtime::execution::ToolExecutionContext {
                    run_id: (&self.run).to_string(),
                    operation_id: format!("{request_id}:tool:{call_id}"),
                    origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                }
            },
        });
        let context = ToolExecutionContext {
            run_id: self.run.clone(),
            operation_id: format!("{request}:tool:wait"),
            origin: ToolOrigin::ModelStep {
                request_id: request.clone(),
            },
        };
        let wait = self.db.wait_for_process(&context, PROCESS).unwrap();
        let result = ToolResult {
            request_id: request.clone(),
            call_id: "wait".into(),
            completion: ToolCompletion::JobAccepted {
                operation_id: context.operation_id,
                phase: "awaiting_process".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
            },
        };
        self.record({
            let result = result.clone();
            ExecutionRecord::ToolSettled {
                executor_stopped: false,
                context: {
                    let request_id: String = result.request_id.clone();
                    let call_id: String = result.call_id.clone();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&self.run).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
                completion: result.completion,
            }
        });
        self.record(ExecutionRecord::ToolBatchCommitted {
            request_id: request,
            results: vec![result],
        });
        self.state(RunState::Waiting, Some(wait.id.clone()));
        wait
    }
    fn terminal(&mut self) {
        self.db.record_external_receipt_with_stop(PROCESS,ExternalReceipt{executor:"process_spawn".into(),identity:PROCESS.into(),
            epoch:"process-epoch".into(),outcome:Outcome::Succeeded,effect:Effect::Confirmed,
            result:json!({"processId":PROCESS,"kernelEpoch":"process-epoch","treeConfirmed":true,"exitCode":0,"signal":null,"outputAvailable":true})},true).unwrap();
    }
    fn reopen(self) -> Self {
        let Self { root, db, run } = self;
        drop(db);
        let db = Catalog::open(&root).unwrap();
        Self { root, db, run }
    }
    fn cleanup(self) {
        let Self { root, db, .. } = self;
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    fn facts(&self) -> Vec<Value> {
        self.db
            .history("branch")
            .unwrap()
            .into_iter()
            .filter(|h| h.source == HistorySource::Environment)
            .map(|h| h.content)
            .collect()
    }
}

#[test]
fn reopen_live_process_does_not_treat_recovery_indeterminate_as_a_terminal_fact() {
    let mut f = Fixture::new();
    let wait = f.wait("live");
    let mut f = f.reopen();
    let pending = f.db.operation(PROCESS).unwrap();
    assert_eq!(pending.outcome, Some(Outcome::Indeterminate));
    assert!(pending.external_receipt.is_none());
    assert!(f
        .db
        .deliver_process_waits()
        .expect("live guardian has no terminal event yet; observation must remain parked")
        .is_empty());
    assert_eq!(f.db.run(&f.run).unwrap().waiting_on, Some(wait.id));
    assert!(f.facts().is_empty());
    f.terminal();
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(f.facts().len(), 1);
    f.cleanup();
}

#[test]
fn early_terminal_and_delivered_before_host_launch_reopen_keep_one_fact() {
    let mut f = Fixture::new();
    f.terminal();
    f.wait("early");
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    let facts = f.facts();
    assert_eq!(facts.len(), 1);
    let mut f = f.reopen();
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(
        f.facts(),
        facts,
        "rediscovery of unlaunched continuation cannot duplicate history"
    );
    f.cleanup();
}

#[test]
fn cancel_observation_leaves_external_operation_running() {
    let mut f = Fixture::new();
    let wait = f.wait("cancel");
    let process = f.db.operation(PROCESS).unwrap();
    f.db.cancel_process_wait(wait.id.strip_prefix("process-wait:").unwrap())
        .unwrap();
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(
        f.db.operation(PROCESS).unwrap(),
        process,
        "observation cancellation cannot cancel or settle process owner"
    );
    f.terminal();
    f.db.deliver_process_waits().unwrap();
    assert_eq!(
        f.facts().len(),
        1,
        "cancelled observer receives no late process-result message"
    );
    f.cleanup();
}

#[test]
fn durable_observer_cancel_intent_survives_crash_before_wait_flag_write() {
    let mut f = Fixture::new();
    let wait = f.wait("cancel-crash");
    // This is exactly the durable boundary between request_cancel_operation and cancel_wait.
    let observer = wait.id.strip_prefix("process-wait:").unwrap();
    f.db.request_cancel_operation(observer).unwrap();
    let mut f = f.reopen();
    assert_eq!(
        f.db.deliver_process_waits().unwrap(),
        vec![f.run.clone()],
        "recovery must close the cancelled observation without waiting for the live process"
    );
    assert_eq!(
        f.db.operation(observer).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    assert!(!f.db.operation(PROCESS).unwrap().cancel_requested);
    f.cleanup();
}

#[test]
fn duplicate_terminal_and_second_observation_do_not_duplicate_visible_fact() {
    let mut f = Fixture::new();
    f.terminal();
    f.wait("first");
    f.db.deliver_process_waits().unwrap();
    let facts = f.facts();
    assert_eq!(facts.len(), 1);
    f.terminal();
    f.wait("second");
    f.db.deliver_process_waits().unwrap();
    assert_eq!(
        f.facts(),
        facts,
        "another wait can settle from the existing ancestor fact"
    );
    f.cleanup();
}

#[test]
fn cancelled_run_never_resumes_from_late_process_terminal() {
    let mut f = Fixture::new();
    let wait = f.wait("run-cancel");
    f.state(RunState::Cancelled, None);
    f.terminal();
    assert!(f.db.deliver_process_waits().unwrap().is_empty());
    assert_eq!(f.db.run(&f.run).unwrap().state, RunState::Cancelled);
    assert_eq!(
        f.db.operation(wait.id.strip_prefix("process-wait:").unwrap())
            .unwrap()
            .outcome,
        Some(Outcome::Cancelled)
    );
    assert_eq!(
        f.db.operation(PROCESS).unwrap().outcome,
        Some(Outcome::Succeeded)
    );
    assert!(f.facts().is_empty());
    f.cleanup();
}

#[test]
fn process_terminal_fact_preserves_the_guardians_string_signal() {
    let mut f = Fixture::new();
    f.wait("signal");
    f.db.record_external_receipt_with_stop(PROCESS,ExternalReceipt{executor:"process_spawn".into(),identity:PROCESS.into(),
        epoch:"process-epoch".into(),outcome:Outcome::Failed,effect:Effect::Confirmed,
        result:json!({"processId":PROCESS,"kernelEpoch":"process-epoch","treeConfirmed":true,"exitCode":null,"signal":"Killed"})},true).unwrap();
    f.db.deliver_process_waits().unwrap();
    let facts = f.facts();
    assert_eq!(facts.len(), 1);
    let text = facts[0]["content"]["text"].as_str().unwrap();
    let fact: Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
    assert_eq!(fact["signal"], "Killed");
    assert_eq!(fact["outcome"], "failed");
    assert!(fact["exitCode"].is_null());
    f.cleanup();
}

#[test]
fn prepared_process_result_cannot_undo_observer_cancel_and_cancel_needs_no_result_body() {
    let mut f = Fixture::new();
    f.terminal();
    let wait = f.wait("result-cancel-race");
    let prepared =
        f.db.capture_process_waits()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    let observer = wait.id.strip_prefix("process-wait:").unwrap();
    f.db.cancel_process_wait(observer).unwrap();
    assert!(
        !f.db.admit_process_wait(prepared).unwrap(),
        "a stale process result cannot revive the cancelled observation"
    );
    assert!(f.facts().is_empty());
    let process = f.db.operation(PROCESS).unwrap();
    let reference = &process.external_receipt.as_ref().unwrap().result_ref;
    let path = varin_runtime::content::object_path(
        &f.root.join("content"),
        reference["content_object"].as_str().unwrap(),
    )
    .unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(
        f.db.operation(observer).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    assert_eq!(f.db.operation(PROCESS).unwrap(), process);
    assert_eq!(f.facts().len(), 1);
    f.cleanup();
}

impl Fixture {
    fn policy_observation(&mut self, node: &str) -> (Wait, ToolExecutionContext, ToolCompletion) {
        let epoch = self.db.epoch();
        let boundary = self.db.policy_boundary(&self.run, epoch).unwrap();
        let action_id = format!("{}:policy:{}", self.run, boundary.id);
        let origin = ToolOrigin::PolicyAction {
            action_id: action_id.clone(),
            node_id: node.into(),
        };
        let call = ToolCall {
            call_id: node.into(),
            name: WAIT_TOOL.into(),
            schema_version: "1".into(),
            arguments: json!({"processId":PROCESS}),
        };
        let launch = self.db.launch_intent(&self.run).unwrap().unwrap().selection;
        let context = FrozenToolContext {
            child_dispatch: None,
            resource_activations: vec![],
            resource_checkpoint_id: boundary.resource_checkpoint_id.clone(),
            run_id: self.run.clone(),
            origin: origin.clone(),
            tool_schema_generation: launch.tool_schema_generation,
            tools: std::sync::Arc::new(launch.tools),
            source: None,
        };
        self.db
            .admit_policy_graph(
                &self.run,
                epoch,
                &PolicyGraphIntent::PolicyToolGraphV1 {
                    action_id,
                    boundary,
                    identity: launch.policy,
                    state: json!({"stage":1}),
                    nodes: vec![PolicyAdmittedNode {
                        node: PolicyToolNode {
                            id: node.into(),
                            depends_on: vec![],
                            call: call.clone(),
                        },
                        context,
                    }],
                },
            )
            .unwrap();
        let context = ToolExecutionContext {
            run_id: self.run.clone(),
            operation_id: origin.operation_id(node),
            origin,
        };
        self.record(ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call,
                contract: ToolContract {
                    name: WAIT_TOOL.into(),
                    schema_version: "1".into(),
                    read_only: true,
                    completion: CompletionKind::Job,
                    lifetime: Lifetime::Thread,
                    resources: vec![],
                },
            },
        });
        self.record(ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: ExecutorOwner::Kernel,
        });
        let wait = self.db.wait_for_process(&context, PROCESS).unwrap();
        let completion = ToolCompletion::JobAccepted {
            operation_id: context.operation_id.clone(),
            phase: "awaiting_process".into(),
            effect: Effect::None,
            lifetime: Lifetime::Thread,
        };
        (wait, context, completion)
    }
    fn consume_policy_observation(
        &mut self,
        context: &ToolExecutionContext,
        completion: ToolCompletion,
    ) -> PolicyNodeReceipt {
        self.record(ExecutionRecord::ToolSettled {
            context: context.clone(),
            completion: completion.clone(),
            executor_stopped: false,
        });
        let ToolOrigin::PolicyAction { action_id, node_id } = &context.origin else {
            panic!("policy origin")
        };
        self.db
            .settle_policy_node(&self.run, self.db.epoch(), action_id, node_id, &completion)
            .unwrap()
    }
}
#[test]
fn policy_process_fact_waits_for_original_graph_acceptance_consumption_after_reopen() {
    let mut f = Fixture::new();
    f.terminal();
    let (wait, context, completion) = f.policy_observation("observe");
    // Reproduce acceptance committed but not consumed, even if the Run's parked projection is visible.
    f.state(RunState::Waiting, Some(wait.id.clone()));
    assert!(f.db.deliver_process_waits().unwrap().is_empty());
    assert!(f.facts().is_empty());
    let mut f = f.reopen();
    assert!(f.db.deliver_process_waits().unwrap().is_empty());
    f.consume_policy_observation(&context, completion);
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(f.facts().len(), 1);
    assert!(matches!(
        f.db.operation(&context.operation_id)
            .unwrap()
            .call_completion,
        Some(varin_runtime::catalog::result_content::ToolCompletionMetadata::JobAccepted { .. })
    ));
    let duplicate = f.db.wait_for_process(&context, PROCESS).unwrap();
    assert_eq!(duplicate.id, wait.id);
    assert_eq!(
        f.db.operation(&context.operation_id).unwrap().phase,
        OperationPhase::Terminal
    );
    f.cleanup();
}
#[test]
fn policy_process_observer_cancel_before_park_is_delivered_without_stopping_process() {
    let mut f = Fixture::new();
    let (wait, context, completion) = f.policy_observation("observe-cancel");
    let process = f.db.operation(PROCESS).unwrap();
    f.db.cancel_process_wait(&context.operation_id).unwrap();
    let receipt = f.consume_policy_observation(&context, completion);
    f.record(ExecutionRecord::PolicyCheckpoint {
        identity: PolicyIdentity {
            name: "fixture".into(),
            version: "1".into(),
        },
        previous_state: json!({"stage":1}),
        state: json!({"stage":1}),
        action: PolicyAction::Wait {
            wait_id: wait.id.clone(),
        },
        event: PolicyEvent::ToolGraphCompleted {
            action_id: match &context.origin {
                ToolOrigin::PolicyAction { action_id, .. } => action_id.clone(),
                _ => unreachable!(),
            },
            receipts: vec![receipt],
        },
    });
    f.state(RunState::Waiting, Some(wait.id));
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(f.db.operation(PROCESS).unwrap(), process);
    assert_eq!(
        f.db.operation(&context.operation_id).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    assert_eq!(f.facts().len(), 1);
    f.terminal();
    f.db.deliver_process_waits().unwrap();
    assert_eq!(f.facts().len(), 1);
    f.cleanup();
}
