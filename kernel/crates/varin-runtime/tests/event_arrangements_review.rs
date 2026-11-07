use rusqlite::Connection;
use serde_json::json;
use uuid::Uuid;
use varin_runtime::catalog::{
    bot::BotGate,
    followups::*,
    inputs::{self, InputOrigin, QueuedInputMetadata},
};
use varin_runtime::{Catalog, FollowupControlAction, RuntimeError, SubmitInput};
#[path = "fixtures/child_dispatch.rs"]
mod child_dispatch;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
#[allow(dead_code)]
#[path = "fixtures/computer_requests.rs"]
mod tool_invocations;
use input_admission::InputAdmission;
type Result<T> = std::result::Result<T, RuntimeError>;
fn record<T: serde::de::DeserializeOwned>(db: &Connection, table: &str, id: &str) -> Result<T> {
    let raw: String = db.query_row(
        &format!("SELECT body FROM {table} WHERE id=?1"),
        [id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&raw)?)
}

struct Fixture {
    root: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        Self {
            root: std::env::temp_dir().join(format!("varin-plugin-events-{}", Uuid::new_v4())),
        }
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.root).unwrap()
    }
    fn raw(&self) -> Connection {
        Connection::open(self.root.join("conversation.sqlite")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn gate(db: &mut Catalog, permitted: bool, revision: u64) {
    db.publish_bot_gate(BotGate {
        bot_id: "bot".into(),
        profile_revision: revision,
        activity_operation_id: None,
        permitted,
    })
    .unwrap();
}
fn setup(db: &mut Catalog) {
    gate(db, true, 1);
    db.create_bot_thread("chat", "main", "bot").unwrap();
}
fn source() -> PluginEventSource {
    PluginEventSource {
        host: None,
        extension_id: "mail".into(),
        source_id: "new-message".into(),
        connection_id: "account-connection".into(),
        account_id: "stable-account".into(),
    }
}
fn input(id: &str, timing: EventTiming) -> ArrangementInput {
    ArrangementInput {
        key: id.into(),
        expected_revision: None,
        bot_id: "bot".into(),
        thread_id: "chat".into(),
        branch_id: "main".into(),
        name: format!("Watch {id}"),
        instruction: "Read new replies and investigate meaningful issues".into(),
        source: source(),
        filter: json!({"label":"important"}),
        timing,
        repeat: FollowupRepeat::Each,
        first_contact: None,
        source_run_id: None,
        external_conversation_id: None,
    }
}
fn arrange(db: &mut Catalog, id: &str, timing: EventTiming) -> Followup {
    let p = db
        .prepare_arrangement(input(id, timing))
        .unwrap()
        .load()
        .unwrap();
    db.admit_arrangement(p).unwrap()
}
fn incoming(id: &str, revision: Option<&str>) -> PluginEventInput {
    PluginEventInput {
        event_id: id.into(),
        object_id: Some("mail-thread".into()),
        sender_id: None,
        revision: revision.map(str::to_owned),
        occurred_at_ms: 10,
        attributes: json!({"label":"important","sender":"customer"}),
        content: varin_runtime::output::OutputBody::text(format!("Original message {id}")),
        files: vec![],
        echo_of: None,
        state: None,
    }
}
fn receive_input(
    events: Vec<PluginEventInput>,
    before: Option<&str>,
    after: Option<&str>,
) -> EventReceiveInput {
    EventReceiveInput {
        identity: EventSourceIdentity {
            principal_id: None,
            source: source(),
        },
        expected_cursor: before.map(str::to_owned),
        next_cursor: after.map(str::to_owned),
        status: None,
        events,
    }
}
fn receive(
    db: &mut Catalog,
    events: Vec<PluginEventInput>,
    before: Option<&str>,
    after: Option<&str>,
) -> Result<EventReceiveReceipt> {
    let p = db
        .prepare_event_receive(receive_input(events, before, after))?
        .load()?;
    db.admit_event_receive(p)
}
fn deliver(db: &mut Catalog) -> Vec<String> {
    db.capture_followup_continuations()
        .unwrap()
        .into_iter()
        .map(
            |p| match db.admit_followup_continuation(p.load().unwrap()).unwrap() {
                ContinuationAdmission::Admitted(id) => id,
                _ => panic!("unexpected hold"),
            },
        )
        .collect()
}

fn consume_events(db: &mut Catalog, run: &str) -> varin_runtime::execution::InputBatch {
    let prepared = db.prepare_input_delivery(run, db.epoch(), db.head("main").unwrap().as_deref()).unwrap().load().unwrap();
    db.admit_input_delivery(prepared).unwrap().unwrap()
}
fn start_event_run(db: &mut Catalog) -> varin_runtime::Receipt {
    db.submit(&SubmitInput { key: "active".into(), thread_id: "chat".into(), branch_id: "main".into(),
        expected_head: None, input: json!("Watch the work"), configuration: json!({}) }).unwrap()
}
fn state_event(id: &str, sequence: u64, value: &str) -> PluginEventInput {
    let mut event = incoming(id, None);
    event.state = Some(EventState { key: "build".into(), sequence, value: value.into() });
    event
}
#[test]
fn event_delivery_shares_bodies_preserves_intents_and_orders_replaceable_states() {
    let f = Fixture::new(); let mut db = f.open(); setup(&mut db);
    let run = start_event_run(&mut db);
    for (key, intent) in [("watch", "Investigate failures"), ("summary", "Prepare the status digest")] {
        let mut draft = input(key, EventTiming::Immediate); draft.instruction = intent.into();
        let p = db.prepare_arrangement(draft).unwrap().load().unwrap(); db.admit_arrangement(p).unwrap();
    }
    receive(&mut db, vec![state_event("recovered", 3, "healthy"), state_event("failed", 1, "failed"),
        state_event("still-failed", 2, "failed"), incoming("mail-one", None), incoming("mail-two", None)], None, Some("a")).unwrap();
    let ids = deliver(&mut db); assert_eq!(ids.len(), 2);
    let batch = consume_events(&mut db, &run.run_id);
    let text = serde_json::to_string(&batch.items).unwrap();
    for needle in ["Original message recovered", "Original message mail-one", "Original message mail-two"] {
        assert_eq!(text.matches(needle).count(), 1, "{text}");
    }
    assert!(!text.contains("Original message failed"));
    assert!(!text.contains("Original message still-failed"));
    assert!(text.contains("Investigate failures") && text.contains("Prepare the status digest"));
    let changes: Vec<_> = batch.items.iter().filter_map(|item| match &item.content {
        varin_runtime::execution::Content::Output { output } => output.data["events"].as_array()
            .and_then(|events| events.iter().find_map(|e| e.get("stateChanges"))).cloned(), _ => None,
    }).collect();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0][0]["value"], "failed"); assert_eq!(changes[0][1]["value"], "healthy");
    let occurrence = db.followup_occurrences("watch", None).unwrap().occurrences.remove(0);
    db.reconcile_followup_facts_at(u64::MAX / 2).unwrap();
    db.prepare_content_collection(Default::default()).run();
    let originals = db.capture_followup_occurrence("watch", &occurrence.id).unwrap().load().unwrap();
    assert_eq!(originals.events.len(), 5);
    assert!(serde_json::to_string(&originals.events).unwrap().contains("Original message failed"));
    let history = serde_json::to_value(db.history("main").unwrap()).unwrap();
    drop(db); let mut db = f.open();
    assert_eq!(serde_json::to_value(db.history("main").unwrap()).unwrap(), history);
    assert!(consume_events(&mut db, &run.run_id).items.is_empty());
}

