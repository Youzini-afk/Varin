use super::*;
#[path = "../tests/fixtures/child_dispatch.rs"]
mod fixture;
use crate::execution::{Content, ConversationHistory};
use crate::test_submission::InputAdmission;

fn visible(db: &Catalog, run: &str) -> (Option<String>, ConversationHistory) {
    let branch = db.run(run).unwrap().branch_id;
    let head = db.head(&branch).unwrap();
    match db
        .prepare_context_read(run, db.epoch(), head.as_deref())
        .unwrap()
    {
        Some(read) => {
            let context = read.load().unwrap();
            (Some(context.checkpoint_id), context.history)
        }
        None => (None, db.execution_history(&branch).unwrap()),
    }
}

fn prepare(db: &Catalog, run: &str) -> inputs::PreparedInputDelivery {
    let branch = db.run(run).unwrap().branch_id;
    let (checkpoint, history) = visible(db, run);
    db.prepare_collaboration_observation(
        run,
        db.epoch(),
        db.head(&branch).unwrap().as_deref(),
        checkpoint.as_deref(),
        &history,
    )
    .unwrap()
    .unwrap()
    .load()
    .unwrap()
}

fn observe(db: &mut Catalog, run: &str) -> ConversationHistory {
    let prepared = prepare(db, run);
    let batch = db.admit_input_delivery(prepared).unwrap().unwrap();
    assert!(!batch.activating);
    assert!(batch.input_ids.is_empty());
    batch.items
}

#[test]
fn changed_observations_survive_restart_without_rewriting_the_previous_prefix() {
    let mut f = fixture::Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let first = observe(&mut f.db, &run);
    assert_eq!(first.len(), 1);
    assert!(matches!(first[0].content, Content::Output { .. }));
    let original = f.db.history("branch:parent").unwrap();
    assert!(observe(&mut f.db, &run).is_empty());
    assert_eq!(f.db.history("branch:parent").unwrap(), original);
    let revision = f.db.inspect_thread(&child.child_thread_id).unwrap()["revision"]
        .as_u64()
        .unwrap();
    f.db.update_thread(&threads::ThreadUpdate {
        thread_id: child.child_thread_id.clone(),
        key: "new-coordination-name".into(),
        expected_revision: revision,
        title: Some("Verify the parser".into()),
        title_mode: None,
        pinned: None,
        archived: None,
    })
    .unwrap();
    let second = observe(&mut f.db, &run);
    assert_eq!(second.len(), 1);
    assert_ne!(first[0].id, second[0].id);
    assert_eq!(
        &f.db.history("branch:parent").unwrap()[..original.len()],
        original.as_slice()
    );
    let root = f.root.clone();
    drop(f);
    let mut reopened = Catalog::open(&root).unwrap();
    let history = reopened.execution_history("branch:parent").unwrap();
    assert!(history.iter().any(|item| item == &first[0]));
    assert!(history.iter().any(|item| item == &second[0]));
    assert!(observe(&mut reopened, &run).is_empty());
    assert!(family::CollaborationSnapshot::from_item(&second[0])
        .unwrap()
        .unwrap()
        .members
        .iter()
        .any(|member| member.name == "Verify the parser"));
    drop(reopened);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_fork_gets_its_own_observation_instead_of_a_foreign_branch_watermark() {
    let mut f = fixture::Fixture::new();
    f.accept();
    f.settle_exchange();
    let parent = f.context.run_id.clone();
    let first = observe(&mut f.db, &parent).remove(0);
    let configuration = f.db.run(&parent).unwrap().configuration;
    f.db.fork_branch("branch:parent", "fork", Some(&first.id))
        .unwrap();
    let next =
        f.db.submit(&SubmitInput {
            key: "fork-input".into(),
            thread_id: "thread:parent".into(),
            branch_id: "fork".into(),
            expected_head: Some(first.id.clone()),
            input: json!("continue on the fork"),
            configuration,
        })
        .unwrap();
    let forked = observe(&mut f.db, &next.run_id);
    assert_eq!(forked.len(), 1);
    let snapshot = family::CollaborationSnapshot::from_item(&forked[0])
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.caller_branch_id, "fork");
    assert_eq!(
        f.db.head("branch:parent").unwrap().as_deref(),
        Some(first.id.as_str())
    );
    assert!(observe(&mut f.db, &next.run_id).is_empty());
}

