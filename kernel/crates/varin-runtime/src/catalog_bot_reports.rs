//! Delegated report delivery uses the original durable message ingress. No second scheduler.
use super::delegated::DelegatedTrigger;
use super::*;
#[path = "catalog_work_reports.rs"]
mod work;

/// The receiver belongs to this admission, not necessarily to the original child relation.
/// Event-driven continuations retain the previous admission's requester.
pub(super) struct ReportRequester {
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
    pub reply_to: Option<String>,
}
pub(super) fn requester(db: &Connection, execution_id: &str) -> Result<ReportRequester> {
    let mut execution = delegated::execution(db, execution_id)?;
    let mut visited = std::collections::BTreeSet::new();
    loop {
        if !visited.insert(execution.execution_id.clone()) {
            return Err(RuntimeError::Invalid("cyclic delegated requester lineage".into()));
        }
        match &execution.trigger {
            DelegatedTrigger::MessageRequest { message_id, .. } => {
                let request: inputs::QueuedInputMetadata = record(db, "input_queue", message_id)?;
                let identity = messages::message_identity(&request)?;
                if let messages::MessageActor::Agent { run_id, .. } = &identity.actor {
                    return Ok(ReportRequester { thread_id: identity.sender_thread_id.clone(),
                        branch_id: identity.sender_branch_id.clone(), run_id: run_id.clone(),
                        reply_to: Some(message_id.clone()) });
                }
                break;
            }
            DelegatedTrigger::WorkEvent { previous_execution_id, .. }
            | DelegatedTrigger::Followup { previous_execution_id, .. }
            | DelegatedTrigger::Calendar { previous_execution_id, .. }
            | DelegatedTrigger::ComputerEvent { previous_execution_id, .. } => {
                execution = delegated::execution(db, previous_execution_id)?;
            }
            DelegatedTrigger::Dispatch | DelegatedTrigger::UserContinuation { .. } => break,
        }
    }
    let child = delegated::relation(db, &execution.child_operation_id)?;
    Ok(ReportRequester { thread_id: child.parent_thread_id, branch_id: child.parent_branch_id,
        run_id: child.parent_run_id, reply_to: None })
}

/// Branch ancestry, rather than a request snapshot or a directory read, proves visibility.
pub(super) fn visible_report(db: &Connection, head: Option<&str>, execution: &str) -> Result<Option<String>> {
    db.query_row("WITH RECURSIVE chain(id,parent) AS (SELECT id,parent FROM history WHERE id=?1 UNION ALL SELECT h.id,h.parent FROM history h JOIN chain c ON h.id=c.parent) SELECT c.id FROM chain c WHERE EXISTS(SELECT 1 FROM deliveries d WHERE d.observer=?2 AND d.request=c.id AND d.state='\"committed\"') OR c.id=?3 LIMIT 1",
        params![head, format!("child-report-history:{execution}"), format!("message:bot-report:{execution}")], |row| row.get(0)).optional().map_err(Into::into)
}

/// Only this transaction's actual history writer calls this helper. It does not claim that
/// a model understood the result, and never treats merely queued reports as delivered.
pub(super) fn record_history_delivery(tx: &Transaction<'_>, run: &Run, execution: &str, history: &str) -> Result<()> {
    let cursor: u64 = tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='child.report_ready' ORDER BY cursor LIMIT 1", [execution], |r| read_number(r, 0))?;
    tx.execute("INSERT OR IGNORE INTO deliveries(observer,fact_cursor,request,state) VALUES(?1,?2,?3,'\"committed\"')",
        params![format!("child-report-history:{execution}"), sql_number(cursor)?, history])?;
    super::attention_facts::record_report_delivery(tx, run, execution)?;
    // A read or wait may win while an automatic report is already queued. Retire only
    // that exact system-owned duplicate; do not cancel its receiving Run or user input.
    if let Some(mut queued) = optional_record::<inputs::QueuedInputMetadata>(tx, "input_queue", &format!("message:bot-report:{execution}"))? {
        if queued.branch_id == run.branch_id && queued.state == InputState::Queued && queued.id != history {
            queued.state = InputState::Cancelled;
            queued.revision += 1;
            inputs::write_input(tx, &queued)?;
            event(tx, &queued.id, queued.revision, "message.report_reused", json!({"executionId":execution,"historyId":history}))?;
        }
    }
    Ok(())
}

