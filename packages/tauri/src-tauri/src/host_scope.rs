//! OS scope for this shell's managed Node services, not user-opened applications.
//! Scope termination is an OS fact only. It never turns an unknown effect into a
//! successful business drain. Kernel native executors retain their own guardian.
#[cfg(windows)]
use crate::host_windows_guardian::ManagedChild as Child;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use tokio::process::Child;
use tokio::process::Command;

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
    guardian: crate::host_windows_guardian::Guardian,
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
            let (child, guardian, job, original_process, original_pid) =
                crate::host_windows_guardian::spawn(command, data_dir, stderr)?;
            Ok((
                child,
                Self {
                    guardian,
                    job,
                    original_process,
                    original_pid,
                    terminating: AtomicBool::new(false),
                    ended: AtomicBool::new(false),
                },
            ))
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
            status
                .as_ref()
                .map_err(|_| "Original desktop service exit is unknown")?;
            let mut result = self.guardian.finished().await?;
            result.clean &= !self.terminating.load(Ordering::Acquire);
            // The independent guardian wrote the durable receipt only after it
            // observed the original Job and process objects, not its own exit.
            if !self.empty()? {
                return Err(
                    "Managed guardian receipt does not match original scope termination".into(),
                );
            }
            self.ended.store(true, Ordering::Release);
            Ok(result)
        }
    }
}

#[cfg(windows)]
pub(crate) mod windows {
    use super::*;
    use std::{
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr::null_mut,
    };
    use windows_sys::Win32::{
        Foundation::{ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::{
            JobObjects::{
                IsProcessInJob, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectBasicAccountingInformation,
                JobObjectBasicProcessIdList, QueryInformationJobObject,
            },
            Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                WaitForSingleObject,
            },
        },
    };
    pub fn empty(scope: &ProcessScope) -> Result<bool, String> {
        empty_after_snapshot(scope, |_| {})
    }

    // The hook lets the native regression deterministically create a descendant
    // after the first kernel snapshot, without changing production observation.
    pub(super) fn empty_after_snapshot(
        scope: &ProcessScope,
        after_snapshot: impl FnOnce(&[u32]),
    ) -> Result<bool, String> {
        empty_original_after_snapshot(
            &scope.job,
            &scope.original_process,
            scope.original_pid,
            after_snapshot,
        )
    }

    pub(crate) fn empty_original(
        job: &OwnedHandle,
        original_process: &OwnedHandle,
        original_pid: u32,
    ) -> Result<bool, String> {
        empty_original_after_snapshot(job, original_process, original_pid, |_| {})
    }

    fn empty_original_after_snapshot(
        job: &OwnedHandle,
        original_process: &OwnedHandle,
        original_pid: u32,
        after_snapshot: impl FnOnce(&[u32]),
    ) -> Result<bool, String> {
        let mut after_snapshot = Some(after_snapshot);
        // Job membership/accounting can advance during process rundown. The
        // original admitted object must be signaled even if a query already
        // reports zero members; neither PID disappearance nor an exit code is
        // a substitute for this retained kernel-object receipt.
        match unsafe { WaitForSingleObject(original_process.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => {
                #[cfg(test)]
                trace_process_state(
                    original_process.as_raw_handle(),
                    true,
                    WAIT_TIMEOUT,
                    Some(true),
                );
                return Ok(false);
            }
            _ => return Err("Original managed process termination is unknown".into()),
        }
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let result = unsafe {
            QueryInformationJobObject(
                job.as_raw_handle(),
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
        'snapshot: loop {
            let ids = members(job, accounting.ActiveProcesses as usize)?;
            if let Some(after_snapshot) = after_snapshot.take() {
                after_snapshot(&ids);
            }
            let mut handles = std::collections::HashMap::with_capacity(ids.len());
            for pid in ids {
                if pid == original_pid {
                    continue;
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
                    IsProcessInJob(handle.as_raw_handle(), job.as_raw_handle(), &mut belongs)
                } == 0
                {
                    return Err("Managed Job process membership is unknown".into());
                }
                if belongs == 0 {
                    continue 'snapshot;
                }
                match unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } {
                    WAIT_OBJECT_0 => {
                        handles.insert(pid, handle);
                    }
                    WAIT_TIMEOUT => {
                        #[cfg(test)]
                        trace_process_state(
                            handle.as_raw_handle(),
                            false,
                            WAIT_TIMEOUT,
                            Some(true),
                        );
                        return Ok(false);
                    }
                    _ => return Err("Managed Job process termination is unknown".into()),
                }
            }
            // A member could spawn a child after the snapshot and then exit
            // before our signal check. Re-read the complete Job membership while
            // every proven process object is still pinned. Only a set contained
            // in these signaled objects is stable: none can now create a child.
            // A new member is still live/unknown work, never a stopped receipt.
            let current = members(job, handles.len().saturating_add(1))?;
            let stopped = current
                .iter()
                .all(|pid| *pid == original_pid || handles.contains_key(pid));
            drop(handles);
            return Ok(stopped);
        }
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
                .ok_or("Managed Job process list is too large")?;
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
            return ids
                .iter()
                .map(|id| {
                    u32::try_from(*id)
                        .ok()
                        .filter(|pid| *pid != 0)
                        .ok_or_else(|| "Managed Job member identity is invalid".into())
                })
                .collect();
        }
    }

