//! A second launch must not open CEF before the data lease is resolved. Forward
//! only to the *original live owner* over the pinned single-instance plugin's
//! transport. This is a client adapter, not another listener or lease owner.
//!
//! Wire contract: tauri-plugin-single-instance 3.0.0-alpha.3, without `semver`.
//! Do not include arguments, cwd, transport errors, or pairing URLs in errors.
use crate::desktop_lock::{Lease, Record, verified_live_tauri_owner};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const PROOF_FILE: &str = "activation-owner.json";
const FORWARD_TIMEOUT: Duration = Duration::from_secs(10);
const IDENTITY_ERROR: &str = "Original desktop activation owner could not be verified";
const ENDPOINT_ERROR: &str = "Original desktop activation endpoint could not be verified";
const FORWARD_ERROR: &str =
    "Desktop activation was not confirmed; original data ownership is retained";

/// Window restoration is separate from deep-link delivery. Coalesce requests
/// received before the primary window exists; startup alone owns its creation.
#[derive(Default)]
pub(crate) struct RestoreIntents(std::sync::Mutex<(bool, bool)>);
impl RestoreIntents {
    pub(crate) fn request(&self) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Desktop activation queue is unavailable")?
            .1 = true;
        Ok(())
    }
    pub(crate) fn ready(&self) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Desktop activation queue is unavailable")?
            .0 = true;
        Ok(())
    }
    pub(crate) fn take_ready(&self) -> Result<bool, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Desktop activation queue is unavailable")?;
        if !state.0 {
            return Ok(false);
        }
        Ok(std::mem::take(&mut state.1))
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "platform", rename_all = "camelCase", deny_unknown_fields)]
enum Generation {
    Linux {
        boot_id: String,
        start_ticks: u64,
    },
    Windows {
        creation_time: u64,
    },
    Macos {
        boot_id: String,
        start_seconds: u64,
        start_microseconds: u64,
    },
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    schema: u32,
    owner_token: String,
    owner_pid: u32,
    generation: Generation,
}

/// Called once by the ordinary lease owner before initializing the engine.
/// The migration helper must neither publish nor replace this proof.
pub(crate) fn publish(data: &Path, lease: &Lease) -> Result<(), String> {
    lease.verify()?;
    let record = lease.record();
    if record.pid != std::process::id() || record.shell != "tauri" {
        return Err(IDENTITY_ERROR.into());
    }
    let process = Process::inspect(record.pid)?;
    let proof = Proof {
        schema: 1,
        owner_token: record.token.clone(),
        owner_pid: record.pid,
        generation: process.generation()?,
    };
    let root = data
        .canonicalize()
        .map_err(|_| IDENTITY_ERROR)?
        .join(".desktop-session.lock");
    // Publish only complete, synced bytes. A concurrent launch observes either
    // absence (owner still preparing) or a valid proof, never a partial write.
    let candidate = root.join(format!(
        ".activation-owner-pending-{}",
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), String> {
        let mut file = options.open(&candidate).map_err(|_| IDENTITY_ERROR)?;
        file.write_all(&serde_json::to_vec(&proof).map_err(|_| IDENTITY_ERROR)?)
            .and_then(|_| file.sync_all())
            .map_err(|_| IDENTITY_ERROR)?;
        lease.verify()?;
        // Creating this link is atomic and refuses an existing proof on every
        // supported platform. A plain rename could overwrite it on Unix.
        fs::hard_link(&candidate, root.join(PROOF_FILE)).map_err(|_| IDENTITY_ERROR)?;
        lease.verify()
    })();
    let _ = fs::remove_file(candidate);
    result
}

