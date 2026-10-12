import {
  parseVarinExtensionAssetPayload,
  parseVarinExtensionCatalogAvailability,
  parseVarinExtensionCatalogSnapshot,
  parseVarinExtensionCandidatePreparationResult,
  parseVarinExtensionHostStateSnapshot,
  parseVarinExtensionManagedEntrypointPayload,
  checkVarinContributionCompatibility,
  isVarinContributionCompatible,
  type VarinApplicationSurface,
  type VarinExtensionActualState,
  type VarinExtensionAssetPayload,
  type VarinExtensionAssetRequest,
  type VarinExtensionCandidateSelectionRequest,
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
  invokeService(request: VarinExtensionServiceInvocationRequest): Promise<JsonValue>;
  prepareCandidate(extensionId: string, candidateIntegrity: string): Promise<VarinExtensionCandidatePreparationResult>;
  requestCandidateApplication(request: VarinExtensionCandidateSelectionRequest): Promise<VarinExtensionCatalogSnapshot>;
  readAsset(request: VarinExtensionAssetRequest): Promise<VarinExtensionAssetPayload>;
  readManagedEntrypoint(request: VarinExtensionManagedEntrypointRequest): Promise<VarinExtensionManagedEntrypointPayload>;
  reportActualState(extensionId: string, state: VarinExtensionActualState): Promise<void>;
  selectCandidate(request: VarinExtensionCandidateSelectionRequest): Promise<VarinExtensionCatalogSnapshot>;
  waitForHostState(request: VarinExtensionHostStateWaitRequest, signal?: AbortSignal): Promise<VarinExtensionHostStateSnapshot>;
}

export interface ManagedSurfaceModuleEvaluator {
  (source: string, identity: { entrypointId: string; extensionId: string; integrity: string }): VarinManagedSurfaceModule | Promise<VarinManagedSurfaceModule>;
}

