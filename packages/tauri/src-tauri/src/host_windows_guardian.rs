//! Independent Windows scope owner. Control and service pipes are physically
//! distinct. The guardian never enters its managed Job, so a dead shell cannot
//! kill the only observer before it records the original tree's real terminal
//! state. A guardian failure remains unconfirmed; Job-name absence is no proof.
use crate::{desktop_lock::ScopeLease, host_scope::ScopeExit};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::{Read, Write},
    mem::size_of,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    ptr::{null, null_mut},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::process::{ChildStdin, ChildStdout, Command};
use windows_sys::Win32::{
    Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE},
        JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateEventW, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
            GetExitCodeProcess, GetProcessId, INFINITE, InitializeProcThreadAttributeList,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION,
            ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, SetEvent,
            UpdateProcThreadAttribute, WaitForMultipleObjects, WaitForSingleObject,
        },
    },
};
#[cfg_attr(test, allow(dead_code))]
const ENTRY: &str = "--varin-windows-service-guardian";
// A maximum Windows UTF-16 path, worst-case decimal JSON encoding, plus fixed
// UUIDs, handle numbers and envelope fields. Host frames never use this bound.
const MAX_GUARDIAN_FRAME: usize = 32767 * 6 + 1024;

/// Preserve the original service's wait boundary, even though the independent
/// guardian is its direct parent. Tokio owns the actual service pipes, and this
/// object waits on the exact process handle transferred at admission.
pub struct ManagedChild {
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    process: OwnedHandle,
    status: Option<ExitStatus>,
}
impl ManagedChild {
    pub async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.stdin.take();
        if let Some(status) = self.status {
            return Ok(status);
        }
        // Poll the retained object, not a PID. Cancellation retains that object
        // and does not turn a pending wait into termination or drop cleanup.
        loop {
            match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    let status = ExitStatus::from_raw(code);
                    self.status = Some(status);
                    return Ok(status);
                }
                WAIT_TIMEOUT => tokio::time::sleep(Duration::from_millis(10)).await,
                _ => return Err(std::io::Error::last_os_error()),
            }
        }
    }
}

