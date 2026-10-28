//! Durable parent/child facts. This is a Catalog domain, not a second task registry.
//! Preparation and model I/O are performed by their existing owners after admission.
use super::*;
use crate::execution::{ToolExecutionContext, ToolOrigin};
use serde::Deserialize;

pub const DISPATCH_TOOL: &str = "dispatch";
pub const STATUS_TOOL: &str = "child_status";
pub const REPORT_TOOL: &str = "child_report";
pub const WAIT_TOOL: &str = "wait_child";

pub use super::dispatch::DispatchInput;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildSourcePin {
    pub pin_id: String,
    pub root: String,
    pub source: launches::SourceSelection,
}
/// Original Documents capture evidence; text lives only in the WorkingState fixed root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDraftResource {
    pub workspace_id: String,
    pub resource_id: String,
    pub base_revision: Option<String>,
    pub local_edit_revision: u64,
    pub revision: String,
    pub encoding: String,
    pub bom: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordination_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_ending: Option<SourceDraftLineEnding>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SourceDraftLineEnding { Lf, Crlf, Cr }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDraftProvenance {
    pub thread_id: String,
    pub branch_id: String,
    pub snapshot_ref: String,
    pub owner_id: String,
    pub owner_generation: u64,
    pub resources: Vec<SourceDraftResource>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "consistency", deny_unknown_fields)]
