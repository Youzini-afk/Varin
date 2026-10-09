//! User clarification is an Operation plus an ordinary durable Wait, never a permission grant.
use super::*;
use crate::execution::AdmittedTool;

pub const QUESTION_TOOL: &str = "ask_user";

impl Catalog {
    pub fn open_question(&mut self, operation_id: &str, run_id: &str) -> Result<String> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let run: Run = record(&tx, "runs", run_id)?;
        if op.run_id != run_id
            || op.executor.as_deref() != Some(QUESTION_TOOL)
            || op.cancel_requested
            || run.cancel_requested
            || run.state.terminal()
            || !matches!(op.phase, OperationPhase::Running | OperationPhase::Waiting)
        {
            return Err(RuntimeError::Conflict(
                "question is no longer admitted".into(),
            ));
        }
        let wait_id = format!("question:{operation_id}");
        if optional_record::<Wait>(&tx, "waits", &wait_id)?.is_none() {
            let cursor = tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
                read_number(r, 0)
            })?;
            let wait = Wait {
                id: wait_id.clone(),
                run_id: run_id.into(),
                subject: operation_id.into(),
                kind: "operation.settled".into(),
                after_cursor: cursor,
                trigger_cursor: None,
                cancelled: false,
            };
            tx.execute(
                "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
                params![wait.id, wait.run_id, encode(&wait)?],
            )?;
            event(
                &tx,
                &wait.id,
                1,
                "wait.registered",
                serde_json::to_value(&wait)?,
            )?;
        }
        let tool: AdmittedTool = serde_json::from_value(op.intent.clone())?;
        let receipt = crate::execution::ToolResult {
            request_id: operation_id
                .strip_suffix(&format!(":tool:{}", tool.call.call_id))
                .ok_or_else(|| RuntimeError::Invalid("question operation identity missing".into()))?
                .into(),
            call_id: tool.call.call_id,
            completion: crate::execution::ToolCompletion::JobAccepted {
                operation_id: operation_id.into(),
                phase: "awaiting_user".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
            },
        };
        tx.execute(
            "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
            params![receipt.request_id, receipt.call_id, encode(&receipt)?],
        )?;
        op.handed_off = true;
        op.phase = OperationPhase::Waiting;
        op.waiting_on = Some(wait_id.clone());
        op.revision += 1;
        put(&tx, "operations", operation_id, &op)?;
        event(
            &tx,
            operation_id,
            op.revision,
            "question.opened",
            Value::Null,
        )?;
        tx.commit()?;
        Ok(wait_id)
    }

    pub fn pending_question_wait(&self, run_id: &str) -> Result<Option<String>> {
        let mut stmt = self
            .db
            .prepare("SELECT body FROM operations WHERE run_id=?1 ORDER BY rowid")?;
        for raw in stmt.query_map([run_id], |r| r.get::<_, String>(0))? {
            let op: Operation = serde_json::from_str(&raw?)?;
            if op.executor.as_deref() == Some(QUESTION_TOOL) && op.phase != OperationPhase::Terminal
            {
                if let Some(wait) = op.waiting_on {
                    return Ok(Some(wait));
                }
            }
        }
        Ok(None)
    }

    /// Answer receipt, conversation delivery, terminal operation and continuation commit together.
    /// Equal retries return the original receipt; cancellation and conflicting answers are rejected.
    pub fn answer_question(&mut self, operation_id: &str, answer: &str) -> Result<Operation> {
        self.finish_question(operation_id, Some(answer))
    }
    pub fn cancel_question(&mut self, operation_id: &str) -> Result<Operation> {
        self.finish_question(operation_id, None)
    }
    fn finish_question(&mut self, operation_id: &str, supplied: Option<&str>) -> Result<Operation> {
        let answer = supplied.unwrap_or(
            "The user cancelled this question. Continue without assuming an answer or permission.",
        );
        if answer.trim().is_empty() {
            return Err(RuntimeError::Invalid("answer is empty".into()));
        }
        let original = self.operation(operation_id)?;
        if original.executor.as_deref() != Some(QUESTION_TOOL) {
            return Err(RuntimeError::Invalid("not a user question".into()));
        }
        // Only the authenticated user's answer becomes user-instruction content. The model's
        // question stays in its original tool call and must not be promoted to user authority.
        let content = self.content.save_history(&json!({"text":answer}), &None)?;
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let mut run: Run = record(&tx, "runs", &op.run_id)?;
        let result = if supplied.is_some() {
            json!({"answer":answer})
        } else {
            json!({"cancelled":true})
        };
        let outcome = if supplied.is_some() {
            Outcome::Succeeded
        } else {
            Outcome::Cancelled
        };
        if op.phase == OperationPhase::Terminal {
            if op.outcome == Some(outcome) && op.result.as_ref() == Some(&result) {
                return Ok(op);
            }
            return Err(RuntimeError::Conflict("question already closed".into()));
        }
        let wait_id = op
            .waiting_on
            .clone()
            .ok_or_else(|| RuntimeError::Conflict("question is not ready".into()))?;
        let mut wait: Wait = record(&tx, "waits", &wait_id)?;
        if !op.handed_off
            || op.cancel_requested
            || run.cancel_requested
            || run.state != RunState::Waiting
            || run.waiting_on.as_deref() != Some(&wait_id)
            || wait.cancelled
        {
            return Err(RuntimeError::Conflict(
                "question is not awaiting an answer".into(),
            ));
        }
        let (parent, active): (Option<String>, Option<String>) = tx.query_row(
            "SELECT head,active_run FROM branches WHERE id=?1",
            [&run.branch_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if active.as_deref() != Some(&run.id) {
            return Err(RuntimeError::Conflict(
                "question branch owner changed".into(),
            ));
        }
        let item = HistoryItem {
            id: format!("question-answer:{operation_id}"),
            thread_id: run.thread_id.clone(),
            parent,
            source: HistorySource::User,
            content,
            provider: None,
        };
        tx.execute(
            "INSERT INTO history(id,thread_id,parent,body) VALUES(?1,?2,?3,?4)",
            params![item.id, item.thread_id, item.parent, encode(&item)?],
        )?;
        tx.execute(
            "UPDATE branches SET head=?2 WHERE id=?1",
            params![run.branch_id, item.id],
        )?;
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(outcome);
        op.effect = Effect::None;
        op.result = Some(result);
        op.revision += 1;
        put(&tx, "operations", operation_id, &op)?;
        let cursor = event(
            &tx,
            operation_id,
            op.revision,
            "operation.settled",
            serde_json::to_value(&op)?,
        )?;
        wait.trigger_cursor = Some(cursor);
        put(&tx, "waits", &wait_id, &wait)?;
        Self::enqueue_resume(&tx, &wait, cursor)?;
        tx.execute(
            "UPDATE resumptions SET claimed=?2,acknowledged=1 WHERE wait_id=?1",
            params![wait_id, sql_number(run.epoch)?],
        )?;
        run.state = RunState::Runnable;
        run.waiting_on = None;
        run.revision += 1;
        put(&tx, "runs", &run.id, &run)?;
        event(
            &tx,
            &run.id,
            run.revision,
            "question.answered",
            json!({"operation_id":operation_id,"input_id":item.id}),
        )?;
        tx.commit()?;
        Ok(op)
    }
}

/// Run cancellation closes unanswered questions and makes later responses inert.
pub(super) fn cancel_run_questions(tx: &Transaction<'_>, run_id: &str) -> Result<()> {
    for mut op in read_all::<Operation>(tx, "operations")? {
        if op.run_id != run_id
            || op.executor.as_deref() != Some(QUESTION_TOOL)
            || op.phase == OperationPhase::Terminal
        {
            continue;
        }
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(Outcome::Cancelled);
        op.cancel_requested = true;
        op.revision += 1;
        op.result = Some(json!({"cancelled":true}));
        if let Some(wait_id) = &op.waiting_on {
            let mut wait: Wait = record(tx, "waits", wait_id)?;
            wait.cancelled = true;
            put(tx, "waits", wait_id, &wait)?;
        }
        put(tx, "operations", &op.id, &op)?;
        event(
            tx,
            &op.id,
            op.revision,
            "operation.settled",
            serde_json::to_value(&op)?,
        )?;
    }
    Ok(())
}
