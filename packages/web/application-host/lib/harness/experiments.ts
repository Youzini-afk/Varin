/**
 * Experiment execution on durable kernel records (7C/7D-1, D-300).
 *
 * Flow: intent → spec/attempt records → resource admission → kernel process
 * (job record) → exit facts → collected artifacts. The process identity is
 * derived from the attempt id, so a lost submit response or a Host restart can
 * reconcile by asking the kernel whether that exact process exists — a retry
 * never starts a second copy.
 *
 * Attempt state and collection state are separate facts: a finished experiment
 * whose artifacts failed to copy stays completed/failed with
 * collection:"failed" and can be re-collected without re-running.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import { sliceUtf8ByBytes } from "@varin/protocol";
import type {
  ExperimentArtifactState,
  ExperimentArtifactView,
  ExperimentAttemptState,
  ExperimentAttemptView,
  ExperimentCollectResult,
  ExperimentGetResult,
  ExperimentInputRef,
  ExperimentJobState,
  ExperimentJobView,
  ExperimentListResult,
  ExperimentLogsResult,
  ExperimentResourceRequest,
  ResourceMachineView,
  ExperimentSpecView,
  ExperimentSubmitParams,
} from "@varin/protocol";
import { canonicalizePathIdentity } from "../workspace/path-safety.js";
import { waitWithSignal } from "../cancellation.js";
import { HarnessServiceError } from "./service-error.js";
import {
  createLocalExperimentBackend,
  type BackendJobHandle,
  type BackendObservation,
  type ExperimentBackend,
  type ExperimentBackendSite,
  type ResolvedExperimentBackend,
} from "./experiment-backend.js";
import type { ResourceService } from "./resources.js";
import type { SourceService } from "./sources.js";
import {
  materializeExperimentAttempt,
  prepareExperimentInput,
  type ExperimentInputSnapshot,
} from "./experiment-workspace.js";

const SPEC_PREFIX = "experiment.spec:";
const ATTEMPT_PREFIX = "experiment.attempt:";
const JOB_PREFIX = "experiment.job:";
const ARTIFACT_PREFIX = "experiment.artifact:";
const LOCAL_MACHINE_ID = "local";
const POLL_MS = 250;
const RECONNECT_POLL_MS = 500;
const BLOB_PAGE_BYTES = 256 * 1024;
const TERMINAL: ReadonlySet<ExperimentAttemptState> = new Set(["completed", "failed", "cancelled", "lost"]);

export const isTerminalAttemptState = (state: ExperimentAttemptState): boolean => TERMINAL.has(state);

export interface ExperimentCaller {
  /** Workspace that owns the durable records and resource facts. */
  workspaceId: string;
  /** The actor's execution workspace (may differ for isolated branches). */
  executionWorkspaceId: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  /** Stable identity of the root session that owns this research tree. */
  rootSessionId?: string;
  /** Restricted child-Run path scopes (owning-root relative). */
  workspaceScope?: readonly string[];
  /** Threads in the caller's authorized root tree. Omitted only for trusted Host maintenance. */
  allowedThreadIds?: readonly string[];
}

export interface ExperimentContext {
  scoped: KernelScopedClient;
  rootId: string;
  canonicalRoot: string;
}

// Host-internal service grant: same trust level as the native process host.
// `storage.maintenance` (not `storage.admin`) is the narrowest capability that
// lets an unbound service grant write records carrying caller attribution
// (sessionId/threadId/runId) and read them back across actors — it grants no
// cross-workspace authority. `process.maintenance` covers inspecting and
// stopping jobs owned by an earlier grant after a Host restart.
const SERVICE_CAPABILITIES = [
  "storage.read", "storage.write", "storage.maintenance", "recovery", "process", "process.maintenance",
];

interface RunningJob {
  backend: ExperimentBackend;
  site: ExperimentBackendSite;
  handle: BackendJobHandle;
  cursor: number;
  totals: Record<"stdout" | "stderr", number>;
  poll: Promise<void>;
  cancelRequested: boolean;
  finalized: boolean;
  lastPollError?: string;
  lastObservationKey?: string;
  observerOwner: symbol;
}

interface SharedExperimentRuntime {
  jobs: Map<string, RunningJob>;
  attemptOperations: Map<string, Promise<void>>;
  listeners: Set<(workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => void>;
  submissionsByThread: Map<string, Set<Promise<unknown>>>;
  stoppingThreads: Map<string, Promise<void>>;
}

const sharedExperimentRuntimes = new WeakMap<KernelClient, SharedExperimentRuntime>();

const sharedExperimentRuntime = (client: KernelClient): SharedExperimentRuntime => {
  const existing = sharedExperimentRuntimes.get(client);
  if (existing) return existing;
  const created: SharedExperimentRuntime = {
    jobs: new Map(),
    attemptOperations: new Map(),
    listeners: new Set(),
    submissionsByThread: new Map(),
    stoppingThreads: new Map(),
  };
  sharedExperimentRuntimes.set(client, created);
  return created;
};

interface ExperimentServiceDeps {
  client: KernelClient;
  resources: ResourceService;
  sources?: SourceService;
  /** Resolve the owning workspace's canonical root (default experiment cwd). */
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  /**
   * Resolve the execution backend for a machine record. The default resolves
   * only the local kernel; connection managers register richer resolution for
   * remote machines and schedulers. Returning null fails the attempt honestly
   * instead of silently running it somewhere else.
   */
  resolveBackend?: (
    ctx: ExperimentContext,
    machineId: string,
    machine: KernelRecordResult | null,
    caller: ExperimentCaller,
  ) => Promise<ResolvedExperimentBackend | null> | ResolvedExperimentBackend | null;
  /** Durable attempt fact changed (state, exit facts, collection) — drives UI refresh. */
  onAttemptChanged?: (workspaceId: string) => void;
  now?: () => number;
  onError?: (error: Error) => void;
}

const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(record.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const num = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);

const str = (value: unknown): string | undefined => (
  typeof value === "string" && value ? value : undefined
);

const strArray = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
);

const recordIdFor = {
  spec: (id: string) => `${SPEC_PREFIX}${id}`,
  attempt: (id: string) => `${ATTEMPT_PREFIX}${id}`,
  job: (id: string) => `${JOB_PREFIX}${id}`,
  artifact: (id: string) => `${ARTIFACT_PREFIX}${id}`,
};

const digestId = (...parts: string[]): string => (
  createHash("sha256").update(parts.join("\0")).digest("hex")
);

const callerNamespace = (caller: ExperimentCaller): string => (
  caller.rootSessionId ?? caller.sessionId ?? caller.threadId ?? "host"
);

const processIdFor = (workspaceId: string, attemptId: string) => (
  `experiment-${digestId(workspaceId, attemptId).slice(0, 40)}`
);
const jobIdFor = (attemptId: string) => `job-${digestId(attemptId).slice(0, 40)}`;
const attemptIdForRequest = (caller: ExperimentCaller, requestId: string) => (
  `attempt-${digestId(caller.workspaceId, callerNamespace(caller), requestId).slice(0, 40)}`
);
const artifactIdFor = (attemptId: string, name: string) => (
  `${attemptId}:${digestId(name).slice(0, 32)}`
);
const attemptKey = (workspaceId: string, attemptId: string) => `${workspaceId}\0${attemptId}`;

const specView = (record: KernelRecordResult): ExperimentSpecView | null => {
  const payload = payloadOf(record);
  const specId = str(payload.id);
  const command = str(payload.command);
  if (!specId || !command) return null;
  const inputs = Array.isArray(payload.inputs)
    ? payload.inputs.flatMap((input): ExperimentInputRef[] => {
        if (!input || typeof input !== "object") return [];
        const raw = input as Record<string, unknown>;
        const sourceId = str(raw.sourceId);
        const inputPath = str(raw.path);
        const objectHash = str(raw.objectHash);
        const role = str(raw.role);
        return [{
          ...(sourceId ? { sourceId } : {}),
          ...(inputPath ? { path: inputPath } : {}),
          ...(objectHash ? { objectHash } : {}),
          ...(role ? { role } : {}),
        }];
      })
    : [];
  const title = str(payload.title);
  const cwd = str(payload.cwd);
  return {
    specId,
    ...(title ? { title } : {}),
    command,
    args: strArray(payload.args),
    ...(cwd ? { cwd } : {}),
    inputs,
    ...(payload.resources && typeof payload.resources === "object"
      ? { resources: payload.resources as ExperimentResourceRequest }
      : {}),
    outputPaths: strArray(payload.outputPaths),
    state: record.state === "retired" ? "retired" : "active",
    revision: record.recordRevision,
    createdAt: record.createdAt,
  };
};

const attemptView = (record: KernelRecordResult): ExperimentAttemptView | null => {
  const payload = payloadOf(record);
  const attemptId = str(payload.id);
  const specId = str(payload.specId);
  if (!attemptId || !specId) return null;
  const machineId = str(payload.machineId);
  const signal = str(payload.signal);
  const error = str(payload.error);
  const queueReason = str(payload.queueReason);
  const requestId = str(payload.requestId);
  const retryOfAttemptId = str(payload.retryOfAttemptId);
  const executionRootId = str(payload.executionRootId);
  const executionCanonicalRoot = str(payload.executionCanonicalRoot);
  const executionCwd = typeof payload.executionCwd === "string" ? payload.executionCwd : undefined;
  const exitCode = num(payload.exitCode);
  const startedAt = num(payload.startedAt);
  const endedAt = num(payload.endedAt);
  return {
    attemptId,
    specId,
    backend: str(payload.backend) ?? "local",
    ...(machineId ? { machineId } : {}),
    state: record.state as ExperimentAttemptState,
    collection: (["none", "pending", "done", "failed"] as const)
      .find((value) => value === payload.collection) ?? "none",
    ...(payload.exitCode === null || exitCode !== undefined
      ? { exitCode: payload.exitCode === null ? null : exitCode! }
      : {}),
    ...(signal ? { signal } : {}),
    ...(error ? { error } : {}),
    ...(queueReason ? { queueReason } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryOfAttemptId ? { retryOfAttemptId } : {}),
    ...(executionRootId && executionCanonicalRoot && executionCwd !== undefined ? {
      execution: { rootId: executionRootId, canonicalRoot: executionCanonicalRoot, cwd: executionCwd },
    } : {}),
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
    createdAt: record.createdAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
};

const jobView = (record: KernelRecordResult): ExperimentJobView | null => {
  const payload = payloadOf(record);
  const jobId = str(payload.id);
  const attemptId = str(payload.attemptId);
  if (!jobId || !attemptId) return null;
  const machineId = str(payload.machineId);
  const backendJobId = str(payload.backendJobId);
  const kernelEpoch = str(payload.kernelEpoch);
  const pid = num(payload.pid);
  const signal = str(payload.signal);
  const reason = str(payload.reason);
  const exitCode = num(payload.exitCode);
  const startedAt = num(payload.startedAt);
  const endedAt = num(payload.endedAt);
  return {
    jobId,
    attemptId,
    backend: str(payload.backend) ?? "local",
    ...(machineId ? { machineId } : {}),
    ...(backendJobId ? { backendJobId } : {}),
    ...(kernelEpoch ? { kernelEpoch } : {}),
    ...(pid !== undefined ? { pid } : {}),
    state: record.state as ExperimentJobState,
    ...(payload.exitCode === null || exitCode !== undefined
      ? { exitCode: payload.exitCode === null ? null : exitCode! }
      : {}),
    ...(signal ? { signal } : {}),
    ...(reason ? { reason } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
};

const artifactView = (record: KernelRecordResult): ExperimentArtifactView | null => {
  const payload = payloadOf(record);
  const artifactId = str(payload.id);
  const attemptId = str(payload.attemptId);
  const name = str(payload.name);
  if (!artifactId || !attemptId || !name) return null;
  const kind = (["stdout", "stderr", "file", "object"] as const)
    .find((value) => value === payload.kind) ?? "object";
  const content = record.references.find((reference) => reference.slot === "content");
  const byteLength = num(payload.byteLength);
  const artifactPath = str(payload.path);
  const collectedAt = num(payload.collectedAt);
  const error = str(payload.error);
  const remote = payload.remote && typeof payload.remote === "object"
    ? payload.remote as Record<string, unknown>
    : null;
  const remoteMachineId = str(remote?.machineId);
  const remoteOutputId = str(remote?.outputId);
  const remotePath = str(remote?.path);
  const remoteAccessible = remote?.accessible === "unreachable" || remote?.accessible === "expired"
    ? remote.accessible : "available";
  return {
    artifactId,
    attemptId,
    name,
    kind,
    state: record.state as ExperimentArtifactState,
    ...(byteLength !== undefined ? { byteLength } : {}),
    ...(payload.truncated === true ? { truncated: true } : {}),
    ...(content ? { objectHash: content.objectHash } : {}),
    ...(remoteMachineId && remoteOutputId && remotePath ? {
      remote: {
        machineId: remoteMachineId,
        outputId: remoteOutputId,
        path: remotePath,
        retainedBy: "execution-target",
        accessible: remoteAccessible,
      },
    } : {}),
    ...(artifactPath ? { path: artifactPath } : {}),
    ...(collectedAt !== undefined ? { collectedAt } : {}),
    ...(error ? { error } : {}),
  };
};

const specDigest = (input: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  inputs?: ExperimentInputRef[];
  resources?: ExperimentResourceRequest;
  outputPaths?: string[];
  inputRoot?: string;
}): string => {
  const normalized = {
    command: input.command,
    args: [...input.args],
    cwd: input.cwd ?? null,
    env: input.env ? Object.fromEntries(Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))) : null,
    inputs: input.inputs ?? [],
    resources: input.resources ?? null,
    outputPaths: input.outputPaths ?? [],
    inputRoot: input.inputRoot ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 24);
};

