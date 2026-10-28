//! A checkpoint requested by the mount worker and selected by the filesystem's
//! post-writeback callback. No control/Storage lock is held across OS cache I/O.
use super::*;
use crate::storage::workspace_session::{Checkpoint, Session};
use std::sync::{Mutex, MutexGuard};

struct Pending {
    selected: String,
    origin: u32,
    result: Option<Result<Checkpoint, KernelError>>,
}
#[derive(Default)]
pub(super) struct CacheFence {
    serial: Mutex<()>,
    pending: Mutex<Option<Pending>>,
}
impl CacheFence {
    pub(super) fn synchronize(&self, session: &Session, origin: u32) -> Result<(), KernelError> {
        let synced = session.flush_all();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| unsupported("Native cache boundary lock failed"))?;
        let result = synced.and_then(|_| {
            pending
                .as_ref()
                .filter(|request| request.origin == origin && request.result.is_none())
                .map(|request| session.checkpoint_native(&request.selected, &[], &[]))
                .transpose()
        });
        match result {
            Ok(snapshot) => {
                if let (Some(request), Some(snapshot)) = (pending.as_mut(), snapshot) {
                    request.result = Some(Ok(snapshot));
                }
                Ok(())
            }
            Err(error) => {
                let failure = varin_runtime::execution::ExecutionError::from(error);
                if let Some(request) = pending
                    .as_mut()
                    .filter(|request| request.origin == origin && request.result.is_none())
                {
                    request.result = Some(Err(KernelError::Execution(failure.clone())));
                }
                Err(KernelError::Execution(failure))
            }
        }
    }
    pub(super) fn request(&self, selected: &str, origin: u32) -> Result<Request<'_>, KernelError> {
        let serial = self
            .serial
            .lock()
            .map_err(|_| unsupported("Native cache boundary lock failed"))?;
        *self
            .pending
            .lock()
            .map_err(|_| unsupported("Native cache boundary lock failed"))? = Some(Pending {
            selected: selected.into(),
            origin,
            result: None,
        });
        Ok(Request {
            fence: self,
            _serial: serial,
        })
    }
}
pub(super) struct Request<'a> {
    fence: &'a CacheFence,
    _serial: MutexGuard<'a, ()>,
}
impl Request<'_> {
    pub(super) fn finish(
        self,
        synchronized: std::io::Result<()>,
    ) -> Result<Checkpoint, KernelError> {
        let snapshot = self
            .fence
            .pending
            .lock()
            .map_err(|_| unsupported("Native cache boundary lock failed"))?
            .take()
            .and_then(|request| request.result);
        if let Some(Err(error)) = snapshot {
            return Err(error);
        }
        synchronized.map_err(|error| {
            KernelError::Execution(
                varin_runtime::execution::ExecutionError::new(
                    "workspace_cache_sync_failed",
                    format!("Native cache synchronization failed: {error}"),
                )
                .with_details(
                    serde_json::json!({"stage":"workspace_cache_sync","parentAvailable":true}),
                ),
            )
        })?;
        match snapshot {
            Some(Ok(snapshot)) => Ok(snapshot),
            _ => Err(KernelError::Execution(
                varin_runtime::execution::ExecutionError::new(
                    "workspace_cache_fence_unavailable",
                    "The backend did not acknowledge a post-writeback filesystem boundary",
                )
                .with_details(
                    serde_json::json!({"stage":"workspace_cache_sync","parentAvailable":true}),
                ),
            )),
        }
    }
}
impl Drop for Request<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.fence.pending.lock() {
            pending.take();
        }
    }
}
