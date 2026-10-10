// Generated from kernel/protocol/schema.json. Do not hand-edit.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FollowupControlAction {
    Pause,
    Resume,
    Cancel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContentCollectionStatus {
    Completed,
    Deferred,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContentCollectionPhase {
    Admission,
    Roots,
    Verify,
    Sweep,
    Staging,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceMode {
    FixedBranch,
    Materialized,
    LiveRoot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Accepted,
    Preparing,
    Runnable,
    Generating,
    Executing,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationPhase {
    Accepted,
    Preparing,
    Queued,
    Running,
    Waiting,
    Settling,
    Terminal,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Succeeded,
    Failed,
    Cancelled,
    Indeterminate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    None,
    Dispatched,
    Partial,
    Confirmed,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Lifetime {
    Call,
    Run,
    Thread,
    Environment,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistorySource {
    User,
    Assistant,
    Tool,
    Agent,
    Environment,
    Compaction,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelStepState {
    Prepared,
    NotDispatched,
    Dispatched,
    Completed,
    Interrupted,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Selected,
    Sent,
    Committed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    Boundary,
    Interrupt,
    NextRun,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputState {
    Queued,
    Delivered,
    Cancelled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Inform,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentCollectionReport {
    pub status: ContentCollectionStatus,
    pub phase: ContentCollectionPhase,
    pub removed_objects: u64,
    pub removed_bytes: u64,
    pub removed_staging_files: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSessionConfiguration {
    pub provider_id: Option<String>,
    pub provider_family: String,
    pub model: String,
    pub endpoint: String,
    pub credential_environment: Option<String>,
    pub allow_anonymous: bool,
    pub accepts_images: Option<bool>,
    pub configuration_generation: u64,
    pub max_output_tokens: Option<u64>,
    pub azure_deployment: Option<String>,
    pub azure_api_version: Option<String>,
    pub legacy_max_tokens: Option<bool>,
    pub include_stream_usage: Option<bool>,
    pub reasoning_effort: Option<String>,
    pub anthropic_oauth: Option<bool>,
    pub adapter_id: Option<String>,
    pub adapter_version: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub thinking_level: Option<String>,
    pub model_options: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelWorkingResultCandidate {
    pub publication_id: String,
    pub candidate_operation_id: String,
    pub workspace_id: String,
    pub branch_id: String,
    pub root: String,
    pub base_root: String,
    pub write_revision: u64,
    pub pin_id: String,
    pub base_pin_id: String,
}
