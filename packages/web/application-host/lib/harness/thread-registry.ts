/**
 * Durable Host-owned registry for threads and their execution attempts.
 *
 * One versioned catalog is written per workspace. Thread and ThreadRun rows
 * share the same atomic file so a run transition cannot be committed without
 * its corresponding thread projection.
 */

import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  isResearchCapability,
  parseHarnessAgentModelSettings,
  normalizeFrozenHarnessPermissions,
  sealRetrievalEvidence,
  summarizeRetrievalEvidence,
} from "@varin/protocol";
import { normalizeThreadScopePath } from "./thread-nesting.js";
import type {
  RetrievalAttempt,
  RetrievalEvidence,
  RetrievalFact,
  RetrievalFactSource,
  Thread,
  ThreadAttention,
  ThreadCreatedBy,
  ThreadDiffStats,
  ThreadEnvironment,
  ThreadInheritedContext,
  ThreadIntegration,
  ThreadIntegrationBinding,
  ThreadKind,
  ThreadLifecycle,
  ThreadLaunchManifest,
  ThreadMessagePeer,
  ThreadMessageRecord,
  ThreadParent,
  ThreadPurpose,
  ThreadPendingContinuation,
  ThreadReport,
  ThreadRun,
  ThreadRunInputOrigin,
  ThreadRunOutcome,
  ThreadResearchManifest,
  ThreadTokens,
  ThreadViewCursor,
  ThreadReviewOf,
  ThreadSessionBinding,
  ThreadSessionOwner,
  ThreadVerificationProjection,
  ThreadWaitingFor,
  ThreadWorktree,
} from "@varin/protocol";

export type { ThreadSessionBinding };

export type {
  Thread,
  ThreadAttention,
  ThreadCreatedBy,
  ThreadDiffStats,
  ThreadIntegration,
  ThreadKind,
  ThreadLifecycle,
  ThreadParent,
  ThreadReport,
  ThreadRun,
  ThreadRunOutcome,
  ThreadTokens,
  ThreadWaitingFor,
  ThreadWorktree,
};

/** Stable structural encoding for durable idempotency identities. Object key
 * order is irrelevant; array order remains significant because tools/scope
 * and rule ordering are part of the frozen configuration. */
export const stableIdentityJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableIdentityJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableIdentityJson(record[key])}`).join(",")}}`;
};

export const sameFrozenRunConfig = (
  left: ThreadRun["frozen"] | undefined,
  right: ThreadRun["frozen"] | undefined,
): boolean => stableIdentityJson(left ?? null) === stableIdentityJson(right ?? null);

export const THREAD_REGISTRY_SCHEMA_VERSION = 10;

/** A retryable scheduling decision, not a storage or execution failure. */
export class ThreadAdmissionError extends Error {
  readonly code = "capacity" as const;

  constructor(readonly rootSessionId: string, readonly concurrency: number) {
    super(`Root task ${rootSessionId} has no free execution slot (limit ${concurrency})`);
    this.name = "ThreadAdmissionError";
  }
}

export type ThreadRegistryErrorCode =
  | "corrupt"
  | "future-schema"
  | "read-failed"
  | "write-failed"
  | "stale-binding";

export class ThreadRegistryError extends Error {
  readonly code: ThreadRegistryErrorCode;
  readonly path: string;

  constructor(code: ThreadRegistryErrorCode, message: string, path: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "ThreadRegistryError";
    this.code = code;
    this.path = path;
  }
}

export interface ThreadCatalogDocument {
  schemaVersion: typeof THREAD_REGISTRY_SCHEMA_VERSION;
  scopeId: string;
  threads: Thread[];
  runs: ThreadRun[];
}

/** Derived references into one committed catalog generation, never another authority. */
interface ThreadCatalogReadIndex {
  threadsById: Map<string, Thread>;
  runsById: Map<string, ThreadRun>;
  runsByThreadId: Map<string, ThreadRun[]>;
  latestRunBySessionId: Map<string, ThreadRun>;
}

export interface CreateThreadInput {
  modelSettings?: import("@varin/protocol").HarnessAgentModelSettings;
  scopeId: string;
  parent: ThreadParent;
  brief: string;
  preset?: string;
  kind: ThreadKind;
  createdBy: ThreadCreatedBy;
  purpose?: ThreadPurpose;
  forkPoint?: { entryId: string };
  carryBlocks?: boolean;
  concurrency: number;
  draftBaselineId?: string;
  sourceViewId?: string;
  /** How the first Run's input is constructed; `inherit` requires inheritedContext. */
  inputOrigin?: "task" | "inherit";
  inheritedContext?: ThreadInheritedContext;
  initialAuthorityRoot?: string;
  scope?: string[];
  worktree: "none" | "shared" | "isolated";
  model?: { providerId: string; modelId: string };
  tools: string[];
  workFocus?: import("@varin/protocol").WorkFocusId;
  research?: ThreadResearchManifest;
  permissions: unknown;
  systemPromptFragment?: string;
  /** Bespoke first-Run prompt that survives queuing. */
  promptText?: string;
  autoRun: boolean;
  hidden?: boolean;
  /** BC3: a discussion Thread bound to consult this Bot. */
  consultBotId?: string;
  /**
   * Initial execution-environment binding; absent = inherit the parent
   * Thread's binding, or Host defaults at the root.
   */
  environment?: { workTarget?: string; desktopId?: string };
}

export interface ThreadRegistryOptions {
  dataDir: string;
  hostId: string;
  canExecuteScope?(scopeId: string): Promise<boolean>;
  onThreadChanged?: (scopeId: string, parent: ThreadParent, thread: Thread, activeRun: ThreadRun | null) => void;
  onThreadDone?: (scopeId: string, parent: ThreadParent, threadId: string, report: ThreadReport) => void;
  /** A report newly persisted by this completed Run, including failure/cancellation. */
  onThreadReturned?: (scopeId: string, parent: ThreadParent, threadId: string, run: ThreadRun, report: ThreadReport) => void;
  onThreadDequeued?: (scopeId: string, parent: ThreadParent, thread: Thread) => Promise<void>;
  /**
   * Fires whenever the shared root execution budget may have freed a slot —
   * after a dequeue pass or when a Thread marks a dependency wait. Consumers
   * re-check admission and retry deferred work (lost-run resume).
   */
  onAdmissionFreed?: (scopeId: string, parent: ThreadParent) => void | Promise<void>;
  onObserverError?: (error: unknown) => void;
  onThreadRemoved?: (scopeId: string, threadId: string) => void | Promise<void>;
  maxConcurrency?: number;
  fsPromises?: Pick<typeof fs.promises, "mkdir" | "readFile" | "readdir" | "rename" | "rm" | "writeFile">;
  now?: () => Date;
}

export interface ThreadRegistryReconcileFailure {
  code: ThreadRegistryErrorCode;
  message: string;
  path: string;
}

export interface ThreadRegistryReconcileResult {
  failures: ThreadRegistryReconcileFailure[];
  legacyFilesSkipped: number;
  reconciledRuns: number;
  workspaces: number;
}

interface MutationResult<T> {
  value: T;
  changed: Thread[];
  done?: Array<{ thread: Thread; report: ThreadReport }>;
  returned?: Array<{ thread: Thread; run: ThreadRun; report: ThreadReport }>;
  wakeParents?: ThreadParent[];
  write?: boolean;
}

const LIFECYCLES = new Set<ThreadLifecycle>(["queued", "active", "settled", "archived"]);
const ATTENTIONS = new Set<ThreadAttention>([
  "none",
  "user",
  "permission",
  "thread",
  "experiment",
  "followup",
  "stalled",
  "looping",
]);
const INTEGRATIONS = new Set<ThreadIntegration>(["none", "dirty", "merge-ready", "conflict", "merged"]);
const WORKTREE_PREPARATION_STAGES = new Set<NonNullable<ThreadWorktree["preparationStage"]>>([
  "capturing-baseline",
  "materialize",
  "materializing",
  "setup",
  "ready",
]);
const MATERIALIZATION_SWITCH_STAGES = new Set<NonNullable<ThreadWorktree["materializationSwitch"]>["stage"]>([
  "staging-ready",
  "live-backed-up",
  "staging-promoted",
]);
const MATERIALIZATION_HANDOFF_STAGES = new Set<NonNullable<ThreadWorktree["materializationHandoff"]>["stage"]>([
  "intent-persisted",
  "kernel-materialized",
  "git-attached",
]);

const isBaselineUpdate = (value: unknown): value is NonNullable<ThreadWorktree["baselineUpdate"]> => (
  isRecord(value)
  && ["operationId", "stageBranchId", "parentBranchId", "originalRoot", "originalBaseRoot", "plannedRoot"]
    .every((key) => isString(value[key]) && value[key].length > 0)
  && Number.isSafeInteger(value.parentResultRevision) && Number(value.parentResultRevision) > 0
  && Number.isSafeInteger(value.expectedWriteRevision) && Number(value.expectedWriteRevision) >= 0
  && (value.phase === "prepared" || value.phase === "committed")
  && ["updatedFromParent", "keptChildPaths", "mergedPaths"].every((key) => Array.isArray(value[key]) && value[key].every(isString))
  && Array.isArray(value.conflicts) && value.conflicts.every((entry) => isRecord(entry) && isString(entry.path)
    && (entry.reason === undefined || isString(entry.reason)))
);

const isMaterializationHandoff = (value: unknown): value is NonNullable<ThreadWorktree["materializationHandoff"]> => (
  isRecord(value)
  && isString(value.operationId) && value.operationId.length > 0
  && isString(value.pinId) && value.pinId.length > 0
  && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
  && Number.isSafeInteger(value.writeRevision) && Number(value.writeRevision) >= 0
  && isString(value.root) && value.root.length > 0
  && (value.view === "current" || value.view === "revision")
  && (value.nextPreparationStage === "setup" || value.nextPreparationStage === "ready")
  && MATERIALIZATION_HANDOFF_STAGES.has(value.stage as NonNullable<ThreadWorktree["materializationHandoff"]>["stage"])
  && (value.gitKind === undefined || value.gitKind === "worktree" || value.gitKind === "init" || value.gitKind === "none")
  && (value.executionBaseline === undefined || isString(value.executionBaseline))
  && (value.stage !== "git-attached" || value.gitKind === "worktree" || value.gitKind === "init" || value.gitKind === "none")
);

const isMaterializationSwitch = (value: unknown): value is NonNullable<ThreadWorktree["materializationSwitch"]> => (
  isRecord(value)
  && Number.isSafeInteger(value.revision)
  && Number(value.revision) >= 0
  && Number.isSafeInteger(value.writeRevision)
  && Number(value.writeRevision) >= 0
  && isString(value.root)
  && value.root.length > 0
  && isString(value.stagingPath)
  && isString(value.backupPath)
  && MATERIALIZATION_SWITCH_STAGES.has(value.stage as NonNullable<ThreadWorktree["materializationSwitch"]>["stage"])
);

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
);

const isReviewOf = (value: unknown): value is ThreadReviewOf => (
  isRecord(value)
  && isString(value.sourceThreadId)
  && Number.isSafeInteger(value.resultRevision)
  && Number(value.resultRevision) > 0
);

const isVerificationCommand = (value: unknown): boolean => (
  isRecord(value)
  && isString(value.command)
  && isString(value.cwd)
  && (value.exitCode === null || Number.isSafeInteger(value.exitCode))
  && typeof value.cancelled === "boolean"
  && (value.relation === "same-run-before-publish" || value.relation === "unbound" || value.relation === "uncertain")
  && (value.inputChanged === null || typeof value.inputChanged === "boolean")
  && (value.outputHandle === undefined || isString(value.outputHandle))
);

const isChildChecks = (value: unknown): boolean => (
  value === null
  || (isRecord(value)
    && Number.isSafeInteger(value.resultRevision)
    && Number(value.resultRevision) > 0
    && (value.binding === "bound" || value.binding === "uncertain")
    && (value.bindingReason === undefined || isString(value.bindingReason))
    && Array.isArray(value.commands)
    && value.commands.every(isVerificationCommand)
    && (value.allExitedZero === null || typeof value.allExitedZero === "boolean"))
);

const isParentChecks = (value: unknown): boolean => (
  value === null
  || (isRecord(value)
    && Number.isSafeInteger(value.mergedResultRevision)
    && Number(value.mergedResultRevision) > 0
    && typeof value.draftUnsaved === "boolean"
    && (value.binding === "bound" || value.binding === "uncertain"
      || value.binding === "cannot-verify-unsaved-draft" || value.binding === "not-recorded")
    && (value.note === undefined || isString(value.note))
    && Array.isArray(value.commands)
    && value.commands.every(isVerificationCommand)
    && (value.allExitedZero === null || typeof value.allExitedZero === "boolean"))
);

const isReviewProjection = (value: unknown): boolean => (
  value === null
  || (isRecord(value)
    && Number.isSafeInteger(value.resultRevision)
    && Number(value.resultRevision) > 0
    && (value.status === "none" || value.status === "running" || value.status === "completed"
      || value.status === "failed" || value.status === "cancelled")
    && (value.reviewThreadId === undefined || isString(value.reviewThreadId))
    && (value.reviewRunId === undefined || isString(value.reviewRunId))
    && (value.conclusion === undefined || isString(value.conclusion))
    && (value.error === undefined || isString(value.error))
    && (value.findings === undefined || (Array.isArray(value.findings) && value.findings.every((finding) => (
      isRecord(finding) && isString(finding.severity) && isString(finding.message)
      && (finding.file === undefined || isString(finding.file))
      && (finding.line === undefined || Number.isSafeInteger(finding.line))
    )))))
);

const isVerificationProjection = (value: unknown): value is ThreadVerificationProjection => (
  isRecord(value)
  && (value.currentResultRevision === undefined
    || (Number.isSafeInteger(value.currentResultRevision) && Number(value.currentResultRevision) > 0))
  && isChildChecks(value.childChecks)
  && isParentChecks(value.parentChecks)
  && isReviewProjection(value.review)
);

const isIntegrationBinding = (value: unknown): value is ThreadIntegrationBinding => (
  isRecord(value)
  && isString(value.operationId)
  && Number.isSafeInteger(value.resultRevision)
  && Number(value.resultRevision) > 0
  && isString(value.bindingFingerprint)
  && typeof value.valid === "boolean"
  && typeof value.mergeReady === "boolean"
  && isStringArray(value.conflictPaths)
  && isStringArray(value.surfaceTargetPaths)
  && isStringArray(value.unavailablePaths)
);
const WORKER_STATES = new Set<ThreadRun["workerState"]>(["starting", "running", "lost", "exited"]);
const OUTCOMES = new Set<ThreadRunOutcome>(["success", "failure", "cancelled", "lost"]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
);
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isParent = (value: unknown): value is ThreadParent => (
  isRecord(value)
  && (value.kind === "session" || value.kind === "thread")
  && isString(value.id)
  && value.id.length > 0
);

const isTokens = (value: unknown): value is ThreadTokens => (
  isRecord(value)
  && isFiniteNumber(value.input)
  && isFiniteNumber(value.output)
  && isFiniteNumber(value.cacheRead)
);

const isWaitingFor = (value: unknown): value is ThreadWaitingFor | null => (
  value === null
  || (isRecord(value)
    && (value.kind === "user" || value.kind === "permission" || value.kind === "thread" || value.kind === "experiment" || value.kind === "followup")
      && isString(value.text))
);

const isMessagePeer = (value: unknown): value is ThreadMessagePeer => (
  isRecord(value)
  && (value.kind === "session" || value.kind === "thread" || value.kind === "user")
  && isString(value.id)
);

const isMessageRecord = (value: unknown): value is ThreadMessageRecord => (
  isRecord(value)
  && isString(value.id)
  && (value.direction === "in" || value.direction === "out")
  && isMessagePeer(value.from)
  && isMessagePeer(value.to)
  && (value.kind === "inform" || value.kind === "request")
  && isString(value.text)
  && (value.context === undefined || (value.kind === "request" && (value.context === "continue" || value.context === "fresh")))
  && (value.replyTo === undefined || isString(value.replyTo))
  && (value.status === "pending" || value.status === "held" || value.status === "delivered" || value.status === "resolved" || value.status === "failed")
  && (value.failure === undefined || isString(value.failure))
  && (value.runId === undefined || isString(value.runId))
  && isString(value.at)
);

