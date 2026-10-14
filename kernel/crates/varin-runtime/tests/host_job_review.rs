//! Actual Catalog lifetimes/ContentStore/reopen. No OS transport or experiment backend is faked as IPC.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{Value, json};
use varin_runtime::{
    catalog::{
        dispatch::ChildModelBinding,
        host_jobs::{
            HostJobBinding, HostJobPending, HostJobSubject, McpEndpoint, McpTaskState,
            McpTaskStatus,
        },
        launches::LaunchSelection,
    },
    execution::*,
    *,
};
struct Fixture {
    root: std::path::PathBuf,
    db: Catalog,
    run: String,
    dispatch: Option<Value>,
}
impl Fixture {
    fn new() -> Self {
        let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"model","configuration_generation":1,"tool_schema_generation":1,
   "tools":[{"name":"research_submit","version":"1","description":"Research submit","schema":{"type":"object"},"output_schema":null,"metadata":null},{"name":"research_wait","version":"1","description":"Observe research","schema":{"type":"object"},"output_schema":null,"metadata":null}],"policy":{"name":"fixture","version":"1"},"source":{"resource_owner":{"kind":"local"},"workspace_id":"ws","execution_workspace_id":"exec","mode":"fixed_branch","branch_id":"source","revision":1,"live_root":null}})).unwrap();
        Self::with_launch(launch, json!({}))
    }
    fn with_launch(launch: LaunchSelection, configuration: Value) -> Self {
        let root = std::env::temp_dir().join(format!("varin-host-job-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let receipt = db
            .submit_with_launch(
                &SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("Research"),
                    configuration,
                },
                Some(launch),
            )
            .unwrap();
        let mut f = Self {
            root,
            db,
            run: receipt.run_id,
            dispatch: None,
        };
        f.record(ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        });
        f
    }
    fn mcp() -> (Self, HostJobBinding) {
        let configuration = json!({"providerFamily":"openai-responses","endpoint":"https://fixture.invalid","allowAnonymous":true,"model":"fixture","configurationGeneration":1});
        let model: ChildModelBinding =
            serde_json::from_value(json!({"configuration":configuration,"credential_scope":null}))
                .unwrap();
        let connection = model.connection_identity().unwrap();
        let schemas: Vec<ToolSchema> = serde_json::from_value(json!([{"name":"task","version":"1","description":"Original Task","schema":{"type":"object"},"output_schema":null,"metadata":null}])).unwrap();
        let mcp = json!({"reference":"original-mcp-owner","generation":1,"tools":schemas,"routes":{"task":{"kind":"direct_task"}},"resources":{"task":"mcp:peer","server:peer":"mcp:peer"},"provenance":{"servers":{"peer":{"owner":{"source_authority":null,"resource_owner":{"kind":"local"},"configuration":{"agent_dir":"/fixture","config_cwd":"/fixture","project_trusted":false},"execution_scope":"global"},"definition_version":"configuration","resource_key":"mcp:peer"}}}});
        let launch: LaunchSelection = serde_json::from_value(json!({"extension_bindings":[],"mcp_binding":mcp,"connection_identity":connection,"provider_family":"openai-responses","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":schemas,"policy":{"name":"fixture","version":"1"},"source":null})).unwrap();
        let mut fixture = Self::with_launch(launch, configuration);
        let prepared = fixture
            .db
            .prepare_child_dispatch_binding(&fixture.run, model, 1, schemas)
            .unwrap()
            .load()
            .unwrap();
        fixture.dispatch = fixture
            .db
            .bind_child_dispatch(&fixture.run, prepared)
            .unwrap();
        let (context, call) = fixture.tool("task", "task-request");
        let (snapshot, frozen) = fixture
            .db
            .capture_tool_invocation(&context, &call.call_id)
            .unwrap()
            .load_mcp()
            .unwrap();
        let binding = HostJobBinding {
            operation_id: context.operation_id.clone(),
            execution_owner: fixture
                .db
                .operation(&context.operation_id)
                .unwrap()
                .execution_owner
                .unwrap(),
            domain: "mcp.task".into(),
            domain_version: 1,
            subject: HostJobSubject::Mcp {
                endpoint: McpEndpoint {
                    server: "peer".into(),
                    resource_key: "mcp:peer".into(),
                    configuration_version: "configuration".into(),
                    credential_version: "original-credential".into(),
                },
                dispatch_id: context.operation_id,
            },
        };
        fixture
            .db
            .begin_mcp_host_job(binding.clone(), &snapshot, &frozen)
            .unwrap();
        (fixture, binding)
    }
    fn record(&mut self, r: ExecutionRecord) {
        self.db
            .commit_execution(&self.run, self.db.epoch(), &r)
            .unwrap();
    }
    fn user(&mut self, key: &str) -> OperationMetadata {
        let body = self
            .db
            .prepare_result_content()
            .write_data(&json!({"requestId":key,"command":"example"}))
            .unwrap();
        self.db
            .admit_user_host_job(
                "thread",
                "branch",
                &self.run,
                key,
                "research.experiment",
                1,
                &format!("attempt:{key}"),
                body,
            )
            .unwrap()
    }
    fn tool(&mut self, name: &str, request: &str) -> (ToolExecutionContext, ToolCall) {
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: self.db.head("branch").unwrap(),
        };
        let launch = self.db.launch_intent(&self.run).unwrap().unwrap().selection;
        let resources = launch
            .mcp_binding
            .as_ref()
            .and_then(|binding| binding.resources.get(name))
            .map(|key| {
                vec![ResourceClaim {
                    key: key.clone(),
                    access: Access::Write,
                }]
            })
            .unwrap_or_default();
        let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":self.dispatch,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":launch.connection_identity,"provider_family":launch.provider_family,"model":launch.model,"credential_ref":null,"configuration_generation":launch.configuration_generation,"tool_schema_generation":launch.tool_schema_generation,"tools":launch.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
        let call = ToolCall {
            call_id: "call".into(),
            name: name.into(),
            schema_version: "1".into(),
            arguments: json!({"requestId":request}),
        };
        self.record(ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: request.into(),
                    run_id: self.run.clone(),
                    origin: RequestOrigin::Conversation {
                        compaction: None, step: 0,
                        history_range: range,
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({}).into(),
            }
            .into(),
        });
        self.record(ExecutionRecord::ModelDispatched {
            request_id: request.into(),
        });
        self.record(ExecutionRecord::ModelFinished {
            request_id: request.into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: format!("{request}:item"),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        });
        let context = ToolExecutionContext {
            run_id: self.run.clone(),
            operation_id: format!("{request}:tool:call"),
            origin: ToolOrigin::ModelStep {
                request_id: request.into(),
            },
        };
        self.record(ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call: call.clone(),
                contract: ToolContract {
                    name: name.into(),
                    schema_version: "1".into(),
                    read_only: false,
                    completion: CompletionKind::Job,
                    lifetime: Lifetime::Thread,
                    resources,
                },
            },
        });
        self.record(ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: ExecutorOwner::External {
                identity: "selected-tool".into(),
                epoch: "host-1".into(),
            },
        });
        (context, call)
    }
    fn bind(&mut self, id: &str, body: &Value) -> HostJobBinding {
        let op = self.db.operation(id).unwrap();
        let b = HostJobBinding {
            operation_id: id.into(),
            execution_owner: op.execution_owner.unwrap(),
            domain: "research.experiment".into(),
            domain_version: 1,
            subject: op
                .host_job
                .as_ref()
                .map(|link| link.binding.subject.clone())
                .unwrap_or_else(|| HostJobSubject::Workspace {
                    workspace_id: "ws".into(),
                    subject_id: format!("attempt:{id}"),
                }),
        };
        self.db.begin_host_job(b.clone()).unwrap();
        let p = self.db.prepare_result_content().write_result(body).unwrap();
        self.db.accept_host_job(b.clone(), p).unwrap();
        b
    }
    fn terminal(&mut self, b: &HostJobBinding) {
        let op = self.db.operation(&b.operation_id).unwrap();
        let ExecutorOwner::External { epoch, .. } = &b.execution_owner else {
            panic!()
        };
        let p = self
            .db
            .prepare_result_content()
            .write_external_receipt(ExternalReceipt {
                executor: op.executor.unwrap(),
                identity: op.id,
                epoch: epoch.clone(),
                outcome: Outcome::Succeeded,
                effect: Effect::Confirmed,
                result: json!({"attempt":"completed"}).into(),
            })
            .unwrap();
        self.db.record_host_job_terminal(b, p, true).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[test]
fn user_job_outlives_source_run_and_tree_stop_is_a_linear_admission_boundary() {
    let mut f = Fixture::new();
    f.record(ExecutionRecord::StateChanged {
        state: RunState::Completed,
        waiting_on: None,
    });
    let first = f.user("one");
    assert_eq!(first.id, f.user("one").id);
    let planned = HostJobBinding {
        operation_id: first.id.clone(),
        execution_owner: first.execution_owner.clone().unwrap(),
        domain: "research.experiment".into(),
        domain_version: 1,
        subject: HostJobSubject::Workspace {
            workspace_id: "ws".into(),
            subject_id: "attempt:one".into(),
        },
    };
    f.db.begin_host_job(planned).unwrap();
    assert_eq!(f.db.run(&f.run).unwrap().state, RunState::Completed);
    f.db.cancel_tree(varin_runtime::catalog::dispatch::TreeCancelTarget::Thread {
        thread_id: "thread".into(),
    })
    .unwrap();
    assert!(f.db.operation(&first.id).unwrap().cancel_requested);
    let b = f.bind(
        &first.id,
        &json!({"attempt":"one","text":"full accepted body"}),
    );
    assert!(f.db.operation(&first.id).unwrap().cancel_requested);
    let next = f.user("two");
    assert!(!next.cancel_requested);
    f.terminal(&b);
    assert_eq!(f.db.run(&f.run).unwrap().state, RunState::Completed);
    let p =
        f.db.prepare_result_content()
            .write_result(&json!({"changed":true}))
            .unwrap();
    assert!(f.db.accept_host_job(b, p).is_err());
}
#[test]
fn trusted_job_body_pairs_once_and_reopen_never_requires_resubmit() {
    let mut f = Fixture::new();
    let (c, call) = f.tool("research_submit", "request");
    let forged = ToolCompletion::JobAccepted {
        operation_id: c.operation_id.clone(),
        phase: "accepted".into(),
        effect: Effect::Confirmed,
        lifetime: Lifetime::Thread,
        content: Some(json!({"forged":true}).into()),
    };
    assert!(
        f.db.commit_execution(
            &f.run,
            f.db.epoch(),
            &ExecutionRecord::ToolSettled {
                context: c.clone(),
                completion: forged,
                executor_stopped: false
            }
        )
        .is_err()
    );
    let body = json!({"attempt":{"attemptId":"durable"},"text":"original body"});
    let b = f.bind(&c.operation_id, &body);
    let completion =
        f.db.host_job_acceptance(&c.operation_id)
            .unwrap()
            .load()
            .unwrap();
    f.terminal(&b); // Actual backend may finish before the tool caller consumes acceptance.
    f.record(ExecutionRecord::ToolSettled {
        context: c,
        completion: completion.clone(),
        executor_stopped: false,
    });
    f.record(ExecutionRecord::ToolBatchCommitted {
        request_id: "request".into(),
        results: vec![ToolResult {
            request_id: "request".into(),
            call_id: call.call_id,
            completion: completion.clone(),
        }],
    });
    assert_eq!(
        f.db.operation(&b.operation_id).unwrap().outcome,
        Some(Outcome::Succeeded)
    );
    let old = std::mem::replace(&mut f.db, Catalog::open(f.root.join("temporary")).unwrap());
    drop(old);
    let reopened = Catalog::open(&f.root).unwrap();
    assert_eq!(
        reopened
            .host_job_acceptance(&b.operation_id)
            .unwrap()
            .load()
            .unwrap(),
        completion
    );
    assert_eq!(
        reopened
            .research_scopes("thread", "branch", None, None)
            .unwrap()[0]
            .source_run_id,
        f.run
    );
}
#[test]
fn recovered_acceptance_keeps_an_already_delivered_unknown_result() {
    let mut f = Fixture::new();
    let (c, call) = f.tool("research_submit", "uncertain");
    let op = f.db.operation(&c.operation_id).unwrap();
    f.db.begin_host_job(HostJobBinding {
        operation_id: op.id.clone(),
        execution_owner: op.execution_owner.unwrap(),
        domain: "research.experiment".into(),
        domain_version: 1,
        subject: HostJobSubject::Workspace {
            workspace_id: "ws".into(),
            subject_id: format!("attempt:{}", op.id),
        },
    })
    .unwrap();
    let unknown = ToolCompletion::Result {
        outcome: Outcome::Indeterminate,
        effect: Effect::Unknown,
        content: json!({"error":"lost ack"}).into(),
    };
    f.record(ExecutionRecord::ToolSettled {
        context: c.clone(),
        completion: unknown.clone(),
        executor_stopped: false,
    });
    f.record(ExecutionRecord::ToolBatchCommitted {
        request_id: "uncertain".into(),
        results: vec![ToolResult {
            request_id: "uncertain".into(),
            call_id: call.call_id,
            completion: unknown.clone(),
        }],
    });
    let b = f.bind(&c.operation_id, &json!({"attemptId":"original"}));
    let hydrated =
        f.db.capture_operation_read(f.db.operation(&b.operation_id).unwrap())
            .load()
            .unwrap();
    assert_eq!(
        serde_json::to_value(hydrated.call_completion).unwrap(),
        serde_json::to_value(Some(unknown.clone())).unwrap()
    );
    assert_eq!(
        f.db.capture_call_completion(&b.operation_id)
            .unwrap()
            .load()
            .unwrap(),
        unknown
    );
    let acceptance =
        f.db.capture_job_acceptance(&b.operation_id)
            .unwrap()
            .load()
            .unwrap();
    assert!(matches!(
        &acceptance,
        ToolCompletion::JobAccepted {
            content: Some(_),
            ..
        }
    ));
    let wait = f.observing(&b.operation_id, "unknown-observer");
    assert!(f.db.operation(&wait).unwrap().waiting_on.is_some());
    f.db.cancel_host_job_wait(&wait).unwrap();
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert!(!f.db.operation(&b.operation_id).unwrap().cancel_requested);
    f.terminal(&b);
    assert_eq!(
        f.db.capture_job_acceptance(&b.operation_id)
            .unwrap()
            .load()
            .unwrap(),
        acceptance
    );
    assert_eq!(
        f.db.capture_call_completion(&b.operation_id)
            .unwrap()
            .load()
            .unwrap(),
        unknown
    );
}
impl Fixture {
    fn paired(&mut self, c: ToolExecutionContext, call: ToolCall) {
        let ToolOrigin::ModelStep { request_id } = c.origin.clone() else {
            panic!()
        };
        let completion = self
            .db
            .host_job_acceptance(&c.operation_id)
            .unwrap()
            .load()
            .unwrap();
        self.record(ExecutionRecord::ToolSettled {
            context: c,
            completion: completion.clone(),
            executor_stopped: false,
        });
        self.record(ExecutionRecord::ToolBatchCommitted {
            request_id: request_id.clone(),
            results: vec![ToolResult {
                request_id,
                call_id: call.call_id,
                completion,
            }],
        });
    }
    fn observing(&mut self, target: &str, suffix: &str) -> String {
        let (c, call) = self.tool("research_wait", suffix);
        let op = self.db.wait_for_host_job(&c.operation_id, target).unwrap();
        let id = op.id.clone();
        self.paired(c, call);
        self.record(ExecutionRecord::StateChanged {
            state: RunState::Waiting,
            waiting_on: op.waiting_on,
        });
        id
    }
}
#[test]
fn durable_wait_requires_actual_stop_and_cancel_only_closes_observation() {
    let mut f = Fixture::new();
    let (c, call) = f.tool("research_submit", "submit");
    let b = f.bind(&c.operation_id, &json!({"attemptId":"original"}));
    f.paired(c, call);
    let wait = f.observing(&b.operation_id, "wait");
    assert!(f.db.deliver_process_waits().unwrap().is_empty());
    let original = f.db.operation(&b.operation_id).unwrap();
    f.db.cancel_host_job_wait(&wait).unwrap();
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(f.db.operation(&b.operation_id).unwrap(), original);
    assert_eq!(
        f.db.operation(&wait).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    let second = f.observing(&b.operation_id, "wait-again");
    let old = std::mem::replace(
        &mut f.db,
        Catalog::open(f.root.join("temporary-wait")).unwrap(),
    );
    drop(old);
    f.db = Catalog::open(&f.root).unwrap();
    assert!(
        f.db.deliver_process_waits().unwrap().is_empty(),
        "reopen Unknown is not executor stop"
    );
    f.terminal(&b);
    assert_eq!(f.db.deliver_process_waits().unwrap(), vec![f.run.clone()]);
    assert_eq!(
        f.db.operation(&second).unwrap().outcome,
        Some(Outcome::Succeeded)
    );
    let count = f.db.history("branch").unwrap().len();
    f.db.deliver_process_waits().unwrap();
    assert_eq!(f.db.history("branch").unwrap().len(), count);
}
#[test]
fn user_atomic_domain_link_is_discoverable_before_the_first_domain_call() {
    let mut f = Fixture::new();
    let user = f.user("pre-dispatch");
    assert!(user.host_job.as_ref().unwrap().mcp_holder_released);
    assert!(
        HostJobPending::from_operation(user.clone())
            .unwrap()
            .mcp_holder_released
    );
    assert!(f.db.capture_mcp_host_job_context(&user.id).is_err());
    assert!(
        f.db.acknowledge_mcp_holder_released(&user.host_job.as_ref().unwrap().binding)
            .is_err()
    );
    assert!(user.host_job.as_ref().unwrap().acceptance_ref.is_none());
    assert!(
        f.db.pending_host_jobs()
            .unwrap()
            .iter()
            .any(|op| op.id == user.id)
    );
    assert!(f.db.host_job_acceptance(&user.id).is_err());
    let read = f.db.capture_operation_read(user).load().unwrap();
    assert_eq!(read.intent["request"]["requestId"], "pre-dispatch");
    assert!(read.intent.get("request_ref").is_none());
}

#[test]
fn cancelled_host_reader_consumes_the_acceptance_that_won_in_catalog() {
    let mut f = Fixture::new();
    let (c, _) = f.tool("research_submit", "ack-race");
    let b = f.bind(&c.operation_id, &json!({"text":"original accepted body"}));
    let old = std::mem::replace(
        &mut f.db,
        Catalog::open(f.root.join("temporary-race")).unwrap(),
    );
    let persistence = std::sync::Mutex::new(old);
    let epoch = persistence.lock().unwrap().epoch();
    let settled = persistence
        .settle_tool(
            &c,
            epoch,
            ToolExecutionReceipt {
                completion: ToolCompletion::Result {
                    outcome: Outcome::Indeterminate,
                    effect: Effect::Unknown,
                    content: json!({"error":"Host reader cancelled"}).into(),
                },
                executor_stopped: false,
            },
        )
        .unwrap();
    assert!(matches!(
        settled.completion,
        ToolCompletion::JobAccepted {
            content: Some(_),
            ..
        }
    ));
    assert!(!settled.executor_stopped);
    let db = persistence.into_inner().unwrap();
    assert_eq!(db.operation(&b.operation_id).unwrap().outcome, None);
    f.db = db;
}

struct RaceTools(std::sync::Arc<std::sync::Mutex<Catalog>>);
impl ToolExecutor for RaceTools {
    fn executor_owner(&self) -> ExecutorOwner {
        ExecutorOwner::External {
            identity: "selected-tool".into(),
            epoch: "host-1".into(),
        }
    }
    fn prepare(
        &self,
        call: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> std::result::Result<ToolContract, ExecutionError> {
        Ok(ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: false,
            completion: CompletionKind::Job,
            lifetime: Lifetime::Thread,
            resources: vec![],
        })
    }
    fn plan(
        &self,
        c: &ToolCall,
        f: &FrozenToolContext,
        t: &CancellationToken,
    ) -> std::result::Result<ToolPreparation, ExecutionError> {
        self.prepare(c, f, t).map(ToolPreparation::Ready)
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> std::result::Result<(), ExecutionError> {
        Ok(())
    }
    fn execute(
        &self,
        c: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        let binding = HostJobBinding {
            operation_id: c.operation_id.clone(),
            execution_owner: self.executor_owner(),
            domain: "research.experiment".into(),
            domain_version: 1,
            subject: HostJobSubject::Workspace {
                workspace_id: "ws".into(),
                subject_id: format!("attempt:{}", c.operation_id),
            },
        };
        let mut db = self.0.lock().unwrap();
        db.begin_host_job(binding.clone()).unwrap();
        let p = db
            .prepare_result_content()
            .write_result(&json!({"accepted":"full original domain body"}))
            .unwrap();
        db.accept_host_job(binding, p).unwrap();
        // The trusted domain committed, but the separate generic Host reader lost its ACK.
        ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            content: json!({"error":"reader aborted after accepted"}).into(),
        }
    }
    fn execute_receipt(
        &self,
        c: &ToolExecutionContext,
        a: &ToolCall,
        k: &ToolContract,
        t: &CancellationToken,
    ) -> ToolExecutionReceipt {
        ToolExecutionReceipt {
            completion: self.execute(c, a, k, t),
            executor_stopped: false,
        }
    }
}
struct RaceProvider;
impl ModelProvider for RaceProvider {
    fn serialize(&self, v: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> std::result::Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(serde_json::to_value(v).unwrap().into())
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> std::result::Result<(), ExecutionError>,
    ) -> std::result::Result<FinishReason, ModelFailure> {
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "tool".into(),
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: "call".into(),
                        name: "research_submit".into(),
                        schema_version: "1".into(),
                        arguments: json!({"command":"original"}),
                    },
                },
                opaque: None,
            },
        })
        .unwrap();
        Ok(FinishReason::ToolCalls)
    }
}
struct RacePolicy {
    graph: bool,
    events: std::sync::Mutex<Vec<Value>>,
}
impl AgentPolicy for RacePolicy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "fixture".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        _: &PolicyView<'_>,
        event: &PolicyEvent,
        _: &Value,
        _: &CancellationToken,
    ) -> std::result::Result<PolicyDecision, ExecutionError> {
        self.events
            .lock()
            .unwrap()
            .push(serde_json::to_value(event).unwrap());
        let action=match event{
    PolicyEvent::Started if self.graph=>serde_json::from_value(json!({"kind":"tool_graph","nodes":[{"id":"submit","depends_on":[],"call":{"call_id":"submit","name":"research_submit","schema_version":"1","arguments":{"command":"original"}}}]})).unwrap(),
    PolicyEvent::Started=>PolicyAction::RequestModel,
    PolicyEvent::ModelCompleted{..}=>PolicyAction::ExecuteTools,
    PolicyEvent::ToolsCompleted{results}=>{assert!(matches!(&results[0].completion,ToolCompletion::JobAccepted{content:Some(body),..} if body.data["accepted"]=="full original domain body"));PolicyAction::Complete},
    PolicyEvent::ToolGraphCompleted{receipts,..}=>{let body=serde_json::to_value(&receipts[0]).unwrap();assert_eq!(body["completion"]["kind"],"job_accepted");assert!(body["completion"]["output"].is_object());PolicyAction::Complete},
    other=>panic!("unexpected {other:?}")};
        Ok(PolicyDecision {
            action,
            state: Value::Null,
        })
    }
}
#[test]
fn actual_model_batch_and_policy_graph_consume_canonical_accepted_receipts() {
    for graph in [false, true] {
        let mut f = Fixture::new();
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: f.db.head("branch").unwrap(),
        };
        let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"model","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":f.db.launch_intent(&f.run).unwrap().unwrap().selection.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
        let input =
            f.db.prepare_execution(
                &f.run,
                binding,
                PolicyIdentity {
                    name: "fixture".into(),
                    version: "1".into(),
                },
                Value::Null,
            )
            .unwrap();
        let original = std::mem::replace(
            &mut f.db,
            Catalog::open(f.root.join("temporary-engine")).unwrap(),
        );
        let db = std::sync::Arc::new(std::sync::Mutex::new(original));
        let engine = ExecutionEngine {
            context_preparation: std::sync::Arc::new(NoopContextPreparation),
            persistence: db.clone(),
            provider: std::sync::Arc::new(RaceProvider),
            tools: std::sync::Arc::new(RaceTools(db.clone())),
            policy: std::sync::Arc::new(RacePolicy {
                graph,
                events: Default::default(),
            }),
            progress: ProgressSink::default(),
        };
        let report = engine.run(input, CancellationToken::default()).unwrap();
        assert_eq!(report.state, RunState::Completed);
        let pending = db.lock().unwrap().pending_host_jobs().unwrap();
        assert_eq!(pending.len(), 1);
        let op = &pending[0];
        assert_eq!(op.phase, OperationPhase::Running);
        assert!(op.external_receipt.is_none());
        let history = db.lock().unwrap().history("branch").unwrap();
        let encoded = serde_json::to_string(&history).unwrap();
        assert!(!encoded.contains("reader aborted"));
        if graph {
            assert!(!encoded.contains("model_step"));
        }
        let accepted = op.clone();
        assert!(accepted.handed_off);
        drop(engine);
        drop(db);
        let reopened = Catalog::open(&f.root).unwrap();
        assert_eq!(reopened.operation(&accepted.id).unwrap(), accepted);
        assert_eq!(reopened.pending_host_jobs().unwrap(), vec![accepted]);
        assert_eq!(reopened.history("branch").unwrap(), history);
    }
}

