//! OS scope for this shell's managed Node services, not user-opened applications.
//! Scope termination is an OS fact only. It never turns an unknown effect into a
//! successful business drain. Kernel native executors retain their own guardian.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::process::{Child, Command};

pub struct ProcessScope {
    #[cfg(unix)]
    group: i32,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
    terminating: AtomicBool,
    ended: AtomicBool,
}
impl ProcessScope {
    pub fn prepare(command: &mut Command) {
        #[cfg(unix)]
        command.process_group(0);
        // Suspend before the first Node instruction so no child can escape the
        // Job between CreateProcess and AssignProcessToJobObject.
        #[cfg(windows)]
        command.creation_flags(0x08000000 | 0x00000004);
    }
    pub fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(unix)]
        {
            Ok(Self {
                group: child.id().ok_or("Managed service PID is unavailable")? as i32,
                terminating: AtomicBool::new(false),
                ended: AtomicBool::new(false),
            })
        }
        #[cfg(windows)]
        {
            windows::attach(child)
        }
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
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            if unsafe { kill(-self.group, 9) } != 0
                && std::io::Error::last_os_error().raw_os_error() != Some(3)
            {
                return Err("Managed process group termination was not accepted".into());
            }
        }
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
        #[cfg(target_os = "linux")]
        {
            // A dead orphan may remain a zombie under a non-reaping container
            // init. Z/X is an actual OS termination fact, not a timeout inference.
            for entry in std::fs::read_dir("/proc")
                .map_err(|_| "Managed process scope cannot be inspected")?
            {
                let entry = entry.map_err(|_| "Managed process scope cannot be inspected")?;
                if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
                    continue;
                }
                let stat = match std::fs::read_to_string(entry.path().join("stat")) {
                    Ok(stat) => stat,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        continue;
                    }
                    Err(_) => return Err("Managed process scope cannot be inspected".into()),
                };
                let (_, rest) = stat
                    .rsplit_once(')')
                    .ok_or("Managed process state is malformed")?;
                let fields: Vec<_> = rest.split_whitespace().collect();
                if fields.get(2).and_then(|field| field.parse::<i32>().ok()) == Some(self.group)
                    && !matches!(fields.first().copied(), Some("Z" | "X"))
                {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            if unsafe { kill(-self.group, 0) } == 0 {
                return Ok(false);
            }
            match std::io::Error::last_os_error().raw_os_error() {
                Some(3) => Ok(true),
                Some(1) => Ok(false),
                _ => Err("Managed process scope cannot be inspected".into()),
            }
        }
        #[cfg(windows)]
        {
            windows::empty(self)
        }
    }
    /// Called after the original Node wait. Leftover owned children are abnormal,
    /// even if Node wrote a stopped receipt. Return whether the scope was clean.
    pub async fn settle_after_node_exit(&self) -> Result<bool, String> {
        let clean = !self.terminating.load(Ordering::Acquire) && self.empty()?;
        if !clean {
            self.terminate()?;
        }
        self.wait_empty().await?;
        Ok(clean)
    }
    pub async fn wait_empty(&self) -> Result<(), String> {
        while !self.empty()? {
            tokio::time::sleep(Duration::from_millis(10)).await;
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
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
                QueryInformationJobObject, SetInformationJobObject,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    pub fn attach(child: &Child) -> Result<ProcessScope, String> {
        let process = child
            .raw_handle()
            .ok_or("Managed service process handle is unavailable")?;
        let pid = child.id().ok_or("Managed service PID is unavailable")?;
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
        Ok(accounting.ActiveProcesses == 0)
    }
}
