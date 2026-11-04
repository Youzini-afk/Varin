//! Admission for native resources that shutdown must observe. A permit covers
//! preparation through registry publication (or original-owner cleanup), never
//! Host/renderer readiness. Closing admission and acquiring a permit share one
//! lock; shutdown waits for admitted work before it snapshots resource owners.
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Clone)]
struct State {
    accepting: bool,
    active: usize,
    cleanup_failures: Vec<String>,
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
            cleanup_failures: Vec::new(),
        };
        Self(Arc::new(Inner {
            state: Mutex::new(state.clone()),
            changed: watch::channel(state).0,
        }))
    }
}
impl Owner {
    pub(crate) fn enter(&self) -> Result<Permit, String> {
        self.admit(false)
    }

    // An unconfirmed original resource blocks execution, not the error window
    // that explains it. Presentation still obeys an in-progress shutdown gate.
    pub(crate) fn enter_presentation(&self) -> Result<Permit, String> {
        self.admit(true)
    }

    fn admit(&self, presentation: bool) -> Result<Permit, String> {
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| "Desktop admission is unavailable")?;
        if !state.accepting {
            return Err("Desktop is shutting down".into());
        }
        if !presentation && !state.cleanup_failures.is_empty() {
            return Err(state.cleanup_failures.join("; "));
        }
        state.active = state
            .active
            .checked_add(1)
            .ok_or("Desktop admission overflow")?;
        self.0.changed.send_replace(state.clone());
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
            self.0.changed.send_replace(state.clone());
        }
        let mut changed = self.0.changed.subscribe();
        loop {
            {
                let state = changed.borrow_and_update();
                if state.active == 0 {
                    return if state.cleanup_failures.is_empty() {
                        Ok(())
                    } else {
                        Err(state.cleanup_failures.join("; "))
                    };
                }
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
        self.0.changed.send_replace(state.clone());
        Ok(())
    }
}
impl Permit {
    pub(crate) fn retain_cleanup_failure(&self, error: String) {
        let mut state = self
            .0
            .0
            .state
            .lock()
            .expect("Desktop admission is unavailable");
        if !state.cleanup_failures.contains(&error) {
            state.cleanup_failures.push(error);
        }
        self.0.0.changed.send_replace(state.clone());
    }

    /// Interrupt the original owner, but never drop its completion future.
    /// The caller must still distinguish observed termination from success.
    pub(crate) async fn finish_on_shutdown<T>(
        &self,
        operation: impl std::future::Future<Output = T>,
        interrupt: impl FnOnce() -> Result<(), String>,
    ) -> (T, Option<Result<(), String>>) {
        tokio::pin!(operation);
        tokio::select! {
            biased;
            result = &mut operation => (result, None),
            _ = self.cancelled() => {
                let interrupted = interrupt();
                (operation.await, Some(interrupted))
            },
        }
    }

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
        self.0.0.changed.send_replace(state.clone());
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

    #[tokio::test]
    async fn completion_waits_after_interrupting_a_stalled_eof_reader() {
        use tokio::io::AsyncReadExt;
        let owner = Owner::default();
        let permit = owner.enter().unwrap();
        let (mut reader, writer) = tokio::io::duplex(16);
        let (reaped, reaping) = oneshot::channel();
        let (interrupted, interruption) = oneshot::channel();
        let cleanup = tokio::spawn(async move {
            let operation = async {
                assert_eq!(reader.read(&mut [0]).await.unwrap(), 0);
                reaping.await.unwrap();
                "original-scope-ended"
            };
            let (result, requested) = permit
                .finish_on_shutdown(operation, move || {
                    // Models the original scope's termination closing its pipe.
                    drop(writer);
                    interrupted.send(()).unwrap();
                    Ok(())
                })
                .await;
            assert_eq!(result, "original-scope-ended");
            assert!(matches!(requested, Some(Ok(()))));
        });
        let draining = owner.clone();
        let shutdown = tokio::spawn(async move { draining.shutdown().await });
        interruption.await.unwrap();
        assert!(
            !shutdown.is_finished(),
            "EOF or accepted terminate is not completion"
        );
        reaped.send(()).unwrap();
        cleanup.await.unwrap();
        shutdown.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn unknown_cleanup_blocks_shutdown_and_execution_but_allows_error_presentation() {
        let owner = Owner::default();
        let original = owner.enter().unwrap();
        original
            .retain_cleanup_failure("Original migration process termination is unconfirmed".into());
        drop(original);
        assert!(
            owner
                .shutdown()
                .await
                .unwrap_err()
                .contains("migration process")
        );
        owner.resume().unwrap();
        assert!(
            owner.enter().is_err(),
            "cannot create new execution beside an unknown original"
        );
        let recovery = owner.enter_presentation().unwrap();
        drop(recovery);
        assert!(
            owner.shutdown().await.is_err(),
            "RAII release must not erase the failure"
        );
    }
}
