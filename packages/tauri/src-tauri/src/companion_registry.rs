//! App-lifetime companion authority. Node identities are local to one service;
//! native labels and asynchronous completions belong to one exact generation.
use std::{collections::HashMap, sync::Mutex};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct OwnerId(u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WindowKey {
    owner: OwnerId,
    generation: u64,
    pub id: u64,
}
impl WindowKey {
    pub fn label(self) -> String {
        format!("companion-{}-{}-{}", self.owner.0, self.generation, self.id)
    }
    fn from_label(label: &str) -> Option<Self> {
        let mut parts = label.strip_prefix("companion-")?.split('-');
        let key = Self {
            owner: OwnerId(parts.next()?.parse().ok()?),
            generation: parts.next()?.parse().ok()?,
            id: parts.next()?.parse().ok()?,
        };
        (parts.next().is_none() && key.label() == label).then_some(key)
    }
}
struct Window<S> {
    key: WindowKey,
    surface: Option<S>,
    publication: watch::Sender<Publication<S>>,
}
#[derive(Clone)]
enum Publication<S> {
    Pending,
    Ready(S),
    Closed,
}
pub(crate) struct Lookup<O, S> {
    owner: O,
    key: WindowKey,
    publication: watch::Receiver<Publication<S>>,
}
impl<O, S: Clone> Lookup<O, S> {
    pub async fn ready(mut self) -> Result<(O, WindowKey, S), String> {
        loop {
            match self.publication.borrow_and_update().clone() {
                Publication::Ready(surface) => return Ok((self.owner, self.key, surface)),
                Publication::Closed => return Err("Companion window generation is closed".into()),
                Publication::Pending => {}
            }
            self.publication
                .changed()
                .await
                .map_err(|_| "Companion window publication ended")?;
        }
    }
}
struct Owner<O, S> {
    value: O,
    stopping: bool,
    windows: HashMap<u64, Window<S>>,
}
struct Entries<O, S> {
    next_owner: u64,
    next_window: u64,
    owners: HashMap<OwnerId, Owner<O, S>>,
}
pub(crate) struct Registry<O, S> {
    entries: Mutex<Entries<O, S>>,
}
impl<O, S> Default for Registry<O, S> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(Entries {
                next_owner: 0,
                next_window: 0,
                owners: HashMap::new(),
            }),
        }
    }
}
impl<O: Clone, S: Clone> Registry<O, S> {
    pub fn register(&self, build: impl FnOnce(OwnerId) -> O) -> Result<O, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Companion registry unavailable")?;
        let next = entries
            .next_owner
            .checked_add(1)
            .ok_or("Companion owner identities exhausted")?;
        entries.next_owner = next;
        let id = OwnerId(next);
        let value = build(id);
        entries.owners.insert(
            id,
            Owner {
                value: value.clone(),
                stopping: false,
                windows: HashMap::new(),
            },
        );
        Ok(value)
    }
    pub fn active(&self, id: OwnerId) -> bool {
        self.entries
            .lock()
            .is_ok_and(|entries| entries.owners.get(&id).is_some_and(|owner| !owner.stopping))
    }
    pub fn reserve(&self, owner: OwnerId, id: u64) -> Result<WindowKey, String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Companion registry unavailable")?;
        let current = entries
            .owners
            .get(&owner)
            .ok_or("Companion native owner is closed")?;
        if current.stopping {
            return Err("Companion native owner is stopping".into());
        }
        if current.windows.contains_key(&id) {
            return Err("Companion window identity is already in use".into());
        }
        let generation = entries
            .next_window
            .checked_add(1)
            .ok_or("Companion window identities exhausted")?;
        entries.next_window = generation;
        let key = WindowKey {
            owner,
            generation,
            id,
        };
        entries.owners.get_mut(&owner).unwrap().windows.insert(
            id,
            Window {
                key,
                surface: None,
                publication: watch::channel(Publication::Pending).0,
            },
        );
        Ok(key)
    }
    /// Publication cannot resurrect a surface that CEF already closed during build.
    /// A stopping owner still retains every surface until authoritative close.
    pub fn publish(&self, key: WindowKey, surface: S) -> Result<(), String> {
        // A poisoned registry must never authorize a request, but it must still
        // retain a just-built native handle until its actual close is observed.
        let (mut entries, unavailable) = match self.entries.lock() {
            Ok(entries) => (entries, false),
            Err(error) => (error.into_inner(), true),
        };
        let owner = entries
            .owners
            .get_mut(&key.owner)
            .ok_or("Companion closed during creation")?;
        let stopping = owner.stopping;
        let window = owner
            .windows
            .get_mut(&key.id)
            .filter(|window| window.key == key && window.surface.is_none())
            .ok_or("Companion closed during creation")?;
        window.surface = Some(surface.clone());
        if unavailable {
            window.publication.send_replace(Publication::Closed);
            return Err("Companion registry unavailable".into());
        }
        if !stopping {
            window.publication.send_replace(Publication::Ready(surface));
        }
        Ok(())
    }
    pub fn surface(&self, owner: OwnerId, id: u64) -> Result<Option<(WindowKey, S)>, String> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| "Companion registry unavailable")?;
        let Some(window) = entries
            .owners
            .get(&owner)
            .and_then(|owner| owner.windows.get(&id))
        else {
            return Ok(None);
        };
        Ok(Some((
            window.key,
            window
                .surface
                .clone()
                .ok_or("Companion window is still preparing")?,
        )))
    }
    pub fn snapshot(&self, id: OwnerId) -> Result<Vec<(WindowKey, S)>, String> {
        let entries = self
            .entries
            .lock()
            .map_err(|_| "Companion registry unavailable")?;
        Ok(entries
            .owners
            .get(&id)
            .into_iter()
            .flat_map(|owner| owner.windows.values())
            .filter_map(|window| window.surface.clone().map(|surface| (window.key, surface)))
            .collect())
    }
    /// Return owned values, never borrowed app state, before any asynchronous work.
    pub fn resolve(&self, label: &str) -> Result<Lookup<O, S>, String> {
        let key = WindowKey::from_label(label).ok_or("Invalid companion native label")?;
        let entries = self
            .entries
            .lock()
            .map_err(|_| "Companion registry unavailable")?;
        let owner = entries
            .owners
            .get(&key.owner)
            .filter(|owner| !owner.stopping)
            .ok_or("Companion native owner is unavailable")?;
        let window = owner
            .windows
            .get(&key.id)
            .filter(|window| window.key == key)
            .ok_or("Companion window generation is closed")?;
        Ok(Lookup {
            owner: owner.value.clone(),
            key,
            publication: window.publication.subscribe(),
        })
    }
    pub fn lookup(&self, label: &str) -> Result<(O, WindowKey, S), String> {
        let lookup = self.resolve(label)?;
        let value = lookup.publication.borrow().clone();
        match value {
            Publication::Ready(surface) => Ok((lookup.owner, lookup.key, surface)),
            Publication::Pending => Err("Companion window is still preparing".into()),
            Publication::Closed => Err("Companion window generation is closed".into()),
        }
    }
    pub fn current(&self, key: WindowKey) -> bool {
        self.entries.lock().is_ok_and(|entries| {
            entries.owners.get(&key.owner).is_some_and(|owner| {
                !owner.stopping
                    && owner
                        .windows
                        .get(&key.id)
                        .is_some_and(|window| window.key == key && window.surface.is_some())
            })
        })
    }
    /// Only the original generation may remove itself. Late close completions
    /// must not remove a replacement that reused the service-local numeric id.
    pub fn remove_window(&self, key: WindowKey) -> bool {
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let Some(owner) = entries.owners.get_mut(&key.owner) else {
            return false;
        };
        if owner
            .windows
            .get(&key.id)
            .is_some_and(|window| window.key == key)
        {
            if let Some(window) = owner.windows.remove(&key.id) {
                window.publication.send_replace(Publication::Closed);
            }
            true
        } else {
            false
        }
    }
    pub fn begin_shutdown(&self, id: OwnerId) -> Result<(), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Companion registry unavailable")?;
        if let Some(owner) = entries.owners.get_mut(&id) {
            owner.stopping = true;
            for window in owner.windows.values() {
                window.publication.send_replace(Publication::Closed);
            }
        }
        Ok(())
    }
    pub fn finish_shutdown(&self, id: OwnerId) -> Result<(), String> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "Companion registry unavailable")?;
        if let Some(owner) = entries.owners.get(&id) {
            if !owner.stopping || !owner.windows.is_empty() {
                return Err(
                    "Companion native surfaces remain owned until their close is confirmed".into(),
                );
            }
        }
        entries.owners.remove(&id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Clone)]
    struct Service {
        id: OwnerId,
        lifetime: Arc<()>,
    }
    fn owner(registry: &Registry<Service, Arc<str>>) -> Service {
        registry
            .register(|id| Service {
                id,
                lifetime: Arc::new(()),
            })
            .unwrap()
    }
    fn window(
        registry: &Registry<Service, Arc<str>>,
        owner: &Service,
        id: u64,
        value: &str,
    ) -> WindowKey {
        let key = registry.reserve(owner.id, id).unwrap();
        registry.publish(key, Arc::from(value)).unwrap();
        key
    }
    #[test]
    fn overlapping_services_keep_independent_authority_and_shutdown() {
        let registry = Registry::default();
        let first = owner(&registry);
        let second = owner(&registry);
        let a = window(&registry, &first, 1, "first artwork");
        let b = window(&registry, &second, 1, "second artwork");
        assert_ne!(a.label(), b.label());
        let lookup = registry.lookup(&b.label()).unwrap();
        assert!(Arc::ptr_eq(&lookup.0.lifetime, &second.lifetime));
        assert_eq!(&*lookup.2, "second artwork");
        registry.begin_shutdown(first.id).unwrap();
        assert!(registry.lookup(&a.label()).is_err());
        assert!(registry.finish_shutdown(first.id).is_err());
        assert!(registry.remove_window(a));
        registry.finish_shutdown(first.id).unwrap();
        assert!(registry.current(b));
        assert!(registry.lookup(&b.label()).is_ok());
        registry.finish_shutdown(first.id).unwrap();
        assert_eq!(registry.snapshot(second.id).unwrap().len(), 1);
    }
    #[test]
    fn lookup_survives_shutdown_but_cannot_publish_a_late_result() {
        let registry = Registry::default();
        let service = owner(&registry);
        let weak = Arc::downgrade(&service.lifetime);
        let key = window(&registry, &service, 1, "in flight");
        let lookup = registry.lookup(&key.label()).unwrap();
        registry.begin_shutdown(service.id).unwrap();
        assert!(!registry.current(key));
        assert!(registry.remove_window(key));
        registry.finish_shutdown(service.id).unwrap();
        drop(service);
        assert!(weak.upgrade().is_some());
        assert_eq!(&*lookup.2, "in flight");
        assert!(registry.lookup(&key.label()).is_err());
        drop(lookup);
        assert!(weak.upgrade().is_none());
    }
    #[test]
    fn stale_close_and_publication_cannot_touch_reused_numeric_identity() {
        let registry = Registry::default();
        let service = owner(&registry);
        let old = window(&registry, &service, 7, "old");
        assert!(registry.remove_window(old));
        let current = window(&registry, &service, 7, "new");
        assert_ne!(old.label(), current.label());
        assert!(!registry.remove_window(old));
        assert!(registry.publish(old, Arc::from("late")).is_err());
        assert!(registry.lookup(&old.label()).is_err());
        assert!(!registry.current(old));
        assert_eq!(&*registry.surface(service.id, 7).unwrap().unwrap().1, "new");
    }
    #[test]
    fn reservations_exclude_duplicate_creates_and_survive_shutdown_until_resolved() {
        let registry = Registry::default();
        let service = owner(&registry);
        let key = registry.reserve(service.id, 1).unwrap();
        assert!(registry.reserve(service.id, 1).is_err());
        assert!(registry.surface(service.id, 1).is_err());
        assert!(registry.surface(service.id, 2).unwrap().is_none());
        assert!(registry.lookup(&key.label()).is_err());
        registry.begin_shutdown(service.id).unwrap();
        assert!(!registry.active(service.id));
        assert!(registry.reserve(service.id, 2).is_err());
        assert!(registry.finish_shutdown(service.id).is_err());
        registry
            .publish(key, Arc::from("built while shutting down"))
            .unwrap();
        assert_eq!(registry.snapshot(service.id).unwrap().len(), 1);
        assert!(!registry.current(key));
        assert!(registry.remove_window(key));
        registry.finish_shutdown(service.id).unwrap();
    }
    #[test]
    fn closed_during_build_cannot_be_resurrected_and_labels_are_canonical() {
        let registry = Registry::default();
        let service = owner(&registry);
        let key = registry.reserve(service.id, 1).unwrap();
        assert!(registry.remove_window(key));
        assert!(registry.publish(key, Arc::from("too late")).is_err());
        let live = window(&registry, &service, 2, "live");
        for label in [
            "companion-2".into(),
            format!("{}-extra", live.label()),
            live.label().replacen("companion-", "companion-0", 1),
        ] {
            assert!(registry.lookup(&label).is_err(), "{label}");
        }
        assert!(registry.current(live));
    }
    #[test]
    fn delayed_lookup_completion_cannot_follow_a_restarted_service() {
        let registry = Arc::new(Registry::default());
        let original = owner(&registry);
        let old = window(&registry, &original, 1, "original receipt");
        let lookup = registry.lookup(&old.label()).unwrap();
        let (resume, paused) = std::sync::mpsc::channel();
        let pending_registry = registry.clone();
        let pending = std::thread::spawn(move || {
            paused.recv().unwrap();
            // This is the post-await authorization check used by artwork delivery.
            assert!(!pending_registry.current(lookup.1));
            assert_eq!(&*lookup.2, "original receipt");
            lookup.0
        });
        registry.begin_shutdown(original.id).unwrap();
        assert!(registry.remove_window(old));
        registry.finish_shutdown(original.id).unwrap();
        let replacement = owner(&registry);
        let fresh = window(&registry, &replacement, 1, "replacement receipt");
        resume.send(()).unwrap();
        let retained = pending.join().unwrap();
        assert!(Arc::ptr_eq(&retained.lifetime, &original.lifetime));
        assert!(!Arc::ptr_eq(&retained.lifetime, &replacement.lifetime));
        assert!(registry.lookup(&old.label()).is_err());
        assert!(registry.current(fresh));
    }
    #[tokio::test]
    async fn pending_native_navigation_waits_for_its_exact_publication() {
        use std::{
            future::Future,
            task::{Context, Waker},
        };
        let registry = Registry::default();
        let first = owner(&registry);
        let second = owner(&registry);
        let key = registry.reserve(first.id, 1).unwrap();
        let mut pending = Box::pin(registry.resolve(&key.label()).unwrap().ready());
        let mut context = Context::from_waker(Waker::noop());
        assert!(pending.as_mut().poll(&mut context).is_pending());
        window(&registry, &second, 1, "unrelated owner");
        assert!(pending.as_mut().poll(&mut context).is_pending());
        registry
            .publish(key, Arc::from("original publication"))
            .unwrap();
        let resolved = pending.await.unwrap();
        assert!(Arc::ptr_eq(&resolved.0.lifetime, &first.lifetime));
        assert_eq!(resolved.1, key);
        assert_eq!(&*resolved.2, "original publication");
    }
    #[tokio::test]
    async fn pending_routes_fail_on_original_close_or_shutdown_without_following_replacement() {
        let registry = Registry::default();
        let service = owner(&registry);
        let key = registry.reserve(service.id, 1).unwrap();
        let pending = registry.resolve(&key.label()).unwrap();
        assert!(registry.remove_window(key));
        let fresh = window(&registry, &service, 1, "replacement");
        assert!(pending.ready().await.is_err());
        assert!(registry.current(fresh));
        let next = registry.reserve(service.id, 2).unwrap();
        let stopped = registry.resolve(&next.label()).unwrap();
        registry.begin_shutdown(service.id).unwrap();
        registry
            .publish(next, Arc::from("native build completed while stopping"))
            .unwrap();
        assert!(stopped.ready().await.is_err());
        assert_eq!(registry.snapshot(service.id).unwrap().len(), 2);
        assert!(registry.finish_shutdown(service.id).is_err());
    }
    #[test]
    fn failed_publication_retains_the_native_handle_without_authorizing_it() {
        let registry = Registry::default();
        let service = owner(&registry);
        let key = registry.reserve(service.id, 1).unwrap();
        let _ = std::panic::catch_unwind(|| {
            let _locked = registry.entries.lock().unwrap();
            panic!("injected registry failure");
        });
        assert!(registry.publish(key, Arc::from("native handle")).is_err());
        assert!(registry.lookup(&key.label()).is_err());
        assert!(!registry.current(key));
        let entries = registry.entries.lock().err().unwrap().into_inner();
        assert_eq!(
            entries.owners[&service.id].windows[&1].surface.as_deref(),
            Some("native handle")
        );
    }
}
