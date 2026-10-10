//! Immutable tool and executor bodies are prepared/read by workers; Catalog commits metadata.
use super::*;
use crate::execution::{ToolCompletion, ToolResult};
use serde::Deserialize;

impl OperationResultMetadata {
    pub(crate) fn control(&self) -> Result<&Value> {
        match self {
            Self::Control { value } => Ok(value),
            Self::Content { .. } => Err(RuntimeError::Invalid(
                "operation requires domain control state".into(),
            )),
        }
    }
    pub(crate) fn reference(&self) -> Result<&Value> {
        match self {
            Self::Content { reference } => Ok(reference),
            Self::Control { .. } => Err(RuntimeError::Invalid(
                "operation requires immutable result content".into(),
            )),
        }
    }
    pub(crate) fn load(self, content: &crate::content::ContentStore) -> Result<Value> {
        match self {
            Self::Control { value } => Ok(value),
            Self::Content { reference } => content.load(&reference),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolReceiptMetadata {
    pub request_id: String,
    pub call_id: String,
    pub completion: ToolCompletionMetadata,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolCompletionMetadata {
    NotDispatched {
        reason_ref: Value,
    },
    Result {
        outcome: Outcome,
        effect: Effect,
        content_ref: Value,
    },
    JobAccepted {
        operation_id: String,
        phase: String,
        effect: Effect,
        lifetime: Lifetime,
    },
}
impl ToolReceiptMetadata {
    pub(crate) fn write(
        content: &crate::content::ContentStore,
        result: &ToolResult,
    ) -> Result<Self> {
        Ok(Self {
            request_id: result.request_id.clone(),
            call_id: result.call_id.clone(),
            completion: ToolCompletionMetadata::write(content, &result.completion)?,
        })
    }
    /// Domain Job registration contains only control identities; no body write is needed.
    pub(crate) fn job(result: &ToolResult) -> Result<Self> {
        let ToolCompletion::JobAccepted {
            operation_id,
            phase,
            effect,
            lifetime,
        } = &result.completion
        else {
            return Err(RuntimeError::Invalid(
                "job registration requires a Job receipt".into(),
            ));
        };
        Ok(Self {
            request_id: result.request_id.clone(),
            call_id: result.call_id.clone(),
            completion: ToolCompletionMetadata::JobAccepted {
                operation_id: operation_id.clone(),
                phase: phase.clone(),
                effect: *effect,
                lifetime: *lifetime,
            },
        })
    }
    pub(crate) fn load(self, content: &crate::content::ContentStore) -> Result<ToolResult> {
        Ok(ToolResult {
            request_id: self.request_id,
            call_id: self.call_id,
            completion: self.completion.load(content)?,
        })
    }
}
impl ToolCompletionMetadata {
    pub(crate) fn write(
        content: &crate::content::ContentStore,
        completion: &ToolCompletion,
    ) -> Result<Self> {
        Ok(match completion {
            ToolCompletion::NotDispatched { reason } => ToolCompletionMetadata::NotDispatched {
                reason_ref: content.save(&json!(reason))?,
            },
            ToolCompletion::Result {
                outcome,
                effect,
                content: body,
            } => ToolCompletionMetadata::Result {
                outcome: *outcome,
                effect: *effect,
                content_ref: content.save(body)?,
            },
            ToolCompletion::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
            } => ToolCompletionMetadata::JobAccepted {
                operation_id: operation_id.clone(),
                phase: phase.clone(),
                effect: *effect,
                lifetime: *lifetime,
            },
        })
    }
    pub(crate) fn load(self, content: &crate::content::ContentStore) -> Result<ToolCompletion> {
        Ok(match self {
            ToolCompletionMetadata::NotDispatched { reason_ref } => ToolCompletion::NotDispatched {
                reason: serde_json::from_value(content.load(&reason_ref)?)?,
            },
            ToolCompletionMetadata::Result {
                outcome,
                effect,
                content_ref,
            } => ToolCompletion::Result {
                outcome,
                effect,
                content: content.load(&content_ref)?,
            },
            ToolCompletionMetadata::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
            } => ToolCompletion::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
            },
        })
    }
}
pub struct ToolCompletionRead {
    pub(super) completion: ToolCompletionMetadata,
    pub(super) content: crate::content::ContentStore,
    pub(super) _publication: crate::content::ContentPublication,
}
impl ToolCompletionRead {
    pub fn load(self) -> Result<ToolCompletion> {
        self.completion.load(&self.content)
    }
}
pub struct ResultContentPreparation {
    pub(super) content: crate::content::ContentStore,
    pub(super) publication: crate::content::ContentPublication,
}
pub struct PreparedOperationResult {
    pub(super) reference: Value,
    pub(super) _publication: crate::content::ContentPublication,
}
pub struct PreparedExternalReceipt {
    pub(super) receipt: ExternalReceiptMetadata,
    pub(super) _publication: crate::content::ContentPublication,
}
impl ResultContentPreparation {
    pub fn write_result(self, result: &Value) -> Result<PreparedOperationResult> {
        Ok(PreparedOperationResult {
            reference: self.content.save(result)?,
            _publication: self.publication,
        })
    }
    pub fn write_external_receipt(
        self,
        receipt: ExternalReceipt,
    ) -> Result<PreparedExternalReceipt> {
        Ok(PreparedExternalReceipt {
            receipt: ExternalReceiptMetadata {
                executor: receipt.executor,
                identity: receipt.identity,
                epoch: receipt.epoch,
                outcome: receipt.outcome,
                effect: receipt.effect,
                result_ref: self.content.save(&receipt.result)?,
            },
            _publication: self.publication,
        })
    }
}
impl Catalog {
    pub fn prepare_result_content(&self) -> ResultContentPreparation {
        ResultContentPreparation {
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
}
/// Trusted receipt consumers call this on their existing execution worker, never the control actor.
pub fn record_external_receipt(
    catalog: &std::sync::Mutex<Catalog>,
    operation_id: &str,
    receipt: ExternalReceipt,
    executor_stopped: bool,
) -> Result<Operation> {
    let preparation = catalog
        .lock()
        .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
        .prepare_result_content();
    let prepared = preparation.write_external_receipt(receipt)?;
    catalog
        .lock()
        .map_err(|_| RuntimeError::Invalid("catalog owner failed".into()))?
        .record_external_receipt_prepared(operation_id, prepared, executor_stopped)
}

pub struct EventRead {
    events: Vec<Event>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl EventRead {
    pub fn load(mut self) -> Result<Vec<Event>> {
        for event in &mut self.events {
            if matches!(
                event.kind.as_str(),
                "operation.accepted"
                    | "operation.dispatched"
                    | "operation.settled"
                    | "operation.external_receipt"
                    | "operation.recovered"
                    | "permission.opened"
            ) {
                let operation: Operation = serde_json::from_value(event.data.take())?;
                event.data = serde_json::to_value(super::tool_content::hydrate_operation(
                    operation,
                    &self.content,
                )?)?;
            }
        }
        Ok(self.events)
    }
}
impl Catalog {
    pub fn capture_events_read(&self, cursor: u64, limit: u32) -> Result<EventRead> {
        Ok(EventRead {
            events: self.events_after(cursor, limit)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}
