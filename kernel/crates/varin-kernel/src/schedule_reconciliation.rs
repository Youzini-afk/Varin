//! Recover the original project scheduler callback through its existing Source receipt.
//! Catalog owns A's invocation and external owner; B's Source only proves the result.
//! No current grant, new invocation, calendar action or task execution is created here.
use crate::{
    error::KernelError,
    tools::{KernelResourceClient, ToolBinding},
};
use serde_json::{json, Value};
use varin_runtime::execution::{CancellationToken, CompletionKind, ToolInvocation};
use varin_runtime::{
    supervisor::RunSupervisor, Effect, ExecutorOwner, ExternalReceipt, Operation, Outcome,
};

fn error(value: impl std::fmt::Display) -> KernelError {
    KernelError::Operation(value.to_string())
}
fn denied(value: &str) -> KernelError {
    KernelError::Authorization(value.into())
}

pub(crate) fn invocation(operation: &Operation) -> Result<ToolInvocation, KernelError> {
    let invocation: ToolInvocation = serde_json::from_value(operation.intent.clone())?;
    let origin_valid = match &invocation.origin {
        varin_runtime::execution::ToolOrigin::ModelStep { request_id } => !request_id.is_empty(),
        varin_runtime::execution::ToolOrigin::PolicyAction { action_id, node_id } => {
            !action_id.is_empty() && !node_id.is_empty() && node_id == &invocation.call.call_id
        }
        varin_runtime::execution::ToolOrigin::NestedCall {
            parent_operation_id,
        } => !parent_operation_id.is_empty(),
    };
    // Extension schema versions are retained declaration hashes, not the service's
    // numeric version and not a later generation's currently selected schema.
    if operation.executor.as_deref() != Some("scheduled_task")
        || invocation.call.name != "scheduled_task"
        || invocation.call.schema_version.is_empty()
        || invocation.contract.name != invocation.call.name
        || invocation.contract.schema_version != invocation.call.schema_version
        || invocation.contract.read_only
        || invocation.contract.completion != CompletionKind::Result
        || invocation.call.call_id.is_empty()
        || !origin_valid
        || invocation.origin.operation_id(&invocation.call.call_id) != operation.id
        || operation.execution_owner.as_ref().is_none_or(|owner| {
            !matches!(owner, ExecutorOwner::External { .. }) || !owner.validate()
        })
        || !matches!(
            invocation.call.arguments["action"].as_str(),
            Some(
                "list"
                    | "get"
                    | "status"
                    | "read_loop"
                    | "upsert"
                    | "write_loop"
                    | "set_enabled"
                    | "remove"
                    | "remove_loop"
                    | "run"
                    | "cancel_occurrence"
                    | "retry_occurrence"
                    | "retry_calculation"
            )
        )
    {
        return Err(denied(
            "Schedule reconciliation differs from its original Tool invocation",
        ));
    }
    Ok(invocation)
}

