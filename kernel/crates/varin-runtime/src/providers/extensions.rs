//! Brokered protocol implementations use the existing ModelProvider/Operation boundary.
//! Extension code only encodes semantic input and interprets SSE frames. Rust retains the
//! frozen request bytes, dispatch credentials, HTTP cancellation and original usage receipts.
use super::registry::{MODEL_ADAPTER_CONTRACT, ModelAdapter, ModelAdapterMetadata};
use super::*;
use crate::types::ModelSessionConfiguration;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelProtocolCall {
    Serialize {
        configuration: ModelSessionConfiguration,
        request: RequestView,
    },
    Parse {
        request_id: String,
        run_id: String,
        connection_identity: String,
        frame: Option<String>,
        state: Value,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelProtocolResult {
    Body {
        body: Value,
    },
    Parsed {
        events: Vec<ProviderEvent>,
        state: Value,
        finish: Option<FinishReason>,
    },
}
/// The Host implementation invokes the fixed service pin, not a service-name lookup.
/// Cancellation must await the original callback's physical result/drain before returning.
/// `release` retires the Host pin only after the registry and every selected provider drop it.
pub trait ModelProtocolBridge: Send + Sync {
    fn invoke(
        &self,
        binding_id: &str,
        call: ModelProtocolCall,
        cancel: &CancellationToken,
    ) -> Result<ModelProtocolResult, ModelFailure>;
    fn release(&self, binding_id: &str);
}
struct ProtocolBinding {
    id: String,
    bridge: Arc<dyn ModelProtocolBridge>,
}
impl Drop for ProtocolBinding {
    fn drop(&mut self) {
        self.bridge.release(&self.id);
    }
}
pub struct BrokeredModelAdapter {
    metadata: ModelAdapterMetadata,
    content_identity: String,
    headers: BTreeMap<String, String>,
    binding: Arc<ProtocolBinding>,
}
impl BrokeredModelAdapter {
    pub fn new(
        metadata: ModelAdapterMetadata,
        binding_id: String,
        content_identity: String,
        headers: BTreeMap<String, String>,
        bridge: Arc<dyn ModelProtocolBridge>,
    ) -> Result<Self, ExecutionError> {
        if metadata.id.trim().is_empty()
            || metadata.version.trim().is_empty()
            || metadata.protocol_family.trim().is_empty()
            || content_identity.trim().is_empty()
            || binding_id.trim().is_empty()
            || metadata.contract_version != MODEL_ADAPTER_CONTRACT
        {
            return Err(ExecutionError::new(
                "model_adapter_contract",
                "invalid brokered model adapter identity",
            ));
        }
        for (name, value) in &headers {
            let lower = name.to_ascii_lowercase();
            // Credentials are supplied only by the original dispatch credential owner. Framing
            // and request destinations cannot be replaced by a protocol metadata declaration.
            if matches!(
                lower.as_str(),
                "authorization"
                    | "proxy-authorization"
                    | "cookie"
                    | "set-cookie"
                    | "x-api-key"
                    | "api-key"
                    | "x-goog-api-key"
                    | "host"
                    | "content-length"
                    | "transfer-encoding"
            ) || reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err()
                || reqwest::header::HeaderValue::from_str(value).is_err()
            {
                return Err(ExecutionError::new(
                    "model_adapter_header",
                    "invalid model adapter protocol header",
                ));
            }
        }
        Ok(Self {
            metadata,
            content_identity,
            headers,
            binding: Arc::new(ProtocolBinding {
                id: binding_id,
                bridge,
            }),
        })
    }
}
impl ModelAdapter for BrokeredModelAdapter {
    fn metadata(&self) -> &ModelAdapterMetadata {
        &self.metadata
    }
    fn content_identity(&self) -> Option<&str> {
        Some(&self.content_identity)
    }
    fn binding_identity(&self) -> Option<&str> {
        Some(&self.binding.id)
    }
    fn bind(
        &self,
        configuration: &ModelSessionConfiguration,
        connection: Connection,
    ) -> Result<Arc<dyn ModelProvider>, ExecutionError> {
        Ok(Arc::new(BrokeredModelProvider {
            metadata: self.metadata.clone(),
            headers: self.headers.clone(),
            binding: self.binding.clone(),
            configuration: configuration.clone(),
            connection,
        }))
    }
}
struct BrokeredModelProvider {
    metadata: ModelAdapterMetadata,
    headers: BTreeMap<String, String>,
    binding: Arc<ProtocolBinding>,
    configuration: ModelSessionConfiguration,
    connection: Connection,
}
impl BrokeredModelProvider {
    fn invoke(
        &self,
        call: ModelProtocolCall,
        cancel: &CancellationToken,
    ) -> Result<ModelProtocolResult, ModelFailure> {
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "generation cancelled"));
        }
        self.binding.bridge.invoke(&self.binding.id, call, cancel)
    }
    fn parse(
        &self,
        request: &RequestSnapshot,
        frame: Option<String>,
        state: &mut Value,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<Option<FinishReason>, ModelFailure> {
        let result = self.invoke(
            ModelProtocolCall::Parse {
                request_id: request.view.request_id.clone(),
                run_id: request.view.run_id.clone(),
                connection_identity: request.view.binding.connection_identity.clone(),
                frame,
                state: std::mem::take(state),
            },
            cancel,
        )?;
        let ModelProtocolResult::Parsed {
            events,
            state: next,
            finish,
        } = result
        else {
            return Err(failure(
                "model_adapter_result",
                "protocol decoder returned an invalid result",
            ));
        };
        *state = next;
        for event in events {
            if let ProviderEvent::ItemCompleted { item } = &event {
                if let Some(opaque) = &item.opaque {
                    if opaque.family != self.metadata.protocol_family
                        || opaque.adapter_version != self.metadata.version
                        || opaque.connection_identity != request.view.binding.connection_identity
                    {
                        return Err(failure(
                            "model_adapter_continuation",
                            "protocol decoder returned a foreign continuation",
                        ));
                    }
                }
            }
            // A real provider may report usage immediately before cancellation. Preserve those
            // facts in the original request; cancellation is not a synthetic zero receipt.
            emit_event(emit, event)?;
        }
        Ok(finish)
    }
}
impl ModelProvider for BrokeredModelProvider {
    fn serialize(
        &self,
        view: &RequestView,
        reuse: Option<&mut RequestCompileReuse>,
    ) -> Result<RequestBody, ExecutionError> {
        self.serialize_cancellable(view, reuse, &CancellationToken::default())
    }
    fn serialize_cancellable(
        &self,
        view: &RequestView,
        _reuse: Option<&mut RequestCompileReuse>,
        cancel: &CancellationToken,
    ) -> Result<RequestBody, ExecutionError> {
        validate_view(view, &self.metadata.protocol_family)?;
        validate_images(view, &self.connection)?;
        let mut projected = view.clone();
        projected.history = project_history(
            &view.history,
            &self.metadata.protocol_family,
            &view.binding.connection_identity,
        )
        .map(|entry| {
            let mut item = entry.item.as_ref().clone();
            item.opaque = entry
                .opaque
                .filter(|value| value.adapter_version == self.metadata.version)
                .cloned();
            Arc::new(item)
        })
        .filter(|item| !matches!(item.content, Content::ProviderOnly) || item.opaque.is_some())
        .collect();
        let result = self
            .invoke(
                ModelProtocolCall::Serialize {
                    configuration: self.configuration.clone(),
                    request: projected,
                },
                cancel,
            )
            .map_err(|error| ExecutionError::new(error.code, error.message))?;
        if cancel.is_cancelled() {
            return Err(ExecutionError::new(
                "cancelled",
                "model serialization cancelled",
            ));
        }
        match result {
            ModelProtocolResult::Body { body } if body.is_object() => Ok(body.into()),
            _ => Err(ExecutionError::new(
                "model_adapter_result",
                "protocol encoder returned an invalid request body",
            )),
        }
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let mut headers = self
            .connection
            .credentials
            .headers(request.view.binding.credential_ref.as_deref(), cancel)?;
        for (name, value) in &self.headers {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| failure("model_adapter_header", "invalid protocol header"))?,
                reqwest::header::HeaderValue::from_str(value)
                    .map_err(|_| failure("model_adapter_header", "invalid protocol header"))?,
            );
        }
        let mut decoder = sse::Decoder::new(self.connection.max_event_bytes);
        let mut state = Value::Null;
        let mut finish = None;
        self.connection.transport.stream_to_eof(
            HttpRequest {
                endpoint: &self.connection.endpoint,
                headers,
                body: &request.serialized,
            },
            cancel,
            &mut |bytes| {
                decoder.push(bytes, &mut |frame| {
                    finish = self.parse(request, Some(frame.into()), &mut state, cancel, emit)?;
                    Ok(finish.is_some())
                })
            },
        )?;
        if finish.is_none() {
            finish = self.parse(request, None, &mut state, cancel, emit)?;
        }
        finish.ok_or_else(|| {
            failure(
                "incomplete_stream",
                "model stream ended without a protocol completion",
            )
        })
    }
}

#[cfg(test)]
#[path = "extensions_tests.rs"]
mod tests;
