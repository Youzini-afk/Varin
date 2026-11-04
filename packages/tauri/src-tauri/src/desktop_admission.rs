//! Admission for native resources that shutdown must observe. A permit covers
//! preparation through registry publication (or original-owner cleanup), never
//! Host/renderer readiness. Closing admission and acquiring a permit share one
//! lock; shutdown waits for admitted work before it snapshots resource owners.
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Clone, Copy)]
struct State {
    accepting: bool,
    active: usize,
}
struct Inner {
    state: Mutex<State>,
    changed: watch::Sender<State>,
}
#[derive(Clone)]
pub(crate) struct Owner(Arc<Inner>);
pub(crate) struct Permit(Owner);

impl Default for Owner {
    fn default() -> Self {
        let state = State {
            accepting: true,
            active: 0,
        };
        Self(Arc::new(Inner {
            state: Mutex::new(state),
            changed: watch::channel(state).0,
        }))
    }
}
impl Owner {
    pub(crate) fn enter(&self) -> Result<Permit, String> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "Desktop admission is unavailable")?;
        if !state.accepting {
            return Err("Desktop is shutting down".into());
        }
        state.active = state
            .active
            .checked_add(1)
            .ok_or("Desktop admission overflow")?;
        self.0.changed.send_replace(*state);
        Ok(Permit(self.clone()))
    }

    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        // watch retains the current count: a permit released before subscribe,
        // or between observing the count and changed().await, cannot be lost.
        {
            let mut state = self
                .0
                .state
                .lock()
                .map_err(|_| "Desktop admission is unavailable")?;
            state.accepting = false;
            self.0.changed.send_replace(*state);
        }
        let mut changed = self.0.changed.subscribe();
        loop {
            if changed.borrow_and_update().active == 0 {
                return Ok(());
            }
            changed
                .changed()
                .await
                .map_err(|_| "Desktop admission drain was lost")?;
        }
    }

    pub(crate) fn resume(&self) -> Result<(), String> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "Desktop admission is unavailable")?;
        if state.active != 0 {
            return Err("Desktop admission is still draining".into());
        }
        state.accepting = true;
        self.0.changed.send_replace(*state);
        Ok(())
    }
}
impl Permit {
    /// An admitted migration can stop waiting for private-reader input when
    /// Quit closes admission, then finish its original cleanup before release.
    pub(crate) async fn until_shutdown<T>(
        &self,
        operation: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        // Only cancel waits whose original owner retains cleanup outside this
        // future. Dropping a waiter is not a completed native/process effect.
        tokio::select! {
            biased;
            _ = self.cancelled() => Err("Desktop is shutting down".into()),
            result = operation => result,
        }
    }

    pub(crate) async fn cancelled(&self) {
        let mut changed = self.0.0.changed.subscribe();
        loop {
            if !changed.borrow_and_update().accepting {
                return;
            }
            if changed.changed().await.is_err() {
                return;
            }
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self
            .0
            .0
            .state
            .lock()
            .expect("Desktop admission is unavailable");
        state.active -= 1;
        self.0.0.changed.send_replace(*state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn quit_after_snapshot_rejects_later_window_and_host_admission() {
        let owner = Owner::default();
        let resources = Arc::new(Mutex::new(Vec::new()));
        let (checked, at_snapshot) = oneshot::channel();
        let (resume, paused) = oneshot::channel();
        let creating = owner.clone();
        let published = resources.clone();
        let startup = tokio::spawn(async move {
            // Represents the completed settings snapshot / old quitting check.
            checked.send(()).unwrap();
            paused.await.unwrap();
            for resource in ["main", "host", "startup-error-window"] {
                if let Ok(_permit) = creating.enter() {
                    published.lock().unwrap().push(resource);
                }
            }
        });
        at_snapshot.await.unwrap();
        owner.shutdown().await.unwrap();
        let drained = resources.lock().unwrap().clone();
        resume.send(()).unwrap();
        startup.await.unwrap();
        assert!(drained.is_empty());
        assert!(resources.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn quit_waits_for_original_registration_but_not_host_readiness() {
        let owner = Owner::default();
        let resources = Arc::new(Mutex::new(Vec::new()));
        let (admitted, in_flight) = oneshot::channel();
        let (publish, publication) = oneshot::channel();
        let (host_ready, readiness) = oneshot::channel();
        let creating = owner.clone();
        let published = resources.clone();
        let startup = tokio::spawn(async move {
            {
                let _permit = creating.enter().unwrap();
                admitted.send(()).unwrap();
                publication.await.unwrap();
                published.lock().unwrap().extend(["main", "host"]);
            }
            readiness.await.unwrap();
        });
        in_flight.await.unwrap();
        let observer = owner.enter().unwrap();
        let draining = owner.clone();
        let registered = resources.clone();
        let shutdown = tokio::spawn(async move {
            draining.shutdown().await.unwrap();
            registered.lock().unwrap().clone()
        });
        observer.cancelled().await;
        drop(observer);
        assert!(!shutdown.is_finished());
        assert!(owner.enter().is_err());
        publish.send(()).unwrap();
        assert_eq!(shutdown.await.unwrap(), ["main", "host"]);
        assert!(
            !startup.is_finished(),
            "readiness must not hold shutdown admission"
        );
        host_ready.send(()).unwrap();
        startup.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_migration_retains_cleanup_and_failed_quit_can_resume() {
        use tokio::io::AsyncReadExt;
        let owner = Owner::default();
        let migration = owner.enter().unwrap();
        let (mut reader, _writer) = tokio::io::duplex(16);
        let (cancelled, cancellation) = oneshot::channel();
        let (cleanup, cleaned) = oneshot::channel();
        let importer = tokio::spawn(async move {
            let result = migration
                .until_shutdown(async { reader.read_u8().await.map_err(|e| e.to_string()) })
                .await;
            assert!(result.is_err());
            cancelled.send(()).unwrap();
            // The original process/native owner still has to settle cleanup.
            cleaned.await.unwrap();
            drop(migration);
        });
        let draining = owner.clone();
        let shutdown = tokio::spawn(async move { draining.shutdown().await });
        cancellation.await.unwrap();
        assert!(!shutdown.is_finished(), "migration still owns its cleanup");
        assert!(
            owner.resume().is_err(),
            "cannot reopen before original cleanup"
        );
        cleanup.send(()).unwrap();
        importer.await.unwrap();
        shutdown.await.unwrap().unwrap();
        // A refusal/error in the subsequent guarded drain restores admission.
        owner.resume().unwrap();
        let restored = owner.enter().unwrap();
        drop(restored);
        owner.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn early_return_and_release_before_wait_do_not_strand_shutdown() {
        let owner = Owner::default();
        let failed = || -> Result<(), String> {
            let _permit = owner.enter()?;
            Err("resource construction failed".into())
        };
        assert!(failed().is_err());
        owner.shutdown().await.unwrap();
        owner.resume().unwrap();
        let permit = owner.enter().unwrap();
        let draining = owner.clone();
        let wait = tokio::spawn(async move { draining.shutdown().await });
        drop(permit);
        wait.await.unwrap().unwrap();
    }
}
