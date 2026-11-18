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
                let original = original_source.expect("alternate mutation source");
                let saved = self.file_receipt(original.clone(), operation.run_id, binding.thread_id.clone(), operation.id.clone())?;
                if saved["state"] != "committed" {
                    continue;
                }
                if saved["tool"] != admitted.call.name {
                    return Err(KernelError::Authorization("Original mutation receipt belongs to another tool".into()));
                }
                let file = &saved["receipt"];
                let applied = file["status"] == "applied";
                let content = crate::file_tool_reconciliation::recovered_output(file, &operation.id)?;
                let epoch = file["__nativeEpoch"].as_str().filter(|epoch| !epoch.is_empty())
                    .ok_or_else(|| KernelError::Storage("Original mutation epoch is missing".into()))?;
                receipts.push((operation.id.clone(), ExternalReceipt {
                    executor: admitted.call.name, identity: operation.id, epoch: epoch.into(),
                    outcome: if applied { varin_runtime::Outcome::Succeeded } else { varin_runtime::Outcome::Failed },
                    effect: if applied { varin_runtime::Effect::Confirmed } else { varin_runtime::Effect::None },
                    result: content,
                }));
                continue;
            }
            if binding.source_mode == SourceMode::FixedBranch {
                return Err(KernelError::Authorization("mutation recovery requires the original physical source".into()));
            }
            if local_executor.is_none() {
                local_executor = Some(KernelToolExecutor::new(binding.clone(), self.clone())
                    .map_err(|error| KernelError::Authorization(error.to_string()))?);
            }
            let executor = local_executor.as_ref().expect("local executor initialized");
            let mut call = admitted.call.clone();
            let mut admitted_contract = admitted.contract.clone();
            if call.schema_version == "3" && crate::work_locations::alternate_tool(&call.name) {
                call.schema_version = "2".into();
                if let Some(arguments) = call.arguments.as_object_mut() {
                    arguments.remove("location");
                }
                admitted_contract.schema_version = "2".into();
            }
            let original = executor
                .operation(Some(&context), &call)
                .map_err(|error| KernelError::Authorization(error.to_string()))?;
            let contract = executor
                .planned_contract(&context, &call, &original, &cancellation)
                .map_err(|error| KernelError::Authorization(error.to_string()))?;
            if contract != admitted_contract {
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
