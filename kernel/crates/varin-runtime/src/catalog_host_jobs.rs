//! Trusted Host domain handoffs. Catalog owns invocation/observation facts; the domain owns work.
use super::*;
use crate::execution::CompletionKind;
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostJobBinding {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub domain: String,
    pub domain_version: u64,
    pub workspace_id: String,
    pub subject_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostJobLink {
    pub binding: HostJobBinding,
    /// Null is a dispatched domain intent, never an acceptance or a stopped receipt.
    pub acceptance_ref: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostJobOrigin {
    Tool {
        origin: crate::execution::ToolOrigin,
        call_id: String,
        tool_name: String,
        schema_version: String,
    },
    User {
        key: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostJobPending {
    pub binding: HostJobBinding,
    pub run_id: String,
    pub accepted: bool,
    pub cancel_requested: bool,
    pub phase: OperationPhase,
    pub executor_stopped: bool,
    pub origin: HostJobOrigin,
}
/// Discovery metadata only. source_run_id is target attribution, never a continuation source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostJobSource {
    pub observation_kinds: Vec<String>,
    pub binding: HostJobBinding,
    pub source_run_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub cancel_requested: bool,
    pub phase: OperationPhase,
    pub executor_stopped: bool,
    pub origin: HostJobOrigin,
}
impl HostJobPending {
    pub fn from_operation(op: Operation) -> Result<Self> {
        let link = op
            .host_job
            .clone()
            .ok_or_else(|| RuntimeError::Invalid("Host domain link missing".into()))?;
        let origin = if op.intent["kind"] == "tool" {
            let intent = tool_content::ToolIntent::from_operation(&op)?;
            HostJobOrigin::Tool {
                origin: intent.origin().clone(),
                call_id: intent.call().call_id.clone(),
                tool_name: intent.call().name.clone(),
                schema_version: intent.call().schema_version.clone(),
            }
        } else {
            let intent: UserJobIntent = serde_json::from_value(op.intent)?;
            HostJobOrigin::User { key: intent.key }
        };
        Ok(Self {
            binding: link.binding,
            run_id: op.run_id,
            accepted: link.acceptance_ref.is_some(),
            cancel_requested: op.cancel_requested,
            phase: op.phase,
            executor_stopped: op
                .external_receipt
                .as_ref()
                .is_some_and(|r| r.executor_stopped),
            origin,
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchScope {
    pub root_thread_id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub source_run_id: String,
    pub source: launches::SourceSelection,
    pub can_submit: bool,
    pub read_thread_ids: Vec<String>,
    pub control_thread_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UserJobIntent {
    pub kind: String,
    pub thread_id: String,
    pub branch_id: String,
    pub source_run_id: String,
    pub subject_id: String,
    pub key: String,
    pub domain: String,
    pub domain_version: u64,
    pub source: launches::SourceSelection,
    pub request_ref: Value,
}
fn descendants(db: &Connection, owner: &str) -> Result<BTreeSet<String>> {
    let mut query = db.prepare("WITH RECURSIVE family(id) AS (SELECT ?1 UNION SELECT c.child_thread_id FROM child_tasks c JOIN family f ON json_extract(c.body,'$.parent_thread_id')=f.id) SELECT id FROM family")?;
    let rows = query.query_map([owner], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<BTreeSet<_>, _>>()?)
}

pub(super) fn scopes(
    db: &Connection,
    thread: &str,
    branch: &str,
    source_run: Option<&str>,
) -> Result<Vec<ResearchScope>> {
    let actual: String = db
        .query_row(
            "SELECT thread_id FROM branches WHERE id=?1",
            [branch],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| RuntimeError::NotFound("research branch".into()))?;
    if actual != thread {
        return Err(RuntimeError::Conflict(
            "research branch belongs to another Thread".into(),
        ));
    }
    let root = scheduling::thread_family(db, thread)?;
    let read = descendants(db, &root)?.into_iter().collect::<Vec<_>>();
    let control = descendants(db, thread)?.into_iter().collect::<Vec<_>>();
    let mut out = Vec::new();
    let mut query=db.prepare("SELECT r.body FROM runs r JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=?1 AND (?2 IS NULL OR r.id=?2) ORDER BY r.rowid")?;
    let rows = query.query_map(params![thread, source_run], |r| r.get::<_, String>(0))?;
    for raw in rows {
        let run: Run = serde_json::from_str(&raw?)?;
        let Some(launch) =
            optional_record::<launch_content::LaunchMetadata>(db, "run_launches", &run.id)?
        else {
            continue;
        };
        if let Some(source) = launch.selection.source {
            out.push(ResearchScope {
                root_thread_id: root.clone(),
                thread_id: thread.into(),
                branch_id: branch.into(),
                source_run_id: run.id.clone(),
                source,
                can_submit: run.branch_id == branch,
                read_thread_ids: read.clone(),
                control_thread_ids: control.clone(),
            });
        }
    }
    if source_run.is_some() && out.is_empty() {
        return Err(RuntimeError::NotFound(
            "original research source Run".into(),
        ));
    }
    Ok(out)
}
impl Catalog {
    pub fn research_scopes(
        &self,
        thread: &str,
        branch: &str,
        source_run: Option<&str>,
        operation: Option<&str>,
    ) -> Result<Vec<ResearchScope>> {
        if let Some(id) = operation {
            let op = self.operation(id)?;
            let run = self.run(&op.run_id)?;
            let intent = tool_content::ToolIntent::from_operation(&op)?;
            if run.thread_id != thread
                || run.branch_id != branch
                || source_run != Some(run.id.as_str())
                || run.cancel_requested
                || run.state.terminal()
                || op.cancel_requested
                || op.phase != OperationPhase::Running
                || !matches!(op.execution_owner, Some(ExecutorOwner::External { .. }))
                || intent.call().name != op.executor.as_deref().unwrap_or("")
            {
                return Err(RuntimeError::Conflict(
                    "research invocation is not the original active tool".into(),
                ));
            }
        }
        scopes(&self.db, thread, branch, source_run)
    }
    pub fn admit_user_host_job(
        &mut self,
        thread: &str,
        branch: &str,
        source_run: &str,
        key: &str,
        domain: &str,
        version: u64,
        subject: &str,
        prepared: result_content::PreparedOperationResult,
    ) -> Result<Operation> {
        if key.trim().is_empty() || domain.trim().is_empty() || subject.is_empty() || version == 0 {
            return Err(RuntimeError::Invalid(
                "User job requires a stable key and domain".into(),
            ));
        }
        let identity = crate::content::ContentStore::reference(&json!([thread, branch, key]))?;
        let id = format!(
            "user-host-job:{}",
            identity["content_object"]
                .as_str()
                .ok_or_else(|| RuntimeError::Invalid("content identity".into()))?
        );
        let scope = scopes(&self.db, thread, branch, Some(source_run))?.remove(0);
        if !scope.can_submit {
            return Err(RuntimeError::Conflict(
                "Historical source is readable but is not an execution source for this branch"
                    .into(),
            ));
        }
        let intent = UserJobIntent {
            kind: "user_host_job".into(),
            thread_id: thread.into(),
            branch_id: branch.into(),
            source_run_id: source_run.into(),
            key: key.into(),
            subject_id: subject.into(),
            domain: domain.into(),
            domain_version: version,
            source: scope.source.clone(),
            request_ref: prepared.reference,
        };
        let value = serde_json::to_value(&intent)?;
        let tx = self.db.transaction()?;
        if let Some(old) = optional_record::<Operation>(&tx, "operations", &id)? {
            if old.intent != value {
                return Err(RuntimeError::Conflict(
                    "User job key is already bound to another intent".into(),
                ));
            }
            return Ok(old);
        }
        let existing:Option<String>=tx.query_row("SELECT id FROM operations WHERE json_extract(body,'$.host_job.binding.domain')=?1 AND json_extract(body,'$.host_job.binding.workspaceId')=?2 AND json_extract(body,'$.host_job.binding.subjectId')=?3 LIMIT 1",params![domain,scope.source.workspace_id,subject],|r|r.get(0)).optional()?;
        if let Some(existing) = existing {
            return Err(RuntimeError::Conflict(format!(
                "Submission identity already belongs to original Operation {existing}"
            )));
        }
        // A source Run is attribution only. The independent User command owner takes
        // responsibility now; handed_off does not assert domain acceptance (the ref stays null).
        // This command must never hold the model Run foreground open.
        let op = Operation {
            host_job: Some(HostJobLink {
                binding: HostJobBinding {
                    operation_id: id.clone(),
                    execution_owner: ExecutorOwner::External {
                        identity: domain.into(),
                        epoch: id.clone(),
                    },
                    domain: domain.into(),
                    domain_version: version,
                    workspace_id: scope.source.workspace_id,
                    subject_id: subject.into(),
                },
                acceptance_ref: None,
            }),
            external_receipt: None,
            call_completion: None,
            id: id.clone(),
            run_id: source_run.into(),
            epoch: self.epoch,
            revision: 1,
            phase: OperationPhase::Running,
            outcome: None,
            effect: Effect::Dispatched,
            cancel_requested: false,
            lifetime: Lifetime::Thread,
            handed_off: true,
            executor: Some(domain.into()),
            execution_owner: Some(ExecutorOwner::External {
                identity: domain.into(),
                epoch: id.clone(),
            }),
            waiting_on: None,
            intent: value,
            result: None,
        };
        tx.execute(
            "INSERT INTO operations(id,run_id,body) VALUES(?1,?2,?3)",
            params![id, source_run, encode(&op)?],
        )?;
        event(
            &tx,
            &id,
            1,
            "host_job.user_accepted",
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn begin_host_job(&mut self, binding: HostJobBinding) -> Result<Operation> {
        if binding.domain.is_empty()
            || binding.domain_version == 0
            || binding.workspace_id.is_empty()
            || binding.subject_id.is_empty()
            || !matches!(&binding.execution_owner, ExecutorOwner::External { .. })
            || !binding.execution_owner.validate()
        {
            return Err(RuntimeError::Invalid(
                "Host job requires a complete original domain binding".into(),
            ));
        }
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &binding.operation_id)?;
        if op.execution_owner.as_ref() != Some(&binding.execution_owner)
            || !matches!(op.lifetime, Lifetime::Thread | Lifetime::Environment)
        {
            return Err(RuntimeError::Conflict(
                "Host job original execution owner or lifetime changed".into(),
            ));
        }
        let tool = if op.intent["kind"] == "tool" {
            let intent = tool_content::ToolIntent::from_operation(&op)?;
            if intent.contract().completion != CompletionKind::Job {
                return Err(RuntimeError::Conflict(
                    "Selected tool is not a Job declaration".into(),
                ));
            }
            Some(intent)
        } else {
            let intent: UserJobIntent = serde_json::from_value(op.intent.clone())?;
            if intent.kind != "user_host_job"
                || intent.domain != binding.domain
                || intent.domain_version != binding.domain_version
            {
                return Err(RuntimeError::Conflict(
                    "User Host job domain changed".into(),
                ));
            }
            None
        };
        let launch: launch_content::LaunchMetadata = record(&tx, "run_launches", &op.run_id)?;
        if launch
            .selection
            .source
            .as_ref()
            .map(|s| s.workspace_id.as_str())
            != Some(binding.workspace_id.as_str())
        {
            return Err(RuntimeError::Conflict(
                "Host job workspace differs from its original source".into(),
            ));
        }
        let _ = tool;
        if let Some(prior) = &op.host_job {
            if prior.binding != binding {
                return Err(RuntimeError::Conflict("Host domain intent changed".into()));
            }
            return Ok(op);
        }
        let existing:Option<String>=tx.query_row("SELECT body FROM operations WHERE json_extract(body,'$.host_job.binding.domain')=?1 AND json_extract(body,'$.host_job.binding.workspaceId')=?2 AND json_extract(body,'$.host_job.binding.subjectId')=?3 LIMIT 1",params![binding.domain,binding.workspace_id,binding.subject_id],|r|r.get(0)).optional()?;
        if let Some(existing) = existing {
            return Ok(serde_json::from_str(&existing)?);
        }
        if op.cancel_requested
            || op.phase != OperationPhase::Running
            || op.call_completion.is_some()
        {
            return Err(RuntimeError::Conflict(
                "Host domain invocation is no longer dispatchable".into(),
            ));
        }
        op.host_job = Some(HostJobLink {
            binding,
            acceptance_ref: None,
        });
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "host_job.dispatched",
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn accept_host_job(
        &mut self,
        binding: HostJobBinding,
        prepared: result_content::PreparedOperationResult,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &binding.operation_id)?;
        let linked = op.host_job.as_ref().ok_or_else(|| {
            RuntimeError::Conflict("Host domain intent was not dispatched".into())
        })?;
        if linked.binding != binding
            || op.execution_owner.as_ref() != Some(&binding.execution_owner)
        {
            return Err(RuntimeError::Conflict(
                "Host job original domain subject changed".into(),
            ));
        }
        if let Some(original) = &linked.acceptance_ref {
            if original != &prepared.reference {
                return Err(RuntimeError::Conflict(
                    "Host job accepted body changed".into(),
                ));
            }
            return Ok(op);
        }
        if op
            .external_receipt
            .as_ref()
            .is_some_and(|r| r.executor_stopped && r.effect == Effect::None)
        {
            return Err(RuntimeError::Conflict(
                "Domain dispatch already proved unaccepted and drained".into(),
            ));
        }
        let tool = if op.intent["kind"] == "tool" {
            Some(tool_content::ToolIntent::from_operation(&op)?)
        } else {
            None
        };
        let completion = result_content::ToolCompletionMetadata::JobAccepted {
            operation_id: op.id.clone(),
            phase: "accepted".into(),
            effect: Effect::Confirmed,
            lifetime: op.lifetime,
            content_ref: Some(prepared.reference.clone()),
        };
        // A previously delivered Unknown remains historical. It is not permission to resubmit.
        if op.call_completion.is_none() {
            op.call_completion = tool.as_ref().map(|_| completion.clone());
            if let Some(admitted) = &tool {
                if let crate::execution::ToolOrigin::ModelStep { request_id } = admitted.origin() {
                    let receipt = result_content::ToolReceiptMetadata {
                        request_id: request_id.clone(),
                        call_id: admitted.call().call_id.clone(),
                        completion: completion.clone(),
                    };
                    tx.execute("UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2 AND receipt IS NULL",
                        params![request_id,admitted.call().call_id,encode(&receipt)?])?;
                }
            }
        }
        op.host_job.as_mut().expect("checked link").acceptance_ref =
            Some(prepared.reference.clone());
        op.handed_off = true;
        op.effect = Effect::Confirmed;
        op.revision += 1;
        op.result = Some(OperationResultMetadata::Content {
            reference: prepared.reference,
        });
        if let Some(receipt) = op.external_receipt.clone() {
            execution_persistence::apply_external_terminal(&mut op, &receipt);
        } else {
            op.phase = OperationPhase::Running;
            op.outcome = None;
        }
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "host_job.accepted",
            serde_json::to_value(&op)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn pending_host_jobs(&self) -> Result<Vec<Operation>> {
        let mut query=self.db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.host_job') IS NOT NULL AND (coalesce(json_extract(body,'$.external_receipt.executor_stopped'),0)=0 OR json_extract(body,'$.phase')!='terminal') ORDER BY rowid")?;
        let rows = query.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|raw| Ok(serde_json::from_str(&raw?)?)).collect()
    }
    pub fn record_host_job_terminal(
        &mut self,
        binding: &HostJobBinding,
        prepared: result_content::PreparedExternalReceipt,
        stopped: bool,
    ) -> Result<Operation> {
        let op = self.operation(&binding.operation_id)?;
        if op.host_job.as_ref().map(|link| &link.binding) != Some(binding)
            || op.execution_owner.as_ref() != Some(&binding.execution_owner)
        {
            return Err(RuntimeError::Conflict(
                "Host job terminal does not match its original binding".into(),
            ));
        }
        self.record_external_receipt_prepared(&op.id, prepared, stopped)
    }
    pub fn host_job_acceptance(&self, id: &str) -> Result<result_content::ToolCompletionRead> {
        let op = self.operation(id)?;
        if op.host_job.is_none()
            && !op
                .waiting_on
                .as_deref()
                .is_some_and(|v| v.starts_with(WAIT_PREFIX))
        {
            return Err(RuntimeError::Conflict(
                "Host job has no trusted acceptance".into(),
            ));
        }
        let completion = if let Some(link) = op.host_job {
            result_content::ToolCompletionMetadata::JobAccepted {
                operation_id: op.id.clone(),
                phase: "accepted".into(),
                effect: Effect::Confirmed,
                lifetime: op.lifetime,
                content_ref: Some(link.acceptance_ref.ok_or_else(|| {
                    RuntimeError::Conflict("Domain subject has not accepted work".into())
                })?),
            }
        } else {
            op.call_completion
                .ok_or_else(|| RuntimeError::NotFound("Host tool acceptance".into()))?
        };
        Ok(result_content::ToolCompletionRead {
            completion,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}

pub(super) fn observation_kinds(binding: &HostJobBinding) -> Vec<String> {
    let mut kinds = vec!["job_stopped".into()];
    if binding.domain == "research.experiment" && binding.domain_version == 1 {
        kinds.extend(["artifact".into(), "collection".into()]);
    }
    kinds
}
pub(super) fn require_observation(
    db: &Connection,
    run: &Run,
    target_id: &str,
) -> Result<Operation> {
    let target: Operation = record(db, "operations", target_id)?;
    let source: Run = record(db, "runs", &target.run_id)?;
    let accepted = target.host_job.as_ref().is_some_and(|link| {
        link.acceptance_ref.is_some()
            && link.binding.operation_id == target.id
            && Some(&link.binding.execution_owner) == target.execution_owner.as_ref()
            && matches!(link.binding.execution_owner, ExecutorOwner::External { .. })
    });
    if !accepted
        || scheduling::thread_family(db, &run.thread_id)?
            != scheduling::thread_family(db, &source.thread_id)?
    {
        return Err(RuntimeError::Conflict(
            "Job is outside the observer's actual task family or lacks its original acceptance"
                .into(),
        ));
    }
    Ok(target)
}
pub(super) fn require_stop_receipt(
    op: &Operation,
    receipt: &ExternalReceiptMetadata,
) -> Result<()> {
    let link = op
        .host_job
        .as_ref()
        .ok_or_else(|| RuntimeError::Invalid("Job binding missing".into()))?;
    let ExecutorOwner::External { epoch, .. } = &link.binding.execution_owner else {
        return Err(RuntimeError::Invalid(
            "Job execution owner is not external".into(),
        ));
    };
    if link.acceptance_ref.is_none()
        || link.binding.operation_id != op.id
        || op.execution_owner.as_ref() != Some(&link.binding.execution_owner)
        || receipt.identity != op.id
        || &receipt.epoch != epoch
        || op.executor.as_deref() != Some(receipt.executor.as_str())
    {
        return Err(RuntimeError::Conflict(
            "Job stop receipt differs from its original accepted binding".into(),
        ));
    }
    Ok(())
}
/// Read the indexed, immutable first stop event, never a later business refinement.
pub(super) fn stop_receipt(
    db: &Connection,
    cursor: u64,
    binding: &HostJobBinding,
    identity: &str,
    epoch: &str,
) -> Result<ExternalReceiptMetadata> {
    #[derive(Deserialize)]
    struct Stop {
        binding: HostJobBinding,
        receipt: ExternalReceiptMetadata,
    }
    let raw: String = db.query_row("SELECT json_extract(data,'$.host_job_stop') FROM events WHERE cursor=?1 AND subject=?2 AND kind='operation.executor_stopped' AND json_extract(data,'$.receipt_identity')=?3 AND json_extract(data,'$.receipt_epoch')=?4",params![sql_number(cursor)?,binding.operation_id,identity,epoch],|r|r.get(0))?;
    let stop: Stop = serde_json::from_str(&raw)?;
    if &stop.binding != binding
        || stop.receipt.identity != identity
        || stop.receipt.epoch != epoch
        || !stop.receipt.executor_stopped
    {
        return Err(RuntimeError::Conflict(
            "Job follow-up evidence differs from original stop event".into(),
        ));
    }
    Ok(stop.receipt)
}
pub const WAIT_PREFIX: &str = "host-job-wait:";
impl Catalog {
    pub fn host_job_sources(&self, run_id: &str) -> Result<Vec<HostJobSource>> {
        let run = self.run(run_id)?;
        let root = scheduling::thread_family(&self.db, &run.thread_id)?;
        let mut out = Vec::new();
        // Traverse only the actual task family and its indexed branch/Run operations.
        // The Operation contains short references; no accepted body or call arguments are loaded.
        let mut query = self.db.prepare("SELECT o.body,r.body FROM branches b JOIN runs r ON r.branch_id=b.id JOIN operations o ON o.run_id=r.id WHERE b.thread_id=?1 AND json_extract(o.body,'$.host_job.acceptanceRef') IS NOT NULL ORDER BY o.rowid")?;
        for thread in descendants(&self.db, &root)? {
            let rows = query.query_map([thread], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (op, source) = row?;
                let op: Operation = serde_json::from_str(&op)?;
                let source: Run = serde_json::from_str(&source)?;
                let pending = HostJobPending::from_operation(op)?;
                out.push(HostJobSource {
                    observation_kinds: observation_kinds(&pending.binding),
                    binding: pending.binding,
                    source_run_id: pending.run_id,
                    thread_id: source.thread_id,
                    branch_id: source.branch_id,
                    cancel_requested: pending.cancel_requested,
                    phase: pending.phase,
                    executor_stopped: pending.executor_stopped,
                    origin: pending.origin,
                });
            }
        }
        Ok(out)
    }
    pub fn require_host_job_observation(&self, run_id: &str, target_id: &str) -> Result<Operation> {
        require_observation(&self.db, &self.run(run_id)?, target_id)
    }
    pub fn wait_for_host_job(&mut self, operation_id: &str, target_id: &str) -> Result<Operation> {
        let current = self.operation(operation_id)?;
        self.require_host_job_observation(&current.run_id, target_id)?;
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let admitted = tool_content::ToolIntent::from_operation(&op)?;
        let id = format!("{WAIT_PREFIX}{}", op.id);
        if let Some(prior) = optional_record::<Wait>(&tx, "waits", &id)? {
            if prior.subject != target_id || prior.run_id != run.id {
                return Err(RuntimeError::Conflict(
                    "Job observation target changed".into(),
                ));
            }
            return Ok(op);
        }
        fence(&run, self.epoch)?;
        if run.cancel_requested
            || run.state.terminal()
            || op.cancel_requested
            || op.phase != OperationPhase::Running
            || admitted.contract().completion != CompletionKind::Job
            || op.lifetime != Lifetime::Thread
            || !matches!(op.execution_owner, Some(ExecutorOwner::External { .. }))
        {
            return Err(RuntimeError::Conflict(
                "Job observation requires its original active selected invocation".into(),
            ));
        }
        let trigger_cursor=tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='operation.executor_stopped' ORDER BY cursor DESC LIMIT 1",[target_id],|r|read_number(r,0)).optional()?;
        let wait = Wait {
            id: id.clone(),
            run_id: run.id.clone(),
            subject: target_id.into(),
            kind: "operation.executor_stopped".into(),
            after_cursor: 0,
            deadline_at_ms: None,
            trigger_cursor,
            cancelled: false,
        };
        tx.execute(
            "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
            params![id, run.id, encode(&wait)?],
        )?;
        if let Some(cursor) = trigger_cursor {
            Self::enqueue_resume(&tx, &wait, cursor)?;
        }
        op.waiting_on = Some(id);
        op.phase = OperationPhase::Waiting;
        op.effect = Effect::None;
        op.handed_off = true;
        op.revision += 1;
        result_content::publish_job_acceptance(&tx, &mut op, &admitted, "awaiting_job")?;
        put(&tx, "operations", operation_id, &op)?;
        event(
            &tx,
            operation_id,
            op.revision,
            "host_job.wait_registered",
            serde_json::to_value(&wait)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
    pub fn cancel_host_job_wait(&mut self, id: &str) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", id)?;
        let wait_id = op
            .waiting_on
            .as_ref()
            .filter(|v| v.starts_with(WAIT_PREFIX))
            .ok_or_else(|| {
                RuntimeError::Invalid("Operation is not a Host job observation".into())
            })?;
        if op.phase == OperationPhase::Terminal {
            return Ok(op);
        }
        let mut wait: Wait = record(&tx, "waits", wait_id)?;
        if wait.trigger_cursor.is_some() {
            return Ok(op);
        }
        wait.cancelled = true;
        op.cancel_requested = true;
        op.revision += 1;
        put(&tx, "waits", wait_id, &wait)?;
        put(&tx, "operations", id, &op)?;
        event(
            &tx,
            id,
            op.revision,
            "wait.cancelled",
            serde_json::to_value(&wait)?,
        )?;
        tx.commit()?;
        Ok(op)
    }
}
pub(super) fn pending_cancelled(db: &Connection, run: &Run, wait: &Wait) -> Result<bool> {
    let Some(id) = wait.id.strip_prefix(WAIT_PREFIX) else {
        return Ok(false);
    };
    let op: Operation = record(db, "operations", id)?;
    Ok(wait.cancelled
        && wait.run_id == run.id
        && op.run_id == run.id
        && op.phase == OperationPhase::Waiting
        && op.handed_off
        && op.waiting_on.as_deref() == Some(wait.id.as_str())
        && op.call_completion.is_some())
}