#[test]
fn empty_initial_family_is_omitted_but_disappearing_members_are_recorded() {
    let root = std::env::temp_dir().join(format!("varin-empty-family-{}", id()));
    let mut db = Catalog::open(&root).unwrap();
    db.create_thread("alone", "main").unwrap();
    let input = db
        .submit(&SubmitInput {
            key: "alone-input".into(),
            thread_id: "alone".into(),
            branch_id: "main".into(),
            expected_head: None,
            input: json!("work"),
            configuration: json!({}),
        })
        .unwrap();
    let before = db.head("main").unwrap();
    assert!(observe(&mut db, &input.run_id).is_empty());
    assert_eq!(db.head("main").unwrap(), before);
    drop(db);
    let _ = std::fs::remove_dir_all(root);

    let mut f = fixture::Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    assert_eq!(observe(&mut f.db, &run).len(), 1);
    let revision = f.db.inspect_thread(&child.child_thread_id).unwrap()["revision"]
        .as_u64()
        .unwrap();
    f.db.delete_thread(&threads::ThreadDelete {
        thread_id: child.child_thread_id,
        key: "hide-child".into(),
        expected_revision: revision,
    })
    .unwrap();
    let empty = observe(&mut f.db, &run);
    assert_eq!(empty.len(), 1);
    assert!(family::CollaborationSnapshot::from_item(&empty[0])
        .unwrap()
        .unwrap()
        .is_empty());
    assert!(observe(&mut f.db, &run).is_empty());
}

#[test]
fn checkpoint_head_and_input_races_never_publish_a_stale_observation() {
    let mut f = fixture::Fixture::new();
    f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let prepared = prepare(&f.db, &run);
    let before = f.db.head("branch:parent").unwrap();
    let current = f.db.active_context("branch:parent").unwrap();
    f.db.publish_context(context::ContextProposal {
        key: "new-coordination-checkpoint".into(),
        branch_id: "branch:parent".into(),
        through_id: None,
        expected_revision: current.map_or(0, |value| value.revision),
        summary: String::new(),
        effective_system_prompt: "new fixed instructions".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    })
    .unwrap();
    assert!(f.db.admit_input_delivery(prepared).unwrap().is_none());
    assert_eq!(f.db.head("branch:parent").unwrap(), before);

    let prepared = prepare(&f.db, &run);
    let pending =
        f.db.enqueue_input(&inputs::EnqueueInput {
            key: "input-wins".into(),
            thread_id: "thread:parent".into(),
            branch_id: "branch:parent".into(),
            mode: InputMode::Boundary,
            input: json!("change the task first"),
            configuration: None,
        })
        .unwrap();
    assert!(matches!(
        f.db.admit_input_delivery(prepared),
        Err(RuntimeError::InputPending)
    ));
    assert_eq!(
        f.db.queued_input(&pending.input_id).unwrap().state,
        InputState::Queued
    );
    assert_eq!(f.db.head("branch:parent").unwrap(), before);
    f.db.consume_inputs(&run, f.db.epoch(), before.as_deref())
        .unwrap();

    let prepared = prepare(&f.db, &run);
    let head = f.db.head("branch:parent").unwrap();
    f.db.append_history(
        &run,
        f.db.epoch(),
        head.as_deref(),
        HistorySource::Assistant,
        serde_json::to_value(ConversationItem::<crate::output::ResolvedMedia> {
            id: "other-history".into(),
            provenance: Provenance::Assistant,
            content: Content::Text {
                text: "another original history fact".into(),
            },
            opaque: None,
            resource_activation: None,
        })
        .unwrap(),
        None,
    )
    .unwrap();
    let moved = f.db.head("branch:parent").unwrap();
    assert!(f.db.admit_input_delivery(prepared).is_err());
    assert_eq!(f.db.head("branch:parent").unwrap(), moved);
}

