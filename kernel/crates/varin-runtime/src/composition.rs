//! Immutable, scope-local execution bindings. Installation, configuration resolution and async
//! preparation remain with their existing owners. Publish only an already-ready candidate here.
//! A normal replacement closes ordinary admission but permits a frozen model exchange to finish;
//! revocation invalidates both future admission and outstanding execution leases.
pub mod resolver;
pub mod context;
pub mod tools;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Weak, Mutex,
};
use thiserror::Error;

const PREPARED: u8 = 0;
const ACTIVE: u8 = 1;
const RETIRED: u8 = 2;
const REVOKED: u8 = 3;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct BindingId(pub u64);

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CompositionError {
    #[error("composition revision changed: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("duplicate capability: {0}")]
    DuplicateCapability(String),
    #[error("capability and content version must be nonempty")]
    InvalidIdentity,
    #[error("capability is not bound: {0}")]
    MissingCapability(String),
    #[error("binding {0:?} is not active")]
    Inactive(BindingId),
    #[error("binding {0:?} was revoked")]
    Revoked(BindingId),
    #[error("candidate belongs to another composition registry")]
    ForeignCandidate,
    #[error("authorization changed after candidate preparation")]
    AuthorizationChanged,
    #[error("composition identity space exhausted")]
    IdentityExhausted,
}

/// T is the actual typed implementation or a managed worker endpoint. This module does
/// not turn in-process invocation into JSON RPC. Schema describes the external boundary only.
/// Implementation/endpoint Drop must be nonblocking: resource owners enqueue asynchronous cleanup
/// outside this coordinator, since the last lease may be released on any execution thread.
pub struct BindingSpec<T> {
    pub capability: String,
    pub content_version: String,
    pub schema: Value,
    pub implementation: Arc<T>,
}

struct Binding<T> {
    id: BindingId,
    capability: String,
    content_version: String,
    schema: Arc<Value>,
    implementation: Arc<T>,
    state: AtomicU8,
    revocations: Mutex<Vec<Weak<crate::execution::CancellationToken>>>,
}

pub struct BindingHandle<T>(Arc<Binding<T>>);
impl<T> Clone for BindingHandle<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<T> BindingHandle<T> {
    pub fn id(&self) -> BindingId {
        self.0.id
    }
    pub fn capability(&self) -> &str {
        &self.0.capability
    }
    pub fn content_version(&self) -> &str {
        &self.0.content_version
    }
    pub fn schema(&self) -> &Value {
        &self.0.schema
    }
    /// Ordinary calls must acquire the currently active binding. Frozen model requests use pins.
    pub fn begin_call(&self) -> Result<CallLease<T>, CompositionError> {
        self.admit(false)
    }
    fn admit(&self, pinned: bool) -> Result<CallLease<T>, CompositionError> {
        match self.0.state.load(Ordering::Acquire) {
            REVOKED => Err(CompositionError::Revoked(self.id())),
            ACTIVE => Ok(CallLease(self.clone())),
            RETIRED if pinned => Ok(CallLease(self.clone())),
            _ => Err(CompositionError::Inactive(self.id())),
        }
    }
}

/// Retains only the implementation actually executing, not the entire prior composition.
/// The executor must validate immediately before an effect/commit. A lease is not an OS sandbox
/// and cannot retract an effect which was already dispatched before revocation.
pub struct CallLease<T>(BindingHandle<T>);
impl<T> CallLease<T> {
    pub fn binding_id(&self) -> BindingId {
        self.0.id()
    }
    pub fn validate(&self) -> Result<(), CompositionError> {
        if self.0 .0.state.load(Ordering::Acquire) == REVOKED {
            Err(CompositionError::Revoked(self.binding_id()))
        } else {
            Ok(())
        }
    }
    pub fn implementation(&self) -> Result<&T, CompositionError> {
        self.validate()?;
        Ok(self.0 .0.implementation.as_ref())
    }
    /// Keep cancellation local to this execution. Retirement never signals these registrations.
    pub fn watch_revocation(&self, cancel: &crate::execution::CancellationToken) -> crate::execution_capacity::AdmissionControlGuard {
        let token = Arc::new(cancel.clone());
        let mut watchers = self.0.0.revocations.lock().unwrap_or_else(|e| e.into_inner());
        watchers.retain(|watcher| watcher.strong_count() > 0);
        watchers.push(Arc::downgrade(&token));
        if self.validate().is_err() { token.cancel(); }
        crate::execution_capacity::AdmissionControlGuard::new(move || drop(token))
    }
}

