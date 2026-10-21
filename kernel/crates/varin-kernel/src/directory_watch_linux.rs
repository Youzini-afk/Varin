//! Linux namespace observation for the original Documents subscription.
//! The watch graph is disposable OS state, not an inventory, content cache or job ledger.
//! An explicit fence crosses each original directory lock, then consumes one finite
//! inotify queue prefix. File bodies remain unproven; this is not an atomic snapshot.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::{CString, OsStr},
    fs::{self, File, OpenOptions, ReadDir},
    io::{self, BufRead, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Open { id: String, path: PathBuf },
    Flush { id: String, request: String },
    Close { id: String },
}
type Output = Arc<Mutex<io::Stdout>>;
fn send(out: &Output, value: Value) -> io::Result<()> {
    let mut writer = out
        .lock()
        .map_err(|_| io::Error::other("directory output unavailable"))?;
    serde_json::to_writer(&mut *writer, &value)?;
    writer.write_all(b"\n")?;
    writer.flush()
}
fn coverage(reason: Option<&str>) -> Value {
    match reason {
        Some(reason) => json!({"namespace":"unknown","content":"unknown","reason":reason}),
        None => json!({"namespace":"complete","content":"unknown"}),
    }
}
struct Failure {
    reason: &'static str,
    error: io::Error,
}
type Result<T> = std::result::Result<T, Failure>;
fn failure(reason: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        reason,
        error: io::Error::other(message.into()),
    }
}
fn io_failure(error: io::Error) -> Failure {
    let reason = if matches!(error.raw_os_error(), Some(libc::EMFILE | libc::ENFILE)) {
        "watch-limit"
    } else {
        "io-error"
    };
    Failure { reason, error }
}
fn watch_failure(error: io::Error) -> Failure {
    let reason = match error.raw_os_error() {
        Some(libc::ENOSPC | libc::EMFILE | libc::ENFILE) => "watch-limit",
        Some(libc::ENOSYS | libc::EOPNOTSUPP) => "fs-unsupported",
        _ => "watch-gap",
    };
    Failure { reason, error }
}
struct Control {
    wake: Mutex<Option<OwnedFd>>,
    stopped: AtomicBool,
    flushes: Mutex<VecDeque<String>>,
}
impl Control {
    fn new() -> io::Result<Self> {
        let fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            wake: Mutex::new(Some(unsafe { OwnedFd::from_raw_fd(fd) })),
            stopped: AtomicBool::new(false),
            flushes: Mutex::new(VecDeque::new()),
        })
    }
    fn signal(&self) {
        let held = self.wake.lock().unwrap();
        let Some(wake) = held.as_ref() else {
            return;
        };
        let value = 1u64.to_ne_bytes();
        // EAGAIN means the counter already contains a wake, not a lost command.
        loop {
            let written =
                unsafe { libc::write(wake.as_raw_fd(), value.as_ptr().cast(), value.len()) };
            if written >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break;
            }
        }
    }
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.signal();
    }
    fn flush(&self, request: String) {
        self.flushes.lock().unwrap().push_back(request);
        self.signal();
    }
    fn check(&self) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            Err(failure("closed", "directory subscription is closed"))
        } else {
            Ok(())
        }
    }
    fn descriptor(&self) -> RawFd {
        self.wake.lock().unwrap().as_ref().unwrap().as_raw_fd()
    }
    fn release(&self) {
        self.stopped.store(true, Ordering::Release);
        self.wake.lock().unwrap().take();
        self.flushes.lock().unwrap().clear();
    }
    fn take_flushes(&self) -> VecDeque<String> {
        let mut value = 0u64;
        unsafe {
            libc::read(self.descriptor(), (&mut value as *mut u64).cast(), 8);
        }
        std::mem::take(&mut *self.flushes.lock().unwrap())
    }
}
fn directory_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    options
}
fn child_directory(parent: RawFd, name: &OsStr) -> io::Result<File> {
    let name =
        CString::new(name.as_bytes()).map_err(|_| io::Error::other("invalid directory name"))?;
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY
                | libc::O_DIRECTORY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn gone(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP)
    )
}
fn mount_id(file: &File) -> Result<u64> {
    let mut stat: libc::statx = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::statx(
            file.as_raw_fd(),
            c"".as_ptr(),
            libc::AT_EMPTY_PATH,
            libc::STATX_MNT_ID,
            &mut stat,
        )
    } != 0
        || stat.stx_mask & libc::STATX_MNT_ID == 0
    {
        return Err(failure(
            "fs-unsupported",
            "directory mount identity is unavailable",
        ));
    }
    Ok(stat.stx_mnt_id)
}
fn supported_filesystem(file: &File) -> Result<()> {
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatfs(file.as_raw_fd(), &mut stat) } != 0 {
        return Err(io_failure(io::Error::last_os_error()));
    }
    // Local VFS filesystems whose name mutations reach fsnotify. Network, FUSE,
    // overlay and pseudo filesystems have no complete-coverage contract here.
    if !matches!(
        stat.f_type as u64,
        0xef53 | 0x58465342 | 0x9123683e | 0x01021994
    ) {
        return Err(failure(
            "fs-unsupported",
            "filesystem namespace observation is unsupported",
        ));
    }
    Ok(())
}
struct Directory {
    relative: String,
    // A stable original inode handle is needed for the namespace lock barrier.
    // A later pathname lookup cannot synchronize with a renamed-away directory.
    barrier: File,
}
struct Scan {
    directory: File,
    entries: ReadDir,
    relative: String,
}
struct Observer {
    path: PathBuf,
    root: File,
    root_identity: (u64, u64),
    mount: u64,
    mounts: File,
    notifications: File,
    directories: HashMap<i32, Directory>,
    retired: HashSet<i32>,
    last_descriptor: i32,
    pending_moves: HashSet<u32>,
}
impl Observer {
    fn open(path: &Path, control: &Control) -> Result<Self> {
        control.check()?;
        let path = fs::canonicalize(path).map_err(io_failure)?;
        let root = directory_options().open(&path).map_err(io_failure)?;
        supported_filesystem(&root)?;
        let mount = mount_id(&root)?;
        // Keep this exact descriptor. Its poll state detects mount/unmount ABA;
        // comparing two textual mount tables alone would miss that interval.
        let mounts = File::open("/proc/self/mounts").map_err(|_| {
            failure(
                "fs-unsupported",
                "mount namespace observation is unavailable",
            )
        })?;
        let metadata = root.metadata().map_err(io_failure)?;
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(watch_failure(io::Error::last_os_error()));
        }
        let mut observer = Self {
            path,
            root_identity: (metadata.dev(), metadata.ino()),
            mount,
            mounts,
            root,
            notifications: unsafe { File::from_raw_fd(fd) },
            directories: HashMap::new(),
            retired: HashSet::new(),
            last_descriptor: 0,
            pending_moves: HashSet::new(),
        };
        observer.install_subtree("", control)?;
        observer.validate()?;
        Ok(observer)
    }
    fn validate(&self) -> Result<()> {
        let mut mount_poll = libc::pollfd {
            fd: self.mounts.as_raw_fd(),
            events: libc::POLLPRI,
            revents: 0,
        };
        if unsafe { libc::poll(&mut mount_poll, 1, 0) } < 0 {
            return Err(io_failure(io::Error::last_os_error()));
        }
        if mount_poll.revents != 0 {
            return Err(failure(
                "mount-changed",
                "mount namespace changed during directory observation",
            ));
        }
        let named = directory_options()
            .open(&self.path)
            .map_err(|_| failure("root-changed", "watched root is unavailable"))?;
        let metadata = named.metadata().map_err(io_failure)?;
        if (metadata.dev(), metadata.ino()) != self.root_identity || mount_id(&named)? != self.mount
        {
            return Err(failure("root-changed", "watched root was replaced"));
        }
        Ok(())
    }
    fn open_relative(&self, relative: &str) -> io::Result<File> {
        let mut directory = self.root.try_clone()?;
        for name in relative.split('/').filter(|name| !name.is_empty()) {
            directory = child_directory(directory.as_raw_fd(), OsStr::new(name))?;
        }
        Ok(directory)
    }
    fn install(&mut self, directory: File, relative: String) -> Result<Scan> {
        supported_filesystem(&directory)?;
        // A separate mount (including a same-device bind mount) can alias a
        // watched inode. Do not silently merge its distinct pathname coverage.
        if mount_id(&directory)? != self.mount {
            return Err(failure(
                "fs-unsupported",
                "nested mounts require a fresh full inventory",
            ));
        }
        let fd_path = format!("/proc/self/fd/{}", directory.as_raw_fd());
        let name = CString::new(fd_path.as_bytes()).unwrap();
        let mask = libc::IN_CREATE
            | libc::IN_DELETE
            | libc::IN_MOVED_FROM
            | libc::IN_MOVED_TO
            | libc::IN_ATTRIB
            | libc::IN_MODIFY
            | libc::IN_CLOSE_WRITE
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF
            | libc::IN_ONLYDIR;
        // Resolve the already opened, no-follow directory descriptor, rather
        // than a concurrently replaceable user pathname.
        let wd =
            unsafe { libc::inotify_add_watch(self.notifications.as_raw_fd(), name.as_ptr(), mask) };
        if wd < 0 {
            return Err(watch_failure(io::Error::last_os_error()));
        }
        if let Some(existing) = self.directories.get(&wd) {
            if existing.relative != relative {
                return Err(failure(
                    "watch-gap",
                    "directory watch has multiple path identities",
                ));
            }
        } else {
            // Never confuse queued events from an old descriptor incarnation.
            // An instance rebuild is safe even at the documented INT_MAX wrap.
            if wd <= self.last_descriptor {
                return Err(failure(
                    "watch-gap",
                    "directory watch descriptor was recycled",
                ));
            }
            self.last_descriptor = wd;
            self.directories.insert(
                wd,
                Directory {
                    relative: relative.clone(),
                    barrier: directory.try_clone().map_err(io_failure)?,
                },
            );
        }
        let entries = fs::read_dir(fd_path).map_err(io_failure)?;
        Ok(Scan {
            directory,
            entries,
            relative,
        })
    }
    fn install_subtree(&mut self, relative: &str, control: &Control) -> Result<()> {
        let directory = match self.open_relative(relative) {
            Ok(directory) => directory,
            Err(error) if gone(&error) && !relative.is_empty() => return Ok(()),
            Err(error) => return Err(io_failure(error)),
        };
        let first = self.install(directory, relative.to_owned())?;
        let mut stack = vec![first];
        while let Some(frame) = stack.last_mut() {
            control.check()?;
            let Some(entry) = frame.entries.next() else {
                stack.pop();
                continue;
            };
            let entry = entry.map_err(io_failure)?;
            let name = entry.file_name();
            let name_text = name.to_str().ok_or_else(|| {
                failure(
                    "watch-gap",
                    "directory observation contains a non-UTF-8 name",
                )
            })?;
            let kind = entry.file_type().map_err(io_failure)?;
            if !kind.is_dir() {
                continue;
            }
            let relative = if frame.relative.is_empty() {
                name_text.to_owned()
            } else {
                format!("{}/{name_text}", frame.relative)
            };
            let child = match child_directory(frame.directory.as_raw_fd(), &name) {
                Ok(child) => child,
                Err(error) if gone(&error) => continue,
                Err(error) => return Err(io_failure(error)),
            };
            // Watch before enumerating: arrivals during installation remain a
            // dirty subtree, including descendants created before their watch.
            let next = self.install(child, relative)?;
            stack.push(next);
        }
        Ok(())
    }
    fn retire_subtree(&mut self, relative: &str) -> Result<()> {
        let prefix = format!("{relative}/");
        let retired = self
            .directories
            .iter()
            .filter_map(|(wd, directory)| {
                (directory.relative == relative || directory.relative.starts_with(&prefix))
                    .then_some(*wd)
            })
            .collect::<Vec<_>>();
        for wd in retired {
            self.directories.remove(&wd);
            self.retired.insert(wd);
            if unsafe { libc::inotify_rm_watch(self.notifications.as_raw_fd(), wd) } != 0 {
                let error = io::Error::last_os_error();
                // Auto-removal already queued IN_IGNORED for a deleted inode.
                if error.raw_os_error() != Some(libc::EINVAL) {
                    return Err(watch_failure(error));
                }
            }
        }
        Ok(())
    }
    fn decode(&mut self, bytes: &[u8], control: &Control) -> Result<Vec<Value>> {
        let mut events = Vec::new();
        let mut offset = 0;
        while offset < bytes.len() {
            control.check()?;
            let header = bytes
                .get(offset..offset + 16)
                .ok_or_else(|| failure("watch-gap", "truncated directory notification"))?;
            let wd = i32::from_ne_bytes(header[..4].try_into().unwrap());
            let mask = u32::from_ne_bytes(header[4..8].try_into().unwrap());
            let cookie = u32::from_ne_bytes(header[8..12].try_into().unwrap());
            let length = u32::from_ne_bytes(header[12..16].try_into().unwrap()) as usize;
            let name = bytes
                .get(offset + 16..offset + 16 + length)
                .ok_or_else(|| failure("watch-gap", "truncated directory name"))?;
            offset += 16 + length;
            if mask & libc::IN_Q_OVERFLOW != 0 {
                return Err(failure(
                    "overflow",
                    "directory notification queue overflowed",
                ));
            }
            if self.retired.contains(&wd) {
                if mask & libc::IN_IGNORED != 0 {
                    self.retired.remove(&wd);
                }
                continue;
            }
            let directory = self.directories.get(&wd).ok_or_else(|| {
                failure("watch-gap", "directory notification has no original watch")
            })?;
            let base = directory.relative.clone();
            if mask & (libc::IN_UNMOUNT | libc::IN_IGNORED) != 0 {
                return Err(failure(
                    "watch-gap",
                    "directory notification watch was lost",
                ));
            }
            if mask & libc::IN_DELETE_SELF != 0 && !base.is_empty() {
                // DELETE_SELF can precede the parent DELETE notification.
                events.push(json!({"kind":"rename","path":base,"scope":"subtree"}));
                self.retire_subtree(&base)?;
                continue;
            }
            if mask & (libc::IN_MOVE_SELF | libc::IN_DELETE_SELF) != 0 {
                // Parent move events normally retire a child before this record.
                // Without those events its pathname can no longer be proven.
                return Err(failure(
                    if base.is_empty() {
                        "root-changed"
                    } else {
                        "watch-gap"
                    },
                    "watched directory moved or was deleted",
                ));
            }
            let name = match name.iter().position(|byte| *byte == 0) {
                Some(end) => std::str::from_utf8(&name[..end])
                    .map_err(|_| failure("watch-gap", "directory name is not UTF-8"))?,
                None if name.is_empty() => "",
                None => return Err(failure("watch-gap", "directory name is unterminated")),
            };
            if name == "." || name == ".." || name.contains('/') {
                return Err(failure("watch-gap", "invalid directory name"));
            }
            let relative = if name.is_empty() {
                base
            } else if base.is_empty() {
                name.to_owned()
            } else {
                format!("{base}/{name}")
            };
            let is_directory = name.is_empty() || mask & libc::IN_ISDIR != 0;
            let namespace = mask
                & (libc::IN_CREATE | libc::IN_DELETE | libc::IN_MOVED_FROM | libc::IN_MOVED_TO)
                != 0;
            let kind = if namespace {
                "rename"
            } else if mask & libc::IN_ATTRIB != 0 {
                "change"
            } else {
                "content"
            };
            events.push(json!({"kind":kind,"path":relative,"scope":if is_directory { "subtree" } else { "exact" }}));
            if namespace && is_directory {
                // Rename halves need not arrive in one read or queue prefix.
                // Do not turn an unmatched FROM into a successful empty tree.
                if mask & libc::IN_MOVED_FROM != 0 {
                    self.pending_moves.insert(cookie);
                }
                if mask & libc::IN_MOVED_TO != 0 {
                    self.pending_moves.remove(&cookie);
                }
                if mask & (libc::IN_DELETE | libc::IN_MOVED_FROM) != 0 {
                    self.retire_subtree(&relative)?;
                }
                if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
                    self.install_subtree(&relative, control)?;
                }
            }
        }
        Ok(events)
    }
    fn namespace_barrier(&self, control: &Control) -> Result<()> {
        // VFS name mutations queue fsnotify while holding their parent i_rwsem.
        // A successful getdents64 goes through iterate_dir's shared i_rwsem.
        // Synchronize every original directory once before sampling the queue:
        // FIONREAD alone can miss a visible mutation stalled before fsnotify.
        // This is O(watched directories), not a recursive inventory. The fixed
        // buffer fits a maximum-sized Linux directory entry and is discarded;
        // no names become another inventory owner. A 32-byte buffer can reject
        // a valid long entry with EINVAL instead of crossing the directory lock.
        // Only success proves the lock was crossed. Even EINVAL can originate
        // from a security hook before the lock, so zero-count/EINVAL is not proof.
        // A stop request does not interrupt a blocked kernel directory lock.
        // Keep the handles alive and acknowledge closed only after actual return.
        // Sources: Linux fs/namei.c (vfs_rename + do_renameat2, vfs_create,
        // vfs_unlink) and fs/readdir.c (getdents64 + iterate_dir).
        let mut buffer = [0u8; std::mem::size_of::<libc::dirent64>()];
        for directory in self.directories.values() {
            control.check()?;
            let fd = directory.barrier.as_raw_fd();
            if unsafe { libc::lseek(fd, 0, libc::SEEK_SET) } < 0 {
                let error = io::Error::last_os_error();
                return Err(failure(
                    "watch-gap",
                    format!(
                        "directory namespace barrier cannot seek its original handle ({}): {error}",
                        directory.relative,
                    ),
                ));
            }
            loop {
                let count = unsafe {
                    libc::syscall(libc::SYS_getdents64, fd, buffer.as_mut_ptr(), buffer.len())
                };
                if count >= 0 {
                    break;
                }
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    control.check()?;
                    continue;
                }
                return Err(failure(
                    "watch-gap",
                    format!(
                        "directory namespace lock barrier did not complete ({}): {error}",
                        directory.relative,
                    ),
                ));
            }
        }
        control.check()
    }
    fn fence(
        &mut self,
        control: &Control,
        output: &Output,
        id: &str,
        establish_boundary: bool,
    ) -> Result<Option<&'static str>> {
        control.check()?;
        self.validate()?;
        if establish_boundary {
            // Reconcile already queued removals before touching original handles
            // that may now be dead. A concurrent later loss still fails closed.
            self.fence(control, output, id, false)?;
            self.namespace_barrier(control)?;
        }
        let mut remaining: libc::c_int = 0;
        // FIONREAD snapshots the ordered queue size under notification_lock.
        // One reader consumes exactly that prefix; new events do not prolong it.
        if unsafe {
            libc::ioctl(
                self.notifications.as_raw_fd(),
                libc::FIONREAD,
                &mut remaining,
            )
        } < 0
            || remaining < 0
        {
            return Err(failure(
                "watch-gap",
                "directory queue boundary is unavailable",
            ));
        }
        let mut buffer = [0u8; 64 * 1024];
        while remaining > 0 {
            control.check()?;
            let limit = (remaining as usize).min(buffer.len());
            let count = match self.notifications.read(&mut buffer[..limit]) {
                Ok(0) => {
                    return Err(failure(
                        "watch-gap",
                        "directory queue ended before its boundary",
                    ))
                }
                Ok(count) => count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(watch_failure(error)),
            };
            remaining -= count as libc::c_int;
            let events = self.decode(&buffer[..count], control)?;
            if !events.is_empty() {
                send(
                    output,
                    json!({"v":1,"id":id,"kind":"events","events":events}),
                )
                .map_err(io_failure)?;
            }
        }
        self.validate()?;
        control.check()?;
        Ok((!self.pending_moves.is_empty()).then_some("watch-gap"))
    }
    fn run(&mut self, id: &str, control: &Control, output: &Output) -> Result<()> {
        send(
            output,
            json!({"v":1,"id":id,"kind":"ready","coverage":coverage(None)}),
        )
        .map_err(io_failure)?;
        loop {
            control.check()?;
            let mut polls = [
                libc::pollfd {
                    fd: control.descriptor(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.mounts.as_raw_fd(),
                    events: libc::POLLPRI,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.notifications.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            if unsafe { libc::poll(polls.as_mut_ptr(), polls.len() as libc::nfds_t, -1) } < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(io_failure(error));
            }
            control.check()?;
            if polls[1].revents != 0 {
                return Err(failure(
                    "mount-changed",
                    "mount namespace changed during directory observation",
                ));
            }
            if polls
                .iter()
                .any(|poll| poll.revents & (libc::POLLHUP | libc::POLLNVAL) != 0)
            {
                return Err(failure(
                    "watch-gap",
                    "directory observation descriptor ended",
                ));
            }
            let requests = control.take_flushes();
            let reason = self.fence(control, output, id, !requests.is_empty())?;
            for request in requests {
                control.check()?;
                send(output, json!({"v":1,"id":id,"kind":"flushed","request":request,"coverage":coverage(reason)})).map_err(io_failure)?;
            }
        }
    }
}
fn unavailable(id: &str, reason: &str, control: &Control, output: &Output) -> Result<()> {
    // The Host can retain Node hints without retrying an unsupported backend in
    // a zero-delay loop. Pending explicit fences still receive a typed result.
    send(
        output,
        json!({"v":1,"id":id,"kind":"ready","coverage":coverage(Some(reason)),"connected":false}),
    )
    .map_err(io_failure)?;
    loop {
        control.check()?;
        let mut poll = libc::pollfd {
            fd: control.descriptor(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, -1) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(io_failure(error));
        }
        control.check()?;
        for request in control.take_flushes() {
            send(output, json!({"v":1,"id":id,"kind":"flushed","request":request,"coverage":coverage(Some(reason))})).map_err(io_failure)?;
        }
    }
}
fn observe(path: &Path, id: &str, control: &Control, output: &Output) -> Result<()> {
    match Observer::open(path, control) {
        Ok(mut observer) => observer.run(id, control, output),
        Err(error) if matches!(error.reason, "fs-unsupported" | "watch-limit") => {
            unavailable(id, error.reason, control, output)
        }
        Err(error) => Err(error),
    }
}
pub fn run() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let output = Arc::new(Mutex::new(io::stdout()));
    send(&output, json!({"v":1,"kind":"hello"}))?;
    let mut watches: HashMap<String, (Arc<Control>, thread::JoinHandle<()>)> = HashMap::new();
    let result = (|| -> std::result::Result<(), Box<dyn std::error::Error>> {
        for line in io::stdin().lock().lines() {
            // Reap only workers that have really released their descriptors.
            let finished = watches
                .iter()
                .filter_map(|(id, (_, worker))| worker.is_finished().then_some(id.clone()))
                .collect::<Vec<_>>();
            for id in finished {
                if let Some((_, worker)) = watches.remove(&id) {
                    let _ = worker.join();
                }
            }
            match serde_json::from_str::<Command>(&line?)? {
                Command::Open { id, path } => {
                    if watches.contains_key(&id) {
                        return Err(
                            io::Error::other("directory subscription already exists").into()
                        );
                    }
                    let control = Arc::new(Control::new()?);
                    let held = control.clone();
                    let out = output.clone();
                    let key = id.clone();
                    let worker = thread::spawn(move || {
                        // All Observer-owned descriptors are dropped before closed.
                        let result = observe(&path, &key, &held, &out);
                        held.release();
                        if let Err(error) = result {
                            if error.reason != "closed" {
                                let _ = send(
                                    &out,
                                    json!({"v":1,"id":key,"kind":"error","reason":error.reason,"message":error.error.to_string()}),
                                );
                            }
                        }
                        let _ = send(
                            &out,
                            json!({"v":1,"id":key,"kind":"closed","coverage":coverage(Some("closed"))}),
                        );
                    });
                    watches.insert(id, (control, worker));
                }
                Command::Flush { id, request } => {
                    if let Some((control, _)) = watches
                        .get(&id)
                        .filter(|(control, _)| !control.stopped.load(Ordering::Acquire))
                    {
                        control.flush(request);
                    } else {
                        send(
                            &output,
                            json!({"v":1,"id":id,"kind":"error","reason":"closed","message":"directory subscription is closed"}),
                        )?;
                    }
                }
                Command::Close { id } => {
                    if let Some((control, _)) = watches.get(&id) {
                        control.stop();
                    }
                }
            }
        }
        Ok(())
    })();
    for (control, _) in watches.values() {
        control.stop();
    }
    for (_, (_, worker)) in watches {
        let _ = worker.join();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            for parent in [std::env::temp_dir(), PathBuf::from("/dev/shm")] {
                let path = parent.join(format!("varin-directory-watch-{}", uuid::Uuid::new_v4()));
                if fs::create_dir(&path).is_err() {
                    continue;
                }
                let fixture = Self(path);
                let directory = directory_options().open(&fixture.0).unwrap();
                if supported_filesystem(&directory).is_ok() {
                    return fixture;
                }
            }
            panic!("Linux namespace tests need a supported local temporary filesystem");
        }
        fn observer(&self, control: &Control) -> Observer {
            Observer::open(&self.0, control)
                .unwrap_or_else(|error| panic!("{}: {}", error.reason, error.error))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn event(wd: i32, mask: u32, cookie: u32, name: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        let length = if name.is_empty() {
            0
        } else {
            (name.len() + 1 + 15) & !15
        };
        bytes.extend_from_slice(&wd.to_ne_bytes());
        bytes.extend_from_slice(&mask.to_ne_bytes());
        bytes.extend_from_slice(&cookie.to_ne_bytes());
        bytes.extend_from_slice(&(length as u32).to_ne_bytes());
        bytes.extend_from_slice(name.as_bytes());
        bytes.resize(16 + length, 0);
        bytes
    }
    fn descriptor(observer: &Observer, relative: &str) -> i32 {
        *observer
            .directories
            .iter()
            .find(|(_, directory)| directory.relative == relative)
            .unwrap()
            .0
    }
    #[test]
    fn new_subtrees_are_watched_before_their_later_changes() {
        let fixture = Fixture::new();
        let control = Control::new().unwrap();
        let mut observer = fixture.observer(&control);
        fs::create_dir_all(fixture.0.join("arrived/nested/deep")).unwrap();
        fs::write(
            fixture.0.join("arrived/nested/deep/body.txt"),
            b"existing before watch",
        )
        .unwrap();
        let notification = event(
            descriptor(&observer, ""),
            libc::IN_CREATE | libc::IN_ISDIR,
            0,
            "arrived",
        );
        let changed = observer
            .decode(&notification, &control)
            .unwrap_or_else(|error| panic!("{}", error.error));
        assert_eq!(changed[0]["scope"], "subtree");
        assert!(observer
            .directories
            .values()
            .any(|directory| directory.relative == "arrived/nested/deep"));
        observer
            .namespace_barrier(&control)
            .unwrap_or_else(|error| panic!("{}", error.error));
    }
    #[test]
    fn split_directory_rename_keeps_the_gap_until_both_halves_arrive() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.0.join("old/nested")).unwrap();
        let control = Control::new().unwrap();
        let mut observer = fixture.observer(&control);
        let root = descriptor(&observer, "");
        fs::rename(fixture.0.join("old"), fixture.0.join("new")).unwrap();
        let from = event(root, libc::IN_MOVED_FROM | libc::IN_ISDIR, 73, "old");
        observer
            .decode(&from, &control)
            .unwrap_or_else(|error| panic!("{}", error.error));
        assert!(!observer.pending_moves.is_empty());
        assert!(!observer
            .directories
            .values()
            .any(|directory| directory.relative.starts_with("old")));
        let to = event(root, libc::IN_MOVED_TO | libc::IN_ISDIR, 73, "new");
        observer
            .decode(&to, &control)
            .unwrap_or_else(|error| panic!("{}", error.error));
        assert!(observer.pending_moves.is_empty());
        assert!(observer
            .directories
            .values()
            .any(|directory| directory.relative == "new/nested"));
    }
    #[test]
    fn namespace_barrier_uses_original_handles_after_a_rename() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("old")).unwrap();
        let control = Control::new().unwrap();
        let observer = fixture.observer(&control);
        fs::rename(fixture.0.join("old"), fixture.0.join("new")).unwrap();
        observer
            .namespace_barrier(&control)
            .unwrap_or_else(|error| panic!("{}", error.error));
        assert_eq!(observer.directories.len(), 2);
    }
    #[test]
    fn namespace_barrier_accepts_maximum_length_names_on_repeated_fences() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("x".repeat(255)), b"long entry").unwrap();
        fs::create_dir(fixture.0.join("d".repeat(255))).unwrap();
        let control = Control::new().unwrap();
        let observer = fixture.observer(&control);
        for _ in 0..3 {
            observer
                .namespace_barrier(&control)
                .unwrap_or_else(|error| panic!("{}", error.error));
        }
    }
    #[test]
    fn namespace_barrier_preserves_the_failed_syscall_diagnostic() {
        let fixture = Fixture::new();
        let file = fixture.0.join("not-a-directory");
        fs::write(&file, b"file").unwrap();
        let control = Control::new().unwrap();
        let mut observer = fixture.observer(&control);
        let root = descriptor(&observer, "");
        observer.directories.get_mut(&root).unwrap().barrier = File::open(file).unwrap();
        let error = observer.namespace_barrier(&control).err().unwrap();
        assert_eq!(error.reason, "watch-gap");
        assert!(error
            .error
            .to_string()
            .contains(&io::Error::from_raw_os_error(libc::ENOTDIR).to_string()));
    }
    #[test]
    fn overflow_and_lost_watch_records_do_not_become_complete() {
        let fixture = Fixture::new();
        let control = Control::new().unwrap();
        let mut observer = fixture.observer(&control);
        let error = observer
            .decode(&event(-1, libc::IN_Q_OVERFLOW, 0, ""), &control)
            .err()
            .unwrap();
        assert_eq!(error.reason, "overflow");
        let error = observer
            .decode(&event(i32::MAX, libc::IN_CREATE, 0, "unmapped"), &control)
            .err()
            .unwrap();
        assert_eq!(error.reason, "watch-gap");
    }
    #[test]
    fn named_root_replacement_invalidates_the_original_handle() {
        let fixture = Fixture::new();
        let holder = Fixture::new();
        let control = Control::new().unwrap();
        let observer = fixture.observer(&control);
        fs::rename(&fixture.0, holder.0.join("original")).unwrap();
        fs::create_dir(&fixture.0).unwrap();
        assert_eq!(observer.validate().err().unwrap().reason, "root-changed");
    }
    #[test]
    fn closed_control_drops_its_wake_and_pending_requests() {
        let control = Control::new().unwrap();
        control.flush("pending".into());
        control.stop();
        assert_eq!(control.check().err().unwrap().reason, "closed");
        control.release();
        assert!(control.wake.lock().unwrap().is_none());
        assert!(control.flushes.lock().unwrap().is_empty());
        control.stop();
    }
}
