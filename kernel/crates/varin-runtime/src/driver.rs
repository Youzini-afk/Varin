//! Per-Run algorithms over the original model, invocation and resource owners.
//! A driver is not a policy action interpreter and never owns execution receipts.
use crate::execution::*;
use crate::{Catalog, RuntimeError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DriverRecovery {
    None,
    Checkpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverArtifact {
    pub provider_key: String,
    pub extension_id: String,
    pub extension_version: String,
    pub service_id: String,
    pub service_version: u64,
    pub artifact_integrity: String,
    pub composition: crate::catalog::service_composition::HostServiceComposition,
    pub configuration_identity: String,
    pub identity: PolicyIdentity,
    pub model_roles: Vec<String>,
    pub recovery: DriverRecovery,
    pub checkpoint_schema: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DriverSelection {
    Builtin { name: String, version: String },
    Extension { artifact: DriverArtifact },
}
impl Default for DriverSelection {
    fn default() -> Self {
        Self::Builtin {
            name: "varin.default".into(),
            version: "1".into(),
        }
    }
}
impl DriverSelection {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        match self {
            Self::Builtin { name, version } if name == "varin.default" && version == "1" => Ok(()),
            Self::Extension { artifact: a } => {
                a.composition.validate_root(
                    &a.extension_id,
                    &a.extension_version,
                    &a.artifact_integrity,
                    &a.provider_key,
                    &a.service_id,
                    a.service_version,
                )?;
                if a.service_id != "varin.agent.driver"
                    || a.service_version != 1
                    || [
                        &a.provider_key,
                        &a.extension_id,
                        &a.extension_version,
                        &a.artifact_integrity,
                        &a.configuration_identity,
                        &a.identity.name,
                        &a.identity.version,
                    ]
                    .iter()
                    .any(|s| s.is_empty())
                    || a.model_roles.iter().any(|s| s.is_empty())
                    || a.model_roles
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
                        .len()
                        != a.model_roles.len()
                    || match a.recovery {
                        DriverRecovery::None => a.checkpoint_schema.is_some(),
                        DriverRecovery::Checkpoint => {
                            a.checkpoint_schema.as_deref().is_none_or(str::is_empty)
                        }
                    }
                {
                    return Err(RuntimeError::Invalid(
                        "driver requires an exact implementation and recovery contract".into(),
                    ));
                }
                Ok(())
            }
            _ => Err(RuntimeError::Invalid(
                "unknown builtin driver; the historical default will not be replaced".into(),
            )),
        }
    }
    pub fn owner_key(&self) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(
            serde_json::to_vec(self).expect("serializable driver selection"),
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverBinding {
    pub reference: String,
    pub artifact: DriverArtifact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverModelInput {
    pub id: String,
    pub capability_id: Option<String>,
    pub history: ConversationHistory,
    pub instructions: Vec<String>,
    /// Only names from this Run's frozen tool directory; no new schemas or permission.
    pub tools: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverModelReceipt {
    pub id: String,
    pub request_id: String,
    pub outcome: ModelOutcome,
    pub items: Vec<ProviderItem>,
    pub usage: UsageReceipt,
    pub finish_reason: Option<FinishReason>,
    pub failure: Option<ModelFailure>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverToolInput {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverToolReceipt {
    pub id: String,
    pub operation_id: String,
    pub completion: ToolCompletion,
    pub executor_stopped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverCheckpointInput {
    pub expected_revision: u64,
    pub schema: String,
    pub state: Value,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverDeliveryInput {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DriverRunOutcome {
    Complete,
    Pause { reason: String },
    Fail { error: ExecutionError },
}

/// The default and third-party algorithms implement the same supervised lifetime. The
/// context, not the algorithm's return value, closes admission and drains accepted work.
pub trait RunDriver: Send + Sync {
    fn selection(&self) -> DriverSelection;
    fn run(&self, context: Arc<DriverContext>) -> Result<ExecutionReport, ExecutionError>;
}

pub struct DefaultRunDriver;
impl RunDriver for DefaultRunDriver {
    fn selection(&self) -> DriverSelection {
        DriverSelection::default()
    }
    fn run(&self, context: Arc<DriverContext>) -> Result<ExecutionReport, ExecutionError> {
        context.run_default()
    }
}

pub struct DriverContext {
    pub catalog: Arc<Mutex<Catalog>>,
    pub run_id: String,
    pub epoch: u64,
    pub start: crate::supervisor::RunStart,
    pub cancel: CancellationToken,
    state: Mutex<ContextState>,
    drained: Condvar,
    context_refresh: Mutex<()>,
    observation_stop: CancellationToken,
}
#[derive(Default)]
struct ContextState {
    accepting: bool,
    active: usize,
    input: Option<ExecutionInput>,
    calls: HashMap<String, Arc<PrimitiveCall>>,
}
struct PrimitiveCall {
    input: Value,
    cancel: CancellationToken,
    result: Mutex<Option<Result<Value, ExecutionError>>>,
    ready: Condvar,
}

pub use crate::catalog::driver::DriverCheckpoint;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverDeliveryReceipt {
    pub id: String,
    pub history_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverReceiptInput {
    pub id: String,
    pub kind: crate::catalog::driver::DriverWorkKind,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct DriverContextInput {}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverContextReceipt {
    pub history: ConversationHistory,
    pub tools: Vec<ToolSchema>,
    pub input_ids: Vec<String>,
    pub activating: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverWaitInput {
    pub after: Option<u64>,
    pub work: Vec<DriverReceiptInput>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverWaitReceipt {
    pub cursor: u64,
    pub input_pending: bool,
    pub receipts: Vec<DriverReceipt>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DriverCancelKind {
    Model,
    Tool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverCancelInput {
    pub id: String,
    pub kind: DriverCancelKind,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverCancelReceipt {
    pub requested: bool,
    pub receipt: Option<DriverReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DriverReceipt {
    Model {
        id: String,
        request_id: String,
        state: crate::ModelStepState,
        receipt: Option<DriverModelReceipt>,
    },
    Tool {
        id: String,
        operation_id: String,
        phase: Option<crate::OperationPhase>,
        receipt: Option<DriverToolReceipt>,
    },
    Delivery {
        id: String,
        history_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverModelAvailability {
    pub capability_id: String,
    pub status: PolicyModelStatus,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverRunInput {
    pub run_id: String,
    pub epoch: u64,
    pub mode: String,
    pub history: ConversationHistory,
    pub tools: Vec<ToolSchema>,
    pub models: Vec<DriverModelAvailability>,
    pub checkpoint: Option<DriverCheckpoint>,
    pub receipts: Vec<DriverReceipt>,
}
#[path = "driver_context.rs"]
mod context;

impl DriverContext {
    pub fn new(
        catalog: Arc<Mutex<Catalog>>,
        run_id: String,
        epoch: u64,
        start: crate::supervisor::RunStart,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            catalog,
            run_id,
            epoch,
            start,
            cancel,
            state: Mutex::new(ContextState::default()),
            drained: Condvar::new(),
            context_refresh: Mutex::new(()),
            observation_stop: CancellationToken::default(),
        }
    }
    fn run_default(&self) -> Result<ExecutionReport, ExecutionError> {
        let catalog = self.catalog.clone();
        let identity = self.run_id.clone();
        let epoch = self.epoch;
        let cancel = self.cancel.clone();
        let start = self.start.clone();
        if !cancel.is_cancelled() {
            catalog
                .lock()
                .map_err(error)?
                .bind_run_driver(&identity, epoch, &DriverSelection::default())
                .map_err(error)?;
        }
        let binding = start.binding;
        let policy_state = start.policy_state;
        let engine = ExecutionEngine {
            persistence: catalog.clone(),
            context_preparation: start.context_preparation,
            provider: start.provider,
            tools: start.tools,
            policy: start.policy,
            progress: start.progress,
        };
        loop {
            if cancel.is_cancelled() {
                let settled = catalog
                    .lock()
                    .map_err(error)?
                    .cancel_preparing_execution(&identity, epoch)
                    .map_err(error)?;
                if let Some(run) = settled {
                    return Ok(ExecutionReport {
                        state: run.state,
                        history: vec![],
                        policy_state,
                        model_steps: 0,
                        waiting_on: run.waiting_on,
                        failure: None,
                    });
                }
            }
            let preparation = catalog
                .lock()
                .map_err(error)?
                .capture_recovered_execution(
                    &identity,
                    binding.clone(),
                    engine.policy.identity(),
                    policy_state.clone(),
                    true,
                )
                .map_err(error)?;
            if preparation.cancel_requested() && !cancel.is_cancelled() {
                cancel.cancel();
                continue;
            }
            let boundary = preparation.identity();
            let cancelled_before_read = cancel.is_cancelled();
            // Immutable content reads, hashing and decoding belong to this Run.
            let prepared = match preparation.load(&cancel) {
                Ok(Some(prepared)) => prepared,
                Ok(None) => continue,
                Err(_) if !cancelled_before_read && cancel.is_cancelled() => continue,
                Err(failure) => {
                    if !catalog
                        .lock()
                        .map_err(error)?
                        .preparation_is_current(&boundary)
                        .map_err(error)?
                    {
                        continue;
                    }
                    return Err(error(failure));
                }
            };
            let launch = catalog
                .lock()
                .map_err(error)?
                .publish_recovered_execution(prepared)
                .map_err(error)?;
            let Some(launch) = launch else { continue };
            if launch.cancel_requested {
                cancel.cancel();
            }
            return engine.run_recovered(launch.input, cancel.clone(), launch.recovery);
        }
    }
}
fn error(error: impl ToString) -> ExecutionError {
    ExecutionError::new("run_driver", error.to_string())
}
