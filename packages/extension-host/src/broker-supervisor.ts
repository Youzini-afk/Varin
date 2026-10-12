import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fork, type ChildProcess } from "node:child_process";
import {
  parseVarinExtensionServiceInvocationRequest,
  parseVarinExtensionServiceProvision,
  parseVarinToolJson,
  parseVarinExtensionStorageOpenRequest,
  type JsonObject,
  type JsonValue,
  type VarinExtensionActualState,
  type VarinExtensionCapabilityGrant,
  type VarinExtensionCatalogEntry,
  type VarinExtensionCatalogSnapshot,
  type VarinExtensionCandidatePreparationResult,
  type VarinExtensionSurfaceReadiness,
  type VarinExtensionManifest,
  type VarinExtensionServiceProvision,
  type VarinExtensionServiceInvocationRequest,
  type VarinExtensionStorageSnapshot,
  type VarinExtensionStorageAddress,
  type VarinExtensionServiceRoutingContext,
  type VarinHostServiceComposition,
  type VarinHostServiceDependencyBinding,
  canonicalServiceComposition,
} from "@varin/extension-contract";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import type { HostCapabilityRegistry } from "./capability-registry.js";
import { ExtensionPackageManager } from "./package-manager.js";
import { NativeHostTransport } from "./native-host-transport.js";
import {
  HostServiceRegistry,
  type HostServiceOwnerIdentity,
  type HostInvocationScope,
  type HostServiceProvision,
  type HostServiceBinding,
  type HostServicePin,
} from "./service-registry.js";
import {
  ExtensionStorageStore,
  type ExtensionStorageMigrationTransaction,
} from "./storage-store.js";

import { ServiceRoutingStore } from './service-routing-store.js';
import { resolveDeclaredServiceRouting } from './runtime-contracts.js';
import { compositionHash, compositionForNode, createHostCompositionPlan, restoreHostCompositionPlan, resolveHostRequirement,
  type HostCompositionNode, type HostCompositionPlan } from './service-composition.js';

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

export interface BrokeredHostStopResult { processExited: true; cleanup: "confirmed" | "unconfirmed" }

export interface BrokeredHostTransport {
  forceTerminate(): void;
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  terminate(): Promise<BrokeredHostStopResult | void>;
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
  preparationId: string;
  epoch: number;
  preparation: AbortController;
  artifactIntegrity: string;
  broker: BrokeredHostTransport;
  desiredRevision: number;
  grants: VarinExtensionCapabilityGrant[];
  grantIdentity: string;
  manifest: VarinExtensionManifest;
  owner: HostServiceOwnerIdentity;
  provisions: HostServiceProvision[];
  slot: "candidate" | "selected";
  storages: Map<string, BrokerStorageSession>;
  composition: VarinHostServiceComposition;
  dependencies: VarinHostServiceDependencyBinding[];
  dependencyPins: HostServicePin[];
  references: number;
  referenceReleases: Set<() => void>;
  onUnreferenced: Array<() => void>;
  published: boolean;
  retiring: boolean;
  revoked: boolean;
  disposed: boolean;
  revocation: AbortController;
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
  /** Grace for a broker disposer after live exchange pins have drained; not an execution budget. */
  brokerShutdownGraceMs?: number;
  capabilities: HostCapabilityRegistry;
  catalog: ApplicationExtensionCatalog;
  onStateChange?: () => void;
  packages: ExtensionPackageManager;
  services: HostServiceRegistry;
  storage: ExtensionStorageStore;
  transportFactory?: BrokeredHostTransportFactory;
  routing: ServiceRoutingStore;
  prepareBuiltin?(extensionId: string): Promise<void>;
}

const hostGrants = (grants: readonly VarinExtensionCapabilityGrant[], version: string): VarinExtensionCapabilityGrant[] => (
  grants.filter((grant) => grant.realm === "host" && grant.manifestVersion === version).map((grant) => ({ ...grant }))
);
const grantIdentity = (grants: readonly VarinExtensionCapabilityGrant[], version: string): string => JSON.stringify(
  hostGrants(grants, version).map((grant) => [grant.capability, grant.granted]).sort(([left], [right]) => String(left).localeCompare(String(right))),
);