struct Owner {
    data: PathBuf,
    record: Record,
    process: Process,
    generation: Generation,
}
impl Owner {
    fn capture(data: &Path) -> Result<Self, String> {
        let data = data.canonicalize().map_err(|_| IDENTITY_ERROR)?;
        let record = verified_live_tauri_owner(&data)?;
        let process = Process::inspect(record.pid)?;
        let generation = process.generation()?;
        let owner = Self {
            data,
            record,
            process,
            generation,
        };
        owner.verify()?;
        Ok(owner)
    }
    #[cfg(test)]
    fn load(data: &Path) -> Result<Self, String> {
        let owner = Self::capture(data)?;
        if !owner.proof_ready()? {
            return Err(IDENTITY_ERROR.into());
        }
        Ok(owner)
    }
    fn proof_ready(&self) -> Result<bool, String> {
        self.verify()?;
        let path = self.data.join(".desktop-session.lock").join(PROOF_FILE);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(IDENTITY_ERROR.into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err(IDENTITY_ERROR.into());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| IDENTITY_ERROR)?
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| IDENTITY_ERROR)?;
        let proof: Proof = serde_json::from_slice(&bytes).map_err(|_| IDENTITY_ERROR)?;
        if proof.schema != 1
            || proof.owner_token != self.record.token
            || proof.owner_pid != self.record.pid
            || proof.generation != self.generation
        {
            return Err(IDENTITY_ERROR.into());
        }
        self.verify()?;
        Ok(true)
    }
    fn verify(&self) -> Result<(), String> {
        let record = verified_live_tauri_owner(&self.data)?;
        if record.token != self.record.token
            || record.pid != self.record.pid
            || self.process.generation()? != self.generation
        {
            return Err(IDENTITY_ERROR.into());
        }
        Ok(())
    }
    fn verify_endpoint(&self, pid: u32) -> Result<(), String> {
        if pid != self.record.pid {
            return Err(ENDPOINT_ERROR.into());
        }
        self.verify()
    }
}

struct Activation {
    args: Vec<String>,
    cwd: String,
}
impl Activation {
    fn current() -> Self {
        Self {
            args: std::env::args_os()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect(),
            cwd: std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        }
    }
    fn validate(&self) -> Result<(), String> {
        if self.cwd.contains('\0') || self.args.iter().any(|arg| arg.contains('\0')) {
            return Err(FORWARD_ERROR.into());
        }
        Ok(())
    }
}

pub(crate) fn forward_to_owner(data: &Path, identifier: &str) -> Result<(), String> {
    let owner = Owner::capture(data)?;
    let activation = Activation::current();
    activation.validate()?;
    wait_for_ready(&owner, || forward_platform(&owner, &activation, identifier))
}

/// False means no payload was sent because the original owner's endpoint is
/// not ready. Once any send is attempted, both success and error are terminal:
/// a timeout or lost reply is an unknown effect and must never be replayed.
fn wait_for_ready(
    owner: &Owner,
    attempt: impl FnMut() -> Result<bool, String>,
) -> Result<(), String> {
    wait_for_ready_observed(owner, attempt, |_| {})
}

fn wait_for_ready_observed(
    owner: &Owner,
    mut attempt: impl FnMut() -> Result<bool, String>,
    mut pending: impl FnMut(bool),
) -> Result<(), String> {
    let deadline = Instant::now() + FORWARD_TIMEOUT;
    loop {
        owner.verify()?;
        let proof_ready = owner.proof_ready()?;
        if proof_ready && attempt()? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ENDPOINT_ERROR.into());
        }
        pending(proof_ready);
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
struct Process {
    pid: u32,
}
#[cfg(target_os = "linux")]
impl Process {
    fn inspect(pid: u32) -> Result<Self, String> {
        let process = Self { pid };
        process.generation()?;
        Ok(process)
    }
    fn generation(&self) -> Result<Generation, String> {
        let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map_err(|_| IDENTITY_ERROR)?
            .trim()
            .to_owned();
        if uuid::Uuid::parse_str(&boot_id).is_err() {
            return Err(IDENTITY_ERROR.into());
        }
        let stat =
            fs::read_to_string(format!("/proc/{}/stat", self.pid)).map_err(|_| IDENTITY_ERROR)?;
        let start_ticks = linux_start_ticks(&stat, self.pid)?;
        Ok(Generation::Linux {
            boot_id,
            start_ticks,
        })
    }
}
#[cfg(target_os = "linux")]
fn linux_start_ticks(stat: &str, pid: u32) -> Result<u64, String> {
    // comm can contain whitespace, newlines, and closing parentheses. The last
    // ')' delimits it; field 22 is starttime, field 3 is process state.
    let (head, tail) = stat.rsplit_once(')').ok_or(IDENTITY_ERROR)?;
    let (actual_pid, _) = head.split_once(" (").ok_or(IDENTITY_ERROR)?;
    let fields: Vec<_> = tail.split_ascii_whitespace().collect();
    if actual_pid.parse::<u32>().ok() != Some(pid)
        || fields.len() < 20
        || matches!(fields[0], "Z" | "X" | "x")
    {
        return Err(IDENTITY_ERROR.into());
    }
    fields[19].parse().map_err(|_| IDENTITY_ERROR.into())
}

