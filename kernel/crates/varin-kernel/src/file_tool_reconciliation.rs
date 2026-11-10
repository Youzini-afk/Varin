//! Recover external format/download writes from the original native file.apply receipt.
use crate::{error::KernelError, tools::{KernelResourceClient, ToolBinding}};
use serde_json::{Value, json};
use varin_runtime::{Effect, ExecutorOwner, ExternalReceipt, Outcome, execution::ToolInvocation, supervisor::RunSupervisor};
fn error(value: impl std::fmt::Display) -> KernelError { KernelError::Operation(value.to_string()) }

/// Project the original file receipt without dropping its fixed artifact when
/// the Host response was lost. The native write remains the only byte owner.
pub(crate) fn recovered_output(file: &Value, operation_id: &str) -> Result<varin_runtime::output::OutputBody, KernelError> {
    let applied = match file["status"].as_str() { Some("applied") => true, Some("conflict") => false,
        _ => return Err(error("File receipt is not settled")) };
    let state: Value = serde_json::from_str(file["stateJson"].as_str().ok_or_else(|| error("File state is missing"))?)?;
    let mut data = json!({"status":if applied{"applied"}else{"conflict"},"path":file["path"],"operationId":operation_id,
        "revision":state["objectHash"],"byteLength":state["byteLength"],"executorStopped":true,"fileJournal":true});
    let mut parts = Vec::new();
    if let Some(value) = file.get("attachment") {
        let attachment: varin_runtime::catalog::attachments::Attachment = serde_json::from_value(value.clone())?;
        attachment.validate().map_err(error)?;
        if !applied || state["kind"] != "regular-file" || state["byteLength"].as_u64() != Some(attachment.byte_length) {
            return Err(error("File artifact differs from its original receipt"));
        }
        data["attachment"] = value.clone();
        parts.push(varin_runtime::output::OutputPart::Attachment { attachment });
    }
    Ok(varin_runtime::output::OutputBody { model_data: None, data, parts })
}

pub(crate) fn reconcile(runtime: &RunSupervisor, resources: &KernelResourceClient, binding: Option<&ToolBinding>,
    operation_id: &str, expected_owner: Option<&ExecutorOwner>) -> Result<bool, KernelError> {
    let owner = runtime.catalog();
    let (read, run, source) = {
        let catalog = owner.lock().map_err(error)?;
        let operation = catalog.operation(operation_id).map_err(error)?;
        let run = catalog.run(&operation.run_id).map_err(error)?;
        let Some(source) = catalog.launch_metadata(&run.id).map_err(error)?.and_then(|launch| launch.selection.source) else { return Ok(false); };
        if !matches!(operation.executor.as_deref(), Some("office_write" | "office_export" | "browser_files"))
            || !matches!(operation.execution_owner.as_ref(), Some(ExecutorOwner::External { .. }))
            || expected_owner.is_some_and(|expected| operation.execution_owner.as_ref() != Some(expected)) {
            return Err(KernelError::Authorization("File reconciliation changed its original executor".into()));
        }
        if let Some(binding) = binding {
            if binding.run_id != run.id || binding.thread_id != run.thread_id || binding.source_selection()? != source {
                return Err(KernelError::Authorization("File reconciliation changed its original source".into()));
            }
        }
        (catalog.capture_operation_read(operation), run, source)
    };
    let (operation, previous) = read.load_with_external_receipt().map_err(error)?;
    let invocation: ToolInvocation = serde_json::from_value(operation.intent.clone())?;
    if invocation.origin.operation_id(&invocation.call.call_id) != operation.id || operation.executor.as_deref() != Some(&invocation.call.name) {
        return Err(KernelError::Authorization("The original tool is not this file write".into()));
    }
    if invocation.call.name == "browser_files" && invocation.call.arguments["action"] != "save" { return Ok(false); }
    let saved = resources.file_receipt(source, run.id, run.thread_id, operation.id.clone())?;
    if saved.is_null() || saved["state"] != "committed" { return Ok(false); }
    if saved["tool"] != invocation.call.name { return Err(KernelError::Authorization("The file receipt belongs to another tool".into())); }
    let file = &saved["receipt"];
    let applied = match file["status"].as_str() { Some("applied") => true, Some("conflict") => false, _ => return Ok(false) };
    let effect = if applied { Effect::Confirmed } else { Effect::None };
    let outcome = if applied { Outcome::Succeeded } else { Outcome::Failed };
    let result = recovered_output(file, &operation.id)?;
    let execution_owner = operation.execution_owner.as_ref().unwrap();
    let ExecutorOwner::External { epoch, .. } = execution_owner else { unreachable!() };
    let receipt = match previous {
        Some(previous) if previous.effect != Effect::Unknown => {
            if previous.effect != effect || previous.outcome != outcome { return Err(error("The confirmed file receipt changed")); }
            previous
        }
        _ => ExternalReceipt { executor: invocation.call.name, identity: operation.id.clone(), epoch: epoch.clone(), outcome, effect, result },
    };
    let preparation = owner.lock().map_err(error)?.prepare_result_content();
    let prepared = preparation.write_external_receipt(receipt).map_err(error)?;
    owner.lock().map_err(error)?.record_external_tool_receipt_prepared(&operation.id, execution_owner, prepared, true).map_err(error)?;
    Ok(true)
}
