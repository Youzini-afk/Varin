//! Opt-in OS qualification, separate from the always-running Storage semantics
//! tests. Requires a user-enabled WinFsp/FUSE component; never installs one.
use super::*;
use crate::storage::{
    workspace_session::{Command, StoragePort},
    Storage,
};
use serde_json::json;
use std::sync::atomic::AtomicBool;
use uuid::Uuid;

#[test]
#[ignore = "child process invoked by native_workspace_mounts_share_storage_and_keep_fork_independent"]
fn native_process_client() {
    let root = std::env::var_os("VARIN_WORKSPACE_MOUNT_PROBE")
        .expect("native mount probe path is required");
    let root = std::path::PathBuf::from(root);
    if std::env::var_os("VARIN_WORKSPACE_MOUNT_READ_ONLY_PROBE").is_some() {
        assert_eq!(
            std::fs::read(root.join("written.txt")).unwrap(),
            b"written in ordinary process"
        );
        return;
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(root.join("writing.tmp"))
        .unwrap();
    file.write_all(b"written in ordinary process").unwrap();
    file.sync_all().unwrap();
    // The descriptor is still open across the namespace replacement.
    std::fs::rename(root.join("writing.tmp"), root.join("written.txt")).unwrap();
    file.sync_all().unwrap();
    drop(file);
    std::fs::create_dir(root.join("empty-directory")).unwrap();
    std::fs::remove_dir(root.join("empty-directory")).unwrap();
    assert_eq!(
        std::fs::read(root.join("written.txt")).unwrap(),
        b"written in ordinary process"
    );
}

#[test]
#[ignore = "requires an already-enabled native filesystem component; never installs drivers"]
fn native_workspace_mounts_share_storage_and_keep_fork_independent() {
    let directory = std::env::temp_dir().join(format!("varin-native-workspace-{}", Uuid::new_v4()));
    let storage_root = directory.join("storage");
    let parent_path = directory.join("parent");
    let child_path = directory.join("child");
    std::fs::create_dir_all(&parent_path).unwrap();
    std::fs::create_dir(&child_path).unwrap();
    let mut storage = Storage::open(&storage_root, "host").unwrap();
    storage.issue_grant(&json!({"grantId":"mount-owner","hostGeneration":"gen","owningWorkspace":"project","executionWorkspace":"project",
        "threadId":"thread","runId":"run","capabilities":["storage.admin"],"pathScopes":[""]}),"host","gen",&storage_root.to_string_lossy(),"epoch").unwrap();
    let input = json!({"operationId":"create","builderId":"create","branchId":"parent","workspaceId":"project","draftBasePaths":[],"captureScopes":[]});
    let (grant, input) = storage
        .authorize(
            Some("mount-owner"),
            "epoch",
            "host",
            "gen",
            "branch.create.begin",
            &input,
        )
        .unwrap();
    storage
        .dispatch("branch.create.begin", &input, Some("mount-owner"), &grant)
        .unwrap();
    let finish = json!({"operationId":"create","builderId":"create"});
    let (grant, finish) = storage
        .authorize(
            Some("mount-owner"),
            "epoch",
            "host",
            "gen",
            "branch.create.finish",
            &finish,
        )
        .unwrap();
    storage
        .dispatch("branch.create.finish", &finish, Some("mount-owner"), &grant)
        .unwrap();
    let (sender, receiver) = std::sync::mpsc::channel::<Option<Command>>();
    let stopping = sender.clone();
    let owner = std::thread::spawn(move || {
        while let Ok(Some(command)) = receiver.recv() {
            command(Some(&mut storage));
        }
        storage
    });
    let port = StoragePort::new(move |command| {
        sender
            .send(Some(command))
            .map_err(|_| KernelError::Storage("qualification Storage stopped".into()))
    });
    let parent = Session::open(port.clone(), "parent".into(), grant.clone()).unwrap();
    let mut mount = Mount::start(parent.clone(), &parent_path).unwrap();
    mount.wait_ready().unwrap();
    let client = std::env::current_exe().unwrap();
    let result = std::process::Command::new(&client)
        .args([
            "--exact",
            "workspace_mount::review::native_process_client",
            "--ignored",
            "--nocapture",
        ])
        .env("VARIN_WORKSPACE_MOUNT_PROBE", &parent_path)
        .current_dir(&parent_path)
        .status()
        .unwrap();
    assert!(result.success());
    // All application handles have been fsynced/closed by the child. This tests
    // the delivered-write boundary, not a dirty mmap/kernel-cache fence.
    let boundary = parent.checkpoint().unwrap();
    boundary
        .fork("child", "native-fork", &AtomicBool::new(false))
        .unwrap();
    boundary.release().unwrap();
    let child = Session::open(port.clone(), "child".into(), grant).unwrap();
    let mut child_mount = Mount::start(child.clone(), &child_path).unwrap();
    child_mount.wait_ready().unwrap();
    let result = std::process::Command::new(client)
        .args([
            "--exact",
            "workspace_mount::review::native_process_client",
            "--ignored",
            "--nocapture",
        ])
        .env("VARIN_WORKSPACE_MOUNT_PROBE", &child_path)
        .env("VARIN_WORKSPACE_MOUNT_READ_ONLY_PROBE", "1")
        .current_dir(&child_path)
        .status()
        .unwrap();
    assert!(result.success());
    std::fs::write(parent_path.join("written.txt"), b"parent after fork").unwrap();
    assert_eq!(
        std::fs::read(child_path.join("written.txt")).unwrap(),
        b"written in ordinary process"
    );
    child_mount.stop().unwrap();
    mount.stop().unwrap();
    drop((child_mount, mount, child, parent, port));
    stopping.send(None).unwrap();
    drop(owner.join().unwrap());
    // Both explicit native mounts are detached before touching their empty
    // target directories. Never delete through a live workspace mount.
    std::fs::remove_dir_all(&directory).unwrap();
}
