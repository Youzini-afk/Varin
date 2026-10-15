import { isDeepStrictEqual } from 'node:util';
import type { HostServiceOwnerIdentity } from './service-registry.js';
import { createHostCompositionPlan } from './service-composition.js';
import {
  parseVarinRuntimeContractRequest,
  resolveVarinExtensionServiceRouting, resolveVarinWorkbenchProfile, serviceRoutingComposition,
  resolveVarinWorkbenchShellSurfaceSeams, parseVarinWorkbenchShellContributionData,
  VARIN_WORKBENCH_SLOT_CONTRACTS, VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID, VARIN_WORKBENCH_LAYOUT_SERVICE_ID,
  type VarinExtensionServiceProviderSnapshot,
  checkVarinContributionCompatibility,
  type VarinExtensionCatalogSnapshot, type VarinExtensionServiceRoutingSnapshot,
  type VarinExtensionServiceRoutingContext, type VarinExtensionServiceProvision,
  type VarinExtensionHostStateSnapshot, type VarinRuntimeContractScope, type VarinRuntimeContractRequest,
  type VarinRuntimeContractResult, type VarinRuntimeServiceSummary,
  type VarinRuntimeSlotSummary, type VarinServiceMethodContract,
  type VarinHostServiceComposition,
} from '@varin/extension-contract';

/** The Workbench storage owner is registered by the application itself, outside package workers. */
export function registeredWorkbenchDeclarations(catalog: VarinExtensionCatalogSnapshot,
  providers: readonly VarinExtensionServiceProviderSnapshot[], serviceId: string, version: number): VarinExtensionServiceProviderSnapshot[] {
  if (serviceId !== VARIN_WORKBENCH_LAYOUT_SERVICE_ID) return [];
  const entry = catalog.extensions.find(value => value.manifest.id === VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID);
  if (!entry?.desired.enabled || entry.source.kind !== 'builtin') return [];
  const descriptor = entry.manifest.provides?.services?.find(value => value.id === serviceId && value.version === version);
  return providers.filter(provider => provider.status === 'active' && provider.extensionId === entry.manifest.id
    && provider.entrypointId === 'workbench-layout' && provider.extensionVersion === entry.manifest.version
    && isDeepStrictEqual(provider.descriptor, descriptor));
}

/** The same pure declared-provider resolver is used by preparation and read-only discovery. */
export function resolveDeclaredServiceRouting(
  catalog: VarinExtensionCatalogSnapshot, routing: VarinExtensionServiceRoutingSnapshot,
  serviceId: string, version: number, context?: VarinExtensionServiceRoutingContext, defaultProviderKey?: string,
  composition?: "ordered", registered: readonly VarinExtensionServiceProviderSnapshot[] = [],
) {
  const candidates = catalog.extensions.filter(entry => entry.desired.enabled && entry.manifest.entrypoints?.host
    && entry.manifest.provides?.services?.some(service => service.id === serviceId && service.version === version))
    .map(entry => ({ providerKey: `${entry.manifest.id}:host:${serviceId}@${version}`, providerId: entry.manifest.id,
      ...(entry.manifest.provides!.services!.find(service => service.id === serviceId && service.version === version)!.contract?.composition
        ? { composition: 'ordered' as const } : {}) }));
  candidates.push(...registeredWorkbenchDeclarations(catalog, registered, serviceId, version)
    .map(provider => ({ providerKey: provider.providerKey, providerId: provider.extensionId })));
  const resolved = resolveVarinExtensionServiceRouting({ candidates, document: routing.document, serviceId, version,
    ...(context ? { context } : {}), ...(defaultProviderKey ? { defaultProviderKey } : {}), ...(composition ? { composition } : {}) });
  if (resolved.status !== 'resolved') return resolved;
  const { providerIds: extensionIds, ...selection } = resolved;
  return { ...selection, extensionIds };
}

