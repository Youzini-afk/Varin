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
            snapshot: snapshot.clone().into(),
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
        &ExecutionRecord::RequestPrepared { snapshot: snapshot.into() },
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
    let basis:crate::catalog::personalization::PersonalizationBasis=serde_json::from_value(json!({"mode":"bot","threadRole":"worker","revision":0,"configurationDigest":"original","memorySnapshot":{"revision":0,"memories":[]},"threadId":child.child_thread_id,"projectId":child.project_id,"originalSections":[{"name":"preamble","content":"original child"}],"instructionSources":[]})).unwrap();
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
fn incremental_history_reads_only_the_selected_tail_and_identifies_a_rewound_boundary() {
    let fixture = Fixture::new(); let mut db = fixture.open(); let receipt = bot_submit(&mut db);
    let original = db.head("main").unwrap();
    let one = db.append_history(&receipt.run_id, db.epoch(), original.as_deref(), HistorySource::Assistant, json!("first"), None).unwrap();
    let two = db.append_history(&receipt.run_id, db.epoch(), Some(&one.id), HistorySource::Assistant, json!("second"), None).unwrap();
    let page = db.capture_history_page("main").unwrap().load_since(None, None, original.as_deref(), 1, &||false).unwrap();
    assert_eq!(page.items[0].id, two.id);
    let next = db.capture_history_page("main").unwrap().load_since(page.head.as_deref(), page.previous.as_deref(), original.as_deref(), 1, &||false).unwrap();
    assert_eq!(next.items[0].id, one.id);
    assert!(next.previous.is_none());
    assert!(db.capture_history_page("main").unwrap().load_since(None, None, Some(&two.id), 100, &||false).unwrap().items.is_empty());
    assert!(db.capture_history_page("main").unwrap().load_since(Some(&one.id), None, Some(&two.id), 100, &||false).unwrap().boundary_reset);
}

#[test]
fn bot_following_keeps_original_identity_and_separates_read_send_and_memory_grants() {
    use super::bot_work::{BotMatter, MatterThread, MatterUpdate};
    let fixture = Fixture::new(); let mut db = fixture.open(); bot_submit(&mut db);
    db.create_thread("ordinary", "ordinary-main").unwrap();
    let matter = BotMatter { id: "release".into(), revision: 0, title: "Release".into(), description: "Follow the original work".into(), archived: false,
        threads: vec![MatterThread { thread_id: "ordinary".into(), branch_id: "ordinary-main".into(), send: false, memory: false }] };
    let mut update = MatterUpdate { bot_id: "bot".into(), key: "follow".into(), expected_revision: 0, matter };
    let saved = db.update_bot_matter(update.clone(), None).unwrap();
    assert_eq!(saved, db.update_bot_matter(update.clone(), None).unwrap());
    assert_eq!(db.bot_for_thread("ordinary").unwrap(), None);
    assert!(super::bot_work::linked(&db.db,"thread","ordinary",Some("ordinary-main"),false,false).unwrap());
    assert!(!super::bot_work::linked(&db.db,"thread","ordinary",Some("ordinary-main"),true,false).unwrap());
    assert!(!super::bot_work::linked(&db.db,"thread","ordinary",Some("ordinary-main"),false,true).unwrap());
    let read = db.capture_family_read("thread",Some("ordinary"),Some("ordinary-main")).unwrap();
    update.key = "grant-send".into(); update.expected_revision = saved.revision; update.matter = saved;
    update.matter.threads[0].send = true;
    let saved = db.update_bot_matter(update.clone(),None).unwrap();
    assert!(super::bot_work::can_message(&db.db,"thread","main","ordinary","ordinary-main").unwrap());
    update.key = "unfollow".into(); update.expected_revision = saved.revision; update.matter = saved; update.matter.archived = true;
    db.update_bot_matter(update,None).unwrap();
    assert!(read.authorize(&||false).is_err());
    assert_eq!(db.bot_for_thread("ordinary").unwrap(),None);
}