pub(crate) fn reconcile(
    runtime: &RunSupervisor,
    resources: &KernelResourceClient,
    binding: Option<&ToolBinding>,
    operation_id: &str,
    expected_owner: Option<&ExecutorOwner>,
) -> Result<bool, KernelError> {
    let owner = runtime.catalog();
    let (read, run, source, delivered) = {
        let catalog = owner.lock().map_err(error)?;
        let operation = catalog.operation(operation_id).map_err(error)?;
        if operation.executor.as_deref() != Some("scheduled_task")
            || operation
                .execution_owner
                .as_ref()
                .is_none_or(|owner| !matches!(owner, ExecutorOwner::External { .. }))
            || expected_owner
                .is_some_and(|expected| operation.execution_owner.as_ref() != Some(expected))
        {
            return Err(denied(
                "Schedule reconciliation changed its original Tool owner",
            ));
        }
        let run = catalog.run(&operation.run_id).map_err(error)?;
        let source = catalog
            .launch_metadata(&run.id)
            .map_err(error)?
            .and_then(|launch| launch.selection.source)
            .ok_or_else(|| denied("Original project schedule Source is unavailable"))?;
        if source.resource_owner.is_local() {
            return Err(denied(
                "Schedule receipt recovery requires its original managed Source",
            ));
        }
        if let Some(binding) = binding {
            if run.id != binding.run_id
                || run.thread_id != binding.thread_id
                || source != binding.source_selection()?
            {
                return Err(denied(
                    "Schedule reconciliation binding differs from its original Source",
                ));
            }
        }
        let delivered = catalog
            .external_delivery_persisted(operation_id)
            .map_err(error)?;
        (
            catalog.capture_operation_read(operation),
            run,
            source,
            delivered,
        )
    };
    let (operation, original) = read.load_with_external_receipt().map_err(error)?;
    let invocation = invocation(&operation)?;
    if delivered {
        // A's immutable, stopped receipt is already durable. B may have released
        // its body, so only retry its original idempotent cleanup after the ACK.
        resources.schedule_project_receipt_release(operation.id);
        return Ok(true);
    }
    let value = resources
        .source_query(
            json!({"kind":"schedule_receipt","phase":"observe","source":source,
        "runId":run.id,"threadId":run.thread_id,"operationId":operation.id}),
            &CancellationToken::default(),
        )
        .map_err(error)?;
    if value.is_null() {
        return Ok(false);
    }
    if value["operationId"] != operation.id
        || !value["accepted"].is_boolean()
        || !value["executorStopped"].is_boolean()
    {
        return Err(denied(
            "Original project schedule receipt identity is malformed",
        ));
    }
    if value["accepted"] != true {
        if value["executorStopped"] == true {
            return Err(denied(
                "Unaccepted schedule callback cannot prove executor stop",
            ));
        }
        return Ok(false);
    }
    let source_owner: ExecutorOwner = serde_json::from_value(value["executionOwner"].clone())?;
    if !source_owner.validate()
        || !matches!(&source_owner, ExecutorOwner::External { epoch, .. }
        if !epoch.is_empty() && Some(epoch.as_str()) == value["resourceEpoch"].as_str())
    {
        return Err(denied(
            "Original project schedule Source receipt owner is malformed",
        ));
    }
    let receipt: crate::storage::source_schedule_receipts::SourceScheduleToolReceipt =
        serde_json::from_value(value["result"].clone())?;
    let crate::storage::source_schedule_receipts::SourceScheduleCompletion::Result {
        outcome,
        effect,
        content,
    } = receipt.completion;
    let read_only = matches!(
        invocation.call.arguments["action"].as_str(),
        Some("list" | "get" | "status" | "read_loop")
    );
    if value["executorStopped"] != receipt.executor_stopped
        || !matches!(
            outcome,
            Outcome::Succeeded | Outcome::Failed | Outcome::Indeterminate
        )
        || !matches!(effect, Effect::None | Effect::Confirmed | Effect::Unknown)
        || (effect == Effect::Unknown && outcome != Outcome::Indeterminate)
        || (read_only && effect == Effect::Confirmed)
        || !content.parts.is_empty()
        || (!receipt.executor_stopped
            && (outcome != Outcome::Indeterminate || effect != Effect::Unknown))
    {
        return Err(denied(
            "Original project schedule receipt has inconsistent effect or stop evidence",
        ));
    }
    if !receipt.executor_stopped {
        return Ok(false);
    }
    // Unknown→Unknown only adds factual stop evidence, preserving A's first body.
    // Known facts can never be rewritten by a later transport observation.
    let preserved = match original {
        Some(previous) if previous.effect != Effect::Unknown => {
            if previous.effect != effect || previous.outcome != outcome {
                return Err(denied("Confirmed schedule receipt changed"));
            }
            Some(previous)
        }
        Some(previous) if effect == Effect::Unknown => Some(previous),
        _ => None,
    };
    let execution_owner = operation
        .execution_owner
        .as_ref()
        .expect("validated original owner");
    let ExecutorOwner::External { epoch, .. } = execution_owner else {
        unreachable!()
    };
    let preparation = owner.lock().map_err(error)?.prepare_result_content();
    let prepared = preparation
        .write_external_receipt(preserved.unwrap_or_else(|| ExternalReceipt {
            executor: "scheduled_task".into(),
            identity: operation.id.clone(),
            epoch: epoch.clone(),
            outcome,
            effect,
            result: content,
        }))
        .map_err(error)?;
    owner
        .lock()
        .map_err(error)?
        .record_external_tool_receipt_prepared(&operation.id, execution_owner, prepared, true)
        .map_err(error)?;
    // Spawning is nonblocking and the helper independently verifies the original
    // durable delivery/stop proof. Unknown effects retain B's receipt for recovery.
    let confirmed = effect != Effect::Unknown && outcome != Outcome::Indeterminate;
    if confirmed {
        resources.schedule_project_receipt_release(operation.id);
    }
    Ok(confirmed)
}

#[cfg(test)]
#[path = "schedule_reconciliation_review.rs"]
mod review;
