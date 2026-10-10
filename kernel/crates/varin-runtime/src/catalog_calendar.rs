//! Calendar definitions are accepted projections of the original GUI/Markdown owner. Native
//! deadlines, durable actual slots, and original ingress own execution; arithmetic is pure work.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance};
use inputs::{InputOrigin, QueuedInputMetadata};
use serde::Deserialize;
use std::sync::{atomic::Ordering, Mutex};
type Result<T> = std::result::Result<T, RuntimeError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Rule {
    Once {
        date: String,
        time: String,
    },
    Daily {
        times: Vec<String>,
    },
    Weekly {
        times: Vec<String>,
        weekdays: Vec<u8>,
    },
    Cron {
        expression: String,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MissedPolicy {
    Skip,
    CoalesceOnce,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Gui,
    Loop,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivationHold {
    PreviousRuntimeActive,
    AssetInvalid,
}
/// Short provenance carried by the original managed asset owner across runtime selection.
/// Acceptance consumes an old once slot; it is not a Run outcome or a native occurrence.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OnceAcceptanceOwner {
    Pi,
    Agent,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OnceAcceptance {
    pub owner: OnceAcceptanceOwner,
    pub acceptance_id: String,
    pub scheduled_at_ms: u64,
    pub accepted_at_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSelection {
    pub provider_id: String,
    pub model_id: String,
    pub thinking_level: Option<String>,
    pub temperature: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InitialGoal {
    pub budget: Option<goals::GoalBudget>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target {
    NewWork {
        model: ModelSelection,
        source_mode: SourceMode,
        goal: Option<InitialGoal>,
    },
    ExistingWork {
        thread_id: String,
        branch_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionInput {
    pub task_id: String,
    pub asset_revision: String,
    pub asset_kind: AssetKind,
    pub name: String,
    pub enabled: bool,
    pub activation_hold: Option<ActivationHold>,
    pub once_acceptance: Option<OnceAcceptance>,
    pub timezone: String,
    pub rule: Rule,
    pub missed_policy: MissedPolicy,
    pub target: Target,
    pub instruction: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DefinitionView {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub asset_revision: String,
    pub asset_kind: AssetKind,
    pub revision: u64,
    pub generation: u64,
    pub name: String,
    pub enabled: bool,
    pub deleted: bool,
    pub timezone: String,
    pub rule: Rule,
    pub missed_policy: MissedPolicy,
    pub target: Target,
    pub synchronized: bool,
    pub activation_hold: Option<ActivationHold>,
    pub once_acceptance: Option<OnceAcceptance>,
    pub next_at_ms: Option<u64>,
    pub calculation_pending: bool,
    pub calculation_failure: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OccurrenceReason {
    Scheduled { at_ms: u64 },
    Manual { key: String },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceState {
    Observed,
    Preparing,
    Held,
    Queued,
    Delivered,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceControlAction {
    Cancel,
    Retry,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OccurrenceView {
    pub id: String,
    pub definition_id: String,
    pub generation: u64,
    pub revision: u64,
    pub reason: OccurrenceReason,
    pub observed_at_ms: u64,
    pub thread_id: String,
    pub branch_id: String,
    pub input_id: Option<String>,
    pub run_id: Option<String>,
    pub execution_id: Option<String>,
    pub goal_id: Option<String>,
    pub state: OccurrenceState,
    pub hold_reason: Option<String>,
    pub failure_code: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProjectView {
    pub project_id: String,
    pub revision: u64,
    pub definitions: Vec<DefinitionView>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Calculation {
    pub definition_id: String,
    pub generation: u64,
    pub revision: u64,
    pub owner_epoch: u64,
    pub rule: Rule,
    pub timezone: String,
    pub after_ms: u64,
    pub now_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Slot {
    pub at_ms: u64,
    pub following_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CalculationResult {
    pub next: Option<Slot>,
    pub latest_due: Option<Slot>,
    pub next_future: Option<Slot>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PendingView {
    pub calculations: Vec<Calculation>,
    pub preparations: Vec<OccurrenceView>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparationView {
    pub occurrence: OccurrenceView,
    pub definition: DefinitionView,
    pub instruction: String,
    pub owner_epoch: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Project {
    id: String,
    revision: u64,
    snapshot_ref: Value,
    synchronized_epoch: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Cursor {
    revision: u64,
    after_ms: u64,
    now_ms: u64,
    slot: Option<Slot>,
    pending: bool,
    recovery: bool,
    once_consumed: bool,
    failure: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Definition {
    view: DefinitionView,
    instruction_ref: Value,
    input_ref: Value,
    semantic_ref: Value,
    source_run_id: Option<String>,
    source: Option<launches::SourceSelection>,
    scope: Option<context::ContextScope>,
    cursor: Cursor,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Occurrence {
    id: String,
    definition_id: String,
    generation: u64,
    revision: u64,
    reason: OccurrenceReason,
    observed_at_ms: u64,
    thread_id: String,
    branch_id: String,
    input_id: Option<String>,
    goal_id: Option<String>,
    cancelled: bool,
    failure: Option<String>,
    instruction_ref: Value,
    target: Target,
}

pub(super) fn initialize_new(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE calendar_projects(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE calendar_definitions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES calendar_projects(id),task_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(project_id,task_id));
        CREATE TABLE calendar_occurrences(id TEXT PRIMARY KEY,definition_id TEXT NOT NULL REFERENCES calendar_definitions(id),thread_id TEXT NOT NULL REFERENCES threads(id),input_id TEXT UNIQUE REFERENCES input_queue(id),body TEXT NOT NULL);
        CREATE INDEX calendar_occurrences_definition ON calendar_occurrences(definition_id);")?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,body FROM calendar_projects")?;
    db.prepare("SELECT id,project_id,task_id,body FROM calendar_definitions")?;
    db.prepare("SELECT id,definition_id,thread_id,input_id,body FROM calendar_occurrences")?;
    Ok(())
}
fn digest(value: &impl Serialize) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}
fn definition_id(project: &str, task: &str) -> Result<String> {
    Ok(format!("calendar:{}", digest(&(project, task))?))
}
fn definitions(db: &Connection, project: Option<&str>) -> Result<Vec<Definition>> {
    let mut q = db.prepare(
        "SELECT body FROM calendar_definitions WHERE ?1 IS NULL OR project_id=?1 ORDER BY rowid",
    )?;
    let rows = q.query_map([project], |r| r.get::<_, String>(0))?;
    rows.map(|s| Ok(serde_json::from_str(&s?)?)).collect()
}
fn occurrences(db: &Connection, definition: Option<&str>) -> Result<Vec<Occurrence>> {
    let mut q = db.prepare(
        "SELECT body FROM calendar_occurrences WHERE ?1 IS NULL OR definition_id=?1 ORDER BY rowid",
    )?;
    let rows = q.query_map([definition], |r| r.get::<_, String>(0))?;
    rows.map(|s| Ok(serde_json::from_str(&s?)?)).collect()
}
fn synchronized(db: &Connection, d: &Definition) -> Result<bool> {
    let p: Project = record(db, "calendar_projects", &d.view.project_id)?;
    let epoch = db.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |r| {
        read_number(r, 0)
    })?;
    Ok(p.synchronized_epoch == epoch)
}
fn project_definition(db: &Connection, d: &Definition) -> Result<DefinitionView> {
    let mut v = d.view.clone();
    v.synchronized = synchronized(db, d)?;
    v.next_at_ms = d.cursor.slot.as_ref().map(|s| s.at_ms);
    v.calculation_pending = d.cursor.pending;
    v.calculation_failure = d.cursor.failure.clone();
    Ok(v)
}
fn write_definition(tx: &Transaction<'_>, d: &Definition) -> Result<()> {
    put(tx, "calendar_definitions", &d.view.id, d)
}
fn write_occurrence(tx: &Transaction<'_>, o: &Occurrence) -> Result<()> {
    tx.execute(
        "UPDATE calendar_occurrences SET input_id=?2,body=?3 WHERE id=?1",
        params![o.id, o.input_id, encode(o)?],
    )?;
    Ok(())
}
fn ended(db: &Connection, o: &Occurrence) -> Result<bool> {
    if o.cancelled {
        return Ok(true);
    }
    if let Some(id) = &o.input_id {
        let row: QueuedInputMetadata = record(db, "input_queue", id)?;
        if row.state == InputState::Cancelled
            || matches!(
                activation::fact(&row)?,
                activation::IngressActivationFact::Failed { .. }
            )
        {
            return Ok(true);
        }
        if row.state != InputState::Delivered {
            return Ok(false);
        }
        if let Some(id) = &o.goal_id {
            let g: goals::Definition = record(db, "goals", id)?;
            if !g.ended()
                || !record::<Run>(db, "runs", &g.source_run_id)?
                    .state
                    .terminal()
            {
                return Ok(false);
            }
        }
        if let Some(id) = activation::fact(&row)?.run_id() {
            return Ok(record::<Run>(db, "runs", id)?.state.terminal());
        }
    }
    Ok(false)
}
fn preceding_active(db: &Connection, o: &Occurrence) -> Result<bool> {
    for candidate in occurrences(db, Some(&o.definition_id))? {
        if candidate.id == o.id {
            return Ok(false);
        }
        if !ended(db, &candidate)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn any_active(db: &Connection, id: &str) -> Result<bool> {
    for o in occurrences(db, Some(id))? {
        if !ended(db, &o)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn current_scope(db: &Connection, branch: &str) -> Result<Option<context::ContextScope>> {
    let raw:Option<Option<String>>=db.query_row("SELECT c.scope FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1",[branch],|r|r.get(0)).optional()?;
    raw.flatten()
        .map(|s| Ok(serde_json::from_str(&s)?))
        .transpose()
}
fn admitted_scope(db: &Connection, run: &str) -> Result<Option<context::ContextScope>> {
    let raw: Option<String> = db.query_row("SELECT c.scope FROM runs r LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id WHERE r.id=?1", [run], |row| row.get(0))?;
    raw.map(|value| Ok(serde_json::from_str(&value)?))
        .transpose()
}
fn latest_run(db: &Connection, branch: &str) -> Result<Option<Run>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT body FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1",
            [branch],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
fn target_hold(
    db: &Connection,
    d: &Definition,
    o: &Occurrence,
    target: Option<&Run>,
) -> Result<Option<String>> {
    if let Target::ExistingWork {
        thread_id,
        branch_id,
    } = &o.target
    {
        let run = target
            .cloned()
            .map(Some)
            .map(Ok)
            .unwrap_or_else(|| latest_run(db, branch_id))?;
        let Some(run) = run else {
            return Ok(Some("source_unavailable".into()));
        };
        if &run.thread_id != thread_id
            || &run.branch_id != branch_id
            || admitted_scope(db, &run.id)? != d.scope
            || current_scope(db, branch_id)? != d.scope
        {
            return Ok(Some("context_scope_changed".into()));
        }
        let launch: launch_content::LaunchMetadata = record(db, "run_launches", &run.id)?;
        let same = followups::normalized_source(launch.selection.source, &run.id) == d.source;
        if !same {
            let Some(previous) = &d.source_run_id else {
                return Ok(Some("source_changed".into()));
            };
            let previous: Run = record(db, "runs", previous)?;
            if process_wait::delegated_source_lineage(db, &previous, &run)?.is_none() {
                return Ok(Some("source_changed".into()));
            }
        }
    }
    Ok(None)
}
fn occurrence_hold(
    db: &Connection,
    d: &Definition,
    o: &Occurrence,
    target: Option<&Run>,
) -> Result<Option<String>> {
    if o.cancelled || d.view.deleted || d.view.generation != o.generation {
        return Ok(Some("definition_cancelled".into()));
    }
    if !synchronized(db, d)? {
        return Ok(Some("asset_revalidation".into()));
    }
    if let Some(hold) = d.view.activation_hold {
        return Ok(Some(
            match hold {
                ActivationHold::PreviousRuntimeActive => "previous_runtime_active",
                ActivationHold::AssetInvalid => "asset_invalid",
            }
            .into(),
        ));
    }
    if matches!(o.reason, OccurrenceReason::Scheduled { .. }) && !d.view.enabled {
        return Ok(Some("disabled".into()));
    }
    if preceding_active(db, o)? {
        return Ok(Some("previous_occurrence_active".into()));
    }
    if o.failure.is_some() {
        return Ok(Some("preparation_failed".into()));
    }
    if matches!(o.target, Target::NewWork { .. }) && o.input_id.is_none() {
        let head: Option<String> = db.query_row(
            "SELECT head FROM branches WHERE id=?1",
            [&o.branch_id],
            |r| r.get(0),
        )?;
        if head.is_some() || latest_run(db, &o.branch_id)?.is_some() {
            return Ok(Some("branch_changed".into()));
        }
    }
    target_hold(db, d, o, target)
}
fn project_occurrence(db: &Connection, d: &Definition, o: &Occurrence) -> Result<OccurrenceView> {
    let mut v = OccurrenceView {
        id: o.id.clone(),
        definition_id: o.definition_id.clone(),
        generation: o.generation,
        revision: o.revision,
        reason: o.reason.clone(),
        observed_at_ms: o.observed_at_ms,
        thread_id: o.thread_id.clone(),
        branch_id: o.branch_id.clone(),
        input_id: o.input_id.clone(),
        run_id: None,
        execution_id: None,
        goal_id: o.goal_id.clone(),
        state: OccurrenceState::Observed,
        hold_reason: None,
        failure_code: o.failure.clone(),
    };
    if let Some(id) = &o.input_id {
        let row: QueuedInputMetadata = record(db, "input_queue", id)?;
        v.run_id = activation::fact(&row)?.run_id().map(str::to_owned);
        v.execution_id = activation::fact(&row)?.execution_id().map(str::to_owned);
        if row.state == InputState::Delivered {
            v.state = OccurrenceState::Delivered;
            let goal = o
                .goal_id
                .as_deref()
                .map(|id| record::<goals::Definition>(db, "goals", id))
                .transpose()?;
            if let Some(goal) = goal
                .as_ref()
                .filter(|goal| goal.thread_id == o.thread_id && goal.branch_id == o.branch_id)
            {
                v.run_id = Some(goal.source_run_id.clone());
            }
            if let Some(id) = &v.run_id {
                let run: Run = record(db, "runs", id)?;
                v.hold_reason = activation::run_hold(db, &run)?.map(activation_hold_code);
                if ended(db, o)? {
                    v.state = match goal.as_ref().map(|g| g.control) {
                        Some(goals::GoalControl::Complete) => OccurrenceState::Completed,
                        Some(goals::GoalControl::Cancelled) => OccurrenceState::Cancelled,
                        Some(_) => OccurrenceState::Delivered,
                        None => match run.state {
                            RunState::Completed => OccurrenceState::Completed,
                            RunState::Failed => OccurrenceState::Failed,
                            RunState::Cancelled => OccurrenceState::Cancelled,
                            _ => OccurrenceState::Delivered,
                        },
                    };
                    v.hold_reason = None;
                }
            }
            return Ok(v);
        }
        if row.state == InputState::Cancelled {
            v.state = OccurrenceState::Cancelled;
            return Ok(v);
        }
        if let activation::IngressActivationFact::Failed { code, .. } = activation::fact(&row)? {
            v.state = OccurrenceState::Failed;
            v.failure_code = Some(code.clone());
            return Ok(v);
        }
        v.state = OccurrenceState::Queued;
    } else if matches!(o.target, Target::NewWork { .. }) {
        v.state = OccurrenceState::Preparing;
    }
    if o.cancelled || d.view.deleted || d.view.generation != o.generation {
        v.state = OccurrenceState::Cancelled;
        return Ok(v);
    }
    v.hold_reason = occurrence_hold(db, d, o, None)?;
    if v.hold_reason.is_none() {
        if let Some(id) = &o.input_id {
            let row: QueuedInputMetadata = record(db, "input_queue", id)?;
            match activation::project(db, &row)? {
                activation::MessageActivation::Pending { hold_reason, .. }
                | activation::MessageActivation::Bound { hold_reason, .. } => {
                    v.hold_reason = hold_reason.map(activation_hold_code);
                }
                _ => (),
            }
        }
    }
    if v.hold_reason.is_some() {
        v.state = OccurrenceState::Held;
    }
    Ok(v)
}
fn activation_hold_code(hold: activation::MessageActivationHold) -> String {
    use activation::MessageActivationHold::*;
    match hold {
        ManualPause => "manual_pause",
        Question => "question",
        GoalBlocked => "goal_blocked",
        DependencyWait => "dependency_wait",
        Preparing => "preparing",
        SourceUnsettled => "source_unsettled",
    }
    .into()
}
fn cancel_occurrence(tx: &Transaction<'_>, o: &mut Occurrence) -> Result<()> {
    if let Some(id) = &o.input_id {
        let mut row: QueuedInputMetadata = record(tx, "input_queue", id)?;
        if row.state == InputState::Delivered {
            return Ok(());
        }
        activation::cancel_row(tx, &mut row)?;
    }
    if !o.cancelled {
        o.cancelled = true;
        o.revision += 1;
        write_occurrence(tx, o)?;
        event(
            tx,
            &o.id,
            o.revision,
            "calendar.occurrence_cancelled",
            json!({"definition_id":o.definition_id}),
        )?;
    }
    Ok(())
}
/// Stop retracts only the already accepted ingress in the selected original work scope.
/// The independent asset definition remains authorized for later actual slots.
pub(super) fn cancel_thread_pending(tx: &Transaction<'_>, thread: &str) -> Result<()> {
    cancel_scope_pending(tx, thread, None)
}
pub(super) fn cancel_branch_pending(
    tx: &Transaction<'_>,
    thread: &str,
    branch: &str,
) -> Result<()> {
    cancel_scope_pending(tx, thread, Some(branch))
}
fn cancel_scope_pending(tx: &Transaction<'_>, thread: &str, branch: Option<&str>) -> Result<()> {
    let rows: Vec<Occurrence> = {
        let mut query = tx.prepare("SELECT body FROM calendar_occurrences WHERE thread_id=?1")?;
        let rows = query.query_map([thread], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<_>>()?
    };
    for mut occurrence in rows {
        if branch.is_none_or(|branch| occurrence.branch_id == branch) {
            cancel_occurrence(tx, &mut occurrence)?;
        }
    }
    Ok(())
}
fn rearm(d: &mut Definition, now: u64, recovery: bool) {
    if matches!(d.view.rule, Rule::Once { .. }) && d.cursor.once_consumed {
        return;
    }
    d.cursor.revision += 1;
    d.cursor.now_ms = now;
    d.cursor.slot = None;
    d.cursor.pending = true;
    d.cursor.recovery = recovery;
}

pub struct SyncPreparation {
    project: String,
    expected: Option<u64>,
    inputs: Vec<DefinitionInput>,
    epoch: u64,
    now: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
struct PreparedDefinition {
    input: DefinitionInput,
    input_ref: Value,
    instruction_ref: Value,
    semantic_ref: Value,
}
pub struct PreparedSync {
    capture: SyncPreparation,
    snapshot_ref: Value,
    definitions: Vec<PreparedDefinition>,
}
impl SyncPreparation {
    pub fn load(self) -> Result<PreparedSync> {
        if self.project.trim().is_empty() {
            return Err(RuntimeError::Invalid("calendar project is required".into()));
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut definitions = Vec::new();
        for input in &self.inputs {
            if input.task_id.trim().is_empty()
                || input.asset_revision.trim().is_empty()
                || input.timezone.trim().is_empty()
                || input.instruction.trim().is_empty()
                || !seen.insert(input.task_id.clone())
            {
                return Err(RuntimeError::Invalid("calendar definition identity, timezone and instruction are required and unique".into()));
            }
            let time = |value: &str| {
                value.len() == 5
                    && value.as_bytes()[2] == b':'
                    && value[..2].parse::<u8>().is_ok_and(|n| n < 24)
                    && value[3..].parse::<u8>().is_ok_and(|n| n < 60)
            };
            let valid = match &input.rule {
                Rule::Once { date, time: t } => date.len() == 10 && date.is_ascii() && time(t),
                Rule::Daily { times } => {
                    !times.is_empty() && times.iter().all(|v| v.is_ascii() && time(v))
                }
                Rule::Weekly { times, weekdays } => {
                    !times.is_empty()
                        && !weekdays.is_empty()
                        && weekdays.iter().all(|d| *d <= 6)
                        && times.iter().all(|v| v.is_ascii() && time(v))
                }
                Rule::Cron { expression } => !expression.trim().is_empty(),
            };
            if !valid {
                return Err(RuntimeError::Invalid(
                    "calendar recurrence is malformed".into(),
                ));
            }
            if let Some(acceptance) = &input.once_acceptance {
                if !matches!(input.rule, Rule::Once { .. })
                    || acceptance.acceptance_id.trim().is_empty()
                    || acceptance.scheduled_at_ms > observations::MAX_DEADLINE_MS
                    || acceptance.accepted_at_ms > observations::MAX_DEADLINE_MS
                {
                    return Err(RuntimeError::Invalid("once acceptance needs its original identity, a once definition and representable UTC instants".into()));
                }
            }
            match &input.target {
                Target::NewWork { model, .. }
                    if model.provider_id.trim().is_empty()
                        || model.model_id.trim().is_empty()
                        || model.temperature.is_some_and(|v| !v.is_finite() || v < 0.0) =>
                {
                    return Err(RuntimeError::Invalid(
                        "calendar model selection is invalid".into(),
                    ))
                }
                Target::ExistingWork {
                    thread_id,
                    branch_id,
                } if thread_id.trim().is_empty() || branch_id.trim().is_empty() => {
                    return Err(RuntimeError::Invalid(
                        "calendar target identity is required".into(),
                    ))
                }
                _ => (),
            }
            let instruction_ref = self.content.save(&json!(input.instruction))?;
            let input_ref = self.content.save(&serde_json::to_value(input)?)?;
            let semantic_ref = crate::content::ContentStore::reference(
                &json!({"timezone":input.timezone,"rule":input.rule,"missed_policy":input.missed_policy,"target":input.target,"instruction":instruction_ref}),
            )?;
            definitions.push(PreparedDefinition {
                input: input.clone(),
                input_ref,
                instruction_ref,
                semantic_ref,
            });
        }
        let snapshot_ref = self.content.save(&serde_json::to_value(&self.inputs)?)?;
        Ok(PreparedSync {
            capture: self,
            snapshot_ref,
            definitions,
        })
    }
}
impl Catalog {
    pub fn prepare_calendar_sync(
        &self,
        project: String,
        expected: Option<u64>,
        inputs: Vec<DefinitionInput>,
    ) -> Result<SyncPreparation> {
        Ok(SyncPreparation {
            project,
            expected,
            inputs,
            epoch: self.epoch,
            now: observations::wall_time_ms()?,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_calendar_sync(&mut self, p: PreparedSync) -> Result<ProjectView> {
        if p.capture.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "calendar owner changed or stopped".into(),
            ));
        }
        let PreparedSync {
            capture,
            snapshot_ref,
            definitions: prepared,
        } = p;
        let _publication = capture.publication;
        let tx = self.db.transaction()?;
        let previous: Option<Project> =
            optional_record(&tx, "calendar_projects", &capture.project)?;
        let identical = previous
            .as_ref()
            .is_some_and(|p| p.snapshot_ref == snapshot_ref);
        if !identical && previous.as_ref().map(|p| p.revision) != capture.expected {
            return Err(RuntimeError::Conflict(
                "calendar project snapshot changed".into(),
            ));
        }
        let recovered = previous
            .as_ref()
            .is_some_and(|p| p.synchronized_epoch != self.epoch);
        let project = Project {
            id: capture.project.clone(),
            revision: previous
                .as_ref()
                .map_or(1, |p| p.revision + u64::from(!identical)),
            snapshot_ref,
            synchronized_epoch: self.epoch,
        };
        tx.execute("INSERT INTO calendar_projects(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![project.id,encode(&project)?])?;
        let mut seen = std::collections::BTreeSet::new();
        for p in prepared {
            let input = p.input;
            let id = definition_id(&capture.project, &input.task_id)?;
            seen.insert(id.clone());
            let old: Option<Definition> = optional_record(&tx, "calendar_definitions", &id)?;
            let changed = old
                .as_ref()
                .is_none_or(|d| d.semantic_ref != p.semantic_ref || d.view.deleted);
            let (source_run_id, source, scope) = if changed {
                match &input.target {
                    Target::NewWork { .. } => (None, None, None),
                    Target::ExistingWork {
                        thread_id,
                        branch_id,
                    } => {
                        context_jobs::require_regular_branch(&tx, branch_id)?;
                        let run = latest_run(&tx, branch_id)?.ok_or_else(|| {
                            RuntimeError::Conflict(
                                "existing calendar work has no original Run configuration".into(),
                            )
                        })?;
                        let scope = admitted_scope(&tx, &run.id)?;
                        if &run.thread_id != thread_id
                            || current_scope(&tx, branch_id)? != scope
                            || scope.as_ref().and_then(|s| s.project_id.as_deref())
                                != Some(capture.project.as_str())
                        {
                            return Err(RuntimeError::Conflict(
                                "calendar target is outside its actual project scope".into(),
                            ));
                        }
                        let launch: launch_content::LaunchMetadata =
                            record(&tx, "run_launches", &run.id)?;
                        (
                            Some(run.id.clone()),
                            followups::normalized_source(launch.selection.source, &run.id),
                            scope,
                        )
                    }
                }
            } else {
                let d = old.as_ref().unwrap();
                (d.source_run_id.clone(), d.source.clone(), d.scope.clone())
            };
            let generation = old
                .as_ref()
                .map_or(1, |d| d.view.generation + u64::from(changed));
            let revision = old.as_ref().map_or(1, |d| {
                d.view.revision + u64::from(d.input_ref != p.input_ref || d.view.deleted)
            });
            let cursor = if changed {
                Cursor {
                    revision: 1,
                    after_ms: capture.now,
                    now_ms: capture.now,
                    slot: None,
                    pending: true,
                    recovery: false,
                    once_consumed: false,
                    failure: None,
                }
            } else {
                old.as_ref().unwrap().cursor.clone()
            };
            let mut d = Definition {
                view: DefinitionView {
                    id: id.clone(),
                    project_id: capture.project.clone(),
                    task_id: input.task_id,
                    asset_revision: input.asset_revision,
                    asset_kind: input.asset_kind,
                    revision,
                    generation,
                    name: input.name,
                    enabled: input.enabled,
                    deleted: false,
                    timezone: input.timezone,
                    rule: input.rule,
                    missed_policy: input.missed_policy,
                    target: input.target,
                    synchronized: true,
                    activation_hold: input.activation_hold,
                    once_acceptance: input.once_acceptance.or_else(|| {
                        old.as_ref()
                            .filter(|_| !changed)
                            .and_then(|old| old.view.once_acceptance.clone())
                    }),
                    next_at_ms: None,
                    calculation_pending: false,
                    calculation_failure: None,
                },
                instruction_ref: p.instruction_ref,
                input_ref: p.input_ref,
                semantic_ref: p.semantic_ref,
                source_run_id,
                source,
                scope,
                cursor,
            };
            // The asset owner already proved unchanged once intent while transferring runtime
            // ownership. Seed only the original scheduling cursor; existing native acceptance,
            // manual work and every Run/Goal/result remain owned by their original records.
            if d.view.once_acceptance.is_some() {
                if !d.cursor.once_consumed || d.cursor.pending || d.cursor.slot.is_some() {
                    d.cursor.revision += 1;
                }
                d.cursor.once_consumed = true;
                d.cursor.slot = None;
                d.cursor.pending = false;
                d.cursor.failure = None;
            }
            if !changed
                && d.cursor.failure.is_none()
                && (recovered
                    || old.as_ref().is_some_and(|old| {
                        (!old.view.enabled && d.view.enabled)
                            || (old.view.activation_hold.is_some()
                                && d.view.activation_hold.is_none())
                    }))
            {
                rearm(&mut d, capture.now, true)
            }
            tx.execute("INSERT INTO calendar_definitions(id,project_id,task_id,body) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET body=excluded.body",params![id,d.view.project_id,d.view.task_id,encode(&d)?])?;
            if changed {
                for mut o in occurrences(&tx, Some(&id))? {
                    cancel_occurrence(&tx, &mut o)?;
                }
            }
            if !identical || recovered {
                event(
                    &tx,
                    &id,
                    d.view.revision,
                    "calendar.definition_changed",
                    json!({"project_id":d.view.project_id,"generation":generation,"once_acceptance":d.view.once_acceptance}),
                )?;
            }
        }
        for mut d in definitions(&tx, Some(&capture.project))? {
            if !seen.contains(&d.view.id) && !d.view.deleted {
                d.view.deleted = true;
                d.view.enabled = false;
                d.view.revision += 1;
                d.cursor.pending = false;
                d.cursor.slot = None;
                write_definition(&tx, &d)?;
                for mut o in occurrences(&tx, Some(&d.view.id))? {
                    cancel_occurrence(&tx, &mut o)?;
                }
                event(
                    &tx,
                    &d.view.id,
                    d.view.revision,
                    "calendar.definition_deleted",
                    json!({"project_id":capture.project}),
                )?;
            }
        }
        if !identical || recovered {
            event(
                &tx,
                &capture.project,
                project.revision,
                "calendar.project_synchronized",
                Value::Null,
            )?;
        }
        tx.commit()?;
        self.calendar_project(&capture.project)
    }
    pub fn calendar_projects(&self) -> Result<Vec<String>> {
        let mut q = self
            .db
            .prepare("SELECT id FROM calendar_projects ORDER BY id")?;
        let rows = q.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn calendar_project(&self, project: &str) -> Result<ProjectView> {
        let p: Option<Project> = optional_record(&self.db, "calendar_projects", project)?;
        Ok(ProjectView {
            project_id: project.into(),
            revision: p.map_or(0, |p| p.revision),
            definitions: definitions(&self.db, Some(project))?
                .iter()
                .map(|d| project_definition(&self.db, d))
                .collect::<Result<_>>()?,
        })
    }
    pub fn calendar_occurrences(&self, definition: &str) -> Result<Vec<OccurrenceView>> {
        let d: Definition = record(&self.db, "calendar_definitions", definition)?;
        occurrences(&self.db, Some(definition))?
            .iter()
            .map(|o| project_occurrence(&self.db, &d, o))
            .collect()
    }
    pub fn calendar_occurrence(&self, id: &str) -> Result<OccurrenceView> {
        let o: Occurrence = record(&self.db, "calendar_occurrences", id)?;
        let d: Definition = record(&self.db, "calendar_definitions", &o.definition_id)?;
        project_occurrence(&self.db, &d, &o)
    }
    pub fn calendar_pending(&self) -> Result<PendingView> {
        let mut calculations = Vec::new();
        let mut preparations = Vec::new();
        for d in definitions(&self.db, None)? {
            if d.view.deleted || !synchronized(&self.db, &d)? {
                continue;
            }
            if d.cursor.pending && d.cursor.failure.is_none() {
                calculations.push(Calculation {
                    definition_id: d.view.id.clone(),
                    generation: d.view.generation,
                    revision: d.cursor.revision,
                    owner_epoch: self.epoch,
                    rule: d.view.rule.clone(),
                    timezone: d.view.timezone.clone(),
                    after_ms: d.cursor.after_ms,
                    now_ms: d.cursor.now_ms,
                });
            }
            for o in occurrences(&self.db, Some(&d.view.id))? {
                if matches!(o.target, Target::NewWork { .. })
                    && o.input_id.is_none()
                    && occurrence_hold(&self.db, &d, &o, None)?.is_none()
                {
                    let mut view = project_occurrence(&self.db, &d, &o)?;
                    if self.head(&o.branch_id)?.is_some()
                        || latest_run(&self.db, &o.branch_id)?.is_some()
                    {
                        view.state = OccurrenceState::Held;
                        view.hold_reason = Some("branch_changed".into());
                    } else {
                        preparations.push(view);
                    }
                }
            }
        }
        Ok(PendingView {
            calculations,
            preparations,
        })
    }
    pub fn admit_calendar_calculation(
        &mut self,
        c: Calculation,
        result: Option<CalculationResult>,
        failure: Option<String>,
    ) -> Result<DefinitionView> {
        if c.owner_epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "calendar calculation belongs to a previous owner".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "calendar_definitions", &c.definition_id)?;
        if d.view.generation != c.generation
            || d.cursor.revision != c.revision
            || d.cursor.after_ms != c.after_ms
            || d.cursor.now_ms != c.now_ms
            || d.view.rule != c.rule
            || d.view.timezone != c.timezone
            || d.view.deleted
            || !synchronized(&tx, &d)?
        {
            return Err(RuntimeError::Conflict(
                "calendar calculation changed".into(),
            ));
        }
        if !d.cursor.pending {
            return project_definition(&tx, &d);
        }
        if result.is_some() == failure.is_some() {
            return Err(RuntimeError::Invalid(
                "calendar calculation needs exactly one result or failure".into(),
            ));
        }
        if let Some(result) = result {
            let once = matches!(d.view.rule, Rule::Once { .. });
            for slot in [&result.next, &result.latest_due, &result.next_future]
                .into_iter()
                .flatten()
            {
                if slot.at_ms > observations::MAX_DEADLINE_MS
                    || slot.following_at_ms.is_some_and(|next| {
                        next <= slot.at_ms || next > observations::MAX_DEADLINE_MS
                    })
                {
                    return Err(RuntimeError::Invalid(
                        "calendar slot is outside the native UTC deadline range or its following slot is not later".into(),
                    ));
                }
            }
            if !once
                && (result.next.as_ref().is_some_and(|s| s.at_ms <= c.after_ms)
                    || result
                        .latest_due
                        .as_ref()
                        .is_some_and(|s| s.at_ms <= c.after_ms || s.at_ms > c.now_ms)
                    || result
                        .next_future
                        .as_ref()
                        .is_some_and(|s| s.at_ms <= c.now_ms || s.at_ms <= c.after_ms))
            {
                return Err(RuntimeError::Invalid(
                    "calendar calculation crossed its actual cursor".into(),
                ));
            }
            d.cursor.slot = if once {
                if d.cursor.once_consumed {
                    None
                } else if d.view.missed_policy == MissedPolicy::Skip
                    && result.next.as_ref().is_some_and(|s| s.at_ms < c.now_ms)
                {
                    d.cursor.once_consumed = true;
                    None
                } else {
                    result.next
                }
            } else if d.cursor.recovery {
                if d.view.missed_policy == MissedPolicy::CoalesceOnce {
                    result.latest_due.or(result.next_future)
                } else {
                    result.next_future
                }
            } else {
                let candidate = result.next;
                if candidate
                    .as_ref()
                    .is_some_and(|s| s.following_at_ms.is_some_and(|next| c.now_ms > next))
                {
                    if d.view.missed_policy == MissedPolicy::CoalesceOnce {
                        result.latest_due.or(result.next_future)
                    } else {
                        result.next_future
                    }
                } else {
                    candidate
                }
            };
            if let Some(slot) = &d.cursor.slot {
                if !once && slot.at_ms > c.now_ms {
                    d.cursor.after_ms = d.cursor.after_ms.max(c.now_ms);
                }
            }
            d.cursor.failure = None;
            d.cursor.recovery = false;
        } else {
            d.cursor.failure = failure;
            d.cursor.slot = None;
        }
        d.cursor.pending = false;
        d.view.revision += 1;
        write_definition(&tx, &d)?;
        event(
            &tx,
            &d.view.id,
            d.view.revision,
            "calendar.calculated",
            Value::Null,
        )?;
        let view = project_definition(&tx, &d)?;
        tx.commit()?;
        Ok(view)
    }
    pub fn retry_calendar_calculation(
        &mut self,
        id: &str,
        revision: u64,
    ) -> Result<DefinitionView> {
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "calendar_definitions", id)?;
        if d.view.revision != revision || d.view.deleted {
            return Err(RuntimeError::Conflict("calendar definition changed".into()));
        }
        if d.cursor.failure.take().is_some() {
            rearm(&mut d, observations::wall_time_ms()?, true);
            d.view.revision += 1;
            write_definition(&tx, &d)?;
            event(
                &tx,
                id,
                d.view.revision,
                "calendar.calculation_requested",
                Value::Null,
            )?;
        }
        let view = project_definition(&tx, &d)?;
        tx.commit()?;
        Ok(view)
    }
}

fn observe(
    tx: &Transaction<'_>,
    d: &Definition,
    reason: OccurrenceReason,
    now: u64,
) -> Result<Occurrence> {
    let id = format!("{}:{}:{}", d.view.id, d.view.generation, digest(&reason)?);
    if let Some(existing) = optional_record(tx, "calendar_occurrences", &id)? {
        return Ok(existing);
    }
    let (thread_id, branch_id) = match &d.view.target {
        Target::NewWork { .. } => {
            let thread = format!("thread:{id}");
            let branch = format!("branch:{id}");
            tx.execute("INSERT INTO threads(id) VALUES(?1)", [&thread])?;
            tx.execute(
                "INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,NULL)",
                params![branch, thread],
            )?;
            event(
                tx,
                &thread,
                1,
                "thread.created",
                json!({"branch_id":branch,"calendar_occurrence_id":id}),
            )?;
            (thread, branch)
        }
        Target::ExistingWork {
            thread_id,
            branch_id,
        } => (thread_id.clone(), branch_id.clone()),
    };
    let o = Occurrence {
        id,
        definition_id: d.view.id.clone(),
        generation: d.view.generation,
        revision: 1,
        reason,
        observed_at_ms: now,
        thread_id,
        branch_id,
        input_id: None,
        goal_id: None,
        cancelled: false,
        failure: None,
        instruction_ref: d.instruction_ref.clone(),
        target: d.view.target.clone(),
    };
    tx.execute("INSERT INTO calendar_occurrences(id,definition_id,thread_id,input_id,body) VALUES(?1,?2,?3,NULL,?4)",params![o.id,o.definition_id,o.thread_id,encode(&o)?])?;
    event(
        tx,
        &o.id,
        1,
        "calendar.observed",
        json!({"definition_id":o.definition_id,"thread_id":o.thread_id,"branch_id":o.branch_id}),
    )?;
    Ok(o)
}
impl Catalog {
    pub fn nearest_calendar_deadline(&self) -> Result<Option<u64>> {
        let mut nearest = None;
        for d in definitions(&self.db, None)? {
            if d.view.deleted
                || !d.view.enabled
                || d.view.activation_hold.is_some()
                || !synchronized(&self.db, &d)?
                || any_active(&self.db, &d.view.id)?
            {
                continue;
            }
            if let Some(s) = d.cursor.slot {
                nearest = Some(nearest.map_or(s.at_ms, |v: u64| v.min(s.at_ms)));
            }
        }
        Ok(nearest)
    }
    pub fn reconcile_calendar_facts_at(&mut self, now: u64) -> Result<usize> {
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Ok(0);
        }
        let tx = self.db.transaction()?;
        let mut count = 0;
        for mut d in definitions(&tx, None)? {
            if d.view.deleted
                || !d.view.enabled
                || d.view.activation_hold.is_some()
                || !synchronized(&tx, &d)?
                || any_active(&tx, &d.view.id)?
            {
                continue;
            }
            let Some(slot) = d.cursor.slot.clone() else {
                continue;
            };
            if now < slot.at_ms {
                continue;
            }
            if !matches!(d.view.rule, Rule::Once { .. })
                && slot.following_at_ms.is_some_and(|next| now > next)
            {
                rearm(&mut d, now, true);
                d.view.revision += 1;
                write_definition(&tx, &d)?;
                event(
                    &tx,
                    &d.view.id,
                    d.view.revision,
                    "calendar.calculation_requested",
                    Value::Null,
                )?;
                continue;
            }
            observe(
                &tx,
                &d,
                OccurrenceReason::Scheduled { at_ms: slot.at_ms },
                now,
            )?;
            count += 1;
            d.cursor.after_ms = d.cursor.after_ms.max(slot.at_ms);
            d.cursor.slot = None;
            d.cursor.once_consumed = matches!(d.view.rule, Rule::Once { .. });
            if !d.cursor.once_consumed {
                rearm(&mut d, now, false)
            }
            d.view.revision += 1;
            write_definition(&tx, &d)?;
        }
        tx.commit()?;
        Ok(count)
    }
    pub fn run_calendar_now(
        &mut self,
        definition: &str,
        revision: u64,
        key: &str,
    ) -> Result<OccurrenceView> {
        if key.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "calendar invocation key is required".into(),
            ));
        }
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict("calendar owner stopped".into()));
        }
        let tx = self.db.transaction()?;
        let d: Definition = record(&tx, "calendar_definitions", definition)?;
        // The key identifies this exact accepted invocation, even after later definition edits.
        for o in occurrences(&tx, Some(definition))? {
            if matches!(&o.reason,OccurrenceReason::Manual{key:old} if old==key) {
                return project_occurrence(&tx, &d, &o);
            }
        }
        if d.view.revision != revision || d.view.deleted {
            return Err(RuntimeError::Conflict("calendar definition changed".into()));
        }
        let o = observe(
            &tx,
            &d,
            OccurrenceReason::Manual { key: key.into() },
            observations::wall_time_ms()?,
        )?;
        let view = project_occurrence(&tx, &d, &o)?;
        tx.commit()?;
        Ok(view)
    }
    pub fn control_calendar_occurrence(
        &mut self,
        id: &str,
        revision: u64,
        action: OccurrenceControlAction,
    ) -> Result<OccurrenceView> {
        let tx = self.db.transaction()?;
        let mut o: Occurrence = record(&tx, "calendar_occurrences", id)?;
        let d: Definition = record(&tx, "calendar_definitions", &o.definition_id)?;
        if let Some(id) = &o.input_id {
            if record::<QueuedInputMetadata>(&tx, "input_queue", id)?.state == InputState::Delivered
            {
                return project_occurrence(&tx, &d, &o);
            }
        }
        if o.cancelled {
            return project_occurrence(&tx, &d, &o);
        }
        if o.revision != revision {
            return Err(RuntimeError::Conflict("calendar occurrence changed".into()));
        }
        match action {
            OccurrenceControlAction::Cancel => cancel_occurrence(&tx, &mut o)?,
            OccurrenceControlAction::Retry => {
                if d.view.deleted || d.view.generation != o.generation {
                    return Err(RuntimeError::Conflict(
                        "calendar generation was replaced".into(),
                    ));
                }
                if o.failure.take().is_some() {
                    o.revision += 1;
                    write_occurrence(&tx, &o)?;
                    event(
                        &tx,
                        id,
                        o.revision,
                        "calendar.preparation_requested",
                        Value::Null,
                    )?;
                }
            }
        }
        let view = project_occurrence(&tx, &d, &o)?;
        tx.commit()?;
        Ok(view)
    }
    pub fn fail_calendar_preparation(
        &mut self,
        id: &str,
        revision: u64,
        epoch: u64,
        code: &str,
    ) -> Result<OccurrenceView> {
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "calendar preparation owner changed".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut o: Occurrence = record(&tx, "calendar_occurrences", id)?;
        let d: Definition = record(&tx, "calendar_definitions", &o.definition_id)?;
        if o.input_id.is_none()
            && !o.cancelled
            && o.revision == revision
            && d.view.generation == o.generation
            && !d.view.deleted
            && o.failure.is_none()
            && occurrence_hold(&tx, &d, &o, None)?.is_none()
        {
            o.failure = Some(code.into());
            o.revision += 1;
            write_occurrence(&tx, &o)?;
            event(
                &tx,
                id,
                o.revision,
                "calendar.preparation_failed",
                json!({"code":code}),
            )?;
        }
        let view = project_occurrence(&tx, &d, &o)?;
        tx.commit()?;
        Ok(view)
    }
    pub fn capture_calendar_preparation(&self, id: &str) -> Result<PreparationRead> {
        let o: Occurrence = record(&self.db, "calendar_occurrences", id)?;
        let d: Definition = record(&self.db, "calendar_definitions", &o.definition_id)?;
        Ok(PreparationRead {
            view: PreparationView {
                occurrence: project_occurrence(&self.db, &d, &o)?,
                definition: project_definition(&self.db, &d)?,
                instruction: String::new(),
                owner_epoch: self.epoch,
            },
            instruction: o.instruction_ref,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}
pub struct PreparationRead {
    view: PreparationView,
    instruction: Value,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl PreparationRead {
    pub fn load(mut self) -> Result<PreparationView> {
        self.view.instruction = serde_json::from_value(self.content.load(&self.instruction)?)?;
        Ok(self.view)
    }
}
fn history(
    content: &crate::content::ContentStore,
    occurrence: &Occurrence,
    input: Value,
) -> Result<Value> {
    content.save_history(
        &serde_json::to_value(CalendarHistory {
            kind: "calendar_input".into(),
            occurrence_id: occurrence.id.clone(),
            definition_id: occurrence.definition_id.clone(),
            generation: occurrence.generation,
            reason: occurrence.reason.clone(),
            observed_at_ms: occurrence.observed_at_ms,
            input,
        })?,
        &None,
    )
}
struct ExistingPreparation {
    definition: Definition,
    occurrence: Occurrence,
    epoch: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl Catalog {
    fn capture_calendar_ingress(&self) -> Result<Vec<ExistingPreparation>> {
        let mut out = Vec::new();
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Ok(out);
        }
        for o in occurrences(&self.db, None)? {
            if o.input_id.is_some() || !matches!(o.target, Target::ExistingWork { .. }) {
                continue;
            }
            let d: Definition = record(&self.db, "calendar_definitions", &o.definition_id)?;
            if occurrence_hold(&self.db, &d, &o, None)?.is_none() {
                out.push(ExistingPreparation {
                    definition: d,
                    occurrence: o,
                    epoch: self.epoch,
                    content: self.content.clone(),
                    _publication: self.content.begin_publication(),
                });
            }
        }
        Ok(out)
    }
    fn admit_calendar_ingress(&mut self, p: ExistingPreparation, history: Value) -> Result<()> {
        if p.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "calendar ingress owner changed".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let d: Definition = record(&tx, "calendar_definitions", &p.definition.view.id)?;
        let mut o: Occurrence = record(&tx, "calendar_occurrences", &p.occurrence.id)?;
        if o.input_id.is_some() {
            return Ok(());
        }
        if d != p.definition || o != p.occurrence || occurrence_hold(&tx, &d, &o, None)?.is_some() {
            return Ok(());
        }
        let activation = activation::accept_target(&tx, &o.thread_id, &o.branch_id)?;
        let id = format!("calendar-input:{}", o.id);
        let cursor = event(
            &tx,
            &o.id,
            o.revision,
            "calendar.input_accepted",
            json!({"input_id":id}),
        )?;
        ingress::insert_occurrence(
            &tx,
            id.clone(),
            o.thread_id.clone(),
            o.branch_id.clone(),
            cursor,
            InputOrigin::Calendar {
                definition_id: o.definition_id.clone(),
                occurrence_id: o.id.clone(),
                generation: o.generation,
                activation,
            },
            &history,
        )?;
        o.input_id = Some(id);
        o.revision += 1;
        write_occurrence(&tx, &o)?;
        tx.commit()?;
        Ok(())
    }
}
pub(super) fn ingress_hold(
    db: &Connection,
    row: &QueuedInputMetadata,
    target: Option<&Run>,
) -> Result<Option<String>> {
    let InputOrigin::Calendar {
        definition_id,
        occurrence_id,
        generation,
        ..
    } = &row.origin
    else {
        return Ok(None);
    };
    let d: Definition = record(db, "calendar_definitions", definition_id)?;
    let o: Occurrence = record(db, "calendar_occurrences", occurrence_id)?;
    if o.definition_id != *definition_id
        || o.generation != *generation
        || o.input_id.as_deref() != Some(row.id.as_str())
    {
        return Err(RuntimeError::Conflict(
            "calendar ingress identity changed".into(),
        ));
    }
    if row.state == InputState::Delivered {
        return Ok(None);
    }
    occurrence_hold(db, &d, &o, target)
}
pub(super) fn delivered(tx: &Transaction<'_>, row: &QueuedInputMetadata) -> Result<()> {
    let InputOrigin::Calendar { occurrence_id, .. } = &row.origin else {
        return Ok(());
    };
    let mut o: Occurrence = record(tx, "calendar_occurrences", occurrence_id)?;
    if let Some(run_id) = row.run_id.as_deref() {
        o.goal_id = goals::for_run(tx, run_id)?.map(|goal| goal.id);
    }
    o.revision += 1;
    write_occurrence(tx, &o)?;
    event(
        tx,
        &o.id,
        o.revision,
        "calendar.delivered",
        json!({"input_id":row.id,"run_id":row.run_id}),
    )?;
    Ok(())
}
pub fn reconcile(catalog: &Mutex<Catalog>) -> Result<()> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))
    };
    let pending = lock()?.capture_calendar_ingress()?;
    let mut failure = None;
    for p in pending {
        let id = p.occurrence.id.clone();
        let revision = p.occurrence.revision;
        let epoch = p.epoch;
        let result = (|| {
            let instruction: String =
                serde_json::from_value(p.content.load(&p.occurrence.instruction_ref)?)?;
            let history = history(&p.content, &p.occurrence, json!(instruction))?;
            lock()?.admit_calendar_ingress(p, history)
        })();
        if let Err(e) = result {
            failure.get_or_insert(e);
            let _ = lock()?.fail_calendar_preparation(
                &id,
                revision,
                epoch,
                "calendar_instruction_unavailable",
            );
        }
    }
    if let Some(e) = failure {
        Err(e)
    } else {
        Ok(())
    }
}

/// Typed original schedule input, including any legitimately prepared skill material. It is
/// projected as environment provenance; the user-input helper is reused only for content parts.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CalendarHistory {
    kind: String,
    occurrence_id: String,
    definition_id: String,
    generation: u64,
    reason: OccurrenceReason,
    observed_at_ms: u64,
    input: Value,
}
pub(super) fn history_items(id: &str, value: &Value) -> Result<Option<Vec<ConversationItem>>> {
    if value.get("kind").and_then(Value::as_str) != Some("calendar_input") {
        return Ok(None);
    }
    let body: CalendarHistory = serde_json::from_value(value.clone())?;
    let mut items = execution_persistence::user_input_items(id, &body.input)?;
    for item in &mut items {
        if matches!(item.provenance, Provenance::UserInstruction { .. }) {
            item.provenance = Provenance::EnvironmentFact {
                event_id: format!("calendar:{}", body.occurrence_id),
            };
        }
    }
    let fact = json!({"definitionId":body.definition_id,"generation":body.generation,"occurrenceId":body.occurrence_id,"reason":body.reason,"observedAtMs":body.observed_at_ms});
    items.insert(0, ConversationItem {
        id: format!("{id}:trigger"),
        provenance: Provenance::EnvironmentFact { event_id: format!("calendar:{}", body.occurrence_id) },
        content: Content::Text { text: format!("A previously registered calendar task has triggered. Its retained instruction follows as environment input, not a new user message or system instruction. It grants no extra permissions. Actual occurrence: {fact}") },
        opaque: None,
        resource_activation: None,
    });
    Ok(Some(items))
}
pub(super) fn original_input(value: &Value) -> Result<Option<Value>> {
    if value.get("kind").and_then(Value::as_str) != Some("calendar_input") {
        return Ok(None);
    }
    let body: CalendarHistory = serde_json::from_value(value.clone())?;
    Ok(Some(body.input))
}
pub struct ColdPreparation {
    definition: Definition,
    occurrence: Occurrence,
    submission: submissions::SubmissionPreparation,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedCold {
    definition: Definition,
    occurrence: Occurrence,
    submission: submissions::PreparedSubmission,
    goal: Option<goals::PreparedGoalMutation>,
    epoch: u64,
    _publication: crate::content::ContentPublication,
}
impl Catalog {
    pub fn prepare_calendar_submission(
        &self,
        id: &str,
        revision: u64,
        epoch: u64,
        configuration: Value,
        initial: context::ContextProposal,
        basis: personalization::PersonalizationBasis,
        resources: Option<resources::ContextResources>,
        input_preparation: Option<resources::InputResourcePreparation>,
    ) -> Result<ColdPreparation> {
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "calendar preparation belongs to a previous owner".into(),
            ));
        }
        let o: Occurrence = record(&self.db, "calendar_occurrences", id)?;
        let d: Definition = record(&self.db, "calendar_definitions", &o.definition_id)?;
        if o.cancelled || d.view.deleted || d.view.generation != o.generation {
            return Err(RuntimeError::DispatchCancelled);
        }
        if occurrence_hold(&self.db, &d, &o, None)?.is_some() {
            return Err(RuntimeError::RequestActivationHeld);
        }
        if o.revision != revision
            || o.input_id.is_some()
            || !matches!(o.target, Target::NewWork { .. })
        {
            return Err(RuntimeError::Conflict(
                "calendar occurrence preparation changed or is held".into(),
            ));
        }
        if self.head(&o.branch_id)?.is_some() || latest_run(&self.db, &o.branch_id)?.is_some() {
            return Err(RuntimeError::Conflict(
                "calendar cold branch changed".into(),
            ));
        }
        if basis.project_id.as_deref() != Some(d.view.project_id.as_str())
            || basis.session_id != o.thread_id
            || basis.mode != "agent"
            || basis.thread_role != "main"
        {
            return Err(RuntimeError::Conflict(
                "calendar context is not its actual main project scope".into(),
            ));
        }
        let command = SubmitInput {
            key: format!("calendar-run:{}", o.id),
            thread_id: o.thread_id.clone(),
            branch_id: o.branch_id.clone(),
            expected_head: None,
            input: Value::Null,
            configuration,
        };
        let submission = self
            .prepare_submission(command, Some(initial), Some(basis))?
            .with_resources(resources)
            .with_input_preparation(input_preparation);
        Ok(ColdPreparation {
            definition: d,
            occurrence: o,
            submission,
            epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_calendar_submission(&mut self, p: PreparedCold) -> Result<OccurrenceView> {
        if p.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "calendar admission owner changed or stopped".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let d: Definition = record(&tx, "calendar_definitions", &p.definition.view.id)?;
        let mut o: Occurrence = record(&tx, "calendar_occurrences", &p.occurrence.id)?;
        if o.input_id.is_some() {
            return project_occurrence(&tx, &d, &o);
        }
        if o.cancelled || d.view.deleted || d.view.generation != o.generation {
            return Err(RuntimeError::DispatchCancelled);
        }
        if occurrence_hold(&tx, &d, &o, None)?.is_some() {
            return Err(RuntimeError::RequestActivationHeld);
        }
        if d.semantic_ref != p.definition.semantic_ref || o != p.occurrence {
            return Err(RuntimeError::Conflict(
                "calendar occurrence changed before admission".into(),
            ));
        }
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&o.branch_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if head.is_some() || active.is_some() || latest_run(&tx, &o.branch_id)?.is_some() {
            return Err(RuntimeError::Conflict(
                "calendar cold branch changed before admission".into(),
            ));
        }
        let submissions::SubmissionOrigin::Ingress { input, .. } = &p.submission.origin else {
            unreachable!()
        };
        let cursor = event(
            &tx,
            &o.id,
            o.revision,
            "calendar.input_accepted",
            json!({"input_id":input.id}),
        )?;
        let mut row = ingress::insert_occurrence(
            &tx,
            input.id.clone(),
            o.thread_id.clone(),
            o.branch_id.clone(),
            cursor,
            input.origin.clone(),
            &p.submission.history,
        )?;
        o.input_id = Some(row.id.clone());
        write_occurrence(&tx, &o)?;
        let mut submission = p.submission;
        if let submissions::SubmissionOrigin::Ingress { input, .. } = &mut submission.origin {
            row.cursor = cursor;
            *input = row;
        }
        let receipt = Self::submit_admission_tx(&tx, self.epoch, &submission, None)?;
        if let Some(goal) = p.goal.as_ref() {
            let receipt = goals::admit_mutation_tx(&tx, goal)?;
            o.goal_id = Some(receipt.id);
        }
        o = record(&tx, "calendar_occurrences", &o.id).map(|mut current: Occurrence| {
            current.goal_id = o.goal_id;
            current
        })?;
        write_occurrence(&tx, &o)?;
        event(
            &tx,
            &o.id,
            o.revision,
            "ingress.run_ready",
            json!({"input_id":receipt.input_id,"run_id":receipt.run_id}),
        )?;
        let view = project_occurrence(&tx, &d, &o)?;
        tx.commit()?;
        Ok(view)
    }
}
impl ColdPreparation {
    pub fn load(mut self, launch: launches::LaunchSelection) -> Result<PreparedCold> {
        let Target::NewWork {
            model,
            source_mode,
            goal,
        } = &self.occurrence.target
        else {
            unreachable!()
        };
        let configuration: crate::ModelSessionConfiguration =
            serde_json::from_value(self.submission.command.configuration.clone())?;
        if configuration.model != model.model_id
            || configuration.provider_id.as_deref() != Some(model.provider_id.as_str())
            || model
                .thinking_level
                .as_ref()
                .is_some_and(|requested| configuration.thinking_level.as_ref() != Some(requested))
            || model.temperature.is_some_and(|requested| {
                configuration
                    .model_options
                    .as_ref()
                    .and_then(|options| options.get("temperature"))
                    .and_then(Value::as_f64)
                    != Some(requested)
            })
            || launch
                .source
                .as_ref()
                .is_none_or(|source| source.mode != *source_mode)
        {
            return Err(RuntimeError::Conflict(
                "calendar candidate does not match its selected model/source".into(),
            ));
        }
        let instruction: String =
            serde_json::from_value(self.content.load(&self.occurrence.instruction_ref)?)?;
        self.submission.command.input = json!(instruction);
        let mut submission = self.submission.load(Some(launch), false)?;
        let (bound, _) = self.content.load_history_payload(&submission.history)?;
        let input_id = format!("calendar-input:{}", self.occurrence.id);
        let history = history(&self.content, &self.occurrence, bound)?;
        submission.history = history.clone();
        submission.origin = submissions::SubmissionOrigin::Ingress {
            input: QueuedInputMetadata {
                id: input_id,
                thread_id: self.occurrence.thread_id.clone(),
                branch_id: self.occurrence.branch_id.clone(),
                run_id: None,
                mode: InputMode::Boundary,
                state: InputState::Queued,
                revision: 1,
                cursor: 0,
                origin: InputOrigin::Calendar {
                    definition_id: self.occurrence.definition_id.clone(),
                    occurrence_id: self.occurrence.id.clone(),
                    generation: self.occurrence.generation,
                    activation: activation::IngressActivationFact::Pending { execution_id: None },
                },
                activation: inputs::InputActivation::Activating,
                delivered_cursor: None,
            },
            execution_id: None,
            checkpoint: None,
            history,
        };
        let goal = goal
            .as_ref()
            .map(|goal| -> Result<_> {
                let objective_ref = self.content.save(&json!(instruction))?;
                let intent = self.content.save(&json!({
                    "run_id": submission.run_id,
                    "objective_ref": objective_ref,
                    "budget": goal.budget,
                }))?;
                Ok(goals::PreparedGoalMutation {
                    scope: goals::GoalScope {
                        thread_id: self.occurrence.thread_id.clone(),
                        branch_id: self.occurrence.branch_id.clone(),
                    },
                    key: format!("calendar-goal:{}", self.occurrence.id),
                    run_id: Some(submission.run_id.clone()),
                    expected_revision: None,
                    objective_ref,
                    intent,
                    budget: goal.budget.clone(),
                    epoch: self.epoch,
                    _publication: self.content.begin_publication(),
                })
            })
            .transpose()?;
        Ok(PreparedCold {
            definition: self.definition,
            occurrence: self.occurrence,
            submission,
            goal,
            epoch: self.epoch,
            _publication: self.publication,
        })
    }
}

#[cfg(test)]
#[path = "catalog_calendar_tests.rs"]
mod tests;
