//! Authenticated Host command for User-created child work. No model/tool invocation is synthesized.
use super::*;
use varin_runtime::catalog::user_dispatch::{
    UserChildDispatchAcceptParams, UserChildDispatchCatalogParams, UserChildDispatchCommand,
};

pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    host: crate::host_tools::ToolBridge,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
    cancel: &varin_runtime::execution::CancellationToken,
) -> Result<Value, KernelError> {
    let owner = runtime.catalog();
    let lock = || {
        owner
            .lock()
            .map_err(|_| KernelError::Storage("Catalog unavailable".into()))
    };
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    if method == "runtime.child.user.catalog" {
        let p: UserChildDispatchCatalogParams = serde_json::from_value(params)?;
        let read = lock()?
            .capture_user_child_dispatch_catalog(p)
            .map_err(domain)?;
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    let (command, attachments, media) = if method == "runtime.child.user.accept" {
        serde_json::from_value::<UserChildDispatchAcceptParams>(params)?.into_parts()
    } else {
        (
            serde_json::from_value::<UserChildDispatchCommand>(params)?,
            Vec::new(),
            Vec::new(),
        )
    };
    // The exact original receipt precedes source/model lookup, even after settings changes.
    let receipt = lock()?
        .user_child_dispatch_receipt(&command)
        .map_err(domain)?;
    if receipt.is_some() || method == "runtime.child.user.receipt" {
        return Ok(serde_json::to_value(receipt)?);
    }
    let captured = lock()?
        .capture_user_child_dispatch(command.clone())
        .map_err(domain)?;
    let selected = captured
        .load()
        .map_err(domain)?
        .with_attachments(attachments, media)
        .map_err(domain)?;
    let selected = {let catalog=lock()?; selected.with_model_references(&catalog).map_err(domain)?};
    let (resolved, tools) = crate::collaboration::resolve_selection_with_attachments(
        &selected.selection,
        &selected.input,
        &selected.attachments,
    )
    .map_err(|error| KernelError::Operation(error.message))?;
    let (operation_id, parent_run_id, execution_epoch) = selected.retention_identity();
    let binding = crate::source_resources::SourceMcpChildBinding {
        operation_id,
        parent_run_id,
        execution_epoch,
        execution_owner: varin_runtime::ExecutorOwner::Kernel,
    };
    let launch = varin_runtime::catalog::launches::LaunchSelection {
        driver: varin_runtime::driver::DriverSelection::default(),
        driver_models: Vec::new(),
        agent: resolved.agent.clone(),
        child_dispatch: Some(selected.selection.catalog.clone()),
        extension_bindings: resolved.extension_bindings.clone(),
        policy_models: Vec::new(),
        mcp_binding: resolved.mcp_binding.clone(),
        credential_scope: resolved.model.credential_scope.clone(),
        connection_identity: resolved.model.connection_identity().map_err(domain)?,
        provider_family: resolved.model.configuration.provider_family.clone(),
        model: resolved.model.configuration.model.clone(),
        configuration_generation: resolved.model.configuration.configuration_generation,
        tool_schema_generation: resolved.tool_schema_generation,
        tools,
        policy: crate::observations::default_policy_identity(),
        source: None,
    };
    let mcp_binding = resolved.mcp_binding.clone();
    let extension_bindings = resolved.extension_bindings.clone();
    let launch = lock()?
        .prepare_child_launch(&command.run_id, launch, resolved)
        .map_err(domain)?;
    let prepared = selected
        .prepare(launch.load().map_err(domain)?)
        .map_err(domain)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    lock()?
        .stage_user_child_dependencies(&prepared)
        .map_err(domain)?;
    let outcome = (|| {
        // The selected model is retained by the existing explicit-model owner after admission.
        // Tool dependencies still require the exact original Run owners; no fresh substitute.
        let retained = host
            .retain_child(
                &binding,
                mcp_binding.as_ref(),
                &extension_bindings,
                None,
                cancel,
            )
            .map_err(|error| {
                KernelError::Operation(format!("{}: {}", error.code, error.message))
            })?;
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let mut catalog = lock()?;
        catalog.accept_child_references(prepared).map_err(domain)?;
        if let Some(retained) = retained {
            retained.handoff();
        }
        Ok(serde_json::to_value(
            catalog
                .user_child_dispatch_receipt(&command)
                .map_err(domain)?,
        )?)
    })();
    if outcome.is_err() {
        // A failed remote ACK/release can leave a durable retain even without a local handle.
        // Preserve its original cleanup duty; never create a child or retry a different owner.
        lock()?
            .abort_user_child_dependencies(&command, cancelled.load(Ordering::Acquire))
            .map_err(domain)?;
    }
    outcome
}
