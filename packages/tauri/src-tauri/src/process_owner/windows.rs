//! A launch-bound Job owner, independent of the desktop and its lease.
//! The application is born suspended inside the original Job. Only its NUL
//! input and the guardian's diagnostic stream may cross the inheritance boundary.
use super::{Control, Launch, RootExit, emit};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    mem::{size_of, size_of_val},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::{null, null_mut},
    sync::mpsc::{self, Receiver, TryRecvError},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, FILETIME,
        HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::{
        Console::{GetStdHandle, STD_ERROR_HANDLE},
        JobObjects::{
            CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
            JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
            GetExitCodeProcess, GetProcessTimes, InitializeProcThreadAttributeList,
            LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcess, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW,
            UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(10);
// Controls contain only the bounded nonce and a duration, never application data.
const MAX_CONTROL_FRAME: usize = 8192;

pub fn run(launch: Launch) -> Result<(), String> {
    let job = create_job()?;
    let (root, initial_thread, pid) = create_application(&launch, &job)?;
    // No fallible return is allowed past creation until the original scope has
    // actually drained. KILL_ON_JOB_CLOSE is a crash safeguard, not a receipt.
    let mut owner = Owner {
        job,
        root,
        pid,
        members: BTreeMap::new(),
        root_exit: None,
        forced: false,
        failed: false,
        reason: None,
        force_at: None,
        terminated: false,
    };
    let controls = start_control_reader();
    if controls.is_err() {
        owner.fail("Process owner control could not be observed");
    }
    let controls = controls.ok();
    let mut control_closed = controls.is_none();
    let start_identity = root_start_identity(&owner.root).ok();
    if start_identity.is_none() {
        owner.fail("Original process start identity could not be observed");
    }
    if !owner.failed
        && emit(
            &launch.nonce,
            "ready",
            json!({
                "rootPid":pid,
                "rootIdentity":format!("windows:{}:{pid}", launch.nonce),
                "rootStartIdentity":start_identity
            }),
        )
        .is_err()
    {
        owner.fail("Admission receipt was not delivered");
    }
    owner.poll_controls(controls.as_ref(), &mut control_closed, &launch.nonce);
    // The ready receipt establishes ownership before any application code runs.
    // A failed receipt leaves the exact initial thread suspended for Job cleanup.
    if owner.forced {
        // Cancellation before release does not need an application grace period.
        owner.force_at = Some(Instant::now());
    } else if unsafe { ResumeThread(initial_thread.as_raw_handle()) } != 1 {
        owner.fail("Application release failed");
    }
    drop(initial_thread);
    loop {
        owner.poll_controls(controls.as_ref(), &mut control_closed, &launch.nonce);
        if owner.force_at.is_some_and(|time| Instant::now() >= time) && !owner.terminated {
            // The retained Job is the only termination authority. Never kill a
            // snapshot PID, root PID, process name, or an unrelated process tree.
            if unsafe { TerminateJobObject(owner.job.as_raw_handle(), 1) } != 0 {
                owner.terminated = true;
            } else {
                owner.fail("Original Job termination was not accepted");
            }
        }
        if owner.root_exit.is_none() {
            match root_exit(&owner.root) {
                Ok(Some(exit)) => {
                    owner.root_exit = Some(exit.clone());
                    if emit(&launch.nonce, "root-exit", json!({"rootExit":exit})).is_err() {
                        owner.fail("Root termination receipt was not delivered");
                    }
                }
                Ok(None) => {}
                Err(_) => owner.fail("Original process termination could not be observed"),
            }
        }
        if owner.root_exit.is_some() {
            match owner.drained() {
                Ok(true) => {
                    owner.poll_controls(controls.as_ref(), &mut control_closed, &launch.nonce);
                    let exit = owner.root_exit.as_ref().unwrap();
                    // This is the only post-creation return. Even a lost receipt
                    // channel cannot make us abandon a live original Job member.
                    emit(
                        &launch.nonce,
                        "settled",
                        json!({
                            "ownershipDrainConfirmed":true,
                            "clean":exit.success && !owner.forced && !owner.failed,
                            "forced":owner.forced,
                            "rootExit":exit,
                            "reason":owner.reason
                        }),
                    )?;
                    return Ok(());
                }
                Ok(false) => {}
                Err(_) => owner.fail("Original Job termination could not be observed"),
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

struct Owner {
    job: OwnedHandle,
    root: OwnedHandle,
    pid: u32,
    // Pin each discovered member object for the remainder of this launch. A
    // candidate PID is useful only after membership in our exact Job is verified.
    members: BTreeMap<u32, OwnedHandle>,
    root_exit: Option<RootExit>,
    forced: bool,
    failed: bool,
    reason: Option<&'static str>,
    force_at: Option<Instant>,
    terminated: bool,
}
impl Owner {
    fn poll_controls(
        &mut self,
        controls: Option<&Receiver<Result<Control, ()>>>,
        closed: &mut bool,
        nonce: &str,
    ) {
        while !*closed {
            match controls.unwrap().try_recv() {
                Ok(Ok(Control::Stop {
                    nonce: received,
                    force_after_ms,
                })) if received == nonce && force_after_ms <= 3_600_000 => {
                    self.forced = true;
                    let deadline = Instant::now() + Duration::from_millis(force_after_ms);
                    self.force_at = Some(self.force_at.map_or(deadline, |old| old.min(deadline)));
                }
                Ok(Ok(Control::Settle { nonce: received })) if received == nonce => {
                    // Observation is not cancellation. A successful root with a
                    // live descendant remains owned until it actually stops.
                }
                Err(TryRecvError::Empty) => break,
                _ => {
                    *closed = true;
                    self.fail("Process owner control was lost or invalid");
                }
            }
        }
    }

    fn fail(&mut self, reason: &'static str) {
        self.failed = true;
        self.forced = true;
        self.reason.get_or_insert(reason);
        self.force_at = Some(Instant::now());
    }

    fn drained(&mut self) -> Result<bool, String> {
        self.drained_after_snapshot(|_| {})
    }

    fn drained_after_snapshot(
        &mut self,
        after_snapshot: impl FnOnce(&[u32]),
    ) -> Result<bool, String> {
        if !signaled(&self.root)? {
            return Ok(false);
        }
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of_val(&accounting) as u32,
                null_mut(),
            )
        } == 0
        {
            return Err("Original Job accounting is unavailable".into());
        }
        if accounting.ActiveProcesses == 0 {
            // Windows decrements this count only after process exit and release
            // of all references. Retained handles must still be checked directly.
            // https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information
            return self.all_members_signaled();
        }
        let ids = members(&self.job, accounting.ActiveProcesses as usize)?;
        after_snapshot(&ids);
        for pid in ids {
            if pid == self.pid || self.members.contains_key(&pid) {
                continue;
            }
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            };
            if raw.is_null() {
                if std::io::Error::last_os_error().raw_os_error()
                    == Some(ERROR_INVALID_PARAMETER as i32)
                {
                    // It disappeared during this snapshot. Start another full
                    // reconciliation instead of treating PID disappearance as proof.
                    return Ok(false);
                }
                return Err("Original Job process object is unavailable".into());
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            let mut belongs = 0;
            if unsafe {
                IsProcessInJob(
                    handle.as_raw_handle(),
                    self.job.as_raw_handle(),
                    &mut belongs,
                )
            } == 0
            {
                return Err("Original Job membership could not be verified".into());
            }
            if belongs == 0 {
                // A reused candidate must neither be retained nor signaled.
                return Ok(false);
            }
            self.members.insert(pid, handle);
        }
        if !self.all_members_signaled()? {
            // In particular, an exit code published before native rundown is
            // not completion. Keep polling the object while controls remain live.
            return Ok(false);
        }
        // A member can create another child after the first snapshot and then
        // exit. Pin and wait the old objects before reconciling the entire set.
        // Once every member in this final set signals, none can create children.
        let current = members(&self.job, self.members.len().saturating_add(1))?;
        Ok(current
            .iter()
            .all(|pid| *pid == self.pid || self.members.contains_key(pid)))
    }

    fn all_members_signaled(&self) -> Result<bool, String> {
        for handle in self.members.values() {
            if !signaled(handle)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn signaled(handle: &OwnedHandle) -> Result<bool, String> {
    match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err("Original process object could not be observed".into()),
    }
}

fn root_exit(root: &OwnedHandle) -> Result<Option<RootExit>, String> {
    if !signaled(root)? {
        return Ok(None);
    }
    let mut code = 0;
    if unsafe { GetExitCodeProcess(root.as_raw_handle(), &mut code) } == 0 {
        return Err("Original process exit result is unavailable".into());
    }
    Ok(Some(RootExit {
        code: Some(code as i32),
        signal: None,
        success: code == 0,
    }))
}

fn root_start_identity(root: &OwnedHandle) -> Result<String, String> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe {
        GetProcessTimes(
            root.as_raw_handle(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err("Original process start identity is unavailable".into());
    }
    let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
    Ok(format!("win32:{ticks}"))
}

fn members(job: &OwnedHandle, capacity: usize) -> Result<Vec<u32>, String> {
    let mut capacity = capacity.max(1);
    loop {
        let header = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
        let word = size_of::<usize>();
        let bytes = capacity
            .checked_mul(word)
            .and_then(|size| size.checked_add(header))
            .and_then(|size| u32::try_from(size).ok())
            .ok_or("Original Job member list is too large")?;
        let mut buffer = vec![0usize; (bytes as usize).div_ceil(word)];
        let ok = unsafe {
            QueryInformationJobObject(
                job.as_raw_handle(),
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast(),
                bytes,
                null_mut(),
            )
        };
        if ok == 0 && std::io::Error::last_os_error().raw_os_error() != Some(ERROR_MORE_DATA as i32)
        {
            return Err("Original Job member list is unavailable".into());
        }
        let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
        let count = list.NumberOfProcessIdsInList as usize;
        if ok == 0 || count < list.NumberOfAssignedProcesses as usize {
            capacity = capacity
                .checked_mul(2)
                .map(|value| value.max(list.NumberOfAssignedProcesses as usize))
                .ok_or("Original Job member list is too large")?;
            continue;
        }
        if count > capacity {
            return Err("Original Job member list is invalid".into());
        }
        let ids = unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), count) };
        return ids
            .iter()
            .map(|id| {
                u32::try_from(*id)
                    .ok()
                    .filter(|pid| *pid != 0)
                    .ok_or_else(|| "Original Job member identity is invalid".into())
            })
            .collect();
    }
}

fn start_control_reader() -> Result<Receiver<Result<Control, ()>>, String> {
    // One queued frame bounds memory even when a controller floods the pipe.
    // The detached reader owns no Job or process handle and is never joined, so
    // waiting for another control cannot keep a completed guardian alive.
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("launch-control".into())
        .spawn(move || {
            let mut input = std::io::stdin().lock();
            loop {
                let result = read_control(&mut input);
                let failed = result.is_err();
                if sender.send(result).is_err() || failed {
                    break;
                }
            }
        })
        .map_err(|_| "Process owner control could not be observed")?;
    Ok(receiver)
}

fn read_control(input: &mut impl Read) -> Result<Control, ()> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0];
        match input.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => return serde_json::from_slice(&bytes).map_err(|_| ()),
            Ok(1) if bytes.len() < MAX_CONTROL_FRAME => bytes.push(byte[0]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            _ => return Err(()),
        }
    }
}

fn create_job() -> Result<OwnedHandle, String> {
    let raw = unsafe { CreateJobObjectW(null(), null()) };
    if raw.is_null() {
        return Err("Launch-bound Job could not be created".into());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // Neither explicit nor silent breakaway is permitted.
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err("Launch-bound Job limits could not be established".into());
    }
    Ok(job)
}

fn duplicate_inheritable(handle: HANDLE) -> Result<OwnedHandle, String> {
    let current = unsafe { GetCurrentProcess() };
    let mut output = null_mut();
    if unsafe {
        DuplicateHandle(
            current,
            handle,
            current,
            &mut output,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err("Application stream could not be isolated".into());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(output) })
}

fn create_application(
    launch: &Launch,
    job: &OwnedHandle,
) -> Result<(OwnedHandle, OwnedHandle, u32), String> {
    let executable = wide_string(&launch.executable)?;
    let cwd = launch.cwd.as_deref().map(wide_string).transpose()?;
    let environment = environment_block(&launch.env)?;
    let mut command_line = application_command_line(launch)?;
    let null_input = File::open("NUL").map_err(|_| "Application input is unavailable")?;
    let input = duplicate_inheritable(null_input.as_raw_handle())?;
    let diagnostic = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
    if diagnostic.is_null() || diagnostic == INVALID_HANDLE_VALUE {
        return Err("Process owner diagnostic stream is unavailable".into());
    }
    let output = duplicate_inheritable(diagnostic)?;
    // Both child output streams deliberately share one inherited diagnostic
    // handle. The receipt stdout and private control stdin are not on this list.
    let handles = [input.as_raw_handle(), output.as_raw_handle()];
    let jobs = [job.as_raw_handle()];
    let mut bytes = 0;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
    }
    if bytes == 0 {
        return Err("Application containment attributes are unavailable".into());
    }
    let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let attributes = buffer.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(attributes, 2, 0, &mut bytes) } == 0 {
        return Err("Application containment attributes could not be initialized".into());
    }
    struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
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
            return Err("Application containment attributes could not be set".into());
        }
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[1];
    startup.lpAttributeList = attributes;
    let mut process = PROCESS_INFORMATION::default();
    // JOB_LIST closes the create/assign crash gap. Unsupported nested Jobs fail
    // here; never retry with BREAKAWAY_FROM_JOB or an uncontained process.
    // https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
    if unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_NO_WINDOW
                | CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            cwd.as_ref().map_or(null(), |value| value.as_ptr()),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err("Application could not start inside its original Job".into());
    }
    Ok((
        unsafe { OwnedHandle::from_raw_handle(process.hProcess) },
        unsafe { OwnedHandle::from_raw_handle(process.hThread) },
        process.dwProcessId,
    ))
}

