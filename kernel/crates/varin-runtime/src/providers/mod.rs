//! Native wire adapters. Credentials resolve only at dispatch and never enter RequestSnapshot.
//! HTTP retries and redirects are disabled: an interrupted generation has ambiguous remote cost.
pub mod anthropic;
pub mod auth;
pub mod azure;
pub mod chat;
pub mod codex;
pub mod google;
pub mod host_auth;
pub mod mistral;
pub mod responses;
mod sse;
#[cfg(test)]
mod tests;

use crate::execution::*;
use serde_json::Value;
use std::sync::{Arc, OnceLock};

pub trait CredentialResolver: Send + Sync {
    /// Return dispatch-only headers. Implementations own refresh/single-flight and cancellation.
    fn headers(
        &self,
        credential_ref: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure>;
}
pub struct HttpRequest<'a> {
    pub endpoint: &'a str,
    pub headers: reqwest::header::HeaderMap,
    pub body: &'a Value,
}
pub trait HttpTransport: Send + Sync {
    fn stream(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure>;
    /// Protocols such as GenerateContent terminate the HTTP body after their finish marker.
    /// They must independently reject EOF without that marker.
    fn stream_to_eof(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.stream(request, cancel, receive)
    }
}
/// A single shared outbound policy can supply proxy, custom roots and DNS via ClientBuilder.
/// Must run on a native execution worker, outside an existing Tokio runtime.
pub struct NativeHttpTransport {
    builder: Arc<dyn Fn() -> reqwest::ClientBuilder + Send + Sync>,
    state: OnceLock<Result<TransportState, ModelFailure>>,
}
struct TransportState {
    client: reqwest::Client,
    runtime: tokio::runtime::Runtime,
}
impl Default for NativeHttpTransport {
    fn default() -> Self {
        Self::new(reqwest::Client::builder)
    }
}
impl NativeHttpTransport {
    pub fn new(builder: impl Fn() -> reqwest::ClientBuilder + Send + Sync + 'static) -> Self {
        Self {
            builder: Arc::new(builder),
            state: OnceLock::new(),
        }
    }
}

impl HttpTransport for NativeHttpTransport {
    fn stream(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.stream_internal(request, cancel, receive, false)
    }
    fn stream_to_eof(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.stream_internal(request, cancel, receive, true)
    }
}
impl NativeHttpTransport {
    fn stream_internal(
        &self,
        request: HttpRequest<'_>,
        cancel: &CancellationToken,
        receive: &mut dyn FnMut(&[u8]) -> Result<bool, ModelFailure>,
        allow_eof: bool,
    ) -> Result<(), ModelFailure> {
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "generation cancelled"));
        }
        if tokio::runtime::Handle::try_current().is_ok() {
            return Err(failure(
                "worker_required",
                "native model requests must execute on a blocking worker",
            ));
        }
        // State is scoped to this trusted connection configuration, never a global tenant cache.
        // Separate callers block on their own futures; no request holds an executor-wide mutex.
        let state = self
            .state
            .get_or_init(|| {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .map_err(|_| {
                        failure("transport_setup", "could not create outbound executor")
                    })?;
                let client = {
                    let _entered = runtime.enter();
                    (self.builder)()
                        .redirect(reqwest::redirect::Policy::none())
                        .retry(reqwest::retry::never())
                        .build()
                        .map_err(|_| {
                            failure(
                                "transport_setup",
                                "invalid outbound connection configuration",
                            )
                        })?
                };
                Ok(TransportState { client, runtime })
            })
            .as_ref()
            .map_err(Clone::clone)?;
        state.runtime.block_on(async {
            let client=&state.client;
            let send = client.post(request.endpoint).headers(request.headers)
                .header("accept", "text/event-stream").json(request.body).send();
            let mut response = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(failure("cancelled", "generation cancelled")),
                response = send => response.map_err(|_| failure("transport_error", "model connection failed; no automatic retry"))?,
            };
            let request_id = response.headers().get("x-request-id").or_else(|| response.headers().get("request-id"))
                .and_then(|v| v.to_str().ok()).map(str::to_owned);
            if !response.status().is_success() {
                // Never persist arbitrary error bodies: providers can echo prompt/credentials in them.
                return Err(ModelFailure { code: format!("http_{}", response.status().as_u16()),
                    message: "model endpoint rejected the request".into(),
                    retry_after_ms: response.headers().get("retry-after-ms").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok())
                        .or_else(|| response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).and_then(|s| s.checked_mul(1000))),
                    provider_request_id: request_id });
            }
            if !response.headers().get("content-type").and_then(|v|v.to_str().ok())
                .is_some_and(|v| v.split(';').next().is_some_and(|t|t.trim().eq_ignore_ascii_case("text/event-stream"))) {
                return Err(failure("invalid_content_type", "model endpoint did not return an SSE stream"));
            }
            loop {
                let chunk = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(ModelFailure {
                        provider_request_id: request_id.clone(), ..failure("cancelled", "generation cancelled") }),
                    chunk = response.chunk() => chunk.map_err(|_| ModelFailure {
                        provider_request_id: request_id.clone(), ..failure("stream_interrupted", "model stream interrupted; no automatic retry") })?,
                };
                match chunk {
                    Some(bytes) => {
                        let done=receive(&bytes).map_err(|mut error| {
                            if error.provider_request_id.is_none(){error.provider_request_id=request_id.clone();}
                            error
                        })?;
                        if done{return Ok(());}
                    }
                    None if allow_eof => return Ok(()),
                    None => return Err(ModelFailure {provider_request_id:request_id.clone(),
                        ..failure("stream_interrupted", "model stream ended before a terminal event")})
                }
            }
        })
    }
}
#[derive(Clone)]
pub struct Connection {
    pub endpoint: String,
    pub credentials: Arc<dyn CredentialResolver>,
    pub transport: Arc<dyn HttpTransport>,
    /// Configurable memory budget for an individual SSE event, not total generation size.
    pub max_event_bytes: usize,
}
impl Connection {
    pub fn new(
        endpoint: impl Into<String>,
        credentials: Arc<dyn CredentialResolver>,
        transport: Arc<dyn HttpTransport>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            credentials,
            transport,
            max_event_bytes: 16 * 1024 * 1024,
        }
    }
    pub(super) fn run(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        protocol_headers: &[(&str, &str)],
        event: &mut dyn FnMut(Value) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.run_events(
            request,
            cancel,
            protocol_headers,
            &mut |value| match value {
                Some(value) => event(value),
                None => Ok(false),
            },
        )
    }
    pub(super) fn run_events(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        protocol_headers: &[(&str, &str)],
        event: &mut dyn FnMut(Option<Value>) -> Result<bool, ModelFailure>,
    ) -> Result<(), ModelFailure> {
        self.run_events_mode(request, cancel, protocol_headers, event, false)
    }
    pub(super) fn run_events_mode(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        protocol_headers: &[(&str, &str)],
        event: &mut dyn FnMut(Option<Value>) -> Result<bool, ModelFailure>,
        allow_eof: bool,
    ) -> Result<(), ModelFailure> {
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "generation cancelled"));
        }
        let mut headers = self
            .credentials
            .headers(request.view.binding.credential_ref.as_deref(), cancel)?;
        for (key, value) in protocol_headers {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(key.as_bytes())
                    .map_err(|_| failure("invalid_header", "invalid protocol header"))?,
                reqwest::header::HeaderValue::from_str(value)
                    .map_err(|_| failure("invalid_header", "invalid protocol header"))?,
            );
        }
        let mut decoder = sse::Decoder::new(self.max_event_bytes);
        let stream = if allow_eof {
            HttpTransport::stream_to_eof
        } else {
            HttpTransport::stream
        };
        stream(
            self.transport.as_ref(),
            HttpRequest {
                endpoint: &self.endpoint,
                headers,
                body: &request.serialized,
            },
            cancel,
            &mut |bytes| {
                if cancel.is_cancelled() {
                    return Err(failure("cancelled", "generation cancelled"));
                }
                decoder.push(bytes, &mut |data| {
                    if data == "[DONE]" {
                        return event(None);
                    }
                    let value = serde_json::from_str(data).map_err(|_| {
                        failure("invalid_event_json", "model SSE data is not valid JSON")
                    })?;
                    event(Some(value))
                })
            },
        )?;
        Ok(())
    }
}
pub(super) fn failure(code: &str, message: &str) -> ModelFailure {
    ModelFailure {
        code: code.into(),
        message: message.into(),
        retry_after_ms: None,
        provider_request_id: None,
    }
}
pub(super) fn emit_event(
    emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    event: ProviderEvent,
) -> Result<(), ModelFailure> {
    emit(event).map_err(|e| failure(&e.code, &e.message))
}
pub(super) fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str, ModelFailure> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            failure(
                "invalid_provider_event",
                "provider event lacks a required string",
            )
        })
}
pub(super) fn schema_version(view: &RequestView, name: &str) -> Result<String, ModelFailure> {
    view.binding
        .tools
        .iter()
        .find(|t| t.name == name)
        .map(|t| t.version.clone())
        .ok_or_else(|| {
            failure(
                "unknown_tool_schema",
                "provider called a tool outside the frozen schema",
            )
        })
}
pub(super) fn opaque(view: &RequestView, value: Value) -> Option<OpaqueProviderItem> {
    Some(OpaqueProviderItem {
        family: view.binding.provider_family.clone(),
        connection_identity: view.binding.connection_identity.clone(),
        adapter_version: "1".into(),
        value,
    })
}
pub(super) fn validate_view(view: &RequestView, family: &str) -> Result<(), ExecutionError> {
    if view.binding.provider_family != family {
        return Err(ExecutionError::new(
            "provider_family_mismatch",
            "request does not belong to this adapter",
        ));
    }
    Ok(())
}

