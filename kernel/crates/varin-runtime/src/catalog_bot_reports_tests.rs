use super::*;
#[path = "../tests/fixtures/child_dispatch.rs"]
mod child_fixture;
#[path = "../tests/fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;

#[test]
fn a_bot_preparation_failure_is_queued_once_with_its_original_report() {
    let mut fixture = child_fixture::Fixture::new_in_bot("bot");
    let child = fixture.accept();
    fixture
        .db
        .fail_child_preparation(&child.execution_id, "source_unavailable")
        .unwrap();
    let candidates = fixture.db.pending_bot_reports().unwrap();
    assert_eq!(candidates.len(), 1);
    let prepared = fixture
        .db
        .prepare_bot_report(candidates[0].clone())
        .unwrap()
        .load()
        .unwrap();
    let first = fixture.db.admit_message(prepared).unwrap();
    assert!(first.accepted);
    assert_eq!(
        first.receipt.identity.target_thread_id,
        child.parent_thread_id
    );
    assert_eq!(first.receipt.identity.kind, MessageKind::Request);
    assert_eq!(
        first.receipt.identity.message_id,
        format!("message:bot-report:{}", child.execution_id)
    );
    assert!(fixture.db.pending_bot_reports().unwrap().is_empty());
    let view = fixture
        .db
        .capture_message(
            &child.parent_thread_id,
            &child.parent_branch_id,
            &first.receipt.identity.message_id,
        )
        .unwrap()
        .load()
        .unwrap();
    assert!(view.text.contains("source_unavailable"));
    let prepared = fixture
        .db
        .prepare_bot_report(candidates[0].clone())
        .unwrap()
        .load()
        .unwrap();
    assert!(!fixture.db.admit_message(prepared).unwrap().accepted);
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordinary_agent_reports_queue_passively_and_acknowledge_only_the_history_boundary() {
    let mut fixture = child_fixture::Fixture::new();
    let child = fixture.accept();
    fixture.settle_exchange();
    fixture.db.fail_child_preparation(&child.execution_id, "source_unavailable").unwrap();
    let report = fixture.db.pending_bot_reports().unwrap().remove(0);
    let prepared = fixture.db.prepare_bot_report(report).unwrap().load().unwrap();
    let admitted = fixture.db.admit_message(prepared).unwrap();
    assert_eq!(admitted.receipt.identity.kind, MessageKind::Inform);
    let head = fixture.db.head(&child.parent_branch_id).unwrap();
    assert!(visible_report(&fixture.db.db, head.as_deref(), &child.execution_id).unwrap().is_none());
    assert!(fixture.db.capture_attention_read().load(&||false).unwrap().delivered_reports.is_empty());
    let prepared = fixture.db.prepare_input_delivery(&child.parent_run_id, fixture.db.epoch(), head.as_deref()).unwrap().load().unwrap();
    fixture.db.admit_input_delivery(prepared).unwrap().unwrap();
    let head = fixture.db.head(&child.parent_branch_id).unwrap();
    assert_eq!(visible_report(&fixture.db.db, head.as_deref(), &child.execution_id).unwrap().as_deref(), Some(admitted.receipt.identity.message_id.as_str()));
    let reports = fixture.db.capture_attention_read().load(&||false).unwrap().delivered_reports;
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].execution_id, child.execution_id);
    assert!(fixture.db.pending_bot_reports().unwrap().is_empty());
    let root = fixture.root.clone(); drop(fixture); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordinary_idle_and_cancelled_parents_keep_report_without_starting_another_run() {
    use crate::execution::ExecutionRecord;
    for cancelled in [false, true] {
        let mut f = child_fixture::Fixture::new();
        let child = f.accept(); f.settle_exchange();
        f.db.fail_child_preparation(&child.execution_id, "source_unavailable").unwrap();
        if cancelled { f.db.request_cancel_run(&child.parent_run_id).unwrap(); }
        f.db.commit_execution(&child.parent_run_id, f.db.epoch(), &ExecutionRecord::StateChanged {
            state: if cancelled { RunState::Cancelled } else { RunState::Completed }, waiting_on: None,
        }).unwrap();
        let runs: u64 = f.db.db.query_row("SELECT count(*) FROM runs", [], |r|read_number(r,0)).unwrap();
        let prepared = f.db.prepare_bot_report(f.db.pending_bot_reports().unwrap().remove(0)).unwrap().load().unwrap();
        let receipt = f.db.admit_message(prepared).unwrap().receipt;
        let input: inputs::QueuedInputMetadata = record(&f.db.db,"input_queue",&receipt.identity.message_id).unwrap();
        assert_eq!(input.state, InputState::Queued); assert_eq!(input.activation, inputs::InputActivation::Passive);
        assert!(input.run_id.is_none());
        assert_eq!(f.db.db.query_row("SELECT count(*) FROM runs", [], |r|read_number(r,0)).unwrap(), runs);
        assert_eq!(f.db.run(&child.parent_run_id).unwrap().state, if cancelled {RunState::Cancelled} else {RunState::Completed});
        let root=f.root.clone(); drop(f); std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn reopening_does_not_backfill_historical_reports_but_finishes_preupgrade_accepted_work() {
    let mut f=child_fixture::Fixture::new(); let child=f.accept(); f.settle_exchange();
    let root=f.root.clone(); drop(f.db);
    let mut db=Catalog::open(&root).unwrap();
    assert!(db.pending_bot_reports().unwrap().is_empty());
    db.fail_child_preparation(&child.execution_id,"ended_after_restart").unwrap();
    assert_eq!(db.pending_bot_reports().unwrap().len(),1);
    // This models a pre-feature terminal report: the original report is present, but
    // no publication event ever requested an automatic notification.
    db.db.execute("DELETE FROM events WHERE subject=?1 AND kind='bot.report_pending'",[&child.execution_id]).unwrap();
    drop(db); let db=Catalog::open(&root).unwrap();
    assert!(db.pending_bot_reports().unwrap().is_empty());
    assert!(db.delegated_execution(&child.execution_id).unwrap().report.is_some());
    drop(db); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bot_wait_and_background_delivery_consume_the_same_original_report() {
    let mut fixture = child_fixture::Fixture::new_in_bot("bot");
    let child = fixture.accept();
    fixture.settle_exchange();
    fixture
        .db
        .fail_child_preparation(&child.execution_id, "source_unavailable")
        .unwrap();
    let report = fixture.db.pending_bot_reports().unwrap().remove(0);
    let prepared = fixture
        .db
        .prepare_bot_report(report)
        .unwrap()
        .load()
        .unwrap();
    fixture.admit_wait("queued-bot-report");
    // The report worker captured the result just before the same request registered its Wait.
    let receipt = fixture.db.admit_message(prepared).unwrap();
    let waits = fixture.db.capture_child_waits().unwrap();
    assert_eq!(waits.len(), 1);
    for wait in waits {
        let prepared = wait.load().unwrap();
        fixture.db.admit_child_wait(prepared).unwrap();
    }
    assert!(fixture.db.pending_bot_reports().unwrap().is_empty());
    assert_eq!(
        fixture
            .db
            .execution_history(&child.parent_branch_id)
            .unwrap()
            .iter()
            .filter(|item| item.id == receipt.receipt.identity.message_id)
            .count(),
        1
    );
    let queued: bool = fixture
        .db
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM input_queue WHERE id=?1 AND state='queued')",
            [&receipt.receipt.identity.message_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!queued);
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bot_project_dispatch_waits_for_its_own_source_and_never_borrows_the_home_source() {
    let mut fixture = child_fixture::Fixture::new_project_dispatch();
    let child = fixture.accept();
    assert_eq!(child.project_id.as_deref(), Some("project-B"));
    assert!(matches!(
        child.source,
        collaboration::ChildSource::Project { .. }
    ));
    let source:launches::SourceSelection=serde_json::from_value(json!({"resource_owner":{"kind":"local"},"mode":"live_root","live_root":{"hostId":"local","rootId":"project-B-root","canonicalRoot":"/registered/project-B"},"workspace_id":"workspace-B","execution_workspace_id":"workspace-B","branch_id":null,"revision":null})).unwrap();
    let prepared = fixture
        .db
        .prepare_project_child_source(&child.execution_id, None, source.clone(), None)
        .unwrap()
        .load()
        .unwrap();
    let ready = fixture.db.attach_child_source(prepared).unwrap();
    assert_eq!(ready.source.selection(), Some(&source));
    assert!(ready.source.handoff().is_none());
    assert_eq!(
        ready.code_result,
        collaboration::ChildCodeResult::SharedSource
    );
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn bot_activity_pages_a_sessions_dispatch_and_its_report_newest_first() {
    let mut fixture = child_fixture::Fixture::new_in_bot("bot");
    let child = fixture.accept();
    fixture
        .db
        .fail_child_preparation(&child.execution_id, "source_unavailable")
        .unwrap();
    let read = |before| {
        serde_json::to_value(
            fixture
                .db
                .capture_bot_activity("bot", before, Some(1))
                .unwrap()
                .load(&|| false)
                .unwrap(),
        )
        .unwrap()
    };
    let newest = read(None);
    let report = &newest["events"][0];
    assert_eq!(newest["events"].as_array().unwrap().len(), 1);
    assert_eq!(report["kind"], "report");
    assert_eq!(report["outcome"], "failed");
    assert_eq!(report["threadId"], json!(child.child_thread_id));
    assert_eq!(report["sessionThreadId"], "thread:parent");
    assert!(report["atMs"].as_u64().is_some());
    assert!(
        newest["participants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["threadId"] == json!(child.child_thread_id))
    );
    let older = read(newest["before"].as_u64());
    let dispatch = &older["events"][0];
    assert_eq!(dispatch["kind"], "dispatch");
    assert_eq!(dispatch["task"], "Read the fixed file and report");
    assert_eq!(dispatch["operationId"], json!(child.operation_id));
    assert!(dispatch["atMs"].as_u64().is_some());
    assert!(older["before"].is_null());
    let whole = fixture
        .db
        .capture_bot_activity("bot", None, None)
        .unwrap()
        .load(&|| false)
        .unwrap();
    assert_eq!(whole.events.len(), 2);
    assert!(whole.before.is_none());
    assert!(
        fixture
            .db
            .capture_bot_activity("bot", None, None)
            .unwrap()
            .load(&|| true)
            .is_err()
    );
    let root = fixture.root.clone();
    drop(fixture);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn user_created_bot_child_reports_success_and_preparation_failure_once_as_agent_data() {
    use super::super::user_dispatch_tests::{Fixture, start_child};
    for success in [false, true] {
        let mut f = Fixture::new_in_bot();
        let child = f.accept();
        let child = if success {
            let child = start_child(&mut f.db, child);
            let run = f.db.run(&child.receipt.as_ref().unwrap().run_id).unwrap();
            f.db.transition_run(&run.id, f.db.epoch(), run.revision, RunState::Runnable)
                .unwrap();
            let head = f.db.head(&run.branch_id).unwrap();
            f.db.append_history(
                &run.id,
                f.db.epoch(),
                head.as_deref(),
                HistorySource::Assistant,
                serde_json::to_value(crate::execution::ConversationItem::<
                    crate::output::ResolvedMedia,
                > {
                    id: "answer".into(),
                    provenance: crate::execution::Provenance::Assistant,
                    content: crate::execution::Content::Text {
                        text: "Finished work".into(),
                    },
                    resource_activation: None,
                    opaque: None,
                })
                .unwrap(),
                None,
            )
            .unwrap();
            let run = f.db.run(&run.id).unwrap();
            f.db.transition_run(&run.id, f.db.epoch(), run.revision, RunState::Completed)
                .unwrap();
            for report in f.db.capture_child_reports().unwrap().load().unwrap() {
                f.db.admit_child_report(report).unwrap();
            }
            child
        } else {
            f.db.fail_child_preparation(&child.execution_id, "source_unavailable")
                .unwrap();
            child
        };
        let candidates = f.db.pending_bot_reports().unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].report.as_ref().unwrap().outcome,
            if success {
                Outcome::Succeeded
            } else {
                Outcome::Failed
            }
        );
        let prepared =
            f.db.prepare_bot_report(candidates[0].clone())
                .unwrap()
                .load()
                .unwrap();
        let admitted = f.db.admit_message(prepared).unwrap();
        assert!(admitted.accepted);
        if success {
            let view=f.db.capture_message(&child.parent_thread_id,&child.parent_branch_id,&admitted.receipt.identity.message_id).unwrap().load().unwrap();
            assert!(view.text.contains("Finished work"));
        }
        assert_eq!(
            admitted.receipt.identity.actor,
            messages::MessageActor::AgentReport {
                execution_id: child.execution_id.clone(),
                operation_id: child.operation_id.clone()
            }
        );
        let queued: inputs::QueuedInputMetadata = record(
            &f.db.db,
            "input_queue",
            &admitted.receipt.identity.message_id,
        )
        .unwrap();
        assert_eq!(queued.origin.history_source(), HistorySource::Agent);
        assert!(f.db.pending_bot_reports().unwrap().is_empty());
        let retry =
            f.db.prepare_bot_report(candidates[0].clone())
                .unwrap()
                .load()
                .unwrap();
        assert!(!f.db.admit_message(retry).unwrap().accepted);
        assert!(f.db.capture_child_receipts().unwrap().is_empty());
    }
}

fn report_fixture() -> child_fixture::Fixture {
    use crate::execution::ToolSchema;
    let schema=|name:&str| ToolSchema {requirements:None,name:name.into(),version:"1".into(),description:String::new(),schema:json!({"type":"object"}),output_schema:None,metadata:None};
    let mut fixture=child_fixture::Fixture::new_parent_custom(7,schema("file_read"),schema("dispatch"),false,false,false,
        |_,launch| { launch.tools.push(schema(collaboration::REPORT_TOOL)); launch.tools.push(schema(crate::tool_disclosure::INVOKE)); launch.tools.push(schema("script_run")); });
    // Freeze the actual child subset, including its existing native gateway.
    let directory=fixture.db.capture_child_dispatch_invocation(&fixture.context).unwrap().load().unwrap();
    let selected=directory.resolve(&fixture.input).unwrap();
    fixture.launch.tools=directory.frozen.allowed_delegation.into_iter()
        .filter(|tool|selected.profile.tools.contains(&tool.name)).collect();
    fixture
}

#[test]
fn only_committed_successful_report_reads_consume_queued_reports_and_waits_reuse_history() {
    use crate::execution::*;
    for succeeded in [false,true] {
        let mut f=report_fixture(); let child=f.accept(); f.settle_exchange();
        f.db.fail_child_preparation(&child.execution_id,"source_unavailable").unwrap();
        let prepared=f.db.prepare_bot_report(f.db.pending_bot_reports().unwrap().remove(0)).unwrap().load().unwrap();
        let message=f.db.admit_message(prepared).unwrap().receipt.identity.message_id;
        let original: ModelStep=record(&f.db.db,"model_steps","parent-request").unwrap();
        let mut snapshot=f.db.content.load_snapshot(&original.request).unwrap();
        let request="read-original-report";
        snapshot.view.request_id=request.into();
        snapshot.view.history=f.db.execution_history(&child.parent_branch_id).unwrap();
        snapshot.view.binding.history_range.leaf_id=f.db.head(&child.parent_branch_id).unwrap();
        snapshot.view.origin=RequestOrigin::Conversation {compaction:None,step:2,history_range:snapshot.view.binding.history_range.clone()};
        let call=ToolCall{call_id:"read-report".into(),name:collaboration::REPORT_TOOL.into(),schema_version:"1".into(),arguments:json!({"operationId":child.operation_id})};
        let context=ToolExecutionContext{run_id:child.parent_run_id.clone(),operation_id:format!("{request}:tool:{}",call.call_id),origin:ToolOrigin::ModelStep{request_id:request.into()}};
        for record in [ExecutionRecord::RequestPrepared{snapshot:snapshot.into()},ExecutionRecord::ModelDispatched{request_id:request.into()},
            ExecutionRecord::ModelFinished{request_id:request.into(),outcome:ModelOutcome::Completed,finish_reason:Some(FinishReason::ToolCalls),items:vec![ProviderItem{id:"read-call".into(),content:Content::ToolCall{call:call.clone()},opaque:None}],interrupted_deltas:vec![],usage:UsageReceipt::default(),failure:None},
            ExecutionRecord::ToolAdmitted{context:context.clone(),tool:AdmittedTool{call:call.clone(),contract:ToolContract{name:call.name.clone(),schema_version:call.schema_version.clone(),read_only:true,completion:CompletionKind::Result,lifetime:Lifetime::Run,resources:vec![]}}},
            ExecutionRecord::ToolDispatched{context:context.clone(),executor_owner:ExecutorOwner::Kernel}] {
            f.db.commit_execution(&child.parent_run_id,f.db.epoch(),&record).unwrap();
        }
        f.db.record_child_report_read(&context,&child.execution_id).unwrap();
        let head=f.db.head(&child.parent_branch_id).unwrap();
        assert!(visible_report(&f.db.db,head.as_deref(),&child.execution_id).unwrap().is_none());
        let result=ToolResult{request_id:request.into(),call_id:call.call_id.clone(),completion:ToolCompletion::Result{
            outcome:if succeeded{Outcome::Succeeded}else{Outcome::Failed},effect:Effect::None,
            content:crate::output::OutputBody::text("Original source_unavailable preparation report")}};
        f.db.commit_execution(&child.parent_run_id,f.db.epoch(),&ExecutionRecord::ToolSettled{context,completion:result.completion.clone(),executor_stopped:true}).unwrap();
        // Settling the tool is still not a history receipt.
        let head=f.db.head(&child.parent_branch_id).unwrap();
        assert!(visible_report(&f.db.db,head.as_deref(),&child.execution_id).unwrap().is_none());
        f.db.commit_execution(&child.parent_run_id,f.db.epoch(),&ExecutionRecord::ToolBatchCommitted{request_id:request.into(),results:vec![result]}).unwrap();
        let head=f.db.head(&child.parent_branch_id).unwrap();
        assert_eq!(visible_report(&f.db.db,head.as_deref(),&child.execution_id).unwrap().is_some(),succeeded);
        let queued:inputs::QueuedInputMetadata=record(&f.db.db,"input_queue",&message).unwrap();
        assert_eq!(queued.state,if succeeded{InputState::Cancelled}else{InputState::Queued});
        if succeeded {
            let before=f.db.history(&child.parent_branch_id).unwrap().len();
            f.admit_wait("after-explicit-report-read");
            let after_wait=f.db.history(&child.parent_branch_id).unwrap().len();
            assert!(after_wait>before);
            for wait in f.db.capture_child_waits().unwrap() { f.db.admit_child_wait(wait.load().unwrap()).unwrap(); }
            // Wait completion only returns the original result entry; no second report body.
            assert_eq!(f.db.history(&child.parent_branch_id).unwrap().len(),after_wait);
        }
        let root=f.root.clone(); drop(f); std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn exact_wait_keeps_its_selected_execution_and_validates_the_original_short_selector() {
    use crate::execution::*;
    let mut f=child_fixture::Fixture::new(); let child=f.accept(); f.settle_exchange();
    let reference=f.db.execution_reference(&child.execution_id).unwrap();
    let context=f.admit_policy_call(ToolCall{call_id:"exact-wait".into(),name:collaboration::WAIT_TOOL.into(),schema_version:"1".into(),arguments:json!({"target":reference.reference})});
    let prepared=f.db.prepare_delegated_wait_registration(&context,&child.operation_id,&child.execution_id).unwrap().load().unwrap();
    let wait=f.db.register_child_wait(prepared).unwrap();
    assert_eq!(wait.subject,child.execution_id); assert_eq!(wait.kind,"child.report_ready");
    f.db.fail_child_preparation(&child.execution_id,"source_unavailable").unwrap();
    let prepared=f.db.prepare_delegated_wait_registration(&context,&child.operation_id,&child.execution_id).unwrap().load().unwrap();
    assert_eq!(f.db.register_child_wait(prepared).unwrap().id,wait.id);
    let root=f.root.clone(); drop(f); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn published_gateway_reports_acknowledge_only_successful_outer_history_and_not_script_reads() {
    use crate::execution::*;
    for (gateway,succeeded) in [(true,true),(true,false),(false,true)] {
        let mut f=report_fixture(); let child=f.accept(); f.settle_exchange();
        f.db.fail_child_preparation(&child.execution_id,"source_unavailable").unwrap();
        let pending=f.db.pending_bot_reports().unwrap().remove(0);
        let prepared=f.db.prepare_bot_report(pending).unwrap().load().unwrap();
        let message=f.db.admit_message(prepared).unwrap().receipt.identity.message_id;
        let original: ModelStep=record(&f.db.db,"model_steps","parent-request").unwrap();
        let mut snapshot=f.db.content.load_snapshot(&original.request).unwrap();
        let request="gateway-report";
        snapshot.view.request_id=request.into();
        snapshot.view.history=f.db.execution_history(&child.parent_branch_id).unwrap();
        snapshot.view.binding.history_range.leaf_id=f.db.head(&child.parent_branch_id).unwrap();
        snapshot.view.origin=RequestOrigin::Conversation {compaction:None,step:2,history_range:snapshot.view.binding.history_range.clone()};
        let call=ToolCall{call_id:"gateway".into(),name:if gateway{crate::tool_disclosure::INVOKE}else{"script_run"}.into(),schema_version:"1".into(),arguments:json!({"name":collaboration::REPORT_TOOL,"arguments":{"operationId":child.operation_id}})};
        let origin=ToolOrigin::ModelStep{request_id:request.into()};
        let outer=ToolExecutionContext{run_id:child.parent_run_id.clone(),operation_id:origin.operation_id(&call.call_id),origin};
        let contract=|call:&ToolCall| ToolContract{name:call.name.clone(),schema_version:call.schema_version.clone(),read_only:true,completion:CompletionKind::Result,lifetime:Lifetime::Run,resources:vec![]};
        for record in [ExecutionRecord::RequestPrepared{snapshot:snapshot.into()},ExecutionRecord::ModelDispatched{request_id:request.into()},
            ExecutionRecord::ModelFinished{request_id:request.into(),outcome:ModelOutcome::Completed,finish_reason:Some(FinishReason::ToolCalls),items:vec![ProviderItem{id:"gateway-call".into(),content:Content::ToolCall{call:call.clone()},opaque:None}],interrupted_deltas:vec![],usage:UsageReceipt::default(),failure:None},
            ExecutionRecord::ToolAdmitted{context:outer.clone(),tool:AdmittedTool{contract:contract(&call),call:call.clone()}},
            ExecutionRecord::ToolDispatched{context:outer.clone(),executor_owner:ExecutorOwner::Kernel}] {
            f.db.commit_execution(&child.parent_run_id,f.db.epoch(),&record).unwrap();
        }
        // Use the real live nested-call scope. Fabricating a NestedCall context
        // bypasses the invocation registry and is rightly rejected by admission.
        let frozen=f.db.capture_tool_invocation(&outer,&call.call_id).unwrap().load().unwrap().frozen;
        let registry=f.db.nested_tools();
        let fixture=std::sync::Arc::new(std::sync::Mutex::new(f));
        let callback_fixture=fixture.clone();
        let execution_id=child.execution_id.clone();
        let scope=registry.register(outer.clone(),ExecutorOwner::Kernel,std::sync::Arc::new(frozen),CancellationToken::default(),
            std::sync::Arc::new(move |context,call| {
                let mut f=callback_fixture.lock().unwrap();
                let epoch=f.db.epoch();
                for record in [ExecutionRecord::ToolAdmitted{context:context.clone(),tool:AdmittedTool{contract:contract(&call),call:(*call).clone()}},
                    ExecutionRecord::ToolDispatched{context:context.clone(),executor_owner:ExecutorOwner::Kernel}] {
                    f.db.commit_execution(&context.run_id,epoch,&record).unwrap();
                }
                f.db.record_child_report_read(&context,&execution_id).unwrap();
                let completion=ToolCompletion::Result{outcome:Outcome::Succeeded,effect:Effect::None,content:crate::output::OutputBody::text("Original source_unavailable report")};
                f.db.commit_execution(&context.run_id,epoch,&ExecutionRecord::ToolSettled{context:context.clone(),completion:completion.clone(),executor_stopped:true}).unwrap();
                Ok(ToolExecutionReceipt{completion,executor_stopped:true})
            })).unwrap();
        let nested=registry.invoke(&outer.operation_id,&ExecutorOwner::Kernel,crate::nested_tools::NestedToolInput{
            call_id:"report".into(),name:collaboration::REPORT_TOOL.into(),arguments:json!({"operationId":child.operation_id})}).unwrap();
        let mut f=fixture.lock().unwrap();
        let epoch=f.db.epoch();
        let completion=|outcome| ToolCompletion::Result{outcome,effect:Effect::None,content:crate::output::OutputBody::text("Original source_unavailable report")};
        if gateway {
            f.db.forward_nested_report_read(&outer.operation_id,&nested.operation_id).unwrap();
            f.db.forward_nested_report_read(&outer.operation_id,&nested.operation_id).unwrap();
        } else {
            assert!(f.db.forward_nested_report_read(&outer.operation_id,&nested.operation_id).is_err());
        }
        assert!(f.db.capture_attention_read().load(&||false).unwrap().delivered_reports.is_empty());
        let result=ToolResult{request_id:request.into(),call_id:call.call_id,completion:completion(if succeeded{Outcome::Succeeded}else{Outcome::Failed})};
        f.db.commit_execution(&child.parent_run_id,epoch,&ExecutionRecord::ToolSettled{context:outer,completion:result.completion.clone(),executor_stopped:true}).unwrap();
        f.db.commit_execution(&child.parent_run_id,epoch,&ExecutionRecord::ToolBatchCommitted{request_id:request.into(),results:vec![result]}).unwrap();
        let queued:inputs::QueuedInputMetadata=record(&f.db.db,"input_queue",&message).unwrap();
        assert_eq!(queued.state,if gateway && succeeded{InputState::Cancelled}else{InputState::Queued});
        assert_eq!(f.db.capture_attention_read().load(&||false).unwrap().delivered_reports.len(),usize::from(gateway&&succeeded));
        let root=f.root.clone();drop(f);drop(scope);drop(fixture);std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn report_read_in_another_parent_fork_does_not_clear_requester_pending_work() {
    let mut f=child_fixture::Fixture::new();let child=f.accept();f.settle_exchange();
    f.db.fail_child_preparation(&child.execution_id,"source_unavailable").unwrap();
    let prepared=f.db.prepare_bot_report(f.db.pending_bot_reports().unwrap().remove(0)).unwrap().load().unwrap();
    let report=f.db.admit_message(prepared).unwrap().receipt;
    let head=f.db.head(&child.parent_branch_id).unwrap();
    f.db.fork_branch(&child.parent_branch_id,"other-parent-fork",head.as_deref()).unwrap();
    let configuration=f.db.run(&child.parent_run_id).unwrap().configuration;
    let fork=f.db.submit(&SubmitInput{key:"fork-report-reader".into(),thread_id:child.parent_thread_id.clone(),branch_id:"other-parent-fork".into(),expected_head:head,input:json!("Read the exact report in this fork"),configuration}).unwrap();
    let receiving=f.db.run(&fork.run_id).unwrap();let head=f.db.head(&fork.branch_id).unwrap();
    let item=f.db.append_history(&fork.run_id,f.db.epoch(),head.as_deref(),HistorySource::Tool,json!({"report":"actual exact report read"}),None).unwrap();
    let tx=f.db.db.transaction().unwrap();record_history_delivery(&tx,&receiving,&child.execution_id,&item.id).unwrap();tx.commit().unwrap();
    let current=|db:&Catalog|db.capture_family_read(&child.parent_thread_id,None,None).unwrap().directory_page(false,
        family::FamilyListQuery{scope:Some("current".into()),query:Some(child.agent_id.clone()),..Default::default()},&||false).unwrap().members;
    assert_eq!(current(&f.db).len(),1,"another branch reading the report does not deliver it to the requester");
    let queued:inputs::QueuedInputMetadata=record(&f.db.db,"input_queue",&report.identity.message_id).unwrap();
    assert_eq!(queued.state,InputState::Queued);
    let head=f.db.head(&child.parent_branch_id).unwrap();
    let prepared=f.db.prepare_input_delivery(&child.parent_run_id,f.db.epoch(),head.as_deref()).unwrap().load().unwrap();
    f.db.admit_input_delivery(prepared).unwrap().unwrap();
    assert!(current(&f.db).is_empty());
    let root=f.root.clone();drop(f);std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn frozen_report_receiver_consumes_original_ids_from_wait_and_background_delivery() {
    use crate::execution::*;
    for waiting in [false, true] {
        // Original main declarations, including same-version operationId/itemId requirements.
        let readers: Vec<ToolSchema> = serde_json::from_str(include_str!("../tests/fixtures/collaboration_readers_main.json")).unwrap();
        let status = readers.iter().find(|schema| schema.name == collaboration::STATUS_TOOL).unwrap().clone();
        let dispatch = ToolSchema {requirements:None,name:collaboration::DISPATCH_TOOL.into(),version:"1".into(),description:String::new(),schema:json!({"type":"object"}),output_schema:None,metadata:None};
        let mut f = child_fixture::Fixture::new_parent_custom(0, status, dispatch, false, false, false,
            move |input, launch| {
                input.tools = Some(vec![collaboration::STATUS_TOOL.into()]);
                launch.tools.retain(|schema| schema.name == collaboration::DISPATCH_TOOL);
                launch.tools.extend(readers);
            });
        let child = f.accept();
        let accepted = f.db.capture_call_completion(&child.operation_id).unwrap().load().unwrap();
        let ToolCompletion::JobAccepted {content:Some(content),..} = &accepted else {panic!("dispatch acceptance")};
        assert!(content.model_data.is_none());
        assert_eq!(content.model_data()["operationId"], child.operation_id);
        f.settle_exchange();
        let mut source = child.source.pin().unwrap().source.clone();
        source.branch_id = Some(format!("child-source:{}", child.execution_id));
        source.revision = Some(0);
        let proposal = context::ContextProposal {key:"reader-context".into(),branch_id:child.child_branch_id.clone(),through_id:None,
            expected_revision:0,summary:String::new(),effective_system_prompt:"Original report".into(),instruction_sources:vec![],memory_checkpoint:None};
        let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
            "configurationDigest":"reader-report","memorySnapshot":{"revision":0,"memories":[]},"threadId":child.child_thread_id,"projectId":child.project_id,
            "originalSections":[{"name":"preamble","content":"Original report"}],"instructionSources":[]})).unwrap();
        let child = f.db.prepare_child(&child.execution_id, source, proposal, basis).unwrap();
        let run = child.receipt.as_ref().unwrap().run_id.clone();
        f.db.commit_execution(&run,f.db.epoch(),&ExecutionRecord::StateChanged {state:RunState::Runnable,waiting_on:None}).unwrap();
        let head = f.db.head(&child.child_branch_id).unwrap();
        f.db.append_history(&run,f.db.epoch(),head.as_deref(),HistorySource::Assistant,
            serde_json::to_value(ConversationItem::<crate::output::ResolvedMedia>{id:"actual-reader-answer".into(),resource_activation:None,
                provenance:Provenance::Assistant,content:Content::Text{text:"Original report answer".into()},opaque:None}).unwrap(),None).unwrap();
        f.db.commit_execution(&run,f.db.epoch(),&ExecutionRecord::StateChanged {state:RunState::Completed,waiting_on:None}).unwrap();
        f.db.reconcile_child_reports().unwrap();
        let expected_report = f.db.child_task(&child.operation_id).unwrap().report.unwrap();
        let message_id = if waiting {
            let wait = f.admit_wait("real-frozen-reader");
            let acceptance = f.db.capture_call_completion(wait.id.strip_prefix("child-wait:").unwrap()).unwrap().load().unwrap();
            let ToolCompletion::JobAccepted{content:Some(output),..}=acceptance else {panic!("wait acceptance")};
            assert!(output.model_data.is_none());
            assert_eq!(output.model_data()["operationId"], child.operation_id);
            f.db.deliver_child_waits().unwrap();
            format!("child-report:{}:{}", child.parent_branch_id, child.execution_id)
        } else {
            let execution = f.db.pending_bot_reports().unwrap().remove(0);
            let prepared = f.db.prepare_bot_report(execution).unwrap().load().unwrap();
            let message = f.db.admit_message(prepared).unwrap();
            let head = f.db.head(&child.parent_branch_id).unwrap();
            let prepared = f.db.prepare_input_delivery(&child.parent_run_id,f.db.epoch(),head.as_deref()).unwrap().load().unwrap();
            f.db.admit_input_delivery(prepared).unwrap().unwrap();
            message.receipt.identity.message_id
        };
        let root=f.root.clone(); drop(f.db);
        let db=Catalog::open(&root).unwrap();
        let item=db.execution_history(&child.parent_branch_id).unwrap().into_iter().find(|item|item.id==message_id).unwrap();
        let Content::Output{output}=&item.content else {panic!("typed report")};
        assert!(output.model_data.is_none(),"the actual receiver, not the sender's smaller tool subset, controls compatibility");
        assert_eq!(output.model_data()["report"]["history_ids"],json!(expected_report.history_ids));
        assert!(!output.parts.iter().any(|part|matches!(part,crate::output::OutputPart::Text{text} if text.contains("child_report target="))));
        let item=output.model_data()["report"]["history_ids"][0].as_str().unwrap();
        let page=db.capture_child_report(&child.operation_id,item,0,65536).unwrap().load().unwrap();
        assert_eq!(page.text,"Original report answer");
        assert_eq!(db.capture_call_completion(&child.operation_id).unwrap().load().unwrap(),accepted);
        drop(db);std::fs::remove_dir_all(root).unwrap();
    }
}
