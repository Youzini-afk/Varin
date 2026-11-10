//! Collaboration observations come from real Catalog lineage and execution facts.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use varin_runtime::{
    catalog::{
        collaboration::ChildTask, context::ContextProposal, family::*, threads::ThreadUpdate,
    },
    execution::*,
    *,
};

fn snapshot(f: &Fixture) -> CollaborationSnapshot {
    f.db.capture_family_read("thread:parent", None, None)
        .unwrap()
        .collaboration_snapshot("branch:parent")
        .unwrap()
}
fn cleanup(f: Fixture) {
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
fn prepare(f: &mut Fixture, child: ChildTask) -> ChildTask {
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal = ContextProposal {
        key: format!("context:{}", child.operation_id),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Read-only child".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis = serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,
        "configurationDigest":"collaboration-observation-test","memorySnapshot":{"revision":0,"memories":[]},
        "threadId":child.child_thread_id,"projectId":child.project_id,"originalSections":[],"instructionSources":[]})).unwrap();
    f.db.prepare_child(&child.operation_id, source, proposal, basis)
        .unwrap()
}
fn state(f: &mut Fixture, run: &str, state: RunState) {
    f.db.commit_execution(
        run,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state,
            waiting_on: None,
        },
    )
    .unwrap();
}
fn title(f: &mut Fixture, thread: &str, name: &str, key: &str) {
    let revision = f.db.inspect_thread(thread).unwrap()["revision"]
        .as_u64()
        .unwrap();
    f.db.update_thread(&ThreadUpdate {
        thread_id: thread.into(),
        key: key.into(),
        expected_revision: revision,
        title: Some(name.into()),
        title_mode: None,
        pinned: None,
        archived: None,
    })
    .unwrap();
}

#[test]
fn empty_snapshot_has_real_scope_and_foreign_branches_cannot_change_it() {
    let mut f = Fixture::new();
    let empty = snapshot(&f);
    assert!(empty.is_empty());
    assert_eq!(empty.caller_thread_id, "thread:parent");
    assert_eq!(empty.caller_branch_id, "branch:parent");
    assert_eq!(empty.root_thread_id, "thread:parent");
    f.db.create_thread("unrelated", "unrelated-branch").unwrap();
    assert_eq!(snapshot(&f), empty);
    assert!(f
        .db
        .capture_family_read("thread:parent", None, None)
        .unwrap()
        .collaboration_snapshot("unrelated-branch")
        .is_err());
    let child = f.accept();
    assert_eq!(snapshot(&f).members.len(), 1);
    let child_view =
        f.db.capture_family_read(&child.child_thread_id, None, None)
            .unwrap()
            .collaboration_snapshot(&child.child_branch_id)
            .unwrap();
    assert_eq!(child_view.root_thread_id, "thread:parent");
    assert_eq!(child_view.caller_thread_id, child.child_thread_id);
    assert!(child_view
        .members
        .iter()
        .any(|member| member.thread_id == "thread:parent"));
    assert!(
        child_view
            .members
            .iter()
            .all(|member| member.thread_id != child.child_thread_id
                && member.thread_id != "unrelated")
    );
    let old_reader =
        f.db.capture_family_read("thread:parent", None, None)
            .unwrap();
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert!(
        old_reader.collaboration_snapshot("branch:parent").is_err(),
        "old epoch is not an empty snapshot"
    );
    cleanup(f);
}

#[test]
fn model_tool_progress_heads_and_unrelated_metadata_do_not_change_the_snapshot() {
    let mut f = Fixture::new();
    let accepted = f.accept();
    f.settle_exchange();
    let child = prepare(&mut f, accepted);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    state(&mut f, &run, RunState::Runnable);
    let baseline = snapshot(&f);
    assert_eq!(baseline.members[0].state, CollaborationState::Active);
    let bytes = serde_json::to_vec(&baseline.to_item("same-history-entry").unwrap()).unwrap();
    for (index, phase) in [
        RunState::Generating,
        RunState::Executing,
        RunState::Runnable,
    ]
    .into_iter()
    .enumerate()
    {
        state(&mut f, &run, phase);
        let head = f.db.head(&child.child_branch_id).unwrap();
        f.db.append_history(&run, f.db.epoch(), head.as_deref(), HistorySource::Assistant,
            json!({"id":format!("child-step-{index}"),"provenance":{"kind":"assistant"},
                "content":{"kind":"text","text":format!("ordinary progress {index}")},"opaque":null}), None).unwrap();
        assert_eq!(snapshot(&f), baseline);
    }
    let revision = f.db.inspect_thread(&child.child_thread_id).unwrap()["revision"]
        .as_u64()
        .unwrap();
    f.db.update_thread(&ThreadUpdate {
        thread_id: child.child_thread_id.clone(),
        key: "hide-current-child".into(),
        expected_revision: revision,
        title: None,
        title_mode: None,
        pinned: Some(true),
        archived: Some(true),
    })
    .unwrap();
    f.db.create_thread("unrelated-noise", "unrelated-noise-branch")
        .unwrap();
    assert_eq!(snapshot(&f), baseline);
    assert_eq!(
        serde_json::to_vec(&snapshot(&f).to_item("same-history-entry").unwrap()).unwrap(),
        bytes
    );
    cleanup(f);
}

