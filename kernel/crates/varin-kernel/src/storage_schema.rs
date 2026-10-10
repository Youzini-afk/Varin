//! SQLite catalog schema owned by the Rust storage authority.
//!
//! The schema is intentionally kept apart from the operation code so format
//! validation and atomic initialization remain one reviewable responsibility.

pub(crate) const CATALOG_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS process_records (process_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, execution_workspace_id TEXT NOT NULL, grant_id TEXT NOT NULL, kernel_epoch TEXT NOT NULL, cwd TEXT NOT NULL, job_name TEXT NOT NULL, params_hash TEXT NOT NULL, status_json TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS process_records_workspace ON process_records(workspace_id);
     CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, byte_length INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS trie_nodes (hash TEXT PRIMARY KEY, children_json TEXT NOT NULL, state_json TEXT);
     CREATE TABLE IF NOT EXISTS branches (branch_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, create_params_hash TEXT NOT NULL, base_root TEXT NOT NULL, head_root TEXT NOT NULL, head_revision INTEGER NOT NULL, write_revision INTEGER NOT NULL, parent_ref TEXT, draft_base_paths_json TEXT NOT NULL, capture_scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS revisions (branch_id TEXT NOT NULL, revision INTEGER NOT NULL, root_hash TEXT NOT NULL, parent_revision INTEGER, operation_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(branch_id, revision));
	     CREATE TABLE IF NOT EXISTS pins (pin_id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL, write_revision INTEGER NOT NULL, root_hash TEXT NOT NULL, grant_id TEXT NOT NULL, ephemeral INTEGER NOT NULL, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS root_blobs (root_hash TEXT NOT NULL, blob_hash TEXT NOT NULL, PRIMARY KEY(root_hash, blob_hash));
     CREATE TABLE IF NOT EXISTS root_parents (root_hash TEXT PRIMARY KEY, parent_root TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS grants (grant_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, grant_json TEXT NOT NULL, params_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','retired','revoked')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, params_hash TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS operation_owners (operation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL);
	     CREATE TABLE IF NOT EXISTS object_owners (owner_id TEXT PRIMARY KEY, blob_hash TEXT NOT NULL, workspace_id TEXT, operation_id TEXT, grant_id TEXT NOT NULL, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS object_owners_blob ON object_owners(blob_hash);
     CREATE INDEX IF NOT EXISTS object_owners_workspace ON object_owners(workspace_id);
     CREATE TABLE IF NOT EXISTS recovery_checkpoints (id TEXT NOT NULL, workspace_id TEXT NOT NULL, sequence INTEGER NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT, session_id TEXT, entry_id TEXT, execution_id TEXT, changed_path_count INTEGER NOT NULL DEFAULT 0, byte_length INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, sequence), UNIQUE(workspace_id, execution_id));
     CREATE TABLE IF NOT EXISTS recovery_turns (execution_id TEXT NOT NULL, workspace_id TEXT NOT NULL, runtime_key TEXT NOT NULL, runtime_generation INTEGER NOT NULL, worker_id TEXT NOT NULL, session_id TEXT NOT NULL, user_entry_id TEXT NOT NULL, assistant_entry_id TEXT, checkpoint_id TEXT NOT NULL, active_writer_scopes_json TEXT NOT NULL, provenance TEXT NOT NULL, status TEXT NOT NULL, observed_resource_ids_json TEXT NOT NULL, unrecorded_resource_ids_json TEXT NOT NULL, failure_json TEXT, started_at TEXT NOT NULL, settled_at TEXT, revision INTEGER NOT NULL, PRIMARY KEY(workspace_id, execution_id), FOREIGN KEY(workspace_id, checkpoint_id) REFERENCES recovery_checkpoints(workspace_id, id) ON DELETE CASCADE);
     CREATE TABLE IF NOT EXISTS recovery_changes (workspace_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, path TEXT NOT NULL, execution_id TEXT NOT NULL, tool_name TEXT NOT NULL, mutation_id TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(workspace_id, checkpoint_id, path), FOREIGN KEY(workspace_id, checkpoint_id) REFERENCES recovery_checkpoints(workspace_id, id) ON DELETE CASCADE);
     CREATE TABLE IF NOT EXISTS recovery_operations (operation_id TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT, thread_id TEXT, run_id TEXT, data_json TEXT NOT NULL, result_json TEXT, failure_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(workspace_id, operation_id));
     CREATE TABLE IF NOT EXISTS recovery_operation_files (workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL, expected_json TEXT, target_json TEXT, safety_json TEXT, phase TEXT NOT NULL, observed_fingerprint TEXT, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, operation_id, path), FOREIGN KEY(workspace_id, operation_id) REFERENCES recovery_operations(workspace_id, operation_id) ON DELETE CASCADE);
     CREATE TABLE IF NOT EXISTS recovery_refs (workspace_id TEXT NOT NULL, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, slot TEXT NOT NULL, object_hash TEXT NOT NULL, PRIMARY KEY(workspace_id, owner_kind, owner_id, slot));
	     CREATE TABLE IF NOT EXISTS domain_records (record_id TEXT NOT NULL, workspace_id TEXT NOT NULL, record_type TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT, thread_id TEXT, run_id TEXT, branch_id TEXT, revision INTEGER, result_revision INTEGER, record_revision INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(workspace_id, record_id));
     CREATE TABLE IF NOT EXISTS domain_record_refs (workspace_id TEXT NOT NULL, record_id TEXT NOT NULL, slot TEXT NOT NULL, object_hash TEXT NOT NULL, PRIMARY KEY(workspace_id, record_id, slot), FOREIGN KEY(workspace_id, record_id) REFERENCES domain_records(workspace_id, record_id) ON DELETE CASCADE);
     CREATE TABLE IF NOT EXISTS pending_gc_files (hash TEXT PRIMARY KEY, path TEXT NOT NULL, state TEXT NOT NULL, last_error TEXT, queued_at INTEGER NOT NULL, cleaned_at INTEGER);
     CREATE INDEX IF NOT EXISTS revisions_root ON revisions(root_hash);
     CREATE INDEX IF NOT EXISTS pins_root ON pins(root_hash);
     CREATE INDEX IF NOT EXISTS root_blobs_blob ON root_blobs(blob_hash);
     CREATE INDEX IF NOT EXISTS recovery_checkpoints_workspace ON recovery_checkpoints(workspace_id, sequence DESC);
     CREATE INDEX IF NOT EXISTS recovery_turns_workspace ON recovery_turns(workspace_id, started_at DESC);
     CREATE INDEX IF NOT EXISTS recovery_changes_checkpoint ON recovery_changes(workspace_id, checkpoint_id, path);
     CREATE INDEX IF NOT EXISTS recovery_operations_workspace ON recovery_operations(workspace_id, created_at DESC);
     CREATE INDEX IF NOT EXISTS recovery_operation_files_operation ON recovery_operation_files(workspace_id, operation_id, ordinal);
     CREATE INDEX IF NOT EXISTS recovery_refs_hash ON recovery_refs(object_hash);
     CREATE INDEX IF NOT EXISTS domain_records_workspace ON domain_records(workspace_id, record_type, updated_at DESC);
     CREATE INDEX IF NOT EXISTS domain_records_thread ON domain_records(workspace_id, thread_id, record_type);
     CREATE INDEX IF NOT EXISTS domain_record_refs_hash ON domain_record_refs(object_hash);";

pub(crate) const CATALOG_USER_VERSION: i64 = 11;

pub(crate) const REQUIRED_TABLES: &[&str] = &[
    "blobs",
    "branches",
    "domain_record_refs",
    "domain_records",
    "grants",
    "metadata",
    "object_owners",
    "operation_owners",
    "operations",
    "pending_gc_files",
    "pins",
    "process_records",
    "recovery_changes",
    "recovery_checkpoints",
    "recovery_operation_files",
    "recovery_operations",
    "recovery_refs",
    "recovery_turns",
    "revisions",
    "root_blobs",
    "root_parents",
    "trie_nodes",
];

pub(crate) const REQUIRED_INDEXES: &[&str] = &[
    "domain_record_refs_hash",
    "domain_records_thread",
    "domain_records_workspace",
    "object_owners_blob",
    "object_owners_workspace",
    "pins_root",
    "process_records_workspace",
    "recovery_changes_checkpoint",
    "recovery_checkpoints_workspace",
    "recovery_operation_files_operation",
    "recovery_operations_workspace",
    "recovery_refs_hash",
    "recovery_turns_workspace",
    "revisions_root",
    "root_blobs_blob",
];

pub(crate) const REQUIRED_COLUMNS: &[(&str, &[&str])] = &[
    (
        "process_records",
        &[
            "process_id",
            "workspace_id",
            "execution_workspace_id",
            "grant_id",
            "kernel_epoch",
            "cwd",
            "job_name",
            "params_hash",
            "status_json",
        ],
    ),
    ("blobs", &["hash", "byte_length"]),
    (
        "branches",
        &[
            "branch_id",
            "workspace_id",
            "create_params_hash",
            "base_root",
            "head_root",
            "head_revision",
            "write_revision",
            "parent_ref",
            "draft_base_paths_json",
            "capture_scopes_json",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "grants",
        &[
            "grant_id",
            "host_id",
            "grant_json",
            "params_hash",
            "state",
            "created_at",
            "updated_at",
        ],
    ),
    ("metadata", &["key", "value"]),
    (
        "object_owners",
        &[
            "owner_id",
            "blob_hash",
            "workspace_id",
            "operation_id",
            "grant_id",
            "created_at",
        ],
    ),
    (
        "operation_owners",
        &["operation_id", "workspace_id", "created_at"],
    ),
    (
        "operations",
        &[
            "operation_id",
            "kind",
            "params_hash",
            "state",
            "result_json",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "pending_gc_files",
        &[
            "hash",
            "path",
            "state",
            "last_error",
            "queued_at",
            "cleaned_at",
        ],
    ),
    (
        "pins",
        &[
            "pin_id",
            "branch_id",
            "workspace_id",
            "revision",
            "write_revision",
            "root_hash",
            "grant_id",
            "ephemeral",
            "created_at",
        ],
    ),
    (
        "domain_records",
        &[
            "record_id",
            "workspace_id",
            "record_type",
            "state",
            "session_id",
            "thread_id",
            "run_id",
            "branch_id",
            "revision",
            "result_revision",
            "record_revision",
            "payload_json",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "domain_record_refs",
        &["workspace_id", "record_id", "slot", "object_hash"],
    ),
    (
        "recovery_checkpoints",
        &[
            "id",
            "workspace_id",
            "sequence",
            "source",
            "state",
            "created_at",
            "label",
            "session_id",
            "entry_id",
            "execution_id",
            "changed_path_count",
            "byte_length",
            "revision",
        ],
    ),
    (
        "recovery_turns",
        &[
            "execution_id",
            "workspace_id",
            "runtime_key",
            "runtime_generation",
            "worker_id",
            "session_id",
            "user_entry_id",
            "assistant_entry_id",
            "checkpoint_id",
            "active_writer_scopes_json",
            "provenance",
            "status",
            "observed_resource_ids_json",
            "unrecorded_resource_ids_json",
            "failure_json",
            "started_at",
            "settled_at",
            "revision",
        ],
    ),
    (
        "recovery_changes",
        &[
            "workspace_id",
            "checkpoint_id",
            "path",
            "execution_id",
            "tool_name",
            "mutation_id",
            "before_json",
            "after_json",
            "state",
            "created_at",
            "updated_at",
            "revision",
        ],
    ),
    (
        "recovery_operations",
        &[
            "operation_id",
            "workspace_id",
            "kind",
            "state",
            "session_id",
            "thread_id",
            "run_id",
            "data_json",
            "result_json",
            "failure_json",
            "created_at",
            "updated_at",
            "revision",
        ],
    ),
    (
        "recovery_operation_files",
        &[
            "workspace_id",
            "operation_id",
            "ordinal",
            "path",
            "expected_json",
            "target_json",
            "safety_json",
            "phase",
            "observed_fingerprint",
            "revision",
            "updated_at",
        ],
    ),
    (
        "recovery_refs",
        &[
            "workspace_id",
            "owner_kind",
            "owner_id",
            "slot",
            "object_hash",
        ],
    ),
    (
        "revisions",
        &[
            "branch_id",
            "revision",
            "root_hash",
            "parent_revision",
            "operation_id",
            "created_at",
        ],
    ),
    ("root_blobs", &["root_hash", "blob_hash"]),
    ("root_parents", &["root_hash", "parent_root"]),
    ("trie_nodes", &["hash", "children_json", "state_json"]),
];
