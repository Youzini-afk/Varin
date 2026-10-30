//! Indexed original receipt/delivery metadata for attention. No task or result bodies.
use super::*;
use serde::Deserialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionStoppedExecutor {
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
    pub operation_id: String,
    pub revision: u64,
    pub stopped_cursor: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionDeliveredReport {
    pub parent_thread_id: String,
    pub parent_branch_id: String,
    pub parent_run_id: String,
    pub receiving_run_id: String,
    pub child_operation_id: String,
    pub execution_id: String,
    pub child_thread_id: String,
    pub child_branch_id: String,
    #[serde(default)]
    pub delivered_cursor: u64,
}

/// Called only inside an original successful history/model-delivery transaction.
/// It proves receipt, not comprehension. A ready-but-undelivered report emits nothing.
pub(super) fn record_report_delivery(tx: &Transaction<'_>, receiving: &Run, execution_id: &str) -> Result<()> {
    let execution = delegated::execution(tx, execution_id)?;
    let relation = delegated::relation(tx, &execution.child_operation_id)?;
    if receiving.thread_id != relation.parent_thread_id || receiving.branch_id != relation.parent_branch_id { return Ok(()); }
    let ready: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='child.report_ready')", [execution_id], |r| r.get(0))?;
    if !ready { return Ok(()); }
    let recorded: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='child.report_delivered' AND json_extract(data,'$.receivingRunId')=?2)", params![execution_id, receiving.id], |r| r.get(0))?;
    if recorded { return Ok(()); }
    let fact = AttentionDeliveredReport {
        parent_thread_id: relation.parent_thread_id, parent_branch_id: relation.parent_branch_id, parent_run_id: relation.parent_run_id,
        receiving_run_id: receiving.id.clone(), child_operation_id: relation.operation_id, execution_id: execution_id.into(),
        child_thread_id: relation.child_thread_id, child_branch_id: relation.child_branch_id, delivered_cursor: 0,
    };
    event(tx, execution_id, execution.revision, "child.report_delivered", serde_json::to_value(fact)?)?;
    Ok(())
}

