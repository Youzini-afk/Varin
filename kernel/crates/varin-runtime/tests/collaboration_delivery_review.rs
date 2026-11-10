//! Report visibility follows a completed frozen request, never observation publication.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::json;
use std::sync::Arc;
use varin_runtime::{
    catalog::{
        collaboration::ChildTask, context::ContextProposal, delegated::ChildContinuationCommand,
        family::CollaborationSnapshot,
    },
    execution::*,
    RunState,
};

fn observe(f: &mut Fixture) -> Arc<ConversationItem> {
    let run = f.context.run_id.clone();
    observe_for(f, &run)
}
fn observe_for(f: &mut Fixture, run: &str) -> Arc<ConversationItem> {
    let branch = f.db.run(run).unwrap().branch_id;
    let head = f.db.head(&branch).unwrap();
    let context =
        f.db.prepare_context_read(run, f.db.epoch(), head.as_deref())
            .unwrap()
            .map(|read| read.load().unwrap());
    let history = context
        .as_ref()
        .map(|c| c.history.clone())
        .unwrap_or_else(|| f.db.execution_history(&branch).unwrap());
    let preparation =
        f.db.prepare_collaboration_observation(
            run,
            f.db.epoch(),
            head.as_deref(),
            context.as_ref().map(|c| c.checkpoint_id.as_str()),
            &history,
        )
        .unwrap()
        .unwrap();
    f.db.admit_input_delivery(preparation.load().unwrap())
        .unwrap()
        .unwrap()
        .items
        .pop()
        .unwrap()
}
fn snapshot(f: &Fixture, request: &str, item: Arc<ConversationItem>) -> RequestSnapshot {
    snapshot_for(f, &f.context.run_id, request, item)
}
fn snapshot_for(
    f: &Fixture,
    run: &str,
    request: &str,
    item: Arc<ConversationItem>,
) -> RequestSnapshot {
    let branch = f.db.run(run).unwrap().branch_id;
    let launch = f.db.launch_intent(run).unwrap().unwrap().selection;
    let range = HistoryRange {
        branch_id: branch.clone(),
        ancestor_id: None,
        leaf_id: f.db.head(&branch).unwrap(),
    };
    RequestSnapshot {
        view: RequestView {
            request_id: request.into(),
            run_id: run.into(),
            origin: RequestOrigin::Conversation {
                compaction: None,
                step: 2,
                history_range: range.clone(),
            },
            binding: RequestBinding {
                pricing: None,
                tool_output_visible_bytes: None,
                mcp_tools: vec![],
                execution_environment: None,
                direct_tools: None,
                provider_id: None,
                tokenizer: None,
                request_context: None,
                child_dispatch: f
                    .db
                    .launch_metadata(run)
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
                history_range: range,
            },
            history: vec![item],
        },
        serialized: json!({}).into(),
    }
}
fn commit(f: &mut Fixture, record: ExecutionRecord) {
    f.db.commit_execution(&f.context.run_id, f.db.epoch(), &record)
        .unwrap();
}
fn completed(request: &str) -> ExecutionRecord {
    ExecutionRecord::ModelFinished {
        request_id: request.into(),
        outcome: ModelOutcome::Completed,
        finish_reason: Some(FinishReason::Stop),
        items: vec![ProviderItem {
            id: "answer".into(),
            content: Content::Text {
                text: "Received the report".into(),
            },
            opaque: None,
        }],
        interrupted_deltas: vec![],
        usage: UsageReceipt::default(),
        failure: None,
    }
}
fn current(f: &Fixture) -> CollaborationSnapshot {
    f.db.capture_family_read("thread:parent", None, None)
        .unwrap()
        .collaboration_snapshot("branch:parent")
        .unwrap()
}
fn cancelled_child() -> Fixture {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    f.db.cancel_child(&child.operation_id).unwrap();
    assert_eq!(current(&f).members.len(), 1);
    f
}
fn cleanup(f: Fixture) {
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

fn prepare_child(f: &mut Fixture, child: ChildTask) -> ChildTask {
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.execution_id));
    source.revision = Some(0);
    let proposal = ContextProposal {
        key: format!("report-context:{}", child.execution_id),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Read-only child".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"collaboration-delivery-test","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":child.child_thread_id,"projectId":child.project_id,"originalSections":[],"instructionSources":[]})).unwrap();
    f.db.prepare_child(&child.execution_id, source, proposal, basis)
        .unwrap()
}