#[test]
fn coalescing_rechecks_each_arrangement_before_delivery_and_rebuilds_after_cancellation() {
    let f = Fixture::new(); let mut db = f.open(); setup(&mut db);
    let run = start_event_run(&mut db);
    arrange(&mut db, "first", EventTiming::Immediate); arrange(&mut db, "second", EventTiming::Immediate);
    receive(&mut db, vec![incoming("shared", None)], None, Some("a")).unwrap(); deliver(&mut db);
    let prepared = db.prepare_input_delivery(&run.run_id, db.epoch(), db.head("main").unwrap().as_deref()).unwrap().load().unwrap();
    db.control_followup("first", 1, FollowupControlAction::Cancel).unwrap();
    assert!(db.admit_input_delivery(prepared).unwrap().is_none());
    let batch = consume_events(&mut db, &run.run_id);
    assert_eq!(batch.items.len(), 1);
    assert!(serde_json::to_string(&batch.items).unwrap().contains("Original message shared"));
}

#[test]
fn passive_state_batches_coalesce_across_pause_when_intent_is_unchanged() {
    let f = Fixture::new(); let mut db = f.open(); setup(&mut db);
    let run = start_event_run(&mut db);
    arrange(&mut db, "watch", EventTiming::Passive);
    receive(&mut db, vec![state_event("failed", 1, "failed")], None, Some("a")).unwrap(); deliver(&mut db);
    db.control_followup("watch", 1, FollowupControlAction::Pause).unwrap();
    let revision = db.followup("watch").unwrap().revision;
    db.control_followup("watch", revision, FollowupControlAction::Resume).unwrap();
    receive(&mut db, vec![state_event("recovered", 2, "healthy")], Some("a"), Some("b")).unwrap(); deliver(&mut db);
    let batch = consume_events(&mut db, &run.run_id);
    let text = serde_json::to_string(&batch.items).unwrap();
    assert!(!text.contains("Original message failed"));
    assert_eq!(text.matches("Original message recovered").count(), 1);
}

#[test]
fn cold_bot_coalesces_its_original_wake_with_the_first_ready_event_batch() {
    use varin_runtime::catalog::{context, launches, personalization};
    use varin_runtime::execution::{AgentPolicy, DefaultAgentPolicy};
    let f = Fixture::new(); let mut db = f.open(); setup(&mut db);
    arrange(&mut db, "first", EventTiming::Immediate); arrange(&mut db, "second", EventTiming::Immediate);
    receive(&mut db, vec![incoming("shared", None)], None, Some("a")).unwrap(); deliver(&mut db);
    let work = db.pending_cold_bot_work().unwrap().remove(0);
    let initial = context::ContextProposal { key: "initial".into(), branch_id: "main".into(), through_id: None,
        expected_revision: 0, summary: String::new(), effective_system_prompt: "Assistant".into(), instruction_sources: vec![], memory_checkpoint: None };
    let basis: personalization::PersonalizationBasis = serde_json::from_value(json!({"mode":"bot","threadRole":"main","revision":0,
        "configurationDigest":"original","memorySnapshot":{"revision":0,"memories":[]},"threadId":"chat","projectId":null,
        "originalSections":[{"name":"preamble","content":"Assistant"}],"instructionSources":[]})).unwrap();
    let launch: launches::LaunchSelection = serde_json::from_value(json!({"connection_identity":"fixture","provider_family":"test","model":"mock",
        "configuration_generation":1,"tool_schema_generation":1,"tools":[],"extension_bindings":[],"policy":DefaultAgentPolicy.identity()})).unwrap();
    let prepared = db.prepare_cold_bot_work(work, json!({}), initial, basis, None).unwrap().load(launch).unwrap();
    let run = db.admit_cold_bot_work(prepared).unwrap();
    let batch = consume_events(&mut db, &run.run_id);
    assert_eq!(batch.replacements.len(), 1); assert_eq!(batch.items.len(), 1);
    let history = serde_json::to_string(&db.history("main").unwrap()).unwrap();
    assert_eq!(history.matches("Original message shared").count(), 1);
    assert!(consume_events(&mut db, &run.run_id).replacements.is_empty());
}

