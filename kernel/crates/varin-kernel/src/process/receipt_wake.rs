//! One temporary native directory subscription for recovered guardian receipts.
//! It carries no terminal facts: the Storage owner rechecks the original receipts.
use std::{
    io,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
};
pub(crate) struct Watch {
    stop: platform::Stop,
    thread: Option<JoinHandle<()>>,
    pending: Arc<AtomicBool>,
    failure: Arc<Mutex<Option<String>>>,
}
impl Watch {
    pub(crate) fn open(path: &Path, notify: Arc<dyn Fn() + Send + Sync>) -> io::Result<Self> {
        let (stop, mut source) = platform::open(path)?; // Fully subscribed before the caller's recheck.
        let pending = Arc::new(AtomicBool::new(false));
        let failure = Arc::new(Mutex::new(None));
        let worker_pending = pending.clone();
        let worker_failure = failure.clone();
        let thread = thread::Builder::new()
            .name("process-receipt-wake".into())
            .spawn(move || loop {
                match source.wait() {
                    Ok(false) => break,
                    Ok(true) => (),
                    Err(error) => {
                        *worker_failure.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(error.to_string());
                        if !worker_pending.swap(true, Ordering::AcqRel) {
                            notify();
                        }
                        break;
                    }
                }
                if !worker_pending.swap(true, Ordering::AcqRel) {
                    notify();
                }
            })?;
        Ok(Self {
            stop,
            thread: Some(thread),
            pending,
            failure,
        })
    }
    pub(crate) fn acknowledge(&self) -> Option<String> {
        self.pending.store(false, Ordering::Release);
        self.failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::ffi::OsStrExt,
        },
    };
    pub struct Stop(Arc<OwnedFd>);
    pub struct Source {
        stop: Arc<OwnedFd>,
        directory: OwnedFd,
    }
    fn owned(fd: i32) -> io::Result<OwnedFd> {
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }
    }
    pub fn open(path: &Path) -> io::Result<(Stop, Source)> {
        let directory =
            owned(unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) })?;
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "receipt directory contains NUL",
            )
        })?;
        let mask = libc::IN_CREATE
            | libc::IN_MOVED_TO
            | libc::IN_MOVE_SELF
            | libc::IN_DELETE_SELF
            | libc::IN_ONLYDIR;
        if unsafe { libc::inotify_add_watch(directory.as_raw_fd(), path.as_ptr(), mask) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let stop = Arc::new(owned(unsafe {
            libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK)
        })?);
        Ok((Stop(stop.clone()), Source { stop, directory }))
    }
    impl Stop {
        pub fn stop(&self) {
            let value = 1u64;
            loop {
                let n =
                    unsafe { libc::write(self.0.as_raw_fd(), (&value as *const u64).cast(), 8) };
                if n == 8 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    break;
                }
            }
        }
    }
    impl Source {
        pub fn wait(&mut self) -> io::Result<bool> {
            loop {
                let mut fds = [
                    libc::pollfd {
                        fd: self.stop.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    },
                    libc::pollfd {
                        fd: self.directory.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    },
                ];
                if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } < 0 {
                    let e = io::Error::last_os_error();
                    if e.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(e);
                }
                if fds[0].revents != 0 {
                    return Ok(false);
                }
                if fds[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                    return Err(io::Error::other(
                        "process receipt directory subscription lost",
                    ));
                }
                let mut bytes = [0u8; 8192];
                let n = unsafe {
                    libc::read(
                        self.directory.as_raw_fd(),
                        bytes.as_mut_ptr().cast(),
                        bytes.len(),
                    )
                };
                if n < 0 {
                    let e = io::Error::last_os_error();
                    if matches!(
                        e.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) {
                        continue;
                    }
                    return Err(e);
                }
                let mut offset = 0;
                while offset + std::mem::size_of::<libc::inotify_event>() <= n as usize {
                    let event = unsafe {
                        std::ptr::read_unaligned(
                            bytes.as_ptr().add(offset).cast::<libc::inotify_event>(),
                        )
                    };
                    if event.mask
                        & (libc::IN_Q_OVERFLOW
                            | libc::IN_IGNORED
                            | libc::IN_MOVE_SELF
                            | libc::IN_DELETE_SELF)
                        != 0
                    {
                        return Err(io::Error::other(
                            "process receipt directory subscription invalidated",
                        ));
                    }
                    offset += std::mem::size_of::<libc::inotify_event>() + event.len as usize;
                }
                return Ok(true);
            }
        }
    }
}
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::ffi::OsStrExt,
        },
    };
    pub struct Stop(Arc<OwnedFd>);
    pub struct Source {
        queue: Arc<OwnedFd>,
        _directory: OwnedFd,
    }
    fn owned(fd: i32) -> io::Result<OwnedFd> {
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }
    }
    fn event(ident: usize, filter: i16, flags: u16, fflags: u32) -> libc::kevent {
        libc::kevent {
            ident,
            filter,
            flags,
            fflags,
            data: 0,
            udata: std::ptr::null_mut(),
        }
    }
    pub fn open(path: &Path) -> io::Result<(Stop, Source)> {
        let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "receipt directory contains NUL",
            )
        })?;
        let directory =
            owned(unsafe { libc::open(path.as_ptr(), libc::O_EVTONLY | libc::O_CLOEXEC) })?;
        let queue = Arc::new(owned(unsafe { libc::kqueue() })?);
        if unsafe { libc::fcntl(queue.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
        let changes = [
            event(
                directory.as_raw_fd() as usize,
                libc::EVFILT_VNODE,
                libc::EV_ADD | libc::EV_CLEAR,
                libc::NOTE_WRITE | libc::NOTE_RENAME | libc::NOTE_DELETE | libc::NOTE_REVOKE,
            ),
            event(1, libc::EVFILT_USER, libc::EV_ADD | libc::EV_CLEAR, 0),
        ];
        if unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                changes.as_ptr(),
                2,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((
            Stop(queue.clone()),
            Source {
                queue,
                _directory: directory,
            },
        ))
    }
    impl Stop {
        pub fn stop(&self) {
            let change = event(1, libc::EVFILT_USER, 0, libc::NOTE_TRIGGER);
            loop {
                let n = unsafe {
                    libc::kevent(
                        self.0.as_raw_fd(),
                        &change,
                        1,
                        std::ptr::null_mut(),
                        0,
                        std::ptr::null(),
                    )
                };
                if n >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    break;
                }
            }
        }
    }
    impl Source {
        pub fn wait(&mut self) -> io::Result<bool> {
            loop {
                let mut e: libc::kevent = unsafe { std::mem::zeroed() };
                let n = unsafe {
                    libc::kevent(
                        self.queue.as_raw_fd(),
                        std::ptr::null(),
                        0,
                        &mut e,
                        1,
                        std::ptr::null(),
                    )
                };
                if n < 0 {
                    let e = io::Error::last_os_error();
                    if e.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(e);
                }
                if e.filter == libc::EVFILT_USER {
                    return Ok(false);
                }
                if e.flags & (libc::EV_ERROR | libc::EV_EOF) != 0
                    || e.fflags & (libc::NOTE_RENAME | libc::NOTE_DELETE | libc::NOTE_REVOKE) != 0
                {
                    return Err(io::Error::other(
                        "process receipt directory subscription invalidated",
                    ));
                }
                return Ok(true);
            }
        }
    }
}
#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::PathBuf,
    };
    use windows_sys::Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
        Storage::FileSystem::{
            FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
            FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
        },
        System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE},
    };
    struct Directory(HANDLE);
    // The notification handle is uniquely owned by the waiting worker.
    unsafe impl Send for Directory {}
    impl Drop for Directory {
        fn drop(&mut self) {
            unsafe {
                FindCloseChangeNotification(self.0);
            }
        }
    }
    fn directory(path: &Path, filter: u32) -> io::Result<Directory> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let h = unsafe { FindFirstChangeNotificationW(wide.as_ptr(), 0, filter) };
        if h == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Directory(h))
        }
    }
    pub struct Stop(Arc<OwnedHandle>);
    pub struct Source {
        stop: Arc<OwnedHandle>,
        directory: Directory,
        parent: Directory,
        path: PathBuf,
    }
    pub fn open(path: &Path) -> io::Result<(Stop, Source)> {
        let parent = directory(
            path.parent()
                .ok_or_else(|| io::Error::other("receipt directory parent missing"))?,
            FILE_NOTIFY_CHANGE_DIR_NAME,
        )?;
        let directory = directory(path, FILE_NOTIFY_CHANGE_FILE_NAME)?;
        let h = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if h.is_null() {
            return Err(io::Error::last_os_error());
        }
        let stop = Arc::new(unsafe { OwnedHandle::from_raw_handle(h.cast()) });
        Ok((
            Stop(stop.clone()),
            Source {
                stop,
                directory,
                parent,
                path: path.to_owned(),
            },
        ))
    }
    impl Stop {
        pub fn stop(&self) {
            unsafe {
                SetEvent(self.0.as_raw_handle().cast());
            }
        }
    }
    impl Source {
        pub fn wait(&mut self) -> io::Result<bool> {
            let handles = [
                self.stop.as_raw_handle().cast(),
                self.directory.0,
                self.parent.0,
            ];
            let value = unsafe { WaitForMultipleObjects(3, handles.as_ptr(), 0, INFINITE) };
            if value == WAIT_OBJECT_0 {
                return Ok(false);
            }
            if value == WAIT_OBJECT_0 + 1 {
                // Re-arm before the Storage recheck; Windows retains changes between calls.
                if unsafe { FindNextChangeNotification(self.directory.0) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                return Ok(true);
            }
            if value == WAIT_OBJECT_0 + 2 {
                if unsafe { FindNextChangeNotification(self.parent.0) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                // Parent entry changes may replace the directory. Subscribe to the current
                // owner path before rechecking; never retain a handle to an old directory.
                self.directory = directory(&self.path, FILE_NOTIFY_CHANGE_FILE_NAME)?;
                return Ok(true);
            }
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_receipt_subscription_stop_joins_and_stops_notifications() {
        let root = std::env::temp_dir().join(format!("receipt-wake-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let watch = Watch::open(
            &root,
            Arc::new(move || {
                let _ = tx.send(());
            }),
        )
        .unwrap();
        drop(watch);
        std::fs::write(root.join("after-stop.json"), b"{}").unwrap();
        assert!(rx.try_recv().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
