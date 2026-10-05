//! Idempotent operation log and transaction identity.
use super::*;

impl Storage {
    pub(super) fn operation_existing(
        &self,
        id: &str,
        kind: &str,
        params_hash: &str,
    ) -> Result<Option<Value>, KernelError> {
        let row: Option<(String, String, String, Option<String>)> = self.conn.query_row(
            "SELECT kind, params_hash, state, result_json FROM operations WHERE operation_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        match row {
            None => Ok(None),
            Some((stored_kind, stored_hash, state, result)) => {
                if stored_kind != kind || stored_hash != params_hash {
                    return Err(KernelError::Operation(format!(
                        "operationId {id} was reused with different parameters"
                    )));
                }
                if state == "failed" {
                    return Ok(None);
                }
                match result {
                    Some(text) => Ok(Some(serde_json::from_str(&text)?)),
                    None => Err(KernelError::Operation(format!(
                        "operationId {id} is still in progress"
                    ))),
                }
            }
        }
    }

    pub(super) fn operation_begin(
        &mut self,
        id: &str,
        kind: &str,
        params_hash: &str,
    ) -> Result<(), KernelError> {
        self.conn.execute(
            "INSERT INTO operations(operation_id, kind, params_hash, state, created_at, updated_at) VALUES (?1, ?2, ?3, 'started', ?4, ?4)",
            params![id, kind, params_hash, now_ms()],
        )?;
        Ok(())
    }

    pub(super) fn operation_finish(&mut self, id: &str, result: &Value) -> Result<(), KernelError> {
        if std::env::var_os("VARIN_KERNEL_FAIL_OPERATION_FINISH").is_some() {
            return Err(KernelError::Storage(
                "injected operation finish failure".to_string(),
            ));
        }
        self.conn.execute(
            "UPDATE operations SET state = 'committed', result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
            params![id, serde_json::to_string(result)?, now_ms()],
        )?;
        Ok(())
    }

    pub(super) fn operation_failed(
        &mut self,
        id: &str,
        error: &KernelError,
    ) -> Result<(), KernelError> {
        self.conn.execute(
            "UPDATE operations SET state = 'failed', result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
            params![id, serde_json::to_string(&json!({"error": error.to_string()}))?, now_ms()],
        )?;
        Ok(())
    }

