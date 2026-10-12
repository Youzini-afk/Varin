//! Real public dispatch declaration, frozen invocation, child RunAssembly and Engine.
//! Host effect replies are controlled; no Storage file source or listening transport is used.
use super::*;
use varin_runtime::catalog::{collaboration::*, delegated::*, dispatch::*};

#[test]
fn source_free_dispatch_executes_ordinary_effects_through_both_origins_and_file_modes() {
    for (parent_policy, model, mode) in [
        (false, true, ChildWorkMode::ReadOnly),
        (true, false, ChildWorkMode::IsolatedWrite),
    ] {
        let f = Fixture::source_free(parent_policy, mode);
        let helper = f
            .original
            .tools
            .iter()
            .find(|tool| tool.name == "helper")
            .unwrap();
        let calls = vec![ToolCall {
            call_id: "ordinary-effect".into(),
            name: helper.name.clone(),
            schema_version: helper.version.clone(),
            arguments: json!({}),
        }];
        let mut owner = OwnerReplies::default();
        execute(&f, model, calls, &mut owner, false);
        assert!(
            owner
                .host_calls
                .iter()
                .any(|frame| frame["phase"] == "authorize")
        );
        assert_eq!(
            owner
                .host_calls
                .iter()
                .filter(|frame| frame["phase"] == "execute")
                .count(),
            1
        );
        let catalog = f.catalog();
        let mut db = catalog.lock().unwrap();
        db.reconcile_child_reports().unwrap();
        let original = db.child_task(&f.child.operation_id).unwrap();
        assert_eq!(
            original.report.as_ref().unwrap().outcome,
            Outcome::Succeeded
        );
        assert!(!original.report.as_ref().unwrap().history_ids.is_empty());
        assert_eq!(original.code_result, ChildCodeResult::NotApplicable);
        assert_eq!(original.source, ChildSource::Absent);
        let next = db
            .capture_child_continuation(ChildContinuationCommand {
                key: "next-capability-step".into(),
                child_operation_id: original.operation_id.clone(),
                previous_run_id: f.run.id.clone(),
                expected_head: db.head(&f.run.branch_id).unwrap(),
                input: json!({"text":"Continue without file authority"}),
            })
            .unwrap()
            .load()
            .unwrap();
        let next = db.accept_child_continuation(next).unwrap();
        assert_eq!(next.source, Some(ChildSource::Absent));
        assert!(next.source_basis.is_none() && next.launch.source.is_none());
        assert_eq!(next.code_result, ChildCodeResult::NotApplicable);
        assert_ne!(next.execution_id, original.execution_id);
        assert_eq!(db.child_task(&original.operation_id).unwrap(), original);
        drop(db);
        drop(catalog);
        let f = f.reopen();
        let catalog = f.catalog();
        let mut db = catalog.lock().unwrap();
        let restored = db.delegated_execution(&next.execution_id).unwrap();
        assert_eq!(restored, next);
        let cancelled = db
            .cancel_tree(TreeCancelTarget::Child {
                operation_id: original.operation_id,
            })
            .unwrap();
        assert!(cancelled.receipt.child_count > 0);
        let next = db.delegated_execution(&next.execution_id).unwrap();
        assert!(next.cancel_requested && next.receipt.is_none());
        assert_eq!(next.report.unwrap().outcome, Outcome::Cancelled);
        assert_eq!(next.code_result, ChildCodeResult::NotApplicable);
        drop(db);
        drop(catalog);
        f.finish();
    }
}

#[test]
fn file_read_only_does_not_bypass_per_call_permission_for_source_free_effect() {
    let f = Fixture::source_free(false, ChildWorkMode::ReadOnly);
    let helper = f
        .original
        .tools
        .iter()
        .find(|tool| tool.name == "helper")
        .unwrap();
    let calls = vec![ToolCall {
        call_id: "denied-effect".into(),
        name: helper.name.clone(),
        schema_version: helper.version.clone(),
        arguments: json!({}),
    }];
    let mut owner = OwnerReplies {
        deny_host: true,
        ..Default::default()
    };
    execute(&f, true, calls, &mut owner, false);
    assert_eq!(owner.host_calls.len(), 1);
    assert_eq!(owner.host_calls[0]["phase"], "authorize");
    let catalog = f.catalog();
    let db = catalog.lock().unwrap();
    let operation = db
        .operation(owner.host_calls[0]["call"]["operationId"].as_str().unwrap())
        .unwrap();
    assert_eq!(operation.effect, Effect::None);
    assert!(matches!(
        operation.call_completion,
        Some(varin_runtime::catalog::result_content::ToolCompletionMetadata::NotDispatched { .. })
    ));
    drop(db);
    drop(catalog);
    f.finish();
}