pub struct Guardian {
    control: Mutex<File>,
    reply: Arc<Mutex<File>>,
}
impl Guardian {
    pub async fn finished(&self) -> Result<ScopeExit, String> {
        self.control
            .lock()
            .map_err(|_| "Managed guardian control is unavailable")?
            .write_all(b"S")
            .map_err(|_| "Managed guardian settlement is unconfirmed")?;
        let reply = self.reply.clone();
        tokio::task::spawn_blocking(move || {
            let mut reply = reply
                .lock()
                .map_err(|_| "Managed guardian receipt is unavailable")?;
            read_frame::<ScopeExit>(&mut *reply)
        })
        .await
        .map_err(|_| "Managed guardian completion is unknown")?
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Admission {
    data: Vec<u16>,
    owner_token: String,
    scope_token: String,
    shell: usize,
    job: usize,
    input: usize,
    output: usize,
    reply: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    process: usize,
    pid: u32,
}

type Spawned = (ManagedChild, Guardian, OwnedHandle, OwnedHandle, u32);
pub fn spawn(command: Command, data: &Path, stderr: Stdio) -> Result<Spawned, String> {
    let owner = crate::desktop_lock::verified_live_tauri_owner(data)?;
    if owner.pid != std::process::id() {
        return Err("Managed service does not own the original desktop lease".into());
    }
    let data = data
        .canonicalize()
        .map_err(|_| "Desktop data directory is unavailable")?;
    let token = uuid::Uuid::new_v4().to_string();
    let job = create_job()?;
    let observed_job = job
        .try_clone()
        .map_err(|_| "Original Job observer could not be retained")?;
    let (input, parent_input) = std::io::pipe().map_err(|_| "Service input pipe is unavailable")?;
    let (parent_output, output) =
        std::io::pipe().map_err(|_| "Service output pipe is unavailable")?;
    let (mut parent_reply, reply) =
        std::io::pipe().map_err(|_| "Guardian reply pipe is unavailable")?;
    let source = command.as_std();
    let mut native =
        Command::new(std::env::current_exe().map_err(|_| "Native guardian is unavailable")?);
    let arguments: Vec<OsString> = std::iter::once(source.get_program().to_owned())
        .chain(source.get_args().map(ToOwned::to_owned))
        .collect();
    #[cfg(not(test))]
    native.arg(ENTRY).args(&arguments);
    #[cfg(test)]
    {
        native.args([
            "--exact",
            "host_windows_guardian::tests::guardian_entry",
            "--ignored",
            "--nocapture",
        ]);
        native.env(
            "VARIN_TEST_WINDOWS_GUARDIAN_ARGUMENTS",
            arguments.len().to_string(),
        );
        for (index, argument) in arguments.iter().enumerate() {
            native.env(format!("VARIN_TEST_WINDOWS_GUARDIAN_ARG_{index}"), argument);
        }
    }
    for (key, value) in source.get_envs() {
        match value {
            Some(value) => {
                native.env(key, value);
            }
            None => {
                native.env_remove(key);
            }
        }
    }
    if let Some(directory) = source.get_current_dir() {
        native.current_dir(directory);
    }
    native
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(stderr)
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = native
        .spawn()
        .map_err(|_| "Native guardian could not start")?;
    drop(native);
    let raw = child
        .raw_handle()
        .ok_or("Original guardian handle is unavailable")?;
    let guardian_process = unsafe { BorrowedHandle::borrow_raw(raw) }
        .try_clone_to_owned()
        .map_err(|_| "Original guardian handle could not be retained")?;
    let control = child
        .stdin
        .take()
        .ok_or("Guardian control pipe is unavailable")?
        .into_owned_handle()
        .map_err(|_| "Guardian control pipe is unavailable")?;
    let mut control = File::from(control);
    // No scope receipt exists until the running guardian receives this exact
    // admission. A shell crash before then cannot strand a pending writer lease.
    let result = (|| {
        let admission = Admission {
            data: data.as_os_str().encode_wide().collect(),
            owner_token: owner.token,
            scope_token: token.clone(),
            shell: duplicate_to(
                unsafe { GetCurrentProcess() },
                guardian_process.as_raw_handle(),
                false,
            )?,
            job: duplicate_to(job.as_raw_handle(), guardian_process.as_raw_handle(), false)?,
            input: duplicate_to(
                input.as_raw_handle(),
                guardian_process.as_raw_handle(),
                false,
            )?,
            output: duplicate_to(
                output.as_raw_handle(),
                guardian_process.as_raw_handle(),
                false,
            )?,
            reply: duplicate_to(
                reply.as_raw_handle(),
                guardian_process.as_raw_handle(),
                false,
            )?,
        };
        write_frame(&mut control, &admission)?;
        // Parent copies must not keep the service or guardian output alive.
        drop(input);
        drop(output);
        drop(reply);
        let ready: Ready = read_frame(&mut parent_reply)?;
        if ready.process == 0 || ready.pid == 0 {
            return Err("Managed service admission is invalid".into());
        }
        let original = unsafe { OwnedHandle::from_raw_handle(ready.process as HANDLE) };
        if unsafe { GetProcessId(original.as_raw_handle()) } != ready.pid {
            return Err("Managed service admission changed its original process".into());
        }
        let process = original
            .try_clone()
            .map_err(|_| "Original service handle could not be retained")?;
        let stdin = std::process::ChildStdin::from(OwnedHandle::from(parent_input));
        let stdout = std::process::ChildStdout::from(OwnedHandle::from(parent_output));
        let stdin = ChildStdin::from_std(stdin)
            .map_err(|_| "Service input pipe could not be registered")?;
        let stdout = ChildStdout::from_std(stdout)
            .map_err(|_| "Service output pipe could not be registered")?;
        Ok((
            ManagedChild {
                stdin: Some(stdin),
                stdout: Some(stdout),
                process,
                status: None,
            },
            Guardian {
                control: Mutex::new(control),
                reply: Arc::new(Mutex::new(File::from(OwnedHandle::from(parent_reply)))),
            },
            original,
            ready.pid,
        ))
    })();
    // Always retain an actual waiter for the observer, independently of Node's
    // Child wrapper. An uncertain admission is cleaned by its private EOF.
    tokio::spawn(async move {
        let _ = child.wait().await;
        // A lost observer must not leave an unobserved writer running merely
        // because the shell still holds its Job handle. This is cancellation
        // only, never a terminal receipt inferred from the guardian's exit code.
        unsafe {
            TerminateJobObject(observed_job.as_raw_handle(), 1);
        }
    });
    match result {
        Ok((child, guardian, original, pid)) => Ok((child, guardian, job, original, pid)),
        Err(error) => {
            unsafe {
                TerminateJobObject(job.as_raw_handle(), 1);
            }
            Err(error)
        }
    }
}

fn create_job() -> Result<OwnedHandle, String> {
    let handle = unsafe { CreateJobObjectW(null(), null()) };
    if handle.is_null() {
        return Err("Managed Job could not be created".into());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err("Managed Job limits could not be established".into());
    }
    Ok(job)
}
fn duplicate_to(handle: HANDLE, target: HANDLE, inherit: bool) -> Result<usize, String> {
    let mut output = null_mut();
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            handle,
            target,
            &mut output,
            0,
            inherit.into(),
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err("Original managed handle could not be transferred".into());
    }
    Ok(output as usize)
}
fn read_frame<T: serde::de::DeserializeOwned>(input: &mut impl Read) -> Result<T, String> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0];
        input
            .read_exact(&mut byte)
            .map_err(|_| "Managed guardian receipt is unconfirmed")?;
        if byte[0] == b'\n' {
            break;
        }
        // This is a private handle/admission envelope, never a Host frame.
        if bytes.len() == MAX_GUARDIAN_FRAME {
            return Err("Managed guardian envelope is invalid".into());
        }
        bytes.push(byte[0]);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Managed guardian envelope is invalid".into())
}
fn write_frame(output: &mut impl Write, value: &impl Serialize) -> Result<(), String> {
    serde_json::to_writer(&mut *output, value)
        .map_err(|_| "Managed guardian receipt could not be sent")?;
    output
        .write_all(b"\n")
        .map_err(|_| "Managed guardian receipt could not be sent".into())
}

