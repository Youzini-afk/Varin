//! Read/reconcile existing file journals on a worker, without blocking control admission.
use crate::{
    error::{response_error, KernelError},
    protocol::response_ok,
    tools::{KernelResourceClient, ToolBinding},
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
                let mut reconciled = Vec::new();
                for operation in &operations {
                    if matches!(operation.executor.as_deref(), Some("office_write" | "office_export" | "browser_files"))
                        && crate::file_tool_reconciliation::reconcile(&runtime, &resources, Some(&binding), &operation.id, operation.execution_owner.as_ref())? {
                        reconciled.push(operation.id.clone());
                    }
                    if matches!(operation.executor.as_deref(),Some("integrate_child"|"submit_code"|"update"))
                        && crate::integration_reconciliation::reconcile(
                            &runtime,
                            &resources,
                            Some(&binding),
                            &operation.id,
                            operation.execution_owner.as_ref(),
                        )?
                    {
                        reconciled.push(operation.id.clone());
                    }
                }
                for operation in &operations {
                    if operation.executor.as_deref() == Some("scheduled_task") && !binding.resource_owner.is_local()
                        && crate::schedule_reconciliation::reconcile(&runtime, &resources, Some(&binding),
                            &operation.id, operation.execution_owner.as_ref())? {
                        reconciled.push(operation.id.clone());
                    }
                }
                for operation in &operations {
                    if matches!(
                        operation.executor.as_deref(),
                        Some("process_write" | "process_resize")
                    ) {
                        let invocation =
                            varin_runtime::catalog::tool_content::ToolIntent::from_operation(
                                operation,
                            )
                            .map_err(|error| KernelError::Authorization(error.to_string()))?;
                        let claim = invocation.contract().resources.first().ok_or_else(|| {
                            KernelError::Authorization(
                                "process interaction resource identity missing".into(),
                            )
                        })?;
                        let target: Vec<Value> = serde_json::from_str(&claim.key)?;
                        let expected = if operation.executor.as_deref() == Some("process_write") {
                            "process-input"
                        } else {
                            "process-size"
                        };
                        if target.len() != 4
                            || target[0] != expected
                            || target[1] != serde_json::to_value(&binding.resource_owner)?
                            || target[2] != binding.execution_workspace_id
                        {
                            return Err(KernelError::Authorization(
                                "process interaction resource identity changed".into(),
                            ));
                        }
                        let process_id = target[3].as_str().ok_or_else(|| {
                            KernelError::Authorization("Process resource identity missing".into())
                        })?;
                        {
                            let owner = runtime.catalog();
                            let catalog = owner
                                .lock()
                                .map_err(|_| KernelError::Storage("Catalog owner failed".into()))?;
                            let process = catalog
                                .require_process_observation(&binding.run_id, process_id)
                                .map_err(|error| KernelError::Authorization(error.to_string()))?;
                            if process.run_id != binding.run_id {
                                return Err(KernelError::Authorization(
                                    "process recovery cannot use follow-up delegation".into(),
                                ));
                            }
                        }
                        if !binding.resource_owner.is_local() {
                            let value = resources
                                .remote_operation_receipt(&operation.id, "observe")?
                                .ok_or_else(|| {
                                    KernelError::Authorization(
                                        "Managed interaction lost its original owner".into(),
                                    )
                                })?;
                            let observed: varin_runtime::execution::ToolExecutionReceipt =
                                serde_json::from_value(value["result"].clone())?;
                            if let varin_runtime::execution::ToolCompletion::Result {
                                content,
                                ..
                            } = observed.completion
                            {
                                if let Ok(receipt) = serde_json::from_value::<
                                    crate::process::interaction::Receipt,
                                >(content.data)
                                {
                                    let native = crate::storage::process_interactions::Native {
                                        resource_owner: binding.resource_owner.clone(),
                                        context: varin_runtime::execution::ToolExecutionContext {
                                            run_id: operation.run_id.clone(),
                                            operation_id: operation.id.clone(),
                                            origin: invocation.origin().clone(),
                                        },
                                        executor: operation.executor.clone().unwrap(),
                                    };
                                    crate::agent_runtime::record_process_interaction(
                                        &runtime.catalog(),
                                        &native,
                                        &receipt,
                                        observed.executor_stopped,
                                    )?;
                                    if observed.executor_stopped {
                                        reconciled.push(operation.id.clone());
                                    }
                                }
                            }
                            continue;
                        }
                        let client = resources.interactions.as_ref().ok_or_else(|| {
                            KernelError::Storage("process input owner unavailable".into())
                        })?;
                        let native = crate::storage::process_interactions::Native {
                            resource_owner: binding.resource_owner.clone(),
                            context: varin_runtime::execution::ToolExecutionContext {
                                run_id: operation.run_id.clone(),
                                operation_id: operation.id.clone(),
                                origin: invocation.origin().clone(),
                            },
                            executor: operation.executor.clone().ok_or_else(|| {
                                KernelError::Authorization(
                                    "process recovery executor missing".into(),
                                )
                            })?,
                        };
                        let address = crate::storage::process_interactions::Address {
                            workspace_id: binding.workspace_id.clone(),
                            process_id: process_id.into(),
                            operation_id: operation.id.clone(),
                            root_id: binding.root_id.clone(),
                        };
                        if let Some((intent, receipt)) = client.reconcile(native, address)? {
                            let native = intent.native.ok_or_else(|| {
                                KernelError::Authorization(
                                    "process interaction has no original native invocation".into(),
                                )
                            })?;
                            crate::agent_runtime::record_process_interaction(
                                &runtime.catalog(),
                                &native,
                                &receipt,
                                true,
                            )?;
                            reconciled.push(operation.id.clone());
                        }
                    }
                }
                for operation in &operations {
                    if reconcile_managed_read(&runtime.catalog(), &resources, operation)? {
                        reconciled.push(operation.id.clone());
                    }
                }
                let reads = {
                    let owner = runtime.catalog();
                    let catalog = owner
                        .lock()
                        .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                    operations
                        .into_iter()
                        .filter(|operation| {
                            matches!(
                                operation.executor.as_deref(),
                                Some("file_write" | "file_edit" | "file_restore")
                            )
                        })
                        .map(|operation| catalog.capture_operation_read(operation))
                        .collect::<Vec<_>>()
                };
                let operations = reads
                    .into_iter()
                    .map(|read| {
                        read.load()
                            .map_err(|error| KernelError::Operation(error.to_string()))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let receipts = if operations.is_empty() {
                    Vec::new()
                } else {
                    resources.reconcile_mutations(binding, operations)?
                };
                let catalog = runtime.catalog();
                for (operation_id, receipt) in receipts {
                    let stopped = receipt.outcome != varin_runtime::Outcome::Indeterminate;
                    varin_runtime::catalog::result_content::record_external_receipt(
                        &catalog,
                        &operation_id,
                        receipt,
                        stopped,
                    )
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

pub(crate) fn is_managed_read(operation: &varin_runtime::OperationMetadata) -> bool {
    operation
        .executor
        .as_deref()
        .is_some_and(crate::tools::managed_read_receipt_tool)
        && matches!(operation.execution_owner.as_ref(),Some(varin_runtime::ExecutorOwner::External{identity,..}) if identity.starts_with("source:"))
}

pub(crate) fn reconcile_managed_read(
    catalog: &Arc<std::sync::Mutex<varin_runtime::Catalog>>,
    resources: &KernelResourceClient,
    operation: &varin_runtime::OperationMetadata,
) -> Result<bool, KernelError> {
    if !is_managed_read(operation) {
        return Ok(false);
    }
    let value = resources
        .remote_operation_receipt(&operation.id, "observe")?
        .ok_or_else(|| {
            KernelError::Authorization("Managed read lost its original execution owner".into())
        })?;
    let observed: varin_runtime::execution::ToolExecutionReceipt =
        serde_json::from_value(value["result"].clone())?;
    if !observed.executor_stopped {
        return Ok(false);
    }
    let (outcome, effect, result) = match observed.completion {
        varin_runtime::execution::ToolCompletion::Result {
            outcome,
            effect,
            content,
        } => (outcome, effect, content),
        varin_runtime::execution::ToolCompletion::NotDispatched { reason, .. } => (
            varin_runtime::Outcome::Failed,
            varin_runtime::Effect::None,
            json!({"reason":reason}).into(),
        ),
        _ => {
            return Err(KernelError::Authorization(
                "Read receipt cannot start a process Job".into(),
            ));
        }
    };
    let receipt = varin_runtime::ExternalReceipt {
        executor: operation.executor.clone().expect("read tool"),
        identity: operation.id.clone(),
        epoch: value["resourceEpoch"]
            .as_str()
            .ok_or_else(|| {
                KernelError::Authorization("Original read receipt epoch missing".into())
            })?
            .into(),
        outcome,
        effect,
        result,
    };
    varin_runtime::catalog::result_content::record_external_receipt(
        catalog,
        &operation.id,
        receipt,
        true,
    )
    .map_err(|error| KernelError::Operation(error.to_string()))?;
    resources.schedule_read_receipt_release(operation.id.clone());
    Ok(true)
}
