//! BotService owns Bot identity and activity. Catalog stores only its execution gate
//! projection and control references on the original Threads and Runs.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotGate {
    pub bot_id: String,
    pub profile_revision: u64,
    pub activity_operation_id: Option<String>,
    pub permitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotSuspension {
    pub bot_id: String,
    pub activity_operation_id: String,
    pub profile_revision: u64,
}

/// The stop token is physical cancellation. Its business meaning comes from the
/// original Run control, never from clearing or restoring `cancel_requested`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunStopReason {
    Cancel,
    BotSuspension(BotSuspension),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotScopeCapture {
    pub kernel_epoch: u64,
    pub suspension: BotSuspension,
    pub run_ids: Vec<String>,
    pub operation_ids: Vec<String>,
}

/// Only current Rust worker ownership is inspected here. Host preparation, memory
/// mutations, Computer guests and old executor epochs require their original owners.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotKernelScopeStatus {
    pub suspension: BotSuspension,
    pub kernel_epoch: u64,
    pub source_profile_revision: Option<u64>,
    pub current_kernel_workers_drained: bool,
    pub unproven_operation_stop_ids: Vec<String>,
    pub unknown_effect_operation_ids: Vec<String>,
    pub unresolved_model_request_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotScopeResume {
    pub resumed_run_ids: Vec<String>,
    pub blocked_run_ids: Vec<String>,
}

pub(super) fn initialize_new(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE bot_thread_bindings(thread_id TEXT PRIMARY KEY REFERENCES threads(id),bot_id TEXT NOT NULL);
        CREATE INDEX bot_thread_bindings_bot ON bot_thread_bindings(bot_id);
        CREATE TABLE bot_execution_gates(bot_id TEXT PRIMARY KEY,profile_revision INTEGER NOT NULL,kernel_epoch INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE TABLE bot_run_holds(run_id TEXT PRIMARY KEY REFERENCES runs(id),bot_id TEXT NOT NULL,activity_operation_id TEXT NOT NULL);
        CREATE INDEX bot_run_holds_scope ON bot_run_holds(bot_id,activity_operation_id);
        CREATE INDEX bot_memory_scope ON operations(json_extract(body,'$.intent.kind'),json_extract(body,'$.intent.scopeId'));
        CREATE INDEX bot_child_parent ON child_tasks(json_extract(body,'$.parent_thread_id'));")?;
    Ok(())
}

pub(super) fn check_format(db: &Connection) -> Result<()> {
    db.prepare("SELECT thread_id,bot_id FROM bot_thread_bindings")?;
    db.prepare("SELECT bot_id,profile_revision,kernel_epoch,body FROM bot_execution_gates")?;
    db.prepare("SELECT run_id,bot_id,activity_operation_id FROM bot_run_holds")?;
    Ok(())
}

/// Children and auxiliary work retain their existing relationship owners. An absent
/// Bot binding does not imply that a Thread is a user-facing ordinary main Thread.
pub(super) fn thread_bot(db: &Connection, thread_id: &str) -> Result<Option<String>> {
    let mut current = thread_id.to_owned();
    let mut seen = std::collections::HashSet::new();
    loop {
        if !seen.insert(current.clone()) {
            return Err(RuntimeError::Invalid(
                "Bot execution ancestry is cyclic".into(),
            ));
        }
        let direct: Option<String> = db
            .query_row(
                "SELECT bot_id FROM bot_thread_bindings WHERE thread_id=?1",
                [&current],
                |r| r.get(0),
            )
            .optional()?;
        if direct.is_some() {
            return Ok(direct);
        }
        let parent: Option<String> = db.query_row(
            "SELECT json_extract(body,'$.parent_thread_id') FROM child_tasks WHERE child_thread_id=?1",
            [&current], |r| r.get(0),
        ).optional()?;
        if let Some(parent) = parent {
            current = parent;
            continue;
        }
        // The source branch is authoritative even for an explicit summary without owner_run_id.
        let source: Option<String> = db.query_row(
            "SELECT source.thread_id FROM context_jobs c JOIN runs r ON r.id=c.run_id JOIN branches helper ON helper.id=r.branch_id JOIN branches source ON source.id=c.branch_id WHERE helper.thread_id=?1",
            [&current], |r| r.get(0),
        ).optional()?;
        if let Some(source) = source {
            current = source;
            continue;
        }
        let scope: Option<String> = db.query_row(
            "SELECT json_extract(o.body,'$.intent.scopeId') FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND json_extract(o.body,'$.intent.kind')=?2",
            params![current, super::memory_work::WORK_KIND], |r| r.get(0),
        ).optional()?;
        return scope
            .map(|scope| {
                scope
                    .strip_prefix("bot:")
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        RuntimeError::Invalid("MemoryWork Bot identity is invalid".into())
                    })
            })
            .transpose();
    }
}

