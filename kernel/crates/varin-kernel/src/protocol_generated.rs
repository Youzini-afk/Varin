// Generated from kernel/protocol/schema.json. Do not hand-edit.
#![allow(dead_code)]

use crate::model::PathState;
use serde::Deserialize;
use serde_json::Value;

pub(crate) const KERNEL_PROTOCOL_VERSION: u64 = 23;
pub(crate) const KERNEL_MAX_FRAME_BYTES: usize = 16777216;
pub(crate) const KERNEL_REQUEST_WINDOW: usize = 2;
pub(crate) const KERNEL_CONTROL_METHODS: &[&str] = &[
    "runtime.inference.session",
    "runtime.inference.receipt_pending",
    "runtime.inference.dispatch",
    "runtime.inference.status",
    "runtime.mcp.interaction.inspect",
    "runtime.mcp.interaction.pending",
    "runtime.mcp.interaction.response.begin",
    "runtime.mcp.interaction.response.settle",
    "runtime.mcp.interaction.close",
    "runtime.mcp.interaction.complete",
    "runtime.mcp.interaction.release_source",
    "runtime.computer.event.cancel",
    "runtime.computer.request.cancel",
    "runtime.computer.request.reconcile",
    "runtime.followup.registrations.pending",
    "runtime.followup.registration.cancel",
    "runtime.operation.status",
    "runtime.child.cancel",
    "runtime.child.capabilities",
    "runtime.source.tools",
    "runtime.tree.cancel",
    "runtime.goal.control",
    "runtime.followup.control",
    "runtime.followup.files",
    "runtime.followup.file.release",
    "runtime.policy.select",
    "runtime.policy.cancel",
    "runtime.policy.fail",
    "runtime.policy.inspect",
    "kernel.handshake",
    "kernel.ping",
    "kernel.shutdown",
    "authority.grant.revoke",
    "authority.grant.retire",
    "runtime.status",
    "runtime.tools.select",
    "runtime.run.inspect",
    "runtime.run.scope",
    "runtime.run.cancel",
    "runtime.run.resume",
    "runtime.operation.inspect",
    "runtime.operation.cancel",
    "runtime.process.access",
    "process.interaction.inspect",
    "runtime.input.cancel",
    "runtime.input.inspect",
    "runtime.admission.inspect",
    "process.inspect",
    "process.kill",
    "process.resize",
    "process.release",
    "process.subscription.ack",
    "process.subscription.unsubscribe",
    "runtime.calendar.occurrence.control",
    "runtime.calendar.calculation.retry",
];
pub(crate) const KERNEL_CONTROL_RESPONSE_METHODS: &[&str] = &[
    "runtime.inference.session",
    "runtime.inference.generate",
    "runtime.inference.receipt_pending",
    "runtime.inference.admit",
    "runtime.inference.dispatch",
    "runtime.inference.status",
    "runtime.inference.settle",
    "runtime.mcp.interaction.inspect",
    "runtime.mcp.interaction.pending",
    "runtime.mcp.interaction.response.begin",
    "runtime.mcp.interaction.response.settle",
    "runtime.mcp.interaction.close",
    "runtime.mcp.interaction.complete",
    "runtime.mcp.interaction.release_source",
    "runtime.computer.event.cancel",
    "runtime.computer.request.cancel",
    "runtime.computer.request.reconcile",
    "runtime.followup.registrations.pending",
    "runtime.followup.registration.cancel",
    "runtime.operation.status",
    "runtime.child.cancel",
    "runtime.child.capabilities",
    "runtime.source.tools",
    "runtime.tree.cancel",
    "runtime.goal.control",
    "runtime.followup.control",
    "runtime.followup.files",
    "runtime.followup.file.release",
    "runtime.policy.select",
    "runtime.policy.cancel",
    "runtime.policy.fail",
    "runtime.policy.inspect",
    "kernel.handshake",
    "kernel.ping",
    "kernel.shutdown",
    "authority.grant.revoke",
    "authority.grant.retire",
    "runtime.status",
    "runtime.tools.select",
    "runtime.run.scope",
    "runtime.run.cancel",
    "runtime.run.resume",
    "runtime.operation.cancel",
    "runtime.process.access",
    "process.interaction.inspect",
    "process.kill",
    "process.resize",
    "process.release",
    "process.subscription.ack",
    "process.subscription.unsubscribe",
    "runtime.calendar.occurrence.control",
    "runtime.calendar.calculation.retry",
];
pub(crate) const KERNEL_DEFERRED_RESPONSE_METHODS: &[&str] =
    &["process.write", "process.resize", "runtime.tools.invoke"];