function methodNames(descriptor: VarinExtensionServiceProvision): string[] | null {
  return descriptor.contract || descriptor.tool
    ? [...new Set([...Object.keys(descriptor.contract?.methods ?? {}), ...(descriptor.tool ? ['execute'] : [])])].sort()
    : null;
}
function toolMethod(descriptor: VarinExtensionServiceProvision): VarinServiceMethodContract | undefined {
  const tool = descriptor.tool;
  if (!tool) return undefined;
  return {
    description: tool.description,
    inputSchema: { type: 'array', minItems: 1, maxItems: 1, items: tool.inputSchema },
    outputSchema: tool.outputSchema,
    ...(tool.examples ? { examples: tool.examples.map(input => [input]) } : {}),
    ...(tool.source ? { source: tool.source } : {}),
  };
}
function serviceSummary(state: VarinExtensionHostStateSnapshot, serviceId: string, version: number,
  scope: VarinRuntimeContractScope, artifactIdentityForOwner: (owner: HostServiceOwnerIdentity) => string | undefined,
  compositionForOwner: (owner: HostServiceOwnerIdentity) => VarinHostServiceComposition | undefined): VarinRuntimeServiceSummary {
  const providers = state.services.providers.filter(provider => provider.descriptor.id === serviceId && provider.descriptor.version === version);
  const registered = registeredWorkbenchDeclarations(state.catalog, providers, serviceId, version);
  const currentDeclarationMatches = (provider: typeof providers[number]): boolean => {
    if (registered.some(value => value.providerId === provider.providerId)) return true;
    const entry = state.catalog.extensions.find(entry => entry.manifest.id === provider.extensionId);
    const descriptor = entry?.manifest.provides?.services?.find(service => service.id === serviceId && service.version === version);
    return !!entry?.manifest.entrypoints?.host && entry.manifest.version === provider.extensionVersion
      && isDeepStrictEqual(descriptor, provider.descriptor)
      // Same-semver source updates can publish before registry replacement. Only the original
      // supervisor's exact generation identity can associate an instance with this declaration.
      && !!entry.integrity && artifactIdentityForOwner(provider) === entry.integrity;
  };
  const instances = providers
    .map(({ providerId, providerKey, extensionId, extensionVersion, generation, status }) =>
      ({ providerId, providerKey, extensionId, extensionVersion, generation, status }));
  const implementations = state.catalog.extensions.flatMap(entry => {
    const descriptor = entry.manifest.provides?.services?.find(service => service.id === serviceId && service.version === version);
    const native = registered.find(provider => provider.extensionId === entry.manifest.id);
    if (!descriptor || (!entry.manifest.entrypoints?.host && !native)) return [];
    return [{ extensionId: entry.manifest.id, extensionVersion: entry.manifest.version,
      artifacts: {
        selected: entry.integrity ? { extensionId: entry.manifest.id, slot: 'selected' as const, artifactIntegrity: entry.integrity } : null,
        candidate: entry.candidate ? { extensionId: entry.manifest.id, slot: 'candidate' as const, artifactIntegrity: entry.candidate.integrity } : null,
      },
      providerKey: native?.providerKey ?? `${entry.manifest.id}:host:${serviceId}@${version}`,
      enabled: entry.desired.enabled,
      registration: providers.some(provider => provider.status === 'active' && provider.extensionId === entry.manifest.id && currentDeclarationMatches(provider))
        ? 'registered' as const : 'declared' as const,
      actual: entry.actual.filter(actual => actual.hostId === state.catalog.hostId && actual.realmKind === 'host')
        .map(actual => ({ status: actual.status, generation: actual.generation, codes: actual.diagnostics.map(diagnostic => diagnostic.code) })),
      contractStatus: descriptor.contract || descriptor.tool ? 'declared' as const : 'undeclared' as const,
      ...(descriptor.contract?.composition ? { composition: descriptor.contract.composition } : {}),
      methods: methodNames(descriptor), events: descriptor.contract?.events ? Object.keys(descriptor.contract.events).sort() : null,
      requirements: structuredClone(entry.manifest.requires?.services ?? []),
    }];
  });
  const summary: VarinRuntimeServiceSummary = { serviceId, version, implementations, instances,
    selection: { status: 'stale', codes: [] } };
  if (!state.catalog.authoritative || !state.routing.authoritative) return summary;
  const composition = serviceRoutingComposition(state, serviceId, version);
  const resolution = resolveDeclaredServiceRouting(state.catalog, state.routing, serviceId, version, scope.routing, undefined, composition, registered);
  const active = resolution.status !== 'resolved' ? undefined : resolution.providerKeys.map((key, index) => {
    try {
      const native = registered.filter(provider => provider.providerKey === key);
      if (native.length) return native.length === 1 ? native[0] : undefined;
      const plan = createHostCompositionPlan(state.catalog, state.routing, resolution.extensionIds[index]!, scope.routing);
      const matches = providers.filter(provider => provider.status === 'active' && provider.providerKey === key
        && currentDeclarationMatches(provider) && compositionForOwner(provider)?.root === plan.composition.root);
      return matches.length === 1 ? matches[0] : undefined;
    } catch { return undefined; } // A cold or invalid composition has no executing identity to report.
  });
  summary.selection = { status: resolution.status, codes: resolution.diagnostics.map(diagnostic => diagnostic.code),
    ...(composition ? { composition } : {}), ...(resolution.providerKeys !== undefined ? { providerKeys: resolution.providerKeys } : {}),
    ...(resolution.status === 'resolved' && active?.every(provider => provider !== undefined)
      ? { providerIds: active.map(provider => provider!.providerId) } : {}) };
  return summary;
}

