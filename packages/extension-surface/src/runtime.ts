import {
  parseVarinExtensionManifest,
  checkVarinContributionCompatibility,
  isVarinExtensionId,
  isVarinContributionCompatible,
  evaluateVarinContextExpression,
  collectVarinContextExpressionKeys,
  type VarinApplicationSurface,
  type VarinContextValue,
  type VarinExtensionActualState,
  type VarinExtensionDiagnostic,
  type VarinExtensionServiceProvision,
  type VarinExtensionServiceRequirement,
  type VarinExtensionStaticContribution,
} from "@varin/extension-contract";
import { SurfaceActivationStaleError, SurfaceRegistryConflictError } from "./errors.js";
import { SurfaceOwnerScope } from "./owner-scope.js";
import type {
  SurfaceActivation,
  SurfaceActualState,
  SurfaceActivationContext,
  SurfaceActivationOptions,
  SurfaceContribution,
  SurfaceContributionConsumer,
  SurfaceContributionLease,
  SurfaceDisposer,
  SurfaceContextProvider,
  SurfaceContextChanges,
  SurfaceContributionPreview,
  SurfaceContextWriter,
  SurfaceContextWriterLease,
  SurfaceExternalService,
  SurfaceExtensionRuntimeOptions,
  SurfaceLayoutReference,
  SurfaceOwnerHandle,
  SurfaceOwnerIdentity,
  SurfaceRegistrySnapshot,
  SurfaceService,
} from "./types.js";


/** A frozen local handle keeps its owner alive through the consumer and every admitted call. */
function retainServiceCalls(value: unknown, provider: SurfaceOwnerScope, consumer: SurfaceOwnerScope): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  return new Proxy(value as object, {
    get(target, property) {
      const member = Reflect.get(target, property);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (consumer.disposed) throw new Error("Surface service consumer is inactive");
        const release = provider.retain();
        try {
          const result = Reflect.apply(member, target, args);
          if (result && typeof (result as { then?: unknown }).then === "function") return Promise.resolve(result).finally(release);
          void release();
          return result;
        } catch (error) { void release(); throw error; }
      };
    },
  });
}

interface ActiveOwner {
  contributions: SurfaceContribution[];
  boundLocalOwners: ReadonlySet<string>;
  contextLease: SurfaceContextWriterLease | null;
  diagnostics: VarinExtensionDiagnostic[];
  externalServices: SurfaceExternalService[];
  owner: SurfaceOwnerIdentity;
  requirements: VarinExtensionServiceRequirement[];
  preparedLocalBindings: string;
  scope: SurfaceOwnerScope;
  exactProviderIds: Readonly<Record<string, readonly string[]>>;
  services: SurfaceService[];
}

interface ServiceConsumer {
  externalServices: readonly SurfaceExternalService[];
  requirements: readonly VarinExtensionServiceRequirement[];
  exactProviderIds: Readonly<Record<string, readonly string[]>>;
}

interface ResolvedServiceCandidate {
  identity: string;
  implementation: unknown;
}

interface RequestVersion {
  desiredRevision: number;
  generation: number;
}

const ACTUAL_REALM_KIND = "surface" as const;

function ownerKey(owner: SurfaceOwnerIdentity): string {
  return `${owner.extensionId}\0${owner.realmId}\0${owner.entrypointId}`;
}

function compareRequest(left: RequestVersion, right: RequestVersion): number {
  return left.desiredRevision - right.desiredRevision || left.generation - right.generation;
}

function diagnostic(owner: SurfaceOwnerIdentity, code: string, message: string): VarinExtensionDiagnostic {
  return {
    code,
    extensionId: owner.extensionId,
    message,
    realmId: owner.realmId,
    severity: "error",
    timestamp: new Date().toISOString(),
  };
}

function actual(
  owner: SurfaceOwnerIdentity,
  status: VarinExtensionActualState["status"],
  diagnostics: VarinExtensionDiagnostic[] = [],
): SurfaceActualState {
  return {
    desiredRevision: owner.desiredRevision,
    diagnostics,
    entrypointId: owner.entrypointId,
    extensionId: owner.extensionId,
    extensionVersion: owner.extensionVersion,
    generation: owner.generation,
    hostId: owner.hostId,
    realmId: owner.realmId,
    realmKind: ACTUAL_REALM_KIND,
    status,
    updatedAt: new Date().toISOString(),
  };
}

function validateOwner(owner: SurfaceOwnerIdentity): void {
  parseVarinExtensionManifest({
    schemaVersion: 1,
    id: owner.extensionId,
    version: owner.extensionVersion,
    engines: { varin: "*" },
  });
  if (!isVarinExtensionId(owner.entrypointId)) throw new Error(`Invalid Surface owner entrypoint ID: ${owner.entrypointId}`);
  if (!owner.realmId.trim()) throw new Error("Surface owner realmId is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.hostId)) {
    throw new Error("Surface owner hostId must be an application-host UUID");
  }
  if (!Number.isSafeInteger(owner.generation) || owner.generation < 0) throw new Error("Surface owner generation must be a non-negative safe integer");
  if (!Number.isSafeInteger(owner.desiredRevision) || owner.desiredRevision <= 0) throw new Error("Surface owner desired revision must be a positive safe integer");
}

function normalizeRequirements(
  owner: SurfaceOwnerIdentity,
  requirements: VarinExtensionServiceRequirement[],
): VarinExtensionServiceRequirement[] {
  const parsed = parseVarinExtensionManifest({
    schemaVersion: 1,
    id: owner.extensionId,
    version: owner.extensionVersion,
    engines: { varin: "*" },
    requires: { services: requirements },
  });
  return parsed.requires?.services?.filter(requirement => requirement.realms.includes("surface")) ?? [];
}

