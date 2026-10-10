//! Selected declarative context transforms. The Host prepares a frozen declaration through its
//! existing extension owner; request compilation invokes this typed handle without RPC.
//! No callback, filesystem, network or model execution belongs to this pure transform contract.
use super::resolver::*;
use super::{CompositionRegistry, ModelStepPins};
use crate::execution::{Content, ConversationItem, Provenance};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

pub const CAPABILITY: &str = "varin.context.fragments";
const BINDING: &str = "context.fragments";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FragmentKind { Instruction, Data }
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextFragment {
    pub name: String,
    pub kind: FragmentKind,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextComposition {
    pub provider_id: String,
    pub content_version: String,
    pub scope_id: String,
    pub selection_revision: u64,
    pub sections: Vec<ContextFragment>,
}
impl ContextComposition {
    pub fn validate(&self) -> Result<(), String> {
        if [&self.provider_id, &self.content_version, &self.scope_id].iter().any(|id| id.trim().is_empty()) {
            return Err("context composition requires exact provider, content and scope identities".into());
        }
        let mut names = BTreeSet::new();
        for section in &self.sections {
            if section.name.trim().is_empty() || !names.insert(&section.name) {
                return Err("context composition section identities must be nonempty and unique".into());
            }
        }
        Ok(())
    }
}
struct FragmentTransform { declaration: ContextComposition }
impl FragmentTransform {
    fn apply(&self, checkpoint: &str) -> Vec<ConversationItem> {
        self.declaration.sections.iter().map(|section| {
            let source = format!("{}:{}:{}:{}", CAPABILITY, self.declaration.provider_id,
                self.declaration.content_version, section.name);
            ConversationItem {
                resource_activation: None,
                id: format!("context:{checkpoint}:fragment:{}", section.name),
                provenance: match section.kind {
                    FragmentKind::Instruction => Provenance::SystemInstruction { source },
                    FragmentKind::Data => Provenance::ExternalData { source },
                },
                content: Content::Text { text: section.content.clone() }, opaque: None,
            }
        }).collect()
    }
}
struct Scope {
    declaration: Option<ContextComposition>,
    registry: CompositionRegistry<FragmentTransform>,
}
/// Ephemeral binding cache, never a second context/configuration writer. Durable checkpoints are
/// authoritative and reconstruct this cache after restart. Only each branch's active binding is
/// retained; a concurrently prepared request holds exactly its own transform pin.
#[derive(Default)]
pub struct ContextCompositions { scopes: Mutex<BTreeMap<String, Scope>> }
pub struct BoundContextFragments { pins: ModelStepPins<FragmentTransform> }
impl ContextCompositions {
    pub fn bind(&self, branch: &str, declaration: Option<&ContextComposition>) -> Result<Option<BoundContextFragments>, String> {
        if let Some(value) = declaration { value.validate()?; }
        let mut scopes = self.scopes.lock().map_err(|_| "context composition owner failed")?;
        let scope = scopes.entry(branch.into()).or_insert_with(|| Scope {
            declaration: None, registry: CompositionRegistry::new(),
        });
        if scope.declaration.as_ref() != declaration {
            let revision = scope.registry.active().revision();
            if let Some(declaration) = declaration {
                let capability = Capability { id: CAPABILITY.into(), version: 1 };
                let selection = ScopedSelection { scope_id: declaration.scope_id.clone(),
                    revision: declaration.selection_revision,
                    selected: BTreeMap::from([(capability.clone(), vec![declaration.provider_id.clone()])]) };
                let preparation = PreparationKey { provider_id: declaration.provider_id.clone(),
                    content_version: declaration.content_version.clone(), instance_key: branch.into(),
                    configuration: serde_json::to_value(declaration).map_err(|e| e.to_string())? };
                let descriptor = ProviderDescriptor { preparation: preparation.clone(),
                    provides: BTreeSet::from([capability.clone()]), requires: vec![] };
                let graph = resolve(&selection, &[descriptor], &[Requirement { binding: BINDING.into(),
                    capability: capability.clone(), cardinality: Cardinality::One, optional: false }]).map_err(|e| e.to_string())?;
                let implementation = Arc::new(FragmentTransform { declaration: declaration.clone() });
                let ready = BTreeMap::from([(declaration.provider_id.clone(), ReadyProvider { preparation,
                    capabilities: BTreeMap::from([(capability, PreparedCapability {
                        schema: serde_json::json!({"contract":CAPABILITY,"version":1,"participation":"transform"}), implementation,
                    })]) })]);
                let candidate = scope.registry.prepare_resolved(revision, &graph, &ready,
                    |_, _| Err(ResolveError::AssemblyMismatch("context fragments requires one provider".into())))
                    .map_err(|e| e.to_string())?;
                scope.registry.publish_resolved(candidate, &selection).map_err(|e| e.to_string())?;
            } else {
                let candidate = scope.registry.prepare(revision, vec![]).map_err(|e| e.to_string())?;
                scope.registry.publish(candidate).map_err(|e| e.to_string())?;
            }
            scope.declaration = declaration.cloned();
        }
        declaration.map(|_| scope.registry.active().pin_model_step([BINDING])
            .map(|pins| BoundContextFragments { pins }).map_err(|e| e.to_string())).transpose()
    }
}
impl BoundContextFragments {
    /// Exact prepared instance identity for inspection; unchanged checkpoint declarations reuse it.
    pub fn binding_id(&self) -> Result<super::BindingId, String> {
        self.pins.begin_call(BINDING).map(|call| call.binding_id()).map_err(|e| e.to_string())
    }
    /// An ordinary replacement cannot retarget a prepared request. The immutable output becomes
    /// part of RequestSnapshot; after application no implementation reference is needed by the model.
    pub fn apply(&self, checkpoint: &str) -> Result<Vec<ConversationItem>, String> {
        let call = self.pins.begin_call(BINDING).map_err(|e| e.to_string())?;
        Ok(call.implementation().map_err(|e| e.to_string())?.apply(checkpoint))
    }
}
