use super::*;
use crate::execution::*;
#[path = "../tests/fixtures/child_dispatch.rs"]
mod child_fixture;
#[path = "../tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;

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
        let duplicate_follow: u64 = f.db.db.query_row("SELECT count(*) FROM events WHERE kind='bot.work_pending' AND json_extract(data,'$.kind')='run_report' AND json_extract(data,'$.runId')=?1", [&work.run_id], |row| read_number(row, 0)).unwrap();
        assert_eq!(duplicate_follow, 0);
        let root = f.root.clone();
        drop(f.db);
        let owner = std::sync::Mutex::new(Catalog::open(&root).unwrap());
        super::super::deliver_reports(&owner).unwrap();
        super::super::deliver_reports(&owner).unwrap();
        let db = owner.into_inner().unwrap();
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
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
