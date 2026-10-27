//! Durable kernel storage owner and its domain implementations.
//!
//! `Storage` owns the SQLite connection, object root, process lock, cancellation token, and
//! in-flight builders. Domain modules extend this single owner; protocol dispatch is the only
//! broad entry point used by the runtime.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use fs2::FileExt;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

use crate::authority::{
    path_allowed, path_allowed_scopes, path_metadata_allowed_scopes, require_capability,
};
use crate::error::KernelError;
use crate::model::{
    BlobStream, BranchBuilder, BranchRow, BranchWriteBuilder, BuildTree, FileLease,
    FileLeaseResource, FileRoot, Grant, PathState, TrieNode,
};
use crate::protocol::*;
use crate::storage_schema::{
    CATALOG_QUERY_INDEXES, CATALOG_SCHEMA, CATALOG_USER_VERSION, REQUIRED_COLUMNS, REQUIRED_INDEXES, REQUIRED_TABLES,
};

mod authority_store;
pub(crate) mod blob_reads;
mod branches;
pub(crate) mod branch_namespace;
pub(crate) mod workspace_files;
pub(crate) mod workspace_metadata;
pub(crate) mod workspace_session;
mod workspace_results;
pub(crate) mod workspace_adoption;
pub(crate) mod capture_resources;
mod child_sources;
mod compute_resources;
mod core;
mod dispatch;
pub(crate) mod file_inventory;
mod file_identity;
pub(crate) mod file_reads;
pub(crate) mod line_reads;
pub(crate) mod file_mutations;
pub(crate) mod file_mutation_tasks;
pub(crate) mod file_observations;
mod file_reconciliation;
mod file_resource_leases;
pub(crate) mod file_lease_tasks;
pub(crate) mod file_effects;
mod file_resources;
mod gc;
mod maintenance;
pub(crate) mod materialization;
pub(crate) mod materialized_views;
mod execution_views;
mod objects;
mod operations;
#[cfg(test)]
mod native_authority_tests;
#[cfg(test)]
mod versioned_workspaces_review;
pub(crate) mod process_interactions;
mod process_resources;
mod records;
mod recovery;
mod recovery_journal;
pub(crate) mod recovery_points;
pub(crate) mod result_publication;
mod state_tree;
mod tree_diff;
mod source_authorities;
mod source_mcp_deliveries;
pub(crate) mod source_mcp_children;
pub(crate) mod source_mcp_derivation;
pub(crate) mod source_read_receipts;
pub(crate) mod source_schedule_receipts;
pub(crate) mod source_mcp_receipts;

pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

pub(crate) fn durable_rename(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::rename(source, target)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
        }
        fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
            // Unlike Rust's filesystem APIs, a direct Win32 call does not expand
            // long paths for us. Resolve syntax without following the final link.
            let absolute = std::path::absolute(path)?;
            let (prefix, skip) = match absolute.components().next() {
                Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
                    std::path::Prefix::Disk(_) => (r"\\?\", 0),
                    std::path::Prefix::UNC(_, _) => (r"\\?\UNC\", 2),
                    _ => ("", 0),
                },
                _ => ("", 0),
            };
            Ok(std::ffi::OsStr::new(prefix).encode_wide()
                .chain(absolute.as_os_str().encode_wide().skip(skip))
                .chain(std::iter::once(0)).collect())
        }
        let existing = wide_path(source)?;
        let replacement = wide_path(target)?;
        let moved = unsafe {
            MoveFileExW(
                existing.as_ptr(),
                replacement.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn hash_file(path: &Path) -> Result<(String, u64), KernelError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        length = length
            .checked_add(read as u64)
            .ok_or_else(|| KernelError::Storage("content length overflow".to_string()))?;
    }
    Ok((format!("sha256-{}", hex::encode(digest.finalize())), length))
}

fn chrono_like_now() -> String {
    // Keep recovery timestamps RFC3339-shaped without adding a clock crate to
    // the kernel's small dependency set.  The civil-date conversion is the
    // standard proleptic Gregorian calculation used for Unix timestamps.
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs() as i64;
    let nanos = elapsed.subsec_nanos();
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{nanos:09}Z")
}

