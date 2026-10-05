import { randomUUID } from "node:crypto";
import { lstat, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CompactionRunResult,
  CompactionTaskSpec,
  EventEnvelope,
  ExtensionUiResponse,
  HarnessActorIdentity,
  HostHandshakeParams,
  HostHandshakeResult,
  HostMethod,
  HostMethodParams,
  HostMethodResult,
  ProviderAuthResponse,
  ProjectTrustRequest,
  PiConfigWatchSubscription,
  PiConfigWatchTarget,
  RuntimeContextTarget,
  RuntimeMethod,
  RuntimeSourceKind,
  RuntimeWorkerRole,
  PermissionPolicy,
  SessionSnapshot,
  SessionSummary,
  SessionWorkspaceBinding,
  SessionWorkFocusSnapshot,
  WorkFocusId,
  WorkFocusSelection,
} from "@varin/protocol";
import {
  findFoundationalPackageBySource,
  FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
  matchesFoundationalPackage,
  isRuntimeMethod,
  productDefaultWorkFocus,
  type FoundationalPiPackageId,
  type FoundationalPiPackageManifestEntry,
  type FoundationalPiPackageStatusSnapshot,
  type PackageDescriptor,
} from "@varin/protocol";
import { PiHostClient, type PiHostExit } from "./host-client.js";
import { PiRuntimeBrokerError } from "./errors.js";
import { SessionMetadataStore } from "./session-metadata-store.js";
import {
  createPackageProvisioningReceiptStore,
  type PackageProvisioningReceiptDocument,
  type PackageProvisioningReceiptEntry,
  type PackageProvisioningReceiptStore,
} from "./package-provisioning-receipt-store.js";
import { reconcileFoundationalPackages } from "./foundational-package-provisioner.js";

export interface ProjectTrustDecision {
  remember: boolean;
  trusted: boolean;
}

interface PendingProjectTrust {
  client: PiHostClient;
}

interface WorkspaceWorkerContext {
  client: PiHostClient;
  cwd: string;
  ready: Promise<{ client: PiHostClient; sessionId: string }>;
}

export interface PiSessionExecutionAdmissionRequest {
  cwd: string;
  executionId: string;
  method?: HostMethod;
  phase: "agent-run" | "worker-start" | "workspace-mutation";
  runtimeGeneration: number;
  sessionId?: string;
  workspace?: SessionWorkspaceBinding;
  workerId: string;
}

export interface PiSessionExecutionLease {
  close(): Promise<void> | void;
  /** Recheck dynamic owner state even when a running turn reuses this lease. */
  assertCanExecute?(): Promise<void>;
}

export type PiSessionExecutionAdmission = (
  request: PiSessionExecutionAdmissionRequest,
) => Promise<PiSessionExecutionLease | null | undefined>;

export type PiSessionDeleteCoordinator = (request: {
  sessionId: string;
  summary: SessionSummary;
}) => Promise<void>;

export type PiSessionRunCoordinator = (request: {
  sessionId: string;
  snapshot: SessionSnapshot;
  summary: SessionSummary;
}) => Promise<{ workspace?: SessionWorkspaceBinding } | void>;

export type PiQuestionContinuation = (sessionId: string, reply: { messageId: string; text: string }) => Promise<boolean>;

export interface PiSessionRunCoordinatorOptions {
  /** Skip coordinator reads for work focuses that have no pre-run binding work. */
  appliesToWorkFocus?: readonly WorkFocusId[];
}

interface SessionExecutionAdmissionState {
  awaitsAgentSettlement: boolean;
  client: PiHostClient;
  closing: boolean;
  closePromise?: Promise<void>;
  done: Promise<void>;
  executionId: string;
  holders: number;
  lease?: PiSessionExecutionLease | null;
  phase: PiSessionExecutionAdmissionRequest["phase"];
  ready: Promise<void>;
  resolveDone(): void;
  running: boolean;
}

type PiRuntimeBrokerEventPayload =
  | {
      kind: "diagnostic";
      level: "error" | "info";
      message: string;
      role: RuntimeWorkerRole;
      workerId: string;
    }
  | {
      actor?: HarnessActorIdentity;
      envelope: EventEnvelope;
      kind: "host";
      role: RuntimeWorkerRole;
      sessionId?: string;
      workerId: string;
    }
  | {
      actor?: HarnessActorIdentity;
      code: number | null;
      expected: boolean;
      kind: "worker.exit";
      role: RuntimeWorkerRole;
      sequence: number;
      sessionId?: string;
      signal: NodeJS.Signals | null;
      workerId: string;
    };

export type PiRuntimeBrokerEvent = PiRuntimeBrokerEventPayload & {
  executionId?: string;
  runtimeGeneration: number;
};

type WorkerEventIdentityDecision = "accept" | "ignore-unbound-snapshot" | "ignore-transition-snapshot" | "reject";