    pub(super) fn record_operation_workspace(
        &mut self,
        operation_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<(), KernelError> {
        if let Some(workspace_id) = workspace_id {
            self.conn.execute(
                "INSERT OR IGNORE INTO operation_owners(operation_id, workspace_id, created_at) VALUES (?1, ?2, ?3)",
                params![operation_id, workspace_id, now_ms()],
            )?;
        }
        Ok(())
    }

    pub(super) fn operation_get(&self, params_value: &Value) -> Result<Value, KernelError> {
        let id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let row: Option<(String, String, String, Option<String>, i64, i64)> = self.conn.query_row(
            "SELECT kind, params_hash, state, result_json, created_at, updated_at FROM operations WHERE operation_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).optional()?;
        let Some((kind, params_hash, state, result, created_at, updated_at)) = row else {
            return Ok(Value::Null);
        };
        Ok(json!({
            "operationId": id,
            "kind": kind,
            "paramsHash": params_hash,
            "state": state,
            "result": result.map(|text| serde_json::from_str::<Value>(&text)).transpose()?,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }))
    }

    pub(super) fn operation_release(&mut self, params_value: &Value) -> Result<Value, KernelError> {
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Authorization("operation workspace is required".to_string())
            })?;
        let blocked: Option<String> = self
            .conn
            .query_row(
                "SELECT 'pending-operation' FROM operations WHERE operation_id = ?1 AND state = 'started' UNION SELECT 'temporary-object' FROM object_owners WHERE operation_id = ?1 UNION SELECT 'revision' FROM revisions WHERE operation_id = ?1 LIMIT 1",
                params![operation_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(blocked) = blocked {
            return Ok(json!({
                "operationId": operation_id,
                "released": false,
                "status": "in-use",
                "reason": blocked,
            }));
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            let owned: Option<i64> = self
                .conn
                .query_row(
                    "SELECT 1 FROM operation_owners WHERE operation_id = ?1 AND workspace_id = ?2",
                    params![operation_id, workspace_id],
                    |row| row.get(0),
                )
                .optional()?;
            if owned.is_none() {
                return Ok(false);
            }
            self.conn.execute(
                "DELETE FROM operation_owners WHERE operation_id = ?1 AND workspace_id = ?2",
                params![operation_id, workspace_id],
            )?;
            self.conn.execute(
                "DELETE FROM operations WHERE operation_id = ?1",
                params![operation_id],
            )?;
            Ok::<bool, KernelError>(true)
        })();
        match outcome {
            Ok(released) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(
                    json!({"operationId": operation_id, "released": released, "status": if released { "released" } else { "missing" }}),
                )
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}

pub(super) fn idempotent(
    storage: &mut Storage,
    kind: &str,
    params_value: &Value,
    action: impl FnOnce(&mut Storage) -> Result<Value, KernelError>,
) -> Result<Value, KernelError> {
    let operation_id = params_value
        .get("operationId")
        .and_then(Value::as_str)
        .ok_or_else(|| KernelError::Operation(format!("{kind} requires operationId")))?;
    let mut identity_params = params_value.clone();
    if kind == "storage.putBlob.finish" {
        if let Some(object) = identity_params.as_object_mut() {
            object.remove("streamId");
        }
    }
    let params_hash = hash_json(&identity_params)?;
    if let Some(result) = storage.operation_existing(operation_id, kind, &params_hash)? {
        return Ok(result);
    }
    let prior_cleanup = if kind == "storage.gc" {
        storage.sweep_orphan_objects()?;
        Some(storage.drain_gc_files()?)
    } else {
        None
    };
    storage.conn.execute(
        "DELETE FROM operations WHERE operation_id = ?1 AND state = 'failed'",
        params![operation_id],
    )?;
    storage.conn.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| {
        storage.operation_begin(operation_id, kind, &params_hash)?;
        storage.record_operation_workspace(
            operation_id,
            params_value.get("workspaceId").and_then(Value::as_str),
        )?;
        let result = action(storage)?;
        storage.operation_finish(operation_id, &result)?;
        Ok::<Value, KernelError>(result)
    })();
    match outcome {
        Ok(result) => {
            storage.conn.execute_batch("COMMIT")?;
            if kind == "storage.gc" {
                let cleanup = storage.drain_gc_files()?;
                let mut enriched = result.clone();
                if let Some(object) = enriched.as_object_mut() {
                    let deleted = cleanup
                        .get("deleted")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len)
                        + prior_cleanup
                            .as_ref()
                            .and_then(|prior| prior.get("deleted"))
                            .and_then(Value::as_array)
                            .map_or(0, Vec::len);
                    let reclaimed_bytes = cleanup
                        .get("byteLengthReclaimed")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        + prior_cleanup
                            .as_ref()
                            .and_then(|prior| prior.get("byteLengthReclaimed"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                    let (_, failures) = storage.cleanup_status()?;
                    object.insert("deletedBlobs".to_string(), json!(deleted));
                    object.insert("byteLengthReclaimed".to_string(), json!(reclaimed_bytes));
                    object.insert("cleanupFailures".to_string(), json!(failures));
                }
                storage.conn.execute(
                    "UPDATE operations SET result_json = ?2, updated_at = ?3 WHERE operation_id = ?1",
                    params![operation_id, serde_json::to_string(&enriched)?, now_ms()],
                )?;
                return Ok(enriched);
            }
            Ok(result)
        }
        Err(error) => {
            let _ = storage.conn.execute_batch("ROLLBACK");
            storage.conn.execute_batch("BEGIN IMMEDIATE")?;
            storage.operation_begin(operation_id, kind, &params_hash)?;
            storage.operation_failed(operation_id, &error)?;
            storage.conn.execute_batch("COMMIT")?;
            Err(error)
        }
    }
}