const isPendingContinuation = (value: unknown): value is ThreadPendingContinuation => (
  isRecord(value)
  && (value.preparedInput === undefined || isString(value.preparedInput))
  && (value.sourceRunId === undefined || isString(value.sourceRunId))
  && (value.frozen === undefined || isFrozenRunConfig(value.frozen))
  && (value.mode === "continue" || value.mode === "fresh")
  && isString(value.task)
  && isString(value.requestId) && value.requestId.length > 0
  && isMessagePeer(value.from)
  && isString(value.at)
);

const isDiffStats = (value: unknown): value is ThreadDiffStats | null => (
  value === null
  || (isRecord(value)
    && isFiniteNumber(value.files)
    && isFiniteNumber(value.insertions)
    && isFiniteNumber(value.deletions))
);

const isTranscriptRef = (value: unknown): value is ThreadReport["transcriptRef"] => (
  isRecord(value)
  && isString(value.runtimeId)
  && isString(value.sessionId)
  && isNullableString(value.fromEntryId)
  && isNullableString(value.toEntryId)
  && (value.branchLeafId === undefined || isString(value.branchLeafId))
);

const FACT_STATUSES = new Set(["source-checked", "unknown", "unavailable"]);
const EVIDENCE_COMPLETIONS = new Set(["delivered", "incomplete", "cancelled", "unavailable"]);
const SOURCE_CHECKS = new Set(["source-valid", "unavailable", "unknown"]);
const ATTEMPT_OUTCOMES = new Set(["rejected", "unavailable", "empty", "failed"]);
const SOURCE_KINDS = new Set(["local", "url", "output"]);
const SOURCE_ORIGINS = new Set(["disk", "surface-draft", "working-branch"]);

const isOutputRef = (value: unknown): value is RetrievalFactSource["outputRef"] => (
  isRecord(value)
  && value.durability === "ephemeral"
  && isString(value.generation)
  && isString(value.handle)
);

const isArtifactRef = (value: unknown): value is NonNullable<RetrievalFactSource["artifact"]> => (
  isRecord(value)
  && value.durability === "durable"
  && isString(value.hash)
  && Number.isSafeInteger(value.byteLength)
  && isString(value.recordId)
  && (value.recordType === "retrieval.artifact" || value.recordType === "retrieval.receipt")
  && isString(value.workspaceId)
  && (value.sessionId === undefined || isString(value.sessionId))
  && (value.threadId === undefined || isString(value.threadId))
  && (value.runId === undefined || isString(value.runId))
);

const isFactSource = (value: unknown): value is RetrievalFactSource => (
  isRecord(value)
  && SOURCE_KINDS.has(value.kind as string)
  && (value.check === undefined || SOURCE_CHECKS.has(value.check as string))
  && (value.path === undefined || isString(value.path))
  && (value.startLine === undefined || Number.isSafeInteger(value.startLine))
  && (value.endLine === undefined || Number.isSafeInteger(value.endLine))
  && (value.revision === undefined || isString(value.revision))
  && (value.origin === undefined || SOURCE_ORIGINS.has(value.origin as string))
  && (value.contentHash === undefined || isString(value.contentHash))
  && (value.excerpt === undefined || isString(value.excerpt))
  && (value.artifact === undefined || isArtifactRef(value.artifact))
  && (value.url === undefined || isString(value.url))
  && (value.receiptId === undefined || isString(value.receiptId))
  && (value.outputRef === undefined || isOutputRef(value.outputRef))
);

const isFact = (value: unknown): value is RetrievalFact => (
  isRecord(value)
  && isString(value.claim)
  && FACT_STATUSES.has(value.status as string)
  && Array.isArray(value.sources)
  && value.sources.every(isFactSource)
);

const isAttempt = (value: unknown): value is RetrievalAttempt => (
  isRecord(value)
  && isString(value.action)
  && ATTEMPT_OUTCOMES.has(value.outcome as string)
  && (value.detail === undefined || isString(value.detail))
);

const isEvidence = (value: unknown): value is RetrievalEvidence => (
  isRecord(value)
  && isString(value.question)
  && Array.isArray(value.scope) && value.scope.every(isString)
  && Array.isArray(value.facts) && value.facts.every(isFact)
  && Array.isArray(value.unknowns) && value.unknowns.every(isString)
  && Array.isArray(value.attempted) && value.attempted.every(isAttempt)
  && EVIDENCE_COMPLETIONS.has(value.completion as string)
);

const isInheritedContext = (value: unknown): value is ThreadInheritedContext => (
  isRecord(value)
  && isString(value.fromSessionId)
  && isString(value.capturedAt)
  && isString(value.text)
  && Array.isArray(value.anchors) && value.anchors.every(isString)
  && (value.images === undefined || (Array.isArray(value.images)
    && value.images.every((image) => isRecord(image) && isString(image.data) && isString(image.mimeType))))
);


const isLaunchManifest = (value: unknown): value is ThreadLaunchManifest => (
  isRecord(value)
  && typeof value.carryBlocks === "boolean"
  && Number.isSafeInteger(value.concurrency) && Number(value.concurrency) > 0
  && (value.draftBaselineId === null || (isString(value.draftBaselineId) && value.draftBaselineId.length > 0))
  && (value.sourceViewId === undefined || (isString(value.sourceViewId) && value.sourceViewId.length > 0))
  && (value.inputOrigin === undefined || value.inputOrigin === "task" || value.inputOrigin === "inherit")
  && (value.inheritedContext === undefined || isInheritedContext(value.inheritedContext))
  && (value.initialAuthorityRoot === undefined || isString(value.initialAuthorityRoot))
  && Array.isArray(value.scope) && value.scope.every(isString)
  && isNullableString(value.systemPromptFragment)
  && isAgentModelSettings(value.modelSettings)
  && Array.isArray(value.tools) && value.tools.every(isString)
  && (value.workFocus === "code" || value.workFocus === "research")
  && (value.research === undefined || isResearchManifest(value.research))
  && (value.worktree === "none" || value.worktree === "shared" || value.worktree === "isolated")
  && (value.permissions === undefined || isRecord(value.permissions))
  && (value.promptText === undefined || isString(value.promptText))
);

const isResearchManifest = (value: unknown): value is ThreadResearchManifest => (
  isRecord(value)
  && isResearchCapability(value.capability)
  && isRecord(value.resources)
  && Object.entries(value.resources).every(([key, item]) => (
    (key === "cpu" || key === "gpu" || key === "network" || key === "longRunning")
      && typeof item === "boolean"
  ))
);

const isReport = (value: unknown): value is ThreadReport | null => (
  value === null
  || (isRecord(value)
    && isString(value.conclusion)
    && Array.isArray(value.changedFiles) && value.changedFiles.every(isString)
    && Array.isArray(value.unresolved) && value.unresolved.every(isString)
    && Array.isArray(value.deviations) && value.deviations.every(isString)
    && isFiniteNumber(value.confidence)
    && isTranscriptRef(value.transcriptRef)
    && (value.resultCommit === undefined || isString(value.resultCommit))
    && (value.resultRevision === undefined || (Number.isSafeInteger(value.resultRevision) && Number(value.resultRevision) > 0))
    && (value.evidenceRunId === undefined || isString(value.evidenceRunId))
    && isRecord(value.blocksSnapshot) && Object.values(value.blocksSnapshot).every(isString)
    && (value.evidence === undefined || isEvidence(value.evidence)))
);

const isDeletionState = (value: unknown): boolean => (
  isRecord(value)
  && isString(value.operationId)
  && isString(value.rootThreadId)
  && (value.phase === "sessions" || value.phase === "store" || value.phase === "directory" || value.phase === "registry")
  && isString(value.requestedAt)
  && isString(value.updatedAt)
  && (value.error === undefined || isString(value.error))
);

const isThread = (value: unknown): value is Thread => {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isParent(value.parent)
    && isString(value.workspaceId)
    && (value.forkPoint === null || (isRecord(value.forkPoint) && isString(value.forkPoint.entryId)))
    && isString(value.brief)
    && isNullableString(value.preset)
    && !("role" in value)
    && (value.model === null || (isRecord(value.model) && isString(value.model.providerId) && isString(value.model.modelId)))
    && isLaunchManifest(value.manifest)
    && (value.manifest.draftBaselineId === null || value.manifest.worktree === "isolated")
    && (value.createdBy === "user" || value.createdBy === "agent")
    && (value.kind === "discussion" || value.kind === "implementation")
    && (value.purpose === "task" || value.purpose === "research-root" || value.purpose === "bot-root")
    && (value.worktree === null || (isRecord(value.worktree)
      && isString(value.worktree.path)
      && (value.worktree.managedRoot === undefined || isString(value.worktree.managedRoot))
      && (value.worktree.readOnlyInput === undefined || typeof value.worktree.readOnlyInput === "boolean")
      && isString(value.worktree.base)
      && (value.worktree.executionBaseline === undefined || isString(value.worktree.executionBaseline))
      && (value.worktree.branch === undefined || isString(value.worktree.branch))
      && (value.worktree.resultCommit === undefined || isString(value.worktree.resultCommit))
      && (value.worktree.resultPath === undefined || isString(value.worktree.resultPath))
      && (value.worktree.materialized === undefined || typeof value.worktree.materialized === "boolean")
      && (value.worktree.viewMode === undefined || value.worktree.viewMode === "virtual" || value.worktree.viewMode === "materialized")
      && (value.worktree.materializationSwitch === undefined || isMaterializationSwitch(value.worktree.materializationSwitch))
      && (value.worktree.materializationHandoff === undefined || isMaterializationHandoff(value.worktree.materializationHandoff))
      && (value.worktree.baselineUpdate === undefined || isBaselineUpdate(value.worktree.baselineUpdate))
      && (value.worktree.preparationStage === undefined
        || WORKTREE_PREPARATION_STAGES.has(value.worktree.preparationStage as NonNullable<ThreadWorktree["preparationStage"]>))
      && (value.worktree.materializationFingerprint === undefined || isString(value.worktree.materializationFingerprint))
      && (value.worktree.retentionReason === undefined || isString(value.worktree.retentionReason))))
    && (value.workBranchId === undefined || isString(value.workBranchId))
    && (value.resultRevision === undefined || (Number.isSafeInteger(value.resultRevision) && Number(value.resultRevision) > 0))
    && LIFECYCLES.has(value.lifecycle as ThreadLifecycle)
    && ATTENTIONS.has(value.attention as ThreadAttention)
    && isWaitingFor(value.waitingFor)
    && INTEGRATIONS.has(value.integration as ThreadIntegration)
    && isDiffStats(value.diffStats)
    && isReport(value.report)
    && (value.pendingEvidence === undefined || isEvidence(value.pendingEvidence))
    && (value.mergedCommit === undefined || isString(value.mergedCommit))
    && (value.mergedResultRevision === undefined || (Number.isSafeInteger(value.mergedResultRevision) && Number(value.mergedResultRevision) > 0))
    && (value.integrationBinding === undefined || isIntegrationBinding(value.integrationBinding))
    && (value.verification === undefined || isVerificationProjection(value.verification))
    && (value.reviewOf === undefined || isReviewOf(value.reviewOf))
    && (value.consultBotId === undefined || isString(value.consultBotId))
    && (value.messages === undefined || (Array.isArray(value.messages) && value.messages.every(isMessageRecord)))
    && !("pendingContinuation" in value)
    && (value.pendingContinuations === undefined || (Array.isArray(value.pendingContinuations) && value.pendingContinuations.every(isPendingContinuation)))
    && isNullableString(value.activeRunId)
    && isString(value.createdAt)
    && isString(value.updatedAt)
    && Number.isSafeInteger(value.eventSeq)
    && typeof value.hidden === "boolean"
    && (value.keepWorktree === undefined || typeof value.keepWorktree === "boolean")
    && (value.deletion === undefined || isDeletionState(value.deletion));
};

const isAgentModelSettings = (value: unknown): boolean => {
  if (value === undefined) return true;
  try { parseHarnessAgentModelSettings(value); return true; } catch { return false; }
};

const isFrozenRunConfig = (value: unknown): value is NonNullable<ThreadRun["frozen"]> => (
  isRecord(value)
  && (value.model === null || (isRecord(value.model) && isString(value.model.providerId) && isString(value.model.modelId)))
  && Array.isArray(value.tools) && value.tools.every(isString)
  && (value.permissions === undefined || isRecord(value.permissions))
  && Array.isArray(value.scope) && value.scope.every(isString)
  && (value.worktree === "none" || value.worktree === "shared" || value.worktree === "isolated")
  && isNullableString(value.systemPromptFragment)
  && isAgentModelSettings(value.modelSettings)
  && (value.inputOrigin === "task" || value.inputOrigin === "inherit" || value.inputOrigin === "continue" || value.inputOrigin === "fresh")
  && (value.workFocus === "code" || value.workFocus === "research")
  && (value.research === undefined || isResearchManifest(value.research))
);

const isThreadRun = (value: unknown): value is ThreadRun => {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.threadId)
    && Number.isSafeInteger(value.attempt)
    && Number(value.attempt) > 0
    && isString(value.runtimeId)
    && isNullableString(value.sessionId)
    && (value.sessionOwner === "spawned-child" || value.sessionOwner === "attached-root")
    && (value.inputRevision === undefined || (Number.isSafeInteger(value.inputRevision) && Number(value.inputRevision) > 0))
    && isFrozenRunConfig(value.frozen)
    && (value.report === undefined || (value.report !== null && isReport(value.report)))
    && (value.request === undefined || isPendingContinuation(value.request))
    && (value.executionYielded === undefined || typeof value.executionYielded === "boolean")
    && WORKER_STATES.has(value.workerState as ThreadRun["workerState"])
    && (value.outcome === null || OUTCOMES.has(value.outcome as ThreadRunOutcome))
    && isNullableString(value.exitReason)
    && isTokens(value.tokens)
    && (value.costUsd === null || isFiniteNumber(value.costUsd))
    && Number.isSafeInteger(value.steps)
    && (value.lastToolCall === null
      || (isRecord(value.lastToolCall) && isString(value.lastToolCall.name) && isString(value.lastToolCall.at)))
    && isString(value.startedAt)
    && isString(value.lastActivityAt)
    && isNullableString(value.endedAt);
};

const parentEquals = (left: ThreadParent, right: ThreadParent): boolean => (
  left.kind === right.kind && left.id === right.id
);

const scopeKey = (scopeId: string, parent: ThreadParent): string => (
  `${scopeId}\0${parent.kind}\0${parent.id}`
);

const workspaceFileName = (scopeId: string): string => (
  `${createHash("sha256").update(scopeId).digest("hex")}.json`
);

export const threadCatalogPath = (dataDir: string, hostId: string, scopeId: string): string => (
  join(dataDir, "threads", hostId, workspaceFileName(scopeId))
);

export const threadSessionBindingsPath = (dataDir: string, hostId: string): string => (
  join(dataDir, "threads", hostId, "session-bindings.json")
);

const SESSION_BINDINGS_FILE_NAME = "session-bindings.json";

const isThreadCatalogFileName = (name: string): boolean => (
  name.endsWith(".json") && name !== SESSION_BINDINGS_FILE_NAME
);

const SESSION_BINDINGS_SCHEMA_VERSION = 2;

interface ThreadSessionBindingsDocument {
  schemaVersion: typeof SESSION_BINDINGS_SCHEMA_VERSION;
  bindings: ThreadSessionBinding[];
}

const emptyCatalog = (scopeId: string): ThreadCatalogDocument => ({
  schemaVersion: THREAD_REGISTRY_SCHEMA_VERSION,
  scopeId,
  threads: [],
  runs: [],
});

const catalogMaxEventSeq = (catalog: ThreadCatalogDocument): number => (
  catalog.threads.reduce((maximum, thread) => Math.max(maximum, thread.eventSeq), 0)
);

const parseJson = (raw: string, path: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ThreadRegistryError("corrupt", `Thread registry JSON is malformed: ${path}`, path, { cause: error });
  }
};