#[test]
fn cold_bot_receives_fixed_batches_without_a_source_run_and_deduplicates_after_reopen() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    let d = arrange(&mut db, "inbox", EventTiming::Immediate);
    assert!(d.source_run_id.is_none());
    assert_eq!(
        d.owner,
        FollowupOwner::Bot {
            bot_id: "bot".into()
        }
    );
    let one = incoming("one", None);
    assert_eq!(
        receive(&mut db, vec![one.clone(), one.clone()], None, Some("a"))
            .unwrap()
            .accepted,
        1
    );
    assert_eq!(
        receive(&mut db, vec![one.clone()], None, Some("a"))
            .unwrap()
            .duplicates,
        1
    );
    let frozen = db.capture_followup_continuations().unwrap();
    assert_eq!(frozen.len(), 1);
    receive(&mut db, vec![incoming("two", None)], Some("a"), Some("b")).unwrap();
    let prepared = frozen.into_iter().next().unwrap().load().unwrap();
    db.admit_followup_continuation(prepared).unwrap();
    assert_eq!(db.followup("inbox").unwrap().pending_events, 1);
    let work = db.pending_cold_bot_work().unwrap();
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].thread_id, "chat");
    let occurrences = db.followup_occurrences("inbox", None).unwrap().occurrences;
    assert!(
        matches!(&occurrences[0].evidence,TriggerEvidence::PluginEvents {event_ids,..} if event_ids.len()==1)
    );
    drop(db);
    let mut db = f.open();
    gate(&mut db, true, 1);
    assert_eq!(
        receive(&mut db, vec![incoming("two", None)], Some("a"), Some("b"))
            .unwrap()
            .duplicates,
        1
    );
    assert_eq!(deliver(&mut db).len(), 1);
    assert_eq!(
        db.followup_occurrences("inbox", None)
            .unwrap()
            .occurrences
            .len(),
        2
    );
    assert_eq!(
        receive(
            &mut db,
            vec![incoming("one", Some("edited"))],
            Some("b"),
            Some("c")
        )
        .unwrap()
        .accepted,
        1
    );
}
#[test]
fn receipt_transaction_never_advances_cursor_for_stale_or_changed_event_identity() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "inbox", EventTiming::Immediate);
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    assert!(receive(&mut db, vec![incoming("new", None)], None, Some("b")).is_err());
    let mut changed = incoming("one", None);
    changed.content = varin_runtime::output::OutputBody::text("changed without revision");
    assert!(receive(
        &mut db,
        vec![incoming("new", None), changed],
        Some("a"),
        Some("b")
    )
    .is_err());
    assert_eq!(
        db.event_source_checkpoint(&EventSourceIdentity {
            principal_id: None,
            source: source()
        })
        .unwrap()
        .cursor
        .as_deref(),
        Some("a")
    );
    assert_eq!(
        f.raw()
            .query_row("SELECT count(*) FROM followup_events", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let cursor = db.event_cursor().unwrap();
    receive(&mut db, vec![], Some("a"), Some("a")).unwrap();
    assert_eq!(db.event_cursor().unwrap(), cursor);
}
#[test]
fn pause_keeps_its_own_matching_watermark_while_shared_source_advances() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "a", EventTiming::Immediate);
    let b = arrange(&mut db, "b", EventTiming::Immediate);
    db.control_followup("b", b.revision, FollowupControlAction::Pause)
        .unwrap();
    receive(
        &mut db,
        vec![incoming("during-pause", None)],
        None,
        Some("1"),
    )
    .unwrap();
    deliver(&mut db);
    assert_eq!(db.followup("b").unwrap().pending_events, 0);
    assert!(f
        .raw()
        .query_row(
            "SELECT content_ref IS NOT NULL FROM followup_events",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    let b = db.followup("b").unwrap();
    db.control_followup("b", b.revision, FollowupControlAction::Resume)
        .unwrap();
    assert_eq!(deliver(&mut db).len(), 1);
    assert_eq!(
        db.followup_occurrences("b", None)
            .unwrap()
            .occurrences
            .len(),
        1
    );
    assert_eq!(
        f.raw()
            .query_row("SELECT count(*) FROM followup_events", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn batch_deadline_is_anchored_to_first_event_and_new_events_do_not_move_it() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "batched", EventTiming::Batch { window_ms: 60_000 });
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    let deadline = db.nearest_followup_deadline().unwrap().unwrap();
    receive(&mut db, vec![incoming("two", None)], Some("a"), Some("b")).unwrap();
    assert_eq!(db.nearest_followup_deadline().unwrap(), Some(deadline));
    db.reconcile_followup_facts_at(deadline - 1).unwrap();
    assert!(db.followup("batched").unwrap().occurrence.is_none());
    db.reconcile_followup_facts_at(deadline).unwrap();
    let occurrence = db.followup("batched").unwrap().occurrence.unwrap();
    assert!(
        matches!(occurrence.evidence,TriggerEvidence::PluginEvents {event_ids,..} if event_ids.len()==2)
    );
    assert_eq!(db.nearest_followup_deadline().unwrap(), None);
}
#[test]
fn passive_ingress_does_not_wake_until_process_now_promotes_the_same_input() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "passive", EventTiming::Passive);
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    let ids = deliver(&mut db);
    assert_eq!(ids.len(), 1);
    assert!(db.pending_cold_bot_work().unwrap().is_empty());
    let row: QueuedInputMetadata = record(&f.raw(), "input_queue", &ids[0]).unwrap();
    assert_eq!(row.activation, inputs::InputActivation::Passive);
    let d = db.followup("passive").unwrap();
    db.control_event_backlog(EventBacklogInput {
        followup_id: d.id,
        expected_revision: d.revision,
        action: EventBacklogAction::ProcessNow,
    })
    .unwrap();
    assert_eq!(db.pending_cold_bot_work().unwrap()[0].input_id, ids[0]);
}
#[test]
fn sleeping_bot_still_receives_and_cancelled_batch_does_not_reopen() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "inbox", EventTiming::Immediate);
    gate(&mut db, false, 2);
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    assert!(db.capture_followup_continuations().unwrap().is_empty());
    assert_eq!(
        db.followup("inbox")
            .unwrap()
            .occurrence
            .unwrap()
            .hold_reason,
        Some(HoldReason::BotSuspended)
    );
    gate(&mut db, true, 3);
    let _ids = deliver(&mut db);
    let d = db.followup("inbox").unwrap();
    db.control_event_backlog(EventBacklogInput {
        followup_id: d.id,
        expected_revision: d.revision,
        action: EventBacklogAction::Discard,
    })
    .unwrap();
    assert!(deliver(&mut db).is_empty());
    assert_eq!(db.followup("inbox").unwrap().state, FollowupState::Active);
    let mut recent = incoming("two", None);
    recent.occurred_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    receive(&mut db, vec![recent], Some("a"), Some("b")).unwrap();
    assert_eq!(deliver(&mut db).len(), 1);
}

#[test]
fn changing_timing_replans_unconsumed_events_before_the_next_delivery() {
    for (original, updated, passive) in [
        (EventTiming::Passive, EventTiming::Immediate, false),
        (EventTiming::Immediate, EventTiming::Passive, true),
    ] {
        let f = Fixture::new();
        let mut db = f.open();
        setup(&mut db);
        arrange(&mut db, "inbox", original);
        receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
        let old = deliver(&mut db);
        let mut edited = input("inbox", updated);
        edited.expected_revision = Some(db.followup("inbox").unwrap().revision);
        let prepared = db.prepare_arrangement(edited).unwrap().load().unwrap();
        db.admit_arrangement(prepared).unwrap();
        let ids = deliver(&mut db);
        assert_eq!(ids.len(), 1);
        let row: QueuedInputMetadata = record(&f.raw(), "input_queue", &ids[0]).unwrap();
        assert_eq!(row.activation == inputs::InputActivation::Passive, passive);
        assert_ne!(ids, old);
        assert_eq!(db.pending_cold_bot_work().unwrap().len(), usize::from(!passive));
    }
}

#[test]
fn switching_queued_events_to_batch_honors_the_new_deadline() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "inbox", EventTiming::Immediate);
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    deliver(&mut db);
    let mut edited = input("inbox", EventTiming::Batch { window_ms: 60_000 });
    edited.expected_revision = Some(db.followup("inbox").unwrap().revision);
    let prepared = db.prepare_arrangement(edited).unwrap().load().unwrap();
    db.admit_arrangement(prepared).unwrap();
    assert!(deliver(&mut db).is_empty());
    assert!(db.pending_cold_bot_work().unwrap().is_empty());
    let now = varin_runtime::catalog::observations::wall_time_ms().unwrap();
    db.reconcile_followup_facts_at(now + 60_000).unwrap();
    assert_eq!(deliver(&mut db).len(), 1);
}