pub(crate) const KERNEL_INPUT_ORDER_PARAMS: &[(&str, &str)] = &[
    ("runtime.thread.create", "branchId"),
    ("runtime.branch.fork", "branchId"),
    ("runtime.input.submit", "branchId"),
    ("runtime.input.enqueue", "branchId"),
    ("runtime.input.edit", "inputId"),
];
pub(crate) const KERNEL_RUNTIME_DATA_METHODS: &[&str] = &[
    "runtime.memory_work.admit",
    "runtime.memory_work.read",
    "runtime.memory_work.status",
    "runtime.memory_work.list",
    "runtime.memory_work.update",
    "runtime.inference.generate",
    "runtime.inference.admit",
    "runtime.inference.settle",
    "runtime.mcp.sampling.review_output",
    "runtime.mcp.sampling.review_request",
    "runtime.mcp.sampling.generate",
    "runtime.mcp.interaction.open",
    "runtime.mcp.interaction.error.open",
    "runtime.mcp.interaction.list",
    "runtime.mcp.interaction.read",
    "runtime.mcp.interaction.respond",
    "runtime.tools.invoke",
    "runtime.history.body",
    "runtime.output.media.read",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub(crate) struct RequiredNullable<T>(pub(crate) Option<T>);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryWorkAdmit {
    pub(crate) key: String,
    pub(crate) scope_id: String,
    pub(crate) mode: varin_runtime::catalog::memory_work::MemoryWorkMode,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) claims: Vec<varin_runtime::catalog::memory_work::MemoryWorkClaim>,
    pub(crate) retry_of: RequiredNullable<String>,
    pub(crate) recipe: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryWorkReadParams {
    pub(crate) work_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryWorkListParams {
    pub(crate) scope_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemoryWorkUpdate {
    pub(crate) work_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) expected_revision: i64,
    pub(crate) action: varin_runtime::catalog::memory_work::MemoryWorkAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InferenceReceiptPendingParams {
    pub(crate) operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) request_started: RequiredNullable<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InferenceAdmitParams {
    pub(crate) parent_operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) ordinal: i64,
    pub(crate) binding: varin_runtime::catalog::inference::InferenceBinding,
    pub(crate) request: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InferenceGenerateParams {
    pub(crate) parent_operation_id: String,
    pub(crate) caller_owner: varin_runtime::ExecutorOwner,
    pub(crate) ordinal: i64,
    pub(crate) configuration: ModelSessionConfiguration,
    pub(crate) credential_scope: CredentialScope,
    pub(crate) purpose: String,
    pub(crate) system_prompt: String,
    pub(crate) user: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InferenceSessionParams {
    pub(crate) parent_operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InferenceOwnerParams {
    pub(crate) operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InferenceSettleParams {
    pub(crate) operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) receipt: varin_runtime::catalog::inference::InferenceReceipt,
    pub(crate) response: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionReadParams {
    pub(crate) operation_id: String,
    pub(crate) interaction_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSamplingOutputReviewParams {
    pub(crate) operation_id: String,
    pub(crate) interaction_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) action: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSamplingRequestReviewParams {
    pub(crate) operation_id: String,
    pub(crate) interaction_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) action: String,
    pub(crate) edited_request: Option<std::collections::BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSamplingGenerateParams {
    pub(crate) operation_id: String,
    pub(crate) interaction_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) edited_request: std::collections::BTreeMap<String, Value>,
    pub(crate) configuration: ModelSessionConfiguration,
    pub(crate) credential_scope: Option<CredentialScope>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionOpenParams {
    pub(crate) id: String,
    pub(crate) binding: varin_runtime::catalog::mcp_interactions::McpInteractionBinding,
    pub(crate) mode: varin_runtime::McpInteractionMode,
    pub(crate) request: std::collections::BTreeMap<String, Value>,
    pub(crate) presentation: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionErrorOpenParams {
    pub(crate) items: Vec<McpInteractionErrorItem>,
    pub(crate) request: std::collections::BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionListParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionRespondParams {
    pub(crate) operation_id: String,
    pub(crate) interaction_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) response: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelEmptyParams {}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionControlParams {
    pub(crate) binding: varin_runtime::catalog::mcp_interactions::McpInteractionBinding,
    pub(crate) interaction_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionSettleParams {
    pub(crate) binding: varin_runtime::catalog::mcp_interactions::McpInteractionBinding,
    pub(crate) interaction_id: String,
    pub(crate) delivery: varin_runtime::McpInteractionDelivery,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionCloseParams {
    pub(crate) binding: varin_runtime::catalog::mcp_interactions::McpInteractionBinding,
    pub(crate) interaction_id: String,
    pub(crate) availability: varin_runtime::McpInteractionAvailability,
    pub(crate) problem: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunParams {
    pub(crate) run_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedProcessTerminalParams {
    pub(crate) operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) tool_binding: Value,
    pub(crate) callbacks_stopped: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedProcessCellParams {
    pub(crate) operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) environment_id: String,
    pub(crate) closing: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedProcessAcceptParams {
    pub(crate) operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) tool_binding: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedProcessBeginParams {
    pub(crate) operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
    pub(crate) node: varin_runtime::catalog::managed_process::NodeBinding,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerEventCommand {
    pub(crate) fact: varin_runtime::catalog::computer_events::ComputerEventFact,
    pub(crate) label: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerEventCancellation {
    pub(crate) id: String,
    pub(crate) execution: varin_runtime::catalog::computer_requests::ComputerExecution,
    pub(crate) desktop_id: String,
    pub(crate) pending_event_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerRequestCreateParams {
    pub(crate) operation_id: String,
    pub(crate) desktop_id: String,
    pub(crate) access: varin_runtime::catalog::computer_requests::ComputerAccess,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerRequestListParams {
    pub(crate) root_thread_id: Option<String>,
    pub(crate) root_branch_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerDecisionBeginParams {
    pub(crate) request_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) actor: varin_runtime::catalog::computer_requests::ComputerDecisionActor,
    pub(crate) approved: bool,
    pub(crate) host_epoch: String,
    pub(crate) assignment_id: String,
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerDecisionSettleParams {
    pub(crate) request_id: String,
    pub(crate) claim: varin_runtime::catalog::computer_requests::ComputerDecisionClaim,
    pub(crate) status: varin_runtime::catalog::computer_requests::ComputerRequestStatus,
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerRequestCancelParams {
    pub(crate) target: varin_runtime::catalog::computer_requests::ComputerRequestCancelTarget,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerRequestReconcileParams {
    pub(crate) host_epoch: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerRequestWaitParams {
    pub(crate) operation_id: String,
    pub(crate) request_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NestedToolInspectParams {
    pub(crate) parent_operation_id: String,
    pub(crate) executor_owner: varin_runtime::ExecutorOwner,
    pub(crate) name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NestedToolInvokeParams {
    pub(crate) parent_operation_id: String,
    pub(crate) executor_owner: varin_runtime::ExecutorOwner,
    pub(crate) call: varin_runtime::execution::NestedToolInput,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ComputerScopeParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) operation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResearchScopeParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) source_run_id: Option<String>,
    pub(crate) operation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostJobBeginParams {
    pub(crate) binding: varin_runtime::catalog::host_jobs::HostJobBinding,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostJobUserParams {
    pub(crate) subject_id: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) source_run_id: String,
    pub(crate) key: String,
    pub(crate) domain: String,
    pub(crate) domain_version: i64,
    pub(crate) request: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostJobAcceptParams {
    pub(crate) binding: varin_runtime::catalog::host_jobs::HostJobBinding,
    pub(crate) content: varin_runtime::output::OutputBody<varin_runtime::output::IncomingMedia>,
    pub(crate) task: Option<varin_runtime::catalog::host_jobs::McpTaskState>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostJobTerminalParams {
    pub(crate) binding: varin_runtime::catalog::host_jobs::HostJobBinding,
    pub(crate) outcome: varin_runtime::Outcome,
    pub(crate) effect: varin_runtime::Effect,
    pub(crate) content: varin_runtime::output::OutputBody<varin_runtime::output::IncomingMedia>,
    pub(crate) executor_stopped: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostJobObserveParams {
    pub(crate) operation_id: String,
    pub(crate) target_operation_id: String,
    pub(crate) mode: Option<varin_runtime::HostJobWaitMode>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarSyncParams {
    pub(crate) project_id: String,
    pub(crate) expected_revision: RequiredNullable<i64>,
    pub(crate) definitions: Vec<varin_runtime::catalog::calendar::DefinitionInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarProjectParams {
    pub(crate) project_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarDefinitionParams {
    pub(crate) definition_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarRunParams {
    pub(crate) definition_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarOccurrenceParams {
    pub(crate) occurrence_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarOccurrenceControlParams {
    pub(crate) occurrence_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) action: varin_runtime::catalog::calendar::OccurrenceControlAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarCalculatedParams {
    pub(crate) calculation: varin_runtime::catalog::calendar::Calculation,
    pub(crate) result: RequiredNullable<varin_runtime::catalog::calendar::CalculationResult>,
    pub(crate) failure_code: RequiredNullable<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarAdmitParams {
    pub(crate) occurrence_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) owner_epoch: i64,
    pub(crate) configuration: Value,
    pub(crate) launch: SubmitLaunch,
    pub(crate) initial_context: InitialContext,
    pub(crate) input_preparation:
        Option<varin_runtime::catalog::resources::InputResourcePreparation>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarPreparationFailedParams {
    pub(crate) occurrence_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) owner_epoch: i64,
    pub(crate) failure_code: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CalendarCalculationRetryParams {
    pub(crate) definition_id: String,
    pub(crate) expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GoalStartParams {
    pub(crate) key: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) run_id: String,
    pub(crate) objective: String,
    pub(crate) budget: RequiredNullable<varin_runtime::catalog::goals::GoalBudget>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GoalUpdateParams {
    pub(crate) goal_id: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) objective: String,
    pub(crate) budget: RequiredNullable<varin_runtime::catalog::goals::GoalBudget>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GoalControlParams {
    pub(crate) goal_id: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) action: varin_runtime::catalog::goals::GoalControlAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadParams {
    pub(crate) thread_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceRefreshParams {
    pub(crate) branch_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) context: InitialContext,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceSnapshotParams {
    pub(crate) activation_id: Option<String>,
    pub(crate) run_id: String,
    pub(crate) origin: varin_runtime::execution::ToolOrigin,
    pub(crate) call_id: String,
    pub(crate) resource_checkpoint_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupPendingParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) after: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupRegistrationCancelParams {
    pub(crate) key: String,
    pub(crate) run_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupRegisterAdmissionParams {
    pub(crate) repeat: Option<varin_runtime::catalog::followups::FollowupRepeat>,
    pub(crate) key: String,
    pub(crate) run_id: String,
    pub(crate) trigger: varin_runtime::catalog::followups::FollowupRegistrationTrigger,
    pub(crate) instruction: String,
    pub(crate) file_authority: Option<FollowupFileAuthority>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupFilesParams {
    pub(crate) after: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupMetricWorksParams {
    pub(crate) after: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupMetricObserveParams {
    pub(crate) key: varin_runtime::catalog::followups::FollowupResearchKey,
    pub(crate) expected: varin_runtime::catalog::followups::FollowupMetricState,
    pub(crate) snapshot: varin_runtime::catalog::followups::FollowupMetricSnapshot,
    pub(crate) gap: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupResearchWorksParams {
    pub(crate) after: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupResearchObserveParams {
    pub(crate) key: varin_runtime::catalog::followups::FollowupResearchKey,
    pub(crate) evidence: varin_runtime::catalog::followups::FollowupLeafEvidence,
    pub(crate) content: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupLogObserveParams {
    pub(crate) key: varin_runtime::catalog::followups::FollowupResearchKey,
    pub(crate) binding: varin_runtime::catalog::host_jobs::HostJobBinding,
    pub(crate) expected: varin_runtime::catalog::followups::FollowupLogState,
    pub(crate) next: varin_runtime::catalog::followups::FollowupLogState,
    pub(crate) evidence: RequiredNullable<varin_runtime::catalog::followups::FollowupLogEvidence>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupFileObserveParams {
    pub(crate) followup_id: String,
    pub(crate) generation: i64,
    pub(crate) source_index: i64,
    pub(crate) receipt_id: String,
    pub(crate) observation_revision: i64,
    pub(crate) reopen: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupFileReleaseParams {
    pub(crate) followup_id: String,
    pub(crate) generation: i64,
    pub(crate) source_index: i64,
    pub(crate) receipt_id: String,
    pub(crate) observation_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupGetParams {
    pub(crate) followup_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupOccurrencesParams {
    pub(crate) followup_id: String,
    pub(crate) after: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupOccurrenceGetParams {
    pub(crate) followup_id: String,
    pub(crate) occurrence_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupControlParams {
    pub(crate) followup_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) action: varin_runtime::FollowupControlAction,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BranchForkParams {
    pub(crate) source_branch_id: String,
    pub(crate) branch_id: String,
    pub(crate) head_id: RequiredNullable<String>,
    pub(crate) plan_capture: Option<PlanForkCaptureParams>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanViewParams {
    pub(crate) branch_id: String,
    pub(crate) head_id: RequiredNullable<String>,
    pub(crate) current: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanContainsParams {
    pub(crate) branch_id: String,
    pub(crate) head_id: RequiredNullable<String>,
    pub(crate) candidate_head_id: RequiredNullable<String>,
    pub(crate) cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextJobCreateParams {
    pub(crate) summary_recipe: varin_runtime::context_job::ContextSummaryRecipe,
    pub(crate) owner_run_id: Option<String>,
    pub(crate) personalization: Option<ContextPersonalization>,
    pub(crate) key: String,
    pub(crate) branch_id: String,
    pub(crate) through_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) effective_system_prompt: String,
    pub(crate) instruction_sources: Vec<String>,
    pub(crate) memory_checkpoint: RequiredNullable<String>,
    pub(crate) configuration: Value,
    pub(crate) credential_scope: Option<CredentialScope>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryParams {
    pub(crate) branch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextRefreshParams {
    pub(crate) branch_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) context: InitialContext,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryPageParams {
    pub(crate) branch_id: String,
    pub(crate) head_id: Option<String>,
    pub(crate) before_id: Option<String>,
    pub(crate) limit: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryBodyParams {
    pub(crate) item_id: String,
    pub(crate) chunk_index: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaReadParams {}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadOperationsParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostToolReconcileParams {
    pub(crate) operation_id: String,
    pub(crate) execution_owner: varin_runtime::ExecutorOwner,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunReconcileParams {
    pub(crate) run_id: String,
    pub(crate) tool_binding: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchFailedParams {
    pub(crate) run_id: String,
    pub(crate) code: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputEnqueueParams {
    pub(crate) input_preparation:
        Option<varin_runtime::catalog::resources::InputResourcePreparation>,
    pub(crate) key: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) mode: varin_runtime::InputMode,
    pub(crate) input: Value,
    pub(crate) configuration: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputEditParams {
    pub(crate) input_preparation:
        Option<varin_runtime::catalog::resources::InputResourcePreparation>,
    pub(crate) input_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) content: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputCancelParams {
    pub(crate) input_id: String,
    pub(crate) expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputHandleParams {
    pub(crate) input_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchSelectParams {
    pub(crate) run_id: String,
    pub(crate) source: RequiredNullable<LaunchSourceParams>,
    pub(crate) enabled_tools: Vec<String>,
    pub(crate) credential_scope: Option<CredentialScope>,
    pub(crate) child_dispatch: Option<varin_runtime::catalog::dispatch::ChildDispatchCatalog>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpPrepareParams {
    pub(crate) run_id: String,
    pub(crate) binding: McpBinding,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExtensionPrepareParams {
    pub(crate) run_id: String,
    pub(crate) bindings: Vec<ExtensionToolBinding>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolSelectParams {
    pub(crate) run_id: String,
    pub(crate) selection_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ToolReadyParams {
    pub(crate) extension_bindings: Option<Vec<LiveExtensionToolBinding>>,
    pub(crate) run_id: String,
    pub(crate) selection_id: String,
    pub(crate) binding: Option<LiveMcpBinding>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PolicyPrepareParams {
    pub(crate) run_id: String,
    pub(crate) identity: LaunchPolicy,
    pub(crate) target: varin_runtime::catalog::policy_switch::PolicyTarget,
    pub(crate) policy_models: Vec<varin_runtime::execution::PolicyModelCapability>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PolicySelectParams {
    pub(crate) expected_selection_id: RequiredNullable<String>,
    pub(crate) run_id: String,
    pub(crate) selection_id: String,
    pub(crate) expected_generation: i64,
    pub(crate) target: varin_runtime::catalog::policy_switch::PolicyTarget,
    pub(crate) state_mode: varin_runtime::catalog::policy_switch::PolicyStateMode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PolicyReadyParams {
    pub(crate) run_id: String,
    pub(crate) selection_id: String,
    pub(crate) generation: i64,
    pub(crate) binding: RequiredNullable<AgentPolicyBinding>,
    pub(crate) policy_models: Vec<varin_runtime::execution::PolicyModelCapability>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PolicyCancelParams {
    pub(crate) run_id: String,
    pub(crate) selection_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PolicyFailParams {
    pub(crate) run_id: String,
    pub(crate) selection_id: String,
    pub(crate) code: varin_runtime::catalog::policy_switch::PolicyPreparationFailure,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunStartParams {
    pub(crate) extension_bindings: Option<Vec<LiveExtensionToolBinding>>,
    pub(crate) policy_binding: Option<AgentPolicyBinding>,
    pub(crate) mcp_binding: Option<LiveMcpBinding>,
    pub(crate) run_id: String,
    pub(crate) tool_binding: Option<Value>,
    pub(crate) credential_scope: Option<CredentialScope>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelSelectParams {
    pub(crate) run_id: String,
    pub(crate) key: String,
    pub(crate) configuration: Value,
    pub(crate) credential_scope: Option<CredentialScope>,
    pub(crate) child_dispatch: Option<varin_runtime::catalog::dispatch::ChildDispatchCatalog>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdmissionInspectParams {
    pub(crate) parent_operation_id: Option<String>,
    pub(crate) run_id: String,
    pub(crate) owner_generation: i64,
    pub(crate) call_id: String,
    pub(crate) request_id: Option<String>,
    pub(crate) action_id: Option<String>,
    pub(crate) node_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ThreadCreateParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputSubmitParams {
    pub(crate) input_preparation:
        Option<varin_runtime::catalog::resources::InputResourcePreparation>,
    pub(crate) expected_context_checkpoint: Option<String>,
    pub(crate) initial_context: Option<InitialContext>,
    pub(crate) launch: Option<SubmitLaunch>,
    pub(crate) key: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_head: RequiredNullable<String>,
    pub(crate) input: Value,
    pub(crate) configuration: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunResumeParams {
    pub(crate) run_id: String,
    pub(crate) wait_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PermissionOpenParams {
    pub(crate) operation_id: String,
    pub(crate) permission_id: String,
    pub(crate) call: HostToolCall,
    pub(crate) scope: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PermissionDecideParams {
    pub(crate) operation_id: String,
    pub(crate) permission_id: String,
    pub(crate) decision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QuestionAnswerParams {
    pub(crate) operation_id: String,
    pub(crate) answer: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationInspectParams {
    pub(crate) operation_id: String,
    pub(crate) allow_missing: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationParams {
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeProcessAccessParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) operation_id: String,
    pub(crate) tool_binding: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EventsParams {
    pub(crate) cursor: i64,
    pub(crate) limit: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ObserverReadParams {
    pub(crate) observer_id: String,
    pub(crate) thread_id: String,
    pub(crate) limit: i64,
    pub(crate) through_cursor: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ObserverDeliveryParams {
    pub(crate) observer_id: String,
    pub(crate) thread_id: String,
    pub(crate) cursor: i64,
    pub(crate) state: varin_runtime::DeliveryState,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessSubscribeParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) root_id: Option<String>,
    pub(crate) subscription_id: String,
    pub(crate) cursor: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessSubscriptionAckParams {
    pub(crate) subscription_id: String,
    pub(crate) stream: String,
    pub(crate) sequence: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessSubscriptionParams {
    pub(crate) subscription_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessSpawnParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) root_id: String,
    pub(crate) cwd: String,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) windows_raw_arguments: Option<String>,
    pub(crate) env: Vec<KernelProcessEnvironmentEntry>,
    pub(crate) mode: String,
    pub(crate) cols: Option<i64>,
    pub(crate) rows: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessReadParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) root_id: Option<String>,
    pub(crate) cursor: i64,
    pub(crate) max_bytes: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessWriteParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) root_id: Option<String>,
    pub(crate) operation_id: String,
    pub(crate) bytes_base64: String,
    pub(crate) eof: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessResizeParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) root_id: Option<String>,
    pub(crate) operation_id: String,
    pub(crate) cols: i64,
    pub(crate) rows: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessInteractionInspectParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) operation_id: String,
    pub(crate) root_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessKillParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) root_id: Option<String>,
    pub(crate) force: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessHandleParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) root_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessListParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelHandshakeParams {
    pub(crate) protocol_version: i64,
    pub(crate) build_version: String,
    pub(crate) host_id: String,
    pub(crate) host_generation: String,
    pub(crate) storage_root: String,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelHealthParams {
    pub(crate) deep: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelSourceHandoffClaimParams {
    pub(crate) handoff_operation_id: String,
    pub(crate) grant_id: String,
    pub(crate) child_thread_id: String,
    pub(crate) child_branch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGrantIssueParams {
    pub(crate) grant_id: String,
    pub(crate) host_generation: String,
    pub(crate) authority_instance_id: Option<RequiredNullable<String>>,
    pub(crate) worker_id: Option<RequiredNullable<String>>,
    pub(crate) worker_generation: Option<RequiredNullable<i64>>,
    pub(crate) session_id: RequiredNullable<String>,
    pub(crate) thread_id: RequiredNullable<String>,
    pub(crate) run_id: RequiredNullable<String>,
    pub(crate) operation_id: Option<RequiredNullable<String>>,
    pub(crate) owning_workspace: RequiredNullable<String>,
    pub(crate) execution_workspace: RequiredNullable<String>,
    pub(crate) storage_identity: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) path_scopes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGrantTargetParams {
    pub(crate) grant_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGrantRetireParams {
    pub(crate) target: crate::model::GrantRetireTarget,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelSnapshotParams {
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobBeginParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) byte_length: i64,
    pub(crate) expected_hash: Option<String>,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobChunkParams {
    pub(crate) stream_id: String,
    pub(crate) sequence: i64,
    pub(crate) bytes_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobFinishParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) expected_hash: Option<String>,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobAbortParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBlobReleaseParams {
    pub(crate) owner_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGetBlobParams {
    pub(crate) hash: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) revision: Option<i64>,
    pub(crate) pin_id: Option<String>,
    pub(crate) owner_id: Option<String>,
    pub(crate) record_id: Option<String>,
    pub(crate) slot: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) offset: Option<i64>,
    pub(crate) length: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelObjectOwnerRebindParams {
    pub(crate) workspace_id: String,
    pub(crate) owner_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileReadCheckParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileRootRegisterParams {
    pub(crate) workspace_id: String,
    pub(crate) execution_workspace_id: String,
    pub(crate) canonical_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileOperationListParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileOperationReconcileParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileLeaseAcquireParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) lease_id: String,
    pub(crate) resources: Vec<KernelFileLeaseResource>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileLeaseReleaseParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) lease_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileCaptureParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) store: bool,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileCaptureBatchParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) paths: Vec<String>,
    pub(crate) store: bool,
    pub(crate) lease_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileApplyParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) target_json: String,
    pub(crate) expected_json: Option<String>,
    pub(crate) owner_id: Option<String>,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileMkdirParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) recursive: bool,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileRemoveParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) recursive: bool,
    pub(crate) force: bool,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileRenameParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) from_path: String,
    pub(crate) to_path: String,
    pub(crate) target_must_be_missing: Option<bool>,
    pub(crate) expected_from_json: Option<String>,
    pub(crate) expected_to_json: Option<String>,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileScanParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) scopes: Option<Vec<String>>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
    pub(crate) expected_fingerprint: Option<String>,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileMeasureParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileMaterializeParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) source_root: String,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelMaterializedViewPrepareParams {
    pub(crate) workspace_id: String,
    pub(crate) execution_workspace_id: String,
    pub(crate) branch_id: String,
    pub(crate) revision: i64,
    pub(crate) view_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelMaterializedViewParams {
    pub(crate) workspace_id: String,
    pub(crate) view_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_type: String,
    pub(crate) state: String,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) revision: Option<i64>,
    pub(crate) result_revision: Option<i64>,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) payload_json: String,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordListParams {
    pub(crate) workspace_id: String,
    pub(crate) record_type: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelExperimentArtifactsParams {
    pub(crate) workspace_id: String,
    pub(crate) attempt_id: String,
    pub(crate) after: Option<String>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelExperimentLogChunksParams {
    pub(crate) workspace_id: String,
    pub(crate) attempt_id: String,
    pub(crate) stream: varin_runtime::catalog::followups::LogStream,
    pub(crate) offset: i64,
    pub(crate) end_offset: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordWorkspacesParams {
    pub(crate) record_type: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultPrepareParams {
    pub(crate) operation_id: String,
    pub(crate) publication_id: String,
    pub(crate) builder_id: String,
    pub(crate) expected_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultPublishParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) branch_id: String,
    pub(crate) candidate_operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultCandidateReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) branch_id: String,
    pub(crate) candidate_operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) parent_ref: Option<String>,
    pub(crate) changed_paths: Vec<String>,
    pub(crate) diff_stats: KernelWorkingDiffStats,
    pub(crate) created_at: String,
    pub(crate) document: KernelWorkingResultDocument,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultListParams {
    pub(crate) workspace_id: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) document: KernelWorkingDraftDocument,
    pub(crate) branch_id: String,
    pub(crate) revision: i64,
    pub(crate) root: String,
    pub(crate) created_at: String,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftListParams {
    pub(crate) workspace_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) kind: String,
    pub(crate) thread_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) document: KernelWorkingVerificationDocument,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationListParams {
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
    pub(crate) kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) document: KernelWorkingReviewDocument,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewListParams {
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchBeginParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
    pub(crate) branch_id: String,
    pub(crate) workspace_id: String,
    pub(crate) base_ref: Option<String>,
    pub(crate) parent_ref: Option<String>,
    pub(crate) draft_base_paths: Vec<String>,
    pub(crate) capture_scopes: Vec<String>,
    pub(crate) source_provenance: Option<KernelSourceProvenanceReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchAppendParams {
    pub(crate) builder_id: String,
    pub(crate) sequence: i64,
    pub(crate) entries: Vec<KernelCreateEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchFinishParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchAbortParams {
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchReadParams {
    pub(crate) branch_id: String,
    pub(crate) revision: Option<i64>,
    pub(crate) paths: Option<Vec<String>>,
    pub(crate) roots: Option<Vec<String>>,
    pub(crate) include_entries: Option<bool>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteBeginParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_write_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteAppendParams {
    pub(crate) builder_id: String,
    pub(crate) sequence: i64,
    pub(crate) changes: Vec<KernelBranchChange>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteFinishParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
    pub(crate) base_ref: Option<String>,
    pub(crate) parent_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteAbortParams {
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchPublishParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_write_revision: i64,
    pub(crate) expected_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchPinParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) revision: Option<i64>,
    pub(crate) expected_write_revision: Option<i64>,
    pub(crate) expected_root: Option<String>,
    pub(crate) pin_id: Option<String>,
    pub(crate) persistent: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchUnpinParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) pin_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchDiffParams {
    pub(crate) left_root: String,
    pub(crate) right_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchObjectsParams {
    pub(crate) branch_id: String,
    pub(crate) include_revisions: Option<bool>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchDeleteParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPinReadParams {
    pub(crate) pin_id: String,
    pub(crate) paths: Option<Vec<String>>,
    pub(crate) roots: Option<Vec<String>>,
    pub(crate) include_entries: Option<bool>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationGetParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnStartParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) session_id: String,
    pub(crate) user_entry_id: String,
    pub(crate) worker_id: String,
    pub(crate) runtime_generation: i64,
    pub(crate) active_writer_scopes: Vec<String>,
    pub(crate) provenance: String,
    pub(crate) failure: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnGetParams {
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnSettleParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) status: String,
    pub(crate) observed_resource_ids: Vec<String>,
    pub(crate) unrecorded_resource_ids: Vec<String>,
    pub(crate) observation_complete: bool,
    pub(crate) active_writer_scopes: Vec<String>,
    pub(crate) provenance: String,
    pub(crate) assistant_entry_id: Option<String>,
    pub(crate) failure_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryCheckpointCreateParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) label: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryCheckpointListParams {
    pub(crate) workspace_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryEntryResolveParams {
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) entry_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeBeforeParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) execution_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
    pub(crate) tool_name: String,
    pub(crate) mutation_id: String,
    pub(crate) before_json: String,
    pub(crate) references: Vec<KernelRecoveryReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeGetParams {
    pub(crate) workspace_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeListParams {
    pub(crate) workspace_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) execution_id: Option<String>,
    pub(crate) entry_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeAfterParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) execution_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
    pub(crate) after_json: String,
    pub(crate) succeeded: bool,
    pub(crate) expected_revision: i64,
    pub(crate) references: Vec<KernelRecoveryReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationCreateParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) kind: String,
    pub(crate) state: String,
    pub(crate) data_json: String,
    pub(crate) files: Vec<KernelRecoveryOperationFile>,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationFileCasParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) path: String,
    pub(crate) expected_revision: i64,
    pub(crate) expected_phase: String,
    pub(crate) phase: String,
    pub(crate) observed_fingerprint: Option<String>,
    pub(crate) expected_json: Option<String>,
    pub(crate) target_json: Option<String>,
    pub(crate) safety_json: Option<String>,
    pub(crate) references: Option<Vec<KernelRecoveryReference>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationCompleteParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) state: String,
    pub(crate) result_json: Option<String>,
    pub(crate) failure_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationConflictsParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) paths: Vec<String>,
    pub(crate) except_operation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationListParams {
    pub(crate) workspace_id: String,
    pub(crate) kind: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationReleaseParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelOperationGetParams {
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelOperationReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGcParams {
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeStartParams {
    pub(crate) workspace_id: String,
    pub(crate) job_id: String,
    pub(crate) lane: String,
    pub(crate) operation: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) revision: Option<i64>,
    pub(crate) pin_id: Option<String>,
    pub(crate) root_id: Option<String>,
    pub(crate) objects: Option<Vec<KernelComputeObject>>,
    pub(crate) paths: Option<Vec<String>>,
    pub(crate) globs: Option<Vec<String>>,
    pub(crate) exclude_paths: Option<Vec<String>>,
    pub(crate) exclude_directories: Option<Vec<String>>,
    pub(crate) respect_gitignore: Option<bool>,
    pub(crate) include_hidden: Option<bool>,
    pub(crate) query: Option<String>,
    pub(crate) ignore_case: Option<bool>,
    pub(crate) fixed_strings: Option<bool>,
    pub(crate) max_results: Option<i64>,
    pub(crate) before: Option<i64>,
    pub(crate) after: Option<i64>,
    pub(crate) start_line: Option<i64>,
    pub(crate) end_line: Option<i64>,
    pub(crate) byte_offset: Option<i64>,
    pub(crate) byte_length: Option<i64>,
    pub(crate) immediate: Option<bool>,
    pub(crate) files: Option<Vec<KernelComputeFile>>,
    pub(crate) parse_budget_ms: Option<i64>,
    pub(crate) chunk_lines: Option<i64>,
    pub(crate) include_text: Option<bool>,
    pub(crate) include_tracked: Option<bool>,
    pub(crate) include_revisions: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeReadParams {
    pub(crate) workspace_id: String,
    pub(crate) job_id: String,
    pub(crate) cursor: i64,
    pub(crate) max_bytes: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeHandleParams {
    pub(crate) workspace_id: String,
    pub(crate) job_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeGrammarParams {
    pub(crate) recipe_id: String,
    pub(crate) grammar_path: String,
    pub(crate) grammar_name: String,
    pub(crate) style: String,
    pub(crate) definition_query: String,
    pub(crate) import_query: Option<String>,
    pub(crate) literal_call_query: Option<String>,
    pub(crate) max_depth: Option<i64>,
    pub(crate) max_symbols: Option<i64>,
    pub(crate) grammar_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildContinuationAcceptParams {
    pub(crate) key: String,
    pub(crate) child_operation_id: String,
    pub(crate) previous_run_id: String,
    pub(crate) expected_head: RequiredNullable<String>,
    pub(crate) input: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildExecutionParams {
    pub(crate) execution_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildExecutionListParams {
    pub(crate) child_operation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildExecutionReportReadParams {
    pub(crate) execution_id: String,
    pub(crate) item_id: String,
    pub(crate) offset: Option<i64>,
    pub(crate) max_bytes: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildReportReadParams {
    pub(crate) operation_id: String,
    pub(crate) item_id: String,
    pub(crate) offset: Option<i64>,
    pub(crate) max_bytes: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildSourceReadyParams {
    pub(crate) execution_id: String,
    pub(crate) pin: varin_runtime::catalog::collaboration::ChildSourcePin,
    pub(crate) source: LaunchSourceParams,
    pub(crate) provenance: varin_runtime::catalog::collaboration::ChildSourceProvenance,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildSettleParams {
    pub(crate) execution_id: String,
    pub(crate) tool_binding: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildResultCandidateParams {
    pub(crate) execution_id: String,
    pub(crate) tool_binding: Value,
    pub(crate) candidate_operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildResultPublishedParams {
    pub(crate) execution_id: String,
    pub(crate) tool_binding: Value,
    pub(crate) publication_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildPrepareParams {
    pub(crate) execution_id: String,
    pub(crate) source: RequiredNullable<LaunchSourceParams>,
    pub(crate) context: InitialContext,
    pub(crate) expected_context_checkpoint: RequiredNullable<String>,
    pub(crate) input_preparation:
        Option<varin_runtime::catalog::resources::InputResourcePreparation>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildFailParams {
    pub(crate) execution_id: String,
    pub(crate) code: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TreeCancelParams {
    pub(crate) target: varin_runtime::catalog::dispatch::TreeCancelTarget,
    pub(crate) expected_parent_thread_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceToolsParams {
    pub(crate) mode: varin_runtime::SourceMode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChildWaitParams {
    pub(crate) wait_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FamilyListParams {
    pub(crate) caller_thread_id: String,
    pub(crate) include_self: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FamilyRunsParams {
    pub(crate) caller_thread_id: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FamilyReadParams {
    pub(crate) caller_thread_id: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) anchor: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) query: varin_runtime::catalog::family::FamilyReadQuery,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FamilyItemParams {
    pub(crate) caller_thread_id: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) anchor: String,
    pub(crate) item_id: String,
    pub(crate) offset: Option<i64>,
    pub(crate) max_bytes: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MessageSendParams {
    pub(crate) key: String,
    pub(crate) sender_thread_id: String,
    pub(crate) sender_branch_id: String,
    pub(crate) target_thread_id: Option<String>,
    pub(crate) target_branch_id: Option<String>,
    pub(crate) reply_to: Option<String>,
    pub(crate) kind: varin_runtime::MessageKind,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MessageListParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) direction: varin_runtime::catalog::messages::MessageDirection,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MessageGetParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) message_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostJobTaskUpdateParams {
    pub(crate) binding: varin_runtime::catalog::host_jobs::HostJobBinding,
    pub(crate) expected_revision: i64,
    pub(crate) task: varin_runtime::catalog::host_jobs::McpTaskState,
    pub(crate) availability: varin_runtime::McpTaskAvailability,
    pub(crate) content: Value,
    pub(crate) problem: Option<varin_runtime::catalog::host_jobs::McpTaskProblem>,
    pub(crate) result: Option<McpTaskResultInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostJobAccessParams {
    pub(crate) run_id: String,
    pub(crate) target_operation_id: String,
    pub(crate) control: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpResourceBeginParams {
    pub(crate) binding: varin_runtime::catalog::mcp_resources::McpResourceBinding,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpResourceAcceptParams {
    pub(crate) binding: varin_runtime::catalog::mcp_resources::McpResourceBinding,
    pub(crate) listener_id: String,
    pub(crate) content: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpResourceListenerParams {
    pub(crate) binding: varin_runtime::catalog::mcp_resources::McpResourceBinding,
    pub(crate) expected_listener_id: RequiredNullable<String>,
    pub(crate) listener_id: RequiredNullable<String>,
    pub(crate) availability: varin_runtime::McpResourceAvailability,
    pub(crate) local_released: bool,
    pub(crate) remote_cleanup: varin_runtime::McpResourceCleanup,
    pub(crate) problem: RequiredNullable<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpResourceNotifyParams {
    pub(crate) binding: varin_runtime::catalog::mcp_resources::McpResourceBinding,
    pub(crate) listener_id: String,
    pub(crate) fact_id: String,
    pub(crate) kind: varin_runtime::McpResourceFactKind,
    pub(crate) notification: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpResourceAccessParams {
    pub(crate) run_id: String,
    pub(crate) target_operation_id: String,
    pub(crate) control: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostToolErrorMarker {
    pub(crate) code: String,
    pub(crate) admission: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelSessionConfiguration {
    pub(crate) provider_id: Option<String>,
    pub(crate) provider_family: String,
    pub(crate) model: String,
    pub(crate) endpoint: String,
    pub(crate) credential_environment: RequiredNullable<String>,
    pub(crate) allow_anonymous: bool,
    pub(crate) accepts_images: Option<bool>,
    pub(crate) configuration_generation: i64,
    pub(crate) max_output_tokens: RequiredNullable<i64>,
    pub(crate) azure_deployment: Option<RequiredNullable<String>>,
    pub(crate) azure_api_version: Option<RequiredNullable<String>>,
    pub(crate) legacy_max_tokens: Option<bool>,
    pub(crate) include_stream_usage: Option<bool>,
    pub(crate) reasoning_effort: Option<RequiredNullable<String>>,
    pub(crate) anthropic_oauth: Option<bool>,
    pub(crate) adapter_id: Option<String>,
    pub(crate) adapter_version: Option<String>,
    pub(crate) context_window_tokens: Option<i64>,
    pub(crate) thinking_level: Option<String>,
    pub(crate) model_options: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CredentialScope {
    pub(crate) reference: String,
    pub(crate) authority: String,
    pub(crate) account: String,
    pub(crate) generation: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpInteractionErrorItem {
    pub(crate) id: String,
    pub(crate) binding: varin_runtime::catalog::mcp_interactions::McpInteractionBinding,
    pub(crate) presentation: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubmitLaunch {
    pub(crate) inherit_source: Option<bool>,
    pub(crate) source: RequiredNullable<LaunchSourceParams>,
    pub(crate) enabled_tools: Vec<String>,
    pub(crate) credential_scope: Option<CredentialScope>,
    pub(crate) child_dispatch: Option<varin_runtime::catalog::dispatch::ChildDispatchCatalog>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InitialContext {
    pub(crate) resources: Option<varin_runtime::catalog::resources::ContextResources>,
    pub(crate) personalization: Option<ContextPersonalization>,
    pub(crate) effective_system_prompt: String,
    pub(crate) instruction_sources: Vec<String>,
    pub(crate) memory_checkpoint: RequiredNullable<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FollowupFileAuthority {
    pub(crate) grant_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanForkCaptureParams {
    pub(crate) source_thread_id: String,
    pub(crate) source_branch_id: String,
    pub(crate) target_branch_id: String,
    pub(crate) head_id: RequiredNullable<String>,
    pub(crate) inherited_ref: RequiredNullable<String>,
    pub(crate) captured_ref: RequiredNullable<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextPersonalization {
    pub(crate) memory_snapshot: MemorySnapshot,
    pub(crate) configuration_digest: String,
    pub(crate) mode: String,
    pub(crate) thread_role: String,
    pub(crate) context_composition: Option<ContextComposition>,
    pub(crate) revision: i64,
    pub(crate) session_id: String,
    pub(crate) project_id: RequiredNullable<String>,
    pub(crate) original_sections: Vec<SystemSection>,
    pub(crate) instruction_sources: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchSourceParams {
    pub(crate) environment_run_id: Option<String>,
    pub(crate) workspace_id: String,
    pub(crate) execution_workspace_id: String,
    pub(crate) branch_id: RequiredNullable<String>,
    pub(crate) revision: RequiredNullable<i64>,
    pub(crate) mode: varin_runtime::SourceMode,
    pub(crate) live_root: Option<RequiredNullable<LiveRoot>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpBinding {
    pub(crate) routes: std::collections::BTreeMap<String, varin_runtime::McpRoute>,
    pub(crate) provenance: McpProvenance,
    pub(crate) resources: std::collections::BTreeMap<String, String>,
    pub(crate) reference: String,
    pub(crate) generation: i64,
    pub(crate) tools: Vec<LaunchTool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExtensionToolBinding {
    pub(crate) provider_key: String,
    pub(crate) extension_id: String,
    pub(crate) extension_version: String,
    pub(crate) service_id: String,
    pub(crate) service_version: i64,
    pub(crate) artifact_integrity: String,
    pub(crate) composition: varin_runtime::catalog::service_composition::HostServiceComposition,
    pub(crate) declaration_hash: String,
    pub(crate) configuration_identity: RequiredNullable<String>,
    pub(crate) tool: LaunchTool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveExtensionToolBinding {
    pub(crate) owner_id: String,
    pub(crate) generation: i64,
    pub(crate) binding: ExtensionToolBinding,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveMcpBinding {
    pub(crate) owner_id: String,
    pub(crate) binding: McpBinding,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchPolicy {
    pub(crate) name: String,
    pub(crate) version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentPolicyBinding {
    pub(crate) reference: String,
    pub(crate) generation: i64,
    pub(crate) artifact: varin_runtime::catalog::policy_switch::AgentPolicyArtifactBinding,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostToolCall {
    pub(crate) run_id: String,
    pub(crate) operation_id: String,
    pub(crate) origin: varin_runtime::execution::ToolOrigin,
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) schema_version: String,
    pub(crate) arguments: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessEnvironmentEntry {
    pub(crate) name: String,
    pub(crate) value: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileLeaseResource {
    pub(crate) path: String,
    pub(crate) scope: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordReference {
    pub(crate) slot: String,
    pub(crate) object_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDiffStats {
    pub(crate) files: i64,
    pub(crate) insertions: i64,
    pub(crate) deletions: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultDocument {
    pub(crate) result_revision: i64,
    pub(crate) branch_id: String,
    pub(crate) parent_ref: Option<String>,
    pub(crate) changed_paths: Vec<String>,
    pub(crate) diff_stats: KernelWorkingDiffStats,
    pub(crate) created_at: String,
    pub(crate) root: String,
    pub(crate) base_root: String,
    pub(crate) base_states: Value,
    pub(crate) path_states: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftDocument {
    pub(crate) id: String,
    pub(crate) workspace_id: String,
    pub(crate) branch_id: String,
    pub(crate) revision: i64,
    pub(crate) created_at: String,
    pub(crate) root: String,
    pub(crate) provenance: Vec<KernelDraftProvenance>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationDocument {
    pub(crate) result_revision: Option<i64>,
    pub(crate) merged_result_revision: Option<i64>,
    pub(crate) merge_operation_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) result_tree_hash: Option<String>,
    pub(crate) parent_tree_hash: Option<String>,
    pub(crate) recorded_at: i64,
    pub(crate) window_opened_at: Option<i64>,
    pub(crate) draft_unsaved: Option<bool>,
    pub(crate) note: Option<String>,
    pub(crate) binding: String,
    pub(crate) binding_reason: Option<String>,
    pub(crate) checks: Vec<KernelCommandVerificationRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewDocument {
    pub(crate) result_revision: i64,
    pub(crate) status: String,
    pub(crate) recorded_at: i64,
    pub(crate) review_thread_id: Option<String>,
    pub(crate) review_run_id: Option<String>,
    pub(crate) gate: Option<bool>,
    pub(crate) conclusion: Option<String>,
    pub(crate) findings: Option<Vec<KernelReviewFinding>>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelSourceProvenanceReference {
    pub(crate) object_hash: String,
    pub(crate) owner_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateEntry {
    pub(crate) path: String,
    pub(crate) state: PathState,
    pub(crate) owner_id: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) source_record_id: Option<String>,
    pub(crate) source_slot: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchChange {
    pub(crate) path: String,
    pub(crate) state: PathState,
    pub(crate) owner_id: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) source_record_id: Option<String>,
    pub(crate) source_slot: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryReference {
    pub(crate) slot: String,
    pub(crate) object_hash: String,
    pub(crate) owner_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationFile {
    pub(crate) path: String,
    pub(crate) expected_json: Option<String>,
    pub(crate) target_json: Option<String>,
    pub(crate) safety_json: Option<String>,
    pub(crate) phase: Option<String>,
    pub(crate) references: Option<Vec<KernelRecoveryReference>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeObject {
    pub(crate) path: String,
    pub(crate) revision: String,
    pub(crate) object_hash: Option<String>,
    pub(crate) owner_id: Option<String>,
    pub(crate) missing: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeFile {
    pub(crate) path: String,
    pub(crate) recipe_id: Option<String>,
    pub(crate) revision: Option<String>,
    pub(crate) unchanged_revision: Option<String>,
    pub(crate) lines: Option<Vec<i64>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpTaskResultInput {
    pub(crate) outcome: varin_runtime::Outcome,
    pub(crate) effect: varin_runtime::Effect,
    pub(crate) content: varin_runtime::output::OutputBody<varin_runtime::output::IncomingMedia>,
    pub(crate) kind: varin_runtime::McpTaskResultKind,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemorySnapshot {
    pub(crate) revision: i64,
    pub(crate) memories: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextComposition {
    pub(crate) scope_id: String,
    pub(crate) selection_revision: i64,
    pub(crate) transforms: Vec<ContextTransform>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SystemSection {
    pub(crate) name: String,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveRoot {
    pub(crate) host_id: String,
    pub(crate) canonical_root: String,
    pub(crate) root_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpProvenance {
    #[serde(rename = "execution_scope")]
    pub(crate) execution_scope: varin_runtime::catalog::launches::McpExecutionScope,
    pub(crate) configuration: McpConfiguration,
    pub(crate) servers: std::collections::BTreeMap<String, McpServerSelection>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchTool {
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) description: String,
    pub(crate) schema: Value,
    #[serde(rename = "output_schema")]
    pub(crate) output_schema: Value,
    pub(crate) metadata: RequiredNullable<varin_runtime::execution::ToolMetadata>,
    pub(crate) requirements: Option<varin_runtime::execution::ToolRequirements>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelDraftProvenance {
    pub(crate) path: String,
    pub(crate) base_revision: RequiredNullable<String>,
    pub(crate) encoding: String,
    pub(crate) bom: bool,
    pub(crate) local_edit_revision: i64,
    pub(crate) revision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCommandVerificationRecord {
    pub(crate) id: String,
    pub(crate) run_id: String,
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) env_summary: Option<KernelVerificationEnvSummary>,
    pub(crate) command_run_id: Option<String>,
    pub(crate) started_at: i64,
    pub(crate) ended_at: i64,
    pub(crate) exit_code: RequiredNullable<i64>,
    pub(crate) cancelled: bool,
    pub(crate) output_handle: Option<String>,
    pub(crate) output_preview: Option<String>,
    pub(crate) actor: KernelVerificationActor,
    pub(crate) binding_generation: i64,
    pub(crate) input_identity: KernelVerificationInputIdentity,
    pub(crate) input_changed_during_run: RequiredNullable<bool>,
    pub(crate) relation_to_published: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelReviewFinding {
    pub(crate) severity: String,
    pub(crate) file: Option<String>,
    pub(crate) line: Option<i64>,
    pub(crate) message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextTransform {
    pub(crate) provider_id: String,
    pub(crate) content_version: String,
    pub(crate) sections: Vec<ContextFragment>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpConfiguration {
    #[serde(rename = "agent_dir")]
    pub(crate) agent_dir: String,
    #[serde(rename = "config_cwd")]
    pub(crate) config_cwd: String,
    #[serde(rename = "project_trusted")]
    pub(crate) project_trusted: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpServerSelection {
    #[serde(rename = "definition_version")]
    pub(crate) definition_version: String,
    #[serde(rename = "resource_key")]
    pub(crate) resource_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationEnvSummary {
    pub(crate) path: Option<bool>,
    #[serde(rename = "VIRTUAL_ENV")]
    pub(crate) virtual_env: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationActor {
    pub(crate) authority_instance_id: String,
    pub(crate) session_id: String,
    pub(crate) worker_id: String,
    pub(crate) worker_generation: i64,
    pub(crate) run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationInputIdentity {
    pub(crate) kind: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) root: Option<String>,
    pub(crate) start_tree_hash: Option<String>,
    pub(crate) end_tree_hash: Option<String>,
    pub(crate) reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextFragment {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) content: String,
}

pub(crate) fn validate_generated_method_params(method: &str, params: &Value) -> Result<(), String> {
    match method {
        "runtime.memory_work.admit" => serde_json::from_value::<MemoryWorkAdmit>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.memory_work.read" => {
            serde_json::from_value::<MemoryWorkReadParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.memory_work.status" => {
            serde_json::from_value::<MemoryWorkReadParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.memory_work.list" => {
            serde_json::from_value::<MemoryWorkListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.memory_work.update" => serde_json::from_value::<MemoryWorkUpdate>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.inference.receipt_pending" => {
            serde_json::from_value::<InferenceReceiptPendingParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.inference.admit" => serde_json::from_value::<InferenceAdmitParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.inference.generate" => {
            serde_json::from_value::<InferenceGenerateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.inference.session" => {
            serde_json::from_value::<InferenceSessionParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.inference.dispatch" => {
            serde_json::from_value::<InferenceOwnerParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.inference.status" => {
            serde_json::from_value::<InferenceOwnerParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.inference.settle" => {
            serde_json::from_value::<InferenceSettleParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.inspect" => {
            serde_json::from_value::<McpInteractionReadParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.sampling.review_output" => {
            serde_json::from_value::<McpSamplingOutputReviewParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.sampling.review_request" => {
            serde_json::from_value::<McpSamplingRequestReviewParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.sampling.generate" => {
            serde_json::from_value::<McpSamplingGenerateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.open" => {
            serde_json::from_value::<McpInteractionOpenParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.error.open" => {
            serde_json::from_value::<McpInteractionErrorOpenParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.list" => {
            serde_json::from_value::<McpInteractionListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.read" => {
            serde_json::from_value::<McpInteractionReadParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.respond" => {
            serde_json::from_value::<McpInteractionRespondParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.pending" => {
            serde_json::from_value::<KernelEmptyParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.response.begin" => {
            serde_json::from_value::<McpInteractionControlParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.response.settle" => {
            serde_json::from_value::<McpInteractionSettleParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.close" => {
            serde_json::from_value::<McpInteractionCloseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.complete" => {
            serde_json::from_value::<McpInteractionControlParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.interaction.release_source" => {
            serde_json::from_value::<RunParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.managed_process.pending" => {
            serde_json::from_value::<KernelEmptyParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.managed_process.terminal" => {
            serde_json::from_value::<ManagedProcessTerminalParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.managed_process.cell" => {
            serde_json::from_value::<ManagedProcessCellParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.managed_process.accept" => {
            serde_json::from_value::<ManagedProcessAcceptParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.managed_process.begin" => {
            serde_json::from_value::<ManagedProcessBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.event.accept" => {
            serde_json::from_value::<ComputerEventCommand>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.event.cancel" => {
            serde_json::from_value::<ComputerEventCancellation>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.request.create" => {
            serde_json::from_value::<ComputerRequestCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.request.list" => {
            serde_json::from_value::<ComputerRequestListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.decision.begin" => {
            serde_json::from_value::<ComputerDecisionBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.decision.settle" => {
            serde_json::from_value::<ComputerDecisionSettleParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.request.cancel" => {
            serde_json::from_value::<ComputerRequestCancelParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.request.reconcile" => {
            serde_json::from_value::<ComputerRequestReconcileParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.computer.request.wait" => {
            serde_json::from_value::<ComputerRequestWaitParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.tools.inspect" => {
            serde_json::from_value::<NestedToolInspectParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.tools.invoke" => serde_json::from_value::<NestedToolInvokeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.computer.scope" => serde_json::from_value::<ComputerScopeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.research.scopes" => serde_json::from_value::<ResearchScopeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.host_job.begin" => serde_json::from_value::<HostJobBeginParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.host_job.user" => serde_json::from_value::<HostJobUserParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.host_job.accept" => serde_json::from_value::<HostJobAcceptParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.host_job.sources" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.host_job.pending" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.host_job.terminal" => {
            serde_json::from_value::<HostJobTerminalParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.host_job.observe" => {
            serde_json::from_value::<HostJobObserveParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.calendar.projects" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.calendar.sync" => serde_json::from_value::<CalendarSyncParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.calendar.list" => serde_json::from_value::<CalendarProjectParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.calendar.occurrences" => {
            serde_json::from_value::<CalendarDefinitionParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.calendar.run" => serde_json::from_value::<CalendarRunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.calendar.prepare" => {
            serde_json::from_value::<CalendarOccurrenceParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.calendar.occurrence.control" => {
            serde_json::from_value::<CalendarOccurrenceControlParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.calendar.calculated" => {
            serde_json::from_value::<CalendarCalculatedParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.calendar.admit" => serde_json::from_value::<CalendarAdmitParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.calendar.preparation.failed" => {
            serde_json::from_value::<CalendarPreparationFailedParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.calendar.pending" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.calendar.calculation.retry" => {
            serde_json::from_value::<CalendarCalculationRetryParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.goal.start" => serde_json::from_value::<GoalStartParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.goal.update" => serde_json::from_value::<GoalUpdateParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.goal.control" => serde_json::from_value::<GoalControlParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.goal.list" => serde_json::from_value::<ThreadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.resources.refresh" => {
            serde_json::from_value::<ResourceRefreshParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.resources.snapshot" => {
            serde_json::from_value::<ResourceSnapshotParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.registrations.pending" => {
            serde_json::from_value::<FollowupPendingParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.registration.cancel" => {
            serde_json::from_value::<FollowupRegistrationCancelParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.register" => {
            serde_json::from_value::<FollowupRegisterAdmissionParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.files" => serde_json::from_value::<FollowupFilesParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.followup.metrics" => {
            serde_json::from_value::<FollowupMetricWorksParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.metric.observe" => {
            serde_json::from_value::<FollowupMetricObserveParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.research" => {
            serde_json::from_value::<FollowupResearchWorksParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.research.observe" => {
            serde_json::from_value::<FollowupResearchObserveParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.log.observe" => {
            serde_json::from_value::<FollowupLogObserveParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.file.observe" => {
            serde_json::from_value::<FollowupFileObserveParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.file.release" => {
            serde_json::from_value::<FollowupFileReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.list" => serde_json::from_value::<ThreadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.followup.get" => serde_json::from_value::<FollowupGetParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.followup.occurrences" => {
            serde_json::from_value::<FollowupOccurrencesParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.occurrence" => {
            serde_json::from_value::<FollowupOccurrenceGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.followup.control" => {
            serde_json::from_value::<FollowupControlParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.branch.fork" => serde_json::from_value::<BranchForkParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.plan.view" => serde_json::from_value::<PlanViewParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.plan.contains" => serde_json::from_value::<PlanContainsParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.context_job.create" => {
            serde_json::from_value::<ContextJobCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.context_job.inspect" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.context_job.list" => serde_json::from_value::<HistoryParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.context_job.publish" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.context_job.resume" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.context.inspect" => serde_json::from_value::<HistoryParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.context.refresh" => serde_json::from_value::<ContextRefreshParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.memory.reconcile" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.plan.reconcile" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.history.page" => serde_json::from_value::<HistoryPageParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.history.body" => serde_json::from_value::<HistoryBodyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.output.media.read" => serde_json::from_value::<MediaReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.thread.operations.active" => {
            serde_json::from_value::<ThreadOperationsParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.host_tool.reconcile" => {
            serde_json::from_value::<HostToolReconcileParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.run.reconcile" => serde_json::from_value::<RunReconcileParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.launch.fail" => serde_json::from_value::<LaunchFailedParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.thread.inspect" => serde_json::from_value::<ThreadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.thread.list" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.input.enqueue" => serde_json::from_value::<InputEnqueueParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.input.enqueueReceipt" => {
            serde_json::from_value::<InputEnqueueParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.input.edit" => serde_json::from_value::<InputEditParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.input.cancel" => serde_json::from_value::<InputCancelParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.input.inspect" => serde_json::from_value::<InputHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.input.list" => serde_json::from_value::<HistoryParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.launch.select" => serde_json::from_value::<LaunchSelectParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.launch.mcp.prepare" => serde_json::from_value::<McpPrepareParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.launch.extensions.prepare" => {
            serde_json::from_value::<ExtensionPrepareParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.tools.select" => serde_json::from_value::<ToolSelectParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.tools.ready" => serde_json::from_value::<ToolReadyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.launch.policy.prepare" => {
            serde_json::from_value::<PolicyPrepareParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.policy.select" => serde_json::from_value::<PolicySelectParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.policy.ready" => serde_json::from_value::<PolicyReadyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.policy.cancel" => serde_json::from_value::<PolicyCancelParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.policy.fail" => serde_json::from_value::<PolicyFailParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.policy.inspect" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.launch.inspect" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.launch.list" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.run.start" => serde_json::from_value::<RunStartParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.model.select" => serde_json::from_value::<ModelSelectParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.model.inspect" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.status" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.content.collect" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.admission.inspect" => {
            serde_json::from_value::<AdmissionInspectParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.thread.create" => serde_json::from_value::<ThreadCreateParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.input.submit" => serde_json::from_value::<InputSubmitParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.input.receipt" => serde_json::from_value::<InputSubmitParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.run.scope" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.run.inspect" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.run.cancel" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.run.resume" => serde_json::from_value::<RunResumeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.permission.open" => serde_json::from_value::<PermissionOpenParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.permission.decide" => {
            serde_json::from_value::<PermissionDecideParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.permission.consume" => {
            serde_json::from_value::<PermissionOpenParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.question.answer" => serde_json::from_value::<QuestionAnswerParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.operation.inspect" => {
            serde_json::from_value::<OperationInspectParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.operation.status" => serde_json::from_value::<OperationParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.operation.cancel" => serde_json::from_value::<OperationParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.process.access" => {
            serde_json::from_value::<RuntimeProcessAccessParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.events.read" => serde_json::from_value::<EventsParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.observer.read" => serde_json::from_value::<ObserverReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.observer.delivery" => {
            serde_json::from_value::<ObserverDeliveryParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "process.subscribe" => {
            serde_json::from_value::<KernelProcessSubscribeParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "process.subscription.ack" => {
            serde_json::from_value::<KernelProcessSubscriptionAckParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "process.subscription.unsubscribe" => {
            serde_json::from_value::<KernelProcessSubscriptionParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "process.spawn" => serde_json::from_value::<KernelProcessSpawnParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.read" => serde_json::from_value::<KernelProcessReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.write" => serde_json::from_value::<KernelProcessWriteParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.resize" => serde_json::from_value::<KernelProcessResizeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.interaction.inspect" => {
            serde_json::from_value::<KernelProcessInteractionInspectParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "process.kill" => serde_json::from_value::<KernelProcessKillParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.inspect" => serde_json::from_value::<KernelProcessHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.list" => serde_json::from_value::<KernelProcessListParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.release" => serde_json::from_value::<KernelProcessHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "kernel.handshake" => serde_json::from_value::<KernelHandshakeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "kernel.ping" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "kernel.shutdown" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.health" => serde_json::from_value::<KernelHealthParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "source.handoff.claim" => {
            serde_json::from_value::<KernelSourceHandoffClaimParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "authority.grant.issue" => serde_json::from_value::<KernelGrantIssueParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "authority.grant.revoke" => {
            serde_json::from_value::<KernelGrantTargetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "authority.grant.retire" => {
            serde_json::from_value::<KernelGrantRetireParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.snapshot" => serde_json::from_value::<KernelSnapshotParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.putBlob.begin" => {
            serde_json::from_value::<KernelPutBlobBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.putBlob.chunk" => {
            serde_json::from_value::<KernelPutBlobChunkParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.putBlob.finish" => {
            serde_json::from_value::<KernelPutBlobFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.putBlob.abort" => {
            serde_json::from_value::<KernelPutBlobAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.blob.release" => serde_json::from_value::<KernelBlobReleaseParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.getBlob" => serde_json::from_value::<KernelGetBlobParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.object.rebindOwner" => {
            serde_json::from_value::<KernelObjectOwnerRebindParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.read.check" => serde_json::from_value::<KernelFileReadCheckParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.root.register" => {
            serde_json::from_value::<KernelFileRootRegisterParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.operation.list" => {
            serde_json::from_value::<KernelFileOperationListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.operation.reconcile" => {
            serde_json::from_value::<KernelFileOperationReconcileParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.lease.acquire" => {
            serde_json::from_value::<KernelFileLeaseAcquireParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.lease.check" => {
            serde_json::from_value::<KernelFileLeaseAcquireParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.lease.release" => {
            serde_json::from_value::<KernelFileLeaseReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.capture" => serde_json::from_value::<KernelFileCaptureParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.captureBatch" => {
            serde_json::from_value::<KernelFileCaptureBatchParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.apply" => serde_json::from_value::<KernelFileApplyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.mkdir" => serde_json::from_value::<KernelFileMkdirParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.remove" => serde_json::from_value::<KernelFileRemoveParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.rename" => serde_json::from_value::<KernelFileRenameParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.scan" => serde_json::from_value::<KernelFileScanParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.measure" => serde_json::from_value::<KernelFileMeasureParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.materialize" => serde_json::from_value::<KernelFileMaterializeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.materializedView.prepare" => {
            serde_json::from_value::<KernelMaterializedViewPrepareParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.materializedView.check" => {
            serde_json::from_value::<KernelMaterializedViewParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.materializedView.release" => {
            serde_json::from_value::<KernelMaterializedViewParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.record.put" => serde_json::from_value::<KernelRecordPutParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.get" => serde_json::from_value::<KernelRecordGetParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.list" => serde_json::from_value::<KernelRecordListParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.experiment.artifacts" => {
            serde_json::from_value::<KernelExperimentArtifactsParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.experiment.logChunks" => {
            serde_json::from_value::<KernelExperimentLogChunksParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.record.workspaces" => {
            serde_json::from_value::<KernelRecordWorkspacesParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.record.release" => {
            serde_json::from_value::<KernelRecordReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.prepare" => {
            serde_json::from_value::<KernelWorkingResultPrepareParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.publish" => {
            serde_json::from_value::<KernelWorkingResultPublishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.candidate.release" => {
            serde_json::from_value::<KernelWorkingResultCandidateReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.put" => {
            serde_json::from_value::<KernelWorkingResultPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.get" => {
            serde_json::from_value::<KernelWorkingResultGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.list" => {
            serde_json::from_value::<KernelWorkingResultListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.release" => {
            serde_json::from_value::<KernelWorkingResultReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.put" => {
            serde_json::from_value::<KernelWorkingDraftPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.get" => {
            serde_json::from_value::<KernelWorkingDraftGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.list" => {
            serde_json::from_value::<KernelWorkingDraftListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.release" => {
            serde_json::from_value::<KernelWorkingDraftReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.put" => {
            serde_json::from_value::<KernelWorkingVerificationPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.list" => {
            serde_json::from_value::<KernelWorkingVerificationListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.release" => {
            serde_json::from_value::<KernelWorkingVerificationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.put" => {
            serde_json::from_value::<KernelWorkingReviewPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.list" => {
            serde_json::from_value::<KernelWorkingReviewListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.release" => {
            serde_json::from_value::<KernelWorkingReviewReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.begin" => {
            serde_json::from_value::<KernelCreateBranchBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.append" => {
            serde_json::from_value::<KernelCreateBranchAppendParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.finish" => {
            serde_json::from_value::<KernelCreateBranchFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.abort" => {
            serde_json::from_value::<KernelCreateBranchAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.read" => serde_json::from_value::<KernelBranchReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.write.begin" => {
            serde_json::from_value::<KernelBranchWriteBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.append" => {
            serde_json::from_value::<KernelBranchWriteAppendParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.finish" => {
            serde_json::from_value::<KernelBranchWriteFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.abort" => {
            serde_json::from_value::<KernelBranchWriteAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.publish" => serde_json::from_value::<KernelBranchPublishParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.pin" => serde_json::from_value::<KernelBranchPinParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.unpin" => serde_json::from_value::<KernelBranchUnpinParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.diff" => serde_json::from_value::<KernelBranchDiffParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.objects" => serde_json::from_value::<KernelBranchObjectsParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.delete" => serde_json::from_value::<KernelBranchDeleteParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "pin.read" => serde_json::from_value::<KernelPinReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "recovery.operation.get" => {
            serde_json::from_value::<KernelRecoveryOperationGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.start" => {
            serde_json::from_value::<KernelRecoveryTurnStartParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.get" => {
            serde_json::from_value::<KernelRecoveryTurnGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.settle" => {
            serde_json::from_value::<KernelRecoveryTurnSettleParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.checkpoint.create" => {
            serde_json::from_value::<KernelRecoveryCheckpointCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.checkpoint.list" => {
            serde_json::from_value::<KernelRecoveryCheckpointListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.entry.resolve" => {
            serde_json::from_value::<KernelRecoveryEntryResolveParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.before" => {
            serde_json::from_value::<KernelRecoveryChangeBeforeParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.get" => {
            serde_json::from_value::<KernelRecoveryChangeGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.list" => {
            serde_json::from_value::<KernelRecoveryChangeListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.after" => {
            serde_json::from_value::<KernelRecoveryChangeAfterParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.create" => {
            serde_json::from_value::<KernelRecoveryOperationCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.file.cas" => {
            serde_json::from_value::<KernelRecoveryOperationFileCasParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.complete" => {
            serde_json::from_value::<KernelRecoveryOperationCompleteParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.conflicts" => {
            serde_json::from_value::<KernelRecoveryOperationConflictsParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.list" => {
            serde_json::from_value::<KernelRecoveryOperationListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.release" => {
            serde_json::from_value::<KernelRecoveryOperationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "operation.get" => serde_json::from_value::<KernelOperationGetParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "operation.release" => {
            serde_json::from_value::<KernelOperationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.gc" => serde_json::from_value::<KernelGcParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.start" => serde_json::from_value::<KernelComputeStartParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.read" => serde_json::from_value::<KernelComputeReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.cancel" => serde_json::from_value::<KernelComputeHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.release" => serde_json::from_value::<KernelComputeHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.grammar.register" => {
            serde_json::from_value::<KernelComputeGrammarParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.sources.pending" => {
            serde_json::from_value::<KernelEmptyParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.sources.release" => {
            serde_json::from_value::<OperationParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.continuation.accept" => {
            serde_json::from_value::<ChildContinuationAcceptParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.execution.inspect" => {
            serde_json::from_value::<ChildExecutionParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.execution.for_run" => serde_json::from_value::<RunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.execution.list" => {
            serde_json::from_value::<ChildExecutionListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.execution.report.read" => {
            serde_json::from_value::<ChildExecutionReportReadParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.list" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.inspect" => serde_json::from_value::<OperationParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.report.read" => {
            serde_json::from_value::<ChildReportReadParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.for_thread" => serde_json::from_value::<ThreadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.source.ready" => {
            serde_json::from_value::<ChildSourceReadyParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.settle" => serde_json::from_value::<ChildSettleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.result.candidate" => {
            serde_json::from_value::<ChildResultCandidateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.result.published" => {
            serde_json::from_value::<ChildResultPublishedParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.prepare" => serde_json::from_value::<ChildPrepareParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.fail" => serde_json::from_value::<ChildFailParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.cancel" => serde_json::from_value::<OperationParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.tree.cancel" => serde_json::from_value::<TreeCancelParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.capabilities" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.source.tools" => serde_json::from_value::<SourceToolsParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.child.release" => serde_json::from_value::<ChildExecutionParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.observations.reconcile" => {
            serde_json::from_value::<KernelEmptyParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.child.wait.cancel" => serde_json::from_value::<ChildWaitParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.family.list" => serde_json::from_value::<FamilyListParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.family.runs" => serde_json::from_value::<FamilyRunsParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.family.read" => serde_json::from_value::<FamilyReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.family.item" => serde_json::from_value::<FamilyItemParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.messages.send" => serde_json::from_value::<MessageSendParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.messages.list" => serde_json::from_value::<MessageListParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.messages.get" => serde_json::from_value::<MessageGetParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.host_job.task.update" => {
            serde_json::from_value::<HostJobTaskUpdateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.host_job.access" => serde_json::from_value::<HostJobAccessParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.host_job.task.context" => {
            serde_json::from_value::<OperationParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.host_job.task.read" => {
            serde_json::from_value::<HostJobAccessParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.host_job.task.finish" => {
            serde_json::from_value::<HostJobBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.resource.begin" => {
            serde_json::from_value::<McpResourceBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.resource.accept" => {
            serde_json::from_value::<McpResourceAcceptParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.resource.listener" => {
            serde_json::from_value::<McpResourceListenerParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.resource.notify" => {
            serde_json::from_value::<McpResourceNotifyParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.resource.pending" => {
            serde_json::from_value::<KernelEmptyParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.resource.context" => serde_json::from_value::<OperationParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.mcp.resource.access" => {
            serde_json::from_value::<McpResourceAccessParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.mcp.resource.release_source" => {
            serde_json::from_value::<RunParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        _ => Ok(()),
    }
}

pub(crate) fn validate_generated_working_document(
    record_type: &str,
    document: &Value,
) -> Result<(), String> {
    match record_type {
        "working.result" => serde_json::from_value::<KernelWorkingResultDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "working.draft" => serde_json::from_value::<KernelWorkingDraftDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "working.verification.child" => {
            serde_json::from_value::<KernelWorkingVerificationDocument>(document.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.parent" => {
            serde_json::from_value::<KernelWorkingVerificationDocument>(document.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review" => serde_json::from_value::<KernelWorkingReviewDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}
