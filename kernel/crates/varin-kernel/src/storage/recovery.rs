//! Typed Recovery checkpoints, turns, changes, operations, and per-file phases.
use super::*;

impl Storage {
    pub(super) fn recovery_workspace(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<String, KernelError> {
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                KernelError::Operation("recovery workspaceId is required".to_string())
            })?;
        let grant = self.load_grant(grant_id)?;
        if grant.owning_workspace.as_deref() != Some(workspace_id)
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "recovery workspace does not match actor grant".to_string(),
            ));
        }
        for key in ["sessionId", "threadId", "runId"] {
            let supplied = params_value.get(key).and_then(Value::as_str);
            let expected = match key {
                "sessionId" => grant.session_id.as_deref(),
                "threadId" => grant.thread_id.as_deref(),
                _ => grant.run_id.as_deref(),
            };
            if supplied.is_some() && expected.is_some() && supplied != expected {
                return Err(KernelError::Authorization(format!(
                    "recovery {key} does not match actor grant"
                )));
            }
            if supplied.is_some()
                && expected.is_none()
                && !grant.capabilities.contains("recovery.maintenance")
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(format!(
                    "recovery {key} requires an actor-bound grant"
                )));
            }
        }
        Ok(workspace_id.to_string())
    }

    pub(super) fn require_recovery_owner(
        &self,
        grant_id: &str,
        session_id: Option<&str>,
        thread_id: Option<&str>,
        run_id: Option<&str>,
    ) -> Result<(), KernelError> {
        let grant = self.load_grant(grant_id)?;
        if grant.capabilities.contains("recovery.maintenance")
            || grant.capabilities.contains("storage.admin")
        {
            return Ok(());
        }
        let identities = [
            ("sessionId", session_id, grant.session_id.as_deref()),
            ("threadId", thread_id, grant.thread_id.as_deref()),
            ("runId", run_id, grant.run_id.as_deref()),
        ];
        if identities.iter().all(|(_, value, _)| value.is_none()) {
            return Err(KernelError::Authorization(
                "unowned recovery resources require a maintenance grant".to_string(),
            ));
        }
        for (name, resource, actor) in identities {
            if let Some(resource) = resource {
                if actor != Some(resource) {
                    return Err(KernelError::Authorization(format!(
                        "recovery {name} does not match actor grant"
                    )));
                }
            }
        }
        Ok(())
    }

    pub(super) fn validate_recovery_state(value: &Value, label: &str) -> Result<(), KernelError> {
        let object = value.as_object().ok_or_else(|| {
            KernelError::Operation(format!("{label} must be a recovery state object"))
        })?;
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation(format!("{label}.kind is required")))?;
        let allowed: &[&str] = match kind {
            "missing" | "unsupported" => &["kind"],
            "directory" => &["kind", "mode"],
            "symlink" => &["kind", "mode", "symlinkTarget"],
            "regular-file" => &["kind", "objectHash", "byteLength", "mode"],
            _ => return Err(KernelError::Operation(format!("{label}.kind is invalid"))),
        };
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(KernelError::Operation(format!(
                "{label} contains unknown fields"
            )));
        }
        if let Some(mode) = object.get("mode") {
            if mode.as_u64().is_none_or(|mode| mode > u32::MAX as u64) {
                return Err(KernelError::Operation(format!("{label}.mode is invalid")));
            }
        }
        match kind {
            "regular-file" => {
                let hash = object
                    .get("objectHash")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if hash.len() != 71
                    || !hash.starts_with("sha256-")
                    || !hash[7..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    return Err(KernelError::Operation(format!(
                        "{label}.objectHash is invalid"
                    )));
                }
                if object.get("byteLength").and_then(Value::as_u64).is_none() {
                    return Err(KernelError::Operation(format!(
                        "{label}.byteLength is invalid"
                    )));
                }
            }
            "symlink" => {
                if object
                    .get("symlinkTarget")
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(KernelError::Operation(format!(
                        "{label}.symlinkTarget is required"
                    )));
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn recovery_state_hash(
        value: &Value,
        label: &str,
    ) -> Result<Option<String>, KernelError> {
        Self::validate_recovery_state(value, label)?;
        Ok(value
            .get("objectHash")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    pub(super) fn require_recovery_state_reference(
        state: &Value,
        label: &str,
        references: &[(String, String, Option<String>)],
    ) -> Result<(), KernelError> {
        if let Some(hash) = Self::recovery_state_hash(state, label)? {
            if !references
                .iter()
                .any(|(_, reference_hash, _)| reference_hash == &hash)
            {
                return Err(KernelError::Operation(format!(
                    "{label} content is missing its durable reference"
                )));
            }
        }
        Ok(())
    }

    pub(super) fn recovery_json_object(
        params_value: &Value,
        field: &str,
    ) -> Result<Value, KernelError> {
        let raw = params_value
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation(format!("{field} is required")))?;
        let value = serde_json::from_str::<Value>(raw)
            .map_err(|error| KernelError::Operation(format!("{field} is malformed: {error}")))?;
        if !value.is_object() {
            return Err(KernelError::Operation(format!(
                "{field} must contain an object"
            )));
        }
        if let Some(kind) = value.get("kind").and_then(Value::as_str) {
            match kind {
                "missing" | "unsupported" | "directory" => {}
                "symlink" => {
                    if value.get("symlinkTarget").and_then(Value::as_str).is_none() {
                        return Err(KernelError::Operation(format!(
                            "{field} symlinkTarget is required"
                        )));
                    }
                }
                "regular-file" => {
                    let hash = value
                        .get("objectHash")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let byte_length = value.get("byteLength").and_then(Value::as_i64);
                    if !hash.starts_with("sha256-") || byte_length.is_none_or(|length| length < 0) {
                        return Err(KernelError::Operation(format!(
                            "{field} regular-file state is malformed"
                        )));
                    }
                }
                _ => {
                    return Err(KernelError::Operation(format!(
                        "{field} kind is unsupported"
                    )))
                }
            }
        }
        Ok(value)
    }

    pub(super) fn recovery_references(
        &self,
        params_value: &Value,
        workspace_id: &str,
        grant_id: &str,
    ) -> Result<Vec<(String, String, Option<String>)>, KernelError> {
        let references = params_value
            .get("references")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                KernelError::Operation("recovery references are required".to_string())
            })?;
        let mut slots = BTreeSet::new();
        let mut result = Vec::with_capacity(references.len());
        for reference in references {
            let slot = reference
                .get("slot")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("recovery reference slot is malformed".to_string())
                })?;
            if !slots.insert(slot.to_string()) {
                return Err(KernelError::Operation(
                    "recovery reference slots must be unique".to_string(),
                ));
            }
            let hash = reference
                .get("objectHash")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("sha256-") && value.len() == 71)
                .ok_or_else(|| {
                    KernelError::Operation("recovery reference objectHash is malformed".to_string())
                })?;
            let owner_id = reference
                .get("ownerId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            if let Some(owner_id) = owner_id {
                let owned_hash: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT blob_hash FROM object_owners WHERE owner_id = ?1 AND blob_hash = ?2 AND workspace_id = ?3 AND grant_id = ?4",
                        params![owner_id, hash, workspace_id, grant_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if owned_hash.is_none() {
                    return Err(KernelError::Authorization(format!(
                        "recovery owner is not valid: {owner_id}"
                    )));
                }
            } else {
                let durable = self
                    .conn
                    .query_row(
                        "SELECT 1 FROM blobs WHERE hash = ?1 AND (EXISTS (SELECT 1 FROM recovery_refs WHERE object_hash = ?1 AND workspace_id = ?2) OR EXISTS (SELECT 1 FROM domain_record_refs WHERE object_hash = ?1 AND workspace_id = ?2) OR EXISTS (SELECT 1 FROM root_blobs WHERE blob_hash = ?1))",
                        params![hash, workspace_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some();
                if !durable {
                    return Err(KernelError::Authorization(
                        "recovery reference must consume an owner or existing durable reference"
                            .to_string(),
                    ));
                }
            }
            result.push((
                slot.to_string(),
                hash.to_string(),
                owner_id.map(str::to_string),
            ));
        }
        Ok(result)
    }

    pub(super) fn insert_recovery_refs(
        &mut self,
        workspace_id: &str,
        owner_kind: &str,
        owner_id: &str,
        references: &[(String, String, Option<String>)],
        grant_id: &str,
    ) -> Result<(), KernelError> {
        self.conn.execute(
            "DELETE FROM recovery_refs WHERE workspace_id = ?1 AND owner_kind = ?2 AND owner_id = ?3",
            params![workspace_id, owner_kind, owner_id],
        )?;
        let mut consumed = BTreeMap::new();
        for (slot, hash, owner) in references {
            self.conn.execute(
                "INSERT INTO recovery_refs(workspace_id, owner_kind, owner_id, slot, object_hash) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workspace_id, owner_kind, owner_id, slot, hash],
            )?;
            if let Some(owner) = owner {
                consumed.insert(owner.clone(), hash.clone());
            }
        }
        self.consume_object_owners(workspace_id, grant_id, &consumed)
    }

    pub(super) fn recovery_checkpoint_value(
        &self,
        workspace_id: &str,
        id: &str,
    ) -> Result<Option<Value>, KernelError> {
        let row: Option<(String, String, i64, String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64, i64, i64)> = self.conn.query_row(
            "SELECT id, workspace_id, sequence, source, state, created_at, label, session_id, entry_id, execution_id, changed_path_count, byte_length, revision FROM recovery_checkpoints WHERE workspace_id = ?1 AND id = ?2",
            params![workspace_id, id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?)),
        ).optional()?;
        Ok(row.map(|(id, workspace_id, sequence, source, state, created_at, label, session_id, entry_id, execution_id, changed_path_count, byte_length, revision)| json!({
            "id": id, "workspaceId": workspace_id, "sequence": sequence, "source": source, "state": state, "createdAt": created_at,
            "label": label, "sessionId": session_id, "entryId": entry_id, "executionId": execution_id,
            "changedPathCount": changed_path_count, "byteLength": byte_length, "revision": revision,
        })))
    }

    pub(super) fn recovery_turn_value(
        &self,
        workspace_id: &str,
        execution_id: &str,
    ) -> Result<Option<Value>, KernelError> {
        let row: Option<(String, String, String, i64, String, String, String, Option<String>, String, String, String, String, String, String, Option<String>, String, Option<String>, i64)> = self.conn.query_row(
            "SELECT execution_id, workspace_id, runtime_key, runtime_generation, worker_id, session_id, user_entry_id, assistant_entry_id, checkpoint_id, active_writer_scopes_json, provenance, status, observed_resource_ids_json, unrecorded_resource_ids_json, failure_json, started_at, settled_at, revision FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2",
            params![workspace_id, execution_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?, row.get(13)?, row.get(14)?, row.get(15)?, row.get(16)?, row.get(17)?)),
        ).optional()?;
        let Some((
            execution_id,
            workspace_id,
            runtime_key,
            runtime_generation,
            worker_id,
            session_id,
            user_entry_id,
            assistant_entry_id,
            checkpoint_id,
            active_writer_scopes_json,
            provenance,
            status,
            observed_resource_ids_json,
            unrecorded_resource_ids_json,
            failure_json,
            started_at,
            settled_at,
            revision,
        )) = row
        else {
            return Ok(None);
        };
        Ok(Some(json!({
            "executionId": execution_id, "workspaceId": workspace_id, "runtimeKey": runtime_key, "runtimeGeneration": runtime_generation,
            "workerId": worker_id, "sessionId": session_id, "userEntryId": user_entry_id, "assistantEntryId": assistant_entry_id,
            "checkpointId": checkpoint_id, "activeWriterScopes": serde_json::from_str::<Value>(&active_writer_scopes_json)?, "provenance": provenance,
            "status": status, "observedResourceIds": serde_json::from_str::<Value>(&observed_resource_ids_json)?, "unrecordedResourceIds": serde_json::from_str::<Value>(&unrecorded_resource_ids_json)?,
            "failure": failure_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()), "startedAt": started_at, "settledAt": settled_at, "revision": revision,
        })))
    }

    pub(super) fn recovery_turn_start(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        let session_id = params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("sessionId is required".to_string()))?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let identity_hash = hash_json(params_value)?;
        if let Some(existing) =
            self.operation_existing(operation_id, "recovery.turn.start", &identity_hash)?
        {
            return Ok(existing);
        }
        if let Some(existing) = self.recovery_turn_value(&workspace_id, execution_id)? {
            return Ok(existing);
        }
        let now = format!("{}", chrono_like_now());
        let checkpoint_id = format!("recovery.checkpoint:{workspace_id}:{execution_id}");
        let sequence: i64 = self.conn.query_row("SELECT COALESCE(MAX(sequence), 0) + 1 FROM recovery_checkpoints WHERE workspace_id = ?1", params![workspace_id], |row| row.get(0))?;
        let active = serde_json::to_string(
            &params_value
                .get("activeWriterScopes")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        let runtime_generation = params_value
            .get("runtimeGeneration")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let runtime_key = format!(
            "{}@{}",
            params_value
                .get("workerId")
                .and_then(Value::as_str)
                .unwrap_or(""),
            runtime_generation
        );
        let status = if params_value
            .get("failure")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "incomplete"
        } else {
            "pending"
        };
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.operation_begin(operation_id, "recovery.turn.start", &identity_hash)?;
            self.record_operation_workspace(operation_id, Some(&workspace_id))?;
            recovery_fault("turn-intent")?;
            self.conn.execute("INSERT INTO recovery_checkpoints(id, workspace_id, sequence, source, state, created_at, session_id, entry_id, execution_id, revision) VALUES (?1, ?2, ?3, 'turn', ?4, ?5, ?6, ?7, ?8, 1)", params![checkpoint_id, workspace_id, sequence, status, now, session_id, params_value.get("userEntryId").and_then(Value::as_str), execution_id])?;
            self.conn.execute("INSERT INTO recovery_turns(execution_id, workspace_id, runtime_key, runtime_generation, worker_id, session_id, user_entry_id, checkpoint_id, active_writer_scopes_json, provenance, status, observed_resource_ids_json, unrecorded_resource_ids_json, started_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '[]', '[]', ?12, 1)", params![execution_id, workspace_id, runtime_key, runtime_generation, params_value.get("workerId").and_then(Value::as_str).unwrap_or(""), session_id, params_value.get("userEntryId").and_then(Value::as_str).unwrap_or(""), checkpoint_id, active, params_value.get("provenance").and_then(Value::as_str).unwrap_or("caused-by"), status, now])?;
            let value = self
                .recovery_turn_value(&workspace_id, execution_id)?
                .ok_or_else(|| {
                    KernelError::Storage("recovery turn disappeared after commit".to_string())
                })?;
            self.operation_finish(operation_id, &value)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub(super) fn recovery_turn_get(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        Ok(self
            .recovery_turn_value(&workspace_id, execution_id)?
            .unwrap_or(Value::Null))
    }

    pub(super) fn recovery_turn_settle(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let identity_hash = hash_json(params_value)?;
        if let Some(existing) =
            self.operation_existing(operation_id, "recovery.turn.settle", &identity_hash)?
        {
            return Ok(existing);
        }
        let expected = params_value
            .get("expectedRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| KernelError::Operation("expectedRevision is required".to_string()))?;
        let current: Option<(i64, String, String)> = self.conn.query_row("SELECT revision, checkpoint_id, status FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2", params![workspace_id, execution_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((revision, checkpoint_id, _)) = current else {
            return Err(KernelError::Operation(
                "recovery turn not found".to_string(),
            ));
        };
        if revision != expected {
            return Err(KernelError::Operation(
                "recovery turn revision conflict".to_string(),
            ));
        }
        let status = params_value
            .get("status")
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "pending" | "ready" | "incomplete" | "failed"))
            .ok_or_else(|| KernelError::Operation("recovery turn status is invalid".to_string()))?;
        let observed = serde_json::to_string(
            &params_value
                .get("observedResourceIds")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        let unrecorded = serde_json::to_string(
            &params_value
                .get("unrecordedResourceIds")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        let active = serde_json::to_string(
            &params_value
                .get("activeWriterScopes")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )?;
        let provenance = params_value
            .get("provenance")
            .and_then(Value::as_str)
            .unwrap_or("caused-by");
        let failure = params_value.get("failureJson").and_then(Value::as_str);
        let now = format!("{}", chrono_like_now());
        let mut changed_path_count = 0_i64;
        let mut byte_length = 0_i64;
        {
            let mut statement = self.conn.prepare("SELECT before_json, after_json FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND after_json IS NOT NULL")?;
            let rows = statement
                .query_map(params![workspace_id, checkpoint_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (before_json, after_json) in rows {
                let before = serde_json::from_str::<Value>(&before_json)?;
                let after = serde_json::from_str::<Value>(&after_json)?;
                if before == after {
                    continue;
                }
                changed_path_count += 1;
                let before_bytes = before
                    .get("byteLength")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let after_bytes = after.get("byteLength").and_then(Value::as_i64).unwrap_or(0);
                byte_length += before_bytes.max(after_bytes);
            }
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.operation_begin(operation_id, "recovery.turn.settle", &identity_hash)?;
            self.record_operation_workspace(operation_id, Some(&workspace_id))?;
            self.conn.execute("UPDATE recovery_turns SET assistant_entry_id = ?1, status = ?2, observed_resource_ids_json = ?3, unrecorded_resource_ids_json = ?4, active_writer_scopes_json = ?5, provenance = ?6, failure_json = ?7, settled_at = ?8, revision = revision + 1 WHERE workspace_id = ?9 AND execution_id = ?10 AND revision = ?11", params![params_value.get("assistantEntryId").and_then(Value::as_str), status, observed, unrecorded, active, provenance, failure, now, workspace_id, execution_id, expected])?;
            self.conn.execute("UPDATE recovery_checkpoints SET state = ?1, changed_path_count = ?2, byte_length = ?3, revision = revision + 1 WHERE workspace_id = ?4 AND id = ?5", params![status, changed_path_count, byte_length, workspace_id, checkpoint_id])?;
            let value = self
                .recovery_turn_value(&workspace_id, execution_id)?
                .ok_or_else(|| {
                    KernelError::Storage("recovery turn disappeared after settle".to_string())
                })?;
            self.operation_finish(operation_id, &value)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub(super) fn recovery_checkpoint_create(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let label = params_value
            .get("label")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("checkpoint label is required".to_string()))?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let identity_hash = hash_json(params_value)?;
        if let Some(existing) =
            self.operation_existing(operation_id, "recovery.checkpoint.create", &identity_hash)?
        {
            return Ok(existing);
        }
        let id = format!(
            "recovery.checkpoint:{workspace_id}:named:{}",
            Uuid::new_v4()
        );
        let sequence: i64 = self.conn.query_row("SELECT COALESCE(MAX(sequence), 0) + 1 FROM recovery_checkpoints WHERE workspace_id = ?1", params![workspace_id], |row| row.get(0))?;
        let now = format!("{}", chrono_like_now());
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.operation_begin(operation_id, "recovery.checkpoint.create", &identity_hash)?;
            self.record_operation_workspace(operation_id, Some(&workspace_id))?;
            self.conn.execute("INSERT INTO recovery_checkpoints(id, workspace_id, sequence, source, state, created_at, label, revision) VALUES (?1, ?2, ?3, 'named', 'ready', ?4, ?5, 1)", params![id, workspace_id, sequence, now, label])?;
            let value = self
                .recovery_checkpoint_value(&workspace_id, &id)?
                .ok_or_else(|| {
                    KernelError::Storage("checkpoint disappeared after commit".to_string())
                })?;
            self.operation_finish(operation_id, &value)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub(super) fn recovery_checkpoint_list(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let cursor = params_value
            .get("cursor")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let page_size = params_value
            .get("pageSize")
            .and_then(Value::as_i64)
            .unwrap_or(128);
        if page_size <= 0 {
            return Err(KernelError::Operation(
                "pageSize must be positive".to_string(),
            ));
        }
        let rows: Vec<String> = self.conn.prepare("SELECT id FROM recovery_checkpoints WHERE workspace_id = ?1 AND sequence < ?2 ORDER BY sequence DESC LIMIT ?3")?.query_map(params![workspace_id, if cursor > 0 { cursor } else { i64::MAX }, page_size + 1], |row| row.get(0))?.collect::<Result<_, _>>()?;
        let has_more = rows.len() as i64 > page_size;
        let ids = rows
            .into_iter()
            .take(page_size as usize)
            .collect::<Vec<_>>();
        let mut checkpoints = Vec::new();
        for id in ids {
            if let Some(value) = self.recovery_checkpoint_value(&workspace_id, &id)? {
                checkpoints.push(value);
            }
        }
        let next_cursor = checkpoints
            .last()
            .and_then(|value| value.get("sequence").and_then(Value::as_i64))
            .filter(|_| has_more);
        Ok(json!({"checkpoints": checkpoints, "nextCursor": next_cursor}))
    }

    pub(super) fn recovery_entry_resolve(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let session_id = params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("sessionId is required".to_string()))?;
        let entry_id = params_value
            .get("entryId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("entryId is required".to_string()))?;
        let row: Option<(String, String, String)> = self.conn.query_row("SELECT execution_id, checkpoint_id, status FROM recovery_turns WHERE workspace_id = ?1 AND session_id = ?2 AND (user_entry_id = ?3 OR assistant_entry_id = ?3) ORDER BY started_at DESC LIMIT 1", params![workspace_id, session_id, entry_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((execution_id, checkpoint_id, status)) = row else {
            return Ok(json!({"status": "unbound", "reason": "entry-unbound"}));
        };
        let checkpoint = self
            .recovery_checkpoint_value(&workspace_id, &checkpoint_id)?
            .unwrap_or(Value::Null);
        if status != "ready" || checkpoint.get("state").and_then(Value::as_str) != Some("ready") {
            return Ok(
                json!({"status": "incomplete", "reason": "checkpoint-incomplete", "executionId": execution_id, "checkpoint": checkpoint}),
            );
        }
        Ok(
            json!({"status": "ready", "executionId": execution_id, "checkpoint": checkpoint, "position": "before"}),
        )
    }

    pub(super) fn recovery_change_before(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let before = Self::recovery_json_object(params_value, "beforeJson")?;
        Self::validate_recovery_state(&before, "beforeJson")?;
        let checkpoint_id = params_value
            .get("checkpointId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("checkpointId is required".to_string()))?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        let session_id = params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("sessionId is required".to_string()))?;
        let raw_path = params_value
            .get("path")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                KernelError::Operation("recovery change path is required".to_string())
            })?;
        let path = Self::validate_path(raw_path)?.join("/");
        let turn: Option<(String, String)> = self.conn.query_row(
            "SELECT checkpoint_id, session_id FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2",
            params![workspace_id, execution_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((turn_checkpoint, turn_session)) = turn else {
            return Err(KernelError::Operation(
                "recovery turn is not found".to_string(),
            ));
        };
        if turn_checkpoint != checkpoint_id || turn_session != session_id {
            return Err(KernelError::Authorization(
                "recovery change does not belong to the actor turn".to_string(),
            ));
        }
        self.require_recovery_owner(grant_id, Some(session_id), None, None)?;
        let references = self.recovery_references(params_value, &workspace_id, grant_id)?;
        Self::require_recovery_state_reference(&before, "beforeJson", &references)?;
        let now = format!("{}", chrono_like_now());
        let existing: Option<(i64, String, String, String)> = self.conn.query_row("SELECT revision, execution_id, mutation_id, before_json FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND path = ?3", params![workspace_id, checkpoint_id, path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
        if let Some((revision, stored_execution, _, _)) = &existing {
            if stored_execution != execution_id {
                return Err(KernelError::Operation(
                    "recovery change identity was reused with different input".to_string(),
                ));
            }
            return Ok(
                json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "revision": revision, "recorded": true, "existing": true}),
            );
        } else {
            self.conn.execute("INSERT INTO recovery_changes(workspace_id, checkpoint_id, path, execution_id, tool_name, mutation_id, before_json, state, created_at, updated_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'before', ?8, ?8, 1)", params![workspace_id, checkpoint_id, path, execution_id, params_value.get("toolName").and_then(Value::as_str).unwrap_or(""), params_value.get("mutationId").and_then(Value::as_str).unwrap_or(""), serde_json::to_string(&before)?, now])?;
        }
        self.insert_recovery_refs(
            &workspace_id,
            "change",
            &format!("change:{checkpoint_id}:{path}"),
            &references,
            grant_id,
        )?;
        Ok(
            json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "revision": existing.map(|value| value.0).unwrap_or(1), "recorded": true}),
        )
    }

    pub(super) fn recovery_change_get(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let checkpoint_id = params_value
            .get("checkpointId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("checkpointId is required".to_string()))?;
        let raw_path = params_value
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Operation("recovery change path is required".to_string())
            })?;
        let path = Self::validate_path(raw_path)?.join("/");
        let row: Option<(String, String, String, String, Option<String>, String, i64)> = self.conn.query_row("SELECT path, before_json, state, execution_id, after_json, updated_at, revision FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND path = ?3", params![workspace_id, checkpoint_id, path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))).optional()?;
        let Some((path, before_json, state, execution_id, after_json, updated_at, revision)) = row
        else {
            return Ok(Value::Null);
        };
        let session_id: Option<String> = self.conn.query_row(
            "SELECT session_id FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2 AND checkpoint_id = ?3",
            params![workspace_id, execution_id, checkpoint_id],
            |row| row.get(0),
        ).optional()?;
        self.require_recovery_owner(grant_id, session_id.as_deref(), None, None)?;
        Ok(
            json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "executionId": execution_id, "before": serde_json::from_str::<Value>(&before_json)?, "after": after_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()), "state": state, "updatedAt": updated_at, "revision": revision}),
        )
    }

    pub(super) fn recovery_change_list(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let requested_session = params_value.get("sessionId").and_then(Value::as_str);
        let requested_execution = params_value.get("executionId").and_then(Value::as_str);
        let requested_entries = params_value
            .get("entryIds")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        self.require_recovery_owner(grant_id, requested_session, None, None)?;

        let mut statement = self.conn.prepare(
            "SELECT t.execution_id, t.checkpoint_id, c.sequence, t.status, t.session_id, t.user_entry_id, t.assistant_entry_id, t.active_writer_scopes_json, t.unrecorded_resource_ids_json, t.failure_json FROM recovery_turns t JOIN recovery_checkpoints c ON c.workspace_id = t.workspace_id AND c.id = t.checkpoint_id WHERE t.workspace_id = ?1 ORDER BY c.sequence ASC",
        )?;
        let rows = statement
            .query_map(params![workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let selected = rows
            .into_iter()
            .filter(|row| {
                requested_session.is_none_or(|session| row.4 == session)
                    && requested_execution.is_none_or(|execution| row.0 == execution)
                    && (requested_entries.is_empty()
                        || requested_entries.contains(row.5.as_str())
                        || row
                            .6
                            .as_deref()
                            .is_some_and(|entry| requested_entries.contains(entry)))
            })
            .collect::<Vec<_>>();

        let mut turns = Vec::new();
        let mut changes = Vec::new();
        for (
            execution_id,
            checkpoint_id,
            sequence,
            status,
            session_id,
            user_entry_id,
            assistant_entry_id,
            active_json,
            unrecorded_json,
            failure_json,
        ) in selected
        {
            turns.push(json!({
                "executionId": execution_id,
                "checkpointId": checkpoint_id,
                "sequence": sequence,
                "status": status,
                "sessionId": session_id,
                "userEntryId": user_entry_id,
                "assistantEntryId": assistant_entry_id,
                "activeWriterScopes": serde_json::from_str::<Value>(&active_json)?,
                "unrecordedResourceIds": serde_json::from_str::<Value>(&unrecorded_json)?,
                "failure": failure_json.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
            }));
            let mut change_statement = self.conn.prepare(
                "SELECT path, tool_name, mutation_id, before_json, after_json, state, revision FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND after_json IS NOT NULL ORDER BY path",
            )?;
            let change_rows = change_statement
                .query_map(params![workspace_id, checkpoint_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (path, tool_name, mutation_id, before_json, after_json, state, revision) in
                change_rows
            {
                changes.push(json!({
                    "workspaceId": workspace_id,
                    "checkpointId": checkpoint_id,
                    "executionId": execution_id,
                    "sequence": sequence,
                    "path": path,
                    "toolName": tool_name,
                    "mutationId": mutation_id,
                    "before": serde_json::from_str::<Value>(&before_json)?,
                    "after": serde_json::from_str::<Value>(&after_json)?,
                    "state": state,
                    "revision": revision,
                }));
            }
        }
        Ok(json!({"turns": turns, "changes": changes}))
    }

    pub(super) fn recovery_change_after(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let after = Self::recovery_json_object(params_value, "afterJson")?;
        Self::validate_recovery_state(&after, "afterJson")?;
        let checkpoint_id = params_value
            .get("checkpointId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("checkpointId is required".to_string()))?;
        let execution_id = params_value
            .get("executionId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("executionId is required".to_string()))?;
        let session_id = params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("sessionId is required".to_string()))?;
        let raw_path = params_value
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Operation("recovery change path is required".to_string())
            })?;
        let path = Self::validate_path(raw_path)?.join("/");
        let expected = params_value
            .get("expectedRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| KernelError::Operation("expectedRevision is required".to_string()))?;
        let current: Option<(i64, String, String)> = self.conn.query_row("SELECT revision, before_json, execution_id FROM recovery_changes WHERE workspace_id = ?1 AND checkpoint_id = ?2 AND path = ?3", params![workspace_id, checkpoint_id, path], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((revision, before_json, stored_execution)) = current else {
            return Err(KernelError::Operation(
                "recovery before-image is missing".to_string(),
            ));
        };
        let turn_session: Option<String> = self.conn.query_row("SELECT session_id FROM recovery_turns WHERE workspace_id = ?1 AND execution_id = ?2 AND checkpoint_id = ?3", params![workspace_id, execution_id, checkpoint_id], |row| row.get(0)).optional()?;
        if stored_execution != execution_id || turn_session.as_deref() != Some(session_id) {
            return Err(KernelError::Authorization(
                "recovery change does not belong to the actor turn".to_string(),
            ));
        }
        self.require_recovery_owner(grant_id, Some(session_id), None, None)?;
        if revision != expected {
            return Err(KernelError::Operation(
                "recovery change revision conflict".to_string(),
            ));
        }
        let references = self.recovery_references(params_value, &workspace_id, grant_id)?;
        let now = format!("{}", chrono_like_now());
        let before_value = serde_json::from_str::<Value>(&before_json)?;
        if before_value == after {
            self.conn.execute("UPDATE recovery_changes SET after_json = ?1, state = 'unchanged', updated_at = ?2, revision = revision + 1 WHERE workspace_id = ?3 AND checkpoint_id = ?4 AND path = ?5 AND revision = ?6", params![serde_json::to_string(&after)?, now, workspace_id, checkpoint_id, path, expected])?;
            self.insert_recovery_refs(
                &workspace_id,
                "change",
                &format!("change:{checkpoint_id}:{path}"),
                &references,
                grant_id,
            )?;
            return Ok(
                json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "before": before_value, "after": after, "unchanged": true, "revision": expected + 1}),
            );
        }
        Self::require_recovery_state_reference(&after, "afterJson", &references)?;
        self.conn.execute("UPDATE recovery_changes SET after_json = ?1, state = ?2, updated_at = ?3, revision = revision + 1 WHERE workspace_id = ?4 AND checkpoint_id = ?5 AND path = ?6 AND revision = ?7", params![serde_json::to_string(&after)?, if params_value.get("succeeded").and_then(Value::as_bool).unwrap_or(false) { "after" } else { "failed" }, now, workspace_id, checkpoint_id, path, expected])?;
        self.insert_recovery_refs(
            &workspace_id,
            "change",
            &format!("change:{checkpoint_id}:{path}"),
            &references,
            grant_id,
        )?;
        Ok(
            json!({"workspaceId": workspace_id, "checkpointId": checkpoint_id, "path": path, "before": before_value, "after": after, "revision": expected + 1}),
        )
    }

    pub(super) fn recovery_operation_create(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let kind = params_value
            .get("kind")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operation kind is required".to_string()))?;
        let state = params_value
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "planned"
                        | "applying"
                        | "applying-files"
                        | "complete"
                        | "aborted"
                        | "compensated"
                        | "needs-attention"
                        | "undone"
                        | "awaiting-surface"
                        | "awaiting-turn-binding"
                )
            })
            .ok_or_else(|| KernelError::Operation("operation state is invalid".to_string()))?;
        let session_id = params_value.get("sessionId").and_then(Value::as_str);
        let thread_id = params_value.get("threadId").and_then(Value::as_str);
        let run_id = params_value.get("runId").and_then(Value::as_str);
        self.require_recovery_owner(grant_id, session_id, thread_id, run_id)?;
        let data = Self::recovery_json_object(params_value, "dataJson")?;
        let files = params_value
            .get("files")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("operation files are required".to_string()))?;
        let mut paths = BTreeSet::new();
        let now = format!("{}", chrono_like_now());
        let identity_hash = hash_json(params_value)?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            if let Some(existing_result) =
                self.operation_existing(operation_id, "recovery.operation.create", &identity_hash)?
            {
                return Ok(existing_result);
            }
            let existing: Option<(i64, String, String)> = self.conn.query_row("SELECT revision, state, data_json FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2", params![workspace_id, operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
            if let Some(existing) = existing {
                return Ok(
                    json!({"operationId": operation_id, "workspaceId": workspace_id, "state": existing.1, "revision": existing.0, "data": serde_json::from_str::<Value>(&existing.2)?, "files": []}),
                );
            }
            self.operation_begin(operation_id, "recovery.operation.create", &identity_hash)?;
            self.record_operation_workspace(operation_id, Some(&workspace_id))?;
            self.conn.execute("INSERT INTO recovery_operations(operation_id, workspace_id, kind, state, session_id, thread_id, run_id, data_json, created_at, updated_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 1)", params![operation_id, workspace_id, kind, state, session_id, thread_id, run_id, serde_json::to_string(&data)?, now])?;
            recovery_fault("operation-before-files")?;
            for (ordinal, file) in files.iter().enumerate() {
                let raw_path = file
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        KernelError::Operation("operation file path is required".to_string())
                    })?;
                let path = Self::validate_path(raw_path)?.join("/");
                if !paths.insert(path.to_string()) {
                    return Err(KernelError::Operation(
                        "operation file paths must be unique".to_string(),
                    ));
                }
                let refs = file.get("references").cloned().unwrap_or_else(|| json!([]));
                let refs_params = json!({"references": refs});
                let normalized = self.recovery_references(&refs_params, &workspace_id, grant_id)?;
                for field in ["expectedJson", "targetJson", "safetyJson"] {
                    if let Some(raw) = file.get(field).and_then(Value::as_str) {
                        let value = serde_json::from_str::<Value>(raw)?;
                        Self::require_recovery_state_reference(&value, field, &normalized)?;
                    }
                }
                let phase = file
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                if !matches!(
                    phase,
                    "pending"
                        | "apply-intent"
                        | "target-observed"
                        | "compensate-intent"
                        | "safety-observed"
                        | "needs-attention"
                        | "external-intent"
                        | "external-dispatched"
                        | "external-target-observed"
                        | "external-compensate-intent"
                        | "external-safety-observed"
                ) {
                    return Err(KernelError::Operation(
                        "operation file phase is invalid".to_string(),
                    ));
                }
                self.conn.execute("INSERT INTO recovery_operation_files(workspace_id, operation_id, ordinal, path, expected_json, target_json, safety_json, phase, revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)", params![workspace_id, operation_id, ordinal as i64, path, file.get("expectedJson").and_then(Value::as_str), file.get("targetJson").and_then(Value::as_str), file.get("safetyJson").and_then(Value::as_str), phase, now])?;
                self.insert_recovery_refs(
                    &workspace_id,
                    "operation-file",
                    &format!("operation-file:{operation_id}:{path}"),
                    &normalized,
                    grant_id,
                )?;
            }
            recovery_fault("operation-before-finish")?;
            let result = json!({"operationId": operation_id, "workspaceId": workspace_id, "kind": kind, "state": state, "revision": 1, "data": data, "files": files});
            self.operation_finish(operation_id, &result)?;
            Ok(result)
        })();
        match result {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub(super) fn recovery_operation_file_cas(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let raw_path = params_value
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operation file path is required".to_string()))?;
        let path = Self::validate_path(raw_path)?.join("/");
        let expected = params_value
            .get("expectedRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| KernelError::Operation("expectedRevision is required".to_string()))?;
        let expected_phase = params_value
            .get("expectedPhase")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("expectedPhase is required".to_string()))?;
        let phase = params_value
            .get("phase")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "pending"
                        | "apply-intent"
                        | "target-observed"
                        | "compensate-intent"
                        | "safety-observed"
                        | "needs-attention"
                        | "external-intent"
                        | "external-dispatched"
                        | "external-target-observed"
                        | "external-compensate-intent"
                        | "external-safety-observed"
                )
            })
            .ok_or_else(|| KernelError::Operation("operation file phase is invalid".to_string()))?;
        let owner: Option<(Option<String>, Option<String>, Option<String>)> = self.conn.query_row(
            "SELECT session_id, thread_id, run_id FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2",
            params![workspace_id, operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((session_id, thread_id, run_id)) = owner else {
            return Err(KernelError::Operation(
                "recovery operation is not found".to_string(),
            ));
        };
        self.require_recovery_owner(
            grant_id,
            session_id.as_deref(),
            thread_id.as_deref(),
            run_id.as_deref(),
        )?;
        let current: Option<(i64, String)> = self.conn.query_row("SELECT revision, phase FROM recovery_operation_files WHERE workspace_id = ?1 AND operation_id = ?2 AND path = ?3", params![workspace_id, operation_id, path], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let Some((revision, current_phase)) = current else {
            return Err(KernelError::Operation(
                "operation file is not found".to_string(),
            ));
        };
        if revision != expected || current_phase != expected_phase {
            return Err(KernelError::Operation(
                "operation file phase conflict".to_string(),
            ));
        }
        let normalized = params_value
            .get("references")
            .map(|refs| {
                self.recovery_references(&json!({"references": refs}), &workspace_id, grant_id)
            })
            .transpose()?;
        for field in ["expectedJson", "targetJson", "safetyJson"] {
            if let Some(raw) = params_value.get(field).and_then(Value::as_str) {
                let value = serde_json::from_str::<Value>(raw)?;
                let refs = normalized.as_ref().ok_or_else(|| {
                    KernelError::Operation(format!("{field} update requires references"))
                })?;
                Self::require_recovery_state_reference(&value, field, refs)?;
            }
        }
        recovery_fault("file-phase-cas")?;
        let changed = self.conn.execute("UPDATE recovery_operation_files SET phase = ?1, observed_fingerprint = COALESCE(?2, observed_fingerprint), expected_json = COALESCE(?3, expected_json), target_json = COALESCE(?4, target_json), safety_json = COALESCE(?5, safety_json), revision = revision + 1, updated_at = ?6 WHERE workspace_id = ?7 AND operation_id = ?8 AND path = ?9 AND revision = ?10 AND phase = ?11", params![phase, params_value.get("observedFingerprint").and_then(Value::as_str), params_value.get("expectedJson").and_then(Value::as_str), params_value.get("targetJson").and_then(Value::as_str), params_value.get("safetyJson").and_then(Value::as_str), chrono_like_now(), workspace_id, operation_id, path, expected, expected_phase])?;
        if changed != 1 {
            return Err(KernelError::Operation(
                "operation file phase conflict".to_string(),
            ));
        }
        if let Some(normalized) = normalized {
            self.insert_recovery_refs(
                &workspace_id,
                "operation-file",
                &format!("operation-file:{operation_id}:{path}"),
                &normalized,
                grant_id,
            )?;
        }
        Ok(
            json!({"operationId": operation_id, "workspaceId": workspace_id, "path": path, "phase": phase, "revision": expected + 1}),
        )
    }

    // R1 accepts non-terminal durable phase markers (awaiting-surface/undoing) so
    // restart reconciliation can observe them through the same operation identity.
    pub(super) fn recovery_operation_complete(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let expected = params_value
            .get("expectedRevision")
            .and_then(Value::as_i64)
            .ok_or_else(|| KernelError::Operation("expectedRevision is required".to_string()))?;
        let state = params_value
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "complete"
                        | "conflict"
                        | "aborted"
                        | "compensated"
                        | "undone"
                        | "needs-attention"
                        | "undoing"
                        | "awaiting-surface"
                        | "awaiting-turn-binding"
                        | "applying-files"
                        | "files-restored"
                        | "navigating-conversation"
                        | "compensating-files"
                )
            })
            .ok_or_else(|| {
                KernelError::Operation("terminal operation state is invalid".to_string())
            })?;
        let owner: Option<(Option<String>, Option<String>, Option<String>)> = self.conn.query_row(
            "SELECT session_id, thread_id, run_id FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2",
            params![workspace_id, operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?;
        let Some((session_id, thread_id, run_id)) = owner else {
            return Err(KernelError::Operation(
                "recovery operation is not found".to_string(),
            ));
        };
        self.require_recovery_owner(
            grant_id,
            session_id.as_deref(),
            thread_id.as_deref(),
            run_id.as_deref(),
        )?;
        for field in ["resultJson", "failureJson"] {
            if let Some(raw) = params_value.get(field).and_then(Value::as_str) {
                let value = serde_json::from_str::<Value>(raw)?;
                if !value.is_object() {
                    return Err(KernelError::Operation(format!(
                        "{field} must contain an object"
                    )));
                }
            }
        }
        recovery_fault("operation-complete")?;
        let changed = self.conn.execute("UPDATE recovery_operations SET state = ?1, result_json = ?2, failure_json = ?3, revision = revision + 1, updated_at = ?4 WHERE workspace_id = ?5 AND operation_id = ?6 AND revision = ?7 AND (state NOT IN ('complete', 'aborted', 'compensated', 'undone', 'needs-attention') OR (?1 = 'undoing' AND state IN ('complete', 'conflict')) OR (?1 = 'needs-attention' AND state IN ('complete', 'conflict')))", params![state, params_value.get("resultJson").and_then(Value::as_str), params_value.get("failureJson").and_then(Value::as_str), chrono_like_now(), workspace_id, operation_id, expected])?;
        if changed == 0 {
            return Err(KernelError::Operation(
                "operation terminal state conflict".to_string(),
            ));
        }
        Ok(
            json!({"operationId": operation_id, "workspaceId": workspace_id, "state": state, "revision": expected + 1}),
        )
    }

    pub(super) fn recovery_operation_list(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        self.require_recovery_owner(grant_id, None, None, None)?;
        let cursor = params_value
            .get("cursor")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let page_size = params_value
            .get("pageSize")
            .and_then(Value::as_i64)
            .unwrap_or(128);
        if page_size <= 0 {
            return Err(KernelError::Operation(
                "pageSize must be positive".to_string(),
            ));
        }
        let kind = params_value.get("kind").and_then(Value::as_str);
        let (sql, values) = if let Some(kind) = kind {
            ("SELECT operation_id, kind, state, data_json, revision, session_id, thread_id, run_id, created_at, updated_at FROM recovery_operations WHERE workspace_id = ?1 AND kind = ?2 ORDER BY created_at DESC LIMIT ?3 OFFSET ?4", vec![Value::String(workspace_id.clone()), Value::String(kind.to_string()), Value::from(page_size + 1), Value::from(cursor)])
        } else {
            ("SELECT operation_id, kind, state, data_json, revision, session_id, thread_id, run_id, created_at, updated_at FROM recovery_operations WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3", vec![Value::String(workspace_id.clone()), Value::from(page_size + 1), Value::from(cursor)])
        };
        let mut statement = self.conn.prepare(sql)?;
        let mut rows = if kind.is_some() {
            statement.query(params![workspace_id, kind.unwrap_or(""), page_size, cursor])?
        } else {
            statement.query(params![workspace_id, page_size, cursor])?
        };
        let mut operations = Vec::new();
        while let Some(row) = rows.next()? {
            let operation_id: String = row.get(0)?;
            operations.push(json!({"operationId": operation_id, "workspaceId": workspace_id, "kind": row.get::<_, String>(1)?, "state": row.get::<_, String>(2)?, "data": serde_json::from_str::<Value>(&row.get::<_, String>(3)?)?, "revision": row.get::<_, i64>(4)?, "sessionId": row.get::<_, Option<String>>(5)?, "threadId": row.get::<_, Option<String>>(6)?, "runId": row.get::<_, Option<String>>(7)?, "createdAt": row.get::<_, String>(8)?, "updatedAt": row.get::<_, String>(9)?}));
        }
        let _ = values;
        let has_more = operations.len() as i64 > page_size;
        operations.truncate(page_size as usize);
        Ok(
            json!({"operations": operations, "nextCursor": if has_more { Value::from(cursor + page_size) } else { Value::Null }}),
        )
    }

    pub(super) fn recovery_operation_release(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let stored: Option<(String, Option<String>, Option<String>, Option<String>)> = self.conn.query_row("SELECT state, session_id, thread_id, run_id FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2", params![workspace_id, operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
        let Some((state, session_id, thread_id, run_id)) = stored else {
            return Ok(json!({"operationId": operation_id, "released": false}));
        };
        self.require_recovery_owner(
            grant_id,
            session_id.as_deref(),
            thread_id.as_deref(),
            run_id.as_deref(),
        )?;
        if !matches!(
            state.as_str(),
            "complete" | "aborted" | "compensated" | "undone"
        ) {
            return Err(KernelError::Operation(
                "only terminal recovery operations can be released".to_string(),
            ));
        }
        self.conn.execute("DELETE FROM recovery_refs WHERE workspace_id = ?1 AND ((owner_kind = 'operation-file' AND owner_id LIKE ?2) OR (owner_kind = 'operation' AND owner_id = ?3))", params![workspace_id, format!("operation-file:{operation_id}:%"), format!("operation:{operation_id}")])?;
        let deleted = self.conn.execute(
            "DELETE FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2",
            params![workspace_id, operation_id],
        )?;
        Ok(json!({"operationId": operation_id, "released": deleted > 0}))
    }

    pub(super) fn recovery_operation_get(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.recovery_workspace(params_value, grant_id)?;
        let operation_id = params_value
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        self.read_recovery_operation(&workspace_id,operation_id,Some(grant_id))
    }
    pub(super) fn read_recovery_operation(&self,workspace_id:&str,operation_id:&str,grant_id:Option<&str>)->Result<Value,KernelError>{
        let typed: Option<(String, String, String, Option<String>, Option<String>, Option<String>, String, Option<String>, Option<String>, i64)> = self.conn.query_row(
            "SELECT kind, state, data_json, session_id, thread_id, run_id, created_at, result_json, failure_json, revision FROM recovery_operations WHERE workspace_id = ?1 AND operation_id = ?2",
            params![workspace_id, operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
        ).optional()?;
        let Some((
            kind,
            state,
            data_json,
            session_id,
            thread_id,
            run_id,
            created_at,
            result_json,
            failure_json,
            revision,
        )) = typed
        else {
            return Ok(Value::Null);
        };
        if let Some(grant_id)=grant_id {
        self.require_recovery_owner(
            grant_id,
            session_id.as_deref(),
            thread_id.as_deref(),
            run_id.as_deref(),
        )?;
        }
        let mut files = Vec::new();
        let mut files_statement = self.conn.prepare("SELECT path, expected_json, target_json, safety_json, phase, observed_fingerprint, revision FROM recovery_operation_files WHERE workspace_id = ?1 AND operation_id = ?2 ORDER BY ordinal")?;
        let mut rows = files_statement.query(params![workspace_id, operation_id])?;
        while let Some(row) = rows.next()? {
            files.push(json!({
                "path": row.get::<_, String>(0)?,
                "expectedJson": row.get::<_, Option<String>>(1)?,
                "targetJson": row.get::<_, Option<String>>(2)?,
                "safetyJson": row.get::<_, Option<String>>(3)?,
                "phase": row.get::<_, String>(4)?,
                "observedFingerprint": row.get::<_, Option<String>>(5)?,
                "revision": row.get::<_, i64>(6)?,
            }));
        }
        Ok(json!({
            "operationId": operation_id,
            "workspaceId": workspace_id,
            "kind": kind,
            "state": state,
            "sessionId": session_id,
            "threadId": thread_id,
            "runId": run_id,
            "createdAt": created_at,
            "data": serde_json::from_str::<Value>(&data_json)?,
            "result": result_json.map(|value| serde_json::from_str::<Value>(&value)).transpose()?,
            "failure": failure_json.map(|value| serde_json::from_str::<Value>(&value)).transpose()?,
            "revision": revision,
            "files": files,
        }))
    }
}

impl Storage {
    /// A scoped physical overlap query. It discloses only reservations intersecting the
    /// caller's authorized target, including aliases owned by another workspace identity.
    pub(super) fn recovery_operation_conflicts(&self,params_value:&Value,grant:&Grant)->Result<Value,KernelError>{
        let workspace=self.recovery_workspace(params_value,&grant.grant_id)?;
        let root_id=params_value["rootId"].as_str().ok_or_else(||KernelError::Authorization("reservation root missing".into()))?;
        let paths=params_value["paths"].as_array().ok_or_else(||KernelError::Operation("reservation paths missing".into()))?.iter().map(|value|{
            let path=value.as_str().ok_or_else(||KernelError::Operation("reservation path malformed".into()))?;
            Ok(FileLeaseResource{path:path.into(),subtree:true})
        }).collect::<Result<Vec<_>,KernelError>>()?;
        let requested=self.canonical_lease_resources(root_id,&paths,grant)?;
        let except=params_value.get("exceptOperationId").and_then(Value::as_str);
        let mut statement=self.conn.prepare("SELECT workspace_id,operation_id,state,revision,COALESCE(json_extract(result_json,'$.reservedResources.canonicalRoot'),json_extract(data_json,'$.reservedResources.canonicalRoot'),json_extract(result_json,'$.applyCanonicalRoot'),json_extract(data_json,'$.applyCanonicalRoot')),COALESCE(json_extract(result_json,'$.reservedResources.paths'),json_extract(data_json,'$.reservedResources.paths')),COALESCE(json_extract(result_json,'$.targets'),json_extract(data_json,'$.targets')) FROM recovery_operations WHERE kind='integration' AND COALESCE(json_extract(result_json,'$.parentBranchId'),json_extract(data_json,'$.parentBranchId')) IS NULL AND state NOT IN ('complete','conflict','compensated','aborted','undone') ORDER BY workspace_id,operation_id")?;
        let mut rows=statement.query([])?;let mut operations=Vec::new();
        while let Some(row)=rows.next()? {
            let owning:String=row.get(0)?;let operation:String=row.get(1)?;
            if owning==workspace && except==Some(operation.as_str()){continue;}
            let directory=row.get::<_,Option<String>>(4)?.ok_or_else(||KernelError::Operation(format!("unresolved Integration reservation root: {owning}/{operation}")))?;
            let paths:Vec<String>=if let Some(raw)=row.get::<_,Option<String>>(5)?{serde_json::from_str(&raw)?}
                else if let Some(raw)=row.get::<_,Option<String>>(6)?{serde_json::from_str::<Value>(&raw)?.as_object().ok_or_else(||KernelError::Storage("Integration targets are malformed".into()))?.keys().cloned().collect()}
                else{return Err(KernelError::Operation(format!("unresolved Integration reservation paths: {owning}/{operation}")));};
            let directory_path=PathBuf::from(&directory);
            if !directory_path.is_absolute(){return Err(KernelError::Storage("Integration reservation root is not canonical".into()));}
            let physical=paths.iter().map(|path|{
                let resolved=super::file_resources::resolve_scoped_resource(&directory_path,path,true,true,|_|true)?;
                super::file_resource_leases::canonical_lease_path(resolved.absolute)
            }).collect::<Result<Vec<_>,KernelError>>()?;
            let overlap=requested.iter().any(|left|physical.iter().any(|right|physical_paths_overlap(&left.absolute,right)));
            if overlap{operations.push(json!({"operationId":operation,"workspaceId":owning,"state":row.get::<_,String>(2)?,"revision":row.get::<_,i64>(3)?,"canonicalRoot":directory,"paths":paths}));}
        }
        Ok(json!({"operations":operations}))
    }
}
fn physical_paths_overlap(left:&Path,right:&Path)->bool{
    #[cfg(windows)]
    let (left,right)=(PathBuf::from(left.to_string_lossy().to_lowercase()),PathBuf::from(right.to_string_lossy().to_lowercase()));
    left.starts_with(right)||right.starts_with(left)
}
