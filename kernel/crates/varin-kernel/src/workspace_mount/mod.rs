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
#[cfg(windows)]
mod windows;

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use fuse::Mount;
#[cfg(windows)]
pub(crate) use windows::Mount;

pub(crate) fn dependencies()->Result<(),KernelError>{
    #[cfg(windows)] {windows::initialize()?; windows::check_driver()}
    #[cfg(any(target_os="linux",target_os="macos"))] {
        fuser::mount_dependencies().map_err(|error| crate::workspace_backend::unavailable(
            match error.kind() {
                std::io::ErrorKind::NotFound => "dependency_missing",
                std::io::ErrorKind::PermissionDenied => "permission_denied",
                std::io::ErrorKind::Unsupported => "backend_unsupported",
                _ => "dependency_unavailable",
            }, format!("Native workspace dependency is unavailable: {error}")))
    }
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

/// Never mount over an existing project or a directory containing user files.
/// This tests the explicit target only; backend admission remains responsible
/// for the native atomic mount-point claim.
fn admit_target(target: &Path) -> Result<(), KernelError> {
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