function slots(state: VarinExtensionHostStateSnapshot, scope: VarinRuntimeContractScope): VarinRuntimeSlotSummary[] {
  let selectedShell: VarinRuntimeSlotSummary['selectedShell'] = null;
  let hosted: string[] | undefined;
  let codes: string[] | undefined;
  if (scope.workbench && state.catalog.authoritative && state.workbench.authoritative) {
    const profile = resolveVarinWorkbenchProfile(state.workbench.document, state.catalog, scope.workbench);
    if (profile.shellExtensionId && profile.shellContributionId) {
      selectedShell = { extensionId: profile.shellExtensionId, contributionId: profile.shellContributionId };
      const contribution = state.catalog.extensions.find(entry => entry.manifest.id === profile.shellExtensionId)
        ?.manifest.contributions?.find(item => item.id === profile.shellContributionId);
      const compatibility = contribution && checkVarinContributionCompatibility(contribution.kind, contribution.contractVersion);
      if (compatibility?.status === 'unsupported-contract-version') {
        codes = [compatibility.status];
      } else if (contribution && profile.status === 'ready') {
        const contract = parseVarinWorkbenchShellContributionData(contribution.data, contribution.supports);
        hosted = resolveVarinWorkbenchShellSurfaceSeams(contract, scope.workbench.surface).slots;
      } else if (contribution) hosted = [];
    }
  }
  return Object.values(VARIN_WORKBENCH_SLOT_CONTRACTS).map(contract => ({
    id: contract.id, version: contract.version, placement: 'list', live: 'unobserved', selectedShell,
    ...(codes ? { codes } : {}),
    hosting: hosted === undefined ? 'unresolved' : hosted.includes(contract.id) ? 'declared' : 'dormant',
  }));
}

