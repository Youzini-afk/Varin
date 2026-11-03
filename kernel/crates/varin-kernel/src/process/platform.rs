//! OS containment. A guardian waits on its private input until admission to its
//! job succeeds; no user command can escape the spawn/AssignProcess race.
use std::{io, process::Child};

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{
            CompareObjectHandles, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA,
            HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
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
    /// Exact process objects present before any user command may execute.
    pub struct PtyInfrastructure {
        processes: Vec<OwnedHandle>,
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
        pub fn abort(&self) -> io::Result<()> {
            // A lost owner or failed native setup invalidates this entire tree.
            if unsafe { TerminateJobObject(self.handle.as_raw_handle() as _, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        /// Must run after openpty and before spawn_command. No image-name or
        /// PID exemption can identify the original console host after user code runs.
        pub fn capture_pty_infrastructure(&self) -> io::Result<PtyInfrastructure> {
            use windows_sys::Win32::System::Threading::{
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            };
            let processes = self
                .members(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?
                .ok_or_else(|| {
                    io::Error::other("Job membership changed during PTY infrastructure capture")
                })?;
            if !processes.iter().any(|process| is_guardian(process)) {
                return Err(io::Error::other(
                    "original Job does not contain its guardian",
                ));
            }
            Ok(PtyInfrastructure { processes })
        }
        pub fn drain_pty_clients(&self, infrastructure: &PtyInfrastructure) -> io::Result<bool> {
            self.drain_except(&infrastructure.processes)
        }
        pub fn drain_descendants(&self) -> io::Result<bool> {
            self.drain_except(&[])
        }
        fn drain_except(&self, protected: &[OwnedHandle]) -> io::Result<bool> {
            use windows_sys::Win32::System::Threading::{
                GetProcessId, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            };
            let preserve = |process: &OwnedHandle| {
                is_guardian(process)
                    || protected.iter().any(|original| unsafe {
                        CompareObjectHandles(
                            process.as_raw_handle() as _,
                            original.as_raw_handle() as _,
                        ) != 0
                    })
            };
            let Some(members) =
                self.members(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?
            else {
                return Ok(false);
            };
            for process in &members {
                if preserve(process) || signaled(process)? {
                    continue;
                }
                // Original infrastructure only needs query/wait rights. Obtain
                // terminate access only after classifying a later process object.
                let pid = unsafe { GetProcessId(process.as_raw_handle() as _) };
                if pid == 0 {
                    return Err(io::Error::last_os_error());
                }
                let terminate = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                        0,
                        pid,
                    )
                };
                if terminate.is_null() {
                    let error = io::Error::last_os_error();
                    if signaled(process)? {
                        continue;
                    }
                    return Err(error);
                }
                let terminate = unsafe { OwnedHandle::from_raw_handle(terminate as _) };
                if unsafe {
                    CompareObjectHandles(
                        process.as_raw_handle() as _,
                        terminate.as_raw_handle() as _,
                    )
                } == 0
                {
                    return Ok(false);
                }
                let mut belongs = 0;
                if unsafe {
                    IsProcessInJob(
                        terminate.as_raw_handle() as _,
                        self.handle.as_raw_handle() as _,
                        &mut belongs,
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if belongs == 0 {
                    return Ok(false);
                }
                if unsafe { TerminateProcess(terminate.as_raw_handle() as _, 1) } == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(ERROR_ACCESS_DENIED as i32) {
                        return Err(error);
                    }
                    // Termination can race an exiting process. Neither acceptance
                    // nor access denied proves it exited; inspect the actual object.
                }
            }
            for process in &members {
                if !preserve(process) && !signaled(process)? {
                    return Ok(false);
                }
            }
            // Children can spawn during an earlier pass, and protected objects can
            // exit. Only a fresh complete list proves quiescence, never count minus
            // the number of originally captured infrastructure processes.
            Ok(self
                .members(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)?
                .is_some_and(|members| members.iter().all(preserve)))
        }
        // None means membership changed during inspection, not an empty Job.
        fn members(&self, access: u32) -> io::Result<Option<Vec<OwnedHandle>>> {
            use windows_sys::Win32::System::Threading::OpenProcess;
            let raw = self.handle.as_raw_handle() as _;
            let mut members = Vec::new();
            for pid in self.member_ids()? {
                let process = unsafe { OpenProcess(access, 0, pid) };
                if process.is_null() {
                    let error = io::Error::last_os_error();
                    // A vanished PID is not an open failure we may silently call
                    // empty. Requery this same Job to prove that it has left.
                    if !self.member_ids()?.contains(&pid) {
                        return Ok(None);
                    }
                    return Err(error);
                }
                let process = unsafe { OwnedHandle::from_raw_handle(process as _) };
                let mut belongs = 0;
                if unsafe { IsProcessInJob(process.as_raw_handle() as _, raw, &mut belongs) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                if belongs == 0 {
                    return Ok(None);
                }
                members.push(process);
            }
            Ok(Some(members))
        }
        fn member_ids(&self) -> io::Result<Vec<u32>> {
            let raw = self.handle.as_raw_handle() as _;
            let header = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
            let word = std::mem::size_of::<usize>();
            let mut capacity = (active(raw)? as usize).max(1);
            loop {
                let bytes = capacity
                    .checked_mul(word)
                    .and_then(|n| n.checked_add(header))
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| {
                        io::Error::other("Job process list exceeds Win32 buffer size")
                    })?;
                let mut buffer = Vec::<usize>::new();
                let words = (bytes as usize).div_ceil(word);
                buffer.try_reserve_exact(words).map_err(io::Error::other)?;
                buffer.resize(words, 0);
                let ok = unsafe {
                    QueryInformationJobObject(
                        raw,
                        JobObjectBasicProcessIdList,
                        buffer.as_mut_ptr() as _,
                        bytes,
                        std::ptr::null_mut(),
                    )
                };
                let failure = (ok == 0).then(io::Error::last_os_error);
                if let Some(error) = failure.as_ref() {
                    if error.raw_os_error() != Some(ERROR_MORE_DATA as i32) {
                        return Err(failure.expect("query failed"));
                    }
                }
                let list = unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
                let assigned = list.NumberOfAssignedProcesses as usize;
                let listed = list.NumberOfProcessIdsInList as usize;
                if ok == 0 || listed < assigned {
                    capacity = capacity
                        .checked_mul(2)
                        .map(|n| n.max(assigned))
                        .ok_or_else(|| io::Error::other("Job process list size overflow"))?;
                    continue;
                }
                if listed > capacity {
                    return Err(io::Error::other("Job process list exceeds its buffer"));
                }
                let pids =
                    unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), listed) };
                return pids
                    .iter()
                    .map(|&pid| {
                        u32::try_from(pid)
                            .ok()
                            .filter(|pid| *pid != 0)
                            .ok_or_else(|| io::Error::other("invalid Job process identity"))
                    })
                    .collect();
            }
        }
    }
    fn is_guardian(process: &OwnedHandle) -> bool {
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        unsafe { CompareObjectHandles(process.as_raw_handle() as _, GetCurrentProcess()) != 0 }
    }
    fn signaled(process: &OwnedHandle) -> io::Result<bool> {
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        match unsafe { WaitForSingleObject(process.as_raw_handle() as _, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            WAIT_FAILED => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("unexpected process wait result")),
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
pub use windows::{prior_tree_gone, Containment, PtyInfrastructure, WorkerJob};

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
pub fn prepare_guardian() -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
