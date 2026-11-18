//! Discover and invoke the system FUSE helper for unprivileged mounts.

use log::debug;
use std::env;
use std::ffi::{CStr, CString, OsStr};
use std::io::{self, Error, ErrorKind};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const FUSERMOUNT_BIN: &str = "fusermount";
const FUSERMOUNT3_BIN: &str = "fusermount3";
pub(super) const MOUNT_FUSEFS_BIN: &str = "mount_fusefs";

#[cfg(target_os = "linux")]
pub(crate) fn unmount_path(target: &Path) -> io::Result<()> {
    let path = CString::new(target.as_os_str().as_bytes())?;
    if unsafe { libc::umount2(path.as_ptr(), libc::UMOUNT_NOFOLLOW) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.kind() != io::ErrorKind::PermissionDenied {
        return Err(error);
    }
    unmount(&path)
}

pub(super) fn unmount(mountpoint: &CStr) -> io::Result<()> {
    let helper = detect_fusermount_bin()?;
    let mut builder = Command::new(helper);
    builder.stdout(Stdio::piped()).stderr(Stdio::piped());
    builder
        .arg("-u")
        .arg("--")
        .arg(OsStr::from_bytes(mountpoint.to_bytes()));

    let output = builder.output()?;
    debug!("fusermount: {}", String::from_utf8_lossy(&output.stdout));
    debug!("fusermount: {}", String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "FUSE detach refused: {}",
            String::from_utf8_lossy(&output.stderr)
        )))
    }
}

fn executable(candidate: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(candidate)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "FUSE mount helper is not an executable file",
        ));
    }
    let name = CString::new(candidate.as_os_str().as_bytes())
        .map_err(|_| Error::new(ErrorKind::InvalidInput, "FUSE helper path contains NUL"))?;
    if unsafe { libc::access(name.as_ptr(), libc::X_OK) } != 0 {
        return Err(Error::last_os_error());
    }
    Ok(())
}
pub(super) fn detect_fusermount_bin() -> io::Result<PathBuf> {
    if let Some(fusermount) = env::var_os("FUSERMOUNT_PATH") {
        let candidate = PathBuf::from(fusermount);
        if candidate.components().count() > 1 || candidate.is_absolute() {
            executable(&candidate).map_err(|error| {
                Error::new(
                    error.kind(),
                    format!(
                        "Configured FUSE helper {} is unavailable: {error}",
                        candidate.display()
                    ),
                )
            })?;
            return Ok(candidate);
        }
        let mut denied = false;
        for directory in env::split_paths(&env::var_os("PATH").unwrap_or_default()) {
            let path = directory.join(&candidate);
            match executable(&path) {
                Ok(()) => return Ok(path),
                Err(error) => denied |= error.kind() == ErrorKind::PermissionDenied,
            }
        }
        return Err(Error::new(
            if denied {
                ErrorKind::PermissionDenied
            } else {
                ErrorKind::NotFound
            },
            "The configured FUSERMOUNT_PATH helper is not executable in PATH",
        ));
    }
    let mut denied = false;
    let paths = env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .chain([
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/sbin"),
        ])
        .collect::<Vec<_>>();
    for name in [FUSERMOUNT3_BIN, FUSERMOUNT_BIN, MOUNT_FUSEFS_BIN] {
        for directory in &paths {
            let candidate = directory.join(name);
            match executable(&candidate) {
                Ok(()) => return Ok(candidate),
                Err(error) => denied |= error.kind() == ErrorKind::PermissionDenied,
            }
        }
    }
    Err(Error::new(
        if denied {
            ErrorKind::PermissionDenied
        } else {
            ErrorKind::NotFound
        },
        "No executable FUSE mount helper was found; install fuse3/fusermount3 on the execution Host or correct FUSERMOUNT_PATH",
    ))
}
