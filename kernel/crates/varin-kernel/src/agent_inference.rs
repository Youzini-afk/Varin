//! Private Host inference lifecycle. Body I/O stays outside the Catalog lock.
use super::*;
use varin_runtime::catalog::inference::{
    InferenceAdmitParams, InferenceOwnerParams, InferenceReceiptPendingParams,
    InferenceSettleParams,
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
        "runtime.inference.admit" => {
            let p: InferenceAdmitParams = serde_json::from_value(params)?;
            let prep = lock()?.prepare_inference_content();
            let body = prep.write(&p.request).map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            Ok(serde_json::to_value(
                lock()?.admit_inference(&p, body).map_err(domain)?,
            )?)
        }
        "runtime.inference.settle" => {
            let p: InferenceSettleParams = serde_json::from_value(params)?;
            let prep = lock()?.prepare_inference_content();
            let body = prep.write(&p.response).map_err(domain)?;
            // Cancelling this observer cannot erase the exact already observed provider receipt.
            Ok(serde_json::to_value(
                lock()?.settle_inference(&p, body).map_err(domain)?,
            )?)
        }
        "runtime.inference.receipt_pending" => {
            let p: InferenceReceiptPendingParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(
                lock()?.inference_receipt_pending(&p).map_err(domain)?,
            )?)
        }
        "runtime.inference.dispatch" | "runtime.inference.status" => {
            let p: InferenceOwnerParams = serde_json::from_value(params)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let result = if method.ends_with(".status") {
                lock()?.inference_status(&p.operation_id, &p.execution_owner)
            } else {
                lock()?.dispatch_inference(&p)
            }
            .map_err(domain)?;
            Ok(serde_json::to_value(result)?)
        }
        _ => Err(KernelError::Protocol(
            "Unknown inference lifecycle method".into(),
        )),
    }
}