fn report_deliveries(f: &Fixture, execution: &str, cursor: u64) -> usize {
    let read = rusqlite::Connection::open_with_flags(
        f.root.join("conversation.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let count: i64 = read.query_row(
        "SELECT count(*) FROM deliveries WHERE observer=?1 AND fact_cursor=?2 AND state='\"committed\"'",
        rusqlite::params![format!("agent-status:{execution}"), i64::try_from(cursor).unwrap()],
        |row| row.get(0),
    )
    .unwrap();
    usize::try_from(count).unwrap()
}

#[test]
fn only_completed_frozen_observation_acknowledges_the_original_report_once() {
    let mut f = cancelled_child();
    let item = observe(&mut f);
    let observed = CollaborationSnapshot::from_item(&item).unwrap().unwrap();
    assert_eq!(observed.report_refs().len(), 1);
    assert_eq!(
        current(&f),
        observed,
        "durable history alone is not model receipt"
    );
    let request = snapshot(&f, "report-consumer", item);
    commit(
        &mut f,
        ExecutionRecord::RequestPrepared {
            snapshot: request.into(),
        },
    );
    assert_eq!(current(&f), observed);
    commit(
        &mut f,
        ExecutionRecord::ModelDispatched {
            request_id: "report-consumer".into(),
        },
    );
    assert_eq!(current(&f), observed);
    commit(&mut f, completed("report-consumer"));
    assert!(current(&f).is_empty());
    let before = f.db.events_after(0, 1000).unwrap().len();
    commit(&mut f, completed("report-consumer"));
    assert_eq!(f.db.events_after(0, 1000).unwrap().len(), before);
    let empty = observe(&mut f);
    assert!(CollaborationSnapshot::from_item(&empty)
        .unwrap()
        .unwrap()
        .is_empty());
    cleanup(f);
}

#[test]
fn failed_request_does_not_acknowledge_a_report_in_its_frozen_history() {
    let mut f = cancelled_child();
    let item = observe(&mut f);
    let request = snapshot(&f, "failed-report-consumer", item);
    commit(
        &mut f,
        ExecutionRecord::RequestPrepared {
            snapshot: request.into(),
        },
    );
    commit(
        &mut f,
        ExecutionRecord::ModelDispatched {
            request_id: "failed-report-consumer".into(),
        },
    );
    commit(
        &mut f,
        ExecutionRecord::ModelFinished {
            request_id: "failed-report-consumer".into(),
            outcome: ModelOutcome::Failed,
            finish_reason: None,
            items: vec![],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: Some(ModelFailure {
                code: "provider_failed".into(),
                message: "fixture failure".into(),
                tool_name: None,
                retry_after_ms: None,
                provider_request_id: None,
            }),
        },
    );
    assert_eq!(current(&f).members.len(), 1);
    cleanup(f);
}

#[test]
fn matching_source_and_id_cannot_acknowledge_modified_observation_contents() {
    let mut f = cancelled_child();
    let item = observe(&mut f);
    let mut observed = CollaborationSnapshot::from_item(&item).unwrap().unwrap();
    observed.members[0].name.push_str(" forged");
    let forged = observed.to_item(&item.id).unwrap();
    let request = snapshot(&f, "forged-report-consumer", Arc::new(forged));
    commit(
        &mut f,
        ExecutionRecord::RequestPrepared {
            snapshot: request.into(),
        },
    );
    commit(
        &mut f,
        ExecutionRecord::ModelDispatched {
            request_id: "forged-report-consumer".into(),
        },
    );
    let error =
        f.db.commit_execution(
            &f.context.run_id,
            f.db.epoch(),
            &completed("forged-report-consumer"),
        )
        .unwrap_err();
    assert!(
        error.to_string().contains("matching original observation"),
        "{error}"
    );
    assert_eq!(current(&f).members.len(), 1);
    cleanup(f);
}

#[test]
fn a_stale_frozen_range_cannot_acknowledge_a_new_observation() {
    let mut f = cancelled_child();
    let prior_head = f.db.head("branch:parent").unwrap();
    let item = observe(&mut f);
    let mut request = snapshot(&f, "off-branch-report-consumer", item);
    request.view.binding.history_range.leaf_id = prior_head.clone();
    if let RequestOrigin::Conversation { history_range, .. } = &mut request.view.origin {
        history_range.leaf_id = prior_head;
    }
    let error =
        f.db.commit_execution(
            &f.context.run_id,
            f.db.epoch(),
            &ExecutionRecord::RequestPrepared {
                snapshot: request.into(),
            },
        )
        .unwrap_err();
    assert!(
        error.to_string().contains("request history head changed"),
        "{error}"
    );
    assert_eq!(current(&f).members.len(), 1);
    cleanup(f);
}

#[test]
fn completed_request_receives_an_older_retained_report_after_failed_delivery_and_continuation() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let child = prepare_child(&mut f, child);
    let child_run = child.receipt.as_ref().unwrap().run_id.clone();
    for state in [RunState::Runnable, RunState::Completed] {
        f.db.commit_execution(
            &child_run,
            f.db.epoch(),
            &ExecutionRecord::StateChanged {
                state,
                waiting_on: None,
            },
        )
        .unwrap();
    }
    f.db.reconcile_child_reports().unwrap();
    let first = observe(&mut f);
    let original = CollaborationSnapshot::from_item(&first)
        .unwrap()
        .unwrap()
        .report_refs()
        .pop()
        .unwrap();
    assert_eq!(original.execution_id, child.execution_id);
    let request = snapshot(&f, "first-report-fails", first.clone());
    commit(
        &mut f,
        ExecutionRecord::RequestPrepared {
            snapshot: request.into(),
        },
    );
    commit(
        &mut f,
        ExecutionRecord::ModelDispatched {
            request_id: "first-report-fails".into(),
        },
    );
    commit(
        &mut f,
        ExecutionRecord::ModelFinished {
            request_id: "first-report-fails".into(),
            outcome: ModelOutcome::Failed,
            finish_reason: None,
            items: vec![],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: Some(ModelFailure {
                code: "provider_failed".into(),
                message: "fixture failure".into(),
                tool_name: None,
                retry_after_ms: None,
                provider_request_id: None,
            }),
        },
    );
    assert_eq!(
        report_deliveries(&f, &original.execution_id, original.report_cursor),
        0
    );

    f.db.mark_child_resources_released(&child.execution_id)
        .unwrap();
    let command = ChildContinuationCommand {
        key: "continue-before-report-retry".into(),
        source_agent: None,
        name: None,
        child_operation_id: child.operation_id,
        previous_run_id: child_run,
        expected_head: f.db.head(&child.child_branch_id).unwrap(),
        input: json!({"text":"Continue the next part"}),
    };
    let prepared =
        f.db.capture_child_continuation(command)
            .unwrap()
            .load()
            .unwrap();
    let second_execution = f.db.accept_child_continuation(prepared).unwrap();
    assert_ne!(second_execution.execution_id, original.execution_id);
    let second = observe(&mut f);
    let second_state = CollaborationSnapshot::from_item(&second).unwrap().unwrap();
    assert!(
        second_state.report_refs().is_empty(),
        "CURRENT now describes execution 2"
    );
    assert_ne!(first.id, second.id);
    let history = f.db.execution_history("branch:parent").unwrap();
    assert!(history.iter().any(|item| item == &first));
    assert!(history.iter().any(|item| item == &second));
    let mut request = snapshot(&f, "retained-report-succeeds", second);
    request.view.history = history;
    commit(
        &mut f,
        ExecutionRecord::RequestPrepared {
            snapshot: request.into(),
        },
    );
    commit(
        &mut f,
        ExecutionRecord::ModelDispatched {
            request_id: "retained-report-succeeds".into(),
        },
    );
    commit(&mut f, completed("retained-report-succeeds"));
    assert_eq!(
        report_deliveries(&f, &original.execution_id, original.report_cursor),
        1
    );
    assert_eq!(
        current(&f),
        second_state,
        "receipt of execution 1 does not hide active execution 2"
    );
    commit(&mut f, completed("retained-report-succeeds"));
    assert_eq!(
        report_deliveries(&f, &original.execution_id, original.report_cursor),
        1
    );
    cleanup(f);
}

