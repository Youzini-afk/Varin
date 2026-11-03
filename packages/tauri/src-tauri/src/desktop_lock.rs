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
                    scopes_ended(&root, &record)?;
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
        if self.verify().is_err() || scopes_ended(&self.root, &self.record).is_err() {
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
/// A managed process scope must settle independently of the shell PID. The
/// guardian commits this receipt only after the original OS scope is empty.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopeRecord {
    schema: u32,
    token: String,
    lease_token: String,
    shell_pid: u32,
    phase: String,
    guardian_pid: Option<u32>,
    node_pid: Option<u32>,
}
#[derive(Clone)]
pub struct ScopeLease {
    path: PathBuf,
    token: String,
    lease_token: String,
}
impl ScopeLease {
    pub fn prepare(data: &Path) -> Result<Self, String> {
        let root = data
            .canonicalize()
            .map_err(|_| "Desktop data directory is unavailable")?
            .join(".desktop-session.lock");
        let owner = read_record(&root)?;
        if owner.pid != std::process::id() || owner.shell != "tauri" {
            return Err("Managed service does not own the original desktop lease".into());
        }
        let scopes = root.join("scopes");
        match fs::create_dir(&scopes) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&scopes, fs::Permissions::from_mode(0o700))
                        .map_err(|_| "Managed scope directory is not private")?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("Managed scope directory could not be prepared".into()),
        }
        let metadata =
            fs::symlink_metadata(&scopes).map_err(|_| "Managed scope directory is unavailable")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Managed scope directory is invalid".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        let lease = Self {
            path: scopes.join(format!("{token}.json")),
            token: token.clone(),
            lease_token: owner.token.clone(),
        };
        let record = ScopeRecord {
            schema: 1,
            token,
            lease_token: owner.token,
            shell_pid: owner.pid,
            phase: "pending".into(),
            guardian_pid: None,
            node_pid: None,
        };
        lease.write(&record, true)?;
        Ok(lease)
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn open(path: &Path, token: &str) -> Result<Self, String> {
        let scopes = path.parent().ok_or("Managed scope path is invalid")?;
        if scopes.file_name().and_then(|s| s.to_str()) != Some("scopes") {
            return Err("Managed scope path is invalid".into());
        }
        let root = scopes.parent().ok_or("Managed scope path is invalid")?;
        let owner = read_record(root)?;
        let record = read_scope(path, &owner)?;
        if record.token != token
            || path.file_name().and_then(|s| s.to_str()) != Some(format!("{token}.json").as_str())
        {
            return Err("Managed scope identity changed".into());
        }
        Ok(Self {
            path: path.to_owned(),
            token: token.into(),
            lease_token: owner.token,
        })
    }
    pub fn mark_active(&self, guardian_pid: u32, node_pid: u32) -> Result<(), String> {
        if guardian_pid == 0 || node_pid == 0 {
            return Err("Managed scope process identity is invalid".into());
        }
        let mut record = self.read()?;
        if record.phase != "pending" {
            return Err("Managed scope was already admitted".into());
        }
        record.guardian_pid = Some(guardian_pid);
        record.node_pid = Some(node_pid);
        record.phase = "active".into();
        self.write(&record, false)
    }
    /// Also valid for a failed preparation only when no process was started.
    pub fn mark_ended(&self) -> Result<(), String> {
        let mut record = self.read()?;
        record.phase = "ended".into();
        self.write(&record, false)
    }
    fn read(&self) -> Result<ScopeRecord, String> {
        let root = self
            .path
            .parent()
            .and_then(Path::parent)
            .ok_or("Managed scope path is invalid")?;
        let owner = read_record(root)?;
        let record = read_scope(&self.path, &owner)?;
        if owner.token != self.lease_token || record.token != self.token {
            return Err("Managed scope identity changed".into());
        }
        Ok(record)
    }
    fn write(&self, record: &ScopeRecord, initial: bool) -> Result<(), String> {
        let output = if initial {
            self.path.clone()
        } else {
            self.path
                .with_extension(format!("pending-{}", uuid::Uuid::new_v4()))
        };
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&output)
            .map_err(|_| "Managed scope receipt could not be prepared")?;
        let result = (|| {
            file.write_all(
                &serde_json::to_vec(record).map_err(|_| "Managed scope receipt is invalid")?,
            )
            .map_err(|_| "Managed scope receipt could not be written")?;
            file.sync_all()
                .map_err(|_| "Managed scope receipt could not be committed")?;
            if !initial {
                fs::rename(&output, &self.path)
                    .map_err(|_| "Managed scope receipt could not be published")?;
            }
            Ok(())
        })();
        if result.is_err() && !initial {
            let _ = fs::remove_file(output);
        }
        result
    }
}
fn read_scope(path: &Path, owner: &Record) -> Result<ScopeRecord, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "Managed scope receipt is unavailable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("Managed scope receipt is invalid".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Managed scope receipt cannot be read")?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Managed scope receipt cannot be read")?;
    if bytes.len() > 4096 {
        return Err("Managed scope receipt is invalid".into());
    }
    let record: ScopeRecord = serde_json::from_slice(&bytes)
        .map_err(|_| "Managed scope receipt is incomplete; cleanup remains unconfirmed")?;
    if record.schema != 1
        || uuid::Uuid::parse_str(&record.token).is_err()
        || record.lease_token != owner.token
        || record.shell_pid != owner.pid
        || !matches!(record.phase.as_str(), "pending" | "active" | "ended")
        || record.guardian_pid == Some(0)
        || record.node_pid == Some(0)
        || record.phase == "active" && (record.guardian_pid.is_none() || record.node_pid.is_none())
    {
        return Err("Managed scope receipt is invalid".into());
    }
    Ok(record)
}
fn scopes_ended(root: &Path, owner: &Record) -> Result<(), String> {
    let directory = root.join("scopes");
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Managed scope records cannot be inspected".into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Managed scope directory is invalid".into());
    }
    for entry in fs::read_dir(directory).map_err(|_| "Managed scope records cannot be inspected")? {
        let entry = entry.map_err(|_| "Managed scope records cannot be inspected")?;
        let record = read_scope(&entry.path(), owner)?;
        if entry.file_name().to_str() != Some(format!("{}.json", record.token).as_str())
            || record.phase != "ended"
        {
            return Err("The previous desktop's managed services have not confirmed termination; original data ownership is retained".into());
        }
    }
    Ok(())
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
    fn managed_scope_receipt_prevents_release_until_original_scope_ends() {
        let root = tempfile::tempdir().unwrap();
        let lease = Lease::acquire(root.path()).unwrap();
        let scope = ScopeLease::prepare(root.path()).unwrap();
        assert!(scopes_ended(&lease.root, &lease.record).is_err());
        let inherited = ScopeLease::open(scope.path(), scope.token()).unwrap();
        inherited
            .mark_active(std::process::id(), std::process::id())
            .unwrap();
        assert!(scopes_ended(&lease.root, &lease.record).is_err());
        assert!(
            inherited
                .mark_active(std::process::id(), std::process::id())
                .is_err()
        );
        assert!(ScopeLease::open(scope.path(), &uuid::Uuid::new_v4().to_string()).is_err());
        inherited.mark_ended().unwrap();
        scopes_ended(&lease.root, &lease.record).unwrap();
        drop(lease);
        assert!(!root.path().join(".desktop-session.lock").exists());
    }
    #[test]
    fn dropping_a_shell_lease_does_not_discard_an_unconfirmed_scope() {
        let root = tempfile::tempdir().unwrap();
        let lease = Lease::acquire(root.path()).unwrap();
        let _scope = ScopeLease::prepare(root.path()).unwrap();
        drop(lease);
        assert!(root.path().join(".desktop-session.lock").is_dir());
        assert!(Lease::acquire(root.path()).is_err());
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