const serviceKey = (id: string, version: number): string => `${id}@${version}`;
const ownerStorageKey = (owner: HostServiceOwnerIdentity): string => `${owner.extensionId}\0${owner.entrypointId}\0${owner.generation}`;
const storageAddressKey = (address: Pick<VarinExtensionStorageAddress, "key" | "scope">): string => (
  `${address.scope}\0${address.key}`
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const asJsonValue = (value: unknown): JsonValue => parseVarinToolJson(value, "Broker RPC value");

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
  readonly #exited: Promise<void>;
  readonly #shutdownGraceMs: number;
  #termination: Promise<BrokeredHostStopResult> | undefined;
  #cleanupConfirmed = false;
  readonly #requestFromChild: (method: string, params: unknown, signal: AbortSignal) => Promise<JsonValue>;
  #intentional = false;
  #crashed = false;
  #channelFailure: Error | undefined;
  #requestId = 0;

  constructor(options: {
    brokerScript: string;
    shutdownGraceMs?: number;
    forkProcess?: typeof fork;
    onCrash(error: Error): void;
    requestFromChild(method: string, params: unknown, signal: AbortSignal): Promise<JsonValue>;
  }) {
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    if (!Number.isSafeInteger(this.#shutdownGraceMs) || this.#shutdownGraceMs <= 0) throw new Error("Broker shutdown grace must be a positive integer");
    this.#onCrash = options.onCrash;
    this.#requestFromChild = options.requestFromChild;
    this.#child = (options.forkProcess ?? fork)(options.brokerScript, [], {
      env: process.env,
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let resolveExited!: () => void;
    this.#exited = new Promise<void>(resolve => { resolveExited = resolve; });
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
      resolveExited();
      const error = new Error(`Brokered Host process exited (${code ?? signal ?? "unknown"})`);
      rejectReadyRequest(error);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      for (const controller of this.#childRequests.values()) controller.abort(error);
      this.#childRequests.clear();
      if (!this.#intentional && !this.#crashed) { this.#crashed = true; this.#onCrash(error); }
    });
    this.#child.on("error", (error) => {
      if (!this.#child.pid) {
        // Spawn failed: there was no execution process to retain.
        resolveExited();
        rejectReadyRequest(error);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
      } else this.#failChannel(error);
    });
    this.#child.on("disconnect", () => {
      if (!this.#intentional) this.#failChannel(new Error("Brokered Host IPC disconnected"));
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
    if (this.#channelFailure) throw this.#channelFailure;
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
          // Delivery failure does not establish whether the child received or ran the request.
          // Stop the unreliable owner, but retain its callback until a response or actual exit.
          this.#failChannel(error);
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

  terminate(): Promise<BrokeredHostStopResult> {
    if (this.#termination) return this.#termination;
    if (this.#intentional) return this.#exited.then(() => ({ processExited: true, cleanup: this.#cleanupConfirmed ? "confirmed" : "unconfirmed" }));
    this.#intentional = true;
    this.#termination = (async () => {
      let forced = false;
      // A broker can stall in its disposer even with zero service calls. Bound only this final
      // process-cleanup phase, after normal replacement has respected every live exchange pin.
      const timer = setTimeout(() => { forced = true; this.forceTerminate(); }, this.#shutdownGraceMs);
      try {
        if (this.#child.connected) { await this.request("deactivate"); this.#cleanupConfirmed = true; }
        if (this.#child.connected) this.#child.disconnect();
        await this.#exited;
      } catch (error) {
        this.forceTerminate();
        await this.#exited;
        if (!forced) throw error;
      } finally { clearTimeout(timer); }
      return { processExited: true, cleanup: this.#cleanupConfirmed ? "confirmed" : "unconfirmed" };
    })();
    return this.#termination;
  }

  forceTerminate(): void {
    this.#intentional = true;
    for (const controller of this.#childRequests.values()) controller.abort("Brokered Host process force-terminated");
    this.#childRequests.clear();
    this.#child.kill("SIGKILL");
  }

  #failChannel(error: Error): void {
    if (this.#channelFailure) return;
    this.#channelFailure = error;
    if (!this.#intentional && !this.#crashed) {
      this.#crashed = true;
      this.#onCrash(error);
    }
    this.forceTerminate();
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
        this.#failChannel(new Error(message.error || "Brokered Host process failed"));
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

export class ExtensionUpdateReadinessError extends Error {
  constructor(readonly code: "required_surface_readiness" | "stale_surface_readiness" | "surface_readiness_not_declared", message: string) {
    super(message);
  }
}

interface HostNodeLease {
  instance: BrokeredHostInstance;
  release(): void;
}
export interface HostCompositionLease {
  readonly owner: HostServiceOwnerIdentity;
  readonly composition: VarinHostServiceComposition;
  readonly routingRevision: number;
  readonly revocationSignal: AbortSignal;
  bind(serviceId: string, version: number): HostServiceBinding;
  release(): void;
}
interface RootConsumer {
  plan: HostCompositionPlan;
  instance: BrokeredHostInstance;
  current: HostNodeLease;
}
interface CandidateGroup {
  extensionId: string;
  integrity: string;
  desiredRevision: number;
  preparationId: string;
  generation: number;
  roots: Array<{ plan: HostCompositionPlan; lease: HostCompositionLease; consumer?: RootConsumer }>;
  instances: BrokeredHostInstance[];
}

export class BrokeredHostSupervisor {
  readonly #active = new Map<string, BrokeredHostInstance>();
  readonly #invocations = new Map<string, { scope?: HostInvocationScope; signal: AbortSignal; active: boolean }>();
  readonly #brokerScript: string;
  readonly #capabilities: HostCapabilityRegistry;
  readonly #catalog: ApplicationExtensionCatalog;
  readonly #generations = new Map<string, number>();
  readonly #packages: ExtensionPackageManager;
  readonly #onStateChange: () => void;
  readonly #services: HostServiceRegistry;
  readonly #routing: ServiceRoutingStore;
  readonly #prepareBuiltin: (extensionId: string) => Promise<void>;
  readonly #staged = new Map<string, CandidateGroup>();
  readonly #nativeRestartRequired = new Set<string>();
  readonly #storage: ExtensionStorageStore;
  readonly #ownerDependencies = new Map<string, { bindings: VarinHostServiceDependencyBinding[]; pins: HostServicePin[] }>();
  readonly #storageSessions = new Map<string, Map<string, BrokerStorageSession>>();
  readonly #transportFactory: BrokeredHostTransportFactory;
  readonly #operations = new Map<string, Promise<void>>();
  readonly #retirements = new Map<string, { instance: BrokeredHostInstance; promise: Promise<void> }>();
  readonly #pending = new Map<string, { node: HostCompositionNode; promise: Promise<BrokeredHostInstance>; controller: AbortController; waiters: number; settled: boolean }>();
  readonly #candidatePreparations = new Map<string, Promise<VarinExtensionCandidatePreparationResult>>();
  readonly #candidateSelections = new Set<string>();
  readonly #preparations = new Map<string, AbortController>();
  readonly #roots = new Set<RootConsumer>();
  readonly #anchors = new Map<string, HostCompositionLease>();
  readonly #ownerGrants = new Map<string, {
    owner: HostServiceOwnerIdentity; artifactIntegrity: string; grants: VarinExtensionCapabilityGrant[];
    desiredRevision: number; slot: 'candidate' | 'selected'; broker: BrokeredHostTransport; native: boolean;
  }>();
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
    this.#storage = options.storage;
    this.#routing = options.routing;
    this.#prepareBuiltin = options.prepareBuiltin ?? (async () => {});
    this.#transportFactory = options.transportFactory ?? (transportOptions => new ChildBrokeredHostTransport({
      brokerScript: this.#brokerScript,
      ...(options.brokerShutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.brokerShutdownGraceMs }),
      onCrash: transportOptions.onCrash,
      requestFromChild: (method, params, signal) => this.#handleChildRequest(transportOptions.owner, transportOptions.grants, method, params, signal),
    }));
  }
  getActiveArtifactIdentity(owner: HostServiceOwnerIdentity): string | undefined {
    const instance = this.#active.get(owner.instanceKey);
    return instance && !instance.retiring && instance.owner.generation === owner.generation ? instance.artifactIntegrity : undefined;
  }
  getRetainedArtifactIdentity(owner: HostServiceOwnerIdentity): string | undefined {
    const retained = this.#ownerGrants.get(ownerStorageKey(owner));
    return retained?.owner.extensionVersion === owner.extensionVersion ? retained.artifactIntegrity : undefined;
  }
  getRetainedComposition(owner: HostServiceOwnerIdentity): VarinHostServiceComposition | undefined {
    return this.#instance(owner)?.composition;
  }
  #instance(owner: HostServiceOwnerIdentity): BrokeredHostInstance | undefined {
    const current = this.#active.get(owner.instanceKey);
    if (current?.owner.generation === owner.generation) return current;
    return this.#retirements.get(ownerStorageKey(owner))?.instance;
  }
  #latest(extensionId: string): BrokeredHostInstance | undefined {
    return [...this.#active.values()].filter(instance => instance.owner.extensionId === extensionId && instance.slot === 'selected' && !instance.revoked)
      .sort((a, b) => b.owner.generation - a.owner.generation)[0];
  }
  #assertRunning(): void { if (this.#stopping) throw new Error('Host supervisor is shutting down'); }
  #enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#operations.get(key) ?? Promise.resolve()).then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#operations.set(key, settled);
    void settled.then(() => { if (this.#operations.get(key) === settled) this.#operations.delete(key); });
    return result;
  }

  async #plan(extensionId: string, scope: VarinExtensionServiceRoutingContext,
    candidate?: { extensionId: string; integrity: string }): Promise<HostCompositionPlan> {
    let catalog = await this.#catalog.snapshot();
    const routing = await this.#routing.read();
    if (!catalog.authoritative || !routing.authoritative) throw new Error('Cannot prepare a Host service from stale selection state');
    const visited = new Set<string>();
    const materialize = async (id: string, stack: string[]): Promise<void> => {
      if (stack.includes(id)) throw new Error(`Host service dependency cycle: ${[...stack, id].join(' -> ')}`);
      if (visited.has(id)) return;
      visited.add(id);
      const entry = catalog.extensions.find(entry => entry.manifest.id === id);
      if (!entry?.desired.enabled) throw new Error(`Host dependency is unavailable: ${id}`);
      const manifest = id === candidate?.extensionId ? entry.candidate?.manifest : entry.manifest;
      if (!manifest) throw new Error(`Host candidate is unavailable: ${id}`);
      await Promise.all((manifest.requires?.services ?? []).filter(requirement => requirement.realms.includes('host')).flatMap(requirement => resolveHostRequirement(catalog, routing, requirement, scope)
        .map(provider => materialize(provider.manifest.id, [...stack, id]))));
      await this.#prepareBuiltin(id);
    };
    await materialize(extensionId, []);
    catalog = await this.#catalog.snapshot();
    return createHostCompositionPlan(catalog, routing, extensionId, scope, candidate);
  }
  async prepareExtension(extensionId: string, scope: VarinExtensionServiceRoutingContext = {}, signal?: AbortSignal,
    frozen?: VarinHostServiceComposition): Promise<HostCompositionLease> {
    this.#assertRunning(); signal?.throwIfAborted();
    const plan = frozen ? restoreHostCompositionPlan(frozen, await this.#catalog.snapshot()) : await this.#plan(extensionId, scope);
    return this.prepareComposition(plan, signal, frozen === undefined);
  }
  async prepareSurfaceExtension(extensionId: string, scope: VarinExtensionServiceRoutingContext, signal: AbortSignal,
    candidate?: { extensionId: string; integrity: string }): Promise<HostCompositionLease> {
    return this.prepareComposition(await this.#plan(extensionId, scope, candidate), signal, true);
  }
  async prepareComposition(plan: HostCompositionPlan, signal?: AbortSignal, selectionOwner = true): Promise<HostCompositionLease> {
    this.#assertRunning(); signal?.throwIfAborted();
    const acquired = await this.#acquireNode(plan.root, signal);
    let released = false;
    const consumer: RootConsumer = { plan, instance: acquired.instance, current: acquired };
    if (selectionOwner) this.#roots.add(consumer);
    return {
      get owner() { return consumer.current.instance.owner; },
      get composition() { return consumer.plan.composition; },
      get routingRevision() { return consumer.plan.routingRevision; },
      revocationSignal: acquired.instance.revocation.signal,
      bind: (id, version) => {
        if (released) throw new Error('Host composition lease has been released');
        return this.#bindInstance(consumer.current.instance, id, version);
      },
      release: () => {
        if (released) return; released = true;
        this.#roots.delete(consumer);
        consumer.current.release();
      },
    };
  }
  #retain(instance: BrokeredHostInstance): HostNodeLease {
    if (instance.revoked || instance.disposed) throw new Error('Host composition instance is unavailable');
    instance.references += 1;
    let released = false;
    const release = () => {
      if (released) return; released = true; instance.referenceReleases.delete(release); instance.references -= 1;
      if (instance.references === 0) for (const resolve of instance.onUnreferenced.splice(0)) resolve();
      this.#unused(instance);
    };
    instance.referenceReleases.add(release);
    return { instance, release };
  }

  async #acquireNode(node: HostCompositionNode, signal?: AbortSignal): Promise<HostNodeLease> {
    signal?.throwIfAborted(); this.#assertRunning();
    const identity = `${node.node.id}:${this.#epochs.get(node.node.extensionId) ?? 0}`;
    let pending = this.#pending.get(identity);
    if (!pending) {
      const controller = new AbortController();
      pending = { node, controller, waiters: 0, settled: false, promise: Promise.resolve(undefined as never) };
      const current = pending;
      current.promise = this.#activateNode(node, controller.signal).finally(() => {
        current.settled = true;
        if (this.#pending.get(identity) === current) this.#pending.delete(identity);
      });
      this.#pending.set(identity, current);
    }
    const current = pending; current.waiters += 1;
    return new Promise<HostNodeLease>((resolve, reject) => {
      let done = false;
      const finish = () => { if (done) return false; done = true; signal?.removeEventListener('abort', abort); current.waiters -= 1; return true; };
      const abort = () => {
        if (!finish()) return;
        if (!current.waiters && !current.settled) current.controller.abort(signal?.reason ?? new Error('Host preparation has no remaining consumer'));
        reject(signal?.reason ?? new Error('Host preparation cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      void current.promise.then(instance => {
        if (!finish()) { if (!current.waiters) this.#unused(instance); return; }
        try { resolve(this.#retain(instance)); } catch (error) { reject(error); }
      }, error => { if (finish()) reject(error); });
      if (signal?.aborted) abort();
    });
  }
  async #activateNode(node: HostCompositionNode, signal: AbortSignal): Promise<BrokeredHostInstance> {
    const dependencyPins: HostServicePin[] = [];
    const dependencies: VarinHostServiceDependencyBinding[] = [];
    const preparation = new AbortController();
    const dependencySignal = AbortSignal.any([signal, preparation.signal]);
    try {
      // Every accepted child preparation settles its lease even if a sibling fails first.
      const resolved = await Promise.allSettled(node.dependencies.map(async ({ requirement, providers }) => {
        const acquired = await Promise.allSettled(providers.map(async provider => {
          try {
            const lease = await this.#acquireNode(provider, dependencySignal);
            try {
            const binding = this.#bindInstance(lease.instance, requirement.id, requirement.version);
              try { dependencyPins.push(binding.pin()); return binding.providerId; } finally { binding.release(); }
            } finally { lease.release(); }
          } catch (error) { preparation.abort(error); throw error; }
        }));
        const failure = acquired.find(value => value.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return { ...requirement, providerIds: acquired.map(value => (value as PromiseFulfilledResult<string>).value) };
      }));
      const failure = resolved.find(value => value.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      dependencies.push(...resolved.map(value => (value as PromiseFulfilledResult<VarinHostServiceDependencyBinding>).value));
      signal.throwIfAborted();
      const instanceKey = compositionHash({ node: node.node.id, dependencies: dependencies.map(dependency => [dependency.id, dependency.version, dependency.providerIds]) });
      const existing = this.#active.get(instanceKey);
      if (existing && !existing.revoked && !existing.retiring && !existing.preparation.signal.aborted) {
        for (const pin of dependencyPins.splice(0)) pin.release();
        return existing;
      }
      const candidate = node.slot === 'candidate' ? node.entry.candidate : undefined;
      const manifest = candidate?.manifest ?? node.entry.manifest;
      if (manifest.entrypoints?.host?.mode === 'native') {
        if (this.#nativeRestartRequired.has(node.node.extensionId)
          || [...this.#ownerGrants.values()].some(owner => owner.native && owner.owner.extensionId === node.node.extensionId && owner.artifactIntegrity !== node.node.artifactIntegrity)) {
          this.#nativeRestartRequired.add(node.node.extensionId);
          throw new Error('Trusted-native Host generation requires an application-host restart');
        }
      }
      const instance = await this.#prepareInstance(node.entry, {
        capabilityGrants: candidate?.capabilityGrants ?? node.entry.capabilityGrants,
        integrity: node.node.artifactIntegrity, manifest, slot: node.slot, version: node.node.extensionVersion,
      }, await this.#catalog.snapshot(), { instanceKey, dependencies, dependencyPins,
        composition: compositionForNode(node), signal });
      // A selected package depending on an unpublished candidate is itself unpublished.
      const staged = node.slot === 'candidate' || dependencyPins.some(pin => this.#services.getSnapshot().providers
        .some(provider => provider.providerId === pin.providerId && provider.status === 'candidate'));
      const publication = this.#services.prepareOwnerReplacement(instance.owner, instance.provisions, {
        composition: instance.composition, onUnused: () => this.#unused(instance), previousOwners: [], candidate: staged,
      });
      try {
        await this.#assertCurrent(instance);
        if (!staged) { await this.#commitInstanceStorage(instance); await this.#assertCurrent(instance); }
        publication.commit();
        instance.published = !staged;
        this.#active.set(instanceKey, instance);
        if (!staged) this.#finalizeInstanceStorage(instance);
        await this.#reportOwner(node.entry.manifest.id);
        return instance;
      } catch (error) {
        await publication.rollback();
        await this.#rollbackInstanceStorage(instance);
        await this.#disposeInstance(instance, false);
        throw error;
      }
    } catch (error) { for (const pin of dependencyPins.splice(0)) pin.release(); throw error; }
  }
  #bindInstance(instance: BrokeredHostInstance, id: string, version: number): HostServiceBinding {
    if (instance.revoked || instance.disposed) throw new Error('Host composition instance is unavailable');
    const provision = instance.provisions.find(provision => provision.descriptor.id === id && provision.descriptor.version === version);
    if (!provision) throw new Error(`Host activation did not provide ${id}@${version}`);
    const providerId = this.#providerId(instance.owner, provision.descriptor);
    return instance.published ? this.#services.bindPinned(id, version, providerId) : this.#services.bindPrepared(id, version, providerId);
  }
  #unused(instance: BrokeredHostInstance): void {
    if (!instance.disposed && !instance.references && !this.#services.ownerInUse(instance.owner)) this.#retire(instance);
  }
  #retire(instance: BrokeredHostInstance): void {
    if (instance.retiring || instance.disposed) return;
    instance.retiring = true;
    if (this.#active.get(instance.owner.instanceKey) === instance) this.#active.delete(instance.owner.instanceKey);
    const drain = this.#services.retireOwner(instance.owner);
    const promise = (async () => {
      if (instance.references) await new Promise<void>(resolve => instance.onUnreferenced.push(resolve));
      await drain;
      this.#services.removeOwner(instance.owner);
      await this.#disposeInstance(instance, true);
      await this.#reportOwner(instance.owner.extensionId);
    })();
    const key = ownerStorageKey(instance.owner);
    this.#retirements.set(key, { instance, promise });
    void promise.then(() => { if (this.#retirements.get(key)?.promise === promise) this.#retirements.delete(key); }, async error => {
      await this.#reportOwner(instance.owner.extensionId, 'host_retirement_failed', new Error(`Retiring generation ${instance.owner.generation}: ${error instanceof Error ? error.message : String(error)}`)).catch(() => undefined);
    });
  }
  async #assertCurrent(instance: BrokeredHostInstance): Promise<void> {
    this.#assertRunning(); instance.preparation.signal.throwIfAborted();
    if ((this.#epochs.get(instance.owner.extensionId) ?? 0) !== instance.epoch) throw new Error('Host activation was superseded');
    const entry = (await this.#catalog.snapshot()).extensions.find(entry => entry.manifest.id === instance.owner.extensionId);
    const selected = instance.slot === 'candidate' ? entry?.candidate : entry;
    if (!entry?.desired.enabled || entry.desired.revision !== instance.desiredRevision || selected?.integrity !== instance.artifactIntegrity
      || grantIdentity(selected.capabilityGrants, instance.owner.extensionVersion) !== instance.grantIdentity) throw new Error(`Host activation is stale: ${instance.owner.extensionId}`);
    for (const pin of instance.dependencyPins) pin.assertAvailable();
  }
  async activateExtension(extensionId: string): Promise<void> {
    const acquired = await this.prepareExtension(extensionId);
    const previous = this.#anchors.get(extensionId);
    this.#anchors.set(extensionId, acquired); previous?.release();
    // Explicit/startup selection moves its owner without waiting for old independent exchanges.
    if (previous && previous.owner.instanceKey !== acquired.owner.instanceKey) {
      const old = this.#instance(previous.owner); if (old) this.#retire(old);
    }
  }
  activeExtensions(): string[] { return [...new Set([...this.#active.values()].filter(instance => instance.published && !instance.revoked).map(instance => instance.owner.extensionId))].sort(); }
  async activateForService(requestValue: VarinExtensionServiceInvocationRequest | unknown): Promise<void> {
    const request = parseVarinExtensionServiceInvocationRequest(requestValue);
    const catalog = await this.#catalog.snapshot(), routing = await this.#routing.read();
    const resolved = resolveDeclaredServiceRouting(catalog, routing, request.serviceId, request.version, request.routing);
    if (resolved.status !== 'resolved') throw new Error('Host service selection is unavailable');
    await Promise.all(resolved.extensionIds.map(id => this.activateExtension(id)));
  }
  #revoke(extensionId: string): void {
    this.#epochs.set(extensionId, (this.#epochs.get(extensionId) ?? 0) + 1);
    for (const pending of this.#pending.values()) if (pending.node.node.extensionId === extensionId) pending.controller.abort(new Error(`Host owner revoked: ${extensionId}`));
    for (const [key, controller] of this.#preparations) if (key.startsWith(`${extensionId}\0`)) controller.abort(new Error(`Host owner revoked: ${extensionId}`));
    this.#revokeOwners([...this.#ownerGrants.values()].filter(owner => owner.owner.extensionId === extensionId).map(owner => owner.owner));
  }
  /** Revoke actual owner edges. A failed/denied candidate never sweeps selected instances by name. */
  #revokeOwners(owners: readonly HostServiceOwnerIdentity[]): void {
    const revoked = new Set(owners.map(ownerStorageKey));
    const instances = [...this.#active.values(), ...[...this.#retirements.values()].map(retirement => retirement.instance)];
    for (;;) {
      let changed = false;
      const providerIds = new Set(this.#services.getSnapshot().providers.filter(provider => revoked.has(ownerStorageKey(provider))).map(provider => provider.providerId));
      for (const [key, dependencies] of this.#ownerDependencies) {
        if (!revoked.has(key) && dependencies.pins.some(pin => providerIds.has(pin.providerId))) { revoked.add(key); changed = true; }
      }
      if (!changed) break;
    }
    for (const key of revoked) {
      const tracked = this.#ownerGrants.get(key); if (!tracked) continue;
      for (const grant of tracked.grants) grant.granted = false;
      this.#preparations.get(`${tracked.owner.extensionId}\0${tracked.owner.instanceKey}`)?.abort(new Error('Host owner revoked'));
      this.#services.revokeOwner(tracked.owner);
      if (!tracked.native && this.#services.hasPendingOwnerCalls(tracked.owner)) tracked.broker.forceTerminate();
    }
    for (const instance of instances) {
      if (!revoked.has(ownerStorageKey(instance.owner))) continue;
      instance.revoked = true;
      instance.revocation.abort(new Error('Host composition was revoked'));
      this.#services.revokeOwner(instance.owner);
      for (const release of [...instance.referenceReleases]) release();
      if (instance.manifest.entrypoints?.host?.mode !== 'native' && this.#services.hasPendingOwnerCalls(instance.owner)) instance.broker.forceTerminate();
      for (const root of [...this.#roots]) if (root.instance === instance) {
        this.#roots.delete(root);
        this.#anchors.get(root.plan.root.node.extensionId)?.release(); this.#anchors.delete(root.plan.root.node.extensionId);
      }
      this.#retire(instance);
    }
  }
  forceTerminate(extensionId: string): void {
    this.#revoke(extensionId);
    for (const tracked of this.#ownerGrants.values()) if (tracked.owner.extensionId === extensionId) {
      if (tracked.native) this.#nativeRestartRequired.add(extensionId);
      tracked.broker.forceTerminate();
    }
  }
  async deactivateExtension(extensionId: string, afterDeactivate?: () => Promise<void>): Promise<void> {
    this.#revoke(extensionId);
    this.#anchors.get(extensionId)?.release(); this.#anchors.delete(extensionId);
    await this.discardPreparedCandidate(extensionId, this.#staged.get(extensionId)?.integrity ?? '');
    const retirements = [...this.#retirements.entries()].filter(([, value]) => value.instance.composition.nodes.some(node => node.extensionId === extensionId));
    const outcomes = await Promise.allSettled(retirements.map(([, value]) => value.promise));
    for (const [key, value] of retirements) if (this.#retirements.get(key) === value) this.#retirements.delete(key);
    const failures = outcomes.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(value => value.reason), 'Extension Host teardown reported failures');
    await afterDeactivate?.();
  }
  async reconcile(_snapshot?: VarinExtensionCatalogSnapshot): Promise<void> {
    this.#assertRunning();
    const snapshot = await this.#catalog.snapshot(); if (!snapshot.authoritative) return;
    const disabled = new Set<string>();
    const deniedOwners: HostServiceOwnerIdentity[] = [];
    // A composition owns its dependency waiters before it has a transport/generation.
    // Cancel only that node's preparation; other consumers keep their shared dependency.
    for (const pending of this.#pending.values()) {
      const { node, slot } = pending.node;
      const entry = snapshot.extensions.find(entry => entry.manifest.id === node.extensionId);
      if (!entry?.desired.enabled) { disabled.add(node.extensionId); continue; }
      const source = slot === 'candidate' ? entry.candidate : entry;
      if (!source) continue;
      const denied = new Set(source.capabilityGrants.filter(grant => grant.realm === 'host' && !grant.granted).map(grant => grant.capability));
      if (node.grants.some(grant => grant.granted && denied.has(grant.capability))) pending.controller.abort(new Error(`Host owner revoked: ${node.extensionId}`));
    }
    for (const tracked of this.#ownerGrants.values()) {
      const entry = snapshot.extensions.find(entry => entry.manifest.id === tracked.owner.extensionId);
      if (!entry?.desired.enabled) { disabled.add(tracked.owner.extensionId); continue; }
      const source = tracked.slot === 'candidate' ? entry.candidate : entry;
      if (!source) continue;
      const denied = new Set(source.capabilityGrants.filter(grant => grant.realm === 'host' && !grant.granted).map(grant => grant.capability));
      if (tracked.grants.some(grant => grant.granted && denied.has(grant.capability))) deniedOwners.push(tracked.owner);
      for (const grant of tracked.grants) if (denied.has(grant.capability)) grant.granted = false;
    }
    for (const id of disabled) this.#revoke(id);
    this.#revokeOwners(deniedOwners);
    await this.reconcileCandidatePreparations();
    await Promise.all(snapshot.extensions.filter(entry => entry.desired.enabled).map(async entry => {
      if (entry.candidate?.applyRequested && !entry.candidate.manifest.updateReadiness) {
        try { await this.selectCandidate(entry.manifest.id, entry.candidate.integrity, (await this.#catalog.snapshot()).revision); }
        catch (error) { await this.#reportOwner(entry.manifest.id, 'requested_candidate_activation_failed', error); }
      }
      if (!entry.manifest.entrypoints?.host) return;
      const activation = entry.manifest.entrypoints.host.activation ?? [];
      if (activation.length && !activation.includes('application-startup') && !activation.includes('background') && !this.#anchors.has(entry.manifest.id)) return;
      try { await this.activateExtension(entry.manifest.id); }
      catch (error) { await this.#reportOwner(entry.manifest.id, 'host_activation_failed', error); }
    }));
    // Explicit disable owns completion of the actual teardown, including disposer failures.
    // Independent preparation has no global queue and remains callable while this awaits its owners.
    await Promise.all([...disabled].map(id => this.deactivateExtension(id)));
  }
  async #reportOwner(extensionId: string, code?: string, error?: unknown): Promise<void> {
    const snapshot = await this.#catalog.snapshot();
    const entry = snapshot.extensions.find(entry => entry.manifest.id === extensionId); if (!entry) return;
    const active = this.#latest(extensionId);
    const status = this.#nativeRestartRequired.has(extensionId) ? 'restart-required' : active ? 'active' : code ? 'failed' : 'inactive';
    const state = diagnosticState(snapshot.hostId, entry.desired.revision, active?.owner.generation ?? this.#generations.get(extensionId) ?? 0,
      status, code, error instanceof Error ? error.message : error === undefined ? undefined : String(error));
    const cleanupDiagnostics = entry.actual.filter(actual => actual.realmKind === 'host' && actual.hostId === snapshot.hostId)
      .flatMap(actual => actual.diagnostics.filter(diagnostic => (diagnostic.code === 'broker_cleanup_unconfirmed' || diagnostic.code === 'host_retirement_failed')
        && (!active || diagnostic.message.startsWith(`Broker generation ${state.generation} `) || diagnostic.message.startsWith(`Retiring generation ${state.generation}:`))));
    state.diagnostics = [...new Map([...cleanupDiagnostics, ...state.diagnostics].map(diagnostic => [`${diagnostic.code}\0${diagnostic.message}`, diagnostic])).values()];
    await this.#reportActual(extensionId, state);
  }
  async reconcileCandidatePreparations(): Promise<void> {
    const snapshot = await this.#catalog.snapshot(); if (!snapshot.authoritative) return;
    for (const group of [...this.#staged.values()]) {
      const entry = snapshot.extensions.find(entry => entry.manifest.id === group.extensionId);
      if (entry?.desired.enabled && entry.desired.revision === group.desiredRevision
        && (entry.candidate?.integrity === group.integrity || entry.integrity === group.integrity)) continue;
      await this.discardPreparedCandidate(group.extensionId, group.integrity);
    }
  }
  prepareCandidate(extensionId: string, integrity: string): Promise<VarinExtensionCandidatePreparationResult> {
    const key = `${extensionId}\0${integrity}`;
    const pending = this.#candidatePreparations.get(key); if (pending) return pending;
    const promise = this.#prepareCandidate(extensionId, integrity);
    this.#candidatePreparations.set(key, promise);
    void promise.finally(() => { if (this.#candidatePreparations.get(key) === promise) this.#candidatePreparations.delete(key); }).catch(() => undefined);
    return promise;
  }
  async #prepareCandidate(extensionId: string, integrity: string): Promise<VarinExtensionCandidatePreparationResult> {
    this.#assertRunning();
    const snapshot = await this.#catalog.snapshot(), entry = snapshot.extensions.find(entry => entry.manifest.id === extensionId);
    if (entry?.integrity === integrity) return { extensionId, integrity, providers: this.#services.getSnapshot().providers.filter(provider => provider.extensionId === extensionId && provider.status === 'active') };
    if (!entry?.candidate || entry.candidate.integrity !== integrity) throw new Error(`Host candidate is stale: ${extensionId}`);
    if (!entry.candidate.capabilitiesReviewed) throw new Error(`Host candidate capabilities require review: ${extensionId}`);
    if (!entry.desired.enabled || !entry.candidate.manifest.entrypoints?.host) return { extensionId, integrity, providers: [] };
    if (entry.candidate.manifest.entrypoints.host.mode === 'native') {
      if (this.#ownerGrants.size && [...this.#ownerGrants.values()].some(owner => owner.owner.extensionId === extensionId)) throw new Error('Trusted-native Host candidate requires an application-host restart');
      if (entry.candidate.manifest.updateReadiness) throw new ExtensionUpdateReadinessError('required_surface_readiness', 'Trusted-native grouped update requires disable, apply and restart');
      return { extensionId, integrity, providers: [] };
    }
    const existing = this.#staged.get(extensionId);
    const consumers = [...this.#roots].filter(root => root.plan.composition.nodes.some(node => node.extensionId === extensionId));
    if (existing?.integrity === integrity && existing.desiredRevision === entry.desired.revision
      && existing.roots.filter(root => root.consumer).length === consumers.length
      && consumers.every(consumer => existing.roots.some(root => root.consumer === consumer))) {
      for (const instance of existing.instances) await this.#assertCurrent(instance);
      return this.#candidatePreparation(existing);
    }
    if (existing) {
      // An already queued publication owns its preparation. A new caller cannot tear it down.
      if (this.#operations.has(extensionId)) throw new Error('Host candidate publication is already in progress');
      await this.#releaseCandidateGroup(existing);
    }
    const activation = entry.candidate.manifest.entrypoints.host.activation ?? [];
    if (!consumers.length && !entry.candidate.manifest.updateReadiness && activation.length
      && !activation.includes('application-startup') && !activation.includes('background')) {
      // A lazy declaration without a live selection owner has no scope to compose yet.
      // An old exact exchange pin is deliberately not a replacement selection owner.
      return { extensionId, integrity, providers: [] };
    }
    const contexts = consumers.length ? consumers.map(consumer => ({ extensionId: consumer.plan.root.node.extensionId, scope: consumer.plan.scope, consumer }))
      : [{ extensionId, scope: {} as VarinExtensionServiceRoutingContext, consumer: undefined }];
    const roots: CandidateGroup['roots'] = [];
    try {
      for (const context of contexts) {
        const plan = await this.#plan(context.extensionId, context.scope, { extensionId, integrity });
        const lease = await this.prepareComposition(plan, undefined, false);
        roots.push({ plan, lease, ...(context.consumer ? { consumer: context.consumer } : {}) });
      }
      const instances = [...this.#active.values()].filter(instance => !instance.published && roots.some(root => root.plan.composition.nodes.some(node => node.id === instance.composition.root)));
      const group: CandidateGroup = { extensionId, integrity, desiredRevision: entry.desired.revision, preparationId: randomUUID(),
        generation: Math.max(0, ...instances.filter(instance => instance.owner.extensionId === extensionId).map(instance => instance.owner.generation)), roots, instances };
      this.#staged.set(extensionId, group);
      return this.#candidatePreparation(group);
    } catch (error) { for (const root of roots) root.lease.release(); throw error; }
  }
  #candidatePreparation(group: CandidateGroup): VarinExtensionCandidatePreparationResult {
    const providers = this.#services.getSnapshot().providers.filter(provider => group.instances.some(instance => instance.owner.extensionId === provider.extensionId && instance.owner.generation === provider.generation));
    return { extensionId: group.extensionId, integrity: group.integrity,
      hostPreparation: { id: group.preparationId, hostId: this.#services.hostId, desiredRevision: group.desiredRevision, generation: group.generation }, providers };
  }
  async selectCandidate(extensionId: string, integrity: string, expectedRevision: number, signal?: AbortSignal,
    surfaceReadiness?: VarinExtensionSurfaceReadiness): Promise<VarinExtensionCatalogSnapshot> {
    signal?.throwIfAborted();
    const snapshot = await this.#catalog.snapshot(), entry = snapshot.extensions.find(entry => entry.manifest.id === extensionId);
    if (entry?.integrity === integrity) return snapshot;
    if (entry?.desired.enabled && entry.candidate?.manifest.updateReadiness && !surfaceReadiness) throw new ExtensionUpdateReadinessError('required_surface_readiness', 'The update requires a compatible Surface to prepare its declared group');
    this.#candidateSelections.add(extensionId);
    try {
      await this.prepareCandidate(extensionId, integrity);
      return await this.#enqueue(extensionId, async () => {
        signal?.throwIfAborted(); this.#assertRunning();
        const group = this.#staged.get(extensionId);
        if (!group) return this.#packages.selectCandidate({ extensionId, candidateIntegrity: integrity, expectedRevision }, () => signal?.throwIfAborted());
        if (group.integrity !== integrity) throw new Error('Host candidate preparation changed');
        const current = (await this.#catalog.snapshot()).extensions.find(entry => entry.manifest.id === extensionId);
        const manifest = current?.candidate?.manifest;
        const required = manifest?.updateReadiness?.surfaceEntrypoints;
        let routingRevision: number | undefined;
        const validate = (checkConnection = true) => {
          if (checkConnection && routingRevision !== undefined) this.#routing.assertCurrentRevision(routingRevision);
          if (checkConnection) signal?.throwIfAborted(); this.#assertRunning();
          if (this.#staged.get(extensionId) !== group || group.instances.some(instance => instance.preparation.signal.aborted || instance.revoked)) throw new Error('Host candidate publication was cancelled');
          if (!required && surfaceReadiness) throw new ExtensionUpdateReadinessError('surface_readiness_not_declared', 'This candidate does not declare a Surface update group');
          if (required) {
            const prepared = surfaceReadiness?.hostPreparation, members = new Set(surfaceReadiness?.members.map(member => member.entrypointId));
            if (!prepared || prepared.id !== group.preparationId || prepared.hostId !== this.#services.hostId
              || prepared.generation !== group.generation || prepared.desiredRevision !== group.desiredRevision
              || members.size !== surfaceReadiness!.members.length || members.size !== required.length
              || required.some(id => !members.has(id) || !manifest?.entrypoints?.surfaces?.find(entry => entry.id === id)?.supports.includes(surfaceReadiness!.surface))) {
              throw new ExtensionUpdateReadinessError('stale_surface_readiness', 'Surface update readiness does not match the current Host preparation and required members');
            }
          }
        };
        validate();
        const committed: BrokeredHostInstance[] = [];
        let catalogCommitted = false;
        try {
          for (const instance of group.instances) { await this.#assertCurrent(instance); await this.#commitInstanceStorage(instance); committed.push(instance); }
          for (const root of group.roots) {
            const fresh = await this.#plan(root.plan.root.node.extensionId, root.plan.scope, { extensionId, integrity });
            if (canonicalServiceComposition(fresh.composition) !== canonicalServiceComposition(root.plan.composition)) throw new Error('Host candidate composition changed');
            if (routingRevision !== undefined && routingRevision !== fresh.routingRevision) throw new Error('Host service routing changed during candidate preparation');
            routingRevision = fresh.routingRevision;
          }
          const selected = await this.#packages.selectCandidate({ extensionId, candidateIntegrity: integrity, expectedRevision }, validate);
          catalogCommitted = true;
          validate(false);
          for (const instance of group.instances) {
            instance.slot = 'selected'; instance.published = true;
            this.#finalizeInstanceStorage(instance); this.#services.publishOwner(instance.owner);
          }
          for (const root of group.roots) if (root.consumer && this.#roots.has(root.consumer)) {
            const replacement = this.#active.get(root.lease.owner.instanceKey);
            if (replacement) {
              const old = root.consumer.instance, previous = root.consumer.current;
              if (old === replacement) { root.consumer.plan = root.plan; continue; }
              root.consumer.current = this.#retain(replacement); root.consumer.instance = replacement; root.consumer.plan = root.plan;
              previous.release(); this.#retire(old);
            }
          }
          this.#staged.delete(extensionId);
          for (const root of group.roots) root.lease.release();
          await this.#reportOwner(extensionId);
          return selected;
        } catch (error) {
          if (!catalogCommitted) for (const instance of committed.reverse()) await this.#rollbackInstanceStorage(instance);
          else {
            for (const root of group.roots) if (root.consumer && this.#roots.has(root.consumer)) this.#retire(root.consumer.instance);
            this.#staged.delete(extensionId);
            for (const root of group.roots) root.lease.release();
          }
          throw error;
        }
      });
    } finally { this.#candidateSelections.delete(extensionId); }
  }
  async discardPreparedCandidate(extensionId: string, integrity: string): Promise<void> {
    const group = this.#staged.get(extensionId);
    if (!group || group.integrity !== integrity || this.#candidateSelections.has(extensionId)) return;
    await this.#releaseCandidateGroup(group);
  }
  async #releaseCandidateGroup(group: CandidateGroup): Promise<void> {
    if (this.#staged.get(group.extensionId) === group) this.#staged.delete(group.extensionId);
    for (const root of group.roots) root.lease.release();
    await Promise.all(group.instances.map(instance => this.#retirements.get(ownerStorageKey(instance.owner))?.promise));
  }
  hasStagedProvider(providerId: string): boolean { return this.#services.getSnapshot().providers.some(provider => provider.providerId === providerId && provider.status === 'candidate'); }
  async invokeStagedService(requestValue: VarinExtensionServiceInvocationRequest | unknown, signal?: AbortSignal): Promise<JsonValue> {
    const request = parseVarinExtensionServiceInvocationRequest(requestValue);
    if (!request.providerId) throw new Error('Candidate invocation requires an exact provider ID');
    const binding = this.#services.bindPrepared(request.serviceId, request.version, request.providerId);
    try { return await binding.invoke(request.method, request.args, signal); } finally { binding.release(); }
  }
  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#stopping = true;
    for (const pending of this.#pending.values()) pending.controller.abort(new Error('Host supervisor is shutting down'));
    for (const anchor of this.#anchors.values()) anchor.release(); this.#anchors.clear();
    for (const group of this.#staged.values()) for (const root of group.roots) root.lease.release(); this.#staged.clear();
    for (const id of new Set([...this.#ownerGrants.values()].map(owner => owner.owner.extensionId))) this.#revoke(id);
    this.#shutdown = (async () => {
      await Promise.allSettled([...this.#pending.values()].map(pending => pending.promise));
      const results = await Promise.allSettled([...this.#retirements.values()].map(retirement => retirement.promise));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Extension Host shutdown reported failures');
    })();
    return this.#shutdown;
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
    composition: { instanceKey: string; composition: VarinHostServiceComposition; dependencies: VarinHostServiceDependencyBinding[]; dependencyPins: HostServicePin[]; signal: AbortSignal },
  ): Promise<BrokeredHostInstance> {
    this.#assertRunning();
    const epoch = this.#epochs.get(entry.manifest.id) ?? 0;
    const controller = new AbortController();
    let prepared = false;
    const preparationKey = `${entry.manifest.id}\0${composition.instanceKey}`;
    this.#preparations.set(preparationKey, controller);
    const abort = () => controller.abort(composition.signal.reason);
    composition.signal.addEventListener('abort', abort, { once: true });
    if (composition.signal.aborted) abort();
    try {
      const current = (await this.#catalog.snapshot()).extensions.find((value) => value.manifest.id === entry.manifest.id);
      const currentSelection = selection.slot === "candidate" ? current?.candidate : current;
      if (!current?.desired.enabled || current.desired.revision !== entry.desired.revision
        || currentSelection?.integrity !== selection.integrity
        || grantIdentity(currentSelection.capabilityGrants, selection.version) !== grantIdentity(selection.capabilityGrants, selection.version)) {
        throw new Error(`Host capability review or selection changed before activation: ${entry.manifest.id}`);
      }
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
        instanceKey: composition.instanceKey,
      };
      const grants = hostGrants(selection.capabilityGrants, selection.version);
      const preparedGrantIdentity = grantIdentity(grants, selection.version);
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
            // A crash belongs to this actual process, including an unpublished candidate.
            controller.abort(error);
            this.#handleCrash(owner, error);
          },
        });
      this.#ownerDependencies.set(ownerStorageKey(owner), { bindings: composition.dependencies, pins: composition.dependencyPins });
      this.#ownerGrants.set(ownerStorageKey(owner), { owner, artifactIntegrity: selection.integrity, grants, desiredRevision: entry.desired.revision, slot: selection.slot, broker, native: selection.manifest.entrypoints?.host?.mode === "native" });
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
          dependencies: composition.dependencies,
        }, controller.signal) as BrokerActivationResult;
        controller.signal.throwIfAborted();
        if ((this.#epochs.get(entry.manifest.id) ?? 0) !== epoch) throw new Error("Host activation was superseded");
        if (crashed) throw crashed;
        const provisions = this.#provisions(owner, broker, activation.provisions, selection.manifest);
        prepared = true;
        return {
          preparationId: randomUUID(),
          preparation: controller,
          epoch,
          artifactIntegrity: selection.integrity,
          broker,
          desiredRevision: entry.desired.revision,
          grants,
          grantIdentity: preparedGrantIdentity,
          manifest: selection.manifest,
          owner,
          provisions,
          slot: selection.slot,
          storages,
          composition: composition.composition, dependencies: composition.dependencies, dependencyPins: composition.dependencyPins,
          references: 0, referenceReleases: new Set(), onUnreferenced: [], published: false, retiring: false, revoked: false, disposed: false, revocation: new AbortController(),
        };
      } catch (error) {
        for (const session of this.#storageSessions.get(ownerStorageKey(owner))?.values() ?? []) session.phase = "disposed";
        this.#storageSessions.delete(ownerStorageKey(owner));
        for (const grant of grants) grant.granted = false;
        this.#ownerGrants.delete(ownerStorageKey(owner));
        this.#ownerDependencies.delete(ownerStorageKey(owner));
        broker.forceTerminate();
        await broker.terminate().catch(() => undefined);
        if (selection.manifest.entrypoints?.host?.mode === "native") this.#nativeRestartRequired.add(entry.manifest.id);
        // Direct service preparation has no startup/reconcile catch to publish its failure.
        // Retain a real old generation, and never overwrite a later selection/cancellation.
        if (!controller.signal.aborted && (this.#epochs.get(entry.manifest.id) ?? 0) === epoch
          && this.#generations.get(entry.manifest.id) === generation) {
          const active = this.#latest(entry.manifest.id);
          await this.#reportActual(entry.manifest.id, diagnosticState(
            snapshot.hostId, entry.desired.revision, active?.owner.generation ?? generation,
            active ? 'active' : 'failed', active ? 'host_candidate_activation_failed' : 'host_activation_failed',
            error instanceof Error ? error.message : String(error),
          )).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      composition.signal.removeEventListener('abort', abort);
      if (!prepared && this.#preparations.get(preparationKey) === controller) this.#preparations.delete(preparationKey);
    }
  }

  #provisions(
    owner: HostServiceOwnerIdentity,
    broker: BrokeredHostTransport,
    raw: unknown,
    manifest: VarinExtensionManifest,
  ): HostServiceProvision[] {
    if (!Array.isArray(raw)) throw new Error("Host activation must return service provisions");
    const values = raw;
    const declared = new Map((manifest.provides?.services ?? []).map((service) => [serviceKey(service.id, service.version), service]));
    const provisions = values.map<HostServiceProvision>((value) => {
      if (!isRecord(value) || typeof value.id !== "string" || !Number.isSafeInteger(value.version)) {
        throw new Error("Host service provision is invalid");
      }
      const key = serviceKey(value.id, Number(value.version));
      const descriptor = declared.get(key);
      if (!descriptor) throw new Error(`Host provided undeclared service: ${key}`);
      if (descriptor.tool !== undefined || value.tool !== undefined || descriptor.contract !== undefined || value.contract !== undefined) {
        const provided = parseVarinExtensionServiceProvision(value);
        if (!isDeepStrictEqual(provided, descriptor)) throw new Error(`Host service declaration differs from manifest: ${key}`);
      }
      return {
        descriptor: { ...descriptor },
        handler: async (method, args, context) => {
          const invocationId = randomUUID();
          const lifetime = new AbortController();
          const invocationKey = invocationId ? `${ownerStorageKey(owner)}\0${invocationId}` : undefined;
          if (invocationKey) this.#invocations.set(invocationKey, { ...(context.invocation ? { scope: context.invocation } : {}),
            signal: AbortSignal.any([context.signal, lifetime.signal]), active: true });
          try {
            return asJsonValue(await broker.request("service.invoke", {
              args,
              method,
              serviceId: descriptor.id,
              version: descriptor.version,
              ...(invocationId ? { invocationId } : {}),
            }, context.signal));
          } finally {
            lifetime?.abort(new Error("Host capability invocation has expired"));
            if (invocationKey) this.#invocations.delete(invocationKey);
          }
        },
      };
    });
    const registered = new Set(provisions.map(({ descriptor }) => serviceKey(descriptor.id, descriptor.version)));
    for (const [key, descriptor] of declared) {
      if ((descriptor.tool || descriptor.contract) && !registered.has(key)) throw new Error(`Host activation did not register declared service contract: ${key}`);
    }
    return provisions;
  }


  #providerId(owner: HostServiceOwnerIdentity, descriptor: VarinExtensionServiceProvision): string {
    return `${owner.extensionId}:${owner.entrypointId}:${owner.generation}:${serviceKey(descriptor.id, descriptor.version)}`;
  }

  async #disposeInstance(instance: BrokeredHostInstance, terminate: boolean): Promise<boolean> {
    if (instance.disposed) return true;
    instance.disposed = true;
    const preparationKey = `${instance.owner.extensionId}\0${instance.owner.instanceKey}`;
    if (this.#preparations.get(preparationKey) === instance.preparation) this.#preparations.delete(preparationKey);
    this.#setStoragePhase(instance, "disposed");
    this.#storageSessions.delete(ownerStorageKey(instance.owner));
    try {
      // Normal cleanup retains its reviewed capability view until it finishes. A forced process
      // exit is a separate fact from successful disposer completion.
      let result: BrokeredHostStopResult | void = undefined;
      let cleanupFailed = false;
      try { result = await instance.broker.terminate(); }
      catch (error) {
        instance.broker.forceTerminate();
        if (terminate) throw error;
        cleanupFailed = true;
      }
      const confirmed = !cleanupFailed && result?.cleanup !== "unconfirmed";
      if (result?.cleanup === "unconfirmed") {
        await this.#catalog.recordHostCleanupUnconfirmed(instance.owner.extensionId, instance.owner.generation);
        this.#onStateChange();
      }
      return confirmed;
    } finally {
      // Trusted-native callbacks may retain their context even after cleanup failed. Never
      // leave those captured grants usable after the owner is no longer tracked.
      for (const grant of instance.grants) grant.granted = false;
      this.#ownerGrants.delete(ownerStorageKey(instance.owner));
      this.#ownerDependencies.delete(ownerStorageKey(instance.owner));
      for (const pin of instance.dependencyPins.splice(0)) pin.release();
    }
  }

  #handleCrash(owner: HostServiceOwnerIdentity, error: Error): void {
    const instance = this.#instance(owner);
    if (!instance || instance.revoked) return;
    instance.revoked = true;
    instance.revocation.abort(error);
    this.#revokeOwners([owner]);
    void this.#reportOwner(owner.extensionId, 'brokered_host_crashed', error).catch(() => undefined);
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
      const scoped = params.invocationId === undefined ? undefined
        : typeof params.invocationId === "string"
          ? this.#invocations.get(`${ownerStorageKey(owner)}\0${params.invocationId}`)
          : undefined;
      if (params.invocationId !== undefined && (!scoped || !scoped.active)) throw new Error("Host capability invocation is expired or belongs to another owner");
      const callSignal = scoped ? AbortSignal.any([signal, scoped.signal]) : signal;
      return this.#capabilities.invoke(
        owner,
        grants,
        String(params.capability ?? ""),
        String(params.method ?? ""),
        asJsonValue(params.params),
        callSignal,
        scoped?.scope,
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
    if (method === 'service.invoke') {
      const request = parseVarinExtensionServiceInvocationRequest(params);
      const dependencies = this.#ownerDependencies.get(ownerStorageKey(owner));
      const binding = dependencies?.bindings.find(binding => binding.id === request.serviceId && binding.version === request.version);
      const providerId = request.providerId ?? (binding?.providerIds.length === 1 ? binding.providerIds[0] : undefined);
      if (!providerId || !binding?.providerIds.includes(providerId)) throw new Error('Host dependency is undeclared or differs from its frozen binding');
      const pin = dependencies?.pins.find(pin => pin.providerId === providerId);
      if (!pin) throw new Error('Host dependency binding is unavailable');
      const invocation = typeof params.invocationId === 'string' ? this.#invocations.get(`${ownerStorageKey(owner)}\0${params.invocationId}`) : undefined;
      if (params.invocationId !== undefined && (!invocation || !invocation.active)) throw new Error('Host dependency invocation has expired or belongs to another owner');
      const callSignal = invocation ? AbortSignal.any([signal, invocation.signal]) : signal;
      const invoke = () => pin.invoke(request.method, request.args, callSignal, invocation?.scope);
      const target = this.#services.getSnapshot().providers.find(provider => provider.providerId === pin.providerId);
      if (!target) throw new Error('Bound dependency provider is unavailable');
      return invocation?.scope?.invokeDependency ? invocation.scope.invokeDependency(owner, target, invoke) : invoke();
    }
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
    const grantOwner = this.#ownerGrants.get(ownerStorageKey(instance.owner));
    if (grantOwner) grantOwner.slot = "selected";
    const preparationKey = `${instance.owner.extensionId}\0${instance.owner.instanceKey}`;
    if (this.#preparations.get(preparationKey) === instance.preparation) this.#preparations.delete(preparationKey);
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
