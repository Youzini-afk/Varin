//! Pure, scope-local dependency resolution over the existing owner's catalog/configuration view.
//! This is not an installer, configuration store, permission grant, or async activation supervisor.
//! Only root-reachable providers enter preparation. Slow preparation runs outside the registry.
use super::{BindingSpec, CompositionError, CompositionPlan, CompositionRegistry, PreparedPlan};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Capability {
    pub id: String,
    pub version: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cardinality {
    One,
    Collection,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    /// Local name used by the consumer; it does not change the public capability identity.
    pub binding: String,
    pub capability: Capability,
    pub cardinality: Cardinality,
    pub optional: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub struct PreparationKey {
    pub provider_id: String,
    pub content_version: String,
    /// Resolved by the environment/resource owner, including credential and SourceView identity
    /// where appropriate. Configuration visibility alone never authorizes resource sharing.
    pub instance_key: String,
    pub configuration: Value,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderDescriptor {
    pub preparation: PreparationKey,
    pub provides: BTreeSet<Capability>,
    pub requires: Vec<Requirement>,
}
/// Selection precedence and equal-priority conflicts are resolved by the existing routing owner.
/// Empty selection means explicitly disabled. Collection order is significant and retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedSelection {
    pub scope_id: String,
    pub revision: u64,
    pub selected: BTreeMap<Capability, Vec<String>>,
}
#[derive(Debug, Clone)]
pub struct ResolvedBinding {
    pub requirement: Requirement,
    pub providers: Vec<String>,
}
#[derive(Debug, Clone)]
pub struct ResolvedProvider {
    pub descriptor: ProviderDescriptor,
    pub dependencies: Vec<ResolvedBinding>,
}
#[derive(Debug, Clone)]
pub struct MissingOptional {
    pub consumer: Option<String>,
    pub binding: String,
    pub capability: Capability,
}
#[derive(Debug, Clone)]
pub struct ResolvedGraph {
    scope: ScopedSelection,
    roots: Vec<ResolvedBinding>,
    nodes: BTreeMap<String, ResolvedProvider>,
    preparation_batches: Vec<Vec<String>>,
    missing_optional: Vec<MissingOptional>,
}
impl ResolvedGraph {
    pub fn scope(&self) -> &ScopedSelection {
        &self.scope
    }
    pub fn roots(&self) -> &[ResolvedBinding] {
        &self.roots
    }
    pub fn providers(&self) -> &BTreeMap<String, ResolvedProvider> {
        &self.nodes
    }
    /// Topological depth groups for inspection, not global wait barriers. Use `preparable` to
    /// release a dependent as soon as its actual prerequisites finish, even if a peer is slow.
    pub fn preparation_batches(&self) -> &[Vec<String>] {
        &self.preparation_batches
    }
    pub fn missing_optional(&self) -> &[MissingOptional] {
        &self.missing_optional
    }
    pub fn preparable<'a>(
        &'a self,
        prepared: &BTreeSet<String>,
        preparing: &BTreeSet<String>,
    ) -> Vec<&'a ResolvedProvider> {
        self.nodes
            .iter()
            .filter(|(id, node)| {
                !prepared.contains(*id)
                    && !preparing.contains(*id)
                    && node
                        .dependencies
                        .iter()
                        .flat_map(|binding| &binding.providers)
                        .all(|id| prepared.contains(id))
            })
            .map(|(_, node)| node)
            .collect()
    }
}

#[derive(Debug, Error)]
pub enum ResolveError {
    #[error("invalid capability/provider/binding identity: {0}")]
    InvalidIdentity(String),
    #[error("duplicate provider identity: {0}")]
    DuplicateProvider(String),
    #[error("duplicate consumer binding: {0}")]
    DuplicateBinding(String),
    #[error("required capability is missing: {0:?}")]
    MissingRequired(Capability),
    #[error("single-provider capability is ambiguous: {0:?}")]
    Ambiguous(Capability),
    #[error("selected provider {provider} does not provide {capability:?}")]
    InvalidSelection {
        provider: String,
        capability: Capability,
    },
    #[error("duplicate provider in selected collection: {0}")]
    DuplicateSelection(String),
    #[error("provider preparation dependency cycle: {0:?}")]
    DependencyCycle(Vec<String>),
    #[error("provider is not ready for this exact preparation identity: {0}")]
    NotReady(String),
    #[error("ready provider {provider} omitted capability {capability:?}")]
    MissingPreparedCapability {
        provider: String,
        capability: Capability,
    },
    #[error("collection assembler returned the wrong local binding: {0}")]
    AssemblyMismatch(String),
    #[error("scope selection changed while the composition was being prepared")]
    ScopeChanged,
    #[error(transparent)]
    Composition(#[from] CompositionError),
}

struct Resolver<'a> {
    scope: &'a ScopedSelection,
    catalog: BTreeMap<String, &'a ProviderDescriptor>,
    available: BTreeMap<Capability, Vec<String>>,
    stack: Vec<String>,
    nodes: BTreeMap<String, ResolvedProvider>,
    depths: BTreeMap<String, usize>,
    missing: Vec<MissingOptional>,
}