#[cfg(all(target_os = "linux", any(feature = "desktop", test)))]
fn forward_platform(
    owner: &Owner,
    activation: &Activation,
    identifier: &str,
) -> Result<bool, String> {
    let address = local_bus_address(zbus::Address::session().map_err(|_| ENDPOINT_ERROR)?)?;
    let connection = zbus::blocking::connection::Builder::address(address)
        .map_err(|_| ENDPOINT_ERROR)?
        .method_timeout(FORWARD_TIMEOUT)
        .build()
        .map_err(|_| ENDPOINT_ERROR)?;
    forward_linux(owner, activation, identifier, &connection)
}
#[cfg(all(target_os = "linux", any(feature = "desktop", test)))]
fn local_bus_address(address: zbus::Address) -> Result<zbus::Address, String> {
    // The plugin's service is a local desktop process. A TCP or unixexec
    // address cannot provide the kernel-authenticated session bus we require.
    if !matches!(address.transport(), zbus::address::Transport::Unix(_)) {
        return Err(ENDPOINT_ERROR.into());
    }
    Ok(address)
}
#[cfg(all(target_os = "linux", any(feature = "desktop", test)))]
fn forward_linux(
    owner: &Owner,
    activation: &Activation,
    identifier: &str,
    connection: &zbus::blocking::Connection,
) -> Result<bool, String> {
    // zbus 5.19's replacement blocking peer_creds is accidentally async.
    // The still-supported synchronous method obtains kernel socket credentials.
    #[allow(deprecated)]
    let credentials = connection.peer_credentials().map_err(|_| ENDPOINT_ERROR)?;
    if credentials.unix_user_id() != Some(unsafe { libc::geteuid() }) {
        return Err(ENDPOINT_ERROR.into());
    }
    let name = format!("{identifier}.SingleInstance");
    let path = format!("/{}", name.replace('.', "/").replace('-', "_"));
    let bus = zbus::blocking::fdo::DBusProxy::new(connection).map_err(|_| ENDPOINT_ERROR)?;
    let unique = match bus.get_name_owner(name.as_str().try_into().map_err(|_| ENDPOINT_ERROR)?) {
        Ok(unique) => unique,
        Err(zbus::fdo::Error::NameHasNoOwner(_)) => return Ok(false),
        Err(_) => return Err(ENDPOINT_ERROR.into()),
    };
    let pid = bus
        .get_connection_unix_process_id(unique.as_ref().into())
        .map_err(|_| ENDPOINT_ERROR)?;
    owner.verify_endpoint(pid)?;
    // Address the authenticated connection, not the replaceable well-known
    // name. Losing that connection cannot redirect a secret-bearing argument.
    connection
        .call_method(
            Some(unique.as_str()),
            path.as_str(),
            Some("org.SingleInstance.DBus"),
            "ExecuteCallback",
            &(&activation.args, &activation.cwd),
        )
        .map_err(|_| FORWARD_ERROR)?;
    Ok(true)
}

#[cfg(windows)]
struct Process {
    handle: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(windows)]
