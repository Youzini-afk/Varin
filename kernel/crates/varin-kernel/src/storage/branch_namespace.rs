//! Path-level transactions over the same immutable branch tree. These operations
//! never open a live project directory or create a physical execution view.
use super::*;
use crate::protocol_generated::{
    KernelBranchForkParams, KernelBranchPathApplyParams, KernelBranchPathInspectParams,
    KernelBranchRenameParams,
};

struct NodeObservation {
    node: Option<String>,
    state: PathState,
}

fn namespace_error(code: &str, message: &str, path: &str) -> KernelError {
    KernelError::Execution(
        varin_runtime::execution::ExecutionError::new(code, message)
            .with_details(json!({"domain":"workspace_namespace","path":path})),
    )
}

impl Storage {
    fn observe_branch_node(&self, root: &str, path: &str) -> Result<NodeObservation, KernelError> {
        let segments = if path.is_empty() {
            vec![]
        } else {
            Self::validate_path(path)?
        };
        let Some(node) = self.find_path_node(root, &segments)? else {
            return Ok(NodeObservation {
                node: None,
                state: PathState::Missing,
            });
        };
        let TrieNode::Path { state, .. } = self.load_node(&node)? else {
            return Err(KernelError::Storage(
                "a namespace path points to an index".into(),
            ));
        };
        // An implicit ancestor is a real directory in a filesystem view, even
        // when the imported tree has no explicit directory metadata for it.
        let state = state.unwrap_or(PathState::Directory { mode: None });
        Ok(NodeObservation {
            node: (!matches!(state, PathState::Missing)).then_some(node),
            state,
        })
    }

    pub(super) fn branch_path_inspect(&self, params: &Value) -> Result<Value, KernelError> {
        let input: KernelBranchPathInspectParams =
            super::file_resources::parse_file_params(params)?;
        let branch = self.branch(&input.branch_id)?;
        let root = if let Some(revision) = input.revision {
            self.resolve_base_ref(
                &format!("{}@{revision}", input.branch_id),
                &branch.workspace_id,
            )?
        } else {
            branch.head_root.clone()
        };
        let path = if input.path.is_empty() {
            String::new()
        } else {
            Self::validate_path(&input.path)?.join("/")
        };
        let observed = self.observe_branch_node(&root, &path)?;
        Ok(json!({"branchId":input.branch_id,"path":path,"root":root,
            "node":observed.node,"state":observed.state,"writeRevision":if input.revision.is_some(){None}else{Some(branch.write_revision)},
            "revision":input.revision}))
    }

    pub(super) fn branch_path_apply(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let input: KernelBranchPathApplyParams = super::file_resources::parse_file_params(params)?;
        let branch = self.branch(&input.branch_id)?;
        if input
            .expected_write_revision
            .is_some_and(|expected| expected != branch.write_revision)
        {
            return Ok(
                json!({"status":"conflict","root":branch.head_root,"writeRevision":branch.write_revision}),
            );
        }
        let mut changes = Vec::with_capacity(input.changes.len());
        for change in params["changes"].as_array().expect("typed changes") {
            self.check_cancelled()?;
            let mut change = change.clone();
            let path = Self::validate_path(change["path"].as_str().expect("typed path"))?.join("/");
            let expected = self.parse_state(&change["expectedState"])?;
            let target = self.parse_state(&change["state"])?;
            let observed = self.observe_branch_node(&branch.head_root, &path)?;
            let node = change["expectedNode"].as_str();
            if expected.is_directory()
                && !target.is_directory()
                && node.is_none()
                && input.expected_write_revision.is_none()
            {
                return Err(KernelError::Operation("Replacing a directory requires its expectedNode, including the descendants being replaced".into()));
            }
            if observed.state != expected
                || node.is_some_and(|node| observed.node.as_deref() != Some(node))
            {
                return Ok(
                    json!({"status":"conflict","root":branch.head_root,"writeRevision":branch.write_revision,
                    "path":path,"state":observed.state,"node":observed.node}),
                );
            }
            let object = change.as_object_mut().expect("typed change");
            object.remove("expectedState");
            object.remove("expectedNode");
            object.insert("path".into(), json!(path));
            changes.push(change);
        }
        // No intervening branch revision is possible inside this original
        // transaction. Disjoint path writes can omit a whole-root expectation;
        // same-file and subtree preconditions still compare at this boundary.
        self.branch_write(
            &json!({"operationId":input.operation_id,"branchId":input.branch_id,
            "expectedWriteRevision":branch.write_revision,"changes":changes}),
            grant_id,
        )
    }

    /// Replace only an existing directory's selected child links. A subtree is
    /// grafted by identity; moving a directory never enumerates its descendants.
    fn replace_namespace_node(
        &mut self,
        root: &str,
        segments: &[String],
        node: Option<&str>,
        top: bool,
    ) -> Result<String, KernelError> {
        self.check_cancelled()?;
        let TrieNode::Path {
            mut state,
            children,
        } = self.load_node(root)?
        else {
            return Err(KernelError::Storage(
                "a namespace directory points to an index".into(),
            ));
        };
        if state.as_ref().is_some_and(|state| !state.is_directory()) {
            return Err(namespace_error(
                "namespace_not_directory",
                "Rename parent is not a directory",
                &segments.join("/"),
            ));
        }
        let name = &segments[0];
        let replacement = if segments.len() == 1 {
            node.map(str::to_owned)
        } else {
            let child = self.index_get(children.as_ref(), name)?.ok_or_else(|| {
                namespace_error(
                    "namespace_parent_missing",
                    "Rename destination parent does not exist",
                    &segments.join("/"),
                )
            })?;
            Some(self.replace_namespace_node(&child, &segments[1..], node, false)?)
        };
        let next = match replacement {
            Some(child) => Some(self.index_set(children, name.clone(), child)?),
            None => self.index_remove(children, name)?,
        };
        if !top && state.is_none() {
            state = Some(PathState::Directory { mode: None });
        }
        self.store_node(&TrieNode::Path {
            state,
            children: next,
        })
    }

