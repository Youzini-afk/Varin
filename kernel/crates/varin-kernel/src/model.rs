use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum PathState {
    #[serde(rename = "regular-file")]
    RegularFile {
        #[serde(rename = "objectHash")]
        object_hash: String,
        #[serde(rename = "byteLength")]
        byte_length: u64,
        mode: u32,
    },
    Directory {
        mode: Option<u32>,
    },
    Symlink {
        #[serde(rename = "symlinkTarget")]
        symlink_target: String,
        mode: Option<u32>,
    },
    Missing,
    Unsupported,
}

impl PathState {
    pub(crate) fn is_directory(&self) -> bool {
        matches!(self, Self::Directory { .. })
    }
    pub(crate) fn object_hash(&self) -> Option<&str> {
        match self {
            Self::RegularFile { object_hash, .. } => Some(object_hash),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "node", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum TrieNode {
    Path {
        state: Option<PathState>,
        children: Option<String>,
    },
    Index {
        key: String,
        child: String,
        left: Option<String>,
        right: Option<String>,
        height: u16,
    },
}

#[derive(Default)]
pub(crate) struct BuildTree {
    pub(crate) state: Option<PathState>,
    pub(crate) children: BTreeMap<String, BuildTree>,
}

#[derive(Clone, Debug)]
pub(crate) struct BranchRow {
    pub(crate) workspace_id: String,
    pub(crate) base_root: String,
    pub(crate) head_root: String,
    pub(crate) head_revision: i64,
    pub(crate) write_revision: i64,
    pub(crate) parent_ref: Option<String>,
    pub(crate) draft_base_paths: Vec<String>,
    pub(crate) capture_scopes: Vec<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Grant {
    pub(crate) grant_id: String,
    pub(crate) host_id: String,
    pub(crate) host_generation: String,
    pub(crate) authority_instance_id: Option<String>,
    pub(crate) worker_id: Option<String>,
    pub(crate) worker_generation: Option<u64>,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) owning_workspace: Option<String>,
    pub(crate) execution_workspace: Option<String>,
    pub(crate) storage_identity: String,
    pub(crate) capabilities: BTreeSet<String>,
    pub(crate) path_scopes: Vec<String>,
    pub(crate) kernel_epoch: String,
    pub(crate) revoked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) handoff_operation_id: Option<String>,
}

pub(crate) struct BlobStream {
    pub(crate) operation_id: String,
    pub(crate) expected_length: u64,
    pub(crate) received: u64,
    pub(crate) next_sequence: u64,
    pub(crate) expected_hash: Option<String>,
    pub(crate) staging: PathBuf,
    pub(crate) grant_id: String,
    pub(crate) workspace_id: Option<String>,
}

pub(crate) struct BranchBuilder {
    pub(crate) source_provenance: Option<Value>,
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) workspace_id: String,
    pub(crate) base_ref: Option<String>,
    pub(crate) parent_ref: Option<String>,
    pub(crate) draft_base_paths: Vec<String>,
    pub(crate) capture_scopes: Vec<String>,
    pub(crate) next_sequence: u64,
    pub(crate) entries: Vec<Value>,
    pub(crate) grant_id: String,
}

pub(crate) struct BranchWriteBuilder {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_write_revision: i64,
    pub(crate) workspace_id: String,
    pub(crate) next_sequence: u64,
    pub(crate) changes: Vec<Value>,
    pub(crate) grant_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct FileRoot {
    pub(crate) root_id: String,
    pub(crate) owning_workspace_id: String,
    pub(crate) execution_workspace_id: String,
    pub(crate) canonical_root: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FileLeaseResource {
    pub(crate) path: String,
    pub(crate) subtree: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanonicalFileLeaseResource {
    pub(crate) absolute: PathBuf,
    pub(crate) subtree: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct FileLease {
    pub(crate) lease_id: String,
    pub(crate) root_id: String,
    pub(crate) workspace_id: String,
    pub(crate) grant_id: String,
    pub(crate) resources: Vec<FileLeaseResource>,
    pub(crate) canonical_resources: Vec<CanonicalFileLeaseResource>,
}
