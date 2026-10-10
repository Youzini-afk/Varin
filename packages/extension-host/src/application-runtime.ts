import {
  assertVarinApplicationVersion,
  parseVarinExtensionActualState,
  parseVarinExtensionCandidateCapabilityReviewRequest,
  parseVarinExtensionCandidateSelectionRequest,
  parseVarinExtensionCapabilityReviewRequest,
  parseVarinExtensionHostStateWaitRequest,
  parseVarinExtensionLocalSourceReloadRequest,
  parseVarinExtensionPackageInstallRequest,
  parseVarinExtensionRemoveRequest,
  parseVarinExtensionServiceInvocationRequest,
  parseVarinExtensionServiceSelectionRequest,
  parseVarinWorkbenchProfileApplyRequest,
  resolveVarinExtensionServiceRouting,
  type JsonValue,
  type VarinExtensionActivationEvent,
  type VarinExtensionActualState,
  type VarinExtensionCandidateCapabilityReviewRequest,
  type VarinExtensionCandidateSelectionRequest,
  type VarinExtensionCapabilityReviewRequest,
  type VarinExtensionCandidatePreparationResult,
  type VarinExtensionCatalogSnapshot,
  type VarinExtensionHostStateSnapshot,
  type VarinExtensionHostStateWaitRequest,
  type VarinExtensionLocalSourceReloadRequest,
  type VarinExtensionLocalSourceReloadResult,
  type VarinExtensionPackageInstallRequest,
  type VarinExtensionRemoveRequest,
  type VarinExtensionServiceInvocationRequest,
  type VarinExtensionServiceRoutingRuleRemoveRequest,
  type VarinExtensionServiceRoutingRuleUpdateRequest,
  type VarinExtensionServiceRoutingSnapshot,
  type VarinExtensionServiceSelectionRequest,
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
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import { BrokeredHostSupervisor, type BrokeredHostTransportFactory } from "./broker-supervisor.js";
import { HostCapabilityRegistry } from "./capability-registry.js";
import { ExtensionPackageManager } from "./package-manager.js";
import { HostServiceRegistry, HostServiceBindingError, type HostServiceBinding } from "./service-registry.js";
import { ServiceRoutingStore } from "./service-routing-store.js";
import { ExtensionStorageError } from "./errors.js";
import { ExtensionStorageStore } from "./storage-store.js";
import { WorkbenchProfileStore } from "./workbench-profile-store.js";

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
  readonly #serviceUnsubscribe: () => void;
  #revision = 0;
  readonly #mutations = new Set<Promise<void>>();
  readonly #builtinPreparations = new Map<string, Promise<void>>();
  #stop: Promise<void> | undefined;
  #stopped = false;

  private constructor(options: ApplicationExtensionRuntimeOptions, hostId: string) {
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
      invokeService: async (request, signal) => {
        const parsed = parseVarinExtensionServiceInvocationRequest(request);
        return (await this.#bindRegisteredService(parsed)).invoke(parsed.method, parsed.args, signal);
      },
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

  prepareCandidate(extensionId: string, integrity: string): Promise<VarinExtensionCandidatePreparationResult> {
    return this.#mutate(async () => {
      const prepared = await this.supervisor.prepareCandidate(extensionId, integrity);
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
      const current = await this.catalog.snapshot();
      if (current.revision !== request.expectedRevision) {
        return this.catalog.discardCandidate(
          request.extensionId,
          request.candidateIntegrity,
          request.expectedRevision,
        );
      }
      await this.supervisor.discardPreparedCandidate(request.extensionId, request.candidateIntegrity);
      try {
        const snapshot = await this.catalog.discardCandidate(
          request.extensionId,
          request.candidateIntegrity,
          request.expectedRevision,
        );
        await this.supervisor.reconcile(snapshot);
        return snapshot;
      } catch (error) {
        await this.supervisor.reconcile(await this.catalog.snapshot()).catch(() => undefined);
        throw error;
      }
    });
  }

  selectCandidate(
    requestValue: VarinExtensionCandidateSelectionRequest | unknown,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const request = parseVarinExtensionCandidateSelectionRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const selected = await this.supervisor.selectCandidate(
        request.extensionId,
        request.candidateIntegrity,
        request.expectedRevision,
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

  invokeService(request: VarinExtensionServiceInvocationRequest | unknown, signal?: AbortSignal): Promise<JsonValue> {
    if (this.#stopped) return Promise.reject(new Error("Application extension runtime is stopped"));
    const parsed = parseVarinExtensionServiceInvocationRequest(request);
    const providerId = parsed.providerId;
    if (typeof providerId === "string" && this.supervisor.hasStagedProvider(providerId)) {
      return this.supervisor.invokeStagedService(parsed, signal);
    }
    return this.prepareService(parsed).then((binding) => binding.invoke(parsed.method, parsed.args, signal));
  }

  /** Resolve once at a caller's preparation boundary, then invoke the exact bound implementation.
   * Routing remains owned by ServiceRoutingStore; the returned handle is not another selection store.
   * Callers with a frozen exchange can pin the handle and must release it when that exchange settles.
   */
  async prepareService(request: VarinExtensionServiceInvocationRequest | unknown, options?: { defaultProviderKey?: string; expectedRoutingRevision?: number }): Promise<HostServiceBinding> {
    if (this.#stopped) throw new Error("Application extension runtime is stopped");
    const parsed = parseVarinExtensionServiceInvocationRequest(request);
    if (parsed.providerId) return this.services.bind(parsed.serviceId, parsed.version, parsed.providerId);
    const [catalog, routing] = await Promise.all([this.catalog.snapshot(), this.routing.read()]);
    if (!catalog.authoritative || !routing.authoritative) throw new Error("Cannot prepare a Host service from stale selection state");
    if (options?.expectedRoutingRevision !== undefined && routing.document.revision !== options.expectedRoutingRevision) {
      throw new Error("Host service routing changed during preparation");
    }
    const legacySelection = this.services.getSnapshot().selections[`${parsed.serviceId}@${parsed.version}`];
    if (legacySelection) return this.services.bind(parsed.serviceId, parsed.version, legacySelection);
    const candidates = catalog.extensions.filter(entry => entry.desired.enabled && entry.manifest.entrypoints?.host
      && entry.manifest.provides?.services?.some(service => service.id === parsed.serviceId && service.version === parsed.version))
      .map(entry => ({ extensionId: entry.manifest.id,
        providerKey: `${entry.manifest.id}:host:${parsed.serviceId}@${parsed.version}`,
        providerId: entry.manifest.id }));
    const resolution = resolveVarinExtensionServiceRouting({ candidates, document: routing.document,
      serviceId: parsed.serviceId, version: parsed.version,
      ...(parsed.routing ? { context: parsed.routing } : {}),
      ...(options?.defaultProviderKey ? { defaultProviderKey: options.defaultProviderKey } : {}),
    });
    if (resolution.status !== "resolved" || !resolution.providerId || !resolution.providerKey) {
      throw new HostServiceBindingError(resolution.status === "ambiguous" ? "ambiguous"
        : resolution.matchedRule ? "selected_unavailable" : "missing",
        resolution.diagnostics.map(diagnostic => diagnostic.message).join("; ") || "Host service provider is unavailable");
    }
    // Prepare only the selected root and its declared dependencies, never every installed provider.
    await this.#ensureBuiltinArtifact(resolution.providerId);
    await this.supervisor.activateExtension(resolution.providerId);
    if (this.#stopped) throw new Error("Application extension runtime is stopped");
    const currentRouting = await this.routing.read();
    if (!currentRouting.authoritative || currentRouting.document.revision !== routing.document.revision) {
      throw new Error("Host service routing changed during preparation");
    }
    const provider = this.services.getSnapshot().providers.find(candidate => candidate.status === "active"
      && candidate.providerKey === resolution.providerKey);
    if (!provider) throw new HostServiceBindingError("selected_unavailable", "Selected Host service provider did not become ready");
    this.#publish();
    return this.services.bind(parsed.serviceId, parsed.version, provider.providerId);
  }

  setServiceSelection(requestValue: VarinExtensionServiceSelectionRequest | unknown): Promise<VarinExtensionHostStateSnapshot> {
    const request = parseVarinExtensionServiceSelectionRequest(requestValue);
    return this.#mutate(async () => {
      this.services.setSelection(request.serviceId, request.version, request.providerId);
      this.#publish();
      return this.state();
    });
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

  async #bindRegisteredService(
    request: VarinExtensionServiceInvocationRequest,
    defaultProviderKey?: string,
  ): Promise<HostServiceBinding> {
    const parsed = parseVarinExtensionServiceInvocationRequest(request);
    if (parsed.providerId) return this.services.bind(parsed.serviceId, parsed.version, parsed.providerId);
    const services = this.services.getSnapshot();
    const key = `${parsed.serviceId}@${parsed.version}`;
    const legacySelection = services.selections[key];
    if (legacySelection) return this.services.bind(parsed.serviceId, parsed.version, legacySelection);
    const candidates = services.providers.filter((provider) => (
      provider.status === "active"
      && provider.descriptor.id === parsed.serviceId
      && provider.descriptor.version === parsed.version
    ));
    const routing = await this.routing.read();
    if (!routing.authoritative) throw new Error("Cannot bind a Host service from stale routing state");
    const resolution = resolveVarinExtensionServiceRouting({
      candidates: candidates.map((provider) => ({
        providerId: provider.providerId,
        providerKey: provider.providerKey,
      })),
      document: routing.document,
      ...(defaultProviderKey ? { defaultProviderKey } : {}),
      serviceId: parsed.serviceId,
      version: parsed.version,
      ...(parsed.routing ? { context: parsed.routing } : {}),
    });
    if (resolution.status !== "resolved" || !resolution.providerId) {
      const detail = resolution.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
      throw new HostServiceBindingError(resolution.status === "ambiguous" ? "ambiguous"
        : resolution.matchedRule ? "selected_unavailable" : "missing",
        detail || `Host service provider is unavailable or ambiguous: ${key}`);
    }
    return this.services.bind(parsed.serviceId, parsed.version, resolution.providerId);
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
    for (const listener of this.#listeners) listener();
  }
}
