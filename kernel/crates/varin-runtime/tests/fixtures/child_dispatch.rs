//! Independent counterexamples for durable child admission. Host/source authority is covered by
//! the loopback suite; these tests use real Catalog transactions and committed tool origins.
use serde_json::json;
use varin_runtime::catalog::collaboration::{
    ChildSourcePin, DISPATCH_TOOL, DispatchInput, WAIT_TOOL,
};
use varin_runtime::catalog::launches::{LaunchSelection, SourceSelection};
use varin_runtime::execution::*;
use varin_runtime::*;

pub(crate) struct Fixture {
    pub(crate) root: std::path::PathBuf,
    pub(crate) db: Catalog,
    pub(crate) context: ToolExecutionContext,
    pub(crate) input: DispatchInput,
    pub(crate) pin: ChildSourcePin,
    pub(crate) launch: LaunchSelection,
}
fn read_schema() -> ToolSchema {
    ToolSchema {
        name: "file_read".into(),
        version: "1".into(),
        schema: json!({"type":"object"}),
    }
}
impl Fixture {
    pub(crate) fn new() -> Self {
        Self::new_with_schemas(
            7,
            read_schema(),
            ToolSchema {
                name: DISPATCH_TOOL.into(),
                version: "1".into(),
                schema: json!({"type":"object"}),
            },
        )
    }
    pub(crate) fn new_with_schemas(revision: i64, read: ToolSchema, dispatch: ToolSchema) -> Self {
        let root = std::env::temp_dir().join(format!(
            "varin-child-catalog-review-{}",
            uuid::Uuid::new_v4()
        ));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread:parent", "branch:parent")
            .unwrap();
        let input = DispatchInput {
            task: "Read the fixed file and report".into(),
            model: "parent".into(),
            profile: "read_only".into(),
        };
        let source: SourceSelection = serde_json::from_value(json!({"mode":"fixed_branch","live_root":null,
            "workspace_id":"workspace-A","execution_workspace_id":"workspace-A","branch_id":"fixed-parent","revision":revision})).unwrap();
        let launch: LaunchSelection = serde_json::from_value(json!({"connection_identity":"frozen-connection",
            "provider_family":"fixture","model":"fixture-model","configuration_generation":2,"tool_schema_generation":1,
            "tools":[read.clone(),dispatch],"policy":{"name":"fixture","version":"1"},"source":source,
            "credential_scope":{"reference":"credential-ref","authority":"credential-owner","account":"account-A","generation":3}})).unwrap();
        let receipt = db.submit_with_launch(&SubmitInput { key: "parent-input".into(), thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(), expected_head: None, input: json!("Delegate a read"),
            configuration: json!({"providerFamily":"fixture","model":"fixture-model","configurationGeneration":2}) }, Some(launch.clone())).unwrap();
        let range = HistoryRange {
            branch_id: receipt.branch_id.clone(),
            ancestor_id: None,
            leaf_id: Some(receipt.input_id),
        };
        let snapshot = RequestSnapshot {
            view: RequestView {
                request_id: "parent-request".into(),
                run_id: receipt.run_id.clone(),
                origin: RequestOrigin::Conversation {
                    step: 1,
                    history_range: range.clone(),
                },
                binding: RequestBinding {
                    connection_identity: launch.connection_identity.clone(),
                    provider_family: launch.provider_family.clone(),
                    model: launch.model.clone(),
                    credential_ref: Some("credential-ref".into()),
                    configuration_generation: 2,
                    tool_schema_generation: 1,
                    tools: launch.tools.clone(),
                    instruction_sources: vec![],
                    memory_checkpoint: None,
                    attachment_refs: vec![],
                    environment_cursor: 0,
                    history_range: range,
                },
                history: vec![],
            },
            serialized: json!({}),
        };
        let epoch = db.epoch();
        let run = receipt.run_id.clone();
        db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        db.commit_execution(&run, epoch, &ExecutionRecord::RequestPrepared { snapshot })
            .unwrap();
        db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ModelDispatched {
                request_id: "parent-request".into(),
            },
        )
        .unwrap();
        let call = ToolCall {
            call_id: "dispatch-call".into(),
            name: DISPATCH_TOOL.into(),
            schema_version: "1".into(),
            arguments: serde_json::to_value(&input).unwrap(),
        };
        db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ModelFinished {
                request_id: "parent-request".into(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: vec![ProviderItem {
                    id: "dispatch-item".into(),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                }],
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
        )
        .unwrap();
        db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ToolsAdmitted {
                request_id: "parent-request".into(),
                tools: vec![AdmittedTool {
                    call,
                    contract: ToolContract {
                        name: DISPATCH_TOOL.into(),
                        schema_version: "1".into(),
                        read_only: true,
                        completion: CompletionKind::Job,
                        lifetime: Lifetime::Thread,
                        resources: vec![],
                    },
                }],
            },
        )
        .unwrap();
        db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ToolDispatched {
                request_id: "parent-request".into(),
                call_id: "dispatch-call".into(),
            },
        )
        .unwrap();
        let context = ToolExecutionContext {
            run_id: run,
            origin: ToolOrigin::ModelStep {
                request_id: "parent-request".into(),
            },
            operation_id: "parent-request:tool:dispatch-call".into(),
        };
        let pin = ChildSourcePin {
            pin_id: "retained-pin".into(),
            root: "fixed-root".into(),
            source,
        };
        let mut child_launch = launch;
        child_launch.tools = vec![read];
        child_launch.policy = PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        };
        Self {
            root,
            db,
            context,
            input,
            pin,
            launch: child_launch,
        }
    }
    pub(crate) fn accept(&mut self) -> varin_runtime::catalog::collaboration::ChildTask {
        self.db
            .accept_child(
                &self.context,
                self.input.clone(),
                self.pin.clone(),
                self.launch.clone(),
            )
            .unwrap()
    }
    pub(crate) fn admit_wait(&mut self, suffix: &str) -> Wait {
        let request_id = format!("wait-request-{suffix}");
        let call_id = format!("wait-call-{suffix}");
        let epoch = self.db.epoch();
        let branch = self.db.run(&self.context.run_id).unwrap().branch_id;
        let range = HistoryRange {
            branch_id: branch.clone(),
            ancestor_id: None,
            leaf_id: self.db.head(&branch).unwrap(),
        };
        let schema = ToolSchema {
            name: WAIT_TOOL.into(),
            version: "1".into(),
            schema: json!({"type":"object"}),
        };
        let snapshot = RequestSnapshot {
            view: RequestView {
                request_id: request_id.clone(),
                run_id: self.context.run_id.clone(),
                origin: RequestOrigin::Conversation {
                    step: 2,
                    history_range: range.clone(),
                },
                binding: RequestBinding {
                    connection_identity: self.launch.connection_identity.clone(),
                    provider_family: self.launch.provider_family.clone(),
                    model: self.launch.model.clone(),
                    credential_ref: Some("credential-ref".into()),
                    configuration_generation: 2,
                    tool_schema_generation: 1,
                    tools: vec![schema],
                    instruction_sources: vec![],
                    memory_checkpoint: None,
                    attachment_refs: vec![],
                    environment_cursor: 0,
                    history_range: range,
                },
                history: vec![],
            },
            serialized: json!({}),
        };
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::RequestPrepared { snapshot },
            )
            .unwrap();
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::ModelDispatched {
                    request_id: request_id.clone(),
                },
            )
            .unwrap();
        let call = ToolCall {
            call_id: call_id.clone(),
            name: WAIT_TOOL.into(),
            schema_version: "1".into(),
            arguments: json!({"operationId": self.context.operation_id}),
        };
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::ModelFinished {
                    request_id: request_id.clone(),
                    outcome: ModelOutcome::Completed,
                    finish_reason: Some(FinishReason::ToolCalls),
                    items: vec![ProviderItem {
                        id: format!("wait-item-{suffix}"),
                        content: Content::ToolCall { call: call.clone() },
                        opaque: None,
                    }],
                    interrupted_deltas: vec![],
                    usage: UsageReceipt::default(),
                    failure: None,
                },
            )
            .unwrap();
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::ToolsAdmitted {
                    request_id: request_id.clone(),
                    tools: vec![AdmittedTool {
                        call,
                        contract: ToolContract {
                            name: WAIT_TOOL.into(),
                            schema_version: "1".into(),
                            read_only: true,
                            completion: CompletionKind::Job,
                            lifetime: Lifetime::Thread,
                            resources: vec![],
                        },
                    }],
                },
            )
            .unwrap();
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::ToolDispatched {
                    request_id: request_id.clone(),
                    call_id: call_id.clone(),
                },
            )
            .unwrap();
        let context = ToolExecutionContext {
            run_id: self.context.run_id.clone(),
            origin: ToolOrigin::ModelStep {
                request_id: request_id.clone(),
            },
            operation_id: format!("{request_id}:tool:{call_id}"),
        };
        let wait = self
            .db
            .wait_for_child(&context, &self.context.operation_id)
            .unwrap();
        let result = ToolResult {
            request_id: request_id.clone(),
            call_id,
            completion: ToolCompletion::JobAccepted {
                operation_id: context.operation_id,
                phase: "awaiting_child".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
            },
        };
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::ToolSettled {
                    result: result.clone(),
                },
            )
            .unwrap();
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::ToolBatchCommitted {
                    request_id,
                    results: vec![result],
                },
            )
            .unwrap();
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::StateChanged {
                    state: RunState::Waiting,
                    waiting_on: Some(wait.id.clone()),
                },
            )
            .unwrap();
        wait
    }
    pub(crate) fn settle_exchange(&mut self) {
        let result = ToolResult {
            request_id: "parent-request".into(),
            call_id: "dispatch-call".into(),
            completion: ToolCompletion::JobAccepted {
                operation_id: self.context.operation_id.clone(),
                phase: "preparing_child".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
            },
        };
        self.db
            .commit_execution(
                &self.context.run_id,
                self.db.epoch(),
                &ExecutionRecord::ToolSettled {
                    result: result.clone(),
                },
            )
            .unwrap();
        self.db
            .commit_execution(
                &self.context.run_id,
                self.db.epoch(),
                &ExecutionRecord::ToolBatchCommitted {
                    request_id: "parent-request".into(),
                    results: vec![result],
                },
            )
            .unwrap();
    }
}
