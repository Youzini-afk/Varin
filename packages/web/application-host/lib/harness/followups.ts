/**
 * Follow-up service (D-307): durable wait intent + trigger + continuation.
 *
 * Authority model:
 * - `followup.definition` / `followup.occurrence` kernel records are the durable
 *   intent. In-memory state is only timers and the attempt subscription — both
 *   rebuild from records on reconcile().
 * - Delivery reuses the Thread/Run lifecycle: an active target gets a passive
 *   inform (lands in the next request); a settled target resumes through
 *   continueRun (requestId = occurrence id — restart/retry cannot duplicate);
 *   a queued target parks via enqueueContinuation.
 * - `pause` pauses the session goal (goal.update paused, statusReason waiting)
 *   so automation stops auditing; cancel/fire resumes it only if we paused it.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  FollowUpCancelParams,
  FollowUpCheckParams,
  FollowUpCheckResult,
  FollowUpDefinitionView,
  FollowUpFireParams,
  FollowUpGetParams,
  FollowUpGetResult,
  FollowUpListParams,
  FollowUpListResult,
  FollowUpLeafSource,
  FollowUpOccurrenceDelivery,
  FollowUpOccurrenceView,
  FollowUpRegisterParams,
  FollowUpRegisterResult,
  FollowUpSource,
  FollowUpStatus,
  FollowUpUpdateParams,
  FollowUpUpdateResult,
  JsonValue,
  ThreadParent,
} from "@varin/protocol";
import { sliceUtf8ByBytes } from "@varin/protocol";
import type { KernelClient, KernelScopedClient } from "../kernel/kernel-client.js";
import type { KernelRecordResult } from "../kernel/protocol.generated.js";
import type { ExperimentArtifactView, ExperimentAttemptView } from "@varin/protocol";
import { HarnessServiceError } from "./service-error.js";

const DEFINITION_PREFIX = "followup.definition:";
const OCCURRENCE_PREFIX = "followup.occurrence:";
const TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "lost"]);
const ACTIVE_STATUSES: ReadonlySet<FollowUpStatus> = new Set(["waiting", "triggered"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DELIVERY_RETRY_DELAY_MS = 1_000;

const SERVICE_CAPABILITIES = ["storage.read", "storage.write", "storage.maintenance"];

export interface FollowUpCaller {
  workspaceId: string;
  executionWorkspaceId: string;
  sessionId: string;
  /** Present when the caller's session is bound to a thread; absent on the root session. */
  threadId?: string;
  runId?: string;
  rootSessionId: string;
  workspaceScope?: readonly string[];
  allowedThreadIds: readonly string[];
}

interface PersistedExperimentCaller {
  workspaceId: string;
  executionWorkspaceId: string;
  sessionId: string;
  threadId?: string;
  runId?: string;
  rootSessionId: string;
  workspaceScope?: string[];
  allowedThreadIds: string[];
}

interface DefinitionPayload {
  id: string;
  workspaceId: string;
  sessionId: string;
  /** Thread target when the caller is thread-bound; absent targets the session itself. */
  threadId?: string;
  parent?: ThreadParent;
  runId?: string;
  instruction: string;
  source: FollowUpSource;
  /** Original research authority used for every attempt read, including restart recovery. */
  experimentCaller: PersistedExperimentCaller;
  pauseRequested: boolean;
  pausedGoal: boolean;
  /** Goal id captured when pause was applied — resume only touches that goal. */
  pausedGoalId?: string;
  waitingSummary: string;
  createdAt: number;
  updatedAt: number;
  lastOccurrence?: { id: string; reason: string; at: number; delivered: boolean };
  /** Hidden leaf definition owned by a composite parent. */
  internalSource?: { parentId: string; key: string };
  composite?: {
    childIds: string[];
    satisfied: Record<string, { eventId: string; reason: string; at: number; facts: Record<string, JsonValue> }>;
  };
  /**
   * Durable per-source observation state: log byte cursor, metric holding
   * flag, fired artifact ids. Rebuilt-conservative on restart — occurrence
   * identities dedupe any overlap replay.
   */
  sourceState?: {
    logOffset?: number;
    holding?: boolean;
    firedArtifactIds?: string[];
    /** Last authoritative stat observed after the workspace watch became ready. */
    fileExists?: boolean;
    fileSize?: number | null;
    fileMtimeMs?: number | null;
    /** Last watch position folded into the file baseline (0 = initial snapshot). */
    fileGeneration?: number;
    fileSequence?: number;
    fileSourceId?: string;
    fileObservationAt?: number;
    fileObservationEventId?: string;
    metricObservedAt?: number;
    /** Last durable Knowledge event consumed for an ordinary shell execution. */
    shellEventId?: number;
    shellOutputOffset?: number;
    shellOutputTail?: string;
    shellMatchOffset?: number;
  };
}

interface OccurrencePayload {
  id: string;
  followUpId: string;
  reason: string;
  facts: Record<string, JsonValue>;
  /** Re-arming source — the definition returns to `waiting` after delivery. */
  rearm?: boolean;
  /** Set after the delivery attempt resolves. */
  delivery?: FollowUpOccurrenceDelivery;
  runId?: string;
  at: number;
}

interface ObservationPayload {
  id: string;
  workspaceId: string;
  sessionId?: string;
  sourceKind: "file" | "metric" | "shell";
  sourceKey: string;
  eventId: string;
  at: number;
  facts: Record<string, JsonValue>;
}

/** Committed `resource.sample` fact observed through the resource service. */
export interface FollowUpResourceSample {
  machineId: string;
  observedAt: number;
  usage: {
    cpuPercent?: number;
    memoryMb?: number;
    gpus?: Array<{ index?: number; utilizationPercent?: number; usedMemoryMb?: number; memoryMb?: number }>;
  };
}

export interface FollowUpShellEvent {
  id: number;
  type: "shell-start" | "shell-output" | "shell-completion";
  sessionId: string;
  workspaceId: string;
  executionId: string;
  at: number;
  state: "running" | "completed" | "failed" | "cancelled";
  command: string;
  cwd: string;
  offset?: number;
  text?: string;
  exitCode?: number | null;
}

/**
 * Typed, authorized external source. Adapters are registered host-side; the
 * wire only carries a provider id — never a URL, script, or model-authored
 * code. `intervalMs` is the adapter's own capability-based query spacing.
 */
export interface FollowUpExternalSource {
  intervalMs: number;
  query(input: {
    workspaceId: string;
    source: Extract<FollowUpSource, { kind: "external" }>;
  }): Promise<{
    matched: boolean;
    /** True when the provider itself cannot be queried (auth gone, dir gone). */
    unavailable?: boolean;
    /** Stable identity of the matched state — dedupes identical observations. */
    eventId?: string;
    /** Override the next query delay (e.g. rate-limit backoff). */
    retryAfterMs?: number;
    facts: Record<string, JsonValue>;
  }>;
}

export interface FollowUpServiceDeps {
  client: KernelClient;
  /** Look up a thread + parent for delivery decisions. */
  getThread(workspaceId: string, threadId: string): Promise<{
    id: string;
    lifecycle: string;
    parent: ThreadParent;
    activeRunId: string | null;
  } | null>;
  /** Passive inform into a live session (lands in the next model request). */
  notifySession(sessionId: string, text: string, messageId: string): Promise<void>;
  /** Session-level idempotent execution request (native receipt dedupes). */
  sessionRequest(sessionId: string, text: string, messageId: string): Promise<void>;
  /** Whether the session is mid-run — an inform lands in the current turn. */
  sessionBusy(sessionId: string): Promise<boolean>;
  /** Single thread.send-compatible message/admission path for Thread targets. */
  sendToThread(input: {
    scopeId: string;
    threadId: string;
    text: string;
    requestId: string;
    from: ThreadParent;
  }): Promise<{ delivery: FollowUpOccurrenceDelivery; runId?: string }>;
  /**
   * Presentation wait marker on the thread. `null` clears only a follow-up
   * attention — never a user/permission wait that arrived meanwhile.
   */
  setFollowUpAttention(workspaceId: string, threadId: string, waitingFor: { kind: "followup"; text: string } | null): Promise<unknown>;
  /** Goal feature channel — pause/resume on explicit waits only. */
  requestForSession(sessionId: string, method: "session.features.get" | "session.features.mutate", params: Record<string, unknown>): Promise<unknown>;
  /** Experiment source subscription (durable attempt facts). */
  subscribeAttempts?(listener: (workspaceId: string, attemptId: string, view: ExperimentAttemptView | null) => void): () => void;
  /** Read the current attempt view for registration-time/check evaluation. */
  getAttempt?(caller: PersistedExperimentCaller, attemptId: string): Promise<ExperimentAttemptView | null>;
  /** Attempt detail incl. collected artifact views (experiment service `get`). */
  getExperiment?(caller: PersistedExperimentCaller, attemptId: string): Promise<{
    attempt: ExperimentAttemptView;
    artifacts: ExperimentArtifactView[];
  } | null>;
  /** Incremental read of an attempt's durable log (experiment service `logs`). */
  readExperimentLog?(caller: PersistedExperimentCaller, params: {
    attemptId: string;
    stream?: "stdout" | "stderr";
    offset?: number;
    maxBytes?: number;
  }): Promise<{ text: string; nextOffset: number; eof: boolean }>;
  /**
   * Workspace watch through the document authority — invalidation events
   * (path, kind, sequence) only; content is re-read via stat, never watched.
   */
  watchWorkspace?(workspaceId: string, listener: (event: {
    sourceId: string;
    kind: string;
    sequence: number;
    generation: number;
    path?: string;
  }) => void): { ready: Promise<boolean>; close(): void } | null;
  /** Stat a workspace-relative path; null → the workspace root is unknown here. */
  statWorkspaceFile?(workspaceId: string, path: string): Promise<{ exists: boolean; size?: number; mtimeMs?: number } | null>;
  /** True while the document authority reports an active writer/capture. */
  workspaceHasActiveWriters?(workspaceId: string): Promise<boolean>;
  /** `resource.sample` commits from the resource service. */
  subscribeResourceSamples?(listener: (sample: FollowUpResourceSample) => void): () => void;
  /** Latest committed usage sample for a machine. */
  getResourceSample?(machineId: string): Promise<FollowUpResourceSample | null>;
  /** Registered external-source adapters by provider id ("github-pr"). */
  externalSource?(provider: string): FollowUpExternalSource | null;
  /** Durable Knowledge events produced by the shell owner before notification. */
  getShellEvents?(workspaceId: string, sessionId: string, executionId: string, afterId?: number): Promise<FollowUpShellEvent[]>;
  subscribeShellEvents?(listener: (event: FollowUpShellEvent) => void | Promise<void>): () => void;
  /** Current-runtime projection; null means a started process cannot be reattached. */
  getShellExecutionStatus?(sessionId: string, executionId: string): Promise<{ running: boolean; exitCode?: number } | null>;
  /**
   * Read output already owned by the live shell supervisor. This closes the
   * registration gap without copying the command log into the follow-up store.
   */
  readShellExecutionOutput?(sessionId: string, executionId: string, offset: number, length: number): Promise<{
    text: string;
    offset: number;
    length: number;
    nextOffset: number;
    total: number;
    eof: boolean;
    running: boolean;
    exitCode?: number;
  } | null>;
  onChange?(workspaceId: string): void;
  now?(): number;
  onError?(error: Error): void;
}

const payloadOf = (record: KernelRecordResult): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(record.payloadJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const definitionIdFor = (id: string) => `${DEFINITION_PREFIX}${id}`;
const occurrenceIdFor = (id: string) => `${OCCURRENCE_PREFIX}${id}`;
const observationIdFor = (sourceKey: string, eventId: string) => (
  createHash("sha256").update(`${sourceKey}\0${eventId}`).digest("hex")
);

interface FireGuard {
  /** Record revision observed when the callback was armed — optional: source identity is the authoritative guard for in-band drains. */
  recordRevision?: number;
  sourceIdentity: string;
}

interface FileWatchSignal {
  sourceId: string;
  kind: string;
  sequence: number;
  generation: number;
  path?: string;
  observationAt?: number;
  observationEventId?: string;
  /** The signal crossed a triggered/delivery window and is being coalesced. */
  buffered?: true;
}

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
};

const sourceIdentityFor = (source: FollowUpSource, reason: string): string => {
  if (source.kind === "experiment" && reason === "experiment-terminal") {
    return stableJson({ kind: source.kind, attemptId: source.attemptId, states: source.states ?? null });
  }
  if (reason !== "deadline" && "fallbackAt" in source) {
    // fallbackAt is a backstop timer facet, not the observed condition — a
    // consumed deadline must not change the source identity and block the
    // real event.
    const { fallbackAt: _ignored, ...rest } = source as Record<string, unknown> & { fallbackAt?: number };
    return stableJson(rest);
  }
  return stableJson(source);
};

const assertOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string) => {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new HarnessServiceError("invalid-params", `${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
};

const optionalEpoch = (value: Record<string, unknown>, key: string, label: string): number | undefined => {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
    throw new HarnessServiceError("invalid-params", `${label} ${key} must be a finite epoch time`);
  }
  return value[key] as number;
};

const optionalBoolean = (value: Record<string, unknown>, key: string, label: string): boolean | undefined => {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "boolean") {
    throw new HarnessServiceError("invalid-params", `${label} ${key} must be a boolean`);
  }
  return value[key] as boolean;
};

const optionalNonEmptyString = (value: Record<string, unknown>, key: string, label: string): string | undefined => {
  if (value[key] === undefined) return undefined;
  if (typeof value[key] !== "string" || value[key].trim().length === 0) {
    throw new HarnessServiceError("invalid-params", `${label} ${key} must be a non-empty string`);
  }
  return (value[key] as string).trim();
};

/** Workspace-relative watch paths: forward slashes, no escapes. */
const normalizeWatchPath = (raw: string): string => {
  const path = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  const segments = path.split("/");
  if (path.length === 0 || path.includes("\0") || /^[a-zA-Z]:/.test(path)
    || segments.some((segment) => segment === ".." || segment.length === 0)) {
    throw new HarnessServiceError("invalid-params", `file source path "${raw}" is not a workspace-relative path`);
  }
  return path;
};

const METRIC_KEY = /^(cpuPercent|memoryMb|gpu:\d+\.(?:percent|memoryMb))$/;

const isCompositeSource = (source: FollowUpSource): source is Extract<FollowUpSource, { kind: "any" | "all" }> => (
  source.kind === "any" || source.kind === "all"
);

const isRepeatableLeaf = (source: FollowUpLeafSource): boolean => (
  source.kind === "file" && source.condition === "changed"
  || source.kind === "artifact" && source.every === true
  || source.kind === "log" && source.every === true
  || source.kind === "metric" && source.every === true
  || source.kind === "shell" && source.condition === "output" && source.every === true
);

/** Validate and normalize the untrusted wire value at the service boundary. */
const validateSource = (value: unknown): FollowUpSource => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new HarnessServiceError(
      "invalid-params",
      "source.kind is required (time | experiment | artifact | file | log | metric | external | shell | manual | any | all)",
    );
  }
  if (value.kind === "any" || value.kind === "all") {
    assertOnlyKeys(value, new Set(["kind", "sources", "every", "fallbackAt"]), `${value.kind} source`);
    if (!Array.isArray(value.sources) || value.sources.length === 0) {
      throw new HarnessServiceError("invalid-params", `${value.kind} source requires at least one source`);
    }
    const sources = value.sources.map((candidate) => validateSource(candidate));
    if (sources.some(isCompositeSource)) {
      throw new HarnessServiceError("invalid-params", "nested follow-up combinations are not supported; put ordinary sources directly in any/all");
    }
    if (value.every === true) {
      const repeatable = (sources as FollowUpLeafSource[]).filter(isRepeatableLeaf).length;
      if ((value.kind === "all" && repeatable !== sources.length)
        || (value.kind === "any" && repeatable === 0)) {
        throw new HarnessServiceError(
          "invalid-params",
          `${value.kind} source with every=true requires ${value.kind === "all" ? "every" : "at least one"} child to emit repeatable edges`,
        );
      }
    }
    return {
      kind: value.kind,
      sources: sources as FollowUpLeafSource[],
      ...(optionalBoolean(value, "every", `${value.kind} source`) !== undefined ? { every: value.every as boolean } : {}),
      ...(optionalEpoch(value, "fallbackAt", `${value.kind} source`) !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "time") {
    assertOnlyKeys(value, new Set(["kind", "at", "timezone"]), "time source");
    if (typeof value.at !== "number" || !Number.isFinite(value.at)) {
      throw new HarnessServiceError("invalid-params", "time source requires a finite `at` (epoch ms)");
    }
    if (value.timezone !== undefined) {
      if (typeof value.timezone !== "string" || value.timezone.trim().length === 0) {
        throw new HarnessServiceError("invalid-params", "time source timezone must be a non-empty IANA name");
      }
      try {
        new Intl.DateTimeFormat("en", { timeZone: value.timezone }).format(0);
      } catch {
        throw new HarnessServiceError("invalid-params", `invalid IANA timezone "${value.timezone}"`);
      }
    }
    return {
      kind: "time",
      at: value.at,
      ...(value.timezone !== undefined ? { timezone: value.timezone.trim() } : {}),
    };
  }
  if (value.kind === "experiment") {
    assertOnlyKeys(value, new Set(["kind", "attemptId", "states", "fallbackAt"]), "experiment source");
    if (typeof value.attemptId !== "string" || value.attemptId.trim().length === 0) {
      throw new HarnessServiceError("invalid-params", "experiment source requires a non-empty attemptId");
    }
    if (value.states !== undefined
      && (!Array.isArray(value.states)
        || value.states.some((state) => typeof state !== "string" || state.trim().length === 0))) {
      throw new HarnessServiceError("invalid-params", "experiment source states must be an array of non-empty strings");
    }
    if (value.fallbackAt !== undefined
      && (typeof value.fallbackAt !== "number" || !Number.isFinite(value.fallbackAt))) {
      throw new HarnessServiceError("invalid-params", "experiment source fallbackAt must be a finite epoch time");
    }
    return {
      kind: "experiment",
      attemptId: value.attemptId.trim(),
      ...(value.states !== undefined ? { states: value.states.map((state) => state.trim()) } : {}),
      ...(value.fallbackAt !== undefined ? { fallbackAt: value.fallbackAt } : {}),
    };
  }
  if (value.kind === "artifact") {
    assertOnlyKeys(value, new Set(["kind", "attemptId", "artifactId", "name", "every", "fallbackAt"]), "artifact source");
    const attemptId = optionalNonEmptyString(value, "attemptId", "artifact source");
    if (!attemptId) throw new HarnessServiceError("invalid-params", "artifact source requires a non-empty attemptId");
    const artifactId = optionalNonEmptyString(value, "artifactId", "artifact source");
    const name = optionalNonEmptyString(value, "name", "artifact source");
    if (artifactId !== undefined && name !== undefined) {
      throw new HarnessServiceError("invalid-params", "artifact source binds by artifactId OR name, not both");
    }
    return {
      kind: "artifact",
      attemptId,
      ...(artifactId !== undefined ? { artifactId } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(optionalBoolean(value, "every", "artifact source") !== undefined ? { every: value.every as boolean } : {}),
      ...(optionalEpoch(value, "fallbackAt", "artifact source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "file") {
    assertOnlyKeys(value, new Set(["kind", "path", "condition", "fallbackAt"]), "file source");
    const rawPath = optionalNonEmptyString(value, "path", "file source");
    if (!rawPath) throw new HarnessServiceError("invalid-params", "file source requires a non-empty workspace-relative path");
    if (value.condition !== "exists" && value.condition !== "changed" && value.condition !== "ready") {
      throw new HarnessServiceError("invalid-params", "file source condition must be exists | changed | ready");
    }
    return {
      kind: "file",
      path: normalizeWatchPath(rawPath),
      condition: value.condition,
      ...(optionalEpoch(value, "fallbackAt", "file source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "log") {
    assertOnlyKeys(value, new Set(["kind", "attemptId", "stream", "pattern", "regex", "every", "fallbackAt"]), "log source");
    const attemptId = optionalNonEmptyString(value, "attemptId", "log source");
    if (!attemptId) throw new HarnessServiceError("invalid-params", "log source requires a non-empty attemptId");
    const pattern = optionalNonEmptyString(value, "pattern", "log source");
    if (!pattern) throw new HarnessServiceError("invalid-params", "log source requires a non-empty pattern");
    if (value.stream !== undefined && value.stream !== "stdout" && value.stream !== "stderr") {
      throw new HarnessServiceError("invalid-params", "log source stream must be stdout | stderr");
    }
    const regex = optionalBoolean(value, "regex", "log source");
    if (regex === true) {
      try {
        new RegExp(pattern);
      } catch {
        throw new HarnessServiceError("invalid-params", "log source pattern is not a valid regular expression");
      }
    }
    return {
      kind: "log",
      attemptId,
      ...(value.stream !== undefined ? { stream: value.stream as "stdout" | "stderr" } : {}),
      pattern,
      ...(regex !== undefined ? { regex } : {}),
      ...(optionalBoolean(value, "every", "log source") !== undefined ? { every: value.every as boolean } : {}),
      ...(optionalEpoch(value, "fallbackAt", "log source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "metric") {
    assertOnlyKeys(value, new Set(["kind", "machineId", "metric", "predicate", "threshold", "every", "fallbackAt"]), "metric source");
    const machineId = optionalNonEmptyString(value, "machineId", "metric source");
    if (!machineId) throw new HarnessServiceError("invalid-params", "metric source requires a non-empty machineId");
    if (typeof value.metric !== "string" || !METRIC_KEY.test(value.metric)) {
      throw new HarnessServiceError("invalid-params", "metric source metric must be cpuPercent | memoryMb | gpu:<index>.percent | gpu:<index>.memoryMb");
    }
    if (value.predicate !== "above" && value.predicate !== "below") {
      throw new HarnessServiceError("invalid-params", "metric source predicate must be above | below");
    }
    if (typeof value.threshold !== "number" || !Number.isFinite(value.threshold)) {
      throw new HarnessServiceError("invalid-params", "metric source threshold must be a finite number");
    }
    return {
      kind: "metric",
      machineId,
      metric: value.metric,
      predicate: value.predicate,
      threshold: value.threshold,
      ...(optionalBoolean(value, "every", "metric source") !== undefined ? { every: value.every as boolean } : {}),
      ...(optionalEpoch(value, "fallbackAt", "metric source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "external") {
    assertOnlyKeys(value, new Set(["kind", "provider", "branch", "remote", "condition", "fallbackAt"]), "external source");
    if (value.provider !== "github-pr") {
      throw new HarnessServiceError("invalid-params", `external source provider "${String(value.provider)}" is not a registered adapter`);
    }
    if (value.condition !== "exists" && value.condition !== "open" && value.condition !== "merged" && value.condition !== "closed") {
      throw new HarnessServiceError("invalid-params", "external source condition must be exists | open | merged | closed");
    }
    return {
      kind: "external",
      provider: "github-pr",
      ...(optionalNonEmptyString(value, "branch", "external source") !== undefined ? { branch: (value.branch as string).trim() } : {}),
      ...(optionalNonEmptyString(value, "remote", "external source") !== undefined ? { remote: (value.remote as string).trim() } : {}),
      condition: value.condition,
      ...(optionalEpoch(value, "fallbackAt", "external source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "shell") {
    assertOnlyKeys(value, new Set(["kind", "executionId", "condition", "pattern", "regex", "states", "every", "fallbackAt"]), "shell source");
    const executionId = optionalNonEmptyString(value, "executionId", "shell source");
    if (!executionId) throw new HarnessServiceError("invalid-params", "shell source requires the executionId returned by bash/powershell");
    if (value.condition !== "exit" && value.condition !== "output" && value.condition !== "status") {
      throw new HarnessServiceError("invalid-params", "shell source condition must be exit | output | status");
    }
    const pattern = optionalNonEmptyString(value, "pattern", "shell source");
    if (value.condition === "output" && !pattern) {
      throw new HarnessServiceError("invalid-params", "shell output source requires a non-empty pattern");
    }
    if (value.condition !== "output" && pattern !== undefined) {
      throw new HarnessServiceError("invalid-params", "shell pattern is only valid with condition=output");
    }
    const regex = optionalBoolean(value, "regex", "shell source");
    if (regex === true && pattern) {
      try { new RegExp(pattern); } catch {
        throw new HarnessServiceError("invalid-params", "shell source pattern is not a valid regular expression");
      }
    }
    const allowedStates = new Set(["running", "completed", "failed", "cancelled", "unavailable"]);
    if (value.states !== undefined && (!Array.isArray(value.states)
      || value.states.length === 0 || value.states.some((state) => typeof state !== "string" || !allowedStates.has(state)))) {
      throw new HarnessServiceError("invalid-params", "shell source states contain an unsupported status");
    }
    if (value.condition === "status" && value.states === undefined) {
      throw new HarnessServiceError("invalid-params", "shell status source requires states");
    }
    const states = value.states as Array<"running" | "completed" | "failed" | "cancelled" | "unavailable"> | undefined;
    return {
      kind: "shell",
      executionId,
      condition: value.condition,
      ...(pattern !== undefined ? { pattern } : {}),
      ...(regex !== undefined ? { regex } : {}),
      ...(states !== undefined ? { states: [...states] } : {}),
      ...(optionalBoolean(value, "every", "shell source") !== undefined ? { every: value.every as boolean } : {}),
      ...(optionalEpoch(value, "fallbackAt", "shell source") !== undefined ? { fallbackAt: value.fallbackAt as number } : {}),
    };
  }
  if (value.kind === "manual") {
    assertOnlyKeys(value, new Set(["kind", "note"]), "manual source");
    if (value.note !== undefined && typeof value.note !== "string") {
      throw new HarnessServiceError("invalid-params", "manual source note must be a string");
    }
    return { kind: "manual", ...(value.note !== undefined ? { note: value.note } : {}) };
  }
  throw new HarnessServiceError("invalid-params", `unknown source kind "${value.kind}"`);
};

const assertSourceWithinCallerScope = (caller: FollowUpCaller, source: FollowUpSource): void => {
  if (isCompositeSource(source)) {
    for (const child of source.sources) assertSourceWithinCallerScope(caller, child);
    return;
  }
  if (source.kind !== "file" || !caller.workspaceScope?.length) return;
  const allowed = caller.workspaceScope.some((scope) => (
    scope === "" || source.path === scope || source.path.startsWith(`${scope}/`)
  ));
  if (!allowed) {
    throw new HarnessServiceError("forbidden", `File source is outside the actor scope: ${source.path}`);
  }
};

const summarizeSource = (source: FollowUpSource): string => {
  switch (source.kind) {
    case "time":
      return `at ${new Date(source.at).toISOString()}${source.timezone ? ` (${source.timezone})` : ""}`;
    case "experiment":
      return `experiment attempt ${source.attemptId} to reach ${(source.states ?? [...TERMINAL_ATTEMPT_STATES]).join("/")}`
        + (source.fallbackAt ? `; fallback check at ${new Date(source.fallbackAt).toISOString()}` : "");
    case "artifact":
      return `experiment attempt ${source.attemptId} artifact ${source.artifactId ?? source.name ?? "collection"}`
        + (source.every === true ? " (each)" : "");
    case "file":
      return `workspace file ${source.path} ${source.condition}`;
    case "log":
      return `experiment attempt ${source.attemptId} ${source.stream ?? "stdout"} matching ${source.regex === true ? `/${source.pattern}/` : JSON.stringify(source.pattern)}`
        + (source.every === true ? " (each)" : "");
    case "metric":
      return `${source.metric} on machine ${source.machineId} ${source.predicate} ${source.threshold}`
        + (source.every === true ? " (each crossing)" : "");
    case "external":
      return `GitHub PR ${source.condition}${source.branch ? ` on ${source.branch}` : ""}`;
    case "shell":
      return source.condition === "output"
        ? `shell ${source.executionId} output matching ${source.regex === true ? `/${source.pattern}/` : JSON.stringify(source.pattern)}`
        : source.condition === "status"
          ? `shell ${source.executionId} status ${(source.states ?? []).join("/")}`
          : `shell ${source.executionId} to exit`;
    case "manual":
      return source.note ?? "explicit trigger only";
    case "any":
    case "all":
      return `${source.kind} of ${source.sources.map(summarizeSource).join("; ")}${source.every === true ? " (repeatable edges)" : ""}`;
  }
};

export function createFollowUpService(deps: FollowUpServiceDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const reportError = (error: unknown) => {
    try {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Observer failures must not break the service.
    }
  };

  /** Serializes per-definition mutations (CAS chains) within this host. */
  const operations = new Map<string, Promise<unknown>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** External polling timers are independent from fallback/deadline timers. */
  const externalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const deliveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const externalGroups = new Map<string, {
    workspaceId: string;
    source: Extract<FollowUpSource, { kind: "external" }>;
    followUpIds: Set<string>;
    running?: Promise<void>;
  }>();
  /** attemptId -> Set<followUpId> for experiment/artifact/log waits. */
  const attemptWaits = new Map<string, Set<string>>();
  let unsubscribeAttempts: (() => void) | undefined;
  /** workspaceId -> normalized path -> Set<followUpId> for file waits. */
  const fileWaits = new Map<string, Map<string, Set<string>>>();
  /** workspaceId -> live document-authority watch shared by file waits. */
  const workspaceWatches = new Map<string, { close(): void; ready: Promise<boolean>; refs: number }>();
  /** followUpId -> pending "ready" settle probe (candidate stat). */
  const readySettles = new Map<string, { timer: ReturnType<typeof setTimeout>; size: number | undefined; mtimeMs: number | undefined }>();
  /** machineId -> followUpId -> workspaceId for metric waits. */
  const metricWaits = new Map<string, Map<string, string>>();
  let unsubscribeSamples: (() => void) | undefined;
  /** executionId -> followUpId -> durable owner identity. */
  const shellWaits = new Map<string, Map<string, { workspaceId: string; sessionId: string }>>();
  let unsubscribeShellEvents: (() => void) | undefined;
  const shellStreamState = new Map<string, { offset: number; tail: string }>();
  const reprimeQueued = new Set<string>();
  /** followUpId -> consumed log byte offset (persisted on sourceState). */
  const logOffsets = new Map<string, number>();
  const recordScopeByWorkspace = new Map<string, Promise<{ scoped: KernelScopedClient }>>();

  const recordScope = (workspaceId: string) => {
    let pending = recordScopeByWorkspace.get(workspaceId);
    if (!pending) {
      pending = (async () => {
        const grant = await deps.client.issueGrant({
          grantId: `followup:${randomUUID()}`,
          capabilities: [...SERVICE_CAPABILITIES],
          owningWorkspace: workspaceId,
          executionWorkspace: workspaceId,
          pathScopes: [""],
        });
        return { scoped: deps.client.scoped(grant) };
      })();
      pending.catch(() => recordScopeByWorkspace.delete(workspaceId));
      recordScopeByWorkspace.set(workspaceId, pending);
    }
    return pending;
  };

  const withDefinition = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const prior = operations.get(id) ?? Promise.resolve();
    const next = prior.then(task, task);
    operations.set(id, next.catch(() => {}));
    const cleanup = () => {
      if (operations.get(id) === next) operations.delete(id);
    };
    void next.then(cleanup, cleanup);
    return next;
  };

  const getDefinitionRecord = async (workspaceId: string, id: string): Promise<KernelRecordResult | null> => {
    const { scoped } = await recordScope(workspaceId);
    return scoped.getRecord(workspaceId, definitionIdFor(id)).catch(() => null);
  };

  const putDefinition = async (
    workspaceId: string,
    payload: DefinitionPayload,
    state: FollowUpStatus,
    expectedRecordRevision?: number,
  ): Promise<KernelRecordResult> => {
    const { scoped } = await recordScope(workspaceId);
    return scoped.putRecord({
      operationId: `followup.definition:${randomUUID()}`,
      recordId: definitionIdFor(payload.id),
      recordType: "followup.definition",
      workspaceId,
      state,
      sessionId: payload.sessionId,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      ...(payload.runId ? { runId: payload.runId } : {}),
      ...(expectedRecordRevision !== undefined ? { expectedRecordRevision } : {}),
      payloadJson: JSON.stringify(payload),
      ownerIds: [],
      references: [],
    });
  };

  const putOccurrence = async (
    workspaceId: string,
    payload: OccurrencePayload,
    state: "recorded" | "delivering" | "delivered" | "held" | "dropped",
    expectedRecordRevision?: number,
  ): Promise<KernelRecordResult> => {
    const { scoped } = await recordScope(workspaceId);
    return scoped.putRecord({
      operationId: `followup.occurrence:${randomUUID()}`,
      recordId: occurrenceIdFor(payload.id),
      recordType: "followup.occurrence",
      workspaceId,
      state,
      payloadJson: JSON.stringify(payload),
      ownerIds: [],
      references: [],
      ...(expectedRecordRevision !== undefined ? { expectedRecordRevision } : {}),
    });
  };

  const putObservation = async (
    workspaceId: string,
    sourceKind: ObservationPayload["sourceKind"],
    sourceKey: string,
    eventId: string,
    facts: Record<string, JsonValue>,
    sessionId?: string,
  ): Promise<KernelRecordResult> => {
    const { scoped } = await recordScope(workspaceId);
    const payload: ObservationPayload = {
      id: observationIdFor(sourceKey, eventId),
      workspaceId,
      ...(sessionId ? { sessionId } : {}),
      sourceKind,
      sourceKey,
      eventId,
      at: now(),
      facts,
    };
    try {
      return await scoped.putRecord({
        operationId: `followup.observation:${randomUUID()}`,
        recordId: `followup.observation:${payload.id}`,
        recordType: "followup.observation",
        workspaceId,
        state: "available",
        ...(sessionId ? { sessionId } : {}),
        payloadJson: JSON.stringify(payload),
        ownerIds: [],
        references: [],
      });
    } catch (error) {
      const existing = await scoped.getRecord(workspaceId, `followup.observation:${payload.id}`).catch(() => null);
      if (existing) return existing;
      throw error;
    }
  };

  const listObservations = async (workspaceId: string, sourceKey: string): Promise<ObservationPayload[]> => {
    const { scoped } = await recordScope(workspaceId);
    const observations: ObservationPayload[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId,
        recordType: "followup.observation",
        pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        const payload = payloadOf(record) as unknown as ObservationPayload;
        if (payload.sourceKey === sourceKey) observations.push(payload);
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return observations.sort((left, right) => left.at - right.at || left.eventId.localeCompare(right.eventId));
  };

  const releaseObservation = async (workspaceId: string, observation: ObservationPayload): Promise<void> => {
    const { scoped } = await recordScope(workspaceId);
    await scoped.releaseRecord(
      `followup.observation.release:${randomUUID()}`,
      workspaceId,
      `followup.observation:${observation.id}`,
    );
  };

  const releaseObservationsForSource = async (workspaceId: string, sourceKey: string): Promise<void> => {
    for (const observation of await listObservations(workspaceId, sourceKey)) {
      await releaseObservation(workspaceId, observation);
    }
  };

  const toView = (record: KernelRecordResult): FollowUpDefinitionView => {
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    return {
      id: payload.id,
      workspaceId: payload.workspaceId,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      sessionId: payload.sessionId,
      instruction: payload.instruction,
      source: payload.source,
      status: record.state as FollowUpStatus,
      revision: String(record.recordRevision),
      ...(payload.runId ? { runId: payload.runId } : {}),
      pausedGoal: payload.pausedGoal === true,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      ...(payload.lastOccurrence ? { lastOccurrence: payload.lastOccurrence } : {}),
      waitingSummary: payload.waitingSummary,
    };
  };

  const occurrenceView = (record: KernelRecordResult): FollowUpOccurrenceView => {
    const payload = payloadOf(record) as unknown as OccurrencePayload;
    return {
      id: payload.id,
      followUpId: payload.followUpId,
      reason: payload.reason,
      facts: payload.facts,
      delivery: payload.delivery ?? "dropped",
      ...(payload.runId ? { runId: payload.runId } : {}),
      at: payload.at,
    };
  };

  const clearTimer = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };

  const clearExternalTimer = (id: string) => {
    const timer = externalTimers.get(id);
    if (timer) clearTimeout(timer);
    externalTimers.delete(id);
  };

  /** Node clamps larger delays; chain chunks until the authoritative due time. */
  const scheduleAt = (id: string, dueAt: number, callback: () => Promise<unknown>) => {
    const scheduleNext = () => {
      const delay = Math.max(0, Math.min(dueAt - now(), MAX_TIMER_DELAY_MS));
      const timer = setTimeout(() => {
        if (timers.get(id) !== timer) return;
        timers.delete(id);
        if (dueAt > now()) {
          scheduleNext();
          return;
        }
        void callback().catch(reportError);
      }, delay);
      timers.set(id, timer);
    };
    scheduleNext();
  };

  const scheduleExternalAt = (id: string, dueAt: number, callback: () => Promise<unknown>) => {
    // External poll timers are keyed by compatible workspace/query groups.
    const scheduleNext = () => {
      const delay = Math.max(0, Math.min(dueAt - now(), MAX_TIMER_DELAY_MS));
      const timer = setTimeout(() => {
        if (externalTimers.get(id) !== timer) return;
        externalTimers.delete(id);
        if (dueAt > now()) {
          scheduleNext();
          return;
        }
        void callback().catch(reportError);
      }, delay);
      externalTimers.set(id, timer);
    };
    scheduleNext();
  };

  const unwatchAttempt = (attemptId: string, followUpId: string) => {
    const set = attemptWaits.get(attemptId);
    if (!set) return;
    set.delete(followUpId);
    if (set.size === 0) attemptWaits.delete(attemptId);
    if (attemptWaits.size === 0) {
      unsubscribeAttempts?.();
      unsubscribeAttempts = undefined;
    }
  };

  const watchAttempt = (attemptId: string, followUpId: string) => {
    let set = attemptWaits.get(attemptId);
    if (!set) {
      set = new Set();
      attemptWaits.set(attemptId, set);
    }
    set.add(followUpId);
    if (!unsubscribeAttempts && deps.subscribeAttempts) {
      unsubscribeAttempts = deps.subscribeAttempts(onAttemptEvent);
    }
  };

  const watchMetric = (machineId: string, followUpId: string, workspaceId: string) => {
    let set = metricWaits.get(machineId);
    if (!set) {
      set = new Map();
      metricWaits.set(machineId, set);
    }
    set.set(followUpId, workspaceId);
    if (!unsubscribeSamples && deps.subscribeResourceSamples) {
      unsubscribeSamples = deps.subscribeResourceSamples(onResourceSample);
    }
  };

  const unwatchMetric = (machineId: string, followUpId: string) => {
    const set = metricWaits.get(machineId);
    if (set) {
      set.delete(followUpId);
      if (set.size === 0) metricWaits.delete(machineId);
    }
    if (metricWaits.size === 0) {
      unsubscribeSamples?.();
      unsubscribeSamples = undefined;
    }
  };

  const watchShell = (executionId: string, followUpId: string, workspaceId: string, sessionId: string) => {
    let set = shellWaits.get(executionId);
    if (!set) {
      set = new Map();
      shellWaits.set(executionId, set);
    }
    set.set(followUpId, { workspaceId, sessionId });
    if (!unsubscribeShellEvents && deps.subscribeShellEvents) {
      unsubscribeShellEvents = deps.subscribeShellEvents(onShellEvent);
    }
  };

  const unwatchShell = (executionId: string, followUpId: string) => {
    const set = shellWaits.get(executionId);
    if (set) {
      set.delete(followUpId);
      if (set.size === 0) shellWaits.delete(executionId);
    }
    if (shellWaits.size === 0) {
      unsubscribeShellEvents?.();
      unsubscribeShellEvents = undefined;
    }
  };

  const ensureWorkspaceWatch = (workspaceId: string): Promise<boolean> | null => {
    const existing = workspaceWatches.get(workspaceId);
    if (existing) {
      existing.refs += 1;
      return existing.ready;
    }
    const handle = deps.watchWorkspace?.(workspaceId, (event) => onWatchEvent(workspaceId, event));
    if (!handle) return null;
    const ready = handle.ready.catch((error) => {
      reportError(error);
      return false;
    });
    workspaceWatches.set(workspaceId, { close: () => handle.close(), ready, refs: 1 });
    return ready;
  };

  const releaseWorkspaceWatch = (workspaceId: string) => {
    const entry = workspaceWatches.get(workspaceId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      workspaceWatches.delete(workspaceId);
      entry.close();
    }
  };

  const clearReadySettle = (followUpId: string) => {
    const pending = readySettles.get(followUpId);
    if (pending) clearTimeout(pending.timer);
    readySettles.delete(followUpId);
  };

  /** Arm in-memory observers for a waiting definition (idempotent). */
  const arm = async (record: KernelRecordResult): Promise<boolean> => {
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const id = payload.id;
    const source = payload.source;
    clearTimer(id);
    if (source.kind === "time") {
      const dueAt = source.at;
      scheduleAt(id, dueAt, () => fire(
        payload.workspaceId,
        id,
        "time-due",
        { dueAt },
        `time-${dueAt}`,
        { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(source, "time-due") },
      ));
      return true;
    }
    if (source.kind === "experiment" || source.kind === "artifact" || source.kind === "log") {
      watchAttempt(source.attemptId, id);
    }
    if (source.kind === "file") {
      let paths = fileWaits.get(payload.workspaceId);
      if (!paths) {
        paths = new Map();
        fileWaits.set(payload.workspaceId, paths);
      }
      let set = paths.get(source.path);
      if (!set) {
        set = new Set();
        paths.set(source.path, set);
      }
      const first = set.size === 0;
      set.add(id);
      const ready = first
        ? ensureWorkspaceWatch(payload.workspaceId)
        : workspaceWatches.get(payload.workspaceId)?.ready ?? null;
      if (!ready || !await ready) {
        await markUnavailable(payload.workspaceId, id);
        return false;
      }
    }
    if (source.kind === "metric") {
      watchMetric(source.machineId, id, payload.workspaceId);
    }
    if (source.kind === "shell") {
      watchShell(source.executionId, id, payload.workspaceId, payload.sessionId);
    }
    if (source.kind === "external") watchExternal(payload.workspaceId, id, source);
    const fallbackAt = "fallbackAt" in source ? source.fallbackAt : undefined;
    if (typeof fallbackAt === "number") {
      scheduleAt(id, fallbackAt, () => fire(
        payload.workspaceId,
        id,
        "deadline",
        { fallbackAt, stillWaiting: true },
        `deadline-${fallbackAt}`,
        { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(source, "deadline") },
      ));
    }
    return true;
  };

  const disarm = (payload: DefinitionPayload) => {
    clearTimer(payload.id);
    const source = payload.source;
    if (source.kind === "experiment" || source.kind === "artifact" || source.kind === "log") {
      unwatchAttempt(source.attemptId, payload.id);
    }
    if (source.kind === "file") {
      clearReadySettle(payload.id);
      const paths = fileWaits.get(payload.workspaceId);
      const set = paths?.get(source.path);
      if (set) {
        set.delete(payload.id);
        if (set.size === 0) {
          paths?.delete(source.path);
          releaseWorkspaceWatch(payload.workspaceId);
          void releaseObservationsForSource(
            payload.workspaceId,
            fileSourceKey(payload.workspaceId, source.path),
          ).catch(reportError);
        }
      }
      if (paths && paths.size === 0) fileWaits.delete(payload.workspaceId);
    }
    if (source.kind === "metric") {
      unwatchMetric(source.machineId, payload.id);
      if (!metricWaits.has(source.machineId)) {
        void releaseObservationsForSource(payload.workspaceId, metricSourceKey(source.machineId)).catch(reportError);
      }
    }
    if (source.kind === "shell") {
      unwatchShell(source.executionId, payload.id);
      void releaseObservationsForSource(
        payload.workspaceId,
        shellSourceKey(payload.sessionId, source.executionId, payload.id),
      ).catch(reportError);
    }
    if (source.kind === "external") unwatchExternal(payload.workspaceId, payload.id, source);
    shellStreamState.delete(payload.id);

    if (source.kind === "log") logOffsets.delete(payload.id);
    reprimeQueued.delete(payload.id);
  };

  const changed = (workspaceId: string) => {
    try {
      deps.onChange?.(workspaceId);
    } catch {
      // SSE fan-out must not break the service.
    }
  };

  // ---------- source observers (W-A) ----------

  /**
   * Quiet window for a file "ready" claim: the path must exist, the document
   * authority must report no active writer/capture, and a re-stat after the
   * window must observe identical size+mtime. This is atomic-publish
   * evidence — a bare "file appeared" event never qualifies.
   */
  const FILE_READY_SETTLE_MS = 750;

  /** Merge into durable per-source state while the source is unchanged. */
  const updateSourceState = async (
    workspaceId: string,
    followUpId: string,
    patch: NonNullable<DefinitionPayload["sourceState"]>,
    sourceJson: string,
  ): Promise<void> => {
    await withDefinition(followUpId, async () => {
      const record = await getDefinitionRecord(workspaceId, followUpId);
      if (!record || record.state !== "waiting") return;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      if (JSON.stringify(payload.source) !== sourceJson) return;
      await putDefinition(workspaceId, {
        ...payload,
        updatedAt: now(),
        sourceState: { ...(payload.sourceState ?? {}), ...patch },
      }, "waiting", record.recordRevision);
    });
  };

  const artifactMatches = (
    source: Extract<FollowUpSource, { kind: "artifact" }>,
    artifact: ExperimentArtifactView,
  ): boolean => {
    if (source.artifactId !== undefined) return artifact.artifactId === source.artifactId;
    if (source.name !== undefined) return artifact.name === source.name || artifact.path === source.name;
    return true;
  };

  const artifactFacts = (artifact: ExperimentArtifactView): Record<string, JsonValue> => ({
    artifactId: artifact.artifactId,
    attemptId: artifact.attemptId,
    name: artifact.name,
    kind: artifact.kind,
    state: artifact.state,
    ...(artifact.byteLength !== undefined ? { byteLength: artifact.byteLength } : {}),
    ...(artifact.path !== undefined ? { path: artifact.path } : {}),
    ...(artifact.remote ? { remoteAccessible: artifact.remote.accessible } : {}),
    ...(artifact.collectedAt !== undefined ? { collectedAt: artifact.collectedAt } : {}),
    ...(artifact.error !== undefined ? { error: artifact.error } : {}),
  });

  /**
   * Evaluate an artifact wait against the authoritative attempt detail.
   * Distinguishes collected-ready, per-artifact failure, missing bound
   * artifact, and collection failure; re-reads happen under the definition
   * caller so nothing observes with maintenance authority.
   */
  const evaluateArtifactWait = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "artifact") return;
    if (!deps.getExperiment) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    let detail: { attempt: ExperimentAttemptView; artifacts: ExperimentArtifactView[] } | null;
    try {
      detail = await deps.getExperiment(payload.experimentCaller, source.attemptId);
    } catch (error) {
      if (error instanceof HarnessServiceError && error.harnessCode === "not-found") detail = null;
      else {
        reportError(error);
        return;
      }
    }
    if (detail === null) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    const { attempt, artifacts } = detail;
    const guard = (): FireGuard => ({
      sourceIdentity: sourceIdentityFor(source, "artifact-ready"),
    });
    const bound = source.artifactId !== undefined || source.name !== undefined;
    const relevant = artifacts.filter((artifact) => artifactMatches(source, artifact));
    const ready = relevant.filter((artifact) => artifact.state === "available");
    const failed = relevant.filter((artifact) => artifact.state === "failed" || artifact.state === "expired");
    const collectionDone = attempt.collection === "done" || TERMINAL_ATTEMPT_STATES.has(attempt.state);

    if (source.every === true) {
      const firedIds = new Set(payload.sourceState?.firedArtifactIds ?? []);
      for (const artifact of ready) {
        if (firedIds.has(artifact.artifactId)) continue;
        firedIds.add(artifact.artifactId);
        const fired = await fire(workspaceId, followUpId, "artifact-ready", {
          ...artifactFacts(artifact), via,
        }, `artifact-${artifact.artifactId}-available`, guard(), {
          rearm: true,
          sourceStatePatch: { firedArtifactIds: [...firedIds] },
        });
        if (!fired) return;
      }
      if (collectionDone || attempt.collection === "failed") {
        // The set is final — close the per-artifact wait with an end fact.
        await fire(workspaceId, followUpId, "artifact-collection-finished", {
          attemptId: source.attemptId,
          attemptState: attempt.state,
          collection: attempt.collection,
          artifactCount: ready.length,
          via,
        }, `artifact-collection-${source.attemptId}-${attempt.collection}-${attempt.state}`, guard());
      }
      return;
    }

    const failedArtifact = failed.find((artifact) => artifactMatches(source, artifact));
    if (failedArtifact) {
      await fire(workspaceId, followUpId, "artifact-failed", {
        ...artifactFacts(failedArtifact), via,
      }, `artifact-${failedArtifact.artifactId}-${failedArtifact.state}`, guard());
      return;
    }
    if (bound) {
      const readyBound = ready[0];
      if (readyBound) {
        await fire(workspaceId, followUpId, "artifact-ready", {
          ...artifactFacts(readyBound), via,
        }, `artifact-${readyBound.artifactId}-available`, guard());
        return;
      }
      if (collectionDone || attempt.collection === "failed") {
        await fire(workspaceId, followUpId, "artifact-missing", {
          attemptId: source.attemptId,
          attemptState: attempt.state,
          collection: attempt.collection,
          boundBy: source.artifactId !== undefined ? "artifactId" : "name",
          boundTo: source.artifactId ?? source.name ?? "",
          via,
        }, `artifact-missing-${source.attemptId}-${attempt.state}-${attempt.collection}`, guard());
      }
      return;
    }
    // Unbound one-shot: the collected set is the condition.
    if (attempt.collection === "failed") {
      await fire(workspaceId, followUpId, "artifact-failed", {
        attemptId: source.attemptId, attemptState: attempt.state, collection: attempt.collection, via,
      }, `artifact-collection-${source.attemptId}-failed`, guard());
      return;
    }
    if (attempt.collection === "done") {
      await fire(workspaceId, followUpId, "artifact-ready", {
        attemptId: source.attemptId,
        collection: attempt.collection,
        artifacts: ready.map((artifact) => artifactFacts(artifact)),
        via,
      }, `artifact-collection-${source.attemptId}-done`, guard());
      return;
    }
    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      await fire(workspaceId, followUpId, "artifact-missing", {
        attemptId: source.attemptId,
        attemptState: attempt.state,
        collection: attempt.collection,
        via,
      }, `artifact-missing-${source.attemptId}-${attempt.state}-${attempt.collection}`, guard());
    }
  };

  const LOG_CHUNK_BYTES = 256 * 1024;

  /**
   * Drain new durable log bytes for a log wait. Literal patterns retain a
   * pattern-width tail in both memory and durable state, so a pattern can
   * straddle pages or a later append. Regex patterns use the same bounded
   * source-width overlap; expressions requiring unbounded context cannot be
   * streamed reliably from a byte cursor.
   */
  const drainLog = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "log") return;
    if (!deps.readExperimentLog) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    const sourceJson = JSON.stringify(source);
    const patternBytes = Buffer.byteLength(source.pattern);
    let offset = Math.max(0, logOffsets.get(followUpId) ?? payload.sourceState?.logOffset ?? 0);
    const regex = source.regex === true ? new RegExp(source.pattern, "g") : null;
    let tail = "";
    let tailByteLength = 0;
    let eof = false;
    for (;;) {
      // A long drain can overlap an update/cancel. Check both before and after
      // each read so a stale observer stops without waiting for another event.
      const beforePage = await getDefinitionRecord(workspaceId, followUpId);
      if (!beforePage || beforePage.state !== "waiting") return;
      const beforePagePayload = payloadOf(beforePage) as unknown as DefinitionPayload;
      if (JSON.stringify(beforePagePayload.source) !== sourceJson || beforePagePayload.source.kind !== "log") return;

      let page: { text: string; offset?: number; nextOffset: number; eof: boolean };
      try {
        page = await deps.readExperimentLog(payload.experimentCaller, {
          attemptId: source.attemptId,
          ...(source.stream !== undefined ? { stream: source.stream } : {}),
          offset,
          maxBytes: LOG_CHUNK_BYTES,
        });
      } catch (error) {
        if (error instanceof HarnessServiceError && error.harnessCode === "not-found") {
          await markUnavailable(workspaceId, followUpId);
          return;
        }
        reportError(error);
        return;
      }

      const afterPage = await getDefinitionRecord(workspaceId, followUpId);
      if (!afterPage || afterPage.state !== "waiting") return;
      const afterPagePayload = payloadOf(afterPage) as unknown as DefinitionPayload;
      if (JSON.stringify(afterPagePayload.source) !== sourceJson || afterPagePayload.source.kind !== "log") return;

      const pageOffset = (page as { offset?: number }).offset ?? offset;
      const scanText = tail + page.text;
      const scanBase = pageOffset - tailByteLength;
      const matches: Array<{ at: number; end: number; text: string }> = [];
      if (regex) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(scanText)) !== null) {
          const at = scanBase + Buffer.byteLength(scanText.slice(0, match.index));
          const end = at + Buffer.byteLength(match[0]);
          if (at >= offset || end > offset) {
            matches.push({ at, end, text: match[0].slice(0, 160) });
            if (source.every !== true) break;
          }
          if (match[0].length === 0) regex.lastIndex += 1;
        }
      } else {
        let from = 0;
        for (;;) {
          const index = scanText.indexOf(source.pattern, from);
          if (index < 0) break;
          const at = scanBase + Buffer.byteLength(scanText.slice(0, index));
          from = index + Math.max(1, source.pattern.length);
          const end = at + patternBytes;
          if (at < offset && end <= offset) continue;
          matches.push({ at, end, text: source.pattern.slice(0, 160) });
          if (source.every !== true) break;
        }
      }
      for (const match of matches) {
        const current = await getDefinitionRecord(workspaceId, followUpId);
        if (!current || current.state !== "waiting") return;
        const currentPayload = payloadOf(current) as unknown as DefinitionPayload;
        if (JSON.stringify(currentPayload.source) !== sourceJson) return;
        const fired = await fire(workspaceId, followUpId, "log-match", {
          attemptId: source.attemptId,
          stream: source.stream ?? "stdout",
          offset: match.at,
          match: match.text,
          via,
        }, `log-${match.at}`, {
          recordRevision: current.recordRevision,
          sourceIdentity: sourceIdentityFor(currentPayload.source, "log-match"),
        }, {
          rearm: source.every === true,
          sourceStatePatch: { logOffset: Math.max(0, match.end - Math.max(0, patternBytes - 1)) },
        });
        if (!fired) return;
        if (source.every !== true) {
          return;
        }
      }
      const carry = Math.max(0, patternBytes - 1);
      if (scanText.length > carry) {
        tail = scanText.slice(-carry);
        tailByteLength = Buffer.byteLength(tail);
      } else {
        tail = scanText;
        tailByteLength = Buffer.byteLength(scanText);
      }
      if (page.eof) {
        eof = true;
        if (page.nextOffset > offset) offset = page.nextOffset;
        break;
      }
      if (page.nextOffset <= offset) break; // reader made no progress
      offset = page.nextOffset;
    }
    // Keep the in-memory and durable cursors identical: both trail by the
    // overlap so a later append can complete a pattern started in old bytes.
    const cursor = Math.max(0, offset - Math.max(0, patternBytes - 1));
    logOffsets.set(followUpId, cursor);
    await updateSourceState(workspaceId, followUpId, {
      logOffset: cursor,
    }, sourceJson).catch(reportError);
    if (eof) {
      const current = await getDefinitionRecord(workspaceId, followUpId);
      if (!current || current.state !== "waiting") return;
      const currentPayload = payloadOf(current) as unknown as DefinitionPayload;
      if (JSON.stringify(currentPayload.source) !== sourceJson) return;
      await fire(workspaceId, followUpId, "log-exhausted", {
        attemptId: source.attemptId,
        stream: source.stream ?? "stdout",
        pattern: source.pattern.slice(0, 160),
        consumedBytes: offset,
        via,
      }, `log-exhausted-${source.attemptId}-${source.stream ?? "stdout"}`, {
        recordRevision: current.recordRevision,
        sourceIdentity: sourceIdentityFor(currentPayload.source, "log-exhausted"),
      });
    }
  };

  const fileObservationPatch = (
    state: DefinitionPayload["sourceState"],
    stat: { exists: boolean; size?: number; mtimeMs?: number },
    signal?: FileWatchSignal,
  ): NonNullable<DefinitionPayload["sourceState"]> => {
    const sourceId = signal?.sourceId ?? state?.fileSourceId;
    const observationAt = signal?.observationAt ?? state?.fileObservationAt;
    const observationEventId = signal?.observationEventId ?? state?.fileObservationEventId;
    return {
      fileExists: stat.exists,
      fileSize: stat.exists ? stat.size ?? null : null,
      fileMtimeMs: stat.exists ? stat.mtimeMs ?? null : null,
      fileGeneration: signal?.generation ?? state?.fileGeneration ?? 0,
      fileSequence: signal?.sequence ?? state?.fileSequence ?? 0,
      ...(sourceId === undefined ? {} : { fileSourceId: sourceId }),
      ...(observationAt === undefined ? {} : { fileObservationAt: observationAt }),
      ...(observationEventId === undefined ? {} : { fileObservationEventId: observationEventId }),
    };
  };

  const fileSourceKey = (workspaceId: string, path: string): string => `file:${workspaceId}:${path}`;

  const fileObservationConsumed = async (
    workspaceId: string,
    path: string,
    observation: ObservationPayload,
  ): Promise<boolean> => {
    const ids = fileWaits.get(workspaceId)?.get(path);
    if (!ids || ids.size === 0) return true;
    for (const id of ids) {
      const record = await getDefinitionRecord(workspaceId, id);
      if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) continue;
      if (record.state === "triggered") return false;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      const at = payload.sourceState?.fileObservationAt ?? -1;
      const eventId = payload.sourceState?.fileObservationEventId ?? "";
      if (at < observation.at || (at === observation.at && eventId < observation.eventId)) return false;
    }
    return true;
  };

  const drainFileObservations = async (workspaceId: string, followUpId: string): Promise<boolean> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return false;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (payload.source.kind !== "file") return false;
    let observationAt = payload.sourceState?.fileObservationAt ?? -1;
    let observationEventId = payload.sourceState?.fileObservationEventId ?? "";
    const observations = await listObservations(workspaceId, fileSourceKey(workspaceId, payload.source.path));
    for (const observation of observations) {
      if (observation.sourceKind !== "file" || observation.at < payload.createdAt) continue;
      if (observation.at < observationAt
        || (observation.at === observationAt && observation.eventId <= observationEventId)) continue;
      const nextGeneration = typeof observation.facts.generation === "number" ? observation.facts.generation : 0;
      const nextSequence = typeof observation.facts.sequence === "number" ? observation.facts.sequence : 0;
      const sourceId = typeof observation.facts.sourceId === "string" ? observation.facts.sourceId : "legacy";
      await evaluateFileWait(workspaceId, followUpId, "durable-event", {
        sourceId,
        kind: typeof observation.facts.event === "string" ? observation.facts.event : "changed",
        generation: nextGeneration,
        sequence: nextSequence,
        path: payload.source.path,
        observationAt: observation.at,
        observationEventId: observation.eventId,
        buffered: true,
      });
      observationAt = observation.at;
      observationEventId = observation.eventId;
      if (await fileObservationConsumed(workspaceId, payload.source.path, observation)) {
        await releaseObservation(workspaceId, observation);
      }
      const current = await getDefinitionRecord(workspaceId, followUpId);
      if (!current || current.state !== "waiting") return true;
    }
    return false;
  };

  const fileStatChanged = (
    state: NonNullable<DefinitionPayload["sourceState"]>,
    stat: { exists: boolean; size?: number; mtimeMs?: number },
  ): boolean => state.fileExists !== stat.exists
    || (stat.exists && (state.fileSize !== (stat.size ?? null) || state.fileMtimeMs !== (stat.mtimeMs ?? null)));

  /**
   * File wait evaluation. Watch events are invalidations; the stat snapshot is
   * the durable baseline. A signal buffered during delivery remains evidence of
   * one coalesced change even when a short-lived edit returned to the baseline.
   */
  const evaluateFileWait = async (
    workspaceId: string,
    followUpId: string,
    via: string,
    signal?: FileWatchSignal,
  ): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "file") return;
    if (!deps.statWorkspaceFile) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    let stat: { exists: boolean; size?: number; mtimeMs?: number } | null | undefined;
    try {
      stat = await deps.statWorkspaceFile(workspaceId, source.path);
    } catch (error) {
      reportError(error);
      return;
    }
    if (stat === undefined) return; // transient — the watch still covers the edge
    if (stat === null) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    const sourceJson = JSON.stringify(source);
    const baselineKnown = payload.sourceState?.fileExists !== undefined;
    const observation = fileObservationPatch(payload.sourceState, stat, signal);
    if (source.condition === "changed") {
      const changedFromBaseline = baselineKnown && fileStatChanged(payload.sourceState!, stat);
      const observedChange = signal !== undefined && signal.kind !== "reset";
      if ((!baselineKnown && !observedChange) || (baselineKnown && !changedFromBaseline && !observedChange)) {
        await updateSourceState(workspaceId, followUpId, observation, sourceJson).catch(reportError);
        return;
      }
      await fire(workspaceId, followUpId, "file-changed", {
        path: source.path,
        exists: stat.exists,
        event: signal?.kind ?? "snapshot-difference",
        generation: observation.fileGeneration ?? 0,
        sequence: observation.fileSequence ?? 0,
        ...(stat.size !== undefined ? { size: stat.size } : {}),
        ...(stat.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
        via,
      }, `file-${observation.fileGeneration ?? 0}-${observation.fileSequence ?? 0}-${stat.mtimeMs ?? 0}-${stat.size ?? 0}`, {
        recordRevision: record.recordRevision,
        sourceIdentity: sourceIdentityFor(source, "file-changed"),
      }, { rearm: true, sourceStatePatch: observation });
      return;
    }
    if (!stat.exists) {
      clearReadySettle(followUpId);
      await updateSourceState(workspaceId, followUpId, observation, sourceJson).catch(reportError);
      return;
    }
    if (source.condition === "exists") {
      await fire(workspaceId, followUpId, "file-exists", {
        path: source.path,
        ...(stat.size !== undefined ? { size: stat.size } : {}),
        ...(stat.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
        via,
      }, `file-exists-${source.path}-${stat.mtimeMs ?? 0}-${stat.size ?? 0}`, {
        recordRevision: record.recordRevision,
        sourceIdentity: sourceIdentityFor(source, "file-exists"),
      }, { sourceStatePatch: observation });
      return;
    }
    if (source.condition !== "ready") return;
    await updateSourceState(workspaceId, followUpId, observation, sourceJson).catch(reportError);
    const writers = deps.workspaceHasActiveWriters
      ? await deps.workspaceHasActiveWriters(workspaceId).catch(() => true)
      : false;
    if (writers) {
      clearReadySettle(followUpId);
      return;
    }
    const pending = readySettles.get(followUpId);
    if (pending && pending.size === stat.size && pending.mtimeMs === stat.mtimeMs) return;
    clearReadySettle(followUpId);
    const timer = setTimeout(() => {
      readySettles.delete(followUpId);
      void confirmFileReady(workspaceId, followUpId, { size: stat.size, mtimeMs: stat.mtimeMs }).catch(reportError);
    }, FILE_READY_SETTLE_MS);
    readySettles.set(followUpId, { timer, size: stat.size, mtimeMs: stat.mtimeMs });
  };

  const confirmFileReady = async (
    workspaceId: string,
    followUpId: string,
    candidate: { size: number | undefined; mtimeMs: number | undefined },
  ): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "file" || source.condition !== "ready" || !deps.statWorkspaceFile) return;
    let stat: { exists: boolean; size?: number; mtimeMs?: number } | null;
    try {
      stat = await deps.statWorkspaceFile(workspaceId, source.path);
    } catch (error) {
      reportError(error);
      return;
    }
    if (!stat?.exists) return;
    const writers = deps.workspaceHasActiveWriters
      ? await deps.workspaceHasActiveWriters(workspaceId).catch(() => true)
      : false;
    if (writers || stat.size !== candidate.size || stat.mtimeMs !== candidate.mtimeMs) {
      // Still mutating — re-arm the settle probe on the new observed state.
      if (!writers && stat.exists) {
        const timer = setTimeout(() => {
          readySettles.delete(followUpId);
          void confirmFileReady(workspaceId, followUpId, { size: stat!.size, mtimeMs: stat!.mtimeMs }).catch(reportError);
        }, FILE_READY_SETTLE_MS);
        readySettles.set(followUpId, { timer, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      return;
    }
    await fire(workspaceId, followUpId, "file-ready", {
      path: source.path,
      ...(stat.size !== undefined ? { size: stat.size } : {}),
      ...(stat.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
      stableForMs: FILE_READY_SETTLE_MS,
    }, `file-ready-${source.path}-${stat.mtimeMs ?? 0}-${stat.size ?? 0}`, {
      recordRevision: record.recordRevision,
      sourceIdentity: sourceIdentityFor(source, "file-ready"),
    });
  };

  const handleFileSignal = async (
    workspaceId: string,
    followUpId: string,
    event: FileWatchSignal,
  ): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "file" || (event.path !== undefined && source.path !== event.path)) return;
    if (record.state === "triggered") {
      // The owner callback persisted this invalidation before fan-out. Delivery
      // reprime consumes it from the durable per-definition cursor.
      return;
    }
    await evaluateFileWait(workspaceId, followUpId, event.kind === "reset" ? "watch-reset" : "event", event);
  };

  const onWatchEvent = (workspaceId: string, event: FileWatchSignal) => {
    const paths = fileWaits.get(workspaceId);
    if (!paths) return;
    const targets = event.path === undefined
      ? [...paths.entries()]
      : [[event.path, paths.get(event.path) ?? new Set<string>()] as const];
    for (const [path, ids] of targets) {
      void (async () => {
        const eventId = `${event.sourceId}:${event.generation}:${event.sequence}:${event.kind}`;
        const observation = await putObservation(workspaceId, "file", fileSourceKey(workspaceId, path),
          eventId, {
            sourceId: event.sourceId,
            generation: event.generation,
            sequence: event.sequence,
            event: event.kind,
            path,
          });
        const observationPayload = payloadOf(observation) as unknown as ObservationPayload;
        for (const followUpId of [...ids]) {
          await handleFileSignal(workspaceId, followUpId, {
            ...event,
            path,
            observationAt: observationPayload.at,
            observationEventId: eventId,
          });
        }
        if (await fileObservationConsumed(workspaceId, path, observationPayload)) {
          await releaseObservation(workspaceId, observationPayload);
        }
      })().catch(reportError);
    }
  };

  const metricValue = (sample: FollowUpResourceSample, key: string): number | undefined => {
    if (key === "cpuPercent") return sample.usage.cpuPercent;
    if (key === "memoryMb") return sample.usage.memoryMb;
    const gpu = /^gpu:(\d+)\.(percent|memoryMb)$/.exec(key);
    if (gpu) {
      const entry = sample.usage.gpus?.find((device) => device.index === Number(gpu[1]))
        ?? sample.usage.gpus?.[Number(gpu[1])];
      return gpu[2] === "percent" ? entry?.utilizationPercent : entry?.usedMemoryMb;
    }
    return undefined;
  };

  const metricSourceKey = (machineId: string): string => `metric:${machineId}`;

  const metricObservationConsumed = async (
    workspaceId: string,
    machineId: string,
    observation: ObservationPayload,
  ): Promise<boolean> => {
    const observedAt = typeof observation.facts.observedAt === "number" ? observation.facts.observedAt : -1;
    const ids = metricWaits.get(machineId);
    if (!ids) return true;
    for (const [id, ownerWorkspaceId] of ids) {
      if (ownerWorkspaceId !== workspaceId) continue;
      const record = await getDefinitionRecord(workspaceId, id);
      if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) continue;
      if (record.state === "triggered") return false;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      if ((payload.sourceState?.metricObservedAt ?? -1) < observedAt) return false;
    }
    return true;
  };

  const drainMetricObservations = async (workspaceId: string, followUpId: string): Promise<boolean> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return false;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (payload.source.kind !== "metric") return false;
    const cursor = payload.sourceState?.metricObservedAt ?? -1;
    const observations = await listObservations(workspaceId, metricSourceKey(payload.source.machineId));
    let processed = false;
    for (const observation of observations) {
      const observedAt = typeof observation.facts.observedAt === "number" ? observation.facts.observedAt : -1;
      if (observation.sourceKind !== "metric" || observation.at < payload.createdAt || observedAt <= cursor) continue;
      const usage = observation.facts.usage;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
      await evaluateMetricSample(workspaceId, followUpId, {
        machineId: payload.source.machineId,
        observedAt,
        usage: usage as FollowUpResourceSample["usage"],
      }, "durable-event");
      processed = true;
      if (await metricObservationConsumed(workspaceId, payload.source.machineId, observation)) {
        await releaseObservation(workspaceId, observation);
      }
      const current = await getDefinitionRecord(workspaceId, followUpId);
      if (!current || current.state !== "waiting") return true;
    }
    return processed;
  };

  /**
   * Metric waits fire on the crossing edge only. The persisted `holding`
   * flag survives restarts, so a steady-true stream cannot re-wake the
   * target and a restart cannot replay a consumed crossing.
   */
  const evaluateMetricSample = async (
    workspaceId: string,
    followUpId: string,
    sample: FollowUpResourceSample,
    via: string,
  ): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "metric" || source.machineId !== sample.machineId) return;
    const value = metricValue(sample, source.metric);
    if (value === undefined) {
      await updateSourceState(
        workspaceId,
        followUpId,
        { metricObservedAt: sample.observedAt },
        JSON.stringify(source),
      ).catch(reportError);
      return; // dimension not probed — not evidence either way
    }
    const holds = source.predicate === "above" ? value > source.threshold : value < source.threshold;
    const held = payload.sourceState?.holding === true;
    const sourceJson = JSON.stringify(source);
    if (holds === held) {
      if ((payload.sourceState?.metricObservedAt ?? -1) < sample.observedAt) {
        await updateSourceState(workspaceId, followUpId, { metricObservedAt: sample.observedAt }, sourceJson).catch(reportError);
      }
      return;
    }
    if (!holds) {
      await updateSourceState(workspaceId, followUpId, { holding: false, metricObservedAt: sample.observedAt }, sourceJson).catch(reportError);
      return;
    }
    await fire(workspaceId, followUpId, "metric-crossed", {
      machineId: source.machineId,
      metric: source.metric,
      predicate: source.predicate,
      threshold: source.threshold,
      value,
      observedAt: sample.observedAt,
      via,
    }, `metric-${source.machineId}-${source.metric}-${sample.observedAt}`, {
      recordRevision: record.recordRevision,
      sourceIdentity: sourceIdentityFor(source, "metric-crossed"),
    }, {
      rearm: source.every === true,
      sourceStatePatch: { holding: true, metricObservedAt: sample.observedAt },
    });
  };

  const handleMetricSample = async (
    workspaceId: string,
    followUpId: string,
    sample: FollowUpResourceSample,
  ): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "metric" || source.machineId !== sample.machineId) return;
    if (record.state === "triggered") {
      // The sample was persisted before fan-out. The re-arming definition will
      // replay it after delivery using its durable observedAt cursor.
      return;
    }
    await evaluateMetricSample(workspaceId, followUpId, sample, "sample");
  };

  function onResourceSample(sample: FollowUpResourceSample): void {
    const set = metricWaits.get(sample.machineId);
    if (!set) return;
    const byWorkspace = new Map<string, string[]>();
    for (const [followUpId, workspaceId] of [...set]) {
      const ids = byWorkspace.get(workspaceId) ?? [];
      ids.push(followUpId);
      byWorkspace.set(workspaceId, ids);
    }
    for (const [workspaceId, ids] of byWorkspace) {
      void (async () => {
        const observationRecord = await putObservation(workspaceId, "metric", metricSourceKey(sample.machineId),
          `${sample.observedAt}:${createHash("sha256").update(JSON.stringify(sample.usage)).digest("hex")}`, {
            machineId: sample.machineId,
            observedAt: sample.observedAt,
            usage: sample.usage as unknown as JsonValue,
          });
        for (const followUpId of ids) await handleMetricSample(workspaceId, followUpId, sample);
        const observation = payloadOf(observationRecord) as unknown as ObservationPayload;
        if (await metricObservationConsumed(workspaceId, sample.machineId, observation)) {
          await releaseObservation(workspaceId, observation);
        }
      })().catch(reportError);
    }
  }

  const shellStatusFacts = (event: FollowUpShellEvent): Record<string, JsonValue> => ({
    executionId: event.executionId,
    state: event.state,
    command: event.command,
    cwd: event.cwd,
    eventId: event.id,
    observedAt: event.at,
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
  });

  const shellSourceKey = (sessionId: string, executionId: string, followUpId: string): string => (
    `shell:${sessionId}:${executionId}:${followUpId}`
  );

  const drainShellMatchObservations = async (
    workspaceId: string,
    followUpId: string,
    payload: DefinitionPayload,
    source: Extract<FollowUpSource, { kind: "shell" }>,
    via: string,
  ): Promise<boolean> => {
    const observations = await listObservations(workspaceId, shellSourceKey(payload.sessionId, source.executionId, followUpId));
    let consumed = payload.sourceState?.shellMatchOffset ?? 0;
    for (const observation of observations) {
      if (observation.sourceKind !== "shell" || observation.facts.kind !== "match") continue;
      const end = typeof observation.facts.end === "number" ? observation.facts.end : 0;
      if (end <= consumed) continue;
      const current = await getDefinitionRecord(workspaceId, followUpId);
      if (!current || current.state !== "waiting") return false;
      const currentPayload = payloadOf(current) as unknown as DefinitionPayload;
      if (currentPayload.source.kind !== "shell" || JSON.stringify(currentPayload.source) !== JSON.stringify(source)) return false;
      const fired = await fire(workspaceId, followUpId, "shell-output-match", {
        ...observation.facts,
        observationId: observation.id,
        via,
      }, observation.eventId, {
        recordRevision: current.recordRevision,
        sourceIdentity: sourceIdentityFor(source, "shell-output-match"),
      }, {
        rearm: source.every === true,
        sourceStatePatch: {
          shellMatchOffset: end,
          shellOutputOffset: typeof observation.facts.outputOffset === "number" ? observation.facts.outputOffset : end,
          shellOutputTail: typeof observation.facts.tail === "string" ? observation.facts.tail : "",
        },
      });
      const after = await getDefinitionRecord(workspaceId, followUpId);
      const afterPayload = after ? payloadOf(after) as unknown as DefinitionPayload : null;
      if (!after || !ACTIVE_STATUSES.has(after.state as FollowUpStatus)
        || (afterPayload?.sourceState?.shellMatchOffset ?? 0) >= end) {
        await releaseObservation(workspaceId, observation);
      }
      if (!fired) return false;
      consumed = end;
      if (source.every !== true) return true;
    }
    return consumed > (payload.sourceState?.shellMatchOffset ?? 0);
  };

  const observeShellOutputEvent = async (
    workspaceId: string,
    followUpId: string,
    event: FollowUpShellEvent,
  ): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "shell" || source.condition !== "output" || source.executionId !== event.executionId || !event.text) return;
    const persisted = shellStreamState.get(followUpId) ?? {
      offset: payload.sourceState?.shellOutputOffset ?? 0,
      tail: payload.sourceState?.shellOutputTail ?? "",
    };
    let chunk = event.text;
    let chunkOffset = event.offset ?? persisted.offset;
    const patternBytes = Buffer.byteLength(source.pattern ?? "", "utf8");
    if (event.type === "shell-completion" && event.offset === undefined) {
      const start = Math.max(0, persisted.offset - Math.max(0, patternBytes - 1));
      const page = sliceUtf8ByBytes(chunk, start, Math.max(0, Buffer.byteLength(chunk, "utf8") - start));
      chunk = page.text;
      chunkOffset = page.offset;
    }
    const tailBytes = Buffer.byteLength(persisted.tail, "utf8");
    const scan = persisted.tail + chunk;
    const base = Math.max(0, chunkOffset - tailBytes);
    const matches: Array<{ at: number; end: number; text: string }> = [];
    if (source.regex === true) {
      const regex = new RegExp(source.pattern!, "g");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(scan)) !== null) {
        const at = base + Buffer.byteLength(scan.slice(0, match.index), "utf8");
        const end = at + Buffer.byteLength(match[0], "utf8");
        if (end > persisted.offset) matches.push({ at, end, text: match[0].slice(0, 160) });
        if (source.every !== true) break;
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    } else {
      let from = 0;
      for (;;) {
        const index = scan.indexOf(source.pattern!, from);
        if (index < 0) break;
        const at = base + Buffer.byteLength(scan.slice(0, index), "utf8");
        const end = at + patternBytes;
        from = index + Math.max(1, source.pattern!.length);
        if (end > persisted.offset) matches.push({ at, end, text: source.pattern!.slice(0, 160) });
        if (source.every !== true) break;
      }
    }
    const nextOffset = Math.max(persisted.offset, chunkOffset + Buffer.byteLength(chunk, "utf8"));
    const carry = Math.max(0, patternBytes - 1);
    const tailPage = sliceUtf8ByBytes(scan, Math.max(0, Buffer.byteLength(scan, "utf8") - carry), carry);
    const nextTail = tailPage.text;
    shellStreamState.set(followUpId, { offset: nextOffset, tail: nextTail });
    const key = shellSourceKey(payload.sessionId, source.executionId, followUpId);
    for (const match of matches) {
      await putObservation(workspaceId, "shell", key, `match-${match.at}-${match.end}`, {
        kind: "match",
        executionId: source.executionId,
        offset: match.at,
        end: match.end,
        match: match.text,
        outputOffset: nextOffset,
        tail: nextTail,
        observedAt: event.at,
      }, payload.sessionId);
    }
    if (record.state === "waiting") {
      if (matches.length > 0) {
        await drainShellMatchObservations(workspaceId, followUpId, payload, source, "event");
      }
    }
  };

  /**
   * Ordinary shell waits consume the shell owner's durable Knowledge events.
   * The subscription is only a wakeup; registration, checks, and restart all
   * replay from the per-definition event/byte cursor.
   */
  const evaluateShellWait = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    let record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    let payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind !== "shell") return;
    if (!deps.getShellEvents) {
      await markUnavailable(workspaceId, followUpId);
      return;
    }
    if (source.condition === "output"
      && await drainShellMatchObservations(workspaceId, followUpId, payload, source, via)) {
      const afterMatches = await getDefinitionRecord(workspaceId, followUpId);
      if (!afterMatches || afterMatches.state !== "waiting") return;
      record = afterMatches;
      payload = payloadOf(record) as unknown as DefinitionPayload;
    }
    if (source.condition === "output" && deps.readShellExecutionOutput) {
      let readOffset = Math.max(
        payload.sourceState?.shellOutputOffset ?? 0,
        shellStreamState.get(followUpId)?.offset ?? 0,
      );
      for (;;) {
        const page = await deps.readShellExecutionOutput(
          payload.sessionId,
          source.executionId,
          readOffset,
          32 * 1024,
        ).catch(() => null);
        if (!page) break;
        if (page.text) {
          await observeShellOutputEvent(workspaceId, followUpId, {
            id: 0,
            type: "shell-output",
            sessionId: payload.sessionId,
            workspaceId,
            executionId: source.executionId,
            at: now(),
            state: page.running ? "running" : page.exitCode === 0 ? "completed" : "failed",
            command: "",
            cwd: "",
            offset: page.offset,
            text: page.text,
            ...(page.exitCode === undefined ? {} : { exitCode: page.exitCode }),
          });
          const current = await getDefinitionRecord(workspaceId, followUpId);
          if (!current || current.state !== "waiting") return;
          const currentPayload = payloadOf(current) as unknown as DefinitionPayload;
          if (currentPayload.source.kind !== "shell" || JSON.stringify(currentPayload.source) !== JSON.stringify(source)) return;
          record = current;
          payload = payloadOf(record) as unknown as DefinitionPayload;
        }
        if (page.eof || page.nextOffset <= readOffset) break;
        readOffset = page.nextOffset;
      }
      const streamed = shellStreamState.get(followUpId);
      if (streamed && via !== "event") {
        await updateSourceState(workspaceId, followUpId, {
          shellOutputOffset: streamed.offset,
          shellOutputTail: streamed.tail,
        }, JSON.stringify(source));
        record = await getDefinitionRecord(workspaceId, followUpId) ?? record;
        payload = payloadOf(record) as unknown as DefinitionPayload;
      }
    }
    const initialCursor = payload.sourceState?.shellEventId ?? 0;
    const events = (await deps.getShellEvents(workspaceId, payload.sessionId, source.executionId, initialCursor))
      .sort((left, right) => left.id - right.id);
    if (events.length === 0 && initialCursor === 0) {
      const runtime = await deps.getShellExecutionStatus?.(payload.sessionId, source.executionId).catch(() => null);
      if (runtime === null) {
        await markUnavailable(workspaceId, followUpId);
      }
      return;
    }

    let cursor = initialCursor;
    const streamed = shellStreamState.get(followUpId);
    let outputOffset = Math.max(payload.sourceState?.shellOutputOffset ?? 0, streamed?.offset ?? 0);
    let tail = streamed && streamed.offset >= (payload.sourceState?.shellOutputOffset ?? 0)
      ? streamed.tail
      : payload.sourceState?.shellOutputTail ?? "";
    const sourceJson = JSON.stringify(source);
    for (const event of events) {
      cursor = Math.max(cursor, event.id);
      if (source.condition === "exit" && event.type === "shell-completion") {
        await fire(workspaceId, followUpId, "shell-exit", { ...shellStatusFacts(event), via }, `shell-${source.executionId}-exit-${event.id}`, {
          recordRevision: record.recordRevision,
          sourceIdentity: sourceIdentityFor(source, "shell-exit"),
        }, { sourceStatePatch: { shellEventId: cursor, shellOutputOffset: outputOffset, shellOutputTail: tail } });
        return;
      }
      if (source.condition === "status" && (source.states ?? []).includes(event.state)) {
        await fire(workspaceId, followUpId, "shell-status", { ...shellStatusFacts(event), via }, `shell-${source.executionId}-status-${event.state}-${event.id}`, {
          recordRevision: record.recordRevision,
          sourceIdentity: sourceIdentityFor(source, "shell-status"),
        }, { sourceStatePatch: { shellEventId: cursor, shellOutputOffset: outputOffset, shellOutputTail: tail } });
        return;
      }
      if (source.condition !== "output") continue;
      let chunk = event.text ?? "";
      let chunkOffset = event.offset ?? outputOffset;
      if (event.type === "shell-completion" && event.offset === undefined && chunk) {
        const overlap = Math.max(0, Buffer.byteLength(source.pattern ?? "", "utf8") - 1);
        const start = Math.max(0, outputOffset - overlap);
        const page = sliceUtf8ByBytes(chunk, start, Math.max(0, Buffer.byteLength(chunk, "utf8") - start));
        chunk = page.text;
        chunkOffset = page.offset;
      }
      if (chunk) {
        const tailBytes = Buffer.byteLength(tail, "utf8");
        const scan = tail + chunk;
        const base = Math.max(0, chunkOffset - tailBytes);
        const regex = source.regex === true ? new RegExp(source.pattern!, "g") : null;
        const matches: Array<{ at: number; end: number; text: string }> = [];
        if (regex) {
          let match: RegExpExecArray | null;
          while ((match = regex.exec(scan)) !== null) {
            const at = base + Buffer.byteLength(scan.slice(0, match.index), "utf8");
            const end = at + Buffer.byteLength(match[0], "utf8");
            if (end > outputOffset) matches.push({ at, end, text: match[0].slice(0, 160) });
            if (source.every !== true) break;
            if (match[0].length === 0) regex.lastIndex += 1;
          }
        } else {
          let from = 0;
          for (;;) {
            const index = scan.indexOf(source.pattern!, from);
            if (index < 0) break;
            const at = base + Buffer.byteLength(scan.slice(0, index), "utf8");
            const end = at + Buffer.byteLength(source.pattern!, "utf8");
            from = index + Math.max(1, source.pattern!.length);
            if (end > outputOffset) matches.push({ at, end, text: source.pattern!.slice(0, 160) });
            if (source.every !== true) break;
          }
        }
        outputOffset = Math.max(outputOffset, chunkOffset + Buffer.byteLength(chunk, "utf8"));
        const carry = Math.max(0, Buffer.byteLength(source.pattern!, "utf8") - 1);
        const tailPage = sliceUtf8ByBytes(scan, Math.max(0, Buffer.byteLength(scan, "utf8") - carry), carry);
        tail = tailPage.text;
        for (const match of matches) {
          record = await getDefinitionRecord(workspaceId, followUpId) ?? record;
          payload = payloadOf(record) as unknown as DefinitionPayload;
          if (record.state !== "waiting" || JSON.stringify(payload.source) !== sourceJson) return;
          const fired = await fire(workspaceId, followUpId, "shell-output-match", {
            executionId: source.executionId,
            offset: match.at,
            match: match.text,
            eventId: event.id,
            via,
          }, `shell-${source.executionId}-output-${match.at}`, {
            recordRevision: record.recordRevision,
            sourceIdentity: sourceIdentityFor(source, "shell-output-match"),
          }, {
            rearm: source.every === true,
            sourceStatePatch: { shellEventId: cursor, shellOutputOffset: Math.max(outputOffset, match.end), shellOutputTail: tail },
          });
          if (!fired || source.every !== true) return;
        }
      }
      if (event.type === "shell-completion") {
        await fire(workspaceId, followUpId, "shell-output-exhausted", {
          ...shellStatusFacts(event), pattern: source.pattern ?? "", via,
        }, `shell-${source.executionId}-output-exhausted-${event.id}`, {
          sourceIdentity: sourceIdentityFor(source, "shell-output-exhausted"),
        }, { sourceStatePatch: { shellEventId: cursor, shellOutputOffset: outputOffset, shellOutputTail: tail } });
        return;
      }
    }
    if (cursor !== initialCursor || via !== "event") {
      await updateSourceState(workspaceId, followUpId, {
        shellEventId: cursor,
        shellOutputOffset: outputOffset,
        shellOutputTail: tail,
      }, sourceJson).catch(reportError);
    }
    const latest = events.at(-1);
    if (latest && latest.type !== "shell-completion" && deps.getShellExecutionStatus) {
      const runtime = await deps.getShellExecutionStatus(payload.sessionId, source.executionId).catch(() => null);
      if (runtime === null) {
        if (source.condition === "status" && (source.states ?? []).includes("unavailable")) {
          const current = await getDefinitionRecord(workspaceId, followUpId);
          if (current?.state === "waiting") {
            await fire(workspaceId, followUpId, "shell-status", {
              executionId: source.executionId,
              state: "unavailable",
              recoveredAfterRestart: via === "reconcile",
              via,
            }, `shell-${source.executionId}-status-unavailable`, {
              recordRevision: current.recordRevision,
              sourceIdentity: sourceIdentityFor(source, "shell-status"),
            }, { sourceStatePatch: { shellEventId: cursor, shellOutputOffset: outputOffset, shellOutputTail: tail } });
          }
        } else {
          await markUnavailable(workspaceId, followUpId);
        }
      }
    }
  };

  async function onShellEvent(event: FollowUpShellEvent): Promise<void> {
    const set = shellWaits.get(event.executionId);
    if (!set) return;
    const deliveries: Promise<void>[] = [];
    for (const [followUpId, owner] of [...set]) {
      if (owner.workspaceId !== event.workspaceId || owner.sessionId !== event.sessionId) continue;
      deliveries.push((async () => {
        // The live supervisor is the output owner. Its byte slice excludes the
        // command-framing sentinels and closes registration races; the transient
        // event is only a wakeup. Completion preview remains the fallback once
        // the execution is no longer attached to a supervisor.
        if (event.type === "shell-completion" && event.text) {
          await observeShellOutputEvent(owner.workspaceId, followUpId, event);
        } else if (event.type === "shell-output" && event.text && !deps.readShellExecutionOutput) {
          await observeShellOutputEvent(owner.workspaceId, followUpId, event);
        }
        await evaluateShellWait(owner.workspaceId, followUpId, "event");
      })());
    }
    await Promise.all(deliveries);
  }

  const externalGroupKey = (workspaceId: string, source: Extract<FollowUpSource, { kind: "external" }>) => (
    `${workspaceId}\0${sourceIdentityFor(source, "external-match")}`
  );

  const scheduleExternalGroup = (key: string, delayMs?: number): void => {
    const group = externalGroups.get(key);
    if (!group || group.followUpIds.size === 0) return;
    const adapter = deps.externalSource?.(group.source.provider);
    if (!adapter) {
      for (const id of [...group.followUpIds]) void markUnavailable(group.workspaceId, id).catch(reportError);
      return;
    }
    const delay = Math.max(0, delayMs ?? adapter.intervalMs);
    scheduleExternalAt(key, now() + delay, () => runExternalGroup(key, "poll"));
  };

  const watchExternal = (workspaceId: string, followUpId: string, source: Extract<FollowUpSource, { kind: "external" }>): void => {
    const key = externalGroupKey(workspaceId, source);
    let group = externalGroups.get(key);
    if (!group) {
      group = { workspaceId, source, followUpIds: new Set() };
      externalGroups.set(key, group);
    }
    group.followUpIds.add(followUpId);
    if (!externalTimers.has(key) && !group.running) scheduleExternalGroup(key);
  };

  const unwatchExternal = (workspaceId: string, followUpId: string, source: Extract<FollowUpSource, { kind: "external" }>): void => {
    const key = externalGroupKey(workspaceId, source);
    const group = externalGroups.get(key);
    if (!group) return;
    group.followUpIds.delete(followUpId);
    if (group.followUpIds.size === 0) {
      clearExternalTimer(key);
      externalGroups.delete(key);
    }
  };

  async function runExternalGroup(key: string, via: string): Promise<void> {
    const group = externalGroups.get(key);
    if (!group || group.followUpIds.size === 0) return;
    if (group.running) return group.running;
    const work = (async () => {
      const adapter = deps.externalSource?.(group.source.provider);
      if (!adapter) {
        for (const id of [...group.followUpIds]) await markUnavailable(group.workspaceId, id);
        return;
      }
      let result: Awaited<ReturnType<FollowUpExternalSource["query"]>>;
      try {
        result = await adapter.query({ workspaceId: group.workspaceId, source: group.source });
      } catch (error) {
        reportError(error);
        scheduleExternalGroup(key);
        return;
      }
      for (const followUpId of [...group.followUpIds]) {
        const record = await getDefinitionRecord(group.workspaceId, followUpId);
        if (!record || record.state !== "waiting") continue;
        const payload = payloadOf(record) as unknown as DefinitionPayload;
        if (payload.source.kind !== "external" || externalGroupKey(group.workspaceId, payload.source) !== key) continue;
        if (result.unavailable === true) {
          await markUnavailable(group.workspaceId, followUpId);
        } else if (result.matched) {
          await fire(group.workspaceId, followUpId, "external-match", {
            provider: payload.source.provider,
            ...result.facts,
            via,
          }, result.eventId ?? `ext-${payload.source.provider}-${JSON.stringify(result.facts)}`, {
            recordRevision: record.recordRevision,
            sourceIdentity: sourceIdentityFor(payload.source, "external-match"),
          });
        }
      }
      if (!result.matched && result.unavailable !== true) scheduleExternalGroup(key, result.retryAfterMs);
    })();
    group.running = work;
    try { await work; } finally {
      const current = externalGroups.get(key);
      if (current?.running === work) delete current.running;
    }
  }

  const runExternalQuery = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (payload.source.kind !== "external") return;
    watchExternal(workspaceId, followUpId, payload.source);
    await runExternalGroup(externalGroupKey(workspaceId, payload.source), via);
  };

  /** Registration/reconcile snapshot: fire if the condition already holds. */
  const primeSource = async (workspaceId: string, followUpId: string, via: string): Promise<void> => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    const source = payload.source;
    if (source.kind === "artifact") {
      await evaluateArtifactWait(workspaceId, followUpId, via);
    } else if (source.kind === "file") {
      if (await drainFileObservations(workspaceId, followUpId)) return;
      await evaluateFileWait(workspaceId, followUpId, via);
    } else if (source.kind === "log") {
      await drainLog(workspaceId, followUpId, via);
    } else if (source.kind === "metric") {
      if (await drainMetricObservations(workspaceId, followUpId)) {
        const current = await getDefinitionRecord(workspaceId, followUpId);
        if (!current || current.state !== "waiting") return;
      }
      if (!deps.getResourceSample) {
        await markUnavailable(workspaceId, followUpId);
        return;
      }
      const sample = await deps.getResourceSample(source.machineId).catch((error) => {
        reportError(error);
        return null;
      });
      if (sample) await evaluateMetricSample(workspaceId, followUpId, sample, via);
    } else if (source.kind === "external") {
      await runExternalQuery(workspaceId, followUpId, via);
    } else if (source.kind === "shell") {
      await evaluateShellWait(workspaceId, followUpId, via);
    }
  };

  /** Once delivery re-arms, replay the source owner's durable cursor/history. */
  const reprimeAfterDelivery = async (workspaceId: string, followUpId: string): Promise<void> => {
    reprimeQueued.delete(followUpId);
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || record.state !== "waiting") return;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (isCompositeSource(payload.source) && payload.composite) {
      for (const childId of payload.composite.childIds) {
        const child = await getDefinitionRecord(workspaceId, childId);
        if (!child || child.state !== "waiting") continue;
        await primeSource(workspaceId, childId, "delivery-reprime");
      }
      return;
    }
    if (payload.source.kind === "artifact" || payload.source.kind === "log"
      || payload.source.kind === "metric" || payload.source.kind === "file" || payload.source.kind === "shell") {
      await primeSource(workspaceId, followUpId, "delivery-reprime");
    }
  };

  const scheduleReprime = (workspaceId: string, followUpId: string) => {
    if (reprimeQueued.has(followUpId)) return;
    reprimeQueued.add(followUpId);
    setTimeout(() => {
      void reprimeAfterDelivery(workspaceId, followUpId).catch(reportError);
    }, 0);
  };

  const goalPause = async (sessionId: string): Promise<string | undefined> => {
    try {
      const features = await deps.requestForSession(sessionId, "session.features.get", {}) as {
        goal?: { id?: string; status?: string; statusReason?: string };
      };
      const goal = features?.goal;
      const goalId = goal?.id;
      if (!goalId) return undefined;
      if (goal.status === "paused" && goal.statusReason === "waiting") {
        return goalId;
      }
      if (goal.status !== "active") return undefined;
      await deps.requestForSession(sessionId, "session.features.mutate", {
        mutation: { type: "goal.update", goalId, status: "paused", statusReason: "waiting" },
      });
      return goalId;
    } catch (error) {
      reportError(error);
      return undefined;
    }
  };

  const goalResume = async (
    workspaceId: string,
    sessionId: string,
    goalId: string | undefined,
    completedFollowUpId: string,
  ): Promise<boolean> => {
    if (!goalId) return true;
    try {
      const definitions = await listDefinitions(workspaceId);
      const stillWaiting = definitions.some((record) => {
        if (!ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return false;
        const candidate = payloadOf(record) as unknown as DefinitionPayload;
        return candidate.id !== completedFollowUpId
          && candidate.sessionId === sessionId
          && (candidate.pausedGoalId === goalId
            || (candidate.pauseRequested === true && !candidate.pausedGoalId));
      });
      if (stillWaiting) return true;
      const features = await deps.requestForSession(sessionId, "session.features.get", {}) as {
        goal?: { id?: string; status?: string; statusReason?: string };
      };
      // Only resume a goal this registration paused (waiting reason) — never
      // resurrect a goal the user paused or that settled meanwhile.
      if (features?.goal?.id !== goalId || features.goal.status !== "paused"
        || features.goal.statusReason !== "waiting") {
        return true;
      }
      await deps.requestForSession(sessionId, "session.features.mutate", {
        mutation: { type: "goal.update", goalId, status: "active", statusReason: "resumed" },
      });
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };

  /**
   * Deliver one recorded occurrence through the real lifecycle:
   * active run → passive inform; settled → continueRun; queued → parked
   * continuation; gone → dropped. Never starts a parallel run on an active
   * thread — the admission layer is the arbiter.
   */
  const deliver = async (
    workspaceId: string,
    definition: DefinitionPayload,
    occurrence: OccurrencePayload,
  ): Promise<{ delivery: FollowUpOccurrenceDelivery; runId?: string }> => {
    const factsText = Object.entries(occurrence.facts)
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("; ");
    const task = [
      `[follow-up ${occurrence.reason}] ${definition.instruction}`,
      factsText ? `Observed: ${factsText}` : "",
      "Logs and artifacts stay on demand — read them via the experiment/thread tools if needed.",
    ].filter(Boolean).join("\n");
    // The directed-message ledger, passive notify, native session receipt, and
    // continuation admission all share one identity. A live→settled race may
    // change the delivery path, but it cannot append a second model message.
    const requestId = occurrenceIdFor(occurrence.id);
    if (!definition.threadId) {
      // Root-session target: no thread lifecycle — the session itself is the
      // continuation. Busy gets a passive inform; idle gets the idempotent
      // execution request (its native receipt dedupes restart replays).
      if (await deps.sessionBusy(definition.sessionId).catch(() => false)) {
        try {
          await deps.notifySession(definition.sessionId, task, requestId);
        } catch (error) {
          if (await deps.sessionBusy(definition.sessionId).catch(() => true)) throw error;
          await deps.sessionRequest(definition.sessionId, task, requestId);
          return { delivery: "continued" as const };
        }
        // The run can settle between the busy snapshot and notification. The
        // shared message identity makes the idle request a safe handoff when it
        // no longer has a live request to receive the inform.
        if (await deps.sessionBusy(definition.sessionId).catch(() => true)) {
          return { delivery: "active-inform" as const };
        }
        await deps.sessionRequest(definition.sessionId, task, requestId);
        return { delivery: "continued" as const };
      }
      await deps.sessionRequest(definition.sessionId, task, requestId);
      return { delivery: "continued" as const };
    }
    return deps.sendToThread({
      scopeId: workspaceId,
      threadId: definition.threadId,
      text: task,
      requestId,
      from: definition.parent ?? { kind: "session", id: definition.sessionId },
    });
  };

  const syncFollowUpAttention = async (workspaceId: string, threadId: string): Promise<void> => {
    const definitions = await listDefinitions(workspaceId);
    const remaining = definitions
      .filter((record) => ACTIVE_STATUSES.has(record.state as FollowUpStatus))
      .map((record) => payloadOf(record) as unknown as DefinitionPayload)
      .find((candidate) => candidate.threadId === threadId && candidate.pauseRequested === true);
    await deps.setFollowUpAttention(
      workspaceId,
      threadId,
      remaining ? { kind: "followup", text: remaining.waitingSummary } : null,
    );
  };

  /** Deliver an already-recorded occurrence and settle both records with CAS. */
  const deliverRecordedOccurrence = async (
    workspaceId: string,
    followUpId: string,
    occurrenceRecord: KernelRecordResult,
  ): Promise<boolean> => {
    const occurrence = payloadOf(occurrenceRecord) as unknown as OccurrencePayload;
    let outcome: { delivery: FollowUpOccurrenceDelivery; runId?: string } | null = null;
    if (occurrenceRecord.state === "delivered" || occurrenceRecord.state === "dropped") {
      outcome = { delivery: occurrence.delivery ?? "dropped", ...(occurrence.runId ? { runId: occurrence.runId } : {}) };
    } else {
      const definitionRecord = await getDefinitionRecord(workspaceId, followUpId);
      if (!definitionRecord) return false;
      const definition = payloadOf(definitionRecord) as unknown as DefinitionPayload;
      try {
        outcome = await deliver(workspaceId, definition, occurrence);
      } catch (error) {
        reportError(error);
        if (!deliveryRetryTimers.has(occurrence.id)) {
          const timer = setTimeout(() => {
            deliveryRetryTimers.delete(occurrence.id);
            void (async () => {
              const { scoped } = await recordScope(workspaceId);
              const current = await scoped.getRecord(workspaceId, occurrenceIdFor(occurrence.id)).catch(() => null);
              if (!current || current.state === "delivered" || current.state === "dropped") return;
              await deliverRecordedOccurrence(workspaceId, followUpId, current);
            })().catch(reportError);
          }, DELIVERY_RETRY_DELAY_MS);
          deliveryRetryTimers.set(occurrence.id, timer);
        }
        return false;
      }
      const retry = deliveryRetryTimers.get(occurrence.id);
      if (retry) clearTimeout(retry);
      deliveryRetryTimers.delete(occurrence.id);
      try {
        occurrenceRecord = await putOccurrence(
          workspaceId,
          { ...occurrence, delivery: outcome.delivery, ...(outcome.runId ? { runId: outcome.runId } : {}) },
          outcome.delivery === "dropped" ? "dropped" : "delivered",
          occurrenceRecord.recordRevision,
        );
      } catch (error) {
        const { scoped } = await recordScope(workspaceId);
        const current = await scoped.getRecord(workspaceId, occurrenceIdFor(occurrence.id)).catch(() => null);
        if (!current || (current.state !== "delivered" && current.state !== "dropped")) throw error;
        occurrenceRecord = current;
        const currentPayload = payloadOf(current) as unknown as OccurrencePayload;
        outcome = {
          delivery: currentPayload.delivery ?? "dropped",
          ...(currentPayload.runId ? { runId: currentPayload.runId } : {}),
        };
      }
    }

    const latest = await getDefinitionRecord(workspaceId, followUpId);
    if (!latest) return true;
    const latestPayload = payloadOf(latest) as unknown as DefinitionPayload;
    // A later mutation owns the definition; never overwrite its occurrence.
    if (latestPayload.lastOccurrence?.id !== occurrence.id) return true;
    const delivered = outcome.delivery !== "dropped";
    const nextState: FollowUpStatus = outcome.delivery === "dropped"
      ? "unavailable"
      : (occurrence.reason === "deadline" || occurrence.rearm === true) ? "waiting" : "delivered";
    const nextPayload: DefinitionPayload = {
      ...latestPayload,
      updatedAt: now(),
      lastOccurrence: {
        id: occurrence.id,
        reason: occurrence.reason,
        at: occurrence.at,
        delivered,
      },
    };
    await putDefinition(workspaceId, nextPayload, nextState, latest.recordRevision);
    if (nextState === "waiting") {
      scheduleReprime(workspaceId, followUpId);
    } else {
      disarm(latestPayload);
      // A composite parent can be firing while one child owns its serial lock.
      // Defer sibling cleanup until that signal transaction releases the child.
      if (latestPayload.composite) {
        setTimeout(() => { void settleCompositeChildren(workspaceId, latestPayload).catch(reportError); }, 0);
      }
      if (latestPayload.threadId) {
        await syncFollowUpAttention(workspaceId, latestPayload.threadId).catch(reportError);
      }
      await goalResume(workspaceId, latestPayload.sessionId, latestPayload.pausedGoalId, followUpId);
    }
    changed(workspaceId);
    return true;
  };

  const settleCompositeChildren = async (workspaceId: string, payload: DefinitionPayload): Promise<void> => {
    if (!payload.composite) return;
    for (const childId of payload.composite.childIds) {
      await withDefinition(childId, async () => {
        const child = await getDefinitionRecord(workspaceId, childId);
        if (!child || !ACTIVE_STATUSES.has(child.state as FollowUpStatus)) return;
        const childPayload = payloadOf(child) as unknown as DefinitionPayload;
        disarm(childPayload);
        await putDefinition(workspaceId, { ...childPayload, updatedAt: now() }, "superseded", child.recordRevision);
      });
    }
  };

  const signalComposite = async (
    child: DefinitionPayload,
    reason: string,
    facts: Record<string, JsonValue>,
    eventId: string,
  ): Promise<{ recorded: boolean; fired: boolean }> => {
    const internal = child.internalSource;
    if (!internal) return { recorded: false, fired: false };
    const signal = await withDefinition(internal.parentId, async () => {
      const parentRecord = await getDefinitionRecord(child.workspaceId, internal.parentId);
      if (!parentRecord || parentRecord.state !== "waiting") return { recorded: false, ready: null };
      const parent = payloadOf(parentRecord) as unknown as DefinitionPayload;
      if (!isCompositeSource(parent.source) || !parent.composite?.childIds.includes(child.id)) {
        return { recorded: false, ready: null };
      }
      const existing = parent.composite.satisfied[internal.key];
      if (existing?.eventId === eventId) return { recorded: true, ready: null };
      const satisfied = {
        ...parent.composite.satisfied,
        [internal.key]: { eventId, reason, facts, at: now() },
      };
      const updatedPayload: DefinitionPayload = {
        ...parent,
        updatedAt: now(),
        composite: { ...parent.composite, satisfied },
      };
      const updated = await putDefinition(child.workspaceId, updatedPayload, "waiting", parentRecord.recordRevision);
      const complete = parent.source.kind === "any"
        ? Object.keys(satisfied).length > 0
        : parent.composite.childIds.every((_id, index) => satisfied[String(index)] !== undefined);
      return {
        recorded: true,
        ready: complete ? { record: updated, payload: updatedPayload, satisfied } : null,
      };
    });
    if (!signal.recorded || !signal.ready) return { recorded: signal.recorded, fired: false };
    const source = signal.ready.payload.source;
    if (!isCompositeSource(source)) return { recorded: false, fired: false };
    const cycleIdentity = createHash("sha256").update(JSON.stringify(
      Object.entries(signal.ready.satisfied).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value.eventId]),
    )).digest("hex");
    const fired = await fire(child.workspaceId, internal.parentId, `${source.kind}-satisfied`, {
      mode: source.kind,
      matched: Object.entries(signal.ready.satisfied).map(([key, value]) => ({ key, reason: value.reason, facts: value.facts })) as unknown as JsonValue,
    }, `composite-${cycleIdentity}`, {
      recordRevision: signal.ready.record.recordRevision,
      sourceIdentity: sourceIdentityFor(source, `${source.kind}-satisfied`),
    }, {
      rearm: source.every === true,
      sourceStatePatch: undefined,
    });
    return { recorded: true, fired };
  };

  /**
   * Fire an occurrence for a definition: record durably first (idempotent by
   * occurrence id), advance the definition, then deliver. Replays after a lost
   * response or restart observe the durable records instead of duplicating.
   */
  const fire = async (
    workspaceId: string,
    followUpId: string,
    reason: string,
    facts: Record<string, JsonValue>,
    dedupeKey?: string,
    guard?: FireGuard,
    opts?: { rearm?: boolean; sourceStatePatch?: DefinitionPayload["sourceState"] },
  ): Promise<boolean> => withDefinition(followUpId, async () => {
      const record = await getDefinitionRecord(workspaceId, followUpId);
      if (!record) return false;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      const status = record.state as FollowUpStatus;
      if (status !== "waiting") return false; // cancelled/superseded/delivered — late callbacks cannot revive
      if (guard) {
        const sameRevision = guard.recordRevision === undefined
          || record.recordRevision === guard.recordRevision;
        const sameSource = sourceIdentityFor(payload.source, reason) === guard.sourceIdentity;
        const consumedDeadlineOnly = reason === "experiment-terminal"
          && payload.lastOccurrence?.reason === "deadline"
          && sameSource;
        if (!sameSource || (!sameRevision && !consumedDeadlineOnly)) return false;
      }
      if (payload.internalSource) {
        const eventId = dedupeKey ?? `${reason}-${now()}`;
        const compositeSignal = await signalComposite(payload, reason, facts, eventId);
        if (!compositeSignal.recorded) return false;
        const parentRecord = await getDefinitionRecord(workspaceId, payload.internalSource.parentId);
        const parentPayload = parentRecord ? payloadOf(parentRecord) as unknown as DefinitionPayload : null;
        const compositeRepeats = Boolean(parentPayload && isCompositeSource(parentPayload.source)
          && parentPayload.source.every === true
          && (payload.source.kind === "log"
            || payload.source.kind === "metric"
            || payload.source.kind === "artifact" && payload.source.every === true
            || payload.source.kind === "shell" && payload.source.condition === "output"
            || payload.source.kind === "file" && payload.source.condition === "changed"));
        const sourceState = opts?.sourceStatePatch === undefined
          ? payload.sourceState
          : { ...(payload.sourceState ?? {}), ...opts.sourceStatePatch };
        const nextState: FollowUpStatus = opts?.rearm === true || compositeRepeats ? "waiting" : "delivered";
        await putDefinition(workspaceId, {
          ...payload,
          updatedAt: now(),
          ...(sourceState === undefined ? {} : { sourceState }),
        }, nextState, record.recordRevision);
        if (nextState !== "waiting") disarm(payload);
        return compositeSignal.fired;
      }
      const occurrenceId = `occ-${followUpId}-${reason}-${dedupeKey ?? now()}`;
      const occurrence: OccurrencePayload = {
        id: occurrenceId,
        followUpId,
        reason,
        facts,
        ...(opts?.rearm === true ? { rearm: true } : {}),
        at: now(),
      };
      let occurrenceRecord: KernelRecordResult;
      try {
        occurrenceRecord = await putOccurrence(workspaceId, occurrence, "recorded");
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (code.includes("conflict") || code.includes("idempotent") || code.includes("revision")) {
          // Same occurrence already recorded — recover it and continue delivery.
          const { scoped } = await recordScope(workspaceId);
          const existing = await scoped.getRecord(workspaceId, occurrenceIdFor(occurrenceId)).catch(() => null);
          if (!existing) throw error;
          occurrenceRecord = existing;
        } else {
          throw error;
        }
      }
      const mergedSourceState = opts?.sourceStatePatch !== undefined
        ? { ...(payload.sourceState ?? {}), ...opts.sourceStatePatch }
        : payload.sourceState;
      if (reason === "deadline" && "fallbackAt" in payload.source && payload.source.fallbackAt !== undefined) {
        // Backstop fires once; the event wait survives — clear fallbackAt so
        // a reconcile does not re-arm the consumed deadline.
        const next = { ...payload, source: { ...payload.source }, updatedAt: now() };
        delete (next.source as { fallbackAt?: number }).fallbackAt;
        const nextPayload: DefinitionPayload = {
          ...next,
          ...(mergedSourceState !== undefined ? { sourceState: mergedSourceState } : {}),
          lastOccurrence: { id: occurrenceId, reason, at: now(), delivered: false },
        };
        await putDefinition(workspaceId, nextPayload, "waiting", record.recordRevision);
        clearTimer(followUpId);
      } else {
        const nextPayload: DefinitionPayload = {
          ...payload,
          updatedAt: now(),
          ...(isCompositeSource(payload.source) && opts?.rearm === true && payload.composite
            ? { composite: { ...payload.composite, satisfied: {} } }
            : {}),
          ...(mergedSourceState !== undefined ? { sourceState: mergedSourceState } : {}),
          lastOccurrence: { id: occurrenceId, reason, at: now(), delivered: false },
        };
        await putDefinition(workspaceId, nextPayload, "triggered", record.recordRevision);
        if (opts?.rearm !== true) disarm(payload);
      }
      changed(workspaceId);
      await deliverRecordedOccurrence(workspaceId, followUpId, occurrenceRecord);
      return true;
    });

  async function listDefinitions(workspaceId: string): Promise<KernelRecordResult[]> {
    const { scoped } = await recordScope(workspaceId);
    const records: KernelRecordResult[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId, recordType: "followup.definition", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      records.push(...page.records);
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return records;
  }

  const persistedExperimentCaller = (caller: FollowUpCaller): PersistedExperimentCaller => ({
    workspaceId: caller.workspaceId,
    executionWorkspaceId: caller.executionWorkspaceId,
    sessionId: caller.sessionId,
    ...(caller.threadId ? { threadId: caller.threadId } : {}),
    ...(caller.runId ? { runId: caller.runId } : {}),
    rootSessionId: caller.rootSessionId,
    ...(caller.workspaceScope ? { workspaceScope: [...caller.workspaceScope] } : {}),
    allowedThreadIds: [...caller.allowedThreadIds],
  });

  const activateDefinition = async (
    record: KernelRecordResult,
    payload: DefinitionPayload,
    via: string,
  ): Promise<void> => {
    const source = payload.source;
    if (source.kind === "time") {
      if (source.at <= now()) {
        await fire(payload.workspaceId, payload.id, "time-due", { dueAt: source.at, via }, `time-${source.at}`, {
          recordRevision: record.recordRevision,
          sourceIdentity: sourceIdentityFor(source, "time-due"),
        });
      } else await arm(record);
      return;
    }
    if (source.kind === "experiment") {
      await arm(record);
      if (!deps.getAttempt) {
        await markUnavailable(payload.workspaceId, payload.id);
        return;
      }
      const attempt = await deps.getAttempt(payload.experimentCaller, source.attemptId).catch((error) => {
        reportError(error);
        return undefined;
      });
      if (attempt === null) {
        await markUnavailable(payload.workspaceId, payload.id);
      } else if (attempt !== undefined) {
        const states = new Set(source.states ?? [...TERMINAL_ATTEMPT_STATES]);
        if (states.has(attempt.state)) {
          await fire(payload.workspaceId, payload.id, "experiment-terminal", {
            attemptId: source.attemptId,
            state: attempt.state,
            ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
            via,
          } as Record<string, JsonValue>, `terminal-${source.attemptId}-${attempt.state}`, {
            recordRevision: record.recordRevision,
            sourceIdentity: sourceIdentityFor(source, "experiment-terminal"),
          });
        }
      }
      return;
    }
    if (!await arm(record)) return;
    await primeSource(payload.workspaceId, payload.id, via);
  };

  const createCompositeChildren = async (
    _parentRecord: KernelRecordResult,
    parent: DefinitionPayload,
    via: string,
    replaceExisting = true,
  ): Promise<void> => {
    if (!isCompositeSource(parent.source) || !parent.composite) return;
    const records: Array<{ record: KernelRecordResult; payload: DefinitionPayload }> = [];
    for (let index = 0; index < parent.source.sources.length; index += 1) {
      const source = parent.source.sources[index]!;
      const id = parent.composite.childIds[index]!;
      const childPayload: DefinitionPayload = {
        id,
        workspaceId: parent.workspaceId,
        sessionId: parent.sessionId,
        ...(parent.threadId ? { threadId: parent.threadId } : {}),
        ...(parent.parent ? { parent: parent.parent } : {}),
        ...(parent.runId ? { runId: parent.runId } : {}),
        instruction: parent.instruction,
        source,
        experimentCaller: parent.experimentCaller,
        pauseRequested: false,
        pausedGoal: false,
        waitingSummary: `Composite ${parent.source.kind} source ${index + 1}: ${summarizeSource(source)}`,
        createdAt: parent.createdAt,
        updatedAt: now(),
        internalSource: { parentId: parent.id, key: String(index) },
      };
      const existing = await getDefinitionRecord(parent.workspaceId, id);
      if (existing && !replaceExisting) {
        const existingPayload = payloadOf(existing) as unknown as DefinitionPayload;
        if (ACTIVE_STATUSES.has(existing.state as FollowUpStatus)) {
          records.push({ record: existing, payload: existingPayload });
        }
      } else {
        const childRecord = existing
          ? await putDefinition(parent.workspaceId, childPayload, "waiting", existing.recordRevision)
          : await putDefinition(parent.workspaceId, childPayload, "waiting");
        records.push({ record: childRecord, payload: childPayload });
      }
    }
    for (const child of records) {
      const currentParent = await getDefinitionRecord(parent.workspaceId, parent.id);
      if (!currentParent || !ACTIVE_STATUSES.has(currentParent.state as FollowUpStatus)) {
        await settleCompositeChildren(parent.workspaceId, parent);
        return;
      }
      if (child.payload.source.kind === "time" && child.payload.source.at <= now()) {
        await signalComposite(child.payload, "time-due", { dueAt: child.payload.source.at, via }, `time-${child.payload.source.at}`);
        const fresh = await getDefinitionRecord(parent.workspaceId, child.payload.id);
        if (fresh?.state === "waiting") {
          await putDefinition(parent.workspaceId, { ...child.payload, updatedAt: now() }, "delivered", fresh.recordRevision);
        }
      } else {
        await activateDefinition(child.record, child.payload, via);
      }
    }
  };

  const markUnavailable: (workspaceId: string, followUpId: string) => Promise<void> = async (workspaceId, followUpId) => {
    let internalParentId: string | undefined;
    await withDefinition(followUpId, async () => {
      const record = await getDefinitionRecord(workspaceId, followUpId);
      if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return;
      const payload = payloadOf(record) as unknown as DefinitionPayload;
      internalParentId = payload.internalSource?.parentId;
      disarm(payload);
      await putDefinition(workspaceId, { ...payload, updatedAt: now() }, "unavailable", record.recordRevision);
      if (!payload.internalSource) await settleCompositeChildren(workspaceId, payload);
      if (payload.threadId) await syncFollowUpAttention(workspaceId, payload.threadId).catch(reportError);
      await goalResume(workspaceId, payload.sessionId, payload.pausedGoalId, followUpId);
      changed(workspaceId);
    });
    if (internalParentId) {
      const parentRecord = await getDefinitionRecord(workspaceId, internalParentId);
      if (!parentRecord || parentRecord.state !== "waiting") return;
      const parent = payloadOf(parentRecord) as unknown as DefinitionPayload;
      if (!isCompositeSource(parent.source) || !parent.composite) return;
      const children = await Promise.all(parent.composite.childIds.map((id) => getDefinitionRecord(workspaceId, id)));
      const closeParent = parent.source.kind === "all"
        || children.every((child) => !child || child.state === "unavailable" || child.state === "superseded");
      if (closeParent) await markUnavailable(workspaceId, parent.id);
    }
  };

  const claimRequestedPause = async (
    workspaceId: string,
    followUpId: string,
  ): Promise<KernelRecordResult | null> => withDefinition(followUpId, async () => {
    const record = await getDefinitionRecord(workspaceId, followUpId);
    if (!record || !ACTIVE_STATUSES.has(record.state as FollowUpStatus)) return record;
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (payload.pauseRequested !== true || payload.pausedGoalId) return record;
    const pausedGoalId = await goalPause(payload.sessionId);
    if (!pausedGoalId) return record;
    return putDefinition(workspaceId, {
      ...payload,
      pausedGoal: true,
      pausedGoalId,
      updatedAt: now(),
    }, record.state as FollowUpStatus, record.recordRevision);
  });

  const assertLatestOccurrenceSettled = async (workspaceId: string, followUpId: string): Promise<void> => {
    const current = await getDefinitionRecord(workspaceId, followUpId);
    if (!current) return;
    const payload = payloadOf(current) as unknown as DefinitionPayload;
    if (ACTIVE_STATUSES.has(current.state as FollowUpStatus) && payload.lastOccurrence?.delivered === false) {
      throw new Error(`follow-up occurrence delivery remains pending: ${payload.lastOccurrence.id}`);
    }
  };

  const register = async (
    caller: FollowUpCaller,
    params: FollowUpRegisterParams,
  ): Promise<FollowUpRegisterResult> => {
    const instruction = params.instruction?.trim();
    if (!instruction) {
      throw new HarnessServiceError("invalid-params", "instruction is required — what should happen when the source fires");
    }
    const source = validateSource(params.source);
    assertSourceWithinCallerScope(caller, source);
    const thread = caller.threadId
      ? await deps.getThread(caller.workspaceId, caller.threadId).catch(() => null)
      : null;
    const parent: ThreadParent | undefined = caller.threadId
      ? (thread?.parent ?? { kind: "session", id: caller.sessionId })
      : undefined;
    const id = `fu-${randomUUID()}`;
    let payload: DefinitionPayload = {
      id,
      workspaceId: caller.workspaceId,
      sessionId: caller.sessionId,
      ...(caller.threadId ? { threadId: caller.threadId } : {}),
      ...(parent ? { parent } : {}),
      ...(caller.runId ? { runId: caller.runId } : {}),
      instruction,
      source,
      experimentCaller: persistedExperimentCaller(caller),
      pauseRequested: params.pause === true,
      pausedGoal: false,
      waitingSummary: `Waiting for ${summarizeSource(source)}`,
      createdAt: now(),
      updatedAt: now(),
      ...(isCompositeSource(source) ? {
        composite: {
          childIds: source.sources.map((_child, index) => `${id}:source:${index}`),
          satisfied: {},
        },
      } : {}),
    };
    // Persist pause intent before mutating the session goal. If the Host dies in
    // the next window, reconcile can safely complete and claim the pause.
    let record = await putDefinition(caller.workspaceId, payload, "waiting");
    if (params.pause === true) {
      const pausedGoalId = await goalPause(caller.sessionId);
      if (pausedGoalId) {
        payload = { ...payload, pausedGoal: true, pausedGoalId, updatedAt: now() };
        record = await putDefinition(caller.workspaceId, payload, "waiting", record.recordRevision);
      }
    }
    if (params.pause === true && caller.threadId) {
      await syncFollowUpAttention(caller.workspaceId, caller.threadId).catch(reportError);
    }

    // Install the durable observer before reading the attempt snapshot. An event
    // in the registration interval queues the same per-definition operation and
    // is drained below before the result is returned.
    let firedImmediately = false;
    if (isCompositeSource(source)) {
      await arm(record);
      await createCompositeChildren(record, payload, "register");
    } else if (source.kind === "time") {
      if (source.at <= now()) {
        firedImmediately = await fire(caller.workspaceId, id, "time-due", { dueAt: source.at, atRegistration: true }, `time-${source.at}`, {
          recordRevision: record.recordRevision,
          sourceIdentity: sourceIdentityFor(source, "time-due"),
        });
      } else {
        await arm(record);
      }
    } else if (source.kind === "experiment") {
      await arm(record);
      if (!deps.getAttempt) {
        await markUnavailable(caller.workspaceId, id);
      } else {
        let attempt: ExperimentAttemptView | null | undefined;
        try {
          attempt = await deps.getAttempt(payload.experimentCaller, source.attemptId);
        } catch (error) {
          // A transient read failure leaves the durable observer armed.
          reportError(error);
        }
        if (attempt === null) {
          await markUnavailable(caller.workspaceId, id);
        } else if (attempt !== undefined) {
          const states = new Set(source.states ?? [...TERMINAL_ATTEMPT_STATES]);
          if (states.has(attempt.state)) {
            firedImmediately = await fire(caller.workspaceId, id, "experiment-terminal", {
              attemptId: source.attemptId,
              state: attempt.state,
              ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
              atRegistration: true,
            } as Record<string, JsonValue>, `terminal-${source.attemptId}-${attempt.state}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(source, "experiment-terminal"),
            });
          } else if (source.fallbackAt !== undefined && source.fallbackAt <= now()) {
            firedImmediately = await fire(caller.workspaceId, id, "deadline", {
              fallbackAt: source.fallbackAt,
              stillWaiting: true,
              atRegistration: true,
            }, `deadline-${source.fallbackAt}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(source, "deadline"),
            });
          }
        }
      }
      await withDefinition(id, async () => {});
    } else {
      if (!await arm(record)) {
        const unavailable = await getDefinitionRecord(caller.workspaceId, id);
        return { followUp: toView(unavailable ?? record), firedImmediately: false };
      }
      // Observer first, snapshot second — an edge during the interval is
      // delivered once by whichever path commits the occurrence first.
      await primeSource(caller.workspaceId, id, "register");
    }
    changed(caller.workspaceId);
    const finalRecord = await getDefinitionRecord(caller.workspaceId, id);
    if (finalRecord && (payloadOf(finalRecord) as unknown as DefinitionPayload).lastOccurrence) {
      firedImmediately = true;
    }
    return {
      followUp: toView(finalRecord ?? record),
      firedImmediately,
    };
  };

  const requireDefinition = async (caller: FollowUpCaller, id: string) => {
    const record = await getDefinitionRecord(caller.workspaceId, id);
    if (!record) {
      throw new HarnessServiceError("not-found", `unknown follow-up "${id}"`);
    }
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (payload.internalSource) {
      throw new HarnessServiceError("not-found", `unknown follow-up "${id}"`);
    }
    const ownsTarget = payload.threadId !== undefined
      ? caller.threadId === payload.threadId
      : caller.sessionId === payload.sessionId;
    if (payload.workspaceId !== caller.workspaceId || !ownsTarget) {
      throw new HarnessServiceError("not-found", `unknown follow-up "${id}"`);
    }
    return { record, payload };
  };

  const list = async (caller: FollowUpCaller, params: FollowUpListParams): Promise<FollowUpListResult> => {
    // Also covers an ad-hoc root workspace that was not present in the Thread
    // catalog or saved project list during Host startup.
    await reconcile(caller.workspaceId);
    const records = await listDefinitions(caller.workspaceId);
    const views = records
      .filter((record) => !(payloadOf(record) as unknown as DefinitionPayload).internalSource)
      .map(toView)
      .filter((view) => params.includeInactive === true || ACTIVE_STATUSES.has(view.status))
      .filter((view) => view.threadId !== undefined
        ? caller.threadId === view.threadId
        : caller.sessionId === view.sessionId);
    return { followUps: views.sort((a, b) => a.createdAt - b.createdAt) };
  };

  const get = async (caller: FollowUpCaller, params: FollowUpGetParams): Promise<FollowUpGetResult> => {
    await reconcile(caller.workspaceId);
    const { record } = await requireDefinition(caller, params.id);
    const { scoped } = await recordScope(caller.workspaceId);
    const occurrences: FollowUpOccurrenceView[] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.listRecords({
        workspaceId: caller.workspaceId, recordType: "followup.occurrence", pageSize: 128,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const entry of page.records) {
        const view = occurrenceView(entry);
        if (view.followUpId === params.id) occurrences.push(view);
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
    return { followUp: toView(record), occurrences };
  };

  const update = async (caller: FollowUpCaller, params: FollowUpUpdateParams): Promise<FollowUpUpdateResult> => {
    let instruction: string | undefined;
    if (params.instruction !== undefined) {
      if (typeof params.instruction !== "string" || params.instruction.trim().length === 0) {
        throw new HarnessServiceError("invalid-params", "instruction must be a non-empty string");
      }
      instruction = params.instruction.trim();
    }
    const source = params.source !== undefined ? validateSource(params.source) : undefined;
    if (source) assertSourceWithinCallerScope(caller, source);
    const result = await withDefinition(params.id, async () => {
      const { record, payload } = await requireDefinition(caller, params.id);
      const status = record.state as FollowUpStatus;
      if (!ACTIVE_STATUSES.has(status)) {
        throw new HarnessServiceError("failed", `follow-up "${params.id}" is ${status} and cannot be updated`);
      }
      if (params.expectedRevision !== undefined && params.expectedRevision !== String(record.recordRevision)) {
        throw new HarnessServiceError(
          "failed",
          `revision conflict — re-read and retry (current ${record.recordRevision})`,
        );
      }
      const next: DefinitionPayload = {
        ...payload,
        ...(instruction !== undefined ? { instruction } : {}),
        ...(source !== undefined ? {
          source,
          experimentCaller: persistedExperimentCaller(caller),
        } : {}),
        updatedAt: now(),
        waitingSummary: source !== undefined
          ? `Waiting for ${summarizeSource(source)}`
          : payload.waitingSummary,
      };
      if (source !== undefined) {
        delete next.sourceState;
        delete next.composite;
        if (isCompositeSource(source)) {
          next.composite = {
            childIds: source.sources.map((_child, index) => `${payload.id}:source:${index}`),
            satisfied: {},
          };
        }
      }
      const updated = await putDefinition(caller.workspaceId, next, "waiting", record.recordRevision);
      if (source !== undefined) disarm(payload);
      changed(caller.workspaceId);
      return { updated, next, previous: payload, sourceChanged: source !== undefined };
    });
    const { updated, next, previous, sourceChanged } = result;
    if (!sourceChanged) return { followUp: toView(updated) };
    await settleCompositeChildren(caller.workspaceId, previous);
    if (isCompositeSource(next.source)) {
      await arm(updated);
      await createCompositeChildren(updated, next, "update");
    } else if (next.source.kind === "time" && next.source.at <= now()) {
      await fire(caller.workspaceId, params.id, "time-due", { dueAt: next.source.at, via: "update" }, `time-${next.source.at}`, {
        recordRevision: updated.recordRevision,
        sourceIdentity: sourceIdentityFor(next.source, "time-due"),
      });
    } else if (next.source.kind === "experiment") {
      await arm(updated);
      if (!deps.getAttempt) {
        await markUnavailable(caller.workspaceId, params.id);
      } else {
        let attempt: ExperimentAttemptView | null;
        try {
          attempt = await deps.getAttempt(next.experimentCaller, next.source.attemptId);
        } catch (error) {
          reportError(error);
          const current = await getDefinitionRecord(caller.workspaceId, params.id);
          return { followUp: toView(current ?? updated) };
        }
        if (attempt === null) {
          await markUnavailable(caller.workspaceId, params.id);
        } else {
          const states = new Set(next.source.states ?? [...TERMINAL_ATTEMPT_STATES]);
          if (states.has(attempt.state)) {
            await fire(caller.workspaceId, params.id, "experiment-terminal", {
              attemptId: next.source.attemptId,
              state: attempt.state,
              ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
              via: "update",
            }, `terminal-${next.source.attemptId}-${attempt.state}`, {
              recordRevision: updated.recordRevision,
              sourceIdentity: sourceIdentityFor(next.source, "experiment-terminal"),
            });
          } else if (next.source.fallbackAt !== undefined && next.source.fallbackAt <= now()) {
            await fire(caller.workspaceId, params.id, "deadline", {
              fallbackAt: next.source.fallbackAt,
              stillWaiting: true,
              via: "update",
            }, `deadline-${next.source.fallbackAt}`, {
              recordRevision: updated.recordRevision,
              sourceIdentity: sourceIdentityFor(next.source, "deadline"),
            });
          }
        }
      }
    } else {
      if (!await arm(updated)) {
        const unavailable = await getDefinitionRecord(caller.workspaceId, params.id);
        return { followUp: toView(unavailable ?? updated) };
      }
      await primeSource(caller.workspaceId, params.id, "update");
    }
    const current = await getDefinitionRecord(caller.workspaceId, params.id);
    return { followUp: toView(current ?? updated) };
  };

  const cancel = async (caller: FollowUpCaller, params: FollowUpCancelParams): Promise<FollowUpGetResult> => {
    let cancelledPayload: DefinitionPayload | undefined;
    await withDefinition(params.id, async () => {
      const { record, payload } = await requireDefinition(caller, params.id);
      const status = record.state as FollowUpStatus;
      if (!ACTIVE_STATUSES.has(status)) {
        if (payload.threadId) await syncFollowUpAttention(caller.workspaceId, payload.threadId).catch(reportError);
        await goalResume(caller.workspaceId, payload.sessionId, payload.pausedGoalId, params.id);
        return;
      }
      if (params.expectedRevision !== undefined && params.expectedRevision !== String(record.recordRevision)) {
        throw new HarnessServiceError(
          "failed",
          `revision conflict — re-read and retry (current ${record.recordRevision})`,
        );
      }
      disarm(payload);
      cancelledPayload = payload;
      await putDefinition(caller.workspaceId, { ...payload, updatedAt: now() }, "cancelled", record.recordRevision);
      if (payload.threadId) {
        await syncFollowUpAttention(caller.workspaceId, payload.threadId).catch(reportError);
      }
      await goalResume(caller.workspaceId, payload.sessionId, payload.pausedGoalId, params.id);
      changed(caller.workspaceId);
    });
    if (cancelledPayload) await settleCompositeChildren(caller.workspaceId, cancelledPayload);
    return get(caller, { id: params.id });
  };

  /** Read-only probe facts for a check report (no firing, no cursor advance). */
  const probeFacts = async (
    caller: FollowUpCaller,
    payload: DefinitionPayload,
  ): Promise<Record<string, JsonValue>> => {
    const source = payload.source;
    if (source.kind === "file") {
      const stat = deps.statWorkspaceFile
        ? await deps.statWorkspaceFile(caller.workspaceId, source.path).catch(() => null)
        : null;
      return {
        kind: "file",
        path: source.path,
        condition: source.condition,
        exists: stat?.exists === true,
        ...(stat?.size !== undefined ? { size: stat.size } : {}),
        ...(stat?.mtimeMs !== undefined ? { mtimeMs: stat.mtimeMs } : {}),
      };
    }
    if (isCompositeSource(source)) {
      return {
        kind: source.kind,
        satisfied: Object.keys(payload.composite?.satisfied ?? {}).length,
        total: source.sources.length,
      };
    }
    if (source.kind === "metric") {
      const sample = deps.getResourceSample
        ? await deps.getResourceSample(source.machineId).catch(() => null)
        : null;
      const value = sample ? metricValue(sample, source.metric) : undefined;
      return {
        kind: "metric",
        machineId: source.machineId,
        metric: source.metric,
        ...(value !== undefined && sample
          ? { value, observedAt: sample.observedAt, holding: payload.sourceState?.holding === true }
          : { sampled: false }),
      };
    }
    if (source.kind === "artifact") {
      const detail = deps.getExperiment
        ? await deps.getExperiment(payload.experimentCaller, source.attemptId).catch(() => null)
        : null;
      if (!detail) return { kind: "artifact", attemptId: source.attemptId, observed: "unavailable" };
      return {
        kind: "artifact",
        attemptId: source.attemptId,
        attemptState: detail.attempt.state,
        collection: detail.attempt.collection,
        readyArtifacts: detail.artifacts.filter((a) => a.state === "available" && artifactMatches(source, a)).length,
      };
    }
    if (source.kind === "log") {
      return {
        kind: "log",
        attemptId: source.attemptId,
        consumedBytes: logOffsets.get(payload.id) ?? payload.sourceState?.logOffset ?? 0,
      };
    }
    if (source.kind === "external") {
      return { kind: "external", provider: source.provider, condition: source.condition };
    }
    if (source.kind === "shell") {
      return {
        kind: "shell",
        executionId: source.executionId,
        condition: source.condition,
        eventCursor: payload.sourceState?.shellEventId ?? 0,
        outputOffset: payload.sourceState?.shellOutputOffset ?? 0,
      };
    }
    return { kind: source.kind };
  };

  const OBSERVED_KINDS: ReadonlySet<string> = new Set(["artifact", "file", "log", "metric", "external", "shell"]);

  /** Program-side evaluation of the source — "check now", never a model call. */
  const evaluate = async (
    caller: FollowUpCaller,
    id: string,
  ): Promise<{ satisfied: boolean; unavailable?: boolean; reason?: string; facts: Record<string, JsonValue>; guard?: FireGuard }> => {
    const { record } = await requireDefinition(caller, id);
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (record.state !== "waiting") {
      return { satisfied: false, facts: { status: record.state } };
    }
    const source = payload.source;
    if (source.kind === "time") {
      const due = source.at <= now();
      return {
        satisfied: due,
        reason: "time-due",
        facts: { dueAt: source.at, now: now(), due },
        guard: { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(source, "time-due") },
      };
    }
    if (source.kind === "experiment") {
      const attempt = deps.getAttempt
        ? await deps.getAttempt(payload.experimentCaller, source.attemptId)
        : null;
      if (attempt === null) {
        return { satisfied: false, unavailable: true, facts: { attemptId: source.attemptId, observed: "unavailable" } };
      }
      const states = new Set(source.states ?? [...TERMINAL_ATTEMPT_STATES]);
      const satisfied = states.has(attempt.state);
      return {
        satisfied,
        reason: "experiment-terminal",
        guard: { recordRevision: record.recordRevision, sourceIdentity: sourceIdentityFor(source, "experiment-terminal") },
        facts: {
          attemptId: source.attemptId,
          state: attempt.state,
          ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
        },
      };
    }
    return { satisfied: false, facts: { kind: source.kind, note: "no program-evaluable condition" } };
  };

  const check = async (caller: FollowUpCaller, params: FollowUpCheckParams): Promise<FollowUpCheckResult> => {
    const { record: before } = await requireDefinition(caller, params.id);
    const beforePayload = payloadOf(before) as unknown as DefinitionPayload;
    const beforeOccurrence = beforePayload.lastOccurrence?.id;
    if (before.state === "waiting" && isCompositeSource(beforePayload.source) && beforePayload.composite) {
      for (const childId of beforePayload.composite.childIds) {
        const child = await getDefinitionRecord(caller.workspaceId, childId);
        if (!child || child.state !== "waiting") continue;
        await activateDefinition(child, payloadOf(child) as unknown as DefinitionPayload, "check");
      }
      const { record: after } = await requireDefinition(caller, params.id);
      const afterPayload = payloadOf(after) as unknown as DefinitionPayload;
      return {
        followUp: toView(after),
        fired: afterPayload.lastOccurrence?.id !== undefined && afterPayload.lastOccurrence.id !== beforeOccurrence,
        observed: await probeFacts(caller, afterPayload),
      };
    }
    if (before.state === "waiting" && OBSERVED_KINDS.has(beforePayload.source.kind)) {
      // Observed sources evaluate through their own prime path — the same one
      // registration and reconcile use — so check cannot diverge from events.
      await primeSource(caller.workspaceId, params.id, "check");
      const { record: after } = await requireDefinition(caller, params.id);
      const afterPayload = payloadOf(after) as unknown as DefinitionPayload;
      const fired = afterPayload.lastOccurrence !== undefined
        && afterPayload.lastOccurrence.id !== beforeOccurrence;
      let observed = await probeFacts(caller, afterPayload).catch(() => ({ kind: afterPayload.source.kind } as Record<string, JsonValue>));
      if (fired && afterPayload.lastOccurrence) {
        const { scoped } = await recordScope(caller.workspaceId);
        const occurrence = await scoped.getRecord(caller.workspaceId, occurrenceIdFor(afterPayload.lastOccurrence.id)).catch(() => null);
        if (occurrence) observed = (payloadOf(occurrence) as unknown as OccurrencePayload).facts;
      }
      return { followUp: toView(after), fired, observed };
    }
    const outcome = await evaluate(caller, params.id);
    let fired = false;
    if (outcome.unavailable) {
      await markUnavailable(caller.workspaceId, params.id);
    } else if (outcome.satisfied && outcome.reason) {
      const dedupeKey = outcome.reason === "time-due"
        ? `time-${String(outcome.facts.dueAt)}`
        : undefined;
      fired = await fire(
        caller.workspaceId,
        params.id,
        outcome.reason,
        { ...outcome.facts, via: "check" },
        dedupeKey,
        outcome.guard,
      );
    }
    const { record } = await requireDefinition(caller, params.id);
    return {
      followUp: toView(record),
      fired,
      observed: outcome.facts,
    };
  };

  /** Explicit invoke — "let the agent take over now", not a program check. */
  const fireNow = async (caller: FollowUpCaller, params: FollowUpFireParams): Promise<FollowUpGetResult> => {
    const { record } = await requireDefinition(caller, params.id);
    if (params.expectedRevision !== undefined && params.expectedRevision !== String(record.recordRevision)) {
      throw new HarnessServiceError(
        "failed",
        `revision conflict — re-read and retry (current ${record.recordRevision})`,
      );
    }
    const reason = params.reason ?? "invoked-now";
    const payload = payloadOf(record) as unknown as DefinitionPayload;
    if (isCompositeSource(payload.source) && payload.composite) {
      const manualIndex = payload.source.sources.findIndex((source, index) => (
        source.kind === "manual" && payload.composite?.satisfied[String(index)] === undefined
      ));
      if (manualIndex >= 0) {
        const childId = payload.composite.childIds[manualIndex]!;
        const childRecord = await getDefinitionRecord(caller.workspaceId, childId);
        const childPayload = childRecord
          ? payloadOf(childRecord) as unknown as DefinitionPayload
          : { ...payload, id: childId, source: payload.source.sources[manualIndex]!, internalSource: { parentId: payload.id, key: String(manualIndex) } };
        const signal = await signalComposite(
          childPayload,
          reason,
          { via: "manual", compositeKey: String(manualIndex) },
          `manual-${now()}`,
        );
        if (signal.recorded && childRecord && ACTIVE_STATUSES.has(childRecord.state as FollowUpStatus)) {
          await withDefinition(childId, async () => {
            const fresh = await getDefinitionRecord(caller.workspaceId, childId);
            if (!fresh || !ACTIVE_STATUSES.has(fresh.state as FollowUpStatus)) return;
            const freshPayload = payloadOf(fresh) as unknown as DefinitionPayload;
            disarm(freshPayload);
            await putDefinition(caller.workspaceId, { ...freshPayload, updatedAt: now() }, "delivered", fresh.recordRevision);
          });
        }
        return get(caller, { id: params.id });
      }
    }
    await fire(caller.workspaceId, params.id, reason, { via: "manual" }, `manual-${now()}`, {
      recordRevision: record.recordRevision,
      sourceIdentity: sourceIdentityFor(payload.source, reason),
    });
    return get(caller, { id: params.id });
  };

  // Experiment attempt changes drive experiment/artifact/log waits. The
  // notification is only a wakeup — every path re-reads through the
  // definition's persisted caller. Occurrence identities dedupe replays.
  function onAttemptEvent(workspaceId: string, attemptId: string, _view: ExperimentAttemptView | null): void {
    const waiting = attemptWaits.get(attemptId);
    if (!waiting) return;
    for (const followUpId of [...waiting]) {
      void (async () => {
        const record = await getDefinitionRecord(workspaceId, followUpId);
        if (!record || record.state !== "waiting") return;
        const payload = payloadOf(record) as unknown as DefinitionPayload;
        if (payload.source.kind === "artifact" && payload.source.attemptId === attemptId) {
          await evaluateArtifactWait(workspaceId, followUpId, "event");
          return;
        }
        if (payload.source.kind === "log" && payload.source.attemptId === attemptId) {
          await drainLog(workspaceId, followUpId, "event");
          return;
        }
        if (payload.source.kind !== "experiment" || payload.source.attemptId !== attemptId) return;
        if (!deps.getAttempt) {
          await markUnavailable(workspaceId, followUpId);
          return;
        }
        // Subscription payloads are only wakeups. Re-read through the
        // definition's persisted ExperimentCaller so a Host observer never
        // becomes a maintenance-authority bypass.
        const observed = await deps.getAttempt(payload.experimentCaller, attemptId);
        if (observed === null) {
          await markUnavailable(workspaceId, followUpId);
          return;
        }
        const states = new Set(payload.source.states ?? [...TERMINAL_ATTEMPT_STATES]);
        if (!states.has(observed.state)) return;
        await fire(workspaceId, followUpId, "experiment-terminal", {
          attemptId,
          state: observed.state,
          ...(observed.exitCode !== undefined ? { exitCode: observed.exitCode } : {}),
          ...(observed.endedAt !== undefined && observed.endedAt !== null ? { endedAt: observed.endedAt } : {}),
        } as Record<string, JsonValue>, `terminal-${attemptId}-${observed.state}`, {
          recordRevision: record.recordRevision,
          sourceIdentity: sourceIdentityFor(payload.source, "experiment-terminal"),
        });
      })().catch(reportError);
    }
  }

  const reconciledWorkspaces = new Set<string>();
  const reconcileOperations = new Map<string, Promise<void>>();

  type SettlementTarget = { kind: "thread" | "session"; id: string };

  const payloadTargets = (payload: DefinitionPayload, target: SettlementTarget): boolean => (
    target.kind === "thread" ? payload.threadId === target.id : payload.sessionId === target.id
  );

  /** Settle one definition only after re-reading it inside the serial section. */
  const settleDefinitionTarget = async (
    workspaceId: string,
    followUpId: string,
    target: SettlementTarget,
  ): Promise<boolean> => withDefinition(followUpId, async () => {
    const fresh = await getDefinitionRecord(workspaceId, followUpId);
    if (!fresh || !ACTIVE_STATUSES.has(fresh.state as FollowUpStatus)) return false;
    const freshPayload = payloadOf(fresh) as unknown as DefinitionPayload;
    if (!payloadTargets(freshPayload, target)) return false;
    disarm(freshPayload);
    await putDefinition(
      workspaceId,
      { ...freshPayload, updatedAt: now() },
      "cancelled",
      fresh.recordRevision,
    );
    if (freshPayload.threadId) {
      await syncFollowUpAttention(workspaceId, freshPayload.threadId).catch(reportError);
    }
    if (!await goalResume(workspaceId, freshPayload.sessionId, freshPayload.pausedGoalId, freshPayload.id)) {
      throw new Error(`follow-up goal resume remains pending for ${freshPayload.id}`);
    }
    return true;
  });

  /**
   * Rebuild observers from durable records after a host restart. Overdue time
   * waits fire once (with a delayed-delivery fact); experiment waits re-check
   * the durable attempt view rather than re-subscribing blind. Once per
   * workspace per host lifetime.
   */
  const reconcile = async (workspaceId: string): Promise<void> => {
    if (reconciledWorkspaces.has(workspaceId)) return;
    const existing = reconcileOperations.get(workspaceId);
    if (existing) return existing;
    const operation = (async () => {
      // Do not mark the workspace reconciled until the authoritative list read
      // and every recovery mutation succeeds; callers may retry a failed pass.
      const records = await listDefinitions(workspaceId);
      let sideEffectFailed = false;
      for (const initialRecord of records) {
        let record = initialRecord;
        let payload = payloadOf(record) as unknown as DefinitionPayload;
        let status = record.state as FollowUpStatus;

        if (!ACTIVE_STATUSES.has(status)) {
          disarm(payload);
          if (payload.threadId && payload.pauseRequested === true) {
            try {
              await syncFollowUpAttention(workspaceId, payload.threadId);
            } catch (error) {
              reportError(error);
              sideEffectFailed = true;
            }
          }
          if (!await goalResume(workspaceId, payload.sessionId, payload.pausedGoalId, payload.id)) {
            sideEffectFailed = true;
          }
          continue;
        }

        // Thread lifecycle is durable and queryable. This retries archive/remove
        // settlement after an observer failure without needing a second event.
        if (payload.threadId) {
          const thread = await deps.getThread(workspaceId, payload.threadId);
          if (!thread || thread.lifecycle === "archived") {
            await settleDefinitionTarget(workspaceId, payload.id, { kind: "thread", id: payload.threadId });
            continue;
          }
        }

        if (payload.pauseRequested === true && !payload.pausedGoalId) {
          const claimed = await claimRequestedPause(workspaceId, payload.id);
          if (!claimed) continue;
          record = claimed;
          payload = payloadOf(record) as unknown as DefinitionPayload;
          status = record.state as FollowUpStatus;
          if (payload.threadId) await syncFollowUpAttention(workspaceId, payload.threadId);
        }

        if (payload.lastOccurrence && payload.lastOccurrence.delivered === false) {
          // Deadline occurrences keep observing the terminal attempt while their
          // own delivery is recovered.
          if (status === "waiting" && payload.lastOccurrence.reason === "deadline") await arm(record);
          const { scoped } = await recordScope(workspaceId);
          const occurrenceRecord = await scoped.getRecord(
            workspaceId,
            occurrenceIdFor(payload.lastOccurrence.id),
          );
          if (!occurrenceRecord) {
            await markUnavailable(workspaceId, payload.id);
            continue;
          }
          const recovered = await withDefinition(payload.id, () => (
            deliverRecordedOccurrence(workspaceId, payload.id, occurrenceRecord)
          ));
          if (!recovered) throw new Error(`follow-up occurrence delivery remains pending: ${payload.lastOccurrence.id}`);
          const refreshed = await getDefinitionRecord(workspaceId, payload.id);
          if (!refreshed) continue;
          record = refreshed;
          payload = payloadOf(record) as unknown as DefinitionPayload;
          status = record.state as FollowUpStatus;
          if (!ACTIVE_STATUSES.has(status)) continue;
          if (payload.lastOccurrence?.delivered === false) {
            throw new Error(`follow-up occurrence did not settle: ${payload.lastOccurrence.id}`);
          }
        }

        if (status === "triggered") {
          // Triggered without an exact pending occurrence cannot be recovered by
          // guessing from workspace history.
          await markUnavailable(workspaceId, payload.id);
          continue;
        }
        if (isCompositeSource(payload.source)) {
          await arm(record);
          await createCompositeChildren(record, payload, "reconcile", false);
          continue;
        }
        if (payload.source.kind === "time") {
          if (payload.source.at <= now()) {
            const fired = await fire(workspaceId, payload.id, "time-due", {
              dueAt: payload.source.at,
              delayedByMs: now() - payload.source.at,
              recoveredAfterRestart: true,
            }, `time-${payload.source.at}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(payload.source, "time-due"),
            });
            if (fired) await assertLatestOccurrenceSettled(workspaceId, payload.id);
          } else {
            await arm(record);
          }
          continue;
        }
        if (payload.source.kind === "experiment") {
          await arm(record);
          if (!deps.getAttempt) {
            await markUnavailable(workspaceId, payload.id);
            continue;
          }
          const attempt = await deps.getAttempt(payload.experimentCaller, payload.source.attemptId);
          if (attempt === null) {
            await markUnavailable(workspaceId, payload.id);
            continue;
          }
          const states = new Set(payload.source.states ?? [...TERMINAL_ATTEMPT_STATES]);
          if (states.has(attempt.state)) {
            const fired = await fire(workspaceId, payload.id, "experiment-terminal", {
              attemptId: payload.source.attemptId,
              state: attempt.state,
              recoveredAfterRestart: true,
            }, `terminal-${payload.source.attemptId}-${attempt.state}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(payload.source, "experiment-terminal"),
            });
            if (fired) await assertLatestOccurrenceSettled(workspaceId, payload.id);
          } else if (payload.source.fallbackAt !== undefined && payload.source.fallbackAt <= now()) {
            const fired = await fire(workspaceId, payload.id, "deadline", {
              fallbackAt: payload.source.fallbackAt,
              stillWaiting: true,
              recoveredAfterRestart: true,
            }, `deadline-${payload.source.fallbackAt}`, {
              recordRevision: record.recordRevision,
              sourceIdentity: sourceIdentityFor(payload.source, "deadline"),
            });
            if (fired) await assertLatestOccurrenceSettled(workspaceId, payload.id);
          }
          continue;
        }
        if (OBSERVED_KINDS.has(payload.source.kind)) {
          // Rebuild the observer, then re-read the authoritative snapshot —
          // the durable observer is installed before any eval so a restart
          // edge is never lost. Occurrence identities dedupe overlap replays.
          if (!await arm(record)) continue;
          await primeSource(workspaceId, payload.id, "reconcile");
          if (payload.lastOccurrence && payload.lastOccurrence.delivered === false) {
            await assertLatestOccurrenceSettled(workspaceId, payload.id);
          }
          continue;
        }
        await arm(record);
      }
      if (sideEffectFailed) throw new Error(`follow-up side-effect reconciliation failed for workspace ${workspaceId}`);
      reconciledWorkspaces.add(workspaceId);
    })();
    reconcileOperations.set(workspaceId, operation);
    try {
      await operation;
    } finally {
      if (reconcileOperations.get(workspaceId) === operation) reconcileOperations.delete(workspaceId);
    }
  };

  /**
   * Owning workspaces of every durable definition — the kernel record store is
   * the single authority, so recovery does not depend on the Thread catalog,
   * saved projects, or an open UI surface. A Host-level maintenance grant sees
   * workspace ids only; definition reads stay scoped per workspace.
   */
  const definitionWorkspaces = async (): Promise<string[]> => {
    const grantId = `followup:enumerate:${randomUUID()}`;
    const grant = await deps.client.issueGrant({
      grantId,
      capabilities: [...SERVICE_CAPABILITIES],
      owningWorkspace: null,
      executionWorkspace: null,
      pathScopes: [],
    });
    try {
      const result = await deps.client.recordWorkspaces({ recordType: "followup.definition" }, grant);
      return result.workspaceIds;
    } finally {
      await deps.client.revokeGrant(grantId);
    }
  };

  /** Authenticated Host UI overview only; never exposed as an Agent service. */
  const listForHost = async (params: FollowUpListParams): Promise<FollowUpListResult> => {
    const followUps: FollowUpDefinitionView[] = [];
    for (const workspaceId of await definitionWorkspaces()) {
      const records = await listDefinitions(workspaceId);
      for (const record of records) {
        if ((payloadOf(record) as unknown as DefinitionPayload).internalSource) continue;
        const view = toView(record);
        if (params.includeInactive === true || ACTIVE_STATUSES.has(view.status)) followUps.push(view);
      }
    }
    return { followUps: followUps.sort((left, right) => right.updatedAt - left.updatedAt) };
  };

  /**
   * Lifecycle settling (W-B): when a target disappears — thread archived or
   * deleted or a session deleted — active definitions pointing at it are
   * durably closed instead of waiting for a trigger that can no longer deliver.
   * Attempt removal has no production lifecycle hook; source disappearance is
   * handled by the authoritative experiment reads instead.
   */
  const settleTarget = async (
    workspaceId: string,
    target: SettlementTarget,
  ): Promise<number> => {
    try {
      const records = await listDefinitions(workspaceId);
      let settled = 0;
      for (const record of records) {
        if (!ACTIVE_STATUSES.has(record.state as FollowUpStatus)) continue;
        const payload = payloadOf(record) as unknown as DefinitionPayload;
        if (!payloadTargets(payload, target)) continue;
        if (await settleDefinitionTarget(workspaceId, payload.id, target)) settled += 1;
      }
      if (settled > 0) changed(workspaceId);
      return settled;
    } catch (error) {
      // A later list/get pass must be allowed to retry against durable target
      // lifecycle rather than treating the failed observer pass as final.
      reconciledWorkspaces.delete(workspaceId);
      throw error;
    }
  };

  return {
    register,
    list,
    listForHost,
    get,
    update,
    cancel,
    check,
    fire: fireNow,
    reconcile,
    definitionWorkspaces,
    settleTarget,
    dispose: () => {
      unsubscribeAttempts?.();
      unsubscribeSamples?.();
      unsubscribeShellEvents?.();
      for (const id of [...timers.keys()]) clearTimer(id);
      for (const id of [...externalTimers.keys()]) clearExternalTimer(id);
      for (const timer of deliveryRetryTimers.values()) clearTimeout(timer);
      deliveryRetryTimers.clear();
      externalGroups.clear();
      for (const id of [...readySettles.keys()]) clearReadySettle(id);
      for (const [workspaceId] of workspaceWatches) {
        workspaceWatches.get(workspaceId)?.close();
      }
      workspaceWatches.clear();
      fileWaits.clear();
      metricWaits.clear();
      shellWaits.clear();
      logOffsets.clear();
    },
  };
}

export type FollowUpService = ReturnType<typeof createFollowUpService>;
