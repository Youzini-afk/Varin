//! One explicit, one-shot process continuation. Catalog owns authorization, the next-Run wait,
//! occurrence consumption and admission. The process owner remains the only execution authority.
use super::*;
use crate::execution::{CompletionKind, Content, ConversationItem, Provenance};
use serde::Deserialize;
use std::sync::{atomic::Ordering, Mutex};

type Result<T> = std::result::Result<T, RuntimeError>;

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
    GoalPaused, GoalBudget, GoalBlocked, GoalEnded, GoalSuperseded,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum FollowupTrigger {
    ProcessStopped { operation_id:String },
    RunCompleted { cursor:u64 },
    GoalRequested { cursor:u64 },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag="kind",rename_all="snake_case",deny_unknown_fields)]
pub enum TriggerEvidence {
    ProcessStopped { receipt_identity:String,receipt_epoch:String },
    RunCompleted { run_revision:u64 },
    GoalRequested { run_revision:u64 },
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
pub struct FollowupOccurrence {
    pub id: String,
    pub generation: u64,
    pub trigger_cursor: u64,
    pub evidence: TriggerEvidence,
    pub state: OccurrenceState,
    pub hold_reason: Option<HoldReason>,
    pub receipt: Option<Receipt>,
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
    pub goal_id:Option<String>,
    pub trigger:FollowupTrigger,
    pub state: FollowupState,
    pub wait: NextRunWait,
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
    goal_id:Option<String>,
    trigger:FollowupTrigger,
    state: FollowupState,
    wait: NextRunWait,
    configuration: Value,
    launch: launch_content::LaunchMetadata,
    scope: Option<context::ContextScope>,
}
impl Definition {
    fn project(self, occurrence: Option<FollowupOccurrence>) -> Followup {
        Followup {
            id: self.id,
            revision: self.revision,
            generation: self.generation,
            thread_id: self.thread_id,
            branch_id: self.branch_id,
            source_run_id: self.source_run_id,
            operation_id: self.operation_id,
            goal_id:self.goal_id,trigger:self.trigger,
            state: self.state,
            wait: self.wait,
            occurrence,
        }
    }
}

pub(super) fn initialize_new(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE followups(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),source_run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT REFERENCES operations(id),body TEXT NOT NULL);
        CREATE INDEX followups_thread ON followups(thread_id);
        CREATE INDEX followups_source ON followups(source_run_id);
        CREATE INDEX followups_wait_state ON followups(json_extract(body,'$.wait.state'));
        CREATE TABLE followup_occurrences(id TEXT PRIMARY KEY,followup_id TEXT NOT NULL UNIQUE REFERENCES followups(id),run_id TEXT UNIQUE REFERENCES runs(id),body TEXT NOT NULL);
        CREATE INDEX followup_occurrence_state ON followup_occurrences(json_extract(body,'$.state'));")?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,thread_id,source_run_id,operation_id,body FROM followups")?;
    db.prepare("SELECT id,followup_id,run_id,body FROM followup_occurrences")?;
    Ok(())
}
fn occurrence(db: &Connection, definition: &str) -> Result<Option<FollowupOccurrence>> {
    db.query_row(
        "SELECT body FROM followup_occurrences WHERE followup_id=?1",
        [definition],
        |r| r.get::<_, String>(0),
    )
    .optional()?
    .map(|raw| Ok(serde_json::from_str(&raw)?))
    .transpose()
}
fn project(db: &Connection, definition: Definition) -> Result<Followup> {
    let value = occurrence(db, &definition.id)?;
    Ok(definition.project(value))
}
fn active_context(
    db: &Connection,
    branch: &str,
) -> Result<(Option<String>, Option<context::ContextScope>)> {
    let value: Option<(String, Option<String>)> = db.query_row(
        "SELECT c.id,c.scope FROM active_contexts a JOIN context_checkpoints c ON c.id=a.checkpoint_id WHERE a.branch_id=?1", [branch], |r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    match value {
        Some((id, scope)) => Ok((
            Some(id),
            scope.map(|raw| serde_json::from_str(&raw)).transpose()?,
        )),
        None => Ok((None, None)),
    }
}
fn observe(tx: &Transaction<'_>, definition: &mut Definition) -> Result<()> {
    if definition.state == FollowupState::Cancelled
        || definition.wait.state != NextRunWaitState::Waiting
    {
        return Ok(());
    }
    let run: Run = record(tx, "runs", &definition.source_run_id)?;
    let (trigger_cursor, evidence) = match &definition.trigger {
        FollowupTrigger::ProcessStopped { operation_id } => {
            let operation: Operation = record(tx, "operations", operation_id)?;
            let Some(receipt) = operation
                .external_receipt
                .as_ref()
                .filter(|r| r.executor_stopped)
            else {
                return Ok(());
            };
            if receipt.identity != operation.id
                || receipt.executor != "process_spawn"
                || operation.execution_owner != Some(ExecutorOwner::Kernel)
            {
                return Err(RuntimeError::Invalid(
                    "process stop receipt owner mismatch".into(),
                ));
            }
            let cursor:u64=tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='operation.executor_stopped' AND json_extract(data,'$.receipt_identity')=?2 AND json_extract(data,'$.receipt_epoch')=?3 ORDER BY cursor LIMIT 1",params![operation.id,receipt.identity,receipt.epoch],|r|read_number(r,0))?;
            if let Some(goal)=&definition.goal_id{goals::clear_dependency(tx,goal,operation_id)?;}
            (cursor,TriggerEvidence::ProcessStopped{receipt_identity:receipt.identity.clone(),receipt_epoch:receipt.epoch.clone()})
        },
        FollowupTrigger::RunCompleted{cursor}=>{if run.state!=RunState::Completed{return Ok(())};(*cursor,TriggerEvidence::RunCompleted{run_revision:run.revision})},
        FollowupTrigger::GoalRequested{cursor}=>{if !run.state.terminal(){return Ok(())};(*cursor,TriggerEvidence::GoalRequested{run_revision:run.revision})},
    };
    let value = FollowupOccurrence {
        id: format!(
            "{}:{}:{}",
            definition.id, definition.generation, trigger_cursor
        ),
        generation: definition.generation,
        trigger_cursor,
        evidence,
        state: OccurrenceState::Observed,
        hold_reason: None,
        receipt: None,
    };
    tx.execute(
        "INSERT INTO followup_occurrences(id,followup_id,run_id,body) VALUES(?1,?2,NULL,?3)",
        params![value.id, definition.id, encode(&value)?],
    )?;
    definition.wait.trigger_cursor = Some(trigger_cursor);
    definition.wait.state = NextRunWaitState::Observed;
    put(tx, "followups", &definition.id, definition)?;
    event(
        tx,
        &definition.id,
        definition.revision,
        "followup.observed",
        json!({"occurrence_id":value.id,"operation_id":definition.operation_id,"trigger_cursor":trigger_cursor}),
    )?;
    Ok(())
}
fn held(
    tx: &Transaction<'_>,
    definition: &Definition,
    value: &mut FollowupOccurrence,
    reason: HoldReason,
) -> Result<()> {
    if value.receipt.is_some()
        || (value.state == OccurrenceState::Held && value.hold_reason == Some(reason))
    {
        return Ok(());
    }
    value.state = OccurrenceState::Held;
    value.hold_reason = Some(reason);
    put(tx, "followup_occurrences", &value.id, value)?;
    event(
        tx,
        &definition.id,
        definition.revision,
        "followup.held",
        json!({"occurrence_id":value.id,"reason":reason}),
    )?;
    Ok(())
}
pub(super) fn normalized_source(
    mut source: Option<launches::SourceSelection>,
    run_id: &str,
) -> Option<launches::SourceSelection> {
    if let Some(source) = source.as_mut() {
        if source.mode == crate::SourceMode::Materialized && source.environment_run_id.is_none() {
            source.environment_run_id = Some(run_id.to_owned());
        }
    }
    source
}
fn branch_source_matches(db: &Connection, definition: &Definition) -> Result<bool> {
    let current: Option<(String, String)> = db.query_row(
        "SELECT r.id,l.body FROM runs r JOIN run_launches l ON l.id=r.id WHERE r.branch_id=?1 ORDER BY r.rowid DESC LIMIT 1",
        [&definition.branch_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((run_id, body)) = current else {
        return Ok(false);
    };
    let launch: launch_content::LaunchMetadata = serde_json::from_str(&body)?;
    Ok(normalized_source(launch.selection.source, &run_id)
        == normalized_source(
            definition.launch.selection.source.clone(),
            &definition.source_run_id,
        ))
}
fn effective_goal(db:&Connection,d:&Definition)->Result<Option<goals::Definition>>{
    if let Some(id)=&d.goal_id{return Ok(Some(record(db,"goals",id)?));}
    Ok(goals::for_run(db,&d.source_run_id)?.filter(|g|!g.ended()))
}
fn eligibility(db: &Connection, definition: &Definition) -> Result<Option<HoldReason>> {
    if definition.state == FollowupState::Paused {
        return Ok(Some(HoldReason::ControlPaused));
    }
    let run: Run = record(db, "runs", &definition.source_run_id)?;
    if !run.state.terminal() {
        return Ok(Some(HoldReason::SourceRunActive));
    }
    if let Some(id)=&definition.operation_id {
        let source:Operation=record(db,"operations",id)?;
        let occupied:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM resource_occupancy WHERE operation_id=?1)",[id],|r|r.get(0))?;
        if source.phase!=OperationPhase::Terminal||occupied||!source.external_receipt.as_ref().is_some_and(|r|r.executor_stopped){return Ok(Some(HoldReason::SourceUnsettled));}
    }
    if let Some(goal)=effective_goal(db,definition)? {
        let id=&goal.id;
        if goal.ended(){return Ok(Some(HoldReason::GoalEnded));}
        if !matches!(definition.trigger,FollowupTrigger::ProcessStopped{..})&&goal.source_run_id!=definition.source_run_id{return Ok(Some(HoldReason::GoalSuperseded));}
        if !matches!(definition.trigger,FollowupTrigger::ProcessStopped{..}){
            let dependency:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM followups WHERE json_extract(body,'$.goal_id')=?1 AND operation_id IS NOT NULL AND json_extract(body,'$.wait.state') IN ('waiting','observed'))",[id],|r|r.get(0))?;
            if dependency{return Ok(Some(HoldReason::SourceUnsettled));}
        }
        if goal.control==goals::GoalControl::Paused{return Ok(Some(HoldReason::GoalPaused));}
        let usage:goals::GoalUsage=record(db,"goal_usage",id)?;
        if goals::budget_limited(&goal,&usage){return Ok(Some(HoldReason::GoalBudget));}
        if goal.blocked.is_some()||goals::usage_unknown(&goal,&usage){return Ok(Some(HoldReason::GoalBlocked));}
        // Handed-off is not finished. Any original unresolved effect, independent job or
        // compaction owned by this Goal must settle before admitting more automatic work.
        let unsettled:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM operations o JOIN goal_runs g ON g.id=o.run_id WHERE g.goal_id=?1 AND (json_extract(o.body,'$.phase')!='terminal' OR json_extract(o.body,'$.effect')='unknown' OR json_extract(o.body,'$.outcome')='indeterminate' OR EXISTS(SELECT 1 FROM resource_occupancy x WHERE x.operation_id=o.id))) OR EXISTS(SELECT 1 FROM context_jobs j JOIN goal_runs g ON g.id=j.owner_run_id JOIN runs r ON r.id=j.run_id WHERE g.goal_id=?1 AND json_extract(r.body,'$.state') NOT IN ('completed','failed','cancelled'))",[id],|r|r.get(0))?;
        if unsettled{return Ok(Some(HoldReason::SourceUnsettled));}
    }
    let active: Option<String> = db.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [&definition.branch_id],
        |r| r.get(0),
    )?;
    let queued: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM input_queue WHERE branch_id=?1 AND state='queued' AND activation='activating')",
        [&definition.branch_id],
        |r| r.get(0),
    )?;
    if active.is_some() || queued {
        return Ok(Some(HoldReason::BranchActive));
    }
    if active_context(db, &definition.branch_id)?.1 != definition.scope
        || !branch_source_matches(db, definition)?
    {
        return Ok(Some(HoldReason::ContextScopeChanged));
    }
    Ok(None)
}
fn cancel_definition(tx: &Transaction<'_>, definition: &mut Definition) -> Result<()> {
    if definition.state == FollowupState::Cancelled
        || definition.wait.state == NextRunWaitState::Consumed
    {
        return Ok(());
    }
    definition.state = FollowupState::Cancelled;
    definition.revision += 1;
    definition.wait.state = NextRunWaitState::Cancelled;
    put(tx, "followups", &definition.id, definition)?;
    if let Some(mut value) = occurrence(tx, &definition.id)? {
        value.state = OccurrenceState::Cancelled;
        value.hold_reason = None;
        put(tx, "followup_occurrences", &value.id, &value)?;
    }
    event(
        tx,
        &definition.id,
        definition.revision,
        "followup.cancelled",
        Value::Null,
    )?;
    Ok(())
}
pub(super) fn cancel_source_run(tx: &Transaction<'_>, run_id: &str) -> Result<()> { cancel_source_registrations(tx, run_id, false) }
pub(super) fn cancel_tree_source_run(tx: &Transaction<'_>, run_id: &str) -> Result<()> { cancel_source_registrations(tx, run_id, true) }
fn cancel_source_registrations(tx: &Transaction<'_>, run_id: &str, include_goal_owned: bool) -> Result<()> {
    let mut query = tx.prepare("SELECT body FROM followups WHERE source_run_id=?1")?;
    let definitions = query
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(query);
    for raw in definitions {
        let mut d:Definition=serde_json::from_str(&raw)?;
        if include_goal_owned || d.goal_id.is_none(){cancel_definition(tx,&mut d)?;}
    }
    Ok(())
}
pub(super) fn settle_run(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    if !run.state.terminal() {
        return Ok(());
    }
    let row: Option<(String, String)> = tx
        .query_row(
            "SELECT followup_id,body FROM followup_occurrences WHERE run_id=?1",
            [&run.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((followup, raw)) = row {
        let mut value: FollowupOccurrence = serde_json::from_str(&raw)?;
        let state = match run.state {
            RunState::Completed => OccurrenceState::Completed,
            RunState::Failed => OccurrenceState::Failed,
            RunState::Cancelled => OccurrenceState::Cancelled,
            _ => unreachable!(),
        };
        if value.state != state {
            value.state = state;
            value.hold_reason = None;
            put(tx, "followup_occurrences", &value.id, &value)?;
            event(
                tx,
                &followup,
                run.revision,
                "followup.settled",
                json!({"run_id":run.id,"occurrence_id":value.id,"state":state}),
            )?;
        }
    }
    Ok(())
}

pub(super) fn register_process_tx(tx:&Transaction<'_>,key:&str,source_run_id:&str,operation_id:&str,goal_id:Option<&str>)->Result<Followup>{
        if let Some(old) = optional_record::<Definition>(tx, "followups", key)? {
            if old.source_run_id != source_run_id || old.operation_id.as_deref() != Some(operation_id) || old.goal_id.as_deref()!=goal_id {
                return Err(RuntimeError::Conflict(
                    "follow-up key has different source".into(),
                ));
            }
            return project(tx, old);
        }
        let run: Run = record(tx, "runs", source_run_id)?;
        if run.cancel_requested || run.state == RunState::Cancelled {
            return Err(RuntimeError::Conflict(
                "cancelled Run cannot authorize follow-up work".into(),
            ));
        }
        context_jobs::require_regular_branch(tx, &run.branch_id)?;
        let delegated: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM child_tasks WHERE child_thread_id=?1)",
            [&run.thread_id],
            |r| r.get(0),
        )?;
        if delegated {
            return Err(RuntimeError::Invalid(
                "delegated Thread cannot acquire independent follow-up authority".into(),
            ));
        }
        let source: Operation = record(tx, "operations", operation_id)?;
        let intent = tool_content::ToolIntent::from_operation(&source)?;
        if source.run_id != run.id
            || source.executor.as_deref() != Some("process_spawn")
            || source.execution_owner != Some(ExecutorOwner::Kernel)
            || intent.call().name != "process_spawn"
            || intent.contract().name != "process_spawn"
            || intent.contract().completion != CompletionKind::Job
            || !matches!(source.lifetime, Lifetime::Thread | Lifetime::Environment)
        {
            return Err(RuntimeError::Conflict(
                "follow-up requires the original admitted process Job of this Run".into(),
            ));
        }
        let accepted = matches!(source.call_completion.as_ref(), Some(result_content::ToolCompletionMetadata::JobAccepted { operation_id, .. }) if operation_id == &source.id);
        if !accepted && source.external_receipt.is_none() {
            return Err(RuntimeError::Conflict(
                "process has no original Job acceptance or executor receipt".into(),
            ));
        }
        let launch: launch_content::LaunchMetadata = record(tx, "run_launches", source_run_id)?;
        if launch.selection.source.is_none() {
            return Err(RuntimeError::Invalid(
                "process follow-up requires its original source selection".into(),
            ));
        }
        let scope:Option<String>=tx.query_row("SELECT c.scope FROM runs r LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id WHERE r.id=?1",[source_run_id],|r|r.get(0))?;
        let after_cursor = tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
            read_number(r, 0)
        })?;
        let mut definition = Definition {
            id: key.into(),
            revision: 1,
            generation: 1,
            thread_id: run.thread_id.clone(),
            branch_id: run.branch_id.clone(),
            source_run_id: run.id.clone(),
            operation_id: Some(source.id.clone()),
            goal_id:goal_id.map(str::to_owned),trigger:FollowupTrigger::ProcessStopped{operation_id:source.id.clone()},
            state: FollowupState::Active,
            wait: NextRunWait {
                id: format!("followup-wait:{key}"),
                kind: "process_stopped".into(),
                after_cursor,
                trigger_cursor: None,
                state: NextRunWaitState::Waiting,
            },
            configuration: run.configuration,
            launch,
            scope: scope.map(|raw| serde_json::from_str(&raw)).transpose()?,
        };
        tx.execute("INSERT INTO followups(id,thread_id,source_run_id,operation_id,body) VALUES(?1,?2,?3,?4,?5)",params![key,definition.thread_id,source_run_id,operation_id,encode(&definition)?])?;
        event(
            tx,
            key,
            1,
            "followup.registered",
            json!({"thread_id":definition.thread_id,"branch_id":definition.branch_id,"source_run_id":source_run_id,"operation_id":operation_id}),
        )?;
        observe(tx, &mut definition)?;
        let result = project(tx, definition)?;
        Ok(result)
}

