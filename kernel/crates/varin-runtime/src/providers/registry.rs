//! Typed adapter selection using the existing composition publication and lease owner.
//! Registration performs no network requests. A binding holds the selected implementation;
//! ordinary replacement drains it, while explicit revocation invalidates dispatch.
use super::*;
use crate::composition::{BindingId, BindingSpec, CallLease, CompositionRegistry};
use crate::types::ModelSessionConfiguration;
use serde::{Deserialize, Serialize};
use std::sync::RwLock;

pub const MODEL_ADAPTER_CONTRACT: u64 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelAdapterMetadata {
    pub id: String,
    pub version: String,
    pub contract_version: u64,
    pub protocol_family: String,
}

/// Extension implementations receive typed runtime services and the frozen configuration.
/// They implement serialization, stream facts, opaque continuation and cancellation through
/// ModelProvider; credentials cannot be obtained from a serialized request snapshot.
pub trait ModelAdapter: Send + Sync {
    fn metadata(&self) -> &ModelAdapterMetadata;
    fn bind(
        &self,
        configuration: &ModelSessionConfiguration,
        connection: Connection,
    ) -> Result<Arc<dyn ModelProvider>, ExecutionError>;
    fn environment_auth(&self) -> Option<(&str, &str)> {
        None
    }
}

