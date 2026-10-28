//! Crash leftovers are owned executor resources, not user projects. A live OS
//! lock protects every active instance; cleanup never infers death from age.
use super::*;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
pub(super) fn root() -> Result<PathBuf, KernelError> {
    let path = PathBuf::from(format!("/tmp/varin-workspaces-{}", unsafe {
        libc::geteuid()
    }));
    match std::fs::DirBuilder::new().mode(0o700).create(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(KernelError::Authorization(
            "The private filesystem executor directory is not owned exclusively by this Host user"
                .into(),
        ));
    }
    let path = std::fs::canonicalize(path)?;
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let path = path.clone();
        std::thread::spawn(move || cleanup(&path));
    });
    Ok(path)
}
fn cleanup(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            continue;
        }
        let Ok(owner) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path.join("owner.lock"))
        else {
            continue;
        };
        if fs2::FileExt::try_lock_exclusive(&owner).is_err() {
            continue;
        }
        let manifest = std::fs::read(path.join("resource.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(manifest) = manifest else {
            // A crash before resource publication may leave only its owner
            // file/socket. Check the OS table before releasing this candidate.
            if matches!(mounts(),Ok(values) if !values.iter().any(|(_,_,source)|source==&path.to_string_lossy() || source==&format!("file://{}",path.display())))
            {
                let _ = std::fs::remove_dir_all(&path);
            }
            continue;
        };
        if manifest["protocol"] != 1 {
            continue;
        }
        let Some(target) = manifest["mountTarget"].as_str() else {
            continue;
        };
        // getmntinfo does not enter a disconnected filesystem. Only detach an
        // exact path-resource mount, never a replacement at the same pathname.
        let Ok(mounted) = mount_source(target) else {
            continue;
        };
        if let Some((kind, source)) = mounted {
            if kind != "varin"
                || (source != path.to_string_lossy()
                    && source != format!("file://{}", path.display()))
            {
                continue;
            }
            match std::process::Command::new("/sbin/umount")
                .arg(target)
                .output()
            {
                Ok(output) if output.status.success() => {}
                _ => continue,
            }
            if !matches!(mount_source(target), Ok(None)) {
                continue;
            }
        }
        // The nonce directory was validated under our private root, its owner
        // lock is held and its original mount has really detached.
        let _ = std::fs::remove_dir_all(&path);
    }
}
pub(super) fn mount_source(target: &str) -> std::io::Result<Option<(String, String)>> {
    Ok(mounts()?
        .into_iter()
        .find(|(path, _, _)| path == target)
        .map(|(_, kind, source)| (kind, source)))
}
fn mounts() -> std::io::Result<Vec<(String, String, String)>> {
    let mut mounts = std::ptr::null_mut();
    let count = unsafe { libc::getmntinfo(&mut mounts, libc::MNT_NOWAIT) };
    if count == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let values = unsafe { std::slice::from_raw_parts(mounts, count as usize) };
    let mut result = Vec::new();
    for mount in values {
        let path =
            unsafe { std::ffi::CStr::from_ptr(mount.f_mntonname.as_ptr()) }.to_string_lossy();
        result.push((
            path.into_owned(),
            unsafe { std::ffi::CStr::from_ptr(mount.f_fstypename.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
            unsafe { std::ffi::CStr::from_ptr(mount.f_mntfromname.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        ));
    }
    Ok(result)
}