#[test]
fn a_siblings_completed_same_scope_observation_cannot_acknowledge_the_parents_report() {
    let mut f = Fixture::new();
    let reader = f.accept();
    f.settle_exchange();
    let dispatch = f.admit_policy_call(ToolCall {
        call_id: "reported-sibling".into(),
        name: "dispatch".into(),
        schema_version: "1".into(),
        arguments: serde_json::to_value(&f.input).unwrap(),
    });
    let sibling =
        f.db.accept_child(&dispatch, f.input.clone(), f.pin.clone(), f.launch.clone())
            .unwrap();
    f.settle_policy_call(&dispatch, "preparing_child");
    f.db.cancel_child(&sibling.operation_id).unwrap();
    let reader = prepare_child(&mut f, reader);
    let reader_run = reader.receipt.as_ref().unwrap().run_id.clone();
    f.db.commit_execution(
        &reader_run,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    let item = observe_for(&mut f, &reader_run);
    let observation = CollaborationSnapshot::from_item(&item).unwrap().unwrap();
    assert_eq!(observation.caller_branch_id, reader.child_branch_id);
    let report = observation
        .report_refs()
        .into_iter()
        .find(|report| report.execution_id == sibling.execution_id)
        .unwrap();
    let request = snapshot_for(&f, &reader_run, "sibling-sees-report", item);
    for record in [
        ExecutionRecord::RequestPrepared {
            snapshot: request.into(),
        },
        ExecutionRecord::ModelDispatched {
            request_id: "sibling-sees-report".into(),
        },
        completed("sibling-sees-report"),
    ] {
        f.db.commit_execution(&reader_run, f.db.epoch(), &record)
            .unwrap();
    }
    assert_eq!(
        report_deliveries(&f, &report.execution_id, report.report_cursor),
        0
    );
    assert!(
        current(&f).report_refs().contains(&report),
        "the actual recipient still has the unread report"
    );
    let item = observe(&mut f);
    let request = snapshot(&f, "parent-receives-report", item);
    commit(
        &mut f,
        ExecutionRecord::RequestPrepared {
            snapshot: request.into(),
        },
    );
    commit(
        &mut f,
        ExecutionRecord::ModelDispatched {
            request_id: "parent-receives-report".into(),
        },
    );
    commit(&mut f, completed("parent-receives-report"));
    assert_eq!(
        report_deliveries(&f, &report.execution_id, report.report_cursor),
        1
    );
    cleanup(f);
}
