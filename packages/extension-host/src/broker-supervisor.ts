import { fork, type ChildProcess } from "node:child_process";
import {
  parseVarinExtensionServiceInvocationRequest,
  parseVarinExtensionStorageOpenRequest,
  type JsonObject,
  type JsonValue,
  type VarinExtensionActualState,
  type VarinExtensionCapabilityGrant,
  type VarinExtensionCatalogEntry,
  type VarinExtensionCatalogSnapshot,
  type VarinExtensionCandidatePreparationResult,
  type VarinExtensionManifest,
  type VarinExtensionServiceProvision,
  type VarinExtensionServiceInvocationRequest,
  type VarinExtensionServiceProviderSnapshot,
  type VarinExtensionServiceRequirement,
  type VarinExtensionStorageSnapshot,
  type VarinExtensionStorageAddress,
} from "@varin/extension-contract";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import type { HostCapabilityRegistry } from "./capability-registry.js";
import { ExtensionPackageManager } from "./package-manager.js";
import { NativeHostTransport } from "./native-host-transport.js";
import {
  HostServiceRegistry,
  type HostServiceOwnerIdentity,
  type HostServiceProvision,
} from "./service-registry.js";
import {
  ExtensionStorageStore,
  type ExtensionStorageMigrationTransaction,
} from "./storage-store.js";

interface BrokerRequestMessage {
  id: string;
  kind: "request";
  method: string;
  params?: unknown;
}

interface BrokerResponseMessage {
  error?: string;
  id: string;
  kind: "response";
  result?: unknown;
  success: boolean;
}

interface BrokerEventMessage {
  error?: string;
  event: string;
  kind: "event";
}

interface BrokerCancelMessage { kind: "cancel"; id: string; }

type BrokerMessage = BrokerRequestMessage | BrokerResponseMessage | BrokerEventMessage | BrokerCancelMessage;

export interface BrokeredHostTransport {
  forceTerminate(): void;
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  terminate(): Promise<void>;
}

export interface BrokeredHostTransportOptions {
  grants: VarinExtensionCapabilityGrant[];
  onCrash(error: Error): void;
  owner: HostServiceOwnerIdentity;
}

export type BrokeredHostTransportFactory = (
  options: BrokeredHostTransportOptions,
) => BrokeredHostTransport;

interface BrokeredHostInstance {
  epoch: number;
  preparation: AbortController;
  artifactIntegrity: string;
  broker: BrokeredHostTransport;
  desiredRevision: number;
  grants: VarinExtensionCapabilityGrant[];
  manifest: VarinExtensionManifest;
  owner: HostServiceOwnerIdentity;
  provisions: HostServiceProvision[];
  slot: "candidate" | "selected";
  storages: Map<string, BrokerStorageSession>;
}

interface BrokerStorageSession {
  address: VarinExtensionStorageAddress;
  phase: "activating" | "active" | "disposed" | "draining";
  schemaVersion: number;
  snapshot: VarinExtensionStorageSnapshot;
  transaction: ExtensionStorageMigrationTransaction | null;
}

interface BrokerActivationResult {
  provisions?: unknown;
}

export interface BrokeredHostSupervisorOptions {
  brokerScript: string;
  capabilities: HostCapabilityRegistry;
  catalog: ApplicationExtensionCatalog;
  onStateChange?: () => void;
  packages: ExtensionPackageManager;
  services: HostServiceRegistry;
  storage: ExtensionStorageStore;
  transportFactory?: BrokeredHostTransportFactory;
  invokeService?(request: VarinExtensionServiceInvocationRequest | unknown, signal?: AbortSignal): Promise<JsonValue>;
}

const serviceKey = (id: string, version: number): string => `${id}@${version}`;
const ownerStorageKey = (owner: HostServiceOwnerIdentity): string => `${owner.extensionId}\0${owner.entrypointId}\0${owner.generation}`;
const storageAddressKey = (address: Pick<VarinExtensionStorageAddress, "key" | "scope">): string => (
  `${address.scope}\0${address.key}`
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const asJsonValue = (value: unknown): JsonValue => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Broker RPC value is not JSON-safe");
  return JSON.parse(serialized) as JsonValue;
};

const diagnosticState = (
  hostId: string,
  desiredRevision: number,
  generation: number,
  status: VarinExtensionActualState["status"],
  code?: string,
  message?: string,
): VarinExtensionActualState => ({
  desiredRevision,
  diagnostics: code && message ? [{ code, message, severity: "error", timestamp: new Date().toISOString() }] : [],
  entrypointId: "host",
  generation,
  hostId,
  realmId: "application-host",
  realmKind: "host",
  status,
  updatedAt: new Date().toISOString(),
});

export class ChildBrokeredHostTransport implements BrokeredHostTransport {
  readonly #child: ChildProcess;
  readonly #childRequests = new Map<string, AbortController>();
  readonly #onCrash: (error: Error) => void;
  readonly #pending = new Map<string, { reject(error: Error): void; resolve(value: unknown): void }>();
  readonly #ready: Promise<void>;
  readonly #requestFromChild: (method: string, params: unknown, signal: AbortSignal) => Promise<JsonValue>;
  #intentional = false;
  #crashed = false;
  #requestId = 0;

