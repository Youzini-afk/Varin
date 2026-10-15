//! Instance-scoped resource admission. Entire plans are acquired atomically; no partial leases.
//! Conflicting requests preserve arrival order, while unrelated work bypasses blocked requests.
use crate::execution::{
    Access, CancellationRegistration, CancellationToken, ExecutionError, ResourceClaim,
    ResourceIntent,
};
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
    intents: Vec<ResourceIntent>,
    claims: Option<Vec<ResourceClaim>>,
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
    /// Reserve arrival order before resolving canonical identities. This holds no resources or
    /// compute capacity. Later disjoint work bypasses it, including work from other Runs.
    pub fn reserve(
        self: &Arc<Self>,
        owner: &str,
        intents: Vec<ResourceIntent>,
        identity: &AdmissionIdentity,
        class: ExecutionClass,
        cancel: &CancellationToken,
    ) -> Result<ResourceReservation, ExecutionError> {
        self.reserve_inner(
            owner,
            intents,
            &identity.family_id,
            class,
            Some(identity.clone()),
            cancel,
        )
    }
    /// Host ingress has no model/tool origin. Preserve conflicting command arrival order
    /// while preparing bodies independently, using the same instance resource authority.
    pub fn reserve_unmetered(self:&Arc<Self>,owner:&str,intents:Vec<ResourceIntent>,cancel:&CancellationToken)
        ->Result<ResourceReservation,ExecutionError> {
        self.reserve_inner(owner,intents,owner,ExecutionClass::Unmetered,None,cancel)
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
        let mut reservation = self.reserve_inner(
            owner,
            claims.iter().cloned().map(ResourceIntent::Exact).collect(),
            family,
            class,
            identity,
            cancel,
        )?;
        reservation.resolve(claims)?;
        reservation.acquire()
    }
    fn reserve_inner(
        self: &Arc<Self>,
        owner: &str,
        intents: Vec<ResourceIntent>,
        family: &str,
        class: ExecutionClass,
        identity: Option<AdmissionIdentity>,
        cancel: &CancellationToken,
    ) -> Result<ResourceReservation, ExecutionError> {
        let (wake, events) = mpsc::sync_channel(1);
        let cancellation = cancel.wake_on_cancel(wake.clone());
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
                intents,
                claims: None,
                wake,
                family: family.into(),
                class,
                cancel: cancel.clone(),
                identity: identity.clone(),
            });
            if class == ExecutionClass::LocalCompute
                && !state.families.iter().any(|id| id == family)
            {
                // A new runnable family joins before the last-served family. Unresolved entries
                // retain their place but do not consume a turn or stall another family's work.
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
        Ok(ResourceReservation {
            admission: self.clone(),
            ticket,
            owner: Some(owner.into()),
            events,
            _cancellation: cancellation,
        })
    }
    fn compute_active(state: &State) -> usize {
        state
            .active
            .values()
            .filter(|entry| entry.class == ExecutionClass::LocalCompute)
            .count()
    }
    fn resource_blocked(state: &State, position: usize) -> bool {
        let requested = &state.pending[position];
        state.active.values().any(|active| {
            active.claims.iter().any(|claim| {
                requested
                    .intents
                    .iter()
                    .any(|intent| intent.may_conflict_claim(claim))
            })
        }) || state.pending.iter().take(position).any(|prior| {
            !prior.cancel.is_cancelled()
                && prior.intents.iter().any(|left| {
                    requested
                        .intents
                        .iter()
                        .any(|right| left.may_conflict(right))
                })
        })
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
                        && pending.claims.is_some()
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
        } else if pending.claims.is_none() {
            "resource_planning"
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
/// A queue identity retained across owner-side preparation. Dropping an undispatched reservation
/// removes only its own ordering intent and wakes work that it previously blocked.
pub struct ResourceReservation {
    admission: Arc<ResourceAdmission>,
    ticket: u64,
    owner: Option<String>,
    events: mpsc::Receiver<()>,
    _cancellation: CancellationRegistration,
}
impl ResourceReservation {
    /// Validate the trusted preplanning promise before publishing the complete plan. Narrowing
    /// releases unrelated successors immediately; no partial resource lease is ever acquired.
    pub fn resolve(&mut self, claims: &[ResourceClaim]) -> Result<(), ExecutionError> {
        let mut state = self
            .admission
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let pending = state
            .pending
            .iter_mut()
            .find(|entry| entry.ticket == self.ticket)
            .expect("reservation owns its queue entry");
        if pending.claims.is_some() {
            return Err(ExecutionError::new(
                "resource_plan_already_resolved",
                "resource plan is immutable after resolution",
            ));
        }
        if claims
            .iter()
            .any(|claim| !pending.intents.iter().any(|intent| intent.covers(claim)))
        {
            return Err(ExecutionError::new(
                "resource_intent_mismatch",
                "resolved resource plan exceeds its ordering intent",
            ));
        }
        pending.intents = claims.iter().cloned().map(ResourceIntent::Exact).collect();
        pending.claims = Some(claims.to_vec());
        ResourceAdmission::wake_waiters(&state);
        Ok(())
    }
    pub fn acquire(mut self) -> Result<Option<ResourceLease>, ExecutionError> {
        loop {
            let mut state = self
                .admission
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let position = state
                .pending
                .iter()
                .position(|entry| entry.ticket == self.ticket)
                .expect("reservation owns its queue entry");
            let pending = &state.pending[position];
            if pending.cancel.is_cancelled() {
                return Ok(None);
            }
            if pending.claims.is_none() {
                return Err(ExecutionError::new(
                    "resource_plan_unresolved",
                    "complete resource plan required before admission",
                ));
            }
            let class = pending.class;
            let blocked = ResourceAdmission::resource_blocked(&state, position)
                || (class == ExecutionClass::LocalCompute
                    && (ResourceAdmission::compute_active(&state) >= state.compute_capacity.get()
                        || ResourceAdmission::next_compute(&state) != Some(self.ticket)));
            if !blocked {
                let pending = state.pending.remove(position).expect("checked reservation");
                let owner = self.owner.take().expect("unconsumed reservation");
                state.active.insert(
                    owner.clone(),
                    Active {
                        claims: pending.claims.expect("resolved plan"),
                        family: pending.family.clone(),
                        class,
                        identity: pending.identity,
                    },
                );
                if class == ExecutionClass::LocalCompute {
                    state.families.retain(|id| id != &pending.family);
                    state.families.push_back(pending.family.clone());
                    state.last_compute_family = Some(pending.family);
                }
                ResourceAdmission::wake_waiters(&state);
                return Ok(Some(ResourceLease {
                    admission: self.admission.clone(),
                    owner: Some(owner),
                    dispatched: false,
                }));
            }
            drop(state);
            self.events.recv().map_err(|_| {
                ExecutionError::new("resource_wait_closed", "resource control channel closed")
            })?;
        }
    }
}
impl Drop for ResourceReservation {
    fn drop(&mut self) {
        if self.owner.is_some() {
            let mut state = self
                .admission
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            state.pending.retain(|entry| entry.ticket != self.ticket);
            ResourceAdmission::prune_families(&mut state);
            ResourceAdmission::wake_waiters(&state);
        }
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