function normalizeContribution(
  owner: SurfaceOwnerIdentity,
  descriptor: VarinExtensionStaticContribution,
): VarinExtensionStaticContribution {
  const parsed = parseVarinExtensionManifest({
    schemaVersion: 1,
    id: owner.extensionId,
    version: owner.extensionVersion,
    engines: { varin: "*" },
    entrypoints: {
      surfaces: [{
        id: owner.entrypointId,
        file: "runtime-entrypoint.mjs",
        mode: "managed",
        supports: descriptor.supports,
      }],
    },
    ...(descriptor.requiresCapabilities && descriptor.requiresCapabilities.length > 0
      ? { capabilities: { surface: descriptor.requiresCapabilities } }
      : {}),
    contributions: [descriptor],
  });
  const normalized = parsed.contributions?.[0];
  if (!normalized) throw new Error(`Surface contribution could not be normalized: ${descriptor.id}`);
  return normalized;
}

function validateService(descriptor: VarinExtensionServiceProvision): VarinExtensionServiceProvision {
  if (!isVarinExtensionId(descriptor.id)) throw new Error(`Invalid Surface service ID: ${descriptor.id}`);
  if (!Number.isSafeInteger(descriptor.version) || descriptor.version <= 0) throw new Error(`Invalid Surface service version: ${descriptor.id}`);
  if (descriptor.multiple !== undefined && typeof descriptor.multiple !== "boolean") throw new Error(`Invalid Surface service multiplicity: ${descriptor.id}`);
  return { id: descriptor.id, version: descriptor.version, ...(descriptor.multiple !== undefined ? { multiple: descriptor.multiple } : {}) };
}

function contributionOrder(
  left: SurfaceContribution,
  right: SurfaceContribution,
  layoutReferences: ReadonlyMap<string, SurfaceLayoutReference>,
): number {
  const leftOrder = layoutReferences.get(left.descriptor.id)?.order ?? left.descriptor.placement?.order ?? 0;
  const rightOrder = layoutReferences.get(right.descriptor.id)?.order ?? right.descriptor.placement?.order ?? 0;
  return leftOrder - rightOrder
    || left.descriptor.id.localeCompare(right.descriptor.id);
}

function selectVisibleContributions(
  contributions: SurfaceContribution[],
  replacementSelections: ReadonlyMap<string, string>,
  layoutReferences: ReadonlyMap<string, SurfaceLayoutReference>,
  context?: ReadonlyMap<string, VarinContextValue>,
): SurfaceContribution[] {
  const additive: SurfaceContribution[] = [];
  const replacements = new Map<string, SurfaceContribution[]>();
  for (const contribution of contributions) {
    if (layoutReferences.get(contribution.descriptor.id)?.visible === false) continue;
    // Exclude contributions whose contract version is not compatible with
    // the current runtime. They remain in the registry (catalog retains
    // the record) but are not visible or activatable.
    if (!isVarinContributionCompatible(contribution.descriptor.kind, contribution.descriptor.contractVersion)) continue;
    // Evaluate `when` context expression if present and a context provider
    // is available. When false, the contribution is hidden but its
    // registration and replacement selection are preserved.
    if (contribution.descriptor.when && context) {
      if (!evaluateVarinContextExpression(contribution.descriptor.when, context)) continue;
    }
    const target = contribution.descriptor.replacement?.target;
    if (!target) additive.push(contribution);
    else {
      const group = replacements.get(target) ?? [];
      group.push(contribution);
      replacements.set(target, group);
    }
  }
  for (const [target, candidates] of replacements) {
    const selectedId = replacementSelections.get(target);
    const selected = selectedId ? candidates.find((candidate) => candidate.descriptor.id === selectedId) : undefined;
    const fallback = candidates.find((candidate) => candidate.descriptor.data.fallback === true);
    if (selected ?? fallback) additive.push((selected ?? fallback) as SurfaceContribution);
  }
  return orderContributions(additive, layoutReferences);
}

function orderContributions(
  contributions: SurfaceContribution[],
  layoutReferences: ReadonlyMap<string, SurfaceLayoutReference> = new Map(),
): SurfaceContribution[] {
  const byId = new Map(contributions.map((contribution) => [contribution.descriptor.id, contribution]));
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const id of byId.keys()) {
    outgoing.set(id, new Set());
    indegree.set(id, 0);
  }
  const edge = (from: string, to: string) => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const targets = outgoing.get(from) as Set<string>;
    if (targets.has(to)) return;
    targets.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  };
  for (const contribution of contributions) {
    for (const before of contribution.descriptor.placement?.before ?? []) edge(contribution.descriptor.id, before);
    for (const after of contribution.descriptor.placement?.after ?? []) edge(after, contribution.descriptor.id);
  }
  const ready = contributions
    .filter((item) => indegree.get(item.descriptor.id) === 0)
    .sort((left, right) => contributionOrder(left, right, layoutReferences));
  const ordered: SurfaceContribution[] = [];
  while (ready.length > 0) {
    const next = ready.shift() as SurfaceContribution;
    ordered.push(next);
    for (const target of outgoing.get(next.descriptor.id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        const contribution = byId.get(target);
        if (contribution) {
          ready.push(contribution);
          ready.sort((left, right) => contributionOrder(left, right, layoutReferences));
        }
      }
    }
  }
  if (ordered.length !== contributions.length) {
    const cycle = contributions.map((item) => item.descriptor.id).filter((id) => !ordered.some((item) => item.descriptor.id === id));
    throw new SurfaceRegistryConflictError("Surface contribution ordering contains a cycle", cycle);
  }
  return ordered;
}

