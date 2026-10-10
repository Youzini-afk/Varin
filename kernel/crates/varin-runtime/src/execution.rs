//! Worker-friendly agent execution. Providers, policies and tools run outside Catalog locks.
//!
//! A worker owns one engine invocation. Its cloneable cancellation control has no dependency on
//! persistence or the data stream. Adapters must observe that control during blocking I/O. This
//! module never retries a dispatched model request or an ambiguous external effect.

use crate::types::{Effect, ExecutorOwner, Lifetime, Outcome, RunState};
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
            state
                .cancel_wakes
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&self.id);
        }
    }
}
impl CancellationToken {
    pub fn cancel(&self) {
        let mut pending = vec![self.0.clone()];
        while let Some(state) = pending.pop() {
            state.cancelled.store(true, Ordering::Release);
            state.changed.notify_waiters();
            for (_, wake) in
                std::mem::take(&mut *state.cancel_wakes.lock().unwrap_or_else(|p| p.into_inner()))
            {
                let _ = wake.try_send(());
            }
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
        let mut wakes = self
            .0
            .cancel_wakes
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let id = self.0.next_cancel_wake.fetch_add(1, Ordering::Relaxed);
        if self.is_cancelled() {
            let _ = wake.try_send(());
        } else {
            wakes.insert(id, wake);
        }
        CancellationRegistration {
            state: Arc::downgrade(&self.0),
            id,
        }
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
        self.0
            .children
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(identity.into(), Arc::downgrade(&child.0));
        if self.is_cancelled() {
            child.cancel();
        }
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
    SystemInstruction {
        source: String,
    },
    GoalInstruction { goal_id:String, generation:u64 },
    UserInstruction {
        input_id: String,
    },
    Assistant,
    PolicyOutput {
        action_id: String,
        identity: PolicyIdentity,
    },
    ToolData {
        call_id: String,
    },
    PolicyToolData {
        reference: PolicyEvidenceRef,
    },
    ExternalData {
        source: String,
    },
    AgentMessage {
        thread_id: String,
    },
    EnvironmentFact {
        event_id: String,
    },
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_activation: Option<crate::catalog::resources::ResourceActivation>,
    pub id: String,
    pub provenance: Provenance,
    pub content: Content,
    pub opaque: Option<OpaqueProviderItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolSchema {
    pub name: String,
    pub version: String,
    pub description: String,
    pub schema: Value,
    pub output_schema: Option<Value>,
    pub metadata: Option<ToolMetadata>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolMetadata {
    pub service_id: String,
    pub service_version: u64,
    pub completion: RegisteredToolCompletion,
    pub operation: ToolOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ToolSourceLocation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolSourceLocation {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RegisteredToolCompletion {
    Result,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolOperation {
    Read,
    Effect,
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
    pub goal: Option<crate::catalog::goals::FrozenGoal>,
    pub resource_activations: Vec<crate::catalog::resources::ResourceActivation>,
    pub resource_checkpoint_id: Option<String>,
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
    Conversation {
        step: u64,
        history_range: HistoryRange,
    },
    PolicyModelJob {
        action_id: String,
        purpose: String,
        boundary_id: String,
    },
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
pub(crate) fn model_history_id(request_id: &str, item_id: &str) -> String {
    format!("model-item:{}:{}:{}", request_id.len(), request_id, item_id)
}
pub(crate) fn model_history_item(request_id: &str, item: &ProviderItem) -> ConversationItem {
    ConversationItem {
        resource_activation: None,
        id: model_history_id(request_id, &item.id),
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
    /// Called only at a closed conversation exchange, before compiling the next request.
    /// The returned provider is retained by that ModelStep; subsequent selection cannot mutate it.
    fn select_for_request(
        &self,
        _run_id: &str,
        _owner_generation: u64,
        _cancel: &CancellationToken,
    ) -> Result<Option<SelectedModel>, ExecutionError> {
        Ok(None)
    }
    fn policy_model_capabilities(&self) -> Vec<PolicyModelCapability> {
        Vec::new()
    }
    fn policy_model_capability(&self, _id: &str) -> Option<BoundPolicyModel> {
        None
    }

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

#[derive(Clone)]
pub struct SelectedModel {
    pub binding: RequestBinding,
    pub provider: Arc<dyn ModelProvider>,
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

/// A trusted bound on a resource plan that still needs owner-side identity resolution.
/// Prefixes name canonical resource namespaces, never unverified model paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceIntent {
    Exact(ResourceClaim),
    Prefix { key_prefix: String, access: Access },
}
impl ResourceIntent {
    pub fn access(&self) -> Access {
        match self {
            Self::Exact(claim) => claim.access,
            Self::Prefix { access, .. } => *access,
        }
    }
    pub fn covers(&self, claim: &ResourceClaim) -> bool {
        (self.access() == Access::Write || claim.access == Access::Read)
            && match self {
                Self::Exact(expected) => expected.key == claim.key,
                Self::Prefix { key_prefix, .. } => claim.key.starts_with(key_prefix),
            }
    }
    pub fn may_conflict_claim(&self, claim: &ResourceClaim) -> bool {
        (self.access() == Access::Write || claim.access == Access::Write)
            && match self {
                Self::Exact(expected) => expected.key == claim.key,
                Self::Prefix { key_prefix, .. } => claim.key.starts_with(key_prefix),
            }
    }
    pub fn may_conflict(&self, other: &Self) -> bool {
        if self.access() == Access::Read && other.access() == Access::Read {
            return false;
        }
        match (self, other) {
            (Self::Exact(left), Self::Exact(right)) => left.key == right.key,
            (Self::Exact(claim), Self::Prefix { key_prefix, .. })
            | (Self::Prefix { key_prefix, .. }, Self::Exact(claim)) => {
                claim.key.starts_with(key_prefix)
            }
            (
                Self::Prefix {
                    key_prefix: left, ..
                },
                Self::Prefix {
                    key_prefix: right, ..
                },
            ) => left.starts_with(right) || right.starts_with(left),
        }
    }
}

pub enum ToolPreparation {
    /// The complete canonical plan is available without I/O.
    Ready(ToolContract),
    /// Preparation runs independently. Every eventual claim must be covered by these intents.
    Resolve {
        resources: Vec<ResourceIntent>,
        class: crate::execution_capacity::ExecutionClass,
    },
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

/// Trusted executor evidence, never author-controlled tool output. A returned observation may
/// close the caller's exchange while the actual external execution is still unresolved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolExecutionReceipt {
    pub completion: ToolCompletion,
    pub executor_stopped: bool,
}
impl ToolExecutionReceipt {
    pub fn local(completion: ToolCompletion, contract: &ToolContract) -> Self {
        let executor_stopped = !matches!(&completion, ToolCompletion::JobAccepted { .. })
            && !(contract.completion == CompletionKind::Job
                && matches!(
                    &completion,
                    ToolCompletion::Result {
                        effect: Effect::Unknown,
                        ..
                    }
                ));
        Self {
            completion,
            executor_stopped,
        }
    }
    pub fn not_dispatched(reason: impl Into<String>) -> Self {
        Self {
            completion: ToolCompletion::NotDispatched {
                reason: reason.into(),
            },
            executor_stopped: true,
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
impl ToolOrigin {
    pub fn operation_id(&self, call_id: &str) -> String {
        match self {
            Self::ModelStep { request_id } => format!("{request_id}:tool:{call_id}"),
            Self::PolicyAction { action_id, node_id } => format!("{action_id}:node:{node_id}"),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenToolContext {
    pub resource_activations: Vec<crate::catalog::resources::ResourceActivation>,
    pub resource_checkpoint_id: Option<String>,
    pub run_id: String,
    pub origin: ToolOrigin,
    pub tool_schema_generation: u64,
    pub tools: Arc<Vec<ToolSchema>>,
    pub source: Option<crate::catalog::launches::SourceSelection>,
}
#[path = "policy_actions.rs"]
pub mod policy_actions;
pub use policy_actions::*;
#[path = "policy_model.rs"]
pub mod policy_model;
pub use policy_model::*;

/// A selected invocation. External arguments are decoded when this handle is created, and the
/// same implementation and typed input are retained through preparation, admission and dispatch.
pub trait PreparedToolCall: Send {
    fn executor_owner(&self) -> ExecutorOwner {
        ExecutorOwner::Kernel
    }
    fn plan(&self, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError>;
    fn prepare(&self, cancel: &CancellationToken) -> Result<ToolContract, ExecutionError>;
    fn execution_class(&self, contract: &ToolContract)
        -> crate::execution_capacity::ExecutionClass;
    fn watch_admission(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<Option<crate::execution_capacity::AdmissionControlGuard>, ExecutionError>;
    fn supports_policy_read(&self, contract: &ToolContract) -> bool;
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError>;
    fn execute(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt;
}

struct ExecutorCall<T: ?Sized> {
    executor: Arc<T>,
    call: ToolCall,
    context: FrozenToolContext,
}
impl<T: ToolExecutor + ?Sized> PreparedToolCall for ExecutorCall<T> {
    fn executor_owner(&self) -> ExecutorOwner {
        self.executor.executor_owner()
    }
    fn plan(&self, cancel: &CancellationToken) -> Result<ToolPreparation, ExecutionError> {
        self.executor.plan(&self.call, &self.context, cancel)
    }
    fn prepare(&self, cancel: &CancellationToken) -> Result<ToolContract, ExecutionError> {
        self.executor.prepare(&self.call, &self.context, cancel)
    }
    fn execution_class(
        &self,
        contract: &ToolContract,
    ) -> crate::execution_capacity::ExecutionClass {
        self.executor.execution_class(&self.call, contract)
    }
    fn watch_admission(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<Option<crate::execution_capacity::AdmissionControlGuard>, ExecutionError> {
        self.executor
            .watch_admission(context, &self.call, contract, cancel)
    }
    fn supports_policy_read(&self, contract: &ToolContract) -> bool {
        self.executor
            .supports_policy_read(&self.context, &self.call, contract)
    }
    fn authorize(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.executor
            .authorize(context, &self.call, contract, cancel)
    }
    fn execute(
        &self,
        context: &ToolExecutionContext,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        self.executor
            .execute_receipt(context, &self.call, contract, cancel)
    }
}

pub struct SelectedTools {
    pub generation: u64,
    pub schemas: Vec<ToolSchema>,
    pub executor: Arc<dyn ToolExecutor>,
}
pub trait ToolExecutor: Send + Sync + 'static {
    fn executor_owner(&self) -> ExecutorOwner {
        ExecutorOwner::Kernel
    }
    /// Local synchronous implementations provide their real return evidence here. External
    /// bridges override this method instead of treating a cancelled waiter as a stopped executor.
    fn execute_receipt(
        &self,
        context: &ToolExecutionContext,
        call: &ToolCall,
        contract: &ToolContract,
        cancel: &CancellationToken,
    ) -> ToolExecutionReceipt {
        ToolExecutionReceipt::local(self.execute(context, call, contract, cancel), contract)
    }
    /// Ready candidates may publish only here, at a closed ModelStep boundary. Each request
    /// retains the selected executor; preparing another candidate cannot change that exchange.
    fn select_for_request(
        &self,
        _: &str,
        _: u64,
        _: &CancellationToken,
    ) -> Result<Option<SelectedTools>, ExecutionError> {
        Ok(None)
    }
    /// Freeze before the model request is sent. A directory returns only the selected pins;
    /// simple typed adapters may use their already immutable instance directly.
    fn freeze(&self, _: &[ToolSchema]) -> Result<Option<Arc<dyn ToolExecutor>>, ExecutionError> {
        Ok(None)
    }
    fn bind_call(
        self: Arc<Self>,
        call: &ToolCall,
        context: &FrozenToolContext,
        _: &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError> {
        Ok(Box::new(ExecutorCall {
            executor: self,
            call: call.clone(),
            context: context.clone(),
        }))
    }
    /// Establish ordering before any owner lookup. This must be local and nonblocking: no I/O,
    /// service preparation, credentials or permission waits. Wrappers forward calls they do not own.
    fn plan(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        cancel: &CancellationToken,
    ) -> Result<ToolPreparation, ExecutionError>;

    /// Load classification comes only from the bound trusted capability. Wrappers must forward
    /// calls they do not own. This does not grant permission or classify external annotations.
    fn execution_class(
        &self,
        _: &ToolCall,
        _: &ToolContract,
    ) -> crate::execution_capacity::ExecutionClass {
        crate::execution_capacity::ExecutionClass::Unmetered
    }

    /// Retain the capability owner's revocation control while queued. No I/O or preparation.
    fn watch_admission(
        &self,
        _: &ToolExecutionContext,
        _: &ToolCall,
        _: &ToolContract,
        _: &CancellationToken,
    ) -> Result<Option<crate::execution_capacity::AdmissionControlGuard>, ExecutionError> {
        Ok(None)
    }

    /// Trusted implementation opt-in, never inferred from untrusted MCP annotations.
    fn supports_policy_read(&self, _: &FrozenToolContext, _: &ToolCall, _: &ToolContract) -> bool {
        false
    }

    /// Resolve an already-bound schema/contract and the complete canonical resource plan.
    /// Any resource-owner lookup must observe this call's cancellation.
    /// This must not start a service, refresh credentials, wait for permissions or send effects.
    /// Called independently for a Resolve plan; the core verifies its claims against the intent.
    /// Slow capability preparation belongs to the individual execution, outside this resource lookup.
    fn prepare(
        &self,
        call: &ToolCall,
        context: &FrozenToolContext,
        _cancel: &CancellationToken,
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

/// Public hydrated tool intent. Origin is durable and never reconstructed from an ID string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolInvocation {
    pub origin: ToolOrigin,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NonDispatchReason {
    Cancelled,
    InputPending,
    GoalChanged,
    Recovery,
    WorkerStopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionRecord {
    StateChanged {
        state: RunState,
        waiting_on: Option<String>,
    },
    ContextPreparationFailed {
        failure: ExecutionError,
    },
    RequestPrepared {
        snapshot: RequestSnapshot,
    },
    /// Positive nonexecution evidence, committed only from the original Prepared state.
    RequestNotDispatched {
        request_id: String,
        reason: NonDispatchReason,
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
    /// Each admitted effectful call's intent precedes its side effects. A record may contain one
    /// independently prepared call. Read-only results need no per-stage operation.
    ToolAdmitted {
        context: ToolExecutionContext,
        tool: AdmittedTool,
    },
    ToolDispatched {
        context: ToolExecutionContext,
        executor_owner: ExecutorOwner,
    },
    ToolSettled {
        context: ToolExecutionContext,
        completion: ToolCompletion,
        executor_stopped: bool,
    },
    /// Ordered, complete pairing is committed before another model request can observe results.
    ToolBatchCommitted {
        request_id: String,
        results: Vec<ToolResult>,
    },
    PolicyCheckpoint {
        identity: PolicyIdentity,
        previous_state: Value,
        state: Value,
        action: PolicyAction,
        event: PolicyEvent,
    },
    PolicyDecisionConsumed {
        event: PolicyEvent,
    },
}

/// Implement each callback with short atomic writes and an owner-generation fence.
/// Never retain a transaction or lock after return. Error means no new work may be dispatched.
#[derive(Debug, Clone)]
pub struct ContextProjection {
    pub resource_checkpoint_id: Option<String>,
    pub checkpoint_id: String,
    pub history: Vec<ConversationItem>,
    pub instruction_sources: Vec<String>,
    pub memory_checkpoint: Option<String>,
}

pub enum ToolResume {
    New,
    Admitted { cancel_requested: bool },
    Completed(crate::catalog::result_content::ToolCompletionRead),
}

pub trait Persistence: Send + Sync {
    fn goal_tool_allowed(&self,_c:&ToolExecutionContext)->Result<bool,ExecutionError>{Ok(true)}
    fn goal_context(&self,_run:&str,_epoch:u64)->Result<Option<crate::catalog::goals::GoalContext>,ExecutionError>{Ok(None)}
    fn goal_boundary(&self,_run:&str,_epoch:u64)->Result<crate::catalog::goals::GoalBoundary,ExecutionError>{Ok(crate::catalog::goals::GoalBoundary::Continue)}

    fn resume_tool(
        &self,
        _context: &ToolExecutionContext,
        _epoch: u64,
    ) -> Result<ToolResume, ExecutionError> {
        Err(ExecutionError::new(
            "policy_graph_unavailable",
            "canonical tool invocation authority required",
        ))
    }
    /// Only durable executor evidence may refine dispatched work to a no-effect result.
    /// Other persistence backends retain the conservative Unknown normalization.
    fn confirms_no_effect(
        &self,
        _context: &ToolExecutionContext,
        _epoch: u64,
        _completion: &ToolCompletion,
    ) -> Result<bool, ExecutionError> {
        Ok(false)
    }

    /// Catalog overrides this with its actual parent/child lineage and execution fence.
    fn task_family(&self, run: &str, _epoch: u64) -> Result<String, ExecutionError> {
        Ok(run.into())
    }

    fn policy_model_job(
        &self,
        _run: &str,
        _epoch: u64,
    ) -> Result<Option<PolicyModelState>, ExecutionError> {
        Ok(None)
    }
    fn admit_policy_model(
        &self,
        _run: &str,
        _epoch: u64,
        _intent: &PolicyModelIntent,
        _snapshot: &RequestSnapshot,
    ) -> Result<PolicyModelState, ExecutionError> {
        Err(ExecutionError::new(
            "policy_model_unavailable",
            "durable model job authority required",
        ))
    }
    fn dispatch_policy_model(
        &self,
        _run: &str,
        _epoch: u64,
        _action: &str,
    ) -> Result<(), ExecutionError> {
        Err(ExecutionError::new(
            "policy_model_unavailable",
            "durable model job authority required",
        ))
    }
    fn record_policy_model(
        &self,
        _run: &str,
        _epoch: u64,
        _action: &str,
        _output: &PolicyModelOutput,
        _receipt: Option<&PolicyModelReceipt>,
    ) -> Result<(), ExecutionError> {
        Err(ExecutionError::new(
            "policy_model_unavailable",
            "durable model job authority required",
        ))
    }

    /// Select the one latest durable action. Stores must explicitly implement recovery selection.
    fn policy_action(
        &self,
        run: &str,
        epoch: u64,
    ) -> Result<Option<PolicyActionState>, ExecutionError>;
    fn commit_policy_control(
        &self,
        _run: &str,
        _epoch: u64,
        _intent: &PolicyControlIntent,
    ) -> Result<PolicyControlReceipt, ExecutionError> {
        Err(ExecutionError::new(
            "policy_action_unavailable",
            "durable policy action authority required",
        ))
    }
    fn policy_boundary(&self, _run: &str, _epoch: u64) -> Result<PolicyBoundary, ExecutionError> {
        Err(ExecutionError::new(
            "policy_graph_unavailable",
            "durable policy action authority required",
        ))
    }
    fn policy_graph(
        &self,
        _run: &str,
        _epoch: u64,
    ) -> Result<Option<PolicyGraphState>, ExecutionError> {
        Ok(None)
    }
    fn admit_policy_graph(
        &self,
        _run: &str,
        _epoch: u64,
        _intent: &PolicyGraphIntent,
    ) -> Result<PolicyGraphState, ExecutionError> {
        Err(ExecutionError::new(
            "policy_graph_unavailable",
            "durable graph authority required",
        ))
    }
    fn settle_policy_node(
        &self,
        _run: &str,
        _epoch: u64,
        _action: &str,
        _node: &str,
        _completion: &ToolCompletion,
    ) -> Result<PolicyNodeReceipt, ExecutionError> {
        Err(ExecutionError::new(
            "policy_graph_unavailable",
            "durable graph authority required",
        ))
    }
    fn policy_evidence(
        &self,
        _run: &str,
        _epoch: u64,
        _reference: &PolicyEvidenceRef,
    ) -> Result<PolicyEvidence, ExecutionError> {
        Err(ExecutionError::new(
            "policy_graph_unavailable",
            "durable graph authority required",
        ))
    }
    fn policy_chunk(
        &self,
        _run: &str,
        _epoch: u64,
        _reference: &PolicyEvidenceRef,
        _index: usize,
    ) -> Result<crate::content::ContentChunk, ExecutionError> {
        Err(ExecutionError::new(
            "policy_graph_unavailable",
            "durable graph authority required",
        ))
    }
    fn tool_source(
        &self,
        _run: &str,
    ) -> Result<Option<crate::catalog::launches::SourceSelection>, ExecutionError> {
        Ok(None)
    }

    /// The durable authority owns and reuses one coordinator across every Run and policy call.
    /// Returning a newly allocated owner would split conflict ordering and execution capacity.
    fn resource_admission(&self) -> Arc<crate::resource_admission::ResourceAdmission>;

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
    RequestModelWithEvidence {
        evidence: Vec<PolicyEvidenceRef>,
    },
    RequestModelJob {
        capability_id: String,
        instructions: Vec<String>,
        evidence: Vec<PolicyEvidenceRef>,
    },
    ToolGraph {
        nodes: Vec<PolicyToolNode>,
    },
    ReadResult {
        reference: PolicyEvidenceRef,
        index: usize,
    },
    ExecuteTools,
    Deliver {
        text: String,
    },
    Pause {
        reason: String,
    },
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PolicyEvent {
    InputDelivered {
        input_ids: Vec<String>,
    },
    Started,
    Delivered {
        action_id: String,
        item_id: String,
    },
    Resumed {
        action_id: String,
        wait_id: String,
    },
    ToolGraphCompleted {
        action_id: String,
        receipts: Vec<PolicyNodeReceipt>,
    },
    ModelJobCompleted {
        action_id: String,
        receipt: PolicyModelReceipt,
    },
    ResultChunk {
        reference: PolicyEvidenceRef,
        index: usize,
        total_chunks: usize,
        total_bytes: u64,
        bytes: Vec<u8>,
    },
    ModelCompleted {
        reason: FinishReason,
        tool_calls: usize,
    },
    ToolsCompleted {
        results: Vec<ToolResult>,
    },
}

impl PolicyEvent {
    /// A domain Wait must not hide a strategy's failure response to a real execution receipt.
    pub fn has_execution_failure(&self) -> bool {
        match self {
            Self::ToolsCompleted { results } => results.iter().any(|result| match &result.completion {
                ToolCompletion::NotDispatched { .. } => true,
                ToolCompletion::Result { outcome, .. } => *outcome != Outcome::Succeeded,
                ToolCompletion::JobAccepted { .. } => false,
            }),
            Self::ToolGraphCompleted { receipts, .. } => receipts.iter().any(|receipt| receipt.outcome() != Outcome::Succeeded),
            Self::ModelJobCompleted { receipt, .. } => receipt.outcome != Outcome::Succeeded,
            _ => false,
        }
    }
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
    /// Only the Run worker calls this at a closed decision boundary. A candidate failure leaves
    /// the active binding untouched. Implementations publish through the same durable Catalog.
    fn select_for_decision(
        &self,
        _view: &PolicyView<'_>,
        _event: &PolicyEvent,
        _state: &Value,
        _owner_generation: u64,
        _cancel: &CancellationToken,
    ) -> Result<Option<Value>, ExecutionError> {
        Ok(None)
    }
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
        if cancel.is_cancelled() {
            return Err(ExecutionError::new("policy_cancelled", "policy cancelled"));
        }
        let action = match event {
            PolicyEvent::Started | PolicyEvent::InputDelivered{..} => PolicyAction::RequestModel,
            PolicyEvent::ModelCompleted { tool_calls, .. } if *tool_calls > 0 => PolicyAction::ExecuteTools,
            PolicyEvent::ModelCompleted { reason: FinishReason::Stop, .. } => PolicyAction::Complete,
            PolicyEvent::ModelCompleted { .. } => PolicyAction::Fail { reason: "model ended without a complete answer".into() },
            PolicyEvent::ToolsCompleted { results } if results.iter().any(|result|
                matches!(result.completion, ToolCompletion::Result { outcome: Outcome::Indeterminate, .. })) =>
                PolicyAction::Fail { reason: "tool effect is indeterminate; reconcile the original operation before continuing".into() },
            PolicyEvent::Delivered { .. } | PolicyEvent::Resumed { .. } | PolicyEvent::ToolsCompleted { .. } | PolicyEvent::ModelJobCompleted { .. } | PolicyEvent::ToolGraphCompleted { .. } | PolicyEvent::ResultChunk { .. } => PolicyAction::RequestModel,
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

/// Trusted context owner synchronization before a new request is frozen. This runs on
/// the Run worker, outside Catalog transactions; prepared snapshots never pass through it.
pub enum ContextRequestPreparation {
    Ready,
    Recompile,
    Waiting { wait_id: String },
}
pub trait ContextPreparation: Send + Sync {
    fn prepare(
        &self,
        run_id: &str,
        owner_generation: u64,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError>;
    /// Inspect the complete serialized candidate before admission. A successful checkpoint
    /// publication asks the engine to compile the same legal boundary again.
    fn prepare_request(
        &self,
        _owner_generation: u64,
        _view: &RequestView,
        _serialized: &Value,
        _cancel: &CancellationToken,
    ) -> Result<ContextRequestPreparation, ExecutionError> {
        Ok(ContextRequestPreparation::Ready)
    }
}
pub struct NoopContextPreparation;
impl ContextPreparation for NoopContextPreparation {
    fn prepare(&self, _: &str, _: u64, _: &CancellationToken) -> Result<(), ExecutionError> {
        Ok(())
    }
}

pub struct ExecutionEngine<P: ?Sized, M: ?Sized, T: ?Sized, A: ?Sized> {
    pub persistence: Arc<P>,
    pub context_preparation: Arc<dyn ContextPreparation>,
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
        mut input: ExecutionInput,
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
        let mut pending_tools = pending
            .as_ref()
            .map(|(snapshot, _)| self.tools.freeze(&snapshot.view.binding.tools))
            .transpose()?
            .flatten();
        let mut pending_model: Option<Arc<dyn ModelProvider>> = None;
        let mut control_state = matches!(
            event,
            PolicyEvent::Delivered { .. } | PolicyEvent::Resumed { .. }
        )
        .then(|| policy_state.clone());
        if let Some(action) = self
            .persistence
            .policy_action(&input.run_id, input.owner_generation)?
        {
            if pending.is_some() {
                return Err(ExecutionError::new(
                    "unclosed_model_exchange",
                    "policy action conflicts with model exchange",
                ));
            }
            match action {
                PolicyActionState::Graph(graph) => {
                    recovered_decision = graph.decision.clone();
                    event = self.execute_tool_graph(&input, graph, &cancel, None)?;
                }
                PolicyActionState::Model(job) => {
                    recovered_decision = job.decision.clone();
                    event = self.execute_model_job(&input, job, &cancel)?;
                }
                PolicyActionState::Control(control) => {
                    policy_state = control.state;
                    control_state = Some(policy_state.clone());
                    recovered_decision = control.decision;
                    event = control.event;
                }
            }
        }
        if matches!(&event,PolicyEvent::ModelJobCompleted{receipt,..} if receipt.failure.as_ref().is_some_and(|f|f.code=="goal_changed")) {
            event=PolicyEvent::Started;
            recovered_decision=None;
        }
        let mut steps = input.completed_model_steps;
        let mut interrupted_generation = false;
        macro_rules! finish {
            ($label:lifetime,$next:expr,$waiting:expr,$failure:expr $(,$rollback:expr)?)=>{{
                let next:RunState=$next;let waiting_on:Option<String>=$waiting;let failure:Option<ExecutionError>=$failure;
                match self.commit(&input,ExecutionRecord::StateChanged{state:next,waiting_on:waiting_on.clone()}) {
                    Err(error) if error.code=="input_pending"=>{ $(policy_state=$rollback;)? continue $label },
                    Err(error)=>return Err(error),
                    Ok(())=>return Ok(ExecutionReport{state:next,history,policy_state,model_steps:steps,waiting_on,failure}),
                }
            }};
        }
        macro_rules! fail_context_preparation {
            ($label:lifetime) => {{
                // Host errors can contain external content or credentials. Persist a
                // stable structural cause and a safe message, never the raw callback error.
                let failure = ExecutionError::new("context_preparation_failed", "Context preparation failed before a new model request was admitted");
                match self.commit(&input, ExecutionRecord::ContextPreparationFailed { failure: failure.clone() }) {
                    Err(error) if error.code == "input_pending" => continue $label,
                    Err(error) => return Err(error),
                    Ok(()) => return Ok(ExecutionReport { state: RunState::Failed, history, policy_state, model_steps: steps, waiting_on: None, failure: Some(failure) }),
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
                    if let Some(committed_state) = &control_state {
                        // The input is real history. It invalidates a not-yet-executed decision,
                        // not the original durable action's completion event or private state.
                        policy_state = committed_state.clone();
                    } else {
                        event = PolicyEvent::InputDelivered { input_ids };
                    }
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
            if pending.is_none() {
                match self.persistence.goal_boundary(&input.run_id,input.owner_generation)? {
                    crate::catalog::goals::GoalBoundary::Continue=>(),
                    crate::catalog::goals::GoalBoundary::Wait{wait_id}=>finish!('agent,RunState::Waiting,Some(wait_id),None),
                    crate::catalog::goals::GoalBoundary::Finish{state}=>finish!('agent,state,None,None),
                }
            }
            if pending.is_none() && recovered_decision.is_none() {
                let view = PolicyView {
                    run_id: &input.run_id,
                    state,
                    history: &history,
                    pending_tool_calls: 0,
                    model_capabilities: self
                        .provider
                        .policy_model_capabilities()
                        .iter()
                        .map(PolicyModelAvailability::from)
                        .collect(),
                };
                if let Some(selected_state) = self.policy.select_for_decision(
                    &view,
                    &event,
                    &policy_state,
                    input.owner_generation,
                    &cancel,
                )? {
                    policy_state = selected_state;
                    if control_state.is_some() {
                        control_state = Some(policy_state.clone());
                    }
                }
            }
            let view = PolicyView {
                run_id: &input.run_id,
                state,
                history: &history,
                pending_tool_calls: pending.as_ref().map_or(0, |(_, calls)| calls.len()),
                model_capabilities: self
                    .provider
                    .policy_model_capabilities()
                    .iter()
                    .map(PolicyModelAvailability::from)
                    .collect(),
            };
            let decision = match recovered_decision.take().map(Ok).unwrap_or_else(|| {
                guarded("policy_panicked", || {
                    self.policy.decide(&view, &event, &policy_state, &cancel)
                })
            }) {
                Ok(decision) => decision,
                Err(error) => {
                    if cancel.is_cancelled() {
                        continue 'agent;
                    }
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
            if cancel.is_cancelled() {
                continue 'agent;
            }
            // A policy can neither fabricate a closed exchange nor bypass the tool admission path.
            let legal = match &decision.action {
                PolicyAction::ExecuteTools => pending.is_some(),
                PolicyAction::RequestModel
                | PolicyAction::RequestModelJob { .. }
                | PolicyAction::RequestModelWithEvidence { .. }
                | PolicyAction::ToolGraph { .. }
                | PolicyAction::ReadResult { .. }
                | PolicyAction::Deliver { .. }
                | PolicyAction::Pause { .. }
                | PolicyAction::Complete
                | PolicyAction::Wait { .. } => pending.is_none(),
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
            if !matches!(
                decision.action,
                PolicyAction::ToolGraph { .. }
                    | PolicyAction::RequestModelJob { .. }
                    | PolicyAction::Deliver { .. }
                    | PolicyAction::Pause { .. }
            ) {
                self.commit(
                    &input,
                    ExecutionRecord::PolicyCheckpoint {
                        identity: self.policy.identity(),
                        previous_state: policy_state.clone(),
                        state: decision.state.clone(),
                        action: decision.action.clone(),
                        event: event.clone(),
                    },
                )?;
            }
            let previous_policy_state = std::mem::replace(&mut policy_state, decision.state);
            match decision.action {
                PolicyAction::Complete => {
                    finish!('agent, RunState::Completed, None, None, previous_policy_state)
                }
                PolicyAction::Fail { reason } => finish!('agent, RunState::Failed, None,
                    Some(ExecutionError::new("policy_failed", reason)), previous_policy_state),
                PolicyAction::Wait { wait_id } => {
                    if wait_id.is_empty() {
                        finish!('agent, RunState::Failed, None,
                            Some(ExecutionError::new("invalid_wait", "a wait needs a registered identity")));
                    }
                    finish!('agent, RunState::Waiting, Some(wait_id), None, previous_policy_state);
                }
                action @ (PolicyAction::Deliver { .. } | PolicyAction::Pause { .. }) => {
                    let boundary = self
                        .persistence
                        .policy_boundary(&input.run_id, input.owner_generation)?;
                    let intent = PolicyControlIntent {
                        action_id: format!("{}:policy:{}", input.run_id, boundary.id),
                        boundary,
                        identity: self.policy.identity(),
                        state: policy_state.clone(),
                        expected_head: history_cursor.clone(),
                        action,
                    };
                    let receipt = match self.persistence.commit_policy_control(
                        &input.run_id,
                        input.owner_generation,
                        &intent,
                    ) {
                        Ok(receipt) => receipt,
                        Err(error) if matches!(error.code.as_str(),"input_pending"|"goal_changed") || cancel.is_cancelled() => {
                            policy_state = previous_policy_state;
                            continue 'agent;
                        }
                        Err(error) => return Err(error),
                    };
                    match receipt {
                        PolicyControlReceipt::Delivered { action_id, item } => {
                            history_cursor = Some(item.id.clone());
                            event = PolicyEvent::Delivered {
                                action_id,
                                item_id: item.id.clone(),
                            };
                            control_state = Some(policy_state.clone());
                            history.push(item);
                        }
                        PolicyControlReceipt::Paused { wait_id, .. } => {
                            return Ok(ExecutionReport {
                                state: RunState::Waiting,
                                history,
                                policy_state,
                                model_steps: steps,
                                waiting_on: Some(wait_id),
                                failure: None,
                            })
                        }
                    }
                }
                PolicyAction::RequestModelJob {
                    capability_id,
                    instructions,
                    evidence,
                } => {
                    if self
                        .context_preparation
                        .prepare(&input.run_id, input.owner_generation, &cancel)
                        .is_err()
                    {
                        policy_state = previous_policy_state;
                        if cancel.is_cancelled() {
                            continue 'agent;
                        }
                        fail_context_preparation!('agent);
                    }
                    if cancel.is_cancelled() {
                        policy_state = previous_policy_state;
                        continue 'agent;
                    }
                    let job = match self.admit_model_job(
                        &input,
                        &history,
                        history_cursor.as_deref(),
                        capability_id,
                        instructions,
                        evidence,
                        policy_state.clone(),
                    ) {
                        Ok(job) => job,
                        Err(error) if matches!(error.code.as_str(),"input_pending"|"goal_changed") => {
                            policy_state = previous_policy_state;
                            continue 'agent;
                        }
                        Err(error) => {
                            policy_state = previous_policy_state;
                            finish!('agent,RunState::Failed,None,Some(error));
                        }
                    };
                    control_state = None;
                    event = self.execute_model_job(&input, job, &cancel)?;
                    if matches!(&event,PolicyEvent::ModelJobCompleted{receipt,..} if receipt.failure.as_ref().is_some_and(|f|f.code=="goal_changed")) {policy_state=previous_policy_state;event=PolicyEvent::Started;}
                }
                PolicyAction::ToolGraph { nodes } => {
                    let selected = match guarded("tool_selection_panicked", || {
                        self.tools.select_for_request(
                            &input.run_id,
                            input.owner_generation,
                            &cancel,
                        )
                    }) {
                        Ok(selected) => selected,
                        Err(_) if cancel.is_cancelled() => {
                            policy_state = previous_policy_state;
                            continue 'agent;
                        }
                        Err(error) => finish!('agent,RunState::Failed,None,Some(error)),
                    };
                    if let Some(selected) = &selected {
                        input.binding.tools = selected.schemas.clone();
                        input.binding.tool_schema_generation = selected.generation;
                    }
                    let retained = match selected {
                        Some(selected) => Some(selected.executor),
                        None => self.tools.freeze(&input.binding.tools)?,
                    };
                    let graph =
                        match self.admit_tool_graph(&input, nodes, policy_state.clone(), &history, history_cursor.as_deref(), &cancel) {
                            Ok(graph) => graph,
                            Err(error)
                                if matches!(error.code.as_str(),"input_pending"|"goal_changed") || cancel.is_cancelled() =>
                            {
                                policy_state = previous_policy_state;
                                continue 'agent;
                            }
                            Err(error) => {
                                policy_state = previous_policy_state;
                                finish!('agent,RunState::Failed,None,Some(error))
                            }
                        };
                    control_state = None;
                    event = self.execute_tool_graph(&input, graph, &cancel, retained)?;
                }
                PolicyAction::ReadResult { reference, index } => {
                    let chunk = match self.persistence.policy_chunk(
                        &input.run_id,
                        input.owner_generation,
                        &reference,
                        index,
                    ) {
                        Ok(chunk) => chunk,
                        Err(error) => finish!('agent,RunState::Failed,None,Some(error)),
                    };
                    control_state = None;
                    event = PolicyEvent::ResultChunk {
                        reference,
                        index,
                        total_chunks: chunk.chunk_count,
                        total_bytes: chunk.total_bytes,
                        bytes: chunk.bytes,
                    };
                    self.commit(
                        &input,
                        ExecutionRecord::PolicyDecisionConsumed {
                            event: event.clone(),
                        },
                    )?;
                }
                action @ (PolicyAction::RequestModel
                | PolicyAction::RequestModelWithEvidence { .. }) => {
                    let evidence = match action {
                        PolicyAction::RequestModelWithEvidence { evidence } => evidence,
                        _ => Vec::new(),
                    };
                    let selected_model = match guarded("model_selection_panicked", || {
                        self.provider.select_for_request(
                            &input.run_id,
                            input.owner_generation,
                            &cancel,
                        )
                    }) {
                        Ok(selected) => selected,
                        Err(_) if cancel.is_cancelled() => {
                            policy_state = previous_policy_state;
                            continue 'agent;
                        }
                        Err(error) => finish!('agent,RunState::Failed,None,Some(error)),
                    };
                    if let Some(selected) = &selected_model {
                        input.binding.connection_identity =
                            selected.binding.connection_identity.clone();
                        input.binding.provider_family = selected.binding.provider_family.clone();
                        input.binding.model = selected.binding.model.clone();
                        input.binding.credential_ref = selected.binding.credential_ref.clone();
                        input.binding.configuration_generation =
                            selected.binding.configuration_generation;
                    }
                    let selected_tools = match guarded("tool_selection_panicked", || {
                        self.tools.select_for_request(
                            &input.run_id,
                            input.owner_generation,
                            &cancel,
                        )
                    }) {
                        Ok(selected) => selected,
                        Err(_) if cancel.is_cancelled() => {
                            policy_state = previous_policy_state;
                            continue 'agent;
                        }
                        Err(error) => finish!('agent,RunState::Failed,None,Some(error)),
                    };
                    if let Some(selected) = &selected_tools {
                        input.binding.tools = selected.schemas.clone();
                        input.binding.tool_schema_generation = selected.generation;
                    }
                    if self
                        .context_preparation
                        .prepare(&input.run_id, input.owner_generation, &cancel)
                        .is_err()
                    {
                        policy_state = previous_policy_state;
                        if cancel.is_cancelled() {
                            continue 'agent;
                        }
                        fail_context_preparation!('agent);
                    }
                    if cancel.is_cancelled() {
                        policy_state = previous_policy_state;
                        continue 'agent;
                    }
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
                        binding.resource_checkpoint_id = context.resource_checkpoint_id;
                        binding.instruction_sources = context.instruction_sources;
                        binding.memory_checkpoint = context.memory_checkpoint;
                    }
                    if let Err(error) = validate_history_pairs(&history) {
                        finish!('agent, RunState::Failed, None, Some(error));
                    }
                    binding.history_range.leaf_id = history_cursor.clone();
                    let request_tools = match selected_tools {
                        Some(selected) => Some(selected.executor),
                        None => self.tools.freeze(&binding.tools)?,
                    };
                    let mut request_history = compile_history(
                        &history,
                        &binding.provider_family,
                        &binding.connection_identity,
                    );
                    let mut selected = BTreeSet::new();
                    for reference in evidence {
                        if !selected
                            .insert((reference.action_id.clone(), reference.node_id.clone()))
                        {
                            finish!('agent,RunState::Failed,None,Some(ExecutionError::new("duplicate_evidence","evidence references must be unique")));
                        }
                        let item = match self.persistence.policy_evidence(
                            &input.run_id,
                            input.owner_generation,
                            &reference,
                        ) {
                            Ok(item) => item,
                            Err(error) => finish!('agent,RunState::Failed,None,Some(error)),
                        };
                        request_history.retain(|previous| !matches!(&previous.provenance,Provenance::EnvironmentFact{event_id} if item.memory_facts.contains(event_id)));
                        request_history.push(item.item);
                    }
                    binding.resource_activations = crate::catalog::resources::retained_activations(&request_history);
                    let goal=self.persistence.goal_context(&input.run_id,input.owner_generation)?;
                    binding.goal=goal.as_ref().map(|g|g.binding.clone());
                    if let Some(item)=goal.and_then(|g|g.item){request_history.push(item);}
                    let view = RequestView {
                        request_id: format!(
                            "{}:{}:{}",
                            input.run_id, input.owner_generation, steps
                        ),
                        run_id: input.run_id.clone(),
                        origin: RequestOrigin::Conversation {
                            step: steps,
                            history_range: binding.history_range.clone(),
                        },
                        binding,
                        history: request_history,
                    };
                    let model_cancel = cancel.child(&format!("model:{}", view.request_id));
                    let serialized =
                        match guarded("provider_serialize_panicked", || match &selected_model {
                            Some(selected) => selected.provider.serialize(&view),
                            None => self.provider.serialize(&view),
                        }) {
                            Ok(serialized) => serialized,
                            Err(error) => finish!('agent, RunState::Failed, None, Some(error)),
                        };
                    match self.context_preparation.prepare_request(
                        input.owner_generation,
                        &view,
                        &serialized,
                        &cancel,
                    ) {
                        Ok(ContextRequestPreparation::Recompile) => {
                            steps -= 1;
                            policy_state = previous_policy_state;
                            continue 'agent;
                        }
                        Ok(ContextRequestPreparation::Ready) => (),
                        Ok(ContextRequestPreparation::Waiting { wait_id }) => {
                            steps -= 1;
                            finish!('agent,RunState::Waiting,Some(wait_id),None);
                        }
                        Err(error) => {
                            if cancel.is_cancelled() {
                                steps -= 1;
                                policy_state = previous_policy_state;
                                continue 'agent;
                            }
                            finish!('agent, RunState::Failed, None, Some(error));
                        }
                    }
                    let snapshot = RequestSnapshot { view, serialized };
                    match self.commit(
                        &input,
                        ExecutionRecord::RequestPrepared {
                            snapshot: snapshot.clone(),
                        },
                    ) {
                        Ok(()) => {}
                        Err(error)
                            if matches!(error.code.as_str(),"input_pending"|"goal_changed") || model_cancel.is_cancelled() =>
                        {
                            steps -= 1;
                            policy_state = previous_policy_state;
                            continue 'agent;
                        }
                        Err(error) => return Err(error),
                    }
                    if model_cancel.is_cancelled() {
                        interrupted_generation = !cancel.is_cancelled();
                        self.commit(
                            &input,
                            ExecutionRecord::RequestNotDispatched {
                                request_id: snapshot.view.request_id.clone(),
                                reason: NonDispatchReason::Cancelled,
                            },
                        )?;
                        policy_state = previous_policy_state;
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
                        Ok(()) => {
                            // The durable checkpoint and its in-memory continuation are consumed
                            // together. Preparation alone can still lose to input or Goal changes.
                            control_state = None;
                        }
                        Err(error)
                            if matches!(error.code.as_str(),"input_pending"|"goal_changed") || model_cancel.is_cancelled() =>
                        {
                            interrupted_generation = error.code != "goal_changed" && !cancel.is_cancelled();
                            self.commit(
                                &input,
                                ExecutionRecord::RequestNotDispatched {
                                    request_id: snapshot.view.request_id.clone(),
                                    reason: if error.code == "goal_changed" {
                                        NonDispatchReason::GoalChanged
                                    } else if error.code == "input_pending" {
                                        NonDispatchReason::InputPending
                                    } else {
                                        NonDispatchReason::Cancelled
                                    },
                                },
                            )?;
                            policy_state = previous_policy_state;
                            continue 'agent;
                        }
                        Err(error) => return Err(error),
                    }
                    let (items, deltas, usage, mut result) = self.generate(
                        &input.run_id,
                        &snapshot,
                        &model_cancel,
                        selected_model
                            .as_ref()
                            .map(|selected| selected.provider.as_ref()),
                    );
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
                    let committed: Vec<_> = items
                        .iter()
                        .map(|item| model_history_item(&snapshot.view.request_id, item))
                        .collect();
                    history_cursor = committed
                        .last()
                        .map(|item| item.id.clone())
                        .or(history_cursor);
                    history.extend(committed);
                    event = PolicyEvent::ModelCompleted {
                        reason,
                        tool_calls: calls.len(),
                    };
                    if !calls.is_empty() {
                        pending = Some((snapshot, calls));
                        pending_tools = request_tools;
                        pending_model = selected_model.map(|selected| selected.provider);
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
                    let results = self.execute_batch(
                        &input,
                        &snapshot,
                        calls,
                        &cancel,
                        &recovered_results,
                        pending_tools.take(),
                    )?;
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
                            resource_activation: None,
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
                    pending_model.take();
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
                resource_activation: None,
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
        selected: Option<&dyn ModelProvider>,
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
            let mut emit = |event| {
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
            };
            match selected {
                Some(provider) => provider.generate(snapshot, cancel, &mut emit),
                None => self.provider.generate(snapshot, cancel, &mut emit),
            }
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
        tools: Option<Arc<dyn ToolExecutor>>,
    ) -> Result<Vec<ToolResult>, ExecutionError> {
        let frozen = FrozenToolContext {
            resource_activations: snapshot.view.binding.resource_activations.clone(),
            resource_checkpoint_id: snapshot.view.binding.resource_checkpoint_id.clone(),
            run_id: input.run_id.clone(),
            origin: ToolOrigin::ModelStep {
                request_id: snapshot.view.request_id.clone(),
            },
            tools: Arc::new(snapshot.view.binding.tools.clone()),
            tool_schema_generation: snapshot.view.binding.tool_schema_generation,
            source: self.persistence.tool_source(&input.run_id)?,
        };
        let mut results: Vec<Option<ToolResult>> = calls
            .iter()
            .map(|call| cached.get(&call.call_id).cloned())
            .collect();
        let mut planned = Vec::new();
        let mut operation_tokens = Vec::new();
        let admission = self.persistence.resource_admission();
        let mut identity = None;
        // Only local, nonblocking planning runs on this thread. Establish the entire batch's
        // order before starting owner lookups; the shared admission owner also orders other Runs.
        for (index, call) in calls.iter().enumerate() {
            if results[index].is_some() {
                continue;
            }
            let operation_id = format!("{}:tool:{}", snapshot.view.request_id, call.call_id);
            let operation_cancel = cancel.child(&operation_id);
            operation_tokens.push(operation_cancel.clone());
            let bound = match tools
                .as_ref()
                .map(|tools| tools.clone().bind_call(call, &frozen, &operation_cancel))
                .unwrap_or_else(|| {
                    self.tools
                        .clone()
                        .bind_call(call, &frozen, &operation_cancel)
                }) {
                Ok(bound) => bound,
                Err(error) => {
                    results[index] = Some(self.unprepared_result(
                        input,
                        snapshot,
                        call,
                        ToolCompletion::failure(&error.code, &error.message, Effect::None),
                    ));
                    continue;
                }
            };
            let preparation = if operation_cancel.is_cancelled() {
                None
            } else {
                match guarded("tool_plan_panicked", || bound.plan(&operation_cancel)) {
                    Ok(preparation) => Some(preparation),
                    Err(error) => {
                        results[index] = Some(self.unprepared_result(
                            input,
                            snapshot,
                            call,
                            if operation_cancel.is_cancelled() {
                                ToolCompletion::cancelled()
                            } else {
                                ToolCompletion::failure(&error.code, &error.message, Effect::None)
                            },
                        ));
                        continue;
                    }
                }
            };
            let Some(preparation) = preparation else {
                results[index] = Some(self.unprepared_result(
                    input,
                    snapshot,
                    call,
                    ToolCompletion::cancelled(),
                ));
                continue;
            };
            let (intents, class) = match &preparation {
                ToolPreparation::Ready(contract) => {
                    if contract.name != call.name || contract.schema_version != call.schema_version
                    {
                        results[index] = Some(self.unprepared_result(
                            input,
                            snapshot,
                            call,
                            ToolCompletion::failure(
                                "contract_mismatch",
                                "resolved tool differs from frozen schema",
                                Effect::None,
                            ),
                        ));
                        continue;
                    }
                    let class =
                        match guarded("tool_plan_panicked", || Ok(bound.execution_class(contract)))
                        {
                            Ok(class) => class,
                            Err(error) => {
                                results[index] = Some(self.unprepared_result(
                                    input,
                                    snapshot,
                                    call,
                                    ToolCompletion::failure(
                                        &error.code,
                                        &error.message,
                                        Effect::None,
                                    ),
                                ));
                                continue;
                            }
                        };
                    (
                        contract
                            .resources
                            .iter()
                            .cloned()
                            .map(ResourceIntent::Exact)
                            .collect(),
                        class,
                    )
                }
                ToolPreparation::Resolve { resources, class } => (resources.clone(), *class),
            };
            if identity.is_none() {
                match self
                    .persistence
                    .task_family(&input.run_id, input.owner_generation)
                {
                    Ok(family_id) => {
                        identity = Some(crate::execution_capacity::AdmissionIdentity {
                            run_id: input.run_id.clone(),
                            owner_generation: input.owner_generation,
                            origin: frozen.origin.clone(),
                            family_id,
                        })
                    }
                    Err(_) if cancel.is_cancelled() => {
                        results[index] = Some(self.unprepared_result(
                            input,
                            snapshot,
                            call,
                            ToolCompletion::cancelled(),
                        ));
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            let reservation = admission.reserve(
                &operation_id,
                intents,
                identity.as_ref().expect("established identity"),
                class,
                &operation_cancel,
            )?;
            planned.push((
                index,
                bound,
                preparation,
                reservation,
                class,
                operation_cancel,
            ));
        }
        let mut persistence_failure = None;
        std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel();
            let count = planned.len();
            for (index, bound, preparation, mut reservation, class, operation_cancel) in planned {
                let tx = tx.clone();
                let call = &calls[index];
                scope.spawn(move || {
                    let result = guarded("tool_worker_panicked", || {
                        let contract = match preparation {
                            ToolPreparation::Ready(contract) => Ok(contract),
                            ToolPreparation::Resolve { .. } => {
                                guarded("tool_prepare_panicked", || {
                                    bound.prepare(&operation_cancel)
                                })
                            }
                        };
                        let contract = match contract {
                            Ok(contract)
                                if contract.name == call.name
                                    && contract.schema_version == call.schema_version =>
                            {
                                contract
                            }
                            Ok(_) => {
                                return Ok(self.unprepared_result(
                                    input,
                                    snapshot,
                                    call,
                                    ToolCompletion::failure(
                                        "contract_mismatch",
                                        "resolved tool differs from frozen schema",
                                        Effect::None,
                                    ),
                                ))
                            }
                            Err(error) => {
                                return Ok(self.unprepared_result(
                                    input,
                                    snapshot,
                                    call,
                                    if operation_cancel.is_cancelled() {
                                        ToolCompletion::cancelled()
                                    } else {
                                        ToolCompletion::failure(
                                            &error.code,
                                            &error.message,
                                            Effect::None,
                                        )
                                    },
                                ))
                            }
                        };
                        if bound.execution_class(&contract) != class {
                            return Ok(self.unprepared_result(
                                input,
                                snapshot,
                                call,
                                ToolCompletion::failure(
                                    "execution_class_mismatch",
                                    "resolved execution class differs from preplanning",
                                    Effect::None,
                                ),
                            ));
                        }
                        if let Err(error) = reservation.resolve(&contract.resources) {
                            return Ok(self.unprepared_result(
                                input,
                                snapshot,
                                call,
                                ToolCompletion::failure(&error.code, &error.message, Effect::None),
                            ));
                        }
                        let tool = AdmittedTool {
                            call: call.clone(),
                            contract,
                        };
                        // Each side effect owns its durable intent; pure results retain the
                        // cheaper in-memory path and enter history when provider pairing closes.
                        if !tool.contract.read_only
                            || tool.contract.completion == CompletionKind::Job
                        {
                            self.commit(
                                input,
                                ExecutionRecord::ToolAdmitted {
                                    context: ToolExecutionContext {
                                        run_id: input.run_id.clone(),
                                        origin: ToolOrigin::ModelStep {
                                            request_id: snapshot.view.request_id.clone(),
                                        },
                                        operation_id: format!(
                                            "{}:tool:{}",
                                            snapshot.view.request_id, call.call_id
                                        ),
                                    },
                                    tool: tool.clone(),
                                },
                            )?;
                        }
                        let context = ToolExecutionContext {
                            run_id: input.run_id.clone(),
                            origin: ToolOrigin::ModelStep {
                                request_id: snapshot.view.request_id.clone(),
                            },
                            operation_id: format!(
                                "{}:tool:{}",
                                snapshot.view.request_id, call.call_id
                            ),
                        };
                        let durable = !tool.contract.read_only
                            || tool.contract.completion == CompletionKind::Job;
                        let completion = self.execute_one(
                            input,
                            &context,
                            &tool,
                            bound.as_ref(),
                            &operation_cancel,
                            reservation,
                            durable,
                        )?;
                        Ok(self.unprepared_result(input, snapshot, call, completion))
                    });
                    let _ = tx.send((index, result));
                });
            }
            drop(tx);
            for _ in 0..count {
                let (index, result) = rx
                    .recv()
                    .expect("tool workers retain their completion sender");
                match result {
                    Ok(result) => results[index] = Some(result),
                    Err(error) => {
                        if persistence_failure.is_none() {
                            persistence_failure = Some(error);
                            // No queued successor may remain waiting behind an unconfirmed durable
                            // receipt. Cancellation stops dispatch but does not release active effects.
                            for token in &operation_tokens {
                                token.cancel();
                            }
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

    fn unprepared_result(
        &self,
        input: &ExecutionInput,
        snapshot: &RequestSnapshot,
        call: &ToolCall,
        completion: ToolCompletion,
    ) -> ToolResult {
        let result = ToolResult {
            request_id: snapshot.view.request_id.clone(),
            call_id: call.call_id.clone(),
            completion,
        };
        self.progress
            .emit(&input.run_id, ExecutionEvent::ToolCompleted(result.clone()));
        result
    }

    fn execute_one(
        &self,
        input: &ExecutionInput,
        context: &ToolExecutionContext,
        tool: &AdmittedTool,
        bound: &dyn PreparedToolCall,
        cancel: &CancellationToken,
        reservation: crate::resource_admission::ResourceReservation,
        durable: bool,
    ) -> Result<ToolCompletion, ExecutionError> {
        let mut lease = None;
        let mut reservation = Some(reservation);
        let mut _admission_control = None;
        let mut executor_stopped = true;
        let completion = if cancel.is_cancelled() || !self.persistence.goal_tool_allowed(context)? {
            ToolCompletion::NotDispatched {
                reason: "cancelled".into(),
            }
        } else if let Err(error) = guarded("tool_admission_watch_panicked", || {
            _admission_control = bound.watch_admission(context, &tool.contract, cancel)?;
            Ok(())
        }) {
            ToolCompletion::NotDispatched {
                reason: format!("{}: {}", error.code, error.message),
            }
        } else if let Err(error) = guarded("tool_authorize_panicked", || {
            bound.authorize(context, &tool.contract, cancel)
        }) {
            ToolCompletion::NotDispatched {
                reason: format!("{}: {}", error.code, error.message),
            }
        } else {
            let ready = prepare_dispatch(cancel, || {
                lease = reservation
                    .take()
                    .expect("one admission per call")
                    .acquire()?;
                Ok(lease.is_some())
            })?;
            if !ready {
                ToolCompletion::NotDispatched {
                    reason: "cancelled".into(),
                }
            } else if let Err(error) = self
                .persistence
                .task_family(&input.run_id, input.owner_generation)
                .and_then(|_| {
                    guarded("tool_authorize_panicked", || {
                        bound.authorize(context, &tool.contract, cancel)
                    })
                })
            {
                ToolCompletion::NotDispatched {
                    reason: format!("{}: {}", error.code, error.message),
                }
            } else if cancel.is_cancelled() || !self.persistence.goal_tool_allowed(context)? {
                ToolCompletion::NotDispatched {
                    reason: "cancelled".into(),
                }
            } else {
                let dispatch_cancelled = if durable {
                    match self.commit(
                        input,
                        ExecutionRecord::ToolDispatched {
                            context: context.clone(),
                            executor_owner: bound.executor_owner(),
                        },
                    ) {
                        Ok(()) => {
                            if let Some(lease) = lease.as_mut() {
                                lease.dispatched();
                            }
                            false
                        }
                        Err(error) if error.code == "dispatch_cancelled" => true,
                        Err(error) => return Err(error),
                    }
                } else {
                    false
                };
                let result = if dispatch_cancelled || cancel.is_cancelled() {
                    Ok(ToolExecutionReceipt::not_dispatched("cancelled"))
                } else {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        bound.execute(context, &tool.contract, cancel)
                    }))
                };
                match result {
                    Ok(receipt) => {
                        executor_stopped = receipt.executor_stopped;
                        let completion = receipt.completion;
                        let confirmed_no_effect = !tool.contract.read_only
                            && matches!(
                                &completion,
                                ToolCompletion::Result {
                                    effect: Effect::None,
                                    ..
                                }
                            )
                            && guarded("receipt_evidence_panicked", || {
                                self.persistence.confirms_no_effect(
                                    context,
                                    input.owner_generation,
                                    &completion,
                                )
                            })
                            .unwrap_or(false);
                        normalize_completion(completion, &tool.contract, confirmed_no_effect)
                    }
                    Err(_) => {
                        executor_stopped = matches!(bound.executor_owner(), ExecutorOwner::Kernel)
                            && tool.contract.completion != CompletionKind::Job;
                        ToolCompletion::failure(
                            "tool_panicked",
                            "tool worker stopped without a receipt",
                            if tool.contract.read_only {
                                Effect::None
                            } else {
                                Effect::Unknown
                            },
                        )
                    }
                }
            }
        };
        let settled = if durable {
            self.commit(
                input,
                ExecutionRecord::ToolSettled {
                    context: context.clone(),
                    completion: completion.clone(),
                    executor_stopped,
                },
            )
            .map(|_| completion)
        } else {
            Ok(completion)
        };
        // Only original executor completion/stop evidence releases dispatched occupancy.
        if let Some(lease) = lease {
            if settled.is_err() || !executor_stopped {
                lease.handoff();
            } else {
                lease.release();
            }
        }
        settled
    }
}

/// Cancellation wins only while no tool has been dispatched. Inspect it after admission
/// returns, including on error: durable cancellation can invalidate task_family while
/// a watch is being registered. Without that control fact, preserve recovery errors.
fn prepare_dispatch(
    cancel: &CancellationToken,
    admission: impl FnOnce() -> Result<bool, ExecutionError>,
) -> Result<bool, ExecutionError> {
    if cancel.is_cancelled() {
        return Ok(false);
    }
    let result = admission();
    if cancel.is_cancelled() {
        Ok(false)
    } else {
        result
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

fn normalize_completion(
    completion: ToolCompletion,
    contract: &ToolContract,
    confirmed_no_effect: bool,
) -> ToolCompletion {
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
        } if !contract.read_only && !confirmed_no_effect => ToolCompletion::Result {
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