fn wide_string(value: &str) -> Result<Vec<u16>, String> {
    if value.contains('\0') {
        return Err("Invalid application launch string".into());
    }
    Ok(value.encode_utf16().chain(std::iter::once(0)).collect())
}

fn application_command_line(launch: &Launch) -> Result<Vec<u16>, String> {
    let mut command_line = Vec::new();
    // argv[0] remains protected even for a caller-owned verbatim argument tail.
    quote_argument(&launch.executable, &mut command_line)?;
    for argument in &launch.args {
        command_line.push(b' ' as u16);
        if launch.windows_verbatim_arguments {
            if argument.contains('\0') {
                return Err("Invalid application argument".into());
            }
            command_line.extend(argument.encode_utf16());
        } else {
            quote_argument(argument, &mut command_line)?;
        }
    }
    command_line.push(0);
    if command_line.len() > 32767 {
        return Err("Application command line exceeds the Windows limit".into());
    }
    Ok(command_line)
}

fn environment_block(environment: &BTreeMap<String, String>) -> Result<Vec<u16>, String> {
    let mut ordered = BTreeMap::new();
    for (key, value) in environment {
        if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
            return Err("Invalid application environment".into());
        }
        let normalized = key.to_uppercase();
        if let Some((_, previous)) = ordered.insert(normalized, (key, value))
            && previous != value
        {
            return Err("Conflicting application environment names".into());
        }
    }
    let mut block = Vec::new();
    for (key, value) in ordered.values() {
        block.extend(key.encode_utf16());
        block.push(b'=' as u16);
        block.extend(value.encode_utf16());
        block.push(0);
    }
    // Even the explicitly empty environment needs two UTF-16 terminators.
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