/// Record a successful exact report read against its real invocation. Delivery is deferred
/// until the successful result is appended by the original history transaction.
impl Catalog {
    /// Only the built-in tool_invoke gateway publishes the nested result as its
    /// own complete output. Script calls may discard results, so their ancestry
    /// alone must never acknowledge a report.
    pub fn forward_nested_report_read(&mut self, parent_id: &str, nested_id: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        let executions = {
            let mut query=tx.prepare("SELECT DISTINCT json_extract(data,'$.executionId') FROM events WHERE subject=?1 AND kind='child.report_read'")?;
            let rows=query.query_map([nested_id],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            rows
        };
        // Ordinary pure reads and accepted background Jobs have no report receipt.
        if executions.is_empty() { tx.commit()?; return Ok(()); }
        let parent: Operation = record(&tx,"operations",parent_id)?;
        let nested: Operation = record(&tx,"operations",nested_id)?;
        let parent_intent = tool_content::ToolIntent::from_operation(&parent)?;
        let nested_intent = tool_content::ToolIntent::from_operation(&nested)?;
        if parent_intent.call().name != crate::tool_disclosure::INVOKE
            || nested_intent.origin() != &(crate::execution::ToolOrigin::NestedCall {parent_operation_id:parent_id.into()})
            || parent.run_id != nested.run_id || parent.cancel_requested
            || nested.outcome != Some(Outcome::Succeeded) {
            return Err(RuntimeError::Conflict("Published nested report differs from its original tool gateway".into()));
        }
        for execution in executions {
            let existing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='child.report_read' AND json_extract(data,'$.executionId')=?2)",params![parent_id,execution],|row|row.get(0))?;
            if !existing {event(&tx,parent_id,parent.revision,"child.report_read",json!({"executionId":execution,"nestedOperationId":nested_id}))?;}
        }
        tx.commit()?;Ok(())
    }
    pub fn record_child_report_read(&mut self, context: &crate::execution::ToolExecutionContext, execution_id: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", &context.run_id)?;
        fence(&run, self.epoch)?;
        let execution = delegated::execution(&tx, execution_id)?;
        let Some(op):Option<Operation> = optional_record(&tx,"operations",&context.operation_id)? else {
            // A read-only policy/nested read has no original effect Operation. It can
            // return data without pretending that a private/discarded result was delivered.
            tx.commit()?;return Ok(());
        };
        let intent = tool_content::ToolIntent::from_operation(&op)?;
        if op.run_id != run.id || intent.origin() != &context.origin || intent.call().name != collaboration::REPORT_TOOL
            || op.cancel_requested || run.cancel_requested || execution.report.is_none() {
            return Err(RuntimeError::Conflict("report read differs from its live original invocation".into()));
        }
        let existing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='child.report_read' AND json_extract(data,'$.executionId')=?2)", params![op.id,execution_id], |r|r.get(0))?;
        if !existing { event(&tx, &op.id, op.revision, "child.report_read", json!({"executionId":execution_id}))?; }
        tx.commit()?;
        Ok(())
    }
}
pub(super) fn commit_report_reads(tx: &Transaction<'_>, run: &Run, operation: &str, history: &str) -> Result<()> {
    let mut query = tx.prepare("SELECT DISTINCT json_extract(data,'$.executionId') FROM events WHERE subject=?1 AND kind='child.report_read'")?;
    let executions = query.query_map([operation], |r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for execution in executions { record_history_delivery(tx, run, &execution, history)?; }
    Ok(())
}

pub(super) fn publish_run_pending(tx: &Transaction<'_>, run: &Run) -> Result<()> {
    work::publish_pending(tx, run)
}

pub(super) fn directly_requested_by(db: &Connection, run: &Run, bot: &str) -> Result<bool> {
    work::directly_requested_by(db, run, bot)
}

/// Only a newly published result creates work. Opening a store does not replay every
/// historical report as a fresh request.
pub(super) fn publish_pending(
    tx: &Transaction<'_>,
    execution_id: &str,
    revision: u64,
) -> Result<()> {
    // Preparation may fail or be cancelled before there is any execution source.
    // Report publication needs the durable lineage, not a launch-ready ChildTask.
    let execution = delegated::execution(tx, execution_id)?;
    let child = delegated::relation(tx, &execution.child_operation_id)?;
    // The event is written with the newly published report. No startup sweep invents
    // pending notifications for terminal executions from before this feature.
    let _ = child;
    event(tx, execution_id, revision, "bot.report_pending", json!({"executionId": execution_id}))?;
    Ok(())
}

impl Catalog {
    fn pending_bot_reports(&self) -> Result<Vec<delegated::DelegatedExecution>> {
        let mut query = self.db.prepare("SELECT e.id FROM delegated_executions e JOIN child_tasks c ON c.id=e.child_operation_id JOIN operations o ON o.id=c.id JOIN threads t ON t.id=c.child_thread_id WHERE t.deleted_at_ms IS NULL AND json_extract(e.body,'$.report') IS NOT NULL AND EXISTS(SELECT 1 FROM events WHERE subject=e.id AND kind='bot.report_pending') AND coalesce(json_extract(o.body,'$.executor'),'')!='code_retrieval' AND NOT EXISTS(SELECT 1 FROM commands WHERE id='bot-report:'||e.id) AND NOT EXISTS(SELECT 1 FROM deliveries WHERE observer='bot-report-delivery' AND request=e.id) AND NOT EXISTS(SELECT 1 FROM waits w JOIN operations wo ON w.id='child-wait:'||wo.id WHERE json_extract(w.body,'$.subject')=e.id AND json_extract(w.body,'$.cancelled')=0 AND json_extract(wo.body,'$.phase')!='terminal')")?;
        let ids = query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut pending = Vec::new();
        for id in ids {
            let target = requester(&self.db, &id)?;
            let head = self.head(&target.branch_id)?;
            if visible_report(&self.db, head.as_deref(), &id)?.is_none() {
                pending.push(delegated::execution(&self.db, &id)?);
            }
        }
        Ok(pending)
    }

    fn prepare_bot_report(
        &self,
        execution: delegated::DelegatedExecution,
    ) -> Result<DelegatedReportPreparation> {
        let child = delegated::relation(&self.db, &execution.child_operation_id)?;
        let name: String = self.db.query_row("SELECT title FROM threads WHERE id=?1", [&child.child_thread_id], |row| row.get(0))?;
        let report = execution
            .report
            .as_ref()
            .ok_or_else(|| RuntimeError::Conflict("Bot report is not ready".into()))?;
        let target = requester(&self.db, &execution.execution_id)?;
        let parent = self.run(&target.run_id)?;
        let actor = messages::MessageActor::AgentReport {
            execution_id: execution.execution_id.clone(), operation_id: child.operation_id.clone(),
        };
        let preview = report.history_ids.last().map(|item| self.capture_delegated_report(
            &execution.execution_id, item, 0, 65536)).transpose()?;
        let reference = self.execution_reference(&execution.execution_id)?;
        let data = json!({"kind":"child_report", "executionRef":reference.reference,"agentRef":reference.agent_id, "operationId":child.operation_id,
            "executionId":execution.execution_id, "senderThreadId":child.child_thread_id,
            "report":report, "trust":"Other-agent report, not a new user instruction or permission."});
        let text = format!("Work {} [{}], execution {}, ended with status {:?}. {} The preview below may be partial.",
            name, reference.agent_id, reference.reference, report.outcome, report.detail.as_deref().unwrap_or(""));
        let message = self.prepare_message(
            format!("bot-report:{}", execution.execution_id),
            child.child_thread_id,
            child.child_branch_id,
            actor,
            messages::MessageInput { attachments: report.attachments.iter().map(|file|super::attachments::AttachmentSelection::Ref{reference:file.reference.clone()}).collect(),
                after_current: None,
                source_agent: None,
                name: None,
                wait: None,
                target_thread_id: Some(target.thread_id.clone()),
                target_branch_id: Some(target.branch_id.clone()),
                reply_to: target.reply_to,
                // A cancelled original request may leave evidence, but must not wake new work.
                kind: if parent.cancel_requested || parent.state == RunState::Cancelled || super::bot::thread_bot(&self.db, &target.thread_id)?.is_none() {
                    MessageKind::Inform
                } else {
                    MessageKind::Request
                },
                text,
            },
            None,
            None,
        )
        .and_then(|message| message.with_attachments(report.attachments.clone()).with_delivery_data(data).with_model_references(self))?
            .with_report_receiver(self, &parent.id)?;
        Ok(DelegatedReportPreparation { message, preview })
    }
}

struct DelegatedReportPreparation {
    message: messages::MessagePreparation,
    preview: Option<super::child_content::ChildReportRead>,
}
impl DelegatedReportPreparation {
    fn load(self) -> Result<messages::PreparedMessage> {
        let preview = self.preview.map(|read| read.summary()).transpose()?;
        self.message.with_report_preview(preview).load()
    }
}

pub fn deliver_reports(catalog: &std::sync::Mutex<Catalog>) -> Result<()> {
    let lock = || {
        catalog
            .lock()
            .map_err(|_| RuntimeError::Invalid("Catalog unavailable".into()))
    };
    let candidates = lock()?.pending_bot_reports()?;
    let mut failure = None;
    for child in candidates {
        let delivered = (|| {
            let preparation = lock()?.prepare_bot_report(child)?;
            let prepared = preparation.load()?;
            let mut owner = lock()?;
            let identity = prepared.identity();
            if let messages::MessageActor::AgentReport { execution_id, .. } = &identity.actor {
                let head = owner.head(&identity.target_branch_id)?;
                if visible_report(&owner.db, head.as_deref(), execution_id)?.is_some() { return Ok(()); }
            }
            owner.admit_message(prepared)?;
            Ok(())
        })();
        if let Err(error) = delivered {
            failure.get_or_insert(error);
        }
    }
    if let Err(error) = work::deliver(catalog) { failure.get_or_insert(error); }
    failure.map_or(Ok(()), Err)
}

#[cfg(test)]
#[path = "catalog_bot_reports_tests.rs"]
mod tests;