const normalizeThreadWorktree = (worktree: ThreadWorktree): ThreadWorktree => (
  worktree.preparationStage
    ? structuredClone(worktree)
    : {
        ...structuredClone(worktree),
        preparationStage: worktree.materialized === false ? "materialize" : "ready",
      }
);

const normalizeWorktreePreparation = (thread: Thread): Thread => {
  if (!thread.worktree || thread.worktree.preparationStage) return thread;
  return {
    ...thread,
    worktree: normalizeThreadWorktree(thread.worktree),
  };
};

const parseCatalog = (raw: string, path: string, expectedScopeId?: string): ThreadCatalogDocument => {
  const value = parseJson(raw, path);
  if (!isRecord(value)) {
    throw new ThreadRegistryError("corrupt", `Thread registry catalog must be an object: ${path}`, path);
  }
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion)) {
    throw new ThreadRegistryError("corrupt", `Thread registry schemaVersion is missing or invalid: ${path}`, path);
  }
  if (schemaVersion > THREAD_REGISTRY_SCHEMA_VERSION) {
    throw new ThreadRegistryError(
      "future-schema",
      `Thread registry schema ${schemaVersion} is newer than supported schema ${THREAD_REGISTRY_SCHEMA_VERSION}: ${path}`,
      path,
    );
  }
  if (schemaVersion !== THREAD_REGISTRY_SCHEMA_VERSION) {
    throw new ThreadRegistryError("corrupt", `Unsupported thread registry schema ${schemaVersion}: ${path}`, path);
  }
  // Catalogs written before the scope rename carry `workspaceId` for the same
  // shard identity; accept it once and normalize to `scopeId`.
  const catalogScopeId = isString(value.scopeId) && value.scopeId.length > 0
    ? value.scopeId
    : isString(value.workspaceId) && value.workspaceId.length > 0
      ? value.workspaceId
      : null;
  if (!catalogScopeId || !Array.isArray(value.threads) || !Array.isArray(value.runs)) {
    throw new ThreadRegistryError("corrupt", `Thread registry catalog shape is invalid: ${path}`, path);
  }
  if (expectedScopeId !== undefined && catalogScopeId !== expectedScopeId) {
    throw new ThreadRegistryError("corrupt", `Thread registry scope identity does not match its catalog: ${path}`, path);
  }
  if (!value.runs.every(isThreadRun)) {
    throw new ThreadRegistryError("corrupt", `Thread registry contains malformed run records: ${path}`, path);
  }
  if (!value.threads.every(isThread)) {
    throw new ThreadRegistryError("corrupt", `Thread registry contains malformed thread records: ${path}`, path);
  }
  const current = value as unknown as ThreadCatalogDocument;
  const catalog: ThreadCatalogDocument = {
    schemaVersion: THREAD_REGISTRY_SCHEMA_VERSION,
    scopeId: catalogScopeId,
    runs: structuredClone(current.runs),
    threads: current.threads.map((thread) => normalizeWorktreePreparation(structuredClone(thread))),
  };
  const threadIds = new Set<string>();
  for (const thread of catalog.threads) {
    if (thread.workspaceId !== catalog.scopeId || threadIds.has(thread.id)) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains duplicate or cross-workspace threads: ${path}`, path);
    }
    threadIds.add(thread.id);
  }
  const runsById = new Map<string, ThreadRun>();
  const attempts = new Set<string>();
  for (const run of catalog.runs) {
    const attemptKey = `${run.threadId}\0${run.attempt}`;
    if (!threadIds.has(run.threadId) || runsById.has(run.id) || attempts.has(attemptKey)) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains orphaned or duplicate runs: ${path}`, path);
    }
    runsById.set(run.id, run);
    attempts.add(attemptKey);
  }
  for (const thread of catalog.threads) {
    const activeRun = thread.activeRunId === null
      ? null
      : runsById.get(thread.activeRunId) ?? null;
    if (thread.activeRunId !== null && (!activeRun || activeRun.threadId !== thread.id)) {
      throw new ThreadRegistryError("corrupt", `Thread registry thread points to a missing active run: ${path}`, path);
    }
    if (
      ((thread.attention === "user" || thread.attention === "permission" || thread.attention === "thread" || thread.attention === "experiment" || thread.attention === "followup") && thread.waitingFor === null)
      || (thread.waitingFor !== null && thread.attention !== thread.waitingFor.kind)
    ) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains inconsistent attention state: ${path}`, path);
    }
  }
  for (const run of catalog.runs) {
    const active = run.workerState === "starting" || run.workerState === "running";
    const terminal = run.workerState === "lost" || run.workerState === "exited";
    if (
      (active && (run.outcome !== null || run.endedAt !== null))
      || (terminal && (run.outcome === null || run.endedAt === null))
      || (run.workerState === "lost" && run.outcome !== "lost")
      || (run.workerState === "exited" && run.outcome === "lost")
    ) {
      throw new ThreadRegistryError("corrupt", `Thread registry contains inconsistent run state: ${path}`, path);
    }
  }
  return structuredClone(catalog);
};

export function createThreadRegistry(options: ThreadRegistryOptions) {
  const { dataDir, hostId } = options;
  const fsPromises = options.fsPromises ?? fs.promises;
  const now = options.now ?? (() => new Date());
  const maxConcurrency = options.maxConcurrency ?? 12;
  const cache = new Map<string, ThreadCatalogDocument>();
  const readIndexes = new WeakMap<ThreadCatalogDocument, ThreadCatalogReadIndex>();
  const loads = new Map<string, Promise<ThreadCatalogDocument>>();
  let hostCatalogLoad: Promise<void> | null = null;

  const readIndexFor = (catalog: ThreadCatalogDocument): ThreadCatalogReadIndex | null => {
    // Mutations use a private mutable draft. Index only published generations:
    // a failed write cannot publish entries, and a successful write replaces
    // the catalog identity rather than mutating references retained by readers.
    if (cache.get(catalog.scopeId) !== catalog) return null;
    const existing = readIndexes.get(catalog);
    if (existing) return existing;
    const index: ThreadCatalogReadIndex = {
      threadsById: new Map(catalog.threads.map((thread) => [thread.id, thread])),
      runsById: new Map(),
      runsByThreadId: new Map(),
      latestRunBySessionId: new Map(),
    };
    for (const run of catalog.runs) {
      index.runsById.set(run.id, run);
      const threadRuns = index.runsByThreadId.get(run.threadId);
      if (threadRuns) threadRuns.push(run);
      else index.runsByThreadId.set(run.threadId, [run]);
      if (run.sessionId) {
        const previous = index.latestRunBySessionId.get(run.sessionId);
        // Preserve catalog order on equal timestamps, as the original scan did.
        if (!previous || run.startedAt.localeCompare(previous.startedAt) > 0) {
          index.latestRunBySessionId.set(run.sessionId, run);
        }
      }
    }
    readIndexes.set(catalog, index);
    return index;
  };
  const mutationTails = new Map<string, Promise<void>>();
  const cursors = new Map<string, ThreadViewCursor>();
  const cursorEpochs = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();
  const admissionWaiters = new Map<string, Set<() => void>>();
  let disposed = false;
  const draining = new Set<string>();
  const retiredParents = new Set<string>();
  const dequeueing = new Set<string>();
  // Lifecycle cascade admission is owned by the registry so dispatch/create
  // cannot race a runtime-local kill/archive snapshot.
  const cascadingThreads = new Set<string>();
  let persistCounter = 0;
  const sessionBindings = new Map<string, ThreadSessionBinding>();
  // Session bindings are the active-owner index.  Keep the historical set in
  // memory as a tombstone index so an old child session cannot fall through to
  // the root-session path after restart.
  const historicalSessionIds = new Set<string>();
  const staleBindingIds = new Set<string>();
  let sessionBindingsLoaded = false;
  let sessionBindingsLoad: Promise<void> | null = null;
  let sessionBindingTail = Promise.resolve();

  const nowISO = (): string => now().toISOString();

  const readText = async (path: string): Promise<string | null> => {
    try {
      return await fsPromises.readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ThreadRegistryError("read-failed", `Unable to read thread registry: ${path}`, path, { cause: error });
    }
  };

  const loadWorkspace = async (scopeId: string): Promise<ThreadCatalogDocument> => {
    const cached = cache.get(scopeId);
    if (cached) return cached;
    const pending = loads.get(scopeId);
    if (pending) return pending;
    const path = threadCatalogPath(dataDir, hostId, scopeId);
    const loading = (async () => {
      const raw = await readText(path);
      const catalog = raw === null ? emptyCatalog(scopeId) : parseCatalog(raw, path, scopeId);
      cache.set(scopeId, catalog);
      return catalog;
    })();
    loads.set(scopeId, loading);
    try {
      return await loading;
    } finally {
      loads.delete(scopeId);
    }
  };

  const parseSessionBindings = (raw: string, path: string): ThreadSessionBinding[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ThreadRegistryError("corrupt", `Thread session bindings are not valid JSON: ${path}`, path, { cause: error });
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== SESSION_BINDINGS_SCHEMA_VERSION || !Array.isArray(parsed.bindings)) {
      throw new ThreadRegistryError("corrupt", `Thread session bindings are not a recognized document: ${path}`, path);
    }
    const bindings: ThreadSessionBinding[] = [];
    for (const entry of parsed.bindings) {
      if (
        !isRecord(entry)
        || !isString(entry.sessionId) || entry.sessionId.length === 0
        || !(isString(entry.owningScopeId) && entry.owningScopeId.length > 0)
          && !(isString(entry.owningWorkspaceId) && entry.owningWorkspaceId.length > 0)
        || !isString(entry.threadId) || entry.threadId.length === 0
        || !isString(entry.runId) || entry.runId.length === 0
        || !isParent(entry.parent)
        || (entry.owner !== "spawned-child" && entry.owner !== "attached-root")
      ) {
        throw new ThreadRegistryError("corrupt", `Thread session binding is invalid: ${path}`, path);
      }
      // Records written before the scope rename carry `owningWorkspaceId`.
      const owningScopeId = isString(entry.owningScopeId) && entry.owningScopeId.length > 0
        ? entry.owningScopeId
        : entry.owningWorkspaceId as string;
      bindings.push({
        sessionId: entry.sessionId,
        owningScopeId,
        threadId: entry.threadId,
        runId: entry.runId,
        parent: entry.parent,
        owner: entry.owner,
      });
    }
    return bindings;
  };

  const ensureSessionBindings = async (): Promise<void> => {
    if (sessionBindingsLoaded) return;
    if (!sessionBindingsLoad) {
      sessionBindingsLoad = (async () => {
        const path = threadSessionBindingsPath(dataDir, hostId);
        let persistedBindings: ThreadSessionBinding[] = [];
        // Catalogs are authoritative.  A corrupt/missing derived index is
        // rebuilt from the healthy catalogs and atomically overwritten.
        try {
          const raw = await readText(path);
          if (raw !== null) {
            persistedBindings = parseSessionBindings(raw, path);
          }
        } catch {
          sessionBindings.clear();
        }
        await loadHostCatalogs();
        historicalSessionIds.clear();
        for (const catalog of cache.values()) {
          for (const run of catalog.runs) {
            if (run.sessionId && run.sessionOwner === "spawned-child") historicalSessionIds.add(run.sessionId);
          }
        }
        const derived = derivedBindingsFromCatalogs();
        sessionBindings.clear();
        for (const [sessionId, binding] of derived) sessionBindings.set(sessionId, structuredClone(binding));
        staleBindingIds.clear();
        for (const binding of persistedBindings) {
          const current = derived.get(binding.sessionId);
          // An attached root is an index over a user-owned session, not a child
          // session tombstone. Startup reconciliation deliberately marks its
          // interrupted Run lost and drops the index without poisoning that
          // user session for a later reopen.
          if (binding.owner === "spawned-child" && (!current || !sameBinding(current, binding))) {
            staleBindingIds.add(binding.sessionId);
          }
        }
        await persistSessionBindings();
        sessionBindingsLoaded = true;
      })();
    }
    await sessionBindingsLoad;
  };

  const persistSessionBindings = async (): Promise<void> => {
    const path = threadSessionBindingsPath(dataDir, hostId);
    const directory = join(dataDir, "threads", hostId);
    persistCounter += 1;
    const temporary = `${path}.${process.pid}.${persistCounter}.tmp`;
    const document: ThreadSessionBindingsDocument = {
      schemaVersion: SESSION_BINDINGS_SCHEMA_VERSION,
      bindings: [...sessionBindings.values()],
    };
    try {
      await fsPromises.mkdir(directory, { recursive: true });
      await fsPromises.writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
      await fsPromises.rename(temporary, path);
    } catch (error) {
      await fsPromises.rm(temporary, { force: true }).catch(() => undefined);
      throw new ThreadRegistryError("write-failed", `Unable to persist thread session bindings: ${path}`, path, { cause: error });
    }
  };

  const mutateSessionBindings = async (mutate: () => void): Promise<void> => {
    const previous = sessionBindingTail;
    const operation = previous.then(async () => {
      await ensureSessionBindings();
      mutate();
      await persistSessionBindings();
    });
    sessionBindingTail = operation.then(() => undefined, () => undefined);
    await operation;
  };

  const bindRunSession = async (binding: ThreadSessionBinding): Promise<ThreadSessionBinding> => {
    await mutateSessionBindings(() => {
      for (const [sessionId, existing] of sessionBindings) {
        if (existing.threadId === binding.threadId || sessionId === binding.sessionId) {
          sessionBindings.delete(sessionId);
          if (sessionId !== binding.sessionId && existing.owner === "spawned-child") historicalSessionIds.add(sessionId);
        }
      }
      historicalSessionIds.delete(binding.sessionId);
      staleBindingIds.delete(binding.sessionId);
      sessionBindings.set(binding.sessionId, structuredClone(binding));
    });
    return structuredClone(binding);
  };

  const unbindRunSession = async (
    sessionId: string,
    options: { retainHistorical?: boolean } = {},
  ): Promise<void> => {
    await mutateSessionBindings(() => {
      const existing = sessionBindings.get(sessionId);
      sessionBindings.delete(sessionId);
      const retainHistorical = options.retainHistorical ?? existing?.owner === "spawned-child";
      if (retainHistorical) historicalSessionIds.add(sessionId);
      else historicalSessionIds.delete(sessionId);
    });
  };

  const sameBinding = (left: ThreadSessionBinding, right: ThreadSessionBinding): boolean => (
    left.sessionId === right.sessionId
    && left.owningScopeId === right.owningScopeId
    && left.threadId === right.threadId
    && left.runId === right.runId
    && left.owner === right.owner
    && parentEquals(left.parent, right.parent)
  );

  const bindingRank = (run: ThreadRun): number => {
    if (run.workerState === "running" || run.workerState === "starting") return 3;
    if (run.workerState === "lost") return 2;
    return 1;
  };

  const bindingFromRun = (catalog: ThreadCatalogDocument, run: ThreadRun): ThreadSessionBinding | null => {
    if (!run.sessionId) return null;
    const thread = findThread(catalog, run.threadId);
    if (!thread || thread.activeRunId !== run.id || thread.lifecycle === "archived"
      || (run.outcome !== null && run.outcome !== "lost")
      || (run.sessionOwner === "attached-root" && run.outcome === "lost")
      || (run.workerState !== "starting" && run.workerState !== "running" && run.workerState !== "lost")) return null;
    return {
      sessionId: run.sessionId,
      owningScopeId: catalog.scopeId,
      threadId: run.threadId,
      runId: run.id,
      parent: thread.parent,
      owner: run.sessionOwner,
    };
  };

  const bindingMatchesCatalog = (binding: ThreadSessionBinding, catalog: ThreadCatalogDocument): boolean => {
    if (catalog.scopeId !== binding.owningScopeId) return false;
    const thread = findThread(catalog, binding.threadId);
    const run = findRun(catalog, binding.runId);
    return !!thread
      && !!run
      && run.threadId === binding.threadId
      && thread.activeRunId === run.id
      && (run.outcome === null || run.outcome === "lost")
      && (run.workerState === "starting" || run.workerState === "running" || run.workerState === "lost")
      && run.sessionId === binding.sessionId
      && run.sessionOwner === binding.owner
      && parentEquals(thread.parent, binding.parent);
  };

  const readExistingCatalog = async (scopeId: string): Promise<ThreadCatalogDocument | null> => {
    if (cache.has(scopeId)) return cache.get(scopeId)!;
    const path = threadCatalogPath(dataDir, hostId, scopeId);
    const raw = await readText(path);
    if (raw === null) return null;
    return loadWorkspace(scopeId);
  };

  const loadHostCatalogs = async (): Promise<void> => {
    if (hostCatalogLoad) return hostCatalogLoad;
    const loading = (async () => {
      const directory = join(dataDir, "threads", hostId);
      let entries: fs.Dirent<string>[];
      try {
        entries = await fsPromises.readdir(directory, { withFileTypes: true, encoding: "utf8" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new ThreadRegistryError("read-failed", `Unable to enumerate thread registries: ${directory}`, directory, { cause: error });
      }
      const cachedPaths = new Set([...cache.keys()].map((scopeId) => threadCatalogPath(dataDir, hostId, scopeId)));
      for (const entry of entries) {
        if (!entry.isFile() || !isThreadCatalogFileName(entry.name)) continue;
        const path = join(directory, entry.name);
        // The live Host is the catalog writer. Discovery has always kept an
        // already-loaded generation; do not read/parse a replacement only to
        // discard it. New paths are still discovered on each directory scan,
        // and explicit restart reconciliation independently rereads every file.
        if (cachedPaths.has(path)) continue;
        try {
          const raw = await readText(path);
          if (raw === null) continue;
          const parsed = parseJson(raw, path);
          if (Array.isArray(parsed)) continue;
          const catalog = parseCatalog(raw, path);
          if (threadCatalogPath(dataDir, hostId, catalog.scopeId) !== path) continue;
          if (!cache.has(catalog.scopeId)) cache.set(catalog.scopeId, catalog);
        } catch {
          // One malformed workspace catalog must not hide healthy workspace
          // roots or prevent rebuilding the derived session index. Failed
          // discoveries are not cached, so a repaired file can be retried.
        }
      }
    })();
    hostCatalogLoad = loading;
    try {
      await loading;
    } finally {
      if (hostCatalogLoad === loading) hostCatalogLoad = null;
    }
  };

  const derivedBindingsFromCatalogs = (): Map<string, ThreadSessionBinding> => {
    const candidates: Array<{ binding: ThreadSessionBinding; rank: number; startedAt: string }> = [];
    for (const catalog of cache.values()) {
      for (const run of catalog.runs) {
        const derived = bindingFromRun(catalog, run);
        if (!derived) continue;
        const rank = bindingRank(run);
        candidates.push({ binding: derived, rank, startedAt: run.startedAt });
      }
    }
    candidates.sort((left, right) => right.rank - left.rank
      || right.startedAt.localeCompare(left.startedAt)
      || left.binding.sessionId.localeCompare(right.binding.sessionId)
      || left.binding.threadId.localeCompare(right.binding.threadId));
    const next = new Map<string, ThreadSessionBinding>();
    const threads = new Set<string>();
    for (const candidate of candidates) {
      if (next.has(candidate.binding.sessionId) || threads.has(candidate.binding.threadId)) continue;
      next.set(candidate.binding.sessionId, candidate.binding);
      threads.add(candidate.binding.threadId);
    }
    return next;
  };

  const rebuildSessionBindingsFromCatalogs = async (): Promise<void> => {
    await ensureSessionBindings();
    const next = derivedBindingsFromCatalogs();
    let changed = next.size !== sessionBindings.size;
    if (!changed) {
      for (const [sessionId, binding] of next) {
        const current = sessionBindings.get(sessionId);
        if (!current || !sameBinding(current, binding)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    await mutateSessionBindings(() => {
      sessionBindings.clear();
      for (const [sessionId, binding] of next) sessionBindings.set(sessionId, structuredClone(binding));
    });
  };

  /**
   * RR4/E07: durable owner resolution. `getSessionBinding` only answers for
   * an active Run; a settled child session or a restarted Host loses that
   * binding even though the owning workspace is still a fact recorded in the
   * catalog. Knowledge/todo ownership needs the durable answer: active
   * binding first, then any catalog run record carrying this sessionId —
   * never a UI-snapshot guess.
   */
  const resolveSessionOwner = async (
    sessionId: string,
  ): Promise<Pick<ThreadSessionBinding, "owningScopeId" | "threadId" | "runId" | "owner"> | null> => {
    await ensureSessionBindings();
    const existing = sessionBindings.get(sessionId);
    if (existing) {
      const catalog = await readExistingCatalog(existing.owningScopeId);
      if (catalog && bindingMatchesCatalog(existing, catalog)) {
        return {
          owningScopeId: existing.owningScopeId,
          threadId: existing.threadId,
          runId: existing.runId,
          owner: existing.owner,
        };
      }
    }
    // Refresh the catalog view so workspaces created after startup are seen.
    await loadHostCatalogs();
    let best: { scopeId: string; run: ThreadRun } | null = null;
    for (const catalog of cache.values()) {
      const run = readIndexFor(catalog)!.latestRunBySessionId.get(sessionId);
      if (run && (!best || run.startedAt.localeCompare(best.run.startedAt) > 0)) {
        best = { scopeId: catalog.scopeId, run };
      }
    }
    return best
      ? {
        owningScopeId: best.scopeId,
        threadId: best.run.threadId,
        runId: best.run.id,
        owner: best.run.sessionOwner === "attached-root" ? "attached-root" : "spawned-child",
      }
      : null;
  };

  const getSessionBinding = async (sessionId: string): Promise<ThreadSessionBinding | null> => {
    await ensureSessionBindings();
    const existing = sessionBindings.get(sessionId);
    if (existing) {
      const catalog = await readExistingCatalog(existing.owningScopeId);
      if (catalog && bindingMatchesCatalog(existing, catalog)) return structuredClone(existing);
    }
    if (staleBindingIds.has(sessionId)) {
      await mutateSessionBindings(() => {
        staleBindingIds.delete(sessionId);
      });
      throw new ThreadRegistryError(
        "stale-binding",
        `Thread session binding does not match the catalog: ${sessionId}`,
        threadSessionBindingsPath(dataDir, hostId),
      );
    }
    if (existing) {
      await mutateSessionBindings(() => {
        sessionBindings.delete(sessionId);
      });
      throw new ThreadRegistryError(
        "stale-binding",
        `Thread session binding does not match the catalog: ${sessionId}`,
        threadSessionBindingsPath(dataDir, hostId),
      );
    }
    if (historicalSessionIds.has(sessionId)) {
      throw new ThreadRegistryError(
        "stale-binding",
        `Thread session binding is no longer the current owner: ${sessionId}`,
        threadSessionBindingsPath(dataDir, hostId),
      );
    }
    return null;
  };

  const writeCatalog = async (catalog: ThreadCatalogDocument): Promise<void> => {
    const path = threadCatalogPath(dataDir, hostId, catalog.scopeId);
    const directory = join(dataDir, "threads", hostId);
    persistCounter += 1;
    const temporary = `${path}.${process.pid}.${persistCounter}.tmp`;
    try {
      await fsPromises.mkdir(directory, { recursive: true });
      await fsPromises.writeFile(temporary, JSON.stringify(catalog, null, 2), "utf8");
      await fsPromises.rename(temporary, path);
    } catch (error) {
      await fsPromises.rm(temporary, { force: true }).catch(() => undefined);
      throw new ThreadRegistryError("write-failed", `Unable to persist thread registry: ${path}`, path, { cause: error });
    }
  };

  const findRun = (catalog: ThreadCatalogDocument, runId: string): ThreadRun | null => {
    const index = readIndexFor(catalog);
    return (index ? index.runsById.get(runId) : catalog.runs.find((run) => run.id === runId)) ?? null;
  };

  const activeRunFor = (catalog: ThreadCatalogDocument, thread: Thread): ThreadRun | null => (
    thread.activeRunId === null ? null : findRun(catalog, thread.activeRunId)
  );

  const reportObserverError = (error: unknown): void => {
    try { options.onObserverError?.(error); } catch { /* Observers cannot break registry authority. */ }
  };

  const emitChanges = (catalog: ThreadCatalogDocument, mutation: MutationResult<unknown>): void => {
    for (const thread of mutation.changed) {
      try {
        // A notification already knows its changed Thread; do not build a full
        // read index after every progress write merely to find this one Run.
        options.onThreadChanged?.(catalog.scopeId, thread.parent, structuredClone(thread), structuredClone(
          thread.activeRunId === null ? null : catalog.runs.find((run) => run.id === thread.activeRunId) ?? null,
        ));
      } catch (error) {
        reportObserverError(error);
      }
      const done = mutation.done?.find((entry) => entry.thread.id === thread.id);
      if (done) {
        try {
          options.onThreadDone?.(catalog.scopeId, thread.parent, thread.id, structuredClone(done.report));
        } catch (error) {
          reportObserverError(error);
        }
      }
      const returned = mutation.returned?.find((entry) => entry.thread.id === thread.id);
      if (returned) {
        try {
          options.onThreadReturned?.(catalog.scopeId, thread.parent, thread.id, structuredClone(returned.run), structuredClone(returned.report));
        } catch (error) {
          reportObserverError(error);
        }
      }
      const callbacks = waiters.get(scopeKey(catalog.scopeId, thread.parent));
      if (callbacks) {
        for (const callback of callbacks) {
          try { callback(); } catch (error) { reportObserverError(error); }
        }
        callbacks.clear();
      }
    }
    for (const parent of mutation.wakeParents ?? []) {
      const callbacks = waiters.get(scopeKey(catalog.scopeId, parent));
      if (!callbacks) continue;
      for (const callback of callbacks) {
        try { callback(); } catch (error) { reportObserverError(error); }
      }
      callbacks.clear();
    }
  };

  const mutateWorkspace = async <T>(
    scopeId: string,
    mutate: (catalog: ThreadCatalogDocument) => MutationResult<T> | Promise<MutationResult<T>>,
  ): Promise<T> => {
    const previous = mutationTails.get(scopeId) ?? Promise.resolve();
    let value!: T;
    const operation = previous.then(async () => {
      const current = await loadWorkspace(scopeId);
      const draft = structuredClone(current);
      const mutation = await mutate(draft);
      value = mutation.value;
      if (mutation.write !== false) {
        await writeCatalog(draft);
        cache.set(scopeId, draft);
        emitChanges(draft, mutation);
        if (mutation.changed.length > 0) {
          const listeners = admissionWaiters.get(scopeId);
          if (listeners) {
            for (const listener of [...listeners]) listener();
            listeners.clear();
          }
        }
      }
    });
    mutationTails.set(scopeId, operation.then(() => undefined, () => undefined));
    await operation;
    return structuredClone(value);
  };

  const nextEventSeq = (catalog: ThreadCatalogDocument): number => catalogMaxEventSeq(catalog) + 1;

  const catalogForScope = async (scopeId: string, _parent: ThreadParent): Promise<ThreadCatalogDocument> => {
    return loadWorkspace(scopeId);
  };

  const findThread = (catalog: ThreadCatalogDocument, threadId: string): Thread | null => {
    const index = readIndexFor(catalog);
    return (index ? index.threadsById.get(threadId) : catalog.threads.find((thread) => thread.id === threadId)) ?? null;
  };

  const findThreadInScope = (catalog: ThreadCatalogDocument, parent: ThreadParent, threadId: string): Thread | null => {
    const thread = findThread(catalog, threadId);
    return thread && parentEquals(thread.parent, parent) ? thread : null;
  };

  const cascadeBlocksParent = (scopeId: string, catalog: ThreadCatalogDocument, parent: ThreadParent): boolean => {
    let current: ThreadParent | null = parent;
    while (current?.kind === "thread") {
      if (cascadingThreads.has(scopeKey(scopeId, current))) return true;
      const ancestor = findThread(catalog, current.id);
      if (!ancestor) return false;
      if (ancestor.lifecycle === "archived" || ancestor.deletion) return true;
      current = ancestor.parent;
    }
    return false;
  };

  const cascadeBlocksThread = (scopeId: string, catalog: ThreadCatalogDocument, thread: Thread): boolean => (
    cascadingThreads.has(scopeKey(scopeId, { kind: "thread", id: thread.id }))
      || thread.deletion !== undefined
      || cascadeBlocksParent(scopeId, catalog, thread.parent)
  );

  const beginCascade = async (scopeId: string, threadId: string): Promise<() => void> => {
    const key = scopeKey(scopeId, { kind: "thread", id: threadId });
    // Enter the fence through the workspace mutation tail.  Any create/start
    // queued after this operation observes the fence synchronously inside its
    // own catalog mutation.
    await mutateWorkspace(scopeId, (catalog) => {
      if (!findThread(catalog, threadId)) throw new Error(`Unknown thread: ${threadId}`);
      if (cascadingThreads.has(key)) throw new Error(`Thread cascade is already active: ${threadId}`);
      cascadingThreads.add(key);
      return { value: undefined, changed: [], write: false };
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      cascadingThreads.delete(key);
    };
  };

  const touchThread = (catalog: ThreadCatalogDocument, thread: Thread): void => {
    thread.updatedAt = nowISO();
    thread.eventSeq = nextEventSeq(catalog);
  };

  const assertScopeExecution = async (scopeId: string): Promise<void> => {
    if (options.canExecuteScope && !await options.canExecuteScope(scopeId)) {
      throw new Error("This Bot is asleep or changing state; wake it before starting work");
    }
  };

  const createThread = async (input: CreateThreadInput): Promise<Thread> => {
    if (input.draftBaselineId !== undefined && (!input.draftBaselineId || input.worktree !== "isolated")) {
      throw new Error("A Thread draft baseline requires a non-empty id and an isolated worktree");
    }
    const key = scopeKey(input.scopeId, input.parent);
    if (draining.has(key) || retiredParents.has(key)) {
      throw new Error("Cannot create a thread while its parent is being deleted");
    }
    return mutateWorkspace(input.scopeId, async (catalog) => {
      await assertScopeExecution(input.scopeId);
      if (draining.has(key) || retiredParents.has(key) || cascadeBlocksParent(input.scopeId, catalog, input.parent)) {
        throw new Error("Cannot create a thread while its parent is archived or being cascaded");
      }
      const timestamp = nowISO();
      const inheritedWorkFocus = input.parent.kind === "thread"
        ? findThread(catalog, input.parent.id)?.manifest.workFocus
        : undefined;
      const inheritedResearch = input.parent.kind === "thread"
        ? findThread(catalog, input.parent.id)?.manifest.research
        : undefined;
      const inheritedEnvironment = input.parent.kind === "thread"
        ? findThread(catalog, input.parent.id)?.environment
        : undefined;
      const environment = input.environment === undefined ? inheritedEnvironment
        : { ...inheritedEnvironment, ...input.environment };
      const thread: Thread = {
        id: `thread-${randomUUID().slice(0, 8)}`,
        parent: structuredClone(input.parent),
        workspaceId: input.scopeId,
        forkPoint: input.forkPoint ?? null,
        brief: input.brief,
        preset: input.preset ?? null,
        model: input.model ?? null,
        manifest: {
          ...(input.modelSettings === undefined ? {} : { modelSettings: parseHarnessAgentModelSettings(input.modelSettings) }),
          carryBlocks: input.carryBlocks ?? true,
          concurrency: input.concurrency,
          draftBaselineId: input.draftBaselineId ?? null,
          ...(input.sourceViewId ? { sourceViewId: input.sourceViewId } : {}),
          ...(input.inputOrigin !== undefined ? { inputOrigin: input.inputOrigin } : {}),
          ...(input.inheritedContext !== undefined ? { inheritedContext: structuredClone(input.inheritedContext) } : {}),
          ...(input.initialAuthorityRoot !== undefined ? { initialAuthorityRoot: input.initialAuthorityRoot } : {}),
          scope: [...(input.scope ?? [])].map(normalizeThreadScopePath),
          systemPromptFragment: input.systemPromptFragment ?? null,
          tools: [...new Set(input.tools)],
          workFocus: input.workFocus ?? inheritedWorkFocus ?? "code",
          ...(input.research === undefined
            ? inheritedResearch === undefined ? {} : { research: structuredClone(inheritedResearch) }
            : { research: structuredClone(input.research) }),
          worktree: input.worktree,
          permissions: normalizeFrozenHarnessPermissions(input.permissions),
          ...(input.promptText !== undefined ? { promptText: input.promptText } : {}),
        },
        createdBy: input.createdBy,
        kind: input.kind,
        purpose: input.purpose ?? "task",
        worktree: null,
        lifecycle: input.autoRun ? "queued" : "active",
        attention: "none",
        waitingFor: null,
        integration: "none",
        diffStats: null,
        report: null,
        activeRunId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        eventSeq: nextEventSeq(catalog),
        hidden: input.hidden ?? false,
        ...(input.consultBotId ? { consultBotId: input.consultBotId } : {}),
        ...(environment && (environment.workTarget !== undefined || environment.desktopId !== undefined)
          ? { environment: { ...environment, updatedAt: timestamp } }
          : {}),
      };
      catalog.threads.push(thread);
      return { value: thread, changed: [thread] };
    });
  };

  const assertDispatchAllowed = async (scopeId: string, threadId: string): Promise<void> => {
    await mutateWorkspace(scopeId, async (catalog) => {
      await assertScopeExecution(scopeId);
      const thread = findThread(catalog, threadId);
      if (!thread) throw new Error(`Unknown thread: ${threadId}`);
      if (thread.lifecycle === "archived" || thread.lifecycle === "settled" || cascadeBlocksThread(scopeId, catalog, thread)) {
        throw new Error(`Cannot dispatch while the thread or an ancestor is settled, archived, or being cascaded: ${threadId}`);
      }
      return { value: undefined, changed: [], write: false };
    });
  };

  const getThread = async (scopeId: string, parent: ThreadParent, threadId: string): Promise<Thread | null> => {
    const catalog = await catalogForScope(scopeId, parent);
    return structuredClone(findThreadInScope(catalog, parent, threadId));
  };

  const updateThreadBrief = async (
    scopeId: string,
    threadId: string,
    brief: string,
  ): Promise<Thread | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    const normalized = brief.trim();
    if (!normalized || thread.brief === normalized) {
      return { value: thread, changed: [], write: false };
    }
    thread.brief = normalized;
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  /**
   * Rebind a Thread's execution environment (EE stage 1). This is a placement
   * default for operations admitted after the write; accepted operations keep
   * the target snapshot they were pinned with. The registry records the
   * intent only — target verification lives in the environment service.
   */
  const setThreadEnvironment = async (
    scopeId: string,
    threadId: string,
    patch: { workTarget?: string | null; desktopId?: string | null },
  ): Promise<{ environment: ThreadEnvironment | null; previous: ThreadEnvironment | null }> => (
    mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) throw new Error(`Unknown thread: ${threadId}`);
      const previous = thread.environment ? structuredClone(thread.environment) : null;
      const next: ThreadEnvironment = { updatedAt: nowISO() };
      const resolveField = (value: string | null | undefined, old: string | undefined): string | undefined => (
        value === undefined ? old : (value === null ? undefined : value)
      );
      const workTarget = resolveField(patch.workTarget, previous?.workTarget);
      const desktopId = resolveField(patch.desktopId, previous?.desktopId);
      if (workTarget !== undefined) next.workTarget = workTarget;
      if (desktopId !== undefined) next.desktopId = desktopId;
      if (workTarget === undefined && desktopId === undefined) delete thread.environment;
      else thread.environment = next;
      touchThread(catalog, thread);
      return {
        value: { environment: thread.environment ? structuredClone(thread.environment) : null, previous },
        changed: [thread],
      };
    })
  );

  /**
   * Durable environment resolution for a session: binding → owning Thread →
   * its placement record. Returns null when the session carries no Thread.
   */
  const threadEnvironmentForSession = async (
    sessionId: string,
  ): Promise<{ threadId: string; environment: ThreadEnvironment | null } | null> => {
    const owner = await resolveSessionOwner(sessionId);
    if (!owner) return null;
    const catalog = await readExistingCatalog(owner.owningScopeId);
    const thread = catalog ? findThread(catalog, owner.threadId) : null;
    if (!thread) throw new ThreadRegistryError("stale-binding", "Environment binding does not match a catalog Thread", owner.owningScopeId);
    return { threadId: thread.id, environment: thread.environment ? structuredClone(thread.environment) : null };
  };

  const listWorkspaceThreads = async (scopeId: string): Promise<Thread[]> => {
    const catalog = await loadWorkspace(scopeId);
    return structuredClone(catalog.threads);
  };

  const listWorkspaceThreadSnapshots = async (scopeId: string): Promise<Array<{ thread: Thread; activeRun: ThreadRun | null }>> => {
    const catalog = await loadWorkspace(scopeId);
    return structuredClone(catalog.threads.map((thread) => ({ thread, activeRun: activeRunFor(catalog, thread) })));
  };

  const listWorkspaceRunSessionIds = async (scopeId: string): Promise<string[]> => {
    const catalog = await loadWorkspace(scopeId);
    return [...new Set(catalog.runs.flatMap((run) => run.sessionId ? [run.sessionId] : []))];
  };

  /**
   * The caller already holds the owning storage lease. Keep release validation
   * and its metadata commit ahead of subsequent Run/review mutations. The
   * callback must not call Registry methods or wait for another storage lease;
   * object-file collection happens after it returns.
   */
  const withThreadRetentionSnapshot = async <T>(
    scopeId: string,
    operation: (snapshots: Array<{ thread: Thread; activeRun: ThreadRun | null }>) => Promise<T>,
  ): Promise<T> => {
    const previous = mutationTails.get(scopeId) ?? Promise.resolve();
    const task = previous.then(async () => {
      const catalog = await loadWorkspace(scopeId);
      return operation(structuredClone(catalog.threads.map((thread) => ({ thread, activeRun: activeRunFor(catalog, thread) }))));
    });
    mutationTails.set(scopeId, task.then(() => undefined, () => undefined));
    return task;
  };

  const listWorkspaceIds = async (): Promise<string[]> => {
    await loadHostCatalogs();
    return [...cache.keys()].sort();
  };

  const listThreads = async (scopeId: string, parent: ThreadParent, includeHidden = false): Promise<Thread[]> => {
    const catalog = await catalogForScope(scopeId, parent);
    return structuredClone(catalog.threads.filter((thread) => (
      parentEquals(thread.parent, parent) && (includeHidden || !thread.hidden)
    )));
  };

  const listThreadSnapshots = async (
    scopeId: string,
    parent: ThreadParent,
    includeHidden = false,
  ): Promise<Array<{ thread: Thread; activeRun: ThreadRun | null }>> => {
    const catalog = await catalogForScope(scopeId, parent);
    return structuredClone(catalog.threads
      .filter((thread) => parentEquals(thread.parent, parent) && (includeHidden || !thread.hidden))
      .map((thread) => ({ thread, activeRun: activeRunFor(catalog, thread) })));
  };

  const getActiveRun = async (scopeId: string, threadId: string): Promise<ThreadRun | null> => {
    const catalog = await loadWorkspace(scopeId);
    const thread = findThread(catalog, threadId);
    return structuredClone(thread ? activeRunFor(catalog, thread) : null);
  };

  const listRuns = async (scopeId: string, threadId: string): Promise<ThreadRun[]> => {
    const catalog = await loadWorkspace(scopeId);
    const index = readIndexFor(catalog);
    const runs = index ? index.runsByThreadId.get(threadId) ?? [] : catalog.runs.filter((run) => run.threadId === threadId);
    return structuredClone(runs.toSorted((a, b) => a.attempt - b.attempt));
  };

  const getThreadById = async (scopeId: string, threadId: string): Promise<Thread | null> => {
    const catalog = await loadWorkspace(scopeId);
    return structuredClone(findThread(catalog, threadId));
  };

  const getThreadSnapshot = async (scopeId: string, threadId: string): Promise<{ thread: Thread; activeRun: ThreadRun | null } | null> => {
    const catalog = await loadWorkspace(scopeId);
    const thread = findThread(catalog, threadId);
    return thread ? structuredClone({ thread, activeRun: activeRunFor(catalog, thread) }) : null;
  };

  const getThreadForSession = async (scopeId: string, sessionId: string): Promise<Thread | null> => {
    const catalog = await loadWorkspace(scopeId);
    for (const thread of catalog.threads) {
      const run = activeRunFor(catalog, thread);
      if (!run || run.sessionId !== sessionId || !bindingFromRun(catalog, run)) continue;
      return structuredClone(thread);
    }
    return null;
  };

  /**
   * Root session id for a Thread parent scope — the ancestor chain's session.
   * The shared execution budget is accounted per root task, so nested
   * dispatch cannot multiply it by parent level (3.18C).
   */
  const rootSessionFor = (catalog: ThreadCatalogDocument, parent: ThreadParent): string | null => {
    const seen = new Set<string>();
    let current = parent;
    while (current.kind === "thread") {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      const owner = findThread(catalog, current.id);
      if (!owner) return null;
      current = owner.parent;
    }
    return current.id;
  };

  const countActiveInCatalog = (catalog: ThreadCatalogDocument, root: string | null): number => {
    if (root === null) return 0;
    return catalog.threads.filter((thread) => {
      // User discussion threads keep an idle worker attached between messages;
      // they are not delegated model work and must not permanently occupy the
      // parent's implementation concurrency slots.
      if (thread.kind !== "implementation" || thread.lifecycle !== "active") return false;
      // A Thread waiting on a requested answer relinquishes its model
      // execution slot while it waits; sessions,
      // processes, writers, and worktrees stay occupied regardless.
      const run = activeRunFor(catalog, thread);
      if (run?.executionYielded === true) return false;
      if (run?.workerState !== "starting" && run?.workerState !== "running") return false;
      return rootSessionFor(catalog, thread.parent) === root;
    }).length;
  };

  /**
   * Active Runs consuming the root task's shared execution budget (3.18C).
   * Every admission decision — dispatch, dequeue, lost-run resume,
   * continuation, review — must go through this count.
   */
  const countActiveInRoot = async (scopeId: string, parent: ThreadParent): Promise<number> => {
    const catalog = await catalogForScope(scopeId, parent);
    return countActiveInCatalog(catalog, rootSessionFor(catalog, parent));
  };

  const assertRootAdmission = (catalog: ThreadCatalogDocument, thread: Thread): void => {
    const root = rootSessionFor(catalog, thread.parent);
    if (root === null) throw new Error(`Thread has no valid root task: ${thread.id}`);
    if (countActiveInCatalog(catalog, root) >= thread.manifest.concurrency) {
      throw new ThreadAdmissionError(root, thread.manifest.concurrency);
    }
  };

  /** Only an actually blocked tool may release a model slot; attention is presentation. */
  const yieldExecutionSlot = async (
    scopeId: string, threadId: string, runId: string, waitingFor: ThreadWaitingFor,
  ): Promise<Thread | null> => {
    const updated = await mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      const run = thread ? activeRunFor(catalog, thread) : null;
      if (!thread || !run || run.id !== runId || thread.lifecycle !== "active"
        || (run.workerState !== "starting" && run.workerState !== "running")) {
        return { value: null, changed: [], write: false };
      }
      if (waitingFor.kind !== "thread" && waitingFor.kind !== "experiment") {
        throw new Error("Execution yield requires a real thread or experiment dependency");
      }
      run.executionYielded = true;
      if (thread.attention === "none") {
        thread.attention = waitingFor.kind;
        thread.waitingFor = waitingFor;
      }
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    });
    if (updated) void tryDequeue(scopeId, updated.parent).catch(reportObserverError);
    return updated;
  };

  /** Reacquisition and clearing the yield are one catalog transaction. */
  const awaitExecutionSlot = async (
    scopeId: string, threadId: string, runId: string, signal: AbortSignal,
  ): Promise<void> => {
    while (true) {
      signal.throwIfAborted();
      if (disposed) throw new Error("Thread registry disposed while awaiting execution admission");
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => { wake = resolve; });
      let listeners = admissionWaiters.get(scopeId);
      if (!listeners) { listeners = new Set(); admissionWaiters.set(scopeId, listeners); }
      listeners.add(wake);
      signal.addEventListener("abort", wake, { once: true });
      try {
        const admitted = await mutateWorkspace(scopeId, (catalog) => {
          signal.throwIfAborted();
          if (disposed) throw new Error("Thread registry is disposed");
          const thread = findThread(catalog, threadId);
          const run = thread ? activeRunFor(catalog, thread) : null;
          if (!thread || !run || run.id !== runId || thread.lifecycle !== "active"
            || (run.workerState !== "starting" && run.workerState !== "running")) {
            throw new Error("The Run awaiting execution admission is no longer active");
          }
          if (!run.executionYielded) return { value: true, changed: [], write: false };
          const root = rootSessionFor(catalog, thread.parent);
          if (root === null) throw new Error("The waiting Run has no root task");
          if (countActiveInCatalog(catalog, root) >= thread.manifest.concurrency) {
            return { value: false, changed: [], write: false };
          }
          run.executionYielded = false;
          if (thread.waitingFor?.kind === "thread" || thread.waitingFor?.kind === "experiment") {
            thread.attention = "none";
            thread.waitingFor = null;
          }
          touchThread(catalog, thread);
          return { value: true, changed: [thread] };
        });
        if (admitted) return;
        await changed;
      } finally {
        listeners.delete(wake);
        if (listeners.size === 0) admissionWaiters.delete(scopeId);
        signal.removeEventListener("abort", wake);
      }
    }
  };

  const admitRun = async (
    scopeId: string,
    threadId: string,
    runtimeId = "pi",
    options: {
      allowSettled?: boolean;
      frozen?: ThreadRun["frozen"];
      inputOrigin?: ThreadRunInputOrigin;
      request?: ThreadPendingContinuation;
      sessionOwner?: ThreadSessionOwner;
    } = {},
  ): Promise<{ run: ThreadRun; started: boolean }> => (
    mutateWorkspace<{ run: ThreadRun; started: boolean }>(scopeId, async (catalog) => {
      await assertScopeExecution(scopeId);
      const thread = findThread(catalog, threadId);
      if (!thread) throw new Error(`Unknown thread: ${threadId}`);
      const parentKey = scopeKey(scopeId, thread.parent);
      if (draining.has(parentKey) || retiredParents.has(parentKey) || cascadeBlocksThread(scopeId, catalog, thread)) {
        throw new Error("Cannot start a thread while its parent is archived or being cascaded");
      }
      if (options.request) {
        const previous = catalog.runs.find((run) => run.threadId === threadId && run.request?.requestId === options.request!.requestId);
        const parked = (thread.pendingContinuations ?? []).find((request) => request.requestId === options.request!.requestId);
        const prior = previous?.request ?? parked;
        if (prior) {
          if (prior.task !== options.request.task || prior.mode !== options.request.mode
            || prior.from.kind !== options.request.from.kind || prior.from.id !== options.request.from.id
            || !sameFrozenRunConfig(prior.frozen, options.request.frozen)) {
            throw new Error("Continuation identity is already bound to different input");
          }
          if (previous) return { value: { run: previous, started: false }, changed: [], write: false };
        }
      }
      const current = activeRunFor(catalog, thread);
      if (current?.workerState === "starting" || current?.workerState === "running") {
        throw new Error(`Thread already has an active run: ${threadId}`);
      }
      if ((thread.lifecycle === "settled" && !options.allowSettled) || thread.lifecycle === "archived") {
        throw new Error(`Cannot start a run for ${thread.lifecycle} thread: ${threadId}`);
      }
      // Admission and the starting Run are one catalog mutation. A count
      // observed before async capture/open work is not a slot reservation.
      // Every producer (dispatch, dequeue, continuation, recovery, review)
      // reaches this same authority; none can overbook the last root slot.
      if (thread.kind === "implementation") {
        assertRootAdmission(catalog, thread);
      }
      const inputRevision = thread.resultRevision;
      const attempt = catalog.runs
        .filter((run) => run.threadId === threadId)
        .reduce((maximum, run) => Math.max(maximum, run.attempt), 0) + 1;
      const timestamp = nowISO();
      const run: ThreadRun = {
        id: `run-${randomUUID()}`,
        threadId,
        attempt,
        runtimeId,
        sessionId: null,
        sessionOwner: options.sessionOwner ?? "spawned-child",
        ...(inputRevision ? { inputRevision } : {}),
        // An explicit frozen override (same-Thread capability/model re-route)
        // is recorded verbatim except inputOrigin, which always reflects the
        // continuation mode actually admitted.
        frozen: options.frozen ? {
          ...structuredClone(options.frozen),
          inputOrigin: options.inputOrigin ?? options.frozen.inputOrigin,
        } : {
          model: structuredClone(thread.model),
          ...(thread.manifest.modelSettings === undefined ? {} : { modelSettings: { ...thread.manifest.modelSettings } }),
          tools: [...thread.manifest.tools],
          ...(thread.manifest.permissions ? { permissions: structuredClone(thread.manifest.permissions) } : {}),
          scope: [...thread.manifest.scope],
          worktree: thread.manifest.worktree,
          systemPromptFragment: thread.manifest.systemPromptFragment,
          inputOrigin: options.inputOrigin ?? thread.manifest.inputOrigin ?? "task",
          workFocus: thread.manifest.workFocus,
          ...(thread.manifest.research === undefined ? {} : { research: structuredClone(thread.manifest.research) }),
        },
        workerState: "starting",
        outcome: null,
        exitReason: null,
        tokens: { input: 0, output: 0, cacheRead: 0 },
        costUsd: null,
        steps: 0,
        lastToolCall: null,
        startedAt: timestamp,
        lastActivityAt: timestamp,
        endedAt: null,
      };
      if (options.request) {
        run.request = structuredClone(options.request);
        thread.pendingContinuations = (thread.pendingContinuations ?? []).filter((pending) => pending.requestId !== options.request!.requestId);
        if (thread.pendingContinuations.length === 0) delete thread.pendingContinuations;
        const incoming = thread.messages?.find((message) => message.direction === "in" && message.id === options.request!.requestId);
        if (incoming) incoming.runId = run.id;
      }
      catalog.runs.push(run);
      thread.activeRunId = run.id;
      thread.lifecycle = "active";
      // A dependency wait belongs to the preceding execution attempt. Leaving
      // it on a newly admitted Run would make that Run invisible to counting.
      if (thread.waitingFor?.kind === "thread" || thread.waitingFor?.kind === "experiment"
        || thread.waitingFor?.kind === "followup") {
        thread.attention = "none";
        thread.waitingFor = null;
      }
      // A result is the output of one completed Run, not a standing alias for
      // the Thread. Keep immutable historical revisions in WorkingState, while
      // removing the default pointer before this new attempt can fail outside
      // the normal settlement path.
      delete thread.resultRevision;
      delete thread.pendingEvidence;
      delete thread.integrationBinding;
      if (thread.verification) {
        delete thread.verification.currentResultRevision;
        thread.verification.childChecks = null;
        thread.verification.review = null;
      }
      touchThread(catalog, thread);
      return { value: { run, started: true }, changed: [thread] };
    })
  );

  const startRun = async (...args: Parameters<typeof admitRun>): Promise<ThreadRun> => (await admitRun(...args)).run;

  const markRunRunning = async (
    scopeId: string,
    threadId: string,
    runId: string,
    sessionId: string,
  ): Promise<ThreadRun> => {
    const run = await mutateWorkspace(scopeId, async (catalog) => {
      await assertScopeExecution(scopeId);
      const thread = findThread(catalog, threadId);
      const candidate = catalog.runs.find((entry) => entry.id === runId && entry.threadId === threadId);
      if (!thread || !candidate || thread.activeRunId !== runId) throw new Error(`Unknown active run: ${runId}`);
      if (candidate.workerState !== "starting" && candidate.workerState !== "running") {
        throw new Error(`Cannot mark ${candidate.workerState} run as running: ${runId}`);
      }
      candidate.workerState = "running";
      candidate.sessionId = sessionId;
      candidate.lastActivityAt = nowISO();
      touchThread(catalog, thread);
      return { value: { run: candidate, parent: thread.parent }, changed: [thread] };
    });
    await bindRunSession({
      sessionId,
      owningScopeId: scopeId,
      threadId,
      runId,
      parent: run.parent,
      owner: run.run.sessionOwner,
    });
    return structuredClone(run.run);
  };

  const maybeDequeue = async (scopeId: string, parent: ThreadParent): Promise<void> => {
    const key = scopeKey(scopeId, parent);
    if (draining.has(key)) return;
    await tryDequeue(scopeId, parent);
  };

  const endRun = async (
    scopeId: string,
    threadId: string,
    runId: string,
    outcome: ThreadRunOutcome,
    exitReason: string | null = null,
    report: ThreadReport | null = null,
  ): Promise<Thread> => {
    const result = await mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      const run = catalog.runs.find((candidate) => candidate.id === runId && candidate.threadId === threadId);
      if (!thread || !run || thread.activeRunId !== runId) throw new Error(`Unknown active run: ${runId}`);
      if (run.outcome !== null) {
        if (run.outcome !== outcome) throw new Error(`Run already ended as ${run.outcome}: ${runId}`);
        return { value: thread, changed: [], write: false };
      }
      run.workerState = outcome === "lost" ? "lost" : "exited";
      run.outcome = outcome;
      run.exitReason = exitReason;
      run.endedAt = nowISO();
      run.lastActivityAt = run.endedAt;
      thread.lifecycle = outcome === "lost" ? "active" : "settled";
      // Lost is not settlement. Keep pendingEvidence for Zone 2 until the
      // existing resume path starts a new Run, which clears it.
      if (thread.preset === "retrieval" && outcome !== "lost") {
        const evidence = sealRetrievalEvidence(thread.pendingEvidence, {
          brief: thread.brief,
          outcome,
        });
        delete thread.pendingEvidence;
        const fallbackConclusion = evidence
          ? summarizeRetrievalEvidence(evidence)
          : "Retrieval ended (" + outcome + ")" + (exitReason ? ": " + exitReason : " without an assistant report.");
        const runIssues = outcome !== "success" && exitReason ? [exitReason] : [];
        let sealed: ThreadReport;
        if (report) {
          const assistantReport = { ...report };
          delete assistantReport.evidence;
          delete assistantReport.evidenceRunId;
          sealed = {
            ...assistantReport,
            conclusion: report.conclusion.trim() ? report.conclusion : fallbackConclusion,
            changedFiles: [],
            deviations: [],
            unresolved: [...new Set([...report.unresolved, ...(evidence?.unknowns ?? []), ...runIssues])],
            ...(evidence ? { evidence, evidenceRunId: run.id } : {}),
          };
        } else {
          sealed = {
            conclusion: fallbackConclusion,
            changedFiles: [],
            unresolved: [...new Set([...(evidence?.unknowns ?? []), ...runIssues])],
            deviations: [],
            confidence: 0,
            transcriptRef: {
              runtimeId: run.runtimeId,
              sessionId: run.sessionId ?? "",
              fromEntryId: null,
              toEntryId: null,
            },
            blocksSnapshot: {},
            ...(evidence ? { evidence, evidenceRunId: run.id } : {}),
          };
        }
        thread.report = sealed;
        report = sealed;
      } else if (report) {
        thread.report = report;
        if (thread.integration === "none" && report.changedFiles.length > 0) thread.integration = "dirty";
      }
      if (report) run.report = structuredClone(report);
      touchThread(catalog, thread);
      return {
        value: thread,
        changed: [thread],
        ...(outcome === "success" && report ? { done: [{ thread, report }] } : {}),
        ...(outcome !== "lost" && report ? { returned: [{ thread, run, report }] } : {}),
      };
    });
    await maybeDequeue(scopeId, result.parent).catch(reportObserverError);
    return result;
  };

  const updateRunProgress = async (
    scopeId: string,
    threadId: string,
    progress: {
      steps?: number;
      tokens?: Partial<ThreadTokens>;
      lastToolCall?: { name: string; at: string };
      diffStats?: ThreadDiffStats;
      costUsd?: number;
    },
  ): Promise<Thread | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    const run = activeRunFor(catalog, thread);
    if (!run) throw new Error(`Thread has no active run: ${threadId}`);
    run.steps = progress.steps ?? run.steps;
    run.tokens = { ...run.tokens, ...(progress.tokens ?? {}) };
    run.lastToolCall = progress.lastToolCall ?? run.lastToolCall;
    run.costUsd = progress.costUsd ?? run.costUsd;
    run.lastActivityAt = nowISO();
    thread.diffStats = progress.diffStats ?? thread.diffStats;
    if (thread.diffStats && thread.diffStats.files > 0 && thread.integration === "none") thread.integration = "dirty";
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setAttention = async (
    scopeId: string,
    threadId: string,
    attention: ThreadAttention,
    waitingFor: ThreadWaitingFor | null = null,
  ): Promise<Thread | null> => {
    const updated = await mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) return { value: null, changed: [], write: false };
      if ((attention === "user" || attention === "permission" || attention === "thread" || attention === "experiment" || attention === "followup") && waitingFor === null) {
        throw new Error(`${attention} attention requires waitingFor details`);
      }
      if (waitingFor !== null && waitingFor.kind !== attention) {
        throw new Error(`${attention} attention does not match ${waitingFor.kind} waiting details`);
      }
      thread.attention = attention;
      thread.waitingFor = waitingFor;
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    });
    // Attention updates cannot grant or release an execution slot. Re-evaluate
    // queued work, but only yieldExecutionSlot changes a live Run's admission.
    if (updated && attention === "thread") {
      void tryDequeue(scopeId, updated.parent).catch(reportObserverError);
    }
    return updated;
  };

  // Message identities live as long as the Thread. A display window is not
  // permission to delete outstanding requests or durable retry receipts.
  const sameMessageIdentity = (left: Omit<ThreadMessageRecord, "direction">, right: Omit<ThreadMessageRecord, "direction">): boolean => (
    left.id === right.id && left.from.kind === right.from.kind && left.from.id === right.from.id
    && left.to.kind === right.to.kind && left.to.id === right.to.id
    && left.kind === right.kind && left.text === right.text && left.replyTo === right.replyTo
    && (left.kind !== "request" || (left.context ?? "continue") === (right.context ?? "continue"))
  );

  // Serializes the recipient's input boundary, not its model execution. The
  // durable ledger below, rather than this transient lock, owns retry state.
  const messageDeliveryTails = new Map<string, Promise<void>>();
  const withMessageDelivery = async <T>(scopeId: string, target: string, task: () => Promise<T>): Promise<T> => {
    const key = scopeId + "\0" + target;
    const previous = messageDeliveryTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    messageDeliveryTails.set(key, next);
    await previous;
    try {
      if (disposed) throw new Error("Thread registry disposed during message delivery");
      return await task();
    } finally {
      release();
      if (messageDeliveryTails.get(key) === next) messageDeliveryTails.delete(key);
    }
  };

  const threadMessagePeers = (catalog: ThreadCatalogDocument, message: Omit<ThreadMessageRecord, "direction">) => {
    const copies: Array<{ thread: Thread; direction: ThreadMessageRecord["direction"] }> = [];
    if (message.to.kind === "thread") {
      const target = findThread(catalog, message.to.id);
      if (!target) throw new Error(`Unknown message target: ${message.to.id}`);
      copies.push({ thread: target, direction: "in" });
    }
    if (message.from.kind === "thread") {
      const sender = findThread(catalog, message.from.id);
      if (sender) copies.push({ thread: sender, direction: "out" });
    }
    if (copies.length === 0) throw new Error("A directed Thread message requires a retained Thread ledger");
    return copies;
  };

  const equivalentRecipient = (left: ThreadMessageRecord["from"], right: ThreadMessageRecord["from"]) => (
    left.id === right.id && (left.kind === right.kind || (left.kind !== "thread" && right.kind !== "thread"))
  );
  const writeDirectedMessage = (catalog: ThreadCatalogDocument, message: Omit<ThreadMessageRecord, "direction">) => {
    const copies = threadMessagePeers(catalog, message);
    const prior = copies.map(({ thread, direction }) => thread.messages?.find((entry) => entry.direction === direction && entry.id === message.id)).filter((entry) => entry !== undefined);
    for (const entry of prior) {
      if (!sameMessageIdentity(entry, message)) throw new Error("requestId is already bound to a different message or sender");
      if (entry.runId && message.runId && entry.runId !== message.runId) throw new Error("A message cannot be rebound to a different execution Run");
    }
    const canonical = prior[0];
    const next = {
      ...message,
      ...(canonical ? { at: canonical.at } : {}),
      ...(canonical?.runId && !message.runId ? { runId: canonical.runId } : {}),
      ...(canonical?.status === "resolved" ? { status: "resolved" as const }
        : canonical?.status === "delivered" && (message.status === "pending" || message.status === "held") ? { status: "delivered" as const } : {}),
    };
    const changed = new Set<Thread>();
    let primary!: ThreadMessageRecord;
    for (const { thread, direction } of copies) {
      const entries = thread.messages ?? [];
      const index = entries.findIndex((entry) => entry.direction === direction && entry.id === next.id);
      const value = { ...structuredClone(next), direction };
      if (!primary) primary = value;
      if (index >= 0 && JSON.stringify(entries[index]) === JSON.stringify(value)) continue;
      if (index < 0) entries.push(value); else entries[index] = value;
      thread.messages = entries;
      changed.add(thread);
    }
    // A successful reply resolves both sides of precisely its original request.
    // Merely accepting a pending message does not satisfy a dependency.
    if (next.replyTo && (next.status === "delivered" || next.status === "resolved")) {
      for (const { thread } of copies) {
        for (const request of thread.messages ?? []) {
          if (request.id !== next.replyTo || request.kind !== "request" || request.status === "resolved"
            || !equivalentRecipient(request.to, next.from) || !equivalentRecipient(request.from, next.to)) continue;
          request.status = "resolved";
          changed.add(thread);
        }
      }
    }
    return { value: primary, changed: [...changed], write: changed.size > 0 };
  };

  /** Accept/acknowledge both ledgers in one durable catalog transaction. */
  const recordDirectedMessage = async (
    scopeId: string, message: Omit<ThreadMessageRecord, "direction">,
  ): Promise<ThreadMessageRecord> => mutateWorkspace(scopeId, (catalog) => {
    const result = writeDirectedMessage(catalog, message);
    for (const thread of result.changed) touchThread(catalog, thread);
    return result;
  });

  const recordThreadMessage = async (
    scopeId: string,
    threadId: string,
    message: ThreadMessageRecord,
  ): Promise<ThreadMessageRecord> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    const ledger = [...(thread.messages ?? [])];
    // Idempotent: a retry carrying the same requestId observes the recorded
    // outcome instead of duplicating delivery or execution.
    const existing = ledger.find((entry) => entry.direction === message.direction && entry.id === message.id);
    if (existing) {
      if (!sameMessageIdentity(existing, message)) throw new Error("requestId is already bound to a different message or sender");
      return { value: existing, changed: [], write: false };
    }
    ledger.push(structuredClone(message));
    thread.messages = ledger;
    touchThread(catalog, thread);
    return { value: message, changed: [thread] };
  });

  const patchThreadMessage = async (
    scopeId: string,
    threadId: string,
    messageId: string,
    patch: { status?: ThreadMessageRecord["status"]; runId?: string },
  ): Promise<ThreadMessageRecord | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    const entry = thread.messages?.find((message) => message.id === messageId);
    if (!entry) return { value: null, changed: [], write: false };
    if (patch.status !== undefined) entry.status = patch.status;
    if (patch.runId !== undefined) entry.runId = patch.runId;
    touchThread(catalog, thread);
    return { value: entry, changed: [thread] };
  });

  /** Patch both copies of an already-authorized directed-message receipt. */
  const patchDirectedMessage = async (
    scopeId: string,
    threadId: string,
    messageId: string,
    patch: { status?: ThreadMessageRecord["status"]; runId?: string },
  ): Promise<ThreadMessageRecord | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    const incoming = thread?.messages?.find((message) => message.direction === "in" && message.id === messageId);
    if (!incoming) return { value: null, changed: [], write: false };
    const next = {
      ...incoming,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.runId === undefined ? {} : { runId: patch.runId }),
    };
    const outcome = writeDirectedMessage(catalog, next);
    for (const entry of outcome.changed) touchThread(catalog, entry);
    return { value: next, changed: outcome.changed, write: outcome.write };
  });

  /** Read pending input without claiming the consumer has accepted it. */
  const listPendingThreadMessages = async (
    scopeId: string, threadId: string, excludeId?: string,
  ): Promise<ThreadMessageRecord[]> => {
    const catalog = await loadWorkspace(scopeId);
    const thread = findThread(catalog, threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    return structuredClone((thread.messages ?? []).filter((message) => (
      message.direction === "in" && message.id !== excludeId
      && !thread.pendingContinuations?.some((request) => request.requestId === message.id)
      && (message.status === "pending" || message.status === "held")
    )));
  };

  /** Both parties' receipts commit together, after actual input acceptance. */
  const acknowledgeThreadMessages = async (
    scopeId: string, threadId: string, ids: readonly string[], runId?: string,
  ): Promise<void> => {
    if (ids.length === 0) return;
    await mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) throw new Error(`Unknown thread: ${threadId}`);
      if (runId && !catalog.runs.some((run) => run.id === runId && run.threadId === threadId)) {
        throw new Error("Message receipt refers to an unrelated Run");
      }
      const changed = new Set<Thread>();
      for (const id of ids) {
        const incoming = thread.messages?.find((message) => message.direction === "in" && message.id === id);
        if (!incoming) throw new Error(`Unknown received message: ${id}`);
        const outcome = writeDirectedMessage(catalog, { ...incoming, status: "delivered", ...(runId ? { runId } : {}) });
        for (const entry of outcome.changed) changed.add(entry);
      }
      for (const entry of changed) touchThread(catalog, entry);
      return { value: undefined, changed: [...changed] };
    });
  };

  const failRunRequest = async (scopeId: string, threadId: string, runId: string, failure: string): Promise<void> => {
    await mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      const run = catalog.runs.find((entry) => entry.threadId === threadId && entry.id === runId);
      const message = thread?.messages?.find((entry) => entry.direction === "in" && entry.id === run?.request?.requestId);
      if (!message || message.status === "delivered" || message.status === "resolved") return { value: undefined, changed: [], write: false };
      const result = writeDirectedMessage(catalog, { ...message, status: "failed", failure, runId });
      for (const entry of result.changed) touchThread(catalog, entry);
      return { value: undefined, changed: result.changed, write: result.write };
    });
  };

  /** Queue every distinct request; no later caller may overwrite accepted work. */
  const enqueueContinuation = async (
    scopeId: string, threadId: string, continuation: ThreadPendingContinuation,
  ): Promise<Thread> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    const queue = thread.pendingContinuations ?? [];
    const prior = queue.find((entry) => entry.requestId === continuation.requestId)
      ?? catalog.runs.find((run) => run.threadId === threadId && run.request?.requestId === continuation.requestId)?.request;
    if (prior) {
      if (prior.task !== continuation.task || prior.mode !== continuation.mode
        || prior.from.kind !== continuation.from.kind || prior.from.id !== continuation.from.id
        || !sameFrozenRunConfig(prior.frozen, continuation.frozen)) {
        throw new Error("Continuation identity is already bound to different input");
      }
      return { value: thread, changed: [], write: false };
    }
    thread.pendingContinuations = [...queue, structuredClone(continuation)];
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setIntegration = async (
    scopeId: string,
    threadId: string,
    integration: ThreadIntegration,
    diffStats?: ThreadDiffStats | null,
    mergedCommit?: string | null,
    mergedResultRevision?: number | null,
  ): Promise<Thread | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    const nextMergedCommit = mergedCommit === undefined
      ? thread.mergedCommit
      : mergedCommit || undefined;
    const nextMergedResultRevision = mergedResultRevision === undefined
      ? thread.mergedResultRevision
      : mergedResultRevision || undefined;
    const clearsBinding = (integration === "merged" || integration === "none") && Boolean(thread.integrationBinding);
    if (thread.integration === integration
      && (diffStats === undefined || JSON.stringify(thread.diffStats) === JSON.stringify(diffStats))
      && nextMergedCommit === thread.mergedCommit
      && nextMergedResultRevision === thread.mergedResultRevision
      && !clearsBinding) {
      return { value: thread, changed: [], write: false };
    }
    thread.integration = integration;
    if (diffStats !== undefined) thread.diffStats = diffStats;
    if (mergedCommit !== undefined) {
      if (mergedCommit) thread.mergedCommit = mergedCommit;
      else delete thread.mergedCommit;
    }
    if (mergedResultRevision !== undefined) {
      if (mergedResultRevision) thread.mergedResultRevision = mergedResultRevision;
      else delete thread.mergedResultRevision;
    }
    if (integration === "merged" || integration === "none") delete thread.integrationBinding;
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setIntegrationBinding = async (
    scopeId: string,
    threadId: string,
    binding: ThreadIntegrationBinding | null,
  ): Promise<Thread | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    if (binding) {
      if (thread.integration === "merged" || thread.integration === "none") {
        return { value: thread, changed: [], write: false };
      }
      if (JSON.stringify(thread.integrationBinding) === JSON.stringify(binding)) {
        return { value: thread, changed: [], write: false };
      }
      thread.integrationBinding = structuredClone(binding);
    } else {
      if (!thread.integrationBinding) return { value: thread, changed: [], write: false };
      delete thread.integrationBinding;
    }
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const invalidateIntegrationBinding = async (
    scopeId: string,
    threadId: string,
    expectedBindingFingerprint: string,
  ): Promise<Thread | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    if (thread.integration === "merged" || thread.integration === "none"
      || !thread.integrationBinding
      || thread.integrationBinding.bindingFingerprint !== expectedBindingFingerprint
      || !thread.integrationBinding.valid) {
      return { value: thread, changed: [], write: false };
    }
    thread.integrationBinding = { ...thread.integrationBinding, valid: false, mergeReady: false };
    if (thread.integration === "merge-ready") thread.integration = "dirty";
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setVerification = async (
    scopeId: string,
    threadId: string,
    verification: ThreadVerificationProjection | null,
  ): Promise<Thread | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    if (verification) {
      if (JSON.stringify(thread.verification) === JSON.stringify(verification)) {
        return { value: thread, changed: [], write: false };
      }
      thread.verification = structuredClone(verification);
    } else {
      if (!thread.verification) return { value: thread, changed: [], write: false };
      delete thread.verification;
    }
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setWorktree = async (scopeId: string, threadId: string, worktree: ThreadWorktree): Promise<Thread | null> => (
    mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) return { value: null, changed: [], write: false };
      thread.worktree = normalizeThreadWorktree(worktree);
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    })
  );

  const setWorkingState = async (
    scopeId: string,
    threadId: string,
    input: {
      branchId: string;
      resultRevision?: number | null;
      worktree?: ThreadWorktree;
      diffStats?: ThreadDiffStats;
    },
  ): Promise<Thread | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    thread.workBranchId = input.branchId;
    if (input.resultRevision !== undefined) {
      const previous = thread.resultRevision;
      if (input.resultRevision === null) delete thread.resultRevision;
      else thread.resultRevision = input.resultRevision;
      if (previous !== input.resultRevision && thread.verification) {
        if (input.resultRevision === null || thread.verification.childChecks?.resultRevision !== input.resultRevision) {
          thread.verification.childChecks = null;
        }
        if (input.resultRevision === null || thread.verification.review?.resultRevision !== input.resultRevision) {
          thread.verification.review = null;
        }
        if (input.resultRevision === null) delete thread.verification.currentResultRevision;
        else thread.verification.currentResultRevision = input.resultRevision;
      }
    }
    if (input.worktree) thread.worktree = normalizeThreadWorktree(input.worktree);
    if (input.diffStats) {
      thread.diffStats = structuredClone(input.diffStats);
      if (thread.integration === "none") {
        thread.integration = input.diffStats.files > 0 ? "dirty" : "none";
      }
    }
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const setPendingEvidence = async (
    scopeId: string,
    threadId: string,
    runId: string,
    evidence: RetrievalEvidence,
  ): Promise<Thread> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    if (thread.preset !== "retrieval") throw new Error(`Thread is not a retrieval preset: ${threadId}`);
    const run = catalog.runs.find((candidate) => candidate.id === runId && candidate.threadId === threadId);
    if (!run || thread.activeRunId !== runId || run.outcome !== null) {
      throw new Error(`Retrieval evidence run is not active: ${runId}`);
    }
    thread.pendingEvidence = structuredClone(evidence);
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const completeThread = async (
    scopeId: string,
    threadId: string,
    report: ThreadReport,
  ): Promise<Thread | null> => {
    const catalog = await loadWorkspace(scopeId);
    const thread = findThread(catalog, threadId);
    if (!thread) return null;
    if (thread.lifecycle === "settled" && thread.report) return structuredClone(thread);
    if (!thread.activeRunId) throw new Error(`Thread has no active run: ${threadId}`);
    return endRun(scopeId, threadId, thread.activeRunId, "success", null, report);
  };

  const cancelThread = async (scopeId: string, threadId: string, exitReason = "cancelled by user or parent"): Promise<Thread | null> => {
    const catalog = await loadWorkspace(scopeId);
    const thread = findThread(catalog, threadId);
    if (!thread) return null;
    if (thread.lifecycle === "archived") return structuredClone(thread);
    const run = activeRunFor(catalog, thread);
    if (run && run.outcome === null) return endRun(scopeId, threadId, run.id, "cancelled", exitReason);
    const result = await mutateWorkspace(scopeId, (draft) => {
      const candidate = findThread(draft, threadId);
      if (!candidate) return { value: null, changed: [], write: false };
      candidate.lifecycle = "settled";
      candidate.attention = "none";
      candidate.waitingFor = null;
      touchThread(draft, candidate);
      return { value: candidate, changed: [candidate] };
    });
    if (result) await maybeDequeue(scopeId, result.parent).catch(reportObserverError);
    return result;
  };

  const archiveThread = async (scopeId: string, threadId: string, keepWorktree?: boolean): Promise<Thread | null> => {
    const result = await mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) return { value: null, changed: [], write: false };
      const activeRun = activeRunFor(catalog, thread);
      if (activeRun?.outcome === null) {
        throw new Error(`Cannot archive a thread with an active Run: ${threadId}`);
      }
      thread.lifecycle = "archived";
      thread.attention = "none";
      thread.waitingFor = null;
      if (keepWorktree !== undefined) thread.keepWorktree = keepWorktree;
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    });
    if (result) await maybeDequeue(scopeId, result.parent).catch(reportObserverError);
    return result;
  };

  const restoreThread = async (scopeId: string, threadId: string): Promise<Thread | null> => (
    mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) return { value: null, changed: [], write: false };
      if (thread.lifecycle !== "archived") return { value: thread, changed: [], write: false };
      if (cascadeBlocksThread(scopeId, catalog, thread)) {
        throw new Error(`Cannot restore thread while its ancestor is archived or being cascaded: ${threadId}`);
      }
      const run = activeRunFor(catalog, thread);
      thread.lifecycle = run && run.outcome === null ? "active" : "settled";
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    })
  );

  const setKeepWorktree = async (scopeId: string, threadId: string, keepWorktree: boolean): Promise<Thread | null> => (
    mutateWorkspace(scopeId, (catalog) => {
      const thread = findThread(catalog, threadId);
      if (!thread) return { value: null, changed: [], write: false };
      thread.keepWorktree = keepWorktree;
      touchThread(catalog, thread);
      return { value: thread, changed: [thread] };
    })
  );

  const markDeletionCascade = async (
    scopeId: string,
    threadIds: readonly string[],
    rootThreadId: string,
    operationId: string,
  ): Promise<Thread[]> => mutateWorkspace(scopeId, (catalog) => {
    const timestamp = nowISO();
    const changed: Thread[] = [];
    for (const threadId of threadIds) {
      const thread = findThread(catalog, threadId);
      if (!thread) continue;
      if (thread.deletion && (
        thread.deletion.rootThreadId !== rootThreadId
        || thread.deletion.operationId !== operationId
      )) {
        throw new Error(`Thread already belongs to another deletion operation: ${threadId}`);
      }
      thread.deletion = thread.deletion ?? {
        operationId,
        rootThreadId,
        phase: "sessions",
        requestedAt: timestamp,
        updatedAt: timestamp,
      };
      delete thread.deletion.error;
      touchThread(catalog, thread);
      changed.push(thread);
    }
    return { value: changed, changed };
  });

  const setDeletionPhase = async (
    scopeId: string,
    threadId: string,
    operationId: string,
    phase: NonNullable<Thread["deletion"]>["phase"],
    error?: string,
  ): Promise<Thread | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    if (!thread.deletion || thread.deletion.operationId !== operationId) {
      throw new Error(`Thread deletion operation changed: ${threadId}`);
    }
    thread.deletion.phase = phase;
    thread.deletion.updatedAt = nowISO();
    if (error) thread.deletion.error = error;
    else delete thread.deletion.error;
    touchThread(catalog, thread);
    return { value: thread, changed: [thread] };
  });

  const listDeletionRoots = async (): Promise<Array<{ scopeId: string; parent: ThreadParent; threadId: string }>> => {
    const roots: Array<{ scopeId: string; parent: ThreadParent; threadId: string }> = [];
    for (const scopeId of await listWorkspaceIds()) {
      const catalog = await loadWorkspace(scopeId);
      for (const thread of catalog.threads) {
        if (thread.deletion?.rootThreadId === thread.id) {
          roots.push({ scopeId, parent: structuredClone(thread.parent), threadId: thread.id });
        }
      }
    }
    return roots;
  };

  const archiveThreadsForDeletedSession = async (
    scopeId: string,
    sessionId: string,
  ): Promise<Thread[]> => mutateWorkspace(scopeId, (catalog) => {
    const timestamp = nowISO();
    const affectedIds = new Set(
      catalog.runs.filter((run) => run.sessionId === sessionId).map((run) => run.threadId),
    );
    const changed: Thread[] = [];
    for (const threadId of affectedIds) {
      const thread = findThread(catalog, threadId);
      if (!thread) continue;
      const activeRun = activeRunFor(catalog, thread);
      if (activeRun?.sessionId === sessionId && activeRun.outcome === null) {
        activeRun.workerState = "exited";
        activeRun.outcome = "cancelled";
        activeRun.exitReason = "thread session deleted by user";
        activeRun.endedAt = timestamp;
        activeRun.lastActivityAt = timestamp;
      }
      // A Bot entry is replaceable; its durable root remains an ancestor of
      // independent work. Archiving it would make every child unresumable.
      thread.lifecycle = thread.purpose === "bot-root" ? "settled" : "archived";
      thread.attention = "none";
      thread.waitingFor = null;
      // The report's TranscriptRef points at the file being deleted. Retaining
      // it would turn an intentional deletion into a durable broken reference.
      thread.report = null;
      touchThread(catalog, thread);
      changed.push(thread);
    }
    return { value: changed, changed, write: changed.length > 0 };
  });

  const archiveThreadsForDeletedSessionAcrossWorkspaces = async (
    sessionId: string,
  ): Promise<Thread[]> => {
    const scopeIds = new Set(cache.keys());
    const directory = join(dataDir, "threads", hostId);
    let entries: fs.Dirent<string>[];
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw new ThreadRegistryError("read-failed", `Unable to enumerate thread registries: ${directory}`, directory, { cause: error });
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isThreadCatalogFileName(entry.name)) continue;
      const path = join(directory, entry.name);
      const raw = await readText(path);
      if (raw === null) continue;
      const parsed = parseJson(raw, path);
      if (Array.isArray(parsed)) continue;
      const catalog = parseCatalog(raw, path);
      if (threadCatalogPath(dataDir, hostId, catalog.scopeId) !== path) {
        throw new ThreadRegistryError("corrupt", `Thread registry filename does not match its workspace identity: ${path}`, path);
      }
      if (!cache.has(catalog.scopeId)) cache.set(catalog.scopeId, catalog);
      scopeIds.add(catalog.scopeId);
    }
    const archived: Thread[] = [];
    for (const scopeId of scopeIds) {
      archived.push(...await archiveThreadsForDeletedSession(scopeId, sessionId));
    }
    return archived;
  };

  const convertThread = async (
    scopeId: string,
    threadId: string,
    input: {
      model?: { providerId: string; modelId: string };
      scope: string[];
      systemPromptFragment?: string;
      tools: string[];
      worktree: ThreadWorktree;
    },
  ): Promise<{ run: ThreadRun; thread: Thread } | null> => mutateWorkspace(scopeId, (catalog) => {
    const thread = findThread(catalog, threadId);
    if (!thread) return { value: null, changed: [], write: false };
    if (thread.kind !== "discussion") throw new Error(`Thread is already an implementation thread: ${threadId}`);
    if (thread.lifecycle !== "active") throw new Error(`Cannot convert ${thread.lifecycle} thread: ${threadId}`);
    const previous = activeRunFor(catalog, thread);
    if (!previous || previous.outcome !== null || !previous.sessionId) {
      throw new Error(`Discussion thread has no live Pi session: ${threadId}`);
    }

    // Discussion workers do not consume delegated slots until conversion.
    // Reserve before ending the old Run or publishing implementation identity.
    assertRootAdmission(catalog, thread);

    const timestamp = nowISO();
    previous.workerState = "exited";
    previous.outcome = "success";
    previous.exitReason = "converted to implementation";
    previous.endedAt = timestamp;
    previous.lastActivityAt = timestamp;

    const attempt = catalog.runs
      .filter((candidate) => candidate.threadId === threadId)
      .reduce((maximum, candidate) => Math.max(maximum, candidate.attempt), 0) + 1;
    const run: ThreadRun = {
      id: `run-${randomUUID()}`,
      threadId,
      attempt,
      runtimeId: previous.runtimeId,
      // The conversation is intentionally retained across the worker restart.
      // Persisting its id here also makes a host crash in the conversion window
      // recoverable through the ordinary lost-Run reconciliation path.
      sessionId: previous.sessionId,
      sessionOwner: previous.sessionOwner,
      frozen: {
        model: input.model ?? thread.model,
        tools: [...new Set(input.tools)],
        ...(thread.manifest.permissions ? { permissions: structuredClone(thread.manifest.permissions) } : {}),
        scope: [...input.scope],
        worktree: "isolated",
        systemPromptFragment: input.systemPromptFragment ?? null,
        inputOrigin: "inherit",
        workFocus: previous.frozen?.workFocus ?? thread.manifest.workFocus,
      },
      workerState: "starting",
      outcome: null,
      exitReason: null,
      tokens: { input: 0, output: 0, cacheRead: 0 },
      costUsd: null,
      steps: 0,
      lastToolCall: null,
      startedAt: timestamp,
      lastActivityAt: timestamp,
      endedAt: null,
    };
    catalog.runs.push(run);

    thread.kind = "implementation";
    thread.model = input.model ?? thread.model;
    thread.manifest = {
      ...thread.manifest,
      scope: [...input.scope],
      systemPromptFragment: input.systemPromptFragment ?? null,
      tools: [...new Set(input.tools)],
      worktree: "isolated",
    };
    thread.worktree = normalizeThreadWorktree(input.worktree);
    thread.lifecycle = "active";
    thread.attention = "none";
    thread.waitingFor = null;
    thread.integration = "none";
    thread.diffStats = null;
    thread.report = null;
    thread.activeRunId = run.id;
    touchThread(catalog, thread);
    return { value: { thread, run }, changed: [thread] };
  });

  const mergeThread = async (scopeId: string, threadId: string): Promise<Thread | null> => (
    setIntegration(scopeId, threadId, "merged")
  );

  const cancelAllForParent = async (
    scopeId: string,
    parent: ThreadParent,
    stopActive?: (thread: Thread) => Promise<void>,
  ): Promise<void> => {
    const key = scopeKey(scopeId, parent);
    draining.add(key);
    try {
      const threads = await listThreads(scopeId, parent, true);
      for (const thread of threads) {
        if (thread.lifecycle === "queued" || thread.lifecycle === "active") {
          if (thread.lifecycle === "active") await stopActive?.(thread);
          await cancelThread(scopeId, thread.id, "parent session deleted");
        }
        await archiveThread(scopeId, thread.id);
      }
      retiredParents.add(key);
    } finally {
      draining.delete(key);
    }
  };

  const deleteThread = async (scopeId: string, parent: ThreadParent, threadId: string): Promise<boolean> => {
    const removed = await mutateWorkspace(scopeId, (catalog) => {
      const index = catalog.threads.findIndex((thread) => thread.id === threadId && parentEquals(thread.parent, parent));
      if (index < 0) return { value: false, changed: [], write: false };
      const thread = catalog.threads[index]!;
      // This entry point is used to discard a dispatch that never acquired a
      // Run. Once a lifecycle cascade owns the thread, or another path has
      // advanced it, leave the durable record for that owner to settle/archive.
      if (cascadeBlocksThread(scopeId, catalog, thread)
        || thread.lifecycle === "archived"
        || thread.lifecycle === "settled"
        || thread.activeRunId !== null) {
        return { value: false, changed: [], write: false };
      }
      catalog.threads.splice(index, 1);
      catalog.runs = catalog.runs.filter((run) => run.threadId !== threadId);
      for (const key of cursors.keys()) if (key.endsWith(`\0${threadId}`)) cursors.delete(key);
      return { value: true, changed: [], wakeParents: [parent] };
    });
    if (removed) await Promise.resolve(options.onThreadRemoved?.(scopeId, threadId)).catch(reportObserverError);
    return removed;
  };

  /**
   * Remove a Thread and all of its Runs after the runtime lifecycle cascade
   * has settled them (D-242). Unlike `deleteThread` — which only discards a
   * dispatch that never acquired a Run — this is the delete path's durable
   * removal: it also drops session bindings for every Run the Thread owned.
   */
  const removeThread = async (scopeId: string, parent: ThreadParent, threadId: string): Promise<Thread | null> => {
    const removed = await mutateWorkspace(scopeId, (catalog) => {
      const index = catalog.threads.findIndex((thread) => thread.id === threadId && parentEquals(thread.parent, parent));
      if (index < 0) return { value: null, changed: [], write: false };
      const thread = catalog.threads[index]!;
      const sessionIds = new Set(
        catalog.runs
          .filter((run) => run.threadId === threadId && typeof run.sessionId === "string" && run.sessionId.length > 0)
          .map((run) => run.sessionId!),
      );
      catalog.threads.splice(index, 1);
      catalog.runs = catalog.runs.filter((run) => run.threadId !== threadId);
      for (const key of cursors.keys()) if (key.endsWith(`\0${threadId}`)) cursors.delete(key);
      return { value: { thread, sessionIds }, changed: [], wakeParents: [parent] };
    });
    if (!removed) return null;
    for (const sessionId of removed.sessionIds) {
      await unbindRunSession(sessionId).catch(reportObserverError);
    }
    await Promise.resolve(options.onThreadRemoved?.(scopeId, threadId)).catch(reportObserverError);
    return removed.thread;
  };

  const cursorKey = (observerSessionId: string, threadId: string): string => `${observerSessionId}\0${threadId}`;
  const getCursor = (observerSessionId: string, threadId: string): ThreadViewCursor | null => (
    structuredClone(cursors.get(cursorKey(observerSessionId, threadId)) ?? null)
  );
  const getCursorEpoch = (observerSessionId: string): number => cursorEpochs.get(observerSessionId) ?? 0;
  const setCursor = (
    observerSessionId: string,
    threadId: string,
    cursor: ThreadViewCursor,
    expectedEpoch?: number,
  ): boolean => {
    if (expectedEpoch !== undefined && getCursorEpoch(observerSessionId) !== expectedEpoch) return false;
    const key = cursorKey(observerSessionId, threadId);
    const current = cursors.get(key);
    if (current && current.eventSeq > cursor.eventSeq) return false;
    cursors.set(key, structuredClone(cursor));
    return true;
  };
  const clearCursorsForSession = (observerSessionId: string): void => {
    cursorEpochs.set(observerSessionId, getCursorEpoch(observerSessionId) + 1);
    for (const key of cursors.keys()) if (key.startsWith(`${observerSessionId}\0`)) cursors.delete(key);
  };

  const retainCursorsForSession = (observerSessionId: string, retained: ReadonlySet<string>): void => {
    cursorEpochs.set(observerSessionId, getCursorEpoch(observerSessionId) + 1);
    for (const [key, cursor] of cursors) {
      if (key.startsWith(`${observerSessionId}\0`)
        && (!cursor.retainedBy?.length || cursor.retainedBy.some((ref) => !retained.has(ref)))) cursors.delete(key);
    }
  };

  const subscribeToChanges = (scopeId: string, parent: ThreadParent, callback: () => void): (() => void) => {
    const key = scopeKey(scopeId, parent);
    let callbacks = waiters.get(key);
    if (!callbacks) {
      callbacks = new Set();
      waiters.set(key, callbacks);
    }
    callbacks.add(callback);
    return () => {
      callbacks?.delete(callback);
      if (callbacks?.size === 0) waiters.delete(key);
    };
  };

  async function tryDequeue(scopeId: string, parent: ThreadParent): Promise<Thread | null> {
    if (options.canExecuteScope && !await options.canExecuteScope(scopeId)) return null;
    const catalog = await catalogForScope(scopeId, parent);
    const root = rootSessionFor(catalog, parent);
    // Dequeue and admission are root-wide: the oldest candidate anywhere under
    // the root task wins a freed slot, regardless of which scope freed it.
    const key = root !== null
      ? scopeKey(scopeId, { kind: "session", id: root })
      : scopeKey(scopeId, parent);
    if (dequeueing.has(key)) return null;
    const next = catalog.threads
      .filter((thread) => {
        if (thread.kind !== "implementation") return false;
        const candidate = thread.lifecycle === "queued"
          || (thread.lifecycle === "settled" && (thread.pendingContinuations?.length ?? 0) > 0);
        if (!candidate) return false;
        return rootSessionFor(catalog, thread.parent) === root;
      })
      .toSorted((left, right) => (
        (left.pendingContinuations?.[0]?.at ?? left.createdAt).localeCompare(right.pendingContinuations?.[0]?.at ?? right.createdAt)
      ))[0] ?? null;
    if (next && countActiveInCatalog(catalog, root) >= next.manifest.concurrency) return null;
    if (!next || !options.onThreadDequeued) {
      if (next === null) await Promise.resolve(options.onAdmissionFreed?.(scopeId, parent)).catch(reportObserverError);
      return structuredClone(next);
    }
    dequeueing.add(key);
    try {
      await options.onThreadDequeued(scopeId, next.parent, structuredClone(next));
      return structuredClone(next);
    } finally {
      dequeueing.delete(key);
      await Promise.resolve(options.onAdmissionFreed?.(scopeId, parent)).catch(reportObserverError);
    }
  }

  const reconcileWorkspace = async (
    scopeId: string,
    activeSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<number> => mutateWorkspace(scopeId, (catalog) => {
    let reconciled = 0;
    const changed: Thread[] = [];
    for (const run of catalog.runs) {
      if (run.workerState !== "starting" && run.workerState !== "running") continue;
      if (run.sessionId && activeSessionIds.has(run.sessionId)) continue;
      run.workerState = "lost";
      run.outcome = "lost";
      run.exitReason = "host restarted";
      run.endedAt = nowISO();
      run.lastActivityAt = run.endedAt;
      const thread = findThread(catalog, run.threadId);
      if (thread) {
        thread.lifecycle = "active";
        touchThread(catalog, thread);
        changed.push(thread);
      }
      reconciled += 1;
    }
    return { value: reconciled, changed, write: reconciled > 0 };
  });

  const reconcileAfterHostRestart = async (): Promise<ThreadRegistryReconcileResult> => {
    const directory = join(dataDir, "threads", hostId);
    let entries: fs.Dirent<string>[];
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { failures: [], legacyFilesSkipped: 0, reconciledRuns: 0, workspaces: 0 };
      }
      const failure = new ThreadRegistryError("read-failed", `Unable to enumerate thread registries: ${directory}`, directory, { cause: error });
      return {
        failures: [{ code: failure.code, message: failure.message, path: failure.path }],
        legacyFilesSkipped: 0,
        reconciledRuns: 0,
        workspaces: 0,
      };
    }
    const failures: ThreadRegistryReconcileFailure[] = [];
    let legacyFilesSkipped = 0;
    let reconciledRuns = 0;
    let workspaces = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !isThreadCatalogFileName(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        const raw = await readText(path);
        if (raw === null) continue;
        const parsed = parseJson(raw, path);
        if (Array.isArray(parsed)) {
          legacyFilesSkipped += 1;
          continue;
        }
        const catalog = parseCatalog(raw, path);
        const expectedPath = threadCatalogPath(dataDir, hostId, catalog.scopeId);
        if (expectedPath !== path) {
          throw new ThreadRegistryError("corrupt", `Thread registry filename does not match its workspace identity: ${path}`, path);
        }
        cache.set(catalog.scopeId, catalog);
        workspaces += 1;
        reconciledRuns += await reconcileWorkspace(catalog.scopeId);
      } catch (error) {
        const failure = error instanceof ThreadRegistryError
          ? error
          : new ThreadRegistryError("read-failed", `Unable to inspect thread registry: ${path}`, path, { cause: error });
        failures.push({ code: failure.code, message: failure.message, path: failure.path });
      }
    }
    try {
      await rebuildSessionBindingsFromCatalogs();
    } catch (error) {
      const path = threadSessionBindingsPath(dataDir, hostId);
      const failure = error instanceof ThreadRegistryError
        ? error
        : new ThreadRegistryError("write-failed", `Unable to rebuild thread session bindings: ${path}`, path, { cause: error });
      failures.push({ code: failure.code, message: failure.message, path: failure.path });
    }
    return { failures, legacyFilesSkipped, reconciledRuns, workspaces };
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    for (const listeners of admissionWaiters.values()) for (const wake of listeners) wake();
    admissionWaiters.clear();
    await Promise.allSettled([...mutationTails.values(), sessionBindingTail]);
    waiters.clear();
    cursors.clear();
    cursorEpochs.clear();
    cache.clear();
    retiredParents.clear();
    sessionBindings.clear();
    historicalSessionIds.clear();
    staleBindingIds.clear();
    sessionBindingsLoaded = false;
    sessionBindingsLoad = null;
  };

  return {
    canExecuteScope: async (scopeId: string) => options.canExecuteScope ? options.canExecuteScope(scopeId) : true,
    flushScope: async (scopeId: string) => { await mutationTails.get(scopeId); },
    createThread,
    assertDispatchAllowed,
    getThread,
    updateThreadBrief,
    getThreadById,
    getThreadSnapshot,
    listThreads,
    listWorkspaceThreads,
    listWorkspaceThreadSnapshots,
    listWorkspaceRunSessionIds,
    withThreadRetentionSnapshot,
    listWorkspaceIds,
    listThreadSnapshots,
    getActiveRun,
    listRuns,
    getThreadForSession,
    getSessionBinding,
    resolveSessionOwner,
    setThreadEnvironment,
    threadEnvironmentForSession,
    bindRunSession,
    unbindRunSession,
    countActiveInRoot,
    yieldExecutionSlot,
    awaitExecutionSlot,
    startRun,
    admitRun,
    markRunRunning,
    endRun,
    setPendingEvidence,
    updateRunProgress,
    setAttention,
    recordThreadMessage,
    recordDirectedMessage,
    patchThreadMessage,
    patchDirectedMessage,
    listPendingThreadMessages,
    acknowledgeThreadMessages,
    failRunRequest,
    withMessageDelivery,
    enqueueContinuation,
    setIntegration,
    setIntegrationBinding,
    invalidateIntegrationBinding,
    setVerification,
    setWorktree,
    setWorkingState,
    completeThread,
    cancelThread,
    archiveThread,
    restoreThread,
    setKeepWorktree,
    markDeletionCascade,
    setDeletionPhase,
    listDeletionRoots,
    archiveThreadsForDeletedSession,
    archiveThreadsForDeletedSessionAcrossWorkspaces,
    convertThread,
    beginCascade,
    mergeThread,
    cancelAllForParent,
    deleteThread,
    removeThread,
    getCursor,
    getCursorEpoch,
    setCursor,
    clearCursorsForSession,
    retainCursorsForSession,
    subscribeToChanges,
    tryDequeue,
    reconcileWorkspace,
    reconcileAfterHostRestart,
    dispose,
    maxConcurrency,
  };
}

export type ThreadRegistry = ReturnType<typeof createThreadRegistry>;
