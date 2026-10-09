//! Authorized protocol-method dispatch into storage domains.
use super::operations::idempotent;
use super::*;

fn recovery_transition(
    storage: &mut Storage,
    method: &str,
    params: &Value,
    action: impl FnOnce(&mut Storage) -> Result<Value, KernelError>,
) -> Result<Value, KernelError> {
    let transition_id = params
        .get("transitionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| KernelError::Operation(format!("{method} requires transitionId")))?;
    let mut identity = params.clone();
    let object = identity
        .as_object_mut()
        .ok_or_else(|| KernelError::Protocol("request params must be an object".to_string()))?;
    if let Some(target) = params.get("operationId").and_then(Value::as_str) {
        object.insert(
            "targetOperationId".to_string(),
            Value::String(target.to_string()),
        );
    }
    object.insert(
        "operationId".to_string(),
        Value::String(transition_id.to_string()),
    );
    idempotent(storage, method, &identity, action)
}

impl Storage {
    pub(crate) fn dispatch(
        &mut self,
        method: &str,
        authorized_params: &Value,
        grant_id: Option<&str>,
        authorized_grant: &Grant,
    ) -> Result<Value, KernelError> {
        self.sweep_compute_readers()?;
        let storage = self;
        match method {
            method if method.starts_with("compute.") => storage.dispatch_compute(method, authorized_params, authorized_grant),
            method if method.starts_with("process.") => {
                storage.dispatch_process(method, authorized_params, authorized_grant)
            }
            "storage.health" => storage.health(authorized_params),
            "storage.snapshot" => storage.snapshot(authorized_params),
            "storage.putBlob.begin" => {
                storage.begin_blob_stream(authorized_params, grant_id.unwrap_or(""))
            }
            "storage.putBlob.chunk" => {
                storage.stream_blob_chunk(authorized_params, grant_id.unwrap_or(""))?;
                Ok(json!({"sequence": authorized_params["sequence"]}))
            }
            "storage.putBlob.finish" => idempotent(storage, method, authorized_params, |storage| {
                storage.finish_blob_stream(authorized_params, grant_id.unwrap_or(""))
            }),
            "storage.putBlob.abort" => {
                storage.abort_blob_stream(authorized_params, grant_id.unwrap_or(""))
            }
            "storage.blob.release" => storage.release_object_owner(
                authorized_params,
                authorized_params.get("workspaceId").and_then(Value::as_str),
                grant_id.unwrap_or(""),
            ),
            "storage.object.rebindOwner" => storage.rebind_object_owner(
                authorized_params,
                authorized_params.get("workspaceId").and_then(Value::as_str),
                grant_id.unwrap_or(""),
            ),
            "storage.getBlob" => storage.get_blob(
                authorized_params,
                grant_id.unwrap_or(""),
                authorized_grant.capabilities.contains("storage.admin"),
            ),
            "file.read.check" => storage.native_file_read_check(authorized_params, authorized_grant),
            "file.root.register" => storage.file_root_register(authorized_params, authorized_grant),
            "file.operation.list" => {
                storage.file_operation_list(authorized_params, authorized_grant)
            }
            "file.operation.reconcile" => {
                storage.file_operation_reconcile(authorized_params, authorized_grant)
            }
            "file.lease.acquire" => storage.file_lease_acquire(authorized_params, authorized_grant),
            "file.lease.check" => storage.file_lease_check(authorized_params, authorized_grant),
            "file.lease.release" => storage.file_lease_release(authorized_params, authorized_grant),
            "file.capture" => storage.file_capture(authorized_params, authorized_grant),
            "file.apply" => storage.file_apply(authorized_params, authorized_grant),
            "file.mkdir" => storage.file_mkdir(authorized_params, authorized_grant),
            "file.remove" => storage.file_remove(authorized_params, authorized_grant),
            "file.rename" => storage.file_rename(authorized_params, authorized_grant),
            "file.scan" => storage.file_scan(authorized_params, authorized_grant),
            "file.measure" => storage.file_measure(authorized_params, authorized_grant),
            "file.materialize" => storage.file_materialize(authorized_params, authorized_grant),
            "storage.record.put" => idempotent(storage, method, authorized_params, |storage| {
                storage.domain_record_put(authorized_params, grant_id.unwrap_or(""))
            }),
            "storage.record.get" => {
                storage.domain_record_get(authorized_params, grant_id.unwrap_or(""))
            }
            "storage.record.list" => {
                storage.domain_record_list(authorized_params, grant_id.unwrap_or(""))
            }
            "storage.record.workspaces" => {
                storage.domain_record_workspaces(authorized_params, grant_id.unwrap_or(""))
            }
            "storage.record.release" => idempotent(storage, method, authorized_params, |storage| {
                storage.domain_record_release(authorized_params, grant_id.unwrap_or(""))
            }),
            "working.result.put" => idempotent(storage, method, authorized_params, |storage| {
                storage.working_record_put(
                    method,
                    "working.result",
                    "published",
                    "document",
                    authorized_params,
                    grant_id.unwrap_or(""),
                )
            }),
            "working.result.get" => storage.working_record_get(
                authorized_params,
                grant_id.unwrap_or(""),
                "working.result",
            ),
            "working.result.list" => storage.working_record_list(
                authorized_params,
                grant_id.unwrap_or(""),
                "working.result",
            ),
            "working.result.release" => idempotent(storage, method, authorized_params, |storage| {
                storage.working_record_release(
                    authorized_params,
                    grant_id.unwrap_or(""),
                    "working.result",
                )
            }),
            "working.draft.put" => idempotent(storage, method, authorized_params, |storage| {
                storage.working_record_put(
                    method,
                    "working.draft",
                    "active",
                    "document",
                    authorized_params,
                    grant_id.unwrap_or(""),
                )
            }),
            "working.draft.get" => storage.working_record_get(
                authorized_params,
                grant_id.unwrap_or(""),
                "working.draft",
            ),
            "working.draft.list" => storage.working_record_list(
                authorized_params,
                grant_id.unwrap_or(""),
                "working.draft",
            ),
            "working.draft.release" => idempotent(storage, method, authorized_params, |storage| {
                storage.working_record_release(
                    authorized_params,
                    grant_id.unwrap_or(""),
                    "working.draft",
                )
            }),
            "working.verification.put" => {
                idempotent(storage, method, authorized_params, |storage| {
                    let kind = authorized_params
                        .get("kind")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            KernelError::Operation("verification kind is required".to_string())
                        })?;
                    let record_type = match kind {
                        "child" => "working.verification.child",
                        "parent" => "working.verification.parent",
                        _ => {
                            return Err(KernelError::Operation(
                                "verification kind is invalid".to_string(),
                            ))
                        }
                    };
                    storage.working_record_put(
                        method,
                        record_type,
                        "recorded",
                        "document",
                        authorized_params,
                        grant_id.unwrap_or(""),
                    )
                })
            }
            "working.verification.list" => {
                let kind = authorized_params
                    .get("kind")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        KernelError::Operation("verification kind is required".to_string())
                    })?;
                let record_type = match kind {
                    "child" => "working.verification.child",
                    "parent" => "working.verification.parent",
                    _ => {
                        return Err(KernelError::Operation(
                            "verification kind is invalid".to_string(),
                        ))
                    }
                };
                storage.working_record_list(authorized_params, grant_id.unwrap_or(""), record_type)
            }
            "working.verification.release" => {
                idempotent(storage, method, authorized_params, |storage| {
                    storage.working_record_release(
                        authorized_params,
                        grant_id.unwrap_or(""),
                        "working.verification",
                    )
                })
            }
            "working.review.put" => idempotent(storage, method, authorized_params, |storage| {
                storage.working_record_put(
                    method,
                    "working.review",
                    "recorded",
                    "document",
                    authorized_params,
                    grant_id.unwrap_or(""),
                )
            }),
            "working.review.list" => storage.working_record_list(
                authorized_params,
                grant_id.unwrap_or(""),
                "working.review",
            ),
            "working.review.release" => idempotent(storage, method, authorized_params, |storage| {
                storage.working_record_release(
                    authorized_params,
                    grant_id.unwrap_or(""),
                    "working.review",
                )
            }),
            "branch.create.begin" => {
                storage.begin_branch_builder(authorized_params, grant_id.unwrap_or(""))
            }
            "branch.create.append" => {
                storage.append_branch_builder(authorized_params, grant_id.unwrap_or(""))
            }
            "branch.create.finish" => {
                storage.finish_branch_builder(authorized_params, grant_id.unwrap_or(""))
            }
            "branch.create.abort" => {
                storage.abort_branch_builder(authorized_params, grant_id.unwrap_or(""))
            }
            "branch.read" => storage.branch_read(authorized_params),
            "branch.write.begin" => {
                storage.begin_branch_write_builder(authorized_params, grant_id.unwrap_or(""))
            }
            "branch.write.append" => {
                storage.append_branch_write_builder(authorized_params, grant_id.unwrap_or(""))
            }
            "branch.write.finish" => {
                storage.finish_branch_write_builder(authorized_params, grant_id.unwrap_or(""))
            }
            "branch.write.abort" => {
                storage.abort_branch_write_builder(authorized_params, grant_id.unwrap_or(""))
            }
            "branch.publish" => idempotent(storage, method, authorized_params, |storage| {
                storage.branch_publish(authorized_params)
            }),
            "branch.pin" => idempotent(storage, method, authorized_params, |storage| {
                storage.branch_pin(authorized_params, true, grant_id.unwrap_or(""))
            }),
            "branch.unpin" => idempotent(storage, method, authorized_params, |storage| {
                storage.branch_pin(authorized_params, false, grant_id.unwrap_or(""))
            }),
            "branch.diff" => storage.branch_diff(authorized_params),
            "branch.objects" => storage.branch_objects(authorized_params),
            "branch.delete" => idempotent(storage, method, authorized_params, |storage| {
                storage.branch_delete(authorized_params)
            }),
            "pin.read" => storage.pin_read(authorized_params, grant_id.unwrap_or("")),
            "storage.gc" => idempotent(storage, method, authorized_params, |storage| storage.gc()),
            "recovery.operation.get" => {
                storage.recovery_operation_get(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.turn.start" => {
                storage.recovery_turn_start(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.turn.get" => {
                storage.recovery_turn_get(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.turn.settle" => {
                storage.recovery_turn_settle(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.checkpoint.create" => {
                storage.recovery_checkpoint_create(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.checkpoint.list" => {
                storage.recovery_checkpoint_list(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.entry.resolve" => {
                storage.recovery_entry_resolve(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.change.before" => idempotent(storage, method, authorized_params, |storage| {
                storage.recovery_change_before(authorized_params, grant_id.unwrap_or(""))
            }),
            "recovery.change.get" => {
                storage.recovery_change_get(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.change.list" => {
                storage.recovery_change_list(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.change.after" => idempotent(storage, method, authorized_params, |storage| {
                storage.recovery_change_after(authorized_params, grant_id.unwrap_or(""))
            }),
            "recovery.operation.create" => {
                storage.recovery_operation_create(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.operation.file.cas" => {
                recovery_transition(storage, method, authorized_params, |storage| {
                    storage.recovery_operation_file_cas(authorized_params, grant_id.unwrap_or(""))
                })
            }
            "recovery.operation.complete" => {
                recovery_transition(storage, method, authorized_params, |storage| {
                    storage.recovery_operation_complete(authorized_params, grant_id.unwrap_or(""))
                })
            }
            "recovery.operation.list" => {
                storage.recovery_operation_list(authorized_params, grant_id.unwrap_or(""))
            }
            "recovery.operation.release" => {
                recovery_transition(storage, method, authorized_params, |storage| {
                    storage.recovery_operation_release(authorized_params, grant_id.unwrap_or(""))
                })
            }
            "operation.get" => storage.operation_get(authorized_params),
            "operation.release" => storage.operation_release(authorized_params),
            _ => Err(KernelError::Protocol(format!("unknown method: {method}"))),
        }
    }
}
