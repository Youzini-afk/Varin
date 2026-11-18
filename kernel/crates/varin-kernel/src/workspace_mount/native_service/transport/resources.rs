//! Crash leftovers are owned executor resources, not user projects. A live OS
//! lock protects every active instance; cleanup never infers death from age.
use super::*;
use crate::workspace_mount::unix;
use std::os::unix::fs::MetadataExt;
fn root_path() -> PathBuf {
    PathBuf::from(format!("/tmp/varin-workspaces-{}", unsafe {
        libc::geteuid()
    }))
}

pub(in crate::workspace_mount) fn recover_previous_resources() -> std::io::Result<()> {
    if root_path().try_exists()? {
        root().map_err(|error| std::io::Error::other(error.to_string()))?;
    }
    Ok(())
}

pub(super) fn root() -> Result<PathBuf, KernelError> {
    let path = root_path();
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
        let Some(_owner) = resource_owner::claim(root, &path) else {
            continue;
        };
        let manifest = std::fs::read(path.join("resource.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(manifest) = manifest else {
            // A crash before resource publication may leave only its owner
            // file/socket. Check the OS table before releasing this candidate.
            if matches!(unix::mounts(), Ok(values) if !values.iter().any(|mount| owns_mount(mount, &path)))
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
        // Match the original path and resource without opening the filesystem.
        let target = Path::new(target);
        let Ok(mounted) = unix::mount_at(target) else {
            continue;
        };
        if let Some(mount) = mounted {
            if !owns_mount(&mount, &path) || unix::detach(target).is_err() {
                continue;
            }
        }
        // Production mount directories use the original Session generation.
        if target.parent().is_some_and(|parent| {
            parent.ends_with("managed/workspaces")
                && parent
                    .canonicalize()
                    .is_ok_and(|canonical| canonical == parent)
        }) && manifest["generation"]
            .as_str()
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            .is_some()
            && target.file_name().and_then(|name| name.to_str()) == manifest["generation"].as_str()
        {
            unix::remove_empty_target(target);
        }
        // The nonce directory was validated under our private root, its owner
        // lock is held and its original mount has really detached.
        let _ = std::fs::remove_dir_all(&path);
    }
}
pub(super) fn owns_mount(mount: &unix::MountInfo, resource: &Path) -> bool {
    let mut url = std::ffi::OsString::from("file://");
    url.push(resource);
    mount.filesystem == "varin" && (mount.source == resource.as_os_str() || mount.source == url)
}
