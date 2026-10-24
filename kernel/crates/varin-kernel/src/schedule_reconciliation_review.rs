//! Actual Catalog admission, immutable receipts and restart recovery with a controlled
//! existing Source rendezvous. No provider, scheduler mutation or external process runs.
use super::*;
use crate::host_query::OwnerChannel;
use std::sync::{mpsc, Arc};
use std::time::Duration;
use varin_runtime::execution::*;
use varin_runtime::{Catalog, RunState, SubmitInput};

struct Harness {
    root: std::path::PathBuf,
    runtime: Arc<RunSupervisor>,
    resources: KernelResourceClient,
    bridge: OwnerChannel,
    frames: mpsc::Receiver<Value>,
    context: ToolExecutionContext,
    owner: ExecutorOwner,
    source: Value,
}
impl Harness {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-schedule-reconcile-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "branch").unwrap();
        let admission = catalog
            .prepare_submission(
                SubmitInput {
                    key: "schedule-run".into(),
                    thread_id: "thread".into(),
                    branch_id: "branch".into(),
                    expected_head: None,
                    input: json!("manage the original project calendar"),
                    configuration: json!({}),
                },
                None,
                None,
            )
            .unwrap();
        let run = catalog
            .admit_submission(admission.load(None, false).unwrap())
            .unwrap();
        let source = json!({"resource_owner":{"kind":"managed_host","hostId":"B","connectionId":"original-B","endpointIdentity":"identity-B"},
            "mode":"live_root","workspace_id":"workspace","execution_workspace_id":"workspace","branch_id":null,"revision":null,
            "live_root":{"hostId":"B","rootId":"project-root","canonicalRoot":"/project"},"environment_run_id":null});
        let version = "declaration-hash-original";
        let schema = ToolSchema {
            name: "scheduled_task".into(),
            version: version.into(),
            description: String::new(),
            schema: json!({"type":"object","properties":{"action":{"type":"string"}}}),
            requirements: None,
            output_schema: None,
            metadata: None,
        };
        let binding = RequestBinding {
            direct_tools: None,
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
            tool_schema_generation: 1,
            tools: vec![schema],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: "branch".into(),
                ancestor_id: None,
                leaf_id: Some(run.input_id),
            },
        };
        let policy = PolicyIdentity {
            name: "fixture".into(),
            version: "1".into(),
        };
        catalog
            .bind_launch(
                &run.run_id,
                varin_runtime::catalog::launches::LaunchSelection::from_binding(
                    &binding,
                    policy.clone(),
                    Some(serde_json::from_value(source.clone()).unwrap()),
                ),
            )
            .unwrap();
        let epoch = catalog
            .prepare_execution(&run.run_id, binding.clone(), policy, Value::Null)
            .unwrap()
            .owner_generation;
        let context = ToolExecutionContext {
            run_id: run.run_id.clone(),
            operation_id: "request:tool:schedule".into(),
            origin: ToolOrigin::ModelStep {
                request_id: "request".into(),
            },
        };
        let owner = ExecutorOwner::External {
            identity: "original-extension-reference".into(),
            epoch: "A-owner-epoch".into(),
        };
        let call = ToolCall {
            call_id: "schedule".into(),
            name: "scheduled_task".into(),
            schema_version: version.into(),
            arguments: json!({"action":"write_loop","taskId":"daily","content":"original","expectedRevision":"original-revision"}),
        };
        for record in [
            ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
            ExecutionRecord::RequestPrepared {
                snapshot: RequestSnapshot {
                    view: RequestView {
                        request_id: "request".into(),
                        run_id: run.run_id.clone(),
                        origin: RequestOrigin::Conversation {
                            compaction: None,
                            step: 1,
                            history_range: binding.history_range.clone(),
                        },
                        binding,
                        history: vec![],
                    },
                    serialized: json!({}).into(),
                }
                .into(),
            },
            ExecutionRecord::ModelDispatched {
                request_id: "request".into(),
            },
            ExecutionRecord::ModelFinished {
                request_id: "request".into(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: vec![ProviderItem {
                    id: "schedule-call".into(),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                }],
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
            ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call,
                    contract: ToolContract {
                        name: "scheduled_task".into(),
                        schema_version: version.into(),
                        read_only: false,
                        completion: CompletionKind::Result,
                        lifetime: varin_runtime::Lifetime::Run,
                        resources: vec![ResourceClaim {
                            key: "original-project-schedule".into(),
                            access: Access::Write,
                        }],
                    },
                },
            },
            ExecutionRecord::ToolDispatched {
                context: context.clone(),
                executor_owner: owner.clone(),
            },
        ] {
            catalog
                .commit_execution(&run.run_id, epoch, &record)
                .unwrap();
        }
        Self::attach(root, catalog, context, owner, source)
    }
    fn attach(
        root: std::path::PathBuf,
        catalog: Catalog,
        context: ToolExecutionContext,
        owner: ExecutorOwner,
        source: Value,
    ) -> Self {
        let runtime = Arc::new(RunSupervisor::new(catalog));
        let (sender, frames) = mpsc::sync_channel(8);
        let bridge = OwnerChannel::new("source-resource", sender);
        bridge.initialize("transport-epoch");
        let resources = KernelResourceClient::new(
            |_| panic!("recovery must not execute assets"),
            |_| Ok(()),
            Default::default(),
        )
        .with_journal_catalog(runtime.catalog())
        .with_source_bridge(bridge.clone());
        Self {
            root,
            runtime,
            resources,
            bridge,
            frames,
            context,
            owner,
            source,
        }
    }
    fn seed_unknown(&self) {
        let owner = self.runtime.catalog();
        let mut catalog = owner.lock().unwrap();
        let epoch = catalog.epoch();
        catalog
            .commit_execution(
                &self.context.run_id,
                epoch,
                &ExecutionRecord::ToolSettled {
                    context: self.context.clone(),
                    completion: ToolCompletion::Result {
                        outcome: Outcome::Indeterminate,
                        effect: Effect::Unknown,
                        content: json!({"original":"A transport unknown"}).into(),
                    },
                    executor_stopped: false,
                },
            )
            .unwrap();
        let prep = catalog.prepare_result_content();
        drop(catalog);
        let prepared = prep
            .write_external_receipt(ExternalReceipt {
                executor: "scheduled_task".into(),
                identity: self.context.operation_id.clone(),
                epoch: "A-owner-epoch".into(),
                outcome: Outcome::Indeterminate,
                effect: Effect::Unknown,
                result: json!({"original":"A transport unknown"}).into(),
            })
            .unwrap();
        owner
            .lock()
            .unwrap()
            .record_external_tool_receipt_prepared(
                &self.context.operation_id,
                &self.owner,
                prepared,
                false,
            )
            .unwrap();
    }
    fn observe(&self, value: Value) -> Result<bool, KernelError> {
        let runtime = self.runtime.clone();
        let resources = self.resources.clone();
        let id = self.context.operation_id.clone();
        let owner = self.owner.clone();
        let worker =
            std::thread::spawn(move || reconcile(&runtime, &resources, None, &id, Some(&owner)));
        let frame = self.frames.recv_timeout(Duration::from_secs(5)).unwrap();
        self.check_query(&frame, "observe");
        self.reply(&frame, json!({"ok":true,"value":value}));
        worker.join().unwrap()
    }
    fn check_query(&self, frame: &Value, phase: &str) {
        assert_eq!(
            frame["query"],
            json!({"kind":"schedule_receipt","phase":phase,"source":self.source,
            "runId":self.context.run_id,"threadId":"thread","operationId":self.context.operation_id})
        );
        assert!(
            self.runtime.catalog().try_lock().is_ok(),
            "Source IO never occupies Catalog"
        );
    }
    fn reply(&self, frame: &Value, result: Value) {
        self.bridge.receive(json!({"v":1,"kind":"source-resource-response","id":frame["id"],"kernelEpoch":"transport-epoch","result":result}));
    }
    fn load(&self) -> (Operation, Option<ExternalReceipt>) {
        let owner = self.runtime.catalog();
        let catalog = owner.lock().unwrap();
        let read =
            catalog.capture_operation_read(catalog.operation(&self.context.operation_id).unwrap());
        drop(catalog);
        read.load_with_external_receipt().unwrap()
    }
    fn reopen(self) -> Self {
        let root = self.root.clone();
        let context = self.context.clone();
        let owner = self.owner.clone();
        let source = self.source.clone();
        self.bridge.close();
        drop(self);
        let catalog = Catalog::open(&root).unwrap();
        Self::attach(root, catalog, context, owner, source)
    }
    fn remove(self) {
        let root = self.root.clone();
        self.bridge.close();
        drop(self);
        std::fs::remove_dir_all(root).unwrap();
    }
}
fn remote(stopped: bool, outcome: &str, effect: &str, body: Value) -> Value {
    json!({"operationId":"request:tool:schedule","resourceEpoch":"B-original-epoch",
        "executionOwner":{"kind":"external","identity":"source:B:original-authority","epoch":"B-original-epoch"},
        "accepted":true,"executorStopped":stopped,"process":null,"result":{"executor_stopped":stopped,
            "completion":{"kind":"result","outcome":outcome,"effect":effect,"content":{"data":body,"parts":[]}}}})
}
#[test]
fn scheduled_original_unknown_stop_refines_after_reopen_and_preserves_a_owner() {
    let h = Harness::new();
    h.seed_unknown();
    let foreign = ExecutorOwner::External {
        identity: "replacement-extension".into(),
        epoch: "A-owner-epoch".into(),
    };
    assert!(reconcile(
        &h.runtime,
        &h.resources,
        None,
        &h.context.operation_id,
        Some(&foreign)
    )
    .is_err());
    assert!(h.frames.try_recv().is_err());
    assert!(!h.observe(Value::Null).unwrap());
    assert!(!h
        .observe(remote(
            false,
            "indeterminate",
            "unknown",
            json!({"B":"pending"})
        ))
        .unwrap());
    let mut false_stop = remote(true, "indeterminate", "unknown", json!({"B":"invalid"}));
    false_stop["result"]["executor_stopped"] = json!(false);
    assert!(h.observe(false_stop).is_err());
    assert!(!h
        .observe(remote(
            true,
            "indeterminate",
            "unknown",
            json!({"B":"stopped, effect still unknown"})
        ))
        .unwrap());
    let (op, receipt) = h.load();
    assert_eq!(
        receipt.unwrap().result.data,
        json!({"original":"A transport unknown"})
    );
    assert!(op.external_receipt.unwrap().executor_stopped);
    assert_eq!(op.execution_owner.as_ref(), Some(&h.owner));
    assert!(!h
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .external_delivery_persisted(&h.context.operation_id)
        .unwrap());
    assert!(
        h.frames.recv_timeout(Duration::from_millis(50)).is_err(),
        "unknown business effect keeps B's recovery body"
    );
    let h = h.reopen();
    assert!(!h
        .observe(remote(
            true,
            "indeterminate",
            "unknown",
            json!({"B":"stopped, effect still unknown"})
        ))
        .unwrap());
    assert_eq!(
        h.load().1.unwrap().result.data,
        json!({"original":"A transport unknown"})
    );
    h.remove();
    // B's own committed receipt is immutable. A separate original invocation
    // starts Unknown only because its transport reply was lost, then recovers
    // B's already-confirmed original result after A reopens.
    let h = Harness::new();
    h.seed_unknown();
    let h = h.reopen();
    let original = json!({"taskId":"daily","revision":"confirmed-revision","body":"original schedule result".repeat(40_000)});
    assert!(h
        .observe(remote(true, "succeeded", "confirmed", original.clone()))
        .unwrap());
    // Reconciliation returned before remote cleanup. Only the durable original ACK
    // allows this source release; it does not block a late-receipt notification.
    let frame = h.frames.recv_timeout(Duration::from_secs(5)).unwrap();
    h.check_query(&frame, "release");
    let (op, receipt) = h.load();
    let receipt = receipt.unwrap();
    assert_eq!(receipt.epoch, "A-owner-epoch");
    assert_eq!(op.execution_owner, Some(h.owner.clone()));
    assert_eq!(receipt.result.data, original);
    assert_eq!(op.effect, Effect::Confirmed);
    assert!(h
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .external_delivery_persisted(&h.context.operation_id)
        .unwrap());
    h.reply(
        &frame,
        json!({"ok":false,"message":"lost cleanup acknowledgement"}),
    );
    let before = h.load().1.unwrap();
    assert!(reconcile(
        &h.runtime,
        &h.resources,
        None,
        &h.context.operation_id,
        Some(&h.owner)
    )
    .unwrap());
    let retry = h.frames.recv_timeout(Duration::from_secs(5)).unwrap();
    h.check_query(&retry, "release");
    h.reply(
        &retry,
        json!({"ok":true,"value":{"operationId":h.context.operation_id,"released":true}}),
    );
    assert_eq!(
        h.load().1.unwrap(),
        before,
        "known immutable receipt is never replaced or re-observed"
    );
    h.remove();
}
#[test]
fn scheduled_normal_ack_cleanup_replays_existing_delivery_after_restart() {
    let h = Harness::new();
    h.resources
        .release_delivered_schedule_receipt(&h.context.operation_id)
        .unwrap();
    assert!(
        h.frames.try_recv().is_err(),
        "running callback cannot release receipt"
    );
    {
        let owner = h.runtime.catalog();
        let mut catalog = owner.lock().unwrap();
        let epoch = catalog.epoch();
        catalog
            .commit_execution(
                &h.context.run_id,
                epoch,
                &ExecutionRecord::ToolSettled {
                    context: h.context.clone(),
                    completion: ToolCompletion::Result {
                        outcome: Outcome::Succeeded,
                        effect: Effect::Confirmed,
                        content: json!({"original":"normal result"}).into(),
                    },
                    executor_stopped: true,
                },
            )
            .unwrap();
        assert!(catalog
            .external_delivery_persisted(&h.context.operation_id)
            .unwrap());
    }
    let id = h.context.operation_id.clone();
    let resources = h.resources.clone();
    let first = std::thread::spawn(move || resources.release_delivered_schedule_receipt(&id));
    let frame = h.frames.recv_timeout(Duration::from_secs(5)).unwrap();
    h.check_query(&frame, "release");
    h.reply(&frame, json!({"ok":false,"message":"B unavailable"}));
    assert!(first.join().unwrap().is_err());
    let h = h.reopen();
    h.resources.replay_source_delivery_releases().unwrap();
    let retry = h.frames.recv_timeout(Duration::from_secs(5)).unwrap();
    h.check_query(&retry, "release");
    h.reply(
        &retry,
        json!({"ok":true,"value":{"operationId":h.context.operation_id,"released":true}}),
    );
    let (op, _) = h.load();
    assert_eq!(
        op.result.unwrap().output().unwrap().data,
        json!({"original":"normal result"})
    );
    assert_eq!(op.execution_owner, Some(h.owner.clone()));
    h.remove();
}

#[test]
fn scheduled_indeterminate_no_effect_keeps_original_recovery_receipt() {
    let h = Harness::new();
    h.seed_unknown();
    assert!(!h
        .observe(remote(
            true,
            "indeterminate",
            "none",
            json!({"B":"no write, outcome unresolved"})
        ))
        .unwrap());
    let (op, receipt) = h.load();
    assert_eq!(op.outcome, Some(Outcome::Indeterminate));
    assert_eq!(receipt.unwrap().epoch, "A-owner-epoch");
    assert!(!h
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .external_delivery_persisted(&h.context.operation_id)
        .unwrap());
    assert!(h.frames.recv_timeout(Duration::from_millis(50)).is_err());
    h.remove();
}