pub(super) fn register_goal_continuation(tx:&Transaction<'_>,goal:&goals::Definition,run:&Run,requested:Option<u64>)->Result<()> {
    let cursor=match requested{Some(c)=>c,None=>tx.query_row("SELECT max(cursor) FROM events WHERE subject=?1 AND (kind='run.changed' OR kind='execution.committed')",[&run.id],|r|read_number(r,0))?};
    let key=match requested{Some(c)=>format!("goal:{}:requested:{c}",goal.id),None=>format!("goal:{}:completed:{}",goal.id,run.id)};
    if optional_record::<Definition>(tx,"followups",&key)?.is_some(){return Ok(())}
    let mut q=tx.prepare("SELECT body FROM followups WHERE json_extract(body,'$.goal_id')=?1 AND operation_id IS NULL AND json_extract(body,'$.wait.state') IN ('waiting','observed')")?;
    let old=q.query_map([&goal.id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;drop(q);
    for raw in old{cancel_definition(tx,&mut serde_json::from_str(&raw)?)?;}
    let launch:launch_content::LaunchMetadata=record(tx,"run_launches",&run.id)?;
    let scope:Option<String>=tx.query_row("SELECT c.scope FROM runs r LEFT JOIN context_checkpoints c ON c.id=r.context_checkpoint_id WHERE r.id=?1",[&run.id],|r|r.get(0))?;
    let trigger=if requested.is_some(){FollowupTrigger::GoalRequested{cursor}}else{FollowupTrigger::RunCompleted{cursor}};
    let mut d=Definition{id:key.clone(),revision:1,generation:1,thread_id:run.thread_id.clone(),branch_id:run.branch_id.clone(),source_run_id:run.id.clone(),operation_id:None,goal_id:Some(goal.id.clone()),trigger,state:FollowupState::Active,
        wait:NextRunWait{id:format!("followup-wait:{key}"),kind:if requested.is_some(){"goal_requested"}else{"run_completed"}.into(),after_cursor:cursor,trigger_cursor:None,state:NextRunWaitState::Waiting},configuration:run.configuration.clone(),launch,scope:scope.map(|r|serde_json::from_str(&r)).transpose()?};
    tx.execute("INSERT INTO followups(id,thread_id,source_run_id,operation_id,body) VALUES(?1,?2,?3,NULL,?4)",params![key,run.thread_id,run.id,encode(&d)?])?;
    event(tx,&key,1,"followup.registered",json!({"goal_id":goal.id,"source_run_id":run.id}))?;
    observe(tx,&mut d)
}

impl Catalog {
    pub fn register_followup(
        &mut self,
        key: &str,
        source_run_id: &str,
        operation_id: &str,
    ) -> Result<Followup> {
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict("Catalog owner is stopping".into()));
        }
        if key.trim().is_empty() {
            return Err(RuntimeError::Invalid("follow-up key is required".into()));
        }
        let tx=self.db.transaction()?;
        let goal=goals::for_run(&tx,source_run_id)?.filter(|g|!g.ended());
        let result=register_process_tx(&tx,key,source_run_id,operation_id,goal.as_ref().map(|g|g.id.as_str()))?;
        tx.commit()?;Ok(result)
    }
    pub fn followup(&self, id: &str) -> Result<Followup> {
        project(&self.db, record(&self.db, "followups", id)?)
    }
    pub fn followups(&self, thread_id: &str) -> Result<Vec<Followup>> {
        let mut query = self
            .db
            .prepare("SELECT body FROM followups WHERE thread_id=?1 ORDER BY rowid")?;
        let result = query
            .query_map([thread_id], |r| r.get::<_, String>(0))?
            .map(|raw| project(&self.db, serde_json::from_str(&raw?)?))
            .collect();
        result
    }
    pub fn control_followup(
        &mut self,
        id: &str,
        revision: u64,
        action: FollowupControlAction,
    ) -> Result<Followup> {
        let tx = self.db.transaction()?;
        let mut definition: Definition = record(&tx, "followups", id)?;
        if definition.goal_id.is_some(){return Err(RuntimeError::Conflict("Goal-owned continuation is controlled through its Goal".into()));}
        if definition.wait.state == NextRunWaitState::Consumed
            || definition.state == FollowupState::Cancelled
        {
            return project(&tx, definition);
        }
        if definition.revision != revision {
            return Err(RuntimeError::Conflict("follow-up revision changed".into()));
        }
        match action {
            FollowupControlAction::Cancel => cancel_definition(&tx, &mut definition)?,
            _ => {
                let state = if action == FollowupControlAction::Pause {
                    FollowupState::Paused
                } else {
                    FollowupState::Active
                };
                let retry = action == FollowupControlAction::Resume
                    && occurrence(&tx, id)?.is_some_and(|value| {
                        value.hold_reason == Some(HoldReason::PreparationFailed)
                    });
                if definition.state != state || retry {
                    definition.state = state;
                    definition.revision += 1;
                    put(&tx, "followups", id, &definition)?;
                    event(
                        &tx,
                        id,
                        definition.revision,
                        "followup.changed",
                        json!({"state":state}),
                    )?;
                }
            }
        }
        let result = project(&tx, definition)?;
        tx.commit()?;
        Ok(result)
    }
}

