//! The OS mount table can be read without opening a disconnected workspace.
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub(in crate::workspace_mount) struct MountInfo {
    target: PathBuf,
    pub(super) filesystem: OsString,
    pub(super) source: OsString,
}

pub(in crate::workspace_mount) fn mount_at(target: &Path) -> io::Result<Option<MountInfo>> {
    let mut matching = mounts()?.into_iter().filter(|mount| mount.target == target);
    let first = matching.next();
    if matching.next().is_some() {
        return Err(io::Error::other(
            "Multiple mounts occupy the workspace path",
        ));
    }
    Ok(first)
}

#[cfg(target_os = "linux")]
fn mounts() -> io::Result<Vec<MountInfo>> {
    let table = fs::read("/proc/self/mountinfo")?;
    table
        .split(|&byte| byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(parse_mountinfo)
        .collect()
}

#[cfg(target_os = "linux")]
fn parse_mountinfo(line: &[u8]) -> io::Result<MountInfo> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid Linux mount table entry",
        )
    };
    let mut fields = line.split(|&byte| byte == b' ');
    let target = fields.nth(4).ok_or_else(invalid)?;
    fields.find(|&field| field == b"-").ok_or_else(invalid)?;
    let filesystem = fields.next().ok_or_else(invalid)?;
    let source = fields.next().ok_or_else(invalid)?;
    fn unescape(field: &[u8]) -> OsString {
        let mut bytes = Vec::with_capacity(field.len());
        let mut rest = field;
        while let Some((&byte, tail)) = rest.split_first() {
            match rest.get(..4) {
                Some(b"\\040") => bytes.push(b' '),
                Some(b"\\011") => bytes.push(b'\t'),
                Some(b"\\012") => bytes.push(b'\n'),
                Some(b"\\134") => bytes.push(b'\\'),
                _ => {
                    bytes.push(byte);
                    rest = tail;
                    continue;
                }
            }
            rest = &rest[4..];
        }
        OsString::from_vec(bytes)
    }
    Ok(MountInfo {
        target: unescape(target).into(),
        filesystem: unescape(filesystem),
        source: unescape(source),
    })
}

#[cfg(target_os = "macos")]
pub(in crate::workspace_mount) fn mounts() -> io::Result<Vec<MountInfo>> {
    use std::mem::{MaybeUninit, size_of};
    let mut capacity = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if capacity < 0 {
        return Err(io::Error::last_os_error());
    }
    loop {
        // getfsstat writes into our buffer, so concurrent inspectors never share
        // the static snapshot used by getmntinfo.
        let length = capacity as usize + 1;
        let mut entries = vec![MaybeUninit::<libc::statfs>::uninit(); length];
        let size = (length * size_of::<libc::statfs>())
            .try_into()
            .map_err(|_| io::Error::other("The macOS mount table is too large"))?;
        let count = unsafe { libc::getfsstat(entries.as_mut_ptr().cast(), size, libc::MNT_NOWAIT) };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        if count as usize >= length {
            capacity = count;
            continue;
        }
        let name = |value: &[libc::c_char]| {
            OsString::from_vec(
                value
                    .iter()
                    .take_while(|&&byte| byte != 0)
                    .map(|&byte| byte as u8)
                    .collect(),
            )
        };
        return Ok(entries[..count as usize]
            .iter()
            .map(|entry| {
                let entry = unsafe { entry.assume_init_ref() };
                MountInfo {
                    target: name(&entry.f_mntonname).into(),
                    filesystem: name(&entry.f_fstypename),
                    source: name(&entry.f_mntfromname),
                }
            })
            .collect());
    }
}

pub(super) fn fuse_source(generation: &str) -> String {
    format!("varin-workspace:{generation}")
}

fn is_original_fuse(mount: &MountInfo, generation: &str) -> bool {
    let kind = mount.filesystem.as_bytes();
    (kind == b"fuse" || kind.starts_with(b"fuse.") || kind == b"macfuse" || kind == b"osxfuse")
        && mount.source == fuse_source(generation).as_str()
}

#[cfg(target_os = "linux")]
fn unmount(target: &Path) -> io::Result<()> {
    fuser::unmount_path(target)
}

#[cfg(target_os = "macos")]
fn unmount(target: &Path) -> io::Result<()> {
    let output = std::process::Command::new("/sbin/umount")
        .arg(target)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    Ok(())
}

/// The caller has identified its mount at this path in the OS mount table.
pub(in crate::workspace_mount) fn detach(target: &Path) -> io::Result<()> {
    unmount(target)?;
    if mount_at(target)?.is_some() {
        return Err(io::Error::other(
            "Workspace mount removal was not confirmed",
        ));
    }
    Ok(())
}

pub(super) fn detach_disconnected_fuse(target: &Path, generation: &str) -> io::Result<()> {
    if let Some(mount) = mount_at(target)? {
        if !is_original_fuse(&mount, generation) {
            return Err(io::Error::other(
                "The workspace path is occupied by another mount",
            ));
        }
        detach(target)?;
    }
    Ok(())
}

/// The Storage lock is already held for this root. Current kernels cannot
/// publish into this directory before recovery finishes.
pub(crate) fn recover(storage: &Path) -> io::Result<()> {
    let root = storage.join("managed/workspaces");
    match root.canonicalize() {
        Ok(path) if path == root => (),
        Ok(_) => return Err(io::Error::other("The workspace mount directory has moved")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let mounted = mounts()?;
    #[cfg(target_os = "macos")]
    if let Err(error) = super::native_service::recover_previous_resources() {
        eprintln!("[Workspace] Previous FSKit resources could not be inspected: {error}");
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(generation) = name.to_str() else {
            continue;
        };
        if uuid::Uuid::parse_str(generation).is_err() {
            continue;
        }
        let target = entry.path();
        let mut at_target = mounted.iter().filter(|mount| mount.target == target);
        if let Some(original) = at_target.next() {
            if at_target.next().is_some() || !is_original_fuse(original, generation) {
                continue;
            }
            if let Err(error) = detach_disconnected_fuse(&target, generation) {
                eprintln!("[Workspace] Previous FUSE mount could not be detached: {error}");
                continue;
            }
        }
        remove_empty_target(&target);
    }
    Ok(())
}

pub(crate) fn create_target(target: &Path) -> io::Result<()> {
    let root = target.parent().expect("managed workspace mount parent");
    fs::create_dir_all(root)?;
    if root.canonicalize()? != root {
        return Err(io::Error::other("The workspace mount directory has moved"));
    }
    fs::create_dir(target)
}

pub(crate) fn remove_empty_target(target: &Path) {
    // A directory may contain files after a detach, or have been replaced.
    // rmdir preserves both those files and any mount occupying the pathname.
    if let Err(error) = fs::remove_dir(target) {
        if !matches!(
            error.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
        ) {
            eprintln!("[Workspace] Mount directory could not be removed: {error}");
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn uses_the_mount_table_to_distinguish_a_stale_source_from_a_replacement() {
        let original = parse_mountinfo(
            br"94 71 0:40 / /home/a\040b/mount rw,nosuid shared:7 - fuse varin-workspace:old rw",
        )
        .unwrap();
        assert_eq!(original.target, Path::new("/home/a b/mount"));
        assert!(is_original_fuse(&original, "old"));
        assert!(!is_original_fuse(&original, "replacement"));
        let other =
            parse_mountinfo(br"95 71 0:41 / /home/a\040b/mount rw - tmpfs varin-workspace:old rw")
                .unwrap();
        assert!(!is_original_fuse(&other, "old"));
    }
}
