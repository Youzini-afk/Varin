//! Content-free provider presentation facts in the existing Catalog event ledger.
//! These observations never own execution and never contain provider output.
use super::*;
use crate::execution::GenerationPhase;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhaseFact {
    request_id: String,
    owner_generation: u64,
    run_revision: u64,
    phase: Option<GenerationPhase>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionGeneration {
    pub request_id: String,
    pub phase: GenerationPhase,
    /// Cursor of the phase transition in the existing durable event ledger.
    pub revision: u64,
}

fn latest_step(db: &Connection, run_id: &str) -> Result<Option<ModelStep>> {
    let raw: Option<String> = db.query_row(
        "SELECT body FROM model_steps WHERE run_id=?1 ORDER BY rowid DESC LIMIT 1",
        [run_id], |row| row.get(0),
    ).optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into)).transpose()
}
fn last_phase(db: &Connection, run_id: &str) -> Result<Option<(u64, PhaseFact)>> {
    let raw: Option<(u64, String)> = db.query_row(
        "SELECT cursor,data FROM events WHERE subject=?1 AND kind='generation.phase_changed' ORDER BY cursor DESC LIMIT 1",
        [run_id], |row| Ok((read_number(row, 0)?, row.get(1)?)),
    ).optional()?;
    raw.map(|(cursor, raw)| Ok((cursor, serde_json::from_str(&raw)?))).transpose()
}

impl Catalog {
    pub(crate) fn record_generation_phase(&mut self, run_id: &str, epoch: u64, request_id: &str, phase: Option<GenerationPhase>) -> Result<()> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        let active: Option<String> = tx.query_row("SELECT active_run FROM branches WHERE id=?1", [&run.branch_id], |row| row.get(0))?;
        let step = latest_step(&tx, run_id)?.ok_or_else(|| RuntimeError::Conflict("generation request is missing".into()))?;
        if run.state != RunState::Generating || active.as_deref() != Some(run_id)
            || (phase.is_some() && run.cancel_requested)
            || step.id != request_id || step.run_id != run_id || step.epoch != epoch
            || step.state != ModelStepState::Dispatched {
            return Err(RuntimeError::Conflict("generation observation is not current".into()));
        }
        if last_phase(&tx, run_id)?.is_some_and(|(_, prior)| prior.request_id == request_id && prior.owner_generation == epoch && prior.run_revision == run.revision && prior.phase == phase) {
            return Ok(());
        }
        event(&tx, run_id, run.revision, "generation.phase_changed", serde_json::to_value(PhaseFact {
            request_id: request_id.into(), owner_generation: epoch, run_revision: run.revision, phase,
        })?)?;
        tx.commit()?;
        Ok(())
    }
}

pub(super) fn read_generation(db: &Connection, run: &Run, epoch: u64) -> Result<Option<AttentionGeneration>> {
    if run.state != RunState::Generating || run.cancel_requested || run.epoch != epoch { return Ok(None); }
    let Some(step) = latest_step(db, &run.id)? else { return Ok(None); };
    if step.epoch != epoch || step.state != ModelStepState::Dispatched { return Ok(None); }
    let Some((cursor, fact)) = last_phase(db, &run.id)? else { return Ok(None); };
    if fact.request_id != step.id || fact.owner_generation != epoch || fact.run_revision != run.revision { return Ok(None); }
    Ok(fact.phase.map(|phase| AttentionGeneration { request_id: step.id, phase, revision: cursor }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetryFact {
    request_id: String,
    owner_generation: u64,
    run_revision: u64,
    scheduled: Option<RetrySchedule>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrySchedule { attempt: u64, scheduled_at_ms: u64, retry_at_ms: u64 }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionRetry {
    pub request_id: String,
    pub attempt: u64,
    pub scheduled_at_ms: u64,
    pub retry_at_ms: u64,
    pub revision: u64,
}
impl Catalog {
    pub(crate) fn record_retry_schedule(&mut self, run_id: &str, epoch: u64, request_id: &str, schedule: Option<(u64, u64)>) -> Result<()> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        let step = latest_step(&tx, run_id)?.ok_or_else(|| RuntimeError::Conflict("retry request is missing".into()))?;
        let active: Option<String> = tx.query_row("SELECT active_run FROM branches WHERE id=?1", [&run.branch_id], |row| row.get(0))?;
        if run.state != RunState::Generating || active.as_deref() != Some(run_id) || (schedule.is_some() && run.cancel_requested)
            || step.id != request_id || step.epoch != epoch || !matches!(step.state, ModelStepState::Failed | ModelStepState::Interrupted) {
            return Err(RuntimeError::Conflict("retry observation is not current".into()));
        }
        let scheduled = schedule.map(|(attempt, delay_ms)| {
            let scheduled_at_ms = super::observations::wall_time_ms()?;
            let retry_at_ms = scheduled_at_ms.checked_add(delay_ms).ok_or_else(|| RuntimeError::Invalid("retry deadline overflow".into()))?;
            Ok::<_, RuntimeError>(RetrySchedule { attempt, scheduled_at_ms, retry_at_ms })
        }).transpose()?;
        event(&tx, run_id, run.revision, "generation.retry_changed", serde_json::to_value(RetryFact {
            request_id: request_id.into(), owner_generation: epoch, run_revision: run.revision, scheduled,
        })?)?;
        tx.commit()?; Ok(())
    }
}
pub(super) fn read_retry(db: &Connection, run: &Run, epoch: u64) -> Result<Option<AttentionRetry>> {
    if run.state != RunState::Generating || run.cancel_requested || run.epoch != epoch { return Ok(None); }
    let Some(step) = latest_step(db, &run.id)? else { return Ok(None); };
    if step.epoch != epoch || !matches!(step.state, ModelStepState::Failed | ModelStepState::Interrupted) { return Ok(None); }
    let raw: Option<(u64,String)> = db.query_row("SELECT cursor,data FROM events WHERE subject=?1 AND kind='generation.retry_changed' ORDER BY cursor DESC LIMIT 1", [&run.id], |row| Ok((read_number(row,0)?,row.get(1)?))).optional()?;
    let Some((revision, raw)) = raw else { return Ok(None); };
    let fact: RetryFact = serde_json::from_str(&raw)?;
    if fact.request_id != step.id || fact.owner_generation != epoch || fact.run_revision != run.revision { return Ok(None); }
    Ok(fact.scheduled.map(|schedule| AttentionRetry { request_id: step.id, attempt: schedule.attempt, scheduled_at_ms: schedule.scheduled_at_ms, retry_at_ms: schedule.retry_at_ms, revision }))
}
