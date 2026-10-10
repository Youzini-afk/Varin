//! Reachability collection and durable object cleanup.
use super::*;

impl Storage {
    pub(super) fn drain_gc_files(&mut self) -> Result<Value, KernelError> {
        let rows: Vec<(String, String)> = self
            .conn
            .prepare("SELECT hash, path FROM pending_gc_files WHERE state IN ('pending', 'failed') ORDER BY queued_at")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let mut deleted = Vec::new();
        let mut reclaimed_bytes = 0_u64;
        let mut failures = Vec::new();
        for (hash, raw_path) in rows {
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
        let pending: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM pending_gc_files", [], |row| {
                    row.get(0)
                })?;
        let failures = self
            .conn
            .prepare(
                "SELECT last_error FROM pending_gc_files WHERE state = 'failed' ORDER BY queued_at",
            )?
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect();
        Ok((pending, failures))
    }

    pub(super) fn gc(&mut self) -> Result<Value, KernelError> {
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
            .prepare("SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins UNION SELECT json_extract(payload_json,'$.root') FROM domain_records WHERE record_type='working.result' UNION SELECT json_extract(payload_json,'$.baseRoot') FROM domain_records WHERE record_type='working.result'")?
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
        let mut blobs = BTreeSet::new();
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
        let stale_root_blobs: Vec<(String, String)> = self
            .conn
            .prepare("SELECT root_hash, blob_hash FROM root_blobs")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (root_hash, blob_hash) in stale_root_blobs {
            if !nodes.contains(&root_hash) {
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
            if !nodes.contains(&root_hash) || !nodes.contains(&parent_root) {
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
            if !nodes.contains(&hash) {
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
            if !blobs.contains(&hash) {
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
