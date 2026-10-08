//! Private Host credential rendezvous. Only metadata is emitted; secret replies are one-shot,
//! epoch-bound in-memory values. The Host retains sole refresh/persistence authority.
use super::{auth::CredentialScope, failure, CredentialResolver, ModelFailure};
use crate::execution::CancellationToken;
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostCredentialRequest {
    pub request_id: String,
    pub epoch: String,
    pub run_id: String,
    pub scope: CredentialScope,
}
struct Pending {
    scope: CredentialScope,
    reply: tokio::sync::oneshot::Sender<Result<HeaderMap, ModelFailure>>,
}
struct Runtime(Option<tokio::runtime::Runtime>);
impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(runtime) = self.0.take() {
            runtime.shutdown_background();
        }
    }
}
type SendRequest = dyn Fn(HostCredentialRequest) -> Result<(), ModelFailure> + Send + Sync;
pub struct HostCredentialChannel {
    epoch: String,
    send: Arc<SendRequest>,
    pending: Mutex<BTreeMap<String, Pending>>,
    closed: AtomicBool,
    runtime: OnceLock<Result<Runtime, ModelFailure>>,
}
impl HostCredentialChannel {
    pub fn new(
        epoch: impl Into<String>,
        send: impl Fn(HostCredentialRequest) -> Result<(), ModelFailure> + Send + Sync + 'static,
    ) -> Result<Arc<Self>, ModelFailure> {
        let epoch = epoch.into();
        if epoch.is_empty() {
            return Err(failure(
                "credential_channel_epoch",
                "credential channel requires the current kernel epoch",
            ));
        }
        Ok(Arc::new(Self {
            epoch,
            send: Arc::new(send),
            pending: Mutex::new(BTreeMap::new()),
            closed: AtomicBool::new(false),
            runtime: OnceLock::new(),
        }))
    }
    pub fn resolver(
        self: &Arc<Self>,
        run_id: impl Into<String>,
        scope: CredentialScope,
    ) -> Result<Arc<dyn CredentialResolver>, ModelFailure> {
        scope
            .validate()
            .map_err(|_| failure("invalid_credential_scope", "credential scope is incomplete"))?;
        if self.closed.load(Ordering::Acquire) {
            return Err(failure(
                "credential_channel_closed",
                "Host credential channel is closed",
            ));
        }
        let run_id = run_id.into();
        if run_id.is_empty() {
            return Err(failure(
                "credential_run_required",
                "credential resolver requires an admitted run identity",
            ));
        }
        Ok(Arc::new(HostCredentialResolver {
            channel: self.clone(),
            run_id,
            scope,
        }))
    }
    /// Must be called only by the authenticated parent Host management channel, never a tool grant.
    /// False means the waiter cancelled or the request was already settled; no secret is retained.
    pub fn reply(
        &self,
        request_id: &str,
        epoch: &str,
        scope: &CredentialScope,
        mut headers: HeaderMap,
    ) -> Result<bool, ModelFailure> {
        if epoch != self.epoch {
            return Err(failure(
                "credential_channel_epoch",
                "credential reply belongs to a different kernel epoch",
            ));
        }
        let pending = self
            .pending
            .lock()
            .map_err(|_| {
                failure(
                    "credential_channel_failed",
                    "credential channel is unavailable",
                )
            })?
            .remove(request_id);
        let Some(pending) = pending else {
            return Ok(false);
        };
        let result = if &pending.scope != scope {
            Err(failure(
                "credential_scope_changed",
                "Host credential account or generation changed",
            ))
        } else {
            for value in headers.values_mut() {
                value.set_sensitive(true);
            }
            Ok(headers)
        };
        let _ = pending.reply.send(result);
        Ok(true)
    }
    /// Deliver only a fixed failure code; raw provider/store error bodies never enter this channel.
    pub fn reject(&self, request_id: &str, epoch: &str) -> Result<bool, ModelFailure> {
        if epoch != self.epoch {
            return Err(failure(
                "credential_channel_epoch",
                "credential reply belongs to a different kernel epoch",
            ));
        }
        let pending = self
            .pending
            .lock()
            .map_err(|_| {
                failure(
                    "credential_channel_failed",
                    "credential channel is unavailable",
                )
            })?
            .remove(request_id);
        if let Some(pending) = pending {
            let _ = pending.reply.send(Err(failure(
                "host_credential_failed",
                "Host credential owner could not resolve the registered credential",
            )));
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Ok(mut pending) = self.pending.lock() {
            for (_, pending) in std::mem::take(&mut *pending) {
                let _ = pending.reply.send(Err(failure(
                    "credential_channel_closed",
                    "Host credential channel closed before resolution",
                )));
            }
        }
    }
    fn resolve(
        &self,
        run_id: &str,
        scope: &CredentialScope,
        cancel: &CancellationToken,
    ) -> Result<HeaderMap, ModelFailure> {
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "credential resolution cancelled"));
        }
        if tokio::runtime::Handle::try_current().is_ok() {
            return Err(failure(
                "worker_required",
                "credential resolution requires a blocking execution worker",
            ));
        }
        let runtime = self
            .runtime
            .get_or_init(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .build()
                    .map(|runtime| Runtime(Some(runtime)))
                    .map_err(|_| {
                        failure(
                            "credential_channel_failed",
                            "credential worker is unavailable",
                        )
                    })
            })
            .as_ref()
            .map_err(Clone::clone)?
            .0
            .as_ref()
            .ok_or_else(|| failure("credential_channel_closed", "credential channel closed"))?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| {
                failure(
                    "credential_channel_failed",
                    "credential channel is unavailable",
                )
            })?;
            if self.closed.load(Ordering::Acquire) {
                return Err(failure(
                    "credential_channel_closed",
                    "Host credential channel is closed",
                ));
            }
            pending.insert(
                request_id.clone(),
                Pending {
                    scope: scope.clone(),
                    reply: tx,
                },
            );
        }
        struct Guard<'a> {
            channel: &'a HostCredentialChannel,
            id: &'a str,
        }
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                if let Ok(mut pending) = self.channel.pending.lock() {
                    pending.remove(self.id);
                }
            }
        }
        let _guard = Guard {
            channel: self,
            id: &request_id,
        };
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "credential resolution cancelled"));
        }
        (self.send)(HostCredentialRequest {
            request_id: request_id.clone(),
            epoch: self.epoch.clone(),
            run_id: run_id.into(),
            scope: scope.clone(),
        })
        .map_err(|_| {
            failure(
                "credential_channel_failed",
                "could not contact Host credential owner",
            )
        })?;
        runtime.block_on(async{tokio::select!{biased;_ = cancel.cancelled()=>Err(failure("cancelled","credential resolution cancelled")),result=rx=>result.map_err(|_|failure("credential_channel_closed","Host credential reply channel closed"))?}})
    }
}
impl Drop for HostCredentialChannel {
    fn drop(&mut self) {
        self.close();
    }
}
struct HostCredentialResolver {
    channel: Arc<HostCredentialChannel>,
    run_id: String,
    scope: CredentialScope,
}
impl CredentialResolver for HostCredentialResolver {
    fn headers(
        &self,
        reference: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<HeaderMap, ModelFailure> {
        if reference != Some(self.scope.reference.as_str()) {
            return Err(failure(
                "unknown_credential_ref",
                "credential reference does not match the registered owner",
            ));
        }
        self.channel.resolve(&self.run_id, &self.scope, cancel)
    }
}
