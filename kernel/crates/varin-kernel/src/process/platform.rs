//! OS containment. A guardian waits on its private input until admission to its
//! job succeeds; no user command can escape the spawn/AssignProcess race.
use std::{io, process::Child};

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
            JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };
    const JOB_OBJECT_QUERY: u32 = 0x0004;
    const JOB_OBJECT_TERMINATE: u32 = 0x0008;
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    pub struct Containment {
        handle: OwnedHandle,
    }
    impl Containment {
        pub fn admit(name: &str, child: &Child) -> io::Result<Self> {
            let name = wide(name);
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), name.as_ptr()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self {
                handle: unsafe { OwnedHandle::from_raw_handle(handle as _) },
            };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    job.raw(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            if unsafe { AssignProcessToJobObject(job.raw(), child.as_raw_handle() as _) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
        fn raw(&self) -> HANDLE {
            self.handle.as_raw_handle() as _
        }
        pub fn terminate(&self, _child: &Child, _force: bool) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.raw(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        pub fn empty(&self) -> io::Result<bool> {
            active(self.raw()).map(|n| n == 0)
        }
    }
    pub struct WorkerJob {
        handle: OwnedHandle,
    }
    impl WorkerJob {
        pub fn open(name: &str) -> io::Result<Self> {
            let name = wide(name);
            let handle = unsafe {
                OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, 0, name.as_ptr())
            };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self {
                handle: unsafe { OwnedHandle::from_raw_handle(handle as _) },
            })
        }
        pub fn abort(&self) {
            // Closing the Host/kernel pipe invalidates this entire managed tree.
            unsafe {
                TerminateJobObject(self.handle.as_raw_handle() as _, 1);
            }
        }
        pub fn drain_descendants(&self) -> io::Result<bool> {
            use windows_sys::Win32::System::Threading::{
                OpenProcess, TerminateProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            };
            let raw = self.handle.as_raw_handle() as _;
            let count = active(raw)? as usize;
            if count <= 1 {
                return Ok(true);
            }
            let mut buffer = vec![0usize; count + 64];
            let ok = unsafe {
                QueryInformationJobObject(
                    raw,
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr() as _,
                    (buffer.len() * std::mem::size_of::<usize>()) as u32,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
            let pids = unsafe {
                std::slice::from_raw_parts(
                    list.ProcessIdList.as_ptr(),
                    list.NumberOfProcessIdsInList as usize,
                )
            };
            for pid in pids
                .iter()
                .copied()
                .filter(|pid| *pid != std::process::id() as usize)
            {
                let process = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                        0,
                        pid as u32,
                    )
                };
                if process.is_null() {
                    continue;
                } // The job count below, not this open, establishes exit.
                let process = unsafe { OwnedHandle::from_raw_handle(process as _) };
                let mut belongs = 0;
                if unsafe { IsProcessInJob(process.as_raw_handle() as _, raw, &mut belongs) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                if belongs != 0 && unsafe { TerminateProcess(process.as_raw_handle() as _, 1) } == 0
                {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(5) {
                        return Err(error);
                    }
                    // A granted terminate handle can race teardown before its
                    // process object is signaled. Wait/recount; never treat the
                    // access-denied result itself as proof of a completed exit.
                    let _ = unsafe { WaitForSingleObject(process.as_raw_handle() as _, 10) };
                }
            }
            active(raw).map(|n| n <= 1)
        }
    }
    fn active(handle: HANDLE) -> io::Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(info.ActiveProcesses)
    }
    pub fn prior_tree_gone(name: &str) -> io::Result<bool> {
        let name = wide(name);
        let handle = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr()) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
                return Ok(true);
            }
            return Err(error);
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle as _) };
        active(handle.as_raw_handle() as _).map(|n| n == 0)
    }
}
#[cfg(windows)]
pub use windows::{prior_tree_gone, Containment, WorkerJob};

#[cfg(unix)]
pub struct Containment;
#[cfg(unix)]
impl Containment {
    pub fn admit(_name: &str, _child: &Child) -> io::Result<Self> {
        Ok(Self)
    }
    pub fn terminate(&self, child: &Child, force: bool) -> io::Result<()> {
        // Signal only the still-owned guardian, not a PID recovered from disk.
        let signal = if force { libc::SIGUSR2 } else { libc::SIGUSR1 };
        if unsafe { libc::kill(child.id() as i32, signal) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
    pub fn empty(&self) -> io::Result<bool> {
        Ok(true)
    }
}
#[cfg(unix)]
pub fn prior_tree_gone(_name: &str) -> io::Result<bool> {
    // Unix has no named kill-on-close Job. Only the guardian's durable receipt
    // proves an old session has drained. A vanished PID alone proves nothing.
    Ok(false)
}

#[cfg(unix)]
pub fn session_members(session: u32) -> io::Result<Vec<i32>> {
    #[cfg(target_os = "linux")]
    {
        let mut rows = Vec::new();
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            let stat = match std::fs::read_to_string(entry.path().join("stat")) {
                Ok(stat) => stat,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let end = stat
                .rfind(')')
                .ok_or_else(|| io::Error::other("invalid process stat"))?;
            let fields: Vec<_> = stat[end + 1..].split_whitespace().collect();
            let parent = fields.get(1).and_then(|v| v.parse::<i32>().ok());
            let sid = fields.get(3).and_then(|v| v.parse::<u32>().ok());
            rows.push((pid, parent, sid, fields.first() == Some(&"Z")));
        }
        // Linux reparents orphaned descendants to this guardian (subreaper),
        // including double-fork/setsid daemons that left the original session.
        let guardian = std::process::id() as i32;
        let mut family = std::collections::BTreeSet::from([guardian]);
        loop {
            let before = family.len();
            for (pid, parent, _, _) in &rows {
                if parent.is_some_and(|p| family.contains(&p)) {
                    family.insert(*pid);
                }
            }
            if family.len() == before {
                break;
            }
        }
        let members = rows
            .into_iter()
            .filter_map(|(pid, _, sid, zombie)| {
                (!zombie && pid != guardian && (sid == Some(session) || family.contains(&pid)))
                    .then_some(pid)
            })
            .collect();
        Ok(members)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let output = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,stat="])
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other("process-session inspection failed"));
        }
        let mut members = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let fields: Vec<_> = line.split_whitespace().collect();
            if let Some(pid) = fields.first().and_then(|v| v.parse::<i32>().ok()) {
                if unsafe { libc::getsid(pid) } == session as i32
                    && !fields.get(1).is_some_and(|v| v.starts_with('Z'))
                {
                    members.push(pid);
                }
            }
        }
        Ok(members)
    }
}
#[cfg(unix)]
pub fn terminate_session(session: u32, force: bool) -> io::Result<bool> {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let mut applied = false;
    for pid in session_members(session)? {
        if unsafe { libc::kill(pid, signal) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        } else {
            applied = true;
        }
    }
    Ok(applied)
}

#[cfg(target_os = "linux")]
pub fn arm_parent_death_signal() -> io::Result<()> {
    // The control pipe is the normal lifetime boundary. PR_SET_PDEATHSIG is
    // the Linux backstop for an abrupt kernel exit (including process::exit,
    // which cannot run ProcessManager::drop). Arm it before accepting the
    // spawn configuration, then close the prctl race by checking the parent.
    let parent = unsafe { libc::getppid() };
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGUSR2) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::getppid() } != parent {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "owning kernel exited while arming guardian lifetime",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn prepare_guardian() -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
