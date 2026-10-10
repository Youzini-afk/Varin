//! Stable family relationships and per-admission delegated execution facts.
//! Runs and their Launch records remain the only execution state owners.
use super::*;
use collaboration::{
    ChildCodeResult, ChildReport, ChildSource, ChildSourcePin, ChildTask, ChildWorkingResultRef,
};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildRelation {
    pub operation_id: String,
    pub parent_run_id: String,
    pub parent_thread_id: String,
    pub parent_branch_id: String,
    pub origin: crate::execution::ToolOrigin,
    pub call_id: String,
    pub child_thread_id: String,
    pub child_branch_id: String,
    pub project_id: Option<String>,
    pub selected_profile_ref: Value,
    pub dispatch_context_ref: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DelegatedTrigger {
    Dispatch,
    Followup {
        followup_id: String,
        occurrence_id: String,
        input_id: String,
        previous_execution_id: String,
        previous_run_id: String,
        previous_run_revision: u64,
        expected_head: Option<String>,
    },
    Calendar {
        definition_id: String,
        occurrence_id: String,
        input_id: String,
        previous_execution_id: String,
        previous_run_id: String,
        previous_run_revision: u64,
        expected_head: Option<String>,
    },
    MessageRequest {
        message_id: String,
        previous_execution_id: String,
        previous_run_id: String,
        previous_run_revision: u64,
        expected_head: Option<String>,
    },
    UserContinuation {
        key: String,
        previous_execution_id: String,
        previous_run_id: String,
        previous_run_revision: u64,
        expected_head: Option<String>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChildSourceBasis {
    WorkingResult {
        source: launches::SourceSelection,
        root: String,
        result: ChildWorkingResultRef,
        provenance_ref: Value,
    },
    ImmutableSource {
        source: launches::SourceSelection,
        root: String,
        pin: ChildSourcePin,
        provenance_ref: Value,
    },
}
impl ChildSourceBasis {
    pub fn source(&self) -> &launches::SourceSelection {
        match self {
            Self::WorkingResult { source, .. } | Self::ImmutableSource { source, .. } => source,
        }
    }
    pub fn root(&self) -> &str {
        match self {
            Self::WorkingResult { root, .. } | Self::ImmutableSource { root, .. } => root,
        }
    }
    pub fn provenance_ref(&self) -> &Value {
        match self {
            Self::WorkingResult { provenance_ref, .. }
            | Self::ImmutableSource { provenance_ref, .. } => provenance_ref,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DelegatedExecution {
    pub execution_id: String,
    pub child_operation_id: String,
    pub trigger: DelegatedTrigger,
    pub input_ref: Value,
    pub configuration_ref: Value,
    pub launch: launch_content::LaunchSelectionMetadata,
    pub policy_target: policy_switch::PolicyTarget,
    pub source_basis: Option<ChildSourceBasis>,
    pub source: Option<ChildSource>,
    pub code_result: ChildCodeResult,
    pub revision: u64,
    pub cursor: u64,
    pub receipt: Option<Receipt>,
    pub report: Option<ChildReport>,
    pub terminal_head: Option<String>,
    pub resources_released: bool,
    pub cancel_requested: bool,
}
impl DelegatedExecution {
    pub fn state(&self) -> &'static str {
        if let Some(report) = &self.report {
            if !self.code_result.settled() {
                "settling"
            } else {
                match report.outcome {
                    Outcome::Succeeded => "completed",
                    Outcome::Cancelled => "cancelled",
                    _ => "failed",
                }
            }
        } else if matches!(
            self.code_result,
            ChildCodeResult::Settling { .. } | ChildCodeResult::Candidate { .. }
        ) {
            "settling"
        } else if self.receipt.is_some() {
            "ready"
        } else {
            "preparing"
        }
    }
}

pub(super) fn relation(db: &Connection, id: &str) -> Result<ChildRelation> {
    record(db, "child_tasks", id)
}
pub(super) fn execution(db: &Connection, id: &str) -> Result<DelegatedExecution> {
    record(db, "delegated_executions", id)
}
pub(super) fn execution_task(db: &Connection, id: &str) -> Result<ChildTask> {
    let execution = execution(db, id)?;
    let child = relation(db, &execution.child_operation_id)?;
    Ok(ChildTask {
        execution_id: execution.execution_id.clone(),
        operation_id: child.operation_id,
        parent_run_id: child.parent_run_id,
        parent_thread_id: child.parent_thread_id,
        parent_branch_id: child.parent_branch_id,
        origin: child.origin,
        call_id: child.call_id,
        child_thread_id: child.child_thread_id,
        child_branch_id: child.child_branch_id,
        project_id: child.project_id,
        input_ref: execution.input_ref.clone(),
        configuration_ref: execution.configuration_ref.clone(),
        selected_profile_ref: child.selected_profile_ref,
        dispatch_context_ref: child.dispatch_context_ref,
        launch: execution.launch.clone(),
        source: execution.source.clone().ok_or_else(|| {
            RuntimeError::Conflict("delegated source has not been prepared".into())
        })?,
        code_result: execution.code_result.clone(),
        state: execution.state().into(),
        revision: execution.revision,
        cursor: execution.cursor,
        receipt: execution.receipt,
        report: execution.report,
        resources_released: execution.resources_released,
    })
}
pub(super) fn write_execution(db: &Connection, execution: &DelegatedExecution) -> Result<()> {
    db.execute(
        "UPDATE delegated_executions SET run_id=?2,body=?3 WHERE id=?1",
        params![
            execution.execution_id,
            execution.receipt.as_ref().map(|r| &r.run_id),
            encode(execution)?
        ],
    )?;
    Ok(())
}
pub(super) fn write_child_task(db: &Connection, child: &ChildTask) -> Result<()> {
    let mut execution = execution(db, &child.execution_id)?;
    execution.input_ref = child.input_ref.clone();
    execution.configuration_ref = child.configuration_ref.clone();
    execution.launch = child.launch.clone();
    execution.source = Some(child.source.clone());
    execution.code_result = child.code_result.clone();
    execution.revision = child.revision;
    execution.cursor = child.cursor;
    execution.receipt = child.receipt.clone();
    execution.report = child.report.clone();
    execution.resources_released = child.resources_released;
    write_execution(db, &execution)
}
pub(super) fn insert_initial(db: &Connection, child: &ChildTask) -> Result<()> {
    let relation = ChildRelation {
        operation_id: child.operation_id.clone(),
        parent_run_id: child.parent_run_id.clone(),
        parent_thread_id: child.parent_thread_id.clone(),
        parent_branch_id: child.parent_branch_id.clone(),
        origin: child.origin.clone(),
        call_id: child.call_id.clone(),
        child_thread_id: child.child_thread_id.clone(),
        child_branch_id: child.child_branch_id.clone(),
        project_id: child.project_id.clone(),
        selected_profile_ref: child.selected_profile_ref.clone(),
        dispatch_context_ref: child.dispatch_context_ref.clone(),
    };
    db.execute(
        "INSERT INTO child_tasks(id,child_thread_id,body) VALUES(?1,?2,?3)",
        params![
            relation.operation_id,
            relation.child_thread_id,
            encode(&relation)?
        ],
    )?;
    let execution = DelegatedExecution {
        execution_id: child.execution_id.clone(),
        child_operation_id: child.operation_id.clone(),
        trigger: DelegatedTrigger::Dispatch,
        input_ref: child.input_ref.clone(),
        configuration_ref: child.configuration_ref.clone(),
        launch: child.launch.clone(),
        policy_target: policy_switch::PolicyTarget::Default,
        source_basis: None,
        source: Some(child.source.clone()),
        code_result: child.code_result.clone(),
        revision: child.revision,
        cursor: child.cursor,
        receipt: child.receipt.clone(),
        report: child.report.clone(),
        terminal_head: None,
        resources_released: child.resources_released,
        cancel_requested: false,
    };
    insert_execution(db, &execution, None)
}
fn insert_execution(
    db: &Connection,
    execution: &DelegatedExecution,
    key: Option<&str>,
) -> Result<()> {
    db.execute("INSERT INTO delegated_executions(id,child_operation_id,command_key,run_id,body) VALUES(?1,?2,?3,?4,?5)",
        params![execution.execution_id,execution.child_operation_id,key,execution.receipt.as_ref().map(|r|&r.run_id),encode(execution)?])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct DelegatedExecutionView {
    pub execution_id: String,
    pub child_operation_id: String,
    pub parent_run_id: String,
    pub parent_thread_id: String,
    pub parent_branch_id: String,
    pub origin: crate::execution::ToolOrigin,
    pub call_id: String,
    pub child_thread_id: String,
    pub child_branch_id: String,
    pub project_id: Option<String>,
    pub trigger: DelegatedTrigger,
    pub input: Value,
    pub configuration: Value,
    pub selected_profile: dispatch::ChildSelectedProfile,
    pub launch: launches::LaunchSelection,
    pub policy_target: policy_switch::PolicyTarget,
    pub source_basis: Option<Value>,
    pub source: Option<Value>,
    pub code_result: ChildCodeResult,
    pub state: String,
    pub revision: u64,
    pub cursor: u64,
    pub receipt: Option<Receipt>,
    pub report: Option<ChildReport>,
    pub terminal_head: Option<String>,
    pub resources_released: bool,
    pub cancel_requested: bool,
}
pub struct DelegatedExecutionRead {
    relation: ChildRelation,
    execution: DelegatedExecution,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl DelegatedExecutionRead {
    pub fn load(self) -> Result<DelegatedExecutionView> {
        let execution = self.execution;
        let child = self.relation;
        let source = execution
            .source
            .as_ref()
            .map(|source| hydrate_source(&self.content, source))
            .transpose()?;
        let source_basis = execution
            .source_basis
            .as_ref()
            .map(|basis| {
                let mut value = serde_json::to_value(basis)?;
                value
                    .as_object_mut()
                    .expect("source basis object")
                    .remove("provenance_ref");
                value["provenance"] = self.content.load(basis.provenance_ref())?;
                Ok::<_, RuntimeError>(value)
            })
            .transpose()?;
        Ok(DelegatedExecutionView {
            execution_id: execution.execution_id.clone(),
            child_operation_id: execution.child_operation_id.clone(),
            parent_run_id: child.parent_run_id,
            parent_thread_id: child.parent_thread_id,
            parent_branch_id: child.parent_branch_id,
            origin: child.origin,
            call_id: child.call_id,
            child_thread_id: child.child_thread_id,
            child_branch_id: child.child_branch_id,
            project_id: child.project_id,
            state: execution.state().into(),
            input: if matches!(
                execution.trigger,
                DelegatedTrigger::MessageRequest { .. }
                    | DelegatedTrigger::Followup { .. }
                    | DelegatedTrigger::Calendar { .. }
            ) {
                self.content.load_history_payload(&execution.input_ref)?.0
            } else {
                self.content.load(&execution.input_ref)?
            },
            configuration: self.content.load(&execution.configuration_ref)?,
            selected_profile: serde_json::from_value(
                self.content.load(&child.selected_profile_ref)?,
            )?,
            launch: execution.launch.load(&self.content)?,
            trigger: execution.trigger,
            policy_target: execution.policy_target,
            source_basis,
            source,
            code_result: execution.code_result,
            revision: execution.revision,
            cursor: execution.cursor,
            receipt: execution.receipt,
            report: execution.report,
            terminal_head: execution.terminal_head,
            resources_released: execution.resources_released,
            cancel_requested: execution.cancel_requested,
        })
    }
}
pub(super) fn hydrate_source(
    content: &crate::content::ContentStore,
    source: &ChildSource,
) -> Result<Value> {
    let mut value = serde_json::to_value(source)?;
    if let ChildSource::Ready { provenance_ref, .. } = source {
        value
            .as_object_mut()
            .expect("source object")
            .remove("provenance_ref");
        value["provenance"] = content.load(provenance_ref)?;
    }
    Ok(value)
}
impl Catalog {
    pub fn delegated_execution(&self, id: &str) -> Result<DelegatedExecution> {
        execution(&self.db, id)
    }
    pub fn delegated_executions(&self, child: Option<&str>) -> Result<Vec<DelegatedExecution>> {
        let mut statement=self.db.prepare("SELECT body FROM delegated_executions WHERE ?1 IS NULL OR child_operation_id=?1 ORDER BY rowid")?;
        let rows = statement.query_map([child], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn delegated_execution_for_run(&self, run_id: &str) -> Result<Option<DelegatedExecution>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM delegated_executions WHERE run_id=?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }
    pub fn capture_delegated_execution(
        &self,
        execution: DelegatedExecution,
    ) -> Result<DelegatedExecutionRead> {
        Ok(DelegatedExecutionRead {
            relation: relation(&self.db, &execution.child_operation_id)?,
            execution,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn execution_task(&self, id: &str) -> Result<ChildTask> {
        execution_task(&self.db, id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildContinuationCommand {
    pub key: String,
    pub child_operation_id: String,
    pub previous_run_id: String,
    pub expected_head: Option<String>,
    pub input: Value,
}
pub struct ChildContinuationPreparation {
    ingress: Option<(inputs::QueuedInputMetadata, Value)>,
    command: ChildContinuationCommand,
    existing: Option<DelegatedExecution>,
    previous: Option<DelegatedExecution>,
    run: Option<Run>,
    launch: Option<launch_content::LaunchMetadata>,
    writers: Option<collaboration::ChildWriterBindingsRead>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChildContinuation {
    pub(super) ingress: Option<inputs::QueuedInputMetadata>,
    command: ChildContinuationCommand,
    input_ref: Value,
    configuration_ref: Option<Value>,
    selection: Option<launch_content::LaunchSelectionMetadata>,
    previous: Option<DelegatedExecution>,
    run: Option<Run>,
    launch: Option<launch_content::LaunchMetadata>,
    writers: Option<collaboration::ChildWriterBindings>,
    provenance_ref: Option<Value>,
    epoch: u64,
    _publication: crate::content::ContentPublication,
}
impl ChildContinuationPreparation {
    pub fn load(self) -> Result<PreparedChildContinuation> {
        if self.command.key.trim().is_empty() {
            return Err(RuntimeError::Invalid("continuation key is required".into()));
        }
        let input_ref = if let Some((_, history)) = &self.ingress {
            self.content.load_history_payload(history)?;
            history.clone()
        } else {
            resources::validate_raw_input(&self.command.input)?;
            self.content.save(&self.command.input)?
        };
        if let Some(existing) = &self.existing {
            check_retry(existing, &self.command, &input_ref)?;
        }
        let provenance_ref = self
            .previous
            .as_ref()
            .map(|previous| -> Result<Value> {
                let source = previous.source.as_ref().ok_or_else(|| {
                    RuntimeError::Conflict("previous immutable source is unavailable".into())
                })?;
                let ChildSource::Ready {
                    pin,
                    provenance_ref,
                    ..
                } = source
                else {
                    return Err(RuntimeError::Conflict(
                        "previous source is not ready".into(),
                    ));
                };
                let provenance = self.content.load(provenance_ref)?;
                let root = match &previous.code_result {
                    ChildCodeResult::Published { result, .. } => result.root.clone(),
                    _ => pin.root.clone(),
                };
                let resources = provenance.get("resources").cloned();
                self.content.save(&serde_json::to_value(
                    collaboration::ChildSourceProvenance::FixedRoot { root, resources },
                )?)
            })
            .transpose()?;
        let selection = self
            .launch
            .as_ref()
            .map(|launch| -> Result<_> {
                let mut selection = launch.selection.clone();
                selection.rebase_policy_models(&self.content)?;
                selection.source = None;
                Ok(selection)
            })
            .transpose()?;
        Ok(PreparedChildContinuation {
            ingress: self.ingress.map(|(row, _)| row),
            selection,
            provenance_ref,
            configuration_ref: self
                .run
                .as_ref()
                .map(|run| self.content.save(&run.configuration))
                .transpose()?,
            command: self.command,
            input_ref,
            previous: self.previous,
            run: self.run,
            launch: self.launch,
            writers: self.writers.map(|read| read.load()).transpose()?,
            epoch: self.epoch,
            _publication: self.publication,
        })
    }
}
fn check_retry(
    execution: &DelegatedExecution,
    command: &ChildContinuationCommand,
    input_ref: &Value,
) -> Result<()> {
    if execution.child_operation_id != command.child_operation_id
        || execution.input_ref != *input_ref
        || !matches!(&execution.trigger,DelegatedTrigger::UserContinuation{key,previous_run_id,expected_head,..} if key==&command.key && previous_run_id==&command.previous_run_id && expected_head==&command.expected_head)
    {
        return Err(RuntimeError::Conflict(
            "continuation key has different input or predecessor".into(),
        ));
    }
    Ok(())
}
impl Catalog {
    pub fn capture_child_continuation(
        &self,
        command: ChildContinuationCommand,
    ) -> Result<ChildContinuationPreparation> {
        let existing: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM delegated_executions WHERE command_key=?1",
                [&command.key],
                |row| row.get(0),
            )
            .optional()?;
        let existing = existing.map(|raw| serde_json::from_str(&raw)).transpose()?;
        let (previous, run, launch, writers) = if existing.is_some() {
            (None, None, None, None)
        } else {
            let previous = self
                .delegated_execution_for_run(&command.previous_run_id)?
                .ok_or_else(|| {
                    RuntimeError::Invalid("previous Run is not a delegated execution".into())
                })?;
            if previous.child_operation_id != command.child_operation_id {
                return Err(RuntimeError::Conflict(
                    "previous Run belongs to another child".into(),
                ));
            }
            let run = self.run(&command.previous_run_id)?;
            let launch = self
                .launch_metadata(&run.id)?
                .ok_or_else(|| RuntimeError::NotFound("previous Run launch".into()))?;
            let writers = self.capture_child_writer_bindings(&previous.execution_id)?;
            (Some(previous), Some(run), Some(launch), Some(writers))
        };
        Ok(ChildContinuationPreparation {
            ingress: None,
            command,
            existing,
            previous,
            run,
            launch,
            writers,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub(super) fn capture_ingress_continuation(
        &self,
        row: inputs::QueuedInputMetadata,
        previous: Run,
        child_operation_id: String,
    ) -> Result<ChildContinuationPreparation> {
        let history: String = self.db.query_row(
            "SELECT body FROM input_history_content WHERE input_id=?1",
            [&row.id],
            |r| r.get(0),
        )?;
        let mut preparation = self.capture_child_continuation(ChildContinuationCommand {
            key: row.id.clone(),
            child_operation_id,
            previous_run_id: previous.id,
            expected_head: self.head(&row.branch_id)?,
            input: Value::Null,
        })?;
        preparation.ingress = Some((row, serde_json::from_str(&history)?));
        Ok(preparation)
    }
    pub fn accept_child_continuation(
        &mut self,
        prepared: PreparedChildContinuation,
    ) -> Result<DelegatedExecution> {
        let old: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM delegated_executions WHERE command_key=?1",
                [&prepared.command.key],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            let old: DelegatedExecution = serde_json::from_str(&old)?;
            check_retry(&old, &prepared.command, &prepared.input_ref)?;
            return Ok(old);
        }
        if self.epoch != prepared.epoch {
            return Err(RuntimeError::Conflict(
                "continuation preparation belongs to a previous owner".into(),
            ));
        }
        if let Some(row) = &prepared.ingress {
            activation::validate_pending(&self.db, row)?;
            if ingress::hold(&self.db, row, None)?.is_some() {
                return Err(RuntimeError::RequestActivationHeld);
            }
        }
        let previous = prepared
            .previous
            .ok_or_else(|| RuntimeError::Conflict("continuation predecessor changed".into()))?;
        let run = prepared.run.expect("captured predecessor");
        let launch = prepared.launch.expect("captured launch");
        let writers = prepared.writers.expect("captured writer bindings");
        // A published immutable result fixes the next source even when its original
        // business effect remains Unknown. Native synchronous writes were quiesced
        // by that result's existing Storage publication owner; independently-lived
        // processes and Host source callbacks still require their original stop receipt.
        if !self.child_writers_stopped(&writers)? {
            if prepared.ingress.is_some() {
                return Err(RuntimeError::RequestActivationHeld);
            }
            return Err(RuntimeError::Conflict(
                "previous child source writers have not confirmed stop".into(),
            ));
        }
        if !run.state.terminal() || previous.report.is_none() || !previous.code_result.settled() {
            if prepared.ingress.is_some() {
                return Err(RuntimeError::RequestActivationHeld);
            }
            return Err(RuntimeError::Conflict(
                "previous child execution has not fixed its report and source result".into(),
            ));
        }
        let source = previous.source.as_ref().ok_or_else(|| {
            RuntimeError::Conflict("previous immutable source is unavailable".into())
        })?;
        let ChildSource::Ready { pin, selection, .. } = source else {
            return Err(RuntimeError::Conflict(
                "previous source is not ready".into(),
            ));
        };
        let provenance_ref = prepared.provenance_ref.expect("prepared source provenance");
        let basis = match &previous.code_result {
            ChildCodeResult::Published { result, .. } => {
                let mut source = selection.clone();
                source.mode = SourceMode::FixedBranch;
                source.branch_id = Some(result.branch_id.clone());
                source.revision = Some(result.result_revision);
                source.environment_run_id = None;
                source.live_root = None;
                ChildSourceBasis::WorkingResult {
                    source,
                    root: result.root.clone(),
                    result: result.clone(),
                    provenance_ref: provenance_ref.clone(),
                }
            }
            ChildCodeResult::NoChanges => ChildSourceBasis::ImmutableSource {
                source: pin.source.clone(),
                root: pin.root.clone(),
                pin: pin.clone(),
                provenance_ref: provenance_ref.clone(),
            },
            ChildCodeResult::Unavailable {
                effect: Effect::None,
                ..
            } if self.child_file_effect_bound(&writers)? == Effect::None => {
                ChildSourceBasis::ImmutableSource {
                    source: pin.source.clone(),
                    root: pin.root.clone(),
                    pin: pin.clone(),
                    provenance_ref: provenance_ref.clone(),
                }
            }
            _ => {
                return Err(RuntimeError::Conflict(
                    "previous source has no exact settled continuation basis".into(),
                ))
            }
        };
        let tx = self.db.transaction()?;
        let current = execution(&tx, &previous.execution_id)?;
        let actual: Run = record(&tx, "runs", &run.id)?;
        let actual_launch: launch_content::LaunchMetadata = record(&tx, "run_launches", &run.id)?;
        // requires_rebind is a derived epoch projection, not persisted selection authority.
        if current != previous
            || actual != run
            || actual_launch.selection != launch.selection
            || actual_launch.policy_target != launch.policy_target
            || actual_launch.revision != launch.revision
        {
            if prepared.ingress.is_some() {
                return Err(RuntimeError::RequestActivationStale);
            }
            return Err(RuntimeError::Conflict(
                "previous child execution changed during continuation preparation".into(),
            ));
        }
        let child = relation(&tx, &previous.child_operation_id)?;
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&child.child_branch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM delegated_executions WHERE child_operation_id=?1 AND run_id IS NULL AND json_extract(body,'$.report') IS NULL AND json_extract(body,'$.cancel_requested')=0)",[&child.operation_id],|row|row.get(0))?;
        let latest_run: String = tx.query_row(
            "SELECT id FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",
            [&child.child_branch_id],
            |row| row.get(0),
        )?;
        if head != prepared.command.expected_head
            || head != previous.terminal_head
            || active.is_some()
            || pending
            || latest_run != run.id
        {
            if prepared.ingress.is_some() {
                return Err(RuntimeError::RequestActivationStale);
            }
            return Err(RuntimeError::Conflict(
                "child head or execution owner changed".into(),
            ));
        }
        let execution_id = id();
        let selected = prepared.selection.expect("prepared continuation selection");
        let mut next = DelegatedExecution {
            execution_id: execution_id.clone(),
            child_operation_id: child.operation_id,
            trigger: if let Some(row) = &prepared.ingress {
                match &row.origin {
                    inputs::InputOrigin::Followup {
                        followup_id,
                        occurrence_id,
                        ..
                    } => DelegatedTrigger::Followup {
                        followup_id: followup_id.clone(),
                        occurrence_id: occurrence_id.clone(),
                        input_id: row.id.clone(),
                        previous_execution_id: previous.execution_id.clone(),
                        previous_run_id: run.id.clone(),
                        previous_run_revision: run.revision,
                        expected_head: head.clone(),
                    },
                    inputs::InputOrigin::Calendar {
                        definition_id,
                        occurrence_id,
                        ..
                    } => DelegatedTrigger::Calendar {
                        definition_id: definition_id.clone(),
                        occurrence_id: occurrence_id.clone(),
                        input_id: row.id.clone(),
                        previous_execution_id: previous.execution_id.clone(),
                        previous_run_id: run.id.clone(),
                        previous_run_revision: run.revision,
                        expected_head: head.clone(),
                    },
                    inputs::InputOrigin::Message { .. } => DelegatedTrigger::MessageRequest {
                        message_id: row.id.clone(),
                        previous_execution_id: previous.execution_id.clone(),
                        previous_run_id: run.id.clone(),
                        previous_run_revision: run.revision,
                        expected_head: head.clone(),
                    },
                    _ => {
                        return Err(RuntimeError::Invalid(
                            "continuation ingress is not activating".into(),
                        ))
                    }
                }
            } else {
                DelegatedTrigger::UserContinuation {
                    key: prepared.command.key.clone(),
                    previous_execution_id: previous.execution_id,
                    previous_run_id: run.id,
                    previous_run_revision: run.revision,
                    expected_head: head,
                }
            },
            input_ref: prepared.input_ref,
            configuration_ref: prepared.configuration_ref.expect("captured configuration"),
            launch: selected,
            policy_target: launch.policy_target,
            source_basis: Some(basis),
            source: None,
            code_result: if matches!(previous.code_result, ChildCodeResult::NoChanges) {
                ChildCodeResult::NoChanges
            } else {
                ChildCodeResult::Pending
            },
            revision: 1,
            cursor: 0,
            receipt: None,
            report: None,
            terminal_head: None,
            resources_released: false,
            cancel_requested: false,
        };
        next.cursor = event(
            &tx,
            &execution_id,
            1,
            "child.execution_accepted",
            json!({"child_operation_id":next.child_operation_id}),
        )?;
        insert_execution(&tx, &next, Some(&prepared.command.key))?;
        activation::bind_execution(&tx, &child.child_branch_id, &next.execution_id)?;
        tx.commit()?;
        Ok(next)
    }
}

pub(super) fn check_format(db: &Connection) -> Result<()> {
    let columns: Vec<(String, String, i64, i64)> = {
        let mut s = db.prepare("PRAGMA table_info(delegated_executions)")?;
        let rows = s
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(5)?)))?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    if columns
        != vec![
            ("id".into(), "TEXT".into(), 0, 1),
            ("child_operation_id".into(), "TEXT".into(), 1, 0),
            ("command_key".into(), "TEXT".into(), 0, 0),
            ("run_id".into(), "TEXT".into(), 0, 0),
            ("body".into(), "TEXT".into(), 1, 0),
        ]
    {
        return Err(RuntimeError::Invalid(
            "unsupported delegated execution format; user data was preserved".into(),
        ));
    }
    let relations: Vec<(String, String, String)> = {
        let mut query = db.prepare("PRAGMA foreign_key_list(delegated_executions)")?;
        let rows = query
            .query_map([], |row| Ok((row.get(3)?, row.get(2)?, row.get(4)?)))?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    if relations.len() != 2
        || !relations.contains(&(
            "child_operation_id".into(),
            "child_tasks".into(),
            "id".into(),
        ))
        || !relations.contains(&("run_id".into(), "runs".into(), "id".into()))
    {
        return Err(RuntimeError::Invalid(
            "malformed delegated execution relations; user data was preserved".into(),
        ));
    }
    let indexes: Vec<(String, bool, bool)> = {
        let mut query = db.prepare(
            "SELECT name,\"unique\",partial FROM pragma_index_list('delegated_executions')",
        )?;
        let rows = query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    let mut unique = std::collections::BTreeSet::new();
    for (index, is_unique, partial) in indexes {
        if !is_unique || partial {
            continue;
        }
        let columns: Vec<(Option<String>, String, bool)> = {
            let mut query = db.prepare(
                "SELECT name,coll,\"desc\" FROM pragma_index_xinfo(?1) WHERE key=1 ORDER BY seqno",
            )?;
            let rows = query
                .query_map([index], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<std::result::Result<_, _>>()?;
            rows
        };
        if let [(Some(name), collation, false)] = columns.as_slice() {
            if collation == "BINARY" {
                unique.insert(name.clone());
            }
        }
    }
    if !["id", "command_key", "run_id"]
        .into_iter()
        .all(|name| unique.contains(name))
    {
        return Err(RuntimeError::Invalid(
            "malformed delegated execution uniqueness; user data was preserved".into(),
        ));
    }
    let mut statement = db.prepare(
        "SELECT id,child_operation_id,command_key,run_id,body FROM delegated_executions",
    )?;
    for row in statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
        ))
    })? {
        let (id, child, key, run, body) = row?;
        let execution: DelegatedExecution = serde_json::from_str(&body).map_err(|_| {
            RuntimeError::Invalid(
                "unsupported delegated execution body; user data was preserved".into(),
            )
        })?;
        let expected_key = match &execution.trigger {
            DelegatedTrigger::Dispatch => None,
            DelegatedTrigger::UserContinuation { key, .. } => Some(key.as_str()),
            DelegatedTrigger::MessageRequest { message_id, .. } => Some(message_id.as_str()),
            DelegatedTrigger::Followup { input_id, .. }
            | DelegatedTrigger::Calendar { input_id, .. } => Some(input_id.as_str()),
        };
        let family = relation(db, &child)?;
        if let Some(receipt) = &execution.receipt {
            let run: Run = record(db, "runs", &receipt.run_id)?;
            if run.thread_id != family.child_thread_id
                || run.branch_id != family.child_branch_id
                || receipt.thread_id != run.thread_id
                || receipt.branch_id != run.branch_id
            {
                return Err(RuntimeError::Invalid(
                    "delegated execution Run belongs to another child; user data was preserved"
                        .into(),
                ));
            }
        }
        if matches!(execution.trigger, DelegatedTrigger::Dispatch)
            && (execution.execution_id != child
                || execution.source_basis.is_some()
                || execution.source.is_none())
        {
            return Err(RuntimeError::Invalid(
                "malformed original dispatch execution; user data was preserved".into(),
            ));
        }
        if execution.execution_id != id
            || execution.child_operation_id != child
            || key.as_deref() != expected_key
            || execution.receipt.as_ref().map(|r| r.run_id.as_str()) != run.as_deref()
        {
            return Err(RuntimeError::Invalid(
                "malformed delegated execution identity; user data was preserved".into(),
            ));
        }
    }
    let missing:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM child_tasks c LEFT JOIN delegated_executions e ON e.id=c.id WHERE e.id IS NULL OR json_extract(e.body,'$.trigger.kind')!='dispatch')",[],|row|row.get(0))?;
    if missing {
        return Err(RuntimeError::Invalid(
            "child has no original dispatch execution; user data was preserved".into(),
        ));
    }
    Ok(())
}
impl Catalog {
    pub fn fail_delegated_preparation(
        &mut self,
        id: &str,
        reason: &str,
    ) -> Result<DelegatedExecution> {
        let mut execution = self.delegated_execution(id)?;
        if execution.report.is_some() {
            return Ok(execution);
        }
        if let Some(receipt) = &execution.receipt {
            let run = self.run(&receipt.run_id)?;
            let steps: i64 = self.db.query_row(
                "SELECT count(*) FROM model_steps WHERE run_id=?1",
                [&run.id],
                |row| row.get(0),
            )?;
            let used:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM policy_checkpoints WHERE run_id=?1) OR EXISTS(SELECT 1 FROM operations WHERE run_id=?1)",[&run.id],|row|row.get(0))?;
            if steps != 0 || used || run.state.terminal() {
                return Err(RuntimeError::Conflict(
                    "child execution already started; preparation cannot replace its outcome"
                        .into(),
                ));
            }
            self.transition_run(&run.id, run.epoch, run.revision, RunState::Failed)?;
            execution.terminal_head = self.head(&run.branch_id)?;
        }
        let relation = relation(&self.db, &execution.child_operation_id)?;
        if !execution.code_result.settled() {
            execution.code_result = ChildCodeResult::Unavailable {
                code: reason.into(),
                effect: Effect::None,
            };
        }
        execution.report = Some(ChildReport {
            outcome: Outcome::Failed,
            sender_thread_id: relation.child_thread_id,
            run_id: execution.receipt.as_ref().map(|r| r.run_id.clone()),
            history_ids: vec![],
            detail: Some(reason.into()),
        });
        execution.revision += 1;
        let tx = self.db.transaction()?;
        write_execution(&tx, &execution)?;
        event(
            &tx,
            id,
            execution.revision,
            "child.report_ready",
            json!({"outcome":"failed"}),
        )?;
        tx.commit()?;
        Ok(execution)
    }
    pub fn release_delegated_resources(&mut self, id: &str) -> Result<DelegatedExecution> {
        let mut execution = self.delegated_execution(id)?;
        if execution.receipt.is_none() && execution.report.is_none() {
            return Err(RuntimeError::Conflict(
                "preparation still owns its source resources".into(),
            ));
        }
        if !execution.resources_released {
            execution.resources_released = true;
            execution.revision += 1;
            let tx = self.db.transaction()?;
            write_execution(&tx, &execution)?;
            event(
                &tx,
                id,
                execution.revision,
                "child.resources_released",
                Value::Null,
            )?;
            tx.commit()?;
        }
        Ok(execution)
    }
    pub fn require_delegated_parent(
        &self,
        run_id: &str,
        child_id: &str,
        execution_id: &str,
    ) -> Result<DelegatedExecution> {
        self.require_child_parent(run_id, child_id)?;
        let execution = self.delegated_execution(execution_id)?;
        if execution.child_operation_id != child_id {
            return Err(RuntimeError::Conflict(
                "execution belongs to another child".into(),
            ));
        }
        Ok(execution)
    }
}
