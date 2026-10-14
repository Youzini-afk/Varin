//! Private Knowledge utility admission, using the shared original inference executor.
use super::*;
use varin_runtime::catalog::knowledge_inference::{
    KnowledgeInferenceAdmit, KnowledgeInferenceFinish, KnowledgeInferenceReadParams,
};
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    let owner = runtime.catalog();
    let lock = || {
        owner
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner failed".into()))
    };
    match method {
        "runtime.knowledge_inference.admit" => {
            let p: KnowledgeInferenceAdmit = serde_json::from_value(params)?;
            let prep = lock()?.prepare_inference_content();
            let body = prep.write(&p.recipe).map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let id = lock()?
                .admit_knowledge_inference(&p, body)
                .map_err(domain)?;
            let read = lock()?.capture_knowledge_inference(&id).map_err(domain)?;
            Ok(serde_json::to_value(read.load().map_err(domain)?)?)
        }
        "runtime.knowledge_inference.read" => {
            let p: KnowledgeInferenceReadParams = serde_json::from_value(params)?;
            let read = lock()?.capture_knowledge_inference(&p.operation_id);
            match read {
                Ok(read) => Ok(serde_json::to_value(read.load().map_err(domain)?)?),
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing => Ok(Value::Null),
                Err(error) => Err(domain(error)),
            }
        }
        "runtime.knowledge_inference.status" => {
            let p: KnowledgeInferenceReadParams = serde_json::from_value(params)?;
            match lock()?.knowledge_inference_status(&p.operation_id) {
                Ok(status) => Ok(serde_json::to_value(status)?),
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing => Ok(Value::Null),
                Err(error) => Err(domain(error)),
            }
        }
        "runtime.knowledge_inference.cancel" => {
            let p: KnowledgeInferenceReadParams = serde_json::from_value(params)?;
            lock()?
                .cancel_knowledge_inference(&p.operation_id)
                .map_err(domain)?;
            runtime.cancel_operation_control(&p.operation_id);
            Ok(serde_json::to_value(
                lock()?
                    .knowledge_inference_status(&p.operation_id)
                    .map_err(domain)?,
            )?)
        }
        "runtime.knowledge_inference.finish" => {
            let p: KnowledgeInferenceFinish = serde_json::from_value(params)?;
            lock()?.finish_knowledge_inference(&p).map_err(domain)?;
            Ok(serde_json::to_value(
                lock()?
                    .knowledge_inference_status(&p.operation_id)
                    .map_err(domain)?,
            )?)
        }
        _ => Err(KernelError::Protocol(
            "Unknown Knowledge inference method".into(),
        )),
    }
}
