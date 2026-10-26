use super::*;
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    let params: KernelExternalCommandParams = serde_json::from_value(params)?;
    if params.command["action"]
        .as_str()
        .is_some_and(|s| s.starts_with("child_"))
    {
        return varin_runtime::catalog::external_children::execute(
            &runtime.catalog(),
            params.command,
        )
        .map_err(domain);
    }
    let command: varin_runtime::catalog::external::ExternalCommand =
        serde_json::from_value(params.command)?;
    let owner = runtime.catalog();
    let lock = || {
        owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))
    };
    let preparation = lock()?.prepare_external(command);
    let prepared = preparation.load().map_err(domain)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let read = lock()?.execute_external(prepared).map_err(domain)?;
    read.load().map_err(domain)
}
