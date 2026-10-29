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
    let f = ExecutorFixture::new();
    let service = super::native_service::Service::new(f.session.clone()).unwrap();
    let call = |q: serde_json::Value, body: &[u8]| service.dispatch(&q, body).unwrap();
    let item=call(json!({"op":"create","parent":1,"name":"source.bin","kind":"file","attributes":{"mode":384}}),&[]).0;
    let id = item["id"].as_u64().unwrap();
    call(json!({"op":"open","id":id}), &[]);
    call(json!({"op":"open","id":id}), &[]); // aggregate mode upgrade
    call(json!({"op":"close","id":id,"keepOpen":true}), &[]);
    let bytes = [0, 255, 1, 2, 128, 0];
    call(json!({"op":"write","id":id,"offset":3}), &bytes);
    assert_eq!(
        call(json!({"op":"read","id":id,"offset":0,"length":9}), &[]).1,
        [0, 0, 0, 0, 255, 1, 2, 128, 0]
    );
    call(
        json!({"op":"link","id":id,"parent":1,"name":"alias.bin"}),
        &[],
    );
    let linked = call(json!({"op":"lookup","parent":1,"name":"alias.bin"}), &[]).0;
    assert_eq!(linked["id"], id);
    assert_eq!(linked["links"], 2);
    call(
        json!({"op":"setxattr","id":id,"name":"user.test","policy":"create"}),
        &bytes,
    );
    assert_eq!(
        call(json!({"op":"getxattr","id":id,"name":"user.test"}), &[]).1,
        bytes
    );
    assert!(service
        .dispatch(
            &json!({"op":"setxattr","id":id,"name":"user.test","policy":"create"}),
            b"x"
        )
        .is_err());
    call(
        json!({"op":"rename","id":id,"parent":1,"name":"source.bin","toParent":1,"toName":"renamed.bin"}),
        &[],
    );
    call(
        json!({"op":"remove","id":id,"parent":1,"name":"alias.bin"}),
        &[],
    );
    call(
        json!({"op":"remove","id":id,"parent":1,"name":"renamed.bin"}),
        &[],
    );
    call(json!({"op":"reclaim","id":id}), &[]);
    assert_eq!(
        call(json!({"op":"read","id":id,"offset":3,"length":6}), &[]).1,
        bytes
    );
    call(json!({"op":"close","id":id}), &[]);
    assert!(service
        .dispatch(&json!({"op":"getattr","id":id}), &[])
        .is_err());
    assert!(service
        .dispatch(&json!({"op":"lookup","parent":1,"name":"../outside"}), &[])
        .is_err());
    drop(service);
    f.finish();
}

#[test]
fn cache_fence_selects_only_its_original_sync_and_preserves_the_boundary() {
    let f = ExecutorFixture::new();
    let file = f.session.create_file("before.txt", 0o644).unwrap();
    f.session.write(&file, Some(0), b"before").unwrap();
    let fence = super::cache_fence::CacheFence::default();
    let request = fence.request("", 17).unwrap();
    fence.synchronize(&f.session, 99).unwrap();
    f.session.write(&file, Some(0), b"chosen").unwrap();
    fence.synchronize(&f.session, 17).unwrap();
    f.session.write(&file, Some(0), b"later!").unwrap();
    let boundary = request.finish(Ok(())).unwrap();
    boundary
        .fork("child", "fence-fork", &AtomicBool::new(false))
        .unwrap();
    boundary.release().unwrap();
    let child = Session::open(f.port.clone(), "child".into(), f.session.owner()).unwrap();
    let node = child.lookup("before.txt").unwrap();
    let mut data = [0; 6];
    child.read(&node, 0, &mut data).unwrap();
    assert_eq!(&data, b"chosen");
    child.close().unwrap();
    drop((node, child, file));
    let missing = fence.request("", 18).unwrap().finish(Ok(())).err().unwrap();
    assert_eq!(
        super::kind_error(&missing),
        "workspace_cache_fence_unavailable"
    );
    f.finish();
}

struct ExecutorFixture {
    directory: std::path::PathBuf,
    session: Arc<Session>,
    port: StoragePort,
    stop: std::sync::mpsc::Sender<Option<Command>>,
    worker: std::thread::JoinHandle<Storage>,
}

