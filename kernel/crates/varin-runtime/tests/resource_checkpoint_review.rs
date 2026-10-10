#[path = "fixtures/content_collection.rs"]
mod content_collection;
use serde_json::{json, Value};
use std::sync::Arc;
use varin_runtime::catalog::{
    context::{ContextCheckpoint, ContextProposal},
    launches::{LaunchSelection, SourceSelection},
    personalization::PersonalizationBasis,
    resources::ContextResources,
};
use varin_runtime::execution::*;
use varin_runtime::{Catalog, Receipt, RunState, SubmitInput};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-resource-review-{}", uuid::Uuid::new_v4())))
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn schema() -> ToolSchema {
    ToolSchema {
        name: "resource_read".into(),
        version: "1".into(),
        description: "Read selected resource".into(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    }
}
fn source(mode: &str, branch: &str) -> SourceSelection {
    serde_json::from_value(
        json!({"mode":mode,"workspace_id":"workspace","execution_workspace_id":"execution",
        "branch_id":branch,"revision":1,"live_root":null}),
    )
    .unwrap()
}
fn basis(text: &str) -> PersonalizationBasis {
    serde_json::from_value(json!({"mode":"agent","threadRole":"main","revision":1,"configurationDigest":"profile-1",
        "memorySnapshot":{"revision":7,"memories":[]},"sessionId":"thread","projectId":"project",
        "originalSections":[{"name":"instructions","content":text}],"instructionSources":["fixture-source"]})).unwrap()
}
fn resources(text: &str, source: Option<SourceSelection>) -> ContextResources {
    let reference = json!({"domainId":"resource-domain","viewId":format!("view-{text}"),"path":"skill/SKILL.md",
        "canonicalId":"resource-domain/skill/SKILL.md","version":format!("version-{text}")});
    serde_json::from_value(json!({"source":source,"snapshot":{
        "id":format!("snapshot-{text}"),"scope":{"threadId":"thread","branchId":"main","mode":"agent","threadRole":"main",
            "projectId":"project","sourceIdentity":source.as_ref().map(|_|"fixed-source-identity"),"cwd":"","projectTrusted":true,"projectRoot":"/project"},
        "readers":[{"domainId":"resource-domain","viewId":format!("view-{text}"),"consistency":"immutable"}],"project":null,
        "configurationDigest":"resource-config","shadowedContextCanonicalIds":[],"system":null,"appendSystem":null,"instructions":[],
        "instructionScopes":[],"skills":[{"id":"skill","name":"skill","description":"fixture skill","disableModelInvocation":false,"requiresProjectTrust":false,
            "origin":"user","reference":reference,"basePath":"skill","baseCanonicalId":"resource-domain/skill","priority":0}],
        "diagnostics":[],"capturedFiles":[{"reference":reference,"content":text}],"observations":[]
    }})).unwrap()
}
fn proposal(text: &str) -> ContextProposal {
    ContextProposal {
        key: "initial-context:main".into(),
        branch_id: "main".into(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: text.into(),
        instruction_sources: vec!["fixture-source".into()],
        memory_checkpoint: Some("memory-7".into()),
    }
}
fn binding(branch: &str, head: Option<String>) -> RequestBinding {
    RequestBinding {
        resource_checkpoint_id: None,
        connection_identity: "connection".into(),
        provider_family: "fixture".into(),
        model: "model".into(),
        credential_ref: None,
        configuration_generation: 1,
        tool_schema_generation: 1,
        tools: vec![schema()],
        instruction_sources: vec![],
        memory_checkpoint: None,
        attachment_refs: vec![],
        environment_cursor: 0,
        history_range: HistoryRange {
            branch_id: branch.into(),
            ancestor_id: None,
            leaf_id: head,
        },
    }
}
fn launch(source: Option<SourceSelection>) -> LaunchSelection {
    LaunchSelection::from_binding(
        &binding("main", None),
        PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        },
        source,
    )
}
fn command(db: &Catalog, key: &str, branch: &str) -> SubmitInput {
    SubmitInput {
        key: key.into(),
        thread_id: "thread".into(),
        branch_id: branch.into(),
        expected_head: db.head(branch).unwrap(),
        input: json!({"text":key}),
        configuration: json!({}),
    }
}
fn admit(db: &mut Catalog, key: &str, text: &str, source: Option<SourceSelection>) -> Receipt {
    let expected = db
        .active_context("main")
        .unwrap()
        .map(|checkpoint| checkpoint.id);
    let prepared = db
        .prepare_submission(
            command(db, key, "main"),
            Some(proposal(text)),
            Some(basis(text)),
        )
        .unwrap()
        .with_resources(Some(resources(text, source.clone())))
        .with_expected_context_checkpoint(expected)
        .load(Some(launch(source)), false)
        .unwrap();
    db.admit_submission(prepared).unwrap()
}
fn finish(db: &mut Catalog, receipt: &Receipt) {
    let run = db.run(&receipt.run_id).unwrap();
    let run = db
        .transition_run(&run.id, run.epoch, run.revision, RunState::Runnable)
        .unwrap();
    db.transition_run(&run.id, run.epoch, run.revision, RunState::Completed)
        .unwrap();
}
fn refresh(db: &mut Catalog, text: &str) -> ContextCheckpoint {
    let old = db.active_context("main").unwrap().unwrap();
    let source = old.resources.as_ref().unwrap().source.clone();
    let prepared = db
        .prepare_resource_refresh(
            "main",
            old.revision,
            text.into(),
            vec!["fixture-source".into()],
            old.proposal.memory_checkpoint,
            basis(text),
            resources(text, source),
        )
        .unwrap()
        .load()
        .unwrap();
    db.publish_resource_refresh(prepared).unwrap()
}
fn model_call(db: &mut Catalog, receipt: &Receipt, checkpoint: &str) -> ToolOrigin {
    let mut binding = binding(&receipt.branch_id, db.head(&receipt.branch_id).unwrap());
    binding.resource_checkpoint_id = Some(checkpoint.into());
    let snapshot = RequestSnapshot {
        view: RequestView {
            request_id: "model-step".into(),
            run_id: receipt.run_id.clone(),
            origin: RequestOrigin::Conversation {
                step: 1,
                history_range: binding.history_range.clone(),
            },
            binding,
            history: vec![],
        },
        serialized: json!({"fixture":true}),
    };
    let epoch = db.epoch();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared { snapshot },
    )
    .unwrap();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::ModelDispatched {
            request_id: "model-step".into(),
        },
    )
    .unwrap();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::ModelFinished {
            request_id: "model-step".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::ToolCalls),
            items: vec![ProviderItem {
                id: "resource-call-item".into(),
                content: Content::ToolCall {
                    call: ToolCall {
                        call_id: "read-skill".into(),
                        name: "resource_read".into(),
                        schema_version: "1".into(),
                        arguments: json!({"kind":"skill","resourceId":"skill"}),
                    },
                },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    )
    .unwrap();
    ToolOrigin::ModelStep {
        request_id: "model-step".into(),
    }
}