#[cfg_attr(test, allow(dead_code))]
pub fn run_if_requested() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(ENTRY)) {
        return;
    }
    std::process::exit(run(args.collect()));
}
fn run(arguments: Vec<OsString>) -> i32 {
    if run_inner(arguments).is_ok() { 0 } else { 1 }
}
fn run_inner(arguments: Vec<OsString>) -> Result<(), String> {
    if arguments.is_empty() {
        return Err("Managed guardian program is missing".into());
    }
    let mut control = std::io::stdin();
    let admission: Admission = read_frame(&mut control)?;
    let own = |raw: usize| -> Result<OwnedHandle, String> {
        if raw == 0 || raw == usize::MAX {
            return Err("Managed guardian handle is invalid".into());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(raw as HANDLE) })
    };
    let shell = own(admission.shell)?;
    let job = Arc::new(own(admission.job)?);
    let input = own(admission.input)?;
    let output = own(admission.output)?;
    let mut reply = File::from(own(admission.reply)?);
    let data = PathBuf::from(OsString::from_wide(&admission.data));
    #[cfg(test)]
    pause_admission("before-pending", &shell, None)?;
    let lease = ScopeLease::prepare_windows_guardian(
        &data,
        shell.as_handle(),
        &admission.owner_token,
        &admission.scope_token,
    )?;
    // From this point a running independent observer owns even a pending receipt.
    // No user instruction has run, and every future child is born in the Job.
    let mut original: Option<OwnedHandle> = None;
    let result = (|| -> Result<(), String> {
        #[cfg(test)]
        pause_admission("pending", &shell, None)?;
        if unsafe { WaitForSingleObject(shell.as_raw_handle(), 0) } != WAIT_TIMEOUT {
            return Err("Original shell ended before process creation".into());
        }
        let (process, thread, pid) =
            create_service(&arguments, &job, &input, &output, lease.token())?;
        original = Some(process);
        // Only the real service may retain its stdin reader/stdout writer.
        // Keeping these in the guardian would hide protocol EOF from its owner.
        drop(input);
        drop(output);
        let process = original.as_ref().unwrap();
        #[cfg(test)]
        pause_admission("created", &shell, Some(pid))?;
        lease.mark_active(std::process::id(), pid)?;
        let event = unsafe { CreateEventW(null(), 1, 0, null()) };
        if event.is_null() {
            return Err("Managed guardian wake event is unavailable".into());
        }
        let event = Arc::new(unsafe { OwnedHandle::from_raw_handle(event) });
        let cancelled = Arc::new(AtomicBool::new(false));
        let watcher_event = event.clone();
        let watcher_cancelled = cancelled.clone();
        let watcher_job = job.clone();
        // The only inherited control-reader is in the guardian; Node receives
        // its separate input and cannot keep shell-control EOF from arriving.
        std::thread::Builder::new()
            .name("service-control".into())
            .spawn(move || {
                let mut byte = [0];
                let settle = control.read_exact(&mut byte).is_ok() && byte[0] == b'S';
                if !settle {
                    watcher_cancelled.store(true, Ordering::Release);
                    unsafe {
                        TerminateJobObject(watcher_job.as_raw_handle(), 1);
                    }
                }
                unsafe {
                    SetEvent(watcher_event.as_raw_handle());
                }
            })
            .map_err(|_| "Managed guardian control could not be observed")?;
        let shell_event = event.clone();
        let shell_cancelled = cancelled.clone();
        let shell_job = job.clone();
        let shell_watch = shell
            .try_clone()
            .map_err(|_| "Original shell could not be retained")?;
        std::thread::Builder::new()
            .name("service-shell".into())
            .spawn(move || {
                // Keep watching the original shell object, including after an S byte.
                if unsafe { WaitForSingleObject(shell_watch.as_raw_handle(), INFINITE) }
                    == WAIT_OBJECT_0
                {
                    shell_cancelled.store(true, Ordering::Release);
                    unsafe {
                        TerminateJobObject(shell_job.as_raw_handle(), 1);
                        SetEvent(shell_event.as_raw_handle());
                    }
                }
            })
            .map_err(|_| "Original shell termination could not be observed")?;
        if unsafe { WaitForSingleObject(shell.as_raw_handle(), 0) } != WAIT_TIMEOUT {
            return Err("Original shell ended before service admission".into());
        }
        #[cfg(test)]
        pause_admission("active", &shell, Some(pid))?;
        if unsafe { WaitForSingleObject(shell.as_raw_handle(), 0) } != WAIT_TIMEOUT {
            return Err("Original shell ended before process resume".into());
        }
        let remote = duplicate_to(process.as_raw_handle(), shell.as_raw_handle(), false)?;
        // Unlike a Toolhelp enumeration this is the exact initial thread returned
        // by CreateProcess. Job membership was atomic, before the thread existed.
        if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
            return Err("Original service initial thread could not be resumed".into());
        }
        write_frame(
            &mut reply,
            &Ready {
                process: remote,
                pid,
            },
        )?;
        drop(thread);
        if unsafe { WaitForSingleObject(process.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 {
            return Err("Original service termination is unknown".into());
        }
        let waits = [event.as_raw_handle(), shell.as_raw_handle()];
        let wake =
            unsafe { WaitForMultipleObjects(waits.len() as u32, waits.as_ptr(), 0, INFINITE) };
        if wake != WAIT_OBJECT_0 && wake != WAIT_OBJECT_0 + 1 {
            return Err("Managed guardian settlement request is unknown".into());
        }
        let mut clean = !cancelled.load(Ordering::Acquire)
            && unsafe { WaitForSingleObject(shell.as_raw_handle(), 0) } == WAIT_TIMEOUT
            && crate::host_scope::windows::settle_original(&job, process, pid)?;
        if !clean && unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
            return Err("Original Job termination was not accepted".into());
        }
        while !crate::host_scope::windows::empty_original(&job, process, pid)? {
            std::thread::sleep(Duration::from_millis(10));
        }
        clean &= !cancelled.load(Ordering::Acquire);
        let mut code = 0;
        if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } == 0 {
            return Err("Original service exit result is unavailable".into());
        }
        lease.mark_ended()?;
        // A vanished shell cannot receive this, but the durable OS receipt is
        // already committed. This is not a successful application drain claim.
        let _ = write_frame(
            &mut reply,
            &ScopeExit {
                clean,
                code: Some(code as i32),
                success: code == 0,
            },
        );
        Ok(())
    })();
    if result.is_err() {
        if let Some(process) = &original {
            let pid = unsafe { GetProcessId(process.as_raw_handle()) };
            if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
                return result;
            }
            while !crate::host_scope::windows::empty_original(&job, process, pid)? {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        // With no original process, CreateProcess never succeeded. With one,
        // only the complete retained-objects observation above grants release.
        lease.mark_ended()?;
    }
    result
}