#[test]
fn process_now_remembers_held_passive_batches_until_the_bot_wakes() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "inbox", EventTiming::Passive);
    gate(&mut db, false, 2);
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    assert!(deliver(&mut db).is_empty());
    let d = db.followup("inbox").unwrap();
    db.control_event_backlog(EventBacklogInput { followup_id: d.id,
        expected_revision: d.revision, action: EventBacklogAction::ProcessNow }).unwrap();
    assert!(deliver(&mut db).is_empty());
    gate(&mut db, true, 3);
    let ids = deliver(&mut db);
    assert_eq!(ids.len(), 1);
    assert_eq!(db.pending_cold_bot_work().unwrap()[0].input_id, ids[0]);
}
#[test]
fn discard_releases_payload_but_preserves_dedup_identity() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "inbox", EventTiming::Batch { window_ms: 60_000 });
    let event = incoming("one", None);
    receive(&mut db, vec![event.clone()], None, Some("a")).unwrap();
    let d = db.followup("inbox").unwrap();
    db.control_event_backlog(EventBacklogInput {
        followup_id: d.id,
        expected_revision: d.revision,
        action: EventBacklogAction::Discard,
    })
    .unwrap();
    db.reconcile_followup_facts_at(u64::MAX).unwrap();
    assert!(deliver(&mut db).is_empty());
    assert!(f
        .raw()
        .query_row("SELECT content_ref IS NULL FROM followup_events", [], |r| r
            .get::<_, bool>(0))
        .unwrap());
    assert_eq!(
        receive(&mut db, vec![event], Some("a"), Some("a"))
            .unwrap()
            .duplicates,
        1
    );
    assert_eq!(db.followup("inbox").unwrap().pending_events, 0);
}
#[test]
fn edited_target_moves_only_unconsumed_input_and_keeps_original_delivery() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    db.create_thread("work", "work-main").unwrap();
    arrange(&mut db, "inbox", EventTiming::Immediate);
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    let ids = deliver(&mut db);
    let mut updated = input("inbox", EventTiming::Immediate);
    updated.expected_revision = Some(1);
    updated.thread_id = "work".into();
    updated.branch_id = "work-main".into();
    let p = db.prepare_arrangement(updated).unwrap().load().unwrap();
    db.admit_arrangement(p).unwrap();
    assert_eq!(deliver(&mut db), ids);
    let row: QueuedInputMetadata = record(&f.raw(), "input_queue", &ids[0]).unwrap();
    assert_eq!(row.thread_id, "work");
    assert_eq!(row.branch_id, "work-main");
    assert_eq!(db.bot_arrangements("bot", None).unwrap().len(), 1);
}
#[test]
fn source_account_and_principal_cannot_silently_change_subscription_identity() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "inbox", EventTiming::Immediate);
    let mut input = receive_input(vec![incoming("one", None)], None, Some("a"));
    input.identity.source.account_id = "replacement-account".into();
    let p = db.prepare_event_receive(input).unwrap().load().unwrap();
    assert!(db.admit_event_receive(p).is_err());
    let mut input = receive_input(vec![incoming("one", None)], None, Some("a"));
    input.identity.principal_id = Some("other-user".into());
    let p = db.prepare_event_receive(input).unwrap().load().unwrap();
    assert!(db.admit_event_receive(p).is_err());
    assert_eq!(db.followup("inbox").unwrap().pending_events, 0);
}

#[test]
fn object_routes_preserve_other_targets_and_only_trusted_sender_mapping_is_user_input() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    db.initialize_principals("owner", true).unwrap();
    db.create_thread_with_principal("work", "work-main", Some("owner"))
        .unwrap();
    arrange(&mut db, "inbox", EventTiming::Immediate);
    let route = EventSourceRouteInput {
        followup_id: "inbox".into(),
        expected_revision: 1,
        object_id: "mail-thread".into(),
        thread_id: "work".into(),
        branch_id: "work-main".into(),
        sender_id: Some("me".into()),
        user_input: true,
        external_conversation_id: None,
    };
    let routed = db.put_event_source_route(route.clone()).unwrap();
    assert_eq!(routed.revision, 2);
    assert_eq!(db.put_event_source_route(route).unwrap().revision, 2);
    let mut own = incoming("own", None);
    own.sender_id = Some("me".into());
    let mut other = incoming("other", None);
    other.sender_id = Some("not-me".into());
    let mut independent = incoming("elsewhere", None);
    independent.object_id = Some("other-object".into());
    independent.sender_id = Some("me".into());
    let mut batch = receive_input(vec![own, other, independent], None, Some("a"));
    batch.identity.principal_id = Some("owner".into());
    let p = db.prepare_event_receive(batch).unwrap().load().unwrap();
    db.admit_event_receive(p).unwrap();
    let ids = deliver(&mut db);
    assert_eq!(ids.len(), 3);
    let rows = ids
        .iter()
        .map(|id| record::<QueuedInputMetadata>(&f.raw(), "input_queue", id).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows.iter().filter(|r| r.thread_id == "work").count(), 2);
    assert_eq!(
        rows.iter()
            .filter(|r| matches!(
                r.origin,
                InputOrigin::Followup {
                    user_input: true,
                    ..
                }
            ))
            .count(),
        1
    );
    assert_eq!(
        rows.iter()
            .filter(|r| r.thread_id == "chat"
                && matches!(
                    r.origin,
                    InputOrigin::Followup {
                        user_input: false,
                        ..
                    }
                ))
            .count(),
        1
    );
    let remove = EventSourceRouteRemove {
        followup_id: "inbox".into(),
        expected_revision: 2,
        object_id: "mail-thread".into(),
    };
    assert_eq!(
        db.remove_event_source_route(remove.clone())
            .unwrap()
            .revision,
        3
    );
    assert_eq!(db.remove_event_source_route(remove).unwrap().revision, 3);
    assert!(db.event_source_routes("inbox").unwrap().is_empty());
}

