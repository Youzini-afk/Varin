//! Instance-scoped resource admission. Entire plans are acquired atomically; no partial leases.
//! Conflicting requests preserve arrival order, while unrelated work bypasses blocked requests.
use crate::execution::{Access, CancellationToken, ExecutionError, ResourceClaim};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{mpsc, Arc, Mutex};

#[derive(Default)]
pub struct ResourceAdmission {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    next_ticket: u64,
    pending: VecDeque<Pending>,
    active: BTreeMap<String, Vec<ResourceClaim>>,
}
struct Pending {
    ticket: u64,
    owner: String,
    claims: Vec<ResourceClaim>,
    wake: mpsc::SyncSender<()>,
}

pub fn claims_conflict(a: &[ResourceClaim], b: &[ResourceClaim]) -> bool {
    a.iter().any(|left| {
        b.iter().any(|right| {
            left.key == right.key && (left.access == Access::Write || right.access == Access::Write)
        })
    })
}
impl ResourceAdmission {
    /// Register an already-dispatched durable owner before accepting any new work after restart.
    pub(crate) fn restore(&self, owner: String, claims: Vec<ResourceClaim>) {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .active
            .insert(owner, claims);
    }
    pub fn acquire(
        self: &Arc<Self>,
        owner: &str,
        claims: &[ResourceClaim],
        cancel: &CancellationToken,
    ) -> Result<Option<ResourceLease>, ExecutionError> {
        let (wake, events) = mpsc::sync_channel(1);
        let _cancellation = cancel.wake_on_cancel(wake.clone());
        let ticket = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.active.contains_key(owner) || state.pending.iter().any(|p| p.owner == owner) {
                return Err(ExecutionError::new(
                    "resource_owner_exists",
                    "operation already owns or awaits resources",
                ));
            }
            let ticket = state.next_ticket;
            state.next_ticket += 1;
            state.pending.push_back(Pending {
                ticket,
                owner: owner.into(),
                claims: claims.to_vec(),
                wake,
            });
            ticket
        };
        loop {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let position = state
                .pending
                .iter()
                .position(|p| p.ticket == ticket)
                .expect("waiting operation owns its queue entry");
            if cancel.is_cancelled() {
                state.pending.remove(position);
                Self::wake_waiters(&state);
                return Ok(None);
            }
            let blocked = state
                .active
                .values()
                .any(|active| claims_conflict(active, claims))
                || state
                    .pending
                    .iter()
                    .take(position)
                    .any(|prior| claims_conflict(&prior.claims, claims));
            if !blocked {
                state.pending.remove(position);
                state.active.insert(owner.into(), claims.to_vec());
                Self::wake_waiters(&state);
                return Ok(Some(ResourceLease {
                    admission: self.clone(),
                    owner: Some(owner.into()),
                    dispatched: false,
                }));
            }
            drop(state);
            // Completion and cancellation both enqueue notifications: there is no polling or lost wake.
            events.recv().map_err(|_| {
                ExecutionError::new("resource_wait_closed", "resource control channel closed")
            })?;
        }
    }
    fn wake_waiters(state: &State) {
        for pending in &state.pending {
            let _ = pending.wake.try_send(());
        }
    }
    /// Only executor stop/terminal evidence releases a background owner's claims; cancel is not proof.
    pub(crate) fn release(&self, owner: &str) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.active.remove(owner);
        Self::wake_waiters(&state);
    }
}
pub struct ResourceLease {
    admission: Arc<ResourceAdmission>,
    owner: Option<String>,
    dispatched: bool,
}
impl ResourceLease {
    /// After durable dispatch, unwinding cannot prove that the external owner has stopped.
    pub(crate) fn dispatched(&mut self) {
        self.dispatched = true;
    }
    pub(crate) fn release(mut self) {
        self.dispatched = false;
    }
    /// The durable operation now owns occupancy, including uncertain persistence after dispatch.
    pub fn handoff(mut self) {
        self.owner.take();
    }
}
impl Drop for ResourceLease {
    fn drop(&mut self) {
        if !self.dispatched {
            if let Some(owner) = self.owner.take() {
                self.admission.release(&owner);
            }
        }
    }
}
