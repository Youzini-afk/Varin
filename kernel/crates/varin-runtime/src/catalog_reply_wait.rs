//! A send observation refers to the accepted message and original ingress history only.
use super::*;
use crate::catalog::observations;
use crate::execution::{Content, ConversationItem, Provenance};
pub const PREFIX: &str = "reply-wait:";
pub const REPLY_EVENT: &str = "message.reply_received";
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReplyWaitState {
    Waiting,
    Replied,
    Expired,
    Cancelled,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplyWaitView {
    pub wait_id: String,
    pub operation_id: String,
    pub run_id: String,
    pub deadline_at_ms: Option<u64>,
    pub state: ReplyWaitState,
    pub reply_message_id: Option<String>,
    pub delivered: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReplyObservationResult {
    pub message_id: String,
    pub wait_id: String,
    pub deadline_at_ms: Option<u64>,
    pub state: ReplyWaitState,
    pub reply_message_id: Option<String>,
    pub pending_message_ids: Vec<String>,
}
fn result(db: &Connection, wait: &Wait) -> Result<(ReplyWaitState, Option<String>)> {
    if let Some(cursor) = wait.trigger_cursor {
        let (kind, raw): (String, String) = db.query_row(
            "SELECT kind,data FROM events WHERE cursor=?1",
            [sql_number(cursor)?],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if kind == REPLY_EVENT {
            let data: Value = serde_json::from_str(&raw)?;
            return Ok((
                ReplyWaitState::Replied,
                Some(
                    data.get("reply_message_id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            RuntimeError::Invalid("reply trigger identity missing".into())
                        })?
                        .into(),
                ),
            ));
        }
        if kind == "wait.expired" {
            return Ok((ReplyWaitState::Expired, None));
        }
    }
    if wait.cancelled {
        Ok((ReplyWaitState::Cancelled, None))
    } else {
        Ok((ReplyWaitState::Waiting, None))
    }
}
pub(in crate::catalog) fn project(
    db: &Connection,
    identity: &MessageIdentity,
) -> Result<Option<ReplyWaitView>> {
    let MessageActor::Agent {
        operation_id,
        run_id,
        ..
    } = &identity.actor
    else {
        return Ok(None);
    };
    let Some(wait) = optional_record::<Wait>(db, "waits", &format!("{PREFIX}{operation_id}"))?
    else {
        return Ok(None);
    };
    if wait.subject != identity.message_id || wait.run_id != *run_id || wait.kind != REPLY_EVENT {
        return Err(RuntimeError::Invalid(
            "message observation identity changed".into(),
        ));
    }
    let delivered: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM history WHERE id=?1)",
        [format!("reply-observation:{}", wait.id)],
        |r| r.get(0),
    )?;
    let (state, reply_message_id) = result(db, &wait)?;
    Ok(Some(ReplyWaitView {
        wait_id: wait.id,
        operation_id: operation_id.clone(),
        run_id: run_id.clone(),
        deadline_at_ms: wait.deadline_at_ms,
        state,
        reply_message_id,
        delivered,
    }))
}
pub(in crate::catalog) fn register(
    tx: &Transaction<'_>,
    op: &mut Operation,
    identity: &MessageIdentity,
    cursor: u64,
    deadline: Option<u64>,
    now: u64,
) -> Result<()> {
    let mut wait = Wait {
        id: format!("{PREFIX}{}", op.id),
        run_id: op.run_id.clone(),
        subject: identity.message_id.clone(),
        kind: REPLY_EVENT.into(),
        after_cursor: cursor,
        deadline_at_ms: deadline,
        trigger_cursor: None,
        cancelled: false,
    };
    tx.execute(
        "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
        params![wait.id, wait.run_id, encode(&wait)?],
    )?;
    event(
        tx,
        &wait.id,
        1,
        "wait.registered",
        serde_json::to_value(&wait)?,
    )?;
    resolve(tx, &mut wait, now)?;
    op.phase = OperationPhase::Waiting;
    op.waiting_on = Some(wait.id.clone());
    op.handed_off = true;
    op.result = Some(OperationResultMetadata::Control {
        value: json!({"message_id":identity.message_id,"wait_id":wait.id,"deadline_at_ms":deadline}),
    });
    Ok(())
}
/// The caller has authenticated the original reverse route in the same acceptance transaction.
/// This event carries no body. A delayed timer cannot make a late acceptance beat its deadline.
pub(in crate::catalog) fn accepted_reply(
    tx: &Transaction<'_>,
    identity: &MessageIdentity,
    accepted_at_ms: u64,
) -> Result<()> {
    let Some(original) = &identity.reply_to else {
        return Ok(());
    };
    event(
        tx,
        original,
        1,
        REPLY_EVENT,
        json!({"reply_message_id":identity.message_id,"accepted_at_ms":accepted_at_ms}),
    )?;
    let waits = {
        let mut q=tx.prepare("SELECT body FROM waits WHERE json_extract(body,'$.subject')=?1 AND json_extract(body,'$.kind')=?2")?;
        let rows = q
            .query_map(params![original, REPLY_EVENT], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for raw in waits {
        let mut wait: Wait = serde_json::from_str(&raw)?;
        resolve(tx, &mut wait, accepted_at_ms)?;
    }
    Ok(())
}
pub(in crate::catalog) fn resolve(tx: &Transaction<'_>, wait: &mut Wait, now: u64) -> Result<bool> {
    if wait.cancelled || wait.trigger_cursor.is_some() {
        return Ok(false);
    }
    let run: Run = record(tx, "runs", &wait.run_id)?;
    if run.cancel_requested || run.state.terminal() {
        return Ok(false);
    }
    let cursor:Option<u64>=tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind=?2 AND cursor>?3 AND (?4 IS NULL OR json_extract(data,'$.accepted_at_ms')<?4) ORDER BY cursor LIMIT 1",params![wait.subject,REPLY_EVENT,sql_number(wait.after_cursor)?,wait.deadline_at_ms.map(sql_number).transpose()?],|r|read_number(r,0)).optional()?;
    let cursor = if let Some(cursor) = cursor {
        Some(cursor)
    } else if wait.deadline_at_ms.is_some_and(|at| now >= at) {
        Some(event(
            tx,
            &wait.id,
            2,
            "wait.expired",
            json!({"deadline_at_ms":wait.deadline_at_ms,"observed_at_ms":now}),
        )?)
    } else {
        None
    };
    if let Some(cursor) = cursor {
        wait.trigger_cursor = Some(cursor);
        put(tx, "waits", &wait.id, wait)?;
        Catalog::enqueue_resume(tx, wait, cursor)?;
        event(tx, &wait.id, 2, "wait.triggered", json!({"cursor":cursor}))?;
        return Ok(true);
    }
    Ok(false)
}
pub(in crate::catalog) fn pending_cancelled(
    db: &Connection,
    run: &Run,
    wait: &Wait,
) -> Result<bool> {
    let Some(id) = wait.id.strip_prefix(PREFIX) else {
        return Ok(false);
    };
    let Some(op) = optional_record::<Operation>(db, "operations", id)? else {
        return Ok(false);
    };
    Ok(wait.cancelled
        && wait.run_id == run.id
        && wait.kind == REPLY_EVENT
        && op.run_id == run.id
        && op.epoch == run.epoch
        && op.executor.as_deref() == Some(SEND_TOOL)
        && op.execution_owner == Some(ExecutorOwner::Kernel)
        && op.phase == OperationPhase::Waiting
        && op.handed_off
        && op.waiting_on.as_deref() == Some(&wait.id)
        && matches!(&op.call_completion,Some(super::super::result_content::ToolCompletionMetadata::JobAccepted{operation_id,phase,effect:Effect::Confirmed,lifetime:Lifetime::Thread}) if operation_id==id && phase=="awaiting_reply"))
}
impl Catalog {
    pub fn cancel_reply_wait(&mut self, operation_id: &str) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let id = format!("{PREFIX}{operation_id}");
        if op.executor.as_deref() != Some(SEND_TOOL)
            || op.execution_owner != Some(ExecutorOwner::Kernel)
            || op.waiting_on.as_deref() != Some(&id)
        {
            return Err(RuntimeError::Invalid(
                "operation is not a reply observation".into(),
            ));
        }
        if op.phase == OperationPhase::Terminal {
            return Ok(op);
        }
        let mut wait: Wait = record(&tx, "waits", &id)?;
        resolve(&tx, &mut wait, observations::wall_time_ms()?)?;
        if wait.trigger_cursor.is_none() && !wait.cancelled {
            wait.cancelled = true;
            put(&tx, "waits", &id, &wait)?;
            event(&tx, &id, 2, "wait.cancelled", Value::Null)?;
            op.cancel_requested = true;
            op.revision += 1;
            put(&tx, "operations", operation_id, &op)?;
            event(
                &tx,
                operation_id,
                op.revision,
                "operation.cancel_requested",
                Value::Null,
            )?;
        }
        tx.commit()?;
        Ok(op)
    }
    fn close_finished_reply_waits(&mut self) -> Result<()> {
        let tx = self.db.transaction()?;
        let mut released = Vec::new();
        for mut op in observations::operations(&tx, None)? {
            if op.executor.as_deref() != Some(SEND_TOOL) {
                continue;
            }
            let run: Run = record(&tx, "runs", &op.run_id)?;
            if !run.state.terminal() {
                continue;
            }
            let mut wait: Wait =
                record(&tx, "waits", op.waiting_on.as_deref().expect("observation"))?;
            if wait.trigger_cursor.is_none() {
                wait.cancelled = true;
                put(&tx, "waits", &wait.id, &wait)?;
            }
            let (state, reply_message_id) = result(&tx, &wait)?;
            op.phase = OperationPhase::Terminal;
            op.effect = Effect::Confirmed;
            op.outcome = Some(if state == ReplyWaitState::Cancelled {
                Outcome::Cancelled
            } else {
                Outcome::Succeeded
            });
            op.cancel_requested |= state == ReplyWaitState::Cancelled;
            op.revision += 1;
            op.result = Some(OperationResultMetadata::Control {
                value: serde_json::to_value(ReplyObservationResult {
                    message_id: wait.subject.clone(),
                    wait_id: wait.id.clone(),
                    deadline_at_ms: wait.deadline_at_ms,
                    state,
                    reply_message_id,
                    pending_message_ids: Vec::new(),
                })?,
            });
            put(&tx, "operations", &op.id, &op)?;
            tx.execute(
                "DELETE FROM resource_occupancy WHERE operation_id=?1",
                [&op.id],
            )?;
            event(
                &tx,
                &op.id,
                op.revision,
                "operation.settled",
                serde_json::to_value(&op)?,
            )?;
            released.push(op.id);
        }
        tx.commit()?;
        for id in released {
            self.resource_admission.release(&id);
        }
        Ok(())
    }
    pub fn capture_reply_waits(&mut self) -> Result<Vec<ReplyWaitPreparation>> {
        self.close_finished_reply_waits()?;
        let mut out = Vec::new();
        for op in observations::operations(&self.db, None)? {
            if op.executor.as_deref() != Some(SEND_TOOL) {
                continue;
            }
            let mut wait: Wait = record(
                &self.db,
                "waits",
                op.waiting_on.as_deref().expect("observation"),
            )?;
            if op.cancel_requested && !wait.cancelled && wait.trigger_cursor.is_none() {
                self.cancel_reply_wait(&op.id)?;
                wait = record(&self.db, "waits", &wait.id)?;
            }
            let op = self.operation(&op.id)?;
            let run = self.run(&op.run_id)?;
            if run.state != RunState::Waiting
                || run.cancel_requested
                || run.waiting_on.as_deref() != Some(&wait.id)
            {
                continue;
            }
            let (state, reply_message_id) = result(&self.db, &wait)?;
            if state == ReplyWaitState::Waiting {
                continue;
            }
            let unresolved:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls t JOIN model_steps m ON m.id=t.request_id WHERE m.run_id=?1 AND t.committed=0)",[&run.id],|r|r.get(0))?;
            if unresolved || !super::super::result_content::job_acceptance_consumed(&self.db, &op)?
            {
                continue;
            }
            let mut pending_message_ids = Vec::new();
            for other in observations::operations(&self.db, Some(&run.id))? {
                if other.id == op.id || other.executor.as_deref() != Some(SEND_TOOL) {
                    continue;
                }
                let other: Wait = record(
                    &self.db,
                    "waits",
                    other.waiting_on.as_deref().expect("observation"),
                )?;
                if result(&self.db, &other)?.0 == ReplyWaitState::Waiting {
                    pending_message_ids.push(other.subject);
                }
            }
            let result = ReplyObservationResult {
                message_id: wait.subject.clone(),
                wait_id: wait.id.clone(),
                deadline_at_ms: wait.deadline_at_ms,
                state,
                reply_message_id,
                pending_message_ids,
            };
            out.push(ReplyWaitPreparation {
                epoch: self.epoch,
                head: self.head(&run.branch_id)?,
                run,
                wait,
                op,
                result,
                content: self.content.clone(),
                _publication: self.content.begin_publication(),
            });
        }
        Ok(out)
    }
    pub fn admit_reply_wait(&mut self, prepared: PreparedReplyWait) -> Result<bool> {
        let PreparedReplyWait {
            capture,
            history_ref,
        } = prepared;
        if capture.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "reply delivery owner changed".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", &capture.run.id)?;
        let mut op: Operation = record(&tx, "operations", &capture.op.id)?;
        let mut wait: Wait = record(&tx, "waits", &capture.wait.id)?;
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if run != capture.run
            || op != capture.op
            || wait != capture.wait
            || head != capture.head
            || active.as_deref() != Some(&run.id)
            || !super::super::result_content::job_acceptance_consumed(&tx, &op)?
        {
            return Ok(false);
        }
        let item_id = format!("reply-observation:{}", wait.id);
        let item = HistoryItem {
            run_id: run.id.clone(),
            id: item_id.clone(),
            thread_id: run.thread_id.clone(),
            parent: head,
            source: HistorySource::Environment,
            content: history_ref,
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
            params![run.branch_id, item_id],
        )?;
        op.phase = OperationPhase::Terminal;
        op.effect = Effect::Confirmed;
        op.outcome = Some(if capture.result.state == ReplyWaitState::Cancelled {
            Outcome::Cancelled
        } else {
            Outcome::Succeeded
        });
        op.result = Some(OperationResultMetadata::Control {
            value: serde_json::to_value(&capture.result)?,
        });
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        tx.execute(
            "DELETE FROM resource_occupancy WHERE operation_id=?1",
            [&op.id],
        )?;
        let cursor = event(
            &tx,
            &op.id,
            op.revision,
            "operation.settled",
            serde_json::to_value(&op)?,
        )?;
        wait.trigger_cursor = Some(wait.trigger_cursor.unwrap_or(cursor));
        put(&tx, "waits", &wait.id, &wait)?;
        Self::enqueue_resume(&tx, &wait, wait.trigger_cursor.expect("terminal cursor"))?;
        tx.execute(
            "UPDATE resumptions SET claimed=?2,acknowledged=1 WHERE wait_id=?1",
            params![wait.id, sql_number(run.epoch)?],
        )?;
        observations::advance(&tx, &mut run)?;
        event(
            &tx,
            &run.id,
            run.revision,
            "message.wait_delivered",
            json!({"message_id":wait.subject,"wait_id":wait.id,"history_id":item_id}),
        )?;
        tx.commit()?;
        self.resource_admission.release(&op.id);
        Ok(true)
    }
}
pub struct ReplyWaitPreparation {
    epoch: u64,
    run: Run,
    head: Option<String>,
    wait: Wait,
    op: Operation,
    result: ReplyObservationResult,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedReplyWait {
    capture: ReplyWaitPreparation,
    history_ref: Value,
}
impl ReplyWaitPreparation {
    pub fn load(self) -> Result<PreparedReplyWait> {
        let item=ConversationItem{resource_activation:None,id:format!("reply-observation:{}",self.wait.id),provenance:Provenance::EnvironmentFact{event_id:self.wait.id.clone()},content:Content::Text{text:format!("This message observation ended; this is lifecycle data, not a new instruction. The original message remains sent. Reuse the original message IDs if further work is needed; do not resend merely because observation expired or ended. A reply body is delivered only through the original incoming message history.\n{}",serde_json::to_string(&self.result)?)},opaque:None};
        let history_ref = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        Ok(PreparedReplyWait {
            capture: self,
            history_ref,
        })
    }
}
pub fn deliver_waits(catalog: &std::sync::Mutex<Catalog>) -> Result<Vec<String>> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))
    };
    loop {
        let captures = lock()?.capture_reply_waits()?;
        if captures.is_empty() {
            break;
        }
        for capture in captures {
            let prepared = capture.load()?;
            lock()?.admit_reply_wait(prepared)?;
        }
    }
    lock()?.pending_observation_continuations()
}