pub fn resolve(
    scope: &ScopedSelection,
    catalog: &[ProviderDescriptor],
    roots: &[Requirement],
) -> Result<ResolvedGraph, ResolveError> {
    if scope.scope_id.trim().is_empty() {
        return Err(ResolveError::InvalidIdentity("scope".into()));
    }
    let mut resolver = Resolver {
        scope,
        catalog: BTreeMap::new(),
        available: BTreeMap::new(),
        stack: Vec::new(),
        nodes: BTreeMap::new(),
        depths: BTreeMap::new(),
        missing: Vec::new(),
    };
    for descriptor in catalog {
        let key = &descriptor.preparation;
        if key.provider_id.trim().is_empty()
            || key.content_version.trim().is_empty()
            || key.instance_key.trim().is_empty()
        {
            return Err(ResolveError::InvalidIdentity(key.provider_id.clone()));
        }
        if resolver
            .catalog
            .insert(key.provider_id.clone(), descriptor)
            .is_some()
        {
            return Err(ResolveError::DuplicateProvider(key.provider_id.clone()));
        }
        for capability in &descriptor.provides {
            validate_capability(capability)?;
            resolver
                .available
                .entry(capability.clone())
                .or_default()
                .push(key.provider_id.clone());
        }
    }
    // Unselected collection fallback is deterministic, never installation-order dependent.
    for providers in resolver.available.values_mut() {
        providers.sort();
    }
    let roots = resolver.requirements(None, roots)?;
    let mut batches = Vec::<Vec<String>>::new();
    for (provider, depth) in &resolver.depths {
        batches.resize_with(batches.len().max(depth + 1), Vec::new);
        batches[*depth].push(provider.clone());
    }
    Ok(ResolvedGraph {
        scope: scope.clone(),
        roots,
        nodes: resolver.nodes,
        preparation_batches: batches,
        missing_optional: resolver.missing,
    })
}
fn validate_capability(capability: &Capability) -> Result<(), ResolveError> {
    if capability.id.trim().is_empty() || capability.version == 0 {
        Err(ResolveError::InvalidIdentity(capability.id.clone()))
    } else {
        Ok(())
    }
}
impl Resolver<'_> {
    fn requirements(
        &mut self,
        consumer: Option<&str>,
        requirements: &[Requirement],
    ) -> Result<Vec<ResolvedBinding>, ResolveError> {
        let mut aliases = BTreeSet::new();
        let mut resolved = Vec::new();
        for requirement in requirements {
            validate_capability(&requirement.capability)?;
            if requirement.binding.trim().is_empty() {
                return Err(ResolveError::InvalidIdentity("binding".into()));
            }
            if !aliases.insert(&requirement.binding) {
                return Err(ResolveError::DuplicateBinding(requirement.binding.clone()));
            }
            let providers = self
                .scope
                .selected
                .get(&requirement.capability)
                .cloned()
                .unwrap_or_else(|| {
                    self.available
                        .get(&requirement.capability)
                        .cloned()
                        .unwrap_or_default()
                });
            let mut seen = BTreeSet::new();
            for provider in &providers {
                if !seen.insert(provider) {
                    return Err(ResolveError::DuplicateSelection(provider.clone()));
                }
                if !self
                    .catalog
                    .get(provider)
                    .is_some_and(|descriptor| descriptor.provides.contains(&requirement.capability))
                {
                    return Err(ResolveError::InvalidSelection {
                        provider: provider.clone(),
                        capability: requirement.capability.clone(),
                    });
                }
            }
            if requirement.cardinality == Cardinality::One && providers.len() > 1 {
                return Err(ResolveError::Ambiguous(requirement.capability.clone()));
            }
            if providers.is_empty() {
                if !requirement.optional {
                    return Err(ResolveError::MissingRequired(
                        requirement.capability.clone(),
                    ));
                }
                self.missing.push(MissingOptional {
                    consumer: consumer.map(str::to_owned),
                    binding: requirement.binding.clone(),
                    capability: requirement.capability.clone(),
                });
            }
            for provider in &providers {
                self.visit(provider)?;
            }
            resolved.push(ResolvedBinding {
                requirement: requirement.clone(),
                providers,
            });
        }
        Ok(resolved)
    }
    fn visit(&mut self, provider: &str) -> Result<(), ResolveError> {
        if self.nodes.contains_key(provider) {
            return Ok(());
        }
        if let Some(start) = self.stack.iter().position(|id| id == provider) {
            let mut cycle = self.stack[start..].to_vec();
            cycle.push(provider.into());
            return Err(ResolveError::DependencyCycle(cycle));
        }
        let descriptor = (*self.catalog.get(provider).expect("selection validated")).clone();
        self.stack.push(provider.into());
        let dependencies = self.requirements(Some(provider), &descriptor.requires)?;
        self.stack.pop();
        let depth = dependencies
            .iter()
            .flat_map(|binding| &binding.providers)
            .map(|id| self.depths[id] + 1)
            .max()
            .unwrap_or(0);
        self.depths.insert(provider.into(), depth);
        self.nodes.insert(
            provider.into(),
            ResolvedProvider {
                descriptor,
                dependencies,
            },
        );
        Ok(())
    }
}