#[test]
fn original_model_call_reads_retained_bytes_after_refresh_and_collection() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let receipt = admit(&mut db, "first", "old bytes", None);
    let old = db.active_context("main").unwrap().unwrap();
    let origin = model_call(&mut db, &receipt, &old.id);
    let latest = refresh(&mut db, "new bytes");
    assert_ne!(old.id, latest.id);
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    let bound = db
        .capture_resource_snapshot(&receipt.run_id, &origin, "read-skill", &old.id)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(bound, old.resources.unwrap());
    assert_eq!(bound.snapshot.captured_files[0].content, "old bytes");
    assert!(db
        .capture_resource_snapshot(&receipt.run_id, &origin, "read-skill", &latest.id)
        .unwrap()
        .load()
        .is_err());
    assert!(db
        .capture_resource_snapshot(&receipt.run_id, &origin, "forged-call", &old.id)
        .is_err());
    let sql = rusqlite::Connection::open(f.0.join("conversation.sqlite")).unwrap();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM operations", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    drop(sql);
    drop(db);
    let db = f.open();
    assert_eq!(
        db.capture_resource_snapshot(&receipt.run_id, &origin, "read-skill", &old.id)
            .unwrap()
            .load()
            .unwrap()
            .snapshot
            .captured_files[0]
            .content,
        "old bytes"
    );
    assert_eq!(
        db.active_context("main").unwrap().unwrap().resources,
        latest.resources
    );
}

