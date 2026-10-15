//! Native desktop requests are short Catalog facts. Physical assignments remain in ComputerService.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerExecution {
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAccess {
    Observe,
    Control,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ComputerDecisionActor {
    Tool {
        operation_id: String,
    },
    User {
        thread_id: String,
        branch_id: String,
        key: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerDecisionClaim {
    pub actor: ComputerDecisionActor,
    pub manager: Option<ComputerExecution>,
    pub host_epoch: String,
    pub assignment_id: String,
    pub approved: bool,
    pub reason_ref: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ComputerRequestCancelTarget {
    Requests {
        request_ids: Vec<String>,
    },
    Execution {
        execution: ComputerExecution,
        family: bool,
        desktop_id: Option<String>,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerRequestStatus {
    Pending,
    Granting,
    Granted,
    Denied,
    Cancelled,
    Indeterminate,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComputerRequestRecord {
    pub id: String,
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub requester: ComputerExecution,
    pub root_thread_id: String,
    pub root_branch_id: String,
    pub desktop_id: String,
    pub access: ComputerAccess,
    pub revision: u64,
    pub status: ComputerRequestStatus,
    pub created_at_ms: u64,
    pub request_ref: Value,
    pub detail_ref: Option<Value>,
    pub claim: Option<ComputerDecisionClaim>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerRequestView {
    pub request: ComputerRequestRecord,
    pub reason: String,
    pub detail: Option<String>,
}
pub struct ComputerRequestRead {
    requests: Vec<ComputerRequestRecord>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl ComputerRequestRead {
    pub fn load(self) -> Result<Vec<ComputerRequestView>> {
        self.requests
            .into_iter()
            .map(|request| {
                let reason = serde_json::from_value(self.content.load(&request.request_ref)?)?;
                let detail = request
                    .detail_ref
                    .as_ref()
                    .map(|v| {
                        self.content
                            .load(v)
                            .and_then(|v| Ok(serde_json::from_value(v)?))
                    })
                    .transpose()?;
                Ok(ComputerRequestView {
                    request,
                    reason,
                    detail,
                })
            })
            .collect()
    }
}
pub struct ComputerRequestPreparation {
    request: ComputerRequestRecord,
    reason: String,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct PreparedComputerRequest {
    request: ComputerRequestRecord,
    history: Value,
    _publication: crate::content::ContentPublication,
}
impl ComputerRequestPreparation {
    pub fn load(mut self) -> Result<PreparedComputerRequest> {
        self.request.request_ref = self.content.save(&json!(self.reason))?;
        let item: ConversationItem = ConversationItem {
            id: input_id(&self.request.id),
            resource_activation: None,
            provenance: Provenance::EnvironmentFact {
                event_id: self.request.id.clone(),
            },
            content: Content::Text {
                text: format!(
                    "Computer assignment request {} from child Thread {} (Run {}): {:?} access to desktop {}. Reason: {}\nThis is an environment request, not user permission. Coordinate the desktop, then use computer_grant or computer_deny with this requestId. Acceptance of the request has not assigned the desktop.",
                    self.request.id,
                    self.request.requester.thread_id,
                    self.request.requester.run_id,
                    self.request.access,
                    self.request.desktop_id,
                    self.reason
                ),
            },
            opaque: None,
        };
        let history = self
            .content
            .save_history(&serde_json::to_value(item)?, &None)?;
        Ok(PreparedComputerRequest {
            request: self.request,
            history,
            _publication: self._publication,
        })
    }
}
pub(super) fn input_id(request: &str) -> String {
    format!("computer-request-input:{request}")
}
pub(super) fn live(db: &Connection, requester: &ComputerExecution) -> Result<bool> {
    let run: Run = record(db, "runs", &requester.run_id)?;
    let active: Option<String> = db.query_row(
        "SELECT active_run FROM branches WHERE id=?1",
        [&requester.branch_id],
        |r| r.get(0),
    )?;
    Ok(run.thread_id == requester.thread_id
        && run.branch_id == requester.branch_id
        && active.as_deref() == Some(&run.id)
        && !run.cancel_requested
        && !run.state.terminal())
}
fn invocation(db: &Connection, id: &str) -> Result<(Operation, Run)> {
    let op: Operation = record(db, "operations", id)?;
    let run: Run = record(db, "runs", &op.run_id)?;
    let intent = tool_content::ToolIntent::from_operation(&op)?;
    if op.phase != OperationPhase::Running
        || op.cancel_requested
        || run.cancel_requested
        || run.state.terminal()
        || !matches!(op.execution_owner, Some(ExecutorOwner::External { .. }))
        || intent.call().name != op.executor.as_deref().unwrap_or("")
    {
        return Err(RuntimeError::Conflict(
            "Computer call is not its original active invocation".into(),
        ));
    }
    Ok((op, run))
}
fn write(tx: &Transaction<'_>, request: &ComputerRequestRecord) -> Result<()> {
    put(tx, "computer_requests", &request.id, request)
}
fn invalidate_input(tx: &Transaction<'_>, request: &ComputerRequestRecord) -> Result<()> {
    let mut row: inputs::QueuedInputMetadata = record(tx, "input_queue", &input_id(&request.id))?;
    activation::cancel_row(tx, &mut row)
}
fn resolved(
    tx: &Transaction<'_>,
    request: &mut ComputerRequestRecord,
    status: ComputerRequestStatus,
) -> Result<()> {
    request.status = status;
    request.revision += 1;
    write(tx, request)?;
    invalidate_input(tx, request)?;
    event(
        tx,
        &request.id,
        request.revision,
        "computer.request_decided",
        serde_json::to_value(&request)?,
    )?;
    Ok(())
}
pub(super) fn ingress_hold(
    db: &Connection,
    row: &inputs::QueuedInputMetadata,
) -> Result<Option<String>> {
    let inputs::InputOrigin::ComputerRequest { request_id, .. } = &row.origin else {
        return Ok(None);
    };
    let request: ComputerRequestRecord = record(db, "computer_requests", request_id)?;
    Ok((!matches!(
        request.status,
        ComputerRequestStatus::Pending | ComputerRequestStatus::Granting
    ) || !live(db, &request.requester)?)
    .then(|| "computer_request_unavailable".into()))
}
impl Catalog {
    pub fn prepare_computer_request(
        &self,
        operation: &str,
        desktop: String,
        access: ComputerAccess,
        reason: String,
        now: u64,
    ) -> Result<ComputerRequestPreparation> {
        if desktop.trim().is_empty() || reason.trim().is_empty() {
            return Err(RuntimeError::Invalid(
                "Computer request requires a desktop and reason".into(),
            ));
        }
        let (op, run) = invocation(&self.db, operation)?;
        let scope = self.computer_scope(
            &run.thread_id,
            &run.branch_id,
            Some(&run.id),
            Some(operation),
        )?;
        if scope.root_thread_id == run.thread_id {
            return Err(RuntimeError::Conflict(
                "Only a child requests an assignment from its root".into(),
            ));
        }
        let request = ComputerRequestRecord {
            id: format!("computer-request:{operation}"),
            operation_id: op.id,
            execution_owner: op.execution_owner.expect("validated"),
            requester: ComputerExecution {
                thread_id: run.thread_id,
                branch_id: run.branch_id,
                run_id: run.id,
            },
            root_thread_id: scope.root_thread_id,
            root_branch_id: scope.root_branch_id,
            desktop_id: desktop,
            access,
            revision: 1,
            status: ComputerRequestStatus::Pending,
            created_at_ms: now,
            request_ref: Value::Null,
            detail_ref: None,
            claim: None,
        };
        Ok(ComputerRequestPreparation {
            request,
            reason,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn admit_computer_request(
        &mut self,
        prepared: PreparedComputerRequest,
    ) -> Result<ComputerRequestRecord> {
        let request = prepared.request;
        let tx = self.db.transaction()?;
        if let Some(old) =
            optional_record::<ComputerRequestRecord>(&tx, "computer_requests", &request.id)?
        {
            if old.operation_id != request.operation_id
                || old.execution_owner != request.execution_owner
                || old.desktop_id != request.desktop_id
                || old.access != request.access
                || old.request_ref != request.request_ref
            {
                return Err(RuntimeError::Conflict(
                    "Computer request identity changed".into(),
                ));
            }
            return Ok(old);
        }
        let (op, run) = invocation(&tx, &request.operation_id)?;
        fence(&run, self.epoch)?;
        if op.execution_owner.as_ref() != Some(&request.execution_owner)
            || !live(&tx, &request.requester)?
        {
            return Err(RuntimeError::Conflict(
                "Computer requester changed before acceptance".into(),
            ));
        }
        tx.execute("INSERT INTO computer_requests(id,requester_run_id,root_thread_id,root_branch_id,body) VALUES(?1,?2,?3,?4,?5)",params![request.id,request.requester.run_id,request.root_thread_id,request.root_branch_id,encode(&request)?])?;
        let cursor = event(
            &tx,
            &request.id,
            1,
            "computer.request_accepted",
            serde_json::to_value(&request)?,
        )?;
        let activation =
            activation::accept_target(&tx, &request.root_thread_id, &request.root_branch_id)?;
        ingress::insert_occurrence(
            &tx,
            input_id(&request.id),
            request.root_thread_id.clone(),
            request.root_branch_id.clone(),
            cursor,
            inputs::InputOrigin::ComputerRequest {
                request_id: request.id.clone(),
                requester: request.requester.clone(),
                activation,
            },
            &prepared.history,
        )?;
        tx.commit()?;
        Ok(request)
    }
    pub fn computer_request(&self, id: &str) -> Result<ComputerRequestRecord> {
        record(&self.db, "computer_requests", id)
    }
    pub fn capture_computer_requests(
        &self,
        root_thread: Option<&str>,
        root_branch: Option<&str>,
    ) -> Result<ComputerRequestRead> {
        let mut q=self.db.prepare("SELECT body FROM computer_requests WHERE (?1 IS NULL OR root_thread_id=?1) AND (?2 IS NULL OR root_branch_id=?2) ORDER BY rowid")?;
        let rows = q.query_map(params![root_thread, root_branch], |r| r.get::<_, String>(0))?;
        let requests = rows
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        Ok(ComputerRequestRead {
            requests,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    pub fn begin_computer_decision(
        &mut self,
        id: &str,
        revision: u64,
        actor: ComputerDecisionActor,
        approved: bool,
        host_epoch: String,
        assignment_id: String,
        detail: Option<result_content::PreparedOperationResult>,
    ) -> Result<ComputerRequestRecord> {
        if host_epoch.is_empty() || assignment_id.is_empty() {
            return Err(RuntimeError::Invalid(
                "Computer decision requires the original physical owner claim".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut request: ComputerRequestRecord = record(&tx, "computer_requests", id)?;
        let (thread, branch, manager) = match &actor {
            ComputerDecisionActor::Tool { operation_id } => {
                let (_, run) = invocation(&tx, operation_id)?;
                (
                    run.thread_id.clone(),
                    run.branch_id.clone(),
                    Some(ComputerExecution {
                        thread_id: run.thread_id,
                        branch_id: run.branch_id,
                        run_id: run.id,
                    }),
                )
            }
            ComputerDecisionActor::User {
                thread_id,
                branch_id,
                key,
            } => {
                if key.trim().is_empty() {
                    return Err(RuntimeError::Invalid(
                        "User Computer decision requires a stable command key".into(),
                    ));
                }
                (thread_id.clone(), branch_id.clone(), None)
            }
        };
        if thread != request.root_thread_id || branch != request.root_branch_id {
            return Err(RuntimeError::Conflict(
                "Only the original root work can decide this request".into(),
            ));
        }
        let reason_ref = detail.as_ref().map(|v| v.reference.clone());
        if let Some(claim) = request.claim.as_ref().filter(|claim| claim.actor == actor) {
            if claim.approved != approved || claim.reason_ref != reason_ref {
                return Err(RuntimeError::Conflict(
                    "Computer decision command was reused with different content".into(),
                ));
            }
            return Ok(request);
        }
        if let ComputerDecisionActor::User { key, .. } = &actor {
            let previous:Option<String>=tx.query_row("SELECT id FROM computer_requests WHERE root_thread_id=?1 AND root_branch_id=?2 AND json_extract(body,'$.claim.actor.kind')='user' AND json_extract(body,'$.claim.actor.key')=?3",params![thread,branch,key],|r|r.get(0)).optional()?;
            if previous.is_some_and(|previous| previous != id) {
                return Err(RuntimeError::Conflict(
                    "Computer decision key already belongs to another request".into(),
                ));
            }
        }
        if request.revision != revision || request.status != ComputerRequestStatus::Pending {
            return Err(RuntimeError::Conflict(
                "Computer request revision or decision changed".into(),
            ));
        }
        if !live(&tx, &request.requester)? {
            resolved(&tx, &mut request, ComputerRequestStatus::Cancelled)?;
            tx.commit()?;
            return Ok(request);
        }
        request.claim = Some(ComputerDecisionClaim {
            actor,
            manager,
            host_epoch,
            assignment_id,
            approved,
            reason_ref,
        });
        request.detail_ref = detail.map(|v| v.reference);
        if approved {
            request.status = ComputerRequestStatus::Granting;
            request.revision += 1;
            write(&tx, &request)?;
            event(
                &tx,
                id,
                request.revision,
                "computer.grant_claimed",
                serde_json::to_value(&request)?,
            )?;
        } else {
            resolved(&tx, &mut request, ComputerRequestStatus::Denied)?;
        }
        tx.commit()?;
        Ok(request)
    }
    pub fn settle_computer_decision(
        &mut self,
        id: &str,
        claim: &ComputerDecisionClaim,
        status: ComputerRequestStatus,
        detail: Option<result_content::PreparedOperationResult>,
    ) -> Result<ComputerRequestRecord> {
        if !matches!(
            status,
            ComputerRequestStatus::Granted
                | ComputerRequestStatus::Cancelled
                | ComputerRequestStatus::Indeterminate
        ) {
            return Err(RuntimeError::Invalid(
                "Invalid Computer decision settlement".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut request: ComputerRequestRecord = record(&tx, "computer_requests", id)?;
        if request.claim.as_ref() != Some(claim) {
            return Err(RuntimeError::Conflict(
                "Original Computer assignment claim changed".into(),
            ));
        }
        if request.status != ComputerRequestStatus::Granting {
            return Ok(request);
        }
        if status == ComputerRequestStatus::Granted
            && (!live(&tx, &request.requester)?
                || match &claim.actor {
                    ComputerDecisionActor::Tool { operation_id } => {
                        let op: Operation = record(&tx, "operations", operation_id)?;
                        let run: Run = record(&tx, "runs", &op.run_id)?;
                        op.cancel_requested
                            || op.phase != OperationPhase::Running
                            || run.cancel_requested
                            || run.state.terminal()
                    }
                    ComputerDecisionActor::User { .. } => false,
                })
        {
            resolved(&tx, &mut request, ComputerRequestStatus::Cancelled)?;
        } else {
            request.detail_ref = detail.map(|v| v.reference).or(request.detail_ref);
            resolved(&tx, &mut request, status)?;
        }
        tx.commit()?;
        Ok(request)
    }
    pub fn cancel_computer_requests(&mut self, target: ComputerRequestCancelTarget) -> Result<()> {
        let tx = self.db.transaction()?;
        let ids = match target {
            ComputerRequestCancelTarget::Requests { request_ids } => request_ids,
            ComputerRequestCancelTarget::Execution {
                execution,
                family,
                desktop_id,
            } => {
                let run: Run = record(&tx, "runs", &execution.run_id)?;
                if run.thread_id != execution.thread_id || run.branch_id != execution.branch_id {
                    return Err(RuntimeError::Conflict(
                        "Computer cancellation execution changed".into(),
                    ));
                }
                if family && scheduling::thread_family(&tx, &run.thread_id)? != run.thread_id {
                    return Err(RuntimeError::Conflict(
                        "Only root work can stop its Computer family".into(),
                    ));
                }
                let mut query=tx.prepare("SELECT body FROM computer_requests WHERE (?1=1 AND root_thread_id=?2 AND root_branch_id=?3) OR (?1=0 AND requester_run_id=?4)")?;
                let rows = query
                    .query_map(params![family, run.thread_id, run.branch_id, run.id], |r| {
                        r.get::<_, String>(0)
                    })?;
                let mut ids = vec![];
                for raw in rows {
                    let request: ComputerRequestRecord = serde_json::from_str(&raw?)?;
                    if desktop_id
                        .as_ref()
                        .is_none_or(|id| id == &request.desktop_id)
                    {
                        ids.push(request.id);
                    }
                }
                ids
            }
        };
        for id in &ids {
            let mut request: ComputerRequestRecord = record(&tx, "computer_requests", id)?;
            if matches!(
                request.status,
                ComputerRequestStatus::Pending | ComputerRequestStatus::Granting
            ) {
                resolved(&tx, &mut request, ComputerRequestStatus::Cancelled)?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn reconcile_computer_requests(
        &mut self,
        host_epoch: Option<&str>,
    ) -> Result<Vec<ComputerRequestRecord>> {
        let tx = self.db.transaction()?;
        let mut requests = read_all::<ComputerRequestRecord>(&tx, "computer_requests")?;
        for request in &mut requests {
            if !matches!(
                request.status,
                ComputerRequestStatus::Pending | ComputerRequestStatus::Granting
            ) {
                continue;
            }
            let status = if !live(&tx, &request.requester)? {
                Some(ComputerRequestStatus::Cancelled)
            } else if request.status == ComputerRequestStatus::Granting
                && host_epoch.is_some_and(|epoch| {
                    request
                        .claim
                        .as_ref()
                        .is_some_and(|claim| claim.host_epoch != epoch)
                })
            {
                Some(ComputerRequestStatus::Indeterminate)
            } else {
                None
            };
            if let Some(status) = status {
                resolved(&tx, request, status)?;
            }
        }
        tx.commit()?;
        Ok(requests)
    }
}

/// Follow actual parked child observations, not family membership or a timeout.
fn observes_run(
    db: &Connection,
    run_id: &str,
    target: &str,
    seen: &mut std::collections::BTreeSet<String>,
) -> Result<bool> {
    if run_id == target {
        return Ok(true);
    }
    if !seen.insert(run_id.into()) {
        return Ok(false);
    }
    let run: Run = record(db, "runs", run_id)?;
    if run.state != RunState::Waiting || run.cancel_requested {
        return Ok(false);
    }
    for op in observations::operations(db, Some(run_id))? {
        let Some(id) = op.waiting_on.filter(|id| id.starts_with("child-wait:")) else {
            continue;
        };
        let wait: Wait = record(db, "waits", &id)?;
        if wait.cancelled || wait.trigger_cursor.is_some() {
            continue;
        }
        let child = delegated::execution_task(db, &wait.subject)?;
        if let Some(receipt) = child.receipt {
            if observes_run(db, &receipt.run_id, target, seen)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
pub(super) fn interrupting_request(
    db: &Connection,
    run: &Run,
    wait: &Wait,
) -> Result<Option<String>> {
    if !wait.id.starts_with("child-wait:") || wait.cancelled || wait.trigger_cursor.is_some() {
        return Ok(None);
    }
    let child = delegated::execution_task(db, &wait.subject)?;
    let Some(receipt) = child.receipt else {
        return Ok(None);
    };
    let mut q=db.prepare("SELECT body FROM input_queue WHERE run_id=?1 AND origin='computer_request' AND state='queued' AND activation='activating'")?;
    let rows = q.query_map([&run.id], |r| r.get::<_, String>(0))?;
    for raw in rows {
        let row: inputs::QueuedInputMetadata = serde_json::from_str(&raw?)?;
        let inputs::InputOrigin::ComputerRequest {
            request_id,
            requester,
            ..
        } = row.origin
        else {
            continue;
        };
        let request: ComputerRequestRecord = record(db, "computer_requests", &request_id)?;
        if request.status == ComputerRequestStatus::Pending
            && live(db, &requester)?
            && observes_run(
                db,
                &receipt.run_id,
                &requester.run_id,
                &mut Default::default(),
            )?
        {
            return Ok(Some(request_id));
        }
    }
    Ok(None)
}
impl Catalog {
    pub(super) fn interrupt_computer_dependency(
        &mut self,
        op_id: &str,
        request_id: &str,
    ) -> Result<bool> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", op_id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let Some(id) = op.waiting_on.as_ref() else {
            return Ok(false);
        };
        let mut wait: Wait = record(&tx, "waits", id)?;
        if interrupting_request(&tx, &run, &wait)?.as_deref() != Some(request_id) {
            return Ok(false);
        }
        wait.cancelled = true;
        put(&tx, "waits", &wait.id, &wait)?;
        op.result = Some(OperationResultMetadata::Control {
            value: json!({"interrupted_for_computer_request":request_id}),
        });
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &wait.id,
            op.revision,
            "wait.cancelled",
            json!({"reason":"computer_request","request_id":request_id}),
        )?;
        tx.commit()?;
        Ok(true)
    }
}
