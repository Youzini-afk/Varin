//! Native mount qualification adapters. These do not select a project source,
//! install a driver or silently replace materialization in existing Runs.
use crate::error::KernelError;
use crate::model::PathState;
use crate::storage::workspace_files::PrivateFile;
use crate::storage::workspace_session::{Node, Session};
use std::path::Path;
use std::sync::Arc;

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod fuse;
#[cfg(any(target_os = "linux", target_os = "macos", test))]
mod cache_fence;
#[cfg(any(target_os = "macos", test))]
mod native_service;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub(crate) use fuse::Mount;
#[cfg(target_os = "macos")]
pub(crate) use macos::Mount;
#[cfg(windows)]
pub(crate) use windows::Mount;

pub(crate) fn dependencies()->Result<(),KernelError>{
    #[cfg(windows)] {windows::initialize()?; windows::check_driver()}
    #[cfg(target_os="macos")] {macos::select().map(|_|())}
    #[cfg(target_os="linux")] {
        fuser::mount_dependencies().map_err(|error| crate::workspace_backend::unavailable(
            match error.kind() {
                std::io::ErrorKind::NotFound => "dependency_missing",
                std::io::ErrorKind::PermissionDenied => "permission_denied",
                std::io::ErrorKind::Unsupported => "backend_unsupported",
                _ => "dependency_unavailable",
            }, format!("Native workspace dependency is unavailable: {error}")))
    }
}

#[cfg(target_os="macos")]
fn darwin_cache_fence(target:&Path)->Result<(),KernelError>{
    use std::os::fd::AsRawFd;
    unsafe extern "C"{fn fsync_volume_np(fd:libc::c_int,flags:libc::c_int)->libc::c_int;}
    let root=std::fs::File::open(target)?;
    // SYNC_VOLUME_WAIT: drain data and metadata without holding any file service
    // lock needed by the kernel's writeback callbacks.
    let result=unsafe{fsync_volume_np(root.as_raw_fd(),0x02)};
    if result==0{return Ok(());}
    let error=if result>0{std::io::Error::from_raw_os_error(result)}else{std::io::Error::last_os_error()};
    Err(KernelError::Execution(varin_runtime::execution::ExecutionError::new("workspace_cache_sync_failed",format!("macOS volume synchronization failed: {error}"))
        .with_details(serde_json::json!({"stage":"workspace_cache_sync","parentAvailable":true}))))
}

fn unsupported(message: &str) -> KernelError {
    KernelError::Execution(varin_runtime::execution::ExecutionError::new(
        "workspace_backend_unsupported",
        message,
    ))
}

/// Preserve the requested namespace. A lossy OS-string conversion would create
/// a different file, so byte/UTF-16 names outside today's Storage path contract
/// have an explicit error until native-name persistence is implemented.
fn component(value: &std::ffi::OsStr) -> Result<&str, KernelError> {
    let value = value.to_str().ok_or_else(|| {
        unsupported("This source name cannot be represented by the current Storage path contract")
    })?;
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\', '\0']) {
        return Err(unsupported("Invalid native path component"));
    }
    Ok(value)
}

/// Check only the explicit target. FUSE mounts over an empty directory;
/// WinFsp creates and owns a new junction. Neither may cover user files.
fn admit_target(target: &Path) -> Result<(), KernelError> {
    // WinFsp atomically creates and owns its delete-on-close junction. Creating
    // and removing a placeholder first can leave Windows deletion pending.
    #[cfg(windows)]
    {
        return match std::fs::symlink_metadata(target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
            Ok(_) => Err(unsupported("WinFsp mount target must not already exist")),
        };
    }
    #[cfg(not(windows))]
    {
        let metadata = std::fs::symlink_metadata(target)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || std::fs::read_dir(target)?.next().is_some()
        {
            return Err(unsupported(
                "Workspace mount target must be an existing empty real directory",
            ));
        }
        Ok(())
    }
}

fn kind_error(error: &KernelError) -> &str {
    match error {
        KernelError::Execution(error) => &error.code,
        KernelError::Authorization(_) => "denied",
        KernelError::Cancelled => "cancelled",
        KernelError::NotFound(_) => "namespace_missing",
        _ => "io",
    }
}

#[cfg(test)]
mod review;
