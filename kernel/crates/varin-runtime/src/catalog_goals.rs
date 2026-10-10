//! Explicit continuing work. Goal controls and attribution live beside their original Runs,
//! inference receipts and occurrence admissions; neither usage nor execution has a second owner.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance, UsageMeasurement, UsageReceipt};
use serde::Deserialize;

pub const REPORT_TOOL: &str = "goal_report";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrozenGoal {
    pub id: String,
    pub generation: u64,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalState {
    Active,
    Paused,
    Blocked,
    BudgetLimited,
    Complete,
    Cancelled,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalControlAction {
    Pause,
    Resume,
    Complete,
    Cancel,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalControl {
    Active,
    Paused,
    Complete,
    Cancelled,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct GoalBudget {
    pub max_output_tokens: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GoalScope {
    pub thread_id: String,
    pub branch_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GoalControlReceipt {
    pub id: String,
    pub revision: u64,
    pub generation: u64,
    pub thread_id: String,
    pub branch_id: String,
    pub control: GoalControl,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TokenAmount {
    pub known: u64,
    pub unknown_receipts: u64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GoalMeasuredUsage {
    pub inferences: u64,
    pub input_tokens: TokenAmount,
    pub output_tokens: TokenAmount,
    pub cached_input_tokens: TokenAmount,
    pub cache_write_tokens: TokenAmount,
    pub reasoning_tokens: TokenAmount,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GoalUsage {
    pub actual: GoalMeasuredUsage,
    pub estimated: GoalMeasuredUsage,
    pub missing_inferences: u64,
    pub pending_inferences: u64,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalBlockReason {
    Reported,
    Dependency,
    RunFailed,
    Waiting,
    Unsettled,
    ContextChanged,
    PreparationFailed,
    UsageUnknown,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Goal {
    pub id: String,
    pub revision: u64,
    pub generation: u64,
    pub thread_id: String,
    pub branch_id: String,
    pub source_run_id: String,
    pub objective: String,
    pub control: GoalControl,
    pub state: GoalState,
    pub budget: Option<GoalBudget>,
    pub usage: GoalUsage,
    pub blocked_reason: Option<GoalBlockReason>,
    pub reason: Option<String>,
    pub dependency_operation_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Definition {
    pub id: String,
    pub revision: u64,
    pub generation: u64,
    pub thread_id: String,
    pub branch_id: String,
    pub source_run_id: String,
    pub objective_ref: Value,
    pub control: GoalControl,
    pub budget: Option<GoalBudget>,
    pub blocked: Option<GoalBlockReason>,
    pub reason_ref: Option<Value>,
    pub dependency_operation_id: Option<String>,
    pub start_intent: Value,
}
impl Definition {
    fn receipt(&self) -> GoalControlReceipt {
        GoalControlReceipt {
            id: self.id.clone(),
            revision: self.revision,
            generation: self.generation,
            thread_id: self.thread_id.clone(),
            branch_id: self.branch_id.clone(),
            control: self.control,
        }
    }
    fn require_scope(&self, scope: &GoalScope) -> Result<()> {
        if self.thread_id != scope.thread_id || self.branch_id != scope.branch_id {
            Err(RuntimeError::Conflict(
                "Goal belongs to a different Thread or branch".into(),
            ))
        } else {
            Ok(())
        }
    }
    pub(super) fn binding(&self) -> FrozenGoal {
        FrozenGoal {
            id: self.id.clone(),
            generation: self.generation,
        }
    }
    pub(super) fn ended(&self) -> bool {
        matches!(self.control, GoalControl::Complete | GoalControl::Cancelled)
    }
}
pub struct GoalRead {
    definition: Definition,
    usage: GoalUsage,
    blocked: Option<GoalBlockReason>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl GoalRead {
    pub fn load(self) -> Result<Goal> {
        let d = self.definition;
        let blocked = if usage_unknown(&d, &self.usage) {
            Some(GoalBlockReason::UsageUnknown)
        } else {
            self.blocked
        };
        let state = effective_state(&d, &self.usage, blocked);
        Ok(Goal {
            objective: serde_json::from_value(self.content.load(&d.objective_ref)?)?,
            reason: d
                .reason_ref
                .as_ref()
                .map(|r| {
                    self.content
                        .load(r)
                        .and_then(|v| Ok(serde_json::from_value(v)?))
                })
                .transpose()?,
            id: d.id,
            revision: d.revision,
            generation: d.generation,
            thread_id: d.thread_id,
            branch_id: d.branch_id,
            source_run_id: d.source_run_id,
            control: d.control,
            state,
            budget: d.budget,
            usage: self.usage,
            blocked_reason: blocked,
            dependency_operation_id: d.dependency_operation_id,
        })
    }
}
pub(super) fn initialize_new(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("CREATE TABLE goals(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),branch_id TEXT NOT NULL REFERENCES branches(id),body TEXT NOT NULL);
        CREATE INDEX goals_thread ON goals(thread_id); CREATE INDEX goals_branch ON goals(branch_id);
        CREATE TABLE goal_runs(id TEXT PRIMARY KEY REFERENCES runs(id),goal_id TEXT NOT NULL REFERENCES goals(id),primary_run INTEGER NOT NULL);
        CREATE INDEX goal_runs_goal ON goal_runs(goal_id);
        CREATE TABLE goal_children(id TEXT PRIMARY KEY REFERENCES child_tasks(id),goal_id TEXT NOT NULL REFERENCES goals(id));
        CREATE TABLE goal_usage(id TEXT PRIMARY KEY REFERENCES goals(id),body TEXT NOT NULL);")?;
    Ok(())
}
pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT id,thread_id,branch_id,body FROM goals")?;
    db.prepare("SELECT id,goal_id,primary_run FROM goal_runs")?;
    db.prepare("SELECT id,goal_id FROM goal_children")?;
    db.prepare("SELECT id,body FROM goal_usage")?;
    Ok(())
}
fn effective_state(d: &Definition, u: &GoalUsage, blocked: Option<GoalBlockReason>) -> GoalState {
    match d.control {
        GoalControl::Complete => GoalState::Complete,
        GoalControl::Cancelled => GoalState::Cancelled,
        GoalControl::Paused => GoalState::Paused,
        GoalControl::Active if budget_limited(d, u) => GoalState::BudgetLimited,
        GoalControl::Active if blocked.is_some() => GoalState::Blocked,
        GoalControl::Active => GoalState::Active,
    }
}
pub(super) fn budget_limited(d: &Definition, u: &GoalUsage) -> bool {
    d.budget
        .as_ref()
        .is_some_and(|b| u.actual.output_tokens.known >= b.max_output_tokens)
}
pub(super) fn usage_unknown(d: &Definition, u: &GoalUsage) -> bool {
    d.budget.is_some()
        && (u.missing_inferences > 0
            || u.estimated.inferences > 0
            || u.actual.output_tokens.unknown_receipts > 0)
}
pub(super) fn active_for_branch(db: &Connection, branch: &str) -> Result<Option<Definition>> {
    let raw:Option<String>=db.query_row("SELECT body FROM goals WHERE branch_id=?1 AND json_extract(body,'$.control') NOT IN ('complete','cancelled') ORDER BY rowid DESC LIMIT 1",[branch],|r|r.get(0)).optional()?;
    raw.map(|r| Ok(serde_json::from_str(&r)?)).transpose()
}
/// Follow actual parent ownership, not branch ancestry, user text or workspace identity.
pub(super) fn for_run(db: &Connection, run_id: &str) -> Result<Option<Definition>> {
    let mut current = run_id.to_owned();
    let mut seen = std::collections::BTreeSet::new();
    loop {
        if !seen.insert(current.clone()) {
            return Err(RuntimeError::Invalid(
                "cyclic Goal inference lineage".into(),
            ));
        }
        let goal: Option<String> = db
            .query_row(
                "SELECT goal_id FROM goal_runs WHERE id=?1",
                [&current],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(goal) = goal {
            return Ok(Some(record(db, "goals", &goal)?));
        }
        // A UserContinuation with no admitted Goal mapping explicitly crossed an
        // ended Goal boundary. Do not infer the old Goal again from stable family ties.
        if continuation_predecessor(db, &current)?.is_some() { return Ok(None); }
        if let Some(parent) = context_jobs::context_job_parent(db, &current)? {
            current = parent;
            continue;
        }
        let run: Run = record(db, "runs", &current)?;
        let delegated_goal:Option<String>=db.query_row("SELECT g.goal_id FROM goal_children g JOIN child_tasks c ON c.id=g.id WHERE c.child_thread_id=?1 AND json_extract(c.body,'$.child_branch_id')=?2",params![run.thread_id,run.branch_id],|r|r.get(0)).optional()?;
        if let Some(goal) = delegated_goal {
            return Ok(Some(record(db, "goals", &goal)?));
        }
        let parent:Option<String>=db.query_row("SELECT json_extract(body,'$.parent_run_id') FROM child_tasks WHERE child_thread_id=?1 AND json_extract(body,'$.child_branch_id')=?2",params![run.thread_id,run.branch_id],|r|r.get(0)).optional()?;
        match parent {
            Some(parent) => current = parent,
            None => return Ok(None),
        }
    }
}
fn continuation_predecessor(db: &Connection, run_id: &str) -> Result<Option<String>> {
    Ok(db.query_row("SELECT json_extract(body,'$.trigger.previous_run_id') FROM delegated_executions WHERE run_id=?1 AND json_extract(body,'$.trigger.kind') IN ('user_continuation','message_request')",[run_id],|row|row.get(0)).optional()?)
}
pub(super) fn bind_admission(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    if let Some(previous) = continuation_predecessor(tx, &run.id)? {
        if let Some(goal) = for_run(tx, &previous)?.filter(|goal| !goal.ended()) {
            tx.execute("INSERT INTO goal_runs(id,goal_id,primary_run) VALUES(?1,?2,0)", params![run.id,goal.id])?;
        }
        return Ok(());
    }
    let parent: Option<String> = tx
        .query_row(
            "SELECT json_extract(body,'$.parent_run_id') FROM child_tasks WHERE child_thread_id=?1 AND json_extract(body,'$.child_branch_id')=?2",
            params![run.thread_id,run.branch_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(parent) = parent {
        let frozen:Option<String>=tx.query_row("SELECT g.goal_id FROM goal_children g JOIN child_tasks c ON c.id=g.id WHERE c.child_thread_id=?1 AND json_extract(c.body,'$.child_branch_id')=?2",params![run.thread_id,run.branch_id],|r|r.get(0)).optional()?;
        if let Some(goal) = frozen {
            tx.execute("INSERT INTO goal_runs(id,goal_id,primary_run) VALUES(?1,?2,0) ON CONFLICT(id) DO NOTHING",params![run.id,goal])?;
            return Ok(());
        }
        return bind_inherited(tx, &run.id, &parent);
    }
    if let Some(mut goal) = active_for_branch(tx, &run.branch_id)? {
        tx.execute("INSERT INTO goal_runs(id,goal_id,primary_run) VALUES(?1,?2,1) ON CONFLICT(id) DO NOTHING",params![run.id,goal.id])?;
        goal.source_run_id = run.id.clone();
        put(tx, "goals", &goal.id, &goal)?;
    }
    Ok(())
}
pub(super) fn bind_inherited(tx: &Transaction<'_>, run: &str, parent: &str) -> Result<()> {
    if let Some(goal) = for_run(tx, parent)? {
        tx.execute("INSERT INTO goal_runs(id,goal_id,primary_run) VALUES(?1,?2,0) ON CONFLICT(id) DO NOTHING",params![run,goal.id])?;
    }
    Ok(())
}
pub(super) fn bind_child(tx: &Transaction<'_>, operation: &str, parent: &str) -> Result<()> {
    if let Some(goal) = for_run(tx, parent)? {
        tx.execute(
            "INSERT INTO goal_children(id,goal_id) VALUES(?1,?2) ON CONFLICT(id) DO NOTHING",
            params![operation, goal.id],
        )?;
    }
    Ok(())
}
fn adopt_descendants(tx: &Transaction<'_>, run: &str, goal: &str) -> Result<()> {
    tx.execute("WITH RECURSIVE descendants(id) AS (SELECT ?1 UNION SELECT j.run_id FROM context_jobs j JOIN descendants d ON j.owner_run_id=d.id UNION SELECT r.id FROM child_tasks c JOIN descendants d ON json_extract(c.body,'$.parent_run_id')=d.id JOIN runs r ON r.branch_id=json_extract(c.body,'$.child_branch_id') WHERE NOT EXISTS(SELECT 1 FROM delegated_executions e WHERE e.run_id=r.id AND json_extract(e.body,'$.trigger.kind') IN ('user_continuation','message_request'))) INSERT INTO goal_runs(id,goal_id,primary_run) SELECT id,?2,0 FROM descendants WHERE id!=?1 ON CONFLICT(id) DO NOTHING",params![run,goal])?;
    tx.execute("INSERT INTO goal_children(id,goal_id) SELECT c.id,?1 FROM child_tasks c JOIN goal_runs g ON json_extract(c.body,'$.parent_run_id')=g.id WHERE g.goal_id=?1 ON CONFLICT(id) DO NOTHING",[goal])?;
    Ok(())
}
pub(super) fn detach_ended_for_input(tx: &Transaction<'_>, run: &str) -> Result<()> {
    tx.execute("DELETE FROM goal_runs WHERE id=?1 AND primary_run=1 AND goal_id IN (SELECT id FROM goals WHERE json_extract(body,'$.control') IN ('complete','cancelled'))",[run])?;
    Ok(())
}
fn is_primary(db: &Connection, run: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM goal_runs WHERE id=?1 AND primary_run=1)",
        [run],
        |r| r.get(0),
    )?)
}
fn projection_block(db: &Connection, d: &Definition) -> Result<Option<GoalBlockReason>> {
    if d.blocked.is_some() {
        return Ok(d.blocked);
    }
    let waiting:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM runs r JOIN goal_runs g ON g.id=r.id WHERE g.goal_id=?1 AND g.primary_run=1 AND json_extract(r.body,'$.state')='waiting' AND json_extract(r.body,'$.waiting_on') NOT LIKE 'goal-wait:%')",[&d.id],|r|r.get(0))?;
    if waiting {
        return Ok(Some(GoalBlockReason::Waiting));
    }
    let held:Option<String>=db.query_row("SELECT json_extract(o.body,'$.hold_reason') FROM followup_occurrences o JOIN followups f ON f.id=o.followup_id JOIN runs r ON r.id=json_extract(f.body,'$.source_run_id') WHERE json_extract(f.body,'$.goal_id')=?1 AND json_extract(o.body,'$.state')='held' AND json_extract(r.body,'$.state') IN ('completed','failed','cancelled') ORDER BY o.rowid DESC LIMIT 1",[&d.id],|r|r.get(0)).optional()?.flatten();
    Ok(match held.as_deref() {
        Some("source_unsettled") => Some(GoalBlockReason::Unsettled),
        Some("context_scope_changed") => Some(GoalBlockReason::ContextChanged),
        Some("preparation_failed") => Some(GoalBlockReason::PreparationFailed),
        _ => None,
    })
}
impl Catalog {
    pub fn capture_goal(&self, id: &str) -> Result<GoalRead> {
        let definition: Definition = record(&self.db, "goals", id)?;
        Ok(GoalRead {
            blocked: projection_block(&self.db, &definition)?,
            definition,
            usage: record(&self.db, "goal_usage", id)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn capture_goals(&self, thread: &str) -> Result<Vec<GoalRead>> {
        let mut q = self
            .db
            .prepare("SELECT id FROM goals WHERE thread_id=?1 ORDER BY rowid")?;
        let ids = q
            .query_map([thread], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.into_iter().map(|id| self.capture_goal(&id)).collect()
    }
    pub fn goal_binding(&self, run: &str) -> Result<Option<FrozenGoal>> {
        Ok(for_run(&self.db, run)?.map(|d| d.binding()))
    }
}

pub struct GoalMutationPreparation {
    scope: GoalScope,
    key: String,
    run_id: Option<String>,
    expected_revision: Option<u64>,
    objective: String,
    budget: Option<GoalBudget>,
    epoch: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedGoalMutation {
    scope: GoalScope,
    key: String,
    run_id: Option<String>,
    expected_revision: Option<u64>,
    objective_ref: Value,
    intent: Value,
    budget: Option<GoalBudget>,
    epoch: u64,
    _publication: crate::content::ContentPublication,
}
impl GoalMutationPreparation {
    pub fn load(self) -> Result<PreparedGoalMutation> {
        if self.objective.trim().is_empty() {
            return Err(RuntimeError::Invalid("Goal objective is empty".into()));
        }
        let objective_ref = self.content.save(&json!(self.objective))?;
        let intent = self.content.save(
            &json!({"run_id":self.run_id,"objective_ref":objective_ref,"budget":self.budget}),
        )?;
        Ok(PreparedGoalMutation {
            scope: self.scope,
            key: self.key,
            run_id: self.run_id,
            expected_revision: self.expected_revision,
            objective_ref,
            intent,
            budget: self.budget,
            epoch: self.epoch,
            _publication: self._publication,
        })
    }
}
impl Catalog {
    pub fn prepare_goal_start(
        &self,
        key: &str,
        run_id: &str,
        scope: GoalScope,
        objective: String,
        budget: Option<GoalBudget>,
    ) -> Result<GoalMutationPreparation> {
        if key.trim().is_empty() {
            return Err(RuntimeError::Invalid("Goal key is required".into()));
        }
        Ok(GoalMutationPreparation {
            scope,
            key: key.into(),
            run_id: Some(run_id.into()),
            expected_revision: None,
            objective,
            budget,
            epoch: self.epoch,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn prepare_goal_update(
        &self,
        id: &str,
        revision: u64,
        scope: GoalScope,
        objective: String,
        budget: Option<GoalBudget>,
    ) -> Result<GoalMutationPreparation> {
        Ok(GoalMutationPreparation {
            scope,
            key: id.into(),
            run_id: None,
            expected_revision: Some(revision),
            objective,
            budget,
            epoch: self.epoch,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn admit_goal_mutation(&mut self, p: PreparedGoalMutation) -> Result<GoalControlReceipt> {
        if p.epoch != self.epoch
            || self
                .continuation_stopping
                .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(RuntimeError::Conflict(
                "Goal owner changed or stopped".into(),
            ));
        }
        let tx = self.db.transaction()?;
        if let Some(run_id) = &p.run_id {
            if let Some(old) = optional_record::<Definition>(&tx, "goals", &p.key)? {
                old.require_scope(&p.scope)?;
                if old.start_intent != p.intent {
                    return Err(RuntimeError::Conflict(
                        "Goal key has different input".into(),
                    ));
                }
                return Ok(old.receipt());
            }
            let run: Run = record(&tx, "runs", run_id)?;
            context_jobs::require_regular_branch(&tx, &run.branch_id)?;
            let delegated: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM child_tasks WHERE child_thread_id=?1)",
                [&run.thread_id],
                |r| r.get(0),
            )?;
            let latest:String=tx.query_row("SELECT coalesce(active_run,(SELECT id FROM runs WHERE branch_id=?1 ORDER BY rowid DESC LIMIT 1)) FROM branches WHERE id=?1",[&run.branch_id],|r|r.get(0))?;
            if run.thread_id != p.scope.thread_id
                || run.branch_id != p.scope.branch_id
                || delegated
                || latest != run.id
                || active_for_branch(&tx, &run.branch_id)?.is_some()
            {
                return Err(RuntimeError::Conflict(
                    "Goal requires the latest primary Run and no unfinished Goal on this branch"
                        .into(),
                ));
            }
            let d = Definition {
                id: p.key.clone(),
                revision: 1,
                generation: 1,
                thread_id: run.thread_id.clone(),
                branch_id: run.branch_id.clone(),
                source_run_id: run.id.clone(),
                objective_ref: p.objective_ref,
                control: GoalControl::Active,
                budget: p.budget,
                blocked: None,
                reason_ref: None,
                dependency_operation_id: None,
                start_intent: p.intent,
            };
            tx.execute(
                "INSERT INTO goals(id,thread_id,branch_id,body) VALUES(?1,?2,?3,?4)",
                params![d.id, d.thread_id, d.branch_id, encode(&d)?],
            )?;
            tx.execute(
                "INSERT INTO goal_usage(id,body) VALUES(?1,?2)",
                params![d.id, encode(&GoalUsage::default())?],
            )?;
            tx.execute("INSERT INTO goal_runs(id,goal_id,primary_run) VALUES(?1,?2,1) ON CONFLICT(id) DO UPDATE SET goal_id=excluded.goal_id,primary_run=1",params![run.id,d.id])?;
            adopt_descendants(&tx, &run.id, &d.id)?;
            let cursor = event(
                &tx,
                &d.id,
                1,
                "goal.created",
                json!({"run_id":run.id,"thread_id":run.thread_id}),
            )?;
            if run.state.terminal() {
                followups::register_goal_continuation(&tx, &d, &run, Some(cursor))?;
            }
        } else {
            let mut d: Definition = record(&tx, "goals", &p.key)?;
            d.require_scope(&p.scope)?;
            if Some(d.revision) != p.expected_revision || d.ended() {
                return Err(RuntimeError::Conflict(
                    "Goal revision changed or ended".into(),
                ));
            }
            d.objective_ref = p.objective_ref;
            d.budget = p.budget;
            d.revision += 1;
            d.generation += 1;
            put(&tx, "goals", &d.id, &d)?;
            event(
                &tx,
                &d.id,
                d.revision,
                "goal.changed",
                json!({"generation":d.generation}),
            )?;
        }
        let receipt = record::<Definition>(&tx, "goals", &p.key)?.receipt();
        tx.commit()?;
        Ok(receipt)
    }
    /// Controls affect only Goal authorization. Existing question/policy/process Waits retain
    /// their original conditions and already handed-off external jobs keep their own lifetime.
    pub fn control_goal(
        &mut self,
        id: &str,
        revision: u64,
        scope: &GoalScope,
        action: GoalControlAction,
    ) -> Result<GoalControlReceipt> {
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "goals", id)?;
        d.require_scope(scope)?;
        if d.ended() {
            return Ok(d.receipt());
        }
        if d.revision != revision {
            return Err(RuntimeError::Conflict("Goal revision changed".into()));
        }
        d.control = match action {
            GoalControlAction::Pause => GoalControl::Paused,
            GoalControlAction::Resume => GoalControl::Active,
            GoalControlAction::Complete => GoalControl::Complete,
            GoalControlAction::Cancel => GoalControl::Cancelled,
        };
        if action == GoalControlAction::Resume && d.dependency_operation_id.is_none() {
            d.blocked = None;
            d.reason_ref = None;
        }
        d.revision += 1;
        d.generation += 1;
        put(&tx, "goals", id, &d)?;
        let cursor = event(
            &tx,
            id,
            d.revision,
            "goal.changed",
            json!({"generation":d.generation,"control":d.control}),
        )?;
        if action == GoalControlAction::Resume {
            let run: Run = record(&tx, "runs", &d.source_run_id)?;
            if run.state.terminal() && d.dependency_operation_id.is_none() {
                followups::register_goal_continuation(&tx, &d, &run, Some(cursor))?;
            }
        }
        tx.commit()?;
        Ok(d.receipt())
    }
}

/// These aggregate values are projections of original inference receipts. They are changed only
/// in the transaction that owns original dispatch/output publication, never by a public API.
fn add(n: &mut u64, v: u64) -> Result<()> {
    *n = n
        .checked_add(v)
        .ok_or_else(|| RuntimeError::Invalid("Goal usage counter overflow".into()))?;
    Ok(())
}
fn amount(value: &mut TokenAmount, n: Option<u64>) -> Result<()> {
    match n {
        Some(n) => add(&mut value.known, n),
        None => add(&mut value.unknown_receipts, 1),
    }
}
pub(super) fn dispatched(tx: &Transaction<'_>, binding: &FrozenGoal) -> Result<()> {
    let mut u: GoalUsage = record(tx, "goal_usage", &binding.id)?;
    add(&mut u.pending_inferences, 1)?;
    put(tx, "goal_usage", &binding.id, &u)
}
pub(super) fn measured(
    tx: &Transaction<'_>,
    binding: Option<&FrozenGoal>,
    receipt: &UsageReceipt,
) -> Result<()> {
    let Some(binding) = binding else {
        return Ok(());
    };
    let mut u: GoalUsage = record(tx, "goal_usage", &binding.id)?;
    u.pending_inferences = u
        .pending_inferences
        .checked_sub(1)
        .ok_or_else(|| RuntimeError::Invalid("Goal inference receipt lacks its dispatch".into()))?;
    let bucket = match receipt.measurement {
        UsageMeasurement::Missing => {
            add(&mut u.missing_inferences, 1)?;
            None
        }
        UsageMeasurement::Actual => Some(&mut u.actual),
        UsageMeasurement::Estimated => Some(&mut u.estimated),
    };
    if let Some(b) = bucket {
        add(&mut b.inferences, 1)?;
        amount(&mut b.input_tokens, receipt.input_tokens)?;
        amount(&mut b.output_tokens, receipt.output_tokens)?;
        amount(&mut b.cached_input_tokens, receipt.cached_input_tokens)?;
        amount(&mut b.cache_write_tokens, receipt.cache_write_tokens)?;
        amount(&mut b.reasoning_tokens, receipt.reasoning_tokens)?;
    }
    put(tx, "goal_usage", &binding.id, &u)?;
    event(tx, &binding.id, 0, "goal.usage_changed", Value::Null)?;
    Ok(())
}
pub(super) fn check_dispatch(
    db: &Connection,
    run: &str,
    selected: Option<&FrozenGoal>,
) -> Result<Option<FrozenGoal>> {
    let d = for_run(db, run)?;
    if d.as_ref().map(Definition::binding).as_ref() != selected {
        return Err(RuntimeError::GoalChanged);
    }
    if let Some(d) = d {
        let u: GoalUsage = record(db, "goal_usage", &d.id)?;
        if d.control != GoalControl::Active
            || budget_limited(&d, &u)
            || usage_unknown(&d, &u)
            || (d.blocked.is_some() && is_primary(db, run)?)
        {
            return Err(RuntimeError::GoalChanged);
        }
        return Ok(Some(d.binding()));
    }
    Ok(None)
}

pub struct GoalContextRead {
    definition: Definition,
    primary: bool,
    summary: bool,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct GoalContext {
    pub binding: FrozenGoal,
    pub item: Option<ConversationItem>,
}
impl GoalContextRead {
    pub fn load(self) -> Result<GoalContext> {
        let binding = self.definition.binding();
        let item = if self.summary {
            None
        } else {
            let objective: String =
                serde_json::from_value(self.content.load(&self.definition.objective_ref)?)?;
            Some(ConversationItem {
                resource_activation: None,
                id: format!("goal:{}:{}", binding.id, binding.generation),
                provenance: Provenance::GoalInstruction {
                    goal_id: binding.id.clone(),
                    generation: binding.generation,
                },
                content: Content::Text {
                    text: format!(
                        "User-established continuing objective:\n{objective}\n\n{}",
                        if self.primary {
                            "Continue useful work toward this objective within the existing permissions. Report completion explicitly with goal_report state=complete. If work is blocked, use goal_report state=blocked with the real reason and, when applicable, the original process operation to wait for. An ordinary final answer does not complete this continuing objective; do not repeat completed work or poll without a real dependency."
                        } else {
                            "This is the parent task's continuing objective. Complete only your admitted delegated task and report to the parent; this context grants no independent Goal control or additional permissions."
                        }
                    ),
                },
                opaque: None,
            })
        };
        Ok(GoalContext { binding, item })
    }
}
impl Catalog {
    pub fn capture_goal_context(&self, run: &str, epoch: u64) -> Result<Option<GoalContextRead>> {
        fence(&self.run(run)?, epoch)?;
        let Some(definition) = for_run(&self.db, run)? else {
            return Ok(None);
        };
        let primary: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM goal_runs WHERE id=?1 AND primary_run=1)",
            [run],
            |r| r.get(0),
        )?;
        Ok(Some(GoalContextRead {
            definition,
            primary,
            summary: self.is_context_job(run)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        }))
    }
}

#[derive(Debug, Clone)]
pub enum GoalBoundary {
    Continue,
    Wait { wait_id: String },
    Finish { state: RunState },
}
fn own_wait(wait: &Wait) -> bool {
    wait.kind == "goal.ready"
}
impl Catalog {
    /// One closed-boundary gate. Never tears down another domain's Wait or holds a worker lock.
    pub fn goal_boundary(&mut self, run_id: &str, epoch: u64) -> Result<GoalBoundary> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", run_id)?;
        fence(&run, epoch)?;
        let Some(d) = for_run(&tx, run_id)? else {
            return Ok(GoalBoundary::Continue);
        };
        let usage: GoalUsage = record(&tx, "goal_usage", &d.id)?;
        // Let the original question/policy wait be exposed first. Answering it never clears the
        // Goal pause; a restarted worker reaches this same gate before any subsequent dispatch.
        let other:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE run_id=?1 AND json_extract(body,'$.phase')='waiting' AND json_extract(body,'$.waiting_on') IS NOT NULL)",[run_id],|r|r.get(0))?;
        if other {
            return Ok(GoalBoundary::Continue);
        }
        match d.control {
            GoalControl::Complete => {
                return Ok(GoalBoundary::Finish {
                    state: if is_primary(&tx, run_id)? {
                        RunState::Completed
                    } else {
                        RunState::Cancelled
                    },
                })
            }
            GoalControl::Cancelled => {
                return Ok(GoalBoundary::Finish {
                    state: RunState::Cancelled,
                })
            }
            GoalControl::Active if d.blocked.is_some() && is_primary(&tx, run_id)? => {
                // Only this Run's reported round ends. User input delivered after the report,
                // or admitted to another Run, remains pending work until the block is released.
                let reported:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events e WHERE e.subject=?1 AND e.kind='goal.reported' AND json_extract(e.data,'$.run_id')=?2 AND json_extract(e.data,'$.state')='blocked' AND NOT EXISTS(SELECT 1 FROM events i WHERE i.subject=?2 AND i.kind='input.delivered' AND i.cursor>e.cursor))",params![d.id,run_id],|r|r.get(0))?;
                if reported {
                    return Ok(GoalBoundary::Finish {
                        state: RunState::Completed,
                    });
                }
            }
            GoalControl::Active if !budget_limited(&d, &usage) && !usage_unknown(&d, &usage) => {
                return Ok(GoalBoundary::Continue)
            }
            _ => (),
        }
        let wait_id = format!("goal-wait:{run_id}:{}:{}", d.id, d.generation);
        if optional_record::<Wait>(&tx, "waits", &wait_id)?.is_none() {
            let after_cursor =
                tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
                    read_number(r, 0)
                })?;
            let wait = Wait {
                id: wait_id.clone(),
                run_id: run_id.into(),
                subject: d.id.clone(),
                kind: "goal.ready".into(),
                after_cursor,
                trigger_cursor: None,
                cancelled: false,
            };
            tx.execute(
                "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
                params![wait_id, run_id, encode(&wait)?],
            )?;
            event(
                &tx,
                &wait_id,
                1,
                "wait.registered",
                json!({"goal_id":d.id,"run_id":run_id}),
            )?;
        }
        tx.commit()?;
        Ok(GoalBoundary::Wait { wait_id })
    }
    pub fn goal_waiting_runs(&self) -> Result<Vec<String>> {
        let mut q=self.db.prepare("SELECT r.id FROM runs r JOIN waits w ON w.id=json_extract(r.body,'$.waiting_on') WHERE json_extract(r.body,'$.state')='waiting' AND json_extract(w.body,'$.kind')='goal.ready'")?;
        let result = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(result)
    }
    pub fn release_goal_wait(&mut self, run_id: &str) -> Result<bool> {
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", run_id)?;
        if run.state != RunState::Waiting || run.cancel_requested {
            return Ok(false);
        }
        let Some(wait_id) = run.waiting_on.clone() else {
            return Ok(false);
        };
        let mut wait: Wait = record(&tx, "waits", &wait_id)?;
        if !own_wait(&wait) || wait.cancelled {
            return Ok(false);
        }
        let Some(d) = for_run(&tx, run_id)? else {
            return Ok(false);
        };
        let usage: GoalUsage = record(&tx, "goal_usage", &d.id)?;
        if d.control == GoalControl::Paused
            || (d.control == GoalControl::Active
                && (budget_limited(&d, &usage)
                    || usage_unknown(&d, &usage)
                    || (d.blocked.is_some() && is_primary(&tx, run_id)?)))
        {
            return Ok(false);
        }
        let cursor = event(
            &tx,
            &d.id,
            d.revision,
            "goal.run_ready",
            json!({"run_id":run_id,"goal_id":d.id}),
        )?;
        wait.trigger_cursor = Some(cursor);
        put(&tx, "waits", &wait_id, &wait)?;
        tx.execute("INSERT INTO resumptions(wait_id,run_id,trigger_cursor,claimed,acknowledged) VALUES(?1,?2,?3,1,1) ON CONFLICT(wait_id) DO NOTHING",params![wait_id,run_id,sql_number(cursor)?])?;
        run.state = RunState::Runnable;
        run.waiting_on = None;
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        tx.commit()?;
        Ok(true)
    }
}
pub(super) fn cancel_run(tx: &Transaction<'_>, run_id: &str) -> Result<()> {
    let direct: Option<String> = tx
        .query_row(
            "SELECT goal_id FROM goal_runs WHERE id=?1 AND primary_run=1",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = direct {
        let mut d: Definition = record(tx, "goals", &id)?;
        if !d.ended() && d.control != GoalControl::Paused {
            d.control = GoalControl::Paused;
            d.revision += 1;
            d.generation += 1;
            put(tx, "goals", &id, &d)?;
            event(
                tx,
                &id,
                d.revision,
                "goal.changed",
                json!({"control":d.control,"generation":d.generation,"reason":"run_cancelled"}),
            )?;
        }
    }
    Ok(())
}
pub(super) fn settle_run(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    let direct: Option<String> = tx
        .query_row(
            "SELECT goal_id FROM goal_runs WHERE id=?1 AND primary_run=1",
            [&run.id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(id) = direct else { return Ok(()) };
    let mut d: Definition = record(tx, "goals", &id)?;
    if d.ended() {
        return Ok(());
    }
    let active: Option<String> = tx.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [&run.branch_id],
        |r| r.get(0),
    )?;
    if active.is_none() || active.as_deref() == Some(&run.id) {
        d.source_run_id = run.id.clone();
    }
    match run.state {
        RunState::Cancelled => {
            put(tx, "goals", &id, &d)?;
            cancel_run(tx, &run.id)?;
        }
        RunState::Failed => {
            d.blocked = Some(GoalBlockReason::RunFailed);
            put(tx, "goals", &id, &d)?;
            event(
                tx,
                &id,
                d.revision,
                "goal.blocked",
                json!({"run_id":run.id,"reason":"run_failed"}),
            )?;
        }
        RunState::Completed => {
            put(tx, "goals", &id, &d)?;
            if d.blocked.is_none() && d.source_run_id == run.id {
                followups::register_goal_continuation(tx, &d, run, None)?;
            }
        }
        _ => (),
    }
    Ok(())
}
pub(super) fn clear_dependency(tx: &Transaction<'_>, id: &str, operation: &str) -> Result<()> {
    let mut d: Definition = record(tx, "goals", id)?;
    if d.dependency_operation_id.as_deref() == Some(operation) {
        d.dependency_operation_id = None;
        d.blocked = None;
        d.reason_ref = None;
        put(tx, "goals", id, &d)?;
        event(
            tx,
            id,
            d.revision,
            "goal.dependency_satisfied",
            json!({"operation_id":operation}),
        )?;
    }
    Ok(())
}
/// New effects from an old frozen request cannot cross a later user control change.
pub(super) fn tool_allowed(
    db: &Connection,
    c: &crate::execution::ToolExecutionContext,
) -> Result<bool> {
    let selected = origin_goal(db, &c.origin)?;
    let current = for_run(db, &c.run_id)?;
    Ok(current.as_ref().map(Definition::binding) == selected
        && current.is_none_or(|d| d.control == GoalControl::Active))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GoalReportState {
    Complete,
    Blocked,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalReportInput {
    pub state: GoalReportState,
    pub reason: String,
    pub wait_operation_id: Option<String>,
}
pub struct GoalReportPreparation {
    definition: Definition,
    operation: Operation,
    epoch: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedGoalReport {
    definition: Definition,
    operation: Operation,
    epoch: u64,
    input: GoalReportInput,
    reason_ref: Value,
    completion: crate::execution::ToolCompletion,
    completion_metadata: result_content::ToolCompletionMetadata,
    _publication: crate::content::ContentPublication,
}
impl GoalReportPreparation {
    pub fn load(self) -> Result<PreparedGoalReport> {
        let intent = tool_content::ToolIntent::from_operation(&self.operation)?;
        let input: GoalReportInput =
            serde_json::from_value(self.content.load(&intent.call().arguments_ref)?)?;
        if input.reason.trim().is_empty()
            || (input.state == GoalReportState::Complete && input.wait_operation_id.is_some())
        {
            return Err(RuntimeError::Invalid(
                "Goal report needs a reason; only blocked reports can name a dependency".into(),
            ));
        }
        let reason_ref = self.content.save(&json!(input.reason))?;
        let completion = crate::execution::ToolCompletion::Result {
            outcome: Outcome::Succeeded,
            effect: Effect::Confirmed,
            content: json!({"goal_id":self.definition.id,"state":input.state,"revision":self.definition.revision+1,"generation":self.definition.generation+1}),
        };
        let completion_metadata =
            result_content::ToolCompletionMetadata::write(&self.content, &completion)?;
        Ok(PreparedGoalReport {
            definition: self.definition,
            operation: self.operation,
            epoch: self.epoch,
            input,
            reason_ref,
            completion,
            completion_metadata,
            _publication: self._publication,
        })
    }
}
fn origin_goal(
    db: &Connection,
    origin: &crate::execution::ToolOrigin,
) -> Result<Option<FrozenGoal>> {
    match origin {
        crate::execution::ToolOrigin::ModelStep { request_id } => {
            Ok(record::<ModelStep>(db, "model_steps", request_id)?.goal)
        }
        crate::execution::ToolOrigin::PolicyAction { action_id, .. } => {
            Ok(policy_body::PolicyActionMetadata::from_operation(&record(
                db,
                "operations",
                action_id,
            )?)?
            .and_then(|m| m.boundary().goal.clone()))
        }
    }
}
impl Catalog {
    pub fn prepare_goal_report(
        &self,
        c: &crate::execution::ToolExecutionContext,
    ) -> Result<GoalReportPreparation> {
        let operation = self.operation(&c.operation_id)?;
        let intent = tool_content::ToolIntent::from_operation(&operation)?;
        let run = self.run(&c.run_id)?;
        fence(&run, self.epoch)?;
        let direct: Option<String> = self
            .db
            .query_row(
                "SELECT goal_id FROM goal_runs WHERE id=?1 AND primary_run=1",
                [&run.id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(id) = direct else {
            return Err(RuntimeError::Conflict(
                "only the primary Goal Run can report its state".into(),
            ));
        };
        let definition: Definition = record(&self.db, "goals", &id)?;
        if operation.run_id != run.id
            || intent.origin() != &c.origin
            || intent.call().name != REPORT_TOOL
            || operation.cancel_requested
            || run.cancel_requested
            || definition.control != GoalControl::Active
            || origin_goal(&self.db, &c.origin)?.as_ref() != Some(&definition.binding())
        {
            return Err(RuntimeError::Conflict(
                "Goal report no longer owns the current objective generation".into(),
            ));
        }
        Ok(GoalReportPreparation {
            definition,
            operation,
            epoch: self.epoch,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn admit_goal_report(
        &mut self,
        p: PreparedGoalReport,
    ) -> Result<crate::execution::ToolCompletion> {
        if p.epoch != self.epoch {
            return Err(RuntimeError::Conflict("Goal report owner changed".into()));
        }
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &p.operation.id)?;
        if op.call_completion.as_ref() == Some(&p.completion_metadata) {
            return Ok(p.completion);
        }
        let mut d: Definition = record(&tx, "goals", &p.definition.id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        if d.binding() != p.definition.binding()
            || op != p.operation
            || op.cancel_requested
            || run.cancel_requested
            || op.phase != OperationPhase::Running
            || d.control != GoalControl::Active
        {
            return Err(RuntimeError::Conflict(
                "Goal report was superseded by control or another original receipt".into(),
            ));
        }
        d.reason_ref = Some(p.reason_ref);
        d.revision += 1;
        d.generation += 1;
        match p.input.state {
            GoalReportState::Complete => {
                d.control = GoalControl::Complete;
                d.blocked = None;
                d.dependency_operation_id = None;
            }
            GoalReportState::Blocked => {
                d.blocked = Some(if p.input.wait_operation_id.is_some() {
                    GoalBlockReason::Dependency
                } else {
                    GoalBlockReason::Reported
                });
                d.dependency_operation_id = p.input.wait_operation_id.clone();
            }
        }
        put(&tx, "goals", &d.id, &d)?;
        if let Some(process) = &p.input.wait_operation_id {
            followups::register_process_tx(
                &tx,
                &format!("goal:{}:dependency:{}", d.id, op.id),
                &run.id,
                process,
                Some(&d.id),
            )?;
        }
        let result = match &p.completion_metadata {
            result_content::ToolCompletionMetadata::Result { content_ref, .. } => {
                content_ref.clone()
            }
            _ => unreachable!(),
        };
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(Outcome::Succeeded);
        op.effect = Effect::Confirmed;
        op.result = Some(OperationResultMetadata::Content { reference: result });
        op.call_completion = Some(p.completion_metadata.clone());
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        tx.execute(
            "DELETE FROM resource_occupancy WHERE operation_id=?1",
            [&op.id],
        )?;
        let intent = tool_content::ToolIntent::from_operation(&op)?;
        match intent.origin() {
            crate::execution::ToolOrigin::ModelStep { request_id } => {
                let receipt = result_content::ToolReceiptMetadata {
                    request_id: request_id.clone(),
                    call_id: intent.call().call_id.clone(),
                    completion: p.completion_metadata,
                };
                tx.execute(
                    "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
                    params![request_id, intent.call().call_id, encode(&receipt)?],
                )?;
            }
            crate::execution::ToolOrigin::PolicyAction { .. } => (), // The canonical Operation is the receipt; graph settlement projects it.
        }
        event(
            &tx,
            &d.id,
            d.revision,
            "goal.reported",
            json!({"run_id":run.id,"operation_id":op.id,"state":p.input.state,"generation":d.generation}),
        )?;
        event(
            &tx,
            &op.id,
            op.revision,
            "operation.settled",
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(p.completion)
    }
}
