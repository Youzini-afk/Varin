//! Real Win32 namespace lifetime, with an original process held at a pipe gate.
//! No timing assumption about how quickly asynchronous TerminateProcess finishes.
use super::*;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JobObjectBasicAccountingInformation, OpenJobObjectW, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        },
        Threading::WaitForSingleObject,
    },
};

#[test]
fn process_recovery_gated_child() {
    let Some(ready) = std::env::var_os("VARIN_TEST_RECOVERY_READY") else {
        return;
    };
    fs::write(ready, b"ready").unwrap();
    std::io::stdin().read_exact(&mut [0u8]).unwrap();
}

struct Fixture {
    child: Child,
    root: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn job(name: &[u16]) -> OwnedHandle {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), name.as_ptr()) };
    assert!(!handle.is_null(), "{}", io::Error::last_os_error());
    unsafe { OwnedHandle::from_raw_handle(handle as _) }
}
fn active(job: &OwnedHandle) -> u32 {
    let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
    assert_ne!(
        unsafe {
            QueryInformationJobObject(
                job.as_raw_handle() as _,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        },
        0,
        "{}",
        io::Error::last_os_error()
    );
    info.ActiveProcesses
}
fn assert_unknown(storage: &mut Storage, id: &str) {
    let record = storage.refresh_process_writer_record(id).unwrap().unwrap();
    assert_eq!(record["status"], "unknown");
    assert_eq!(record["writerActive"], true);
    assert_eq!(record["treeConfirmed"], false);
}

#[test]
fn process_recovery_does_not_confuse_job_name_removal_or_reuse_with_original_exit() {
    let root = std::env::temp_dir().join(format!("varin-job-recovery-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let ready = root.join("ready");
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "storage::process_recovery_tests::process_recovery_gated_child",
            "--nocapture",
        ])
        .env("VARIN_TEST_RECOVERY_READY", &ready)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut fixture = Fixture { child, root };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.is_file() {
        assert!(
            fixture.child.try_wait().unwrap().is_none(),
            "fixture exited before its gate"
        );
        assert!(Instant::now() < deadline, "fixture did not reach its gate");
        std::thread::sleep(Duration::from_millis(10));
    }
    let id = "original-scope";
    let store = fixture.root.join("storage");
    let name = crate::process::job_name(&store, id);
    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let original = job(&wide);
    let process: HANDLE = fixture.child.as_raw_handle() as _;
    assert_ne!(
        unsafe { AssignProcessToJobObject(original.as_raw_handle() as _, process) },
        0,
        "{}",
        io::Error::last_os_error()
    );
    assert_eq!(active(&original), 1);
    // Seed an interrupted admitted scope, then reopen the actual Storage owner.
    // The test's original Job deliberately has no kill-on-close: namespace removal
    // is the same object-manager boundary, without racing asynchronous termination.
    let storage = Storage::open(&store, "host").unwrap();
    let record = json!({"processId":id,"kernelEpoch":"original-epoch","status":"running",
        "writerActive":true,"treeConfirmed":false,"cwd":fixture.root});
    storage.conn.execute(
        "INSERT INTO process_records(process_id,workspace_id,execution_workspace_id,grant_id,kernel_epoch,cwd,job_name,params_hash,status_json) VALUES (?1,'ws','ws','actor','original-epoch',?2,?3,'intent',?4)",
        params![id, fixture.root.to_string_lossy(), name, record.to_string()],
    ).unwrap();
    drop(storage);
    let mut storage = Storage::open(&store, "host").unwrap();
    assert_unknown(&mut storage, id);

    drop(original);
    let reopened = unsafe { OpenJobObjectW(0x0004, 0, wide.as_ptr()) };
    assert!(
        reopened.is_null(),
        "temporary Job name must disappear at its last handle"
    );
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(ERROR_FILE_NOT_FOUND as i32)
    );
    assert_eq!(
        unsafe { WaitForSingleObject(process, 0) },
        WAIT_TIMEOUT,
        "the original process object must still be unsignaled after name removal"
    );
    assert_unknown(&mut storage, id);

    let replacement = job(&wide);
    assert_eq!(active(&replacement), 0);
    assert!(
        crate::process::platform::WorkerJob::open(&name).is_err(),
        "a guardian outside the named Job cannot dispatch or publish its receipt"
    );
    let mut belongs = 1;
    assert_ne!(
        unsafe { IsProcessInJob(process, replacement.as_raw_handle() as _, &mut belongs) },
        0
    );
    assert_eq!(belongs, 0, "the same name now identifies a different Job");
    assert_eq!(unsafe { WaitForSingleObject(process, 0) }, WAIT_TIMEOUT);
    assert_unknown(&mut storage, id);
    // The defective shortcut was also persisted. A future open must not trust
    // that known name-only projection as if it were an original-object receipt.
    let mut name_only = record;
    name_only["status"] = json!("exited");
    name_only["writerActive"] = json!(false);
    name_only["treeConfirmed"] = json!(true);
    name_only["reason"] =
        json!("prior native Job is gone; command is not replayed and exit code is unknown");
    storage
        .conn
        .execute(
            "UPDATE process_records SET status_json=?2 WHERE process_id=?1",
            params![id, name_only.to_string()],
        )
        .unwrap();
    drop(storage);
    let mut storage = Storage::open(&store, "host").unwrap();
    assert_unknown(&mut storage, id);
    assert_eq!(unsafe { WaitForSingleObject(process, 0) }, WAIT_TIMEOUT);
    drop(replacement);

    // Cleanup uses the original Child/handle, not a recovered PID. Even observed
    // fixture exit cannot manufacture a missing product guardian receipt.
    fixture.child.stdin.take().unwrap().write_all(b"x").unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(process, 10_000) },
        WAIT_OBJECT_0
    );
    fixture.child.wait().unwrap();
    assert_unknown(&mut storage, id);
    drop(storage);
}
