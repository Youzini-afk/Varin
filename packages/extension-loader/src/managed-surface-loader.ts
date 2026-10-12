import {
  parseVarinExtensionAssetPayload,
  parseVarinExtensionCatalogAvailability,
  parseVarinExtensionCatalogSnapshot,
  parseVarinExtensionCandidatePreparationResult,
  parseVarinExtensionHostStateSnapshot,
  parseVarinExtensionManagedEntrypointPayload,
  parseVarinSurfaceServiceLeaseEvent,
  resolveVarinSurfaceManifestOwner,
  varinSurfaceManifestOwnerId,
  resolveVarinExtensionServiceRouting,
  resolveVarinWorkbenchProfile,
  canonicalServiceComposition,
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_WORKBENCH_LAYOUT_SERVICE_ID,
  type VarinSurfaceServiceLeaseRequest,
  type VarinSurfaceServiceLeaseEvent,
  type VarinSurfaceServiceInvocationLease,
  type VarinExtensionServiceRoutingContext,
  checkVarinContributionCompatibility,
  isVarinContributionCompatible,
  type VarinApplicationSurface,
  type VarinExtensionActualState,
  type VarinExtensionAssetPayload,
  type VarinExtensionAssetRequest,
  type VarinExtensionCandidateSelectionRequest,
  type VarinExtensionCandidatePublicationRequest,
  type VarinExtensionCapabilityGrant,
  type VarinExtensionCandidatePreparationResult,
  type VarinExtensionCatalogAvailability,
  type VarinExtensionCatalogEntry,
  type VarinExtensionCatalogSnapshot,
  type VarinExtensionDiagnostic,
  type VarinExtensionManagedEntrypointPayload,
  type VarinExtensionManagedEntrypointRequest,
  type VarinExtensionManifest,
  type VarinExtensionActivationEvent,
  type VarinExtensionHostStateSnapshot,
  type VarinExtensionHostStateWaitRequest,
  type VarinExtensionStaticContribution,
  type VarinExtensionSurfaceEntrypoint,
  type VarinExtensionServiceInvocationRequest,
  type VarinExtensionServiceProvision,
  type VarinExtensionServiceProviderSnapshot,
  type VarinExtensionServiceRequirement,
  type JsonValue,
} from "@varin/extension-contract";
import {
  resolveSurfaceExtensionModule,
  type VarinManagedSurfaceContext,
  type VarinManagedSurfaceModule,
  type VarinSurfaceAsset,
} from "@varin/extension-sdk";
import {
  SurfaceCapabilityRegistry,
  SurfaceExtensionRuntime,
  type SurfaceActivation,
  type SurfaceActivationContext,
  type SurfaceActivationOptions,
  type SurfaceCapabilityAccessContext,
  type SurfaceDisposer,
  type SurfaceExternalService,
  type SurfaceOwnerIdentity,
} from "@varin/extension-surface";
import {
  browserIsolatedSurfaceRealmFactory,
  type IsolatedSurfaceRealm,
  type IsolatedSurfaceRealmFactory,
} from "./isolated-realm.js";

export interface SurfaceExtensionHost {
  activateExtension(extensionId: string): Promise<void>;
  catalog(): Promise<VarinExtensionCatalogAvailability>;
  discardPreparedCandidate(extensionId: string, candidateIntegrity: string): Promise<void>;
  hostState(): Promise<VarinExtensionHostStateSnapshot>;
  invokeService(request: VarinExtensionServiceInvocationRequest, signal?: AbortSignal): Promise<JsonValue>;
  watchServiceLease(request: VarinSurfaceServiceLeaseRequest, onEvent: (event: VarinSurfaceServiceLeaseEvent) => void, signal: AbortSignal): Promise<void>;
  prepareCandidate(extensionId: string, candidateIntegrity: string, signal?: AbortSignal): Promise<VarinExtensionCandidatePreparationResult>;
  requestCandidateApplication(request: VarinExtensionCandidateSelectionRequest): Promise<VarinExtensionCatalogSnapshot>;
  readAsset(request: VarinExtensionAssetRequest): Promise<VarinExtensionAssetPayload>;
  readManagedEntrypoint(request: VarinExtensionManagedEntrypointRequest): Promise<VarinExtensionManagedEntrypointPayload>;
  reportActualState(extensionId: string, state: VarinExtensionActualState): Promise<void>;
  selectCandidate(request: VarinExtensionCandidatePublicationRequest, signal?: AbortSignal): Promise<VarinExtensionCatalogSnapshot>;
  waitForHostState(request: VarinExtensionHostStateWaitRequest, signal?: AbortSignal): Promise<VarinExtensionHostStateSnapshot>;
}

export interface ManagedSurfaceModuleEvaluator {
  (source: string, identity: { entrypointId: string; extensionId: string; integrity: string }): VarinManagedSurfaceModule | Promise<VarinManagedSurfaceModule>;
}

export interface ManagedStyleHandle {
  /** Recheck the staged local resource before an external publication begins. */
  validate?(): void;
  /** Synchronous publication of a validated style; implementations must not throw. */
  commit(): void;
  dispose(): void;
}

export interface ManagedStyleHost {
  stage(cssText: string, ownerLabel: string): ManagedStyleHandle;
}

export interface SurfaceExtensionLoaderDiagnostic extends VarinExtensionDiagnostic {
  entrypointId?: string;
  integrity?: string;
  moduleGeneration?: number;
}

export interface SurfaceExtensionLoaderSnapshot {
  active: Array<{
    entrypointId: string;
    extensionId: string;
    extensionVersion: string;
    integrity: string;
    moduleGeneration: number;
  }>;
  diagnostics: SurfaceExtensionLoaderDiagnostic[];
  hostId: string | null;
  revision: number;
}

export interface SurfaceActivationTarget {
  contributionId?: string;
  entrypointId?: string;
  extensionId?: string;
}

