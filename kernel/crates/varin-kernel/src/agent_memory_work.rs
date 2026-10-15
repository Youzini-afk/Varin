//! Private Host admission for the existing Bot memory organizer. No public tool/route.
use super::*;
use varin_runtime::catalog::memory_work::{
    MemoryWorkAdmit, MemoryWorkListParams, MemoryWorkReadParams, MemoryWorkUpdate,
};
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    let catalog = runtime.catalog();
    let lock = || {
        catalog
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner failed".into()))
    };
    match method {
        "runtime.memory_work.admit" => {
            let p: MemoryWorkAdmit = serde_json::from_value(params)?;
            let prepared = lock()?.prepare_inference_content();
            let body = prepared.write(&p.recipe).map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let id = lock()?.admit_memory_work(&p, body).map_err(domain)?;
            Ok(json!({"workId":id}))
        }
        "runtime.memory_work.read" => {
            let p: MemoryWorkReadParams = serde_json::from_value(params)?;
            let read = lock()?.capture_memory_work(&p.work_id).map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.memory_work.status" => {
            let p: MemoryWorkReadParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?.memory_work_status(&p.work_id).map_err(domain)?,
            )?)
        }
        "runtime.memory_work.list" => {
            let p: MemoryWorkListParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?.memory_work_ids(&p.scope_id).map_err(domain)?,
            )?)
        }
        "runtime.memory_work.update" => {
            let p: MemoryWorkUpdate = serde_json::from_value(params)?;
            lock()?.update_memory_work(&p).map_err(domain)?;
            Ok(Value::Null)
        }
        _ => Err(KernelError::Protocol("Unknown memory work method".into())),
    }
}

#[cfg(test)]
#[path = "agent_memory_work/tests.rs"]
mod tests;