fn recovery_fault(phase: &str) -> Result<(), KernelError> {
    if std::env::var("VARIN_KERNEL_FAIL_RECOVERY_PHASE")
        .ok()
        .as_deref()
        == Some(phase)
    {
        return Err(KernelError::Storage(format!(
            "injected recovery failure at {phase}"
        )));
    }
    Ok(())
}

fn blob_owner_id(operation_id: &str) -> String {
    format!(
        "blob-owner-{}",
        hex::encode(Sha256::digest(operation_id.as_bytes()))
    )
}

struct StorageLock {
    _file: File,
}

impl Drop for StorageLock {
    fn drop(&mut self) {
        let _ = self._file.unlock();
    }
}

pub(crate) struct Storage {
    root: PathBuf,
    conn: Connection,
    _lock: StorageLock,
    cancellation: Option<Arc<AtomicBool>>,
    streams: HashMap<String, BlobStream>,
    branch_builders: HashMap<String, BranchBuilder>,
    branch_write_builders: HashMap<String, BranchWriteBuilder>,
    verified_objects: BTreeSet<String>,
    source_capture_cache: HashMap<(String, String), capture_resources::CaptureReuse>,
    blob_read_roots: blob_reads::BlobReadRoots,
    private_files: HashMap<String, Vec<std::sync::Weak<workspace_files::PrivateFile>>>,
    workspace_revocations: HashMap<String, Vec<std::sync::Weak<AtomicBool>>>,
    workspace_sessions: HashMap<String, std::sync::Weak<workspace_session::Session>>,
    workspace_holders: HashMap<String, (String, String)>,
    private_cleanup: Arc<workspace_files::StagingCleanup>,
    file_roots: HashMap<String, FileRoot>,
    observation_reads: HashMap<String, file_observations::ActiveRead>,
    observation_hints: Option<Arc<dyn Fn(file_observations::Hint) + Send + Sync>>,
    file_leases: HashMap<String, FileLease>,
    file_lease_waiters: std::collections::VecDeque<file_resource_leases::FileLeaseWaiter>,
    file_lease_notify: Option<Arc<dyn Fn() + Send + Sync>>,
    retained_file_leases: HashMap<String, file_resource_leases::RetainedFileLease>,
    materializations: HashMap<String, materialization::ActiveMaterialization>,
    result_publications: BTreeSet<String>,
    file_effects: BTreeSet<String>,
    processes: crate::process::ProcessManager,
    process_receipt_wake: Option<crate::process::receipt_wake::Watch>,
    process_receipt_notify: Option<Arc<dyn Fn() + Send + Sync>>,
    process_receipt_wake_failure: Option<String>,
    computations: crate::compute::ComputeManager,
}

impl Storage {
    pub(crate) fn take_execution_for_shutdown(&mut self) -> (crate::process::ProcessManager, crate::compute::ComputeManager) {
        (std::mem::take(&mut self.processes), std::mem::take(&mut self.computations))
    }
    pub(crate) fn finish_execution_shutdown(&mut self, processes: crate::process::ProcessManager, computations: crate::compute::ComputeManager) -> Result<(), KernelError> {
        self.processes = processes;
        self.computations = computations;
        self.refresh_process_records()?;
        self.sweep_compute_readers()
    }
}
impl Drop for Storage {
    fn drop(&mut self) {
        // Keep the catalog and storage lock alive through process drainage.
        // Field drop order alone would unlock before native children stop.
        self.process_receipt_wake.take();
        for tokens in self.workspace_revocations.values() {
            for token in tokens.iter().filter_map(std::sync::Weak::upgrade) { token.store(true,Ordering::Release); }
        }
        for handles in self.private_files.values() {
            for handle in handles.iter().filter_map(std::sync::Weak::upgrade) { handle.revoke(); }
        }
        self.cancel_file_observation_reads();
        self.computations.shutdown();
        let _ = self.shutdown_processes();
    }
}
