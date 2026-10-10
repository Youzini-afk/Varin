//! Durable observation of an existing process Operation. No process state is owned here.
use super::*;
use crate::execution::ToolExecutionContext;

pub const WAIT_TOOL: &str = "wait_process";
pub(super) const PREFIX: &str = "process-wait:";

/// Ephemeral proof derived from the original delegated executions, never an ACL or stored grant.
/// Private construction ensures that a tool argument cannot assert this source relationship.
#[derive(Debug, Clone)]
pub struct ProcessResultLineage {
    process_id: String,
    source_run_id: String,
    target_run_id: String,
    source: launches::SourceSelection,
    target: launches::SourceSelection,
    executions: Vec<String>,
}
impl ProcessResultLineage {
    pub fn process_id(&self) -> &str {
        &self.process_id
    }
    pub fn source_run_id(&self) -> &str {
        &self.source_run_id
    }
    pub fn target_run_id(&self) -> &str {
        &self.target_run_id
    }
    pub fn source(&self) -> &launches::SourceSelection {
        &self.source
    }
    pub fn target(&self) -> &launches::SourceSelection {
        &self.target
    }
    pub fn executions(&self) -> &[String] {
        &self.executions
    }
}
/// Verify every actual predecessor and immutable basis; same Thread by itself is insufficient.
pub(super) fn delegated_source_lineage(
    db: &Connection,
    source_run: &Run,
    target_run: &Run,
) -> Result<Option<Vec<String>>> {
    if source_run.thread_id != target_run.thread_id || source_run.branch_id != target_run.branch_id
    {
        return Ok(None);
    }
    let mut run = target_run.clone();
    let mut chain = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    while run.id != source_run.id {
        if !seen.insert(run.id.clone()) {
            return Err(RuntimeError::Invalid(
                "cyclic delegated source lineage".into(),
            ));
        }
        let raw: Option<String> = db
            .query_row(
                "SELECT body FROM delegated_executions WHERE run_id=?1",
                [&run.id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = raw else { return Ok(None) };
        let current: delegated::DelegatedExecution = serde_json::from_str(&raw)?;
        let (previous_id, previous_run_id) = match &current.trigger {
            delegated::DelegatedTrigger::Followup {
                previous_execution_id,
                previous_run_id,
                ..
            }
            | delegated::DelegatedTrigger::Calendar {
                previous_execution_id,
                previous_run_id,
                ..
            }
            | delegated::DelegatedTrigger::MessageRequest {
                previous_execution_id,
                previous_run_id,
                ..
            }
            | delegated::DelegatedTrigger::UserContinuation {
                previous_execution_id,
                previous_run_id,
                ..
            } => (previous_execution_id, previous_run_id),
            _ => return Ok(None),
        };
        let previous = delegated::execution(db, previous_id)?;
        let launch: launch_content::LaunchMetadata = record(db, "run_launches", &run.id)?;
        let Some(collaboration::ChildSource::Ready { selection, pin, .. }) = &current.source else {
            return Ok(None);
        };
        let Some(basis) = &current.source_basis else {
            return Ok(None);
        };
        if current.receipt.as_ref().map(|r| r.run_id.as_str()) != Some(run.id.as_str())
            || previous.child_operation_id != current.child_operation_id
            || previous.receipt.as_ref().map(|r| r.run_id.as_str())
                != Some(previous_run_id.as_str())
            || previous.report.is_none()
            || !previous.code_result.settled()
            || followups::normalized_source(launch.selection.source, &run.id)
                != followups::normalized_source(Some(selection.clone()), &run.id)
            || pin.root != basis.root()
            || selection.workspace_id != basis.source().workspace_id
            || selection.execution_workspace_id != basis.source().execution_workspace_id
        {
            return Ok(None);
        }
        let Some(collaboration::ChildSource::Ready {
            pin: prior_pin,
            selection: prior_selection,
            ..
        }) = &previous.source
        else {
            return Ok(None);
        };
        let valid = match (basis, &previous.code_result) {
            (
                delegated::ChildSourceBasis::WorkingResult {
                    result,
                    root,
                    source,
                    ..
                },
                collaboration::ChildCodeResult::Published { result: actual, .. },
            ) => {
                let mut expected = prior_selection.clone();
                expected.mode = SourceMode::FixedBranch;
                expected.branch_id = Some(actual.branch_id.clone());
                expected.revision = Some(actual.result_revision);
                expected.live_root = None;
                expected.environment_run_id = None;
                result == actual && root == &actual.root && source == &expected
            }
            (
                delegated::ChildSourceBasis::ImmutableSource {
                    pin, source, root, ..
                },
                collaboration::ChildCodeResult::NoChanges
                | collaboration::ChildCodeResult::Unavailable {
                    effect: Effect::None,
                    ..
                },
            ) => pin == prior_pin && source == &prior_pin.source && root == &prior_pin.root,
            _ => false,
        };
        if !valid {
            return Ok(None);
        }
        let prior: Run = record(db, "runs", previous_run_id)?;
        let prior_launch: launch_content::LaunchMetadata =
            record(db, "run_launches", previous_run_id)?;
        if !prior.state.terminal()
            || prior.thread_id != source_run.thread_id
            || prior.branch_id != source_run.branch_id
            || followups::normalized_source(prior_launch.selection.source, &prior.id)
                != followups::normalized_source(Some(prior_selection.clone()), &prior.id)
        {
            return Ok(None);
        }
        chain.push(current.execution_id);
        run = prior;
    }
    Ok((!chain.is_empty()).then_some(chain))
}

pub(super) fn process_observation(
    db: &Connection,
    run: &Run,
    process_id: &str,
) -> Result<Operation> {
    let process: Operation = record(db, "operations", process_id)?;
    let owner: Run = record(db, "runs", &process.run_id)?;
    let intent = tool_content::ToolIntent::from_operation(&process)?;
    let accepted = matches!(process.call_completion.as_ref(), Some(result_content::ToolCompletionMetadata::JobAccepted { operation_id, .. }) if operation_id == &process.id)
        || process.external_receipt.as_ref().is_some_and(|receipt| {
            receipt.identity == process.id && receipt.executor == "process_spawn"
        });
    if owner.thread_id != run.thread_id
        || owner.branch_id != run.branch_id
        || process.executor.as_deref() != Some("process_spawn")
        || process.execution_owner != Some(ExecutorOwner::Kernel)
        || intent.call().name != "process_spawn"
        || intent.contract().name != "process_spawn"
        || intent.contract().completion != crate::execution::CompletionKind::Job
        || !accepted
    {
        return Err(RuntimeError::Conflict(
            "process is not an accepted native Job of this Thread and branch".into(),
        ));
    }
    if owner.id != run.id {
        let original =
            optional_record::<launch_content::LaunchMetadata>(db, "run_launches", &owner.id)?
                .ok_or_else(|| RuntimeError::NotFound("process source launch".into()))?;
        let current =
            optional_record::<launch_content::LaunchMetadata>(db, "run_launches", &run.id)?
                .ok_or_else(|| RuntimeError::NotFound("observer source launch".into()))?;
        if !matches!(process.lifetime, Lifetime::Thread | Lifetime::Environment)
            || original.selection.source.is_none()
            || (followups::normalized_source(original.selection.source, &owner.id)
                != followups::normalized_source(current.selection.source, &run.id)
                && (!process
                    .external_receipt
                    .as_ref()
                    .is_some_and(|r| r.executor_stopped)
                    || delegated_source_lineage(db, &owner, run)?.is_none()))
        {
            return Err(RuntimeError::Conflict(
                "process lifetime or execution source does not permit this read-only successor"
                    .into(),
            ));
        }
    }
    Ok(process)
}

impl Catalog {
    pub fn require_process_observation(&self, run_id: &str, process_id: &str) -> Result<Operation> {
        process_observation(&self.db, &self.run(run_id)?, process_id)
    }

    pub fn process_result_lineage(
        &self,
        run_id: &str,
        process_id: &str,
    ) -> Result<Option<ProcessResultLineage>> {
        let process = self.require_process_observation(run_id, process_id)?;
        if process.run_id == run_id {
            return Ok(None);
        }
        let owner = self.run(&process.run_id)?;
        let target_run = self.run(run_id)?;
        let source = self
            .launch_metadata(&owner.id)?
            .and_then(|v| v.selection.source)
            .ok_or_else(|| RuntimeError::NotFound("process source".into()))?;
        let target = self
            .launch_metadata(run_id)?
            .and_then(|v| v.selection.source)
            .ok_or_else(|| RuntimeError::NotFound("observer source".into()))?;
        if followups::normalized_source(Some(source.clone()), &owner.id)
            == followups::normalized_source(Some(target.clone()), run_id)
        {
            return Ok(None);
        }
        let executions = delegated_source_lineage(&self.db, &owner, &target_run)?
            .ok_or_else(|| RuntimeError::Conflict("delegated source lineage changed".into()))?;
        Ok(Some(ProcessResultLineage {
            process_id: process_id.into(),
            source_run_id: owner.id,
            target_run_id: run_id.into(),
            source,
            target,
            executions,
        }))
    }

    /// Wait and original tool receipt commit together. The caller has checked the real process
    /// observation capability before entering this short transaction.
    pub fn wait_for_process(
        &mut self,
        context: &ToolExecutionContext,
        process_id: &str,
    ) -> Result<Wait> {
        if self
            .require_process_observation(&context.run_id, process_id)?
            .run_id
            != context.run_id
        {
            return Err(RuntimeError::Conflict(
                "follow-up process delegation is read-only, not a new process wait".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", &context.run_id)?;
        let mut op: Operation = record(&tx, "operations", &context.operation_id)?;
        let admitted = super::tool_content::ToolIntent::from_operation(&op)?;
        if op.run_id != context.run_id
            || admitted.origin() != &context.origin
            || admitted.call().arguments_ref
                != crate::content::ContentStore::reference(&json!({"processId":process_id}))?
        {
            return Err(RuntimeError::Conflict(
                "process wait origin or target changed".into(),
            ));
        }
        let wait_id = format!("{PREFIX}{}", op.id);
        let wait = if let Some(wait) = optional_record::<Wait>(&tx, "waits", &wait_id)? {
            if wait.run_id != run.id
                || wait.subject != process_id
                || wait.kind != "operation.settled"
            {
                return Err(RuntimeError::Conflict(
                    "process wait identity reused".into(),
                ));
            }
            // An already accepted observation is immutable, even after delivery or cancellation.
            return Ok(wait);
        } else {
            fence(&run, self.epoch)?;
            super::tool_content::require_job_invocation(&tx, &run, &op, context, WAIT_TOOL)?;
            if run.cancel_requested
                || run.state.terminal()
                || op.cancel_requested
                || op.phase != OperationPhase::Running
            {
                return Err(RuntimeError::Conflict(
                    "process observation is not an active admitted call".into(),
                ));
            }
            // The Operation identity is unique. Looking back from its beginning handles an exit
            // that committed before this model decided to wait, without a registration race.
            let trigger_cursor = tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='operation.settled' ORDER BY cursor DESC LIMIT 1",
                [process_id], |row| read_number(row, 0)).optional()?;
            let wait = Wait {
                id: wait_id,
                run_id: run.id.clone(),
                subject: process_id.into(),
                kind: "operation.settled".into(),
                after_cursor: 0,
                deadline_at_ms: None,
                trigger_cursor,
                cancelled: false,
            };
            tx.execute(
                "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
                params![wait.id, wait.run_id, encode(&wait)?],
            )?;
            if let Some(cursor) = trigger_cursor {
                Self::enqueue_resume(&tx, &wait, cursor)?;
            }
            event(
                &tx,
                &wait.id,
                1,
                "wait.registered",
                serde_json::to_value(&wait)?,
            )?;
            wait
        };
        op.waiting_on = Some(wait.id.clone());
        op.phase = OperationPhase::Waiting;
        op.handed_off = true;
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        super::result_content::publish_job_acceptance(&tx, &mut op, &admitted, "awaiting_process")?;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "process.wait_registered",
            json!({"wait_id":wait.id,"process_id":process_id}),
        )?;
        tx.commit()?;
        Ok(wait)
    }

    pub fn pending_process_wait(&self, run_id: &str) -> Result<Option<String>> {
        let mut statement = self
            .db
            .prepare("SELECT body FROM operations WHERE run_id=?1 ORDER BY rowid")?;
        for raw in statement.query_map([run_id], |row| row.get::<_, String>(0))? {
            let operation: Operation = serde_json::from_str(&raw?)?;
            if operation.executor.as_deref() == Some(WAIT_TOOL)
                && operation.execution_owner == Some(ExecutorOwner::Kernel)
                && operation.phase != OperationPhase::Terminal
            {
                if let Some(wait) = operation.waiting_on {
                    return Ok(Some(wait));
                }
            }
        }
        Ok(None)
    }

    pub fn cancel_process_wait(&mut self, operation_id: &str) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut operation: Operation = record(&tx, "operations", operation_id)?;
        if operation.executor.as_deref() != Some(WAIT_TOOL)
            || operation.execution_owner != Some(ExecutorOwner::Kernel)
        {
            return Err(RuntimeError::Invalid(
                "operation is not a process observation wait".into(),
            ));
        }
        if operation.phase == OperationPhase::Terminal {
            return Ok(operation);
        }
        if !operation.cancel_requested {
            operation.cancel_requested = true;
            operation.revision += 1;
            put(&tx, "operations", operation_id, &operation)?;
            event(
                &tx,
                operation_id,
                operation.revision,
                "operation.cancel_requested",
                Value::Null,
            )?;
        }
        if let Some(id) = &operation.waiting_on {
            if id != &format!("{PREFIX}{operation_id}") {
                return Err(RuntimeError::Invalid(
                    "process wait identity changed".into(),
                ));
            }
            let mut wait: Wait = record(&tx, "waits", id)?;
            if wait.run_id != operation.run_id {
                return Err(RuntimeError::Conflict("process wait Run changed".into()));
            }
            if !wait.cancelled {
                wait.cancelled = true;
                put(&tx, "waits", id, &wait)?;
                event(&tx, id, 2, "wait.cancelled", Value::Null)?;
            }
        }
        tx.commit()?;
        Ok(operation)
    }

    pub(super) fn close_finished_process_waits(&mut self) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut released = Vec::new();
        for mut operation in read_all::<Operation>(&tx, "operations")? {
            if operation.executor.as_deref() != Some(WAIT_TOOL)
                || operation.execution_owner != Some(ExecutorOwner::Kernel)
                || operation.phase == OperationPhase::Terminal
            {
                continue;
            }
            let run: Run = record(&tx, "runs", &operation.run_id)?;
            if !run.state.terminal() {
                continue;
            }
            if let Some(id) = &operation.waiting_on {
                let mut wait: Wait = record(&tx, "waits", id)?;
                wait.cancelled = true;
                put(&tx, "waits", id, &wait)?;
            }
            operation.phase = OperationPhase::Terminal;
            operation.outcome = Some(Outcome::Cancelled);
            operation.effect = Effect::None;
            operation.cancel_requested = true;
            operation.revision += 1;
            operation.result = Some(OperationResultMetadata::Control {
                value: json!({"observation_cancelled":true,"reason":"run_finished"}),
            });
            put(&tx, "operations", &operation.id, &operation)?;
            tx.execute(
                "DELETE FROM resource_occupancy WHERE operation_id=?1",
                [&operation.id],
            )?;
            event(
                &tx,
                &operation.id,
                operation.revision,
                "operation.settled",
                serde_json::to_value(&operation)?,
            )?;
            released.push(operation.id);
        }
        tx.commit()?;
        for id in released {
            self.resource_admission.release(&id);
        }
        Ok(())
    }
}

/// A cancelled observer may still need to park before publishing its own cancellation fact.
/// This never authorizes a different Wait or changes the observed process.
pub(super) fn pending_cancelled_observation(
    db: &Connection,
    run: &Run,
    wait: &Wait,
) -> Result<bool> {
    let Some(id) = wait.id.strip_prefix(PREFIX) else {
        return Ok(false);
    };
    if !wait.cancelled || wait.run_id != run.id || wait.kind != "operation.settled" {
        return Ok(false);
    }
    let Some(op) = optional_record::<Operation>(db, "operations", id)? else {
        return Ok(false);
    };
    if op.run_id != run.id
        || op.epoch != run.epoch
        || op.executor.as_deref() != Some(WAIT_TOOL)
        || op.execution_owner != Some(ExecutorOwner::Kernel)
        || op.phase != OperationPhase::Waiting
        || !op.handed_off
        || op.waiting_on.as_deref() != Some(wait.id.as_str())
        || !matches!(&op.call_completion, Some(super::result_content::ToolCompletionMetadata::JobAccepted {
            operation_id, phase, effect: Effect::None, lifetime: Lifetime::Thread,
        }) if operation_id == &op.id && phase == "awaiting_process")
    {
        return Ok(false);
    }
    let admitted = super::tool_content::ToolIntent::from_operation(&op)?;
    let Some(process) = optional_record::<Operation>(db, "operations", &wait.subject)? else {
        return Ok(false);
    };
    Ok(admitted.call().name == WAIT_TOOL
        && process.run_id == run.id
        && process.executor.as_deref() == Some("process_spawn")
        && process.execution_owner == Some(ExecutorOwner::Kernel))
}