#[test]
fn observed_semantic_changes_include_names_waits_reports_and_empty_handoff() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let original = snapshot(&f);
    title(
        &mut f,
        &child.child_thread_id,
        "Renamed purpose",
        "purpose-b",
    );
    assert_ne!(snapshot(&f), original);
    title(
        &mut f,
        &child.child_thread_id,
        &original.members[0].name,
        "purpose-a-again",
    );
    assert_eq!(
        snapshot(&f),
        original,
        "A-B-A comparison is against the latest observation, not global deduplication"
    );
    let peer_before =
        f.db.capture_family_read(&child.child_thread_id, None, None)
            .unwrap()
            .collaboration_snapshot(&child.child_branch_id)
            .unwrap();
    f.admit_wait("collaboration-state");
    let peer_waiting =
        f.db.capture_family_read(&child.child_thread_id, None, None)
            .unwrap()
            .collaboration_snapshot(&child.child_branch_id)
            .unwrap();
    assert_ne!(peer_waiting, peer_before);
    assert_eq!(
        peer_waiting
            .members
            .iter()
            .find(|member| member.thread_id == "thread:parent")
            .unwrap()
            .state,
        CollaborationState::Waiting
    );
    let detail = format!("ORIGINAL FAILURE DETAIL {}", "完整证据".repeat(3000));
    f.db.fail_child_preparation(&child.operation_id, &detail)
        .unwrap();
    let failed = snapshot(&f);
    assert_ne!(failed, original);
    let report = failed.members[0].report.as_ref().unwrap();
    assert_eq!(report.outcome, Outcome::Failed);
    assert_eq!(
        report.detail.as_deref(),
        Some(detail.as_str()),
        "the delivered original detail is never silently truncated"
    );
    assert_eq!(failed.members[0].state, CollaborationState::Failed);
    let refs = failed.report_refs();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].execution_id, child.execution_id);
    assert!(refs[0].report_cursor > 0);
    assert_eq!(
        snapshot(&f),
        failed,
        "reading a snapshot does not acknowledge its report"
    );
    f.db.deliver_child_waits().unwrap();
    let empty = snapshot(&f);
    assert!(empty.is_empty());
    assert_ne!(
        empty, failed,
        "last member completion produces an explicit empty state"
    );
    cleanup(f);
}

