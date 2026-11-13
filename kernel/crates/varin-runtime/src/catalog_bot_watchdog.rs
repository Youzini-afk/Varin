//! Inactivity is an attention event, independent of the original execution's outcome.
use super::*;

impl Catalog {
    pub fn configure_bot_inactivity(&mut self, minutes: i64) -> Result<()> {
        let minutes = u64::try_from(minutes)
            .map_err(|_| RuntimeError::Invalid("Inactivity minutes must be nonnegative".into()))?;
        let previous: Option<u64> = self.db.query_row(
            "SELECT json_extract(data,'$.minutes') FROM events WHERE subject='bot-inactivity' AND kind='bot.inactivity_configured' ORDER BY cursor DESC LIMIT 1",
            [], |row| read_number(row,0)).optional()?;
        if previous == Some(minutes) {
            return Ok(());
        }
        let tx = self.db.transaction()?;
        event(
            &tx,
            "bot-inactivity",
            1,
            "bot.inactivity_configured",
            json!({"minutes":minutes,"atMs":observations::wall_time_ms()?}),
        )?;
        tx.commit()?;
        Ok(())
    }

    fn bot_inactivity_timeout(&self) -> Result<u64> {
        let minutes = self.db.query_row("SELECT json_extract(data,'$.minutes') FROM events WHERE subject='bot-inactivity' AND kind='bot.inactivity_configured' ORDER BY cursor DESC LIMIT 1",[],|row|read_number(row,0)).optional()?;
        Ok(minutes.unwrap_or(20).saturating_mul(60_000))
    }

    fn bot_inactivity_candidates(&self) -> Result<Vec<(Run, u64, u64)>> {
        let timeout = self.bot_inactivity_timeout()?;
        if timeout == 0 {
            return Ok(vec![]);
        }
        let mut candidates = Vec::new();
        let mut query = self.db.prepare("SELECT body FROM runs WHERE json_extract(body,'$.state') IN ('generating','executing') AND json_extract(body,'$.cancel_requested')=0")?;
        for row in query.query_map([], |row| row.get::<_, String>(0))? {
            let run: Run = serde_json::from_str(&row?)?;
            if bot_work_events::targets(&self.db, &run.thread_id, &run.branch_id)?.is_empty() {
                continue;
            }
            let activity: Option<(u64,u64)> = self.db.query_row(
                "SELECT cursor,json_extract(data,'$.atMs') FROM events WHERE subject=?1 AND kind='execution.committed' AND json_extract(data,'$.kind') IN ('model_dispatched','tool_dispatched') AND json_extract(data,'$.atMs') IS NOT NULL ORDER BY cursor DESC LIMIT 1",
                [&run.id], |row| Ok((read_number(row,0)?,read_number(row,1)?))).optional()?;
            let Some((cursor, at)) = activity else {
                continue;
            };
            let notified: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE kind='bot.work_pending' AND coalesce(json_extract(data,'$.sourceRunId'),json_extract(data,'$.operationId'))=?1 AND json_extract(data,'$.activityCursor')=?2 AND json_extract(data,'$.reason')='inactivity')",params![run.id,sql_number(cursor)?],|row|row.get(0))?;
            if !notified {
                candidates.push((run, cursor, at.saturating_add(timeout)));
            }
        }
        Ok(candidates)
    }

    pub fn nearest_bot_inactivity_deadline(&self) -> Result<Option<u64>> {
        Ok(self
            .bot_inactivity_candidates()?
            .into_iter()
            .map(|(_, _, deadline)| deadline)
            .chain(
                self.external_inactivity_candidates()?
                    .into_iter()
                    .map(|(_, _, deadline)| deadline),
            )
            .min())
    }

    pub fn reconcile_bot_inactivity_at(&mut self, now: u64) -> Result<()> {
        let candidates = self.bot_inactivity_candidates()?;
        let external = self.external_inactivity_candidates()?;
        let tx = self.db.transaction()?;
        for (run, cursor, deadline) in candidates {
            if now >= deadline {
                bot_work_events::attention(&tx, &run, "inactivity", None, Some(cursor), now)?;
            }
        }
        for (child, cursor, deadline) in external {
            if now >= deadline {
                event(
                    &tx,
                    "bot-work-pending",
                    child.revision,
                    "bot.work_pending",
                    json!({"kind":"external_attention",
                    "targetThreadId":child.parent_thread_id,"targetBranchId":child.parent_branch_id,
                    "operationId":child.operation_id,"activityCursor":cursor,"atMs":now}),
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn external_inactivity_candidates(
        &self,
    ) -> Result<Vec<(super::external_children::ExternalChild, u64, u64)>> {
        let timeout = self.bot_inactivity_timeout()?;
        if timeout == 0 {
            return Ok(vec![]);
        }
        let mut result = Vec::new();
        let mut q=self.db.prepare("SELECT c.body FROM external_children c JOIN external_turns t ON t.id=json_extract(c.body,'$.turn_id') WHERE json_extract(c.body,'$.report') IS NULL AND json_extract(c.body,'$.cancel_requested')=0 AND json_extract(t.body,'$.status')='running'")?;
        for row in q.query_map([], |row| row.get::<_, String>(0))? {
            let child: super::external_children::ExternalChild = serde_json::from_str(&row?)?;
            if super::bot::thread_bot(&self.db, &child.parent_thread_id)?.is_none() {
                continue;
            }
            let parent = self.run(&child.parent_run_id)?;
            if parent.cancel_requested || parent.state == RunState::Cancelled {
                continue;
            }
            let activity:Option<(u64,u64)>=self.db.query_row("SELECT cursor,json_extract(data,'$.atMs') FROM events WHERE subject=?1 AND kind='external.execution_activity' ORDER BY cursor DESC LIMIT 1",[child.turn_id.as_deref().unwrap_or_default()],|row|Ok((read_number(row,0)?,read_number(row,1)?))).optional()?;
            let Some((cursor, at)) = activity else {
                continue;
            };
            let notified:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE kind='bot.work_pending' AND json_extract(data,'$.kind')='external_attention' AND coalesce(json_extract(data,'$.sourceRunId'),json_extract(data,'$.operationId'))=?1 AND json_extract(data,'$.activityCursor')=?2)",params![child.operation_id,sql_number(cursor)?],|row|row.get(0))?;
            if !notified {
                result.push((child, cursor, at.saturating_add(timeout)));
            }
        }
        Ok(result)
    }
}
