//! Immutable path trees and their persistent AVL child indexes.
use super::*;

impl Storage {
    pub(super) fn load_node(&self, hash: &str) -> Result<TrieNode, KernelError> {
        let encoded: Option<String> = self
            .conn
            .query_row(
                "SELECT children_json, state_json FROM trie_nodes WHERE hash = ?1",
                params![hash],
                |row| row.get(0),
            )
            .optional()?;
        let encoded =
            encoded.ok_or_else(|| KernelError::Storage(format!("missing trie node {hash}")))?;
        let node: TrieNode = serde_json::from_str(&encoded)?;
        if node_hash(&node) != hash {
            return Err(KernelError::Storage(format!("corrupt trie node {hash}")));
        }
        Ok(node)
    }

    pub(super) fn store_node(&mut self, node: &TrieNode) -> Result<String, KernelError> {
        let hash = node_hash(node);
        self.conn.execute(
            "INSERT OR IGNORE INTO trie_nodes(hash, children_json, state_json) VALUES (?1, ?2, ?3)",
            params![hash, serde_json::to_string(node)?, Option::<String>::None],
        )?;
        Ok(hash)
    }

    pub(super) fn empty_root(&mut self) -> Result<String, KernelError> {
        self.store_node(&TrieNode::Path {
            state: None,
            children: None,
        })
    }

    pub(super) fn root_entries(&self, root: &str) -> Result<Vec<(String, PathState)>, KernelError> {
        let mut output = Vec::new();
        self.walk_path_entries(root, "", &mut output)?;
        Ok(output)
    }

    pub(super) fn root_entries_scoped(
        &self,
        root: &str,
        roots: &[String],
    ) -> Result<Vec<(String, PathState)>, KernelError> {
        if roots.is_empty() || roots.iter().any(|value| value.is_empty()) {
            return self.root_entries(root);
        }
        let mut output = Vec::new();
        for requested in roots {
            let segments = Self::validate_path(requested)?;
            if segments.is_empty() {
                return self.root_entries(root);
            }
            if let Some(subtree) = self.find_path_node(root, &segments)? {
                self.walk_path_entries(&subtree, &segments.join("/"), &mut output)?;
            }
        }
        output.sort_by(|left, right| left.0.cmp(&right.0));
        output.dedup_by(|left, right| left.0 == right.0);
        Ok(output)
    }

    pub(super) fn find_path_node(
        &self,
        hash: &str,
        segments: &[String],
    ) -> Result<Option<String>, KernelError> {
        let TrieNode::Path { children, .. } = self.load_node(hash)? else {
            return Err(KernelError::Storage(
                "path root points to an index node".to_string(),
            ));
        };
        if segments.is_empty() {
            return Ok(Some(hash.to_string()));
        }
        let Some(children) = children else {
            return Ok(None);
        };
        let Some(child) = self.find_index_child(&children, &segments[0])? else {
            return Ok(None);
        };
        self.find_path_node(&child, &segments[1..])
    }

    fn find_index_child(&self, hash: &str, key: &str) -> Result<Option<String>, KernelError> {
        let TrieNode::Index {
            key: node_key,
            child,
            left,
            right,
            ..
        } = self.load_node(hash)?
        else {
            return Err(KernelError::Storage(
                "path children point to a path node".to_string(),
            ));
        };
        if key == node_key {
            return Ok(Some(child));
        }
        if key < node_key.as_str() {
            return left
                .map(|value| self.find_index_child(&value, key))
                .transpose()
                .map(|value| value.flatten());
        }
        right
            .map(|value| self.find_index_child(&value, key))
            .transpose()
            .map(|value| value.flatten())
    }

    pub(super) fn walk_path_entries(
        &self,
        hash: &str,
        prefix: &str,
        output: &mut Vec<(String, PathState)>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let TrieNode::Path { state, children } = self.load_node(hash)? else {
            return Err(KernelError::Storage(
                "path root points to an index node".to_string(),
            ));
        };
        if let Some(state) = state {
            output.push((prefix.to_string(), state));
        }
        if let Some(children) = children {
            self.walk_index_entries(&children, prefix, output)?;
        }
        Ok(())
    }

