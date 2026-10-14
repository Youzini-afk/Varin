//! Host observer publication crosses the original Catalog content and ingress owners.
use super::*;
use varin_runtime::catalog::context_observations::{
    ContextObservationAdmit, ContextObservationSources,
};
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let owner = runtime.catalog();
    let lock = || {
        owner
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner failed".into()))
    };
    match method {
        "runtime.context.observations.sources" => {
            let p: ContextObservationSources = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?.context_observation_sources(&p).map_err(domain)?,
            )?)
        }
        "runtime.context.observations.admit" => {
            let p: ContextObservationAdmit = serde_json::from_value(params)?;
            let preparation = {
                let catalog = lock()?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                catalog.prepare_context_observations(p).map_err(domain)?
            };
            let prepared = preparation.load().map_err(domain)?;
            let receipts = {
                let mut catalog = lock()?;
                // Cancellation while waiting for the owner must still precede admission.
                if cancelled.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                catalog
                    .admit_context_observations(prepared)
                    .map_err(domain)?
            };
            // After commit, report the original result even if its observer has left.
            Ok(serde_json::to_value(receipts)?)
        }
        _ => Err(KernelError::Protocol(
            "Unknown context observation method".into(),
        )),
    }
}