#[test]
fn policy_graph_freezes_original_resource_checkpoint_without_model_step() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let receipt = admit(&mut db, "first", "policy old", None);
    let old = db.active_context("main").unwrap().unwrap();
    let boundary = db.policy_boundary(&receipt.run_id, db.epoch()).unwrap();
    let action_id = format!("{}:policy:{}", receipt.run_id, boundary.id);
    let origin = ToolOrigin::PolicyAction {
        action_id: action_id.clone(),
        node_id: "read-node".into(),
    };
    let intent = PolicyGraphIntent::PolicyToolGraphV1 {
        action_id,
        boundary,
        identity: PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        },
        state: Value::Null,
        nodes: vec![PolicyAdmittedNode {
            node: PolicyToolNode {
                id: "read-node".into(),
                depends_on: vec![],
                call: ToolCall {
                    call_id: "read-node".into(),
                    name: "resource_read".into(),
                    schema_version: "1".into(),
                    arguments: json!({"kind":"skill","resourceId":"skill"}),
                },
            },
            context: FrozenToolContext {
                resource_checkpoint_id: Some(old.id.clone()),
                run_id: receipt.run_id.clone(),
                origin: origin.clone(),
                tool_schema_generation: 1,
                tools: Arc::new(vec![schema()]),
                source: None,
            },
        }],
    };
    db.admit_policy_graph(&receipt.run_id, db.epoch(), &intent)
        .unwrap();
    let latest = refresh(&mut db, "policy new");
    assert_eq!(
        db.capture_resource_snapshot(&receipt.run_id, &origin, "read-node", &old.id)
            .unwrap()
            .load()
            .unwrap(),
        old.resources.unwrap()
    );
    assert!(db
        .capture_resource_snapshot(&receipt.run_id, &origin, "read-node", &latest.id)
        .unwrap()
        .load()
        .is_err());
    assert!(db
        .capture_resource_snapshot(&receipt.run_id, &origin, "other-node", &old.id)
        .unwrap()
        .load()
        .is_err());
}

#[test]
fn resource_refresh_preserves_summary_memory_and_rejects_stale_or_profile_changes() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let receipt = admit(&mut db, "first", "old", None);
    let mut summary = proposal("old");
    summary.key = "summary".into();
    summary.expected_revision = 1;
    summary.through_id = Some(receipt.input_id.clone());
    summary.summary = "Preserve this summary".into();
    let compacted = db.publish_context(summary).unwrap();
    let stale = db
        .prepare_resource_refresh(
            "main",
            compacted.revision,
            "stale".into(),
            vec!["fixture-source".into()],
            Some("memory-7".into()),
            basis("stale"),
            resources("stale", None),
        )
        .unwrap()
        .load()
        .unwrap();
    let updated = refresh(&mut db, "new");
    assert_eq!(updated.proposal.summary, compacted.proposal.summary);
    assert_eq!(updated.proposal.through_id, compacted.proposal.through_id);
    assert_eq!(
        updated.personalization.as_ref().unwrap().memory_snapshot,
        compacted.personalization.as_ref().unwrap().memory_snapshot
    );
    assert!(db.publish_resource_refresh(stale).is_err());
    let mut changed = basis("new");
    changed.memory_snapshot.revision += 1;
    assert!(db
        .prepare_resource_refresh(
            "main",
            updated.revision,
            "new".into(),
            vec!["fixture-source".into()],
            Some("memory-7".into()),
            changed,
            resources("new", None)
        )
        .unwrap()
        .load()
        .is_err());
    assert!(db
        .prepare_personalization_refresh(
            "main",
            updated.revision,
            "profile inject".into(),
            vec!["fixture-source".into()],
            Some("memory-7".into()),
            basis("replaced original source")
        )
        .unwrap()
        .load()
        .is_err());
    assert_eq!(db.active_context("main").unwrap().unwrap(), updated);
}

