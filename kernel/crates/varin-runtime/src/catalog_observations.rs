//! The existing Operations and Waits form one observation barrier per Run. This module owns
//! selection and teardown only; child, process and message owners still produce their facts.
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

// All native wall-clock timer backends can represent an absolute signed nanosecond instant.
// Reject unrepresentable input instead of shortening the persisted user deadline.
pub const MAX_DEADLINE_MS: u64 = i64::MAX as u64 / 1_000_000;
pub fn wall_time_ms() -> Result<u64> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RuntimeError::Invalid("system wall clock precedes Unix epoch".into()))?
            .as_millis(),
    )
    .map_err(|_| RuntimeError::Invalid("system wall clock is unrepresentable".into()))
}
pub fn deadline_after(now: u64, duration: u64) -> Result<u64> {
    now.checked_add(duration)
        .filter(|v| *v <= MAX_DEADLINE_MS)
        .ok_or_else(|| {
            RuntimeError::Invalid(
                "reply deadline exceeds native wall-clock timer representation".into(),
            )
        })
}
pub fn is_observation_id(id: &str) -> bool {
    id.starts_with("child-wait:")
        || id.starts_with("process-wait:")
        || id.starts_with(messages::reply_wait::PREFIX)
        || id.starts_with(followups::observation::PREFIX)
}
fn waiting_runs(db: &Connection) -> Result<Vec<Run>> {
    let mut q = db.prepare("SELECT body FROM runs WHERE json_extract(body,'$.state')='waiting' AND (json_extract(body,'$.waiting_on') GLOB 'child-wait:*' OR json_extract(body,'$.waiting_on') GLOB 'process-wait:*' OR json_extract(body,'$.waiting_on') GLOB 'reply-wait:*' OR json_extract(body,'$.waiting_on') GLOB 'followup-observation:*') ORDER BY rowid")?;
    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}
