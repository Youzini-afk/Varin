//! Selected immutable context declarations. Host preparation and durable checkpoints are the
//! authorities; these typed transforms neither call extensions nor mutate conversation history.
use super::resolver::*;
use super::{BindingSpec, CompositionRegistry, ModelStepPins};
use crate::execution::{Content, ConversationItem, Provenance};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

pub const CAPABILITY: &str = "varin.context.fragments";
const BINDING: &str = "context.fragments";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FragmentKind {
    Instruction,
    Data,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextFragment {
    pub name: String,
    pub kind: FragmentKind,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextTransform {
    pub provider_id: String,
    pub content_version: String,
    pub sections: Vec<ContextFragment>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextComposition {
    pub scope_id: String,
    pub selection_revision: u64,
    /// Explicit order. An empty collection is an admitted no-contribution selection.
    pub transforms: Vec<ContextTransform>,
}
impl ContextComposition {
    pub fn validate(&self) -> Result<(), String> {
        if self.scope_id.trim().is_empty() {
            return Err("context composition requires exact scope identity".into());
        }
        let mut providers = BTreeSet::new();
        for transform in &self.transforms {
            if transform.provider_id.trim().is_empty()
                || transform.content_version.trim().is_empty()
                || !providers.insert(&transform.provider_id)
            {
                return Err(
                    "context composition requires unique provider and exact content identities"
                        .into(),
                );
            }
            let mut names = BTreeSet::new();
            for section in &transform.sections {
                if section.name.trim().is_empty() || !names.insert(&section.name) {
                    return Err("context composition section identities must be nonempty and unique within their provider".into());
                }
            }
        }
        Ok(())
    }
}
enum FragmentTransform {
    Member(ContextTransform),
    Ordered(Vec<Arc<FragmentTransform>>),
}
impl FragmentTransform {
    fn apply(&self, checkpoint: &str, output: &mut crate::execution::ConversationHistory) {
        match self {
            Self::Ordered(members) => {
                for member in members {
                    member.apply(checkpoint, output);
                }
            }
            Self::Member(declaration) => {
                for section in &declaration.sections {
                    // Encode a tuple rather than delimiter-concatenating opaque names. Two providers
                    // may contribute the same local section name without losing either identity.
                    let identity = serde_json::json!([
                        CAPABILITY,
                        declaration.provider_id,
                        declaration.content_version,
                        section.name
                    ]);
                    let source = identity.to_string();
                    output.push(ConversationItem {
                        resource_activation: None,
                        id: format!("context:{}", serde_json::json!([checkpoint, identity])),
                        provenance: match section.kind {
                            FragmentKind::Instruction => Provenance::SystemInstruction { source },
                            FragmentKind::Data => Provenance::ExternalData { source },
                        },
                        content: Content::Text {
                            text: section.content.clone(),
                        },
                        opaque: None,
                    }.into());
                }
            }
        }
    }
}
struct Scope {
    declaration: Option<ContextComposition>,
    members: BTreeMap<String, Arc<FragmentTransform>>,
    registry: CompositionRegistry<FragmentTransform>,
}
/// Ephemeral binding cache reconstructed from the original checkpoint after recovery. Retained
/// requests pin exactly their composition; replacing one member reuses unchanged member Arcs.
#[derive(Default)]
pub struct ContextCompositions {
    scopes: Mutex<BTreeMap<String, Scope>>,
}
pub struct BoundContextFragments {
    pins: ModelStepPins<FragmentTransform>,
}
impl ContextCompositions {
    pub fn bind(
        &self,
        branch: &str,
        declaration: Option<&ContextComposition>,
    ) -> Result<Option<BoundContextFragments>, String> {
        if let Some(value) = declaration {
            value.validate()?;
        }
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| "context composition owner failed")?;
        let scope = scopes.entry(branch.into()).or_insert_with(|| Scope {
            declaration: None,
            members: BTreeMap::new(),
            registry: CompositionRegistry::new(),
        });
        if scope.declaration.as_ref() != declaration {
            let revision = scope.registry.active().revision();
            let mut members = BTreeMap::new();
            if let Some(declaration) = declaration {
                let capability = Capability {
                    id: CAPABILITY.into(),
                    version: 1,
                };
                let selection = ScopedSelection {
                    scope_id: declaration.scope_id.clone(),
                    revision: declaration.selection_revision,
                    selected: BTreeMap::from([(
                        capability.clone(),
                        declaration
                            .transforms
                            .iter()
                            .map(|member| member.provider_id.clone())
                            .collect(),
                    )]),
                };
                let mut descriptors = Vec::new();
                let mut ready = BTreeMap::new();
                for member in &declaration.transforms {
                    let implementation = scope
                        .members
                        .get(&member.provider_id)
                        .filter(|cached| {
                            matches!(cached.as_ref(),
                        FragmentTransform::Member(previous) if previous == member)
                        })
                        .cloned()
                        .unwrap_or_else(|| Arc::new(FragmentTransform::Member(member.clone())));
                    members.insert(member.provider_id.clone(), implementation.clone());
                    let preparation = PreparationKey {
                        provider_id: member.provider_id.clone(),
                        content_version: member.content_version.clone(),
                        instance_key: branch.into(),
                        configuration: serde_json::json!({"provider": member.provider_id, "content": member.content_version}),
                    };
                    descriptors.push(ProviderDescriptor {
                        preparation: preparation.clone(),
                        provides: BTreeSet::from([capability.clone()]),
                        requires: vec![],
                    });
                    ready.insert(member.provider_id.clone(), ReadyProvider { preparation,
                        capabilities: BTreeMap::from([(capability.clone(), PreparedCapability {
                            schema: serde_json::json!({"contract":CAPABILITY,"version":1,"participation":"transform","composition":"ordered"}), implementation,
                        })]) });
                }
                let graph = resolve(
                    &selection,
                    &descriptors,
                    &[Requirement {
                        binding: BINDING.into(),
                        capability,
                        cardinality: Cardinality::Collection,
                        optional: true,
                    }],
                )
                .map_err(|e| e.to_string())?;
                let candidate = scope.registry.prepare_resolved(revision, &graph, &ready, |root, bindings| {
                    let identity: Vec<_> = bindings.iter().map(|binding| (&binding.capability, &binding.content_version)).collect();
                    Ok(BindingSpec { capability: root.requirement.binding.clone(),
                        content_version: serde_json::to_string(&identity).map_err(|e| ResolveError::AssemblyMismatch(e.to_string()))?,
                        schema: serde_json::json!({"contract": CAPABILITY,"version":1,"composition":"ordered"}),
                        implementation: Arc::new(FragmentTransform::Ordered(bindings.into_iter().map(|binding| binding.implementation).collect())),
                    })
                }).map_err(|e| e.to_string())?;
                scope
                    .registry
                    .publish_resolved(candidate, &selection)
                    .map_err(|e| e.to_string())?;
            } else {
                let candidate = scope
                    .registry
                    .prepare(revision, vec![])
                    .map_err(|e| e.to_string())?;
                scope
                    .registry
                    .publish(candidate)
                    .map_err(|e| e.to_string())?;
            }
            scope.members = members;
            scope.declaration = declaration.cloned();
        }
        if declaration.is_none_or(|value| value.transforms.is_empty()) {
            return Ok(None);
        }
        scope
            .registry
            .active()
            .pin_model_step([BINDING])
            .map(|pins| Some(BoundContextFragments { pins }))
            .map_err(|e| e.to_string())
    }
}
impl BoundContextFragments {
    pub fn binding_id(&self) -> Result<super::BindingId, String> {
        self.pins
            .begin_call(BINDING)
            .map(|call| call.binding_id())
            .map_err(|e| e.to_string())
    }
    /// Once admitted, declaration bytes are context facts. Later Host disable blocks new
    /// preparation; it does not revoke already committed history or retract dispatched requests.
    pub fn apply(&self, checkpoint: &str) -> Result<crate::execution::ConversationHistory, String> {
        let call = self.pins.begin_call(BINDING).map_err(|e| e.to_string())?;
        let mut output = Vec::new();
        call.implementation()
            .map_err(|e| e.to_string())?
            .apply(checkpoint, &mut output);
        Ok(output)
    }
}