#[test]
fn explicit_source_switch_publishes_context_and_run_atomically_with_actual_environment_owner() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let physical = source("materialized", "same-base");
    let first = admit(&mut db, "first", "source-a", Some(physical.clone()));
    let old = db.active_context("main").unwrap().unwrap();
    assert_eq!(
        old.resources
            .as_ref()
            .unwrap()
            .source
            .as_ref()
            .unwrap()
            .environment_run_id
            .as_deref(),
        Some(first.run_id.as_str())
    );
    finish(&mut db, &first);
    let next = admit(&mut db, "next", "source-b", Some(physical.clone()));
    let current = db.active_context("main").unwrap().unwrap();
    assert_eq!(
        current
            .resources
            .as_ref()
            .unwrap()
            .source
            .as_ref()
            .unwrap()
            .environment_run_id
            .as_deref(),
        Some(next.run_id.as_str())
    );
    assert_ne!(
        old.resources.as_ref().unwrap().source,
        current.resources.as_ref().unwrap().source
    );
    assert_eq!(
        db.capture_admitted_checkpoint(&next.run_id)
            .unwrap()
            .unwrap()
            .load()
            .unwrap(),
        current
    );
    assert_eq!(
        current.proposal.memory_checkpoint,
        old.proposal.memory_checkpoint
    );
    finish(&mut db, &next);
    let prepared = db
        .prepare_submission(
            command(&db, "raced", "main"),
            Some(proposal("raced")),
            Some(basis("raced")),
        )
        .unwrap()
        .with_resources(Some(resources("raced", Some(physical))))
        .with_expected_context_checkpoint(Some(current.id.clone()))
        .load(
            Some(launch(Some(source("materialized", "same-base")))),
            false,
        )
        .unwrap();
    let preserved = refresh(&mut db, "won-refresh");
    assert!(db.admit_submission(prepared).is_err());
    assert_eq!(db.active_context("main").unwrap().unwrap(), preserved);
    assert_eq!(db.head("main").unwrap(), Some(next.input_id));
}

#[test]
fn fork_and_reopen_preserve_resource_snapshot_provenance_and_bytes() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let first = admit(
        &mut db,
        "first",
        "immutable fork body",
        Some(source("materialized", "source")),
    );
    let original = db.active_context("main").unwrap().unwrap();
    let prepared = db
        .prepare_branch_fork("main", "fork", Some(&first.input_id), None)
        .unwrap()
        .load()
        .unwrap();
    refresh(&mut db, "later main body");
    db.admit_branch_fork(prepared).unwrap();
    let fork = db.active_context("fork").unwrap().unwrap();
    assert_eq!(fork.resources, original.resources);
    assert_eq!(
        fork.resources.as_ref().unwrap().snapshot.scope.branch_id,
        "main"
    );
    assert_eq!(fork.proposal.branch_id, "fork");
    let input = db
        .prepare_submission(command(&db, "fork-input", "fork"), None, None)
        .unwrap()
        .load(Some(launch(None)), true)
        .unwrap();
    let fork_run = db.admit_submission(input).unwrap();
    assert!(db
        .launch_intent(&fork_run.run_id)
        .unwrap()
        .unwrap()
        .selection
        .source
        .is_none());
    let origin = model_call(&mut db, &fork_run, &fork.id);
    assert_eq!(
        db.capture_resource_snapshot(&fork_run.run_id, &origin, "read-skill", &fork.id)
            .unwrap()
            .load()
            .unwrap(),
        fork.resources.clone().unwrap()
    );
    drop(db);
    let db = f.open();
    assert_eq!(db.active_context("fork").unwrap().unwrap(), fork);
}

