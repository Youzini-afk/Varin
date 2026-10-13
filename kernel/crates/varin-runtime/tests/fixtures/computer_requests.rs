//! Real ChildTask/source admission and ordinary selected tool origins; no physical desktop or IPC.
#[path = "child_dispatch.rs"]
mod child_dispatch;
#[path = "input_admission.rs"]
mod input_admission;
pub(crate) use child_dispatch::Fixture as ChildFixture;
use input_admission::InputAdmission;
#[path = "service_composition.rs"]
mod service_composition;
use serde_json::{json, Value};
use varin_runtime::{
    catalog::{computer_requests::*, launches::*},
    execution::*,
    *,
};
pub struct Fixture {
    pub base: ChildFixture,
    pub child_run: String,
    pub parent_run: String,
}
fn schema(name: &str, job: bool) -> ToolSchema {
    ToolSchema{requirements: None,name:name.into(),version:"computer-fixture-v1".into(),description:format!("Original {name}"),schema:json!({"type":"object"}),output_schema:None,metadata:Some(serde_json::from_value(json!({"completion":if job{"job"}else{"result"},"lifetime":if job{Some("thread")}else{None},"operation":if job{"read"}else{"effect"},"service_id":format!("varin.computer.{}",name.trim_start_matches("computer_")),"service_version":1})).unwrap())}
}
impl Fixture {
    pub fn new() -> Self {
        let computer = [
            ("computer_request", false),
            ("computer_wait", true),
            ("computer_grant", false),
            ("computer_deny", false),
        ]
        .into_iter()
        .map(|(name, job)| schema(name, job))
        .collect::<Vec<_>>();
        let read = ToolSchema {
            requirements: None,
            name: "file_read".into(),
            version: "1".into(),
            description: String::new(),
            schema: json!({"type":"object"}),
            output_schema: None,
            metadata: None,
        };
        let dispatch = ToolSchema {
            requirements: None,
            name: "dispatch".into(),
            ..read.clone()
        };
        let mut base = ChildFixture::new_parent_custom(
            7,
            read,
            dispatch,
            false,
            false,
            false,
            move |input, launch| {
                input.tools = Some(computer.iter().map(|t| t.name.clone()).collect());
                for tool in computer {
                    let binding:ExtensionToolBinding=serde_json::from_value(json!({"providerKey":format!("varin.builtin.computer:host:varin.computer.{}@1",tool.name.trim_start_matches("computer_")),"extensionId":"varin.builtin.computer","extensionVersion":"1.0.0","serviceId":format!("varin.computer.{}",tool.name.trim_start_matches("computer_")),"serviceVersion":1,"artifactIntegrity":"sha256-controlled-computer","composition":service_composition::graph("varin.builtin.computer","1.0.0","sha256-controlled-computer"),"declarationHash":tool.version,"configurationIdentity":"original-computer-desktop","tool":tool})).unwrap();
                    launch.tools.push(binding.tool.clone());
                    launch.extension_bindings.push(binding);
                }
            },
        );
        let selected = base
            .db
            .capture_child_dispatch_invocation(&base.context)
            .unwrap()
            .load()
            .unwrap();
        let resolved = selected.resolve(&base.input).unwrap();
        base.launch.tools = selected
            .frozen
            .allowed_delegation
            .iter()
            .filter(|t| resolved.profile.tools.contains(&t.name))
            .cloned()
            .collect();
        base.launch.extension_bindings = resolved.extension_bindings;
        let child = base.accept();
        base.settle_exchange();
        let mut source = child.source.pin().unwrap().source.clone();
        source.branch_id = Some(format!("child-source:{}", child.operation_id));
        source.revision = Some(0);
        let proposal = varin_runtime::catalog::context::ContextProposal {
            key: format!("context:{}", child.operation_id),
            branch_id: child.child_branch_id.clone(),
            through_id: None,
            expected_revision: 0,
            summary: String::new(),
            effective_system_prompt: "Selected Computer child".into(),
            instruction_sources: vec!["fixture:computer".into()],
            memory_checkpoint: None,
        };
        let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"fixture:computer","memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":null,"originalSections":[{"name":"preamble","content":"Selected Computer child"}],"instructionSources":["fixture:computer"]})).unwrap();
        let child = base
            .db
            .prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
        let child_run = child.receipt.unwrap().run_id;
        let parent_run = base.context.run_id.clone();
        let epoch = base.db.epoch();
        base.db
            .commit_execution(
                &child_run,
                epoch,
                &ExecutionRecord::StateChanged {
                    state: RunState::Runnable,
                    waiting_on: None,
                },
            )
            .unwrap();
        Self {
            base,
            child_run,
            parent_run,
        }
    }
    pub fn request(&mut self, policy: bool) -> ComputerRequestRecord {
        let context = admit_call(
            &mut self.base.db,
            &self.child_run,
            "computer_request",
            json!({"desktopId":"desktop","access":"control","reason":"Inspect the requested scene"}),
            policy,
        );
        let prepared = self
            .base
            .db
            .prepare_computer_request(
                &context.operation_id,
                "desktop".into(),
                ComputerAccess::Control,
                "Inspect the requested scene".into(),
                1,
            )
            .unwrap()
            .load()
            .unwrap();
        let request = self.base.db.admit_computer_request(prepared).unwrap();
        settle_call(
            &mut self.base.db,
            &context,
            ToolCompletion::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::Confirmed,
                content: json!({"requestId":request.id,"status":"pending"}).into(),
            },
        );
        request
    }
    pub fn wait(&mut self, request: &ComputerRequestRecord, policy: bool) -> String {
        let context = admit_call(
            &mut self.base.db,
            &self.child_run,
            "computer_wait",
            json!({"requestId":request.id}),
            policy,
        );
        let op = self
            .base
            .db
            .wait_for_computer_request(&context.operation_id, &request.id)
            .unwrap();
        let completion = self
            .base
            .db
            .host_job_acceptance(&op.id)
            .unwrap()
            .load()
            .unwrap();
        settle_call(&mut self.base.db, &context, completion);
        let epoch = self.base.db.epoch();
        self.base
            .db
            .commit_execution(
                &self.child_run,
                epoch,
                &ExecutionRecord::StateChanged {
                    state: RunState::Waiting,
                    waiting_on: op.waiting_on.clone(),
                },
            )
            .unwrap();
        op.id
    }
    pub fn user(&self, key: &str) -> ComputerDecisionActor {
        ComputerDecisionActor::User {
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
            key: key.into(),
        }
    }
    pub fn cleanup(self) {
        let root = self.base.root.clone();
        drop(self);
        std::fs::remove_dir_all(root).unwrap();
    }
}
pub fn admit_call(
    db: &mut Catalog,
    run_id: &str,
    name: &str,
    args: Value,
    policy: bool,
) -> ToolExecutionContext {
    let child_dispatch = db
        .launch_metadata(run_id)
        .unwrap()
        .unwrap()
        .dispatch_context_ref;
    let launch = db.launch_intent(run_id).unwrap().unwrap().selection;
    let tool = launch
        .tools
        .iter()
        .find(|t| t.name == name)
        .unwrap()
        .clone();
    let epoch = db.epoch();
    let run = db.run(run_id).unwrap();
    db.commit_execution(
        run_id,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    let unique = uuid::Uuid::new_v4().to_string();
    let call = ToolCall {
        call_id: unique.clone(),
        name: name.into(),
        schema_version: tool.version.clone(),
        arguments: args,
    };
    let origin = if policy {
        let boundary = db.policy_boundary(run_id, epoch).unwrap();
        let action_id = format!("{run_id}:policy:{}", boundary.id);
        let origin = ToolOrigin::PolicyAction {
            action_id: action_id.clone(),
            node_id: unique,
        };
        let context = FrozenToolContext {
            child_dispatch: child_dispatch.clone(),
            resource_activations: vec![],
            resource_checkpoint_id: boundary.resource_checkpoint_id.clone(),
            run_id: run_id.into(),
            origin: origin.clone(),
            tool_schema_generation: launch.tool_schema_generation,
            tools: std::sync::Arc::new(launch.tools.clone()),
            source: launch.source.clone(),
        };
        db.admit_policy_graph(
            run_id,
            epoch,
            &PolicyGraphIntent::PolicyToolGraphV1 {
                action_id,
                boundary,
                identity: launch.policy.clone(),
                state: json!({}),
                nodes: vec![PolicyAdmittedNode {
                    context,
                    node: PolicyToolNode {
                        id: call.call_id.clone(),
                        depends_on: vec![],
                        call: call.clone(),
                    },
                }],
            },
        )
        .unwrap();
        origin
    } else {
        let request_id = format!("computer-model:{unique}");
        let range = HistoryRange {
            branch_id: run.branch_id.clone(),
            ancestor_id: None,
            leaf_id: db.head(&run.branch_id).unwrap(),
        };
        let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":child_dispatch,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":launch.connection_identity,"provider_family":launch.provider_family,"model":launch.model,"credential_ref":"credential-ref","configuration_generation":launch.configuration_generation,"tool_schema_generation":launch.tool_schema_generation,"tools":launch.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
        db.commit_execution(
            run_id,
            epoch,
            &ExecutionRecord::RequestPrepared {
                snapshot: RequestSnapshot {
                    view: RequestView {
                        request_id: request_id.clone(),
                        run_id: run_id.into(),
                        origin: RequestOrigin::Conversation {
                            step: 1,
                            history_range: range,
                        },
                        binding,
                        history: vec![],
                    },
                    serialized: json!({}),
                }.into(),
            },
        )
        .unwrap();
        db.commit_execution(
            run_id,
            epoch,
            &ExecutionRecord::ModelDispatched {
                request_id: request_id.clone(),
            },
        )
        .unwrap();
        db.commit_execution(
            run_id,
            epoch,
            &ExecutionRecord::ModelFinished {
                request_id: request_id.clone(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: vec![ProviderItem {
                    id: format!("item:{unique}"),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                }],
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
        )
        .unwrap();
        ToolOrigin::ModelStep { request_id }
    };
    let context = ToolExecutionContext {
        operation_id: origin.operation_id(&call.call_id),
        run_id: run_id.into(),
        origin,
    };
    let job = name == "computer_wait";
    db.commit_execution(
        run_id,
        epoch,
        &ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call,
                contract: ToolContract {
                    name: name.into(),
                    schema_version: tool.version,
                    read_only: job,
                    completion: if job {
                        CompletionKind::Job
                    } else {
                        CompletionKind::Result
                    },
                    lifetime: if job {
                        Lifetime::Thread
                    } else {
                        Lifetime::Call
                    },
                    resources: vec![],
                },
            },
        },
    )
    .unwrap();
    db.commit_execution(
        run_id,
        epoch,
        &ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: ExecutorOwner::External {
                identity: "original-computer-tool".into(),
                epoch: "tool-epoch".into(),
            },
        },
    )
    .unwrap();
    context
}
pub fn settle_call(db: &mut Catalog, context: &ToolExecutionContext, completion: ToolCompletion) {
    let epoch = db.epoch();
    db.commit_execution(
        &context.run_id,
        epoch,
        &ExecutionRecord::ToolSettled {
            context: context.clone(),
            executor_stopped: !matches!(completion, ToolCompletion::JobAccepted { .. }),
            completion: completion.clone(),
        },
    )
    .unwrap();
    match &context.origin {
        ToolOrigin::ModelStep { request_id } => {
            let op = db.operation(&context.operation_id).unwrap();
            let call = varin_runtime::catalog::tool_content::ToolIntent::from_operation(&op)
                .unwrap()
                .call()
                .clone();
            db.commit_execution(
                &context.run_id,
                epoch,
                &ExecutionRecord::ToolBatchCommitted {
                    request_id: request_id.clone(),
                    results: vec![ToolResult {
                        request_id: request_id.clone(),
                        call_id: call.call_id,
                        completion,
                    }],
                },
            )
            .unwrap();
        }
        ToolOrigin::PolicyAction { action_id, node_id } => {
            db.settle_policy_node(&context.run_id, epoch, action_id, node_id, &completion)
                .unwrap();
        }
        ToolOrigin::NestedCall { .. } => {
            unreachable!("this Computer request fixture creates only model and policy origins")
        }
    }
}
