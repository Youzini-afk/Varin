//! A small native owner, entered before CEF, for one original managed Node tree.
//! The private socket is never inherited by Node. EOF means the shell is gone,
//! not that effects drained. Only this direct parent may signal the fixed group;
//! WNOWAIT pins Node's identity until all group members have actually stopped.
//! Linux additionally adopts and reaps detached descendants. macOS establishes
//! only the original process-group boundary, not containment of arbitrary
//! descendants which deliberately leave it. Without a complete original-owner
//! drain it retains the restart lease, rather than pretending to be an OS Job.
use crate::host_scope::ScopeExit;
use std::{
    ffi::OsString,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{net::UnixStream, process::CommandExt},
    },
    process::Stdio,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use tokio::process::{Child, ChildStdout, Command};

const ENTRY: &str = "--varin-service-guardian";
pub struct Guardian {
    socket: Mutex<UnixStream>,
}
impl Guardian {
    pub fn terminate(&self) -> Result<(), String> {
        self.socket
            .lock()
            .map_err(|_| "Managed scope control failed")?
            .write_all(b"K")
            .map_err(|_| "Managed scope termination was not accepted".into())
    }
    /// Only the trusted original owner may attest a fully read drain protocol.
    #[cfg(any(target_os = "macos", test))]
    pub fn confirm_drained(&self) -> Result<(), String> {
        self.socket
            .lock()
            .map_err(|_| "Managed scope control failed")?
            .write_all(b"D")
            .map_err(|_| "Managed owner drain could not be recorded".into())
    }
    pub fn finished(&self) -> Result<ScopeExit, String> {
        let mut socket = self
            .socket
            .lock()
            .map_err(|_| "Managed scope control failed")?;
        let mut bytes = Vec::new();
        loop {
            let mut byte = [0];
            socket
                .read_exact(&mut byte)
                .map_err(|_| "Managed scope completion is unknown")?;
            if byte[0] == b'\n' {
                break;
            }
            if bytes.len() == 512 {
                return Err("Managed scope completion is invalid".into());
            }
            bytes.push(byte[0]);
        }
        // A late cancellation byte may race the guardian's exit and reset its
        // socket. The complete bounded receipt, not a subsequent EOF, is proof.
        serde_json::from_slice(&bytes).map_err(|_| "Managed scope completion is unknown".into())
    }
}

