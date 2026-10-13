//! Trusted Host domain handoffs. Catalog owns invocation/observation facts; the domain owns work.
use super::*;
use crate::execution::CompletionKind;
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpEndpoint {
    pub server: String,
    pub resource_key: String,
    pub configuration_version: String,
    pub credential_version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostJobSubject {
    EnvironmentForward {
        host_id: String,
        host_epoch: String,
        target: launches::SourceResourceOwner,
        service_host: String,
        service_port: u16,
    },
    Workspace {
        workspace_id: String,
        subject_id: String,
    },
    Mcp {
        endpoint: McpEndpoint,
        dispatch_id: String,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpTaskStatus {
    Working,
    InputRequired,
    Completed,
    Failed,
    Cancelled,
}
impl McpTaskStatus {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpTaskState {
    pub task_id: String,
    pub status: McpTaskStatus,
    pub created_at: String,
    pub last_updated_at: String,
    pub ttl: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll_interval: Option<u64>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct McpTaskProblem {
    pub kind: crate::McpTaskProblemKind,
    pub stage: crate::McpTaskStage,
    #[serde(skip_serializing_if = "Option::is_none", rename = "rpcCode")]
    pub rpc_code: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpTaskLink {
    pub revision: u64,
    pub task: McpTaskState,
    pub observation_ref: Value,
    pub availability: crate::McpTaskAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<McpTaskProblem>,
    pub result_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_kind: Option<crate::McpTaskResultKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_outcome: Option<Outcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_effect: Option<Effect>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostJobBinding {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub domain: String,
    pub domain_version: u64,
    pub subject: HostJobSubject,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostJobLink {
    pub binding: HostJobBinding,
    /// Null is a dispatched domain intent, never an acceptance or a stopped receipt.
    pub acceptance_ref: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_task: Option<McpTaskLink>,
}
/// Public body projection. Durable records retain only the original content references.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostJobView {
    #[serde(flatten)]
    pub link: HostJobLink,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_task_result: Option<crate::output::OutputBody<crate::output::StoredMedia>>,
}
impl std::ops::Deref for HostJobView {
    type Target = HostJobLink;
    fn deref(&self) -> &Self::Target {
        &self.link
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_task: Option<McpTaskLink>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_task: Option<McpTaskLink>,
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
            mcp_task: link.mcp_task,
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
pub(super) fn descendants(db: &Connection, owner: &str) -> Result<BTreeSet<String>> {
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
        let existing:Option<String>=tx.query_row("SELECT id FROM operations WHERE json_extract(body,'$.host_job.binding.domain')=?1 AND json_extract(body,'$.host_job.binding.subject.workspaceId')=?2 AND json_extract(body,'$.host_job.binding.subject.subjectId')=?3 LIMIT 1",params![domain,scope.source.workspace_id,subject],|r|r.get(0)).optional()?;
        if let Some(existing) = existing {
            return Err(RuntimeError::Conflict(format!(
                "Submission identity already belongs to original Operation {existing}"
            )));
        }
        // A source Run is attribution only. The independent User command owner takes
        // responsibility now; handed_off does not assert domain acceptance (the ref stays null).
        // This command must never hold the model Run foreground open.
        let op = Operation {
            managed_process: None,
            mcp_resource_subscription: None,
            host_job: Some(HostJobLink {
                binding: HostJobBinding {
                    operation_id: id.clone(),
                    execution_owner: ExecutorOwner::External {
                        identity: domain.into(),
                        epoch: id.clone(),
                    },
                    domain: domain.into(),
                    domain_version: version,
                    subject: HostJobSubject::Workspace {
                        workspace_id: scope.source.workspace_id,
                        subject_id: subject.into(),
                    },
                },
                acceptance_ref: None,
                mcp_task: None,
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
        self.begin_host_job_bound(binding, None)
    }
    pub fn begin_environment_forward_job(
        &mut self,
        binding: HostJobBinding,
        snapshot: &tool_content::ToolInvocationSnapshot,
    ) -> Result<Operation> {
        self.validate_tool_invocation(snapshot, true)?;
        let HostJobSubject::EnvironmentForward {
            service_host,
            service_port,
            target,
            ..
        } = &binding.subject
        else {
            return Err(RuntimeError::Conflict("Forward subject required".into()));
        };
        let args = &snapshot.call.arguments;
        let host = args
            .get("host")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("127.0.0.1");
        if snapshot.context.operation_id != binding.operation_id
            || snapshot.call.name != "environment_forward"
            || host != service_host
            || args.get("port").and_then(Value::as_u64) != Some(u64::from(*service_port))
        {
            return Err(RuntimeError::Conflict(
                "Forward differs from the selected invocation".into(),
            ));
        }
        // An explicit target is resolved by the trusted Host registry. Otherwise
        // the original selected Source determines the target, including no Source.
        if args
            .get("target")
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty())
        {
            let expected = snapshot
                .frozen
                .source
                .as_ref()
                .map(|s| s.resource_owner.clone())
                .unwrap_or(launches::SourceResourceOwner::Local);
            if target != &expected {
                return Err(RuntimeError::Conflict(
                    "Forward changed its selected Source owner".into(),
                ));
            }
        }
        self.begin_host_job_bound(binding, None)
    }
    pub fn begin_mcp_host_job(
        &mut self,
        binding: HostJobBinding,
        snapshot: &tool_content::ToolInvocationSnapshot,
        frozen: &launches::HostToolBinding,
    ) -> Result<Operation> {
        self.validate_tool_invocation(snapshot, true)?;
        if snapshot.context.operation_id != binding.operation_id {
            return Err(RuntimeError::Conflict("MCP task invocation changed".into()));
        }
        let HostJobSubject::Mcp { endpoint, .. } = &binding.subject else {
            return Err(RuntimeError::Conflict(
                "MCP dispatch needs an MCP subject".into(),
            ));
        };
        let key = match frozen.routes.get(&snapshot.call.name) {
            Some(crate::McpRoute::DirectTask) => frozen.resources.get(&snapshot.call.name),
            Some(crate::McpRoute::ServerTaskArgument { argument })
                if snapshot
                    .call
                    .arguments
                    .get(argument)
                    .and_then(Value::as_str)
                    == Some(endpoint.server.as_str()) =>
            {
                frozen.resources.get(&format!("server:{}", endpoint.server))
            }
            _ => None,
        };
        if key != Some(&endpoint.resource_key)
            || frozen.provenance.servers.get(&endpoint.server)
                .is_none_or(|server| !server.owner.accepts_source(snapshot.frozen.source.as_ref())) {
            return Err(RuntimeError::Conflict(
                "Task server differs from the selected invocation".into(),
            ));
        }
        self.begin_host_job_bound(binding, Some(frozen))
    }
    fn begin_host_job_bound(
        &mut self,
        binding: HostJobBinding,
        frozen: Option<&launches::HostToolBinding>,
    ) -> Result<Operation> {
        if binding.domain.is_empty()
            || binding.domain_version == 0
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
        match &binding.subject {
            HostJobSubject::EnvironmentForward {
                host_id,
                host_epoch,
                target,
                service_host,
                service_port,
            } => {
                if binding.domain != "environment.forward"
                    || binding.domain_version != 1
                    || host_id.trim().is_empty()
                    || host_epoch.trim().is_empty()
                    || !target.validate()
                    || service_host.trim().is_empty()
                    || *service_port == 0
                    || tool.is_none()
                    || op.lifetime != Lifetime::Thread
                {
                    return Err(RuntimeError::Conflict(
                        "Environment forward lacks its original tool and target binding".into(),
                    ));
                }
            }
            HostJobSubject::Workspace {
                workspace_id,
                subject_id,
            } => {
                let launch: launch_content::LaunchMetadata =
                    record(&tx, "run_launches", &op.run_id)?;
                if workspace_id.is_empty()
                    || subject_id.is_empty()
                    || launch.selection.source.as_ref().map(|s| &s.workspace_id)
                        != Some(workspace_id)
                {
                    return Err(RuntimeError::Conflict(
                        "Host job workspace differs from its original source".into(),
                    ));
                }
                let existing: Option<String> = tx.query_row("SELECT body FROM operations WHERE json_extract(body,'$.host_job.binding.domain')=?1 AND json_extract(body,'$.host_job.binding.subject.workspaceId')=?2 AND json_extract(body,'$.host_job.binding.subject.subjectId')=?3 LIMIT 1", params![binding.domain,workspace_id,subject_id],|r|r.get(0)).optional()?;
                if let Some(existing) = existing {
                    let existing: Operation = serde_json::from_str(&existing)?;
                    if existing.id != op.id {
                        return Ok(existing);
                    }
                }
            }
            HostJobSubject::Mcp {
                endpoint,
                dispatch_id,
            } => {
                let intent = tool.as_ref().ok_or_else(|| {
                    RuntimeError::Conflict("MCP task requires its original tool invocation".into())
                })?;
                // The complete frozen invocation is the authority for server and dispatch mode.
                let frozen = frozen.ok_or_else(|| {
                    RuntimeError::Conflict("MCP task lacks its original frozen binding".into())
                })?;
                let selected = frozen.provenance.servers.get(&endpoint.server);
                if binding.domain != "mcp.task"
                    || binding.domain_version != 1
                    || dispatch_id != &op.id
                    || endpoint.credential_version.is_empty()
                    || intent.contract().resources
                        != vec![crate::execution::ResourceClaim {
                            key: endpoint.resource_key.clone(),
                            access: crate::execution::Access::Write,
                        }]
                    || selected.is_none_or(|s| {
                        s.definition_version != endpoint.configuration_version
                            || s.resource_key != endpoint.resource_key
                    })
                    || !matches!(
                        frozen.routes.get(&intent.call().name),
                        Some(
                            crate::McpRoute::DirectTask
                                | crate::McpRoute::ServerTaskArgument { .. }
                        )
                    )
                {
                    return Err(RuntimeError::Conflict(
                        "MCP task differs from its original dispatch binding".into(),
                    ));
                }
            }
        }
        if let Some(prior) = &op.host_job {
            if prior.binding != binding {
                return Err(RuntimeError::Conflict("Host domain intent changed".into()));
            }
            return Ok(op);
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
            mcp_task: None,
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
        self.accept_host_job_task(binding, prepared, None)
    }
    pub fn accept_host_job_task(
        &mut self,
        binding: HostJobBinding,
        prepared: result_content::PreparedOperationResult,
        task: Option<McpTaskState>,
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
        match (&binding.subject, &task) {
            (
                HostJobSubject::Workspace { .. } | HostJobSubject::EnvironmentForward { .. },
                None,
            ) => {}
            (HostJobSubject::Mcp { .. }, Some(task))
                if !task.task_id.is_empty()
                    && !task.created_at.is_empty()
                    && task.status == McpTaskStatus::Working => {}
            _ => {
                return Err(RuntimeError::Conflict(
                    "Host job acceptance lacks its original subject identity".into(),
                ));
            }
        }
        if let Some(original) = &linked.acceptance_ref {
            if original != &prepared.reference
                || linked
                    .mcp_task
                    .as_ref()
                    .map(|link| (&link.task.task_id, &link.task.created_at))
                    != task.as_ref().map(|task| (&task.task_id, &task.created_at))
            {
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
        if let Some(task) = task {
            op.host_job.as_mut().expect("checked link").mcp_task = Some(McpTaskLink {
                revision: 1,
                task,
                observation_ref: prepared.reference.clone(),
                availability: crate::McpTaskAvailability::Available,
                problem: None,
                result_ready: false,
                result_ref: None,
                result_kind: None,
                result_outcome: None,
                result_effect: None,
            });
            // This proves the originating tools/call dispatch ended, not that its remote Job stopped.
            tx.execute(
                "DELETE FROM resource_occupancy WHERE operation_id=?1",
                [&op.id],
            )?;
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
        self.release_unoccupied_resource_owner(&op.id)?;
        Ok(op)
    }
    pub fn update_mcp_task(
        &mut self,
        binding: &HostJobBinding,
        expected_revision: u64,
        task: McpTaskState,
        availability: crate::McpTaskAvailability,
        problem: Option<McpTaskProblem>,
        result: Option<(
            crate::McpTaskResultKind,
            result_content::PreparedExternalReceipt,
        )>,
        prepared: result_content::PreparedOperationResult,
    ) -> Result<Operation> {
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", &binding.operation_id)?;
        let link = op
            .host_job
            .as_mut()
            .filter(|link| &link.binding == binding)
            .ok_or_else(|| RuntimeError::Conflict("MCP task original binding changed".into()))?;
        let current = link.mcp_task.as_mut().ok_or_else(|| {
            RuntimeError::Conflict("MCP task has no accepted remote identity".into())
        })?;
        if current.revision != expected_revision {
            return Ok(op);
        }
        if task.task_id != current.task.task_id
            || task.created_at != current.task.created_at
            || (current.task.status.terminal() && current.task.status != task.status)
            || (result.is_some() && !task.status.terminal())
            || result.as_ref().is_some_and(|(kind, result)| {
                current.result_ref.as_ref().is_some_and(|old| {
                    old != &result.receipt.result_ref
                        || current.result_kind != Some(*kind)
                        || current.result_outcome != Some(result.receipt.outcome)
                        || current.result_effect != Some(result.receipt.effect)
                })
            })
        {
            return Err(RuntimeError::Conflict(
                "MCP task observation changed its original identity or terminal result".into(),
            ));
        }
        let result_ready = current.result_ref.is_some() || result.is_some();
        if current.task == task
            && current.availability == availability
            && current.problem == problem
            && current.result_ready == result_ready
            && current.observation_ref == prepared.reference
        {
            tx.commit()?;
            return self.finish_mcp_task(binding);
        }
        current.task = task;
        current.availability = availability;
        current.problem = problem;
        current.result_ready = result_ready;
        if let Some((kind, result)) = &result {
            if result.receipt.effect == Effect::Unknown
                && result.receipt.outcome != Outcome::Indeterminate
            {
                return Err(RuntimeError::Invalid(
                    "Unknown task result effect requires indeterminate outcome".into(),
                ));
            }
            current.result_ref = Some(result.receipt.result_ref.clone());
            current.result_kind = Some(*kind);
            current.result_outcome = Some(result.receipt.outcome);
            current.result_effect = Some(result.receipt.effect);
        }
        current.observation_ref = prepared.reference;
        current.revision += 1;
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "host_job.task_observed",
            json!({"operationId":op.id,"task":op.host_job.as_ref().expect("checked link").mcp_task}),
        )?;
        let task = op
            .host_job
            .as_ref()
            .and_then(|link| link.mcp_task.as_ref())
            .expect("accepted task");
        if task.result_ready || task.availability == crate::McpTaskAvailability::Unavailable {
            let receipt = op.external_receipt.as_ref();
            event(
                &tx,
                &op.id,
                op.revision,
                RESULT_EVENT,
                serde_json::to_value(McpResultFact {
                    task: task.clone(),
                    result_ref: task.result_ref.clone(),
                    outcome: task.result_outcome,
                    effect: task.result_effect.unwrap_or(Effect::Unknown),
                    executor_stopped: receipt.is_some_and(|r| r.executor_stopped),
                })?,
            )?;
        }
        tx.commit()?;
        let op = self.finish_mcp_task(binding)?;
        self.reconcile_waits()?;
        Ok(op)
    }
    /// Protocol completion proves stop independently of retrieving the business result.
    /// Reopening can publish either durable fact without another remote request.
    pub fn finish_mcp_task(&mut self, binding: &HostJobBinding) -> Result<Operation> {
        let op = self.operation(&binding.operation_id)?;
        let link = op
            .host_job
            .as_ref()
            .filter(|link| &link.binding == binding)
            .ok_or_else(|| RuntimeError::Conflict("Task binding changed".into()))?;
        let Some(task) = &link.mcp_task else {
            return Ok(op);
        };
        let stopped = matches!(
            task.task.status,
            McpTaskStatus::Completed | McpTaskStatus::Failed
        );
        if !stopped && task.result_ref.is_none() {
            return Ok(op);
        }
        let (reference, outcome, effect) = if let Some(reference) = &task.result_ref {
            (
                reference,
                task.result_outcome
                    .ok_or_else(|| RuntimeError::Invalid("Task result outcome missing".into()))?,
                task.result_effect
                    .ok_or_else(|| RuntimeError::Invalid("Task result effect missing".into()))?,
            )
        } else {
            (
                &task.observation_ref,
                Outcome::Indeterminate,
                Effect::Unknown,
            )
        };
        let ExecutorOwner::External { epoch, .. } = &binding.execution_owner else {
            return Err(RuntimeError::Conflict("Task executor owner changed".into()));
        };
        let prepared = result_content::PreparedExternalReceipt {
            receipt: ExternalReceiptMetadata {
                executor_stopped: false,
                executor: op
                    .executor
                    .clone()
                    .ok_or_else(|| RuntimeError::Invalid("Task executor missing".into()))?,
                identity: op.id.clone(),
                epoch: epoch.clone(),
                outcome,
                effect,
                result_ref: reference.clone(),
            },
            _publication: self.content.begin_publication(),
        };
        self.record_host_job_terminal(binding, prepared, stopped)
    }
    /// A control caller may act only on its own Thread subtree. Reads use the original family.
    pub fn access_host_job(
        &self,
        run_id: &str,
        target_id: &str,
        control: bool,
    ) -> Result<Operation> {
        let target = self.require_host_job_observation(run_id, target_id)?;
        if control {
            let run = self.run(run_id)?;
            let source = self.run(&target.run_id)?;
            if !descendants(&self.db, &run.thread_id)?.contains(&source.thread_id) {
                return Err(RuntimeError::Conflict(
                    "Job control is outside the caller's Thread subtree".into(),
                ));
            }
        }
        Ok(target)
    }
    pub fn pending_host_jobs(&self) -> Result<Vec<Operation>> {
        let mut query=self.db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.host_job') IS NOT NULL AND (coalesce(json_extract(body,'$.external_receipt.executor_stopped'),0)=0 OR json_extract(body,'$.phase')!='terminal' OR (json_extract(body,'$.host_job.mcpTask') IS NOT NULL AND json_extract(body,'$.host_job.mcpTask.resultRef') IS NULL)) ORDER BY rowid")?;
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
        let mut prepared = prepared;
        // The first uncertain business receipt is historical. A later uncertain MCP result has
        // its own immutable Task resultRef; only independently proven stop refines this receipt.
        if matches!(binding.subject, HostJobSubject::Mcp { .. })
            && prepared.receipt.effect == Effect::Unknown
        {
            if let Some(previous) = &op.external_receipt {
                if previous.effect == Effect::Unknown {
                    prepared.receipt = previous.clone();
                }
            }
        }
        self.record_external_receipt_prepared(&op.id, prepared, stopped)
    }
    pub fn host_job_acceptance(&self, id: &str) -> Result<result_content::ToolCompletionRead> {
        let op = self.operation(id)?;
        if op.host_job.is_none()
            && !op.waiting_on.as_deref().is_some_and(|v| {
                v.starts_with(WAIT_PREFIX) || v.starts_with(super::computer_wait::PREFIX)
            })
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
    if matches!(binding.subject, HostJobSubject::Mcp { .. }) {
        kinds.push("job_result".into());
    }
    if binding.domain == "research.experiment" && binding.domain_version == 1 {
        kinds.extend([
            "artifact".into(),
            "collection".into(),
            "log_literal".into(),
            "log_end".into(),
        ]);
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
pub const RESULT_EVENT: &str = "host_job.result_observed";
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResultFact {
    pub task: McpTaskLink,
    pub result_ref: Option<Value>,
    pub outcome: Option<Outcome>,
    pub effect: Effect,
    pub executor_stopped: bool,
}
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
                    mcp_task: pending.mcp_task.clone(),
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
        self.wait_for_host_job_mode(operation_id, target_id, crate::HostJobWaitMode::Stopped)
    }
    pub fn wait_for_host_job_mode(
        &mut self,
        operation_id: &str,
        target_id: &str,
        mode: crate::HostJobWaitMode,
    ) -> Result<Operation> {
        let current = self.operation(operation_id)?;
        let target = self.require_host_job_observation(&current.run_id, target_id)?;
        if mode == crate::HostJobWaitMode::Result
            && target
                .host_job
                .as_ref()
                .and_then(|link| link.mcp_task.as_ref())
                .is_none()
        {
            return Err(RuntimeError::Conflict(
                "Job has no negotiated result observation".into(),
            ));
        }
        let kind = if mode == crate::HostJobWaitMode::Result {
            RESULT_EVENT
        } else {
            "operation.executor_stopped"
        };
        let tx = self.db.transaction()?;
        let mut op: Operation = record(&tx, "operations", operation_id)?;
        let run: Run = record(&tx, "runs", &op.run_id)?;
        let admitted = tool_content::ToolIntent::from_operation(&op)?;
        let id = format!("{WAIT_PREFIX}{}", op.id);
        if let Some(prior) = optional_record::<Wait>(&tx, "waits", &id)? {
            if prior.subject != target_id || prior.run_id != run.id || prior.kind != kind {
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
        // A new result observer consumes the current result/unavailability, not an obsolete
        // transient failure that recovered before registration. Existing triggered waits above
        // retain their original event. A final result remains immediately consumable.
        let current_ready = mode != crate::HostJobWaitMode::Result
            || target
                .host_job
                .as_ref()
                .and_then(|link| link.mcp_task.as_ref())
                .is_some_and(|task| {
                    task.result_ready
                        || task.availability == crate::McpTaskAvailability::Unavailable
                });
        let after_cursor = if current_ready {
            0
        } else {
            tx.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
                read_number(r, 0)
            })?
        };
        let trigger_cursor = if current_ready {
            tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind=?2 ORDER BY cursor DESC LIMIT 1",params![target_id,kind],|r|read_number(r,0)).optional()?
        } else {
            None
        };
        let wait = Wait {
            id: id.clone(),
            run_id: run.id.clone(),
            subject: target_id.into(),
            kind: kind.into(),
            after_cursor,
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
