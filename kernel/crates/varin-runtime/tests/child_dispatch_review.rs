//! Independent counterexamples for durable child admission. Host/source authority is covered by
//! the loopback suite; these tests use real Catalog transactions and committed tool origins.
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
    let mut f = Fixture::new();
    let child = f.accept();
    let (source, proposal, basis) = child_context(&child);
    let child =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    f.db.collect_content_objects().unwrap();
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
    assert_eq!(failed.report.as_ref().unwrap().code_result, "no_changes");
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
    assert_eq!(f.db.collect_content_objects().unwrap(), 0);
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
    let mut source = child.source_pin.source.clone();
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
