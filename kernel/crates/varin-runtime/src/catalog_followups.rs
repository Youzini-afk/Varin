//! Durable one-shot intent and trigger facts. Ingress owns delivery; Runs and delegated
//! executions own work. The native continuation worker is the only wake consumer.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance, ToolOrigin};
use activation::IngressActivationFact;
use inputs::{InputOrigin, QueuedInputMetadata};
use serde::Deserialize;
use std::sync::{atomic::Ordering, Mutex};
type Result<T> = std::result::Result<T, RuntimeError>;
pub const TOOL: &str = "follow_up";
#[path = "catalog_followup_registration.rs"]
mod registration;
pub use registration::*;
#[path = "catalog_followup_wait.rs"]
pub mod observation;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FollowupState {
    Active,
    Paused,
    Cancelled,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NextRunWaitState {
    Waiting,
    Observed,
    Consumed,
    Cancelled,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceState {
    Observed,
    Held,
    Admitted,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HoldReason {
    ControlPaused,
    SourceRunActive,
    SourceUnsettled,
    BranchActive,
    ContextScopeChanged,
    PreparationFailed,
    GoalPaused,
    GoalBudget,
    GoalBlocked,
    GoalEnded,
    GoalSuperseded,
    ManualPause,
    Question,
    Preparing,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupActor {
    User,
    Agent {
        run_id: String,
        operation_id: String,
        origin: ToolOrigin,
    },
    Goal {
        goal_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupTrigger {
    At { at_ms: u64 },
    ProcessStopped { operation_id: String },
    RunCompleted { cursor: u64 },
    GoalRequested { cursor: u64 },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TriggerEvidence {
    At {
        at_ms: u64,
        observed_at_ms: u64,
    },
    ProcessStopped {
        receipt_identity: String,
        receipt_epoch: String,
    },
    RunCompleted {
        run_revision: u64,
    },
    GoalRequested {
        run_revision: u64,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NextRunWait {
    pub id: String,
    pub kind: String,
    pub after_cursor: u64,
    pub trigger_cursor: Option<u64>,
    pub state: NextRunWaitState,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FollowupDelivery {
    pub input_id: String,
    pub state: InputState,
    pub activation_state: String,
    pub run_id: Option<String>,
    pub execution_id: Option<String>,
    pub delivered_cursor: Option<u64>,
    pub failure_code: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FollowupOccurrence {
    pub id: String,
    pub generation: u64,
    pub trigger_cursor: u64,
    pub evidence: TriggerEvidence,
    pub state: OccurrenceState,
    pub hold_reason: Option<HoldReason>,
    pub delivery: Option<FollowupDelivery>,
}
/// Only observed facts and original ingress identity are stored. State and delivery are projections.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Occurrence {
    id: String,
    generation: u64,
    trigger_cursor: u64,
    evidence: TriggerEvidence,
    input_id: Option<String>,
    preparation_failed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Followup {
    pub id: String,
    pub revision: u64,
    pub generation: u64,
    pub thread_id: String,
    pub branch_id: String,
    pub source_run_id: String,
    pub operation_id: Option<String>,
    pub goal_id: Option<String>,
    pub actor: FollowupActor,
    pub has_instruction: bool,
    pub registered_at_ms: u64,
    pub trigger: FollowupTrigger,
    pub state: FollowupState,
    pub wait: NextRunWait,
    pub observation: Option<observation::FollowupObservation>,
    pub occurrence: Option<FollowupOccurrence>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Definition {
    id: String,
    revision: u64,
    generation: u64,
    thread_id: String,
    branch_id: String,
    source_run_id: String,
    operation_id: Option<String>,
    goal_id: Option<String>,
    actor: FollowupActor,
    instruction_ref: Option<Value>,
    registered_at_ms: u64,
    observation_operation_id: Option<String>,
    trigger: FollowupTrigger,
    state: FollowupState,
    wait: NextRunWait,
    source: Option<launches::SourceSelection>,
    scope: Option<context::ContextScope>,
}
impl Definition {
    fn autonomous(&self) -> bool {
        matches!(self.actor, FollowupActor::Goal { .. })
    }
}
pub(super) fn initialize_new(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE followups(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),source_run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT REFERENCES operations(id),body TEXT NOT NULL);
      CREATE INDEX followups_thread ON followups(thread_id);
      CREATE INDEX followups_source ON followups(source_run_id);
      CREATE INDEX followups_wait_state ON followups(json_extract(body,'$.wait.state'));
      CREATE INDEX followups_deadline ON followups(json_extract(body,'$.trigger.at_ms')) WHERE json_extract(body,'$.wait.state')='waiting';
      CREATE TABLE followup_occurrences(id TEXT PRIMARY KEY,followup_id TEXT NOT NULL UNIQUE REFERENCES followups(id),input_id TEXT UNIQUE REFERENCES input_queue(id),body TEXT NOT NULL);")?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,thread_id,source_run_id,operation_id,body FROM followups")?;
    db.prepare("SELECT id,followup_id,input_id,body FROM followup_occurrences")?;
    Ok(())
}
fn occurrence(db: &Connection, id: &str) -> Result<Option<Occurrence>> {
    db.query_row(
        "SELECT body FROM followup_occurrences WHERE followup_id=?1",
        [id],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|s| Ok(serde_json::from_str(&s)?))
    .transpose()
}
pub(super) fn normalized_source(
    mut source: Option<launches::SourceSelection>,
    run: &str,
) -> Option<launches::SourceSelection> {
    if let Some(s) = source.as_mut() {
        if s.mode == SourceMode::Materialized && s.environment_run_id.is_none() {
            s.environment_run_id = Some(run.into());
        }
    }
    source
}
fn active_context(
    db: &Connection,
    branch: &str,
) -> Result<(Option<String>, Option<context::ContextScope>)> {
    let value:Option<(String,Option<String>)>=db.query_row("SELECT c.id,c.scope FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",[branch],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    match value {
        Some((id, scope)) => Ok((
            Some(id),
            scope.map(|s| serde_json::from_str(&s)).transpose()?,
        )),
        None => Ok((None, None)),
    }
}
fn latest_run(db: &Connection, branch: &str) -> Result<Run> {
    let raw: String = db.query_row(
        "SELECT body FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",
        [branch],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&raw)?)
}
fn effective_goal(db: &Connection, d: &Definition) -> Result<Option<goals::Definition>> {
    d.goal_id
        .as_ref()
        .map(|id| record(db, "goals", id))
        .transpose()
}
fn source_matches(db: &Connection, d: &Definition, run: &Run) -> Result<bool> {
    let Some(launch) =
        optional_record::<launch_content::LaunchMetadata>(db, "run_launches", &run.id)?
    else {
        return Ok(false);
    };
    if run.thread_id != d.thread_id
        || run.branch_id != d.branch_id
        || active_context(db, &d.branch_id)?.1 != d.scope
    {
        return Ok(false);
    }
    if normalized_source(launch.selection.source.clone(), &run.id)
        == normalized_source(d.source.clone(), &d.source_run_id)
    {
        return Ok(true);
    }
    // Sanctioned child changes are derived solely from every original immutable predecessor.
    let source_run: Run = record(db, "runs", &d.source_run_id)?;
    let original: launch_content::LaunchMetadata = record(db, "run_launches", &source_run.id)?;
    if normalized_source(original.selection.source, &source_run.id)
        != normalized_source(d.source.clone(), &d.source_run_id)
    {
        return Ok(false);
    }
    if process_wait::delegated_source_lineage(db, &source_run, run)?.is_some() {
        return Ok(true);
    }

    Ok(false)
}
fn dependency_check_eligible(
    db: &Connection,
    d: &Definition,
    goal: &goals::Definition,
) -> Result<bool> {
    if !matches!(d.trigger, FollowupTrigger::At { .. })
        || d.autonomous()
        || goal.blocked != Some(goals::GoalBlockReason::Dependency)
    {
        return Ok(false);
    }
    let Some(id) = &goal.dependency_operation_id else {
        return Ok(false);
    };
    let process: Operation = record(db, "operations", id)?;
    let owner: Run = record(db, "runs", &process.run_id)?;
    let launch: launch_content::LaunchMetadata = record(db, "run_launches", &owner.id)?;
    let intent = tool_content::ToolIntent::from_operation(&process)?;
    Ok(
        goals::for_run(db, &owner.id)?.is_some_and(|g| g.id == goal.id)
            && owner.thread_id == d.thread_id
            && owner.branch_id == d.branch_id
            && normalized_source(launch.selection.source, &owner.id)
                == normalized_source(d.source.clone(), &d.source_run_id)
            && matches!(process.lifetime, Lifetime::Thread | Lifetime::Environment)
            && process.executor.as_deref() == Some("process_spawn")
            && process.execution_owner == Some(ExecutorOwner::Kernel)
            && intent.call().name == "process_spawn"
            && intent.contract().completion == crate::execution::CompletionKind::Job
            && matches!(process.call_completion,Some(result_content::ToolCompletionMetadata::JobAccepted{operation_id,..}) if operation_id==process.id),
    )
}
fn goal_hold(db: &Connection, d: &Definition) -> Result<Option<HoldReason>> {
    let Some(goal) = effective_goal(db, d)? else {
        return Ok(None);
    };
    if goal.ended() {
        return Ok(Some(HoldReason::GoalEnded));
    }
    if goal.control == goals::GoalControl::Paused {
        return Ok(Some(HoldReason::GoalPaused));
    }
    let usage: goals::GoalUsage = record(db, "goal_usage", &goal.id)?;
    if goals::budget_limited(&goal, &usage) {
        return Ok(Some(HoldReason::GoalBudget));
    }
    if goals::usage_unknown(&goal, &usage)
        || (goal.blocked.is_some() && !dependency_check_eligible(db, d, &goal)?)
    {
        return Ok(Some(HoldReason::GoalBlocked));
    }
    Ok(None)
}
fn eligibility(
    db: &Connection,
    d: &Definition,
    target: Option<&Run>,
) -> Result<Option<HoldReason>> {
    if d.state == FollowupState::Paused {
        return Ok(Some(HoldReason::ControlPaused));
    }
    if let Some(reason) = goal_hold(db, d)? {
        return Ok(Some(reason));
    }
    let source: Run = record(db, "runs", &d.source_run_id)?;
    let current = target
        .cloned()
        .map(Ok)
        .unwrap_or_else(|| latest_run(db, &d.branch_id))?;
    if !source_matches(db, d, &current)? {
        return Ok(Some(HoldReason::ContextScopeChanged));
    }
    if d.autonomous() {
        if !source.state.terminal() {
            return Ok(Some(HoldReason::SourceRunActive));
        }
        if let Some(goal) = effective_goal(db, d)? {
            if !matches!(d.trigger, FollowupTrigger::ProcessStopped { .. })
                && goal.source_run_id != d.source_run_id
            {
                return Ok(Some(HoldReason::GoalSuperseded));
            }
            let unsettled:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM operations o JOIN goal_runs g ON g.id=o.run_id WHERE g.goal_id=?1 AND (json_extract(o.body,'$.phase')!='terminal' OR json_extract(o.body,'$.effect')='unknown' OR json_extract(o.body,'$.outcome')='indeterminate' OR EXISTS(SELECT 1 FROM resource_occupancy x WHERE x.operation_id=o.id))) OR EXISTS(SELECT 1 FROM context_jobs j JOIN goal_runs g ON g.id=j.owner_run_id JOIN runs r ON r.id=j.run_id WHERE g.goal_id=?1 AND json_extract(r.body,'$.state') NOT IN ('completed','failed','cancelled'))",[&goal.id],|r|r.get(0))?;
            if unsettled {
                return Ok(Some(HoldReason::SourceUnsettled));
            }
        }
        let busy:bool=db.query_row("SELECT active_run IS NOT NULL OR EXISTS(SELECT 1 FROM input_queue WHERE branch_id=?1 AND state='queued' AND activation='activating') FROM branches WHERE id=?1",[&d.branch_id],|r|r.get(0))?;
        if busy {
            return Ok(Some(HoldReason::BranchActive));
        }
    }
    if let Some(id) = &d.operation_id {
        let op: Operation = record(db, "operations", id)?;
        let occupied: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM resource_occupancy WHERE operation_id=?1)",
            [id],
            |r| r.get(0),
        )?;
        if op.phase != OperationPhase::Terminal
            || occupied
            || !op
                .external_receipt
                .as_ref()
                .is_some_and(|r| r.executor_stopped)
        {
            return Ok(Some(HoldReason::SourceUnsettled));
        }
    }
    Ok(None)
}
fn observe(tx: &Transaction<'_>, d: &mut Definition, now: u64) -> Result<bool> {
    if d.state == FollowupState::Cancelled || d.wait.state != NextRunWaitState::Waiting {
        return Ok(false);
    }
    let run: Run = record(tx, "runs", &d.source_run_id)?;
    let (cursor, evidence) = match &d.trigger {
        FollowupTrigger::At { at_ms } => {
            if now < *at_ms {
                return Ok(false);
            }
            let cursor = event(
                tx,
                &d.id,
                d.revision,
                "followup.time_reached",
                json!({"at_ms":at_ms,"observed_at_ms":now}),
            )?;
            (
                cursor,
                TriggerEvidence::At {
                    at_ms: *at_ms,
                    observed_at_ms: now,
                },
            )
        }
        FollowupTrigger::ProcessStopped { operation_id } => {
            let op: Operation = record(tx, "operations", operation_id)?;
            let Some(r) = op.external_receipt.as_ref().filter(|r| r.executor_stopped) else {
                return Ok(false);
            };
            if r.identity != op.id
                || r.executor != "process_spawn"
                || op.execution_owner != Some(ExecutorOwner::Kernel)
            {
                return Err(RuntimeError::Invalid(
                    "process stop receipt owner mismatch".into(),
                ));
            }
            let cursor=tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='operation.executor_stopped' AND json_extract(data,'$.receipt_identity')=?2 AND json_extract(data,'$.receipt_epoch')=?3 ORDER BY cursor LIMIT 1",params![op.id,r.identity,r.epoch],|r|read_number(r,0))?;
            if d.autonomous() {
                if let Some(goal) = &d.goal_id {
                    goals::clear_dependency(tx, goal, operation_id)?;
                }
            }
            (
                cursor,
                TriggerEvidence::ProcessStopped {
                    receipt_identity: r.identity.clone(),
                    receipt_epoch: r.epoch.clone(),
                },
            )
        }
        FollowupTrigger::RunCompleted { cursor } => {
            if run.state != RunState::Completed {
                return Ok(false);
            };
            (
                *cursor,
                TriggerEvidence::RunCompleted {
                    run_revision: run.revision,
                },
            )
        }
        FollowupTrigger::GoalRequested { cursor } => {
            if !run.state.terminal() {
                return Ok(false);
            };
            (
                *cursor,
                TriggerEvidence::GoalRequested {
                    run_revision: run.revision,
                },
            )
        }
    };
    let v = Occurrence {
        id: format!("{}:{}:{cursor}", d.id, d.generation),
        generation: d.generation,
        trigger_cursor: cursor,
        evidence,
        input_id: None,
        preparation_failed: false,
    };
    tx.execute(
        "INSERT INTO followup_occurrences(id,followup_id,input_id,body) VALUES(?1,?2,NULL,?3)",
        params![v.id, d.id, encode(&v)?],
    )?;
    d.wait.trigger_cursor = Some(cursor);
    d.wait.state = NextRunWaitState::Observed;
    put(tx, "followups", &d.id, d)?;
    event(
        tx,
        &d.id,
        d.revision,
        "followup.observed",
        json!({"occurrence_id":v.id,"trigger_cursor":cursor}),
    )?;
    Ok(true)
}
fn project_occurrence(
    db: &Connection,
    d: &Definition,
    v: Occurrence,
) -> Result<FollowupOccurrence> {
    let mut state = OccurrenceState::Observed;
    let mut hold = if v.preparation_failed {
        Some(HoldReason::PreparationFailed)
    } else {
        eligibility(db, d, None)?
    };
    let mut delivery = None;
    if let Some(id) = &v.input_id {
        let row: QueuedInputMetadata = record(db, "input_queue", id)?;
        let activation = activation::fact(&row)?;
        let (activation_state, run_id, execution_id, failure_code) = match activation {
            IngressActivationFact::Pending { execution_id } => {
                ("pending", None, execution_id.clone(), None)
            }
            IngressActivationFact::Bound {
                run_id,
                execution_id,
            } => ("bound", Some(run_id.clone()), execution_id.clone(), None),
            IngressActivationFact::Cancelled {
                run_id,
                execution_id,
            } => ("cancelled", run_id.clone(), execution_id.clone(), None),
            IngressActivationFact::Failed { execution_id, code } => {
                ("failed", None, execution_id.clone(), Some(code.clone()))
            }
            IngressActivationFact::Passive => {
                return Err(RuntimeError::Invalid("follow-up cannot be passive".into()))
            }
        };
        state = match activation_state {
            "cancelled" => OccurrenceState::Cancelled,
            "failed" => OccurrenceState::Failed,
            "bound" => OccurrenceState::Admitted,
            _ => OccurrenceState::Observed,
        };
        if row.state == InputState::Delivered {
            hold = None;
            if let Some(run) = &run_id {
                state = match record::<Run>(db, "runs", run)?.state {
                    RunState::Completed => OccurrenceState::Completed,
                    RunState::Failed => OccurrenceState::Failed,
                    RunState::Cancelled => OccurrenceState::Cancelled,
                    _ => OccurrenceState::Admitted,
                };
            }
        } else if let Some(run) = &run_id {
            let run: Run = record(db, "runs", run)?;
            hold = ingress_hold(db, &row, Some(&run))?;
            if hold.is_none() {
                hold = match activation::run_hold(db, &run)? {
                    Some(activation::MessageActivationHold::ManualPause) => {
                        Some(HoldReason::ManualPause)
                    }
                    Some(activation::MessageActivationHold::Question) => Some(HoldReason::Question),
                    Some(activation::MessageActivationHold::Preparing) => {
                        Some(HoldReason::Preparing)
                    }
                    _ => None,
                };
            }
        } else if hold.is_none() {
            hold = Some(HoldReason::Preparing)
        }
        delivery = Some(FollowupDelivery {
            input_id: id.clone(),
            state: row.state,
            activation_state: activation_state.into(),
            run_id,
            execution_id,
            delivered_cursor: row.delivered_cursor,
            failure_code,
        });
    }
    if d.state == FollowupState::Cancelled
        && !delivery
            .as_ref()
            .is_some_and(|r| r.state == InputState::Delivered)
    {
        state = OccurrenceState::Cancelled;
        hold = None;
    } else if hold.is_some()
        && !matches!(state, OccurrenceState::Cancelled | OccurrenceState::Failed)
    {
        state = OccurrenceState::Held;
    }
    Ok(FollowupOccurrence {
        id: v.id,
        generation: v.generation,
        trigger_cursor: v.trigger_cursor,
        evidence: v.evidence,
        state,
        hold_reason: hold,
        delivery,
    })
}
fn project(db: &Connection, d: Definition) -> Result<Followup> {
    let occurrence = occurrence(db, &d.id)?
        .map(|v| project_occurrence(db, &d, v))
        .transpose()?;
    let observation = d
        .observation_operation_id
        .as_ref()
        .map(|id| observation::project(db, id))
        .transpose()?;
    Ok(Followup {
        id: d.id,
        revision: d.revision,
        generation: d.generation,
        thread_id: d.thread_id,
        branch_id: d.branch_id,
        source_run_id: d.source_run_id,
        operation_id: d.operation_id,
        goal_id: d.goal_id,
        actor: d.actor,
        has_instruction: d.instruction_ref.is_some(),
        registered_at_ms: d.registered_at_ms,
        trigger: d.trigger,
        state: d.state,
        wait: d.wait,
        observation,
        occurrence,
    })
}
pub(super) fn goal_projection_hold(db: &Connection, goal_id: &str) -> Result<Option<HoldReason>> {
    let mut q=db.prepare("SELECT f.body,o.body FROM followups f JOIN followup_occurrences o ON o.followup_id=f.id WHERE json_extract(f.body,'$.goal_id')=?1 AND json_extract(f.body,'$.actor.kind')='goal' ORDER BY o.rowid DESC")?;
    let rows = q
        .query_map([goal_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (d, o) in rows {
        let d: Definition = serde_json::from_str(&d)?;
        let o: Occurrence = serde_json::from_str(&o)?;
        let p = project_occurrence(db, &d, o)?;
        if matches!(
            p.hold_reason,
            Some(
                HoldReason::SourceUnsettled
                    | HoldReason::ContextScopeChanged
                    | HoldReason::PreparationFailed
            )
        ) {
            return Ok(p.hold_reason);
        }
    }
    Ok(None)
}
fn cancel_definition(tx: &Transaction<'_>, d: &mut Definition) -> Result<()> {
    if d.state == FollowupState::Cancelled || d.wait.state == NextRunWaitState::Consumed {
        return Ok(());
    }
    d.state = FollowupState::Cancelled;
    d.revision += 1;
    d.wait.state = NextRunWaitState::Cancelled;
    put(tx, "followups", &d.id, d)?;
    if let Some(v) = occurrence(tx, &d.id)? {
        if let Some(id) = v.input_id {
            let mut row = record(tx, "input_queue", &id)?;
            activation::cancel_row(tx, &mut row)?;
        }
    }
    observation::cancel_definition(tx, d)?;
    event(tx, &d.id, d.revision, "followup.cancelled", Value::Null)?;
    Ok(())
}
pub(super) fn cancel_source_run(tx: &Transaction<'_>, run: &str) -> Result<()> {
    cancel_source_registrations(tx, run, false)
}
pub(super) fn cancel_tree_source_run(tx: &Transaction<'_>, run: &str) -> Result<()> {
    cancel_source_registrations(tx, run, true)
}
fn cancel_source_registrations(tx: &Transaction<'_>, run: &str, goals: bool) -> Result<()> {
    let rows = {
        let mut q = tx.prepare("SELECT body FROM followups WHERE source_run_id=?1")?;
        let r = q.query_map([run], |r| r.get::<_, String>(0))?;
        r.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for raw in rows {
        let mut d: Definition = serde_json::from_str(&raw)?;
        if goals || !d.autonomous() {
            cancel_definition(tx, &mut d)?;
        }
    }
    Ok(())
}
pub(super) fn settle_run(_tx: &Transaction<'_>, _run: &Run) -> Result<()> {
    Ok(())
}
fn definition_for_run(
    db: &Connection,
    key: &str,
    run: &Run,
    trigger: FollowupTrigger,
    actor: FollowupActor,
    goal: Option<String>,
    now: u64,
) -> Result<Definition> {
    context_jobs::require_regular_branch(db, &run.branch_id)?;
    let launch: launch_content::LaunchMetadata = record(db, "run_launches", &run.id)?;
    let cursor = db.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
        read_number(r, 0)
    })?;
    let operation_id = if let FollowupTrigger::ProcessStopped { operation_id } = &trigger {
        Some(operation_id.clone())
    } else {
        None
    };
    let kind = match trigger {
        FollowupTrigger::At { .. } => "at",
        FollowupTrigger::ProcessStopped { .. } => "process_stopped",
        FollowupTrigger::RunCompleted { .. } => "run_completed",
        FollowupTrigger::GoalRequested { .. } => "goal_requested",
    };
    Ok(Definition {
        id: key.into(),
        revision: 1,
        generation: 1,
        thread_id: run.thread_id.clone(),
        branch_id: run.branch_id.clone(),
        source_run_id: run.id.clone(),
        operation_id,
        goal_id: goal,
        actor,
        instruction_ref: None,
        registered_at_ms: now,
        observation_operation_id: None,
        trigger,
        state: FollowupState::Active,
        wait: NextRunWait {
            id: format!("followup-trigger:{key}"),
            kind: kind.into(),
            after_cursor: cursor,
            trigger_cursor: None,
            state: NextRunWaitState::Waiting,
        },
        source: launch.selection.source,
        scope: active_context(db, &run.branch_id)?.1,
    })
}
fn insert(tx: &Transaction<'_>, d: &Definition) -> Result<()> {
    tx.execute("INSERT INTO followups(id,thread_id,source_run_id,operation_id,body) VALUES(?1,?2,?3,?4,?5)",params![d.id,d.thread_id,d.source_run_id,d.operation_id,encode(d)?])?;
    event(
        tx,
        &d.id,
        1,
        "followup.registered",
        json!({"thread_id":d.thread_id,"branch_id":d.branch_id,"source_run_id":d.source_run_id}),
    )?;
    Ok(())
}
fn require_process(db: &Connection, run: &Run, id: &str) -> Result<()> {
    let process = process_wait::process_observation(db, run, id)?;
    if !matches!(process.lifetime, Lifetime::Thread | Lifetime::Environment) {
        return Err(RuntimeError::Conflict(
            "follow-up requires original Thread or Environment process lifetime".into(),
        ));
    }
    Ok(())
}
pub(super) fn register_process_tx(
    tx: &Transaction<'_>,
    key: &str,
    run_id: &str,
    operation_id: &str,
    goal_id: Option<&str>,
) -> Result<Followup> {
    if let Some(d) = optional_record::<Definition>(tx, "followups", key)? {
        if d.source_run_id != run_id
            || d.operation_id.as_deref() != Some(operation_id)
            || d.goal_id.as_deref() != goal_id
        {
            return Err(RuntimeError::Conflict(
                "follow-up key has different source".into(),
            ));
        }
        return project(tx, d);
    }
    let run: Run = record(tx, "runs", run_id)?;
    require_process(tx, &run, operation_id)?;
    let goal = goal_id.ok_or_else(|| {
        RuntimeError::Invalid("internal process dependency requires its Goal".into())
    })?;
    let mut d = definition_for_run(
        tx,
        key,
        &run,
        FollowupTrigger::ProcessStopped {
            operation_id: operation_id.into(),
        },
        FollowupActor::Goal {
            goal_id: goal.into(),
        },
        Some(goal.into()),
        observations::wall_time_ms()?,
    )?;
    insert(tx, &d)?;
    observe(tx, &mut d, observations::wall_time_ms()?)?;
    project(tx, d)
}
pub(super) fn register_goal_continuation(
    tx: &Transaction<'_>,
    goal: &goals::Definition,
    run: &Run,
    requested: Option<u64>,
) -> Result<()> {
    let cursor=match requested{Some(c)=>c,None=>tx.query_row("SELECT max(cursor) FROM events WHERE subject=?1 AND kind IN ('run.changed','execution.committed')",[&run.id],|r|read_number(r,0))?};
    let key = match requested {
        Some(c) => format!("goal:{}:requested:{c}", goal.id),
        None => format!("goal:{}:completed:{}", goal.id, run.id),
    };
    if optional_record::<Definition>(tx, "followups", &key)?.is_some() {
        return Ok(());
    }
    let raws = {
        let mut q=tx.prepare("SELECT body FROM followups WHERE json_extract(body,'$.actor.kind')='goal' AND json_extract(body,'$.goal_id')=?1 AND operation_id IS NULL AND json_extract(body,'$.wait.state') IN ('waiting','observed')")?;
        let rows = q.query_map([&goal.id], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for raw in raws {
        cancel_definition(tx, &mut serde_json::from_str(&raw)?)?;
    }
    let trigger = if requested.is_some() {
        FollowupTrigger::GoalRequested { cursor }
    } else {
        FollowupTrigger::RunCompleted { cursor }
    };
    let mut d = definition_for_run(
        tx,
        &key,
        run,
        trigger,
        FollowupActor::Goal {
            goal_id: goal.id.clone(),
        },
        Some(goal.id.clone()),
        observations::wall_time_ms()?,
    )?;
    insert(tx, &d)?;
    observe(tx, &mut d, observations::wall_time_ms()?)?;
    Ok(())
}

pub(super) fn ingress_hold(
    db: &Connection,
    row: &QueuedInputMetadata,
    target: Option<&Run>,
) -> Result<Option<HoldReason>> {
    let InputOrigin::Followup {
        followup_id,
        occurrence_id,
        generation,
        ..
    } = &row.origin
    else {
        return Ok(None);
    };
    let d: Definition = record(db, "followups", followup_id)?;
    let v = occurrence(db, followup_id)?
        .ok_or_else(|| RuntimeError::Invalid("follow-up occurrence missing".into()))?;
    if d.generation != *generation
        || v.id != *occurrence_id
        || v.input_id.as_deref() != Some(&row.id)
    {
        return Err(RuntimeError::Conflict(
            "follow-up ingress identity changed".into(),
        ));
    }
    if d.state == FollowupState::Cancelled {
        return Ok(Some(HoldReason::ControlPaused));
    }
    if d.state == FollowupState::Paused {
        return Ok(Some(HoldReason::ControlPaused));
    }
    if let Some(reason) = goal_hold(db, &d)? {
        return Ok(Some(reason));
    }
    let run = target
        .cloned()
        .map(Ok)
        .unwrap_or_else(|| latest_run(db, &d.branch_id))?;
    if !source_matches(db, &d, &run)? {
        return Ok(Some(HoldReason::ContextScopeChanged));
    }
    Ok(None)
}
/// Rebinding a still-unconsumed intent may use the current Goal generation. Once delivered,
/// changing the Goal revokes this single check; it never mutates the original dependency block.
pub(super) fn refresh_ingress_goal(
    tx: &Transaction<'_>,
    row: &mut QueuedInputMetadata,
) -> Result<()> {
    let InputOrigin::Followup {
        followup_id, goal, ..
    } = &mut row.origin
    else {
        return Ok(());
    };
    let d: Definition = record(tx, "followups", followup_id)?;
    *goal = effective_goal(tx, &d)?.map(|d| d.binding());
    Ok(())
}
pub(super) fn dependency_check_for_run(
    db: &Connection,
    run: &str,
    goal: &goals::Definition,
) -> Result<bool> {
    if goal.control != goals::GoalControl::Active
        || goal.blocked != Some(goals::GoalBlockReason::Dependency)
    {
        return Ok(false);
    }
    let mut q=db.prepare("SELECT body FROM input_queue WHERE run_id=?1 AND origin='followup' AND state IN ('queued','delivered')")?;
    let rows = q.query_map([run], |r| r.get::<_, String>(0))?;
    for raw in rows {
        let row: QueuedInputMetadata = serde_json::from_str(&raw?)?;
        let InputOrigin::Followup {
            followup_id,
            goal: binding,
            ..
        } = &row.origin
        else {
            continue;
        };
        if binding.as_ref() != Some(&goal.binding())
            || !matches!(activation::fact(&row)?,IngressActivationFact::Bound{run_id,..} if run_id==run)
        {
            continue;
        }
        let d: Definition = record(db, "followups", followup_id)?;
        if d.goal_id.as_deref() == Some(&goal.id)
            && d.state == FollowupState::Active
            && dependency_check_eligible(db, &d, goal)?
            && ingress_hold(db, &row, Some(&record(db, "runs", run)?))?.is_none()
        {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(super) fn delivered(tx: &Transaction<'_>, row: &QueuedInputMetadata) -> Result<()> {
    let InputOrigin::Followup { followup_id, .. } = &row.origin else {
        return Ok(());
    };
    let mut d: Definition = record(tx, "followups", followup_id)?;
    if d.wait.state != NextRunWaitState::Consumed {
        d.wait.state = NextRunWaitState::Consumed;
        put(tx, "followups", &d.id, &d)?;
        event(
            tx,
            &d.id,
            d.revision,
            "followup.delivered",
            json!({"input_id":row.id,"run_id":row.run_id,"delivered_cursor":row.delivered_cursor}),
        )?;
    }
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowupView {
    pub followup: Followup,
    pub instruction: Option<String>,
}
pub struct FollowupRead {
    followup: Followup,
    instruction: Option<Value>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl FollowupRead {
    pub fn load(self) -> Result<FollowupView> {
        Ok(FollowupView {
            followup: self.followup,
            instruction: self
                .instruction
                .map(|r| {
                    self.content
                        .load(&r)
                        .and_then(|v| Ok(serde_json::from_value(v)?))
                })
                .transpose()?,
        })
    }
}
impl Catalog {
    pub fn followup(&self, id: &str) -> Result<Followup> {
        project(&self.db, record(&self.db, "followups", id)?)
    }
    pub fn followups(&self, thread: &str) -> Result<Vec<Followup>> {
        let mut q = self
            .db
            .prepare("SELECT body FROM followups WHERE thread_id=?1 ORDER BY rowid")?;
        let result = q
            .query_map([thread], |r| r.get::<_, String>(0))?
            .map(|r| project(&self.db, serde_json::from_str(&r?)?))
            .collect();
        result
    }
    pub fn capture_followup(&self, id: &str) -> Result<FollowupRead> {
        let d: Definition = record(&self.db, "followups", id)?;
        Ok(FollowupRead {
            instruction: d.instruction_ref.clone(),
            followup: project(&self.db, d)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn control_followup(
        &mut self,
        id: &str,
        revision: u64,
        action: FollowupControlAction,
    ) -> Result<Followup> {
        let tx = self.db.transaction()?;
        let result = control_tx(&tx, id, revision, action)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn stop_followup_admission(&self) {
        self.continuation_stopping.store(true, Ordering::Release);
    }
    pub fn nearest_followup_deadline(&self) -> Result<Option<u64>> {
        self.db.query_row("SELECT min(json_extract(body,'$.trigger.at_ms')) FROM followups WHERE json_extract(body,'$.wait.state')='waiting' AND json_extract(body,'$.state')!='cancelled' AND json_extract(body,'$.trigger.kind')='at'",[],|r|r.get::<_,Option<i64>>(0))?.map(|n|u64::try_from(n).map_err(|_|RuntimeError::Invalid("negative follow-up deadline".into()))).transpose()
    }
    pub fn reconcile_followup_facts_at(&mut self, now: u64) -> Result<usize> {
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Ok(0);
        }
        let tx = self.db.transaction()?;
        let rows = {
            let mut q = tx.prepare(
                "SELECT body FROM followups WHERE json_extract(body,'$.wait.state')='waiting'",
            )?;
            let r = q.query_map([], |r| r.get::<_, String>(0))?;
            r.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut count = 0;
        let mut failure = None;
        for raw in rows {
            tx.execute_batch("SAVEPOINT followup_fact")?;
            let result = (|| {
                let mut d = serde_json::from_str(&raw)?;
                observe(&tx, &mut d, now)
            })();
            match result {
                Ok(changed) => {
                    count += usize::from(changed);
                    tx.execute_batch("RELEASE followup_fact")?;
                }
                Err(error) => {
                    tx.execute_batch("ROLLBACK TO followup_fact; RELEASE followup_fact")?;
                    failure.get_or_insert(error);
                }
            }
        }
        tx.commit()?;
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok(count)
        }
    }
}
fn control_tx(
    tx: &Transaction<'_>,
    id: &str,
    revision: u64,
    action: FollowupControlAction,
) -> Result<Followup> {
    let mut d: Definition = record(tx, "followups", id)?;
    if d.autonomous() {
        return Err(RuntimeError::Conflict(
            "Goal-owned continuation is controlled through its Goal".into(),
        ));
    }
    if d.wait.state == NextRunWaitState::Consumed || d.state == FollowupState::Cancelled {
        return project(tx, d);
    }
    if d.revision != revision {
        return Err(RuntimeError::Conflict("follow-up revision changed".into()));
    }
    match action {
        FollowupControlAction::Cancel => cancel_definition(tx, &mut d)?,
        _ => {
            let state = if action == FollowupControlAction::Pause {
                FollowupState::Paused
            } else {
                FollowupState::Active
            };
            if let Some(mut v) = occurrence(tx, id)? {
                if action == FollowupControlAction::Resume {
                    v.preparation_failed = false;
                    put(tx, "followup_occurrences", &v.id, &v)?;
                    if let Some(input) = v.input_id {
                        let mut row: QueuedInputMetadata = record(tx, "input_queue", &input)?;
                        if matches!(
                            activation::fact(&row)?,
                            IngressActivationFact::Failed {
                                execution_id: None,
                                ..
                            }
                        ) {
                            activation::write_changed(
                                tx,
                                &mut row,
                                IngressActivationFact::Pending { execution_id: None },
                            )?;
                        }
                        if row.state == InputState::Queued {
                            refresh_ingress_goal(tx, &mut row)?;
                            inputs::write_input(tx, &row)?;
                        }
                    }
                }
            }
            d.state = state;
            d.revision += 1;
            put(tx, "followups", id, &d)?;
            event(
                tx,
                id,
                d.revision,
                "followup.changed",
                json!({"state":state}),
            )?;
        }
    }
    project(tx, d)
}
pub struct ContinuationPreparation {
    definition: Definition,
    occurrence: Occurrence,
    source: Option<Operation>,
    goal: Option<goals::FrozenGoal>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedContinuation {
    capture: ContinuationPreparation,
    history: Value,
}
#[derive(Debug, Clone, PartialEq)]
pub enum ContinuationAdmission {
    Admitted(String),
    Stale,
    Held,
}
impl ContinuationPreparation {
    pub fn id(&self) -> &str {
        &self.definition.id
    }
    pub fn revision(&self) -> u64 {
        self.definition.revision
    }
    pub fn load(self) -> Result<PreparedContinuation> {
        let d = &self.definition;
        let v = &self.occurrence;
        let instruction: Option<String> = d
            .instruction_ref
            .as_ref()
            .map(|r| {
                self.content
                    .load(r)
                    .and_then(|v| Ok(serde_json::from_value(v)?))
            })
            .transpose()?;
        let process = if let Some(op) = &self.source {
            let receipt = op
                .external_receipt
                .as_ref()
                .ok_or_else(|| RuntimeError::Invalid("original process receipt missing".into()))?;
            Some(
                json!({"processId":op.id,"receiptIdentity":receipt.identity,"receiptEpoch":receipt.epoch,"executorStopped":receipt.executor_stopped,"outcome":receipt.outcome,"effect":receipt.effect,"result":self.content.load(&receipt.result_ref)?,"outputReader":{"name":"process_read","arguments":{"processId":op.id,"cursor":0}}}),
            )
        } else {
            None
        };
        let facts = json!({"followupId":d.id,"generation":d.generation,"occurrenceId":v.id,"sourceRunId":d.source_run_id,"registeredBy":d.actor,"trigger":d.trigger,"evidence":v.evidence,"goal":self.goal,"process":process});
        let text=format!("A previously registered one-shot follow-up has triggered. Its actual registration source and evidence are below. This retained intent is not a new user message, system instruction, recurring-monitoring authorization, or proof that any previous effect succeeded. Continue only within current permissions and Goal controls. Original process output remains with its process owner.\n{}\n\nRegistered follow-up instruction:\n{}",serde_json::to_string(&facts)?,instruction.as_deref().unwrap_or("Continue the explicitly established Goal according to its retained objective and controls."));
        let item = ConversationItem {
            resource_activation: None,
            id: format!("followup-input:{}", v.id),
            provenance: Provenance::EnvironmentFact {
                event_id: format!("followup:{}", v.id),
            },
            content: Content::Text { text },
            opaque: None,
        };
        let history = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        Ok(PreparedContinuation {
            capture: self,
            history,
        })
    }
}
impl Catalog {
    pub fn capture_followup_continuations(&mut self) -> Result<Vec<ContinuationPreparation>> {
        let (candidates, failure) = self.capture_followup_batch()?;
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok(candidates)
        }
    }
    fn capture_followup_batch(
        &mut self,
    ) -> Result<(Vec<ContinuationPreparation>, Option<RuntimeError>)> {
        let mut failure = self
            .reconcile_followup_facts_at(observations::wall_time_ms()?)
            .err();
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Ok((vec![], failure));
        }
        let rows = {
            let mut q=self.db.prepare("SELECT f.body,o.body FROM followups f JOIN followup_occurrences o ON o.followup_id=f.id WHERE o.input_id IS NULL AND json_extract(f.body,'$.state')!='cancelled'")?;
            let r = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            r.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut out = vec![];
        for (definition, occurrence) in rows {
            let candidate = (|| -> Result<Option<ContinuationPreparation>> {
                let d: Definition = serde_json::from_str(&definition)?;
                let v: Occurrence = serde_json::from_str(&occurrence)?;
                if v.preparation_failed || eligibility(&self.db, &d, None)?.is_some() {
                    return Ok(None);
                }
                let source = d
                    .operation_id
                    .as_ref()
                    .map(|id| record(&self.db, "operations", id))
                    .transpose()?;
                let goal = effective_goal(&self.db, &d)?.map(|g| g.binding());
                Ok(Some(ContinuationPreparation {
                    definition: d,
                    occurrence: v,
                    source,
                    goal,
                    epoch: self.epoch,
                    content: self.content.clone(),
                    publication: self.content.begin_publication(),
                }))
            })();
            match candidate {
                Ok(Some(p)) => out.push(p),
                Ok(None) => (),
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        Ok((out, failure))
    }
    pub fn fail_followup_preparation(&mut self, id: &str, revision: u64) -> Result<()> {
        let tx = self.db.transaction()?;
        let d: Definition = record(&tx, "followups", id)?;
        if d.revision == revision && d.state != FollowupState::Cancelled {
            if let Some(mut v) = occurrence(&tx, id)? {
                if v.input_id.is_none() && !v.preparation_failed {
                    v.preparation_failed = true;
                    put(&tx, "followup_occurrences", &v.id, &v)?;
                    event(
                        &tx,
                        id,
                        revision,
                        "followup.preparation_failed",
                        json!({"occurrence_id":v.id}),
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn admit_followup_continuation(
        &mut self,
        p: PreparedContinuation,
    ) -> Result<ContinuationAdmission> {
        let PreparedContinuation {
            capture: c,
            history,
        } = p;
        let _publication = c.publication;
        if c.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "follow-up owner changed or stopped".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let d: Definition = record(&tx, "followups", &c.definition.id)?;
        let mut v = occurrence(&tx, &d.id)?
            .ok_or_else(|| RuntimeError::Invalid("follow-up occurrence disappeared".into()))?;
        if let Some(id) = v.input_id {
            return Ok(ContinuationAdmission::Admitted(id));
        }
        if d != c.definition
            || v != c.occurrence
            || effective_goal(&tx, &d)?.map(|d| d.binding()) != c.goal
            || c.source
                .as_ref()
                .map(|o| record::<Operation>(&tx, "operations", &o.id).map(|v| v != *o))
                .transpose()?
                .unwrap_or(false)
        {
            return Ok(ContinuationAdmission::Stale);
        }
        if d.state == FollowupState::Cancelled || eligibility(&tx, &d, None)?.is_some() {
            return Ok(ContinuationAdmission::Held);
        }
        let input_id = format!("followup-input:{}", v.id);
        let activation = activation::accept_target(&tx, &d.thread_id, &d.branch_id)?;
        let cursor = event(
            &tx,
            &d.id,
            d.revision,
            "followup.input_accepted",
            json!({"occurrence_id":v.id,"input_id":input_id}),
        )?;
        ingress::insert_occurrence(
            &tx,
            input_id.clone(),
            d.thread_id.clone(),
            d.branch_id.clone(),
            cursor,
            InputOrigin::Followup {
                followup_id: d.id.clone(),
                occurrence_id: v.id.clone(),
                generation: d.generation,
                activation,
                goal: c.goal,
            },
            &history,
        )?;
        v.input_id = Some(input_id.clone());
        tx.execute(
            "UPDATE followup_occurrences SET input_id=?2,body=?3 WHERE id=?1",
            params![v.id, input_id, encode(&v)?],
        )?;
        tx.commit()?;
        Ok(ContinuationAdmission::Admitted(input_id))
    }
}
pub fn reconcile(catalog: &Mutex<Catalog>) -> Result<Vec<String>> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))
    };
    let mut failure = None;
    loop {
        let candidates = match lock()?.capture_followup_batch() {
            Ok((v, e)) => {
                if let Some(e) = e {
                    failure.get_or_insert(e);
                }
                v
            }
            Err(e) => {
                failure.get_or_insert(e);
                Vec::new()
            }
        };
        let mut stale = false;
        for candidate in candidates {
            let id = candidate.id().to_owned();
            let revision = candidate.revision();
            let prepared = match candidate.load() {
                Ok(v) => v,
                Err(e) => {
                    failure.get_or_insert(e);
                    if let Err(e) = lock()?.fail_followup_preparation(&id, revision) {
                        failure.get_or_insert(e);
                    }
                    continue;
                }
            };
            match lock()?.admit_followup_continuation(prepared) {
                Ok(ContinuationAdmission::Stale) => stale = true,
                Ok(_) => (),
                Err(e) => {
                    failure.get_or_insert(e);
                    if let Err(e) = lock()?.fail_followup_preparation(&id, revision) {
                        failure.get_or_insert(e);
                    }
                }
            }
        }
        if !stale {
            break;
        }
    }
    let activation = activation::reconcile(catalog);
    if let Some(e) = failure {
        Err(e)
    } else {
        activation
    }
}

pub(super) fn pending_dependency_check(db: &Connection, row: &QueuedInputMetadata) -> Result<bool> {
    let InputOrigin::Followup { followup_id, .. } = &row.origin else {
        return Ok(false);
    };
    let d: Definition = record(db, "followups", followup_id)?;
    let Some(goal) = effective_goal(db, &d)? else {
        return Ok(false);
    };
    let usage: goals::GoalUsage = record(db, "goal_usage", &goal.id)?;
    Ok(goal.control == goals::GoalControl::Active
        && !goals::budget_limited(&goal, &usage)
        && !goals::usage_unknown(&goal, &usage)
        && dependency_check_eligible(db, &d, &goal)?
        && ingress_hold(db, row, None)?.is_none())
}