pub struct CompositionPlan<T> {
    revision: u64,
    bindings: BTreeMap<String, BindingHandle<T>>,
}
impl<T> CompositionPlan<T> {
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn bind(&self, capability: &str) -> Result<BindingHandle<T>, CompositionError> {
        self.bindings
            .get(capability)
            .cloned()
            .ok_or_else(|| CompositionError::MissingCapability(capability.into()))
    }
    /// Freeze exactly the tool set sent to a model; do not retain unrelated old providers.
    /// Call this before sending the model request and keep it until its tool exchange settles.
    pub fn pin_model_step<'a>(
        &self,
        capabilities: impl IntoIterator<Item = &'a str>,
    ) -> Result<ModelStepPins<T>, CompositionError> {
        let mut bindings = BTreeMap::new();
        for capability in capabilities {
            let binding = self.bind(capability)?;
            binding.begin_call()?;
            bindings.insert(capability.to_owned(), binding);
        }
        Ok(ModelStepPins {
            revision: self.revision,
            bindings,
        })
    }
}

pub struct ModelStepPins<T> {
    revision: u64,
    bindings: BTreeMap<String, BindingHandle<T>>,
}
impl<T> ModelStepPins<T> {
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn schemas(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.bindings
            .iter()
            .map(|(name, binding)| (name.as_str(), binding.schema()))
    }
    pub fn begin_call(&self, capability: &str) -> Result<CallLease<T>, CompositionError> {
        self.bindings
            .get(capability)
            .ok_or_else(|| CompositionError::MissingCapability(capability.into()))?
            .admit(true)
    }
}

/// Cannot be constructed by consumers or published to a different scope's registry.
pub struct PreparedPlan<T> {
    owner: Arc<()>,
    authorization: Arc<()>,
    expected_revision: u64,
    bindings: BTreeMap<String, BindingHandle<T>>,
}

