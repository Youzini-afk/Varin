//! Child projections load immutable task/launch bodies on a request worker.
use super::*;

pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    resources: crate::tools::KernelResourceClient,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(KernelError::Cancelled);
    }
    let owner = runtime.catalog();
    if method == "runtime.host_tool.reconcile" {
        let p: HostToolReconcileParams = serde_json::from_value(params)?;
        let confirmed = crate::integration_reconciliation::reconcile(
            &runtime,
            &resources,
            None,
            &p.operation_id,
            Some(&p.execution_owner),
        )?;
        return Ok(
            json!({"reconciled":if confirmed{vec![p.operation_id.clone()]}else{vec![]},"unresolved":if confirmed{vec![]}else{vec![p.operation_id]}}),
        );
    }

    if method == "runtime.child.continuation.accept" {
        let p: ChildContinuationAcceptParams = serde_json::from_value(params)?;
        let preparation = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_child_continuation(
                varin_runtime::catalog::delegated::ChildContinuationCommand {
                    key: p.key,
                    child_operation_id: p.child_operation_id,
                    previous_run_id: p.previous_run_id,
                    expected_head: p.expected_head.0,
                    input: p.input,
                },
            )
            .map_err(domain)?;
        let prepared = preparation.load().map_err(domain)?;
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let read = {
            let mut catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let execution = catalog
                .accept_child_continuation(prepared)
                .map_err(domain)?;
            catalog
                .capture_delegated_execution(execution)
                .map_err(domain)?
        };
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if method == "runtime.child.execution.list" {
        let p: ChildExecutionListParams = serde_json::from_value(params)?;
        let reads = {
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            catalog
                .delegated_executions(p.child_operation_id.as_deref())
                .map_err(domain)?
                .into_iter()
                .map(|execution| {
                    catalog
                        .capture_delegated_execution(execution)
                        .map_err(domain)
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        return Ok(serde_json::to_value(
            reads
                .into_iter()
                .map(|read| read.load().map_err(domain))
                .collect::<Result<Vec<_>, _>>()?,
        )?);
    }
    if method == "runtime.child.execution.for_run" {
        let p: RunParams = serde_json::from_value(params)?;
        let read = {
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            catalog
                .delegated_execution_for_run(&p.run_id)
                .map_err(domain)?
                .map(|execution| {
                    catalog
                        .capture_delegated_execution(execution)
                        .map_err(domain)
                })
                .transpose()?
        };
        return Ok(serde_json::to_value(
            read.map(|read| read.load().map_err(domain)).transpose()?,
        )?);
    }
    if matches!(
        method,
        "runtime.child.execution.inspect" | "runtime.child.release" | "runtime.child.fail"
    ) {
        let (execution_id, failure) = if method == "runtime.child.fail" {
            let p: ChildFailParams = serde_json::from_value(params)?;
            if ![
                "preparation_failed",
                "source_unavailable",
                "credentials_unavailable",
                "binding_changed",
            ]
            .contains(&p.code.as_str())
            {
                return Err(KernelError::Protocol(
                    "unknown child preparation failure".into(),
                ));
            }
            (p.execution_id, Some(p.code))
        } else {
            let p: ChildExecutionParams = serde_json::from_value(params)?;
            (p.execution_id, None)
        };
        let read = {
            let mut catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let execution = if let Some(code) = failure {
                catalog.fail_delegated_preparation(&execution_id, &code)
            } else if method == "runtime.child.release" {
                catalog.release_delegated_resources(&execution_id)
            } else {
                catalog.delegated_execution(&execution_id)
            }
            .map_err(domain)?;
            catalog
                .capture_delegated_execution(execution)
                .map_err(domain)?
        };
        // This command already committed its own result. The committed event drives the
        // original continuation owner; unrelated report bodies cannot block this command's ACK.
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if method == "runtime.child.execution.report.read" {
        let p: ChildExecutionReportReadParams = serde_json::from_value(params)?;
        let offset = usize::try_from(p.offset.unwrap_or(0))
            .map_err(|_| KernelError::Protocol("invalid offset".into()))?;
        let max = usize::try_from(p.max_bytes.unwrap_or(65536))
            .map_err(|_| KernelError::Protocol("invalid maxBytes".into()))?;
        let read = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_delegated_report(&p.execution_id, &p.item_id, offset, max)
            .map_err(domain)?;
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if method == "runtime.child.source.ready" {
        let p: ChildSourceReadyParams = serde_json::from_value(params)?;
        let source = varin_runtime::catalog::launches::SourceSelection {
            environment_run_id: p.source.environment_run_id,
            mode: p.source.mode,
            live_root: p.source.live_root.and_then(|root| root.0).map(|root| {
                varin_runtime::catalog::launches::LiveRoot {
                    host_id: root.host_id,
                    root_id: root.root_id,
                    canonical_root: root.canonical_root,
                }
            }),
            workspace_id: p.source.workspace_id,
            execution_workspace_id: p.source.execution_workspace_id,
            branch_id: p.source.branch_id.0,
            revision: p
                .source
                .revision
                .0
                .map(u64::try_from)
                .transpose()
                .map_err(|_| KernelError::Protocol("source revision must be nonnegative".into()))?,
        };
        let preparation = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .prepare_child_source(&p.execution_id, p.pin, source, p.provenance)
            .map_err(domain)?;
        let prepared = preparation.load().map_err(domain)?;
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let read = {
            let mut catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let child = catalog.attach_child_source(prepared).map_err(domain)?;
            catalog
                .capture_delegated_execution(
                    catalog
                        .delegated_execution(&child.execution_id)
                        .map_err(domain)?,
                )
                .map_err(domain)?
        };
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if matches!(
        method,
        "runtime.child.settle"
            | "runtime.child.result.candidate"
            | "runtime.child.result.published"
    ) {
        let (operation_id, binding, receipt_id) = match method {
            "runtime.child.settle" => {
                let p: ChildSettleParams = serde_json::from_value(params)?;
                (p.execution_id, p.tool_binding, None)
            }
            "runtime.child.result.candidate" => {
                let p: ChildResultCandidateParams = serde_json::from_value(params)?;
                (
                    p.execution_id,
                    p.tool_binding,
                    Some(p.candidate_operation_id),
                )
            }
            _ => {
                let p: ChildResultPublishedParams = serde_json::from_value(params)?;
                (p.execution_id, p.tool_binding, Some(p.publication_id))
            }
        };
        let binding: crate::tools::ToolBinding = serde_json::from_value(binding)?;
        let child = {
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let child = catalog.execution_task(&operation_id).map_err(domain)?;
            let receipt = child
                .receipt
                .as_ref()
                .ok_or_else(|| KernelError::Authorization("child has no Run".into()))?;
            let run = catalog.run(&receipt.run_id).map_err(domain)?;
            if binding.run_id != run.id
                || binding.thread_id != run.thread_id
                || !run.state.terminal()
                || child.source.selection() != Some(&binding.source_selection()?)
            {
                return Err(KernelError::Authorization(
                    "child settlement requires the original terminal Run source".into(),
                ));
            }
            child
        };
        let writer_read = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_child_writer_bindings(&operation_id)
            .map_err(domain)?;
        let writers = writer_read.load().map_err(domain)?;
        runtime
            .quiesce_terminal(&binding.run_id)
            .map_err(|error| KernelError::Operation(error.to_string()))?;
        let context = varin_runtime::execution::ToolExecutionContext {
            run_id: binding.run_id.clone(),
            origin: child.origin.clone(),
            operation_id: child.execution_id.clone(),
        };
        let cancel = varin_runtime::execution::CancellationToken::default();
        // A directory capture still needs the original physical writers/leases to stop.
        // Once Storage has fixed a candidate, recovery uses its durable receipt and
        // may deliberately have no execution root (including after cwd removal).
        let captures_directory = method == "runtime.child.settle"
            && matches!(
                child.code_result,
                varin_runtime::catalog::collaboration::ChildCodeResult::Pending
                    | varin_runtime::catalog::collaboration::ChildCodeResult::Settling { .. }
            );
        {
            let directory_idle = if captures_directory {
                resources
                    .require_child_root_idle(&binding, &context, &cancel)
                    .map_err(|error| KernelError::Operation(error.to_string()))?["writerStopped"]
                    == true
            } else {
                true
            };
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            if !directory_idle || !catalog.child_writers_stopped(&writers).map_err(domain)? {
                let read = catalog
                    .capture_delegated_execution(
                        catalog.delegated_execution(&operation_id).map_err(domain)?,
                    )
                    .map_err(domain)?;
                drop(catalog);
                return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
            }
        }
        if captures_directory {
            owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .confirm_child_file_writers_stopped(&operation_id)
                .map_err(domain)?;
            let reads = {
                let catalog = owner
                    .lock()
                    .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
                catalog
                    .pending_run_operations(&binding.run_id)
                    .map_err(domain)?
                    .into_iter()
                    .filter(|operation| {
                        matches!(
                            operation.executor.as_deref(),
                            Some("file_write" | "file_edit")
                        ) && operation.execution_owner == Some(varin_runtime::ExecutorOwner::Kernel)
                    })
                    .map(|operation| catalog.capture_operation_read(operation))
                    .collect::<Vec<_>>()
            };
            let operations = reads
                .into_iter()
                .map(|read| read.load().map_err(domain))
                .collect::<Result<Vec<_>, _>>()?;
            for (id, receipt) in resources.reconcile_mutations(binding.clone(), operations)? {
                // The Run worker has joined and the original physical root has no file lease.
                // An uncertain journal can therefore release occupancy without claiming no effect.
                varin_runtime::catalog::result_content::record_external_receipt(
                    &owner, &id, receipt, true,
                )
                .map_err(domain)?;
            }
        }
        let stored = if let Some(id) = receipt_id {
            let kind = if method == "runtime.child.result.candidate" {
                "working.result.prepare"
            } else {
                "working.result.publish"
            };
            Some(
                resources
                    .child_storage_receipt(&binding, &context, &id, kind, &cancel)
                    .map_err(|error| KernelError::Operation(error.to_string()))?,
            )
        } else {
            None
        };
        if cancelled.load(Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let read = {
            let mut catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            let child = if method == "runtime.child.settle" {
                catalog
                    .begin_child_settlement_bound(&operation_id, &writers)
                    .map_err(domain)?
            } else if method == "runtime.child.result.candidate" {
                let candidate =
                    crate::storage::result_publication::candidate_view(stored.as_ref().unwrap())?;
                catalog
                    .attach_child_candidate_bound(&operation_id, candidate, &writers)
                    .map_err(domain)?
            } else {
                let value = stored.as_ref().unwrap();
                let text = |field: &str| {
                    value[field].as_str().map(str::to_string).ok_or_else(|| {
                        KernelError::Protocol(format!("missing publication {field}"))
                    })
                };
                let result = varin_runtime::catalog::collaboration::ChildWorkingResultRef {
                    publication_id: text("publicationId")?,
                    workspace_id: text("workspaceId")?,
                    branch_id: text("branchId")?,
                    result_revision: value["resultRevision"].as_u64().ok_or_else(|| {
                        KernelError::Protocol("invalid published revision".into())
                    })?,
                    root: text("root")?,
                    base_root: text("baseRoot")?,
                    record_id: text("recordId")?,
                };
                let effect = catalog.child_file_effect_bound(&writers).map_err(domain)?;
                catalog
                    .attach_child_result_bound(&operation_id, result, effect, &writers)
                    .map_err(domain)?
            };
            catalog
                .capture_delegated_execution(
                    catalog
                        .delegated_execution(&child.execution_id)
                        .map_err(domain)?,
                )
                .map_err(domain)?
        };
        // Report/receipt reconciliation follows this real commit on the continuation worker.
        // Return this operation's already captured result without awaiting unrelated children.
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if method == "runtime.child.report.read" {
        let p: ChildReportReadParams = serde_json::from_value(params)?;
        let offset = usize::try_from(p.offset.unwrap_or(0))
            .map_err(|_| KernelError::Protocol("invalid offset".into()))?;
        let max = usize::try_from(p.max_bytes.unwrap_or(65536))
            .map_err(|_| KernelError::Protocol("invalid maxBytes".into()))?;
        let read = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .capture_child_report(&p.operation_id, &p.item_id, offset, max)
            .map_err(domain)?;
        return Ok(serde_json::to_value(read.load().map_err(domain)?)?);
    }
    if method == "runtime.child.list" {
        let reads = {
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            catalog
                .child_tasks()
                .map_err(domain)?
                .into_iter()
                .map(|child| catalog.capture_child_read(child))
                .collect::<Vec<_>>()
        };
        let children = reads
            .into_iter()
            .map(|read| read.load().map_err(domain))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(serde_json::to_value(children)?);
    }
    if method == "runtime.child.for_thread" {
        let p: ThreadParams = serde_json::from_value(params)?;
        let read = {
            let catalog = owner
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
            catalog
                .child_task_for_thread(&p.thread_id)
                .map_err(domain)?
                .map(|child| catalog.capture_child_read(child))
        };
        return Ok(serde_json::to_value(
            read.map(|read| read.load().map_err(domain)).transpose()?,
        )?);
    }
    let p: OperationParams = serde_json::from_value(params)?;
    if method != "runtime.child.inspect" {
        return Err(KernelError::Protocol(
            "unknown child projection command".into(),
        ));
    }
    let read = {
        let catalog = owner
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?;
        catalog.capture_child_read(catalog.child_task(&p.operation_id).map_err(domain)?)
    };
    Ok(serde_json::to_value(read.load().map_err(domain)?)?)
}

#[cfg(test)]
#[path = "delegated_commands_review.rs"]
mod tests;
