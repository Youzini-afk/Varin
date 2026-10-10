//! Independent counterexamples for durable child admission. Host/source authority is covered by
//! the loopback suite; these tests use real Catalog transactions and committed tool origins.
#[path = "input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::catalog::collaboration::{
    ChildSourcePin, DispatchInput, DISPATCH_TOOL, WAIT_TOOL,
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
        description: String::new(),
        output_schema: None,
        metadata: None,
        name: "file_read".into(),
        version: "1".into(),
        schema: json!({"type":"object"}),
    }
}
#[allow(dead_code)]
impl Fixture {
    pub(crate) fn new() -> Self {
        Self::new_with_schemas(
            7,
            read_schema(),
            ToolSchema {
                description: String::new(),
                output_schema: None,
                metadata: None,
                name: DISPATCH_TOOL.into(),
                version: "1".into(),
                schema: json!({"type":"object"}),
            },
        )
    }
    pub(crate) fn new_with_schemas(revision: i64, read: ToolSchema, dispatch: ToolSchema) -> Self {
        Self::new_parent(revision, read, dispatch, false, false, false)
    }
    pub(crate) fn new_extended_parent_with_schemas(read: ToolSchema, dispatch: ToolSchema) -> Self {
        Self::new_parent(0, read, dispatch, false, false, true)
    }
    pub(crate) fn new_policy_parent_with_schemas(
        revision: i64,
        read: ToolSchema,
        dispatch: ToolSchema,
    ) -> Self {
        Self::new_parent(revision, read, dispatch, true, false, false)
    }
    pub(crate) fn new_policy() -> Self {
        let mut fixture = Self::new_parent(
            7,
            read_schema(),
            ToolSchema {
                description: String::new(),
                output_schema: None,
                metadata: None,
                name: DISPATCH_TOOL.into(),
                version: "1".into(),
                schema: json!({"type":"object"}),
            },
            true,
            false,
            false,
        );
        fixture.context = fixture.admit_policy_call(ToolCall {
            call_id: "dispatch-call".into(),
            name: DISPATCH_TOOL.into(),
            schema_version: "1".into(),
            arguments: serde_json::to_value(&fixture.input).unwrap(),
        });
        fixture
    }
    pub(crate) fn new_isolated() -> Self {
        Self::new_parent(7, read_schema(), ToolSchema {
            description:String::new(), output_schema:None, metadata:None,
            name:DISPATCH_TOOL.into(), version:"1".into(), schema:json!({"type":"object"}),
        }, false, true, false)
    }
    pub(crate) fn new_parent_extension() -> Self {
        Self::new_parent(7, read_schema(), ToolSchema {
            description:String::new(), output_schema:None, metadata:None,
            name:DISPATCH_TOOL.into(), version:"1".into(), schema:json!({"type":"object"}),
        }, false, false, true)
    }
    fn new_parent(revision: i64, read: ToolSchema, dispatch: ToolSchema, policy: bool, isolated: bool, parent_extension: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "varin-child-catalog-review-{}",
            uuid::Uuid::new_v4()
        ));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread:parent", "branch:parent").unwrap();
        let input = DispatchInput {
            task: "Read the fixed file and report".into(),
            preset: None,
            work_mode: Some(if isolated { varin_runtime::catalog::dispatch::ChildWorkMode::IsolatedWrite } else { varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly }),
            tools: Some(if isolated { vec!["file_read".into(), "file_write".into(), "file_edit".into()] } else { vec!["file_read".into()] }),
        };
        let source: SourceSelection = serde_json::from_value(json!({"mode":"fixed_branch","live_root":null,
            "workspace_id":"workspace-A","execution_workspace_id":"workspace-A","branch_id":"fixed-parent","revision":revision})).unwrap();
        let mut launch: LaunchSelection = serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"frozen-connection",
            "provider_family":"openai-responses","model":"fixture-model","configuration_generation":2,"tool_schema_generation":1,
            "tools":[read.clone(),dispatch,{"name":WAIT_TOOL,"version":"1","description":"Wait for fixture operation","output_schema":null,"metadata":null,"schema":{"type":"object"}}],"policy":{"name":"fixture","version":"1"},"source":source,
            "credential_scope":{"reference":"credential-ref","authority":"credential-owner","account":"account-A","generation":3}})).unwrap();
        if parent_extension {
            let extension:varin_runtime::catalog::launches::ExtensionToolBinding=serde_json::from_value(json!({"providerKey":"example:host:helper@1","extensionId":"example","extensionVersion":"1.0.0","serviceId":"helper","serviceVersion":1,
                "artifactIntegrity":"sha256-original","declarationHash":"declaration","configurationIdentity":null,
                "tool":{"name":"helper","version":"declaration","description":"Parent extension","schema":{"type":"object"},"output_schema":null,"metadata":{"service_id":"helper","service_version":1,"completion":"result","operation":"read"}}})).unwrap();
            launch.tools.push(extension.tool.clone());launch.extension_bindings.push(extension);
        }
        let configuration = json!({"providerFamily":"openai-responses","endpoint":"http://127.0.0.1:1/model","allowAnonymous":false,"model":"fixture-model","configurationGeneration":2});
        let model = varin_runtime::catalog::dispatch::ChildModelBinding { configuration: serde_json::from_value(configuration.clone()).unwrap(), credential_scope: launch.credential_scope.clone() };
        launch.connection_identity = model.connection_identity().unwrap();
        launch.child_dispatch = Some(varin_runtime::catalog::dispatch::ChildDispatchCatalog { identity: "fixture-catalog".into(), normal_unavailable: None, presets: Vec::new() });
        let dispatch_version = launch.tools.iter().find(|tool| tool.name == DISPATCH_TOOL).unwrap().version.clone();
        let receipt = db.submit_with_launch(&SubmitInput { key: "parent-input".into(), thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(), expected_head: None, input: json!("Delegate a read"),
            configuration }, Some(launch.clone())).unwrap();
        let prepared = db.prepare_child_dispatch_binding(&receipt.run_id, model, launch.tools.clone()).unwrap().load().unwrap();
        let dispatch_context = db.bind_child_dispatch(&receipt.run_id, prepared).unwrap();
        if policy {
            let boundary = db.policy_boundary(&receipt.run_id, db.epoch()).unwrap();
            let origin = ToolOrigin::PolicyAction {
                action_id: format!("{}:policy:{}", receipt.run_id, boundary.id),
                node_id: "dispatch-call".into(),
            };
            let context = ToolExecutionContext {
                operation_id: origin.operation_id("dispatch-call"),
                origin,
                run_id: receipt.run_id,
            };
            let pin = ChildSourcePin {
                pin_id: "retained-pin".into(),
                root: "fixed-root".into(),
                source,
            };
            let mut child_launch = launch;
            child_launch.tools = vec![read];
            child_launch.extension_bindings.clear(); child_launch.mcp_binding = None; child_launch.policy_models.clear();
            if isolated { for name in ["file_write", "file_edit"] { child_launch.tools.push(ToolSchema { name: name.into(), version: "1".into(), description: String::new(), schema: json!({"type":"object"}), output_schema: None, metadata: None }); } }
            child_launch.policy = PolicyIdentity {
                name: "default".into(),
                version: "1".into(),
            };
            return Self {
                root,
                db,
                context,
                input,
                pin,
                launch: child_launch,
            };
        }
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
                    child_dispatch: dispatch_context.clone(),
                    goal: None, resource_activations: Vec::new(),
                    resource_checkpoint_id: None,
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
            schema_version: dispatch_version.clone(),
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
        db.commit_execution(&run, epoch, &{
            let tool = AdmittedTool {
                call,
                contract: ToolContract {
                    name: DISPATCH_TOOL.into(),
                    schema_version: dispatch_version.clone(),
                    read_only: true,
                    completion: CompletionKind::Job,
                    lifetime: Lifetime::Thread,
                    resources: vec![],
                },
            };
            ExecutionRecord::ToolAdmitted {
                context: {
                    let request_id: String = "parent-request".into();
                    let call_id: String = tool.call.call_id.clone();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&run).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
                tool,
            }
        })
        .unwrap();
        db.commit_execution(
            &run,
            epoch,
            &ExecutionRecord::ToolDispatched {
                executor_owner: varin_runtime::ExecutorOwner::Kernel,
                context: {
                    let request_id: String = "parent-request".into();
                    let call_id: String = "dispatch-call".into();
                    varin_runtime::execution::ToolExecutionContext {
                        run_id: (&run).to_string(),
                        operation_id: format!("{request_id}:tool:{call_id}"),
                        origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                    }
                },
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
            child_launch.extension_bindings.clear(); child_launch.mcp_binding = None; child_launch.policy_models.clear();
            if isolated { for name in ["file_write", "file_edit"] { child_launch.tools.push(ToolSchema { name: name.into(), version: "1".into(), description: String::new(), schema: json!({"type":"object"}), output_schema: None, metadata: None }); } }
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
        let tools = self
            .db
            .launch_intent(&self.context.run_id)
            .unwrap()
            .unwrap()
            .selection
            .tools;
        let snapshot = RequestSnapshot {
            view: RequestView {
                request_id: request_id.clone(),
                run_id: self.context.run_id.clone(),
                origin: RequestOrigin::Conversation {
                    step: 2,
                    history_range: range.clone(),
                },
                binding: RequestBinding {
                    child_dispatch: self.db.launch_metadata(&self.context.run_id).unwrap().unwrap().dispatch_context_ref,
                    goal: None, resource_activations: Vec::new(),
                    resource_checkpoint_id: None,
                    connection_identity: self.launch.connection_identity.clone(),
                    provider_family: self.launch.provider_family.clone(),
                    model: self.launch.model.clone(),
                    credential_ref: Some("credential-ref".into()),
                    configuration_generation: 2,
                    tool_schema_generation: 1,
                    tools,
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
            .commit_execution(&self.context.run_id, epoch, &{
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
                        let request_id: String = request_id.clone();
                        let call_id: String = tool.call.call_id.clone();
                        varin_runtime::execution::ToolExecutionContext {
                            run_id: (&self.context.run_id).to_string(),
                            operation_id: format!("{request_id}:tool:{call_id}"),
                            origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                        }
                    },
                    tool,
                }
            })
            .unwrap();
        self.db
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::ToolDispatched {
                    executor_owner: varin_runtime::ExecutorOwner::Kernel,
                    context: {
                        let request_id: String = request_id.clone();
                        let call_id: String = call_id.clone();
                        varin_runtime::execution::ToolExecutionContext {
                            run_id: (&self.context.run_id).to_string(),
                            operation_id: format!("{request_id}:tool:{call_id}"),
                            origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                        }
                    },
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
        let prepared = self
            .db
            .prepare_child_wait_registration(&context, &self.context.operation_id)
            .unwrap()
            .load()
            .unwrap();
        let wait = self.db.register_child_wait(prepared).unwrap();
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
            .commit_execution(&self.context.run_id, epoch, &{
                let result = result.clone();
                ExecutionRecord::ToolSettled {
                    executor_stopped: false,
                    context: {
                        let request_id: String = result.request_id.clone();
                        let call_id: String = result.call_id.clone();
                        varin_runtime::execution::ToolExecutionContext {
                            run_id: (&self.context.run_id).to_string(),
                            operation_id: format!("{request_id}:tool:{call_id}"),
                            origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                        }
                    },
                    completion: result.completion,
                }
            })
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
    pub(crate) fn admit_policy_call(&mut self, call: ToolCall) -> ToolExecutionContext {
        let run_id = self.context.run_id.clone();
        let epoch = self.db.epoch();
        self.db
            .commit_execution(
                &run_id,
                epoch,
                &ExecutionRecord::StateChanged {
                    state: RunState::Runnable,
                    waiting_on: None,
                },
            )
            .unwrap();
        let launch = self.db.launch_intent(&run_id).unwrap().unwrap().selection;
        let boundary = self.db.policy_boundary(&run_id, epoch).unwrap();
        let action_id = format!("{run_id}:policy:{}", boundary.id);
        let origin = ToolOrigin::PolicyAction {
            action_id: action_id.clone(),
            node_id: call.call_id.clone(),
        };
        let context = ToolExecutionContext {
            operation_id: origin.operation_id(&call.call_id),
            origin: origin.clone(),
            run_id: run_id.clone(),
        };
        let intent = PolicyGraphIntent::PolicyToolGraphV1 {
            action_id,
            boundary,
            identity: launch.policy,
            state: json!({"stage": 1}),
            nodes: vec![PolicyAdmittedNode {
                context: FrozenToolContext {
                    child_dispatch: self.db.launch_metadata(&run_id).unwrap().unwrap().dispatch_context_ref,
                    resource_activations: Vec::new(),
                    resource_checkpoint_id: None,
                    run_id: run_id.clone(),
                    origin,
                    tool_schema_generation: launch.tool_schema_generation,
                    tools: std::sync::Arc::new(launch.tools),
                    source: launch.source,
                },
                node: PolicyToolNode {
                    id: call.call_id.clone(),
                    depends_on: vec![],
                    call: call.clone(),
                },
            }],
        };
        self.db.admit_policy_graph(&run_id, epoch, &intent).unwrap();
        self.db
            .commit_execution(
                &run_id,
                epoch,
                &ExecutionRecord::ToolAdmitted {
                    context: context.clone(),
                    tool: AdmittedTool {
                        contract: ToolContract {
                            name: call.name.clone(),
                            schema_version: call.schema_version.clone(),
                            read_only: true,
                            completion: CompletionKind::Job,
                            lifetime: Lifetime::Thread,
                            resources: vec![],
                        },
                        call,
                    },
                },
            )
            .unwrap();
        self.db
            .commit_execution(
                &run_id,
                epoch,
                &ExecutionRecord::ToolDispatched {
                    executor_owner: varin_runtime::ExecutorOwner::Kernel,
                    context: context.clone(),
                },
            )
            .unwrap();
        context
    }
    pub(crate) fn settle_policy_call(&mut self, context: &ToolExecutionContext, phase: &str) {
        let ToolOrigin::PolicyAction { action_id, node_id } = &context.origin else {
            panic!("policy call required")
        };
        let completion = ToolCompletion::JobAccepted {
            operation_id: context.operation_id.clone(),
            phase: phase.into(),
            effect: Effect::None,
            lifetime: Lifetime::Thread,
        };
        self.db
            .commit_execution(
                &context.run_id,
                self.db.epoch(),
                &ExecutionRecord::ToolSettled {
                    executor_stopped: false,
                    context: context.clone(),
                    completion: completion.clone(),
                },
            )
            .unwrap();
        self.db
            .settle_policy_node(
                &context.run_id,
                self.db.epoch(),
                action_id,
                node_id,
                &completion,
            )
            .unwrap();
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
            .commit_execution(&self.context.run_id, self.db.epoch(), &{
                let result = result.clone();
                ExecutionRecord::ToolSettled {
                    executor_stopped: false,
                    context: {
                        let request_id: String = result.request_id.clone();
                        let call_id: String = result.call_id.clone();
                        varin_runtime::execution::ToolExecutionContext {
                            run_id: (&self.context.run_id).to_string(),
                            operation_id: format!("{request_id}:tool:{call_id}"),
                            origin: varin_runtime::execution::ToolOrigin::ModelStep { request_id },
                        }
                    },
                    completion: result.completion,
                }
            })
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
