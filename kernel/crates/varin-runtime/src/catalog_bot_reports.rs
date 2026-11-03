//! Bot report delivery uses the original durable message ingress. No second scheduler.
use super::delegated::DelegatedTrigger;
use super::*;

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
    if super::bot::thread_bot(tx, &child.child_thread_id)?.is_some() {
        event(
            tx,
            execution_id,
            revision,
            "bot.report_pending",
            json!({"executionId": execution_id}),
        )?;
    }
    Ok(())
}

impl Catalog {
    fn pending_bot_reports(&self) -> Result<Vec<delegated::DelegatedExecution>> {
        let mut query = self.db.prepare("SELECT e.id FROM delegated_executions e JOIN child_tasks c ON c.id=e.child_operation_id JOIN operations o ON o.id=c.id JOIN threads t ON t.id=c.child_thread_id WHERE t.deleted_at_ms IS NULL AND json_extract(e.body,'$.report') IS NOT NULL AND EXISTS(SELECT 1 FROM events WHERE subject=e.id AND kind='bot.report_pending') AND coalesce(json_extract(o.body,'$.executor'),'')!='code_retrieval' AND NOT EXISTS(SELECT 1 FROM commands WHERE id='bot-report:'||e.id) AND NOT EXISTS(SELECT 1 FROM deliveries WHERE observer='bot-report-delivery' AND request=e.id) AND NOT EXISTS(SELECT 1 FROM waits w JOIN operations wo ON w.id='child-wait:'||wo.id WHERE json_extract(w.body,'$.subject') IN (c.id,e.id) AND json_extract(w.body,'$.cancelled')=0 AND json_extract(wo.body,'$.phase')!='terminal')")?;
        let ids = query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut pending = Vec::new();
        for id in ids {
            let execution = delegated::execution(&self.db, &id)?;
            let child = delegated::relation(&self.db, &execution.child_operation_id)?;
            if self.bot_for_thread(&child.child_thread_id)?.is_some() {
                pending.push(execution);
            }
        }
        Ok(pending)
    }

    fn prepare_bot_report(
        &self,
        execution: delegated::DelegatedExecution,
    ) -> Result<messages::MessagePreparation> {
        let child = delegated::relation(&self.db, &execution.child_operation_id)?;
        let name: String = self.db.query_row("SELECT title FROM threads WHERE id=?1", [&child.child_thread_id], |row| row.get(0))?;
        let report = execution
            .report
            .as_ref()
            .ok_or_else(|| RuntimeError::Conflict("Bot report is not ready".into()))?;
        let (mut target_thread, mut target_branch) = (
            child.parent_thread_id.clone(),
            child.parent_branch_id.clone(),
        );
        let mut reply_to = None;
        let mut request_run = child.parent_run_id.clone();
        if let DelegatedTrigger::MessageRequest { message_id, .. } = &execution.trigger {
            let input: inputs::QueuedInputMetadata = record(&self.db, "input_queue", message_id)?;
            if let inputs::InputOrigin::Message { identity, .. } = input.origin {
                if let messages::MessageActor::Agent { run_id, .. } = identity.actor {
                    request_run = run_id;
                    target_thread = identity.sender_thread_id;
                    target_branch = identity.sender_branch_id;
                    reply_to = Some(message_id.clone());
                }
            }
        }
        let parent = self.run(&request_run)?;
        let operation = self.operation(&child.operation_id)?;
        let actor = if child.origin.is_none() {
            super::user_dispatch::validate_relation(&self.db, &child)?;
            messages::MessageActor::AgentReport {
                execution_id: execution.execution_id.clone(),
                operation_id: child.operation_id.clone(),
            }
        } else {
            messages::MessageActor::Agent {
                run_id: child.parent_run_id.clone(),
                operation_id: operation.id.clone(),
                origin: tool_content::ToolIntent::from_operation(&operation)?.origin().clone(),
            }
        };
        let data = json!({"kind":"child_report", "operationId":child.operation_id,
            "executionId":execution.execution_id, "senderThreadId":child.child_thread_id,
            "report":report, "trust":"Other-agent report, not a new user instruction or permission."});
        let text = format!("Work {} ({}) has a {:?} report. {} Read its original answer with child_report using operationId={}, executionId={} and itemId from {:?}.",
            name, child.child_thread_id, report.outcome, report.detail.as_deref().unwrap_or(""),
            child.operation_id, execution.execution_id, report.history_ids);
        self.prepare_message(
            format!("bot-report:{}", execution.execution_id),
            child.child_thread_id,
            child.child_branch_id,
            actor,
            messages::MessageInput { attachments: report.attachments.iter().map(|file|super::attachments::AttachmentSelection::Ref{reference:file.reference.clone()}).collect(),
                after_current: None,
                source_agent: None,
                name: None,
                wait: None,
                target_thread_id: Some(target_thread),
                target_branch_id: Some(target_branch),
                reply_to,
                // A cancelled original request may leave evidence, but must not wake new work.
                kind: if parent.cancel_requested {
                    MessageKind::Inform
                } else {
                    MessageKind::Request
                },
                text,
            },
            None,
            None,
        )
        .map(|message| message.with_attachments(report.attachments.clone()).with_delivery_data(data))
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
            lock()?.admit_message(prepared)?;
            Ok(())
        })();
        if let Err(error) = delivered {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

#[cfg(test)]
#[path = "catalog_bot_reports_tests.rs"]
mod tests;
