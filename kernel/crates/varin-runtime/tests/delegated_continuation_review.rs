//! Actual Catalog/ContentStore admission, source identity, history and recovery consumers.
//! Host source capture, credentials and provider I/O are covered separately.
#[path = "fixtures/content_collection.rs"]
mod content_collection;
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
#[path = "fixtures/input_admission.rs"]
mod input_admission;
use fixture::Fixture;
use input_admission::InputAdmission;
use serde_json::{json, Value};
use varin_runtime::catalog::{
    collaboration::*, context::ContextProposal, delegated::*, dispatch::TreeCancelTarget,
    inputs::EnqueueInput, launches::SourceSelection, personalization::PersonalizationBasis,
};
use varin_runtime::execution::*;
use varin_runtime::*;
fn context(child: &ChildTask, key: &str) -> (ContextProposal, PersonalizationBasis) {
    let proposal = ContextProposal {
        key: key.into(),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Frozen worker instructions".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":1,"configurationDigest":"frozen-worker","memorySnapshot":{"revision":0,"memories":[]},"sessionId":child.child_thread_id,"projectId":child.project_id,"originalSections":[{"name":"system","content":"Frozen worker instructions"}],"instructionSources":[]})).unwrap();
    (proposal, basis)
}
fn first(f: &mut Fixture) -> ChildTask {
    let child = f.accept();
    f.settle_exchange();
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.execution_id));
    source.revision = Some(0);
    if matches!(child.code_result, ChildCodeResult::Pending) {
        source.mode = SourceMode::Materialized;
    }
    let (proposal, basis) = context(&child, "first-context");
    f.db.prepare_child(&child.execution_id, source, proposal, basis)
        .unwrap()
}
fn finish(db: &mut Catalog, child: &ChildTask, text: Option<&str>) {
    let run = &child.receipt.as_ref().unwrap().run_id;
    db.commit_execution(
        run,
        db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Runnable,
            waiting_on: None,
        },
    )
    .unwrap();
    if let Some(text) = text {
        db.append_history(
            run,
            db.epoch(),
            db.head(&child.child_branch_id).unwrap().as_deref(),
            HistorySource::Assistant,
            serde_json::to_value(ConversationItem {
                id: "answer".into(),
                provenance: Provenance::Assistant,
                content: Content::Text { text: text.into() },
                opaque: None,
                resource_activation: None,
            })
            .unwrap(),
            None,
        )
        .unwrap();
    }
    db.commit_execution(
        run,
        db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Completed,
            waiting_on: None,
        },
    )
    .unwrap();
    db.reconcile_child_reports().unwrap();
}
fn continuation_command(
    db: &Catalog,
    child: &ChildTask,
    key: &str,
    input: Value,
) -> ChildContinuationCommand {
    ChildContinuationCommand {
        key: key.into(),
        child_operation_id: child.operation_id.clone(),
        previous_run_id: child.receipt.as_ref().unwrap().run_id.clone(),
        expected_head: db.head(&child.child_branch_id).unwrap(),
        input,
    }
}
fn accept(db: &mut Catalog, command: ChildContinuationCommand) -> DelegatedExecution {
    let prepared = db
        .capture_child_continuation(command)
        .unwrap()
        .load()
        .unwrap();
    db.accept_child_continuation(prepared).unwrap()
}
fn ready_source(db: &mut Catalog, next: &DelegatedExecution) -> SourceSelection {
    let basis = next.source_basis.as_ref().unwrap();
    let mut source = basis.source().clone();
    source.branch_id = Some(format!("child-source:{}", next.execution_id));
    source.revision = Some(0);
    let mut pin_source = source.clone();
    pin_source.mode = SourceMode::FixedBranch;
    if !matches!(next.code_result, ChildCodeResult::NoChanges) {
        source.mode = SourceMode::Materialized;
    }
    let view = db
        .capture_delegated_execution(next.clone())
        .unwrap()
        .load()
        .unwrap();
    let provenance =
        serde_json::from_value(view.source_basis.unwrap()["provenance"].clone()).unwrap();
    let prepared = db
        .prepare_child_source(
            &next.execution_id,
            ChildSourcePin {
                pin_id: format!("child-source-pin:{}", next.execution_id),
                root: basis.root().into(),
                source: pin_source,
            },
            source.clone(),
            provenance,
        )
        .unwrap()
        .load()
        .unwrap();
    db.attach_child_source(prepared).unwrap();
    source
}
fn prepare(db: &mut Catalog, next: &DelegatedExecution, source: SourceSelection) -> ChildTask {
    let child = db.child_task(&next.child_operation_id).unwrap();
    let (proposal, basis) = context(&child, &format!("context:{}", next.execution_id));
    let prepared = db
        .capture_child_preparation(&next.execution_id, source, proposal, basis)
        .unwrap()
        .load()
        .unwrap();
    db.admit_child(prepared).unwrap()
}
fn result(db: &mut Catalog, child: &ChildTask, effect: Effect) -> ChildWorkingResultRef {
    db.begin_child_settlement(&child.execution_id).unwrap();
    let publication = format!("child-result:{}", child.execution_id);
    let candidate = KernelWorkingResultCandidate {
        publication_id: publication.clone(),
        candidate_operation_id: format!("result-prepare:{publication}"),
        workspace_id: "workspace-A".into(),
        branch_id: format!("child-source:{}", child.execution_id),
        root: format!("result-root:{}", child.execution_id),
        base_root: child.source.pin().unwrap().root.clone(),
        write_revision: 1,
        pin_id: "result-pin".into(),
        base_pin_id: "result-base-pin".into(),
    };
    db.attach_child_candidate(&child.execution_id, candidate.clone())
        .unwrap();
    let result = ChildWorkingResultRef {
        publication_id: publication,
        workspace_id: candidate.workspace_id,
        branch_id: candidate.branch_id,
        result_revision: 1,
        root: candidate.root,
        base_root: candidate.base_root,
        record_id: "result-record".into(),
    };
    db.attach_child_result(&child.execution_id, result.clone(), effect)
        .unwrap();
    result
}
#[test]
fn explicit_user_new_run_keeps_original_dispatch_and_never_borrows_its_report() {
    let mut f = Fixture::new();
    let initial = first(&mut f);
    finish(&mut f.db, &initial, Some("first answer"));
    f.db.mark_child_resources_released(&initial.execution_id)
        .unwrap();
    let original = f.db.child_task(&initial.operation_id).unwrap();
    let command = continuation_command(
        &f.db,
        &initial,
        "second",
        json!({"text":"continue with this image","attachments":[{"media_type":"image/png","content_ref":"image:fixed","source":"user-upload"}]}),
    );
    let next = accept(&mut f.db, command.clone());
    assert!(next.source.is_none());
    assert!(next.receipt.is_none());
    assert_eq!(accept(&mut f.db, command.clone()), next);
    let source = ready_source(&mut f.db, &next);
    let child = prepare(&mut f.db, &next, source);
    let run = &child.receipt.as_ref().unwrap().run_id;
    assert_ne!(run, &initial.receipt.as_ref().unwrap().run_id);
    assert_eq!(
        f.db.require_child_launch(run)
            .unwrap()
            .unwrap()
            .execution_id,
        next.execution_id
    );
    assert!(
        f.db.child_task(&next.execution_id).is_err(),
        "child operation endpoint keeps original dispatch identity"
    );
    let history = f.db.history(&child.child_branch_id).unwrap();
    let input = history.iter().find(|item| item.run_id == *run).unwrap();
    assert_eq!(input.source, HistorySource::User);
    assert_eq!(
        input.content["attachments"][0]["content_ref"],
        "image:fixed"
    );
    finish(&mut f.db, &child, None);
    let finished = f.db.delegated_execution(&next.execution_id).unwrap();
    assert_eq!(finished.report.as_ref().unwrap().outcome, Outcome::Failed);
    assert!(finished.report.as_ref().unwrap().history_ids.is_empty());
    assert_eq!(f.db.child_task(&initial.operation_id).unwrap(), original);
    content_collection::collect(|| f.db.prepare_content_collection(Default::default())).unwrap();
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(accept(&mut f.db, command), finished);
    assert_eq!(
        f.db.capture_delegated_execution(finished)
            .unwrap()
            .load()
            .unwrap()
            .input["text"],
        "continue with this image"
    );
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn pending_cancel_fences_late_source_but_a_new_user_intent_after_cancel_can_proceed() {
    let mut f = Fixture::new();
    let first = first(&mut f);
    finish(&mut f.db, &first, Some("done"));
    let command = continuation_command(&f.db, &first, "cancelled-intent", json!("continue"));
    let pending = accept(&mut f.db, command.clone());
    let view =
        f.db.capture_delegated_execution(pending.clone())
            .unwrap()
            .load()
            .unwrap();
    let basis = pending.source_basis.as_ref().unwrap();
    let mut source = basis.source().clone();
    source.branch_id = Some(format!("child-source:{}", pending.execution_id));
    source.revision = Some(0);
    let late =
        f.db.prepare_child_source(
            &pending.execution_id,
            ChildSourcePin {
                pin_id: format!("child-source-pin:{}", pending.execution_id),
                root: basis.root().into(),
                source: source.clone(),
            },
            source,
            serde_json::from_value(view.source_basis.unwrap()["provenance"].clone()).unwrap(),
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.cancel_tree(TreeCancelTarget::Child {
        operation_id: first.operation_id.clone(),
    })
    .unwrap();
    assert!(f.db.attach_child_source(late).is_err());
    let cancelled = accept(&mut f.db, command);
    assert_eq!(cancelled.report.unwrap().outcome, Outcome::Cancelled);
    let next = {
        let cmd = continuation_command(
            &f.db,
            &first,
            "fresh-after-cancel",
            json!("new explicit instruction"),
        );
        accept(&mut f.db, cmd)
    };
    let source = ready_source(&mut f.db, &next);
    let child = prepare(&mut f.db, &next, source);
    assert!(f
        .db
        .require_child_launch(&child.receipt.unwrap().run_id)
        .unwrap()
        .is_some());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn concurrent_preparation_is_one_execution_and_failed_pre_run_intent_does_not_block_later_input() {
    let mut f = Fixture::new();
    let first = first(&mut f);
    finish(&mut f.db, &first, Some("done"));
    let command = continuation_command(&f.db, &first, "race", json!("again"));
    let a =
        f.db.capture_child_continuation(command.clone())
            .unwrap()
            .load()
            .unwrap();
    let b =
        f.db.capture_child_continuation(command.clone())
            .unwrap()
            .load()
            .unwrap();
    let accepted = f.db.accept_child_continuation(a).unwrap();
    assert_eq!(f.db.accept_child_continuation(b).unwrap(), accepted);
    let mut changed = command.clone();
    changed.input = json!("different");
    assert!(f
        .db
        .capture_child_continuation(changed)
        .unwrap()
        .load()
        .is_err());
    let mut other = command.clone();
    other.key = "other".into();
    let blocked =
        f.db.capture_child_continuation(other.clone())
            .unwrap()
            .load()
            .unwrap();
    assert!(f.db.accept_child_continuation(blocked).is_err());
    let member = |db: &Catalog| {
        db.capture_family_read(&first.parent_thread_id, None, None)
            .unwrap()
            .list(false, &|| false)
            .unwrap()
            .members
            .into_iter()
            .find(|member| member.thread_id == first.child_thread_id)
            .unwrap()
    };
    assert_eq!(member(&f.db).state, "preparing");
    assert_eq!(member(&f.db).task, Some(f.input.task.clone()));
    f.db.fail_delegated_preparation(&accepted.execution_id, "source_unavailable")
        .unwrap();
    assert_eq!(member(&f.db).state, "failed");
    let later = accept(&mut f.db, other);
    assert_ne!(later.execution_id, accepted.execution_id);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn isolated_continuation_uses_exact_published_root_without_rewriting_unknown_effect() {
    let mut f = Fixture::new_isolated();
    let first = first(&mut f);
    finish(&mut f.db, &first, Some("written result"));
    let fixed = result(&mut f.db, &first, Effect::Unknown);
    let command = continuation_command(&f.db, &first, "next", json!("continue files"));
    let original = f.db.child_task(&first.operation_id).unwrap();
    let next = accept(&mut f.db, command);
    assert_eq!(f.db.child_task(&first.operation_id).unwrap(), original);
    let ChildSourceBasis::WorkingResult {
        source,
        root,
        result: original_result,
        ..
    } = next.source_basis.as_ref().unwrap()
    else {
        panic!("result basis required")
    };
    assert_eq!(root, &fixed.root);
    assert_eq!(source.branch_id.as_deref(), Some(fixed.branch_id.as_str()));
    assert_eq!(source.revision, Some(fixed.result_revision));
    assert_eq!(original_result, &fixed);
    let view =
        f.db.capture_delegated_execution(next.clone())
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(
        view.source_basis.as_ref().unwrap()["provenance"]["root"],
        fixed.root
    );
    let source = ready_source(&mut f.db, &next);
    let child = prepare(&mut f.db, &next, source);
    assert!(matches!(
        child.source,
        ChildSource::Ready { handoff: None, .. }
    ));
    finish(&mut f.db, &child, Some("second result"));
    let second = result(&mut f.db, &child, Effect::None);
    assert_ne!(fixed.publication_id, second.publication_id);
    assert_eq!(
        f.db.child_task(&first.operation_id).unwrap().code_result,
        ChildCodeResult::Published {
            result: fixed,
            effect: Effect::Unknown
        }
    );
    // A later cold preparation failure with proven no source effect can retain
    // its exact immutable baseline without permanently disabling this Thread.
    let command = continuation_command(&f.db, &child, "cold-attempt", json!("try explicitly"));
    let cold = accept(&mut f.db, command);
    let source = ready_source(&mut f.db, &cold);
    let cold_child = prepare(&mut f.db, &cold, source);
    let failed =
        f.db.fail_delegated_preparation(&cold.execution_id, "credentials_unavailable")
            .unwrap();
    assert!(matches!(
        failed.code_result,
        ChildCodeResult::Unavailable {
            effect: Effect::None,
            ..
        }
    ));
    let command = continuation_command(
        &f.db,
        &cold_child,
        "retry-new-intent",
        json!("new explicit attempt"),
    );
    let next = accept(&mut f.db, command);
    let ChildSourceBasis::ImmutableSource {
        root: baseline,
        pin,
        ..
    } = next.source_basis.unwrap()
    else {
        panic!("no-effect failure keeps its immutable baseline")
    };
    assert_eq!(baseline, second.root);
    assert_eq!(pin, cold_child.source.pin().unwrap().clone());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn active_user_input_uses_original_execution_but_idle_and_next_run_cannot_clone_it() {
    let mut f = Fixture::new();
    let child = first(&mut f);
    let run = child.receipt.as_ref().unwrap().run_id.clone();
    for (index, mode) in [InputMode::Boundary, InputMode::Interrupt]
        .into_iter()
        .enumerate()
    {
        let receipt =
            f.db.enqueue_input(&EnqueueInput {
                key: format!("active-{index}"),
                thread_id: child.child_thread_id.clone(),
                branch_id: child.child_branch_id.clone(),
                mode,
                input: json!("active correction"),
                configuration: None,
            })
            .unwrap();
        assert_eq!(receipt.run_id, run);
    }
    let mut command = EnqueueInput {
        key: "next-clone".into(),
        thread_id: child.child_thread_id.clone(),
        branch_id: child.child_branch_id.clone(),
        mode: InputMode::NextRun,
        input: json!("next"),
        configuration: None,
    };
    assert!(f.db.enqueue_input(&command).is_err());
    f.db.request_cancel_run(&run).unwrap();
    f.db.commit_execution(
        &run,
        f.db.epoch(),
        &ExecutionRecord::StateChanged {
            state: RunState::Cancelled,
            waiting_on: None,
        },
    )
    .unwrap();
    command.key = "idle-clone".into();
    command.mode = InputMode::Boundary;
    assert!(f.db.enqueue_input(&command).is_err());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn continuation_resource_cas_preserves_summary_memory_and_binds_explicit_skill_to_the_new_input() {
    use varin_runtime::catalog::resources::{ContextResources, InputResourcePreparation};
    let mut f = Fixture::new();
    let first = first(&mut f);
    let mut summary = context(&first, "summary-context").0;
    summary.expected_revision = 1;
    summary.through_id = Some(first.receipt.as_ref().unwrap().input_id.clone());
    summary.summary = "Retain the verified summary".into();
    let old = f.db.publish_context(summary).unwrap();
    finish(&mut f.db, &first, Some("ready"));
    let command = continuation_command(
        &f.db,
        &first,
        "skill-next",
        json!({"text":"/skill:review exact scope","attachments":[{"media_type":"image/png","content_ref":"image:retained"}]}),
    );
    let next = accept(&mut f.db, command);
    let source = ready_source(&mut f.db, &next);
    let reference = json!({"domainId":"domain","viewId":"fixed-view","path":"review/SKILL.md","canonicalId":"domain/review/SKILL.md","version":"retained-v1"});
    let resources:ContextResources=serde_json::from_value(json!({"source":source,"snapshot":{"id":"new-source-resources","scope":{"threadId":first.child_thread_id,"branchId":first.child_branch_id,"mode":"agent","threadRole":"worker","projectId":first.project_id,"sourceIdentity":"exact-next-source","cwd":"","projectTrusted":true,"projectRoot":null},"readers":[{"domainId":"domain","viewId":"fixed-view","consistency":"immutable"}],"project":null,"configurationDigest":"resources-v1","shadowedContextCanonicalIds":[],"system":null,"appendSystem":null,"instructions":[],"instructionScopes":[],"skills":[{"id":"review","name":"review","description":"review resource","disableModelInvocation":false,"requiresProjectTrust":false,"origin":"user","reference":reference,"basePath":"review","baseCanonicalId":"domain/review","priority":0}],"diagnostics":[],"capturedFiles":[{"reference":reference,"content":"Use this exact resource"}],"observations":[]}})).unwrap();
    let skill:InputResourcePreparation=serde_json::from_value(json!({"expectedContextCheckpoint":null,"skill":{"snapshotId":"new-source-resources","resourceId":"review","reference":reference,"name":"review","arguments":"exact scope","body":"Use this exact resource"}})).unwrap();
    let (proposal, basis) = context(&first, "new-context");
    let stale =
        f.db.capture_child_preparation(
            &next.execution_id,
            source.clone(),
            proposal.clone(),
            basis.clone(),
        )
        .unwrap()
        .with_resources(Some(resources.clone()))
        .with_input_preparation(Some(skill.clone()))
        .with_expected_checkpoint(Some("different-checkpoint".into()))
        .load();
    assert!(stale.is_err());
    let prepared =
        f.db.capture_child_preparation(
            &next.execution_id,
            source.clone(),
            proposal.clone(),
            basis.clone(),
        )
        .unwrap()
        .with_resources(Some(resources.clone()))
        .with_input_preparation(Some(skill.clone()))
        .with_expected_checkpoint(Some(old.id.clone()))
        .load()
        .unwrap();
    let child = f.db.admit_child(prepared).unwrap();
    let current =
        f.db.active_context(&first.child_branch_id)
            .unwrap()
            .unwrap();
    let replay =
        f.db.capture_child_preparation(&next.execution_id, source, proposal, basis)
            .unwrap()
            .with_resources(Some(resources))
            .with_input_preparation(Some(skill))
            .with_expected_checkpoint(Some(old.id.clone()))
            .load()
            .unwrap();
    assert_eq!(f.db.admit_child(replay).unwrap().receipt, child.receipt);
    assert_eq!(
        f.db.active_context(&first.child_branch_id)
            .unwrap()
            .unwrap()
            .id,
        current.id
    );
    assert_eq!(current.proposal.summary, old.proposal.summary);
    assert_eq!(current.proposal.through_id, old.proposal.through_id);
    assert_eq!(
        current.personalization.as_ref().unwrap().memory_snapshot,
        old.personalization.as_ref().unwrap().memory_snapshot
    );
    assert_eq!(current.revision, old.revision + 1);
    let history = f.db.history(&first.child_branch_id).unwrap();
    let item = history
        .iter()
        .find(|item| item.id == child.receipt.as_ref().unwrap().input_id)
        .unwrap();
    assert_eq!(item.source, HistorySource::User);
    assert_eq!(item.content["text"], "/skill:review exact scope");
    assert_eq!(
        item.content["skillInvocations"][0]["resourceCheckpointId"],
        current.id
    );
    assert_eq!(
        item.content["attachments"][0]["content_ref"],
        "image:retained"
    );
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn each_new_run_retargets_only_the_original_mcp_definition_and_its_own_recovery_is_exact() {
    use varin_runtime::catalog::launches::*;
    let tool = ToolSchema {
        name: "mcp_tool".into(),
        version: "schema-v1".into(),
        description: "Frozen tool".into(),
        schema: json!({"type":"object"}),
        output_schema: None,
        metadata: None,
    };
    let binding = HostToolBinding {
        reference: "parent-owner".into(),
        generation: 1,
        tools: vec![tool],
        resources: [
            ("mcp_tool".into(), "parent-resource".into()),
            ("server:one".into(), "parent-resource".into()),
        ]
        .into(),
        provenance: McpProvenance {
            configuration: McpConfiguration {
                agent_dir: "/agent".into(),
                config_cwd: "/workspace".into(),
                project_trusted: true,
            },
            execution_scope: McpExecutionScope::Workspace,
            servers: [(
                "one".into(),
                McpServerSelection {
                    definition_version: "definition-v1".into(),
                    resource_key: "parent-resource".into(),
                },
            )]
            .into(),
        },
    };
    let mut f = Fixture::new_host_child(
        false,
        Some(binding),
        vec!["mcp_tool".into(), "helper".into()],
    );
    let first = first(&mut f);
    let derive = |mut binding: HostToolBinding, id: &str| {
        binding.reference = format!("owner-{id}");
        binding.generation += 1;
        for key in binding.resources.values_mut() {
            *key = format!("resource-{id}");
        }
        for server in binding.provenance.servers.values_mut() {
            server.resource_key = format!("resource-{id}");
        }
        binding
    };
    let original = f.launch.mcp_binding.clone().unwrap();
    let first_binding = derive(original, "first");
    let first_run = first.receipt.as_ref().unwrap().run_id.clone();
    f.db.prepare_mcp_launch(&first_run, first_binding.clone())
        .unwrap();
    finish(&mut f.db, &first, Some("first"));
    f.db.mark_child_resources_released(&first.execution_id)
        .unwrap();
    let command = continuation_command(&f.db, &first, "mcp-next", json!("continue"));
    let next = accept(&mut f.db, command);
    let source = ready_source(&mut f.db, &next);
    let second = prepare(&mut f.db, &next, source);
    let run = second.receipt.as_ref().unwrap().run_id.clone();
    assert_eq!(
        f.db.launch_intent(&run)
            .unwrap()
            .unwrap()
            .selection
            .mcp_binding,
        Some(first_binding.clone())
    );
    let second_binding = derive(first_binding, "second");
    let mut wrong = second_binding.clone();
    wrong
        .provenance
        .servers
        .get_mut("one")
        .unwrap()
        .definition_version = "latest-definition".into();
    assert!(f.db.prepare_mcp_launch(&run, wrong).is_err());
    f.db.prepare_mcp_launch(&run, second_binding.clone())
        .unwrap();
    let root = f.root.clone();
    drop(f.db);
    f.db = Catalog::open(&root).unwrap();
    assert_eq!(
        f.db.prepare_mcp_launch(&run, second_binding.clone())
            .unwrap()
            .selection
            .mcp_binding,
        Some(second_binding.clone())
    );
    assert!(f
        .db
        .prepare_mcp_launch(&run, derive(second_binding, "third"))
        .is_err());
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn continuation_freezes_the_previous_actual_model_and_policy_instead_of_initial_dispatch_defaults()
{
    use varin_runtime::catalog::policy_switch::{
        AgentPolicyArtifactBinding, PolicyStateMode, PolicyStateTransition, PolicyTarget,
    };
    let mut f = Fixture::new();
    let first = first(&mut f);
    let run_id = first.receipt.as_ref().unwrap().run_id.clone();
    let mut configuration: ModelSessionConfiguration =
        serde_json::from_value(f.db.run(&run_id).unwrap().configuration).unwrap();
    configuration.model = "user-selected-model".into();
    configuration.configuration_generation += 1;
    let scope =
        f.db.launch_intent(&run_id)
            .unwrap()
            .unwrap()
            .selection
            .credential_scope;
    let choice =
        f.db.select_model(&run_id, "user-model", configuration.clone(), scope.clone())
            .unwrap();
    assert!(f
        .db
        .prepare_model_selection(&choice, f.db.epoch(), None)
        .unwrap());
    let identity = varin_runtime::catalog::dispatch::ChildModelBinding {
        configuration: configuration.clone(),
        credential_scope: scope,
    }
    .connection_identity()
    .unwrap();
    let binding:RequestBinding=serde_json::from_value(json!({"child_dispatch":null,"goal":null,"resource_activations":[],"resource_checkpoint_id":null,"connection_identity":identity,"provider_family":configuration.provider_family,"model":configuration.model,"credential_ref":null,"configuration_generation":configuration.configuration_generation,"tool_schema_generation":first.launch.tool_schema_generation,"tools":f.launch.tools,"instruction_sources":[],"memory_checkpoint":null,"attachment_refs":[],"environment_cursor":0,"history_range":{"branch_id":first.child_branch_id,"ancestor_id":null,"leaf_id":f.db.head(&first.child_branch_id).unwrap()}})).unwrap();
    assert!(f
        .db
        .activate_model_selection(&choice, f.db.epoch(), &binding)
        .unwrap());
    let mut artifact = AgentPolicyArtifactBinding {
        provider_key: "policy:exact".into(),
        extension_id: "policy".into(),
        extension_version: "1".into(),
        service_id: "varin.agent.policy".into(),
        service_version: 3,
        artifact_integrity: "retained-artifact".into(),
        configuration_identity: "retained-configuration".into(),
        declared_identity: PolicyIdentity {
            name: "policy".into(),
            version: "1".into(),
        },
        identity: PolicyIdentity {
            name: "selected-policy".into(),
            version: "1".into(),
        },
        model_roles: vec!["agentPlanning".into()],
        state_transition: PolicyStateTransition::Explicit,
    };
    let planner_configuration:ModelSessionConfiguration=serde_json::from_value(json!({"providerFamily":"openai-responses","endpoint":"https://planner.invalid/responses","model":"retained-planner","allowAnonymous":false,"configurationGeneration":7})).unwrap();
    let planner_scope = varin_runtime::providers::auth::CredentialScope {
        reference: "retained-planner-account".into(),
        authority: "host-provider".into(),
        account: "original-account".into(),
        generation: 9,
    };
    use sha2::{Digest, Sha256};
    let configuration_identity = hex::encode(Sha256::digest(
        serde_json::to_vec(&json!({"configuration":planner_configuration,"scope":planner_scope}))
            .unwrap(),
    ));
    let mut planner = PolicyModelCapability {
        capability_id: "agentPlanning".into(),
        purpose: "planning".into(),
        status: PolicyModelStatus::Available,
        binding_id: Some(format!("policy:1:agentPlanning:{configuration_identity}")),
        configuration_identity: Some(configuration_identity),
        supported_operation: "tool_free_text".into(),
        binding: None,
        configuration: Some(planner_configuration),
        credential_scope: Some(planner_scope),
    };
    // An optional independent Host-generated selection can traverse this same real
    // Catalog activation/admission path and be returned to its original consumer.
    if let Some(path) = std::env::var_os("VARIN_CONTINUATION_POLICY_PROBE_INPUT") {
        let input: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        artifact = serde_json::from_value(input["artifact"].clone()).unwrap();
        planner = serde_json::from_value(input["capabilities"][0].clone()).unwrap();
    }
    let config = planner.configuration.as_ref().unwrap();
    let scope = planner.credential_scope.as_ref().unwrap();
    let mut planner_binding = binding.clone();
    planner_binding.connection_identity =
        varin_runtime::model_session::connection_identity_with_scope(config, scope).unwrap();
    planner_binding.provider_family = config.provider_family.clone();
    planner_binding.model = config.model.clone();
    planner_binding.configuration_generation = config.configuration_generation;
    planner_binding.credential_ref = Some(scope.reference.clone());
    planner_binding.tool_schema_generation = 0;
    planner_binding.tools.clear();
    planner_binding.history_range = HistoryRange {
        branch_id: String::new(),
        ancestor_id: None,
        leaf_id: None,
    };
    planner.binding = Some(planner_binding);
    let target = PolicyTarget::Extension {
        artifact: artifact.clone(),
    };
    let selected =
        f.db.select_policy(
            &run_id,
            "user-policy",
            0,
            None,
            target.clone(),
            PolicyStateMode::RestartState,
        )
        .unwrap();
    assert_eq!(selected.generation, 1);
    let p =
        f.db.prepare_policy_ready(
            &run_id,
            &selected.selection_id,
            1,
            artifact.identity.clone(),
            vec![planner.clone()],
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.publish_policy_ready(p).unwrap();
    let p =
        f.db.capture_policy_activation(&run_id, f.db.epoch(), &selected.selection_id, 1)
            .unwrap()
            .unwrap()
            .load(
                &json!({"private":"previous generation"}),
                &PolicyEvent::Started,
            )
            .unwrap();
    f.db.activate_policy(p).unwrap().unwrap();
    assert_eq!(
        f.db.launch_intent(&run_id)
            .unwrap()
            .unwrap()
            .policy_generation,
        1
    );
    finish(&mut f.db, &first, Some("selected configuration finished"));
    let command = continuation_command(&f.db, &first, "preserve-selection", json!("continue"));
    let next = accept(&mut f.db, command);
    assert_eq!(next.launch.model, configuration.model);
    assert_eq!(next.policy_target, target);
    assert_eq!(next.launch.policy, artifact.identity);
    let source = ready_source(&mut f.db, &next);
    let child = prepare(&mut f.db, &next, source);
    let new_run = child.receipt.as_ref().unwrap().run_id.clone();
    let saved = f.db.launch_intent(&new_run).unwrap().unwrap();
    assert_eq!(
        f.db.run(&new_run).unwrap().configuration,
        serde_json::to_value(configuration).unwrap()
    );
    assert_eq!(saved.policy_target, target);
    assert_eq!(saved.policy_generation, 0);
    assert!(!saved.policy_preparable);
    let mut expected = planner.clone();
    expected.binding_id = Some(format!(
        "policy:0:agentPlanning:{}",
        planner.configuration_identity.as_ref().unwrap()
    ));
    assert_eq!(saved.selection.policy_models, vec![expected]);
    assert_eq!(
        f.db.launch_intent(&run_id)
            .unwrap()
            .unwrap()
            .selection
            .policy_models,
        vec![planner]
    );
    if let Some(path) = std::env::var_os("VARIN_CONTINUATION_POLICY_PROBE_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&saved).unwrap()).unwrap();
    }
    let inspect = rusqlite::Connection::open_with_flags(
        f.root.join("conversation.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        inspect
            .query_row(
                "SELECT count(*) FROM policy_checkpoints WHERE run_id=?1",
                [&new_run],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    drop(inspect);
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn new_user_execution_leaves_ended_goal_behind_but_preserves_active_pause_and_budget() {
    use varin_runtime::catalog::goals::*;
    for action in [
        Some(GoalControlAction::Complete),
        Some(GoalControlAction::Cancel),
        Some(GoalControlAction::Pause),
        None,
    ] {
        let mut f = Fixture::new();
        let first = first(&mut f);
        finish(&mut f.db, &first, Some("old delegated work done"));
        let scope = GoalScope {
            thread_id: first.parent_thread_id.clone(),
            branch_id: first.parent_branch_id.clone(),
        };
        let prepared =
            f.db.prepare_goal_start(
                "original-goal",
                &first.parent_run_id,
                scope.clone(),
                "Original parent objective".into(),
                action.is_none().then_some(GoalBudget {
                    max_output_tokens: 0,
                }),
            )
            .unwrap()
            .load()
            .unwrap();
        let goal = f.db.admit_goal_mutation(prepared).unwrap();
        assert_eq!(
            f.db.goal_binding(&first.receipt.as_ref().unwrap().run_id)
                .unwrap()
                .unwrap()
                .id,
            goal.id
        );
        if let Some(action) = action {
            f.db.control_goal(&goal.id, goal.revision, &scope, action)
                .unwrap();
        }
        let original = f.db.capture_goal(&goal.id).unwrap().load().unwrap();
        let command = continuation_command(
            &f.db,
            &first,
            "user-new-goal-boundary",
            json!("New explicit User intent"),
        );
        let next = accept(&mut f.db, command);
        let source = ready_source(&mut f.db, &next);
        let child = prepare(&mut f.db, &next, source);
        let run = &child.receipt.as_ref().unwrap().run_id;
        let ended = matches!(
            action,
            Some(GoalControlAction::Complete | GoalControlAction::Cancel)
        );
        if ended {
            assert_eq!(f.db.goal_binding(run).unwrap(), None);
            assert!(matches!(
                f.db.goal_boundary(run, f.db.epoch()).unwrap(),
                GoalBoundary::Continue
            ));
            // A later parent Goal may adopt the old delegated lineage, but cannot
            // cross this independently admitted User continuation back into it.
            let prepared =
                f.db.prepare_goal_start(
                    "later-parent-goal",
                    &first.parent_run_id,
                    scope,
                    "Later parent objective".into(),
                    None,
                )
                .unwrap()
                .load()
                .unwrap();
            f.db.admit_goal_mutation(prepared).unwrap();
            assert_eq!(f.db.goal_binding(run).unwrap(), None);
        } else {
            assert_eq!(f.db.goal_binding(run).unwrap().unwrap().id, goal.id);
            assert!(matches!(
                f.db.goal_boundary(run, f.db.epoch()).unwrap(),
                GoalBoundary::Wait { .. }
            ));
        }
        assert_eq!(
            f.db.capture_goal(&goal.id).unwrap().load().unwrap().usage,
            original.usage
        );
        assert_eq!(
            f.db.goal_binding(&first.receipt.as_ref().unwrap().run_id)
                .unwrap()
                .unwrap()
                .id,
            goal.id
        );
        let root = f.root.clone();
        drop(f.db);
        f.db = Catalog::open(&root).unwrap();
        assert_eq!(f.db.goal_binding(run).unwrap().is_none(), ended);
        if ended {
            assert!(matches!(
                f.db.goal_boundary(run, f.db.epoch()).unwrap(),
                GoalBoundary::Continue
            ));
        }
        drop(f);
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn request_child(f:&mut Fixture,child:&ChildTask,key:&str)->varin_runtime::catalog::messages::MessageReceipt {
    use varin_runtime::catalog::messages::*;
    let prepared=f.db.prepare_user_message(key.into(),child.parent_thread_id.clone(),child.parent_branch_id.clone(),MessageInput{target_thread_id:Some(child.child_thread_id.clone()),target_branch_id:Some(child.child_branch_id.clone()),reply_to:None,kind:MessageKind::Request,text:"/skill:ordinary-text does not acquire an explicit User skill".into()}).unwrap().load().unwrap();
    f.db.admit_message(prepared).unwrap().receipt
}
#[test]
fn directed_request_reuses_delegated_source_and_original_message_history_without_user_conversion() {
    use varin_runtime::catalog::messages::{MessageActivation,activation::RequestActivationAdmission};
    for isolated in [false,true] {
    let mut f=if isolated {Fixture::new_isolated()} else {Fixture::new()};let child=first(&mut f);finish(&mut f.db,&child,Some("first report"));
    let fixed=isolated.then(||result(&mut f.db,&child,Effect::Unknown));
    let previous=f.db.delegated_execution(&child.execution_id).unwrap();
    let message=request_child(&mut f,&child,"child-request");
    let candidate=f.db.capture_request_activations().unwrap().pop().unwrap().load().unwrap();
    let RequestActivationAdmission::Delegated(id)=f.db.admit_request_activation(candidate).unwrap() else{panic!("delegated request")};
    let next=f.db.delegated_execution(&id).unwrap();
    if let Some(fixed)=&fixed {assert!(matches!(&next.source_basis,Some(ChildSourceBasis::WorkingResult{result,..}) if result==fixed));}
    assert!(matches!(&next.trigger,DelegatedTrigger::MessageRequest{message_id,previous_run_id,..} if message_id==&message.identity.message_id && previous_run_id==&child.receipt.as_ref().unwrap().run_id));
    let read=f.db.capture_message(&child.child_thread_id,&child.child_branch_id,&message.identity.message_id).unwrap().load().unwrap();
    assert!(matches!(read.summary.activation,MessageActivation::Pending{execution_id:Some(ref execution),..} if execution==&id));
    assert_eq!(read.summary.state,InputState::Queued);
    let root=f.root.clone();drop(f);let mut db=Catalog::open(&root).unwrap();
    let next=db.delegated_execution(&id).unwrap();let source=ready_source(&mut db,&next);let current=prepare(&mut db,&next,source);
    let receipt=current.receipt.as_ref().unwrap();assert_eq!(receipt.input_id,message.identity.message_id);
    let history=db.history(&child.child_branch_id).unwrap();assert_eq!(history.last().unwrap().id,message.identity.message_id);assert_eq!(history.last().unwrap().source,HistorySource::User);
    let content=db.execution_history(&child.child_branch_id).unwrap();let item=content.last().unwrap();assert!(matches!(item.provenance,Provenance::UserInstruction{..}));assert!(item.resource_activation.is_none());
    assert_eq!(db.delegated_execution(&child.execution_id).unwrap(),previous);
    finish(&mut db,&current,None);
    assert_eq!(db.delegated_execution(&id).unwrap().report.unwrap().outcome,Outcome::Failed);
    assert_eq!(db.delegated_execution(&child.execution_id).unwrap(),previous);
    assert!(db.capture_request_activations().unwrap().is_empty());drop(db);std::fs::remove_dir_all(root).unwrap();    }
}

#[test]
fn pending_request_child_tree_cancel_fences_staged_source_and_later_new_intent_is_independent() {
    use varin_runtime::catalog::messages::activation::RequestActivationAdmission;
    let mut f=Fixture::new();let child=first(&mut f);finish(&mut f.db,&child,Some("fixed report"));
    let old=request_child(&mut f,&child,"old-request");let late=f.db.capture_request_activations().unwrap().pop().unwrap().load().unwrap();
    f.db.cancel_tree(TreeCancelTarget::Child{operation_id:child.operation_id.clone()}).unwrap();
    assert_eq!(f.db.admit_request_activation(late).unwrap(),RequestActivationAdmission::Stale);
    assert_eq!(f.db.capture_message(&child.child_thread_id,&child.child_branch_id,&old.identity.message_id).unwrap().load().unwrap().summary.state,InputState::Cancelled);
    let newer=request_child(&mut f,&child,"new-request");let candidate=f.db.capture_request_activations().unwrap().pop().unwrap().load().unwrap();
    let RequestActivationAdmission::Delegated(id)=f.db.admit_request_activation(candidate).unwrap() else{panic!("new intent")};
    let execution=f.db.delegated_execution(&id).unwrap();assert!(matches!(execution.trigger,DelegatedTrigger::MessageRequest{message_id,..} if message_id==newer.identity.message_id));
    let root=f.root.clone();drop(f);std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn request_child_respects_active_goal_but_never_reinherits_ended_goal_from_the_family() {
    use varin_runtime::catalog::{goals::*,messages::activation::RequestActivationAdmission};
    for action in [GoalControlAction::Pause,GoalControlAction::Complete,GoalControlAction::Cancel] {
        let mut f=Fixture::new();let child=first(&mut f);finish(&mut f.db,&child,Some("first goal work"));
        let scope=GoalScope{thread_id:child.parent_thread_id.clone(),branch_id:child.parent_branch_id.clone()};
        let prepared=f.db.prepare_goal_start("goal",&child.parent_run_id,scope.clone(),"Original Goal".into(),None).unwrap().load().unwrap();let goal=f.db.admit_goal_mutation(prepared).unwrap();f.db.control_goal(&goal.id,goal.revision,&scope,action).unwrap();
        request_child(&mut f,&child,"goal-request");
        let mut candidates=f.db.capture_request_activations().unwrap();
        if action==GoalControlAction::Pause {assert!(candidates.is_empty())} else {
            let RequestActivationAdmission::Delegated(id)=f.db.admit_request_activation(candidates.pop().unwrap().load().unwrap()).unwrap() else{panic!("new request")};
            let next=f.db.delegated_execution(&id).unwrap();let source=ready_source(&mut f.db,&next);let next=prepare(&mut f.db,&next,source);let run=next.receipt.unwrap().run_id;
            assert!(f.db.goal_binding(&run).unwrap().is_none());assert!(matches!(f.db.goal_boundary(&run,f.db.epoch()).unwrap(),GoalBoundary::Continue));
        }
        let root=f.root.clone();drop(f);std::fs::remove_dir_all(root).unwrap();
    }
}
