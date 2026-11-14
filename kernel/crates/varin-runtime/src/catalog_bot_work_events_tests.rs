use super::*;
use crate::test_submission::InputAdmission;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self { Self(std::env::temp_dir().join(format!("varin-work-report-{}", id()))) }
    fn open(&self) -> Catalog { Catalog::open(&self.0).unwrap() }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

fn follow(db: &mut Catalog) {
    db.publish_bot_gate(bot::BotGate { bot_id: "bot".into(), profile_revision: 1,
        activity_operation_id: None, permitted: true }).unwrap();
    db.create_bot_thread("bot", "bot-main", "bot").unwrap();
    db.create_thread("work", "work-main").unwrap();
    db.update_bot_matter(bot_work::MatterUpdate { bot_id: "bot".into(), key: "follow".into(), expected_revision: 0,
        matter: bot_work::BotMatter { id: "matter".into(), revision: 0, title: "Original work".into(),
            description: String::new(), archived: false, threads: vec![bot_work::MatterThread {
                thread_id: "work".into(), branch_id: "work-main".into(), send: false, memory: false }] } }, None).unwrap();
}
fn start(db: &mut Catalog, thread: &str, branch: &str) -> Receipt {
    db.submit(&SubmitInput { key: format!("start-{thread}"), thread_id: thread.into(), branch_id: branch.into(),
        expected_head: None, input: json!({"text":"Do the original work"}), configuration: json!({"provider":"test"}) }).unwrap()
}
fn report_output(db: &Catalog) -> (String, crate::output::OutputBody) {
    let (id, reference): (String, String) = db.db.query_row("SELECT q.id,c.body FROM input_queue q JOIN input_history_content c ON c.input_id=q.id JOIN events e ON e.cursor=json_extract(q.body,'$.origin.event_cursor') WHERE json_extract(e.data,'$.kind')='run_report'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    let body = db.content.load_history_payload(&serde_json::from_str(&reference).unwrap()).unwrap().0;
    let item: ConversationItem = serde_json::from_value(body).unwrap();
    let Content::Output {output} = item.content else { panic!("report output") };
    (id, output)
}

#[test]
fn followed_native_report_is_bounded_stable_and_reads_its_original_answer() {
    let fixture = Fixture::new();
    let mut db = fixture.open();
    follow(&mut db);
    let bot = start(&mut db, "bot", "bot-main");
    let work = start(&mut db, "work", "work-main");
    let text = format!("{}original ending", "事实🧪".repeat(20000));
    let attachment = attachments::Attachment { model_ref: None, reference: "attachment:original-artifact".into(),
        filename: "results.csv".into(), mime_type: "text/csv".into(), byte_length: 42 };
    let answer = db.append_history(&work.run_id, db.epoch(), Some(&work.input_id), HistorySource::Assistant,
        json!({"id":"answer","provenance":{"kind":"assistant"},"content":{"kind":"output","output":{"data":null,
            "parts":[{"kind":"text","text":text},{"kind":"attachment","attachment":attachment}]}},"opaque":null}), None).unwrap();
    for state in [RunState::Runnable, RunState::Completed] {
        db.commit_execution(&work.run_id, db.epoch(), &crate::execution::ExecutionRecord::StateChanged {state, waiting_on: None}).unwrap();
    }
    let expected_execution = db.execution_reference(&work.run_id).unwrap().reference;
    let owner = std::sync::Mutex::new(db);
    deliver(&owner).unwrap();
    deliver(&owner).unwrap();
    let mut db = owner.into_inner().unwrap();
    let (queued, output) = report_output(&db);
    let model = output.model_data.as_ref().unwrap();
    assert_eq!(model["executionRef"], expected_execution);
    assert_eq!(model["previewPartial"], true);
    assert_eq!(output.data["source"]["runId"], work.run_id);
    assert_eq!(output.data["source"]["itemId"], answer.id);
    let rendered = std::iter::once(serde_json::to_string(output.model_data()).unwrap()).chain(output.parts.iter().filter_map(|part| match part {
        crate::output::OutputPart::Text {text} => Some(text.clone()),
        crate::output::OutputPart::Attachment {attachment} => Some(attachment.description()), _ => None,
    })).collect::<Vec<_>>().join("\n");
    let preview = output.parts.iter().find_map(|part| match part { crate::output::OutputPart::Text {text} => Some(text), _ => None }).unwrap();
    let preview = preview.split_once('\n').unwrap().1;
    assert!(preview.len() <= 65536 && preview.len() > 65526);
    assert!(text.starts_with(preview));
    assert!(rendered.contains("事实🧪"));
    assert!(!rendered.contains("original ending"));
    assert!(!rendered.contains(&work.run_id));
    assert!(!rendered.contains("attachment:original-artifact"));
    let file = output.parts.iter().find_map(|part| match part {
        crate::output::OutputPart::Attachment {attachment} => Some(attachment), _ => None,
    }).unwrap();
    assert_eq!(file.reference, attachment.reference);
    assert!(file.model_ref.as_ref().unwrap().starts_with("file:"));
    assert!(db.db.query_row("SELECT EXISTS(SELECT 1 FROM attachment_deliveries WHERE holder_id=?1)", [&queued], |r|r.get::<_,bool>(0)).unwrap());
    let selected = db.resolve_model_reference(model_references::ReferenceKind::Item,
        model["read"]["arguments"]["ref"].as_str().unwrap()).unwrap();
    let arguments = db.model_history_read_arguments(&bot.run_id, &selected.target).unwrap();
    assert_eq!(arguments["query"]["itemId"], answer.id);
    assert_eq!(arguments["runId"], work.run_id);
    let original = db.capture_family_read("bot", Some("work"), Some("work-main")).unwrap()
        .item(family::ItemRequest {run_id:Some(work.run_id.clone()), anchor:None, item_id:answer.id,
            offset:None, max_bytes:Some(text.len()+4096)}, &||false).unwrap();
    assert!(original.text.contains("original ending"));
    let update = db.inspect_thread("work").unwrap();
    db.update_thread(&threads::ThreadUpdate {thread_id:"work".into(),key:"rename".into(),expected_revision:update["revision"].as_u64().unwrap(),
        title:Some("Changed title".into()),pinned:None,archived:None,title_mode:None}).unwrap();
    let owner = std::sync::Mutex::new(db);
    deliver(&owner).unwrap();
    let db = owner.into_inner().unwrap();
    assert_eq!(report_output(&db).1, output);
    drop(db);
    let owner = std::sync::Mutex::new(fixture.open());
    deliver(&owner).unwrap();
    assert_eq!(report_output(&owner.lock().unwrap()).1, output);
}


#[test]
fn bot_attention_inactivity_is_configurable_deduplicated_and_rearmed_by_real_activity() {
    let fixture=Fixture::new(); let mut db=fixture.open(); follow(&mut db);
    let _bot=start(&mut db,"bot","bot-main"); let work=start(&mut db,"work","work-main");
    db.configure_bot_inactivity(20).unwrap();
    for state in [RunState::Runnable,RunState::Generating] { db.commit_execution(&work.run_id,db.epoch(),&crate::execution::ExecutionRecord::StateChanged{state,waiting_on:None}).unwrap(); }
    let activity=|db:&mut Catalog| {let tx=db.db.transaction().unwrap(); event(&tx,&work.run_id,1,"execution.committed",json!({"kind":"model_dispatched","atMs":observations::wall_time_ms().unwrap()})).unwrap();tx.commit().unwrap();};
    activity(&mut db);
    let due=db.nearest_bot_inactivity_deadline().unwrap().unwrap();
    db.reconcile_bot_inactivity_at(due-1).unwrap();
    let count=|db:&Catalog| db.db.query_row("SELECT count(*) FROM events WHERE kind='bot.work_pending' AND json_extract(data,'$.kind')='execution_attention'",[],|row|row.get::<_,i64>(0)).unwrap();
    assert_eq!(count(&db),0);
    db.reconcile_bot_inactivity_at(due).unwrap(); db.reconcile_bot_inactivity_at(due+1).unwrap();
    assert_eq!(count(&db),1); assert_eq!(db.nearest_bot_inactivity_deadline().unwrap(),None);
    let owner=std::sync::Mutex::new(db); deliver(&owner).unwrap(); deliver(&owner).unwrap();
    let mut db=owner.into_inner().unwrap();
    let delivered:i64=db.db.query_row("SELECT count(*) FROM input_queue q JOIN events e ON q.id='bot-work-event:'||e.cursor WHERE json_extract(e.data,'$.kind')='execution_attention'",[],|row|row.get(0)).unwrap(); assert_eq!(delivered,1);
    activity(&mut db); assert!(db.nearest_bot_inactivity_deadline().unwrap().is_some());
    db.configure_bot_inactivity(0).unwrap(); assert_eq!(db.nearest_bot_inactivity_deadline().unwrap(),None);
}

#[test]
fn bot_attention_restart_reports_interruption_without_completing_the_original_work() {
    let fixture=Fixture::new(); let mut db=fixture.open(); follow(&mut db);
    let _bot=start(&mut db,"bot","bot-main"); let work=start(&mut db,"work","work-main");
    for state in [RunState::Runnable,RunState::Generating] { db.commit_execution(&work.run_id,db.epoch(),&crate::execution::ExecutionRecord::StateChanged{state,waiting_on:None}).unwrap(); }
    drop(db); let db=fixture.open();
    assert_eq!(db.run(&work.run_id).unwrap().state,RunState::Waiting);
    let owner=std::sync::Mutex::new(db); deliver(&owner).unwrap(); deliver(&owner).unwrap();
    let db=owner.into_inner().unwrap();
    let count:i64=db.db.query_row("SELECT count(*) FROM input_queue q JOIN events e ON q.id='bot-work-event:'||e.cursor WHERE json_extract(e.data,'$.reason')='interrupted'",[],|row|row.get(0)).unwrap(); assert_eq!(count,1);
}

#[test]
fn bot_attention_restart_keeps_followers_when_source_creation_identity_is_unknown() {
    let fixture = Fixture::new();
    let mut db = fixture.open();
    follow(&mut db);
    let _bot = start(&mut db, "bot", "bot-main");
    let work = start(&mut db, "work", "work-main");
    for state in [RunState::Runnable, RunState::Generating] {
        db.commit_execution(&work.run_id, db.epoch(), &crate::execution::ExecutionRecord::StateChanged {
            state, waiting_on: None,
        }).unwrap();
    }
    // A retained follower relation is independent of missing legacy creation facts.
    db.db.execute("UPDATE thread_creations SET identity_known=0 WHERE thread_id='work'", []).unwrap();
    drop(db);

    let db = fixture.open();
    assert_eq!(db.run(&work.run_id).unwrap().state, RunState::Waiting);
    assert!(matches!(bot::thread_permitted(&db.db, "work", db.epoch()), Err(RuntimeError::IdentityUnavailable(_))));
    let owner = std::sync::Mutex::new(db);
    deliver(&owner).unwrap();
    deliver(&owner).unwrap();
    let db = owner.into_inner().unwrap();
    let count: i64 = db.db.query_row(
        "SELECT count(*) FROM input_queue q JOIN events e ON q.id='bot-work-event:'||e.cursor WHERE json_extract(e.data,'$.reason')='interrupted' AND json_extract(e.data,'$.sourceThreadId')='work' AND json_extract(e.data,'$.targetThreadId')='bot'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(count, 1);
    assert_eq!(db.inspect_thread("work").unwrap()["creation_identity_known"], false);
}