#[test]
fn cancellation_and_open_exchanges_block_observation_writes() {
    let mut f = fixture::Fixture::new();
    f.accept();
    let run = f.context.run_id.clone();
    let head = f.db.head("branch:parent").unwrap();
    let (checkpoint, history) = visible(&f.db, &run);
    assert!(
        f.db.prepare_collaboration_observation(
            &run,
            f.db.epoch(),
            head.as_deref(),
            checkpoint.as_deref(),
            &history,
        )
        .is_err(),
        "the dispatch tool exchange is not closed"
    );
    f.settle_exchange();
    let prepared = prepare(&f.db, &run);
    let head = f.db.head("branch:parent").unwrap();
    f.db.request_cancel_run(&run).unwrap();
    assert!(matches!(
        f.db.admit_input_delivery(prepared),
        Err(RuntimeError::DispatchCancelled)
    ));
    assert_eq!(f.db.head("branch:parent").unwrap(), head);

    let mut f = fixture::Fixture::new();
    f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let prepared = prepare(&f.db, &run);
    f.db.prepare_model_step("open-model", &run, f.db.epoch(), json!({}))
        .unwrap();
    let before = f.db.head("branch:parent").unwrap();
    assert!(f.db.admit_input_delivery(prepared).is_err());
    assert_eq!(f.db.head("branch:parent").unwrap(), before);
}

#[test]
fn an_unrelated_or_modified_snapshot_is_not_a_deduplication_authority() {
    let mut f = fixture::Fixture::new();
    f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let first = observe(&mut f.db, &run).remove(0);
    let mut altered = family::CollaborationSnapshot::from_item(&first)
        .unwrap()
        .unwrap();
    altered.members[0].name = "not the original observation".into();
    let candidate = Arc::new(altered.to_item(&first.id).unwrap());
    let (checkpoint, _) = visible(&f.db, &run);
    let prepared =
        f.db.prepare_collaboration_observation(
            &run,
            f.db.epoch(),
            Some(&first.id),
            checkpoint.as_deref(),
            &[candidate],
        )
        .unwrap()
        .unwrap();
    assert!(prepared.load().is_err());
    assert_eq!(
        f.db.head("branch:parent").unwrap().as_deref(),
        Some(first.id.as_str())
    );
}

#[test]
fn a_finite_capture_keeps_its_original_state_and_catches_later_changes_next_time() {
    let mut f = fixture::Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let prepared = prepare(&f.db, &run);
    let original_name = f.db.inspect_thread(&child.child_thread_id).unwrap()["title"]
        .as_str()
        .unwrap()
        .to_owned();
    let revision = f.db.inspect_thread(&child.child_thread_id).unwrap()["revision"]
        .as_u64()
        .unwrap();
    f.db.update_thread(&threads::ThreadUpdate {
        thread_id: child.child_thread_id,
        key: "change-after-capture".into(),
        expected_revision: revision,
        title: Some("New work after capture".into()),
        title_mode: None,
        pinned: None,
        archived: None,
    })
    .unwrap();
    let first = f.db.admit_input_delivery(prepared).unwrap().unwrap().items;
    let first_state = family::CollaborationSnapshot::from_item(&first[0])
        .unwrap()
        .unwrap();
    assert_eq!(first_state.members[0].name, original_name);
    let second = observe(&mut f.db, &run);
    assert_eq!(
        family::CollaborationSnapshot::from_item(&second[0])
            .unwrap()
            .unwrap()
            .members[0]
            .name,
        "New work after capture"
    );
    assert!(observe(&mut f.db, &run).is_empty());
}