#[test]
fn catalog_88_upgrade_preserves_original_work_and_does_not_replay_an_occurrence() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("work", "work-main").unwrap();
    let run = db
        .submit_with_launch(&SubmitInput {
            key: "initial".into(),
            thread_id: "work".into(),
            branch_id: "work-main".into(),
            expected_head: None,
            input: json!("do work"),
            configuration: json!({}),
        },Some(serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"fixture","provider_family":"fixture","model":"fixture","configuration_generation":1,"tool_schema_generation":1,"tools":[],"policy":{"name":"default","version":"1"},"source":null})).unwrap()))
        .unwrap();
    let p = db
        .prepare_followup_registration(
            "legacy",
            &run.run_id,
            FollowupRegistration {
                repeat: FollowupRepeat::Once,
                trigger: FollowupRegistrationTrigger::At { at_ms: 1 },
                instruction: "Original instruction".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    db.admit_followup_registration(p).unwrap();
    let before = db.followup_occurrences("legacy", None).unwrap().occurrences;
    let original = db.capture_followup("legacy").unwrap().load().unwrap();
    // Build the released 88 representation, retaining the actual old work, queue and receipts.
    f.raw().execute_batch(include_str!("fixtures/catalog-pre-arrangements.sql")).unwrap();
    f.raw().pragma_update(None, "user_version", 88).unwrap();
    drop(db);
    let db = f.open();
    let upgraded = db.capture_followup("legacy").unwrap().load().unwrap();
    assert_eq!(upgraded.followup.owner, FollowupOwner::Work);
    assert_eq!(upgraded.followup.source_run_id, Some(run.run_id));
    assert_eq!(upgraded.instruction, original.instruction);
    assert_eq!(
        db.followup_occurrences("legacy", None).unwrap().occurrences,
        before
    );
    assert_eq!(
        f.raw()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        89
    );
}

#[test]
fn discard_cancels_passive_queue_and_process_now_does_not_revive_it() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "passive", EventTiming::Passive);
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    let ids = deliver(&mut db);
    let d = db.followup("passive").unwrap();
    let d = db
        .control_event_backlog(EventBacklogInput {
            followup_id: d.id,
            expected_revision: d.revision,
            action: EventBacklogAction::Discard,
        })
        .unwrap();
    let row: QueuedInputMetadata = record(&f.raw(), "input_queue", &ids[0]).unwrap();
    assert_eq!(row.state, varin_runtime::InputState::Cancelled);
    db.control_event_backlog(EventBacklogInput {
        followup_id: d.id,
        expected_revision: d.revision,
        action: EventBacklogAction::ProcessNow,
    })
    .unwrap();
    assert!(db.pending_cold_bot_work().unwrap().is_empty());
    assert!(deliver(&mut db).is_empty());
}

#[test]
fn selected_target_repair_preserves_object_routes_and_rebuilds_revoked_sender_trust() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    db.initialize_principals("owner", true).unwrap();
    for (t, b) in [("work", "work-main"), ("next", "next-main")] {
        db.create_thread_with_principal(t, b, Some("owner"))
            .unwrap();
    }
    arrange(&mut db, "inbox", EventTiming::Immediate);
    db.put_event_source_route(EventSourceRouteInput {
        followup_id: "inbox".into(),
        expected_revision: 1,
        object_id: "mail-thread".into(),
        thread_id: "work".into(),
        branch_id: "work-main".into(),
        sender_id: Some("me".into()),
        user_input: true,
        external_conversation_id: None,
    })
    .unwrap();
    let mut trusted = incoming("trusted", None);
    trusted.sender_id = Some("me".into());
    let mut default = incoming("default", None);
    default.object_id = Some("unmapped".into());
    let mut batch = receive_input(vec![trusted, default], None, Some("a"));
    batch.identity.principal_id = Some("owner".into());
    let p = db.prepare_event_receive(batch).unwrap().load().unwrap();
    db.admit_event_receive(p).unwrap();
    // Freeze both while the Bot sleeps: neither has an input yet.
    gate(&mut db, false, 2);
    assert!(db.capture_followup_continuations().unwrap().is_empty());
    let ids = db
        .followup_occurrences("inbox", None)
        .unwrap()
        .occurrences
        .iter()
        .map(|v| v.id.clone())
        .collect::<Vec<_>>();
    let mut changed = input("inbox", EventTiming::Immediate);
    changed.expected_revision = Some(2);
    changed.thread_id = "next".into();
    changed.branch_id = "next-main".into();
    let p = db.prepare_arrangement(changed).unwrap().load().unwrap();
    db.admit_arrangement(p).unwrap();
    let occurrences = db.followup_occurrences("inbox", None).unwrap().occurrences;
    assert!(occurrences
        .iter()
        .any(|v| v.target.as_ref().unwrap().thread_id == "work"));
    assert!(occurrences
        .iter()
        .any(|v| v.target.as_ref().unwrap().thread_id == "next"));
    assert_eq!(
        occurrences.iter().map(|v| v.id.clone()).collect::<Vec<_>>(),
        ids
    );
    gate(&mut db, true, 3);
    let queued = deliver(&mut db);
    assert_eq!(queued.len(), 2);
    let d = db.followup("inbox").unwrap();
    db.remove_event_source_route(EventSourceRouteRemove {
        followup_id: d.id,
        expected_revision: d.revision,
        object_id: "mail-thread".into(),
    })
    .unwrap();
    assert_eq!(deliver(&mut db), queued);
    for id in queued {
        let row: QueuedInputMetadata = record(&f.raw(), "input_queue", &id).unwrap();
        assert_eq!(row.thread_id, "next");
        assert!(matches!(
            row.origin,
            InputOrigin::Followup {
                user_input: false,
                ..
            }
        ));
    }
}

#[test]
fn legacy_auth_claim_preserves_cursor_fixed_batch_and_receipt_dedup() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    arrange(&mut db, "inbox", EventTiming::Immediate);
    let one = incoming("one", None);
    receive(&mut db, vec![one.clone()], None, Some("a")).unwrap();
    let ids = deliver(&mut db);
    db.initialize_principals("owner", true).unwrap();
    let mut replay = receive_input(vec![one], None, Some("a"));
    replay.identity.principal_id = Some("owner".into());
    let p = db.prepare_event_receive(replay).unwrap().load().unwrap();
    assert_eq!(db.admit_event_receive(p).unwrap().duplicates, 1);
    let mut changed = input("inbox", EventTiming::Immediate);
    changed.expected_revision = Some(1);
    changed.name = "Renamed after auth".into();
    let p = db.prepare_arrangement(changed).unwrap().load().unwrap();
    db.admit_arrangement(p).unwrap();
    assert_eq!(deliver(&mut db), ids);
    assert_eq!(db.bot_arrangements("bot", Some("owner")).unwrap().len(), 1);
    assert!(db
        .bot_arrangements("bot", Some("other"))
        .unwrap()
        .is_empty());
    let cp = db
        .event_source_checkpoint(&EventSourceIdentity {
            principal_id: Some("owner".into()),
            source: source(),
        })
        .unwrap();
    assert_eq!(cp.cursor.as_deref(), Some("a"));
    let cursor = db.event_cursor().unwrap();
    db.update_event_source_status(
        cp.identity,
        EventSourceStatus {
            code: Some("offline".into()),
            message: None,
            coverage: None,
            last_connected_at_ms: None,
        },
    )
    .unwrap();
    assert!(db
        .events_after_for_principal(cursor, 100, Some("owner"))
        .unwrap()
        .iter()
        .any(|e| e.kind == "followup.source_status_changed"));
    assert!(db
        .events_after_for_principal(cursor, 100, Some("other"))
        .unwrap()
        .is_empty());
}

