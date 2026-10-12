use super::*;
use crate::catalog::bot::{BotGate, BotSuspension};
use crate::execution::*;
fn gate(revision: u64, permitted: bool) -> BotGate {
    BotGate {
        bot_id: "bot".into(),
        profile_revision: revision,
        activity_operation_id: Some("sleep".into()),
        permitted,
    }
}
fn suspension(revision: u64) -> BotSuspension {
    BotSuspension {
        bot_id: "bot".into(),
        profile_revision: revision,
        activity_operation_id: "sleep".into(),
    }
}
fn bot_submit(db: &mut Catalog) -> Receipt {
    db.publish_bot_gate(gate(1, true)).unwrap();
    db.create_bot_thread("thread", "main", "bot").unwrap();
    db.submit(&command()).unwrap()
}
#[test]
fn bot_gate_reopen_preserves_original_wait_trigger_and_revalidates_epoch() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = bot_submit(&mut db);
    let epoch = db.epoch();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    let wait = db
        .register_wait("question:original", &r.run_id, "source", "source.ready", 0)
        .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Waiting,
            waiting_on: Some(wait.id.clone()),
        },
    )
    .unwrap();
    db.publish_bot_gate(gate(2, false)).unwrap();
    db.suspend_bot_scope(suspension(2)).unwrap();
    db.park_bot_run(&r.run_id, epoch).unwrap();
    assert_eq!(record::<Wait>(&db.db, "waits", &wait.id).unwrap(), wait);
    let tx = db.db.transaction().unwrap();
    let trigger = event(&tx, "source", 1, "source.ready", Value::Null).unwrap();
    tx.commit().unwrap();
    db.reconcile_waits().unwrap();
    let fired = record::<Wait>(&db.db, "waits", &wait.id).unwrap();
    assert_eq!(fired.trigger_cursor, Some(trigger));
    assert!(!fired.cancelled);
    assert!(!db.run(&r.run_id).unwrap().cancel_requested);
    let cursor = db.event_cursor().unwrap();
    db.publish_bot_gate(gate(2, false)).unwrap();
    assert_eq!(db.event_cursor().unwrap(), cursor);
    drop(db);
    let mut db = f.open();
    assert_ne!(db.epoch(), epoch);
    assert!(!crate::catalog::bot::run_permitted(&db.db, &db.run(&r.run_id).unwrap()).unwrap());
    assert!(db.suspend_bot_scope(suspension(2)).is_err());
    db.publish_bot_gate(gate(2, false)).unwrap();
    assert_eq!(record::<Wait>(&db.db, "waits", &wait.id).unwrap(), fired);
    db.publish_bot_gate(gate(3, true)).unwrap();
    let resumed = db.resume_bot_scope(&suspension(3)).unwrap();
    assert_eq!(resumed.resumed_run_ids, vec![r.run_id.clone()]);
    assert_eq!(record::<Wait>(&db.db, "waits", &wait.id).unwrap(), fired);
    assert_eq!(db.pending_resumptions().unwrap(), vec![wait.id]);
}
#[test]
fn bot_suspend_preserves_prepared_candidate_until_original_recovery_closes_it() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = bot_submit(&mut db);
    let epoch = db.epoch();
    let snapshot = request_snapshot(&r);
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared {
            snapshot: snapshot.clone(),
        },
    )
    .unwrap();
    let before = db.model_step("model-1").unwrap();
    db.publish_bot_gate(gate(2, false)).unwrap();
    db.suspend_bot_scope(suspension(2)).unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::RequestNotDispatched {
            request_id: "model-1".into(),
            reason: NonDispatchReason::Suspended,
        },
    )
    .unwrap();
    db.park_bot_run(&r.run_id, epoch).unwrap();
    assert_eq!(db.model_step("model-1").unwrap(), before);
    assert!(!db.run(&r.run_id).unwrap().cancel_requested);
    db.publish_bot_gate(gate(3, true)).unwrap();
    db.resume_bot_scope(&suspension(3)).unwrap();
    let _ = db
        .prepare_recovered_execution(
            &r.run_id,
            snapshot.view.binding.clone(),
            DefaultAgentPolicy.identity(),
            Value::Null,
        )
        .unwrap();
    assert_eq!(
        db.model_step("model-1").unwrap().state,
        ModelStepState::NotDispatched
    );
    assert_eq!(db.model_step("model-1").unwrap().request, before.request);
    assert!(db
        .events_after(0, 100)
        .unwrap()
        .iter()
        .any(|e| e.kind == "model.not_dispatched" && e.data["reason"] == "recovery"));
}
#[test]
fn bot_readonly_invocation_needs_original_stop_evidence_and_late_refinement_is_idempotent() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = bot_submit(&mut db);
    let epoch = db.epoch();
    let snapshot = request_snapshot(&r);
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared { snapshot },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "model-1".into(),
        },
    )
    .unwrap();
    let call = ToolCall {
        call_id: "read".into(),
        name: "read".into(),
        schema_version: "1".into(),
        arguments: json!({}),
    };
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "model-1".into(),
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
    )
    .unwrap();
    let context = ToolExecutionContext {
        run_id: r.run_id.clone(),
        operation_id: "model-1:tool:read".into(),
        origin: ToolOrigin::ModelStep {
            request_id: "model-1".into(),
        },
    };
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call,
                contract: ToolContract {
                    name: "read".into(),
                    schema_version: "1".into(),
                    read_only: true,
                    completion: CompletionKind::Result,
                    lifetime: Lifetime::Run,
                    resources: vec![],
                },
            },
        },
    )
    .unwrap();
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: ExecutorOwner::External {
                identity: "original-reader".into(),
                epoch: "host-1".into(),
            },
        },
    )
    .unwrap();
    let completion = ToolCompletion::Result {
        outcome: Outcome::Succeeded,
        effect: Effect::None,
        content: json!("read bytes").into(),
    };
    db.commit_execution(
        &r.run_id,
        epoch,
        &ExecutionRecord::ToolSettled {
            context: context.clone(),
            completion: completion.clone(),
            executor_stopped: false,
        },
    )
    .unwrap();
    let (stops, effects, _) = db.bot_run_barriers(&r.run_id).unwrap();
    assert_eq!(stops, vec![context.operation_id.clone()]);
    assert!(effects.is_empty());
    let persistence = std::sync::Mutex::new(db);
    for _ in 0..2 {
        persistence
            .settle_tool(
                &context,
                epoch,
                ToolExecutionReceipt {
                    completion: completion.clone(),
                    executor_stopped: true,
                },
            )
            .unwrap();
    }
    let db = persistence.lock().unwrap();
    assert!(db.bot_run_barriers(&r.run_id).unwrap().0.is_empty());
    assert_eq!(
        db.events_after(0, 100)
            .unwrap()
            .iter()
            .filter(|e| e.subject == context.operation_id
                && e.kind == "operation.invocation_executor_stopped")
            .count(),
        1
    );
    assert_eq!(
        db.operation(&context.operation_id).unwrap().effect,
        Effect::None
    );
}

