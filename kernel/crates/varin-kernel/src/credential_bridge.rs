//! Private parent-Host credential replies bypass all public methods and durable queues.
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::{
    execution::ModelFailure,
    providers::{auth::CredentialScope, host_auth::HostCredentialChannel, CredentialResolver},
};

#[derive(Clone)]
pub(crate) struct CredentialBridge {
    channel: Arc<Mutex<Option<Arc<HostCredentialChannel>>>>,
    events: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
}
impl CredentialBridge {
    pub(crate) fn new(output: mpsc::SyncSender<Value>) -> Self {
        let (events, rx) = mpsc::channel();
        // Never hold credential/model locks while waiting for the shared stdout writer.
        std::thread::spawn(move || {
            for value in rx {
                if output.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            channel: Arc::new(Mutex::new(None)),
            events: Arc::new(Mutex::new(Some(events))),
        }
    }
    pub(crate) fn initialize(&self, epoch: &str) -> Result<(), ModelFailure> {
        let events = self.events.clone();
        let next = HostCredentialChannel::new(epoch, move |request| {
            events.lock().map_err(|_|failed("credential_channel_failed"))?.as_ref().ok_or_else(||failed("credential_channel_closed"))?.send(json!({"v":1,"kind":"credential-request","id":request.request_id,"kernelEpoch":request.epoch,"runId":request.run_id,"scope":request.scope,"dispatch":request.dispatch}))
                .map_err(|_|failed("credential_channel_closed"))
        })?;
        let mut current = self
            .channel
            .lock()
            .map_err(|_| failed("credential_channel_failed"))?;
        if let Some(old) = current.replace(next) {
            old.close();
        }
        Ok(())
    }
    pub(crate) fn resolver(
        &self,
        run_id: &str,
        scope: CredentialScope,
    ) -> Result<Arc<dyn CredentialResolver>, ModelFailure> {
        self.channel
            .lock()
            .map_err(|_| failed("credential_channel_failed"))?
            .as_ref()
            .ok_or_else(|| failed("credential_channel_uninitialized"))?
            .resolver(run_id, scope)
    }
    /// Malformed/stale replies are deliberately discarded without echoing payloads or raw errors.
    pub(crate) fn receive(&self, value: Value) {
        let Ok(reply) = serde_json::from_value::<Reply>(value) else {
            return;
        };
        if reply.v != 1 || reply.kind != "credential-response" || reply.id.is_empty() {
            return;
        }
        let Ok(current) = self.channel.lock() else {
            return;
        };
        let Some(channel) = current.as_ref().cloned() else {
            return;
        };
        drop(current);
        if !reply.ok {
            if reply.result.is_none() && reply.error.is_some() {
                let _ = channel.reject(&reply.id, &reply.kernel_epoch);
            }
            return;
        }
        if reply.error.is_some() {
            return;
        }
        let Some(result) = reply.result else {
            return;
        };
        let mut headers = reqwest_headers::HeaderMap::new();
        for header in result.headers {
            let Ok(name) = reqwest_headers::HeaderName::from_bytes(header.name.as_bytes()) else {
                let _ = channel.reject(&reply.id, &reply.kernel_epoch);
                return;
            };
            let Ok(mut value) = reqwest_headers::HeaderValue::from_str(&header.value) else {
                let _ = channel.reject(&reply.id, &reply.kernel_epoch);
                return;
            };
            value.set_sensitive(true);
            if headers.insert(name, value).is_some() {
                let _ = channel.reject(&reply.id, &reply.kernel_epoch);
                return;
            }
        }
        let _ = channel.reply(&reply.id, &reply.kernel_epoch, &result.scope, headers);
    }
    pub(crate) fn close(&self) {
        if let Ok(mut events) = self.events.lock() {
            events.take();
        }
        if let Ok(mut current) = self.channel.lock() {
            if let Some(channel) = current.take() {
                channel.close();
            }
        }
    }
}
fn failed(code: &str) -> ModelFailure {
    ModelFailure {
        code: code.into(),
        message: "private Host credential channel unavailable".into(),
        retry_after_ms: None,
        provider_request_id: None,
    }
}
// These types are private transport data, never public method DTOs or catalog serialization.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reply {
    v: u64,
    kind: String,
    id: String,
    kernel_epoch: String,
    ok: bool,
    result: Option<Resolved>,
    error: Option<ErrorMarker>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolved {
    scope: CredentialScope,
    headers: Vec<Header>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    name: String,
    value: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorMarker {
    #[serde(rename = "code")]
    _code: String,
    #[serde(rename = "message")]
    _message: String,
}
// Re-exported header types avoid giving the kernel a second HTTP client dependency.
use varin_runtime::providers::header_types as reqwest_headers;
