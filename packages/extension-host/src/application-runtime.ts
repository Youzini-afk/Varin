import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  assertVarinApplicationVersion,
  parseVarinExtensionActualState,
  parseVarinExtensionCandidateCapabilityReviewRequest,
  parseVarinExtensionCandidateSelectionRequest,
  parseVarinExtensionCandidatePublicationRequest,
  parseVarinExtensionCapabilityReviewRequest,
  parseVarinExtensionHostStateWaitRequest,
  parseVarinExtensionLocalSourceReloadRequest,
  parseVarinExtensionPackageInstallRequest,
  parseVarinExtensionRemoveRequest,
  parseVarinExtensionServiceInvocationRequest,
  parseVarinWorkbenchProfileApplyRequest,
  resolveVarinExtensionServiceRouting,
  type JsonValue,
  type VarinExtensionActivationEvent,
  type VarinExtensionActualState,
  type VarinExtensionCandidateCapabilityReviewRequest,
  type VarinExtensionCandidateSelectionRequest,
  type VarinExtensionCandidatePublicationRequest,
  type VarinExtensionCapabilityReviewRequest,
  type VarinExtensionCandidatePreparationResult,
  type VarinExtensionCatalogSnapshot,
  type VarinExtensionHostStateSnapshot,
  type VarinExtensionHostStateWaitRequest,
  type VarinExtensionLocalSourceReloadRequest,
  type VarinExtensionLocalSourceReloadResult,
  type VarinExtensionPackageInstallRequest,
  type VarinExtensionSourceViewProvenance,
  type VarinExtensionPackageResult,
  type VarinExtensionRemoveRequest,
  type VarinExtensionServiceInvocationRequest,
  type VarinExtensionServiceProvision,
  type VarinExtensionServiceRoutingRuleRemoveRequest,
  type VarinExtensionServiceRoutingRuleUpdateRequest,
  type VarinExtensionServiceRoutingSnapshot,
  type VarinHostServiceComposition,
  parseVarinSurfaceServiceLeaseRequest,
  resolveVarinSurfaceManifestOwner,
  type VarinSurfaceServiceLeaseRequest,
  type VarinSurfaceServiceLeaseEvent,
  type VarinSurfaceServiceInvocationLease,
  parseVarinRuntimeContractRequest,
  type VarinRuntimeContractRequest,
  type VarinRuntimeContractScope,
  type VarinRuntimeContractResult,
  type VarinWorkbenchLayoutUpdateRequest,
  type VarinWorkbenchProfileRemoveRequest,
  type VarinWorkbenchProfileApplyRequest,
  type VarinWorkbenchProfileSelectionRequest,
  type VarinWorkbenchProfileSnapshot,
  type VarinWorkbenchProfileUpsertRequest,
} from "@varin/extension-contract";
import {
  VARIN_BUILTIN_EXTENSION_DEFINITIONS,
  VARIN_BUILTIN_EXTENSION_PREFIX,
  VARIN_BUNDLED_LANGUAGE_SERVERS,
} from "@varin/extension-builtins";
import { queryRuntimeContracts, resolveDeclaredServiceRouting, registeredWorkbenchDeclarations } from "./runtime-contracts.js";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import { BrokeredHostSupervisor, ExtensionUpdateReadinessError, type BrokeredHostTransportFactory, type HostCompositionLease } from "./broker-supervisor.js";
import { HostCapabilityRegistry } from "./capability-registry.js";
import { ExtensionPackageManager } from "./package-manager.js";
import { HostServiceRegistry, HostServiceBindingError, type HostServiceBinding, type HostServicePin } from "./service-registry.js";
import { ServiceRoutingStore } from "./service-routing-store.js";
import { createHostCompositionPlan } from "./service-composition.js";
import { ExtensionStorageError } from "./errors.js";
import { ExtensionStorageStore } from "./storage-store.js";
import { WorkbenchProfileStore } from "./workbench-profile-store.js";

export interface HostServicePreparationOptions { defaultProviderKey?: string; expectedRoutingRevision?: number; signal?: AbortSignal; frozenComposition?: VarinHostServiceComposition }
export interface PreparedHostServiceCollection {
  readonly bindings: readonly HostServiceBinding[];
  readonly routingRevision: number;
}
export interface ResolvedHostServiceCompositions {
  readonly services: readonly { providerKey: string; descriptor: Readonly<VarinExtensionServiceProvision>; composition: VarinHostServiceComposition }[];
  readonly routingRevision: number;
}

export interface ApplicationExtensionRuntimeOptions {
  brokerScript: string;
  brokerShutdownGraceMs?: number;
  capabilities?: HostCapabilityRegistry;
  catalog?: ApplicationExtensionCatalog;
  dataDir: string;
  packages?: ExtensionPackageManager;
  varinVersion: string;
  routing?: ServiceRoutingStore;
  services?: HostServiceRegistry;
  storage?: ExtensionStorageStore;
  transportFactory?: BrokeredHostTransportFactory;
  workbench?: WorkbenchProfileStore;
  onObserverError?: (error: unknown) => void;
}

export class ExtensionPackageApplicationError extends Error {
  constructor(readonly result: VarinExtensionPackageResult, cause: unknown) {
    super(cause instanceof Error ? cause.message : "Extension candidate preparation failed", { cause });
  }
}

