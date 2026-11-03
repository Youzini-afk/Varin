//! Opt-in probe breadcrumbs. The hot path only stores fixed, content-free progress markers;
//! a sleeping observer publishes once, after a stop has already stalled.
//! Each stage retains its last sequence number, so repeated read/kill calls
//! cannot look stuck merely because their entry and return share a millisecond.
use std::{
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc},
    thread,
    time::{Duration, Instant},
};

const STAGES: &[&str] = &[
    "stop-requested", "stop-enqueue-started", "stop-enqueued", "stop-write-started", "stop-written",
    "control-read-started", "control-read-returned", "control-resize-started", "control-resize-returned",
    "stop-received", "target-kill-started", "target-kill-returned", "target-exit-observed",
    "pty-master-lock-started", "pty-close-started", "pty-close-returned",
    "output-read-started", "output-read-returned", "output-send-started", "output-send-returned",
    "output-reader-ended", "pty-reader-join-started", "pty-reader-joined",
    "descendant-drain-started", "descendant-drain-confirmed",
    "input-write-started", "input-write-returned", "input-flush-started", "input-flush-returned",
    "input-receipt-started", "input-receipt-returned", "input-send-started", "input-send-returned",
    "input-idle", "input-finish-requested", "input-finish-queued", "input-worker-joined",
    "tree-receipt-write-started", "tree-receipt-installed", "tree-receipt-sent",
];
const STALL: Duration = Duration::from_secs(5);

pub(super) struct StalledTrace {
    started: Instant,
    armed: AtomicU64,
    sequence: AtomicU64,
    finished: AtomicBool,
    stages: [AtomicU64; STAGES.len()],
}
impl StalledTrace {
    pub(super) fn start(publish: impl FnOnce(Vec<(&'static str, u64)>) + Send + 'static) -> Arc<Self> {
        Self::start_with_trigger(|| false, publish)
    }
    pub(super) fn start_with_trigger(
        externally_stalled: impl Fn() -> bool + Send + 'static,
        publish: impl FnOnce(Vec<(&'static str, u64)>) + Send + 'static,
    ) -> Arc<Self> {
        let trace = Arc::new(Self {
            started: Instant::now(), armed: AtomicU64::new(0), sequence: AtomicU64::new(0), finished: AtomicBool::new(false),
            stages: std::array::from_fn(|_| AtomicU64::new(0)),
        });
        let observer = Arc::downgrade(&trace);
        thread::spawn(move || loop {
            // No diagnostic I/O, owner locks, notifications or busy polling in
            // the command-to-stop race. A probe is not an exit deadline.
            thread::sleep(STALL);
            let Some(trace) = observer.upgrade() else { return; };
            if trace.finished.load(Ordering::Acquire) { return; }
            if trace.should_publish(trace.elapsed(), STALL.as_millis() as u64, externally_stalled()) {
                publish(trace.snapshot());
                return;
            }
        });
        trace
    }
    fn elapsed(&self) -> u64 { self.started.elapsed().as_millis() as u64 }
    pub(super) fn mark(&self, stage: &str) {
        if let Some(index) = STAGES.iter().position(|candidate| *candidate == stage) {
            self.stages[index].store(self.sequence.fetch_add(1, Ordering::Relaxed) + 1, Ordering::Release);
        }
    }
    pub(super) fn arm(&self) {
        let _ = self.armed.compare_exchange(0, self.elapsed() + 1, Ordering::Release, Ordering::Relaxed);
    }
    pub(super) fn finish(&self) { self.finished.store(true, Ordering::Release); }
    fn is_stalled(&self, now: u64, grace: u64) -> bool {
        let armed = self.armed.load(Ordering::Acquire);
        armed != 0 && now.saturating_sub(armed - 1) >= grace && !self.finished.load(Ordering::Acquire)
    }
    fn should_publish(&self, now: u64, grace: u64, externally_stalled: bool) -> bool {
        !self.finished.load(Ordering::Acquire) && (externally_stalled || self.is_stalled(now, grace))
    }
    fn snapshot(&self) -> Vec<(&'static str, u64)> {
        let mut stages: Vec<_> = STAGES.iter().zip(&self.stages).filter_map(|(name, progress)| {
            let sequence = progress.load(Ordering::Acquire);
            (sequence != 0).then_some((*name, sequence))
        }).collect();
        stages.sort_by_key(|(_, at)| *at);
        stages
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn trace() -> StalledTrace {
        StalledTrace { started: Instant::now(), armed: AtomicU64::new(0), sequence: AtomicU64::new(0), finished: AtomicBool::new(false),
            stages: std::array::from_fn(|_| AtomicU64::new(0)) }
    }
    #[test]
    fn only_an_unfinished_original_stop_can_trigger_a_snapshot() {
        let trace = trace();
        assert!(!trace.is_stalled(100_000, 5_000));
        trace.armed.store(101, Ordering::Release);
        assert!(!trace.is_stalled(5_099, 5_000));
        assert!(trace.is_stalled(5_100, 5_000));
        trace.arm();
        assert_eq!(trace.armed.load(Ordering::Acquire), 101);
        trace.finish();
        assert!(!trace.is_stalled(100_000, 5_000));
    }
    #[test]
    fn independent_lanes_remain_bounded_and_keep_repeated_entry_order() {
        let trace = trace();
        for stage in ["target-kill-started", "output-read-started", "input-idle"] { trace.mark(stage); }
        trace.mark("untrusted-content-must-not-be-recorded");
        let snapshot = trace.snapshot();
        assert_eq!(snapshot.len(), 3);
        for stage in ["target-kill-started", "output-read-started", "input-idle"] {
            assert!(snapshot.iter().any(|(name, _)| *name == stage));
        }
        trace.mark("target-kill-started");
        assert_eq!(trace.snapshot().last(), Some(&("target-kill-started", 4)));
    }
    #[test]
    fn original_kernel_stall_can_observe_a_guardian_that_never_received_stop() {
        let trace = trace();
        trace.mark("control-resize-started");
        assert!(!trace.should_publish(100_000, 5_000, false));
        assert!(trace.should_publish(100_000, 5_000, true));
        assert_eq!(trace.snapshot(), vec![("control-resize-started", 1)]);
        trace.finish();
        assert!(!trace.should_publish(100_000, 5_000, true));
    }
}