#[test]
fn prepared_observation_from_a_previous_owner_epoch_cannot_append_after_reopen() {
    let mut f = fixture::Fixture::new();
    f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let prepared = prepare(&f.db, &run);
    let head = f.db.head("branch:parent").unwrap();
    let root = f.root.clone();
    drop(f);
    let mut reopened = Catalog::open(&root).unwrap();
    assert!(reopened.admit_input_delivery(prepared).is_err());
    assert_eq!(reopened.head("branch:parent").unwrap(), head);
    assert_eq!(observe(&mut reopened, &run).len(), 1);
    drop(reopened);
    let _ = std::fs::remove_dir_all(root);
}

struct EmptyRetainSummary;
impl crate::execution::ModelProvider for EmptyRetainSummary {
    fn serialize(
        &self,
        view: &crate::execution::RequestView,
        _: Option<&mut crate::execution::RequestCompileReuse>,
    ) -> std::result::Result<crate::execution::RequestBody, crate::execution::ExecutionError> {
        Ok(serde_json::to_value(view).unwrap().into())
    }
    fn generate(
        &self,
        _: &crate::execution::RequestSnapshot,
        _: &crate::execution::CancellationToken,
        emit: &mut dyn FnMut(
            crate::execution::ProviderEvent,
        ) -> std::result::Result<(), crate::execution::ExecutionError>,
    ) -> std::result::Result<crate::execution::FinishReason, crate::execution::ModelFailure> {
        emit(crate::execution::ProviderEvent::ItemCompleted {
            item: crate::execution::ProviderItem {
                id: "empty-retain-summary".into(),
                opaque: None,
                content: Content::Text {
                    text: json!({"summary":"Continue the coordinated work.","retain":[]})
                        .to_string(),
                },
            },
        })
        .unwrap();
        Ok(crate::execution::FinishReason::Stop)
    }
}

fn compact(
    supervisor: &crate::supervisor::RunSupervisor,
    run: &str,
    key: &str,
    launch: launches::LaunchSelection,
) -> context::ContextCheckpoint {
    use crate::context_job::{
        configure_compaction_start, text_compaction_start, ContextJobRequest, ContextSummaryRecipe,
    };
    let owner = supervisor.catalog();
    let (job, selected, execution) = {
        let mut db = owner.lock().unwrap();
        let source = db.run(run).unwrap();
        let mut summary_recipe = ContextSummaryRecipe::manual();
        summary_recipe.continuation_budget_tokens = Some(4096);
        let request = ContextJobRequest {
            key: key.into(),
            branch_id: source.branch_id.clone(),
            through_id: db.head(&source.branch_id).unwrap().unwrap(),
            expected_revision: db
                .active_context(&source.branch_id)
                .unwrap()
                .map_or(0, |value| value.revision),
            owner_run_id: None,
            personalization: None,
            compaction: None,
            summary_recipe,
            effective_system_prompt: "Continue".into(),
            instruction_sources: vec![],
            memory_checkpoint: None,
        };
        let job = db
            .create_context_job(request, launch, source.configuration)
            .unwrap();
        let selected = db.capture_launch(&job.receipt.run_id).unwrap().unwrap();
        let execution = db.capture_context_job(&job.receipt.run_id).unwrap();
        (job, selected, execution)
    };
    let mut start = text_compaction_start(&selected.load().unwrap().selection);
    start.provider = Arc::new(EmptyRetainSummary);
    let start = configure_compaction_start(start, execution.load_execution().unwrap());
    let report = supervisor
        .start(&job.receipt.run_id, start)
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(report.state, RunState::Completed, "{:?}", report.failure);
    let publication = owner
        .lock()
        .unwrap()
        .prepare_context_job_publication(&job.receipt.run_id)
        .unwrap();
    let prepared = publication.load().unwrap();
    let checkpoint = owner
        .lock()
        .unwrap()
        .publish_prepared_context_job(prepared)
        .unwrap();
    checkpoint
}

