//! Explicit User handoff admission. This is not a tool invocation: it has no call ID,
//! model origin or invented parent Run. The original child pipeline owns everything
//! after the atomic operation/relation/receipt commit.
use super::child_content::{ChildAdmissionOrigin, PreparedChildAdmission};
use super::dispatch::{
    ChildDispatchRead, ChildDispatchSelection, ChildProjectSource, DispatchInput,
};
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserChildDispatchCommand {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
    pub expected_head: Option<String>,
    pub input: DispatchInput,
}
/// Prepared descriptors/media come only from the authenticated material owner. They
/// are excluded from the immutable caller command, so exact retries never reselect files.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserChildDispatchAcceptParams {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
    pub expected_head: Option<String>,
    pub input: DispatchInput,
    #[serde(default)]
    pub prepared_attachments: Vec<attachments::Attachment>,
    #[serde(default)]
    pub prepared_attachment_media: Vec<crate::output::IncomingMedia>,
}
impl UserChildDispatchAcceptParams {
    pub fn into_parts(
        self,
    ) -> (
        UserChildDispatchCommand,
        Vec<attachments::Attachment>,
        Vec<crate::output::IncomingMedia>,
    ) {
        (
            UserChildDispatchCommand {
                key: self.key,
                thread_id: self.thread_id,
                branch_id: self.branch_id,
                run_id: self.run_id,
                expected_head: self.expected_head,
                input: self.input,
            },
            self.prepared_attachments,
            self.prepared_attachment_media,
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserChildDispatchReceipt {
    pub operation_id: String,
    pub execution_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub actor: messages::MessageActor,
    pub accepted_cursor: u64,
    pub accepted_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserChildDispatchCatalogParams {
    pub thread_id: String,
    pub branch_id: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserChildDispatchCatalog {
    pub run_id: String,
    pub head_id: Option<String>,
    pub projects: Vec<ChildProjectSource>,
}
pub struct UserChildDispatchCatalogRead {
    run_id: String,
    head_id: Option<String>,
    read: ChildDispatchRead,
}
impl UserChildDispatchCatalogRead {
    pub fn load(self) -> Result<UserChildDispatchCatalog> {
        let selection = self.read.load()?;
        if !selection.catalog.model_selection_preparation {
            return Err(RuntimeError::Invalid(
                "This execution has no delegated model selection; start a new request".into(),
            ));
        }
        Ok(UserChildDispatchCatalog {
            run_id: self.run_id,
            head_id: self.head_id,
            projects: selection.catalog.projects,
        })
    }
}

pub(super) struct UserDispatchAdmission {
    pub command: UserChildDispatchCommand,
    pub operation_id: String,
    pub command_ref: Value,
    pub dispatch_ref: Value,
    pub dependencies_ref: Value,
    pub epoch: u64,
}
pub struct UserChildDispatchPreparation {
    command: UserChildDispatchCommand,
    read: Option<ChildDispatchRead>,
    parent: Run,
    epoch: u64,
    database: std::path::PathBuf,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct UserChildDispatchSelection {
    pub selection: ChildDispatchSelection,
    /// Source-less choices narrow only the original allowed tool directory.
    pub input: DispatchInput,
    pub attachments: Vec<attachments::Attachment>,
    attachment_media: Vec<crate::output::ResolvedMedia>,
    preparation: UserChildDispatchPreparation,
}
impl UserChildDispatchPreparation {
    pub fn load(mut self) -> Result<UserChildDispatchSelection> {
        let selection = self.read.take().expect("captured selection").load()?;
        let mut input = self.command.input.clone();
        if input.project_id.is_none() {
            input.tools = Some(
                selection
                    .frozen
                    .allowed_delegation
                    .iter()
                    .filter(|tool| {
                        selection.source_requirement(&tool.name)
                            == Some(dispatch::ChildSourceRequirement::None)
                    })
                    .map(|tool| tool.name.clone())
                    .collect(),
            );
        }
        Ok(UserChildDispatchSelection {
            selection,
            input,
            attachments: Vec::new(),
            attachment_media: Vec::new(),
            preparation: self,
        })
    }
}
impl UserChildDispatchSelection {
    pub fn with_model_references(mut self, catalog: &Catalog) -> Result<Self> {
        catalog.project_attachments(&mut self.attachments, &self.preparation.parent.id)?;
        Ok(self)
    }
    /// A planned domain identity for retaining original Host dependencies before commit.
    /// It does not create an Operation or impersonate an admitted tool invocation.
    pub fn retention_identity(&self) -> (String, String, u64) {
        (
            operation_id(&self.preparation.command),
            self.preparation.parent.id.clone(),
            self.preparation.epoch,
        )
    }
    pub fn with_attachments(
        mut self,
        files: Vec<attachments::Attachment>,
        media: Vec<crate::output::IncomingMedia>,
    ) -> Result<Self> {
        attachments::validate_prepared(&self.preparation.command.input.attachments, &files)?;
        let images: Vec<_> = files.iter().filter(|file| file.is_direct_image()).collect();
        if images.len() != media.len()
            || images
                .iter()
                .zip(&media)
                .any(|(file, media)| file.mime_type != media.media_type)
        {
            return Err(RuntimeError::Invalid(
                "Every selected image must have its original typed media".into(),
            ));
        }
        let source = crate::output::OutputSource::Conversation {
            provenance: crate::execution::Provenance::UserInstruction {
                input_id: format!("child-input:{}", operation_id(&self.preparation.command)),
            },
        };
        self.attachments = files;
        self.attachment_media = media
            .into_iter()
            .map(|media| crate::output::ResolvedMedia {
                media_type: media.media_type,
                data_base64: media.data_base64,
                source: source.clone(),
            })
            .collect();
        Ok(self)
    }
    pub fn prepare(
        self,
        launch: launch_content::PreparedChildLaunch,
    ) -> Result<PreparedChildAdmission> {
        let p = self.preparation;
        attachments::validate_prepared(&self.input.attachments, &self.attachments)?;
        let resolved = self
            .selection
            .resolve_with_attachments(&self.input, &self.attachments)?;
        if resolved.profile != launch.selected_profile
            || resolved.frozen_reference != launch.frozen_reference
        {
            return Err(RuntimeError::Conflict(
                "User handoff selection changed before preparation".into(),
            ));
        }
        let database = Connection::open_with_flags(
            &p.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let history = background::load(
            &database,
            &p.content,
            &p.parent,
            &p.command.input.background,
        )?;
        let background_reference_ids = background::capture_reference_ids(&database, &p.parent.id, &history)?;
        let inherited_context = if history.is_empty() {
            None
        } else {
            let counter =
                crate::token_count::TokenCounter::for_configuration(&launch.configuration);
            Some(crate::context_retention::RetainedContext {
                estimated_tokens: history.iter().map(|item| counter.item(item)).sum(),
                budget_tokens: None,
                items: p.content.save_items(&history)?,
            })
        };
        let title = p
            .command
            .input
            .name
            .as_deref()
            .map(str::trim)
            .map(str::to_owned);
        let command_ref = p.content.save(&serde_json::to_value(&p.command)?)?;
        let operation_id = operation_id(&p.command);
        let project = self.selection.project(&p.command.input)?;
        let mut selection = launch.selection;
        selection.source = None;
        let attachment_input_ref = if self.attachments.is_empty() {
            None
        } else {
            Some(p.content.save_user_history(
                &format!("child-input:{operation_id}"),
                &attachments::incoming_input(
                    &p.command.input.task,
                    &self.attachments,
                    &self.attachment_media,
                ),
            )?)
        };
        Ok(PreparedChildAdmission {
            model_contract: super::collaboration::ModelContract::default(),
            attachments: self.attachments,
            attachment_input_ref,
            model_selection_required: resolved.profile.model_selection_required,
            project,
            source_path: None,
            background: p.command.input.background.clone(),
            inherited_context,
            background_reference_ids,
            avatar: launch.selected_profile.avatar.clone(),
            source_agent: None,
            input_ref: p.content.save(&serde_json::to_value(&p.command.input)?)?,
            title,
            configuration_ref: p.content.save(&launch.configuration)?,
            launch: launch_content::LaunchSelectionMetadata::stage_child_intent(
                &p.content, selection,
            )?,
            handoff: None,
            work_mode: launch.selected_profile.work_mode,
            selected_profile_ref: p
                .content
                .save(&serde_json::to_value(&launch.selected_profile)?)?,
            frozen_reference: launch.frozen_reference.clone(),
            parent_tools_ref: launch.parent_tools_ref,
            operation_revision: 0,
            call_id: None,
            internal_retrieval: false,
            origin: ChildAdmissionOrigin::User(UserDispatchAdmission {
                command: p.command,
                operation_id,
                command_ref,
                dependencies_ref: p
                    .content
                    .save(&serde_json::to_value(&resolved.mcp_binding)?)?,
                dispatch_ref: launch.frozen_reference,
                epoch: p.epoch,
            }),
            _publication: p.publication,
        })
    }
}
fn operation_id(command: &UserChildDispatchCommand) -> String {
    format!(
        "user-dispatch:{}:{}:{}",
        command.branch_id.len(),
        command.branch_id,
        command.key
    )
}
fn require_owner(db: &Connection, thread: &str, branch: &str) -> Result<()> {
    threads::require_available(db, thread)?;
    threads::require_public(db, thread)?;
    let owner: Option<String> = db
        .query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [branch],
            |row| row.get(0),
        )
        .optional()?;
    if owner.as_deref() != Some(thread) {
        return Err(RuntimeError::Conflict(
            "Handoff branch belongs to another Thread".into(),
        ));
    }
    context_jobs::require_regular_branch(db, branch)
}
fn validate_command(command: &UserChildDispatchCommand) -> Result<()> {
    command.input.validate()?;
    if command.key.trim().is_empty()
        || command.run_id.is_empty()
        || command.input.model.is_none()
        || command.input.preset.is_some()
        || command.input.inherit_context
        || command.input.source_agent.is_some()
        || command.input.source_path.is_some()
        || command.input.tools.is_some()
        || command.input.work_mode.is_none()
    {
        return Err(RuntimeError::Invalid("User handoff requires an explicit model and work mode, with selected project and exact background references".into()));
    }
    Ok(())
}
pub(super) fn existing(
    db: &Connection,
    command: &UserChildDispatchCommand,
) -> Result<Option<UserChildDispatchReceipt>> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT intent,receipt FROM commands WHERE id=?1",
            [operation_id(command)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    row.map(|(intent, receipt)| {
        if serde_json::from_str::<Value>(&intent)?
            != crate::content::ContentStore::reference(&serde_json::to_value(command)?)?
        {
            return Err(RuntimeError::Conflict(
                "User handoff key has different input".into(),
            ));
        }
        serde_json::from_str(&receipt).map_err(Into::into)
    })
    .transpose()
}
fn current_run(db: &Connection, thread: &str, branch: &str) -> Result<Run> {
    require_owner(db, thread, branch)?;
    let run_id: Option<String> = db
        .query_row(
            "SELECT id FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",
            [branch],
            |row| row.get(0),
        )
        .optional()?;
    let run: Run = record(
        db,
        "runs",
        &run_id.ok_or_else(|| {
            RuntimeError::Invalid("Start a conversation before handing off a new task".into())
        })?,
    )?;
    if run.thread_id != thread {
        return Err(RuntimeError::Conflict(
            "Handoff Run belongs to another Thread".into(),
        ));
    }
    Ok(run)
}
impl Catalog {
    pub fn user_child_dispatch_receipt(
        &self,
        command: &UserChildDispatchCommand,
    ) -> Result<Option<UserChildDispatchReceipt>> {
        require_owner(&self.db, &command.thread_id, &command.branch_id)?;
        existing(&self.db, command)
    }
    pub fn capture_user_child_dispatch_catalog(
        &self,
        p: UserChildDispatchCatalogParams,
    ) -> Result<UserChildDispatchCatalogRead> {
        let run = current_run(&self.db, &p.thread_id, &p.branch_id)?;
        let launch = self.launch_metadata(&run.id)?.ok_or_else(|| {
            RuntimeError::Invalid("This conversation has no native execution binding".into())
        })?;
        let reference = launch.dispatch_context_ref.ok_or_else(|| {
            RuntimeError::Invalid("This execution has no child dispatch catalog".into())
        })?;
        Ok(UserChildDispatchCatalogRead {
            run_id: run.id,
            head_id: self.head(&p.branch_id)?,
            read: self.capture_child_dispatch(&reference),
        })
    }
    pub fn capture_user_child_dispatch(
        &self,
        command: UserChildDispatchCommand,
    ) -> Result<UserChildDispatchPreparation> {
        validate_command(&command)?;
        let parent = current_run(&self.db, &command.thread_id, &command.branch_id)?;
        if parent.id != command.run_id || self.head(&command.branch_id)? != command.expected_head {
            return Err(RuntimeError::Conflict(
                "Conversation changed while preparing the handoff; review the current branch"
                    .into(),
            ));
        }
        let launch = self
            .launch_metadata(&parent.id)?
            .ok_or_else(|| RuntimeError::Invalid("Handoff execution binding missing".into()))?;
        let reference = launch
            .dispatch_context_ref
            .ok_or_else(|| RuntimeError::Invalid("Handoff dispatch catalog missing".into()))?;
        Ok(UserChildDispatchPreparation {
            command,
            parent,
            read: Some(self.capture_child_dispatch(&reference)),
            epoch: self.epoch,
            database: self
                .db
                .path()
                .ok_or_else(|| RuntimeError::Invalid("Catalog database missing".into()))?
                .into(),
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
}
pub(super) fn admit_operation(
    tx: &Transaction<'_>,
    user: &UserDispatchAdmission,
    epoch: u64,
) -> Result<Operation> {
    let run = current_run(tx, &user.command.thread_id, &user.command.branch_id)?;
    let head: Option<String> = tx.query_row(
        "SELECT head FROM branches WHERE id=?1",
        [&user.command.branch_id],
        |row| row.get(0),
    )?;
    let launch: launch_content::LaunchMetadata = record(tx, "run_launches", &run.id)?;
    if epoch != user.epoch
        || run.id != user.command.run_id
        || head != user.command.expected_head
        || launch.dispatch_context_ref.as_ref() != Some(&user.dispatch_ref)
    {
        return Err(RuntimeError::Conflict(
            "Handoff target or execution binding changed before admission".into(),
        ));
    }
    if !bot::thread_permitted(tx, &run.thread_id, epoch)? {
        return Err(RuntimeError::BotSuspended);
    }
    if let Some(mut current) = optional_record::<Operation>(tx, "operations", &user.operation_id)? {
        if current.intent["commandRef"] != user.command_ref
            || current.intent["dependenciesRef"] != user.dependencies_ref
            || current.intent["kind"] != "user_child_dispatch_v1"
            || current.epoch != epoch
            || current.phase != OperationPhase::Preparing
            || current.cancel_requested
            || current.handed_off
        {
            return Err(RuntimeError::Conflict(
                "The original handoff attempt ended; confirm a new attempt with a new key".into(),
            ));
        }
        current.handed_off = true;
        current.revision += 1;
        put(tx, "operations", &current.id, &current)?;
        return Ok(current);
    }
    let op = Operation {
        id: user.operation_id.clone(),
        run_id: run.id,
        epoch,
        revision: 1,
        phase: OperationPhase::Preparing,
        outcome: None,
        effect: Effect::None,
        cancel_requested: false,
        lifetime: Lifetime::Thread,
        handed_off: true,
        executor: Some("user_dispatch".into()),
        execution_owner: Some(ExecutorOwner::Kernel),
        waiting_on: None,
        intent: json!({"kind":"user_child_dispatch_v1","actor":{"kind":"user"},"commandRef":user.command_ref,"dependenciesRef":user.dependencies_ref}),
        result: None,
        external_receipt: None,
        call_completion: None,
        host_job: None,
        mcp_resource_subscription: None,
        managed_process: None,
    };
    tx.execute(
        "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
        params![op.id, op.run_id, encode(&op)?],
    )?;
    Ok(op)
}
pub(super) fn publish_receipt(
    tx: &Transaction<'_>,
    user: &UserDispatchAdmission,
    child: &collaboration::ChildTask,
    at: u64,
) -> Result<()> {
    let receipt = UserChildDispatchReceipt {
        operation_id: child.operation_id.clone(),
        execution_id: child.execution_id.clone(),
        thread_id: child.child_thread_id.clone(),
        branch_id: child.child_branch_id.clone(),
        actor: messages::MessageActor::User,
        accepted_cursor: child.cursor,
        accepted_at_ms: at,
    };
    tx.execute(
        "INSERT INTO commands(id,intent,receipt) VALUES(?1,?2,?3)",
        params![
            user.operation_id,
            encode(&user.command_ref)?,
            encode(&receipt)?
        ],
    )?;
    Ok(())
}
pub(super) fn settle_operation(
    db: &Connection,
    execution: &delegated::DelegatedExecution,
) -> Result<()> {
    if execution.execution_id != execution.child_operation_id || execution.report.is_none() {
        return Ok(());
    }
    let relation = delegated::relation(db, &execution.child_operation_id)?;
    if relation.origin.is_some() {
        return Ok(());
    }
    let mut op: Operation = record(db, "operations", &execution.child_operation_id)?;
    if op.intent["kind"] != "user_child_dispatch_v1" {
        return Err(RuntimeError::Conflict(
            "User dispatch operation provenance missing".into(),
        ));
    }
    let report = execution.report.as_ref().expect("terminal report");
    let effect = execution.code_result.effect();
    if op.phase == OperationPhase::Terminal
        && op.outcome == Some(report.outcome)
        && op.effect == effect
    {
        return Ok(());
    }
    op.phase = OperationPhase::Terminal;
    op.outcome = Some(report.outcome);
    op.effect = effect;
    op.revision += 1;
    put(db, "operations", &op.id, &op)?;
    Ok(())
}
/// Nullable tool provenance is legal only for this explicit User-owned domain operation.
pub(super) fn validate_relation(db: &Connection, child: &delegated::ChildRelation) -> Result<()> {
    let op: Operation = record(db, "operations", &child.operation_id)?;
    let valid = match (&child.origin, &child.call_id) {
        (Some(_), Some(call)) => !call.is_empty() && op.intent["kind"] != "user_child_dispatch_v1",
        (None, None) => {
            op.executor.as_deref() == Some("user_dispatch")
                && op.intent["kind"] == "user_child_dispatch_v1"
                && op.intent["actor"] == json!({"kind":"user"})
                && op.call_completion.is_none()
                && op.execution_owner == Some(ExecutorOwner::Kernel)
                && op.run_id == child.parent_run_id
                && op.intent.get("commandRef").is_some_and(Value::is_object)
        }
        _ => false,
    };
    if !valid {
        return Err(RuntimeError::Invalid(
            "malformed User/tool dispatch provenance; user data was preserved".into(),
        ));
    }
    Ok(())
}

impl Catalog {
    /// Durable cleanup duty before external retention. No child Thread, acceptance receipt,
    /// or user task exists yet. A stopped attempt cannot reuse its released dependency token.
    pub fn stage_user_child_dependencies(
        &mut self,
        prepared: &PreparedChildAdmission,
    ) -> Result<()> {
        let ChildAdmissionOrigin::User(user) = &prepared.origin else {
            return Err(RuntimeError::Invalid(
                "User handoff preparation required".into(),
            ));
        };
        let tx = self.db.transaction()?;
        if optional_record::<Operation>(&tx, "operations", &user.operation_id)?.is_some() {
            return Err(RuntimeError::Conflict(
                "This handoff attempt already exists; reconcile it before confirming a new key"
                    .into(),
            ));
        }
        let mut op = admit_operation(&tx, user, self.epoch)?;
        op.handed_off = false;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "child.dependencies_preparing",
            Value::Null,
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn abort_user_child_dependencies(
        &mut self,
        command: &UserChildDispatchCommand,
        cancelled: bool,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let Some(mut op) = optional_record::<Operation>(&tx, "operations", &operation_id(command))?
        else {
            return Ok(());
        };
        if op.intent["commandRef"]
            != crate::content::ContentStore::reference(&serde_json::to_value(command)?)?
        {
            return Err(RuntimeError::Conflict(
                "User handoff cleanup intent changed".into(),
            ));
        }
        let admitted: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM child_tasks WHERE id=?1)",
            [&op.id],
            |r| r.get(0),
        )?;
        if !admitted && op.phase != OperationPhase::Terminal {
            let cancelled = cancelled || op.cancel_requested;
            stop_preparation(
                &tx,
                &mut op,
                if cancelled {
                    Outcome::Cancelled
                } else {
                    Outcome::Failed
                },
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
fn stop_preparation(db: &Transaction<'_>, op: &mut Operation, outcome: Outcome) -> Result<()> {
    op.phase = OperationPhase::Terminal;
    op.outcome = Some(outcome);
    op.revision += 1;
    put(db, "operations", &op.id, op)?;
    event(
        db,
        &op.id,
        op.revision,
        "child.dependencies_cleanup_pending",
        Value::Null,
    )?;
    Ok(())
}
pub(super) fn recover_preparation(db: &Transaction<'_>, op: &mut Operation) -> Result<()> {
    let admitted: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM child_tasks WHERE id=?1)",
        [&op.id],
        |r| r.get(0),
    )?;
    if !admitted && op.phase != OperationPhase::Terminal {
        let outcome = if op.cancel_requested {
            Outcome::Cancelled
        } else {
            Outcome::Indeterminate
        };
        stop_preparation(db, op, outcome)?;
    }
    Ok(())
}

pub(super) fn cancel_preparation(tx: &Transaction<'_>, op: &mut Operation) -> Result<()> {
    if op.intent["kind"] == "user_child_dispatch_v1"
        && !op.handed_off
        && op.phase != OperationPhase::Terminal
    {
        // Exact release writes a tombstone even before a delayed retain arrives. Publish
        // cleanup now so Thread deletion does not wait on an absent child/live owner.
        stop_preparation(tx, op, Outcome::Cancelled)?;
    }
    Ok(())
}
