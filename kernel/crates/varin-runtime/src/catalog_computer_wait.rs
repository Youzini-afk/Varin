//! A durable observation of the original Computer request; cancelling it never revokes an assignment.
use super::*;
use crate::execution::{CompletionKind, Content, ConversationItem, Provenance};
use computer_requests::{ComputerRequestRecord, ComputerRequestStatus};
use std::sync::Mutex;
pub const PREFIX: &str = "computer-request-wait:";
pub const EVENT: &str = "computer.request_decided";
pub(super) fn ready(db: &Connection, wait: &Wait) -> Result<bool> {
    if wait.cancelled {
        return Ok(true);
    }
    let r: ComputerRequestRecord = record(db, "computer_requests", &wait.subject)?;
    Ok(!matches!(
        r.status,
        ComputerRequestStatus::Pending | ComputerRequestStatus::Granting
    ))
}
pub(super) fn pending_cancelled(db: &Connection, run: &Run, wait: &Wait) -> Result<bool> {
    let Some(id) = wait.id.strip_prefix(PREFIX) else {
        return Ok(false);
    };
    let op: Operation = record(db, "operations", id)?;
    Ok(wait.cancelled
        && wait.run_id == run.id
        && op.run_id == run.id
        && op.phase == OperationPhase::Waiting
        && op.handed_off
        && op.waiting_on.as_deref() == Some(&wait.id)
        && op.call_completion.is_some())
}
pub struct ComputerWaitPreparation {
    run: Run,
    op: Operation,
    wait: Wait,
    request: ComputerRequestRecord,
    head: Option<String>,
    epoch: u64,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedComputerWait {
    capture: ComputerWaitPreparation,
    history: Value,
}
impl ComputerWaitPreparation {
    pub fn load(self) -> Result<PreparedComputerWait> {
        let detail = self
            .request
            .detail_ref
            .as_ref()
            .map(|v| self.content.load(v))
            .transpose()?;
        let body = json!({"requestId":self.request.id,"status":self.request.status,"assignmentId":self.request.claim.as_ref().map(|v|&v.assignment_id),"detail":detail,"observationCancelled":self.wait.cancelled});
        let text = if self.wait.cancelled {
            "The Computer request observation was cancelled. The request and any desktop assignment were not cancelled by ending this observation."
        } else {
            "Computer request decision from the original owner. Granted records that an assignment was ready then; it is not physical input release or permission to replay an action. Check the current assignment and observe the scene before acting."
        };
        let item: ConversationItem = ConversationItem {
            id: format!("computer-request-result:{}", self.wait.id),
            resource_activation: None,
            provenance: Provenance::EnvironmentFact {
                event_id: self.wait.id.clone(),
            },
            content: Content::Text {
                text: format!("{text}\n{}", serde_json::to_string(&body)?),
            },
            opaque: None,
        };
        let history = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        Ok(PreparedComputerWait {
            capture: self,
            history,
        })
    }
}
impl Catalog {
    pub fn wait_for_computer_request(
        &mut self,
        operation_id: &str,
        request_id: &str,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let request: ComputerRequestRecord = record(&tx, "computer_requests", request_id)?;
        let intent = tool_content::ToolIntent::from_operation(&op)?;
        if request.requester.run_id != run.id
            || request.requester.thread_id != run.thread_id
            || request.requester.branch_id != run.branch_id
        {
            return Err(RuntimeError::Conflict(
                "Only the original requesting execution can observe this request".into(),
            ));
        }
        let id = format!("{PREFIX}{operation_id}");
        if let Some(old) = optional_record::<Wait>(&tx, "waits", &id)? {
            if old.subject != request_id {
                return Err(RuntimeError::Conflict(
                    "Computer Wait target changed".into(),
                ));
            }
            return Ok(op);
        }
        fence(&run, self.epoch)?;
        if run.cancel_requested
            || run.state.terminal()
            || op.cancel_requested
            || op.phase != OperationPhase::Running
            || intent.contract().completion != CompletionKind::Job
            || op.lifetime != Lifetime::Thread
            || !matches!(op.execution_owner, Some(ExecutorOwner::External { .. }))
        {
            return Err(RuntimeError::Conflict(
                "Computer observation requires its original active Job invocation".into(),
            ));
        }
        let cursor = tx
            .query_row(
                "SELECT cursor FROM events WHERE subject=?1 AND kind=?2 ORDER BY cursor LIMIT 1",
                params![request_id, EVENT],
                |r| read_number(r, 0),
            )
            .optional()?;
        let wait = Wait {
            id: id.clone(),
            run_id: run.id,
            subject: request_id.into(),
            kind: EVENT.into(),
            after_cursor: 0,
            deadline_at_ms: None,
            trigger_cursor: cursor,
            cancelled: false,
        };
        tx.execute(
            "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
            params![id, wait.run_id, encode(&wait)?],
        )?;
        if let Some(cursor) = cursor {
            Self::enqueue_resume(&tx, &wait, cursor)?;
        }
        op.waiting_on = Some(id);
        op.phase = OperationPhase::Waiting;
        op.handed_off = true;
        op.effect = Effect::None;
        op.revision += 1;
        result_content::publish_job_acceptance(&tx, &mut op, &intent, "awaiting_computer_request")?;
        put(&tx, "operations", operation_id, &op)?;
        event(
            &tx,
            operation_id,
            op.revision,
            "computer.wait_registered",
            serde_json::to_value(&wait)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn cancel_computer_wait(&mut self, id: &str) -> Result<Operation> {
        self.reconcile_waits()?;
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", id)?;
        let wid = op
            .waiting_on
            .as_ref()
            .filter(|v| v.starts_with(PREFIX))
            .ok_or_else(|| RuntimeError::Invalid("Not a Computer request observation".into()))?
            .clone();
        if op.phase == OperationPhase::Terminal {
            return Ok(op);
        }
        let mut wait: Wait = record(&tx, "waits", &wid)?;
        if wait.trigger_cursor.is_none() && !wait.cancelled {
            wait.cancelled = true;
            op.cancel_requested = true;
            op.revision += 1;
            put(&tx, "waits", &wid, &wait)?;
            put(&tx, "operations", id, &op)?;
            event(
                &tx,
                id,
                op.revision,
                "wait.cancelled",
                serde_json::to_value(&wait)?,
            )?;
        }
        tx.commit()?;
        Ok(op)
    }
    pub fn capture_computer_waits(&mut self) -> Result<Vec<ComputerWaitPreparation>> {
        self.reconcile_computer_requests(None)?;
        self.reconcile_waits()?;
        let mut out = vec![];
        for mut op in observations::operations(&self.db, None)? {
            let Some(wid) = op
                .waiting_on
                .as_ref()
                .filter(|v| v.starts_with(PREFIX))
                .cloned()
            else {
                continue;
            };
            let mut wait: Wait = record(&self.db, "waits", &wid)?;
            if op.cancel_requested && !wait.cancelled && wait.trigger_cursor.is_none() {
                self.cancel_computer_wait(&op.id)?;
                op = self.operation(&op.id)?;
                wait = record(&self.db, "waits", &wid)?;
            }
            let run = self.run(&op.run_id)?;
            if run.state.terminal() {
                let tx = self.db.transaction()?;
                if wait.trigger_cursor.is_none() {
                    wait.cancelled = true;
                    put(&tx, "waits", &wid, &wait)?;
                }
                op.phase = OperationPhase::Terminal;
                op.outcome = Some(Outcome::Cancelled);
                op.effect = Effect::None;
                op.revision += 1;
                op.result = Some(OperationResultMetadata::Control {
                    value: json!({"requestId":wait.subject,"observationCancelled":true,"reason":"run_finished"}),
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
                tx.execute(
                    "UPDATE resumptions SET claimed=?2,acknowledged=1 WHERE wait_id=?1",
                    params![wid, sql_number(run.epoch)?],
                )?;
                tx.commit()?;
                self.resource_admission.release(&op.id);
                continue;
            }
            if run.state != RunState::Waiting
                || run.cancel_requested
                || run.waiting_on.as_deref() != Some(&wid)
                || !ready(&self.db, &wait)?
                || !result_content::job_acceptance_consumed(&self.db, &op)?
            {
                continue;
            }
            let unresolved:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM tool_calls t JOIN model_steps m ON m.id=t.request_id WHERE m.run_id=?1 AND t.committed=0)",[&run.id],|r|r.get(0))?;
            if unresolved {
                continue;
            }
            let request = if !wait.cancelled {
                let cursor = wait.trigger_cursor.ok_or_else(|| {
                    RuntimeError::Invalid("Computer decision has no original event".into())
                })?;
                let raw: String = self.db.query_row(
                    "SELECT data FROM events WHERE cursor=?1 AND subject=?2 AND kind=?3",
                    params![sql_number(cursor)?, wait.subject, EVENT],
                    |r| r.get(0),
                )?;
                serde_json::from_str(&raw)?
            } else {
                record(&self.db, "computer_requests", &wait.subject)?
            };
            out.push(ComputerWaitPreparation {
                head: self.head(&run.branch_id)?,
                run,
                op,
                wait,
                request,
                epoch: self.epoch,
                content: self.content.clone(),
                _publication: self.content.begin_publication(),
            });
        }
        Ok(out)
    }
    pub fn admit_computer_wait(&mut self, prepared: PreparedComputerWait) -> Result<bool> {
        let c = prepared.capture;
        if c.epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "Computer observation owner changed".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut run: Run = record(&tx, "runs", &c.run.id)?;
        let mut op: Operation = record(&tx, "operations", &c.op.id)?;
        let mut wait: Wait = record(&tx, "waits", &c.wait.id)?;
        let (head, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if run != c.run
            || op != c.op
            || wait != c.wait
            || head != c.head
            || active.as_deref() != Some(&run.id)
            || !result_content::job_acceptance_consumed(&tx, &op)?
        {
            return Ok(false);
        }
        let item = HistoryItem {
            id: format!("computer-request-result:{}", wait.id),
            run_id: run.id.clone(),
            thread_id: run.thread_id.clone(),
            parent: head,
            source: HistorySource::Environment,
            content: prepared.history,
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
            params![run.branch_id, item.id],
        )?;
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(if wait.cancelled {
            Outcome::Cancelled
        } else {
            Outcome::Succeeded
        });
        op.effect = Effect::None;
        op.revision += 1;
        op.result = Some(OperationResultMetadata::Control {
            value: json!({"requestId":wait.subject,"requestStatus":c.request.status,"observationCancelled":wait.cancelled}),
        });
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
        if wait.trigger_cursor.is_none() {
            wait.trigger_cursor = Some(cursor);
            put(&tx, "waits", &wait.id, &wait)?;
        }
        Self::enqueue_resume(&tx, &wait, wait.trigger_cursor.expect("assigned cursor"))?;
        tx.execute(
            "UPDATE resumptions SET claimed=?2,acknowledged=1 WHERE wait_id=?1",
            params![wait.id, sql_number(run.epoch)?],
        )?;
        observations::advance(&tx, &mut run)?;
        tx.commit()?;
        self.resource_admission.release(&op.id);
        Ok(true)
    }
}
pub fn deliver_waits(catalog: &Mutex<Catalog>) -> Result<Vec<String>> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))
    };
    let captures = lock()?.capture_computer_waits()?;
    let mut error = None;
    for capture in captures {
        if let Err(cause) = capture.load().and_then(|p| lock()?.admit_computer_wait(p)) {
            error.get_or_insert(cause);
        }
    }
    if let Some(error) = error {
        Err(error)
    } else {
        Ok(vec![])
    }
}
