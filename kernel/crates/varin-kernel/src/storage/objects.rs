//! Content objects, streaming uploads, durable owners, and authorized blob reads.
use super::*;

impl Storage {
    pub(super) fn record_root_blobs(&mut self, root: &str) -> Result<(), KernelError> {
        let mut nodes = BTreeSet::new();
        let mut blobs = BTreeSet::new();
        self.collect_reachable(root, &mut nodes, &mut blobs)?;
        for blob in blobs {
            self.conn.execute(
                "INSERT OR IGNORE INTO root_blobs(root_hash, blob_hash) VALUES (?1, ?2)",
                params![root, blob],
            )?;
        }
        Ok(())
    }

    pub(super) fn record_root_parent(
        &mut self,
        root: &str,
        parent: &str,
    ) -> Result<(), KernelError> {
        if root != parent {
            self.conn.execute(
                "INSERT OR IGNORE INTO root_parents(root_hash, parent_root) VALUES (?1, ?2)",
                params![root, parent],
            )?;
        }
        Ok(())
    }

    pub(super) fn record_root_blob_hashes(
        &mut self,
        root: &str,
        hashes: impl IntoIterator<Item = String>,
    ) -> Result<(), KernelError> {
        for hash in hashes {
            self.conn.execute(
                "INSERT OR IGNORE INTO root_blobs(root_hash, blob_hash) VALUES (?1, ?2)",
                params![root, hash],
            )?;
        }
        Ok(())
    }

