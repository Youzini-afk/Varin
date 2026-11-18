//! Private typed journal replay for the reconciliation worker. This path
//! never invokes execute(), reconstructs edited text, or uses the original grant
//! as current authority. It returns only facts proved by the Storage owner.
use super::*;
use varin_runtime::execution::{ToolExecutionReceipt, ToolInvocation};
use varin_runtime::{ExternalReceipt, Operation};

impl KernelResourceClient {
    pub(crate) fn reconcile_mutations(
        &self,
        binding: ToolBinding,
        operations: Vec<Operation>,
    ) -> Result<Vec<(String, ExternalReceipt)>, KernelError> {
        // A fixed-source command can produce a working result without admitting
        // any text-mutation journals. Nothing needs physical mutation recovery.
        if operations.is_empty() { return Ok(Vec::new()); }
        let mut local_executor = None;
        let cancellation = CancellationToken::default();
        let mut receipts = Vec::new();
        for operation in operations {
            if operation.run_id != binding.run_id {
                return Err(KernelError::Authorization(
                    "mutation recovery belongs to another Run".into(),
                ));
            }
            let admitted: ToolInvocation = serde_json::from_value(operation.intent.clone())?;
            if operation.executor.as_deref() != Some(admitted.call.name.as_str()) {
                return Err(KernelError::Authorization(
                    "mutation executor does not match its durable intent".into(),
                ));
            }
            let context = ToolExecutionContext {
                run_id: operation.run_id.clone(),
                origin: admitted.origin.clone(),
                operation_id: operation.id.clone(),
            };
            if context.operation_id != context.origin.operation_id(&admitted.call.call_id) {
                return Err(KernelError::Authorization(
                    "mutation identity differs from its durable origin".into(),
                ));
            }
            let original_source = operation.resource_source.as_ref();
            if original_source.map_or(!binding.resource_owner.is_local(), |source| !source.resource_owner.is_local()) {
                if !matches!(admitted.call.name.as_str(), "file_write" | "file_edit" | "file_restore") {
                    return Err(KernelError::Authorization(
                        "Managed receipt is not a text mutation".into(),
                    ));
                }
                let value = self
                    .remote_operation_receipt(&operation.id, "observe")?
                    .ok_or_else(|| {
                        KernelError::Authorization(
                            "Managed mutation lost its original owner".into(),
                        )
                    })?;
                let observed: ToolExecutionReceipt =
                    serde_json::from_value(value["result"].clone())?;
                if observed.executor_stopped {
                    if let ToolCompletion::Result {
                        outcome,
                        effect,
                        content,
                    } = observed.completion
                    {
                        receipts.push((
                            operation.id.clone(),
                            ExternalReceipt {
                                executor: admitted.call.name,
                                identity: operation.id,
                                epoch: value["resourceEpoch"]
                                    .as_str()
                                    .ok_or_else(|| {
                                        KernelError::Authorization(
                                            "Original mutation epoch missing".into(),
                                        )
                                    })?
                                    .into(),
                                outcome,
                                effect,
                                result: content,
                            },
                        ));
                    }
                }
                continue;
            }
            if original_source.is_some_and(|source| Some(source) != binding.source_selection().ok().as_ref()) {
                return Err(KernelError::Authorization("Original local mutation source is unavailable; its receipt cannot be reconciled here".into()));
            }
            if binding.source_mode == SourceMode::FixedBranch {
                return Err(KernelError::Authorization("mutation recovery requires the original physical source".into()));
            }
            if local_executor.is_none() {
                local_executor = Some(KernelToolExecutor::new(binding.clone(), self.clone())
                    .map_err(|error| KernelError::Authorization(error.to_string()))?);
            }
            let executor = local_executor.as_ref().expect("local executor initialized");
            let original = executor
                .operation(Some(&context), &admitted.call)
                .map_err(|error| KernelError::Authorization(error.to_string()))?;
            let contract = executor
                .planned_contract(&context, &admitted.call, &original, &cancellation)
                .map_err(|error| KernelError::Authorization(error.to_string()))?;
            if contract != admitted.contract {
                return Err(KernelError::Authorization(
                    "mutation source or contract changed before recovery".into(),
                ));
            }
            let observation = match original {
                ResourceOperation::FileMutation(mutation) => ResourceOperation::ReconcileMutation { mutation, executor: admitted.call.name },
                ResourceOperation::FileRestore(args) => ResourceOperation::ReconcileFileRestore(args),
                _ => return Err(KernelError::Authorization("operation is not an admitted file mutation".into())),
            };
            let result = self
                .call(
                    &binding,
                    &context,
                    observation,
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