const inputSnapshotOf = (record: KernelRecordResult): ExperimentInputSnapshot | null => {
  const value = payloadOf(record).inputSnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || typeof input.branchId !== "string" || typeof input.root !== "string"
    || typeof input.sourceRoot !== "string" || typeof input.workspaceId !== "string"
    || typeof input.executionWorkspaceId !== "string" || !Array.isArray(input.captureScopes)
    || !input.captureScopes.every((entry) => typeof entry === "string")
    || !Number.isSafeInteger(input.capturedPathCount) || typeof input.inventoryFingerprint !== "string") {
    return null;
  }
  return value as unknown as ExperimentInputSnapshot;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function createExperimentService(deps: ExperimentServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const serviceToken = Symbol("experiment-service");
  const sharedRuntime = sharedExperimentRuntime(deps.client);
  let disposed = false;
  const contexts = new Map<string, Promise<ExperimentContext>>();
  const recordContexts = new Map<string, Promise<ExperimentContext>>();
  const reconciliations = new Map<string, Promise<void>>();
  const jobs = sharedRuntime.jobs;
  const waiters = new Map<string, Set<(view: ExperimentAttemptView | null) => void>>();
  const queued = new Map<string, Set<string>>();
  const attemptOperations = sharedRuntime.attemptOperations;
  const queueDrains = new Map<string, Promise<void>>();
  const report = (error: unknown) => {
    if (deps.onError) deps.onError(error instanceof Error ? error : new Error(String(error)));
  };

  const serializeAttempt = async <T>(workspaceId: string, attemptId: string, operation: () => Promise<T>): Promise<T> => {
    const key = attemptKey(workspaceId, attemptId);
    const prior = attemptOperations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(() => gate);
    attemptOperations.set(key, tail);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (attemptOperations.get(key) === tail) attemptOperations.delete(key);
    }
  };

  const recordAllowed = (caller: ExperimentCaller, record: KernelRecordResult): boolean => {
    if (caller.allowedThreadIds === undefined) return true;
    const payload = payloadOf(record);
    const recordRoot = str(payload.rootSessionId);
    if (recordRoot && recordRoot !== callerNamespace(caller)) return false;
    if (record.threadId) return caller.allowedThreadIds.includes(record.threadId);
    const allowedSessions = new Set([caller.sessionId, caller.rootSessionId].filter((value): value is string => !!value));
    return !!record.sessionId && allowedSessions.has(record.sessionId);
  };

  const assertRecordAllowed = (caller: ExperimentCaller, record: KernelRecordResult, noun: string): void => {
    if (!recordAllowed(caller, record)) {
      throw new HarnessServiceError("not-found", `Unknown ${noun}`);
    }
  };

  // Experiment execution is a Host-managed authority (like the process-host
  // service): one service grant per (owning, execution) workspace pair so a
  // detached reconciler can still inspect, stop and collect the jobs it
  // launched. Records live in the owning workspace so facts are shared across
  // roots; the process root and cwd resolve against the actor's execution
  // workspace, whose scope the router already admitted for params.cwd.
  const contextAt = (caller: ExperimentCaller, canonicalRoot: string): Promise<ExperimentContext> => {
    const key = `${caller.workspaceId}\0${caller.executionWorkspaceId}\0${canonicalRoot}`;
    const existing = contexts.get(key);
    if (existing) return existing;
    const creating = (async (): Promise<ExperimentContext> => {
      const grant = await deps.client.issueGrant({
        grantId: `experiment:${randomUUID()}`,
        owningWorkspace: caller.workspaceId,
        executionWorkspace: caller.executionWorkspaceId,
        capabilities: SERVICE_CAPABILITIES,
        pathScopes: [""],
      });
      const scoped = deps.client.scoped(grant);
      const root = await scoped.fileRootRegister({
        workspaceId: caller.workspaceId,
        executionWorkspaceId: caller.executionWorkspaceId,
        canonicalRoot,
      });
      if (typeof root.rootId !== "string") {
        throw new HarnessServiceError("unavailable", "Experiment root registration returned no identity");
      }
      return { scoped, rootId: root.rootId, canonicalRoot };
    })();
    contexts.set(key, creating);
    void creating.catch(() => { if (contexts.get(key) === creating) contexts.delete(key); });
    return creating;
  };

  const context = async (caller: ExperimentCaller): Promise<ExperimentContext> => {
    const resolved = await deps.resolveWorkspaceRoot(caller.executionWorkspaceId);
    if (!resolved) throw new HarnessServiceError("unavailable", `Workspace root is unavailable: ${caller.executionWorkspaceId}`);
    return contextAt(caller, await canonicalizePathIdentity(resolved));
  };

  const recordContext = (workspaceId: string): Promise<ExperimentContext> => {
    const existing = recordContexts.get(workspaceId);
    if (existing) return existing;
    const creating = (async (): Promise<ExperimentContext> => {
      const grant = await deps.client.issueGrant({
        grantId: `experiment-records:${randomUUID()}`,
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        capabilities: SERVICE_CAPABILITIES,
        pathScopes: [""],
      });
      return { scoped: deps.client.scoped(grant), rootId: "", canonicalRoot: "" };
    })();
    recordContexts.set(workspaceId, creating);
    void creating.catch(() => { if (recordContexts.get(workspaceId) === creating) recordContexts.delete(workspaceId); });
    return creating;
  };

  const contextForAttempt = async (
    caller: ExperimentCaller,
    record: KernelRecordResult,
  ): Promise<ExperimentContext> => {
    const executionRoot = str(payloadOf(record).executionCanonicalRoot);
    return executionRoot ? contextAt(caller, await canonicalizePathIdentity(executionRoot)) : recordContext(caller.workspaceId);
  };

  const assertInputPathsCaptured = async (
    ctx: ExperimentContext,
    snapshot: ExperimentInputSnapshot,
    inputs: readonly ExperimentInputRef[],
  ): Promise<void> => {
    const paths = [...new Set(inputs.flatMap((input) => input.path ? [input.path] : []))];
    if (paths.length === 0) return;
    const branch = await ctx.scoped.readBranch({
      branchId: snapshot.branchId,
      paths,
      includeEntries: true,
    });
    if (branch.root !== snapshot.root || branch.currentRoot !== snapshot.root) {
      throw new HarnessServiceError("unavailable", "Experiment input snapshot changed before spec persistence");
    }
    const captured = new Set(branch.entries.map((entry) => entry.path));
    for (const inputPath of paths) {
      if (!captured.has(inputPath)) {
        throw new HarnessServiceError("invalid-params", `Experiment input path was not captured: ${inputPath}`);
      }
    }
  };

  /**
   * Backend resolution: the machine record (when registered) tells which
   * backend kind the target is reached through; the resolver returns a
   * backend bound to a real execution site or null — never a fallback that
   * runs the job on a different machine than requested.
   */
  const resolveBackend = async (
    ctx: ExperimentContext,
    caller: ExperimentCaller,
    machineId: string,
  ): Promise<ResolvedExperimentBackend | null> => {
    const machine = machineId === LOCAL_MACHINE_ID
      ? null
      : await deps.resources.getMachineRecord(caller.workspaceId, machineId).catch(() => null);
    if (deps.resolveBackend) {
      const resolved = await deps.resolveBackend(ctx, machineId, machine, caller);
      if (resolved || machineId !== LOCAL_MACHINE_ID) return resolved;
    }
    if (machineId !== LOCAL_MACHINE_ID) return null;
    return {
      backend: createLocalExperimentBackend(ctx.scoped),
      site: {
        workspaceId: caller.workspaceId,
        rootId: ctx.rootId,
        canonicalRoot: ctx.canonicalRoot,
        transport: ctx.scoped,
      },
      prepare: async ({ attemptId, input }) => {
        const materialized = await materializeExperimentAttempt(deps.client, caller, attemptId, input);
        return {
          backend: createLocalExperimentBackend(materialized.scoped),
          site: {
            workspaceId: caller.workspaceId,
            rootId: materialized.rootId,
            canonicalRoot: materialized.canonicalRoot,
            transport: materialized.scoped,
          },
          cwd: materialized.cwd,
          inputRoot: materialized.snapshotRoot,
        };
      },
    };
  };

  const machineCanConfirm = (machine: ResourceMachineView, request: ExperimentResourceRequest): boolean => {
    if (machine.state !== "available" || machine.connection.status !== "connected") return false;
    const active = machine.commitments.filter((item) => item.state === "confirmed" || item.state === "requested");
    const reserved = (key: "cpuCores" | "memoryMb" | "gpuCount" | "gpuMemoryMb") => (
      active.reduce((total, item) => total + (item.resources[key] ?? 0), 0)
    );
    if ((request.cpuCores ?? 0) > 0
      && (machine.capacity?.cpuCores === undefined
        || machine.capacity.cpuCores - reserved("cpuCores") < request.cpuCores!)) return false;
    if ((request.memoryMb ?? 0) > 0
      && (machine.capacity?.memoryMb === undefined
        || machine.capacity.memoryMb - reserved("memoryMb") < request.memoryMb!)) return false;
    const gpuRequested = (request.gpuCount ?? 0) > 0 || (request.gpuMemoryMb ?? 0) > 0;
    if (gpuRequested) {
      if (machine.gpuProbe?.status !== "available" || !machine.capacity?.gpus?.length) return false;
      const held = new Set(active.flatMap((item) => item.gpuAllocation?.devices.map((device) => device.uuid) ?? []));
      const available = machine.capacity.gpus.filter((device) => device.uuid && !held.has(device.uuid));
      if (available.length < Math.max(1, request.gpuCount ?? 0)) return false;
      if ((request.gpuMemoryMb ?? 0) > 0) {
        const usageByUuid = new Map(
          (machine.usage?.gpus ?? []).flatMap((device) => device.uuid
            ? [[device.uuid, device.usedMemoryMb] as const]
            : []),
        );
        if (!available.some((device) => {
          const used = device.uuid ? usageByUuid.get(device.uuid) : undefined;
          return device.memoryMb !== undefined && used !== undefined
            && device.memoryMb - used >= request.gpuMemoryMb!;
        })) return false;
      }
    }
    return true;
  };

  const selectMachine = async (
    workspaceId: string,
    request: ExperimentResourceRequest,
    explicit?: string,
    recorded?: string,
  ): Promise<string> => {
    if (explicit) return explicit;
    if (recorded) return recorded;
    const candidates = (await deps.resources.listMachines(workspaceId))
      .filter((machine) => machineCanConfirm(machine, request))
      .sort((left, right) => {
        const leftLocal = left.machineId === LOCAL_MACHINE_ID ? 0 : 1;
        const rightLocal = right.machineId === LOCAL_MACHINE_ID ? 0 : 1;
        return leftLocal - rightLocal || left.machineId.localeCompare(right.machineId);
      });
    return candidates[0]?.machineId ?? LOCAL_MACHINE_ID;
  };

  const putRecord = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    input: {
      recordId: string;
      recordType: string;
      state: string;
      payload: Record<string, unknown>;
      references?: Array<{ slot: string; objectHash: string }>;
      ownerIds?: string[];
      expectedRecordRevision?: number;
    },
  ): Promise<KernelRecordResult> => ctx.scoped.putRecord({
    operationId: `${input.recordType}:${randomUUID()}`,
    recordId: input.recordId,
    workspaceId,
    recordType: input.recordType,
    state: input.state,
    payloadJson: JSON.stringify(input.payload),
    ownerIds: input.ownerIds ?? [],
    references: input.references ?? [],
    ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
    ...(caller.threadId ? { threadId: caller.threadId } : {}),
    ...(caller.runId ? { runId: caller.runId } : {}),
    ...(input.expectedRecordRevision === undefined ? {} : { expectedRecordRevision: input.expectedRecordRevision }),
  });

  const getAttemptRecord = (ctx: ExperimentContext, workspaceId: string, attemptId: string) => (
    ctx.scoped.getRecord(workspaceId, recordIdFor.attempt(attemptId))
  );

  const updateAttempt = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    state: ExperimentAttemptState,
    mutate: (payload: Record<string, unknown>) => Record<string, unknown>,
    onlyIf?: (current: ExperimentAttemptView) => boolean,
  ): Promise<KernelRecordResult> => {
    let existing = await getAttemptRecord(ctx, workspaceId, attemptId);
    for (;;) {
      if (!existing) throw new HarnessServiceError("not-found", `Unknown experiment attempt: ${attemptId}`);
      const current = attemptView(existing);
      if (!current) throw new HarnessServiceError("failed", `Experiment attempt is unreadable: ${attemptId}`);
      if (onlyIf && !onlyIf(current)) return existing;
      try {
        const record = await putRecord(ctx, workspaceId, recordCaller(workspaceId, existing), {
          recordId: existing.recordId,
          recordType: "experiment.attempt",
          state,
          expectedRecordRevision: existing.recordRevision,
          payload: mutate(payloadOf(existing)),
        });
        const view = attemptView(record);
        notify(workspaceId, attemptId, view);
        try { deps.onAttemptChanged?.(workspaceId); } catch { /* observer errors must not break writes */ }
        return record;
      } catch (error) {
        const refreshed = await getAttemptRecord(ctx, workspaceId, attemptId).catch(() => null);
        if (refreshed && refreshed.recordRevision !== existing.recordRevision) {
          existing = refreshed;
          continue;
        }
        throw error;
      }
    }
  };

  const deliverNotification = (workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => {
    if (!view || !TERMINAL.has(view.state)) return;
    const key = attemptKey(workspaceId, attemptId);
    const pending = waiters.get(key);
    if (!pending) return;
    waiters.delete(key);
    for (const resolve of pending) resolve(view);
  };
  sharedRuntime.listeners.add(deliverNotification);

  const notify = (workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => {
    for (const listener of sharedRuntime.listeners) listener(workspaceId, attemptId, view);
  };

  const logChunkArtifactId = (
    attemptId: string,
    stream: "stdout" | "stderr",
    streamOffset: number,
  ): string => `${attemptId}:log:${stream}:${streamOffset}`;

  const persistLogChunk = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    stream: "stdout" | "stderr",
    streamOffset: number,
    bytes: Buffer,
  ): Promise<void> => {
    if (bytes.byteLength === 0) return;
    const artifactId = logChunkArtifactId(attemptId, stream, streamOffset);
    const recordId = recordIdFor.artifact(artifactId);
    const expectedHash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
    const prior = await ctx.scoped.getRecord(workspaceId, recordId);
    if (prior?.state === "available") {
      const payload = payloadOf(prior);
      const content = prior.references.find((reference) => reference.slot === "content");
      const priorLength = num(payload.byteLength);
      if (num(payload.streamOffset) !== streamOffset || priorLength === undefined || !content?.objectHash) {
        throw new Error(`Durable ${stream} chunk conflicts at byte ${streamOffset}`);
      }
      if (priorLength > bytes.byteLength) {
        throw new Error(`Durable ${stream} chunk extends beyond the replayed page at byte ${streamOffset}`);
      }
      const priorBytes = await ctx.scoped.getBlob(
        content.objectHash,
        { recordId: prior.recordId, slot: "content" },
      );
      const retained = Buffer.from(priorBytes.bytesBase64, "base64");
      if (!retained.equals(bytes.subarray(0, priorLength))) {
        throw new Error(`Durable ${stream} chunk content conflicts at byte ${streamOffset}`);
      }
      if (priorLength < bytes.byteLength) {
        await persistLogChunk(
          ctx, workspaceId, caller, attemptId, stream,
          streamOffset + priorLength, bytes.subarray(priorLength),
        );
      }
      return;
    }
    const blob = await ctx.scoped.putBlob(bytes, `experiment-log-chunk:${randomUUID()}`);
    try {
      await putRecord(ctx, workspaceId, caller, {
        recordId,
        recordType: "experiment.artifact",
        state: "available",
        ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
        ownerIds: [blob.ownerId],
        references: [{ slot: "content", objectHash: blob.hash }],
        payload: {
          id: artifactId,
          attemptId,
          name: `${stream} chunk ${streamOffset}`,
          kind: stream,
          internalLogChunk: true,
          stream,
          streamOffset,
          byteLength: bytes.byteLength,
          collectedAt: now(),
        },
      });
    } catch (error) {
      const raced = await ctx.scoped.getRecord(workspaceId, recordId).catch(() => null);
      const payload = raced ? payloadOf(raced) : null;
      const content = raced?.references.find((reference) => reference.slot === "content");
      await ctx.scoped.releaseBlob(blob.ownerId).catch(() => undefined);
      if (raced?.state === "available" && num(payload?.streamOffset) === streamOffset
        && num(payload?.byteLength) === bytes.byteLength && content?.objectHash === expectedHash) return;
      throw error;
    }
  };

  const listLogChunks = async (
    ctx: ExperimentContext,
    workspaceId: string,
    attemptId: string,
    stream: "stdout" | "stderr",
  ): Promise<Array<{ record: KernelRecordResult; offset: number; byteLength: number; objectHash: string }>> => {
    const chunks: Array<{ record: KernelRecordResult; offset: number; byteLength: number; objectHash: string }> = [];
    let cursor: number | undefined;
    do {
      const page = await ctx.scoped.listRecords({
        workspaceId,
        recordType: "experiment.artifact",
        pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        const payload = payloadOf(record);
        if (payload.internalLogChunk !== true || str(payload.attemptId) !== attemptId || payload.stream !== stream) continue;
        const offset = num(payload.streamOffset);
        const byteLength = num(payload.byteLength);
        const objectHash = record.references.find((reference) => reference.slot === "content")?.objectHash;
        if (offset !== undefined && byteLength !== undefined && objectHash) {
          chunks.push({ record, offset, byteLength, objectHash });
        }
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    chunks.sort((left, right) => left.offset - right.offset);
    return chunks;
  };

  const readLogRange = async (
    ctx: ExperimentContext,
    workspaceId: string,
    attemptId: string,
    stream: "stdout" | "stderr",
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; total: number; nextOffset: number; eof: boolean }> => {
    const chunks = await listLogChunks(ctx, workspaceId, attemptId, stream);
    const total = chunks.reduce((end, chunk) => Math.max(end, chunk.offset + chunk.byteLength), 0);
    const start = Math.min(Math.max(0, offset), total);
    const end = Math.min(total, start + Math.max(0, length));
    const parts: Buffer[] = [];
    let covered = start;
    for (const chunk of chunks) {
      const chunkEnd = chunk.offset + chunk.byteLength;
      if (chunkEnd <= start || chunk.offset >= end) continue;
      const rangeStart = Math.max(start, chunk.offset);
      const rangeEnd = Math.min(end, chunkEnd);
      if (rangeStart !== covered) {
        throw new HarnessServiceError("unavailable", `${stream} has a missing durable page at byte ${covered}`);
      }
      const page = await ctx.scoped.getBlob(
        chunk.objectHash,
        { recordId: chunk.record.recordId, slot: "content" },
        {
          offset: rangeStart - chunk.offset,
          length: rangeEnd - rangeStart,
          ...(signal ? { signal } : {}),
        },
      );
      const bytes = Buffer.from(page.bytesBase64, "base64");
      if (bytes.byteLength !== rangeEnd - rangeStart) {
        throw new HarnessServiceError("unavailable", `${stream} durable page is incomplete at byte ${rangeStart}`);
      }
      parts.push(bytes);
      covered = rangeEnd;
      if (covered >= end) break;
    }
    if (covered !== end) {
      throw new HarnessServiceError("unavailable", `${stream} has a missing durable page at byte ${covered}`);
    }
    return { bytes: Buffer.concat(parts), total, nextOffset: end, eof: end >= total };
  };

  const readArtifactRange = async (
    ctx: ExperimentContext,
    workspaceId: string,
    record: KernelRecordResult,
    artifact: ExperimentArtifactView,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Buffer; total: number; nextOffset: number; eof: boolean }> => {
    const payload = payloadOf(record);
    if (payload.chunked === true && (artifact.kind === "stdout" || artifact.kind === "stderr")) {
      return readLogRange(ctx, workspaceId, artifact.attemptId, artifact.kind, offset, length, signal);
    }
    if (!artifact.objectHash) {
      throw new HarnessServiceError("unavailable", `Artifact ${artifact.artifactId} has no durable content reference`);
    }
    const page = await ctx.scoped.getBlob(
      artifact.objectHash,
      { recordId: record.recordId, slot: "content" },
      { offset, length, ...(signal ? { signal } : {}) },
    );
    const bytes = Buffer.from(page.bytesBase64, "base64");
    const total = artifact.byteLength ?? (page.eof ? offset + bytes.byteLength : page.nextOffset);
    return { bytes, total, nextOffset: page.nextOffset, eof: page.eof };
  };

  const persistLogManifest = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    stream: "stdout" | "stderr",
    byteLength: number,
  ): Promise<ExperimentArtifactView | null> => {
    if (byteLength === 0) return null;
    const artifactId = artifactIdFor(attemptId, stream);
    const recordId = recordIdFor.artifact(artifactId);
    const prior = await ctx.scoped.getRecord(workspaceId, recordId);
    const record = await putRecord(ctx, workspaceId, prior ? recordCaller(workspaceId, prior) : caller, {
      recordId,
      recordType: "experiment.artifact",
      state: "available",
      ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
      payload: {
        id: artifactId,
        attemptId,
        name: stream,
        kind: stream,
        chunked: true,
        byteLength,
        collectedAt: now(),
      },
    });
    return artifactView(record);
  };

  const persistArtifacts = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    spec: ExperimentSpecView,
    resolved: Pick<ResolvedExperimentBackend, "backend" | "site">,
    running: RunningJob | null,
  ): Promise<ExperimentArtifactView[]> => {
    const artifacts: ExperimentArtifactView[] = [];
    const persistBlob = async (
      name: string,
      kind: ExperimentArtifactView["kind"],
      bytes: Buffer,
      extra: Record<string, unknown> = {},
    ) => {
      const artifactId = artifactIdFor(attemptId, name);
      const recordId = recordIdFor.artifact(artifactId);
      const prior = await ctx.scoped.getRecord(workspaceId, recordId);
      if (prior && prior.state === "available") {
        const existing = artifactView(prior);
        if (existing) { artifacts.push(existing); return; }
      }
      try {
        const blob = await ctx.scoped.putBlob(bytes, `experiment-artifact:${randomUUID()}`);
        const record = await putRecord(ctx, workspaceId, caller, {
          recordId,
          recordType: "experiment.artifact",
          state: "available",
          ownerIds: [blob.ownerId],
          references: [{ slot: "content", objectHash: blob.hash }],
          ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
          payload: {
            id: artifactId,
            attemptId,
            name,
            kind,
            byteLength: bytes.byteLength,
            collectedAt: now(),
            ...extra,
          },
        });
        const view = artifactView(record);
        if (view) artifacts.push(view);
      } catch (error) {
        const record = await putRecord(ctx, workspaceId, caller, {
          recordId,
          recordType: "experiment.artifact",
          state: "failed",
          ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
          payload: {
            id: artifactId, attemptId, name, kind,
            collectedAt: now(), error: errorMessage(error),
            ...extra,
          },
        }).catch(() => null);
        const view = record ? artifactView(record) : null;
        artifacts.push(view ?? {
          artifactId, attemptId, name, kind, state: "failed", error: errorMessage(error),
        });
      }
    };
    const persistObject = async (
      name: string,
      kind: ExperimentArtifactView["kind"],
      object: { objectHash: string; byteLength: number; ownerId: string },
      extra: Record<string, unknown> = {},
    ) => {
      const artifactId = artifactIdFor(attemptId, name);
      const recordId = recordIdFor.artifact(artifactId);
      const prior = await ctx.scoped.getRecord(workspaceId, recordId);
      if (prior?.state === "available") {
        const existing = artifactView(prior);
        if (existing) artifacts.push(existing);
        return;
      }
      await ctx.scoped.rebindObjectOwner(workspaceId, object.ownerId);
      try {
        const record = await putRecord(ctx, workspaceId, caller, {
          recordId,
          recordType: "experiment.artifact",
          state: "available",
          ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
          ownerIds: [object.ownerId],
          references: [{ slot: "content", objectHash: object.objectHash }],
          payload: {
            id: artifactId,
            attemptId,
            name,
            kind,
            byteLength: object.byteLength,
            collectedAt: now(),
            ...extra,
          },
        });
        const view = artifactView(record);
        if (view) artifacts.push(view);
      } catch (error) {
        await ctx.scoped.releaseBlob(object.ownerId).catch(() => undefined);
        throw error;
      }
    };
    const persistRemoteObject = async (
      name: string,
      kind: ExperimentArtifactView["kind"],
      object: { outputId: string; path: string; objectHash: string; byteLength: number },
    ) => {
      const machineId = resolved.site.machineId;
      if (!machineId) throw new Error("Remote output has no stable target identity");
      const artifactId = artifactIdFor(attemptId, name);
      const recordId = recordIdFor.artifact(artifactId);
      const prior = await ctx.scoped.getRecord(workspaceId, recordId);
      if (prior?.state === "available") {
        const existing = artifactView(prior);
        if (existing) artifacts.push(existing);
        return;
      }
      const record = await putRecord(ctx, workspaceId, caller, {
        recordId,
        recordType: "experiment.artifact",
        state: "available",
        ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
        payload: {
          id: artifactId,
          attemptId,
          name,
          kind,
          path: object.path,
          byteLength: object.byteLength,
          retainedObjectHash: object.objectHash,
          remote: {
            machineId,
            outputId: object.outputId,
            path: object.path,
            retainedBy: "execution-target",
            accessible: "available",
          },
          collectedAt: now(),
        },
      });
      const view = artifactView(record);
      if (view) artifacts.push(view);
    };
    if (running) {
      for (const stream of ["stdout", "stderr"] as const) {
        const manifest = await persistLogManifest(
          ctx, workspaceId, caller, attemptId, stream, running.totals[stream],
        );
        if (manifest) artifacts.push(manifest);
      }
    } else {
      for (const stream of ["stdout", "stderr"] as const) {
        const existing = await ctx.scoped.getRecord(workspaceId, recordIdFor.artifact(artifactIdFor(attemptId, stream)));
        const view = existing ? artifactView(existing) : null;
        if (view) artifacts.push(view);
      }
    }
    for (const relativePath of spec.outputPaths) {
      try {
        const artifactId = artifactIdFor(attemptId, relativePath);
        const prior = await ctx.scoped.getRecord(workspaceId, recordIdFor.artifact(artifactId));
        if (prior?.state === "available") {
          const existing = artifactView(prior);
          if (existing) artifacts.push(existing);
          continue;
        }
        const collected = await resolved.backend.collectFile(
          resolved.site,
          relativePath,
          running?.handle.backendJobId ?? processIdFor(workspaceId, attemptId),
        );
        if (Buffer.isBuffer(collected)) {
          await persistBlob(relativePath, "file", collected, { path: relativePath });
        } else if ("outputId" in collected) {
          await persistRemoteObject(relativePath, "file", collected);
        } else {
          await persistObject(relativePath, "file", collected, { path: relativePath });
        }
      } catch (error) {
        const artifactId = artifactIdFor(attemptId, relativePath);
        const recordId = recordIdFor.artifact(artifactId);
        const prior = await ctx.scoped.getRecord(workspaceId, recordId);
        if (prior?.state === "available") continue;
        const record = await putRecord(ctx, workspaceId, caller, {
          recordId,
          recordType: "experiment.artifact",
          state: "failed",
          ...(prior ? { expectedRecordRevision: prior.recordRevision } : {}),
          payload: {
            id: artifactId, attemptId, name: relativePath, kind: "file",
            path: relativePath, collectedAt: now(), error: errorMessage(error),
          },
        }).catch(() => null);
        if (record) {
          const view = artifactView(record);
          if (view) artifacts.push(view);
        }
      }
    }
    return artifacts;
  };

  const jobStateFor = (observation: BackendObservation): ExperimentJobState => {
    if (observation.status === "cancelled") return "cancelled";
    if (observation.status === "exited") return "exited";
    if (observation.status === "released") return "released";
    if (observation.status === "starting") return "starting";
    if (observation.status === "running") return "running";
    if (observation.status === "unknown") return "unknown";
    return "failed";
  };

  const upsertJob = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    state: ExperimentJobState,
    patch: Record<string, unknown>,
  ): Promise<KernelRecordResult> => {
    const jobId = jobIdFor(attemptId);
    const recordId = recordIdFor.job(jobId);
    let existing = await ctx.scoped.getRecord(workspaceId, recordId);
    for (;;) {
      const priorPayload = existing ? payloadOf(existing) : {
        id: jobId,
        attemptId,
        backend: patch.backend,
      };
      if (existing?.state === state) {
        const unchanged = Object.entries(patch).every(([key, value]) => priorPayload[key] === value);
        if (unchanged) return existing;
      }
      try {
        return await putRecord(ctx, workspaceId, existing ? recordCaller(workspaceId, existing) : caller, {
          recordId,
          recordType: "experiment.job",
          state,
          ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}),
          payload: { ...priorPayload, ...patch },
        });
      } catch (error) {
        const refreshed = await ctx.scoped.getRecord(workspaceId, recordId).catch(() => null);
        if (refreshed && refreshed.recordRevision !== existing?.recordRevision) {
          existing = refreshed;
          continue;
        }
        throw error;
      }
    }
  };

  const releaseFinalizedJob = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    running: RunningJob,
  ): Promise<boolean> => {
    try {
      await running.backend.release(running.site, running.handle.backendJobId);
      await upsertJob(ctx, workspaceId, caller, attemptId, "released", { releasedAt: now() });
      const key = attemptKey(workspaceId, attemptId);
      if (jobs.get(key) === running) jobs.delete(key);
      return true;
    } catch (error) {
      const existing = await ctx.scoped.getRecord(workspaceId, recordIdFor.job(jobIdFor(attemptId))).catch(() => null);
      const knownState = existing ? jobView(existing)?.state : undefined;
      await upsertJob(ctx, workspaceId, caller, attemptId,
        knownState && knownState !== "released" ? knownState : "exited", {
          releaseError: errorMessage(error),
          reason: `backend bookkeeping release failed: ${errorMessage(error)}`,
        }).catch(report);
      report(error);
      return false;
    }
  };

  const releaseTerminalCommitment = async (
    ctx: ExperimentContext,
    workspaceId: string,
    record: KernelRecordResult,
  ): Promise<boolean> => {
    const attempt = attemptView(record);
    const payload = payloadOf(record);
    if (!attempt || attempt.state === "lost" || !TERMINAL.has(attempt.state)) return false;
    const commitmentId = str(payload.commitmentId);
    if (!commitmentId || payload.commitmentReleased === true) return true;
    try {
      await deps.resources.release(workspaceId, commitmentId, "backend confirmed attempt termination");
      await updateAttempt(
        ctx,
        workspaceId,
        recordCaller(workspaceId, record),
        attempt.attemptId,
        attempt.state,
        (current) => ({ ...current, commitmentReleased: true, commitmentReleasedAt: now() }),
        (current) => current.state !== "lost" && TERMINAL.has(current.state),
      );
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  };

  const finalize = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    running: RunningJob,
    observation: BackendObservation,
  ): Promise<void> => serializeAttempt(workspaceId, attemptId, async () => {
    if (observation.status === "unknown" || observation.writerActive) return;
    const attemptRecord = await getAttemptRecord(ctx, workspaceId, attemptId);
    const attempt = attemptRecord ? attemptView(attemptRecord) : null;
    if (!attemptRecord || !attempt) return;
    const owner = recordCaller(workspaceId, attemptRecord);
    const attemptPayload = payloadOf(attemptRecord);
    const jobState = jobStateFor(observation);
    await upsertJob(ctx, workspaceId, owner, attemptId, jobState, {
      backend: running.backend.backend,
      backendJobId: running.handle.backendJobId,
      exitCode: observation.exitCode,
      signal: observation.signal,
      reason: observation.reason,
      endedAt: now(),
    });

    const specRecord = await ctx.scoped.getRecord(workspaceId, recordIdFor.spec(attempt.specId));
    const spec = specRecord ? specView(specRecord) : null;
    let collection: ExperimentAttemptView["collection"] = "failed";
    if (spec) {
      try {
        const artifacts = await persistArtifacts(
          ctx, workspaceId, owner, attemptId, spec,
          { backend: running.backend, site: running.site }, running,
        );
        collection = artifacts.some((artifact) => artifact.state === "failed") ? "failed" : "done";
      } catch (error) {
        report(error);
      }
    }

    const persistedCancel = attempt.state === "stopping" || attemptPayload.cancelRequested === true;
    const finalState: ExperimentAttemptState = TERMINAL.has(attempt.state) ? attempt.state
      : persistedCancel || observation.status === "cancelled" ? "cancelled"
      : observation.status === "exited" && observation.exitCode === 0 ? "completed"
      : "failed";
    const updated = await updateAttempt(ctx, workspaceId, owner, attemptId, finalState, (payload) => ({
      ...payload,
      exitCode: observation.exitCode,
      signal: observation.signal,
      endedAt: num(payload.endedAt) ?? now(),
      collection,
      ...(observation.reason && finalState !== "completed" ? { error: observation.reason } : {}),
    }));
    running.finalized = true;

    await releaseTerminalCommitment(ctx, workspaceId, updated);
    if (collection === "done") await releaseFinalizedJob(ctx, workspaceId, owner, attemptId, running);
    await drainQueue(workspaceId);
  });

  const poll = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    running: RunningJob,
  ): Promise<void> => {
    for (;;) {
      const key = attemptKey(workspaceId, attemptId);
      if (disposed || running.observerOwner !== serviceToken || jobs.get(key) !== running) return;
      try {
        const result = await running.backend.read(running.site, running.handle.backendJobId, running.cursor);
        const observation = result.observation;
        delete running.lastPollError;
        const nextTotals = { ...running.totals };
        for (const stream of ["stdout", "stderr"] as const) {
          const bytes = Buffer.concat(result.chunks
            .filter((chunk) => chunk.channel === stream)
            .map((chunk) => Buffer.from(chunk.bytesBase64, "base64")));
          if (bytes.byteLength === 0) continue;
          await persistLogChunk(
            ctx, workspaceId, caller, attemptId, stream, running.totals[stream], bytes,
          );
          nextTotals[stream] += bytes.byteLength;
        }
        const observationKey = `${observation.status}\0${observation.reason ?? ""}`;
        if (result.nextCursor !== running.cursor
          || nextTotals.stdout !== running.totals.stdout || nextTotals.stderr !== running.totals.stderr) {
          await upsertJob(ctx, workspaceId, caller, attemptId, jobStateFor(observation), {
            outputCursor: result.nextCursor,
            stdoutBytes: nextTotals.stdout,
            stderrBytes: nextTotals.stderr,
            reason: observation.reason,
          });
          running.lastObservationKey = observationKey;
        }
        if (nextTotals.stdout !== running.totals.stdout || nextTotals.stderr !== running.totals.stderr) {
          // Durable log bytes grew — wake log-source observers (follow-ups).
          const record = await getAttemptRecord(ctx, workspaceId, attemptId).catch(() => null);
          notify(workspaceId, attemptId, record ? attemptView(record) : null);
        }
        running.totals = nextTotals;
        running.cursor = result.nextCursor;
        if (observation.status === "unknown") {
          if (running.lastObservationKey !== observationKey) {
            running.lastObservationKey = observationKey;
            await upsertJob(ctx, workspaceId, caller, attemptId, "unknown", {
              reason: observation.reason ?? "backend state is not currently observable",
            }).catch(report);
          }
          await new Promise((resolve) => setTimeout(resolve, RECONNECT_POLL_MS));
          continue;
        }
        if (!observation.writerActive && running.cursor === result.endCursor) {
          await finalize(ctx, workspaceId, caller, attemptId, running, observation);
          return;
        }
        const state = jobStateFor(observation);
        if ((state === "starting" || state === "running") && running.lastObservationKey !== observationKey) {
          running.lastObservationKey = observationKey;
          await upsertJob(ctx, workspaceId, caller, attemptId, state, { reason: observation.reason }).catch(report);
        }
        if (result.chunks.length > 0 || running.cursor < result.endCursor) continue;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      } catch (error) {
        const message = errorMessage(error);
        if (running.lastPollError !== message) {
          running.lastPollError = message;
          running.lastObservationKey = `error\0${message}`;
          await upsertJob(ctx, workspaceId, caller, attemptId, "unknown", {
            reason: `backend observation or durable output persistence unavailable: ${message}`,
          }).catch(report);
          report(error);
        }
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_POLL_MS));
      }
    }
  };

  const startPolling = (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    running: RunningJob,
  ): void => {
    const key = attemptKey(workspaceId, attemptId);
    if (disposed || jobs.has(key)) return;
    jobs.set(key, running);
    running.poll = poll(ctx, workspaceId, caller, attemptId, running).catch((error) => {
      report(error);
      if (jobs.get(key) === running && !running.finalized) {
        running.poll = poll(ctx, workspaceId, caller, attemptId, running).catch(report);
      }
    });
  };

  const launch = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptRecord: KernelRecordResult,
    preResolved?: ResolvedExperimentBackend,
  ): Promise<void> => {
    const attempt = attemptView(attemptRecord);
    if (!attempt || jobs.has(attemptKey(workspaceId, attempt.attemptId)) || attempt.state !== "submitted") return;
    const payload = payloadOf(attemptRecord);
    const resources = payload.resources && typeof payload.resources === "object"
      ? payload.resources as ExperimentResourceRequest : {};
    const needsAdmission = (["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const)
      .some((key) => (resources[key] ?? 0) > 0);
    if (needsAdmission && !str(payload.commitmentId)) return;
    const specRecord = await ctx.scoped.getRecord(workspaceId, recordIdFor.spec(attempt.specId));
    const spec = specRecord ? specView(specRecord) : null;
    if (!spec) {
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "failed", (p) => ({
        ...p, error: "experiment spec is unavailable", endedAt: now(), collection: "none",
      }), (current) => current.state === "submitted");
      return;
    }
    const inputSnapshot = inputSnapshotOf(specRecord!);
    if (!inputSnapshot) {
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "failed", (p) => ({
        ...p, error: "experiment spec input snapshot is unavailable", endedAt: now(), collection: "none",
      }), (current) => current.state === "submitted");
      return;
    }
    const backendJobId = processIdFor(workspaceId, attempt.attemptId);
    const resolved = preResolved ?? await resolveBackend(ctx, caller, attempt.machineId ?? LOCAL_MACHINE_ID);
    if (!resolved) {
      await upsertJob(ctx, workspaceId, caller, attempt.attemptId, "unknown", {
        backend: attempt.backend,
        machineId: attempt.machineId ?? LOCAL_MACHINE_ID,
        backendJobId,
        reason: "execution backend is unavailable; reconciliation remains pending",
      }).catch(report);
      return;
    }
    let executionBackend: ResolvedExperimentBackend;
    let executionCwd: string;
    try {
      const prepared = await resolved.prepare({ attemptId: attempt.attemptId, input: inputSnapshot });
      executionBackend = {
        backend: prepared.backend ?? resolved.backend,
        site: prepared.site,
        prepare: resolved.prepare,
      };
      executionCwd = prepared.cwd;
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "submitted", (p) => ({
        ...p,
        executionRootId: prepared.site.rootId,
        executionCanonicalRoot: prepared.site.canonicalRoot,
        executionCwd: prepared.cwd,
        inputRoot: prepared.inputRoot,
        materializedAt: num(p.materializedAt) ?? now(),
        materializationReused: prepared.reused === true,
        materializationError: undefined,
      }), (current) => current.state === "submitted");
    } catch (error) {
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "submitted", (p) => ({
        ...p, materializationError: errorMessage(error),
      }), (current) => current.state === "submitted").catch(report);
      report(error);
      return;
    }
    await upsertJob(ctx, workspaceId, caller, attempt.attemptId, "starting", {
      backend: executionBackend.backend.backend,
      machineId: attempt.machineId ?? LOCAL_MACHINE_ID,
      backendJobId,
      startedAt: num(payload.startedAt) ?? now(),
    });
    const specEnv = payloadOf(specRecord!).env;
    const commitmentId = str(payload.commitmentId);
    const gpuAllocation = commitmentId
      ? await deps.resources.getCommitmentAllocation(workspaceId, commitmentId)
      : null;
    const mergedEnv: Record<string, string> = {};
    if (specEnv && typeof specEnv === "object") {
      for (const [name, value] of Object.entries(specEnv)) {
        if (typeof value === "string") mergedEnv[name] = value;
      }
    }
    try {
      const { handle, observation } = await executionBackend.backend.spawn(executionBackend.site, {
        attemptId: attempt.attemptId,
        backendJobId,
        cwd: executionCwd,
        command: spec.command,
        args: spec.args,
        env: Object.entries(mergedEnv)
          .filter(([, value]) => typeof value === "string")
          .map(([name, value]) => ({ name, value })),
        resources,
        ...(gpuAllocation ? { gpuAllocation } : {}),
      });
      const actualSite = handle.executionRootId && handle.executionCanonicalRoot
        ? {
            ...executionBackend.site,
            rootId: handle.executionRootId,
            canonicalRoot: handle.executionCanonicalRoot,
          }
        : executionBackend.site;
      await upsertJob(ctx, workspaceId, caller, attempt.attemptId, jobStateFor(observation), {
        backend: executionBackend.backend.backend,
        machineId: attempt.machineId ?? LOCAL_MACHINE_ID,
        backendJobId: handle.backendJobId,
        kernelEpoch: handle.kernelEpoch,
        pid: handle.pid,
        executionRootId: handle.executionRootId,
        executionCanonicalRoot: handle.executionCanonicalRoot,
        executionCwd: handle.executionCwd,
        startedAt: num(payload.startedAt) ?? now(),
        reason: observation.reason,
      });
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "running", (p) => ({
        ...p,
        backend: executionBackend.backend.backend,
        ...(handle.executionRootId ? { executionRootId: handle.executionRootId } : {}),
        ...(handle.executionCanonicalRoot ? { executionCanonicalRoot: handle.executionCanonicalRoot } : {}),
        ...(handle.executionCwd !== undefined ? { executionCwd: handle.executionCwd } : {}),
        startedAt: num(p.startedAt) ?? now(),
        error: undefined,
      }), (current) => current.state === "submitted");
      const refreshed = await getAttemptRecord(ctx, workspaceId, attempt.attemptId);
      const refreshedView = refreshed ? attemptView(refreshed) : null;
      const running: RunningJob = {
        backend: executionBackend.backend,
        site: actualSite,
        handle,
        cursor: 0,
        totals: { stdout: 0, stderr: 0 },
        cancelRequested: refreshedView?.state === "stopping" || payloadOf(refreshed ?? attemptRecord).cancelRequested === true,
        finalized: false,
        observerOwner: serviceToken,
        poll: Promise.resolve(),
      };
      startPolling(ctx, workspaceId, recordCaller(workspaceId, refreshed ?? attemptRecord), attempt.attemptId, running);
    } catch (error) {
      const message = errorMessage(error);
      await upsertJob(ctx, workspaceId, caller, attempt.attemptId, "unknown", {
        backend: executionBackend.backend.backend,
        machineId: attempt.machineId ?? LOCAL_MACHINE_ID,
        backendJobId,
        reason: `submit response unavailable: ${message}`,
        lastObservedAt: now(),
      }).catch(report);
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "submitted", (p) => ({
        ...p, reconciliationError: message,
      }), (current) => current.state === "submitted").catch(report);
      report(error);
    }
  };

  const drainQueue = async (workspaceId: string): Promise<void> => {
    const existing = queueDrains.get(workspaceId);
    if (existing) return existing;
    const draining = (async () => {
      const pending = queued.get(workspaceId);
      if (!pending || pending.size === 0) return;
      for (const attemptId of [...pending]) {
        await serializeAttempt(workspaceId, attemptId, async () => {
          let admissionCommitment: string | undefined;
          try {
            const scanCtx = await recordContext(workspaceId);
            const record = await getAttemptRecord(scanCtx, workspaceId, attemptId);
            const attempt = record ? attemptView(record) : null;
            if (!attempt || !record || attempt.state !== "queued") {
              pending.delete(attemptId);
              return;
            }
            const owner = recordCaller(workspaceId, record);
            const ctx = await contextForAttempt(owner, record);
            const resources = (payloadOf(record).resources ?? {}) as ExperimentResourceRequest;
            const admission = await deps.resources.admit(workspaceId, attempt.machineId ?? LOCAL_MACHINE_ID, resources, attemptId);
            if (admission.status !== "confirmed") return;
            const commitmentId = admission.commitmentId;
            if (!commitmentId) throw new Error("Resource admission returned no commitment identity");
            admissionCommitment = commitmentId;
            const current = await getAttemptRecord(ctx, workspaceId, attemptId);
            const currentView = current ? attemptView(current) : null;
            if (!current || currentView?.state !== "queued") {
              await deps.resources.release(workspaceId, commitmentId, "queued attempt changed before admission commit");
              pending.delete(attemptId);
              return;
            }
            const admitted = await updateAttempt(ctx, workspaceId, owner, attemptId, "submitted", (p) => ({
              ...p, commitmentId, admissionState: "confirmed", queueReason: undefined,
            }), (view) => view.state === "queued");
            if (attemptView(admitted)?.state !== "submitted") {
              await deps.resources.release(workspaceId, commitmentId, "queued attempt was cancelled during admission");
              pending.delete(attemptId);
              return;
            }
            pending.delete(attemptId);
            await launch(ctx, workspaceId, owner, admitted);
          } catch (error) {
            if (admissionCommitment) {
              await deps.resources.release(workspaceId, admissionCommitment, "admission transition failed").catch(report);
            }
            report(error);
          }
        });
      }
    })();
    queueDrains.set(workspaceId, draining);
    try {
      await draining;
    } finally {
      if (queueDrains.get(workspaceId) === draining) queueDrains.delete(workspaceId);
    }
  };

  const resolveCwd = async (
    canonicalRoot: string,
    cwd: string | undefined,
    scope: readonly string[] | undefined,
  ): Promise<string> => {
    if (cwd === undefined) return "";
    const absolute = await canonicalizePathIdentity(cwd);
    if (absolute !== canonicalRoot && !absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new HarnessServiceError("forbidden", `Experiment cwd is outside the workspace root: ${cwd}`);
    }
    const relative = path.relative(canonicalRoot, absolute).replaceAll("\\", "/");
    if (scope?.length) {
      const allowed = scope.some((entry) => relative === "" || relative === entry || relative.startsWith(`${entry}/`));
      if (!allowed) throw new HarnessServiceError("forbidden", `Experiment cwd is outside the actor scope: ${cwd}`);
    }
    return relative;
  };

  const resolveInputs = async (
    caller: ExperimentCaller,
    inputs: readonly ExperimentInputRef[] | undefined,
  ): Promise<ExperimentInputRef[]> => {
    const resolved: ExperimentInputRef[] = [];
    for (const input of inputs ?? []) {
      const entry: ExperimentInputRef = { ...(input.role ? { role: input.role } : {}) };
      if (input.sourceId) {
        if (!deps.sources) throw new HarnessServiceError("unavailable", "Research source records are unavailable");
        const source = await deps.sources.get(caller.workspaceId, input.sourceId, caller);
        if (!source || source.state !== "available") {
          throw new HarnessServiceError("not-found", `Unknown or retired research source: ${input.sourceId}`);
        }
        entry.sourceId = source.sourceId;
        if (!input.path && source.path) entry.path = source.path;
        if (!input.objectHash && source.objectHash) entry.objectHash = source.objectHash;
        if (!source.path && !source.objectHash) {
          throw new HarnessServiceError(
            "invalid-params",
            `Research source ${input.sourceId} is external provenance only; fetch or register fixed local/object content before execution`,
          );
        }
      }
      if (input.path) {
        if (path.isAbsolute(input.path) || input.path.includes("..") || input.path.includes("\0")) {
          throw new HarnessServiceError("invalid-params", `Input path must stay inside the workspace: ${input.path}`);
        }
        entry.path = input.path.replaceAll("\\", "/");
      }
      if (entry.path) {
        if (path.isAbsolute(entry.path) || entry.path.includes("\0") || entry.path.split("/").includes("..")) {
          throw new HarnessServiceError("invalid-params", `Input path must stay inside the workspace: ${entry.path}`);
        }
        entry.path = entry.path.replaceAll("\\", "/");
        if (caller.workspaceScope?.length && !caller.workspaceScope.some((scope) => (
          scope === "" || entry.path === scope || entry.path!.startsWith(`${scope}/`)
        ))) {
          throw new HarnessServiceError("forbidden", `Experiment input is outside the actor scope: ${entry.path}`);
        }
      }
      if (input.objectHash) {
        if (!input.objectHash.startsWith("sha256-")) {
          throw new HarnessServiceError("invalid-params", "Input objectHash must be a sha256- reference");
        }
        entry.objectHash = input.objectHash;
      }
      if (entry.objectHash && !entry.path) {
        throw new HarnessServiceError(
          "invalid-params",
          "Object-only experiment inputs are not materialized into the process workspace; provide a fixed workspace path",
        );
      }
      if (!entry.sourceId && !entry.path && !entry.objectHash) {
        throw new HarnessServiceError("invalid-params", "Experiment input requires a sourceId, path or objectHash");
      }
      resolved.push(entry);
    }
    return resolved;
  };

  const recordCaller = (workspaceId: string, record: KernelRecordResult): ExperimentCaller => {
    const payload = payloadOf(record);
    const rootSessionId = str(payload.rootSessionId);
    return {
      workspaceId,
      executionWorkspaceId: str(payload.executionWorkspaceId) ?? workspaceId,
      ...(rootSessionId ? { rootSessionId } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.threadId ? { threadId: record.threadId } : {}),
      ...(record.runId ? { runId: record.runId } : {}),
    };
  };

  const ensureReconciled = async (workspaceId: string): Promise<void> => {
    const existing = reconciliations.get(workspaceId);
    if (existing) return existing;
    const reconciliation = (async () => {
      const ctx = await recordContext(workspaceId);
      const all: KernelRecordResult[] = [];
      let cursor: number | undefined;
      do {
        const page = await ctx.scoped.listRecords({
          workspaceId, recordType: "experiment.attempt", pageSize: 128,
          ...(cursor === undefined ? {} : { cursor }),
        });
        all.push(...page.records);
        cursor = page.nextCursor === null ? undefined : page.nextCursor;
      } while (cursor !== undefined);
      for (const record of all) {
        const attempt = attemptView(record);
        if (!attempt || attempt.state === "lost") continue;
        const caller = recordCaller(workspaceId, record);
        try {
          const attemptCtx = await contextForAttempt(caller, record);
          await reconcileAttempt(attemptCtx, workspaceId, caller, record);
        } catch (error) {
          report(new Error(`attempt ${attempt.attemptId} reconciliation is pending: ${errorMessage(error)}`));
        }
      }
      void drainQueue(workspaceId).catch(report);
    })();
    reconciliations.set(workspaceId, reconciliation);
    try {
      await reconciliation;
    } catch (error) {
      report(error);
    } finally {
      if (reconciliations.get(workspaceId) === reconciliation) reconciliations.delete(workspaceId);
    }
  };

  const submitUnsafe = async (
    caller: ExperimentCaller,
    params: ExperimentSubmitParams,
    signal?: AbortSignal,
  ): Promise<{ spec: ExperimentSpecView; attempt: ExperimentAttemptView; text: string }> => {
    signal?.throwIfAborted();
    await waitWithSignal(ensureReconciled(caller.workspaceId), signal);
    const ctx = await waitWithSignal(params.specId !== undefined ? recordContext(caller.workspaceId) : context(caller), signal);
    if (params.specId !== undefined) {
      if (params.command !== undefined || params.args !== undefined || params.inputs !== undefined
        || params.resources !== undefined || params.outputPaths !== undefined || params.env !== undefined
        || params.cwd !== undefined) {
        throw new HarnessServiceError("invalid-params", "specId cannot be combined with inline spec fields");
      }
    }
    let specRecord: KernelRecordResult;
    let spec: ExperimentSpecView | null;
    if (params.specId !== undefined) {
      const found = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(params.specId));
      spec = found ? specView(found) : null;
      if (!spec || spec.state !== "active") {
        throw new HarnessServiceError("not-found", `Unknown or retired experiment spec: ${params.specId}`);
      }
      assertRecordAllowed(caller, found!, `experiment spec: ${params.specId}`);
      specRecord = found!;
    } else {
      const command = typeof params.command === "string" ? params.command.trim() : "";
      if (!command) throw new HarnessServiceError("invalid-params", "experiment submit requires a command");
      const args = params.args ?? [];
      if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
        throw new HarnessServiceError("invalid-params", "experiment args must be a string array");
      }
      const env = params.env ?? {};
      if (!Object.values(env).every((value) => typeof value === "string")) {
        throw new HarnessServiceError("invalid-params", "experiment env values must be strings");
      }
      const cwd = await resolveCwd(ctx.canonicalRoot, params.cwd, caller.workspaceScope);
      const inputs = await resolveInputs(caller, params.inputs);
      const outputPaths = (params.outputPaths ?? []).map((entry) => {
        if (typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry) || entry.includes("..")) {
          throw new HarnessServiceError("invalid-params", `Invalid experiment output path: ${String(entry)}`);
        }
        return entry.replaceAll("\\", "/");
      });
      const inputSnapshot = await prepareExperimentInput(deps.client, caller, ctx.canonicalRoot, {
        captureScopes: caller.workspaceScope ?? [],
        ...(cwd ? { cwd } : {}),
        ...(signal ? { signal } : {}),
      });
      try {
        await assertInputPathsCaptured(ctx, inputSnapshot, inputs);
        signal?.throwIfAborted();
      } catch (error) {
        await ctx.scoped.deleteBranch({
          operationId: `experiment-input-discard:${randomUUID()}`,
          branchId: inputSnapshot.branchId,
        }).catch(report);
        throw error;
      }
      const contentDigest = specDigest({
        command, args, cwd, env, inputs, outputPaths,
        ...(params.resources ? { resources: params.resources } : {}),
        inputRoot: inputSnapshot.root,
      });
      const specId = `spec-${digestId(caller.workspaceId, callerNamespace(caller), contentDigest).slice(0, 40)}`;
      const existing = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(specId));
      if (existing) {
        assertRecordAllowed(caller, existing, `experiment spec: ${specId}`);
        if (str(payloadOf(existing).contentDigest) !== contentDigest) {
          throw new HarnessServiceError("failed", `Experiment spec identity collision: ${specId}`);
        }
        const persistedInput = inputSnapshotOf(existing);
        if (!persistedInput) throw new HarnessServiceError("unavailable", `Experiment spec has no durable input snapshot: ${specId}`);
        if (persistedInput.branchId !== inputSnapshot.branchId) {
          await ctx.scoped.deleteBranch({
            operationId: `experiment-input-deduplicate:${randomUUID()}`,
            branchId: inputSnapshot.branchId,
          }).catch(report);
        }
        spec = specView(existing);
        specRecord = existing;
      } else {
        try {
          specRecord = await putRecord(ctx, caller.workspaceId, caller, {
            recordId: recordIdFor.spec(specId),
            recordType: "experiment.spec",
            state: "active",
            payload: {
              id: specId,
              workspaceId: caller.workspaceId,
              rootSessionId: callerNamespace(caller),
              contentDigest,
              ...(params.title?.trim() ? { title: params.title.trim() } : {}),
              command,
              args,
              ...(cwd ? { cwd } : {}),
              env,
              inputs,
              inputSnapshot,
              ...(params.resources ? { resources: params.resources } : {}),
              outputPaths,
              createdAt: now(),
            },
            references: inputs.flatMap((input, index) => input.objectHash
              ? [{ slot: `input:${index}`, objectHash: input.objectHash }]
              : []),
          });
        } catch (error) {
          const raced = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(specId));
          if (!raced) throw error;
          assertRecordAllowed(caller, raced, `experiment spec: ${specId}`);
          if (str(payloadOf(raced).contentDigest) !== contentDigest) throw error;
          if (inputSnapshotOf(raced)?.branchId !== inputSnapshot.branchId) {
            await ctx.scoped.deleteBranch({
              operationId: `experiment-input-race-discard:${randomUUID()}`,
              branchId: inputSnapshot.branchId,
            }).catch(report);
          }
          specRecord = raced;
        }
        spec = specView(specRecord);
      }
      if (!spec) throw new HarnessServiceError("failed", "experiment spec record is unreadable");
    }
    if (!inputSnapshotOf(specRecord)) {
      throw new HarnessServiceError("unavailable", `Experiment spec has no durable input snapshot: ${spec.specId}`);
    }
    let retryOfAttemptId: string | undefined;
    if (params.retryOfAttemptId !== undefined) {
      retryOfAttemptId = params.retryOfAttemptId.trim();
      if (!retryOfAttemptId) throw new HarnessServiceError("invalid-params", "retryOfAttemptId cannot be empty");
      const priorRecord = await getAttemptRecord(ctx, caller.workspaceId, retryOfAttemptId);
      const prior = priorRecord ? attemptView(priorRecord) : null;
      if (!priorRecord || !prior) throw new HarnessServiceError("not-found", `Unknown retry source attempt: ${retryOfAttemptId}`);
      assertRecordAllowed(caller, priorRecord, `experiment attempt: ${retryOfAttemptId}`);
      if (prior.specId !== spec.specId) {
        throw new HarnessServiceError("invalid-params", `Retry source ${retryOfAttemptId} uses a different experiment spec`);
      }
    }
    const attemptId = params.requestId ? attemptIdForRequest(caller, params.requestId) : `attempt-${randomUUID()}`;
    // A retried submit response must keep the target already recorded for this
    // request. New implicit placement uses only currently confirmable capacity,
    // prefers local when equally suitable, and is persisted on the attempt so
    // queue reconciliation never reselects a different Host.
    const recordedAttempt = params.requestId
      ? await getAttemptRecord(ctx, caller.workspaceId, attemptId).catch(() => null)
      : null;
    const recordedMachineId = recordedAttempt ? attemptView(recordedAttempt)?.machineId : undefined;
    const machineId = await selectMachine(
      caller.workspaceId,
      spec.resources ?? {},
      params.machineId?.trim() || undefined,
      recordedMachineId,
    );
    const machineRecord = machineId === LOCAL_MACHINE_ID
      ? null
      : await deps.resources.getMachineRecord(caller.workspaceId, machineId).catch(() => null);
    if (machineId !== LOCAL_MACHINE_ID && !machineRecord) {
      throw new HarnessServiceError("not-found", `Machine is not registered: ${machineId}`);
    }
    const resolvedBackend = await resolveBackend(ctx, caller, machineId);
    const requestedResources = spec.resources ?? {};
    const needsAdmission = (["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const)
      .some((key) => (requestedResources[key] ?? 0) > 0);
    let createdAttempt = false;
    let recorded = await serializeAttempt(caller.workspaceId, attemptId, async () => {
      const existing = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
      if (existing) {
        assertRecordAllowed(caller, existing, `experiment attempt: ${attemptId}`);
        const prior = attemptView(existing);
        if (!prior) throw new HarnessServiceError("failed", `Experiment attempt is unreadable: ${attemptId}`);
        if (prior.specId !== spec!.specId || (prior.machineId ?? LOCAL_MACHINE_ID) !== machineId
          || (params.requestId !== undefined && prior.requestId !== params.requestId)
          || prior.retryOfAttemptId !== retryOfAttemptId) {
          throw new HarnessServiceError("invalid-params", `requestId ${params.requestId ?? attemptId} is already bound to a different experiment submission`);
        }
        return existing;
      }
      // Once the attempt intent is durable, reconciliation owns its outcome.
      // Before that boundary, cancellation must stop preparation and admission.
      signal?.throwIfAborted();
      try {
        const created = await putRecord(ctx, caller.workspaceId, caller, {
          recordId: recordIdFor.attempt(attemptId),
          recordType: "experiment.attempt",
          state: "submitted",
          payload: {
            id: attemptId,
            specId: spec!.specId,
            backend: resolvedBackend?.backend.backend
              ?? str(machineRecord ? payloadOf(machineRecord).backend : null)
              ?? "unresolved",
            machineId,
            executionWorkspaceId: caller.executionWorkspaceId,
            rootSessionId: callerNamespace(caller),
            ...(params.requestId ? { requestId: params.requestId } : {}),
            ...(retryOfAttemptId ? { retryOfAttemptId } : {}),
            resources: requestedResources,
            admissionState: needsAdmission ? "pending" : "not-required",
            createdAt: now(),
          },
        });
        createdAttempt = true;
        return created;
      } catch (error) {
        const raced = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
        if (!raced) throw error;
        assertRecordAllowed(caller, raced, `experiment attempt: ${attemptId}`);
        const prior = attemptView(raced);
        if (!prior || prior.specId !== spec!.specId || (prior.machineId ?? LOCAL_MACHINE_ID) !== machineId) throw error;
        return raced;
      }
    });
    if (createdAttempt && !resolvedBackend && attemptView(recorded)?.state === "submitted") {
      recorded = await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "failed", (p) => ({
        ...p, error: `no execution backend is registered for machine ${machineId}`, endedAt: now(),
      }), (current) => current.state === "submitted");
    } else if (!TERMINAL.has(attemptView(recorded)!.state)) {
      await reconcileAttempt(ctx, caller.workspaceId, recordCaller(caller.workspaceId, recorded), recorded, resolvedBackend ?? undefined);
    }
    const view = await getAttemptRecord(ctx, caller.workspaceId, attemptId).then((r) => r ? attemptView(r) : null);
    return { spec, attempt: view!, text: describeAttempt(spec, view) };
  };

  const reconcileAttempt = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    record: KernelRecordResult,
    preResolved?: ResolvedExperimentBackend,
  ): Promise<void> => {
    const initial = attemptView(record);
    if (!initial) return;
    await serializeAttempt(workspaceId, initial.attemptId, async () => {
      const fresh = await getAttemptRecord(ctx, workspaceId, initial.attemptId);
      const attempt = fresh ? attemptView(fresh) : null;
      if (!fresh || !attempt || attempt.state === "lost") return;
      const payload = payloadOf(fresh);
      if (TERMINAL.has(attempt.state)) await releaseTerminalCommitment(ctx, workspaceId, fresh);
      const key = attemptKey(workspaceId, attempt.attemptId);
      const existingJob = jobs.get(key);
      if (existingJob) {
        if (TERMINAL.has(attempt.state) && attempt.collection === "done" && existingJob.finalized) {
          await releaseFinalizedJob(ctx, workspaceId, recordCaller(workspaceId, fresh), attempt.attemptId, existingJob);
        }
        return;
      }
      if (attempt.state === "queued") {
        const set = queued.get(workspaceId) ?? new Set<string>();
        set.add(attempt.attemptId);
        queued.set(workspaceId, set);
        void drainQueue(workspaceId).catch(report);
        return;
      }
      const resources = payload.resources && typeof payload.resources === "object"
        ? payload.resources as ExperimentResourceRequest : {};
      const needsAdmission = (["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const)
        .some((dimension) => (resources[dimension] ?? 0) > 0);
      if (attempt.state === "submitted" && needsAdmission && !str(payload.commitmentId)) {
        const admission = await deps.resources.admit(workspaceId, attempt.machineId ?? LOCAL_MACHINE_ID, resources, attempt.attemptId);
        if (admission.status !== "confirmed") {
          const queuedRecord = await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "queued", (p) => ({
            ...p, admissionState: "pending", queueReason: admission.reason ?? "insufficient resources",
          }), (current) => current.state === "submitted");
          if (attemptView(queuedRecord)?.state === "queued") {
            const set = queued.get(workspaceId) ?? new Set<string>();
            set.add(attempt.attemptId);
            queued.set(workspaceId, set);
          }
          return;
        }
        const commitmentId = admission.commitmentId;
        if (!commitmentId) throw new Error("Resource admission returned no commitment identity");
        const latest = await getAttemptRecord(ctx, workspaceId, attempt.attemptId);
        if (attemptView(latest!)?.state !== "submitted") {
          await deps.resources.release(workspaceId, commitmentId, "attempt changed during admission");
          return;
        }
        const admitted = await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "submitted", (p) => ({
          ...p, commitmentId, admissionState: "confirmed", queueReason: undefined,
        }), (current) => current.state === "submitted");
        await launch(ctx, workspaceId, recordCaller(workspaceId, admitted), admitted, preResolved);
        return;
      }
      if (attempt.state === "submitted") {
        await launch(ctx, workspaceId, recordCaller(workspaceId, fresh), fresh, preResolved);
        return;
      }

      const jobRecord = await ctx.scoped.getRecord(workspaceId, recordIdFor.job(jobIdFor(attempt.attemptId))).catch(() => null);
      if (jobRecord?.state === "released") return;
      const resolved = preResolved ?? await resolveBackend(ctx, caller, attempt.machineId ?? LOCAL_MACHINE_ID).catch(() => null);
      if (!resolved) return;
      const executionRootId = str(payload.executionRootId);
      const executionCanonicalRoot = str(payload.executionCanonicalRoot);
      const executionResolved = executionRootId && executionCanonicalRoot
        ? {
            backend: resolved.backend,
            site: { ...resolved.site, rootId: executionRootId, canonicalRoot: executionCanonicalRoot },
            prepare: resolved.prepare,
          }
        : resolved;
      const backendJobId = str(jobRecord ? payloadOf(jobRecord).backendJobId : null)
        ?? processIdFor(workspaceId, attempt.attemptId);
      const jobPayload = jobRecord ? payloadOf(jobRecord) : {};
      const running: RunningJob = {
        backend: executionResolved.backend,
        site: executionResolved.site,
        handle: { backendJobId },
        cursor: num(jobPayload.outputCursor) ?? 0,
        totals: {
          stdout: num(jobPayload.stdoutBytes) ?? 0,
          stderr: num(jobPayload.stderrBytes) ?? 0,
        },
        cancelRequested: attempt.state === "stopping" || payload.cancelRequested === true,
        finalized: TERMINAL.has(attempt.state) && attempt.collection === "done",
        observerOwner: serviceToken,
        poll: Promise.resolve(),
      };
      if (running.finalized) {
        jobs.set(key, running);
        await releaseFinalizedJob(ctx, workspaceId, caller, attempt.attemptId, running);
        return;
      }
      try {
        const observation = await executionResolved.backend.inspect(executionResolved.site, backendJobId);
        if (observation.executionRootId && observation.executionCanonicalRoot) {
          const reconciled = await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, attempt.state, (current) => ({
            ...current,
            executionRootId: observation.executionRootId,
            executionCanonicalRoot: observation.executionCanonicalRoot,
            ...(observation.executionCwd !== undefined ? { executionCwd: observation.executionCwd } : {}),
          }));
          running.site = {
            ...running.site,
            rootId: observation.executionRootId,
            canonicalRoot: observation.executionCanonicalRoot,
          };
          record = reconciled;
        }
        if (observation.status === "unknown") {
          await upsertJob(ctx, workspaceId, caller, attempt.attemptId, "unknown", {
            reason: observation.reason ?? "backend state is not currently observable", lastObservedAt: now(),
          });
          running.lastObservationKey = `unknown\0${observation.reason ?? ""}`;
          startPolling(ctx, workspaceId, caller, attempt.attemptId, running);
          return;
        }
        if (running.cancelRequested && executionResolved.backend.controls.includes("cancel")) {
          await executionResolved.backend.kill(executionResolved.site, backendJobId).catch(async (error) => {
            await upsertJob(ctx, workspaceId, caller, attempt.attemptId, "unknown", {
              reason: `cancel request could not be confirmed: ${errorMessage(error)}`,
            }).catch(report);
          });
        }
        startPolling(ctx, workspaceId, caller, attempt.attemptId, running);
      } catch (error) {
        await upsertJob(ctx, workspaceId, caller, attempt.attemptId, "unknown", {
          reason: `backend job is unreachable; reconciliation remains pending: ${errorMessage(error)}`,
          lastObservedAt: now(),
        }).catch(report);
        running.lastObservationKey = `error\0${errorMessage(error)}`;
        startPolling(ctx, workspaceId, caller, attempt.attemptId, running);
      }
    });
  };

  const submit = async (
    caller: ExperimentCaller,
    params: ExperimentSubmitParams,
    signal?: AbortSignal,
  ): Promise<{ spec: ExperimentSpecView; attempt: ExperimentAttemptView; text: string }> => {
    if (!caller.threadId) return submitUnsafe(caller, params, signal);
    const key = `${caller.workspaceId}\0${caller.threadId}`;
    if (sharedRuntime.stoppingThreads.has(key)) {
      throw new HarnessServiceError("unavailable", `Thread ${caller.threadId} is stopping and cannot submit a new experiment`);
    }
    const submitted = submitUnsafe(caller, params, signal);
    const active = sharedRuntime.submissionsByThread.get(key) ?? new Set<Promise<unknown>>();
    active.add(submitted);
    sharedRuntime.submissionsByThread.set(key, active);
    void submitted.finally(() => {
      active.delete(submitted);
      if (active.size === 0 && sharedRuntime.submissionsByThread.get(key) === active) {
        sharedRuntime.submissionsByThread.delete(key);
      }
    }).catch(() => undefined);
    return submitted;
  };

  const describeAttempt = (spec: ExperimentSpecView, attempt: ExperimentAttemptView | null): string => {
    if (!attempt) return `spec ${spec.specId}: attempt record unreadable`;
    const command = [spec.command, ...spec.args].join(" ");
    const state = attempt.state;
    const suffix = attempt.state === "queued" ? ` (${attempt.queueReason ?? "queued"})`
      : attempt.exitCode !== undefined && attempt.exitCode !== null ? ` (exit ${attempt.exitCode})`
      : attempt.error ? ` (${attempt.error})`
      : "";
    return `attempt ${attempt.attemptId} [${spec.specId}] ${state}${suffix} — ${command}`;
  };

  const requireAttempt = async (
    caller: ExperimentCaller,
    attemptId: string,
  ): Promise<{ ctx: ExperimentContext; record: KernelRecordResult; view: ExperimentAttemptView }> => {
    await ensureReconciled(caller.workspaceId);
    const ctx = await recordContext(caller.workspaceId);
    const record = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
    const view = record ? attemptView(record) : null;
    if (!record || !view) throw new HarnessServiceError("not-found", `Unknown experiment attempt: ${attemptId}`);
    assertRecordAllowed(caller, record, `experiment attempt: ${attemptId}`);
    return { ctx, record, view };
  };

  const get = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentGetResult> => {
    const { ctx, view } = await requireAttempt(caller, attemptId);
    const specRecord = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(view.specId));
    const spec = specRecord && recordAllowed(caller, specRecord) ? specView(specRecord) : null;
    const jobRecord = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.job(jobIdFor(attemptId)));
    const job = jobRecord ? jobView(jobRecord) : null;
    const artifacts: ExperimentArtifactView[] = [];
    let cursor: number | undefined;
    do {
      const page = await ctx.scoped.listRecords({
        workspaceId: caller.workspaceId, recordType: "experiment.artifact", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        if (payloadOf(record).internalLogChunk === true) continue;
        const artifact = artifactView(record);
        if (artifact?.attemptId === attemptId) artifacts.push(artifact);
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return {
      attempt: view,
      ...(spec ? { spec } : {}),
      ...(job ? { job } : {}),
      artifacts,
    };
  };

  const list = async (
    caller: ExperimentCaller,
    params: { state?: ExperimentAttemptState; specId?: string; limit?: number },
  ): Promise<ExperimentListResult> => {
    await ensureReconciled(caller.workspaceId);
    const ctx = await recordContext(caller.workspaceId);
    const attempts: ExperimentAttemptView[] = [];
    let cursor: number | undefined;
    do {
      const page = await ctx.scoped.listRecords({
        workspaceId: caller.workspaceId, recordType: "experiment.attempt", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        if (!recordAllowed(caller, record)) continue;
        const view = attemptView(record);
        if (!view) continue;
        if (params.state && view.state !== params.state) continue;
        if (params.specId && view.specId !== params.specId) continue;
        attempts.push(view);
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    const limited = params.limit !== undefined ? attempts.slice(0, Math.max(0, params.limit)) : attempts;
    const text = limited.length === 0
      ? "No experiments recorded."
      : limited.map((attempt) => {
          const detail = attempt.state === "queued" ? ` (${attempt.queueReason ?? "queued"})`
            : attempt.exitCode !== undefined && attempt.exitCode !== null ? ` exit=${attempt.exitCode}`
            : attempt.error ? ` (${attempt.error})`
            : "";
          return `${attempt.attemptId} · ${attempt.state}${detail} · spec ${attempt.specId}`;
        }).join("\n");
    return { attempts: limited, text };
  };

  const cancel = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentAttemptView> => {
    const { ctx, view } = await requireAttempt(caller, attemptId);
    if (TERMINAL.has(view.state)) return view;
    let reconcileRecord: KernelRecordResult | null = null;
    const result = await serializeAttempt(caller.workspaceId, attemptId, async () => {
      const current = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
      const currentView = current ? attemptView(current) : null;
      if (!current || !currentView) throw new HarnessServiceError("not-found", `Unknown experiment attempt: ${attemptId}`);
      assertRecordAllowed(caller, current, `experiment attempt: ${attemptId}`);
      if (TERMINAL.has(currentView.state)) return currentView;
      if (currentView.state === "queued") {
        queued.get(caller.workspaceId)?.delete(attemptId);
        const cancelled = await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "cancelled", (p) => ({
          ...p, cancelRequested: true, endedAt: now(), collection: "none",
        }), (attempt) => attempt.state === "queued");
        return attemptView(cancelled)!;
      }

      const key = attemptKey(caller.workspaceId, attemptId);
      const running = jobs.get(key);
      const owner = recordCaller(caller.workspaceId, current);
      const executionCtx = running ? ctx : await contextForAttempt(owner, current).catch(() => null);
      const resolved = running
        ? { backend: running.backend, site: running.site }
        : executionCtx
          ? await resolveBackend(executionCtx, owner, currentView.machineId ?? LOCAL_MACHINE_ID).catch(() => null)
          : null;
      if (resolved && !resolved.backend.controls.includes("cancel")) {
        throw new HarnessServiceError("invalid-params", `Backend ${resolved.backend.backend} does not support cancellation`);
      }
      const stopping = await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "stopping", (p) => ({
        ...p, cancelRequested: true,
      }), (attempt) => !TERMINAL.has(attempt.state));
      const stoppingView = attemptView(stopping)!;
      if (TERMINAL.has(stoppingView.state)) return stoppingView;
      if (running) running.cancelRequested = true;
      const jobRecord = running ? null : await ctx.scoped
        .getRecord(caller.workspaceId, recordIdFor.job(jobIdFor(attemptId)))
        .catch(() => null);
      const backendJobId = running?.handle.backendJobId
        ?? str(jobRecord ? payloadOf(jobRecord).backendJobId : null)
        ?? processIdFor(caller.workspaceId, attemptId);
      if (resolved) {
        try {
          await resolved.backend.kill(resolved.site, backendJobId);
        } catch (error) {
          await upsertJob(ctx, caller.workspaceId, recordCaller(caller.workspaceId, current), attemptId, "unknown", {
            backendJobId,
            reason: `termination could not be confirmed: ${errorMessage(error)}`,
            lastObservedAt: now(),
          }).catch(report);
        }
      }
      if (!running) reconcileRecord = stopping;
      return attemptView(stopping)!;
    });
    if (reconcileRecord) {
      const owner = recordCaller(caller.workspaceId, reconcileRecord);
      await reconcileAttempt(await contextForAttempt(owner, reconcileRecord), caller.workspaceId, owner, reconcileRecord);
    }
    const updated = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
    return updated ? attemptView(updated) ?? result : result;
  };

  const wait = async (
    caller: ExperimentCaller,
    attemptId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ attempt: ExperimentAttemptView; timedOut: boolean }> => {
    const { view } = await requireAttempt(caller, attemptId);
    if (TERMINAL.has(view.state)) return { attempt: view, timedOut: false };
    const deadline = timeoutMs === undefined ? 30_000 : Math.max(0, timeoutMs);
    if (signal?.aborted) return { attempt: view, timedOut: true };
    const key = attemptKey(caller.workspaceId, attemptId);
    let finishRegistered: ((value: ExperimentAttemptView | null) => void) | undefined;
    const waitedPromise = new Promise<ExperimentAttemptView | null>((resolve) => {
      const set = waiters.get(key) ?? new Set<(view: ExperimentAttemptView | null) => void>();
      const finish = (value: ExperimentAttemptView | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        set.delete(finish);
        if (set.size === 0 && waiters.get(key) === set) waiters.delete(key);
        resolve(value);
      };
      finishRegistered = finish;
      // Cancelling the wait must not cancel the job: abort only ends this
      // observation, the attempt keeps its reservation and lifecycle.
      const onAbort = () => finish(null);
      const timer = setTimeout(() => {
        set.delete(finish);
        signal?.removeEventListener("abort", onAbort);
        resolve(null);
      }, deadline);
      set.add(finish);
      waiters.set(key, set);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // Close the read/register race: a terminal transition between
    // requireAttempt and waiter registration must resolve immediately.
    const recordCtx = await recordContext(caller.workspaceId);
    const afterRegistration = await getAttemptRecord(recordCtx, caller.workspaceId, attemptId);
    const afterView = afterRegistration ? attemptView(afterRegistration) : null;
    if (afterView && TERMINAL.has(afterView.state)) finishRegistered?.(afterView);
    const waited = await waitedPromise;
    if (waited) return { attempt: waited, timedOut: false };
    const refreshed = await getAttemptRecord(recordCtx, caller.workspaceId, attemptId);
    const current = refreshed ? attemptView(refreshed) : null;
    return { attempt: current ?? view, timedOut: !current || !TERMINAL.has(current.state) };
  };

  const logs = async (
    caller: ExperimentCaller,
    params: { attemptId: string; stream?: "stdout" | "stderr"; offset?: number; maxBytes?: number },
  ): Promise<ExperimentLogsResult> => {
    const { ctx, view } = await requireAttempt(caller, params.attemptId);
    const stream = params.stream ?? "stdout";
    const offset = Math.max(0, params.offset ?? 0);
    const maxBytes = Math.max(1, Math.floor(params.maxBytes ?? 64 * 1024));
    const running = jobs.get(attemptKey(caller.workspaceId, params.attemptId));
    const artifactId = artifactIdFor(params.attemptId, stream);
    const record = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.artifact(artifactId))
      ?? await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.artifact(`${params.attemptId}:${stream}`));
    const artifact = record ? artifactView(record) : null;
    const windowStart = Math.max(0, offset - 3);
    const rangeLength = maxBytes + (offset - windowStart) + 3;
    const range = artifact?.state === "available" && record
      ? await readArtifactRange(ctx, caller.workspaceId, record, artifact, windowStart, rangeLength)
      : await readLogRange(ctx, caller.workspaceId, params.attemptId, stream, windowStart, rangeLength);
    if (range.total === 0) {
      return {
        attemptId: params.attemptId,
        stream,
        offset: 0,
        nextOffset: 0,
        eof: TERMINAL.has(view.state) && view.collection === "done",
        text: "",
        origin: running || !TERMINAL.has(view.state) ? "live" : "artifact",
      };
    }
    const slice = sliceUtf8ByBytes(range.bytes, offset - windowStart, maxBytes);
    const nextOffset = windowStart + slice.nextOffset;
    return {
      attemptId: params.attemptId,
      stream,
      offset: windowStart + slice.offset,
      nextOffset,
      eof: TERMINAL.has(view.state) && view.collection === "done" && nextOffset >= range.total,
      text: slice.text,
      origin: running || !TERMINAL.has(view.state) ? "live" : "artifact",
    };
  };

  const collect = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentCollectResult> => {
    const { ctx, record, view } = await requireAttempt(caller, attemptId);
    if (!TERMINAL.has(view.state)) {
      throw new HarnessServiceError("invalid-params", `Attempt ${attemptId} is still ${view.state}; collect after it finishes`);
    }
    if (view.state === "lost") {
      throw new HarnessServiceError("unavailable", `Attempt ${attemptId} is lost; its backend state is unknown`);
    }
    const specRecord = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(view.specId));
    const spec = specRecord ? specView(specRecord) : null;
    if (!spec) throw new HarnessServiceError("unavailable", "experiment spec record is unavailable");
    const running = jobs.get(attemptKey(caller.workspaceId, attemptId)) ?? null;
    // Outputs live under the execution workspace recorded on the attempt —
    // a UI- or reconciler-driven collect may arrive with a different caller.
    const owner = recordCaller(caller.workspaceId, record);
    const attemptCtx = await contextForAttempt(owner, record);
    let resolved = running
      ? { backend: running.backend, site: running.site }
      : await resolveBackend(attemptCtx, owner, view.machineId ?? LOCAL_MACHINE_ID);
    const attemptPayload = payloadOf(record);
    const executionRootId = str(attemptPayload.executionRootId);
    const executionCanonicalRoot = str(attemptPayload.executionCanonicalRoot);
    if (resolved && (view.machineId ?? LOCAL_MACHINE_ID) === LOCAL_MACHINE_ID
      && executionRootId && executionCanonicalRoot) {
      resolved = {
        backend: resolved.backend,
        site: { ...resolved.site, rootId: executionRootId, canonicalRoot: executionCanonicalRoot },
      };
    }
    if (!resolved?.backend.controls.includes("collect")) {
      throw new HarnessServiceError(
        "unavailable",
        `No backend can collect outputs for machine ${view.machineId ?? LOCAL_MACHINE_ID}`,
      );
    }
    return serializeAttempt(caller.workspaceId, attemptId, async () => {
      const current = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
      const currentView = current ? attemptView(current) : null;
      if (!current || !currentView || !TERMINAL.has(currentView.state)) {
        throw new HarnessServiceError("invalid-params", `Attempt ${attemptId} is not ready for collection`);
      }
      const currentOwner = recordCaller(caller.workspaceId, current);
      const artifacts = await persistArtifacts(ctx, caller.workspaceId, currentOwner, attemptId, spec!, resolved, running);
      const collection = artifacts.some((artifact) => artifact.state === "failed") ? "failed" : "done";
      const updated = await updateAttempt(ctx, caller.workspaceId, currentOwner, attemptId, currentView.state, (p) => ({
        ...p, collection,
      }));
      if (collection === "done" && running?.finalized) {
        await releaseFinalizedJob(ctx, caller.workspaceId, currentOwner, attemptId, running);
      }
      return { attempt: attemptView(updated)!, artifacts };
    });
  };

  const validatedArtifact = async (
    caller: ExperimentCaller,
    attemptId: string,
    artifactId: string,
  ): Promise<{ ctx: ExperimentContext; record: KernelRecordResult; artifact: ExperimentArtifactView }> => {
    const { ctx } = await requireAttempt(caller, attemptId);
    const record = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.artifact(artifactId));
    const artifact = record ? artifactView(record) : null;
    if (!record || !artifact || artifact.attemptId !== attemptId || artifact.state !== "available"
      || payloadOf(record).internalLogChunk === true) {
      throw new HarnessServiceError("not-found", `Unknown experiment artifact: ${artifactId}`);
    }
    return { ctx, record, artifact };
  };

  const readRemoteArtifactRange = async (
    caller: ExperimentCaller,
    attemptId: string,
    artifact: ExperimentArtifactView,
    offset: number,
    length: number,
  ): Promise<{ bytes: Buffer; total: number; nextOffset: number; eof: boolean }> => {
    if (!artifact.remote) throw new HarnessServiceError("unavailable", `Artifact ${artifact.artifactId} has no remote reference`);
    const attempt = await requireAttempt(caller, attemptId);
    const owner = recordCaller(caller.workspaceId, attempt.record);
    const attemptCtx = await contextForAttempt(owner, attempt.record);
    const resolved = await resolveBackend(attemptCtx, owner, attempt.view.machineId ?? LOCAL_MACHINE_ID);
    if (!resolved?.backend.readCollectedObject) {
      throw new HarnessServiceError("unavailable", `Backend cannot read retained artifact ${artifact.artifactId}`);
    }
    const page = await resolved.backend.readCollectedObject(resolved.site, artifact.remote.outputId, offset, length);
    return {
      bytes: page.bytes,
      total: artifact.byteLength ?? (page.eof ? page.nextOffset : Math.max(page.nextOffset, offset + page.bytes.byteLength)),
      nextOffset: page.nextOffset,
      eof: page.eof,
    };
  };

  const readArtifact = async (
    caller: ExperimentCaller,
    attemptId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; byteLength?: number; chunks: AsyncIterable<Uint8Array> }> => {
    const { ctx, record, artifact } = await validatedArtifact(caller, attemptId, artifactId);
    const chunks = (async function* (): AsyncGenerator<Uint8Array> {
      let offset = 0;
      for (;;) {
        signal?.throwIfAborted();
        const page = artifact.remote
          ? await readRemoteArtifactRange(caller, attemptId, artifact, offset, BLOB_PAGE_BYTES)
          : await readArtifactRange(ctx, caller.workspaceId, record, artifact, offset, BLOB_PAGE_BYTES, signal);
        if (page.bytes.byteLength > 0) yield page.bytes;
        if (page.eof) return;
        if (page.nextOffset <= offset) {
          throw new HarnessServiceError("unavailable", `Artifact ${artifactId} cursor did not advance`);
        }
        offset = page.nextOffset;
      }
    })();
    return {
      name: artifact.name,
      ...(artifact.byteLength === undefined ? {} : { byteLength: artifact.byteLength }),
      chunks,
    };
  };

  const readArtifactPage = async (
    caller: ExperimentCaller,
    params: { attemptId: string; artifactId: string; offset?: number; maxBytes?: number },
  ): Promise<{
    attemptId: string;
    artifactId: string;
    name: string;
    offset: number;
    nextOffset: number;
    eof: boolean;
    bytesBase64: string;
    text: string | null;
  }> => {
    const { ctx, record, artifact } = await validatedArtifact(caller, params.attemptId, params.artifactId);
    const requestedOffset = Math.max(0, Math.floor(params.offset ?? 0));
    const maxBytes = Math.max(1, Math.floor(params.maxBytes ?? 64 * 1024));
    const windowStart = Math.max(0, requestedOffset - 3);
    const range = artifact.remote
      ? await readRemoteArtifactRange(
          caller, params.attemptId, artifact, windowStart,
          maxBytes + (requestedOffset - windowStart) + 3,
        )
      : await readArtifactRange(
          ctx,
          caller.workspaceId,
          record,
          artifact,
          windowStart,
          maxBytes + (requestedOffset - windowStart) + 3,
        );
    try {
      const slice = sliceUtf8ByBytes(range.bytes, requestedOffset - windowStart, maxBytes);
      if (slice.text.includes("\0")) throw new Error("binary content");
      const bytes = range.bytes.subarray(slice.offset, slice.nextOffset);
      const offset = windowStart + slice.offset;
      const nextOffset = windowStart + slice.nextOffset;
      return {
        attemptId: params.attemptId,
        artifactId: params.artifactId,
        name: artifact.name,
        offset,
        nextOffset,
        eof: nextOffset >= range.total,
        bytesBase64: bytes.toString("base64"),
        text: slice.text,
      };
    } catch {
      const localStart = Math.min(range.bytes.byteLength, requestedOffset - windowStart);
      const bytes = range.bytes.subarray(localStart, localStart + maxBytes);
      const nextOffset = requestedOffset + bytes.byteLength;
      return {
        attemptId: params.attemptId,
        artifactId: params.artifactId,
        name: artifact.name,
        offset: requestedOffset,
        nextOffset,
        eof: nextOffset >= range.total,
        bytesBase64: bytes.toString("base64"),
        text: null,
      };
    }
  };

  const stopForThreads = async (workspaceId: string, threadIds: readonly string[]): Promise<void> => {
    if (threadIds.length === 0) return;
    const targetThreads = new Set(threadIds);
    const stopKeys = [...targetThreads].map((threadId) => `${workspaceId}\0${threadId}`);
    const priorStops = stopKeys.flatMap((key) => {
      const prior = sharedRuntime.stoppingThreads.get(key);
      return prior ? [prior] : [];
    });
    if (priorStops.length > 0) {
      await Promise.allSettled(priorStops);
      return stopForThreads(workspaceId, threadIds);
    }
    let finishStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { finishStop = resolve; });
    for (const key of stopKeys) sharedRuntime.stoppingThreads.set(key, stopGate);
    try {
      const inFlight = stopKeys.flatMap((key) => [...(sharedRuntime.submissionsByThread.get(key) ?? [])]);
      await Promise.allSettled(inFlight);
      await ensureReconciled(workspaceId);
      const scanCtx = await recordContext(workspaceId);
      const records: KernelRecordResult[] = [];
      let cursor: number | undefined;
      do {
        const page = await scanCtx.scoped.listRecords({
          workspaceId,
          recordType: "experiment.attempt",
          pageSize: 128,
          ...(cursor === undefined ? {} : { cursor }),
        });
        records.push(...page.records.filter((record) => record.threadId && targetThreads.has(record.threadId)));
        cursor = page.nextCursor === null ? undefined : page.nextCursor;
      } while (cursor !== undefined);

      const results = await Promise.allSettled(records.map(async (record) => {
        const attempt = attemptView(record);
        if (!attempt || TERMINAL.has(attempt.state)) return;
        const owner = recordCaller(workspaceId, record);
        const stopped = await cancel(owner, attempt.attemptId);
        if (TERMINAL.has(stopped.state)) return;
        const ctx = await contextForAttempt(owner, record);
        const jobRecord = await ctx.scoped.getRecord(workspaceId, recordIdFor.job(jobIdFor(attempt.attemptId))).catch(() => null);
        const resolved = await resolveBackend(ctx, owner, stopped.machineId ?? LOCAL_MACHINE_ID).catch(() => null);
        if (!resolved) {
          throw new HarnessServiceError("unavailable", `Attempt ${attempt.attemptId} stop is pending because its backend is unavailable`);
        }
        const backendJobId = str(jobRecord ? payloadOf(jobRecord).backendJobId : null)
          ?? processIdFor(workspaceId, attempt.attemptId);
        let observation: BackendObservation;
        try {
          observation = await resolved.backend.inspect(resolved.site, backendJobId);
        } catch (error) {
          throw new HarnessServiceError(
            "unavailable",
            `Attempt ${attempt.attemptId} stop could not be confirmed: ${errorMessage(error)}`,
          );
        }
        if (observation.status === "unknown" || observation.writerActive) {
          throw new HarnessServiceError("unavailable", `Attempt ${attempt.attemptId} has not confirmed termination`);
        }
        const latest = await getAttemptRecord(ctx, workspaceId, attempt.attemptId);
        if (latest) await reconcileAttempt(ctx, workspaceId, owner, latest, resolved);
        const waited = await wait(owner, attempt.attemptId);
        if (waited.timedOut || !TERMINAL.has(waited.attempt.state)) {
          throw new HarnessServiceError("unavailable", `Attempt ${attempt.attemptId} termination was not durably recorded`);
        }
      }));
      const failures = results.flatMap((result) => result.status === "rejected" ? [errorMessage(result.reason)] : []);
      if (failures.length > 0) {
        throw new HarnessServiceError("unavailable", `Some experiment jobs could not be confirmed stopped: ${failures.join("; ")}`);
      }
    } finally {
      for (const key of stopKeys) {
        if (sharedRuntime.stoppingThreads.get(key) === stopGate) sharedRuntime.stoppingThreads.delete(key);
      }
      finishStop();
    }
  };

  const refreshQueue = async (workspaceId: string): Promise<void> => {
    await ensureReconciled(workspaceId);
    await drainQueue(workspaceId);
  };

  const detachObservers = (): void => {
    if (disposed) return;
    disposed = true;
    sharedRuntime.listeners.delete(deliverNotification);
    for (const [key, running] of jobs) {
      if (running.observerOwner === serviceToken) jobs.delete(key);
    }
    for (const pending of waiters.values()) {
      for (const resolve of pending) resolve(null);
    }
    waiters.clear();
    queued.clear();
  };

  /**
   * Observe durable attempt changes (state transitions, collection updates).
   * Follow-up registrations (D-307) and external triggers subscribe here rather
   * than polling; listeners receive the projected view, not raw records.
   */
  const subscribeAttempts = (
    listener: (workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => void,
  ): (() => void) => {
    sharedRuntime.listeners.add(listener);
    return () => sharedRuntime.listeners.delete(listener);
  };

  return {
    submit, list, get, logs, cancel, wait, collect, readArtifact, readArtifactPage,
    stopForThreads, refreshQueue, ensureReconciled, subscribeAttempts,
    detachObservers,
    dispose: detachObservers,
  };
}

export type ExperimentService = ReturnType<typeof createExperimentService>;