/// JOB_LIST closes the suspended-spawn/AssignProcess crash gap. HANDLE_LIST
/// prevents the child from inheriting the guardian's Job, shell, or control.
/// Windows 10+ is the desktop's supported floor for these official APIs:
/// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
fn create_service(
    arguments: &[OsString],
    job: &OwnedHandle,
    input: &OwnedHandle,
    output: &OwnedHandle,
    token: &str,
) -> Result<(OwnedHandle, OwnedHandle, u32), String> {
    let mut command_line = Vec::new();
    for (index, argument) in arguments.iter().enumerate() {
        if index != 0 {
            command_line.push(b' ' as u16);
        }
        quote_argument(argument, &mut command_line)?;
    }
    command_line.push(0);
    if command_line.len() > 32767 {
        return Err("Managed service command line exceeds the Windows limit".into());
    }
    let current = unsafe { GetCurrentProcess() };
    let stdin = unsafe {
        OwnedHandle::from_raw_handle(duplicate_to(input.as_raw_handle(), current, true)? as HANDLE)
    };
    let stdout = unsafe {
        OwnedHandle::from_raw_handle(duplicate_to(output.as_raw_handle(), current, true)? as HANDLE)
    };
    // Explorer-launched GUI applications need not have a standard error
    // handle. Keep an inherited handle when present, but give the service a
    // real NUL handle when there is no console. Never pass NULL as an explicit
    // STARTF_USESTDHANDLES value or treat an arbitrary duplication failure as
    // permission to replace an existing stream.
    let inherited_stderr = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    let null_stderr = if inherited_stderr.is_null() {
        Some(
            File::options()
                .write(true)
                .open("NUL")
                .map_err(|_| "Managed service null error stream is unavailable")?,
        )
    } else {
        None
    };
    let stderr_source = null_stderr
        .as_ref()
        .map_or(inherited_stderr, AsRawHandle::as_raw_handle);
    let stderr = unsafe {
        OwnedHandle::from_raw_handle(duplicate_to(stderr_source, current, true)? as HANDLE)
    };
    let handles = [
        stdin.as_raw_handle(),
        stdout.as_raw_handle(),
        stderr.as_raw_handle(),
    ];
    let jobs = [job.as_raw_handle()];
    let mut bytes = 0;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
    }
    if bytes == 0 {
        return Err("Managed process attributes are unavailable".into());
    }
    let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let attributes = buffer.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(attributes, 2, 0, &mut bytes) } == 0 {
        return Err("Managed process attributes could not be initialized".into());
    }
    struct Attributes(windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0);
            }
        }
    }
    let _attributes = Attributes(attributes);
    for (kind, value, size) in [
        (
            PROC_THREAD_ATTRIBUTE_JOB_LIST,
            jobs.as_ptr().cast(),
            size_of_val(&jobs),
        ),
        (
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            handles.as_ptr().cast(),
            size_of_val(&handles),
        ),
    ] {
        if unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                kind as usize,
                value,
                size,
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err("Managed process containment attributes could not be set".into());
        }
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes;
    let mut process = PROCESS_INFORMATION::default();
    // Construct the environment without mutating this guardian's process-global
    // environment. UTF-16 preserves the exact Windows names and values.
    let mut environment: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| {
            !key.to_string_lossy()
                .eq_ignore_ascii_case("VARIN_DESKTOP_SCOPE_TOKEN")
                && !key
                    .to_string_lossy()
                    .starts_with("VARIN_TEST_WINDOWS_GUARDIAN_")
        })
        .collect();
    environment.push(("VARIN_DESKTOP_SCOPE_TOKEN".into(), token.into()));
    environment.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block: Vec<u16> = Vec::new();
    for (key, value) in environment {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    #[cfg(not(test))]
    let console_flags = CREATE_NO_WINDOW;
    #[cfg(test)]
    let console_flags =
        if std::env::var_os("VARIN_TEST_WINDOWS_GUARDIAN_DETACHED_SERVICE").is_some() {
            // CREATE_NO_WINDOW still permits a hidden conhost. The exact Job
            // snapshot regression requires only its explicitly synchronized native
            // actors, so that fixture has no console at all. This flag never permits
            // Job breakaway and does not alter production service startup.
            // https://github.com/microsoft/terminal/blob/main/doc/specs/%23492%20-%20Default%20Terminal/spec.md
            windows_sys::Win32::System::Threading::DETACHED_PROCESS
        } else {
            CREATE_NO_WINDOW
        };
    if unsafe {
        CreateProcessW(
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            console_flags
                | CREATE_SUSPENDED
                | EXTENDED_STARTUPINFO_PRESENT
                | windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT,
            block.as_ptr().cast(),
            null(),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(format!(
            "Managed service could not start in its Job (OS error {:?})",
            std::io::Error::last_os_error().raw_os_error()
        ));
    }
    Ok((
        unsafe { OwnedHandle::from_raw_handle(process.hProcess) },
        unsafe { OwnedHandle::from_raw_handle(process.hThread) },
        process.dwProcessId,
    ))
}
fn quote_argument(argument: &OsStr, output: &mut Vec<u16>) -> Result<(), String> {
    // Microsoft C runtime quoting, also used by Node and our native fixtures.
    // This is CreateProcess, never a shell command or cmd.exe expansion.
    output.push(b'"' as u16);
    let mut slashes = 0;
    for value in argument.encode_wide() {
        if value == 0 {
            return Err("Managed service argument contains a NUL".into());
        }
        if value == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            b'\\' as u16,
            if value == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        output.push(value);
    }
    output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    output.push(b'"' as u16);
    Ok(())
}

#[cfg(test)]
pub(crate) fn pause_admission(
    phase: &str,
    shell: &impl AsRawHandle,
    node: Option<u32>,
) -> Result<(), String> {
    if std::env::var("VARIN_TEST_WINDOWS_SCOPE_PHASE")
        .ok()
        .as_deref()
        != Some(phase)
    {
        return Ok(());
    }
    let root = PathBuf::from(
        std::env::var_os("VARIN_TEST_WINDOWS_SCOPE_ROOT").ok_or("Fixture root is missing")?,
    );
    let data = serde_json::json!({"guardian": std::process::id(), "node": node, "phase":phase});
    std::fs::write(
        root.join("stage.pending"),
        serde_json::to_vec(&data).unwrap(),
    )
    .map_err(|_| "Fixture stage write failed")?;
    std::fs::rename(root.join("stage.pending"), root.join("stage.json"))
        .map_err(|_| "Fixture stage publication failed")?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !root.join("continue").exists()
        && (phase == "enrolling"
            || unsafe { WaitForSingleObject(shell.as_raw_handle(), 0) } == WAIT_TIMEOUT)
    {
        if std::time::Instant::now() >= deadline {
            return Err("Fixture admission release timed out".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        TerminateProcess,
    };

    #[test]
    #[ignore = "private Windows guardian entry"]
    fn guardian_entry() {
        let count: usize = std::env::var("VARIN_TEST_WINDOWS_GUARDIAN_ARGUMENTS")
            .unwrap()
            .parse()
            .unwrap();
        let arguments = (0..count)
            .map(|index| {
                std::env::var_os(format!("VARIN_TEST_WINDOWS_GUARDIAN_ARG_{index}")).unwrap()
            })
            .collect();
        if std::env::var_os("VARIN_TEST_WINDOWS_GUARDIAN_NULL_STDERR").is_some() {
            // A separate native fixture process models Explorer GUI startup;
            // never mutate this test runner's process-global standard handles.
            assert_ne!(
                unsafe {
                    windows_sys::Win32::System::Console::SetStdHandle(STD_ERROR_HANDLE, null_mut())
                },
                0
            );
        }
        std::process::exit(run(arguments));
    }

    #[tokio::test]
    async fn missing_gui_stderr_keeps_service_admission_and_clean_settlement() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let data = tempfile::tempdir().unwrap();
        let _lease = crate::desktop_lock::Lease::acquire(data.path()).unwrap();
        let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
        let mut command = Command::new(node);
        command
            .args([
                "-e",
                "require('node:fs').writeSync(2,'valid native error stream\\n');process.stdout.write('ready\\n')",
            ])
            .env("VARIN_TEST_WINDOWS_GUARDIAN_NULL_STDERR", "1");
        let (mut child, scope) =
            crate::host_scope::ProcessScope::spawn(command, data.path()).unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .await
            .unwrap();
        assert_eq!(line, "ready\n");
        let status = child.wait().await;
        let ended = tokio::time::timeout(
            Duration::from_secs(10),
            scope.settle_after_node_exit(&status),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(ended.clean && ended.success, "Original scope: {ended:?}");
        assert!(scope.empty().unwrap());
    }

    #[tokio::test]
    #[ignore = "private shell process for real Windows admission/crash tests"]
    async fn shell_fixture() {
        let root = PathBuf::from(std::env::var_os("VARIN_TEST_WINDOWS_SCOPE_ROOT").unwrap());
        let _lease = crate::desktop_lock::Lease::acquire(&root).unwrap();
        let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
        let mut command = Command::new(node);
        command.args(["-e", r#"const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const root=process.argv[1];const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(root,'writers.pending'),JSON.stringify([process.pid,c.pid]));fs.renameSync(path.join(root,'writers.pending'),path.join(root,'writers.json'));setInterval(()=>{},1000);"#]).arg(&root);
        let (mut child, _scope) = crate::host_scope::ProcessScope::spawn(command, &root).unwrap();
        std::fs::write(root.join("admitted"), b"ready").unwrap();
        let _ = child.wait().await;
        // Parent crash tests must kill this original shell; a natural service
        // return is not a substitute for that failure path.
        std::future::pending::<()>().await;
    }

    fn fixture(root: &Path, phase: &str) -> std::process::Child {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "host_windows_guardian::tests::shell_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("VARIN_TEST_WINDOWS_SCOPE_ROOT", root)
            .env("VARIN_TEST_WINDOWS_SCOPE_PHASE", phase)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap()
    }
    fn pin(pid: u32) -> OwnedHandle {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                0,
                pid,
            )
        };
        assert!(
            !handle.is_null(),
            "Original fixture object: {}",
            std::io::Error::last_os_error()
        );
        unsafe { OwnedHandle::from_raw_handle(handle) }
    }
    fn wait_file(path: &Path, parent: &mut std::process::Child) -> serde_json::Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(value) = serde_json::from_slice(&bytes) {
                    return value;
                }
            }
            assert!(
                parent.try_wait().unwrap().is_none(),
                "Original fixture exited before admission stage"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "Fixture admission stage timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn ended(process: &OwnedHandle) -> bool {
        unsafe { WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_OBJECT_0 }
    }
    fn wait_ended(process: &OwnedHandle) {
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 20_000) },
            WAIT_OBJECT_0,
            "The original fixture object, not its PID or exit code, must signal"
        );
    }

    #[test]
    fn shell_crash_recovers_only_after_every_original_admitted_object_stops() {
        for phase in [
            "before-pending",
            "enrolling",
            "pending",
            "created",
            "active",
            "running",
        ] {
            let data = tempfile::tempdir().unwrap();
            let mut parent = fixture(data.path(), phase);
            let mut original = Vec::new();
            let guardian;
            if phase == "running" {
                let ids = wait_file(&data.path().join("writers.json"), &mut parent);
                for pid in ids.as_array().unwrap() {
                    original.push(pin(pid.as_u64().unwrap() as u32));
                }
                // Read the actual committed owner receipt, never a fixture-built DTO.
                let scopes = data.path().join(".desktop-session.lock/scopes");
                let path = std::fs::read_dir(scopes)
                    .unwrap()
                    .next()
                    .unwrap()
                    .unwrap()
                    .path();
                let receipt: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                guardian = pin(receipt["guardianPid"].as_u64().unwrap() as u32);
            } else {
                let stage = wait_file(&data.path().join("stage.json"), &mut parent);
                guardian = pin(stage["guardian"].as_u64().unwrap() as u32);
                if let Some(pid) = stage["node"].as_u64() {
                    original.push(pin(pid as u32));
                }
                assert!(
                    !data.path().join("writers.json").exists(),
                    "No service instruction may execute before admission"
                );
            }
            assert!(original.iter().all(|handle| !ended(handle)));
            assert!(crate::desktop_lock::Lease::acquire(data.path()).is_err());
            parent.kill().unwrap();
            parent.wait().unwrap(); // Keep the parent's exact original handle pinned.
            if phase == "enrolling" {
                assert!(
                    crate::desktop_lock::Lease::acquire(data.path()).is_err(),
                    "An enrolled guardian must pin the original directory before publishing pending"
                );
                std::fs::write(data.path().join("continue"), b"publish").unwrap();
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            let next = loop {
                match crate::desktop_lock::Lease::acquire(data.path()) {
                    Ok(lease) => {
                        assert!(
                            original.iter().all(ended),
                            "Recovery cannot precede original process-object termination at {phase}"
                        );
                        break lease;
                    }
                    Err(_) => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "Original guardian did not settle {phase}"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            };
            wait_ended(&guardian);
            next.verify().unwrap();
            if phase != "running" {
                assert!(!data.path().join("writers.json").exists());
            }
        }
    }

    #[test]
    fn guardian_crash_before_resume_never_leaks_a_writer_or_forges_a_receipt() {
        for phase in ["created", "active"] {
            let data = tempfile::tempdir().unwrap();
            let mut parent = fixture(data.path(), phase);
            let stage = wait_file(&data.path().join("stage.json"), &mut parent);
            let guardian = pin(stage["guardian"].as_u64().unwrap() as u32);
            let node = pin(stage["node"].as_u64().unwrap() as u32);
            assert_ne!(unsafe { TerminateProcess(guardian.as_raw_handle(), 1) }, 0);
            wait_ended(&guardian);
            // Admission sees the observer EOF, terminates the retained Job, and
            // fails. The suspended service was born in that exact Job.
            assert_eq!(
                unsafe { WaitForSingleObject(parent.as_raw_handle(), 20_000) },
                WAIT_OBJECT_0
            );
            parent.wait().unwrap();
            wait_ended(&node);
            assert!(!data.path().join("writers.json").exists());
            assert!(
                crate::desktop_lock::Lease::acquire(data.path()).is_err(),
                "A crashed guardian did not attest the scope, even if these fixture handles stopped"
            );
            let scopes = data.path().join(".desktop-session.lock/scopes");
            let path = std::fs::read_dir(scopes)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            let receipt: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_ne!(receipt["phase"], "ended");
        }
    }

    #[test]
    fn running_guardian_loss_stops_original_writers_but_keeps_scope_unconfirmed() {
        let data = tempfile::tempdir().unwrap();
        let mut parent = fixture(data.path(), "running");
        let ids = wait_file(&data.path().join("writers.json"), &mut parent);
        let original: Vec<_> = ids
            .as_array()
            .unwrap()
            .iter()
            .map(|pid| pin(pid.as_u64().unwrap() as u32))
            .collect();
        let scopes = data.path().join(".desktop-session.lock/scopes");
        let path = std::fs::read_dir(scopes)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let before = std::fs::read(&path).unwrap();
        let receipt: serde_json::Value = serde_json::from_slice(&before).unwrap();
        let guardian = pin(receipt["guardianPid"].as_u64().unwrap() as u32);
        assert_ne!(unsafe { TerminateProcess(guardian.as_raw_handle(), 0) }, 0);
        wait_ended(&guardian);
        for process in &original {
            wait_ended(process);
        }
        assert!(
            parent.try_wait().unwrap().is_none(),
            "The shell remains alive when its observer dies"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "Even exit code zero cannot forge an observer receipt"
        );
        parent.kill().unwrap();
        parent.wait().unwrap();
        assert!(crate::desktop_lock::Lease::acquire(data.path()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