fn quote_argument(argument: &str, output: &mut Vec<u16>) -> Result<(), String> {
    // Microsoft CRT quoting. No shell expansion or command interpreter is used.
    output.push(b'"' as u16);
    let mut slashes = 0;
    for value in argument.encode_utf16() {
        if value == 0 {
            return Err("Invalid application argument".into());
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
mod tests {
    use super::*;
    use std::{
        os::windows::process::CommandExt,
        path::Path,
        process::{Command, Stdio},
    };

    const FIXTURE: &str = "process_owner::windows::tests::job_process_fixture";

    fn fixture_launch(root: &Path, role: &str) -> Launch {
        let mut env: BTreeMap<_, _> = std::env::vars().collect();
        env.insert(
            "VARIN_OWNER_FIXTURE_ROOT".into(),
            root.to_str().unwrap().into(),
        );
        env.insert("VARIN_OWNER_FIXTURE_ROLE".into(), role.into());
        Launch {
            nonce: "native-job-fixture".into(),
            executable: std::env::current_exe().unwrap().to_str().unwrap().into(),
            args: vec![
                "--exact".into(),
                FIXTURE.into(),
                "--ignored".into(),
                "--nocapture".into(),
            ],
            windows_verbatim_arguments: false,
            cwd: None,
            env,
        }
    }

    fn fixture_owner(launch: &Launch) -> (Owner, OwnedHandle) {
        let job = create_job().unwrap();
        let (root, thread, pid) = create_application(launch, &job).unwrap();
        (
            Owner {
                job,
                root,
                pid,
                members: BTreeMap::new(),
                root_exit: None,
                forced: false,
                failed: false,
                reason: None,
                force_at: None,
                terminated: false,
            },
            thread,
        )
    }

    fn wait_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "Native fixture did not reach its synchronization boundary"
            );
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn fixture_command(role: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", FIXTURE, "--ignored", "--nocapture"])
            .env("VARIN_OWNER_FIXTURE_ROLE", role)
            .creation_flags(windows_sys::Win32::System::Threading::DETACHED_PROCESS)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    fn wait_root(owner: &Owner) {
        assert_eq!(
            unsafe { WaitForSingleObject(owner.root.as_raw_handle(), 30_000) },
            WAIT_OBJECT_0
        );
        assert!(root_exit(&owner.root).unwrap().unwrap().success);
    }

    fn wait_drained(owner: &mut Owner) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !owner.drained().unwrap() {
            assert!(
                Instant::now() < deadline,
                "Original Job objects did not signal"
            );
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    #[test]
    #[ignore = "private native Windows Job fixture"]
    fn job_process_fixture() {
        let root = std::path::PathBuf::from(std::env::var_os("VARIN_OWNER_FIXTURE_ROOT").unwrap());
        match std::env::var("VARIN_OWNER_FIXTURE_ROLE").unwrap().as_str() {
            "command-line" => {
                // GetCommandLineW observes the exact OS command line rather than
                // reconstructing it from CRT-parsed argv. Test-only native API.
                #[link(name = "kernel32")]
                unsafe extern "system" {
                    fn GetCommandLineW() -> *const u16;
                }
                let raw = unsafe { GetCommandLineW() };
                assert!(!raw.is_null());
                let mut length = 0;
                while unsafe { *raw.add(length) } != 0 {
                    length += 1;
                }
                let command_line =
                    String::from_utf16(unsafe { std::slice::from_raw_parts(raw, length) }).unwrap();
                let observed = json!({"commandLine": command_line, "args": std::env::args().collect::<Vec<_>>()});
                std::fs::write(
                    root.join("command-line.json"),
                    serde_json::to_vec(&observed).unwrap(),
                )
                .unwrap();
            }
            "root" | "race-root" => {
                let role = if std::env::var("VARIN_OWNER_FIXTURE_ROLE").unwrap() == "root" {
                    "leaf"
                } else {
                    "race-leaf"
                };
                let child = fixture_command(role).spawn().unwrap();
                std::fs::write(root.join("leaf-pid"), child.id().to_string()).unwrap();
                wait_file(&root.join("leaf-ready"));
            }
            "leaf" => {
                std::fs::write(root.join("leaf-ready"), b"ready").unwrap();
                wait_file(&root.join("release"));
            }
            "race-leaf" => {
                std::fs::write(root.join("leaf-ready"), b"ready").unwrap();
                wait_file(&root.join("spawn"));
                let child = fixture_command("late").spawn().unwrap();
                std::fs::write(root.join("late-pid"), child.id().to_string()).unwrap();
                wait_file(&root.join("late-ready"));
            }
            "late" => {
                std::fs::write(root.join("late-ready"), b"ready").unwrap();
                wait_file(&root.join("release"));
            }
            "nested" => {
                let launch = fixture_launch(&root, "breakaway");
                let (mut owner, thread) = fixture_owner(&launch);
                assert_eq!(unsafe { ResumeThread(thread.as_raw_handle()) }, 1);
                wait_root(&owner);
                wait_drained(&mut owner);
            }
            "breakaway" => {
                let result = fixture_command("escaped")
                    .creation_flags(
                        windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB
                            | windows_sys::Win32::System::Threading::DETACHED_PROCESS,
                    )
                    .spawn();
                assert!(
                    result.is_err(),
                    "The original Job must reject explicit breakaway"
                );
                std::fs::write(root.join("breakaway-denied"), b"denied").unwrap();
            }
            "escaped" => panic!("The fixture escaped the original Job"),
            _ => panic!("Unknown native Job fixture"),
        }
        // Dropping a std Child does not wait or terminate it. The independent
        // Job owner must still observe any descendant after this root exits.
        std::process::exit(0);
    }

    #[test]
    fn job_admission_precedes_application_execution_and_cleans_suspended_root() {
        let directory = tempfile::tempdir().unwrap();
        let (mut owner, _thread) = fixture_owner(&fixture_launch(directory.path(), "root"));
        let mut belongs = 0;
        assert_ne!(
            unsafe {
                IsProcessInJob(
                    owner.root.as_raw_handle(),
                    owner.job.as_raw_handle(),
                    &mut belongs,
                )
            },
            0
        );
        assert_ne!(belongs, 0);
        assert!(!signaled(&owner.root).unwrap());
        assert!(
            root_start_identity(&owner.root)
                .unwrap()
                .starts_with("win32:")
        );
        assert!(!directory.path().join("leaf-ready").exists());
        assert_ne!(
            unsafe { TerminateJobObject(owner.job.as_raw_handle(), 1) },
            0
        );
        wait_drained(&mut owner);
        assert!(!root_exit(&owner.root).unwrap().unwrap().success);
        assert!(!directory.path().join("leaf-ready").exists());
    }

    #[test]
    fn root_exit_does_not_settle_live_descendant_and_external_handles_do_not_prevent_proof() {
        let directory = tempfile::tempdir().unwrap();
        let (mut owner, thread) = fixture_owner(&fixture_launch(directory.path(), "root"));
        let retained_root = owner.root.try_clone().unwrap();
        let start_identity = root_start_identity(&retained_root).unwrap();
        assert_eq!(unsafe { ResumeThread(thread.as_raw_handle()) }, 1);
        wait_root(&owner);
        assert!(
            !owner.drained().unwrap(),
            "A root exit is not Job completion"
        );
        let pid: u32 = std::fs::read_to_string(directory.path().join("leaf-pid"))
            .unwrap()
            .parse()
            .unwrap();
        let retained_leaf = owner.members.get(&pid).unwrap().try_clone().unwrap();
        assert!(!signaled(&retained_leaf).unwrap());
        std::fs::write(directory.path().join("release"), b"release").unwrap();
        wait_drained(&mut owner);
        assert!(signaled(&retained_root).unwrap());
        assert!(signaled(&retained_leaf).unwrap());
        assert_eq!(root_start_identity(&retained_root).unwrap(), start_identity);
        assert!(!owner.forced);
    }

    #[test]
    fn second_membership_snapshot_retains_late_descendant() {
        let directory = tempfile::tempdir().unwrap();
        let (mut owner, thread) = fixture_owner(&fixture_launch(directory.path(), "race-root"));
        assert_eq!(unsafe { ResumeThread(thread.as_raw_handle()) }, 1);
        wait_root(&owner);
        let pid: u32 = std::fs::read_to_string(directory.path().join("leaf-pid"))
            .unwrap()
            .parse()
            .unwrap();
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        assert!(!raw.is_null());
        let ancestor = unsafe { OwnedHandle::from_raw_handle(raw) };
        let drained = owner
            .drained_after_snapshot(|ids| {
                assert!(ids.contains(&pid));
                std::fs::write(directory.path().join("spawn"), b"spawn").unwrap();
                assert_eq!(
                    unsafe { WaitForSingleObject(ancestor.as_raw_handle(), 30_000) },
                    WAIT_OBJECT_0
                );
                let late: u32 = std::fs::read_to_string(directory.path().join("late-pid"))
                    .unwrap()
                    .parse()
                    .unwrap();
                assert!(!ids.contains(&late));
            })
            .unwrap();
        assert!(
            !drained,
            "A signaled ancestor cannot certify a child born after the first snapshot"
        );
        assert!(!owner.drained().unwrap());
        std::fs::write(directory.path().join("release"), b"release").unwrap();
        wait_drained(&mut owner);
    }

    #[test]
    fn nested_original_jobs_do_not_grant_breakaway() {
        let directory = tempfile::tempdir().unwrap();
        let (mut owner, thread) = fixture_owner(&fixture_launch(directory.path(), "nested"));
        assert_eq!(unsafe { ResumeThread(thread.as_raw_handle()) }, 1);
        wait_root(&owner);
        wait_drained(&mut owner);
        assert!(directory.path().join("breakaway-denied").exists());
    }

    #[test]
    fn native_command_line_preserves_default_quotes_and_opt_in_nsis_tail() {
        let directory = tempfile::tempdir().unwrap();
        let binary_directory = directory.path().join("application path with spaces");
        std::fs::create_dir(&binary_directory).unwrap();
        let executable = binary_directory.join("owner fixture.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        let destination = r"C:\Users\runner\Temp\Installed Varin";
        for verbatim in [false, true] {
            let mut launch = fixture_launch(directory.path(), "command-line");
            launch.executable = executable.to_str().unwrap().into();
            launch.windows_verbatim_arguments = verbatim;
            launch.args.extend([
                "--".into(),
                "/S".into(),
                "/currentuser".into(),
                format!("/D={destination}"),
            ]);
            let (mut owner, thread) = fixture_owner(&launch);
            assert_eq!(unsafe { ResumeThread(thread.as_raw_handle()) }, 1);
            wait_root(&owner);
            wait_drained(&mut owner);
            let observed: serde_json::Value = serde_json::from_slice(
                &std::fs::read(directory.path().join("command-line.json")).unwrap(),
            )
            .unwrap();
            let command_line = observed["commandLine"].as_str().unwrap();
            assert!(command_line.starts_with(&format!("\"{}\" ", executable.display())));
            let tail = format!("/D={destination}");
            if verbatim {
                assert!(command_line.ends_with(&format!(" /S /currentuser {tail}")));
                assert!(!command_line.ends_with('"'));
                // NSIS consumes this entire unquoted tail instead of CRT argv.
                assert_eq!(command_line.rsplit_once(" /D=").unwrap().1, destination);
                assert_ne!(
                    observed["args"].as_array().unwrap().last().unwrap(),
                    &json!(tail)
                );
            } else {
                assert!(command_line.ends_with(&format!(" \"/S\" \"/currentuser\" \"{tail}\"")));
                assert_eq!(
                    observed["args"].as_array().unwrap().last().unwrap(),
                    &json!(tail)
                );
            }
        }
    }

    #[test]
    fn control_reader_is_bounded_and_does_not_consume_the_next_frame() {
        let mut input = &b"{\"type\":\"settle\",\"nonce\":\"a\"}\n{\"type\":\"stop\",\"nonce\":\"b\",\"forceAfterMs\":0}\n"[..];
        assert!(matches!(read_control(&mut input), Ok(Control::Settle { nonce }) if nonce == "a"));
        assert!(
            matches!(read_control(&mut input), Ok(Control::Stop { nonce, force_after_ms: 0 }) if nonce == "b")
        );
        assert!(read_control(&mut input).is_err());
        let oversized = vec![b' '; MAX_CONTROL_FRAME + 1];
        assert!(read_control(&mut &oversized[..]).is_err());
        assert!(
            read_control(&mut &b"{\"type\":\"settle\",\"nonce\":\"a\",\"unknown\":true}\n"[..])
                .is_err()
        );
    }

    #[test]
    fn windows_environment_is_explicit_and_rejects_ambiguous_names() {
        assert_eq!(environment_block(&BTreeMap::new()).unwrap(), vec![0, 0]);
        let values = BTreeMap::from([("z".into(), "尾".into()), ("A".into(), "1".into())]);
        assert_eq!(
            String::from_utf16(&environment_block(&values).unwrap()).unwrap(),
            "A=1\0z=尾\0\0"
        );
        let conflicting =
            BTreeMap::from([("PATH".into(), "a".into()), ("Path".into(), "b".into())]);
        assert!(environment_block(&conflicting).is_err());
        assert!(environment_block(&BTreeMap::from([("A".into(), "a\0b".into())])).is_err());
    }

    #[test]
    fn crt_arguments_preserve_quotes_empty_strings_and_trailing_slashes() {
        for (argument, expected) in [
            ("", "\"\""),
            ("a b", "\"a b\""),
            ("a\"b", "\"a\\\"b\""),
            ("x\\", "\"x\\\\\""),
        ] {
            let mut output = Vec::new();
            quote_argument(argument, &mut output).unwrap();
            assert_eq!(String::from_utf16(&output).unwrap(), expected);
        }
        assert!(quote_argument("a\0b", &mut Vec::new()).is_err());
    }
}
