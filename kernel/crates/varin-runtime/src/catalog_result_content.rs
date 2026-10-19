//! Immutable tool and executor bodies are prepared/read by workers; Catalog commits metadata.
use super::*;
use crate::execution::{ToolCompletion, ToolOrigin, ToolResult};
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
    pub(crate) fn load(
        self,
        content: &crate::content::ContentStore,
    ) -> Result<crate::output::OperationResult> {
        match self {
            Self::Control { value } => Ok(crate::output::OperationResult::Control { value }),
            Self::Content { reference } => Ok(crate::output::OperationResult::Output {
                output: content.load_stored_output(&reference)?,
            }),
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
        #[serde(skip_serializing_if = "Option::is_none")]
        content_ref: Option<Value>,
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
                content_ref: content.save_output(body)?,
            },
            ToolCompletion::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
                content: body,
            } => ToolCompletionMetadata::JobAccepted {
                operation_id: operation_id.clone(),
                phase: phase.clone(),
                effect: *effect,
                lifetime: *lifetime,
                content_ref: body.as_ref().map(|v| content.save_output(v)).transpose()?,
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
                content: content.load_output(&content_ref)?,
            },
            ToolCompletionMetadata::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
                content_ref,
            } => ToolCompletion::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
                content: content_ref.map(|v| content.load_output(&v)).transpose()?,
            },
        })
    }
    pub(crate) fn load_stored(
        self,
        content: &crate::content::ContentStore,
    ) -> Result<ToolCompletion<crate::output::StoredMedia>> {
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
                content: content.load_stored_output(&content_ref)?,
            },
            ToolCompletionMetadata::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
                content_ref,
            } => ToolCompletion::JobAccepted {
                operation_id,
                phase,
                effect,
                lifetime,
                content: content_ref
                    .map(|v| content.load_stored_output(&v))
                    .transpose()?,
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
    /// Explicit non-output input/control material; never interpret opaque JSON as an output body.
    pub fn write_data(self, data: &Value) -> Result<PreparedOperationResult> {
        Ok(PreparedOperationResult {
            reference: self.content.save(data)?,
            _publication: self.publication,
        })
    }
    pub fn write_output(
        self,
        output: &crate::output::OutputBody,
    ) -> Result<PreparedOperationResult> {
        Ok(PreparedOperationResult {
            reference: self.content.save_output(output)?,
            _publication: self.publication,
        })
    }
    pub fn write_result(self, result: &Value) -> Result<PreparedOperationResult> {
        Ok(PreparedOperationResult {
            reference: self.content.save_output(&result.clone().into())?,
            _publication: self.publication,
        })
    }
    pub fn write_external_receipt(
        self,
        receipt: ExternalReceipt,
    ) -> Result<PreparedExternalReceipt> {
        Ok(PreparedExternalReceipt {
            receipt: ExternalReceiptMetadata {
                executor_stopped: false,
                executor: receipt.executor,
                identity: receipt.identity,
                epoch: receipt.epoch,
                outcome: receipt.outcome,
                effect: receipt.effect,
                result_ref: self.content.save_output(&receipt.result)?,
            },
            _publication: self.publication,
        })
    }
}
impl Catalog {
    /// Capture the acceptance owned by the actual Job domain. A HostJob may be
    /// accepted after an Unknown invocation completion was already delivered;
    /// its acceptance_ref, rather than that first completion, remains canonical.
    pub fn capture_job_acceptance(&self, operation_id: &str) -> Result<ToolCompletionRead> {
        let operation = self.operation(operation_id)?;
        if operation.host_job.is_none() && operation.managed_process.is_some() {
            self.capture_call_completion(operation_id)
        } else {
            self.host_job_acceptance(operation_id)
        }
    }
    /// Read the exact invocation completion already committed by its owning domain.
    /// Capturing is a short metadata operation; the existing reader resolves bytes off-lock.
    pub fn capture_call_completion(&self, operation_id: &str) -> Result<ToolCompletionRead> {
        let operation = self.operation(operation_id)?;
        let completion = operation
            .call_completion
            .ok_or_else(|| RuntimeError::NotFound("canonical invocation completion".into()))?;
        Ok(ToolCompletionRead {
            completion,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
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
            if event.kind == "followup.source_observed" {
                if let Some(reference) = event
                    .data
                    .as_object_mut()
                    .and_then(|data| data.remove("content_ref"))
                {
                    event.data["content"] = self.content.load(&reference)?;
                }
            }
            if event.kind == "operation.executor_stopped" {
                if let Some(stop) = event.data.get_mut("host_job_stop") {
                    let receipt: ExternalReceiptMetadata =
                        serde_json::from_value(stop["receipt"].take())?;
                    stop["receipt"] = json!({"executor":receipt.executor,"identity":receipt.identity,"epoch":receipt.epoch,"outcome":receipt.outcome,"effect":receipt.effect,"executor_stopped":receipt.executor_stopped,"result":self.content.load(&receipt.result_ref)?});
                }
            }
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

/// Canonical invocation acceptance is separate from the eventual Job terminal fact.
pub(super) fn publish_job_acceptance(
    tx: &Transaction<'_>,
    op: &mut Operation,
    admitted: &super::tool_content::ToolIntent,
    phase: &str,
) -> Result<()> {
    publish_job_acceptance_content(tx,op,admitted,phase,None)
}
pub(super) fn publish_job_acceptance_content(
    tx:&Transaction<'_>,op:&mut Operation,admitted:&super::tool_content::ToolIntent,phase:&str,content_ref:Option<Value>,
) -> Result<()> {
    let completion = super::result_content::ToolCompletionMetadata::JobAccepted {
        operation_id: op.id.clone(),
        phase: phase.into(),
        effect: Effect::None,
        lifetime: Lifetime::Thread,
        content_ref,
    };
    if op
        .call_completion
        .as_ref()
        .is_some_and(|previous| previous != &completion)
    {
        return Err(RuntimeError::Conflict(
            "original invocation acceptance changed".into(),
        ));
    }
    op.call_completion = Some(completion.clone());
    if let ToolOrigin::ModelStep { request_id } = admitted.origin() {
        let receipt = super::result_content::ToolReceiptMetadata {
            request_id: request_id.clone(),
            call_id: admitted.call().call_id.clone(),
            completion,
        };
        tx.execute(
            "UPDATE tool_calls SET receipt=?3 WHERE request_id=?1 AND call_id=?2",
            params![request_id, admitted.call().call_id, encode(&receipt)?],
        )?;
    }
    Ok(())
}

/// The invocation receipt must be consumed by its real caller before a Job can append history.
/// A model pairs its tool row; a policy graph consumes the same canonical completion at its node.
pub(super) fn job_acceptance_consumed(db: &Connection, op: &Operation) -> Result<bool> {
    let admitted = super::tool_content::ToolIntent::from_operation(op)?;
    let Some(completion) = &op.call_completion else {
        return Ok(false);
    };
    let receipt: Option<String> = match admitted.origin() {
        // The canonical Operation acceptance is the nested caller's receipt. No model pairing
        // or second consumption ledger is invented for a callback that may omit its output.
        ToolOrigin::NestedCall { .. } => return Ok(matches!(completion, ToolCompletionMetadata::JobAccepted { .. })),
        ToolOrigin::ModelStep { request_id } => db.query_row(
            "SELECT receipt FROM tool_calls WHERE request_id=?1 AND call_id=?2 AND committed=1",
            params![request_id, admitted.call().call_id], |row| row.get(0),
        ).optional()?.flatten(),
        ToolOrigin::PolicyAction { action_id, node_id } => db.query_row(
            "SELECT receipt FROM policy_graph_nodes WHERE action_id=?1 AND node_id=?2 AND call_id=?3",
            params![action_id, node_id, admitted.call().call_id], |row| row.get(0),
        ).optional()?.flatten(),
    };
    let Some(receipt) = receipt else {
        return Ok(false);
    };
    let receipt: Value = serde_json::from_str(&receipt)?;
    Ok(receipt.get("completion") == Some(&serde_json::to_value(completion)?))
}