fn calendar(db: &mut Catalog) -> varin_runtime::catalog::calendar::DefinitionView {
    let input=serde_json::from_value(json!({"taskId":"calendar","assetRevision":"1","assetKind":"gui","name":"Review inbox","enabled":true,"timezone":"UTC","rule":{"kind":"daily","times":["09:00"]},"missedPolicy":"skip","target":{"kind":"existing_work","threadId":"chat","branchId":"main"},"instruction":"Review pending inbox"})).unwrap();
    let p = db
        .prepare_calendar_sync("bot:bot".into(), None, vec![input])
        .unwrap()
        .load()
        .unwrap();
    db.admit_calendar_sync(p).unwrap().definitions.remove(0)
}
#[test]
fn calendar_slot_freezes_every_routed_target_and_cancelled_owners_do_not_steal_future_slots() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    db.create_thread("work", "work-main").unwrap();
    let calendar = calendar(&mut db);
    arrange(
        &mut db,
        "inbox",
        EventTiming::Scheduled {
            calendar_id: calendar.id.clone(),
            run_empty: false,
        },
    );
    db.put_event_source_route(EventSourceRouteInput {
        followup_id: "inbox".into(),
        expected_revision: 1,
        object_id: "mail-thread".into(),
        thread_id: "work".into(),
        branch_id: "work-main".into(),
        sender_id: None,
        user_input: false,
        external_conversation_id: None,
    })
    .unwrap();
    let mut other = incoming("other", None);
    other.object_id = Some("default".into());
    receive(
        &mut db,
        vec![incoming("routed", None), other],
        None,
        Some("a"),
    )
    .unwrap();
    let slot = db
        .run_calendar_now(&calendar.id, calendar.revision, "slot-one")
        .unwrap();
    let ids = deliver(&mut db);
    assert_eq!(ids.len(), 2);
    assert_eq!(db.followup("inbox").unwrap().pending_events, 0);
    let batches = db.followup_occurrences("inbox", None).unwrap().occurrences;
    assert!(batches.iter().all(|v|matches!(&v.evidence,TriggerEvidence::PluginEvents {calendar_occurrence_id:Some(id),..} if id==&slot.id)));
    let d = db.followup("inbox").unwrap();
    db.control_followup(&d.id, d.revision, FollowupControlAction::Cancel)
        .unwrap();
    let next = db
        .run_calendar_now(&calendar.id, calendar.revision, "slot-two")
        .unwrap();
    let raw: serde_json::Value = record(&f.raw(), "calendar_occurrences", &next.id).unwrap();
    assert_eq!(raw["arrangement_owned"], false);
}
#[test]
fn empty_or_detached_calendar_slot_settles_without_a_prompt_or_permanent_active_hold() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    let calendar = calendar(&mut db);
    arrange(
        &mut db,
        "inbox",
        EventTiming::Scheduled {
            calendar_id: calendar.id.clone(),
            run_empty: false,
        },
    );
    let empty = db
        .run_calendar_now(&calendar.id, calendar.revision, "empty")
        .unwrap();
    assert!(deliver(&mut db).is_empty());
    assert_eq!(
        db.calendar_occurrence(&empty.id).unwrap().state,
        varin_runtime::catalog::calendar::OccurrenceState::Skipped
    );
    let pending = db
        .run_calendar_now(&calendar.id, calendar.revision, "pending")
        .unwrap();
    let mut changed = input("inbox", EventTiming::Immediate);
    changed.expected_revision = Some(1);
    let p = db.prepare_arrangement(changed).unwrap().load().unwrap();
    db.admit_arrangement(p).unwrap();
    assert_eq!(
        db.calendar_occurrence(&pending.id).unwrap().state,
        varin_runtime::catalog::calendar::OccurrenceState::Skipped
    );
    let next = db
        .run_calendar_now(&calendar.id, calendar.revision, "standalone")
        .unwrap();
    assert!(next.hold_reason.is_none());
    let lock = std::sync::Mutex::new(db);
    varin_runtime::catalog::calendar::reconcile(&lock).unwrap();
    let db = lock.into_inner().unwrap();
    assert_eq!(db.pending_cold_bot_work().unwrap().len(), 1);
}

#[test]
fn discarded_paused_history_is_cut_by_occurrence_time_without_losing_new_events() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    let d = arrange(&mut db, "inbox", EventTiming::Immediate);
    let d = db
        .control_followup(&d.id, d.revision, FollowupControlAction::Pause)
        .unwrap();
    let d = db
        .control_event_backlog(EventBacklogInput {
            followup_id: d.id,
            expected_revision: d.revision,
            action: EventBacklogAction::Discard,
        })
        .unwrap();
    db.control_followup(&d.id, d.revision, FollowupControlAction::Resume)
        .unwrap();
    let old = incoming("historic", None);
    let mut recent = incoming("new", None);
    recent.occurred_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert_eq!(
        receive(&mut db, vec![old, recent], None, Some("history-then-new"))
            .unwrap()
            .accepted,
        2
    );
    assert_eq!(db.followup("inbox").unwrap().pending_events, 1);
    assert_eq!(deliver(&mut db).len(), 1);
}

#[test]
fn first_contact_creates_one_real_bot_session_per_source_object() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    let mut definition = input("inbox", EventTiming::Immediate);
    definition.first_contact = Some(FirstContactPolicy::CreateBotSession);
    let p = db.prepare_arrangement(definition).unwrap().load().unwrap();
    db.admit_arrangement(p).unwrap();
    let event = incoming("one", None);
    receive(&mut db, vec![event.clone()], None, Some("a")).unwrap();
    let first = deliver(&mut db);
    let route = db.event_source_routes("inbox").unwrap().remove(0);
    assert_ne!(route.thread_id, "chat");
    assert!(!route.user_input);
    assert_eq!(
        db.pending_cold_bot_work().unwrap()[0].thread_id,
        route.thread_id
    );
    receive(&mut db, vec![event], None, Some("a")).unwrap();
    assert!(deliver(&mut db).is_empty());
    receive(&mut db, vec![incoming("two", None)], Some("a"), Some("b")).unwrap();
    assert_eq!(deliver(&mut db).len(), 1);
    assert_eq!(db.event_source_routes("inbox").unwrap().len(), 1);
    let row: QueuedInputMetadata = record(&f.raw(), "input_queue", &first[0]).unwrap();
    assert_eq!(row.thread_id, route.thread_id);
    let revision = db.inspect_thread(&route.thread_id).unwrap()["revision"]
        .as_u64()
        .unwrap();
    db.delete_thread(&varin_runtime::catalog::threads::ThreadDelete {
        thread_id: route.thread_id,
        key: "remove-auto-session".into(),
        expected_revision: revision,
    })
    .unwrap();
    let d = db.followup("inbox").unwrap();
    db.remove_event_source_route(EventSourceRouteRemove {
        followup_id: d.id,
        expected_revision: d.revision,
        object_id: "mail-thread".into(),
    })
    .unwrap();
    receive(&mut db, vec![incoming("three", None)], Some("b"), Some("c")).unwrap();
    let last = deliver(&mut db);
    let row: QueuedInputMetadata = record(&f.raw(), "input_queue", &last[0]).unwrap();
    assert_eq!(row.thread_id, "chat");
    assert!(db.event_source_routes("inbox").unwrap().is_empty());
}

