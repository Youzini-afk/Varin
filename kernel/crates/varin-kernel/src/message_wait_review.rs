//! Real ModelStep/PolicyAction, Catalog and original input consumers. Model and Host responses
//! are controlled fixtures; no paid model or full Host IPC is used by these tests.
use super::*;
use varin_runtime::{
    catalog::messages::reply_wait::ReplyWaitState, InputMode, Lifetime, OperationPhase,
};
struct Batch {
    calls: Vec<ToolCall>,
}
impl ModelProvider for Batch {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        _: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        for call in &self.calls {
            emit(ProviderEvent::ItemCompleted {
                item: ProviderItem {
                    id: call.call_id.clone(),
                    content: Content::ToolCall { call: call.clone() },
                    opaque: None,
                },
            })
            .unwrap();
        }
        Ok(FinishReason::ToolCalls)
    }
}
fn calls(waits: Vec<Value>) -> Vec<ToolCall> {
    waits.into_iter().enumerate().map(|(i,wait)|ToolCall{call_id:format!("send-{i}"),name:"send".into(),schema_version:"3".into(),arguments:json!({"kind":"inform","targetThreadId":"thread:parent","targetBranchId":"branch:parent","text":format!("Original request {i}"),"wait":wait})}).collect()
}
fn fixture() -> Fixture {
    Fixture::with_tools(
        false,
        vec![crate::message_tools::schema()],
        vec!["send".into()],
    )
}
pub(super) fn waiting(f: &Fixture, model: bool, calls: Vec<ToolCall>) {
    f.prepare_policy(0, "http://127.0.0.1:1/unused-planner");
    let mut start = f.start(0);
    start.provider = Arc::new(Batch {
        calls: calls.clone(),
    });
    let input = f
        .catalog()
        .lock()
        .unwrap()
        .prepare_execution(
            &f.run.id,
            start.binding.clone(),
            start.policy.identity(),
            Value::Null,
        )
        .unwrap();
    let engine = make_engine(f, start);
    let (tx, done) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        tx.send(engine.run(input, CancellationToken::default()))
            .unwrap()
    });
    let end = Instant::now() + Duration::from_secs(10);
    let mut owner = OwnerReplies::default();
    let report = loop {
        assert!(Instant::now() < end, "wait admission stalled");
        if let Ok(report) = done.try_recv() {
            break report.unwrap();
        }
        let frame = match f.frames.recv_timeout(Duration::from_millis(20)) {
            Ok(v) => v,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(e) => panic!("{e}"),
        };
        if owner.frame(f, &frame, false) || f.ordinary_frame(&frame) {
            continue;
        }
        assert_eq!(frame["kind"], "agent-policy-request", "{frame}");
        let event = frame["input"]["event"]["kind"].as_str().unwrap();
        let action = if model {
            if event == "model_completed" {
                json!({"kind":"execute_tools"})
            } else {
                assert_eq!(event, "started");
                json!({"kind":"request_model"})
            }
        } else {
            assert_eq!(event, "started");
            json!({"kind":"tool_graph","nodes":calls.iter().map(|call|json!({"id":call.call_id,"depends_on":[],"call":call})).collect::<Vec<_>>()})
        };
        f.reply(&frame, json!({"state":{"original":true},"action":action}));
    };
    worker.join().unwrap();
    assert_eq!(report.state, RunState::Waiting, "{:?}", report.failure);
    assert_eq!(report.model_steps, u64::from(model));
}
fn outgoing(f: &Fixture) -> Vec<MessageSummary> {
    f.catalog()
        .lock()
        .unwrap()
        .capture_message_list(
            f.run.thread_id.clone(),
            f.run.branch_id.clone(),
            MessageDirection::Outgoing,
            None,
            None,
        )
        .unwrap()
        .load(&|| false)
        .unwrap()
        .messages
}
fn reply(f: &Fixture, id: &str, key: &str, kind: varin_runtime::MessageKind) -> MessageReceipt {
    let catalog = f.catalog();
    let mut db = catalog.lock().unwrap();
    let p = db
        .prepare_user_message(
            key.into(),
            "thread:parent".into(),
            "branch:parent".into(),
            MessageInput {
                wait: None,
                target_thread_id: None,
                target_branch_id: None,
                reply_to: Some(id.into()),
                kind,
                text: format!("Original reply {key}"),
            },
        )
        .unwrap()
        .load()
        .unwrap();
    db.admit_message(p).unwrap().receipt
}
fn reconcile(f: &Fixture) -> Vec<String> {
    f.assembly.runtime.reconcile_observations().unwrap()
}
#[test]
fn both_origins_multiple_replies_park_until_all_original_observations_are_delivered() {
    for model in [true, false] {
        let f = fixture();
        waiting(&f, model, calls(vec![json!({}), json!({})]));
        let messages = outgoing(&f);
        assert_eq!(messages.len(), 2);
        for message in &messages {
            let view = message.reply_wait.as_ref().unwrap();
            assert_eq!(view.state, ReplyWaitState::Waiting);
            assert!(!view.delivered);
            assert_eq!(view.deadline_at_ms, None);
            let db = f.catalog();
            let db = db.lock().unwrap();
            let op = db.operation(&view.operation_id).unwrap();
            let public = db.capture_operation_read(op).load().unwrap();
            assert_eq!(public.effect, Effect::Confirmed);
            assert!(matches!(
                public.call_completion,
                Some(ToolCompletion::JobAccepted {
                    effect: Effect::Confirmed,
                    lifetime: Lifetime::Thread,
                    ..
                })
            ));
        }
        let first = reply(
            &f,
            &messages[0].receipt.identity.message_id,
            "first",
            varin_runtime::MessageKind::Inform,
        );
        assert!(reconcile(&f).is_empty());
        assert_eq!(
            f.catalog().lock().unwrap().run(&f.run.id).unwrap().state,
            RunState::Waiting
        );
        let after = outgoing(&f);
        assert_eq!(
            after[0].reply_wait.as_ref().unwrap().state,
            ReplyWaitState::Replied
        );
        assert!(after[0].reply_wait.as_ref().unwrap().delivered);
        assert!(!after[1].reply_wait.as_ref().unwrap().delivered);
        assert!(
            f.catalog()
                .lock()
                .unwrap()
                .history(&f.run.branch_id)
                .unwrap()
                .iter()
                .all(|h| h.id != first.identity.message_id),
            "reply body stays in original queue until the barrier opens"
        );
        let second = reply(
            &f,
            &messages[1].receipt.identity.message_id,
            "second",
            varin_runtime::MessageKind::Inform,
        );
        assert_eq!(reconcile(&f), vec![f.run.id.clone()]);
        let f = f.reopen();
        assert_eq!(reconcile(&f), vec![f.run.id.clone()]);
        let seen = resume(&f);
        for id in [&first.identity.message_id, &second.identity.message_id] {
            assert_eq!(seen.iter().filter(|item| &item.id == id).count(), 1);
        }
        assert_eq!(
            seen.iter()
                .filter(|item| matches!(&item.content, Content::ToolResult { .. }))
                .count(),
            if model { 2 } else { 0 }
        );
        assert_eq!(outgoing(&f).len(), 2);
        assert!(reconcile(&f).is_empty());
        let catalog = f.catalog();
        let db = catalog.lock().unwrap();
        assert_eq!(db.pending_observation_wait(&f.run.id).unwrap(), None);
        let history = db.history(&f.run.branch_id).unwrap();
        for id in [&first.identity.message_id, &second.identity.message_id] {
            assert_eq!(history.iter().filter(|h| &h.id == id).count(), 1);
        }
        let observed = history
            .iter()
            .filter(|h| h.id.starts_with("reply-observation:"))
            .count();
        assert_eq!(observed, 2);
        drop(db);
        drop(catalog);
        f.finish();
    }
}
#[test]
fn absolute_deadlines_keep_early_reply_and_reject_late_reply_even_before_timer_reconciliation() {
    for early in [false, true] {
        let f = fixture();
        waiting(&f, true, calls(vec![json!({"timeoutMs":2000})]));
        let original = outgoing(&f).remove(0);
        let view = original.reply_wait.as_ref().unwrap();
        let deadline = view.deadline_at_ms.unwrap();
        assert_eq!(deadline, original.receipt.accepted_at_ms + 2000);
        let early_reply = early.then(|| {
            reply(
                &f,
                &original.receipt.identity.message_id,
                "early",
                varin_runtime::MessageKind::Inform,
            )
        });
        let now = varin_runtime::catalog::observations::wall_time_ms().unwrap();
        std::thread::sleep(Duration::from_millis(deadline.saturating_sub(now) + 20));
        // No timer/reconciliation/reopen has run: late acceptance itself must resolve elapsed.
        if !early {
            reply(
                &f,
                &original.receipt.identity.message_id,
                "late",
                varin_runtime::MessageKind::Inform,
            );
            let waiting = outgoing(&f).remove(0).reply_wait.unwrap();
            assert_eq!(waiting.state, ReplyWaitState::Expired);
            assert!(!waiting.delivered);
        }
        let f = f.reopen();
        reconcile(&f);
        let after = outgoing(&f).remove(0);
        let wait = after.reply_wait.unwrap();
        assert_eq!(wait.deadline_at_ms, Some(deadline));
        assert_eq!(
            wait.state,
            if early {
                ReplyWaitState::Replied
            } else {
                ReplyWaitState::Expired
            }
        );
        assert_eq!(
            wait.reply_message_id,
            early_reply.map(|r| r.identity.message_id)
        );
        assert!(wait.delivered);
        let db = f.catalog();
        let db = db.lock().unwrap();
        let op = db.operation(&view.operation_id).unwrap();
        assert_eq!(op.effect, Effect::Confirmed);
        assert_eq!(op.outcome, Some(Outcome::Succeeded));
        drop(db);
        f.finish();
    }
    let f = fixture();
    waiting(&f, false, calls(vec![json!({"timeoutMs":0})]));
    reconcile(&f);
    assert_eq!(
        outgoing(&f)[0].reply_wait.as_ref().unwrap().state,
        ReplyWaitState::Expired
    );
    f.finish();
}
#[test]
fn new_user_input_ends_all_observers_without_withdrawing_messages_and_terminal_close_is_not_delivery(
) {
    let f = fixture();
    waiting(&f, true, calls(vec![json!({}), json!({})]));
    let original = outgoing(&f);
    let catalog = f.catalog();
    {
        let mut db = catalog.lock().unwrap();
        db.enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput {
            key: "new-owner-input".into(),
            thread_id: f.run.thread_id.clone(),
            branch_id: f.run.branch_id.clone(),
            mode: InputMode::Boundary,
            input: json!("Please change course"),
            configuration: None,
        })
        .unwrap();
        let head = db.head(&f.run.branch_id).unwrap();
        let p = db
            .prepare_input_delivery(&f.run.id, db.epoch(), head.as_deref())
            .unwrap()
            .load()
            .unwrap();
        assert!(db
            .admit_input_delivery(p)
            .unwrap()
            .unwrap()
            .items
            .is_empty());
    }
    reconcile(&f);
    for message in outgoing(&f) {
        let wait = message.reply_wait.unwrap();
        assert_eq!(wait.state, ReplyWaitState::Cancelled);
        assert!(wait.delivered);
        let db = catalog.lock().unwrap();
        assert_eq!(
            db.operation(&wait.operation_id).unwrap().effect,
            Effect::Confirmed
        );
    }
    assert_eq!(outgoing(&f).len(), original.len());
    drop(catalog);
    f.finish();
    let f = fixture();
    waiting(&f, true, calls(vec![json!({})]));
    f.assembly.runtime.cancel(&f.run.id).unwrap();
    reconcile(&f);
    let message = outgoing(&f).remove(0);
    let wait = message.reply_wait.unwrap();
    assert_eq!(wait.state, ReplyWaitState::Cancelled);
    assert!(!wait.delivered);
    assert_eq!(
        f.catalog()
            .lock()
            .unwrap()
            .operation(&wait.operation_id)
            .unwrap()
            .phase,
        OperationPhase::Terminal
    );
    f.finish();
}
struct FinalModel {
    calls: AtomicUsize,
    seen: Mutex<Vec<ConversationItem>>,
}
impl ModelProvider for FinalModel {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.seen.lock().unwrap() = request.view.history.clone();
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: "final-message".into(),
                content: Content::Text {
                    text: "Received all original replies".into(),
                },
                opaque: None,
            },
        })
        .unwrap();
        Ok(FinishReason::Stop)
    }
}
fn resume(f: &Fixture) -> Vec<ConversationItem> {
    f.prepare_policy(0, "http://127.0.0.1:1/unused-planner");
    let mut start = f.start(0);
    let provider = Arc::new(FinalModel {
        calls: AtomicUsize::new(0),
        seen: Mutex::new(Vec::new()),
    });
    start.provider = provider.clone();
    let (input, recovery) = f
        .catalog()
        .lock()
        .unwrap()
        .prepare_recovered_execution(
            &f.run.id,
            start.binding.clone(),
            start.policy.identity(),
            Value::Null,
        )
        .unwrap();
    let engine = make_engine(f, start);
    let (tx, done) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        tx.send(engine.run_recovered(input, CancellationToken::default(), recovery))
            .unwrap()
    });
    let end = Instant::now() + Duration::from_secs(10);
    let mut owner = OwnerReplies::default();
    let report = loop {
        assert!(Instant::now() < end, "resume stalled");
        if let Ok(report) = done.try_recv() {
            break report.unwrap();
        }
        let frame = match f.frames.recv_timeout(Duration::from_millis(20)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(e) => panic!("{e}"),
        };
        if owner.frame(f, &frame, false) || f.ordinary_frame(&frame) {
            continue;
        }
        assert_eq!(frame["kind"], "agent-policy-request", "{frame}");
        let action = if frame["input"]["event"]["kind"] == "model_completed" {
            json!({"kind":"complete"})
        } else {
            json!({"kind":"request_model"})
        };
        f.reply(&frame, json!({"state":{"resumed":true},"action":action}));
    };
    worker.join().unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let seen = provider.seen.lock().unwrap().clone();
    seen
}
#[test]
fn original_job_pairs_and_reply_body_reach_one_recovered_model_request() {
    for model in [false, true] {
        let f = fixture();
        waiting(&f, model, calls(vec![json!({}), json!({})]));
        let messages = outgoing(&f);
        // Two prepared retries and a reopen must reuse the accepted operation, clock and Wait.
        {
            let catalog = f.catalog();
            let mut db = catalog.lock().unwrap();
            let view = messages[0].reply_wait.as_ref().unwrap();
            let op = db.operation(&view.operation_id).unwrap();
            let public = db.capture_operation_read(op).load().unwrap();
            let invocation: ToolInvocation = serde_json::from_value(public.intent).unwrap();
            let context = ToolExecutionContext {
                run_id: f.run.id.clone(),
                operation_id: view.operation_id.clone(),
                origin: invocation.origin.clone(),
            };
            for _ in 0..2 {
                let p = db
                    .prepare_tool_message(
                        &context,
                        invocation.call.clone(),
                        crate::message_tools::schema(),
                        serde_json::from_value(invocation.call.arguments.clone()).unwrap(),
                    )
                    .unwrap()
                    .load()
                    .unwrap();
                let accepted = db.admit_message(p).unwrap();
                assert!(!accepted.accepted);
                assert_eq!(accepted.receipt, messages[0].receipt);
            }
        }
        let one = reply(
            &f,
            &messages[0].receipt.identity.message_id,
            "recovered-one",
            varin_runtime::MessageKind::Inform,
        );
        reconcile(&f);
        let f = f.reopen();
        let two = reply(
            &f,
            &messages[1].receipt.identity.message_id,
            "recovered-two",
            varin_runtime::MessageKind::Inform,
        );
        reconcile(&f);
        let seen = resume(&f);
        for id in [&one.identity.message_id, &two.identity.message_id] {
            assert_eq!(seen.iter().filter(|item| &item.id == id).count(), 1);
        }
        assert_eq!(
            seen.iter()
                .filter(|item| matches!(&item.content, Content::ToolResult { .. }))
                .count(),
            if model { 2 } else { 0 }
        );
        assert_eq!(outgoing(&f).len(), 2);
        assert!(reconcile(&f).is_empty());
        f.finish();
    }
}
#[test]
#[cfg(target_os = "linux")]
fn native_continuation_worker_expires_catalog_wait_without_host_or_model_polling() {
    let f = fixture();
    waiting(&f, true, calls(vec![json!({"timeoutMs":150})]));
    let (signal, wakes) = crate::continuation_wake::channel().unwrap();
    let (events, event_rx) = mpsc::sync_channel(1);
    f.catalog()
        .lock()
        .unwrap()
        .set_event_notifier(events)
        .unwrap();
    let owner = Arc::downgrade(&f.assembly.runtime);
    let worker = std::thread::spawn(move || crate::continuation_wake::drive(owner, wakes));
    let guard = crate::continuation_wake::StopGuard(signal.clone());
    signal.notify();
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        event_rx
            .recv_timeout(end.saturating_duration_since(Instant::now()))
            .expect("native deadline did not produce a committed event");
        signal.notify();
        if f.catalog().lock().unwrap().run(&f.run.id).unwrap().state == RunState::Runnable {
            break;
        }
    }
    let wait = outgoing(&f).remove(0).reply_wait.unwrap();
    assert_eq!(wait.state, ReplyWaitState::Expired);
    assert!(wait.delivered);
    drop(guard);
    worker.join().unwrap();
    f.finish();
}