export interface ManagedStyleHandle {
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
  accessContext?: () => Omit<SurfaceCapabilityAccessContext, "surface">;
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

const selectionCapabilities = (selection: ArtifactSelection): string[] => selection.capabilityGrants
  .filter((grant) => grant.realm === "surface" && grant.granted && grant.manifestVersion === selection.version)
  .map((grant) => grant.capability);

const manifestOwnerEntrypointId = (manifest: VarinExtensionManifest): string => {
  const occupied = new Set((manifest.entrypoints?.surfaces ?? []).map((entrypoint) => entrypoint.id));
  const base = `${manifest.id}.manifest`;
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

const compatibleActivationPlans = (
  manifest: VarinExtensionManifest,
  surface: VarinApplicationSurface,
): CompatibleSurfacePlans => {
  const compatibleEntrypoints = (manifest.entrypoints?.surfaces ?? [])
    .filter((entrypoint) => entrypoint.supports.includes(surface));
  const compatibleEntrypointIds = new Set(compatibleEntrypoints.map((entrypoint) => entrypoint.id));
  const executable = new Map<string, SurfaceActivationPlan>();
  for (const entrypoint of compatibleEntrypoints) {
    if (entrypoint.mode === "declarative") continue;
    executable.set(entrypoint.id, {
      contributions: [],
      entrypoint: entrypoint as ExecutableSurfaceEntrypoint,
      entrypointId: entrypoint.id,
      mode: entrypoint.mode,
    });
  }
  const staticContributions: VarinExtensionStaticContribution[] = [];
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
      if (compatible) staticContributions.push(contribution);
      continue;
    }
    if (compatible) staticContributions.push(contribution);
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
    ...(staticContributions.length > 0 || compatibleEntrypoints.some((entrypoint) => entrypoint.mode === "declarative")
      ? {
          manifest: {
            contributions: staticContributions,
            entrypointId: manifestOwnerEntrypointId(manifest),
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
  readonly #accessContext: () => SurfaceCapabilityAccessContext;
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
  readonly #reconcileRequests = new Map<string, { snapshot: VarinExtensionCatalogSnapshot; state: VarinExtensionHostStateSnapshot }>();
  readonly #reconciliations = new Map<string, Promise<void>>();
  #lifecycleEpoch = 0;
  #stopped = false;
  #revision = 0;
  #hostStateRevision = 0;
  #watchController: AbortController | null = null;

  constructor(options: SurfaceExtensionLoaderOptions) {
    this.#accessContext = () => {
      const provided = options.accessContext?.();
      return {
        access: provided?.access ?? (options.surface === "desktop" ? "local" : "remote"),
        projectTrusted: provided?.projectTrusted ?? false,
        surface: options.surface,
      };
    };
    this.#capabilities = options.capabilities ?? new SurfaceCapabilityRegistry();
    this.#evaluate = options.evaluateModule ?? evaluateManagedSurfaceModule;
    this.#externalServiceFactories = [...(options.externalServiceFactories ?? [])];
    this.#host = options.host;
    this.#isolatedRealmFactory = options.isolatedRealmFactory ?? browserIsolatedSurfaceRealmFactory;
    this.#realmId = options.realmId ?? defaultRealmId();
    this.#styleHost = options.styleHost ?? defaultStyleHost;
    this.#surface = options.surface;
    this.#surfaceRuntime = options.surfaceRuntime;
    this.#watchRetry = options.watchRetry ?? defaultWatchRetry;
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
          const entrypoint = plan.entrypoint as ExecutableSurfaceEntrypoint;
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
      const executablePlans = plans.executable.filter((plan) => (
        entrypointIsEager(plan.entrypoint as ExecutableSurfaceEntrypoint)
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
          if (active.owner.extensionId === extensionId && !retained.has(key)) {
            await this.#deactivate(active, entry.desired.revision);
          }
        }
        this.#failedCandidates.delete(`${extensionId}\0${candidateIntegrity}`);
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
    if (this.#hostId && this.#hostId !== snapshot.hostId) {
      this.#lifecycleEpoch += 1;
      this.#triggered.clear();
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
          entrypointIsEager(plan.entrypoint as ExecutableSurfaceEntrypoint)
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
      const selected = publicCandidateSelection(entry);
      if (!selected) {
        this.#diagnose(entry.manifest.id, "artifact_unavailable", "Surface extension has no content-addressed artifact");
        continue;
      }
      const plans = compatibleActivationPlans(selected.manifest, this.#surface);
      const executablePlans = plans.executable.filter((plan) => {
        const key = keyFor(entry.manifest.id, plan.entrypointId);
        return entrypointIsEager(plan.entrypoint as ExecutableSurfaceEntrypoint)
          || this.#triggered.has(key)
          || this.#active.has(key);
      });
      const desiredPlans = [...(plans.manifest ? [plans.manifest] : []), ...executablePlans];
      if (desiredPlans.length === 0) {
        await this.#ensureInactivePlans(entry, selected, plans.executable, snapshot.hostId);
        continue;
      }
      const failedKey = `${entry.manifest.id}\0${selected.integrity}`;
      if (selected.slot === "candidate" && this.#failedCandidates.has(failedKey)) continue;
      if (executablePlans.some((plan) => plan.mode === "native") && this.#nativeRestartRequired.has(entry.manifest.id)) continue;
      const expectedBindings = selected.slot === "selected"
        ? this.#serviceBindingSignature(
            this.#resolveExternalProviders(selected, hostState, null),
            this.#matchingLocalServiceFactories(selected.manifest.requires?.services ?? []),
          )
        : null;
      const accessContext = this.#accessContext();
      const grantedCapabilities = this.#capabilities.resolveGranted(selectionCapabilities(selected), accessContext);
      const expectedCapabilityBindings = this.#capabilityBindingSignature(grantedCapabilities, accessContext);
      const currentEntrypoints = desiredPlans
        .map((plan) => this.#active.get(keyFor(entry.manifest.id, plan.entrypointId)))
        .filter((value): value is ActiveEntrypoint => value !== undefined);
      if (selected.slot === "selected"
        && (currentEntrypoints.length > 0 || executablePlans.length > 0)
        && !this.#requirementsSatisfied(selected, hostState)) {
        if (currentEntrypoints.length > 0) {
          for (const active of currentEntrypoints) {
            if (active.artifactIntegrity === selected.integrity) await this.#deactivate(active, entry.desired.revision);
          }
        }
        this.#diagnose(entry.manifest.id, "required_service_withdrawn", "A required extension service is no longer available");
        continue;
      }
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
        && (expectedBindings === null
          || this.#active.get(keyFor(entry.manifest.id, plan.entrypointId))?.serviceBindings === expectedBindings)
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
            || (expectedBindings !== null && active.serviceBindings !== expectedBindings);
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
            if (active.owner.extensionId === entry.manifest.id && !retained.has(key)) {
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
    const executableEntrypointIds = new Set(desiredExecutablePlans.map((plan) => plan.entrypointId));
    const plans = [
      ...(compatible.manifest
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
    const nativeOwners: SurfaceOwnerIdentity[] = [];
    const requests: Array<{ activation: SurfaceActivation; options: SurfaceActivationOptions }> = [];
    const activated: ActiveEntrypoint[] = [];
    try {
      let prepared: VarinExtensionCandidatePreparationResult | null = null;
      if (selection.slot === "candidate") {
        prepared = parseVarinExtensionCandidatePreparationResult(
          await this.#host.prepareCandidate(entry.manifest.id, selection.integrity),
        );
      } else if (executablePlansToActivate.length > 0) {
        await this.#host.activateExtension(entry.manifest.id);
      }
      const currentHostState = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
      const currentEntry = currentHostState.catalog.extensions.find((candidate) => candidate.manifest.id === entry.manifest.id);
      if (selection.slot === "candidate" && currentEntry?.integrity === selection.integrity) {
        selection = { ...selection, slot: "selected" };
      }
      const externalProviders = this.#resolveExternalProviders(selection, currentHostState, prepared);
      const serviceSelections = this.#resolvedServiceSelections(selection, currentHostState, externalProviders);
      const hostExternalServices = this.#externalServices(externalProviders);
      const matchingLocalFactories = this.#matchingLocalServiceFactories(selection.manifest.requires?.services ?? []);
      const serviceBindings = this.#serviceBindingSignature(externalProviders, matchingLocalFactories);
      const requestedGrants = selectionCapabilities(selection);
      const accessContext = this.#accessContext();
      const grantedCapabilities = this.#capabilities.resolveGranted(requestedGrants, accessContext);
      const capabilityBindings = this.#capabilityBindingSignature(grantedCapabilities, accessContext);
      const plannedKeys = new Set([
        ...(compatible.manifest ? [keyFor(entry.manifest.id, compatible.manifest.entrypointId)] : []),
        ...desiredExecutablePlans.map((plan) => keyFor(entry.manifest.id, plan.entrypointId)),
      ]);

      for (const plan of plans) {
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
                      const service = externalServices.find((candidate) => (
                        candidate.providerId === providerId
                        && candidate.descriptor.id === serviceId
                        && candidate.descriptor.version === version
                      ));
                      const handler = (service?.implementation as Record<string, unknown> | undefined)?.[method];
                      if (typeof handler !== "function") {
                        throw new Error(`Isolated Surface service provider is unavailable: ${providerId}`);
                      }
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
                    ? externalServices.some((service) => (
                        service.providerId === providerId
                        && service.descriptor.id === serviceId
                        && service.descriptor.version === version
                      ))
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
          activation,
          options: {
            grantedCapabilities,
            owner,
            ...(externalServices.length > 0 ? { externalServices } : {}),
            ...(selection.manifest.requires?.services
              ? { requirements: selection.manifest.requires.services }
              : {}),
            ...(Object.keys(serviceSelections).length > 0 ? { serviceSelections } : {}),
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

      // Owners removed by an update are replaced by empty generations in the same batch. This
      // withdraws their old contributions before the candidate is selected, without making missing
      // service requirements or cleanup of an obsolete owner part of the candidate's new contract.
      for (const active of this.#active.values()) {
        if (active.owner.extensionId !== entry.manifest.id) continue;
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
        requests.push({ activation: () => undefined, options: { owner } });
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
      await this.#surfaceRuntime.activateBatchWithCommit(requests, async () => {
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
          ) {
            throw new Error("Surface activation was superseded by a newer Host or desired artifact generation");
          }
        }
        if (selection.slot === "candidate") {
          const latest = parseVarinExtensionHostStateSnapshot(await this.#host.hostState());
          const latestEntry = latest.catalog.extensions.find((candidate) => candidate.manifest.id === entry.manifest.id);
          if (!latest.catalog.authoritative || latest.catalog.hostId !== snapshot.hostId
            || !latestEntry?.desired.enabled || latestEntry.desired.revision !== entry.desired.revision) {
            throw new Error("Surface candidate was superseded by a newer Host or desired generation");
          }
          committedSnapshot = latestEntry.integrity === selection.integrity ? latest.catalog
            : parseVarinExtensionCatalogSnapshot(await this.#host.selectCandidate({
                candidateIntegrity: selection.integrity,
                expectedRevision: snapshot.revision,
                extensionId: entry.manifest.id,
              }));
        } else {
          committedSnapshot = currentHostState.catalog;
        }
        for (const resource of resources) resource.commit();
      });
      for (const active of activated) this.#active.set(keyFor(active.owner.extensionId, active.owner.entrypointId), active);
      await this.#reportActual(entry.manifest.id);
      return committedSnapshot;
    } catch (error) {
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

  #resolveExternalProviders(
    selection: ArtifactSelection,
    state: VarinExtensionHostStateSnapshot,
    prepared: VarinExtensionCandidatePreparationResult | null,
  ): VarinExtensionServiceProviderSnapshot[] {
    const requirements = selection.manifest.requires?.services ?? [];
    const preparedProviders = prepared?.providers ?? [];
    const selectedProviders: VarinExtensionServiceProviderSnapshot[] = [];
    for (const requirement of requirements) {
      const candidateKeys = new Set(preparedProviders
        .filter((provider) => provider.descriptor.id === requirement.id && provider.descriptor.version === requirement.version)
        .map((provider) => `${provider.extensionId}\0${provider.descriptor.id}\0${provider.descriptor.version}`));
      const active = state.services.providers.filter((provider) => (
        provider.status === "active"
        && provider.descriptor.id === requirement.id
        && provider.descriptor.version === requirement.version
        && !candidateKeys.has(`${provider.extensionId}\0${provider.descriptor.id}\0${provider.descriptor.version}`)
      ));
      const candidates = preparedProviders.filter((provider) => (
        provider.descriptor.id === requirement.id && provider.descriptor.version === requirement.version
      ));
      const matches = [...active, ...candidates];
      const binding = requirement.binding ?? "single";
      if (binding === "all") selectedProviders.push(...matches);
      else if (binding === "selected") {
        const selectedId = state.services.selections[`${requirement.id}@${requirement.version}`];
        const selected = matches.find((provider) => provider.providerId === selectedId)
          ?? (candidates.length === 1 && state.services.providers.some((provider) => (
            provider.providerId === selectedId && provider.extensionId === candidates[0]?.extensionId
          )) ? candidates[0] : undefined);
        if (selected) {
          selectedProviders.push(selected);
        }
      } else selectedProviders.push(...matches);
    }
    return [...new Map(selectedProviders.map((provider) => [provider.providerId, provider])).values()];
  }

  #externalServices(
    providers: VarinExtensionServiceProviderSnapshot[],
  ): NonNullable<SurfaceActivationOptions["externalServices"]> {
    return providers.map((provider) => ({
      descriptor: { ...provider.descriptor },
      implementation: new Proxy({}, {
        get: (_target, property) => property === "then" || typeof property !== "string"
          ? undefined
          : (...args: JsonValue[]) => this.#host.invokeService({
            args,
            method: property,
            providerId: provider.providerId,
            serviceId: provider.descriptor.id,
            version: provider.descriptor.version,
          }),
      }),
      providerId: provider.providerId,
    }));
  }

  #matchingLocalServiceFactories(
    requirements: readonly VarinExtensionServiceRequirement[],
  ): SurfaceLocalExternalServiceFactory[] {
    return this.#externalServiceFactories.filter((factory) => requirements.some((requirement) => (
      requirement.id === factory.descriptor.id && requirement.version === factory.descriptor.version
    )));
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

  #requirementsSatisfied(selection: ArtifactSelection, state: VarinExtensionHostStateSnapshot): boolean {
    const external = this.#resolveExternalProviders(selection, state, null);
    return (selection.manifest.requires?.services ?? []).every((requirement) => {
      if (requirement.optional) return true;
      const externalCount = external.filter((provider) => (
        provider.descriptor.id === requirement.id && provider.descriptor.version === requirement.version
      )).length;
      const localExternalCount = this.#externalServiceFactories.filter((factory) => (
        factory.descriptor.id === requirement.id && factory.descriptor.version === requirement.version
      )).length;
      const localCount = this.#surfaceRuntime.getServices(requirement.id, requirement.version).length;
      const count = externalCount + localExternalCount + localCount;
      if ((requirement.binding ?? "single") === "single") return count === 1;
      if (requirement.binding === "selected") {
        const serviceKey = `${requirement.id}@${requirement.version}`;
        const selected = state.services.selections[serviceKey]
          ?? this.#surfaceRuntime.getSnapshot().serviceSelections[serviceKey];
        if (!selected) return false;
        const matches = [
          ...external.map((provider) => provider.providerId),
          ...this.#externalServiceFactories
            .filter((factory) => factory.descriptor.id === requirement.id && factory.descriptor.version === requirement.version)
            .map((factory) => factory.providerId),
          ...this.#surfaceRuntime.getSnapshot().services
            .filter((service) => service.descriptor.id === requirement.id && service.descriptor.version === requirement.version)
            .map((service) => service.owner.extensionId),
        ].filter((providerId) => providerId === selected);
        return matches.length === 1;
      }
      return count > 0;
    });
  }

  #resolvedServiceSelections(
    selection: ArtifactSelection,
    state: VarinExtensionHostStateSnapshot,
    providers: readonly VarinExtensionServiceProviderSnapshot[],
  ): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const requirement of selection.manifest.requires?.services ?? []) {
      if (requirement.binding !== "selected") continue;
      const serviceKey = `${requirement.id}@${requirement.version}`;
      const configured = state.services.selections[serviceKey];
      if (!configured) continue;
      const provider = providers.find((candidate) => (
        candidate.descriptor.id === requirement.id && candidate.descriptor.version === requirement.version
      ));
      resolved[serviceKey] = provider?.providerId ?? configured;
    }
    return resolved;
  }

  #serviceBindingSignature(
    providers: VarinExtensionServiceProviderSnapshot[],
    localFactories: readonly SurfaceLocalExternalServiceFactory[] = [],
  ): string {
    return [
      ...providers.map((provider) => `host:${provider.providerId}`),
      ...localFactories.map((factory) => `surface:${factory.providerId}`),
    ].sort().join("\0");
  }

  #capabilityBindingSignature(capabilities: Iterable<string>, context: SurfaceCapabilityAccessContext): string {
    return JSON.stringify({
      access: context.access,
      capabilities: this.#capabilities.resolveGranted(capabilities, context).sort(),
      projectTrusted: context.projectTrusted,
      surface: context.surface,
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
