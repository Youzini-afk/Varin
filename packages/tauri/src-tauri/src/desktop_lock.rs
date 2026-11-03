//! Cross-shell lease. Published directories always contain a complete owner
//! record. A dead owner is renamed to its token-specific, nonempty tombstone:
//! competing reclaimers cannot rename a newer live lease over that tombstone.
//! No timer/mtime grants authority to take a live or indeterminate lease.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub schema: u32,
    pub pid: u32,
    pub token: String,
    pub shell: String,
}
pub struct Lease {
    root: PathBuf,
    record: Record,
}
impl Lease {
    pub fn acquire(data: &Path) -> Result<Self, String> {
        fs::create_dir_all(data).map_err(|_| "Desktop data directory is unavailable")?;
        let data = data
            .canonicalize()
            .map_err(|_| "Desktop data directory is unavailable")?;
        let root = data.join(".desktop-session.lock");
        for _ in 0..4 {
            match fs::symlink_metadata(&root) {
                Ok(_) => {
                    let record = read_record(&root)?;
                    if process_alive(record.pid)? {
                        return Err("Another Varin desktop is using this data directory. Close it before switching desktop engines.".into());
                    }
                    let tombstone = data.join(format!(".desktop-session-retired-{}", record.token));
                    // Keep the nonempty tombstone. Deleting it could let a racing
                    // reclaimer move a newly published owner's live directory.
                    match fs::rename(&root,&tombstone){Ok(())=>continue,Err(error)if matches!(error.kind(),std::io::ErrorKind::NotFound|std::io::ErrorKind::AlreadyExists|std::io::ErrorKind::DirectoryNotEmpty)=>continue,Err(_)=>return Err("Desktop lease recovery is unconfirmed; original owner record was retained".into())}
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Desktop lease could not be inspected".into()),
            }
            let record = Record {
                schema: 1,
                pid: std::process::id(),
                token: uuid::Uuid::new_v4().to_string(),
                shell: "tauri".into(),
            };
            let candidate = data.join(format!(".desktop-session-pending-{}", record.token));
            fs::create_dir(&candidate).map_err(|_| "Desktop lease could not be prepared")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&candidate, fs::Permissions::from_mode(0o700))
                    .map_err(|_| "Desktop lease permissions could not be set")?;
            }
            let prepared = (|| -> Result<(), String> {
                let mut file = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(candidate.join("owner.json"))
                    .map_err(|_| "Desktop lease record could not be prepared")?;
                file.write_all(
                    &serde_json::to_vec(&record).map_err(|_| "Desktop lease record is invalid")?,
                )
                .map_err(|_| "Desktop lease record could not be written")?;
                file.sync_all()
                    .map_err(|_| "Desktop lease record could not be committed")?;
                Ok(())
            })();
            if let Err(error) = prepared {
                let _ = fs::remove_dir_all(&candidate);
                return Err(error);
            }
            match fs::rename(&candidate, &root) {
                Ok(()) => return Ok(Self { root, record }),
                Err(_) => {
                    let _ = fs::remove_dir_all(&candidate);
                }
            }
        }
        Err("Desktop lease changed during startup; retry after the other desktop closes".into())
    }
    pub fn record(&self) -> Record {
        self.record.clone()
    }
    pub fn verify(&self) -> Result<(), String> {
        let record = read_record(&self.root)?;
        if record.token != self.record.token || record.pid != self.record.pid {
            return Err("Desktop data ownership changed".into());
        }
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if self.verify().is_err() {
            return;
        }
        let released = self
            .root
            .with_file_name(format!(".desktop-session-released-{}", self.record.token));
        if fs::rename(&self.root, &released).is_ok() {
            let _ = fs::remove_dir_all(released);
        }
    }
}
fn read_record(root: &Path) -> Result<Record, String> {
    let meta = fs::symlink_metadata(root).map_err(|_| "Desktop lease owner is unavailable")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("Desktop lease is not a private owner directory".into());
    }
    let path = root.join("owner.json");
    let meta = fs::symlink_metadata(&path)
        .map_err(|_| "Desktop lease is incomplete; no stale timeout is assumed")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4096 {
        return Err("Desktop lease owner record is invalid".into());
    }
    let mut text = String::new();
    fs::File::open(path)
        .map_err(|_| "Desktop lease owner could not be read")?
        .take(4097)
        .read_to_string(&mut text)
        .map_err(|_| "Desktop lease owner could not be read")?;
    let record: Record =
        serde_json::from_str(&text).map_err(|_| "Desktop lease owner record is invalid")?;
    if record.schema != 1
        || record.pid == 0
        || uuid::Uuid::parse_str(&record.token).is_err()
        || !matches!(record.shell.as_str(), "tauri" | "electron" | "migration")
    {
        return Err("Desktop lease owner record is invalid".into());
    }
    Ok(record)
}
#[cfg(unix)]
fn process_alive(pid: u32) -> Result<bool, String> {
    if pid > i32::MAX as u32 {
        return Err("Desktop owner process cannot be inspected".into());
    }
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if unsafe { kill(pid as i32, 0) } == 0 {
        return Ok(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(3) => Ok(false),
        Some(1 | 13) => Ok(true),
        _ => Err("Desktop owner process state is unknown".into()),
    }
}
#[cfg(windows)]
fn process_alive(pid: u32) -> Result<bool, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError},
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return if GetLastError() == ERROR_INVALID_PARAMETER {
                Ok(false)
            } else {
                Err("Desktop owner process state is unknown".into())
            };
        }
        let mut code = 0;
        let ok = GetExitCodeProcess(process, &mut code);
        CloseHandle(process);
        if ok == 0 {
            Err("Desktop owner process state is unknown".into())
        } else {
            Ok(code == 259)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lease_is_exclusive_and_released_by_only_its_owner() {
        let root = tempfile::tempdir().unwrap();
        let lease = Lease::acquire(root.path()).unwrap();
        assert!(Lease::acquire(root.path()).is_err());
        lease.verify().unwrap();
        drop(lease);
        Lease::acquire(root.path()).unwrap();
    }
    #[test]
    fn incomplete_owner_is_never_taken_over_by_elapsed_time() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".desktop-session.lock")).unwrap();
        assert!(
            Lease::acquire(root.path())
                .err()
                .unwrap()
                .contains("incomplete")
        );
    }
    #[test]
    fn nonempty_tombstone_prevents_a_late_reclaimer_stealing_the_next_lease() {
        let root = tempfile::tempdir().unwrap();
        let first = Lease::acquire(root.path()).unwrap();
        let retired = root
            .path()
            .join(format!(".desktop-session-retired-{}", first.record.token));
        fs::rename(&first.root, &retired).unwrap();
        let next = Lease::acquire(root.path()).unwrap();
        assert!(fs::rename(&next.root, &retired).is_err());
        next.verify().unwrap();
    }
    #[test]
    fn node_and_rust_share_one_real_process_lease_and_recover_only_after_exit() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let data = tempfile::tempdir().unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let source =
            repo.join("packages/web/application-host/lib/platform/desktop-session-lease.ts");
        let script = format!(
            "import {{acquireDesktopSessionLease}} from {};const lease=acquireDesktopSessionLease(process.argv[1]);process.stdout.write('owned\\n');process.stdin.resume();process.stdin.on('end',()=>{{lease.release();process.exit(0);}});",
            serde_json::to_string(&url::Url::from_file_path(source).unwrap().to_string()).unwrap()
        );
        let mut child = Command::new("node")
            .args(["--import", "tsx", "--input-type=module", "-e", &script])
            .arg(data.path())
            .current_dir(repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("Node development runtime is required");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "owned");
        assert!(Lease::acquire(data.path()).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        let lease = Lease::acquire(data.path()).unwrap();
        lease.verify().unwrap();
        drop(lease);
    }
}