    pub(super) fn walk_index_entries(
        &self,
        hash: &str,
        prefix: &str,
        output: &mut Vec<(String, PathState)>,
    ) -> Result<(), KernelError> {
        self.check_cancelled()?;
        let TrieNode::Index {
            key,
            child,
            left,
            right,
            ..
        } = self.load_node(hash)?
        else {
            return Err(KernelError::Storage(
                "index root points to a path node".to_string(),
            ));
        };
        if let Some(left) = left {
            self.walk_index_entries(&left, prefix, output)?;
        }
        let child_prefix = if prefix.is_empty() {
            key
        } else {
            format!("{prefix}/{key}")
        };
        self.walk_path_entries(&child, &child_prefix, output)?;
        if let Some(right) = right {
            self.walk_index_entries(&right, prefix, output)?;
        }
        Ok(())
    }

    pub(super) fn index_height(&self, hash: Option<&String>) -> Result<i32, KernelError> {
        let Some(hash) = hash else {
            return Ok(0);
        };
        let TrieNode::Index { height, .. } = self.load_node(hash)? else {
            return Err(KernelError::Storage(
                "index height requested for a path node".to_string(),
            ));
        };
        Ok(i32::from(height))
    }

    pub(super) fn make_index(
        &mut self,
        key: String,
        child: String,
        left: Option<String>,
        right: Option<String>,
    ) -> Result<String, KernelError> {
        let height = (self
            .index_height(left.as_ref())?
            .max(self.index_height(right.as_ref())?)
            + 1) as u16;
        self.store_node(&TrieNode::Index {
            key,
            child,
            left,
            right,
            height,
        })
    }

