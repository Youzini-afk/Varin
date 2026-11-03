//! A sole-reaper, single-threaded subreaper. /proc is candidate discovery only;
//! ECHILD from the kernel is the sole proof that the owned descendant scope ended.
use super::{Control, Launch, RootExit, emit};
use serde_json::json;
use std::{
    ffi::CString,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    time::{Duration, Instant},
};

fn pidfd_open(pid: libc::pid_t) -> std::io::Result<OwnedFd> {
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw as i32) })
}
fn signal(fd: &OwnedFd, number: i32) -> std::io::Result<()> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            number,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
/// Candidate identities are not authority. This wait validates the exact pidfd
/// against our kernel child set before any signal; a foreign/recycled PID fails.
fn pin_child(pid: libc::pid_t) -> std::io::Result<OwnedFd> {
    let fd = pidfd_open(pid)?;
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        if unsafe {
            libc::waitid(
                libc::P_PIDFD,
                fd.as_raw_fd() as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT | libc::__WALL,
            )
        } == 0
        {
            return Ok(fd);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}
fn candidates() -> std::io::Result<Vec<libc::pid_t>> {
    // The optional /proc task/children interface is absent on some kernels.
    // A parent-PID snapshot is only discovery, never termination authority.
    let parent = std::process::id().to_string();
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let Ok(entry) = entry else { continue };
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<libc::pid_t>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(1))
            == Some(parent.as_str())
        {
            found.push(pid);
        }
    }
    Ok(found)
}

fn stat_start_identity(stat: &str, pid: u32, parent: Option<u32>) -> Option<String> {
    if stat.split_once(' ')?.0.parse::<u32>().ok()? != pid {
        return None;
    }
    let fields: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    if parent.is_some_and(|expected| {
        fields.get(1).and_then(|value| value.parse::<u32>().ok()) != Some(expected)
    }) {
        return None;
    }
    let ticks = *fields.get(19)?;
    if ticks.parse::<u64>().ok()? == 0 {
        return None;
    }
    Some(format!("linux:{ticks}"))
}

fn start_identity(pid: libc::pid_t) -> Option<String> {
    #[cfg(test)]
    if std::env::var_os("VARIN_TEST_PROCESS_OWNER_MISSING_IDENTITY").is_some() {
        return None;
    }
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat_start_identity(&stat, pid as u32, Some(std::process::id()))
}

enum Reaped {
    Pending,
    Empty,
    Exit(libc::pid_t, RootExit),
}
fn reap_one() -> std::io::Result<Reaped> {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_ALL,
                0,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::__WALL,
            )
        } == 0
        {
            let pid = unsafe { info.si_pid() };
            if pid == 0 {
                return Ok(Reaped::Pending);
            }
            let status = unsafe { info.si_status() };
            return Ok(Reaped::Exit(
                pid,
                RootExit {
                    code: (info.si_code == libc::CLD_EXITED).then_some(status),
                    signal: (info.si_code != libc::CLD_EXITED).then_some(status),
                    success: info.si_code == libc::CLD_EXITED && status == 0,
                },
            ));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ECHILD) {
            return Ok(Reaped::Empty);
        }
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

struct Input {
    bytes: Vec<u8>,
    closed: bool,
}
impl Input {
    fn poll(&mut self, nonce: &str) -> Result<Option<Duration>, ()> {
        if self.closed {
            return Ok(None);
        }
        let mut stop = None;
        loop {
            let mut chunk = [0u8; 4096];
            let count = unsafe { libc::read(0, chunk.as_mut_ptr().cast(), chunk.len()) };
            if count == 0 {
                self.closed = true;
                return Err(());
            }
            if count < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                if error.kind() == std::io::ErrorKind::WouldBlock {
                    return Ok(stop);
                }
                self.closed = true;
                return Err(());
            }
            self.bytes.extend_from_slice(&chunk[..count as usize]);
            // Control frames contain a nonce and timeout, never app input.
            if self.bytes.len() > 8192 {
                self.closed = true;
                return Err(());
            }
            while let Some(end) = self.bytes.iter().position(|byte| *byte == b'\n') {
                let line: Vec<_> = self.bytes.drain(..=end).collect();
                match serde_json::from_slice::<Control>(&line) {
                    Ok(Control::Stop {
                        nonce: received,
                        force_after_ms,
                    }) if received == nonce && force_after_ms <= 3_600_000 => {
                        let grace = Duration::from_millis(force_after_ms);
                        stop = Some(stop.map_or(grace, |prior: Duration| prior.min(grace)));
                    }
                    Ok(Control::Settle { nonce: received }) if received == nonce => {}
                    _ => {
                        self.closed = true;
                        return Err(());
                    }
                }
            }
        }
    }
}

