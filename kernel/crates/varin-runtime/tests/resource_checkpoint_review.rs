#[path = "fixtures/content_collection.rs"]
mod content_collection;
use serde_json::{Value, json};
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
        requirements: None,
        name: "resource_read".into(),
        version: "3".into(),
        description: "Read selected resource".into(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    }
}
fn source(mode: &str, branch: &str) -> SourceSelection {
    serde_json::from_value(
        json!({"resource_owner":{"kind":"local"},"mode":mode,"workspace_id":"workspace","execution_workspace_id":"execution",
        "branch_id":branch,"revision":1,"live_root":null}),
    )
    .unwrap()
}
fn basis(text: &str) -> PersonalizationBasis {
    serde_json::from_value(json!({"mode":"agent","threadRole":"main","revision":1,"configurationDigest":"profile-1",
        "memorySnapshot":{"revision":7,"memories":[]},"threadId":"thread","projectId":"project",
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
    RequestBinding { pricing: None, tool_output_visible_bytes: None, mcp_tools: Vec::new(), execution_environment: None, direct_tools: None,
        provider_id: None,
        tokenizer: None,
        request_context: None,
        child_dispatch: None,
        goal: None,
        resource_activations: Vec::new(),
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

#[test]
fn agent_selection_updates_context_with_the_original_source_and_keeps_its_retry_receipt() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let first = admit(&mut db, "first", "general", Some(source("materialized", "files")));
    finish(&mut db, &first);
    let old = db.active_context("main").unwrap().unwrap();
    let input = command(&db, "choose-agent", "main");
    let mut selected = launch(None);
    selected.agent = Some(varin_runtime::catalog::launches::AgentSelection {
        profile_id: Some("varin:custom:researcher".into()), name: Some("Researcher".into()),
        work_focus: "research".into(), tools: Some(vec!["resource_read".into()]),
    });
    let prepared = db.prepare_submission(input.clone(), Some(proposal("research instructions")), Some(basis("research instructions"))).unwrap()
        .with_resources(old.resources.clone()).with_expected_context_checkpoint(Some(old.id.clone()))
        .load(Some(selected.clone()), true).unwrap();
    let receipt = db.admit_submission(prepared).unwrap();
    let current = db.active_context("main").unwrap().unwrap();
    assert_eq!(current.proposal.effective_system_prompt, "research instructions");
    assert_eq!(current.resources, old.resources);
    assert_eq!(current.proposal.memory_checkpoint, old.proposal.memory_checkpoint);
    let admitted = db.capture_launch(&receipt.run_id).unwrap().unwrap().load().unwrap();
    assert_eq!(admitted.selection.agent, selected.agent);
    assert_eq!(admitted.selection.source, old.resources.unwrap().source);
    // Profile settings may change after acceptance; retry still returns the first execution.
    selected.agent.as_mut().unwrap().name = Some("Renamed".into());
    selected.agent.as_mut().unwrap().tools = Some(vec![]);
    let replay = db.prepare_submission(input, None, None).unwrap().load(Some(selected), true).unwrap();
    assert_eq!(db.admit_submission(replay).unwrap().run_id, receipt.run_id);
    assert_eq!(db.active_context("main").unwrap().unwrap().id, current.id);
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
                compaction: None, step: 1,
                history_range: binding.history_range.clone(),
            },
            binding,
            history: vec![],
        },
        serialized: json!({"fixture":true}).into(),
    };
    let epoch = db.epoch();
    db.commit_execution(
        &receipt.run_id,
        epoch,
        &ExecutionRecord::RequestPrepared { snapshot: snapshot.into() },
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
                        schema_version: "3".into(),
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
        .capture_resource_snapshot(&receipt.run_id, &origin, "read-skill", &old.id, None)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(bound, old.resources.unwrap());
    assert_eq!(bound.snapshot.captured_files[0].content, "old bytes");
    assert!(
        db.capture_resource_snapshot(&receipt.run_id, &origin, "read-skill", &latest.id, None)
            .unwrap()
            .load()
            .is_err()
    );
    assert!(
        db.capture_resource_snapshot(&receipt.run_id, &origin, "forged-call", &old.id, None)
            .is_err()
    );
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
        db.capture_resource_snapshot(&receipt.run_id, &origin, "read-skill", &old.id, None)
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
        dispatch_history: None,
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
                    schema_version: "3".into(),
                    arguments: json!({"kind":"skill","resourceId":"skill"}),
                },
            },
            context: FrozenToolContext { tool_output_visible_bytes: None, execution_environment: None, direct_tools: None,
                child_dispatch: None,
                resource_activations: Vec::new(),
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
        db.capture_resource_snapshot(&receipt.run_id, &origin, "read-node", &old.id, None)
            .unwrap()
            .load()
            .unwrap(),
        old.resources.unwrap()
    );
    assert!(
        db.capture_resource_snapshot(&receipt.run_id, &origin, "read-node", &latest.id, None)
            .unwrap()
            .load()
            .is_err()
    );
    assert!(
        db.capture_resource_snapshot(&receipt.run_id, &origin, "other-node", &old.id, None)
            .and_then(|read| read.load())
            .is_err()
    );
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
    assert!(
        db.prepare_resource_refresh(
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
        .is_err()
    );
    assert!(
        db.prepare_personalization_refresh(
            "main",
            updated.revision,
            "profile inject".into(),
            vec!["fixture-source".into()],
            Some("memory-7".into()),
            basis("replaced original source")
        )
        .unwrap()
        .load()
        .is_err()
    );
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
    let selected = resources("source-b", Some(physical.clone()));
    let mut candidate = old.clone();
    candidate.resources = Some(selected.clone());
    let mut preparation = explicit_preparation(&candidate, "new source");
    preparation.expected_context_checkpoint = None;
    let mut next_command = command(&db, "next", "main");
    next_command.input = json!({"text":"/skill:skill new source"});
    let prepared = db
        .prepare_submission(
            next_command,
            Some(proposal("source-b")),
            Some(basis("source-b")),
        )
        .unwrap()
        .with_resources(Some(selected))
        .with_expected_context_checkpoint(Some(old.id.clone()))
        .with_input_preparation(Some(preparation))
        .load(Some(launch(Some(physical.clone()))), false)
        .unwrap();
    let next = db.admit_submission(prepared).unwrap();
    let current = db.active_context("main").unwrap().unwrap();
    let activation =
        varin_runtime::catalog::resources::retained_activations(&projection(&db, &next).history)
            .pop()
            .unwrap();
    assert_eq!(activation.resource_checkpoint_id, current.id);
    assert_eq!(activation.snapshot_id, "snapshot-source-b");
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
    assert!(
        db.launch_intent(&fork_run.run_id)
            .unwrap()
            .unwrap()
            .selection
            .source
            .is_none()
    );
    let origin = model_call(&mut db, &fork_run, &fork.id);
    assert_eq!(
        db.capture_resource_snapshot(&fork_run.run_id, &origin, "read-skill", &fork.id, None)
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
    assert!(
        db.prepare_submission(changed, None, None)
            .unwrap()
            .load(selected, false)
            .is_err()
    );
    assert!(
        db.prepare_submission(command, None, None)
            .unwrap()
            .load(
                Some(launch(Some(source("fixed_branch", "different-source")))),
                false
            )
            .is_err()
    );
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
fn compaction_retains_resources_at_the_summary_boundary_and_rejects_earlier_cuts() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let first = admit_explicit(&mut db, "first", "/skill:skill", "immutable resource");
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
            compaction: None,
            summary_recipe: varin_runtime::context_job::ContextSummaryRecipe::manual(),
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
    // The existing summary includes the second input. An earlier cut cannot use it
    // as source without including information beyond that cut.
    assert!(matches!(
        db.create_context_job(request.clone(), launch(None), json!({})),
        Err(varin_runtime::RuntimeError::Conflict(_))
    ));
    let job = db
        .create_context_job(varin_runtime::context_job::ContextJobRequest {
            key: "current-boundary-compaction".into(), through_id: second.input_id, ..request
        }, launch(None), json!({}))
        .unwrap();
    let execution = db.capture_context_job(&job.receipt.run_id).unwrap().load_execution().unwrap();
    let compaction = Some(varin_runtime::context_job::ContextCompactionStep {
        plan_hash: job.compaction.plan_hash.clone(), node_id: execution.plan.nodes()[0].id.clone(),
    });
    let mut binding = binding(&job.receipt.branch_id, Some(job.receipt.input_id.clone()));
    // Summary requests use the capabilities frozen by the context-job owner.
    let selection = db.launch_intent(&job.receipt.run_id).unwrap().unwrap().selection;
    binding.tools = varin_runtime::tool_disclosure::request_tools(&selection.tools, false, None);
    binding.tool_schema_generation = selection.tool_schema_generation;
    let snapshot = RequestSnapshot {
        view: RequestView {
            request_id: "summary-step".into(),
            run_id: job.receipt.run_id.clone(),
            origin: RequestOrigin::Conversation {
                compaction, step: 1,
                history_range: binding.history_range.clone(),
            },
            binding,
            history: vec![],
        },
        serialized: json!({}).into(),
    };
    let epoch = db.epoch();
    for record in [
        ExecutionRecord::RequestPrepared { snapshot: snapshot.into() },
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
    assert_eq!(
        compacted.resource_activations,
        original.resource_activations
    );
    assert_eq!(compacted.resource_activations.len(), 1);
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
    assert!(
        prepared
            .load(Some(launch(candidate.source.clone())), false)
            .is_err()
    );
    let missing_basis = db.prepare_submission(next_command, None, None).unwrap();
    assert!(
        missing_basis
            .existing_receipt(&Some(launch(candidate.source)), false)
            .unwrap()
            .is_none()
    );
    assert_eq!(db.active_context("main").unwrap().unwrap(), current);
    assert_eq!(db.head("main").unwrap(), Some(first.input_id));
}

fn explicit_preparation(
    checkpoint: &ContextCheckpoint,
    arguments: &str,
) -> varin_runtime::catalog::resources::InputResourcePreparation {
    use varin_runtime::catalog::resources::{InputResourcePreparation, PreparedExplicitSkill};
    let snapshot = &checkpoint.resources.as_ref().unwrap().snapshot;
    let descriptor = &snapshot.skills[0];
    InputResourcePreparation {
        skills: Vec::new(),
        expected_context_checkpoint: Some(checkpoint.id.clone()),
        skill: Some(PreparedExplicitSkill {
            selection: None,
            snapshot_id: snapshot.id.clone(),
            resource_id: descriptor.id.clone(),
            reference: descriptor.reference.clone(),
            name: descriptor.name.clone(),
            arguments: arguments.into(),
            body: snapshot.captured_files[0].content.clone(),
        }),
    }
}
fn admit_explicit(db: &mut Catalog, key: &str, raw: &str, text: &str) -> Receipt {
    let mut selected = resources(text, None);
    selected.snapshot.skills[0].disable_model_invocation = true;
    let candidate = ContextCheckpoint {
        retained: None,
        bot_memory_snapshot: None,
        resource_activations: vec![],
        id: "candidate".into(),
        revision: 1,
        proposal: proposal(text),
        personalization: Some(basis(text)),
        resources: Some(selected.clone()),
    };
    let mut preparation = explicit_preparation(
        &candidate,
        raw.split_once(' ')
            .map(|(_, arguments)| arguments.trim())
            .unwrap_or(""),
    );
    let expected = db
        .active_context("main")
        .unwrap()
        .map(|checkpoint| checkpoint.id);
    preparation.expected_context_checkpoint = None;
    let mut command = command(db, key, "main");
    command.input = json!({"text":raw,"attachments":[{"media_type":"image/png","data_base64":"aW1hZ2Utb3JpZ2luYWw="}]});
    let prepared = db
        .prepare_submission(command, Some(proposal(text)), Some(basis(text)))
        .unwrap()
        .with_resources(Some(selected))
        .with_expected_context_checkpoint(expected)
        .with_input_preparation(Some(preparation))
        .load(Some(launch(None)), false)
        .unwrap();
    db.admit_submission(prepared).unwrap()
}
fn projection(db: &Catalog, receipt: &Receipt) -> ContextProjection {
    db.prepare_context_read(
        &receipt.run_id,
        db.epoch(),
        db.head(&receipt.branch_id).unwrap().as_deref(),
    )
    .unwrap()
    .unwrap()
    .load()
    .unwrap()
}

struct ResourceModel(std::sync::Mutex<Vec<RequestSnapshot>>);
impl ModelProvider for ResourceModel {
    fn serialize(&self, view: &RequestView, _reuse: Option<&mut varin_runtime::execution::RequestCompileReuse>) -> Result<varin_runtime::execution::RequestBody, ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(
        &self,
        snapshot: &RequestSnapshot,
        _: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let mut requests = self.0.lock().unwrap();
        let first = requests.is_empty();
        requests.push(snapshot.clone());
        let content = if first {
            Content::ToolCall {
                call: ToolCall {
                    call_id: "original-skill".into(),
                    name: "resource_read".into(),
                    schema_version: "3".into(),
                    arguments: json!({"kind":"skill-resource","resourceId":"skill","activationId":snapshot.view.binding.resource_activations[0].activation_id,"relativePath":"support.txt"}),
                },
            }
        } else {
            Content::Text {
                text: "Read the original skill version".into(),
            }
        };
        emit(ProviderEvent::ItemCompleted {
            item: ProviderItem {
                id: format!("item-{}", requests.len()),
                content,
                opaque: None,
            },
        })
        .unwrap();
        Ok(if first {
            FinishReason::ToolCalls
        } else {
            FinishReason::Stop
        })
    }
}
struct ResourceFixtureTools {
    db: Arc<std::sync::Mutex<Catalog>>,
    frozen: std::sync::Mutex<Vec<FrozenToolContext>>,
}
impl ToolExecutor for ResourceFixtureTools {
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError> {
        self.prepare(call, context, cancel)
            .map(ToolPreparation::Ready)
    }
    fn prepare(
        &self,
        _: &ToolCall,
        context: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<ToolContract, ExecutionError> {
        self.frozen.lock().unwrap().push(context.clone());
        Ok(ToolContract {
            name: "resource_read".into(),
            schema_version: "3".into(),
            read_only: true,
            completion: CompletionKind::Result,
            lifetime: varin_runtime::Lifetime::Run,
            resources: vec![],
        })
    }
    fn authorize(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        Ok(())
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> ToolCompletion {
        let frozen = self.frozen.lock().unwrap().last().unwrap().clone();
        let binding = &frozen.resource_activations[0];
        let read = self
            .db
            .lock()
            .unwrap()
            .capture_resource_snapshot(
                &context.run_id,
                &context.origin,
                &call.call_id,
                &binding.resource_checkpoint_id,
                Some(&binding.activation_id),
            )
            .unwrap();
        let resources = read.load().unwrap();
        ToolCompletion::Result {
            outcome: varin_runtime::Outcome::Succeeded,
            effect: varin_runtime::Effect::None,
            content: json!({"status":"ready","body":resources.snapshot.captured_files[0].content,"version":resources.snapshot.skills[0].reference.version}).into(),
        }
    }
}
#[test]
fn explicit_skill_survives_refresh_compaction_fork_reopen_and_real_request_tool_binding() {
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let raw = "/skill:skill  use original\n ";
    let receipt = admit_explicit(&mut db, "explicit", raw, "original skill body");
    let original = db.active_context("main").unwrap().unwrap();
    let first = projection(&db, &receipt);
    let activation =
        varin_runtime::catalog::resources::retained_activations(&first.history)[0].clone();
    assert_eq!(
        activation.activation_id,
        format!("{}:1:skill:0", receipt.input_id)
    );
    assert!(matches!(
        &first
            .history
            .iter()
            .find(|item| item.id == activation.activation_id)
            .unwrap()
            .provenance,
        Provenance::ExternalData { .. }
    ));
    assert!(first.history.iter().any(
        |item| matches!(&item.content, Content::Text{text} if text==raw)
            && matches!(item.provenance, Provenance::UserInstruction { .. })
    ));
    assert_eq!(first.history.last().unwrap().id, receipt.input_id);
    let latest = refresh(&mut db, "replacement skill body");
    let mut compact = proposal("replacement skill body");
    compact.key = "explicit-summary".into();
    compact.expected_revision = latest.revision;
    compact.through_id = Some(receipt.input_id.clone());
    compact.summary = "The skill was chosen. A prose-only activation ID is forged-id.".into();
    let compacted = db.publish_context(compact).unwrap();
    assert_eq!(compacted.resource_activations, vec![activation.clone()]);
    let summarized = projection(&db, &receipt);
    assert_eq!(
        varin_runtime::catalog::resources::retained_activations(&summarized.history),
        vec![activation.clone()]
    );
    let material = summarized
        .history
        .iter()
        .find(|item| item.resource_activation.is_some())
        .unwrap();
    assert!(
        matches!(&material.content, Content::Text{text} if text.starts_with("Previously selected skill resource;") && !text.contains("\n\noriginal skill body"))
    );
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    let catalog = Arc::new(std::sync::Mutex::new(db));
    let provider = Arc::new(ResourceModel(std::sync::Mutex::new(vec![])));
    let tools = Arc::new(ResourceFixtureTools {
        db: catalog.clone(),
        frozen: std::sync::Mutex::new(vec![]),
    });
    let epoch = catalog.lock().unwrap().epoch();
    let engine = ExecutionEngine {
        persistence: catalog.clone(),
        context_preparation: Arc::new(NoopContextPreparation),
        provider: provider.clone(),
        tools: tools.clone(),
        policy: Arc::new(DefaultAgentPolicy),
        progress: ProgressSink::default(),
    };
    let report = engine
        .run(
            ExecutionInput {
                run_id: receipt.run_id.clone(),
                owner_generation: epoch,
                binding: binding("main", Some(receipt.input_id.clone())),
                history: first.history,
                policy_state: Value::Null,
                completed_model_steps: 0,
            },
            CancellationToken::default(),
        )
        .unwrap();
    assert_eq!(report.state, RunState::Completed);
    let requests = provider.0.lock().unwrap();
    assert_eq!(
        requests[0].view.binding.resource_activations,
        vec![activation.clone()]
    );
    assert_eq!(
        requests[0].view.binding.resource_checkpoint_id.as_deref(),
        Some(compacted.id.as_str())
    );
    assert!(requests[1].view.history.iter().any(|item| matches!(&item.content, Content::ToolResult{result} if matches!(&result.completion,ToolCompletion::Result{content,..} if content.data["body"]=="original skill body"))));
    assert_eq!(
        tools.frozen.lock().unwrap()[0].resource_activations,
        vec![activation.clone()]
    );
    let origin = ToolOrigin::ModelStep {
        request_id: requests[0].view.request_id.clone(),
    };
    drop(requests);
    let mut db = catalog.lock().unwrap();
    assert!(
        db.capture_resource_snapshot(
            &receipt.run_id,
            &origin,
            "original-skill",
            &original.id,
            Some("forged-id")
        )
        .is_err()
    );
    let fork = db
        .prepare_branch_fork("main", "fork-explicit", Some(&receipt.input_id), None)
        .unwrap()
        .load()
        .unwrap();
    db.admit_branch_fork(fork).unwrap();
    let fork_input = db
        .prepare_submission(command(&db, "fork-input", "fork-explicit"), None, None)
        .unwrap()
        .load(Some(launch(None)), true)
        .unwrap();
    let fork_receipt = db.admit_submission(fork_input).unwrap();
    assert_eq!(
        varin_runtime::catalog::resources::retained_activations(
            &projection(&db, &fork_receipt).history
        ),
        vec![activation.clone()]
    );
    drop(db);
    drop(engine);
    drop(tools);
    drop(catalog);
    let mut db = f.open();
    assert_eq!(
        varin_runtime::catalog::resources::retained_activations(
            &projection(&db, &fork_receipt).history
        ),
        vec![activation.clone()]
    );
    let boundary = db
        .policy_boundary(&fork_receipt.run_id, db.epoch())
        .unwrap();
    let action_id = format!("{}:policy:{}", fork_receipt.run_id, boundary.id);
    let origin = ToolOrigin::PolicyAction {
        action_id: action_id.clone(),
        node_id: "inherited-skill".into(),
    };
    let intent = PolicyGraphIntent::PolicyToolGraphV1 {
        dispatch_history: None,
        action_id: action_id.clone(),
        boundary: boundary.clone(),
        identity: PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        },
        state: Value::Null,
        nodes: vec![PolicyAdmittedNode {
            node: PolicyToolNode {
                id: "inherited-skill".into(),
                depends_on: vec![],
                call: ToolCall {
                    call_id: "inherited-skill".into(),
                    name: "resource_read".into(),
                    schema_version: "3".into(),
                    arguments: json!({"kind":"skill-resource","resourceId":"skill","relativePath":"support.txt","activationId":activation.activation_id}),
                },
            },
            context: FrozenToolContext { tool_output_visible_bytes: None, execution_environment: None, direct_tools: None,
                child_dispatch: None,
                resource_activations: vec![activation.clone()],
                resource_checkpoint_id: boundary.resource_checkpoint_id.clone(),
                run_id: fork_receipt.run_id.clone(),
                origin: origin.clone(),
                tool_schema_generation: 1,
                tools: Arc::new(vec![schema()]),
                source: None,
            },
        }],
    };
    let mut forged = intent.clone();
    let PolicyGraphIntent::PolicyToolGraphV1 { nodes, .. } = &mut forged;
    nodes[0].context.resource_activations[0].input_revision += 1;
    assert!(
        db.admit_policy_graph(&fork_receipt.run_id, db.epoch(), &forged)
            .is_err()
    );
    db.admit_policy_graph(&fork_receipt.run_id, db.epoch(), &intent)
        .unwrap();
    assert_eq!(
        db.capture_resource_snapshot(
            &fork_receipt.run_id,
            &origin,
            "inherited-skill",
            &original.id,
            Some(&activation.activation_id)
        )
        .unwrap()
        .load()
        .unwrap(),
        original.resources.unwrap()
    );
    assert!(
        db.capture_resource_snapshot(
            &fork_receipt.run_id,
            &origin,
            "inherited-skill",
            boundary.resource_checkpoint_id.as_deref().unwrap(),
            Some(&activation.activation_id)
        )
        .unwrap()
        .load()
        .is_err()
    );
    assert!(
        db.capture_resource_snapshot(
            &fork_receipt.run_id,
            &origin,
            "inherited-skill",
            &original.id,
            Some("forged-id")
        )
        .unwrap()
        .load()
        .is_err()
    );
    assert!(
        db.capture_resource_snapshot(
            &fork_receipt.run_id,
            &origin,
            "inherited-skill",
            &original.id,
            None
        )
        .unwrap()
        .load()
        .is_err()
    );
    db.request_cancel_operation(&action_id).unwrap();
    assert!(
        db.capture_resource_snapshot(
            &fork_receipt.run_id,
            &origin,
            "inherited-skill",
            &original.id,
            Some(&activation.activation_id)
        )
        .is_err()
    );
}

#[test]
fn queued_skill_admission_edit_cancel_delivery_and_retry_keep_one_revision_authority() {
    use varin_runtime::catalog::inputs::EnqueueInput;
    use varin_runtime::{InputMode, InputState};
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let owner = admit(&mut db, "owner", "queue A", None);
    let original = db.active_context("main").unwrap().unwrap();
    let make = |key: &str, mode| EnqueueInput {
        key: key.into(),
        thread_id: "thread".into(),
        branch_id: "main".into(),
        mode,
        input: json!({"text":"/skill:skill argument","attachments":[{"media_type":"image/png","data_base64":"Zmlyc3QtaW1hZ2U="}]}),
        configuration: None,
    };
    let commands = vec![
        make("boundary", InputMode::Boundary),
        make("interrupt", InputMode::Interrupt),
        make("next", InputMode::NextRun),
    ];
    let receipts = commands
        .iter()
        .map(|command| {
            let prepared = db
                .prepare_enqueue(command.clone())
                .unwrap()
                .with_input_preparation(Some(explicit_preparation(&original, "argument")))
                .load()
                .unwrap();
            let concurrent = db
                .prepare_enqueue(command.clone())
                .unwrap()
                .with_input_preparation(Some(explicit_preparation(&original, "argument")))
                .load()
                .unwrap();
            let first = db.admit_queued_input(prepared).unwrap();
            assert!(first.accepted);
            let duplicate = db.admit_queued_input(concurrent).unwrap();
            assert!(!duplicate.accepted);
            assert_eq!(first.receipt, duplicate.receipt);
            first.receipt
        })
        .collect::<Vec<_>>();
    let stale_command = make("stale-enqueue", InputMode::NextRun);
    let stale = db
        .prepare_enqueue(stale_command.clone())
        .unwrap()
        .with_input_preparation(Some(explicit_preparation(&original, "argument")))
        .load()
        .unwrap();
    let current = refresh(&mut db, "queue B");
    assert!(db.admit_queued_input(stale).is_err());
    assert!(
        db.prepare_enqueue(stale_command)
            .unwrap()
            .existing_receipt()
            .unwrap()
            .is_none()
    );
    let mut invalid = explicit_preparation(&current, "wrong arguments");
    invalid.skill.as_mut().unwrap().resource_id = "removed-resource".into();
    let duplicate = db
        .prepare_enqueue(commands[0].clone())
        .unwrap()
        .with_input_preparation(Some(invalid));
    assert_eq!(
        duplicate.existing_receipt().unwrap(),
        Some(receipts[0].clone())
    );
    let retry = db.admit_queued_input(duplicate.load().unwrap()).unwrap();
    assert!(!retry.accepted);
    assert_eq!(retry.receipt, receipts[0]);
    let mut different = commands[0].clone();
    different.mode = InputMode::NextRun;
    assert!(
        db.prepare_enqueue(different)
            .unwrap()
            .existing_receipt()
            .is_err()
    );
    let edited = db
        .prepare_input_edit(
            &receipts[0].input_id,
            1,
            json!({"text":"/skill:skill argument",
        "attachments":[{"media_type":"image/png","data_base64":"cmVwbGFjZW1lbnQtaW1hZ2U="}]}),
        )
        .unwrap()
        .load()
        .unwrap();
    let edited = db.admit_input_edit(edited).unwrap().load().unwrap();
    assert_eq!(edited.revision, 2);
    assert_eq!(edited.content["skillInvocations"][0]["body"], "queue A");
    assert_eq!(edited.content["skillInvocations"][0]["contentRevision"], 2);
    let changed = db
        .prepare_input_edit(
            &receipts[1].input_id,
            1,
            json!({"text":"/skill:skill changed"}),
        )
        .unwrap()
        .with_input_preparation(Some(explicit_preparation(&current, "changed")))
        .load()
        .unwrap();
    let changed = db.admit_input_edit(changed).unwrap().load().unwrap();
    assert_eq!(changed.content["skillInvocations"][0]["body"], "queue B");
    let plain = db
        .prepare_input_edit(
            &receipts[1].input_id,
            changed.revision,
            json!({"text":"ordinary text"}),
        )
        .unwrap()
        .load()
        .unwrap();
    let plain = db.admit_input_edit(plain).unwrap().load().unwrap();
    assert!(plain.content.get("skillInvocations").is_none());
    assert!(
        db.prepare_input_edit(
            &receipts[1].input_id,
            plain.revision,
            json!({"text":"/skill:missing"})
        )
        .unwrap()
        .with_input_preparation(Some(explicit_preparation(&current, "")))
        .load()
        .is_err()
    );
    assert_eq!(
        db.capture_queued_input(&receipts[1].input_id)
            .unwrap()
            .load()
            .unwrap()
            .content,
        plain.content
    );
    let restored = db
        .prepare_input_edit(
            &receipts[1].input_id,
            plain.revision,
            json!({"text":"/skill:skill restored"}),
        )
        .unwrap()
        .with_input_preparation(Some(explicit_preparation(&current, "restored")))
        .load()
        .unwrap();
    db.admit_input_edit(restored).unwrap();
    let cancel_command = make("cancel-next", InputMode::NextRun);
    let prepared = db
        .prepare_enqueue(cancel_command)
        .unwrap()
        .with_input_preparation(Some(explicit_preparation(&current, "argument")))
        .load()
        .unwrap();
    let cancelled = db.admit_queued_input(prepared).unwrap().receipt;
    let late = db
        .prepare_input_edit(&cancelled.input_id, 1, json!({"text":"/skill:skill late"}))
        .unwrap()
        .with_input_preparation(Some(explicit_preparation(&current, "late")))
        .load()
        .unwrap();
    assert_eq!(
        db.cancel_input(&cancelled.input_id, 1)
            .unwrap()
            .load()
            .unwrap()
            .state,
        InputState::Cancelled
    );
    assert!(db.admit_input_edit(late).is_err());
    let late = db
        .prepare_input_edit(
            &receipts[0].input_id,
            2,
            json!({"text":"/skill:skill late"}),
        )
        .unwrap()
        .with_input_preparation(Some(explicit_preparation(&current, "late")))
        .load()
        .unwrap();
    let delivery = db
        .prepare_input_delivery(
            &owner.run_id,
            db.epoch(),
            db.head("main").unwrap().as_deref(),
        )
        .unwrap()
        .load()
        .unwrap();
    let delivered = db.admit_input_delivery(delivery).unwrap().unwrap();
    assert!(db.admit_input_edit(late).is_err());
    let bindings = varin_runtime::catalog::resources::retained_activations(&delivered.items);
    assert_eq!(bindings.len(), 2);
    assert_eq!(bindings[0].resource_checkpoint_id, original.id);
    assert_eq!(bindings[0].input_revision, 2);
    assert_eq!(bindings[1].resource_checkpoint_id, current.id);
    assert!(delivered.items.iter().any(|item| matches!(&item.content,Content::Media{media} if media.data_base64=="cmVwbGFjZW1lbnQtaW1hZ2U=")));
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    finish(&mut db, &owner);
    let next = db
        .capture_queued_input(&receipts[2].input_id)
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(next.state, InputState::Delivered);
    assert_eq!(next.content["skillInvocations"][0]["body"], "queue A");
    assert_eq!(next.content["text"], "/skill:skill argument");
    assert_eq!(
        db.capture_queued_input(&cancelled.input_id)
            .unwrap()
            .load()
            .unwrap()
            .state,
        InputState::Cancelled
    );
    drop(db);
    let db = f.open();
    let recovered = db.execution_history("main").unwrap();
    assert!(recovered.iter().any(|item| {
        item.resource_activation.as_ref().is_some_and(|binding| {
            binding.input_id == receipts[2].input_id
                && binding.resource_checkpoint_id == original.id
        })
    }));
    assert!(!recovered.iter().any(|item| {
        item.resource_activation
            .as_ref()
            .is_some_and(|binding| binding.input_id == cancelled.input_id)
    }));
}

#[test]
fn cold_calendar_skill_keeps_real_environment_proof_through_compaction_gc_and_resource_read() {
    use varin_runtime::catalog::calendar::*;
    let f = Fixture::new();
    let mut db = f.open();
    let input = DefinitionInput {
        task_id: "skill-task".into(),
        asset_revision: "asset:1".into(),
        asset_kind: AssetKind::Gui,
        name: "Skill task".into(),
        enabled: true,
        activation_hold: None,
        once_acceptance: None,
        timezone: "UTC".into(),
        rule: Rule::Once {
            date: "2026-10-10".into(),
            time: "09:00".into(),
        },
        missed_policy: MissedPolicy::CoalesceOnce,
        target: Target::NewWork {
            model: ModelSelection {
                provider_id: "fixture".into(),
                model_id: "model".into(),
                thinking_level: None,
                temperature: None,
            },
            source: varin_runtime::catalog::calendar::Source::Project,
            source_mode: varin_runtime::SourceMode::FixedBranch,
            goal: None,
        },
        instruction: "/skill:skill exact retained arguments".into(),
    };
    let prepared = db
        .prepare_calendar_sync("project".into(), None, vec![input])
        .unwrap()
        .load()
        .unwrap();
    let definition = db
        .admit_calendar_sync(prepared)
        .unwrap()
        .definitions
        .remove(0);
    let occurrence = db
        .run_calendar_now(&definition.id, definition.revision, "skill-once")
        .unwrap();
    let source = source("fixed_branch", "fixed-calendar");
    let mut selected = resources("calendar original skill", Some(source.clone()));
    selected.snapshot.scope.thread_id = occurrence.thread_id.clone();
    selected.snapshot.scope.branch_id = occurrence.branch_id.clone();
    selected.snapshot.skills[0].disable_model_invocation = true;
    let mut initial = proposal("calendar main");
    initial.branch_id = occurrence.branch_id.clone();
    initial.key = format!("initial:{}", occurrence.branch_id);
    let mut personalization = basis("calendar main");
    personalization.thread_id = occurrence.thread_id.clone();
    let candidate = ContextCheckpoint {
        retained: None,
        bot_memory_snapshot: None,
        resource_activations: vec![],
        id: "candidate".into(),
        revision: 1,
        proposal: initial.clone(),
        personalization: Some(personalization.clone()),
        resources: Some(selected.clone()),
    };
    let mut skill = explicit_preparation(&candidate, "exact retained arguments");
    skill.expected_context_checkpoint = None;
    let prepared=db.prepare_calendar_submission(&occurrence.id,occurrence.revision,db.epoch(),json!({"providerId":"fixture","providerFamily":"fixture","model":"model","endpoint":"https://fixture.invalid","allowAnonymous":true,"configurationGeneration":1}),initial.clone(),personalization,Some(selected),Some(skill)).unwrap().load(launch(Some(source.clone()))).unwrap();
    let delivered = db.admit_calendar_submission(prepared).unwrap();
    let run = delivered.run_id.unwrap();
    let head = db.head(&occurrence.branch_id).unwrap().unwrap();
    let original = db.active_context(&occurrence.branch_id).unwrap().unwrap();
    let history = db.execution_history(&occurrence.branch_id).unwrap();
    assert!(
        history
            .iter()
            .all(|item| !matches!(item.provenance, Provenance::UserInstruction { .. }))
    );
    let activation = varin_runtime::catalog::resources::retained_activations(&history).remove(0);
    assert!(matches!(
        history
            .iter()
            .find(|i| i.resource_activation.is_some())
            .unwrap()
            .provenance,
        Provenance::ExternalData { .. }
    ));
    initial.key = "calendar-summary".into();
    initial.expected_revision = original.revision;
    initial.through_id = Some(head);
    initial.summary = "Retain calendar task and selected skill".into();
    let compacted = db.publish_context(initial).unwrap();
    assert_eq!(compacted.resource_activations, vec![activation.clone()]);
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    let boundary = db.policy_boundary(&run, db.epoch()).unwrap();
    let action_id = format!("{}:policy:{}", run, boundary.id);
    let origin = ToolOrigin::PolicyAction {
        action_id: action_id.clone(),
        node_id: "calendar-resource".into(),
    };
    let intent = PolicyGraphIntent::PolicyToolGraphV1 {
        dispatch_history: None,
        action_id: action_id.clone(),
        boundary: boundary.clone(),
        identity: PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        },
        state: Value::Null,
        nodes: vec![PolicyAdmittedNode {
            node: PolicyToolNode {
                id: "calendar-resource".into(),
                depends_on: vec![],
                call: ToolCall {
                    call_id: "calendar-resource".into(),
                    name: "resource_read".into(),
                    schema_version: "3".into(),
                    arguments: json!({"kind":"skill-resource","resourceId":"skill","relativePath":"support.txt","activationId":activation.activation_id}),
                },
            },
            context: FrozenToolContext { tool_output_visible_bytes: None, execution_environment: None, direct_tools: None,
                child_dispatch: None,
                resource_activations: vec![activation.clone()],
                resource_checkpoint_id: boundary.resource_checkpoint_id.clone(),
                run_id: run.clone(),
                origin: origin.clone(),
                tool_schema_generation: 1,
                tools: Arc::new(vec![schema()]),
                source: Some(source),
            },
        }],
    };
    db.admit_policy_graph(&run, db.epoch(), &intent).unwrap();
    let captured = db
        .capture_resource_snapshot(
            &run,
            &origin,
            "calendar-resource",
            &original.id,
            Some(&activation.activation_id),
        )
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(
        captured.snapshot.captured_files[0].content,
        "calendar original skill"
    );
    assert!(
        db.capture_resource_snapshot(
            &run,
            &origin,
            "calendar-resource",
            &original.id,
            Some("forged-activation")
        )
        .unwrap()
        .load()
        .is_err()
    );
    drop(db);
    let db = f.open();
    assert_eq!(
        db.calendar_occurrence(&occurrence.id).unwrap().goal_id,
        None
    );
    let projected = db
        .prepare_context_read(
            &run,
            db.epoch(),
            db.head(&occurrence.branch_id).unwrap().as_deref(),
        )
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(
        varin_runtime::catalog::resources::retained_activations(&projected.history),
        vec![activation]
    );
}

#[test]
fn selected_skill_ranges_bind_multiple_same_named_resources_and_survive_replay_and_edits() {
    use varin_runtime::catalog::{inputs::EnqueueInput, resources::{CapturedResource, InputResourcePreparation, PreparedExplicitSkill}};
    use varin_runtime::InputMode;
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let mut selected = resources("first selected body", None);
    let mut other = selected.snapshot.skills[0].clone();
    other.id = "other-resource".into();
    other.reference.path = "other/SKILL.md".into();
    other.reference.canonical_id = "resource-domain/other/SKILL.md".into();
    other.reference.version = "other-v1".into();
    other.base_path = "other".into();
    other.base_canonical_id = "resource-domain/other".into();
    selected.snapshot.captured_files.push(CapturedResource { reference: other.reference.clone(), content: "second selected body".into() });
    selected.snapshot.skills.push(other);
    let text = "🦊 before /skill:skill between /skill:skill after /skill:skill";
    let ranges: Vec<_> = text.match_indices("/skill:skill").map(|(offset, token)| {
        let start = text[..offset].encode_utf16().count();
        (start, start + token.encode_utf16().count())
    }).collect();
    let selector = |index: usize, resource: usize| json!({"resourceId":selected.snapshot.skills[resource].id,
        "version":selected.snapshot.skills[resource].reference.version,"start":ranges[index].0,"end":ranges[index].1});
    // Selectors may arrive out of order, but activations follow text order. The third
    // occurrence retains its intent without loading the same effective skill twice.
    let raw = json!({"text":text,"skills":[selector(2, 0),selector(0, 0),selector(1, 1)]});
    let prepared_skills: Vec<_> = selected.snapshot.skills.iter().enumerate().map(|(index, descriptor)| PreparedExplicitSkill {
            selection: None,
        snapshot_id: selected.snapshot.id.clone(), resource_id: descriptor.id.clone(), reference: descriptor.reference.clone(),
        name: descriptor.name.clone(), arguments: String::new(), body: selected.snapshot.captured_files[index].content.clone(),
    }).collect();
    let preparation = InputResourcePreparation { expected_context_checkpoint: None, skill: None, skills: prepared_skills.clone() };
    let mut input = command(&db, "multiple-selected", "main");
    input.input = raw.clone();
    let mut invalid = preparation.clone();
    invalid.skills[1].resource_id = invalid.skills[0].resource_id.clone();
    assert!(db.prepare_submission(input.clone(), Some(proposal("first selected body")), Some(basis("first selected body"))).unwrap()
        .with_resources(Some(selected.clone())).with_input_preparation(Some(invalid)).load(Some(launch(None)), false).is_err());
    let mut reversed = preparation.clone();
    reversed.skills.reverse();
    assert!(db.prepare_submission(input.clone(), Some(proposal("first selected body")), Some(basis("first selected body"))).unwrap()
        .with_resources(Some(selected.clone())).with_input_preparation(Some(reversed)).load(Some(launch(None)), false).is_err());
    let prepared = db.prepare_submission(input.clone(), Some(proposal("first selected body")), Some(basis("first selected body"))).unwrap()
        .with_resources(Some(selected)).with_input_preparation(Some(preparation.clone())).load(Some(launch(None)), false).unwrap();
    let receipt = db.admit_submission(prepared).unwrap();
    let checkpoint = db.active_context("main").unwrap().unwrap();
    let record = db.history("main").unwrap().into_iter().find(|item| item.id == receipt.input_id).unwrap();
    assert_eq!(record.content["text"], raw["text"]);
    assert_eq!(record.content["skills"], raw["skills"]);
    let invocations = record.content["skillInvocations"].as_array().unwrap();
    assert_eq!(invocations.len(), 2);
    assert_eq!(invocations[0]["resourceId"], "skill");
    assert_eq!(invocations[1]["resourceId"], "other-resource");
    assert_eq!(invocations[1]["ordinal"], 1);
    let activations = varin_runtime::catalog::resources::retained_activations(&db.execution_history("main").unwrap());
    assert_eq!(activations.len(), 2);
    assert_eq!(activations[1].resource_id, "other-resource");

    let queue = EnqueueInput { key: "selected-queue".into(), thread_id: "thread".into(), branch_id: "main".into(),
        mode: InputMode::Boundary, input: raw.clone(), configuration: None };
    let mut preparation = preparation;
    preparation.expected_context_checkpoint = Some(checkpoint.id.clone());
    let queued = db.prepare_enqueue(queue.clone()).unwrap().with_input_preparation(Some(preparation.clone())).load().unwrap();
    let queued = db.admit_queued_input(queued).unwrap().receipt;
    let mut changed = raw.clone();
    changed["skills"] = json!([raw["skills"][2].clone()]);
    assert!(db.prepare_input_edit(&queued.input_id, 1, changed.clone()).unwrap().load().is_err());
    preparation.skills = vec![prepared_skills[1].clone()];
    let edited = db.prepare_input_edit(&queued.input_id, 1, changed.clone()).unwrap()
        .with_input_preparation(Some(preparation)).load().unwrap();
    let edited = db.admit_input_edit(edited).unwrap().load().unwrap();
    assert_eq!(edited.content["skillInvocations"].as_array().unwrap().len(), 1);
    assert_eq!(edited.content["skillInvocations"][0]["resourceId"], "other-resource");
    assert_eq!(edited.content["skillInvocations"][0]["contentRevision"], 2);
    let mut different = queue.clone();
    different.input = changed;
    assert!(db.prepare_enqueue(different).unwrap().existing_receipt().is_err());
    assert_eq!(db.prepare_enqueue(queue).unwrap().existing_receipt().unwrap().unwrap(), queued);
    db.cancel_input(&queued.input_id, edited.revision).unwrap();
    finish(&mut db, &receipt);
    refresh(&mut db, "later resources");
    let retry = db.prepare_submission(input.clone(), None, None).unwrap().load(Some(launch(None)), false).unwrap();
    assert_eq!(db.admit_submission(retry).unwrap(), receipt);
    input.input["skills"][0]["version"] = json!("changed-version");
    assert!(db.prepare_submission(input, None, None).unwrap().existing_receipt(&Some(launch(None)), false).is_err());
    content_collection::collect(|| db.prepare_content_collection(Default::default())).unwrap();
    drop(db);
    let db = f.open();
    let activations = varin_runtime::catalog::resources::retained_activations(&db.execution_history("main").unwrap());
    assert_eq!(activations.len(), 2);
    assert_eq!(activations[0].reference.version, "version-first selected body");
    assert_eq!(activations[1].reference.version, "other-v1");
}

#[test]
fn augmented_input_keeps_legacy_skill_arguments_bound_to_original_user_text() {
    use varin_runtime::catalog::inputs::EnqueueInput;
    use varin_runtime::InputMode;
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let owner = admit(&mut db, "augmentation-owner", "frozen skill body", None);
    let original = db.active_context("main").unwrap().unwrap();
    let input = json!({"text":"/skill:skill exact args @notes\n\nAttached object context", "userText":"/skill:skill exact args @notes","references":[{"kind":"directory","path":"notes","start":24,"end":30}]});
    let command = EnqueueInput { key: "augmented-skill".into(), thread_id: "thread".into(), branch_id: "main".into(),
        mode: InputMode::Boundary, input: input.clone(), configuration: None };
    let prepared = db.prepare_enqueue(command.clone()).unwrap().with_input_preparation(Some(explicit_preparation(&original, "exact args @notes"))).load().unwrap();
    let receipt = db.admit_queued_input(prepared).unwrap().receipt;
    let queued = db.capture_queued_input(&receipt.input_id).unwrap().load().unwrap();
    let mut forged_retry = command.clone();
    forged_retry.input["userText"] = json!("/skill:unrelated");
    assert!(db.prepare_enqueue(forged_retry).unwrap().existing_receipt().is_err());
    let mut legacy_retry = command.clone();
    legacy_retry.input.as_object_mut().unwrap().remove("userText");
    assert_eq!(db.prepare_enqueue(legacy_retry).unwrap().existing_receipt().unwrap().unwrap(), receipt);
    let mut changed_reference = command.clone();
    changed_reference.input["references"][0]["path"] = json!("another-directory");
    assert!(db.prepare_enqueue(changed_reference).unwrap().existing_receipt().is_err());
    let mut different = command;
    different.input["skills"] = json!([{"resourceId":"skill","version":"version-frozen skill body","start":0,"end":12}]);
    assert!(db.prepare_enqueue(different).unwrap().existing_receipt().is_err());
    assert_eq!(queued.content["text"], input["text"]);
    assert_eq!(queued.content["userText"], input["userText"]);
    assert_eq!(queued.content["references"], input["references"]);
    assert_eq!(queued.content["skillInvocations"][0]["arguments"], "exact args @notes");
    let mut changed = input;
    changed["userText"] = json!("/skill:skill changed args");
    assert!(db.prepare_input_edit(&receipt.input_id, 1, changed).unwrap().load().is_err());
    db.cancel_input(&receipt.input_id, 1).unwrap();
    finish(&mut db, &owner);
}

#[test]
fn object_reference_retry_uses_raw_intent_without_rebuilding_accepted_context() {
    use varin_runtime::catalog::inputs::EnqueueInput;
    use varin_runtime::InputMode;
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let owner = admit(&mut db, "reference-intent-owner", "selected reference skill", None);
    let checkpoint = db.active_context("main").unwrap().unwrap();
    let text = "/skill:skill inspect @notes";
    let raw = json!({"text":text,
        "references":[{"kind":"directory","path":"notes","start":21,"end":27}],
        "skills":[{"resourceId":"skill","version":"version-selected reference skill","start":0,"end":12}],
        "referenceIntent":{"text":text,"materials":[{"snapshotId":"original-document"}]},
        "attachments":[{"media_type":"image/png","data_base64":"b3JpZ2luYWwtaW1hZ2U="}]});
    let mut prepared_input = raw.clone();
    prepared_input["userText"] = json!(text);
    prepared_input["text"] = json!(format!("{text}\n\nOriginal directory locator and retained original-document description"));
    let command = EnqueueInput { key: "reference-intent".into(), thread_id: "thread".into(), branch_id: "main".into(),
        mode: InputMode::Boundary, input: prepared_input.clone(), configuration: None };
    let preparation = explicit_preparation(&checkpoint, "");
    let prepared = db.prepare_enqueue(command.clone()).unwrap().with_input_preparation(Some(preparation)).load().unwrap();
    let receipt = db.admit_queued_input(prepared).unwrap().receipt;
    let mut retry = command.clone();
    retry.input = raw.clone();
    // Refresh removes the original resource version. Receipt lookup must not prepare again.
    refresh(&mut db, "later reference resources");
    let captured = db.prepare_enqueue(retry.clone()).unwrap();
    assert_eq!(captured.existing_receipt().unwrap(), Some(receipt.clone()));
    let replay = db.admit_queued_input(captured.load().unwrap()).unwrap();
    assert!(!replay.accepted);
    assert_eq!(replay.receipt, receipt);
    let stored = db.capture_queued_input(&receipt.input_id).unwrap().load().unwrap();
    assert_eq!(stored.content["text"], prepared_input["text"]);
    assert_eq!(stored.content["referenceIntent"], raw["referenceIntent"]);
    assert_eq!(stored.content["skillInvocations"][0]["body"], "selected reference skill");
    let media: varin_runtime::output::StoredMedia = serde_json::from_value(stored.content["attachments"][0].clone()).unwrap();
    let read = varin_runtime::output::MediaReadParams { thread_id: "thread".into(), branch_id: "main".into(),
        holder: varin_runtime::output::OutputMediaHolder::Input { input_id: receipt.input_id.clone(), expected_revision: stored.revision },
        part_index: 0, chunk_index: 0, expected_content_ref: media.content_ref.content_object };
    assert_eq!(db.capture_media_read(&read).unwrap().chunk(&|| false).unwrap().bytes_base64,
        raw["attachments"][0]["data_base64"].as_str().unwrap());

    for pointer in ["/references/0/path", "/referenceIntent/materials/0/snapshotId", "/skills/0/version", "/attachments/0/data_base64"] {
        let mut different = retry.clone();
        *different.input.pointer_mut(pointer).unwrap() = json!("Y2hhbmdlZA==");
        assert!(db.prepare_enqueue(different).unwrap().existing_receipt().is_err(), "changed {pointer} must conflict");
    }
    let mut different_text = retry.clone();
    different_text.input["text"] = json!(format!("{text}!"));
    different_text.input["referenceIntent"]["text"] = different_text.input["text"].clone();
    assert!(db.prepare_enqueue(different_text).unwrap().existing_receipt().is_err());
    for invalid_marker in [
        json!({"text":"unrelated"}),
        json!({"text":text,"materials":null}),
        json!({"text":text,"materials":[{"snapshotId":" "}]}),
        json!({"text":text,"materials":[{"snapshotId":"original-document","grant":"read"}]}),
        json!({"text":text,"extra":true}),
    ] {
        let mut invalid = retry.clone();
        invalid.input["referenceIntent"] = invalid_marker;
        assert!(db.prepare_enqueue(invalid).unwrap().existing_receipt().is_err());
    }
    let mut missing_references = retry;
    missing_references.input["references"] = json!([]);
    assert!(db.prepare_enqueue(missing_references).unwrap().existing_receipt().is_err());
    // Historical, unmarked input still treats the entire submitted text as intent.
    let unmarked = EnqueueInput { key: "unmarked-reference-intent".into(), input: json!({"text":"original locator text"}), ..command };
    let prepared = db.prepare_enqueue(unmarked.clone()).unwrap().load().unwrap();
    let unmarked_receipt = db.admit_queued_input(prepared).unwrap().receipt;
    let mut changed = unmarked;
    changed.input["text"] = json!("changed locator text");
    assert!(db.prepare_enqueue(changed).unwrap().existing_receipt().is_err());
    db.cancel_input(&receipt.input_id, 1).unwrap();
    db.cancel_input(&unmarked_receipt.input_id, 1).unwrap();
    finish(&mut db, &owner);
}

#[test]
fn pending_skill_locator_binds_exact_frozen_descriptor_and_retries_without_current_resource() {
    use sha2::{Digest, Sha256};
    use varin_runtime::catalog::{inputs::EnqueueInput, launches::SourceResourceOwner, resources::ExplicitSkillSelectionIdentity};
    use varin_runtime::InputMode;
    let locator_id = |locator: &Value| {
        let owner: SourceResourceOwner = serde_json::from_value(locator["resourceOwner"].clone()).unwrap();
        let tuple = (&owner, locator["workspaceId"].as_str().unwrap(), locator["domainId"].as_str().unwrap(), locator["path"].as_str().unwrap());
        format!("draft-skill:{}", hex::encode(Sha256::digest(serde_json::to_vec(&tuple).unwrap())))
    };
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let captured = "\u{feff}---\nname: skill\n---\nOriginal selected body";
    let owner = admit(&mut db, "pending-skill-owner", captured, Some(source("fixed_branch", "pending-source")));
    let checkpoint = db.active_context("main").unwrap().unwrap();
    let locator = json!({"resourceOwner":{"kind":"local"},"workspaceId":"workspace","domainId":"resource-domain","path":"skill/SKILL.md"});
    let draft_id = locator_id(&locator);
    let version = hex::encode(Sha256::digest(captured.strip_prefix('\u{feff}').unwrap().as_bytes()));
    let selector = |start, end| json!({"resourceId":draft_id,"version":version,"start":start,"end":end,"locator":locator});
    let raw = json!({"text":"Use /skill:skill /skill:skill","skills":[selector(4,16),selector(17,29)]});
    let mut preparation = explicit_preparation(&checkpoint, "");
    let skill = preparation.skill.as_mut().unwrap();
    skill.body = "Original selected body".into();
    skill.selection = Some(ExplicitSkillSelectionIdentity { resource_id: draft_id.clone(), version: version.clone() });
    let command = EnqueueInput { key: "pending-skill".into(), thread_id: "thread".into(), branch_id: "main".into(),
        mode: InputMode::Boundary, input: raw.clone(), configuration: None };

    // The Host's resolved selection cannot substitute a different workspace, owner,
    // domain, path or captured version even when its raw locator identity is recomputed.
    for (field, value) in [
        ("workspaceId", json!("other-workspace")), ("domainId", json!("other-domain")),
        ("path", json!("other/SKILL.md")),
        ("resourceOwner", json!({"kind":"managed_host","hostId":"remote","connectionId":"connection","endpointIdentity":"endpoint"})),
    ] {
        let mut different = command.clone();
        let mut changed_locator = locator.clone();
        changed_locator[field] = value;
        let changed_id = locator_id(&changed_locator);
        for selection in different.input["skills"].as_array_mut().unwrap() {
            selection["locator"] = changed_locator.clone();
            selection["resourceId"] = json!(changed_id);
        }
        let mut changed_preparation = preparation.clone();
        changed_preparation.skill.as_mut().unwrap().selection.as_mut().unwrap().resource_id = changed_id;
        assert!(db.prepare_enqueue(different).unwrap().with_input_preparation(Some(changed_preparation)).load().is_err(), "{field} must match frozen source");
    }
    let mut wrong_version = command.clone();
    for selection in wrong_version.input["skills"].as_array_mut().unwrap() { selection["version"] = json!("changed-version"); }
    let mut changed_preparation = preparation.clone();
    changed_preparation.skill.as_mut().unwrap().selection.as_mut().unwrap().version = "changed-version".into();
    assert!(db.prepare_enqueue(wrong_version).unwrap().with_input_preparation(Some(changed_preparation)).load().is_err());
    let mut aliases = command.clone();
    let mut direct = preparation.skill.as_ref().unwrap().clone();
    direct.selection = None;
    aliases.input["skills"][1] = json!({"resourceId":direct.resource_id,"version":direct.reference.version,"start":17,"end":29});
    let mut alias_preparation = preparation.clone();
    alias_preparation.skills = vec![alias_preparation.skill.take().unwrap(), direct];
    assert!(db.prepare_enqueue(aliases).unwrap().with_input_preparation(Some(alias_preparation)).load().is_err());

    let prepared = db.prepare_enqueue(command.clone()).unwrap().with_input_preparation(Some(preparation)).load().unwrap();
    let receipt = db.admit_queued_input(prepared).unwrap().receipt;
    let stored = db.capture_queued_input(&receipt.input_id).unwrap().load().unwrap();
    assert_eq!(stored.content["skillInvocations"].as_array().unwrap().len(), 1);
    assert_eq!(stored.content["skillInvocations"][0]["resourceId"], "skill");
    assert_eq!(stored.content["skillInvocations"][0]["selection"]["resourceId"], draft_id);
    assert_eq!(stored.content["skills"], raw["skills"]);
    let mut unavailable = checkpoint.resources.as_ref().unwrap().clone();
    unavailable.snapshot.id = "currently-unavailable".into();
    unavailable.snapshot.skills.clear();
    unavailable.snapshot.captured_files.clear();
    let refresh = db.prepare_resource_refresh("main", checkpoint.revision, checkpoint.proposal.effective_system_prompt.clone(),
        checkpoint.proposal.instruction_sources.clone(), checkpoint.proposal.memory_checkpoint.clone(), checkpoint.personalization.clone().unwrap(), unavailable).unwrap().load().unwrap();
    db.publish_resource_refresh(refresh).unwrap();
    let replay = db.prepare_enqueue(command.clone()).unwrap();
    assert_eq!(replay.existing_receipt().unwrap(), Some(receipt.clone()));
    assert_eq!(db.admit_queued_input(replay.load().unwrap()).unwrap().receipt, receipt);
    for pointer in ["/skills/0/locator/path", "/skills/0/version"] {
        let mut different = command.clone();
        *different.input.pointer_mut(pointer).unwrap() = json!("changed");
        assert!(db.prepare_enqueue(different).unwrap().existing_receipt().is_err());
    }
    db.cancel_input(&receipt.input_id, 1).unwrap();
    finish(&mut db, &owner);
}

#[test]
fn queued_object_reference_edits_retain_original_images_before_partial_validation() {
    use varin_runtime::catalog::inputs::EnqueueInput;
    use varin_runtime::output::{MediaReadParams, OutputMediaHolder, StoredMedia};
    use varin_runtime::InputMode;
    let f = Fixture::new();
    let mut db = f.open();
    db.create_thread("thread", "main").unwrap();
    let owner = admit(&mut db, "edit-reference-owner", "edit selected skill", None);
    let checkpoint = db.active_context("main").unwrap().unwrap();
    let text = "Read @task /skill:skill";
    let input = json!({"text":text,"references":[{"kind":"thread","threadId":"other","branchId":"branch","start":5,"end":10}],
        "referenceIntent":{"text":text,"attachmentSelections":[{"ref":"attachment:original"}],"originalImageCount":1},
        "fileAttachments":[{"ref":"attachment:original","filename":"notes.pdf","mimeType":"application/pdf","byteLength":4}],
        "attachments":[{"media_type":"image/png","data_base64":"b3JpZ2luYWw="}],"imageReferences":[3]});
    let prepared = db.prepare_enqueue(EnqueueInput { key:"reference-edit".into(),thread_id:"thread".into(),branch_id:"main".into(),
        mode:InputMode::Boundary,input:input.clone(),configuration:None }).unwrap().load().unwrap();
    let receipt = db.admit_queued_input(prepared).unwrap().receipt;
    let original = db.capture_queued_input(&receipt.input_id).unwrap().load().unwrap();
    let media: StoredMedia = serde_json::from_value(original.content["attachments"][0].clone()).unwrap();
    let mut edit = input.clone();
    for field in ["attachments","imageReferences","fileAttachments"] { edit.as_object_mut().unwrap().remove(field); }
    let prepared = db.prepare_input_edit(&receipt.input_id, original.revision, edit.clone()).unwrap().load().unwrap();
    let unchanged = db.admit_input_edit(prepared).unwrap().load().unwrap();
    assert_eq!(unchanged.content["attachments"], original.content["attachments"]);
    assert_eq!(unchanged.content["imageReferences"], original.content["imageReferences"]);
    assert_eq!(unchanged.content["fileAttachments"], original.content["fileAttachments"]);
    assert_eq!(unchanged.content["referenceIntent"], original.content["referenceIntent"]);
    edit["skills"] = json!([{"resourceId":"skill","version":"version-edit selected skill","start":11,"end":23}]);
    let prepared = db.prepare_input_edit(&receipt.input_id, unchanged.revision, edit.clone()).unwrap()
        .with_input_preparation(Some(explicit_preparation(&checkpoint, ""))).load().unwrap();
    let selected = db.admit_input_edit(prepared).unwrap().load().unwrap();
    assert_eq!(selected.content["skillInvocations"][0]["body"], "edit selected skill");
    assert_eq!(selected.content["attachments"], original.content["attachments"]);
    assert_eq!(selected.content["fileAttachments"], original.content["fileAttachments"]);
    let read = MediaReadParams { thread_id:"thread".into(),branch_id:"main".into(),
        holder:OutputMediaHolder::Input { input_id:receipt.input_id.clone(),expected_revision:selected.revision },
        part_index:0,chunk_index:0,expected_content_ref:media.content_ref.content_object.clone() };
    assert_eq!(db.capture_media_read(&read).unwrap().chunk(&|| false).unwrap().bytes_base64,"b3JpZ2luYWw=");
    let old_read = MediaReadParams { holder:OutputMediaHolder::Input { input_id:receipt.input_id.clone(),expected_revision:original.revision },..read };
    assert!(db.capture_media_read(&old_read).is_err());
    let mut forged = edit.clone();
    forged["attachments"] = original.content["attachments"].clone();
    assert!(db.prepare_input_edit(&receipt.input_id, selected.revision, forged).unwrap().load().is_err(), "stored refs cannot enter through user media");
    edit["referenceIntent"]["originalImageCount"] = json!(2);
    assert!(db.prepare_input_edit(&receipt.input_id, selected.revision, edit.clone()).unwrap().load().is_err(), "retained media count is exact");
    edit["referenceIntent"]["originalImageCount"] = json!(1);
    assert!(db.prepare_enqueue(EnqueueInput { key:"fresh-with-missing-image".into(),thread_id:"thread".into(),branch_id:"main".into(),
        mode:InputMode::Boundary,input:edit,configuration:None }).unwrap().load().is_err(), "fresh input cannot claim retained images");
    db.run(&owner.run_id).unwrap();
}
