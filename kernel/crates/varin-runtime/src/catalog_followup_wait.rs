//! Optional observation is separate from registration and original occurrence delivery.
use super::*;
pub const PREFIX: &str = "followup-observation:";
pub const EVENT: &str = "followup.observed";
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FollowupObservationState {
    Waiting,
    Triggered,
    Cancelled,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FollowupObservation {
    pub wait_id: String,
    pub operation_id: String,
    pub run_id: String,
    pub state: FollowupObservationState,
    pub delivered: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct ObservationResult {
    followup_id: String,
    occurrence_id: Option<String>,
    wait_id: String,
    state: FollowupObservationState,
}
fn state(w: &Wait) -> FollowupObservationState {
    if w.cancelled {
        FollowupObservationState::Cancelled
    } else if w.trigger_cursor.is_some() {
        FollowupObservationState::Triggered
    } else {
        FollowupObservationState::Waiting
    }
}
pub(super) fn project(db: &Connection, id: &str) -> Result<FollowupObservation> {
    let w: Wait = record(db, "waits", &format!("{PREFIX}{id}"))?;
    let delivered = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM history WHERE id=?1)",
        [format!("followup-observation-result:{}", w.id)],
        |r| r.get(0),
    )?;
    Ok(FollowupObservation {
        wait_id: w.id.clone(),
        operation_id: id.into(),
        run_id: w.run_id.clone(),
        state: state(&w),
        delivered,
    })
}
pub(super) fn register(tx: &Transaction<'_>, op: &mut Operation, d: &Definition) -> Result<()> {
    let cursor = tx
        .query_row(
            "SELECT cursor FROM events WHERE subject=?1 AND kind=?2 ORDER BY cursor LIMIT 1",
            params![d.id, EVENT],
            |r| read_number(r, 0),
        )
        .optional()?;
    let w = Wait {
        id: format!("{PREFIX}{}", op.id),
        run_id: op.run_id.clone(),
        subject: d.id.clone(),
        kind: EVENT.into(),
        after_cursor: d.wait.after_cursor,
        deadline_at_ms: None,
        trigger_cursor: cursor,
        cancelled: false,
    };
    tx.execute(
        "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
        params![w.id, w.run_id, encode(&w)?],
    )?;
    if let Some(c) = cursor {
        Catalog::enqueue_resume(tx, &w, c)?;
    }
    event(tx, &w.id, 1, "wait.registered", serde_json::to_value(&w)?)?;
    op.phase = OperationPhase::Waiting;
    op.waiting_on = Some(w.id.clone());
    op.handed_off = true;
    op.result = Some(OperationResultMetadata::Control {
        value: json!({"followup_id":d.id,"wait_id":w.id}),
    });
    Ok(())
}
pub(super) fn cancel_definition(tx: &Transaction<'_>, d: &Definition) -> Result<()> {
    let Some(id) = &d.observation_operation_id else {
        return Ok(());
    };
    let mut w: Wait = record(tx, "waits", &format!("{PREFIX}{id}"))?;
    if w.trigger_cursor.is_none() && !w.cancelled {
        w.cancelled = true;
        put(tx, "waits", &w.id, &w)?;
        event(tx, &w.id, 2, "wait.cancelled", Value::Null)?;
    }
    Ok(())
}
pub(in crate::catalog) fn pending_cancelled(db: &Connection, r: &Run, w: &Wait) -> Result<bool> {
    let Some(id) = w.id.strip_prefix(PREFIX) else {
        return Ok(false);
    };
    let Some(o) = optional_record::<Operation>(db, "operations", id)? else {
        return Ok(false);
    };
    Ok(w.cancelled
        && w.run_id == r.id
        && w.kind == EVENT
        && o.run_id == r.id
        && o.epoch == r.epoch
        && o.executor.as_deref() == Some(TOOL)
        && o.execution_owner == Some(ExecutorOwner::Kernel)
        && o.phase == OperationPhase::Waiting
        && o.handed_off
        && o.waiting_on.as_deref() == Some(&w.id)
        && matches!(&o.call_completion,Some(result_content::ToolCompletionMetadata::JobAccepted{operation_id,phase,effect:Effect::Confirmed,lifetime:Lifetime::Thread}) if operation_id==id && phase=="awaiting_followup"))
}
fn result(db: &Connection, w: &Wait) -> Result<ObservationResult> {
    Ok(ObservationResult {
        followup_id: w.subject.clone(),
        occurrence_id: occurrence(db, &w.subject)?.map(|v| v.id),
        wait_id: w.id.clone(),
        state: state(w),
    })
}
pub struct FollowupWaitPreparation {
    run: Run,
    op: Operation,
    wait: Wait,
    head: Option<String>,
    result: ObservationResult,
    epoch: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedFollowupWait {
    capture: FollowupWaitPreparation,
    history: Value,
}
impl FollowupWaitPreparation {
    pub fn load(self) -> Result<PreparedFollowupWait> {
        let item=ConversationItem{resource_activation:None,id:format!("followup-observation-result:{}",self.wait.id),provenance:Provenance::EnvironmentFact{event_id:self.wait.id.clone()},content:Content::Text{text:format!("This follow-up observation ended. The original registered instruction is delivered separately through its occurrence. Ending observation does not cancel the definition or stop its process. Do not register the same intent again merely because observation ended.\n{}",serde_json::to_string(&self.result)?)},opaque:None};
        let history = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        Ok(PreparedFollowupWait {
            capture: self,
            history,
        })
    }
}
impl Catalog {
    pub fn cancel_followup_observation(&mut self, id: &str) -> Result<Operation> {
        self.reconcile_waits()?;
        let tx = self.db.transaction()?;
        let mut o: Operation = record(&tx, "operations", id)?;
        let wid = format!("{PREFIX}{id}");
        if o.executor.as_deref() != Some(TOOL)
            || o.execution_owner != Some(ExecutorOwner::Kernel)
            || o.waiting_on.as_deref() != Some(&wid)
        {
            return Err(RuntimeError::Invalid(
                "Operation is not a follow-up observation".into(),
            ));
        }
        if o.phase == OperationPhase::Terminal {
            return Ok(o);
        }
        let mut w: Wait = record(&tx, "waits", &wid)?;
        if w.trigger_cursor.is_none() && !w.cancelled {
            w.cancelled = true;
            put(&tx, "waits", &w.id, &w)?;
            event(&tx, &w.id, 2, "wait.cancelled", Value::Null)?;
            o.cancel_requested = true;
            o.revision += 1;
            put(&tx, "operations", id, &o)?;
            event(
                &tx,
                id,
                o.revision,
                "operation.cancel_requested",
                Value::Null,
            )?;
        }
        tx.commit()?;
        Ok(o)
    }
    pub fn capture_followup_waits(&mut self) -> Result<Vec<FollowupWaitPreparation>> {
        let mut out = vec![];
        for o in observations::operations(&self.db, None)? {
            if o.executor.as_deref() != Some(TOOL) {
                continue;
            }
            let mut w: Wait = record(
                &self.db,
                "waits",
                o.waiting_on.as_deref().expect("observation"),
            )?;
            if o.cancel_requested && w.trigger_cursor.is_none() && !w.cancelled {
                self.cancel_followup_observation(&o.id)?;
                w = record(&self.db, "waits", &w.id)?;
            }
            let mut o = self.operation(&o.id)?;
            let r = self.run(&o.run_id)?;
            if r.state.terminal() {
                let tx = self.db.transaction()?;
                if w.trigger_cursor.is_none() {
                    w.cancelled = true;
                    put(&tx, "waits", &w.id, &w)?;
                }
                let value = result(&tx, &w)?;
                o.phase = OperationPhase::Terminal;
                o.effect = Effect::Confirmed;
                o.outcome = Some(if value.state == FollowupObservationState::Cancelled {
                    Outcome::Cancelled
                } else {
                    Outcome::Succeeded
                });
                o.revision += 1;
                o.result = Some(OperationResultMetadata::Control {
                    value: serde_json::to_value(value)?,
                });
                put(&tx, "operations", &o.id, &o)?;
                tx.execute(
                    "DELETE FROM resource_occupancy WHERE operation_id=?1",
                    [&o.id],
                )?;
                event(
                    &tx,
                    &o.id,
                    o.revision,
                    "operation.settled",
                    serde_json::to_value(&o)?,
                )?;
                tx.commit()?;
                self.resource_admission.release(&o.id);
                continue;
            }
            if r.state != RunState::Waiting
                || r.cancel_requested
                || r.waiting_on.as_deref() != Some(&w.id)
                || state(&w) == FollowupObservationState::Waiting
            {
                continue;
            }
            let unresolved:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls t JOIN model_steps m ON m.id=t.request_id WHERE m.run_id=?1 AND t.committed=0)",[&r.id],|r|r.get(0))?;
            if unresolved || !result_content::job_acceptance_consumed(&self.db, &o)? {
                continue;
            }
            out.push(FollowupWaitPreparation {
                head: self.head(&r.branch_id)?,
                result: result(&self.db, &w)?,
                run: r,
                op: o,
                wait: w,
                epoch: self.epoch,
                content: self.content.clone(),
                _publication: self.content.begin_publication(),
            });
        }
        Ok(out)
    }
    pub fn admit_followup_wait(&mut self, p: PreparedFollowupWait) -> Result<bool> {
        let c = p.capture;
        if c.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "follow-up observation owner changed".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut r: Run = record(&tx, "runs", &c.run.id)?;
        let mut o: Operation = record(&tx, "operations", &c.op.id)?;
        let mut w: Wait = record(&tx, "waits", &c.wait.id)?;
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&r.branch_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if r != c.run
            || o != c.op
            || w != c.wait
            || head != c.head
            || active.as_deref() != Some(&r.id)
            || !result_content::job_acceptance_consumed(&tx, &o)?
        {
            return Ok(false);
        }
        let item = HistoryItem {
            run_id: r.id.clone(),
            id: format!("followup-observation-result:{}", w.id),
            thread_id: r.thread_id.clone(),
            parent: head,
            source: HistorySource::Environment,
            content: p.history,
            provider: None,
        };
        tx.execute(
            "INSERT INTO history(id,thread_id,parent,run_id,body) VALUES(?1,?2,?3,?4,?5)",
            params![
                item.id,
                item.thread_id,
                item.parent,
                item.run_id,
                encode(&item)?
            ],
        )?;
        tx.execute(
            "UPDATE branches SET head=?2 WHERE id=?1",
            params![r.branch_id, item.id],
        )?;
        o.phase = OperationPhase::Terminal;
        o.effect = Effect::Confirmed;
        o.outcome = Some(if c.result.state == FollowupObservationState::Cancelled {
            Outcome::Cancelled
        } else {
            Outcome::Succeeded
        });
        o.result = Some(OperationResultMetadata::Control {
            value: serde_json::to_value(c.result)?,
        });
        o.revision += 1;
        put(&tx, "operations", &o.id, &o)?;
        tx.execute(
            "DELETE FROM resource_occupancy WHERE operation_id=?1",
            [&o.id],
        )?;
        let cursor = event(
            &tx,
            &o.id,
            o.revision,
            "operation.settled",
            serde_json::to_value(&o)?,
        )?;
        if w.trigger_cursor.is_none() {
            w.trigger_cursor = Some(cursor);
            put(&tx, "waits", &w.id, &w)?;
        }
        tx.execute("INSERT INTO resumptions(wait_id,run_id,trigger_cursor,claimed,acknowledged) VALUES(?1,?2,?3,1,1) ON CONFLICT(wait_id) DO UPDATE SET claimed=1,acknowledged=1",params![w.id,r.id,sql_number(w.trigger_cursor.unwrap_or(cursor))?])?;
        observations::advance(&tx, &mut r)?;
        tx.commit()?;
        self.resource_admission.release(&o.id);
        Ok(true)
    }
}
pub fn deliver_waits(catalog: &Mutex<Catalog>) -> Result<Vec<String>> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))
    };
    let mut failure = None;
    let captures = lock()?.capture_followup_waits()?;
    for c in captures {
        match c.load() {
            Ok(p) => {
                if let Err(e) = lock()?.admit_followup_wait(p) {
                    failure.get_or_insert(e);
                }
            }
            Err(e) => {
                failure.get_or_insert(e);
            }
        }
    }
    if let Some(e) = failure {
        Err(e)
    } else {
        Ok(vec![])
    }
}