#[test]
fn input_retry_returns_original_receipt_before_current_context_validation() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let first = admit(
        &mut db,
        "first",
        "source-a",
        Some(source("fixed_branch", "source-a")),
    );
    finish(&mut db, &first);
    let command = command(&db, "source-switch", "main");
    let selected = Some(launch(Some(source("fixed_branch", "source-b"))));
    let candidate = resources("source-b", Some(source("fixed_branch", "source-b")));
    let original_checkpoint = db.active_context("main").unwrap().unwrap().id;
    let prepared = db
        .prepare_submission(
            command.clone(),
            Some(proposal("source-b")),
            Some(basis("source-b")),
        )
        .unwrap()
        .with_resources(Some(candidate.clone()))
        .with_expected_context_checkpoint(Some(original_checkpoint.clone()))
        .load(selected.clone(), false)
        .unwrap();
    let receipt = db.admit_submission(prepared).unwrap();
    let latest = refresh(&mut db, "later prompt");
    let mut changed_basis = latest.personalization.clone().unwrap();
    changed_basis.revision += 1;
    let profile = db
        .prepare_personalization_refresh(
            "main",
            latest.revision,
            "later profile".into(),
            latest.proposal.instruction_sources.clone(),
            latest.proposal.memory_checkpoint.clone(),
            changed_basis,
        )
        .unwrap()
        .load()
        .unwrap();
    let latest = db.publish_personalization_refresh(profile).unwrap();
    let retried = db
        .prepare_submission(
            command.clone(),
            Some(proposal("source-b")),
            Some(basis("source-b")),
        )
        .unwrap()
        .with_resources(Some(candidate.clone()))
        .with_expected_context_checkpoint(Some(original_checkpoint.clone()))
        .load(selected.clone(), false)
        .unwrap();
    assert_eq!(db.admit_submission(retried).unwrap(), receipt);
    assert_eq!(db.active_context("main").unwrap().unwrap(), latest);
    let mut changed = command.clone();
    changed.input = json!("different command");
    assert!(db
        .prepare_submission(changed, None, None)
        .unwrap()
        .load(selected, false)
        .is_err());
    assert!(db
        .prepare_submission(command, None, None)
        .unwrap()
        .load(
            Some(launch(Some(source("fixed_branch", "different-source")))),
            false
        )
        .is_err());
}

#[test]
fn resource_refresh_can_remove_project_trust_without_changing_scope() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    admit(&mut db, "first", "trusted", None);
    let original = db.active_context("main").unwrap().unwrap();
    let mut untrusted = resources("untrusted", None);
    untrusted.snapshot.scope.project_trusted = false;
    let prepared = db
        .prepare_resource_refresh(
            "main",
            original.revision,
            "untrusted".into(),
            vec!["fixture-source".into()],
            original.proposal.memory_checkpoint.clone(),
            basis("untrusted"),
            untrusted,
        )
        .unwrap()
        .load()
        .unwrap();
    let updated = db.publish_resource_refresh(prepared).unwrap();
    assert!(!updated.resources.unwrap().snapshot.scope.project_trusted);
}

