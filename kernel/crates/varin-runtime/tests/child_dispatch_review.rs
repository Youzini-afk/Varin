//! Independent counterexamples for durable child admission. Host/source authority is covered by
//! the loopback suite; these tests use real Catalog transactions and committed tool origins.
#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use input_admission::InputAdmission;
use serde_json::json;
use varin_runtime::catalog::launches::{LaunchSelection, SourceSelection};
use varin_runtime::execution::*;
use varin_runtime::*;

#[path = "fixtures/child_dispatch.rs"]
mod fixture;
use fixture::Fixture;

#[test]
fn same_committed_origin_is_one_child_before_and_after_reopen_and_changed_task_conflicts() {
    let mut f = Fixture::new();
    let first = f.accept();
    assert_eq!(f.accept(), first);
    assert_eq!(f.db.child_tasks().unwrap().len(), 1);
    let mut changed = f.input.clone();
    changed.task.push_str(" changed");
    assert!(f
        .db
        .accept_child(&f.context, changed, f.pin.clone(), f.launch.clone())
        .is_err());
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(
        f.accept(),
        first,
        "restart retry retains the original receipt and identity"
    );
    assert_eq!(f.db.child_tasks().unwrap().len(), 1);
    assert!(f.db.operation(&f.context.operation_id).unwrap().handed_off);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn authority_cannot_be_forged_by_another_run_policy_origin_or_expanded_child_tools() {
    let mut f = Fixture::new();
    let mut wrong = f.context.clone();
    wrong.run_id = "other-run".into();
    assert!(f
        .db
        .accept_child(&wrong, f.input.clone(), f.pin.clone(), f.launch.clone())
        .is_err());
    let mut wrong = f.context.clone();
    wrong.origin = ToolOrigin::PolicyAction {
        action_id: "pretend-model".into(),
        node_id: "node".into(),
    };
    assert!(f
        .db
        .accept_child(&wrong, f.input.clone(), f.pin.clone(), f.launch.clone())
        .is_err());
    let mut wrong = f.pin.clone();
    wrong.source.workspace_id = "workspace-B".into();
    assert!(f
        .db
        .accept_child(&f.context, f.input.clone(), wrong, f.launch.clone())
        .is_err());
    for name in ["file_write", "file_list", "process_spawn"] {
        let mut expanded = f.launch.clone();
        expanded.tools.push(ToolSchema {
            description: String::new(),
            output_schema: None,
            metadata: None,
            name: name.into(),
            version: "1".into(),
            schema: json!({"type":"object"}),
        });
        assert!(
            f.db.accept_child(&f.context, f.input.clone(), f.pin.clone(), expanded)
                .is_err(),
            "cannot grant {name} beyond parent"
        );
    }
    assert!(f.db.child_tasks().unwrap().is_empty());
    let child = f.accept();
    assert_eq!(child.parent_run_id, f.context.run_id);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn child_body_roots_survive_collection_and_broken_task_text_does_not_block_controls() {
    let mut f = Fixture::new_parent_extension();
    let child = f.accept();
    assert!(child.receipt.is_none());
    assert_ne!(child.launch.extension_bindings_ref,f.db.launch_metadata(&f.context.run_id).unwrap().unwrap().selection.extension_bindings_ref);
    content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap();
    assert!(f.db.capture_child_read(child.clone()).load().unwrap().launch.extension_bindings.is_empty());
    let (source, proposal, basis) = child_context(&child);
    let child =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap();
    let view = f.db.capture_child_read(child.clone()).load().unwrap();
    assert_eq!(view.input, f.input);
    assert_eq!(view.launch.tools, f.launch.tools);
    assert!(serde_json::to_value(&child).unwrap().get("input").is_none());
    let hash = child.input_ref["content_object"]
        .as_str()
        .unwrap()
        .strip_prefix("sha256-")
        .unwrap();
    std::fs::write(
        f.root
            .join("content/objects")
            .join(&hash[..2])
            .join(&hash[2..]),
        b"damaged task body",
    )
    .unwrap();
    assert!(f.db.capture_child_read(child.clone()).load().is_err());
    let receipt = child.receipt.as_ref().unwrap();
    assert_eq!(
        f.db.task_family(&receipt.run_id, f.db.epoch()).unwrap(),
        child.parent_thread_id
    );
    assert_eq!(
        f.db.require_child_parent(&f.context.run_id, &child.operation_id)
            .unwrap()
            .child_thread_id,
        child.child_thread_id
    );
    f.db.cancel_child(&child.operation_id).unwrap();
    assert!(f.db.run(&receipt.run_id).unwrap().cancel_requested);
    assert!(
        f.db.mark_child_resources_released(&child.operation_id)
            .unwrap()
            .resources_released
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn preparation_failure_before_dispatch_exchange_commit_preserves_the_real_receipt_and_report() {
    let mut f = Fixture::new();
    let child = f.accept();
    let failed =
        f.db.fail_child_preparation(&child.operation_id, "fixture preparation failure")
            .unwrap();
    assert_eq!(failed.report.as_ref().unwrap().outcome, Outcome::Failed);
    assert_eq!(failed.code_result, varin_runtime::catalog::collaboration::ChildCodeResult::NoChanges);
    assert_ne!(
        f.db.operation(&child.operation_id).unwrap().phase,
        OperationPhase::Terminal
    );
    let original_completion = f.db.operation(&child.operation_id).unwrap().call_completion;
    f.db.settle_child_receipts().unwrap();
    assert_eq!(
        f.db.operation(&child.operation_id).unwrap().outcome,
        Some(Outcome::Failed)
    );
    f.settle_exchange();
    assert_eq!(
        f.db.operation(&child.operation_id).unwrap().call_completion,
        original_completion
    );
    assert_eq!(
        f.db.operation(&child.operation_id).unwrap().outcome,
        Some(Outcome::Failed)
    );
    assert_eq!(
        f.db.child_task(&child.operation_id).unwrap().report,
        failed.report
    );
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    f.db.reconcile_child_reports().unwrap();
    assert_eq!(
        f.db.child_task(&child.operation_id).unwrap().report,
        failed.report
    );
    assert_eq!(
        f.db.events_after(0, 1000)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "child.report_ready")
            .count(),
        1
    );
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn parent_final_does_not_cancel_an_already_handed_off_preparing_child() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    f.db.commit_execution(
        &f.context.run_id,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    let current = f.db.child_task(&child.operation_id).unwrap();
    assert_eq!(current.state, "preparing");
    assert!(current.report.is_none());
    assert!(
        !f.db
            .operation(&child.operation_id)
            .unwrap()
            .cancel_requested
    );
    let failed =
        f.db.fail_child_preparation(&child.operation_id, "late independent failure")
            .unwrap();
    assert_eq!(failed.report.unwrap().outcome, Outcome::Failed);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn report_and_wait_registration_in_either_order_deliver_once_with_real_child_provenance() {
    for report_first in [true, false] {
        let mut f = Fixture::new();
        let child = f.accept();
        f.settle_exchange();
        if report_first {
            f.db.fail_child_preparation(&child.operation_id, "distinct preparation failure")
                .unwrap();
        }
        let wait = f.admit_wait("once");
        if !report_first {
            f.db.fail_child_preparation(&child.operation_id, "distinct preparation failure")
                .unwrap();
        }
        assert_eq!(
            f.db.deliver_child_waits().unwrap(),
            vec![f.context.run_id.clone()]
        );
        assert!(
            f.db.deliver_child_waits()
                .unwrap()
                .iter()
                .all(|run| run == &f.context.run_id),
            "only the original pending continuation may be rediscovered"
        );
        let history = f.db.history("branch:parent").unwrap();
        let reports: Vec<_> = history
            .iter()
            .filter(|item| item.source == HistorySource::Agent)
            .collect();
        assert_eq!(reports.len(), 1);
        let item: ConversationItem = serde_json::from_value(reports[0].content.clone()).unwrap();
        assert_eq!(
            item.provenance,
            Provenance::AgentMessage {
                thread_id: child.child_thread_id
            }
        );
        assert!(serde_json::to_string(&item)
            .unwrap()
            .contains("distinct preparation failure"));
        assert_eq!(
            f.db.run(&f.context.run_id).unwrap().state,
            RunState::Runnable
        );
        assert!(f
            .db
            .pending_child_wait(&f.context.run_id)
            .unwrap()
            .is_none());
        let root = f.root.clone();
        drop(f.db);
        f.db = Catalog::open(&root).unwrap();
        assert!(
            f.db.deliver_child_waits()
                .unwrap()
                .iter()
                .all(|run| run == &f.context.run_id),
            "only the original pending continuation may be rediscovered"
        );
        assert_eq!(f.db.history("branch:parent").unwrap(), history);
        assert!(!f.db.pending_resumptions().unwrap().contains(&wait.id));
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn cancelling_observation_then_waiting_again_never_cancels_child_or_consumes_its_report() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let first_wait = f.admit_wait("cancelled");
    assert!(f.db.cancel_child_wait(&first_wait.id).unwrap().cancelled);
    assert_eq!(
        f.db.run(&f.context.run_id).unwrap().state,
        RunState::Runnable
    );
    let preparing = f.db.child_task(&child.operation_id).unwrap();
    assert!(preparing.report.is_none());
    assert_eq!(preparing.state, "preparing");
    assert!(
        !f.db
            .operation(&child.operation_id)
            .unwrap()
            .cancel_requested
    );
    let second_wait = f.admit_wait("new-observation");
    assert_ne!(second_wait.id, first_wait.id);
    f.db.fail_child_preparation(&child.operation_id, "REPORT_AFTER_CANCELLED_OBSERVATION")
        .unwrap();
    assert_eq!(
        f.db.deliver_child_waits().unwrap(),
        vec![f.context.run_id.clone()]
    );
    let history = f.db.history("branch:parent").unwrap();
    let reports: Vec<_> = history
        .iter()
        .filter(|item| item.source == HistorySource::Agent)
        .collect();
    assert_eq!(
        reports.len(),
        1,
        "cancelled observation is a Host fact, not a message sent by the child"
    );
    assert!(serde_json::to_string(&reports[0].content)
        .unwrap()
        .contains("REPORT_AFTER_CANCELLED_OBSERVATION"));
    assert!(
        f.db.deliver_child_waits()
            .unwrap()
            .iter()
            .all(|run| run == &f.context.run_id),
        "only the original pending continuation may be rediscovered"
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancelled_wait_rejects_a_prepared_report_append_and_a_new_observer_can_receive_it() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    f.db.fail_child_preparation(&child.operation_id, "RETAINED_REPORT")
        .unwrap();
    let wait = f.admit_wait("cancel-during-body-preparation");
    let prepared =
        f.db.capture_child_waits()
            .unwrap()
            .pop()
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap(), 0);
    f.db.request_cancel_child_wait(&wait.id).unwrap();
    assert!(f.db.admit_child_wait(prepared).unwrap().is_none());
    assert!(f
        .db
        .history("branch:parent")
        .unwrap()
        .iter()
        .all(|item| item.source != HistorySource::Agent));
    f.db.deliver_child_waits().unwrap();
    assert_eq!(
        f.db.run(&f.context.run_id).unwrap().state,
        RunState::Runnable
    );
    f.admit_wait("new-observer");
    f.db.deliver_child_waits().unwrap();
    let history = f.db.history("branch:parent").unwrap();
    let reports: Vec<_> = history
        .iter()
        .filter(|item| item.source == HistorySource::Agent)
        .collect();
    assert_eq!(reports.len(), 1);
    assert!(serde_json::to_string(&reports[0].content)
        .unwrap()
        .contains("RETAINED_REPORT"));
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

fn child_context(
    child: &varin_runtime::catalog::collaboration::ChildTask,
) -> (
    SourceSelection,
    varin_runtime::catalog::context::ContextProposal,
    varin_runtime::catalog::personalization::PersonalizationBasis,
) {
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal = varin_runtime::catalog::context::ContextProposal {
        key: format!("child-context:{}", child.operation_id),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Read-only child".into(),
        instruction_sources: vec!["review:child".into()],
        memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"review:child-profile:0","memorySnapshot":{"revision":0,"memories":[]},
        "sessionId":child.child_thread_id,"projectId":child.project_id,
        "originalSections":[{"name":"preamble","content":"Read-only child"}],"instructionSources":["review:child"]})).unwrap();
    (source, proposal, basis)
}

#[test]
fn child_prepare_rejects_late_cancelled_work_and_untrusted_parent_scope_without_admitting_a_run() {
    for field in ["sessionId", "projectId", "mode", "threadRole"] {
        let mut f = Fixture::new();
        let child = f.accept();
        let (source, proposal, basis) = child_context(&child);
        let mut wrong = serde_json::to_value(&basis).unwrap();
        wrong[field] = json!(match field {
            "sessionId" => "thread:parent",
            "projectId" => "forged-project",
            "mode" => "bot",
            _ => "main",
        });
        assert!(
            f.db.prepare_child(
                &child.operation_id,
                source.clone(),
                proposal.clone(),
                serde_json::from_value(wrong).unwrap()
            )
            .is_err(),
            "reject forged {field}"
        );
        assert!(f
            .db
            .child_task(&child.operation_id)
            .unwrap()
            .receipt
            .is_none());
        let prepared =
            f.db.prepare_child(&child.operation_id, source, proposal, basis)
                .unwrap();
        assert!(prepared.receipt.is_some());
        let root = f.root.clone();
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
    let mut f = Fixture::new();
    let child = f.accept();
    let (source, proposal, basis) = child_context(&child);
    f.db.cancel_child(&child.operation_id).unwrap();
    assert!(
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .is_err(),
        "late prepared context cannot create a Run after cancellation"
    );
    let cancelled = f.db.child_task(&child.operation_id).unwrap();
    assert!(cancelled.receipt.is_none());
    assert_eq!(cancelled.report.unwrap().outcome, Outcome::Cancelled);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn same_origin_cannot_change_model_generation_or_expand_launch_after_the_receipt() {
    let mut f = Fixture::new();
    f.accept();
    for field in [
        "provider_family",
        "model",
        "configuration_generation",
        "tool_schema_generation",
    ] {
        let mut changed = serde_json::to_value(&f.launch).unwrap();
        changed[field] = if field.ends_with("generation") {
            json!(999)
        } else {
            json!("other")
        };
        let changed: LaunchSelection = serde_json::from_value(changed).unwrap();
        assert!(
            f.db.accept_child(&f.context, f.input.clone(), f.pin.clone(), changed)
                .is_err(),
            "same origin cannot change {field}"
        );
    }
    assert_eq!(f.db.child_tasks().unwrap().len(), 1);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn report_delivery_respects_fork_ancestry_instead_of_global_or_current_branch_only_deduplication() {
    for fork_after_report in [false, true] {
        let mut f = Fixture::new();
        let child = f.accept();
        f.settle_exchange();
        let before_report = f.db.head("branch:parent").unwrap();
        f.admit_wait("original");
        f.db.fail_child_preparation(&child.operation_id, "ONE_REPORT_PER_VISIBLE_ANCESTRY")
            .unwrap();
        f.db.deliver_child_waits().unwrap();
        let after_report = f.db.head("branch:parent").unwrap();
        let fork_head = if fork_after_report {
            after_report
        } else {
            before_report
        };
        f.db.fork_branch("branch:parent", "fork", fork_head.as_deref())
            .unwrap();
        let receipt =
            f.db.submit_with_launch(
                &SubmitInput {
                    key: "fork-input".into(),
                    thread_id: "thread:parent".into(),
                    branch_id: "fork".into(),
                    expected_head: fork_head,
                    input: json!("Wait for the same owned child on this fork"),
                    configuration: json!({}),
                },
                Some(f.launch.clone()),
            )
            .unwrap();
        f.context.run_id = receipt.run_id.clone();
        f.db.commit_execution(
            &receipt.run_id,
            f.db.epoch(),
            &ExecutionRecord::StateChanged {
                state: RunState::Runnable,
                waiting_on: None,
            },
        )
        .unwrap();
        f.admit_wait("fork");
        f.db.deliver_child_waits().unwrap();
        let reports: Vec<_> =
            f.db.history("fork")
                .unwrap()
                .into_iter()
                .filter(|item| item.source == HistorySource::Agent)
                .collect();
        assert_eq!(
            reports.len(),
            1,
            "fork_after_report={fork_after_report}: a visible report is never duplicated, but an earlier fork may receive it"
        );
        assert!(serde_json::to_string(&reports[0])
            .unwrap()
            .contains("ONE_REPORT_PER_VISIBLE_ANCESTRY"));
        let root = f.root.clone();
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn a_crash_before_child_admission_discovers_only_the_stopped_origins_exact_source_cleanup() {
    let mut f = Fixture::new();
    assert!(
        f.db.unaccepted_child_sources().unwrap().is_empty(),
        "cleanup must not race the live source admission window"
    );
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    let pending = f.db.unaccepted_child_sources().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].operation_id, f.context.operation_id);
    assert_eq!(pending[0].parent_thread_id, "thread:parent");
    assert_eq!(
        pending[0].pin_id,
        format!("child-pin:{}", f.context.operation_id)
    );
    assert_eq!(pending[0].source, f.pin.source);
    assert!(f.db.child_tasks().unwrap().is_empty());
    f.db.mark_unaccepted_child_source_released(&f.context.operation_id)
        .unwrap();
    f.db.mark_unaccepted_child_source_released(&f.context.operation_id)
        .unwrap();
    assert!(f.db.unaccepted_child_sources().unwrap().is_empty());
    assert_eq!(
        f.db.events_after(0, 1000)
            .unwrap()
            .iter()
            .filter(|event| event.kind == "child.source_released")
            .count(),
        1
    );
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn incompatible_collaboration_domain_is_rejected_without_rewriting_existing_assets() {
    for defect in ["old_report_text", "missing_unique", "missing_foreign_keys"] {
        let mut f = Fixture::new();
        let child = f.accept();
        let root = f.root.clone();
        drop(f.db);
        let database = root.join("conversation.sqlite");
        let raw = rusqlite::Connection::open(&database).unwrap();
        if defect == "old_report_text" {
            let mut body = serde_json::to_value(&child).unwrap();
            body["report"] = json!({"outcome":"failed","sender_thread_id":child.child_thread_id,"run_id":null,
                "history_ids":[],"detail":"failed","code_result":"no_changes","text":"legacy duplicated payload"});
            raw.execute(
                "UPDATE child_tasks SET body=?1 WHERE id=?2",
                rusqlite::params![body.to_string(), child.operation_id],
            )
            .unwrap();
        } else {
            let definition = if defect == "missing_unique" {
                "CREATE TABLE child_tasks(id TEXT PRIMARY KEY REFERENCES operations(id),child_thread_id TEXT NOT NULL REFERENCES threads(id),body TEXT NOT NULL);"
            } else {
                "CREATE TABLE child_tasks(id TEXT PRIMARY KEY,child_thread_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);"
            };
            raw.execute_batch(&format!("PRAGMA foreign_keys=OFF; ALTER TABLE child_tasks RENAME TO saved_children; {definition} INSERT INTO child_tasks SELECT * FROM saved_children; DROP TABLE saved_children;")).unwrap();
        }
        raw.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(raw);
        let before = std::fs::read(&database).unwrap();
        assert!(Catalog::open(&root).is_err(), "must refuse {defect}");
        assert_eq!(
            std::fs::read(&database).unwrap(),
            before,
            "preflight rewrote {defect}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn fixed_parent_can_admit_private_writable_child_and_cancelled_empty_report_keeps_partial_result() {
    use varin_runtime::catalog::collaboration::{ChildCodeResult,ChildSource,ChildWorkingResultRef};
    let mut f=Fixture::new_isolated();
    let child=f.accept();
    assert!(matches!(child.source,ChildSource::Pending{..}));
    assert_eq!(child.code_result,ChildCodeResult::Pending);
    f.settle_exchange();
    let (mut source, proposal, basis) = child_context(&child);
    source.mode = SourceMode::Materialized;
    let child =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let epoch = f.db.epoch();
    let context = admit_native_child_writer(&mut f.db, &run, "file_write", "child-file-request");
    settle_native_child_writer(
        &mut f.db,
        &context,
        ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            content: json!({"written":true}),
        },
        true,
    );
    f.db.request_cancel_run(&run).unwrap();
    f.db.commit_execution(&run,epoch,&ExecutionRecord::StateChanged{state:RunState::Cancelled,waiting_on:None}).unwrap();
    f.db.reconcile_child_reports().unwrap();
    let reported=f.db.child_task(&child.operation_id).unwrap();
    assert_eq!(reported.report.as_ref().unwrap().outcome,Outcome::Cancelled);
    assert!(reported.report.as_ref().unwrap().history_ids.is_empty());
    assert_eq!(reported.code_result,ChildCodeResult::Pending);
    assert_eq!(f.db.child_file_effect(&child.operation_id).unwrap(),Effect::Partial);
    let publication_id=format!("child-result:{}",child.operation_id);
    f.db.begin_child_settlement(&child.operation_id).unwrap();
    let candidate=KernelWorkingResultCandidate {publication_id:publication_id.clone(),candidate_operation_id:format!("result-prepare:{publication_id}"),
        workspace_id:"workspace-A".into(),branch_id:format!("child-source:{}",child.operation_id),root:"fixed-result-root".into(),base_root:child.source.pin().unwrap().root.clone(),
        write_revision:1,pin_id:"result-pin".into(),base_pin_id:"result-base-pin".into()};
    f.db.attach_child_candidate(&child.operation_id,candidate.clone()).unwrap();
    let result=ChildWorkingResultRef{publication_id:publication_id.clone(),workspace_id:candidate.workspace_id,branch_id:candidate.branch_id,root:candidate.root,base_root:candidate.base_root,
        result_revision:1,record_id:"working-result:fixed".into()};
    f.db.attach_child_result(&child.operation_id,result.clone(),Effect::Partial).unwrap();
    f.db.settle_child_receipts().unwrap();
    let operation=f.db.operation(&child.operation_id).unwrap();
    assert_eq!(operation.outcome,Some(Outcome::Cancelled));assert_eq!(operation.effect,Effect::Partial);
    let original_revision=operation.revision;
    f.db.settle_child_receipts().unwrap();assert_eq!(f.db.operation(&child.operation_id).unwrap().revision,original_revision);
    let root=f.root.clone();drop(f.db);let db=Catalog::open(&root).unwrap();
    assert_eq!(db.child_task(&child.operation_id).unwrap().code_result,ChildCodeResult::Published{result,effect:Effect::Partial});
    drop(db);std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn ended_goal_detaches_new_primary_input_but_retains_admitted_child_attribution() {
    use varin_runtime::catalog::goals::*;
    for prepare_late in [false,true] {
    let mut f=Fixture::new();
    let scope=GoalScope{thread_id:"thread:parent".into(),branch_id:"branch:parent".into()};
    let p=f.db.prepare_goal_start("goal",&f.context.run_id,scope.clone(),"Finish parent objective".into(),None).unwrap().load().unwrap();
    f.db.admit_goal_mutation(p).unwrap();
    let mut child=f.accept();
    if !prepare_late {
        let (source,proposal,basis)=child_context(&child);child=f.db.prepare_child(&child.operation_id,source,proposal,basis).unwrap();
        let run=&child.receipt.as_ref().unwrap().run_id;
        f.db.commit_execution(run,f.db.epoch(),&ExecutionRecord::StateChanged{state:RunState::Runnable,waiting_on:None}).unwrap();
        f.db.register_wait("child-dependency",run,"dependency","finished",0).unwrap();
        f.db.commit_execution(run,f.db.epoch(),&ExecutionRecord::StateChanged{state:RunState::Waiting,waiting_on:Some("child-dependency".into())}).unwrap();
        assert_eq!(f.db.capture_goal("goal").unwrap().load().unwrap().state,GoalState::Active,"an independently waiting child does not block its still-active primary");
    }
    f.settle_exchange();
    f.db.control_goal("goal",1,&scope,GoalControlAction::Complete).unwrap();
    f.db.enqueue_input(&varin_runtime::catalog::inputs::EnqueueInput{key:"new-user-input".into(),thread_id:scope.thread_id.clone(),branch_id:scope.branch_id.clone(),mode:InputMode::Boundary,input:json!("new ordinary task"),configuration:None}).unwrap();
    let head=f.db.head(&scope.branch_id).unwrap();f.db.consume_inputs(&f.context.run_id,f.db.epoch(),head.as_deref()).unwrap();
    assert!(f.db.goal_binding(&f.context.run_id).unwrap().is_none());
    if prepare_late {let (source,proposal,basis)=child_context(&child);child=f.db.prepare_child(&child.operation_id,source,proposal,basis).unwrap();}
    let child_run=&child.receipt.as_ref().unwrap().run_id;
    assert_eq!(f.db.goal_binding(child_run).unwrap().unwrap().id,"goal");
    assert!(matches!(f.db.goal_boundary(child_run,f.db.epoch()).unwrap(),GoalBoundary::Finish{state:RunState::Cancelled}));
    let root=f.root.clone();drop(f);std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn completed_report_does_not_stop_process_tree_cancel_is_scoped_and_waits_for_original_stop() {
    use varin_runtime::catalog::dispatch::TreeCancelTarget;
    let mut f = Fixture::new_isolated_process();
    let child = f.accept();
    f.settle_exchange();
    let (mut source, proposal, basis) = child_context(&child);
    source.mode = SourceMode::Materialized;
    let child =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let epoch = f.db.epoch();
    let context =
        admit_native_child_writer(&mut f.db, &run, "process_spawn", "child-process-request");
    f.db.handoff_operation(&context.operation_id, epoch)
        .unwrap();
    settle_native_child_writer(
        &mut f.db,
        &context,
        ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            content: json!({"status":"unknown"}),
        },
        false,
    );
    f.db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    f.db.commit_execution(
        &run,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    f.db.reconcile_child_reports().unwrap();
    let report =
        f.db.child_task(&child.operation_id)
            .unwrap()
            .report
            .unwrap();
    assert!(!f
        .db
        .child_writers_stopped_sync(&child.operation_id)
        .unwrap());
    assert!(f.db.begin_child_settlement(&child.operation_id).is_err());
    assert!(f
        .db
        .pending_external_operations("process_spawn")
        .unwrap()
        .contains(&"child-process-request:tool:process_spawn".into()));
    let target = TreeCancelTarget::Child {
        operation_id: child.operation_id.clone(),
    };
    assert!(f
        .db
        .cancel_tree_checked(target.clone(), Some("unrelated-parent"))
        .is_err());
    assert!(
        !f.db
            .operation("child-process-request:tool:process_spawn")
            .unwrap()
            .cancel_requested
    );
    let before = f.db.run(&run).unwrap();
    let capture =
        f.db.cancel_tree_checked(target.clone(), Some("thread:parent"))
            .unwrap();
    assert_eq!(
        (
            capture.receipt.run_count,
            capture.receipt.child_count,
            capture.receipt.process_count
        ),
        (1, 1, 1)
    );
    assert_eq!(
        capture.process_ids,
        vec!["child-process-request:tool:process_spawn"]
    );
    assert_eq!(
        f.db.run(&run).unwrap(),
        before,
        "a terminal report is not rewritten as fake cancellation"
    );
    assert!(!f.db.run(&f.context.run_id).unwrap().cancel_requested);
    assert!(
        f.db.operation("child-process-request:tool:process_spawn")
            .unwrap()
            .cancel_requested
    );
    assert_eq!(
        f.db.child_task(&child.operation_id).unwrap().report,
        Some(report)
    );
    let revision =
        f.db.operation("child-process-request:tool:process_spawn")
            .unwrap()
            .revision;
    f.db.cancel_tree(target).unwrap();
    assert_eq!(
        f.db.operation("child-process-request:tool:process_spawn")
            .unwrap()
            .revision,
        revision
    );
    f.db.record_external_receipt_with_stop(
        "child-process-request:tool:process_spawn",
        ExternalReceipt {
            identity: "child-process-request:tool:process_spawn".into(),
            executor: "process_spawn".into(),
            epoch: "original-process".into(),
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            result: json!({"treeConfirmed":true,"writerActive":false}),
        },
        true,
    )
    .unwrap();
    assert!(f
        .db
        .child_writers_stopped_sync(&child.operation_id)
        .unwrap());
    f.db.begin_child_settlement(&child.operation_id).unwrap();
    assert_eq!(
        f.db.child_file_effect(&child.operation_id).unwrap(),
        Effect::Unknown
    );
    let root = f.root.clone();
    drop(f);
    let db = Catalog::open(&root).unwrap();
    assert!(db.child_writers_stopped_sync(&child.operation_id).unwrap());
    assert_eq!(
        db.child_file_effect(&child.operation_id).unwrap(),
        Effect::Unknown
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

fn admit_native_child_writer(
    db: &mut Catalog,
    run: &str,
    name: &str,
    request: &str,
) -> ToolExecutionContext {
    let selection = db.launch_intent(run).unwrap().unwrap().selection;
    let branch = db.run(run).unwrap().branch_id;
    let schema = selection
        .tools
        .iter()
        .find(|tool| tool.name == name)
        .unwrap();
    let call = ToolCall {
        call_id: name.into(),
        name: name.into(),
        schema_version: schema.version.clone(),
        arguments: json!({}),
    };
    let binding: RequestBinding = serde_json::from_value(json!({
        "child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,
        "connection_identity":selection.connection_identity,"provider_family":selection.provider_family,"model":selection.model,
        "credential_ref":null,"configuration_generation":selection.configuration_generation,"tool_schema_generation":selection.tool_schema_generation,
        "tools":selection.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,
        "history_range":{"branch_id":branch,"ancestor_id":null,"leaf_id":db.head(&branch).unwrap()}
    })).unwrap();
    let epoch = db.epoch();
    db.commit_execution(
        run,
        epoch,
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    db.commit_execution(
        run,
        epoch,
        &ExecutionRecord::RequestPrepared {
            snapshot: RequestSnapshot {
                view: RequestView {
                    request_id: request.into(),
                    run_id: run.into(),
                    origin: RequestOrigin::Conversation {
                        step: 1,
                        history_range: binding.history_range.clone(),
                    },
                    binding,
                    history: vec![],
                },
                serialized: json!({"fixture":"native child writer"}),
            },
        },
    )
    .unwrap();
    db.commit_execution(
        run,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: request.into(),
        },
    )
    .unwrap();
    db.commit_execution(
        run,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: request.into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: name.into(),
                content: Content::ToolCall { call: call.clone() },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    let origin = ToolOrigin::ModelStep {
        request_id: request.into(),
    };
    let context = ToolExecutionContext {
        run_id: run.into(),
        operation_id: origin.operation_id(name),
        origin,
    };
    db.commit_execution(
        run,
        epoch,
        &ExecutionRecord::ToolAdmitted {
            context: context.clone(),
            tool: AdmittedTool {
                call,
                contract: ToolContract {
                    name: name.into(),
                    schema_version: schema.version.clone(),
                    read_only: false,
                    completion: if name == "process_spawn" {
                        CompletionKind::Job
                    } else {
                        CompletionKind::Result
                    },
                    lifetime: if name == "process_spawn" {
                        Lifetime::Thread
                    } else {
                        Lifetime::Run
                    },
                    resources: vec![],
                },
            },
        },
    )
    .unwrap();
    db.commit_execution(
        run,
        epoch,
        &ExecutionRecord::ToolDispatched {
            context: context.clone(),
            executor_owner: ExecutorOwner::Kernel,
        },
    )
    .unwrap();
    context
}
fn settle_native_child_writer(
    db: &mut Catalog,
    context: &ToolExecutionContext,
    completion: ToolCompletion,
    stopped: bool,
) {
    let epoch = db.epoch();
    db.commit_execution(
        &context.run_id,
        epoch,
        &ExecutionRecord::ToolSettled {
            context: context.clone(),
            completion: completion.clone(),
            executor_stopped: stopped,
        },
    )
    .unwrap();
    let ToolOrigin::ModelStep { request_id } = &context.origin else {
        unreachable!()
    };
    let call_id = context.operation_id.rsplit(':').next().unwrap().to_string();
    db.commit_execution(
        &context.run_id,
        epoch,
        &ExecutionRecord::ToolBatchCommitted {
            request_id: request_id.clone(),
            results: vec![ToolResult {
                request_id: request_id.clone(),
                call_id,
                completion,
            }],
        },
    )
    .unwrap();
}

#[test]
fn original_no_send_receipt_does_not_wait_for_a_nonexistent_native_process() {
    let mut f = Fixture::new_isolated_process();
    let child = f.accept();
    f.settle_exchange();
    let (mut source, proposal, basis) = child_context(&child);
    source.mode = SourceMode::Materialized;
    let child =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    let context = admit_native_child_writer(&mut f.db, &run, "process_spawn", "not-sent-process");
    settle_native_child_writer(
        &mut f.db,
        &context,
        ToolCompletion::NotDispatched {
            reason: "cancelled-before-spawn".into(),
        },
        true,
    );
    assert!(f
        .db
        .operation(&context.operation_id)
        .unwrap()
        .external_receipt
        .is_none());
    f.db.commit_execution(
        &run,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    let writers =
        f.db.capture_child_writer_bindings(&child.operation_id)
            .unwrap()
            .load()
            .unwrap();
    assert!(f.db.child_writers_stopped(&writers).unwrap());
    assert_eq!(
        f.db.child_file_effect_bound(&writers).unwrap(),
        Effect::None
    );
    f.db.begin_child_settlement_bound(&child.operation_id, &writers)
        .unwrap();
    let root = f.root.clone();
    drop(writers);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