pub enum ChildSourceProvenance {
    #[serde(rename = "refreshed-root")]
    RefreshedRoot {
        root: String,
        #[serde(rename = "previousRoot")]
        previous_root: String,
        incoming: dispatch::AgentSourceSelection,
        #[serde(rename = "incomingRoot")]
        incoming_root: String,
        conflicts: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resources: Option<Value>,
    },
    #[serde(rename = "fixed-root")]
    FixedRoot {
        root: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        selection: Option<SourceSnapshotSelection>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resources: Option<Value>,
    },
    #[serde(rename = "stable-capture")]
    StableCapture {
        #[serde(rename = "contentMode")]
        content_mode: ChildSourceContentMode,
        #[serde(rename = "captureScopes")]
        capture_scopes: Vec<String>,
        #[serde(rename = "omittedDraftPaths")]
        omitted_draft_paths: Vec<String>,
        // Product preparations bind a public key; physical child captures have no such request.
        #[serde(rename = "captureIdentity", skip_serializing_if = "Option::is_none")]
        capture_identity: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        drafts: Option<SourceDraftProvenance>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resources: Option<Value>,
    },
    #[serde(rename = "git-base-with-overlay")]
    GitBaseWithOverlay {
        #[serde(rename = "contentMode")]
        content_mode: ChildSourceContentMode,
        #[serde(rename = "captureScopes")]
        capture_scopes: Vec<String>,
        #[serde(rename = "omittedDraftPaths")]
        omitted_draft_paths: Vec<String>,
        // Product preparations bind a public key; physical child captures have no such request.
        #[serde(rename = "captureIdentity", skip_serializing_if = "Option::is_none")]
        capture_identity: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        drafts: Option<SourceDraftProvenance>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resources: Option<Value>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct SourceSnapshotSelection {
    pub capture_identity:String,
    pub content_mode:ChildSourceContentMode,
    pub capture_scopes:Vec<String>,
    pub omitted_draft_paths:Vec<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub drafts:Option<SourceDraftProvenance>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ChildSourceContentMode {
    SavedFiles,
    FixedDraftBaseline,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChildSourceRoot {
    Fixed { pin: ChildSourcePin },
    Native { pin: ChildSourcePin },
    Physical { root: launches::LiveRoot },
    /// A fixed baseline whose Run now owns command-modified physical content.
    /// The pin also retains that execution view until this handoff is released.
    Derived { pin: ChildSourcePin, root: launches::LiveRoot, view_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildSourceAuthority {pub authority_id:String,pub resource_epoch:String}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildSourceHandoff {
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub retention_pin: Option<ChildSourcePin>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub refresh: Option<super::dispatch::AgentSourceSelection>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub source_run_id: Option<String>,
    pub resource_authority: Option<ChildSourceAuthority>,
    pub operation_id: String,
    pub source: launches::SourceSelection,
    pub root: ChildSourceRoot,
}
impl ChildSourceHandoff {
    pub fn fixed(operation_id: &str, pin: ChildSourcePin) -> Self {
        Self {
            retention_pin:None,
            source_path:None,
            refresh:None,
            source_run_id:None,
            resource_authority:None,
            operation_id: format!("child-source-handoff:{operation_id}"),
            source: pin.source.clone(),
            root: ChildSourceRoot::Fixed { pin },
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChildSource {
    /// The original invocation selected no file source. This is neither preparation nor failure.
    Absent,
    Pending {
        handoff: ChildSourceHandoff,
    },
    /// Read-only access to the dispatching Run's actual local execution workspace.
    /// Materialized sources retain the original environment Run instead of copying it.
    Shared {
        handoff: Option<ChildSourceHandoff>,
        selection: launches::SourceSelection,
    },
    Ready {
        handoff: Option<ChildSourceHandoff>,
        pin: ChildSourcePin,
        selection: launches::SourceSelection,
        provenance_ref: Value,
    },
}
impl ChildSource {
    pub fn handoff(&self) -> Option<&ChildSourceHandoff> {
        match self {
            Self::Absent => None,
            Self::Pending { handoff } => Some(handoff),
            Self::Ready { handoff, .. } | Self::Shared { handoff, .. } => handoff.as_ref(),
        }
    }
    pub fn pin(&self) -> Option<&ChildSourcePin> {
        match self {
            Self::Absent | Self::Shared { .. } => None,
            Self::Ready { pin, .. } => Some(pin),
            Self::Pending { handoff } => match &handoff.root {
                ChildSourceRoot::Fixed { pin } | ChildSourceRoot::Native { pin } | ChildSourceRoot::Derived { pin, .. } => Some(pin),
                _ => None,
            },
        }
    }
    pub fn selection(&self) -> Option<&launches::SourceSelection> {
        match self {
            Self::Ready { selection, .. } | Self::Shared { selection, .. } => Some(selection),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildWorkingResultRef {
    pub publication_id: String,
    pub workspace_id: String,
    pub branch_id: String,
    pub result_revision: u64,
    pub root: String,
    pub base_root: String,
    pub record_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChildCodeResult {
    NotApplicable,
    /// The shared environment owns any command effects; no isolated merge result is produced.
    SharedSource,
    Pending,
    Settling {
        publication_id: String,
    },
    Candidate {
        candidate: crate::KernelWorkingResultCandidate,
    },
    Published {
        result: ChildWorkingResultRef,
        effect: Effect,
    },
    NoChanges,
    Unavailable {
        code: String,
        effect: Effect,
    },
}
impl ChildCodeResult {
    pub fn settled(&self) -> bool {
        matches!(
            self,
            Self::NotApplicable
                | Self::SharedSource
                | Self::Published { .. }
                | Self::NoChanges
                | Self::Unavailable { .. }
        )
    }
    pub fn effect(&self) -> Effect {
        match self {
            Self::Published { effect, .. } | Self::Unavailable { effect, .. } => *effect,
            _ => Effect::None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildReport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::execution::ExecutionError>,
    pub outcome: Outcome,
    pub sender_thread_id: String,
    pub run_id: Option<String>,
    pub history_ids: Vec<String>,
    pub detail: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChildTask {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherited_context: Option<crate::context_retention::RetainedContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub agent_id: String,
    pub name: String,
    pub execution_id: String,
    pub operation_id: String,
    pub parent_run_id: String,
    pub parent_thread_id: String,
    pub parent_branch_id: String,
    pub origin: ToolOrigin,
    pub call_id: String,
    pub child_thread_id: String,
    pub child_branch_id: String,
    pub project_id: Option<String>,
    pub input_ref: Value,
    pub configuration_ref: Value,
    pub selected_profile_ref: Value,
    pub dispatch_context_ref: Value,
    pub launch: launch_content::LaunchSelectionMetadata,
    pub source: ChildSource,
    pub code_result: ChildCodeResult,
    pub state: String,
    pub revision: u64,
    pub cursor: u64,
    pub receipt: Option<Receipt>,
    pub report: Option<ChildReport>,
    pub resources_released: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildReportFormat {
    Text,
    OutputBody,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChildReportPage {
    pub format: ChildReportFormat,
    pub execution_id: String,
    pub operation_id: String,
    pub item_id: String,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub total_bytes: usize,
    pub text: String,
}
impl Catalog {
    /// Bounded projection of existing history content. No duplicated report body is persisted.
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn read_child_report(
        &self,
        operation_id: &str,
        item_id: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<ChildReportPage> {
        let _synchronous = self.content.begin_synchronous()?;
        self.capture_child_report(operation_id, item_id, offset, max_bytes)?
            .load()
    }
    pub fn capture_child_report(
        &self,
        operation_id: &str,
        item_id: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<child_content::ChildReportRead> {
        self.child_task(operation_id)?;
        self.capture_delegated_report(operation_id, item_id, offset, max_bytes)
    }
    pub fn capture_delegated_report(
        &self,
        operation_id: &str,
        item_id: &str,
        offset: usize,
        max_bytes: usize,
    ) -> Result<child_content::ChildReportRead> {
        let child = self.execution_task(operation_id)?;
        if !child
            .report
            .as_ref()
            .is_some_and(|r| r.history_ids.iter().any(|id| id == item_id))
        {
            return Err(RuntimeError::Invalid(
                "not_a_report_item: itemId must be one of child_status.report.history_ids for this child; read child_status to select the report item".into(),
            ));
        }
        Ok(child_content::ChildReportRead::new(
            self,
            &child.execution_id,
            &child.operation_id,
            item_id,
            offset,
            max_bytes,
            record(&self.db, "history", item_id)?,
        ))
    }

    pub fn child_task(&self, operation_id: &str) -> Result<ChildTask> {
        if delegated::relation(&self.db, operation_id).is_ok() {return delegated::execution_task(&self.db, operation_id)}
        let thread=super::threads::resolve(&self.db,operation_id)?;
        self.child_task_for_thread(&thread)?.ok_or_else(||RuntimeError::NotFound(operation_id.into()))
    }
    pub fn child_tasks(&self) -> Result<Vec<ChildTask>> {
        read_all::<delegated::ChildRelation>(&self.db, "child_tasks")?
            .into_iter()
            .map(|child| delegated::execution_task(&self.db, &child.operation_id))
            .collect()
    }
    pub fn child_task_for_thread(&self, thread_id: &str) -> Result<Option<ChildTask>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT body FROM child_tasks WHERE child_thread_id=?1",
                [thread_id],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| {
            let child: delegated::ChildRelation = serde_json::from_str(&raw)?;
            delegated::execution_task(&self.db, &child.operation_id)
        })
        .transpose()
    }
    /// The source owner has already admitted and pinned this exact revision under the real parent
    /// grant. No directory capture, credential preparation or extension callback runs here.
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn accept_child(
        &mut self,
        context: &ToolExecutionContext,
        input: DispatchInput,
        pin: ChildSourcePin,
        child_launch: launches::LaunchSelection,
    ) -> Result<ChildTask> {
        let _synchronous = self.content.begin_synchronous()?;
        let selected = self
            .capture_child_dispatch_invocation(context)?
            .load()?
            .resolve(&input)?;
        let prepared = self
            .prepare_child_launch(&context.run_id, child_launch, selected)?
            .load()?;
        self.accept_prepared_child(context, input, pin, prepared)
    }
    /// Synchronous fixture convenience; production uses capture/prepare, unlocked I/O, then commit.
    pub fn accept_prepared_child(
        &mut self,
        context: &ToolExecutionContext,
        input: DispatchInput,
        pin: ChildSourcePin,
        prepared: launch_content::PreparedChildLaunch,
    ) -> Result<ChildTask> {
        let _synchronous = self.content.begin_synchronous()?;
        let prepared = self
            .prepare_child_admission(
                context,
                input,
                Some(ChildSourceHandoff::fixed(&context.operation_id, pin)),
                prepared,
            )?
            .load()?;
        self.accept_child_references(prepared)
    }
    pub fn accept_child_references(
        &mut self,
        prepared: child_content::PreparedChildAdmission,
    ) -> Result<ChildTask> {
        let context = &prepared.context;
        let child_launch = &prepared.launch;
        let handoff = &prepared.handoff;
        if let Some(old) = optional_record::<delegated::ChildRelation>(
            &self.db,
            "child_tasks",
            &context.operation_id,
        )?
        .map(|_| self.child_task(&context.operation_id))
        .transpose()?
        {
            if old.parent_run_id == context.run_id
                && old.origin == context.origin
                && old.input_ref == prepared.input_ref
                && old.source.handoff() == handoff.as_ref()
                && &old.launch == child_launch
            {
                return Ok(old);
            }
            return Err(RuntimeError::Conflict(
                "dispatch origin has different input or source".into(),
            ));
        }
        let project_id = self.run_project_id(&context.run_id)?;
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", &context.run_id)?;
        fence(&run, self.epoch)?;
        let mut op: Operation = record(&tx, "operations", &context.operation_id)?;
        let admitted = super::tool_content::require_job_invocation(&tx, &run, &op, context,
            if prepared.internal_retrieval { "code_retrieval" } else { DISPATCH_TOOL })?;
        if admitted.call().call_id != prepared.call_id
            || op.revision != prepared.operation_revision
            || op.phase != OperationPhase::Running
            || op.cancel_requested
            || run.cancel_requested
        {
            return Err(RuntimeError::Conflict(
                "dispatch is not an admitted parent tool call".into(),
            ));
        }
        let parent: launch_content::LaunchMetadata = record(&tx, "run_launches", &run.id)?;
        super::dispatch::validate_agent_source(&tx,&run,prepared.source_agent.as_deref(),handoff.as_ref())?;
        if parent.selection.tool_schema_generation != child_launch.tool_schema_generation
            || parent.selection.tools_ref != prepared.parent_tools_ref
        {
            return Err(RuntimeError::Conflict(
                "child exceeds parent source/model/read authority".into(),
            ));
        }
        let child_thread_id = format!("thread:child:{}", op.id);
        let child_branch_id = format!("branch:child:{}", op.id);
        super::threads::insert(&tx, &child_thread_id)?;
        super::threads::initialize_title(&tx, &child_thread_id, prepared.title.as_deref())?;
        tx.execute(
            "INSERT INTO branches(id,thread_id,head) VALUES(?1,?2,NULL)",
            params![child_branch_id, child_thread_id],
        )?;
        let shared_physical=prepared.handoff.as_ref().is_some_and(|handoff| handoff.source.mode == SourceMode::Materialized
            || matches!(handoff.root,ChildSourceRoot::Physical{..} | ChildSourceRoot::Derived{..}));
        let mut child =
            ChildTask {
                inherited_context: prepared.inherited_context,
                avatar: Some(prepared.avatar.unwrap_or_else(|| {
                    let index = (Uuid::new_v4().as_u128() % crate::AGENT_AVATAR_IDS.len() as u128) as usize;
                    crate::AGENT_AVATAR_IDS[index].to_owned()
                })),
                agent_id: tx.query_row("SELECT agent_code FROM threads WHERE id=?1",[&child_thread_id],|r|r.get(0))?,
                name: prepared.title.clone().unwrap_or_else(|| "Agent".into()),
                execution_id: op.id.clone(),
                operation_id: op.id.clone(),
                parent_run_id: run.id.clone(),
                parent_thread_id: run.thread_id.clone(),
                parent_branch_id: run.branch_id.clone(),
                origin: context.origin.clone(),
                call_id: prepared.call_id.clone(),
                child_thread_id,
                child_branch_id,
                project_id,
                input_ref: prepared.input_ref,
                configuration_ref: prepared.configuration_ref,
                selected_profile_ref: prepared.selected_profile_ref,
                dispatch_context_ref: prepared.frozen_reference,
                launch: prepared.launch,
                source: prepared.handoff.map_or(ChildSource::Absent, |handoff| {
                    if prepared.work_mode != super::dispatch::ChildWorkMode::IsolatedWrite
                        && (handoff.source.mode == SourceMode::Materialized
                            || matches!(handoff.root, ChildSourceRoot::Physical { .. } | ChildSourceRoot::Derived { .. }))
                    {
                        let mut selection = handoff.source.clone();
                        if selection.mode == crate::SourceMode::Materialized {
                            selection.environment_run_id.get_or_insert_with(|| handoff.source_run_id.clone().unwrap_or_else(|| run.id.clone()));
                        }
                        if (handoff.source_path.is_some() || matches!(handoff.root, ChildSourceRoot::Derived { .. }))
                            && selection.mode!=SourceMode::NativeWorkspace
                            && !matches!(handoff.root,ChildSourceRoot::Fixed{..}) {
                            let root = match &handoff.root { ChildSourceRoot::Physical { root } | ChildSourceRoot::Derived { root, .. } => root.clone(), _ => unreachable!() };
                            selection.mode = crate::SourceMode::LiveRoot;
                            selection.live_root = Some(root);
                            selection.branch_id = None; selection.revision = None; selection.environment_run_id = None;
                        }
                        if selection.mode==SourceMode::NativeWorkspace {
                            if let Some(path)=&handoff.source_path{selection.native_scope=Some(selection.native_scope.as_ref().map_or_else(||path.clone(),|scope|format!("{scope}/{path}")));}
                        }
                        ChildSource::Shared { handoff: Some(handoff), selection }
                    } else {
                        ChildSource::Pending { handoff }
                    }
                }),
                code_result: if parent.selection.source.is_none() {
                    ChildCodeResult::NotApplicable
                } else if prepared.work_mode == super::dispatch::ChildWorkMode::Shared && (shared_physical || prepared.internal_retrieval) {
                    ChildCodeResult::SharedSource
                } else if prepared.work_mode == super::dispatch::ChildWorkMode::ReadOnly {
                    ChildCodeResult::NoChanges
                } else {
                    ChildCodeResult::Pending
                },
                state: "preparing".into(),
                revision: 1,
                cursor: 0,
                receipt: None,
                report: None,
                resources_released: false,
            };
        // The original invocation completes at acceptance. A fast child may independently
        // finish before the model exchange or policy graph consumes this immutable fact.
        let accepted_at_ms = observations::wall_time_ms()?;
        let acceptance=super::result_content::ToolCompletionMetadata::write(&self.content,&crate::execution::ToolCompletion::JobAccepted{
            operation_id:op.id.clone(),phase:"preparing_child".into(),effect:Effect::None,lifetime:Lifetime::Thread,
            content:Some(if prepared.internal_retrieval {
                json!({"kind":"retrieval","operationId":child.operation_id,"status":"preparing", "acceptedAtMs":accepted_at_ms,
                    "control":{"tool":"retrieval_control","actions":["status","wait","stop"]},
                    "delivery":"The final answer is delivered automatically. Continue other work, inspect status, wait, or stop this investigation."})
            } else { json!({"agentId":child.agent_id,"name":child.name,"threadId":child.child_thread_id,"branchId":child.child_branch_id,"operationId":child.operation_id}) }.into()),
        })?;
        let content_ref=match acceptance {super::result_content::ToolCompletionMetadata::JobAccepted{content_ref,..}=>content_ref,_=>unreachable!()};
        super::result_content::publish_job_acceptance_content(&tx, &mut op, &admitted, "preparing_child",content_ref)?;
        op.handed_off = true;
        op.phase = OperationPhase::Preparing;
        op.effect = Effect::None;
        op.revision += 1;
        put(&tx, "operations", &op.id, &op)?;
        child.cursor = event(
            &tx,
            &op.id,
            child.revision,
            "child.accepted",
            json!({"child_thread_id":child.child_thread_id,"parent_run_id":run.id,"acceptedAtMs":accepted_at_ms}),
        )?;
        delegated::insert_initial(&tx, &child)?;
        super::goals::bind_child(&tx, &op.id, &run.id)?;
        tx.commit()?;
        Ok(child)
    }
}

/// Validate a dispatched call against the original invocation and its real caller owner.
/// Arguments were checked on the worker; only immutable identities are compared here.
/// Cancelling an observation does not consume its pending delivery. A parent that has not
/// parked yet must still relinquish its history writer so this domain can publish that fact.
/// Other cancelled Waits remain unavailable to policy/checkpoint transitions.
pub(super) fn pending_cancelled_observation(
    db: &Connection,
    run: &Run,
    wait: &Wait,
) -> Result<bool> {
    let Some(id) = wait.id.strip_prefix("child-wait:") else {
        return Ok(false);
    };
    if !wait.cancelled || wait.run_id != run.id || wait.kind != "operation.settled" {
        return Ok(false);
    }
    let Some(op) = optional_record::<Operation>(db, "operations", id)? else {
        return Ok(false);
    };
    if op.run_id != run.id
        || op.epoch != run.epoch
        || !matches!(op.executor.as_deref(), Some(WAIT_TOOL | super::retrieval::CONTROL_TOOL))
        || op.phase != OperationPhase::Waiting
        || !op.handed_off
        || op.waiting_on.as_deref() != Some(wait.id.as_str())
        || !matches!(&op.call_completion, Some(super::result_content::ToolCompletionMetadata::JobAccepted {
            operation_id, phase, effect: Effect::None, lifetime: Lifetime::Thread, ..}) if operation_id == &op.id && phase == "awaiting_child")
    {
        return Ok(false);
    }
    let admitted = super::tool_content::ToolIntent::from_operation(&op)?;
    if !matches!(admitted.call().name.as_str(), WAIT_TOOL | super::retrieval::CONTROL_TOOL) {
        return Ok(false);
    }
    let Some(child) =
        optional_record::<delegated::ChildRelation>(db, "child_tasks", &wait.subject)?
    else {
        return Ok(false);
    };
    Ok(child.parent_thread_id == run.thread_id)
}

/// Required on every existing catalog before any write-capable open or epoch advancement.
pub(super) fn check_format(db: &Connection) -> Result<()> {
    let version: Option<i64> = db
        .query_row(
            "SELECT version FROM runtime_domains WHERE name='collaboration'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let columns: Vec<(String, String, i64, i64)> = {
        let mut statement = db.prepare("PRAGMA table_info(child_tasks)")?;
        let rows = statement
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(5)?)))?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    db.prepare("SELECT execution_id,path FROM child_result_files")?;
    db.prepare("SELECT operation_id,peer_thread_id FROM code_exchange_peers")?;
    if version != Some(9)
        || columns
            != vec![
                ("id".into(), "TEXT".into(), 0, 1),
                ("child_thread_id".into(), "TEXT".into(), 1, 0),
                ("body".into(), "TEXT".into(), 1, 0),
            ]
    {
        return Err(RuntimeError::Invalid(
            "unsupported or malformed collaboration domain; user data was preserved".into(),
        ));
    }
    let relations: Vec<(String, String, String, String, String, String)> = {
        let mut statement = db.prepare("PRAGMA foreign_key_list(child_tasks)")?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get(3)?,
                    r.get(2)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    let indexes: Vec<(String, bool, String, bool)> = {
        let mut statement = db.prepare(
            "SELECT name,\"unique\",origin,partial FROM pragma_index_list('child_tasks')",
        )?;
        let rows = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    let mut primary_id = false;
    let mut unique_thread = false;
    for (name, unique, origin, partial) in indexes {
        if !unique || partial {
            continue;
        }
        // index_info omits collation/order and cannot distinguish a partial UNIQUE constraint.
        // Auxiliary rowid columns are not keys; expressions have no column name and must not match.
        let keys: Vec<(Option<String>, String, bool)> = {
            let mut statement = db.prepare(
                "SELECT name,coll,\"desc\" FROM pragma_index_xinfo(?1) WHERE key=1 ORDER BY seqno",
            )?;
            let rows = statement
                .query_map([name], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<std::result::Result<_, _>>()?;
            rows
        };
        if origin == "pk" && keys == vec![(Some("id".into()), "BINARY".into(), false)] {
            primary_id = true;
        }
        if keys == vec![(Some("child_thread_id".into()), "BINARY".into(), false)] {
            unique_thread = true;
        }
    }
    let expected_relation = |column: &str, table: &str| {
        (
            column.into(),
            table.into(),
            "id".into(),
            "NO ACTION".into(),
            "NO ACTION".into(),
            "NONE".into(),
        )
    };
    if relations.len() != 2
        || !relations.contains(&expected_relation("id", "operations"))
        || !relations.contains(&expected_relation("child_thread_id", "threads"))
        || !primary_id
        || !unique_thread
    {
        return Err(RuntimeError::Invalid(
            "malformed collaboration constraints; user data was preserved".into(),
        ));
    }
    // Validate persisted domain bodies while the existing catalog is still read-only.
    // In particular, an older duplicated-text report is not silently rewritten as references.
    let mut statement = db.prepare("SELECT id,child_thread_id,body FROM child_tasks")?;
    for row in statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })? {
        let (id, thread, body) = row?;
        let child: delegated::ChildRelation = serde_json::from_str(&body).map_err(|_| {
            RuntimeError::Invalid("unsupported collaboration body; user data was preserved".into())
        })?;
        if child.operation_id != id || child.child_thread_id != thread {
            return Err(RuntimeError::Invalid(
                "malformed collaboration identity; user data was preserved".into(),
            ));
        }
    }
    delegated::check_format(db)?;
    Ok(())
}
pub(super) fn initialize_new(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE child_tasks(id TEXT PRIMARY KEY REFERENCES operations(id),child_thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),body TEXT NOT NULL); CREATE INDEX child_tasks_parent ON child_tasks(json_extract(body,'$.parent_thread_id')); CREATE TABLE delegated_executions(id TEXT PRIMARY KEY,child_operation_id TEXT NOT NULL REFERENCES child_tasks(id),command_key TEXT UNIQUE,run_id TEXT UNIQUE REFERENCES runs(id),body TEXT NOT NULL); CREATE INDEX delegated_executions_child ON delegated_executions(child_operation_id); CREATE TABLE child_result_files(execution_id TEXT NOT NULL REFERENCES delegated_executions(id) ON DELETE CASCADE,path TEXT NOT NULL,PRIMARY KEY(execution_id,path)); CREATE INDEX child_result_files_path ON child_result_files(path,execution_id); INSERT INTO runtime_domains(name,version) VALUES('collaboration',9);")?;
    db.execute_batch("CREATE TABLE code_exchange_peers(operation_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,peer_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE); CREATE INDEX code_exchange_peers_thread ON code_exchange_peers(peer_thread_id,operation_id);")?;
    Ok(())
}

pub(super) fn track_code_peer(tx:&Transaction<'_>,run:&Run,operation_id:&str,call:&crate::execution::ToolCall)->Result<()> {
    let field=match call.name.as_str() {"submit_code"=>"target","update"=>"source",_=>return Ok(())};
    let peer=if let Some(identity)=call.arguments[field].as_str() {super::threads::resolve(tx,identity).ok()}
        else {tx.query_row("SELECT json_extract(body,'$.parent_thread_id') FROM child_tasks WHERE child_thread_id=?1",[&run.thread_id],|r|r.get::<_,String>(0)).optional()?};
    if let Some(peer)=peer.filter(|peer|peer!=&run.thread_id) {
        if super::scheduling::thread_family(tx,&peer)?==super::scheduling::thread_family(tx,&run.thread_id)? {
            tx.execute("INSERT OR IGNORE INTO code_exchange_peers(operation_id,peer_thread_id) VALUES(?1,?2)",params![operation_id,peer])?;
        }
    }
    Ok(())
}

impl Catalog {
    /// Context is assembled by the single Host context owner from the child identity and admitted
    /// project/role. The existing input writer commits its Run, context, launch and relation together.
    pub fn capture_child_preparation(
        &self,
        operation_id: &str,
        source: Option<launches::SourceSelection>,
        proposal: context::ContextProposal,
        basis: personalization::PersonalizationBasis,
    ) -> Result<ChildPreparation> {
        let child = self.execution_task(operation_id)?;
        let admitted = child
            .receipt
            .as_ref()
            .map(|receipt| self.capture_admitted_checkpoint(&receipt.run_id))
            .transpose()?
            .flatten();
        let checkpoint = self
            .capture_active_checkpoint(&child.child_branch_id)?
            .map(|checkpoint| checkpoint.id);
        let execution = self.delegated_execution(operation_id)?;
        let ingress_id = match &execution.trigger {
            delegated::DelegatedTrigger::MessageRequest { message_id, .. } => Some(message_id),
            delegated::DelegatedTrigger::ComputerEvent { input_id, .. }
            | delegated::DelegatedTrigger::Followup { input_id, .. }
            | delegated::DelegatedTrigger::Calendar { input_id, .. } => Some(input_id),
            _ => None,
        };
        let ingress = ingress_id
            .map(|id| -> Result<_> {
                Ok((
                    record::<inputs::QueuedInputMetadata>(&self.db, "input_queue", id)?,
                    execution.input_ref.clone(),
                ))
            })
            .transpose()?;
        Ok(ChildPreparation {
            bot: self.bot_for_thread(&child.child_thread_id)?.is_some(),
            ingress,
            execution: self.delegated_execution(operation_id)?,
            current: self.capture_active_checkpoint(&child.child_branch_id)?,
            input_preparation: None,
            expected_checkpoint: checkpoint.clone(),
            child,
            source,
            proposal,
            basis,
            resources: None,
            admitted,
            checkpoint,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn admit_child(&mut self, prepared: PreparedChild) -> Result<ChildTask> {
        let PreparedChild {
            operation_id,
            submission,
            receipt,
        } = prepared;
        if let Some(submission) = submission {
            self.submit_admission(submission, None)?;
        } else if self.execution_task(&operation_id)?.receipt != receipt {
            return Err(RuntimeError::Conflict(
                "child admission changed during preparation".into(),
            ));
        }
        self.execution_task(&operation_id)
    }
    pub fn require_child_launch(&self, run_id: &str) -> Result<Option<ChildTask>> {
        let run = self.run(run_id)?;
        let Some(execution) = self.delegated_execution_for_run(run_id)? else {
            if self.child_task_for_thread(&run.thread_id)?.is_some() {
                return Err(RuntimeError::Conflict(
                    "delegated Run has no exact execution admission".into(),
                ));
            }
            return Ok(None);
        };
        if execution.cancel_requested
            || execution.report.is_some()
            || execution.receipt.as_ref().map(|r| r.run_id.as_str()) != Some(run_id)
        {
            return Err(RuntimeError::Conflict(
                "delegated execution is not eligible to launch".into(),
            ));
        }
        if matches!(execution.trigger, delegated::DelegatedTrigger::Dispatch)
            && self
                .operation(&execution.child_operation_id)?
                .cancel_requested
        {
            return Err(RuntimeError::Conflict("dispatch was cancelled".into()));
        }
        Ok(Some(self.execution_task(&execution.execution_id)?))
    }
}
pub struct ChildPreparation {
    bot: bool,
    execution: delegated::DelegatedExecution,
    ingress: Option<(inputs::QueuedInputMetadata, Value)>,
    current: Option<context::CheckpointRead>,
    input_preparation: Option<resources::InputResourcePreparation>,
    expected_checkpoint: Option<String>,
    child: ChildTask,
    source: Option<launches::SourceSelection>,
    proposal: context::ContextProposal,
    basis: personalization::PersonalizationBasis,
    resources: Option<resources::ContextResources>,
    admitted: Option<context::CheckpointRead>,
    checkpoint: Option<String>,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChild {
    operation_id: String,
    submission: Option<submissions::PreparedSubmission>,
    receipt: Option<Receipt>,
}
impl ChildPreparation {
    pub fn with_input_preparation(
        mut self,
        input: Option<resources::InputResourcePreparation>,
    ) -> Self {
        self.input_preparation = input;
        self
    }
    pub fn with_expected_checkpoint(mut self, checkpoint: Option<String>) -> Self {
        self.expected_checkpoint = checkpoint;
        self
    }
    pub fn with_resources(mut self, resources: Option<resources::ContextResources>) -> Self {
        self.resources = resources;
        self
    }
    pub fn load(self) -> Result<PreparedChild> {
        let Self {
            bot,
            execution,
            ingress,
            current,
            input_preparation,
            expected_checkpoint,
            child,
            source,
            proposal,
            basis,
            mut resources,
            admitted,
            checkpoint,
            epoch,
            content,
            publication,
        } = self;
        if child.receipt.is_none() && expected_checkpoint != checkpoint {
            return Err(RuntimeError::Conflict(
                "child context changed during preparation".into(),
            ));
        }
        let continuing = !matches!(execution.trigger, delegated::DelegatedTrigger::Dispatch);
        if ingress.is_some() && input_preparation.is_some() {
            return Err(RuntimeError::Invalid(
                "message requests cannot acquire User skill input".into(),
            ));
        }
        if let Some(input) = input_preparation
            .as_ref()
            .filter(|_| child.receipt.is_none())
        {
            let expected = if resources.is_some() {
                None
            } else {
                checkpoint.clone()
            };
            if input.expected_context_checkpoint != expected {
                return Err(RuntimeError::Conflict(
                    "prepared skill context is based on another delegated checkpoint".into(),
                ));
            }
        }
        let scope = serde_json::to_value(&basis)?;
        if basis.thread_id != child.child_thread_id
            || basis.project_id != child.project_id
            || scope.get("mode").and_then(Value::as_str) != Some(if bot { "bot" } else { "agent" })
            || scope.get("threadRole").and_then(Value::as_str) != Some("worker")
            || proposal.branch_id != child.child_branch_id
            || proposal.through_id.is_some()
            || proposal.expected_revision != 0
            || !proposal.summary.is_empty()
        {
            return Err(RuntimeError::Conflict(
                "child context does not match admitted identity/role/project".into(),
            ));
        }
        if let Some(source) = &source {
            source.validate()?;
        }
        let expected = match &child.source {
            ChildSource::Absent => None,
            ChildSource::Ready { selection, .. } | ChildSource::Shared { selection, .. } => Some(selection),
            ChildSource::Pending { .. } => {
                return Err(RuntimeError::Conflict("child source is not ready".into()));
            }
        };
        if source.as_ref() != expected {
            return Err(RuntimeError::Conflict(
                "prepared source does not match child baseline identity".into(),
            ));
        }
        if let Some(receipt) = &child.receipt {
            if continuing {
                return Ok(PreparedChild {
                    operation_id: child.execution_id,
                    receipt: Some(receipt.clone()),
                    submission: None,
                });
            }
            if let Some(resources) = resources.as_mut() {
                resources.source =
                    super::followups::normalized_source(resources.source.take(), &receipt.run_id);
            }
            let admitted = admitted
                .ok_or_else(|| {
                    RuntimeError::Invalid("child admission has no context checkpoint".into())
                })?
                .load()?;
            if admitted.proposal != proposal
                || admitted.personalization.as_ref() != Some(&basis)
                || admitted.resources != resources
            {
                return Err(RuntimeError::Conflict(
                    "child preparation retry changed its admitted context".into(),
                ));
            }
            return Ok(PreparedChild {
                operation_id: child.execution_id,
                receipt: child.receipt,
                submission: None,
            });
        }
        let raw_input = if ingress.is_some() {
            Value::Null
        } else {
            content.load(&child.input_ref)?
        };
        let input = if continuing {
            raw_input
        } else {
            let input: DispatchInput = serde_json::from_value(raw_input)?;
            Value::String(input.task)
        };
        let configuration = content.load(&child.configuration_ref)?;
        let mut launch = child.launch.load_child_intent(&content)?;
        launch.source = source;
        let operation_id = child.execution_id;
        let source_fact = if let Some(delegated::ChildSourceBasis::Refreshed { incoming, root, .. }) = &execution.source_basis {
            let provenance = match &execution.source { Some(ChildSource::Ready { provenance_ref, .. }) => content.load(provenance_ref)?, _ => Value::Null };
            let fact = crate::execution::ConversationItem::<crate::output::ResolvedMedia> {
                id: format!("child-source-refresh:{}", execution.execution_id),
                provenance: crate::execution::Provenance::EnvironmentFact { event_id: format!("child-source-refresh:{}", execution.execution_id) },
                content: crate::execution::Content::Text { text: format!("本轮文件基础已更新，携带了此前成果中的修改。\n{}", json!({"previousRoot":root,"incoming":incoming,
                    "root":provenance["root"],"incomingRoot":provenance["incomingRoot"],"incomingBranch":format!("child-incoming:{}",execution.execution_id),"conflicts":provenance["conflicts"]})) },
                opaque: None, resource_activation: None,
            };
            Some(content.save_history(&serde_json::to_value(fact)?, &None)?)
        } else { None };
        let mut submission = submissions::PreparedSubmission::stage(submissions::SubmissionBody {
            inherited_context: if continuing { None } else { child.inherited_context.clone() },
            input_preparation,
            command: SubmitInput {
                key: format!("child:{operation_id}"),
                thread_id: child.child_thread_id,
                branch_id: child.child_branch_id,
                expected_head: match &execution.trigger {
                    delegated::DelegatedTrigger::UserContinuation { expected_head, .. }
                    | delegated::DelegatedTrigger::MessageRequest { expected_head, .. }
                    | delegated::DelegatedTrigger::ComputerEvent { expected_head, .. }
                    | delegated::DelegatedTrigger::Followup { expected_head, .. }
                    | delegated::DelegatedTrigger::Calendar { expected_head, .. } => {
                        expected_head.clone()
                    }
                    _ => None,
                },
                input,
                configuration,
            },
            launch: Some(launch),
            inherit_source: false,
            initial: Some(proposal),
            current: if continuing { current } else { None },
            personalization: Some(basis),
            resources,
            origin: if let Some((input, history)) = ingress {
                submissions::SubmissionOrigin::Ingress {
                    input,
                    history,
                    execution_id: Some(operation_id.clone()),
                    checkpoint,
                }
            } else if continuing {
                submissions::SubmissionOrigin::ChildContinuation {
                    execution_id: operation_id.clone(),
                    checkpoint,
                }
            } else {
                submissions::SubmissionOrigin::Child {
                    operation_id: operation_id.clone(),
                    checkpoint,
                    parent_thread_id: child.parent_thread_id,
                }
            },
            epoch,
            content,
            publication,
        })?;
        if let Some(fact) = source_fact { submission.environment.push(fact); }
        Ok(PreparedChild {
            operation_id,
            submission: Some(submission),
            receipt: None,
        })
    }
}
impl Catalog {
    pub fn fail_child_preparation(
        &mut self,
        execution_id: &str,
        reason: &str,
    ) -> Result<ChildTask> {
        self.fail_delegated_preparation(execution_id, reason, None)?;
        self.execution_task(execution_id)
    }
    pub fn cancel_child(&mut self, operation_id: &str) -> Result<ChildTask> {
        self.cancel_tree(super::dispatch::TreeCancelTarget::Child {
            operation_id: operation_id.into(),
        })?;
        self.child_task(operation_id)
    }
    pub fn mark_child_resources_released(&mut self, execution_id: &str) -> Result<ChildTask> {
        self.release_delegated_resources(execution_id)?;
        self.execution_task(execution_id)
    }
    pub(super) fn publish_child_report(
        &mut self,
        mut child: ChildTask,
        terminal_head: Option<String>,
    ) -> Result<ChildTask> {
        let tx = self.db.transaction()?;
        let old: ChildTask = delegated::execution_task(&tx, &child.execution_id)?;
        if old.report.is_some() {
            return Ok(old);
        }
        child.revision = old.revision + 1;
        delegated::write_child_task(&tx, &child)?;
        let mut execution = delegated::execution(&tx, &child.execution_id)?;
        if execution.receipt.is_some() {
            execution.terminal_head = terminal_head;
            delegated::write_execution(&tx, &execution)?;
        }
        event(
            &tx,
            &child.execution_id,
            child.revision,
            "child.report_ready",
            json!({"sender_thread_id":child.child_thread_id,"outcome":child.report.as_ref().map(|r|r.outcome),"atMs":observations::wall_time_ms()?}),
        )?;
        tx.commit()?;
        Ok(child)
    }
}

pub(super) fn validate_submission(
    tx: &Transaction<'_>,
    execution_id: &str,
    command: &submissions::SubmissionIdentity,
) -> Result<()> {
    let execution = delegated::execution(tx, execution_id)?;
    let child = delegated::relation(tx, &execution.child_operation_id)?;
    if execution.receipt.is_some()
        || execution.report.is_some()
        || execution.cancel_requested
        || execution.source.is_none()
        || command.thread_id != child.child_thread_id
        || command.branch_id != child.child_branch_id
    {
        return Err(RuntimeError::Conflict(
            "delegated preparation was cancelled or superseded".into(),
        ));
    }
    if matches!(execution.trigger, delegated::DelegatedTrigger::Dispatch)
        && record::<Operation>(tx, "operations", &child.operation_id)?.cancel_requested
    {
        return Err(RuntimeError::Conflict(
            "dispatch preparation was cancelled".into(),
        ));
    }
    Ok(())
}
pub(super) fn publish_submission(
    tx: &Transaction<'_>,
    execution_id: &str,
    receipt: &Receipt,
) -> Result<()> {
    let mut execution = delegated::execution(tx, execution_id)?;
    execution.receipt = Some(receipt.clone());
    execution.revision += 1;
    delegated::write_execution(tx, &execution)?;
    let mut launch: launch_content::LaunchMetadata = record(tx, "run_launches", &receipt.run_id)?;
    launch.policy_target = execution.policy_target;
    put(tx, "run_launches", &receipt.run_id, &launch)?;
    event(
        tx,
        execution_id,
        execution.revision,
        "child.prepared",
        json!({"run_id":receipt.run_id}),
    )?;
    Ok(())
}

impl Catalog {
    pub fn require_child_parent(&self, run_id: &str, operation_id: &str) -> Result<ChildTask> {
        let run = self.run(run_id)?;
        let child = self.child_task(operation_id)?;
        if child.parent_thread_id != run.thread_id {
            return Err(RuntimeError::Conflict(
                "child belongs to another parent Thread".into(),
            ));
        }
        Ok(child)
    }
    pub fn register_child_wait(
        &mut self,
        prepared: child_content::PreparedChildWaitRegistration,
    ) -> Result<Wait> {
        let context = &prepared.context;
        let operation_id = prepared.child_operation_id.as_str();
        let child = if prepared.tool_name == super::retrieval::CONTROL_TOOL {
            self.require_retrieval_parent(&context.run_id, operation_id)?
        } else { self.require_child_parent(&context.run_id, operation_id)? };
        let wait_id = format!("child-wait:{}", context.operation_id);
        let tx = self.db.transaction()?;
        let run: Run = record(&tx, "runs", &context.run_id)?;
        let mut op: Operation = record(&tx, "operations", &context.operation_id)?;
        let admitted = super::tool_content::ToolIntent::from_operation(&op)?;
        if op.run_id != context.run_id
            || admitted.origin() != &context.origin
            || admitted != prepared.intent
        {
            return Err(RuntimeError::Conflict(
                "child wait invocation changed".into(),
            ));
        }
        if let Some(wait) = optional_record::<Wait>(&tx, "waits", &wait_id)? {
            if wait.run_id != run.id || wait.subject != operation_id {
                return Err(RuntimeError::Conflict("child wait target changed".into()));
            }
            // A retry returns the existing observation, including cancellation/delivery, without
            // reviving its operation or replacing the original accepted completion.
            return Ok(wait);
        }
        fence(&run, self.epoch)?;
        super::tool_content::require_job_invocation(&tx, &run, &op, context, &prepared.tool_name)?;
        if run.state.terminal()
            || run.cancel_requested
            || op.cancel_requested
            || op.phase != OperationPhase::Running
            || op.revision != prepared.operation_revision
        {
            return Err(RuntimeError::Conflict(
                "parent can no longer register this wait".into(),
            ));
        }
        let trigger_cursor = tx.query_row(
            "SELECT cursor FROM events WHERE subject=?1 AND kind='operation.settled' AND cursor>?2 ORDER BY cursor LIMIT 1",
            params![operation_id, sql_number(child.cursor)?], |r| read_number(r, 0),
        ).optional()?;
        let wait = Wait {
            id: wait_id.clone(),
            run_id: run.id.clone(),
            subject: operation_id.into(),
            kind: "operation.settled".into(),
            after_cursor: child.cursor,
            deadline_at_ms: None,
            trigger_cursor,
            cancelled: false,
        };
        tx.execute(
            "INSERT INTO waits(id,run_id,body) VALUES(?1,?2,?3)",
            params![wait.id, wait.run_id, encode(&wait)?],
        )?;
        if let Some(cursor) = trigger_cursor {
            Self::enqueue_resume(&tx, &wait, cursor)?;
        }
        event(
            &tx,
            &wait.id,
            1,
            "wait.registered",
            serde_json::to_value(&wait)?,
        )?;
        op.waiting_on = Some(wait_id);
        op.phase = OperationPhase::Waiting;
        op.handed_off = true;
        op.revision += 1;
        super::result_content::publish_job_acceptance(&tx, &mut op, &admitted, "awaiting_child")?;
        put(&tx, "operations", &op.id, &op)?;
        event(
            &tx,
            &op.id,
            op.revision,
            "child.wait_registered",
            json!({"wait_id":wait.id,"child_operation_id":operation_id}),
        )?;
        tx.commit()?;
        Ok(wait)
    }
    pub fn pending_child_wait(&self, run_id: &str) -> Result<Option<String>> {
        self.db.query_row("SELECT json_extract(body,'$.waiting_on') FROM operations WHERE run_id=?1 AND json_extract(body,'$.executor') IN (?2,?3) AND json_extract(body,'$.phase')!='terminal' AND json_extract(body,'$.waiting_on') IS NOT NULL ORDER BY rowid LIMIT 1",
            params![run_id,WAIT_TOOL,super::retrieval::CONTROL_TOOL],|row|row.get(0)).optional().map_err(Into::into)
    }

    pub fn inspect_child_wait(&self, wait_id: &str) -> Result<Wait> {
        if !wait_id.starts_with("child-wait:") {
            return Err(RuntimeError::Invalid("not a collaboration Wait".into()));
        }
        record(&self.db, "waits", wait_id)
    }
    pub fn request_cancel_child_wait(&mut self, wait_id: &str) -> Result<Wait> {
        if !wait_id.starts_with("child-wait:") {
            return Err(RuntimeError::Invalid("not a collaboration Wait".into()));
        }
        self.reconcile_waits()?;
        let wait: Wait = record(&self.db, "waits", wait_id)?;
        if wait.trigger_cursor.is_some() {
            return Ok(wait);
        }
        self.cancel_wait(wait_id)
    }
    /// Only a parked Run has relinquished its model-history writer. Do not append a report
    /// between a model call and its tool results, or concurrently with a frozen request.
    pub(super) fn close_finished_parent_waits(&mut self) -> Result<()> {
        let tx = self.db.transaction()?;
        let operations: Vec<Operation> = {
            let mut statement=tx.prepare("SELECT o.body FROM operations o JOIN runs r ON r.id=o.run_id WHERE json_extract(o.body,'$.executor') IN (?1,?2) AND json_extract(o.body,'$.phase')!='terminal' AND json_extract(o.body,'$.waiting_on') LIKE 'child-wait:%' AND json_extract(r.body,'$.state') IN ('completed','failed','cancelled')")?;
            let rows = statement
                .query_map([WAIT_TOOL,super::retrieval::CONTROL_TOOL], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(|row| serde_json::from_str(&row).map_err(Into::into))
                .collect::<Result<_>>()?
        };
        let mut released = Vec::new();
        for mut op in operations {
            if !matches!(op.executor.as_deref(),Some(WAIT_TOOL | super::retrieval::CONTROL_TOOL)) || op.phase == OperationPhase::Terminal {
                continue;
            }
            let run: Run = record(&tx, "runs", &op.run_id)?;
            if !run.state.terminal() {
                continue;
            }
            if let Some(id) = &op.waiting_on {
                let mut wait: Wait = record(&tx, "waits", id)?;
                wait.cancelled = true;
                put(&tx, "waits", id, &wait)?;
            }
            op.phase = OperationPhase::Terminal;
            op.outcome = Some(Outcome::Cancelled);
            op.effect = Effect::None;
            op.cancel_requested = true;
            op.revision += 1;
            op.result = Some(OperationResultMetadata::Control {
                value: json!({"wait_cancelled":true,"reason":"parent_run_finished"}),
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
            released.push(op.id);
        }
        tx.commit()?;
        for id in released {
            self.resource_admission.release(&id);
        }
        Ok(())
    }
}

/// A fixed source may have been pinned before its child admission was committed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UnacceptedChildSourcePin {
    pub source: launches::SourceSelection,
    pub pin_id: String,
}
/// Cleanup of a stopped dispatch is bound to its original Operation and dependency cut.
/// The target's selection receipt is deliberately unnecessary: its ACK may have been lost.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UnacceptedChildDependencies {
    pub parent_run_id: String,
    pub parent_thread_id: String,
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub execution_epoch: u64,
    pub source_pin: Option<UnacceptedChildSourcePin>,
    pub mcp_binding: Option<launches::HostToolBinding>,
}
struct UnacceptedChildDependencyRead {
    dependencies: UnacceptedChildDependencies,
    call: tool_content::ToolCallMetadata,
    dispatch: dispatch::ChildInvocationRead,
}
/// Short original identities are captured under Catalog; body reads and delegation resolution
/// run on a worker after releasing its shared lock, just like child admission.
pub struct UnacceptedChildDependenciesRead {
    dispatches: Vec<UnacceptedChildDependencyRead>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl UnacceptedChildDependenciesRead {
    pub fn load(self) -> Result<Vec<UnacceptedChildDependencies>> {
        let mut pending = Vec::new();
        for read in self.dispatches {
            let selected = read.dispatch.load()?;
            let call = read.call.load(&self.content)?;
            let input=DispatchInput::from_tool_call(&call.name,&call.arguments)?;
            let resolved = selected.resolve(&input)?;
            let mut dependencies = read.dependencies;
            dependencies.source_pin = selected
                .frozen
                .source
                .map(|source| UnacceptedChildSourcePin {
                    source,
                    pin_id: format!("child-pin:{}", dependencies.operation_id),
                });
            // Local MCP leases disappear with their process. Managed retains are durable on
            // their exact original Source owners, even for live/materialized file selections.
            dependencies.mcp_binding = resolved.mcp_binding.filter(|binding| {
                binding.provenance.servers.values().any(|server| {
                    matches!(
                        server.owner.resource_owner,
                        launches::SourceResourceOwner::ManagedHost { .. }
                    )
                })
            });
            if dependencies.source_pin.is_some() || dependencies.mcp_binding.is_some() {
                pending.push(dependencies);
            }
        }
        Ok(pending)
    }
}
fn unaccepted_child_dependency_owner(db: &Connection, op: &Operation) -> Result<bool> {
    if !matches!(op.executor.as_deref(),Some(DISPATCH_TOOL|"code_retrieval"))
        || op.phase != OperationPhase::Terminal
        || op.execution_owner.is_none()
    {
        return Ok(false);
    }
    let owned: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM child_tasks WHERE id=?1) OR EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='child.dependencies_released')",
        [&op.id], |row| row.get(0),
    )?;
    Ok(!owned)
}
impl Catalog {
    /// A target can retain dependencies durably before Catalog accepts the ChildTask. Only a
    /// terminal original dispatch can request cleanup; neither a later launch nor a current epoch
    /// may replace the invocation that created those dependencies.
    pub fn capture_unaccepted_child_dependencies(&self) -> Result<UnacceptedChildDependenciesRead> {
        let mut dispatches = Vec::new();
        for op in read_all::<Operation>(&self.db, "operations")? {
            if !unaccepted_child_dependency_owner(&self.db, &op)? {
                continue;
            }
            let intent = tool_content::ToolIntent::from_operation(&op)?;
            if !matches!(intent.call().name.as_str(),DISPATCH_TOOL|"code_retrieval") {
                return Err(RuntimeError::Conflict(
                    "dispatch cleanup invocation changed".into(),
                ));
            }
            let run = self.run(&op.run_id)?;
            let context = ToolExecutionContext {
                run_id: run.id.clone(),
                operation_id: op.id.clone(),
                origin: intent.origin().clone(),
            };
            let dispatch = self.capture_child_dispatch_invocation(&context)?;
            dispatches.push(UnacceptedChildDependencyRead {
                dependencies: UnacceptedChildDependencies {
                    parent_run_id: run.id,
                    parent_thread_id: run.thread_id,
                    operation_id: op.id,
                    execution_owner: op.execution_owner.expect("captured execution owner"),
                    execution_epoch: op.epoch,
                    source_pin: None,
                    mcp_binding: None,
                },
                call: intent.call().clone(),
                dispatch,
            });
        }
        Ok(UnacceptedChildDependenciesRead {
            dispatches,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    /// The caller acknowledges only after all original file and managed MCP releases complete.
    /// This short commit rechecks ownership without decoding immutable input/binding bodies.
    pub fn mark_unaccepted_child_dependencies_released(
        &mut self,
        operation_id: &str,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let done: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE subject=?1 AND kind='child.dependencies_released')",
            [operation_id], |row| row.get(0),
        )?;
        if done {
            return Ok(());
        }
        let op: Operation = record(&tx, "operations", operation_id)?;
        if !unaccepted_child_dependency_owner(&tx, &op)?
            || !matches!(tool_content::ToolIntent::from_operation(&op)?.call().name.as_str(),DISPATCH_TOOL|"code_retrieval")
        {
            return Err(RuntimeError::Conflict(
                "dependency cleanup no longer owns this dispatch".into(),
            ));
        }
        event(
            &tx,
            operation_id,
            1,
            "child.dependencies_released",
            Value::Null,
        )?;
        tx.commit()?;
        Ok(())
    }
}

pub struct ChildSourcePreparation {
    execution: delegated::DelegatedExecution,
    profile_ref:Value,
    pin: ChildSourcePin,
    selection: launches::SourceSelection,
    provenance: ChildSourceProvenance,
    epoch: u64,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedChildSource {
    execution: delegated::DelegatedExecution,
    source: ChildSource,
    epoch: u64,
    _publication: crate::content::ContentPublication,
}
impl ChildSourcePreparation {
    pub fn load(self) -> Result<PreparedChildSource> {
        self.pin.source.validate()?;
        self.selection.validate()?;
        let branch = format!("child-source:{}", self.execution.execution_id);
        let profile:super::dispatch::ChildSelectedProfile=serde_json::from_value(self.content.load(&self.profile_ref)?)?;
        let mode = if profile.work_mode!=super::dispatch::ChildWorkMode::IsolatedWrite {
            SourceMode::FixedBranch
        } else {
            match self.selection.mode {SourceMode::NativeWorkspace=>SourceMode::NativeWorkspace,SourceMode::Materialized=>SourceMode::Materialized,
                _=>return Err(RuntimeError::Conflict("Isolated source needs an independent writable workspace".into()))}
        };
        let (base, handoff) = match (&self.execution.source, &self.execution.source_basis) {
            (Some(ChildSource::Pending { handoff }), None) => {
                (handoff.source.clone(), Some(handoff.clone()))
            }
            (
                Some(ChildSource::Ready {
                    handoff, selection, ..
                }),
                _,
            ) => (selection.clone(), handoff.clone()),
            (None, Some(basis)) => (basis.source().clone(), None),
            _ => {
                return Err(RuntimeError::Conflict(
                    "delegated source basis is unavailable".into(),
                ));
            }
        };
        if handoff.as_ref().is_some_and(|handoff|matches!(handoff.root,ChildSourceRoot::Native{..}))&&mode!=SourceMode::NativeWorkspace{
            return Err(RuntimeError::Conflict("A native workspace handoff cannot fall back to a physical copy".into()));
        }
        if self.selection.mode != mode
            || self.selection.branch_id.as_deref() != Some(&branch)
            || self.selection.revision != if mode==SourceMode::NativeWorkspace {None}else{Some(0)}
            || self.selection.native_scope.is_some()
            || self.selection.environment_run_id.is_some()
            || self.selection.resource_owner != base.resource_owner
            || self.selection.workspace_id != base.workspace_id
            || self.selection.execution_workspace_id != if mode==SourceMode::NativeWorkspace {launches::native_execution_workspace_id(&self.execution.execution_id)}else{base.execution_workspace_id.clone()}
            || self.pin.source.mode != SourceMode::FixedBranch
            || self.pin.source.branch_id.as_deref() != Some(&branch)
            || self.pin.source.revision != Some(0)
            || self.pin.source.resource_owner != self.selection.resource_owner
            || self.pin.source.workspace_id != self.selection.workspace_id
            || self.pin.source.execution_workspace_id != self.selection.execution_workspace_id
            || self.pin.root.is_empty()
            || self.pin.pin_id.is_empty()
            || (self.execution.source_basis.is_some()
                && self.pin.pin_id != format!("child-source-pin:{}", self.execution.execution_id))
        {
            return Err(RuntimeError::Conflict(
                "prepared delegated source identity changed".into(),
            ));
        }
        let provenance_ref = self
            .content
            .save(&serde_json::to_value(&self.provenance)?)?;
        if let Some(basis) = &self.execution.source_basis {
            let matches = if let delegated::ChildSourceBasis::Refreshed { incoming, root, .. } = basis {
                matches!(&self.provenance, ChildSourceProvenance::RefreshedRoot { root: next, previous_root, incoming: selected, incoming_root, .. }
                    if next == &self.pin.root && previous_root == root && selected == incoming && !incoming_root.is_empty())
            } else { self.pin.root == basis.root() && provenance_ref == *basis.provenance_ref() };
            if !matches {
                return Err(RuntimeError::Conflict(
                    "continued source differs from its exact immutable basis".into(),
                ));
            }
        } else if let Some(handoff) = &handoff {
            if let ChildSourceRoot::Fixed { pin } | ChildSourceRoot::Native { pin } = &handoff.root {
                if pin.root != self.pin.root
                    || !matches!(&self.provenance,ChildSourceProvenance::FixedRoot{root,..} if root==&pin.root)
                {
                    return Err(RuntimeError::Conflict(
                        "fixed child source differs from its handoff".into(),
                    ));
                }
            } else if matches!(self.provenance, ChildSourceProvenance::FixedRoot { .. }) {
                return Err(RuntimeError::Conflict(
                    "physical capture cannot claim a fixed-root source".into(),
                ));
            }
        }
        let source = ChildSource::Ready {
            handoff,
            pin: self.pin,
            selection: self.selection,
            provenance_ref,
        };
        Ok(PreparedChildSource {
            execution: self.execution,
            source,
            epoch: self.epoch,
            _publication: self.publication,
        })
    }
}
impl Catalog {
    pub fn prepare_child_source(
        &self,
        execution_id: &str,
        pin: ChildSourcePin,
        selection: launches::SourceSelection,
        provenance: ChildSourceProvenance,
    ) -> Result<ChildSourcePreparation> {
        let execution=self.delegated_execution(execution_id)?;
        let profile_ref=delegated::relation(&self.db,&execution.child_operation_id)?.selected_profile_ref;
        Ok(ChildSourcePreparation {
            execution,profile_ref,
            pin,
            selection,
            provenance,
            epoch: self.epoch,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        })
    }
    pub fn attach_child_source(&mut self, prepared: PreparedChildSource) -> Result<ChildTask> {
        let mut execution = self.delegated_execution(&prepared.execution.execution_id)?;
        if execution.source.as_ref() == Some(&prepared.source) {
            return self.execution_task(&execution.execution_id);
        }
        if prepared.epoch != self.epoch
            || execution.revision != prepared.execution.revision
            || execution.receipt.is_some()
            || execution.report.is_some()
            || execution.cancel_requested
            || matches!(execution.source, Some(ChildSource::Ready { .. } | ChildSource::Shared { .. }))
            || (matches!(execution.trigger, delegated::DelegatedTrigger::Dispatch)
                && self
                    .operation(&execution.child_operation_id)?
                    .cancel_requested)
        {
            return Err(RuntimeError::Conflict(
                "delegated source preparation was cancelled or superseded".into(),
            ));
        }
        execution.source = Some(prepared.source);
        execution.revision += 1;
        let tx = self.db.transaction()?;
        delegated::write_execution(&tx, &execution)?;
        event(
            &tx,
            &execution.execution_id,
            execution.revision,
            "child.source_ready",
            Value::Null,
        )?;
        tx.commit()?;
        self.execution_task(&execution.execution_id)
    }
    /// Synchronous fixture convenience; production loads writer bindings outside Catalog.
    pub fn begin_child_settlement(&mut self, operation_id: &str) -> Result<ChildTask> {
        let _synchronous = self.content.begin_synchronous()?;
        let bindings = self.capture_child_writer_bindings(operation_id)?.load()?;
        self.begin_child_settlement_bound(operation_id, &bindings)
    }
    pub fn begin_child_settlement_bound(
        &mut self,
        operation_id: &str,
        bindings: &ChildWriterBindings,
    ) -> Result<ChildTask> {
        if operation_id != bindings.operation_id {
            return Err(RuntimeError::Conflict(
                "child writer identity changed".into(),
            ));
        }
        let mut child = self.execution_task(operation_id)?;
        let receipt = child
            .receipt
            .as_ref()
            .ok_or_else(|| RuntimeError::Conflict("child has no admitted Run".into()))?;
        if !self.run(&receipt.run_id)?.state.terminal() {
            return Err(RuntimeError::Conflict(
                "child execution is still active".into(),
            ));
        }
        self.require_child_writers_stopped(bindings)?;
        if !matches!(child.code_result, ChildCodeResult::Pending) {
            return Ok(child);
        }
        child.code_result = ChildCodeResult::Settling {
            publication_id: format!("child-result:{operation_id}"),
        };
        child.state = "settling".into();
        self.commit_child_metadata(child, "child.settling")
    }
    /// Storage proved that this fixed Run never published a physical execution view.
    pub fn settle_child_without_execution_view(&mut self,operation_id:&str,bindings:&ChildWriterBindings)->Result<ChildTask> {
        if operation_id!=bindings.operation_id {return Err(RuntimeError::Conflict("Child writer identity changed".into()));}
        self.require_child_writers_stopped(bindings)?;
        let mut child=self.execution_task(operation_id)?;
        let receipt=child.receipt.as_ref().ok_or_else(||RuntimeError::Conflict("Child has no Run".into()))?;
        if !self.run(&receipt.run_id)?.state.terminal() || child.source.selection().is_none_or(|source|source.mode!=SourceMode::FixedBranch) {
            return Err(RuntimeError::Conflict("Only a stopped immutable child can settle without an execution view".into()));
        }
        if child.code_result==ChildCodeResult::NoChanges {return Ok(child)};
        if !matches!(child.code_result,ChildCodeResult::Pending) {return Err(RuntimeError::Conflict("Child already owns a result publication".into()));}
        child.code_result=ChildCodeResult::NoChanges;
        self.commit_child_metadata(child,"child.source_unchanged")
    }
    /// Synchronous fixture convenience; production loads writer bindings outside Catalog.
    pub fn attach_child_candidate(
        &mut self,
        operation_id: &str,
        candidate: crate::KernelWorkingResultCandidate,
    ) -> Result<ChildTask> {
        let _synchronous = self.content.begin_synchronous()?;
        let bindings = self.capture_child_writer_bindings(operation_id)?.load()?;
        self.attach_child_candidate_bound(operation_id, candidate, &bindings)
    }
    pub fn attach_child_candidate_bound(
        &mut self,
        operation_id: &str,
        candidate: crate::KernelWorkingResultCandidate,
        bindings: &ChildWriterBindings,
    ) -> Result<ChildTask> {
        if operation_id != bindings.operation_id {
            return Err(RuntimeError::Conflict(
                "child writer identity changed".into(),
            ));
        }
        self.require_child_writers_stopped(bindings)?;
        let mut child = self.execution_task(operation_id)?;
        let publication_id = format!("child-result:{operation_id}");
        if candidate.publication_id != publication_id
            || candidate.candidate_operation_id != format!("result-prepare:{publication_id}")
            || candidate.branch_id != format!("child-source:{operation_id}")
            || candidate.workspace_id
                != child
                    .source
                    .selection()
                    .ok_or_else(|| RuntimeError::Conflict("child source is not ready".into()))?
                    .workspace_id
        {
            return Err(RuntimeError::Conflict(
                "result candidate does not belong to this child".into(),
            ));
        }
        if let ChildCodeResult::Candidate { candidate: old } = &child.code_result {
            return if old == &candidate {
                Ok(child)
            } else {
                Err(RuntimeError::Conflict(
                    "child result candidate changed".into(),
                ))
            };
        }
        if child.code_result != (ChildCodeResult::Settling { publication_id }) {
            return Err(RuntimeError::Conflict(
                "child is not ready to attach a result candidate".into(),
            ));
        }
        child.code_result = ChildCodeResult::Candidate { candidate };
        self.commit_child_metadata(child, "child.result_candidate")
    }
    /// Synchronous fixture convenience; production loads writer bindings outside Catalog.
    pub fn attach_child_result(
        &mut self,
        operation_id: &str,
        result: ChildWorkingResultRef,
        effect: Effect,
    ) -> Result<ChildTask> {
        let _synchronous = self.content.begin_synchronous()?;
        let bindings = self.capture_child_writer_bindings(operation_id)?.load()?;
        self.attach_child_result_bound(operation_id, result, effect, &bindings)
    }
    pub fn attach_child_result_bound(
        &mut self,
        operation_id: &str,
        result: ChildWorkingResultRef,
        effect: Effect,
        bindings: &ChildWriterBindings,
    ) -> Result<ChildTask> {
        self.attach_child_result_files_bound(operation_id,result,effect,bindings,None)
    }
    pub fn attach_child_result_files_bound(&mut self,operation_id:&str,result:ChildWorkingResultRef,effect:Effect,
        bindings:&ChildWriterBindings,changed_paths:Option<&[String]>) -> Result<ChildTask> {
        if operation_id != bindings.operation_id {
            return Err(RuntimeError::Conflict(
                "child writer identity changed".into(),
            ));
        }
        self.require_child_writers_stopped(bindings)?;
        let mut child = self.execution_task(operation_id)?;
        match &child.code_result {
            ChildCodeResult::Candidate { candidate }
                if candidate.publication_id == result.publication_id
                    && candidate.workspace_id == result.workspace_id
                    && candidate.branch_id == result.branch_id
                    && candidate.root == result.root
                    && candidate.base_root == result.base_root =>
            {
                ()
            }
            ChildCodeResult::Published {
                result: old,
                effect: old_effect,
            } if old == &result && (*old_effect == effect || *old_effect == Effect::Unknown) => (),
            _ => {
                return Err(RuntimeError::Conflict(
                    "WorkingResult does not match the original child candidate".into(),
                ));
            }
        }
        if child.code_result
            == (ChildCodeResult::Published {
                result: result.clone(),
                effect,
            })
        {
            if let Some(paths)=changed_paths {
                let tx=self.db.transaction()?;
                for path in paths {tx.execute("INSERT OR IGNORE INTO child_result_files(execution_id,path) VALUES(?1,?2)",params![child.execution_id,path])?;}
                tx.commit()?;
            }
            return Ok(child);
        }
        child.code_result = ChildCodeResult::Published { result, effect };
        if let Some(report) = &child.report {
            child.state = match report.outcome {
                Outcome::Succeeded => "completed",
                Outcome::Cancelled => "cancelled",
                _ => "failed",
            }
            .into();
        }
        self.commit_child_metadata_with_files(child, "child.result_ready", changed_paths)
    }
    /// Synchronous fixture convenience; production loads the original binding bodies outside Catalog.
    pub fn child_writers_stopped_sync(&self, operation_id: &str) -> Result<bool> {
        let _synchronous = self.content.begin_synchronous()?;
        let bindings = self.capture_child_writer_bindings(operation_id)?.load()?;
        self.child_writers_stopped(&bindings)
    }
    /// Synchronous fixture convenience; production uses child_file_effect_bound.
    pub fn child_file_effect(&self, operation_id: &str) -> Result<Effect> {
        let _synchronous = self.content.begin_synchronous()?;
        let bindings = self.capture_child_writer_bindings(operation_id)?.load()?;
        self.child_file_effect_bound(&bindings)
    }
    fn require_child_writers_stopped(&self, bindings: &ChildWriterBindings) -> Result<()> {
        if !self.child_writers_stopped(bindings)? {
            return Err(RuntimeError::Conflict(
                "child execution owner has not confirmed stop".into(),
            ));
        }
        Ok(())
    }
    pub fn child_writers_stopped(&self, bindings: &ChildWriterBindings) -> Result<bool> {
        let operations = self.child_writer_operations(bindings)?;
        Ok(!operations.iter().any(|operation| {
            bindings.is_writer(operation, false)
                && !matches!(
                    operation.call_completion,
                    Some(super::result_content::ToolCompletionMetadata::NotDispatched { .. })
                )
                && !operation
                    .external_receipt
                    .as_ref()
                    .is_some_and(|receipt| receipt.executor_stopped)
        }))
    }
    pub fn child_file_effect_bound(&self, bindings: &ChildWriterBindings) -> Result<Effect> {
        let operations = self.child_writer_operations(bindings)?;
        let Some(run_id) = &bindings.run_id else {
            return Ok(Effect::None);
        };
        let mut confirmed = false;
        let mut partial = false;
        for operation in operations
            .iter()
            .filter(|operation| bindings.is_writer(operation, true))
        {
            match operation.effect {
                Effect::Unknown | Effect::Dispatched => return Ok(Effect::Unknown),
                Effect::Confirmed => confirmed = true,
                Effect::Partial => partial = true,
                _ => (),
            }
        }
        if partial || (confirmed && self.run(run_id)?.state != RunState::Completed) {
            Ok(Effect::Partial)
        } else if confirmed {
            Ok(Effect::Confirmed)
        } else {
            Ok(Effect::None)
        }
    }
    fn child_writer_operations(
        &self,
        bindings: &ChildWriterBindings,
    ) -> Result<Vec<OperationMetadata>> {
        let child = self.execution_task(&bindings.operation_id)?;
        if child.receipt.as_ref().map(|receipt| &receipt.run_id) != bindings.run_id.as_ref() {
            return Err(RuntimeError::Conflict("child writer Run changed".into()));
        }
        let Some(run_id) = &bindings.run_id else {
            return Ok(Vec::new());
        };
        let launch = self
            .launch_metadata(run_id)?
            .ok_or_else(|| RuntimeError::NotFound("child launch".into()))?;
        if launch.selection.mcp_binding_ref != bindings.mcp_binding_ref
            || Some(&launch.selection.extension_bindings_ref)
                != bindings.extension_bindings_ref.as_ref()
        {
            return Err(RuntimeError::Conflict(
                "child writer bindings changed".into(),
            ));
        }
        let mut statement = self
            .db
            .prepare("SELECT body FROM operations WHERE run_id=?1")?;
        let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn capture_child_writer_bindings(
        &self,
        operation_id: &str,
    ) -> Result<ChildWriterBindingsRead> {
        let child = self.execution_task(operation_id)?;
        let run_id = child.receipt.map(|receipt| receipt.run_id);
        let launch = run_id
            .as_ref()
            .map(|run_id| {
                self.launch_metadata(run_id).and_then(|launch| {
                    launch.ok_or_else(|| RuntimeError::NotFound("child launch".into()))
                })
            })
            .transpose()?;
        Ok(ChildWriterBindingsRead {
            operation_id: operation_id.into(),
            run_id,
            mcp_binding_ref: launch
                .as_ref()
                .and_then(|launch| launch.selection.mcp_binding_ref.clone()),
            extension_bindings_ref: launch.map(|launch| launch.selection.extension_bindings_ref),
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
    fn commit_child_metadata(&mut self, child: ChildTask, kind: &str) -> Result<ChildTask> {
        self.commit_child_metadata_with_files(child,kind,None)
    }
    fn commit_child_metadata_with_files(&mut self, mut child: ChildTask, kind: &str, files:Option<&[String]>) -> Result<ChildTask> {
        let tx = self.db.transaction()?;
        child.revision += 1;
        delegated::write_child_task(&tx, &child)?;
        if let Some(files)=files {
            for path in files {tx.execute("INSERT OR IGNORE INTO child_result_files(execution_id,path) VALUES(?1,?2)",params![child.execution_id,path])?;}
        }
        event(&tx, &child.execution_id, child.revision, kind, Value::Null)?;
        tx.commit()?;
        Ok(child)
    }
}

/// A derived read of the child's exact committed launch, never another execution authority.
pub struct ChildWriterBindingsRead {
    operation_id: String,
    run_id: Option<String>,
    mcp_binding_ref: Option<Value>,
    extension_bindings_ref: Option<Value>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
pub struct ChildWriterBindings {
    operation_id: String,
    run_id: Option<String>,
    mcp_binding_ref: Option<Value>,
    extension_bindings_ref: Option<Value>,
    external_writers: std::collections::BTreeSet<(String, String)>,
    _publication: crate::content::ContentPublication,
}
impl ChildWriterBindingsRead {
    pub fn load(self) -> Result<ChildWriterBindings> {
        let mut external_writers = std::collections::BTreeSet::new();
        if let Some(reference) = &self.mcp_binding_ref {
            let binding: launches::HostToolBinding =
                serde_json::from_value(self.content.load(reference)?)?;
            binding.validate()?;
            external_writers.extend(binding.tools.iter()
                .filter(|tool| binding.tool_uses_workspace(&tool.name))
                .map(|tool| (binding.reference.clone(), tool.name.clone())));
        }
        if let Some(reference) = &self.extension_bindings_ref {
            let bindings: Vec<launches::ExtensionToolBinding> =
                serde_json::from_value(self.content.load(reference)?)?;
            for binding in bindings {
                binding.validate()?;
                // Ordinary services receive the child's own invocation source authority.
                external_writers.insert((binding.provider_key, binding.tool.name));
            }
        }
        Ok(ChildWriterBindings {
            operation_id: self.operation_id,
            run_id: self.run_id,
            mcp_binding_ref: self.mcp_binding_ref,
            extension_bindings_ref: self.extension_bindings_ref,
            external_writers,
            _publication: self._publication,
        })
    }
}
impl ChildWriterBindings {
    fn is_writer(&self, operation: &OperationMetadata, include_native_files: bool) -> bool {
        if operation.managed_process.is_some() {
            return true;
        }
        match (&operation.execution_owner, operation.executor.as_deref()) {
            (Some(ExecutorOwner::External { identity, .. }), Some(name)) => self
                .external_writers
                .contains(&(identity.clone(), name.into())),
            (Some(ExecutorOwner::Kernel), Some("file_write" | "file_edit" | "file_restore")) => include_native_files,
            _ => false,
        }
    }
}