#[test]
#[cfg(target_os = "linux")]
fn native_deadline_survives_unrelated_followup_reconciliation_failure() {
    let f = fixture();
    waiting(&f, true, calls(vec![json!({"timeoutMs":1500})]));
    // Inject an unreadable followup definition in the independent original control owner.
    // All original Wait/Run/Operation/message facts remain valid and queryable.
    let fault = rusqlite::Connection::open(f.root.join("conversation.sqlite")).unwrap();
    fault.execute("INSERT INTO followups(id,thread_id,source_run_id,operation_id,body) VALUES('broken-followup',?1,?2,NULL,?3)", rusqlite::params![f.run.thread_id, f.run.id, r#"{"wait":{"state":"waiting"}}"#]).unwrap();
    assert!(varin_runtime::catalog::followups::reconcile(&f.catalog()).is_err());
    let (signal, wakes) = crate::continuation_wake::channel().unwrap();
    let (events, event_rx) = mpsc::sync_channel(1);
    f.catalog()
        .lock()
        .unwrap()
        .set_event_notifier(events)
        .unwrap();
    let owner = Arc::downgrade(&f.assembly.runtime);
    let worker = std::thread::spawn(move || crate::continuation_wake::drive(owner, wakes));
    let guard = crate::continuation_wake::StopGuard(signal.clone());
    signal.notify();
    let end = Instant::now() + Duration::from_secs(4);
    let mut ready = false;
    // Listen to real commits without forwarding an artificial event to the worker. The
    // future absolute timer itself must stay armed after the followup failure diagnostic.
    while event_rx
        .recv_timeout(end.saturating_duration_since(Instant::now()))
        .is_ok()
    {
        if f.catalog().lock().unwrap().run(&f.run.id).unwrap().state == RunState::Runnable {
            ready = true;
            break;
        }
    }
    drop(guard);
    worker.join().unwrap();
    assert!(
        ready,
        "unrelated followup failure disabled the live reply deadline"
    );
    let wait = outgoing(&f).remove(0).reply_wait.unwrap();
    assert_eq!(wait.state, ReplyWaitState::Expired);
    assert!(wait.delivered);
    assert_eq!(
        f.catalog().lock().unwrap().nearest_wait_deadline().unwrap(),
        None
    );
    let diagnostics: i64 = fault
        .query_row(
            "SELECT count(*) FROM events WHERE kind='recovery.unavailable'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        diagnostics, 1,
        "the same failed owner cannot produce a diagnostic/event retry loop"
    );
    fault
        .execute("DELETE FROM followups WHERE id='broken-followup'", [])
        .unwrap();
    drop(fault);
    f.finish();
}