pub struct ContinuationPreparation {
    definition: Definition,
    occurrence: FollowupOccurrence,
    source: Option<Operation>,
    goal:Option<goals::FrozenGoal>,
    head: Option<String>,
    checkpoint: Option<String>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
    stopping: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
pub struct PreparedContinuation {
    preparation: ContinuationPreparation,
    history: Value,
    intent: Value,
}
#[derive(Debug, Clone, PartialEq)]
pub enum ContinuationAdmission {
    Admitted(Receipt),
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
        if self.stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "continuation owner is stopping".into(),
            ));
        }
        let fact=if let Some(source)=&self.source {
            let receipt=source.external_receipt.as_ref().ok_or_else(||RuntimeError::Invalid("original process receipt missing".into()))?;
            let result=self.content.load(&receipt.result_ref)?;
            let tools:Vec<crate::execution::ToolSchema>=serde_json::from_value(self.content.load(&self.definition.launch.selection.tools_ref)?)?;
            let reader=tools.iter().any(|t|t.name=="process_read").then(||json!({"name":"process_read","arguments":{"processId":source.id,"cursor":0}}));
            json!({"processId":source.id,"receiptIdentity":receipt.identity,"receiptEpoch":receipt.epoch,"executorStopped":receipt.executor_stopped,"outcome":receipt.outcome,"effect":receipt.effect,"result":result,"outputReader":reader})
        }else{json!({"trigger":self.definition.trigger,"evidence":self.occurrence.evidence})};
        let fact=json!({"followupId":self.definition.id,"occurrenceId":self.occurrence.id,"sourceRunId":self.definition.source_run_id,"goal":self.goal,"fact":fact});
        let item=ConversationItem {resource_activation: None,id:format!("continuation-input:{}",self.occurrence.id),provenance:Provenance::EnvironmentFact{event_id:format!("followup:{}",self.occurrence.id)},
            content:Content::Text{text:format!("The retained explicit user authorization permits this occurrence of continuing the existing Thread work. Its actual trigger and evidence are recorded below. The original instructions remain in the conversation. This is execution data, not a new user instruction or permission. Preserve failed, cancelled or uncertain outcomes. Process output remains with its original owner; outputReader is available only under the retained read capability and current authorization.\n{}",serde_json::to_string(&fact)?)},opaque:None};
        if self.stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "continuation owner is stopping".into(),
            ));
        }
        let history = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        let intent=self.content.save(&json!({"kind":"followup","followup_id":self.definition.id,"generation":self.definition.generation,"occurrence_id":self.occurrence.id,"trigger_cursor":self.occurrence.trigger_cursor,"source_run_id":self.definition.source_run_id,"operation_id":self.definition.operation_id,"goal":self.goal}))?;
        Ok(PreparedContinuation {
            preparation: self,
            history,
            intent,
        })
    }
}
impl Catalog {
    pub fn stop_followup_admission(&self) {
        self.continuation_stopping.store(true, Ordering::Release);
    }
    pub fn capture_followup_continuations(&mut self) -> Result<Vec<ContinuationPreparation>> {
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Ok(Vec::new());
        }
        let tx = self.db.transaction()?;
        let mut ready = Vec::new();
        let raws = {
            let mut query=tx.prepare("SELECT f.body FROM followups f WHERE json_extract(f.body,'$.wait.state') IN ('waiting','observed')
                UNION ALL SELECT f.body FROM followup_occurrences o JOIN followups f ON f.id=o.followup_id JOIN runs r ON r.id=o.run_id WHERE json_extract(o.body,'$.state')='admitted' AND json_extract(r.body,'$.state') IN ('completed','failed','cancelled')")?;
            let values = query
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            values
        };
        for raw in raws {
            let mut definition: Definition = serde_json::from_str(&raw)?;
            if definition.wait.state == NextRunWaitState::Consumed {
                if let Some(value) = occurrence(&tx, &definition.id)? {
                    if let Some(receipt) = value.receipt {
                        settle_run(&tx, &record(&tx, "runs", &receipt.run_id)?)?;
                    }
                }
                continue;
            }
            let source_run: Run = record(&tx, "runs", &definition.source_run_id)?;
            if definition.goal_id.is_none() && (source_run.cancel_requested || source_run.state == RunState::Cancelled) {
                cancel_definition(&tx, &mut definition)?;
                continue;
            }
            observe(&tx, &mut definition)?;
            let Some(mut value) = occurrence(&tx, &definition.id)? else {
                continue;
            };
            if let Some(reason) = eligibility(&tx, &definition)? {
                held(&tx, &definition, &mut value, reason)?;
                continue;
            }
            let head = tx.query_row(
                "SELECT head FROM branches WHERE id=?1",
                [&definition.branch_id],
                |r| r.get(0),
            )?;
            let checkpoint = active_context(&tx, &definition.branch_id)?.0;
            let source = definition.operation_id.as_ref().map(|id|record(&tx,"operations",id)).transpose()?;
            let goal=effective_goal(&tx,&definition)?.map(|d|d.binding());
            ready.push(ContinuationPreparation {
                definition,
                occurrence: value,
                source,
                goal,
                head,
                checkpoint,
                epoch: self.epoch,
                content: self.content.clone(),
                publication: self.content.begin_publication(),
                stopping: self.continuation_stopping.clone(),
            });
        }
        tx.commit()?;
        Ok(ready)
    }
    pub fn fail_followup_preparation(&mut self, id: &str, revision: u64) -> Result<()> {
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Ok(());
        }
        let tx = self.db.transaction()?;
        let definition: Definition = record(&tx, "followups", id)?;
        if definition.revision == revision
            && definition.state == FollowupState::Active
            && definition.wait.state == NextRunWaitState::Observed
        {
            if let Some(mut value) = occurrence(&tx, id)? {
                held(&tx, &definition, &mut value, HoldReason::PreparationFailed)?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn admit_followup_continuation(
        &mut self,
        prepared: PreparedContinuation,
    ) -> Result<ContinuationAdmission> {
        let PreparedContinuation {
            preparation,
            history,
            intent,
        } = prepared;
        let ContinuationPreparation {
            definition,
            occurrence: value,
            source,
            goal,
            head,
            checkpoint,
            epoch,
            publication: _publication,
            ..
        } = preparation;
        if epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "continuation preparation owner changed or stopped".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let current: Definition = record(&tx, "followups", &definition.id)?;
        let mut actual = occurrence(&tx, &definition.id)?
            .ok_or_else(|| RuntimeError::Invalid("follow-up occurrence disappeared".into()))?;
        if let Some(receipt) = actual.receipt {
            return Ok(ContinuationAdmission::Admitted(receipt));
        }
        if current != definition
            || actual != value
            || source.as_ref().map(|s|record::<Operation>(&tx,"operations",&s.id).map(|a|a!=*s)).transpose()?.unwrap_or(false)
            || effective_goal(&tx,&current)?.map(|d|d.binding()) != goal
        {
            return Ok(ContinuationAdmission::Stale);
        }
        if current.state == FollowupState::Cancelled {
            return Ok(ContinuationAdmission::Held);
        }
        if let Some(reason) = eligibility(&tx, &current)? {
            held(&tx, &current, &mut actual, reason)?;
            tx.commit()?;
            return Ok(ContinuationAdmission::Held);
        }
        let current_head: Option<String> = tx.query_row(
            "SELECT head FROM branches WHERE id=?1",
            [&definition.branch_id],
            |r| r.get(0),
        )?;
        if current_head != head || active_context(&tx, &definition.branch_id)?.0 != checkpoint {
            return Ok(ContinuationAdmission::Stale);
        }
        let mut selection = definition.launch.selection.clone();
        if let Some(source) = selection.source.as_mut() {
            if source.mode == crate::SourceMode::Materialized && source.environment_run_id.is_none()
            {
                source.environment_run_id = Some(definition.source_run_id.clone());
            }
        }
        let submission = submissions::PreparedSubmission {
            run_id: id(),
            identity: submissions::SubmissionIdentity {
                key: format!("followup-command:{}", value.id),
                thread_id: definition.thread_id.clone(),
                branch_id: definition.branch_id.clone(),
                expected_head: head,
                configuration: definition.configuration.clone(),
            },
            epoch,
            intent,
            history,
            launch: Some(selection),
            inherit_source: false,
            initial: None,
            origin: submissions::SubmissionOrigin::Continuation {
                occurrence_id: value.id.clone(),
                checkpoint,
            },
            _publication,
        };
        let receipt = Self::submit_admission_tx(&tx, self.epoch, &submission, None)?;
        // This new Run starts the retained implementation with a new binding generation, not the
        // old Run's policy state or authorization generation.
        let mut launch: launch_content::LaunchMetadata =
            record(&tx, "run_launches", &receipt.run_id)?;
        launch.policy_target = definition.launch.policy_target.clone();
        launch.policy_generation = 0;
        put(&tx, "run_launches", &receipt.run_id, &launch)?;
        let mut definition = current;
        definition.wait.state = NextRunWaitState::Consumed;
        put(&tx, "followups", &definition.id, &definition)?;
        actual.state = OccurrenceState::Admitted;
        actual.hold_reason = None;
        actual.receipt = Some(receipt.clone());
        tx.execute(
            "UPDATE followup_occurrences SET run_id=?2,body=?3 WHERE id=?1",
            params![actual.id, receipt.run_id, encode(&actual)?],
        )?;
        event(
            &tx,
            &definition.id,
            definition.revision,
            "followup.admitted",
            json!({"run_id":receipt.run_id,"followup_id":definition.id,"occurrence_id":actual.id,"source_run_id":definition.source_run_id,"operation_id":definition.operation_id}),
        )?;
        tx.commit()?;
        Ok(ContinuationAdmission::Admitted(receipt))
    }
    /// Exact authority for the original process's read-only observer. No other process in the
    /// source Run, thread family or current environment is delegated by this relationship.
    pub fn followup_process_source(
        &self,
        run_id: &str,
        operation_id: &str,
    ) -> Result<Option<String>> {
        let raw:Option<String>=self.db.query_row("SELECT f.body FROM followup_occurrences o JOIN followups f ON f.id=o.followup_id WHERE o.run_id=?1 AND f.operation_id=?2",params![run_id,operation_id],|r|r.get(0)).optional()?;
        raw.map(|raw| {
            let definition: Definition = serde_json::from_str(&raw)?;
            let run = self.run(run_id)?;
            if run.thread_id != definition.thread_id || run.branch_id != definition.branch_id {
                return Err(RuntimeError::Conflict(
                    "follow-up process target changed".into(),
                ));
            }
            let launch = self
                .launch_metadata(run_id)?
                .ok_or_else(|| RuntimeError::Conflict("follow-up launch missing".into()))?;
            if normalized_source(launch.selection.source, run_id)
                != normalized_source(
                    definition.launch.selection.source.clone(),
                    &definition.source_run_id,
                )
            {
                return Err(RuntimeError::Conflict(
                    "follow-up process source changed".into(),
                ));
            }
            Ok(definition.source_run_id)
        })
        .transpose()
    }
}
/// A pass is driven by a real committed event or startup. A stale candidate recaptures in this
/// pass so the last concurrent boundary cannot be lost. Held work never polls or emits repeats.
pub fn reconcile(catalog: &Mutex<Catalog>) -> Result<Vec<String>> {
    let mut admitted = Vec::new();
    loop {
        let candidates = catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
            .capture_followup_continuations()?;
        let mut stale = false;
        for candidate in candidates {
            let id = candidate.id().to_owned();
            let revision = candidate.revision();
            let prepared = match candidate.load() {
                Ok(value) => value,
                Err(_error) => {
                    catalog
                        .lock()
                        .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
                        .fail_followup_preparation(&id, revision)?;
                    continue;
                }
            };
            match catalog
                .lock()
                .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
                .admit_followup_continuation(prepared)?
            {
                ContinuationAdmission::Admitted(receipt) => admitted.push(receipt.run_id),
                ContinuationAdmission::Stale => stale = true,
                ContinuationAdmission::Held => (),
            }
        }
        if !stale {
            return Ok(admitted);
        }
    }
}