/// Error messages are deliberately not copied: remote endpoints may echo sensitive input.
/// Preserve a bounded machine code when it has the protocol's identifier shape.
pub(super) fn provider_failure(error: &Value, fallback: &str) -> ModelFailure {
    let code = error
        .get("code")
        .or_else(|| error.get("type"))
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .unwrap_or(fallback);
    failure(code, "model provider reported a generation error")
}

/// Trusted configuration names environment variables; the model may only select a registered ref.
/// No environment names or credential values are inferred from model text or arbitrary references.
#[derive(Clone)]
pub struct EnvironmentHeader {
    pub variable: String,
    pub header: String,
    pub prefix: String,
}
#[derive(Default)]
pub struct EnvironmentCredentialResolver {
    pub bindings: std::collections::BTreeMap<String, Vec<EnvironmentHeader>>,
    /// Explicitly admitted dispatch headers (including protocol beta/project headers).
    pub headers: reqwest::header::HeaderMap,
    pub allow_anonymous: bool,
}
impl CredentialResolver for EnvironmentCredentialResolver {
    fn headers(
        &self,
        reference: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelFailure> {
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "generation cancelled"));
        }
        let mut headers = self.headers.clone();
        let bindings = match reference {
            Some(reference) => self.bindings.get(reference).ok_or_else(|| {
                failure(
                    "unknown_credential_ref",
                    "credential reference is not registered",
                )
            })?,
            None if self.allow_anonymous => return Ok(headers),
            None => {
                return Err(failure(
                    "credential_required",
                    "this connection requires a credential reference",
                ))
            }
        };
        if bindings.is_empty() {
            return Err(failure(
                "credential_required",
                "credential reference has no header bindings",
            ));
        }
        for binding in bindings {
            if cancel.is_cancelled() {
                return Err(failure("cancelled", "generation cancelled"));
            }
            let secret = std::env::var(&binding.variable).map_err(|_| {
                failure(
                    "credential_unavailable",
                    "registered environment credential is unavailable",
                )
            })?;
            if secret.is_empty() {
                return Err(failure(
                    "credential_unavailable",
                    "registered environment credential is empty",
                ));
            }
            let name = reqwest::header::HeaderName::from_bytes(binding.header.as_bytes()).map_err(
                |_| {
                    failure(
                        "invalid_credential_header",
                        "invalid credential header name",
                    )
                },
            )?;
            let mut value =
                reqwest::header::HeaderValue::from_str(&format!("{}{}", binding.prefix, secret))
                    .map_err(|_| {
                        failure(
                            "invalid_credential_header",
                            "invalid credential header value",
                        )
                    })?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
        Ok(headers)
    }
}

/// Header types for private credential bridges; values remain dispatch-only.
pub use reqwest::header as header_types;