/** Reads only already-owned metadata. No activation, package reads, handler calls or new binding. */
export function queryRuntimeContracts(state: VarinExtensionHostStateSnapshot,
  requestValue: VarinRuntimeContractRequest | unknown, scope: VarinRuntimeContractScope,
  artifactIdentityForOwner: (owner: HostServiceOwnerIdentity) => string | undefined,
  compositionForOwner: (owner: HostServiceOwnerIdentity) => VarinHostServiceComposition | undefined): VarinRuntimeContractResult {
  const request = parseVarinRuntimeContractRequest(requestValue);
  if (request.kind === 'source') throw new Error('Source reads require the original package owner');
  const basis = { origin: 'current_catalog' as const, permission: 'checked_on_invocation' as const,
    hostId: state.catalog.hostId, authoritative: state.catalog.authoritative && state.routing.authoritative && state.workbench.authoritative,
    revisions: { catalog: state.catalog.revision, services: state.services.revision,
      routing: state.routing.document.revision, workbench: state.workbench.document.revision } };
  if (request.kind === 'ui_slot') {
    const entries = slots(state, scope);
    if (request.action === 'list') return { ...basis, action: 'list', kind: 'ui_slot', entries };
    const slot = entries.find(entry => entry.id === request.id);
    const contract = Object.values(VARIN_WORKBENCH_SLOT_CONTRACTS).find(entry => entry.id === request.id);
    return { ...basis, action: 'describe', kind: 'ui_slot', status: slot ? 'found' : 'missing',
      slot: slot && contract ? { ...slot, propsSchema: structuredClone(contract.propsSchema) } : null };
  }
  if (request.action === 'list') {
    const services = new Map<string, { id: string; version: number }>();
    for (const extension of state.catalog.extensions) if (extension.manifest.entrypoints?.host) {
      for (const service of extension.manifest.provides?.services ?? []) services.set(`${service.id}@${service.version}`, service);
    }
    for (const provider of state.services.providers) services.set(`${provider.descriptor.id}@${provider.descriptor.version}`, provider.descriptor);
    const entries = [...services.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version)
      .map(service => serviceSummary(state, service.id, service.version, scope, artifactIdentityForOwner, compositionForOwner));
    return { ...basis, action: 'list', kind: 'service', entries };
  }
  const service = serviceSummary(state, request.serviceId, request.version, scope, artifactIdentityForOwner, compositionForOwner);
  const candidates = state.catalog.extensions.filter(entry => (!request.extensionId || entry.manifest.id === request.extensionId)
    && entry.manifest.provides?.services?.some(descriptor => descriptor.id === request.serviceId && descriptor.version === request.version));
  if (!candidates.length) return { ...basis, action: 'describe', kind: 'service', status: 'missing', service: null, member: null };
  if (!request.member) return { ...basis, action: 'describe', kind: 'service', status: 'found', service, member: null };
  // Explicit implementation or the original scoped selection. Ambiguity never selects an arbitrary schema.
  const selectedKeys = service.selection.providerKeys;
  const entry = request.extensionId ? candidates[0] : selectedKeys?.length === 1 ? candidates.find(candidate =>
    service.implementations.some(implementation => implementation.extensionId === candidate.manifest.id && selectedKeys.includes(implementation.providerKey))) : undefined;
  if (!entry) return { ...basis, action: 'describe', kind: 'service', status: 'unresolved', service, member: null };
  const descriptor = entry.manifest.provides!.services!.find(item => item.id === request.serviceId && item.version === request.version)!;
  const { kind, name } = request.member;
  if (kind === 'method') {
    const contract = name === 'execute' && descriptor.tool ? toolMethod(descriptor)
      : descriptor.contract && Object.hasOwn(descriptor.contract.methods, name) ? descriptor.contract.methods[name] : undefined;
    return { ...basis, action: 'describe', kind: 'service',
      status: contract ? 'found' : descriptor.contract || descriptor.tool ? 'missing' : 'undeclared', service,
      member: contract ? { kind, name, extensionId: entry.manifest.id, contract: structuredClone(contract) } : null };
  }
  const contract = descriptor.contract?.events && Object.hasOwn(descriptor.contract.events, name)
    ? descriptor.contract.events[name] : undefined;
  return { ...basis, action: 'describe', kind: 'service',
    status: contract ? 'found' : descriptor.contract?.events ? 'missing' : 'undeclared', service,
    member: contract ? { kind, name, extensionId: entry.manifest.id, contract: structuredClone(contract) } : null };
}
