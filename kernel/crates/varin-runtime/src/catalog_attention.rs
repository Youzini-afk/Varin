//! Compact, metadata-only Host attention. This is a read model, never a second task owner.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionRun {
    pub id: String,
    pub state: RunState,
    pub revision: u64,
    pub cancel_requested: bool,
    /// Terminal Runs only: whether the Run published assistant output the user can read.
    /// A quiet background round ends without it; null while the Run is not terminal.
    pub visible_output: Option<bool>,
}
impl From<&Run> for AttentionRun {
    fn from(r: &Run) -> Self {
        Self {
            id: r.id.clone(),
            state: r.state,
            revision: r.revision,
            cancel_requested: r.cancel_requested,
            visible_output: None,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionBranch {
    pub thread_id: String,
    pub branch_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub parent_thread_id: Option<String>,
    /// Exact Catalog ownership, including existing child ancestry; null is unbound.
    pub bot_id: Option<String>,
    /// The Bot conversation whose execution ancestry contains this Thread (itself for a
    /// session). Null for unbound work and for Bot helpers that belong to no conversation.
    pub bot_session_thread_id: Option<String>,
    pub archived: bool,
    pub deleted: bool,
    pub active_run_id: Option<String>,
    pub current_run: Option<AttentionRun>,
    pub latest_run: Option<AttentionRun>,
    pub has_unsettled_work: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_id: Option<String>,
    pub revision: u64,
    pub kind: String,
    pub actionable: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionCounts {
    pub action_required: usize,
    pub affected_branches: usize,
    pub unknown_effects: usize,
}
#[derive(Debug, Clone, Serialize)]
pub struct AttentionCoverage {
    pub native: &'static str,
    pub external: &'static str,
    pub scope: &'static str,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionTeamExecution {
    pub parent_thread_id: String,
    pub parent_branch_id: String,
    pub parent_run_id: String,
    pub child_operation_id: String,
    pub execution_id: String,
    pub child_thread_id: String,
    pub child_branch_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub state: String,
    pub child_run_id: Option<String>,
    pub child_run_state: Option<RunState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<&'static str>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionDelegation {
    pub operation_id: String,
    pub parent_thread_id: String,
    pub parent_branch_id: String,
    pub parent_run_id: String,
    pub child_thread_id: String,
    pub child_branch_id: String,
    pub accepted_cursor: Option<u64>,
    /// The latest acceptance of this same child Agent asked again through a message request.
    /// The relation and identity are unchanged; only the new request has its own cursor.
    pub continued_cursor: Option<u64>,
    /// The Thread that sent that request (the original requester or another conversation).
    pub continued_by_thread_id: Option<String>,
    /// The latest report this child actually returned to its requester, and its outcome.
    pub report_cursor: Option<u64>,
    pub report_outcome: Option<String>,
}
/// Work a Bot follows by the user's explicit association. Following never becomes dispatch:
/// the Thread keeps its own owner, Agent and relations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionFollow {
    pub bot_id: String,
    pub matter_id: String,
    pub thread_id: String,
    pub branch_id: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSnapshot {
    pub epoch: u64,
    pub event_cursor: u64,
    pub coverage: AttentionCoverage,
    pub branches: Vec<AttentionBranch>,
    pub items: Vec<AttentionItem>,
    pub team_executions: Vec<AttentionTeamExecution>,
    pub delegations: Vec<AttentionDelegation>,
    pub follows: Vec<AttentionFollow>,
    pub counts: AttentionCounts,
}
/// Work whose original owner has not settled. The text matches the partial indexes created
/// with the Catalog, so each read touches open records instead of every retained one.
pub(super) const OPEN_RUN: &str = "json_extract(body,'$.state') NOT IN ('completed','failed','cancelled')";
pub(super) const OPEN_OPERATION: &str = "(json_extract(o.body,'$.phase')!='terminal' OR json_extract(o.body,'$.effect')='unknown' OR json_extract(o.body,'$.outcome')='indeterminate' OR (json_extract(o.body,'$.mcp_resource_subscription') IS NOT NULL AND (json_extract(o.body,'$.cancel_requested')=0 OR json_extract(o.body,'$.mcp_resource_subscription.localReleased')=0)))";
const OPEN_MCP: &str = "(json_extract(body,'$.choice') IS NULL OR json_extract(body,'$.delivery') IN ('unknown','sending') OR json_extract(body,'$.deliveryReleased')=0)";
/// Which committed Catalog data a snapshot was read from. The Catalog connection is the writer:
/// its own change count covers its commits and data_version covers any other connection.
/// Attention is a pure function of that data and the owner epoch (no clock input).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AttentionGeneration {
    data_version: i64,
    changes: u64,
}
/// The last snapshot and the generation captured before it was read. Holding the lock while
/// reading also makes concurrent pollers wait for one read instead of repeating it.
pub(super) type AttentionCache =
    std::sync::Arc<std::sync::Mutex<Option<(AttentionGeneration, AttentionSnapshot)>>>;
/// Capture only location/owner under the Catalog mutex. SQL and serialization run on a worker.
pub struct AttentionRead {
    database: std::path::PathBuf,
    epoch: u64,
    generation: Option<AttentionGeneration>,
    cache: AttentionCache,
}
impl Catalog {
    pub fn capture_attention_read(&self) -> AttentionRead {
        // No generation means no reuse; the read itself still reports its own failure.
        let generation = self
            .db
            .query_row("PRAGMA data_version", [], |r| r.get::<_, i64>(0))
            .ok()
            .map(|data_version| AttentionGeneration {
                data_version,
                changes: self.db.total_changes(),
            });
        AttentionRead {
            database: self.database_path.clone(),
            epoch: self.epoch,
            generation,
            cache: self.attention_cache.clone(),
        }
    }
}
fn check(cancel: &dyn Fn() -> bool) -> Result<()> {
    if cancel() {
        Err(RuntimeError::DispatchCancelled)
    } else {
        Ok(())
    }
}
fn item(
    run: &Run,
    op: Option<&Operation>,
    kind: &str,
    request: Option<String>,
    permission: Option<String>,
    revision: u64,
    actionable: bool,
) -> AttentionItem {
    AttentionItem {
        key: json!([
            run.thread_id,
            run.branch_id,
            run.id,
            op.map(|o| &o.id),
            kind,
            request,
            permission
        ])
        .to_string(),
        thread_id: run.thread_id.clone(),
        branch_id: run.branch_id.clone(),
        run_id: run.id.clone(),
        operation_id: op.map(|o| o.id.clone()),
        request_id: request,
        permission_id: permission,
        revision,
        kind: kind.into(),
        actionable,
    }
}
impl AttentionRead {
    pub fn load(self, cancel: &dyn Fn() -> bool) -> Result<AttentionSnapshot> {
        self.read(cancel, None)
    }
    pub fn load_cancellable(
        self,
        cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<AttentionSnapshot> {
        let signal = cancelled.clone();
        self.read(
            &|| signal.load(std::sync::atomic::Ordering::Acquire),
            Some(cancelled),
        )
    }
    fn read(
        self,
        cancel: &dyn Fn() -> bool,
        sql_cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) -> Result<AttentionSnapshot> {
        let cache = self.cache.clone();
        let mut cached = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let (Some(generation), Some((previous, snapshot))) = (self.generation, cached.as_ref()) {
            if generation == *previous && snapshot.epoch == self.epoch {
                check(cancel)?;
                // Unchanged data, but this read must still belong to the current owner.
                history_views::current_history_owner(&self.database, self.epoch)?;
                return Ok(snapshot.clone());
            }
        }
        let generation = self.generation;
        let snapshot = self.read_uncached(cancel, sql_cancel)?;
        *cached = generation.map(|generation| (generation, snapshot.clone()));
        Ok(snapshot)
    }
    fn read_uncached(
        self,
        cancel: &dyn Fn() -> bool,
        sql_cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) -> Result<AttentionSnapshot> {
        check(cancel)?;
        let db = history_views::current_history_owner(&self.database, self.epoch)?;
        if let Some(signal) = sql_cancel {
            db.progress_handler(
                1000,
                Some(move || signal.load(std::sync::atomic::Ordering::Acquire)),
            )?;
        }
        db.execute_batch("BEGIN")?;
        // The first read establishes the same SQLite cut for cursor, rows, entries and counts.
        let (epoch,event_cursor):(u64,u64)=db.query_row("SELECT epoch,(SELECT coalesce(max(cursor),0) FROM events) FROM runtime_meta WHERE id=1",[],|r|Ok((read_number(r,0)?,read_number(r,1)?)))?;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict("attention owner changed".into()));
        }
        let mut branches = BTreeMap::new();
        let mut runs = BTreeMap::<String, Run>::new();
        let mut items = Vec::new();
        // Branches whose original owners may still hold work, whatever their visibility. Archived
        // and deleted Threads are read only through these, not by loading every retained Thread.
        let mut hinted = BTreeSet::<String>::new();
        let mut q = db.prepare(&format!("SELECT branch_id FROM runs WHERE {OPEN_RUN}
          UNION SELECT branch_id FROM input_queue WHERE state='queued' AND activation='activating'
          UNION SELECT r.branch_id FROM operations o JOIN runs r ON r.id=o.run_id WHERE {OPEN_OPERATION}
          UNION SELECT root_branch_id FROM computer_requests WHERE json_extract(body,'$.status') IN ('pending','granting','indeterminate')
          UNION SELECT json_extract(body,'$.branchId') FROM mcp_interactions WHERE {OPEN_MCP}"))?;
        for id in q.query_map([], |r| r.get::<_, Option<String>>(0))? {
            if let Some(id) = id? {
                hinted.insert(id);
            }
        }
        // Reuse the original task-family current-work predicate: this is not execution history.
        // A terminal child with report/delivery still settling keeps its relation, not a running claim.
        let mut q=db.prepare(&format!("SELECT c.body,d.body FROM child_tasks c JOIN threads t ON t.id=c.child_thread_id JOIN delegated_executions d ON d.child_operation_id=c.id WHERE d.rowid=(SELECT max(x.rowid) FROM delegated_executions x WHERE x.child_operation_id=c.id) AND ({}) ORDER BY c.id",family::CURRENT))?;
        let mut team_rows = Vec::new();
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            check(cancel)?;
            let (child, execution) = row?;
            let child: delegated::ChildRelation = serde_json::from_str(&child)?;
            let execution: delegated::DelegatedExecution = serde_json::from_str(&execution)?;
            hinted.insert(child.parent_branch_id.clone());
            hinted.insert(child.child_branch_id.clone());
            team_rows.push((child, execution));
        }
        // These are the same internal inference/retrieval exclusions as product discovery.
        let mut q=db.prepare("SELECT t.id,b.id,t.title,t.archived,t.deleted_at_ms IS NOT NULL,b.active_run,
          (SELECT body FROM runs WHERE branch_id=b.id ORDER BY rowid DESC LIMIT 1),
          (SELECT json_extract(body,'$.parent_thread_id') FROM child_tasks WHERE child_thread_id=t.id),
          (SELECT json_extract(body,'$.avatar') FROM child_tasks WHERE child_thread_id=t.id)
          FROM threads t JOIN branches b ON b.thread_id=t.id
          WHERE ((t.archived=0 AND t.deleted_at_ms IS NULL) OR b.id IN (SELECT value FROM json_each(?1)))
          AND NOT EXISTS(SELECT 1 FROM child_tasks c JOIN operations o ON o.id=c.id WHERE c.child_thread_id=t.id AND json_extract(o.body,'$.executor')='code_retrieval')
          AND NOT EXISTS(SELECT 1 FROM branches x JOIN runs r ON r.branch_id=x.id JOIN context_jobs c ON c.run_id=r.id WHERE x.thread_id=t.id)
          AND NOT EXISTS(SELECT 1 FROM branches x JOIN runs r ON r.branch_id=x.id JOIN operations o ON o.run_id=r.id WHERE x.thread_id=t.id AND json_extract(o.body,'$.intent.kind')='memory_work_v1') ORDER BY t.id,b.id")?;
        let rows = q.query_map([serde_json::to_string(&hinted)?], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
                r.get::<_, bool>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })?;
        // Every branch of a Thread shares its owner; resolve the ancestry once per Thread.
        let mut owners = BTreeMap::<String, Option<bot::ThreadOwner>>::new();
        for row in rows {
            check(cancel)?;
            let (
                thread_id,
                branch_id,
                title,
                archived,
                deleted,
                active_run_id,
                latest,
                parent_thread_id,
                avatar,
            ) = row?;
            let latest: Option<Run> = latest.map(|r| serde_json::from_str(&r)).transpose()?;
            let active: Option<Run> = active_run_id
                .as_deref()
                .map(|id| record(&db, "runs", id))
                .transpose()?;
            let has_unsettled_work = active.as_ref().is_some_and(|r| !r.state.terminal());
            if let Some(run) = active.as_ref() {
                runs.insert(run.id.clone(), run.clone());
            }
            if let Some(run) = latest.as_ref() {
                runs.insert(run.id.clone(), run.clone());
            }
            let owner = match owners.get(&thread_id) {
                Some(owner) => owner.clone(),
                None => {
                    let owner = bot::thread_owner(&db, &thread_id)?;
                    owners.insert(thread_id.clone(), owner.clone());
                    owner
                }
            };
            let mut latest_run: Option<AttentionRun> = latest.as_ref().map(Into::into);
            if let Some(run) = latest_run.as_mut().filter(|run| run.state.terminal()) {
                run.visible_output = Some(db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='assistant.output')", [&run.id], |r| r.get(0))?);
            }
            branches.insert(
                branch_id.clone(),
                AttentionBranch {
                    bot_id: owner.as_ref().map(|owner| owner.bot_id.clone()),
                    bot_session_thread_id: owner.and_then(|owner| owner.session_thread_id),
                    thread_id,
                    branch_id,
                    title,
                    avatar,
                    parent_thread_id,
                    archived,
                    deleted,
                    active_run_id,
                    current_run: active.as_ref().map(Into::into),
                    latest_run,
                    has_unsettled_work,
                },
            );
        }
        // No result/intent content is hydrated. Independent effects can outlive their Run.
        let mut q=db.prepare(&format!("SELECT o.body,r.body FROM operations o JOIN runs r ON r.id=o.run_id WHERE {OPEN_OPERATION} ORDER BY o.id"))?;
        let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            check(cancel)?;
            let (raw, run) = row?;
            let op: Operation = serde_json::from_str(&raw)?;
            let run: Run = serde_json::from_str(&run)?;
            let Some(branch) = branches.get_mut(&run.branch_id) else {
                continue;
            };
            branch.has_unsettled_work = true;
            if op.effect == Effect::Unknown || op.outcome == Some(Outcome::Indeterminate) {
                items.push(item(
                    &run,
                    Some(&op),
                    "effect_unknown",
                    None,
                    None,
                    op.revision,
                    false,
                ));
            }
            if let Some(id) = permissions::attention(&db, &op, &run, epoch)? {
                items.push(item(
                    &run,
                    Some(&op),
                    "permission",
                    None,
                    Some(id),
                    op.revision,
                    true,
                ));
            }
            if questions::attention(&db, &op, &run, epoch)? {
                items.push(item(
                    &run,
                    Some(&op),
                    "question",
                    None,
                    None,
                    op.revision,
                    true,
                ));
            }
            if op.cancel_requested && op.phase != OperationPhase::Terminal {
                items.push(item(
                    &run,
                    Some(&op),
                    "cancelling",
                    None,
                    None,
                    op.revision,
                    false,
                ));
            }
            runs.insert(run.id.clone(), run);
        }
        let mut q=db.prepare("SELECT body FROM computer_requests WHERE json_extract(body,'$.status') IN ('pending','granting','indeterminate') ORDER BY id")?;
        for row in q.query_map([], |r| r.get::<_, String>(0))? {
            check(cancel)?;
            let request: computer_requests::ComputerRequestRecord = serde_json::from_str(&row?)?;
            if !branches.contains_key(&request.root_branch_id) {
                continue;
            }
            let run: Run = record(&db, "runs", &request.requester.run_id)?;
            let actionable = computer_requests::attention(&db, &request, epoch)?;
            let unknown = request.status == computer_requests::ComputerRequestStatus::Indeterminate;
            if actionable
                || unknown
                || request.status == computer_requests::ComputerRequestStatus::Granting
            {
                if let Some(branch) = branches.get_mut(&request.root_branch_id) {
                    branch.has_unsettled_work = true;
                }
                let mut entry = item(
                    &run,
                    None,
                    if unknown {
                        "effect_unknown"
                    } else {
                        "computer_permission"
                    },
                    Some(request.id),
                    None,
                    request.revision,
                    actionable,
                );
                // User decisions belong to root work, requester Run remains the original execution witness.
                entry.thread_id = request.root_thread_id;
                entry.branch_id = request.root_branch_id;
                entry.operation_id = Some(request.operation_id);
                entry.key = json!([
                    entry.thread_id,
                    entry.branch_id,
                    entry.run_id,
                    entry.operation_id,
                    entry.kind,
                    entry.request_id
                ])
                .to_string();
                items.push(entry);
            }
        }
        let mut q=db.prepare("SELECT body FROM mcp_interactions WHERE json_extract(body,'$.choice') IS NULL AND (json_extract(body,'$.mode')!='sampling' OR json_extract(body,'$.sampling.review') IN ('request','output')) ORDER BY id")?;
        for raw in q.query_map([], |r| r.get::<_, String>(0))? {
            check(cancel)?;
            if let Some((m, kind)) = mcp_interactions::attention(&db, &raw?, epoch)? {
                let Some(branch) = branches.get_mut(&m.branch_id) else {
                    continue;
                };
                branch.has_unsettled_work = true;
                let run: Run = record(&db, "runs", &m.run_id)?;
                let op: Operation = record(&db, "operations", &m.binding.operation_id)?;
                items.push(item(
                    &run,
                    Some(&op),
                    kind,
                    Some(m.id),
                    None,
                    m.revision,
                    true,
                ));
            }
        }
        // A chosen MCP response can have an uncertain delivery independently of its tool effect.
        let mut q=db.prepare("SELECT body FROM mcp_interactions WHERE json_extract(body,'$.delivery') IN ('unknown','sending') OR json_extract(body,'$.deliveryReleased')=0 ORDER BY id")?;
        for raw in q.query_map([], |r| r.get::<_, String>(0))? {
            check(cancel)?;
            let m: mcp_interactions::McpInteractionRecord = serde_json::from_str(&raw?)?;
            let Some(branch) = branches.get_mut(&m.branch_id) else {
                continue;
            };
            branch.has_unsettled_work = true;
            if m.delivery != Some(crate::McpInteractionDelivery::Unknown) {
                continue;
            }
            let run: Run = record(&db, "runs", &m.run_id)?;
            let op: Operation = record(&db, "operations", &m.binding.operation_id)?;
            items.push(item(
                &run,
                Some(&op),
                "effect_unknown",
                Some(m.id),
                None,
                m.revision,
                false,
            ));
        }
        // Queued/activating work need not yet own a branch's active pointer.
        let mut q=db.prepare(&format!("SELECT DISTINCT branch_id FROM runs WHERE {OPEN_RUN} UNION SELECT branch_id FROM input_queue WHERE state='queued' AND activation='activating'"))?;
        for id in q.query_map([], |r| r.get::<_, String>(0))? {
            check(cancel)?;
            if let Some(b) = branches.get_mut(&id?) {
                b.has_unsettled_work = true;
            }
        }
        let mut team_executions = Vec::new();
        for (child, execution) in team_rows {
            check(cancel)?;
            if !branches.contains_key(&child.parent_branch_id)
                || !branches.contains_key(&child.child_branch_id)
            {
                continue;
            }
            let state = execution.state().to_owned();
            let run: Option<Run> = execution
                .receipt
                .as_ref()
                .map(|r| record(&db, "runs", &r.run_id))
                .transpose()?;
            let activity = if state == "ready" {
                if let Some(run) = run.as_ref() {
                    let preparation:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM run_launches WHERE id=?1 AND json_extract(body,'$.preparation_failure') IS NOT NULL)",[&run.id],|r|r.get(0))?;
                    Some(if preparation {
                        "preparation_failed"
                    } else if run.state.terminal() {
                        "settling"
                    } else if run
                        .waiting_on
                        .as_deref()
                        .is_some_and(|w| w.starts_with("preparation:"))
                    {
                        "preparing"
                    } else if run.state == RunState::Waiting {
                        "waiting"
                    } else {
                        "running"
                    })
                } else {
                    None
                }
            } else {
                None
            };
            for branch in [&child.parent_branch_id, &child.child_branch_id] {
                if let Some(b) = branches.get_mut(branch) {
                    b.has_unsettled_work = true;
                }
            }
            team_executions.push(AttentionTeamExecution {
                parent_thread_id: child.parent_thread_id,
                parent_branch_id: child.parent_branch_id,
                parent_run_id: child.parent_run_id,
                child_operation_id: child.operation_id,
                execution_id: execution.execution_id,
                child_thread_id: child.child_thread_id,
                child_branch_id: child.child_branch_id,
                avatar: child.avatar,
                state,
                child_run_id: run.as_ref().map(|r| r.id.clone()),
                child_run_state: run.as_ref().map(|r| r.state),
                activity,
            });
        }
        branches.retain(|_, b| (!b.archived && !b.deleted) || b.has_unsettled_work);
        for branch in branches.values() {
            check(cancel)?;
            let shown = branch
                .active_run_id
                .as_ref()
                .and_then(|id| runs.get(id))
                .or_else(|| branch.latest_run.as_ref().and_then(|r| runs.get(&r.id)));
            if let Some(run) = shown {
                if run.cancel_requested && !run.state.terminal() {
                    items.push(item(
                        run,
                        None,
                        "cancelling",
                        None,
                        None,
                        run.revision,
                        false,
                    ));
                }
                // Preparation failure is a retryable waiting Run, not a terminal failure.
                let preparation:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM run_launches WHERE id=?1 AND json_extract(body,'$.preparation_failure') IS NOT NULL)",[&run.id],|r|r.get(0))?;
                if preparation && !run.state.terminal() && !run.cancel_requested {
                    items.push(item(
                        run,
                        None,
                        "preparation_failed",
                        None,
                        None,
                        run.revision,
                        false,
                    ));
                } else if !branch.archived && !branch.deleted && run.state == RunState::Failed {
                    // Hidden historical failures do not become persistent action requests.
                    items.push(item(
                        run,
                        None,
                        "run_failed",
                        None,
                        None,
                        run.revision,
                        false,
                    ));
                }
            }
        }
        // Stable relations outlive current execution/report delivery. Restrict the recursive
        // read to displayed Threads and their actual ancestors, never all retained task history.
        let thread_ids = branches
            .values()
            .map(|b| &b.thread_id)
            .collect::<BTreeSet<_>>();
        let mut q = db.prepare("WITH RECURSIVE lineage(thread_id) AS (
          SELECT value FROM json_each(?1) UNION
          SELECT json_extract(c.body,'$.parent_thread_id') FROM child_tasks c
            JOIN lineage l ON c.child_thread_id=l.thread_id)
          SELECT c.body,(SELECT min(e.cursor) FROM events e WHERE e.subject=c.id AND e.kind='child.accepted'),
            (SELECT json_array(e.cursor,q.sender_thread_id) FROM delegated_executions d JOIN events e ON e.subject=d.id AND e.kind='child.execution_accepted'
              LEFT JOIN input_queue q ON q.id=json_extract(d.body,'$.trigger.message_id')
              WHERE d.child_operation_id=c.id AND json_extract(d.body,'$.trigger.kind')='message_request' ORDER BY e.cursor DESC LIMIT 1),
            (SELECT max(e.cursor) FROM delegated_executions d JOIN events e ON e.subject=d.id AND e.kind='child.report_ready' WHERE d.child_operation_id=c.id),
            (SELECT json_extract(e.data,'$.outcome') FROM delegated_executions d JOIN events e ON e.subject=d.id AND e.kind='child.report_ready'
              WHERE d.child_operation_id=c.id ORDER BY e.cursor DESC LIMIT 1)
          FROM child_tasks c JOIN lineage l ON c.child_thread_id=l.thread_id ORDER BY c.id")?;
        let mut delegations = Vec::new();
        let cursor = |r: &rusqlite::Row<'_>, i: usize| -> rusqlite::Result<Option<u64>> {
            if r.get::<_, Option<i64>>(i)?.is_some() { Ok(Some(read_number(r, i)?)) } else { Ok(None) }
        };
        for row in q.query_map([serde_json::to_string(&thread_ids)?], |r| {
            Ok((r.get::<_, String>(0)?, cursor(r, 1)?, r.get::<_, Option<String>>(2)?, cursor(r, 3)?, r.get::<_, Option<String>>(4)?))
        })? {
            check(cancel)?;
            let (body, accepted_cursor, continued, report_cursor, report_outcome) = row?;
            let relation: delegated::ChildRelation = serde_json::from_str(&body)?;
            let (continued_cursor, continued_by_thread_id) = match continued {
                Some(raw) => {
                    let (cursor, sender): (u64, Option<String>) = serde_json::from_str(&raw)?;
                    (Some(cursor), sender)
                }
                None => (None, None),
            };
            delegations.push(AttentionDelegation {
                operation_id: relation.operation_id,
                parent_thread_id: relation.parent_thread_id,
                parent_branch_id: relation.parent_branch_id,
                parent_run_id: relation.parent_run_id,
                child_thread_id: relation.child_thread_id,
                child_branch_id: relation.child_branch_id,
                accepted_cursor,
                continued_cursor,
                continued_by_thread_id,
                report_cursor,
                report_outcome,
            });
        }
        // A Bot's explicit follow of an ordinary task, from the matters owner. Only displayed
        // branches matter; the relation is never folded into dispatch.
        let bot_ids = branches
            .values()
            .filter_map(|b| b.bot_id.clone())
            .chain(db.prepare("SELECT DISTINCT bot_id FROM bot_thread_bindings")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?)
            .collect::<BTreeSet<_>>();
        let mut follows = Vec::new();
        for bot_id in bot_ids {
            check(cancel)?;
            for matter in bot_work::matters(&db, &bot_id)? {
                if matter.archived {
                    continue;
                }
                for link in matter.threads {
                    if branches.contains_key(&link.branch_id) {
                        follows.push(AttentionFollow {
                            bot_id: bot_id.clone(),
                            matter_id: matter.id.clone(),
                            thread_id: link.thread_id,
                            branch_id: link.branch_id,
                        });
                    }
                }
            }
        }
        items.retain(|i| branches.contains_key(&i.branch_id));
        items.sort_by(|a, b| a.key.cmp(&b.key));
        let counts = AttentionCounts {
            action_required: items.iter().filter(|i| i.actionable).count(),
            affected_branches: items
                .iter()
                .filter(|i| i.actionable)
                .map(|i| (&i.thread_id, &i.branch_id))
                .collect::<BTreeSet<_>>()
                .len(),
            unknown_effects: items.iter().filter(|i| i.kind == "effect_unknown").count(),
        };
        check(cancel)?;
        history_views::current_history_owner(&self.database, self.epoch)?;
        Ok(AttentionSnapshot {
            epoch,
            event_cursor,
            coverage: AttentionCoverage {
                native: "complete",
                external: "unsupported",
                scope: "host",
            },
            branches: branches.into_values().collect(),
            items,
            team_executions,
            delegations,
            follows,
            counts,
        })
    }
}
