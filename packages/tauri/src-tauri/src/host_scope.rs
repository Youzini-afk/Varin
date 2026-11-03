//! OS scope for this shell's managed Node services, not user-opened applications.
//! Scope termination is an OS fact only. It never turns an unknown effect into a
//! successful business drain. Kernel native executors retain their own guardian.
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::process::{Child, Command};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeExit {
    pub clean: bool,
    pub code: Option<i32>,
    pub success: bool,
}
pub struct ProcessScope {
    #[cfg(unix)]
    guardian: crate::host_guardian::Guardian,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
    #[cfg(windows)]
    original_process: std::os::windows::io::OwnedHandle,
    #[cfg(windows)]
    original_pid: u32,
    #[cfg(windows)]
    lease: crate::desktop_lock::ScopeLease,
    terminating: AtomicBool,
    ended: AtomicBool,
}
impl ProcessScope {
    #[allow(unused_mut)]
    pub fn spawn(command: Command, data_dir: &std::path::Path) -> Result<(Child, Self), String> {
        Self::spawn_with_stderr(command, data_dir, std::process::Stdio::inherit())
    }
    #[allow(unused_mut)]
    pub fn spawn_with_stderr(
        mut command: Command,
        data_dir: &std::path::Path,
        stderr: std::process::Stdio,
    ) -> Result<(Child, Self), String> {
        #[cfg(unix)]
        {
            let (child, guardian) = crate::host_guardian::spawn(command, data_dir, stderr)?;
            Ok((
                child,
                Self {
                    guardian,
                    terminating: AtomicBool::new(false),
                    ended: AtomicBool::new(false),
                },
            ))
        }
        #[cfg(windows)]
        {
            let lease = crate::desktop_lock::ScopeLease::prepare(data_dir)?;
            command
                .env("VARIN_DESKTOP_SCOPE_TOKEN", lease.token())
                .stderr(stderr);
            // No Node instruction may run before it belongs to the kill-on-close Job.
            command.creation_flags(0x08000000 | 0x00000004);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(_) => {
                    lease.mark_ended()?;
                    return Err("Bundled desktop service could not start".into());
                }
            };
            match windows::attach(&child, lease.clone()) {
                Ok(scope) => Ok((child, scope)),
                Err(error) => {
                    let _ = child.start_kill();
                    tokio::spawn(async move {
                        // Admission failed before the initial thread resumed.
                        // Only a successful wait releases that pending scope.
                        if child.wait().await.is_ok() {
                            let _ = lease.mark_ended();
                        }
                    });
                    Err(error)
                }
            }
        }
    }
    /// Called only after the controlled owner's complete drain protocol. This
    /// is not a replacement for OS exit observation or an abnormal cleanup.
    pub fn confirm_owner_drained(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        self.guardian.confirm_drained()?;
        Ok(())
    }
    pub fn terminate(&self) -> Result<(), String> {
        if self.ended.load(Ordering::Acquire) || self.terminating.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let result = self.terminate_original_scope();
        // A failed OS request is not accepted termination intent. A later owner
        // observation may retry the same scope, but never substitute success.
        if result.is_err() {
            self.terminating.store(false, Ordering::Release);
        }
        result
    }
    fn terminate_original_scope(&self) -> Result<(), String> {
        #[cfg(unix)]
        self.guardian.terminate()?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    self.job.as_raw_handle(),
                    1,
                )
            } == 0
            {
                return Err("Managed process Job termination was not accepted".into());
            }
        }
        Ok(())
    }
    pub fn empty(&self) -> Result<bool, String> {
        if self.ended.load(Ordering::Acquire) {
            return Ok(true);
        }
        #[cfg(unix)]
        {
            Ok(self.ended.load(Ordering::Acquire))
        }
        #[cfg(windows)]
        {
            windows::empty(self)
        }
    }
    /// The Unix guardian reports the original Node result only after it has
    /// observed every original group member stopped and reaped Node. Windows
    /// keeps its kernel Job object until the same stop boundary is established.
    pub async fn settle_after_node_exit(
        &self,
        status: &std::io::Result<std::process::ExitStatus>,
    ) -> Result<ScopeExit, String> {
        #[cfg(unix)]
        {
            if !status.as_ref().is_ok_and(|status| status.success()) {
                return Err(
                    "Managed service guardian exited without confirming its original scope".into(),
                );
            }
            let result = self.guardian.finished()?;
            self.ended.store(true, Ordering::Release);
            Ok(result)
        }
        #[cfg(windows)]
        {
            let clean = !self.terminating.load(Ordering::Acquire) && self.empty()?;
            #[cfg(test)]
            if !clean {
                eprintln!(
                    "Managed Job settlement requires cleanup: termination_requested={}, node_status={status:?}",
                    self.terminating.load(Ordering::Acquire),
                );
            }
            if !clean {
                self.terminate()?;
            }
            self.wait_empty().await?;
            self.lease.mark_ended()?;
            let status = status
                .as_ref()
                .map_err(|_| "Desktop service termination could not be observed")?;
            Ok(ScopeExit {
                clean,
                code: status.code(),
                success: status.success(),
            })
        }
    }
    #[cfg(windows)]
    pub async fn wait_empty(&self) -> Result<(), String> {
        while !self.empty()? {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        self.ended.store(true, Ordering::Release);
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        mem::size_of,
        os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, INVALID_HANDLE_VALUE,
            WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
                JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject,
            },
            Threading::{
                OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                ResumeThread, THREAD_SUSPEND_RESUME, WaitForSingleObject,
            },
        },
    };
    pub fn attach(
        child: &Child,
        lease: crate::desktop_lock::ScopeLease,
    ) -> Result<ProcessScope, String> {
        let process = child
            .raw_handle()
            .ok_or("Managed service process handle is unavailable")?;
        let pid = child.id().ok_or("Managed service PID is unavailable")?;
        // Retain the actual admitted process object through scope settlement.
        // Closing Tokio's last handle and reopening its PID races kernel object
        // deletion and Job bookkeeping, even after a successful wait().
        let original_process = unsafe { BorrowedHandle::borrow_raw(process) }
            .try_clone_to_owned()
            .map_err(|_| "Original managed process handle could not be retained")?;
        unsafe {
            let handle = CreateJobObjectW(null(), null());
            if handle.is_null() {
                return Err("Managed process Job could not be created".into());
            }
            let job = OwnedHandle::from_raw_handle(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
                || AssignProcessToJobObject(handle, process) == 0
            {
                return Err("Managed service could not enter its process Job".into());
            }
            // Publish the exact active ancestry before any child instruction.
            // An inherited lease consumer authenticates this chain on Windows
            // just as it authenticates a Unix guardian's durable scope record.
            lease.mark_active(std::process::id(), pid)?;
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Err("Managed service initial thread could not be inspected".into());
            }
            let snapshot = OwnedHandle::from_raw_handle(snapshot);
            let mut entry = THREADENTRY32::default();
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut found = Thread32First(snapshot.as_raw_handle(), &mut entry) != 0;
            let mut resumed = false;
            while found {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        resumed = ResumeThread(thread) != u32::MAX;
                        CloseHandle(thread);
                    }
                    break;
                }
                found = Thread32Next(snapshot.as_raw_handle(), &mut entry) != 0;
            }
            if !resumed {
                return Err("Managed service initial thread could not be resumed".into());
            }
            Ok(ProcessScope {
                job,
                original_process,
                original_pid: pid,
                lease,
                terminating: AtomicBool::new(false),
                ended: AtomicBool::new(false),
            })
        }
    }
    pub fn empty(scope: &ProcessScope) -> Result<bool, String> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let result = unsafe {
            QueryInformationJobObject(
                scope.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        };
        if result == 0 {
            return Err("Managed process Job termination could not be observed".into());
        }
        if accounting.ActiveProcesses == 0 {
            return Ok(true);
        }
        // ActiveProcesses includes terminated objects retained by any external
        // handle. Inspect a complete Job list and the original kernel objects,
        // never infer termination from elapsed time or a bare reusable PID.
        let mut capacity = accounting.ActiveProcesses as usize;
        'snapshot: loop {
            let header = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
            let word = size_of::<usize>();
            let bytes = capacity
                .checked_mul(word)
                .and_then(|size| size.checked_add(header))
                .and_then(|size| u32::try_from(size).ok())
                .ok_or("Managed Job process list is too large")?;
            let mut buffer = vec![0usize; (bytes as usize).div_ceil(word)];
            let ok = unsafe {
                QueryInformationJobObject(
                    scope.job.as_raw_handle(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    bytes,
                    null_mut(),
                )
            };
            if ok == 0
                && std::io::Error::last_os_error().raw_os_error() != Some(ERROR_MORE_DATA as i32)
            {
                return Err("Managed Job members cannot be inspected".into());
            }
            let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
            let count = list.NumberOfProcessIdsInList as usize;
            if ok == 0 || count < list.NumberOfAssignedProcesses as usize {
                capacity = capacity
                    .checked_mul(2)
                    .map(|value| value.max(list.NumberOfAssignedProcesses as usize))
                    .ok_or("Managed Job process list overflow")?;
                continue;
            }
            if count > capacity {
                return Err("Managed Job member list is invalid".into());
            }
            let ids = unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), count) };
            let mut handles = Vec::with_capacity(count);
            for &id in ids {
                let pid = u32::try_from(id)
                    .ok()
                    .filter(|pid| *pid != 0)
                    .ok_or("Managed Job member identity is invalid")?;
                if pid == scope.original_pid {
                    match unsafe { WaitForSingleObject(scope.original_process.as_raw_handle(), 0) }
                    {
                        WAIT_OBJECT_0 => continue,
                        WAIT_TIMEOUT => {
                            #[cfg(test)]
                            trace_unsignaled(scope.original_process.as_raw_handle(), true);
                            return Ok(false);
                        }
                        _ => return Err("Original managed process termination is unknown".into()),
                    }
                }
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        0,
                        pid,
                    )
                };
                if handle.is_null() {
                    if std::io::Error::last_os_error().raw_os_error()
                        == Some(ERROR_INVALID_PARAMETER as i32)
                    {
                        // It exited while taking the snapshot; ask for a fresh
                        // full membership set rather than assume this PID died.
                        continue 'snapshot;
                    }
                    return Err(format!(
                        "Managed Job process object cannot be opened (OS error {:?})",
                        std::io::Error::last_os_error().raw_os_error()
                    ));
                }
                let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
                let mut belongs = 0;
                if unsafe {
                    IsProcessInJob(
                        handle.as_raw_handle(),
                        scope.job.as_raw_handle(),
                        &mut belongs,
                    )
                } == 0
                {
                    return Err("Managed Job process membership is unknown".into());
                }
                if belongs == 0 {
                    continue 'snapshot;
                }
                match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
                    WAIT_OBJECT_0 => handles.push(handle),
                    WAIT_TIMEOUT => {
                        #[cfg(test)]
                        trace_unsignaled(handle.as_raw_handle(), false);
                        return Ok(false);
                    }
                    _ => return Err("Managed Job process termination is unknown".into()),
                }
            }
            // All members of this complete snapshot are signaled, so none can
            // spawn after observation. Preserve their handles through this fact.
            drop(handles);
            return Ok(true);
        }
    }

    #[cfg(test)]
    fn trace_unsignaled(handle: std::os::windows::io::RawHandle, original: bool) {
        let mut code = 0;
        let readable = unsafe {
            windows_sys::Win32::System::Threading::GetExitCodeProcess(handle, &mut code)
        } != 0;
        // Process role and OS exit status only. Never print command lines,
        // environment, application data or inherited pipe contents.
        eprintln!(
            "Managed Job member is not signaled: original={original}, exit_code={:?}",
            readable.then_some(code),
        );
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{os::windows::io::AsHandle, process::Stdio, time::Duration};
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[tokio::test]
    async fn clean_job_settlement_uses_original_object_after_tokio_child_is_dropped() {
        let data = tempfile::tempdir().unwrap();
        let _lease = crate::desktop_lock::Lease::acquire(data.path()).unwrap();
        for _ in 0..24 {
            let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
            let mut command = Command::new(node);
            command.args(["-e", "process.exit(0)"]);
            let (mut child, scope) = ProcessScope::spawn(command, data.path()).unwrap();
            let retained = scope
                .original_process
                .as_handle()
                .try_clone_to_owned()
                .unwrap();
            let status = child.wait().await;
            drop(child);
            let ended = tokio::time::timeout(
                Duration::from_secs(10),
                scope.settle_after_node_exit(&status),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(ended.clean && ended.success, "Original Job receipt: {ended:?}");
            assert!(scope.empty().unwrap());
            drop(retained);
        }
    }
    #[tokio::test]
    async fn exited_original_process_does_not_certify_a_live_job_descendant() {
        let data = tempfile::tempdir().unwrap();
        let _lease = crate::desktop_lock::Lease::acquire(data.path()).unwrap();
        let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
        let mut command = Command::new(node);
        command.args(["-e", "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(c.pid+'\\n');c.unref();"])
            .stdout(Stdio::piped());
        let (mut child, scope) = ProcessScope::spawn(command, data.path()).unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .await
            .unwrap();
        assert!(line.trim().parse::<u32>().unwrap() > 0);
        let status = child.wait().await;
        drop(child);
        assert!(
            !scope.empty().unwrap(),
            "root exit cannot release the Job's descendant"
        );
        let ended = tokio::time::timeout(
            Duration::from_secs(10),
            scope.settle_after_node_exit(&status),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!ended.clean);
        assert!(scope.empty().unwrap());
    }
}
