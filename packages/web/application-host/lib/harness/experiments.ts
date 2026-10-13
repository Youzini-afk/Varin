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
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ResearchSourceAuthority, ExperimentSourceAdmission } from "../kernel/research-source.js";
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
  ExperimentPreparationError,
  type BackendJobHandle,
  type BackendObservation,
  type ExperimentBackend,
  type ExperimentBackendSite,
  type ResolvedExperimentBackend,
} from "./experiment-backend.js";
import { validateResources, type ResourceService } from "./resources.js";
import type { SourceService } from "./sources.js";
import {
  materializeExperimentAttempt,
  prepareExperimentInput,
  ExperimentInputCaptureError,
  recoverExperimentInput,
  reconcileExperimentPreparation,
  reconcileExperimentCapture,
  type ExperimentInputCapture,
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
const STOPPED_BACKEND_STATES: ReadonlySet<BackendObservation["status"]> = new Set(["exited", "failed", "cancelled", "released"]);
export const ATTEMPT_STATES: ReadonlySet<string> = new Set(["submitted", "queued", "running", "stopping", ...TERMINAL]);

export const isTerminalAttemptState = (state: ExperimentAttemptState): boolean => TERMINAL.has(state);

export type { ExperimentCaller } from './research-identity.js';
import { type ExperimentCaller, mayAccessResearch, requireResearchOwner, researchNamespace, researchMaintenanceCaller, researchOwner } from './research-identity.js';

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
  /** Original backend reader/release flight, shared across service detach and manual collect. */
  collection?: Promise<void>;
  lastPollError?: string;
  lastObservationKey?: string;
  observerOwner: symbol;
}

interface AttemptFlight {
  controller: AbortController;
  promise: Promise<void>;
}

