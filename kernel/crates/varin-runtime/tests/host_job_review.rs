//! Actual Catalog lifetimes/ContentStore/reopen. No OS transport or experiment backend is faked as IPC.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use varin_runtime::{
    catalog::{host_jobs::HostJobBinding, launches::LaunchSelection},
    execution::*,
    *,
};
struct Fixture {
    root: std::path::PathBuf,
    db: Catalog,
    run: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("varin-host-job-{}", uuid::Uuid::new_v4()));
        let mut db = Catalog::open(&root).unwrap();
        db.create_thread("thread", "branch").unwrap();
        let launch:LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"model","configuration_generation":1,"tool_schema_generation":1,
   "tools":[{"name":"research_submit","version":"1","description":"Research submit","schema":{"type":"object"},"output_schema":null,"metadata":null},{"name":"research_wait","version":"1","description":"Observe research","schema":{"type":"object"},"output_schema":null,"metadata":null}],"policy":{"name":"fixture","version":"1"},"source":{"workspace_id":"ws","execution_workspace_id":"exec","mode":"fixed_branch","branch_id":"source","revision":1,"live_root":null}})).unwrap();
        let receipt = db
            .submit_with_launch(
                &SubmitInput {
                    key: "input".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("Research"),
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
        f.record(ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        });
        f
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
            .write_result(&json!({"requestId":key,"command":"example"}))
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
        let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":"fixture","provider_family":"fixture","model":"model","credential_ref":null,"configuration_generation":1,"tool_schema_generation":1,"tools":self.db.launch_intent(&self.run).unwrap().unwrap().selection.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":range})).unwrap();
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
                    resources: vec![],
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
            workspace_id: "ws".into(),
            subject_id: op
                .host_job
                .as_ref()
                .map(|link| link.binding.subject_id.clone())
                .unwrap_or_else(|| format!("attempt:{id}")),
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
                result: json!({"attempt":"completed"}),
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
        workspace_id: "ws".into(),
        subject_id: "attempt:one".into(),
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
        content: Some(json!({"forged":true})),
    };
    assert!(f
        .db
        .commit_execution(
            &f.run,
            f.db.epoch(),
            &ExecutionRecord::ToolSettled {
                context: c.clone(),
                completion: forged,
                executor_stopped: false
            }
        )
        .is_err());
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
        workspace_id: "ws".into(),
        subject_id: format!("attempt:{}", op.id),
    })
    .unwrap();
    let unknown = ToolCompletion::Result {
        outcome: Outcome::Indeterminate,
        effect: Effect::Unknown,
        content: json!({"error":"lost ack"}),
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
    assert_eq!(hydrated.call_completion, Some(unknown));
    assert!(matches!(
        f.db.host_job_acceptance(&b.operation_id)
            .unwrap()
            .load()
            .unwrap(),
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
    assert!(user.host_job.as_ref().unwrap().acceptance_ref.is_none());
    assert!(f
        .db
        .pending_host_jobs()
        .unwrap()
        .iter()
        .any(|op| op.id == user.id));
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
                    content: json!({"error":"Host reader cancelled"}),
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
            workspace_id: "ws".into(),
            subject_id: format!("attempt:{}", c.operation_id),
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
            content: json!({"error":"reader aborted after accepted"}),
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
    fn serialize(&self, v: &RequestView) -> std::result::Result<Value, ExecutionError> {
        Ok(serde_json::to_value(v).unwrap())
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
    PolicyEvent::ToolsCompleted{results}=>{assert!(matches!(&results[0].completion,ToolCompletion::JobAccepted{content:Some(body),..} if body["accepted"]=="full original domain body"));PolicyAction::Complete},
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
    assert!(projected
        .iter()
        .any(|p| p.binding.operation_id == healthy.id));
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
fn same_subject_cannot_acquire_a_second_user_execution_owner_and_historical_thread_scopes_survive_fork(
) {
    let mut f = Fixture::new();
    let (c, call) = f.tool("research_submit", "shared-key");
    let b = f.bind(&c.operation_id, &json!({"requestId":"same"}));
    f.paired(c, call);
    let body =
        f.db.prepare_result_content()
            .write_result(&json!({"requestId":"same","command":"example"}))
            .unwrap();
    let error =
        f.db.admit_user_host_job(
            "thread",
            "branch",
            &f.run,
            "same",
            "research.experiment",
            1,
            &b.subject_id,
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
    assert!(f
        .db
        .research_scopes("another-thread", "fork", None, None)
        .is_err());
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