#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[test]
fn user_request_and_full_acceptance_are_original_content_roots_and_pending_is_metadata_only() {
    let mut f = Fixture::new();
    let user = f.user("content");
    let b = f.bind(
        &user.id,
        &json!({"text":"complete accepted domain receipt","attempt":{"attemptId":"content"}}),
    );
    content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap();
    let op = f.db.operation(&user.id).unwrap();
    assert!(f.db.capture_operation_read(op.clone()).load().is_ok());
    let reference = &op
        .host_job
        .as_ref()
        .unwrap()
        .acceptance_ref
        .as_ref()
        .unwrap()["content_object"];
    let hash = reference.as_str().unwrap().strip_prefix("sha256-").unwrap();
    std::fs::write(
        f.root
            .join("content/objects")
            .join(&hash[..2])
            .join(&hash[2..]),
        b"damaged body",
    )
    .unwrap();
    assert!(f.db.host_job_acceptance(&user.id).unwrap().load().is_err());
    let healthy = f.user("healthy");
    let projected: Vec<_> =
        f.db.pending_host_jobs()
            .unwrap()
            .into_iter()
            .map(varin_runtime::catalog::host_jobs::HostJobPending::from_operation)
            .collect::<std::result::Result<_, _>>()
            .unwrap();
    assert_eq!(projected.len(), 2);
    assert!(
        projected
            .iter()
            .any(|p| p.binding.operation_id == healthy.id)
    );
    f.db.request_cancel_operation(&user.id).unwrap();
    f.terminal(&b);
    assert!(
        f.db.operation(&user.id)
            .unwrap()
            .external_receipt
            .unwrap()
            .executor_stopped
    );
}
#[test]
fn same_subject_cannot_acquire_a_second_user_execution_owner_and_historical_thread_scopes_survive_fork()
 {
    let mut f = Fixture::new();
    let (c, call) = f.tool("research_submit", "shared-key");
    let b = f.bind(&c.operation_id, &json!({"requestId":"same"}));
    f.paired(c, call);
    let body =
        f.db.prepare_result_content()
            .write_data(&json!({"requestId":"same","command":"example"}))
            .unwrap();
    let error =
        f.db.admit_user_host_job(
            "thread",
            "branch",
            &f.run,
            "same",
            "research.experiment",
            1,
            match &b.subject {
                HostJobSubject::Workspace { subject_id, .. } => subject_id,
                _ => panic!("research job requires workspace"),
            },
            body,
        )
        .unwrap_err();
    assert!(error.to_string().contains(&b.operation_id));
    assert_eq!(f.db.pending_host_jobs().unwrap().len(), 1);
    f.record(ExecutionRecord::StateChanged {
        state: RunState::Completed,
        waiting_on: None,
    });
    let head = f.db.head("branch").unwrap();
    f.db.fork_branch("branch", "fork", head.as_deref()).unwrap();
    let scopes = f.db.research_scopes("thread", "fork", None, None).unwrap();
    assert_eq!(scopes.len(), 1);
    assert_eq!(scopes[0].source_run_id, f.run);
    assert!(!scopes[0].can_submit);
    assert!(
        f.db.research_scopes("another-thread", "fork", None, None)
            .is_err()
    );
}

