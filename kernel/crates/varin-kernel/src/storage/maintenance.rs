//! Deep integrity checks and storage health reporting.
use super::*;

impl Storage {
    pub(super) fn validate_node_integrity(
        &self,
        hash: &str,
        lower: Option<&str>,
        upper: Option<&str>,
        active: &mut BTreeSet<String>,
        cached: &mut HashMap<String, (i32, Option<String>, Option<String>)>,
        errors: &mut Vec<String>,
    ) -> Result<(i32, Option<String>, Option<String>), KernelError> {
        if !active.insert(hash.to_string()) {
            errors.push(format!("trie cycle detected at {hash}"));
            return Ok((0, None, None));
        }
        let node = self.load_node(hash)?;
        let result = match node {
            TrieNode::Path { state, children } => {
                if state.as_ref().is_some_and(|state| !state.is_directory()) && children.is_some() {
                    errors.push(format!("non-directory path node has children: {hash}"));
                }
                if let Some(children) = children {
                    let _ = self
                        .validate_node_integrity(&children, None, None, active, cached, errors)?;
                }
                (0, None, None)
            }
            TrieNode::Index {
                key,
                child,
                left,
                right,
                height,
            } => {
                if lower.is_some_and(|lower| key.as_str() <= lower)
                    || upper.is_some_and(|upper| key.as_str() >= upper)
                {
                    errors.push(format!("AVL key order violation at {hash}"));
                }
                let _ = self.validate_node_integrity(&child, None, None, active, cached, errors)?;
                let left_info = if let Some(left) = left {
                    self.validate_node_integrity(
                        &left,
                        lower,
                        Some(key.as_str()),
                        active,
                        cached,
                        errors,
                    )?
                } else {
                    (0, None, None)
                };
                let right_info = if let Some(right) = right {
                    self.validate_node_integrity(
                        &right,
                        Some(key.as_str()),
                        upper,
                        active,
                        cached,
                        errors,
                    )?
                } else {
                    (0, None, None)
                };
                let expected_height = left_info.0.max(right_info.0) + 1;
                if i32::from(height) != expected_height || (left_info.0 - right_info.0).abs() > 1 {
                    errors.push(format!("AVL height/balance violation at {hash}"));
                }
                let min = left_info.1.unwrap_or_else(|| key.clone());
                let max = right_info.2.unwrap_or_else(|| key.clone());
                (expected_height, Some(min), Some(max))
            }
        };
        active.remove(hash);
        cached.insert(hash.to_string(), result.clone());
        Ok(result)
    }

