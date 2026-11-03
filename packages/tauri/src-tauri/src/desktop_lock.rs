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
    boot: Option<BootIdentity>,
}
impl Lease {
    pub fn acquire(data: &Path) -> Result<Self, String> {
        Self::acquire_with_identity(data, current_boot_identity())
    }
    fn acquire_with_identity(data: &Path, boot: Option<BootIdentity>) -> Result<Self, String> {
        fs::create_dir_all(data).map_err(|_| "Desktop data directory is unavailable")?;
        let data = data
            .canonicalize()
            .map_err(|_| "Desktop data directory is unavailable")?;
        let root = data.join(".desktop-session.lock");
        for _ in 0..4 {
            match fs::symlink_metadata(&root) {
                Ok(_) => {
                    let record = read_record(&root)?;
                    let prior_boot =
                        boot_relation(&root, &record, boot.as_ref())? == BootRelation::Previous;
                    if !prior_boot && process_alive(record.pid)? {
                        return Err("Another Varin desktop is using this data directory. Close it before switching desktop engines.".into());
                    }
                    if !prior_boot {
                        scopes_ended(&root, &record)?;
                    }
                    // A different boot on this same host proves executor death,
                    // not successful drain. Retire unchanged receipts for review.
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
                if let Some(identity) = &boot {
                    write_boot_proof(&candidate, &record, identity)?;
                }
                Ok(())
            })();
            if let Err(error) = prepared {
                let _ = fs::remove_dir_all(&candidate);
                return Err(error);
            }
            match fs::rename(&candidate, &root) {
                Ok(()) => return Ok(Self { root, record, boot }),
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
        if record.token != self.record.token
            || record.pid != self.record.pid
            || boot_relation(&self.root, &record, self.boot.as_ref())? == BootRelation::Previous
        {
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
// Keep owner.json and scope schema 1 compatible with the transition exporter.
// This sidecar is committed inside the candidate directory before publication.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootIdentity {
    host_uuid: String,
    boot_uuid: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootProof {
    schema: u32,
    source: String,
    owner_token: String,
    owner_pid: u32,
    identity: BootIdentity,
}
#[derive(PartialEq, Eq, Debug)]
enum BootRelation {
    Unrecorded,
    Current,
    Previous,
}
fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .is_ok_and(|id| !id.is_nil() && id.hyphenated().to_string() == value)
}
fn boot_relation(
    root: &Path,
    owner: &Record,
    current: Option<&BootIdentity>,
) -> Result<BootRelation, String> {
    let path = root.join("boot-session.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BootRelation::Unrecorded);
        }
        Err(_) => return Err("Desktop boot identity cannot be inspected".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err("Desktop boot identity is invalid".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Desktop boot identity cannot be read")?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Desktop boot identity cannot be read")?;
    if bytes.len() > 4096 {
        return Err("Desktop boot identity is invalid".into());
    }
    let proof: BootProof =
        serde_json::from_slice(&bytes).map_err(|_| "Desktop boot identity is invalid")?;
    if proof.schema != 1
        || proof.source != "darwin-platform-boot-v1"
        || proof.owner_token != owner.token
        || proof.owner_pid != owner.pid
        || !canonical_uuid(&proof.identity.host_uuid)
        || !canonical_uuid(&proof.identity.boot_uuid)
    {
        return Err("Desktop boot identity does not match its original owner".into());
    }
    let current = current.ok_or(
        "Current desktop host/boot identity is unavailable; original ownership is retained",
    )?;
    if !canonical_uuid(&current.host_uuid)
        || !canonical_uuid(&current.boot_uuid)
        || current.host_uuid != proof.identity.host_uuid
    {
        // In particular, never apply local PID liveness to an owner of a shared
        // data root on another host, even if its boot UUID is different.
        return Err(
            "Desktop data belongs to another or unconfirmed host; original ownership is retained"
                .into(),
        );
    }
    Ok(if current.boot_uuid == proof.identity.boot_uuid {
        BootRelation::Current
    } else {
        BootRelation::Previous
    })
}
fn require_current_boot(root: &Path, owner: &Record) -> Result<(), String> {
    if boot_relation(root, owner, current_boot_identity().as_ref())? == BootRelation::Previous {
        return Err("Desktop ownership belongs to a previous operating-system boot".into());
    }
    Ok(())
}
fn write_boot_proof(root: &Path, owner: &Record, identity: &BootIdentity) -> Result<(), String> {
    let proof = BootProof {
        schema: 1,
        source: "darwin-platform-boot-v1".into(),
        owner_token: owner.token.clone(),
        owner_pid: owner.pid,
        identity: identity.clone(),
    };
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(root.join("boot-session.json"))
        .map_err(|_| "Desktop boot identity could not be prepared")?;
    file.write_all(&serde_json::to_vec(&proof).map_err(|_| "Desktop boot identity is invalid")?)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Desktop boot identity could not be committed".into())
}
#[cfg(not(target_os = "macos"))]
fn current_boot_identity() -> Option<BootIdentity> {
    None
}
#[cfg(target_os = "macos")]
fn current_boot_identity() -> Option<BootIdentity> {
    // XNU gethostuuid reads IOPlatformUUID, the same property used by the Node
    // owner. Neither value is supplied by an environment variable or wall clock.
    let mut host = [0u8; 16];
    let timeout = libc::timespec {
        tv_sec: 1,
        tv_nsec: 0,
    };
    if unsafe { libc::gethostuuid(host.as_mut_ptr(), &timeout) } != 0 {
        return None;
    }
    let host_uuid = uuid::Uuid::from_bytes(host).hyphenated().to_string();
    let mut boot = [0u8; 37];
    let mut size = boot.len();
    if unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            boot.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || size != boot.len()
        || boot[36] != 0
    {
        return None;
    }
    let boot_uuid = std::str::from_utf8(&boot[..36]).ok()?.to_ascii_lowercase();
    if !canonical_uuid(&host_uuid) || !canonical_uuid(&boot_uuid) {
        return None;
    }
    Some(BootIdentity {
        host_uuid,
        boot_uuid,
    })
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
        require_current_boot(&root, &owner)?;
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
        require_current_boot(root, &owner)?;
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
        require_current_boot(root, &owner)?;
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
    fn identity() -> BootIdentity {
        BootIdentity {
            host_uuid: uuid::Uuid::new_v4().to_string(),
            boot_uuid: uuid::Uuid::new_v4().to_string(),
        }
    }
    #[test]
    fn proven_reboot_retires_unconfirmed_scope_despite_reused_live_pid() {
        let data = tempfile::tempdir().unwrap();
        let old = Lease::acquire_with_identity(data.path(), None).unwrap();
        let scope = ScopeLease::prepare(data.path()).unwrap();
        scope
            .mark_active(std::process::id(), std::process::id())
            .unwrap();
        let before = identity();
        write_boot_proof(&old.root, &old.record, &before).unwrap();
        let current = BootIdentity {
            boot_uuid: uuid::Uuid::new_v4().to_string(),
            ..before
        };
        let next = Lease::acquire_with_identity(data.path(), Some(current)).unwrap();
        assert_ne!(next.record.token, old.record.token);
        next.verify().unwrap();
        let retired = data
            .path()
            .join(format!(".desktop-session-retired-{}", old.record.token));
        let original = read_scope(
            &retired.join("scopes").join(scope.path.file_name().unwrap()),
            &old.record,
        )
        .unwrap();
        assert_eq!(
            original.phase, "active",
            "reboot cannot fabricate a successful drain"
        );
        drop(old);
        next.verify().unwrap();
    }
    #[test]
    fn only_same_host_and_a_different_known_boot_grant_recovery() {
        let data = tempfile::tempdir().unwrap();
        let before = identity();
        let old = Lease::acquire_with_identity(data.path(), Some(before.clone())).unwrap();
        assert!(Lease::acquire_with_identity(data.path(), Some(before.clone())).is_err());
        assert!(
            Lease::acquire_with_identity(data.path(), None)
                .err()
                .unwrap()
                .contains("unavailable")
        );
        assert!(
            Lease::acquire_with_identity(data.path(), Some(identity()))
                .err()
                .unwrap()
                .contains("another")
        );
        old.verify().unwrap();
        fs::remove_file(old.root.join("boot-session.json")).unwrap();
        assert!(
            Lease::acquire_with_identity(data.path(), Some(identity())).is_err(),
            "old missing proof grants no reboot inference"
        );
    }
    #[test]
    fn missing_or_same_boot_proof_cannot_retire_a_dead_owners_active_scope() {
        let data = tempfile::tempdir().unwrap();
        let old = Lease::acquire_with_identity(data.path(), None).unwrap();
        let scope = ScopeLease::prepare(data.path()).unwrap();
        let mut child = std::process::Command::new("node")
            .args(["-e", "process.exit(0)"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!process_alive(pid).unwrap());
        let mut owner = old.record.clone();
        owner.pid = pid;
        let mut pending: serde_json::Value =
            serde_json::from_slice(&fs::read(scope.path()).unwrap()).unwrap();
        pending["shellPid"] = serde_json::json!(pid);
        fs::write(
            old.root.join("owner.json"),
            serde_json::to_vec(&owner).unwrap(),
        )
        .unwrap();
        fs::write(scope.path(), serde_json::to_vec(&pending).unwrap()).unwrap();
        let boot = identity();
        assert!(
            Lease::acquire_with_identity(data.path(), Some(boot.clone()))
                .err()
                .unwrap()
                .contains("not confirmed termination")
        );
        write_boot_proof(&old.root, &owner, &boot).unwrap();
        assert!(
            Lease::acquire_with_identity(data.path(), Some(boot))
                .err()
                .unwrap()
                .contains("not confirmed termination")
        );
        assert!(
            Lease::acquire_with_identity(data.path(), Some(identity()))
                .err()
                .unwrap()
                .contains("another")
        );
        assert!(old.root.exists());
    }
    #[test]
    fn malformed_or_foreign_boot_sidecars_never_relax_the_original_lease() {
        let data = tempfile::tempdir().unwrap();
        let before = identity();
        let old = Lease::acquire_with_identity(data.path(), Some(before.clone())).unwrap();
        let path = old.root.join("boot-session.json");
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for (key, value) in [
            ("schema", serde_json::json!(2)),
            (
                "ownerToken",
                serde_json::json!(uuid::Uuid::new_v4().to_string()),
            ),
            ("ownerPid", serde_json::json!(0)),
            ("source", serde_json::json!("clock")),
            ("extra", serde_json::json!(true)),
            (
                "identity",
                serde_json::json!({"hostUuid":before.host_uuid,"bootUuid":"00000000-0000-0000-0000-000000000000"}),
            ),
        ] {
            let mut changed = original.clone();
            changed[key] = value;
            fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(Lease::acquire_with_identity(data.path(), Some(before.clone())).is_err());
        }
        fs::write(&path, b"{").unwrap();
        assert!(Lease::acquire_with_identity(data.path(), Some(before)).is_err());
        assert!(old.root.exists());
    }
    #[test]
    fn concurrent_reboot_reclaimers_cannot_retire_the_new_live_owner() {
        let data = tempfile::tempdir().unwrap();
        let before = identity();
        let old = Lease::acquire_with_identity(data.path(), Some(before.clone())).unwrap();
        let current = BootIdentity {
            boot_uuid: uuid::Uuid::new_v4().to_string(),
            ..before
        };
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let path = data.path().to_owned();
                let identity = current.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    Lease::acquire_with_identity(&path, Some(identity))
                })
            })
            .collect();
        let winners: Vec<_> = workers
            .into_iter()
            .filter_map(|worker| worker.join().unwrap().ok())
            .collect();
        assert_eq!(winners.len(), 1);
        drop(old);
        winners[0].verify().unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_boot_identity_is_stable_and_matches_the_node_owner() {
        let first = current_boot_identity()
            .expect("macOS qualification requires readable host and boot UUIDs");
        assert_eq!(current_boot_identity().unwrap(), first);
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/application-host/lib/platform/desktop-boot-identity.ts");
        let script = format!(
            "import {{currentDesktopBootIdentity}} from {};process.stdout.write(JSON.stringify(currentDesktopBootIdentity()));",
            serde_json::to_string(
                url::Url::from_file_path(source.canonicalize().unwrap())
                    .unwrap()
                    .as_str()
            )
            .unwrap()
        );
        let output = std::process::Command::new("node")
            .args(["--import", "tsx", "--input-type=module", "-e", &script])
            .output()
            .unwrap();
        assert!(output.status.success());
        let node: BootIdentity = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(node, first);
    }
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
