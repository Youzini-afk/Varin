//! Scope deletion waits for original remote read delivery cleanup on this worker.
//! Catalog remains the only record owner; a failed cleanup preserves its retry address.
use super::domain;
use crate::{error::KernelError, tools::KernelResourceClient};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use varin_runtime::{catalog::bot::BotSuspension, Catalog};

pub(super) fn remove(
    catalog: &Arc<Mutex<Catalog>>,
    resources: &KernelResourceClient,
    suspension: BotSuspension,
    cancel: &AtomicBool,
) -> Result<Value, KernelError> {
    let operations = {
        let db = catalog
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner unavailable".into()))?;
        db.bot_scope_capture(suspension.clone()).map_err(domain)?;
        let runs = db.bot_scope_run_ids(&suspension.bot_id).map_err(domain)?;
        db.delivered_external_operations()
            .map_err(domain)?
            .into_iter()
            .filter(|operation| {
                runs.contains(&operation.run_id) && crate::reconcile::is_managed_read(operation)
            })
            .map(|operation| operation.id)
            .collect::<Vec<_>>()
    };
    for id in operations {
        if cancel.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        resources.release_delivered_read_receipt(&id)?;
    }
    if let Some(files) = &resources.file_observations {
        files.drain_bot_scope(catalog, &suspension, cancel)?;
    }
    if cancel.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    catalog
        .lock()
        .map_err(|_| KernelError::Storage("Catalog owner unavailable".into()))?
        .remove_bot_scope(&suspension)
        .map_err(domain)?;
    Ok(json!({"removed":true}))
}
