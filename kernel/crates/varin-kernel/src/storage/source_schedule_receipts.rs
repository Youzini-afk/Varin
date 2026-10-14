//! One dispatch fence and immutable receipt for the existing Host project scheduler.
//! This is an original Storage operation, not another calendar or task ledger.
//! Source workers stage and hydrate bodies; the owner commits only short references.
use super::*;
use crate::source_resources::{AuthorityRecord, SourceAuthorityAddress, SourceDispatch};
use serde::{Deserialize, Serialize};
use varin_runtime::execution::{ToolExecutionReceipt, ToolOrigin};
use varin_runtime::{Effect, ExecutorOwner, Outcome};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceScheduleInvocation {
    pub invocation_id: String,
    pub run_id: String,
    pub thread_id: String,
    pub operation_id: String,
    pub call_id: String,
    pub executor_owner: ExecutorOwner,
    pub origin: ToolOrigin,
    pub source: Option<varin_runtime::catalog::launches::SourceSelection>,
    pub tool_name: String,
    pub operation: String,
    pub completion: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration_identity: Option<String>,
    pub arguments: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceScheduleToolReceipt {
    pub executor_stopped: bool,
    pub completion: SourceScheduleCompletion,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SourceScheduleCompletion {
    Result {
        outcome: Outcome,
        effect: Effect,
        content: varin_runtime::output::OutputBody,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceScheduleReceiptParams {
    pub principal_id: String,
    pub coordinator_host_id: String,
    pub authority_id: String,
    pub resource_epoch: String,
    pub action: String,
    pub invocation: Option<SourceScheduleInvocation>,
    pub operation_id: Option<String>,
    pub receipt: Option<SourceScheduleToolReceipt>,
}

pub(crate) struct ScheduleReceiptPreparation {
    record: AuthorityRecord,
    operation_id: String,
    params_hash: String,
    receipt: SourceScheduleToolReceipt,
    root: PathBuf,
}
pub(crate) struct StagedScheduleReceipt {
    record: AuthorityRecord,
    operation_id: String,
    params_hash: String,
    staged: PathBuf,
    hash: String,
    byte_length: u64,
    outcome: Outcome,
    effect: Effect,
    executor_stopped: bool,
}
impl Drop for StagedScheduleReceipt {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.staged);
    }
}
impl ScheduleReceiptPreparation {
    pub(crate) fn stage(self) -> Result<(Value, StagedScheduleReceipt), KernelError> {
        let value = serde_json::to_value(&self.receipt)?;
        let bytes = serde_json::to_vec(&value)?;
        let SourceScheduleCompletion::Result {
            outcome, effect, ..
        } = self.receipt.completion;
        let staged = StagedScheduleReceipt {
            record: self.record,
            operation_id: self.operation_id,
            params_hash: self.params_hash,
            staged: self
                .root
                .join("staging")
                .join(format!("source-schedule-{}", Uuid::new_v4())),
            hash: format!("sha256-{}", hex::encode(Sha256::digest(&bytes))),
            byte_length: bytes.len() as u64,
            outcome,
            effect,
            executor_stopped: self.receipt.executor_stopped,
        };
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged.staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok((value, staged))
    }
}
pub(crate) struct ScheduleReceiptBody {
    value: Value,
    begin: bool,
    path: PathBuf,
    hash: String,
    byte_length: u64,
    _retention: blob_reads::BlobReadRetention,
}
impl ScheduleReceiptBody {
    pub(crate) fn load(mut self) -> Result<Value, KernelError> {
        let bytes = fs::read(&self.path)?;
        if bytes.len() as u64 != self.byte_length
            || format!("sha256-{}", hex::encode(Sha256::digest(&bytes))) != self.hash
        {
            return Err(KernelError::Storage(
                "Original schedule receipt object is corrupt".into(),
            ));
        }
        self.value[if self.begin { "receipt" } else { "result" }] = serde_json::from_slice(&bytes)?;
        Ok(self.value)
    }
}
fn denied(message: &str) -> KernelError {
    crate::source_resources::denied(message)
}
fn identity(record: &AuthorityRecord, prior: &Value) -> Result<(), KernelError> {
    if prior["kind"] != "source.schedule"
        || prior["result"]["authorityId"] != record.result.authority_id
        || prior["result"]["grantId"] != record.result.grant_id
    {
        return Err(denied(
            "Schedule operation belongs to another original authority",
        ));
    }
    Ok(())
}
fn action_readonly(invocation: &SourceScheduleInvocation) -> Result<bool, KernelError> {
    match invocation.arguments.get("action").and_then(Value::as_str) {
        Some("list" | "get" | "status" | "read_loop") => Ok(true),
        Some(
            "upsert" | "write_loop" | "set_enabled" | "remove" | "remove_loop" | "run"
            | "cancel_occurrence" | "retry_occurrence" | "retry_calculation",
        ) => Ok(false),
        _ => Err(denied(
            "Schedule action is not an original scheduler operation",
        )),
    }
}
impl Storage {
    pub(crate) fn source_schedule_receipt(
        &mut self,
        p: SourceScheduleReceiptParams,
        epoch: &str,
    ) -> Result<SourceDispatch, KernelError> {
        let address = SourceAuthorityAddress {
            principal_id: p.principal_id,
            coordinator_host_id: p.coordinator_host_id,
            authority_id: p.authority_id,
            resource_epoch: p.resource_epoch,
        };
        // Observation and late completion use original identity, never restored authority.
        let record = self.source_authority(&address, false, epoch)?;
        match p.action.as_str() {
            "begin" if p.operation_id.is_none() && p.receipt.is_none() => {
                let invocation = p
                    .invocation
                    .ok_or_else(|| denied("Original schedule invocation is required"))?;
                let origin_valid = match &invocation.origin {
                    ToolOrigin::ModelStep { request_id } => !request_id.is_empty(),
                    ToolOrigin::PolicyAction { action_id, node_id } => {
                        !action_id.is_empty()
                            && !node_id.is_empty()
                            && node_id == &invocation.call_id
                    }
                    ToolOrigin::NestedCall {
                        parent_operation_id,
                    } => !parent_operation_id.is_empty(),
                };
                if record.purpose != "source"
                    || record.result.scope.run_id() != Some(invocation.run_id.as_str())
                    || record.result.scope.thread_id() != invocation.thread_id
                    || invocation.source.as_ref() != Some(&record.result.source)
                    || record.result.source.resource_owner.is_local()
                    || invocation.invocation_id.is_empty()
                    || invocation.call_id.is_empty()
                    || !origin_valid
                    || invocation.origin.operation_id(&invocation.call_id)
                        != invocation.operation_id
                    || !matches!(invocation.executor_owner, ExecutorOwner::External { .. })
                    || !invocation.executor_owner.validate()
                    || invocation.tool_name != "scheduled_task"
                    || invocation.operation != "effect"
                    || invocation.completion != "result"
                {
                    return Err(denied(
                        "Schedule invocation differs from its original Source and Run",
                    ));
                }
                let read_only = action_readonly(&invocation)?;
                // Hash the complete immutable invocation, including arguments and the
                // coordinating extension owner, separately from the resource Source owner.
                let params_hash = hash_json(&json!([address, invocation]))?;
                let prior = self.operation_get(&json!({"operationId":invocation.operation_id}))?;
                if !prior.is_null() {
                    identity(&record, &prior)?;
                    if prior["paramsHash"] != params_hash {
                        return Err(denied("Original schedule invocation changed"));
                    }
                    return self.schedule_receipt_response(
                        &record,
                        &invocation.operation_id,
                        prior,
                        true,
                        false,
                    );
                }
                self.source_authority(&address, true, epoch)?;
                let grant = self.load_grant(&record.result.grant_id)?;
                if record.result.phase != "ready"
                    || grant.state != crate::model::GrantState::Active
                    || grant.kernel_epoch != epoch
                    || grant.thread_id.as_deref() != Some(invocation.thread_id.as_str())
                    || grant.run_id.as_deref() != Some(invocation.run_id.as_str())
                    || grant.owning_workspace.as_deref()
                        != Some(record.result.source.workspace_id.as_str())
                    || grant.execution_workspace.as_deref()
                        != Some(record.result.source.execution_workspace_id.as_str())
                    || !grant.path_scopes.iter().any(String::is_empty)
                {
                    return Err(denied(
                        "Original Source no longer admits project schedule work",
                    ));
                }
                self.conn.execute_batch("BEGIN IMMEDIATE")?;
                let admitted = (|| {
                    self.operation_begin(
                        &invocation.operation_id,
                        "source.schedule",
                        &params_hash,
                    )?;
                    self.record_operation_workspace(
                        &invocation.operation_id,
                        Some(&record.result.source.workspace_id),
                    )?;
                    self.conn.execute("UPDATE operations SET result_json=?2 WHERE operation_id=?1", params![invocation.operation_id,
                        serde_json::to_string(&json!({"authorityId":record.result.authority_id,"grantId":record.result.grant_id,"readOnly":read_only}))?])?;
                    Ok::<_, KernelError>(())
                })();
                if let Err(error) = admitted {
                    let _ = self.conn.execute_batch("ROLLBACK");
                    return Err(error);
                }
                self.conn.execute_batch("COMMIT")?;
                // Only this committed first admission permits the Host callback. A lost
                // acknowledgement leaves a started original operation, never fresh again.
                Ok(SourceDispatch::Ready(json!({"fresh":true,"receipt":null})))
            }
            "finish" if p.invocation.is_none() => {
                let id = p
                    .operation_id
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| denied("Original schedule operation is required"))?;
                let receipt = p
                    .receipt
                    .ok_or_else(|| denied("Original schedule receipt is required"))?;
                let prior = self.operation_get(&json!({"operationId":id}))?;
                identity(&record, &prior)?;
                let SourceScheduleCompletion::Result {
                    outcome,
                    effect,
                    content,
                } = &receipt.completion;
                if !matches!(
                    outcome,
                    Outcome::Succeeded | Outcome::Failed | Outcome::Indeterminate
                ) || !matches!(effect, Effect::None | Effect::Confirmed | Effect::Unknown)
                    || !content.parts.is_empty()
                    || (*effect == Effect::Unknown && *outcome != Outcome::Indeterminate)
                    || !receipt.executor_stopped
                    || (prior["result"]["readOnly"] == true && *effect == Effect::Confirmed)
                {
                    return Err(denied(
                        "Schedule receipt has inconsistent effect or stop evidence",
                    ));
                }
                Ok(SourceDispatch::ScheduleReceiptStage(
                    ScheduleReceiptPreparation {
                        record,
                        operation_id: id,
                        params_hash: prior["paramsHash"]
                            .as_str()
                            .ok_or_else(|| denied("Schedule identity missing"))?
                            .into(),
                        receipt,
                        root: self.root.clone(),
                    },
                ))
            }
            _ => Err(denied("Unknown or incomplete schedule receipt action")),
        }
    }
    fn schedule_receipt_response(
        &mut self,
        record: &AuthorityRecord,
        id: &str,
        prior: Value,
        begin: bool,
        cancel: bool,
    ) -> Result<SourceDispatch, KernelError> {
        identity(record, &prior)?;
        if prior["result"]["released"] == true {
            if begin {
                return Ok(SourceDispatch::Ready(json!({"fresh":false,"receipt":null})));
            }
            if !cancel {
                return Err(KernelError::Operation("Original schedule receipt body was released after delivery; it cannot be replayed".into()));
            }
        }
        let stopped = prior["state"] == "committed" && prior["result"]["executorStopped"] == true;
        let pending: ToolExecutionReceipt = ToolExecutionReceipt { executor_stopped: false, completion: varin_runtime::execution::ToolCompletion::Result {
            outcome: Outcome::Indeterminate, effect: Effect::Unknown,
            content: json!({"reason":"Original schedule callback has no durable completion; it cannot be replayed"}).into(),
        }};
        let value = if begin {
            json!({"fresh":false,"receipt":null})
        } else {
            json!({"operationId":id,"resourceEpoch":record.result.resource_epoch,"executionOwner":record.result.execution_owner,
                "accepted":true,"executorStopped":stopped,"result":if cancel { Value::Null } else { serde_json::to_value(pending)? },"process":null})
        };
        // Cancellation is not a callback stop. Its bounded control response carries
        // only actual stop metadata; the original body is read through observe/data.
        if prior["state"] != "committed" || cancel {
            return Ok(SourceDispatch::Ready(value));
        }
        let hash = prior["result"]["objectHash"].as_str().ok_or_else(|| {
            KernelError::Storage("Schedule receipt object identity is missing".into())
        })?;
        let byte_length = prior["result"]["byteLength"]
            .as_u64()
            .ok_or_else(|| KernelError::Storage("Schedule receipt length is missing".into()))?;
        Ok(SourceDispatch::ScheduleReceiptObserve(
            ScheduleReceiptBody {
                value,
                begin,
                path: object_path(&self.root, hash)?,
                hash: hash.into(),
                byte_length,
                _retention: self.blob_read_roots.retain(hash),
            },
        ))
    }
    pub(crate) fn recall_source_schedule(
        &mut self,
        record: &AuthorityRecord,
        id: &str,
        cancel: bool,
    ) -> Result<Option<SourceDispatch>, KernelError> {
        let prior = self.operation_get(&json!({"operationId":id}))?;
        if prior["kind"] != "source.schedule" {
            return Ok(None);
        }
        self.schedule_receipt_response(record, id, prior, false, cancel)
            .map(Some)
    }
    pub(crate) fn release_source_schedule(
        &mut self,
        address: &SourceAuthorityAddress,
        id: &str,
        epoch: &str,
    ) -> Result<Option<Value>, KernelError> {
        let mut prior = self.operation_get(&json!({"operationId":id}))?;
        if prior["kind"] != "source.schedule" {
            return Ok(None);
        }
        let record = self.source_authority(address, false, epoch)?;
        identity(&record, &prior)?;
        let released = prior["state"] == "committed";
        if released && prior["result"]["released"] != true {
            // Keep the exact invocation and completion fingerprints forever. Only
            // the acknowledged body becomes collectible; no dispatch is reopened.
            prior["result"]["released"] = json!(true);
            self.operation_finish(id, &prior["result"])?;
        }
        Ok(Some(
            json!({"operationId":id,"resourceEpoch":record.result.resource_epoch,
            "executionOwner":record.result.execution_owner,"released":released}),
        ))
    }
    pub(crate) fn publish_source_schedule(
        &mut self,
        staged: StagedScheduleReceipt,
    ) -> Result<(), KernelError> {
        let prior = self.operation_get(&json!({"operationId":staged.operation_id}))?;
        identity(&staged.record, &prior)?;
        if prior["paramsHash"] != staged.params_hash {
            return Err(denied("Original schedule admission changed"));
        }
        if prior["state"] == "committed" {
            if prior["result"]["objectHash"] != staged.hash
                || prior["result"]["byteLength"] != staged.byte_length
            {
                return Err(denied("Original schedule completion changed"));
            }
            return Ok(());
        }
        if prior["state"] != "started" {
            return Err(denied("Original schedule operation is unavailable"));
        }
        let object = object_path(&self.root, &staged.hash)?;
        let shard = object.parent().expect("content object shard");
        if !shard.exists() {
            fs::create_dir_all(shard)?;
            sync_directory(&self.root.join("objects"))?;
        }
        durable_rename(&staged.staged, &object)?;
        sync_directory(shard)?;
        sync_directory(&self.root.join("staging"))?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let published = (|| {
            self.conn.execute(
                "INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES(?1,?2)",
                params![
                    staged.hash,
                    i64::try_from(staged.byte_length).map_err(|_| KernelError::Storage(
                        "Schedule receipt object is too large".into()
                    ))?
                ],
            )?;
            self.conn
                .execute("DELETE FROM pending_gc_files WHERE hash=?1", [&staged.hash])?;
            self.operation_finish(&staged.operation_id, &json!({"authorityId":staged.record.result.authority_id,
                "grantId":staged.record.result.grant_id,"readOnly":prior["result"]["readOnly"],"objectHash":staged.hash,
                "byteLength":staged.byte_length,"executorStopped":staged.executor_stopped,"outcome":staged.outcome,"effect":staged.effect}))?;
            Ok::<_, KernelError>(())
        })();
        if let Err(error) = published {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(error);
        }
        self.conn.execute_batch("COMMIT")?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "source_schedule_receipts_tests.rs"]
mod tests;
