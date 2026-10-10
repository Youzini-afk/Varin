//! Persisted grants and resource-derived authorization.
use super::*;

impl Storage {
    pub(super) fn load_grant(&self, grant_id: &str) -> Result<Grant, KernelError> {
        let json: String = self
            .conn
            .query_row(
                "SELECT grant_json FROM grants WHERE grant_id = ?1",
                params![grant_id],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    KernelError::Authorization("grant not found".to_string())
                }
                other => other.into(),
            })?;
        serde_json::from_str(&json)
            .map_err(|error| KernelError::Storage(format!("grant is corrupt: {error}")))
    }

    pub(crate) fn issue_grant(
        &mut self,
        params: &Value,
        host_id: &str,
        expected_host_generation: &str,
        storage_identity: &str,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let grant_id = params
            .get("grantId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Authorization("grantId is required".to_string()))?;
        let supplied_host_generation = params
            .get("hostGeneration")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Authorization("hostGeneration is required".to_string()))?;
        if supplied_host_generation != expected_host_generation {
            return Err(KernelError::Authorization(
                "grant host generation does not match Host".to_string(),
            ));
        }
        let requested_storage = params
            .get("storageIdentity")
            .and_then(Value::as_str)
            .unwrap_or(storage_identity);
        if requested_storage != storage_identity {
            return Err(KernelError::Authorization(
                "grant storage identity does not match kernel storage".to_string(),
            ));
        }
        let parse_optional = |key: &str| -> Result<Option<String>, KernelError> {
            match params.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
                _ => Err(KernelError::Authorization(format!(
                    "grant {key} is malformed"
                ))),
            }
        };
        let capabilities: BTreeSet<String> = params
            .get("capabilities")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                KernelError::Authorization("grant capabilities are required".to_string())
            })?
            .iter()
            .map(|value| {
                value.as_str().map(str::to_string).ok_or_else(|| {
                    KernelError::Authorization("grant capability is malformed".to_string())
                })
            })
            .collect::<Result<_, _>>()?;
        if capabilities.is_empty() {
            return Err(KernelError::Authorization(
                "grant capabilities are empty".to_string(),
            ));
        }
        let path_scopes = params
            .get("pathScopes")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Authorization("grant pathScopes are required".to_string()))?
            .iter()
            .map(|value| {
                let raw = value.as_str().ok_or_else(|| {
                    KernelError::Authorization("grant path scope is malformed".to_string())
                })?;
                if raw.is_empty() {
                    Ok(String::new())
                } else {
                    Ok(Self::validate_path(raw)?.join("/"))
                }
            })
            .collect::<Result<Vec<_>, KernelError>>()?;
        let owning_workspace = parse_optional("owningWorkspace")?;
        let execution_workspace = parse_optional("executionWorkspace")?;
        let worker_generation = match params.get("workerGeneration") {
            None | Some(Value::Null) => None,
            Some(value) => Some(value.as_u64().ok_or_else(|| {
                KernelError::Authorization("grant workerGeneration is malformed".to_string())
            })?),
        };
        let grant = Grant {
            grant_id: grant_id.to_string(),
            host_id: host_id.to_string(),
            host_generation: supplied_host_generation.to_string(),
            authority_instance_id: parse_optional("authorityInstanceId")?,
            worker_id: parse_optional("workerId")?,
            worker_generation,
            session_id: parse_optional("sessionId")?,
            thread_id: parse_optional("threadId")?,
            run_id: parse_optional("runId")?,
            owning_workspace,
            execution_workspace,
            storage_identity: storage_identity.to_string(),
            capabilities,
            path_scopes,
            kernel_epoch: epoch.to_string(),
            revoked: false,
            handoff_operation_id: None,
        };
        let params_hash = hash_json(params)?;
        if let Some((stored_hash, stored_json)) = self
            .conn
            .query_row(
                "SELECT params_hash, grant_json FROM grants WHERE grant_id = ?1",
                params![grant_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if stored_hash != params_hash {
                return Err(KernelError::Authorization(
                    "grantId was reused with different parameters".to_string(),
                ));
            }
            let mut stored_grant: Grant = serde_json::from_str(&stored_json)?;
            if stored_grant.kernel_epoch != epoch || stored_grant.revoked {
                stored_grant.kernel_epoch = epoch.to_string();
                stored_grant.revoked = false;
                self.conn.execute(
                    "UPDATE grants SET revoked = 0, updated_at = ?2, grant_json = ?3 WHERE grant_id = ?1",
                    params![grant_id, now_ms(), serde_json::to_string(&stored_grant)?],
                )?;
            }
            return Ok(serde_json::to_value(stored_grant)?);
        }
        self.conn.execute("INSERT INTO grants(grant_id, host_id, grant_json, params_hash, revoked, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)", params![grant_id, host_id, serde_json::to_string(&grant)?, params_hash, now_ms()])?;
        Ok(serde_json::to_value(grant)?)
    }

    pub(crate) fn revoke_grant(
        &mut self,
        params: &Value,
        host_id: &str,
    ) -> Result<Value, KernelError> {
        let grant_id = params
            .get("grantId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Authorization("grantId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.host_id != host_id {
            return Err(KernelError::Authorization(
                "grant belongs to another Host".to_string(),
            ));
        }
        self.computations.revoke(grant_id);
        let mut revoked = grant;
        revoked.revoked = true;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let outcome = (|| {
            self.conn.execute(
                "UPDATE grants SET revoked = 1, updated_at = ?2, grant_json = ?3 WHERE grant_id = ?1",
                params![grant_id, now_ms(), serde_json::to_string(&revoked)?],
            )?;
            self.abort_streams_for_grant(grant_id)?;
            self.conn.execute(
                "DELETE FROM pins WHERE grant_id = ?1 AND ephemeral = 1",
                params![grant_id],
            )?;
            Ok::<(), KernelError>(())
        })();
        match outcome {
            Ok(()) => {
                self.conn.execute_batch("COMMIT")?;
                self.processes.revoke_subscriptions(grant_id);
                self.file_leases.retain(|id, lease| {
                    if lease.grant_id != grant_id {
                        return true;
                    }
                    if let Some(retained) = self.retained_file_leases.get_mut(id) {
                        retained.release_requested = true;
                        return true;
                    }
                    false
                });
                let process_stop = self.revoke_processes_for_grant(grant_id).unwrap_or_else(|error| {
                    json!({"pendingProcesses": [], "processStopFailures": [{"reason": error.to_string()}]})
                });
                Ok(json!({"grantId": grant_id, "revoked": true,
                    "pendingProcesses": process_stop["pendingProcesses"],
                    "processStopFailures": process_stop["processStopFailures"]}))
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub(super) fn blob_reachable(
        &self,
        hash: &str,
        workspace: Option<&str>,
    ) -> Result<bool, KernelError> {
        let query = if workspace.is_some() {
            "WITH RECURSIVE roots(root_hash) AS (SELECT base_root FROM branches WHERE workspace_id = ?2 UNION SELECT head_root FROM branches WHERE workspace_id = ?2 UNION SELECT r.root_hash FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE b.workspace_id = ?2 UNION SELECT p.root_hash FROM pins p WHERE p.workspace_id = ?2 UNION SELECT parent.parent_root FROM root_parents parent JOIN roots ON parent.root_hash = roots.root_hash) SELECT 1 FROM root_blobs rb JOIN roots ON roots.root_hash = rb.root_hash WHERE rb.blob_hash = ?1 LIMIT 1"
        } else {
            "WITH RECURSIVE roots(root_hash) AS (SELECT base_root FROM branches UNION SELECT head_root FROM branches UNION SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins UNION SELECT parent.parent_root FROM root_parents parent JOIN roots ON parent.root_hash = roots.root_hash) SELECT 1 FROM root_blobs rb JOIN roots ON roots.root_hash = rb.root_hash WHERE rb.blob_hash = ?1 LIMIT 1"
        };
        let row: Option<i64> = if let Some(workspace) = workspace {
            self.conn
                .query_row(query, params![hash, workspace], |row| row.get(0))
                .optional()?
        } else {
            self.conn
                .query_row(query, params![hash], |row| row.get(0))
                .optional()?
        };
        Ok(row.is_some())
    }

    pub(super) fn blob_owned(
        &self,
        hash: &str,
        workspace: Option<&str>,
    ) -> Result<bool, KernelError> {
        if self.blob_reachable(hash, workspace)? {
            return Ok(true);
        }
        let row: Option<i64> = if let Some(workspace) = workspace {
            self.conn
                .query_row(
                    "SELECT 1 FROM object_owners WHERE blob_hash = ?1 AND workspace_id = ?2 UNION SELECT 1 FROM domain_record_refs r WHERE r.object_hash = ?1 AND r.workspace_id = ?2 UNION SELECT 1 FROM recovery_refs r WHERE r.object_hash = ?1 AND r.workspace_id = ?2 LIMIT 1",
                    params![hash, workspace],
                    |row| row.get(0),
                )
                .optional()?
        } else {
            self.conn
                .query_row(
                    "SELECT 1 FROM object_owners WHERE blob_hash = ?1 UNION SELECT 1 FROM domain_record_refs WHERE object_hash = ?1 UNION SELECT 1 FROM recovery_refs WHERE object_hash = ?1 LIMIT 1",
                    params![hash],
                    |row| row.get(0),
                )
                .optional()?
        };
        Ok(row.is_some())
    }

    pub(crate) fn authorize(
        &self,
        grant_id: Option<&str>,
        epoch: &str,
        host_id: &str,
        host_generation: &str,
        method: &str,
        params: &Value,
    ) -> Result<(Grant, Value), KernelError> {
        let grant_id = grant_id
            .ok_or_else(|| KernelError::Authorization("grantId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.revoked {
            return Err(KernelError::Authorization("grant is revoked".to_string()));
        }
        if grant.host_id != host_id
            || grant.host_generation != host_generation
            || grant.kernel_epoch != epoch
            || grant.storage_identity != self.root.to_string_lossy()
        {
            return Err(KernelError::Authorization(
                "grant identity is stale".to_string(),
            ));
        }
        require_capability(&grant, method)?;
        self.authorize_child_handoff(&grant, method, params)?;
        let mut authorized = params.clone();
        let workspace = if let Some(workspace) = params.get("workspaceId").and_then(Value::as_str) {
            Some(workspace.to_string())
        } else if let Some(branch_id) = params.get("branchId").and_then(Value::as_str) {
            let branch_workspace: Option<String> = self
                .conn
                .query_row(
                    "SELECT workspace_id FROM branches WHERE branch_id = ?1",
                    params![branch_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if branch_workspace.is_some() {
                branch_workspace
            } else if let Some(pin_id) = params.get("pinId").and_then(Value::as_str) {
                self.conn
                    .query_row(
                        "SELECT workspace_id FROM pins WHERE pin_id = ?1 AND branch_id = ?2",
                        params![pin_id, branch_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
            } else {
                None
            }
        } else if let Some(pin_id) = params.get("pinId").and_then(Value::as_str) {
            self.conn
                .query_row(
                    "SELECT workspace_id FROM pins WHERE pin_id = ?1",
                    params![pin_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else if method == "storage.putBlob.chunk" {
            params
                .get("streamId")
                .and_then(Value::as_str)
                .and_then(|stream_id| {
                    self.streams
                        .get(stream_id)
                        .and_then(|stream| stream.workspace_id.clone())
                })
        } else if let Some(builder_id) = params.get("builderId").and_then(Value::as_str) {
            let builder = self
                .branch_builders
                .get(builder_id)
                .map(|builder| (&builder.grant_id, &builder.workspace_id))
                .or_else(|| {
                    self.branch_write_builders
                        .get(builder_id)
                        .map(|builder| (&builder.grant_id, &builder.workspace_id))
                });
            if builder.is_some_and(|(builder_grant, _)| builder_grant != &grant.grant_id)
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(
                    "branch builder belongs to another grant".to_string(),
                ));
            }
            builder.map(|(_, workspace)| workspace.clone())
        } else if let Some(owner_id) = params.get("ownerId").and_then(Value::as_str) {
            let owner: Option<(Option<String>, String)> = self
                .conn
                .query_row(
                    "SELECT workspace_id, grant_id FROM object_owners WHERE owner_id = ?1",
                    params![owner_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if owner
                .as_ref()
                .is_some_and(|(_, owner_grant)| owner_grant != &grant.grant_id)
                && !grant.capabilities.contains("storage.admin")
            {
                return Err(KernelError::Authorization(
                    "temporary object owner belongs to another grant".to_string(),
                ));
            }
            owner.and_then(|(workspace, _)| workspace)
        } else if let Some(operation_id) = params.get("operationId").and_then(Value::as_str) {
            let operation_workspace: Option<String> = self
                .conn
                .query_row(
                    "SELECT workspace_id FROM operation_owners WHERE operation_id = ?1",
                    params![operation_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if operation_workspace.is_some() {
                operation_workspace
            } else {
                self.conn
                    .query_row(
                        "SELECT workspace_id FROM recovery_operations WHERE operation_id = ?1",
                        params![operation_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
            }
        } else if let Some(record_id) = params.get("recordId").and_then(Value::as_str) {
            self.conn
                .query_row(
                    "SELECT workspace_id FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2 UNION SELECT workspace_id FROM recovery_operations WHERE operation_id = ?1 AND workspace_id = ?2 LIMIT 1",
                    params![record_id, grant.owning_workspace],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else if method == "branch.diff" {
            let left = params.get("leftRoot").and_then(Value::as_str);
            let right = params.get("rightRoot").and_then(Value::as_str);
            if let (Some(left), Some(right)) = (left, right) {
                if let Some(owning) = &grant.owning_workspace {
                    if self.root_owned_by_workspace(left, owning)?
                        && self.root_owned_by_workspace(right, owning)?
                    {
                        Some(owning.clone())
                    } else {
                        None
                    }
                } else {
                    let left_workspace = self.root_workspace(left)?;
                    let right_workspace = self.root_workspace(right)?;
                    if left_workspace.is_some() && left_workspace == right_workspace {
                        left_workspace
                    } else {
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };
        if method == "operation.get" && workspace.is_none() {
            let operation_id = params
                .get("operationId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KernelError::Authorization("operation identity is required".to_string())
                })?;
            let exists: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM operations WHERE operation_id = ?1)",
                params![operation_id],
                |row| row.get(0),
            )?;
            if exists {
                // An entity without ownership is not proof of absence. In particular,
                // orphaned/uncertain operations must never permit a fresh mutation.
                return Err(KernelError::Authorization(
                    "operation is not owned by this storage authority".to_string(),
                ));
            }
            // A genuinely missing operation may be read as null. authorize and dispatch
            // run synchronously on the same sole Storage worker while its lifetime
            // exclusive kernel.lock excludes other owners; no creation can interleave
            // this check and operation_get. Foreign owned operations were resolved above
            // and still undergo the workspace check below.
        }
        let workspace = workspace;
        if let Some(owning) = &grant.owning_workspace {
            if workspace
                .as_deref()
                .is_some_and(|workspace| workspace != owning.as_str())
            {
                return Err(KernelError::Authorization(
                    "grant workspace does not match resource".to_string(),
                ));
            }
        }
        if let Some(workspace) = workspace.as_deref() {
            if params.get("workspaceId").is_none() {
                if let Some(object) = authorized.as_object_mut() {
                    object.insert(
                        "workspaceId".to_string(),
                        Value::String(workspace.to_string()),
                    );
                }
            }
        }
        if let Some(object) = authorized.as_object_mut() {
            object.insert(
                "__pathScopes".to_string(),
                Value::Array(
                    grant
                        .path_scopes
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
        if method == "storage.snapshot" && !grant.path_scopes.iter().any(String::is_empty) {
            return Err(KernelError::Authorization(
                "snapshot requires an unbounded path grant".to_string(),
            ));
        }
        for field in [
            "paths",
            "entries",
            "changes",
            "draftBasePaths",
            "captureScopes",
        ] {
            // Compute traversal intersects requested roots with the grant before
            // candidate selection; a broad root is not itself a file read.
            if method == "compute.start" && field == "paths" {
                continue;
            }
            if let Some(values) = params.get(field).and_then(Value::as_array) {
                for value in values {
                    let path = value
                        .get("path")
                        .and_then(Value::as_str)
                        .or_else(|| value.as_str())
                        .ok_or_else(|| {
                            KernelError::Authorization(
                                "grant path subject is malformed".to_string(),
                            )
                        })?;
                    let metadata = field == "paths" && matches!(method, "branch.read" | "pin.read");
                    let canonical = if metadata && path.is_empty() {
                        String::new()
                    } else {
                        Self::validate_path(path)?.join("/")
                    };
                    if !(if metadata {
                        path_metadata_allowed_scopes(&grant.path_scopes, &canonical)
                    } else {
                        path_allowed(&grant, &canonical)
                    }) {
                        return Err(KernelError::Authorization(format!(
                            "path is outside grant scope: {canonical}"
                        )));
                    }
                    if let Some(source_path) = value.get("sourcePath").and_then(Value::as_str) {
                        let source = Self::validate_path(source_path)?.join("/");
                        if !path_allowed(&grant, &source) {
                            return Err(KernelError::Authorization(format!(
                                "source path is outside grant scope: {source}"
                            )));
                        }
                    }
                }
            }
        }
        if let Some(path) = params.get("path").and_then(Value::as_str) {
            let canonical =
                if (method == "file.scan" || method == "file.measure") && path.is_empty() {
                    String::new()
                } else {
                    Self::validate_path(path)?.join("/")
                };
            if !path_allowed(&grant, &canonical) {
                return Err(KernelError::Authorization(format!(
                    "path is outside grant scope: {canonical}"
                )));
            }
        }
        if method == "storage.getBlob" {
            let hash = params
                .get("hash")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::Authorization("hash is required".to_string()))?;
            if !self.blob_owned(
                hash,
                workspace.as_deref().or(grant.owning_workspace.as_deref()),
            )? {
                return Err(KernelError::Authorization(
                    "content object is not owned by the grant".to_string(),
                ));
            }
        }
        Ok((grant, authorized))
    }
}
