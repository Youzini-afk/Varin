//! Exact policy pins and cancellable rendezvous. Catalog alone publishes an activation.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::catalog::policy_switch::*;
use varin_runtime::{execution::*, Catalog};

struct Pending {
    wake: mpsc::SyncSender<()>,
    reply: Option<Reply>,
    generation: u64,
    transition: bool,
}
struct State {
    epoch: Option<String>,
    pending: HashMap<String, Pending>,
}
#[derive(Clone)]
pub(crate) struct PolicyBridge {
    state: Arc<Mutex<State>>,
    events: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
    catalog: Arc<Mutex<Option<Arc<Mutex<Catalog>>>>>,
    slots: Arc<Mutex<HashMap<String, Arc<PolicySlot>>>>,
}
#[derive(Default)]
struct SlotState {
    active: Option<Arc<LivePolicy>>,
    candidate: Option<Arc<Candidate>>,
}
#[derive(Default)]
struct PolicySlot {
    state: Mutex<SlotState>,
}
struct LivePolicy {
    generation: u64,
    target: PolicyTarget,
    policy: Arc<dyn AgentPolicy>,
    host: Option<HostPolicy>,
    capabilities: Vec<PolicyModelCapability>,
    models: BTreeMap<String, BoundPolicyModel>,
}
struct Candidate {
    selection: PolicySelection,
    binding: Arc<LivePolicy>,
    cancel: CancellationToken,
}
fn failed(code: &str) -> ExecutionError {
    ExecutionError::new(code, code)
}
fn storage(error: impl ToString) -> ExecutionError {
    ExecutionError::new("policy_selection", error.to_string())
}
pub(crate) fn effective_identity(identity: PolicyIdentity) -> PolicyIdentity {
    crate::process_wait::policy_identity(crate::collaboration::policy_identity(
        crate::questions::policy_identity(identity),
    ))
}
impl PolicyBridge {
    pub(crate) fn new(output: impl Into<crate::transport::Sender>) -> Self {
        let output = output.into();
        let (tx, rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(State {
            epoch: None,
            pending: HashMap::new(),
        }));
        let failed = state.clone();
        std::thread::spawn(move || {
            for event in rx {
                if output.send(event).is_err() {
                    break;
                }
            }
            close_state(&failed);
        });
        Self {
            state,
            events: Arc::new(Mutex::new(Some(tx))),
            catalog: Arc::new(Mutex::new(None)),
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub(crate) fn initialize(&self, epoch: &str) {
        close_state(&self.state);
        if let Ok(mut s) = self.state.lock() {
            s.epoch = Some(epoch.into());
        }
        if let Ok(mut slots) = self.slots.lock() {
            for slot in slots.values() {
                if let Ok(s) = slot.state.lock() {
                    if let Some(c) = &s.candidate {
                        c.cancel.cancel();
                    }
                }
            }
            slots.clear();
        }
    }
    pub(crate) fn set_catalog(&self, catalog: Arc<Mutex<Catalog>>) {
        *self.catalog.lock().unwrap_or_else(|p| p.into_inner()) = Some(catalog);
    }
    fn catalog(&self) -> Result<Arc<Mutex<Catalog>>, ExecutionError> {
        self.catalog
            .lock()
            .map_err(storage)?
            .clone()
            .ok_or_else(|| failed("policy_catalog_unavailable"))
    }
    pub(crate) fn close(&self) {
        close_state(&self.state);
        if let Ok(mut e) = self.events.lock() {
            e.take();
        }
        if let Ok(mut slots) = self.slots.lock() {
            for slot in slots.values() {
                if let Ok(s) = slot.state.lock() {
                    if let Some(c) = &s.candidate {
                        c.cancel.cancel();
                    }
                }
            }
            slots.clear();
        }
    }
    fn slot(&self, run: &str) -> Result<Arc<PolicySlot>, ExecutionError> {
        Ok(self
            .slots
            .lock()
            .map_err(storage)?
            .entry(run.into())
            .or_default()
            .clone())
    }
    pub(crate) fn receive(&self, value: Value) {
        let Ok(reply) = serde_json::from_value::<Reply>(value) else {
            return;
        };
        let transition = reply.kind == "agent-policy-transition-response";
        if reply.v != 1
            || (!transition && reply.kind != "agent-policy-response")
            || reply.id.is_empty()
            || reply.ok
                != (if transition {
                    reply.transition.is_some() && reply.decision.is_none()
                } else {
                    reply.decision.is_some() && reply.transition.is_none()
                })
            || reply.ok == reply.error.is_some()
        {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if state.epoch.as_deref() != Some(&reply.kernel_epoch) {
                return;
            }
            if let Some(p) = state.pending.get_mut(&reply.id) {
                if p.generation == reply.generation
                    && p.transition == transition
                    && p.reply.is_none()
                {
                    p.reply = Some(reply);
                    let _ = p.wake.try_send(());
                }
            }
        }
    }
    fn send(&self, value: Value) -> Result<(), ExecutionError> {
        self.events
            .lock()
            .map_err(storage)?
            .as_ref()
            .ok_or_else(|| failed("policy_channel_closed"))?
            .send(value)
            .map_err(|_| failed("policy_channel_closed"))
    }
    pub(crate) fn policy(
        &self,
        run_id: String,
        reference: String,
        generation: u64,
        artifact: AgentPolicyArtifactBinding,
    ) -> Result<Arc<dyn AgentPolicy>, ExecutionError> {
        Ok(Arc::new(
            self.host(run_id, reference, generation, artifact)?,
        ))
    }
    fn host(
        &self,
        run_id: String,
        reference: String,
        generation: u64,
        artifact: AgentPolicyArtifactBinding,
    ) -> Result<HostPolicy, ExecutionError> {
        PolicyTarget::Extension {
            artifact: artifact.clone(),
        }
        .validate()
        .map_err(storage)?;
        if run_id.is_empty() || reference.is_empty() {
            return Err(failed("policy_binding_invalid"));
        }
        Ok(HostPolicy {
            bridge: self.clone(),
            run_id,
            reference,
            generation,
            artifact,
        })
    }
    pub(crate) fn install(
        &self,
        run: &str,
        generation: u64,
        target: PolicyTarget,
        policy: Arc<dyn AgentPolicy>,
        capabilities: Vec<PolicyModelCapability>,
        models: BTreeMap<String, BoundPolicyModel>,
    ) -> Result<Arc<dyn AgentPolicy>, ExecutionError> {
        let slot = self.slot(run)?;
        let catalog = self.catalog()?;
        {
            let db = catalog.lock().map_err(storage)?;
            let launch = db.launch_metadata(run).map_err(storage)?;
            if let Some(launch) = launch {
                if launch.policy_generation != generation
                    || launch.policy_target != target
                    || effective_identity(policy.identity()) != launch.selection.policy
                {
                    return Err(failed("policy_rebind_changed"));
                }
            } else if generation != 0 || target != PolicyTarget::Default {
                return Err(failed("policy_launch_missing"));
            }
        }
        slot.state.lock().map_err(storage)?.active = Some(Arc::new(LivePolicy {
            generation,
            target,
            policy,
            host: None,
            capabilities,
            models,
        }));
        Ok(Arc::new(SelectedPolicy {
            owner: self.clone(),
            slot,
            run_id: run.into(),
        }))
    }
    pub(crate) fn install_models(
        &self,
        run: &str,
        generation: u64,
        capabilities: Vec<PolicyModelCapability>,
        models: BTreeMap<String, BoundPolicyModel>,
    ) -> Result<(), ExecutionError> {
        let slot = self.slot(run)?;
        let mut state = slot.state.lock().map_err(storage)?;
        let old = state
            .active
            .as_ref()
            .ok_or_else(|| failed("policy_not_installed"))?;
        if old.generation != generation {
            return Err(failed("policy_rebind_changed"));
        }
        state.active = Some(Arc::new(LivePolicy {
            generation,
            target: old.target.clone(),
            policy: old.policy.clone(),
            host: old.host.clone(),
            capabilities,
            models,
        }));
        Ok(())
    }
    pub(crate) fn wrap_models(
        &self,
        run: &str,
        primary: Arc<dyn ModelProvider>,
    ) -> Result<Arc<dyn ModelProvider>, ExecutionError> {
        Ok(Arc::new(SelectedPolicyModels {
            slot: self.slot(run)?,
            primary,
        }))
    }
    pub(crate) fn ready(
        &self,
        selection: PolicySelection,
        binding: Option<crate::protocol_generated::AgentPolicyBinding>,
        mut capabilities: Vec<PolicyModelCapability>,
        credentials: &crate::credential_bridge::CredentialBridge,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<PolicySelection, crate::error::KernelError> {
        use crate::error::KernelError;
        let (policy, host): (Arc<dyn AgentPolicy>, Option<HostPolicy>) =
            match (&selection.target, binding) {
                (PolicyTarget::Default, None) => (Arc::new(DefaultAgentPolicy), None),
                (PolicyTarget::Extension { artifact }, Some(binding))
                    if binding.generation >= 0
                        && binding.generation as u64 == selection.generation
                        && &binding.artifact == artifact =>
                {
                    let host = self
                        .host(
                            selection.run_id.clone(),
                            binding.reference,
                            selection.generation,
                            binding.artifact,
                        )
                        .map_err(|e| KernelError::Operation(e.to_string()))?;
                    (Arc::new(host.clone()), Some(host))
                }
                _ => {
                    return Err(KernelError::Authorization(
                        "candidate binding differs from exact policy target".into(),
                    ))
                }
            };
        let mut models = BTreeMap::new();
        for capability in &mut capabilities {
            if capability.binding.is_some() {
                return Err(KernelError::Protocol(
                    "policy model binding is constructed by the owner".into(),
                ));
            }
            if capability.status == PolicyModelStatus::Available {
                let bound = crate::agent_runtime::bind_policy_model(
                    &selection.run_id,
                    capability,
                    credentials,
                )?;
                capability.binding = Some(bound.binding);
                models.insert(
                    capability.capability_id.clone(),
                    BoundPolicyModel {
                        capability: capability.clone(),
                        provider: bound.provider,
                    },
                );
            }
        }
        let catalog = self
            .catalog()
            .map_err(|e| KernelError::Operation(e.to_string()))?;
        let stored_capabilities = capabilities.clone();
        let preparation = {
            catalog
                .lock()
                .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
                .prepare_policy_ready(
                    &selection.run_id,
                    &selection.selection_id,
                    selection.generation,
                    effective_identity(policy.identity()),
                    stored_capabilities,
                )
                .map_err(crate::agent_runtime::domain)?
        };
        let prepared = preparation.load().map_err(crate::agent_runtime::domain)?;
        let live = Arc::new(LivePolicy {
            generation: selection.generation,
            target: selection.target.clone(),
            policy,
            host,
            capabilities,
            models,
        });
        let slot = self
            .slot(&selection.run_id)
            .map_err(|e| KernelError::Operation(e.to_string()))?;
        let mut state = slot
            .state
            .lock()
            .map_err(|_| KernelError::Storage("policy slot failed".into()))?;
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(KernelError::Cancelled);
        }
        let committed = catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .publish_policy_ready(prepared)
            .map_err(crate::agent_runtime::domain)?;
        if committed.status == PolicySelectionStatus::Ready {
            if state
                .candidate
                .as_ref()
                .is_some_and(|c| c.selection == committed)
            {
                return Ok(committed);
            }
            if let Some(old) = state.candidate.take() {
                old.cancel.cancel();
            }
            state.candidate = Some(Arc::new(Candidate {
                selection: committed.clone(),
                binding: live,
                cancel: CancellationToken::default(),
            }));
        }
        Ok(committed)
    }
    pub(crate) fn cancel_candidate(&self, run: &str, selection_id: &str) {
        let slot = self
            .slots
            .lock()
            .ok()
            .and_then(|slots| slots.get(run).cloned());
        if let Some(slot) = slot {
            let old = slot.state.lock().ok().and_then(|mut s| {
                if s.candidate
                    .as_ref()
                    .is_some_and(|c| c.selection.selection_id == selection_id)
                {
                    s.candidate.take()
                } else {
                    None
                }
            });
            if let Some(old) = old {
                old.cancel.cancel();
                self.release_generation(run, old.selection.generation);
            }
        }
    }
    fn release_generation(&self, run: &str, generation: u64) {
        let epoch = self.state.lock().ok().and_then(|s| s.epoch.clone());
        if let Some(epoch) = epoch {
            let _=self.send(json!({"v":1,"kind":"agent-policy-release","kernelEpoch":epoch,"runId":run,"generation":generation}));
        }
    }
    pub(crate) fn release(&self, run: &str) {
        let slot = self.slots.lock().ok().and_then(|mut s| s.remove(run));
        if let Some(slot) = slot {
            if let Ok(s) = slot.state.lock() {
                if let Some(active) = &s.active {
                    self.release_generation(run, active.generation);
                }
                if let Some(candidate) = &s.candidate {
                    candidate.cancel.cancel();
                    self.release_generation(run, candidate.selection.generation);
                }
            }
        }
    }
}
fn close_state(state: &Mutex<State>) {
    if let Ok(mut s) = state.lock() {
        s.epoch = None;
        for (_, p) in s.pending.drain() {
            let _ = p.wake.try_send(());
        }
    }
}
#[derive(Clone)]
struct HostPolicy {
    bridge: PolicyBridge,
    run_id: String,
    reference: String,
    generation: u64,
    artifact: AgentPolicyArtifactBinding,
}
impl HostPolicy {
    fn request(
        &self,
        input: Value,
        transition: bool,
        cancel: &CancellationToken,
        candidate_cancel: Option<&CancellationToken>,
    ) -> Result<Reply, ExecutionError> {
        if cancel.is_cancelled() || candidate_cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(failed("policy_cancelled"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (wake, rx) = mpsc::sync_channel(1);
        let _registration = cancel.wake_on_cancel(wake.clone());
        let _candidate_registration = candidate_cancel.map(|c| c.wake_on_cancel(wake.clone()));
        let epoch = {
            let mut s = self.bridge.state.lock().map_err(storage)?;
            let epoch = s
                .epoch
                .clone()
                .ok_or_else(|| failed("policy_channel_unavailable"))?;
            s.pending.insert(
                id.clone(),
                Pending {
                    wake,
                    reply: None,
                    generation: self.generation,
                    transition,
                },
            );
            epoch
        };
        let result = (|| {
            self.bridge.send(json!({"v":1,"kind":if transition{"agent-policy-transition-request"}else{"agent-policy-request"},"id":id,"kernelEpoch":epoch,
            "runId":self.run_id,"generation":self.generation,"binding":{"reference":self.reference,"generation":self.generation,"artifact":self.artifact},"input":input}))?;
            loop {
                if cancel.is_cancelled()
                    || candidate_cancel.is_some_and(CancellationToken::is_cancelled)
                {
                    let _=self.bridge.send(json!({"v":1,"kind":"agent-policy-cancel","id":id,"kernelEpoch":epoch,"runId":self.run_id,"generation":self.generation}));
                    return Err(failed("policy_cancelled"));
                }
                {
                    let mut s = self.bridge.state.lock().map_err(storage)?;
                    if s.epoch.as_deref() != Some(&epoch) {
                        return Err(failed("policy_channel_closed"));
                    }
                    let pending = s
                        .pending
                        .get_mut(&id)
                        .ok_or_else(|| failed("policy_channel_closed"))?;
                    if let Some(reply) = pending.reply.take() {
                        return if reply.ok {
                            Ok(reply)
                        } else {
                            Err(failed("policy_callback_failed"))
                        };
                    }
                }
                rx.recv().map_err(|_| failed("policy_channel_closed"))?;
            }
        })();
        if let Ok(mut s) = self.bridge.state.lock() {
            s.pending.remove(&id);
        }
        result
    }
}
impl AgentPolicy for HostPolicy {
    fn identity(&self) -> PolicyIdentity {
        self.artifact.identity.clone()
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        if view.run_id != self.run_id {
            return Err(failed("policy_run_mismatch"));
        }
        self.request(
            json!({"view":view_value(view),"event":event_view(event),"state":state}),
            false,
            cancel,
            None,
        )?
        .decision
        .ok_or_else(|| failed("policy_decision_failed"))
    }
}
struct SelectedPolicy {
    owner: PolicyBridge,
    slot: Arc<PolicySlot>,
    run_id: String,
}
fn active(slot: &PolicySlot) -> Arc<LivePolicy> {
    slot.state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .active
        .clone()
        .expect("Run assembly installed an active policy")
}
impl AgentPolicy for SelectedPolicy {
    fn identity(&self) -> PolicyIdentity {
        active(&self.slot).policy.identity()
    }
    fn decide(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        cancel: &CancellationToken,
    ) -> Result<PolicyDecision, ExecutionError> {
        active(&self.slot).policy.decide(view, event, state, cancel)
    }
    fn select_for_decision(
        &self,
        view: &PolicyView<'_>,
        event: &PolicyEvent,
        state: &Value,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<Option<Value>, ExecutionError> {
        let (old, candidate) = {
            let slot = self.slot.state.lock().map_err(storage)?;
            (
                slot.active.clone().expect("active policy installed"),
                slot.candidate.clone(),
            )
        };
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        if candidate.cancel.is_cancelled() {
            return Ok(None);
        }
        let catalog = self.owner.catalog()?;
        let capture = catalog
            .lock()
            .map_err(storage)?
            .capture_policy_activation(
                &self.run_id,
                epoch,
                &candidate.selection.selection_id,
                candidate.selection.generation,
            )
            .map_err(storage)?;
        let Some(capture) = capture else {
            return Ok(None);
        };
        let selected_state = if capture.state_mode() == PolicyStateMode::RestartState {
            Ok(Value::Null)
        } else if capture.previous_target() == &candidate.binding.target {
            Ok(state.clone())
        } else {
            match &candidate.binding.host {
                Some(host) if host.artifact.state_transition == PolicyStateTransition::Explicit => {
                    let input = json!({
                        "from": {"identity": old.target.identity(), "declaredIdentity": old.target.declared_identity()},
                        "view": view_value(view), "event": event_view(event), "state": state,
                    });
                    host.request(input, true, cancel, Some(&candidate.cancel))
                        .and_then(|reply| match reply.transition {
                            Some(TransitionOutcome::Compatible { state }) => Ok(state),
                            Some(TransitionOutcome::Incompatible { .. }) => {
                                Err(failed("policy_state_incompatible"))
                            }
                            None => Err(failed("policy_transition_invalid")),
                        })
                }
                _ => Err(failed("policy_state_incompatible")),
            }
        };
        let selected_state = match selected_state {
            Ok(state) => state,
            Err(error) => {
                if !cancel.is_cancelled() && !candidate.cancel.is_cancelled() {
                    catalog
                        .lock()
                        .map_err(storage)?
                        .fail_policy_selection(
                            &self.run_id,
                            &candidate.selection.selection_id,
                            &error.code,
                        )
                        .map_err(storage)?;
                }
                self.owner
                    .cancel_candidate(&self.run_id, &candidate.selection.selection_id);
                return Ok(None);
            }
        };
        let prepared = capture.load(&selected_state, event).map_err(storage)?;
        let mut slot = self.slot.state.lock().map_err(storage)?;
        if candidate.cancel.is_cancelled()
            || cancel.is_cancelled()
            || slot
                .candidate
                .as_ref()
                .is_none_or(|c| !Arc::ptr_eq(c, &candidate))
        {
            return Ok(None);
        }
        let committed = catalog
            .lock()
            .map_err(storage)?
            .activate_policy(prepared)
            .map_err(storage)?;
        if committed.is_none() {
            return Ok(None);
        }
        slot.active = Some(candidate.binding.clone());
        slot.candidate = None;
        drop(slot);
        self.owner.release_generation(&self.run_id, old.generation);
        Ok(Some(selected_state))
    }
}
struct SelectedPolicyModels {
    slot: Arc<PolicySlot>,
    primary: Arc<dyn ModelProvider>,
}
impl ModelProvider for SelectedPolicyModels {
    fn select_for_request(
        &self,
        run: &str,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<Option<SelectedModel>, ExecutionError> {
        self.primary.select_for_request(run, epoch, cancel)
    }
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        self.primary.serialize(view)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.primary.generate(request, cancel, emit)
    }
    fn policy_model_capabilities(&self) -> Vec<PolicyModelCapability> {
        active(&self.slot).capabilities.clone()
    }
    fn policy_model_capability(&self, id: &str) -> Option<BoundPolicyModel> {
        active(&self.slot).models.get(id).cloned()
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum TransitionOutcome {
    Compatible {
        state: Value,
    },
    Incompatible {
        #[serde(rename = "reason")]
        _reason: String,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reply {
    v: u64,
    kind: String,
    id: String,
    kernel_epoch: String,
    generation: u64,
    ok: bool,
    decision: Option<PolicyDecision>,
    transition: Option<TransitionOutcome>,
    error: Option<ErrorMarker>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorMarker {
    #[serde(rename = "code")]
    _code: String,
}
fn view_value(view: &PolicyView<'_>) -> Value {
    json!({"run_id":view.run_id,"state":view.state,"history_count":view.history.len(),"history_head_id":view.history.last().map(|i|&i.id),"pending_tool_calls":view.pending_tool_calls,"model_capabilities":view.model_capabilities})
}
fn event_view(event: &PolicyEvent) -> Value {
    match event {
        PolicyEvent::ToolsCompleted { results } => {
            json!({"kind":"tools_completed","results":results.iter().map(|result|{
        let completion=match &result.completion{ToolCompletion::Result{outcome,effect,..}=>json!({"kind":"result","outcome":outcome,"effect":effect}),ToolCompletion::NotDispatched{..}=>json!({"kind":"not_dispatched"}),ToolCompletion::JobAccepted{operation_id,phase,effect,lifetime}=>json!({"kind":"job_accepted","operation_id":operation_id,"phase":phase,"effect":effect,"lifetime":lifetime})};
        json!({"request_id":result.request_id,"call_id":result.call_id,"completion":completion})}).collect::<Vec<_>>()})
        }
        _ => serde_json::to_value(event).expect("policy event serializes"),
    }
}

#[cfg(test)]
#[path = "policy_switch_review.rs"]
mod switch_review;
