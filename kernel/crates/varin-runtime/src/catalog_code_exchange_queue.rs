//! File exchanges remain original thread-lifetime Jobs. Only their application
//! boundary is mutable; the accepted content names an immutable source result.
use super::host_jobs::HostJobBinding;
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeExchangeQueue {
    pub request_ref: Value,
    pub target_thread_id: String,
    pub target_branch_id: String,
    pub after_run_id: Option<String>,
    pub external_operation_id: Option<String>,
    pub started: bool,
}
impl Catalog {
    pub fn pending_code_exchanges(&self) -> Result<Vec<Operation>> {
        let mut query = self.db.prepare("SELECT body FROM operations INDEXED BY pending_code_exchange_jobs WHERE json_extract(body,'$.host_job.binding.domain')='collaboration.code' AND (coalesce(json_extract(body,'$.external_receipt.executor_stopped'),0)=0 OR json_extract(body,'$.phase')!='terminal') ORDER BY rowid")?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn queue_code_exchange(
        &mut self,
        binding: &HostJobBinding,
        thread: &str,
        branch: &str,
        after_current: bool,
        external: Option<&str>,
        prepared: result_content::PreparedOperationResult,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &binding.operation_id)?;
        let job = op
            .host_job
            .as_ref()
            .ok_or_else(|| RuntimeError::Invalid("File exchange Job is unavailable".into()))?;
        if job.binding != *binding || binding.domain != "collaboration.code" {
            return Err(RuntimeError::Conflict("File exchange owner changed".into()));
        }
        if job.code_exchange.is_some() {
            return Ok(op);
        }
        let actual: String = tx.query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [branch],
            |r| r.get(0),
        )?;
        if actual != thread {
            return Err(RuntimeError::Conflict("Exchange branch changed".into()));
        }
        if job.acceptance_ref.is_some()
            || op.cancel_requested
            || op.phase != OperationPhase::Running
        {
            return Err(RuntimeError::Conflict(
                "File exchange is no longer being prepared".into(),
            ));
        }
        let after_run_id = if after_current && external.is_none() {
            tx.query_row(
                "SELECT active_run FROM branches WHERE id=?1",
                [branch],
                |r| r.get(0),
            )?
        } else {
            None
        };
        if let Some(id) = external {
            let child: external_children::ExternalChild = record(&tx, "external_children", id)?;
            if child.parent_thread_id != thread || child.parent_branch_id != branch {
                return Err(RuntimeError::Conflict(
                    "External exchange target changed".into(),
                ));
            }
        }
        op.host_job.as_mut().unwrap().code_exchange = Some(CodeExchangeQueue {
            request_ref: prepared.reference,
            target_thread_id: thread.into(),
            target_branch_id: branch.into(),
            after_run_id,
            external_operation_id: external.filter(|_| after_current).map(str::to_owned),
            started: false,
        });
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "operation.code_exchange_queued",
            json!({}),
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn code_exchange_request(&self, id: &str) -> Result<result_content::ToolCompletionRead> {
        let op = self.operation(id)?;
        let queue = op
            .host_job
            .and_then(|job| job.code_exchange)
            .ok_or_else(|| RuntimeError::NotFound("Queued file exchange".into()))?;
        Ok(result_content::ToolCompletionRead {
            completion: result_content::ToolCompletionMetadata::Result {
                outcome: Outcome::Succeeded,
                effect: Effect::None,
                content_ref: queue.request_ref,
            },
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn control_code_exchange(
        &mut self,
        thread: &str,
        branch: &str,
        id: &str,
        revision: u64,
        action: &str,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let job = op
            .host_job
            .as_ref()
            .ok_or_else(|| RuntimeError::Invalid("File exchange Job is unavailable".into()))?;
        let queue = job
            .code_exchange
            .as_ref()
            .ok_or_else(|| RuntimeError::Invalid("Queued file exchange is unavailable".into()))?;
        if (run.thread_id != thread || run.branch_id != branch)
            && (queue.target_thread_id != thread || queue.target_branch_id != branch)
        {
            return Err(RuntimeError::Invalid(
                "File exchange does not belong to this conversation".into(),
            ));
        }
        if op.revision != revision {
            return Err(RuntimeError::Conflict(
                "File exchange changed; refresh its queue state".into(),
            ));
        }
        if op.phase == OperationPhase::Terminal
            && op
                .external_receipt
                .as_ref()
                .is_some_and(|receipt| receipt.executor_stopped)
        {
            return Ok(op);
        }
        match action {
            "claim" => {
                if queue.started || op.cancel_requested || job.acceptance_ref.is_none() {
                    return Ok(op);
                }
                let target_exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM branches WHERE id=?1 AND thread_id=?2) AND (?3 IS NULL OR EXISTS(SELECT 1 FROM runs WHERE id=?3)) AND (?4 IS NULL OR EXISTS(SELECT 1 FROM external_children WHERE id=?4))",
                    params![queue.target_branch_id, queue.target_thread_id, queue.after_run_id, queue.external_operation_id], |row| row.get(0))?;
                if !target_exists {
                    op.cancel_requested = true;
                } else {
                    if let Some(id) = &queue.after_run_id {
                        let recipient: Run = record(&tx, "runs", id)?;
                        if !recipient.state.terminal() {
                            return Ok(op);
                        }
                    }
                    if let Some(id) = &queue.external_operation_id {
                        let child: external_children::ExternalChild =
                            record(&tx, "external_children", id)?;
                        if child.finished_at_ms.is_none() {
                            return Ok(op);
                        }
                    }
                    op.host_job
                        .as_mut()
                        .unwrap()
                        .code_exchange
                        .as_mut()
                        .unwrap()
                        .started = true;
                }
            }
            "send_now" | "cancel" => {
                if queue.started {
                    return Err(RuntimeError::Conflict(
                        "File merge has already started".into(),
                    ));
                }
                if action == "cancel" {
                    op.cancel_requested = true;
                } else {
                    let queue = op
                        .host_job
                        .as_mut()
                        .unwrap()
                        .code_exchange
                        .as_mut()
                        .unwrap();
                    queue.after_run_id = None;
                    queue.external_operation_id = None;
                }
            }
            "retry"
                if queue.started
                    && op.external_receipt.as_ref().is_some_and(|receipt| {
                        !receipt.executor_stopped && receipt.effect == Effect::Unknown
                    }) => {}
            _ => {
                return Err(RuntimeError::Invalid(
                    "Unknown file exchange queue action".into(),
                ));
            }
        }
        op.revision += 1;
        put(&tx, "operations", id, &op)?;
        event(
            &tx,
            id,
            op.revision,
            "operation.code_exchange_changed",
            json!({"action":action}),
        )?;
        tx.commit()?;
        Ok(op)
    }
}
