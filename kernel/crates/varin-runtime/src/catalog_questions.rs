//! User clarification is an Operation plus an ordinary durable Wait, never a permission grant.
use super::*;

pub const QUESTION_TOOL: &str = "ask_user";

pub struct QuestionAnswerPreparation {
    operation_id: String,
    run_id: String,
    epoch: u64,
    answer: Option<String>,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedQuestionAnswer {
    operation_id: String,
    run_id: String,
    epoch: u64,
    content: Value,
    result: Value,
    outcome: Outcome,
    _publication: crate::content::ContentPublication,
}
impl QuestionAnswerPreparation {
    pub fn load(self) -> Result<PreparedQuestionAnswer> {
        let answer = self.answer.as_deref().unwrap_or(
            "The user cancelled this question. Continue without assuming an answer or permission.",
        );
        if answer.trim().is_empty() {
            return Err(RuntimeError::Invalid("answer is empty".into()));
        }
        let content = self.content.save_history(&json!({"text":answer}), &None)?;
        let (outcome, result) = if self.answer.is_some() {
            (Outcome::Succeeded, json!({"answer_ref":content}))
        } else {
            (Outcome::Cancelled, json!({"cancelled":true}))
        };
        Ok(PreparedQuestionAnswer {
            operation_id: self.operation_id,
            run_id: self.run_id,
            epoch: self.epoch,
            content,
            result,
            outcome,
            _publication: self.publication,
        })
    }
}

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
        let tool=super::tool_content::ToolIntent::from_operation(&op)?;
        let receipt = crate::execution::ToolResult {
            request_id:match tool.origin() {
                crate::execution::ToolOrigin::ModelStep{request_id}=>request_id.clone(),
                crate::execution::ToolOrigin::PolicyAction{..}=>return Err(RuntimeError::Invalid("questions currently require a model origin".into())),
            },
            call_id: tool.call().call_id.clone(),
            completion: crate::execution::ToolCompletion::JobAccepted {
                operation_id: operation_id.into(),
                phase: "awaiting_user".into(),
                effect: Effect::None,
                lifetime: Lifetime::Thread,
            },
        };
        let accepted=super::result_content::ToolReceiptMetadata::job(&receipt)?;
        if op.call_completion.as_ref().is_some_and(|previous|previous!=&accepted.completion) {return Err(RuntimeError::Conflict("original invocation acceptance changed".into()));}
        op.call_completion=Some(accepted.completion.clone());
        put(&tx,"operations",&op.id,&op)?;
        tx.execute(
            "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
            params![receipt.request_id, receipt.call_id, encode(&accepted)?],
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
        Ok(self
            .db
            .query_row(
                "SELECT json_extract(body,'$.waiting_on') FROM operations WHERE run_id=?1
            AND json_extract(body,'$.executor')=?2 AND json_extract(body,'$.phase')!='terminal'
            AND json_extract(body,'$.waiting_on') IS NOT NULL ORDER BY rowid LIMIT 1",
                params![run_id, QUESTION_TOOL],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Answer receipt, conversation delivery, terminal operation and continuation commit together.
    /// Equal retries return the original receipt; cancellation and conflicting answers are rejected.
    pub fn answer_question(&mut self, operation_id: &str, answer: &str) -> Result<Operation> {
        let prepared = self
            .prepare_question_answer(operation_id, Some(answer.into()))?
            .load()?;
        self.admit_question_answer(prepared)
    }
    pub fn cancel_question(&mut self, operation_id: &str) -> Result<Operation> {
        let prepared = self.prepare_question_answer(operation_id, None)?.load()?;
        self.admit_question_answer(prepared)
    }
    pub fn prepare_question_answer(
        &self,
        operation_id: &str,
        answer: Option<String>,
    ) -> Result<QuestionAnswerPreparation> {
        let original = self.operation(operation_id)?;
        if original.executor.as_deref() != Some(QUESTION_TOOL) {
            return Err(RuntimeError::Invalid("not a user question".into()));
        }
        Ok(QuestionAnswerPreparation {
            operation_id: operation_id.into(),
            run_id: original.run_id,
            epoch: self.epoch,
            answer,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    /// Only the authenticated answer becomes user content; the receipt keeps its content identity.
    /// The question remains in its original tool call and cannot acquire user authority.
    pub fn admit_question_answer(&mut self, prepared: PreparedQuestionAnswer) -> Result<Operation> {
        let PreparedQuestionAnswer {
            operation_id,
            run_id,
            epoch,
            content,
            result,
            outcome,
            _publication,
        } = prepared;
        if epoch != self.epoch {
            return Err(RuntimeError::Conflict(
                "question answer belongs to a previous owner".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &operation_id)?;
        if op.run_id != run_id || op.executor.as_deref() != Some(QUESTION_TOOL) {
            return Err(RuntimeError::Conflict("question owner changed".into()));
        }
        let mut run: Run = record(&tx, "runs", &op.run_id)?;
        if op.phase == OperationPhase::Terminal {
            if op.outcome == Some(outcome) && op.result.as_ref().map(OperationResultMetadata::control).transpose()? == Some(&result) {
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
            || (op.cancel_requested && outcome != Outcome::Cancelled)
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
        op.result = Some(OperationResultMetadata::Control { value: result });
        op.revision += 1;
        put(&tx, "operations", &operation_id, &op)?;
        let cursor = event(
            &tx,
            &operation_id,
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
        if let Some(mut launch) = optional_record::<super::launch_content::LaunchMetadata>(&tx, "run_launches", &run.id)? {
            launch.bound_epoch = None;
            launch.requires_rebind = true;
            launch.revision += 1;
            put(&tx, "run_launches", &run.id, &launch)?;
        }
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
    let ids = {
        let mut statement = tx.prepare(
            "SELECT id FROM operations WHERE run_id=?1
            AND json_extract(body,'$.executor')=?2 AND json_extract(body,'$.phase')!='terminal'",
        )?;
        let rows = statement.query_map(params![run_id, QUESTION_TOOL], |row| {
            row.get::<_, String>(0)
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for operation_id in ids {
        let mut op: Operation = record(tx, "operations", &operation_id)?;
        op.phase = OperationPhase::Terminal;
        op.outcome = Some(Outcome::Cancelled);
        op.cancel_requested = true;
        op.revision += 1;
        op.result = Some(OperationResultMetadata::Control { value: json!({"cancelled":true}) });
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