export class ApplicationExtensionRuntime {
  readonly capabilities: HostCapabilityRegistry;
  readonly catalog: ApplicationExtensionCatalog;
  readonly packages: ExtensionPackageManager;
  readonly varinVersion: string;
  readonly routing: ServiceRoutingStore;
  readonly services: HostServiceRegistry;
  readonly storage: ExtensionStorageStore;
  readonly supervisor: BrokeredHostSupervisor;
  readonly workbench: WorkbenchProfileStore;
  readonly #listeners = new Set<() => void>();
  readonly #onObserverError: (error: unknown) => void;
  readonly #serviceUnsubscribe: () => void;
  #revision = 0;
  readonly #mutations = new Set<Promise<void>>();
  readonly #builtinPreparations = new Map<string, Promise<void>>();
  readonly #surfaceLeases = new Map<string, { principal: string; owner: VarinSurfaceServiceInvocationLease['owner'];
    services: Map<string, { pin: HostServicePin; serviceId: string; version: number }>; revoke(): void }>();
  #stop: Promise<void> | undefined;
  #stopped = false;

  private constructor(options: ApplicationExtensionRuntimeOptions, hostId: string) {
    this.#onObserverError = options.onObserverError ?? (error => {
      console.error("[VarinExtensions] Observer failed:", error instanceof Error ? error.message : "Unknown observer failure");
    });
    this.varinVersion = options.varinVersion;
    assertVarinApplicationVersion(this.varinVersion);
    this.catalog = options.catalog ?? new ApplicationExtensionCatalog({ dataDir: options.dataDir });
    this.packages = options.packages ?? new ExtensionPackageManager({
      catalog: this.catalog,
      dataDir: options.dataDir,
      varinVersion: this.varinVersion,
    });
    if (this.packages.varinVersion !== this.varinVersion) {
      throw new Error("Extension package manager targets another Varin application version");
    }
    this.capabilities = options.capabilities ?? new HostCapabilityRegistry();
    this.services = options.services ?? new HostServiceRegistry(hostId);
    if (this.services.hostId !== hostId) throw new Error("Extension service registry belongs to another application host");
    this.storage = options.storage ?? new ExtensionStorageStore(options.dataDir);
    this.routing = options.routing ?? new ServiceRoutingStore({ hostId, storage: this.storage });
    if (this.routing.hostId !== hostId) throw new Error("Service routing store belongs to another application host");
    this.workbench = options.workbench ?? new WorkbenchProfileStore({ hostId, storage: this.storage });
    if (this.workbench.hostId !== hostId) throw new Error("Workbench profile store belongs to another application host");
    this.supervisor = new BrokeredHostSupervisor({
      brokerScript: options.brokerScript,
      ...(options.brokerShutdownGraceMs === undefined ? {} : { brokerShutdownGraceMs: options.brokerShutdownGraceMs }),
      capabilities: this.capabilities,
      catalog: this.catalog,
      onStateChange: () => this.#publish(),
      packages: this.packages,
      services: this.services,
      storage: this.storage,
      routing: this.routing,
      prepareBuiltin: (extensionId) => this.#ensureBuiltinArtifact(extensionId),
      ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
    });
    this.#serviceUnsubscribe = this.services.subscribe(() => this.#publish());
  }

  static async create(options: ApplicationExtensionRuntimeOptions): Promise<ApplicationExtensionRuntime> {
    const catalog = options.catalog ?? new ApplicationExtensionCatalog({ dataDir: options.dataDir });
    const identity = await catalog.store.getHostIdentity();
    return new ApplicationExtensionRuntime({ ...options, catalog }, identity.hostId);
  }

  async start(): Promise<VarinExtensionHostStateSnapshot> {
    await this.#mutate(async () => {
      const snapshot = await this.catalog.reconcileBuiltins(
        VARIN_BUILTIN_EXTENSION_DEFINITIONS,
        VARIN_BUILTIN_EXTENSION_PREFIX,
      );
      await this.supervisor.reconcile(snapshot);
      await this.workbench.read();
      await this.routing.read();
      this.#publish();
    });
    return this.state();
  }

  async state(): Promise<VarinExtensionHostStateSnapshot> {
    for (;;) {
      const before = this.#revision;
      const catalog = await this.catalog.snapshot();
      const services = this.services.getSnapshot();
      const routing = await this.routing.read();
      const workbench = await this.workbench.read();
      const after = this.#revision;
      if (before === after) return { catalog, revision: after, routing, services, workbench };
    }
  }

  async queryContracts(requestValue: VarinRuntimeContractRequest | unknown, scope: VarinRuntimeContractScope = {}, signal?: AbortSignal): Promise<VarinRuntimeContractResult> {
    const request = parseVarinRuntimeContractRequest(requestValue);
    signal?.throwIfAborted();
    // Only this explicit branch reads immutable package bytes, outside lifecycle/control admission.
    if (request.kind === 'source') return this.packages.readSource(request, signal);
    // list/describe remain pure metadata reads: no package preparation or provider activation.
    for (;;) {
      signal?.throwIfAborted();
      const revision = this.#revision;
      const catalog = await this.catalog.snapshot();
      const services = this.services.getSnapshot();
      const routing = await this.routing.read();
      const workbench = await this.workbench.snapshot();
      if (revision === this.#revision) return queryRuntimeContracts({ catalog, services, routing, workbench, revision }, request, scope,
        owner => this.supervisor.getRetainedArtifactIdentity(owner), owner => this.supervisor.getRetainedComposition(owner));
    }
  }

  /** A stable preparation-cache token only outside original lifecycle mutations. It never
   * snapshots or activates the catalog, and is not a second selection/configuration revision. */
  get preparationRevision(): number | undefined {
    if (this.#stopped) throw new Error("Application extension runtime is stopped");
    return this.#mutations.size === 0 ? this.#revision : undefined;
  }

  subscribe(listener: () => void): () => void {
    if (this.#stopped) throw new Error("Application extension runtime is stopped");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async waitForState(
    requestValue: VarinExtensionHostStateWaitRequest | unknown,
    signal?: AbortSignal,
  ): Promise<VarinExtensionHostStateSnapshot> {
    const request = parseVarinExtensionHostStateWaitRequest(requestValue);
    const current = await this.state();
    if (request.hostId !== current.catalog.hostId || request.revision !== current.revision) return current;
    return new Promise((resolveWait, rejectWait) => {
      let disposed = false;
      const finish = (callback: () => void) => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => rejectWait(signal?.reason ?? new Error("Extension host-state wait aborted")));
      const onChange = () => {
        void this.state().then(
          (next) => finish(() => resolveWait(next)),
          (error) => finish(() => rejectWait(error)),
        );
      };
      const unsubscribe = this.subscribe(onChange);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      if (this.#revision !== request.revision) onChange();
    });
  }

  reconcile(snapshot?: VarinExtensionCatalogSnapshot): Promise<void> {
    return this.#mutate(async () => {
      await this.supervisor.reconcile(snapshot);
      this.#publish();
    });
  }

  installOrStage(
    requestValue: VarinExtensionPackageInstallRequest | unknown,
    signal?: AbortSignal,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionPackageInstallRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const snapshot = await this.packages.installOrStage(request.source, request.expectedRevision, signal);
      await this.supervisor.reconcile(snapshot);
      return this.catalog.snapshot();
    });
  }

  stageCapturedPackage(directory: string, provenance: VarinExtensionSourceViewProvenance, expectedRevision: number,
    signal?: AbortSignal, onMutation?: () => void): Promise<VarinExtensionPackageResult> {
    return this.#mutate(async () => {
      const result = await this.packages.stageCaptured(directory, provenance, expectedRevision, signal, onMutation);
      // Staging revokes obsolete preparation without cold-activating selected providers.
      // The package result is already durable; cleanup failure cannot erase that effect.
      try { await this.supervisor.reconcileCandidatePreparations(); }
      catch (error) {
        try { this.#onObserverError(error); }
        catch { console.error("[VarinExtensions] Candidate cleanup error reporting failed"); }
      }
      this.#publish();
      return result;
    });
  }

  /** An already-authorized exact update, not permission to enable an extension or grant capabilities. */
  applyPackageCandidate(requestValue: VarinExtensionCandidateSelectionRequest | unknown,
    signal?: AbortSignal, onMutation?: () => void): Promise<VarinExtensionPackageResult> {
    const request = parseVarinExtensionCandidateSelectionRequest(requestValue);
    return this.#mutate(async () => {
      signal?.throwIfAborted();
      const before = await this.catalog.snapshot();
      const entry = before.extensions.find(value => value.manifest.id === request.extensionId);
      if (!entry?.desired.enabled) throw new Error("extension_package_enable_required");
      if (!entry.candidate || entry.candidate.integrity !== request.candidateIntegrity) throw new Error("extension_package_candidate_changed");
      if (!entry.candidate.capabilitiesReviewed) throw new Error("extension_package_capability_review_required");
      signal?.throwIfAborted();
      onMutation?.();
      const requested = await this.catalog.requestCandidateApplication(request.extensionId, request.candidateIntegrity, request.expectedRevision);
      this.#publish();
      const result = (outcome: "application_requested" | "selected", catalogRevision: number): VarinExtensionPackageResult => ({
        outcome, extensionId: request.extensionId, artifactIntegrity: request.candidateIntegrity, catalogRevision,
        applicationRequested: true, resumesOnRestart: true,
      });
      if (signal?.aborted) return result("application_requested", requested.revision);
      try {
        const selected = await this.supervisor.selectCandidate(request.extensionId, request.candidateIntegrity, requested.revision, signal);
        this.#publish();
        return result("selected", selected.revision);
      } catch (error) {
        // The durable application request already committed. Neither cancellation nor a
        // failed preparation erases it; the original lifecycle owner may resume on restart.
        let current: VarinExtensionCatalogSnapshot;
        try { current = await this.catalog.snapshot(); }
        catch (readError) {
          throw new ExtensionPackageApplicationError(result("application_requested", requested.revision),
            new AggregateError([error, readError], "Candidate preparation failed and its current catalog could not be read"));
        }
        if (current.extensions.some(value => value.manifest.id === request.extensionId && value.integrity === request.candidateIntegrity)) {
          return result("selected", current.revision);
        }
        if (signal?.aborted || error instanceof ExtensionUpdateReadinessError && error.code === "required_surface_readiness") {
          this.#publish();
          return result("application_requested", current.revision);
        }
        throw new ExtensionPackageApplicationError(result("application_requested", current.revision), error);
      }
    });
  }

  reloadLocalSource(
    requestValue: VarinExtensionLocalSourceReloadRequest | unknown,
    signal?: AbortSignal,
  ): Promise<VarinExtensionLocalSourceReloadResult> {
    const request = parseVarinExtensionLocalSourceReloadRequest(requestValue);
    return this.#mutate(async () => {
      const result = await this.packages.reloadLocalSource(request, signal);
      if (result.outcome === "staged") {
        await this.supervisor.reconcile(result.snapshot);
        this.#publish();
      }
      return result;
    });
  }

  removeExtension(
    requestValue: VarinExtensionRemoveRequest | unknown,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionRemoveRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const current = await this.catalog.snapshot();
      if (current.revision !== request.expectedRevision) {
        return this.catalog.remove(request.extensionId, request.expectedRevision);
      }
      const entry = current.extensions.find((candidate) => candidate.manifest.id === request.extensionId);
      if (!entry) throw new Error(`Varin extension is not installed: ${request.extensionId}`);
      if (entry.source.kind === "builtin") throw new Error(`Built-in Varin extensions are managed by the distribution: ${request.extensionId}`);
      if (entry.desired.enabled) throw new Error(`Disable the Varin extension before removing it: ${request.extensionId}`);
      try {
        let removed: VarinExtensionCatalogSnapshot | undefined;
        await this.supervisor.deactivateExtension(request.extensionId, async () => {
          removed = await this.catalog.remove(request.extensionId, request.expectedRevision);
          if (request.deleteData) {
            try {
              await this.storage.deleteExtensionData(request.extensionId);
            } catch (error) {
              throw new ExtensionStorageError(
                "storage_write_failed",
                `Varin extension ${request.extensionId} was removed, but its namespaced storage could not be deleted`,
                { cause: error },
              );
            }
          }
        });
        if (!removed) throw new Error("Extension removal did not complete");
        await this.supervisor.reconcile(removed);
        return removed;
      } catch (error) {
        await this.supervisor.reconcile(await this.catalog.snapshot()).catch(() => undefined);
        throw error;
      }
    });
  }

  setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    return this.#mutateCatalog(async () => {
      const snapshot = await this.catalog.setEnabled(extensionId, enabled, expectedRevision);
      await this.supervisor.reconcile(snapshot);
      return this.catalog.snapshot();
    });
  }

  setAllEnabled(enabled: boolean, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    return this.#mutateCatalog(async () => {
      const snapshot = await this.catalog.setAllEnabled(enabled, expectedRevision);
      await this.supervisor.reconcile(snapshot);
      return this.catalog.snapshot();
    });
  }

  prepareCandidate(extensionId: string, integrity: string, signal?: AbortSignal): Promise<VarinExtensionCandidatePreparationResult> {
    return this.#mutate(async () => {
      signal?.throwIfAborted();
      const prepared = await this.supervisor.prepareCandidate(extensionId, integrity);
      signal?.throwIfAborted();
      this.#publish();
      return prepared;
    });
  }

  activateExtension(extensionId: string): Promise<void> {
    return this.#mutate(async () => {
      await this.#ensureBuiltinArtifact(extensionId);
      await this.supervisor.activateExtension(extensionId);
      this.#publish();
    });
  }

  activateForEvent(event: VarinExtensionActivationEvent, { languageId }: { languageId?: string } = {}): Promise<void> {
    return this.#mutate(async () => {
      const snapshot = await this.catalog.snapshot();
      if (!snapshot.authoritative) throw new Error("Cannot activate extensions from a stale catalog");
      await Promise.all(snapshot.extensions.map(async (entry) => {
        if (!entry.desired.enabled || !entry.manifest.entrypoints?.host?.activation?.includes(event)) return;
        // Built-in language ownership is known before activation. A TypeScript
        // request must not first materialize the unrelated Python/tooling pack.
        // Third-party workspace activations keep their declared event behavior.
        if (event === "workspace-match" && languageId && entry.source.kind === "builtin") {
          const bundled = VARIN_BUNDLED_LANGUAGE_SERVERS.filter((server) => server.extensionId === entry.manifest.id);
          if (bundled.length > 0 && !bundled.some((server) => server.languageIds.includes(languageId))) return;
        }
        await this.#ensureBuiltinArtifact(entry.manifest.id);
        await this.supervisor.activateExtension(entry.manifest.id);
      }));
      this.#publish();
    });
  }

  discardPreparedCandidate(extensionId: string, integrity: string): Promise<void> {
    return this.#mutate(async () => {
      await this.supervisor.discardPreparedCandidate(extensionId, integrity);
      this.#publish();
    });
  }

  discardCandidate(
    requestValue: VarinExtensionCandidateSelectionRequest | unknown,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionCandidateSelectionRequest(requestValue);
    return this.#mutateCatalog(async () => {
      // This is an explicit catalog rejection, unlike optional Surface preparation cleanup.
      // Establish its CAS outcome before revoking preparation; a competing selected winner
      // must never be killed by a stale discard request.
      const snapshot = await this.catalog.discardCandidate(
        request.extensionId,
        request.candidateIntegrity,
        request.expectedRevision,
      );
      try {
        await this.supervisor.reconcile(snapshot);
        await this.supervisor.discardPreparedCandidate(request.extensionId, request.candidateIntegrity);
        return snapshot;
      } catch (error) {
        await this.supervisor.reconcile(await this.catalog.snapshot()).catch(() => undefined);
        throw error;
      }
    });
  }

  selectCandidate(
    requestValue: VarinExtensionCandidatePublicationRequest | unknown,
    signal?: AbortSignal,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionCandidatePublicationRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const selected = await this.supervisor.selectCandidate(
        request.extensionId,
        request.candidateIntegrity,
        request.expectedRevision,
        signal,
        request.surfaceReadiness,
      );
      await this.supervisor.reconcile(selected);
      return this.catalog.snapshot();
    });
  }

  requestCandidateApplication(
    requestValue: VarinExtensionCandidateSelectionRequest | unknown,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionCandidateSelectionRequest(requestValue);
    return this.#mutateCatalog(() => this.catalog.requestCandidateApplication(
      request.extensionId,
      request.candidateIntegrity,
      request.expectedRevision,
    ));
  }

  reviewCandidateCapabilities(
    requestValue: VarinExtensionCandidateCapabilityReviewRequest | unknown,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionCandidateCapabilityReviewRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const reviewed = await this.catalog.reviewCandidateCapabilities(request);
      await this.supervisor.reconcile(reviewed);
      return this.catalog.snapshot();
    });
  }

  reviewCapabilities(
    requestValue: VarinExtensionCapabilityReviewRequest | unknown,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionCapabilityReviewRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const reviewed = await this.catalog.reviewCapabilities(request);
      await this.supervisor.reconcile(reviewed);
      return this.catalog.snapshot();
    });
  }

  reportActualState(extensionId: string, stateValue: VarinExtensionActualState | unknown): Promise<void> {
    const state = parseVarinExtensionActualState(stateValue);
    return this.#mutate(async () => {
      await this.catalog.reportActualState(extensionId, state);
      this.#publish();
    });
  }

  invokeService(request: VarinExtensionServiceInvocationRequest | unknown, signal?: AbortSignal, principal?: string): Promise<JsonValue> {
    if (this.#stopped) return Promise.reject(new Error("Application extension runtime is stopped"));
    const parsed = parseVarinExtensionServiceInvocationRequest(request);
    if (parsed.lease) {
      const lease = this.#surfaceLeases.get(parsed.lease.id), service = lease?.services.get(parsed.providerId!);
      if (!principal || lease?.principal !== principal || !isDeepStrictEqual(lease.owner, parsed.lease.owner)
        || !service || service.serviceId !== parsed.serviceId || service.version !== parsed.version) {
        return Promise.reject(new Error('Surface service invocation does not belong to this authenticated composition owner'));
      }
      return service.pin.invoke(parsed.method, parsed.args, signal);
    }
    const providerId = parsed.providerId;
    if (typeof providerId === "string" && this.supervisor.hasStagedProvider(providerId)) {
      return this.supervisor.invokeStagedService(parsed, signal);
    }
    return this.prepareService(parsed, { ...(signal ? { signal } : {}) }).then(async binding => {
      try { return await binding.invoke(parsed.method, parsed.args, signal); } finally { binding.release(); }
    });
  }

  /** The authenticated response stream is the sole owner of these preparation references. */
  async watchServiceLease(requestValue: VarinSurfaceServiceLeaseRequest | unknown, principal: string,
    emit: (event: VarinSurfaceServiceLeaseEvent) => void, signal: AbortSignal): Promise<void> {
    if (!principal || this.#stopped) throw new Error('Authenticated Surface owner is unavailable');
    const request = parseVarinSurfaceServiceLeaseRequest(requestValue);
    signal.throwIfAborted();
    const catalog = await this.catalog.snapshot(), routing = await this.routing.read();
    if (!catalog.authoritative || !routing.authoritative || catalog.hostId !== request.owner.hostId
      || routing.document.revision !== request.expectedRoutingRevision) throw new Error('Surface composition selection is stale');
    const entry = catalog.extensions.find(value => value.manifest.id === request.owner.extensionId);
    const source = request.slot === 'candidate' ? entry?.candidate : entry;
    const manifest = source?.manifest;
    const surface = manifest?.entrypoints?.surfaces?.find(value => value.id === request.owner.entrypointId);
    const declarative = manifest && request.owner.entrypointId === resolveVarinSurfaceManifestOwner(manifest, request.surface)?.entrypointId;
    if (!entry?.desired.enabled || !manifest || source?.integrity !== request.artifactIntegrity || manifest.version !== request.owner.extensionVersion
      || entry.desired.revision !== request.owner.desiredRevision || (!surface?.supports.includes(request.surface) && !declarative)
      || (request.slot === 'candidate' && !entry.candidate?.capabilitiesReviewed)) throw new Error('Surface composition does not match its canonical owner declaration');
    const selectedCatalog = { ...catalog, extensions: catalog.extensions.map(value => value === entry ? { ...entry,
      manifest, integrity: request.artifactIntegrity, capabilityGrants: source.capabilityGrants } : value) };
    const roots = new Map<string, HostCompositionLease>();
    const bindings: HostServiceBinding[] = [], pins: HostServicePin[] = [];
    const revoked = new AbortController();
    const lifetime = AbortSignal.any([signal, revoked.signal]);
    const id = randomUUID();
    let unwatch = () => {}, ready = false;
    const revoke = () => revoked.abort(new Error('Surface composition was revoked'));
    const candidate = request.slot === 'candidate' ? { extensionId: entry.manifest.id, integrity: request.artifactIntegrity } : undefined;
    const acquire = async (extensionId: string) => {
      let root = roots.get(extensionId);
      if (!root) {
        root = await this.supervisor.prepareSurfaceExtension(extensionId, request.routing, lifetime, candidate);
        roots.set(extensionId, root);
        root.revocationSignal.addEventListener('abort', revoke, { once: true });
        if (root.revocationSignal.aborted) revoke();
      }
      return root;
    };
    try {
      if (manifest.entrypoints?.host && surface) await acquire(entry.manifest.id);
      const grouped = new Map<string, typeof request.services>();
      for (const service of request.services) {
        const key = `${service.serviceId}@${service.version}`;
        grouped.set(key, [...(grouped.get(key) ?? []), service]);
      }
      for (const choices of grouped.values()) {
        const service = choices[0]!;
        const requirement = manifest.requires?.services?.find(value => value.realms.includes('surface') && value.id === service.serviceId && value.version === service.version);
        const own = manifest.provides?.services?.some(value => value.id === service.serviceId && value.version === service.version);
        if (!requirement && !own) throw new Error('Surface service is not declared by its canonical consumer');
        if (requirement?.binding !== 'all' && choices.length !== 1) throw new Error('Surface service declaration requires one exact implementation');
        const candidates = selectedCatalog.extensions.flatMap(value => value.desired.enabled && value.manifest.entrypoints?.host
          && value.manifest.provides?.services?.some(item => item.id === service.serviceId && item.version === service.version)
          ? [{ providerId: value.manifest.id, providerKey: `${value.manifest.id}:host:${service.serviceId}@${service.version}` }] : []);
        const native = registeredWorkbenchDeclarations(selectedCatalog, this.services.getSnapshot().providers, service.serviceId, service.version);
        const declared = [...candidates, ...native.map(provider => ({ providerId: provider.extensionId, providerKey: provider.providerKey }))];
        const resolution = requirement?.binding === 'selected' ? resolveVarinExtensionServiceRouting({ candidates: declared,
          document: routing.document, context: request.routing, serviceId: service.serviceId, version: service.version }) : undefined;
        if (resolution && (resolution.status !== 'resolved' || choices.some(choice => !resolution.providerKeys.includes(choice.providerKey)))) throw new Error('Surface service differs from its original scoped routing selection');
        for (const choice of choices) {
          const declaration = declared.find(value => value.providerKey === choice.providerKey);
          if (!declaration || (!requirement && declaration.providerId !== entry.manifest.id)) throw new Error('Surface Host provider is not a canonical declaration');
          const nativeMatches = native.filter(value => value.providerKey === choice.providerKey);
          const binding = nativeMatches.length === 1 ? this.services.bind(service.serviceId, service.version, nativeMatches[0]!.providerId)
            : (await acquire(declaration.providerId)).bind(service.serviceId, service.version);
          bindings.push(binding);
          const pin = binding.pin(); pins.push(pin);
          pin.revocationSignal.addEventListener('abort', revoke, { once: true });
          if (pin.revocationSignal.aborted) revoke();
        }
      }
      lifetime.throwIfAborted();
      const latest = await this.routing.read();
      if (!latest.authoritative || latest.document.revision !== request.expectedRoutingRevision) throw new Error('Surface service routing changed during preparation');
      const owner = { realmId: request.owner.realmId, extensionId: request.owner.extensionId,
        entrypointId: request.owner.entrypointId, generation: request.owner.generation };
      this.#surfaceLeases.set(id, { principal, owner, revoke, services: new Map(bindings.map((binding, index) => [binding.providerId,
        { pin: pins[index]!, serviceId: binding.descriptor.id, version: binding.descriptor.version }])) });
      let checking = false, dirty = false;
      const check = async () => {
        dirty = true; if (checking) return; checking = true;
        try { while (dirty && !lifetime.aborted) {
          dirty = false;
          const snapshot = await this.catalog.snapshot(), current = snapshot.extensions.find(value => value.manifest.id === entry.manifest.id);
          if (!snapshot.authoritative || !current?.desired.enabled) { revoke(); return; }
          const grants = current.candidate?.integrity === request.artifactIntegrity ? current.candidate.capabilityGrants : current.capabilityGrants;
          if (source.capabilityGrants.some(grant => grant.realm === 'surface' && grant.granted
            && grants.some(value => value.realm === grant.realm && value.capability === grant.capability && !value.granted))) revoke();
        } } finally { checking = false; }
      };
      unwatch = this.subscribe(() => { void check().catch(revoke); });
      await check(); lifetime.throwIfAborted();
      const providers = bindings.map(binding => this.services.getSnapshot().providers.find(provider => provider.providerId === binding.providerId)!);
      if (providers.some(provider => !provider)) throw new Error('Surface service provider retired during preparation');
      emit({ kind: 'ready', leaseId: id, routingRevision: request.expectedRoutingRevision, providers }); ready = true;
      await new Promise<void>(resolve => { if (lifetime.aborted) resolve(); else lifetime.addEventListener('abort', () => resolve(), { once: true }); });
      if (!signal.aborted && revoked.signal.aborted) emit({ kind: 'revoked', code: 'binding_revoked' });
    } catch (error) {
      if (!signal.aborted) emit({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      if (!ready && signal.aborted) signal.throwIfAborted();
    } finally {
      this.#surfaceLeases.delete(id); unwatch();
      for (const pin of pins) { pin.revocationSignal.removeEventListener('abort', revoke); pin.release(); }
      for (const binding of bindings) binding.release();
      for (const root of roots.values()) { root.revocationSignal.removeEventListener('abort', revoke); root.release(); }
    }
  }

  /** Resolve once at a caller's preparation boundary, then invoke the exact bound implementation.
   * Routing remains owned by ServiceRoutingStore; the returned handle is not another selection store.
   * Callers with a frozen exchange can pin the handle and must release it when that exchange settles.
   */
  async prepareService(request: VarinExtensionServiceInvocationRequest | unknown, options?: HostServicePreparationOptions): Promise<HostServiceBinding> {
    const { bindings } = await this.#prepareServices(request, options, false);
    if (bindings.length !== 1) { bindings.forEach(binding => binding.release()); throw new HostServiceBindingError("selected_unavailable", "Single-service preparation requires exactly one provider"); }
    const [binding] = bindings;
    return binding!;
  }

  /** Explicit ordered-contract consumer. Never changes the ordinary service invocation shape. */
  prepareServiceCollection(request: VarinExtensionServiceInvocationRequest | unknown,
    options?: HostServicePreparationOptions): Promise<PreparedHostServiceCollection> {
    return this.#prepareServices(request, options, true);
  }

  /** Pure declaration/configuration resolution for immutable value caches. No worker or lease
   * is acquired, and ordinary worker retirement cannot invalidate unchanged composition identity. */
  async resolveServiceCompositions(request: VarinExtensionServiceInvocationRequest | unknown,
    options?: Pick<HostServicePreparationOptions, 'defaultProviderKey' | 'expectedRoutingRevision' | 'signal'> & { collection?: boolean }): Promise<ResolvedHostServiceCompositions> {
    if (this.#stopped) throw new Error('Application extension runtime is stopped');
    const parsed = parseVarinExtensionServiceInvocationRequest(request);
    if (parsed.providerId) throw new Error('Declaration resolution does not accept a live provider identity');
    for (;;) {
      options?.signal?.throwIfAborted();
      const revision = this.#revision;
      const [catalog, routing] = await Promise.all([this.catalog.snapshot(), this.routing.read()]);
      if (!catalog.authoritative || !routing.authoritative) throw new Error('Cannot resolve a Host composition from stale selection state');
      if (options?.expectedRoutingRevision !== undefined && options.expectedRoutingRevision !== routing.document.revision) throw new Error('Host service routing changed during resolution');
      const resolution = resolveDeclaredServiceRouting(catalog, routing, parsed.serviceId, parsed.version, parsed.routing,
        options?.defaultProviderKey, options?.collection ? 'ordered' : undefined);
      if (resolution.status !== 'resolved') throw new HostServiceBindingError(resolution.status === 'ambiguous' ? 'ambiguous'
        : resolution.matchedRule ? 'selected_unavailable' : 'missing', resolution.diagnostics.map(diagnostic => diagnostic.message).join('; '));
      const services = resolution.extensionIds.map(extensionId => {
        const plan = createHostCompositionPlan(catalog, routing, extensionId, parsed.routing);
        const descriptor = plan.root.entry.manifest.provides!.services!.find(service => service.id === parsed.serviceId && service.version === parsed.version)!;
        if (options?.collection && descriptor.contract?.composition !== 'ordered') throw new HostServiceBindingError('selected_unavailable', 'Every selected provider must declare ordered composition');
        return { providerKey: `${extensionId}:host:${parsed.serviceId}@${parsed.version}`, descriptor: structuredClone(descriptor), composition: plan.composition };
      });
      options?.signal?.throwIfAborted();
      if (revision === this.#revision) return { services, routingRevision: routing.document.revision };
    }
  }

  async #prepareServices(request: VarinExtensionServiceInvocationRequest | unknown,
    options: HostServicePreparationOptions | undefined, collection: boolean): Promise<PreparedHostServiceCollection> {
    if (this.#stopped) throw new Error("Application extension runtime is stopped");
    const parsed = parseVarinExtensionServiceInvocationRequest(request);
    options?.signal?.throwIfAborted();
    const result = (bindings: HostServiceBinding[], routingRevision: number): PreparedHostServiceCollection => {
      if (collection && bindings.some(binding => binding.descriptor.contract?.composition !== 'ordered')) {
        bindings.forEach(binding => binding.release());
        throw new HostServiceBindingError("selected_unavailable", "Every selected provider must declare ordered composition");
      }
      return { bindings, routingRevision };
    };
    if (parsed.providerId) return result([this.services.bind(parsed.serviceId, parsed.version, parsed.providerId)], 0);
    const [catalog, routing] = await Promise.all([this.catalog.snapshot(), this.routing.read()]);
    if (!catalog.authoritative || (!options?.frozenComposition && !routing.authoritative)) throw new Error("Cannot prepare a Host service from stale selection state");
    if (options?.expectedRoutingRevision !== undefined && routing.document.revision !== options.expectedRoutingRevision) throw new Error("Host service routing changed during preparation");
    const frozen = options?.frozenComposition;
    const root = frozen?.nodes.find(node => node.id === frozen.root);
    const resolution = frozen && root ? { status: 'resolved' as const, extensionIds: [root.extensionId],
      providerKeys: [`${root.extensionId}:host:${parsed.serviceId}@${parsed.version}`] }
      : resolveDeclaredServiceRouting(catalog, routing, parsed.serviceId, parsed.version,
        parsed.routing, options?.defaultProviderKey, collection ? 'ordered' : undefined, this.services.getSnapshot().providers);
    if (resolution.status !== 'resolved') throw new HostServiceBindingError(resolution.status === 'ambiguous' ? 'ambiguous'
      : resolution.matchedRule ? 'selected_unavailable' : 'missing', resolution.diagnostics.map(diagnostic => diagnostic.message).join('; '));
    const bindings: HostServiceBinding[] = [];
    const prepared = await Promise.allSettled(resolution.extensionIds.map(async (id, index) => {
      const native = registeredWorkbenchDeclarations(catalog, this.services.getSnapshot().providers, parsed.serviceId, parsed.version)
        .filter(provider => provider.providerKey === resolution.providerKeys[index]);
      if (native.length) {
        if (native.length !== 1 || frozen) throw new Error('Workbench service owner identity is unavailable');
        return this.services.bind(parsed.serviceId, parsed.version, native[0]!.providerId);
      }
      const lease = await this.supervisor.prepareExtension(id, parsed.routing, options?.signal, frozen);
      try {
        const binding = lease.bind(parsed.serviceId, parsed.version);
        let released = false;
        const selected: HostServiceBinding = Object.freeze({ ...binding, release: () => {
          if (released) return; released = true; binding.release(); lease.release();
        } });
        return selected;
      } catch (error) { lease.release(); throw error; }
    }));
    for (const value of prepared) if (value.status === 'fulfilled') bindings.push(value.value);
    try {
      const failure = prepared.find(value => value.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      options?.signal?.throwIfAborted();
      if (this.#stopped) throw new Error('Application extension runtime is stopped');
      if (!frozen) {
        const current = await this.routing.read();
        if (!current.authoritative || current.document.revision !== routing.document.revision) throw new Error('Host service routing changed during preparation');
      }
      return result(bindings, routing.document.revision);
    } catch (error) { bindings.forEach(binding => binding.release()); throw error; }
  }

  upsertServiceRoutingRule(
    request: VarinExtensionServiceRoutingRuleUpdateRequest | unknown,
  ): Promise<VarinExtensionServiceRoutingSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.routing.upsertRule(request);
      this.#publish();
      return snapshot;
    });
  }

  removeServiceRoutingRule(
    request: VarinExtensionServiceRoutingRuleRemoveRequest | unknown,
  ): Promise<VarinExtensionServiceRoutingSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.routing.removeRule(request);
      this.#publish();
      return snapshot;
    });
  }

  updateWorkbenchLayout(
    request: VarinWorkbenchLayoutUpdateRequest | unknown,
  ): Promise<VarinWorkbenchProfileSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.workbench.updateLayout(request);
      this.#publish();
      return snapshot;
    });
  }

  selectWorkbenchProfile(
    request: VarinWorkbenchProfileSelectionRequest | unknown,
  ): Promise<VarinWorkbenchProfileSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.workbench.selectProfile(request);
      this.#publish();
      return snapshot;
    });
  }

  upsertWorkbenchProfile(
    request: VarinWorkbenchProfileUpsertRequest | unknown,
  ): Promise<VarinWorkbenchProfileSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.workbench.upsertProfile(request);
      this.#publish();
      return snapshot;
    });
  }

  removeWorkbenchProfile(
    request: VarinWorkbenchProfileRemoveRequest | unknown,
  ): Promise<VarinWorkbenchProfileSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.workbench.removeProfile(request);
      this.#publish();
      return snapshot;
    });
  }

  applyWorkbenchProfile(
    requestValue: VarinWorkbenchProfileApplyRequest | unknown,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinWorkbenchProfileApplyRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const workbench = await this.workbench.read();
      if (!workbench.authoritative) throw new Error("Cannot apply a stale workbench profile");
      const profile = workbench.document.profiles.find((candidate) => candidate.id === request.profileId);
      if (!profile) throw new Error(`Workbench profile is not installed: ${request.profileId}`);
      if (!profile.extensionIds) throw new Error(`Workbench profile does not define an extension set: ${request.profileId}`);
      const snapshot = await this.catalog.setEnabledSet(profile.extensionIds, request.expectedCatalogRevision);
      await this.supervisor.reconcile(snapshot);
      return snapshot;
    });
  }

  stop(): Promise<void> {
    if (this.#stop) return this.#stop;
    this.#stopped = true;
    for (const lease of this.#surfaceLeases.values()) lease.revoke();
    // Close supervisor admission and cancel unpublished workers before waiting for callers.
    const shutdown = this.supervisor.shutdown();
    this.#stop = (async () => {
      const results = await Promise.allSettled([shutdown, ...this.#mutations]);
      this.#serviceUnsubscribe();
      this.#publish();
      this.#listeners.clear();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Extension Host shutdown reported failures");
    })();
    return this.#stop;
  }

  async #ensureBuiltinArtifact(extensionId: string): Promise<void> {
    const pending = this.#builtinPreparations.get(extensionId);
    if (pending) return pending;
    const definition = VARIN_BUILTIN_EXTENSION_DEFINITIONS.find((candidate) => (
      candidate.manifest.id === extensionId && candidate.manifest.entrypoints?.host
    ));
    if (!definition) return;
    const preparation = (async () => {
      const snapshot = await this.catalog.snapshot();
      await this.packages.reconcileBuiltinArtifacts([definition], snapshot);
    })();
    this.#builtinPreparations.set(extensionId, preparation);
    try { await preparation; }
    finally {
      if (this.#builtinPreparations.get(extensionId) === preparation) this.#builtinPreparations.delete(extensionId);
    }
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#stopped) return Promise.reject(new Error("Application extension runtime is stopped"));
    // Catalog, routing and storage owners already serialize their revision-checked writes.
    // Tracking admission here must not serialize downloads, activation or retirement.
    const result = Promise.resolve().then(() => {
      if (this.#stopped) throw new Error("Application extension runtime is stopped");
      return operation();
    });
    const settled = result.then(() => undefined, () => undefined);
    this.#mutations.add(settled);
    void settled.then(() => this.#mutations.delete(settled));
    return result;
  }

  #mutateCatalog(operation: () => Promise<VarinExtensionCatalogSnapshot>): Promise<VarinExtensionCatalogSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await operation();
      this.#publish();
      return snapshot;
    });
  }

  #publish(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) {
      try { listener(); }
      catch (error) {
        try { this.#onObserverError(error); }
        catch { console.error("[VarinExtensions] Observer error reporting failed"); }
      }
    }
  }
}