interface SharedExperimentRuntime {
  resumers: Map<symbol, (workspaceId: string, attemptId: string) => void>;
  flights: Map<string, AttemptFlight>;
  stops: Map<string, Promise<void>>;
  jobs: Map<string, RunningJob>;
  attemptOperations: Map<string, Promise<void>>;
  listeners: Set<(workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => void>;
  submissionsByThread: Map<string, Set<Promise<unknown>>>;
  submissionsByAttempt: Map<string, Set<Promise<unknown>>>;
  stoppingThreads: Map<string, Promise<void>>;
}

const sharedExperimentRuntimes = new WeakMap<KernelClient, SharedExperimentRuntime>();

const sharedExperimentRuntime = (client: KernelClient): SharedExperimentRuntime => {
  const existing = sharedExperimentRuntimes.get(client);
  if (existing) return existing;
  const created: SharedExperimentRuntime = {
    resumers: new Map(),
    flights: new Map(),
    stops: new Map(),
    jobs: new Map(),
    attemptOperations: new Map(),
    listeners: new Set(),
    submissionsByThread: new Map(),
    submissionsByAttempt: new Map(),
    stoppingThreads: new Map(),
  };
  sharedExperimentRuntimes.set(client, created);
  return created;
};

interface ExperimentServiceDeps {
  sourceAuthority?: ResearchSourceAuthority;
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

const callerNamespace = (caller: ExperimentCaller): string => caller.owner.runtime === "agent"
  ? JSON.stringify(["agent",caller.owner.rootThreadId,caller.owner.threadId,caller.owner.branchId]) : researchNamespace(caller);

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

const collectionCompletion = (raw: unknown, currentRevision: number): import("@varin/protocol").ExperimentCollectionCompletion => {
  const value = raw as { recordRevision?: unknown; outcome?: unknown } | null;
  if (!value || !Number.isSafeInteger(value.recordRevision) || (value.recordRevision as number) < 1 || (value.recordRevision as number) > currentRevision || !["done", "failed", "not_started"].includes(String(value.outcome))) {
    throw new HarnessServiceError("unavailable", "Original collection completion is unreadable");
  }
  return value as import("@varin/protocol").ExperimentCollectionCompletion;
};
const unspawnedDrained = (payload: Record<string, unknown>): boolean => !payload.spawnDispatched
  && (!payload.captureStarted || payload.captureDrained === true)
  && (!payload.preparationStarted || payload.preparationDrained === true)
  && (!payload.admissionStarted || payload.admissionDrained === true);
const originalOutputDrained = (record: KernelRecordResult, view: ExperimentAttemptView, job: KernelRecordResult | null): boolean =>
  view.state !== "lost" && TERMINAL.has(view.state) && (payloadOf(record).spawnDispatched
    ? !!job && payloadOf(job).executorStopped === true && payloadOf(job).outputDrained === true : unspawnedDrained(payloadOf(record)));

const attemptView = (record: KernelRecordResult): ExperimentAttemptView | null => {
  const payload = payloadOf(record);
  const attemptId = str(payload.id);
  const specId = str(payload.specId);
  const backend = str(payload.backend);
  if (!attemptId || (!specId && payload.specId !== null) || !backend || typeof payload.cancelRequested !== "boolean"
    || !ATTEMPT_STATES.has(record.state) || (!specId && ["queued", "running", "completed"].includes(record.state))) return null;
  const machineId = str(payload.machineId);
  const signal = str(payload.signal);
  const error = str(payload.error) ?? str(payload.preparationError) ?? str(payload.materializationError);
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
    ...(payload.collectionCompletion ? { collectionCompletion: collectionCompletion(payload.collectionCompletion, record.recordRevision) } : {}),
    specId: specId ?? null,
    cancelRequested: payload.cancelRequested,
    backend,
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
    createdAt: num(payload.createdAt) ?? record.createdAt,
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
    recordRevision: record.recordRevision,
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
  if (input.schemaVersion !== 2 || typeof input.branchId !== "string" || typeof input.root !== "string"
    || (typeof input.sourceRoot !== "string" && input.sourceRoot !== null) || typeof input.workspaceId !== "string"
    || typeof input.executionWorkspaceId !== "string" || !Array.isArray(input.captureScopes)
    || !input.captureScopes.every((entry) => typeof entry === "string")
    || (input.capturedPathCount !== null && !Number.isSafeInteger(input.capturedPathCount)) || (input.inventoryFingerprint !== null && typeof input.inventoryFingerprint !== "string")) {
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

  const recordAllowed = (caller: ExperimentCaller, record: KernelRecordResult): boolean => mayAccessResearch(caller, record);
  const assertRecordControlled = (caller: ExperimentCaller, record: KernelRecordResult): void => {
    if (!mayAccessResearch(caller, record, true)) throw new HarnessServiceError("denied", "Experiment control is outside the caller's task scope");
  };
  const callerView = (caller: ExperimentCaller, record: KernelRecordResult, view: ExperimentAttemptView): ExperimentAttemptView =>
    caller.owner.runtime === 'agent' ? { ...view, permissions: { control: mayAccessResearch(caller, record, true) } } : view;

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
      : await deps.resources.getMachineRecord(caller.workspaceId, machineId);
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
      reconcilePreparation: ({ attemptId, input }) => reconcileExperimentPreparation(deps.client, caller, attemptId, input),
      prepare: async ({ attemptId, input, signal }) => {
        const materialized = await materializeExperimentAttempt(deps.client, caller, attemptId, input, signal ? { signal } : {});
        return {
          backend: createLocalExperimentBackend(materialized.scoped, materialized.releaseAuthority),
          site: {
            workspaceId: caller.workspaceId,
            rootId: materialized.rootId,
            canonicalRoot: materialized.canonicalRoot,
            transport: materialized.scoped,
          },
          cwd: materialized.cwd,
          inputRoot: materialized.snapshotRoot,
          releaseAuthority: materialized.releaseAuthority,
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
  ): Promise<KernelRecordResult> => {
    const record = await ctx.scoped.putRecord({
    operationId: `${input.recordType}:${randomUUID()}`,
    recordId: input.recordId,
    workspaceId,
    recordType: input.recordType,
    state: input.state,
    payloadJson: JSON.stringify({ ...input.payload, researchOwner: input.payload.researchOwner ?? requireResearchOwner(caller),
      executionWorkspaceId: input.payload.executionWorkspaceId ?? caller.executionWorkspaceId }),
    ownerIds: input.ownerIds ?? [],
    references: input.references ?? [],
    ...(caller.sessionId ? { sessionId: caller.sessionId } : {}),
    ...(caller.threadId ? { threadId: caller.threadId } : {}),
    ...(caller.runId ? { runId: caller.runId } : {}),
    ...(input.expectedRecordRevision === undefined ? {} : { expectedRecordRevision: input.expectedRecordRevision }),
    });
    if (input.recordType === "experiment.artifact" && input.payload.internalLogChunk !== true) notify(workspaceId, String(input.payload.attemptId), null);
    return record;
  };

  const getAttemptRecord = (ctx: ExperimentContext, workspaceId: string, attemptId: string) => (
    ctx.scoped.getRecord(workspaceId, recordIdFor.attempt(attemptId))
  );

  const updateAttempt = async (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    attemptId: string,
    state: ExperimentAttemptState | ((current: ExperimentAttemptView) => ExperimentAttemptState),
    mutate: (payload: Record<string, unknown>, nextRevision: number) => Record<string, unknown>,
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
          state: typeof state === "function" ? state(current) : state,
          expectedRecordRevision: existing.recordRevision,
          payload: mutate(payloadOf(existing), existing.recordRevision + 1),
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
    for (const listener of sharedRuntime.listeners) { try { listener(workspaceId, attemptId, view); } catch (error) { report(error); } }
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

  const readLogRange = async (
    ctx: ExperimentContext,
    workspaceId: string,
    attemptId: string,
    stream: "stdout" | "stderr",
    offset: number,
    length: number,
    signal?: AbortSignal,
    publishedEnd?: number,
    caller?: ExperimentCaller,
  ): Promise<{ bytes: Buffer; total: number; nextOffset: number; eof: boolean }> => {
    // Chunks may be durable before their original job cursor CAS. Only published
    // stream lengths expose bytes; the chunk index is never a publication owner.
    const job = publishedEnd === undefined ? await ctx.scoped.getRecord(workspaceId, recordIdFor.job(jobIdFor(attemptId)), signal) : null;
    const total = publishedEnd ?? (job ? num(payloadOf(job)[`${stream}Bytes`]) ?? 0 : 0);
    const start = Math.min(Math.max(0, offset), total);
    const end = Math.min(total, start + Math.max(0, length));
    const parts: Buffer[] = [];
    let covered = start;
    while (covered < end) {
      signal?.throwIfAborted();
      const page = await ctx.scoped.experimentLogChunks({ workspaceId, attemptId, stream, offset: covered, endOffset: end }, signal);
      for (const record of page.records) {
        if (caller) assertRecordAllowed(caller, record, `experiment log: ${record.recordId}`);
        const payload = payloadOf(record);
        const chunkOffset = num(payload.streamOffset), byteLength = num(payload.byteLength);
        const objectHash = record.references.find(reference => reference.slot === "content")?.objectHash;
        if (record.state !== "available" || payload.internalLogChunk !== true || payload.attemptId !== attemptId || payload.stream !== stream
          || chunkOffset === undefined || byteLength === undefined || byteLength <= 0 || !objectHash) {
          throw new HarnessServiceError("unavailable", `${stream} durable chunk metadata is unreadable`);
        }
        const chunkEnd = chunkOffset + byteLength;
        if (chunkEnd <= covered) continue;
        const rangeStart = Math.max(start, chunkOffset), rangeEnd = Math.min(end, chunkEnd);
        if (rangeStart !== covered) throw new HarnessServiceError("unavailable", `${stream} has a missing or overlapping durable page at byte ${covered}`);
        const blob = await ctx.scoped.getBlob(objectHash, { recordId: record.recordId, slot: "content" },
          { offset: rangeStart - chunkOffset, length: rangeEnd - rangeStart, ...(signal ? { signal } : {}) });
        const bytes = Buffer.from(blob.bytesBase64, "base64");
        if (bytes.byteLength !== rangeEnd - rangeStart) throw new HarnessServiceError("unavailable", `${stream} durable page is incomplete at byte ${rangeStart}`);
        parts.push(bytes); covered = rangeEnd;
        if (covered >= end) break;
      }
      if (covered < end && (page.nextOffset === null || page.nextOffset !== covered)) {
        throw new HarnessServiceError("unavailable", `${stream} has a missing durable page at byte ${covered}`);
      }
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
        });
        const view = artifactView(record);
        if (!view) throw new HarnessServiceError("unavailable", "Collected artifact failure record is unreadable");
        artifacts.push(view);
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
        });
        const view = artifactView(record);
        if (!view) throw new HarnessServiceError("unavailable", "Collected artifact failure record is unreadable");
        artifacts.push(view);
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

  // Cleanup uses the original durable grant attribution, including grants retained by a
  // previous Host whose physical writer had not yet supplied a drain receipt.
  const retireAttemptAuthority = async (caller: ExperimentCaller): Promise<void> => {
    const owner=requireResearchOwner(caller);
    if(owner.runtime === "agent") await deps.client.retireOperationGrants(owner.operationId);
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
      await retireAttemptAuthority(caller);
      const key = attemptKey(workspaceId, attemptId);
      if (jobs.get(key) === running) jobs.delete(key);
      return true;
    } catch (error) {
      const existing = await ctx.scoped.getRecord(workspaceId, recordIdFor.job(jobIdFor(attemptId))).catch(() => null);
      const knownState = existing ? jobView(existing)?.state : undefined;
      await upsertJob(ctx, workspaceId, caller, attemptId,
        knownState ?? "exited", {
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

  const finalize = (
    ctx: ExperimentContext,
    workspaceId: string,
    attemptId: string,
    running: RunningJob,
    observation?: BackendObservation,
  ): Promise<void> => {
    if (running.collection) return running.collection;
    // This promise belongs to the original backend holder, not its current observer.
    // Register it before publishing terminal facts so reentrant reads/collect join it.
    const collection = (async () => {
      const terminal = await serializeAttempt(workspaceId, attemptId, async () => {
        if (observation && (!STOPPED_BACKEND_STATES.has(observation.status) || observation.writerActive)) return null;
        const record = await getAttemptRecord(ctx, workspaceId, attemptId);
        const attempt = record ? attemptView(record) : null;
        if (!record || !attempt || attempt.state === "lost") return null;
        const owner = recordCaller(workspaceId, record);
        if (!observation) {
          if (!running.finalized || !TERMINAL.has(attempt.state)) return null;
        } else {
          await upsertJob(ctx, workspaceId, owner, attemptId, jobStateFor(observation), {
            backend: running.backend.backend,
            backendJobId: running.handle.backendJobId,
            exitCode: observation.exitCode,
            signal: observation.signal,
            reason: observation.reason,
            executorStopped: true,
            outputDrained: true,
            endedAt: now(),
          });
        }
        const persistedCancel = attempt.state === "stopping" || payloadOf(record).cancelRequested === true;
        const finalState: ExperimentAttemptState = TERMINAL.has(attempt.state) ? attempt.state
          : persistedCancel || observation?.status === "cancelled" ? "cancelled"
          : observation?.status === "exited" && observation.exitCode === 0 ? "completed"
          : "failed";
        const updated = await updateAttempt(ctx, workspaceId, owner, attemptId, finalState, (payload) => ({
          ...payload,
          ...(observation ? { exitCode: observation.exitCode, signal: observation.signal } : {}),
          endedAt: num(payload.endedAt) ?? now(),
          collection: attempt.collection === "done" ? "done" : "pending",
          ...(observation?.reason && finalState !== "completed" ? { error: observation.reason } : {}),
        }));
        running.finalized = true;
        return updated;
      });
      if (!terminal) return;
      const owner = recordCaller(workspaceId, terminal);
      // Execution is durably stopped and its logs are drained. Artifact readers no
      // longer own compute, and cannot hold the attempt's control transaction open.
      await releaseTerminalCommitment(ctx, workspaceId, terminal);
      void drainQueue(workspaceId).catch(report);
      let state = attemptView(terminal)!.collection;
      if (state !== "done") {
        state = "failed";
        try {
          const specId = attemptView(terminal)!.specId;
          const specRecord = specId ? await ctx.scoped.getRecord(workspaceId, recordIdFor.spec(specId)) : null;
          const spec = specRecord ? specView(specRecord) : null;
          if (!spec) throw new Error("Experiment spec is unavailable for output collection");
          const artifacts = await persistArtifacts(ctx, workspaceId, owner, attemptId, spec,
            { backend: running.backend, site: running.site }, running);
          state = artifacts.some((artifact) => artifact.state === "failed") ? "failed" : "done";
        } catch (error) {
          report(error);
        }
        await serializeAttempt(workspaceId, attemptId, () => updateAttempt(
          ctx, workspaceId, owner, attemptId, (view) => view.state, (payload, nextRevision) => ({ ...payload, collection: state, collectionCompletion: { recordRevision: nextRevision, outcome: state } }),
          (view) => view.state !== "lost" && TERMINAL.has(view.state),
        ));
      }
      if (state === "done") await releaseFinalizedJob(ctx, workspaceId, owner, attemptId, running);
    })().finally(() => {
      if (running.collection === collection) delete running.collection;
      // A detached holder remains the owner of its actual reader until it drains.
      // If terminal publication failed, only then may a new observer reconnect.
      const key = attemptKey(workspaceId, attemptId);
      if (disposed && !running.finalized && jobs.get(key) === running) {
        jobs.delete(key);
        sharedRuntime.resumers.values().next().value?.(workspaceId, attemptId);
      }
    });
    running.collection = collection;
    return collection;
  };

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
        // The durable control receipt remains authoritative across an observer's attach/read awaits.
        const current = await getAttemptRecord(ctx, workspaceId, attemptId);
        if (!current) throw new Error(`Experiment attempt disappeared during observation: ${attemptId}`);
        running.cancelRequested ||= current.state === "stopping" || payloadOf(current).cancelRequested === true;
        if (running.cancelRequested && (!STOPPED_BACKEND_STATES.has(observation.status) || observation.writerActive)) {
          void requestBackendStop(ctx, workspaceId, current, running).catch(report);
        }
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
        if (STOPPED_BACKEND_STATES.has(observation.status) && !observation.writerActive && running.cursor === result.endCursor) {
          await finalize(ctx, workspaceId, attemptId, running, observation);
          return;
        }
        if (observation.status === "running" || observation.status === "starting") {
          await updateAttempt(ctx, workspaceId, caller, attemptId, "running", (p) => ({
            ...p, backend: running.backend.backend, startedAt: num(p.startedAt) ?? now(), phase: "running",
          }), (current) => current.state === "submitted");
        }
        const state = jobStateFor(observation);
        if ((state === "starting" || state === "running") && running.lastObservationKey !== observationKey) {
          running.lastObservationKey = observationKey;
          await upsertJob(ctx, workspaceId, caller, attemptId, state, { reason: observation.reason }).catch(report);
        }
        if (result.chunks.length > 0 || running.cursor < result.endCursor) continue;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      } catch (error) {
        if (running.finalized) { report(error); return; }
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
    signal?: AbortSignal,
  ): Promise<void> => {
    const attempt = attemptView(attemptRecord);
    if (!attempt || !attempt.specId || jobs.has(attemptKey(workspaceId, attempt.attemptId)) || attempt.state !== "submitted") return;
    const payload = payloadOf(attemptRecord);
    const resources = payload.resources && typeof payload.resources === "object"
      ? payload.resources as ExperimentResourceRequest : {};
    const needsAdmission = (["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const)
      .some((key) => (resources[key] ?? 0) > 0);
    if (needsAdmission && !str(payload.commitmentId)) return;
    const specRecord = attempt.specId ? await ctx.scoped.getRecord(workspaceId, recordIdFor.spec(attempt.specId)) : null;
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
      if (payload.preparationStarted && payload.preparationDrained !== true) {
        await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, (current) => current.state,
          (p) => ({ ...p, preparationUncertain: true, preparationError: "Original preparation backend is unavailable; drain reconciliation remains pending" }));
        return;
      }
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "failed", (p) => ({
        ...p, error: `no execution backend is registered for machine ${attempt.machineId ?? LOCAL_MACHINE_ID}`, endedAt: now(), collection: "none",
      }), (current) => current.state === "submitted");
      return;
    }
    let executionBackend: ResolvedExperimentBackend;
    let executionCwd: string;
    let releasePreparedAuthority: (() => Promise<void>) | undefined;
    let backendDispatched = false;
    try {
      signal?.throwIfAborted();
      if (payload.preparationStarted && payload.preparationDrained !== true) {
        if (!resolved.reconcilePreparation || await resolved.reconcilePreparation({ attemptId: attempt.attemptId, input: inputSnapshot }) !== "drained") {
          await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, (current) => current.state,
            (p) => ({ ...p, preparationError: "Previous preparation effect is not yet confirmed drained; reconciliation remains pending" }));
          return;
        }
      }
      signal?.throwIfAborted();
      await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, (current) => current.state,
        (p) => ({ ...p, preparationStarted: true, preparationDrained: false }));
      try {
        const prepared = await resolved.prepare({ attemptId: attempt.attemptId, input: inputSnapshot, ...(signal ? { signal } : {}) });
        releasePreparedAuthority = prepared.releaseAuthority;
        await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, (current) => current.state,
          (p) => ({ ...p, preparationDrained: true, preparationUncertain: false }));
        signal?.throwIfAborted();
        if (prepared.inputRoot !== inputSnapshot.root) throw new ExperimentPreparationError("Prepared input does not match the frozen experiment snapshot", { drained: true, retryable: false });
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
        // Adapters distinguish actual drain from a disconnected/unknown preparation effect.
        const drained = error instanceof ExperimentPreparationError && error.drained;
        await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, (current) => current.state, (p) => ({
          ...p, preparationDrained: p.preparationDrained === true || drained,
          preparationUncertain: p.preparationDrained !== true && !drained, materializationError: errorMessage(error),
        })).catch(report);
        if (signal?.aborted || (error instanceof ExperimentPreparationError && !error.retryable)) throw error;
        report(error);
        return;
      }
      signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      const dispatch = await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "submitted", (p) => ({
        ...p, backend: executionBackend.backend.backend, spawnDispatched: true, phase: "dispatching",
      }), (current) => current.state === "submitted");
      if (attemptView(dispatch)?.state !== "submitted") return;
      if (signal?.aborted) {
        const latest = await getAttemptRecord(ctx, workspaceId, attempt.attemptId);
        if (latest && latest.state === "stopping") await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "stopping", (p) => ({ ...p, spawnDispatched: false }), (view) => view.state === "stopping");
        return;
      }
      let spawnReceipt: { handle: BackendJobHandle; observation: BackendObservation } | undefined;
      try {
        backendDispatched = true;
        spawnReceipt = await executionBackend.backend.spawn(executionBackend.site, {
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
        const { handle, observation } = spawnReceipt;
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
        if (running.cancelRequested) void requestBackendStop(ctx, workspaceId, refreshed ?? attemptRecord, running).catch(report);
        startPolling(ctx, workspaceId, recordCaller(workspaceId, refreshed ?? attemptRecord), attempt.attemptId, running);
      } catch (error) {
        const message = errorMessage(error);
        const retainedHandle = spawnReceipt?.handle ?? { backendJobId };
        const retainedSite = retainedHandle.executionRootId && retainedHandle.executionCanonicalRoot
          ? { ...executionBackend.site, rootId: retainedHandle.executionRootId, canonicalRoot: retainedHandle.executionCanonicalRoot }
          : executionBackend.site;
        await upsertJob(ctx, workspaceId, caller, attempt.attemptId, "unknown", {
          backend: executionBackend.backend.backend,
          machineId: attempt.machineId ?? LOCAL_MACHINE_ID,
          backendJobId: retainedHandle.backendJobId,
          reason: `submit response or durable receipt unavailable: ${message}`,
          lastObservedAt: now(),
        }).catch(report);
        await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "submitted", (p) => ({
          ...p, reconciliationError: message,
        }), (current) => current.state === "submitted").catch(report);
        report(error);
        const current = await getAttemptRecord(ctx, workspaceId, attempt.attemptId);
        const recovering: RunningJob = {
          backend: executionBackend.backend, site: retainedSite, handle: retainedHandle,
          cursor: 0, totals: { stdout: 0, stderr: 0 }, cancelRequested: current?.state === "stopping", finalized: false,
          observerOwner: serviceToken, poll: Promise.resolve(),
        };
        if (recovering.cancelRequested && current) void requestBackendStop(ctx, workspaceId, current, recovering).catch(report);
        startPolling(ctx, workspaceId, caller, attempt.attemptId, recovering);
      }
    } finally {
      if (!backendDispatched) await releasePreparedAuthority?.();
    }
  };

  const drainQueue = async (workspaceId: string): Promise<void> => {
    const ctx = await recordContext(workspaceId);
    for (const attemptId of [...(queued.get(workspaceId) ?? [])]) {
      const record = await getAttemptRecord(ctx, workspaceId, attemptId);
      if (!record || record.state !== "queued") { queued.get(workspaceId)?.delete(attemptId); continue; }
      void reconcileAttempt(ctx, workspaceId, recordCaller(workspaceId, record), record).catch(report);
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

  const recordCaller = researchMaintenanceCaller;

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
        if (!attempt) { report(new Error(`Experiment attempt is unreadable: ${record.recordId}`)); continue; }
        if (attempt.state === "lost") continue;
        const caller = recordCaller(workspaceId, record);
        try {
          void reconcileAttempt(ctx, workspaceId, caller, record).catch(report);
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

  const submissionResources = (resources: ExperimentResourceRequest): ExperimentResourceRequest => {
    try { return validateResources(resources); }
    catch (error) { throw new HarnessServiceError("invalid-params", errorMessage(error)); }
  };

  const normalizeSubmission = (params: ExperimentSubmitParams): ExperimentSubmitParams => {
    if (params.specId !== undefined && (params.command !== undefined || params.args !== undefined
      || params.inputs !== undefined || params.resources !== undefined || params.outputPaths !== undefined
      || params.env !== undefined || params.cwd !== undefined)) {
      throw new HarnessServiceError("invalid-params", "specId cannot be combined with inline spec fields");
    }
    if (params.requestId !== undefined && !params.requestId.trim()) throw new HarnessServiceError("invalid-params", "requestId cannot be empty");
    if (params.retryOfAttemptId !== undefined && !params.retryOfAttemptId.trim()) throw new HarnessServiceError("invalid-params", "retryOfAttemptId cannot be empty");
    const common = {
      ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
      ...(params.retryOfAttemptId === undefined ? {} : { retryOfAttemptId: params.retryOfAttemptId.trim() }),
      ...(params.machineId?.trim() ? { machineId: params.machineId.trim() } : {}),
      ...(params.title?.trim() ? { title: params.title.trim() } : {}),
    };
    if (params.specId !== undefined) {
      if (!params.specId.trim()) throw new HarnessServiceError("invalid-params", "specId cannot be empty");
      return { ...common, specId: params.specId.trim() };
    }
    const command = typeof params.command === "string" ? params.command.trim() : "";
    if (!command) throw new HarnessServiceError("invalid-params", "experiment submit requires a command");
    const args = params.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new HarnessServiceError("invalid-params", "experiment args must be a string array");
    const env = params.env ?? {};
    if (!Object.values(env).every((value) => typeof value === "string")) throw new HarnessServiceError("invalid-params", "experiment env values must be strings");
    const outputPaths = (params.outputPaths ?? []).map((entry) => {
      if (typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry) || entry.includes("..") || entry.includes("\0")) {
        throw new HarnessServiceError("invalid-params", `Invalid experiment output path: ${String(entry)}`);
      }
      return entry.replaceAll("\\", "/");
    });
    return { ...common, command, args: [...args], env: { ...env }, inputs: structuredClone(params.inputs ?? []),
      outputPaths, ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.resources === undefined ? {} : { resources: submissionResources(params.resources) }) };
  };

  const submissionFingerprint = (caller: ExperimentCaller, params: ExperimentSubmitParams): string => {
    const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, ordered(entry)])) : value;
    return digestId(JSON.stringify(ordered({ params, workspaceId: caller.workspaceId,
      namespace: callerNamespace(caller) })));
  };

  const requireSpec = async (ctx: ExperimentContext, caller: ExperimentCaller, specId: string): Promise<KernelRecordResult> => {
    const record = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(specId));
    if (!record) throw new HarnessServiceError("unavailable", `Experiment spec is missing: ${specId}`);
    assertRecordAllowed(caller, record, `experiment spec: ${specId}`);
    if (!specView(record) || !inputSnapshotOf(record)) throw new HarnessServiceError("failed", `Experiment spec is unreadable: ${specId}`);
    return record;
  };

  const submitUnsafe = async (
    caller: ExperimentCaller,
    requested: ExperimentSubmitParams,
    signal?: AbortSignal,
  ): Promise<{ spec: ExperimentSpecView | null; attempt: ExperimentAttemptView; text: string }> => {
    signal?.throwIfAborted();
    requireResearchOwner(caller);
    const params = normalizeSubmission(requested);
    const fingerprint = submissionFingerprint(caller, params);
    const attemptId = params.requestId ? attemptIdForRequest(caller, params.requestId) : `attempt-${randomUUID()}`;
    const ctx = await waitWithSignal(recordContext(caller.workspaceId), signal);
    const reuse = async (record: KernelRecordResult) => {
      assertRecordAllowed(caller, record, `experiment attempt: ${attemptId}`);
      const attempt = attemptView(record);
      if (!attempt) throw new HarnessServiceError("failed", `Experiment attempt is unreadable: ${attemptId}`);
      if (payloadOf(record).submissionFingerprint !== fingerprint) throw new HarnessServiceError("invalid-params", `requestId ${params.requestId ?? attemptId} is already bound to a different experiment submission`);
      const spec = attempt.specId ? specView(await requireSpec(ctx, caller, attempt.specId)) : null;
      void reconcileAttempt(ctx, caller.workspaceId, recordCaller(caller.workspaceId, record), record).catch(report);
      return { spec, attempt: callerView(caller, record, attempt), text: describeAttempt(spec, attempt) };
    };
    // Resolve the durable receipt before touching live source paths or execution targets.
    const prior = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
    if (prior) return reuse(prior);
    let spec: ExperimentSpecView | null = null;
    let sourceRoot: string | undefined;
    let sourceAdmission: ExperimentSourceAdmission | undefined;
    let sourceCwd: string | undefined;
    let resolvedInputs: ExperimentInputRef[] | undefined;
    let retrySpecId: string | undefined;
    if (params.retryOfAttemptId) {
      const retry = await getAttemptRecord(ctx, caller.workspaceId, params.retryOfAttemptId);
      if (!retry) throw new HarnessServiceError("not-found", `Unknown retry source attempt: ${params.retryOfAttemptId}`);
      assertRecordAllowed(caller, retry, `experiment attempt: ${params.retryOfAttemptId}`);
      const retryAttempt = attemptView(retry);
      if (!retryAttempt?.specId) throw new HarnessServiceError("invalid-params", "Retry source has no frozen experiment spec");
      retrySpecId = retryAttempt.specId;
      if (params.specId && params.specId !== retrySpecId) throw new HarnessServiceError("invalid-params", "Retry source uses a different experiment spec");
    }
    if (params.specId) {
      spec = specView(await requireSpec(ctx, caller, params.specId));
      if (spec?.state !== "active") throw new HarnessServiceError("invalid-params", `Experiment spec is retired: ${params.specId}`);
    } else {
      resolvedInputs = await waitWithSignal(resolveInputs(caller, params.inputs), signal);
      if (caller.owner.runtime === "agent") {
        if (!deps.sourceAuthority) throw new HarnessServiceError("unavailable", "Original native research source owner is unavailable");
        sourceAdmission = await deps.sourceAuthority.admit(caller, params.cwd, signal);
        sourceRoot = sourceAdmission.kind === "physical" ? sourceAdmission.canonicalRoot : undefined;
        sourceCwd = sourceAdmission.cwd;
      } else {
        const root = await waitWithSignal(deps.resolveWorkspaceRoot(caller.executionWorkspaceId), signal);
        if (!root) throw new HarnessServiceError("unavailable", `Workspace root is unavailable: ${caller.executionWorkspaceId}`);
        sourceRoot = await waitWithSignal(canonicalizePathIdentity(root), signal);
        sourceCwd = await waitWithSignal(resolveCwd(sourceRoot, params.cwd, caller.workspaceScope), signal);
      }
    }
    const acceptedAt = now();
    const acceptedAttempt: ExperimentAttemptView = { attemptId, specId: spec?.specId ?? null, cancelRequested: false, backend: "unresolved",
      state: "submitted", collection: "none", createdAt: acceptedAt,
      ...(caller.threadId ? {threadId:caller.threadId} : {}), ...(caller.runId ? {runId:caller.runId} : {}),
      ...(params.requestId ? {requestId:params.requestId} : {}), ...(params.retryOfAttemptId ? {retryOfAttemptId:params.retryOfAttemptId} : {}),
      ...(caller.owner.runtime === "agent" ? { permissions: { control:true } } : {}) };
    const acceptance = { spec, attempt: acceptedAttempt, text: describeAttempt(spec, acceptedAttempt) };
    let record: KernelRecordResult;
    try { record = await serializeAttempt(caller.workspaceId, attemptId, async () => {
      const existing = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
      if (existing) return existing;
      if (caller.threadId && sharedRuntime.stoppingThreads.has(`${caller.workspaceId}\0${caller.threadId}`)) {
        throw new HarnessServiceError("unavailable", `Thread ${caller.threadId} is stopping and cannot submit a new experiment`);
      }
      signal?.throwIfAborted();
      try {
        return await putRecord(ctx, caller.workspaceId, caller, {
          recordId: recordIdFor.attempt(attemptId), recordType: "experiment.attempt", state: "submitted",
          payload: { id: attemptId, specId: spec?.specId ?? null, backend: "unresolved", cancelRequested: false,
            executionWorkspaceId: caller.executionWorkspaceId,
            workspaceScope: [...(caller.workspaceScope ?? [])], submissionFingerprint: fingerprint,
            submission: params, acceptance, sourceAdmission, sourceRoot, sourceCwd, resolvedInputs, retrySpecId, phase: "accepted", createdAt: acceptedAt,
            ...(params.requestId ? { requestId: params.requestId } : {}),
            ...(params.retryOfAttemptId ? { retryOfAttemptId: params.retryOfAttemptId } : {}),
          },
        });
      } catch (error) {
        const raced = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
        if (!raced) throw error;
        return raced;
      }
    });
    } catch (error) {
      // A failed ACK may still have admitted this exact attempt. Release only an unadopted pin.
      const durable = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
      if (sourceAdmission && !durable) await deps.sourceAuthority!.release(caller, sourceAdmission);
      throw error;
    }
    if (sourceAdmission && JSON.stringify(payloadOf(record).sourceAdmission) !== JSON.stringify(sourceAdmission)) await deps.sourceAuthority!.release(caller, sourceAdmission);
    const result = await reuse(record);
    notify(caller.workspaceId, attemptId, result.attempt);
    try { deps.onAttemptChanged?.(caller.workspaceId); } catch { /* observers do not own admission */ }
    return result;
  };

  /** Settle only this attempt's recorded candidate; published specs keep their original branch. */
  const releaseSourceAdmission = async (ctx: ExperimentContext, workspaceId: string, record: KernelRecordResult): Promise<void> => {
    const payload = payloadOf(record);
    if (!payload.sourceAdmission || payload.sourceAdmissionReleased === true) return;
    if (!deps.sourceAuthority) throw new HarnessServiceError("unavailable", "Original native source release owner is unavailable");
    const owner = recordCaller(workspaceId, record);
    await deps.sourceAuthority.release(owner, payload.sourceAdmission as ExperimentSourceAdmission);
    await updateAttempt(ctx, workspaceId, owner, str(payload.id)!, (view) => view.state, (current) => ({ ...current, sourceAdmissionReleased: true }));
  };

  const settleInputCandidate = async (ctx: ExperimentContext, workspaceId: string, record: KernelRecordResult): Promise<boolean> => {
    const payload = payloadOf(record);
    const capture = payload.inputCapture as ExperimentInputCapture | undefined;
    if (!capture || payload.inputCaptureDisposition === "spec" || payload.inputCaptureDisposition === "released") return true;
    const id = str(payload.id)!;
    const owner = recordCaller(workspaceId, record);
    const recipient = str(payload.inputCandidateSpecId);
    if (recipient) {
      const specRecord = await ctx.scoped.getRecord(workspaceId, recordIdFor.spec(recipient));
      if (specRecord) {
        const snapshot = inputSnapshotOf(specRecord);
        if (!snapshot) throw new Error("Experiment candidate recipient spec is unreadable");
        if (snapshot.branchId === capture.branchId) {
          await updateAttempt(ctx, workspaceId, owner, id, (view) => view.state, (p) => ({ ...p, inputCaptureDisposition: "spec" }));
          return true;
        }
      }
    }
    const cleanupOperationId = `experiment-input-candidate-release:${capture.branchId}`;
    const deletion = await ctx.scoped.getOperation(cleanupOperationId);
    if (deletion !== null) {
      const result = deletion.result as Record<string, unknown> | undefined;
      if (deletion.state !== "committed" || result?.branchId !== capture.branchId || typeof result.deleted !== "boolean") return false;
    } else {
      const receipt = await ctx.scoped.getOperation(`experiment-input-branch:${capture.branchId}`);
      if (receipt === null) {
        // A locally observed pre-dispatch failure is evidence; an absent reply after restart is not.
        if (payload.captureCreateUnsent !== true) return false;
      } else {
        const result = receipt.result as Record<string, unknown> | undefined;
        if (receipt.state !== "committed" || result?.branchId !== capture.branchId || result.created !== true || typeof result.root !== "string") return false;
        const branch = await ctx.scoped.readBranch({ branchId: capture.branchId });
        if (branch.workspaceId !== workspaceId || branch.root !== result.root || branch.currentRoot !== result.root) {
          throw new Error("Experiment candidate branch no longer matches its original creation receipt");
        }
        const deleted = await ctx.scoped.deleteBranch({ operationId: cleanupOperationId, branchId: capture.branchId });
        if (deleted.deleted !== true) return false;
      }
    }
    await updateAttempt(ctx, workspaceId, owner, id, (view) => view.state, (p) => ({ ...p, inputCaptureDisposition: "released" }));
    return true;
  };

  const prepareAccepted = async (ctx: ExperimentContext, caller: ExperimentCaller, record: KernelRecordResult, signal: AbortSignal): Promise<KernelRecordResult> => {
    const attempt = attemptView(record)!;
    const payload = payloadOf(record);
    const params = payload.submission as ExperimentSubmitParams | undefined;
    if (!params || typeof params !== "object") throw new Error("Experiment submission intent is unavailable");
    let specRecord: KernelRecordResult;
    if (attempt.specId) {
      specRecord = await requireSpec(ctx, caller, attempt.specId);
    } else {
      const sourceRoot = str(payload.sourceRoot);
      if ((!sourceRoot && !payload.sourceAdmission) || typeof payload.sourceCwd !== "string") throw new Error("Experiment source identity is unavailable");
      const inputs = Array.isArray(payload.resolvedInputs) ? payload.resolvedInputs as ExperimentInputRef[] : null;
      if (!inputs) throw new Error("Experiment authorized input metadata is unavailable");
      signal.throwIfAborted();
      const capture = payloadOf(record).inputCapture as ExperimentInputCapture | undefined;
      let inputSnapshot = capture ? await recoverExperimentInput(deps.client, caller, capture, signal) : null;
      if (!inputSnapshot) {
        await updateAttempt(ctx, caller.workspaceId, caller, attempt.attemptId, (current) => current.state,
          (p) => ({ ...p, captureStarted: true, captureDrained: false }));
        try {
          const captureOptions = {
            captureScopes: caller.workspaceScope ?? [], cwd: payload.sourceCwd, signal,
            branchId: `experiment-input-${digestId(caller.workspaceId, attempt.attemptId).slice(0, 40)}`,
            beforeBranchCreate: async (inputCapture: ExperimentInputCapture) => {
              signal.throwIfAborted();
              await updateAttempt(ctx, caller.workspaceId, caller, attempt.attemptId, "submitted", (p) => ({ ...p, inputCapture, captureCreateUnsent: false }), (view) => view.state === "submitted");
              signal.throwIfAborted();
            },
          };
          inputSnapshot = caller.owner.runtime === "agent"
            ? await (() => { if (!deps.sourceAuthority || !payload.sourceAdmission) throw new HarnessServiceError("unavailable", "Original native research source owner is unavailable");
                return deps.sourceAuthority.capture(caller, payload.sourceAdmission as ExperimentSourceAdmission, captureOptions); })()
            : await prepareExperimentInput(deps.client, caller, sourceRoot!, captureOptions);
          await updateAttempt(ctx, caller.workspaceId, caller, attempt.attemptId, (current) => current.state,
            (p) => ({ ...p, captureDrained: true }));
        } catch (error) {
          if (error instanceof ExperimentInputCaptureError && !error.branchCreateDispatched) await updateAttempt(ctx, caller.workspaceId, caller, attempt.attemptId, (current) => current.state,
            (p) => ({ ...p, captureCreateUnsent: true }));
          if (error instanceof ExperimentPreparationError && error.drained) await updateAttempt(ctx, caller.workspaceId, caller, attempt.attemptId, (current) => current.state,
            (p) => ({ ...p, captureDrained: true }));
          throw error;
        }
      }
      await assertInputPathsCaptured(ctx, inputSnapshot, inputs);
      signal.throwIfAborted();
      const contentDigest = specDigest({ command: params.command!, args: params.args ?? [], cwd: payload.sourceCwd,
        env: params.env ?? {}, inputs, outputPaths: params.outputPaths ?? [], resources: params.resources ?? {}, inputRoot: inputSnapshot.root });
      // The immutable spec retains its creator's record access boundary; only content blobs deduplicate across owners.
      const specOwner = caller.threadId ? ["thread", caller.threadId] : caller.sessionId ? ["session", caller.sessionId] : ["host"];
      const specId = `spec-${digestId(caller.workspaceId, callerNamespace(caller), ...specOwner, contentDigest).slice(0, 40)}`;
      // Record the sole possible recipient before publishing the spec, including lost-write-ACK recovery.
      record = await updateAttempt(ctx, caller.workspaceId, caller, attempt.attemptId, (view) => view.state,
        (p) => ({ ...p, inputCandidateSpecId: specId }));
      signal.throwIfAborted();
      const existing = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(specId));
      if (existing) {
        if (payloadOf(existing).contentDigest !== contentDigest) throw new Error("Experiment spec identity collision");
        specRecord = await requireSpec(ctx, caller, specId);
      } else {
        try {
          specRecord = await putRecord(ctx, caller.workspaceId, caller, {
            recordId: recordIdFor.spec(specId), recordType: "experiment.spec", state: "active",
            payload: { id: specId, workspaceId: caller.workspaceId, contentDigest,
              ...(params.title ? { title: params.title } : {}), command: params.command, args: params.args ?? [],
              ...(payload.sourceCwd ? { cwd: payload.sourceCwd } : {}), env: params.env ?? {}, inputs, inputSnapshot,
              ...(params.resources ? { resources: params.resources } : {}), outputPaths: params.outputPaths ?? [], createdAt: now() },
            references: inputs.flatMap((input, index) => input.objectHash ? [{ slot: `input:${index}`, objectHash: input.objectHash }] : []),
          });
        } catch (error) {
          const raced = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.spec(specId));
          if (!raced || payloadOf(raced).contentDigest !== contentDigest) throw error;
          specRecord = await requireSpec(ctx, caller, specId);
        }
      }
      record = await updateAttempt(ctx, caller.workspaceId, caller, attempt.attemptId, "submitted", (p) => ({ ...p, specId, phase: "placing" }), (view) => view.state === "submitted");
    }
    if (!await settleInputCandidate(ctx, caller.workspaceId, record)) throw new Error("Experiment input candidate cleanup remains pending");
    await releaseSourceAdmission(ctx, caller.workspaceId, record);
    signal.throwIfAborted();
    const spec = specView(specRecord)!;
    const resources = submissionResources(spec.resources ?? {});
    if (params.retryOfAttemptId) {
      if (!str(payload.retrySpecId)) throw new Error("Experiment authorized retry binding is unavailable");
      if (payload.retrySpecId !== spec.specId) throw new HarnessServiceError("invalid-params", "Retry source uses a different experiment spec");
    }
    const machineId = await selectMachine(caller.workspaceId, resources, params.machineId, str(payloadOf(record).machineId));
    signal.throwIfAborted();
    if (machineId !== LOCAL_MACHINE_ID && !payload.preparationStarted && !await deps.resources.getMachineRecord(caller.workspaceId, machineId)) {
      throw new HarnessServiceError("not-found", `Machine is not registered: ${machineId}`);
    }
    return updateAttempt(ctx, caller.workspaceId, caller, attempt.attemptId, "submitted", (p) => ({ ...p, machineId,
      resources, phase: "preparing", preparationError: undefined }), (view) => view.state === "submitted");
  };

  const finishUnspawnedCancellation = async (ctx: ExperimentContext, workspaceId: string, record: KernelRecordResult): Promise<void> => {
    const payload = payloadOf(record);
    if (record.state !== "stopping" || payload.spawnDispatched) return;
    const id = str(payload.id)!;
    if (payload.captureStarted && payload.captureDrained !== true) {
      const sourceRoot = str(payload.sourceRoot);
      const admission = payload.sourceAdmission as ExperimentSourceAdmission | undefined;
      if (admission?.kind === 'managed') {
        await releaseSourceAdmission(ctx, workspaceId, record);
        record = (await getAttemptRecord(ctx, workspaceId, id))!;
      } else if (admission?.kind !== "fixed"
        && (!sourceRoot || await reconcileExperimentCapture(deps.client, recordCaller(workspaceId, record), sourceRoot, strArray(payload.workspaceScope)) !== "drained")) return;
      record = await updateAttempt(ctx, workspaceId, recordCaller(workspaceId, record), id, (current) => current.state,
        (p) => ({ ...p, captureDrained: true }));
    }
    if (payload.preparationStarted && payload.preparationDrained !== true) {
      const owner = recordCaller(workspaceId, record);
      const specId = str(payload.specId);
      if (!specId) throw new Error("Unsettled preparation has no frozen spec");
      const specRecord = await requireSpec(ctx, owner, specId);
      const input = inputSnapshotOf(specRecord)!;
      const resolved = await resolveBackend(ctx, owner, str(payload.machineId) ?? LOCAL_MACHINE_ID);
      if (!resolved?.reconcilePreparation || await resolved.reconcilePreparation({ attemptId: id, input }) !== "drained") return;
      record = await updateAttempt(ctx, workspaceId, owner, id, (current) => current.state,
        (p) => ({ ...p, preparationDrained: true, preparationUncertain: false }));
    }
    // Admission can have committed remotely before its reply reached this owner. Only the original resource owner can reconcile it.
    if (payload.admissionStarted && !str(payload.commitmentId) && payload.admissionDrained !== true) {
      const admission = await deps.resources.reconcileAdmission(workspaceId, str(payload.machineId) ?? LOCAL_MACHINE_ID,
        (payload.resources ?? {}) as ExperimentResourceRequest, id);
      if (admission.status === "unknown") return;
      record = await updateAttempt(ctx, workspaceId, recordCaller(workspaceId, record), id, (current) => current.state,
        (p) => ({ ...p, admissionDrained: true, ...(admission.status === "confirmed" ? { commitmentId: admission.commitmentId } : {}) }));
    }
    if (!await settleInputCandidate(ctx, workspaceId, record)) return;
    await releaseSourceAdmission(ctx, workspaceId, record);
    const cancelled = await updateAttempt(ctx, workspaceId, recordCaller(workspaceId, record), id, "cancelled", (p, nextRevision) => {
      if (!unspawnedDrained(p)) throw new HarnessServiceError("unavailable", "Original unspawned preparation is not drained");
      return { ...p, endedAt: now(), collection: "none", phase: "settled", collectionCompletion: { recordRevision: nextRevision, outcome: "not_started" } };
    }, (view) => view.state === "stopping");
    await releaseTerminalCommitment(ctx, workspaceId, cancelled);
    await retireAttemptAuthority(recordCaller(workspaceId,cancelled));
  };

  const reconcileAttempt = (
    ctx: ExperimentContext,
    workspaceId: string,
    caller: ExperimentCaller,
    record: KernelRecordResult,
    preResolved?: ResolvedExperimentBackend,
  ): Promise<void> => {
    const initial = attemptView(record);
    if (!initial) return Promise.reject(new Error(`Experiment attempt is unreadable: ${record.recordId}`));
    const key = attemptKey(workspaceId, initial.attemptId);
    const existing = sharedRuntime.flights.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const signal = controller.signal;
    const flight: AttemptFlight = { controller, promise: Promise.resolve() };
    sharedRuntime.flights.set(key, flight);
    flight.promise = (async () => {
      let fresh = await getAttemptRecord(ctx, workspaceId, initial.attemptId);
      let attempt = fresh ? attemptView(fresh) : null;
      if (!fresh || !attempt || attempt.state === "lost") return;
      let payload = payloadOf(fresh);
      if (TERMINAL.has(attempt.state)) {
        if (!await settleInputCandidate(ctx, workspaceId, fresh)) return;
        await releaseSourceAdmission(ctx, workspaceId, fresh);
        await releaseTerminalCommitment(ctx, workspaceId, fresh);
        if (!payload.spawnDispatched) {
          if (unspawnedDrained(payload) && !payload.collectionCompletion) {
            fresh = await updateAttempt(ctx, workspaceId, recordCaller(workspaceId, fresh), attempt.attemptId, current => current.state,
              (p, nextRevision) => {
                if (!unspawnedDrained(p)) throw new HarnessServiceError("unavailable", "Original unspawned preparation is not drained");
                return { ...p, collectionCompletion: { recordRevision: nextRevision, outcome: "not_started" } };
              });
          }
          if (unspawnedDrained(payloadOf(fresh))) await retireAttemptAuthority(recordCaller(workspaceId,fresh));
          return;
        }
      }
      if (attempt.state === "stopping" && !payload.spawnDispatched) {
        await finishUnspawnedCancellation(ctx, workspaceId, fresh);
        return;
      }
      const key = attemptKey(workspaceId, attempt.attemptId);
      const existingJob = jobs.get(key);
      if (existingJob) {
        existingJob.cancelRequested ||= attempt.state === "stopping" || payload.cancelRequested === true;
        if (existingJob.cancelRequested && !existingJob.finalized) void requestBackendStop(ctx, workspaceId, fresh, existingJob).catch(report);
        if (existingJob.finalized && !existingJob.collection
          && (attempt.collection === "pending" || attempt.collection === "done")) {
          void finalize(ctx, workspaceId, attempt.attemptId, existingJob).catch(report);
        }
        return;
      }
      if ((attempt.state === "submitted" || attempt.state === "queued") && !payload.spawnDispatched) {
        if (attempt.state === "submitted") {
          fresh = await prepareAccepted(ctx, caller, fresh, signal);
          attempt = attemptView(fresh)!;
          payload = payloadOf(fresh);
        }
        signal.throwIfAborted();
        const resources = (payload.resources ?? {}) as ExperimentResourceRequest;
        const needsAdmission = (["cpuCores", "memoryMb", "gpuCount", "gpuMemoryMb"] as const)
          .some((dimension) => (resources[dimension] ?? 0) > 0);
        if (needsAdmission && !str(payload.commitmentId)) {
          if (payload.admissionStarted && payload.admissionDrained !== true) {
            const outcome = await deps.resources.reconcileAdmission(workspaceId, attempt.machineId ?? LOCAL_MACHINE_ID, resources, attempt.attemptId);
            if (outcome.status === "unknown") {
              await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, (view) => view.state,
                (p) => ({ ...p, preparationError: "Previous resource admission has no confirmed outcome; reconciliation remains pending" }));
              return;
            }
            fresh = await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, (view) => view.state,
              (p) => ({ ...p, admissionDrained: true, ...(outcome.status === "confirmed" ? { commitmentId: outcome.commitmentId } : {}) }));
            payload = payloadOf(fresh);
            signal.throwIfAborted();
          }
          if (!str(payload.commitmentId)) {
            await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, attempt.state, (p) => ({ ...p, admissionStarted: true, admissionDrained: false }), (view) => view.state === attempt!.state);
            signal.throwIfAborted();
            const admission = await deps.resources.admit(workspaceId, attempt.machineId ?? LOCAL_MACHINE_ID, resources, attempt.attemptId);
            if (admission.status !== "confirmed") {
              const pending = await updateAttempt(ctx, workspaceId, caller, attempt.attemptId,
                (view) => view.state === "stopping" ? "stopping" : "queued", (p) => ({ ...p,
                  admissionDrained: true, admissionState: "pending", queueReason: admission.reason ?? "insufficient resources" }),
                (view) => view.state === "submitted" || view.state === "queued" || view.state === "stopping");
              if (pending.state === "queued") {
                const set = queued.get(workspaceId) ?? new Set<string>(); set.add(attempt.attemptId); queued.set(workspaceId, set);
              }
              return;
            }
            if (!admission.commitmentId) throw new Error("Resource admission returned no commitment identity");
            // Persist even a late admission receipt before handling cancellation.
            const latest = await getAttemptRecord(ctx, workspaceId, attempt.attemptId);
            if (!latest) throw new Error("Experiment attempt disappeared during resource admission");
            fresh = await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, (current) => current.state,
              (p) => ({ ...p, commitmentId: admission.commitmentId, admissionDrained: true, admissionState: "confirmed", queueReason: undefined }));
            signal.throwIfAborted();
          }
        }
        if (fresh.state === "queued") fresh = await updateAttempt(ctx, workspaceId, caller, attempt.attemptId, "submitted", (p) => ({ ...p, queueReason: undefined }), (view) => view.state === "queued");
        queued.get(workspaceId)?.delete(attempt.attemptId);
        signal.throwIfAborted();
        await launch(ctx, workspaceId, recordCaller(workspaceId, fresh), fresh, preResolved, signal);
        return;
      }

      const jobRecord = await ctx.scoped.getRecord(workspaceId, recordIdFor.job(jobIdFor(attempt.attemptId))).catch(() => null);
      if (jobRecord?.state === "released") { await retireAttemptAuthority(recordCaller(workspaceId,fresh)); return; }
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
        finalized: TERMINAL.has(attempt.state) && jobPayload.executorStopped === true && jobPayload.outputDrained === true,
        observerOwner: serviceToken,
        poll: Promise.resolve(),
      };
      if (running.finalized) {
        jobs.set(key, running);
        void finalize(ctx, workspaceId, attempt.attemptId, running).catch(report);
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
          }), (view) => view.state === attempt!.state);
          running.site = {
            ...running.site,
            rootId: observation.executionRootId,
            canonicalRoot: observation.executionCanonicalRoot,
          };
          record = reconciled;
        }
        const latest = await getAttemptRecord(ctx, workspaceId, attempt.attemptId);
        if (!latest) throw new Error(`Experiment attempt disappeared during backend attachment: ${attempt.attemptId}`);
        running.cancelRequested ||= latest.state === "stopping" || payloadOf(latest).cancelRequested === true;
        if (running.cancelRequested && (!STOPPED_BACKEND_STATES.has(observation.status) || observation.writerActive)) {
          void requestBackendStop(ctx, workspaceId, latest, running).catch(report);
        }
        if (observation.status === "unknown") {
          await upsertJob(ctx, workspaceId, caller, attempt.attemptId, "unknown", {
            backendJobId, backend: executionResolved.backend.backend,
            reason: observation.reason ?? "backend state is not currently observable", lastObservedAt: now(),
          });
          running.lastObservationKey = `unknown\0${observation.reason ?? ""}`;
          startPolling(ctx, workspaceId, caller, attempt.attemptId, running);
          return;
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
    })().catch(async (error) => {
      if (!signal.aborted) {
        const current = await getAttemptRecord(ctx, workspaceId, initial.attemptId);
        let definiteFailure = (error instanceof ExperimentPreparationError && error.drained && !error.retryable)
            || (error instanceof HarnessServiceError && ["invalid-params", "not-found", "forbidden"].includes(error.harnessCode));
        if (definiteFailure && current) definiteFailure = await settleInputCandidate(ctx, workspaceId, current);
        if (current && !TERMINAL.has(current.state as ExperimentAttemptState)) {
          await updateAttempt(ctx, workspaceId, caller, initial.attemptId,
            (view) => definiteFailure && view.state !== "stopping" ? "failed" : view.state,
            (p) => ({ ...p, preparationError: errorMessage(error), ...(definiteFailure ? { endedAt: now() } : {}) }));
        }
        if (!definiteFailure) report(error);
      }
    }).finally(async () => {
      try {
        const current = await getAttemptRecord(ctx, workspaceId, initial.attemptId);
        if (current?.state === "stopping" && !payloadOf(current).spawnDispatched) await finishUnspawnedCancellation(ctx, workspaceId, current);
        else if (current && TERMINAL.has(current.state as ExperimentAttemptState)) await releaseTerminalCommitment(ctx, workspaceId, current);
      } finally {
        if (sharedRuntime.flights.get(key) === flight) sharedRuntime.flights.delete(key);
        // A retired service can finish an admitted worker. Hand observation to a live owner only after it drains.
        if (disposed) sharedRuntime.resumers.values().next().value?.(workspaceId, initial.attemptId);
      }
    });
    return flight.promise;
  };

  const submit = async (
    caller: ExperimentCaller,
    params: ExperimentSubmitParams,
    signal?: AbortSignal,
  ): Promise<{ spec: ExperimentSpecView | null; attempt: ExperimentAttemptView; text: string }> => {
    if (!caller.threadId) return submitUnsafe(caller, params, signal);
    const key = `${caller.workspaceId}\0${caller.threadId}`;
    const submitted = submitUnsafe(caller, params, signal);
    const subjectKey=params.requestId ? attemptKey(caller.workspaceId,attemptIdForRequest(caller,params.requestId)) : undefined;
    const subjectAdmissions=subjectKey ? sharedRuntime.submissionsByAttempt.get(subjectKey) ?? new Set<Promise<unknown>>() : undefined;
    if(subjectKey && subjectAdmissions){subjectAdmissions.add(submitted);sharedRuntime.submissionsByAttempt.set(subjectKey,subjectAdmissions);}
    const active = sharedRuntime.submissionsByThread.get(key) ?? new Set<Promise<unknown>>();
    active.add(submitted);
    sharedRuntime.submissionsByThread.set(key, active);
    void submitted.finally(() => {
      active.delete(submitted);
      if(subjectKey && subjectAdmissions){subjectAdmissions.delete(submitted);if(!subjectAdmissions.size)sharedRuntime.submissionsByAttempt.delete(subjectKey);}
      if (active.size === 0 && sharedRuntime.submissionsByThread.get(key) === active) {
        sharedRuntime.submissionsByThread.delete(key);
      }
    }).catch(() => undefined);
    return submitted;
  };

  const describeAttempt = (spec: ExperimentSpecView | null, attempt: ExperimentAttemptView | null): string => {
    if (!attempt) throw new HarnessServiceError("failed", "Experiment attempt record is unreadable");
    if (!spec) return `attempt ${attempt.attemptId} ${attempt.state}: accepted; input preparation pending`;
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
    void ensureReconciled(caller.workspaceId).catch(report);
    const ctx = await recordContext(caller.workspaceId);
    const record = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
    const view = record ? attemptView(record) : null;
    if (!record) throw new HarnessServiceError("not-found", `Unknown experiment attempt: ${attemptId}`);
    if (!view) throw new HarnessServiceError("failed", `Experiment attempt is unreadable: ${attemptId}`);
    assertRecordAllowed(caller, record, `experiment attempt: ${attemptId}`);
    return { ctx, record, view };
  };

  const get = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentGetResult> => {
    const { ctx, view, record } = await requireAttempt(caller, attemptId);
    const specRecord = view.specId ? await requireSpec(ctx, caller, view.specId) : null;
    const spec = specRecord && recordAllowed(caller, specRecord) ? specView(specRecord) : null;
    const jobRecord = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.job(jobIdFor(attemptId)));
    const job = jobRecord ? jobView(jobRecord) : null;
    const artifacts: ExperimentArtifactView[] = [];
    let after: string | undefined;
    do {
      const page = await ctx.scoped.experimentArtifacts({ workspaceId: caller.workspaceId, attemptId, ...(after ? { after } : {}) });
      for (const item of page.records) {
        assertRecordAllowed(caller, item, `experiment artifact: ${item.recordId}`);
        const artifact = artifactView(item);
        if (!artifact || artifact.attemptId !== attemptId) throw new HarnessServiceError("unavailable", "Original artifact record is unreadable");
        artifacts.push(artifact);
      }
      after = page.nextCursor ?? undefined;
    } while (after !== undefined);
    return {
      attempt: callerView(caller, record, view),
      ...(spec ? { spec } : {}),
      ...(job ? { job } : {}),
      artifacts,
    };
  };

  /** Original metadata only. The observer's read authority never becomes target control authority. */
  const readArtifactObservation = async (
    caller: ExperimentCaller,
    binding: import("../kernel/protocol.generated.js").HostJobBinding,
    selector: { artifactId?: string; name?: string },
    signal?: AbortSignal,
  ) => {
    const subject = binding.subject;
    if (subject.kind !== "workspace" || caller.access.kind !== "family" || caller.workspaceId !== subject.workspaceId || binding.domain !== "research.experiment" || binding.domainVersion !== 1) {
      throw new HarnessServiceError("denied", "Artifact observation requires its actual family reader and original research binding");
    }
    for (;;) {
      signal?.throwIfAborted();
      const before = await requireAttempt(caller, subject.subjectId);
      const original = researchOwner(before.record);
      if (original.runtime !== "agent" || original.operationId !== binding.operationId
        || !isDeepStrictEqual(original.executionOwner, binding.executionOwner)) {
        throw new HarnessServiceError("denied", "Artifact observation target differs from its original accepted owner");
      }
      const artifacts: ExperimentArtifactView[] = [];
      const selectedId = selector.artifactId ?? (selector.name ? artifactIdFor(subject.subjectId, selector.name) : undefined);
      const accept = (record: KernelRecordResult) => {
        assertRecordAllowed(caller, record, `experiment artifact: ${record.recordId}`);
        const artifact = artifactView(record), owner = researchOwner(record);
        if (!artifact || artifact.attemptId !== subject.subjectId || payloadOf(record).internalLogChunk === true
          || owner.runtime !== "agent" || owner.operationId !== binding.operationId || !isDeepStrictEqual(owner.executionOwner, binding.executionOwner)) {
          throw new HarnessServiceError("unavailable", "Original artifact metadata or provenance is unreadable");
        }
        if (selector.name && artifact.name !== selector.name && artifact.path !== selector.name) {
          throw new HarnessServiceError("unavailable", "Original artifact name binding changed");
        }
        if (!Number.isSafeInteger(artifact.recordRevision) || artifact.recordRevision < 1
          || !["pending", "available", "failed", "expired"].includes(artifact.state)) {
          throw new HarnessServiceError("unavailable", "Original artifact state or revision is unreadable");
        }
        artifacts.push(artifact);
      };
      if (selectedId) {
        const record = await before.ctx.scoped.getRecord(caller.workspaceId, recordIdFor.artifact(selectedId), signal);
        if (record) accept(record);
      } else {
        let after: string | undefined;
        do {
          signal?.throwIfAborted();
          const page = await before.ctx.scoped.experimentArtifacts({ workspaceId: caller.workspaceId, attemptId: subject.subjectId, ...(after ? { after } : {}) }, signal);
          for (const record of page.records) accept(record);
          if (page.nextCursor !== null && (page.nextCursor === after || page.nextCursor.length === 0)) throw new HarnessServiceError("unavailable", "Artifact metadata cursor did not advance");
          after = page.nextCursor ?? undefined;
        } while (after !== undefined);
      }
      const after = await requireAttempt(caller, subject.subjectId);
      const stamp = (view: ExperimentAttemptView) => JSON.stringify([view.collection, view.collectionCompletion ?? null]);
      if (stamp(before.view) !== stamp(after.view)) continue;
      const completion = after.view.collectionCompletion;
      const settled = completion && (completion.outcome === after.view.collection || (completion.outcome === "not_started" && after.view.collection === "none"));
      return { attempt: after.view, attemptRevision: after.record.recordRevision, artifacts,
        completion: settled ? completion : null,
        counts: artifacts.reduce((counts, artifact) => { counts[artifact.state]++; return counts; }, { available: 0, failed: 0, expired: 0, pending: 0 }) };
    }
  };

  const list = async (
    caller: ExperimentCaller,
    params: { state?: ExperimentAttemptState; specId?: string; limit?: number },
  ): Promise<ExperimentListResult> => {
    void ensureReconciled(caller.workspaceId).catch(report);
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
        if (!view) throw new HarnessServiceError("failed", `Experiment attempt is unreadable: ${record.recordId}`);
        if (params.state && view.state !== params.state) continue;
        if (params.specId && view.specId !== params.specId) continue;
        attempts.push(callerView(caller, record, view));
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

  const requestBackendStop = (
    ctx: ExperimentContext,
    workspaceId: string,
    record: KernelRecordResult,
    running?: RunningJob,
  ): Promise<void> => {
    const attempt = attemptView(record)!;
    const key = attemptKey(workspaceId, attempt.attemptId);
    // A late spawn reply can reveal the backend's native identity; do not let an older stop flight suppress it.
    const stopKey = `${key}\0${running?.handle.backendJobId ?? "dispatch"}`;
    const existing = sharedRuntime.stops.get(stopKey);
    if (existing) return existing;
    const stopping = (async () => {
      const owner = recordCaller(workspaceId, record);
      const resolved = running ?? await resolveBackend(await contextForAttempt(owner, record), owner, attempt.machineId ?? LOCAL_MACHINE_ID);
      if (!resolved) throw new Error("Execution backend is unavailable; cancellation remains pending");
      if (!resolved.backend.controls.includes("cancel")) throw new Error(`Backend ${resolved.backend.backend} does not support cancellation`);
      const job = await ctx.scoped.getRecord(workspaceId, recordIdFor.job(jobIdFor(attempt.attemptId)));
      const backendJobId = running?.handle.backendJobId ?? str(job ? payloadOf(job).backendJobId : null) ?? processIdFor(workspaceId, attempt.attemptId);
      try {
        await resolved.backend.kill(resolved.site, backendJobId);
      } catch (error) {
        await upsertJob(ctx, workspaceId, owner, attempt.attemptId, "unknown", {
          backendJobId, reason: `termination could not be confirmed: ${errorMessage(error)}`, lastObservedAt: now(),
        });
        throw error;
      }
    })().finally(() => { if (sharedRuntime.stops.get(stopKey) === stopping) sharedRuntime.stops.delete(stopKey); });
    sharedRuntime.stops.set(stopKey, stopping);
    return stopping;
  };

  const cancel = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentAttemptView> => {
    const { ctx, record, view } = await requireAttempt(caller, attemptId);
    assertRecordControlled(caller, record);
    if (TERMINAL.has(view.state)) return callerView(caller, record, view);
    // This CAS is the control receipt. It never joins preparation, admission, spawn, or workspace reconciliation.
    const stopping = await updateAttempt(ctx, caller.workspaceId, caller, attemptId, "stopping", (p) => ({
      ...p, cancelRequested: true,
    }), (current) => !TERMINAL.has(current.state));
    const stoppedView = attemptView(stopping)!;
    if (TERMINAL.has(stoppedView.state)) return callerView(caller, stopping, stoppedView);
    const key = attemptKey(caller.workspaceId, attemptId);
    queued.get(caller.workspaceId)?.delete(attemptId);
    const flight = sharedRuntime.flights.get(key);
    flight?.controller.abort();
    const running = jobs.get(key);
    if (running) running.cancelRequested = true;
    if (payloadOf(stopping).spawnDispatched || running) void requestBackendStop(ctx, caller.workspaceId, stopping, running).catch(report);
    if (!flight) void reconcileAttempt(ctx, caller.workspaceId, recordCaller(caller.workspaceId, record), stopping).catch(report);
    return callerView(caller, stopping, stoppedView);
  };

  const wait = async (
    caller: ExperimentCaller,
    attemptId: string,
    timeoutMs?: number | null,
    signal?: AbortSignal,
  ): Promise<{ attempt: ExperimentAttemptView; timedOut: boolean }> => {
    const { view } = await requireAttempt(caller, attemptId);
    if (TERMINAL.has(view.state)) return { attempt: view, timedOut: false };
    const deadline = timeoutMs === null ? null : timeoutMs === undefined ? 30_000 : Math.max(0, timeoutMs);
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
      const timer = deadline === null ? undefined : setTimeout(() => {
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

  /** Raw published bytes for the original accepted research Job. No UTF-8
   * display pagination, inferred stop, copied log, or observer-owned storage. */
  const readLogObservation = async (
    caller: ExperimentCaller,
    binding: import("../kernel/protocol.generated.js").HostJobBinding,
    input: { stream: "stdout" | "stderr"; offset: number; maxBytes?: number },
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const subject = binding.subject;
    if (subject.kind !== "workspace" || caller.access.kind !== "family" || caller.workspaceId !== subject.workspaceId || binding.domain !== "research.experiment" || binding.domainVersion !== 1) {
      throw new HarnessServiceError("denied", "Log observation requires its actual family reader and original research Job");
    }
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new HarnessServiceError("invalid-params", "Log byte offset must be a nonnegative safe integer");
    const { ctx, record, view } = await requireAttempt(caller, subject.subjectId);
    const requireOriginal = (record: KernelRecordResult) => {
      assertRecordAllowed(caller, record, `experiment log owner: ${record.recordId}`);
      const owner = researchOwner(record);
      if (owner.runtime !== "agent" || owner.operationId !== binding.operationId || !isDeepStrictEqual(owner.executionOwner, binding.executionOwner)) {
        throw new HarnessServiceError("denied", "Log observation differs from its original accepted owner");
      }
    };
    requireOriginal(record);
    const job = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.job(jobIdFor(subject.subjectId)), signal);
    if (job) requireOriginal(job);
    const payload = job ? payloadOf(job) : null;
    const publishedBytes = payload ? payload[`${input.stream}Bytes`] ?? 0 : 0;
    if (!Number.isSafeInteger(publishedBytes) || (publishedBytes as number) < 0
      || (payload && payload.attemptId !== subject.subjectId)
      || (payload && payload[`${input.stream}Bytes`] === undefined && (num(payload.outputCursor) ?? 0) > 0)) {
      throw new HarnessServiceError("unavailable", "Original published log byte cursor is unreadable; retry after the research owner reconnects");
    }
    const end = publishedBytes as number;
    const maxBytes = input.maxBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new HarnessServiceError("invalid-params", "Log read size must be a positive safe integer");
    const range = input.offset < end
      ? await readLogRange(ctx, caller.workspaceId, subject.subjectId, input.stream, input.offset, maxBytes, signal, end, caller)
      : { bytes: Buffer.alloc(0), nextOffset: input.offset };
    signal?.throwIfAborted();
    return { bytes: range.bytes, offset: input.offset, nextOffset: range.nextOffset, publishedBytes: end,
      eof: originalOutputDrained(record, view, job) && range.nextOffset >= end,
      jobRevision: job?.recordRevision ?? null, attemptRevision: record.recordRevision };
  };

  const logs = async (
    caller: ExperimentCaller,
    params: { attemptId: string; stream?: "stdout" | "stderr"; offset?: number; maxBytes?: number },
  ): Promise<ExperimentLogsResult> => {
    const { ctx, view, record: attemptRecord } = await requireAttempt(caller, params.attemptId);
    const jobRecord = await ctx.scoped.getRecord(caller.workspaceId, recordIdFor.job(jobIdFor(params.attemptId)));
    const outputDrained = originalOutputDrained(attemptRecord, view, jobRecord);
    const stream = params.stream ?? "stdout";
    const offset = Math.max(0, params.offset ?? 0);
    const maxBytes = Math.max(1, Math.floor(params.maxBytes ?? 64 * 1024));
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
        eof: outputDrained,
        text: "",
        origin: outputDrained ? "artifact" : "live",
      };
    }
    const slice = sliceUtf8ByBytes(range.bytes, offset - windowStart, maxBytes);
    const nextOffset = windowStart + slice.nextOffset;
    return {
      attemptId: params.attemptId,
      stream,
      offset: windowStart + slice.offset,
      nextOffset,
      eof: outputDrained && nextOffset >= range.total,
      text: slice.text,
      origin: outputDrained ? "artifact" : "live",
    };
  };

  const collect = async (caller: ExperimentCaller, attemptId: string): Promise<ExperimentCollectResult> => {
    const { ctx, record, view } = await requireAttempt(caller, attemptId);
    assertRecordControlled(caller, record);
    if (!TERMINAL.has(view.state)) {
      throw new HarnessServiceError("invalid-params", `Attempt ${attemptId} is still ${view.state}; collect after it finishes`);
    }
    if (view.state === "lost") {
      throw new HarnessServiceError("unavailable", `Attempt ${attemptId} is lost; its backend state is unknown`);
    }
    if (!payloadOf(record).spawnDispatched) return { attempt: callerView(caller, record, view), artifacts: [] };
    // Reconnect only the original durable backend identity. The shared attempt
    // flight installs one holder; an in-flight automatic/manual collector stays
    // attached to that holder even when its service observer has been replaced.
    await reconcileAttempt(ctx, caller.workspaceId, recordCaller(caller.workspaceId, record), record);
    const key = attemptKey(caller.workspaceId, attemptId);
    const running = jobs.get(key);
    if (running?.collection) await running.collection;
    else if (running?.finalized) {
      if (!running.backend.controls.includes("collect")) {
        throw new HarnessServiceError("unavailable", `No backend can collect outputs for machine ${view.machineId ?? LOCAL_MACHINE_ID}`);
      }
      await finalize(ctx, caller.workspaceId, attemptId, running);
    } else {
      const current = await getAttemptRecord(ctx, caller.workspaceId, attemptId);
      if (!current || attemptView(current)?.collection !== "done") {
        throw new HarnessServiceError("unavailable", `Attempt ${attemptId} output reader is not yet reconnected`);
      }
    }
    const result = await get(caller, attemptId);
    return { attempt: result.attempt, artifacts: result.artifacts };
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
        const flight = sharedRuntime.flights.get(attemptKey(workspaceId, attempt.attemptId));
        if (flight) await flight.promise;
        const ctx = await recordContext(workspaceId);
        const latest = await getAttemptRecord(ctx, workspaceId, attempt.attemptId);
        if (!latest) throw new Error(`Experiment attempt disappeared: ${attempt.attemptId}`);
        if (TERMINAL.has(latest.state as ExperimentAttemptState)) return;
        const running = jobs.get(attemptKey(workspaceId, attempt.attemptId));
        if (payloadOf(latest).spawnDispatched) await requestBackendStop(ctx, workspaceId, latest, running);
        await reconcileAttempt(ctx, workspaceId, owner, latest);
        const waited = await wait(owner, attempt.attemptId, null);
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
    sharedRuntime.resumers.delete(serviceToken);
    for (const [key, running] of jobs) {
      if (running.observerOwner === serviceToken && !running.collection && !running.finalized) jobs.delete(key);
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

  sharedRuntime.resumers.set(serviceToken, (workspaceId, attemptId) => {
    void (async () => {
      const ctx = await recordContext(workspaceId);
      const record = await getAttemptRecord(ctx, workspaceId, attemptId);
      if (record) await reconcileAttempt(ctx, workspaceId, recordCaller(workspaceId, record), record);
    })().catch(report);
  });

  const submissionId = (caller: ExperimentCaller, requestId: string): string => {
    if (!requestId.trim()) throw new HarnessServiceError("invalid-params", "Stable submission identity is required");
    return attemptIdForRequest(caller,requestId);
  };
  const reconcileUnaccepted = async (caller: ExperimentCaller, attemptId: string): Promise<boolean> => {
    const owner=requireResearchOwner(caller);
    if(owner.runtime!=="agent") throw new Error("Original native domain owner is required");
    // Original live admissions own their real promises across bridge replacement.
    if(sharedRuntime.submissionsByAttempt.get(attemptKey(caller.workspaceId,attemptId))?.size) return false;
    const ctx=await recordContext(caller.workspaceId);
    if(await getAttemptRecord(ctx,caller.workspaceId,attemptId)) return false;
    if(!deps.sourceAuthority) throw new HarnessServiceError("unavailable","Original source owner is unavailable");
    return deps.sourceAuthority.reconcileUnaccepted(caller);
  };

  const nativeReceipt = async (workspaceId: string, attemptId: string) => {
    const ctx = await recordContext(workspaceId);
    const record = await getAttemptRecord(ctx, workspaceId, attemptId);
    if (!record) return null;
    const caller = recordCaller(workspaceId, record);
    if (caller.owner.runtime !== "agent") return null;
    const attempt = attemptView(record);
    if (!attempt) throw new HarnessServiceError("unavailable", "Native experiment receipt is unreadable");
    const payload = payloadOf(record);
    const job = await ctx.scoped.getRecord(workspaceId, recordIdFor.job(jobIdFor(attemptId)));
    const stopped = originalOutputDrained(record, attempt, job);
    void reconcileAttempt(ctx, workspaceId, caller, record).catch(report);
    const owner = requireResearchOwner(caller);
    if (owner.runtime !== "agent") return null;
    const accepted = payload.acceptance as import("@varin/protocol").ExperimentSubmitResult | undefined;
    if (!accepted || accepted.attempt.attemptId !== attemptId) throw new HarnessServiceError("unavailable", "Original experiment acceptance is missing");
    return { caller, owner, attempt: callerView(caller, record, attempt), recordRevision: record.recordRevision, executorStopped: stopped, accepted };
  };


  return {
    submit, list, get, logs, cancel, wait, collect, readArtifactObservation, readLogObservation, readArtifact, readArtifactPage, submissionId, reconcileUnaccepted, nativeReceipt,
    stopForThreads, refreshQueue, ensureReconciled, subscribeAttempts,
    detachObservers,
    dispose: detachObservers,
  };
}

export type ExperimentService = ReturnType<typeof createExperimentService>;