/// One registry per resolved composition scope. The coordinator serializes only these short
/// in-memory prepare/publish operations; no activation, cleanup, network or await occurs here.
pub struct CompositionRegistry<T> {
    identity: Arc<()>,
    authorization: Arc<()>,
    active: Arc<CompositionPlan<T>>,
    next_binding: u64,
    generations: HashMap<BindingId, Weak<Binding<T>>>,
}
impl<T> Default for CompositionRegistry<T> {
    fn default() -> Self {
        Self::new()
    }
}
impl<T> CompositionRegistry<T> {
    pub fn new() -> Self {
        Self {
            identity: Arc::new(()),
            authorization: Arc::new(()),
            active: Arc::new(CompositionPlan {
                revision: 0,
                bindings: BTreeMap::new(),
            }),
            next_binding: 1,
            generations: HashMap::new(),
        }
    }
    pub fn active(&self) -> Arc<CompositionPlan<T>> {
        self.active.clone()
    }
    /// This is binding assembly after successful external preparation. Any error or dropped
    /// candidate leaves the active plan unchanged. Unchanged actual implementations are reused.
    pub fn prepare(
        &mut self,
        expected_revision: u64,
        specs: Vec<BindingSpec<T>>,
    ) -> Result<PreparedPlan<T>, CompositionError> {
        self.check_revision(expected_revision)?;
        let mut bindings = BTreeMap::new();
        for spec in specs {
            if spec.capability.trim().is_empty() || spec.content_version.trim().is_empty() {
                return Err(CompositionError::InvalidIdentity);
            }
            if bindings.contains_key(&spec.capability) {
                return Err(CompositionError::DuplicateCapability(spec.capability));
            }
            let existing = self
                .active
                .bindings
                .get(&spec.capability)
                .filter(|binding| {
                    binding.0.state.load(Ordering::Acquire) == ACTIVE
                        && binding.content_version() == spec.content_version
                        && binding.schema() == &spec.schema
                        && Arc::ptr_eq(&binding.0.implementation, &spec.implementation)
                });
            let binding = if let Some(existing) = existing {
                existing.clone()
            } else {
                let id = BindingId(self.next_binding);
                self.next_binding = self
                    .next_binding
                    .checked_add(1)
                    .ok_or(CompositionError::IdentityExhausted)?;
                BindingHandle(Arc::new(Binding {
                    id,
                    capability: spec.capability.clone(),
                    content_version: spec.content_version,
                    schema: Arc::new(spec.schema),
                    implementation: spec.implementation,
                    state: AtomicU8::new(PREPARED),
                    revocations: Mutex::new(Vec::new()),
                }))
            };
            bindings.insert(spec.capability, binding);
        }
        Ok(PreparedPlan {
            owner: self.identity.clone(),
            authorization: self.authorization.clone(),
            expected_revision,
            bindings,
        })
    }
    pub fn publish(
        &mut self,
        candidate: PreparedPlan<T>,
    ) -> Result<Arc<CompositionPlan<T>>, CompositionError> {
        self.validate_candidate(&candidate)?;
        let revision = candidate.expected_revision + 1;
        for (key, old) in &self.active.bindings {
            if !candidate.bindings.get(key).is_some_and(|new| Arc::ptr_eq(&old.0, &new.0)) {
                let _ = old.0.state.compare_exchange(ACTIVE, RETIRED, Ordering::AcqRel, Ordering::Acquire);
            }
        }
        for binding in candidate.bindings.values() {
            let _ = binding.0.state.compare_exchange(PREPARED, ACTIVE, Ordering::AcqRel, Ordering::Acquire);
            self.generations.insert(binding.id(), Arc::downgrade(&binding.0));
        }
        self.active = Arc::new(CompositionPlan { revision, bindings: candidate.bindings });
        self.generations.retain(|_, binding| binding.strong_count() > 0);
        Ok(self.active())
    }
    /// Check readiness without publishing or retiring the current plan.
    pub fn validate_candidate(&self, candidate: &PreparedPlan<T>) -> Result<(), CompositionError> {
        if !Arc::ptr_eq(&self.identity, &candidate.owner) {
            return Err(CompositionError::ForeignCandidate);
        }
        self.check_revision(candidate.expected_revision)?;
        if !Arc::ptr_eq(&self.authorization, &candidate.authorization) {
            return Err(CompositionError::AuthorizationChanged);
        }
        candidate
            .expected_revision
            .checked_add(1)
            .ok_or(CompositionError::IdentityExhausted)?;
        // A grant may have been revoked while an externally prepared candidate was waiting.
        for binding in candidate.bindings.values() {
            if binding.0.state.load(Ordering::Acquire) == REVOKED {
                return Err(CompositionError::Revoked(binding.id()));
            }
        }
        Ok(())
    }
    /// Explicit revocation also reaches retired generations retained by model pins or calls.
    /// Returns false when the generation no longer exists. This does not claim driver stopping.
    pub fn revoke(&mut self, id: BindingId) -> bool {
        if let Some(binding) = self.generations.get(&id).and_then(Weak::upgrade) {
            binding.state.store(REVOKED, Ordering::Release);
            let watchers: Vec<_> = binding.revocations.lock().unwrap_or_else(|e| e.into_inner())
                .iter().filter_map(Weak::upgrade).collect();
            for token in watchers { token.cancel(); }
            self.authorization = Arc::new(());
            true
        } else {
            false
        }
    }
    fn check_revision(&self, expected: u64) -> Result<(), CompositionError> {
        let actual = self.active.revision;
        if expected == actual {
            Ok(())
        } else {
            Err(CompositionError::RevisionConflict { expected, actual })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn spec(
        name: &str,
        version: &str,
        implementation: Arc<&'static str>,
    ) -> BindingSpec<&'static str> {
        BindingSpec {
            capability: name.into(),
            content_version: version.into(),
            schema: json!({"version": version}),
            implementation,
        }
    }
    fn install(
        registry: &mut CompositionRegistry<&'static str>,
        version: &str,
    ) -> Arc<CompositionPlan<&'static str>> {
        let candidate = registry
            .prepare(
                registry.active().revision(),
                vec![spec("search", version, Arc::new("implementation"))],
            )
            .unwrap();
        registry.publish(candidate).unwrap()
    }
    #[test]
    fn failed_or_abandoned_candidate_preserves_active() {
        let mut registry = CompositionRegistry::new();
        let old = install(&mut registry, "v1");
        let result = registry.prepare(
            1,
            vec![
                spec("search", "v2", Arc::new("new")),
                spec("search", "v3", Arc::new("duplicate")),
            ],
        );
        assert!(matches!(
            result,
            Err(CompositionError::DuplicateCapability(_))
        ));
        let candidate = registry
            .prepare(1, vec![spec("search", "v2", Arc::new("new"))])
            .unwrap();
        drop(candidate); // activation failure outside this short publication owner
        assert!(Arc::ptr_eq(&old, &registry.active()));
        assert_eq!(
            *old.bind("search")
                .unwrap()
                .begin_call()
                .unwrap()
                .implementation()
                .unwrap(),
            "implementation"
        );
    }
    #[test]
    fn retirement_preserves_calls_and_frozen_model_schema() {
        let mut registry = CompositionRegistry::new();
        let old = install(&mut registry, "v1");
        let handle = old.bind("search").unwrap();
        let call = handle.begin_call().unwrap();
        let pins = old.pin_model_step(["search"]).unwrap();
        let new = install(&mut registry, "v2");
        assert!(matches!(
            handle.begin_call(),
            Err(CompositionError::Inactive(_))
        ));
        assert!(call.validate().is_ok());
        let delayed_tool = pins.begin_call("search").unwrap();
        assert_eq!(delayed_tool.binding_id(), handle.id());
        assert_ne!(new.bind("search").unwrap().id(), handle.id());
        assert_eq!(pins.schemas().next().unwrap().1, &json!({"version":"v1"}));
        assert!(pins.begin_call("unadvertised").is_err());
        assert!(old.pin_model_step(["search"]).is_err());
    }
    #[test]
    fn revocation_invalidates_retired_pins_calls_and_prepared_candidates() {
        let mut registry = CompositionRegistry::new();
        let old = install(&mut registry, "v1");
        let pins = old.pin_model_step(["search"]).unwrap();
        let call = pins.begin_call("search").unwrap();
        install(&mut registry, "v2");
        let candidate = registry
            .prepare(2, vec![spec("search", "v3", Arc::new("new"))])
            .unwrap();
        assert!(registry.revoke(call.binding_id()));
        assert!(matches!(call.validate(), Err(CompositionError::Revoked(_))));
        assert!(matches!(
            pins.begin_call("search"),
            Err(CompositionError::Revoked(_))
        ));
        assert!(matches!(
            registry.publish(candidate),
            Err(CompositionError::AuthorizationChanged)
        ));
        assert_eq!(registry.active().revision(), 2);
        assert!(registry
            .active()
            .bind("search")
            .unwrap()
            .begin_call()
            .is_ok());
    }
    #[test]
    fn candidate_revision_and_scope_are_checked() {
        let mut a = CompositionRegistry::new();
        let mut b = CompositionRegistry::new();
        let foreign = a
            .prepare(0, vec![spec("search", "v1", Arc::new("a"))])
            .unwrap();
        assert!(matches!(
            b.publish(foreign),
            Err(CompositionError::ForeignCandidate)
        ));
        let first = a
            .prepare(0, vec![spec("search", "v1", Arc::new("a"))])
            .unwrap();
        let stale = a
            .prepare(0, vec![spec("search", "v2", Arc::new("b"))])
            .unwrap();
        a.publish(first).unwrap();
        assert!(matches!(
            a.publish(stale),
            Err(CompositionError::RevisionConflict {
                expected: 0,
                actual: 1
            })
        ));
    }
    #[test]
    fn unchanged_bindings_reuse_and_pins_only_keep_referenced_implementations() {
        let mut registry = CompositionRegistry::new();
        let search = Arc::new("search");
        let unrelated = Arc::new("unrelated");
        let weak_search = Arc::downgrade(&search);
        let weak_unrelated = Arc::downgrade(&unrelated);
        let candidate = registry
            .prepare(
                0,
                vec![
                    spec("search", "v1", search.clone()),
                    spec("other", "v1", unrelated),
                ],
            )
            .unwrap();
        let first = registry.publish(candidate).unwrap();
        let id = first.bind("search").unwrap().id();
        let pins = first.pin_model_step(["search"]).unwrap();
        let candidate = registry
            .prepare(1, vec![spec("search", "v1", search)])
            .unwrap();
        let second = registry.publish(candidate).unwrap();
        assert_eq!(second.bind("search").unwrap().id(), id);
        drop(first);
        assert!(weak_unrelated.upgrade().is_none());
        let empty = registry.prepare(2, vec![]).unwrap();
        registry.publish(empty).unwrap();
        drop(second);
        assert!(weak_search.upgrade().is_some());
        drop(pins);
        assert!(weak_search.upgrade().is_none());
    }
}
