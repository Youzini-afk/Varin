pub use crate::types_generated::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

impl RunState {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
    pub fn permits(self, next: Self) -> bool {
        use RunState::*;
        matches!(
            (self, next),
            (Accepted, Preparing | Runnable | Cancelled | Failed)
                | (Preparing, Runnable | Waiting | Cancelled | Failed)
                | (
                    Runnable,
                    Generating | Executing | Waiting | Completed | Cancelled | Failed
                )
                | (
                    Generating,
                    Executing | Runnable | Waiting | Completed | Cancelled | Failed
                )
                | (
                    Executing,
                    Runnable | Waiting | Completed | Cancelled | Failed
                )
                | (Waiting, Runnable | Cancelled | Failed)
        )
    }
}
/// Physical execution ownership is distinct from the tool/adapter name. External workers may
/// survive a kernel restart; their original epoch must authenticate any late receipt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExecutorOwner {
    Kernel,
    External { identity: String, epoch: String },
}
impl ExecutorOwner {
    pub fn validate(&self) -> bool {
        match self {
            Self::Kernel => true,
            Self::External { identity, epoch } => !identity.is_empty() && !epoch.is_empty(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Operation<E = ExternalReceipt, R = Value, C = crate::execution::ToolCompletion> {
    pub external_receipt: Option<E>,
    pub call_completion: Option<C>,
    pub id: String,
    pub run_id: String,
    pub epoch: u64,
    pub revision: u64,
    pub phase: OperationPhase,
    pub outcome: Option<Outcome>,
    pub effect: Effect,
    pub cancel_requested: bool,
    pub lifetime: Lifetime,
    pub handed_off: bool,
    pub executor: Option<String>,
    pub execution_owner: Option<ExecutorOwner>,
    pub waiting_on: Option<String>,
    pub intent: Value,
    pub result: Option<R>,
}
/// Catalog representation. Public reads hydrate immutable bodies into Operation.
pub type OperationMetadata = Operation<
    ExternalReceiptMetadata,
    OperationResultMetadata,
    crate::catalog::result_content::ToolCompletionMetadata,
>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationResultMetadata {
    /// Short domain-owned permission, question, policy or wait state, never tool output.
    Control { value: Value },
    /// Immutable ordinary/generic operation result.
    Content { reference: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExternalReceiptMetadata {
    pub executor: String,
    pub identity: String,
    pub epoch: String,
    pub outcome: Outcome,
    pub effect: Effect,
    pub result_ref: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Run {
    #[serde(default)]
    pub waiting_on: Option<String>,
    pub id: String,
    pub thread_id: String,
    pub branch_id: String,
    pub state: RunState,
    pub revision: u64,
    pub epoch: u64,
    pub configuration: Value,
    pub cancel_requested: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Receipt {
    pub thread_id: String,
    pub branch_id: String,
    pub run_id: String,
    pub input_id: String,
    pub cursor: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubmitInput {
    pub key: String,
    pub thread_id: String,
    pub branch_id: String,
    pub expected_head: Option<String>,
    pub input: Value,
    pub configuration: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryItem {
    pub id: String,
    pub thread_id: String,
    pub parent: Option<String>,
    pub source: HistorySource,
    pub content: Value,
    pub provider: Option<ProviderOriginal>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderOriginal {
    #[serde(default)]
    pub connection_identity: String,
    pub adapter: String,
    pub version: String,
    pub item: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelStep {
    #[serde(default)]
    pub superseded_by_input: Option<String>,
    pub id: String,
    pub run_id: String,
    pub epoch: u64,
    pub state: ModelStepState,
    pub request: Value,
    pub original: Vec<ProviderOriginal>,
    pub usage: Option<Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub cursor: u64,
    pub subject: String,
    pub revision: u64,
    pub kind: String,
    pub data: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Wait {
    pub id: String,
    pub run_id: String,
    pub subject: String,
    pub kind: String,
    pub after_cursor: u64,
    pub trigger_cursor: Option<u64>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExternalReceipt {
    pub executor: String,
    pub identity: String,
    pub epoch: String,
    pub outcome: Outcome,
    pub effect: Effect,
    pub result: Value,
}