  constructor(options: {
    brokerScript: string;
    forkProcess?: typeof fork;
    onCrash(error: Error): void;
    requestFromChild(method: string, params: unknown, signal: AbortSignal): Promise<JsonValue>;
  }) {
    this.#onCrash = options.onCrash;
    this.#requestFromChild = options.requestFromChild;
    this.#child = (options.forkProcess ?? fork)(options.brokerScript, [], {
      env: process.env,
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let rejectReadyRequest: (error: Error) => void = () => undefined;
    this.#ready = new Promise((resolveReady, rejectReady) => {
      rejectReadyRequest = rejectReady;
      const onMessage = (value: unknown) => {
        const message = value as BrokerMessage;
        if (message?.kind === "event" && message.event === "ready") {
          this.#child.off("error", rejectReady);
          resolveReady();
        }
      };
      this.#child.on("message", onMessage);
      this.#child.once("error", rejectReady);
    });
    this.#child.on("message", (value) => { void this.#onMessage(value as BrokerMessage); });
    this.#child.once("exit", (code, signal) => {
      const error = new Error(`Brokered Host process exited (${code ?? signal ?? "unknown"})`);
      rejectReadyRequest(error);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      for (const controller of this.#childRequests.values()) controller.abort(error);
      this.#childRequests.clear();
      if (!this.#intentional && !this.#crashed) { this.#crashed = true; this.#onCrash(error); }
    });
    this.#child.once("error", (error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        void this.#ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    } else await this.#ready;
    signal?.throwIfAborted();
    if (!this.#child.connected) throw new Error("Brokered Host process is disconnected");
    const id = `parent-${process.pid}-${++this.#requestId}`;
    return new Promise((resolveRequest, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const rejectRequest = (error: Error) => { cleanup(); reject(error); };
      // Cancellation requests cooperative stopping; retain pending ownership until the worker
      // settles or exits. Rejecting locally would incorrectly let lifecycle drain finish early.
      const send = (message: BrokerRequestMessage | BrokerCancelMessage) => {
        const failed = (error: Error | null) => {
          if (!error || message.kind === "cancel") return;
          this.#pending.delete(id);
          rejectRequest(error);
        };
        // A failed cancel delivery says nothing about whether the original handler stopped.
        // Preserve its pending ownership until the original response or actual process exit.
        try { this.#child.send(message, failed); }
        catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
      };
      const abort = () => {
        if (this.#child.connected) send({ kind: "cancel", id });
      };
      this.#pending.set(id, { reject: rejectRequest, resolve: (value) => { cleanup(); resolveRequest(value); } });
      signal?.addEventListener("abort", abort, { once: true });
      send({ kind: "request", id, method, params });
    });
  }

  async terminate(): Promise<void> {
    if (this.#intentional) return;
    this.#intentional = true;
    if (this.#child.connected) await this.request("deactivate").catch((error) => { this.#intentional = false; throw error; });
    if (this.#child.connected) this.#child.disconnect();
  }

  forceTerminate(): void {
    this.#intentional = true;
    for (const controller of this.#childRequests.values()) controller.abort("Brokered Host process force-terminated");
    this.#childRequests.clear();
    this.#child.kill();
  }

  async #onMessage(message: BrokerMessage): Promise<void> {
    if (!message || typeof message !== "object") return;
    if (message.kind === "response") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.success) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Brokered Host request failed"));
      return;
    }
    if (message.kind === "event") {
      if (message.event === "fatal" && !this.#intentional && !this.#crashed) {
        this.#crashed = true;
        this.#onCrash(new Error(message.error || "Brokered Host process failed"));
      }
      return;
    }
    if (message.kind === "cancel") {
      this.#childRequests.get(message.id)?.abort(new Error("Brokered Host call cancelled"));
      return;
    }
    const controller = new AbortController();
    this.#childRequests.set(message.id, controller);
    try {
      const result = await this.#requestFromChild(message.method, message.params, controller.signal);
      try {
        if (this.#child.connected) this.#child.send({ kind: "response", id: message.id, success: true, result } satisfies BrokerResponseMessage);
      } catch {
        // The child can exit after the connection check; its request is already cancelled by exit handling.
      }
    } catch (error) {
      try {
        if (this.#child.connected) this.#child.send({
          kind: "response",
          id: message.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies BrokerResponseMessage);
      } catch {
        // The failed child no longer has a response channel.
      }
    } finally {
      this.#childRequests.delete(message.id);
    }
  }
}

export class BrokeredHostSupervisor {
  readonly #active = new Map<string, BrokeredHostInstance>();
  readonly #brokerScript: string;
  readonly #capabilities: HostCapabilityRegistry;
  readonly #catalog: ApplicationExtensionCatalog;
  readonly #generations = new Map<string, number>();
  readonly #packages: ExtensionPackageManager;
  readonly #onStateChange: () => void;
  readonly #services: HostServiceRegistry;
  readonly #invokeService: (request: VarinExtensionServiceInvocationRequest | unknown, signal?: AbortSignal) => Promise<JsonValue>;
  readonly #staged = new Map<string, BrokeredHostInstance>();
  readonly #nativeRestartRequired = new Set<string>();
  readonly #storage: ExtensionStorageStore;
  readonly #storageSessions = new Map<string, Map<string, BrokerStorageSession>>();
  readonly #transportFactory: BrokeredHostTransportFactory;
  readonly #operations = new Map<string, Promise<void>>();
  readonly #selectedPreparations = new Map<string, { identity: string; promise: Promise<void> }>();
  readonly #candidatePreparations = new Map<string, { identity: string; promise: Promise<VarinExtensionCandidatePreparationResult> }>();
  readonly #preparations = new Map<string, AbortController>();
  readonly #preparationTargets = new Map<string, { integrity: string; slot: "candidate" | "selected"; desiredRevision: number }>();
  readonly #epochs = new Map<string, number>();
  #stopping = false;
  #shutdown: Promise<void> | undefined;

  constructor(options: BrokeredHostSupervisorOptions) {
    this.#brokerScript = options.brokerScript;
    this.#capabilities = options.capabilities;
    this.#catalog = options.catalog;
    this.#packages = options.packages;
    this.#onStateChange = options.onStateChange ?? (() => undefined);
    this.#services = options.services;
    this.#invokeService = options.invokeService ?? ((request, signal) => this.#services.invoke(request, signal));
    this.#storage = options.storage;
    this.#transportFactory = options.transportFactory ?? ((transportOptions) => new ChildBrokeredHostTransport({
      brokerScript: this.#brokerScript,
      onCrash: transportOptions.onCrash,
      requestFromChild: (method, params, signal) => this.#handleChildRequest(transportOptions.owner, transportOptions.grants, method, params, signal),
    }));
  }

  reconcile(_snapshot?: VarinExtensionCatalogSnapshot): Promise<void> {
    // Callers may have spent time preparing or deleting data after obtaining their snapshot.
    // Re-read the authority rather than retract a newer owner from that stale observation.
    return this.#reconcileSnapshot();
  }

  prepareCandidate(extensionId: string, integrity: string): Promise<VarinExtensionCandidatePreparationResult> {
    return this.#prepareCandidate(extensionId, integrity);
  }

  selectCandidate(extensionId: string, integrity: string, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot> {
    return this.#prepareCandidate(extensionId, integrity).then(() =>
      this.#enqueue(extensionId, () => this.#selectCandidate(extensionId, integrity, expectedRevision)));
  }

  discardPreparedCandidate(extensionId: string, integrity: string): Promise<void> {
    const preparing = this.#preparationTargets.get(extensionId);
    if (preparing?.slot === "candidate" && preparing.integrity === integrity) this.#invalidate(extensionId);
    return this.#enqueue(extensionId, async () => {
      const staged = this.#staged.get(extensionId);
      if (!staged || staged.artifactIntegrity !== integrity) return;
      this.#staged.delete(extensionId);
      await this.#disposeInstance(staged, false);
    });
  }

  forceTerminate(extensionId: string): void {
    this.#invalidate(extensionId);
    this.#active.get(extensionId)?.broker.forceTerminate();
    this.#staged.get(extensionId)?.broker.forceTerminate();
  }

  activeExtensions(): string[] {
    return [...this.#active.keys()].sort();
  }

  async activateExtension(extensionId: string): Promise<void> {
    this.#assertRunning();
    const snapshot = await this.#catalog.snapshot();
    const entry = snapshot.extensions.find((value) => value.manifest.id === extensionId);
    if (!entry?.desired.enabled || !entry.manifest.entrypoints?.host) return;
    await this.#ensureSelectedActive(entry, snapshot, []);
  }

  async deactivateExtension(extensionId: string, afterDeactivate?: () => Promise<void>): Promise<void> {
    const snapshot = await this.#catalog.snapshot();
    await this.#deactivateWithDependents(extensionId, snapshot, new Set(), afterDeactivate);
  }

  async activateForService(requestValue: VarinExtensionServiceInvocationRequest | unknown): Promise<void> {
    this.#assertRunning();
    const request = parseVarinExtensionServiceInvocationRequest(requestValue);
    const snapshot = await this.#catalog.snapshot();
    const providers = snapshot.extensions.filter((entry) => (
      entry.desired.enabled
      && Boolean(entry.manifest.entrypoints?.host)
      && (entry.manifest.provides?.services ?? []).some((service) => (
        service.id === request.serviceId && service.version === request.version
      ))
    ));
    await Promise.all(providers.map((provider) => this.#ensureSelectedActive(provider, snapshot, [])));
  }

  hasStagedProvider(providerId: string): boolean {
    return [...this.#staged.values()].some((instance) => instance.provisions.some((provision) => (
      this.#providerId(instance.owner, provision.descriptor) === providerId
    )));
  }

  invokeStagedService(
    requestValue: VarinExtensionServiceInvocationRequest | unknown,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const request = parseVarinExtensionServiceInvocationRequest(requestValue);
    if (!request.providerId) throw new Error("Candidate Host service invocation requires providerId");
    for (const instance of this.#staged.values()) {
      const provision = instance.provisions.find((value) => (
        value.descriptor.id === request.serviceId
        && value.descriptor.version === request.version
        && this.#providerId(instance.owner, value.descriptor) === request.providerId
      ));
      if (provision) return Promise.resolve(provision.handler(request.method, request.args, { signal: signal ?? new AbortController().signal }));
    }
    throw new Error(`Candidate Host service provider is unavailable: ${request.providerId}`);
  }

  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#stopping = true;
    for (const [id, controller] of this.#preparations) {
      this.#invalidate(id);
      controller.abort(new Error("Host supervisor is shutting down"));
    }
    this.#shutdown = (async () => {
      await Promise.all([...this.#operations.values()]);
      const snapshot = await this.#catalog.snapshot();
      await Promise.all([...new Set([...this.#active.keys(), ...this.#staged.keys()])]
        .map((id) => this.#deactivateWithDependents(id, snapshot)));
    })();
    return this.#shutdown;
  }

  #assertRunning(): void {
    if (this.#stopping) throw new Error("Host supervisor is shutting down");
  }

  #invalidate(extensionId: string): void {
    this.#epochs.set(extensionId, (this.#epochs.get(extensionId) ?? 0) + 1);
    this.#preparations.get(extensionId)?.abort(new Error(`Host activation was cancelled: ${extensionId}`));
  }

  // Only a single owner's preparation, storage transaction and retirement are serialized.
  // Dependencies are resolved before entering this queue, so waiters share their provider's
  // completed generation without holding an owner lock while traversing the graph.
  #enqueue<T>(extensionId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#operations.get(extensionId) ?? Promise.resolve()).then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#operations.set(extensionId, settled);
    void settled.then(() => {
      if (this.#operations.get(extensionId) === settled) this.#operations.delete(extensionId);
    });
    return result;
  }

  async #reconcileSnapshot(): Promise<void> {
    this.#assertRunning();
    await this.#reconcile(await this.#catalog.snapshot());
  }

  async #assertCurrent(instance: BrokeredHostInstance): Promise<void> {
    this.#assertRunning();
    const snapshot = await this.#catalog.snapshot();
    this.#assertRunning();
    if ((this.#epochs.get(instance.owner.extensionId) ?? 0) !== instance.epoch) {
      throw new Error(`Host activation was cancelled: ${instance.owner.extensionId}`);
    }
    const entry = snapshot.extensions.find((value) => value.manifest.id === instance.owner.extensionId);
    const integrity = instance.slot === "candidate" ? entry?.candidate?.integrity : entry?.integrity;
    if (!entry?.desired.enabled || entry.desired.revision !== instance.desiredRevision
      || integrity !== instance.artifactIntegrity) throw new Error(`Host activation is stale: ${instance.owner.extensionId}`);
    this.#assertDependencies(instance.manifest);
  }

  #assertDependencies(manifest: VarinExtensionManifest): void {
    for (const requirement of manifest.requires?.services ?? []) {
      if (!requirement.optional && this.#services.providersFor(requirement).length === 0) {
        throw new Error(`Required Host service is unavailable: ${serviceKey(requirement.id, requirement.version)}`);
      }
    }
  }

  async #prepareCandidate(extensionId: string, integrity: string): Promise<VarinExtensionCandidatePreparationResult> {
    this.#assertRunning();
    const snapshot = await this.#catalog.snapshot();
    const entry = snapshot.extensions.find((candidate) => candidate.manifest.id === extensionId);
    if (!entry?.candidate || entry.candidate.integrity !== integrity) throw new Error(`Host candidate is no longer current: ${extensionId}`);
    const preparing = this.#preparationTargets.get(extensionId);
    if (preparing?.slot === "candidate" && preparing.integrity !== integrity) this.#invalidate(extensionId);
    const epoch = this.#epochs.get(extensionId) ?? 0;
    if (!entry.candidate.capabilitiesReviewed) throw new Error(`Host candidate capability changes require review: ${extensionId}`);
    if (entry.candidate.manifest.entrypoints?.host?.mode === "native") {
      if (this.#active.has(extensionId)) {
        this.#nativeRestartRequired.add(extensionId);
        await this.#reportActual(extensionId, diagnosticState(
          snapshot.hostId,
          entry.desired.revision,
          this.#active.get(extensionId)?.owner.generation ?? 0,
          "restart-required",
          "trusted_native_update_requires_restart",
          "The trusted-native Host candidate will activate after the application host restarts",
        )).catch(() => undefined);
        throw new Error("Trusted-native Host candidate requires an application-host restart");
      }
      return { extensionId, integrity, providers: [] };
    }
    if (entry.candidate.manifest.entrypoints?.host?.mode !== "brokered") return { extensionId, integrity, providers: [] };
    for (const requirement of entry.candidate.manifest.requires?.services ?? []) {
      if (requirement.optional || this.#services.providersFor(requirement).length > 0) continue;
      for (const provider of this.#providerEntries(requirement, snapshot)) {
        await this.#ensureSelectedActive(provider, snapshot, [extensionId]);
      }
      if (this.#services.providersFor(requirement).length === 0) {
        throw new Error(`Required Host service is unavailable: ${serviceKey(requirement.id, requirement.version)}`);
      }
    }
    const candidate = entry.candidate;
    const identity = `${integrity}:${entry.desired.revision}:${epoch}`;
    const pending = this.#candidatePreparations.get(extensionId);
    if (pending?.identity === identity) return pending.promise;
    const promise = this.#enqueue(extensionId, async () => {
      this.#assertRunning();
      if ((this.#epochs.get(extensionId) ?? 0) !== epoch) throw new Error("Host activation was cancelled");
      const current = this.#staged.get(extensionId);
      if (current?.artifactIntegrity === integrity && current.desiredRevision === entry.desired.revision && current.epoch === epoch) {
        await this.#assertCurrent(current);
        return this.#candidatePreparation(current);
      }
      if (current) {
        this.#staged.delete(extensionId);
        await this.#disposeInstance(current, false);
      }
      const instance = await this.#prepareInstance(entry, {
        capabilityGrants: candidate.capabilityGrants,
        integrity,
        manifest: candidate.manifest,
        slot: "candidate",
        version: candidate.resolvedVersion,
      }, snapshot);
      try {
        await this.#assertCurrent(instance);
        this.#staged.set(extensionId, instance);
        return this.#candidatePreparation(instance);
      } catch (error) {
        await this.#disposeInstance(instance, false);
        throw error;
      }
    });
    this.#candidatePreparations.set(extensionId, { identity, promise });
    try { return await promise; }
    finally {
      if (this.#candidatePreparations.get(extensionId)?.promise === promise) this.#candidatePreparations.delete(extensionId);
    }
  }

  async #selectCandidate(
    extensionId: string,
    integrity: string,
    expectedRevision: number,
  ): Promise<VarinExtensionCatalogSnapshot> {
    const staged = this.#staged.get(extensionId);
    this.#assertRunning();
    if (!staged) return this.#packages.selectCandidate({ candidateIntegrity: integrity, expectedRevision, extensionId });
    if (staged.artifactIntegrity !== integrity) throw new Error(`Prepared Host candidate is stale: ${extensionId}`);
    const previous = this.#active.get(extensionId);
    const replacement = this.#services.prepareOwnerReplacement(staged.owner, staged.provisions);
    let storageCommitted = false;
    let selected: VarinExtensionCatalogSnapshot;
    if (previous) this.#setStoragePhase(previous, "draining");
    try {
      await this.#assertCurrent(staged);
      await this.#commitInstanceStorage(staged);
      storageCommitted = true;
      await this.#assertCurrent(staged);
      selected = await this.#packages.selectCandidate({ candidateIntegrity: integrity, expectedRevision, extensionId });
      // Durable selection may finish after shutdown or an explicit disable cancelled this owner.
      // The committed catalog can recover that artifact next startup; never publish a killed worker.
      this.#assertRunning();
      if ((this.#epochs.get(extensionId) ?? 0) !== staged.epoch || staged.preparation.signal.aborted) {
        throw new Error(`Host candidate publication was cancelled: ${extensionId}`);
      }
      this.#assertDependencies(staged.manifest);
    } catch (error) {
      await replacement.rollback();
      if (storageCommitted) await this.#rollbackInstanceStorage(staged);
      this.#setStoragePhase(staged, "activating");
      if (previous) this.#setStoragePhase(previous, "active");
      throw error;
    }
    replacement.commit();
    this.#finalizeInstanceStorage(staged);
    this.#active.set(extensionId, { ...staged, slot: "selected" });
    this.#staged.delete(extensionId);
    await this.#reportActual(extensionId, diagnosticState(
      selected.hostId,
      staged.desiredRevision,
      staged.owner.generation,
      "active",
    )).catch(() => undefined);
    await replacement.finalize();
    if (previous) await this.#disposeInstance(previous, false);
    return selected;
  }

  async #reconcile(snapshot: VarinExtensionCatalogSnapshot): Promise<void> {
    if (!snapshot.authoritative) return;
    const enabled = new Map(snapshot.extensions.filter((entry) => entry.desired.enabled).map((entry) => [entry.manifest.id, entry]));
    for (const [extensionId, target] of this.#preparationTargets) {
      const entry = enabled.get(extensionId);
      const integrity = target.slot === "candidate" ? entry?.candidate?.integrity : entry?.integrity;
      if (!entry || integrity !== target.integrity || entry.desired.revision !== target.desiredRevision) {
        this.#invalidate(extensionId);
      }
    }
    const owners = new Set([...this.#active.keys(), ...this.#staged.keys(), ...this.#preparations.keys(),
      ...this.#selectedPreparations.keys(), ...this.#candidatePreparations.keys()]);
    const deactivations = [...owners].filter((extensionId) => {
      const entry = enabled.get(extensionId);
      return !entry || !entry.manifest.entrypoints?.host;
    }).map((extensionId) => this.#deactivateWithDependents(extensionId, snapshot));
    await Promise.all([...deactivations, ...[...enabled.values()].map(async (entry) => {
      if (entry.candidate?.applyRequested
        && entry.candidate.manifest.entrypoints?.host
        && (entry.candidate.manifest.entrypoints?.surfaces ?? []).length === 0
        && !this.#active.has(entry.manifest.id)) {
        try {
          const current = await this.#catalog.snapshot();
          const candidate = current.extensions.find((value) => value.manifest.id === entry.manifest.id)?.candidate;
          if (!candidate?.applyRequested || candidate.integrity !== entry.candidate.integrity) return;
          const selected = candidate.manifest.entrypoints?.host?.mode === "native"
            ? await this.#packages.selectCandidate({
              candidateIntegrity: candidate.integrity,
              expectedRevision: current.revision,
              extensionId: entry.manifest.id,
            })
            : await this.selectCandidate(entry.manifest.id, candidate.integrity, current.revision);
          const selectedEntry = selected.extensions.find((value) => value.manifest.id === entry.manifest.id);
          if (selectedEntry) await this.#ensureSelectedActive(selectedEntry, selected, []);
        } catch (error) {
          await this.#reportActual(entry.manifest.id, diagnosticState(
            snapshot.hostId,
            entry.desired.revision,
            0,
            "failed",
            "requested_candidate_activation_failed",
            error instanceof Error ? error.message : String(error),
          )).catch(() => undefined);
        }
        return;
      }
      if (!entry.manifest.entrypoints?.host) return;
      const activation = entry.manifest.entrypoints.host.activation ?? [];
      const startsWithApplication = activation.length === 0
        || activation.includes("application-startup")
        || activation.includes("background");
      if (!startsWithApplication && !this.#active.has(entry.manifest.id)) {
        const reported = entry.actual.find((state) => state.realmKind === "host" && state.entrypointId === "host");
        if (!reported || reported.status !== "inactive") {
          await this.#reportActual(entry.manifest.id, diagnosticState(
            snapshot.hostId,
            entry.desired.revision,
            reported?.generation ?? 0,
            "inactive",
          )).catch(() => undefined);
        }
        return;
      }
      try {
        await this.#ensureSelectedActive(entry, snapshot, []);
      } catch (error) {
        const native = entry.manifest.entrypoints.host.mode === "native";
        if (native) this.#nativeRestartRequired.add(entry.manifest.id);
        await this.#reportActual(entry.manifest.id, diagnosticState(
          snapshot.hostId,
          entry.desired.revision,
          this.#active.get(entry.manifest.id)?.owner.generation ?? 0,
          native ? "restart-required" : this.#active.has(entry.manifest.id) ? "active" : "failed",
          native ? "trusted_native_host_activation_failed" : "brokered_host_activation_failed",
          error instanceof Error ? error.message : String(error),
        )).catch(() => undefined);
        return;
      }
    })]);
  }

  async #ensureSelectedActive(
    entry: VarinExtensionCatalogEntry,
    snapshot: VarinExtensionCatalogSnapshot,
    stack: string[],
  ): Promise<void> {
    this.#assertRunning();
    const epoch = this.#epochs.get(entry.manifest.id) ?? 0;
    if (stack.includes(entry.manifest.id)) {
      throw new Error(`Host service dependency cycle: ${[...stack, entry.manifest.id].join(" -> ")}`);
    }
    const nextStack = [...stack, entry.manifest.id];
    for (const requirement of entry.manifest.requires?.services ?? []) {
      if (requirement.optional || this.#services.providersFor(requirement).length > 0) continue;
      const providers = this.#providerEntries(requirement, snapshot);
      for (const provider of providers) {
        await this.#ensureSelectedActive(provider, snapshot, nextStack).catch((error: unknown) => {
          if (error instanceof Error && error.message.startsWith("Host service dependency cycle:")) throw error;
        });
      }
      if (this.#services.providersFor(requirement).length === 0) {
        await this.#reportActual(entry.manifest.id, diagnosticState(
          snapshot.hostId,
          entry.desired.revision,
          this.#active.get(entry.manifest.id)?.owner.generation ?? 0,
          "waiting",
          "required_host_service_unavailable",
          `Required Host service is unavailable: ${serviceKey(requirement.id, requirement.version)}`,
        ));
        return;
      }
    }
    const identity = `${entry.integrity}:${entry.desired.revision}:${epoch}`;
    const pending = this.#selectedPreparations.get(entry.manifest.id);
    if (pending?.identity === identity) return pending.promise;
    const promise = this.#enqueue(entry.manifest.id, async () => {
      this.#assertRunning();
      if ((this.#epochs.get(entry.manifest.id) ?? 0) !== epoch) throw new Error("Host activation was cancelled");
      const active = this.#active.get(entry.manifest.id);
      if (active && active.artifactIntegrity === entry.integrity && active.desiredRevision === entry.desired.revision) return;
      const native = entry.manifest.entrypoints?.host?.mode === "native";
      if (native && active && active.artifactIntegrity === entry.integrity) {
        active.desiredRevision = entry.desired.revision;
        await this.#reportActual(entry.manifest.id, diagnosticState(
          snapshot.hostId,
          entry.desired.revision,
          active.owner.generation,
          "active",
        )).catch(() => undefined);
        return;
      }
      if (native && (this.#nativeRestartRequired.has(entry.manifest.id) || (active && active.artifactIntegrity !== entry.integrity))) {
        this.#nativeRestartRequired.add(entry.manifest.id);
        await this.#reportActual(entry.manifest.id, diagnosticState(
          snapshot.hostId,
          entry.desired.revision,
          active?.owner.generation ?? 0,
          "restart-required",
          "trusted_native_restart_required",
          "The trusted-native Host generation can change only after the application host restarts",
        )).catch(() => undefined);
        return;
      }
      if (!entry.integrity) throw new Error(`Host extension has no selected artifact: ${entry.manifest.id}`);
      const candidate = await this.#prepareInstance(entry, {
        capabilityGrants: entry.capabilityGrants,
        integrity: entry.integrity,
        manifest: entry.manifest,
        slot: "selected",
        version: entry.selectedVersion,
      }, snapshot);
      let replacement: ReturnType<HostServiceRegistry["prepareOwnerReplacement"]> | undefined;
      let storageCommitted = false;
      if (active) this.#setStoragePhase(active, "draining");
      try {
        await this.#assertCurrent(candidate);
        replacement = this.#services.prepareOwnerReplacement(candidate.owner, candidate.provisions);
        await this.#commitInstanceStorage(candidate);
        storageCommitted = true;
        await this.#assertCurrent(candidate);
        replacement.commit();
        this.#finalizeInstanceStorage(candidate);
        this.#active.set(entry.manifest.id, candidate);
        await this.#reportActual(entry.manifest.id, diagnosticState(
          snapshot.hostId,
          entry.desired.revision,
          candidate.owner.generation,
          "active",
        )).catch(() => undefined);
        await replacement.finalize();
        if (active) await this.#disposeInstance(active, false);
      } catch (error) {
        await replacement?.rollback().catch(() => undefined);
        if (storageCommitted) await this.#rollbackInstanceStorage(candidate);
        await this.#disposeInstance(candidate, false);
        if (active) {
          this.#setStoragePhase(active, "active");
          this.#active.set(entry.manifest.id, active);
          await this.#reportActual(entry.manifest.id, diagnosticState(
            snapshot.hostId,
            active.desiredRevision,
            active.owner.generation,
            "active",
            "host_candidate_activation_failed",
            error instanceof Error ? error.message : String(error),
          ));
          return;
        }
        this.#active.delete(entry.manifest.id);
        throw error;
      }
    });
    this.#selectedPreparations.set(entry.manifest.id, { identity, promise });
    try { await promise; }
    finally {
      if (this.#selectedPreparations.get(entry.manifest.id)?.promise === promise) this.#selectedPreparations.delete(entry.manifest.id);
    }
  }

  #providerEntries(requirement: VarinExtensionServiceRequirement, snapshot: VarinExtensionCatalogSnapshot): VarinExtensionCatalogEntry[] {
    const providers = snapshot.extensions.filter((entry) => (
      entry.desired.enabled
      && Boolean(entry.manifest.entrypoints?.host)
      && (entry.manifest.provides?.services ?? []).some((service) => service.id === requirement.id && service.version === requirement.version)
    ));
    if (requirement.binding === "all") return providers;
    if (requirement.binding === "selected") return [];
    return providers.length === 1 ? providers : [];
  }

  async #prepareInstance(
    entry: VarinExtensionCatalogEntry,
    selection: {
      capabilityGrants: VarinExtensionCatalogEntry["capabilityGrants"];
      integrity: string;
      manifest: VarinExtensionManifest;
      slot: "candidate" | "selected";
      version: string;
    },
    snapshot: VarinExtensionCatalogSnapshot,
  ): Promise<BrokeredHostInstance> {
    this.#assertRunning();
    const epoch = this.#epochs.get(entry.manifest.id) ?? 0;
    const controller = new AbortController();
    let prepared = false;
    this.#preparations.set(entry.manifest.id, controller);
    this.#preparationTargets.set(entry.manifest.id, { integrity: selection.integrity, slot: selection.slot, desiredRevision: entry.desired.revision });
    try {
      const artifact = await this.#packages.resolveBrokeredHostEntrypoint(entry.manifest.id, selection.slot, selection.integrity);
      controller.signal.throwIfAborted();
      this.#assertRunning();
      const generation = (this.#generations.get(entry.manifest.id) ?? 0) + 1;
      this.#generations.set(entry.manifest.id, generation);
      const owner: HostServiceOwnerIdentity = {
        entrypointId: "host",
        extensionId: entry.manifest.id,
        extensionVersion: selection.version,
        generation,
      };
      const grants = selection.capabilityGrants.filter((grant) => grant.realm === "host" && grant.manifestVersion === selection.version);
      let crashed: Error | null = null;
      const requestFromExtension = (method: string, params: unknown, signal: AbortSignal) => (
        this.#handleChildRequest(owner, grants, method, params, signal)
      );
      const broker = selection.manifest.entrypoints?.host?.mode === "native"
        ? new NativeHostTransport({ requestFromExtension })
        : this.#transportFactory({
          grants,
          owner,
          onCrash: (error) => {
            crashed = error;
            void this.#handleCrash(entry.manifest.id, owner, error, snapshot.hostId, entry.desired.revision);
          },
        });
      const cancelPreparation = () => broker.forceTerminate();
      controller.signal.addEventListener("abort", cancelPreparation, { once: true });
      if (controller.signal.aborted) cancelPreparation();
      try {
        const address = { extensionId: entry.manifest.id, key: "state", scope: "application" as const };
        let storageSnapshot = await this.#storage.read(address);
        const targetSchemaVersion = selection.manifest.storage?.schemaVersion ?? storageSnapshot.document.schemaVersion;
        const storageSession: BrokerStorageSession = {
          address,
          phase: "activating",
          schemaVersion: targetSchemaVersion,
          snapshot: storageSnapshot,
          transaction: null,
        };
        const storages = new Map([[storageAddressKey(address), storageSession]]);
        this.#storageSessions.set(ownerStorageKey(owner), storages);
        storageSession.transaction = await this.#storage.prepareMigration(address, targetSchemaVersion, async (input) => {
          const migrated = await broker.request("migrate", { input, modulePath: artifact.modulePath }, controller.signal);
          if (!isRecord(migrated)) throw new Error("Host migration must return a JSON object");
          return migrated as JsonObject;
        });
        if (storageSession.transaction) {
          storageSnapshot = {
            ...storageSession.transaction.previous,
            document: {
              ...storageSession.transaction.previous.document,
              data: structuredClone(storageSession.transaction.targetData),
              schemaVersion: storageSession.transaction.targetSchemaVersion,
            },
          };
        }
        storageSession.snapshot = storageSnapshot;
        const activation = await broker.request("activate", {
          modulePath: artifact.modulePath,
          packageRoot: artifact.packageRoot,
          storage: storageSnapshot,
        }, controller.signal) as BrokerActivationResult;
        controller.signal.throwIfAborted();
        if ((this.#epochs.get(entry.manifest.id) ?? 0) !== epoch) throw new Error("Host activation was superseded");
        if (crashed) throw crashed;
        const provisions = this.#provisions(owner, broker, activation.provisions, selection.manifest);
        prepared = true;
        return {
          preparation: controller,
          epoch,
          artifactIntegrity: selection.integrity,
          broker,
          desiredRevision: entry.desired.revision,
          grants,
          manifest: selection.manifest,
          owner,
          provisions,
          slot: selection.slot,
          storages,
        };
      } catch (error) {
        for (const session of this.#storageSessions.get(ownerStorageKey(owner))?.values() ?? []) session.phase = "disposed";
        this.#storageSessions.delete(ownerStorageKey(owner));
        broker.forceTerminate();
        if (selection.manifest.entrypoints?.host?.mode === "native") this.#nativeRestartRequired.add(entry.manifest.id);
        throw error;
      }
    } finally {
      if (!prepared && this.#preparations.get(entry.manifest.id) === controller) {
        this.#preparations.delete(entry.manifest.id);
        this.#preparationTargets.delete(entry.manifest.id);
      }
    }
  }

  #provisions(
    owner: HostServiceOwnerIdentity,
    broker: BrokeredHostTransport,
    raw: unknown,
    manifest: VarinExtensionManifest,
  ): HostServiceProvision[] {
    const values = Array.isArray(raw) ? raw : [];
    const declared = new Map((manifest.provides?.services ?? []).map((service) => [serviceKey(service.id, service.version), service]));
    return values.map((value) => {
      if (!isRecord(value) || typeof value.id !== "string" || !Number.isSafeInteger(value.version)) {
        throw new Error("Host service provision is invalid");
      }
      const key = serviceKey(value.id, Number(value.version));
      const descriptor = declared.get(key);
      if (!descriptor) throw new Error(`Host provided undeclared service: ${key}`);
      return {
        descriptor: { ...descriptor },
        handler: (method, args, context) => broker.request("service.invoke", {
          args,
          method,
          serviceId: descriptor.id,
          version: descriptor.version,
        }, context.signal).then(asJsonValue),
      };
    });
  }

  #providerId(owner: HostServiceOwnerIdentity, descriptor: VarinExtensionServiceProvision): string {
    return `${owner.extensionId}:${owner.entrypointId}:${owner.generation}:${serviceKey(descriptor.id, descriptor.version)}`;
  }

  #providerKey(owner: HostServiceOwnerIdentity, descriptor: VarinExtensionServiceProvision): string {
    return `${owner.extensionId}:${owner.entrypointId}:${serviceKey(descriptor.id, descriptor.version)}`;
  }

  #candidatePreparation(instance: BrokeredHostInstance): VarinExtensionCandidatePreparationResult {
    const providers = instance.provisions.map<VarinExtensionServiceProviderSnapshot>((provision) => ({
      descriptor: { ...provision.descriptor },
      entrypointId: instance.owner.entrypointId,
      extensionId: instance.owner.extensionId,
      extensionVersion: instance.owner.extensionVersion,
      generation: instance.owner.generation,
      providerId: this.#providerId(instance.owner, provision.descriptor),
      providerKey: this.#providerKey(instance.owner, provision.descriptor),
      status: "candidate",
    }));
    return {
      extensionId: instance.owner.extensionId,
      integrity: instance.artifactIntegrity,
      providers,
    };
  }

  async #deactivateWithDependents(
    extensionId: string,
    snapshot: VarinExtensionCatalogSnapshot,
    visited = new Set<string>(),
    afterDeactivate?: () => Promise<void>,
  ): Promise<void> {
    if (visited.has(extensionId)) return;
    visited.add(extensionId);
    this.#invalidate(extensionId);
    const manifest = this.#active.get(extensionId)?.manifest
      ?? snapshot.extensions.find((entry) => entry.manifest.id === extensionId)?.manifest;
    const provided = new Set((manifest?.provides?.services ?? []).map((service) => serviceKey(service.id, service.version)));
    for (const entry of snapshot.extensions) {
      const dependentId = entry.manifest.id;
      if (dependentId === extensionId) continue;
      const dependent = this.#active.get(dependentId)?.manifest ?? entry.manifest;
      const requiresProvider = (dependent.requires?.services ?? []).some((requirement) => (
        !requirement.optional && provided.has(serviceKey(requirement.id, requirement.version))
      ));
      if (requiresProvider) await this.#deactivateWithDependents(dependentId, snapshot, visited);
    }
    return this.#enqueue(extensionId, async () => {
      await this.#deactivateOwner(extensionId, snapshot);
      await afterDeactivate?.();
    });
  }

  async #deactivateOwner(extensionId: string, snapshot: VarinExtensionCatalogSnapshot): Promise<void> {
    const staged = this.#staged.get(extensionId);
    if (staged) {
      this.#staged.delete(extensionId);
      await this.#disposeInstance(staged, false);
    }
    const instance = this.#active.get(extensionId);
    if (!instance) return;
    await this.#services.drainOwner(instance.owner);
    this.#active.delete(extensionId);
    this.#services.removeOwner(instance.owner);
    const entry = snapshot.extensions.find((candidate) => candidate.manifest.id === extensionId);
    try {
      await this.#disposeInstance(instance, true);
    } catch (error) {
      if (instance.manifest.entrypoints?.host?.mode !== "native") throw error;
      this.#nativeRestartRequired.add(extensionId);
      if (entry) await this.#reportActual(extensionId, diagnosticState(
        snapshot.hostId,
        entry.desired.revision,
        instance.owner.generation + 1,
        "restart-required",
        "trusted_native_cleanup_failed",
        error instanceof Error ? error.message : String(error),
      )).catch(() => undefined);
      return;
    }
    if (entry) await this.#reportActual(extensionId, diagnosticState(
      snapshot.hostId,
      entry.desired.revision,
      instance.owner.generation + 1,
      "inactive",
    ));
  }

  async #disposeInstance(instance: BrokeredHostInstance, terminate: boolean): Promise<void> {
    if (this.#preparations.get(instance.owner.extensionId) === instance.preparation) {
      this.#preparations.delete(instance.owner.extensionId);
      this.#preparationTargets.delete(instance.owner.extensionId);
    }
    this.#setStoragePhase(instance, "disposed");
    this.#storageSessions.delete(ownerStorageKey(instance.owner));
    if (terminate) await instance.broker.terminate();
    else await instance.broker.terminate().catch(() => instance.broker.forceTerminate());
  }

  #handleCrash(
    extensionId: string,
    owner: HostServiceOwnerIdentity,
    error: Error,
    hostId: string,
    desiredRevision: number,
  ): void {
    void this.#enqueue(extensionId, async () => {
      await this.#handleCrashNow(extensionId, owner, error, hostId, desiredRevision);
    }).catch(() => undefined);
  }

  async #handleCrashNow(
    extensionId: string,
    owner: HostServiceOwnerIdentity,
    error: Error,
    hostId: string,
    desiredRevision: number,
  ): Promise<void> {
    const active = this.#active.get(extensionId);
    if (!active || active.owner.generation !== owner.generation) return;
    await this.#services.drainOwner(owner);
    const snapshot = await this.#catalog.snapshot();
    const provided = new Set(active.provisions.map((provision) => serviceKey(provision.descriptor.id, provision.descriptor.version)));
    for (const [dependentId, dependent] of [...this.#active]) {
      if (dependentId === extensionId) continue;
      const requiresProvider = (dependent.manifest.requires?.services ?? []).some((requirement) => (
        !requirement.optional && provided.has(serviceKey(requirement.id, requirement.version))
      ));
      if (requiresProvider) await this.#deactivateWithDependents(dependentId, snapshot, new Set([extensionId]));
    }
    this.#services.removeOwner(owner);
    this.#active.delete(extensionId);
    this.#setStoragePhase(active, "disposed");
    this.#storageSessions.delete(ownerStorageKey(owner));
    await this.#reportActual(extensionId, diagnosticState(
      hostId,
      desiredRevision,
      owner.generation,
      "failed",
      "brokered_host_crashed",
      error.message,
    )).catch(() => undefined);
  }

  async #handleChildRequest(
    owner: HostServiceOwnerIdentity,
    grants: VarinExtensionCapabilityGrant[],
    method: string,
    paramsValue: unknown,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const params = isRecord(paramsValue) ? paramsValue : {};
    if (method === "capability.call") {
      return this.#capabilities.invoke(
        owner,
        grants,
        String(params.capability ?? ""),
        String(params.method ?? ""),
        asJsonValue(params.params ?? null),
        signal,
      );
    }
    if (method === "storage.open") {
      const request = parseVarinExtensionStorageOpenRequest(params);
      const session = await this.#openStorageSession(owner, request);
      return asJsonValue(session.snapshot);
    }
    if (method === "storage.refresh") {
      const request = parseVarinExtensionStorageOpenRequest(params);
      const session = await this.#openStorageSession(owner, request);
      if (session.phase !== "active") return asJsonValue(session.snapshot);
      session.snapshot = await this.#storage.read(session.address);
      return asJsonValue(session.snapshot);
    }
    if (method === "storage.update") {
      if (params.extensionId !== undefined) throw new Error("Extension storage namespace is assigned by the Varin Host");
      const request = params.scope === undefined && params.key === undefined
        ? { key: "state", scope: "application" as const }
        : parseVarinExtensionStorageOpenRequest({ key: params.key, scope: params.scope });
      const session = await this.#openStorageSession(owner, request);
      if (session.phase === "disposed" || session.phase === "draining") {
        throw new Error("Brokered Host storage owner is inactive");
      }
      const expectedRevision = Number(params.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Extension storage expectedRevision is invalid");
      if (expectedRevision !== session.snapshot.document.revision) {
        throw new Error(`Extension storage revision conflict: expected ${expectedRevision}, actual ${session.snapshot.document.revision}`);
      }
      if (!isRecord(params.data)) throw new Error("Extension storage data must be a JSON object");
      const data = asJsonValue(params.data) as JsonObject;
      if (session.phase === "activating") {
        session.transaction ??= await this.#storage.prepareWrite(
          session.address,
          session.schemaVersion,
          data,
        );
        session.transaction.stageData(data);
        session.snapshot = {
          ...session.snapshot,
          document: {
            ...session.snapshot.document,
            data: structuredClone(data),
            schemaVersion: session.schemaVersion,
          },
        };
        return asJsonValue(session.snapshot);
      }
      session.snapshot = await this.#storage.update(
        session.address,
        expectedRevision,
        session.schemaVersion,
        data,
      );
      return asJsonValue(session.snapshot);
    }
    if (method === "service.invoke") return this.#invokeService(params, signal);
    throw new Error(`Unknown Brokered Host child request: ${method}`);
  }

  async #openStorageSession(
    owner: HostServiceOwnerIdentity,
    requestValue: { key: string; schemaVersion?: number; scope: VarinExtensionStorageAddress["scope"] },
  ): Promise<BrokerStorageSession> {
    const storages = this.#storageSessions.get(ownerStorageKey(owner));
    if (!storages) throw new Error("Brokered Host storage owner is inactive");
    const key = storageAddressKey(requestValue);
    const existing = storages.get(key);
    if (existing) {
      if (requestValue.schemaVersion !== undefined && requestValue.schemaVersion !== existing.schemaVersion) {
        throw new Error(`Extension storage ${requestValue.scope}/${requestValue.key} is already open with schemaVersion ${existing.schemaVersion}`);
      }
      return existing;
    }
    const phase = storages.values().next().value?.phase as BrokerStorageSession["phase"] | undefined;
    if (!phase || phase === "disposed" || phase === "draining") throw new Error("Brokered Host storage owner is inactive");
    const address: VarinExtensionStorageAddress = {
      extensionId: owner.extensionId,
      key: requestValue.key,
      scope: requestValue.scope,
    };
    const snapshot = await this.#storage.read(address);
    const session: BrokerStorageSession = {
      address,
      phase,
      schemaVersion: requestValue.schemaVersion ?? snapshot.document.schemaVersion,
      snapshot,
      transaction: null,
    };
    storages.set(key, session);
    return session;
  }

  async #commitInstanceStorage(instance: BrokeredHostInstance): Promise<void> {
    const sessions = [...instance.storages.values()].filter((session) => session.transaction !== null);
    if (sessions.length === 0) return;
    const transactions = sessions.map((session) => session.transaction as ExtensionStorageMigrationTransaction);
    const snapshots = await this.#storage.commitPrepared(transactions);
    sessions.forEach((session, index) => { session.snapshot = snapshots[index] as VarinExtensionStorageSnapshot; });
    try {
      await this.#syncInstanceStorage(instance);
    } catch (error) {
      await this.#rollbackInstanceStorage(instance);
      throw error;
    }
  }

  async #rollbackInstanceStorage(instance: BrokeredHostInstance): Promise<void> {
    const sessions = [...instance.storages.values()].filter((session) => session.transaction !== null);
    if (sessions.length === 0) return;
    const transactions = sessions.map((session) => session.transaction as ExtensionStorageMigrationTransaction);
    await this.#storage.rollbackPrepared(transactions);
    sessions.forEach((session) => {
      const transaction = session.transaction as ExtensionStorageMigrationTransaction;
      session.snapshot = {
        ...transaction.previous,
        document: {
          ...transaction.previous.document,
          data: structuredClone(transaction.targetData),
          schemaVersion: transaction.targetSchemaVersion,
        },
      };
    });
    await this.#syncInstanceStorage(instance).catch(() => undefined);
  }

  #finalizeInstanceStorage(instance: BrokeredHostInstance): void {
    if (this.#preparations.get(instance.owner.extensionId) === instance.preparation) {
      this.#preparations.delete(instance.owner.extensionId);
      this.#preparationTargets.delete(instance.owner.extensionId);
    }
    for (const session of instance.storages.values()) {
      session.phase = "active";
      session.transaction = null;
    }
  }

  #setStoragePhase(instance: BrokeredHostInstance, phase: BrokerStorageSession["phase"]): void {
    for (const session of instance.storages.values()) session.phase = phase;
  }

  #syncInstanceStorage(instance: BrokeredHostInstance): Promise<unknown> {
    return instance.broker.request("storage.sync", {
      storages: [...instance.storages.values()].map((session) => session.snapshot),
    }, instance.preparation.signal);
  }

  async #reportActual(extensionId: string, state: VarinExtensionActualState): Promise<void> {
    await this.#catalog.reportActualState(extensionId, state);
    this.#onStateChange();
  }
}
