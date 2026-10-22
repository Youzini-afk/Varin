//! Authenticated Host source authority and the closed resource wire contract.
//! The receiving Host has no copy of the coordinating Agent Catalog.
use crate::{error::KernelError, tools::ToolBinding};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use varin_runtime::catalog::launches::{LiveRoot, SourceSelection};
use varin_runtime::ExecutorOwner;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SourceAuthorityScope {
    Run {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId")]
        run_id: String,
        epoch: u64,
    },
    SourceRead {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "branchId")]
        branch_id: String,
        key: String,
    },
}
impl SourceAuthorityScope {
    pub fn thread_id(&self) -> &str {
        match self {
            Self::Run { thread_id, .. } | Self::SourceRead { thread_id, .. } => thread_id,
        }
    }
    pub fn run_id(&self) -> Option<&str> {
        match self {
            Self::Run { run_id, .. } => Some(run_id),
            _ => None,
        }
    }
    pub fn epoch(&self) -> u64 {
        match self {
            Self::Run { epoch, .. } => *epoch,
            _ => 0,
        }
    }
    pub fn identity(&self) -> Value {
        match self {
            Self::Run {
                thread_id, run_id, ..
            } => json!(["run", thread_id, run_id]),
            Self::SourceRead {
                thread_id,
                branch_id,
                key,
            } => json!(["source_read", thread_id, branch_id, key]),
        }
    }
    pub fn validate(&self) -> bool {
        !self.thread_id().is_empty()
            && match self {
                Self::Run { run_id, .. } => !run_id.is_empty(),
                Self::SourceRead { branch_id, key, .. } => !branch_id.is_empty() && !key.is_empty(),
            }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceCapabilitiesParams {
    pub mode: varin_runtime::SourceMode,
    pub enabled_tools: Option<Vec<String>>,
    pub client_capabilities: Option<Vec<String>>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceAuthorityOpenParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub scope: SourceAuthorityScope,
    pub source: SourceSelection,
    pub grant_id: String,
    pub enabled_tools: Vec<String>,
    pub purpose: String,
    pub operation_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceAuthorityBindParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub tool_binding: Option<ToolBinding>,
    pub physical_root: Option<LiveRoot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceAuthorityAddress {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
}
pub(crate) use varin_runtime::catalog::launches::SourceMcpChildBinding;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SourceMcpDerivationOutcome {
    Derived { provenance: varin_runtime::catalog::launches::McpProvenance },
    Failed { code: String },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpDerivationReference {
    pub execution_id: String,
    pub released: bool,
    #[serde(deserialize_with = "Option::deserialize")]
    pub request_hash: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub request_ref: Option<SourceMcpCreationReceiptBodyRef>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub outcome_ref: Option<SourceMcpCreationReceiptBodyRef>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceMcpDerivationAction { Begin, Settle, Inspect, Read, Release }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpDerivationParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub execution_id: String,
    pub action: SourceMcpDerivationAction,
    pub origin: Option<varin_runtime::catalog::launches::McpChildDerivationOrigin>,
    pub selection: Option<varin_runtime::catalog::launches::HostToolBinding>,
    pub outcome: Option<SourceMcpDerivationOutcome>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpChildReference {
    pub binding: SourceMcpChildBinding,
    /// Only release-before-retain may omit the original target-owned body ref.
    #[serde(deserialize_with = "Option::deserialize")]
    pub selection_ref: Option<SourceMcpCreationReceiptBodyRef>,
    pub released: bool,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceMcpChildAction { Retain, Inspect, Read, Release }
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpChildParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub binding: SourceMcpChildBinding,
    pub action: SourceMcpChildAction,
    pub selection: Option<varin_runtime::catalog::launches::HostToolBinding>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpHolderBinding {
    pub operation_id: String,
    pub execution_owner: ExecutorOwner,
    pub purpose: String,
    pub endpoint: varin_runtime::catalog::host_jobs::McpEndpoint,
}
impl SourceMcpHolderBinding {
    pub fn validate(&self) -> bool {
        !self.operation_id.is_empty()
            && matches!(&self.execution_owner, ExecutorOwner::External { .. })
            && self.execution_owner.validate()
            && matches!(self.purpose.as_str(), "task" | "resource_observer")
            && !self.endpoint.server.is_empty()
            && !self.endpoint.resource_key.is_empty()
            && !self.endpoint.configuration_version.is_empty()
            && !self.endpoint.credential_version.is_empty()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpHolder {
    pub binding: SourceMcpHolderBinding,
    pub released: bool,
    /// The original creation attempt only. Null is not evidence that dispatch is safe.
    #[serde(deserialize_with = "Option::deserialize")]
    pub creation_receipt: Option<SourceMcpCreationReceipt>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpCreationReceipt {
    pub request_hash: String,
    /// A begun, unsettled attempt cannot be dispatched again.
    #[serde(deserialize_with = "Option::deserialize")]
    pub outcome_ref: Option<SourceMcpCreationReceiptBodyRef>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpCreationReceiptBodyRef {
    pub object_hash: String,
    pub byte_length: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SourceMcpCreationOutcome {
    Accepted { response: SourceMcpTaskCreationResponse },
    Subscribed {
        #[serde(rename = "listenerId")]
        listener_id: String,
        acknowledgement: serde_json::Map<String, Value>,
    },
    Failed { error: SourceMcpCreationError },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpTaskCreationResponse {
    pub task: varin_runtime::catalog::host_jobs::McpTaskState,
    pub result: serde_json::Map<String, Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpCreationError {
    pub code: String,
    pub dispatched: bool,
    pub settlement: SourceMcpCreationSettlement,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_kind: Option<SourceMcpCreationProblemKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rpc_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_error: Option<serde_json::Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_problem: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceMcpCreationSettlement {
    Unknown,
    SessionExpired,
    RpcResponse,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceMcpCreationProblemKind {
    Protocol,
    Transport,
    Unsupported,
    Owner,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceMcpCreationReceiptAction {
    Begin,
    Inspect,
    Settle,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpCreationReceiptParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub binding: SourceMcpHolderBinding,
    pub request_hash: Option<String>,
    pub action: SourceMcpCreationReceiptAction,
    pub outcome: Option<SourceMcpCreationOutcome>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpHolderParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub binding: SourceMcpHolderBinding,
    pub action: String,
}
/// Transport facts on the original Source authority. Request/answer bodies and
/// the only SDK responder stay in the original Host's memory.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpDeliveryReceipt {
    pub delivery_id: String,
    pub binding: varin_runtime::catalog::mcp_interactions::McpInteractionBinding,
    pub kind: SourceMcpDeliveryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_holder: Option<SourceMcpHolderBinding>,
    pub request_hash: String,
    pub revision: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    pub response_hash: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub delivery: Option<SourceMcpDeliveryState>,
    pub availability: varin_runtime::McpInteractionAvailability,
    pub completed: bool,
    pub acknowledged_revision: u64,
    pub released: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceMcpDeliveryKind {
    Elicitation,
    Sampling,
    Error,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceMcpDeliveryState {
    Sending,
    Sent,
    NotSent,
    Unknown,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceMcpDeliveryAction {
    Open,
    Inspect,
    Begin,
    Settle,
    Close,
    Complete,
    Ack,
    Release,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceMcpDeliveryParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub delivery_id: String,
    pub binding: varin_runtime::catalog::mcp_interactions::McpInteractionBinding,
    pub action: SourceMcpDeliveryAction,
    pub kind: Option<SourceMcpDeliveryKind>,
    pub cleanup_holder: Option<SourceMcpHolderBinding>,
    pub request_hash: Option<String>,
    pub response_hash: Option<String>,
    pub delivery: Option<SourceMcpDeliveryState>,
    pub availability: Option<varin_runtime::McpInteractionAvailability>,
    pub revision: Option<u64>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceProcessAccessParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub process_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceScriptControlParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub process_id: String,
    pub source: SourceSelection,
    pub stop: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceAuthorityReleaseParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub mode: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceAuthorityScopeParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub thread_id: String,
    pub run_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceReadScopeParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub scope: SourceAuthorityScope,
    pub source: SourceSelection,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SourceFileObservationAction {
    Accept {
        request: varin_runtime::catalog::followups::FileObservationRequest,
    },
    Observe {
        request: varin_runtime::catalog::followups::FileObservationRequest,
        watch_id: Option<String>,
        after: Option<varin_runtime::catalog::followups::FileWatchPosition>,
        reopen: bool,
        current: Option<varin_runtime::catalog::followups::FileState>,
        ready: bool,
    },
    Release {
        request: varin_runtime::catalog::followups::FileObservationRequest,
    },
}
impl SourceFileObservationAction {
    fn request(&self) -> &varin_runtime::catalog::followups::FileObservationRequest {
        match self {
            Self::Accept { request }
            | Self::Observe { request, .. }
            | Self::Release { request } => request,
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceFileObservationParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub request_id: String,
    pub client_capabilities: Vec<String>,
    pub action: SourceFileObservationAction,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceAuthorityScopeReleaseParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub thread_id: String,
    pub run_id: String,
    pub mode: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceCall {
    pub run_id: String,
    pub operation_id: String,
    pub origin: varin_runtime::execution::ToolOrigin,
    pub call_id: String,
    pub name: String,
    pub schema_version: String,
    pub arguments: Value,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceResourceCallParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub call: SourceCall,
    pub journal: Option<varin_runtime::catalog::journal::JournalAnchor>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceResourceControlParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub operation_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SourceResourceAction {
    Read {
        path: String,
        offset: u64,
        length: Option<u64>,
        #[serde(default, skip_serializing_if="Option::is_none")]
        start_line: Option<u64>,
        #[serde(default, skip_serializing_if="Option::is_none")]
        end_line: Option<u64>,
    },
    LanguageSource {
        path: String,
        derived_view: Option<Value>,
    },
    RetrievalSource {
        paths: Option<Vec<String>>,
    },
    ChildSourceHandoff {
        delegation: varin_runtime::catalog::dispatch::ChildSourceDelegation,
    },
    ChildStorageReceipt {
        operation_id: String,
        receipt_kind: String,
    },
    ChildRootIdle,
    CollaborationPin {
        release: bool,
        pin_id: String,
    },
    ProcessObservation {
        source_run_id: String,
        lineage: Option<varin_runtime::catalog::process_wait::ProcessResultLineage>,
        process_id: String,
        read: Option<(u64, Option<u64>)>,
    },
    ReconcileMutation {
        mutation: crate::storage::file_mutations::TextMutation,
        executor: String,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SourceServiceOperation {
    NativeResource {
        context: varin_runtime::execution::ToolExecutionContext,
        action: SourceResourceAction,
        #[serde(rename = "authorizeOnly")]
        authorize_only: bool,
    },
    Validate,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceServiceCallParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub request_id: String,
    pub client_capabilities: Vec<String>,
    pub operation: SourceServiceOperation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceAuthorityResult {
    pub authority_id: String,
    pub resource_epoch: String,
    pub execution_owner: ExecutorOwner,
    pub source: SourceSelection,
    pub scope: SourceAuthorityScope,
    pub phase: String,
    pub purpose: String,
    pub operation_id: Option<String>,
    pub grant_id: String,
    pub tool_binding: Option<ToolBinding>,
    pub physical_root: Option<LiveRoot>,
    pub first_preparation: bool,
    pub materialization_operation_id: String,
    pub mcp_holders: Vec<SourceMcpHolder>,
    pub mcp_deliveries: Vec<SourceMcpDeliveryReceipt>,
    pub mcp_children: Vec<SourceMcpChildReference>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub mcp_derivation: Option<SourceMcpDerivationReference>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuthorityRecord {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub scope_id: String,
    pub enabled_tools: Vec<String>,
    pub purpose: String,
    pub operation_id: Option<String>,
    pub result: SourceAuthorityResult,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScopeRecord {
    pub source: SourceSelection,
    pub epoch: u64,
    pub ready: bool,
    pub closed: bool,
    // A seal fences MCP admission only through this coordinator epoch. Other
    // original Source purposes and a later Run epoch keep their own admission.
    #[serde(deserialize_with = "Option::<u64>::deserialize")]
    pub mcp_closed_epoch: Option<u64>,
}
pub(crate) fn denied(message: &str) -> KernelError {
    KernelError::Authorization(message.into())
}
pub(crate) fn address(p: &SourceResourceCallParams) -> SourceAuthorityAddress {
    SourceAuthorityAddress {
        principal_id: p.principal_id.clone(),
        coordinator_host_id: p.coordinator_host_id.clone(),
        authority_id: p.authority_id.clone(),
        resource_epoch: p.resource_epoch.clone(),
    }
}

pub(crate) fn capabilities(p: SourceCapabilitiesParams) -> Result<Value, KernelError> {
    crate::tools::source_capabilities(p)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceProcessTerminal {
    pub v: u64,
    pub kind: String,
    pub kernel_epoch: String,
    pub source: SourceSelection,
    pub execution_owner: ExecutorOwner,
    pub process: Value,
}
impl SourceProcessTerminal {
    pub fn process_id(&self) -> String {
        self.process["processId"]
            .as_str()
            .unwrap_or_default()
            .into()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceHandoffInspectParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub operation_id: String,
    pub parent_run_id: String,
    pub parent_thread_id: String,
    pub source: SourceSelection,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceContinuation {
    pub refresh: Option<varin_runtime::catalog::dispatch::AgentSourceSelection>,
    pub execution_id: String,
    pub previous_run_id: String,
    pub root: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceHandoffClaimParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub grant_id: String,
    pub scope: SourceAuthorityScope,
    pub source: SourceSelection,
    pub handoff: Option<varin_runtime::catalog::collaboration::ChildSourceHandoff>,
    pub continuation: Option<SourceContinuation>,
}

pub(crate) fn authorize_service_capabilities(
    p: &SourceServiceCallParams,
) -> Result<(), KernelError> {
    let has = |cap: &str| p.client_capabilities.iter().any(|value| value == cap);
    if !has("filesystem:read") {
        return Err(denied("Current source read capability was revoked"));
    }
    if let SourceServiceOperation::NativeResource { action, .. } = &p.operation {
        let process = matches!(action, SourceResourceAction::ProcessObservation { .. })
            || matches!(action,SourceResourceAction::ChildSourceHandoff{delegation} if delegation.process);
        if process && (!has("terminal:use") || !has("process:control")) {
            return Err(denied("Current source process capability was revoked"));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceIntegrationReceiptParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub source: SourceSelection,
    pub run_id: String,
    pub thread_id: String,
    pub operation_id: String,
}

/// Short original-owner admission. Callers must release Storage before running a Work item.
/// Both the production actor and direct-owner integration fixtures use this same dispatcher.
pub(crate) enum SourceDispatch {
    Ready(Value),
    ProcessAccess { binding: ToolBinding, process_id: String },
    FileObservation {
        address: SourceAuthorityAddress,
        request_id: String,
        action: SourceFileObservationAction,
    },
    ReadObserve(crate::storage::source_read_receipts::ReadReceipt),
    ScheduleReceiptStage(crate::storage::source_schedule_receipts::ScheduleReceiptPreparation),
    ScheduleReceiptObserve(crate::storage::source_schedule_receipts::ScheduleReceiptBody),
    McpCreationReceiptStage(crate::storage::source_mcp_receipts::McpReceiptPreparation),
    McpCreationReceiptObserve(crate::storage::source_mcp_receipts::McpReceiptBody),
    McpDerivationStage(crate::storage::source_mcp_derivation::McpDerivationPreparation),
    McpDerivationObserve(crate::storage::source_mcp_derivation::McpDerivationBody),
    McpChildSelectionStage(crate::storage::source_mcp_children::McpChildPreparation),
    McpChildSelectionObserve(crate::storage::source_mcp_children::McpChildBody),
    InteractionObserve {
        record: AuthorityRecord,
        native: crate::storage::process_interactions::Native,
        address: crate::storage::process_interactions::Address,
    },
    Tool {
        record: AuthorityRecord,
        input: SourceResourceCallParams,
        authorize: bool,
        read: Option<crate::storage::source_read_receipts::ReadPreparation>,
    },
    Resource {
        record: AuthorityRecord,
        address: SourceAuthorityAddress,
        request_id: String,
        context: varin_runtime::execution::ToolExecutionContext,
        action: SourceResourceAction,
        authorize: bool,
    },
}
impl SourceDispatch {
    pub fn key(&self) -> Option<String> {
        match self {
            Self::Ready(_) => None,
            Self::ProcessAccess { .. } => Some(format!("process-access:{}", uuid::Uuid::new_v4())),
            Self::FileObservation {
                address,
                request_id,
                ..
            } => Some(format!(
                "file-observation:{}:{}",
                address.authority_id, request_id
            )),
            Self::ScheduleReceiptStage(_) | Self::ScheduleReceiptObserve(_) =>
                Some(format!("schedule-receipt:{}", uuid::Uuid::new_v4())),
            Self::ReadObserve(_) => Some(format!("source-read-observe:{}", uuid::Uuid::new_v4())),
            Self::McpDerivationStage(_) | Self::McpDerivationObserve(_) =>
                Some(format!("mcp-child-derivation:{}", uuid::Uuid::new_v4())),
            Self::McpChildSelectionStage(_) | Self::McpChildSelectionObserve(_) =>
                Some(format!("mcp-child-selection:{}", uuid::Uuid::new_v4())),
            Self::McpCreationReceiptStage(_) | Self::McpCreationReceiptObserve(_) =>
                Some(format!("mcp-creation-receipt:{}", uuid::Uuid::new_v4())),
            Self::InteractionObserve {
                record, address, ..
            } => Some(format!(
                "observe:{}:{}",
                record.result.authority_id, address.operation_id
            )),
            Self::Tool { input, .. } => Some(format!(
                "{}:{}",
                input.authority_id, input.call.operation_id
            )),
            Self::Resource {
                address,
                request_id,
                ..
            } => Some(format!("service:{}:{}", address.authority_id, request_id)),
        }
    }
    pub fn execute(
        mut self,
        resources: crate::tools::KernelResourceClient,
        cancel: varin_runtime::execution::CancellationToken,
    ) -> Result<SourceWorkResult, KernelError> {
        if let Self::ScheduleReceiptStage(preparation) = self {
            let (value, staged) = preparation.stage()?;
            return Ok(SourceWorkResult { value, schedule_receipt: Some(staged), read: None, mcp_receipt: None, mcp_child: None, mcp_derivation: None });
        }
        if let Self::McpCreationReceiptStage(preparation) = self {
            let (value, staged) = preparation.stage()?;
            return Ok(SourceWorkResult { value, schedule_receipt: None, read: None, mcp_receipt: Some(staged), mcp_child: None, mcp_derivation: None });
        }
        if let Self::McpChildSelectionStage(preparation) = self {
            return Ok(SourceWorkResult { value: Value::Null, schedule_receipt: None, read: None, mcp_receipt: None, mcp_child: Some(preparation.stage()?), mcp_derivation: None });
        }
        if let Self::McpDerivationStage(preparation) = self {
            return Ok(SourceWorkResult { value: Value::Null, schedule_receipt: None, read: None, mcp_receipt: None,
                mcp_child: None, mcp_derivation: Some(preparation.stage()?) });
        }
        let read = if let Self::Tool { read, .. } = &mut self {
            read.take()
        } else {
            None
        };
        let value = match self {
            Self::Ready(value) => Ok(value),
            Self::ProcessAccess { binding, process_id } => resources.interactions.as_ref()
                .ok_or_else(|| denied("Original process interaction owner unavailable"))?
                .access(binding, process_id),
            Self::FileObservation {
                address, action, ..
            } => resources
                .file_observations
                .as_ref()
                .ok_or_else(|| denied("Original file observation owner unavailable"))?
                .execute_managed(address, action, &cancel),
            Self::ReadObserve(read) => read.load(),
            Self::ScheduleReceiptObserve(body) => body.load(),
            Self::ScheduleReceiptStage(_) => unreachable!("schedule receipt staged above"),
            Self::McpDerivationObserve(body) => body.load(),
            Self::McpDerivationStage(_) => unreachable!("derivation staged above"),
            Self::McpChildSelectionObserve(body) => body.load(),
            Self::McpChildSelectionStage(_) => unreachable!("selection staged above"),
            Self::McpCreationReceiptObserve(receipt) => receipt.load(),
            Self::McpCreationReceiptStage(_) => unreachable!("settlement staged above"),
            Self::InteractionObserve {
                record,
                native,
                address,
            } => {
                let id = address.operation_id.clone();
                let client = resources
                    .interactions
                    .as_ref()
                    .ok_or_else(|| denied("Original process interaction owner unavailable"))?;
                let value = client.reconcile(native, address)?;
                let (stopped, completion): (bool, varin_runtime::execution::ToolCompletion) =
                    if let Some((_, receipt)) = value {
                        (
                            receipt.identity().state != crate::process::interaction::State::Unknown,
                            varin_runtime::execution::ToolCompletion::Result {
                                outcome: receipt.outcome(),
                                effect: receipt.effect(),
                                content: serde_json::to_value(receipt)?.into(),
                            },
                        )
                    } else {
                        (false,varin_runtime::execution::ToolCompletion::Result{outcome:varin_runtime::Outcome::Indeterminate,effect:varin_runtime::Effect::Unknown,content:json!({"reason":"Original process interaction receipt remains unresolved"}).into()})
                    };
                Ok(
                    json!({"operationId":id,"resourceEpoch":record.result.resource_epoch,"executionOwner":record.result.execution_owner,"accepted":true,"executorStopped":stopped,"result":varin_runtime::execution::ToolExecutionReceipt{completion,executor_stopped:stopped},"process":null}),
                )
            }
            Self::Tool {
                record,
                input,
                authorize,
                ..
            } => crate::tools::execute_source_tool(resources, record, input, authorize, cancel),
            Self::Resource {
                record,
                address,
                context,
                action,
                authorize,
                ..
            } => crate::tools::execute_source_resource(
                resources, record, address, context, action, authorize, cancel,
            ),
        };
        if let Some(read) = read {
            let (value, staged) = read.stage(value)?;
            Ok(SourceWorkResult {
                value,
                schedule_receipt: None,
                read: Some(staged),
                mcp_receipt: None,
                mcp_child: None, mcp_derivation: None,
            })
        } else {
            value.map(|value| SourceWorkResult { value, schedule_receipt: None, read: None, mcp_receipt: None, mcp_child: None, mcp_derivation: None })
        }
    }
}
pub(crate) struct SourceWorkResult {
    value: Value,
    schedule_receipt: Option<crate::storage::source_schedule_receipts::StagedScheduleReceipt>,
    read: Option<crate::storage::source_read_receipts::StagedRead>,
    mcp_receipt: Option<crate::storage::source_mcp_receipts::StagedMcpReceipt>,
    mcp_child: Option<crate::storage::source_mcp_children::StagedMcpChild>,
    mcp_derivation: Option<crate::storage::source_mcp_derivation::StagedMcpDerivation>,
}
impl SourceWorkResult {
    pub(crate) fn finish(
        self,
        storage: &mut crate::storage::Storage,
    ) -> Result<Value, KernelError> {
        if let Some(receipt) = self.schedule_receipt {
            storage.publish_source_schedule(receipt)?;
            return Ok(self.value);
        }
        if let Some(read) = self.read {
            storage.publish_source_read(read)?;
        }
        if let Some(derivation) = self.mcp_derivation {
            return storage.publish_source_mcp_derivation(derivation);
        }
        if let Some(child) = self.mcp_child {
            return storage.publish_source_mcp_child(child);
        }
        if let Some(receipt) = self.mcp_receipt {
            let mut value = storage.publish_source_mcp_creation_receipt(receipt)?;
            if value["holder"]["released"] != true {
                value["outcome"] = self.value;
            }
            return Ok(value);
        }
        Ok(self.value)
    }
}
pub(crate) fn prepare_request(
    storage: &mut crate::storage::Storage,
    method: &str,
    params: Value,
    epoch: &str,
    host: &str,
    generation: &str,
) -> Result<SourceDispatch, KernelError> {
    crate::protocol::validate_method_params(method, &params)?;
    let value = match method {
        "source.script.control" => storage.control_source_script(serde_json::from_value(params)?, epoch, host)?,
        "source.process.access" => {
            let p: SourceProcessAccessParams = serde_json::from_value(params)?;
            let address = SourceAuthorityAddress { principal_id: p.principal_id,
                coordinator_host_id: p.coordinator_host_id, authority_id: p.authority_id,
                resource_epoch: p.resource_epoch };
            let record = storage.source_authority(&address, true, epoch)?;
            if !matches!(record.purpose.as_str(), "source" | "process_view" | "script_environment") || record.result.phase != "ready"
                || matches!(record.purpose.as_str(), "process_view" | "script_environment") && record.operation_id.as_deref() != Some(p.process_id.as_str()) {
                return Err(denied("Original process source is unavailable"));
            }
            let mut binding = record.result.tool_binding.ok_or_else(|| denied("Original process Run binding is unavailable"))?;
            binding.target_authority = Some(address);
            return Ok(SourceDispatch::ProcessAccess { binding, process_id: p.process_id });
        }
        "source.file_observation" => {
            let p: SourceFileObservationParams = serde_json::from_value(params)?;
            if !matches!(p.action, SourceFileObservationAction::Release { .. })
                && !p.client_capabilities.iter().any(|c| c == "filesystem:read")
            {
                return Err(denied("Current source read capability was revoked"));
            }
            let address = SourceAuthorityAddress {
                principal_id: p.principal_id,
                coordinator_host_id: p.coordinator_host_id,
                authority_id: p.authority_id,
                resource_epoch: p.resource_epoch,
            };
            let record = storage.source_authority(&address, false, epoch)?;
            if record.purpose == "mcp_owner" {
                return Err(denied("MCP owner does not admit file observations"));
            }
            let r = p.action.request();
            let mut source = r.source.clone();
            if matches!(record.result.scope, SourceAuthorityScope::SourceRead { .. })
                && source.mode == varin_runtime::SourceMode::Materialized
            {
                source.environment_run_id =
                    source.environment_run_id.or(Some(r.source_run_id.clone()));
            }
            let expected = varin_runtime::catalog::followups::FileObservationAuthority {
                coordinator_host_id: address.coordinator_host_id.clone(),
                authority_id: address.authority_id.clone(),
                resource_epoch: address.resource_epoch.clone(),
            };
            if r.resource_authority.as_ref() != Some(&expected)
                || record.result.source != source
                || record.result.scope.thread_id() != r.thread_id
                || record
                    .result
                    .scope
                    .run_id()
                    .is_some_and(|run| run != r.source_run_id)
                || matches!(&r.actor,varin_runtime::catalog::followups::FollowupActor::Agent{run_id,..}if record.result.scope.run_id()!=Some(run_id))
            {
                return Err(denied(
                    "File observation belongs to another original source authority",
                ));
            }
            return Ok(SourceDispatch::FileObservation {
                address,
                request_id: p.request_id,
                action: p.action,
            });
        }
        "source.authority.inspect_read_scope" | "source.authority.close_read_scope" => storage
            .source_read_scope(
                serde_json::from_value(params)?,
                method == "source.authority.close_read_scope",
                epoch,
                host,
            )?,
        "source.integration.receipt" => {
            storage.source_integration_receipt(serde_json::from_value(params)?)?
        }
        "source.authority.handoff" => {
            storage.inspect_source_handoff(&serde_json::from_value(params)?, epoch)?
        }
        "source.authority.claim_handoff" => storage.claim_source_handoff(
            serde_json::from_value(params)?,
            epoch,
            host,
            generation,
        )?,
        "source.capabilities" => capabilities(serde_json::from_value(params)?)?,
        "source.authority.open" => {
            storage.source_authority_open(serde_json::from_value(params)?, epoch, host)?
        }
        "source.authority.bind" => {
            storage.source_authority_bind(serde_json::from_value(params)?, epoch, host)?
        }
        "source.authority.seal" => {
            storage.seal_source_authority(&serde_json::from_value(params)?, epoch)?
        }
        "source.mcp.delivery" => {
            storage.source_mcp_delivery(serde_json::from_value(params)?, epoch)?
        }
        "source.mcp.holder" => {
            storage.source_mcp_holder(serde_json::from_value(params)?, epoch)?
        }
        "source.mcp.derivation" => {
            return storage.source_mcp_derivation(serde_json::from_value(params)?, epoch);
        }
        "source.mcp.child" => {
            return storage.source_mcp_child(serde_json::from_value(params)?, epoch);
        }
        "source.schedule.receipt" => {
            return storage.source_schedule_receipt(serde_json::from_value(params)?, epoch);
        }
        "source.mcp.creation_receipt" => {
            return storage.source_mcp_creation_receipt(serde_json::from_value(params)?, epoch);
        }
        "source.authority.inspect" => serde_json::to_value(
            storage
                .source_authority(&serde_json::from_value(params)?, false, epoch)?
                .result,
        )?,
        "source.authority.inspect_scope" => {
            storage.inspect_source_scope(serde_json::from_value(params)?)?
        }
        "source.authority.release" => {
            let p: SourceAuthorityReleaseParams = serde_json::from_value(params)?;
            storage.release_source_authority(
                &SourceAuthorityAddress {
                    principal_id: p.principal_id,
                    coordinator_host_id: p.coordinator_host_id,
                    authority_id: p.authority_id,
                    resource_epoch: p.resource_epoch,
                },
                &p.mode,
                host,
                epoch,
            )?
        }
        "source.authority.release_scope" => {
            storage.release_source_scope(serde_json::from_value(params)?, epoch, host)?
        }
        "source.resource.release" => {
            let p: SourceResourceControlParams = serde_json::from_value(params)?;
            let address = SourceAuthorityAddress {
                principal_id: p.principal_id, coordinator_host_id: p.coordinator_host_id,
                authority_id: p.authority_id, resource_epoch: p.resource_epoch,
            };
            match storage.release_source_schedule(&address, &p.operation_id, epoch)? {
                Some(value) => value,
                None => storage.release_source_read(&address, &p.operation_id, epoch)?,
            }
        }
        "source.resource.observe" | "source.resource.cancel" => {
            let p: SourceResourceControlParams = serde_json::from_value(params)?;
            let address = SourceAuthorityAddress {
                principal_id: p.principal_id,
                coordinator_host_id: p.coordinator_host_id,
                authority_id: p.authority_id,
                resource_epoch: p.resource_epoch,
            };
            let record = storage.source_authority(&address, false, epoch)?;
            if let Some(receipt) = storage.recall_source_schedule(&record, &p.operation_id, method == "source.resource.cancel")? {
                return Ok(receipt);
            }
            if let Some(read) = storage.recall_source_read(&record, &p.operation_id)? {
                return Ok(SourceDispatch::ReadObserve(read));
            }
            if let Some((record, native, interaction)) =
                storage.source_interaction_receipt(&address, &p.operation_id, epoch)?
            {
                return Ok(SourceDispatch::InteractionObserve {
                    record,
                    native,
                    address: interaction,
                });
            }
            storage.observe_source_operation(
                &address,
                &p.operation_id,
                epoch,
                method == "source.resource.cancel",
            )?
        }
        "source.resource.authorize" | "source.resource.execute" => {
            let input: SourceResourceCallParams = serde_json::from_value(params)?;
            let record = storage.source_authority(&address(&input), true, epoch)?;
            if record.result.phase != "ready" || matches!(record.purpose.as_str(), "result" | "process_view" | "script_environment" | "mcp_owner") {
                return Err(denied("Source does not admit model tools"));
            }
            let authorize = method == "source.resource.authorize";
            let read = if !authorize && crate::tools::managed_read_receipt_tool(&input.call.name) {
                match storage.prepare_source_read(&record, &input)? {
                    Some(read) => Some(read),
                    None => {
                        return if let Some(read) =
                            storage.recall_source_read(&record, &input.call.operation_id)?
                        {
                            Ok(SourceDispatch::ReadObserve(read))
                        } else {
                            Ok(SourceDispatch::Ready(storage.observe_source_operation(
                                &address(&input),
                                &input.call.operation_id,
                                epoch,
                                false,
                            )?))
                        };
                    }
                }
            } else {
                None
            };
            return Ok(SourceDispatch::Tool {
                record,
                input,
                authorize,
                read,
            });
        }
        "source.service.call" => {
            let p: SourceServiceCallParams = serde_json::from_value(params.clone())?;
            authorize_service_capabilities(&p)?;
            if let SourceServiceOperation::NativeResource {
                context,
                action,
                authorize_only,
            } = p.operation
            {
                let address = SourceAuthorityAddress {
                    principal_id: p.principal_id,
                    coordinator_host_id: p.coordinator_host_id,
                    authority_id: p.authority_id,
                    resource_epoch: p.resource_epoch,
                };
                let record = storage.source_authority(&address, true, epoch)?;
                if record.purpose == "mcp_owner" { return Err(denied("MCP owner only admits its dedicated process pipe")); }
                if record.purpose == "process_view" { return Err(denied("Process view only admits its original process projection")); }
                if record.purpose == "script_environment" && !matches!(&action, SourceResourceAction::ProcessObservation { process_id, .. } if record.operation_id.as_deref() == Some(process_id.as_str())) {
                    return Err(denied("Script authority only observes its original evaluator process"));
                }
                if record.purpose == "result"
                    && !matches!(action, SourceResourceAction::ChildStorageReceipt { .. })
                {
                    return Err(denied(
                        "Result authority only recalls original child receipts",
                    ));
                }
                return Ok(SourceDispatch::Resource {
                    record,
                    address,
                    request_id: p.request_id,
                    context,
                    action,
                    authorize: authorize_only,
                });
            }
            storage.source_service(p, epoch)?
        }
        _ => return Err(denied("Unknown closed source request")),
    };
    Ok(SourceDispatch::Ready(value))
}