const claimedEventSessionId = (envelope: EventEnvelope): string | undefined => {
  const data = envelope.data as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const sessionId = (data as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
};

/**
 * Session/workspace worker events may describe state for their pinned session,
 * but they never choose that identity. Initial snapshots can arrive before the
 * create/open response and fork snapshots can arrive while a broker-issued
 * transition is pending; the client defers both until the response pins the worker.
 */
export const classifyWorkerEventIdentity = ({
  envelope,
  pinnedSessionId,
  role,
  transitioning,
}: {
  envelope: EventEnvelope;
  pinnedSessionId: string | undefined;
  role: RuntimeWorkerRole;
  transitioning: boolean;
}): WorkerEventIdentityDecision => {
  if (role !== "session" && role !== "workspace") return "accept";
  const claimedSessionId = claimedEventSessionId(envelope);
  if (pinnedSessionId === undefined) {
    if (envelope.event === "session.snapshot") return "ignore-unbound-snapshot";
    return envelope.event === "harness.request" ? "reject" : "accept";
  }
  if (claimedSessionId === undefined) return "accept";
  if (claimedSessionId === pinnedSessionId) return "accept";
  if (transitioning && envelope.event === "session.snapshot") {
    return "ignore-transition-snapshot";
  }
  return "reject";
};

export interface PiRuntimeBrokerOptions {
  agentDir?: string;
  authorityInstanceId?: string;
  client: Omit<HostHandshakeParams, "protocolVersions">;
  cwd?: string;
  emit?(event: PiRuntimeBrokerEvent): void;
  environment?: NodeJS.ProcessEnv;
  execArgv?: string[];
  foundationalPackages?: readonly FoundationalPiPackageManifestEntry[];
  hostEntry: string;
  nodePath?: string;
  packageRoot?: string;
  projectTrustOverride?: boolean;
  runtimeGeneration?: number;
  runtimeSource?: RuntimeSourceKind;
  admitSessionExecution?: PiSessionExecutionAdmission;
  shutdownTimeoutMs?: number;
  promptForProjectTrust?(request: ProjectTrustRequest): Promise<ProjectTrustDecision>;
  resolveProjectWorkFocus?(input: {
    cwd: string;
    workspace?: SessionWorkspaceBinding;
  }): Promise<WorkFocusId | undefined> | WorkFocusId | undefined;
}

export const PI_CATALOG_METHODS = [
  "session.systemPrompt",
  "agentProvider.action",
  "agentProvider.list",
  "config.document.get",
  "config.document.update",
  "config.text.authority.get",
  "config.text.authority.update",
  "config.text.get",
  "config.text.update",
  "config.watch",
  "model.list",
  "mcp.config.snapshot",
  "package.install",
  "package.list",
  "package.remove",
  "package.setEnabled",
  "package.update",
  "provider.list",
  "provider.config.delete",
  "provider.config.get",
  "provider.config.upsert",
  "provider.models.discover",
  "provider.auth.cancel",
  "provider.login",
  "provider.logout",
  "resource.copy",
  "resource.create",
  "resource.delete",
  "resource.get",
  "resource.list",
  "resource.update",
  "session.rename",
  "session.list",
  "settings.get",
  "settings.update",
  "harness.embed",
  "harness.rerank",
  "harness.inference.describe",
  "harness.inference.cancel",
] as const;

export type PiCatalogMethod = (typeof PI_CATALOG_METHODS)[number];
const PI_CATALOG_METHOD_SET = new Set<string>(PI_CATALOG_METHODS);

export const isPiCatalogMethod = (value: unknown): value is PiCatalogMethod => (
  typeof value === "string" && PI_CATALOG_METHOD_SET.has(value)
);

type SessionDynamicMethod = Extract<RuntimeMethod, HostMethod>;
const BROKER_ONLY_RUNTIME_METHODS: Record<Exclude<RuntimeMethod, HostMethod>, true> = {
  "package.foundation.restore": true,
  "package.foundation.setAutoInstallNew": true,
  "package.foundation.status": true,
  "session.archive": true,
  "session.delete": true,
  "session.entries.preview": true,
  "session.unarchive": true,
  "session.workFocus.set": true,
};

const isSessionDynamicMethod = (value: unknown): value is SessionDynamicMethod => (
  isRuntimeMethod(value) && !(value in BROKER_ONLY_RUNTIME_METHODS)
);

export type PiPackageMutationMethod =
  | "package.install"
  | "package.remove"
  | "package.setEnabled"
  | "package.update"
  | "settings.update";

const PACKAGE_MUTATION_METHODS = new Set<HostMethod>([
  "package.install",
  "package.remove",
  "package.setEnabled",
  "package.update",
  "settings.update",
]);

const AGENT_RUN_METHODS = new Set<HostMethod>([
  "agent.compact",
  "agent.compact.apply",
  "agent.followUp",
  "agent.prompt",
  "agent.threadRequest",
  "agent.steer",
  "command.execute",
]);

// These Host methods acknowledge queue admission before Pi emits agent_start.
// Their execution identity must remain attached until agent_settled.
const DEFERRED_AGENT_SETTLEMENT_METHODS = new Set<HostMethod>([
  "agent.queue.update",
  "agent.followUp",
  "agent.prompt",
  "agent.threadRequest",
  "agent.steer",
]);

const ALWAYS_WORKSPACE_MUTATION_METHODS = new Set<HostMethod>([
  "recovery.checkpoint.create",
  "recovery.navigate",
  "recovery.repair",
  "recovery.redo",
  "recovery.undo",
  "resource.delete",
  "resource.update",
]);

const requiresWorkspaceAdmission = (method: HostMethod, params: unknown): boolean => {
  if (AGENT_RUN_METHODS.has(method) || ALWAYS_WORKSPACE_MUTATION_METHODS.has(method)) return true;
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  if (method === "config.document.update" || method === "settings.update") {
    return record.scope === "project";
  }
  if (method === "config.text.update") return record.root === "project";
  if (method === "config.text.authority.update") return record.authority === "pi-lens-project";
  if (method === "provider.config.delete" || method === "provider.config.upsert") {
    return record.scope === "project";
  }
  if (method === "package.update") return true;
  if (method === "package.install" || method === "package.remove" || method === "package.setEnabled") {
    return record.scope === "project";
  }
  if (method === "resource.copy" || method === "resource.create") return record.scope === "project";
  return false;
};

export class PiRuntimeBroker {
  readonly #authorityInstanceId: string;
  readonly #clients = new Set<PiHostClient>();
  readonly #configWatches = new Map<string, PiHostClient>();
  readonly #listeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  readonly #options: PiRuntimeBrokerOptions;
  readonly #sessions = new Map<string, PiHostClient>();
  /** Auxiliary workers (compaction) pinned to a session; killed with it. */
  readonly #sessionAuxiliaries = new Map<string, Set<PiHostClient>>();
  readonly #sessionWorkspaceScopes = new Map<string, readonly string[]>();
  readonly #knownSummaries = new Map<string, SessionSummary>();
  readonly #pendingWorkspaceBindings = new Map<string, SessionWorkspaceBinding>();
  readonly #workFocusTails = new Map<string, Promise<void>>();
  readonly #pendingProjectTrust = new Map<string, PendingProjectTrust>();
  readonly #runtimeGeneration: number;
  readonly #sessionExecutionAdmissions = new Map<PiHostClient, SessionExecutionAdmissionState>();
  readonly #workerCwds = new Map<PiHostClient, string>();
  readonly #foundationalPackages: readonly FoundationalPiPackageManifestEntry[];
  readonly #workspaceContexts = new Map<string, WorkspaceWorkerContext>();
  readonly #workspaceSessions = new Map<string, PiHostClient>();
  #catalog: PiHostClient | undefined;
  #catalogPromise: Promise<PiHostClient> | undefined;
  #disposed = false;
  #foundationalBootstrapStarted = false;
  #foundationalStatus: FoundationalPiPackageStatusSnapshot;
  #foundationalTail: Promise<void> = Promise.resolve();
  #metadata: SessionMetadataStore | undefined;
  #packageMutationTail: Promise<void> = Promise.resolve();
  #receiptPromise: Promise<PackageProvisioningReceiptStore> | undefined;
  #sessionExecutionAdmission: PiSessionExecutionAdmission | undefined;
  #sessionDeleteCoordinator: PiSessionDeleteCoordinator | undefined;
  #sessionRunCoordinator: PiSessionRunCoordinator | undefined;
  #sessionRunCoordinatorFocuses: ReadonlySet<WorkFocusId> | undefined;
  #questionContinuation: PiQuestionContinuation | undefined;

  constructor(options: PiRuntimeBrokerOptions) {
    this.#options = options;
    this.#authorityInstanceId = options.authorityInstanceId?.trim() || randomUUID();
    this.#runtimeGeneration = options.runtimeGeneration ?? 1;
    if (!Number.isSafeInteger(this.#runtimeGeneration) || this.#runtimeGeneration < 1) {
      throw new TypeError("Pi runtime generation must be a positive safe integer");
    }
    this.#sessionExecutionAdmission = options.admitSessionExecution;
    this.#foundationalPackages = [...(options.foundationalPackages ?? [])];
    this.#foundationalStatus = {
      autoInstallNew: true,
      entries: this.#foundationalPackages.map((entry) => ({
        id: entry.id,
        intent: "eligible",
        observed: "missing",
        operation: "idle",
        provenance: "none",
        source: entry.source,
      })),
      manifestRevision: FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
      revision: 0,
      state: "idle",
    };
    if (options.emit) this.#listeners.add(options.emit);
  }

  get activeSessionIds(): string[] {
    return [...this.#sessions.keys()];
  }

  get catalogStarted(): boolean {
    return this.#catalog !== undefined;
  }

  get workerCount(): number {
    return this.#clients.size;
  }

  get packageRoot(): string | undefined {
    return this.#options.packageRoot;
  }

  subscribe(listener: (event: PiRuntimeBrokerEvent) => void): () => void {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setSessionExecutionAdmission(admit: PiSessionExecutionAdmission): void {
    if (typeof admit !== "function") {
      throw new TypeError("Pi session execution admission must be a function");
    }
    this.#sessionExecutionAdmission = admit;
  }

  setSessionDeleteCoordinator(coordinate: PiSessionDeleteCoordinator | undefined): void {
    if (coordinate !== undefined && typeof coordinate !== "function") {
      throw new TypeError("Pi session delete coordinator must be a function");
    }
    this.#sessionDeleteCoordinator = coordinate;
  }

  setSessionRunCoordinator(
    coordinate: PiSessionRunCoordinator | undefined,
    options: PiSessionRunCoordinatorOptions = {},
  ): void {
    if (coordinate !== undefined && typeof coordinate !== "function") {
      throw new TypeError("Pi session run coordinator must be a function");
    }
    this.#sessionRunCoordinator = coordinate;
    this.#sessionRunCoordinatorFocuses = options.appliesToWorkFocus === undefined
      ? undefined : new Set(options.appliesToWorkFocus);
  }

  async warmup(): Promise<HostHandshakeResult> {
    const worker = await this.#getCatalog();
    this.#startFoundationalBootstrap();
    return worker.handshake;
  }

  setQuestionContinuation(coordinate: PiQuestionContinuation | undefined): void {
    this.#questionContinuation = coordinate;
  }

  foundationalPackageStatus(): FoundationalPiPackageStatusSnapshot {
    return structuredClone(this.#foundationalStatus);
  }

  async restoreFoundationalPackages(
    ids?: readonly FoundationalPiPackageId[],
  ): Promise<FoundationalPiPackageStatusSnapshot> {
    await this.#ensureFoundationalBootstrap();
    const selected = new Set(ids ?? this.#foundationalPackages.map((entry) => entry.id));
    await this.#enqueueFoundationalReconcile({ restoreIds: selected });
    return this.foundationalPackageStatus();
  }

  async setAutoInstallNewFoundationalPackages(
    enabled: boolean,
  ): Promise<FoundationalPiPackageStatusSnapshot> {
    await this.#ensureFoundationalBootstrap();
    await this.#enqueueFoundationalReconcile({ setAutoInstallNew: enabled });
    return this.foundationalPackageStatus();
  }

  async requestCatalog<M extends PiCatalogMethod>(
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    if (PACKAGE_MUTATION_METHODS.has(method)) {
      return this.mutatePackage(
        { cwd: resolve(this.#options.cwd ?? process.cwd()) },
        method as PiPackageMutationMethod,
        params as HostMethodParams<PiPackageMutationMethod>,
      ) as Promise<HostMethodResult<M>>;
    }
    const worker = await this.#getCatalog();
    return worker.request(method, params);
  }

  async requestCatalogDynamic(method: unknown, params: unknown): Promise<unknown> {
    if (!isPiCatalogMethod(method)) {
      throw new PiRuntimeBrokerError(
        "unsupported_method",
        `Unsupported catalog method: ${String(method)}`,
        { retryable: false },
      );
    }
    return this.requestCatalog(method, params as HostMethodParams<typeof method>);
  }

  async requestForWorkspace<M extends Exclude<PiCatalogMethod, "session.list">>(
    cwd: string,
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    if (method === "package.list") {
      return this.#withPackageAuthority(
        (worker) => worker.request(method, params),
        cwd,
      );
    }
    if (PACKAGE_MUTATION_METHODS.has(method)) {
      return this.mutatePackage(
        { cwd },
        method as PiPackageMutationMethod,
        params as HostMethodParams<PiPackageMutationMethod>,
      ) as Promise<HostMethodResult<M>>;
    }
    const normalizedCwd = resolve(cwd);
    const context = await this.#getWorkspaceContext(normalizedCwd);
    if (!requiresWorkspaceAdmission(method, params)) return context.client.request(method, params);
    return this.#requestWithExecutionAdmission(
      context.client,
      normalizedCwd,
      context.sessionId,
      method,
      params,
      "workspace-mutation",
    );
  }

  async requestForWorkspaceDynamic(cwd: string, method: unknown, params: unknown): Promise<unknown> {
    if (!isPiCatalogMethod(method) || method === "session.list") {
      throw new PiRuntimeBrokerError(
        "unsupported_method",
        `Unsupported workspace method: ${String(method)}`,
        { retryable: false },
      );
    }
    return this.requestForWorkspace(cwd, method, params as HostMethodParams<typeof method>);
  }

  async listCommandsForWorkspace(cwd: string): Promise<HostMethodResult<"command.list">> {
    const context = await this.#getWorkspaceContext(cwd);
    return context.client.request("command.list", { sessionId: context.sessionId });
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    const worker = await this.#getCatalog();
    const catalogSummaries = await worker.request(
      "session.list",
      cwd === undefined ? {} : { cwd },
    );
    for (const summary of catalogSummaries) this.#knownSummaries.set(summary.id, summary);
    const catalogIds = new Set(catalogSummaries.map((summary) => summary.id));
    const cwdKey = cwd === undefined ? undefined : this.#pathKey(cwd);
    for (const [sessionId, summary] of this.#knownSummaries) {
      if (this.#sessions.has(sessionId) || !summary.persisted) continue;
      if (cwdKey !== undefined && this.#pathKey(summary.cwd) !== cwdKey) continue;
      if (!catalogIds.has(sessionId)) this.#knownSummaries.delete(sessionId);
    }
    const activeSummaries = await Promise.allSettled(
      [...this.#sessions].map(([sessionId, sessionWorker]) =>
        sessionWorker.request("session.summary", { sessionId }),
      ),
    );
    for (const result of activeSummaries) {
      if (result.status === "fulfilled") this.#knownSummaries.set(result.value.id, result.value);
    }
    const merged = [...this.#knownSummaries.values()]
      .filter((summary) => cwdKey === undefined || this.#pathKey(summary.cwd) === cwdKey)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const idsByPath = new Map(merged.map((summary) => [this.#pathKey(summary.sessionFile), summary.id]));
    const linked = merged.map((summary): SessionSummary => {
      if (!summary.parentSessionPath) return summary;
      const parentId = idsByPath.get(this.#pathKey(summary.parentSessionPath));
      const linkedSummary = { ...summary };
      if (parentId === undefined) delete linkedSummary.parentId;
      else linkedSummary.parentId = parentId;
      return linkedSummary;
    });
    const metadata = await this.#metadataFor(worker);
    try {
      await this.#retryPendingWorkspaceBindings(metadata);
      return (await metadata.enrich(linked)).map((summary) => this.#overlayPendingWorkspace(summary));
    } catch (error) {
      this.#emit({
        kind: "diagnostic",
        level: "error",
        message: `Failed to read Varin session metadata: ${error instanceof Error ? error.message : String(error)}`,
        role: "catalog",
        workerId: worker.id,
      });
      return linked.map((summary) => this.#overlayPendingWorkspace(summary));
    }
  }

  async createSession(
    cwd: string,
    name?: string,
    parentSession?: string,
    workspace?: SessionWorkspaceBinding,
    launch?: {
      modelSettings?: import("@varin/protocol").HarnessAgentModelSettings | null;
      model?: { providerId: string; modelId: string };
      permissions?: PermissionPolicy;
      scope?: string[];
      tools?: string[];
      workFocus?: WorkFocusId;
    },
  ): Promise<SessionSnapshot> {
    await this.#ensureFoundationalBootstrap();
    const normalizedCwd = resolve(cwd);
    const workFocus = await this.#resolveInitialWorkFocus(
      normalizedCwd,
      workspace,
      launch?.workFocus,
    );
    const worker = await this.#spawnWorker(normalizedCwd);
    try {
      const snapshot = await worker.request("session.create", {
        cwd: normalizedCwd,
        ...(name === undefined ? {} : { name }),
        ...(parentSession === undefined ? {} : { parentSession }),
        ...(launch?.model === undefined ? {} : { model: { ...launch.model } }),
        ...(launch?.modelSettings === undefined ? {} : { modelSettings: launch.modelSettings }),
        ...(launch?.permissions === undefined ? {} : { permissions: launch.permissions }),
        ...(launch?.tools === undefined ? {} : { tools: [...launch.tools] }),
        workFocus,
        workFocusGeneration: 1,
      });
      this.#bindSession(worker, snapshot.sessionId);
      await (await this.#metadataFor(worker)).ensureWorkFocus(snapshot.sessionId, workFocus);
      if (launch?.scope?.length) this.#sessionWorkspaceScopes.set(snapshot.sessionId, [...launch.scope]);
      if (workspace !== undefined) {
        await this.#persistWorkspaceBinding(
          await this.#metadataFor(worker),
          snapshot.sessionId,
          workspace,
          worker,
          "Failed to persist session workspace binding",
        );
      }
      const enriched = await this.#enrichSnapshot(worker, snapshot);
      worker.flushDeferredSessionSnapshots();
      return enriched;
    } catch (error) {
      await this.#removeWorker(worker);
      throw error;
    } finally {
      const admission = this.#sessionExecutionAdmissions.get(worker);
      if (admission?.phase === "worker-start") {
        await this.#finishSessionExecutionAdmission(admission);
      }
    }
  }

  async openSession(input: {
    modelSettings?: import("@varin/protocol").HarnessAgentModelSettings | null;
    cwd?: string;
    model?: { providerId: string; modelId: string };
    permissions?: PermissionPolicy;
    sessionFile?: string;
    sessionId?: string;
    scope?: string[];
    tools?: string[];
    workspace?: SessionWorkspaceBinding;
  }): Promise<SessionSnapshot> {
    if (input.sessionId) {
      const existing = this.#sessions.get(input.sessionId);
      if (existing) {
        const snapshot = await existing.request("session.snapshot", { sessionId: input.sessionId });
        if (input.scope?.length) this.#sessionWorkspaceScopes.set(snapshot.sessionId, [...input.scope]);
        if (input.workspace !== undefined) {
          await this.#persistWorkspaceBinding(
            await this.#metadataFor(existing),
            snapshot.sessionId,
            input.workspace,
            existing,
            "Failed to update session workspace binding",
          );
        }
        return this.#enrichSnapshot(existing, snapshot);
      }
    }

    await this.#ensureFoundationalBootstrap();

    const explicitCwd = input.cwd === undefined ? undefined : resolve(input.cwd);
    const explicitSessionFile = input.sessionFile === undefined
      ? undefined
      : resolve(this.#options.cwd ?? process.cwd(), input.sessionFile);
    const normalizedInput = {
      ...(explicitSessionFile === undefined ? {} : { sessionFile: explicitSessionFile }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.model === undefined ? {} : { model: { ...input.model } }),
      ...(input.scope === undefined ? {} : { scope: [...input.scope] }),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    };
    let known = this.#knownSummaryForOpen(normalizedInput);
    if (
      explicitCwd === undefined
      && explicitSessionFile === undefined
      && input.sessionId !== undefined
      && known === undefined
    ) {
      await this.listSessions();
      known = this.#knownSummaryForOpen(normalizedInput);
    }

    let sessionFile = explicitSessionFile ?? known?.sessionFile;
    let workerCwd = explicitCwd;
    if (workerCwd === undefined && sessionFile !== undefined) {
      const resolvedSession = await (await this.#getCatalog()).request("session.resolve", {
        sessionFile,
      });
      workerCwd = resolve(resolvedSession.cwd);
      sessionFile = resolvedSession.sessionFile;
    }
    if (workerCwd === undefined) {
      throw new PiRuntimeBrokerError(
        "session_not_found",
        input.sessionId
          ? `Unknown Pi session: ${input.sessionId}`
          : "A session file or known session ID is required",
      );
    }

    const openInput: HostMethodParams<"session.open"> = {
      cwd: workerCwd,
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.model === undefined ? {} : { model: { ...input.model } }),
      ...(input.modelSettings === undefined ? {} : { modelSettings: input.modelSettings }),
      ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    };
    const opened = await this.#openUnboundSessionWorker(workerCwd, openInput);
    try {
      const metadata = await this.#metadataFor(opened.worker);
      const workFocus = await metadata.getWorkFocus(opened.snapshot.sessionId);
      await opened.worker.request("session.workFocus.apply", {
        generation: workFocus.active.generation,
        sessionId: opened.snapshot.sessionId,
        selection: workFocus.active,
      });
      this.#bindSession(opened.worker, opened.snapshot.sessionId);
      if (input.scope?.length) this.#sessionWorkspaceScopes.set(opened.snapshot.sessionId, [...input.scope]);
      if (input.workspace !== undefined) {
        await this.#persistWorkspaceBinding(
          await this.#metadataFor(opened.worker),
          opened.snapshot.sessionId,
          input.workspace,
          opened.worker,
          "Failed to update session workspace binding",
        );
      }
      const enriched = await this.#enrichSnapshot(opened.worker, opened.snapshot);
      opened.worker.flushDeferredSessionSnapshots();
      return enriched;
    } catch (error) {
      await this.#removeWorker(opened.worker);
      throw error;
    } finally {
      const admission = this.#sessionExecutionAdmissions.get(opened.worker);
      if (admission?.phase === "worker-start") {
        await this.#finishSessionExecutionAdmission(admission);
      }
    }
  }

  async closeSession(sessionId: string): Promise<{ closed: boolean }> {
    const worker = this.#workerForSession(sessionId);
    const summary = await this.#rememberSummary(worker, sessionId);
    const result = await worker.request("session.close", { sessionId });
    await this.#removeWorker(worker);
    if (!summary.persisted) this.#knownSummaries.delete(sessionId);
    return result;
  }

  /**
   * Address one specific worker process rather than the session's registered
   * worker. Internal auxiliary workers (a session's compaction worker) are
   * pinned to a session for event identity but never occupy #sessions.
   */
  requestForWorker<M extends HostMethod>(
    workerId: string,
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    if ((method as HostMethod) === "package.bootstrap") {
      throw new PiRuntimeBrokerError(
        "unsupported_method",
        "package.bootstrap is private to the broker provisioner",
      );
    }
    for (const client of this.#clients) {
      if (client.id === workerId) return client.request(method, params);
    }
    throw new PiRuntimeBrokerError("worker_not_found", `Pi worker is not active: ${workerId}`);
  }

  /**
   * D-314: run one frozen internal compaction task in a dedicated worker
   * subprocess. The worker is pinned to the owning session for event identity
   * (its harness.request queries carry the session actor fields) but is never
   * registered as a session worker — it cannot serve session methods and its
   * queries do not queue behind the parent session's request pipeline.
   * Cancellation kills the process; a late response cannot resurrect the task.
   */
  async runCompactionTask(
    sessionId: string,
    spec: CompactionTaskSpec,
    options: {
      signal?: AbortSignal;
      registerWorker?: (workerId: string) => void | Promise<void>;
      dropWorker?: (workerId: string) => void | Promise<void>;
    } = {},
  ): Promise<CompactionRunResult> {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    options.signal?.throwIfAborted();
    const parent = this.#workerForSession(sessionId);
    const cwd = this.#workerCwds.get(parent) ?? this.#options.cwd ?? parent.handshake.runtime.agentDir;
    const worker = await this.#spawnAuxiliaryWorker("compaction", cwd);
    worker.pinSession(sessionId);
    let auxiliaries = this.#sessionAuxiliaries.get(sessionId);
    if (!auxiliaries) {
      auxiliaries = new Set();
      this.#sessionAuxiliaries.set(sessionId, auxiliaries);
    }
    auxiliaries.add(worker);
    let dropping: Promise<void> | undefined;
    const drop = (): Promise<void> => dropping ??= (async () => {
      const owned = this.#sessionAuxiliaries.get(sessionId);
      owned?.delete(worker);
      if (owned?.size === 0) this.#sessionAuxiliaries.delete(sessionId);
      try {
        await options.dropWorker?.(worker.id);
      } finally {
        await this.#removeWorker(worker);
      }
    })();
    const assertOwner = (): void => {
      options.signal?.throwIfAborted();
      if (this.#disposed || parent.disposing || !this.#clients.has(parent)
        || !this.#clients.has(worker)
        || (this.#sessions.get(sessionId) ?? this.#workspaceSessions.get(sessionId)) !== parent) {
        throw new PiRuntimeBrokerError("session_context_unavailable", "The compaction owner exited or changed during worker startup");
      }
    };
    const onAbort = (): void => {
      void drop().catch((error) => {
        this.#emit({
          kind: "diagnostic",
          level: "error",
          message: `Failed to retire cancelled Pi compaction worker: ${error instanceof Error ? error.message : String(error)}`,
          role: "compaction",
          workerId: worker.id,
        });
      });
    };
    try {
      assertOwner();
      await options.registerWorker?.(worker.id);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      assertOwner();
      return await worker.request("compaction.run", spec);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      await drop();
    }
  }

  requestForSession<M extends HostMethod>(
    sessionId: string,
    method: M extends "package.bootstrap" ? never : M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    if ((method as HostMethod) === "package.bootstrap") {
      throw new PiRuntimeBrokerError(
        "unsupported_method",
        "package.bootstrap is private to the broker provisioner",
      );
    }
    if (PACKAGE_MUTATION_METHODS.has(method)) {
      return this.mutatePackage(
        { sessionId },
        method as PiPackageMutationMethod,
        params as HostMethodParams<PiPackageMutationMethod>,
      ) as Promise<HostMethodResult<M>>;
    }
    const worker = this.#workerForSession(sessionId);
    if ((method as HostMethod) === "agent.threadRequest") {
      return worker.request("session.snapshot", { sessionId }).then(snapshot => snapshot.busy
        ? this.#withWorkFocusBoundary(sessionId, async () => {
          const cwd = this.#workerCwds.get(worker);
          if (!cwd) throw new PiRuntimeBrokerError("session_context_unavailable", "Session execution directory is unavailable");
          return this.#requestWithExecutionAdmission(worker, cwd, sessionId, "agent.threadRequest", params as HostMethodParams<"agent.threadRequest">, "agent-run");
        })
        : this.#promptWithSelectedWorkFocus(worker, sessionId, params as HostMethodParams<"agent.threadRequest">, "agent.threadRequest")) as Promise<HostMethodResult<M>>;
    }
    if ((method as HostMethod) === "agent.prompt") {
      return this.#promptWithSelectedWorkFocus(
        worker,
        sessionId,
        params as HostMethodParams<"agent.prompt">,
      ) as Promise<HostMethodResult<M>>;
    }
    if ((method as HostMethod) === "agent.steer" || (method as HostMethod) === "agent.followUp"
      || ((method as HostMethod) === "agent.queue.update"
        && (params as HostMethodParams<"agent.queue.update">).action === "steer")) {
      return this.#withWorkFocusBoundary(sessionId, async () => {
        const cwd = this.#workerCwds.get(worker);
        if (!cwd) {
          throw new PiRuntimeBrokerError(
            "session_context_unavailable",
            `Workspace context is unavailable for Pi session: ${sessionId}`,
          );
        }
        return this.#requestWithExecutionAdmission(
          worker,
          cwd,
          sessionId,
          method,
          params,
          "agent-run",
        );
      }) as Promise<HostMethodResult<M>>;
    }
    if ((method as HostMethod) === "session.snapshot") {
      return worker.request("session.snapshot", params as HostMethodParams<"session.snapshot">)
        .then((snapshot) => this.#enrichSnapshot(worker, snapshot)) as Promise<HostMethodResult<M>>;
    }
    if ((method as HostMethod) === "session.reconcile") {
      return worker.request("session.reconcile", params as HostMethodParams<"session.reconcile">)
        .then(async (result) => ({
          ...result,
          snapshot: await this.#enrichSnapshot(worker, result.snapshot),
        })) as Promise<HostMethodResult<M>>;
    }
    if (!requiresWorkspaceAdmission(method, params)) return worker.request(method, params);
    const cwd = this.#workerCwds.get(worker);
    if (!cwd) {
      throw new PiRuntimeBrokerError(
        "session_context_unavailable",
        `Workspace context is unavailable for Pi session: ${sessionId}`,
      );
    }
    return this.#requestWithExecutionAdmission(
      worker,
      cwd,
      sessionId,
      method,
      params,
      AGENT_RUN_METHODS.has(method) ? "agent-run" : "workspace-mutation",
    );
  }

  async setSessionWorkFocus(
    sessionId: string,
    workFocus: WorkFocusId,
  ): Promise<SessionSnapshot> {
    return this.#withWorkFocusBoundary(sessionId, async () => {
      const worker = this.#workerForSession(sessionId);
      const metadata = await this.#metadataFor(worker);
      const state = await metadata.selectWorkFocus(sessionId, {
        id: workFocus,
        source: "explicit",
      });
      this.#rememberWorkFocus(sessionId, state);
      const snapshot = await worker.request("session.snapshot", { sessionId });
      return this.#enrichSnapshot(worker, snapshot);
    });
  }

  async #promptWithSelectedWorkFocus(
    worker: PiHostClient,
    sessionId: string,
    params: HostMethodParams<"agent.prompt"> | HostMethodParams<"agent.threadRequest">,
    method: "agent.prompt" | "agent.threadRequest" = "agent.prompt",
  ): Promise<HostMethodResult<"agent.prompt">> {
    return this.#withWorkFocusBoundary(sessionId, async () => {
      const metadata = await this.#metadataFor(worker);
      const current = await metadata.getWorkFocus(sessionId);
      if (current.status !== "applied") {
        const candidate: SessionWorkFocusSnapshot = {
          active: {
            ...current.selected,
            generation: current.active.generation
              + (current.active.id === current.selected.id && current.active.source === current.selected.source ? 0 : 1),
          },
          selected: { ...current.selected },
          status: "applied",
        };
        try {
          await worker.request("session.workFocus.apply", {
            generation: candidate.active.generation,
            sessionId,
            selection: current.selected,
          });
          let applied: SessionWorkFocusSnapshot;
          try {
            applied = await metadata.applySelectedWorkFocus(sessionId, current.selected);
          } catch (commitError) {
            await worker.request("session.workFocus.apply", {
              generation: current.active.generation,
              sessionId,
              selection: current.active,
            });
            throw commitError;
          }
          this.#rememberWorkFocus(sessionId, applied);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failed = await metadata.failSelectedWorkFocus(sessionId, current.selected, message);
          this.#rememberWorkFocus(sessionId, failed);
          await worker.request("session.workFocus.publish", { sessionId }).catch(() => undefined);
          throw new PiRuntimeBrokerError(
            "work_focus_prepare_failed",
            `Unable to apply ${current.selected.id} work focus: ${message}`,
            { retryable: true },
          );
        }
        await worker.request("session.workFocus.publish", { sessionId });
      }
      const cwd = this.#workerCwds.get(worker);
      if (!cwd) {
        throw new PiRuntimeBrokerError(
          "session_context_unavailable",
          `Workspace context is unavailable for Pi session: ${sessionId}`,
        );
      }
      if (this.#sessionRunCoordinator && (
        this.#sessionRunCoordinatorFocuses === undefined
        || this.#sessionRunCoordinatorFocuses.has(current.selected.id)
      )) {
        const rawSnapshot = await worker.request("session.snapshot", { sessionId });
        const snapshot = await this.#enrichSnapshot(worker, rawSnapshot);
        const summary = this.#knownSummaries.get(sessionId);
        if (!summary) {
          throw new PiRuntimeBrokerError(
            "session_context_unavailable",
            `Session summary is unavailable before Pi run start: ${sessionId}`,
          );
        }
        const prepared = await this.#sessionRunCoordinator({
          sessionId,
          snapshot: structuredClone(snapshot),
          summary: structuredClone(summary),
        });
        if (prepared?.workspace) {
          await this.#persistWorkspaceBinding(
            metadata,
            sessionId,
            prepared.workspace,
            worker,
            "Failed to persist the research workspace binding",
          );
          this.#knownSummaries.set(sessionId, {
            ...summary,
            workspace: structuredClone(prepared.workspace),
          });
          await worker.request("session.workFocus.publish", { sessionId });
        }
      }
      return this.#requestWithExecutionAdmission(
        worker,
        cwd,
        sessionId,
        method,
        params,
        "agent-run",
      );
    });
  }

  requestForSessionDynamic(sessionId: string, method: unknown, params: unknown): Promise<unknown> {
    if (!isSessionDynamicMethod(method)) {
      throw new PiRuntimeBrokerError(
        "unsupported_method",
        `Unsupported session method: ${String(method)}`,
        { retryable: false },
      );
    }
    return this.requestForSession(sessionId, method, params as HostMethodParams<typeof method>);
  }

  async #requestWithExecutionAdmission<M extends HostMethod>(
    worker: PiHostClient,
    cwd: string,
    sessionId: string | undefined,
    method: M,
    params: HostMethodParams<M>,
    phase: PiSessionExecutionAdmissionRequest["phase"],
  ): Promise<HostMethodResult<M>> {
    const wasRunning = this.#sessionExecutionAdmissions.get(worker)?.running === true;
    const admission = await this.#ensureSessionExecutionAdmission(worker, cwd, {
      method,
      phase,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    try {
      await admission.lease?.assertCanExecute?.();
      const result = await worker.request(method, params);
      if (
        !wasRunning
        && admission.awaitsAgentSettlement
        && typeof result === "object"
        && result !== null
        && "accepted" in result
        && result.accepted === false
      ) {
        admission.running = false;
      }
      return result;
    } catch (error) {
      // A rejected/stale queue operation does not settle the run it joined.
      if (!wasRunning) admission.running = false;
      throw error;
    } finally {
      await this.#finishSessionExecutionAdmission(admission);
    }
  }

  mutatePackage<M extends PiPackageMutationMethod>(
    target: RuntimeContextTarget,
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    const operation = this.#packageMutationTail.then(async () => {
      if (this.#disposed) throw new Error("Pi runtime broker is disposed");
      const receipt = await this.#receiptFor();
      const source = "source" in params && typeof params.source === "string"
        ? params.source
        : undefined;
      const scope = "scope" in params ? params.scope : undefined;
      const reconcileAfterMutation = method !== "settings.update"
        || ("set" in params && Object.hasOwn(params.set, "packages"))
        || ("remove" in params && params.remove.includes("packages"));
      const invalidatesGlobalPackages = method === "package.update"
        || (scope === "global" && reconcileAfterMutation);
      try {
        if (method !== "settings.update" && scope === "global") {
          return await this.#withPackageAuthority(async (worker) => {
            const foundational = source === undefined
              ? undefined
              : await this.#foundationalPackageForMutation(worker, source);
            return this.#coordinatePackageMutation(
              receipt,
              method,
              scope,
              foundational,
              source,
              () => worker.request(method, params),
            );
          });
        }
        if ("sessionId" in target) {
          const worker = this.#workerForSession(target.sessionId);
          const cwd = this.#workerCwds.get(worker);
          if (!cwd) {
            throw new PiRuntimeBrokerError(
              "session_context_unavailable",
              `Workspace context is unavailable for Pi session: ${target.sessionId}`,
            );
          }
          const foundational = source === undefined || scope !== "global"
            ? undefined
            : await this.#foundationalPackageForMutation(worker, source);
          return await this.#coordinatePackageMutation(
            receipt,
            method,
            scope,
            foundational,
            source,
            () => requiresWorkspaceAdmission(method, params)
              ? this.#requestWithExecutionAdmission(
                  worker,
                  cwd,
                  target.sessionId,
                  method,
                  params,
                  "workspace-mutation",
                )
              : worker.request(method, params),
          );
        }
        const workspaceCwd = resolve(target.cwd);
        return await this.#withWorkspaceContext(workspaceCwd, async (worker) => {
          const foundational = source === undefined || scope !== "global"
            ? undefined
            : await this.#foundationalPackageForMutation(worker, source);
          return this.#coordinatePackageMutation(
            receipt,
            method,
            scope,
            foundational,
            source,
            () => requiresWorkspaceAdmission(method, params)
              ? this.#requestWithExecutionAdmission(
                  worker,
                  workspaceCwd,
                  undefined,
                  method,
                  params,
                  "workspace-mutation",
                )
              : worker.request(method, params),
          );
        });
      } finally {
        if (invalidatesGlobalPackages) this.#invalidateWorkspaceContexts();
        if (reconcileAfterMutation) await this.#enqueueFoundationalReconcile({});
      }
    });
    this.#packageMutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async watchConfig(
    target: RuntimeContextTarget,
    watchTarget: PiConfigWatchTarget,
  ): Promise<PiConfigWatchSubscription> {
    let worker: PiHostClient;
    let subscription: PiConfigWatchSubscription;
    if ("sessionId" in target) {
      worker = this.#workerForSession(target.sessionId);
      subscription = await worker.request("config.watch", { target: watchTarget });
    } else {
      const context = await this.#getWorkspaceContext(target.cwd);
      worker = context.client;
      subscription = await worker.request("config.watch", { target: watchTarget });
    }
    if (!this.#clients.has(worker)) {
      throw new PiRuntimeBrokerError(
        "config_watch_failed",
        "Pi configuration worker closed while creating the watch",
      );
    }
    this.#configWatches.set(subscription.watchId, worker);
    return subscription;
  }

  async unwatchConfig(watchId: string): Promise<{ unwatched: boolean }> {
    const worker = this.#configWatches.get(watchId);
    if (!worker) return { unwatched: false };
    this.#configWatches.delete(watchId);
    if (!this.#clients.has(worker)) return { unwatched: false };
    return worker.request("config.unwatch", { watchId });
  }

  async forkSession(sessionId: string, entryId: string, position?: "before" | "at") {
    const worker = this.#workerForSession(sessionId);
    const sourceSummary = await this.#rememberSummary(worker, sessionId);
    const sourceScope = this.#sessionWorkspaceScopes.get(sessionId);
    const finishTransition = worker.beginSessionTransition();
    try {
      const result = await worker.request("session.fork", {
        entryId,
        ...(position === undefined ? {} : { position }),
        sessionId,
      });
      this.#bindSession(worker, result.snapshot.sessionId);
      if (result.snapshot.sessionId !== sessionId) {
        this.#sessions.delete(sessionId);
        if (sourceScope) this.#sessionWorkspaceScopes.set(result.snapshot.sessionId, sourceScope);
      }
      if (result.snapshot.sessionId !== sessionId && sourceSummary.workspace !== undefined) {
        await this.#persistWorkspaceBinding(
          await this.#metadataFor(worker),
          result.snapshot.sessionId,
          sourceSummary.workspace,
          worker,
          "Failed to preserve forked session workspace binding",
        );
      }
      const snapshot = await this.#enrichSnapshot(worker, result.snapshot);
      worker.flushDeferredSessionSnapshots();
      return {
        ...result,
        snapshot,
      };
    } finally {
      finishTransition();
    }
  }

  async renameSession(sessionId: string, name: string): Promise<{ name?: string; sessionId: string }> {
    const worker = this.#sessions.get(sessionId);
    if (worker) {
      const result = await worker.request("session.rename", { name, sessionId });
      await this.#rememberSummary(worker, sessionId);
      return result;
    }
    const summary = (await this.listSessions()).find((entry) => entry.id === sessionId);
    if (!summary) {
      throw new PiRuntimeBrokerError("session_not_found", `Unknown Pi session: ${sessionId}`);
    }
    const result = await this.requestCatalog("session.rename", {
      name,
      sessionFile: summary.sessionFile,
      sessionId,
    });
    const updated = { ...summary, updatedAt: new Date().toISOString() };
    if (result.name === undefined) delete updated.name;
    else updated.name = result.name;
    this.#knownSummaries.set(sessionId, updated);
    return result;
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<SessionSummary> {
    const summaries = await this.listSessions();
    const summary = summaries.find((entry) => entry.id === sessionId);
    if (!summary) {
      throw new PiRuntimeBrokerError("session_not_found", `Unknown Pi session: ${sessionId}`);
    }
    const archivedAt = await (await this.#metadataFor()).setArchived(sessionId, archived);
    const updated = { ...summary };
    if (archivedAt !== undefined) updated.archivedAt = archivedAt;
    else delete updated.archivedAt;
    this.#knownSummaries.set(sessionId, updated);
    return updated;
  }

  async deleteSession(sessionId: string): Promise<{ deleted: boolean; sessionId: string }> {
    const worker = this.#sessions.get(sessionId);
    let summary = this.#knownSummaries.get(sessionId);
    if (!summary && worker) summary = await this.#rememberSummary(worker, sessionId);
    if (!summary) {
      const catalogSummaries = await (await this.#getCatalog()).request("session.list", {});
      for (const candidate of catalogSummaries) this.#knownSummaries.set(candidate.id, candidate);
      summary = catalogSummaries.find((entry) => entry.id === sessionId);
    }
    const metadata = await this.#metadataFor();
    if (!summary) {
      const hadPendingWorkspace = this.#pendingWorkspaceBindings.delete(sessionId);
      const removedMetadata = await metadata.remove(sessionId);
      this.#knownSummaries.delete(sessionId);
      this.#sessionWorkspaceScopes.delete(sessionId);
      return { deleted: hadPendingWorkspace || removedMetadata, sessionId };
    }
    await this.#sessionDeleteCoordinator?.({ sessionId, summary: structuredClone(summary) });
    // Deletion must not wait forever for a plugin's session_shutdown hook. The
    // client disposal path already asks the Host to shut down gracefully, then
    // retires the process tree after the configured shutdown budget.
    if (worker) await this.#removeWorker(worker);
    await this.#deleteSessionFile(summary.sessionFile);
    await metadata.remove(sessionId);
    this.#pendingWorkspaceBindings.delete(sessionId);
    this.#knownSummaries.delete(sessionId);
    this.#sessionWorkspaceScopes.delete(sessionId);
    return { deleted: true, sessionId };
  }

  async previewSessionEntries(
    sessionId: string,
    cwd?: string,
    scope: "branch" | "all" = "branch",
  ) {
    const catalog = await this.#getCatalog();
    let summary = this.#knownSummaries.get(sessionId);
    if (!summary) {
      const summaries = await catalog.request("session.list", cwd === undefined ? {} : { cwd });
      for (const candidate of summaries) this.#knownSummaries.set(candidate.id, candidate);
      summary = summaries.find((candidate) => candidate.id === sessionId);
    }
    if (!summary) {
      throw new PiRuntimeBrokerError("session_not_found", `Unknown Pi session: ${sessionId}`);
    }
    return catalog.request("session.entries.read", {
      cwd: summary.cwd,
      scope,
      sessionFile: summary.sessionFile,
      sessionId,
    });
  }

  async respondToExtensionUi(
    sessionId: string,
    response: ExtensionUiResponse,
  ): Promise<boolean> {
    const live = this.#sessions.get(sessionId) ?? this.#workspaceSessions.get(sessionId);
    let result: HostMethodResult<"extension.ui.respond">;
    if (!live && response.requestId.startsWith(sessionId + ":question:")) {
      if (!this.#knownSummaries.has(sessionId)) await this.listSessions();
      const summary = this.#knownSummaries.get(sessionId);
      if (!summary) throw new PiRuntimeBrokerError("session_not_found", "The question session no longer exists");
      result = await (await this.#getCatalog()).request("session.question.respond", { sessionFile: summary.sessionFile, response });
    } else {
      result = await this.#workerForInteractiveContext(sessionId).request("extension.ui.respond", response);
    }
    if (result.accepted && result.continuation) {
      if (!await this.#questionContinuation?.(sessionId, result.continuation)) {
        if (!live) await this.openSession({ sessionId });
        await this.requestForSession(sessionId, "agent.threadRequest", { sessionId, ...result.continuation });
      }
    }
    return result.accepted;
  }

  async respondToProviderAuth(
    sessionId: string,
    response: ProviderAuthResponse,
  ): Promise<boolean> {
    const result = await this.#workerForInteractiveContext(sessionId).request(
      "provider.auth.respond",
      response,
    );
    return result.accepted;
  }

  async cancelProviderAuth(
    target: RuntimeContextTarget,
    interactionId: string,
  ): Promise<boolean> {
    const result = "sessionId" in target
      ? await this.#workerForInteractiveContext(target.sessionId).request(
          "provider.auth.cancel",
          { interactionId },
        )
      : await (await this.#getWorkspaceContext(target.cwd)).client.request(
          "provider.auth.cancel",
          { interactionId },
        );
    return result.cancelled;
  }

  async respondToProjectTrust(
    workerId: string,
    requestId: string,
    decision: ProjectTrustDecision,
  ): Promise<boolean> {
    const pending = this.#pendingProjectTrust.get(requestId);
    if (!pending || pending.client.id !== workerId) return false;
    const result = await pending.client.request("project.trust.respond", {
      ...decision,
      requestId,
    });
    this.#pendingProjectTrust.delete(requestId);
    return result.accepted;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const clients = [...this.#clients];
    const stoppingClients = Promise.allSettled(clients.map((client) => client.dispose()));
    await Promise.allSettled([
      this.#foundationalTail,
      this.#packageMutationTail,
      stoppingClients,
    ]);
    await Promise.allSettled(
      [...this.#sessionExecutionAdmissions.values()].map((state) => (
        this.#releaseSessionExecutionAdmission(state, true)
      )),
    );
    this.#clients.clear();
    this.#configWatches.clear();
    this.#sessions.clear();
    this.#knownSummaries.clear();
    this.#sessionWorkspaceScopes.clear();
    this.#pendingWorkspaceBindings.clear();
    this.#pendingProjectTrust.clear();
    this.#workerCwds.clear();
    this.#catalog = undefined;
    this.#workspaceContexts.clear();
    this.#workspaceSessions.clear();
    this.#metadata = undefined;
    this.#listeners.clear();
  }

  async #getCatalog(): Promise<PiHostClient> {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    if (this.#catalog) return this.#catalog;
    this.#catalogPromise ??= (async () => {
      const client = this.#createClient("catalog");
      this.#clients.add(client);
      try {
        await client.start();
        if (this.#disposed) {
          await client.dispose();
          throw new Error("Pi runtime broker was disposed during startup");
        }
        this.#catalog = client;
        this.#startFoundationalBootstrap();
        return client;
      } catch (error) {
        this.#clients.delete(client);
        await client.dispose();
        throw error;
      }
    })();
    try {
      return await this.#catalogPromise;
    } finally {
      this.#catalogPromise = undefined;
    }
  }

  async #getWorkspaceContext(cwd: string): Promise<{ client: PiHostClient; sessionId: string }> {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    const normalizedCwd = resolve(cwd);
    const key = this.#pathKey(normalizedCwd);
    const existing = this.#workspaceContexts.get(key);
    if (existing) return existing.ready;

    const client = this.#createClient("workspace", normalizedCwd);
    this.#workerCwds.set(client, normalizedCwd);
    this.#clients.add(client);
    const ready = (async () => {
      const admission = await this.#ensureSessionExecutionAdmission(client, normalizedCwd, {
        phase: "worker-start",
      });
      try {
        await client.start();
        const snapshot = await client.request("catalog.context.open", { cwd: normalizedCwd });
        if (this.#disposed || this.#workspaceContexts.get(key)?.client !== client) {
          throw new Error("Pi workspace worker was superseded during startup");
        }
        this.#bindWorkspaceContext(client, snapshot.sessionId);
        client.flushDeferredSessionSnapshots();
        return { client, sessionId: snapshot.sessionId };
      } finally {
        await this.#finishSessionExecutionAdmission(admission);
      }
    })();
    const context: WorkspaceWorkerContext = { client, cwd: normalizedCwd, ready };
    this.#workspaceContexts.set(key, context);
    try {
      return await ready;
    } catch (error) {
      if (this.#workspaceContexts.get(key) === context) this.#workspaceContexts.delete(key);
      await this.#removeWorker(client);
      throw error;
    }
  }

  async #spawnAuxiliaryWorker(
    role: Extract<RuntimeWorkerRole, "package" | "compaction">,
    cwd: string,
  ): Promise<PiHostClient> {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    const worker = this.#createClient(role, cwd);
    this.#clients.add(worker);
    try {
      await worker.start();
      return worker;
    } catch (error) {
      await this.#removeWorker(worker);
      throw error;
    }
  }

  async #metadataFor(worker?: PiHostClient): Promise<SessionMetadataStore> {
    if (this.#metadata) return this.#metadata;
    const catalog = worker ?? (await this.#getCatalog());
    this.#metadata = new SessionMetadataStore(catalog.handshake.runtime.agentDir);
    return this.#metadata;
  }

  #startFoundationalBootstrap(): void {
    if (this.#foundationalBootstrapStarted || this.#disposed) return;
    this.#foundationalBootstrapStarted = true;
    if (this.#foundationalPackages.length === 0) {
      this.#foundationalStatus = {
        ...this.#foundationalStatus,
        revision: this.#foundationalStatus.revision + 1,
        state: "ready",
      };
      return;
    }
    void this.#enqueueFoundationalReconcile({});
  }

  async #ensureFoundationalBootstrap(): Promise<void> {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    if (this.#foundationalPackages.length === 0) {
      if (!this.#foundationalBootstrapStarted) {
        this.#foundationalBootstrapStarted = true;
        this.#foundationalStatus = {
          ...this.#foundationalStatus,
          revision: this.#foundationalStatus.revision + 1,
          state: "ready",
        };
      }
      return;
    }
    await this.#getCatalog();
    this.#startFoundationalBootstrap();
    await this.#foundationalTail;
  }

  async #enqueueFoundationalReconcile(
    options: {
      restoreIds?: ReadonlySet<FoundationalPiPackageId>;
      setAutoInstallNew?: boolean;
    },
  ): Promise<void> {
    if (this.#foundationalPackages.length === 0) {
      if (options.setAutoInstallNew !== undefined) {
        this.#foundationalStatus = {
          ...this.#foundationalStatus,
          autoInstallNew: options.setAutoInstallNew,
          revision: this.#foundationalStatus.revision + 1,
          state: "ready",
        };
      }
      return;
    }
    const run = this.#foundationalTail.then(async () => {
      if (this.#disposed) return;
      this.#foundationalStatus = {
        ...this.#foundationalStatus,
        entries: this.#foundationalStatus.entries.map((entry) => ({
          ...entry,
          ...(entry.observed === "missing" && entry.intent === "eligible"
            ? { operation: "planned" as const }
            : {}),
        })),
        revision: this.#foundationalStatus.revision + 1,
        state: "running",
      };
      try {
        const result = await this.#withPackageAuthority(async (worker) => {
          const receipt = await this.#receiptFor(worker);
          return reconcileFoundationalPackages({
            bootstrapPackages: (sources) => worker.request("package.bootstrap", { sources }),
            integrations: this.#foundationalPackages,
            listPackages: () => worker.request("package.list", {}),
            manifestRevision: FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
            receiptStore: receipt,
            ...(options.restoreIds === undefined ? {} : { restoreIds: options.restoreIds }),
            ...(options.setAutoInstallNew === undefined
              ? {}
              : { setAutoInstallNew: options.setAutoInstallNew }),
          });
        });
        if (this.#disposed) return;
        this.#foundationalStatus = {
          autoInstallNew: result.autoInstallNew,
          entries: result.entries,
          manifestRevision: FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
          revision: this.#foundationalStatus.revision + 1,
          state: result.state,
        };
      } catch (error) {
        if (this.#disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        this.#foundationalStatus = {
          ...this.#foundationalStatus,
          entries: this.#foundationalStatus.entries.map((entry) => ({
            ...entry,
            error: message,
            operation: "failed_retryable",
          })),
          revision: this.#foundationalStatus.revision + 1,
          state: "degraded",
        };
      }
    });
    this.#foundationalTail = run.then(
      () => undefined,
      () => undefined,
    );
    await this.#foundationalTail;
  }

  async #withWorkspaceContext<Result>(
    cwd: string,
    operation: (worker: PiHostClient) => Promise<Result>,
  ): Promise<Result> {
    const context = await this.#getWorkspaceContext(cwd);
    return operation(context.client);
  }

  async #withPackageAuthority<Result>(
    operation: (worker: PiHostClient) => Promise<Result>,
    cwd?: string,
  ): Promise<Result> {
    const catalog = await this.#getCatalog();
    const packageCwd = resolve(cwd ?? catalog.handshake.runtime.agentDir);
    const worker = await this.#spawnAuxiliaryWorker("package", packageCwd);
    try {
      return await operation(worker);
    } finally {
      await this.#removeWorker(worker);
    }
  }

  #invalidateWorkspaceContexts(): void {
    const workers = [...new Set(
      [...this.#workspaceContexts.values()].map((context) => context.client),
    )];
    this.#workspaceContexts.clear();
    for (const [sessionId, worker] of this.#workspaceSessions) {
      if (workers.includes(worker)) this.#workspaceSessions.delete(sessionId);
    }
    for (const worker of workers) {
      this.#clearConfigWatchesForClient(worker);
      void this.#removeWorker(worker).catch((error) => {
        this.#emit({
          kind: "diagnostic",
          level: "error",
          message: `Failed to retire stale Pi workspace worker: ${
            error instanceof Error ? error.message : String(error)
          }`,
          role: "workspace",
          workerId: worker.id,
        });
      });
    }
  }

  async #receiptFor(worker?: PiHostClient): Promise<PackageProvisioningReceiptStore> {
    if (this.#receiptPromise) return this.#receiptPromise;
    const authority = worker ?? await this.#getCatalog();
    this.#receiptPromise = createPackageProvisioningReceiptStore(
      authority.handshake.runtime.agentDir,
    );
    try {
      return await this.#receiptPromise;
    } catch (error) {
      this.#receiptPromise = undefined;
      throw error;
    }
  }

  async #coordinatePackageMutation<M extends PiPackageMutationMethod>(
    receipt: PackageProvisioningReceiptStore,
    method: M,
    scope: string | undefined,
    foundational: FoundationalPiPackageManifestEntry | undefined,
    source: string | undefined,
    request: () => Promise<HostMethodResult<M>>,
  ): Promise<HostMethodResult<M>> {
    if (method === "package.remove" && foundational) {
      await receipt.markSuppressed(foundational.id);
    }
    if (method !== "package.install" || scope !== "global") {
      return receipt.transact(async (current) => ({
        document: current,
        result: await request(),
        write: false,
      }));
    }
    return receipt.transact(async (current) => {
      const result = await request();
      const descriptor = result as PackageDescriptor;
      const installedFoundation = findFoundationalPackageBySource(
        this.#foundationalPackages,
        descriptor.source || source || "",
      ) ?? this.#foundationalPackages.find((entry) => (
        matchesFoundationalPackage(entry, descriptor)
      )) ?? foundational;
      if (!installedFoundation) return { document: current, result, write: false };
      return {
        document: this.#receiptWithInstalledFoundation(
          current,
          installedFoundation.id,
          descriptor.source,
        ),
        result,
      };
    });
  }

  async #foundationalPackageForMutation(
    worker: PiHostClient,
    source: string,
  ): Promise<FoundationalPiPackageManifestEntry | undefined> {
    const direct = findFoundationalPackageBySource(this.#foundationalPackages, source);
    if (direct) return direct;
    const descriptor = (await worker.request("package.list", {})).find((entry) => (
      entry.scope === "global" && entry.source === source
    ));
    if (!descriptor) return undefined;
    return this.#foundationalPackages.find((entry) => matchesFoundationalPackage(entry, descriptor));
  }

  #receiptWithInstalledFoundation(
    current: PackageProvisioningReceiptDocument,
    id: FoundationalPiPackageId,
    source: string,
  ): PackageProvisioningReceiptDocument {
    const existing = current.entries[id];
    const entry: PackageProvisioningReceiptEntry = {
      ...(typeof existing === "object" && existing !== null && !Array.isArray(existing)
        ? existing
        : {}),
      intent: "eligible",
      lastObservedPresent: true,
      provenance: "auto_managed",
      source,
    };
    return {
      ...current,
      entries: { ...current.entries, [id]: entry },
      manifestRevisionSeen: Math.max(
        current.manifestRevisionSeen,
        FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
      ),
    };
  }

  async #rememberSummary(worker: PiHostClient, sessionId: string): Promise<SessionSummary> {
    const summary = await worker.request("session.summary", { sessionId });
    const metadata = await this.#metadataFor(worker);
    let resolved = this.#overlayPendingWorkspace(summary);
    try {
      await this.#retryPendingWorkspaceBindings(metadata);
      const [enriched] = await metadata.enrich([summary]);
      resolved = this.#overlayPendingWorkspace(enriched ?? summary);
    } catch (error) {
      this.#emit({
        kind: "diagnostic",
        level: "error",
        message: `Failed to read Varin session metadata: ${error instanceof Error ? error.message : String(error)}`,
        role: "session",
        workerId: worker.id,
      });
    }
    this.#knownSummaries.set(resolved.id, resolved);
    return resolved;
  }

  async #enrichSnapshot(worker: PiHostClient, snapshot: SessionSnapshot): Promise<SessionSnapshot> {
    const summary = await this.#rememberSummary(worker, snapshot.sessionId);
    const workFocus = summary.workFocus
      ?? snapshot.workFocus
      ?? productDefaultWorkFocus();
    if (summary.workspace === undefined) {
      const enriched = { ...snapshot, eventWorkerId: worker.id, workFocus: structuredClone(workFocus) };
      delete enriched.workspace;
      delete enriched.workspacePersistence;
      return enriched;
    }
    const enriched = { ...snapshot, eventWorkerId: worker.id, workspace: summary.workspace, workFocus: structuredClone(workFocus) };
    if (summary.workspacePersistence === "pending") enriched.workspacePersistence = "pending";
    else delete enriched.workspacePersistence;
    return enriched;
  }

  #rememberWorkFocus(sessionId: string, workFocus: SessionWorkFocusSnapshot): void {
    const summary = this.#knownSummaries.get(sessionId);
    if (summary) this.#knownSummaries.set(sessionId, { ...summary, workFocus: structuredClone(workFocus) });
  }

  async #resolveInitialWorkFocus(
    cwd: string,
    workspace: SessionWorkspaceBinding | undefined,
    explicit: WorkFocusId | undefined,
  ): Promise<WorkFocusSelection> {
    if (explicit) return { id: explicit, source: "explicit" };
    const project = await this.#options.resolveProjectWorkFocus?.({ cwd, ...(workspace ? { workspace } : {}) });
    if (project) return { id: project, source: "project-default" };
    return { id: "code", source: "product-default" };
  }

  #withWorkFocusBoundary<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#workFocusTails.get(sessionId) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    const tail = task.then(() => undefined, () => undefined);
    this.#workFocusTails.set(sessionId, tail);
    return task.finally(() => {
      if (this.#workFocusTails.get(sessionId) === tail) this.#workFocusTails.delete(sessionId);
    });
  }

  async #persistWorkspaceBinding(
    metadata: SessionMetadataStore,
    sessionId: string,
    workspace: SessionWorkspaceBinding,
    worker: PiHostClient,
    failureMessage: string,
  ): Promise<void> {
    try {
      await metadata.setWorkspace(sessionId, workspace);
      this.#pendingWorkspaceBindings.delete(sessionId);
    } catch (error) {
      this.#pendingWorkspaceBindings.set(sessionId, workspace);
      this.#emit({
        kind: "diagnostic",
        level: "error",
        message: `${failureMessage}: ${error instanceof Error ? error.message : String(error)}`,
        role: "session",
        workerId: worker.id,
      });
    }
  }

  async #retryPendingWorkspaceBindings(metadata: SessionMetadataStore): Promise<void> {
    for (const [sessionId, workspace] of this.#pendingWorkspaceBindings) {
      try {
        await metadata.setWorkspace(sessionId, workspace);
        this.#pendingWorkspaceBindings.delete(sessionId);
      } catch {
        // Keep the binding authoritative in memory and expose the pending state.
      }
    }
  }

  #overlayPendingWorkspace(summary: SessionSummary): SessionSummary {
    const workspace = this.#pendingWorkspaceBindings.get(summary.id);
    if (workspace === undefined) {
      if (summary.workspacePersistence === undefined) return summary;
      const resolved = { ...summary };
      delete resolved.workspacePersistence;
      return resolved;
    }
    return { ...summary, workspace, workspacePersistence: "pending" };
  }

  #projectSessionEnvelope(envelope: EventEnvelope, sessionId: string, workerId: string): EventEnvelope {
    if (envelope.event !== "session.snapshot") return envelope;
    const workspace = this.#pendingWorkspaceBindings.get(sessionId)
      ?? this.#knownSummaries.get(sessionId)?.workspace;
    const workFocus = this.#knownSummaries.get(sessionId)?.workFocus
      ?? (envelope.data as SessionSnapshot).workFocus
      ?? productDefaultWorkFocus();
    if (workspace === undefined) {
      return { ...envelope, data: { ...envelope.data, eventWorkerId: workerId, workFocus } };
    }
    return {
      ...envelope,
      data: {
        ...envelope.data,
        eventWorkerId: workerId,
        workspace,
        workFocus,
        ...(this.#pendingWorkspaceBindings.has(sessionId)
          ? { workspacePersistence: "pending" as const }
          : {}),
      },
    };
  }

  #knownSummaryForOpen(input: {
    sessionFile?: string;
    sessionId?: string;
  }): SessionSummary | undefined {
    if (input.sessionFile !== undefined) {
      const sessionFileKey = this.#pathKey(input.sessionFile);
      return [...this.#knownSummaries.values()].find(
        (summary) => this.#pathKey(summary.sessionFile) === sessionFileKey,
      );
    }
    return input.sessionId === undefined ? undefined : this.#knownSummaries.get(input.sessionId);
  }

  #pathKey(path: string): string {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  async #deleteSessionFile(sessionFile: string): Promise<void> {
    const metadata = await this.#metadataFor();
    const rootPath = resolve(metadata.agentDir, "sessions");
    const candidate = resolve(sessionFile);
    const relativePath = relative(rootPath, candidate);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new PiRuntimeBrokerError(
        "session_path_denied",
        `Refusing to delete a session outside the Pi session root: ${candidate}`,
      );
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new PiRuntimeBrokerError(
        "session_path_denied",
        `Refusing to delete a non-regular Pi session file: ${candidate}`,
      );
    }
    const root = await realpath(rootPath);
    const resolvedCandidate = await realpath(candidate);
    const resolvedRelativePath = relative(root, resolvedCandidate);
    if (
      resolvedRelativePath === ".." ||
      resolvedRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(resolvedRelativePath)
    ) {
      throw new PiRuntimeBrokerError(
        "session_path_denied",
        `Refusing to delete a session outside the Pi session root: ${resolvedCandidate}`,
      );
    }
    await rm(resolvedCandidate);
  }

  async #openUnboundSessionWorker(
    cwd: string,
    input: HostMethodParams<"session.open">,
  ): Promise<{ snapshot: SessionSnapshot; worker: PiHostClient }> {
    // A saved session can outlive the directory it originally worked in.
    // Launch the Pi process from its managed agent directory in that case,
    // while keeping the historical cwd as the session's declared tool target.
    let launchCwd = cwd;
    try {
      if (!(await stat(cwd)).isDirectory()) launchCwd = (await this.#getCatalog()).handshake.runtime.agentDir;
    } catch {
      launchCwd = (await this.#getCatalog()).handshake.runtime.agentDir;
    }
    const worker = await this.#spawnWorker(cwd, launchCwd);
    try {
      return { snapshot: await worker.request("session.open", input), worker };
    } catch (error) {
      await this.#removeWorker(worker);
      throw error;
    }
  }

  async #spawnWorker(cwd: string, launchCwd = cwd): Promise<PiHostClient> {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    const worker = this.#createClient("session", launchCwd);
    this.#workerCwds.set(worker, cwd);
    this.#clients.add(worker);
    try {
      await this.#ensureSessionExecutionAdmission(worker, cwd, { phase: "worker-start" });
      await worker.start();
      return worker;
    } catch (error) {
      await this.#removeWorker(worker);
      throw error;
    }
  }

  #createClient(role: RuntimeWorkerRole, workerCwd?: string): PiHostClient {
    const cwd = role === "catalog" ? this.#options.cwd : workerCwd;
    const client = new PiHostClient({
      ...(this.#options.agentDir === undefined ? {} : { agentDir: this.#options.agentDir }),
      ...(cwd === undefined ? {} : { cwd }),
      environment: {
        ...(this.#options.environment ?? {}),
        ...(role === "session" ? { VARIN_ALLOW_MISSING_SESSION_CWD: "1" } : {}),
      },
      ...(this.#options.execArgv === undefined ? {} : { execArgv: this.#options.execArgv }),
      handshake: this.#options.client,
      hostEntry: this.#options.hostEntry,
      ...(this.#options.nodePath === undefined ? {} : { nodePath: this.#options.nodePath }),
      ...(this.#options.packageRoot === undefined ? {} : { packageRoot: this.#options.packageRoot }),
      ...(this.#options.runtimeSource === undefined
        ? {}
        : { runtimeSource: this.#options.runtimeSource }),
      ...(this.#options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: this.#options.shutdownTimeoutMs }),
      workerRole: role,
      onDiagnostic: (level, message) => {
        this.#emit({ kind: "diagnostic", level, message, role, workerId: client.id });
      },
      onEvent: (envelope) => {
        const identityDecision = classifyWorkerEventIdentity({
          envelope,
          pinnedSessionId: client.sessionId,
          role,
          transitioning: client.sessionTransitioning,
        });
        if (identityDecision !== "accept") {
          if (identityDecision === "reject") {
            const claimed = claimedEventSessionId(envelope) ?? "<missing>";
            this.#emit({
              kind: "diagnostic",
              level: "error",
              message: `Pi worker protocol violation: ${envelope.event} claimed session ${claimed}; pinned session is ${client.sessionId ?? "<unbound>"}`,
              role,
              workerId: client.id,
            });
            if (envelope.event === "harness.request" && client.sessionId === undefined) {
              void client.request("harness.rejectUnbound", { requestId: envelope.data.requestId })
                .catch((error) => this.#emit({
                  kind: "diagnostic",
                  level: "error",
                  message: `Failed to reject an unbound Harness request: ${error instanceof Error ? error.message : String(error)}`,
                  role,
                  workerId: client.id,
                }));
            }
          }
          return;
        }
        if (
          envelope.event === "config.changed"
          && this.#configWatches.get(envelope.data.watchId) !== client
        ) {
          return;
        }
        if (role === "session" && envelope.event === "agent.event") {
          if (envelope.data.event.type === "agent_start") {
            const admission = this.#sessionExecutionAdmissions.get(client);
            if (admission && !admission.closing) admission.running = true;
          } else if (envelope.data.event.type === "agent_settled") {
            const admission = this.#sessionExecutionAdmissions.get(client);
            if (admission) {
              admission.running = false;
              void this.#releaseSessionExecutionAdmission(admission);
            }
          }
        }
        if (envelope.event === "project.trust.request") {
          this.#pendingProjectTrust.set(envelope.data.id, { client });
        }
        this.#emit({
          envelope: client.sessionId === undefined
            ? envelope
            : this.#projectSessionEnvelope(envelope, client.sessionId, client.id),
          kind: "host",
          role,
          ...(client.sessionId === undefined ? {} : { sessionId: client.sessionId }),
          workerId: client.id,
        });
        if (envelope.event === "project.trust.request") {
          if (this.#options.promptForProjectTrust) {
            void this.#resolveProjectTrust(client, role, envelope.data);
          }
        }
      },
      onExit: (exit) => this.#handleExit(client, role, exit),
      ...(this.#options.projectTrustOverride === undefined
        ? {}
        : { projectTrustOverride: this.#options.projectTrustOverride }),
    });
    return client;
  }

  async #resolveProjectTrust(
    client: PiHostClient,
    role: RuntimeWorkerRole,
    request: ProjectTrustRequest,
  ): Promise<void> {
    let decision: ProjectTrustDecision = { remember: false, trusted: false };
    try {
      decision = await this.#options.promptForProjectTrust!(request);
    } catch (error) {
      this.#emit({
        kind: "diagnostic",
        level: "error",
        message: `Project trust prompt failed: ${error instanceof Error ? error.message : String(error)}`,
        role,
        workerId: client.id,
      });
    }
    try {
      await this.respondToProjectTrust(client.id, request.id, decision);
    } catch (error) {
      this.#emit({
        kind: "diagnostic",
        level: "error",
        message: `Project trust response failed: ${error instanceof Error ? error.message : String(error)}`,
        role,
        workerId: client.id,
      });
    }
  }

  #bindSession(client: PiHostClient, sessionId: string): void {
    const existingSessionWorker = this.#sessions.get(sessionId);
    if (existingSessionWorker && existingSessionWorker !== client) {
      throw new PiRuntimeBrokerError(
        "session_conflict",
        `Pi session is already bound to another worker: ${sessionId}`,
      );
    }
    const existingWorkspaceWorker = this.#workspaceSessions.get(sessionId);
    if (existingWorkspaceWorker && existingWorkspaceWorker !== client) {
      throw new PiRuntimeBrokerError(
        "session_conflict",
        `Pi session is already bound to a workspace worker: ${sessionId}`,
      );
    }
    for (const [mappedSessionId, worker] of this.#sessions) {
      if (worker === client && mappedSessionId !== sessionId) {
        this.#sessions.delete(mappedSessionId);
      }
    }
    this.#sessions.set(sessionId, client);
    client.pinSession(sessionId);
  }

  #bindWorkspaceContext(client: PiHostClient, sessionId: string): void {
    const existingWorkspaceWorker = this.#workspaceSessions.get(sessionId);
    if (existingWorkspaceWorker && existingWorkspaceWorker !== client) {
      throw new PiRuntimeBrokerError(
        "session_conflict",
        `Pi workspace context is already bound to another worker: ${sessionId}`,
      );
    }
    const existingSessionWorker = this.#sessions.get(sessionId);
    if (existingSessionWorker && existingSessionWorker !== client) {
      throw new PiRuntimeBrokerError(
        "session_conflict",
        `Pi workspace context collides with an active session: ${sessionId}`,
      );
    }
    for (const [mappedSessionId, worker] of this.#workspaceSessions) {
      if (worker === client && mappedSessionId !== sessionId) {
        this.#workspaceSessions.delete(mappedSessionId);
      }
    }
    this.#workspaceSessions.set(sessionId, client);
    client.pinSession(sessionId);
  }

  #workerForSession(sessionId: string): PiHostClient {
    const worker = this.#sessions.get(sessionId);
    if (!worker) throw new Error(`Session is not active: ${sessionId}`);
    return worker;
  }

  #workerForInteractiveContext(sessionId: string): PiHostClient {
    const worker = this.#sessions.get(sessionId);
    if (worker) return worker;
    const workspace = this.#workspaceSessions.get(sessionId);
    if (workspace) return workspace;
    throw new Error(`Session or workspace context is not active: ${sessionId}`);
  }

  async #removeWorker(worker: PiHostClient): Promise<void> {
    this.#clients.delete(worker);
    if (this.#catalog === worker) {
      this.#catalog = undefined;
    }
    for (const [key, context] of this.#workspaceContexts) {
      if (context.client === worker) this.#workspaceContexts.delete(key);
    }
    for (const [sessionId, candidate] of this.#sessions) {
      if (candidate === worker) this.#sessions.delete(sessionId);
    }
    for (const [sessionId, candidate] of this.#workspaceSessions) {
      if (candidate === worker) this.#workspaceSessions.delete(sessionId);
    }
    this.#clearProjectTrustForClient(worker);
    this.#clearConfigWatchesForClient(worker);
    try {
      await worker.dispose();
    } finally {
      this.#workerCwds.delete(worker);
      const admission = this.#sessionExecutionAdmissions.get(worker);
      if (admission) await this.#releaseSessionExecutionAdmission(admission, true);
    }
  }

  #handleExit(
    client: PiHostClient,
    role: RuntimeWorkerRole,
    exit: PiHostExit,
  ): void {
    const sessionId = client.sessionId;
    const expected = this.#disposed || client.disposing;
    if (client === this.#catalog) {
      this.#catalog = undefined;
    }
    for (const [key, context] of this.#workspaceContexts) {
      if (context.client === client) this.#workspaceContexts.delete(key);
    }
    this.#clients.delete(client);
    for (const [mappedSessionId, worker] of this.#sessions) {
      if (worker === client) this.#sessions.delete(mappedSessionId);
    }
    for (const [mappedSessionId, worker] of this.#workspaceSessions) {
      if (worker === client) this.#workspaceSessions.delete(mappedSessionId);
    }
    this.#clearProjectTrustForClient(client);
    this.#clearConfigWatchesForClient(client);
    this.#workerCwds.delete(client);
    const admission = this.#sessionExecutionAdmissions.get(client);
    if (admission) void this.#releaseSessionExecutionAdmission(admission, true);
    this.#emit({
      code: exit.code,
      expected,
      kind: "worker.exit",
      role,
      sequence: client.lastSequence + 1,
      ...(sessionId === undefined ? {} : { sessionId }),
      signal: exit.signal,
      workerId: client.id,
    });
    // A session worker's death orphans its auxiliary workers (compaction);
    // retire them so a late summary can never be delivered to a dead session.
    if (role === "session" && sessionId !== undefined) {
      const auxiliaries = this.#sessionAuxiliaries.get(sessionId);
      if (auxiliaries) {
        this.#sessionAuxiliaries.delete(sessionId);
        for (const auxiliary of auxiliaries) {
          void this.#removeWorker(auxiliary).catch((error) => {
            this.#emit({
              kind: "diagnostic",
              level: "error",
              message: `Failed to retire orphaned Pi auxiliary worker: ${error instanceof Error ? error.message : String(error)}`,
              role: "compaction",
              workerId: auxiliary.id,
            });
          });
        }
      }
    }
  }

  #emit(event: PiRuntimeBrokerEventPayload): void {
    const admission = [...this.#sessionExecutionAdmissions.values()]
      .find((candidate) => candidate.client.id === event.workerId);
    const executionId = admission?.executionId;
    const actor = event.kind !== "diagnostic" && event.sessionId !== undefined
      ? {
          authorityInstanceId: this.#authorityInstanceId,
          sessionId: event.sessionId,
          ...(this.#sessionWorkspaceScopes.has(event.sessionId)
            ? { workspaceScope: this.#sessionWorkspaceScopes.get(event.sessionId)! }
            : {}),
          ...(executionId === undefined ? {} : { runId: executionId }),
          workerId: event.workerId,
          workerGeneration: this.#runtimeGeneration,
        } satisfies HarnessActorIdentity
      : undefined;
    const projected: PiRuntimeBrokerEvent = {
      ...event,
      ...(actor === undefined ? {} : { actor }),
      ...(executionId === undefined ? {} : { executionId }),
      runtimeGeneration: this.#runtimeGeneration,
    };
    for (const listener of this.#listeners) {
      try {
        listener(projected);
      } catch {
        // Surface callbacks are observational and must not break worker ownership.
      }
    }
  }

  async #ensureSessionExecutionAdmission(
    client: PiHostClient,
    cwd: string,
    context: Pick<PiSessionExecutionAdmissionRequest, "method" | "phase" | "sessionId">,
  ): Promise<SessionExecutionAdmissionState> {
    for (;;) {
      if (this.#disposed) throw new Error("Pi runtime broker is disposed");
      const existing = this.#sessionExecutionAdmissions.get(client);
      if (existing) {
        await existing.ready;
        if (existing.closing || this.#sessionExecutionAdmissions.get(client) !== existing) {
          await existing.done;
          continue;
        }
        if (existing.phase === context.phase || (context.phase === "agent-run" && existing.running)) {
          existing.holders += 1;
          return existing;
        }
        await existing.done;
        continue;
      }
      let resolveDone = () => {};
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const state: SessionExecutionAdmissionState = {
        awaitsAgentSettlement: context.phase === "agent-run"
          && context.method !== undefined
          && DEFERRED_AGENT_SETTLEMENT_METHODS.has(context.method),
        client,
        closing: false,
        done,
        executionId: randomUUID(),
        holders: 1,
        phase: context.phase,
        ready: Promise.resolve(),
        resolveDone,
        running: context.phase === "agent-run"
          && context.method !== undefined
          && DEFERRED_AGENT_SETTLEMENT_METHODS.has(context.method),
      };
      this.#sessionExecutionAdmissions.set(client, state);
      state.ready = (async () => {
        const cachedWorkspace = context.sessionId === undefined
          ? undefined
          : this.#knownSummaries.get(context.sessionId)?.workspace;
        let workspace = cachedWorkspace;
        if (context.sessionId !== undefined) {
          try {
            // Recovery and mutation ownership must use the durable session
            // binding, not whichever summary happened to be cached by the UI.
            // Refreshing here also covers a freshly created or rebound session
            // before its next catalog refresh.
            workspace = (await this.#rememberSummary(client, context.sessionId)).workspace
              ?? cachedWorkspace;
          } catch (error) {
            this.#emit({
              kind: "diagnostic",
              level: "error",
              message: `Failed to refresh Varin session workspace binding: ${error instanceof Error ? error.message : String(error)}`,
              role: "session",
              workerId: client.id,
            });
          }
        }
        const lease = await this.#sessionExecutionAdmission?.({
          cwd,
          executionId: state.executionId,
          ...(context.method === undefined ? {} : { method: context.method }),
          phase: context.phase,
          runtimeGeneration: this.#runtimeGeneration,
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          ...(workspace === undefined ? {} : { workspace }),
          workerId: client.id,
        });
        if (lease != null && typeof lease.close !== "function") {
          throw new TypeError("Pi session execution admission must return a closeable lease");
        }
        state.lease = lease ?? null;
      })().catch((error) => {
        state.closing = true;
        if (this.#sessionExecutionAdmissions.get(client) === state) {
          this.#sessionExecutionAdmissions.delete(client);
        }
        state.resolveDone();
        throw error;
      });
      await state.ready;
      if (state.closing) {
        await state.done;
        continue;
      }
      return state;
    }
  }

  #finishSessionExecutionAdmission(state: SessionExecutionAdmissionState): Promise<void> {
    if (state.holders > 0) state.holders -= 1;
    return this.#releaseSessionExecutionAdmission(state);
  }

  #releaseSessionExecutionAdmission(
    state: SessionExecutionAdmissionState,
    force: boolean = false,
  ): Promise<void> {
    if (state.closePromise) return state.closePromise;
    if (!force && (state.holders > 0 || state.running)) return Promise.resolve();
    state.closing = true;
    state.closePromise = (async () => {
      await state.ready.catch(() => undefined);
      try {
        await state.lease?.close();
      } catch (error) {
        this.#emit({
          kind: "diagnostic",
          level: "error",
          message: `Failed to release Pi session execution admission: ${
            error instanceof Error ? error.message : String(error)
          }`,
          role: "session",
          workerId: state.client.id,
        });
      }
    })().finally(() => {
      if (this.#sessionExecutionAdmissions.get(state.client) === state) {
        this.#sessionExecutionAdmissions.delete(state.client);
      }
      state.resolveDone();
    });
    return state.closePromise;
  }

  #clearProjectTrustForClient(client: PiHostClient): void {
    for (const [requestId, pending] of this.#pendingProjectTrust) {
      if (pending.client === client) this.#pendingProjectTrust.delete(requestId);
    }
  }

  #clearConfigWatchesForClient(client: PiHostClient): void {
    for (const [watchId, worker] of this.#configWatches) {
      if (worker === client) this.#configWatches.delete(watchId);
    }
  }
}
