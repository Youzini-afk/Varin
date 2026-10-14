import { createHash } from 'node:crypto';
import {
  canonicalServiceComposition, parseVarinHostServiceComposition, resolveVarinExtensionServiceRouting,
  type VarinExtensionCatalogEntry, type VarinExtensionCatalogSnapshot, type VarinExtensionServiceRequirement,
  type VarinExtensionServiceRoutingContext, type VarinExtensionServiceRoutingSnapshot,
  type VarinHostCompositionNode, type VarinHostServiceComposition,
} from '@varin/extension-contract';
import { HostServiceBindingError } from './service-registry.js';

export const compositionHash = (value: unknown): string => createHash('sha256').update(canonicalServiceComposition(value)).digest('hex');
export const declaredProviderKey = (extensionId: string, id: string, version: number): string => `${extensionId}:host:${id}@${version}`;
/** A valid lazy declaration lacks artifact identity until its original package owner prepares it. */
export class HostCompositionPreparationRequiredError extends Error {
  readonly code = 'needs_preparation';
  constructor(readonly extensionId: string) {
    super(`Host composition needs artifact preparation: ${extensionId}`);
    this.name = 'HostCompositionPreparationRequiredError';
  }
}
export interface HostCompositionNode {
  entry: VarinExtensionCatalogEntry;
  node: VarinHostCompositionNode;
  dependencies: Array<{ requirement: VarinExtensionServiceRequirement; providers: HostCompositionNode[] }>;
  slot: 'selected' | 'candidate';
}
export interface HostCompositionPlan {
  root: HostCompositionNode;
  composition: VarinHostServiceComposition;
  routingRevision: number;
  scope: VarinExtensionServiceRoutingContext;
}

export function serviceDeclarations(catalog: VarinExtensionCatalogSnapshot, id: string, version: number): VarinExtensionCatalogEntry[] {
  return catalog.extensions.filter(entry => entry.desired.enabled && entry.manifest.entrypoints?.host
    && entry.manifest.provides?.services?.some(service => service.id === id && service.version === version))
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}
export function resolveHostRequirement(catalog: VarinExtensionCatalogSnapshot, routing: VarinExtensionServiceRoutingSnapshot,
  requirement: VarinExtensionServiceRequirement, scope: VarinExtensionServiceRoutingContext): VarinExtensionCatalogEntry[] {
  const candidates = serviceDeclarations(catalog, requirement.id, requirement.version);
  if (requirement.binding === 'all') {
    if (!candidates.length && !requirement.optional) throw new HostServiceBindingError('missing', `Required Host service is unavailable: ${requirement.id}@${requirement.version}`);
    return candidates;
  }
  if (requirement.binding !== 'selected') {
    if (candidates.length === 1 || (!candidates.length && requirement.optional)) return candidates;
    throw new HostServiceBindingError(candidates.length ? 'ambiguous' : 'missing', `Host service must have exactly one implementation: ${requirement.id}@${requirement.version}`);
  }
  const resolution = resolveVarinExtensionServiceRouting({ candidates: candidates.map(entry => ({ providerId: entry.manifest.id,
    providerKey: declaredProviderKey(entry.manifest.id, requirement.id, requirement.version) })), document: routing.document,
    context: scope, serviceId: requirement.id, version: requirement.version });
  if (resolution.status === 'unavailable' && !candidates.length && requirement.optional && !resolution.matchedRule
    && !resolution.diagnostics.some(diagnostic => diagnostic.code.startsWith('service_selection_'))) return [];
  if (resolution.status !== 'resolved' || resolution.providerIds.length !== 1) throw new HostServiceBindingError(
    resolution.status === 'ambiguous' ? 'ambiguous' : 'selected_unavailable', resolution.diagnostics.map(diagnostic => diagnostic.message).join('; '));
  return resolution.providerIds.map(id => candidates.find(entry => entry.manifest.id === id)!);
}