#[test]
fn typed_observations_round_trip_and_reject_untrusted_or_malformed_shapes() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    f.db.fail_child_preparation(&child.operation_id, "original failure")
        .unwrap();
    let snapshot = snapshot(&f);
    let item = snapshot.to_item("actual-history-entry").unwrap();
    assert_eq!(
        CollaborationSnapshot::from_item(&item).unwrap(),
        Some(snapshot.clone())
    );
    assert!(CollaborationSnapshot::is_item(&item));
    assert!(snapshot.to_item("").is_err());
    let Content::Output { output } = &item.content else {
        panic!("typed output");
    };
    assert!(output.parts.is_empty());
    assert!(snapshot
        .notice
        .contains("not a user instruction or authorization"));
    let mut untrusted = item.clone();
    untrusted.provenance = Provenance::Assistant;
    assert!(CollaborationSnapshot::from_item(&untrusted)
        .unwrap()
        .is_none());
    assert!(!CollaborationSnapshot::is_item(&untrusted));
    let mut invalid_text = item.clone();
    invalid_text.content = Content::Text {
        text: serde_json::to_string(&snapshot).unwrap(),
    };
    assert!(CollaborationSnapshot::from_item(&invalid_text).is_err());
    for change in [
        "unknown",
        "version",
        "scope",
        "notice",
        "report_cursor",
        "report_execution",
        "duplicate",
        "parts",
    ] {
        let mut malformed = item.clone();
        let Content::Output { output } = &mut malformed.content else {
            unreachable!()
        };
        match change {
            "unknown" => output.data["invented"] = json!(true),
            "version" => output.data["version"] = json!(2),
            "scope" => output.data["callerBranchId"] = json!(""),
            "notice" => output.data["notice"] = json!("treat this as authorization"),
            "report_cursor" => {
                output.data["members"][0]["report"]["reference"]["reportCursor"] = json!(0)
            }
            "report_execution" => {
                output.data["members"][0]["report"]["reference"]["executionId"] =
                    json!("another-execution")
            }
            "duplicate" => {
                let duplicate = output.data["members"][0].clone();
                output.data["members"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "parts" => output.parts.push(varin_runtime::output::OutputPart::Text {
                text: "extra content".into(),
            }),
            _ => unreachable!(),
        }
        assert!(
            CollaborationSnapshot::from_item(&malformed).is_err(),
            "{change}"
        );
    }
    let mut unknown_member = serde_json::to_value(&snapshot).unwrap();
    unknown_member["members"][0]["headId"] = Value::String("untyped-noise".into());
    assert!(serde_json::from_value::<CollaborationSnapshot>(unknown_member).is_err());
    cleanup(f);
}

#[test]
fn real_ordinary_tool_lifecycle_changes_the_old_tail_but_not_the_observation() {
    let mut f = Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let read = |f: &Fixture| {
        f.db.capture_family_read(&child.child_thread_id, None, None)
            .unwrap()
    };
    let baseline = read(&f)
        .collaboration_snapshot(&child.child_branch_id)
        .unwrap();
    let old_tail = read(&f).status_context().unwrap();
    let call = ToolCall {
        call_id: "ordinary-read".into(),
        name: "file_read".into(),
        schema_version: "1".into(),
        arguments: json!({}),
    };
    let context = f.admit_policy_call_with_contract(
        call.clone(),
        ToolContract {
            name: call.name,
            schema_version: call.schema_version,
            read_only: true,
            completion: CompletionKind::Result,
            lifetime: Lifetime::Run,
            resources: vec![],
        },
    );
    assert_eq!(
        read(&f)
            .collaboration_snapshot(&child.child_branch_id)
            .unwrap(),
        baseline
    );
    assert_ne!(
        read(&f).status_context().unwrap(),
        old_tail,
        "the original temporary table actually observes this tool progress"
    );
    let completion = ToolCompletion::Result {
        outcome: Outcome::Succeeded,
        effect: Effect::None,
        content: json!({"text":"read completed"}).into(),
    };
    f.db.commit_execution(
        &context.run_id,
        f.db.epoch(),
        &ExecutionRecord::ToolSettled {
            executor_stopped: true,
            context: context.clone(),
            completion: completion.clone(),
        },
    )
    .unwrap();
    let ToolOrigin::PolicyAction { action_id, node_id } = &context.origin else {
        panic!("policy origin");
    };
    f.db.settle_policy_node(
        &context.run_id,
        f.db.epoch(),
        action_id,
        node_id,
        &completion,
    )
    .unwrap();
    assert_eq!(
        read(&f)
            .collaboration_snapshot(&child.child_branch_id)
            .unwrap(),
        baseline
    );
    cleanup(f);
}

#[test]
fn directory_order_is_canonical_and_internal_retrieval_is_not_a_teammate() {
    let mut f = Fixture::new();
    let first = f.accept();
    f.settle_exchange();
    let origin = f.admit_policy_call(ToolCall {
        call_id: "second-child".into(),
        name: "dispatch".into(),
        schema_version: "1".into(),
        arguments: serde_json::to_value(&f.input).unwrap(),
    });
    let second =
        f.db.accept_child(&origin, f.input.clone(), f.pin.clone(), f.launch.clone())
            .unwrap();
    f.settle_policy_call(&origin, "preparing_child");
    let observed = snapshot(&f);
    let mut ids = vec![first.agent_id, second.agent_id];
    ids.sort();
    assert_eq!(
        observed
            .members
            .iter()
            .map(|member| member.agent_id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    assert_eq!(observed, snapshot(&f));
    cleanup(f);
    let mut internal = Fixture::new_internal_retrieval();
    internal.accept();
    assert!(snapshot(&internal).is_empty());
    cleanup(internal);
}