    fn directory_has_entries(&self, node: &str) -> Result<bool, KernelError> {
        let TrieNode::Path { children, .. } = self.load_node(node)? else {
            return Err(KernelError::Storage(
                "a directory points to an index".into(),
            ));
        };
        let mut pending = children.into_iter().collect::<Vec<_>>();
        while let Some(index) = pending.pop() {
            self.check_cancelled()?;
            let TrieNode::Index {
                child, left, right, ..
            } = self.load_node(&index)?
            else {
                return Err(KernelError::Storage(
                    "a directory index points to a path".into(),
                ));
            };
            let TrieNode::Path { state, .. } = self.load_node(&child)? else {
                return Err(KernelError::Storage(
                    "a directory child points to an index".into(),
                ));
            };
            if !matches!(state, Some(PathState::Missing)) {
                return Ok(true);
            }
            pending.extend(left);
            pending.extend(right);
        }
        Ok(false)
    }

    pub(super) fn branch_rename(&mut self, params: &Value) -> Result<Value, KernelError> {
        let input: KernelBranchRenameParams = super::file_resources::parse_file_params(params)?;
        let branch = self.branch(&input.branch_id)?;
        let from = Self::validate_path(&input.source_path)?;
        let to = Self::validate_path(&input.path)?;
        let source_path = from.join("/");
        let target_path = to.join("/");
        let source = self.observe_branch_node(&branch.head_root, &source_path)?;
        let target = self.observe_branch_node(&branch.head_root, &target_path)?;
        if source.node.as_deref() != Some(&input.expected_source_node)
            || target.node != input.expected_target_node.0
        {
            return Ok(
                json!({"status":"conflict","root":branch.head_root,"writeRevision":branch.write_revision,
                "sourceNode":source.node,"targetNode":target.node}),
            );
        }
        if from == to {
            return Ok(
                json!({"status":"committed","root":branch.head_root,"writeRevision":branch.write_revision,"changed":false}),
            );
        }
        if to.starts_with(&from) {
            return Err(namespace_error(
                "namespace_invalid_rename",
                "A directory cannot be moved into its own descendant",
                &target_path,
            ));
        }
        if target.node.is_some() {
            if !input.replace.unwrap_or(false) {
                return Err(namespace_error(
                    "namespace_exists",
                    "Rename target already exists; replacement was not requested",
                    &target_path,
                ));
            }
            if source.state.is_directory() != target.state.is_directory() {
                return Err(namespace_error(
                    "namespace_kind_mismatch",
                    "Rename cannot replace a directory with a file or a file with a directory",
                    &target_path,
                ));
            }
            if target.state.is_directory()
                && self.directory_has_entries(target.node.as_deref().expect("observed target"))?
            {
                return Err(namespace_error(
                    "namespace_not_empty",
                    "Rename target directory is not empty",
                    &target_path,
                ));
            }
        }
        let root = self.replace_namespace_node(&branch.head_root, &from, None, true)?;
        let root = self.replace_namespace_node(&root, &to, source.node.as_deref(), true)?;
        let next = branch
            .write_revision
            .checked_add(1)
            .ok_or_else(|| KernelError::Storage("Branch revision overflow".into()))?;
        self.conn.execute("UPDATE branches SET head_root=?2,write_revision=?3,updated_at=?4 WHERE branch_id=?1 AND write_revision=?5",
            params![input.branch_id, root, next, now_ms(), branch.write_revision])?;
        if self.conn.changes() != 1 {
            return Err(KernelError::Storage(
                "Branch changed inside its namespace transaction".into(),
            ));
        }
        self.record_root_parent(&root, &branch.head_root)?;
        Ok(json!({"status":"committed","root":root,"writeRevision":next,"changed":true}))
    }

    pub(super) fn branch_fork(
        &mut self,
        params: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let input: KernelBranchForkParams = super::file_resources::parse_file_params(params)?;
        if input.branch_id == input.source_branch_id {
            return Err(KernelError::Operation(
                "A fork needs a distinct target branch".into(),
            ));
        }
        let root = if let Some(pin) = &input.source_pin_id {
            let source = self.pin_read(&json!({"pinId":pin,"includeEntries":false}), grant_id)?;
            if source["workspaceId"] != input.workspace_id
                || source["branchId"] != input.source_branch_id
            {
                return Err(KernelError::Authorization(
                    "Fork pin belongs to another branch or workspace".into(),
                ));
            }
            source["root"]
                .as_str()
                .ok_or_else(|| KernelError::Storage("Fork pin has no root".into()))?
                .to_owned()
        } else {
            let source = self.branch(&input.source_branch_id)?;
            if source.workspace_id != input.workspace_id {
                return Err(KernelError::Authorization(
                    "Fork source belongs to another workspace".into(),
                ));
            }
            source.head_root
        };
        let mut creation = json!({"operationId":input.operation_id,"branchId":input.branch_id,
            "workspaceId":input.workspace_id,"baseRef":root,"entries":[],
            "draftBasePaths":input.draft_base_paths,"captureScopes":input.capture_scopes});
        if let Some(parent) = input.parent_ref {
            creation["parentRef"] = json!(parent);
        }
        if input.source_provenance.is_some() {
            creation["sourceProvenance"] = params["sourceProvenance"].clone();
        }
        self.create_branch(&creation, grant_id)
    }
}