/** Resolve before starting workers. A node depends on chosen implementations, never on a Thread ID. */
export function createHostCompositionPlan(catalog: VarinExtensionCatalogSnapshot, routing: VarinExtensionServiceRoutingSnapshot,
  extensionId: string, scope: VarinExtensionServiceRoutingContext = {}, candidateSelection?: { extensionId: string; integrity: string }): HostCompositionPlan {
  if (!catalog.authoritative || !routing.authoritative) throw new Error('Cannot compose services from stale selection state');
  const memo = new Map<string, HostCompositionNode>();
  const selectedCatalog = candidateSelection ? { ...catalog, extensions: catalog.extensions.map(entry => {
    if (entry.manifest.id !== candidateSelection.extensionId || entry.candidate?.integrity !== candidateSelection.integrity) return entry;
    return { ...entry, manifest: entry.candidate.manifest, integrity: entry.candidate.integrity,
      selectedVersion: entry.candidate.resolvedVersion, capabilityGrants: entry.candidate.capabilityGrants };
  }) } : catalog;
  const stack: string[] = [];
  const visit = (id: string): HostCompositionNode => {
    if (stack.includes(id)) throw new Error(`Host service dependency cycle: ${[...stack, id].join(' -> ')}`);
    const known = memo.get(id); if (known) return known;
    const entry = catalog.extensions.find(entry => entry.manifest.id === id);
    if (!entry?.desired.enabled) throw new HostServiceBindingError('selected_unavailable', `Host extension is unavailable: ${id}`);
    const candidate = id === candidateSelection?.extensionId ? entry.candidate : undefined;
    if (id === candidateSelection?.extensionId && candidate?.integrity !== candidateSelection.integrity) throw new Error(`Host candidate is stale: ${id}`);
    const manifest = candidate?.manifest ?? entry.manifest;
    if (!manifest.entrypoints?.host) throw new HostServiceBindingError('selected_unavailable', `Host extension is unavailable: ${id}`);
    const integrity = candidate?.integrity ?? entry.integrity;
    if (!integrity) throw new HostCompositionPreparationRequiredError(id);
    stack.push(id);
    const dependencies = (manifest.requires?.services ?? []).filter(requirement => requirement.realms.includes('host')).map(requirement => ({ requirement,
      providers: resolveHostRequirement(selectedCatalog, routing, requirement, scope).map(provider => visit(provider.manifest.id)) }));
    stack.pop();
    const body: Omit<VarinHostCompositionNode, 'id'> = {
      extensionId: id, entrypointId: 'host', extensionVersion: manifest.version, artifactIntegrity: integrity,
      activationConfiguration: null,
      grants: (candidate?.capabilityGrants ?? entry.capabilityGrants).filter(grant => grant.realm === 'host' && grant.manifestVersion === manifest.version)
        .map(({ capability, granted }) => ({ capability, granted })).sort((left, right) => left.capability.localeCompare(right.capability)),
      dependencies: dependencies.map(({ requirement, providers }) => ({ id: requirement.id, version: requirement.version,
        binding: requirement.binding ?? 'single', optional: requirement.optional ?? false,
        providers: providers.map(provider => ({ nodeId: provider.node.id, providerKey: declaredProviderKey(provider.node.extensionId, requirement.id, requirement.version) })) })),
    };
    const result = { entry, node: { ...body, id: compositionHash(body) }, dependencies, slot: candidate ? 'candidate' as const : 'selected' as const };
    memo.set(id, result); return result;
  };
  const root = visit(extensionId);
  return { root, composition: { schemaVersion: 1, root: root.node.id, nodes: [...memo.values()].map(value => value.node).sort((a, b) => a.id.localeCompare(b.id)) },
    routingRevision: routing.document.revision, scope: structuredClone(scope) };
}

/** Rehydrate the original choices, not today's routing. Changed grants/artifacts cannot be guessed. */
export function restoreHostCompositionPlan(value: unknown, catalog: VarinExtensionCatalogSnapshot): HostCompositionPlan {
  if (!catalog.authoritative) throw new Error('Cannot restore services from a stale catalog');
  const composition = parseVarinHostServiceComposition(value);
  const definitions = new Map(composition.nodes.map(node => [node.id, node]));
  const memo = new Map<string, HostCompositionNode>();
  const visit = (id: string): HostCompositionNode => {
    const found = memo.get(id); if (found) return found;
    const node = definitions.get(id)!;
    const { id: _id, ...body } = node;
    if (compositionHash(body) !== id) throw new Error('Host composition node identity differs from its contents');
    const entry = catalog.extensions.find(entry => entry.manifest.id === node.extensionId);
    if (!entry?.desired.enabled || !entry.manifest.entrypoints?.host || entry.integrity !== node.artifactIntegrity
      || entry.selectedVersion !== node.extensionVersion) throw new Error(`Frozen Host artifact is unavailable: ${node.extensionId}`);
    const current = entry.capabilityGrants.filter(grant => grant.realm === 'host' && grant.manifestVersion === node.extensionVersion)
      .map(({ capability, granted }) => ({ capability, granted })).sort((a, b) => a.capability.localeCompare(b.capability));
    if (canonicalServiceComposition(current) !== canonicalServiceComposition(node.grants)) throw new Error(`Frozen Host capability review changed: ${node.extensionId}`);
    const declared = (entry.manifest.requires?.services ?? []).filter(requirement => requirement.realms.includes('host'));
    if (declared.length !== node.dependencies.length) throw new Error('Frozen Host dependency declaration changed');
    const dependencies = node.dependencies.map(dependency => {
      const requirement = declared.find(item => item.id === dependency.id && item.version === dependency.version);
      if (!requirement || (requirement.binding ?? 'single') !== dependency.binding || (requirement.optional ?? false) !== dependency.optional) throw new Error('Frozen Host dependency declaration changed');
      return { requirement, providers: dependency.providers.map(provider => visit(provider.nodeId)) };
    });
    const result: HostCompositionNode = { entry, node, dependencies, slot: 'selected' };
    memo.set(id, result); return result;
  };
  return { root: visit(composition.root), composition, routingRevision: -1, scope: {} };
}

export function compositionForNode(root: HostCompositionNode): VarinHostServiceComposition {
  const nodes = new Map<string, VarinHostCompositionNode>();
  const visit = (node: HostCompositionNode): void => { if (nodes.has(node.node.id)) return; nodes.set(node.node.id, node.node); for (const dependency of node.dependencies) for (const provider of dependency.providers) visit(provider); };
  visit(root);
  return { schemaVersion: 1, root: root.node.id, nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