pub(super) fn permitted(db: &Connection, bot_id: &str, epoch: u64) -> Result<bool> {
    let row: Option<(u64, String)> = db
        .query_row(
            "SELECT kernel_epoch,body FROM bot_execution_gates WHERE bot_id=?1",
            [bot_id],
            |r| Ok((read_number(r, 0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((published_epoch, body)) = row else {
        return Ok(false);
    };
    let gate: BotGate = serde_json::from_str(&body)?;
    Ok(published_epoch == epoch && gate.permitted)
}

pub(super) fn thread_permitted(db: &Connection, thread_id: &str, epoch: u64) -> Result<bool> {
    thread_bot(db, thread_id)?
        .map(|bot| permitted(db, &bot, epoch))
        .transpose()
        .map(|v| v.unwrap_or(true))
}

pub(super) fn current_epoch(db: &Connection) -> Result<u64> {
    Ok(
        db.query_row("SELECT epoch FROM runtime_meta WHERE id=1", [], |r| {
            read_number(r, 0)
        })?,
    )
}

pub(super) fn run_permitted(db: &Connection, run: &Run) -> Result<bool> {
    let held: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM bot_run_holds WHERE run_id=?1)",
        [&run.id],
        |r| r.get(0),
    )?;
    Ok(!held && thread_permitted(db, &run.thread_id, current_epoch(db)?)?)
}

impl Catalog {
    pub fn bot_for_thread(&self, thread_id: &str) -> Result<Option<String>> {
        thread_bot(&self.db, thread_id)
    }

    pub fn publish_bot_gate(&mut self, gate: BotGate) -> Result<()> {
        if gate.bot_id.trim().is_empty()
            || gate.profile_revision == 0
            || gate
                .activity_operation_id
                .as_ref()
                .is_some_and(|id| id.is_empty())
        {
            return Err(RuntimeError::Invalid(
                "Bot gate requires its original profile revision".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let previous: Option<(u64, String)> = tx
            .query_row(
                "SELECT kernel_epoch,body FROM bot_execution_gates WHERE bot_id=?1",
                [&gate.bot_id],
                |r| Ok((read_number(r, 0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((published_epoch, previous)) = previous {
            let previous: BotGate = serde_json::from_str(&previous)?;
            if previous == gate && published_epoch == self.epoch {
                return Ok(());
            }
            if gate.profile_revision < previous.profile_revision
                || gate.profile_revision == previous.profile_revision && gate != previous
            {
                return Err(RuntimeError::Conflict(
                    "Bot profile gate revision changed".into(),
                ));
            }
        }
        tx.execute("INSERT INTO bot_execution_gates(bot_id,profile_revision,kernel_epoch,body) VALUES(?1,?2,?3,?4) ON CONFLICT(bot_id) DO UPDATE SET profile_revision=excluded.profile_revision,kernel_epoch=excluded.kernel_epoch,body=excluded.body",
            params![gate.bot_id, sql_number(gate.profile_revision)?, sql_number(self.epoch)?, encode(&gate)?])?;
        event(
            &tx,
            &format!("bot:{}", gate.bot_id),
            gate.profile_revision,
            "bot.execution_gate_published",
            json!({"permitted":gate.permitted,"kernelEpoch":self.epoch}),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn create_bot_thread(
        &mut self,
        thread_id: &str,
        branch_id: &str,
        bot_id: &str,
    ) -> Result<()> {
        self.create_thread_with_bot(thread_id, branch_id, Some(bot_id))
    }

    pub fn run_stop_reason(&self, run_id: &str, epoch: u64) -> Result<RunStopReason> {
        let run = self.run(run_id)?;
        if run.epoch != epoch {
            return Err(RuntimeError::Conflict("Run stop owner changed".into()));
        }
        if run.cancel_requested {
            return Ok(RunStopReason::Cancel);
        }
        let held: Option<(String, String, u64)> = self.db.query_row(
            "SELECT h.bot_id,h.activity_operation_id,g.profile_revision FROM bot_run_holds h JOIN bot_execution_gates g ON g.bot_id=h.bot_id WHERE h.run_id=?1", [run_id], |r| Ok((r.get(0)?, r.get(1)?, read_number(r, 2)?)),
        ).optional()?;
        if let Some((bot_id, activity_operation_id, profile_revision)) = held {
            return Ok(RunStopReason::BotSuspension(BotSuspension {
                bot_id,
                activity_operation_id,
                profile_revision,
            }));
        }
        // Gate publication precedes physical worker cancellation. An executor reaching
        // that boundary parks under the same original activity even before scope capture.
        if let Some(bot_id) = thread_bot(&self.db, &run.thread_id)? {
            let gate: Option<String> = self
                .db
                .query_row(
                    "SELECT body FROM bot_execution_gates WHERE bot_id=?1 AND kernel_epoch=?2",
                    params![bot_id, sql_number(self.epoch)?],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(body) = gate {
                let gate: BotGate = serde_json::from_str(&body)?;
                if let Some(activity_operation_id) =
                    gate.activity_operation_id.filter(|_| !gate.permitted)
                {
                    return Ok(RunStopReason::BotSuspension(BotSuspension {
                        bot_id,
                        activity_operation_id,
                        profile_revision: gate.profile_revision,
                    }));
                }
            }
        }
        Ok(RunStopReason::Cancel)
    }

    pub(crate) fn bot_scope_source_revision(
        &self,
        suspension: &BotSuspension,
    ) -> Result<Option<u64>> {
        Ok(self.db.query_row("SELECT profile_revision FROM bot_execution_gates WHERE bot_id=?1 AND kernel_epoch=?2 AND json_extract(body,'$.activityOperationId')=?3", params![suspension.bot_id,sql_number(self.epoch)?,suspension.activity_operation_id], |r|read_number(r,0)).optional()?)
    }

    pub(crate) fn check_bot_scope_gate(
        &self,
        suspension: &BotSuspension,
        permitted: Option<bool>,
    ) -> Result<()> {
        let gate: Option<(u64, String)> = self
            .db
            .query_row(
                "SELECT kernel_epoch,body FROM bot_execution_gates WHERE bot_id=?1",
                [&suspension.bot_id],
                |r| Ok((read_number(r, 0)?, r.get(1)?)),
            )
            .optional()?;
        let (epoch, body) =
            gate.ok_or_else(|| RuntimeError::Conflict("Original Bot gate is unavailable".into()))?;
        let gate: BotGate = serde_json::from_str(&body)?;
        if epoch != self.epoch
            || gate.profile_revision != suspension.profile_revision
            || permitted.is_some_and(|permitted| gate.permitted != permitted)
            || gate.activity_operation_id.as_deref() != Some(&suspension.activity_operation_id)
        {
            return Err(RuntimeError::Conflict(
                "Bot control does not match the current activity gate".into(),
            ));
        }
        Ok(())
    }

    pub fn suspend_bot_scope(&mut self, suspension: BotSuspension) -> Result<BotScopeCapture> {
        self.check_bot_scope_gate(&suspension, Some(false))?;
        let run_ids = self.bot_scope_run_ids(&suspension.bot_id)?;
        let tx = self.db.transaction()?;
        for run_id in &run_ids {
            let previous: Option<String> = tx
                .query_row(
                    "SELECT activity_operation_id FROM bot_run_holds WHERE run_id=?1",
                    [run_id],
                    |r| r.get(0),
                )
                .optional()?;
            if previous
                .as_ref()
                .is_some_and(|id| id != &suspension.activity_operation_id)
            {
                return Err(RuntimeError::Conflict(
                    "Run still belongs to another Bot suspension".into(),
                ));
            }
            tx.execute("INSERT INTO bot_run_holds(run_id,bot_id,activity_operation_id) SELECT id,?2,?3 FROM runs WHERE id=?1 AND json_extract(body,'$.state') NOT IN ('completed','failed','cancelled') AND json_extract(body,'$.cancel_requested')=0 ON CONFLICT(run_id) DO NOTHING",
                params![run_id, suspension.bot_id, suspension.activity_operation_id])?;
        }
        tx.commit()?;
        self.bot_scope_capture(suspension)
    }

    /// Enumerate short references through the original relationship indexes. Historical
    /// configuration and content bodies are never hydrated to discover a Bot's scope.
    pub fn bot_scope_run_ids(&self, bot_id: &str) -> Result<Vec<String>> {
        let mut query = self.db.prepare("WITH RECURSIVE scope(thread_id) AS (
            SELECT thread_id FROM bot_thread_bindings WHERE bot_id=?1
            UNION SELECT b.thread_id FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE json_extract(o.body,'$.intent.kind')=?2 AND json_extract(o.body,'$.intent.scopeId')=?3
            UNION SELECT c.child_thread_id FROM child_tasks c JOIN scope s ON json_extract(c.body,'$.parent_thread_id')=s.thread_id
            UNION SELECT helper.thread_id FROM scope s JOIN branches source ON source.thread_id=s.thread_id JOIN context_jobs c ON c.branch_id=source.id JOIN runs r ON r.id=c.run_id JOIN branches helper ON helper.id=r.branch_id
        ) SELECT r.id FROM scope s JOIN branches b ON b.thread_id=s.thread_id JOIN runs r ON r.branch_id=b.id ORDER BY r.id")?;
        let rows = query.query_map(
            params![
                bot_id,
                super::memory_work::WORK_KIND,
                format!("bot:{bot_id}")
            ],
            |r| r.get::<_, String>(0),
        )?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Park the original Run without consuming a policy checkpoint, cancelling its
    /// durable conditions, or manufacturing completions for an unexecuted tool batch.
    pub fn park_bot_run(&mut self, run_id: &str, epoch: u64) -> Result<Run> {
        let RunStopReason::BotSuspension(suspension) = self.run_stop_reason(run_id, epoch)? else {
            return Err(RuntimeError::Conflict("Run has no Bot suspension".into()));
        };
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO bot_run_holds(run_id,bot_id,activity_operation_id) VALUES(?1,?2,?3) ON CONFLICT(run_id) DO NOTHING", params![run_id,suspension.bot_id,suspension.activity_operation_id])?;
        let mut run: Run = record(&tx, "runs", run_id)?;
        if run.state.terminal() || run.state == RunState::Waiting {
            tx.commit()?;
            return Ok(run);
        }
        let dispatched: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM model_steps WHERE run_id=?1 AND state='dispatched')",
            [run_id],
            |r| r.get(0),
        )?;
        if dispatched {
            return Err(RuntimeError::Conflict(
                "Model executor has not settled its original request".into(),
            ));
        }
        let key = format!("execution-recovery:{run_id}:{epoch}");
        let after_cursor = tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
            read_number(r, 0)
        })?;
        let wait = Wait {
            id: key.clone(),
            run_id: run_id.into(),
            subject: run_id.into(),
            kind: "execution.reconciled".into(),
            after_cursor,
            deadline_at_ms: None,
            trigger_cursor: None,
            cancelled: false,
        };
        tx.execute(
            "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING",
            params![key, run_id, encode(&wait)?],
        )?;
        run.state = RunState::Waiting;
        run.waiting_on = Some(key);
        run.revision += 1;
        put(&tx, "runs", run_id, &run)?;
        event(
            &tx,
            run_id,
            run.revision,
            "run.bot_suspended",
            json!({"waiting_on":run.waiting_on}),
        )?;
        tx.commit()?;
        Ok(run)
    }

    /// Stop evidence and effect outcome are deliberately orthogonal. These queries
    /// read only original short owner/receipt metadata, never tool result content.
    pub(crate) fn record_kernel_operation_worker_stopped(
        &mut self,
        operation_id: &str,
        epoch: u64,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let op: Operation = record(&tx, "operations", operation_id)?;
        super::execution_persistence::record_kernel_executor_stopped(&tx, &op, epoch)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn bot_run_barriers(
        &self,
        run_id: &str,
    ) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
        let mut q = self.db.prepare("SELECT id FROM model_steps WHERE run_id=?1 AND state NOT IN ('prepared','completed','not_dispatched') AND json_extract(body,'$.superseded_by_input') IS NULL ORDER BY id")?;
        let models = q
            .query_map([run_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut q = self.db.prepare("SELECT id FROM operations WHERE run_id=?1 AND json_extract(body,'$.effect')='unknown' ORDER BY id")?;
        let effects = q
            .query_map([run_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut q = self.db.prepare("SELECT o.id FROM operations o WHERE o.run_id=?1 AND json_extract(o.body,'$.execution_owner') IS NOT NULL
          AND NOT (
            (json_extract(o.body,'$.execution_owner.kind')='kernel' AND EXISTS(SELECT 1 FROM events e WHERE e.subject=o.id AND e.kind='operation.kernel_executor_stopped' AND json_extract(e.data,'$.operationEpoch')=json_extract(o.body,'$.epoch')))
            OR coalesce(json_extract(o.body,'$.external_receipt.executor_stopped'),0)=1
            OR coalesce(json_extract(o.body,'$.result.value.receipt.localExecutorStopped'),0)=1
            OR (coalesce(json_extract(o.body,'$.intent.kind'),'')='inference_request_v1' AND coalesce(json_extract(o.body,'$.result.value.dispatched'),1)=0)
            OR (EXISTS(SELECT 1 FROM events e WHERE e.subject=o.id AND e.kind='operation.invocation_executor_stopped' AND json_extract(e.data,'$.operationEpoch')=json_extract(o.body,'$.epoch') AND json_extract(e.data,'$.executionOwner.kind') IS json_extract(o.body,'$.execution_owner.kind') AND json_extract(e.data,'$.executionOwner.identity') IS json_extract(o.body,'$.execution_owner.identity') AND json_extract(e.data,'$.executionOwner.epoch') IS json_extract(o.body,'$.execution_owner.epoch')) AND NOT (json_extract(o.body,'$.execution_owner.kind')='kernel' AND json_extract(o.body,'$.effect')='unknown'))
            OR (coalesce(json_extract(o.body,'$.intent.kind'),'') IN ('memory_work_v1','memory_work_stage_v1') AND json_extract(o.body,'$.phase')='terminal' AND EXISTS(SELECT 1 FROM operations w WHERE w.run_id=o.run_id AND json_extract(w.body,'$.intent.kind')='memory_work_v1' AND (coalesce(json_extract(w.body,'$.result.value.consumed'),0)=1 OR coalesce(json_extract(w.body,'$.result.value.consumerFailed'),0)=1)))
          ) ORDER BY o.id")?;
        let stops = q
            .query_map([run_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok((stops, effects, models))
    }

    pub(crate) fn bot_held_run_ids(&self, suspension: &BotSuspension) -> Result<Vec<String>> {
        let mut q = self.db.prepare("SELECT run_id FROM bot_run_holds WHERE bot_id=?1 AND activity_operation_id=?2 ORDER BY run_id")?;
        let rows = q.query_map(
            params![suspension.bot_id, suspension.activity_operation_id],
            |r| r.get::<_, String>(0),
        )?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub(crate) fn resume_bot_scope(
        &mut self,
        suspension: &BotSuspension,
    ) -> Result<BotScopeResume> {
        self.check_bot_scope_gate(suspension, Some(true))?;
        let held = self.bot_held_run_ids(suspension)?;
        let mut resumed_run_ids = Vec::new();
        let mut blocked_run_ids = Vec::new();
        for run in held {
            let (stops, effects, models) = self.bot_run_barriers(&run)?;
            if stops.is_empty() && effects.is_empty() && models.is_empty() {
                resumed_run_ids.push(run);
            } else {
                blocked_run_ids.push(run);
            }
        }
        let tx = self.db.transaction()?;
        for run in &resumed_run_ids {
            tx.execute("DELETE FROM bot_run_holds WHERE run_id=?1 AND bot_id=?2 AND activity_operation_id=?3", params![run,suspension.bot_id,suspension.activity_operation_id])?;
            event(
                &tx,
                run,
                0,
                "run.bot_suspension_released",
                json!({"botId":suspension.bot_id,"profileRevision":suspension.profile_revision}),
            )?;
        }
        tx.commit()?;
        Ok(BotScopeResume {
            resumed_run_ids,
            blocked_run_ids,
        })
    }

    pub fn bot_scope_capture(&self, suspension: BotSuspension) -> Result<BotScopeCapture> {
        self.check_bot_scope_gate(&suspension, Some(false))?;
        let run_ids = self.bot_scope_run_ids(&suspension.bot_id)?;
        let mut operation_ids = Vec::new();
        let mut captured_runs = Vec::new();
        for run_id in run_ids {
            // Keep terminal Runs with unresolved external executors. A terminal/Unknown
            // Host callback does not certify that its underlying mutation has drained.
            let (ids, _, _) = self.bot_run_barriers(&run_id)?;
            let active: bool = self.db.query_row("SELECT json_extract(body,'$.state') NOT IN ('completed','failed','cancelled') FROM runs WHERE id=?1", [&run_id], |r| r.get(0))?;
            if active || !ids.is_empty() {
                captured_runs.push(run_id);
            }
            operation_ids.extend(ids);
        }
        Ok(BotScopeCapture {
            kernel_epoch: self.epoch,
            suspension,
            run_ids: captured_runs,
            operation_ids,
        })
    }
}