#[test]
fn planned_user_command_does_not_hold_its_source_run_foreground_open() {
    let mut f = Fixture::new();
    let command = f.user("independent");
    assert!(command.handed_off);
    assert!(command.host_job.as_ref().unwrap().acceptance_ref.is_none());
    assert!(command.call_completion.is_none());
    f.record(ExecutionRecord::StateChanged {
        state: RunState::Completed,
        waiting_on: None,
    });
    assert_eq!(f.db.run(&f.run).unwrap().state, RunState::Completed);
    f.db.cancel_tree(varin_runtime::catalog::dispatch::TreeCancelTarget::Thread {
        thread_id: "thread".into(),
    })
    .unwrap();
    assert!(f.db.operation(&command.id).unwrap().cancel_requested);
}

#[test]
fn original_mcp_holder_cleanup_is_binding_fenced_durable_and_independent_of_task_facts() {
    for status in [
        McpTaskStatus::Completed,
        McpTaskStatus::Failed,
        McpTaskStatus::Cancelled,
    ] {
        let (mut f, binding) = Fixture::mcp();
        let begun = f.db.operation(&binding.operation_id).unwrap();
        assert!(!begun.host_job.as_ref().unwrap().mcp_holder_released);
        assert!(
            !HostJobPending::from_operation(begun)
                .unwrap()
                .mcp_holder_released
        );
        let (read, thread) =
            f.db.capture_mcp_host_job_context(&binding.operation_id)
                .unwrap();
        let (snapshot, frozen) = read.load_mcp().unwrap();
        assert_eq!(thread, "thread");
        assert_eq!(snapshot.context.operation_id, binding.operation_id);
        assert!(snapshot.frozen.source.is_none());
        assert_eq!(frozen.reference, "original-mcp-owner");
        f.db.validate_tool_invocation(&snapshot, false).unwrap();
        assert!(
            f.db.operation(&binding.operation_id)
                .unwrap()
                .host_job
                .unwrap()
                .mcp_task
                .is_none(),
            "original cleanup context is readable before Task acceptance"
        );
        let task = McpTaskState {
            task_id: "original-remote-task".into(),
            status: McpTaskStatus::Working,
            created_at: "created".into(),
            last_updated_at: "created".into(),
            ttl: None,
            poll_interval: None,
        };
        let acceptance =
            f.db.prepare_result_content()
                .write_data(&json!({"accepted":true}))
                .unwrap();
        f.db.accept_host_job_task(binding.clone(), acceptance, Some(task.clone()))
            .unwrap();
        let observation =
            f.db.prepare_result_content()
                .write_data(&json!({"status":status}))
                .unwrap();
        let outcome = if status == McpTaskStatus::Completed {
            Outcome::Succeeded
        } else if status == McpTaskStatus::Failed {
            Outcome::Failed
        } else {
            Outcome::Indeterminate
        };
        let effect = if status == McpTaskStatus::Cancelled {
            Effect::Unknown
        } else {
            Effect::Confirmed
        };
        let result =
            f.db.prepare_result_content()
                .write_external_receipt(ExternalReceipt {
                    executor: "task".into(),
                    identity: binding.operation_id.clone(),
                    epoch: "host-1".into(),
                    outcome,
                    effect,
                    result: json!({"original":"result"}).into(),
                })
                .unwrap();
        let settled =
            f.db.update_mcp_task(
                &binding,
                1,
                McpTaskState {
                    status,
                    last_updated_at: "settled".into(),
                    ..task
                },
                McpTaskAvailability::Available,
                None,
                Some((McpTaskResultKind::Response, result)),
                observation,
            )
            .unwrap();
        assert_eq!(
            settled.external_receipt.as_ref().unwrap().executor_stopped,
            status != McpTaskStatus::Cancelled
        );
        assert!(
            f.db.pending_host_jobs()
                .unwrap()
                .iter()
                .any(|op| op.id == binding.operation_id),
            "terminal result and stop do not acknowledge cleanup"
        );
        let mut wrong_version = binding.clone();
        wrong_version.domain_version = 2;
        assert!(
            f.db.acknowledge_mcp_holder_released(&wrong_version)
                .is_err()
        );
        let mut wrong_domain = binding.clone();
        wrong_domain.domain = "another-domain".into();
        assert!(f.db.acknowledge_mcp_holder_released(&wrong_domain).is_err());
        let mut wrong_owner = binding.clone();
        wrong_owner.execution_owner = ExecutorOwner::External {
            identity: "selected-tool".into(),
            epoch: "another-owner".into(),
        };
        assert!(f.db.acknowledge_mcp_holder_released(&wrong_owner).is_err());
        let mut wrong_subject = binding.clone();
        if let HostJobSubject::Mcp { endpoint, .. } = &mut wrong_subject.subject {
            endpoint.credential_version = "new-credential".into();
        }
        assert!(
            f.db.acknowledge_mcp_holder_released(&wrong_subject)
                .is_err()
        );
        drop(read);
        drop(snapshot);
        drop(frozen);
        let old = std::mem::replace(
            &mut f.db,
            Catalog::open(f.root.join("replacement")).unwrap(),
        );
        drop(old);
        f.db = Catalog::open(&f.root).unwrap();
        let reopened = &mut f.db;
        assert!(
            !reopened
                .operation(&binding.operation_id)
                .unwrap()
                .host_job
                .unwrap()
                .mcp_holder_released
        );
        let before = reopened.operation(&binding.operation_id).unwrap();
        let acknowledged = reopened.acknowledge_mcp_holder_released(&binding).unwrap();
        let mut expected = before;
        expected.host_job.as_mut().unwrap().mcp_holder_released = true;
        expected.revision += 1;
        assert_eq!(
            acknowledged, expected,
            "cleanup acknowledgement changes no execution or result facts"
        );
        assert_eq!(
            reopened.acknowledge_mcp_holder_released(&binding).unwrap(),
            acknowledged,
            "same original cleanup retry is idempotent"
        );
        assert_eq!(
            reopened
                .pending_host_jobs()
                .unwrap()
                .iter()
                .any(|op| op.id == binding.operation_id),
            status == McpTaskStatus::Cancelled,
            "cancelled is still not stop evidence after holder cleanup"
        );
        let old = std::mem::replace(
            &mut f.db,
            Catalog::open(f.root.join("replacement")).unwrap(),
        );
        drop(old);
        f.db = Catalog::open(&f.root).unwrap();
        assert!(
            f.db.operation(&binding.operation_id)
                .unwrap()
                .host_job
                .unwrap()
                .mcp_holder_released,
            "acknowledged cleanup survives reopening"
        );
        assert!(
            f.db.finish_mcp_task(&binding)
                .unwrap()
                .host_job
                .unwrap()
                .mcp_holder_released,
            "finishing the original result cannot reopen cleanup"
        );
    }
}