#[path = "../tests/fixtures/child_dispatch.rs"]
mod child_fixture;
#[test]
fn bot_child_source_publication_obeys_derived_parent_gate() {
    let mut f = child_fixture::Fixture::new_in_bot("bot");
    let child = f.accept();
    assert_eq!(
        f.db.bot_for_thread(&child.child_thread_id)
            .unwrap()
            .as_deref(),
        Some("bot")
    );
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal = crate::catalog::context::ContextProposal {
        key: "child-context".into(),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "original child".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis:crate::catalog::personalization::PersonalizationBasis=serde_json::from_value(json!({"mode":"bot","threadRole":"worker","revision":0,"configurationDigest":"original","memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":child.project_id,"originalSections":[{"name":"preamble","content":"original child"}],"instructionSources":[]})).unwrap();
    f.db.publish_bot_gate(gate(2, false)).unwrap();
    assert!(matches!(
        f.db.prepare_child(
            &child.operation_id,
            source.clone(),
            proposal.clone(),
            basis.clone()
        ),
        Err(RuntimeError::BotSuspended)
    ));
    assert!(f
        .db
        .child_task(&child.operation_id)
        .unwrap()
        .receipt
        .is_none());
    f.db.publish_bot_gate(gate(3, true)).unwrap();
    let published =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    assert!(f
        .db
        .bot_scope_run_ids("bot")
        .unwrap()
        .contains(&published.receipt.unwrap().run_id));
    let path = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn bot_wake_does_not_resume_original_manual_policy_pause() {
    let f = Fixture::new();
    let mut db = f.open();
    let r = bot_submit(&mut db);
    let epoch = db.epoch();
    let binding = request_snapshot(&r).view.binding;
    db.select_launch(
        &r.run_id,
        crate::catalog::launches::LaunchSelection::from_binding(
            &binding,
            DefaultAgentPolicy.identity(),
            None,
        ),
    )
    .unwrap();
    let boundary = db.policy_boundary(&r.run_id, epoch).unwrap();
    let intent = PolicyControlIntent {
        action_id: format!("{}:policy:{}", r.run_id, boundary.id),
        boundary,
        identity: DefaultAgentPolicy.identity(),
        state: json!({"original":"paused"}),
        expected_head: db.head("main").unwrap(),
        action: PolicyAction::Pause {
            reason: "User confirmation".into(),
        },
    };
    let prepared = db.prepare_policy_control().load(&intent).unwrap();
    let PolicyControlReceipt::Paused { wait_id, .. } = db
        .commit_policy_control(&r.run_id, epoch, prepared)
        .unwrap()
    else {
        panic!("expected original pause")
    };
    let pause = record::<Wait>(&db.db, "waits", &wait_id).unwrap();
    db.publish_bot_gate(gate(2, false)).unwrap();
    db.suspend_bot_scope(suspension(2)).unwrap();
    db.park_bot_run(&r.run_id, epoch).unwrap();
    db.publish_bot_gate(gate(3, true)).unwrap();
    db.resume_bot_scope(&suspension(3)).unwrap();
    assert_eq!(record::<Wait>(&db.db, "waits", &wait_id).unwrap(), pause);
    assert!(!db.run_startable(&r.run_id).unwrap());
    assert_eq!(
        db.run(&r.run_id).unwrap().waiting_on.as_deref(),
        Some(wait_id.as_str())
    );
}

#[test]
fn bot_history_uses_original_item_identity_and_rejects_cross_bot_or_unreachable_witnesses() {
    let f = Fixture::new(); let mut db = f.open(); let input = bot_submit(&mut db);
    db.fork_branch("main", "fork", Some(&input.input_id)).unwrap();
    let main = db.capture_bot_history("bot", "thread", "main", &input.input_id, &input.input_id).unwrap().load(&||false).unwrap();
    let fork = db.capture_bot_history("bot", "thread", "fork", &input.input_id, &input.input_id).unwrap().load(&||false).unwrap();
    assert_eq!(main, fork);
    assert!(db.capture_bot_history("other-bot", "thread", "main", &input.input_id, &input.input_id).is_err());
    assert!(db.capture_bot_history("bot", "thread", "fork", "unreachable-head", &input.input_id).unwrap().load(&||false).is_err());
}
#[test]
fn bot_scope_delete_retains_shared_history_atomically_then_removes_only_original_scope() {
    let f = Fixture::new(); let mut db = f.open(); let input = bot_submit(&mut db);
    db.create_thread("unrelated", "unrelated-main").unwrap();
    db.db.execute("UPDATE branches SET head=?1 WHERE id='unrelated-main'", [&input.input_id]).unwrap();
    db.publish_bot_gate(gate(2, false)).unwrap(); db.suspend_bot_scope(suspension(2)).unwrap();
    assert!(db.remove_bot_scope(&suspension(2)).unwrap_err().to_string().contains("retains"));
    assert_eq!(db.head("main").unwrap(), Some(input.input_id.clone()));
    db.db.execute("UPDATE branches SET head=NULL WHERE id='unrelated-main'", []).unwrap();
    db.remove_bot_scope(&suspension(2)).unwrap();
    assert!(db.inspect_thread("thread").is_err());
    assert!(db.run(&input.run_id).is_err());
    assert!(db.inspect_thread("unrelated").is_ok());
    db.remove_bot_scope(&suspension(2)).unwrap();
}
