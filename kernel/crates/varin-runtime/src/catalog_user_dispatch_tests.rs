//! Real Catalog handoff admission without a synthetic model request or tool call.
use super::user_dispatch::*;
use super::*;
use crate::test_submission::InputAdmission;

pub(super) struct Fixture {
    root: std::path::PathBuf,
    pub(super) db: Catalog,
    command: UserChildDispatchCommand,
    launch: launches::LaunchSelection,
}
impl Fixture {
    fn new() -> Self {
        Self::with_options(false)
    }
    pub(super) fn new_in_bot() -> Self {
        Self::with_options(true)
    }
    fn with_options(bot: bool) -> Self {
        let root = std::env::temp_dir().join(format!("varin-user-dispatch-{}", id()));
        let mut db = Catalog::open(&root).unwrap();
        if bot {
            db.publish_bot_gate(bot::BotGate {
                bot_id: "bot".into(),
                profile_revision: 1,
                activity_operation_id: Some("sleep".into()),
                permitted: true,
            })
            .unwrap();
            db.create_bot_thread("parent", "main", "bot").unwrap();
        } else {
            db.create_thread("parent", "main").unwrap();
        }
        let configuration:ModelSessionConfiguration=serde_json::from_value(json!({"providerId":"channel","providerFamily":"openai-responses","model":"parent","catalogModelId":"parent","endpoint":"https://example.invalid/responses","allowAnonymous":true,"configurationGeneration":1,"maxOutputTokens":100,"thinkingLevel":"low"})).unwrap();
        let receipt = db
            .submit(&SubmitInput {
                key: "input".into(),
                thread_id: "parent".into(),
                branch_id: "main".into(),
                expected_head: None,
                input: json!({"text":"Only this selected context"}),
                configuration: json!(configuration),
            })
            .unwrap();
        let model = dispatch::ChildModelBinding {
            configuration: configuration.clone(),
            credential_scope: None,
        };
        let bound = crate::model_session::bind(configuration).unwrap();
        let mut binding = bound.binding;
        binding.tool_schema_generation = 1;
        let mut launch =
            launches::LaunchSelection::from_binding(&binding, bound.policy.identity(), None);
        launch.child_dispatch=Some(serde_json::from_value(json!({"identity":"original","projects":[{"id":"registered","name":"Original project","path":"/original/project","resource_owner":{"kind":"local"}}],"presets":[],"normal_unavailable":null,"native_capabilities":[],"model_selection_preparation":true})).unwrap());
        db.bind_launch(&receipt.run_id, launch.clone()).unwrap();
        let prepared = db
            .prepare_child_dispatch_binding(&receipt.run_id, model, 1, binding.tools.clone())
            .unwrap()
            .load()
            .unwrap();
        db.bind_child_dispatch(&receipt.run_id, prepared).unwrap();
        let run = db.run(&receipt.run_id).unwrap();
        db.transition_run(&run.id, db.epoch(), run.revision, RunState::Runnable)
            .unwrap();
        let command=UserChildDispatchCommand {key:"handoff".into(),thread_id:"parent".into(),branch_id:"main".into(),run_id:receipt.run_id,expected_head:Some(receipt.input_id),input:serde_json::from_value(json!({"task":"Edited instructions","model":"chosen","thinking":"low","workMode":"shared"})).unwrap()};
        Self {
            root,
            db,
            command,
            launch,
        }
    }
    fn prepare(
        &self,
        command: UserChildDispatchCommand,
    ) -> Result<child_content::PreparedChildAdmission> {
        let selected = self.db.capture_user_child_dispatch(command)?.load()?;
        let resolved = selected.selection.resolve(&selected.input)?;
        let launch = self
            .db
            .prepare_child_launch(
                &selected.retention_identity().1,
                self.launch.clone(),
                resolved,
            )?
            .load()?;
        selected.prepare(launch)
    }
    pub(super) fn accept(&mut self) -> collaboration::ChildTask {
        let prepared = self.prepare(self.command.clone()).unwrap();
        self.db.accept_child_references(prepared).unwrap()
    }
    fn reopen(&mut self) {
        let placeholder = self.root.with_extension("reopen");
        let old = std::mem::replace(&mut self.db, Catalog::open(&placeholder).unwrap());
        drop(old);
        self.db = Catalog::open(&self.root).unwrap();
        std::fs::remove_dir_all(placeholder).unwrap();
    }
    fn counts(&self) -> (i64, i64, i64) {
        self.db.db.query_row("SELECT (SELECT count(*) FROM threads),(SELECT count(*) FROM operations),(SELECT count(*) FROM child_tasks)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn prepare_model(db: &mut Catalog, child: &collaboration::ChildTask) {
    let owner = ExecutorOwner::External {
        identity: "original-model-owner".into(),
        epoch: "host".into(),
    };
    let catalog=serde_json::from_value(json!({"candidates":[{"id":"chosen","providerId":"channel","modelId":"chosen","configurationFingerprint":"chosen-v1","thinkingLevels":["low"],"defaultThinkingLevel":"low","input":["text"]}],"selector":null})).unwrap();
    let p = db
        .capture_delegation_model(delegation_model::PrepareParams {
            execution_id: child.execution_id.clone(),
            execution_owner: owner.clone(),
            catalog: Some(catalog),
        })
        .unwrap()
        .load()
        .unwrap();
    let selection = db.admit_delegation_model(p, owner.clone()).unwrap();
    let recipe = db
        .read_delegation_model(&selection)
        .unwrap()
        .load()
        .unwrap();
    assert!(recipe.recipe.messages.is_empty());
    assert_eq!(recipe.recipe.choices.len(), 1);
    let mut configuration: ModelSessionConfiguration =
        serde_json::from_value(db.content.load(&child.configuration_ref).unwrap()).unwrap();
    configuration.model = "chosen".into();
    configuration.catalog_model_id = Some("chosen".into());
    let p = db
        .prepare_delegation_model_commit(delegation_model::CommitParams {
            execution_id: child.execution_id.clone(),
            execution_owner: owner,
            choice: delegation_model::Choice {
                model: "chosen".into(),
                thinking: "low".into(),
            },
            binding: dispatch::ChildModelBinding {
                configuration,
                credential_scope: None,
            },
        })
        .unwrap()
        .load()
        .unwrap();
    db.commit_delegation_model(p).unwrap();
}
pub(super) fn start_child(
    db: &mut Catalog,
    child: collaboration::ChildTask,
) -> collaboration::ChildTask {
    prepare_model(db, &child);
    let proposal = context::ContextProposal {
        key: "child-context".into(),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Frozen worker instructions".into(),
        instruction_sources: vec![],
        memory_checkpoint: None,
    };
    let basis=serde_json::from_value(json!({"mode":if db.bot_for_thread(&child.child_thread_id).unwrap().is_some(){"bot"}else{"agent"},"threadRole":"worker","revision":1,"configurationDigest":"original-worker","memorySnapshot":{"revision":0,"memories":[]},"threadId":child.child_thread_id,"projectId":null,"originalSections":[{"name":"system","content":"Frozen worker instructions"}],"instructionSources":[]})).unwrap();
    let prepared = db
        .capture_child_preparation(&child.execution_id, None, proposal, basis)
        .unwrap()
        .load()
        .unwrap();
    let child = db.admit_child(prepared).unwrap();
    child
}

#[test]
fn user_handoff_is_atomic_truthful_and_preserves_exact_receipt_after_reopen() {
    let mut f = Fixture::new();
    let original_count = f.counts();
    let prepared = f.prepare(f.command.clone()).unwrap();
    drop(prepared); // Closing/cancelling the form never admits an empty task.
    assert_eq!(f.counts(), original_count);
    let duplicate = f.prepare(f.command.clone()).unwrap();
    let child = f.accept();
    assert_eq!(child.name, format!("Agent {}", child.agent_id));
    assert_eq!(child.origin, None);
    assert_eq!(child.call_id, None);
    assert_eq!(child.parent_thread_id, "parent");
    assert_eq!(child.parent_branch_id, "main");
    assert!(matches!(child.source, collaboration::ChildSource::Absent));
    let op = f.db.operation(&child.operation_id).unwrap();
    assert_eq!(op.intent["actor"], json!({"kind":"user"}));
    assert!(op.call_completion.is_none());
    assert_eq!(
        f.db.db
            .query_row("SELECT count(*) FROM model_steps", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        f.db.accept_child_references(duplicate)
            .unwrap()
            .operation_id,
        child.operation_id
    );
    let receipt =
        f.db.user_child_dispatch_receipt(&f.command)
            .unwrap()
            .unwrap();
    assert_eq!(receipt.actor, messages::MessageActor::User);
    assert_eq!(receipt.accepted_cursor, child.cursor);
    let mut changed = f.command.clone();
    changed.input.task = "different instructions".into();
    assert!(f.db.user_child_dispatch_receipt(&changed).is_err());
    assert_eq!(f.counts().0, original_count.0 + 1);
    assert_eq!(f.counts().2, 1);
    let report = f.db.prepare_content_collection(Default::default()).run();
    assert_eq!(
        report.status,
        ContentCollectionStatus::Completed,
        "{report:?}"
    );
    f.reopen();
    let reopened = &f.db;
    assert_eq!(
        reopened.user_child_dispatch_receipt(&f.command).unwrap(),
        Some(receipt)
    );
    assert_eq!(
        reopened.operation(&child.operation_id).unwrap().epoch,
        op.epoch
    );
    assert_eq!(
        reopened.content.load(&op.intent["commandRef"]).unwrap(),
        json!(f.command)
    );
}
#[test]
fn user_handoff_can_start_after_parent_completion_with_user_history_and_selected_background_only() {
    let mut f = Fixture::new();
    f.command.input.background = vec![background::BackgroundReference {
        thread_id: "parent".into(),
        branch_id: "main".into(),
        head_id: f.command.expected_head.clone().unwrap(),
        item_ids: vec![f.command.expected_head.clone().unwrap()],
    }];
    let run = f.db.run(&f.command.run_id).unwrap();
    f.db.transition_run(&run.id, f.db.epoch(), run.revision, RunState::Completed)
        .unwrap();
    let child = f.accept();
    assert!(child.inherited_context.is_some());
    let child = start_child(&mut f.db, child);
    let history = f.db.history(&child.child_branch_id).unwrap();
    let input = history
        .iter()
        .find(|item| item.id.starts_with("child-input:"))
        .unwrap();
    assert_eq!(input.source, HistorySource::User);
    assert!(input.content.to_string().contains("Edited instructions"));
    assert!(!input.content.to_string().contains("other_agent"));
    assert_eq!(
        f.db.run(&child.receipt.unwrap().run_id).unwrap().thread_id,
        child.child_thread_id
    );
}
#[test]
fn stale_head_run_source_or_foreign_background_never_create_a_child() {
    let mut f = Fixture::new();
    let original = f.counts();
    let mut wrong = f.command.clone();
    wrong.expected_head = None;
    assert!(f.prepare(wrong).is_err());
    let mut wrong = f.command.clone();
    wrong.run_id = "another-run".into();
    assert!(f.prepare(wrong).is_err());
    let mut wrong = f.command.clone();
    wrong.input.project_id = Some("not-in-original-catalog".into());
    assert!(f.prepare(wrong).is_err());
    f.db.create_thread("foreign", "foreign-branch").unwrap();
    let mut wrong = f.command.clone();
    wrong.input.background = vec![background::BackgroundReference {
        thread_id: "foreign".into(),
        branch_id: "foreign-branch".into(),
        head_id: "foreign-head".into(),
        item_ids: vec!["foreign-item".into()],
    }];
    assert!(f.prepare(wrong).is_err());
    let prepared = f.prepare(f.command.clone()).unwrap();
    f.db.append_history(
        &f.command.run_id,
        f.db.epoch(),
        f.command.expected_head.as_deref(),
        HistorySource::User,
        json!({"text":"new explicit request"}),
        None,
    )
    .unwrap();
    assert!(f.db.accept_child_references(prepared).is_err());
    assert_eq!(f.counts(), (original.0 + 1, original.1, original.2));
}
#[test]
fn explicit_project_uses_original_catalog_and_failure_and_cancellation_settle_user_operation() {
    let mut f = Fixture::new();
    f.command.input.project_id = Some("registered".into());
    f.command.input.work_mode = Some(dispatch::ChildWorkMode::IsolatedWrite);
    let child = f.accept();
    match child.source {
        collaboration::ChildSource::Project { project, .. } => {
            assert_eq!(project.path, "/original/project")
        }
        _ => panic!("explicit project lost"),
    }
    f.db.fail_delegated_preparation(
        &child.execution_id,
        "original-source-unavailable",
        Some("Original Host offline"),
    )
    .unwrap();
    assert_eq!(
        f.db.operation(&child.operation_id).unwrap().outcome,
        Some(Outcome::Failed)
    );
    f.command.key = "cancelled-child".into();
    f.command.input.project_id = None;
    f.command.input.work_mode = Some(dispatch::ChildWorkMode::Shared);
    let child = f.accept();
    f.db.cancel_child(&child.operation_id).unwrap();
    assert_eq!(
        f.db.operation(&child.operation_id).unwrap().outcome,
        Some(Outcome::Cancelled)
    );
    assert!(
        f.db.operation(&child.operation_id)
            .unwrap()
            .call_completion
            .is_none()
    );
}
#[test]
fn prepared_attachments_are_exact_and_publish_with_user_child() {
    let mut f = Fixture::new();
    f.command.input.attachments =
        serde_json::from_value(json!([{"ref":"attachment:original"}])).unwrap();
    let selected =
        f.db.capture_user_child_dispatch(f.command.clone())
            .unwrap()
            .load()
            .unwrap();
    assert!(selected.with_attachments(Vec::new(), Vec::new()).is_err());
    assert_eq!(f.counts().2, 0);
    let files:Vec<attachments::Attachment>=serde_json::from_value(json!([{"ref":"attachment:original","filename":"notes.txt","mimeType":"text/plain","byteLength":5}])).unwrap();
    let selected =
        f.db.capture_user_child_dispatch(f.command.clone())
            .unwrap()
            .load()
            .unwrap()
            .with_attachments(files.clone(), Vec::new())
            .unwrap();
    let resolved = selected
        .selection
        .resolve_with_attachments(&selected.input, &selected.attachments)
        .unwrap();
    let launch =
        f.db.prepare_child_launch(&f.command.run_id, f.launch.clone(), resolved)
            .unwrap()
            .load()
            .unwrap();
    let child =
        f.db.accept_child_references(selected.prepare(launch).unwrap())
            .unwrap();
    let delivery =
        f.db.attachment_delivery("dispatch", &child.operation_id)
            .unwrap()
            .unwrap();
    assert_eq!(delivery.thread_id, child.child_thread_id);
    assert_eq!(delivery.attachments, files);
    let history =
        f.db.content
            .load_history_payload(delivery.input_ref.as_ref().unwrap())
            .unwrap()
            .0;
    assert_eq!(history["text"], "Edited instructions");
    assert_eq!(history["fileAttachments"][0]["ref"], "attachment:original");
}

#[test]
fn user_dispatch_cuts_parent_goal_inheritance_and_late_adoption() {
    use goals::{GoalBoundary, GoalBudget, GoalControlAction, GoalScope};
    for action in [
        Some(GoalControlAction::Complete),
        Some(GoalControlAction::Cancel),
        Some(GoalControlAction::Pause),
        None,
    ] {
        let mut f = Fixture::new();
        let scope = GoalScope {
            thread_id: "parent".into(),
            branch_id: "main".into(),
        };
        let prepared =
            f.db.prepare_goal_start(
                "old-goal",
                &f.command.run_id,
                scope.clone(),
                "Old parent duty".into(),
                action.is_none().then_some(GoalBudget {
                    max_output_tokens: 0,
                }),
            )
            .unwrap()
            .load()
            .unwrap();
        let goal = f.db.admit_goal_mutation(prepared).unwrap();
        if let Some(action) = action {
            f.db.control_goal(&goal.id, goal.revision, &scope, action)
                .unwrap();
        }
        let child = f.accept();
        let child = start_child(&mut f.db, child);
        let run = child.receipt.as_ref().unwrap().run_id.clone();
        assert_eq!(f.db.goal_binding(&run).unwrap(), None);
        assert!(matches!(
            f.db.goal_boundary(&run, f.db.epoch()).unwrap(),
            GoalBoundary::Continue
        ));
        assert_eq!(
            f.db.db
                .query_row(
                    "SELECT count(*) FROM goal_children WHERE id=?1",
                    [&child.operation_id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        let goal = f.db.capture_goal(&goal.id).unwrap().load().unwrap();
        if !matches!(
            action,
            Some(GoalControlAction::Complete | GoalControlAction::Cancel)
        ) {
            f.db.control_goal(&goal.id, goal.revision, &scope, GoalControlAction::Complete)
                .unwrap();
        }
        let prepared =
            f.db.prepare_goal_start(
                "later-goal",
                &f.command.run_id,
                scope,
                "Later parent duty".into(),
                None,
            )
            .unwrap()
            .load()
            .unwrap();
        f.db.admit_goal_mutation(prepared).unwrap();
        assert_eq!(f.db.goal_binding(&run).unwrap(), None);
        assert_eq!(
            f.db.db
                .query_row(
                    "SELECT count(*) FROM goal_children WHERE id=?1",
                    [&child.operation_id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}

fn managed_mcp() -> launches::HostToolBinding {
    serde_json::from_value(json!({
        "reference":"original-mcp","generation":1,
        "tools":[{"name":"original_query","version":"1","description":"Original tool","schema":{"type":"object"},"requirements":null,"output_schema":null,"metadata":null}],
        "routes":{"original_query":{"kind":"direct"}},"resources":{"original_query":"original-resource","server:original":"original-resource"},
        "provenance":{"servers":{"original":{
            "owner":{"resource_owner":{"kind":"managed_host","hostId":"original-host","connectionId":"original-connection","endpointIdentity":"original-endpoint"},
            "source_authority":{"coordinator_host_id":"coordinator","authority_id":"original-authority","resource_epoch":"source-epoch"},
            "configuration":{"agent_dir":"/original","config_cwd":"/original","project_trusted":false},"execution_scope":"workspace"},
            "definition_version":"configuration","resource_key":"original-resource"}}}
    })).unwrap()
}
#[test]
fn lost_retain_ack_and_failed_release_preserve_exact_cleanup_without_an_empty_child() {
    for crashed in [false, true] {
        let mut f = Fixture::new();
        let mut prepared = f.prepare(f.command.clone()).unwrap();
        // Inject the frozen dependency output at the original preparation boundary; current
        // source-less/project selectors may narrow away the parent workspace MCP.
        if let child_content::ChildAdmissionOrigin::User(user) = &mut prepared.origin {
            user.dependencies_ref =
                f.db.content
                    .save(&serde_json::to_value(managed_mcp()).unwrap())
                    .unwrap();
        }
        let operation = match &prepared.origin {
            child_content::ChildAdmissionOrigin::User(user) => user.operation_id.clone(),
            _ => unreachable!(),
        };
        let original_epoch = f.db.epoch();
        let original = f.counts();
        f.db.stage_user_child_dependencies(&prepared).unwrap();
        // Remote retain succeeded, but ACK and compensating release both failed. There is
        // no handle to drop. The original Catalog duty remains authoritative across reopen.
        assert_eq!(f.counts(), (original.0, original.1 + 1, original.2));
        assert!(
            f.db.user_child_dispatch_receipt(&f.command)
                .unwrap()
                .is_none()
        );
        assert!(
            f.db.capture_unaccepted_child_dependencies()
                .unwrap()
                .load()
                .unwrap()
                .is_empty()
        );
        if !crashed {
            f.db.abort_user_child_dependencies(&f.command, false)
                .unwrap();
        }
        drop(prepared);
        f.reopen();
        let pending =
            f.db.capture_unaccepted_child_dependencies()
                .unwrap()
                .load()
                .unwrap();
        assert_eq!(pending.len(), 1);
        let dependency = &pending[0];
        assert_eq!(dependency.operation_id, operation);
        assert_eq!(dependency.execution_epoch, original_epoch);
        assert_eq!(dependency.execution_owner, ExecutorOwner::Kernel);
        assert_eq!(
            dependency.mcp_binding.as_ref().unwrap().provenance,
            managed_mcp().provenance
        );
        let retry = f.prepare(f.command.clone()).unwrap();
        assert!(f.db.stage_user_child_dependencies(&retry).is_err());
        assert!(f.db.accept_child_references(retry).is_err());
        // Only the exact original release acknowledgement settles the durable duty.
        assert_eq!(
            f.db.capture_unaccepted_child_dependencies()
                .unwrap()
                .load()
                .unwrap(),
            pending
        );
        f.db.mark_unaccepted_child_dependencies_released(&operation)
            .unwrap();
        assert!(
            f.db.capture_unaccepted_child_dependencies()
                .unwrap()
                .load()
                .unwrap()
                .is_empty()
        );
        let retry = f.prepare(f.command.clone()).unwrap();
        assert!(f.db.stage_user_child_dependencies(&retry).is_err());
        assert_eq!(f.counts(), (original.0, original.1 + 1, original.2));
    }
}
#[test]
fn staged_dependencies_transition_to_the_original_admitted_child_once() {
    let mut f = Fixture::new();
    let prepared = f.prepare(f.command.clone()).unwrap();
    f.db.stage_user_child_dependencies(&prepared).unwrap();
    let child = f.db.accept_child_references(prepared).unwrap();
    let receipt =
        f.db.user_child_dispatch_receipt(&f.command)
            .unwrap()
            .unwrap();
    assert_eq!(receipt.operation_id, child.operation_id);
    assert_eq!(f.accept().operation_id, child.operation_id);
    f.db.abort_user_child_dependencies(&f.command, true)
        .unwrap();
    assert!(
        f.db.capture_unaccepted_child_dependencies()
            .unwrap()
            .load()
            .unwrap()
            .is_empty()
    );
    assert_ne!(
        f.db.operation(&child.operation_id).unwrap().phase,
        OperationPhase::Terminal
    );
}

#[test]
fn staging_cancellation_is_atomic_for_operation_and_parent_tree() {
    for whole_tree in [false, true] {
        let mut f = Fixture::new();
        let mut prepared = f.prepare(f.command.clone()).unwrap();
        if let child_content::ChildAdmissionOrigin::User(user)=&mut prepared.origin {
            user.dependencies_ref=f.db.content.save(&serde_json::to_value(managed_mcp()).unwrap()).unwrap();
        }
        f.db.stage_user_child_dependencies(&prepared).unwrap();
        let operation = match &prepared.origin {
            child_content::ChildAdmissionOrigin::User(user) => user.operation_id.clone(),
            _ => unreachable!(),
        };
        let target = if whole_tree {
            dispatch::TreeCancelTarget::Thread {
                thread_id: f.command.thread_id.clone(),
            }
        } else {
            dispatch::TreeCancelTarget::Child {
                operation_id: operation.clone(),
            }
        };
        let result = f.db.cancel_tree(target).unwrap();
        assert_eq!(result.receipt.child_count, 0);
        assert!(f.db.operation(&operation).unwrap().cancel_requested);
        assert_eq!(
            f.db.operation(&operation).unwrap().outcome,
            Some(Outcome::Cancelled)
        );
        let pending=f.db.capture_unaccepted_child_dependencies().unwrap().load().unwrap();
        assert_eq!(pending.len(),1);assert_eq!(pending[0].execution_epoch,f.db.epoch());
        assert_eq!(pending[0].operation_id,operation);
        assert_eq!(pending[0].mcp_binding.as_ref().unwrap().provenance,managed_mcp().provenance);
        assert!(f.db.accept_child_references(prepared).is_err());
        assert!(
            f.db.user_child_dispatch_receipt(&f.command)
                .unwrap()
                .is_none()
        );
        f.db.abort_user_child_dependencies(&f.command, false)
            .unwrap();
        assert_eq!(
            f.db.operation(&operation).unwrap().outcome,
            Some(Outcome::Cancelled)
        );
        assert_eq!(f.counts().2, 0);
    }
}

#[test]
fn ui_retention_includes_dispatch_and_selected_inherited_context() {
    let mut f = Fixture::new();
    let run = f.db.run(&f.command.run_id).unwrap();
    let inherited = f.db.append_history(&run.id, f.db.epoch(), f.command.expected_head.as_deref(), HistorySource::Assistant,
        json!({"id":"ui-inherited","provenance":{"kind":"assistant"},"content":{"kind":"text","text":"ui:inherited@4 ui-snapshot:background"},"opaque":null}), None).unwrap();
    f.command.expected_head = Some(inherited.id.clone());
    f.command.input.task = "Read ui-selection:dispatch and update ui:dispatch@2".into();
    f.command.input.background = vec![background::BackgroundReference {
        thread_id: "parent".into(), branch_id: "main".into(), head_id: inherited.id.clone(), item_ids: vec![inherited.id],
    }];
    let child = f.accept();
    assert!(child.inherited_context.is_some());
    let retained = f.db.capture_material_retention(None, &[], true).unwrap().load().unwrap().ui_references.unwrap();
    for reference in ["ui:inherited@4", "ui-snapshot:background", "ui-selection:dispatch", "ui:dispatch@2"] {
        assert!(retained.iter().any(|value| value == reference), "missing {reference}: {retained:?}");
    }
}

#[test]
fn copied_background_keeps_typed_references_after_the_source_conversation_is_retired() {
    use crate::catalog::model_references::ReferenceKind;
    use crate::execution::{Content, ConversationItem, Provenance, ToolCompletion, ToolResult};
    use crate::output::OutputBody;
    let mut f = Fixture::new_in_bot();
    f.db.create_thread("background-source", "background-source-main").unwrap();
    let original = f.db.submit(&SubmitInput {
        key: "background-source-input".into(), thread_id: "background-source".into(),
        branch_id: "background-source-main".into(), expected_head: None,
        input: json!({"text":"Read the original file"}), configuration: json!({}),
    }).unwrap();
    let target = json!({"kind":"observation","path":"original.txt","readVersion":"original-version","source":{"originalOwner":"source-b"}});
    let reference = f.db.register_model_reference(ReferenceKind::File,"original-storage-owner",&target,&original.run_id).unwrap();
    let unrelated = f.db.register_model_reference(ReferenceKind::File,"unpublished-owner",&json!({"path":"not-in-background"}),"unpublished").unwrap();
    let output: OutputBody = OutputBody {
        data: json!({"readVersion":"private-read-state","source":{"rootId":"private-root"},"text":"File contents"}),
        model_data: Some(json!({"ref":reference,"path":"original.txt","text":"File contents; literal file:999999 is ordinary prose"})),
        parts: Vec::new(),
    };
    let result = ConversationItem { resource_activation: None, id:"original-file-read".into(),
        provenance: Provenance::ToolData {call_id:"read".into()}, opaque: None,
        content: Content::ToolResult {result: ToolResult {request_id:"original-request".into(),call_id:"read".into(),
            completion:ToolCompletion::Result {outcome:Outcome::Succeeded,effect:Effect::None,content:output.clone()}}},
    };
    let source_item = f.db.append_history(&original.run_id,f.db.epoch(),Some(&original.input_id),HistorySource::Tool,json!(result),None).unwrap();
    f.command.input.background = vec![background::BackgroundReference {
        thread_id:"background-source".into(),branch_id:"background-source-main".into(),
        head_id:source_item.id.clone(),item_ids:vec![source_item.id.clone()],
    }];
    let child = f.accept();
    let copied = f.db.content.load_items(&child.inherited_context.as_ref().unwrap().items,&||false).unwrap();
    let Content::Output {output: quoted} = &copied[0].content else {panic!("selected result must remain quoted source data")};
    assert_eq!(quoted.data["quotedHistory"]["result"]["completion"]["content"],json!(output));
    let shown = quoted.model_data.as_ref().expect("quoted owner projection");
    assert_eq!(shown["quotedHistory"]["result"]["completion"]["content"]["data"]["ref"],reference);
    assert!(!shown.to_string().contains("private-read-state"));
    assert!(shown.to_string().contains("literal file:999999 is ordinary prose"));
    assert!(matches!(copied[0].provenance,Provenance::ExternalData{..}));
    let source_run = f.db.run(&original.run_id).unwrap();
    let source_run = f.db.transition_run(&source_run.id,f.db.epoch(),source_run.revision,RunState::Runnable).unwrap();
    f.db.transition_run(&source_run.id,f.db.epoch(),source_run.revision,RunState::Completed).unwrap();
    f.db.delete_thread(&threads::ThreadDelete {thread_id:"background-source".into(),key:"delete-background-source".into(),
        expected_revision:f.db.inspect_thread("background-source").unwrap()["revision"].as_u64().unwrap()}).unwrap();
    assert!(f.db.retire_deleted_threads(&[original.run_id.clone()]).unwrap().0>0);
    assert!(matches!(f.db.run(&original.run_id),Err(RuntimeError::NotFound(_))),"copied references must not pin the source Run or its assets");
    assert_eq!(f.db.resolve_model_reference(ReferenceKind::File,&reference).unwrap().target,target);
    assert!(f.db.resolve_model_reference(ReferenceKind::File,&unrelated).is_err(),"unpublished references are not retained by scanning body strings");
    f.reopen();
    let child = f.db.child_task(&child.operation_id).unwrap();
    let reopened = f.db.content.load_items(&child.inherited_context.unwrap().items,&||false).unwrap();
    assert_eq!(copied,reopened);
    assert_eq!(f.db.resolve_model_reference(ReferenceKind::File,&reference).unwrap().target,target);
    assert!(f.db.resolve_model_reference(ReferenceKind::File,"file:999999").is_err());
}
