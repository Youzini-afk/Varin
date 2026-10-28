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

fn chosen_time() -> std::time::SystemTime {
    std::time::UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 123_456_700)
}

#[test]
fn native_executor_keeps_binary_bytes_links_and_unlinked_open_handles() {
    let f=ExecutorFixture::new();
    let service=super::native_service::Service::new(f.session.clone()).unwrap();
    let call=|q:serde_json::Value,body:&[u8]|service.dispatch(&q,body).unwrap();
    let item=call(json!({"op":"create","parent":1,"name":"source.bin","kind":"file","attributes":{"mode":384}}),&[]).0;
    let id=item["id"].as_u64().unwrap();
    call(json!({"op":"open","id":id}),&[]);
    let bytes=[0,255,1,2,128,0];
    call(json!({"op":"write","id":id,"offset":3}),&bytes);
    assert_eq!(call(json!({"op":"read","id":id,"offset":0,"length":9}),&[]).1,[0,0,0,0,255,1,2,128,0]);
    call(json!({"op":"link","id":id,"parent":1,"name":"alias.bin"}),&[]);
    let linked=call(json!({"op":"lookup","parent":1,"name":"alias.bin"}),&[]).0;
    assert_eq!(linked["id"],id);assert_eq!(linked["links"],2);
    call(json!({"op":"setxattr","id":id,"name":"user.test","policy":"create"}),&bytes);
    assert_eq!(call(json!({"op":"getxattr","id":id,"name":"user.test"}),&[]).1,bytes);
    assert!(service.dispatch(&json!({"op":"setxattr","id":id,"name":"user.test","policy":"create"}),b"x").is_err());
    call(json!({"op":"rename","id":id,"parent":1,"name":"source.bin","toParent":1,"toName":"renamed.bin"}),&[]);
    call(json!({"op":"remove","id":id,"parent":1,"name":"alias.bin"}),&[]);
    call(json!({"op":"remove","id":id,"parent":1,"name":"renamed.bin"}),&[]);
    call(json!({"op":"reclaim","id":id}),&[]);
    assert_eq!(call(json!({"op":"read","id":id,"offset":3,"length":6}),&[]).1,bytes);
    call(json!({"op":"close","id":id}),&[]);
    assert!(service.dispatch(&json!({"op":"getattr","id":id}),&[]).is_err());
    assert!(service.dispatch(&json!({"op":"lookup","parent":1,"name":"../outside"}),&[]).is_err());
    drop(service);f.finish();
}

#[test]
fn cache_fence_selects_only_its_original_sync_and_preserves_the_boundary() {
    let f=ExecutorFixture::new();let file=f.session.create_file("before.txt",0o644).unwrap();
    f.session.write(&file,Some(0),b"before").unwrap();
    let fence=super::cache_fence::CacheFence::default();
    let request=fence.request("",17).unwrap();
    fence.synchronize(&f.session,99).unwrap();
    f.session.write(&file,Some(0),b"chosen").unwrap();
    fence.synchronize(&f.session,17).unwrap();
    f.session.write(&file,Some(0),b"later!").unwrap();
    let boundary=request.finish(Ok(())).unwrap();
    boundary.fork("child","fence-fork",&AtomicBool::new(false)).unwrap();boundary.release().unwrap();
    let child=Session::open(f.port.clone(),"child".into(),f.session.owner()).unwrap();
    let node=child.lookup("before.txt").unwrap();let mut data=[0;6];child.read(&node,0,&mut data).unwrap();assert_eq!(&data,b"chosen");
    child.close().unwrap();drop((node,child,file));
    let missing=fence.request("",18).unwrap().finish(Ok(())).err().unwrap();
    assert_eq!(super::kind_error(&missing),"workspace_cache_fence_unavailable");
    f.finish();
}

struct ExecutorFixture {
    directory:std::path::PathBuf,session:Arc<Session>,port:StoragePort,
    stop:std::sync::mpsc::Sender<Option<Command>>,worker:std::thread::JoinHandle<Storage>,
}
impl ExecutorFixture {
    fn new()->Self{
        let directory=std::env::temp_dir().join(format!("varin-native-executor-{}",Uuid::new_v4()));
        let mut storage=Storage::open(&directory,"host").unwrap();
        storage.issue_grant(&json!({"grantId":"owner","hostGeneration":"gen","owningWorkspace":"project","executionWorkspace":"project",
            "threadId":"thread","runId":"run","capabilities":["storage.admin"],"pathScopes":[""]}),"host","gen",&directory.to_string_lossy(),"epoch").unwrap();
        let begin=json!({"operationId":"create","builderId":"create","branchId":"parent","workspaceId":"project","draftBasePaths":[],"captureScopes":[]});
        let (grant,begin)=storage.authorize(Some("owner"),"epoch","host","gen","branch.create.begin",&begin).unwrap();
        storage.dispatch("branch.create.begin",&begin,Some("owner"),&grant).unwrap();
        let end=json!({"operationId":"create","builderId":"create"});
        let (grant,end)=storage.authorize(Some("owner"),"epoch","host","gen","branch.create.finish",&end).unwrap();
        storage.dispatch("branch.create.finish",&end,Some("owner"),&grant).unwrap();
        let (sender,receiver)=std::sync::mpsc::channel::<Option<Command>>();let stop=sender.clone();
        let worker=std::thread::spawn(move||{while let Ok(Some(command))=receiver.recv(){command(Some(&mut storage));}storage});
        let port=StoragePort::new(move|command|sender.send(Some(command)).map_err(|_|KernelError::Storage("Test Storage stopped".into())));
        let session=Session::open(port.clone(),"parent".into(),grant).unwrap();
        Self{directory,session,port,stop,worker}
    }
    fn finish(self){
        self.session.close().unwrap();drop((self.session,self.port));self.stop.send(None).unwrap();drop(self.worker.join().unwrap());
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}

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
        assert_eq!(
            std::fs::metadata(root.join("written.txt"))
                .unwrap()
                .modified()
                .unwrap(),
            chosen_time()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.join("written.txt"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o640
            );
        }
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
    file.set_times(std::fs::FileTimes::new().set_modified(chosen_time()))
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o640))
            .unwrap();
    }
    file.sync_all().unwrap();
    drop(file);
    std::fs::create_dir(root.join("empty-directory")).unwrap();
    std::fs::remove_dir(root.join("empty-directory")).unwrap();
    assert_eq!(
        std::fs::read(root.join("written.txt")).unwrap(),
        b"written in ordinary process"
    );
    assert_eq!(
        std::fs::metadata(root.join("written.txt"))
            .unwrap()
            .modified()
            .unwrap(),
        chosen_time()
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