pub(super) fn operations(db: &Connection, run: Option<&str>) -> Result<Vec<Operation>> {
    let mut q = db.prepare("SELECT body FROM operations WHERE (?1 IS NULL OR run_id=?1) AND json_extract(body,'$.phase')!='terminal' AND json_extract(body,'$.execution_owner.kind')='kernel' AND json_extract(body,'$.executor') IN ('wait_child','wait_process','send','follow_up') AND json_extract(body,'$.waiting_on') IS NOT NULL ORDER BY rowid")?;
    let rows = q.query_map([run], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for raw in rows {
        let op: Operation = serde_json::from_str(&raw?)?;
        if op.waiting_on.as_deref().is_some_and(is_observation_id) {
            out.push(op);
        }
    }
    Ok(out)
}
pub(super) fn ready(db: &Connection, op: &Operation, wait: &Wait) -> Result<bool> {
    if wait.cancelled {
        return Ok(true);
    }
    match op.executor.as_deref() {
        Some(collaboration::WAIT_TOOL) => {
            let child = delegated::execution_task(db, &wait.subject)?;
            Ok(child.report.is_some() && child.code_result.settled())
        }
        Some(process_wait::WAIT_TOOL) => {
            let process: Operation = record(db, "operations", &wait.subject)?;
            Ok(process.phase == OperationPhase::Terminal && process.external_receipt.is_some())
        }
        Some(messages::SEND_TOOL) | Some(followups::TOOL) => Ok(wait.trigger_cursor.is_some()),
        _ => Ok(false),
    }
}
/// Prefer a fact that can be delivered now. If any live observation remains unready, retain
/// it as the parking object; a ready-only selection would wrongly resume the model early.
pub(super) fn next(db: &Connection, run: &str) -> Result<Option<String>> {
    let mut pending = None;
    for op in operations(db, Some(run))? {
        let id = op.waiting_on.as_ref().expect("selected observation");
        let wait: Wait = record(db, "waits", id)?;
        if wait.run_id != run {
            return Err(RuntimeError::Invalid(
                "observation Wait owner changed".into(),
            ));
        }
        if ready(db, &op, &wait)? {
            return Ok(Some(id.clone()));
        }
        if pending.is_none() {
            pending = Some(id.clone())
        }
    }
    Ok(pending)
}
pub(super) fn pending_cancelled(db: &Connection, run: &Run, wait: &Wait) -> Result<bool> {
    if collaboration::pending_cancelled_observation(db, run, wait)?
        || process_wait::pending_cancelled_observation(db, run, wait)?
    {
        return Ok(true);
    }
    Ok(messages::reply_wait::pending_cancelled(db, run, wait)?
        || followups::observation::pending_cancelled(db, run, wait)?)
}
pub(super) fn advance(tx: &Transaction<'_>, run: &mut Run) -> Result<()> {
    run.waiting_on = next(tx, &run.id)?;
    run.state = if run.waiting_on.is_some() {
        RunState::Waiting
    } else {
        RunState::Runnable
    };
    run.revision += 1;
    put(tx, "runs", &run.id, run)?;
    if let Some(mut launch) =
        optional_record::<launch_content::LaunchMetadata>(tx, "run_launches", &run.id)?
    {
        launch.requires_rebind = run.state == RunState::Runnable;
        launch.bound_epoch = None;
        launch.revision += 1;
        put(tx, "run_launches", &run.id, &launch)?;
    }
    if run.state == RunState::Runnable {
        event(
            tx,
            &run.id,
            run.revision,
            "observation.run_ready",
            json!({"run_id":run.id}),
        )?;
    }
    Ok(())
}
impl Catalog {
    pub fn pending_observation_wait(&self, run: &str) -> Result<Option<String>> {
        next(&self.db, run)
    }
    pub fn pending_observation_continuations(&self) -> Result<Vec<String>> {
        let mut q=self.db.prepare("SELECT DISTINCT r.id FROM runs r JOIN operations o ON o.run_id=r.id JOIN run_launches l ON l.id=r.id WHERE json_extract(r.body,'$.state')='runnable' AND json_extract(r.body,'$.cancel_requested')=0 AND json_extract(l.body,'$.requires_rebind')=1 AND json_extract(o.body,'$.execution_owner.kind')='kernel' AND json_extract(o.body,'$.executor') IN ('wait_child','wait_process','send','follow_up') AND json_extract(o.body,'$.waiting_on') IS NOT NULL AND json_extract(o.body,'$.phase')='terminal' ORDER BY r.rowid")?;
        let rows = q
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn nearest_wait_deadline(&self) -> Result<Option<u64>> {
        let mut deadline = None;
        for op in operations(&self.db, None)? {
            let run = self.run(&op.run_id)?;
            if run.state.terminal() || run.cancel_requested {
                continue;
            }
            let wait: Wait = record(
                &self.db,
                "waits",
                op.waiting_on.as_deref().expect("selected"),
            )?;
            if !wait.cancelled && wait.trigger_cursor.is_none() {
                if let Some(at) = wait.deadline_at_ms {
                    deadline = Some(deadline.map_or(at, |previous: u64| previous.min(at)));
                }
            }
        }
        if let Some(at) = self.nearest_followup_deadline()? {
            deadline = Some(deadline.map_or(at, |previous| previous.min(at)));
        }
        Ok(deadline)
    }
    /// Runs have quiesced before this selection; no model writer is moved underneath a request.
    pub fn select_ready_observations(&mut self) -> Result<bool> {
        let tx = self.db.transaction()?;
        let mut changed = false;
        for mut run in waiting_runs(&tx)? {
            if run.state != RunState::Waiting
                || run.cancel_requested
                || !run.waiting_on.as_deref().is_some_and(is_observation_id)
            {
                continue;
            }
            if let Some(next) = next(&tx, &run.id)? {
                if run.waiting_on.as_deref() != Some(&next) {
                    run.waiting_on = Some(next);
                    run.revision += 1;
                    put(&tx, "runs", &run.id, &run)?;
                    changed = true;
                }
            }
        }
        tx.commit()?;
        Ok(changed)
    }
    pub fn cancel_observation(&mut self, operation_id: &str) -> Result<Operation> {
        self.reconcile_waits()?;
        let op = self.operation(operation_id)?;
        let id = op
            .waiting_on
            .as_deref()
            .filter(|id| is_observation_id(id))
            .ok_or_else(|| RuntimeError::Invalid("operation is not an observation".into()))?;
        if op.phase == OperationPhase::Terminal {
            return Ok(op);
        }
        let wait: Wait = record(&self.db, "waits", id)?;
        // Cancellation ends a live observation, never rewrites a previously won result.
        if wait.trigger_cursor.is_some() {
            return Ok(op);
        }
        if op.executor.as_deref() == Some(process_wait::WAIT_TOOL) {
            self.cancel_process_wait(operation_id)
        } else if op.executor.as_deref() == Some(followups::TOOL) {
            self.cancel_followup_observation(operation_id)
        } else if op.executor.as_deref() == Some(messages::SEND_TOOL) {
            self.cancel_reply_wait(operation_id)
        } else {
            self.request_cancel_child_wait(id)?;
            self.operation(operation_id)
        }
    }
    pub fn observation_positions(&self) -> Result<Vec<(String, Option<String>)>> {
        let mut out = Vec::new();
        for run in waiting_runs(&self.db)? {
            if run.state == RunState::Waiting
                && run.waiting_on.as_deref().is_some_and(is_observation_id)
            {
                out.push((run.id, run.waiting_on))
            }
        }
        Ok(out)
    }
}
