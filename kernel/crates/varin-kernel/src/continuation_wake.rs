//! One native wall-clock wake source for the original continuation worker. The timer is only a
//! wakeup hint; Catalog rechecks the persisted absolute deadline before committing any outcome.
//! No timer wakes a suspended computer and no Wait receives its own worker.
pub use platform::{channel, Sender};
use std::io;
pub struct StopGuard(pub Sender);
impl Drop for StopGuard {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

/// The original continuation reconciliation loop, shared by startup and the native behavioral
/// test. It consumes committed facts; the wake source owns no operation or scheduling state.
pub(crate) fn drive(
    owner: std::sync::Weak<varin_runtime::supervisor::RunSupervisor>,
    mut wakes: platform::Receiver,
) {
    let mut failed = [false; 4];
    loop {
        let Some(runtime) = owner.upgrade() else {
            break;
        };
        let catalog = runtime.catalog();
        let deadline = match catalog
            .lock()
            .map_err(|_| ())
            .and_then(|c| c.nearest_wait_deadline().map_err(|_| ()))
        {
            Ok(deadline) => deadline,
            Err(()) => {
                if let Ok(mut c) = catalog.lock() {
                    let _ =
                        c.record_recovery_failure("continuation-wake", "wait_deadline_read_failed");
                }
                break;
            }
        };
        drop(catalog);
        drop(runtime);
        match wakes.wait(deadline) {
            Ok(true) => (),
            Ok(false) => break,
            Err(_) => {
                if let Some(runtime) = owner.upgrade() {
                    if let Ok(mut c) = runtime.catalog().lock() {
                        let _ = c.record_recovery_failure(
                            "continuation-wake",
                            "native_wall_clock_wake_failed",
                        );
                    }
                }
                break;
            }
        }
        let Some(runtime) = owner.upgrade() else {
            break;
        };
        // Resolve short Wait facts before any content/Goal/followup work. A committed trigger
        // is naturally excluded from the next deadline query, including when its consumer
        // subsequently fails. An unrelated owner failure cannot disarm other future deadlines.
        let facts = runtime
            .catalog()
            .lock()
            .map_err(|_| ())
            .and_then(|mut c| c.reconcile_waits().map_err(|_| ()));
        if facts.is_err() {
            if let Ok(mut c) = runtime.catalog().lock() {
                let _ = c.record_recovery_failure(
                    "continuation-wake",
                    "wait_fact_reconciliation_failed",
                );
            }
            break;
        }
        // Persist due instants before loading any follow-up content. A held/failed consumer
        // cannot leave an elapsed deadline armed and spin this native wake source.
        let time_facts = runtime.catalog().lock().map_err(|_| ()).and_then(|mut c| {
            varin_runtime::catalog::observations::wall_time_ms()
                .and_then(|now| c.reconcile_followup_facts_at(now))
                .map_err(|_| ())
        });
        let calendar_facts = runtime.catalog().lock().map_err(|_| ()).and_then(|mut c| {
            varin_runtime::catalog::observations::wall_time_ms()
                .and_then(|now| c.reconcile_calendar_facts_at(now))
                .map_err(|_| ())
        });
        // Each domain gets the committed-event pass independently; pure Host arithmetic never blocks it. Diagnostics
        // are edge-triggered per owner, so the error event itself cannot generate a retry loop.
        let results = [
            (
                "messages",
                runtime.reconcile_message_requests().map_err(|_| ()),
            ),
            ("goals", runtime.reconcile_goal_waits().map_err(|_| ())),
            (
                "followups",
                varin_runtime::catalog::followups::reconcile(&runtime.catalog())
                    .map(|_| ())
                    .map_err(|_| ())
                    .and(time_facts.map(|_| ())),
            ),
            (
                "calendar",
                varin_runtime::catalog::calendar::reconcile(&runtime.catalog())
                    .map_err(|_| ())
                    .and(calendar_facts.map(|_| ())),
            ),
        ];
        for (index, (source, result)) in results.into_iter().enumerate() {
            if result.is_err() && !failed[index] {
                if let Ok(mut c) = runtime.catalog().lock() {
                    let _ = c.record_recovery_failure(source, "continuation_reconciliation_failed");
                }
            }
            failed[index] = result.is_err();
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::{
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };
    struct Shared {
        event: OwnedFd,
        stopped: AtomicBool,
    }
    #[derive(Clone)]
    pub struct Sender(Arc<Shared>);
    pub struct Receiver {
        shared: Arc<Shared>,
        timer: OwnedFd,
    }
    fn fd(raw: i32) -> io::Result<OwnedFd> {
        if raw < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(raw) })
        }
    }
    pub fn channel() -> io::Result<(Sender, Receiver)> {
        let shared = Arc::new(Shared {
            event: fd(unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) })?,
            stopped: AtomicBool::new(false),
        });
        let timer = fd(unsafe {
            libc::timerfd_create(libc::CLOCK_REALTIME, libc::TFD_CLOEXEC | libc::TFD_NONBLOCK)
        })?;
        Ok((Sender(shared.clone()), Receiver { shared, timer }))
    }
    impl Sender {
        pub fn notify(&self) {
            let one = 1u64;
            loop {
                let count = unsafe {
                    libc::write(self.0.event.as_raw_fd(), (&one as *const u64).cast(), 8)
                };
                if count == 8 {
                    return;
                }
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                // EAGAIN means the coalesced event is already pending. Other errors cannot
                // arise while this owned descriptor is live; the receiver reports poll errors.
                return;
            }
        }
        pub fn shutdown(&self) {
            self.0.stopped.store(true, Ordering::Release);
            self.notify();
        }
    }
    fn drain(fd: i32) -> io::Result<()> {
        loop {
            let mut value = 0u64;
            let count = unsafe { libc::read(fd, (&mut value as *mut u64).cast(), 8) };
            if count >= 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::EAGAIN | libc::ECANCELED) => return Ok(()),
                _ => return Err(error),
            }
        }
    }
    impl Receiver {
        pub fn wait(&mut self, deadline: Option<u64>) -> io::Result<bool> {
            if self.shared.stopped.load(Ordering::Acquire) {
                return Ok(false);
            }
            let value = deadline.map_or(
                libc::timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                },
                |ms| libc::timespec {
                    tv_sec: (ms / 1000) as _,
                    tv_nsec: ((ms % 1000) * 1_000_000) as _,
                },
            );
            let spec = libc::itimerspec {
                it_interval: libc::timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                },
                it_value: value,
            };
            if unsafe {
                libc::timerfd_settime(
                    self.timer.as_raw_fd(),
                    libc::TFD_TIMER_ABSTIME | libc::TFD_TIMER_CANCEL_ON_SET,
                    &spec,
                    std::ptr::null_mut(),
                )
            } < 0
            {
                let error = io::Error::last_os_error();
                // Linux may return ECANCELED while successfully rearming. Drain the old clock
                // notification and return to Catalog now; never retry blindly or hot-loop here.
                if error.raw_os_error() == Some(libc::ECANCELED) {
                    drain(self.timer.as_raw_fd())?;
                    return Ok(true);
                }
                return Err(error);
            }
            let mut fds = [
                libc::pollfd {
                    fd: self.shared.event.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.timer.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            loop {
                let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
                if n < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                break;
            }
            for item in &fds {
                if item.revents & libc::POLLIN != 0 {
                    drain(item.fd)?;
                }
                if item.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                    return Err(io::Error::other("continuation wake descriptor failed"));
                }
            }
            Ok(!self.shared.stopped.load(Ordering::Acquire))
        }
    }
}
#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_FAILED},
        System::Threading::{
            CancelWaitableTimer, CreateEventW, CreateWaitableTimerW, SetEvent, SetWaitableTimer,
            WaitForMultipleObjects, INFINITE,
        },
    };
    struct Handle(HANDLE);
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn handle(raw: HANDLE) -> io::Result<Handle> {
        if raw.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Handle(raw))
        }
    }
    struct Shared {
        event: Handle,
        stopped: AtomicBool,
    }
    #[derive(Clone)]
    pub struct Sender(Arc<Shared>);
    pub struct Receiver {
        shared: Arc<Shared>,
        timer: Handle,
    }
    pub fn channel() -> io::Result<(Sender, Receiver)> {
        unsafe {
            let shared = Arc::new(Shared {
                event: handle(CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()))?,
                stopped: AtomicBool::new(false),
            });
            let timer = handle(CreateWaitableTimerW(std::ptr::null(), 0, std::ptr::null()))?;
            Ok((Sender(shared.clone()), Receiver { shared, timer }))
        }
    }
    impl Sender {
        pub fn notify(&self) {
            unsafe {
                SetEvent(self.0.event.0);
            }
        }
        pub fn shutdown(&self) {
            self.0.stopped.store(true, Ordering::Release);
            self.notify();
        }
    }
    impl Receiver {
        pub fn wait(&mut self, deadline: Option<u64>) -> io::Result<bool> {
            if self.shared.stopped.load(Ordering::Acquire) {
                return Ok(false);
            }
            unsafe {
                if let Some(ms) = deadline {
                    let due = ms
                        .checked_mul(10_000)
                        .and_then(|v| v.checked_add(116_444_736_000_000_000))
                        .and_then(|v| i64::try_from(v).ok())
                        .ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidInput,
                                "absolute timer instant is unrepresentable",
                            )
                        })?;
                    if SetWaitableTimer(self.timer.0, &due, 0, None, std::ptr::null(), 0) == 0 {
                        return Err(io::Error::last_os_error());
                    }
                } else if CancelWaitableTimer(self.timer.0) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let handles = [self.shared.event.0, self.timer.0];
                // A canceled timer can retain its signaled state. It is excluded when unarmed.
                if WaitForMultipleObjects(
                    if deadline.is_some() { 2 } else { 1 },
                    handles.as_ptr(),
                    0,
                    INFINITE,
                ) == WAIT_FAILED
                {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(!self.shared.stopped.load(Ordering::Acquire))
        }
    }
}
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{
        ffi::c_void,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        },
    };
    type Object = *mut c_void;
    #[link(name = "System")]
    extern "C" {
        static _dispatch_source_type_timer: c_void;
        fn dispatch_get_global_queue(identifier: isize, flags: usize) -> Object;
        fn dispatch_source_create(
            kind: *const c_void,
            handle: usize,
            mask: usize,
            queue: Object,
        ) -> Object;
        fn dispatch_set_context(object: Object, context: *mut c_void);
        fn dispatch_source_set_event_handler_f(
            source: Object,
            handler: unsafe extern "C" fn(*mut c_void),
        );
        fn dispatch_source_set_cancel_handler_f(
            source: Object,
            handler: unsafe extern "C" fn(*mut c_void),
        );
        fn dispatch_source_set_timer(source: Object, start: u64, interval: u64, leeway: u64);
        fn dispatch_walltime(base: *const libc::timespec, delta: i64) -> u64;
        fn dispatch_resume(object: Object);
        fn dispatch_source_cancel(object: Object);
        fn dispatch_release(object: Object);
    }
    struct Shared {
        notify: mpsc::SyncSender<()>,
        stopped: AtomicBool,
    }
    #[derive(Clone)]
    pub struct Sender(Arc<Shared>);
    pub struct Receiver {
        shared: Arc<Shared>,
        events: mpsc::Receiver<()>,
        source: Object,
    }
    // Receiver moves once onto the continuation worker; libdispatch owns callbacks and supports
    // source reconfiguration from that worker. Cancellation drains callbacks before freeing context.
    unsafe impl Send for Receiver {}
    unsafe extern "C" fn fired(context: *mut c_void) {
        let notify = &*(context as *const mpsc::SyncSender<()>);
        let _ = notify.try_send(());
    }
    unsafe extern "C" fn cancelled(context: *mut c_void) {
        drop(Box::from_raw(context as *mut mpsc::SyncSender<()>));
    }
    pub fn channel() -> io::Result<(Sender, Receiver)> {
        let (notify, events) = mpsc::sync_channel(1);
        let shared = Arc::new(Shared {
            notify: notify.clone(),
            stopped: AtomicBool::new(false),
        });
        unsafe {
            let source = dispatch_source_create(
                std::ptr::addr_of!(_dispatch_source_type_timer),
                0,
                0,
                dispatch_get_global_queue(0, 0),
            );
            if source.is_null() {
                return Err(io::Error::other("wall-clock dispatch source unavailable"));
            }
            dispatch_set_context(source, Box::into_raw(Box::new(notify)).cast());
            dispatch_source_set_event_handler_f(source, fired);
            dispatch_source_set_cancel_handler_f(source, cancelled);
            dispatch_source_set_timer(source, u64::MAX, u64::MAX, 0);
            dispatch_resume(source);
            Ok((
                Sender(shared.clone()),
                Receiver {
                    shared,
                    events,
                    source,
                },
            ))
        }
    }
    impl Sender {
        pub fn notify(&self) {
            let _ = self.0.notify.try_send(());
        }
        pub fn shutdown(&self) {
            self.0.stopped.store(true, Ordering::Release);
            self.notify();
        }
    }
    impl Receiver {
        pub fn wait(&mut self, deadline: Option<u64>) -> io::Result<bool> {
            if self.shared.stopped.load(Ordering::Acquire) {
                return Ok(false);
            }
            unsafe {
                let start = if let Some(ms) = deadline {
                    dispatch_walltime(
                        &libc::timespec {
                            tv_sec: (ms / 1000) as _,
                            tv_nsec: ((ms % 1000) * 1_000_000) as _,
                        },
                        0,
                    )
                } else {
                    u64::MAX
                };
                dispatch_source_set_timer(self.source, start, u64::MAX, 0);
            }
            if self.events.recv().is_err() {
                return Ok(false);
            }
            Ok(!self.shared.stopped.load(Ordering::Acquire))
        }
    }
    impl Drop for Receiver {
        fn drop(&mut self) {
            unsafe {
                dispatch_source_cancel(self.source);
                dispatch_release(self.source);
            }
        }
    }
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    use super::*;
    #[derive(Clone)]
    pub struct Sender;
    pub struct Receiver;
    pub fn channel() -> io::Result<(Sender, Receiver)> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "native wall-clock continuation wakes are not implemented for this platform",
        ))
    }
    impl Sender {
        pub fn notify(&self) {}
        pub fn shutdown(&self) {}
    }
    impl Receiver {
        pub fn wait(&mut self, _: Option<u64>) -> io::Result<bool> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "native wall-clock continuation wakes are unavailable",
            ))
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    #[test]
    fn real_absolute_timer_event_rearm_and_shutdown_share_one_waiter() {
        let (notify, mut wait) = channel().unwrap();
        let start = Instant::now();
        let now = varin_runtime::catalog::observations::wall_time_ms().unwrap();
        assert!(wait.wait(Some(now + 30)).unwrap());
        assert!(start.elapsed() >= Duration::from_millis(15));
        notify.notify();
        assert!(wait.wait(None).unwrap());
        notify.notify();
        assert!(wait.wait(Some(now + 60_000)).unwrap());
        let (tx, done) = mpsc::channel();
        let worker = std::thread::spawn(move || tx.send(wait.wait(None)).unwrap());
        notify.shutdown();
        assert!(!done.recv_timeout(Duration::from_secs(2)).unwrap().unwrap());
        worker.join().unwrap();
    }
}
