//! Host observer publication crosses the original Catalog content and ingress owners.
use super::*;
use varin_runtime::catalog::context_observations::{
    ContextObservationAdmit, ContextObservationCaptureBatch, ContextObservationImport,
    ContextObservationImportPosition, ContextObservationImportSources, ContextObservationRead,
    ContextObservationReceiptLookup, ContextObservationSnapshot, ContextObservationSources,
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
            let sources = lock()?.context_observation_sources(&p).map_err(domain)?;
            Ok(serde_json::to_value(sources)?)
        }
        "runtime.context.observations.importSources" => {
            let _: ContextObservationImportSources = serde_json::from_value(params)?;
            let sources = lock()?
                .context_observation_import_sources()
                .map_err(domain)?;
            Ok(serde_json::to_value(sources)?)
        }
        "runtime.context.observations.receipt" => {
            let p: ContextObservationReceiptLookup = serde_json::from_value(params)?;
            let receipts = lock()?.context_observation_receipts(&p).map_err(domain)?;
            Ok(serde_json::to_value(receipts)?)
        }
        "runtime.context.observations.snapshot" => {
            let p: ContextObservationSnapshot = serde_json::from_value(params)?;
            Ok(json!({"cursor":lock()?.context_observation_snapshot(&p).map_err(domain)?}))
        }
        "runtime.context.observations.importPosition" => {
            let p: ContextObservationImportPosition = serde_json::from_value(params)?;
            Ok(
                json!({"throughId":lock()?.context_observation_import_position(&p).map_err(domain)?}),
            )
        }
        "runtime.context.observations.read" => {
            let p: ContextObservationRead = serde_json::from_value(params)?;
            let read = lock()?
                .prepare_context_observation_original(p)
                .map_err(domain)?;
            Ok(serde_json::to_value(
                read.load(&|| cancelled.load(Ordering::Acquire))
                    .map_err(domain)?,
            )?)
        }
        "runtime.context.observations.capture" => {
            let p: ContextObservationCaptureBatch = serde_json::from_value(params)?;
            let preparation = lock()?
                .prepare_context_observation_captures(p)
                .map_err(domain)?;
            let prepared = preparation.load().map_err(domain)?;
            let receipts = {
                let mut catalog = lock()?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                catalog
                    .admit_context_observation_captures(prepared)
                    .map_err(domain)?
            };
            Ok(serde_json::to_value(receipts)?)
        }
        "runtime.context.observations.import" => {
            let p: ContextObservationImport = serde_json::from_value(params)?;
            let preparation = lock()?
                .prepare_context_observation_import(p)
                .map_err(domain)?;
            let prepared = preparation.load().map_err(domain)?;
            let receipt = {
                let mut catalog = lock()?;
                if cancelled.load(Ordering::Acquire) {
                    return Err(KernelError::Cancelled);
                }
                catalog
                    .admit_context_observation_import(prepared)
                    .map_err(domain)?
            };
            Ok(serde_json::to_value(receipt)?)
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