#[test]
fn compaction_copies_original_resource_bytes_even_before_previous_summary_boundary() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let first = admit(&mut db, "first", "immutable resource", None);
    finish(&mut db, &first);
    let second = db
        .prepare_submission(command(&db, "second", "main"), None, None)
        .unwrap()
        .load(Some(launch(None)), true)
        .unwrap();
    let second = db.admit_submission(second).unwrap();
    finish(&mut db, &second);
    let mut previous = proposal("immutable resource");
    previous.key = "later-summary".into();
    previous.expected_revision = 1;
    previous.through_id = Some(second.input_id.clone());
    previous.summary = "Summary after the earlier boundary".into();
    let original = db.publish_context(previous).unwrap();
    let request = varin_runtime::context_job::ContextJobRequest {
        owner_run_id: None,
        personalization: original.personalization.clone(),
        key: "earlier-compaction".into(),
        branch_id: "main".into(),
        through_id: first.input_id,
        expected_revision: original.revision,
        effective_system_prompt: original.proposal.effective_system_prompt.clone(),
        instruction_sources: original.proposal.instruction_sources.clone(),
        memory_checkpoint: original.proposal.memory_checkpoint.clone(),
    };
    let job = db
        .create_context_job(request, launch(None), json!({}))
        .unwrap();
    let mut binding = binding(&job.receipt.branch_id, Some(job.receipt.input_id.clone()));
    binding.tools.clear();
    binding.tool_schema_generation = 0;
    let snapshot = RequestSnapshot {
        view: RequestView {
            request_id: "summary-step".into(),
            run_id: job.receipt.run_id.clone(),
            origin: RequestOrigin::Conversation {
                step: 1,
                history_range: binding.history_range.clone(),
            },
            binding,
            history: vec![],
        },
        serialized: json!({}),
    };
    let epoch = db.epoch();
    for record in [
        ExecutionRecord::RequestPrepared { snapshot },
        ExecutionRecord::ModelDispatched {
            request_id: "summary-step".into(),
        },
        ExecutionRecord::ModelFinished {
            request_id: "summary-step".into(),
            outcome: ModelOutcome::Completed,
            finish_reason: Some(FinishReason::Stop),
            items: vec![ProviderItem {
                id: "summary".into(),
                content: Content::Text {
                    text: "Earlier summary".into(),
                },
                opaque: None,
            }],
            interrupted_deltas: vec![],
            usage: UsageReceipt::default(),
            failure: None,
        },
    ] {
        db.commit_execution(&job.receipt.run_id, epoch, &record)
            .unwrap();
    }
    finish(&mut db, &job.receipt);
    let compacted = db.publish_context_job(&job.receipt.run_id).unwrap();
    assert_eq!(compacted.resources, original.resources);
    assert_eq!(compacted.proposal.summary, "Earlier summary");
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    drop(db);
    let db = f.open();
    assert_eq!(db.active_context("main").unwrap().unwrap(), compacted);
}

#[test]
fn late_input_preparation_cannot_overwrite_a_checkpoint_newer_than_the_host_candidate() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let first = admit(
        &mut db,
        "first",
        "source-a",
        Some(source("fixed_branch", "source-a")),
    );
    finish(&mut db, &first);
    let original = db.active_context("main").unwrap().unwrap();
    let next_command = command(&db, "late-source-switch", "main");
    let candidate = resources("source-b", Some(source("fixed_branch", "source-b")));
    let current = refresh(&mut db, "newer-resource-selection");
    let prepared = db
        .prepare_submission(
            next_command.clone(),
            Some(proposal("source-b")),
            Some(basis("source-b")),
        )
        .unwrap()
        .with_resources(Some(candidate.clone()))
        .with_expected_context_checkpoint(Some(original.id));
    assert!(prepared
        .load(Some(launch(candidate.source.clone())), false)
        .is_err());
    let missing_basis = db.prepare_submission(next_command, None, None).unwrap();
    assert!(missing_basis
        .existing_receipt(&Some(launch(candidate.source)), false)
        .unwrap()
        .is_none());
    assert_eq!(db.active_context("main").unwrap().unwrap(), current);
    assert_eq!(db.head("main").unwrap(), Some(first.input_id));
}