#[test]
fn real_compaction_keeps_the_latest_same_branch_observation_and_charges_its_tokens() {
    let mut f = fixture::Fixture::new();
    let child = f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let first = observe(&mut f.db, &run).remove(0);
    let revision = f.db.inspect_thread(&child.child_thread_id).unwrap()["revision"]
        .as_u64()
        .unwrap();
    f.db.update_thread(&threads::ThreadUpdate {
        thread_id: child.child_thread_id,
        key: "new-state-before-summary".into(),
        expected_revision: revision,
        title: Some("Latest coordinated task".into()),
        title_mode: None,
        pinned: None,
        archived: None,
    })
    .unwrap();
    let latest = observe(&mut f.db, &run).remove(0);
    let configuration = f.db.run(&run).unwrap().configuration;
    let launch = f.db.launch_intent(&run).unwrap().unwrap().selection;
    f.db.fork_branch("branch:parent", "summary-fork", Some(&latest.id))
        .unwrap();
    let fork =
        f.db.submit(&SubmitInput {
            key: "summary-fork-input".into(),
            thread_id: "thread:parent".into(),
            branch_id: "summary-fork".into(),
            expected_head: Some(latest.id.clone()),
            input: json!("continue separately"),
            configuration: configuration.clone(),
        })
        .unwrap();
    let supervisor = crate::supervisor::RunSupervisor::new(f.db);
    let checkpoint = compact(&supervisor, &run, "compact-coordination", launch.clone());
    let retained = checkpoint.retained.as_ref().unwrap();
    let owner = supervisor.catalog();
    let content = owner.lock().unwrap().content.clone();
    let selected = content.load_items(&retained.items, &|| false).unwrap();
    assert_eq!(
        selected,
        vec![latest.clone()],
        "empty model selection still keeps the latest full observation"
    );
    assert!(!selected.iter().any(|item| item.id == first.id));
    let counter = crate::token_count::TokenCounter::for_configuration(&configuration);
    assert_eq!(
        retained.estimated_tokens,
        counter.count(&checkpoint.proposal.summary) + counter.item(&latest)
    );
    assert_eq!(retained.budget_tokens, Some(4096));
    assert!(
        observe(&mut owner.lock().unwrap(), &run).is_empty(),
        "the published retained original is the deduplication baseline"
    );

    let foreign = compact(
        &supervisor,
        &fork.run_id,
        "compact-foreign-scope",
        launch.clone(),
    );
    let foreign_items = content
        .load_items(&foreign.retained.unwrap().items, &|| false)
        .unwrap();
    assert!(
        foreign_items.is_empty(),
        "a fork does not adopt the parent's observation as its own current state"
    );
    let own = observe(&mut owner.lock().unwrap(), &fork.run_id).remove(0);
    let checkpoint = compact(&supervisor, &fork.run_id, "compact-fork-scope", launch);
    let selected = content
        .load_items(&checkpoint.retained.unwrap().items, &|| false)
        .unwrap();
    assert_eq!(selected, vec![own]);
    supervisor.shutdown().unwrap();
}

#[test]
fn actual_child_context_inheritance_excludes_parent_collaboration_observations() {
    let mut f = fixture::Fixture::new();
    f.accept();
    f.settle_exchange();
    let run = f.context.run_id.clone();
    let parent_observation = observe(&mut f.db, &run).remove(0);
    f.input.inherit_context = true;
    let call = crate::execution::ToolCall {
        call_id: "inherit-after-observation".into(),
        name: "dispatch".into(),
        schema_version: "1".into(),
        arguments: serde_json::to_value(&f.input).unwrap(),
    };
    let context = f.admit_policy_call(call);
    let child =
        f.db.accept_child(&context, f.input.clone(), f.pin.clone(), f.launch.clone())
            .unwrap();
    let retained = child.inherited_context.unwrap();
    let inherited = f.db.content.load_items(&retained.items, &|| false).unwrap();
    assert!(
        !inherited.is_empty(),
        "ordinary conversation background is still inherited"
    );
    assert!(!inherited.iter().any(
        |item| item.id == parent_observation.id || family::CollaborationSnapshot::is_item(item)
    ));
}
