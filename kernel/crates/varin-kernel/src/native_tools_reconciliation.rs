//! Private typed journal replay for the native reconciliation worker. This path
//! never invokes execute(), reconstructs edited text, or uses the original grant
//! as current authority. It returns only facts proved by the Storage owner.
use super::*;
use varin_runtime::execution::AdmittedTool;
use varin_runtime::{ExternalReceipt, Operation};

impl NativeResourceClient {
    pub(crate) fn reconcile_mutations(
        &self,
        binding: NativeToolBinding,
        operations: Vec<Operation>,
    ) -> Result<Vec<(String, ExternalReceipt)>, KernelError> {
        if binding.source_mode != NativeSourceMode::Materialized {
            return Err(KernelError::Authorization(
                "mutation recovery requires the original materialized source".into(),
            ));
        }
        let executor = NativeToolExecutor::new(binding.clone(), self.clone())
            .map_err(|error| KernelError::Authorization(error.to_string()))?;
        let cancellation = CancellationToken::default();
        let mut receipts = Vec::new();
        for operation in operations {
            if operation.run_id != binding.run_id {
                return Err(KernelError::Authorization(
                    "mutation recovery belongs to another Run".into(),
                ));
            }
            let admitted: AdmittedTool = serde_json::from_value(operation.intent.clone())?;
            if operation.executor.as_deref() != Some(admitted.call.name.as_str()) {
                return Err(KernelError::Authorization(
                    "mutation executor does not match its durable intent".into(),
                ));
            }
            let suffix = format!(":tool:{}", admitted.call.call_id);
            let request_id = operation
                .id
                .strip_suffix(&suffix)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    KernelError::Authorization(
                        "mutation identity does not match its original tool call".into(),
                    )
                })?;
            let context = ToolExecutionContext {
                run_id: operation.run_id.clone(),
                request_id: request_id.into(),
                operation_id: operation.id.clone(),
            };
            let original = executor
                .operation(Some(&context), &admitted.call)
                .map_err(|error| KernelError::Authorization(error.to_string()))?;
            if executor.contract(&admitted.call, &original) != admitted.contract {
                return Err(KernelError::Authorization(
                    "mutation source or contract changed before recovery".into(),
                ));
            }
            let ResourceOperation::FileMutation(mutation) = original else {
                return Err(KernelError::Authorization(
                    "operation is not an admitted native text mutation".into(),
                ));
            };
            let result = self
                .call(
                    &binding,
                    &context,
                    ResourceOperation::ReconcileMutation {
                        mutation,
                        executor: admitted.call.name,
                    },
                    false,
                    &cancellation,
                )
                .map_err(|failure| failure.error)?;
            let receipt: Option<ExternalReceipt> = serde_json::from_value(result)?;
            if let Some(receipt) = receipt {
                receipts.push((operation.id, receipt));
            }
        }
        Ok(receipts)
    }
}
