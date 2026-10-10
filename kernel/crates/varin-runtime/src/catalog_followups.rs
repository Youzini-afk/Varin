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
    pub receipt_identity: String,
    pub receipt_epoch: String,
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
    pub operation_id: String,
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
    operation_id: String,
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
            state: self.state,
            wait: self.wait,
            occurrence,
        }
    }
}

pub(super) fn initialize_new(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE followups(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),source_run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT NOT NULL REFERENCES operations(id),body TEXT NOT NULL);
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
    let operation: Operation = record(tx, "operations", &definition.operation_id)?;
    let Some(receipt) = operation
        .external_receipt
        .as_ref()
        .filter(|receipt| receipt.executor_stopped)
    else {
        return Ok(());
    };
    if receipt.identity != operation.id || receipt.executor != "process_spawn" {
        return Err(RuntimeError::Invalid(
            "process stop receipt owner mismatch".into(),
        ));
    }
    let trigger_cursor: u64 = tx.query_row(
        "SELECT cursor FROM events WHERE subject=?1 AND kind='operation.executor_stopped' AND json_extract(data,'$.receipt_identity')=?2 AND json_extract(data,'$.receipt_epoch')=?3 ORDER BY cursor LIMIT 1",
        params![operation.id,receipt.identity,receipt.epoch], |r|read_number(r,0))?;
    let value = FollowupOccurrence {
        id: format!(
            "{}:{}:{}",
            definition.id, definition.generation, trigger_cursor
        ),
        generation: definition.generation,
        trigger_cursor,
        receipt_identity: receipt.identity.clone(),
        receipt_epoch: receipt.epoch.clone(),
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
        json!({"occurrence_id":value.id,"operation_id":operation.id,"trigger_cursor":trigger_cursor}),
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
fn eligibility(db: &Connection, definition: &Definition) -> Result<Option<HoldReason>> {
    if definition.state == FollowupState::Paused {
        return Ok(Some(HoldReason::ControlPaused));
    }
    let run: Run = record(db, "runs", &definition.source_run_id)?;
    if !run.state.terminal() {
        return Ok(Some(HoldReason::SourceRunActive));
    }
    let source: Operation = record(db, "operations", &definition.operation_id)?;
    let occupied: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM resource_occupancy WHERE operation_id=?1)",
        [&source.id],
        |r| r.get(0),
    )?;
    if source.phase != OperationPhase::Terminal
        || occupied
        || !source
            .external_receipt
            .as_ref()
            .is_some_and(|r| r.executor_stopped)
    {
        return Ok(Some(HoldReason::SourceUnsettled));
    }
    let active: Option<String> = db.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [&definition.branch_id],
        |r| r.get(0),
    )?;
    let queued: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM input_queue WHERE branch_id=?1 AND state='queued')",
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
pub(super) fn cancel_source_run(tx: &Transaction<'_>, run_id: &str) -> Result<()> {
    let mut query = tx.prepare("SELECT body FROM followups WHERE source_run_id=?1")?;
    let definitions = query
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(query);
    for raw in definitions {
        cancel_definition(tx, &mut serde_json::from_str(&raw)?)?;
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
        let tx = self.db.transaction()?;
        if let Some(old) = optional_record::<Definition>(&tx, "followups", key)? {
            if old.source_run_id != source_run_id || old.operation_id != operation_id {
                return Err(RuntimeError::Conflict(
                    "follow-up key has different source".into(),
                ));
            }
            return project(&tx, old);
        }
        let run: Run = record(&tx, "runs", source_run_id)?;
        if run.cancel_requested || run.state == RunState::Cancelled {
            return Err(RuntimeError::Conflict(
                "cancelled Run cannot authorize follow-up work".into(),
            ));
        }
        context_jobs::require_regular_branch(&tx, &run.branch_id)?;
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
        let source: Operation = record(&tx, "operations", operation_id)?;
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
        let launch: launch_content::LaunchMetadata = record(&tx, "run_launches", source_run_id)?;
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
            operation_id: source.id.clone(),
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
            &tx,
            key,
            1,
            "followup.registered",
            json!({"thread_id":definition.thread_id,"branch_id":definition.branch_id,"source_run_id":source_run_id,"operation_id":operation_id}),
        )?;
        observe(&tx, &mut definition)?;
        let result = project(&tx, definition)?;
        tx.commit()?;
        Ok(result)
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
    source: Operation,
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
        let receipt = self
            .source
            .external_receipt
            .as_ref()
            .ok_or_else(|| RuntimeError::Invalid("original process receipt missing".into()))?;
        let result = self.content.load(&receipt.result_ref)?;
        let tools: Vec<crate::execution::ToolSchema> = serde_json::from_value(
            self.content
                .load(&self.definition.launch.selection.tools_ref)?,
        )?;
        let reader = tools.iter().any(|tool| tool.name == "process_read").then(
            || json!({"name":"process_read","arguments":{"processId":self.source.id,"cursor":0}}),
        );
        let fact = json!({"followupId":self.definition.id,"occurrenceId":self.occurrence.id,"sourceRunId":self.definition.source_run_id,"processId":self.source.id,
            "receiptIdentity":receipt.identity,"receiptEpoch":receipt.epoch,"executorStopped":receipt.executor_stopped,"outcome":receipt.outcome,"effect":receipt.effect,"result":result,"outputReader":reader});
        let item=ConversationItem {id:format!("continuation-input:{}",self.occurrence.id),provenance:Provenance::EnvironmentFact{event_id:format!("followup:{}",self.occurrence.id)},
            content:Content::Text{text:format!("A previously registered one-time user authorization permits continuing the existing Thread work after this original process stopped. The original instructions remain in the conversation. This is execution data, not a new user instruction or permission. Preserve failed, cancelled or uncertain outcomes. Process output remains with its original owner; outputReader is available only under the retained read capability and current authorization.\n{}",serde_json::to_string(&fact)?)},opaque:None};
        if self.stopping.load(Ordering::Acquire) {
            return Err(RuntimeError::Conflict(
                "continuation owner is stopping".into(),
            ));
        }
        let history = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        let intent=self.content.save(&json!({"kind":"process_followup","followup_id":self.definition.id,"generation":self.definition.generation,"occurrence_id":self.occurrence.id,"trigger_cursor":self.occurrence.trigger_cursor,"source_run_id":self.definition.source_run_id,"operation_id":self.source.id}))?;
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
            if source_run.cancel_requested || source_run.state == RunState::Cancelled {
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
            let source = record(&tx, "operations", &definition.operation_id)?;
            ready.push(ContinuationPreparation {
                definition,
                occurrence: value,
                source,
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
            || record::<Operation>(&tx, "operations", &source.id)? != source
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