    pub(super) fn deep_relationship_errors(&self) -> Result<Vec<String>, KernelError> {
        let mut errors = Vec::new();
        let mut cached = HashMap::new();
        let mut validate_root = |root: &str, errors: &mut Vec<String>| -> Result<(), KernelError> {
            let node = match self.load_node(root) {
                Ok(node) => node,
                Err(error) => {
                    errors.push(format!("{root}: {error}"));
                    return Ok(());
                }
            };
            if !matches!(node, TrieNode::Path { .. }) {
                errors.push(format!("root is not a path node: {root}"));
            }
            let mut active = BTreeSet::new();
            if let Err(error) =
                self.validate_node_integrity(root, None, None, &mut active, &mut cached, errors)
            {
                errors.push(format!("{root}: {error}"));
            }
            Ok(())
        };
        let mut branches = self.conn.prepare(
            "SELECT branch_id, workspace_id, base_root, head_root, head_revision, parent_ref, draft_base_paths_json, capture_scopes_json FROM branches",
        )?;
        for row in branches.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })? {
            let (
                branch_id,
                _workspace,
                base_root,
                head_root,
                head_revision,
                parent_ref,
                draft_base_paths_json,
                capture_scopes_json,
            ) = row?;
            if parent_ref.as_deref().is_some_and(str::is_empty) {
                errors.push(format!("branch parent identity is empty: {branch_id}"));
            }
            for (label, raw) in [
                ("draftBasePaths", draft_base_paths_json),
                ("captureScopes", capture_scopes_json),
            ] {
                match serde_json::from_str::<Vec<String>>(&raw) {
                    Ok(paths) => {
                        let mut canonical = Vec::with_capacity(paths.len());
                        for path in &paths {
                            match Self::validate_path(path) {
                                Ok(segments) => canonical.push(segments.join("/")),
                                Err(error) => errors.push(format!(
                                    "branch {label} contains an invalid path ({branch_id}/{path}): {error}"
                                )),
                            }
                        }
                        canonical.sort();
                        canonical.dedup();
                        if canonical != paths {
                            errors.push(format!(
                                "branch {label} is not canonical and unique: {branch_id}"
                            ));
                        }
                    }
                    Err(error) => errors.push(format!(
                        "branch {label} metadata is corrupt ({branch_id}): {error}"
                    )),
                }
            }
            if self
                .conn
                .query_row(
                    "SELECT 1 FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                    params![branch_id, head_revision],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_none()
            {
                errors.push(format!("branch published revision is missing: {branch_id}"));
            }
            if let Err(error) = validate_root(&head_root, &mut errors) {
                errors.push(format!("{branch_id}: {error}"));
            }
            if let Err(error) = validate_root(&base_root, &mut errors) {
                errors.push(format!("{branch_id} base: {error}"));
            }
        }
        let mut pins = self.conn.prepare(
            "SELECT p.pin_id, p.branch_id, p.workspace_id, p.revision, p.write_revision, p.root_hash, b.workspace_id, b.head_root, b.write_revision FROM pins p LEFT JOIN branches b ON b.branch_id = p.branch_id",
        )?;
        for row in pins.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i64>>(8)?,
            ))
        })? {
            let (
                pin_id,
                branch_id,
                workspace,
                revision,
                write_revision,
                root,
                branch_workspace,
                branch_head_root,
                branch_write_revision,
            ) = row?;
            let branch_identity_invalid = branch_workspace
                .as_deref()
                .is_some_and(|branch_workspace| branch_workspace != workspace);
            let pin_target_invalid = if branch_workspace.is_none() {
                false
            } else if write_revision >= 0 {
                branch_head_root.as_deref() != Some(root.as_str())
                    || branch_write_revision != Some(write_revision)
            } else {
                let revision_root = self
                    .conn
                    .query_row(
                        "SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                        params![branch_id, revision],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                revision_root.as_deref() != Some(root.as_str())
            };
            if branch_identity_invalid || pin_target_invalid {
                errors.push(format!("pin identity is inconsistent: {pin_id}"));
            }
            if let Err(error) = validate_root(&root, &mut errors) {
                errors.push(format!("pin {pin_id}: {error}"));
            }
        }
        let mut owners = self
            .conn
            .prepare("SELECT owner_id, blob_hash FROM object_owners")?;
        for row in owners.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (owner_id, hash) = row?;
            let blob = self
                .conn
                .query_row(
                    "SELECT byte_length FROM blobs WHERE hash = ?1",
                    params![hash],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if blob.is_none() {
                errors.push(format!("owner points to missing blob: {owner_id}"));
            }
        }
        let mut pending = self.conn.prepare(
            "SELECT hash, path FROM pending_gc_files WHERE state IN ('pending', 'failed')",
        )?;
        for row in pending.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (hash, raw_path) = row?;
            match object_path(&self.root, &hash) {
                Ok(derived)
                    if derived.starts_with(self.root.join("objects"))
                        && Path::new(&raw_path) == derived => {}
                Ok(_) | Err(_) => {
                    errors.push(format!(
                        "pending cleanup path is outside derived object path: {hash}"
                    ));
                }
            }
        }
        Ok(errors)
    }

    pub(super) fn health(&self, params: &Value) -> Result<Value, KernelError> {
        let integrity: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        let branches: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM branches", [], |row| row.get(0))?;
        let nodes: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM trie_nodes", [], |row| row.get(0))?;
        let blobs: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM blobs", [], |row| row.get(0))?;
        let (pending_cleanup, cleanup_failures) = self.cleanup_status()?;
        let node_json_bytes: i64 = self.conn.query_row("SELECT COALESCE(SUM(length(CAST(children_json AS BLOB)) + COALESCE(length(CAST(state_json AS BLOB)), 0)), 0) FROM trie_nodes", [], |row| row.get(0))?;
        let operations: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))?;
        let temporary_object_owners: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM object_owners", [], |row| row.get(0))?;
        let catalog_path = self.root.join("catalog.sqlite");
        let catalog_bytes = fs::metadata(&catalog_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let wal_bytes = fs::metadata(self.root.join("catalog.sqlite-wal"))
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if !params.get("deep").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(
                json!({"integrity": integrity, "branches": branches, "nodes": nodes, "nodeJsonBytes": node_json_bytes, "catalogBytes": catalog_bytes, "walBytes": wal_bytes, "operations": operations, "temporaryObjectOwners": temporary_object_owners, "blobs": blobs, "storageRoot": self.root, "pendingCleanup": pending_cleanup, "cleanupFailures": cleanup_failures, "deep": false}),
            );
        }
        let mut roots = BTreeSet::new();
        for row in self
            .conn
            .prepare("SELECT base_root, head_root FROM branches")?
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
        {
            let (base, head) = row?;
            roots.insert(base);
            roots.insert(head);
        }
        for row in self
            .conn
            .prepare("SELECT root_hash FROM revisions UNION SELECT root_hash FROM pins UNION SELECT json_extract(payload_json,'$.root') FROM domain_records WHERE record_type='working.result' UNION SELECT json_extract(payload_json,'$.baseRoot') FROM domain_records WHERE record_type='working.result'")?
            .query_map([], |row| row.get::<_, String>(0))?
        {
            roots.insert(row?);
        }
        let mut reachable_nodes = BTreeSet::new();
        let mut reachable_blobs = BTreeSet::new();
        let mut missing_nodes = Vec::new();
        for root in roots {
            if let Err(error) =
                self.collect_reachable(&root, &mut reachable_nodes, &mut reachable_blobs)
            {
                missing_nodes.push(format!("{root}: {error}"));
            }
        }
        let mut missing_objects = Vec::new();
        let mut corrupt_objects = Vec::new();
        for hash in reachable_blobs {
            let recorded: Option<i64> = self
                .conn
                .query_row(
                    "SELECT byte_length FROM blobs WHERE hash = ?1",
                    params![hash],
                    |row| row.get(0),
                )
                .optional()?;
            match (recorded, hash_file(&object_path(&self.root, &hash)?)) {
                (Some(length), Ok((actual_hash, actual_length)))
                    if i64::try_from(actual_length).ok() == Some(length) && actual_hash == hash => {
                }
                (None, _) => missing_objects.push(hash),
                (Some(_), Err(_)) => missing_objects.push(hash),
                _ => corrupt_objects.push(hash),
            }
        }
        let relationship_errors = self.deep_relationship_errors()?;
        let status = if integrity == "ok"
            && missing_nodes.is_empty()
            && missing_objects.is_empty()
            && corrupt_objects.is_empty()
            && relationship_errors.is_empty()
            && cleanup_failures.is_empty()
        {
            "ok"
        } else {
            "degraded"
        };
        Ok(
            json!({"integrity": status, "sqliteIntegrity": integrity, "branches": branches, "nodes": nodes, "nodeJsonBytes": node_json_bytes, "catalogBytes": catalog_bytes, "walBytes": wal_bytes, "operations": operations, "temporaryObjectOwners": temporary_object_owners, "blobs": blobs, "storageRoot": self.root, "pendingCleanup": pending_cleanup, "cleanupFailures": cleanup_failures, "deep": true, "missingNodes": missing_nodes, "missingObjects": missing_objects, "corruptObjects": corrupt_objects, "relationshipErrors": relationship_errors}),
        )
    }
}
