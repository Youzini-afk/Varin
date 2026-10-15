//! Managed read delivery uses the original operation log and immutable objects.
//! Local reads keep their existing fast path. Bodies are staged and hydrated by
//! workers; Storage only admits the original identity and publishes short refs.
use super::*;
use crate::source_resources::{AuthorityRecord, SourceResourceCallParams};

pub(crate) struct ReadPreparation {
    record: AuthorityRecord,
    operation_id: String,
    params_hash: String,
    root: PathBuf,
}
pub(crate) struct StagedRead {
    preparation: ReadPreparation,
    staged: PathBuf,
    hash: String,
    byte_length: u64,
}
impl Drop for StagedRead {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.staged);
    }
}
pub(crate) struct ReadReceipt {
    path: PathBuf,
    hash: String,
    byte_length: u64,
    _retention: blob_reads::BlobReadRetention,
}
impl ReadReceipt {
    pub(crate) fn load(self) -> Result<Value, KernelError> {
        let bytes = fs::read(&self.path)?;
        if bytes.len() as u64 != self.byte_length
            || format!("sha256-{}", hex::encode(Sha256::digest(&bytes))) != self.hash
        {
            return Err(KernelError::Storage(
                "Original source read receipt object is corrupt".into(),
            ));
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
}
impl ReadPreparation {
    pub(crate) fn stage(
        self,
        result: Result<Value, KernelError>,
    ) -> Result<(Value, StagedRead), KernelError> {
        // This worker has actually returned, including all original resource drain.
        // A failed read has no writer; preserve its terminal failure, not a fabricated replay.
        let value = result.unwrap_or_else(|error| {
            let receipt:varin_runtime::execution::ToolExecutionReceipt = varin_runtime::execution::ToolExecutionReceipt {
                executor_stopped: true,
                completion: varin_runtime::execution::ToolCompletion::Result {
                    outcome: varin_runtime::Outcome::Failed,
                    effect: varin_runtime::Effect::None,
                    content: json!({"error":error.to_string()}).into(),
                },
            };
            json!({"operationId":self.operation_id,"resourceEpoch":self.record.result.resource_epoch,"executionOwner":self.record.result.execution_owner,"accepted":true,"executorStopped":true,"result":receipt})
        });
        let staged = self
            .root
            .join("staging")
            .join(format!("source-read-{}", Uuid::new_v4()));
        let mut holder = StagedRead {
            preparation: self,
            staged,
            hash: String::new(),
            byte_length: 0,
        };
        let bytes = serde_json::to_vec(&value)?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&holder.staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        holder.hash = format!("sha256-{}", hex::encode(Sha256::digest(&bytes)));
        holder.byte_length = bytes.len() as u64;
        Ok((value, holder))
    }
}
impl Storage {
    pub(crate) fn prepare_source_read(
        &mut self,
        record: &AuthorityRecord,
        input: &SourceResourceCallParams,
    ) -> Result<Option<ReadPreparation>, KernelError> {
        let id = &input.call.operation_id;
        let params_hash = hash_json(&json!([
            record.result.authority_id,
            input.call,
            input.journal
        ]))?;
        let prior = self.operation_get(&json!({"operationId":id}))?;
        if !prior.is_null() {
            if prior["kind"] != "source.read"
                || prior["paramsHash"] != params_hash
                || prior["result"]["authorityId"] != record.result.authority_id
            {
                return Err(crate::source_resources::denied(
                    "Read operation identity was reused",
                ));
            }
            return Ok(None);
        }
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let admitted = (|| {
            self.operation_begin(id, "source.read", &params_hash)?;
            self.record_operation_workspace(id, Some(&record.result.source.workspace_id))?;
            self.conn.execute("UPDATE operations SET result_json=?2 WHERE operation_id=?1",params![id,serde_json::to_string(&json!({"authorityId":record.result.authority_id,"grantId":record.result.grant_id}))?])?;
            Ok::<_, KernelError>(())
        })();
        if let Err(error) = admitted {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(error);
        }
        self.conn.execute_batch("COMMIT")?;
        Ok(Some(ReadPreparation {
            record: record.clone(),
            operation_id: id.clone(),
            params_hash,
            root: self.root.clone(),
        }))
    }
    pub(crate) fn recall_source_read(
        &mut self,
        record: &AuthorityRecord,
        id: &str,
    ) -> Result<Option<ReadReceipt>, KernelError> {
        let prior = self.operation_get(&json!({"operationId":id}))?;
        if prior["kind"] != "source.read" {
            return Ok(None);
        }
        if prior["result"]["authorityId"] != record.result.authority_id
            || prior["result"]["grantId"] != record.result.grant_id
        {
            return Err(crate::source_resources::denied(
                "Read receipt belongs to another original source authority",
            ));
        }
        if prior["state"] != "committed" {
            return Ok(None);
        }
        if prior["result"]["released"] == true {
            return Err(KernelError::Operation(
                "Original read body was released after delivery; it cannot be replayed".into(),
            ));
        }
        let hash = prior["result"]["objectHash"].as_str().ok_or_else(|| {
            KernelError::Storage("Read receipt object identity is missing".into())
        })?;
        let byte_length = prior["result"]["byteLength"]
            .as_u64()
            .ok_or_else(|| KernelError::Storage("Read receipt object length is missing".into()))?;
        Ok(Some(ReadReceipt {
            path: object_path(&self.root, hash)?,
            hash: hash.into(),
            byte_length,
            _retention: self.blob_read_roots.retain(hash),
        }))
    }
    pub(crate) fn publish_source_read(&mut self, staged: StagedRead) -> Result<(), KernelError> {
        let p = &staged.preparation;
        let prior = self.operation_get(&json!({"operationId":p.operation_id}))?;
        if prior["kind"] != "source.read"
            || prior["state"] != "started"
            || prior["paramsHash"] != p.params_hash
            || prior["result"]["authorityId"] != p.record.result.authority_id
        {
            return Err(KernelError::Storage(
                "Original source read admission changed".into(),
            ));
        }
        // Same staged publication as capture: no body/hash I/O under Storage.
        // The actor serializes rename and GC; bytes are durable before refs are visible.
        let object = object_path(&self.root, &staged.hash)?;
        let shard = object.parent().expect("content object shard");
        if !shard.exists() {
            fs::create_dir_all(shard)?;
            sync_directory(&self.root.join("objects"))?;
        }
        durable_rename(&staged.staged, &object)?;
        sync_directory(shard)?;
        sync_directory(&self.root.join("staging"))?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let published = (|| {
            self.conn.execute(
                "INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES(?1,?2)",
                params![
                    staged.hash,
                    i64::try_from(staged.byte_length).map_err(|_| KernelError::Storage(
                        "Read receipt object is too large".into()
                    ))?
                ],
            )?;
            // The committed original operation owns this object after delivery,
            // independently of the caller grant and its temporary upload owners.
            self.conn
                .execute("DELETE FROM pending_gc_files WHERE hash=?1", [&staged.hash])?;
            self.operation_finish(&p.operation_id,&json!({"authorityId":p.record.result.authority_id,"grantId":p.record.result.grant_id,"objectHash":staged.hash,"byteLength":staged.byte_length}))?;
            Ok::<_, KernelError>(())
        })();
        if let Err(error) = published {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(error);
        }
        self.conn.execute_batch("COMMIT")?;
        Ok(())
    }
}

impl Storage {
    pub(crate) fn release_source_read(
        &mut self,
        address: &crate::source_resources::SourceAuthorityAddress,
        id: &str,
        epoch: &str,
    ) -> Result<Value, KernelError> {
        let record = self.source_authority(address, false, epoch)?;
        let mut prior = self.operation_get(&json!({"operationId":id}))?;
        if prior.is_null() {
            // An acknowledged pre-dispatch cancellation may never have reached B.
            // Fence this original identity before acknowledging cleanup: a delayed
            // execute cannot create a read after its coordinator deletes the address.
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            let tombstone = (|| {
                self.operation_begin(
                    id,
                    "source.read",
                    &hash_json(&json!([record.result.authority_id, id, "released"]))?,
                )?;
                self.record_operation_workspace(id, Some(&record.result.source.workspace_id))?;
                self.operation_finish(id, &json!({"authorityId":record.result.authority_id,"grantId":record.result.grant_id,"released":true}))?;
                Ok::<_, KernelError>(())
            })();
            if let Err(error) = tombstone {
                let _ = self.conn.execute_batch("ROLLBACK");
                return Err(error);
            }
            self.conn.execute_batch("COMMIT")?;
            prior = self.operation_get(&json!({"operationId":id}))?;
        }
        if prior["kind"] != "source.read"
            || prior["result"]["authorityId"] != record.result.authority_id
            || prior["result"]["grantId"] != record.result.grant_id
        {
            return Err(crate::source_resources::denied(
                "Read delivery belongs to another original authority",
            ));
        }
        let released = prior["state"] == "committed";
        if released && prior["result"]["released"] != true {
            // Retain the original fingerprint so a late execute cannot read new bytes.
            self.operation_finish(id,&json!({"authorityId":record.result.authority_id,"grantId":record.result.grant_id,"released":true}))?;
        }
        Ok(
            json!({"operationId":id,"resourceEpoch":record.result.resource_epoch,"executionOwner":record.result.execution_owner,"released":released}),
        )
    }
}
