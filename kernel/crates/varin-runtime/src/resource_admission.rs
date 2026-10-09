//! Instance-scoped resource admission. Entire plans are acquired atomically; no partial leases.
//! Conflicting requests preserve arrival order, while unrelated work bypasses blocked requests.
use crate::execution::{Access, CancellationToken, ExecutionError, ResourceClaim};
use crate::execution_capacity::{
    AdmissionIdentity, AdmissionStatus, AdmissionSummary, ExecutionClass,
};
use std::collections::{BTreeMap, VecDeque};
use std::num::NonZeroUsize;
use std::sync::{mpsc, Arc, Mutex};

#[derive(Default)]
pub struct ResourceAdmission {
    state: Mutex<State>,
}
struct State {
    next_ticket: u64,
    pending: VecDeque<Pending>,
    active: BTreeMap<String, Active>,
    compute_capacity: NonZeroUsize,
    families: VecDeque<String>,
    last_compute_family: Option<String>,
}
struct Active {
    claims: Vec<ResourceClaim>,
    family: String,
    class: ExecutionClass,
    identity: Option<AdmissionIdentity>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            next_ticket: 0,
            pending: VecDeque::new(),
            active: BTreeMap::new(),
            compute_capacity: crate::execution_capacity::default_compute_capacity(),
            families: VecDeque::new(),
            last_compute_family: None,
        }
    }
}
struct Pending {
    ticket: u64,
    owner: String,
    claims: Vec<ResourceClaim>,
    wake: mpsc::SyncSender<()>,
    family: String,
    class: ExecutionClass,
    cancel: CancellationToken,
    identity: Option<AdmissionIdentity>,
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
            .insert(
                owner.clone(),
                Active {
                    claims,
                    family: owner,
                    class: ExecutionClass::Unmetered,
                    identity: None,
                },
            );
    }
    pub fn acquire(
        self: &Arc<Self>,
        owner: &str,
        claims: &[ResourceClaim],
        cancel: &CancellationToken,
    ) -> Result<Option<ResourceLease>, ExecutionError> {
        self.acquire_inner(
            owner,
            claims,
            owner,
            ExecutionClass::Unmetered,
            None,
            cancel,
        )
    }
    /// Resources and capacity are reserved together, never one while waiting on the other.
    pub fn acquire_scheduled(
        self: &Arc<Self>,
        owner: &str,
        claims: &[ResourceClaim],
        identity: &AdmissionIdentity,
        class: ExecutionClass,
        cancel: &CancellationToken,
    ) -> Result<Option<ResourceLease>, ExecutionError> {
        self.acquire_inner(
            owner,
            claims,
            &identity.family_id,
            class,
            Some(identity.clone()),
            cancel,
        )
    }
    fn acquire_inner(
        self: &Arc<Self>,
        owner: &str,
        claims: &[ResourceClaim],
        family: &str,
        class: ExecutionClass,
        identity: Option<AdmissionIdentity>,
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
                family: family.into(),
                class,
                cancel: cancel.clone(),
                identity: identity.clone(),
            });
            if class == ExecutionClass::LocalCompute
                && !state.families.iter().any(|id| id == family)
            {
                // Join the pending round before the last-served family, rather than giving a
                // sole active family another turn merely because the challenger arrived later.
                let insertion = state
                    .last_compute_family
                    .as_ref()
                    .and_then(|last| state.families.iter().position(|id| id == last))
                    .unwrap_or(state.families.len());
                state.families.insert(insertion, family.into());
            }
            Self::wake_waiters(&state);
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
                Self::prune_families(&mut state);
                Self::wake_waiters(&state);
                return Ok(None);
            }
            let blocked = Self::resource_blocked(&state, position)
                || (class == ExecutionClass::LocalCompute
                    && (Self::compute_active(&state) >= state.compute_capacity.get()
                        || Self::next_compute(&state) != Some(ticket)));
            if !blocked {
                state.pending.remove(position);
                state.active.insert(
                    owner.into(),
                    Active {
                        claims: claims.to_vec(),
                        family: family.into(),
                        class,
                        identity: identity.clone(),
                    },
                );
                if class == ExecutionClass::LocalCompute {
                    state.families.retain(|id| id != family);
                    state.families.push_back(family.into());
                    state.last_compute_family = Some(family.into());
                }
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
    fn compute_active(state: &State) -> usize {
        state
            .active
            .values()
            .filter(|entry| entry.class == ExecutionClass::LocalCompute)
            .count()
    }
    fn resource_blocked(state: &State, position: usize) -> bool {
        let claims = &state.pending[position].claims;
        state
            .active
            .values()
            .any(|active| claims_conflict(&active.claims, claims))
            || state
                .pending
                .iter()
                .take(position)
                .any(|prior| !prior.cancel.is_cancelled() && claims_conflict(&prior.claims, claims))
    }
    fn next_compute(state: &State) -> Option<u64> {
        // Round-robin among runnable families. Resource-blocked families do not stall others;
        // their place is retained. Conflicting writes still obey their original FIFO ordering.
        state.families.iter().find_map(|family| {
            state
                .pending
                .iter()
                .enumerate()
                .find(|(position, pending)| {
                    pending.class == ExecutionClass::LocalCompute
                        && &pending.family == family
                        && !pending.cancel.is_cancelled()
                        && !Self::resource_blocked(state, *position)
                })
                .map(|(_, pending)| pending.ticket)
        })
    }
    fn prune_families(state: &mut State) {
        state.families.retain(|family| {
            state
                .pending
                .iter()
                .any(|p| &p.family == family && p.class == ExecutionClass::LocalCompute)
                || state
                    .active
                    .values()
                    .any(|p| &p.family == family && p.class == ExecutionClass::LocalCompute)
        });
    }
    /// A lower budget affects later dispatches; running work is never preempted or replayed.
    pub fn set_compute_capacity(&self, capacity: NonZeroUsize) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.compute_capacity = capacity;
        Self::wake_waiters(&state);
    }
    pub fn summary(&self) -> AdmissionSummary {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        AdmissionSummary {
            local_compute_capacity: state.compute_capacity.get(),
            local_compute_active: Self::compute_active(&state),
            queued: state.pending.len(),
        }
    }
    /// Exact lookup avoids making a large transient queue into one unbounded IPC frame.
    pub fn inspect(&self, owner: &str) -> Option<AdmissionStatus> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(active) = state.active.get(owner) {
            return Some(AdmissionStatus {
                admission_id: owner.into(),
                family_id: active.family.clone(),
                class: active.class,
                run_id: active.identity.as_ref().map(|i| i.run_id.clone()),
                owner_generation: active.identity.as_ref().map(|i| i.owner_generation),
                origin: active.identity.as_ref().map(|i| i.origin.clone()),
                state: "active",
                reason: None,
            });
        }
        let (position, pending) = state
            .pending
            .iter()
            .enumerate()
            .find(|(_, p)| p.owner == owner)?;
        let reason = if pending.cancel.is_cancelled() {
            "cancelled"
        } else if Self::resource_blocked(&state, position) {
            "resource_conflict"
        } else if pending.class == ExecutionClass::LocalCompute
            && Self::compute_active(&state) >= state.compute_capacity.get()
        {
            "capacity"
        } else if pending.class == ExecutionClass::LocalCompute
            && Self::next_compute(&state) != Some(pending.ticket)
        {
            "family_turn"
        } else {
            "ready"
        };
        Some(AdmissionStatus {
            admission_id: owner.into(),
            family_id: pending.family.clone(),
            class: pending.class,
            run_id: pending.identity.as_ref().map(|i| i.run_id.clone()),
            owner_generation: pending.identity.as_ref().map(|i| i.owner_generation),
            origin: pending.identity.as_ref().map(|i| i.origin.clone()),
            state: "queued",
            reason: Some(reason),
        })
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
        Self::prune_families(&mut state);
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