export class SurfaceExtensionRuntime {
  readonly surface: VarinApplicationSurface;
  readonly #activeOwners = new Map<string, ActiveOwner>();
  readonly #actual = new Map<string, SurfaceActualState>();
  readonly #latestRequests = new Map<string, RequestVersion>();
  readonly #preparationControllers = new Map<string, AbortController>();
  readonly #listeners = new Set<() => void>();
  readonly #layoutReferences = new Map<string, SurfaceLayoutReference>();
  readonly #ownerQueues = new Map<string, Promise<void>>();
  readonly #publicationReservations = new Map<string, Promise<void>>();
  readonly #contributionConsumers = new Set<SurfaceContributionConsumer>();
  readonly #replacementSelections = new Map<string, string>();
  #snapshot: SurfaceRegistrySnapshot = {
    actual: [],
    contributions: [],
    layoutReferences: [],
    replacementSelections: {},
    revision: 0,
    services: [],
    visibleContributions: [],
  };

  readonly #contextProvider: SurfaceContextProvider | undefined;
  #contextUnsubscribe: (() => void) | undefined;
  #contextSubscribedKeys: ReadonlySet<string> = new Set();
  #contextPublicationSuppressed = 0;

  constructor(options: SurfaceExtensionRuntimeOptions) {
    this.surface = options.surface;
    this.#contextProvider = options.contextProvider;
    if (this.#contextProvider?.createWriter && !this.#contextProvider.previewContext) {
      throw new Error("An owned Surface context provider requires candidate context preview");
    }
  }

  getSnapshot = (): SurfaceRegistrySnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  activate(options: SurfaceActivationOptions, activation: SurfaceActivation): Promise<SurfaceOwnerHandle> {
    return this.activateWithCommit(options, activation, async () => undefined);
  }

  activateWithCommit(
    options: SurfaceActivationOptions,
    activation: SurfaceActivation,
    commit: (signal: AbortSignal) => void | Promise<void>,
  ): Promise<SurfaceOwnerHandle> {
    return this.activateBatchWithCommit([{ activation, options }], commit)
      .then((handles) => handles[0] as SurfaceOwnerHandle);
  }

  registerContributionConsumer = (consumer: SurfaceContributionConsumer): (() => void) => {
    this.#contributionConsumers.add(consumer);
    return () => { this.#contributionConsumers.delete(consumer); };
  };

  activateBatchWithCommit(
    requests: readonly { activation: SurfaceActivation; options: SurfaceActivationOptions }[],
    commit: (signal: AbortSignal) => void | Promise<void>,
  ): Promise<SurfaceOwnerHandle[]> {
    if (requests.length === 0) return Promise.resolve([]);
    const extensionId = requests[0]?.options.owner.extensionId as string;
    const keys = new Set<string>();
    const preparationController = new AbortController();
    for (const request of requests) {
      validateOwner(request.options.owner);
      if (request.options.owner.extensionId !== extensionId) {
        throw new Error("A transactional Surface activation batch must belong to one extension");
      }
      const key = ownerKey(request.options.owner);
      if (keys.has(key)) throw new Error(`Duplicate Surface owner in activation batch: ${request.options.owner.entrypointId}`);
      keys.add(key);
      this.#markLatest(key, request.options.owner);
      this.#preparationControllers.set(key, preparationController);
    }
    const preparationSignal = AbortSignal.any([
      preparationController.signal,
      ...requests.flatMap((request) => request.options.signal ? [request.options.signal] : []),
    ]);
    return this.#enqueue(extensionId, async () => {
      const previous = new Map<string, ActiveOwner | undefined>();
      const candidates = new Map<string, ActiveOwner>();
      const leases: SurfaceContributionLease[] = [];
      const retirements: SurfaceDisposer[] = [];
      for (const request of requests) {
        const key = ownerKey(request.options.owner);
        this.#assertLatest(key, request.options.owner);
        previous.set(key, this.#activeOwners.get(key));
        this.#actual.set(key, actual(request.options.owner, previous.get(key) ? "updating" : "activating"));
      }
      this.#publish();

      try {
        for (const request of requests) {
          const owner = request.options.owner;
          const key = ownerKey(owner);
          const scope = new SurfaceOwnerScope();
          if (request.options.onRetire) scope.onRetire(request.options.onRetire);
          const stagedContributions: SurfaceContribution[] = [];
          const stagedDiagnostics: VarinExtensionDiagnostic[] = [];
          const stagedServices: SurfaceService[] = [];
          const granted = new Set(request.options.grantedCapabilities ?? []);
          const requirements = normalizeRequirements(owner, request.options.requirements ?? []);
          const exactProviderIds = Object.fromEntries(Object.entries(request.options.exactProviderIds ?? {}).map(([key, value]) => {
            if (!key.trim() || value.some(id => !id.trim()) || new Set(value).size !== value.length) throw new Error("Surface frozen provider IDs must be non-empty and unique");
            return [key, [...value]];
          }));
          const externalServices = [...(request.options.externalServices ?? [])].map((service) => ({
            descriptor: validateService(service.descriptor),
            ...(service.dispose ? { dispose: service.dispose } : {}),
            implementation: retainServiceCalls(service.implementation, scope, scope),
            providerId: service.providerId,
          }));
          for (const service of externalServices) {
            if (!service.providerId.trim()) throw new Error(`Surface external service provider ID is required: ${service.descriptor.id}`);
          }
          for (const service of externalServices) {
            if (service.dispose) scope.onDispose(service.dispose);
          }
          const preparedLocalBindings = this.#localBindingSignature({ externalServices, requirements, exactProviderIds });
          const frozenBindings = new Map<string, ResolvedServiceCandidate[]>();
          const boundLocalOwners = new Set<string>();
          for (const requirement of requirements) {
            const bindings = this.#servicesForConsumer({ externalServices, requirements, exactProviderIds }, requirement.id, requirement.version);
            const serviceKey = `${requirement.id}@${requirement.version}`;
            const expected = exactProviderIds[serviceKey];
            if ((expected && expected.length !== bindings.length) || (!requirement.optional && !bindings.length)
              || (requirement.binding !== "all" && bindings.length > 1)) {
              await scope.dispose();
              throw new SurfaceRegistryConflictError(`${requirement.binding === "selected" ? "Selected Surface service provider is unavailable" : "Required Surface service is unavailable or ambiguous"}: ${serviceKey}`, [requirement.id]);
            }
            const localBindings = this.#matchingServices(requirement.id, requirement.version)
              .filter(service => bindings.some(binding => binding.identity === service.providerId));
            for (const service of localBindings) {
              boundLocalOwners.add(ownerKey(service.owner));
              const providerScope = this.#activeOwners.get(ownerKey(service.owner))!.scope;
              scope.onDispose(providerScope.retain());
              const binding = bindings.find(value => value.identity === service.providerId)!;
              binding.implementation = retainServiceCalls(binding.implementation, providerScope, scope);
            }
            exactProviderIds[serviceKey] = bindings.map(binding => binding.identity);
            frozenBindings.set(serviceKey, bindings);
          }
          const contextLease = this.#createContextWriter(owner, scope);
          const context: SurfaceActivationContext = {
            signal: AbortSignal.any([scope.signal, preparationSignal]),
            contribute: (descriptor, implementation) => {
              const normalized = normalizeContribution(owner, descriptor);
              const compatibility = checkVarinContributionCompatibility(
                normalized.kind,
                normalized.contractVersion,
              );
              if (compatibility.status === "unsupported-contract-version") {
                stagedDiagnostics.push({
                  code: "unsupported-contract-version",
                  extensionId: owner.extensionId,
                  message: `Contribution ${normalized.id} declares unsupported ${normalized.kind} contract version ${normalized.contractVersion}; supported versions: ${compatibility.supportedVersions.join(", ")}`,
                  realmId: owner.realmId,
                  severity: "warning",
                  timestamp: new Date().toISOString(),
                });
                return;
              }
              if (!normalized.supports.includes(this.surface)) {
                throw new SurfaceRegistryConflictError(
                  `Contribution ${normalized.id} does not support ${this.surface}`,
                  [normalized.id],
                );
              }
              const missing = (normalized.requiresCapabilities ?? []).filter((capability) => !granted.has(capability));
              if (missing.length > 0) {
                throw new SurfaceRegistryConflictError(`Contribution ${normalized.id} lacks capability grants`, missing);
              }
              stagedContributions.push({ descriptor: normalized, implementation, owner: { ...owner } });
            },
            provide: (descriptor, implementation) => {
              stagedServices.push({ descriptor: validateService(descriptor), implementation, owner: { ...owner },
                providerKey: `${owner.extensionId}:${owner.entrypointId}:${descriptor.id}@${descriptor.version}`,
                providerId: `${owner.hostId}:${owner.realmId}:${owner.extensionId}:${owner.entrypointId}:${owner.generation}:${descriptor.id}@${descriptor.version}` });
            },
            onDispose: (disposer) => scope.onDispose(disposer),
            useService: <TImplementation = unknown>(id: string, version: number): TImplementation | undefined => {
              const bindings = frozenBindings.get(`${id}@${version}`) ?? [];
              return bindings.length === 1 ? bindings[0]?.implementation as TImplementation : undefined;
            },
            useServices: <TImplementation = unknown>(id: string, version: number): TImplementation[] =>
              (frozenBindings.get(`${id}@${version}`) ?? []).map(service => service.implementation as TImplementation),
            context: contextLease?.writer ?? unavailableContextWriter,
          };
          try {
            await request.activation(context);
          } catch (error) {
            await scope.dispose(error).catch(() => undefined);
            throw error;
          }
          candidates.set(key, {
            contributions: stagedContributions,
            boundLocalOwners,
            contextLease,
            diagnostics: stagedDiagnostics,
            externalServices,
            owner: { ...owner },
            requirements,
            preparedLocalBindings,
            scope,
            exactProviderIds,
            services: stagedServices,
          });
          this.#assertLatest(key, owner);
        }
        this.#validateCandidates(candidates);
        const projectedOwners = new Map(this.#activeOwners);
        for (const [key, candidate] of candidates) projectedOwners.set(key, candidate);
        const contextChanges: SurfaceContextChanges = {
          commit: [...candidates.values()].flatMap((candidate) => candidate.contextLease ? [candidate.contextLease] : []),
          dispose: [],
        };
        preparationSignal.throwIfAborted();
        const preview = {
          ...this.#previewContributions(extensionId, [...candidates.values()].map((candidate) => candidate.owner),
            projectedOwners, contextChanges),
          signal: preparationSignal,
        };
        // Mount preparation is owner-local and runs before reserving any publication keys.
        for (const consumer of this.#contributionConsumers) {
          const lease = await consumer(preview);
          if (lease) leases.push(lease);
        }
        const publicationKeys = this.#publicationKeys(candidates);
        this.#reserveContextChanges(publicationKeys, contextChanges, preview);
        await this.#reservePublication(publicationKeys, async () => {
          this.#validateCandidates(candidates);
          for (const request of requests) this.#assertLatest(ownerKey(request.options.owner), request.options.owner);
          const currentProjection = new Map(this.#activeOwners);
          for (const [key, candidate] of candidates) currentProjection.set(key, candidate);
          const latestPreview = this.#previewContributions(extensionId, preview.owners, currentProjection, contextChanges);
          const affectedIds = new Set([...preview.affectedExtensionIds, ...latestPreview.affectedExtensionIds]);
          const affectedVisibility = (contributions: readonly SurfaceContribution[]) => contributions
            .filter((item) => affectedIds.has(item.owner.extensionId))
            .map((item) => `${item.descriptor.id}\0${item.owner.entrypointId}\0${item.owner.generation}`).join("\n");
          if (affectedVisibility(preview.visibleContributions) !== affectedVisibility(latestPreview.visibleContributions)) {
            throw new SurfaceActivationStaleError("Surface contribution selection changed during preparation");
          }
          for (const lease of leases) lease.validate();
          const commitSignal = AbortSignal.any([
            preparationSignal,
            ...[...candidates.values()].map((candidate) => candidate.scope.signal),
            ...leases.flatMap((lease) => lease.signal ? [lease.signal] : []),
          ]);
          commitSignal.throwIfAborted();
          await commit(commitSignal);
          // The external commit is the transaction boundary. A newer queued lifecycle request may
          // arrive while it is in flight; publish this committed generation first, then let that
          // queued request replace or deactivate it without turning a successful catalog commit
          // into a partial rollback.
          this.#withContextPublicationSuppressed(() => {
            const publishContextLayers = () => {
              for (const candidate of candidates.values()) {
                try {
                  candidate.contextLease?.commit();
                } catch (error) {
                  try { candidate.contextLease?.dispose(); } catch { /* Failure remains attributed below. */ }
                  candidate.diagnostics.push(diagnostic(
                    candidate.owner,
                    "context_commit_failed",
                    error instanceof Error ? error.message : String(error),
                  ));
                }
              }
            };
            try {
              if (this.#contextProvider?.batch) this.#contextProvider.batch(publishContextLayers);
              else publishContextLayers();
            } catch (error) {
              for (const candidate of candidates.values()) {
                try { candidate.contextLease?.dispose(); } catch { /* Failure remains attributed below. */ }
                if (candidate.diagnostics.some((item) => item.code === "context_commit_failed")) continue;
                candidate.diagnostics.push(diagnostic(
                  candidate.owner,
                  "context_commit_failed",
                  error instanceof Error ? error.message : String(error),
                ));
              }
            }
            for (const [key, candidate] of candidates) {
              this.#activeOwners.set(key, candidate);
              this.#actual.set(key, actual(candidate.owner, "active", candidate.diagnostics));
            }
          });
          for (const lease of leases) {
            try {
              const retirement = lease.commit();
              if (retirement) retirements.push(retirement);
            } catch (error) {
              for (const candidate of candidates.values()) candidate.diagnostics.push(diagnostic(
                candidate.owner, "consumer_publication_failed", error instanceof Error ? error.message : String(error),
              ));
              retirements.push(() => lease.rollback());
            }
          }
          this.#publish();
        });
        // Actual mounts finish retiring before their styles, assets, and services are released.
        for (const retire of retirements) await Promise.resolve(retire()).catch(() => undefined);
        for (const [key, oldOwner] of previous) {
          if (!oldOwner) continue;
          await oldOwner.scope.dispose("Surface owner generation replaced").catch((error) => {
            const state = this.#actual.get(key);
            if (state) state.diagnostics = [diagnostic(state, "previous_generation_cleanup_failed", error instanceof Error ? error.message : String(error))];
          });
        }
        this.#publish();
        return requests.map((request) => this.#handle(request.options.owner));
      } catch (error) {
        for (const lease of [...leases].reverse()) await Promise.resolve(lease.rollback()).catch(() => undefined);
        for (const candidate of candidates.values()) await candidate.scope.dispose(error).catch(() => undefined);
        for (const request of requests) {
          const key = ownerKey(request.options.owner);
          const oldOwner = this.#activeOwners.get(key);
          this.#actual.set(key, oldOwner
            ? actual(oldOwner.owner, "active", [
                ...oldOwner.diagnostics,
                diagnostic(request.options.owner, "candidate_activation_failed", error instanceof Error ? error.message : String(error)),
              ])
            : actual(request.options.owner, error instanceof SurfaceActivationStaleError ? "inactive" : "failed", [
              diagnostic(request.options.owner, error instanceof SurfaceActivationStaleError ? "activation_superseded" : "activation_failed", error instanceof Error ? error.message : String(error)),
            ]));
        }
        this.#publish();
        throw error;
      }
    }).finally(() => {
      for (const key of keys) {
        if (this.#preparationControllers.get(key) === preparationController) this.#preparationControllers.delete(key);
      }
    });
  }

  deactivate(owner: SurfaceOwnerIdentity): Promise<void> {
    validateOwner(owner);
    const key = ownerKey(owner);
    this.#markLatest(key, owner);
    return this.#enqueue(owner.extensionId, async () => {
      this.#assertLatest(key, owner);
      const active = this.#activeOwners.get(key);
      if (!active) {
        this.#actual.set(key, actual(owner, "inactive"));
        this.#publish();
        return;
      }
      const changes: SurfaceContextChanges = { commit: [], dispose: active.contextLease ? [active.contextLease] : [] };
      const projected = new Map(this.#activeOwners);
      projected.delete(key);
      const keys = this.#publicationKeys(new Map([[key, active]]));
      this.#reserveContextChanges(keys, changes, this.#previewContributions(owner.extensionId, [owner], projected, changes));
      await this.#reservePublication(keys, async () => {
        this.#assertLatest(key, owner);
        await this.#deactivateTree(key, owner, new Set());
      });
    });
  }

  markRestartRequired(owner: SurfaceOwnerIdentity, code: string, message: string): void {
    validateOwner(owner);
    const key = ownerKey(owner);
    this.#actual.set(key, actual(owner, "restart-required", [diagnostic(owner, code, message)]));
    this.#publish();
  }

  setReplacementSelection(target: string, contributionId: string | null): void {
    if (!isVarinExtensionId(target)) throw new Error(`Invalid replacement target: ${target}`);
    if (contributionId === null) this.#replacementSelections.delete(target);
    else {
      if (!isVarinExtensionId(contributionId)) throw new Error(`Invalid replacement contribution ID: ${contributionId}`);
      this.#replacementSelections.set(target, contributionId);
    }
    this.#publish();
  }

  setLayoutReferences(references: readonly SurfaceLayoutReference[]): void {
    this.setWorkbenchState(references, Object.fromEntries(this.#replacementSelections));
  }

  setWorkbenchState(
    references: readonly SurfaceLayoutReference[],
    replacementSelections: Readonly<Record<string, string>>,
  ): void {
    const next = new Map<string, SurfaceLayoutReference>();
    for (const reference of references) {
      if (!isVarinExtensionId(reference.contributionId)) {
        throw new Error(`Invalid Surface layout contribution ID: ${reference.contributionId}`);
      }
      if (next.has(reference.contributionId)) {
        throw new Error(`Duplicate Surface layout contribution ID: ${reference.contributionId}`);
      }
      if (reference.order !== undefined && !Number.isFinite(reference.order)) {
        throw new Error(`Invalid Surface layout order: ${reference.contributionId}`);
      }
      if (reference.region !== undefined && !reference.region.trim()) {
        throw new Error(`Invalid Surface layout region: ${reference.contributionId}`);
      }
      if (reference.size !== undefined && (!Number.isFinite(reference.size) || reference.size <= 0)) {
        throw new Error(`Invalid Surface layout size: ${reference.contributionId}`);
      }
      if (reference.visible !== undefined && typeof reference.visible !== "boolean") {
        throw new Error(`Invalid Surface layout visibility: ${reference.contributionId}`);
      }
      next.set(reference.contributionId, {
        contributionId: reference.contributionId,
        ...(reference.order !== undefined ? { order: reference.order } : {}),
        ...(reference.region !== undefined ? { region: reference.region } : {}),
        ...(reference.size !== undefined ? { size: reference.size } : {}),
        ...(reference.visible !== undefined ? { visible: reference.visible } : {}),
      });
    }
    const nextSelections = new Map<string, string>();
    for (const [target, contributionId] of Object.entries(replacementSelections)) {
      if (!isVarinExtensionId(target)) throw new Error(`Invalid replacement target: ${target}`);
      if (!isVarinExtensionId(contributionId)) throw new Error(`Invalid replacement contribution ID: ${contributionId}`);
      nextSelections.set(target, contributionId);
    }
    this.#layoutReferences.clear();
    for (const [id, reference] of next) this.#layoutReferences.set(id, reference);
    this.#replacementSelections.clear();
    for (const [target, contributionId] of nextSelections) this.#replacementSelections.set(target, contributionId);
    this.#publish();
  }

  getService<TImplementation = unknown>(id: string, version: number): TImplementation | undefined {
    const services = this.#matchingServices(id, version);
    return services.length === 1 ? services[0]?.implementation as TImplementation : undefined;
  }

  getServices<TImplementation = unknown>(id: string, version: number): TImplementation[] {
    return this.#matchingServices(id, version).map((service) => service.implementation as TImplementation);
  }

  #createContextWriter(owner: SurfaceOwnerIdentity, scope: SurfaceOwnerScope): SurfaceContextWriterLease | null {
    const provider = this.#contextProvider;
    if (!provider?.createWriter) return null;
    const lease = provider.createWriter(owner);
    scope.onDispose(() => lease.dispose());
    return lease;
  }

  #handle(owner: SurfaceOwnerIdentity): SurfaceOwnerHandle {
    return {
      owner: { ...owner },
      deactivate: (desiredRevision, generation) => this.deactivate({
        ...owner,
        desiredRevision,
        generation,
      }),
    };
  }

  #matchingServices(
    id: string,
    version: number,
    owners: ReadonlyMap<string, ActiveOwner> = this.#activeOwners,
  ): SurfaceService[] {
    return [...owners.values()]
      .flatMap((owner) => owner.services)
      .filter((service) => service.descriptor.id === id && service.descriptor.version === version)
      .sort((left, right) => left.owner.extensionId.localeCompare(right.owner.extensionId));
  }

  async #deactivateTree(
    key: string,
    requestedOwner: SurfaceOwnerIdentity,
    visited: Set<string>,
  ): Promise<void> {
    if (visited.has(key)) return;
    visited.add(key);
    const active = this.#activeOwners.get(key);
    if (!active) return;
    const withoutProvider = new Map(this.#activeOwners);
    withoutProvider.delete(key);
    for (const [dependentKey, dependent] of [...withoutProvider]) {
      if (!dependent.boundLocalOwners.has(key)) continue;
      const latest = this.#latestRequests.get(dependentKey);
      const dependentOwner = {
        ...dependent.owner,
        desiredRevision: Math.max(dependent.owner.desiredRevision, latest?.desiredRevision ?? 0),
        generation: Math.max(dependent.owner.generation, latest?.generation ?? 0) + 1,
      };
      this.#markLatest(dependentKey, dependentOwner);
      await this.#deactivateTree(dependentKey, dependentOwner, visited);
      this.#actual.set(dependentKey, actual(dependentOwner, "inactive", [
        diagnostic(dependentOwner, "required_service_withdrawn", "A required Surface service was withdrawn"),
      ]));
      withoutProvider.delete(dependentKey);
    }
    const leases: SurfaceContributionLease[] = [];
    const diagnostics: VarinExtensionDiagnostic[] = [];
    const contextChanges: SurfaceContextChanges = { commit: [], dispose: active.contextLease ? [active.contextLease] : [] };
    const preview = this.#previewContributions(requestedOwner.extensionId, [requestedOwner], withoutProvider, contextChanges);
    for (const consumer of this.#contributionConsumers) {
      try {
        const lease = await consumer(preview);
        if (lease) leases.push(lease);
      } catch (error) {
        diagnostics.push(diagnostic(requestedOwner, "consumer_withdrawal_failed", error instanceof Error ? error.message : String(error)));
      }
    }
    this.#withContextPublicationSuppressed(() => {
      try { active.contextLease?.dispose(); }
      catch (error) {
        diagnostics.push(diagnostic(requestedOwner, "context_withdrawal_failed", error instanceof Error ? error.message : String(error)));
      }
      this.#actual.set(key, actual(requestedOwner, "deactivating"));
      this.#activeOwners.delete(key);
    });
    const retirements: SurfaceDisposer[] = [];
    for (const lease of leases) {
      try {
        const retire = lease.commit();
        if (retire) retirements.push(retire);
      } catch (error) {
        retirements.push(() => lease.rollback());
        diagnostics.push(diagnostic(requestedOwner, "consumer_withdrawal_failed", error instanceof Error ? error.message : String(error)));
      }
    }
    this.#publish();
    for (const retire of retirements) await Promise.resolve(retire()).catch(() => undefined);
    try {
      await active.scope.dispose("Surface extension disabled", true);
    } catch (error) {
      diagnostics.push(diagnostic(requestedOwner, "deactivation_cleanup_failed", error instanceof Error ? error.message : String(error)));
    }
    this.#actual.set(key, actual(requestedOwner, "inactive", diagnostics));
    this.#publish();
  }

  #validateCandidates(candidates: ReadonlyMap<string, ActiveOwner>): void {
    for (const candidate of candidates.values()) {
      if (this.#localBindingSignature(candidate) !== candidate.preparedLocalBindings) {
        throw new SurfaceActivationStaleError("A declared Surface service provider changed during candidate preparation");
      }
    }
    const candidateOwners = new Map(this.#activeOwners);
    for (const [key, candidate] of candidates) candidateOwners.set(key, candidate);
    const allContributions = [...candidateOwners.values()].flatMap((owner) => owner.contributions);
    const duplicateContributions = allContributions
      .map((item) => item.descriptor.id)
      .filter((id, index, values) => values.indexOf(id) !== index);
    if (duplicateContributions.length > 0) {
      throw new SurfaceRegistryConflictError("Surface contribution IDs must be unique", [...new Set(duplicateContributions)]);
    }
    orderContributions(allContributions);
    const fallbackReplacements = new Map<string, SurfaceContribution[]>();
    for (const contribution of allContributions) {
      const target = contribution.descriptor.replacement?.target;
      if (!target || contribution.descriptor.data.fallback !== true) continue;
      const group = fallbackReplacements.get(target) ?? [];
      group.push(contribution);
      fallbackReplacements.set(target, group);
    }
    for (const [target, fallbacks] of fallbackReplacements) {
      if (fallbacks.length <= 1) continue;
      throw new SurfaceRegistryConflictError(
        `Surface replacement ${target} has more than one fallback`,
        fallbacks.map((fallback) => fallback.descriptor.id),
      );
    }

    const allServices = [...candidateOwners.values()].flatMap((owner) => owner.services);
    const serviceGroups = new Map<string, SurfaceService[]>();
    for (const service of allServices) {
      const serviceKey = `${service.descriptor.id}@${service.descriptor.version}`;
      const group = serviceGroups.get(serviceKey) ?? [];
      group.push(service);
      serviceGroups.set(serviceKey, group);
    }
    for (const [serviceKey, providers] of serviceGroups) {
      if (providers.length > 1 && providers.some((provider) => provider.descriptor.multiple !== true)) {
        throw new SurfaceRegistryConflictError(`Surface service ${serviceKey} does not allow multiple providers`, providers.map((provider) => provider.owner.extensionId));
      }
    }
    for (const activeOwner of candidates.values()) {
      for (const requirement of activeOwner.requirements) {
        if (requirement.optional) continue;
        const serviceKey = `${requirement.id}@${requirement.version}`;
        const candidatesForRequirement = this.#serviceCandidatesForConsumer(
          activeOwner,
          requirement.id,
          requirement.version,
          candidateOwners,
        );
        if (candidatesForRequirement.length === 0) {
          throw new SurfaceRegistryConflictError(`Required Surface service is unavailable: ${serviceKey}`, [requirement.id]);
        }
        if (requirement.binding === "selected") {
          const exact = activeOwner.exactProviderIds[serviceKey] ?? [];
          const matches = candidatesForRequirement.filter(candidate => exact.includes(candidate.identity));
          if (matches.length !== 1) {
            throw new SurfaceRegistryConflictError(`Selected Surface service provider is unavailable: ${serviceKey}`, [requirement.id]);
          }
        } else if ((requirement.binding ?? "single") === "single" && candidatesForRequirement.length !== 1) {
          throw new SurfaceRegistryConflictError(`Required Surface service is ambiguous: ${serviceKey}`, [
            ...candidatesForRequirement.map((provider) => provider.identity),
          ]);
        }
      }
    }
  }

  #serviceCandidatesForConsumer(
    consumer: ServiceConsumer,
    id: string,
    version: number,
    owners: ReadonlyMap<string, ActiveOwner> = this.#activeOwners,
  ): ResolvedServiceCandidate[] {
    const local = this.#matchingServices(id, version, owners).map((service) => ({
      identity: service.providerId,
      implementation: service.implementation,
    }));
    const external = consumer.externalServices
      .filter((service) => service.descriptor.id === id && service.descriptor.version === version)
      .map((service) => ({ identity: service.providerId, implementation: service.implementation }));
    return [...local, ...external];
  }

  #servicesForConsumer(
    consumer: ServiceConsumer,
    id: string,
    version: number,
    owners: ReadonlyMap<string, ActiveOwner> = this.#activeOwners,
  ): ResolvedServiceCandidate[] {
    const candidates = this.#serviceCandidatesForConsumer(consumer, id, version, owners);
    const requirement = consumer.requirements.find((item) => item.id === id && item.version === version);
    if (!requirement) return candidates.length === 1 ? candidates : [];
    const exact = consumer.exactProviderIds[`${id}@${version}`];
    if (exact) return exact.flatMap(identity => candidates.filter(candidate => candidate.identity === identity));
    if (requirement.binding === "all") return candidates;
    if (requirement.binding === "selected") return [];
    return candidates.length === 1 ? candidates : [];
  }

  #markLatest(key: string, request: RequestVersion): void {
    const previous = this.#latestRequests.get(key);
    if (previous && compareRequest(request, previous) < 0) {
      throw new SurfaceActivationStaleError("Surface lifecycle request is older than the current desired generation");
    }
    if (previous && compareRequest(request, previous) > 0) {
      this.#preparationControllers.get(key)?.abort(new SurfaceActivationStaleError("Surface owner preparation was superseded"));
    }
    this.#latestRequests.set(key, { desiredRevision: request.desiredRevision, generation: request.generation });
  }

  #assertLatest(key: string, request: RequestVersion): void {
    const latest = this.#latestRequests.get(key);
    if (!latest || compareRequest(request, latest) !== 0) {
      throw new SurfaceActivationStaleError("Surface activation was superseded by a newer desired generation");
    }
  }

  #publish(): void {
    const contributions = [...this.#activeOwners.values()].flatMap((owner) => owner.contributions);
    const services = [...this.#activeOwners.values()].flatMap((owner) => owner.services);
    const visibleContributions = selectVisibleContributions(
      contributions,
      this.#replacementSelections,
      this.#layoutReferences,
      this.#contextProvider?.getContext(),
    );
    this.#snapshot = {
      actual: [...this.#actual.values()].map((state) => ({ ...state, diagnostics: [...state.diagnostics] })),
      contributions: [...contributions],
      layoutReferences: [...this.#layoutReferences.values()].map((reference) => ({ ...reference })),
      replacementSelections: Object.fromEntries(this.#replacementSelections),
      revision: this.#snapshot.revision + 1,
      services: [...services],
      visibleContributions,
    };
    this.#syncContextSubscription(contributions);
    for (const listener of this.#listeners) listener();
  }

  /**
   * Subscribe to context key changes for all `when` expressions referenced by
   * active contributions. When any referenced key changes, re-publish so
   * visibleContributions reflects the new context state.
   */
  #syncContextSubscription(contributions: readonly SurfaceContribution[]): void {
    if (!this.#contextProvider) return;
    const keys = new Set<string>();
    for (const contribution of contributions) {
      if (contribution.descriptor.when) {
        for (const key of collectVarinContextExpressionKeys(contribution.descriptor.when)) keys.add(key);
      }
    }
    // Only resubscribe if the key set actually changed
    if (keys.size === this.#contextSubscribedKeys.size && [...keys].every((k) => this.#contextSubscribedKeys.has(k))) return;
    this.#contextUnsubscribe?.();
    this.#contextUnsubscribe = undefined;
    this.#contextSubscribedKeys = keys;
    if (keys.size === 0) return;
    this.#contextUnsubscribe = this.#contextProvider.subscribe([...keys], () => {
      if (this.#contextPublicationSuppressed > 0) {
        return;
      }
      this.#publish();
    });
  }

  #withContextPublicationSuppressed(operation: () => void): void {
    this.#contextPublicationSuppressed += 1;
    try {
      operation();
    } finally {
      this.#contextPublicationSuppressed -= 1;
    }
  }

  #previewContext(changes: SurfaceContextChanges): ReadonlyMap<string, VarinContextValue> | undefined {
    const provider = this.#contextProvider;
    return provider?.previewContext ? provider.previewContext(changes) : provider?.getContext();
  }

  #previewContributions(
    extensionId: string,
    owners: readonly SurfaceOwnerIdentity[],
    projectedOwners: ReadonlyMap<string, ActiveOwner>,
    changes: SurfaceContextChanges,
  ): SurfaceContributionPreview {
    const visibleContributions = selectVisibleContributions(
      [...projectedOwners.values()].flatMap((owner) => owner.contributions),
      this.#replacementSelections, this.#layoutReferences, this.#previewContext(changes),
    );
    const identity = (item: SurfaceContribution) => `${ownerKey(item.owner)}\0${item.owner.generation}\0${item.descriptor.id}`;
    const before = new Map(this.#snapshot.visibleContributions.map((item) => [identity(item), item]));
    const after = new Map(visibleContributions.map((item) => [identity(item), item]));
    const affected = new Set([extensionId]);
    for (const [key, item] of before) if (!after.has(key)) affected.add(item.owner.extensionId);
    for (const [key, item] of after) if (!before.has(key)) affected.add(item.owner.extensionId);
    return { extensionId, affectedExtensionIds: [...affected], owners, visibleContributions };
  }

  #reserveContextChanges(keys: Set<string>, changes: SurfaceContextChanges, preview: SurfaceContributionPreview): void {
    const current = this.#contextProvider?.getContext();
    const projected = this.#previewContext(changes);
    for (const key of new Set([...(current?.keys() ?? []), ...(projected?.keys() ?? [])])) {
      if (current?.get(key) !== projected?.get(key)) keys.add(`context:${key}`);
    }
    const affected = new Set(preview.affectedExtensionIds);
    for (const item of [...this.#snapshot.visibleContributions, ...preview.visibleContributions]) {
      if (affected.has(item.owner.extensionId)) keys.add(`contribution:${item.descriptor.id}`);
    }
  }

  #localBindingSignature(consumer: ServiceConsumer): string {
    return JSON.stringify(consumer.requirements.map((requirement) => {
      const resolved = this.#servicesForConsumer(consumer, requirement.id, requirement.version);
      return [requirement.id, requirement.version, this.#matchingServices(requirement.id, requirement.version)
        .filter((service) => resolved.some((binding) => binding.identity === service.providerId))
        .map((service) => [ownerKey(service.owner), service.owner.desiredRevision, service.owner.generation])];
    }));
  }

  #publicationKeys(candidates: ReadonlyMap<string, ActiveOwner>): Set<string> {
    const keys = new Set<string>();
    for (const [key, candidate] of candidates) {
      keys.add(`owner:${key}`);
      for (const owner of [this.#activeOwners.get(key), candidate]) {
        if (!owner) continue;
        for (const contribution of owner.contributions) {
          keys.add(`contribution:${contribution.descriptor.id}`);
          if (contribution.descriptor.when) {
            for (const key of collectVarinContextExpressionKeys(contribution.descriptor.when)) keys.add(`context:${key}`);
          }
          for (const id of [...(contribution.descriptor.placement?.before ?? []), ...(contribution.descriptor.placement?.after ?? [])]) {
            keys.add(`contribution:${id}`);
          }
          const target = contribution.descriptor.replacement?.target;
          if (target) keys.add(`replacement:${target}`);
        }
        for (const service of [...owner.services.map((item) => item.descriptor), ...owner.requirements]) {
          keys.add(`service:${service.id}@${service.version}`);
        }
      }
    }
    return keys;
  }

  async #reservePublication<T>(keys: ReadonlySet<string>, operation: () => Promise<T>): Promise<T> {
    for (;;) {
      const pending = [...new Set([...keys].flatMap((key) => {
        const reservation = this.#publicationReservations.get(key);
        return reservation ? [reservation] : [];
      }))];
      if (pending.length === 0) break;
      await Promise.all(pending);
    }
    let release!: () => void;
    const reservation = new Promise<void>((resolve) => { release = resolve; });
    for (const key of keys) this.#publicationReservations.set(key, reservation);
    try { return await operation(); }
    finally {
      for (const key of keys) if (this.#publicationReservations.get(key) === reservation) this.#publicationReservations.delete(key);
      release();
    }
  }

  #enqueue<T>(extensionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#ownerQueues.get(extensionId) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#ownerQueues.set(extensionId, settled);
    void settled.then(() => {
      if (this.#ownerQueues.get(extensionId) === settled) this.#ownerQueues.delete(extensionId);
    });
    return result;
  }
}

const unavailableContextWriter: SurfaceContextWriter = {
  delete: () => false,
  set: () => false,
};