#[test]
fn source_free_handback_prepares_and_admits_a_real_environment_child_run_once() {
    use varin_runtime::catalog::{
        activation::RequestActivationAdmission, computer_events::*,
        computer_requests::ComputerExecution,
    };
    let f = Fixture::source_free(false, ChildWorkMode::ReadOnly);
    execute(&f, true, vec![], &mut OwnerReplies::default(), false);
    let catalog = f.catalog();
    let mut db = catalog.lock().unwrap();
    db.reconcile_child_reports().unwrap();
    let old = db.child_task(&f.child.operation_id).unwrap();
    let checkpoint = db
        .capture_active_checkpoint(&f.run.branch_id)
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
    let mut launch = db.launch_intent(&f.run.id).unwrap().unwrap().selection;
    launch.extension_bindings.clear();
    launch.child_dispatch = None;
    launch.tools.clear();
    let through_id = db.head(&f.run.branch_id).unwrap().unwrap();
    let auxiliary = db
        .create_context_job(
            varin_runtime::context_job::ContextJobRequest {
            summary_recipe: varin_runtime::context_job::ContextSummaryRecipe::manual(),
                owner_run_id: None,
                personalization: checkpoint.personalization,
                key: "child-handback-auxiliary".into(),
                branch_id: f.run.branch_id.clone(),
                through_id,
                expected_revision: checkpoint.revision,
                effective_system_prompt: "Summarize".into(),
                instruction_sources: vec![],
                memory_checkpoint: None,
            },
            launch,
            serde_json::json!({}),
        )
        .unwrap();
    let auxiliary_run = db.run(&auxiliary.receipt.run_id).unwrap();
    assert!(!auxiliary_run.state.terminal());
    assert_ne!(auxiliary_run.thread_id, f.run.thread_id);
    assert_ne!(auxiliary_run.branch_id, f.run.branch_id);
    assert_eq!(auxiliary.request.branch_id, f.run.branch_id);
    let command = ComputerEventCommand {
        fact: ComputerEventFact {
            id: "actual-human-return".into(),
            kind: ComputerEventKind::Handback,
            desktop_id: "original-desktop".into(),
            at: "2026-10-11T11:00:00Z".into(),
            release_confirmed: true,
            execution: ComputerExecution {
                thread_id: f.run.thread_id.clone(),
                branch_id: f.run.branch_id.clone(),
                run_id: f.run.id.clone(),
            },
        },
        label: "Desktop".into(),
    };
    let prepared = db
        .prepare_computer_event(command.clone())
        .unwrap()
        .load()
        .unwrap();
    let received = db.admit_computer_event(prepared).unwrap();
    let candidate = db
        .capture_request_activations()
        .unwrap()
        .pop()
        .unwrap()
        .load()
        .unwrap();
    let RequestActivationAdmission::Delegated(execution) =
        db.admit_request_activation(candidate).unwrap()
    else {
        panic!("real delegated continuation")
    };
    let next = db.delegated_execution(&execution).unwrap();
    assert!(
        matches!(&next.trigger,DelegatedTrigger::ComputerEvent{input_id,previous_run_id,..} if input_id==&received.input_ids[0] && previous_run_id==&f.run.id)
    );
    assert_eq!(next.source, Some(ChildSource::Absent));
    let checkpoint = db
        .capture_active_checkpoint(&f.run.branch_id)
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
    let mut proposal = checkpoint.proposal;
    proposal.key = "handback-context".into();
    let preparation = db
        .capture_child_preparation(
            &execution,
            None,
            proposal,
            checkpoint.personalization.unwrap(),
        )
        .unwrap();
    drop(db);
    let prepared = preparation.load().unwrap();
    let mut db = catalog.lock().unwrap();
    let admitted = db.admit_child(prepared).unwrap();
    let run = admitted.receipt.as_ref().unwrap().run_id.clone();
    assert_ne!(run, f.run.id);
    assert_eq!(admitted.code_result, ChildCodeResult::NotApplicable);
    assert_eq!(
        db.child_task(&old.operation_id).unwrap(),
        old,
        "new round never replaces the original ChildTask result"
    );
    let history = db.history(&f.run.branch_id).unwrap();
    let items: Vec<_> = history.iter().filter(|item| item.run_id == run).collect();
    assert_eq!(
        items
            .iter()
            .filter(|item| item.source == varin_runtime::HistorySource::Environment)
            .count(),
        1
    );
    assert!(
        !items
            .iter()
            .any(|item| item.source == varin_runtime::HistorySource::User)
    );
    let retry = db.prepare_computer_event(command).unwrap().load().unwrap();
    assert_eq!(db.admit_computer_event(retry).unwrap(), received);
    assert!(db.capture_request_activations().unwrap().is_empty());
    drop(db);
    drop(catalog);
    f.finish();
}
