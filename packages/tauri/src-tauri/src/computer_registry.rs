//! App-lifetime capture leases and original-renderer receipt admission.
//! These owners are independent of Tauri/Win32 so their failure interleavings
//! can be tested without fabricating native window or renderer receipts.
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct OwnerId(pub String);
impl OwnerId {
    pub fn controls_label(&self) -> String {
        format!("computer-controls-{}", self.0)
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct WindowKey {
    pub label: String,
    pub handle: usize,
    pub generation: usize,
}

#[derive(Default)]
pub(crate) struct WindowGenerations {
    next: usize,
    windows: HashMap<usize, WindowKey>,
}
impl WindowGenerations {
    pub fn observe(
        &mut self,
        label: String,
        handle: usize,
        marker: usize,
        set_marker: impl FnOnce(usize) -> Result<(), String>,
    ) -> Result<(WindowKey, bool), String> {
        if marker != 0 {
            return self
                .windows
                .get(&marker)
                .filter(|key| key.label == label && key.handle == handle)
                .cloned()
                .map(|key| (key, false))
                .ok_or_else(|| "Original capture window identity is unknown".into());
        }
        let generation = self
            .next
            .checked_add(1)
            .ok_or("Computer capture window identities exhausted")?;
        // Do not reuse a reservation after an uncertain native property write.
        self.next = generation;
        set_marker(generation)?;
        let key = WindowKey {
            label,
            handle,
            generation,
        };
        self.windows.insert(generation, key.clone());
        Ok((key, true))
    }
    pub fn current(&self, key: &WindowKey, marker: usize) -> bool {
        marker == key.generation && self.windows.get(&key.generation) == Some(key)
    }
    pub fn closed(&mut self, key: &WindowKey) -> bool {
        if self.windows.get(&key.generation) != Some(key) {
            return false;
        }
        self.windows.remove(&key.generation);
        true
    }
}

#[derive(Default)]
pub(crate) struct CaptureProtection {
    owners: HashSet<OwnerId>,
    // Retain the original value even when setting/restoring protection fails.
    // A failed OS call is not evidence that its side effect did not occur.
    originals: HashMap<WindowKey, u32>,
}
impl CaptureProtection {
    pub fn set_active(&mut self, owner: &OwnerId, active: bool) {
        if active {
            self.owners.insert(owner.clone());
        } else {
            self.owners.remove(owner);
        }
    }
    pub fn active(&self) -> bool {
        !self.owners.is_empty()
    }
    pub fn protect(
        &mut self,
        key: WindowKey,
        read: impl FnOnce() -> Result<u32, String>,
        set: impl FnOnce(u32) -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.active() {
            return Ok(());
        }
        if !self.originals.contains_key(&key) {
            self.originals.insert(key, read()?);
        }
        set(0x11) // WDA_EXCLUDEFROMCAPTURE
    }
    pub fn closed(&mut self, key: &WindowKey) {
        self.originals.remove(key);
    }
    pub fn restore(
        &mut self,
        mut restore: impl FnMut(&WindowKey, u32) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.active() {
            return Ok(());
        }
        let mut failure = None;
        self.originals.retain(|key, previous| {
            if let Err(error) = restore(key, *previous) {
                failure.get_or_insert(error);
                true
            } else {
                false
            }
        });
        failure.map_or(Ok(()), Err)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum RendererPhase {
    #[default]
    Loading,
    Ready,
    Terminated,
    Closed,
}
pub(crate) struct Receipts<T> {
    phase: RendererPhase,
    pending: HashMap<i32, T>,
}
impl<T> Receipts<T> {
    pub fn new() -> Self {
        Self {
            phase: RendererPhase::Loading,
            pending: HashMap::new(),
        }
    }
    /// A late load callback cannot resurrect a terminated/closed renderer.
    pub fn ready(&mut self) -> bool {
        if self.phase != RendererPhase::Loading {
            return false;
        }
        self.phase = RendererPhase::Ready;
        true
    }
    pub fn admit(&mut self, id: i32, reply: T) -> Result<(), T> {
        if self.phase != RendererPhase::Ready || self.pending.contains_key(&id) {
            return Err(reply);
        }
        self.pending.insert(id, reply);
        Ok(())
    }
    pub fn remove(&mut self, id: i32) -> Option<T> {
        self.pending.remove(&id)
    }
    /// Called under the same mutex as admission, together with the retained
    /// watch signal. Termination is not an actual native browser-close receipt.
    pub fn finish(&mut self, phase: RendererPhase) -> Vec<T> {
        assert!(matches!(
            phase,
            RendererPhase::Terminated | RendererPhase::Closed
        ));
        if self.phase != RendererPhase::Closed {
            self.phase = phase;
        }
        self.pending.drain().map(|(_, reply)| reply).collect()
    }
    pub fn phase(&self) -> RendererPhase {
        self.phase
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    fn owner(id: &str) -> OwnerId {
        OwnerId(id.into())
    }
    fn window(generation: usize) -> WindowKey {
        WindowKey {
            label: "main".into(),
            handle: 10,
            generation,
        }
    }
    #[test]
    fn native_generation_rejects_recycled_handles_and_stale_destroy_receipts() {
        let mut windows = WindowGenerations::default();
        let (original, fresh) = windows.observe("main".into(), 10, 0, |_| Ok(())).unwrap();
        assert!(fresh);
        let (again, fresh) = windows
            .observe("main".into(), 10, original.generation, |_| {
                panic!("existing marker")
            })
            .unwrap();
        assert!(!fresh);
        assert_eq!(again, original);
        // Same label and HWND, but the OS removed its property on destruction.
        let (replacement, fresh) = windows.observe("main".into(), 10, 0, |_| Ok(())).unwrap();
        assert!(fresh);
        assert!(!windows.current(&original, replacement.generation));
        assert!(windows.current(&replacement, replacement.generation));
        assert!(windows.closed(&original));
        assert!(!windows.closed(&original));
        assert!(windows.current(&replacement, replacement.generation));
    }
    #[test]
    fn unknown_or_mismatched_native_markers_are_not_overwritten() {
        let mut windows = WindowGenerations::default();
        let (key, _) = windows.observe("main".into(), 10, 0, |_| Ok(())).unwrap();
        for (label, handle, marker) in [
            ("other", 10, key.generation),
            ("main", 11, key.generation),
            ("main", 10, 99),
        ] {
            assert!(
                windows
                    .observe(label.into(), handle, marker, |_| panic!(
                        "must not overwrite unknown identity"
                    ))
                    .is_err()
            );
        }
        assert!(!windows.current(&key, 0));
    }
    #[test]
    fn failed_native_marker_is_not_published_or_reused() {
        let mut windows = WindowGenerations::default();
        assert!(
            windows
                .observe("main".into(), 10, 0, |_| Err("unknown marker write".into()))
                .is_err()
        );
        assert!(windows.windows.is_empty());
        let (key, _) = windows.observe("main".into(), 10, 0, |_| Ok(())).unwrap();
        assert_eq!(key.generation, 2);
    }
    #[test]
    fn overlapping_owners_restore_once_after_either_shutdown_order() {
        for order in [[owner("a"), owner("b")], [owner("b"), owner("a")]] {
            let mut leases = CaptureProtection::default();
            let affinity = Cell::new(1);
            let reads = Cell::new(0);
            for id in [&owner("a"), &owner("b")] {
                leases.set_active(id, true);
                leases
                    .protect(
                        window(1),
                        || {
                            reads.set(reads.get() + 1);
                            Ok(affinity.get())
                        },
                        |value| {
                            affinity.set(value);
                            Ok(())
                        },
                    )
                    .unwrap();
            }
            assert_eq!(reads.get(), 1);
            for _ in 0..2 {
                leases.set_active(&order[0], false);
            }
            leases
                .restore(|_, _| panic!("another owner remains active"))
                .unwrap();
            assert_eq!(affinity.get(), 0x11);
            leases.set_active(&order[1], false);
            leases
                .restore(|_, value| {
                    affinity.set(value);
                    Ok(())
                })
                .unwrap();
            assert_eq!(affinity.get(), 1);
            leases.restore(|_, _| panic!("must restore once")).unwrap();
        }
    }
    #[test]
    fn new_window_inherits_all_active_owners_not_only_the_refreshing_owner() {
        let mut leases = CaptureProtection::default();
        leases.set_active(&owner("a"), true);
        leases.set_active(&owner("b"), true);
        leases.set_active(&owner("inactive"), false);
        let affinity = Cell::new(0);
        leases
            .protect(
                window(2),
                || Ok(0),
                |v| {
                    affinity.set(v);
                    Ok(())
                },
            )
            .unwrap();
        leases.set_active(&owner("a"), false);
        leases
            .restore(|_, _| panic!("new window still belongs to b"))
            .unwrap();
        assert_eq!(affinity.get(), 0x11);
        leases.set_active(&owner("b"), false);
        leases
            .restore(|key, v| {
                assert_eq!(key, &window(2));
                affinity.set(v);
                Ok(())
            })
            .unwrap();
        assert_eq!(affinity.get(), 0);
    }
    #[test]
    fn failed_set_and_restore_retain_original_affinity_until_actual_success() {
        let mut leases = CaptureProtection::default();
        leases.set_active(&owner("a"), true);
        // Failure may have taken effect: the original must precede the write.
        assert!(
            leases
                .protect(window(1), || Ok(7), |_| Err("unknown set".into()))
                .is_err()
        );
        leases
            .protect(
                window(1),
                || panic!("must not reread the changed OS value"),
                |_| Ok(()),
            )
            .unwrap();
        leases.set_active(&owner("a"), false);
        assert!(
            leases
                .restore(|_, v| {
                    assert_eq!(v, 7);
                    Err("unknown restore".into())
                })
                .is_err()
        );
        // A new owner does not reinterpret a failed restore as the baseline.
        leases.set_active(&owner("b"), true);
        leases
            .protect(window(1), || panic!("original was retained"), |_| Ok(()))
            .unwrap();
        leases.set_active(&owner("b"), false);
        leases
            .restore(|_, v| {
                assert_eq!(v, 7);
                Ok(())
            })
            .unwrap();
        assert!(leases.originals.is_empty());
    }
    #[test]
    fn failed_read_does_not_write_and_does_not_drop_active_owners() {
        let mut leases = CaptureProtection::default();
        leases.set_active(&owner("a"), true);
        assert!(
            leases
                .protect(
                    window(1),
                    || Err("unreadable".into()),
                    |_| panic!("unknown original")
                )
                .is_err()
        );
        assert!(leases.active());
        assert!(leases.originals.is_empty());
        leases.protect(window(1), || Ok(5), |_| Ok(())).unwrap();
        leases.set_active(&owner("a"), false);
        leases
            .restore(|_, original| {
                assert_eq!(original, 5);
                Ok(())
            })
            .unwrap();
    }
    #[test]
    fn exact_generation_survives_label_and_handle_reuse_and_late_destroy() {
        let mut leases = CaptureProtection::default();
        leases.set_active(&owner("a"), true);
        leases.protect(window(1), || Ok(0), |_| Ok(())).unwrap();
        leases.protect(window(2), || Ok(1), |_| Ok(())).unwrap();
        leases.closed(&window(1));
        leases.closed(&window(1)); // Delayed duplicate cannot revoke replacement.
        leases.set_active(&owner("a"), false);
        leases
            .restore(|key, value| {
                assert_eq!(key, &window(2));
                assert_eq!(value, 1);
                Ok(())
            })
            .unwrap();
    }
    #[test]
    fn unknown_original_identity_cannot_restore_or_forget_a_replacement() {
        let mut leases = CaptureProtection::default();
        leases.set_active(&owner("a"), true);
        leases.protect(window(1), || Ok(0), |_| Ok(())).unwrap();
        leases.protect(window(2), || Ok(1), |_| Ok(())).unwrap();
        leases.set_active(&owner("a"), false);
        let mut writes = Vec::new();
        assert!(
            leases
                .restore(|key, value| {
                    if key.generation != 2 {
                        return Err("original incarnation unavailable".into());
                    }
                    writes.push((key.clone(), value));
                    Ok(())
                })
                .is_err()
        );
        assert_eq!(writes, [(window(2), 1)]);
        assert_eq!(leases.originals.len(), 1);
        assert_eq!(leases.originals.get(&window(1)), Some(&0));
        leases.closed(&window(1));
        assert!(leases.originals.is_empty());
    }
    #[test]
    fn controls_label_keeps_each_original_host_owner_distinct() {
        assert_ne!(owner("a").controls_label(), owner("b").controls_label());
        assert_eq!(owner("a").controls_label(), owner("a").controls_label());
    }
    #[test]
    fn renderer_close_before_admission_rejects_the_late_receipt() {
        let mut receipts = Receipts::new();
        assert!(receipts.ready());
        assert!(receipts.finish(RendererPhase::Closed).is_empty());
        assert_eq!(receipts.admit(1, "late"), Err("late"));
        assert_eq!(receipts.phase(), RendererPhase::Closed);
        assert!(!receipts.ready());
    }
    #[test]
    fn renderer_close_after_admission_settles_original_receipts_once() {
        let mut receipts = Receipts::new();
        receipts.ready();
        receipts.admit(1, "first").unwrap();
        assert_eq!(receipts.finish(RendererPhase::Closed), ["first"]);
        assert!(receipts.remove(1).is_none());
        assert!(receipts.finish(RendererPhase::Closed).is_empty());
    }
    #[test]
    fn renderer_termination_is_not_close_and_stale_load_cannot_resurrect_it() {
        let mut receipts = Receipts::new();
        receipts.ready();
        receipts.admit(1, "original").unwrap();
        assert_eq!(receipts.finish(RendererPhase::Terminated), ["original"]);
        assert!(!receipts.ready());
        assert_eq!(receipts.admit(2, "late"), Err("late"));
        assert_eq!(receipts.phase(), RendererPhase::Terminated);
        assert!(receipts.finish(RendererPhase::Closed).is_empty());
        assert_eq!(receipts.phase(), RendererPhase::Closed);
        receipts.finish(RendererPhase::Terminated);
        assert_eq!(receipts.phase(), RendererPhase::Closed);
    }
    #[test]
    fn original_evaluation_result_cannot_settle_another_receipt() {
        let mut receipts = Receipts::new();
        assert_eq!(receipts.admit(1, "loading"), Err("loading"));
        receipts.ready();
        receipts.admit(1, "first").unwrap();
        assert_eq!(receipts.admit(1, "duplicate"), Err("duplicate"));
        receipts.admit(2, "second").unwrap();
        assert_eq!(receipts.remove(1), Some("first"));
        assert_eq!(receipts.finish(RendererPhase::Closed), ["second"]);
    }
}