pub(super) fn stopped_executors(db: &Connection, branch_ids: &str, cancel: &dyn Fn() -> bool) -> Result<Vec<AttentionStoppedExecutor>> {
    // The immutable stop indexes exist independently of business success or cancellation.
    let mut query = db.prepare("WITH candidates AS (
      SELECT o.body AS operation,r.body AS run,e.cursor,e.kind,e.data,
        row_number() OVER (PARTITION BY r.branch_id ORDER BY e.cursor DESC) AS rank
      FROM branches b JOIN runs r ON r.branch_id=b.id JOIN operations o ON o.run_id=r.id
      JOIN events e ON e.subject=o.id AND e.kind IN ('operation.executor_stopped','operation.kernel_executor_stopped','operation.invocation_executor_stopped')
      WHERE b.id IN (SELECT value FROM json_each(?1))
        AND ((e.kind='operation.executor_stopped' AND json_extract(o.body,'$.external_receipt.executor_stopped')=1
          AND json_extract(e.data,'$.receipt_identity')=json_extract(o.body,'$.external_receipt.identity')
          AND json_extract(e.data,'$.receipt_epoch')=json_extract(o.body,'$.external_receipt.epoch')
          AND json_extract(e.data,'$.executor')=json_extract(o.body,'$.external_receipt.executor')
          AND json_extract(o.body,'$.executor')=json_extract(o.body,'$.external_receipt.executor'))
        OR (e.kind!='operation.executor_stopped' AND json_extract(e.data,'$.operationEpoch')=json_extract(o.body,'$.epoch')
          AND json_extract(e.data,'$.executionOwner.kind') IS json_extract(o.body,'$.execution_owner.kind')
          AND json_extract(e.data,'$.executionOwner.identity') IS json_extract(o.body,'$.execution_owner.identity')
          AND json_extract(e.data,'$.executionOwner.epoch') IS json_extract(o.body,'$.execution_owner.epoch')
          AND NOT (e.kind='operation.invocation_executor_stopped' AND json_extract(o.body,'$.execution_owner.kind')='kernel' AND json_extract(o.body,'$.effect')='unknown'))))
      SELECT operation,run,cursor,kind,data FROM candidates WHERE rank=1 ORDER BY cursor")?;
    let mut results = std::collections::BTreeMap::new();
    for row in query.query_map([branch_ids], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,read_number(r,2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))? {
        if cancel() { return Err(RuntimeError::DispatchCancelled); }
        let (op, run, cursor, kind, data) = row?;
        let op: Operation = serde_json::from_str(&op)?;
        let run: Run = serde_json::from_str(&run)?;
        let data: Value = serde_json::from_str(&data)?;
        let proven = if kind == "operation.executor_stopped" {
            op.external_receipt.as_ref().is_some_and(|receipt| receipt.executor_stopped
                && data["receipt_identity"] == receipt.identity && data["receipt_epoch"] == receipt.epoch
                && data["executor"] == receipt.executor && op.executor.as_deref() == Some(receipt.executor.as_str()))
        } else {
            !(kind == "operation.invocation_executor_stopped" && op.execution_owner == Some(ExecutorOwner::Kernel) && op.effect == Effect::Unknown)
                && data["operationEpoch"].as_u64() == Some(op.epoch)
                && op.execution_owner.as_ref().is_some_and(|owner| serde_json::to_value(owner).ok().as_ref() == Some(&data["executionOwner"]))
        };
        if proven {
            results.entry(op.id.clone()).or_insert(AttentionStoppedExecutor { thread_id: run.thread_id, branch_id: run.branch_id,
                run_id: run.id, operation_id: op.id, revision: op.revision, stopped_cursor: cursor });
        }
    }
    Ok(results.into_values().collect())
}
pub(super) fn delivered_reports(db: &Connection, branch_ids: &str, cancel: &dyn Fn() -> bool) -> Result<Vec<AttentionDeliveredReport>> {
    let mut query = db.prepare("WITH candidates AS (
      SELECT e.cursor,e.data,row_number() OVER (PARTITION BY r.branch_id ORDER BY e.cursor DESC) AS rank
      FROM child_tasks c JOIN delegated_executions d ON d.child_operation_id=c.id
      JOIN events e ON e.subject=d.id AND e.kind='child.report_delivered'
      JOIN runs r ON r.id=json_extract(e.data,'$.receivingRunId') JOIN branches b ON b.id=r.branch_id
      WHERE b.id IN (SELECT value FROM json_each(?1))
        AND (r.id=b.active_run OR r.id=(SELECT id FROM runs WHERE branch_id=b.id ORDER BY rowid DESC LIMIT 1)))
      SELECT cursor,data FROM candidates WHERE rank=1 ORDER BY cursor")?;
    let mut reports = Vec::new();
    for row in query.query_map([branch_ids], |r| Ok((read_number(r,0)?,r.get::<_,String>(1)?)))? {
        if cancel() { return Err(RuntimeError::DispatchCancelled); }
        let (cursor, data) = row?;
        let mut fact: AttentionDeliveredReport = serde_json::from_str(&data)?;
        // Original relationship and receiver identities remain authoritative.
        let relation = delegated::relation(db, &fact.child_operation_id)?;
        let receiver: Run = record(db, "runs", &fact.receiving_run_id)?;
        let execution = delegated::execution(db, &fact.execution_id)?;
        if relation.parent_run_id == fact.parent_run_id && relation.parent_thread_id == fact.parent_thread_id
            && relation.parent_branch_id == fact.parent_branch_id && relation.child_thread_id == fact.child_thread_id
            && relation.child_branch_id == fact.child_branch_id && execution.child_operation_id == fact.child_operation_id
            && receiver.thread_id == fact.parent_thread_id && receiver.branch_id == fact.parent_branch_id {
            fact.delivered_cursor = cursor; reports.push(fact);
        }
    }
    Ok(reports)
}
