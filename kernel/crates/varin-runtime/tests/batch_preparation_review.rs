//! Adversarial preparation/dispatch checks against the public execution contract.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Condvar, Mutex,
};
use std::time::Duration;
use varin_runtime::execution::*;
use varin_runtime::execution_capacity::ExecutionClass;
use varin_runtime::resource_admission::ResourceAdmission;
use varin_runtime::{Effect, Lifetime, Outcome, RunState};

const WAIT: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Gate(Mutex<bool>, Condvar);
impl Gate {
    fn open(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
    fn wait(&self, cancel: &CancellationToken) {
        let mut open = self.0.lock().unwrap();
        while !*open && !cancel.is_cancelled() {
            open = self
                .1
                .wait_timeout(open, Duration::from_millis(5))
                .unwrap()
                .0;
        }
    }
}

#[derive(Default)]
struct Store {
    admission: Arc<ResourceAdmission>,
    records: Mutex<Vec<ExecutionRecord>>,
    fail_settlement: bool,
}
impl Persistence for Store {
    fn resource_admission(&self) -> Arc<ResourceAdmission> {
        self.admission.clone()
    }
    fn compile_context(
        &self,
        _: &str,
        _: u64,
        _: Option<&str>,
    ) -> Result<Option<ContextProjection>, ExecutionError> {
        Ok(None)
    }
    fn consume_inputs(
        &self,
        _: &str,
        _: u64,
        _: Option<&str>,
    ) -> Result<Vec<ConversationItem>, ExecutionError> {
        Ok(vec![])
    }
    fn commit(&self, _: &str, _: u64, record: &ExecutionRecord) -> Result<(), ExecutionError> {
        if self.fail_settlement && matches!(record, ExecutionRecord::ToolSettled { .. }) {
            return Err(ExecutionError::new(
                "fixture_settlement",
                "receipt persistence unavailable",
            ));
        }
        self.records.lock().unwrap().push(record.clone());
        Ok(())
    }
}

struct Provider {
    calls: Vec<ToolCall>,
    generations: AtomicUsize,
}
impl ModelProvider for Provider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let first = self.generations.fetch_add(1, Ordering::SeqCst) == 0;
        let items = if first {
            self.calls
                .iter()
                .map(|call| ProviderItem {
                    id: format!("item-{}", call.call_id),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                })
                .collect::<Vec<_>>()
        } else {
            let results = request
                .view
                .history
                .iter()
                .filter_map(|item| match &item.content {
                    Content::ToolResult { result } => Some(result.call_id.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(
                results,
                self.calls
                    .iter()
                    .map(|c| c.call_id.clone())
                    .collect::<Vec<_>>(),
                "continuation must receive complete provider pairing in accepted order"
            );
            vec![ProviderItem {
                id: "answer".into(),
                content: Content::Text {
                    text: "done".into(),
                },
                opaque: None,
            }]
        };
        for item in items {
            emit(ProviderEvent::ItemCompleted { item }).map_err(|e| ModelFailure {
                code: e.code,
                message: e.message,
                retry_after_ms: None,
                provider_request_id: None,
            })?;
        }
        Ok(if first {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}

#[derive(Clone)]
struct Spec {
    key: String,
    access: Access,
    intent: Option<ResourceIntent>,
    declared_class: ExecutionClass,
    actual_class: ExecutionClass,
    prepare_gate: Option<Arc<Gate>>,
    execute_gate: Option<Arc<Gate>>,
    cancel_second_authorize: bool,
}
impl Spec {
    fn ready(key: &str, access: Access) -> Self {
        Self {
            key: key.into(),
            access,
            intent: None,
            declared_class: ExecutionClass::Unmetered,
            actual_class: ExecutionClass::Unmetered,
            prepare_gate: None,
            execute_gate: None,
            cancel_second_authorize: false,
        }
    }
    fn dynamic(key: &str, access: Access, gate: Arc<Gate>) -> Self {
        Self {
            intent: Some(ResourceIntent::Prefix {
                key_prefix: "file:".into(),
                access,
            }),
            prepare_gate: Some(gate),
            ..Self::ready(key, access)
        }
    }
    fn contract(&self, call: &ToolCall) -> ToolContract {
        ToolContract {
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            read_only: self.access == Access::Read,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![ResourceClaim {
                key: self.key.clone(),
                access: self.access,
            }],
        }
    }
}
struct Tools {
    specs: BTreeMap<String, Spec>,
    authorizations: Mutex<BTreeMap<String, usize>>,
    events: mpsc::Sender<String>,
}
impl ToolExecutor for Tools {
    fn plan(
        &self,
        call: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        let spec = &self.specs[&call.call_id];
        Ok(match &spec.intent {
            Some(intent) => ToolPreparation::Resolve {
                resources: vec![intent.clone()],
                class: spec.declared_class,
            },
            None => ToolPreparation::Ready(spec.contract(call)),
        })
    }
    fn prepare(
        &self,
        call: &ToolCall,
        _: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        let spec = &self.specs[&call.call_id];
        self.events
            .send(format!("prepare:{}", call.call_id))
            .unwrap();
        if let Some(gate) = &spec.prepare_gate {
            gate.wait(cancel);
        }
        if cancel.is_cancelled() {
            return Err(ExecutionError::new(
                "fixture_cancel",
                "preparation cancelled",
            ));
        }
        Ok(spec.contract(call))
    }
    fn execution_class(&self, call: &ToolCall, _: &ToolContract) -> ExecutionClass {
        self.specs[&call.call_id].actual_class
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        let mut counts = self.authorizations.lock().unwrap();
        let count = counts.entry(call.call_id.clone()).or_default();
        *count += 1;
        if *count == 2 && self.specs[&call.call_id].cancel_second_authorize {
            cancel.cancel();
        }
        self.events
            .send(format!("authorize:{}:{}", call.call_id, count))
            .unwrap();
        Ok(())
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion {
        self.events
            .send(format!("execute:{}", call.call_id))
            .unwrap();
        let spec = &self.specs[&call.call_id];
        if let Some(gate) = &spec.execute_gate {
            gate.wait(cancel);
        }
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: if spec.access == Access::Read {
                Effect::None
            } else {
                Effect::Confirmed
            },
            content: json!(call.call_id),
        }
    }
}

fn input(run: &str) -> ExecutionInput {
    ExecutionInput {
        run_id: run.into(),
        owner_generation: 1,
        binding: RequestBinding {
            connection_identity: "fixture".into(),
            provider_family: "fixture".into(),
            model: "fixture".into(),
            credential_ref: None,
            configuration_generation: 1,
            tool_schema_generation: 1,
            tools: vec![ToolSchema {
                name: "fixture".into(),
                version: "1".into(),
                schema: json!({"type":"object"}),
            }],
            instruction_sources: vec![],
            memory_checkpoint: None,
            attachment_refs: vec![],
            environment_cursor: 0,
            history_range: HistoryRange {
                branch_id: run.into(),
                ancestor_id: None,
                leaf_id: None,
            },
        },
        history: vec![],
        policy_state: Value::Null,
        completed_model_steps: 0,
    }
}
fn start(
    store: Arc<Store>,
    run: &str,
    specs: Vec<(&str, Spec)>,
    events: mpsc::Sender<String>,
    cancel: CancellationToken,
) -> (
    Arc<Provider>,
    std::thread::JoinHandle<Result<ExecutionReport, ExecutionError>>,
) {
    let provider = Arc::new(Provider {
        calls: specs
            .iter()
            .map(|(id, _)| ToolCall {
                call_id: (*id).into(),
                name: "fixture".into(),
                schema_version: "1".into(),
                arguments: json!({}),
            })
            .collect(),
        generations: AtomicUsize::new(0),
    });
    let engine = ExecutionEngine {
        persistence: store,
        context_preparation: Arc::new(NoopContextPreparation),
        provider: provider.clone(),
        tools: Arc::new(Tools {
            specs: specs
                .into_iter()
                .map(|(id, spec)| (id.into(), spec))
                .collect(),
            authorizations: Mutex::new(BTreeMap::new()),
            events,
        }),
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    };
    let input = input(run);
    (
        provider,
        std::thread::spawn(move || engine.run(input, cancel)),
    )
}
fn until(events: &mpsc::Receiver<String>, wanted: &str) -> Vec<String> {
    let deadline = std::time::Instant::now() + WAIT;
    let mut seen = vec![];
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .unwrap();
        seen.push(event.clone());
        if event == wanted {
            return seen;
        }
    }
}

#[test]
fn stalled_preparation_does_not_delay_ready_execution_but_provider_pairing_waits() {
    let store = Arc::new(Store::default());
    let gate = Arc::new(Gate::default());
    let cancel = CancellationToken::default();
    let (tx, rx) = mpsc::channel();
    let (provider, worker) = start(
        store.clone(),
        "independent",
        vec![
            ("slow", Spec::dynamic("file:a", Access::Write, gate)),
            ("ready", Spec::ready("process:status", Access::Read)),
        ],
        tx,
        cancel.clone(),
    );
    until(&rx, "execute:ready");
    assert_eq!(provider.generations.load(Ordering::SeqCst), 1);
    assert!(!store
        .records
        .lock()
        .unwrap()
        .iter()
        .any(|r| matches!(r, ExecutionRecord::ToolBatchCommitted { .. })));
    cancel.cancel();
    assert_eq!(worker.join().unwrap().unwrap().state, RunState::Cancelled);
    assert!(!rx.try_iter().any(|event| event == "execute:slow"));
    assert_eq!(store.admission.summary().queued, 0);
}

#[test]
fn reversed_alias_resolution_across_runs_keeps_accepted_write_order() {
    let store = Arc::new(Store::default());
    let prepare = Arc::new(Gate::default());
    let execute = Arc::new(Gate::default());
    let (tx, rx) = mpsc::channel();
    let mut first = Spec::dynamic("file:canonical", Access::Write, prepare.clone());
    first.execute_gate = Some(execute.clone());
    let (_, a) = start(
        store.clone(),
        "a",
        vec![("first-alias", first)],
        tx.clone(),
        CancellationToken::default(),
    );
    until(&rx, "prepare:first-alias");
    let second_ready = Arc::new(Gate::default());
    second_ready.open();
    let (_, b) = start(
        store.clone(),
        "b",
        vec![
            (
                "second-alias",
                Spec::dynamic("file:canonical", Access::Write, second_ready),
            ),
            ("unrelated", Spec::ready("process:output", Access::Read)),
        ],
        tx,
        CancellationToken::default(),
    );
    let before = until(&rx, "execute:unrelated");
    assert!(!before.iter().any(|e| e == "execute:second-alias"));
    prepare.open();
    let order = until(&rx, "execute:first-alias");
    assert!(!order.iter().any(|e| e == "execute:second-alias"));
    execute.open();
    until(&rx, "execute:second-alias");
    assert_eq!(a.join().unwrap().unwrap().state, RunState::Completed);
    assert_eq!(b.join().unwrap().unwrap().state, RunState::Completed);
}

#[test]
fn unresolved_read_does_not_block_another_reader_of_same_namespace() {
    let store = Arc::new(Store::default());
    let prepare = Arc::new(Gate::default());
    let (tx, rx) = mpsc::channel();
    let (_, worker) = start(
        store,
        "readers",
        vec![
            (
                "slow-reader",
                Spec::dynamic("file:a", Access::Read, prepare.clone()),
            ),
            ("ready-reader", Spec::ready("file:a", Access::Read)),
        ],
        tx,
        CancellationToken::default(),
    );
    until(&rx, "execute:ready-reader");
    prepare.open();
    assert_eq!(worker.join().unwrap().unwrap().state, RunState::Completed);
}

#[test]
fn invalid_declared_intent_or_class_cannot_dispatch() {
    for class_mismatch in [false, true] {
        let store = Arc::new(Store::default());
        let gate = Arc::new(Gate::default());
        gate.open();
        let mut spec = Spec::dynamic("file:a", Access::Write, gate);
        let expected = if class_mismatch {
            spec.actual_class = ExecutionClass::LocalCompute;
            "execution_class_mismatch"
        } else {
            spec.intent = Some(ResourceIntent::Exact(ResourceClaim {
                key: "file:a".into(),
                access: Access::Read,
            }));
            "resource_intent_mismatch"
        };
        let (tx, rx) = mpsc::channel();
        let (_, worker) = start(
            store.clone(),
            "invalid",
            vec![("invalid", spec)],
            tx,
            CancellationToken::default(),
        );
        assert_eq!(worker.join().unwrap().unwrap().state, RunState::Completed);
        assert!(!rx.try_iter().any(|e| e == "execute:invalid"));
        assert!(store.records.lock().unwrap().iter().any(|r| matches!(r, ExecutionRecord::ToolBatchCommitted { results, .. }
            if matches!(&results[0].completion, ToolCompletion::Result { effect: Effect::None, content, .. } if content["error"] == expected))));
        assert_eq!(store.admission.summary().queued, 0);
    }
}

#[test]
fn cancellation_during_final_authorization_cannot_dispatch() {
    let store = Arc::new(Store::default());
    let (tx, rx) = mpsc::channel();
    let mut spec = Spec::ready("file:a", Access::Write);
    spec.cancel_second_authorize = true;
    let (_, worker) = start(
        store,
        "last-check",
        vec![("cancelled", spec)],
        tx,
        CancellationToken::default(),
    );
    worker.join().unwrap().unwrap();
    assert!(
        !rx.try_iter().any(|e| e == "execute:cancelled"),
        "operation cancelled before ToolDispatched must not reach execute"
    );
}

#[test]
fn persistence_failure_cancels_queued_successor_without_releasing_uncertain_occupancy() {
    let store = Arc::new(Store {
        fail_settlement: true,
        ..Store::default()
    });
    let execute = Arc::new(Gate::default());
    let mut first = Spec::ready("file:a", Access::Write);
    first.execute_gate = Some(execute.clone());
    let (tx, rx) = mpsc::channel();
    let (_, worker) = start(
        store.clone(),
        "persist",
        vec![
            ("first", first),
            ("queued", Spec::ready("file:a", Access::Write)),
        ],
        tx,
        CancellationToken::default(),
    );
    until(&rx, "execute:first");
    execute.open();
    assert_eq!(
        worker.join().unwrap().unwrap_err().code,
        "fixture_settlement"
    );
    assert!(!rx.try_iter().any(|e| e == "execute:queued"));
    assert_eq!(store.admission.summary().queued, 0);
    let owner = store
        .records
        .lock()
        .unwrap()
        .iter()
        .find_map(|record| match record {
            ExecutionRecord::ToolDispatched {
                request_id,
                call_id,
            } if call_id == "first" => Some(format!("{request_id}:tool:{call_id}")),
            _ => None,
        })
        .expect("durable dispatch identity");
    assert_eq!(
        store.admission.inspect(&owner).map(|s| s.state),
        Some("active")
    );
}