#[test]
fn revoking_sender_trust_reprepares_bound_but_unconsumed_input_on_active_run() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    db.initialize_principals("owner", true).unwrap();
    db.create_thread_with_principal("work", "work-main", Some("owner"))
        .unwrap();
    let run = db
        .submit(&SubmitInput {
            key: "active".into(),
            thread_id: "work".into(),
            branch_id: "work-main".into(),
            expected_head: None,
            input: json!("Start work"),
            configuration: json!({}),
        })
        .unwrap();
    arrange(&mut db, "inbox", EventTiming::Immediate);
    db.put_event_source_route(EventSourceRouteInput {
        followup_id: "inbox".into(),
        expected_revision: 1,
        object_id: "mail-thread".into(),
        thread_id: "work".into(),
        branch_id: "work-main".into(),
        sender_id: Some("me".into()),
        user_input: true,
        external_conversation_id: None,
    })
    .unwrap();
    let mut own = incoming("own", None);
    own.sender_id = Some("me".into());
    let mut batch = receive_input(vec![own], None, Some("a"));
    batch.identity.principal_id = Some("owner".into());
    let p = db.prepare_event_receive(batch).unwrap().load().unwrap();
    db.admit_event_receive(p).unwrap();
    let ids = deliver(&mut db);
    let original: QueuedInputMetadata = record(&f.raw(), "input_queue", &ids[0]).unwrap();
    assert_eq!(original.run_id.as_deref(), Some(run.run_id.as_str()));
    assert!(matches!(
        original.origin,
        InputOrigin::Followup {
            user_input: true,
            ..
        }
    ));
    db.put_event_source_route(EventSourceRouteInput {
        followup_id: "inbox".into(),
        expected_revision: 2,
        object_id: "mail-thread".into(),
        thread_id: "work".into(),
        branch_id: "work-main".into(),
        sender_id: None,
        user_input: false,
        external_conversation_id: None,
    })
    .unwrap();
    assert_eq!(deliver(&mut db), ids);
    let queued: QueuedInputMetadata = record(&f.raw(), "input_queue", &ids[0]).unwrap();
    assert!(matches!(
        queued.origin,
        InputOrigin::Followup {
            user_input: false,
            ..
        }
    ));
    assert!(!db.run(&run.run_id).unwrap().cancel_requested);
    let history = db
        .consume_inputs(&run.run_id, db.epoch(), Some(&run.input_id))
        .unwrap();
    assert!(history.iter().any(|item| matches!(
        item.provenance,
        varin_runtime::execution::Provenance::EnvironmentFact { .. }
    )));
}

#[test]
fn provider_echo_waits_for_original_send_receipt_and_new_revision_remains_new_work() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    let run = db
        .submit(&SubmitInput {
            key: "active".into(),
            thread_id: "chat".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!("Start"),
            configuration: json!({}),
        })
        .unwrap();
    arrange(&mut db, "inbox", EventTiming::Immediate);
    receive(&mut db, vec![incoming("request", None)], None, Some("a")).unwrap();
    deliver(&mut db);
    db.consume_inputs(&run.run_id, db.epoch(), Some(&run.input_id))
        .unwrap();
    let occurrence = db.followup("inbox").unwrap().occurrence.unwrap();
    db.admit_operation(
        "send",
        &run.run_id,
        db.epoch(),
        varin_runtime::Lifetime::Run,
        json!({"kind":"send_message","objectId":"mail-thread"}),
    )
    .unwrap();
    db.dispatch_operation("send", db.epoch(), "sender", true)
        .unwrap();
    let mut echo = incoming("echo", Some("sent"));
    echo.echo_of = Some(EventEcho {
        owner_host_id: None,
        followup_id: "inbox".into(),
        occurrence_id: occurrence.id,
        operation_id: Some("send".into()),
    });
    receive(&mut db, vec![echo], Some("a"), Some("b")).unwrap();
    assert!(deliver(&mut db).is_empty());
    db.settle_operation(
        "send",
        db.epoch(),
        varin_runtime::Outcome::Succeeded,
        varin_runtime::Effect::Confirmed,
        json!({"sent":true}),
    )
    .unwrap();
    assert!(deliver(&mut db).is_empty());
    receive(
        &mut db,
        vec![incoming("request", Some("new-reply"))],
        Some("b"),
        Some("c"),
    )
    .unwrap();
    assert_eq!(deliver(&mut db).len(), 1);
}

#[test]
fn removed_object_route_stays_default_after_auth_claim_and_other_objects_still_create_sessions() {
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    db.create_thread("work", "work-main").unwrap();
    let mut definition = input("inbox", EventTiming::Immediate);
    definition.first_contact = Some(FirstContactPolicy::CreateBotSession);
    let p = db.prepare_arrangement(definition).unwrap().load().unwrap();
    db.admit_arrangement(p).unwrap();
    db.put_event_source_route(EventSourceRouteInput {
        followup_id: "inbox".into(),
        expected_revision: 1,
        object_id: "mail-thread".into(),
        thread_id: "work".into(),
        branch_id: "work-main".into(),
        sender_id: None,
        user_input: false,
        external_conversation_id: None,
    })
    .unwrap();
    receive(&mut db, vec![incoming("one", None)], None, Some("a")).unwrap();
    deliver(&mut db);
    let d = db.followup("inbox").unwrap();
    db.remove_event_source_route(EventSourceRouteRemove {
        followup_id: d.id,
        expected_revision: d.revision,
        object_id: "mail-thread".into(),
    })
    .unwrap();
    deliver(&mut db);
    db.initialize_principals("owner", true).unwrap();
    let mut other = incoming("new-object", None);
    other.object_id = Some("new-contact".into());
    let mut batch = receive_input(
        vec![incoming("same-object", None), other],
        Some("a"),
        Some("b"),
    );
    batch.identity.principal_id = Some("owner".into());
    let p = db.prepare_event_receive(batch).unwrap().load().unwrap();
    db.admit_event_receive(p).unwrap();
    let ids = deliver(&mut db);
    assert_eq!(ids.len(), 2);
    let routes = db.event_source_routes("inbox").unwrap();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].object_id, "new-contact");
    assert!(ids.iter().any(
        |id| record::<QueuedInputMetadata>(&f.raw(), "input_queue", id)
            .unwrap()
            .thread_id
            == "chat"
    ));
}