#[test]
fn bot_forgotten_source_filters_unicode_and_attributed_work_updates_without_changing_originals() {
    use crate::execution::{Content, ConversationHistory, ConversationItem, Provenance};
    use sha2::{Digest,Sha256};
    let original = "Keep 🐾 this; forget this choice.";
    let revision = hex::encode(Sha256::digest(original.as_bytes()));
    let state: memory::MemoryState = serde_json::from_value(json!({"revision":1,"memories":[],"noteRevisions":{},"botKnowledge":{
        "botId":"bot","threadId":"thread","items":[],"corrections":[],"invalidations":[],"exclusions":[{"id":1,"scope":"bot","sources":[{
            "kind":"history-item","id":"source","revision":revision,"start":14,"end":33,"threadId":"ordinary","branchId":"ordinary-main","headId":"source"}]}]}})).unwrap();
    let mut history: ConversationHistory = vec![ConversationItem { resource_activation:None,id:"source".into(),provenance:Provenance::UserInstruction{input_id:"source".into()},content:Content::Text{text:original.into()},opaque:None }.into(),
        ConversationItem {resource_activation:None,id:"update".into(),provenance:Provenance::EnvironmentFact{event_id:"work".into()},opaque:None,
            content:Content::Output{output:crate::output::OutputBody{data:json!({"kind":"work_update","source":{"kind":"user_input","itemId":"source"}}),parts:vec![crate::output::OutputPart::Text{text:original.into()}]}}}.into()];
    let originals = history.clone();
    super::memory_exclusion::filter(Some(&state),&mut history).unwrap();
    assert_eq!(originals[0].content,Content::Text{text:original.into()});
    assert!(!serde_json::to_string(&history).unwrap().contains("forget this choice"));
    assert!(serde_json::to_string(&history).unwrap().contains("🐾"));
}

#[test]
fn bot_cold_followed_work_survives_reopen_and_admits_original_environment_input_once() {
    use super::bot_work::{BotMatter,MatterThread,MatterUpdate};
    let fixture = Fixture::new(); let mut db = fixture.open();
    db.publish_bot_gate(gate(1,true)).unwrap();
    db.create_bot_thread("thread","main","bot").unwrap();
    db.create_thread("ordinary","ordinary-main").unwrap();
    db.update_bot_matter(MatterUpdate { bot_id:"bot".into(),key:"follow".into(),expected_revision:0,
        matter:BotMatter{id:"work".into(),revision:0,title:"Original work".into(),description:String::new(),archived:false,
        threads:vec![MatterThread{thread_id:"ordinary".into(),branch_id:"ordinary-main".into(),send:false,memory:false}]}},None).unwrap();
    let mut user = command(); user.thread_id="ordinary".into(); user.branch_id="ordinary-main".into(); user.key="work-user".into(); user.input=json!("The user corrected the original task.");
    db.submit(&user).unwrap();
    let owner=std::sync::Mutex::new(db);
    super::bot_work_events::deliver(&owner).unwrap();
    super::bot_work_events::deliver(&owner).unwrap();
    let db=owner.into_inner().unwrap();
    let count:u64=db.db.query_row("SELECT count(*) FROM input_queue WHERE origin='work_event'",[],|r|read_number(r,0)).unwrap();
    assert_eq!(count,2);
    drop(db);
    let mut db=fixture.open(); db.publish_bot_gate(gate(1,true)).unwrap();
    let pending=db.pending_cold_bot_work().unwrap(); assert_eq!(pending.len(),1);
    let work=pending[0].clone();
    let proposal=context::ContextProposal{key:"bot-initial".into(),branch_id:"main".into(),through_id:None,expected_revision:0,summary:String::new(),effective_system_prompt:"Long-term assistant".into(),instruction_sources:vec![],memory_checkpoint:None};
    let basis:personalization::PersonalizationBasis=serde_json::from_value(json!({"mode":"bot","threadRole":"main","revision":0,"configurationDigest":"original","memorySnapshot":{"revision":0,"memories":[]},"threadId":"thread","projectId":null,"originalSections":[{"name":"preamble","content":"Long-term assistant"}],"instructionSources":[]})).unwrap();
    let preparation=db.prepare_cold_bot_work(work.clone(),command().configuration,proposal,basis,None).unwrap();
    let fake_receipt=Receipt{thread_id:"thread".into(),branch_id:"main".into(),run_id:"unused".into(),input_id:"unused".into(),cursor:0};
    let launch=launches::LaunchSelection::from_binding(&request_snapshot(&fake_receipt).view.binding,DefaultAgentPolicy.identity(),None);
    let prepared=preparation.load(launch).unwrap();
    let admitted=db.admit_cold_bot_work(prepared).unwrap();
    assert_eq!(db.run(&admitted.run_id).unwrap().thread_id,"thread");
    assert!(db.history("main").unwrap().iter().all(|item|item.source==HistorySource::Environment));
    assert!(db.pending_cold_bot_work().unwrap().is_empty());
    assert_eq!(db.inspect_thread("thread").unwrap()["unread"],false);
    assert_eq!(db.bot_for_thread("ordinary").unwrap(),None);
    // Admission binds later pending changes to this Run; the normal request boundary delivers them.
    let delivery=db.prepare_input_delivery(&admitted.run_id,db.epoch(),db.head("main").unwrap().as_deref()).unwrap().load().unwrap();
    db.admit_input_delivery(delivery).unwrap().unwrap();
    let queued:bool=db.db.query_row("SELECT EXISTS(SELECT 1 FROM input_queue WHERE branch_id='main' AND state='queued')",[],|row|row.get(0)).unwrap();
    assert!(!queued);
    assert!(serde_json::to_string(&db.history("main").unwrap()).unwrap().contains("The user corrected the original task."));
    assert_eq!(db.cold_bot_work_receipt(&work.input_id).unwrap(),Some(admitted));
}

