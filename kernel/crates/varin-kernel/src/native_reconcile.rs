//! Read/reconcile existing file journals on a worker, without blocking native control admission.
use crate::{
    error::{response_error, KernelError},
    native_tools::{NativeResourceClient, NativeToolBinding},
    protocol::response_ok,
};
use serde_json::{json, Value};
use std::sync::{mpsc::SyncSender, Arc};
use varin_runtime::supervisor::RunSupervisor;

pub(crate) fn reconcile(
    runtime: Arc<RunSupervisor>,
    resources: NativeResourceClient,
    binding: NativeToolBinding,
    operations: Vec<varin_runtime::Operation>,
    request_id: String,
    responses: SyncSender<Value>,
    finished: Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<(), KernelError> {
    std::thread::Builder::new()
        .name("native-file-reconcile".into())
        .spawn(move || {
            let result = (|| -> Result<Value, KernelError> {
                let requested: Vec<String> = operations.iter().map(|op| op.id.clone()).collect();
                let receipts = resources.reconcile_mutations(binding, operations)?;
                let mut reconciled = Vec::new();
                {
                    let catalog = runtime.catalog();
                    let mut catalog = catalog
                        .lock()
                        .map_err(|_| KernelError::Storage("native catalog owner failed".into()))?;
                    for (operation_id, receipt) in receipts {
                        catalog
                            .record_external_receipt(&operation_id, receipt)
                            .map_err(|error| KernelError::Operation(error.to_string()))?;
                        reconciled.push(operation_id);
                    }
                }
                let unresolved: Vec<_> = requested
                    .into_iter()
                    .filter(|id| !reconciled.contains(id))
                    .collect();
                Ok(json!({"reconciled":reconciled,"unresolved":unresolved}))
            })();
            let response = match result {
                Ok(value) => response_ok(&request_id, value),
                Err(error) => response_error(&request_id, &error),
            };
            finished(&request_id);
            let _ = responses.send(response);
        })
        .map_err(|error| KernelError::Operation(error.to_string()))?;
    Ok(())
}