#[test]
fn another_bots_ordinary_child_is_a_valid_same_user_target_but_its_entry_is_not() {
    let mut f = child_dispatch::Fixture::new_in_bot("other-bot");
    let child = f.accept();
    setup(&mut f.db);
    f.db.initialize_principals("owner", true).unwrap();
    arrange(&mut f.db, "inbox", EventTiming::Immediate);
    let mut route = EventSourceRouteInput {
        followup_id: "inbox".into(),
        expected_revision: 1,
        object_id: "mail-thread".into(),
        thread_id: child.parent_thread_id.clone(),
        branch_id: child.parent_branch_id.clone(),
        sender_id: None,
        user_input: false,
        external_conversation_id: None,
    };
    assert!(f.db.put_event_source_route(route.clone()).is_err());
    route.thread_id = child.child_thread_id.clone();
    route.branch_id = child.child_branch_id.clone();
    f.db.put_event_source_route(route).unwrap();
    let mut request = receive_input(vec![incoming("existing-work", None)], None, Some("one"));
    request.identity.principal_id = Some("owner".into());
    let prepared = f.db.prepare_event_receive(request).unwrap().load().unwrap();
    f.db.admit_event_receive(prepared).unwrap();
    let queued = deliver(&mut f.db);
    assert_eq!(queued.len(), 1);
    assert_eq!(
        f.db.followup_occurrences("inbox", None)
            .unwrap()
            .occurrences[0]
            .delivery
            .as_ref()
            .unwrap()
            .thread_id,
        child.child_thread_id
    );
    assert_eq!(
        f.db.child_task(&child.operation_id)
            .unwrap()
            .parent_thread_id,
        child.parent_thread_id
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordinary_target_tool_edits_its_existing_bot_arrangement_without_claiming_a_bot() {
    use varin_runtime::execution::{ToolCall, ToolSchema};
    let f = Fixture::new();
    let mut db = f.open();
    setup(&mut db);
    db.create_thread("ordinary", "ordinary-main").unwrap();
    let mut arrangement = input("inbox", EventTiming::Immediate);
    arrangement.thread_id = "ordinary".into();
    arrangement.branch_id = "ordinary-main".into();
    let prepared = db.prepare_arrangement(arrangement).unwrap().load().unwrap();
    db.admit_arrangement(prepared).unwrap();
    let schema = ToolSchema {
        requirements: None,
        name: "follow_up".into(),
        version: "10".into(),
        description: "Follow-up arrangement".into(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    };
    let launch:varin_runtime::catalog::launches::LaunchSelection=serde_json::from_value(json!({"extension_bindings":[],"connection_identity":"original","provider_family":"fixture","model":"model","configuration_generation":1,"tool_schema_generation":1,"tools":[schema],"policy":{"name":"fixture","version":"1"}})).unwrap();
    let run = db
        .submit_with_launch(
            &SubmitInput {
                key: "ordinary-input".into(),
                thread_id: "ordinary".into(),
                branch_id: "ordinary-main".into(),
                expected_head: None,
                input: json!("Update the existing watch"),
                configuration: json!({}),
            },
            Some(launch.clone()),
        )
        .unwrap();
    let args = json!({"action":"arrange","followupId":"inbox","expectedRevision":1,"name":"Updated watch","instruction":"Inspect important replies","source":source(),"filter":{},"timing":{"kind":"immediate"}});
    let call_for = |db: &mut Catalog, run: &str, args: serde_json::Value| {
        let context = tool_invocations::admit_call(db, run, "follow_up", args.clone(), false);
        let id = db.operation(&context.operation_id).unwrap().intent["call"]["call_id"]
            .as_str()
            .unwrap()
            .to_owned();
        (
            context,
            ToolCall {
                call_id: id,
                name: schema.name.clone(),
                schema_version: schema.version.clone(),
                arguments: args,
            },
        )
    };
    let (context, call) = call_for(&mut db, &run.run_id, args.clone());
    let prepared = db
        .prepare_event_tool(&context, call.clone(), schema.clone())
        .unwrap()
        .load()
        .unwrap();
    db.admit_event_tool(prepared).unwrap();
    let current = db.followup("inbox").unwrap();
    assert_eq!(
        current.owner,
        FollowupOwner::Bot {
            bot_id: "bot".into()
        }
    );
    assert_eq!(current.name.as_deref(), Some("Updated watch"));
    let mut create = call;
    create
        .arguments
        .as_object_mut()
        .unwrap()
        .remove("followupId");
    create
        .arguments
        .as_object_mut()
        .unwrap()
        .remove("expectedRevision");
    assert!(
        matches!(db.prepare_event_tool(&context,create,schema.clone()),Err(RuntimeError::Conflict(reason)) if reason.contains("requires a Bot owner"))
    );
    let bot_run = db
        .submit_with_launch(
            &SubmitInput {
                key: "bot-edit".into(),
                thread_id: "chat".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!("Change the watch, preserving its target"),
                configuration: json!({}),
            },
            Some(launch),
        )
        .unwrap();
    let edit = |db: &mut Catalog, mut args: serde_json::Value| {
        args["expectedRevision"] = json!(db.followup("inbox").unwrap().revision);
        let (context, call) = call_for(db, &bot_run.run_id, args);
        let prepared = db
            .prepare_event_tool(&context, call, schema.clone())
            .unwrap()
            .load()
            .unwrap();
        db.admit_event_tool(prepared).unwrap();
        db.followup("inbox").unwrap()
    };
    let current = edit(&mut db, args.clone());
    assert_eq!(current.thread_id, "ordinary");
    assert_eq!(current.branch_id, "ordinary-main");
    for command in [
        json!({"action":"configure","key":"config","expectedRevision":0,"value":{"agents":[{"id":"agent","name":"Agent","harness":"codex","enabled":true,"command":"codex","args":[]}],"defaultAgent":"agent"}}),
        json!({"action":"create","key":"external-task","id":"external:task","configurationId":"agent","harness":"codex","title":"Existing work","cwd":"/workspace","principalId":null}),
    ] {
        let prepared = db
            .prepare_external(serde_json::from_value(command).unwrap())
            .load()
            .unwrap();
        db.execute_external(prepared).unwrap().load().unwrap();
    }
    let mut external = args.clone();
    external["externalConversationId"] = json!("external:task");
    assert_eq!(
        edit(&mut db, external).external_conversation_id.as_deref(),
        Some("external:task")
    );
    let preserved = edit(&mut db, args.clone());
    assert_eq!(
        preserved.external_conversation_id.as_deref(),
        Some("external:task")
    );
    assert_eq!(preserved.thread_id, "ordinary");
    let mut native = args;
    native["externalConversationId"] = serde_json::Value::Null;
    let restored = edit(&mut db, native);
    assert_eq!(restored.external_conversation_id, None);
    assert_eq!(restored.thread_id, "ordinary");
}