pub fn spawn(
    command: Command,
    data_dir: &std::path::Path,
    stderr: Stdio,
) -> Result<(Child, Guardian), String> {
    let lease = crate::desktop_lock::ScopeLease::prepare(data_dir)?;
    let mut launched = false;
    let result = (|| {
        let (mut parent, child_socket) =
            UnixStream::pair().map_err(|_| "Managed scope control could not be prepared")?;
        let (output, child_output) =
            std::io::pipe().map_err(|_| "Managed service output could not be prepared")?;
        let socket_fd = child_socket.as_raw_fd();
        let output_fd = child_output.as_raw_fd();
        let source = command.as_std();
        let mut guardian = Command::new(
            std::env::current_exe().map_err(|_| "Native service guardian is unavailable")?,
        );
        let arguments: Vec<OsString> = [
            socket_fd.to_string().into(),
            output_fd.to_string().into(),
            lease.path().as_os_str().to_owned(),
            lease.token().into(),
            source.get_program().to_owned(),
        ]
        .into_iter()
        .chain(source.get_args().map(ToOwned::to_owned))
        .collect();
        #[cfg(not(test))]
        guardian.arg(ENTRY).args(&arguments);
        #[cfg(test)]
        {
            guardian.args([
                "--exact",
                "host_guardian::tests::guardian_entry",
                "--ignored",
                "--nocapture",
            ]);
            guardian.env("VARIN_TEST_GUARDIAN_ARGUMENTS", arguments.len().to_string());
            for (index, argument) in arguments.iter().enumerate() {
                guardian.env(format!("VARIN_TEST_GUARDIAN_ARG_{index}"), argument);
            }
        }
        for (key, value) in source.get_envs() {
            match value {
                Some(value) => {
                    guardian.env(key, value);
                }
                None => {
                    guardian.env_remove(key);
                }
            }
        }
        if let Some(directory) = source.get_current_dir() {
            guardian.current_dir(directory);
        }
        // Guardian's stdout is never the service protocol, including a test harness's
        // prelude. Node receives a separate original pipe without a relay/copy task.
        guardian
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(stderr)
            .process_group(0);
        unsafe {
            guardian.pre_exec(move || {
                for fd in [child_socket.as_raw_fd(), child_output.as_raw_fd()] {
                    if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let mut child = guardian
            .spawn()
            .map_err(|_| "Bundled desktop service guardian could not start")?;
        launched = true;
        // Drop the parent's copies of the child's socket/pipe now, not at scope end.
        drop(guardian);
        // Do not expose the service pipes until its durable guardian identity
        // is active. Inherited-lease consumers authenticate this exact chain.
        let mut ready = [0];
        if parent.read_exact(&mut ready).is_err() || ready != *b"R" {
            drop(parent);
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return Err("Managed service ownership was not established".into());
        }
        let stdout = std::process::ChildStdout::from(OwnedFd::from(output));
        child.stdout = match ChildStdout::from_std(stdout) {
            Ok(stdout) => Some(stdout),
            Err(_) => {
                drop(parent); // Original guardian must clean up, even on setup failure.
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return Err("Managed service output could not be registered".into());
            }
        };
        Ok((
            child,
            Guardian {
                socket: Mutex::new(parent),
            },
        ))
    })();
    if result.is_err() && !launched {
        lease.mark_ended()?;
    }
    result
}

/// Called at the native executable entry before any CEF/desktop initialization.
pub fn run_if_requested() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(ENTRY)) {
        return;
    }
    std::process::exit(run(args.collect()));
}

fn run(args: Vec<OsString>) -> i32 {
    let result = (|| -> Result<(), String> {
        let fd = |index: usize| -> Result<i32, String> {
            args.get(index)
                .and_then(|value| value.to_str())
                .and_then(|value| value.parse::<i32>().ok())
                .filter(|fd| *fd > 2)
                .ok_or_else(|| "Invalid guardian pipe".into())
        };
        let control = fd(0)?;
        let output = fd(1)?;
        if control == output || args.len() < 5 {
            return Err("Invalid guardian entry".into());
        }
        // No descendant or another concurrent service may keep this channel alive.
        for descriptor in [control, output] {
            if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                return Err("Guardian pipe could not be isolated".into());
            }
        }
        let lease = crate::desktop_lock::ScopeLease::open(
            std::path::Path::new(&args[2]),
            args[3].to_str().ok_or("Invalid managed scope identity")?,
        )?;
        let mut socket = unsafe { UnixStream::from_raw_fd(control) };
        let output = unsafe { OwnedFd::from_raw_fd(output) };
        let mut command = std::process::Command::new(&args[4]);
        command
            .env("VARIN_DESKTOP_SCOPE_TOKEN", lease.token())
            .args(&args[5..])
            .stdin(Stdio::inherit())
            .stdout(Stdio::from(output))
            .stderr(Stdio::inherit())
            .process_group(0);
        #[cfg(test)]
        for (key, _) in std::env::vars_os()
            .filter(|(key, _)| key.to_string_lossy().starts_with("VARIN_TEST_GUARDIAN_"))
        {
            command.env_remove(key);
        }
        // Adopt descendants that call setsid/setpgid or double-fork. Establish
        // this before Node can execute, never infer ownership from a saved PID.
        #[cfg(target_os = "linux")]
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err("Managed descendant ownership could not be established".into());
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                lease.mark_ended()?;
                // No Node ever existed. The launch still failed; it did not drain.
                write_receipt(
                    &mut socket,
                    ScopeExit {
                        clean: false,
                        code: None,
                        success: false,
                    },
                )?;
                return Ok(());
            }
        };
        // Only the actual Node should retain the service's stdin read end.
        unsafe {
            libc::close(0);
        }
        let group = child.id() as i32;
        let mut pinned = PinnedGroup(Some(group));
        lease.mark_active(std::process::id(), child.id())?;
        socket
            .write_all(b"R")
            .map_err(|_| "Managed service admission could not be reported")?;
        let ownership = Arc::new((Mutex::new((Some(group), false, false)), Condvar::new()));
        let watcher_ownership = ownership.clone();
        let mut input = socket
            .try_clone()
            .map_err(|_| "Guardian control could not be observed")?;
        let watcher = std::thread::Builder::new()
            .name("service-parent".into())
            .spawn(move || {
                let mut byte = [0];
                loop {
                    let drained = match input.read(&mut byte) {
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Ok(1) if byte[0] == b'D' => true,
                        _ => false,
                    };
                    let (lock, changed) = &*watcher_ownership;
                    if let Ok(mut state) = lock.lock() {
                        if drained {
                            state.2 = true;
                        } else if let Some(group) = state.0 {
                            state.1 = true;
                            let _ = kill_group(group);
                        }
                        changed.notify_all();
                    }
                    if !drained {
                        break;
                    }
                }
            });
        if watcher.is_err() {
            // Startup after Node spawn must still stop this original tree.
            ownership.0.lock().map_err(|_| "Guardian state failed")?.1 = true;
            kill_group(group)?;
        }
        // Unlike wait(), this preserves the direct child's PID even as a zombie.
        let node_succeeded = loop {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    group as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            } == 0
            {
                break unsafe { info.si_code == libc::CLD_EXITED && info.si_status() == 0 };
            }
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                return Err("Original Node termination could not be observed".into());
            }
        };
        let mut clean = !ownership.0.lock().map_err(|_| "Guardian state failed")?.1;
        if !group_empty(group)? {
            clean = false;
            kill_group(group)?;
        }
        while !group_empty(group)? {
            std::thread::sleep(Duration::from_millis(10));
        }
        #[cfg(target_os = "linux")]
        {
            clean &= drain_adopted_children(group)?;
        }
        // Synchronize disarming with the control reader before reaping Node. A
        // late EOF must never send a signal to a recycled group/process identity.
        let status = {
            let mut state = ownership.0.lock().map_err(|_| "Guardian state failed")?;
            // macOS has no unprivileged subreaper or supported NOTE_TRACK.
            // A clean original-owner drain is the only additional evidence we
            // accept there; PG emptiness alone never clears an abnormal scope.
            if requires_owner_drain() && clean && node_succeeded {
                while !state.1 && !state.2 {
                    state = ownership
                        .1
                        .wait(state)
                        .map_err(|_| "Managed drain observation failed")?;
                }
            }
            clean &= !state.1;
            let confirmed = !requires_owner_drain() || (clean && node_succeeded && state.2);
            state.0 = None;
            let status = child
                .wait()
                .map_err(|_| "Original Node could not be reaped")?;
            pinned.0 = None;
            if !confirmed {
                return Err(
                    "Managed descendants are unconfirmed; original desktop ownership is retained"
                        .into(),
                );
            }
            status
        };
        lease.mark_ended()?;
        write_receipt(
            &mut socket,
            ScopeExit {
                clean,
                code: status.code(),
                success: status.success(),
            },
        )?;
        // Entry exits the process, closing the waiting reader even if the shell
        // has not closed its endpoint. No detached work survives the guardian.
        Ok(())
    })();
    #[cfg(test)]
    if let Err(error) = &result {
        eprintln!("Guardian failure: {error}");
    }
    if result.is_ok() { 0 } else { 125 }
}
fn requires_owner_drain() -> bool {
    #[cfg(test)]
    if std::env::var_os("VARIN_TEST_GUARDIAN_REQUIRE_DRAIN").is_some() {
        return true;
    }
    cfg!(target_os = "macos")
}
fn write_receipt(socket: &mut UnixStream, receipt: ScopeExit) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&receipt).map_err(|_| "Managed scope receipt is invalid")?;
    bytes.push(b'\n');
    // Parent death does not undo the actual cleanup if there is no recipient.
    match socket.write_all(&bytes) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
            ) =>
        {
            Ok(())
        }
        Err(_) => Err("Managed scope completion could not be reported".into()),
    }
}
// On any setup/inspection failure, still cancel this exact unreaped child tree.
// Failure never writes a completion receipt or invents a successful drain.
struct PinnedGroup(Option<i32>);
impl Drop for PinnedGroup {
    fn drop(&mut self) {
        if let Some(group) = self.0 {
            let _ = kill_group(group);
            #[cfg(target_os = "linux")]
            {
                // Even failure after spawn must retain the subreaper until
                // escaped descendants are adopted and terminated. Leave Node
                // pinned for the control reader until process exit; never
                // publish an ended receipt from this error path.
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                loop {
                    if unsafe {
                        libc::waitid(
                            libc::P_PID,
                            group as libc::id_t,
                            &mut info,
                            libc::WEXITED | libc::WNOWAIT,
                        )
                    } == 0
                    {
                        let _ = drain_adopted_children(group);
                        break;
                    }
                    if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                        break;
                    }
                }
            }
        }
    }
}
fn kill_group(group: i32) -> Result<(), String> {
    if unsafe { libc::kill(-group, libc::SIGKILL) } != 0
        && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    {
        return Err("Original managed group termination was not accepted".into());
    }
    Ok(())
}
/// Node is already an unreaped zombie. Each surviving orphan is now our
/// direct child; its PID cannot be reused until *we* reap it. Killing only these
/// kernel-confirmed children also handles nested detached descendants without
/// racing a process-table snapshot against PID reuse. No other thread reaps.
#[cfg(target_os = "linux")]
fn drain_adopted_children(node: i32) -> Result<bool, String> {
    let mut clean = true;
    let parent = std::process::id().to_string();
    loop {
        let mut found = false;
        for entry in
            std::fs::read_dir("/proc").map_err(|_| "Managed descendants cannot be inspected")?
        {
            let entry = entry.map_err(|_| "Managed descendants cannot be inspected")?;
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            let stat = match std::fs::read_to_string(entry.path().join("stat")) {
                Ok(stat) => stat,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("Managed descendant state cannot be inspected".into()),
            };
            let (_, rest) = stat
                .rsplit_once(')')
                .ok_or("Managed descendant state is malformed")?;
            if rest.split_whitespace().nth(1) != Some(parent.as_str()) {
                continue;
            }
            if pid == node {
                continue;
            }
            found = true;
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            loop {
                if unsafe {
                    libc::waitid(
                        libc::P_PID,
                        pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                } == 0
                {
                    break;
                }
                if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                    return Err("Managed descendant ownership is unknown".into());
                }
            }
            if unsafe { info.si_pid() } == 0 {
                clean = false;
                if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
                    return Err("Managed descendant termination was not accepted".into());
                }
            } else {
                // Exit reparents any grandchildren before this observation. A
                // fresh children snapshot must be inspected after every reap.
                if unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) } != pid {
                    return Err("Managed descendant could not be reaped".into());
                }
            }
        }
        if !found {
            return Ok(clean);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[cfg(target_os = "linux")]
pub(crate) fn group_empty(group: i32) -> Result<bool, String> {
    for entry in std::fs::read_dir("/proc").map_err(|_| "Managed group cannot be inspected")? {
        let entry = entry.map_err(|_| "Managed group cannot be inspected")?;
        if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
            continue;
        }
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Managed group cannot be inspected".into()),
        };
        let (_, rest) = stat
            .rsplit_once(')')
            .ok_or("Managed process state is malformed")?;
        let fields: Vec<_> = rest.split_whitespace().collect();
        if fields.get(2).and_then(|field| field.parse::<i32>().ok()) == Some(group)
            && !matches!(fields.first().copied(), Some("Z" | "X"))
        {
            return Ok(false);
        }
    }
    Ok(true)
}
#[cfg(target_os = "macos")]
pub(crate) fn group_empty(group: i32) -> Result<bool, String> {
    let mut capacity = 16usize;
    loop {
        let mut pids = vec![0i32; capacity];
        let bytes = i32::try_from(pids.len() * std::mem::size_of::<i32>())
            .map_err(|_| "Managed group is too large to inspect")?;
        // libproc takes bytes but returns a PID count (not bytes). Its wrapper
        // may return zero on error, so clear/check errno rather than certify an
        // empty group from a failed query.
        unsafe {
            *libc::__error() = 0;
        }
        let written = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), bytes) };
        if written < 0 || (written == 0 && unsafe { *libc::__error() } != 0) {
            return Err("Managed group cannot be inspected".into());
        }
        // libproc can fill the buffer and silently omit later members.
        if written as usize >= capacity {
            capacity = capacity
                .checked_mul(2)
                .ok_or("Managed group list overflow")?;
            continue;
        }
        for pid in pids
            .into_iter()
            .take(written as usize)
            .filter(|pid| *pid > 0)
        {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&info) as i32;
            let read = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            };
            if read != size {
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                    continue;
                }
                return Err("Managed member state cannot be inspected".into());
            }
            if info.pbi_pgid == group as u32 && info.pbi_status != 5 {
                return Ok(false);
            } // SZOMB
        }
        return Ok(true);
    }
}
#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_single_live_group_member_is_not_mistaken_for_an_empty_group() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let group = child.id() as i32;
        let empty = super::group_empty(group);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(empty.unwrap(), false);
    }
    #[tokio::test]
    async fn owner_drain_policy_retains_unknown_scopes_but_allows_confirmed_stop() {
        use super::*;
        use tokio::io::{AsyncBufReadExt, BufReader};
        for (certify, cancel, exit) in [
            (true, false, 0),
            (false, true, 0),
            (true, true, 0),
            (true, false, 13),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let lease = crate::desktop_lock::Lease::acquire(directory.path()).unwrap();
            let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
            let mut command = Command::new(node);
            command.env("VARIN_TEST_GUARDIAN_REQUIRE_DRAIN", "1").args(["-e", &format!(
                "process.stdout.write('ready\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit({exit}));"
            )]);
            let (mut child, guardian) = spawn(command, directory.path(), Stdio::null()).unwrap();
            let mut line = String::new();
            tokio::time::timeout(
                Duration::from_secs(10),
                BufReader::new(child.stdout.take().unwrap()).read_line(&mut line),
            )
            .await
            .unwrap()
            .unwrap();
            if certify {
                guardian.confirm_drained().unwrap();
            }
            if cancel {
                guardian.terminate().unwrap();
            }
            drop(child.stdin.take());
            let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
                .await
                .unwrap()
                .unwrap();
            let confirmed = certify && !cancel && exit == 0;
            assert_eq!(status.success(), confirmed);
            if confirmed {
                assert!(guardian.finished().unwrap().clean);
            }
            drop(lease);
            assert_eq!(
                directory.path().join(".desktop-session.lock").exists(),
                !confirmed
            );
            assert_eq!(
                crate::desktop_lock::Lease::acquire(directory.path()).is_ok(),
                confirmed
            );
        }
    }
    #[tokio::test]
    async fn original_guardian_chain_authenticates_the_private_exporter_lease() {
        use super::*;
        use tokio::io::AsyncReadExt;
        let directory = tempfile::tempdir().unwrap();
        let lease = crate::desktop_lock::Lease::acquire(directory.path()).unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/application-host/lib/platform/desktop-session-lease.ts")
            .canonicalize()
            .unwrap();
        let script = format!(
            r#"
import fs from 'node:fs';
import path from 'node:path';
import {{verifyInheritedDesktopSessionLease as verify}} from {};
const directory=process.env.VARIN_TEST_LEASE_DIR;
// Admission must precede the first private-parent message.
for await (const _ of process.stdin) {{ break; }}
const owner=JSON.parse(fs.readFileSync(path.join(directory,'.desktop-session.lock','owner.json'),'utf8'));
const token=process.env.VARIN_DESKTOP_SCOPE_TOKEN;
const file=path.join(directory,'.desktop-session.lock','scopes',token+'.json');
const original=JSON.parse(fs.readFileSync(file,'utf8'));
verify(directory,owner);
for(const change of [{{guardianPid:process.pid}},{{nodePid:process.ppid}},{{leaseToken:token}},{{shellPid:process.pid}},{{phase:'ended'}},{{extra:true}}]) {{
 fs.writeFileSync(file,JSON.stringify({{...original,...change}}));
 let rejected=false;try{{verify(directory,owner)}}catch{{rejected=true}}
 if(!rejected)throw new Error('Invalid guardian identity was accepted');
}}
fs.writeFileSync(file,JSON.stringify(original));verify(directory,owner);
process.stdout.write('verified');
"#,
            serde_json::to_string(url::Url::from_file_path(source).unwrap().as_str()).unwrap()
        );
        let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
        let mut command = Command::new(node);
        command
            .args(["--import", "tsx", "--input-type=module", "-e", &script])
            .env("VARIN_TEST_LEASE_DIR", directory.path());
        let (mut child, guardian) = spawn(command, directory.path(), Stdio::null()).unwrap();
        tokio::io::AsyncWriteExt::write_all(child.stdin.as_mut().unwrap(), b"begin\n")
            .await
            .unwrap();
        drop(child.stdin.take());
        let mut output = String::new();
        tokio::time::timeout(
            Duration::from_secs(10),
            child.stdout.take().unwrap().read_to_string(&mut output),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(output, "verified");
        // The private protocol consumer has now observed EOF and its receipt.
        if requires_owner_drain() {
            guardian.confirm_drained().unwrap();
        }
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        assert!(guardian.finished().unwrap().clean);
        drop(lease);
        crate::desktop_lock::Lease::acquire(directory.path()).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn control_loss_reaps_detached_generations_and_preserves_independent_service() {
        use super::*;
        use tokio::io::{AsyncBufReadExt, BufReader};
        let directory = tempfile::tempdir().unwrap();
        let lease = crate::desktop_lock::Lease::acquire(directory.path()).unwrap();
        let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
        let mut independent = Command::new(&node)
            .args(["-e", "setInterval(()=>{},1000)"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        // Both generations deliberately leave the original PG/session. The
        // middle process exits, so the grandchild must be adopted before stop.
        let script = r#"
const {spawn}=require('node:child_process');
const inner="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.send(c.pid);c.unref();process.disconnect();";
const c=spawn(process.execPath,['-e',inner],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
c.on('message',pid=>c.on('exit',()=>process.stdout.write(JSON.stringify({node:process.pid,grandchild:pid})+'\n')));
setInterval(()=>{},1000);
"#;
        let mut command = Command::new(node);
        command.args(["-e", script]);
        let (mut child, guardian) = spawn(command, directory.path(), Stdio::inherit()).unwrap();
        let mut line = String::new();
        tokio::time::timeout(
            Duration::from_secs(10),
            BufReader::new(child.stdout.take().unwrap()).read_line(&mut line),
        )
        .await
        .unwrap()
        .unwrap();
        let pids: serde_json::Value = serde_json::from_str(&line).unwrap();
        drop(guardian); // Actual socket EOF, without a graceful Host stop.
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        for key in ["node", "grandchild"] {
            let pid = pids[key].as_i64().unwrap() as i32;
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{key} was not reaped");
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
        assert!(independent.try_wait().unwrap().is_none());
        independent.kill().await.unwrap();
        independent.wait().await.unwrap();
        drop(lease);
        // A new shell may admit only after guardian committed the real receipt.
        crate::desktop_lock::Lease::acquire(directory.path()).unwrap();
    }
    #[test]
    fn completion_requires_a_whole_bounded_receipt_not_socket_eof() {
        use super::*;
        let (parent, mut peer) = UnixStream::pair().unwrap();
        let guardian = Guardian {
            socket: Mutex::new(parent),
        };
        peer.write_all(b"{\"clean\":false,\"code\":13,\"success\":false}\n")
            .unwrap();
        let receipt = guardian.finished().unwrap();
        assert!(!receipt.clean && !receipt.success);
        assert_eq!(receipt.code, Some(13));
        drop(peer);
        assert!(guardian.finished().is_err());
        let (parent, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(b"{\"clean\":true").unwrap();
        drop(peer);
        assert!(
            Guardian {
                socket: Mutex::new(parent)
            }
            .finished()
            .is_err()
        );
    }
    #[test]
    #[ignore = "private native guardian subprocess"]
    fn guardian_entry() {
        let Ok(count) = std::env::var("VARIN_TEST_GUARDIAN_ARGUMENTS") else {
            return;
        };
        let args = (0..count.parse::<usize>().unwrap())
            .map(|index| std::env::var_os(format!("VARIN_TEST_GUARDIAN_ARG_{index}")).unwrap())
            .collect();
        std::process::exit(super::run(args));
    }
}
