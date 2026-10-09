//! Worker-friendly native agent execution. Providers, policies and tools run outside Catalog locks.
//!
//! A worker owns one engine invocation. Its cloneable cancellation control has no dependency on
//! persistence or the data stream. Adapters must observe that control during blocking I/O. This
//! module never retries a dispatched model request or an ambiguous external effect.

use crate::types::{Effect, Lifetime, Outcome, RunState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};

#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize, PartialEq, Eq)]
#[error("{code}: {message}")]
pub struct ExecutionError {
    pub code: String,
    pub message: String,
}
impl ExecutionError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Cancellation is a control fact, not a synthetic tool-effect receipt.
#[derive(Debug, Default)]
struct CancellationState {
    cancelled: Arc<AtomicBool>,
    changed: tokio::sync::Notify,
    cancel_wakes: std::sync::Mutex<BTreeMap<u64, mpsc::SyncSender<()>>>,
    next_cancel_wake: AtomicU64,
    children:
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Weak<CancellationState>>>,
}
#[derive(Debug, Clone, Default)]
pub struct CancellationToken(Arc<CancellationState>);
#[must_use = "keep the registration alive until the wait ends"]
pub struct CancellationRegistration {
    state: std::sync::Weak<CancellationState>,
    id: u64,
}
impl Drop for CancellationRegistration {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            state.cancel_wakes.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.id);
        }
    }
}
impl CancellationToken {
    pub fn cancel(&self) {
        let mut pending = vec![self.0.clone()];
        while let Some(state) = pending.pop() {
            state.cancelled.store(true, Ordering::Release);
            state.changed.notify_waiters();
            for (_, wake) in std::mem::take(&mut *state.cancel_wakes.lock().unwrap_or_else(|p| p.into_inner())) { let _ = wake.try_send(()); }
            let children = state
                .children
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            pending.extend(children.values().filter_map(std::sync::Weak::upgrade));
        }
    }
    /// Keep the returned registration alive while waiting. Cancellation coalesces with
    /// other control notifications without retaining completed callers on long-lived tokens.
    pub fn wake_on_cancel(&self, wake: mpsc::SyncSender<()>) -> CancellationRegistration {
        let mut wakes = self.0.cancel_wakes.lock().unwrap_or_else(|p| p.into_inner());
        let id = self.0.next_cancel_wake.fetch_add(1, Ordering::Relaxed);
        if self.is_cancelled() { let _ = wake.try_send(()); } else { wakes.insert(id, wake); }
        CancellationRegistration { state: Arc::downgrade(&self.0), id }
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }
    pub fn shared_flag(&self) -> Arc<AtomicBool> {
        self.0.cancelled.clone()
    }
    pub fn child(&self, identity: &str) -> Self {
        let mut children = self
            .0
            .children
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(child) = children.get(identity).and_then(std::sync::Weak::upgrade) {
            return Self(child);
        }
        children.retain(|_, child| child.strong_count() > 0);
        let child = Self::default();
        children.insert(identity.into(), Arc::downgrade(&child.0));
        if self.is_cancelled() {
            child.cancel();
        }
        child
    }
    pub(crate) fn alias_child(&self, identity: &str, child: &Self) {
        self.0.children.lock().unwrap_or_else(|p|p.into_inner()).insert(identity.into(), Arc::downgrade(&child.0));
        if self.is_cancelled() { child.cancel(); }
    }
    pub fn cancel_children_with_prefix(&self, prefix: &str) -> bool {
        let children: Vec<_> = self
            .0
            .children
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .iter()
            .filter(|(id, _)| id.starts_with(prefix))
            .filter_map(|(_, child)| child.upgrade())
            .collect();
        let found = !children.is_empty();
        for child in children {
            Self(child).cancel();
        }
        found
    }
    pub fn cancel_child(&self, identity: &str) -> bool {
        let child = self
            .0
            .children
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(identity)
            .and_then(std::sync::Weak::upgrade);
        if let Some(child) = child {
            Self(child).cancel();
            true
        } else {
            false
        }
    }
    pub async fn cancelled(&self) {
        loop {
            let notified = self.0.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Provenance {
    SystemInstruction { source: String },
    UserInstruction { input_id: String },
    Assistant,
    ToolData { call_id: String },
    ExternalData { source: String },
    AgentMessage { thread_id: String },
    EnvironmentFact { event_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpaqueProviderItem {
    #[serde(default)]
    pub connection_identity: String,
    pub family: String,
    pub adapter_version: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Content {
    Text {
        text: String,
    },
    ReasoningSummary {
        text: String,
    },
    Attachment {
        media_type: String,
        content_ref: String,
        source: String,
    },
    ToolCall {
        call: ToolCall,
    },
    ToolResult {
        result: ToolResult,
    },
    /// Opaque reasoning, signatures, server-side tool exchanges and continuation identifiers.
    ProviderOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConversationItem {
    pub id: String,
    pub provenance: Provenance,
    pub content: Content,
    pub opaque: Option<OpaqueProviderItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolSchema {
    pub name: String,
    pub version: String,
    pub schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryRange {
    pub branch_id: String,
    pub ancestor_id: Option<String>,
    pub leaf_id: Option<String>,
}

/// No keys, tokens, or authorization headers belong in a request snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestBinding {
    #[serde(default)]
    pub connection_identity: String,
    pub provider_family: String,
    pub model: String,
    pub credential_ref: Option<String>,
    pub configuration_generation: u64,
    pub tool_schema_generation: u64,
    pub tools: Vec<ToolSchema>,
    pub instruction_sources: Vec<String>,
    pub memory_checkpoint: Option<String>,
    pub attachment_refs: Vec<String>,
    pub environment_cursor: u64,
    pub history_range: HistoryRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestView {
    pub request_id: String,
    pub run_id: String,
    pub origin: RequestOrigin,
    pub binding: RequestBinding,
    pub history: Vec<ConversationItem>,
}

/// Explicit request identity: auxiliary work never masquerades as a conversation ModelStep.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestOrigin {
    Conversation { step: u64, history_range: HistoryRange },
    PolicyModelJob { action_id: String, purpose: String, boundary_id: String },
}

/// The provider receives an immutable reference to the exact durably prepared request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestSnapshot {
    pub view: RequestView,
    pub serialized: Value,
}

/// Semantic history is portable; opaque continuation items are confined to their protocol family.
/// Multimodal input must be handled or rejected by the adapter's `serialize`, never dropped here.
pub fn compile_history(
    history: &[ConversationItem],
    family: &str,
    connection_identity: &str,
) -> Vec<ConversationItem> {
    history
        .iter()
        .filter_map(|item| {
            let mut item = item.clone();
            if item.opaque.as_ref().is_some_and(|opaque| {
                opaque.family != family
                    || opaque.connection_identity.is_empty()
                    || opaque.connection_identity != connection_identity
            }) {
                item.opaque = None;
            }
            if matches!(item.content, Content::ProviderOnly) && item.opaque.is_none() {
                None
            } else {
                Some(item)
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageMeasurement {
    #[default]
    Missing,
    Estimated,
    Actual,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageReceipt {
    pub measurement: UsageMeasurement,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning_tokens: Option<u64>,
    /// Original usage fields for audit/repricing, never inferred as zero on interruption.
    #[serde(default)]
    pub raw: Option<Value>,
    pub pricing_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderItem {
    pub id: String,
    pub content: Content,
    pub opaque: Option<OpaqueProviderItem>,
}

/// Provider IDs are local to one ModelStep. Internal history keys are an injective,
/// deterministic tuple of the globally owned request ID and the unmodified provider ID.
/// Length-prefixing the request makes delimiters inside either component unambiguous.
/// Opaque originals and the durable ProviderItem record retain provider-native IDs verbatim.
pub(crate) fn model_history_item(request_id: &str, item: &ProviderItem) -> ConversationItem {
    ConversationItem {
        id: format!("model-item:{}:{}:{}", request_id.len(), request_id, item.id),
        provenance: Provenance::Assistant,
        content: item.content.clone(),
        opaque: item.opaque.clone(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderEvent {
    TextDelta { item_id: String, text: String },
    ToolArgumentsDelta { call_id: String, delta: String },
    ItemCompleted { item: ProviderItem },
    Usage { receipt: UsageReceipt },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelFailure {
    pub code: String,
    pub message: String,
    pub retry_after_ms: Option<u64>,
    pub provider_request_id: Option<String>,
}

pub trait ModelProvider: Send + Sync {
    fn policy_model_capabilities(&self) -> Vec<PolicyModelCapability> { Vec::new() }
    fn policy_model_capability(&self, _id: &str) -> Option<BoundPolicyModel> { None }

    /// Serialize and validate the semantic view. Reject unsupported attachment kinds explicitly.
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError>;
    /// Implementations must cooperate with cancellation, including while awaiting the network.
    /// Deltas are presentation candidates. Only ItemCompleted can register a complete tool call.
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub schema_version: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Read,
    Write,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceClaim {
    /// Canonical conflict key resolved by the trusted executor, not model-supplied text.
    pub key: String,
    pub access: Access,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionKind {
    Result,
    Job,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolContract {
    pub name: String,
    pub schema_version: String,
    pub read_only: bool,
    pub completion: CompletionKind,
    pub lifetime: Lifetime,
    pub resources: Vec<ResourceClaim>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolCompletion {
    /// Executor evidence that no external request or side effect was sent.
    NotDispatched { reason: String },
    Result {
        outcome: Outcome,
        effect: Effect,
        content: Value,
    },
    /// This closes a model tool exchange with real acceptance; it does not claim job completion.
    JobAccepted {
        operation_id: String,
        phase: String,
        effect: Effect,
        lifetime: Lifetime,
    },
}
impl ToolCompletion {
    fn cancelled() -> Self {
        Self::Result {
            outcome: Outcome::Cancelled,
            effect: Effect::None,
            content: serde_json::json!({"error": "cancelled_before_dispatch"}),
        }
    }
    fn failure(code: &str, message: &str, effect: Effect) -> Self {
        Self::Result {
            outcome: if effect == Effect::Unknown {
                Outcome::Indeterminate
            } else {
                Outcome::Failed
            },
            effect,
            content: serde_json::json!({"error":code, "message":message}),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolResult {
    pub request_id: String,
    pub call_id: String,
    pub completion: ToolCompletion,
}

/// Stable identity supplied by the runtime; effectful adapters must use it for executor receipts.
/// Read-only queries share the identity convention without requiring a durable operation row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolExecutionContext {
    pub run_id: String,
    pub origin: ToolOrigin,
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolOrigin {
    ModelStep { request_id: String },
    PolicyAction { action_id: String, node_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenToolContext {
    pub run_id: String,
    pub origin: ToolOrigin,
    pub tool_schema_generation: u64,
    pub tools: Vec<ToolSchema>,
    pub source: Option<crate::catalog::launches::SourceSelection>,
}
#[path = "policy_actions.rs"]
pub mod policy_actions;
pub use policy_actions::*;
#[path = "policy_model.rs"]
pub mod policy_model;
pub use policy_model::*;

pub trait ToolExecutor: Send + Sync {
    /// Load classification comes only from the bound trusted capability. Wrappers must forward
    /// calls they do not own. This does not grant permission or classify external annotations.
    fn execution_class(&self, _: &ToolCall, _: &ToolContract) -> crate::execution_capacity::ExecutionClass {
        crate::execution_capacity::ExecutionClass::Unmetered
    }

    /// Retain the capability owner's revocation control while queued. No I/O or preparation.
    fn watch_admission(&self, _: &ToolExecutionContext, _: &ToolCall, _: &ToolContract, _: &CancellationToken)
        -> Result<Option<crate::execution_capacity::AdmissionControlGuard>, ExecutionError> { Ok(None) }

    /// Trusted implementation opt-in, never inferred from untrusted MCP annotations.
    fn supports_policy_read(&self, _: &FrozenToolContext, _: &ToolCall, _: &ToolContract) -> bool { false }

    /// Resolve an already-bound schema/contract and a pure canonical resource plan.
    /// This must not start a service, refresh credentials, wait for permissions or send effects.
    /// Slow capability preparation belongs to the individual execution, outside batch planning.
    fn prepare(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
    ) -> Result<ToolContract, ExecutionError>;
    /// Re-check permission at dispatch, so revocation is not delayed by a frozen model schema.
    /// Validate the *complete* argument value against the frozen schema before returning Ok.
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError>;
    /// Report the actual effect even after cancellation. Never replay unknown effects here.
    fn execute(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolCompletion;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdmittedTool {
    pub call: ToolCall,
    pub contract: ToolContract,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelOutcome {
    Completed,
    Interrupted,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionRecord {
    StateChanged {
        state: RunState,
        waiting_on: Option<String>,
    },
    RequestPrepared {
        snapshot: RequestSnapshot,
    },
    ModelDispatched {
        request_id: String,
    },
    ModelFinished {
        request_id: String,
        outcome: ModelOutcome,
        finish_reason: Option<FinishReason>,
        items: Vec<ProviderItem>,
        interrupted_deltas: Vec<ProviderEvent>,
        usage: UsageReceipt,
        failure: Option<ModelFailure>,
    },
    /// Atomic batch intent precedes all side effects. Read-only calls need no per-stage operation.
    ToolsAdmitted {
        request_id: String,
        tools: Vec<AdmittedTool>,
    },
    ToolDispatched {
        request_id: String,
        call_id: String,
    },
    ToolSettled {
        result: ToolResult,
    },
    /// Ordered, complete pairing is committed before another model request can observe results.
    ToolBatchCommitted {
        request_id: String,
        results: Vec<ToolResult>,
    },
    PolicyCheckpoint {
        identity: PolicyIdentity,
        state: Value,
        action: PolicyAction,
    },
}

/// Implement each callback with short atomic writes and an owner-generation fence.
/// Never retain a transaction or lock after return. Error means no new work may be dispatched.
#[derive(Debug, Clone)]
pub struct ContextProjection {
    pub checkpoint_id: String,
    pub history: Vec<ConversationItem>,
    pub instruction_sources: Vec<String>,
    pub memory_checkpoint: Option<String>,
}

pub trait Persistence: Send + Sync {
    /// Native Catalog overrides this with its actual parent/child lineage and execution fence.
    fn task_family(&self, run: &str, _epoch: u64) -> Result<String, ExecutionError> { Ok(run.into()) }

    fn policy_model_job(&self, _run: &str, _epoch: u64) -> Result<Option<PolicyModelState>, ExecutionError> { Ok(None) }
    fn admit_policy_model(&self, _run: &str, _epoch: u64, _intent: &PolicyModelIntent, _snapshot: &RequestSnapshot) -> Result<PolicyModelState, ExecutionError> { Err(ExecutionError::new("policy_model_unavailable", "durable model job authority required")) }
    fn dispatch_policy_model(&self, _run: &str, _epoch: u64, _action: &str) -> Result<(), ExecutionError> { Err(ExecutionError::new("policy_model_unavailable", "durable model job authority required")) }
    fn record_policy_model(&self, _run: &str, _epoch: u64, _action: &str, _output: &PolicyModelOutput, _receipt: Option<&PolicyModelReceipt>) -> Result<(), ExecutionError> { Err(ExecutionError::new("policy_model_unavailable", "durable model job authority required")) }

    fn policy_boundary(&self, _run: &str, _epoch: u64) -> Result<PolicyBoundary, ExecutionError> { Err(ExecutionError::new("policy_graph_unavailable", "durable policy action authority required")) }
    fn policy_graph(&self, _run: &str, _epoch: u64) -> Result<Option<PolicyGraphState>, ExecutionError> { Ok(None) }
    fn admit_policy_graph(&self, _run: &str, _epoch: u64, _intent: &PolicyGraphIntent) -> Result<PolicyGraphState, ExecutionError> { Err(ExecutionError::new("policy_graph_unavailable", "durable graph authority required")) }
    fn settle_policy_node(&self, _run: &str, _epoch: u64, _action: &str, _node: &str, _completion: &ToolCompletion) -> Result<PolicyNodeReceipt, ExecutionError> { Err(ExecutionError::new("policy_graph_unavailable", "durable graph authority required")) }
    fn policy_evidence(&self, _run: &str, _epoch: u64, _reference: &PolicyEvidenceRef) -> Result<ConversationItem, ExecutionError> { Err(ExecutionError::new("policy_graph_unavailable", "durable graph authority required")) }
    fn policy_chunk(&self, _run: &str, _epoch: u64, _reference: &PolicyEvidenceRef, _index: usize) -> Result<crate::content::ContentChunk, ExecutionError> { Err(ExecutionError::new("policy_graph_unavailable", "durable graph authority required")) }
    fn tool_source(&self, _run: &str) -> Result<Option<crate::catalog::launches::SourceSelection>, ExecutionError> { Ok(None) }

    /// All engines sharing one durable authority must share its admission owner.
    fn resource_admission(&self) -> Option<Arc<crate::resource_admission::ResourceAdmission>> { None }

    fn compile_context(
        &self,
        run_id: &str,
        owner_generation: u64,
        expected_head: Option<&str>,
    ) -> Result<Option<ContextProjection>, ExecutionError>;

    fn consume_inputs(
        &self,
        run_id: &str,
        owner_generation: u64,
        expected_head: Option<&str>,
    ) -> Result<Vec<ConversationItem>, ExecutionError>;

    fn commit(
        &self,
        run_id: &str,
        owner_generation: u64,
        record: &ExecutionRecord,
    ) -> Result<(), ExecutionError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ExecutionEvent {
    Provider(ProviderEvent),
    ToolCompleted(ToolResult),
}

/// A lossy bounded presentation stream. Its consumer runs independently from the engine.
/// Durable completion facts are always available from Persistence, even if progress is dropped.
#[derive(Debug, Clone)]
pub struct ProgressUpdate {
    pub sequence: u64,
    pub run_id: String,
    pub event: ExecutionEvent,
}

#[derive(Debug, Clone, Default)]
pub struct ProgressSink {
    sequence: Arc<AtomicU64>,
    sender: Option<mpsc::SyncSender<ProgressUpdate>>,
}
impl ProgressSink {
    pub fn channel(capacity: usize) -> (Self, mpsc::Receiver<ProgressUpdate>) {
        let (sender, receiver) = mpsc::sync_channel(capacity);
        (
            Self {
                sequence: Arc::new(AtomicU64::new(0)),
                sender: Some(sender),
            },
            receiver,
        )
    }

    fn emit(&self, run_id: &str, event: ExecutionEvent) {
        if let Some(sender) = &self.sender {
            // Full and disconnected observers both lose transient updates, never block execution.
            let _ = sender.try_send(ProgressUpdate {
                sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
                run_id: run_id.into(),
                event,
            });
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyIdentity {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PolicyAction {
    RequestModel,
    RequestModelWithEvidence { evidence: Vec<PolicyEvidenceRef> },
    RequestModelJob { capability_id: String, instructions: Vec<String>, evidence: Vec<PolicyEvidenceRef> },
    ReadGraph { nodes: Vec<PolicyReadNode> },
    ReadResult { reference: PolicyEvidenceRef, index: usize },
    ExecuteTools,
    /// Persistence must verify that this wait references a durably registered event condition.
    Wait {
        wait_id: String,
    },
    Complete,
    Fail {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyDecision {
    pub action: PolicyAction,
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PolicyEvent {
    InputDelivered {
        input_ids: Vec<String>,
    },
    Started,
    ReadGraphCompleted { action_id: String, receipts: Vec<PolicyNodeReceipt> },
    ModelJobCompleted { action_id: String, receipt: PolicyModelReceipt },
    ResultChunk { reference: PolicyEvidenceRef, index: usize, total_chunks: usize, total_bytes: u64, bytes: Vec<u8> },
    ModelCompleted {
        reason: FinishReason,
        tool_calls: usize,
    },
    ToolsCompleted {
        results: Vec<ToolResult>,
    },
}

pub struct PolicyView<'a> {
    pub run_id: &'a str,
    pub state: RunState,
    pub history: &'a [ConversationItem],
    pub pending_tool_calls: usize,
    pub model_capabilities: Vec<PolicyModelAvailability>,
}

/// Policy computes a quick decision. Slow planning belongs in an explicit model/tool operation.
/// Its versioned private checkpoint never replaces the core's history or provider originals.
pub trait AgentPolicy: Send + Sync {
    fn identity(&self) -> PolicyIdentity;
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError>;
}

#[derive(Default)]
pub struct DefaultAgentPolicy;
impl AgentPolicy for DefaultAgentPolicy {
    fn identity(&self) -> PolicyIdentity {
        PolicyIdentity {
            name: "default".into(),
            version: "1".into(),
        }
    }
    fn decide(
        &self,
        _view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        if cancel.is_cancelled() { return Err(ExecutionError::new("policy_cancelled", "policy cancelled")); }
        let action = match event {
            PolicyEvent::Started | PolicyEvent::InputDelivered{..} => PolicyAction::RequestModel,
            PolicyEvent::ModelCompleted { tool_calls, .. } if *tool_calls > 0 => PolicyAction::ExecuteTools,
            PolicyEvent::ModelCompleted { reason: FinishReason::Stop, .. } => PolicyAction::Complete,
            PolicyEvent::ModelCompleted { .. } => PolicyAction::Fail { reason: "model ended without a complete answer".into() },
            PolicyEvent::ToolsCompleted { results } if results.iter().any(|result|
                matches!(result.completion, ToolCompletion::Result { outcome: Outcome::Indeterminate, .. })) =>
                PolicyAction::Fail { reason: "tool effect is indeterminate; reconcile the original operation before continuing".into() },
            PolicyEvent::ToolsCompleted { .. } | PolicyEvent::ModelJobCompleted { .. } | PolicyEvent::ReadGraphCompleted { .. } | PolicyEvent::ResultChunk { .. } => PolicyAction::RequestModel,
        };
        Ok(PolicyDecision {
            action,
            state: state.clone(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct ExecutionInput {
    pub run_id: String,
    pub owner_generation: u64,
    pub binding: RequestBinding,
    pub history: Vec<ConversationItem>,
    pub policy_state: Value,
    /// Number already committed in this run, supplied by the durable resume path.
    pub completed_model_steps: u64,
}

#[derive(Debug, Clone)]
pub struct ExecutionReport {
    pub state: RunState,
    pub history: Vec<ConversationItem>,
    pub policy_state: Value,
    pub model_steps: u64,
    pub waiting_on: Option<String>,
    pub failure: Option<ExecutionError>,
}

pub struct ExecutionEngine<P: ?Sized, M: ?Sized, T: ?Sized, A: ?Sized> {
    pub persistence: Arc<P>,
    pub provider: Arc<M>,
    pub tools: Arc<T>,
    pub policy: Arc<A>,
    pub progress: ProgressSink,
}

impl<
        P: Persistence + ?Sized,
        M: ModelProvider + ?Sized,
        T: ToolExecutor + ?Sized,
        A: AgentPolicy + ?Sized,
    > ExecutionEngine<P, M, T, A>
{
    /// Run on a worker, never a Catalog/control thread. The input must identify an admitted run.
    /// Re-entering with an old run is rejected by Persistence's durable request/epoch checks.
    pub fn run(
        &self,
        input: ExecutionInput,
        cancel: CancellationToken,
    ) -> Result<ExecutionReport, ExecutionError> {
        self.run_recovered(input, cancel, None)
    }
    pub fn run_recovered(
        &self,
        input: ExecutionInput,
        cancel: CancellationToken,
        recovery: Option<crate::catalog::recovery::ExecutionRecovery>,
    ) -> Result<ExecutionReport, ExecutionError> {
        if input.binding.connection_identity.is_empty() {
            return Err(ExecutionError::new(
                "connection_identity_required",
                "model continuation requires a trusted connection identity",
            ));
        }
        let mut state = RunState::Runnable;
        self.commit(
            &input,
            ExecutionRecord::StateChanged {
                state,
                waiting_on: None,
            },
        )?;
        let mut history = input.history.clone();
        let mut history_cursor = input
            .binding
            .history_range
            .leaf_id
            .clone()
            .or_else(|| history.last().map(|item| item.id.clone()));
        let mut policy_state = input.policy_state.clone();
        let (mut event, mut pending, mut recovered_results, mut recovered_decision) = match recovery
        {
            Some(recovery) => (
                recovery.event,
                recovery.pending,
                recovery.receipts,
                recovery.decision,
            ),
            None => (PolicyEvent::Started, None, BTreeMap::new(), None),
        };
        if pending.is_none() {
            recovered_results.clear();
        }
        let resumed_graph = self.persistence.policy_graph(&input.run_id,input.owner_generation)?;
        if pending.is_some() && resumed_graph.as_ref().is_some_and(|graph|!graph.terminal) { return Err(ExecutionError::new("unclosed_model_exchange","policy graph conflicts with model exchange")); }
        if let Some(graph)=resumed_graph {
            recovered_decision=graph.decision.clone();
            event=self.execute_read_graph(&input,graph,&cancel)?;
        }
        if let Some(job) = self.persistence.policy_model_job(&input.run_id,input.owner_generation)? {
            if pending.is_some() { return Err(ExecutionError::new("unclosed_model_exchange","model job conflicts with model exchange")); }
            recovered_decision = job.decision.clone();
            event = self.execute_model_job(&input, job, &cancel)?;
        }
        let mut steps = input.completed_model_steps;
        let mut interrupted_generation = false;
        macro_rules! finish {
            ($label:lifetime,$next:expr,$waiting:expr,$failure:expr)=>{{
                let next:RunState=$next;let waiting_on:Option<String>=$waiting;let failure:Option<ExecutionError>=$failure;
                match self.commit(&input,ExecutionRecord::StateChanged{state:next,waiting_on:waiting_on.clone()}) {
                    Err(error) if error.code=="input_pending"=>continue $label,
                    Err(error)=>return Err(error),
                    Ok(())=>return Ok(ExecutionReport{state:next,history,policy_state,model_steps:steps,waiting_on,failure}),
                }
            }};
        }
        'agent: loop {
            if cancel.is_cancelled() {
                if let Some((snapshot, calls)) = pending.take() {
                    self.close_unexecuted_batch(
                        &input,
                        &snapshot,
                        calls,
                        &mut history,
                        &recovered_results,
                        ToolCompletion::cancelled(),
                    )?;
                    history_cursor = history.last().map(|item| item.id.clone());
                }
                finish!('agent, RunState::Cancelled, None, None);
            }
            if pending.is_none() {
                let incoming = self.persistence.consume_inputs(
                    &input.run_id,
                    input.owner_generation,
                    history_cursor.as_deref(),
                )?;
                if incoming.is_empty() && interrupted_generation {
                    finish!('agent,RunState::Cancelled,None,None);
                }
                if !incoming.is_empty() {
                    let input_ids = incoming
                        .iter()
                        .filter_map(|item| match &item.provenance {
                            Provenance::UserInstruction { input_id } => Some(input_id.clone()),
                            _ => None,
                        })
                        .collect();
                    history_cursor = incoming
                        .last()
                        .map(|item| item.id.clone())
                        .or(history_cursor);
                    history.extend(incoming);
                    event = PolicyEvent::InputDelivered { input_ids };
                    recovered_decision = None;
                    interrupted_generation = false;
                    if state != RunState::Runnable {
                        state = RunState::Runnable;
                        self.commit(
                            &input,
                            ExecutionRecord::StateChanged {
                                state,
                                waiting_on: None,
                            },
                        )?;
                    }
                }
            }
            let view = PolicyView {
                run_id: &input.run_id,
                state,
                history: &history,
                pending_tool_calls: pending.as_ref().map_or(0, |(_, calls)| calls.len()),
                model_capabilities: self.provider.policy_model_capabilities().iter().map(PolicyModelAvailability::from).collect(),
            };
            let decision = match recovered_decision.take().map(Ok).unwrap_or_else(|| {
                guarded("policy_panicked", || {
                    self.policy.decide(&view, &event, &policy_state, &cancel)
                })
            }) {
                Ok(decision) => decision,
                Err(error) => {
                    if cancel.is_cancelled() { continue 'agent; }
                    if let Some((snapshot, calls)) = pending.take() {
                        self.close_unexecuted_batch(
                            &input,
                            &snapshot,
                            calls,
                            &mut history,
                            &recovered_results,
                            ToolCompletion::failure(&error.code, &error.message, Effect::None),
                        )?;
                        history_cursor = history.last().map(|item| item.id.clone());
                    }
                    finish!('agent, RunState::Failed, None, Some(error));
                }
            };
            if cancel.is_cancelled() { continue 'agent; }
            // A policy can neither fabricate a closed exchange nor bypass the tool admission path.
            let legal = match &decision.action {
                PolicyAction::ExecuteTools => pending.is_some(),
                PolicyAction::RequestModel | PolicyAction::RequestModelJob { .. } | PolicyAction::RequestModelWithEvidence { .. } | PolicyAction::ReadGraph { .. } | PolicyAction::ReadResult { .. } | PolicyAction::Complete | PolicyAction::Wait { .. } => {
                    pending.is_none()
                }
                PolicyAction::Fail { .. } => pending.is_none(),
            };
            if !legal {
                if let Some((snapshot, calls)) = pending.take() {
                    self.close_unexecuted_batch(
                        &input,
                        &snapshot,
                        calls,
                        &mut history,
                        &recovered_results,
                        ToolCompletion::failure(
                            "illegal_policy_action",
                            "policy did not execute the registered tool batch",
                            Effect::None,
                        ),
                    )?;
                    history_cursor = history.last().map(|item| item.id.clone());
                }
                finish!('agent, RunState::Failed, None,
                    Some(ExecutionError::new("illegal_policy_action", "unclosed tool exchange or no tools to execute")));
            }
            if !matches!(decision.action,PolicyAction::ReadGraph{..}|PolicyAction::RequestModelJob{..}) { self.commit(
                &input,
                ExecutionRecord::PolicyCheckpoint {
                    identity: self.policy.identity(),
                    state: decision.state.clone(),
                    action: decision.action.clone(),
                },
            )?; }
            let previous_policy_state = std::mem::replace(&mut policy_state, decision.state);
            match decision.action {
                PolicyAction::Complete => finish!('agent, RunState::Completed, None, None),
                PolicyAction::Fail { reason } => finish!('agent, RunState::Failed, None,
                    Some(ExecutionError::new("policy_failed", reason))),
                PolicyAction::Wait { wait_id } => {
                    if wait_id.is_empty() {
                        finish!('agent, RunState::Failed, None,
                            Some(ExecutionError::new("invalid_wait", "a wait needs a registered identity")));
                    }
                    finish!('agent, RunState::Waiting, Some(wait_id), None);
                }
                PolicyAction::RequestModelJob { capability_id, instructions, evidence } => {
                    let job = match self.admit_model_job(&input, &history, history_cursor.as_deref(), capability_id, instructions, evidence, policy_state.clone()) {
                        Ok(job) => job,
                        Err(error) if error.code == "input_pending" => { policy_state = previous_policy_state; continue 'agent; },
                        Err(error) => { policy_state = previous_policy_state; finish!('agent,RunState::Failed,None,Some(error)); }
                    };
                    event = self.execute_model_job(&input, job, &cancel)?;
                }
                PolicyAction::ReadGraph { nodes } => {
                    let graph=match self.admit_read_graph(&input,nodes,policy_state.clone()) {Ok(graph)=>graph,Err(error) if error.code=="input_pending"=>{policy_state=previous_policy_state;continue 'agent},Err(error)=>{policy_state=previous_policy_state;finish!('agent,RunState::Failed,None,Some(error))}};
                    event=self.execute_read_graph(&input,graph,&cancel)?;
                }
                PolicyAction::ReadResult { reference,index } => {
                    let chunk=match self.persistence.policy_chunk(&input.run_id,input.owner_generation,&reference,index) {Ok(chunk)=>chunk,Err(error)=>finish!('agent,RunState::Failed,None,Some(error))};
                    event=PolicyEvent::ResultChunk{reference,index,total_chunks:chunk.chunk_count,total_bytes:chunk.total_bytes,bytes:chunk.bytes};
                }
                action @ (PolicyAction::RequestModel | PolicyAction::RequestModelWithEvidence { .. }) => {
                    let evidence=match action {PolicyAction::RequestModelWithEvidence{evidence}=>evidence,_=>Vec::new()};
                    steps = steps.checked_add(1).ok_or_else(|| {
                        ExecutionError::new("step_overflow", "model step identity exhausted")
                    })?;
                    let mut binding = input.binding.clone();
                    if let Some(context) = self.persistence.compile_context(
                        &input.run_id,
                        input.owner_generation,
                        history_cursor.as_deref(),
                    )? {
                        history = context.history;
                        binding.instruction_sources = context.instruction_sources;
                        binding.memory_checkpoint = context.memory_checkpoint;
                    }
                    if let Err(error) = validate_history_pairs(&history) {
                        finish!('agent, RunState::Failed, None, Some(error));
                    }
                    binding.history_range.leaf_id = history_cursor.clone();
                    let mut request_history=compile_history(&history,&input.binding.provider_family,&input.binding.connection_identity);
                    let mut selected=BTreeSet::new();
                    for reference in evidence {
                        if !selected.insert((reference.action_id.clone(),reference.node_id.clone())) { finish!('agent,RunState::Failed,None,Some(ExecutionError::new("duplicate_evidence","evidence references must be unique"))); }
                        let item=match self.persistence.policy_evidence(&input.run_id,input.owner_generation,&reference){Ok(item)=>item,Err(error)=>finish!('agent,RunState::Failed,None,Some(error))};
                        request_history.push(item);
                    }
                    let view = RequestView {
                        request_id: format!(
                            "{}:{}:{}",
                            input.run_id, input.owner_generation, steps
                        ),
                        run_id: input.run_id.clone(),
                        origin: RequestOrigin::Conversation { step: steps, history_range: binding.history_range.clone() },
                        binding,
                        history: request_history,
                    };
                    let model_cancel = cancel.child(&format!("model:{}", view.request_id));
                    let serialized = match guarded("provider_serialize_panicked", || {
                        self.provider.serialize(&view)
                    }) {
                        Ok(serialized) => serialized,
                        Err(error) => finish!('agent, RunState::Failed, None, Some(error)),
                    };
                    let snapshot = RequestSnapshot { view, serialized };
                    match self.commit(
                        &input,
                        ExecutionRecord::RequestPrepared {
                            snapshot: snapshot.clone(),
                        },
                    ) {
                        Ok(()) => {}
                        Err(error)
                            if error.code == "input_pending" || model_cancel.is_cancelled() =>
                        {
                            steps -= 1;
                            continue 'agent;
                        }
                        Err(error) => return Err(error),
                    }
                    if model_cancel.is_cancelled() {
                        interrupted_generation = !cancel.is_cancelled();
                        self.commit(
                            &input,
                            ExecutionRecord::ModelFinished {
                                request_id: snapshot.view.request_id.clone(),
                                outcome: if interrupted_generation {
                                    ModelOutcome::Interrupted
                                } else {
                                    ModelOutcome::Cancelled
                                },
                                finish_reason: None,
                                items: vec![],
                                interrupted_deltas: vec![],
                                usage: UsageReceipt::default(),
                                failure: None,
                            },
                        )?;
                        continue;
                    }
                    state = RunState::Generating;
                    self.commit(
                        &input,
                        ExecutionRecord::StateChanged {
                            state,
                            waiting_on: None,
                        },
                    )?;
                    match self.commit(
                        &input,
                        ExecutionRecord::ModelDispatched {
                            request_id: snapshot.view.request_id.clone(),
                        },
                    ) {
                        Ok(()) => {}
                        Err(error)
                            if error.code == "input_pending" || model_cancel.is_cancelled() =>
                        {
                            interrupted_generation = !cancel.is_cancelled();
                            self.commit(
                                &input,
                                ExecutionRecord::ModelFinished {
                                    request_id: snapshot.view.request_id.clone(),
                                    outcome: if interrupted_generation {
                                        ModelOutcome::Interrupted
                                    } else {
                                        ModelOutcome::Cancelled
                                    },
                                    finish_reason: None,
                                    items: vec![],
                                    interrupted_deltas: vec![],
                                    usage: UsageReceipt::default(),
                                    failure: None,
                                },
                            )?;
                            continue 'agent;
                        }
                        Err(error) => return Err(error),
                    }
                    let (items, deltas, usage, mut result) =
                        self.generate(&input.run_id, &snapshot, &model_cancel);
                    let cancelled = cancel.is_cancelled();
                    let interrupted = model_cancel.is_cancelled() && !cancelled;
                    let mut calls = Vec::new();
                    if let Ok(reason) = result {
                        let validation =
                            validate_model_items(&items, &snapshot).and_then(|validated| {
                                if (reason == FinishReason::ToolCalls) != !validated.is_empty() {
                                    Err(ExecutionError::new(
                                        "invalid_model_exchange",
                                        "finish reason and complete tool calls disagree",
                                    ))
                                } else {
                                    Ok(validated)
                                }
                            });
                        match validation {
                            Ok(validated) => calls = validated,
                            Err(error) => {
                                result = Err(ModelFailure {
                                    code: error.code,
                                    message: error.message,
                                    retry_after_ms: None,
                                    provider_request_id: None,
                                })
                            }
                        }
                    }
                    let outcome = if cancelled {
                        ModelOutcome::Cancelled
                    } else if interrupted {
                        ModelOutcome::Interrupted
                    } else if result.is_ok() {
                        ModelOutcome::Completed
                    } else if items.is_empty() && deltas.is_empty() {
                        ModelOutcome::Failed
                    } else {
                        ModelOutcome::Interrupted
                    };
                    self.commit(
                        &input,
                        ExecutionRecord::ModelFinished {
                            request_id: snapshot.view.request_id.clone(),
                            outcome,
                            finish_reason: result.as_ref().ok().copied(),
                            items: items.clone(),
                            interrupted_deltas: if result.is_err() || cancelled || interrupted {
                                deltas
                            } else {
                                vec![]
                            },
                            usage,
                            failure: result.as_ref().err().cloned(),
                        },
                    )?;
                    if cancelled {
                        continue;
                    }
                    if interrupted {
                        interrupted_generation = true;
                        continue;
                    }
                    let reason = match result {
                        Ok(reason) => reason,
                        Err(failure) => finish!('agent, RunState::Failed, None,
                            Some(ExecutionError::new(failure.code, failure.message))),
                    };
                    let committed: Vec<_> = items.iter()
                        .map(|item| model_history_item(&snapshot.view.request_id, item)).collect();
                    history_cursor = committed.last().map(|item| item.id.clone()).or(history_cursor);
                    history.extend(committed);
                    event = PolicyEvent::ModelCompleted {
                        reason,
                        tool_calls: calls.len(),
                    };
                    if !calls.is_empty() {
                        pending = Some((snapshot, calls));
                    }
                }
                PolicyAction::ExecuteTools => {
                    let (snapshot, calls) = pending.take().expect("validated policy action");
                    state = RunState::Executing;
                    self.commit(
                        &input,
                        ExecutionRecord::StateChanged {
                            state,
                            waiting_on: None,
                        },
                    )?;
                    let results =
                        self.execute_batch(&input, &snapshot, calls, &cancel, &recovered_results)?;
                    recovered_results.clear();
                    self.commit(
                        &input,
                        ExecutionRecord::ToolBatchCommitted {
                            request_id: snapshot.view.request_id.clone(),
                            results: results.clone(),
                        },
                    )?;
                    history_cursor = results
                        .last()
                        .map(|result| format!("{}:result:{}", result.request_id, result.call_id))
                        .or(history_cursor);
                    for result in &results {
                        history.push(ConversationItem {
                            id: format!("{}:result:{}", result.request_id, result.call_id),
                            provenance: Provenance::ToolData {
                                call_id: result.call_id.clone(),
                            },
                            content: Content::ToolResult {
                                result: result.clone(),
                            },
                            opaque: None,
                        });
                    }
                    state = RunState::Runnable;
                    self.commit(
                        &input,
                        ExecutionRecord::StateChanged {
                            state,
                            waiting_on: None,
                        },
                    )?;
                    event = PolicyEvent::ToolsCompleted { results };
                }
            }
        }
    }

    fn commit(
        &self,
        input: &ExecutionInput,
        record: ExecutionRecord,
    ) -> Result<(), ExecutionError> {
        self.persistence
            .commit(&input.run_id, input.owner_generation, &record)
    }

    fn close_unexecuted_batch(
        &self,
        input: &ExecutionInput,
        snapshot: &RequestSnapshot,
        calls: Vec<ToolCall>,
        history: &mut Vec<ConversationItem>,
        cached: &BTreeMap<String, ToolResult>,
        completion: ToolCompletion,
    ) -> Result<(), ExecutionError> {
        let results: Vec<_> = calls
            .into_iter()
            .map(|call| {
                cached
                    .get(&call.call_id)
                    .cloned()
                    .unwrap_or_else(|| ToolResult {
                        request_id: snapshot.view.request_id.clone(),
                        call_id: call.call_id,
                        completion: completion.clone(),
                    })
            })
            .collect();
        self.commit(
            input,
            ExecutionRecord::ToolBatchCommitted {
                request_id: snapshot.view.request_id.clone(),
                results: results.clone(),
            },
        )?;
        for result in results {
            history.push(ConversationItem {
                id: format!("{}:result:{}", result.request_id, result.call_id),
                provenance: Provenance::ToolData {
                    call_id: result.call_id.clone(),
                },
                content: Content::ToolResult { result },
                opaque: None,
            });
        }
        Ok(())
    }

    fn generate(
        &self,
        run_id: &str,
        snapshot: &RequestSnapshot,
        cancel: &CancellationToken,
    ) -> (
        Vec<ProviderItem>,
        Vec<ProviderEvent>,
        UsageReceipt,
        Result<FinishReason, ModelFailure>,
    ) {
        let mut items = Vec::new();
        let mut deltas = Vec::new();
        let mut usage = UsageReceipt::default();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.provider.generate(snapshot, cancel, &mut |event| {
                if cancel.is_cancelled() && !matches!(event, ProviderEvent::Usage { .. }) {
                    return Err(ExecutionError::new(
                        "cancelled",
                        "model generation cancelled",
                    ));
                }
                match &event {
                    ProviderEvent::ItemCompleted { item } => items.push(item.clone()),
                    ProviderEvent::Usage { receipt } => usage = receipt.clone(),
                    ProviderEvent::TextDelta { .. } | ProviderEvent::ToolArgumentsDelta { .. } => {
                        deltas.push(event.clone())
                    }
                }
                self.progress.emit(run_id, ExecutionEvent::Provider(event));
                Ok(())
            })
        }))
        .unwrap_or_else(|_| {
            Err(ModelFailure {
                code: "provider_panicked".into(),
                message: "provider worker panicked after dispatch".into(),
                retry_after_ms: None,
                provider_request_id: None,
            })
        });
        (items, deltas, usage, result)
    }

    fn execute_batch(
        &self,
        input: &ExecutionInput,
        snapshot: &RequestSnapshot,
        calls: Vec<ToolCall>,
        cancel: &CancellationToken,
        cached: &BTreeMap<String, ToolResult>,
    ) -> Result<Vec<ToolResult>, ExecutionError> {
        let mut admitted = Vec::new();
        let mut rejected = BTreeMap::new();
        // All contracts are resolved first; no effect can begin while the graph is still being built.
        for (index, call) in calls.iter().enumerate() {
            if cached.contains_key(&call.call_id) {
                continue;
            }
            match guarded("tool_prepare_panicked", || {
                self.tools.prepare(call, &FrozenToolContext { run_id: input.run_id.clone(), origin: ToolOrigin::ModelStep { request_id: snapshot.view.request_id.clone() }, tools: snapshot.view.binding.tools.clone(), tool_schema_generation: snapshot.view.binding.tool_schema_generation, source: self.persistence.tool_source(&input.run_id)? })
            }) {
                Ok(contract)
                    if contract.name == call.name
                        && contract.schema_version == call.schema_version =>
                {
                    admitted.push((
                        index,
                        AdmittedTool {
                            call: call.clone(),
                            contract,
                        },
                    ));
                }
                Ok(_) => {
                    rejected.insert(
                        index,
                        ToolCompletion::failure(
                            "contract_mismatch",
                            "resolved tool differs from frozen schema",
                            Effect::None,
                        ),
                    );
                }
                Err(error) => {
                    rejected.insert(
                        index,
                        ToolCompletion::failure(&error.code, &error.message, Effect::None),
                    );
                }
            }
        }
        // Register and retain every accepted call's control handle before publishing admission.
        // A resource-queued call can be cancelled without waiting until execute_one starts.
        let _operation_tokens: Vec<_> = admitted
            .iter()
            .map(|(_, tool)| {
                cancel.child(&format!(
                    "{}:tool:{}",
                    snapshot.view.request_id, tool.call.call_id
                ))
            })
            .collect();
        self.commit(
            input,
            ExecutionRecord::ToolsAdmitted {
                request_id: snapshot.view.request_id.clone(),
                tools: admitted.iter().map(|(_, tool)| tool.clone()).collect(),
            },
        )?;
        let mut results: Vec<Option<ToolResult>> = calls
            .iter()
            .map(|call| cached.get(&call.call_id).cloned())
            .collect();
        for (index, completion) in rejected {
            let result = ToolResult {
                request_id: snapshot.view.request_id.clone(),
                call_id: calls[index].call_id.clone(),
                completion,
            };
            self.progress
                .emit(&input.run_id, ExecutionEvent::ToolCompleted(result.clone()));
            results[index] = Some(result);
        }
        let mut started = BTreeSet::new();
        let mut finished = BTreeSet::new();
        let mut persistence_failure = None;
        // Each completion releases only its actual dependencies; an unrelated slow tool is no barrier.
        std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel();
            let mut running = 0;
            while finished.len() < admitted.len() {
                for (position, (index, tool)) in admitted.iter().enumerate() {
                    if started.contains(&position) {
                        continue;
                    }
                    let blocked = admitted[..position].iter().enumerate().any(
                        |(earlier, (_, predecessor))| {
                            !finished.contains(&earlier)
                                && contracts_conflict(&predecessor.contract, &tool.contract)
                        },
                    );
                    if blocked {
                        continue;
                    }
                    started.insert(position);
                    running += 1;
                    let tx = tx.clone();
                    let cancel = cancel.clone();
                    let stop_dispatch = persistence_failure.is_some();
                    scope.spawn(move || {
                        let result = if stop_dispatch {
                            Err(ExecutionError::new(
                                "persistence_failed",
                                "dispatch stopped after a failed durable receipt",
                            ))
                        } else {
                            guarded("tool_worker_panicked", || {
                                self.execute_one(input, snapshot, tool, &cancel)
                            })
                        };
                        let _ = tx.send((position, *index, result));
                    });
                }
                if running == 0 {
                    break;
                }
                let (position, index, result) = rx
                    .recv()
                    .expect("tool workers retain their completion sender");
                running -= 1;
                finished.insert(position);
                match result {
                    Ok(result) => {
                        results[index] = Some(result);
                    }
                    Err(error) => {
                        if persistence_failure.is_none() {
                            persistence_failure = Some(error);
                        }
                    }
                }
            }
        });
        if let Some(error) = persistence_failure {
            return Err(error);
        }
        results
            .into_iter()
            .map(|result| {
                result.ok_or_else(|| {
                    ExecutionError::new("incomplete_tool_batch", "a tool result was not settled")
                })
            })
            .collect()
    }

    fn execute_one(
        &self,
        input: &ExecutionInput,
        snapshot: &RequestSnapshot,
        tool: &AdmittedTool,
        cancel: &CancellationToken,
    ) -> Result<ToolResult, ExecutionError> {
        let context = ToolExecutionContext {
            run_id: input.run_id.clone(),
            origin: ToolOrigin::ModelStep { request_id: snapshot.view.request_id.clone() },
            operation_id: format!("{}:tool:{}", snapshot.view.request_id, tool.call.call_id),
        };
        let operation_cancel = cancel.child(&context.operation_id);
        let cancel = &operation_cancel;
        let mut lease = None;
        let mut _admission_control = None;
        let completion = if cancel.is_cancelled() {
            ToolCompletion::cancelled()
        } else if let Err(error) = guarded("tool_authorize_panicked", || {
            self.tools
                .authorize(&context, &tool.call, &tool.contract, cancel)
        }) {
            ToolCompletion::failure(&error.code, &error.message, Effect::None)
        } else if cancel.is_cancelled() {
            ToolCompletion::cancelled()
        } else {
            _admission_control = self.tools.watch_admission(&context, &tool.call, &tool.contract, cancel)?;
            if let Some(admission) = self.persistence.resource_admission() {
                let family_id = self.persistence.task_family(&input.run_id, input.owner_generation)?;
                let identity = crate::execution_capacity::AdmissionIdentity {
                    run_id: input.run_id.clone(), owner_generation: input.owner_generation,
                    origin: context.origin.clone(), family_id,
                };
                lease = admission.acquire_scheduled(&context.operation_id, &tool.contract.resources,
                    &identity, self.tools.execution_class(&tool.call, &tool.contract), cancel)?;
                if lease.is_none() {
                    return self.settle_tool(input, tool, ToolResult {
                        request_id: snapshot.view.request_id.clone(),
                        call_id: tool.call.call_id.clone(),
                        completion: ToolCompletion::cancelled(),
                    });
                }
            }
            if cancel.is_cancelled() {
                return self.settle_tool(input, tool, ToolResult {
                    request_id: snapshot.view.request_id.clone(), call_id: tool.call.call_id.clone(),
                    completion: ToolCompletion::cancelled(),
                });
            }
            // A queued call can outlive authorization or its Run generation. Recheck only at
            // the actual dispatch boundary, outside both Catalog and admission locks.
            if let Err(error) = self.persistence.task_family(&input.run_id, input.owner_generation)
                .and_then(|_| guarded("tool_authorize_panicked", || self.tools.authorize(&context, &tool.call, &tool.contract, cancel))) {
                return self.settle_tool(input, tool, ToolResult {
                    request_id: snapshot.view.request_id.clone(), call_id: tool.call.call_id.clone(),
                    completion: ToolCompletion::NotDispatched { reason: format!("{}: {}", error.code, error.message) },
                });
            }
            if !tool.contract.read_only || tool.contract.completion == CompletionKind::Job {
                self.commit(
                    input,
                    ExecutionRecord::ToolDispatched {
                        request_id: snapshot.view.request_id.clone(),
                        call_id: tool.call.call_id.clone(),
                    },
                )?;
                if let Some(lease) = lease.as_mut() { lease.dispatched(); }
            }
            // Only this operation's resource plan is held; no catalog or tool-environment mutex.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.tools
                    .execute(&context, &tool.call, &tool.contract, cancel)
            }));
            match result {
                Ok(completion) => normalize_completion(completion, &tool.contract),
                Err(_) => ToolCompletion::failure(
                    "tool_panicked",
                    "tool worker stopped without a receipt",
                    if tool.contract.read_only {
                        Effect::None
                    } else {
                        Effect::Unknown
                    },
                ),
            }
        };
        let result = ToolResult {
            request_id: snapshot.view.request_id.clone(),
            call_id: tool.call.call_id.clone(),
            completion,
        };
        let settled = self.settle_tool(input, tool, result);
        // Catalog settlement releases synchronous occupancy atomically after its durable receipt.
        // Background jobs and a failed durable receipt remain owned until executor reconciliation.
        if let Some(lease) = lease {
            if settled.is_err() || matches!(settled.as_ref().map(|r| &r.completion),
                Ok(ToolCompletion::JobAccepted { .. }) | Ok(ToolCompletion::Result { effect: Effect::Unknown, .. })
            ) && tool.contract.completion == CompletionKind::Job { lease.handoff(); }
            else { lease.release(); }
        }
        settled
    }

    fn settle_tool(&self, input: &ExecutionInput, tool: &AdmittedTool, result: ToolResult) -> Result<ToolResult, ExecutionError> {
        if !tool.contract.read_only || tool.contract.completion == CompletionKind::Job {
            self.commit(input, ExecutionRecord::ToolSettled { result: result.clone() })?;
        }
        self.progress
            .emit(&input.run_id, ExecutionEvent::ToolCompleted(result.clone()));
        Ok(result)
    }
}

fn guarded<T>(
    code: &str,
    operation: impl FnOnce() -> Result<T, ExecutionError>,
) -> Result<T, ExecutionError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)).unwrap_or_else(|_| {
        Err(ExecutionError::new(
            code,
            "adapter stopped without a receipt",
        ))
    })
}

fn validate_model_items(
    items: &[ProviderItem],
    snapshot: &RequestSnapshot,
) -> Result<Vec<ToolCall>, ExecutionError> {
    // Provider IDs must be unique within this response, not across independent requests.
    let mut item_ids = BTreeSet::new();
    let mut call_ids = BTreeSet::new();
    let mut calls = Vec::new();
    for item in items {
        if item.id.is_empty() || !item_ids.insert(&item.id) {
            return Err(ExecutionError::new(
                "invalid_provider_item",
                "provider item identity is empty or duplicated",
            ));
        }
        if item.opaque.as_ref().is_some_and(|opaque| {
            opaque.family != snapshot.view.binding.provider_family
                || opaque.connection_identity != snapshot.view.binding.connection_identity
                || opaque.connection_identity.is_empty()
        }) {
            return Err(ExecutionError::new(
                "provider_family_mismatch",
                "provider original belongs to a different family",
            ));
        }
        match &item.content {
            Content::ToolCall { call } => {
                if call.call_id.is_empty() || !call_ids.insert(&call.call_id) {
                    return Err(ExecutionError::new(
                        "invalid_tool_call",
                        "tool call identity is empty or duplicated",
                    ));
                }
                if !snapshot
                    .view
                    .binding
                    .tools
                    .iter()
                    .any(|schema| schema.name == call.name && schema.version == call.schema_version)
                {
                    return Err(ExecutionError::new(
                        "unknown_tool_schema",
                        "tool call was not present in the frozen schema generation",
                    ));
                }
                calls.push(call.clone());
            }
            Content::ToolResult { .. } => {
                return Err(ExecutionError::new(
                    "invalid_provider_item",
                    "a model cannot author a tool result",
                ))
            }
            Content::ProviderOnly if item.opaque.is_none() => {
                return Err(ExecutionError::new(
                    "invalid_provider_item",
                    "provider-only item lacks its original",
                ))
            }
            _ => {}
        }
    }
    Ok(calls)
}

fn contracts_conflict(a: &ToolContract, b: &ToolContract) -> bool {
    a.resources.iter().any(|left| {
        b.resources.iter().any(|right| {
            left.key == right.key && (left.access == Access::Write || right.access == Access::Write)
        })
    })
}

fn normalize_completion(completion: ToolCompletion, contract: &ToolContract) -> ToolCompletion {
    match completion {
        ToolCompletion::JobAccepted {
            operation_id,
            phase,
            effect,
            lifetime,
        } if contract.completion == CompletionKind::Job
            && !operation_id.is_empty()
            && !phase.is_empty()
            && lifetime == contract.lifetime
            && matches!(lifetime, Lifetime::Thread | Lifetime::Environment) =>
        {
            ToolCompletion::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
            }
        }
        ToolCompletion::JobAccepted { effect, .. } => ToolCompletion::failure(
            "invalid_job_receipt",
            "tool did not return an authorized independent job identity and lifetime",
            if contract.read_only && effect == Effect::None {
                Effect::None
            } else {
                Effect::Unknown
            },
        ),
        ToolCompletion::Result {
            effect: Effect::None,
            content,
            ..
        } if !contract.read_only => ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            content,
        },
        ToolCompletion::Result {
            outcome: _,
            effect: Effect::Unknown,
            content,
        } => ToolCompletion::Result {
            outcome: Outcome::Indeterminate,
            effect: Effect::Unknown,
            content,
        },
        result => result,
    }
}

pub(crate) fn validate_history_pairs(history: &[ConversationItem]) -> Result<(), ExecutionError> {
    let mut pending = BTreeSet::new();
    let mut returning_results = false;
    for item in history {
        match &item.content {
            Content::ToolCall { call } => {
                if returning_results
                    || !matches!(item.provenance, Provenance::Assistant)
                    || !pending.insert(call.call_id.clone())
                {
                    return Err(ExecutionError::new(
                        "invalid_history_pairing",
                        "tool calls must form one assistant batch",
                    ));
                }
            }
            Content::ToolResult { result } => {
                if !matches!(&item.provenance, Provenance::ToolData { call_id } if call_id == &result.call_id)
                    || !pending.remove(&result.call_id)
                {
                    return Err(ExecutionError::new(
                        "invalid_history_pairing",
                        "tool result lacks a matching call and provenance",
                    ));
                }
                returning_results = !pending.is_empty();
            }
            _ if !pending.is_empty()
                && (returning_results || !matches!(item.provenance, Provenance::Assistant)) =>
            {
                return Err(ExecutionError::new(
                    "invalid_history_pairing",
                    "content interrupts an unclosed tool exchange",
                ));
            }
            _ => {}
        }
    }
    if pending.is_empty() {
        Ok(())
    } else {
        Err(ExecutionError::new(
            "invalid_history_pairing",
            "history ends in an unclosed tool exchange",
        ))
    }
}

#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
