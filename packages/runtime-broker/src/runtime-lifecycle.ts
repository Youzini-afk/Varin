import type {
  ExtensionUiResponse,
  HostHandshakeResult,
  PiRuntimeInstallation,
  PiRuntimeSnapshot,
  ProviderAuthResponse,
  SessionSnapshot,
  SessionSummary,
  SessionWorkspaceBinding,
  WorkFocusId,
  WorkFocusExecutionRole,
} from "@varin/protocol";
import { PiRuntimeNotReadyError } from "./errors.js";
import { resolveBundledPiHostEntry } from "./host-entry.js";
import {
  PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
  type PiRuntimeBrokerOptions,
  type PiSessionDeleteCoordinator,
  type PiSessionRunCoordinator,
  type PiSessionRunCoordinatorOptions,
  type ProjectTrustDecision,
} from "./runtime-broker.js";
import {
  PiRuntimeManager,
  type PiRuntimeManagerOptions,
} from "./runtime-manager.js";

export interface PiRuntimeBrokerFactoryOptions {
  hostEntry: string;
  nodePath?: string;
  packageRoot?: string;
  runtimeGeneration: number;
  runtimeSource?: PiRuntimeInstallation["source"];
}

export interface PiRuntimeLifecycleOptions extends Omit<PiRuntimeManagerOptions, "startRuntime"> {
  hostEntry?: string;
  createBroker: (options: PiRuntimeBrokerFactoryOptions) => PiRuntimeBroker;
}

interface BrokerGeneration {
  broker: PiRuntimeBroker;
  handshake: HostHandshakeResult;
  id: number;
  packageRoot?: string;
  unsubscribe: () => void;
}

export class PiRuntimeLifecycle {
  readonly #brokerListeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  readonly #createBroker: PiRuntimeLifecycleOptions["createBroker"];
  readonly #generations = new Map<number, BrokerGeneration>();
  readonly #hostEntry: string;
  readonly #manager: PiRuntimeManager;
  readonly #managerUnsubscribe: () => void;
  readonly #sessionGenerations = new Map<string, number>();
  readonly #snapshotListeners = new Set<(snapshot: PiRuntimeSnapshot) => void>();
  readonly #workerGenerations = new Map<string, number>();
  #currentId = 0;
  #handshake: HostHandshakeResult | undefined;
  #nextId = 1;
  #revision = 0;
  #sessionDeleteCoordinator: PiSessionDeleteCoordinator | undefined;
  #sessionRunCoordinator: PiSessionRunCoordinator | undefined;
  #sessionRunCoordinatorOptions: PiSessionRunCoordinatorOptions = {};

