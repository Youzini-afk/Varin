use super::*;
use crate::execution::*;
#[path = "../tests/fixtures/child_dispatch.rs"]
mod child_fixture;
#[path = "../tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
#[path = "../../varin-kernel/src/fixtures/query_schemas_v93.rs"]
#[allow(dead_code)]
mod original_readers;

fn send_schema() -> ToolSchema {
    ToolSchema {
        requirements: None,
        name: messages::SEND_TOOL.into(),
        version: "1".into(),
        description: String::new(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    }
}

fn request(f: &mut child_fixture::Fixture, target: &Receipt) -> messages::MessageReceipt {
    let schema = send_schema();
    let input = messages::MessageInput {
        attachments: vec![],
        after_current: None,
        source_agent: None,
        name: None,
        wait: Some(messages::MessageWaitOptions { timeout_ms: None }),
        target_thread_id: Some(target.thread_id.clone()),
        target_branch_id: Some(target.branch_id.clone()),
        reply_to: None,
        kind: MessageKind::Request,
        text: "Continue this existing work and report the result.".into(),
    };
    let call = ToolCall {
        call_id: "resume-work".into(),
        name: schema.name.clone(),
        schema_version: schema.version.clone(),
        arguments: serde_json::to_value(&input).unwrap(),
    };
    let context = f.admit_policy_call_with_contract(
        call.clone(),
        ToolContract {
            name: schema.name.clone(),
            schema_version: schema.version.clone(),
            read_only: false,
            completion: CompletionKind::Job,
            lifetime: Lifetime::Thread,
            resources: vec![],
        },
    );
    let preparation =
        f.db.prepare_tool_message(&context, call, schema, input)
            .unwrap()
            .load()
            .unwrap();
    f.db.admit_message(preparation).unwrap().receipt
}

#[test]
fn existing_work_replies_to_the_requesting_bot_session_once_after_restart_and_resolves_its_wait() {
    for state in [RunState::Completed, RunState::Failed, RunState::Cancelled] {
        let mut f = child_fixture::Fixture::new_in_bot("bot");
        f.db.create_bot_thread("request-session", "request-route", "bot")
            .unwrap();
        let configuration = f.db.run(&f.context.run_id).unwrap().configuration;
        let mut launch = f.launch.clone();
        launch.tools.push(send_schema());
        launch.tools.push(original_readers::family_schemas().into_iter().find(|tool| tool.name == family::READ_TOOL).unwrap());
        launch.tool_schema_generation += 1;
        let caller =
            f.db.submit_with_launch(
                &SubmitInput {
                    key: "caller".into(),
                    thread_id: "request-session".into(),
                    branch_id: "request-route".into(),
                    expected_head: None,
                    input: json!({"text":"Continue existing work"}),
                    configuration: configuration.clone(),
                },
                Some(launch),
            )
            .unwrap();
        f.context.run_id = caller.run_id.clone();
        f.db.create_thread("existing-work", "work-route").unwrap();
        let work =
            f.db.submit_with_launch(
                &SubmitInput {
                    key: "work".into(),
                    thread_id: "existing-work".into(),
                    branch_id: "work-route".into(),
                    expected_head: None,
                    input: json!({"text":"Earlier user work"}),
                    configuration,
                },
                Some(f.launch.clone()),
            )
            .unwrap();
        f.db.commit_execution(
            &work.run_id,
            f.db.epoch(),
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        f.db.update_bot_matter(
            super::super::super::bot_work::MatterUpdate {
                bot_id: "bot".into(),
                key: "follow".into(),
                expected_revision: 0,
                matter: super::super::super::bot_work::BotMatter {
                    id: "matter".into(),
                    revision: 0,
                    title: "Existing work".into(),
                    description: String::new(),
                    archived: false,
                    threads: vec![super::super::super::bot_work::MatterThread {
                        thread_id: work.thread_id.clone(),
                        branch_id: work.branch_id.clone(),
                        send: false,
                        memory: false,
                    }],
                },
            },
            None,
        )
        .unwrap();
        let sent = request(&mut f, &work);
        let head = f.db.head(&work.branch_id).unwrap();
        let delivery =
            f.db.prepare_input_delivery(&work.run_id, f.db.epoch(), head.as_deref())
                .unwrap()
                .load()
                .unwrap();
        f.db.admit_input_delivery(delivery).unwrap().unwrap();
        let head = f.db.head(&work.branch_id).unwrap();
        f.db.append_history(&work.run_id, f.db.epoch(), head.as_deref(), HistorySource::Assistant,
            json!({"id":"actual-answer","provenance":{"kind":"assistant"},"content":{"kind":"text","text":"The actual result from the reused conversation."},"opaque":null}), None).unwrap();
        f.db.commit_execution(
            &work.run_id,
            f.db.epoch(),
            &ExecutionRecord::StateChanged {
                state,
                waiting_on: None,
            },
        )
        .unwrap();
        let current = |db:&Catalog| db.capture_family_read("request-session",None,None).unwrap().directory_page(false,
            family::FamilyListQuery{scope:Some("current".into()),query:Some("existing-work".into()),..Default::default()},&||false).unwrap().members;
        assert_eq!(current(&f.db).len(),1,"original work report remains current before queue admission");
        let duplicate_follow: u64 = f.db.db.query_row("SELECT count(*) FROM events WHERE kind='bot.work_pending' AND json_extract(data,'$.kind')='run_report' AND json_extract(data,'$.runId')=?1", [&work.run_id], |row| read_number(row, 0)).unwrap();
        assert_eq!(duplicate_follow, 0);
        let root = f.root.clone();
        drop(f.db);
        let owner = std::sync::Mutex::new(Catalog::open(&root).unwrap());
        super::super::deliver_reports(&owner).unwrap();
        super::super::deliver_reports(&owner).unwrap();
        let db = owner.into_inner().unwrap();
        assert_eq!(current(&db).len(),1,"queued work report is not delivered to its requester");
        let id = format!(
            "message:bot-report:run:{}:{}",
            work.run_id, sent.identity.message_id
        );
        let reply = db
            .capture_message("request-session", "request-route", &id)
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(
            reply.summary.receipt.identity.target_thread_id,
            "request-session"
        );
        assert_eq!(
            reply.summary.receipt.identity.target_branch_id,
            "request-route"
        );
        assert_eq!(
            reply.summary.receipt.identity.reply_to.as_deref(),
            Some(sent.identity.message_id.as_str())
        );
        assert!(matches!(
            reply.summary.receipt.identity.actor,
            messages::MessageActor::WorkReport { .. }
        ));
        assert!(
            reply
                .text
                .contains("The actual result from the reused conversation.")
        );
        assert!(reply.text.len() < 68000, "automatic work reports use the existing page budget");
        assert!(!reply.text.contains(&work.run_id), "model notice does not duplicate internal Run IDs");
        assert!(!reply.text.contains("read_thread ref="), "ordinary report text must not teach a frozen reader an undeclared selector");
        let body: String = db.db.query_row("SELECT body FROM input_history_content WHERE input_id=?1",[&id],|row|row.get(0)).unwrap();
        let reference: Value = serde_json::from_str(&body).unwrap();
        let (body, _) = db.content.load_history_payload(&reference).unwrap();
        let item: ConversationItem = serde_json::from_value(body).unwrap();
        let Content::Output { output } = item.content else { panic!("typed work report") };
        assert!(output.model_data.is_none(), "the actual requester has the original operation/query reader");
        let arguments = &output.model_data()["read"]["arguments"];
        assert_eq!(arguments["runId"],work.run_id);
        assert_eq!(arguments["query"]["kind"],"item");
        assert!(arguments.get("ref").is_none());
        let read = db.capture_family_read("request-session",arguments["threadId"].as_str(),arguments["branchId"].as_str()).unwrap();
        let page = read.item(family::ItemRequest {run_id:arguments["runId"].as_str().map(str::to_owned),anchor:None,
            item_id:arguments["query"]["itemId"].as_str().unwrap().into(),offset:None,max_bytes:None},&||false).unwrap();
        assert!(page.text.contains("The actual result from the reused conversation."));
        assert!(reply.text.contains(&db.execution_reference(&work.run_id).unwrap().reference));
        let original = db
            .capture_message(
                "request-session",
                "request-route",
                &sent.identity.message_id,
            )
            .unwrap()
            .load()
            .unwrap();
        assert_eq!(
            original.summary.reply_wait.unwrap().state,
            messages::reply_wait::ReplyWaitState::Replied
        );
        let feed = db
            .capture_message_feed(
                "request-session".into(),
                "request-route".into(),
                None,
                None,
                None,
            )
            .unwrap()
            .load(&|| false)
            .unwrap();
        assert_eq!(
            feed.messages
                .iter()
                .filter(|entry| entry.message.summary.receipt.identity.message_id == id)
                .count(),
            1
        );
        assert!(db.pending_work_reports().unwrap().is_empty());
        assert!(db.capture_child_receipts().unwrap().is_empty());
        let mut db=db;
        let run=db.run(&caller.run_id).unwrap();
        let input:inputs::QueuedInputMetadata=record(&db.db,"input_queue",&id).unwrap();
        let tx=db.db.transaction().unwrap();
        inputs::deliver(&tx,&run,&input).unwrap(); tx.commit().unwrap();
        assert!(db.history("request-route").unwrap().iter().any(|item|item.id==id));
        assert!(current(&db).is_empty(),"completed native work leaves current only after requester history delivery");
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn reused_delegated_execution_reports_to_its_actual_requester_branch_not_original_parent() {
    let mut f=child_fixture::Fixture::new_in_bot("bot");
    let child=f.accept(); f.settle_exchange();
    // This fixture already froze its delegated model at dispatch. The User-dispatch
    // fixture's start_child helper would incorrectly request another model selection.
    let mut source=child.source.pin().unwrap().source.clone();
    source.branch_id=Some(format!("child-source:{}",child.execution_id)); source.revision=Some(0);
    if matches!(child.code_result,collaboration::ChildCodeResult::Pending) { source.mode=SourceMode::Materialized; }
    let proposal=super::super::super::context::ContextProposal {
        key:"first-requester-context".into(),branch_id:child.child_branch_id.clone(),through_id:None,expected_revision:0,
        summary:String::new(),effective_system_prompt:"Frozen worker instructions".into(),instruction_sources:vec![],memory_checkpoint:None,
    };
    let basis=serde_json::from_value(json!({"mode":"bot","threadRole":"worker","revision":1,"configurationDigest":"frozen-worker",
        "memorySnapshot":{"revision":0,"memories":[]},"threadId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"system","content":"Frozen worker instructions"}],"instructionSources":[]})).unwrap();
    let child=f.db.prepare_child(&child.execution_id,source,proposal,basis).unwrap();
    let work=child.receipt.as_ref().unwrap().clone();
    f.db.commit_execution(&work.run_id,f.db.epoch(),&ExecutionRecord::StateChanged{state:RunState::Runnable,waiting_on:None}).unwrap();
    let head=f.db.head(&work.branch_id).unwrap();
    f.db.append_history(&work.run_id,f.db.epoch(),head.as_deref(),HistorySource::Assistant,
        json!({"id":"first-answer","provenance":{"kind":"assistant"},"content":{"kind":"text","text":"First original answer"},"opaque":null}),None).unwrap();
    f.db.commit_execution(&work.run_id,f.db.epoch(),&ExecutionRecord::StateChanged{state:RunState::Completed,waiting_on:None}).unwrap();
    f.db.reconcile_child_reports().unwrap();
    f.db.create_bot_thread("different-requester","different-branch","bot").unwrap();
    let configuration=f.db.run(&child.parent_run_id).unwrap().configuration;
    let mut launch=f.launch.clone(); launch.tools.push(send_schema()); launch.tool_schema_generation+=1;
    let caller=f.db.submit_with_launch(&SubmitInput{key:"different-caller".into(),thread_id:"different-requester".into(),branch_id:"different-branch".into(),expected_head:None,input:json!({"text":"Reuse this Agent"}),configuration},Some(launch)).unwrap();
    f.context.run_id=caller.run_id.clone();
    let sent=request(&mut f,&work);
    let activation=f.db.capture_request_activations().unwrap().into_iter().find_map(|preparation| {
        let prepared=preparation.load().unwrap();
        match f.db.admit_request_activation(prepared).unwrap() {
            super::super::super::activation::RequestActivationAdmission::Delegated(id)=>Some(id), _=>None,
        }
    }).expect("one reused delegated execution");
    assert_ne!(activation,child.execution_id);
    f.db.fail_delegated_preparation(&activation,"second_request_source_unavailable",None).unwrap();
    let root=f.root.clone(); drop(f.db);
    let owner=std::sync::Mutex::new(Catalog::open(&root).unwrap());
    super::super::deliver_reports(&owner).unwrap();
    super::super::deliver_reports(&owner).unwrap();
    let mut db=owner.into_inner().unwrap();
    let message=format!("message:bot-report:{activation}");
    let view=db.capture_message("different-requester","different-branch",&message).unwrap().load().unwrap();
    assert_eq!(view.summary.receipt.identity.target_thread_id,"different-requester");
    assert_eq!(view.summary.receipt.identity.target_branch_id,"different-branch");
    assert_eq!(view.summary.receipt.identity.reply_to.as_deref(),Some(sent.identity.message_id.as_str()));
    assert!(view.text.contains("second_request_source_unavailable"));
    let execution=db.delegated_execution(&activation).unwrap();
    assert!(execution.receipt.is_none());
    let selected=super::super::requester(&db.db,&activation).unwrap();
    assert_eq!(selected.run_id,caller.run_id);
    // Deliver under the actual receiving Run and verify its attention receipt keeps
    // that requester, instead of rewriting the original child relation.
    let run=db.run(&caller.run_id).unwrap();
    let input:inputs::QueuedInputMetadata=record(&db.db,"input_queue",&message).unwrap();
    let tx=db.db.transaction().unwrap();
    inputs::deliver(&tx,&run,&input).unwrap(); tx.commit().unwrap();
    let attention=db.capture_attention_read().load(&||false).unwrap();
    let delivery=attention.delivered_reports.iter().find(|fact|fact.execution_id==activation).unwrap();
    assert_eq!(delivery.parent_run_id,caller.run_id);
    assert_eq!(delivery.parent_branch_id,"different-branch");
    assert_eq!(db.child_task(&child.operation_id).unwrap().parent_run_id,child.parent_run_id);
    drop(db); std::fs::remove_dir_all(root).unwrap();
}