#[test]
fn bot_selective_background_keeps_only_chosen_originals_without_reparenting_or_changing_sources() {
    let fixture=Fixture::new(); let mut db=fixture.open(); let receipt=bot_submit(&mut db);
    let unselected=db.append_history(&receipt.run_id,db.epoch(),Some(&receipt.input_id),HistorySource::Assistant,json!({"id":"unselected","provenance":{"kind":"assistant"},"content":{"kind":"text","text":"An old conclusion that should not be inherited."},"opaque":null}),None).unwrap();
    let selected=db.append_history(&receipt.run_id,db.epoch(),Some(&unselected.id),HistorySource::Assistant,json!({"id":"selected","provenance":{"kind":"assistant"},"content":{"kind":"text","text":"The measured result: 42."},"opaque":null}),None).unwrap();
    let source=db.run(&receipt.run_id).unwrap();
    let background=super::background::load(&db.db,&db.content,&source,&[super::background::BackgroundReference {
        thread_id:"thread".into(),branch_id:"main".into(),head_id:selected.id.clone(),item_ids:vec![selected.id.clone()]}]).unwrap();
    let text=serde_json::to_string(&background).unwrap();
    assert!(text.contains("The measured result: 42.")); assert!(!text.contains("old conclusion")); assert!(!text.contains("hello"));
    assert_eq!(db.run(&receipt.run_id).unwrap(),source);
    assert!(super::background::load(&db.db,&db.content,&source,&[super::background::BackgroundReference {
        thread_id:"thread".into(),branch_id:"main".into(),head_id:unselected.id,item_ids:vec![selected.id]}]).is_err());
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

#[test]
fn bot_session_input_stays_in_its_own_session_and_scope_lists_sessions_in_order() {
    let fixture = Fixture::new();
    let mut db = fixture.open();
    db.publish_bot_gate(gate(1, true)).unwrap();
    db.create_bot_thread("thread", "main", "bot").unwrap();
    db.create_bot_thread("second", "second-main", "bot").unwrap();
    let mut user = command();
    user.thread_id = "second".into();
    user.branch_id = "second-main".into();
    user.key = "second-user".into();
    db.submit(&user).unwrap();
    let owner = std::sync::Mutex::new(db);
    super::bot_work_events::deliver(&owner).unwrap();
    let db = owner.into_inner().unwrap();
    // The second session already holds its own user input; the primary must not receive a copy.
    let copied: u64 = db
        .db
        .query_row("SELECT count(*) FROM input_queue WHERE origin='work_event'", [], |r| read_number(r, 0))
        .unwrap();
    assert_eq!(copied, 0);
    let scope = db.inspect_bot_scope_for("bot", true).unwrap();
    assert_eq!(scope["sessions"], json!(["thread", "second"]));
    let owner = super::bot::thread_owner(&db.db, "second").unwrap().unwrap();
    assert_eq!(owner.bot_id, "bot");
    assert_eq!(owner.session_thread_id.as_deref(), Some("second"));
    assert_eq!(db.bot_for_thread("second").unwrap().as_deref(), Some("bot"));
}

#[test]
fn bot_activity_shows_a_followed_change_and_the_background_round_that_stayed_quiet() {
    use super::bot_work::{BotMatter, MatterThread, MatterUpdate};
    let fixture = Fixture::new();
    let mut db = fixture.open();
    db.publish_bot_gate(gate(1, true)).unwrap();
    db.create_bot_thread("thread", "main", "bot").unwrap();
    db.create_thread("ordinary", "ordinary-main").unwrap();
    db.update_bot_matter(MatterUpdate { bot_id: "bot".into(), key: "follow".into(), expected_revision: 0,
        matter: BotMatter { id: "work".into(), revision: 0, title: "Original work".into(), description: String::new(), archived: false,
            threads: vec![MatterThread { thread_id: "ordinary".into(), branch_id: "ordinary-main".into(), send: false, memory: false }] } }, None).unwrap();
    let mut user = command();
    user.thread_id = "ordinary".into();
    user.branch_id = "ordinary-main".into();
    user.key = "work-user".into();
    user.input = json!("The user corrected the original task.");
    db.submit(&user).unwrap();
    let owner = std::sync::Mutex::new(db);
    super::bot_work_events::deliver(&owner).unwrap();
    let mut db = owner.into_inner().unwrap();
    let work = db.pending_cold_bot_work().unwrap().remove(0);
    let proposal = context::ContextProposal { key: "bot-initial".into(), branch_id: "main".into(), through_id: None, expected_revision: 0, summary: String::new(),
        effective_system_prompt: "Long-term assistant".into(), instruction_sources: vec![], memory_checkpoint: None };
    let basis: personalization::PersonalizationBasis = serde_json::from_value(json!({"mode":"bot","threadRole":"main","revision":0,"configurationDigest":"original","memorySnapshot":{"revision":0,"memories":[]},"threadId":"thread","projectId":null,"originalSections":[{"name":"preamble","content":"Long-term assistant"}],"instructionSources":[]})).unwrap();
    let preparation = db.prepare_cold_bot_work(work, command().configuration, proposal, basis, None).unwrap();
    let receipt = Receipt { thread_id: "thread".into(), branch_id: "main".into(), run_id: "unused".into(), input_id: "unused".into(), cursor: 0 };
    let launch = launches::LaunchSelection::from_binding(&request_snapshot(&receipt).view.binding, DefaultAgentPolicy.identity(), None);
    let admitted = db.admit_cold_bot_work(preparation.load(launch).unwrap()).unwrap();
    let delivery = db.prepare_input_delivery(&admitted.run_id, db.epoch(), db.head("main").unwrap().as_deref()).unwrap().load().unwrap();
    db.admit_input_delivery(delivery).unwrap().unwrap();
    let epoch = db.epoch();
    for state in [RunState::Runnable, RunState::Completed] {
        db.commit_execution(&admitted.run_id, epoch, &ExecutionRecord::StateChanged { state, waiting_on: None }).unwrap();
    }
    let page = serde_json::to_value(db.capture_bot_activity("bot", None, None).unwrap().load(&|| false).unwrap()).unwrap();
    let events = page["events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "{page}");
    // The round ended without assistant output, so the user was not interrupted.
    assert_eq!(events[0]["kind"], "quiet");
    assert_eq!(events[0]["runId"], json!(admitted.run_id));
    assert_eq!(events[0]["sessionThreadId"], "thread");
    assert!(events[0]["atMs"].as_u64().is_some());
    assert!(events[0]["inputs"].as_array().unwrap().iter()
        .any(|input| input["origin"] == "work_event" && input["threadId"] == "ordinary" && input["change"] == "user_input"));
    assert_eq!(events[1]["kind"], "change");
    assert_eq!(events[1]["change"], "user_input");
    assert_eq!(events[1]["threadId"], "ordinary");
    assert_eq!(events[1]["sessionThreadId"], "thread");
    assert!(events[1]["atMs"].as_u64().is_some());
    assert!(page["participants"].as_array().unwrap().iter().any(|p| p["threadId"] == "ordinary"));
}

#[test]
fn bot_activity_leaves_out_user_rounds_and_rejects_unknown_bots() {
    let fixture = Fixture::new();
    let mut db = fixture.open();
    let receipt = bot_submit(&mut db);
    let epoch = db.epoch();
    for state in [RunState::Runnable, RunState::Completed] {
        db.commit_execution(&receipt.run_id, epoch, &ExecutionRecord::StateChanged { state, waiting_on: None }).unwrap();
    }
    let page = db.capture_bot_activity("bot", None, None).unwrap().load(&|| false).unwrap();
    assert!(page.events.is_empty());
    assert!(page.before.is_none());
    assert!(db.capture_bot_activity("other-bot", None, None).is_err());
    assert!(db.capture_bot_activity("bot", None, Some(0)).is_err());
}
