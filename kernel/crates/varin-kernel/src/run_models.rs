//! Selected model preparation is independent; only the Run worker activates a ready candidate.
use crate::{credential_bridge::CredentialBridge, error::KernelError};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    thread,
};
use varin_runtime::{
    catalog::models::{RunModelSelection, RunModelSelectionStatus, RunModelSelections},
    execution::*,
    model_session, Catalog,
};

#[derive(Default)]
struct Candidate {
    id: String,
    preparing: bool,
    prepared: Option<SelectedModel>,
    failure: Option<ExecutionError>,
}
#[derive(Default)]
struct Slot {
    candidate: Mutex<Candidate>,
    changed: tokio::sync::Notify,
}
enum SelectionRead {
    Current(Option<SelectedModel>),
    Preparing,
}
pub(crate) struct RunModels {
    catalog: Arc<Mutex<Catalog>>,
    credentials: CredentialBridge,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}
fn failed(error: impl ToString) -> ExecutionError {
    ExecutionError::new("model_selection", error.to_string())
}
impl RunModels {
    pub fn new(catalog: Arc<Mutex<Catalog>>, credentials: CredentialBridge) -> Arc<Self> {
        Arc::new(Self {
            catalog,
            credentials,
            slots: Mutex::new(HashMap::new()),
        })
    }
    fn slot(&self, run_id: &str) -> Result<Arc<Slot>, ExecutionError> {
        Ok(self
            .slots
            .lock()
            .map_err(failed)?
            .entry(run_id.into())
            .or_default()
            .clone())
    }
    pub fn inspect(&self, run_id: &str) -> Result<RunModelSelections, KernelError> {
        self.catalog
            .lock()
            .map_err(|_| KernelError::Storage("catalog owner failed".into()))?
            .model_selections(run_id)
            .map_err(crate::agent_runtime::domain)
    }
    pub fn prepare(self: &Arc<Self>, selection: RunModelSelection) -> Result<(), ExecutionError> {
        if selection.status == RunModelSelectionStatus::Failed
            || selection.status == RunModelSelectionStatus::Superseded
        {
            return Ok(());
        }
        let slot = self.slot(&selection.run_id)?;
        {
            let mut candidate = slot.candidate.lock().map_err(failed)?;
            if candidate.id == selection.id
                && (candidate.preparing
                    || candidate.prepared.is_some()
                    || candidate.failure.is_some())
            {
                return Ok(());
            }
            *candidate = Candidate {
                id: selection.id.clone(),
                preparing: true,
                prepared: None,
                failure: None,
            };
        }
        let owner = self.clone();
        let worker_selection = selection.clone();
        let worker_slot = slot.clone();
        let spawned = thread::Builder::new()
            .name(format!("model-{}", selection.id))
            .spawn(move || {
                let selection = worker_selection;
                let slot = worker_slot;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    owner.bind(&selection)
                }))
                .unwrap_or_else(|_| {
                    Err(ExecutionError::new(
                        "model_adapter_panicked",
                        "Selected model adapter failed during preparation",
                    ))
                });
                let commit = (|| -> Result<(), ExecutionError> {
                    let mut candidate = slot.candidate.lock().map_err(failed)?;
                    if candidate.id != selection.id {
                        return Ok(());
                    }
                    let mut catalog = owner.catalog.lock().map_err(failed)?;
                    let epoch = catalog.epoch();
                    if catalog
                        .prepare_model_selection(
                            &selection,
                            epoch,
                            result.as_ref().err().map(|error| error.code.clone()),
                        )
                        .map_err(failed)?
                    {
                        candidate.prepared = result.as_ref().ok().cloned();
                        candidate.failure = result.err();
                    }
                    candidate.preparing = false;
                    Ok(())
                })();
                // A failed durable publication is not a usable model. The waiting Run observes
                // its own cancellation/epoch or the preparation failure, never an old fallback.
                if let Err(error) = commit {
                    if let Ok(mut candidate) = slot.candidate.lock() {
                        if candidate.id == selection.id {
                            candidate.preparing = false;
                            candidate.prepared = None;
                            candidate.failure = Some(error);
                        }
                    }
                }
                slot.changed.notify_waiters();
            });
        if let Err(error) = spawned {
            let error = failed(error);
            {
                let mut candidate = slot.candidate.lock().map_err(failed)?;
                if candidate.id == selection.id {
                    candidate.preparing = false;
                    candidate.failure = Some(error.clone());
                }
            }
            let mut catalog = self.catalog.lock().map_err(failed)?;
            let epoch = catalog.epoch();
            catalog
                .prepare_model_selection(
                    &selection,
                    epoch,
                    Some("model_preparation_unavailable".into()),
                )
                .map_err(failed)?;
            slot.changed.notify_waiters();
            return Err(error);
        }
        Ok(())
    }
    fn bind(&self, selection: &RunModelSelection) -> Result<SelectedModel, ExecutionError> {
        let bound = if let Some(scope) = &selection.credential_scope {
            let resolver = self
                .credentials
                .resolver_for_binding(&selection.run_id, &selection.binding_id, scope.clone())
                .map_err(|_| {
                    ExecutionError::new(
                        "credential_owner_unavailable",
                        "Selected model credential owner is unavailable",
                    )
                })?;
            model_session::bind_provider_with_credentials(
                selection.configuration.clone(),
                resolver,
                scope.clone(),
            )?
        } else {
            let start = model_session::bind(selection.configuration.clone())?;
            model_session::BoundModel {
                binding: start.binding,
                provider: start.provider,
            }
        };
        Ok(SelectedModel {
            binding: bound.binding,
            provider: bound.provider,
        })
    }
    fn select(
        self: &Arc<Self>,
        run_id: &str,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<Option<SelectedModel>, ExecutionError> {
        let slot = self.slot(run_id)?;
        if let SelectionRead::Current(selected) = self.try_select(run_id, epoch, cancel, &slot)? {
            return Ok(selected);
        }
        // Already-ready choices take the synchronous path. Only an actual preparation wait
        // needs an executor, and it owns no Catalog/model registry lock while suspended.
        let executor = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(failed)?;
        executor.block_on(async {
            loop {
                let changed = slot.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let SelectionRead::Current(selected) =
                    self.try_select(run_id, epoch, cancel, &slot)?
                {
                    return Ok(selected);
                }
                tokio::select! { _=changed.as_mut()=>{},_=cancel.cancelled()=>{} }
            }
        })
    }
    fn try_select(
        self: &Arc<Self>,
        run_id: &str,
        epoch: u64,
        cancel: &CancellationToken,
        slot: &Slot,
    ) -> Result<SelectionRead, ExecutionError> {
        loop {
            if cancel.is_cancelled() {
                return Err(ExecutionError::new(
                    "cancelled",
                    "Model selection cancelled",
                ));
            }
            let desired = self
                .catalog
                .lock()
                .map_err(failed)?
                .model_selections(run_id)
                .map_err(failed)?
                .desired;
            let Some(desired) = desired else {
                return Ok(SelectionRead::Current(None));
            };
            if let Some(code) = &desired.failure {
                return Err(ExecutionError::new(
                    code,
                    "Selected model preparation failed",
                ));
            }
            self.prepare(desired.clone())?;
            let candidate = slot.candidate.lock().map_err(failed)?;
            if candidate.id != desired.id {
                continue;
            }
            if let Some(error) = &candidate.failure {
                return Err(error.clone());
            }
            if let Some(prepared) = &candidate.prepared {
                if self
                    .catalog
                    .lock()
                    .map_err(failed)?
                    .activate_model_selection(&desired, epoch, &prepared.binding)
                    .map_err(failed)?
                {
                    return Ok(SelectionRead::Current(Some(prepared.clone())));
                }
                continue;
            }
            if !candidate.preparing {
                return Err(ExecutionError::new(
                    "model_preparation_unavailable",
                    "Selected model preparation did not publish a usable binding",
                ));
            }
            return Ok(SelectionRead::Preparing);
        }
    }
    pub fn wrap(self: &Arc<Self>, primary: Arc<dyn ModelProvider>) -> Arc<dyn ModelProvider> {
        Arc::new(SelectedProvider {
            owner: self.clone(),
            primary,
        })
    }
    pub fn release(&self, run_id: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.remove(run_id);
        }
    }
}
struct SelectedProvider {
    owner: Arc<RunModels>,
    primary: Arc<dyn ModelProvider>,
}
impl ModelProvider for SelectedProvider {
    fn select_for_request(
        &self,
        run_id: &str,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<Option<SelectedModel>, ExecutionError> {
        self.owner.select(run_id, epoch, cancel)
    }
    fn serialize(&self, view: &RequestView) -> Result<serde_json::Value, ExecutionError> {
        self.primary.serialize(view)
    }
    fn generate(
        &self,
        request: &RequestSnapshot,
        cancel: &CancellationToken,
        emit: &mut dyn FnMut(ProviderEvent) -> Result<(), ExecutionError>,
    ) -> Result<FinishReason, ModelFailure> {
        self.primary.generate(request, cancel, emit)
    }
    fn policy_model_capabilities(&self) -> Vec<PolicyModelCapability> {
        self.primary.policy_model_capabilities()
    }
    fn policy_model_capability(&self, id: &str) -> Option<BoundPolicyModel> {
        self.primary.policy_model_capability(id)
    }
}