    pub(super) fn record_object_owner(
        &mut self,
        owner_id: &str,
        hash: &str,
        workspace_id: Option<&str>,
        operation_id: Option<&str>,
        grant_id: &str,
    ) -> Result<(), KernelError> {
        let existing: Option<(String, Option<String>, Option<String>, String)> = self.conn.query_row(
            "SELECT blob_hash, workspace_id, operation_id, grant_id FROM object_owners WHERE owner_id = ?1",
            params![owner_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional()?;
        if let Some((prior_hash, prior_workspace, prior_operation, prior_grant)) = existing {
            if prior_hash != hash
                || prior_workspace.as_deref() != workspace_id
                || prior_operation.as_deref() != operation_id
                || prior_grant != grant_id
            {
                return Err(KernelError::Authorization(
                    "temporary object owner was reused with a different identity".to_string(),
                ));
            }
            return Ok(());
        }
        self.conn.execute(
            "DELETE FROM pending_gc_files WHERE hash = ?1",
            params![hash],
        )?;
        self.conn.execute(
            "INSERT INTO object_owners(owner_id, blob_hash, workspace_id, operation_id, grant_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![owner_id, hash, workspace_id, operation_id, grant_id, now_ms()],
        )?;
        Ok(())
    }

    pub(super) fn release_object_owner(
        &mut self,
        params_value: &Value,
        workspace_id: Option<&str>,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let owner_id = params_value
            .get("ownerId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("ownerId is required".to_string()))?;
        let released = if let Some(workspace_id) = workspace_id {
            self.conn.execute(
                "DELETE FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?3",
                params![owner_id, workspace_id, grant_id],
            )?
        } else {
            self.conn.execute(
                "DELETE FROM object_owners WHERE owner_id = ?1 AND grant_id = ?2",
                params![owner_id, grant_id],
            )?
        };
        Ok(json!({"ownerId": owner_id, "released": released > 0}))
    }

    pub(super) fn rebind_object_owner(
        &mut self,
        params_value: &Value,
        workspace_id: Option<&str>,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let owner_id = params_value
            .get("ownerId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("ownerId is required".to_string()))?;
        let requested_workspace = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("workspaceId is required".to_string()))?;
        if workspace_id != Some(requested_workspace) {
            return Err(KernelError::Authorization(
                "object owner workspace does not match the authorized workspace".to_string(),
            ));
        }
        let source_grant_id: Option<String> = self
            .conn
            .query_row(
                "SELECT grant_id FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2",
                params![owner_id, requested_workspace],
                |row| row.get(0),
            )
            .optional()?;
        let source_grant_id = source_grant_id.ok_or_else(|| {
            KernelError::Authorization(format!(
                "temporary object owner is not available in workspace: {owner_id}"
            ))
        })?;
        let source_grant = self.load_grant(&source_grant_id)?;
        if !source_grant.capabilities.contains("recovery.maintenance") {
            return Err(KernelError::Authorization(
                "temporary object owner was not created by recovery maintenance".to_string(),
            ));
        }
        self.conn.execute(
            "UPDATE object_owners SET grant_id = ?3 WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?4",
            params![owner_id, requested_workspace, grant_id, source_grant_id],
        )?;
        Ok(json!({"ownerId": owner_id, "workspaceId": requested_workspace, "rebound": true}))
    }

    pub(super) fn validate_object_owners(
        &self,
        workspace_id: &str,
        grant_id: &str,
        owners: &BTreeMap<String, String>,
    ) -> Result<(), KernelError> {
        for (owner_id, expected_hash) in owners {
            let actual: Option<String> = self
                .conn
                .query_row(
                    "SELECT blob_hash FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?3",
                    params![owner_id, workspace_id, grant_id],
                    |row| row.get(0),
                )
                .optional()?;
            if actual.as_deref() != Some(expected_hash) {
                return Err(KernelError::Authorization(format!(
                    "temporary object owner is not valid for this write: {owner_id}"
                )));
            }
        }
        Ok(())
    }

    pub(super) fn consume_object_owners(
        &mut self,
        workspace_id: &str,
        grant_id: &str,
        owners: &BTreeMap<String, String>,
    ) -> Result<(), KernelError> {
        self.validate_object_owners(workspace_id, grant_id, owners)?;
        for owner_id in owners.keys() {
            self.conn.execute(
                "DELETE FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?3",
                params![owner_id, workspace_id, grant_id],
            )?;
        }
        Ok(())
    }

    pub(super) fn begin_blob_stream(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let operation_id = params
            .get("operationId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("operationId is required".to_string()))?;
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("streamId is required".to_string()))?;
        let expected_length = params
            .get("byteLength")
            .and_then(Value::as_u64)
            .ok_or_else(|| KernelError::Operation("byteLength is required".to_string()))?;
        let expected_hash = params
            .get("expectedHash")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(stream) = self.streams.get(stream_id) {
            if stream.grant_id != grant_id
                || stream.operation_id != operation_id
                || stream.expected_length != expected_length
                || stream.expected_hash != expected_hash
            {
                return Err(KernelError::Operation(
                    "operationId was reused with different stream parameters".to_string(),
                ));
            }
            return Ok(
                json!({"streamId": stream_id, "operationId": operation_id, "byteLength": expected_length, "received": stream.received, "nextSequence": stream.next_sequence}),
            );
        }
        let staging = self
            .root
            .join("staging")
            .join(format!("{stream_id}.stream"));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        self.streams.insert(
            stream_id.to_string(),
            BlobStream {
                operation_id: operation_id.to_string(),
                expected_length,
                received: 0,
                next_sequence: 0,
                expected_hash,
                staging: staging.clone(),
                grant_id: grant_id.to_string(),
                workspace_id: params
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
        );
        if let Err(error) = self.check_cancelled() {
            self.streams.remove(stream_id);
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
        Ok(
            json!({"streamId": stream_id, "operationId": operation_id, "byteLength": expected_length}),
        )
    }

    pub(crate) fn stream_blob_chunk(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("streamId is required".to_string()))?;
        let sequence = params
            .get("sequence")
            .and_then(Value::as_u64)
            .ok_or_else(|| KernelError::Operation("sequence is required".to_string()))?;
        let bytes = params
            .get("bytesBase64")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("bytesBase64 is required".to_string()))?;
        let decoded = BASE64
            .decode(bytes)
            .map_err(|error| KernelError::Operation(format!("invalid bytesBase64: {error}")))?;
        if decoded.len() > 65536 {
            return Err(KernelError::Protocol(
                "Upload chunk exceeds transport bound".into(),
            ));
        }
        self.stream_blob_bytes(stream_id, sequence, &decoded, grant_id)
    }

    pub(super) fn stream_blob_bytes(
        &mut self,
        stream_id: &str,
        sequence: u64,
        bytes: &[u8],
        grant_id: &str,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let stream = self
            .streams
            .get_mut(stream_id)
            .ok_or_else(|| KernelError::Operation("stream not found".to_string()))?;
        if stream.grant_id != grant_id || stream.next_sequence != sequence {
            return Err(KernelError::Authorization(
                "content stream identity is invalid".to_string(),
            ));
        }
        let next = stream
            .received
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| KernelError::Operation("content stream length overflow".to_string()))?;
        if next > stream.expected_length {
            return Err(KernelError::Operation(
                "content stream exceeds declared byteLength".to_string(),
            ));
        }
        let mut file = OpenOptions::new().append(true).open(&stream.staging)?;
        file.write_all(bytes)?;
        stream.received = next;
        stream.next_sequence += 1;
        Ok(())
    }

    pub(super) fn finish_blob_stream(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.check_cancelled()?;
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("streamId is required".to_string()))?;
        let stream = self
            .streams
            .remove(stream_id)
            .ok_or_else(|| KernelError::Operation("stream not found".to_string()))?;
        if stream.grant_id != grant_id {
            let _ = fs::remove_file(&stream.staging);
            return Err(KernelError::Authorization(
                "content stream identity is invalid".to_string(),
            ));
        }
        if params.get("workspaceId").and_then(Value::as_str) != stream.workspace_id.as_deref() {
            let _ = fs::remove_file(&stream.staging);
            return Err(KernelError::Authorization(
                "content stream workspace identity is invalid".to_string(),
            ));
        }
        if let Some(expected_hash) = params.get("expectedHash").and_then(Value::as_str) {
            if stream.expected_hash.as_deref() != Some(expected_hash) {
                let _ = fs::remove_file(&stream.staging);
                return Err(KernelError::Operation(
                    "content stream expectedHash does not match operation".to_string(),
                ));
            }
        }
        if stream.received != stream.expected_length {
            let _ = fs::remove_file(&stream.staging);
            return Err(KernelError::Operation(
                "content stream ended before declared byteLength".to_string(),
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&stream.staging)?;
        file.sync_all()?;
        drop(file);
        if let Err(error) = self.check_cancelled() {
            let _ = fs::remove_file(&stream.staging);
            return Err(error);
        }
        let (hash, byte_length) = hash_file(&stream.staging)?;
        if stream
            .expected_hash
            .as_deref()
            .is_some_and(|expected| expected != hash)
        {
            let _ = fs::remove_file(&stream.staging);
            return Err(KernelError::Operation(
                "content hash does not match expectedHash".to_string(),
            ));
        }
        let target = object_path(&self.root, &hash)?;
        if target.exists() {
            let (existing_hash, existing_length) = hash_file(&target)?;
            if existing_hash != hash || existing_length != byte_length {
                let _ = fs::remove_file(&stream.staging);
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {hash}"
                )));
            }
            fs::remove_file(&stream.staging)?;
            sync_directory(&self.root.join("staging"))?;
        } else {
            let shard = target.parent().expect("object path always has a shard");
            if !shard.exists() {
                fs::create_dir(shard)?;
                sync_directory(&self.root.join("objects"))?;
            }
            if let Err(error) = self.check_cancelled() {
                let _ = fs::remove_file(&stream.staging);
                return Err(error);
            }
            durable_rename(&stream.staging, &target)?;
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&target)?
                .sync_all()?;
            sync_directory(&self.root.join("staging"))?;
        }
        sync_directory(target.parent().unwrap())?;
        self.conn.execute(
            "INSERT OR IGNORE INTO blobs(hash, byte_length) VALUES (?1, ?2)",
            params![
                hash,
                i64::try_from(byte_length).map_err(|_| KernelError::Operation(
                    "content object is too large".to_string()
                ))?
            ],
        )?;
        self.verified_objects.insert(hash.clone());
        let owner_id = blob_owner_id(&stream.operation_id);
        self.record_object_owner(
            &owner_id,
            &hash,
            params.get("workspaceId").and_then(Value::as_str),
            Some(&stream.operation_id),
            grant_id,
        )?;
        Ok(json!({"hash": hash, "byteLength": byte_length, "ownerId": owner_id}))
    }

    pub(super) fn abort_blob_stream(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let stream_id = params
            .get("streamId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("streamId is required".to_string()))?;
        let Some(stream) = self.streams.remove(stream_id) else {
            return Ok(json!({"streamId": stream_id, "aborted": false}));
        };
        if stream.grant_id != grant_id {
            self.streams.insert(stream_id.to_string(), stream);
            return Err(KernelError::Authorization(
                "content stream identity is invalid".to_string(),
            ));
        }
        let _ = fs::remove_file(&stream.staging);
        Ok(json!({"streamId": stream_id, "aborted": true}))
    }

    pub(super) fn abort_streams_for_grant(&mut self, grant_id: &str) -> Result<(), KernelError> {
        let stream_ids = self
            .streams
            .iter()
            .filter(|(_, stream)| stream.grant_id == grant_id)
            .map(|(stream_id, _)| stream_id.clone())
            .collect::<Vec<_>>();
        for stream_id in stream_ids {
            if let Some(stream) = self.streams.remove(&stream_id) {
                let _ = fs::remove_file(stream.staging);
            }
        }
        self.branch_builders
            .retain(|_, builder| builder.grant_id != grant_id);
        self.branch_write_builders
            .retain(|_, builder| builder.grant_id != grant_id);
        self.conn.execute(
            "DELETE FROM object_owners WHERE grant_id = ?1",
            params![grant_id],
        )?;
        Ok(())
    }

    pub(super) fn grant_workspace(&self, grant_id: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT grant_json FROM grants WHERE grant_id = ?1",
                params![grant_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_str::<Grant>(&value).ok())
            .and_then(|grant| grant.owning_workspace)
    }

    pub(super) fn validate_blob_read_source(
        &self,
        params: &Value,
        hash: &str,
        grant_id: &str,
        storage_admin: bool,
    ) -> Result<(), KernelError> {
        let branch_id = params.get("branchId").and_then(Value::as_str);
        let pin_id = params.get("pinId").and_then(Value::as_str);
        let owner_id = params.get("ownerId").and_then(Value::as_str);
        let record_id = params.get("recordId").and_then(Value::as_str);
        if [
            branch_id.is_some(),
            pin_id.is_some(),
            owner_id.is_some(),
            record_id.is_some(),
        ]
        .into_iter()
        .filter(|value| *value)
        .count()
            != 1
        {
            return Err(KernelError::Authorization(
                "content reads require exactly one branchId, pinId, or ownerId source".to_string(),
            ));
        }
        if let Some(owner_id) = owner_id {
            if params.get("path").is_some() || params.get("revision").is_some() {
                return Err(KernelError::Authorization(
                    "owner content reads cannot claim a path or revision".to_string(),
                ));
            }
            let owned: Option<(String, String)> = self
                .conn
                .query_row(
                    "SELECT blob_hash, grant_id FROM object_owners WHERE owner_id = ?1",
                    params![owner_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if owned.as_ref().is_none_or(|(owned_hash, owner_grant)| {
                owned_hash != hash || (!storage_admin && owner_grant != grant_id)
            }) {
                return Err(KernelError::Authorization(
                    "content object is not bound to the supplied owner".to_string(),
                ));
            }
            return Ok(());
        }
        if let Some(record_id) = record_id {
            if params.get("path").is_some() || params.get("revision").is_some() {
                return Err(KernelError::Authorization(
                    "record content reads use an explicit reference slot, not a path or revision"
                        .to_string(),
                ));
            }
            let slot = params.get("slot").and_then(Value::as_str).ok_or_else(|| {
                KernelError::Authorization(
                    "record content reads require a reference slot".to_string(),
                )
            })?;
            let record_workspace = self.grant_workspace(grant_id).ok_or_else(|| {
                KernelError::Authorization(
                    "record content reads require an owning workspace grant".to_string(),
                )
            })?;
            if let Some(record) = self.domain_record_value(&record_workspace, record_id)? {
                if !self.grant_can_access_domain_record(&record, grant_id)? {
                    return Err(KernelError::Authorization(
                        "record belongs to another actor".to_string(),
                    ));
                }
            }
            let owned: Option<(String, String)> = self
                .conn
                .query_row(
                    "SELECT object_hash, workspace_id FROM domain_record_refs WHERE record_id = ?1 AND slot = ?2 AND workspace_id = ?3 UNION SELECT object_hash, workspace_id FROM recovery_refs WHERE (owner_id = ?1 OR owner_id LIKE ?1 || ':%') AND slot = ?2 AND workspace_id = ?3 LIMIT 1",
                    params![record_id, slot, record_workspace],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if owned.as_ref().is_none_or(|(owned_hash, workspace)| {
                owned_hash != hash
                    || (!storage_admin
                        && self
                            .grant_workspace(grant_id)
                            .is_some_and(|grant_workspace| grant_workspace != *workspace))
            }) {
                return Err(KernelError::Authorization(
                    "content object is not bound to the supplied durable record".to_string(),
                ));
            }
            return Ok(());
        }
        let raw_path = params.get("path").and_then(Value::as_str).ok_or_else(|| {
            KernelError::Authorization(
                "path is required for a branch or pin content read".to_string(),
            )
        })?;
        let path = Self::validate_path(raw_path)?.join("/");
        let root = if let Some(branch_id) = branch_id {
            if let Some(revision) = params.get("revision").and_then(Value::as_i64) {
                self.conn
                    .query_row(
                        "SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                        params![branch_id, revision],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| match error {
                        rusqlite::Error::QueryReturnedNoRows => KernelError::Operation(format!(
                            "revision not found: {branch_id}@{revision}"
                        )),
                        other => other.into(),
                    })?
            } else {
                self.branch(branch_id)?.head_root
            }
        } else {
            if params.get("revision").is_some() {
                return Err(KernelError::Authorization(
                    "revision is only valid for a branch content source".to_string(),
                ));
            }
            let (root, owner_grant, ephemeral): (String, String, bool) = self
                .conn
                .query_row(
                    "SELECT root_hash, grant_id, ephemeral FROM pins WHERE pin_id = ?1",
                    params![pin_id.expect("source count checked")],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => {
                        KernelError::Operation("pin not found".to_string())
                    }
                    other => other.into(),
                })?;
            if ephemeral && owner_grant != grant_id && !storage_admin {
                return Err(KernelError::Authorization(
                    "query pin belongs to another actor".to_string(),
                ));
            }
            root
        };
        let state = self.root_get(&root, &path)?;
        if state.as_ref().and_then(PathState::object_hash) != Some(hash) {
            return Err(KernelError::Authorization(
                "content object is not the file bound to the supplied source path".to_string(),
            ));
        }
        Ok(())
    }

    pub(super) fn get_blob(
        &mut self,
        params: &Value,
        grant_id: &str,
        storage_admin: bool,
    ) -> Result<Value, KernelError> {
        let hash = params
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("hash is required".to_string()))?;
        self.validate_blob_read_source(params, hash, grant_id, storage_admin)?;
        let path = object_path(&self.root, hash)?;
        let byte_length = fs::metadata(&path)?.len();
        if !self.verified_objects.contains(hash) {
            let (actual, hashed_length) = hash_file(&path)?;
            if actual != hash || hashed_length != byte_length {
                return Err(KernelError::Storage(format!(
                    "content object is corrupt: {hash}"
                )));
            }
            self.verified_objects.insert(hash.to_string());
        }
        let recorded: Option<i64> = self
            .conn
            .query_row(
                "SELECT byte_length FROM blobs WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;
        if recorded
            != Some(
                i64::try_from(byte_length)
                    .map_err(|_| KernelError::Storage("content object is too large".to_string()))?,
            )
        {
            return Err(KernelError::Storage(format!(
                "content object metadata is missing or corrupt: {hash}"
            )));
        }
        let offset = match params.get("offset") {
            Some(value) => value.as_u64().ok_or_else(|| {
                KernelError::Operation("offset must be a non-negative integer".to_string())
            })?,
            None => 0,
        };
        let length = match params.get("length") {
            Some(value) => value.as_u64().ok_or_else(|| {
                KernelError::Operation("length must be a non-negative integer".to_string())
            })?,
            None => byte_length.saturating_sub(offset),
        };
        if byte_length > MAX_BLOB_RESPONSE_BYTES as u64 && params.get("length").is_none() {
            return Err(KernelError::Operation(
                "content object is larger than one response frame; request a byte range"
                    .to_string(),
            ));
        }
        if length > MAX_BLOB_RESPONSE_BYTES as u64 {
            return Err(KernelError::Operation(
                "requested byte range is larger than one response frame".to_string(),
            ));
        }
        let start = offset.min(byte_length);
        let end = start.saturating_add(length).min(byte_length);
        let slice_length = usize::try_from(end - start).map_err(|_| {
            KernelError::Operation("requested object range is too large".to_string())
        })?;
        let mut file = File::open(&path)?;
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0u8; slice_length];
        file.read_exact(&mut bytes)?;
        Ok(
            json!({"hash": hash, "byteLength": byte_length, "offset": start, "nextOffset": end, "eof": end >= byte_length, "bytesBase64": BASE64.encode(bytes)}),
        )
    }
}
