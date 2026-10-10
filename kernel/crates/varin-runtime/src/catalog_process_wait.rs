//! Durable observation of an existing process Operation. No process state is owned here.
use super::*;
use crate::execution::ToolExecutionContext;

pub const WAIT_TOOL: &str = "wait_process";
pub(super) const PREFIX: &str = "process-wait:";

impl Catalog {
    pub fn require_process_observation(&self, run_id: &str, process_id: &str) -> Result<Operation> {
        let run = self.run(run_id)?;
        let process = self.operation(process_id)?;
        let owner = self.run(&process.run_id)?;
        let delegated = self.followup_process_source(run_id, process_id)?;
        if (owner.id != run.id && delegated.as_deref() != Some(owner.id.as_str()))
            || owner.thread_id != run.thread_id
            || process.executor.as_deref() != Some("process_spawn")
        {
            return Err(RuntimeError::Conflict(
                "process is not owned by this Run".into(),
            ));
        }
        Ok(process)
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
        if operation.executor.as_deref() != Some(WAIT_TOOL) {
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
        && process.executor.as_deref() == Some("process_spawn"))
}
