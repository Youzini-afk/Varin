//! A restarted Run consumes its original external receipt without replaying an effect.
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use varin_runtime::{
    execution::*,
    supervisor::{RunStart, RunSupervisor},
    *,
};

const REQUEST: &str = "external-request";
const OPERATION: &str = "external-request:tool:write";

#[derive(Default)]
struct NoReplay(AtomicUsize);
impl ModelProvider for NoReplay {
    fn serialize(
        &self,
        _: &RequestView,
        _: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ExecutionError::new(
            "unexpected_model",
            "recovery must consume the original receipt",
        ))
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        panic!("recovery sent another model request")
    }
}
impl ToolExecutor for NoReplay {
    fn plan(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ExecutionError::new(
            "unexpected_tool",
            "recovery must not replay the effect",
        ))
    }
    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        panic!("recovery prepared another effect")
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        panic!("recovery authorized another effect")
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        panic!("recovery executed another effect")
    }
}

struct Fixture {
    root: std::path::PathBuf,
    run: String,
    epoch: u64,
    binding: RequestBinding,
    executor: Arc<NoReplay>,
}
impl Fixture {
    fn dispatched(cancel_before_crash: bool) -> Self {
        Self::interrupted(cancel_before_crash, None)
    }
    fn interrupted(cancel_before_crash: bool, canonical_stop: Option<bool>) -> Self {
        let root =
            std::env::temp_dir().join(format!("varin-external-restart-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "branch").unwrap();
        let accepted = catalog
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "thread".into(),
                branch_id: "branch".into(),
                expected_head: None,
                input: json!("perform one external effect"),
                configuration: json!({}),
            })
            .unwrap();
        let epoch = catalog.epoch();
        let range = HistoryRange {
            branch_id: "branch".into(),
            ancestor_id: None,
            leaf_id: Some(accepted.input_id),
        };
        let binding = RequestBinding { tool_output_visible_bytes: None, mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
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
            tools: vec![ToolSchema {
                name: "external_write".into(),
                version: "1".into(),
                description: String::new(),
                schema: json!({"type":"object"}),
                output_schema: None,
                metadata: None,
                requirements: None,
            }],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: range.clone(),
        };
        let call = ToolCall {
            call_id: "write".into(),
            name: "external_write".into(),
            schema_version: "1".into(),
            arguments: json!({}),
        };
        let context = ToolExecutionContext {
            run_id: accepted.run_id.clone(),
            operation_id: OPERATION.into(),
            origin: ToolOrigin::ModelStep {
                request_id: REQUEST.into(),
            },
        };
        let records = [
            ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
            ExecutionRecord::StateChanged {
                state: RunState::Generating,
                waiting_on: None,
            },
            ExecutionRecord::RequestPrepared {
                snapshot: RequestSnapshot {
                    view: RequestView {
                        request_id: REQUEST.into(),
                        run_id: accepted.run_id.clone(),
                        origin: RequestOrigin::Conversation {
                            compaction: None,
                            step: 1,
                            history_range: range,
                        },
                        binding: binding.clone(),
                        history: vec![],
                    },
                    serialized: json!({"original":true}).into(),
                }
                .into(),
            },
            ExecutionRecord::ModelDispatched {
                request_id: REQUEST.into(),
            },
            ExecutionRecord::ModelFinished {
                request_id: REQUEST.into(),
                outcome: ModelOutcome::Completed,
                finish_reason: Some(FinishReason::ToolCalls),
                items: vec![ProviderItem {
                    id: "call".into(),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                }],
                interrupted_deltas: vec![],
                usage: UsageReceipt::default(),
                failure: None,
            },
            ExecutionRecord::StateChanged {
                state: RunState::Executing,
                waiting_on: None,
            },
            ExecutionRecord::ToolAdmitted {
                context: context.clone(),
                tool: AdmittedTool {
                    call,
                    contract: ToolContract {
                        name: "external_write".into(),
                        schema_version: "1".into(),
                        read_only: false,
                        completion: CompletionKind::Result,
                        lifetime: Lifetime::Run,
                        resources: vec![ResourceClaim {
                            key: "original-file".into(),
                            access: Access::Write,
                        }],
                    },
                },
            },
            ExecutionRecord::ToolDispatched {
                context,
                executor_owner: ExecutorOwner::External {
                    identity: "original-owner".into(),
                    epoch: "original-epoch".into(),
                },
            },
        ];
        for record in records {
            catalog
                .commit_execution(&accepted.run_id, epoch, &record)
                .unwrap();
        }
        // The original external owner made its effect, then its caller lost the completion.
        std::fs::write(root.join("effect.txt"), "exactly once\n").unwrap();
        if let Some(executor_stopped) = canonical_stop {
            catalog
                .commit_execution(
                    &accepted.run_id,
                    epoch,
                    &ExecutionRecord::ToolSettled {
                        context: ToolExecutionContext {
                            run_id: accepted.run_id.clone(),
                            operation_id: OPERATION.into(),
                            origin: ToolOrigin::ModelStep {
                                request_id: REQUEST.into(),
                            },
                        },
                        completion: ToolCompletion::Result {
                            outcome: Outcome::Indeterminate,
                            effect: Effect::Unknown,
                            content: json!({"owner":"original","outcome":"unavailable"}).into(),
                        },
                        executor_stopped,
                    },
                )
                .unwrap();
        }
        if cancel_before_crash {
            catalog.request_cancel_run(&accepted.run_id).unwrap();
        }
        drop(catalog);
        Self {
            root,
            run: accepted.run_id,
            epoch,
            binding,
            executor: Arc::new(NoReplay::default()),
        }
    }
    fn start(&self) -> RunStart {
        RunStart {
            binding: self.binding.clone(),
            policy_state: Value::Null,
            provider: self.executor.clone(),
            tools: self.executor.clone(),
            policy: Arc::new(DefaultAgentPolicy),
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        }
    }
    fn receipt(&self) -> ExternalReceipt {
        ExternalReceipt {
            executor: "external_write".into(),
            identity: OPERATION.into(),
            epoch: "original-epoch".into(),
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            result: json!({"owner":"original","outcome":"unavailable"}).into(),
        }
    }
    fn occupancy(&self) -> i64 {
        rusqlite::Connection::open(self.root.join("conversation.sqlite"))
            .unwrap()
            .query_row(
                "SELECT count(*) FROM resource_occupancy WHERE operation_id=?1",
                [OPERATION],
                |row| row.get(0),
            )
            .unwrap()
    }
    fn assert_no_replay(&self) {
        assert_eq!(self.executor.0.load(Ordering::SeqCst), 0);
        assert_eq!(
            std::fs::read_to_string(self.root.join("effect.txt")).unwrap(),
            "exactly once\n"
        );
    }
    fn request_path(&self) -> std::path::PathBuf {
        let connection = rusqlite::Connection::open(self.root.join("conversation.sqlite")).unwrap();
        let raw: String = connection
            .query_row(
                "SELECT body FROM model_steps WHERE id=?1",
                [REQUEST],
                |row| row.get(0),
            )
            .unwrap();
        let step: Value = serde_json::from_str(&raw).unwrap();
        varin_runtime::content::object_path(
            &self.root.join("content"),
            step["request"]["content_object"].as_str().unwrap(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn unknown_effect_with_original_stop_receipt_closes_exchange_after_restart() {
    struct ContinueAfterReceipt(AtomicUsize);
    impl ModelProvider for ContinueAfterReceipt {
        fn serialize(&self,view:&RequestView,_:Option<&mut RequestCompileReuse>)->Result<RequestBody,ExecutionError>{
            assert!(view.history.iter().any(|item|matches!(&item.content,Content::ToolResult{result}
                if matches!(result.completion,ToolCompletion::Result{outcome:Outcome::Indeterminate,..}))));
            Ok(serde_json::to_value(view).unwrap().into())
        }
        fn generate(&self,_:&RequestSnapshot,_:&CancellationToken,emit:&mut dyn FnMut(ProviderEvent)->Result<(),ExecutionError>)->Result<FinishReason,ModelFailure>{
            self.0.fetch_add(1,Ordering::SeqCst);
            emit(ProviderEvent::ItemCompleted { item:ProviderItem { id:"answer".into(),
                content:Content::Text { text:"continued with original receipt".into() },opaque:None } }).unwrap();
            Ok(FinishReason::Stop)
        }
    }
    for cancel_during_recovery in [false, true] {
        let f = Fixture::dispatched(false);
        let mut catalog = Catalog::open(&f.root).unwrap();
        let original = catalog.operation(OPERATION).unwrap();
        assert_eq!(original.epoch, f.epoch);
        assert_eq!(
            (original.outcome, original.effect),
            (Some(Outcome::Indeterminate), Effect::Unknown)
        );
        assert!(original.call_completion.is_none());
        assert_eq!(f.occupancy(), 1);
        catalog
            .record_external_receipt_with_stop(OPERATION, f.receipt(), true)
            .unwrap();
        assert_eq!(f.occupancy(), 0);
        let supervisor = RunSupervisor::new(catalog);
        let mut start = f.start();
        let provider=Arc::new(ContinueAfterReceipt(AtomicUsize::new(0)));
        start.provider=provider.clone();
        let (entered, entering) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let handle = supervisor
            .prepare_start(&f.run, move |_| {
                entered.send(()).unwrap();
                released.recv().unwrap();
                Ok(start)
            })
            .unwrap();
        entering
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        if cancel_during_recovery {
            supervisor.cancel(&f.run).unwrap();
        }
        release.send(()).unwrap();
        let report = handle.wait().unwrap();
        let expected = if cancel_during_recovery {
            RunState::Cancelled
        } else {
            RunState::Completed
        };
        assert_eq!(report.state, expected);
        assert_eq!(provider.0.load(Ordering::SeqCst),usize::from(!cancel_during_recovery));
        let owner = supervisor.catalog();
        let catalog = owner.lock().unwrap();
        let history = catalog.execution_history("branch").unwrap();
        let results = history
            .iter()
            .filter_map(|item| match &item.content {
                Content::ToolResult { result } => Some(result),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].completion,
            ToolCompletion::Result {
                outcome: Outcome::Indeterminate,
                effect: Effect::Unknown,
                content: f.receipt().result
            }
        );
        let operation = catalog.operation(OPERATION).unwrap();
        assert_eq!(operation.epoch, f.epoch);
        assert_eq!(operation.outcome, Some(Outcome::Indeterminate));
        assert!(operation.external_receipt.unwrap().executor_stopped);
        drop(catalog);
        supervisor.shutdown().unwrap();
        drop(supervisor);
        drop(owner);
        let catalog = Catalog::open(&f.root).unwrap();
        assert_eq!(catalog.run(&f.run).unwrap().state, expected);
        assert_eq!(catalog.execution_history("branch").unwrap(), history);
        f.assert_no_replay();
    }
}

#[test]
fn unknown_effect_without_stop_stays_blocked_and_rejects_another_owner_epoch() {
    let f = Fixture::dispatched(false);
    let mut catalog = Catalog::open(&f.root).unwrap();
    let mut foreign = f.receipt();
    foreign.epoch = "replacement-epoch".into();
    assert!(
        catalog
            .record_external_receipt_with_stop(OPERATION, foreign, true)
            .is_err()
    );
    catalog
        .record_external_receipt_with_stop(OPERATION, f.receipt(), false)
        .unwrap();
    let supervisor = RunSupervisor::new(catalog);
    assert!(supervisor.start(&f.run, f.start()).unwrap().wait().is_err());
    assert_eq!(f.occupancy(), 1);
    let owner = supervisor.catalog();
    let catalog = owner.lock().unwrap();
    assert_eq!(catalog.run(&f.run).unwrap().state, RunState::Waiting);
    assert!(
        catalog
            .operation(OPERATION)
            .unwrap()
            .call_completion
            .is_none()
    );
    assert!(
        !catalog
            .execution_history("branch")
            .unwrap()
            .iter()
            .any(|item| matches!(item.content, Content::ToolResult { .. }))
    );
    f.assert_no_replay();
    drop(catalog);
    supervisor.shutdown().unwrap();
}

#[test]
fn precrash_cancel_with_late_original_stop_receipt_finishes_without_launch() {
    let f = Fixture::dispatched(true);
    let catalog = Catalog::open(&f.root).unwrap();
    let supervisor = RunSupervisor::new(catalog);
    assert_eq!(supervisor.cancel(&f.run).unwrap().state, RunState::Waiting);
    {
        let owner = supervisor.catalog();
        let mut catalog = owner.lock().unwrap();
        assert!(!catalog.run_startable(&f.run).unwrap());
        catalog
            .record_external_receipt_with_stop(OPERATION, f.receipt(), false)
            .unwrap();
    }
    supervisor.reconcile_message_requests().unwrap();
    assert!(supervisor.status().unwrap().is_empty());
    assert_eq!(f.occupancy(), 1);
    {
        let owner = supervisor.catalog();
        let mut catalog = owner.lock().unwrap();
        catalog
            .record_external_receipt_with_stop(OPERATION, f.receipt(), true)
            .unwrap();
    }
    // The same real continuation pass used at startup/on receipts owns the cleanup.
    supervisor.reconcile_message_requests().unwrap();
    supervisor.advance_pending().unwrap();
    supervisor.shutdown().unwrap();
    let owner = supervisor.catalog();
    let catalog = owner.lock().unwrap();
    assert_eq!(catalog.run(&f.run).unwrap().state, RunState::Cancelled);
    assert!(!catalog.run_startable(&f.run).unwrap());
    let operation = catalog.operation(OPERATION).unwrap();
    assert_eq!(operation.outcome, Some(Outcome::Indeterminate));
    assert_eq!(operation.effect, Effect::Unknown);
    assert!(operation.external_receipt.unwrap().executor_stopped);
    assert_eq!(
        catalog
            .execution_history("branch")
            .unwrap()
            .iter()
            .filter(|item| matches!(item.content, Content::ToolResult { .. }))
            .count(),
        1
    );
    assert_eq!(f.occupancy(), 0);
    f.assert_no_replay();
}

#[test]
fn cancelled_canonical_unknown_requires_original_executor_stop_even_with_call_receipt() {
    for originally_stopped in [false, true] {
        let f = Fixture::interrupted(true, Some(originally_stopped));
        let supervisor = RunSupervisor::new(Catalog::open(&f.root).unwrap());
        supervisor.reconcile_message_requests().unwrap();
        if !originally_stopped {
            assert!(supervisor.status().unwrap().is_empty());
            assert_eq!(f.occupancy(), 1);
            let owner = supervisor.catalog();
            let mut catalog = owner.lock().unwrap();
            assert_eq!(catalog.run(&f.run).unwrap().state, RunState::Waiting);
            assert!(
                catalog
                    .operation(OPERATION)
                    .unwrap()
                    .call_completion
                    .is_some()
            );
            assert!(
                !catalog
                    .execution_history("branch")
                    .unwrap()
                    .iter()
                    .any(|item| matches!(item.content, Content::ToolResult { .. }))
            );
            catalog
                .record_external_receipt_with_stop(OPERATION, f.receipt(), true)
                .unwrap();
        }
        supervisor.reconcile_message_requests().unwrap();
        supervisor.shutdown().unwrap();
        let owner = supervisor.catalog();
        let catalog = owner.lock().unwrap();
        assert_eq!(catalog.run(&f.run).unwrap().state, RunState::Cancelled);
        assert_eq!(
            catalog.operation(OPERATION).unwrap().effect,
            Effect::Unknown
        );
        assert_eq!(
            catalog
                .execution_history("branch")
                .unwrap()
                .iter()
                .filter(|item| matches!(item.content, Content::ToolResult { .. }))
                .count(),
            1
        );
        assert_eq!(f.occupancy(), 0);
        f.assert_no_replay();
    }
}

#[test]
fn cancelled_recovery_body_failure_retains_intent_and_receipt_then_retries_real_event_or_cancel() {
    for retry_by_receipt in [false, true] {
        let f = Fixture::dispatched(true);
        let mut catalog = Catalog::open(&f.root).unwrap();
        catalog
            .record_external_receipt_with_stop(OPERATION, f.receipt(), true)
            .unwrap();
        let saved = catalog.operation(OPERATION).unwrap().external_receipt;
        let request = f.request_path();
        let body = std::fs::read(&request).unwrap();
        std::fs::remove_file(&request).unwrap();
        let supervisor = RunSupervisor::new(catalog);
        let (wake, wakes) = std::sync::mpsc::channel();
        supervisor.set_wake_sender(wake).unwrap();
        supervisor.reconcile_message_requests().unwrap();
        wakes
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        // Completion is reapable even if its actual thread return races this wake.
        supervisor.advance_pending().unwrap();
        // Releasing the original worker emits one launch-availability hint. Consume
        // that drain notification before checking that the failed boundary stays idle.
        wakes
            .try_recv()
            .expect("original worker drain must notify launch consumers");
        assert!(supervisor.status().unwrap().is_empty());
        assert!(supervisor.execution_failure(&f.run).unwrap().is_some());
        for _ in 0..3 {
            supervisor.reconcile_message_requests().unwrap();
            assert!(
                supervisor.status().unwrap().is_empty(),
                "unchanged body failure must not launch another recovery worker"
            );
        }
        assert!(
            wakes.try_recv().is_err(),
            "unchanged body failure must not spin"
        );
        {
            let owner = supervisor.catalog();
            let catalog = owner.lock().unwrap();
            let run = catalog.run(&f.run).unwrap();
            assert!(run.cancel_requested);
            assert_eq!(run.state, RunState::Waiting);
            assert_eq!(
                catalog.operation(OPERATION).unwrap().external_receipt,
                saved
            );
            assert!(!catalog.run_startable(&f.run).unwrap());
        }
        std::fs::write(&request, body).unwrap();
        if retry_by_receipt {
            let owner = supervisor.catalog();
            let mut catalog = owner.lock().unwrap();
            let mut receipt = f.receipt();
            receipt.outcome = Outcome::Succeeded;
            receipt.effect = Effect::Confirmed;
            receipt.result = json!({"owner":"original","outcome":"confirmed"}).into();
            catalog
                .record_external_receipt_with_stop(OPERATION, receipt, true)
                .unwrap();
        } else {
            supervisor.cancel(&f.run).unwrap();
        }
        supervisor.reconcile_message_requests().unwrap();
        supervisor.shutdown().unwrap();
        let owner = supervisor.catalog();
        let catalog = owner.lock().unwrap();
        assert_eq!(catalog.run(&f.run).unwrap().state, RunState::Cancelled);
        assert_eq!(
            catalog.operation(OPERATION).unwrap().outcome,
            Some(if retry_by_receipt {
                Outcome::Succeeded
            } else {
                Outcome::Indeterminate
            })
        );
        assert!(supervisor.execution_failure(&f.run).unwrap().is_none());
        assert_eq!(
            catalog
                .execution_history("branch")
                .unwrap()
                .iter()
                .filter(|item| matches!(item.content, Content::ToolResult { .. }))
                .count(),
            1
        );
        f.assert_no_replay();
    }
}

#[test]
fn cancelled_pairing_epoch_adoption_survives_failed_batch_commit_and_reopen() {
    let f = Fixture::dispatched(true);
    let mut catalog = Catalog::open(&f.root).unwrap();
    let recovery_epoch = catalog.epoch();
    catalog
        .record_external_receipt_with_stop(OPERATION, f.receipt(), true)
        .unwrap();
    let raw = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
    raw.execute_batch("CREATE TRIGGER interrupt_cancel_pairing BEFORE UPDATE OF committed ON tool_calls WHEN NEW.committed=1 BEGIN SELECT RAISE(ABORT,'simulated pairing commit interruption'); END;").unwrap();
    let supervisor = RunSupervisor::new(catalog);
    supervisor.reconcile_message_requests().unwrap();
    supervisor.shutdown().unwrap();
    assert!(supervisor.execution_failure(&f.run).unwrap().is_some());
    {
        let owner = supervisor.catalog();
        let catalog = owner.lock().unwrap();
        assert_eq!(catalog.model_step(REQUEST).unwrap().epoch, recovery_epoch);
        assert_eq!(
            catalog.model_step(REQUEST).unwrap().state,
            ModelStepState::Completed
        );
        assert_eq!(catalog.run(&f.run).unwrap().state, RunState::Waiting);
        assert!(catalog.run(&f.run).unwrap().cancel_requested);
        assert_eq!(catalog.operation(OPERATION).unwrap().epoch, f.epoch);
    }
    assert_eq!(
        raw.query_row(
            "SELECT committed FROM tool_calls WHERE request_id=?1",
            [REQUEST],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(supervisor);
    raw.execute_batch("DROP TRIGGER interrupt_cancel_pairing;")
        .unwrap();
    drop(raw);
    let supervisor = RunSupervisor::new(Catalog::open(&f.root).unwrap());
    supervisor.reconcile_message_requests().unwrap();
    supervisor.shutdown().unwrap();
    let owner = supervisor.catalog();
    let catalog = owner.lock().unwrap();
    assert_eq!(catalog.run(&f.run).unwrap().state, RunState::Cancelled);
    assert_eq!(catalog.operation(OPERATION).unwrap().epoch, f.epoch);
    assert_eq!(
        catalog.operation(OPERATION).unwrap().effect,
        Effect::Unknown
    );
    assert_eq!(
        catalog
            .execution_history("branch")
            .unwrap()
            .iter()
            .filter(|item| matches!(item.content, Content::ToolResult { .. }))
            .count(),
        1
    );
    f.assert_no_replay();
}