pub struct ModelAdapterRegistration(pub Arc<dyn ModelAdapter>);
pub struct ModelAdapterRegistry {
    registry: CompositionRegistry<ModelAdapterRegistration>,
}
impl Default for ModelAdapterRegistry {
    fn default() -> Self {
        Self {
            registry: CompositionRegistry::new(),
        }
    }
}
impl ModelAdapterRegistry {
    pub fn revision(&self) -> u64 {
        self.registry.active().revision()
    }
    /// Caller supplies the complete prepared catalog for this composition scope. Failed
    /// validation/publication preserves the previously selected generation.
    pub fn publish(
        &mut self,
        expected_revision: u64,
        adapters: Vec<Arc<dyn ModelAdapter>>,
    ) -> Result<u64, ExecutionError> {
        let specs = adapters
            .into_iter()
            .map(|adapter| {
                let metadata = adapter.metadata();
                if metadata.contract_version != MODEL_ADAPTER_CONTRACT
                    || metadata.protocol_family.is_empty()
                {
                    return Err(ExecutionError::new(
                        "model_adapter_contract",
                        "model adapter contract version is unavailable",
                    ));
                }
                Ok(BindingSpec {
                    capability: metadata.id.clone(),
                    content_version: metadata.version.clone(),
                    schema: serde_json::to_value(metadata).expect("adapter metadata"),
                    implementation: Arc::new(ModelAdapterRegistration(adapter)),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let candidate = self
            .registry
            .prepare(expected_revision, specs)
            .map_err(composition_error)?;
        Ok(self
            .registry
            .publish(candidate)
            .map_err(composition_error)?
            .revision())
    }
    pub fn revoke(&mut self, adapter_id: &str) -> Result<(), ExecutionError> {
        let id = self
            .registry
            .active()
            .bind(adapter_id)
            .map_err(composition_error)?
            .id();
        self.registry.revoke(id);
        Ok(())
    }
    pub fn revoke_binding(&mut self, id: BindingId) -> bool {
        self.registry.revoke(id)
    }
    pub fn metadata(&self, id: &str) -> Result<ModelAdapterMetadata, ExecutionError> {
        let handle = self.registry.active().bind(id).map_err(|_| {
            ExecutionError::new(
                "unsupported_provider",
                "selected model adapter is unavailable",
            )
        })?;
        let lease = handle.begin_call().map_err(composition_error)?;
        Ok(lease
            .implementation()
            .map_err(composition_error)?
            .0
            .metadata()
            .clone())
    }
    pub fn environment_auth(&self, id: &str) -> Result<Option<(String, String)>, ExecutionError> {
        let handle = self.registry.active().bind(id).map_err(composition_error)?;
        let lease = handle.begin_call().map_err(composition_error)?;
        Ok(lease
            .implementation()
            .map_err(composition_error)?
            .0
            .environment_auth()
            .map(|(h, p)| (h.into(), p.into())))
    }
    pub fn select(
        &self,
        configuration: &ModelSessionConfiguration,
    ) -> Result<SelectedAdapter, ExecutionError> {
        let id = configuration
            .adapter_id
            .as_deref()
            .unwrap_or(&configuration.provider_family);
        let plan = self.registry.active();
        let pins = plan.pin_model_step([id]).map_err(composition_error)?;
        let lease = pins.begin_call(id).map_err(composition_error)?;
        let adapter = &lease.implementation().map_err(composition_error)?.0;
        let metadata = adapter.metadata();
        if metadata.protocol_family != configuration.provider_family
            || configuration
                .adapter_version
                .as_deref()
                .is_some_and(|version| version != metadata.version)
        {
            return Err(ExecutionError::new(
                "model_adapter_selection_changed",
                "selected model adapter identity/version changed",
            ));
        }
        Ok(SelectedAdapter { lease })
    }
}
/// Selection retains the implementation; extension factories run after releasing the registry lock.
pub struct SelectedAdapter {
    lease: CallLease<ModelAdapterRegistration>,
}
impl SelectedAdapter {
    pub fn binding_id(&self) -> BindingId {
        self.lease.binding_id()
    }
    pub fn bind(
        self,
        configuration: &ModelSessionConfiguration,
        connection: Connection,
    ) -> Result<Arc<dyn ModelProvider>, ExecutionError> {
        let inner = self
            .lease
            .implementation()
            .map_err(composition_error)?
            .0
            .bind(configuration, connection)?;
        self.lease.validate().map_err(composition_error)?;
        Ok(Arc::new(PinnedProvider {
            lease: self.lease,
            inner,
        }))
    }
}
fn composition_error(error: crate::composition::CompositionError) -> ExecutionError {
    ExecutionError::new("model_adapter_binding", error.to_string())
}
struct PinnedProvider {
    lease: CallLease<ModelAdapterRegistration>,
    inner: Arc<dyn ModelProvider>,
}
impl ModelProvider for PinnedProvider {
    fn serialize(&self, view: &RequestView) -> Result<Value, ExecutionError> {
        self.lease.validate().map_err(composition_error)?;
        self.inner.serialize(view)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        let token = cancel.child("model-adapter");
        let _watch = self.lease.watch_revocation(&token);
        self.lease
            .validate()
            .map_err(|e| failure("model_adapter_revoked", &e.to_string()))?;
        self.inner.generate(request, &token, emit)
    }
}

/// The production binding path and native extension integrations share this catalog. Each
/// Host process owns its own registry; accounts share no adapter credential state.
pub fn model_adapters() -> &'static RwLock<ModelAdapterRegistry> {
    static REGISTRY: OnceLock<RwLock<ModelAdapterRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut registry = ModelAdapterRegistry::default();
        registry
            .publish(0, super::builtins::adapters())
            .expect("builtin model adapters");
        RwLock::new(registry)
    })
}

pub fn selected_metadata(
    configuration: &ModelSessionConfiguration,
) -> Result<ModelAdapterMetadata, ExecutionError> {
    model_adapters()
        .read()
        .map_err(|_| {
            ExecutionError::new(
                "model_adapter_registry",
                "model adapter registry unavailable",
            )
        })?
        .metadata(
            configuration
                .adapter_id
                .as_deref()
                .unwrap_or(&configuration.provider_family),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;
    struct Adapter {
        metadata: ModelAdapterMetadata,
        entered: mpsc::Sender<()>,
        value: &'static str,
    }
    impl ModelAdapter for Adapter {
        fn metadata(&self) -> &ModelAdapterMetadata {
            &self.metadata
        }
        fn bind(
            &self,
            _: &ModelSessionConfiguration,
            _: Connection,
        ) -> Result<Arc<dyn ModelProvider>, ExecutionError> {
            Ok(Arc::new(Provider {
                entered: self.entered.clone(),
                value: self.value,
            }))
        }
    }
    struct Provider {
        entered: mpsc::Sender<()>,
        value: &'static str,
    }
    impl ModelProvider for Provider {
        fn serialize(&self, _: &RequestView) -> Result<Value, ExecutionError> {
            Ok(json!({"implementation":self.value}))
        }
        fn generate(
            &self,
            _: &RequestSnapshot,
            cancel: &CancellationToken,
            _: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
        ) -> Result<FinishReason, ModelFailure> {
            let (wake, wait) = mpsc::sync_channel(1);
            let _registration = cancel.wake_on_cancel(wake);
            self.entered.send(()).unwrap();
            wait.recv_timeout(std::time::Duration::from_secs(5))
                .expect("revocation must wake active generation");
            assert!(cancel.is_cancelled());
            Err(failure("cancelled", "generation cancelled"))
        }
    }
    #[test]
    fn replaced_adapter_is_retained_but_explicit_revocation_cancels_its_generation() {
        let (entered, wait) = mpsc::channel();
        let adapter = |version: &str, value| {
            Arc::new(Adapter {
                metadata: ModelAdapterMetadata {
                    id: "test".into(),
                    version: version.into(),
                    contract_version: MODEL_ADAPTER_CONTRACT,
                    protocol_family: "test".into(),
                },
                entered: entered.clone(),
                value,
            }) as Arc<dyn ModelAdapter>
        };
        let config: ModelSessionConfiguration = serde_json::from_value(json!({"providerFamily":"test","model":"fixture","endpoint":"https://fixture.invalid",
            "credentialEnvironment":null,"allowAnonymous":true,"configurationGeneration":1,"maxOutputTokens":null})).unwrap();
        let mut registry = ModelAdapterRegistry::default();
        registry.publish(0, vec![adapter("1", "old")]).unwrap();
        let selected = registry.select(&config).unwrap();
        let id = selected.binding_id();
        let connection = || {
            Connection::new(
                "https://fixture.invalid",
                Arc::new(EnvironmentCredentialResolver::default()),
                shared_transport(),
            )
        };
        registry.publish(1, vec![adapter("2", "new")]).unwrap();
        let provider = selected.bind(&config, connection()).unwrap();
        let view = RequestView {
            request_id: "request".into(),
            run_id: "run".into(),
            origin: RequestOrigin::Conversation {
                step: 1,
                history_range: HistoryRange {
                    branch_id: "branch".into(),
                    ancestor_id: None,
                    leaf_id: None,
                },
            },
            binding: crate::model_session::build_provider(
                {
                    let mut c = config.clone();
                    c.provider_family = responses::FAMILY.into();
                    c
                },
                Arc::new(EnvironmentCredentialResolver::default()),
                None,
                "fixture".into(),
            )
            .unwrap()
            .binding,
            history: vec![],
        };
        assert_eq!(provider.serialize(&view).unwrap()["implementation"], "old");
        let current = registry
            .select(&config)
            .unwrap()
            .bind(&config, connection())
            .unwrap();
        assert_eq!(current.serialize(&view).unwrap()["implementation"], "new");
        let snapshot = RequestSnapshot {
            serialized: provider.serialize(&view).unwrap(),
            view: view.clone(),
        };
        let worker = std::thread::spawn(move || {
            provider.generate(&snapshot, &CancellationToken::default(), &mut |_| Ok(()))
        });
        wait.recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(registry.revoke_binding(id));
        assert_eq!(worker.join().unwrap().unwrap_err().code, "cancelled");
        assert!(current.serialize(&view).is_ok());
    }
}
