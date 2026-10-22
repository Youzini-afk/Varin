//! Parent-Host model codec callbacks, using the existing draining owner transport.
//! Registration is private composition state, never an executor grant or durable record.
use crate::{
    error::KernelError,
    host_query::OwnerChannel,
    protocol_generated::{
        ModelAdaptersPublishParams, ModelAdaptersReleaseParams, ModelAdaptersRetainParams,
        ModelAdaptersRevokeParams,
    },
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
use varin_runtime::{
    composition::BindingId,
    execution::{CancellationToken, ModelFailure},
    providers::{
        extensions::{
            BrokeredModelAdapter, ModelProtocolBridge, ModelProtocolCall, ModelProtocolResult,
        },
        registry::{MODEL_ADAPTER_CONTRACT, ModelAdapter, ModelAdapterMetadata, model_adapters},
    },
};
struct Published {
    id: BindingId,
    descriptor: Value,
    implementation: Weak<dyn ModelAdapter>,
}
#[derive(Default)]
struct Catalog {
    revision: u64,
    published: HashMap<String, Published>,
}
#[derive(Clone)]
pub(crate) struct ModelProtocolOwner {
    channel: OwnerChannel,
    catalog: Arc<Mutex<Catalog>>,
}
impl ModelProtocolOwner {
    pub(crate) fn new(output: impl Into<crate::transport::Sender>) -> Self {
        Self {
            channel: OwnerChannel::new("model-protocol", output),
            catalog: Arc::new(Mutex::new(Catalog::default())),
        }
    }
    pub(crate) fn initialize(&self, epoch: &str) {
        self.channel.initialize(epoch);
    }
    pub(crate) fn receive(&self, value: Value) {
        self.channel.receive(value);
    }
    pub(crate) fn close(&self) {
        self.channel.close();
    }
    pub(crate) fn publish(&self, params: ModelAdaptersPublishParams) -> Result<Value, KernelError> {
        let mut catalog = self
            .catalog
            .lock()
            .map_err(|_| problem("model adapter catalog unavailable"))?;
        if params.expected_revision < 0 || params.expected_revision as u64 != catalog.revision {
            return Err(problem("model adapter revision changed"));
        }
        let revision = catalog
            .revision
            .checked_add(1)
            .ok_or_else(|| problem("model adapter revision exhausted"))?;
        catalog
            .published
            .retain(|_, entry| entry.implementation.strong_count() != 0);
        let mut candidate: Vec<Arc<dyn ModelAdapter>> = Vec::new();
        let mut bindings = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for entry in params.adapters {
            if !seen.insert(entry.binding_id.clone()) {
                return Err(problem("model adapter binding is duplicated"));
            }
            let descriptor = json!({"id":entry.id,"version":entry.version,"protocolFamily":entry.protocol_family,"identity":entry.identity,"headers":entry.headers});
            let adapter: Arc<dyn ModelAdapter> =
                if let Some(existing) = catalog.published.get(&entry.binding_id) {
                    if existing.descriptor != descriptor {
                        return Err(problem("model adapter binding declaration changed"));
                    }
                    existing.implementation.upgrade().ok_or_else(|| {
                        problem("original model adapter implementation was released")
                    })?
                } else {
                    Arc::new(
                        BrokeredModelAdapter::new(
                            ModelAdapterMetadata {
                                id: entry.id.clone(),
                                version: entry.version,
                                protocol_family: entry.protocol_family,
                                contract_version: MODEL_ADAPTER_CONTRACT,
                            },
                            entry.binding_id.clone(),
                            entry.identity,
                            entry.headers,
                            Arc::new(self.clone()),
                        )
                        .map_err(|error| problem(&error.message))?,
                    )
                };
            bindings.push((
                entry.binding_id,
                entry.id,
                descriptor,
                Arc::downgrade(&adapter),
            ));
            candidate.push(adapter);
        }
        let mut registry = model_adapters()
            .write()
            .map_err(|_| problem("model adapter registry unavailable"))?;
        registry
            .publish_extensions(candidate)
            .map_err(|error| problem(&error.message))?;
        for (binding, adapter_id, descriptor, implementation) in bindings {
            let id = registry
                .binding_id(&adapter_id)
                .map_err(|error| problem(&error.message))?;
            catalog.published.insert(
                binding,
                Published {
                    id,
                    descriptor,
                    implementation,
                },
            );
        }
        catalog.revision = revision;
        Ok(json!({"revision":revision}))
    }
    pub(crate) fn retain(&self, params: ModelAdaptersRetainParams) -> Result<Value, KernelError> {
        model_adapters()
            .write()
            .map_err(|_| problem("model adapter registry unavailable"))?
            .retain_binding(&params.binding_id, &params.lease_id)
            .map_err(|error| problem(&error.message))?;
        Ok(json!({"retained":true}))
    }
    pub(crate) fn release(&self, params: ModelAdaptersReleaseParams) -> Result<Value, KernelError> {
        model_adapters()
            .write()
            .map_err(|_| problem("model adapter registry unavailable"))?
            .release_retained(&params.lease_id);
        Ok(json!({"released":true}))
    }
    pub(crate) fn revoke(&self, params: ModelAdaptersRevokeParams) -> Result<Value, KernelError> {
        let catalog = self
            .catalog
            .lock()
            .map_err(|_| problem("model adapter catalog unavailable"))?;
        let revoked = if let Some(entry) = catalog.published.get(&params.binding_id) {
            model_adapters()
                .write()
                .map_err(|_| problem("model adapter registry unavailable"))?
                .revoke_binding(entry.id)
        } else {
            false
        };
        Ok(json!({"revoked":revoked}))
    }
}
fn problem(message: &str) -> KernelError {
    KernelError::Operation(message.into())
}
fn failure(message: impl ToString) -> ModelFailure {
    ModelFailure {
        tool_name: None,
        code: "model_protocol_unavailable".into(),
        message: message.to_string(),
        retry_after_ms: None,
        provider_request_id: None,
    }
}
impl ModelProtocolBridge for ModelProtocolOwner {
    fn invoke(
        &self,
        binding_id: &str,
        call: ModelProtocolCall,
        cancel: &CancellationToken,
    ) -> Result<ModelProtocolResult, ModelFailure> {
        let result = self
            .channel
            .query_draining(json!({"bindingId":binding_id,"call":call}), cancel)
            .map_err(|error| failure(error.message))?;
        if result["ok"] != true {
            return Err(failure("model protocol callback failed"));
        }
        serde_json::from_value(result["value"].clone())
            .map_err(|_| failure("invalid model protocol callback result"))
    }
    fn release(&self, binding_id: &str) {
        self.channel.release_binding(binding_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    #[test]
    fn cancellation_waits_for_original_codec_reply_and_epoch_is_fenced() {
        let (tx, rx) = mpsc::sync_channel(16);
        let owner = ModelProtocolOwner::new(tx);
        owner.initialize("original");
        let call = ModelProtocolCall::Parse {
            request_id: "request".into(),
            run_id: "run".into(),
            connection_identity: "connection".into(),
            frame: Some("data".into()),
            state: Value::Null,
        };
        let cancel = CancellationToken::default();
        let worker_owner = owner.clone();
        let worker_cancel = cancel.clone();
        let (done, result) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            done.send(worker_owner.invoke("pin", call, &worker_cancel))
                .unwrap();
        });
        let request = rx.recv().unwrap();
        assert_eq!(request["kind"], "model-protocol-request");
        assert_eq!(request["query"]["call"]["request_id"], "request");
        cancel.cancel();
        let cancelled = rx.recv().unwrap();
        assert_eq!(cancelled["kind"], "model-protocol-cancel");
        assert!(result.try_recv().is_err());
        owner.receive(json!({"v":1,"kind":"model-protocol-response","id":request["id"],"kernelEpoch":"stale","result":{"ok":true,"value":{"kind":"body","body":{}}}}));
        assert!(result.try_recv().is_err());
        owner.receive(json!({"v":1,"kind":"model-protocol-response","id":request["id"],"kernelEpoch":"original","result":{"ok":true,"value":{"kind":"parsed","events":[],"state":{"received":true},"finish":"stop"}}}));
        assert!(matches!(
            result.recv().unwrap().unwrap(),
            ModelProtocolResult::Parsed {
                finish: Some(varin_runtime::execution::FinishReason::Stop),
                ..
            }
        ));
        worker.join().unwrap();
        ModelProtocolBridge::release(&owner, "pin");
        let released = rx.recv().unwrap();
        assert_eq!(released["kind"], "model-protocol-release");
        assert_eq!(released["bindingId"], "pin");
        owner.close();
    }
    #[test]
    fn complete_candidate_publication_preserves_previous_catalog_on_conflict() {
        let (tx, _rx) = mpsc::sync_channel(32);
        let owner = ModelProtocolOwner::new(tx);
        owner.initialize("catalog");
        let publish = |revision: i64, adapters: Value| {
            serde_json::from_value(json!({"expectedRevision":revision,"adapters":adapters}))
                .unwrap()
        };
        let first = json!([{"id":"test-extension-codec","version":"1","protocolFamily":"test-wire","bindingId":"pin-first","identity":"artifact-first","headers":{}}]);
        assert_eq!(owner.publish(publish(0, first)).unwrap()["revision"], 1);
        assert_eq!(
            model_adapters()
                .read()
                .unwrap()
                .metadata("test-extension-codec")
                .unwrap()
                .protocol_family,
            "test-wire"
        );
        let collision = json!([{"id":"openai-responses","version":"new","protocolFamily":"openai-responses","bindingId":"pin-conflict","identity":"artifact-conflict","headers":{}}]);
        assert!(owner.publish(publish(1, collision)).is_err());
        assert_eq!(
            model_adapters()
                .read()
                .unwrap()
                .metadata("test-extension-codec")
                .unwrap()
                .version,
            "1"
        );
        assert!(owner.publish(publish(0, json!([]))).is_err());
        assert_eq!(
            owner
                .revoke(ModelAdaptersRevokeParams {
                    binding_id: "pin-first".into()
                })
                .unwrap()["revoked"],
            true
        );
        assert!(
            model_adapters()
                .read()
                .unwrap()
                .metadata("test-extension-codec")
                .is_err()
        );
        assert_eq!(owner.publish(publish(1, json!([]))).unwrap()["revision"], 2);
        assert!(
            model_adapters()
                .read()
                .unwrap()
                .metadata("openai-responses")
                .is_ok()
        );
        owner.close();
    }
}
