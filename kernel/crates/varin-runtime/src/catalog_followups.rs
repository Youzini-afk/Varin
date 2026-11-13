//! Durable explicit intent and trigger facts. Ingress owns delivery; Runs and delegated
//! executions own work. The native continuation worker is the only wake consumer.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance, ToolOrigin};
use activation::IngressActivationFact;
use inputs::{InputOrigin, QueuedInputMetadata};
use serde::Deserialize;
use std::sync::{atomic::Ordering, Mutex};
type Result<T> = std::result::Result<T, RuntimeError>;
pub const TOOL: &str = "follow_up";
#[path = "catalog_followup_presentation.rs"]
mod presentation;
pub use presentation::{project_tool_evidence, project_tool_file_state, project_tool_followups};
#[path = "catalog_followup_registration.rs"]
mod registration;
pub use registration::*;
#[path = "catalog_followup_wait.rs"]
pub mod observation;
#[path = "catalog_followup_registration_cancel.rs"]
mod registration_cancel;
#[path = "catalog_followup_sources.rs"]
mod sources;
pub use sources::*;
#[path = "catalog_followup_files.rs"]
mod files;
pub use files::*;
#[path = "catalog_followup_artifacts.rs"]
mod artifacts;
pub use artifacts::*;
#[path = "catalog_followup_logs.rs"]
mod logs;
pub use logs::*;
#[path = "catalog_followup_metrics.rs"]
mod metrics;
pub use metrics::*;
#[path = "catalog_followup_events.rs"]
pub(crate) mod events;
pub use events::*;
#[path = "catalog_followup_event_input.rs"]
pub(crate) mod event_input;
#[path = "catalog_followup_event_files.rs"]
mod event_files;
pub use event_files::{
    EventAttachmentReadInput, EventAttachmentReadView, EventFileInput, PreparedEventAttachmentRead,
};
#[path = "catalog_followup_external.rs"]
pub(crate) mod external;
pub use external::{ExternalEventDelivery, ExternalEventDeliveryView};
#[path = "catalog_followup_event_transport.rs"]
pub(crate) mod event_transport;
pub use event_transport::*;

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FollowupRepeat {
    #[default]
    Once,
    Each,
}
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
    BotSuspended,
    TargetUnavailable,
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
    PluginEvent {
        source: PluginEventSource,
        filter: Value,
    },
    Metric {
        machine_id: String,
        metric: MetricKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gpu_uuid: Option<String>,
        predicate: MetricPredicate,
        threshold: serde_json::Number,
    },

    LogLiteral {
        operation_id: String,
        stream: LogStream,
        from_offset: u64,
        literal_bytes: u64,
    },
    LogEnd {
        operation_id: String,
        stream: LogStream,
    },

    At {
        at_ms: u64,
    },
    ProcessStopped {
        operation_id: String,
    },
    JobStopped {
        operation_id: String,
    },
    Artifact {
        operation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Collection {
        operation_id: String,
    },
    File {
        path: String,
        condition: FileCondition,
    },
    Any {
        sources: Vec<FollowupSource>,
    },
    All {
        sources: Vec<FollowupSource>,
    },
    RunCompleted {
        cursor: u64,
    },
    GoalRequested {
        cursor: u64,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TriggerEvidence {
    PluginEvents {
        event_ids: Vec<String>,
        received_at_ms: u64,
        calendar_occurrence_id: Option<String>,
    },
    Metric {
        fact: FollowupMetricEvidence,
    },
    LogLiteral {
        binding: host_jobs::HostJobBinding,
        stream: LogStream,
        start_offset: u64,
        end_offset: u64,
        published_bytes: u64,
        job_revision: u64,
    },
    LogEnd {
        binding: host_jobs::HostJobBinding,
        stream: LogStream,
        published_bytes: u64,
        job_revision: Option<u64>,
        attempt_revision: u64,
    },

    Artifact {
        binding: host_jobs::HostJobBinding,
        fact: FollowupArtifactFact,
        gap: bool,
    },
    Collection {
        binding: host_jobs::HostJobBinding,
        completion_revision: u64,
        outcome: ResearchCollectionOutcome,
        counts: ResearchArtifactCounts,
        gap: bool,
    },
    File {
        receipt_id: String,
        condition: FileCondition,
        path: String,
        state: FileState,
        proof: FileProof,
        position: Option<FileWatchPosition>,
        gap: bool,
        observed_at_ms: u64,
    },
    At {
        at_ms: u64,
        observed_at_ms: u64,
    },
    ProcessStopped {
        receipt_identity: String,
        receipt_epoch: String,
    },
    JobStopped {
        binding: host_jobs::HostJobBinding,
        outcome: Outcome,
        effect: Effect,
        receipt_identity: String,
        receipt_epoch: String,
    },
    Any {
        sources: Vec<FollowupSourceEvidence>,
    },
    All {
        sources: Vec<FollowupSourceEvidence>,
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
    pub thread_id: String,
    pub branch_id: String,
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
    pub accepted_cursor: u64,
    pub generation: u64,
    pub trigger_cursor: u64,
    pub evidence: TriggerEvidence,
    pub state: OccurrenceState,
    pub hold_reason: Option<HoldReason>,
    pub delivery: Option<FollowupDelivery>,
    pub target: Option<EventDeliveryTarget>,
    pub external_delivery: Option<ExternalEventDeliveryView>,
}
/// Only observed facts and original ingress identity are stored. State and delivery are projections.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Occurrence {
    id: String,
    accepted_cursor: u64,
    generation: u64,
    trigger_cursor: u64,
    evidence: TriggerEvidence,
    input_id: Option<String>,
    preparation_failed: bool,
    passive: bool,
    cancelled: bool,
    target: Option<EventDeliveryTarget>,
    #[serde(default)]
    external_delivery: Option<ExternalEventDelivery>,
    user_input: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Followup {
    pub id: String,
    pub repeat: FollowupRepeat,
    pub pending_occurrences: u64,
    pub exhausted: bool,
    pub revision: u64,
    pub generation: u64,
    pub thread_id: String,
    pub branch_id: String,
    pub source_run_id: Option<String>,
    pub first_contact: Option<FirstContactPolicy>,
    pub external_conversation_id: Option<String>,
    pub owner: FollowupOwner,
    pub name: Option<String>,
    pub timing: EventTiming,
    pub pending_events: u64,
    pub next_delivery_at_ms: Option<u64>,
    pub source_status: Option<EventSourceStatus>,
    pub goal_id: Option<String>,
    pub actor: FollowupActor,
    pub has_instruction: bool,
    pub registered_at_ms: u64,
    pub trigger: FollowupTrigger,
    pub sources: Vec<FollowupSourceState>,
    pub state: FollowupState,
    pub wait: NextRunWait,
    pub observation: Option<observation::FollowupObservation>,
    pub occurrence: Option<FollowupOccurrence>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Definition {
    id: String,
    repeat: FollowupRepeat,
    revision: u64,
    generation: u64,
    thread_id: String,
    branch_id: String,
    source_run_id: Option<String>,
    principal_id: Option<String>,
    #[serde(default)]
    external_conversation_id: Option<String>,
    #[serde(default)]
    first_contact: Option<FirstContactPolicy>,
    owner: FollowupOwner,
    name: Option<String>,
    timing: EventTiming,
    event_after: u64,
    #[serde(default)]
    discard_before_ms: u64,
    calendar_after: u64,
    goal_id: Option<String>,
    actor: FollowupActor,
    instruction_ref: Option<Value>,
    registered_at_ms: u64,
    observation_operation_id: Option<String>,
    trigger: FollowupTrigger,
    sources: Vec<FollowupSourceState>,
    state: FollowupState,
    wait: NextRunWait,
    source: Option<launches::SourceSelection>,
    scope: Option<context::ContextScope>,
}
impl Definition {
    fn work_run(&self) -> Result<&str> {
        self.source_run_id
            .as_deref()
            .ok_or_else(|| RuntimeError::Invalid("work follow-up source Run missing".into()))
    }
    fn autonomous(&self) -> bool {
        matches!(self.actor, FollowupActor::Goal { .. })
    }
}
pub(super) fn initialize_new(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE followups(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),source_run_id TEXT REFERENCES runs(id),body TEXT NOT NULL);
      CREATE INDEX followups_thread ON followups(thread_id);
      CREATE INDEX followups_source ON followups(source_run_id);
      CREATE INDEX followups_bot ON followups(json_extract(body,'$.owner.bot_id'));
      CREATE INDEX followups_wait_state ON followups(json_extract(body,'$.wait.state'));
      CREATE TABLE followup_occurrences(id TEXT PRIMARY KEY,followup_id TEXT NOT NULL REFERENCES followups(id),accepted_cursor INTEGER NOT NULL, input_id TEXT UNIQUE REFERENCES input_queue(id),body TEXT NOT NULL);
      CREATE INDEX followup_occurrences_order ON followup_occurrences(followup_id,accepted_cursor);
      CREATE INDEX followup_occurrences_unprepared ON followup_occurrences(followup_id,accepted_cursor) WHERE input_id IS NULL;
      CREATE INDEX followup_inputs_pending ON input_queue(json_extract(body,'$.origin.followup_id'),state) WHERE origin='followup';
      CREATE INDEX followup_source_edges ON events(subject,json_extract(data,'$.generation'),json_extract(data,'$.source_index'),cursor) WHERE kind='followup.source_observed';
      CREATE INDEX followup_research_edges ON events(subject,json_extract(data,'$.generation'),json_extract(data,'$.source_index'),json_extract(data,'$.entity'),json_extract(data,'$.domain_revision')) WHERE kind='followup.source_observed';")?;
    events::initialize(tx)?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,thread_id,source_run_id,body FROM followups")?;
    db.prepare("SELECT id,followup_id,accepted_cursor,input_id,body FROM followup_occurrences")?;
    Ok(())
}
fn latest_occurrence(db: &Connection, id: &str) -> Result<Option<Occurrence>> {
    db.query_row(
        "SELECT body FROM followup_occurrences WHERE followup_id=?1 ORDER BY accepted_cursor DESC LIMIT 1",
        [id],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|s| Ok(serde_json::from_str(&s)?))
    .transpose()
}
fn occurrence(db: &Connection, followup: &str, id: &str) -> Result<Occurrence> {
    let raw: String = db.query_row(
        "SELECT body FROM followup_occurrences WHERE id=?1 AND followup_id=?2",
        params![id, followup],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&raw)?)
}
fn pending_occurrence_count(db: &Connection, d: &Definition) -> Result<u64> {
    if d.state == FollowupState::Cancelled {
        return Ok(0);
    }
    let external = events::pending_external_count(db, &d.id)?;
    Ok(external+db.query_row(
        "SELECT (SELECT count(*) FROM followup_occurrences WHERE followup_id=?1 AND input_id IS NULL AND json_extract(body,'$.external_delivery') IS NULL AND json_extract(body,'$.cancelled')=0)
            +(SELECT count(*) FROM input_queue WHERE origin='followup'
                AND json_extract(body,'$.origin.followup_id')=?1 AND state='queued')",
        [&d.id],
        |r| read_number(r, 0),
    )?)
}
/// Source progress and delivery may advance while the body is prepared. They do not
/// revoke a different, already frozen occurrence's authorization.
fn same_authorization(left: &Definition, right: &Definition) -> bool {
    left.id == right.id
        && left.revision == right.revision
        && left.generation == right.generation
        && left.repeat == right.repeat
        && left.thread_id == right.thread_id
        && left.branch_id == right.branch_id
        && left.principal_id == right.principal_id
        && left.external_conversation_id == right.external_conversation_id
        && left.owner == right.owner
        && left.name == right.name
        && left.timing == right.timing
        && left.source_run_id == right.source_run_id
        && left.goal_id == right.goal_id
        && left.actor == right.actor
        && left.instruction_ref == right.instruction_ref
        && left.trigger == right.trigger
        && left.state == right.state
        && left.source == right.source
        && left.scope == right.scope
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
        == normalized_source(d.source.clone(), d.work_run()?)
    {
        return Ok(true);
    }
    // Sanctioned child changes are derived solely from every original immutable predecessor.
    let source_run: Run = record(db, "runs", d.work_run()?)?;
    let original: launch_content::LaunchMetadata = record(db, "run_launches", &source_run.id)?;
    if normalized_source(original.selection.source, &source_run.id)
        != normalized_source(d.source.clone(), d.work_run()?)
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
    v: &Occurrence,
    goal: &goals::Definition,
) -> Result<bool> {
    if !v.evidence.has_at()
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
    let process_owned = managed_process::require_process(&process).is_ok();
    Ok(
        goals::for_run(db, &owner.id)?.is_some_and(|g| g.id == goal.id)
            && owner.thread_id == d.thread_id
            && owner.branch_id == d.branch_id
            && normalized_source(launch.selection.source, &owner.id)
                == normalized_source(d.source.clone(), d.work_run()?)
            && matches!(process.lifetime, Lifetime::Thread | Lifetime::Environment)
            && process_owned
            && matches!(process.call_completion,Some(result_content::ToolCompletionMetadata::JobAccepted{operation_id,..}) if operation_id==process.id),
    )
}
fn goal_hold(db: &Connection, d: &Definition, v: &Occurrence) -> Result<Option<HoldReason>> {
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
        || (goal.blocked.is_some() && !dependency_check_eligible(db, d, v, &goal)?)
    {
        return Ok(Some(HoldReason::GoalBlocked));
    }
    Ok(None)
}
fn eligibility(
    db: &Connection,
    d: &Definition,
    v: &Occurrence,
    target: Option<&Run>,
) -> Result<Option<HoldReason>> {
    if d.state == FollowupState::Paused {
        return Ok(Some(HoldReason::ControlPaused));
    }
    if let Some(reason) = goal_hold(db, d, v)? {
        return Ok(Some(reason));
    }
    if matches!(d.owner, FollowupOwner::Bot { .. }) {
        let mut actual = d.clone();
        if let Some(target) = &v.target {
            actual.thread_id = target.thread_id.clone();
            actual.branch_id = target.branch_id.clone();
            actual.external_conversation_id = target.external_conversation_id.clone();
        }
        return events::target_hold(db, &actual);
    }
    let source: Run = record(db, "runs", d.work_run()?)?;
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
                && Some(goal.source_run_id.as_str()) != d.source_run_id.as_deref()
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
    if !sources::evidence_settled(db, &v.evidence)? {
        return Ok(Some(HoldReason::SourceUnsettled));
    }
    Ok(None)
}
fn observe(tx: &Transaction<'_>, d: &mut Definition, now: u64) -> Result<bool> {
    let mut changed = false;
    while observe_one(tx, d, now)? {
        changed = true;
        if d.repeat == FollowupRepeat::Once {
            break;
        }
    }
    Ok(changed)
}
fn observe_one(tx: &Transaction<'_>, d: &mut Definition, now: u64) -> Result<bool> {
    if d.state == FollowupState::Cancelled
        || d.wait.state != NextRunWaitState::Waiting
        || sources::exhausted(tx, d)?
    {
        return Ok(false);
    }
    if matches!(d.trigger, FollowupTrigger::PluginEvent { .. }) {
        return events::observe_events(tx, d, now, false);
    }
    let run: Run = record(tx, "runs", d.work_run()?)?;
    let (accepted_cursor, cursor, evidence) = match &d.trigger {
        FollowupTrigger::PluginEvent { .. } => unreachable!(),
        FollowupTrigger::Metric { .. }
        | FollowupTrigger::At { .. }
        | FollowupTrigger::ProcessStopped { .. }
        | FollowupTrigger::JobStopped { .. }
        | FollowupTrigger::File { .. }
        | FollowupTrigger::Artifact { .. }
        | FollowupTrigger::Collection { .. }
        | FollowupTrigger::LogLiteral { .. }
        | FollowupTrigger::LogEnd { .. }
        | FollowupTrigger::Any { .. }
        | FollowupTrigger::All { .. } => {
            let Some(observed) = sources::observe_sources(tx, d, now)? else {
                return Ok(false);
            };
            if d.autonomous() {
                if let (Some(goal), FollowupTrigger::ProcessStopped { operation_id }) =
                    (&d.goal_id, &d.trigger)
                {
                    goals::clear_dependency(tx, goal, operation_id)?;
                }
            }
            observed
        }
        FollowupTrigger::RunCompleted { cursor } => {
            if run.state != RunState::Completed {
                return Ok(false);
            };
            (
                *cursor,
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
                *cursor,
                TriggerEvidence::GoalRequested {
                    run_revision: run.revision,
                },
            )
        }
    };
    let v = Occurrence {
        id: format!("{}:{}:{accepted_cursor}", d.id, d.generation),
        accepted_cursor,
        generation: d.generation,
        trigger_cursor: cursor,
        evidence,
        input_id: None,
        preparation_failed: false,
        passive: false,
        cancelled: false,
        target: None,
        external_delivery: None,
        user_input: false,
    };
    tx.execute(
        "INSERT INTO followup_occurrences(id,followup_id,accepted_cursor,input_id,body) VALUES(?1,?2,?3,NULL,?4)",
        params![v.id, d.id, sql_number(accepted_cursor)?, encode(&v)?],
    )?;
    d.wait.trigger_cursor = Some(cursor);
    if d.repeat == FollowupRepeat::Once {
        d.wait.state = NextRunWaitState::Observed;
    }
    put(tx, "followups", &d.id, d)?;
    event(
        tx,
        &d.id,
        d.revision,
        "followup.observed",
        json!({"occurrence_id":v.id,"accepted_cursor":accepted_cursor,"trigger_cursor":cursor}),
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
        eligibility(db, d, &v, None)?
    };
    let external_delivery = v
        .external_delivery
        .as_ref()
        .map(|receipt| external::project(db, receipt))
        .transpose()?;
    if let Some(external) = &external_delivery {
        hold = None;
        state = match external.state.as_str() {
            "completed" => OccurrenceState::Completed,
            "failed" | "interrupted" => OccurrenceState::Failed,
            "cancelled" => OccurrenceState::Cancelled,
            _ => OccurrenceState::Admitted,
        };
        if external.hold_reason.is_some() {
            state = OccurrenceState::Held;
            hold = Some(HoldReason::TargetUnavailable);
        }
    }
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
            IngressActivationFact::Passive => ("passive", row.run_id.clone(), None, None),
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
            thread_id: row.thread_id.clone(),
            branch_id: row.branch_id.clone(),
            state: row.state,
            activation_state: activation_state.into(),
            run_id,
            execution_id,
            delivered_cursor: row.delivered_cursor,
            failure_code,
        });
    }
    if (v.cancelled || d.state == FollowupState::Cancelled)
        && !delivery
            .as_ref()
            .is_some_and(|r| r.state == InputState::Delivered)
        && !external_delivery
            .as_ref()
            .is_some_and(|r| !matches!(r.state.as_str(), "queued" | "preparing" | "awaiting_input"))
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
        accepted_cursor: v.accepted_cursor,
        generation: v.generation,
        trigger_cursor: v.trigger_cursor,
        evidence: v.evidence,
        state,
        hold_reason: hold,
        target: v.target,
        external_delivery,
        delivery,
    })
}
fn project(db: &Connection, d: Definition) -> Result<Followup> {
    let occurrence = latest_occurrence(db, &d.id)?
        .map(|v| project_occurrence(db, &d, v))
        .transpose()?;
    let observation = d
        .observation_operation_id
        .as_ref()
        .map(|id| observation::project(db, id))
        .transpose()?;
    let pending_occurrences = pending_occurrence_count(db, &d)?;
    let exhausted = sources::exhausted(db, &d)?;
    let (pending_events, next_delivery_at_ms, source_status) = events::projection(db, &d)?;
    Ok(Followup {
        first_contact: d.first_contact,
        external_conversation_id: d.external_conversation_id,
        owner: d.owner,
        name: d.name,
        timing: d.timing,
        pending_events,
        next_delivery_at_ms,
        source_status,
        exhausted,
        repeat: d.repeat,
        pending_occurrences,
        id: d.id,
        revision: d.revision,
        generation: d.generation,
        thread_id: d.thread_id,
        branch_id: d.branch_id,
        source_run_id: d.source_run_id,
        goal_id: d.goal_id,
        actor: d.actor,
        has_instruction: d.instruction_ref.is_some(),
        registered_at_ms: d.registered_at_ms,
        trigger: d.trigger,
        sources: d.sources,
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
    let input_ids = {
        let mut q = tx.prepare("SELECT id FROM input_queue WHERE origin='followup' AND json_extract(body,'$.origin.followup_id')=?1 AND state='queued'")?;
        let rows = q.query_map([&d.id], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for id in input_ids {
        let mut row = record(tx, "input_queue", &id)?;
        activation::cancel_row(tx, &mut row)?;
    }
    observation::cancel_definition(tx, d)?;
    events::cancel_external_batches(tx, &d.id)?;
    events::settle_calendar_slots(tx)?;
    event(tx, &d.id, d.revision, "followup.cancelled", Value::Null)?;
    Ok(())
}
pub(super) fn cancel_source_run(tx: &Transaction<'_>, run: &str) -> Result<()> {
    cancel_source_registrations(tx, run, false)
}
pub(super) fn cancel_branch(tx: &Transaction<'_>, thread: &str, branch: &str) -> Result<()> {
    let mut query = tx.prepare(
        "SELECT body FROM followups WHERE thread_id=?1 AND json_extract(body,'$.branch_id')=?2",
    )?;
    let rows = query
        .query_map(params![thread, branch], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for raw in rows {
        let mut d: Definition = serde_json::from_str(&raw)?;
        if matches!(d.owner, FollowupOwner::Work) {
            cancel_definition(tx, &mut d)?;
        }
    }
    Ok(())
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
        if matches!(d.owner, FollowupOwner::Work) && (goals || !d.autonomous()) {
            cancel_definition(tx, &mut d)?;
        }
    }
    Ok(())
}
/// Only the original explicit Stop admission may cancel continuing authorization
/// for the current branch. Late terminal receipts keep their exact source-Run scope.
pub(super) fn cancel_current_repeating(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    let current: Option<String> = tx.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [&run.branch_id],
        |r| r.get(0),
    )?;
    if current.as_deref() != Some(&run.id) {
        return Ok(());
    }
    let definitions = {
        let mut q = tx.prepare(
            "SELECT body FROM followups WHERE thread_id=?1 AND json_extract(body,'$.branch_id')=?2
            AND json_extract(body,'$.repeat')='each' AND json_extract(body,'$.state')!='cancelled'",
        )?;
        let rows = q.query_map(params![run.thread_id, run.branch_id], |r| {
            r.get::<_, String>(0)
        })?;
        rows.map(|r| Ok(serde_json::from_str::<Definition>(&r?)?))
            .collect::<Result<Vec<_>>>()?
    };
    for mut d in definitions
        .into_iter()
        .filter(|d| matches!(d.owner, FollowupOwner::Work))
    {
        cancel_definition(tx, &mut d)?;
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
    let sources = trigger
        .sources()
        .iter()
        .enumerate()
        .map(|(source_index, source)| FollowupSourceState {
            source_index,
            after_cursor: cursor,
            observed: None,
            consumed_cursor: 0,
            file: None,
            log: logs::initial_state(source),
            metric: metrics::initial_state(source),
        })
        .collect();
    let kind = match trigger {
        FollowupTrigger::PluginEvent { .. } => "plugin_event",
        FollowupTrigger::Metric { .. } => "metric",
        FollowupTrigger::At { .. } => "at",
        FollowupTrigger::File { .. } => "file",
        FollowupTrigger::Any { .. } => "any",
        FollowupTrigger::All { .. } => "all",
        FollowupTrigger::ProcessStopped { .. } => "process_stopped",
        FollowupTrigger::JobStopped { .. } => "job_stopped",
        FollowupTrigger::Artifact { .. } => "artifact",
        FollowupTrigger::Collection { .. } => "collection",
        FollowupTrigger::LogLiteral { .. } => "log_literal",
        FollowupTrigger::LogEnd { .. } => "log_end",
        FollowupTrigger::RunCompleted { .. } => "run_completed",
        FollowupTrigger::GoalRequested { .. } => "goal_requested",
    };
    Ok(Definition {
        repeat: FollowupRepeat::Once,
        id: key.into(),
        revision: 1,
        generation: 1,
        thread_id: run.thread_id.clone(),
        branch_id: run.branch_id.clone(),
        source_run_id: Some(run.id.clone()),
        principal_id: principals::thread(db, &run.thread_id)?,
        external_conversation_id: None,
        first_contact: None,
        owner: FollowupOwner::Work,
        name: None,
        timing: EventTiming::Immediate,
        event_after: 0,
        discard_before_ms: 0,
        calendar_after: 0,
        goal_id: goal,
        actor,
        instruction_ref: None,
        registered_at_ms: now,
        observation_operation_id: None,
        trigger,
        sources,
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
    tx.execute(
        "INSERT INTO followups(id,thread_id,source_run_id,body) VALUES(?1,?2,?3,?4)",
        params![
            d.id,
            d.thread_id,
            if matches!(d.owner, FollowupOwner::Work) {
                d.source_run_id.as_deref()
            } else {
                None
            },
            encode(d)?
        ],
    )?;
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
        if d.source_run_id.as_deref() != Some(run_id)
            || d.trigger
                != (FollowupTrigger::ProcessStopped {
                    operation_id: operation_id.into(),
                })
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
        let mut q=tx.prepare("SELECT body FROM followups WHERE json_extract(body,'$.actor.kind')='goal' AND json_extract(body,'$.goal_id')=?1 AND json_extract(body,'$.trigger.kind') IN ('run_completed','goal_requested') AND json_extract(body,'$.wait.state') IN ('waiting','observed')")?;
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
    let v = occurrence(db, followup_id, occurrence_id)?;
    if d.generation != *generation
        || v.id != *occurrence_id
        || v.input_id.as_deref() != Some(&row.id)
    {
        return Err(RuntimeError::Conflict(
            "follow-up ingress identity changed".into(),
        ));
    }
    if v.cancelled || d.state == FollowupState::Cancelled {
        return Ok(Some(HoldReason::ControlPaused));
    }
    if d.state == FollowupState::Paused {
        return Ok(Some(HoldReason::ControlPaused));
    }
    if let Some(reason) = goal_hold(db, &d, &v)? {
        return Ok(Some(reason));
    }
    if matches!(d.owner, FollowupOwner::Bot { .. }) {
        return events::ingress_target_hold(db, &d, row);
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
            occurrence_id,
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
        let v = occurrence(db, followup_id, occurrence_id)?;
        if d.goal_id.as_deref() == Some(&goal.id)
            && d.state == FollowupState::Active
            && dependency_check_eligible(db, &d, &v, goal)?
            && ingress_hold(db, &row, Some(&record(db, "runs", run)?))?.is_none()
        {
            return Ok(true);
        }
    }
    Ok(false)
}
pub(super) fn delivered(tx: &Transaction<'_>, row: &QueuedInputMetadata) -> Result<()> {
    let InputOrigin::Followup {
        followup_id,
        occurrence_id,
        generation,
        ..
    } = &row.origin
    else {
        return Ok(());
    };
    let mut d: Definition = record(tx, "followups", followup_id)?;
    let v = occurrence(tx, followup_id, occurrence_id)?;
    if v.input_id.as_deref() != Some(&row.id) || v.generation != *generation {
        return Err(RuntimeError::Conflict(
            "follow-up delivery identity changed".into(),
        ));
    }
    if d.repeat == FollowupRepeat::Once && pending_occurrence_count(tx, &d)? == 0 {
        d.wait.state = NextRunWaitState::Consumed;
        put(tx, "followups", &d.id, &d)?;
    }
    event(
        tx,
        &d.id,
        d.revision,
        "followup.delivered",
        json!({"occurrence_id":v.id,"input_id":row.id,"run_id":row.run_id,"delivered_cursor":row.delivered_cursor}),
    )?;
    Ok(())
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowupOccurrencesResult {
    pub occurrences: Vec<FollowupOccurrence>,
    #[serde(rename = "nextCursor")]
    pub next_cursor: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowupView {
    pub followup: Followup,
    pub instruction: Option<String>,
    pub registration_trigger: Option<FollowupRegistrationTrigger>,
}
pub struct FollowupRead {
    registration: Option<Value>,
    followup: Followup,
    instruction: Option<Value>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct WorkFollowupEdit {
    id: String,
    revision: u64,
    instruction: String,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedWorkFollowupEdit {
    id: String,
    revision: u64,
    instruction: Value,
    _publication: crate::content::ContentPublication,
}
impl WorkFollowupEdit {
    pub fn load(self) -> Result<PreparedWorkFollowupEdit> {
        if self.instruction.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "Follow-up instruction is required".into(),
            ));
        }
        Ok(PreparedWorkFollowupEdit {
            id: self.id,
            revision: self.revision,
            instruction: self.content.save(&json!(self.instruction))?,
            _publication: self._publication,
        })
    }
}
impl Catalog {
    pub fn prepare_work_followup_edit(
        &self,
        id: &str,
        revision: u64,
        instruction: String,
    ) -> Result<WorkFollowupEdit> {
        let d: Definition = record(&self.db, "followups", id)?;
        if d.owner != FollowupOwner::Work || d.autonomous() {
            return Err(RuntimeError::Invalid(
                "Use the original arrangement or Goal editor".into(),
            ));
        }
        Ok(WorkFollowupEdit {
            id: id.into(),
            revision,
            instruction,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn edit_work_followup(
        &mut self,
        prepared: PreparedWorkFollowupEdit,
        at: Option<u64>,
        condition: Option<files::FileCondition>,
    ) -> Result<Followup> {
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "followups", &prepared.id)?;
        if d.revision != prepared.revision {
            return Err(RuntimeError::Conflict(
                "Follow-up changed; reload before saving".into(),
            ));
        }
        if d.state == FollowupState::Cancelled || d.wait.state == NextRunWaitState::Consumed {
            return Err(RuntimeError::Conflict("Follow-up has ended".into()));
        }
        let mut trigger = d.trigger.clone();
        if let Some(at_ms) = at {
            match &mut trigger {
                FollowupTrigger::At { at_ms: value } => *value = at_ms,
                _ => {
                    return Err(RuntimeError::Invalid(
                        "This follow-up does not wait for a time".into(),
                    ))
                }
            }
        }
        if let Some(value) = condition {
            match &mut trigger {
                FollowupTrigger::File { condition, .. } => *condition = value,
                _ => {
                    return Err(RuntimeError::Invalid(
                        "This follow-up does not wait for a file".into(),
                    ))
                }
            }
            if d.repeat == FollowupRepeat::Each && value != files::FileCondition::Changed {
                return Err(RuntimeError::Invalid(
                    "Repeating file follow-ups require changes".into(),
                ));
            }
        }
        if d.trigger != trigger {
            d.trigger = trigger;
            d.generation += 1;
            d.wait.state = NextRunWaitState::Waiting;
            d.wait.trigger_cursor = None;
            d.wait.after_cursor =
                tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |row| {
                    read_number(row, 0)
                })?;
            for source in &mut d.sources {
                source.observed = None;
                source.consumed_cursor = 0;
            }
        }
        d.instruction_ref = Some(prepared.instruction);
        d.revision += 1;
        put(&tx, "followups", &d.id, &d)?;
        event(
            &tx,
            &d.id,
            d.revision,
            "followup.updated",
            json!({"thread_id":d.thread_id}),
        )?;
        observe(&tx, &mut d, observations::wall_time_ms()?)?;
        let result = project(&tx, d)?;
        tx.commit()?;
        Ok(result)
    }
}

impl FollowupRead {
    pub fn load(self) -> Result<FollowupView> {
        Ok(FollowupView {
            followup: self.followup,
            registration_trigger: load_registration_trigger(
                &self.content,
                self.registration.as_ref(),
            )?,
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
    pub fn followup_occurrences(
        &self,
        id: &str,
        after: Option<u64>,
    ) -> Result<FollowupOccurrencesResult> {
        let d: Definition = record(&self.db, "followups", id)?;
        // Page size bounds a response, never the number of retained occurrences.
        let mut q = self.db.prepare(
            "SELECT body FROM followup_occurrences WHERE followup_id=?1
            AND accepted_cursor>?2 ORDER BY accepted_cursor LIMIT 65",
        )?;
        let rows = q.query_map(params![id, sql_number(after.unwrap_or(0))?], |r| {
            r.get::<_, String>(0)
        })?;
        let mut occurrences = rows
            .map(|r| project_occurrence(&self.db, &d, serde_json::from_str(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        let more = occurrences.len() > 64;
        occurrences.truncate(64);
        let next_cursor = more.then(|| occurrences.last().expect("page").accepted_cursor);
        Ok(FollowupOccurrencesResult {
            occurrences,
            next_cursor,
        })
    }
    pub fn capture_followup(&self, id: &str) -> Result<FollowupRead> {
        let d: Definition = record(&self.db, "followups", id)?;
        Ok(FollowupRead {
            registration: registration_intent(&self.db, id)?,
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
        Ok([
            sources::nearest_deadline(&self.db)?,
            events::nearest_deadline(&self.db)?,
        ]
        .into_iter()
        .flatten()
        .min())
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
        events::collect_payloads(&tx)?;
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
            if action == FollowupControlAction::Resume {
                for source in &mut d.sources {
                    if let Some(log) = &mut source.log {
                        log.failure_code = None;
                    }
                }
                let unfinished = {
                    let mut q = tx.prepare("SELECT o.body FROM followup_occurrences o LEFT JOIN input_queue i ON i.id=o.input_id
                        WHERE o.followup_id=?1 AND (o.input_id IS NULL OR i.state='queued') ORDER BY o.accepted_cursor")?;
                    let rows = q.query_map([id], |r| r.get::<_, String>(0))?;
                    rows.map(|r| Ok(serde_json::from_str::<Occurrence>(&r?)?))
                        .collect::<Result<Vec<_>>>()?
                };
                for mut v in unfinished {
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
    followup_reference: String,
    operation_references: std::collections::BTreeMap<String, String>,
    definition: Definition,
    occurrence: Occurrence,
    sources: Vec<Operation>,
    jobs: Vec<Operation>,
    goal: Option<goals::FrozenGoal>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    research_facts: Vec<(usize, u64, Value)>,
    event_facts: Vec<(Value, Value)>,
    event_dependencies: Vec<String>,
}
pub struct PreparedContinuation {
    external_input: Option<Value>,
    attachments: Vec<attachments::Attachment>,
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
        &self.occurrence.id
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
        let mut parts = Vec::new();
        let processes = self.sources.iter().enumerate().map(|(index, op)| -> Result<(Value, Value)> {
            let receipt = op.external_receipt.as_ref().ok_or_else(|| RuntimeError::Invalid("original process receipt missing".into()))?;
            let (result, model_result) = crate::model_input::append_output(&mut parts, self.content.load_output(&receipt.result_ref)?, format!("Process result {}:", index + 1));
            let mut fact = json!({"processId":op.id,"executorStopped":receipt.executor_stopped,"outcome":receipt.outcome,"effect":receipt.effect,"outputReader":{"name":"process_read","arguments":{"processId":op.id,"cursor":0}}});
            let mut model_fact = fact.clone();
            let reference = &self.operation_references[&op.id];
            model_fact["processId"] = json!(reference);
            model_fact["outputReader"]["arguments"]["processId"] = json!(reference);
            let mut model_result = model_result;
            // This is the original managed-process receipt shape, not arbitrary tool JSON.
            if let Some(fields) = model_result.as_object_mut() {
                fields.remove("kernelEpoch");
                if fields.get("processId") == Some(&json!(op.id)) { fields.insert("processId".into(), json!(reference)); }
            }
            if !result.is_null() { fact["result"] = result; }
            if !model_result.is_null() { model_fact["result"] = model_result; }
            Ok((fact, model_fact))
        }).collect::<Result<Vec<_>>>()?;
        let jobs = self.jobs.iter().enumerate().map(|(index, op)| -> Result<(Value, Value)> {
            let link = op.host_job.as_ref().ok_or_else(|| RuntimeError::Invalid("original job binding missing".into()))?;
            let receipt = op.external_receipt.as_ref().ok_or_else(|| RuntimeError::Invalid("original job stop receipt missing".into()))?;
            host_jobs::require_stop_receipt(op, receipt)?;
            let terminal = self.content.load_output(&receipt.result_ref)?;
            let accepted = self.content.load_output(link.acceptance_ref.as_ref().ok_or_else(||RuntimeError::Invalid("original job acceptance missing".into()))?)?;
            let accepted = crate::model_input::acceptance_details(accepted, &terminal);
            let (accepted, model_accepted) = crate::model_input::append_output(&mut parts, accepted, format!("Job {} initial details:", index + 1));
            let (result, model_result) = crate::model_input::append_output(&mut parts, terminal, format!("Job {} result:", index + 1));
            let mut fact = json!({"operationId":op.id,"domain":link.binding.domain,"executorStopped":receipt.executor_stopped,"outcome":receipt.outcome,"effect":receipt.effect});
            let mut model_fact = fact.clone();
            model_fact["operationId"] = json!(self.operation_references[&op.id]);
            if !accepted.is_null() { fact["accepted"] = accepted; }
            if !result.is_null() { fact["result"] = result; }
            if !model_accepted.is_null() { model_fact["accepted"] = model_accepted; }
            if !model_result.is_null() { model_fact["result"] = model_result; }
            Ok((fact, model_fact))
        }).collect::<Result<Vec<_>>>()?;
        let research_facts = self.research_facts.iter().map(|(index,_cursor,reference)| Ok(json!({"source_index":index,"content":self.content.load(reference)?}))).collect::<Result<Vec<Value>>>()?;
        let prefix_parts = parts.len() + usize::from(!v.user_input);
        let event_facts = self.event_facts.iter().enumerate().map(|(index, (metadata, reference))| {
            let output = self.content.load_output(reference)?;
            Ok(event_input::append_event(&mut parts, metadata, output, index + 1))
        }).collect::<Result<Vec<_>>>()?;
        let evidence = presentation::continuation_evidence(&v.evidence)?;
        let mut facts = json!({"followupId":d.id});
        if !evidence.is_null() { facts["evidence"] = evidence; }
        if !research_facts.is_empty() { facts["research"] = json!(research_facts); }
        if !jobs.is_empty() { facts["jobs"] = json!(jobs.iter().map(|(data, _)| data).collect::<Vec<_>>()); }
        if !processes.is_empty() { facts["processes"] = json!(processes.iter().map(|(data, _)| data).collect::<Vec<_>>()); }
        if !event_facts.is_empty() { facts["events"] = json!(event_facts.iter().map(|(data, _)| data).collect::<Vec<_>>()); }
        if let Some(goal) = &self.goal { facts["goalId"] = json!(goal.id); }
        let mut model_facts = facts.clone();
        model_facts["followupId"] = json!(self.followup_reference);
        if let Some(evidence) = model_facts.get_mut("evidence") {
            presentation::reference_continuation_evidence(evidence, &self.operation_references);
        }
        if !jobs.is_empty() { model_facts["jobs"] = json!(jobs.iter().map(|(_, data)| data).collect::<Vec<_>>()); }
        if !processes.is_empty() { model_facts["processes"] = json!(processes.iter().map(|(_, data)| data).collect::<Vec<_>>()); }
        if !event_facts.is_empty() { model_facts["events"] = json!(event_facts.iter().map(|(_, data)| data).collect::<Vec<_>>()); }
        let text = format!("Registered follow-up instruction:\n{}", instruction.as_deref().unwrap_or("Continue the explicitly established Goal according to its retained objective and controls."));
        if !v.user_input {
            parts.insert(0, crate::output::OutputPart::Text { text });
        }
        let item: ConversationItem = ConversationItem {
            resource_activation: None,
            id: format!("followup-input:{}", v.id),
            provenance: if v.user_input {
                Provenance::UserInstruction {
                    input_id: format!("followup-input:{}", v.id),
                }
            } else {
                Provenance::EnvironmentFact {
                    event_id: format!("followup:{}", v.id),
                }
            },
            content: Content::Output {
                output: crate::output::OutputBody { model_data: (model_facts != facts).then_some(model_facts), data: facts, parts },
            },
            opaque: None,
        };
        let attachments = match &item.content {
            Content::Output { output } => attachments::output_attachments(output),
            _ => vec![],
        };
        let metadata = matches!(v.evidence, TriggerEvidence::PluginEvents { .. }).then(|| json!({
            "arrangementEvents": {"instructionRef":d.instruction_ref,"prefixParts": prefix_parts, "events": self.event_facts, "arrangementId":d.id,"trigger":d.trigger}
        }));
        let mut dependencies = self.event_dependencies.clone();
        dependencies.extend(self.event_facts.iter().filter_map(|(_, reference)| reference["content_object"].as_str().map(str::to_owned)));
        let history = self.content.save_conversation_with_metadata(
            &item,
            &None,
            metadata,
            dependencies,
        )?;
        let external_input = if v
            .target
            .as_ref()
            .map_or(d.external_conversation_id.as_ref(), |target| {
                target.external_conversation_id.as_ref()
            })
            .is_some()
        {
            Some(external::prepare_input(&self.content, &history)?)
        } else {
            None
        };
        Ok(PreparedContinuation {
            external_input,
            attachments,
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
            let mut q=self.db.prepare("SELECT f.body,o.body FROM followups f JOIN followup_occurrences o ON o.followup_id=f.id WHERE o.input_id IS NULL AND json_extract(f.body,'$.state')!='cancelled' ORDER BY o.accepted_cursor")?;
            let r = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            r.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut out = vec![];
        for (definition, occurrence) in rows {
            let candidate = (|| -> Result<Option<ContinuationPreparation>> {
                let d: Definition = serde_json::from_str(&definition)?;
                let v: Occurrence = serde_json::from_str(&occurrence)?;
                if v.external_delivery.is_some()
                    || v.cancelled
                    || v.preparation_failed
                    || eligibility(&self.db, &d, &v, None)?.is_some()
                {
                    return Ok(None);
                }
                let sources = v
                    .evidence
                    .process_receipts()
                    .into_iter()
                    .map(|(id, _)| record(&self.db, "operations", id))
                    .collect::<Result<Vec<Operation>>>()?;
                let jobs = v
                    .evidence
                    .job_receipts(v.trigger_cursor)
                    .into_iter()
                    .map(|(binding, identity, epoch, cursor)| {
                        let mut op: Operation =
                            record(&self.db, "operations", &binding.operation_id)?;
                        let receipt =
                            host_jobs::stop_receipt(&self.db, cursor, binding, identity, epoch)?;
                        host_jobs::require_stop_receipt(&op, &receipt)?;
                        op.external_receipt = Some(receipt);
                        Ok(op)
                    })
                    .collect::<Result<Vec<Operation>>>()?;
                // Publication spans short-reference capture, unlocked body preparation and
                // admission. The future input is the eventual holder, not a permanent alias.
                let publication = self.content.begin_publication();
                let holder = format!("followup-input:{}", v.id);
                let followup_reference = self.register_model_reference(model_references::ReferenceKind::Followup,
                    "catalog-followup", &json!({"followupId":d.id}), &holder)?;
                let mut operation_references = std::collections::BTreeMap::new();
                for operation in sources.iter().chain(&jobs) {
                    operation_references.insert(operation.id.clone(), self.operation_model_reference(&operation.id, &holder)?);
                }
                presentation::capture_continuation_references(self, &v.evidence, &holder, &mut operation_references)?;
                let goal = effective_goal(&self.db, &d)?.map(|g| g.binding());
                Ok(Some(ContinuationPreparation {
                    followup_reference, operation_references,
                    event_facts: events::occurrence_refs(&self.db, &v)?,
                    event_dependencies: events::occurrence_file_dependencies(&self.db, &v)?,
                    research_facts: artifacts::occurrence_fact_refs(&self.db, &d, &v)?,
                    definition: d,
                    occurrence: v,
                    sources,
                    jobs,
                    goal,
                    epoch: self.epoch,
                    content: self.content.clone(),
                    publication,
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
        let followup: String = tx.query_row(
            "SELECT followup_id FROM followup_occurrences WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let d: Definition = record(&tx, "followups", &followup)?;
        let mut v = occurrence(&tx, &followup, id)?;
        if d.revision == revision
            && d.state != FollowupState::Cancelled
            && v.input_id.is_none()
            && !v.preparation_failed
        {
            v.preparation_failed = true;
            put(&tx, "followup_occurrences", id, &v)?;
            event(
                &tx,
                &followup,
                revision,
                "followup.preparation_failed",
                json!({"occurrence_id":id}),
            )?;
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
            attachments,
            external_input,
        } = p;
        let _publication = c.publication;
        if c.epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "follow-up owner changed or stopped".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let d: Definition = record(&tx, "followups", &c.definition.id)?;
        let mut v = occurrence(&tx, &d.id, &c.occurrence.id)?;
        if let Some(id) = v.input_id {
            return Ok(ContinuationAdmission::Admitted(id));
        }
        if !same_authorization(&d, &c.definition)
            || v != c.occurrence
            || effective_goal(&tx, &d)?.map(|d| d.binding()) != c.goal
            || c.sources
                .iter()
                .map(|o| record::<Operation>(&tx, "operations", &o.id).map(|v| v != *o))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .any(|changed| changed)
        {
            return Ok(ContinuationAdmission::Stale);
        }
        if v.cancelled
            || d.state == FollowupState::Cancelled
            || eligibility(&tx, &d, &v, None)?.is_some()
        {
            return Ok(ContinuationAdmission::Held);
        }
        if let Some(conversation) = v
            .target
            .as_ref()
            .map_or(d.external_conversation_id.as_ref(), |t| {
                t.external_conversation_id.as_ref()
            })
        {
            if let Some(receipt) = &v.external_delivery {
                return Ok(ContinuationAdmission::Admitted(receipt.turn_id.clone()));
            }
            let receipt = external::accept(
                &tx,
                conversation,
                &v.id,
                external_input.as_ref().ok_or_else(|| {
                    RuntimeError::Invalid("external input preparation is missing".into())
                })?,
                v.passive,
                self.epoch,
            )?;
            attachments::publish(
                &tx,
                &attachments::AttachmentDelivery {
                    holder_kind: "external_turn".into(),
                    holder_id: receipt.turn_id.clone(),
                    thread_id: receipt.conversation_id.clone(),
                    branch_id: String::new(),
                    source_thread_id: None,
                    source_branch_id: None,
                    attachments,
                    input_ref: Some(history.clone()),
                },
            )?;
            let id = receipt.turn_id.clone();
            tx.execute("INSERT OR IGNORE INTO model_reference_holders(reference_id,holder) SELECT reference_id,?2 FROM model_reference_holders WHERE holder=?1",
                params![format!("followup-input:{}", v.id), &id])?;
            v.external_delivery = Some(receipt);
            put(&tx, "followup_occurrences", &v.id, &v)?;
            tx.commit()?;
            return Ok(ContinuationAdmission::Admitted(id));
        }
        let input_id = format!("followup-input:{}", v.id);
        let target_thread = v
            .target
            .as_ref()
            .map_or(d.thread_id.as_str(), |t| t.thread_id.as_str());
        let target_branch = v
            .target
            .as_ref()
            .map_or(d.branch_id.as_str(), |t| t.branch_id.as_str());
        let activation = if v.passive {
            IngressActivationFact::Passive
        } else {
            activation::accept_target(&tx, target_thread, target_branch)?
        };
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
            target_thread.into(),
            target_branch.into(),
            cursor,
            InputOrigin::Followup {
                user_input: v.user_input,
                followup_id: d.id.clone(),
                occurrence_id: v.id.clone(),
                generation: d.generation,
                activation,
                goal: c.goal,
            },
            &history,
        )?;
        attachments::publish(
            &tx,
            &attachments::AttachmentDelivery {
                holder_kind: "input".into(),
                holder_id: input_id.clone(),
                thread_id: target_thread.into(),
                branch_id: target_branch.into(),
                source_thread_id: None,
                source_branch_id: None,
                attachments,
                input_ref: Some(history.clone()),
            },
        )?;
        if let TriggerEvidence::PluginEvents {
            calendar_occurrence_id: Some(calendar),
            ..
        } = &v.evidence
        {
            calendar::bind_arrangement_input(&tx, calendar, &input_id)?;
        }
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
    let InputOrigin::Followup {
        followup_id,
        occurrence_id,
        ..
    } = &row.origin
    else {
        return Ok(false);
    };
    let d: Definition = record(db, "followups", followup_id)?;
    let v = occurrence(db, followup_id, occurrence_id)?;
    let Some(goal) = effective_goal(db, &d)? else {
        return Ok(false);
    };
    let usage: goals::GoalUsage = record(db, "goal_usage", &goal.id)?;
    Ok(goal.control == goals::GoalControl::Active
        && !goals::budget_limited(&goal, &usage)
        && !goals::usage_unknown(&goal, &usage)
        && dependency_check_eligible(db, &d, &v, &goal)?
        && ingress_hold(db, row, None)?.is_none())
}

fn registration_intent(db: &Connection, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT intent FROM commands WHERE id=?1",
            [registration::key(id)],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| Ok(serde_json::from_str(&raw)?)).transpose()
}
fn load_registration_trigger(
    content: &crate::content::ContentStore,
    reference: Option<&Value>,
) -> Result<Option<FollowupRegistrationTrigger>> {
    reference
        .map(|reference| {
            let value = content.load(reference)?;
            let registration: FollowupRegistration =
                serde_json::from_value(value["registration"].clone())?;
            Ok(registration.trigger)
        })
        .transpose()
}
