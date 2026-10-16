//! Reachability collection and durable object cleanup.
use super::*;

impl Storage {
    pub(super) fn drain_gc_files(&mut self) -> Result<Value, KernelError> {
        self.drain_selected_gc_files(None)
    }

    pub(super) fn drain_selected_gc_files(&mut self, selected: Option<&BTreeSet<String>>) -> Result<Value, KernelError> {
        let rows: Vec<(String, String)> = self
            .conn
            .prepare("SELECT hash, path FROM pending_gc_files WHERE state IN ('pending', 'failed') ORDER BY queued_at")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let mut deleted = Vec::new();
        let mut reclaimed_bytes = 0_u64;
        let mut failures = Vec::new();
        for (hash, raw_path) in rows {
            if selected.is_some_and(|hashes| !hashes.contains(&hash)) { continue; }
            if self.blob_read_roots.contains(&hash) {
                continue;
            }
            // An object may have been installed again after an earlier cleanup
            // failure. A stale delete intent cannot revoke a newer catalog fact.
            let installed: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM blobs WHERE hash = ?1)",
                params![hash],
                |row| row.get(0),
            )?;
            if installed {
                self.conn.execute(
                    "DELETE FROM pending_gc_files WHERE hash = ?1",
                    params![hash],
                )?;
                continue;
            }
            let derived = match object_path(&self.root, &hash) {
                Ok(path) => path,
                Err(error) => {
                    let message = format!("{hash}: invalid pending object identity: {error}");
                    self.conn.execute(
                        "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                        params![hash, message],
                    )?;
                    failures.push(message);
                    continue;
                }
            };
            let objects_root = self.root.join("objects");
            if !derived.starts_with(&objects_root) {
                let message = format!("{hash}: pending object path escaped storage root");
                self.conn.execute(
                    "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                    params![hash, message],
                )?;
                failures.push(message);
                continue;
            }
            if std::env::var_os("VARIN_KERNEL_FAIL_GC_DELETE").is_some() {
                let message = format!("{hash}: injected GC cleanup failure");
                self.conn.execute(
                    "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                    params![hash, message],
                )?;
                failures.push(message);
                continue;
            }
            if Path::new(&raw_path) != derived {
                let message = format!("{hash}: ignored untrusted pending path");
                self.conn.execute(
                    "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                    params![hash, message],
                )?;
                failures.push(message);
                continue;
            }
            let byte_length = match fs::symlink_metadata(&derived) {
                Ok(metadata) => metadata.len(),
                Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
                Err(error) => {
                    let message = format!("{hash}: unable to measure pending object: {error}");
                    self.conn.execute(
                        "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                        params![hash, message],
                    )?;
                    failures.push(message);
                    continue;
                }
            };
            match fs::remove_file(&derived) {
                Ok(()) => {
                    deleted.push(hash.clone());
                    reclaimed_bytes += byte_length;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => deleted.push(hash.clone()),
                Err(error) => {
                    let message = format!("{hash}: {error}");
                    self.conn.execute(
                        "UPDATE pending_gc_files SET state = 'failed', last_error = ?2 WHERE hash = ?1",
                        params![hash, message],
                    )?;
                    failures.push(message);
                }
            }
        }
        for hash in &deleted {
            self.conn.execute(
                "DELETE FROM pending_gc_files WHERE hash = ?1",
                params![hash],
            )?;
        }
        Ok(
            json!({"deleted": deleted, "failures": failures, "byteLengthReclaimed": reclaimed_bytes}),
        )
    }

    pub(super) fn sweep_orphan_objects(&mut self) -> Result<(), KernelError> {
        let objects_root = self.root.join("objects");
        let Ok(shards) = fs::read_dir(&objects_root) else {
            return Ok(());
        };
        for shard in shards.flatten() {
            let shard_path = shard.path();
            let shard_name = shard.file_name().to_string_lossy().to_string();
            if shard_name.len() != 2 || !shard_name.chars().all(|value| value.is_ascii_hexdigit()) {
                continue;
            }
            let Ok(files) = fs::read_dir(&shard_path) else {
                continue;
            };
            for file in files.flatten() {
                let file_path = file.path();
                if !file_path.is_file() {
                    continue;
                }
                let suffix = file.file_name().to_string_lossy().to_string();
                if suffix.len() != 62 || !suffix.chars().all(|value| value.is_ascii_hexdigit()) {
                    continue;
                }
                let hash = format!("sha256-{shard_name}{suffix}");
                let referenced: Option<i64> = self
                    .conn
                    .query_row(
                        "SELECT 1 FROM blobs WHERE hash = ?1 UNION SELECT 1 FROM root_blobs WHERE blob_hash = ?1 LIMIT 1",
                        params![hash],
                        |row| row.get(0),
                    )
                    .optional()?;
                if referenced.is_none() {
                    self.conn.execute(
                        "INSERT OR IGNORE INTO pending_gc_files(hash, path, state, queued_at) VALUES (?1, ?2, 'pending', ?3)",
                        params![hash, file_path.to_string_lossy().to_string(), now_ms()],
                    )?;
                }
            }
        }
        Ok(())
    }

    pub(super) fn cleanup_status(&self) -> Result<(i64, Vec<String>), KernelError> {
        let mut pending: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM pending_gc_files", [], |row| {
                    row.get(0)
                })?;
        let mut failures: Vec<String> = self
            .conn
            .prepare(
                "SELECT last_error FROM pending_gc_files WHERE state = 'failed' ORDER BY queued_at",
            )?
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect();
        let views=self.conn.prepare("SELECT payload_json FROM domain_records WHERE record_type='file.materialized-view' AND json_extract(payload_json,'$.cleanupRequested')=1")?
            .query_map([],|row|row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        pending += views.len() as i64;
        for raw in views {
            let view: Value = serde_json::from_str(&raw)?;
            if let Some(error) = view["cleanupError"].as_str() {
                failures.push(format!(
                    "derived view {}: {error}",
                    view["viewId"].as_str().unwrap_or("unknown")
                ));
            }
        }
        Ok((pending, failures))
    }

    fn gc_reachable(&mut self) -> Result<(BTreeSet<String>, BTreeSet<String>), KernelError> {
        let mut roots = BTreeSet::new();
        for row in self
            .conn
            .prepare("SELECT base_root, head_root FROM branches")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
        {
            let (a, b) = row?;
            roots.insert(a);
            roots.insert(b);
        }
        for row in self
            .conn
            .prepare("SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins UNION SELECT json_extract(payload_json,'$.root') FROM domain_records WHERE record_type='working.result' UNION SELECT json_extract(payload_json,'$.baseRoot') FROM domain_records WHERE record_type='working.result' UNION SELECT json_extract(payload_json,'$.sourceRoot') FROM domain_records WHERE record_type='file.materialized-view'")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            roots.insert(row?);
        }
        // A failed/paused materialization must retain its immutable source even
        // after the caller's epoch-local pin or branch has been released.
        for row in self.conn.prepare(
            "SELECT result_json FROM operations WHERE state = 'started' AND kind = 'file.materialize'"
        )?.query_map([], |row| row.get::<_, String>(0))? {
            let envelope: Value = serde_json::from_str(&row?)?;
            let root = envelope.get("intent").and_then(|intent| intent.get("sourceRoot"))
                .and_then(Value::as_str).ok_or_else(|| KernelError::Storage("pending materialization has no source root".to_string()))?;
            roots.insert(root.to_string());
        }
        let mut nodes = BTreeSet::new();
        let mut blobs = self.blob_read_roots.active_hashes();
        for root in roots {
            self.check_cancelled()?;
            self.collect_reachable(&root, &mut nodes, &mut blobs)?;
        }
        for row in self
            .conn
            .prepare("SELECT blob_hash FROM object_owners")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            blobs.insert(row?);
        }
        for row in self.conn.prepare("SELECT json_extract(result_json,'$.objectHash') FROM operations WHERE kind IN ('source.read','source.schedule') AND state='committed' AND json_extract(result_json,'$.released') IS NOT 1")?.query_map([], |row| row.get::<_,String>(0))? {
            blobs.insert(row?);
        }
        // Original MCP holders own creation bodies until their exact release,
        // including while their Source is revoked or a Host has reopened.
        for row in self.conn.prepare(
            "SELECT json_extract(holder.value,'$.creationReceipt.outcomeRef.objectHash')
             FROM domain_records AS source, json_each(source.payload_json,'$.result.mcpHolders') AS holder
             WHERE source.record_type='source.authority'
               AND json_extract(holder.value,'$.released')=0
               AND json_extract(holder.value,'$.creationReceipt.outcomeRef.objectHash') IS NOT NULL"
        )?.query_map([], |row| row.get::<_, String>(0))? {
            blobs.insert(row?);
        }
        // Exact parent definition references own their existing Storage bodies.
        // A release tombstone never remains a GC root, even after late retain.
        for row in self.conn.prepare(
            "SELECT json_extract(child.value,'$.selectionRef.objectHash')
             FROM domain_records AS source, json_each(source.payload_json,'$.result.mcpChildren') AS child
             WHERE source.record_type='source.authority'
               AND json_extract(child.value,'$.released')=0
               AND json_extract(child.value,'$.selectionRef.objectHash') IS NOT NULL"
        )?.query_map([], |row| row.get::<_, String>(0))? {
            blobs.insert(row?);
        }
        // Proof publication survives physical Source retirement until the original
        // delegated launch or its terminal cleanup acknowledges it. It retains only bytes.
        for field in ["requestRef", "outcomeRef"] {
            for row in self.conn.prepare(&format!(
                "SELECT json_extract(payload_json,'$.result.mcpDerivation.{field}.objectHash')
                 FROM domain_records WHERE record_type='source.authority'
                 AND json_extract(payload_json,'$.result.mcpDerivation.released')=0
                 AND json_extract(payload_json,'$.result.mcpDerivation.{field}.objectHash') IS NOT NULL"
            ))?.query_map([], |row| row.get::<_, String>(0))? { blobs.insert(row?); }
        }
        for row in self
            .conn
            .prepare("SELECT object_hash FROM domain_record_refs")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            blobs.insert(row?);
        }
        for row in self
            .conn
            .prepare("SELECT object_hash FROM recovery_refs")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            blobs.insert(row?);
        }
        Ok((nodes, blobs))
    }

    /// Read-only preview uses the exact same reachability rules as collection.
    /// It does not sweep or release any history, materialization or operation.
    pub(super) fn gc_preview(&mut self) -> Result<Value, KernelError> {
        let (_, retained) = self.gc_reachable()?;
        let hashes: BTreeSet<String> = self.conn
            .prepare("SELECT hash FROM blobs UNION SELECT hash FROM pending_gc_files")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        let mut objects = Vec::new();
        for hash in hashes {
            self.check_cancelled()?;
            if retained.contains(&hash) { continue; }
            let file = object_path(&self.root, &hash)?;
            let metadata = match fs::symlink_metadata(&file) {
                Ok(value) => value,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !metadata.file_type().is_file() { continue; }
            objects.push(json!({"hash": hash, "byteLength": metadata.len()}));
        }
        Ok(json!({"objects": objects, "retainedObjects": retained.len()}))
    }

    pub(super) fn gc(&mut self) -> Result<Value, KernelError> {
        self.gc_selected(None)
    }

    pub(super) fn gc_selected(&mut self, selected: Option<&BTreeSet<String>>) -> Result<Value, KernelError> {
        let (nodes, blobs) = self.gc_reachable()?;
        let stale_root_blobs: Vec<(String, String)> = self
            .conn
            .prepare("SELECT root_hash, blob_hash FROM root_blobs")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (root_hash, blob_hash) in stale_root_blobs {
            if selected.is_none() && !nodes.contains(&root_hash) {
                self.conn.execute(
                    "DELETE FROM root_blobs WHERE root_hash = ?1 AND blob_hash = ?2",
                    params![root_hash, blob_hash],
                )?;
            }
        }
        let stale_parents: Vec<(String, String)> = self
            .conn
            .prepare("SELECT root_hash, parent_root FROM root_parents")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (root_hash, parent_root) in stale_parents {
            if selected.is_none() && (!nodes.contains(&root_hash) || !nodes.contains(&parent_root)) {
                self.conn.execute(
                    "DELETE FROM root_parents WHERE root_hash = ?1 AND parent_root = ?2",
                    params![root_hash, parent_root],
                )?;
            }
        }
        // Domain owners are released by their explicit terminal transitions.
        // In particular a started file operation is durable recovery evidence,
        // not a failed transaction or a garbage-collection candidate.
        let all_nodes: Vec<String> = self
            .conn
            .prepare("SELECT hash FROM trie_nodes")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let mut deleted_nodes = 0;
        for hash in all_nodes {
            self.check_cancelled()?;
            if selected.is_none() && !nodes.contains(&hash) {
                self.conn
                    .execute("DELETE FROM trie_nodes WHERE hash = ?1", params![hash])?;
                deleted_nodes += 1;
            }
        }
        let all_blobs: Vec<String> = self
            .conn
            .prepare("SELECT hash FROM blobs")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let mut deleted_blobs = 0;
        for hash in all_blobs {
            self.check_cancelled()?;
            if !blobs.contains(&hash) && selected.is_none_or(|hashes| hashes.contains(&hash)) {
                let path = object_path(&self.root, &hash)?;
                self.conn.execute(
                    "INSERT OR IGNORE INTO pending_gc_files(hash, path, state, queued_at) VALUES (?1, ?2, 'pending', ?3)",
                    params![hash, path.to_string_lossy().to_string(), now_ms()],
                )?;
                self.conn
                    .execute("DELETE FROM blobs WHERE hash = ?1", params![hash])?;
                self.verified_objects.remove(&hash);
                deleted_blobs += 1;
            }
        }
        Ok(
            json!({"deletedNodes": deleted_nodes, "releasedBlobs": deleted_blobs, "deletedBlobs": 0, "cleanupFailures": [], "retainedNodes": nodes.len(), "retainedBlobs": blobs.len()}),
        )
    }

    pub(super) fn collect_reachable(
        &self,
        hash: &str,
        nodes: &mut BTreeSet<String>,
        blobs: &mut BTreeSet<String>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        if !nodes.insert(hash.to_string()) {
            return Ok(());
        }
        let node = self.load_node(hash)?;
        match node {
            TrieNode::Path { state, children } => {
                if let Some(state) = state {
                    if let Some(blob) = state.object_hash() {
                        blobs.insert(blob.to_string());
                    }
                }
                if let Some(children) = children {
                    self.collect_reachable(&children, nodes, blobs)?;
                }
            }
            TrieNode::Index {
                child, left, right, ..
            } => {
                self.collect_reachable(&child, nodes, blobs)?;
                if let Some(left) = left {
                    self.collect_reachable(&left, nodes, blobs)?;
                }
                if let Some(right) = right {
                    self.collect_reachable(&right, nodes, blobs)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod storage_settings_tests {
    use super::*;

    fn fixture() -> (Storage, Grant, PathBuf) {
        let root = std::env::temp_dir().join(format!("varin-storage-settings-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&root, "host").unwrap();
        storage.issue_grant(&json!({"grantId":"settings-test","hostGeneration":"generation","owningWorkspace":"workspace","executionWorkspace":"workspace",
            "capabilities":["storage.read","storage.write","storage.gc"],"pathScopes":[""]}), "host", "generation", root.to_str().unwrap(), "epoch").unwrap();
        let grant = storage.load_grant("settings-test").unwrap();
        (storage, grant, root)
    }
    fn invoke(storage: &mut Storage, grant: &Grant, method: &str, value: Value) -> Value {
        let (grant, params) = storage.authorize(Some(&grant.grant_id), &grant.kernel_epoch, "host", "generation", method, &value).unwrap();
        storage.dispatch(method, &params, Some(&grant.grant_id), &grant).unwrap()
    }
    fn put(storage: &mut Storage, grant: &Grant, id: &str, bytes: &[u8]) -> Value {
        invoke(storage, grant, "storage.putBlob.begin", json!({"operationId":id,"streamId":id,"workspaceId":"workspace","byteLength":bytes.len()}));
        invoke(storage, grant, "storage.putBlob.chunk", json!({"streamId":id,"sequence":0,"bytesBase64":BASE64.encode(bytes)}));
        invoke(storage, grant, "storage.putBlob.finish", json!({"operationId":id,"streamId":id,"workspaceId":"workspace"}))
    }
    fn release(storage: &mut Storage, grant: &Grant, blob: &Value) {
        invoke(storage, grant, "storage.blob.release", json!({"ownerId":blob["ownerId"],"workspaceId":"workspace"}));
    }
    fn close(storage: Storage, root: PathBuf) { drop(storage); fs::remove_dir_all(root).unwrap(); }

    #[test]
    fn preview_is_read_only_and_uses_the_same_recovery_and_temporary_roots() {
        let (mut storage, grant, root) = fixture();
        let temporary = put(&mut storage, &grant, "temporary", b"temporary reader");
        let recovery = put(&mut storage, &grant, "recovery", b"undo safety");
        release(&mut storage, &grant, &recovery);
        storage.conn.execute("INSERT INTO recovery_refs(workspace_id,owner_kind,owner_id,slot,object_hash) VALUES('workspace','operation','undo','safety',?1)", [recovery["hash"].as_str().unwrap()]).unwrap();
        let abandoned = put(&mut storage, &grant, "abandoned", b"discard me");
        release(&mut storage, &grant, &abandoned);
        let preview = invoke(&mut storage, &grant, "storage.health", json!({"gcPreview":true}));
        assert_eq!(preview["gcPreview"]["objects"], json!([{"hash":abandoned["hash"],"byteLength":10}]));
        for blob in [&temporary, &recovery, &abandoned] { assert!(object_path(&root, blob["hash"].as_str().unwrap()).unwrap().exists()); }
        assert_eq!(storage.conn.query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
        close(storage, root);
    }

    #[test]
    fn confirmation_only_collects_selected_hashes_and_rechecks_new_references() {
        let (mut storage, grant, root) = fixture();
        let selected = put(&mut storage, &grant, "selected", b"selected body");
        let newly_referenced = put(&mut storage, &grant, "rereferenced", b"protect again");
        release(&mut storage, &grant, &selected); release(&mut storage, &grant, &newly_referenced);
        let preview = storage.gc_preview().unwrap();
        assert_eq!(preview["objects"].as_array().unwrap().len(), 2);
        storage.record_object_owner("new-reader", newly_referenced["hash"].as_str().unwrap(), Some("workspace"), None, &grant.grant_id).unwrap();
        let later = put(&mut storage, &grant, "later", b"not in preview"); release(&mut storage, &grant, &later);
        let params = json!({"operationId":"confirmed-preview","objectHashes":[selected["hash"],newly_referenced["hash"]]});
        let receipt = invoke(&mut storage, &grant, "storage.gc", params.clone());
        assert_eq!(receipt["byteLengthReclaimed"], 13);
        assert_eq!(receipt["deletedBlobs"], 1);
        assert_eq!(receipt["cleanupFailures"], json!([]));
        assert!(!object_path(&root, selected["hash"].as_str().unwrap()).unwrap().exists());
        assert!(object_path(&root, newly_referenced["hash"].as_str().unwrap()).unwrap().exists());
        assert!(object_path(&root, later["hash"].as_str().unwrap()).unwrap().exists());
        assert_eq!(invoke(&mut storage, &grant, "storage.gc", params), receipt);
        assert_eq!(storage.health(&json!({"deep":true})).unwrap()["integrity"], "ok");
        close(storage, root);
    }

    #[test]
    fn scoped_cleanup_does_not_drain_unselected_pending_files_or_report_their_failures() {
        let (mut storage, grant, root) = fixture();
        let selected = put(&mut storage, &grant, "selected", b"selected"); release(&mut storage, &grant, &selected);
        let pending = put(&mut storage, &grant, "pending", b"pending"); release(&mut storage, &grant, &pending);
        storage.conn.execute("DELETE FROM blobs WHERE hash=?1", [pending["hash"].as_str().unwrap()]).unwrap();
        storage.conn.execute("INSERT INTO pending_gc_files(hash,path,state,last_error,queued_at) VALUES(?1,'untrusted-path','failed','older failure',1)", [pending["hash"].as_str().unwrap()]).unwrap();
        let receipt = invoke(&mut storage, &grant, "storage.gc", json!({"operationId":"only-selected","objectHashes":[selected["hash"]]}));
        assert_eq!(receipt["byteLengthReclaimed"], 8);
        assert_eq!(receipt["cleanupFailures"], json!([]));
        assert!(object_path(&root, pending["hash"].as_str().unwrap()).unwrap().exists());
        let failure = invoke(&mut storage, &grant, "storage.gc", json!({"operationId":"pending-failure","objectHashes":[pending["hash"]]}));
        assert_eq!(failure["byteLengthReclaimed"], 0);
        assert!(!failure["cleanupFailures"].as_array().unwrap().is_empty());
        close(storage, root);
    }
}