  constructor(options: PiRuntimeLifecycleOptions) {
    this.#createBroker = options.createBroker;
    this.#hostEntry = options.hostEntry ?? resolveBundledPiHostEntry();
    this.#manager = new PiRuntimeManager({
      dataDir: options.dataDir,
      ...(options.discover === undefined ? {} : { discover: options.discover }),
      ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
      ...(options.installer === undefined ? {} : { installer: options.installer }),
      ...(options.planInstall === undefined ? {} : { planInstall: options.planInstall }),
      startRuntime: (installation) => this.#ensureBroker(installation),
      ...(options.targetVersion === undefined ? {} : { targetVersion: options.targetVersion }),
    });
    this.#managerUnsubscribe = this.#manager.subscribe(() => {
      this.#publishSnapshot();
    });
  }

  get snapshot(): PiRuntimeSnapshot {
    const snapshot: PiRuntimeSnapshot = {
      ...this.#manager.snapshot,
      revision: this.#revision,
    };
    if (snapshot.status === "ready" && snapshot.active && !this.#currentMatches(snapshot.active)) {
      snapshot.status = "probing";
    }
    return snapshot;
  }

  get handshake(): HostHandshakeResult | undefined {
    return this.#handshake;
  }

  get currentBroker(): PiRuntimeBroker | undefined {
    return this.#generations.get(this.#currentId)?.broker;
  }

  subscribe(listener: (snapshot: PiRuntimeSnapshot) => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => {
      this.#snapshotListeners.delete(listener);
    };
  }

  subscribeBroker(listener: (event: PiRuntimeBrokerEvent) => void): () => void {
    this.#brokerListeners.add(listener);
    return () => {
      this.#brokerListeners.delete(listener);
    };
  }

  setSessionDeleteCoordinator(coordinate: PiSessionDeleteCoordinator | undefined): void {
    this.#sessionDeleteCoordinator = coordinate;
    for (const generation of this.#generations.values()) {
      generation.broker.setSessionDeleteCoordinator(coordinate);
    }
  }

  setSessionRunCoordinator(
    coordinate: PiSessionRunCoordinator | undefined,
    options: PiSessionRunCoordinatorOptions = {},
  ): void {
    this.#sessionRunCoordinator = coordinate;
    this.#sessionRunCoordinatorOptions = options;
    for (const generation of this.#generations.values()) {
      generation.broker.setSessionRunCoordinator(coordinate, options);
    }
  }

  async start(): Promise<HostHandshakeResult | undefined> {
    const snapshot = await this.#manager.start();
    return snapshot.status === "ready" ? this.#handshake : undefined;
  }

  async refresh(): Promise<PiRuntimeSnapshot> {
    await this.#manager.refresh();
    return this.snapshot;
  }

  async rediscover(): Promise<PiRuntimeSnapshot> {
    return this.refresh();
  }

  async activate(id: string): Promise<PiRuntimeSnapshot> {
    await this.#manager.activate(id);
    return this.snapshot;
  }

  async activateCustom(packageRoot: string, nodePath?: string): Promise<PiRuntimeSnapshot> {
    await this.#manager.activateCustom(packageRoot, nodePath);
    return this.snapshot;
  }

  async install(): Promise<PiRuntimeSnapshot> {
    await this.#stopGenerationsForUpdate();
    await this.#manager.install();
    return this.snapshot;
  }

  async upgrade(): Promise<PiRuntimeSnapshot> {
    await this.#stopGenerationsForUpdate();
    await this.#manager.upgrade();
    return this.snapshot;
  }

  requireBroker(): PiRuntimeBroker {
    const broker = this.currentBroker;
    if (!broker) throw new PiRuntimeNotReadyError();
    return broker;
  }

  brokerForSession(sessionId: string): PiRuntimeBroker {
    return this.#findBrokerForSession(sessionId) ?? this.requireBroker();
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    const generations = [...this.#generations.values()];
    if (generations.length === 0) return this.requireBroker().listSessions(cwd);
    const snapshots = await Promise.all(generations.map(async (generation) => ({
      activeSessionIds: new Set(generation.broker.activeSessionIds),
      summaries: await generation.broker.listSessions(cwd),
    })));
    const merged = new Map<string, { active: boolean; summary: SessionSummary }>();
    for (const snapshot of snapshots) {
      for (const summary of snapshot.summaries) {
        const active = snapshot.activeSessionIds.has(summary.id);
        const existing = merged.get(summary.id);
        if (!existing || active || !existing.active) merged.set(summary.id, { active, summary });
      }
    }
    return [...merged.values()]
      .map((entry) => entry.summary)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createSession(
    cwd: string,
    name?: string,
    parentSession?: string,
    workspace?: SessionWorkspaceBinding,
    launch?: { model?: { providerId: string; modelId: string }; scope?: string[]; tools?: string[]; workFocus?: WorkFocusId; workFocusRole?: WorkFocusExecutionRole },
  ): Promise<SessionSnapshot> {
    return this.requireBroker().createSession(cwd, name, parentSession, workspace, launch);
  }

  async openSession(input: {
    cwd?: string;
    model?: { providerId: string; modelId: string };
    sessionFile?: string;
    sessionId?: string;
    scope?: string[];
    tools?: string[];
    workFocusRole?: WorkFocusExecutionRole;
    workspace?: SessionWorkspaceBinding;
  }): Promise<SessionSnapshot> {
    const broker = input.sessionId ? this.#findBrokerForSession(input.sessionId) : undefined;
    return (broker ?? this.requireBroker()).openSession(input);
  }

  closeSession(sessionId: string): Promise<{ closed: boolean }> {
    return this.brokerForSession(sessionId).closeSession(sessionId);
  }

  forkSession(sessionId: string, entryId: string, position?: "before" | "at") {
    return this.brokerForSession(sessionId).forkSession(sessionId, entryId, position);
  }

  renameSession(sessionId: string, name: string): Promise<{ name?: string; sessionId: string }> {
    return this.brokerForSession(sessionId).renameSession(sessionId, name);
  }

  archiveSession(sessionId: string, archived: boolean): Promise<SessionSummary> {
    return this.brokerForSession(sessionId).archiveSession(sessionId, archived);
  }

  deleteSession(sessionId: string): Promise<{ deleted: boolean; sessionId: string }> {
    return this.brokerForSession(sessionId).deleteSession(sessionId);
  }

  respondToExtensionUi(sessionId: string, response: ExtensionUiResponse): Promise<boolean> {
    return this.brokerForSession(sessionId).respondToExtensionUi(sessionId, response);
  }

  respondToProviderAuth(sessionId: string, response: ProviderAuthResponse): Promise<boolean> {
    return this.brokerForSession(sessionId).respondToProviderAuth(sessionId, response);
  }

  respondToProjectTrust(
    workerId: string,
    requestId: string,
    decision: ProjectTrustDecision,
  ): Promise<boolean> {
    const generationId = this.#workerGenerations.get(workerId);
    const broker = generationId === undefined
      ? this.requireBroker()
      : this.#generations.get(generationId)?.broker ?? this.requireBroker();
    return broker.respondToProjectTrust(workerId, requestId, decision);
  }

  async ensureActiveBroker(): Promise<HostHandshakeResult> {
    if (this.#handshake) return this.#handshake;
    const snapshot = this.#manager.snapshot.status === "ready"
      ? this.#manager.snapshot
      : await this.#manager.start();
    if (snapshot.status !== "ready" || !snapshot.active) {
      throw new PiRuntimeNotReadyError(snapshot.issue ?? "Pi runtime is not ready");
    }
    return this.#ensureBroker(snapshot.active);
  }

  asBroker(): PiRuntimeBroker {
    return new Proxy(this.currentBroker ?? ({} as PiRuntimeBroker), {
      get: (_target, property) => {
        if (property === "subscribe") {
          return (listener: (event: PiRuntimeBrokerEvent) => void) => this.subscribeBroker(listener);
        }
        if (property === "dispose") {
          return () => this.dispose();
        }
        if (property === "warmup") {
          return () => this.ensureActiveBroker();
        }
        if (property === "setSessionDeleteCoordinator") {
          return (coordinate: PiSessionDeleteCoordinator | undefined) => this.setSessionDeleteCoordinator(coordinate);
        }
        if (property === "setSessionRunCoordinator") {
          return (coordinate: PiSessionRunCoordinator | undefined, options?: PiSessionRunCoordinatorOptions) => this.setSessionRunCoordinator(coordinate, options);
        }
        if (property === "requestForSession") {
          return (
            sessionId: string,
            method: Parameters<PiRuntimeBroker["requestForSession"]>[1],
            params: Parameters<PiRuntimeBroker["requestForSession"]>[2],
          ) => this.brokerForSession(sessionId).requestForSession(sessionId, method, params);
        }
        if (property === "listSessions") return this.listSessions.bind(this);
        if (property === "createSession") return this.createSession.bind(this);
        if (property === "openSession") return this.openSession.bind(this);
        if (property === "closeSession") return this.closeSession.bind(this);
        if (property === "forkSession") return this.forkSession.bind(this);
        if (property === "renameSession") return this.renameSession.bind(this);
        if (property === "archiveSession") return this.archiveSession.bind(this);
        if (property === "deleteSession") return this.deleteSession.bind(this);
        if (property === "respondToExtensionUi") return this.respondToExtensionUi.bind(this);
        if (property === "respondToProviderAuth") return this.respondToProviderAuth.bind(this);
        if (property === "respondToProjectTrust") return this.respondToProjectTrust.bind(this);
        if (property === "activeSessionIds") {
          return [...new Set([...this.#generations.values()].flatMap((entry) => entry.broker.activeSessionIds))];
        }
        if (property === "workerCount") {
          return [...this.#generations.values()].reduce((sum, entry) => sum + entry.broker.workerCount, 0);
        }
        if (property === "packageRoot") {
          return this.currentBroker?.packageRoot;
        }
        const broker = this.requireBroker();
        const value = Reflect.get(broker, property);
        return typeof value === "function" ? value.bind(broker) : value;
      },
    });
  }

  async dispose(): Promise<void> {
    this.#managerUnsubscribe();
    const generations = [...this.#generations.values()];
    this.#generations.clear();
    this.#currentId = 0;
    this.#handshake = undefined;
    this.#sessionGenerations.clear();
    this.#workerGenerations.clear();
    await Promise.all(generations.map(async (generation) => {
      generation.unsubscribe();
      await generation.broker.dispose();
    }));
    this.#snapshotListeners.clear();
  }

  async #ensureBroker(installation: PiRuntimeInstallation): Promise<HostHandshakeResult> {
    const current = this.#generations.get(this.#currentId);
    if (current && this.#generationMatches(current, installation)) {
      this.#handshake = current.handshake;
      return current.handshake;
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const broker = this.#createBroker({
      hostEntry: this.#hostEntry,
      ...(installation.nodePath === undefined ? {} : { nodePath: installation.nodePath }),
      ...(installation.packageRoot === undefined ? {} : { packageRoot: installation.packageRoot }),
      runtimeGeneration: id,
      runtimeSource: installation.source,
    });
    if (this.#sessionDeleteCoordinator !== undefined) {
      broker.setSessionDeleteCoordinator(this.#sessionDeleteCoordinator);
    }
    if (this.#sessionRunCoordinator !== undefined) {
      broker.setSessionRunCoordinator(this.#sessionRunCoordinator, this.#sessionRunCoordinatorOptions);
    }
    let handshake: HostHandshakeResult;
    try {
      handshake = await broker.warmup();
    } catch (error) {
      await broker.dispose().catch(() => {});
      throw error;
    }
    const unsubscribe = broker.subscribe((event) => {
      this.#workerGenerations.set(event.workerId, id);
      const eventSessionId = "sessionId" in event ? event.sessionId : undefined;
      if (event.role === "session" && eventSessionId) {
        this.#sessionGenerations.set(eventSessionId, id);
      }
      for (const listener of this.#brokerListeners) listener(event);
      if (event.kind === "worker.exit") {
        this.#workerGenerations.delete(event.workerId);
        if (event.role === "session" && eventSessionId) {
          this.#sessionGenerations.delete(eventSessionId);
        }
      }
      if (event.kind === "worker.exit" && event.role === "session") {
        void this.#retireIdleGeneration(id);
      }
    });
    this.#generations.set(id, {
      broker,
      handshake,
      id,
      ...(handshake.runtime.packageRoot === undefined ? {} : { packageRoot: handshake.runtime.packageRoot }),
      unsubscribe,
    });
    this.#currentId = id;
    this.#handshake = handshake;
    this.#publishSnapshot();
    return handshake;
  }

  async #stopGenerationsForUpdate(): Promise<void> {
    const target = this.#manager.snapshot.installations.find(
      (entry) => entry.id === "system" || entry.id === "standalone",
    );
    const packageRoot = target?.packageRoot ?? this.currentBroker?.packageRoot;
    const doomed = [...this.#generations.values()].filter((generation) => (
      !packageRoot || generation.packageRoot === packageRoot
    ));
    for (const generation of doomed) {
      generation.unsubscribe();
      await generation.broker.dispose();
      this.#generations.delete(generation.id);
      if (this.#currentId === generation.id) {
        this.#currentId = 0;
        this.#handshake = undefined;
      }
      for (const [workerId, generationId] of this.#workerGenerations) {
        if (generationId === generation.id) this.#workerGenerations.delete(workerId);
      }
      for (const [sessionId, generationId] of this.#sessionGenerations) {
        if (generationId === generation.id) this.#sessionGenerations.delete(sessionId);
      }
    }
    if (doomed.length > 0) this.#publishSnapshot();
  }

  async #retireIdleGeneration(id: number): Promise<void> {
    if (id === this.#currentId) return;
    const generation = this.#generations.get(id);
    if (!generation || generation.broker.activeSessionIds.length > 0) return;
    generation.unsubscribe();
    await generation.broker.dispose();
    this.#generations.delete(id);
    for (const [workerId, generationId] of this.#workerGenerations) {
      if (generationId === id) this.#workerGenerations.delete(workerId);
    }
    for (const [sessionId, generationId] of this.#sessionGenerations) {
      if (generationId === id) this.#sessionGenerations.delete(sessionId);
    }
  }

  #findBrokerForSession(sessionId: string): PiRuntimeBroker | undefined {
    const mappedGenerationId = this.#sessionGenerations.get(sessionId);
    if (mappedGenerationId !== undefined) {
      const mapped = this.#generations.get(mappedGenerationId)?.broker;
      if (mapped) return mapped;
      this.#sessionGenerations.delete(sessionId);
    }
    for (const generation of this.#generations.values()) {
      if (generation.broker.activeSessionIds.includes(sessionId)) {
        this.#sessionGenerations.set(sessionId, generation.id);
        return generation.broker;
      }
    }
    return undefined;
  }

  #currentMatches(installation: PiRuntimeInstallation): boolean {
    const current = this.#generations.get(this.#currentId);
    return current !== undefined && this.#generationMatches(current, installation);
  }

  #generationMatches(
    generation: BrokerGeneration,
    installation: PiRuntimeInstallation,
  ): boolean {
    const runtimeSource = installation.source === "development" ? "source" : installation.source;
    return generation.packageRoot === installation.packageRoot
      && generation.handshake.runtime.nodePath === installation.nodePath
      && generation.handshake.runtime.piVersion === installation.version
      && generation.handshake.runtime.source === runtimeSource;
  }

  #publishSnapshot(): void {
    this.#revision += 1;
    const snapshot = this.snapshot;
    for (const listener of this.#snapshotListeners) listener(snapshot);
  }
}

export type { PiRuntimeBrokerOptions };