    pub(super) fn index_get(
        &self,
        root: Option<&String>,
        key: &str,
    ) -> Result<Option<String>, KernelError> {
        let Some(root) = root else {
            return Ok(None);
        };
        let TrieNode::Index {
            key: current,
            child,
            left,
            right,
            ..
        } = self.load_node(root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        match key.cmp(&current) {
            std::cmp::Ordering::Equal => Ok(Some(child)),
            std::cmp::Ordering::Less => self.index_get(left.as_ref(), key),
            std::cmp::Ordering::Greater => self.index_get(right.as_ref(), key),
        }
    }

    pub(super) fn rotate_left(&mut self, root: String) -> Result<String, KernelError> {
        let TrieNode::Index {
            key,
            child,
            left,
            right: Some(right),
            ..
        } = self.load_node(&root)?
        else {
            return Ok(root);
        };
        let TrieNode::Index {
            key: right_key,
            child: right_child,
            left: right_left,
            right: right_right,
            ..
        } = self.load_node(&right)?
        else {
            return Err(KernelError::Storage("invalid AVL right child".to_string()));
        };
        let next_left = self.make_index(key, child, left, right_left)?;
        self.make_index(right_key, right_child, Some(next_left), right_right)
    }

    pub(super) fn rotate_right(&mut self, root: String) -> Result<String, KernelError> {
        let TrieNode::Index {
            key,
            child,
            left: Some(left),
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Ok(root);
        };
        let TrieNode::Index {
            key: left_key,
            child: left_child,
            left: left_left,
            right: left_right,
            ..
        } = self.load_node(&left)?
        else {
            return Err(KernelError::Storage("invalid AVL left child".to_string()));
        };
        let next_right = self.make_index(key, child, left_right, right)?;
        self.make_index(left_key, left_child, left_left, Some(next_right))
    }

    pub(super) fn balance_index(&mut self, root: String) -> Result<String, KernelError> {
        let TrieNode::Index {
            key,
            child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Ok(root);
        };
        let balance = self.index_height(left.as_ref())? - self.index_height(right.as_ref())?;
        if balance > 1 {
            let left_hash = left.as_ref().expect("balance implies left child");
            let TrieNode::Index {
                left: left_left,
                right: left_right,
                ..
            } = self.load_node(left_hash)?
            else {
                return Err(KernelError::Storage("invalid AVL left node".to_string()));
            };
            let left_balance =
                self.index_height(left_left.as_ref())? - self.index_height(left_right.as_ref())?;
            if left_balance < 0 {
                let rotated = self.rotate_left(left_hash.clone())?;
                let rebuilt = self.make_index(key, child, Some(rotated), right)?;
                return self.rotate_right(rebuilt);
            }
            return self.rotate_right(root);
        }
        if balance < -1 {
            let right_hash = right.as_ref().expect("balance implies right child");
            let TrieNode::Index {
                left: right_left,
                right: right_right,
                ..
            } = self.load_node(right_hash)?
            else {
                return Err(KernelError::Storage("invalid AVL right node".to_string()));
            };
            let right_balance = self.index_height(right_left.as_ref())?
                - self.index_height(right_right.as_ref())?;
            if right_balance > 0 {
                let rotated = self.rotate_right(right_hash.clone())?;
                let rebuilt = self.make_index(key, child, left, Some(rotated))?;
                return self.rotate_left(rebuilt);
            }
            return self.rotate_left(root);
        }
        Ok(root)
    }

    pub(super) fn index_set(
        &mut self,
        root: Option<String>,
        key: String,
        child: String,
    ) -> Result<String, KernelError> {
        self.check_cancelled()?;
        let Some(root) = root else {
            return self.make_index(key, child, None, None);
        };
        let TrieNode::Index {
            key: current,
            child: current_child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        let next = match key.cmp(&current) {
            std::cmp::Ordering::Equal => self.make_index(current, child, left, right)?,
            std::cmp::Ordering::Less => {
                let next_left = self.index_set(left, key, child)?;
                self.make_index(current, current_child, Some(next_left), right)?
            }
            std::cmp::Ordering::Greater => {
                let next_right = self.index_set(right, key, child)?;
                self.make_index(current, current_child, left, Some(next_right))?
            }
        };
        self.balance_index(next)
    }

    pub(super) fn index_remove_min(
        &mut self,
        root: String,
    ) -> Result<(String, String, Option<String>), KernelError> {
        let TrieNode::Index {
            key,
            child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        let Some(left_root) = left else {
            return Ok((key, child, right));
        };
        let (minimum_key, minimum_child, next_left) = self.index_remove_min(left_root)?;
        let rebuilt = self.make_index(key, child, next_left, right)?;
        Ok((
            minimum_key,
            minimum_child,
            Some(self.balance_index(rebuilt)?),
        ))
    }

    pub(super) fn index_remove(
        &mut self,
        root: Option<String>,
        key: &str,
    ) -> Result<Option<String>, KernelError> {
        self.check_cancelled()?;
        let Some(root) = root else {
            return Ok(None);
        };
        let TrieNode::Index {
            key: current,
            child,
            left,
            right,
            ..
        } = self.load_node(&root)?
        else {
            return Err(KernelError::Storage("path node used as index".to_string()));
        };
        match key.cmp(current.as_str()) {
            std::cmp::Ordering::Less => {
                let next_left = self.index_remove(left, key)?;
                let rebuilt = self.make_index(current, child, next_left, right)?;
                Ok(Some(self.balance_index(rebuilt)?))
            }
            std::cmp::Ordering::Greater => {
                let next_right = self.index_remove(right, key)?;
                let rebuilt = self.make_index(current, child, left, next_right)?;
                Ok(Some(self.balance_index(rebuilt)?))
            }
            std::cmp::Ordering::Equal => match (left, right) {
                (None, next) | (next, None) => Ok(next),
                (Some(left), Some(right)) => {
                    let (successor_key, successor_child, next_right) =
                        self.index_remove_min(right)?;
                    let rebuilt =
                        self.make_index(successor_key, successor_child, Some(left), next_right)?;
                    Ok(Some(self.balance_index(rebuilt)?))
                }
            },
        }
    }

    pub(super) fn root_set(
        &mut self,
        root: &str,
        segments: &[&str],
        state: PathState,
    ) -> Result<String, KernelError> {
        self.check_cancelled()?;
        let TrieNode::Path {
            state: current_state,
            children,
        } = self.load_node(root)?
        else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        if segments.is_empty() {
            let children = if state.is_directory() { children } else { None };
            return self.store_node(&TrieNode::Path {
                state: Some(state),
                children,
            });
        }
        if current_state
            .as_ref()
            .is_some_and(|state| !state.is_directory())
        {
            return Err(KernelError::Operation(
                "a non-directory path cannot have descendants".to_string(),
            ));
        }
        let name = segments[0].to_string();
        let child_root = self
            .index_get(children.as_ref(), &name)?
            .unwrap_or(self.empty_root()?);
        let child = self.root_set(&child_root, &segments[1..], state)?;
        let next_index = self.index_set(children, name, child)?;
        self.store_node(&TrieNode::Path {
            state: current_state,
            children: Some(next_index),
        })
    }

    pub(super) fn root_restore_from_base(
        &mut self,
        current_root: &str,
        base_root: &str,
        segments: &[&str],
    ) -> Result<String, KernelError> {
        if segments.is_empty() {
            return Ok(base_root.to_string());
        }
        let TrieNode::Path {
            state: current_state,
            children: current_children,
        } = self.load_node(current_root)?
        else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        if current_state
            .as_ref()
            .is_some_and(|state| !state.is_directory())
        {
            return Err(KernelError::Operation(
                "a non-directory path cannot have descendants".to_string(),
            ));
        }
        let TrieNode::Path {
            children: base_children,
            ..
        } = self.load_node(base_root)?
        else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        let name = segments[0].as_ref();
        let current_child = self
            .index_get(current_children.as_ref(), name)?
            .unwrap_or(self.empty_root()?);
        let base_child = self.index_get(base_children.as_ref(), name)?;
        let next_children = if segments.len() == 1 {
            match base_child {
                Some(base_child) => {
                    self.index_set(current_children, name.to_string(), base_child)?
                }
                None => self
                    .index_remove(current_children, name)?
                    .unwrap_or_else(String::new),
            }
        } else {
            let empty = self.empty_root()?;
            let restored = self.root_restore_from_base(
                &current_child,
                base_child.as_deref().unwrap_or(&empty),
                &segments[1..],
            )?;
            if base_child.is_none() && restored == empty {
                self.index_remove(current_children, name)?
                    .unwrap_or_else(String::new)
            } else {
                self.index_set(current_children, name.to_string(), restored)?
            }
        };
        self.store_node(&TrieNode::Path {
            state: current_state,
            children: (!next_children.is_empty()).then_some(next_children),
        })
    }

    pub(super) fn build_tree(
        entries: &[(Vec<String>, PathState)],
    ) -> Result<BuildTree, KernelError> {
        let mut root = BuildTree::default();
        for (segments, state) in entries {
            let mut current = &mut root;
            for segment in segments {
                current = current.children.entry(segment.clone()).or_default();
            }
            if current.state.is_some() {
                return Err(KernelError::Operation(
                    "duplicate normalized path".to_string(),
                ));
            }
            current.state = Some(state.clone());
        }
        Ok(root)
    }

    pub(super) fn build_index_balanced(
        &mut self,
        items: &[(String, String)],
        start: usize,
        end: usize,
    ) -> Result<Option<String>, KernelError> {
        if start >= end {
            return Ok(None);
        }
        let middle = start + (end - start) / 2;
        let left = self.build_index_balanced(items, start, middle)?;
        let right = self.build_index_balanced(items, middle + 1, end)?;
        Ok(Some(self.make_index(
            items[middle].0.clone(),
            items[middle].1.clone(),
            left,
            right,
        )?))
    }

    pub(super) fn build_path_tree(&mut self, tree: BuildTree) -> Result<String, KernelError> {
        self.check_cancelled()?;
        let mut child_items = Vec::with_capacity(tree.children.len());
        for (key, child) in tree.children {
            self.check_cancelled()?;
            child_items.push((key, self.build_path_tree(child)?));
        }
        let index = self.build_index_balanced(&child_items, 0, child_items.len())?;
        self.store_node(&TrieNode::Path {
            state: tree.state,
            children: index,
        })
    }

    pub(super) fn build_root(
        &mut self,
        entries: &[(Vec<String>, PathState)],
    ) -> Result<String, KernelError> {
        self.check_cancelled()?;
        self.build_path_tree(Self::build_tree(entries)?)
    }

    pub(super) fn root_get(
        &self,
        root: &str,
        path: &str,
    ) -> Result<Option<PathState>, KernelError> {
        let mut hash = root.to_string();
        for segment in path.split('/').filter(|segment| !segment.is_empty()) {
            let TrieNode::Path { children, .. } = self.load_node(&hash)? else {
                return Err(KernelError::Storage("index node used as path".to_string()));
            };
            let Some(child) = self.index_get(children.as_ref(), segment)? else {
                return Ok(None);
            };
            hash = child;
        }
        let TrieNode::Path { state, .. } = self.load_node(&hash)? else {
            return Err(KernelError::Storage("index node used as path".to_string()));
        };
        Ok(state)
    }

    pub(super) fn branch(&self, branch_id: &str) -> Result<BranchRow, KernelError> {
        self.conn.query_row(
            "SELECT workspace_id, base_root, head_root, head_revision, write_revision, parent_ref, draft_base_paths_json, capture_scopes_json, created_at, updated_at FROM branches WHERE branch_id = ?1",
            params![branch_id],
            |row| {
                let draft_base_paths_json: String = row.get(6)?;
                let capture_scopes_json: String = row.get(7)?;
                let draft_base_paths = serde_json::from_str(&draft_base_paths_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error))
                })?;
                let capture_scopes = serde_json::from_str(&capture_scopes_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error))
                })?;
                Ok(BranchRow {
                    workspace_id: row.get(0)?,
                    base_root: row.get(1)?,
                    head_root: row.get(2)?,
                    head_revision: row.get(3)?,
                    write_revision: row.get(4)?,
                    parent_ref: row.get(5)?,
                    draft_base_paths,
                    capture_scopes,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        ).map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => KernelError::Operation(format!("branch not found: {branch_id}")), other => other.into() })
    }

    pub(super) fn root_owned_by_workspace(
        &self,
        root: &str,
        workspace_id: &str,
    ) -> Result<bool, KernelError> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM branches WHERE workspace_id = ?2 AND (base_root = ?1 OR head_root = ?1) UNION SELECT 1 FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE b.workspace_id = ?2 AND r.root_hash = ?1 UNION SELECT 1 FROM pins WHERE workspace_id = ?2 AND root_hash = ?1 LIMIT 1",
                params![root, workspace_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    pub(super) fn root_workspace(&self, root: &str) -> Result<Option<String>, KernelError> {
        self.conn
            .query_row(
                "SELECT workspace_id FROM branches WHERE base_root = ?1 OR head_root = ?1 UNION SELECT b.workspace_id FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE r.root_hash = ?1 UNION SELECT workspace_id FROM pins WHERE root_hash = ?1 LIMIT 1",
                params![root],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub(super) fn resolve_base_ref(
        &self,
        base_ref: &str,
        workspace_id: &str,
    ) -> Result<String, KernelError> {
        let root = if base_ref.starts_with("sha256-") {
            base_ref.to_string()
        } else if let Some(pin_id) = base_ref.strip_prefix("pin:") {
            self.conn
                .query_row(
                    "SELECT root_hash FROM pins WHERE pin_id = ?1 AND workspace_id = ?2",
                    params![pin_id, workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => KernelError::Authorization(
                        "baseRef pin is not owned by workspace".to_string(),
                    ),
                    other => other.into(),
                })?
        } else if let Some((branch_id, revision)) = base_ref.split_once('@') {
            let revision = revision
                .parse::<i64>()
                .map_err(|_| KernelError::Operation("baseRef revision is malformed".to_string()))?;
            self.conn
                .query_row(
                    "SELECT r.root_hash FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE r.branch_id = ?1 AND r.revision = ?2 AND b.workspace_id = ?3",
                    params![branch_id, revision, workspace_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => {
                        KernelError::Authorization("baseRef revision is not owned by workspace".to_string())
                    }
                    other => other.into(),
                })?
        } else {
            return Err(KernelError::Operation(
                "baseRef must be a root hash, pin:<pinId>, or branchId@revision".to_string(),
            ));
        };
        if !self.root_owned_by_workspace(&root, workspace_id)? {
            return Err(KernelError::Authorization(
                "baseRef root is not owned by workspace".to_string(),
            ));
        }
        self.load_node(&root)?;
        Ok(root)
    }

    pub(super) fn validate_path(path: &str) -> Result<Vec<String>, KernelError> {
        if path.is_empty()
            || path.contains('\0')
            || path.starts_with('/')
            || path.starts_with('\\')
            || path.contains(':')
        {
            return Err(KernelError::Authorization(format!(
                "invalid relative path: {path}"
            )));
        }
        let normalized = path.replace('\\', "/");
        let parts: Vec<String> = normalized
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .map(str::to_string)
            .collect();
        if parts.is_empty()
            || parts
                .iter()
                .any(|part| *part == ".." || part.contains('\0'))
        {
            return Err(KernelError::Authorization(format!(
                "invalid relative path: {path}"
            )));
        }
        Ok(parts)
    }

    pub(super) fn parse_state(&self, state: &Value) -> Result<PathState, KernelError> {
        let parsed: PathState = serde_json::from_value(state.clone())
            .map_err(|error| KernelError::Operation(format!("invalid path state: {error}")))?;
        if let PathState::RegularFile { object_hash, .. } = &parsed {
            if !object_hash.starts_with("sha256-")
                || object_hash.len() != 71
                || !object_hash[7..].chars().all(|c| c.is_ascii_hexdigit())
            {
                return Err(KernelError::Operation(
                    "regular-file.objectHash is malformed".to_string(),
                ));
            }
        }
        Ok(parsed)
    }

    pub(super) fn validate_blob_metadata(&self, state: &PathState) -> Result<(), KernelError> {
        let PathState::RegularFile {
            object_hash,
            byte_length,
            ..
        } = state
        else {
            return Ok(());
        };
        let recorded: Option<i64> = self
            .conn
            .query_row(
                "SELECT byte_length FROM blobs WHERE hash = ?1",
                params![object_hash],
                |row| row.get(0),
            )
            .optional()?;
        if recorded
            != Some(i64::try_from(*byte_length).map_err(|_| {
                KernelError::Operation("regular-file.byteLength is too large".to_string())
            })?)
        {
            return Err(KernelError::Storage(format!(
                "content object is not durable: {object_hash}"
            )));
        }
        Ok(())
    }
}

/// Read and validate an immutable tree on a service worker; retained roots own its lifetime.
pub(super) fn read_immutable_tree_entries(database: &Path, root: &str, cancellation: &AtomicBool) -> Result<Vec<(String,PathState)>,KernelError> {
        let conn = Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let mut pending = vec![(root.to_string(), String::new(), true)];
        let mut entries = Vec::new();
        while let Some((hash, prefix, path_node)) = pending.pop() {
            if cancellation.load(Ordering::Acquire) { return Err(KernelError::Cancelled); }
            let encoded: String = conn.query_row(
                "SELECT children_json FROM trie_nodes WHERE hash=?1",
                [&hash],
                |row| row.get(0),
            )?;
            let node: TrieNode = serde_json::from_str(&encoded)?;
            if node_hash(&node) != hash {
                return Err(KernelError::Storage(format!("corrupt trie node {hash}")));
            }
            match node {
                TrieNode::Path { state, children } if path_node => {
                    if let Some(state) = state {
                        entries.push((prefix.clone(), state));
                    }
                    if let Some(children) = children {
                        pending.push((children, prefix, false));
                    }
                }
                TrieNode::Index {
                    key,
                    child,
                    left,
                    right,
                    ..
                } if !path_node => {
                    if let Some(right) = right {
                        pending.push((right, prefix.clone(), false));
                    }
                    let path = if prefix.is_empty() {
                        key
                    } else {
                        format!("{prefix}/{key}")
                    };
                    Storage::validate_path(&path)?;
                    pending.push((child, path, true));
                    if let Some(left) = left {
                        pending.push((left, prefix, false));
                    }
                }
                _ => {
                    return Err(KernelError::Storage(
                        "materialization source tree has an invalid node type".into(),
                    ))
                }
            }
        }
        entries.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(entries)
}