export interface SurfaceExtensionLoaderOptions {
  accessContext?: (state?: VarinExtensionHostStateSnapshot) => Omit<SurfaceCapabilityAccessContext, "surface">;
  capabilities?: SurfaceCapabilityRegistry;
  evaluateModule?: ManagedSurfaceModuleEvaluator;
  externalServiceFactories?: readonly SurfaceLocalExternalServiceFactory[];
  host: SurfaceExtensionHost;
  isolatedRealmFactory?: IsolatedSurfaceRealmFactory;
  realmId?: string;
  styleHost?: ManagedStyleHost;
  surface: VarinApplicationSurface;
  surfaceRuntime: SurfaceExtensionRuntime;
  /** Overrides the transport-retry wait for deterministic conformance tests. */
  watchRetry?: (attempt: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Trusted Surface-host factory for a UI-local service. The loader supplies the consumer owner and
 * owns the returned instance; extension code cannot choose or forge that owner identity.
 */
export interface SurfaceLocalExternalServiceFactory {
  create(
    owner: Readonly<SurfaceOwnerIdentity>,
  ): SurfaceExternalService | Promise<SurfaceExternalService>;
  descriptor: VarinExtensionServiceProvision;
  providerId: string;
  providerKey: string;
}

/**
 * Public, framework-neutral value exposed for a manifest-declared contribution.
 * Consumers render the descriptor's JSON data through a public contribution-kind adapter; this
 * value is deliberately not a renderer function or a product-private component handle.
 */
export interface DeclarativeSurfaceContributionImplementation {
  readonly descriptor: VarinExtensionStaticContribution;
  readonly kind: "declarative";
}

interface BoundSurfaceServiceLease {
  providers: VarinExtensionServiceProviderSnapshot[];
  identity: VarinSurfaceServiceInvocationLease;
  signal: AbortSignal;
  dispose: SurfaceDisposer;
}

interface SurfaceDependency {
  descriptor: VarinExtensionServiceProvision;
  providerId: string;
  providerKey: string;
  kind: "host" | "native" | "factory" | "surface";
}

function resolveSurfaceRequirement(requirement: VarinExtensionServiceRequirement, all: SurfaceDependency[],
  state: VarinExtensionHostStateSnapshot, routing: VarinExtensionServiceRoutingContext): SurfaceDependency[] {
  const candidates = all.filter(value => value.descriptor.id === requirement.id && value.descriptor.version === requirement.version);
  const key = `${requirement.id}@${requirement.version}`;
  if (requirement.binding === "all") {
    if (!candidates.length && !requirement.optional) throw new Error(`Required Surface service is unavailable: ${key}`);
    return candidates;
  }
  if (requirement.binding !== "selected") {
    if (candidates.length === 1 || (!candidates.length && requirement.optional)) return candidates;
    throw new Error(`Surface service must have exactly one implementation: ${key}`);
  }
  const resolution = resolveVarinExtensionServiceRouting({ candidates, context: routing,
    document: state.routing.document, serviceId: requirement.id, version: requirement.version });
  if (resolution.status === "unavailable" && !candidates.length && requirement.optional && !resolution.matchedRule
    && !resolution.diagnostics.some(value => value.code.startsWith("service_selection_"))) return [];
  if (resolution.status !== "resolved" || resolution.providerIds.length !== 1) {
    throw new Error(resolution.diagnostics.map(value => value.message).join("; "));
  }
  return resolution.providerIds.map(id => candidates.find(value => value.providerId === id)!);
}

interface ActiveEntrypoint {
  artifactIntegrity: string;
  capabilityBindings: string;
  mode: VarinExtensionSurfaceEntrypoint["mode"];
  moduleGeneration: number;
  owner: SurfaceOwnerIdentity;
  serviceBindings: string;
}

interface ArtifactSelection {
  capabilityGrants: VarinExtensionCapabilityGrant[];
  integrity: string;
  manifest: VarinExtensionManifest;
  slot: "candidate" | "selected";
  version: string;
}

interface PendingPreparation {
  controller: AbortController;
  desiredRevision: number;
  hostId: string;
  integrity: string;
  capabilityBindings: string;
  serviceBindings: string;
}

type ExecutableSurfaceEntrypoint = VarinExtensionSurfaceEntrypoint & {
  mode: Exclude<VarinExtensionSurfaceEntrypoint["mode"], "declarative">;
};

interface SurfaceActivationPlan {
  contributions: VarinExtensionStaticContribution[];
  entrypoint?: ExecutableSurfaceEntrypoint;
  entrypointId: string;
  mode: VarinExtensionSurfaceEntrypoint["mode"];
}

interface CompatibleSurfacePlans {
  executable: SurfaceActivationPlan[];
  incompatible: VarinExtensionStaticContribution[];
  manifest?: SurfaceActivationPlan;
}

const keyFor = (extensionId: string, entrypointId: string): string => `${extensionId}\0${entrypointId}`;

const defaultRealmId = (): string => (
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `surface-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const defaultWatchRetry = (attempt: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  // This is transport backoff, not a lifecycle timeout or retry ceiling. A healthy Host-state
  // response resets it immediately; repeated failures never make the watcher give up.
  const delayMs = Math.min(10_000, 250 * (2 ** Math.min(attempt - 1, 6)));
  const timeout = setTimeout(done, delayMs);
  const onAbort = () => done();
  function done(): void {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    resolve();
  }
  signal.addEventListener("abort", onAbort, { once: true });
});

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return `sha256-${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

const verifyAsset = async (
  value: VarinExtensionAssetPayload,
  expectedArtifactIntegrity: string,
): Promise<{ bytes: Uint8Array; payload: VarinExtensionAssetPayload }> => {
  const payload = parseVarinExtensionAssetPayload(value);
  if (payload.artifactIntegrity !== expectedArtifactIntegrity) {
    throw new Error("Surface asset belongs to another extension artifact generation");
  }
  const bytes = decodeBase64(payload.bytesBase64);
  if (await sha256(bytes) !== payload.integrity) throw new Error(`Surface asset integrity failed: ${payload.path}`);
  return { bytes, payload };
};

export const evaluateManagedSurfaceModule: ManagedSurfaceModuleEvaluator = (source, identity) => {
  const module = { exports: {} as unknown };
  const sourceUrl = `varin-extension://${identity.extensionId}/${identity.integrity}/${identity.entrypointId}`;
  const evaluate = new Function("module", "exports", `${source}\n//# sourceURL=${sourceUrl}`) as (
    module: { exports: unknown },
    exports: unknown,
  ) => void;
  evaluate(module, module.exports);
  return module.exports as VarinManagedSurfaceModule;
};

const defaultStyleHost: ManagedStyleHost = {
  stage: (cssText, ownerLabel) => {
    if (typeof document === "undefined") return { commit: () => undefined, dispose: () => undefined };
    const element = document.createElement("style");
    element.dataset.varinExtensionOwner = ownerLabel;
    element.media = "not all";
    element.textContent = cssText;
    document.head.appendChild(element);
    return {
      validate: () => { if (!element.isConnected) throw new Error("Staged Surface style was detached before publication"); },
      commit: () => { element.media = "all"; },
      dispose: () => element.remove(),
    };
  },
};

class ModuleResourceScope {
  readonly #artifactIntegrity: string;
  readonly #disposers: Array<() => void> = [];
  readonly #host: SurfaceExtensionHost;
  readonly #identity: { extensionId: string; integrity: string; slot: "candidate" | "selected" };
  readonly #styleHost: ManagedStyleHost;
  readonly #styles: ManagedStyleHandle[] = [];
  #disposed = false;

  constructor(options: {
    artifactIntegrity: string;
    extensionId: string;
    host: SurfaceExtensionHost;
    slot: "candidate" | "selected";
    styleHost: ManagedStyleHost;
  }) {
    this.#artifactIntegrity = options.artifactIntegrity;
    this.#host = options.host;
    this.#identity = { extensionId: options.extensionId, integrity: options.artifactIntegrity, slot: options.slot };
    this.#styleHost = options.styleHost;
  }

  async stageBundledStyles(styles: VarinExtensionAssetPayload[]): Promise<void> {
    for (const style of styles) {
      const verified = await verifyAsset(style, this.#artifactIntegrity);
      this.#stageStyle(new TextDecoder().decode(verified.bytes), verified.payload.path);
    }
  }

  context(base: SurfaceActivationContext): VarinManagedSurfaceContext {
    return {
      ...base,
      assets: {
        read: (path) => this.#read(path),
        url: async (path) => {
          const asset = await this.#read(path);
          const url = URL.createObjectURL(new Blob([asset.bytes.slice().buffer], { type: asset.contentType }));
          this.#disposers.push(() => URL.revokeObjectURL(url));
          return url;
        },
      },
      styles: {
        use: async (path) => {
          const asset = await this.#read(path);
          this.#stageStyle(new TextDecoder().decode(asset.bytes), asset.path);
        },
      },
    };
  }

  commit(): void {
    if (this.#disposed) throw new Error("Cannot commit disposed managed Surface resources");
    for (const style of this.#styles) style.commit();
  }

  validate(): void {
    if (this.#disposed) throw new Error("Managed Surface resources were disposed before publication");
    for (const style of this.#styles) style.validate?.();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const style of this.#styles.reverse()) style.dispose();
    for (const dispose of this.#disposers.reverse()) dispose();
  }

  async #read(path: string): Promise<VarinSurfaceAsset> {
    if (this.#disposed) throw new Error("Managed Surface resource owner is inactive");
    const verified = await verifyAsset(await this.#host.readAsset({ ...this.#identity, path }), this.#artifactIntegrity);
    if (this.#disposed) throw new Error("Managed Surface resource owner is inactive");
    return {
      bytes: verified.bytes,
      contentType: verified.payload.contentType,
      integrity: verified.payload.integrity,
      path: verified.payload.path,
    };
  }

  #stageStyle(cssText: string, path: string): void {
    if (this.#disposed) throw new Error("Managed Surface resource owner is inactive");
    this.#styles.push(this.#styleHost.stage(cssText, `${this.#identity.extensionId}:${path}`));
  }
}

const publicCandidateSelection = (entry: VarinExtensionCatalogEntry): ArtifactSelection | null => {
  if (!entry.integrity) return null;
  return {
    capabilityGrants: entry.capabilityGrants,
    integrity: entry.integrity,
    manifest: entry.manifest,
    slot: "selected",
    version: entry.selectedVersion,
  };
};

const explicitCandidateSelection = (
  entry: VarinExtensionCatalogEntry,
  integrity: string,
): ArtifactSelection => {
  const candidate = entry.candidate;
  if (!candidate || candidate.integrity !== integrity) {
    throw new Error(`Varin extension candidate is no longer current: ${entry.manifest.id}`);
  }
  if (!candidate.capabilitiesReviewed) {
    throw new Error(`Varin extension candidate capability changes require review: ${entry.manifest.id}`);
  }
  return {
    capabilityGrants: candidate.capabilityGrants,
    integrity: candidate.integrity,
    manifest: candidate.manifest,
    slot: "candidate",
    version: candidate.resolvedVersion,
  };
};

/** Only an explicitly requested group may make the ordinary watcher prepare an unselected artifact. */
const requestedGroupSelection = (entry: VarinExtensionCatalogEntry, surface: VarinApplicationSurface): ArtifactSelection | null => {
  const candidate = entry.candidate;
  const group = candidate?.manifest.updateReadiness;
  if (!candidate?.applyRequested || !candidate.capabilitiesReviewed || !group) return null;
  if (!group.surfaceEntrypoints.every((id) => candidate.manifest.entrypoints?.surfaces
    ?.some((entrypoint) => entrypoint.id === id && entrypoint.supports.includes(surface)))) return null;
  return explicitCandidateSelection(entry, candidate.integrity);
};

const selectionCapabilities = (selection: ArtifactSelection): string[] => selection.capabilityGrants
  .filter((grant) => grant.realm === "surface" && grant.granted && grant.manifestVersion === selection.version)
  .map((grant) => grant.capability);

const compatibleActivationPlans = (
  manifest: VarinExtensionManifest,
  surface: VarinApplicationSurface,
): CompatibleSurfacePlans => {
  const compatibleEntrypoints = (manifest.entrypoints?.surfaces ?? [])
    .filter((entrypoint) => entrypoint.supports.includes(surface));
  const compatibleEntrypointIds = new Set(compatibleEntrypoints.map((entrypoint) => entrypoint.id));
  const groupedIds = new Set(manifest.updateReadiness?.surfaceEntrypoints ?? []);
  const executable = new Map<string, SurfaceActivationPlan>();
  for (const entrypoint of compatibleEntrypoints) {
    if (entrypoint.mode === "declarative" && !groupedIds.has(entrypoint.id)) continue;
    executable.set(entrypoint.id, {
      contributions: [],
      ...(entrypoint.mode !== "declarative" ? { entrypoint: entrypoint as ExecutableSurfaceEntrypoint } : {}),
      entrypointId: entrypoint.id,
      mode: entrypoint.mode,
    });
  }
  const manifestOwner = resolveVarinSurfaceManifestOwner(manifest, surface);
  const incompatible: VarinExtensionStaticContribution[] = [];
  // Track which entrypoints have at least one incompatible static contribution
  // and which have at least one compatible static contribution.
  const entrypointHasIncompatible = new Set<string>();
  const entrypointHasCompatible = new Set<string>();
  // Incompatible contributions are retained in the static (declarative) plan
  // so the catalog preserves the record, but they are NOT attached to
  // executable entrypoint plans — their module code is not executed for them
  // and they are not registered via context.contribute(). The Surface runtime's
  // selectVisibleContributions also filters them as a defense-in-depth measure.
  for (const contribution of manifest.contributions ?? []) {
    if (!contribution.supports.includes(surface)) continue;
    const compatible = isVarinContributionCompatible(contribution.kind, contribution.contractVersion);
    if (!compatible) incompatible.push(contribution);
    if (contribution.entrypoint) {
      if (!compatibleEntrypointIds.has(contribution.entrypoint)) continue;
      // Only attach compatible contributions to executable plans
      if (compatible) {
        executable.get(contribution.entrypoint)?.contributions.push(contribution);
        entrypointHasCompatible.add(contribution.entrypoint);
      } else {
        entrypointHasIncompatible.add(contribution.entrypoint);
      }
      continue;
    }
  }
  // Remove eager executable plans where ALL static contributions are
  // incompatible. An eager entrypoint whose every declared contribution is
  // incompatible would execute its module for no visible effect — the module
  // might still contribute dynamically, but the manifest has declared that
  // every static contribution it owns uses an unsupported contract version.
  // Entrypoints with no static contributions at all are retained (they may
  // contribute dynamically). Lazy entrypoints are retained (they may
  // contribute when triggered).
  const executablePlans = [...executable.values()].filter((plan) => {
    if (groupedIds.has(plan.entrypointId)) return true;
    if (plan.contributions.length > 0) return true;
    if (!plan.entrypoint) return true;
    // Has this entrypoint been declared with contributions, all incompatible?
    if (entrypointHasIncompatible.has(plan.entrypointId) && !entrypointHasCompatible.has(plan.entrypointId)) {
      return !entrypointIsEager(plan.entrypoint);
    }
    return true;
  });
  return {
    executable: executablePlans,
    incompatible,
    ...(manifestOwner
      ? {
          manifest: {
            ...manifestOwner,
            mode: "declarative",
          },
        }
      : {}),
  };
};

const entrypointIsEager = (entrypoint: ExecutableSurfaceEntrypoint): boolean => (
  !entrypoint.activation
  || entrypoint.activation.length === 0
  || entrypoint.activation.includes("application-startup")
  || entrypoint.activation.includes("background")
);

const planIsRequested = (plan: SurfaceActivationPlan): boolean => (
  !plan.entrypoint || entrypointIsEager(plan.entrypoint)
);

const isGroupedCandidate = (selection: ArtifactSelection): boolean => (
  selection.slot === "candidate" && selection.manifest.updateReadiness !== undefined
);

const isGroupMember = (plan: SurfaceActivationPlan, selection: ArtifactSelection): boolean => (
  selection.manifest.updateReadiness?.surfaceEntrypoints.includes(plan.entrypointId) === true
);

const targetMatchesPlan = (
  manifest: VarinExtensionManifest,
  plan: SurfaceActivationPlan,
  target: SurfaceActivationTarget,
): boolean => {
  if (target.extensionId && target.extensionId !== manifest.id) return false;
  if (target.entrypointId && target.entrypointId !== plan.entrypointId) return false;
  if (!target.contributionId) return true;
  return (manifest.contributions ?? []).some((contribution) => (
    contribution.id === target.contributionId && contribution.entrypoint === plan.entrypointId
  ));
};

const declarativeImplementation = (
  descriptor: VarinExtensionStaticContribution,
): DeclarativeSurfaceContributionImplementation => ({
  descriptor: structuredClone(descriptor),
  kind: "declarative",
});

const toReportedActual = (state: ReturnType<SurfaceExtensionRuntime["getSnapshot"]>["actual"][number]): VarinExtensionActualState => ({
  desiredRevision: state.desiredRevision,
  diagnostics: state.diagnostics,
  entrypointId: state.entrypointId,
  generation: state.generation,
  hostId: state.hostId,
  realmId: state.realmId,
  realmKind: state.realmKind,
  status: state.status,
  updatedAt: state.updatedAt,
});

export class SurfaceExtensionLoader {
  readonly #accessContext: (state?: VarinExtensionHostStateSnapshot) => SurfaceCapabilityAccessContext;
  readonly #active = new Map<string, ActiveEntrypoint>();
  readonly #capabilities: SurfaceCapabilityRegistry;
  readonly #diagnostics: SurfaceExtensionLoaderDiagnostic[] = [];
  readonly #evaluate: ManagedSurfaceModuleEvaluator;
  readonly #externalServiceFactories: readonly SurfaceLocalExternalServiceFactory[];
  readonly #failedCandidates = new Set<string>();
  readonly #generations = new Map<string, number>();
  readonly #host: SurfaceExtensionHost;
  readonly #isolatedRealmFactory: IsolatedSurfaceRealmFactory;
  readonly #listeners = new Set<() => void>();
  readonly #nativeRestartRequired = new Set<string>();
  readonly #realmId: string;
  readonly #styleHost: ManagedStyleHost;
  readonly #surface: VarinApplicationSurface;
  readonly #surfaceRuntime: SurfaceExtensionRuntime;
  readonly #triggered = new Set<string>();
  readonly #watchRetry: (attempt: number, signal: AbortSignal) => Promise<void>;
  readonly #enabledExtensions = new Set<string>();
  #hostId: string | null = null;
  readonly #ownerQueues = new Map<string, Promise<void>>();
  readonly #preparations = new Map<string, PendingPreparation>();
  readonly #reconcileRequests = new Map<string, { snapshot: VarinExtensionCatalogSnapshot; state: VarinExtensionHostStateSnapshot }>();
  readonly #reconciliations = new Map<string, Promise<void>>();
  #lifecycleEpoch = 0;
  #stopped = false;
  #revision = 0;
  #hostStateRevision = 0;
  #watchController: AbortController | null = null;

  constructor(options: SurfaceExtensionLoaderOptions) {
    this.#accessContext = (state) => {
      const provided = options.accessContext?.(state);
      return {
        access: provided?.access ?? (options.surface === "desktop" ? "local" : "remote"),
        projectTrusted: provided?.projectTrusted ?? false,
        surface: options.surface,
        routing: { ...(state ? { profileId: resolveVarinWorkbenchProfile(state.workbench.document, state.catalog,
          { surface: options.surface, userId: provided?.routing?.userId ?? "default" }).profileId } : {}),
          ...structuredClone(provided?.routing ?? {}) },
      };
    };
    this.#capabilities = options.capabilities ?? new SurfaceCapabilityRegistry();
    this.#evaluate = options.evaluateModule ?? evaluateManagedSurfaceModule;
    this.#externalServiceFactories = [...(options.externalServiceFactories ?? [])];
    const factoryKeys = new Set<string>();
    for (const factory of this.#externalServiceFactories) {
      if (!factory.providerKey.trim() || !factory.providerId.trim() || factoryKeys.has(factory.providerKey)) {
        throw new Error(`Surface service factory requires a unique stable provider key: ${factory.descriptor.id}@${factory.descriptor.version}`);
      }
      factoryKeys.add(factory.providerKey);
    }
    this.#host = options.host;
    this.#isolatedRealmFactory = options.isolatedRealmFactory ?? browserIsolatedSurfaceRealmFactory;
    this.#realmId = options.realmId ?? defaultRealmId();
    this.#styleHost = options.styleHost ?? defaultStyleHost;
    this.#surface = options.surface;
    this.#surfaceRuntime = options.surfaceRuntime;
    this.#watchRetry = options.watchRetry ?? defaultWatchRetry;
  }

  /** Read-only view of the actual injected factories, shared with provider-choice presentation. */
  getLocalServiceDeclarations(): ReadonlyArray<Pick<SurfaceLocalExternalServiceFactory, "descriptor" | "providerId" | "providerKey">> {
    return this.#externalServiceFactories.map(({ descriptor, providerId, providerKey }) => ({ descriptor: structuredClone(descriptor), providerId, providerKey }));
  }

  getSnapshot = (): SurfaceExtensionLoaderSnapshot => ({
    active: [...this.#active.values()].filter((entry) => entry.mode !== "declarative").map((entry) => ({
      entrypointId: entry.owner.entrypointId,
      extensionId: entry.owner.extensionId,
      extensionVersion: entry.owner.extensionVersion,
      integrity: entry.artifactIntegrity,
      moduleGeneration: entry.moduleGeneration,
    })).sort((left, right) => left.extensionId.localeCompare(right.extensionId) || left.entrypointId.localeCompare(right.entrypointId)),
    diagnostics: this.#diagnostics.map((item) => ({ ...item })),
    hostId: this.#hostId,
    revision: this.#revision,
  });

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async reconcile(availability?: VarinExtensionCatalogAvailability): Promise<void> {
    if (this.#stopped) return;
    const state = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
    if (!availability) return this.#reconcileSnapshot(state.catalog, state);
    const result = parseVarinExtensionCatalogAvailability(availability);
    if (result.supported === true && result.status === "ready") await this.#reconcileSnapshot(result.snapshot, state);
  }

  triggerActivation(
    event: VarinExtensionActivationEvent,
    target: SurfaceActivationTarget = {},
  ): Promise<void> {
    const operation = async () => {
      const state = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
      if (!state.catalog.authoritative) return;
      const matchedKeys: string[] = [];
      let newlyTriggered = false;
      for (const entry of state.catalog.extensions) {
        if (entry.source.kind === "builtin" || !entry.desired.enabled) continue;
        const selection = publicCandidateSelection(entry);
        if (!selection) continue;
        const plans = compatibleActivationPlans(selection.manifest, this.#surface);
        for (const plan of plans.executable) {
          const entrypoint = plan.entrypoint;
          if (!entrypoint) continue;
          if (!entrypoint.activation?.includes(event)) continue;
          if (!targetMatchesPlan(selection.manifest, plan, target)) continue;
          const key = keyFor(entry.manifest.id, plan.entrypointId);
          if (!this.#triggered.has(key)) newlyTriggered = true;
          this.#triggered.add(key);
          matchedKeys.push(key);
        }
      }
      if (newlyTriggered || matchedKeys.length > 0) {
        await this.#reconcileSnapshot(state.catalog, state, target.extensionId);
      }
      const inactive = matchedKeys.filter((key) => !this.#active.has(key));
      if (inactive.length > 0) {
        throw new Error(`Surface activation did not become active for event ${event}`);
      }
    };
    return operation();
  }

  applyCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const operation = async (): Promise<VarinExtensionCatalogSnapshot> => {
      if (this.#stopped) throw new Error("Surface extension loader is stopped");
      const state = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
      let snapshot = state.catalog;
      if (!snapshot.authoritative) throw new Error("Cannot apply a candidate from a stale extension catalog");
      let entry = snapshot.extensions.find((candidate) => candidate.manifest.id === extensionId);
      if (!entry) throw new Error(`Varin extension is not installed: ${extensionId}`);
      if (entry.integrity !== candidateIntegrity) {
        if (snapshot.revision !== expectedRevision) {
          throw new Error(`Extension catalog revision conflict: expected ${expectedRevision}, actual ${snapshot.revision}`);
        }
        explicitCandidateSelection(entry, candidateIntegrity);
        snapshot = parseVarinExtensionCatalogSnapshot(await this.#host.requestCandidateApplication({
          candidateIntegrity, expectedRevision, extensionId,
        }));
        entry = snapshot.extensions.find((candidate) => candidate.manifest.id === extensionId);
        if (!entry) throw new Error(`Varin extension is not installed: ${extensionId}`);
      }
      const selection = entry.integrity === candidateIntegrity
        ? publicCandidateSelection(entry) as ArtifactSelection
        : explicitCandidateSelection(entry, candidateIntegrity);
      this.#hostId ??= snapshot.hostId;
      const plans = compatibleActivationPlans(selection.manifest, this.#surface);
      const executablePlans = plans.executable.filter((plan) => isGroupedCandidate(selection) ? isGroupMember(plan, selection) : (
        planIsRequested(plan)
        || this.#triggered.has(keyFor(extensionId, plan.entrypointId))
        || this.#active.has(keyFor(extensionId, plan.entrypointId))
      ));
      const hasActiveOwners = [...this.#active.values()].some((active) => active.owner.extensionId === extensionId);
      let committed: VarinExtensionCatalogSnapshot | null = null;
      try {
        if (!entry.desired.enabled) {
          committed = parseVarinExtensionCatalogSnapshot(await this.#host.selectCandidate({
            candidateIntegrity,
            expectedRevision: snapshot.revision,
            extensionId,
          }));
        } else if (plans.manifest || executablePlans.length > 0 || hasActiveOwners) {
          committed = await this.#activatePlans(entry, selection, plans, executablePlans, executablePlans, snapshot);
          if (!committed && selection.slot === "selected") committed = snapshot;
        } else {
          await this.#host.prepareCandidate(extensionId, candidateIntegrity);
          committed = parseVarinExtensionCatalogSnapshot(await this.#host.selectCandidate({
            candidateIntegrity,
            expectedRevision: snapshot.revision,
            extensionId,
          }));
        }
        if (!committed) throw new Error(`Varin extension candidate was not committed: ${extensionId}`);
        const retained = new Set(entry.desired.enabled
          ? [
              ...(plans.manifest ? [keyFor(extensionId, plans.manifest.entrypointId)] : []),
              ...executablePlans.map((plan) => keyFor(extensionId, plan.entrypointId)),
            ]
          : []);
        for (const [key, active] of [...this.#active]) {
          if (!isGroupedCandidate(selection) && active.owner.extensionId === extensionId && !retained.has(key)) {
            await this.#deactivate(active, entry.desired.revision);
          }
        }
        this.#failedCandidates.delete(`${extensionId}\0${candidateIntegrity}\0${entry.desired.revision}`);
        this.#revision = committed.revision;
        this.#publish();
        return committed;
      } catch (error) {
        if (
          selection.manifest.entrypoints?.host?.mode === "native"
          && error instanceof Error
          && error.message.includes("requires an application-host restart")
        ) {
          this.#revision = snapshot.revision;
          this.#publish();
          return snapshot;
        }
        await this.#host.discardPreparedCandidate(extensionId, candidateIntegrity).catch(() => undefined);
        this.#diagnose(
          extensionId,
          "candidate_application_failed",
          error instanceof Error ? error.message : String(error),
          { integrity: candidateIntegrity },
        );
        this.#publish();
        throw error;
      }
    };
    return this.#enqueueOwner(extensionId, operation);
  }

  async start(): Promise<void> {
    if (this.#watchController) return;
    this.#stopped = false;
    const controller = new AbortController();
    this.#watchController = controller;
    const initial = this.reconcile();
    void this.#watch(controller).catch((error) => {
      if (!controller.signal.aborted) {
        this.#diagnose("varin.extensions", "host_state_watch_failed", error instanceof Error ? error.message : String(error));
        this.#publish();
      }
      if (this.#watchController === controller) this.#watchController = null;
    });
    try {
      await initial;
    } catch (error) {
      this.#diagnose(
        "varin.extensions",
        "host_state_initial_reconcile_failed",
        error instanceof Error ? error.message : String(error),
      );
      this.#publish();
    }

  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#lifecycleEpoch += 1;
    for (const preparation of this.#preparations.values()) preparation.controller.abort(new Error("Surface extension loader stopped"));
    this.#reconcileRequests.clear();
    this.#watchController?.abort("Surface extension loader stopped");
    this.#watchController = null;
    await Promise.all([...this.#ownerQueues.keys()].map((extensionId) => this.#enqueueOwner(extensionId, async () => {
      await Promise.all([...this.#active.values()].filter((active) => active.owner.extensionId === extensionId)
        .map((active) => this.#deactivate(active, active.owner.desiredRevision)));
    })));
    await this.deactivateAll();
  }

  async deactivateAll(): Promise<void> {
    this.#lifecycleEpoch += 1;
    for (const preparation of this.#preparations.values()) preparation.controller.abort(new Error("Surface owners were withdrawn"));
    await Promise.all([...this.#active.values()].map((entry) => this.#deactivate(entry, entry.owner.desiredRevision)));
    this.#publish();
  }

  async #reconcileSnapshot(
    snapshotValue: VarinExtensionCatalogSnapshot,
    hostState: VarinExtensionHostStateSnapshot,
    onlyExtensionId?: string,
  ): Promise<void> {
    const snapshot = parseVarinExtensionCatalogSnapshot(snapshotValue);
    if (!snapshot.authoritative || this.#stopped) return;
    if (snapshot.hostId === this.#hostId && (snapshot.revision < this.#revision || hostState.revision < this.#hostStateRevision)) return;
    // Watch notifications fence a waiting RPC immediately, rather than sitting behind the same
    // owner's preparation queue. Promotion of this exact artifact is already a committed fact.
    for (const [id, preparation] of this.#preparations) {
      const entry = snapshot.extensions.find((candidate) => candidate.manifest.id === id);
      const selection = entry && (entry.integrity === preparation.integrity ? publicCandidateSelection(entry)
        : entry.candidate?.integrity === preparation.integrity && entry.candidate.capabilitiesReviewed
          ? explicitCandidateSelection(entry, preparation.integrity) : null);
      const access = this.#accessContext(hostState);
      let superseded = snapshot.hostId !== preparation.hostId || !entry?.desired.enabled
        || entry.desired.revision !== preparation.desiredRevision || !selection
        || preparation.capabilityBindings !== this.#capabilityBindingSignature(
          selectionCapabilities(selection), access,
        );
      if (!superseded && selection) {
        try { superseded = preparation.serviceBindings !== this.#serviceBindingSignature(selection, hostState); }
        catch { superseded = true; }
      }
      if (superseded) preparation.controller.abort(new Error("Surface preparation was superseded by Host, desired state, artifact, access, or dependency changes"));
    }
    if (this.#hostId && this.#hostId !== snapshot.hostId) {
      this.#lifecycleEpoch += 1;
      this.#triggered.clear();
      this.#failedCandidates.clear();
      this.#enabledExtensions.clear();
    }
    this.#hostId = snapshot.hostId;
    this.#hostStateRevision = hostState.revision;
    this.#revision = snapshot.revision;
    const enabled = new Set(snapshot.extensions.filter((entry) => entry.source.kind !== "builtin" && entry.desired.enabled)
      .map((entry) => entry.manifest.id));
    for (const id of this.#enabledExtensions) if (!enabled.has(id)) this.#clearTriggered(id);
    this.#enabledExtensions.clear();
    for (const id of enabled) this.#enabledExtensions.add(id);
    const ids = new Set([...snapshot.extensions.map((entry) => entry.manifest.id),
      ...[...this.#active.values()].map((entry) => entry.owner.extensionId), ...this.#reconciliations.keys()]);
    await Promise.all([...ids].filter((id) => !onlyExtensionId || id === onlyExtensionId).map((id) => {
      this.#reconcileRequests.set(id, { snapshot, state: hostState });
      const running = this.#reconciliations.get(id);
      if (running) return running;
      const operation = this.#enqueueOwner(id, async () => {
        try {
          while (!this.#stopped) {
            const next = this.#reconcileRequests.get(id);
            if (!next) break;
            this.#reconcileRequests.delete(id);
            await this.#reconcileOwnerSnapshot(next.snapshot, next.state, id);
          }
        } finally {
          // Drop the coalescing handle in the same turn as the final empty check. A request
          // arriving after completion must create a new drain rather than attach to a settled one.
          if (this.#reconciliations.get(id) === operation) this.#reconciliations.delete(id);
        }
      });
      this.#reconciliations.set(id, operation);
      return operation;
    }));
    this.#publish();
  }

  async #reconcileOwnerSnapshot(
    snapshot: VarinExtensionCatalogSnapshot,
    hostState: VarinExtensionHostStateSnapshot,
    extensionId: string,
  ): Promise<void> {
    if (snapshot.hostId !== this.#hostId || this.#stopped) return;
    const entries = snapshot.extensions.filter((entry) => entry.manifest.id === extensionId);
    const desiredKeys = new Set<string>();

    for (const entry of entries) {
      if (entry.source.kind === "builtin") continue;
      const selected = publicCandidateSelection(entry);
      if (!entry.desired.enabled || !selected) continue;
      const plans = compatibleActivationPlans(selected.manifest, this.#surface);
      for (const contribution of plans.incompatible) {
        const compatibility = checkVarinContributionCompatibility(
          contribution.kind,
          contribution.contractVersion,
        );
        if (compatibility.status !== "unsupported-contract-version") continue;
        this.#diagnose(
          entry.manifest.id,
          "unsupported-contract-version",
          `Contribution ${contribution.id} declares unsupported ${contribution.kind} contract version ${contribution.contractVersion}; supported versions: ${compatibility.supportedVersions.join(", ")}`,
          contribution.entrypoint ? { entrypointId: contribution.entrypoint } : {},
          "warning",
        );
      }
      if (plans.manifest) desiredKeys.add(keyFor(entry.manifest.id, plans.manifest.entrypointId));
      for (const plan of plans.executable) {
        const key = keyFor(entry.manifest.id, plan.entrypointId);
        if (
          planIsRequested(plan)
          || this.#triggered.has(key)
          || this.#active.has(key)
        ) desiredKeys.add(key);
      }
    }
    for (const [key, active] of [...this.#active]) {
      if (active.owner.extensionId !== extensionId) continue;
      const entry = snapshot.extensions.find((candidate) => candidate.manifest.id === active.owner.extensionId);
      if (!entry || !entry.desired.enabled || (!desiredKeys.has(key) && entry.integrity === active.artifactIntegrity) || active.owner.hostId !== snapshot.hostId) {
        await this.#deactivate(active, entry?.desired.revision ?? active.owner.desiredRevision + 1);
      }
    }

    for (const entry of entries) {
      if (entry.source.kind === "builtin") continue;
      if (!entry.desired.enabled) continue;
      const selected = requestedGroupSelection(entry, this.#surface) ?? publicCandidateSelection(entry);
      if (!selected) {
        this.#diagnose(entry.manifest.id, "artifact_unavailable", "Surface extension has no content-addressed artifact");
        continue;
      }
      const plans = compatibleActivationPlans(selected.manifest, this.#surface);
      const executablePlans = plans.executable.filter((plan) => {
        if (isGroupedCandidate(selected)) return isGroupMember(plan, selected);
        const key = keyFor(entry.manifest.id, plan.entrypointId);
        return planIsRequested(plan)
          || this.#triggered.has(key)
          || this.#active.has(key);
      });
      const desiredPlans = [...(plans.manifest && !isGroupedCandidate(selected) ? [plans.manifest] : []), ...executablePlans];
      if (desiredPlans.length === 0) {
        await this.#ensureInactivePlans(entry, selected, plans.executable, snapshot.hostId);
        continue;
      }
      const failedKey = `${entry.manifest.id}\0${selected.integrity}\0${entry.desired.revision}`;
      if (selected.slot === "candidate" && this.#failedCandidates.has(failedKey)) continue;
      if (executablePlans.some((plan) => plan.mode === "native") && this.#nativeRestartRequired.has(entry.manifest.id)) continue;
      let expectedBindings: string;
      try { expectedBindings = this.#serviceBindingSignature(selected, hostState); }
      catch (error) {
        this.#diagnose(entry.manifest.id, "service_composition_unavailable", error instanceof Error ? error.message : String(error));
        continue;
      }
      const accessContext = this.#accessContext(hostState);
      const grantedCapabilities = this.#capabilities.resolveGranted(selectionCapabilities(selected), accessContext);
      const expectedCapabilityBindings = this.#capabilityBindingSignature(grantedCapabilities, accessContext);
      const currentEntrypoints = desiredPlans
        .map((plan) => this.#active.get(keyFor(entry.manifest.id, plan.entrypointId)))
        .filter((value): value is ActiveEntrypoint => value !== undefined);
      const missingContributionCapabilities = [...new Set(desiredPlans
        .flatMap((plan) => plan.contributions)
        .flatMap((contribution) => contribution.requiresCapabilities ?? []))]
        .filter((capability) => !grantedCapabilities.includes(capability));
      if (currentEntrypoints.length > 0 && selected.slot === "selected" && missingContributionCapabilities.length > 0) {
        for (const active of currentEntrypoints) await this.#deactivate(active, entry.desired.revision);
        this.#diagnose(
          entry.manifest.id,
          "required_surface_capability_withdrawn",
          `Required Surface capabilities are no longer available: ${missingContributionCapabilities.join(", ")}`,
        );
        continue;
      }
      const allCurrent = desiredPlans.every((plan) => (
        this.#active.get(keyFor(entry.manifest.id, plan.entrypointId))?.artifactIntegrity === selected.integrity
        && this.#active.get(keyFor(entry.manifest.id, plan.entrypointId))?.capabilityBindings === expectedCapabilityBindings
        && this.#active.get(keyFor(entry.manifest.id, plan.entrypointId))?.serviceBindings === expectedBindings
      ));
      if (allCurrent) {
        await this.#ensureInactivePlans(entry, selected, plans.executable.filter((plan) => !executablePlans.includes(plan)), snapshot.hostId);
        continue;
      }
      try {
        const executablePlansToActivate = executablePlans.filter((plan) => {
          const active = this.#active.get(keyFor(entry.manifest.id, plan.entrypointId));
          return active?.artifactIntegrity !== selected.integrity
            || active.capabilityBindings !== expectedCapabilityBindings
            || active.serviceBindings !== expectedBindings;
        });
        const selection = await this.#activatePlans(
          entry,
          selected,
          plans,
          executablePlans,
          executablePlansToActivate,
          snapshot,
        );
        if (selection) {
          this.#revision = Math.max(this.#revision, selection.revision);
          const retained = new Set(desiredPlans.map((plan) => keyFor(entry.manifest.id, plan.entrypointId)));
          for (const [key, active] of [...this.#active]) {
            if (!isGroupedCandidate(selected) && active.owner.extensionId === entry.manifest.id && !retained.has(key)) {
              await this.#deactivate(active, entry.desired.revision);
            }
          }
        }
        await this.#ensureInactivePlans(entry, selected, plans.executable.filter((plan) => !executablePlans.includes(plan)), snapshot.hostId);
      } catch (error) {
        if (selected.slot === "candidate") this.#failedCandidates.add(failedKey);
        if (selected.slot === "candidate") {
          await this.#host.discardPreparedCandidate(entry.manifest.id, selected.integrity).catch(() => undefined);
        }
        this.#diagnose(
          entry.manifest.id,
          selected.slot === "candidate" ? "candidate_module_activation_failed" : "module_activation_failed",
          error instanceof Error ? error.message : String(error),
          { integrity: selected.integrity },
        );
      }
    }
    this.#revision = Math.max(this.#revision, snapshot.revision);
    this.#publish();
  }

  async #activatePlans(
    entry: VarinExtensionCatalogEntry,
    selection: ArtifactSelection,
    compatible: CompatibleSurfacePlans,
    desiredExecutablePlans: SurfaceActivationPlan[],
    executablePlansToActivate: SurfaceActivationPlan[],
    snapshot: VarinExtensionCatalogSnapshot,
  ): Promise<VarinExtensionCatalogSnapshot | null> {
    const lifecycleEpoch = this.#lifecycleEpoch;
    const groupedCandidate = isGroupedCandidate(selection);
    let currentHostState = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
    const initialAccess = this.#accessContext(currentHostState);
    const preparation: PendingPreparation = {
      controller: new AbortController(),
      desiredRevision: entry.desired.revision,
      hostId: snapshot.hostId,
      integrity: selection.integrity,
      capabilityBindings: this.#capabilityBindingSignature(selectionCapabilities(selection), initialAccess),
      serviceBindings: this.#serviceBindingSignature(selection, currentHostState),
    };
    this.#preparations.set(entry.manifest.id, preparation);
    const signal = preparation.controller.signal;
    const executableEntrypointIds = new Set(desiredExecutablePlans.map((plan) => plan.entrypointId));
    const plans = [
      ...(compatible.manifest && !groupedCandidate
        ? [{
            ...compatible.manifest,
            contributions: compatible.manifest.contributions.filter((contribution) => (
              !contribution.entrypoint || !executableEntrypointIds.has(contribution.entrypoint)
            )),
          }]
        : []),
      ...executablePlansToActivate,
    ];
    const resources: ModuleResourceScope[] = [];
    const realms: IsolatedSurfaceRealm[] = [];
    const localExternalServices: SurfaceExternalService[] = [];
    const serviceLeases: Array<{ dispose: SurfaceDisposer }> = [];
    const nativeOwners: SurfaceOwnerIdentity[] = [];
    const requests: Array<{ activation: SurfaceActivation; options: SurfaceActivationOptions }> = [];
    const activated: ActiveEntrypoint[] = [];
    try {
      let prepared: VarinExtensionCandidatePreparationResult | null = null;
      const missing = selection.slot === "candidate" ? selection.manifest.updateReadiness?.surfaceEntrypoints
        .filter((id) => !plans.some((plan) => plan.entrypointId === id)) : undefined;
      if (missing?.length) throw new Error(`This Surface cannot prepare every required update member: ${missing.join(", ")}`);
      signal.throwIfAborted();
      const currentEntry = currentHostState.catalog.extensions.find((candidate) => candidate.manifest.id === entry.manifest.id);
      if (selection.slot === "candidate" && currentEntry?.integrity === selection.integrity) selection = { ...selection, slot: "selected" };
      const resolved = this.#resolveDependencies(selection, currentHostState);
      const serviceBindings = preparation.serviceBindings;
      const matchingLocalFactories = this.#externalServiceFactories.filter(factory => resolved.some(binding => binding.providerKey === factory.providerKey && binding.kind === "factory"));
      const routing = structuredClone(initialAccess.routing ?? {});
      const requestedGrants = selectionCapabilities(selection);
      const accessContext = initialAccess;
      const grantedCapabilities = this.#capabilities.resolveGranted(requestedGrants, accessContext);
      const capabilityBindings = this.#capabilityBindingSignature(grantedCapabilities, accessContext);
      const plannedKeys = new Set([
        ...(compatible.manifest ? [keyFor(entry.manifest.id, compatible.manifest.entrypointId)] : []),
        ...desiredExecutablePlans.map((plan) => keyFor(entry.manifest.id, plan.entrypointId)),
      ]);

      const preparedOwners: Array<{ plan: SurfaceActivationPlan; owner: SurfaceOwnerIdentity; moduleGeneration: number; lease: BoundSurfaceServiceLease }> = [];
      for (const plan of plans) {
        signal.throwIfAborted();
        const key = keyFor(entry.manifest.id, plan.entrypointId);
        const moduleGeneration = (this.#generations.get(key) ?? 0) + 1;
        this.#generations.set(key, moduleGeneration);
        const owner: SurfaceOwnerIdentity = {
          desiredRevision: entry.desired.revision,
          entrypointId: plan.entrypointId,
          extensionId: entry.manifest.id,
          extensionVersion: selection.version,
          generation: moduleGeneration,
          hostId: snapshot.hostId,
          realmId: this.#realmId,
        };
        const lease = await this.#openServiceLease({ owner, surface: this.#surface, artifactIntegrity: selection.integrity,
          slot: selection.slot, routing, expectedRoutingRevision: currentHostState.routing.document.revision,
          services: resolved.filter(binding => binding.kind === "host" || binding.kind === "native").map(binding => ({
            serviceId: binding.descriptor.id, version: binding.descriptor.version, providerKey: binding.providerKey,
          })),
        }, signal, error => {
          preparation.controller.abort(error);
          const active = this.#active.get(key);
          if (active?.owner.generation === owner.generation) {
            this.#diagnose(owner.extensionId, "service_lease_lost", error.message, { entrypointId: owner.entrypointId });
            void this.#enqueueOwner(owner.extensionId, () => this.#deactivate(active, owner.desiredRevision));
          }
        });
        serviceLeases.push(lease);
        preparedOwners.push({ plan, owner, moduleGeneration, lease });
      }
      // Scope owners precede group preparation; byte reads use the resulting authoritative slot.
      if (selection.slot === "candidate") {
        prepared = parseVarinExtensionCandidatePreparationResult(await this.#host.prepareCandidate(entry.manifest.id, selection.integrity, signal));
        const latest = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
        currentHostState = latest;
        if (latest.catalog.extensions.some(value => value.manifest.id === entry.manifest.id && value.integrity === selection.integrity)) {
          selection = { ...selection, slot: "selected" };
        }
      }
      for (const { plan, owner, moduleGeneration, lease } of preparedOwners) {
        signal.throwIfAborted();
        let invocationSignal = signal;
        const hostExternalServices = this.#externalServices(lease.providers, lease.identity, routing, lease.signal, () => invocationSignal);
        const exactProviderIds: Record<string, string[]> = {};
        for (const requirement of selection.manifest.requires?.services?.filter(requirement => requirement.realms.includes("surface")) ?? []) {
          exactProviderIds[`${requirement.id}@${requirement.version}`] = resolved
            .filter(binding => binding.descriptor.id === requirement.id && binding.descriptor.version === requirement.version)
            .map(binding => (binding.kind === "host" || binding.kind === "native")
              ? lease.providers.find(provider => provider.providerKey === binding.providerKey)!.providerId : binding.providerId);
        }
        const ownerLocalExternalServices = await this.#createLocalExternalServices(owner, matchingLocalFactories);
        localExternalServices.push(...ownerLocalExternalServices);
        const externalServices = [...hostExternalServices, ...ownerLocalExternalServices];
        if (plan.mode === "native") nativeOwners.push(owner);
        let activation: SurfaceActivation;
        const contributeDeclarative = (context: SurfaceActivationContext): void => {
          for (const contribution of plan.contributions) {
            // Skip incompatible contributions — they are retained in the plan
            // for catalog record-keeping but must not be registered or executed.
            if (!isVarinContributionCompatible(contribution.kind, contribution.contractVersion)) continue;
            context.contribute(
              plan.mode === "declarative" && contribution.entrypoint
                ? { ...contribution, entrypoint: plan.entrypointId }
                : contribution,
              declarativeImplementation(contribution),
            );
          }
        };
        const activateWithMergedContributions = async (
          context: SurfaceActivationContext,
          run: (stagingContext: SurfaceActivationContext) => void | Promise<void>,
        ): Promise<void> => {
          const dynamic = new Map<string, { descriptor: VarinExtensionStaticContribution; implementation: unknown }>();
          const stagingContext: SurfaceActivationContext = {
            ...context,
            contribute: (descriptor, implementation) => {
              if (dynamic.has(descriptor.id)) {
                throw new Error(`Surface entrypoint contributed the same ID more than once: ${descriptor.id}`);
              }
              dynamic.set(descriptor.id, { descriptor, implementation });
            },
          };
          await run(stagingContext);
          for (const contribution of plan.contributions) {
            // Skip incompatible contributions — retained for catalog but not registered
            if (!isVarinContributionCompatible(contribution.kind, contribution.contractVersion)) continue;
            if (!dynamic.has(contribution.id)) {
              context.contribute(contribution, declarativeImplementation(contribution));
            }
          }
          for (const contribution of dynamic.values()) {
            // Dynamic contributions from the module are always registered —
            // the module is responsible for only contributing compatible versions.
            context.contribute(contribution.descriptor, contribution.implementation);
          }
        };

        if (!plan.entrypoint) {
          activation = contributeDeclarative;
        } else {
          const entrypoint = plan.entrypoint;
          const payload = parseVarinExtensionManagedEntrypointPayload(await this.#host.readManagedEntrypoint({
            entrypointId: entrypoint.id,
            extensionId: entry.manifest.id,
            integrity: selection.integrity,
            slot: selection.slot,
          }));
          const verifiedModule = await verifyAsset(payload.module, selection.integrity);
          const source = new TextDecoder().decode(verifiedModule.bytes);
          if (entrypoint.mode === "isolated") {
            const styles: string[] = [];
            for (const style of payload.styles) {
              const verifiedStyle = await verifyAsset(style, selection.integrity);
              styles.push(new TextDecoder().decode(verifiedStyle.bytes));
            }
            const realm = this.#isolatedRealmFactory.create(source, styles, {
              entrypointId: entrypoint.id,
              extensionId: entry.manifest.id,
              integrity: selection.integrity,
              kind: entrypoint.isolation ?? "iframe",
              realmId: `${this.#realmId}:${entry.manifest.id}:${entrypoint.id}:${moduleGeneration}`,
            });
            realms.push(realm);
            activation = async (context) => {
              context.onDispose(() => realm.dispose());
              await activateWithMergedContributions(context, async (stagingContext) => {
                await realm.activate({
                  callCapability: (capability, method, params) => this.#capabilities.invoke(
                    capability,
                    method,
                    params,
                    owner,
                    grantedCapabilities,
                    accessContext,
                    context.signal,
                  ),
                  callService: async (serviceId, version, providerId, method, args) => {
                    if (providerId) {
                      const index = exactProviderIds[`${serviceId}@${version}`]?.indexOf(providerId) ?? -1;
                      const service = index < 0 ? undefined : stagingContext.useServices<Record<string, unknown>>(serviceId, version)[index];
                      const handler = service?.[method];
                      if (typeof handler !== "function") throw new Error(`Isolated Surface service provider is unavailable: ${providerId}`);
                      return Promise.resolve((handler as (...values: JsonValue[]) => JsonValue | Promise<JsonValue>)(...args));
                    }
                    const implementation = stagingContext.useService<Record<string, (...values: JsonValue[]) => JsonValue | Promise<JsonValue>>>(serviceId, version);
                    const handler = implementation?.[method];
                    if (typeof handler !== "function") throw new Error(`Isolated Surface service method is unavailable: ${serviceId}@${version}.${method}`);
                    return Promise.resolve(handler(...args));
                  },
                  contribute: (descriptor, implementation) => stagingContext.contribute(descriptor, implementation),
                  deleteContext: (key) => stagingContext.context.delete(key),
                  grantedCapabilities,
                  hasService: (serviceId, version, providerId) => providerId
                    ? (exactProviderIds[`${serviceId}@${version}`] ?? []).includes(providerId)
                    : stagingContext.useServices(serviceId, version).length > 0,
                  readAsset: async (path) => {
                    const value = await this.#host.readAsset({
                      extensionId: entry.manifest.id,
                      integrity: selection.integrity,
                      path,
                      slot: selection.slot,
                    });
                    return (await verifyAsset(value, selection.integrity)).payload;
                  },
                  setContext: (key, value) => stagingContext.context.set(key, value),
                });
              });
            };
          } else {
            const module = await this.#evaluate(source, {
              entrypointId: entrypoint.id,
              extensionId: entry.manifest.id,
              integrity: selection.integrity,
            });
            const extension = resolveSurfaceExtensionModule(module);
            const resourceScope = new ModuleResourceScope({
              artifactIntegrity: selection.integrity,
              extensionId: entry.manifest.id,
              host: this.#host,
              slot: selection.slot,
              styleHost: this.#styleHost,
            });
            await resourceScope.stageBundledStyles(payload.styles);
            resources.push(resourceScope);
            activation = async (context) => {
              context.onDispose(() => resourceScope.dispose());
              await activateWithMergedContributions(context, (stagingContext) => (
                extension.activate(resourceScope.context(stagingContext))
              ));
            };
          }
        }
        requests.push({
          activation: async context => {
            invocationSignal = context.signal;
            await activation(context);
          },
          options: {
            grantedCapabilities,
            owner,
            onRetire: () => { void lease.dispose(); },
            signal,
            ...(externalServices.length > 0 ? { externalServices } : {}),
            ...(selection.manifest.requires?.services
              ? { requirements: selection.manifest.requires.services.filter(requirement => requirement.realms.includes("surface")) }
              : {}),
            exactProviderIds,
          },
        });
        activated.push({
          artifactIntegrity: selection.integrity,
          capabilityBindings,
          mode: plan.mode,
          moduleGeneration,
          owner,
          serviceBindings,
        });
      }

      // A required lazy member may still have a declarative placeholder in the old manifest
      // owner. Withdraw only those placeholders; optional owners keep their actual old resources
      // until the selected-artifact watcher can update them independently.
      if (groupedCandidate) {
        const group = new Set(selection.manifest.updateReadiness!.surfaceEntrypoints);
        const replacedIds = new Set([
          ...plans.flatMap((plan) => plan.contributions.map((contribution) => contribution.id)),
          ...(entry.manifest.contributions ?? []).filter((contribution) => contribution.entrypoint && group.has(contribution.entrypoint))
            .map((contribution) => contribution.id),
        ]);
        const manifestOwner = this.#active.get(keyFor(entry.manifest.id, varinSurfaceManifestOwnerId(entry.manifest)));
        if (manifestOwner) {
          const contributions = this.#surfaceRuntime.getSnapshot().contributions.filter((contribution) => (
            contribution.owner.extensionId === entry.manifest.id
            && contribution.owner.entrypointId === manifestOwner.owner.entrypointId
            && contribution.owner.realmId === this.#realmId
          ));
          if (contributions.some((contribution) => replacedIds.has(contribution.descriptor.id))) {
            const key = keyFor(entry.manifest.id, manifestOwner.owner.entrypointId);
            const generation = (this.#generations.get(key) ?? manifestOwner.moduleGeneration) + 1;
            this.#generations.set(key, generation);
            const owner = { ...manifestOwner.owner, generation };
            requests.push({
              options: { owner, signal, grantedCapabilities },
              activation: (context) => {
                for (const contribution of contributions) {
                  if (!replacedIds.has(contribution.descriptor.id)) context.contribute(contribution.descriptor, contribution.implementation);
                }
              },
            });
            activated.push({ ...manifestOwner, owner, moduleGeneration: generation });
          }
        }
      }

      // Owners removed by an update are replaced by empty generations in the same batch. This
      // withdraws their old contributions before the candidate is selected, without making missing
      // service requirements or cleanup of an obsolete owner part of the candidate's new contract.
      for (const active of this.#active.values()) {
        if (active.owner.extensionId !== entry.manifest.id) continue;
        if (groupedCandidate) continue;
        const key = keyFor(entry.manifest.id, active.owner.entrypointId);
        if (plannedKeys.has(key)) continue;
        const moduleGeneration = (this.#generations.get(key) ?? active.moduleGeneration) + 1;
        this.#generations.set(key, moduleGeneration);
        const owner: SurfaceOwnerIdentity = {
          ...active.owner,
          desiredRevision: entry.desired.revision,
          extensionVersion: selection.version,
          generation: moduleGeneration,
          hostId: snapshot.hostId,
        };
        requests.push({ activation: () => undefined, options: { owner, signal } });
        activated.push({
          artifactIntegrity: selection.integrity,
          capabilityBindings,
          mode: active.mode,
          moduleGeneration,
          owner,
          serviceBindings: "",
        });
      }

      let committedSnapshot: VarinExtensionCatalogSnapshot | null = null;
      await this.#surfaceRuntime.activateBatchWithCommit(requests, async (publicationSignal) => {
        if (this.#stopped || lifecycleEpoch !== this.#lifecycleEpoch || snapshot.hostId !== this.#hostId) {
          throw new Error("Surface activation was superseded by loader close or Host change");
        }
        if (selection.slot === "selected") {
          const latest = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
          const latestEntry = latest.catalog.extensions.find((candidate) => candidate.manifest.id === entry.manifest.id);
          if (
            !latest.catalog.authoritative
            || latest.catalog.hostId !== snapshot.hostId
            || !latestEntry?.desired.enabled
            || latestEntry.desired.revision !== entry.desired.revision
            || latestEntry.integrity !== selection.integrity
            || serviceBindings !== this.#serviceBindingSignature(selection, latest)
          ) {
            throw new Error("Surface activation was superseded by a newer Host, desired artifact, or dependency generation");
          }
        }
        if (selection.slot === "candidate") {
          const latest = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
          const latestEntry = latest.catalog.extensions.find((candidate) => candidate.manifest.id === entry.manifest.id);
          if (!latest.catalog.authoritative || latest.catalog.hostId !== snapshot.hostId
            || !latestEntry?.desired.enabled || latestEntry.desired.revision !== entry.desired.revision
            || serviceBindings !== this.#serviceBindingSignature(selection, latest)) {
            throw new Error("Surface candidate was superseded by a newer Host, desired, or dependency generation");
          }
          for (const resource of resources) resource.validate();
          publicationSignal.throwIfAborted();
          if (latestEntry.integrity === selection.integrity) committedSnapshot = latest.catalog;
          else {
            const group = selection.manifest.updateReadiness;
            if (group && !prepared?.hostPreparation) throw new Error("Required update group has no live Host preparation identity");
            committedSnapshot = await this.#publishCandidate({
              candidateIntegrity: selection.integrity,
              expectedRevision: latest.catalog.revision,
              extensionId: entry.manifest.id,
              ...(group ? { surfaceReadiness: {
                hostPreparation: prepared!.hostPreparation!,
                realmId: this.#realmId,
                surface: this.#surface,
                members: group.surfaceEntrypoints.map((entrypointId) => {
                  const member = activated.find((active) => active.owner.entrypointId === entrypointId);
                  if (!member) throw new Error(`Required Surface owner was not prepared: ${entrypointId}`);
                  return { entrypointId, generation: member.owner.generation };
                }),
              } } : {}),
            }, publicationSignal, snapshot.hostId, entry.desired.revision);
          }
        } else {
          publicationSignal.throwIfAborted();
          committedSnapshot = currentHostState.catalog;
        }
        for (const resource of resources) {
          try { resource.commit(); }
          catch (error) {
            // Resource publication cannot reverse the already confirmed Catalog choice. Keep the
            // local failure visible; this owner's resources still retire on replacement/disable.
            this.#diagnose(entry.manifest.id, "resource_publication_failed",
              error instanceof Error ? error.message : String(error), { integrity: selection.integrity });
          }
        }
      });
      for (const active of activated) this.#active.set(keyFor(active.owner.extensionId, active.owner.entrypointId), active);
      await this.#reportActual(entry.manifest.id);
      return committedSnapshot;
    } catch (error) {
      for (const lease of serviceLeases) await lease.dispose();
      for (const service of [...localExternalServices].reverse()) {
        await Promise.resolve(service.dispose?.()).catch(() => undefined);
      }
      for (const resource of resources) resource.dispose();
      for (const realm of realms) realm.dispose(error);
      for (const owner of nativeOwners) {
        this.#nativeRestartRequired.add(owner.extensionId);
        this.#surfaceRuntime.markRestartRequired(
          owner,
          "native_surface_rollback_not_guaranteed",
          "Trusted-native Surface activation failed; reload this Surface before retrying the extension",
        );
      }
      await this.#reportActual(entry.manifest.id);
      throw error;
    } finally {
      if (this.#preparations.get(entry.manifest.id) === preparation) this.#preparations.delete(entry.manifest.id);
    }
  }

  async #publishCandidate(
    request: VarinExtensionCandidatePublicationRequest,
    signal: AbortSignal,
    hostId: string,
    desiredRevision: number,
  ): Promise<VarinExtensionCatalogSnapshot> {
    try {
      return parseVarinExtensionCatalogSnapshot(await this.#host.selectCandidate(request, signal));
    } catch (error) {
      // A closed fetch may have lost the response after the Host's durable CAS began. Confirm the
      // current selection through its existing authority; this is not a tool-operation receipt.
      let observed: VarinExtensionHostStateSnapshot;
      try { observed = parseVarinExtensionHostStateSnapshot(await this.#host.hostState()); }
      catch (observationError) {
        this.#diagnose(request.extensionId, "candidate_selection_unconfirmed",
          `Candidate publication could not be confirmed: ${observationError instanceof Error ? observationError.message : String(observationError)}`,
          { integrity: request.candidateIntegrity });
        throw error;
      }
      const entry = observed.catalog.extensions.find((candidate) => candidate.manifest.id === request.extensionId);
      if (observed.catalog.authoritative && observed.catalog.hostId === hostId
        && entry?.desired.revision === desiredRevision && entry.integrity === request.candidateIntegrity) return observed.catalog;
      if (signal.aborted) this.#diagnose(request.extensionId, "candidate_selection_unconfirmed",
        "The publication request closed before its result was confirmed; the Host watcher will reconcile its actual selection",
        { integrity: request.candidateIntegrity });
      throw error;
    }
  }

  async #watch(controller: AbortController): Promise<void> {
    let consecutiveFailures = 0;
    for (;;) {
      if (controller.signal.aborted) return;
      try {
        // After a transport failure, fetch an authoritative snapshot instead of resuming a long
        // poll from a possibly replaced Host identity or a revision the new Host never observed.
        const state = consecutiveFailures > 0 || !this.#hostId
          ? parseVarinExtensionHostStateSnapshot(await this.#host.hostState())
          : parseVarinExtensionHostStateSnapshot(await this.#host.waitForHostState({
            hostId: this.#hostId,
            revision: this.#hostStateRevision,
          }, controller.signal));
        if (controller.signal.aborted) return;
        void this.#reconcileSnapshot(state.catalog, state).catch((error) => {
          if (controller.signal.aborted) return;
          this.#diagnose("varin.extensions", "host_state_reconcile_failed", error instanceof Error ? error.message : String(error));
          this.#publish();
        });
        consecutiveFailures = 0;
      } catch (error) {
        if (controller.signal.aborted) return;
        consecutiveFailures += 1;
        if (consecutiveFailures === 1) {
          this.#diagnose(
            "varin.extensions",
            "host_state_watch_interrupted",
            error instanceof Error ? error.message : String(error),
          );
          this.#publish();
        }
        await this.#watchRetry(consecutiveFailures, controller.signal);
      }
    }
  }

  #hostDeclarations(selection: ArtifactSelection, state: VarinExtensionHostStateSnapshot): SurfaceDependency[] {
    const candidates: SurfaceDependency[] = [];
    for (const entry of state.catalog.extensions) {
      const manifest = entry.manifest.id === selection.manifest.id ? selection.manifest : entry.manifest;
      if (!entry.desired.enabled || !manifest.entrypoints?.host) continue;
      for (const descriptor of manifest.provides?.services ?? []) {
        const providerKey = `${manifest.id}:host:${descriptor.id}@${descriptor.version}`;
        candidates.push({ descriptor, kind: "host", providerKey, providerId: providerKey });
      }
    }
    const builtin = state.catalog.extensions.find(entry => entry.manifest.id === VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID && entry.desired.enabled);
    if (builtin) {
      const native = state.services.providers.filter(provider => provider.status === "active"
        && provider.extensionId === builtin.manifest.id && provider.extensionVersion === builtin.selectedVersion
        && provider.entrypointId === "workbench-layout" && provider.descriptor.id === VARIN_WORKBENCH_LAYOUT_SERVICE_ID
        && builtin.manifest.provides?.services?.some(descriptor => descriptor.id === provider.descriptor.id && descriptor.version === provider.descriptor.version));
      if (native.length > 1) throw new Error("Workbench layout service has ambiguous native owners");
      candidates.push(...native.map(provider => ({ ...provider, kind: "native" as const })));
    }
    return candidates;
  }

  #resolveDependencies(selection: ArtifactSelection, state: VarinExtensionHostStateSnapshot): SurfaceDependency[] {
    if (!state.catalog.authoritative || !state.routing.authoritative) throw new Error("Service composition is unavailable until the Host catalog and routing are authoritative");
    const candidates = this.#hostDeclarations(selection, state);
    candidates.push(...this.#externalServiceFactories.map(factory => ({ ...factory, kind: "factory" as const })));
    candidates.push(...this.#surfaceRuntime.getSnapshot().services.map(service => ({ ...service, kind: "surface" as const })));
    const resolved = (selection.manifest.requires?.services?.filter(requirement => requirement.realms.includes("surface")) ?? []).flatMap(requirement =>
      resolveSurfaceRequirement(requirement, candidates, state, this.#accessContext(state).routing ?? {}));
    return [...new Map(resolved.map(value => [`${value.descriptor.id}@${value.descriptor.version}\0${value.providerId}`, value])).values()];
  }

  #externalServices(providers: VarinExtensionServiceProviderSnapshot[], lease: VarinSurfaceServiceInvocationLease,
    routing: VarinExtensionServiceRoutingContext, signal: AbortSignal, callSignal: () => AbortSignal): SurfaceExternalService[] {
    return providers.map(provider => ({ descriptor: { ...provider.descriptor }, providerId: provider.providerId,
      implementation: new Proxy({}, {
        get: (_target, property) => property === "then" || typeof property !== "string" ? undefined
          : (...args: JsonValue[]) => {
            signal.throwIfAborted();
            return this.#host.invokeService({ args, method: property, providerId: provider.providerId,
              serviceId: provider.descriptor.id, version: provider.descriptor.version, routing, lease }, callSignal());
          },
      }),
    }));
  }

  async #openServiceLease(request: VarinSurfaceServiceLeaseRequest, preparationSignal: AbortSignal,
    invalidated: (error: Error) => void): Promise<BoundSurfaceServiceLease> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, preparationSignal]);
    let ready = false;
    let closed = false;
    let resolveReady!: (event: Extract<VarinSurfaceServiceLeaseEvent, { kind: "ready" }>) => void;
    let rejectReady!: (error: Error) => void;
    const readiness = new Promise<Extract<VarinSurfaceServiceLeaseEvent, { kind: "ready" }>>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const fail = (reason: unknown): void => {
      if (closed) return;
      closed = true;
      const error = reason instanceof Error ? reason : new Error(String(reason));
      controller.abort(error);
      rejectReady(error);
      if (ready) invalidated(error);
    };
    const aborted = (): void => fail(signal.reason ?? new Error("Surface service lease was cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    const stream = Promise.resolve().then(() => this.#host.watchServiceLease(request, raw => {
      if (closed) return;
      const event = parseVarinSurfaceServiceLeaseEvent(raw);
      if (event.kind !== "ready") { fail(new Error(event.kind === "error" ? event.message : `Surface service lease revoked: ${event.code}`)); return; }
      if (ready) { fail(new Error("Surface service lease sent duplicate readiness")); return; }
      if (event.routingRevision !== request.expectedRoutingRevision || event.providers.length !== request.services.length
        || request.services.some(choice => !event.providers.some(provider => provider.providerKey === choice.providerKey
          && provider.descriptor.id === choice.serviceId && provider.descriptor.version === choice.version))) {
        fail(new Error("Surface service lease does not match the frozen dependency request")); return;
      }
      ready = true;
      resolveReady(event);
    }, signal));
    void stream.then(() => fail(new Error("Surface service lease stream ended")), fail);
    try {
      const event = await readiness;
      signal.throwIfAborted();
      return { providers: event.providers, identity: { id: event.leaseId, owner: {
        realmId: request.owner.realmId, extensionId: request.owner.extensionId,
        entrypointId: request.owner.entrypointId, generation: request.owner.generation,
      } }, signal, dispose: () => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", aborted);
        controller.abort(new Error("Surface service lease owner retired"));
      } };
    } catch (error) { closed = true; signal.removeEventListener("abort", aborted); controller.abort(error); throw error; }
  }

  async #createLocalExternalServices(
    owner: SurfaceOwnerIdentity,
    factories: readonly SurfaceLocalExternalServiceFactory[],
  ): Promise<SurfaceExternalService[]> {
    const services: SurfaceExternalService[] = [];
    try {
      for (const factory of factories) {
        const created = await factory.create({ ...owner });
        const dispose = created.dispose
          ? this.#onceDisposer(() => created.dispose?.())
          : undefined;
        services.push({
          descriptor: { ...factory.descriptor },
          ...(dispose ? { dispose } : {}),
          implementation: created.implementation,
          providerId: factory.providerId,
        });
      }
      return services;
    } catch (error) {
      for (const service of services.reverse()) await Promise.resolve(service.dispose?.()).catch(() => undefined);
      throw error;
    }
  }

  #onceDisposer(disposer: SurfaceDisposer | undefined): SurfaceDisposer | undefined {
    if (!disposer) return undefined;
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      await disposer();
    };
  }

  #serviceBindingSignature(selection: ArtifactSelection, state: VarinExtensionHostStateSnapshot): string {
    const scope = this.#accessContext(state).routing ?? {};
    const resolved = this.#resolveDependencies(selection, state);
    const hostGraph = new Map<string, unknown>();
    const visit = (extensionId: string): void => {
      if (hostGraph.has(extensionId)) return;
      const entry = state.catalog.extensions.find(value => value.manifest.id === extensionId);
      if (!entry) throw new Error(`Host service artifact is unavailable: ${extensionId}`);
      const manifest = extensionId === selection.manifest.id ? selection.manifest : entry.manifest;
      if (!manifest.entrypoints?.host) {
        const native = this.#hostDeclarations(selection, state).filter(value => value.kind === "native" && value.providerKey.startsWith(`${extensionId}:`));
        if (!native.length) throw new Error(`Native Host service owner is unavailable: ${extensionId}`);
        hostGraph.set(extensionId, native.map(value => [value.providerKey, value.providerId]));
        return;
      }
      const candidates = this.#hostDeclarations(selection, state);
      const dependencies = (manifest.requires?.services?.filter(requirement => requirement.realms.includes("host")) ?? []).flatMap(requirement => resolveSurfaceRequirement(requirement, candidates, state, scope));
      hostGraph.set(extensionId, { integrity: extensionId === selection.manifest.id ? selection.integrity : entry.integrity,
        grants: entry.capabilityGrants, dependencies: dependencies.map(value => value.providerKey) });
      for (const dependency of dependencies) visit(dependency.providerKey.split(":")[0]!);
    };
    for (const dependency of resolved.filter(value => value.kind === "host" || value.kind === "native")) visit(dependency.providerKey.split(":")[0]!);
    if (selection.manifest.entrypoints?.host) visit(selection.manifest.id);
    return canonicalServiceComposition({ scope, dependencies: resolved.map(value => [value.kind, value.providerId]), hostGraph: [...hostGraph] });
  }

  #capabilityBindingSignature(capabilities: Iterable<string>, context: SurfaceCapabilityAccessContext): string {
    return JSON.stringify({
      access: context.access,
      capabilities: this.#capabilities.resolveGranted(capabilities, context).sort(),
      projectTrusted: context.projectTrusted,
      surface: context.surface,
      routing: context.routing,
    });
  }

  async #ensureInactivePlans(
    entry: VarinExtensionCatalogEntry,
    selection: ArtifactSelection,
    plans: SurfaceActivationPlan[],
    hostId: string,
  ): Promise<void> {
    let changed = false;
    for (const plan of plans) {
      const key = keyFor(entry.manifest.id, plan.entrypointId);
      if (this.#active.has(key)) continue;
      const current = this.#surfaceRuntime.getSnapshot().actual.find((state) => (
        state.extensionId === entry.manifest.id
        && state.entrypointId === plan.entrypointId
        && state.realmId === this.#realmId
      ));
      if (
        current?.status === "inactive"
        && current.desiredRevision === entry.desired.revision
        && current.extensionVersion === selection.version
        && current.hostId === hostId
      ) continue;
      const generation = (this.#generations.get(key) ?? current?.generation ?? 0) + 1;
      this.#generations.set(key, generation);
      await this.#surfaceRuntime.deactivate({
        desiredRevision: entry.desired.revision,
        entrypointId: plan.entrypointId,
        extensionId: entry.manifest.id,
        extensionVersion: selection.version,
        generation,
        hostId,
        realmId: this.#realmId,
      });
      changed = true;
    }
    if (changed) await this.#reportActual(entry.manifest.id);
  }

  #clearTriggered(extensionId: string): void {
    const prefix = `${extensionId}\0`;
    for (const key of this.#triggered) {
      if (key.startsWith(prefix)) this.#triggered.delete(key);
    }
    for (const key of this.#failedCandidates) if (key.startsWith(prefix)) this.#failedCandidates.delete(key);
  }

  async #deactivate(active: ActiveEntrypoint, desiredRevision: number): Promise<void> {
    const key = keyFor(active.owner.extensionId, active.owner.entrypointId);
    const owner = {
      ...active.owner,
      desiredRevision,
      generation: Math.max(this.#generations.get(key) ?? 0, active.moduleGeneration) + 1,
    };
    this.#generations.set(key, Math.max(this.#generations.get(key) ?? 0, owner.generation));
    const priorNativeCleanupFailed = active.mode === "native" && this.#surfaceRuntime.getSnapshot().actual.some((state) => (
      state.extensionId === owner.extensionId
      && state.entrypointId === owner.entrypointId
      && state.realmId === owner.realmId
      && state.diagnostics.some((item) => item.code === "previous_generation_cleanup_failed")
    ));
    await this.#surfaceRuntime.deactivate(owner);
    if (active.mode === "native") {
      const actual = this.#surfaceRuntime.getSnapshot().actual.find((state) => (
        state.extensionId === owner.extensionId
        && state.entrypointId === owner.entrypointId
        && state.realmId === owner.realmId
      ));
      if (priorNativeCleanupFailed || actual?.diagnostics.some((item) => item.code === "deactivation_cleanup_failed")) {
        this.#nativeRestartRequired.add(owner.extensionId);
        this.#surfaceRuntime.markRestartRequired(
          owner,
          "native_surface_cleanup_failed",
          "Trusted-native Surface cleanup failed; reload this Surface to complete deactivation",
        );
      }
    }
    this.#active.delete(key);
    await this.#reportActual(active.owner.extensionId);
  }

  async #reportActual(extensionId: string): Promise<void> {
    const states = this.#surfaceRuntime.getSnapshot().actual.filter((state) => (
      state.extensionId === extensionId && state.realmId === this.#realmId
    ));
    for (const state of states) await this.#host.reportActualState(extensionId, toReportedActual(state)).catch(() => undefined);
  }

  #diagnose(
    extensionId: string,
    code: string,
    message: string,
    details: Pick<SurfaceExtensionLoaderDiagnostic, "entrypointId" | "integrity" | "moduleGeneration"> = {},
    severity: SurfaceExtensionLoaderDiagnostic["severity"] = "error",
  ): void {
    if (this.#diagnostics.some((item) => (
      item.code === code
      && item.extensionId === extensionId
      && item.message === message
      && item.entrypointId === details.entrypointId
      && item.integrity === details.integrity
      && item.moduleGeneration === details.moduleGeneration
    ))) return;
    this.#diagnostics.push({
      code,
      extensionId,
      message,
      realmId: this.#realmId,
      severity,
      timestamp: new Date().toISOString(),
      ...details,
    });
  }

  #enqueueOwner<T>(extensionId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#ownerQueues.get(extensionId) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#ownerQueues.set(extensionId, settled);
    void settled.then(() => { if (this.#ownerQueues.get(extensionId) === settled) this.#ownerQueues.delete(extensionId); });
    return result;
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