#[test]
fn original_unaccepted_mcp_intent_retains_cleanup_after_an_unstarted_terminal_receipt() {
    let (mut f, binding) = Fixture::mcp();
    let original = f.db.operation(&binding.operation_id).unwrap();
    let receipt =
        f.db.prepare_result_content()
            .write_external_receipt(ExternalReceipt {
                executor: original.executor.unwrap(),
                identity: binding.operation_id.clone(),
                epoch: "host-1".into(),
                outcome: Outcome::Failed,
                effect: Effect::None,
                result: json!({"reason":"target proved creation never began"}).into(),
            })
            .unwrap();
    let terminal =
        f.db.record_host_job_terminal(&binding, receipt, true)
            .unwrap();
    assert!(terminal.host_job.as_ref().unwrap().mcp_task.is_none());
    assert!(
        f.db.pending_host_jobs()
            .unwrap()
            .iter()
            .any(|op| op.id == binding.operation_id)
    );
    let (read, _) =
        f.db.capture_mcp_host_job_context(&binding.operation_id)
            .unwrap();
    let (snapshot, binding_body) = read.load_mcp().unwrap();
    assert_eq!(binding_body.reference, "original-mcp-owner");
    f.db.validate_tool_invocation(&snapshot, false).unwrap();
    let released = f.db.acknowledge_mcp_holder_released(&binding).unwrap();
    let mut expected = terminal;
    expected.host_job.as_mut().unwrap().mcp_holder_released = true;
    expected.revision += 1;
    assert_eq!(released, expected);
    assert!(f.db.pending_host_jobs().unwrap().is_empty());
}