#[test]
fn native_import_uses_the_admitted_inode_and_keeps_its_private_version() {
    let f = ExecutorFixture::new();
    let physical = f.directory.join("physical");
    std::fs::create_dir(&physical).unwrap();
    let source = physical.join("source");
    let old = physical.join("original");
    let bytes = vec![0xa7; 384 * 1024];
    std::fs::write(&source, &bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o444)).unwrap();
    }
    let observation = crate::native_metadata::observe(&source).unwrap();
    let admitted = std::fs::File::open(&source).unwrap();
    std::fs::rename(&source, &old).unwrap();
    std::fs::write(&source, b"replacement at original name").unwrap();
    let mut captured = 0;
    let node = f
        .session
        .import_open_file(
            "imported.bin",
            admitted,
            observation.attributes.clone(),
            &AtomicBool::new(false),
            |count| {
                captured += count;
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(captured, bytes.len() as u64);
    let mut actual = vec![0; bytes.len()];
    f.session.read(&node, 0, &mut actual).unwrap();
    assert_eq!(actual, bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(node.attributes().unwrap().mode, 0o444);
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    std::fs::write(&old, b"changed original inode").unwrap();
    f.session.read(&node, 0, &mut actual).unwrap();
    assert_eq!(actual, bytes);
    drop(node);
    f.finish();
}

#[cfg(target_os = "macos")]
#[test]
fn private_executor_rejects_an_unadmitted_owner_without_disconnecting_its_mount() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    fn exchange(
        stream: &mut UnixStream,
        value: serde_json::Value,
    ) -> std::io::Result<serde_json::Value> {
        let bytes = serde_json::to_vec(&value)?;
        stream.write_all(&(bytes.len() as u32).to_le_bytes())?;
        stream.write_all(&0u32.to_le_bytes())?;
        stream.write_all(&bytes)?;
        let mut header = [0; 8];
        stream.read_exact(&mut header)?;
        let mut reply = vec![0; u32::from_le_bytes(header[..4].try_into().unwrap()) as usize];
        stream.read_exact(&mut reply)?;
        assert_eq!(u32::from_le_bytes(header[4..].try_into().unwrap()), 0);
        Ok(serde_json::from_slice(&reply)?)
    }
    let f = ExecutorFixture::new();
    let target = f.directory.join("target");
    std::fs::create_dir(&target).unwrap();
    f.session.mount_started();
    let mut server = super::native_service::Server::start(f.session.clone(), &target).unwrap();
    let resource = server.resource.clone();
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(resource.join("resource.json")).unwrap()).unwrap();
    let connect = || {
        let stream = UnixStream::connect(manifest["socket"].as_str().unwrap()).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        stream
    };
    let mut owner = connect();
    let hello = json!({"op":"attach","version":1,"role":"control","generation":manifest["generation"],"token":manifest["token"]});
    exchange(&mut owner, hello.clone()).unwrap();
    let mut rejected = connect();
    let mut wrong = hello;
    wrong["token"] = json!("not-the-owner");
    assert!(exchange(&mut rejected, wrong).is_err());
    assert!(server.attached.load(std::sync::atomic::Ordering::Acquire));
    f.session.check_mounted().unwrap();
    let root = exchange(&mut owner, json!({"op":"root"})).unwrap();
    assert_eq!(root["value"]["kind"], "directory");
    server.stopping(true);
    drop((owner, rejected));
    server.stop();
    assert!(!resource.exists());
    drop(server);
    f.finish();
}
impl ExecutorFixture {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("varin-native-executor-{}", Uuid::new_v4()));
        let mut storage = Storage::open(&directory, "host").unwrap();
        storage.issue_grant(&json!({"grantId":"owner","hostGeneration":"gen","owningWorkspace":"project","executionWorkspace":"project",
            "threadId":"thread","runId":"run","capabilities":["storage.admin"],"pathScopes":[""]}),"host","gen",&directory.to_string_lossy(),"epoch").unwrap();
        let begin = json!({"operationId":"create","builderId":"create","branchId":"parent","workspaceId":"project","draftBasePaths":[],"captureScopes":[]});
        let (grant, begin) = storage
            .authorize(
                Some("owner"),
                "epoch",
                "host",
                "gen",
                "branch.create.begin",
                &begin,
            )
            .unwrap();
        storage
            .dispatch("branch.create.begin", &begin, Some("owner"), &grant)
            .unwrap();
        let end = json!({"operationId":"create","builderId":"create"});
        let (grant, end) = storage
            .authorize(
                Some("owner"),
                "epoch",
                "host",
                "gen",
                "branch.create.finish",
                &end,
            )
            .unwrap();
        storage
            .dispatch("branch.create.finish", &end, Some("owner"), &grant)
            .unwrap();
        let (sender, receiver) = std::sync::mpsc::channel::<Option<Command>>();
        let stop = sender.clone();
        let worker = std::thread::spawn(move || {
            while let Ok(Some(command)) = receiver.recv() {
                command(Some(&mut storage));
            }
            storage
        });
        let port = StoragePort::new(move |command| {
            sender
                .send(Some(command))
                .map_err(|_| KernelError::Storage("Test Storage stopped".into()))
        });
        let session = Session::open(port.clone(), "parent".into(), grant).unwrap();
        Self {
            directory,
            session,
            port,
            stop,
            worker,
        }
    }
    fn finish(self) {
        self.session.close().unwrap();
        drop((self.session, self.port));
        self.stop.send(None).unwrap();
        drop(self.worker.join().unwrap());
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
        let mapped = std::env::var_os("VARIN_WORKSPACE_MOUNT_MAPPED_PROBE").is_some();
        let mut expected = b"written in ordinary process".to_vec();
        if mapped {
            expected[..6].copy_from_slice(b"mapped");
        }
        assert_eq!(std::fs::read(root.join("written.txt")).unwrap(), expected);
        if !mapped {
            assert_eq!(
                std::fs::metadata(root.join("written.txt"))
                    .unwrap()
                    .modified()
                    .unwrap(),
                chosen_time()
            );
        }
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
    std::fs::create_dir_all(&directory).unwrap();
    #[cfg(not(windows))]
    {
        std::fs::create_dir(&parent_path).unwrap();
        std::fs::create_dir(&child_path).unwrap();
    }
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
    #[cfg(windows)]
    let parent_path = mount.path().to_path_buf();
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
    #[cfg(unix)]
    let mapping = mount.capabilities()["activeWritableMappingFork"]
        .as_bool()
        .unwrap_or(false)
        .then(|| WritableMapping::open(&parent_path.join("written.txt")));
    #[cfg(unix)]
    if let Some(mapping) = &mapping {
        mapping.write(b"mapped");
    }
    // Use the actual OS fence while both the descriptor and dirty shared mmap
    // are still live. No msync/fsync or release stands in for that boundary.
    let boundary = mount.checkpoint().unwrap();
    #[cfg(unix)]
    if let Some(mapping) = &mapping {
        mapping.write(b"parent");
    }
    boundary
        .fork("child", "native-fork", &AtomicBool::new(false))
        .unwrap();
    boundary.release().unwrap();
    let child = Session::open(port.clone(), "child".into(), grant).unwrap();
    let mut child_mount = Mount::start(child.clone(), &child_path).unwrap();
    child_mount.wait_ready().unwrap();
    #[cfg(windows)]
    let child_path = child_mount.path().to_path_buf();
    let mut command = std::process::Command::new(client);
    command
        .args([
            "--exact",
            "workspace_mount::review::native_process_client",
            "--ignored",
            "--nocapture",
        ])
        .env("VARIN_WORKSPACE_MOUNT_PROBE", &child_path)
        .env("VARIN_WORKSPACE_MOUNT_READ_ONLY_PROBE", "1");
    #[cfg(unix)]
    if mapping.is_some() {
        command.env("VARIN_WORKSPACE_MOUNT_MAPPED_PROBE", "1");
    }
    let result = command.current_dir(&child_path).status().unwrap();
    assert!(result.success());
    #[cfg(unix)]
    let was_mapped = mapping.is_some();
    #[cfg(not(unix))]
    let was_mapped = false;
    #[cfg(unix)]
    drop(mapping);
    std::fs::write(parent_path.join("written.txt"), b"parent after fork").unwrap();
    let mut expected = b"written in ordinary process".to_vec();
    if was_mapped {
        expected[..6].copy_from_slice(b"mapped");
    }
    assert_eq!(
        std::fs::read(child_path.join("written.txt")).unwrap(),
        expected
    );
    // Windows may deliver native Close after the ordinary process has exited.
    // Follow the original close notification just like the product owner.
    let stop = |mount: &mut Mount, session: &Arc<Session>| {
        let (sender, receiver) = std::sync::mpsc::channel();
        session.on_native_idle(Arc::new(move || { let _ = sender.send(()); }));
        loop {
            match mount.stop() {
                Err(KernelError::Execution(error)) if error.code == "workspace_native_handles_active" => {
                    receiver.recv_timeout(std::time::Duration::from_secs(15)).expect("Native close was not delivered");
                }
                result => { result.unwrap(); break; }
            }
        }
    };
    stop(&mut child_mount, &child);
    stop(&mut mount, &parent);
    drop((child_mount, mount, child, parent, port));
    stopping.send(None).unwrap();
    drop(owner.join().unwrap());
    // Both explicit native mounts are detached before touching their empty
    // target directories. Never delete through a live workspace mount.
    std::fs::remove_dir_all(&directory).unwrap();
}

#[cfg(unix)]
struct WritableMapping {
    pointer: *mut libc::c_void,
    length: usize,
    _file: std::fs::File,
}
#[cfg(unix)]
impl WritableMapping {
    fn open(path: &Path) -> Self {
        use std::os::fd::AsRawFd;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        let length = file.metadata().unwrap().len() as usize;
        let pointer = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        assert_ne!(pointer, libc::MAP_FAILED);
        Self {
            pointer,
            length,
            _file: file,
        }
    }
    fn write(&self, bytes: &[u8]) {
        assert!(bytes.len() <= self.length);
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.pointer.cast(), bytes.len());
        }
    }
}
#[cfg(unix)]
impl Drop for WritableMapping {
    fn drop(&mut self) {
        assert_eq!(unsafe { libc::munmap(self.pointer, self.length) }, 0);
    }
}