impl Process {
    fn inspect(pid: u32) -> Result<Self, String> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        };
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(IDENTITY_ERROR.into());
        }
        let process = Self { handle };
        process.generation()?;
        Ok(process)
    }
    fn generation(&self) -> Result<Generation, String> {
        use windows_sys::Win32::{
            Foundation::{FILETIME, WAIT_TIMEOUT},
            System::Threading::{GetProcessTimes, WaitForSingleObject},
        };
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe {
            if WaitForSingleObject(self.handle, 0) != WAIT_TIMEOUT
                || GetProcessTimes(
                    self.handle,
                    &mut created,
                    &mut exited,
                    &mut kernel,
                    &mut user,
                ) == 0
            {
                return Err(IDENTITY_ERROR.into());
            }
        }
        Ok(Generation::Windows {
            creation_time: (u64::from(created.dwHighDateTime) << 32)
                | u64::from(created.dwLowDateTime),
        })
    }
}
#[cfg(windows)]
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}
#[cfg(any(windows, test))]
fn windows_payload(activation: &Activation) -> Result<Vec<u8>, String> {
    activation.validate()?;
    let mut payload = activation.cwd.clone();
    for arg in &activation.args {
        payload.push('\0');
        payload.push_str(arg);
    }
    let bytes = payload.into_bytes();
    u32::try_from(bytes.len()).map_err(|_| FORWARD_ERROR)?;
    Ok(bytes)
}
#[cfg(windows)]
fn forward_platform(
    owner: &Owner,
    activation: &Activation,
    identifier: &str,
) -> Result<bool, String> {
    use windows_sys::Win32::{
        System::DataExchange::COPYDATASTRUCT,
        UI::WindowsAndMessaging::{
            AllowSetForegroundWindow, FindWindowW, GetWindowThreadProcessId, SMTO_ABORTIFHUNG,
            SMTO_BLOCK, SMTO_ERRORONEXIT, SendMessageTimeoutW, WM_COPYDATA,
        },
    };
    let wide = |text: String| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let class = wide(format!("{identifier}-sic"));
    let title = wide(format!("{identifier}-siw"));
    let bytes = windows_payload(activation)?;
    unsafe {
        let window = FindWindowW(class.as_ptr(), title.as_ptr());
        if window.is_null() {
            return Ok(false);
        }
        let mut pid = 0;
        if GetWindowThreadProcessId(window, &mut pid) == 0 {
            return Err(ENDPOINT_ERROR.into());
        }
        owner.verify_endpoint(pid)?;
        AllowSetForegroundWindow(pid);
        let payload = COPYDATASTRUCT {
            dwData: 1543,
            cbData: bytes.len() as u32,
            lpData: bytes.as_ptr().cast_mut().cast(),
        };
        let mut accepted = 0;
        let sent = SendMessageTimeoutW(
            window,
            WM_COPYDATA,
            0,
            (&payload as *const COPYDATASTRUCT) as isize,
            SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
            FORWARD_TIMEOUT.as_millis() as u32,
            &mut accepted,
        );
        // A timeout is an unknown effect. Never retry it or release the lease.
        if sent == 0 || accepted != 1 {
            return Err(FORWARD_ERROR.into());
        }
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
struct Process {
    pid: u32,
}
#[cfg(target_os = "macos")]
impl Process {
    fn inspect(pid: u32) -> Result<Self, String> {
        let process = Self { pid };
        process.generation()?;
        Ok(process)
    }
    fn generation(&self) -> Result<Generation, String> {
        let pid = i32::try_from(self.pid).map_err(|_| IDENTITY_ERROR)?;
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        if unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        } != size
        {
            return Err(IDENTITY_ERROR.into());
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != self.pid || info.pbi_status == libc::SZOMB {
            return Err(IDENTITY_ERROR.into());
        }
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
            return Err(IDENTITY_ERROR.into());
        }
        let boot_id = std::str::from_utf8(&boot[..36])
            .map_err(|_| IDENTITY_ERROR)?
            .to_owned();
        if uuid::Uuid::parse_str(&boot_id).is_err() {
            return Err(IDENTITY_ERROR.into());
        }
        Ok(Generation::Macos {
            boot_id,
            start_seconds: info.pbi_start_tvsec,
            start_microseconds: info.pbi_start_tvusec,
        })
    }
}
#[cfg(any(target_os = "macos", test))]
fn macos_payload(activation: &Activation) -> Result<Vec<u8>, String> {
    activation.validate()?;
    Ok(format!("{}\0\0{}", activation.cwd, activation.args.join("\0")).into_bytes())
}
#[cfg(target_os = "macos")]
fn forward_platform(
    owner: &Owner,
    activation: &Activation,
    identifier: &str,
) -> Result<bool, String> {
    use std::os::{fd::AsRawFd, unix::net::UnixStream};
    let socket = format!("/tmp/{}_si.sock", identifier.replace(['.', '-'], "_"));
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(false);
        }
        Err(_) => return Err(ENDPOINT_ERROR.into()),
    };
    let mut uid = 0;
    let mut gid = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != unsafe { libc::geteuid() }
    {
        return Err(ENDPOINT_ERROR.into());
    }
    let mut pid: libc::pid_t = 0;
    let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut size,
        )
    };
    if result != 0 || size as usize != std::mem::size_of_val(&pid) || pid <= 0 {
        return Err(ENDPOINT_ERROR.into());
    }
    owner.verify_endpoint(pid as u32)?;
    stream
        .set_write_timeout(Some(FORWARD_TIMEOUT))
        .map_err(|_| FORWARD_ERROR)?;
    stream
        .write_all(&macos_payload(activation)?)
        .map_err(|_| FORWARD_ERROR)?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|_| FORWARD_ERROR)?;
    // The pinned macOS plugin has no reply. Successful transport write/EOF is
    // its acceptance boundary, not evidence the callback or navigation ran.
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    fn activation() -> Activation {
        Activation {
            cwd: "work/中文|directory".into(),
            args: vec![
                "varin".into(),
                "varin://thread/workspace/thread?test=only".into(),
                "a|b".into(),
                "".into(),
            ],
        }
    }
    fn fixture() -> (tempfile::TempDir, Lease) {
        let data = tempfile::tempdir().unwrap();
        let lease = Lease::acquire(data.path()).unwrap();
        publish(data.path(), &lease).unwrap();
        (data, lease)
    }
    fn change_proof(data: &Path, change: impl FnOnce(&mut Proof)) {
        let path = data.join(".desktop-session.lock").join(PROOF_FILE);
        let mut proof: Proof = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        change(&mut proof);
        fs::write(path, serde_json::to_vec(&proof).unwrap()).unwrap();
    }
    #[test]
    fn startup_restore_queue_defers_and_coalesces_then_accepts_later_activations() {
        let intents = RestoreIntents::default();
        intents.request().unwrap();
        assert!(
            !intents.take_ready().unwrap(),
            "activation cannot create a main before setup"
        );
        intents.request().unwrap();
        assert!(!intents.take_ready().unwrap());
        // Production marks this only after setup has built/protected main.
        intents.ready().unwrap();
        assert!(intents.take_ready().unwrap());
        assert!(
            !intents.take_ready().unwrap(),
            "early activations restore just once"
        );
        intents.ready().unwrap();
        assert!(!intents.take_ready().unwrap());
        intents.request().unwrap();
        assert!(
            intents.take_ready().unwrap(),
            "later launch restores the existing window"
        );
        assert!(!intents.take_ready().unwrap());
    }
    #[test]
    fn racing_setup_and_restore_requests_do_not_lose_the_pending_intent() {
        for _ in 0..64 {
            let intents = std::sync::Arc::new(RestoreIntents::default());
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let worker = {
                let intents = intents.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    intents.request().unwrap();
                    intents.take_ready().unwrap()
                })
            };
            barrier.wait();
            intents.ready().unwrap();
            let during_setup = intents.take_ready().unwrap();
            let during_request = worker.join().unwrap();
            let pending = intents.take_ready().unwrap();
            assert_eq!(
                usize::from(during_setup) + usize::from(during_request) + usize::from(pending),
                1
            );
        }
    }
    #[test]
    fn publication_binds_original_owner_and_does_not_replace_proof() {
        let (data, lease) = fixture();
        let owner = Owner::load(data.path()).unwrap();
        owner.verify_endpoint(std::process::id()).unwrap();
        assert!(owner.verify_endpoint(std::process::id() + 1).is_err());
        assert!(publish(data.path(), &lease).is_err());
        assert!(Lease::acquire(data.path()).is_err());
    }
    #[test]
    fn delayed_proof_and_endpoint_forward_only_after_both_are_ready() {
        use std::cell::Cell;
        let data = tempfile::tempdir().unwrap();
        let lease = Lease::acquire(data.path()).unwrap();
        let owner = Owner::capture(data.path()).unwrap();
        let endpoint = Cell::new(false);
        let dispatched = Cell::new(0);
        let stages = Cell::new(0);
        wait_for_ready_observed(
            &owner,
            || {
                if !endpoint.get() {
                    return Ok(false);
                }
                dispatched.set(dispatched.get() + 1);
                Ok(true)
            },
            |proof_ready| {
                stages.set(stages.get() + 1);
                if !proof_ready {
                    publish(data.path(), &lease).unwrap();
                } else {
                    endpoint.set(true);
                }
            },
        )
        .unwrap();
        assert_eq!(stages.get(), 2);
        assert_eq!(dispatched.get(), 1);
    }
    #[test]
    fn replaced_owner_during_readiness_wait_is_not_followed() {
        let data = tempfile::tempdir().unwrap();
        let lease = Lease::acquire(data.path()).unwrap();
        let owner = Owner::capture(data.path()).unwrap();
        let result = wait_for_ready_observed(
            &owner,
            || panic!("no payload without original proof"),
            |_| {
                let mut replacement = lease.record();
                replacement.token = uuid::Uuid::new_v4().to_string();
                fs::write(
                    data.path().join(".desktop-session.lock/owner.json"),
                    serde_json::to_vec(&replacement).unwrap(),
                )
                .unwrap();
            },
        );
        assert!(result.is_err());
        assert!(data.path().join(".desktop-session.lock").exists());
    }
    #[test]
    fn invalid_proof_and_uncertain_send_are_terminal_without_retry() {
        let (data, _lease) = fixture();
        let owner = Owner::capture(data.path()).unwrap();
        let attempts = std::cell::Cell::new(0);
        let result = wait_for_ready(&owner, || {
            attempts.set(attempts.get() + 1);
            Err(FORWARD_ERROR.into())
        });
        assert_eq!(result, Err(FORWARD_ERROR.into()));
        assert_eq!(attempts.get(), 1);
        change_proof(data.path(), |proof| proof.owner_pid += 1);
        assert!(wait_for_ready(&owner, || panic!("invalid proof cannot dispatch")).is_err());
    }
    #[test]
    fn unknown_or_changed_proof_never_authorizes_activation() {
        let (data, _lease) = fixture();
        change_proof(data.path(), |proof| {
            proof.owner_token = uuid::Uuid::new_v4().to_string()
        });
        assert!(Owner::load(data.path()).is_err());
        fs::remove_file(data.path().join(".desktop-session.lock").join(PROOF_FILE)).unwrap();
        assert!(Owner::load(data.path()).is_err());
        assert!(Lease::acquire(data.path()).is_err());
    }
    #[test]
    fn a_reused_live_pid_does_not_match_the_original_generation() {
        let (data, _lease) = fixture();
        change_proof(data.path(), |proof| match &mut proof.generation {
            Generation::Linux { start_ticks, .. } => *start_ticks += 1,
            Generation::Windows { creation_time } => *creation_time += 1,
            Generation::Macos {
                start_microseconds, ..
            } => *start_microseconds += 1,
        });
        assert!(Owner::load(data.path()).is_err());
        assert!(Lease::acquire(data.path()).is_err());
    }
    #[test]
    fn changed_lease_is_rechecked_immediately_before_transmission() {
        let (data, lease) = fixture();
        let owner = Owner::load(data.path()).unwrap();
        let mut replacement = lease.record();
        replacement.token = uuid::Uuid::new_v4().to_string();
        fs::write(
            data.path().join(".desktop-session.lock/owner.json"),
            serde_json::to_vec(&replacement).unwrap(),
        )
        .unwrap();
        assert!(owner.verify_endpoint(std::process::id()).is_err());
    }
    #[test]
    fn another_shell_cannot_receive_native_activation() {
        let (data, lease) = fixture();
        let mut other = lease.record();
        other.shell = "electron".into();
        fs::write(
            data.path().join(".desktop-session.lock/owner.json"),
            serde_json::to_vec(&other).unwrap(),
        )
        .unwrap();
        assert!(Owner::load(data.path()).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_activation_proof_is_refused() {
        let (data, _lease) = fixture();
        let proof = data.path().join(".desktop-session.lock").join(PROOF_FILE);
        let target = data.path().join("elsewhere");
        fs::rename(&proof, &target).unwrap();
        std::os::unix::fs::symlink(target, proof).unwrap();
        assert!(Owner::load(data.path()).is_err());
    }
    #[test]
    fn plugin_wire_payloads_preserve_empty_unicode_and_pipe_arguments() {
        let input = activation();
        let windows = String::from_utf8(windows_payload(&input).unwrap()).unwrap();
        let mut windows = windows.split('\0');
        assert_eq!(windows.next(), Some(input.cwd.as_str()));
        assert_eq!(windows.collect::<Vec<_>>(), input.args);
        let macos = String::from_utf8(macos_payload(&input).unwrap()).unwrap();
        let (cwd, args) = macos.split_once("\0\0").unwrap();
        assert_eq!(cwd, input.cwd);
        assert_eq!(args.split('\0').collect::<Vec<_>>(), input.args);
        let invalid = Activation {
            cwd: "x\0y".into(),
            args: vec![],
        };
        assert!(windows_payload(&invalid).is_err());
        assert!(macos_payload(&invalid).is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn only_a_local_unix_session_bus_can_receive_activation() {
        for address in ["tcp:host=127.0.0.1,port=12345", "unixexec:path=/bin/true"] {
            assert!(local_bus_address(address.parse().unwrap()).is_err());
        }
        assert!(local_bus_address("unix:path=/tmp/test-bus".parse().unwrap()).is_ok());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_identity_handles_parentheses_and_rejects_dead_processes() {
        let fields = [vec!["S"], vec!["0"; 18], vec!["12345"]].concat().join(" ");
        let stat = format!("42 (comm) name) {fields}");
        assert_eq!(linux_start_ticks(&stat, 42).unwrap(), 12345);
        assert!(linux_start_ticks(&stat, 43).is_err());
        assert!(linux_start_ticks(&stat.replace(") S ", ") Z "), 42).is_err());
        assert!(linux_start_ticks("42 (truncated) S", 42).is_err());
    }

    #[test]
    #[ignore = "subprocess fixture, invoked by real owner lifetime test"]
    fn native_owner_process() {
        let Some(data) = std::env::var_os("VARIN_ACTIVATION_LIFETIME_DATA") else {
            return;
        };
        let data = PathBuf::from(data);
        let lease = Lease::acquire(&data).unwrap();
        publish(&data, &lease).unwrap();
        fs::write(data.join("owner-ready"), b"ready").unwrap();
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
    }
    #[test]
    fn exited_original_process_cannot_authorize_activation() {
        let data = tempfile::tempdir().unwrap();
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "preengine_activation::tests::native_owner_process",
                    "--ignored",
                ])
                .env("VARIN_ACTIVATION_LIFETIME_DATA", data.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let started = std::time::Instant::now();
        while !data.path().join("owner-ready").exists() {
            assert!(child.0.try_wait().unwrap().is_none());
            assert!(started.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(10));
        }
        let owner = Owner::load(data.path()).unwrap();
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(owner.verify().is_err());
        assert!(Owner::load(data.path()).is_err());
        assert!(
            data.path()
                .join(".desktop-session.lock/owner.json")
                .exists()
        );
    }

    struct ChildGuard(Child);
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[cfg(target_os = "linux")]
    struct Bus {
        _process: ChildGuard,
        _runtime: tempfile::TempDir,
        address: String,
    }
    #[cfg(target_os = "linux")]
    impl Bus {
        fn new() -> Self {
            use std::io::BufRead;
            let runtime = tempfile::tempdir().unwrap();
            let mut process = ChildGuard(
                Command::new("dbus-daemon")
                    .args(["--session", "--nofork", "--print-address=1"])
                    .arg(format!(
                        "--address=unix:path={}",
                        runtime.path().join("bus").display()
                    ))
                    .env("XDG_RUNTIME_DIR", runtime.path())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .expect("private dbus-daemon is required"),
            );
            let mut address = String::new();
            std::io::BufReader::new(process.0.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            assert!(
                !address.trim().is_empty(),
                "private D-Bus did not publish an address"
            );
            Self {
                _process: process,
                _runtime: runtime,
                address: address.trim().into(),
            }
        }
        fn connection(&self) -> zbus::blocking::Connection {
            zbus::blocking::connection::Builder::address(self.address.as_str())
                .unwrap()
                .method_timeout(FORWARD_TIMEOUT)
                .build()
                .unwrap()
        }
    }
    #[cfg(target_os = "linux")]
    fn server(bus: &Bus, data: &Path, owns_lease: bool) -> ChildGuard {
        server_start(bus, data, owns_lease, false)
    }
    #[cfg(target_os = "linux")]
    fn server_start(bus: &Bus, data: &Path, owns_lease: bool, delayed: bool) -> ChildGuard {
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "preengine_activation::tests::linux_server_process",
                    "--ignored",
                ])
                .env("VARIN_ACTIVATION_TEST_BUS", &bus.address)
                .env("VARIN_ACTIVATION_TEST_DATA", data)
                .env(
                    "VARIN_ACTIVATION_TEST_DELAYED",
                    if delayed { "yes" } else { "no" },
                )
                .env(
                    "VARIN_ACTIVATION_TEST_OWNER",
                    if owns_lease { "yes" } else { "no" },
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let started = std::time::Instant::now();
        while !data
            .join(if delayed {
                "lease-ready"
            } else {
                "server-ready"
            })
            .exists()
        {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "activation fixture exited before readiness"
            );
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "activation fixture did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        child
    }
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "subprocess fixture, invoked by actual D-Bus transport tests"]
    fn linux_server_process() {
        let Some(address) = std::env::var_os("VARIN_ACTIVATION_TEST_BUS") else {
            return;
        };
        let data = PathBuf::from(std::env::var_os("VARIN_ACTIVATION_TEST_DATA").unwrap());
        let delayed = std::env::var("VARIN_ACTIVATION_TEST_DELAYED").unwrap() == "yes";
        let next_stage = || {
            let mut input = String::new();
            assert!(std::io::stdin().read_line(&mut input).unwrap() > 0);
        };
        let _lease = if std::env::var("VARIN_ACTIVATION_TEST_OWNER").unwrap() == "yes" {
            let lease = Lease::acquire(&data).unwrap();
            if delayed {
                fs::write(data.join("lease-ready"), b"ready").unwrap();
                next_stage();
            }
            publish(&data, &lease).unwrap();
            if delayed {
                next_stage();
            }
            Some(lease)
        } else {
            None
        };
        struct Callback {
            receipt: PathBuf,
            count: usize,
        }
        #[zbus::interface(name = "org.SingleInstance.DBus")]
        impl Callback {
            fn execute_callback(&mut self, args: Vec<String>, cwd: String) {
                self.count += 1;
                fs::write(self.receipt.with_extension("count"), self.count.to_string()).unwrap();
                fs::write(&self.receipt, serde_json::to_vec(&(args, cwd)).unwrap()).unwrap();
            }
        }
        let _connection = zbus::blocking::connection::Builder::address(address.to_str().unwrap())
            .unwrap()
            .name("dev.varin.activationtest.SingleInstance")
            .unwrap()
            .serve_at(
                "/dev/varin/activationtest/SingleInstance",
                Callback {
                    receipt: data.join("received.json"),
                    count: 0,
                },
            )
            .unwrap()
            .build()
            .unwrap();
        fs::write(data.join("server-ready"), b"ready").unwrap();
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_delayed_original_owner_accepts_early_activation_exactly_once() {
        let bus = Bus::new();
        let data = tempfile::tempdir().unwrap();
        let mut server = server_start(&bus, data.path(), true, true);
        let owner = Owner::capture(data.path()).unwrap();
        assert!(!owner.proof_ready().unwrap());
        let connection = bus.connection();
        let input = activation();
        let (mut publish_released, mut endpoint_released) = (false, false);
        wait_for_ready_observed(
            &owner,
            || forward_linux(&owner, &input, "dev.varin.activationtest", &connection),
            |proof_ready| {
                if !proof_ready && !publish_released {
                    server
                        .0
                        .stdin
                        .as_mut()
                        .unwrap()
                        .write_all(b"publish\n")
                        .unwrap();
                    publish_released = true;
                } else if proof_ready && !endpoint_released {
                    server
                        .0
                        .stdin
                        .as_mut()
                        .unwrap()
                        .write_all(b"listen\n")
                        .unwrap();
                    endpoint_released = true;
                }
            },
        )
        .unwrap();
        assert!(publish_released && endpoint_released);
        assert_eq!(
            fs::read_to_string(data.path().join("received.count")).unwrap(),
            "1"
        );
        let (args, cwd): (Vec<String>, String) =
            serde_json::from_slice(&fs::read(data.path().join("received.json")).unwrap()).unwrap();
        assert_eq!(args, input.args);
        assert_eq!(cwd, input.cwd);
        owner.verify().unwrap();
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_real_transport_forwards_to_original_live_process() {
        let bus = Bus::new();
        let data = tempfile::tempdir().unwrap();
        let _server = server(&bus, data.path(), true);
        let owner = Owner::load(data.path()).unwrap();
        let input = activation();
        forward_linux(
            &owner,
            &input,
            "dev.varin.activationtest",
            &bus.connection(),
        )
        .unwrap();
        let (args, cwd): (Vec<String>, String) =
            serde_json::from_slice(&fs::read(data.path().join("received.json")).unwrap()).unwrap();
        assert_eq!(args, input.args);
        assert_eq!(cwd, input.cwd);
        assert!(Lease::acquire(data.path()).is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_real_transport_refuses_foreign_endpoint_without_sending() {
        let bus = Bus::new();
        let (data, _lease) = fixture();
        let _server = server(&bus, data.path(), false);
        let owner = Owner::load(data.path()).unwrap();
        assert!(
            forward_linux(
                &owner,
                &activation(),
                "dev.varin.activationtest",
                &bus.connection()
            )
            .is_err()
        );
        assert!(!data.path().join("received.json").exists());
        assert!(Lease::acquire(data.path()).is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_pending_endpoint_leaves_original_data_lock_intact() {
        let bus = Bus::new();
        let (data, _lease) = fixture();
        let owner = Owner::load(data.path()).unwrap();
        assert!(
            !forward_linux(
                &owner,
                &activation(),
                "dev.varin.activationtest",
                &bus.connection()
            )
            .unwrap()
        );
        owner.verify().unwrap();
        assert!(Lease::acquire(data.path()).is_err());
    }
}
