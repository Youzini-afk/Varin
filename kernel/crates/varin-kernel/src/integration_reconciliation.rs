//! Original Host Tool receipt recovery from the existing Integration journal, on a request worker.
use crate::{
    error::KernelError,
    tools::{KernelResourceClient, ToolBinding},
};
use serde_json::{json, Value};
use varin_runtime::execution::ToolInvocation;
use varin_runtime::{supervisor::RunSupervisor, Effect, ExecutorOwner, ExternalReceipt, Outcome};
fn error(value: impl std::fmt::Display) -> KernelError {
    KernelError::Operation(value.to_string())
}

pub(crate) fn reconcile(
    runtime: &RunSupervisor,
    resources: &KernelResourceClient,
    binding: Option<&ToolBinding>,
    operation_id: &str,
    expected_owner: Option<&ExecutorOwner>,
) -> Result<bool, KernelError> {
    let owner = runtime.catalog();
    let (read, run, source) = {
        let catalog = owner.lock().map_err(error)?;
        let operation = catalog.operation(operation_id).map_err(error)?;
        let run = catalog.run(&operation.run_id).map_err(error)?;
        let source = catalog
            .launch_metadata(&run.id)
            .map_err(error)?
            .and_then(|launch| launch.selection.source)
            .ok_or_else(|| error("original Integration source is unavailable"))?;
        if operation.executor.as_deref() != Some("integrate_child")
            || operation
                .execution_owner
                .as_ref()
                .is_none_or(|value| !matches!(value, ExecutorOwner::External { .. }))
            || expected_owner
                .is_some_and(|expected| operation.execution_owner.as_ref() != Some(expected))
        {
            return Err(KernelError::Authorization(
                "Integration reconciliation changed its original Tool owner or source".into(),
            ));
        }
        if let Some(binding) = binding {
            if run.id != binding.run_id
                || run.thread_id != binding.thread_id
                || source != binding.source_selection()?
            {
                return Err(KernelError::Authorization(
                    "Integration current binding differs from original source".into(),
                ));
            }
        }
        (catalog.capture_operation_read(operation), run, source)
    };
    let operation = read.load().map_err(error)?;
    let invocation: ToolInvocation = serde_json::from_value(operation.intent.clone())?;
    if invocation.call.name != "integrate_child"
        || invocation.call.schema_version != "2"
        || invocation.origin.operation_id(&invocation.call.call_id) != operation.id
    {
        return Err(KernelError::Authorization(
            "Integration Tool origin differs from its admitted intent".into(),
        ));
    }
    let child_id = invocation.call.arguments["childOperationId"]
        .as_str()
        .ok_or_else(|| error("Integration child identity missing"))?;
    let execution_id = invocation.call.arguments["executionId"]
        .as_str()
        .ok_or_else(|| error("Integration execution identity missing"))?;
    let publication = invocation.call.arguments["publicationId"]
        .as_str()
        .ok_or_else(|| error("Integration publication missing"))?;
    let child = owner
        .lock()
        .map_err(error)?
        .execution_task(execution_id)
        .map_err(error)?;
    let varin_runtime::catalog::collaboration::ChildCodeResult::Published { result, .. } =
        child.code_result
    else {
        return Err(error("Integration child result is not fixed"));
    };
    if child.operation_id != child_id
        || child.parent_thread_id != run.thread_id
        || child.parent_branch_id != run.branch_id
        || result.publication_id != publication
        || result.workspace_id != source.workspace_id
    {
        return Err(KernelError::Authorization(
            "Integration result belongs to another parent branch".into(),
        ));
    }
    let expected = json!({"kind":"runtime_operation","operationId":operation.id,"parentRunId":run.id,"parentThreadId":run.thread_id,"parentBranchId":run.branch_id,
        "origin":invocation.origin,"callId":invocation.call.call_id,"childOperationId":child_id,"childExecutionId":execution_id,"childThreadId":child.child_thread_id,
        "result":{"workspaceId":result.workspace_id,"branchId":result.branch_id,"resultRevision":result.result_revision,"root":result.root,"publicationId":publication},"target":source});
    let id = format!("integration:{}", operation.id);
    let journal = resources.integration_receipt(
        source.clone(),
        run.id.clone(),
        run.thread_id.clone(),
        operation.id.clone(),
    )?;
    if journal.is_null() {
        return Ok(false);
    }
    let mut data = journal["data"]
        .as_object()
        .ok_or_else(|| error("Integration journal data is malformed"))?
        .clone();
    if let Some(result) = journal["result"].as_object() {
        data.extend(result.clone());
    }
    let data = Value::Object(data);
    if data["operationBinding"] != expected
        || journal["threadId"] != run.thread_id
        || journal["runId"] != run.id
    {
        return Err(KernelError::Authorization(
            "Integration journal does not identify this original Tool invocation".into(),
        ));
    }
    // Business uncertainty and executor stop are independent. No stop evidence means no recovery
    // completion, and this path never compensates or retries the journal's effects.
    if data["executorStopped"] != true {
        return Ok(false);
    }
    let state = journal["state"]
        .as_str()
        .ok_or_else(|| error("Integration journal state missing"))?;
    let files = journal["files"]
        .as_array()
        .ok_or_else(|| error("Integration file phases missing"))?;
    let terminal = matches!(
        state,
        "complete" | "conflict" | "compensated" | "aborted" | "undone"
    );
    let strings = |field: &str| -> Result<Vec<String>, KernelError> {
        data[field]
            .as_array()
            .ok_or_else(|| error(format!("Integration {field} missing")))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| error("invalid Integration path"))
            })
            .collect()
    };
    let applied = strings("appliedPaths")?;
    let compensated = strings("compensatedPaths")?;
    let conflicts = strings("conflictPaths")?;
    let attention = strings("needsAttentionPaths")?;
    if applied
        .iter()
        .chain(&compensated)
        .any(|path| !files.iter().any(|file| file["path"].as_str() == Some(path)))
    {
        return Err(error("Integration outcome has no original file phase"));
    }
    for file in files {
        let path = file["path"]
            .as_str()
            .ok_or_else(|| error("Integration file path missing"))?;
        let phase = file["phase"]
            .as_str()
            .ok_or_else(|| error("Integration file phase missing"))?;
        if terminal
            && applied.iter().any(|value| value == path)
            && !compensated.iter().any(|value| value == path)
            && !matches!(
                phase,
                "target-observed"
                    | "external-target-observed"
                    | "surface-applied"
                    | "disk-applied"
                    | "branch-applied"
            )
        {
            return Ok(false);
        }
        if terminal
            && compensated.iter().any(|value| value == path)
            && !matches!(
                phase,
                "safety-observed"
                    | "external-safety-observed"
                    | "compensated"
                    | "surface-compensated"
            )
        {
            return Ok(false);
        }
        // An external intent is only an unissued plan. With the original stop receipt above,
        // it is safe only when it claims neither an applied nor a compensated file effect.
        if terminal
            && phase == "external-intent"
            && (applied.iter().any(|value| value == path)
                || compensated.iter().any(|value| value == path))
        {
            return Ok(false);
        }
        if terminal
            && matches!(
                phase,
                "apply-intent" | "external-dispatched" | "compensate-intent" | "undo-intent"
            )
        {
            return Ok(false);
        }
    }
    let remaining = applied
        .iter()
        .filter(|path| !compensated.contains(path))
        .count();
    let effect = if !terminal {
        Effect::Unknown
    } else if remaining == 0 {
        if compensated.is_empty() {
            Effect::None
        } else {
            Effect::Confirmed
        }
    } else if state == "complete" {
        Effect::Confirmed
    } else {
        Effect::Partial
    };
    let status = match state {
        "complete" => "applied",
        "conflict" => "conflict",
        "compensated" | "undone" => "compensated",
        _ => "needs-attention",
    };
    let outcome = if effect == Effect::Unknown || status == "needs-attention" {
        Outcome::Indeterminate
    } else if status == "applied" {
        Outcome::Succeeded
    } else {
        Outcome::Failed
    };
    let changed = data["retryBinding"]["childStates"]
        .as_object()
        .ok_or_else(|| error("native Integration child states missing"))?
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let stats = data["diffStats"]
        .as_object()
        .ok_or_else(|| error("native Integration diff stats missing"))?;
    if ["files", "insertions", "deletions"]
        .iter()
        .any(|key| stats.get(*key).and_then(Value::as_u64).is_none())
    {
        return Err(error("native Integration diff stats malformed"));
    }
    let projection = json!({"operationId":id,"status":status,"appliedPaths":applied,"conflictPaths":conflicts,"compensatedPaths":compensated,
        "needsAttentionPaths":attention,"diffStats":data["diffStats"],"changedFiles":changed,"text":format!("Recorded integration {id}: {state}"),
        "receipt":{"kind":"integration","workspaceId":source.workspace_id,"operationId":id,"revision":journal["revision"],"state":state},
        "effect":effect,"executorStopped":true,"recoveryCoverage":"files-only"});
    let preserved = if let Some(previous) = &operation.external_receipt {
        if previous.effect != Effect::Unknown {
            if previous.effect != effect || previous.outcome != outcome {
                return Err(error("confirmed Integration receipt changed"));
            }
            Some(previous.clone())
        } else if effect == Effect::Unknown {
            Some(previous.clone())
        } else {
            None
        }
    } else {
        None
    };
    let execution_owner = operation.execution_owner.as_ref().unwrap();
    let ExecutorOwner::External { epoch, .. } = execution_owner else {
        unreachable!()
    };
    let preparation = owner.lock().map_err(error)?.prepare_result_content();
    let prepared = preparation
        .write_external_receipt(preserved.unwrap_or_else(|| ExternalReceipt {
            executor: "integrate_child".into(),
            identity: operation.id.clone(),
            epoch: epoch.clone(),
            outcome,
            effect,
            result: projection,
        }))
        .map_err(error)?;
    owner
        .lock()
        .map_err(error)?
        .record_external_tool_receipt_prepared(&operation.id, execution_owner, prepared, true)
        .map_err(error)?;
    Ok(effect != Effect::Unknown)
}

#[cfg(test)]
#[path = "integration_reconciliation_review.rs"]
mod review;