pub struct PreparedCapability<T> {
    pub schema: Value,
    pub implementation: Arc<T>,
}
/// Construct only after the owner's asynchronous preparation completes successfully. A shared
/// preparer may reuse this value for the same exact key; cancelling one waiter must not kill it.
pub struct ReadyProvider<T> {
    pub preparation: PreparationKey,
    pub capabilities: BTreeMap<Capability, PreparedCapability<T>>,
}
/// Carries the external routing owner's selection precondition through publication. This does
/// not persist another configuration authority; the owner supplies its current snapshot at commit.
pub struct ResolvedCandidate<T> {
    scope: ScopedSelection,
    plan: PreparedPlan<T>,
}

impl<T> CompositionRegistry<T> {
    /// Assemble ready roots into the existing transactional candidate publication path. Dependency
    /// readiness is checked even when a dependency contributes no root tool. A collection needs an
    /// explicit implementation supplied by its domain owner; it is never silently reduced to one.
    pub fn prepare_resolved<F>(
        &mut self,
        expected_revision: u64,
        graph: &ResolvedGraph,
        ready: &BTreeMap<String, ReadyProvider<T>>,
        mut assemble_collection: F,
    ) -> Result<ResolvedCandidate<T>, ResolveError>
    where
        F: FnMut(&ResolvedBinding, Vec<BindingSpec<T>>) -> Result<BindingSpec<T>, ResolveError>,
    {
        self.check_revision(expected_revision)?;
        for (id, node) in &graph.nodes {
            if !ready
                .get(id)
                .is_some_and(|provider| provider.preparation == node.descriptor.preparation)
            {
                return Err(ResolveError::NotReady(id.clone()));
            }
        }
        let members = |binding: &ResolvedBinding| -> Result<Vec<BindingSpec<T>>, ResolveError> {
            binding
                .providers
                .iter()
                .map(|id| {
                    let provider = ready
                        .get(id)
                        .ok_or_else(|| ResolveError::NotReady(id.clone()))?;
                    let capability = provider
                        .capabilities
                        .get(&binding.requirement.capability)
                        .ok_or_else(|| ResolveError::MissingPreparedCapability {
                            provider: id.clone(),
                            capability: binding.requirement.capability.clone(),
                        })?;
                    Ok(BindingSpec {
                        capability: id.clone(),
                        content_version: provider.preparation.content_version.clone(),
                        schema: capability.schema.clone(),
                        implementation: capability.implementation.clone(),
                    })
                })
                .collect()
        };
        for node in graph.nodes.values() {
            for dependency in &node.dependencies {
                members(dependency)?;
            }
        }
        let mut bindings = Vec::new();
        for root in &graph.roots {
            if root.providers.is_empty() {
                continue;
            }
            let mut selected = members(root)?;
            let binding = match root.requirement.cardinality {
                Cardinality::One => {
                    let mut binding = selected.remove(0);
                    binding.capability = root.requirement.binding.clone();
                    binding
                }
                Cardinality::Collection => assemble_collection(root, selected)?,
            };
            if binding.capability != root.requirement.binding {
                return Err(ResolveError::AssemblyMismatch(binding.capability));
            }
            bindings.push(binding);
        }
        Ok(ResolvedCandidate {
            scope: graph.scope.clone(),
            plan: self.prepare(expected_revision, bindings)?,
        })
    }
    /// The caller obtains current_scope from the existing routing owner at its short publication
    /// boundary. Never hold this boundary across provider preparation or collection construction.
    pub fn publish_resolved(
        &mut self,
        candidate: ResolvedCandidate<T>,
        current_scope: &ScopedSelection,
    ) -> Result<Arc<CompositionPlan<T>>, ResolveError> {
        if &candidate.scope != current_scope {
            return Err(ResolveError::ScopeChanged);
        }
        Ok(self.publish(candidate.plan)?)
    }
}
