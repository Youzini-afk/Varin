//! Read/reconcile existing file journals on a worker, without blocking control admission.
use crate::{
    error::{response_error, KernelError},
    tools::{KernelResourceClient, ToolBinding},
    protocol::response_ok,
};
use serde_json::{json, Value};
use std::sync::Arc;
use varin_runtime::supervisor::RunSupervisor;

pub(crate) fn reconcile(
    runtime: Arc<RunSupervisor>,
    resources: KernelResourceClient,
    binding: ToolBinding,
    operations: Vec<varin_runtime::OperationMetadata>,
    request_id: String,
    responses: crate::transport::Sender,
    finished: Arc<dyn Fn(&str) + Send + Sync>,
) -> Result<(), KernelError> {
    std::thread::Builder::new()
        .name("file-reconcile".into())
        .spawn(move || {
            let result = (|| -> Result<Value, KernelError> {
                let requested: Vec<String> = operations.iter().map(|op| op.id.clone()).collect();
                let reads={let owner=runtime.catalog();let catalog=owner.lock().map_err(|_|KernelError::Storage("catalog owner failed".into()))?;
                    operations.into_iter().map(|operation|catalog.capture_operation_read(operation)).collect::<Vec<_>>()};
                let operations=reads.into_iter().map(|read|read.load().map_err(|error|KernelError::Operation(error.to_string()))).collect::<Result<Vec<_>,_>>()?;
                let receipts = resources.reconcile_mutations(binding, operations)?;
                let mut reconciled = Vec::new();
                let catalog = runtime.catalog();
                for (operation_id, receipt) in receipts {
                    let stopped = receipt.outcome != varin_runtime::Outcome::Indeterminate;
                    varin_runtime::catalog::result_content::record_external_receipt(&catalog, &operation_id, receipt, stopped)
                        .map_err(|error| KernelError::Operation(error.to_string()))?;
                    reconciled.push(operation_id);
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