pub fn run(launch: Launch) -> Result<(), String> {
    // A procfs mount from a different PID namespace can describe unrelated host
    // processes at the same numeric IDs. Never publish their birth tokens.
    let own_stat = std::fs::read_to_string("/proc/self/stat")
        .map_err(|_| "Process owner namespace identity is unavailable")?;
    if stat_start_identity(&own_stat, std::process::id(), None).is_none() {
        return Err("Process owner namespace identity does not match".into());
    }
    // Restore normal child disposition even when the controller ignored SIGCHLD.
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = libc::SIG_DFL;
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
    }
    if unsafe { libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) } != 0
        || unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0
    {
        return Err("Kernel descendant ownership could not be established".into());
    }
    // A disconnected receipt channel must not deliver SIGPIPE and kill the owner.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let flags = unsafe { libc::fcntl(0, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(0, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("Process owner control could not be isolated".into());
    }
    let string =
        |text: &str| CString::new(text).map_err(|_| "Invalid process launch string".to_string());
    let executable = string(&launch.executable)?;
    let args: Vec<CString> = std::iter::once(launch.executable.as_str())
        .chain(launch.args.iter().map(String::as_str))
        .map(string)
        .collect::<Result<_, _>>()?;
    let argv: Vec<_> = args
        .iter()
        .map(|arg| arg.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let env: Vec<CString> = launch
        .env
        .iter()
        .map(|(key, value)| string(&format!("{key}={value}")))
        .collect::<Result<_, _>>()?;
    let envp: Vec<_> = env
        .iter()
        .map(|value| value.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let cwd = launch.cwd.as_deref().map(string).transpose()?;
    let mut gate = [-1; 2];
    if unsafe { libc::pipe2(gate.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err("Launch gate is unavailable".into());
    }
    let gate_read = unsafe { OwnedFd::from_raw_fd(gate[0]) };
    let gate_write = unsafe { OwnedFd::from_raw_fd(gate[1]) };
    let null = std::fs::File::open("/dev/null").map_err(|_| "Application input is unavailable")?;
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err("Owned application could not be created".into());
    }
    if pid == 0 {
        // Only async-signal-safe operations here, no allocator or unwinding.
        unsafe {
            libc::close(gate_write.as_raw_fd());
            if libc::dup2(null.as_raw_fd(), 0) < 0 || libc::dup2(2, 1) < 0 {
                libc::_exit(125);
            }
            let mut release = [0u8];
            loop {
                let count = libc::read(gate_read.as_raw_fd(), release.as_mut_ptr().cast(), 1);
                if count < 0 && *libc::__errno_location() == libc::EINTR {
                    continue;
                }
                if count != 1 || release[0] != b'R' {
                    libc::_exit(125);
                }
                break;
            }
            libc::close(gate_read.as_raw_fd());
            if let Some(cwd) = &cwd {
                if libc::chdir(cwd.as_ptr()) != 0 {
                    libc::_exit(126);
                }
            }
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            libc::execve(executable.as_ptr(), argv.as_ptr(), envp.as_ptr());
            libc::_exit(126);
        }
    }
    #[cfg(test)]
    crash_boundary("forked");
    drop(gate_read);
    drop(null);
    // Before release, our unreaped direct child cannot vanish/reuse its identity.
    let root = pin_child(pid).ok();
    #[cfg(test)]
    crash_boundary("pinned");
    let root_start_identity = root.as_ref().and_then(|_| start_identity(pid));
    let mut failed = root.is_none() || root_start_identity.is_none();
    let mut forced = failed;
    let mut reason = failed.then_some("Original process identity could not be retained");
    if !failed
        && emit(
            &launch.nonce,
            "ready",
            json!({"rootPid":pid,"rootIdentity":format!("linux:{}:{pid}", launch.nonce),"rootStartIdentity":root_start_identity}),
        )
        .is_err()
    {
        failed = true;
        forced = true;
        reason = Some("Admission receipt was not delivered");
    }
    #[cfg(test)]
    crash_boundary("admitted");
    if !failed && unsafe { libc::write(gate_write.as_raw_fd(), b"R".as_ptr().cast(), 1) } != 1 {
        failed = true;
        forced = true;
        reason = Some("Application release failed");
    }
    // Close the admission gate forever before accepting ECHILD as proof.
    drop(gate_write);
    #[cfg(test)]
    crash_boundary("released");
    let mut input = Input {
        bytes: Vec::new(),
        closed: false,
    };
    let mut force_at = failed.then(Instant::now);
    let mut root_exit = None;
    loop {
        match input.poll(&launch.nonce) {
            Ok(Some(grace)) => {
                forced = true;
                let deadline = Instant::now() + grace;
                force_at = Some(force_at.map_or(deadline, |prior| prior.min(deadline)));
            }
            Err(()) => {
                failed = true;
                forced = true;
                reason = Some("Process owner control was lost or invalid");
                force_at = Some(Instant::now());
            }
            Ok(None) => {}
        }
        if let Some(deadline) = force_at {
            let number = if Instant::now() >= deadline {
                libc::SIGKILL
            } else {
                libc::SIGTERM
            };
            if let Some(root) = &root {
                let _ = signal(root, number);
            }
            // Discovery may be empty, inaccessible or race adoption. None of
            // those outcomes is completion. Repeat after every reparent/reap.
            if let Ok(children) = candidates() {
                for candidate in children {
                    if let Ok(child) = pin_child(candidate) {
                        let _ = signal(&child, number);
                    }
                }
            }
        }
        loop {
            match reap_one() {
                Ok(Reaped::Exit(child, exit)) => {
                    if child == pid {
                        root_exit = Some(exit.clone());
                        if emit(&launch.nonce, "root-exit", json!({"rootExit":exit})).is_err() {
                            failed = true;
                            forced = true;
                            reason = Some("Root termination receipt was not delivered");
                            force_at = Some(Instant::now());
                        }
                    }
                }
                Ok(Reaped::Empty) if root_exit.is_some() => {
                    let exit = root_exit.as_ref().unwrap();
                    // Denied signals never make this true. Only the kernel's
                    // child-set exhaustion after root reaping reaches here.
                    emit(
                        &launch.nonce,
                        "settled",
                        json!({
                            "ownershipDrainConfirmed":true,"clean":exit.success && !forced && !failed,
                            "forced":forced,"rootExit":exit,"reason":reason
                        }),
                    )?;
                    return Ok(());
                }
                Ok(Reaped::Pending) => break,
                Ok(Reaped::Empty) | Err(_) => {
                    // An observation error cannot relinquish ownership. Keep
                    // trying and leave the controller's deadline unconfirmed.
                    failed = true;
                    forced = true;
                    reason = Some("Kernel child ownership observation failed");
                    force_at = Some(Instant::now());
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
fn crash_boundary(boundary: &str) {
    if std::env::var("VARIN_TEST_PROCESS_OWNER_CRASH").as_deref() == Ok(boundary) {
        // Only the isolated Rust test binary contains fault injection. Production
        // owner controls never expose a crash/exit command.
        unsafe { libc::_exit(93) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn birth_token_rejects_wrong_proc_namespace_parent_and_zero_ticks() {
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
        let pid = std::process::id();
        let parent = unsafe { libc::getppid() } as u32;
        assert!(stat_start_identity(&stat, pid, Some(parent)).is_some());
        assert!(stat_start_identity(&stat, pid + 1, Some(parent)).is_none());
        assert!(stat_start_identity(&stat, pid, Some(parent + 1)).is_none());
        let (prefix, suffix) = stat.rsplit_once(')').unwrap();
        let mut fields: Vec<_> = suffix.split_whitespace().collect();
        fields[19] = "0";
        assert!(
            stat_start_identity(
                &format!("{prefix}) {}", fields.join(" ")),
                pid,
                Some(parent)
            )
            .is_none()
        );
        assert!(stat_start_identity("unavailable", pid, Some(parent)).is_none());
    }

    #[test]
    fn unavailable_root_birth_token_keeps_exec_gate_closed() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("must-not-execute");
        let mut guardian = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_owner::linux::tests::crash_guardian_entry",
                "--ignored",
                "--nocapture",
            ])
            .env("VARIN_TEST_PROCESS_OWNER_MISSING_IDENTITY", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let launch = json!({"nonce":"missing-birth-token","executable":"/bin/sh", "args":["-c", "printf executed > \"$1\"", "fixture", marker],"cwd":null,"env":{}});
        let mut control = guardian.stdin.take().unwrap();
        control.write_all(format!("{launch}\n").as_bytes()).unwrap();
        assert!(guardian.wait().unwrap().success()); // stdin stays open; no EOF cleanup shortcut
        drop(control);
        let mut output = String::new();
        guardian
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert!(!output.contains("\"type\":\"ready\""));
        assert!(output.contains("\"clean\":false"));
        assert!(!marker.exists());
    }

    #[test]
    fn guardian_death_at_admission_boundaries_has_no_completion_receipt() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_owner::linux::tests::crash_supervisor_entry",
                "--ignored",
                "--nocapture",
            ])
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    #[ignore = "isolated original guardian fault entry"]
    fn crash_guardian_entry() {
        super::super::run().unwrap();
    }

    #[test]
    #[ignore = "isolated fixture cleanup owner"]
    fn crash_supervisor_entry() {
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
            0
        );
        for boundary in ["forked", "pinned", "admitted", "released"] {
            let directory = tempfile::tempdir().unwrap();
            let writes = directory.path().join("writes");
            let stop = directory.path().join("stop");
            let mut guardian = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "process_owner::linux::tests::crash_guardian_entry",
                    "--ignored",
                    "--nocapture",
                ])
                .env("VARIN_TEST_PROCESS_OWNER_CRASH", boundary)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let launch = json!({"nonce":"boundary-test","executable":"/bin/sh", "args":["-c", "while [ ! -e \"$2\" ]; do printf x >> \"$1\"; sleep 0.01; done", "fixture", writes, stop],"cwd":null,"env":{}});
            guardian
                .stdin
                .as_mut()
                .unwrap()
                .write_all(format!("{launch}\n").as_bytes())
                .unwrap();
            let output = guardian.wait_with_output().unwrap();
            assert_eq!(output.status.code(), Some(93));
            assert!(
                !String::from_utf8_lossy(&output.stdout)
                    .contains("\"ownershipDrainConfirmed\":true")
            );
            if boundary == "released" {
                let deadline = Instant::now() + Duration::from_secs(3);
                while !writes.exists() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert!(
                    writes.exists(),
                    "application can survive guardian death; no fabricated receipt"
                );
            }
            std::fs::write(&stop, "stop").unwrap(); // private fixture shutdown protocol
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if matches!(reap_one().unwrap(), Reaped::Empty) {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "private fixture cleanup did not finish"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            if boundary != "released" {
                assert!(
                    !writes.exists(),
                    "exec gate must remain closed on admission death"
                );
            }
        }
    }
    #[test]
    fn foreign_pidfd_candidate_is_rejected_before_signal() {
        let result = pin_child(std::process::id() as i32);
        assert!(matches!(result, Err(error) if error.raw_os_error() == Some(libc::ECHILD)));
    }
    #[test]
    fn empty_discovery_cannot_prove_empty_kernel_children() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_owner::linux::tests::kernel_children_entry",
                "--ignored",
                "--nocapture",
            ])
            .status()
            .unwrap();
        assert!(status.success());
    }
    #[test]
    #[ignore = "isolated sole-reaper subprocess entry"]
    fn kernel_children_entry() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("0.1")
            .spawn()
            .unwrap();
        // Deliberately no discovery. Pending is a positive kernel child fact.
        assert!(matches!(reap_one().unwrap(), Reaped::Pending));
        child.wait().unwrap();
        assert!(matches!(reap_one().unwrap(), Reaped::Empty));
    }
}