    #[cfg(test)]
    pub(super) fn trace_snapshot(scope: &ProcessScope, ids: &[u32]) {
        eprintln!(
            "Managed Job first snapshot: original_pid={}, members={ids:?}",
            scope.original_pid
        );
        // Inspect every original entry before any strict fixture assertion. A
        // missing object is diagnostic uncertainty, never evidence of stopping.
        for &pid in ids {
            let opened;
            let process = if pid == scope.original_pid {
                scope.original_process.as_raw_handle()
            } else {
                let handle = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        0,
                        pid,
                    )
                };
                if handle.is_null() {
                    eprintln!(
                        "Managed Job snapshot process cannot be opened: pid={pid}, os_error={:?}",
                        std::io::Error::last_os_error().raw_os_error()
                    );
                    continue;
                }
                opened = unsafe { OwnedHandle::from_raw_handle(handle) };
                opened.as_raw_handle()
            };
            let first_wait = unsafe { WaitForSingleObject(process, 0) };
            let mut belongs = 0;
            let queried =
                unsafe { IsProcessInJob(process, scope.job.as_raw_handle(), &mut belongs) } != 0;
            trace_process_state(
                process,
                pid == scope.original_pid,
                first_wait,
                queried.then_some(belongs != 0),
            );
        }
    }

    #[cfg(test)]
    fn trace_process_state(
        handle: std::os::windows::io::RawHandle,
        original: bool,
        first_wait: u32,
        belongs: Option<bool>,
    ) {
        use windows_sys::Win32::{
            Foundation::FILETIME,
            System::Threading::{
                GetExitCodeProcess, GetProcessId, GetProcessTimes, QueryFullProcessImageNameW,
            },
        };
        let mut code = 0;
        let readable = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
        let pid = unsafe { GetProcessId(handle) };
        let mut image = [0u16; 32768];
        let mut length = image.len() as u32;
        let image =
            if unsafe { QueryFullProcessImageNameW(handle, 0, image.as_mut_ptr(), &mut length) }
                != 0
            {
                let path = String::from_utf16_lossy(&image[..length as usize]);
                path.rsplit(['\\', '/']).next().map(str::to_owned)
            } else {
                None
            };
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let times =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
                != 0;
        let ticks =
            |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
        // Kernel identity and executable basename only. Never print full paths,
        // command lines, environment, application data or inherited pipe contents.
        let last_wait = unsafe { WaitForSingleObject(handle, 0) };
        eprintln!(
            "Managed Job process observation: original={original}, pid={pid}, job_member={belongs:?}, image={image:?}, first_wait={first_wait}, last_wait={last_wait}, creation_time={:?}, exit_time={:?}, exit_code={:?}",
            times.then_some(ticks(created)),
            times.then_some(ticks(exited)),
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
            assert!(
                ended.clean && ended.success,
                "Original Job receipt: {ended:?}"
            );
            assert!(scope.empty().unwrap());
            drop(retained);
        }
    }
    #[tokio::test]
    async fn exited_original_process_does_not_certify_a_live_job_descendant() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::{JobObjects::IsProcessInJob, Threading::WaitForSingleObject},
        };
        let data = tempfile::tempdir().unwrap();
        let _lease = crate::desktop_lock::Lease::acquire(data.path()).unwrap();
        let node = std::env::var_os("VARIN_TEST_NODE_PATH").unwrap_or_else(|| "node".into());
        let mut command = Command::new(node);
        // libuv places non-detached children in its own kill-on-parent-close
        // Job. unref alone cannot establish a surviving descendant. Detach
        // from that inner lifetime, never from Varin's non-breakaway outer Job,
        // and wait for the child's real ready message before ending its parent.
        command.args(["-e", r#"const c=require('node:child_process').spawn(process.execPath,['-e',"process.send('ready');process.disconnect();setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{process.stdin.once('end',()=>process.exit(0));process.stdin.resume();process.stdout.write(c.pid+'\n');c.unref();});"#])
            .stdout(Stdio::piped());
        let (mut child, scope) = ProcessScope::spawn(command, data.path()).unwrap();
        let mut line = String::new();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        tokio::time::timeout(Duration::from_secs(10), output.read_line(&mut line))
            .await
            .expect("The original descendant must report actual readiness")
            .unwrap();
        let descendant = race_process(line.trim().parse::<u32>().unwrap());
        let mut belongs = 0;
        assert_ne!(
            unsafe {
                IsProcessInJob(
                    descendant.as_raw_handle(),
                    scope.job.as_raw_handle(),
                    &mut belongs,
                )
            },
            0
        );
        assert_ne!(belongs, 0, "The live descendant must belong to Varin's Job");
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .expect("The original root must exit after its input closes");
        drop(child);
        assert!(status.as_ref().unwrap().success());
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) },
            WAIT_TIMEOUT,
            "The fixture must survive its original parent's actual exit"
        );
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
        assert_eq!(
            unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
        assert!(scope.empty().unwrap());
    }

    fn race_command(role: &str) -> std::process::Command {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "host_scope::tests::snapshot_race_process",
                "--ignored",
                "--nocapture",
            ])
            .env("VARIN_SCOPE_RACE_ROLE", role)
            // No console object, rather than merely hiding its window. Never
            // CREATE_BREAKAWAY_FROM_JOB: every actor stays in the original Job.
            .creation_flags(windows_sys::Win32::System::Threading::DETACHED_PROCESS)
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        command
    }

    fn race_event(prefix: &str, suffix: &str, create: bool) -> std::os::windows::io::OwnedHandle {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{
            CreateEventW, EVENT_MODIFY_STATE, OpenEventW, SYNCHRONIZATION_SYNCHRONIZE,
        };
        let name: Vec<u16> = format!("Local\\Varin.Scope.{prefix}.{suffix}\0")
            .encode_utf16()
            .collect();
        let handle = unsafe {
            if create {
                CreateEventW(std::ptr::null(), 1, 0, name.as_ptr())
            } else {
                OpenEventW(
                    EVENT_MODIFY_STATE | SYNCHRONIZATION_SYNCHRONIZE,
                    0,
                    name.as_ptr(),
                )
            }
        };
        assert!(
            !handle.is_null(),
            "Native race event: {}",
            std::io::Error::last_os_error()
        );
        unsafe { OwnedHandle::from_raw_handle(handle) }
    }

    fn race_process(pid: u32) -> std::os::windows::io::OwnedHandle {
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
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
        assert!(
            !handle.is_null(),
            "Native race process: {}",
            std::io::Error::last_os_error()
        );
        unsafe { OwnedHandle::from_raw_handle(handle) }
    }

    #[test]
    #[ignore = "private Windows process fixture for exact Job snapshot interleaving"]
    fn snapshot_race_process() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0,
            System::Threading::{INFINITE, SetEvent, WaitForSingleObject},
        };
        let root = std::path::PathBuf::from(std::env::var_os("VARIN_SCOPE_RACE_ROOT").unwrap());
        let prefix = std::env::var("VARIN_SCOPE_RACE_EVENTS").unwrap();
        match std::env::var("VARIN_SCOPE_RACE_ROLE").unwrap().as_str() {
            "root" => {
                let child = race_command("ancestor").spawn().unwrap();
                std::fs::write(root.join("ancestor-pid"), child.id().to_string()).unwrap();
            }
            "ancestor" => {
                let ready = race_event(&prefix, "ancestor-ready", false);
                let spawn = race_event(&prefix, "spawn", false);
                assert_ne!(unsafe { SetEvent(ready.as_raw_handle()) }, 0);
                assert_eq!(
                    unsafe { WaitForSingleObject(spawn.as_raw_handle(), INFINITE) },
                    WAIT_OBJECT_0
                );
                let child = race_command("late").spawn().unwrap();
                std::fs::write(root.join("late-pid"), child.id().to_string()).unwrap();
                let ready = race_event(&prefix, "late-ready", false);
                assert_eq!(
                    unsafe { WaitForSingleObject(ready.as_raw_handle(), 10_000) },
                    WAIT_OBJECT_0
                );
            }
            "late" => {
                let ready = race_event(&prefix, "late-ready", false);
                let stop = race_event(&prefix, "stop", false);
                assert_ne!(unsafe { SetEvent(ready.as_raw_handle()) }, 0);
                assert_eq!(
                    unsafe { WaitForSingleObject(stop.as_raw_handle(), INFINITE) },
                    WAIT_OBJECT_0
                );
            }
            role => panic!("Unknown race fixture role: {role}"),
        }
        // The scope owns descendants. Do not wait for them in this fixture.
        std::process::exit(0);
    }

    #[tokio::test]
    async fn descendant_spawned_after_snapshot_is_not_certified_stopped() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{SetEvent, WaitForSingleObject},
        };
        let data = tempfile::tempdir().unwrap();
        let _lease = crate::desktop_lock::Lease::acquire(data.path()).unwrap();
        let prefix = uuid::Uuid::new_v4().to_string();
        let ready = race_event(&prefix, "ancestor-ready", true);
        let spawn = race_event(&prefix, "spawn", true);
        let _late_ready = race_event(&prefix, "late-ready", true);
        let _stop = race_event(&prefix, "stop", true);
        let mut command = race_command("root");
        command
            .env("VARIN_SCOPE_RACE_ROOT", data.path())
            .env("VARIN_SCOPE_RACE_EVENTS", &prefix)
            .env("VARIN_TEST_WINDOWS_GUARDIAN_DETACHED_SERVICE", "1");
        let (mut child, scope) = ProcessScope::spawn(command.into(), data.path()).unwrap();
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap();
        assert!(status.as_ref().unwrap().success());
        assert_eq!(
            unsafe { WaitForSingleObject(ready.as_raw_handle(), 10_000) },
            WAIT_OBJECT_0
        );
        let ancestor_pid: u32 = std::fs::read_to_string(data.path().join("ancestor-pid"))
            .unwrap()
            .parse()
            .unwrap();
        // Pin A before it exits. The original single-snapshot algorithm would
        // successfully reopen this signaled object and incorrectly return true.
        let ancestor = race_process(ancestor_pid);
        let mut late = None;
        let empty = windows::empty_after_snapshot(&scope, |ids| {
            windows::trace_snapshot(&scope, ids);
            assert!(
                ids.contains(&ancestor_pid),
                "First snapshot must include live A"
            );
            assert!(
                ids.iter()
                    .all(|pid| *pid == scope.original_pid || *pid == ancestor_pid),
                "The race fixture requires only the pinned root and A in its first snapshot"
            );
            assert_eq!(
                unsafe { WaitForSingleObject(ancestor.as_raw_handle(), 0) },
                WAIT_TIMEOUT
            );
            assert_ne!(unsafe { SetEvent(spawn.as_raw_handle()) }, 0);
            assert_eq!(
                unsafe { WaitForSingleObject(ancestor.as_raw_handle(), 10_000) },
                WAIT_OBJECT_0
            );
            let late_pid: u32 = std::fs::read_to_string(data.path().join("late-pid"))
                .unwrap()
                .parse()
                .unwrap();
            assert!(
                !ids.contains(&late_pid),
                "B must be born after the first snapshot"
            );
            let handle = race_process(late_pid);
            assert_eq!(
                unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
                WAIT_TIMEOUT
            );
            late = Some(handle);
        })
        .unwrap();
        assert!(
            !empty,
            "A's signaled object cannot certify its later child B"
        );
        assert_eq!(
            unsafe { WaitForSingleObject(late.as_ref().unwrap().as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
        let ended = tokio::time::timeout(
            Duration::from_secs(10),
            scope.settle_after_node_exit(&status),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!ended.clean, "Live B requires real Job termination");
        assert_eq!(
            unsafe { WaitForSingleObject(late.as_ref().unwrap().as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
        assert!(scope.empty().unwrap());
    }
}
