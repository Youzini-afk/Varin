//! Internal completion messages keep their original retrieval owner after delivery.
use super::*;
use crate::execution::*;
#[path = "../tests/fixtures/child_dispatch.rs"]
mod child_fixture;
#[path = "../tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;

fn state(db: &mut Catalog, run: &str, state: RunState) {
    db.commit_execution(run, db.epoch(), &ExecutionRecord::StateChanged {
        state, waiting_on: None,
    }).unwrap();
}

fn current(db: &Catalog) -> Vec<family::FamilyMember> {
    db.capture_family_read("thread:parent", None, None).unwrap().directory_page(
        true, family::FamilyListQuery { scope: Some("current".into()), ..Default::default() },
        &|| false,
    ).unwrap().members
}

#[test]
fn retrieval_completion_never_requests_a_work_report_even_after_reopen_with_old_pending_event() {
    for late in [false, true] {
        let mut f = child_fixture::Fixture::new_internal_retrieval();
        let child = f.accept();
        f.settle_exchange();
        if late { state(&mut f.db, &child.parent_run_id, RunState::Completed); }

        let mut source = child.source.pin().unwrap().source.clone();
        source.branch_id = Some(format!("child-source:{}", child.operation_id));
        source.revision = Some(0);
        let proposal = context::ContextProposal {
            key: format!("child-context:{}", child.operation_id),
            branch_id: child.child_branch_id.clone(), through_id: None, expected_revision: 0,
            summary: String::new(), effective_system_prompt: "Read-only child".into(),
            instruction_sources: vec!["review:child".into()], memory_checkpoint: None,
        };
        let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
            "configurationDigest":"review:child-profile:0","memorySnapshot":{"revision":0,"memories":[]},
            "threadId":child.child_thread_id,"projectId":child.project_id,
            "originalSections":[{"name":"preamble","content":"Read-only child"}],"instructionSources":["review:child"]})).unwrap();
        let ready = f.db.prepare_child(&child.operation_id, source, proposal, basis).unwrap();
        let run = ready.receipt.as_ref().unwrap();
        state(&mut f.db, &run.run_id, RunState::Runnable);
        let head = f.db.head(&child.child_branch_id).unwrap();
        f.db.append_history(&run.run_id, f.db.epoch(), head.as_deref(), HistorySource::Assistant,
            json!({"id":"retrieval-answer","provenance":{"kind":"assistant"},
                "content":{"kind":"text","text":"The original background finding."},"opaque":null}), None).unwrap();
        state(&mut f.db, &run.run_id, RunState::Completed);
        f.db.reconcile_child_reports().unwrap();
        f.db.mark_child_resources_released(&child.execution_id).unwrap();

        let owner = std::sync::Mutex::new(f.db);
        crate::catalog::child_delivery::reconcile_reports(&owner).unwrap();
        crate::catalog::child_delivery::reconcile_reports(&owner).unwrap();
        let mut db = owner.into_inner().unwrap();
        let message_id = format!("message:{}", child.operation_id);
        let receiving_run = if late {
            let mut candidates = db.capture_request_activations().unwrap();
            assert_eq!(candidates.len(), 1, "the late result activates its original parent once");
            let prepared = candidates.pop().unwrap().load().unwrap();
            let activation::RequestActivationAdmission::Bound(run) = db.admit_request_activation(prepared).unwrap() else {
                panic!("background result did not activate its original parent");
            };
            assert_ne!(run, child.parent_run_id);
            state(&mut db, &run, RunState::Runnable);
            run
        } else { child.parent_run_id.clone() };
        let result = db.capture_message("thread:parent", "branch:parent", &message_id).unwrap().load().unwrap();
        if result.summary.state == InputState::Queued {
            let head = db.head("branch:parent").unwrap();
            let delivery = db.prepare_input_delivery(&receiving_run, db.epoch(), head.as_deref()).unwrap().load().unwrap();
            let batch = db.admit_input_delivery(delivery).unwrap().unwrap();
            assert_eq!(batch.items.len(), 1);
            assert_eq!(batch.items[0].id, message_id);
        }
        let result = db.capture_message("thread:parent", "branch:parent", &message_id).unwrap().load().unwrap();
        assert_eq!(result.summary.state, InputState::Delivered);
        assert_eq!(result.summary.delivered_run_id.as_deref(), Some(receiving_run.as_str()));
        assert_eq!(result.summary.receipt.identity.sender_thread_id, child.child_thread_id);
        assert!(result.text.contains("The original background finding."));
        let head = db.head("branch:parent").unwrap();
        db.append_history(&receiving_run, db.epoch(), head.as_deref(), HistorySource::Assistant,
            json!({"id":"parent-answer","provenance":{"kind":"assistant"},
                "content":{"kind":"text","text":"Received the background finding."},"opaque":null}), None).unwrap();
        state(&mut db, &receiving_run, RunState::Completed);
        let owner = std::sync::Mutex::new(db);
        crate::catalog::child_delivery::reconcile_reports(&owner).unwrap();
        let mut db = owner.into_inner().unwrap();
        assert!(requests(&db.db, &receiving_run).unwrap().is_empty(), "a retrieval completion is not a new delegated request");
        assert!(db.pending_work_reports().unwrap().is_empty());
        let pending_count = |db: &Catalog| db.db.query_row(
            "SELECT count(*) FROM events WHERE subject=?1 AND kind='bot.request_report_pending'",
            [&message_id], |row| row.get::<_, i64>(0),
        ).unwrap();
        assert_eq!(pending_count(&db), 0, "completion must not publish a reply obligation");
        assert!(current(&db).is_empty());

        // Preserve a pending fact written by the old misclassification. Discovery must
        // recheck its real sender owner rather than retrying a forbidden private reply.
        let receiver = db.run(&receiving_run).unwrap();
        let tx = db.db.transaction().unwrap();
        event(&tx, &message_id, receiver.revision, "bot.request_report_pending",
            json!({"messageId":message_id,"runId":receiving_run})).unwrap();
        tx.commit().unwrap();
        assert!(db.pending_work_reports().unwrap().is_empty());
        assert!(current(&db).is_empty(), "an old false reply obligation cannot keep the parent current");
        drop(db);
        let owner = std::sync::Mutex::new(Catalog::open(&f.root).unwrap());
        for _ in 0..3 { crate::catalog::child_delivery::reconcile_reports(&owner).unwrap(); }
        let db = owner.into_inner().unwrap();
        assert_eq!(pending_count(&db), 1, "historical facts are preserved");
        assert!(db.pending_work_reports().unwrap().is_empty());
        assert!(current(&db).is_empty());
        let replay = db.capture_message("thread:parent", "branch:parent", &message_id).unwrap().load().unwrap();
        assert_eq!(replay.summary.receipt, result.summary.receipt);
        assert_eq!(replay.text, result.text);
        assert_eq!(db.history("branch:parent").unwrap().iter().filter(|item| item.id == message_id).count(), 1);
        assert!(db.capture_message("thread:parent", "branch:parent",
            &format!("message:bot-report:run:{receiving_run}:{message_id}")).is_err());
        assert!(db.capture_family_read("thread:parent", Some(&child.child_thread_id), None).is_err(),
            "the hidden retrieval remains outside public collaboration reads");
        assert!(db.prepare_user_message("forbidden-private-reply".into(), "thread:parent".into(), "branch:parent".into(),
            messages::MessageInput { attachments: vec![], after_current: None, source_agent: None, name: None, wait: None,
                target_thread_id: Some(child.child_thread_id.clone()), target_branch_id: Some(child.child_branch_id.clone()),
                reply_to: Some(message_id), kind: MessageKind::Inform, text: "Do not revive this private worker".into(),
            }).is_err(), "ordinary messages cannot reuse the internal delivery route");
        drop(db);
        std::fs::remove_dir_all(f.root).unwrap();
    }
}
