//! Original Catalog queue, real lineage and durable receipts; no side inbox or runtime revival.
#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::{catalog::messages::*, execution::*, *};
fn input(thread: &str, branch: &str, text: &str) -> MessageInput {
    MessageInput {
        source_agent: None,
            name: None,
        wait: None,
        target_thread_id: Some(thread.into()),
        target_branch_id: Some(branch.into()),
        reply_to: None,
        kind: MessageKind::Inform,
        text: text.into(),
    }
}
fn send(
    f: &mut Fixture,
    key: &str,
    sender: &str,
    branch: &str,
    input: MessageInput,
) -> MessageReceipt {
    let p =
        f.db.prepare_user_message(key.into(), sender.into(), branch.into(), input)
            .unwrap()
            .load()
            .unwrap();
    f.db.admit_message(p).unwrap().receipt
}
fn parent_message(f: &mut Fixture, key: &str, text: &str) -> MessageReceipt {
    let child = f.db.child_task(&f.context.operation_id).unwrap();
    send(
        f,
        key,
        &child.child_thread_id,
        &child.child_branch_id,
        input("thread:parent", "branch:parent", text),
    )
}
fn finished(f: &mut Fixture, state: RunState) {
    f.db.commit_execution(
        &f.context.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state,
            waiting_on: None,
        },
    )
    .unwrap();
}
#[test]
fn family_feed_reads_peer_and_user_messages_once_and_pages_across_new_acceptance() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    f.db.create_thread("unrelated", "unrelated-branch").unwrap();
    let first = parent_message(&mut f, "feed-first", "first body");
    let second = send(&mut f, "feed-second", "thread:parent", "branch:parent", input(&child.child_thread_id, &child.child_branch_id, "second body"));
    let page = f.db.capture_message_feed("thread:parent".into(), "branch:parent".into(), None, None, Some(1)).unwrap().load(&|| false).unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].message.summary.receipt, second);
    assert_eq!(page.messages[0].message.text, "second body");
    assert_eq!(page.participants.len(), 2);
    let third = send(&mut f, "feed-self", "thread:parent", "branch:parent", input("thread:parent", "branch:parent", "user to main agent"));
    let older = f.db.capture_message_feed(child.child_thread_id.clone(), child.child_branch_id.clone(), page.before, None, Some(1)).unwrap().load(&|| false).unwrap();
    assert_eq!(older.messages[0].message.summary.receipt, first);
    let dispatched = f.db.capture_message_feed(child.child_thread_id.clone(), child.child_branch_id.clone(), older.before, None, Some(1)).unwrap().load(&|| false).unwrap();
    assert!(dispatched.messages.is_empty());
    assert!(dispatched.before.is_none());
    assert_eq!(dispatched.dispatches.len(), 1);
    let dispatch = &dispatched.dispatches[0];
    assert_eq!(dispatch.operation_id, child.operation_id);
    assert_eq!(dispatch.accepted_cursor, child.cursor);
    assert_eq!(dispatch.sender_thread_id, "thread:parent");
    assert_eq!(dispatch.target_thread_id, child.child_thread_id);
    assert_eq!(dispatch.task, f.input.task);
    assert!(dispatch.accepted_at_ms > 0);
    let tail = f.db.capture_message_feed("thread:parent".into(), "branch:parent".into(), None, Some(second.accepted_cursor), Some(1)).unwrap().load(&|| false).unwrap();
    assert_eq!(tail.messages[0].message.summary.receipt, third);
    assert!(tail.after.is_none());
    assert!(f.db.capture_message_feed("unrelated".into(), "unrelated-branch".into(), None, None, None).unwrap().load(&|| false).unwrap().messages.is_empty());
    assert!(f.db.capture_message_feed("thread:parent".into(), "unrelated-branch".into(), None, None, None).is_err());
    assert!(f.db.capture_message_feed("thread:parent".into(), "branch:parent".into(), None, None, None).unwrap().load(&|| true).is_err());
    let mut reply = input(&child.child_thread_id, &child.child_branch_id, "user follows up an outgoing message");
    reply.reply_to = Some(second.identity.message_id.clone());
    let replied = send(&mut f, "feed-reply", "thread:parent", "branch:parent", reply);
    assert_eq!(replied.identity.target_thread_id, child.child_thread_id);
    assert_eq!(replied.identity.actor, MessageActor::User);
}
#[test]
fn family_feed_excludes_retrieval_results_without_changing_native_delivery_or_pagination() {
    let mut f = Fixture::new_internal_retrieval();
    let child = f.accept();
    let before = send(&mut f, "before-retrieval", "thread:parent", "branch:parent",
        input("thread:parent", "branch:parent", "visible before retrieval"));
    f.db.fail_child_preparation(&child.operation_id, "retrieval source unavailable").unwrap();
    f.db.mark_child_resources_released(&child.execution_id).unwrap();
    let owner = std::sync::Mutex::new(f.db);
    varin_runtime::catalog::child_delivery::reconcile_reports(&owner).unwrap();
    let mut db = owner.lock().unwrap();
    let result = db.capture_message("thread:parent", "branch:parent", &format!("message:{}", child.operation_id))
        .unwrap().load().unwrap();
    assert!(result.text.contains("retrieval source unavailable"));
    assert_eq!(result.summary.receipt.identity.sender_thread_id, child.child_thread_id);
    assert_eq!(result.summary.receipt.identity.target_thread_id, "thread:parent");

    let read = |db: &Catalog, before, after| db.capture_message_feed(
        "thread:parent".into(), "branch:parent".into(), before, after, Some(1)
    ).unwrap().load(&|| false).unwrap();
    let page = read(&db, None, None);
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].message.summary.receipt, before);
    assert!(page.dispatches.is_empty());
    assert!(page.reports.is_empty());
    assert!(page.before.is_none());
    assert_eq!(page.participants.len(), 1);
    assert_eq!(page.participants[0].thread_id, "thread:parent");
    let delta = read(&db, None, Some(before.accepted_cursor));
    assert!(delta.messages.is_empty());
    assert!(delta.dispatches.is_empty());
    assert!(delta.reports.is_empty());
    assert!(delta.participants.is_empty());
    assert!(delta.after.is_none());

    let prepared = db.prepare_user_message("after-retrieval".into(), "thread:parent".into(), "branch:parent".into(),
        input("thread:parent", "branch:parent", "visible after retrieval")).unwrap().load().unwrap();
    let after = db.admit_message(prepared).unwrap().receipt;
    let page = read(&db, None, None);
    assert_eq!(page.messages[0].message.summary.receipt, after);
    let older = read(&db, page.before, None);
    assert_eq!(older.messages[0].message.summary.receipt, before);
    assert!(older.before.is_none());
    let delta = read(&db, None, Some(before.accepted_cursor));
    assert_eq!(delta.messages.len(), 1);
    assert_eq!(delta.messages[0].message.summary.receipt, after);
    assert!(delta.after.is_none());
    drop(db);
    drop(owner);
    std::fs::remove_dir_all(f.root).unwrap();
}
#[test]
fn idle_receipt_reply_routing_pagination_and_user_queue_are_one_immutable_fact() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    finished(&mut f, RunState::Completed);
    let head = f.db.head("branch:parent").unwrap();
    let first = parent_message(&mut f, "same", "first\n原始正文");
    assert_eq!(first, parent_message(&mut f, "same", "first\n原始正文"));
    assert!(f
        .db
        .prepare_user_message(
            "same".into(),
            child.child_thread_id.clone(),
            child.child_branch_id.clone(),
            input("thread:parent", "branch:parent", "different")
        )
        .unwrap()
        .load()
        .is_err());
    let p =
        f.db.capture_message("thread:parent", "branch:parent", &first.identity.message_id)
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(p.text, "first\n原始正文");
    assert_eq!(p.summary.state, InputState::Queued);
    assert!(p.summary.delivered_run_id.is_none());
    assert_eq!(f.db.head("branch:parent").unwrap(), head);
    assert_eq!(
        f.db.run(&f.context.run_id).unwrap().state,
        RunState::Completed
    );
    assert!(f
        .db
        .capture_queued_inputs("branch:parent")
        .unwrap()
        .is_empty());
    assert!(f
        .db
        .capture_queued_input(&first.identity.message_id)
        .is_err());
    assert!(f.db.cancel_input(&first.identity.message_id, 1).is_err());
    assert!(f
        .db
        .prepare_input_edit(&first.identity.message_id, 1, json!("tamper"))
        .is_err());
    let second = parent_message(&mut f, "second", "second");
    let page =
        f.db.capture_message_list(
            "thread:parent".into(),
            "branch:parent".into(),
            MessageDirection::Incoming,
            None,
            Some(1),
        )
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(page.messages[0].receipt, first);
    let third = parent_message(&mut f, "third", "third");
    let next =
        f.db.capture_message_list(
            "thread:parent".into(),
            "branch:parent".into(),
            MessageDirection::Incoming,
            page.next_cursor.clone(),
            Some(1),
        )
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(next.messages[0].receipt, second);
    assert!(next.next_cursor.is_none());
    assert!(f
        .db
        .capture_message_list(
            child.child_thread_id.clone(),
            child.child_branch_id.clone(),
            MessageDirection::Outgoing,
            page.next_cursor,
            Some(1)
        )
        .unwrap()
        .load(&|| false)
        .is_err());
    let mut reply = MessageInput {
        source_agent: None,
            name: None,
        wait: None,
        target_thread_id: None,
        target_branch_id: None,
        reply_to: Some(first.identity.message_id.clone()),
        kind: MessageKind::Inform,
        text: "answer".into(),
    };
    let result = send(
        &mut f,
        "reply",
        "thread:parent",
        "branch:parent",
        reply.clone(),
    );
    assert_eq!(result.identity.target_thread_id, child.child_thread_id);
    reply.target_branch_id = Some("branch:parent".into());
    assert!(f
        .db
        .prepare_user_message(
            "bad-reply".into(),
            "thread:parent".into(),
            "branch:parent".into(),
            reply
        )
        .is_err());
    f.db.create_thread("foreign", "foreign-branch").unwrap();
    assert!(f
        .db
        .prepare_user_message(
            "foreign".into(),
            "foreign".into(),
            "foreign-branch".into(),
            input("thread:parent", "branch:parent", "same cwd grants nothing")
        )
        .is_err());
    assert!(f
        .db
        .capture_message("foreign", "foreign-branch", &third.identity.message_id)
        .is_err());
    assert!(serde_json::from_value::<MessageInput>(
        json!({"kind":"inform","text":"x","wait":true})
    )
    .is_err());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn cancellation_and_late_delivery_preserve_pending_for_one_later_natural_run_and_gc() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let first = parent_message(&mut f, "pending", "原消息 survives cancellation");
    let head = f.db.head("branch:parent").unwrap();
    let delivery =
        f.db.prepare_input_delivery(&f.context.run_id, f.db.epoch(), head.as_deref())
            .unwrap()
            .load()
            .unwrap();
    f.db.request_cancel_run(&f.context.run_id).unwrap();
    assert!(f.db.admit_input_delivery(delivery).is_err());
    finished(&mut f, RunState::Cancelled);
    let old = f.context.run_id.clone();
    content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap();
    let root = f.root.clone();
    drop(f);
    let mut db = Catalog::open(&root).unwrap();
    assert_eq!(
        db.capture_message("thread:parent", "branch:parent", &first.identity.message_id)
            .unwrap()
            .load()
            .unwrap()
            .summary
            .state,
        InputState::Queued
    );
    let prepared = db
        .prepare_user_message(
            "pending".into(),
            child.child_thread_id,
            child.child_branch_id,
            input(
                "thread:parent",
                "branch:parent",
                "原消息 survives cancellation",
            ),
        )
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(db.admit_message(prepared).unwrap().receipt, first);
    let next = db
        .enqueue_input(&catalog::inputs::EnqueueInput {
            key: "natural-user".into(),
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
            mode: InputMode::Boundary,
            input: json!("new user work"),
            configuration: None,
        })
        .unwrap();
    assert_ne!(old, next.run_id);
    let prepared = db
        .prepare_input_delivery(&next.run_id, db.epoch(), Some(&next.input_id))
        .unwrap()
        .load()
        .unwrap();
    let batch = db.admit_input_delivery(prepared).unwrap().unwrap();
    assert!(!batch.activating);
    assert!(batch.input_ids.is_empty());
    assert_eq!(batch.items.len(), 1);
    assert!(matches!(
        batch.items[0].provenance,
        Provenance::UserInstruction { .. }
    ));
    let row = db
        .capture_message("thread:parent", "branch:parent", &first.identity.message_id)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(
        row.summary.delivered_run_id.as_deref(),
        Some(next.run_id.as_str())
    );
    assert_eq!(
        db.history("branch:parent").unwrap().last().unwrap().run_id,
        next.run_id
    );
    let prepared = db
        .prepare_input_delivery(&next.run_id, db.epoch(), Some(&first.identity.message_id))
        .unwrap()
        .load()
        .unwrap();
    assert!(db
        .admit_input_delivery(prepared)
        .unwrap()
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        db.execution_history("branch:parent")
            .unwrap()
            .last()
            .unwrap(),
        &batch.items[0]
    );
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    assert_eq!(
        db.capture_message("thread:parent", "branch:parent", &first.identity.message_id)
            .unwrap()
            .load()
            .unwrap()
            .text,
        "原消息 survives cancellation"
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn waiting_and_complete_boundaries_are_not_activated_by_an_inform() {
    let mut f = Fixture::new();
    f.accept();
    f.settle_exchange();
    let wait =
        f.db.register_wait("waiting", &f.context.run_id, "never", "event", 0)
            .unwrap();
    f.db.commit_execution(
        &f.context.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Waiting,
            waiting_on: Some(wait.id.clone()),
        },
    )
    .unwrap();
    let first = parent_message(&mut f, "silent", "progress");
    assert_eq!(
        f.db.run(&f.context.run_id).unwrap().waiting_on,
        Some(wait.id)
    );
    assert_eq!(f.db.reconcile_waits().unwrap(), 0);
    assert_eq!(
        f.db.run(&f.context.run_id).unwrap().state,
        RunState::Waiting
    );
    assert!(f
        .db
        .capture_message("thread:parent", "branch:parent", &first.identity.message_id)
        .unwrap()
        .load()
        .unwrap()
        .summary
        .delivered_run_id
        .is_none());
    f.db.request_cancel_run(&f.context.run_id).unwrap();
    finished(&mut f, RunState::Cancelled);
    assert_eq!(
        f.db.capture_message("thread:parent", "branch:parent", &first.identity.message_id)
            .unwrap()
            .load()
            .unwrap()
            .summary
            .state,
        InputState::Queued
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
struct InjectMessage {
    db: Arc<Mutex<Catalog>>,
    sender: String,
    branch: String,
    calls: AtomicUsize,
    interrupt: bool,
}
impl ModelProvider for InjectMessage {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: request.view.request_id.clone(),
                content: Content::Text {
                    text: "Final answer".into(),
                },
                opaque: None,
            },
        })
        .unwrap();
        let prepared = self
            .db
            .lock()
            .unwrap()
            .prepare_user_message(
                "boundary-progress".into(),
                self.sender.clone(),
                self.branch.clone(),
                input(
                    "thread:parent",
                    "branch:parent",
                    "ordinary progress at final boundary",
                ),
            )
            .unwrap()
            .load()
            .unwrap();
        self.db.lock().unwrap().admit_message(prepared).unwrap();
        if self.interrupt {
            cancel.cancel();
        }
        Ok(FinishReason::Stop)
    }
}
struct BoundaryPolicy {
    events: Arc<Mutex<Vec<PolicyEvent>>>,
}
impl AgentPolicy for BoundaryPolicy {
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
        state: &serde_json::Value,
        _: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        self.events.lock().unwrap().push(event.clone());
        let action = if matches!(event, PolicyEvent::Started) {
            PolicyAction::RequestModel
        } else {
            PolicyAction::Complete
        };
        Ok(PolicyDecision {
            action,
            state: state.clone(),
        })
    }
}
struct NoTools;
impl ToolExecutor for NoTools {
    fn plan(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        panic!("no new tools")
    }
    fn prepare(
        &self,
        _: &ToolCall,
        _: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        panic!("no new tools")
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        panic!("no new tools")
    }
    fn execute(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        panic!("no new tools")
    }
}
fn binding(f: &Fixture) -> RequestBinding {
    let launch =
        f.db.launch_intent(&f.context.run_id)
            .unwrap()
            .unwrap()
            .selection;
    RequestBinding { mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
        provider_id: None,
        tokenizer: None,
        request_context: None,
        child_dispatch: f
            .db
            .launch_metadata(&f.context.run_id)
            .unwrap()
            .unwrap()
            .dispatch_context_ref,
        goal: None,
        resource_activations: vec![],
        resource_checkpoint_id: None,
        connection_identity: launch.connection_identity,
        provider_family: launch.provider_family,
        model: launch.model,
        credential_ref: Some("credential-ref".into()),
        configuration_generation: launch.configuration_generation,
        tool_schema_generation: launch.tool_schema_generation,
        tools: launch.tools,
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: "branch:parent".into(),
            ancestor_id: None,
            leaf_id: f.db.head("branch:parent").unwrap(),
        },
    }
}
#[test]
fn real_engine_preserves_model_completed_and_interrupted_events_with_passive_batch() {
    for interrupt in [false, true] {
        let mut f = Fixture::new();
        let child = f.accept();
        f.settle_exchange();
        let binding = binding(&f);
        let initial =
            f.db.prepare_execution(
                &f.context.run_id,
                binding,
                PolicyIdentity {
                    name: "fixture".into(),
                    version: "1".into(),
                },
                json!({"preserved":7}),
            )
            .unwrap();
        let root = f.root.clone();
        let run = f.context.run_id.clone();
        let db = Arc::new(Mutex::new(f.db));
        let provider = Arc::new(InjectMessage {
            db: db.clone(),
            sender: child.child_thread_id,
            branch: child.child_branch_id,
            calls: AtomicUsize::new(0),
            interrupt,
        });
        let events = Arc::new(Mutex::new(vec![]));
        let report = ExecutionEngine {
            persistence: db.clone(),
            provider: provider.clone(),
            tools: Arc::new(NoTools),
            policy: Arc::new(BoundaryPolicy {
                events: events.clone(),
            }),
            context_preparation: Arc::new(NoopContextPreparation),
            progress: ProgressSink::default(),
        }
        .run(initial, CancellationToken::default())
        .unwrap();
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            1,
            "inform must not add a model request"
        );
        assert_eq!(
            report.state,
            if interrupt {
                RunState::Cancelled
            } else {
                RunState::Completed
            }
        );
        assert_eq!(report.policy_state, json!({"preserved":7}));
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .all(|event| !matches!(event, PolicyEvent::InputDelivered { .. })));
        let catalog = db.lock().unwrap();
        let page = catalog
            .capture_message_list(
                "thread:parent".into(),
                "branch:parent".into(),
                MessageDirection::Incoming,
                None,
                None,
            )
            .unwrap()
            .load(&|| false)
            .unwrap();
        assert_eq!(page.messages.len(), 1);
        assert_eq!(
            page.messages[0].delivered_run_id.as_deref(),
            Some(run.as_str())
        );
        assert_eq!(
            report.history.last(),
            catalog.execution_history("branch:parent").unwrap().last()
        );
        drop(catalog);
        drop(provider);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn idle_inform_does_not_block_an_already_authorized_goal_continuation() {
    use varin_runtime::catalog::{
        followups::ContinuationAdmission, goals::*, inputs::EnqueueInput,
    };
    let mut f = Fixture::new();
    f.accept();
    f.settle_exchange();
    finished(&mut f, RunState::Completed);
    let current =
        f.db.enqueue_input(&EnqueueInput {
            key: "goal-user-run".into(),
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
            mode: InputMode::Boundary,
            input: json!("explicit continuing work"),
            configuration: None,
        })
        .unwrap();
    f.db.commit_execution(
        &current.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    let goal =
        f.db.prepare_goal_start(
            "explicit-goal",
            &current.run_id,
            GoalScope {
                thread_id: "thread:parent".into(),
                branch_id: "branch:parent".into(),
            },
            "Continue the explicitly authorized objective".into(),
            None,
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_goal_mutation(goal).unwrap();
    let message = parent_message(&mut f, "pending-goal-inform", "does not block continuation");
    f.db.commit_execution(
        &current.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    let mut continuations = f.db.capture_followup_continuations().unwrap();
    assert_eq!(continuations.len(), 1);
    let ContinuationAdmission::Admitted(_) =
        f.db.admit_followup_continuation(continuations.pop().unwrap().load().unwrap())
            .unwrap()
    else {
        panic!("authorized continuation was blocked by passive information")
    };
    let candidate = f.db.capture_request_activations().unwrap().pop().unwrap();
    let varin_runtime::catalog::activation::RequestActivationAdmission::Bound(next) =
        f.db.admit_request_activation(candidate.load().unwrap())
            .unwrap()
    else {
        panic!("expected root admission")
    };
    assert_ne!(next, current.run_id);
    let prepared =
        f.db.prepare_input_delivery(
            &next,
            f.db.epoch(),
            f.db.head("branch:parent").unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    let batch = f.db.admit_input_delivery(prepared).unwrap().unwrap();
    assert!(!batch.activating);
    assert_eq!(batch.items.len(), 1);
    assert_eq!(batch.items[0].id, message.identity.message_id);
    assert_eq!(
        f.db.capture_message(
            "thread:parent",
            "branch:parent",
            &message.identity.message_id
        )
        .unwrap()
        .load()
        .unwrap()
        .summary
        .delivered_run_id,
        Some(next)
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn passive_delivery_before_and_after_reopen_preserves_the_original_pending_decision() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let binding = binding(&f);
    let policy = PolicyIdentity {
        name: "fixture".into(),
        version: "1".into(),
    };
    f.db.commit_execution(
        &f.context.run_id,
        f.db.epoch(),
        &ExecutionRecord::PolicyCheckpoint {
            identity: policy.clone(),
            previous_state: json!({"previous":1}),
            state: json!({"pending":2}),
            action: PolicyAction::Complete,
            event: PolicyEvent::ToolsCompleted { results: vec![] },
        },
    )
    .unwrap();
    let before = parent_message(&mut f, "before-crash", "retained before crash");
    let head = f.db.head("branch:parent").unwrap();
    let prepared =
        f.db.prepare_input_delivery(&f.context.run_id, f.db.epoch(), head.as_deref())
            .unwrap()
            .load()
            .unwrap();
    assert!(
        !f.db
            .admit_input_delivery(prepared)
            .unwrap()
            .unwrap()
            .activating
    );
    let root = f.root.clone();
    let run = f.context.run_id.clone();
    drop(f);
    let mut catalog = Catalog::open(&root).unwrap();
    let (initial, recovery) = catalog
        .prepare_recovered_execution(&run, binding, policy, serde_json::Value::Null)
        .unwrap();
    assert!(recovery.as_ref().unwrap().decision.is_some());
    assert!(matches!(
        recovery.as_ref().unwrap().event,
        PolicyEvent::ToolsCompleted { .. }
    ));
    let prepared = catalog
        .prepare_user_message(
            "after-crash".into(),
            child.child_thread_id.clone(),
            child.child_branch_id.clone(),
            input("thread:parent", "branch:parent", "retained after crash"),
        )
        .unwrap()
        .load()
        .unwrap();
    let after = catalog.admit_message(prepared).unwrap().receipt;
    let db = Arc::new(Mutex::new(catalog));
    let provider = Arc::new(InjectMessage {
        db: db.clone(),
        sender: child.child_thread_id,
        branch: child.child_branch_id,
        calls: AtomicUsize::new(0),
        interrupt: false,
    });
    let events = Arc::new(Mutex::new(vec![]));
    let report = ExecutionEngine {
        persistence: db.clone(),
        provider: provider.clone(),
        tools: Arc::new(NoTools),
        policy: Arc::new(BoundaryPolicy {
            events: events.clone(),
        }),
        context_preparation: Arc::new(NoopContextPreparation),
        progress: ProgressSink::default(),
    }
    .run_recovered(initial, CancellationToken::default(), recovery)
    .unwrap();
    assert_eq!(report.state, RunState::Completed);
    assert_eq!(report.policy_state, json!({"pending":2}));
    assert!(
        events.lock().unwrap().is_empty(),
        "inform must preserve the unconsumed decision"
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    for receipt in [before, after] {
        assert_eq!(
            db.lock()
                .unwrap()
                .capture_message(
                    "thread:parent",
                    "branch:parent",
                    &receipt.identity.message_id
                )
                .unwrap()
                .load()
                .unwrap()
                .summary
                .state,
            InputState::Delivered
        );
    }
    drop(provider);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
