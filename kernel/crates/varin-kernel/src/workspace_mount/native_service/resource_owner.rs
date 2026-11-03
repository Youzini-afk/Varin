//! The OS owner shared by FSKit resource creation and crash cleanup.
use crate::error::KernelError;
use std::fs::File;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

fn namespace(root: &Path) -> Result<File, KernelError> {
    // Never unlink this inode: every process must meet at the same admission
    // lock, including after its previous holder crashes.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root.join("namespace.lock"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(KernelError::Authorization(
            "The filesystem executor namespace lock is not owned exclusively by this Host user"
                .into(),
        ));
    }
    Ok(file)
}

pub(super) fn create(root: &Path) -> Result<(PathBuf, File), KernelError> {
    create_with(root, |_| {})
}

fn create_with(root: &Path, opened: impl FnOnce(&Path)) -> Result<(PathBuf, File), KernelError> {
    // Protect the interval between publishing the directory/owner inode and
    // acquiring its live-owner lock. Service work starts only after this returns.
    let admission = namespace(root)?;
    fs2::FileExt::lock_exclusive(&admission)?;
    let path = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::DirBuilder::new().mode(0o700).create(&path)?;
    let prepared = (|| {
        let owner = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path.join("owner.lock"))?;
        opened(&path);
        fs2::FileExt::try_lock_exclusive(&owner)?;
        Ok(owner)
    })();
    match prepared {
        Ok(owner) => Ok((path, owner)),
        Err(error) => {
            let _ = std::fs::remove_dir_all(&path);
            Err(error)
        }
    }
}

pub(super) fn claim(root: &Path, path: &Path) -> Option<File> {
    let admission = namespace(root).ok()?;
    // Cleanup is opportunistic: busy publication is not evidence of a dead owner.
    fs2::FileExt::try_lock_exclusive(&admission).ok()?;
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return None;
    }
    let owner = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path.join("owner.lock"))
        .ok()?;
    fs2::FileExt::try_lock_exclusive(&owner).ok()?;
    // Only the per-resource lock crosses into mount inspection/unmount/removal.
    Some(owner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Read, Write};
    use std::process::{Child, Command, Stdio};

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("varin-resource-owner-{}", uuid::Uuid::new_v4()));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .unwrap();
            Self(path)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    struct Process(Child);
    impl Drop for Process {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn subprocess(mode: &str, root: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "workspace_mount::native_service::resource_owner::tests::owner_process",
                "--ignored",
                "--nocapture",
            ])
            .env("VARIN_RESOURCE_OWNER_TEST_MODE", mode)
            .env("VARIN_RESOURCE_OWNER_TEST_ROOT", root);
        command
    }
    fn process_claims(root: &Path, path: &Path) -> bool {
        let output = subprocess("claim", root)
            .env("VARIN_RESOURCE_OWNER_TEST_PATH", path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output = String::from_utf8(output.stdout).unwrap();
        assert!(output.contains("resource-owner-claim:"), "{output}");
        output.contains("resource-owner-claim:true")
    }

    #[test]
    fn constructing_owner_excludes_cleanup_in_another_process() {
        let root = Root::new();
        let (path, owner) = create_with(&root.0, |path| {
            assert!(
                !process_claims(&root.0, path),
                "cleanup acquired the creator's published but not-yet-locked owner"
            );
        })
        .unwrap();
        assert!(!process_claims(&root.0, &path));
        drop(owner);
        assert!(process_claims(&root.0, &path));
    }

    #[test]
    fn creator_crash_releases_construction_and_resource_ownership() {
        let root = Root::new();
        let mut process = Process(
            subprocess("construct", &root.0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let output = std::io::BufReader::new(process.0.stdout.take().unwrap());
        let path = output
            .lines()
            .map(Result::unwrap)
            .find_map(|line| {
                line.split_once("resource-owner-ready:")
                    .map(|(_, path)| PathBuf::from(path))
            })
            .unwrap();
        assert!(
            claim(&root.0, &path).is_none(),
            "a still-running constructor is not a crash leftover"
        );
        process.0.kill().unwrap();
        process.0.wait().unwrap();
        assert!(claim(&root.0, &path).is_some());
        let (_next, _owner) = create(&root.0).unwrap();
    }

    #[test]
    fn cleanup_claim_holds_only_its_original_resource() {
        let root = Root::new();
        let (first, owner) = create(&root.0).unwrap();
        drop(owner);
        let (other, owner) = create(&root.0).unwrap();
        drop(owner);
        let _cleanup = claim(&root.0, &first).unwrap();
        assert!(!process_claims(&root.0, &first));
        assert!(
            process_claims(&root.0, &other),
            "slow teardown must not retain namespace admission"
        );
    }

    #[test]
    fn namespace_admission_rejects_a_symlink_or_shared_lock_file() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = Root::new();
        let target = root.0.join("unrelated");
        let lock = root.0.join("namespace.lock");
        std::fs::write(&target, b"original bytes").unwrap();
        symlink(&target, &lock).unwrap();
        assert!(create(&root.0).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original bytes");
        std::fs::remove_file(&lock).unwrap();
        std::fs::write(&lock, b"").unwrap();
        std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(create(&root.0).is_err());
    }

    #[test]
    #[ignore = "subprocess entry used by the resource ownership tests"]
    fn owner_process() {
        let root = PathBuf::from(std::env::var_os("VARIN_RESOURCE_OWNER_TEST_ROOT").unwrap());
        match std::env::var("VARIN_RESOURCE_OWNER_TEST_MODE")
            .unwrap()
            .as_str()
        {
            "claim" => {
                let path =
                    PathBuf::from(std::env::var_os("VARIN_RESOURCE_OWNER_TEST_PATH").unwrap());
                let owner = claim(&root, &path);
                println!("resource-owner-claim:{}", owner.is_some());
            }
            "construct" => {
                let _owner = create_with(&root, |path| {
                    println!("resource-owner-ready:{}", path.display());
                    std::io::stdout().flush().unwrap();
                    std::io::stdin().read_exact(&mut [0]).unwrap();
                })
                .unwrap();
            }
            _ => panic!("unknown resource owner test operation"),
        }
    }
}
